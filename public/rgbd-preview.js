import {FloatType, Matrix4, PerspectiveCamera, Quaternion, RedFormat, Vector3} from 'three'
import {OrbitControls} from 'three/addons/controls/OrbitControls.js'
import {EXRLoader} from 'three/addons/loaders/EXRLoader.js'
import {unzlibSync} from 'three/addons/libs/fflate.module.js'
import {fov, radians} from './viewport-geometry.js'

const maxFrames = 16
const pointBudget = 320000
const containsFinite = (a,n) => Array.isArray(a) && a.length===n && a.every(Number.isFinite)
const bitmapLimit = 16777216

function validGrid(w,h) {
  if (!Number.isInteger(w) || !Number.isInteger(h) || w<1 || h<1 || w*h>bitmapLimit) {
    throw new Error('图像分辨率超出预览范围。')
  }
}
function validatedCamera(camera) {
  const k=camera?.intrinsics, e=camera?.extrinsics
  if (!k || !(k.fx>0 && k.fy>0) || ![k.fx,k.fy,k.cx,k.cy].every(Number.isFinite) ||
      !containsFinite(e?.position,3) || !containsFinite(e?.quaternion,4) ||
      Math.hypot(...e.quaternion)<1e-8 || !['rdf','rub'].includes(e.coordinateSystem)) {
    throw new Error('帧缺少有效相机内参或位姿。')
  }
  validGrid(k.width,k.height)
  return camera
}

function paeth(a,b,c) {
  const p=a+b-c, da=Math.abs(p-a), db=Math.abs(p-b), dc=Math.abs(p-c)
  return da<=db && da<=dc ? a : db<=dc ? b : c
}
// Keep all 16 bits of log depth; drawing a PNG in an HTML canvas truncates it.
export function decodeLogPNG(buffer,zMin,zMax) {
  if (!(Number.isFinite(zMin) && Number.isFinite(zMax) && zMin>0 && zMax>=zMin)) throw new Error('对数深度范围无效。')
  const view=new DataView(buffer), bytes=new Uint8Array(buffer)
  if (view.byteLength<33 || view.getUint32(0)!==0x89504e47 || view.getUint32(4)!==0x0d0a1a0a) throw new Error('对数深度文件不是 PNG。')
  const width=view.getUint32(16),height=view.getUint32(20),bits=bytes[24],type=bytes[25],interlaced=bytes[28]
  validGrid(width,height)
  const channels=({0:1,2:3,4:2,6:4})[type]
  if (![8,16].includes(bits) || !channels || interlaced>1) throw new Error('需要 8 或 16 位灰度深度 PNG。')
  const chunks=[]
  for (let i=8;i+12<=bytes.length;) {
    const size=view.getUint32(i)
    if (i+size+12>bytes.length) throw new Error('PNG 数据不完整。')
    if (view.getUint32(i+4)===0x49444154) chunks.push(bytes.subarray(i+8,i+8+size))
    i+=size+12
  }
  const compressed=new Uint8Array(chunks.reduce((n,c)=>n+c.length,0))
  let cursor=0
  for (const c of chunks) {compressed.set(c,cursor);cursor+=c.length}
  const stride=channels*bits/8, white=bits===8 ? 255 : 65535
  const passes=interlaced ? [[0,0,8,8],[4,0,8,8],[0,4,4,8],[2,0,4,4],[0,2,2,4],[1,0,2,2],[0,1,1,2]] : [[0,0,1,1]]
  const shapes=passes.map(([x,y,dx,dy])=>({x,y,dx,dy,w:Math.max(0,Math.ceil((width-x)/dx)),h:Math.max(0,Math.ceil((height-y)/dy))})).filter(p=>p.w && p.h)
  const size=shapes.reduce((n,p)=>n+p.h*(p.w*stride+1),0)
  const decoded=unzlibSync(compressed,{out:new Uint8Array(size)})
  if (decoded.length!==size) throw new Error('PNG 扫描行长度不匹配。')
  const samples=bits===8 ? new Uint8Array(width*height) : new Uint16Array(width*height)
  cursor=0
  for (const p of shapes) {
    const bytesPerRow=p.w*stride
    let previous=new Uint8Array(bytesPerRow), row=new Uint8Array(bytesPerRow)
    for (let y=0;y<p.h;y++) {
      const filter=decoded[cursor++]
      if (filter>4) throw new Error('PNG 过滤器无效。')
      for (let j=0;j<bytesPerRow;j++) {
        const a=j>=stride ? row[j-stride] : 0,b=previous[j],c=j>=stride ? previous[j-stride] : 0
        const predictor=[0,a,b,(a+b)>>1,paeth(a,b,c)][filter]
        row[j]=decoded[cursor++]+predictor
      }
      for (let x=0;x<p.w;x++) {
        const j=x*stride
        samples[(p.y+y*p.dy)*width+p.x+x*p.dx]=bits===8 ? row[j] : row[j]*256+row[j+1]
      }
      ;[row,previous]=[previous,row]
    }
  }
  const ratio=zMax/zMin
  return {width,height,at:(x,y)=>{
    const p=samples[y*width+x]
    return p ? zMin*ratio**(1-p/white) : 0
  }}
}

export function linearEXR(buffer) {
  const {width,height,data}=new EXRLoader().setDataType(FloatType).setOutputFormat(RedFormat).parse(buffer)
  validGrid(width,height)
  return {width,height,at:(x,y)=>data[(height-1-y)*width+x]}
}

function safeAssetURL(value) {
  if (typeof value!=='string' || !value) throw new Error('素材没有可读取的网址。')
  if (/^data:(image\/[\w.+-]+|application\/octet-stream);base64,/i.test(value)) return value
  const url=new URL(value,location.origin)
  if (url.protocol==='https:' || (url.origin===location.origin && url.protocol==='http:')) return url.href
  throw new Error('素材地址无效。')
}
async function readAsset(asset,signal) {
  if (!asset) throw new Error('RGBD 帧缺少素材。')
  async function retrieve(url) {
    const result=await fetch(safeAssetURL(url),{signal,credentials:'same-origin'})
    if (!result.ok) throw new Error('素材读取失败（HTTP '+result.status+'）。')
    return result.blob()
  }
  if (asset.base64 || asset.url) {
    try { return await retrieve(asset.base64 || asset.url) }
    catch(error) { if (!asset.assetId || signal.aborted) throw error }
  }
  const id=String(asset.assetId || '').replace(/^assets\//,'')
  if (!id) throw new Error('素材没有可读取的网址或资产编号。')
  const result=await fetch('/api/assets/'+encodeURIComponent(id)+'/url',{signal})
  if (!result.ok) throw new Error('无法获取素材下载地址（HTTP '+result.status+'）。')
  return retrieve((await result.json()).url)
}

async function readPixels(asset,signal,width,height,cover) {
  const bitmap=await createImageBitmap(await readAsset(asset,signal))
  try {
    signal.throwIfAborted()
    if (!cover && (bitmap.width!==width || bitmap.height!==height)) throw new Error('遮罩的分辨率与相机不一致。')
    const canvas=document.createElement('canvas')
    canvas.width=width; canvas.height=height
    const ctx=canvas.getContext('2d',{willReadFrequently:true})
    // images2PosedRGBD cover-resizes and centre-crops the source onto its grid.
    const s=Math.max(width/bitmap.width,height/bitmap.height),w=width/s,h=height/s
    ctx.drawImage(bitmap,(bitmap.width-w)/2,(bitmap.height-h)/2,w,h,0,0,width,height)
    return ctx.getImageData(0,0,width,height).data
  } finally {bitmap.close()}
}

export function sampleFrame(camera,depth,rgb,masks=[],budget=pointBudget) {
  validatedCamera(camera)
  const k=camera.intrinsics,e=camera.extrinsics
  if (depth.width!==k.width || depth.height!==k.height || rgb.length!==4*k.width*k.height) throw new Error('相机、色彩或深度图的尺寸不一致。')
  const q=new Quaternion(...e.quaternion).normalize(),p=new Vector3(...e.position)
  const sign=e.coordinateSystem==='rub' ? -1 : 1
  const vector=new Vector3(),pos=[],color=[],zSamples=[]
  const step=Math.max(1,Math.ceil(Math.sqrt(k.width*k.height/budget)))
  const offset=Math.floor(step/2)
  for (let y=Math.min(offset,k.height-1);y<k.height;y+=step) {
    for (let x=Math.min(offset,k.width-1);x<k.width;x+=step) {
      const i=(y*k.width+x)*4,z=depth.at(x,y)
      if (!(z>0 && Number.isFinite(z)) || !rgb[i+3] || masks.some(m=>m.data[i]<=m.min || !m.data[i+3])) continue
      vector.set((x+.5-k.cx)*z/k.fx,sign*(y+.5-k.cy)*z/k.fy,sign*z).applyQuaternion(q).add(p)
      pos.push(vector.x,vector.y,vector.z);color.push(rgb[i],rgb[i+1],rgb[i+2])
      if (zSamples.length<4096 || (pos.length/3)%32===0) zSamples.push(z)
    }
  }
  zSamples.sort((a,b)=>a-b)
  return {positions:new Float32Array(pos),colors:new Uint8Array(color),medianDepth:zSamples[Math.floor(zSamples.length/2)] || 1}
}

async function loadFrame(frame,signal,budget) {
  const camera=validatedCamera(frame.camera),k=camera.intrinsics,d=frame.depth
  if (!d?.depthAsset && !d?.logDepthAsset) throw new Error('当前帧没有深度。')
  const masks=[[frame.maskAsset,127],[d.maskAsset,127],[d.confidenceAsset,0]].filter(([asset])=>asset)
  const [rgb,buffer,...planes]=await Promise.all([
    readPixels(frame.imageAsset,signal,k.width,k.height,true),
    readAsset(d.depthAsset || d.logDepthAsset,signal).then(blob=>blob.arrayBuffer()),
    ...masks.map(([asset])=>readPixels(asset,signal,k.width,k.height,false))
  ])
  signal.throwIfAborted()
  const dep=d.depthAsset ? linearEXR(buffer) : decodeLogPNG(buffer,d.zMin,d.zMax)
  return sampleFrame(camera,dep,rgb,planes.map((data,i)=>({data,min:masks[i][1]})),budget)
}

export function cameraToOrbit(position,target) {
  const delta=position.clone().sub(target),distance=delta.length()
  return {yaw:Math.atan2(delta.x,delta.z)/radians,pitch:Math.asin(Math.max(-1,Math.min(1,delta.y/(distance||1))))/radians,
    distance,target:target.toArray()}
}

export async function mountRGBDPreview(host,frames,{onCamera}={}) {
  const controller=new AbortController(),signal=controller.signal
  const root=document.createElement('div'),canvas=document.createElement('canvas'),bar=document.createElement('div')
  root.style.cssText='width:100%;height:100%;min-height:260px;display:grid;grid-template-rows:minmax(180px,1fr) auto;background:#212725'
  canvas.style.cssText='width:100%;height:100%;min-height:0;display:block;touch-action:none'
  canvas.setAttribute('aria-label','RGBD 点云，拖动旋转，右键平移，滚轮缩放')
  bar.style.cssText='display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:8px 12px'
  const status=document.createElement('span'),use=document.createElement('button')
  status.style.cssText='font-size:12px;color:#b8c9c1;flex:1'
  status.setAttribute('role','status');use.className='primary';use.textContent='采用此机位';use.disabled=true
  bar.append(status,use);root.append(canvas,bar);host.append(root)
  const ctx=canvas.getContext('2d',{alpha:false}),camera=new PerspectiveCamera(fov/radians,16/9,.001,1e6)
  const controls=new OrbitControls(camera,canvas),clouds=[],clip=new Matrix4()
  let pending=0,image,zBuffer,first=null
  function destroy() {
    if (signal.aborted) return
    controller.abort(); observer.disconnect(); controls.dispose();cancelAnimationFrame(pending)
    clouds.length=0;image=null;zBuffer=null;root.remove()
  }
  const observer=new ResizeObserver(schedule)
  function render() {
    pending=0
    if (signal.aborted) return
    const width=Math.max(16,Math.round(canvas.clientWidth)),height=Math.max(16,Math.round(canvas.clientHeight))
    if (!image || image.width!==width || image.height!==height) {
      canvas.width=width;canvas.height=height;image=ctx.createImageData(width,height);zBuffer=new Float32Array(width*height)
    }
    // Preserve the adopted 16:9 Atlas framing regardless of the dialog shape.
    const W=Math.min(width,height*16/9),H=W*9/16,L=(width-W)/2,T=(height-H)/2
    const packed=new Uint32Array(image.data.buffer)
    packed.fill(0xff1c201d);zBuffer.fill(Infinity)
    for (let y=Math.ceil(T);y<T+H;y++) packed.fill(0xff282d29,y*width+Math.ceil(L),y*width+Math.floor(L+W))
    camera.updateMatrixWorld()
    const m=clip.multiplyMatrices(camera.projectionMatrix,camera.matrixWorldInverse).elements
    for (const {positions,colors} of clouds) for (let i=0;i<positions.length;i+=3) {
      const x=positions[i],y=positions[i+1],z=positions[i+2]
      const depth=m[3]*x+m[7]*y+m[11]*z+m[15]
      if (depth<=camera.near) continue
      const u=(m[0]*x+m[4]*y+m[8]*z+m[12])/depth,v=(m[1]*x+m[5]*y+m[9]*z+m[13])/depth
      if (Math.abs(u)>1 || Math.abs(v)>1) continue
      const sx=Math.floor((u+1)*W/2+L), sy=Math.floor((1-v)*H/2+T)
      const rgb=0xff000000 | colors[i+2]<<16 | colors[i+1]<<8 | colors[i]
      for (let yy=sy;yy<Math.min(sy+2,T+H,height);yy++) for (let xx=sx;xx<Math.min(sx+2,L+W,width);xx++) {
        const idx=yy*width+xx
        if (depth<zBuffer[idx]) {zBuffer[idx]=depth;packed[idx]=rgb}
      }
    }
    ctx.putImageData(image,0,0)
  }
  function schedule() {if (!pending && !signal.aborted) pending=requestAnimationFrame(render)}
  controls.addEventListener('change',schedule);observer.observe(canvas)
  host.closest('dialog')?.addEventListener('close',destroy,{once:true,signal})
  use.addEventListener('click',()=>onCamera?.(cameraToOrbit(camera.position,controls.target)),{signal})
  let count=0,errors=[]
  try {
    const usable=(frames || []).filter(f=>f?.imageAsset && f?.camera && (f.depth?.depthAsset || f.depth?.logDepthAsset))
    if (!usable.length) throw new Error('结果中没有同时包含照片、相机和深度的帧。')
    const n=Math.min(maxFrames,usable.length)
    const chosen=Array.from({length:n},(_,i)=>usable[Math.round(i*(usable.length-1)/Math.max(1,n-1))])
    for (const [i,frame] of chosen.entries()) {
      status.textContent='读取 RGBD 帧 '+(i+1)+' / '+n
      try {
        const cloud=await loadFrame(frame,signal,Math.floor(pointBudget/n))
        signal.throwIfAborted()
        if (!cloud.positions.length) throw new Error('深度没有有效采样点。')
        clouds.push(cloud);count+=cloud.positions.length/3
        if (!first) {
          first=frame
          const e=first.camera.extrinsics
          const forward=new Vector3(0,0,e.coordinateSystem==='rub' ? -1 : 1).applyQuaternion(new Quaternion(...e.quaternion).normalize())
          camera.position.fromArray(e.position)
          controls.target.copy(camera.position).addScaledVector(forward,cloud.medianDepth)
          controls.minDistance=.12;controls.maxDistance=20000
          controls.minPolarAngle=.0018;controls.maxPolarAngle=Math.PI-.0018
          controls.update()
        }
        schedule()
      } catch(error) {if (signal.aborted) return {destroy};errors.push('第 '+(i+1)+' 帧：'+error.message)}
    }
    if (!count) throw new Error(errors[0] || '结果没有可见点。')
    status.textContent=clouds.length+' / '+usable.length+' 帧 · '+count.toLocaleString()+' 个点'+(errors.length?' · '+errors[0]:'')
    use.disabled=false
  } catch(error) {
    if (!signal.aborted) status.textContent='点云预览失败。'+error.message
  }
  return {destroy}
}
