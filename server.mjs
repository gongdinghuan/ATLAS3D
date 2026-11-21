import { createServer } from 'node:http';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, stat, unlink } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { join, resolve, relative, extname, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createProjectStore, fail, atomicWrite } from './storage.mjs';
import { handleProvider } from './providers.mjs';
import { validWorkspace, domesticProviders } from './domestic-providers.mjs';
import { recoveryStore } from './recovery.mjs';

const root = fileURLToPath(new URL('.', import.meta.url));
const data = resolve(process.env.ATLAS_DATA_DIR || join(root, 'data'));
const media = join(data, 'assets');
const settingsFile = join(data, 'providers.json');
const projects = createProjectStore(join(data, 'projects'));
const recovery = recoveryStore(data);
const port = Number(process.env.PORT || 4317);
const allowed = new Set(['localhost:' + port, '127.0.0.1:' + port]);
const writableSettings = ['ATLAS_API_KEY','IMAGES_API_KEY','IMAGES_BASE_URL','IMAGES_MODEL','MESHY_API_KEY','DASHSCOPE_WORKSPACE_ID','DASHSCOPE_API_KEY','TENCENTCLOUD_SECRET_ID','TENCENTCLOUD_SECRET_KEY','DEEPSEEK_API_KEY','MINIMAX_API_KEY'];
const inherited = Object.fromEntries(writableSettings.map(k => [k, process.env[k]]));
await mkdir(media, {recursive:true});
let settings = await readFile(settingsFile, 'utf8').then(JSON.parse).catch(e => {
  if (e.code === 'ENOENT') return {};
  throw e;
});
for (const key of writableSettings) if (settings[key]) process.env[key] = settings[key];
const types = {'.html':'text/html; charset=utf-8','.css':'text/css','.js':'text/javascript','.svg':'image/svg+xml','.png':'image/png','.webp':'image/webp','.jpg':'image/jpeg','.jpeg':'image/jpeg','.gif':'image/gif','.avif':'image/avif','.mp4':'video/mp4','.webm':'video/webm','.glb':'model/gltf-binary','.json':'application/json','.wasm':'application/wasm'};
const mediaExt = new Set(['.png','.jpg','.jpeg','.webp','.gif','.avif','.mp4','.webm','.glb','.spz','.ply','.splat','.ksplat','.exr','.obj','.bin']);
function respond(res, status, obj) {
  res.writeHead(status, {'content-type':'application/json; charset=utf-8','cache-control':'no-store'});
  res.end(JSON.stringify(obj));
}
async function bodyJSON(req, max) {
  if (!req.headers['content-type']?.startsWith('application/json')) throw fail(415,'需要 JSON 请求');
  let bytes = 0; const chunks = [];
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > max) throw fail(413,'数据超过此操作的大小限制');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw fail(400,'无效 JSON'); }
}
function safeJoin(folder, file) {
  const target = resolve(folder, file);
  const rel = relative(folder, target);
  if (!rel || rel.startsWith('..') || isAbsolute(rel) || rel.includes(':')) throw fail(404,'文件不存在');
  return target;
}
async function sendFile(res, req, path) {
  const info = await stat(path).catch(()=>{ throw fail(404,'文件不存在'); });
  if (!info.isFile()) throw fail(404,'文件不存在');
  const headers = {'content-type':types[extname(path)] || 'application/octet-stream','accept-ranges':'bytes'};
  const range = req.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
  const start = range ? Number(range[1]) : 0;
  const end = range?.[2] ? Math.min(Number(range[2]), info.size-1) : info.size-1;
  if (range && (start > end || start >= info.size)) throw fail(416,'读取范围无效');
  if (range) headers['content-range'] = 'bytes '+start+'-'+end+'/'+info.size;
  headers['content-length'] = end-start+1;
  res.writeHead(range ? 206 : 200, headers);
  if (req.method === 'HEAD' || !info.size) return res.end();
  await pipeline(createReadStream(path,{start,end}),res);
}
function publicSettings() {
  const base = process.env.IMAGES_BASE_URL || process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
  return {imagesBase: base, imagesModel: process.env.IMAGES_MODEL || process.env.OPENAI_IMAGE_MODEL || 'gpt-image-1.5',
    atlasConfigured: Boolean(process.env.ATLAS_API_KEY || process.env.WLT_API_KEY),
    imagesConfigured: Boolean(process.env.IMAGES_API_KEY || process.env.OPENAI_API_KEY),meshyConfigured:Boolean(process.env.MESHY_API_KEY),deepseekConfigured:Boolean(process.env.DEEPSEEK_API_KEY),minimaxConfigured:Boolean(process.env.MINIMAX_API_KEY?.trim()),wanWorkspace:process.env.DASHSCOPE_WORKSPACE_ID||'',domestic:Object.fromEntries(domesticProviders().map(p=>[p.id,p.configured]))};
}
let updatingSettings = false;
async function saveSettings(input) {
  if (updatingSettings) throw fail(409,'另一项设置正在保存，请稍后重试');
  updatingSettings = true;
  try {
    const current = publicSettings();
    let base;
    try { base = new URL(input.imagesBase || current.imagesBase); } catch { throw fail(400,'请填写完整 API 地址'); }
    if ((!['localhost','127.0.0.1','[::1]'].includes(base.hostname) || base.protocol !== 'http:') && base.protocol !== 'https:') throw fail(400,'远程服务需要 HTTPS 地址');
    if (base.username || base.password || base.search || base.hash) throw fail(400,'API 地址不能包含凭据、查询或片段');
    if (base.origin !== new URL(current.imagesBase).origin && current.imagesConfigured && !input.imagesKey?.trim()) throw fail(400,'更换服务主机时请填写该服务的密钥');
    const next = {...settings, IMAGES_BASE_URL: base.href.replace(/\/$/,''), IMAGES_MODEL: String(input.imagesModel || current.imagesModel).trim()};
    if (input.atlasKey?.trim()) next.ATLAS_API_KEY = input.atlasKey.trim();
    if (input.imagesKey?.trim()) next.IMAGES_API_KEY = input.imagesKey.trim();
    if (input.meshyKey?.trim()) next.MESHY_API_KEY = input.meshyKey.trim();
    if(input.wanWorkspace?.trim()){
      const id=input.wanWorkspace.trim();
      if(!validWorkspace(id))throw fail(400,'请输入北京地域的百炼 Workspace ID，不含域名或路径');
      next.DASHSCOPE_WORKSPACE_ID=id;
    }
    if(typeof input.minimaxKey==='string' && input.minimaxKey.trim())next.MINIMAX_API_KEY=input.minimaxKey.trim();
    if(input.deepseekKey?.trim())next.DEEPSEEK_API_KEY=input.deepseekKey.trim();
    if(input.wanKey?.trim())next.DASHSCOPE_API_KEY=input.wanKey.trim();
    const secretId=input.tencentId?.trim(),secretKey=input.tencentKey?.trim();
    if(Boolean(secretId)!==Boolean(secretKey))throw fail(400,'设置腾讯云凭据时请同时填写 SecretId 和 SecretKey');
    if(secretId){next.TENCENTCLOUD_SECRET_ID=secretId;next.TENCENTCLOUD_SECRET_KEY=secretKey}
    await atomicWrite(settingsFile, JSON.stringify(next));
    settings = next;
    for (const key of writableSettings) if (next[key] || inherited[key]) process.env[key] = next[key] || inherited[key];
    return publicSettings();
  } finally { updatingSettings = false; }
}
const server = createServer(async (req,res) => {
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('Referrer-Policy','no-referrer');
  res.setHeader('X-Frame-Options','DENY');
  try {
    if (!allowed.has(req.headers.host)) throw fail(403,'仅接受本机访问');
    const origin = 'http://'+req.headers.host;
    if (req.headers.origin && req.headers.origin !== origin) throw fail(403,'拒绝跨站请求');
    const url = new URL(req.url,origin);
    const path = decodeURIComponent(url.pathname);
    const method = req.method;
    if (method === 'POST' && path === '/api/local-assets') {
      if (req.headers['content-type'] !== 'application/octet-stream') throw fail(415,'需要二进制文件');
      const name = url.searchParams.get('name')?.slice(0,200) || 'asset.bin';
      const suffix = extname(name).toLowerCase();
      const id = randomUUID() + (mediaExt.has(suffix) ? suffix : '.bin');
      const dest = join(media,id); let bytes = 0;
      const limit = new Transform({transform(chunk,encoding,cb) {
        bytes += chunk.length; cb(bytes > 512*1024*1024 ? fail(413,'单个本地文件最大 512 MiB') : null,chunk);
      }});
      try { await pipeline(req,limit,createWriteStream(dest,{flags:'wx'})); }
      catch(e) { await unlink(dest).catch(()=>{}); throw e; }
      return respond(res,201,{id,name,url:'/media/'+id,type:types[suffix] || 'application/octet-stream',size:bytes});
    }
    if (path.startsWith('/api/')) {
      if (path === '/api/health' && method === 'GET') return respond(res,200,{app:'atlas-local-studio',version:'0.1.0'});
      const checkpoints=/^\/api\/projects\/([\da-f-]+)\/checkpoints(?:\/([\da-f-]+))?$/.exec(path);
      if(checkpoints && method==='GET')return respond(res,200,checkpoints[2]?await recovery.restore(checkpoints[1],checkpoints[2]):await recovery.snapshots(checkpoints[1]));
      if(checkpoints && !checkpoints[2] && method==='POST'){
        const {name,project}=await bodyJSON(req,96*1024*1024);
        return respond(res,201,await recovery.snapshot(checkpoints[1],name,project));
      }
      const receipt=/^\/api\/receipts\/([\da-f-]+)$/.exec(path);
      if(receipt && method==='GET')return respond(res,200,await recovery.checkReceipt(receipt[1]));
      if (path === '/api/projects' && method === 'GET') return respond(res,200,await projects.list());
      if (path === '/api/projects' && method === 'PUT') {
        const saved = await projects.save(await bodyJSON(req,96*1024*1024));
        return respond(res,200,{revision:saved.revision,updatedAt:saved.updatedAt});
      }
      if (path === '/api/settings' && method === 'GET') return respond(res,200,publicSettings());
      if (path === '/api/settings' && method === 'PUT') return respond(res,200,await saveSettings(await bodyJSON(req,16384)));
      if (!['GET','POST','DELETE'].includes(method)) throw fail(405,'方法不支持');
      const body = method === 'POST' ? await bodyJSON(req,180*1024*1024) : {};
      const result = path==='/api/tasks' && method==='POST' && body.requestId
        ? await recovery.submit(body,()=>handleProvider(method,path,body,media))
        : await handleProvider(method,path,body,media);
      return respond(res,200,result);
    }
    if (!['GET','HEAD'].includes(method)) throw fail(405,'方法不支持');
    if (path.startsWith('/media/')) {
      if (!/^[a-f\d-]{36}\.[a-z0-9]+$/i.test(path.slice(7))) throw fail(404,'素材不存在');
      return await sendFile(res,req,safeJoin(media,path.slice(7)));
    }
    for (const [prefix,folder] of [['/vendor/three/','node_modules/three'],['/vendor/spark/','node_modules/@sparkjsdev/spark/dist']]) {
      if (path.startsWith(prefix)) return await sendFile(res,req,safeJoin(join(root,folder),path.slice(prefix.length)));
    }
    await sendFile(res,req,safeJoin(join(root,'public'),path==='/'?'index.html':path.slice(1)));
  } catch(e) {
    if (res.headersSent || res.destroyed) return res.destroy();
    const status = Number(e.status) || 500;
    respond(res,status>=400 && status<=599 ? status : 500,{error:e.message || '本地服务出现错误'});
  }
});
server.on('error',e=>{ console.error(e.code==='EADDRINUSE' ? '端口被占用，请检查已运行的编辑器或设置 PORT。' : e.message); process.exitCode=1; });
server.listen(port,'127.0.0.1',()=>console.log('Atlas 工作台已就绪  http://127.0.0.1:'+port));
