export const geometryTypes=['BoxGeometry','CylinderGeometry','ConeGeometry','SphereGeometry','TorusGeometry','ExtrudeGeometry','LatheGeometry','BufferGeometry'];
function requireValue(ok,message){if(!ok)throw new Error(message)}
function nameOf(name){requireValue(typeof name==='string' && name.trim().length>0 && name.trim().length<=100,'模型和构件需要 1–100 字的名称');return name.trim()}
function vector(v,dimension,min,max,label){
 requireValue(Array.isArray(v)&&v.length===dimension&&v.every(n=>typeof n==='number'&&Number.isFinite(n)&&n>=min&&n<=max),label+'无效');
 return v.slice();
}
function signedArea(points){
 return points.reduce((sum,[x,y],i)=>{const next=points[(i+1)%points.length];return sum+x*next[1]-y*next[0]},0)/2;
}
function edges(points){return points.map((p,i)=>[p,points[(i+1)%points.length]])}
function crosses([a,b],[c,d]){
 const orient=(p,q,r)=>Math.sign((q[0]-p[0])*(r[1]-p[1])-(q[1]-p[1])*(r[0]-p[0]));
 const overlaps=k=>Math.max(Math.min(a[k],b[k]),Math.min(c[k],d[k]))<=Math.min(Math.max(a[k],b[k]),Math.max(c[k],d[k]));
 return overlaps(0)&&overlaps(1)&&orient(a,b,c)*orient(a,b,d)<=0&&orient(c,d,a)*orient(c,d,b)<=0;
}
function inside([x,y],ring){
 let result=false;
 for(const [[ax,ay],[bx,by]] of edges(ring)){
  if((ay>y)!==(by>y)&&x<(bx-ax)*(y-ay)/(by-ay)+ax)result=!result;
 }
 return result;
}
function openRing(points){
 const last=points.at(-1),first=points[0];
 const ring=last[0]===first[0]&&last[1]===first[1]?points.slice(0,-1):points;
 const segments=edges(ring);
 requireValue(Math.abs(signedArea(ring))>1e-9&&new Set(ring.map(p=>p.join(','))).size===ring.length,'开孔轮廓需要互异的顶点和有效面积');
 requireValue(!segments.some((e,i)=>segments.some((f,j)=>j>i+1&&!(i===0&&j===segments.length-1)&&crosses(e,f))),'开孔轮廓不能自交');
 return ring;
}
function validateHoles(outer,raw){
 requireValue(Array.isArray(raw)&&raw.length<=12,'每个挤出构件最多 12 个开孔');
 const boundary=openRing(outer),holes=[];
 const touches=(a,b)=>edges(a).some(e=>edges(b).some(f=>crosses(e,f)));
 for(const points of raw){
  requireValue(Array.isArray(points)&&points.length>=3&&points.length<=48,'每个开孔需要 3–48 个顶点');
  const ring=openRing(points.map(p=>vector(p,2,-10000,10000,'开孔点')));
  requireValue(inside(ring[0],boundary)&&!touches(ring,boundary),'开孔必须在外轮廓以内');
  requireValue(!holes.some(h=>inside(ring[0],h)||inside(h[0],ring)||touches(ring,h)),'开孔不能相交、重叠或嵌套');
  holes.push(ring);
 }
 return holes;
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
    requireValue(Math.abs(signedArea(points))>5e-10,'挤出轮廓没有面积');
    if(raw.holes!==undefined)part.holes=validateHoles(points,raw.holes);
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
  rx:p.rotation[0],ry:p.rotation[1],rz:p.rotation[2],color:p.color,...(p.profile?{profile:p.profile}:{}),...(p.holes?{holes:p.holes}:{}),...(p.vertices?{vertices:p.vertices,triangles:p.triangles}:{})}));
}
export function readPart(o){
 return {name:o.name,geometry:o.geometry||({box:'BoxGeometry',cylinder:'CylinderGeometry',sphere:'SphereGeometry'}[o.type]),
  position:[o.x,o.y,o.z],size:[o.w,o.h,o.d],rotation:[o.rx||0,o.ry||0,o.rz||0],color:o.color,...(o.profile?{profile:o.profile}:{}),...(o.holes?{holes:o.holes}:{}),...(o.vertices?{vertices:o.vertices,triangles:o.triangles}:{})};
}
