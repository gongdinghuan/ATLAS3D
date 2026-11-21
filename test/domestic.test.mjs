import test from 'node:test';
import assert from 'node:assert/strict';
import {handleProvider} from '../providers.mjs';
import {buildTaskInput,resultAssets} from '../public/workflows.js';

test('万相按北京业务空间提交并以原编号取回多张图片',async t=>{
 t.mock.method(globalThis,'fetch',async(url,init)=>{
  assert.match(String(url),/^https:\/\/ws-example.cn-beijing.maas.aliyuncs.com\/api\/v1\//);
  assert.equal(new Headers(init.headers).get('Authorization'),'Bearer wan-test');
  if(init.method==='POST'){
   assert.equal(new Headers(init.headers).get('X-DashScope-Async'),'enable');
   const data=JSON.parse(init.body);assert.equal(data.model,'wan2.6-t2i');assert.deepEqual(data.parameters,{n:2,size:'1280*1280',prompt_extend:true});assert.equal(data.input.messages[0].content[0].text,'庭院');
   return Response.json({output:{task_id:'job-9',task_status:'PENDING'}})
  }
  assert.ok(String(url).endsWith('/tasks/job-9'));
  return Response.json({output:{task_status:'SUCCEEDED',choices:[{message:{content:[{image:'https://example.org/1.png'},{image:'https://example.org/2.png'}]}}]}})
 });
 process.env.DASHSCOPE_API_KEY='wan-test';process.env.DASHSCOPE_WORKSPACE_ID='ws-example';
 const input=buildTaskInput('atlasTextToImage',{provider:'wan',prompt:'庭院',n:2,wanSize:'1280*1280'});
 const op=await handleProvider('POST','/api/tasks',{provider:'wan',task:'atlasTextToImage',input});
 assert.equal(op.done,false);const result=await handleProvider('GET','/api/operations/'+op.id);
 assert.equal(result.response.frames.length,2);assert.equal(result.done,true);
 await assert.rejects(handleProvider('DELETE','/api/operations/'+op.id),{status:405});
});
test('腾讯混元签署中国区请求，按原编号轮询并保留 GLB 和 OBJ 输出',async t=>{
 process.env.TENCENTCLOUD_SECRET_ID='tencent-id';process.env.TENCENTCLOUD_SECRET_KEY='tencent-key';
 const calls=[];t.mock.method(globalThis,'fetch',async(url,init)=>{
  assert.equal(String(url),'https://ai3d.tencentcloudapi.com/');const h=new Headers(init.headers),data=JSON.parse(init.body);
  assert.match(h.get('Authorization'),/^TC3-HMAC-SHA256 Credential=tencent-id\/\d{4}-\d\d-\d\d\/ai3d\/tc3_request, SignedHeaders=content-type;host, Signature=[a-f\d]{64}$/);assert.equal(h.get('X-TC-Version'),'2025-05-13');assert.equal(h.get('X-TC-Region'),'ap-guangzhou');
  calls.push(h.get('X-TC-Action'));
  if(calls.length===1){assert.deepEqual(data,{Model:'3.1',Prompt:'一把椅子',GenerateType:'Normal'});return Response.json({Response:{JobId:'987'}})}
  assert.deepEqual(data,{JobId:'987'});return Response.json({Response:{Status:'DONE',ResultFile3Ds:[{Type:'OBJ',Url:'https://example.org/chair.zip'},{Type:'GLB',Url:'https://example.org/chair.glb'}]}})
 });
 const op=await handleProvider('POST','/api/tasks',{provider:'hunyuan',task:'hunyuanTo3D',input:{prompt:'一把椅子',model:'3.1'}});
 const result=await handleProvider('GET','/api/operations/'+op.id);assert.equal(result.response.mesh.url,'https://example.org/chair.glb');
 assert.ok(resultAssets(result.response).some(a=>a.ext==='zip'));assert.deepEqual(calls,['SubmitHunyuanTo3DProJob','QueryHunyuanTo3DProJob']);
 await assert.rejects(handleProvider('POST','/api/tasks',{provider:'hunyuan',task:'hunyuanTo3D',input:{prompt:'a',image_url:'https://example.org/a.png'}}),{status:400});
 const publicInfo=await handleProvider('GET','/api/providers');assert.ok(publicInfo.providers.find(p=>p.id==='hunyuan').configured);assert.doesNotMatch(JSON.stringify(publicInfo),/tencent-key|wan-test|tencent-id/);
});
