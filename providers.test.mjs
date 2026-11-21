import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { handleProvider } from './providers.mjs';

const atlas = 'https://api.atlas.worldlabs.ai/api/v2';
const keys = ['ATLAS_API_KEY', 'WLT_API_KEY', 'IMAGES_API_KEY', 'OPENAI_API_KEY','MESHY_API_KEY',
  'IMAGES_BASE_URL', 'OPENAI_BASE_URL', 'IMAGES_MODEL', 'OPENAI_IMAGE_MODEL'];
const originals = new Map(keys.map(key => [key, process.env[key]]));
const nativeFetch = globalThis.fetch;
let calls;
let replies;
beforeEach(() => {
  for (const key of keys) delete process.env[key];
  process.env.ATLAS_API_KEY = 'test-atlas-key';
  process.env.IMAGES_API_KEY = 'test-images-key';
  calls = [];
  replies = [];
  globalThis.fetch = async (url, options) => {
    calls.push({url: String(url), ...options, headers: new Headers(options.headers)});
    assert.ok(replies.length, 'unexpected network request');
    return replies.shift();
  };
});
afterEach(() => {
  globalThis.fetch = nativeFetch;
  for (const [key, value] of originals) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});
const pending = {id:'op_a', done:false, error:null, response:null, metadata:{state:'QUEUED'}};
test('Meshy image-to-3D polls the original provider and returns a GLB',async()=>{
  process.env.MESHY_API_KEY='test-meshy-key';
  replies.push(Response.json({result:'m01'}),Response.json({status:'IN_PROGRESS',progress:50}),Response.json({status:'SUCCEEDED',model_urls:{glb:'https://example.org/a.glb'}}));
  const op=await handleProvider('POST','/api/tasks',{provider:'meshy',task:'meshyImageTo3D',input:{image_url:'https://example.org/p.png'}});
  assert.equal(calls[0].url,'https://api.meshy.ai/openapi/v1/image-to-3d');
  assert.equal(calls[0].headers.get('Authorization'),'Bearer test-meshy-key');
  assert.deepEqual(JSON.parse(calls[0].body).target_formats,['glb']);
  const path='/api/operations/'+op.id;
  assert.equal((await handleProvider('GET',path)).done,false);
  assert.equal((await handleProvider('GET',path)).response.mesh.url,'https://example.org/a.glb');
  await assert.rejects(handleProvider('DELETE',path),{status:405});
  assert.equal(calls.length,3);
});
const frame = {imageAsset:{assetId:'asset_rgb'}};
const camera = {extrinsics:{position:[0,0,0],quaternion:[0,0,0,1],coordinateSystem:'rub'},
  intrinsics:{width:1280,height:720,fx:800,fy:800,cx:640,cy:360}};
const posed = {...frame, camera, depth:{depthAsset:{assetId:'asset_z'}}};
const second = {...posed, camera:{...camera, extrinsics:{...camera.extrinsics,position:[1,0,0]}}};
const inputs = {
  atlasTextToImage:{prompt:'A courtyard', aspectRatio:'16:9', numSamples:2},
  images2PosedRGBD:{frames:[frame], targetResolution:[1280,720]},
  atlasGenerate:{contextFrames:[posed], targetCameras:[camera]},
  atlasChisel:{prompt:'Library', targetFrames:[{camera}]},
  posedImages2Splats:{posedFrames:[posed,second]},
  splats2Mesh:{splatAsset:{assetId:'asset_splat'}, textureMode:'vertex_color'}
};

test('capabilities reflect environment credentials without exposing them', async () => {
  delete process.env.IMAGES_API_KEY;
  const {providers} = await handleProvider('GET','/api/providers');
  assert.equal(providers.find(p=>p.id==='images').configured,false);
  const provider = providers.find(p=>p.id==='atlas');
  assert.equal(provider.configured,true);
  assert.deepEqual([...provider.tasks].sort(),Object.keys(inputs).sort());
  assert.doesNotMatch(JSON.stringify(providers),/test-atlas-key/);
  await assert.rejects(handleProvider('POST','/api/tasks',{provider:'images',task:'atlasTextToImage',input:{prompt:'city'}}), {status:503});
  assert.equal(calls.length,0);
});

test('every Atlas task sends the native input unchanged with a caller-stable submission key', async () => {
  for (const [task,input] of Object.entries(inputs)) {
    replies.push(Response.json(pending));
    const op = await handleProvider('POST','/api/tasks',{provider:'atlas',task,input,requestId:'my-request',baseUrl:'https://ignored.invalid'});
    assert.deepEqual(op,pending);
    const request = calls.at(-1);
    assert.equal(request.url, atlas+'/tasks:'+task);
    assert.equal(request.method,'POST');
    assert.equal(request.headers.get('WLT-Api-Key'),'test-atlas-key');
    assert.equal(request.headers.get('Idempotency-Key'),'my-request');
    assert.deepEqual(JSON.parse(request.body),input);
    assert.equal(request.redirect,'error');
  }
});

test('poll preserves task failures and cancel requests can safely be repeated', async () => {
  const failure = {...pending, done:true, error:{code:1,message:'Cancelled'}};
  replies.push(Response.json(pending),Response.json(pending),Response.json(failure));
  await handleProvider('DELETE','/api/operations/op_a');
  await handleProvider('DELETE','/api/operations/op_a');
  assert.equal(calls[0].url,atlas+'/operations/op_a:cancel');
  assert.equal(calls[0].method,'POST');
  const {requestId} = JSON.parse(calls[0].body);
  assert.ok(requestId.length>0 && requestId.length<=36);
  assert.deepEqual(JSON.parse(calls[1].body),{requestId});
  assert.deepEqual(await handleProvider('GET','/api/operations/op_a'),failure);
  assert.equal(calls[2].url,atlas+'/operations/op_a');
  assert.equal(calls[2].method,'GET');
});

test('small assets include MIME and fresh read URLs are minted on demand', async () => {
  replies.push(Response.json({id:'asset_a',state:'READY',mimeType:'application/octet-stream'}));
  const result = await handleProvider('POST','/api/assets',{fileName:'scene.spz',mimeType:'application/octet-stream',base64:'YWJj'});
  assert.equal(result.assetId,'asset_a');
  assert.deepEqual(JSON.parse(calls[0].body),{asset:{displayName:'scene.spz',base64:'data:application/octet-stream;base64,YWJj'}});
  for (const suffix of ['one','two']) {
    const url = 'https://storage.example/asset?sig='+suffix;
    replies.push(Response.json({readUrl:url,expiresAt:'2026-11-20T10:00:00Z'}));
    assert.equal((await handleProvider('GET','/api/assets/asset_a/url')).url,url);
    assert.equal(calls.at(-1).url,atlas+'/assets/asset_a:createReadUrl');
  }
});

test('at the inline limit the bytes go to a signed URL without API credentials', async () => {
  const bytes = Buffer.alloc(10*1024*1024,11);
  const uploadUrl = 'https://storage.example/put?grant=example';
  replies.push(Response.json({id:'asset_a',state:'CREATED'}),
    Response.json({uploadUrl,method:'PUT',headers:{'content-type':'application/octet-stream','x-goog-meta-test':'yes'}}),
    new Response(null,{status:200}),Response.json({id:'asset_a',state:'READY'}));
  assert.equal((await handleProvider('POST','/api/assets',{fileName:'scene.spz',mimeType:'application/octet-stream',base64:bytes.toString('base64')})).assetId,'asset_a');
  assert.deepEqual(JSON.parse(calls[0].body),{asset:{displayName:'scene.spz'}});
  assert.equal(calls[1].url,atlas+'/assets/asset_a:createUploadUrl');
  assert.deepEqual(JSON.parse(calls[1].body),{contentType:'application/octet-stream',contentLength:10485760});
  assert.equal(calls[2].url,uploadUrl);
  assert.equal(calls[2].method,'PUT');
  assert.equal(calls[2].headers.get('x-goog-meta-test'),'yes');
  assert.equal(calls[2].headers.has('wlt-api-key'),false);
  assert.equal(calls[2].headers.has('authorization'),false);
  assert.deepEqual(calls[2].body,bytes);
  assert.equal(calls[3].url,atlas+'/assets/asset_a:completeUpload');
});

test('schema and billing errors preserve actionable details and never echo credentials', async () => {
  replies.push(Response.json({detail:[{loc:['body','frames'],msg:'Field required',input:{secret:'test-atlas-key'}}]},{status:422}),
    Response.json({code:'CREDITS_UNAVAILABLE',detail:'Balance exhausted for test-atlas-key'},{status:402}));
  for (const [status,pattern] of [[422,/frames/],[402,/CREDITS_UNAVAILABLE/]]) {
    await assert.rejects(handleProvider('POST','/api/tasks',{provider:'atlas',task:'atlasChisel',input:{prompt:'room'}}),e=>{
      assert.equal(e.status,status);
      assert.match(e.message,pattern);
      assert.doesNotMatch(e.message,/test-atlas-key/);
      return true;
    });
  }
});

test('unsupported tasks, unsafe IDs, and malformed uploads never contact a provider', async () => {
  await assert.rejects(handleProvider('POST','/api/tasks',{provider:'atlas',task:'../arbitrary',input:{}}));
  await assert.rejects(handleProvider('GET','/api/operations/%2e%2e'));
  await assert.rejects(handleProvider('POST','/api/assets',{fileName:'bad.spz',mimeType:'application/octet-stream',base64:'!abc'}),{status:400});
  assert.equal(calls.length,0);
});

test('Images sends only generation parameters to the configured server and normalizes URL and base64 output', async () => {
  process.env.IMAGES_BASE_URL = 'http://127.0.0.1:3001/v1/';
  process.env.IMAGES_MODEL = 'studio-default';
  const url = 'https://storage.example/image.webp';
  replies.push(Response.json({data:[{url}]}),Response.json({output_format:'webp',data:[{b64_json:'YQ=='}]}));
  const submit = input => handleProvider('POST','/api/tasks',{provider:'images',task:'atlasTextToImage',input});
  const result = await submit({prompt:'city',baseUrl:'https://ignored.invalid'});
  assert.equal(calls[0].url,'http://127.0.0.1:3001/v1/images/generations');
  assert.equal(calls[0].headers.get('authorization'),'Bearer test-images-key');
  assert.deepEqual(JSON.parse(calls[0].body),{model:'studio-default',prompt:'city'});
  assert.equal(result.done,true);
  assert.equal(result.response.frames[0].imageAsset.url,url);
  const secondResult = await submit({prompt:'city',model:'override',size:'1536x1024',quality:'high',n:1});
  assert.deepEqual(JSON.parse(calls[1].body),{model:'override',prompt:'city',size:'1536x1024',quality:'high',n:1});
  assert.equal(secondResult.response.frames[0].imageAsset.url,'data:image/webp;base64,YQ==');
});
