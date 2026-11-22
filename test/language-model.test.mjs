import test from 'node:test';
import {Raycaster,Vector3} from 'three';
import assert from 'node:assert/strict';
import {handleProvider} from '../providers.mjs';
import {validateModel,modelParts,readPart} from '../public/model-spec.js';
import {nativeGroup,modelModule} from '../public/three-model.js';
import {meshScene} from '../public/viewport-geometry.js';

const model={name:'木亭',parts:[{name:'斜屋顶',geometry:'ExtrudeGeometry',profile:[[-1,0],[1,0],[0,1]],position:[0,3,0],size:[6,2,4],rotation:[0,30,0],color:'#aa8855'}]};
test('墙体孔洞可穿透，编辑与导出的模块保留同一轮廓',async()=>{
 const part={...model.parts[0],name:'开窗墙',position:[0,0,0],rotation:[0,0,0],size:[4,4,.2],profile:[[-2,-2],[2,-2],[2,2],[-2,2]],holes:[[[-1,-1],[1,-1],[1,1],[-1,1]]]};
 const spec=validateModel({name:'立面',parts:[part]}),objects=modelParts(spec,'wall','v1');
 assert.deepEqual(readPart(objects[0]),spec.parts[0]);
 const source=modelModule(objects,spec.name).replace("'three'",JSON.stringify(import.meta.resolve('three')));
 const exported=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
 for(const group of [nativeGroup(objects),exported.buildModel()]){
  group.updateMatrixWorld(true);
  const hit=x=>new Raycaster(new Vector3(x,0,2),new Vector3(0,0,-1)).intersectObjects(group.children).length;
  assert.equal(hit(0),0);assert.ok(hit(1.5)>0);
 }
 for(const holes of [[[[1,1],[3,1],[3,3]]],[part.holes[0],part.holes[0]],[[[0,0],[1,1],[0,1],[1,0]]]]){
  assert.throws(()=>validateModel({name:'立面',parts:[{...part,holes}]}));
 }
});
test('语言模型以一次对话请求生成结构，可在下一次描述中继续修改',async t=>{
 t.mock.method(globalThis,'fetch',async(url,opts)=>{
  assert.equal(url,'https://api.deepseek.com/chat/completions');assert.equal(opts.headers.Authorization,'Bearer model-test-key');
  const body=JSON.parse(opts.body);assert.equal(body.model,'deepseek-flash');assert.equal(body.response_format.type,'json_object');assert.match(body.messages[0].content,/ExtrudeGeometry/);assert.match(body.messages[1].content,/木亭/);
  return Response.json({model:body.model,choices:[{finish_reason:'stop',message:{content:JSON.stringify(model)}}]});
 });
 process.env.DEEPSEEK_API_KEY='model-test-key';
 const op=await handleProvider('POST','/api/tasks',{provider:'deepseek',task:'threeModel',input:{prompt:'把木亭加高',previous:model}});
 assert.equal(op.done,true);assert.equal(op.response.threeModel.parts[0].geometry,'ExtrudeGeometry');
 await assert.rejects(handleProvider('POST','/api/tasks',{provider:'deepseek',task:'threeModel',input:{prompt:' '}}),{status:400});
 assert.equal(globalThis.fetch.mock.callCount(),1)
});
test('千问 Coder 调用北京业务空间，拒绝截断或非法结构的回复',async t=>{
 process.env.DASHSCOPE_WORKSPACE_ID='ws-language-test';process.env.DASHSCOPE_API_KEY='qwen-test-key';
 let choice={finish_reason:'length',message:{content:'{'}};
 t.mock.method(globalThis,'fetch',async(url,opts)=>{
  assert.equal(url,'https://ws-language-test.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/chat/completions');
  const payload=JSON.parse(opts.body);assert.equal(payload.model,'qwen3-coder-flash');assert.equal(payload.response_format.type,'json_object');
  return Response.json({choices:[choice]});
 });
 const generate=()=>handleProvider('POST','/api/tasks',{provider:'qwen',task:'threeModel',input:{prompt:'生成一组屋顶'}});
 await assert.rejects(generate(),{status:422});choice={finish_reason:'stop',message:{content:'{"parts":[]}'}};await assert.rejects(generate(),{status:422});
 choice.message.content=JSON.stringify(model);assert.deepEqual((await generate()).response.threeModel,validateModel(model));
});
test('MiniMax 中国站使用所选模型续改，只读取最终答复并保留请求边界',async t=>{
 const saved=process.env.MINIMAX_API_KEY;
 t.after(()=>{if(saved===undefined)delete process.env.MINIMAX_API_KEY;else process.env.MINIMAX_API_KEY=saved});
 delete process.env.MINIMAX_API_KEY;
 const submit=(input={})=>handleProvider('POST','/api/tasks',{provider:'minimax',task:'threeModel',input:{prompt:'保留斜屋顶，加高木亭',previous:model,...input}});
 const caps=async()=>(await handleProvider('GET','/api/providers')).providers.find(p=>p.id==='minimax');
 assert.equal((await caps())?.configured,false);
 await assert.rejects(submit(),{status:503});
 const key='fixture-minimax-unit';process.env.MINIMAX_API_KEY=key;
 assert.equal((await caps()).configured,true);assert.ok(!JSON.stringify(await caps()).includes(key));
 let choice={finish_reason:'stop',message:{reasoning_content:'内部推理',content:JSON.stringify(model)}};
 const requests=[];let error;
 t.mock.method(globalThis,'fetch',async(url,options)=>{
  assert.equal(url,'https://api.minimax.cn/v1/chat/completions');assert.equal(options.headers.Authorization,'Bearer '+key);
  const req=JSON.parse(options.body);requests.push(req);assert.equal(req.reasoning_split,true);assert.equal(req.thinking,undefined);
  assert.equal(req.response_format,undefined);assert.ok(req.max_completion_tokens>0);
  if(error)return Response.json(error,{status:401});
  return Response.json({model:req.model,choices:[choice]});
 });
 const result=await submit();assert.deepEqual(result.response.threeModel,validateModel(model));assert.equal(result.response.model,'MiniMax-M3.1-Flash');
 assert.deepEqual(JSON.parse(requests[0].messages[1].content).previous,validateModel(model));
 assert.equal(requests[0].reasoning_effort,'medium');assert.ok(!JSON.stringify(result).includes('内部推理'));
 choice.message.content='\x60\x60\x60json\n'+JSON.stringify(model)+'\n\x60\x60\x60';
 assert.equal((await submit({model:'MiniMax-M3'})).response.model,'MiniMax-M3');assert.equal(requests[1].reasoning_effort,undefined);
 await assert.rejects(submit({model:'other'}),{status:400});assert.equal(requests.length,2);
 const fresh=await submit({previous:undefined});assert.equal(fresh.response.threeModel.name,'木亭');assert.equal(Object.hasOwn(JSON.parse(requests[2].messages[1].content),'previous'),false);
 choice.finish_reason='length';await assert.rejects(submit(),{status:422});
 choice={finish_reason:'stop',message:{reasoning_content:JSON.stringify(model),content:' '}};await assert.rejects(submit(),{status:422});
 error={error:{message:'Invalid API key '+key}};await assert.rejects(submit(),e=>e.status===401&&!e.message.includes(key));
});
test('Three.js 几何体、编辑器网格、模块导出共享尺寸和旋转',async()=>{
 const parts=modelParts(validateModel(model),'group','version');const native=nativeGroup(parts);assert.equal(native.children.length,1);assert.equal(native.children[0].geometry.type,'ExtrudeGeometry');assert.equal(native.children[0].rotation.y,Math.PI/6);
 assert.ok(meshScene(parts)[0].faces.length>=8);assert.deepEqual(readPart(parts[0]),validateModel(model).parts[0]);
 const moduleSource=modelModule(parts,'木亭').replace("'three'",JSON.stringify(import.meta.resolve('three')));
 const exported=await import('data:text/javascript;base64,'+Buffer.from(moduleSource).toString('base64'));
 const rebuilt=exported.buildModel();assert.equal(rebuilt.children[0].geometry.type,'ExtrudeGeometry');assert.deepEqual(rebuilt.children[0].scale.toArray(),model.parts[0].size);
 assert.match(modelModule(parts,'木亭'),/import \* as THREE from 'three'/);
 const custom={...model.parts[0],geometry:'BufferGeometry',vertices:[[0,0,0],[1,0,0],[0,1,0]],triangles:[[0,1,2]],repeat:{count:2,step:[1,0,0]}};
 const meshes=modelParts(validateModel({name:'面板',parts:[custom]}),'panels','v2');
 assert.equal(meshes.length,2);assert.equal(meshScene(meshes)[0].faces.length,1);
 assert.throws(()=>validateModel({name:'面板',parts:[{...custom,triangles:[[0,2,3]]}]}));
 assert.throws(()=>validateModel({...model,parts:[{...model.parts[0],geometry:'ShaderMaterial'}]}));assert.throws(()=>validateModel({...model,parts:[{...model.parts[0],size:[0,2,3]}]}));
});
