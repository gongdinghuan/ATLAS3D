import {cameraFrame, clamp, fov, radians} from './viewport-geometry.js'

const dot = (a,b) => a[0]*b[0]+a[1]*b[1]+a[2]*b[2]
const near = .035
const shadowSize = 640
const focalLength = h => h/(2*Math.tan(fov/2))

// Rasterize at pixel centres. The interpolant is reciprocal Z for perspective
// and light-space Z for the orthographic shadow pass. Larger is nearer in both.
function triangle(a,b,c,width,height,buffer,ids,id) {
  const ax=a[0], ay=a[1], bx=b[0], by=b[1], cx=c[0], cy=c[1]
  const det=(bx-ax)*(cy-ay)-(by-ay)*(cx-ax)
  if (Math.abs(det)<1e-8) return
  const x0=Math.max(0,Math.ceil(Math.min(ax,bx,cx)-.5))
  const y0=Math.max(0,Math.ceil(Math.min(ay,by,cy)-.5))
  const x1=Math.min(width-1,Math.floor(Math.max(ax,bx,cx)-.5))
  const y1=Math.min(height-1,Math.floor(Math.max(ay,by,cy)-.5))
  if (x0>x1 || y0>y1) return
  const sx=(cy-ay)/det, sy=(ax-cx)/det, tx=(ay-by)/det, ty=(bx-ax)/det
  let s0=(x0+.5-ax)*sx+(y0+.5-ay)*sy
  let t0=(x0+.5-ax)*tx+(y0+.5-ay)*ty
  const ds=b[2]-a[2], dt=c[2]-a[2], dz=sx*ds+tx*dt
  for (let y=y0; y<=y1; y++,s0+=sy,t0+=ty) {
    let i=y*width+x0, s=s0, t=t0, z=a[2]+s*ds+t*dt
    for (let x=x0; x<=x1; x++,i++,s+=sx,t+=tx,z+=dz) {
      if (s>=-1e-7 && t>=-1e-7 && s+t<=1.0000001 && z>buffer[i]) {
        buffer[i]=z
        if (ids) ids[i]=id
      }
    }
  }
}

function clipNear(points) {
  const clipped=[]
  let prev=points.at(-1)
  for (const curr of points) {
    if ((curr[2]>=near)!==(prev[2]>=near)) {
      const t=(near-prev[2])/(curr[2]-prev[2])
      clipped.push([prev[0]+(curr[0]-prev[0])*t,prev[1]+(curr[1]-prev[1])*t,near])
    }
    if (curr[2]>=near) clipped.push(curr)
    prev=curr
  }
  return clipped
}

export function rasterScene(meshes,camera,width,height,buffers={}) {
  const frame=cameraFrame(camera), f=focalLength(height)
  const depth=buffers.depth?.length===width*height ? buffers.depth : new Float32Array(width*height)
  const ids=buffers.ids?.length===width*height ? buffers.ids : new Int32Array(width*height)
  depth.fill(0); ids.fill(0)
  const faces=[null]
  const project=([x,y,z]) => [width/2+x*f/z,height/2-y*f/z,1/z]
  for (const mesh of meshes) {
    const vertices=mesh.vertices.map(p=>{
      const delta=p.map((v,i)=>v-frame.position[i])
      return [dot(delta,frame.right),dot(delta,frame.up),-dot(delta,frame.back)]
    })
    const projected=vertices.map(p=>p[2]>=near ? project(p) : null)
    for (const face of mesh.faces) {
      const front=mesh.vertices[face.indices[0]]
      if (dot(face.normal,frame.position)-dot(face.normal,front)<0) continue
      let polygon=face.indices.map(i=>projected[i])
      if (polygon.some(p=>!p)) polygon=clipNear(face.indices.map(i=>vertices[i])).map(project)
      if (polygon.length<3) continue
      const id=faces.push({mesh,normal:face.normal,point:front})-1
      for (let j=1;j+1<polygon.length;j++) triangle(polygon[0],polygon[j],polygon[j+1],width,height,depth,ids,id)
    }
  }
  return {width,height,depth,ids,faces,frame,f}
}

export function buildLight(meshes,settings={}) {
  const a=(settings.azimuth ?? -36)*radians
  const b=clamp(settings.elevation ?? 49,1,89.9)*radians
  const intensity=clamp(settings.intensity ?? 1,0,4)
  const sin=Math.sin(a), cos=Math.cos(a), sb=Math.sin(b), cb=Math.cos(b)
  const back=[sin*cb,sb,cos*cb], right=[cos,0,-sin], up=[-sin*sb,cb,-cos*sb]
  let x0=Infinity,x1=-Infinity,y0=Infinity,y1=-Infinity
  for (const mesh of meshes) for (const p of mesh.vertices) {
    const x=dot(p,right), y=dot(p,up)
    x0=Math.min(x0,x); x1=Math.max(x1,x); y0=Math.min(y0,y); y1=Math.max(y1,y)
  }
  if (!meshes.length) { x0=y0=-1; x1=y1=1 }
  const scale=(shadowSize-8)/Math.max(x1-x0,y1-y0,.01)
  const offsetX=shadowSize/2-(x0+x1)*scale/2, offsetY=shadowSize/2-(y0+y1)*scale/2
  const map = new Float32Array(shadowSize*shadowSize).fill(-Infinity)
  for (const mesh of meshes) {
    const points=mesh.vertices.map(p=>[dot(p,right)*scale+offsetX,dot(p,up)*scale+offsetY,dot(p,back)])
    for (const {indices} of mesh.faces) for (let i=1;i+1<indices.length;i++) {
      triangle(points[indices[0]],points[indices[i]],points[indices[i+1]],shadowSize,shadowSize,map,null,0)
    }
  }
  return {right,up,back,intensity,scale,offsetX,offsetY,map}
}

function visibility(light,x,y,z,bias) {
  const u=(light.right[0]*x+light.right[2]*z)*light.scale+light.offsetX-.5
  const v=(light.up[0]*x+light.up[1]*y+light.up[2]*z)*light.scale+light.offsetY-.5
  if (u<0 || v<0 || u>=shadowSize-1 || v>=shadowSize-1) return 1
  const ix=u|0, iy=v|0, fx=u-ix, fy=v-iy
  const p=iy*shadowSize+ix, h=x*light.back[0]+y*light.back[1]+z*light.back[2]+bias
  const m=light.map
  const top=(h>=m[p])*(1-fx)+(h>=m[p+1])*fx
  const bottom=(h>=m[p+shadowSize])*(1-fx)+(h>=m[p+shadowSize+1])*fx
  return top*(1-fy)+bottom*fy
}

function materials(faces,light,selectedId,frame,focal) {
  return faces.map(face=>{
    if (!face) return null
    const n=face.normal, c=face.mesh.color
    const diffuse=Math.max(0,dot(n,light.back))
    const ambient=.55+.14*n[1]+.035*n[0]
    const direct=diffuse*Math.min(2.3,light.intensity)*.45
    const plane=dot(n,face.point)-dot(n,frame.position)
    return {color:c, ambient,direct,bias:Math.min(7,1.2/Math.max(diffuse,.13))/light.scale,
      slopeX:dot(n,frame.right)/(focal*plane),slopeY:-dot(n,frame.up)/(focal*plane),
      selected:!!selectedId && face.mesh.id===selectedId}
  })
}

// Reciprocal depth varies linearly over a projected plane. Comparing a nearby
// pixel against that plane rejects self-occlusion on sloping roofs and walls.
const contactTaps=[[-1,-.3],[.25,-.95],[1,.28],[-.32,1],[-.5,-.69],[.78,-.47],[.54,.79],[-.86,.52]]
function contactShade(depth,w,h,x,y,inv,m,f) {
  const z=1/inv
  const radius=clamp(.68*f*inv,2,48)
  let sum=0
  for (let j=0;j<contactTaps.length;j++) {
    const r=j<4 ? radius*.42 : radius
    const ox=Math.round(contactTaps[j][0]*r), oy=Math.round(contactTaps[j][1]*r)
    const sampleX=x+ox,sampleY=y+oy
    if (sampleX<0 || sampleY<0 || sampleX>=w || sampleY>=h) continue
    const sample=depth[sampleY*w+sampleX],plane=inv+ox*m.slopeX+oy*m.slopeY
    if (sample<=plane || !sample || plane<=0) continue
    const gap=(sample-plane)*z/sample
    sum+=clamp(gap*8,0,1)*clamp(1-gap/1.2,0,1)
  }
  return 1-sum*.032
}

// The displayed image, picking and exported depth all use the same Z-buffer
// and pixel-centre convention. The studio floor is an editor overlay.
export function renderView(ctx,raster,light,scene,image) {
  const {width:w,height:h,depth,ids,faces,frame,f}=raster
  if (!image || image.width!==w || image.height!==h) image=ctx.createImageData(w,h)
  const pixels=image.data, mats=materials(faces,light,scene.selectedId,frame,f)
  const {position:pos,right,up,back}=frame
  const deltaX=right[0]/f, deltaZ=right[2]/f
  for (let y=0;y<h;y++) {
    const localY=(h/2-y-.5)/f, localX=(.5-w/2)/f
    let dx=right[0]*localX+up[0]*localY-back[0], dz=right[2]*localX+up[2]*localY-back[2]
    const dy=up[1]*localY-back[1]
    const groundDepth=-pos[1]/dy
    const floorVisible=groundDepth>near && groundDepth<350
    const groundXStep=deltaX*groundDepth, groundZStep=deltaZ*groundDepth
    let groundX=pos[0]+dx*groundDepth, groundZ=pos[2]+dz*groundDepth
    const gridWidth=Math.min(.13,Math.max(.005,groundDepth/f*.78))
    const fade=floorVisible ? clamp((110-groundDepth)/80,0,1) : 0
    const vertical=y/h
    for (let x=0,i=y*w; x<w; x++,i++,dx+=deltaX,dz+=deltaZ,groundX+=groundXStep,groundZ+=groundZStep) {
      const faceId=ids[i]
      let r,g,b
      if (faceId) {
        const m=mats[faceId], z=1/depth[i]
        const vis=m.direct>0 ? visibility(light,pos[0]+dx*z,pos[1]+dy*z,pos[2]+dz*z,m.bias) : 1
        const occlusion=contactShade(depth,w,h,x,y,depth[i],m,f)
        const shade=m.ambient*occlusion+m.direct*vis
        r=m.color[0]*shade; g=m.color[1]*shade; b=m.color[2]*(shade+.015*(1-vis))
        if (m.selected) {
          const border=(x>0 && !mats[ids[i-1]]?.selected) || (x<w-1 && !mats[ids[i+1]]?.selected)
            || (y>0 && !mats[ids[i-w]]?.selected) || (y<h-1 && !mats[ids[i+w]]?.selected)
          if (border) {r=250;g=186;b=104}
          else {r=r*.9+22;g=g*.9+14;b=b*.9+5}
        }
      } else {
        const nx=(x+.5)/w-.49, ny=vertical-.45
        const glow=Math.max(0,1-1.55*nx*nx-1.05*ny*ny)
        let value=22+glow*18+vertical*2.5
        if (floorVisible) {
          const vis=visibility(light,groundX,0,groundZ,1/light.scale)
          value-=11*(1-vis)*Math.min(1,light.intensity)
          if (scene.grid && fade>0) {
            const edge=Math.min(Math.abs(groundX-Math.round(groundX)), Math.abs(groundZ-Math.round(groundZ)))
            const major=Math.min(Math.abs(groundX-5*Math.round(groundX/5)),Math.abs(groundZ-5*Math.round(groundZ/5)))
            value+=fade*(8*clamp(1-edge/gridWidth,0,1)+4*clamp(1-major/gridWidth,0,1))
          }
        }
        r=value*.94; g=value; b=value*1.035
      }
      const p=i*4
      pixels[p]=r; pixels[p+1]=g; pixels[p+2]=b; pixels[p+3]=255
    }
  }
  ctx.putImageData(image,0,0)
  return image
}
