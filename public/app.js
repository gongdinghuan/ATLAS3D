import {createViewport,defaultScene,orbitToAtlasCamera} from './viewport.js';
import {mountWorkflows} from './workflows.js';
import {$,esc,icons,api,download,blobToData,safeAssetURL,kindOf,alongPath,uid} from './ui.js';
import {journal,acknowledged,recover,openCheckpoints} from './resume.js';
import {openExports} from './exports.js';
import {validateModel,modelParts,readPart} from './model-spec.js';
import {modelModule,frameModel} from './three-model.js';

const titles={view:'场景取景器',edit:'白模编辑',light:'光照工作台',mesh:'网格工作台'};
const startCamera={yaw:34,pitch:21,distance:26,target:[0,2,0]};
const clone=structuredClone;
let projects=[],project,view,workflow,mode='view',tab='inspector',playing=0,thumbTimer=0;
let chosenCamera=null,viewerCleanup=null,toastTimer=0;
const pending=new Map(),issues=new Map(),saving=new Map(),undoStack=[],redoStack=[];
function notify(message){const el=$('#toast');el.textContent=message;el.className='show';clearTimeout(toastTimer);toastTimer=setTimeout(()=>el.className='',3800)}
function savedStatus(){
 const el=$('#save-state');if(!project)return;const id=project.id;
 el.textContent=issues.get(id)?.message||((pending.has(id)||saving.has(id))?'正在保存…':'已保存到本机');
 el.className=issues.has(id)?'warning':pending.has(id)||saving.has(id)?'':'ok';
}
function queue(p){if(!p)return;p.editNumber=(p.editNumber||0)+1;journal(p);pending.set(p.id,p);savedStatus();clearTimeout(persistTimer);persistTimer=setTimeout(flush,240)}
let persistTimer;
async function saveOne(id){
 if(saving.has(id))return saving.get(id);
 const work=(async()=>{
  while(pending.has(id)&&!issues.has(id)){
   const p=pending.get(id); pending.delete(id);
   try{const token=p.editToken;const result=await api('/api/projects','PUT',p);p.revision=result.revision;p.updatedAt=result.updatedAt;acknowledged(p,token)}
   catch(e){issues.set(id,e);pending.set(id,p);notify(e.message);break}
  }
 })();saving.set(id,work);savedStatus();
 try{await work}finally{saving.delete(id);savedStatus()}
}
async function flush(){await Promise.all([...pending.keys()].map(saveOne))}
window.addEventListener('beforeunload',e=>{if(pending.size||saving.size){e.preventDefault();e.returnValue=''}});document.addEventListener('visibilitychange',()=>{if(document.hidden)flush()});
function updateProject(updater,id=project?.id){const p=projects.find(v=>v.id===id);if(!p)return;updater(p);queue(p);if(p===project){renderSide();renderStrip();renderHeader()}}
function snapshotHistory(){undoStack.push(clone({scene:project.scene,cameras:project.cameras}));if(undoStack.length>32)undoStack.shift();redoStack.length=0}
function undo(reverse){const source=reverse?redoStack:undoStack,target=reverse?undoStack:redoStack;const prev=source.pop();if(!prev)return notify(reverse?'没有可重做的修改':'没有可撤销的修改');target.push(clone({scene:project.scene,cameras:project.cameras}));Object.assign(project,prev);view.setScene(project.scene);renderAll();queue(project)}
function updateScene(fn,history=true){if(history)snapshotHistory();fn(project.scene);view.setScene(project.scene);queue(project);renderSide()}
function makeProject(name,demo=true){
 const scene=defaultScene();if(!demo){scene.objects=[];scene.selectedId=null}
 const camera=clone(startCamera);
 const cameras=demo?[{id:uid(),name:'建筑全景',camera:clone(camera)},{id:uid(),name:'侧向取景',camera:{yaw:-32,pitch:17,distance:25,target:[0,2,0]}},{id:uid(),name:'高位取景',camera:{yaw:54,pitch:39,distance:31,target:[0,1.5,0]}}]:[];
 return {id:uid(),name,revision:0,camera,cameras,scene,jobs:[],assets:[]};
}
function smallThumb(){
 const source=$('#scene');const canvas=document.createElement('canvas');canvas.width=216;canvas.height=96;
 const ctx=canvas.getContext('2d');const scale=Math.max(216/source.width,96/source.height);ctx.drawImage(source,(216-source.width*scale)/2,(96-source.height*scale)/2,source.width*scale,source.height*scale);return canvas.toDataURL('image/jpeg',.72)
}
function refreshThumbnails(){
 if(playing)return;
 const selectedProject=project;clearTimeout(thumbTimer);
 thumbTimer=setTimeout(async()=>{
  if(selectedProject!==project||playing)return;
  const missing=project.cameras.filter(c=>!c.thumb);if(!missing.length)return;
  const saved=view.getCamera();
  for(const item of missing){view.setCamera(item.camera);view.snapshot();item.thumb=smallThumb()}
  view.setCamera(saved);renderStrip();queue(project);
 },80)
}
function choose(p){
 stopPlay();project=p;mode=Object.hasOwn(titles,p.editor?.mode)?p.editor.mode:'view';tab=['inspector','assets','jobs'].includes(p.editor?.tab)?p.editor.tab:'inspector';chosenCamera=p.editor?.chosenCamera||null;undoStack.length=redoStack.length=0;
 localStorage.setItem('atlas-active',p.id);view.setScene(p.scene);view.setCamera(p.camera||startCamera);renderAll();refreshThumbnails();workflow?.refresh()
}
function remember(){if(!project)return;project.editor={...project.editor,mode,tab,chosenCamera,generationOpen:$('#generate-dialog').open};queue(project)}
function renderHeader(){
 $('#projects').innerHTML=projects.map(p=>'<option value="'+esc(p.id)+'">'+esc(p.name)+'</option>').join('');$('#projects').value=project.id;
 $('#scene-name').textContent=project.name;$('#mode-title').textContent=titles[mode];savedStatus()
}
function renderStrip(){
 const list=project.cameras;$('#camera-count').textContent=String(list.length).padStart(2,'0');
 $('#camera-strip').innerHTML=list.map((c,i)=>'<div class="camera-card '+(c.id===chosenCamera?'current':'')+'" role="button" tabindex="0" data-camera="'+esc(c.id)+'" aria-label="切换机位 '+esc(c.name)+'">'+(safeThumb(c.thumb)?'<img alt="" src="'+esc(c.thumb)+'">':'<div style="height:56px"></div>')+'<div class="camera-foot"><em>'+String(i+1).padStart(2,'0')+'</em><b>'+esc(c.name)+'</b><button title="移除机位" aria-label="移除机位 '+esc(c.name)+'" data-remove-camera="'+esc(c.id)+'">×</button></div></div>').join('')+'<button class="camera-add" data-action="add-camera" title="保存当前机位" aria-label="保存当前机位">＋</button>';
 $('#play-label').textContent=playing?'停止':'播放'
}
function safeThumb(str){return typeof str==='string'&&/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(str)}
function renderAll(){renderHeader();renderStrip();renderSide();icons()}
function section(title,html,sub=''){return '<section class="side-section"><div class="section-title">'+title+'<span>'+sub+'</span></div>'+html+'</section>'}
function action(id,label,icon,style='secondary full'){return '<button class="'+style+'" data-action="'+id+'">'+(icon?'<i data-icon="'+icon+'"></i>':'')+label+'</button>'}
function slider(name,label,val,min,max,step=1,unit=''){return '<label class="field"><span class="field-label">'+label+'<output id="out-'+name+'">'+Number(val).toFixed(step<1?1:0)+unit+'</output></span><input type="range" data-range="'+name+'" aria-label="'+label+'" min="'+min+'" max="'+max+'" step="'+step+'" value="'+val+'"></label>'}
function inspector(){
 const s=project.scene,cam=project.camera||startCamera;
 let html='';
 if(mode==='edit'||mode==='view')html+=section('大模型建模',action('three-task','文字建模 · Three.js','spark','primary full'));
 if(mode==='view'){
  html+=section('相机参数',slider('yaw','水平角度',cam.yaw,-180,180,1,'°')+slider('pitch','俯仰角度',cam.pitch,-85,85,1,'°')+slider('distance','相机距离',cam.distance,2,100,.1,' m')+action('add-camera','保存当前机位','camera'),'透视');
 }
 if(mode==='edit'){
  html+=section('添加几何体','<div class="btn-row">'+['box','cylinder','sphere'].map((type,i)=>'<button class="secondary small" data-shape="'+type+'">'+['方体','圆柱','球体'][i]+'</button>').join('')+'</div>');
  const obj=s.objects.find(o=>o.id===s.selectedId);
  if(obj){
   const fields=(keys,title)=>'<label class="field">'+title+'</label><div class="columns">'+keys.map((k,i)=>'<label class="mini">'+['X','Y','Z'][i]+'<input type="number" step=".1" data-object-prop="'+k+'" value="'+Number(obj[k]).toFixed(2)+'"></label>').join('')+'</div>';
   html+=section('物体属性','<label class="field">名称<input data-object-prop="name" value="'+esc(obj.name)+'" maxlength="80"></label>'+fields(['x','y','z'],'中心位置 · m')+fields(['w','h','d'],'尺寸 · m')+(obj.type==='three'?fields(['rx','ry','rz'],'旋转 · °'):'')+'<label class="field">材质色<input type="color" data-object-prop="color" value="'+esc(obj.color)+'"></label><div class="btn-row">'+action('duplicate-object','复制','','secondary small')+action('remove-object','移除','','secondary small')+'</div>')
  }
 }
 if(mode==='light'){
  const light=s.light;
  html+=section('场景光照',slider('azimuth','光源方向',light.azimuth,-180,360,1,'°')+slider('elevation','太阳高度',light.elevation,2,88,1,'°')+slider('intensity','光照强度',light.intensity,.1,2.5,.05)+action('screenshot','导出当前画面','download'),'本地白模');
  html+=section('Splat 调色','<p>打开素材中的三维文件，可调整亮度与色调，导出当前视角。</p>'+action('assets','查看三维素材','layers'));
 }
 if(mode==='mesh')html+=section('网格转换','<p>从已生成的 Gaussian splat 或本地文件提交网格转换，完成后可下载 GLB。</p>'+action('mesh-task','将 Splat 转为 GLB','mesh','primary full')+action('obj','导出当前白模 OBJ','download'));
 const label=mode==='edit'?'从白模生成外观':mode==='view'?'从当前相机生成新视角':'';
 if(label)html+=section('Atlas 生成',action(mode==='edit'?'chisel-task':'view-task',label,'spark'));
 if(mode==='edit'||mode==='view'){
 html+=section('场景物体','<div class="object-list">'+(s.objects.map(o=>'<button data-object="'+esc(o.id)+'" class="item '+(o.id===s.selectedId?'selected':'')+'"><i data-icon="cube"></i><span class="item-title">'+esc(o.name)+'</span></button>').join('')||'<p class="empty">在白模工具中添加第一个物体。</p>')+'</div>',s.objects.length+' 个');
 }
 html+=section('项目','<div class="pair"><span>'+esc(project.name)+'</span>'+action('project-rename','重命名','','text-btn')+'</div>'+action('project-copy','另存为本地副本','folder')+(issues.has(project.id)?action('retry-save','重试保存','','secondary full'):''));
 return html
}
function renderSide(){
 if(!project)return;for(const b of document.querySelectorAll('[data-tab]'))b.classList.toggle('selected',b.dataset.tab===tab);
 for(const b of document.querySelectorAll('[data-mode]'))b.classList.toggle('active',b.dataset.mode===mode);
 let html;
 if(tab==='assets'){
 const assets=project.assets;
 html=section('项目素材',action('import','导入图片、视频或三维文件','upload')+'<div class="asset-list">'+(assets.map(a=>'<button class="item" data-asset="'+esc(a.id)+'">'+(kindOf(a)==='image'&&safeAssetURL(a.url)?'<img alt="" src="'+esc(a.url)+'">':'<i data-icon="'+(kindOf(a)==='video'?'film':'cube')+'"></i>')+'<span class="item-title">'+esc(a.name)+'</span></button>').join('')||'<p class="empty">项目尚无素材。</p>')+'</div>',assets.length+' 个')
 }else if(tab==='jobs'){
 html=section('任务历史',action('workflows','打开生成任务','spark')+'<div class="job-list">'+(project.jobs.map(j=>'<button class="item" data-action="workflows"><span>'+esc(j.task)+'</span><span class="chip-status">'+esc(j.status||'等待')+'</span></button>').join('')||'<p class="empty">项目尚未提交生成任务。</p>')+'</div>')
 }else html=inspector();
 $('#side-content').innerHTML=html;icons($('#side-content'))
}
function cameraFields(){const cam=project.camera;for(const k of ['yaw','pitch','distance']){const el=document.querySelector('[data-range="'+k+'"]');if(el){el.value=cam[k];$('#out-'+k).textContent=cam[k].toFixed(k==='distance'?1:0)+(k==='distance'?' m':'°')}}}
function stopPlay(){
 if(playing){cancelAnimationFrame(playing);playing=0;if(project){project.camera=view.getCamera();queue(project);renderStrip();cameraFields()}}
}
function play(){
 if(playing){stopPlay();return}
 if(project.cameras.length<2)return notify('请先保存至少两个机位');
 const start=performance.now(),frames=clone(project.cameras),duration=(frames.length-1)*2100;
 const step=now=>{const t=Math.min(1,(now-start)/duration);view.setCamera(alongPath(frames,t));if(t>=1){stopPlay();return}playing=requestAnimationFrame(step)};
 playing=requestAnimationFrame(step);renderStrip()
}
function saveCamera(){stopPlay();snapshotHistory();const item={id:uid(),name:'机位 '+String(project.cameras.length+1).padStart(2,'0'),camera:view.getCamera(),thumb:smallThumb()};project.cameras.push(item);chosenCamera=item.id;remember();renderStrip()}
function showDialog(title,html){closePreview();$('#dialog-title').textContent=title;$('#dialog-content').innerHTML=html;icons($('#dialog-content'));if(!$('#dialog').open)$('#dialog').showModal()}
function closePreview(){viewerCleanup?.();viewerCleanup=null}
$('#dialog').addEventListener('close',closePreview);
function formDialog(title,initial,callback,option=''){showDialog(title,'<form id="name-form"><label class="field">项目名称<input id="project-input" required maxlength="80" autocomplete="off" value="'+esc(initial)+'"></label>'+option+'<div class="dialog-actions"><button type="button" class="secondary" data-action="close">取消</button><button class="primary">保存</button></div></form>');$('#name-form').onsubmit=e=>{e.preventDefault();const value=$('#project-input').value.trim();if(!value)return;callback(value);$('#dialog').close()};$('#project-input').select()}
async function uploadBlob(blob,name){
 const r=await fetch('/api/local-assets?name='+encodeURIComponent(name),{method:'POST',headers:{'content-type':'application/octet-stream'},body:blob});const value=await r.json();if(!r.ok)throw Error(value.error||'无法保存素材');return value
}
async function addAsset(input,projectId=project.id){
 let saved;
 if(input instanceof File)saved=await uploadBlob(input,input.name);
 else{
  let url=input.url;if(!url)throw Error('缺少素材地址');
  if(url.startsWith('data:')||url.startsWith('blob:')||/^https?:\/\//.test(url)){
   try{const resp=await fetch(url,{credentials:'omit',referrerPolicy:'no-referrer'});if(!resp.ok)throw Error('素材下载失败');saved=await uploadBlob(await resp.blob(),input.name)}
   catch(e){if(!safeAssetURL(url))throw e;notify('外部素材未能下载，已保留来源链接')}
  }
  if(!saved){url=safeAssetURL(url);if(!url)throw Error('素材地址无效');saved={id:uid(),url,name:input.name,type:input.type}}
 }
 if(input.assetId)saved.assetId=input.assetId;
 updateProject(p=>p.assets.push(saved),projectId);return saved
}
async function importFiles(files){const id=project.id;let n=0;for(const file of files){await addAsset(file,id);n++}tab='assets';renderSide();notify('已导入 '+n+' 个素材')}
async function showPointCloud(frames){
 const pid=project.id;if($('#generate-dialog').open)$('#generate-dialog').close();
 showDialog('重建点云取景','<div id="rgbd-stage" style="height:54vh"></div>');
 const host=$('#rgbd-stage');const {mountRGBDPreview}=await import('./rgbd-preview.js');
 if(!host.isConnected||!$('#dialog').open)return;
 const result=await mountRGBDPreview(host,frames,{onCamera:cam=>{if(project.id!==pid)return;project.camera=cam;view.setCamera(cam);saveCamera();$('#dialog').close();notify('点云机位已存入相机路径')}});
 if(!host.isConnected||!$('#dialog').open)result.destroy();else viewerCleanup=()=>result.destroy()
}
async function previewAsset(id){
 const a=project.assets.find(x=>x.id===id);if(!a)return;let url=safeAssetURL(a.url);if(a.assetId && !url.startsWith('/media/')){try{const link=await api('/api/assets/'+encodeURIComponent(a.assetId)+'/url');url=safeAssetURL(link.url)}catch(e){if(!url)throw e}}if(!url)throw Error('无法打开素材地址');
 const kind=kindOf(a);const media=kind==='image'?'<img class="preview-img" alt="素材预览" src="'+esc(url)+'">':kind==='video'?'<video class="preview-video" controls src="'+esc(url)+'"></video>':kind==='model'?'<div id="preview-model" class="model-stage"></div>':'<p class="note">此格式可下载后在对应工具中打开。</p>';
 showDialog(a.name,media+'<div class="asset-dialog pair"><a download="'+esc(a.name)+'" href="'+esc(url)+'" target="_blank" rel="noopener noreferrer">下载素材</a><button class="text-btn" data-remove-asset="'+esc(id)+'">从项目移除</button></div>');
 if(kind==='model'){const host=$('#preview-model');try{const {mountModelPreview}=await import('./model-preview.js');if(!host.isConnected)return;const handle=await mountModelPreview(host,{...a,url});if(!host.isConnected||!$('#dialog').open)handle?.destroy();else viewerCleanup=()=>handle?.destroy()}catch(e){if(host.isConnected)host.textContent='三维预览失败：'+e.message}}
}
async function settings(){
 const s=await api('/api/settings');
 const badge=on=>'<span class="setting-state '+(on?'on':'')+'">'+(on?'● 已配置':'○ 未配置')+'</span>';
 const minimaxSettings='<div class="setting-group"><h3>MiniMax · Three.js 建模 '+badge(s.minimaxConfigured)+'</h3><label class="field">MiniMax API Key（中国站）<input id="minimax-key" type="password" autocomplete="new-password" placeholder="'+(s.minimaxConfigured?'保留已存密钥':'输入 MiniMax 中国站密钥')+'"></label></div>';
 const domesticSettings='<div class="setting-group"><h3>DeepSeek · Three.js 建模 '+badge(s.deepseekConfigured)+'</h3><label class="field">DeepSeek API Key<input type="password" autocomplete="new-password" id="deepseek-key" placeholder="填写后保存在本机"></label></div><div class="setting-group"><h3>阿里云百炼 · 千问建模 / 万相文生图 '+badge(s.domestic?.wan)+'</h3><label class="field">百炼 Workspace ID（北京）<input id="wan-workspace" placeholder="ws-…" value="'+esc(s.wanWorkspace||'')+'"></label><label class="field">百炼 API Key<input id="wan-key" type="password" autocomplete="new-password" placeholder="填写后保存在本机"></label></div><div class="setting-group"><h3>腾讯混元 3D · 三维生成 '+badge(s.domestic?.hunyuan)+'</h3><label class="field">腾讯云 SecretId<input id="tencent-id" type="password" autocomplete="new-password" placeholder="AKID…"></label><label class="field">腾讯云 SecretKey<input id="tencent-key" type="password" autocomplete="new-password" placeholder="与 SecretId 配对填写"></label></div>';
 showDialog('模型服务','<form id="settings-form" autocomplete="off">'+minimaxSettings+domesticSettings+'<div class="setting-group"><h3>World Labs Atlas '+badge(s.atlasConfigured)+'</h3><label class="field">项目 API 密钥<input id="atlas-key" type="password" autocomplete="new-password" placeholder="'+(s.atlasConfigured?'保留已存密钥':'输入 Atlas 项目密钥')+'"></label></div><div class="setting-group"><h3>兼容 Images API 的服务 '+badge(s.imagesConfigured)+'</h3><label class="field">API 基础地址<input required type="url" id="image-base"></label><label class="field">图像模型<input required id="image-model"></label><label class="field">服务 API 密钥<input type="password" id="image-key" autocomplete="new-password" placeholder="'+(s.imagesConfigured?'保留已存密钥':'输入服务密钥')+'"></label></div><div class="setting-group"><h3>Meshy 图生 3D '+badge(s.meshyConfigured)+'</h3><label class="field">Meshy API 密钥<input type="password" id="meshy-key" autocomplete="new-password" placeholder="保留已存密钥"></label></div><p class="note">密钥保存在此电脑的工作台数据目录。生成任务由所选服务处理并计费。</p><div class="control-error" id="settings-error" role="alert"></div><div class="dialog-actions"><button type="button" class="secondary" data-action="close">取消</button><button class="primary">保存配置</button></div></form>');
 $('#image-base').value=s.imagesBase;$('#image-model').value=s.imagesModel;
 $('#settings-form').onsubmit=async e=>{e.preventDefault();const btn=e.submitter;btn.disabled=true;try{await api('/api/settings','PUT',{minimaxKey:$('#minimax-key').value,deepseekKey:$('#deepseek-key').value,wanWorkspace:$('#wan-workspace').value,wanKey:$('#wan-key').value,tencentId:$('#tencent-id').value,tencentKey:$('#tencent-key').value,atlasKey:$('#atlas-key').value,meshyKey:$('#meshy-key').value,imagesBase:$('#image-base').value,imagesModel:$('#image-model').value,imagesKey:$('#image-key').value});$('#dialog').close();workflow?.refresh();notify('模型服务配置已保存')}catch(err){$('#settings-error').textContent=err.message}finally{btn.disabled=false}}
}
function getModel(p,id){
 const parts=p.scene.objects.filter(o=>o.type==='three'&&o.group===id);
 return parts.length?{name:parts[0].groupName,parts:parts.map(readPart)}:null;
}
function installModel(pid,jobId,asNew=false){
 const p=projects.find(item=>item.id===pid),job=p?.jobs.find(item=>item.id===jobId);
 if(!job||p!==project||job.modelApplied)return;
 const model=validateModel(job.response.threeModel);
 const target=asNew?null:job.modelGroup;
 if(target&&JSON.stringify(getModel(p,target))!==JSON.stringify(job.modelBase)){
  job.modelConflict=true;job.note='提交后原模型已更改。可以将生成结果作为新模型加入场景。';queue(p);return;
 }
 const group=target||'model-'+job.id;
 const parts=modelParts(model,group,job.id);
 const existing=p.scene.objects.filter(o=>o.group!==group);
 if(!target&&existing.length){
  const radius=o=>Math.hypot(o.w,o.h,o.d)/2;
  const right=existing.reduce((x,o)=>Math.max(x,o.x+radius(o)),-Infinity);
  const left=Math.min(...parts.map(o=>o.x-radius(o)));
  for(const o of parts)o.x+=right+1-left;
 }
 const camera=frameModel(parts,p.camera);
 stopPlay();snapshotHistory();
 p.scene.objects=existing.concat(parts);p.scene.selectedId=parts[0].id;p.camera=camera;chosenCamera=null;
 job.modelApplied=group;job.modelConflict=false;job.note='已加入场景，可逐件编辑或继续描述修改。';
 view.setScene(p.scene);view.setCamera(camera);mode='edit';tab='inspector';remember();renderAll();
 return group;
}
function downloadModel(spec){
 const model=validateModel(spec);
 download(model.name+'.js',modelModule(modelParts(model,'export','export'),model.name),'text/javascript');
}
function openGeneration(task){$('#generate-dialog').showModal();workflow.refresh(task);remember()}
$('#generate-dialog').addEventListener('close',remember);
async function run(action){
 switch(action){
 case 'checkpoints':await openCheckpoints({project,showDialog,updateProject,notify,chooseCopy:(p,label)=>{p.id=uid();p.revision=0;p.name=p.name+' · '+label;projects.push(p);choose(p);queue(p)}});break;
 case 'close':$('#dialog').close();break;case 'close-workflows':$('#generate-dialog').close();break;
 case 'settings':await settings();break;
 case 'three-task':openGeneration('threeModel');break;
 case 'workflows':openGeneration();break;case 'view-task':openGeneration('atlasGenerate');break;case 'chisel-task':openGeneration('atlasChisel');break;case 'mesh-task':openGeneration('splats2Mesh');break;
 case 'assets':tab='assets';renderSide();break;
 case 'add-camera':saveCamera();break;case 'play':play();break;
 case 'grid':updateScene(s=>s.grid=!s.grid);break;case 'fullscreen':if(document.fullscreenElement)await document.exitFullscreen();else await $('#view-wrap').requestFullscreen();break;
 case 'reset-camera':stopPlay();project.camera=clone(startCamera);view.setCamera(project.camera);chosenCamera=null;queue(project);renderAll();break;
 case 'project-create':formDialog('新建项目','新场景',name=>{const p=makeProject(name,$('#project-template').value==='pavilion');projects.push(p);choose(p);queue(p)},'<label class="field">起始场景<select id="project-template"><option value="empty">空场景</option><option value="pavilion">庭院展亭</option></select></label>');break;
 case 'project-copy':formDialog('另存为副本',project.name+' · 副本',name=>{const p=clone(project);p.name=name;p.id=uid();p.revision=0;projects.push(p);choose(p);queue(p)});break;
 case 'project-rename':formDialog('重命名项目',project.name,name=>updateProject(p=>p.name=name));break;
 case 'retry-save':issues.delete(project.id);queue(project);break;
 case 'import':$('#import-file').click();break;
 case 'duplicate-object':updateScene(s=>{const o=s.objects.find(x=>x.id===s.selectedId);if(o){const copy={...o,id:uid(),name:o.name+' 副本',x:o.x+.5};s.objects.push(copy);s.selectedId=copy.id}});break;
 case 'remove-object':updateScene(s=>{s.objects=s.objects.filter(o=>o.id!==s.selectedId);s.selectedId=null});break;
 case 'obj':download(project.name+'.obj',view.exportOBJ(),'text/plain');break;
 case 'screenshot':{const png=await(await fetch(view.snapshot())).blob();download(project.name+'.png',png);break}
 case 'export':stopPlay();openExports({project,view,showDialog,notify,refresh:renderAll,onCameraRestore:cameraFields,importProject,close:()=>$('#dialog').close()});break;
 case 'shortcuts':showDialog('工作台操作','<div class="shortcut-list"><span>环绕 / 平移</span><span><kbd>拖动</kbd> / <kbd>Shift + 拖动</kbd></span><span>缩放</span><span><kbd>滚轮</kbd></span><span>选择物体</span><span><kbd>单击</kbd></span><span>撤销 / 重做</span><span><kbd>Ctrl + Z</kbd> / <kbd>Ctrl + Y</kbd></span><span>立即保存</span><span><kbd>Ctrl + S</kbd></span></div>');break;
 }}
async function importProject(p){
 if(!p||typeof p.name!=='string'||!Array.isArray(p.scene?.objects)||!Array.isArray(p.cameras)||!Array.isArray(p.assets))throw Error('项目文件缺少场景、机位或素材');
 const validCam=c=>c&&['yaw','pitch','distance'].every(k=>Number.isFinite(c[k]))&&c.distance>0&&Array.isArray(c.target)&&c.target.length===3&&c.target.every(Number.isFinite);
 if(!validCam(p.camera)||p.cameras.some(f=>!validCam(f.camera)))throw Error('项目文件的相机参数无效');
 if(!p.scene.light||!['azimuth','elevation','intensity'].every(k=>Number.isFinite(p.scene.light[k]))||p.scene.objects.some(o=>!o||!['box','cylinder','sphere','three'].includes(o.type)||!['x','y','z','w','h','d'].every(k=>Number.isFinite(o[k]))))throw Error('项目文件的几何或光照参数无效');
 for(const o of p.scene.objects)if(o.type==='three')validateModel({name:o.groupName||o.name,parts:[readPart(o)]});
 const moved=new Map();for(const a of p.assets){if(a.url?.startsWith('data:')){const blob=await(await fetch(a.url)).blob();const local=await uploadBlob(blob,a.name);moved.set(a.backupSource||'/media/'+a.id,local.url);delete a.backupSource;a.url=local.url}else if(!safeAssetURL(a.url))throw Error('无效素材地址')}
 function rebind(node){if(!node||typeof node!=='object')return;for(const [k,v] of Object.entries(node)){if(typeof v==='string'&&moved.has(v))node[k]=moved.get(v);else if(typeof v==='object')rebind(v)}}rebind(p.workflowDrafts);rebind(p.jobs);
 p.id=uid();p.revision=0;p.jobs=Array.isArray(p.jobs)?p.jobs:[];p.name=p.name.trim()||'导入项目';projects.push(p);choose(p);queue(p);notify('项目已导入')
}
document.addEventListener('click',async e=>{
 const el=e.target.closest('button,[data-camera]');if(!el)return;
 try{
 if(el.dataset.action)await run(el.dataset.action);
 else if(el.dataset.mode){mode=el.dataset.mode;tab='inspector';renderAll();remember()}
 else if(el.dataset.tab){tab=el.dataset.tab;renderSide();remember()}
 else if(el.dataset.object){project.scene.selectedId=el.dataset.object;view.setScene(project.scene);renderSide();queue(project)}
 else if(el.dataset.shape){const t=el.dataset.shape;updateScene(s=>{const o={id:uid(),name:({box:'方体',cylinder:'圆柱',sphere:'球体'}[t])+' '+(s.objects.length+1),type:t,x:0,y:1,z:0,w:2,h:2,d:2,color:'#b9c1b9'};s.objects.push(o);s.selectedId=o.id})}
 else if(el.dataset.removeCamera){snapshotHistory();project.cameras=project.cameras.filter(c=>c.id!==el.dataset.removeCamera);queue(project);renderStrip()}
 else if(el.dataset.camera){stopPlay();const c=project.cameras.find(c=>c.id===el.dataset.camera);if(c){chosenCamera=c.id;remember();project.camera=clone(c.camera);view.setCamera(c.camera);queue(project);renderStrip();cameraFields()}}
 else if(el.dataset.asset)await previewAsset(el.dataset.asset);
 else if(el.dataset.removeAsset){updateProject(p=>p.assets=p.assets.filter(a=>a.id!==el.dataset.removeAsset));$('#dialog').close()}
 }catch(err){notify(err.message)}
});
document.addEventListener('keydown',e=>{
 if(e.target.matches('[data-camera]')&&['Enter',' '].includes(e.key)){e.preventDefault();e.target.click();return}
 if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='s'){e.preventDefault();flush();return}
 if(e.target.closest('input,textarea,select,[contenteditable],dialog'))return;
 if((e.ctrlKey||e.metaKey)&&['z','y'].includes(e.key.toLowerCase())){e.preventDefault();undo(e.shiftKey||e.key.toLowerCase()==='y')}
});
$('#projects').onchange=e=>choose(projects.find(p=>p.id===e.target.value));
$('#import-file').onchange=async e=>{try{await importFiles([...e.target.files])}catch(err){notify(err.message)}finally{e.target.value=''}};
$('#side-content').addEventListener('pointerdown',e=>{if(e.target.dataset.range&&['azimuth','elevation','intensity'].includes(e.target.dataset.range))snapshotHistory()});
$('#side-content').addEventListener('input',e=>{const k=e.target.dataset.range;if(!k)return;const n=Number(e.target.value);if(['yaw','pitch','distance'].includes(k)){stopPlay();project.camera={...view.getCamera(),[k]:n};view.setCamera(project.camera);chosenCamera=null;cameraFields()}else{project.scene.light[k]=n;view.setScene(project.scene);$('#out-'+k).textContent=n+(k==='intensity'?'':'°')}queue(project)});
$('#side-content').addEventListener('change',e=>{const key=e.target.dataset.objectProp;if(!key)return;const raw=e.target.value;const v=['name','color'].includes(key)?raw:Number(raw);if(typeof v==='number'&&(!Number.isFinite(v)||(['w','h','d'].includes(key)&&v<=0))){renderSide();return notify('尺寸必须大于零')}updateScene(s=>{const o=s.objects.find(o=>o.id===s.selectedId);if(o)o[key]=v})});
const wrap=$('#view-wrap');wrap.addEventListener('dragover',e=>e.preventDefault());wrap.addEventListener('drop',async e=>{e.preventDefault();try{await importFiles([...e.dataTransfer.files])}catch(err){notify(err.message)}});
async function init(){
 icons();projects=await api('/api/projects');const restored=await recover(projects);for(const p of restored)queue(p);
 view=createViewport($('#scene'),{onSelect:id=>{if(!project)return;project.scene.selectedId=id;view.setScene(project.scene);renderSide();queue(project)},onCameraChange:cam=>{if(!project)return;stopPlay();project.camera=cam;chosenCamera=null;cameraFields();queue(project)}});
 if(!projects.length){const p=makeProject('庭院展亭');projects.push(p);queue(p)}
 choose(projects.find(p=>p.id===localStorage.getItem('atlas-active'))||projects[0]);
 workflow=mountWorkflows($('#workflow-root'),{getProject:()=>project,updateProject,getModel,installModel,downloadModel,showScene:()=>$('#generate-dialog').close(),saveDraft:(pid,t,d)=>{const p=projects.find(x=>x.id===pid);if(!p)return;p.workflowDrafts||={};p.workflowDrafts[t]=d;p.activeTask=t;queue(p)},flushProject:async id=>{await saveOne(id);if(issues.has(id))throw issues.get(id)},showPointCloud, getAtlasCamera:orbitToAtlasCamera,getPathCameras:(count=24)=>{if(!project.cameras.length)return [];const n=Math.max(1,Math.min(1440,Math.trunc(count)||24));return Array.from({length:n},(_,i)=>orbitToAtlasCamera(alongPath(project.cameras,i/Math.max(1,n-1))))},notify,getSnapshot:()=>view.snapshot(),getDepthSnapshot:camera=>view.captureDepth(camera||view.getCamera(),1280,720),addAsset});
 workflow.refresh();
 if(project.editor?.generationOpen)openGeneration(project.activeTask);
 if(restored.length)notify('已恢复上次尚未写入磁盘的编辑');
}
init().catch(e=>{document.querySelector('main').textContent='工作台启动失败：'+e.message;console.error(e)});


