import test from 'node:test';
import assert from 'node:assert/strict';
import { assetReference, posedFrame, buildTaskInput, resultAssets, mergeOperation } from '../public/workflows.js';

const ref = id => ({ assetId: id, url: 'https://assets.example/' + id });
const camera = { extrinsics: { coordinateSystem: 'rub', quaternion: [0,0,0,1], position: [0,0,0] }, intrinsics: {width:1280,height:720,fx:900,fy:900,cx:640,cy:360} };
const frame = { imageAsset: ref('image'), camera, depth: { depthAsset: ref('depth'), confidenceAsset: ref('confidence') }, centroidWorld: [1,2,3], maskAsset: ref('mask') };
const input = (task, extra) => buildTaskInput(task, {provider:'atlas', prompt:'海边的白色小屋', ...extra});

test('reconstruction sends ordered image references without leaking signed URLs or output metadata', () => {
  assert.deepEqual(assetReference(ref('image')), {assetId:'image'});
  assert.deepEqual(posedFrame(frame), {imageAsset:{assetId:'image'}, camera, depth:{depthAsset:{assetId:'depth'}}});
  const body = input('images2PosedRGBD', {images:[ref('image'),ref('second')],resolution:'1280x720'});
  assert.deepEqual(body.frames,[{imageAsset:{assetId:'image'}},{imageAsset:{assetId:'second'}}]);
  assert.deepEqual(body.targetResolution,[1280,720]);
});

test('images provider receives only its own contract; Atlas supports returned depth', () => {
  assert.deepEqual(input('atlasTextToImage', {provider:'images',model:'custom',size:'1024x1024',n:1}), {prompt:'海边的白色小屋',model:'custom',size:'1024x1024',n:1});
  assert.equal(input('atlasTextToImage',{ratio:'4:3',n:1,returnDepth:true}).returnDepth,true);
});

test('generation and Chisel keep the camera paired with its image and depth', () => {
  const b=input('atlasGenerate',{frames:[frame],cameras:[camera,camera],returnDepth:true});
  assert.deepEqual(b.contextFrames,[posedFrame(frame)]);
  assert.equal(b.targetCameras.length,2);
  const chisel=input('atlasChisel',{targets:[{camera,imageAsset:ref('image'),maskAsset:ref('mask')}]});
  assert.deepEqual(chisel.targetFrames,[{camera,imageAsset:{assetId:'image'},maskAsset:{assetId:'mask'}}]);
  const flat={logDepthAsset:ref('plane'),zMin:2,zMax:2};
  assert.deepEqual(input('atlasChisel',{targets:[{camera,depth:flat}]}).targetFrames[0].depth,{...flat,logDepthAsset:{assetId:'plane'}});
});

test('splat reconstruction enforces frame count, depth and compatible image grids', () => {
  assert.throws(()=>input('posedImages2Splats',{frames:[frame]}));
  const second={...frame,camera:{...camera,intrinsics:{...camera.intrinsics,width:960}}};
  assert.throws(()=>input('posedImages2Splats',{frames:[frame,second]}));
  const body=input('posedImages2Splats',{frames:[frame,frame],refine:false});
  assert.equal(body.posedFrames.length,2);
  assert.equal(body.refine,false);
});

test('both draft and refined splat outputs flow into meshing', () => {
  const assets=resultAssets({draftSplat:ref('draft'), refinedSplats:{'500000':ref('refined')}});
  assert.equal(assets.length,2);
  for (const a of assets) {
    const mesh=input('splats2Mesh',{splat:a.asset,textureMode:'vertex_color',colliders:true,faces:50000});
    assert.equal(mesh.splatAsset.assetId,a.asset.assetId);
    assert.deepEqual(mesh.colliderBoxes,{});
    assert.equal(mesh.targetFaces,50000);
  }
});

test('terminal result wins over a late in-flight poll, cancellation request stays pending', () => {
  const job={id:'local',operationId:'remote',status:'cancelling'};
  assert.equal(mergeOperation(job,{id:'remote',done:false}).status,'cancelling');
  const ready=mergeOperation(job,{id:'remote',done:true,response:{frames:[frame]}});
  assert.equal(ready.status,'succeeded');
  assert.deepEqual(mergeOperation(ready,{id:'remote',done:false}),ready);
  assert.equal(mergeOperation(job,{id:'remote',done:true,error:{code:'CANCELLED',message:'cancelled'}}).status,'cancelled');
});
