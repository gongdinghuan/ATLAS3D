const tasks = {
  threeModel: ['文字建模','直接调用语言模型生成 Three.js 网格，可在白模中逐件编辑。',''],
  hunyuanTo3D: ['混元 3D','使用腾讯混元专业版，将文字或参考图生成三维模型。',''],
  meshyImageTo3D: ['Meshy 图生 3D','从单张参考图生成可下载的 GLB 模型。',''], 
  atlasTextToImage: ['文生图', '从场景描述生成起始图像。', 'atlas-text-to-image'],
  images2PosedRGBD: ['图像重建', '从一组有重叠的照片估计相机位姿和深度。', 'images2-posed-rgbd'],
  atlasGenerate: ['生成新视角', '选择已有位姿和深度的帧，按目标相机生成新画面。', 'atlas-generate'],
  atlasChisel: ['Chisel 编辑', '用布局深度确定空间，或用遮罩指定需要重绘的区域。', 'atlas-chisel'],
  posedImages2Splats: ['生成 Splat', '使用同一空间中的多张 RGBD 帧重建 Gaussian splat。', 'posed-images2-splats'],
  splats2Mesh: ['转换网格', '将 SPZ 场景转换为可下载的 GLB 网格。', 'splats2-mesh']
};
const languageServices={
  deepseek:{label:'DeepSeek',docs:'https://api-docs.deepseek.com/guides/json_mode/'},
  qwen:{label:'通义千问',docs:'https://help.aliyun.com/zh/model-studio/qwen-structured-output',modelField:'qwenModel'},
  minimax:{label:'MiniMax',docs:'https://platform.minimax.cn/docs/api-reference/text-openai-api',modelField:'minimaxModel'}
};
const asynchronousProviders=new Set(['atlas','meshy','wan','hunyuan']);
const terminal = new Set(['succeeded','failed','cancelled']);
const stateNames = { submitting:'提交中', uncertain:'提交待核对', running:'运行中', cancelling:'正在取消', succeeded:'已完成', failed:'失败', cancelled:'已取消' };
const grids = ['1280x720','720x1280','960x720','528x704'];
const must = (ok, message) => { if (!ok) throw new Error(message); };
const messageOf = err => typeof err === 'string' ? err : err?.message || err?.detail || '服务返回未知错误。';
const gridOf = cam => cam?.intrinsics?.width + 'x' + cam?.intrinsics?.height;

export function assetReference(asset) {
  if (asset?.assetId) return {assetId:asset.assetId};
  if (asset?.base64) return {base64:asset.base64};
  if (/^data:/i.test(asset?.url)) return {base64:asset.url};
  if (/^https:\/\//i.test(asset?.url)) return {url:asset.url};
  throw new Error('请选择文件、项目素材或有效的 Atlas 资产。');
}

function inputDepth(depth) {
  if (depth?.depthAsset) return {depthAsset:assetReference(depth.depthAsset)};
  if (depth?.logDepthAsset) {
    must(Number.isFinite(depth.zMin) && Number.isFinite(depth.zMax) && depth.zMin > 0 && depth.zMax >= depth.zMin, '对数深度的取值范围无效。');
    return {logDepthAsset:assetReference(depth.logDepthAsset),zMin:depth.zMin,zMax:depth.zMax};
  }
  throw new Error('选中的帧缺少深度图。');
}

export function posedFrame(frame) {
  must(frame?.camera?.intrinsics && frame.camera.extrinsics, '选中的帧缺少相机参数。');
  return { imageAsset:assetReference(frame.imageAsset), camera:frame.camera, depth:inputDepth(frame.depth) };
}

function matchingGrid(frames, supported) {
  const grid=gridOf(frames[0]?.camera);
  must(frames.every(f => gridOf(f.camera) === grid), '请选择相同分辨率的帧。');
  if (supported) must(grids.includes(grid), '请先在图像重建中选择支持的目标分辨率。');
}

export function buildTaskInput(task, v) {
  const prompt = v.prompt?.trim();
  if (task === 'atlasTextToImage') {
    must(prompt,'请填写场景描述。');
    if (v.provider === 'wan') return {prompt,n:Number(v.n||1),size:v.wanSize||'1280*1280',enhance:v.enhance!==false};
    if (v.provider === 'images') return {prompt, ...(v.model?.trim() ? {model:v.model.trim()} : {}), ...(v.size ? {size:v.size} : {}), n:Number(v.n || 1)};
    return {prompt,aspectRatio:v.ratio || '16:9', numSamples:Number(v.n || 1), enhancePrompt:v.enhance !== false, returnDepth:!!v.returnDepth};
  }
  if (task === 'images2PosedRGBD') {
    must(v.images?.length, '请至少添加一张图片。');
    const body={frames:v.images.map(asset => ({imageAsset:assetReference(asset)})),canonicalizeToFirstFrame:!!v.canonical};
    if (v.resolution) body.targetResolution=v.resolution.split('x').map(Number);
    return body;
  }
  if (task === 'atlasGenerate' || task === 'posedImages2Splats') {
    const frames=(v.frames || []).map(posedFrame);
    const extra=prompt ? {prompt} : {};
    if (task === 'posedImages2Splats') {
      const limit=v.refine ? 512 : 32;
      must(frames.length >= 2 && frames.length <= limit, '请选择 2 至 ' + limit + ' 张带深度的帧。');
      matchingGrid(frames,true);
      must(frames.every(f => f.depth.depthAsset), '生成 Splat 需要线性 EXR 深度。请使用图像重建或返回线性深度的新视角。');
      return {posedFrames:frames,refine:!!v.refine,...extra};
    }
    must(frames.length,'请选择至少一张带深度的参考帧。');
    matchingGrid(frames,false);
    must(v.cameras?.length,'请先录制相机关键帧或选择目标视角。');
    matchingGrid(v.cameras.map(camera=>({camera})),true);
    return {contextFrames:frames,targetCameras:v.cameras, returnDepth:!!v.returnDepth,...extra};
  }
  if (task === 'atlasChisel') {
    must(prompt,'请描述编辑后的场景。');
    must(v.targets?.length,'请选择编辑视角。');
    const targetFrames=v.targets.map(f=>{
      must(gridOf(f.camera)==='1280x720','Chisel 的目标图像和相机必须为 1280 × 720，请先按此尺寸重建。');
      const target={camera:f.camera};
      if (f.depth) target.depth=inputDepth(f.depth);
      if (f.imageAsset) target.imageAsset=assetReference(f.imageAsset);
      if (f.maskAsset) target.maskAsset=assetReference(f.maskAsset);
      return target;
    });
    return {targetFrames,prompt,returnDepth:!!v.returnDepth};
  }
  must(task === 'splats2Mesh','未知任务。');
  const body={splatAsset:assetReference(v.splat),textureMode:v.textureMode || 'image_texture'};
  if (body.textureMode === 'image_texture') body.textureSize=Number(v.textureSize || 4096);
  if (v.faces) {
    must(Number.isSafeInteger(Number(v.faces)) && Number(v.faces)>0,'目标面数必须是正整数。');
    body.targetFaces=Number(v.faces);
  }
  if (v.colliders) body.colliderBoxes={};
  return body;
}

export function resultAssets(response={}) {
  const out=[];
  function add(asset,label,ext,type) {
    if (asset?.url || asset?.assetId || asset?.base64) out.push({asset,label,ext,type});
  }
  (response.frames || []).forEach((f,i)=>{
    const prefix='帧 ' + String(i+1).padStart(2,'0') + ' · ';
    add(f.imageAsset,prefix+'图像','png','image');
    add(f.maskAsset,prefix+'保留遮罩','png','image');
    add(f.depth?.depthAsset,prefix+'线性深度','exr','depth');
    add(f.depth?.logDepthAsset,prefix+'对数深度','png','image');
    add(f.depth?.confidenceAsset,prefix+'置信度','png','image');
  });
  add(response.draftSplat,'草稿 Splat','spz','splat');
  for (const [count,asset] of Object.entries(response.refinedSplats || {})) add(asset, '精细 Splat · '+count,'spz','splat');
  add(response.mesh,'场景网格','glb','model');
  for(const file of response.modelFiles || [])add(file.asset,file.label,file.ext,file.ext==='glb'?'model':'file');
  add(response.colliderBoxes,'碰撞盒','glb','model');
  return out;
}

export function mergeOperation(job, op) {
  if (terminal.has(job.status)) return job;
  must(op && typeof op.done === 'boolean' && op.id,'服务未返回有效任务状态。');
  const cancelled=/cancel/i.test([op.error?.code,op.error?.status,op.error?.message,op.metadata?.state].join(' '));
  const status=op.done ? (op.error ? (cancelled ? 'cancelled':'failed') : 'succeeded') : (job.status==='cancelling' ? 'cancelling':'running');
  return {...job,operationId:op.id,status,metadata:op.metadata, response:op.response ?? undefined,
    error:op.error ? messageOf(op.error) : undefined, pollError:undefined, pollPaused:false, input:undefined};
}

async function api(path, method='GET', body) {
  const res=await fetch(path,{method,...(body ? {headers:{'Content-Type':'application/json'}, body:JSON.stringify(body)}:{})});
  let data;
  try { data=await res.json(); } catch { throw new Error('本地服务未返回 JSON（HTTP ' + res.status + '）。'); }
  if (!res.ok) throw Object.assign(new Error(messageOf(data.error || data)),{status:res.status});
  return data;
}

function dom(tag, className, content) {
  const node=document.createElement(tag);
  if (className) node.className=className;
  if (content != null) node.textContent=content;
  return node;
}

function button(label, run, style='wf-btn') {
  const node=dom('button',style,label);
  node.type='button'; node.addEventListener('click',run);
  return node;
}

function fileData(file) {
  return new Promise((resolve,reject)=>{
    const reader=new FileReader();
    reader.onload=()=>resolve(reader.result);
    reader.onerror=()=>reject(new Error('无法读取文件 ' + (file.name || '') + '。'));
    reader.readAsDataURL(file);
  });
}

function safeUrl(url) {
  if (typeof url !== 'string') return '';
  if (/^data:(?:image\/(?:png|jpe?g|webp|gif|avif)|application\/octet-stream);base64,/i.test(url)) return url;
  try {
    const u=new URL(url,location.origin);
    if (u.protocol==='https:' || u.origin===location.origin && u.protocol==='http:') return u.href;
  } catch { /* An operation may contain only an asset ID. */ }
  return '';
}

async function resourceUrl(asset,fresh=false) {
  const cached=safeUrl(asset.url || asset.base64);
  if (cached && (!fresh || !asset.assetId)) return cached;
  must(asset.assetId,'结果中缺少可用的资源地址。');
  const result=await api('/api/assets/'+encodeURIComponent(asset.assetId)+'/url');
  const url=safeUrl(result.url);
  must(url,'资产服务未返回有效的下载地址。'); return url;
}

const jobTitle=job=>tasks[job.task]?.[0] || job.task || 'Atlas 任务';
const jobKey=job=>job.id;
function defaults() {
  return {modelDetail:'standard',minimaxModel:'MiniMax-M3.1-Flash',qwenModel:'qwen3-coder-flash',targetModel:'new',hunyuanMode:'text',hunyuanModel:'3.1',wanSize:'1280*1280',meshTexture:true,provider:'atlas',ratio:'16:9',n:1,enhance:true,returnDepth:true,resolution:'1280x720',canonical:true,
    prompt:'',images:[],sources:[],targets:'current',count:24,chisel:'layout',refine:false,textureMode:'image_texture',textureSize:4096};
}

function availableFrames(project, needsDepth=false) {
  return (project.jobs || []).flatMap(j=>(j.response?.frames || []).flatMap((f,i)=>{
    if (!f.imageAsset || needsDepth && (!f.camera || !f.depth)) return [];
    return [{id:jobKey(j)+'@'+i,label:jobTitle(j)+' · 帧 '+(i+1)+' · '+new Date(j.createdAt).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'}),frame:f}];
  }));
}

const localReference=url=>typeof url==='string'&&/^\/media\/[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}\.(?:png|jpe?g|webp)$/i.test(url);
const referenceLimit=7*1024*1024;
async function prepareReferenceFile(file){
  const suffix={ 'image/png':'png','image/jpeg':'jpg','image/webp':'webp' }[file.type];
  must(suffix||/\.(png|jpe?g|webp)$/i.test(file.name),'请选择 PNG、JPEG 或 WebP 图片。');
  let bitmap;
  try{bitmap=await createImageBitmap(file)}catch{throw Error('图片无法解码，请选择可正常打开的图片。')}
  try{
    if(file.size<=referenceLimit){
      return /\.(png|jpe?g|webp)$/i.test(file.name)?file:new File([file],file.name+'.'+suffix,{type:file.type});
    }
    const scale=Math.min(1,2048/Math.max(bitmap.width,bitmap.height));
    const canvas=document.createElement('canvas');
    canvas.width=Math.max(1,Math.round(bitmap.width*scale));canvas.height=Math.max(1,Math.round(bitmap.height*scale));
    canvas.getContext('2d').drawImage(bitmap,0,0,canvas.width,canvas.height);
    const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/webp',.86));
    must(blob&&blob.size<=referenceLimit,'无法缩小参考图，请选择一张较小的图片。');
    return new File([blob],file.name.replace(/\.[^.]+$/,'')+'-参考图.webp',{type:blob.type});
  }finally{bitmap.close()}
}
const imageAsset=a=>a.type==='image' || a.type?.startsWith('image/') || /\.(png|jpe?g|webp|avif)$/i.test(a.name);
const splatAsset=a=>/\.spz$/i.test(a.name);
const formDefaults={hunyuanTo3D:{prompt:'',model:'3.1',textured:true},meshyImageTo3D:{image_url:'',should_texture:true},atlasTextToImage:{prompt:''},images2PosedRGBD:{frames:[],targetResolution:[1280,720]},atlasGenerate:{contextFrames:[],targetCameras:[],returnDepth:true},atlasChisel:{targetFrames:[],prompt:''},posedImages2Splats:{posedFrames:[],refine:false},splats2Mesh:{splatAsset:{assetId:''},textureMode:'image_texture'}};

export function mountWorkflows(container,ctx) {
  container.classList.add('wf-root');
  const top=dom('div','wf-top'), picker=dom('nav','wf-tabs'), pane=dom('section','wf-pane');
  const heading=dom('div','wf-heading'), form=dom('div','wf-form'), feedback=dom('p','wf-feedback'), history=dom('section','wf-history');
  picker.setAttribute('aria-label','选择生成任务');
  feedback.setAttribute('role','status');
  const run=button('提交任务',submit,'wf-btn wf-primary');
  const actions=dom('div','wf-actions'); actions.append(feedback,run);
  top.append(picker); pane.append(heading,form,actions); container.replaceChildren(top,pane,history);
  let projectId=null, task='atlasTextToImage', providers=[], providerError='', loading=null, draft;
  const drafts=new Map(), pending=new Set(), timers=new Map(), polling=new Set(), fileAssets=new WeakMap();
  const expanded=new Set(), recovering=new Set(), loadingReference=new WeakSet();
  function draftFor(p,t){return {...defaults(),...(p.workflowDrafts?.[t]||{})}}
  function saveDraft(d=draft,t=task,pid=projectId){
    if(!d||!pid||!ctx.saveDraft)return;
    const copy=structuredClone(d);
    ctx.saveDraft(pid,t,copy);
  }
  for(const event of ['input','change','click','pointerup'])form.addEventListener(event,()=>queueMicrotask(()=>saveDraft()));

  function current() { return ctx.getProject(); }
  function viewKey(pid=projectId,t=task) { return JSON.stringify([pid,t]); }
  function say(msg,error=false) {
    feedback.textContent=msg; feedback.classList.toggle('wf-error',error);
  }
  function editJob(pid,id,updater) {
    ctx.updateProject(p=>{
      const idx=(p.jobs || []).findIndex(j=>jobKey(j)===id);
      if (idx>=0) p.jobs[idx]=updater(p.jobs[idx]);
    },pid);
    if (current()?.id===pid) renderHistory();
  }
  function addJob(pid,job) {
    ctx.updateProject(p=>{p.jobs ||= [];p.jobs.unshift(job);},pid);
    if (current()?.id===pid) renderHistory();
  }
  function updateRun() {
    const p=providers.find(x=>x.id===draft?.provider);
    const busy=pending.has(viewKey());
    run.disabled=busy || loadingReference.has(draft) || !p?.configured;
    run.textContent=loadingReference.has(draft)?'正在读取参考图…':busy ? '正在准备任务…' : '提交任务';
  }
  function refresh(name) {
    const p=current();
    if (!p) return;
    if (name && Object.hasOwn(tasks,name)) task=name;
    if (p.id!==projectId) { projectId=p.id; if (!name) task=Object.hasOwn(tasks,p.activeTask)?p.activeTask:'atlasTextToImage'; }
    if (!drafts.has(viewKey())) drafts.set(viewKey(),draftFor(p,task));
    draft=drafts.get(viewKey());
    render();if(name)saveDraft();
    for(const job of p.jobs || [])if(['submitting','uncertain'].includes(job.status)&&!job.operationId&&!sending.has(p.id+'/'+job.id))recoverSubmitted(p.id,job);
    for (const j of p.jobs || []) if (j.operationId && !j.pollPaused && !terminal.has(j.status) && asynchronousProviders.has(j.provider)) schedule(p.id,j.id,j.operationId,100);
    if (!loading) loadProviders();
  }
  async function loadProviders() {
    const promise=api('/api/providers');
    loading=promise;
    try { const data=await promise; providers=data.providers || []; providerError=''; }
    catch(e) { providerError=messageOf(e); providers=[]; }
    finally { if (loading===promise) loading=null; if (current()?.id===projectId) renderProviderState(); }
  }
  let stateNode=null,providerSelect=null,modelField=null;
  function renderProviderState() {
    if (!stateNode) return;
    if (providerSelect) for (const option of providerSelect.options) {
      const p=providers.find(o=>o.id===option.value);
      option.textContent=p?.label || option.textContent;
    }
    if (modelField) modelField.placeholder=providers.find(p=>p.id==='images')?.model || '使用服务端配置的模型';
    const provider=providers.find(p=>p.id===draft.provider);
    stateNode.replaceChildren();
    if (loading && !providers.length) stateNode.append('正在读取服务状态…');
    else if (providerError) stateNode.append('服务状态读取失败 · '+providerError,button('重试',loadProviders,'wf-link'));
    else if (!provider?.configured) stateNode.append('未配置 '+(provider?.label || languageServices[draft.provider]?.label || ({meshy:'Meshy',images:'Images',wan:'阿里通义万相',hunyuan:'腾讯混元 3D',atlas:'Atlas'}[draft.provider]))+' 服务。请在顶部「模型服务」中填写凭据。',button('刷新状态',loadProviders,'wf-link'));
    else stateNode.append(dom('span','wf-indicator'), '已连接配置');
    updateRun();
  }
  function choose(t) {
    if (task===t) return;
    saveDraft();task=t;
    if (!drafts.has(viewKey())) drafts.set(viewKey(),draftFor(current(),task));
    draft=drafts.get(viewKey()); render();saveDraft();
  }
  function field(title,node,hint) {
    if(node.matches('input,textarea,select'))node.setAttribute('aria-label',title);
    const label=dom('label','wf-field');label.append(dom('span','wf-label',title),node);
    if (hint) label.append(dom('small','wf-hint',hint));return label;
  }
  function select(items,value,onChange) {
    const s=dom('select','wf-input');
    for (const opt of items) {
      const [val,title,disabled]=Array.isArray(opt) ? opt : [opt,opt,false];
      const el=dom('option',null,title);el.value=val;el.disabled=!!disabled;s.append(el);
    }
    s.value=value ?? '';
    s.onchange=()=>onChange(s.value);return s;
  }
  function options(label,key,list,rerender=false) {
    return field(label,select(list,draft[key],val=>{draft[key]=val;if(rerender)render();}));
  }
  function textField(label,key,placeholder='',kind='text',attributes={}) {
    const el=dom(kind==='textarea'?'textarea':'input','wf-input');
    if(kind!=='textarea') el.type=kind;Object.assign(el,attributes);el.placeholder=placeholder;el.value=draft[key] ?? '';
    el.oninput=()=>{draft[key]=el.value;};return field(label,el);
  }
  function check(label,key) {
    const box=dom('input'), wrap=dom('label','wf-check');box.type='checkbox';box.checked=!!draft[key];
    box.onchange=()=>{draft[key]=box.checked;};wrap.append(box,document.createTextNode(label));return wrap;
  }
  function row(...children){const el=dom('div','wf-row');el.append(...children);return el;}
  function files(title,accept,multiple,onFiles) {
    const el=dom('input','wf-file');el.type='file';el.accept=accept;el.multiple=multiple;
    el.onchange=()=>{const chosen=[...el.files]; if (chosen.length) onFiles(chosen);};
    return field(title,el);
  }
  function render() {
    picker.replaceChildren(...Object.keys(tasks).map(t=>{
      const b=button(tasks[t][0],()=>choose(t),'wf-tab');b.setAttribute('aria-pressed',String(t===task));return b;
    }));
    const title=dom('div');title.append(dom('h3',null,tasks[task][0]),dom('p','wf-hint',tasks[task][1]));
    if(task==='threeModel') {if(!Object.hasOwn(languageServices,draft.provider))draft.provider='deepseek';draft.raw=false;}
    const doc=dom('a','wf-link','接口文档 ↗');doc.href=task==='threeModel'?languageServices[draft.provider].docs:task==='hunyuanTo3D'?'https://cloud.tencent.com/document/product/1804/123447':task==='atlasTextToImage'&&draft.provider==='wan'?'https://help.aliyun.com/zh/model-studio/text-to-image-v2-api-reference':task==='meshyImageTo3D'?'https://docs.meshy.ai/en/api/image-to-3d':'https://docs.atlas.worldlabs.ai/api-reference/'+tasks[task][2];doc.target='_blank';doc.rel='noopener noreferrer';
    heading.replaceChildren(title,doc);form.replaceChildren();providerSelect=null;modelField=null;
    if(task==='threeModel'){
      providerSelect=select(Object.entries(languageServices).map(([id,s])=>[id,s.label]),draft.provider,v=>{draft.provider=v;render()});
      form.append(field('建模大模型',providerSelect));
    } else if (task==='atlasTextToImage') {
      providerSelect=select([['atlas','World Labs Atlas'],['wan','阿里通义万相 2.6'],['images','第三方 Images API']],draft.provider,v=>{draft.provider=v;draft.raw=false;draft.json=null;render();});
      form.append(field('推理服务',providerSelect));
    } else draft.provider=task==='hunyuanTo3D'?'hunyuan':task==='meshyImageTo3D'?'meshy':'atlas';
    stateNode=dom('div','wf-service');
    const bar=dom('div','wf-format');
    const modes=dom('div','wf-switch');
    for (const [raw,label] of [[false,'表单'],[true,'JSON']]) {
      const b=button(label,()=>switchFormat(raw),'wf-mode');b.setAttribute('aria-pressed',String(!!draft.raw===raw));modes.append(b);
    }
    bar.append(stateNode);if(task!=='threeModel')bar.append(modes);form.append(bar);
    if (draft.raw) {
      const raw=textField('请求体 JSON','json','','textarea',{rows:12,spellcheck:false});raw.lastChild.classList.add('wf-code');form.append(raw);
    } else renderFields();
    say('');renderProviderState();renderHistory();
  }
  async function switchFormat(raw) {
    if (!!draft.raw===raw) return;
    const d=draft, t=task, p=current();
    if (raw && !d.json) {
      let body;
      try { body=await prepare(t,{...d},p,true); } catch {
        body=structuredClone(formDefaults[t]);
        if ('prompt' in body) body.prompt=d.prompt || '';
        if(t==='atlasTextToImage' && d.provider==='images') {if(d.model)body.model=d.model;body.n=Number(d.n || 1);}
      }
      d.json=JSON.stringify(body,null,2);
    }
    if (draft!==d || current().id!==p.id) return;
    d.raw=raw;render();
  }
  function projectChoices(project,kind) {
    const assets=(project.assets || []).filter(kind==='image' ? imageAsset : splatAsset)
      .map(a=>({key:'project:'+a.id,label:a.name,local:a}));
    if(kind==='image') return assets.concat(availableFrames(project).map(x=>({key:x.id,label:x.label,asset:x.frame.imageAsset})));
    return assets.concat((project.jobs || []).flatMap(j=>resultAssets(j.response || {}).filter(x=>x.type==='splat').map((x,i)=>({key:j.id+'@splat'+i,label:x.label+' · '+jobTitle(j),asset:x.asset}))));
  }
  function assetPicker(kind) {
    const multi=kind==='image', holder=dom('div','wf-assets');
    const selected=multi ? draft.images : (draft.splatChoice ? [draft.splatChoice]:[]);
    const d=draft,t=task,pid=projectId;
    const add=async items=>{
      try{const chosen=[];for(const a of items){if(a.file && ctx.saveDraft){const local=await ctx.addAsset(a.file,pid);chosen.push({label:a.label,local})}else chosen.push(a)}
        if(multi)d.images.push(...chosen);else d.splatChoice=chosen[0];
        saveDraft(d,t,pid);if(d===draft)render()
      }catch(e){say(messageOf(e),true)}
    };
    const choices=projectChoices(current(),kind);
    const selector=select([['','选择已有素材或生成结果…'],...choices.map(a=>[a.key,a.label])],'',value=>{
      const item=choices.find(a=>a.key===value);if(item)add([item]);
    });
    holder.append(row(field(multi?'项目图像':'已有 SPZ',selector),files(multi?'从文件添加图片':'从文件添加 SPZ',multi?'image/png,image/jpeg,image/webp':'.spz',multi,chosen=>add(chosen.map(file=>({file,label:file.name}))))));
    const manual=dom('details','wf-detail');manual.append(dom('summary',null,'使用 Atlas 资产 ID'));
    const id=dom('input','wf-input');id.placeholder='asset_…';id.setAttribute('aria-label','Atlas 资产 ID');
    manual.append(row(id,button('添加',()=>{
      const value=id.value.trim();
      if(!/^asset_[\w-]+$/.test(value)){say('请输入有效的 asset_ 资产 ID。',true);return;}
      add([{label:value,asset:{assetId:value}}]);
    })));if(!['meshyImageTo3D','hunyuanTo3D'].includes(task))holder.append(manual);
    if(multi) holder.append(button('＋ 使用当前视口截图',async ()=>{
      const d=draft,pid=projectId;
      try {
        const snap=await ctx.getSnapshot();
        must(snap,'没有可用的视口截图。');
        const name='取景-'+Date.now()+'.png';
        if(ctx.saveDraft)d.images.push({label:name,local:await ctx.addAsset({name,url:snap,type:'image'},pid)});
        else d.images.push({label:name,asset:{url:snap}});
        saveDraft(d,t,pid);
        if(draft===d && projectId===pid)render();
      } catch(e) {if(draft===d && projectId===pid)say(messageOf(e),true);}
    },'wf-link'));
    if(selected.length) {
      const list=dom('ol','wf-selected');
      selected.forEach((a,i)=>{
        const li=dom('li');li.append(dom('span',null,(multi ? (i+1)+'. ':'')+a.label));
        if(multi && i>0) li.append(button('上移',()=>{[selected[i-1],selected[i]]=[selected[i],selected[i-1]];render();},'wf-link'));
        li.append(button('移除',()=>{if(multi)selected.splice(i,1);else draft.splatChoice=null;render();},'wf-link'));
        list.append(li);
      });
      holder.append(list);
    }
    return holder;
  }
  function referencePicker(){
    const d=draft,pid=projectId,p=current();
    const group=dom('fieldset','wf-reference'),legend=dom('legend',null,'参考图片（可选）');
    const input=dom('input');input.type='file';input.accept='image/jpeg,image/png,image/webp';input.hidden=true;input.setAttribute('aria-label','上传建模参考图');
    async function chooseImage(file,asset){
      if(loadingReference.has(d))return;
      loadingReference.add(d);updateRun();let error='';
      try{
        if(asset){
          const res=await fetch(asset.url);must(res.ok,'项目参考图读取失败。');
          const blob=await res.blob();file=new File([blob],asset.name,{type:blob.type});
        }
        const ready=await prepareReferenceFile(file);
        const local=asset&&file===ready?asset:await ctx.addAsset(ready,pid);
        must(localReference(local?.url),'参考图未能保存到本机。');
        d.referenceImage={name:local.name,url:local.url};saveDraft(d,'threeModel',pid);
      }catch(e){error=messageOf(e)}
      finally{
        loadingReference.delete(d);
        if(d===draft&&pid===projectId){render();if(error)say(error,true)}
      }
    }
    input.onchange=()=>{if(input.files[0])chooseImage(input.files[0])};
    const currentRef=d.referenceImage;
    const pick=button(currentRef?'更换图片':'选择图片',()=>input.click());
    const line=dom('div','wf-ref-line');
    if(currentRef&&localReference(currentRef.url)){
      const preview=dom('img');preview.src=currentRef.url;preview.alt='建模参考图预览';
      line.append(preview,dom('span','wf-ref-name',currentRef.name),pick,button('移除参考图',()=>{
        if(loadingReference.has(d))return;delete d.referenceImage;saveDraft(d,'threeModel',pid);render();
      },'wf-link'));
    }else line.append(pick,dom('span','wf-hint','或拖入 JPG、PNG、WebP'));
    group.append(legend,input,line);
    const assets=(p.assets||[]).filter(a=>localReference(a.url));
    if(assets.length){
      const menu=select([['','选择项目图片…'],...assets.map(a=>[a.url,a.name])],currentRef?.url||'',url=>{
        const asset=assets.find(a=>a.url===url);if(asset)chooseImage(null,asset);
      });
      group.append(field('从项目素材选择',menu));
    }
    group.ondragover=e=>{e.preventDefault();e.dataTransfer.dropEffect='copy'};
    group.ondrop=e=>{e.preventDefault();e.stopPropagation();if(e.dataTransfer.files.length===1)chooseImage(e.dataTransfer.files[0]);else say('每次请选择一张参考图。',true)};
    return group;
  }
  function frameSelector() {
    const all=availableFrames(current(),true).filter(x=>task!=='posedImages2Splats' || x.frame.depth?.depthAsset);
    const group=dom('fieldset','wf-sources');group.append(dom('legend',null,'参考帧'));
    if(!all.length) group.append(dom('p','wf-hint','先完成图像重建，或生成带深度的视图。'));
    const counter=dom('span','wf-hint');
    const sync=()=>{counter.textContent='已选 '+draft.sources.filter(id=>all.some(f=>f.id===id)).length+' 帧，按勾选顺序提交';};
    if(all.length)group.append(counter);sync();
    for(const f of all) {
      const label=dom('label','wf-check'),box=dom('input');box.type='checkbox';box.checked=draft.sources.includes(f.id);
      box.onchange=()=>{draft.sources=draft.sources.filter(id=>id!==f.id);if(box.checked)draft.sources.push(f.id); sync();};
      label.append(box,document.createTextNode(f.label));group.append(label);
    }
    return group;
  }
  function renderFields() {
    if(task==='threeModel'){
      form.append(referencePicker());
      if(draft.provider==='qwen'&&draft.referenceImage)form.append(field('千问模型',dom('output',null,'Qwen3-VL-Plus · 视觉建模')));
      else if(draft.provider==='qwen')form.append(options('千问模型','qwenModel',[['qwen3-coder-flash','Qwen3-Coder-Flash'],['qwen-plus','Qwen-Plus']]));
      if(draft.provider==='minimax')form.append(options('MiniMax 模型','minimaxModel',['MiniMax-M3.1-Flash','MiniMax-M3']));
      const groups=new Map((current().scene?.objects||[]).filter(o=>o.type==='three'&&o.group).map(o=>[o.group,o.groupName]));
      const choices=[['new','新建模型'],...groups];
      if(draft.targetModel!=='new'&&!groups.has(draft.targetModel))choices.push([draft.targetModel,'原模型已移除，请重新选择']);
      form.append(row(options('建模目标','targetModel',choices),options('建模细节','modelDetail',[['standard','标准 · 主体与比例'],['fine','精细 · 开口与构造']])),
        textField('建模描述','prompt',draft.referenceImage?'可选：指定实际尺寸、材质，或说明希望保留和修改的部分。':'例如：建一座六米宽的双坡木亭，四根柱子，屋脊朝东西。','textarea',{rows:4,maxLength:6000}));
    }
    else if(task==='hunyuanTo3D'){
      form.append(options('输入方式','hunyuanMode',[['text','文字生成模型'],['image','参考图生成模型']],true));
      if(draft.hunyuanMode==='image')form.append(assetPicker('image'),dom('p','wf-hint','选择一张 JPEG、PNG 或 WebP 图片，单边 128–5000 像素。'));
      else form.append(textField('模型描述','prompt','例如：一座带木格栅的庭院展亭','textarea',{rows:3,maxLength:1024}));
      form.append(row(options('模型版本','hunyuanModel',['3.1','3.0']),check('生成纹理','meshTexture')));
    }
    else if(task==='meshyImageTo3D'){form.append(assetPicker('image'),textField('模型（可选）','meshModel','使用服务默认模型'),check('生成纹理','meshTexture'));}
    else if(task==='atlasTextToImage'){
      form.append(textField('场景描述','prompt','描述空间、材质与光线…','textarea',{rows:3}));
      const counts=options('生成数量','n',[1,2,3,4].map(n=>[n,n+' 张']));
      if(draft.provider==='images') {
        const model=textField('模型','model','使用服务端配置的模型');modelField=model.querySelector('input');
        form.append(row(model,options('图像尺寸','size',[['','模型默认'],'1024x1024','1536x1024','1024x1536','1792x1024','1024x1792'])),counts);
      } else if(draft.provider==='wan')form.append(row(options('输出尺寸','wanSize',['1280*1280','1696*960','960*1696','1472*1104','1104*1472'].map(s=>[s,s.replace('*',' × ')])),counts),check('优化提示词','enhance'));
      else form.append(row(options('画幅','ratio',['16:9','9:16','4:3','3:4','1:1']),counts),row(check('优化提示词','enhance'),check('返回相机与深度','returnDepth')));
    } else if(task==='images2PosedRGBD') {
      form.append(assetPicker('image'),row(options('输出尺寸','resolution',[...grids.map(g=>[g,g.replace('x',' × ')]),['','跟随输入']]),check('首帧相机设为原点','canonical')));
    } else if(task==='atlasGenerate') {
      form.append(frameSelector());
      const choices=[['current','工作台当前相机'],['relative','相对参考帧平移'],['path','工作台关键帧路径'],...(current().cameras || []).map(c=>['key:'+c.id,c.name])];
      form.append(options('目标视角','targets',choices,true));
      if(draft.targets==='path') form.append(textField('路径总帧数','count','24','number',{min:2,max:1440,step:1}));
      if(draft.targets==='relative') form.append(textField('向相机右侧平移（米）','offset','0.25','number',{step:0.05}));
      form.append(textField('场景描述（可选）','prompt','描述希望保留的场景外观','textarea',{rows:2}),check('输出深度，供后续重建','returnDepth'));
    } else if(task==='atlasChisel') {
      form.append(options('编辑方式','chisel',[['layout','白模布局 · 当前视口深度'],['restyle','前序视图 · 保留几何，重绘外观'],['mask','局部编辑 · 绘制或上传遮罩'],['camera','仅使用当前相机和描述']],true));
      if(draft.chisel==='restyle' || draft.chisel==='mask'){
        const frames=availableFrames(current()).filter(x=>gridOf(x.frame.camera)==='1280x720' && (draft.chisel==='mask' || x.frame.depth));
        const selector=select([['','选择 1280 × 720 结果帧…'],...frames.map(f=>[f.id,f.label])],draft.chiselFrame,id=>{
          draft.chiselFrame=id;draft.strokes=[];draft.maskFile=null;render();
        });
        form.append(field('目标帧',selector,frames.length ? '' : '请先重建或生成 1280 × 720 的视图。'));
        if(draft.chisel==='mask' && draft.chiselFrame){
          const source=frames.find(f=>f.id===draft.chiselFrame);
          if(source)form.append(maskEditor(source.frame));
        }
      }
      form.append(textField('编辑后的场景','prompt','描述应生成的材质、外观与光线…','textarea',{rows:3}),check('返回深度','returnDepth'));
    } else if(task==='posedImages2Splats'){
      form.append(frameSelector(),check('精细重建（最多 512 帧）','refine'),textField('场景描述（可选）','prompt','描述拍摄的场景','textarea',{rows:2}));
    } else {
      form.append(assetPicker('splat'),options('网格外观','textureMode',[['image_texture','图像纹理'],['vertex_color','顶点颜色'],['none','无纹理']],true));
      if(draft.textureMode==='image_texture')form.append(options('纹理分辨率','textureSize',[2048,4096,8192]));
      form.append(row(textField('目标面数（可选）','faces','保留全部','number',{min:1,step:1}),check('同时生成碰撞盒 GLB','colliders')));
    }
  }
  function drawStroke(context,stroke,color) {
    const [first,...rest]=stroke.points;
    context.lineWidth=stroke.width;context.strokeStyle=color;context.fillStyle=color;
    context.lineJoin='round';context.lineCap='round';
    context.beginPath();context.arc(first[0],first[1],stroke.width/2,0,2*Math.PI);context.fill();
    context.beginPath();context.moveTo(...first);
    for(const p of rest) context.lineTo(...p);
    context.stroke();
  }
  function maskEditor(frame) {
    const d=draft;d.strokes ||= [];
    const editor=dom('div','wf-mask'),stage=dom('div','wf-mask-stage'),canvas=dom('canvas'),img=dom('img');
    img.alt='待编辑的参考图像';canvas.width=1280;canvas.height=720;
    canvas.setAttribute('aria-label','涂画需要重绘的区域，亦可上传黑白遮罩');
    const brush=dom('input','wf-input');brush.type='range';brush.min='4';brush.max='180';brush.value=String(d.brush || 52);
    brush.oninput=()=>{d.brush=+brush.value;};
    resourceUrl(frame.imageAsset).then(url=>{img.src=url;}).catch(e=>{img.alt=messageOf(e);});
    img.onerror=()=>{img.onerror=null;resourceUrl(frame.imageAsset,true).then(url=>{img.src=url;}).catch(()=>{});};
    const g=canvas.getContext('2d');
    function redraw(){g.clearRect(0,0,1280,720);for(const s of d.strokes)drawStroke(g,s,'#f26474');}
    let active=null;
    function pos(e){const r=canvas.getBoundingClientRect();return [(e.clientX-r.left)*1280/r.width,(e.clientY-r.top)*720/r.height];}
    canvas.onpointerdown=e=>{
      if(active || e.button!==0 || d.maskFile)return;
      e.preventDefault();canvas.setPointerCapture(e.pointerId);active={width:+brush.value,points:[pos(e)],pointer:e.pointerId};d.strokes.push(active);redraw();
    };
    canvas.onpointermove=e=>{if(active?.pointer===e.pointerId){active.points.push(pos(e));redraw();}};
    canvas.onlostpointercapture=()=>{active=null;};
    redraw();stage.append(img,canvas);editor.append(dom('p','wf-hint','涂画要重绘的区域。导入的遮罩须为 1280 × 720 PNG，白色保留，黑色重绘。'));
    if(!d.maskFile)editor.append(stage,row(field('画笔大小',brush),button('撤销一笔',()=>{d.strokes.pop();redraw();}),button('清空涂画',()=>{d.strokes=[];redraw();})));
    editor.append(files('导入保留遮罩','image/png',false,async f=>{const pid=projectId,t=task;try{if(ctx.saveDraft)d.maskFile=await ctx.addAsset(f[0],pid);else d.maskFile=f[0];saveDraft(d,t,pid);if(d===draft)render()}catch(e){say(messageOf(e),true)}}));
    if(d.maskFile)editor.append(row(dom('span',null,d.maskFile.name),button('改用画笔',()=>{d.maskFile=null;render();})));
    return editor;
  }
  async function uploadData(dataUrl,name,mime) {
    const comma=dataUrl.indexOf(',');
    must(comma>=0 && dataUrl.slice(0,comma).endsWith(';base64'),'文件编码无效。');
    const r=await api('/api/assets','POST',{fileName:name,mimeType:mime || dataUrl.slice(5,dataUrl.indexOf(';')),base64:dataUrl.slice(comma+1)});
    must(r.assetId,'上传服务未返回资产 ID。');return {assetId:r.assetId};
  }
  async function inputAsset(source,p,inline) {
    if(source.asset?.assetId)return {assetId:source.asset.assetId};
    if(source.local?.assetId || source.local?.atlasAssetId)return {assetId:source.local.assetId || source.local.atlasAssetId};
    const asset=source.asset || {url:source.local?.url};
    if(/^https:\/\//i.test(asset.url))return {url:asset.url};
    if(source.file && !inline && fileAssets.get(source.file))return fileAssets.get(source.file);
    let data=asset.base64 || asset.url;
    if(source.file)data=await fileData(source.file);
    if(typeof data==='string' && !data.startsWith('data:')){
      const url=safeUrl(data);must(url,'素材地址无效。');
      const r=await fetch(url);must(r.ok,'读取项目素材失败。');data=await fileData(await r.blob());
    }
    must(typeof data==='string' && data.startsWith('data:'),'无法读取选中的素材。');
    if(inline)return {base64:data};
    const id=await uploadData(data,source.file?.name || source.local?.name || source.label || 'image.png',source.file?.type);
    if(source.file)fileAssets.set(source.file,id);
    if(source.local)ctx.updateProject(project=>{const a=project.assets.find(a=>a.id===source.local.id);if(a)a.assetId=id.assetId;},p.id);
    return id;
  }
  async function prepare(t,d,p,inline=false) {
    if(t==='threeModel'){
      const prompt=d.prompt?.trim()||'';must(prompt||d.referenceImage,'请填写建模描述或选择参考图。');
      const modelField=languageServices[d.provider].modelField;
      const input={prompt,...(d.modelDetail==='fine'?{modelDetail:'fine'}:{}),...(modelField?{model:d[modelField]}:{})};
      if(d.referenceImage){must(localReference(d.referenceImage.url),'参考图无法读取，请重新选择。');input.referenceImage=d.referenceImage.url;if(d.provider==='qwen')input.model='qwen3-vl-plus';}
      if(d.targetModel==='new')return input;
      const previous=ctx.getModel(p,d.targetModel);must(previous,'原模型已移除，请重新选择建模目标。');
      return {...input,previous};
    }
    if(d.raw){
      let body;
      try{body=JSON.parse(d.json);}catch(e){throw new Error('JSON 格式有误。'+e.message);}
      must(body && typeof body==='object' && !Array.isArray(body),'请求体必须是 JSON 对象。');
      return body;
    }
    const v={...d}, frameMap=new Map(availableFrames(p,true).map(f=>[f.id,f.frame]));
    v.frames=d.sources.map(id=>frameMap.get(id)).filter(Boolean);
    if(t==='hunyuanTo3D' && d.hunyuanMode!=='image'){
      must(d.prompt?.trim(),'请填写模型描述');return {prompt:d.prompt.trim(),model:d.hunyuanModel,textured:d.meshTexture!==false};
    }
    if(t==='meshyImageTo3D' || t==='hunyuanTo3D'){
      must(d.images.length===1,'图生 3D 需要选择一张图片。');
      const src=d.images[0];let url=src.local?.url||src.asset?.url;
      if(!url && src.asset?.assetId)url=await resourceUrl(src.asset,true);
      if(!url || !/^https:\/\//.test(url)){
        const blob=src.file || (url && await (await fetch(url)).blob());const limit=t==='hunyuanTo3D'?6*1024*1024:20_000_000;must(blob && blob.size<=limit,'请选择不超过 '+(t==='hunyuanTo3D'?'6 MiB':'20 MB')+' 的图片');
        url=await new Promise((ok,no)=>{const reader=new FileReader();reader.onload=()=>ok(reader.result);reader.onerror=()=>no(reader.error);reader.readAsDataURL(blob)});
      }
      if(t==='hunyuanTo3D')return {image_url:url,model:d.hunyuanModel,textured:d.meshTexture!==false};
      return {image_url:url,should_texture:d.meshTexture!==false,...(d.meshModel?.trim()?{ai_model:d.meshModel.trim()}:{})}
    }
    if(t==='images2PosedRGBD'){
      v.images=[];
      for(const source of d.images)v.images.push(await inputAsset(source,p,inline));
    }
    if(t==='splats2Mesh'){
      must(d.splatChoice,'请选择 SPZ 文件或生成结果。');v.splat=await inputAsset(d.splatChoice,p,inline);
    }
    if(t==='atlasGenerate'){
      if(d.targets==='path'){
        const n=Number(d.count);must(Number.isInteger(n) && n>=2 && n<=1440,'路径帧数应为 2 至 1440 的整数。');
        must((p.cameras || []).length>=2,'请先在工作台保存至少两个相机关键帧。');
        v.cameras=ctx.getPathCameras(n);
      } else if(d.targets==='relative'){
        must(v.frames[0]?.camera,'请选择参考帧。');
        const cam=structuredClone(v.frames[0].camera), e=cam.extrinsics;
        const delta=Number(d.offset || 0.25);
        must(Number.isFinite(delta),'请输入有效的平移距离。');
        const [x,y,z,w]=e.quaternion;
        const right=[1-2*(y*y+z*z),2*(x*y+z*w),2*(x*z-y*w)];
        e.position=e.position.map((v,i)=>v+right[i]*delta);
        if(!grids.includes(gridOf(cam))) {
          const grid=cam.intrinsics, s=Math.max(1280/grid.width,720/grid.height);
          Object.assign(grid,{fx:grid.fx*s,fy:grid.fy*s,cx:grid.cx*s-(grid.width*s-1280)/2,cy:grid.cy*s-(grid.height*s-720)/2,width:1280,height:720});
        }
        v.cameras=[cam];
      } else {
        const cam=d.targets==='current' ? p.camera : p.cameras.find(c=>'key:'+c.id===d.targets)?.camera;
        must(cam,'未找到目标相机。');v.cameras=[ctx.getAtlasCamera(cam)];
      }
    }
    if(t==='atlasChisel'){
      must(d.prompt.trim(),'请描述编辑后的场景。');
      if(d.chisel==='layout'){
        const s=await ctx.getDepthSnapshot(p.camera);
        must(s?.dataUrl && s.camera,'无法取得当前视口深度。');
        const depth=await inputAsset({asset:{url:s.dataUrl},label:'layout-depth.png'},p,inline);
        v.targets=[{camera:s.camera,depth:{logDepthAsset:depth,zMin:s.zMin,zMax:s.zMax}}];
      } else if(d.chisel==='camera')v.targets=[{camera:ctx.getAtlasCamera(p.camera)}];
      else {
        const target=availableFrames(p).find(f=>f.id===d.chiselFrame)?.frame;
        must(target,'请选择需要编辑的目标帧。');
        if(d.chisel==='restyle')v.targets=[{camera:target.camera,depth:target.depth}];
        else {
          must(d.maskFile || d.strokes?.length,'请先绘制要重绘的区域，或选择 PNG 遮罩。');
          let mask;
          if(d.maskFile){
            const file=d.maskFile.url?await (await fetch(d.maskFile.url)).blob():d.maskFile;
            const bitmap=await createImageBitmap(file);
            const valid=bitmap.width===1280 && bitmap.height===720;bitmap.close();
            must(valid,'遮罩尺寸须为 1280 × 720。');
            mask=await inputAsset(d.maskFile.url?{local:d.maskFile}:{file:d.maskFile},p,inline);
          } else {
            const canvas=dom('canvas');canvas.width=1280;canvas.height=720;
            const g=canvas.getContext('2d');g.fillStyle='white';g.fillRect(0,0,1280,720);
            for (const s of d.strokes)drawStroke(g,s,'black');
            mask=await inputAsset({asset:{url:canvas.toDataURL('image/png')},label:'keep-mask.png'},p,inline);
          }
          v.targets=[{camera:target.camera,imageAsset:target.imageAsset,maskAsset:mask}];
        }
      }
    }
    return buildTaskInput(t,v);
  }
  const sending=new Set(),saving=new Set(),backoff=new Map(),pages=new Map();
  async function submit() {
    const p=current(), t=task, key=viewKey();
    const d={...draft, images:[...draft.images],sources:[...draft.sources],strokes:structuredClone(draft.strokes || [])};
    if(pending.has(key)||loadingReference.has(draft))return;
    if(!providers.find(env=>env.id===d.provider)?.configured){say('请先连接推理服务。',true);return;}
    pending.add(key);updateRun();say('正在准备输入…');
    try {
      const input=await prepare(t,d,p);
      const id=crypto.randomUUID(),job={id,requestId:id, task:t,provider:d.provider,input,status:'submitting',createdAt:new Date().toISOString()};
      if(t==='threeModel'){job.prompt=input.prompt;job.modelDetail=d.modelDetail;if(d.referenceImage)job.referenceImage={...d.referenceImage};if(input.previous){job.modelGroup=d.targetModel;job.modelBase=input.previous;}}
      expanded.add(id);addJob(p.id,job);
      await ctx.flushProject?.(p.id);await dispatch(p.id,job);
    } catch(e){if(viewKey()===key)say(messageOf(e),true);}
    finally {pending.delete(key);updateRun();}
  }
  async function recoverSubmitted(pid,job){
    const key=pid+'/'+job.id;if(!ctx.flushProject||!job.requestId||recovering.has(key))return;
    recovering.add(key);
    try{
      const saved=await api('/api/receipts/'+encodeURIComponent(job.requestId));
      if(saved.state==='received' && saved.operation){await dispatch(pid,job,saved.operation);return}
      if(saved.state==='failed'){editJob(pid,job.id,j=>({...j,status:'failed',error:saved.error}));return}
      if(saved.state==='inFlight'){setTimeout(()=>recoverSubmitted(pid,job),3500);return}
      editJob(pid,job.id,j=>({...j,status:'uncertain',note:'本地服务在等待远端回复时中断。请核对原任务。'}))
    }catch(e){if(e.status===404){editJob(pid,job.id,j=>({...j,status:'uncertain',note:'本机尚无提交回执，可用原请求编号继续。'}))}else if(current()?.id===pid)say(messageOf(e),true)}
    finally{recovering.delete(key)}
  }
  async function dispatch(pid,job,receipt) {
    const key=pid+'/'+job.id;if(sending.has(key))return;
    sending.add(key);
    try {
      const op=receipt || await api('/api/tasks','POST',{provider:job.provider,task:job.task,input:job.input,requestId:job.requestId});
      let note='';
      if(job.provider==='images' && op.done && !op.error) {
        for(const [i,f] of (op.response?.frames || []).entries()){
          if(!f.imageAsset?.url?.startsWith('data:'))continue;
          try{
            const extension=extensionOf(f.imageAsset,'png');
            const asset=await ctx.addAsset({name:'生成图像-'+job.id.slice(0,8)+'-'+(i+1)+'.'+extension,type:'image',url:f.imageAsset.url},pid);
            if(asset?.url) f.imageAsset={url:asset.url,projectAssetId:asset.id};
          }catch(e){note='素材保存失败，结果已保留在任务中。'+messageOf(e);}
        }
      }
      editJob(pid,job.id,j=>({...mergeOperation(j,op),note}));
      if(job.task==='threeModel' && op.done && !op.error && current()?.id===pid){
        try{
          const group=ctx.installModel(pid,job.id);
          if(group&&task==='threeModel'&&draft.prompt.trim()===job.prompt&&draft.referenceImage?.url===job.referenceImage?.url&&draft.targetModel===(job.modelGroup||'new')){
            draft.targetModel=group;draft.prompt='';saveDraft();
          }
        }
        catch(e){editJob(pid,job.id,j=>({...j,note:messageOf(e)}));}
        if(current()?.id===pid && task==='threeModel')render();
      }
      if(!op.done && asynchronousProviders.has(job.provider))schedule(pid,job.id,op.id);
      if(current().id===pid && task===job.task){say(op.done ? (op.error ? messageOf(op.error):'生成完成，可在任务记录中查看结果。'):'已提交，正在等待服务返回结果。',!!op.error); if(op.done) renderHistory();}
    } catch(e){
      const ambiguous=!e.status || e.status>=500 || e.status===408 || e.status===409;
      editJob(pid,job.id,j=>({...j,status:ambiguous?'uncertain':'failed',error:messageOf(e)}));
      if(current().id===pid && task===job.task)say(messageOf(e),true);
    } finally {sending.delete(key);if(current().id===pid)renderHistory();}
  }
  function schedule(pid,id,operationId,delay=3500){
    const key=pid+'/'+id;if(timers.has(key) || polling.has(key))return;
    timers.set(key,setTimeout(()=>{timers.delete(key);poll(pid,id,operationId);},delay));
  }
  function stopTimer(pid,id){const k=pid+'/'+id;clearTimeout(timers.get(k));timers.delete(k);}
  async function poll(pid,id,operationId) {
    const key=pid+'/'+id;if(polling.has(key))return;
    stopTimer(pid,id);polling.add(key);let next=0;
    try{
      const op=await api('/api/operations/'+encodeURIComponent(operationId));
      let done=op.done;
      editJob(pid,id,j=>{const updated=mergeOperation(j,op);done=terminal.has(updated.status);return updated;});
      backoff.delete(key);
      if(!done)next=4000;
    } catch(e) {
      const retry=e.status!==404 && e.status!==401 && e.status!==403;
      let active=true;
      editJob(pid,id,j=>{active=!terminal.has(j.status);return active ? {...j,pollError:messageOf(e),pollPaused:!retry} : j;});
      if(active && retry){next=Math.min(60000,(backoff.get(key)||3000)*2);backoff.set(key,next);}
    } finally {polling.delete(key);if(next)schedule(pid,id,operationId,next);}
  }
  async function cancel(pid,job) {
    stopTimer(pid,job.id);editJob(pid,job.id,j=>terminal.has(j.status) ? j : {...j,status:'cancelling'});
    try{
      const op=await api('/api/operations/'+encodeURIComponent(job.operationId),'DELETE');
      editJob(pid,job.id,j=>mergeOperation(j,op));
      if(!op.done)schedule(pid,job.id,job.operationId,1000);
    }catch(e){
      editJob(pid,job.id,j=>terminal.has(j.status) ? j : {...j,status:'running',pollError:'取消请求失败。'+messageOf(e)});
      schedule(pid,job.id,job.operationId);
    }
  }
  function extensionOf(asset,fallback) {
    const mime=/^data:image\/(png|jpeg|webp|gif|avif);/i.exec(asset.url || asset.base64 || '')?.[1];
    if(mime)return mime==='jpeg' ? 'jpg' : mime;
    if(fallback==='png')return /\.(png|jpg|jpeg|webp|avif|gif)(?:$|[?#])/i.exec(asset.url || '')?.[1] || fallback;
    return fallback;
  }
  function assetName(job,x) {
    return jobTitle(job)+'-'+job.id.slice(0,8)+'-'+x.label.replaceAll(' · ','-').replaceAll(' ','')+'.'+extensionOf(x.asset,x.ext);
  }
  function download(url,name) {
    const a=dom('a');a.href=url;a.download=name;a.rel='noopener noreferrer';a.target='_blank';
    document.body.append(a);a.click();a.remove();
  }
  async function downloadAsset(x,name) {
    const url=await resourceUrl(x.asset,true);
    try{
      const r=await fetch(url);must(r.ok,'无法下载资产。');
      const obj=URL.createObjectURL(await r.blob());download(obj,name);setTimeout(()=>URL.revokeObjectURL(obj),60000);
    }catch{download(url,name);}
  }
  async function saveOutput(pid,job,x) {
    const name=assetName(job,x), id=x.asset.projectAssetId || job.savedAssets?.[name];
    if(id && (current().id!==pid || current().assets.some(a=>a.id===id)))return;
    const key=pid+'/'+job.id+'/'+name;
    if(saving.has(key))return;
    saving.add(key);
    try{
      const url=await resourceUrl(x.asset,true);
      const added=await ctx.addAsset({name,type:x.type,url,assetId:x.asset.assetId},pid);
      if(added?.id){
        editJob(pid,job.id,j=>({...j,savedAssets:{...(j.savedAssets || {}),[name]:added.id}}));
      }
    }finally{saving.delete(key);}
  }
  function action(label,work,pid) {
    const b=button(label,async()=>{
      b.disabled=true;
      try{await work();}
      catch(e){if(current().id===pid)ctx.notify(messageOf(e));}
      finally{b.disabled=false;}
    },'wf-link');return b;
  }
  function showOutputs(job,body,pid) {
    const response=job.response || {}, assets=resultAssets(response), limit=pages.get(job.id)||12;
    const controls=dom('div','wf-output-actions');
    controls.append(action('下载结果 JSON',()=>{
      const url=URL.createObjectURL(new Blob([JSON.stringify(response,null,2)],{type:'application/json'}));download(url,job.id+'-result.json');setTimeout(()=>URL.revokeObjectURL(url),60000);
    },pid));
    if(response.threeModel){
      const model=response.threeModel;
      body.append(dom('strong',null,model.name+' · '+model.parts.length+' 个构件'),dom('p','wf-hint',(response.model||'')+(job.modelDetail==='fine'?' · 精细建模':'')+(job.prompt?' · '+job.prompt:'')));
      if(job.referenceImage)body.append(dom('p','wf-hint','参考图 · '+job.referenceImage.name));
      if(!job.modelApplied)controls.prepend(action(job.modelConflict?'作为新模型加入':'加入场景',()=>{
        ctx.installModel(pid,job.id,!!job.modelConflict);render();
      },pid));
      else controls.prepend(action('回到场景',()=>ctx.showScene(),pid));
      controls.append(action('下载 Three.js 模型',()=>ctx.downloadModel(model),pid));
      body.append(controls);return;
    }
    if(ctx.showPointCloud && response.frames?.some(f=>f.camera && f.depth && f.imageAsset))controls.append(action('打开重建点云取景',()=>ctx.showPointCloud(response.frames),pid));
    const sequence=assets.filter(a=>a.label.endsWith(' · 图像'));
    if(sequence.length>1)controls.append(action('保存全部 '+sequence.length+' 帧到项目',async()=>{
      for(const a of sequence)await saveOutput(pid,job,a);
      if(current().id===pid)ctx.notify('已保存 '+sequence.length+' 张序列帧。');
    },pid));
    if(assets.length)body.append(controls);
    else {body.append(dom('p','wf-hint','该任务未返回可预览的资产。'),controls);return;}
    const list=dom('div','wf-outputs');
    for(const x of assets.slice(0,limit)){
      const card=dom('div','wf-result');
      if(x.type==='image'){
        const image=dom('img');image.alt=x.label;image.loading='lazy';image.decoding='async';
        const fallback=()=>{image.onerror=null;resourceUrl(x.asset,true).then(url=>{image.src=url;}).catch(()=>{image.alt=x.label+' · 预览不可用';});};
        image.onerror=fallback;const url=safeUrl(x.asset.url || x.asset.base64);if(url)image.src=url;else fallback();
        card.append(image);
      }else card.append(dom('div','wf-filetype',x.ext.toUpperCase()));
      card.append(dom('strong',null,x.label));
      const bar=dom('div','wf-card-actions');
      bar.append(action('下载',()=>downloadAsset(x,assetName(job,x)),pid));
      const saved=x.asset.projectAssetId || job.savedAssets?.[assetName(job,x)];
      if(saved && current().assets.some(a=>a.id===saved))bar.append(dom('small','wf-hint','已在项目中'));
      else bar.append(action('存入项目',async()=>{await saveOutput(pid,job,x);if(current().id===pid)ctx.notify('已添加到项目素材。');},pid));
      card.append(bar);list.append(card);
    }
    body.append(list);
    if(assets.length>limit)body.append(button('再显示 '+Math.min(12,assets.length-limit)+' 项',()=>{pages.set(job.id,limit+12);renderHistory();}));
  }
  function renderHistory(){
    const p=current();if(!p || p.id!==projectId)return;
    const jobs=p.jobs || [], h=dom('div','wf-hist-title');
    h.append(dom('h3',null,'任务记录'),dom('span','wf-count',jobs.length));history.replaceChildren(h);
    if(!jobs.length)history.append(dom('p','wf-empty','该项目还没有生成任务。'));
    for(const j of jobs){
      const box=dom('details','wf-job');box.open=expanded.has(j.id);
      const summary=dom('summary');summary.append(dom('span','wf-job-title',jobTitle(j)+(j.provider==='wan'?' · 通义万相':'')),dom('time',null,new Date(j.createdAt).toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'})),dom('span','wf-status wf-status-'+j.status,stateNames[j.status] || j.status));
      const body=dom('div','wf-job-body');
      box.append(summary,body);history.append(box);
      function fill(){
        body.replaceChildren();
        body.append(dom('code','wf-id',j.operationId || j.requestId || j.id));
        if(j.error || j.pollError)body.append(dom('p','wf-error',j.error || j.pollError));
        if(j.note)body.append(dom('p','wf-hint',j.note));
        if(j.metadata?.state)body.append(dom('small','wf-hint','服务状态 · '+j.metadata.state));
        if(j.status==='succeeded')showOutputs(j,body,p.id);
        if(asynchronousProviders.has(j.provider) && !terminal.has(j.status)){
          const bar=dom('div','wf-output-actions');
          if(j.operationId){
            bar.append(action('立即查询',()=>poll(p.id,j.id,j.operationId),p.id));
            if(j.provider==='atlas' && j.status!=='cancelling')bar.append(action('请求取消任务',()=>cancel(p.id,j),p.id));
          } else if(j.input && !sending.has(p.id+'/'+j.id))bar.append(action('用原请求 ID 恢复提交',()=>dispatch(p.id,j),p.id));
          body.append(bar);
        } else if((j.provider==='images'||Object.hasOwn(languageServices,j.provider)) && !j.operationId && !terminal.has(j.status) && !sending.has(p.id+'/'+j.id)){
          body.append(dom('p','wf-hint','可从本地提交回执恢复结果。若远端状态未知，请核对服务商记录。'));if(j.input)body.append(action('恢复原请求',()=>dispatch(p.id,j),p.id));
        }
      }
      if(box.open)fill();
      box.ontoggle=()=>{
        if(!box.isConnected)return;
        if(box.open){expanded.add(j.id);if(!body.childElementCount)fill();}
        else expanded.delete(j.id);
      };
    }
  }
  refresh();
  return {refresh};
}
