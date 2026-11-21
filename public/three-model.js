import * as THREE from 'three';
import {readPart} from './model-spec.js';

// This self-contained constructor is also included in downloadable ES modules.
function makeMesh(THREE,part){
 let geometry;
 switch(part.geometry){
  case 'BoxGeometry':geometry=new THREE.BoxGeometry(1,1,1);break;
  case 'CylinderGeometry':geometry=new THREE.CylinderGeometry(.5,.5,1,24);break;
  case 'ConeGeometry':geometry=new THREE.ConeGeometry(.5,1,24);break;
  case 'SphereGeometry':geometry=new THREE.SphereGeometry(.5,20,12);break;
  case 'TorusGeometry':geometry=new THREE.TorusGeometry(.4,.1,10,24);break;
  case 'ExtrudeGeometry':{
   const shape=new THREE.Shape(part.profile.map(([x,y])=>new THREE.Vector2(x,y)));
   geometry=new THREE.ExtrudeGeometry(shape,{depth:1,steps:1,bevelEnabled:false});break;
  }
  case 'LatheGeometry':geometry=new THREE.LatheGeometry(part.profile.map(([r,y])=>new THREE.Vector2(r,y)),24);break;
  case 'BufferGeometry':{
   geometry=new THREE.BufferGeometry();
   geometry.setAttribute('position',new THREE.Float32BufferAttribute(part.vertices.flat(),3));
   geometry.setIndex(part.triangles.flat());geometry.computeVertexNormals();break;
  }
  default:throw new Error('不支持的 Three.js 几何类型');
 }
 geometry.computeBoundingBox();
 const extent=geometry.boundingBox.getSize(new THREE.Vector3());
 geometry.center();
 geometry.scale(1/Math.max(extent.x,1e-9),1/Math.max(extent.y,1e-9),1/Math.max(extent.z,1e-9));
 const mesh=new THREE.Mesh(geometry,new THREE.MeshStandardMaterial({color:part.color,roughness:.78}));
 mesh.name=part.name;mesh.position.fromArray(part.position);mesh.scale.fromArray(part.size);
 mesh.rotation.set(...part.rotation.map(THREE.MathUtils.degToRad));mesh.updateMatrixWorld();
 return mesh;
}
export function nativeGroup(objects,name='模型'){
 const group=new THREE.Group();group.name=name;
 for(const obj of objects)group.add(makeMesh(THREE,readPart(obj)));
 return group;
}
export function modelModule(objects,name){
 const parts=objects.map(readPart);
 return "import * as THREE from 'three';\n\n"+makeMesh.toString()+"\n\nconst parts = "+JSON.stringify(parts,null,2)+";\n\nexport function buildModel() {\n  const group = new THREE.Group();\n  group.name = "+JSON.stringify(name)+";\n  for (const part of parts) group.add(makeMesh(THREE, part));\n  return group;\n}\n";
}
export function geometryForViewport(o){
 const mesh=makeMesh(THREE,readPart(o)),g=mesh.geometry;
 const points=g.getAttribute('position'),vertex=new THREE.Vector3(),vertices=[];
 for(let i=0;i<points.count;i++)vertices.push(vertex.fromBufferAttribute(points,i).applyMatrix4(mesh.matrixWorld).toArray());
 const indices=g.getIndex()?.array,faces=[],count=indices?.length??points.count;
 const a=new THREE.Vector3(),b=new THREE.Vector3(),c=new THREE.Vector3();
 for(let i=0;i<count;i+=3){
  const tri=indices?[indices[i],indices[i+1],indices[i+2]]:[i,i+1,i+2];
  a.fromArray(vertices[tri[0]]);b.fromArray(vertices[tri[1]]).sub(a);c.fromArray(vertices[tri[2]]).sub(a);
  b.cross(c);if(b.lengthSq()>1e-18)faces.push({indices:tri,normal:b.normalize().toArray()});
 }
 g.dispose();mesh.material.dispose();
 return {id:o.id,name:o.name,vertices,faces,color:[1,3,5].map(i=>parseInt(o.color.slice(i,i+2),16))};
}
export function frameModel(objects,currentCamera){
 const group=nativeGroup(objects),bounds=new THREE.Box3().setFromObject(group,true);
 group.traverse(o=>{o.geometry?.dispose();o.material?.dispose()});
 const center=bounds.getCenter(new THREE.Vector3()),size=bounds.getSize(new THREE.Vector3());
 return {...currentCamera,target:center.toArray(),distance:Math.max(1,size.length()*1.7)};
}

