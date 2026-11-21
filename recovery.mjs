import {mkdir,readdir,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {atomicWrite,fail} from './storage.mjs';

const uuid=/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i;
const valid=id=>{if(!uuid.test(id))throw fail(400,'无效编号');return id};
async function read(path){try{return JSON.parse(await readFile(path,'utf8'))}catch(e){if(e.code==='ENOENT')return null;throw e}}
export function recoveryStore(root){
 const inFlight=new Map();
 const receiptDir=join(root,'receipts');
 async function receipt(id){return read(join(receiptDir,valid(id)+'.json'))}
 async function run(body,digest,send){
  await mkdir(receiptDir,{recursive:true});
  const key=valid(body.requestId),file=join(receiptDir,key+'.json'),saved=await read(file);
  if(saved?.digest!==undefined && saved.digest!==digest)throw fail(409,'同一请求编号对应不同参数');
  if(saved?.state==='received')return saved.operation;
  if(saved?.state==='failed')throw fail(saved.status,saved.message);
  if(saved && body.provider!=='atlas')throw fail(409,'原请求的远端状态尚未核实，请先检查供应商记录。');
  const base={id:key,digest,provider:body.provider};
  await atomicWrite(file,JSON.stringify({...base,state:'sending'}));
  let op;
  try{op=await send()}catch(e){
   // Interrupted or timed-out requests can still create a billable remote job.
   const status=Number(e.status)||502;
   if(status>=400 && status<500 && status!==408)await atomicWrite(file,JSON.stringify({...base,state:'failed',status,message:e.message}));
   throw e;
  }
  await atomicWrite(file,JSON.stringify({...base,state:'received',operation:op}));return op;
 }
 return {
  receipt,
  submit(body,send){
   const id=valid(body.requestId),digest=createHash('sha256').update(JSON.stringify([body.provider,body.task,body.input])).digest('hex');
   const existing=inFlight.get(id);
   if(existing){if(digest!==existing.digest)throw fail(409,'不同任务不能共用同一请求编号');return existing.promise}
   const promise=run(body,digest,send).finally(()=>inFlight.delete(id));inFlight.set(id,{digest,promise});return promise
  },
  async checkReceipt(id){
   const r=await receipt(id);if(!r)throw fail(404,'本机没有此请求的提交记录');
   return {state:r.state==='sending' && inFlight.has(id)?'inFlight':r.state,operation:r.operation,error:r.message}
  },
  async snapshot(pid,label,project){
   valid(pid);if(project?.id!==pid||!Array.isArray(project?.scene?.objects)||typeof label!=='string'||!label.trim())throw fail(400,'检查点缺少名称或项目内容');
   const folder=join(root,'checkpoints',pid);await mkdir(folder,{recursive:true});
   const meta={id:randomUUID(),name:label.trim().slice(0,90),createdAt:new Date().toISOString(),projectId:pid};
   await atomicWrite(join(folder,meta.id+'.json'),JSON.stringify({meta,project}));return meta
  },
  async snapshots(pid){
   const folder=join(root,'checkpoints',valid(pid));const files=await readdir(folder).catch(e=>{if(e.code==='ENOENT')return [];throw e});
   const list=[];for(const f of files.filter(f=>f.endsWith('.json'))){const entry=await read(join(folder,f));if(entry)list.push(entry.meta)}
   return list.sort((a,b)=>b.createdAt.localeCompare(a.createdAt))
  },
  async restore(pid,id){const record=await read(join(root,'checkpoints',valid(pid),valid(id)+'.json'));if(!record)throw fail(404,'检查点不存在');return record}
 }
}
