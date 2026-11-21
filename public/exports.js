import {$,esc,download,blobToData,safeAssetURL,kindOf,alongPath} from './ui.js';

const wait=ms=>new Promise(ok=>setTimeout(ok,ms));
async function getImage(url){const r=await fetch(url,{credentials:'omit'});if(!r.ok)throw Error('无法读取图像');return createImageBitmap(await r.blob())}
async function record(canvas,duration,draw,signal){
 if(!window.MediaRecorder||!canvas.captureStream)throw Error('当前浏览器无法录制画布，请使用较新版本的 Edge 或 Chrome。');
 const mime=['video/webm;codecs=vp9','video/webm;codecs=vp8','video/webm'].find(t=>MediaRecorder.isTypeSupported(t));if(!mime)throw Error('浏览器缺少 WebM 编码器');
 await draw(0);
 const stream=canvas.captureStream(24),rec=new MediaRecorder(stream,{mimeType:mime,videoBitsPerSecond:6000000}),chunks=[];
 rec.ondataavailable=e=>{if(e.data.size)chunks.push(e.data)};
 const completed=new Promise((ok,no)=>{rec.onstop=()=>ok(new Blob(chunks,{type:mime}));rec.onerror=e=>no(e.error||Error('录制失败'))});
 try{rec.start();const start=performance.now();while(!signal.aborted){const t=Math.min(1,(performance.now()-start)/duration);await draw(t);if(t>=1)break;await wait(34)}rec.stop();const blob=await completed;if(signal.aborted)throw Error('已取消录制');return blob}
 finally{if(rec.state!=='inactive')rec.stop();for(const tr of stream.getTracks())tr.stop()}
}
function choice(id,title){return '<button data-export="'+id+'">'+title+'</button>'}
export function openExports({project,view,showDialog,notify,importProject,close}){
 const images=project.assets.filter(a=>kindOf(a)==='image'&&safeAssetURL(a.url));
 const aborter=new AbortController();
 showDialog('导出与备份','<div class="menu-rows">'+choice('png','导出当前机位 · PNG')+choice('obj','导出白模几何 · OBJ')+choice('three','导出 Three.js 模块 · JS')+choice('glb','导出场景网格 · GLB')+choice('path','导出相机参数与路径 · JSON')+choice('movie','录制本地相机路径 · WebM')+choice('sequence','合成素材图片序列 · WebM')+choice('project','导出项目与本地素材 · .atlas.json')+choice('restore','从 .atlas.json 导入项目')+'</div><input type="file" id="restore-file" accept=".json" hidden><div id="export-status" role="status" class="note"></div>');
 const root=$('#dialog-content'),status=$('#export-status'),dialog=$('#dialog');
 dialog.addEventListener('close',()=>aborter.abort(),{once:true});
 async function act(kind){const name=project.name;
  if(kind==='png'){download(name+'.png',await(await fetch(view.snapshot())).blob());return}
  if(kind==='obj'){download(name+'.obj',view.exportOBJ(),'text/plain');return}
  if(kind==='three'||kind==='glb'){
   if(!project.scene.objects.length)throw Error('请先在场景中添加一个物体。');
   const {nativeGroup,modelModule}=await import('./three-model.js');
   if(kind==='three'){download(name+'.js',modelModule(project.scene.objects,name),'text/javascript');return}
   const {GLTFExporter}=await import('three/addons/exporters/GLTFExporter.js');
   const group=nativeGroup(project.scene.objects,name);
   try{download(name+'.glb',await new GLTFExporter().parseAsync(group,{binary:true}),'model/gltf-binary')}
   finally{group.traverse(o=>{o.geometry?.dispose();o.material?.dispose()})}
   return;
  }
  if(kind==='path'){const {orbitToAtlasCamera}=await import('./viewport.js');download(name+'-cameras.json',JSON.stringify({coordinateSystem:'rub',targetCameras:project.cameras.map(k=>orbitToAtlasCamera(k.camera)),keyframes:project.cameras.map(({name,camera})=>({name,camera}))},null,2),'application/json');return}
  if(kind==='project'){const data=structuredClone(project);for(const a of data.assets){if(a.url.startsWith('/media/')){a.backupSource=a.url;const r=await fetch(a.url);if(!r.ok)throw Error('本地素材读取失败：'+a.name);a.url=await blobToData(await r.blob())}}download(name+'.atlas.json',JSON.stringify(data),'application/json');return}
  if(kind==='restore'){$('#restore-file').click();return}
  if(kind==='movie'){
   if(project.cameras.length<2)throw Error('请先保存两个或更多机位。');
   const camera=view.getCamera();const frames=structuredClone(project.cameras);const duration=2100*(frames.length-1);
   try{const video=await record($('#scene'),duration,t=>{view.setCamera(alongPath(frames,t));status.textContent='相机路径录制中 '+Math.round(t*100)+'%'},aborter.signal);download(name+'-path.webm',video)}finally{view.setCamera(camera)}return
  }
  if(kind==='sequence'){
   if(images.length<2)throw Error('请先将至少两帧图像保存到项目素材。');
   root.querySelector('.menu-rows').innerHTML='<p class="note">勾选要合成的图像。按下方顺序播放，可用箭头调整。</p><div id="seq-list"></div><label class="field">每秒帧数<input id="seq-fps" type="number" min="1" max="30" value="8"></label>'+choice('encode','生成 WebM');
   const list=$('#seq-list');
   images.forEach((a,i)=>{const row=document.createElement('div');row.className='pair';row.dataset.index=i;row.innerHTML='<label><input type="checkbox" checked> '+esc(a.name)+'</label><span><button type="button" aria-label="向上移动">↑</button><button type="button" aria-label="向下移动">↓</button></span>';const [up,down]=row.querySelectorAll('button');up.onclick=()=>{if(row.previousElementSibling)list.insertBefore(row,row.previousElementSibling)};down.onclick=()=>{if(row.nextElementSibling)list.insertBefore(row.nextElementSibling,row)};list.append(row)});return
  }
  if(kind==='encode'){
   const selected=[...$('#seq-list').children].filter(r=>r.querySelector('input').checked).map(r=>images[Number(r.dataset.index)]);if(!selected.length)throw Error('至少选择一帧图像');
   const fps=Number($('#seq-fps').value);if(!Number.isFinite(fps)||fps<1||fps>30)throw Error('帧率应在 1–30 之间');
   const frames=[];
   try{for(const [i,a] of selected.entries()){if(aborter.signal.aborted)return;status.textContent='读取图像 '+(i+1)+' / '+selected.length;frames.push(await getImage(a.url))}
    const canvas=document.createElement('canvas');const scale=Math.min(1,1920/Math.max(frames[0].width,frames[0].height));canvas.width=Math.max(2,Math.round(frames[0].width*scale/2)*2);canvas.height=Math.max(2,Math.round(frames[0].height*scale/2)*2);const ctx=canvas.getContext('2d');
    const video=await record(canvas,frames.length/fps*1000,t=>{const f=frames[Math.min(frames.length-1,Math.floor(t*frames.length))];const s=Math.min(canvas.width/f.width,canvas.height/f.height);ctx.fillStyle='#000';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.drawImage(f,(canvas.width-f.width*s)/2,(canvas.height-f.height*s)/2,f.width*s,f.height*s);status.textContent='编码中 '+Math.round(t*100)+'%'},aborter.signal);download(name+'-sequence.webm',video)
   } finally{frames.forEach(f=>f.close())}
  }
 }
 let busy=false;root.onclick=async e=>{const kind=e.target.closest('[data-export]')?.dataset.export;if(!kind||busy)return;busy=true;status.textContent='';try{await act(kind);if(!['restore','sequence'].includes(kind))status.textContent='已导出'}catch(err){status.textContent=err.message}finally{busy=false}};
 const input=$('#restore-file');input.onchange=async()=>{const file=input.files[0];if(!file)return;try{await importProject(JSON.parse(await file.text()));close()}catch(err){status.textContent=err.message;notify(err.message)}};
 dialog.addEventListener('close',()=>{root.onclick=null},{once:true})
}
