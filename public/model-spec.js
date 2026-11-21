export const geometryTypes=['BoxGeometry','CylinderGeometry','ConeGeometry','SphereGeometry','TorusGeometry','ExtrudeGeometry','LatheGeometry','BufferGeometry'];
function requireValue(ok,message){if(!ok)throw new Error(message)}
function nameOf(name){requireValue(typeof name==='string' && name.trim().length>0 && name.trim().length<=100,'模型和构件需要 1–100 字的名称');return name.trim()}
function vector(v,dimension,min,max,label){
 requireValue(Array.isArray(v)&&v.length===dimension&&v.every(n=>typeof n==='number'&&Number.isFinite(n)&&n>=min&&n<=max),label+'无效');
 return v.slice();
}
export function validateModel(value){
 const name=nameOf(value?.name);
 requireValue(Array.isArray(value.parts)&&value.parts.length>=1&&value.parts.length<=96,'模型需要 1–96 个构件');
 const parts=[];
 for(const raw of value.parts){
  requireValue(raw&&geometryTypes.includes(raw.geometry),'不支持该 Three.js 几何类型');
  const part={name:nameOf(raw.name),geometry:raw.geometry,position:vector(raw.position,3,-10000,10000,'位置'),
   size:vector(raw.size,3,.001,10000,'尺寸'),rotation:vector(raw.rotation??[0,0,0],3,-3600,3600,'旋转角度'),color:raw.color};
  requireValue(typeof part.color==='string'&&/^#[0-9a-f]{6}$/i.test(part.color),'材质色必须为 #RRGGBB');
  if(part.geometry==='ExtrudeGeometry'||part.geometry==='LatheGeometry'){
   const lathe=part.geometry==='LatheGeometry',points=raw.profile;
   requireValue(Array.isArray(points)&&points.length>=(lathe?2:3)&&points.length<=48,'轮廓点数量无效');
   part.profile=points.map(p=>vector(p,2,-10000,10000,'轮廓点'));
   if(lathe)requireValue(points.every(p=>p[0]>=0)&&points.some(p=>p[0]>0)&&points.some(p=>p[1]!==points[0][1]),'旋转轮廓需要非负半径和有效高度');
   else{
    const area=points.reduce((s,[x,y],i)=>{const n=points[(i+1)%points.length];return s+x*n[1]-y*n[0]},0);
    requireValue(Math.abs(area)>1e-9,'挤出轮廓没有面积');
   }
  }
  if(part.geometry==='BufferGeometry'){
   requireValue(Array.isArray(raw.vertices)&&raw.vertices.length>=3&&raw.vertices.length<=256,'自定义网格需要 3–256 个顶点');
   part.vertices=raw.vertices.map(v=>vector(v,3,-10000,10000,'网格顶点'));
   requireValue(Array.isArray(raw.triangles)&&raw.triangles.length>=1&&raw.triangles.length<=512,'自定义网格需要 1–512 个三角面');
   part.triangles=raw.triangles.map(face=>{
    requireValue(Array.isArray(face)&&face.length===3&&new Set(face).size===3&&face.every(i=>Number.isInteger(i)&&i>=0&&i<part.vertices.length),'三角面需要三个不同的有效顶点索引');
    return face.slice();
   });
  }
  const count=raw.repeat?.count??1;
  requireValue(Number.isInteger(count)&&count>=1&&parts.length+count<=96,'展开后最多允许 96 个构件');
  const step=raw.repeat?vector(raw.repeat.step,3,-10000,10000,'排列间距'):[0,0,0];
  for(let i=0;i<count;i++){
   const position=vector(part.position.map((n,k)=>n+i*step[k]),3,-10000,10000,'排列位置');
   parts.push({...part,position,name:count===1?part.name:part.name.slice(0,94)+' '+(i+1)});
  }
 }
 return {name,parts};
}
export function modelParts(model,group,version){
 return model.parts.map((p,i)=>({type:'three',id:version+'-'+i,group,groupName:model.name,modelVersion:version,
  name:p.name,geometry:p.geometry,x:p.position[0],y:p.position[1],z:p.position[2],w:p.size[0],h:p.size[1],d:p.size[2],
  rx:p.rotation[0],ry:p.rotation[1],rz:p.rotation[2],color:p.color,...(p.profile?{profile:p.profile}:{}),...(p.vertices?{vertices:p.vertices,triangles:p.triangles}:{})}));
}
export function readPart(o){
 return {name:o.name,geometry:o.geometry||({box:'BoxGeometry',cylinder:'CylinderGeometry',sphere:'SphereGeometry'}[o.type]),
  position:[o.x,o.y,o.z],size:[o.w,o.h,o.d],rotation:[o.rx||0,o.ry||0,o.rz||0],color:o.color,...(o.profile?{profile:o.profile}:{}),...(o.vertices?{vertices:o.vertices,triangles:o.triangles}:{})};
}
