import {cameraFrame, clamp, fov, defaultScene, initialCamera, meshScene, meshToOBJ, normalizeCamera, orbitToAtlasCamera} from './viewport-geometry.js'
import {buildLight, rasterScene, renderView} from './viewport-renderer.js'
export {defaultScene, orbitToAtlasCamera}

const crcTable = Uint32Array.from({length:256},(_,i)=>{
  let v=i
  for (let bit=0;bit<8;bit++) v=(v>>>1)^((v&1)?0xedb88320:0)
  return v>>>0
})

function pngChunk(type,bytes) {
  const result=new Uint8Array(bytes.length+12)
  const view=new DataView(result.buffer)
  view.setUint32(0,bytes.length)
  result.set(new TextEncoder().encode(type),4)
  result.set(bytes,8)
  let crc=0xffffffff
  for (let i=4;i<result.length-4;i++) crc=(crc>>>8)^crcTable[(crc^result[i])&255]
  view.setUint32(result.length-4,(crc^0xffffffff)>>>0)
  return result
}

async function grayscalePNG(width,height,scanlines) {
  const header=new Uint8Array(13), view=new DataView(header.buffer)
  view.setUint32(0,width); view.setUint32(4,height); header[8]=8
  const source=new Blob([scanlines]).stream().pipeThrough(new CompressionStream('deflate'))
  const compressed=new Uint8Array(await new Response(source).arrayBuffer())
  const blob=new Blob([Uint8Array.of(137,80,78,71,13,10,26,10),pngChunk('IHDR',header),
    pngChunk('IDAT',compressed),pngChunk('IEND',new Uint8Array())],{type:'image/png'})
  const bytes=new Uint8Array(await blob.arrayBuffer())
  let binary=''
  for (let i=0;i<bytes.length;i+=16384) binary+=String.fromCharCode(...bytes.subarray(i,i+16384))
  return 'data:image/png;base64,'+btoa(binary)
}

// Atlas log-depth PNG: grayscale 0 means no surface. Valid pixels encode
// metres along the optical axis (Z), with 255 at zMin and at least 1 at zMax.
async function depthCapture(meshes,camera,width,height) {
  const {depth}=rasterScene(meshes,camera,width,height)
  let nearInv=0,farInv=Infinity
  for (const v of depth) if (v>0) {nearInv=Math.max(nearInv,v);farInv=Math.min(farInv,v)}
  if (!nearInv) throw new Error('取景范围内没有几何体，请调整相机再生成深度图。')
  const zMin=1/nearInv, zMax=1/farInv, range=Math.log(zMax/zMin)
  const rows=new Uint8Array(height*(width+1))
  for (let y=0;y<height;y++) {
    const row=y*(width+1)+1
    for (let x=0;x<width;x++) {
      const inv=depth[y*width+x]
      if (inv) rows[row+x]=range>1e-10 ? clamp(Math.round(255*(1+Math.log(inv*zMin)/range)),1,255) : 255
    }
  }
  return {dataUrl:await grayscalePNG(width,height,rows),zMin,zMax,camera:orbitToAtlasCamera(camera,width,height)}
}

export function interpolateCamera(start,end,t) {
  const a=normalizeCamera(start), b=normalizeCamera(end), amount=clamp(t,0,1)
  const turn=((b.yaw-a.yaw)%360+540)%360-180
  const lerp=(x,y)=>x+(y-x)*amount
  return {yaw:a.yaw+turn*amount,pitch:lerp(a.pitch,b.pitch),distance:lerp(a.distance,b.distance),
    target:a.target.map((v,i)=>lerp(v,b.target[i]))}
}

export function createViewport(canvas,{onSelect,onCameraChange}={}) {
  const ctx=canvas.getContext('2d',{alpha:false})
  if (!ctx) throw new Error('当前浏览器未提供 Canvas 2D 渲染。')
  let scene=defaultScene(),camera=normalizeCamera(initialCamera)
  let meshes=meshScene(scene.objects),light=buildLight(meshes,scene.light)
  let frame=null,image=null,dirty=true,drawRequest=0,playing=0,finishPlayback=null,dead=false
  const pointers=new Map()
  let drag=null

  function draw() {
    if (dead) return
    if (drawRequest) cancelAnimationFrame(drawRequest)
    drawRequest=0
    const rect=canvas.getBoundingClientRect()
    const cssW=Math.max(1,rect.width || canvas.width || 640), cssH=Math.max(1,rect.height || canvas.height || 360)
    const scale=Math.min(Math.max(1.3,window.devicePixelRatio || 1),1.5,Math.sqrt(1048576/(cssW*cssH)))
    const w=Math.max(1,Math.round(cssW*scale)),h=Math.max(1,Math.round(cssH*scale))
    if (canvas.width!==w || canvas.height!==h) {canvas.width=w;canvas.height=h;dirty=true}
    if (!dirty) return
    frame=rasterScene(meshes,camera,w,h,frame || {})
    image=renderView(ctx,frame,light,scene,image)
    dirty=false
  }
  function invalidate() {
    dirty=true
    if (!drawRequest && !dead) drawRequest=requestAnimationFrame(draw)
  }
  function setCamera(value) {
    camera=normalizeCamera(value)
    invalidate()
  }
  function userCamera(value) {
    setCamera(value)
    onCameraChange?.(normalizeCamera(camera))
  }
  function stopPlayback() {
    if (playing) cancelAnimationFrame(playing)
    playing=0
    finishPlayback?.(false)
    finishPlayback=null
  }
  // Camera keys can be plain orbit poses or {camera: pose}. Duration is in ms.
  function playPath(keys,duration=3500) {
    stopPlayback()
    if (!Array.isArray(keys) || keys.length<2) return Promise.resolve(false)
    const path=keys.map(key=>normalizeCamera(key.camera || key))
    const start=performance.now()
    return new Promise(resolve=>{
      finishPlayback=resolve
      const tick=now=>{
        const t=clamp((now-start)/Math.max(1,duration),0,1)
        const segment=t*(path.length-1), index=Math.min(path.length-2,Math.floor(segment))
        userCamera(interpolateCamera(path[index],path[index+1],segment-index))
        draw()
        if (t<1) playing=requestAnimationFrame(tick)
        else {playing=0;finishPlayback=null;resolve(true)}
      }
      tick(start)
    })
  }
  function pick(clientX,clientY) {
    draw()
    const rect=canvas.getBoundingClientRect()
    if (!rect.width || !rect.height || !frame) return null
    const x=Math.floor((clientX-rect.left)*frame.width/rect.width), y=Math.floor((clientY-rect.top)*frame.height/rect.height)
    if (x<0 || y<0 || x>=frame.width || y>=frame.height) return null
    return frame.faces[frame.ids[y*frame.width+x]]?.mesh.id ?? null
  }
  function pan(value,dx,dy) {
    const {right,up}=cameraFrame(value)
    const units=2*value.distance*Math.tan(fov/2)/Math.max(1,canvas.getBoundingClientRect().height)
    return {...value,target:value.target.map((v,i)=>v+units*(-right[i]*dx+up[i]*dy))}
  }
  function down(e) {
    if (e.button>2) return
    stopPlayback()
    pointers.set(e.pointerId,[e.clientX,e.clientY])
    canvas.setPointerCapture?.(e.pointerId)
    if (pointers.size===1) drag={x:e.clientX,y:e.clientY,moved:false,pan:e.button===1 || e.button===2 || e.shiftKey}
    else if (drag) drag.moved=true
  }
  function move(e) {
    if (!pointers.has(e.pointerId) || !drag) return
    const old=pointers.get(e.pointerId), point=[e.clientX,e.clientY]
    if (pointers.size===2) {
      const other=[...pointers].find(([id])=>id!==e.pointerId)[1]
      const oldSpan=Math.hypot(old[0]-other[0],old[1]-other[1])
      const newSpan=Math.hypot(point[0]-other[0],point[1]-other[1])
      const panned=pan(camera,(point[0]-old[0])/2,(point[1]-old[1])/2)
      userCamera({...panned,distance:camera.distance*Math.max(2,oldSpan)/Math.max(2,newSpan)})
    } else if (pointers.size===1) {
      if (!drag.moved && Math.hypot(e.clientX-drag.x,e.clientY-drag.y)<3) return
      drag.moved=true
      const dx=point[0]-old[0],dy=point[1]-old[1]
      if (drag.pan || e.shiftKey) userCamera(pan(camera,dx,dy))
      else userCamera({...camera,yaw:camera.yaw-dx*.35,pitch:camera.pitch+dy*.28})
    }
    pointers.set(e.pointerId,point)
  }
  function end(e) {
    if (!pointers.has(e.pointerId)) return
    if (e.type==='pointerup' && pointers.size===1 && drag && !drag.moved && !drag.pan) {
      const id=pick(e.clientX,e.clientY)
      scene={...scene,selectedId:id}
      invalidate()
      onSelect?.(id)
    }
    pointers.delete(e.pointerId)
    if (!pointers.size) drag=null
  }
  function wheel(e) {
    e.preventDefault()
    stopPlayback()
    const unit=e.deltaMode===1 ? 16 : e.deltaMode===2 ? canvas.clientHeight : 1
    userCamera({...camera,distance:camera.distance*Math.exp(clamp(e.deltaY*unit*.0013,-1,1))})
  }
  const contextMenu=e=>e.preventDefault()
  const events={pointerdown:down,pointermove:move,pointerup:end,pointercancel:end,lostpointercapture:end,contextmenu:contextMenu}
  for (const [name,fn] of Object.entries(events)) canvas.addEventListener(name,fn)
  canvas.addEventListener('wheel',wheel,{passive:false})
  const previousTouchAction=canvas.style.touchAction
  canvas.style.touchAction='none'
  const resize=new ResizeObserver(invalidate)
  resize.observe(canvas)
  invalidate()
  return {
    setScene(value) {
      scene={...value,objects:value?.objects || [],light:value?.light || {},grid:value?.grid!==false}
      meshes=meshScene(scene.objects)
      light=buildLight(meshes,scene.light)
      invalidate()
    },
    setCamera,getCamera:()=>normalizeCamera(camera),pick,playPath,stopPlayback,
    snapshot(width,height,pose=camera) {
      if (width && height) {
        const target=document.createElement('canvas')
        target.width=width;target.height=height
        renderView(target.getContext('2d'),rasterScene(meshes,pose,width,height),light,{...scene,selectedId:null})
        return target.toDataURL('image/png')
      }
      draw()
      return canvas.toDataURL('image/png')
    },
    captureDepth:(pose=camera,width=1280,height=720)=>depthCapture(meshes,normalizeCamera(pose),width,height),
    exportOBJ:()=>meshToOBJ(meshes),
    destroy() {
      dead=true
      stopPlayback()
      if (drawRequest) cancelAnimationFrame(drawRequest)
      resize.disconnect()
      for (const [name,fn] of Object.entries(events)) canvas.removeEventListener(name,fn)
      canvas.removeEventListener('wheel',wheel)
      canvas.style.touchAction=previousTouchAction
      pointers.clear()
    }
  }
}
