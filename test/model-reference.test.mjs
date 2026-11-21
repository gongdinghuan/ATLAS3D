import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {handleProvider} from '../providers.mjs';

test('参考图按真实图像发送，支持仅用图片新建和带图修改，错误输入不会提交',async t=>{
 const folder=await mkdtemp(join(tmpdir(),'atlas-reference-'));
 const filename=randomUUID()+'.png',referenceImage='/media/'+filename;
 const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl1PMoAAAAASUVORK5CYII=';
 await writeFile(join(folder,filename),Buffer.from(png,'base64'));
 const model={name:'雨棚',parts:[{name:'板',geometry:'BoxGeometry',size:[3,.2,2],position:[0,2,0],rotation:[0,0,0],color:'#776655'}]};
 process.env.DEEPSEEK_API_KEY='fixture';process.env.DASHSCOPE_API_KEY='fixture';process.env.DASHSCOPE_WORKSPACE_ID='ws-test';process.env.MINIMAX_API_KEY='fixture';
 const requests=[];
 t.mock.method(globalThis,'fetch',async(url,opts)=>{
  const body=JSON.parse(opts.body),content=body.messages[1].content;assert.ok(Array.isArray(content));
  assert.deepEqual(content.filter(c=>c.type==='image_url'),[{type:'image_url',image_url:{url:'data:image/png;base64,'+png}}]);
  requests.push({model:body.model,input:JSON.parse(content.find(c=>c.type==='text').text)});
  return Response.json({model:body.model,choices:[{finish_reason:'stop',message:{content:JSON.stringify(model)}}]});
 });
 const submit=(provider,input)=>handleProvider('POST','/api/tasks',{provider,task:'threeModel',input},folder);
 for(const [provider,actual] of [['deepseek','deepseek-flash'],['minimax','MiniMax-M3.1-Flash'],['qwen','qwen3-vl-plus']]){
  const op=await submit(provider,{referenceImage});assert.equal(op.response.model,actual);assert.equal(op.response.threeModel.name,'雨棚');
  assert.match(requests.at(-1).input.request,/参考图/);
 }
 await submit('qwen',{model:'qwen3-vl-plus',referenceImage,prompt:'按图修改雨棚',previous:model});
 assert.deepEqual(requests.at(-1).input.previous,model);assert.equal(requests.at(-1).input.request,'按图修改雨棚');
 await assert.rejects(submit('qwen',{referenceImage,model:'qwen3-coder-flash'}),{status:400});
 for(const invalid of ['','/media/../server.mjs','https://example.org/photo.png'])await assert.rejects(submit('minimax',{referenceImage:invalid,prompt:'建模'}),{status:400});
 await assert.rejects(submit('minimax',{referenceImage:'/media/'+randomUUID()+'.jpg'}),{status:404});
 await writeFile(join(folder,filename),'not an image');await assert.rejects(submit('deepseek',{referenceImage}),{status:415});
 assert.equal(requests.length,4);
});

