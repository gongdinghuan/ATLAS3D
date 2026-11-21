import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {recoveryStore} from '../recovery.mjs';
test('重启后仍可从命名检查点取回原始创作状态',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'atlas-checkpoint-')),s=recoveryStore(dir);
 const p={id:randomUUID(),scene:{objects:[{id:1}]},workflowDrafts:{atlasChisel:{prompt:'改用木材'}},editor:{mode:'edit'}};
 const a=await s.snapshot(p.id,'初稿',p);p.workflowDrafts.atlasChisel.prompt='修改';
 const reopened=recoveryStore(dir);const saved=await reopened.restore(p.id,a.id);
 assert.equal(saved.project.workflowDrafts.atlasChisel.prompt,'改用木材');assert.equal((await reopened.snapshots(p.id))[0].id,a.id);
 await assert.rejects(reopened.restore(randomUUID(),a.id),{status:404});
});
test('刷新、并发和服务重启使用同一次付费提交的回执',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'atlas-receipt-')),s=recoveryStore(dir);
 let calls=0;const req={requestId:randomUUID(),provider:'images',task:'atlasTextToImage',input:{prompt:'a'}};
 const send=async()=>{calls++;return {id:'op',done:true,response:{frames:[]}}};
 const [a,b]=await Promise.all([s.submit(req,send),s.submit(req,send)]);assert.deepEqual(a,b);
 const reopened=recoveryStore(dir);assert.deepEqual(await reopened.submit(req,send),a);
 assert.equal((await reopened.checkReceipt(req.requestId)).state,'received');assert.equal(calls,1);
 await assert.rejects(reopened.submit({...req,input:{prompt:'b'}},send),{status:409});
});
test('第三方请求响应不明时，恢复操作不会重复提交',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'atlas-uncertain-')),s=recoveryStore(dir);
 const req={requestId:randomUUID(),provider:'meshy',input:{},task:'meshyImageTo3D'};
 await assert.rejects(s.submit(req,async()=>{throw Object.assign(new Error('网络中断'),{status:502})}));
 let calls=0;await assert.rejects(recoveryStore(dir).submit(req,()=>{calls++}),{status:409});assert.equal(calls,0)
});
