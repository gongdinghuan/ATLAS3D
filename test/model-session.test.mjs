import test from 'node:test';
import assert from 'node:assert/strict';
import {buildSessionContext,cleanSessionContext,resumeTarget} from '../public/model-session.js';
const job=(id,parent)=>({id,task:'threeModel',status:'succeeded',modelApplied:'roof',modelGroup:parent?'roof':null,parentTurnId:parent,prompt:'修改 '+id,response:{threeModel:{name:'展亭'}}});
test('长会话保留首轮和最近的实际版本，撤销与分支不引入废弃轮次',()=>{
 const chain=Array.from({length:12},(_,i)=>job('v'+i,i?'v'+(i-1):null));
 const p={name:'庭院',jobs:chain.slice().reverse(),scene:{objects:[{type:'three',group:'roof',groupName:'展亭',modelVersion:'v11',color:'#778855'}]}};
 const ctx=buildSessionContext(p,'roof');assert.equal(ctx.turns.length,8);assert.equal(ctx.turns[0].request,'修改 v0');assert.equal(ctx.turns.at(-1).request,'修改 v11');
 p.scene.objects[0].modelVersion='v1';assert.deepEqual(buildSessionContext(p,'roof').turns.map(t=>t.request),['修改 v0','修改 v1']);
 const branch={...job('copy','v1'),modelApplied:'new-group'};p.jobs.unshift(branch);p.scene.objects.push({...p.scene.objects[0],group:'new-group',modelVersion:'copy'});
 const fork=buildSessionContext(p,'new-group');assert.equal(fork.turns.length,3);assert.equal(fork.models.length,1);assert.equal(fork.models[0].firstRequest,'修改 v0');assert.equal(resumeTarget(p),'new-group');
 const legacy=structuredClone(p);for(const j of legacy.jobs)delete j.parentTurnId;assert.equal(buildSessionContext(legacy,'roof').turns.length,2);
});
test('仅传递已采用的设计、当前工程说明和有限文本',()=>{
 const p={name:'A',modelSession:{requirements:'红色金属'},jobs:[{...job('failure','g'),status:'failed'},job('ok',null)],scene:{objects:[{type:'three',group:'roof',modelVersion:'ok',groupName:'展亭',color:'#aabbcc'}]}};
 assert.deepEqual(buildSessionContext(p,'roof').turns.map(t=>t.request),['修改 ok']);
 const fresh=buildSessionContext(p,'new');assert.equal(fresh.requirements,'红色金属');assert.equal(fresh.turns.length,0);assert.equal(fresh.models[0].lastRequest,'修改 ok');
 assert.equal(buildSessionContext({name:'B',jobs:[]},'new'),undefined);
 const limit=cleanSessionContext({requirements:'a'.repeat(3500),secret:'unused',turns:Array(20).fill({request:'b'.repeat(1600),url:'unused'})});
 assert.equal(limit.requirements.length,3000);assert.equal(limit.turns.length,8);assert.equal(limit.turns[0].request.length,900);assert.ok(!JSON.stringify(limit).includes('unused'));
});
