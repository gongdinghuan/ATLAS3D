import { createHash, randomUUID } from 'node:crypto';

import {languageProviders,isLanguageProvider,generateModel} from './language-model.mjs';
import {domesticProviders,submitDomestic,pollDomestic} from './domestic-providers.mjs';

const atlasRoot = 'https://api.atlas.worldlabs.ai/api/v2';
const tasks = [
  'atlasTextToImage', 'images2PosedRGBD', 'atlasGenerate', 'atlasChisel',
  'posedImages2Splats', 'splats2Mesh'
];
const imageTask = 'atlasTextToImage';
const maxUploadBytes = 128 * 1024 * 1024;
const inlineLimit = 10 * 1024 * 1024;
const resourceId = /^[a-zA-Z0-9_-]+$/;

function fail(status, message) {
  throw Object.assign(new Error(message), {status});
}

function configuration(provider) {
  if (provider === 'meshy') return {label:'Meshy',root:'https://api.meshy.ai/openapi/v1',key:process.env.MESHY_API_KEY?.trim()};
  if (provider === 'atlas') {
    return {label:'World Labs Atlas', root:atlasRoot,
      key:process.env.ATLAS_API_KEY?.trim() || process.env.WLT_API_KEY?.trim()};
  }
  return {label:'Images API',
    root:process.env.IMAGES_BASE_URL?.trim() || process.env.OPENAI_BASE_URL?.trim() || 'https://api.openai.com/v1',
    model:process.env.IMAGES_MODEL?.trim() || process.env.OPENAI_IMAGE_MODEL?.trim() || 'gpt-image-1.5',
    key:process.env.IMAGES_API_KEY?.trim() || process.env.OPENAI_API_KEY?.trim()};
}

function safeHttpUrl(value) {
  if (typeof value !== 'string' || !URL.canParse(value)) return false;
  const url = new URL(value);
  const loopback = ['localhost','127.0.0.1','[::1]'].includes(url.hostname);
  return !url.username && !url.password &&
    (url.protocol === 'https:' || (url.protocol === 'http:' && loopback));
}

function configured(provider) {
  const config = configuration(provider);
  if (!config.key) {
    const name = {atlas:'ATLAS_API_KEY',meshy:'MESHY_API_KEY',images:'IMAGES_API_KEY'}[provider];
    fail(503, '请先在本机服务中设置 ' + name + '。');
  }
  if (!safeHttpUrl(config.root) || /[?#]/.test(config.root)) {
    fail(503, 'Images API 地址须为 HTTPS 或本机 HTTP 接口根地址，且不能含查询参数或登录信息。');
  }
  return config;
}

function redacted(text) {
  for (const key of [configuration('atlas').key, configuration('images').key,configuration('meshy').key]) {
    if (key) text = text.replaceAll(key, '[redacted]');
  }
  return text;
}

function providerError(label, status, data) {
  const validation = Array.isArray(data?.detail)
    ? data.detail.slice(0,4).map(item => [item?.loc?.join?.('.'),item?.msg].filter(Boolean).join(' ')).join(' / ')
    : data?.detail;
  const code = data?.code ?? data?.error?.code;
  const details = status === 401 ? '请检查服务端 API 密钥。' :
    validation ?? data?.error?.message ?? data?.message;
  const reason = [code, details].filter(x => typeof x === 'string' && x.length > 0).join(' · ');
  fail(status, redacted(label + '（HTTP ' + status + '）' + (reason ? ' ' + reason : '')).slice(0,1000));
}

async function transport(url, options, label, timeoutMs) {
  try {
    return await fetch(url, {...options, redirect:'error', signal:AbortSignal.timeout(timeoutMs)});
  } catch (error) {
    const timeout = error.name === 'TimeoutError' || error.name === 'AbortError';
    fail(timeout ? 504 : 502, label + (timeout ? ' 请求超时。' : ' 无法连接，请检查网络和服务地址。'));
  }
}

async function api(provider, method, path, payload, extraHeaders = {}) {
  const config = configured(provider);
  const headers = provider === 'atlas'
    ? {'WLT-Api-Key':config.key}
    : {Authorization:'Bearer ' + config.key};
  const options = {method, headers:{...headers, ...extraHeaders}};
  if (payload !== undefined) {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(payload);
  }
  const url = config.root.replace(/\/+$/, '') + path;
  const response = await transport(url, options, config.label, provider === 'atlas' ? 75000 : 600000);
  let data;
  try {
    data = await response.json();
  } catch {
    if (!response.ok) providerError(config.label,response.status);
    fail(502, config.label + ' 返回了不完整的 JSON。');
  }
  if (!response.ok) providerError(config.label,response.status,data);
  if (!data || typeof data !== 'object') fail(502,config.label + ' 返回了无效结果。');
  return data;
}

function checkedOperation(op) {
  if (typeof op.id !== 'string' || !resourceId.test(op.id) || typeof op.done !== 'boolean') {
    fail(502,'Atlas 返回了无效的任务状态，缺少操作 ID 或完成状态。');
  }
  if (op.error) {
    // Provider diagnostics may contain a reflected credential or request fragment.
    op.error = JSON.parse(redacted(JSON.stringify(op.error)));
  }
  return op;
}

function checkedKey(value, limit) {
  if (typeof value !== 'string' || value.length > limit || !/^[\x21-\x7E]+$/.test(value)) {
    fail(400,'requestId 只能使用可打印 ASCII 字符，长度上限为 ' + limit + '。');
  }
  return value;
}

async function generateImages(input) {
  if (typeof input.prompt !== 'string' || !input.prompt.trim()) fail(400,'请输入生成图像的提示词。');
  const model = input.model ?? configuration('images').model;
  if (typeof model !== 'string' || !model.trim()) fail(400,'图像模型名称无效。');
  const payload = {model:model.trim(), prompt:input.prompt};
  for (const field of ['size','quality','n','background','output_format','output_compression','response_format']) {
    if (input[field] !== undefined) payload[field] = input[field];
  }
  const data = await api('images','POST','/images/generations',payload);
  if (!Array.isArray(data.data) || data.data.length === 0) fail(502,'Images API 未返回图像。');
  const format = data.output_format ?? input.output_format ?? 'png';
  const mime = {png:'image/png',jpeg:'image/jpeg',webp:'image/webp',gif:'image/gif',svg:'image/svg+xml'}[format];
  const frames = data.data.map(item => {
    if (mime && typeof item?.b64_json === 'string' && item.b64_json.length) {
      return {imageAsset:{url:'data:' + mime + ';base64,' + item.b64_json}};
    }
    if (safeHttpUrl(item?.url)) return {imageAsset:{url:item.url}};
    fail(502,'Images API 返回的图像缺少有效的 URL 或 Base64 数据。');
  });
  return {id:'img_' + randomUUID(),done:true,response:{frames,model:payload.model}};
}

async function submitTask(body,mediaDirectory) {
  const {provider,task,input,requestId} = body;
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail(400,'任务 input 必须是 JSON 对象。');
  if(isLanguageProvider(provider))return generateModel(provider,task,input,mediaDirectory);
  if (provider==='wan'||provider==='hunyuan') return submitDomestic(provider,task,input);
  if (provider === 'meshy' && task === 'meshyImageTo3D') {
    if (!(typeof input.image_url==='string' && (/^data:image\/(?:png|jpe?g|webp);base64,/i.test(input.image_url)||safeHttpUrl(input.image_url)))) fail(400,'请提供有效的 PNG、JPEG 或 WebP 图像');
    if(input.image_url.startsWith('data:') && input.image_url.length>28_000_000)fail(413,'Meshy 输入上限为 20 MB');
    const payload={image_url:input.image_url,target_formats:['glb'],should_texture:input.should_texture!==false};
    if(input.ai_model)payload.ai_model=input.ai_model;
    const data=await api('meshy','POST','/image-to-3d',payload);
    if(typeof data.result!=='string'||!resourceId.test(data.result))fail(502,'Meshy 没有返回任务编号');
    return {id:'meshy_'+data.result,done:false,metadata:{state:'PENDING'}};
  }
  if (provider === 'images' && task === imageTask) return generateImages(input);
  if (provider !== 'atlas' || !tasks.includes(task)) fail(400,'服务不支持该任务类型。');
  const idempotencyKey = checkedKey(requestId ?? randomUUID(),128);
  return checkedOperation(await api('atlas','POST','/tasks:' + task,input,{'Idempotency-Key':idempotencyKey}));
}

function uploadInput({fileName, mimeType, base64}) {
  if (typeof fileName !== 'string' || !fileName.trim() || fileName.length > 255 || /[\x00-\x1F]/.test(fileName)) {
    fail(400,'请提供有效的文件名。');
  }
  if (typeof mimeType !== 'string' || !/^[\w!#$&^.+-]+\/[\w!#$&^.+-]+$/.test(mimeType)) {
    fail(400,'请提供有效的文件 MIME 类型。');
  }
  if (typeof base64 !== 'string') fail(400,'缺少 Base64 文件数据。');
  const prefix = 'data:' + mimeType + ';base64,';
  const encoded = base64.startsWith(prefix) ? base64.slice(prefix.length) : base64;
  if (encoded.length > 4*Math.ceil(maxUploadBytes/3)) fail(413,'单个上传文件大小上限为 128 MiB。');
  // Validate without decoding the full buffer for inline submissions.
  const pad = encoded.endsWith('==') ? 2 : Number(encoded.endsWith('='));
  const digits = encoded.length - pad;
  const content = encoded.slice(0,digits);
  if (!digits || digits % 4 === 1 || (pad && encoded.length % 4 !== 0) || /[^A-Za-z0-9+/]/.test(content)) {
    fail(400,'文件 Base64 编码无效。');
  }
  const size = Math.floor(digits * 3 / 4);
  if (size > maxUploadBytes) fail(413,'单个上传文件大小上限为 128 MiB。');
  return {fileName,mimeType,encoded,size};
}

async function uploadAsset(body) {
  const {fileName,mimeType,encoded,size} = uploadInput(body);
  const asset = {displayName:fileName};
  if (size < inlineLimit) asset.base64 = 'data:' + mimeType + ';base64,' + encoded;
  let record = await api('atlas','POST','/assets',{asset});
  if (typeof record.id !== 'string' || !resourceId.test(record.id)) fail(502,'Atlas 未返回有效的资产 ID。');
  if (size >= inlineLimit) {
    const path = '/assets/' + record.id;
    const grant = await api('atlas','POST',path + ':createUploadUrl',{contentType:mimeType,contentLength:size});
    if (grant.method !== 'PUT' || !safeHttpUrl(grant.uploadUrl)) fail(502,'Atlas 未返回有效的签名上传地址。');
    const headers = new Headers(grant.headers);
    headers.delete('WLT-Api-Key');
    headers.delete('Authorization');
    const upload = await transport(grant.uploadUrl,{method:'PUT',headers,body:Buffer.from(encoded,'base64')},'资产上传',600000);
    if (!upload.ok) fail(502,'存储服务未接受文件（HTTP ' + upload.status + '）。');
    await upload.body?.cancel();
    const completed = await api('atlas','POST',path + ':completeUpload',{});
    if (completed.id !== record.id) fail(502,'Atlas 返回的上传确认与资产 ID 不一致。');
    record = completed;
  }
  if (record.state !== 'READY') fail(502,'Atlas 资产尚未就绪。');
  return {assetId:record.id, fileName, mimeType:record.mimeType || mimeType, sizeBytes:size};
}

export async function handleProvider(method, path, body = {}, mediaDirectory) {
  if (method === 'GET' && path === '/api/providers') {
    const providers = ['atlas','images','meshy'].map(id => {
      const {key,label} = configuration(id);
      return {id,label,configured:Boolean(key),tasks:id === 'atlas' ? [...tasks] : id==='meshy'? ['meshyImageTo3D'] : [imageTask]};
    });
    return {providers:providers.concat(domesticProviders(),languageProviders())};
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) fail(400,'请求体必须是 JSON 对象。');
  if (method === 'POST' && path === '/api/tasks') return submitTask(body,mediaDirectory);
  if (method === 'POST' && path === '/api/assets') return uploadAsset(body);

  const operation = /^\/api\/operations\/([A-Za-z0-9_-]+)$/.exec(path);
  if (operation) {
    if (/^(wan_|hunyuan_)/.test(operation[1])) {
      if(method!=='GET')fail(405,'此任务只支持查询进度');
      return pollDomestic(operation[1]);
    }
    if(operation[1].startsWith('meshy_')){
      if(method!=='GET')fail(405,'Meshy 图生 3D 未提供取消操作。');
      const r=await api('meshy','GET','/image-to-3d/'+operation[1].slice(6));
      const state=String(r.status);
      if(!['SUCCEEDED','FAILED','CANCELED','IN_PROGRESS','PENDING'].includes(state))fail(502,'Meshy 返回未知任务状态');
      const op={id:operation[1],done:['SUCCEEDED','FAILED','CANCELED'].includes(state),metadata:{state,progress:r.progress}};
      if(state==='SUCCEEDED'){if(!safeHttpUrl(r.model_urls?.glb))fail(502,'Meshy 未返回 GLB');op.response={mesh:{url:r.model_urls.glb}}}
      else if(op.done)op.error={code:state,message:redacted(r.task_error?.message||state)};
      return op;
    }
    const target = '/operations/' + operation[1];
    if (method === 'GET') return checkedOperation(await api('atlas','GET',target));
    if (method === 'DELETE') {
      const stableId = createHash('sha256').update('cancel:' + operation[1]).digest('hex').slice(0,32);
      const requestId = checkedKey(body.requestId ?? stableId,36);
      return checkedOperation(await api('atlas','POST',target + ':cancel',{requestId}));
    }
  }
  const asset = /^\/api\/assets\/([A-Za-z0-9_-]+)\/url$/.exec(path);
  if (asset && method === 'GET') {
    const result = await api('atlas','POST','/assets/' + asset[1] + ':createReadUrl');
    if (!safeHttpUrl(result.readUrl)) fail(502,'Atlas 未返回有效的资产下载地址。');
    return {url:result.readUrl,expiresAt:result.expiresAt};
  }
  fail(404,'生成服务接口不存在。');
}
