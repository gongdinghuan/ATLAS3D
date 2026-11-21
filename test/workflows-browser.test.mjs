import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile,mkdtemp,rm,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

// Run inside the browser. The fetch fixture handles API calls only.
async function exercise(mountWorkflows) {
  const root=document.querySelector('main');
  const click=label=>{
    const b=[...root.querySelectorAll('button')].find(b=>!b.disabled && b.textContent===label);
    if(!b)throw Error('Missing button: '+label);
    b.click();
  };
  const until=async(fn,why)=>{
    for(let i=0;i<200;i++){if(fn())return;await new Promise(r=>setTimeout(r,15));}
    throw Error('Timed out: '+why+' · '+root.innerText.slice(0,400));
  };
  const setField=(name,value)=>{
    const label=[...root.querySelectorAll('label')].find(l=>l.firstElementChild?.textContent===name);
    if(!label)throw Error('Missing field: '+name);
    const el=label.querySelector('input,textarea,select');el.value=value;
    el.dispatchEvent(new Event(el.tagName==='SELECT'?'change':'input',{bubbles:true}));return el;
  };
  const assert=(yes,msg)=>{if(!yes)throw Error(msg);};
  const camera={intrinsics:{width:1280,height:720,fx:800,fy:800,cx:640,cy:360},extrinsics:{coordinateSystem:'rub',quaternion:[0,0,0,1],position:[0,0,0]}};
  const f={imageAsset:{assetId:'asset_img'},camera,depth:{depthAsset:{assetId:'asset_depth'}}};
  let pid='A',release,request,upload,polls=0,shouldCancel=false,failSubmit=false;
  const projects=Object.fromEntries(['A','B'].map(id=>[id,{id,camera,assets:[],jobs:[],cameras:[{id:'1',name:'A',camera},{id:'2',name:'B',camera}]}]));
  const ctx={getProject:()=>projects[pid],updateProject:(mut,id)=>mut(projects[id]),getAtlasCamera:()=>camera,
    getDepthSnapshot:async()=>({dataUrl:'data:image/png;base64,QQ==',camera,zMin:3,zMax:3}),
    getPathCameras:n=>Array(n).fill(camera),notify:()=>{}, addAsset:async(a,id)=>{const saved={...a,id:crypto.randomUUID(),url:'/assets/saved.png'};projects[id].assets.push(saved);return saved;}};
  const original=window.fetch;
  window.fetch=async(path,opts={})=>{
    const json=data=>new Response(JSON.stringify(data),{headers:{'content-type':'application/json'}});
    if(path==='/api/providers')return json({providers:[{id:'atlas',configured:true},{id:'images',configured:true}]});
    if(path==='/api/tasks'){
      request=JSON.parse(opts.body);
      if(request.input.prompt==='hold')await new Promise(r=>{release=r;});
      if(failSubmit){failSubmit=false;throw Error('network disconnected');}
      if(request.provider==='images')return json({id:'image1',done:true,response:{frames:[{imageAsset:{url:'data:image/png;base64,QQ=='}}]}});
      if(request.task==='images2PosedRGBD')return json({id:'op_pose',done:false});
      return json({id:'op_done',done:true,response:{frames:[f,f]}});
    }
    if(path==='/api/assets'){upload=JSON.parse(opts.body);return json({assetId:'asset_upload'});}
    if(String(path).startsWith('/api/assets/'))return json({url:'/assets/result.png'});
    if(path==='/api/operations/op_pose'){
      if(opts.method==='DELETE') {shouldCancel=true;return json({id:'op_pose',done:false});}
      polls++;return json(shouldCancel ? {id:'op_pose',done:true,error:{code:'CANCELLED'}}:{id:'op_pose',done:false});
    }
    return original(path,opts);
  };
  const widget=mountWorkflows(root,ctx);
  await until(()=>!root.querySelector('.wf-primary').disabled,'services');
  setField('场景描述','hold');click('提交任务');await until(()=>release,'dispatch');
  pid='B';widget.refresh();release();
  await until(()=>projects.A.jobs[0]?.status==='succeeded','completed in original project');
  assert(projects.B.jobs.length===0 && !root.innerText.includes('op_done'),'late result leaked');
  pid='A';widget.refresh('images2PosedRGBD');
  const dt=new DataTransfer();dt.items.add(new File(['pixel'],'photo.png',{type:'image/png'}));
  root.querySelector('input[type=file]').files=dt.files;root.querySelector('input[type=file]').dispatchEvent(new Event('change'));
  click('提交任务');await until(()=>projects.A.jobs[0].status==='running','submitted upload');
  assert(upload.base64==='cGl4ZWw=' && request.input.frames[0].imageAsset.assetId==='asset_upload','upload/submit');
  click('请求取消任务');await until(()=>shouldCancel && projects.A.jobs[0].status==='cancelling','cancel acknowledged');
  click('立即查询');await until(()=>projects.A.jobs[0].status==='cancelled','cancel finished');
  widget.refresh('atlasGenerate');root.querySelector('.wf-sources input').click();
  setField('目标视角','path');setField('路径总帧数','6');click('提交任务');
  await until(()=>projects.A.jobs[0].status==='succeeded' && request.task==='atlasGenerate','new views');
  assert(request.input.targetCameras.length===6 && request.input.contextFrames[0].depth.depthAsset.assetId==='asset_depth','path and context');
  click('保存全部 2 帧到项目');await until(()=>projects.A.assets.length===2,'saved sequence');
  widget.refresh('atlasChisel');setField('编辑后的场景','stucco');click('提交任务');
  await until(()=>projects.A.jobs[0].task==='atlasChisel' && projects.A.jobs[0].status==='succeeded','depth guided chisel');
  assert(request.input.targetFrames[0].depth.logDepthAsset.assetId==='asset_upload','layout depth');
  widget.refresh('atlasTextToImage');setField('推理服务','images');setField('模型','fixture-model');setField('场景描述','landscape');click('提交任务');
  await until(()=>projects.A.jobs[0].provider==='images' && projects.A.jobs[0].status==='succeeded','images provider');
  assert(request.input.model==='fixture-model' && projects.A.jobs[0].response.frames[0].imageAsset.url==='/assets/saved.png','inline result saved');
  widget.refresh('splats2Mesh');click('JSON');await until(()=>root.querySelector('.wf-code'),'JSON mode');
  setField('请求体 JSON','{"splatAsset":{"assetId":"asset_draft"},"textureMode":"none"}');
  failSubmit=true;click('提交任务');await until(()=>projects.A.jobs[0].status==='uncertain','uncertain request');
  const key=request.requestId;
  click('用原请求 ID 恢复提交');await until(()=>projects.A.jobs[0].status==='succeeded','idempotent retry');
  assert(request.requestId===key && request.input.splatAsset.assetId==='asset_draft','replayed same id and input');
  const before=polls;pid='B';
  projects.B.jobs.push({id:'restored',provider:'atlas',task:'images2PosedRGBD',status:'running',operationId:'op_pose',createdAt:new Date().toISOString()});
  widget.refresh();await until(()=>polls>before && projects.B.jobs[0].status==='cancelled','restore automatic polling');
}

test('browser exercises project isolation, uploads, cancellation, paths, depth, images, JSON and recovery', {timeout:60000}, async t=>{
  const candidates=[process.env.ATLAS_TEST_BROWSER,'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe','/usr/bin/chromium','/usr/bin/google-chrome'].filter(Boolean);
  let browser;
  for(const path of candidates){try{await access(path);browser=path;break;}catch{}}
  if(!browser){t.skip('Set ATLAS_TEST_BROWSER to a Chromium executable.');return;}
  const module=await readFile(new URL('../public/workflows.js',import.meta.url),'utf8');
  const server=createServer((req,res)=>{
    if(req.url==='/workflows.js'){res.setHeader('content-type','text/javascript; charset=utf-8');res.end(module);return;}
    if(req.url!=='/'){res.writeHead(404);res.end();return;}
    res.setHeader('content-type','text/html; charset=utf-8');
    res.end('<main></main><script type="module">import {mountWorkflows} from "/workflows.js"; ('+exercise.toString()+')(mountWorkflows).then(()=>{document.body.textContent="workflow-browser-pass"}).catch(e=>{document.body.textContent="workflow-browser-failure "+e.stack})</script>');
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const profile=await mkdtemp(join(tmpdir(),'atlas-workflow-test-'));
  try{
    const {stdout}=await promisify(execFile)(browser,['--headless=new','--disable-gpu','--disable-extensions','--disable-background-networking','--disable-sync','--no-first-run','--user-data-dir='+profile,'--virtual-time-budget=18000','--dump-dom','http://127.0.0.1:'+server.address().port+'/'],{windowsHide:true,timeout:50000,maxBuffer:3*1024*1024});
    assert.match(stdout,/<body>workflow-browser-pass<\/body>/,stdout.slice(0,1600));
  }finally{
    server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
    await rm(profile,{force:true,recursive:true,maxRetries:5,retryDelay:100});
  }
});
