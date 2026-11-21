import {geometryForViewport} from './three-model.js';

const TAU = 2 * Math.PI
export const radians = Math.PI / 180
export const fov = 37 * radians
export const initialCamera = {yaw: 34, pitch: 21, distance: 26, target: [0, 1.9, 0]}
export const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))
const finite = (v, fallback) => Number.isFinite(v) ? v : fallback

export function normalizeCamera(camera = {}) {
  return {
    yaw: finite(camera.yaw, initialCamera.yaw),
    pitch: clamp(finite(camera.pitch, initialCamera.pitch), -89.9, 89.9),
    distance: clamp(finite(camera.distance, initialCamera.distance), .12, 20000),
    target: initialCamera.target.map((v, i) => finite(camera.target?.[i], v))
  }
}

// Metres, right-handed Y-up. Zero yaw places the camera on +Z.
// A positive yaw orbits toward +X. Local camera axes are right/up/back (RUB).
export function cameraFrame(camera) {
  const {yaw, pitch, distance, target} = normalizeCamera(camera)
  const a = yaw * radians, b = pitch * radians
  const sa = Math.sin(a), ca = Math.cos(a), sb = Math.sin(b), cb = Math.cos(b)
  const back = [sa * cb, sb, ca * cb]
  return {
    right: [ca, 0, -sa], up: [-sa * sb, cb, -ca * sb], back,
    position: target.map((v, i) => v + distance * back[i])
  }
}

export function orbitToAtlasCamera(camera, width = 1280, height = 720) {
  const c = normalizeCamera(camera)
  const yaw = c.yaw * radians / 2, pitch = -c.pitch * radians / 2
  const sy = Math.sin(yaw), cy = Math.cos(yaw), sp = Math.sin(pitch), cp = Math.cos(pitch)
  const focal = height / (2 * Math.tan(fov / 2))
  return {
    intrinsics: {fx: focal, fy: focal, cx: width / 2, cy: height / 2, width, height},
    extrinsics: {
      position: cameraFrame(c).position, quaternion: [cy * sp, sy * cp, -sy * sp, cy * cp],
      coordinateSystem: 'rub'
    }
  }
}

// A terraced courtyard pavilion. Each element remains an ordinary editable primitive.
export function defaultScene() {
  const objects = []
  function box(id, name, x, y, z, w, h, d, color = '#cec9bc', type = 'box') {
    objects.push({id, name, type, x, y, z, w, h, d, color})
  }
  const stone = '#d3cfc2', edge = '#b6afa1', glass = '#5a6361', bronze = '#817a69'
  box('plinth','场地基座',0,.13,0,14.7,.26,10.4,'#8e9086')
  box('terrace','首层平台',-.15,.47,-.6,12.8,.42,7.2,stone)
  box('reflecting-pool','倒影水池',-2.65,.291,3.68,6.8,.062,2.52,'#667d7d')
  box('pool-rim','池岸压顶',-2.65,.36,4.97,7.04,.2,.14,edge)
  box('pool-edge','池岸侧墙',-6.1,.36,3.68,.14,.2,2.52,edge)
  box('pool-edge-right','池岸侧墙（东）',.8,.36,3.68,.14,.2,2.52,edge)
  for (let i=0;i<4;i++) {
    box('step-'+i,'入口踏步 '+(i+1),3.5,.26+(4-i)*.052,3.08+i*.43,3.8,(4-i)*.104,.44,stone)
  }
  box('lower-core','首层混凝土核心筒',-.2,1.82,-2.2,10.8,2.28,2.7,edge)
  box('lower-glazing','首层玻璃幕墙',.25,1.79,-.1,9.6,2.2,1.87,glass)
  for (let i=0;i<9;i++) {
    box('front-mullion-'+i,'首层幕墙竖梃 '+(i+1),-4.45+i*1.17,1.8,.86,.066,2.24,.08,'#777a70')
  }
  for (const [i,x] of [-5.65,.55,5.4].entries()) {
    box('pilotis-'+i,'架空层柱 '+(i+1),x,1.86,2.05,.25,2.36,.25,stone)
  }
  box('gallery-end','西侧剪力墙',-5.63,1.85,-.56,.48,2.34,4.6,stone)
  box('upper-deck','悬挑楼板',0,3.17,-.32,13.1,.41,6.35,stone)
  box('upper-back','展厅后墙',-.97,4.38,-2.47,9.86,2.02,.5,stone)
  box('upper-west','展厅西山墙',-5.72,4.38,-.29,.4,2.02,4.85,stone)
  box('upper-east','展厅东山墙',3.79,4.38,-.29,.38,2.02,4.85,stone)
  box('gallery-glass','展厅落地玻璃',-.93,4.36,.96,9.2,2.0,.16,'#626a66')
  for (let i=0;i<6;i++) {
    box('gallery-mullion-'+i,'展厅窗框 '+(i+1),-5.4+i*1.72,4.37,1.06,.095,2,.1,bronze)
  }
  for (let i=0;i<11;i++) {
    box('screen-'+i,'遮阳翼片 '+(i+1),-5.35+i*.35,4.37,1.69,.11,2.02,.73,'#b7ae99')
  }
  box('roof','展厅悬挑屋盖',-.88,5.55,-.22,10.9,.36,5.56,stone)
  box('roof-rim-back','屋面泛水（北）',-.88,5.82,-2.94,10.87,.18,.09,edge)
  box('roof-rim-front','屋面泛水（南）',-.88,5.82,2.51,10.87,.18,.09,edge)
  box('roof-rim-left','屋面泛水（西）',-6.27,5.82,-.22,.09,.18,5.39,edge)
  box('roof-rim-right','屋面泛水（东）',4.52,5.82,-.22,.09,.18,5.39,edge)
  box('roof-inset','屋面覆盖层',-.88,5.75,-.22,10.64,.042,5.31,'#b7b3a6')
  // The uncovered east terrace is topped by an open timber pergola.
  box('pergola-post-front','廊架前柱',6.1,4.28,2.05,.14,1.82,.14,bronze)
  box('pergola-post-back','廊架后柱',6.1,4.28,-2.38,.14,1.82,.14,bronze)
  box('pergola-beam','廊架边梁',6.1,5.21,-.16,.16,.18,4.78,bronze)
  for (let i=0;i<10;i++) {
    box('rafter-'+i,'廊架椽条 '+(i+1),5.12,5.32,-2.39+i*.495,2.25,.18,.11,'#b7ac95')
  }
  // A small bench gives the building a recognizable human scale.
  box('bench','平台长椅',-3.35,1.12,2.31,2.22,.14,.51,'#aaa08b')
  for (const [i,x] of [-4.18,-2.53].entries()) box('bench-foot-'+i,'长椅支座 '+(i+1),x,.87,2.31,.16,.38,.38,edge)
  return {objects, light: {azimuth: -36, elevation: 49, intensity: 1}, grid: true, selectedId: null}
}

function unitShape(type) {
  const vertices = [], faces = []
  if (type === 'box') {
    for (const [x,y,z] of [[-1,-1,-1],[1,-1,-1],[1,1,-1],[-1,1,-1],[-1,-1,1],[1,-1,1],[1,1,1],[-1,1,1]]) {
      vertices.push([x/2,y/2,z/2])
    }
    faces.push([0,3,2,1],[4,5,6,7],[0,4,7,3],[1,2,6,5],[3,7,6,2],[0,1,5,4])
  } else {
    const sides = 24
    const latitudes = type === 'sphere' ? 12 : 1
    const ringCount = type === 'sphere' ? latitudes - 1 : 2
    for (let j=0;j<ringCount;j++) {
      const lat = type === 'sphere' ? Math.PI*((j+1)/latitudes-.5) : 0
      const y = type === 'sphere' ? Math.sin(lat)/2 : j-.5
      for (let i=0;i<sides;i++) {
        vertices.push([Math.cos(TAU*i/sides)*Math.cos(lat)/2,y,Math.sin(TAU*i/sides)*Math.cos(lat)/2])
      }
    }
    for (let j=0;j<ringCount-1;j++) {
      for (let i=0;i<sides;i++) {
        const p = j*sides+i, q = j*sides+(i+1)%sides
        faces.push([p,p+sides,q+sides,q])
      }
    }
    const bottom = vertices.push([0,-.5,0])-1
    const top = vertices.push([0,.5,0])-1
    const last = (ringCount-1)*sides
    for (let i=0;i<sides;i++) {
      const next = (i+1)%sides
      faces.push([bottom,i,next],[top,last+next,last+i])
    }
  }
  return {vertices,faces}
}

const primitives = Object.fromEntries(['box','cylinder','sphere'].map(type => [type,unitShape(type)]))
const normal = (a,b,c) => {
  const u = b.map((v,i) => v-a[i]), v = c.map((n,i) => n-a[i])
  const n = [u[1]*v[2]-u[2]*v[1],u[2]*v[0]-u[0]*v[2],u[0]*v[1]-u[1]*v[0]]
  const length = Math.hypot(...n) || 1
  return n.map(v => v/length)
}

export function meshScene(objects) {
  return (objects || []).map((o, index) => {
    if(o.type==='three')return geometryForViewport(o);
    const primitive = primitives[o.type] || primitives.box
    const size = [o.w,o.h,o.d].map(v => Math.max(.001, finite(v, 1)))
    const center = [o.x,o.y,o.z].map(v => finite(v,0))
    const vertices = primitive.vertices.map(p => p.map((v,i) => v*size[i]+center[i]))
    const code = /^#[0-9a-f]{6}$/i.test(o.color) ? parseInt(o.color.slice(1),16) : 0xbebbb2
    const color = [(code>>16)&255,(code>>8)&255,code&255]
    const faces = primitive.faces.map(indices => ({indices,normal:normal(...indices.slice(0,3).map(i=>vertices[i]))}))
    return {id:o.id, name:o.name || o.id || ('object-'+index), vertices, faces, color}
  })
}

export function meshToOBJ(meshes) {
  const lines = ['# Atlas Studio | metres, right-handed, Y up']
  let base = 1
  for (const mesh of meshes) {
    lines.push('o '+String(mesh.name).replace(/[\r\n\s#]+/g,'_'))
    for (const point of mesh.vertices) lines.push('v '+point.map(v=>Number(v.toFixed(6))).join(' '))
    for (const face of mesh.faces) lines.push('f '+face.indices.map(i=>base+i).join(' '))
    base += mesh.vertices.length
  }
  return lines.join('\n')+'\n'
}
