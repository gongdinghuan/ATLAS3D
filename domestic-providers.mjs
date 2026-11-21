import {createHash,createHmac} from 'node:crypto';
import {fail} from './storage.mjs';

const wanModel='wan2.6-t2i';
export const validWorkspace=id=>typeof id==='string' && /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(id);
const httpsURL=value=>typeof value==='string' && URL.canParse(value) && new URL(value).protocol==='https:' && !new URL(value).username && !new URL(value).password;
const validId=id=>typeof id==='string' && /^[A-Za-z0-9_-]{1,160}$/.test(id);
export function domesticProviders(){
 return [
  {id:'wan',label:'阿里通义万相 2.6',tasks:['atlasTextToImage'],configured:Boolean(process.env.DASHSCOPE_API_KEY?.trim()&&validWorkspace(process.env.DASHSCOPE_WORKSPACE_ID))},
  {id:'hunyuan',label:'腾讯混元 3D 专业版',tasks:['hunyuanTo3D'],configured:Boolean(process.env.TENCENTCLOUD_SECRET_ID?.trim()&&process.env.TENCENTCLOUD_SECRET_KEY?.trim())}
 ];
}
function redact(message){
 let text=String(message||'供应商没有返回错误详情').slice(0,1000);
 for(const name of ['DASHSCOPE_API_KEY','TENCENTCLOUD_SECRET_KEY','TENCENTCLOUD_SECRET_ID','TENCENTCLOUD_TOKEN']){
  if(process.env[name])text=text.replaceAll(process.env[name],'[已隐藏]')
 }
 return text;
}
async function request(url,method,headers,body){
 let response;
 try{response=await fetch(url,{method,headers,body,redirect:'error',signal:AbortSignal.timeout(60000)})}
 catch(e){throw fail(e.name==='TimeoutError'?504:502,'连接模型服务失败，请检查网络并用原任务编号核对进度。')}
 const result=await response.json().catch(()=>null);
 const problem=result?.Response?.Error || (result?.code ? {Code:result.code,Message:result.message}:null);
 if(!response.ok||problem){
  const code=String(problem?.Code||response.status);
  let status=response.ok?400:response.status;
  if(code.startsWith('AuthFailure'))status=401;
  else if(code.startsWith('UnauthorizedOperation'))status=403;
  else if(code.startsWith('RequestLimitExceeded'))status=429;
  else if(code.startsWith('InternalError'))status=502;
  throw fail(status,redact(code+' · '+(problem?.Message||response.statusText)))
 }
 if(!result||typeof result!=='object')throw fail(502,'模型服务返回了无效数据');
 return result
}
function wanRequest(path,body){
 const workspace=process.env.DASHSCOPE_WORKSPACE_ID?.trim(),key=process.env.DASHSCOPE_API_KEY?.trim();
 if(!key||!validWorkspace(workspace))throw fail(503,'请配置百炼北京地域的 Workspace ID 和 API Key');
 const headers={Authorization:'Bearer '+key};
 if(body){headers['Content-Type']='application/json';headers['X-DashScope-Async']='enable'}
 return request('https://'+workspace+'.cn-beijing.maas.aliyuncs.com/api/v1'+path,body?'POST':'GET',headers,body?JSON.stringify(body):undefined)
}
const sha256=value=>createHash('sha256').update(value).digest('hex');
const hmac=(key,value)=>createHmac('sha256',key).update(value).digest();
async function tencent(action,input){
 const id=process.env.TENCENTCLOUD_SECRET_ID?.trim(),key=process.env.TENCENTCLOUD_SECRET_KEY?.trim();
 if(!id||!key)throw fail(503,'请配置腾讯云 SecretId 和 SecretKey');
 const host='ai3d.tencentcloudapi.com',body=JSON.stringify(input),timestamp=Math.floor(Date.now()/1000);
 const date=new Date(timestamp*1000).toISOString().slice(0,10),scope=date+'/ai3d/tc3_request';
 const canonical=['POST','/','','content-type:application/json\nhost:'+host+'\n','content-type;host',sha256(body)].join('\n');
 const toSign=['TC3-HMAC-SHA256',timestamp,scope,sha256(canonical)].join('\n');
 const signingKey=hmac(hmac(hmac('TC3'+key,date),'ai3d'),'tc3_request');
 const signature=hmac(signingKey,toSign).toString('hex');
 const headers={
  'Content-Type':'application/json','X-TC-Action':action,'X-TC-Version':'2025-05-13','X-TC-Region':'ap-guangzhou','X-TC-Timestamp':String(timestamp),
  Authorization:'TC3-HMAC-SHA256 Credential='+id+'/'+scope+', SignedHeaders=content-type;host, Signature='+signature
 };
 if(process.env.TENCENTCLOUD_TOKEN)headers['X-TC-Token']=process.env.TENCENTCLOUD_TOKEN;
 const result=await request('https://'+host+'/','POST',headers,body);
 if(!result.Response)throw fail(502,'混元服务缺少 Response 字段');
 return result.Response
}
export async function submitDomestic(provider,task,input){
 if(provider==='wan' && task==='atlasTextToImage'){
  const {prompt,n=1,size='1280*1280'}=input;
  if(typeof prompt!=='string'||!prompt.trim())throw fail(400,'请填写万相场景描述');
  if(!Number.isInteger(n)||n<1||n>4)throw fail(400,'万相每次可生成 1 至 4 张');
  if(!['1280*1280','1104*1472','1472*1104','960*1696','1696*960'].includes(size))throw fail(400,'请选择万相支持的图像尺寸');
  const result=await wanRequest('/services/aigc/image-generation/generation',{model:wanModel,input:{messages:[{role:'user',content:[{text:prompt.trim()}]}]},parameters:{n,size,prompt_extend:input.enhance!==false}});
  if(!validId(result.output?.task_id))throw fail(502,'万相未返回任务编号');
  return {id:'wan_'+result.output.task_id,done:false,metadata:{model:wanModel,state:result.output.task_status}}
 }
 if(provider==='hunyuan' && task==='hunyuanTo3D'){
  const prompt=typeof input.prompt==='string'?input.prompt.trim():'',image=input.image_url;
  if(Boolean(prompt)===Boolean(image))throw fail(400,'请选择一张图像或填写一段描述');
  if([...prompt].length>1024)throw fail(400,'混元描述最多 1024 个字符');
  const model=input.model||'3.1';
  if(!['3.0','3.1'].includes(model))throw fail(400,'请选择混元 3.0 或 3.1');
  const payload={Model:model,GenerateType:input.textured===false?'Geometry':'Normal'};
  if(prompt)payload.Prompt=prompt;
  else if(httpsURL(image))payload.ImageUrl=image;
  else{
   const m=typeof image==='string' && /^data:image\/(?:jpeg|png|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(image);
   if(!m||Buffer.byteLength(m[1],'base64')>6*1024*1024)throw fail(400,'混元需要不超过 6 MiB 的 JPEG、PNG 或 WebP 图像');
   payload.ImageBase64=m[1]
  }
  const result=await tencent('SubmitHunyuanTo3DProJob',payload);
  if(!validId(result.JobId))throw fail(502,'混元未返回任务编号');
  return {id:'hunyuan_'+result.JobId,done:false,metadata:{state:'WAIT',model}}
 }
 throw fail(400,'所选国产模型不支持此任务');
}
export async function pollDomestic(id){
 if(id.startsWith('wan_')){
  const {output}=await wanRequest('/tasks/'+id.slice(4));
  const state=output?.task_status;
  if(!['PENDING','RUNNING','SUCCEEDED','FAILED','CANCELED','UNKNOWN'].includes(state))throw fail(502,'万相返回未知状态');
  const op={id,done:!['PENDING','RUNNING'].includes(state),metadata:{state,model:wanModel}};
  if(state==='SUCCEEDED'){
   const frames=(output.choices||[]).flatMap(c=>c.message?.content||[]).filter(c=>httpsURL(c.image)).map(c=>({imageAsset:{url:c.image}}));
   if(!frames.length)throw fail(502,'万相任务已完成，未返回图像链接');
   op.response={frames,model:wanModel};
  }else if(op.done)op.error={code:state,message:redact(output.message||output.code||'任务已终止或超过查询有效期')};
  return op
 }
 const result=await tencent('QueryHunyuanTo3DProJob',{JobId:id.slice('hunyuan_'.length)});
 if(!['WAIT','RUN','DONE','FAIL'].includes(result.Status))throw fail(502,'混元返回未知任务状态');
 const op={id,done:['DONE','FAIL'].includes(result.Status),metadata:{state:result.Status}};
 if(result.Status==='FAIL')op.error={code:result.ErrorCode||'FAIL',message:redact(result.ErrorMessage)};
 if(result.Status==='DONE'){
  const files=(result.ResultFile3Ds||[]).filter(f=>httpsURL(f.Url));
  if(!files.length)throw fail(502,'混元任务已完成，未返回模型文件');
  const glb=files.find(f=>String(f.Type).toUpperCase()==='GLB' && !/\.zip$/i.test(new URL(f.Url).pathname));
  op.response={...(glb?{mesh:{url:glb.Url}}:{}),modelFiles:files.filter(f=>f!==glb).map(f=>{
   const ext=new URL(f.Url).pathname.match(/\.(zip|obj|glb|fbx|usdz|stl)$/i)?.[1]?.toLowerCase()||'bin';
   return {asset:{url:f.Url},label:String(f.Type||'模型文件'),ext}
  })};
 }
 return op
}
