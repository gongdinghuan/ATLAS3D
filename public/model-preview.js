import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { PLYLoader } from 'three/addons/loaders/PLYLoader.js';

const decoder = new TextDecoder();

function assetFormat(asset, bytes) {
  if (decoder.decode(bytes.subarray(0,4)) === 'glTF') return 'glb';
  if (decoder.decode(bytes.subarray(0,3)) === 'ply') return 'ply';
  for (const value of [asset.name, asset.url, asset.type]) {
    const ext = value?.split(/[?#]/,1)[0].match(/(?:\.|\/|-|^)(glb|spz|splat|ksplat|ply)$/i);
    if (ext) return ext[1].toLowerCase();
  }
  if (asset.type === 'model/gltf-binary') return 'glb';
  throw new Error('无法识别模型格式。支持 GLB、SPZ、PLY、SPLAT 和 KSPLAT。');
}

function disposeMesh(root) {
  const resources = new Set();
  const images = new Set();
  root.traverse(node => {
    if (node.geometry) resources.add(node.geometry);
    if (node.skeleton) resources.add(node.skeleton);
    const materials = Array.isArray(node.material) ? node.material : [node.material];
    for (const material of materials.filter(Boolean)) {
      resources.add(material);
      for (const value of Object.values(material)) {
        if (value?.isTexture) {
          resources.add(value);
          if (value.source?.data?.close) images.add(value.source.data);
        }
      }
    }
  });
  for (const resource of resources) resource.dispose();
  for (const bitmap of images) bitmap.close();
}

async function readModel(asset, renderer, manager, signal) {
  const response = await fetch(asset.url,{signal,credentials:'same-origin'});
  if (!response.ok) throw new Error('素材读取失败（HTTP ' + response.status + '）。');
  const buffer = await response.arrayBuffer();
  signal.throwIfAborted();
  const bytes = new Uint8Array(buffer);
  const format = assetFormat(asset,bytes);
  let model;
  if (format === 'glb') {
    const loader = new GLTFLoader(manager);
    const [{DRACOLoader}, {KTX2Loader}, {MeshoptDecoder}] = await Promise.all([
      import('three/addons/loaders/DRACOLoader.js'), import('three/addons/loaders/KTX2Loader.js'),
      import('three/addons/libs/meshopt_decoder.module.js')
    ]);
    signal.throwIfAborted();
    const draco = new DRACOLoader(manager).setDecoderPath('/vendor/three/examples/jsm/libs/draco/gltf/');
    const ktx2 = new KTX2Loader(manager).setTranscoderPath('/vendor/three/examples/jsm/libs/basis/');
    try {
      loader.setDRACOLoader(draco).setKTX2Loader(ktx2.detectSupport(renderer)).setMeshoptDecoder(MeshoptDecoder);
      const base = new URL(response.url || asset.url,document.baseURI);
      const directory = /^https?:$/.test(base.protocol) ? new URL('.',base).href : document.baseURI;
      model = (await loader.parseAsync(buffer,directory)).scene;
    } finally {
      draco.dispose();
      ktx2.dispose();
    }
  } else if (format === 'ply' && !/property\s+\w+\s+(?:scale_0|f_dc_0|packed_position)\b/.test(
      decoder.decode(bytes.subarray(0,65536)).split('end_header',1)[0])) {
    const geometry = new PLYLoader().parse(buffer);
    geometry.computeBoundingSphere();
    const vertexColors = geometry.hasAttribute('color');
    if (geometry.index) {
      if (!geometry.hasAttribute('normal')) geometry.computeVertexNormals();
      model = new THREE.Mesh(geometry,new THREE.MeshStandardMaterial({vertexColors,side:THREE.DoubleSide}));
    } else {
      const size = Math.max(geometry.boundingSphere.radius * 0.012,0.0001);
      model = new THREE.Points(geometry,new THREE.PointsMaterial({size,vertexColors}));
    }
  } else {
    const {SplatMesh, SparkRenderer} = await import('@sparkjsdev/spark');
    signal.throwIfAborted();
    const mesh = new SplatMesh({fileBytes:bytes,fileType:format,fileName:asset.name,raycastable:false});
    let spark;
    try {
      await mesh.initialized;
      signal.throwIfAborted();
      let box = mesh.getBoundingBox();
      if (!box.isEmpty() && box.min.equals(box.max)) box = mesh.getBoundingBox(false);
      spark = new SparkRenderer({renderer});
      const group = new THREE.Group();
      group.add(mesh,spark);
      return {root:group,box,dispose() { mesh.dispose(); spark.dispose(); }};
    } catch (error) {
      mesh.dispose();
      spark?.dispose();
      throw error;
    }
  }
  const box = new THREE.Box3().setFromObject(model);
  return {root:model,box,dispose() { disposeMesh(model); }};
}

function makeTools() {
  const bar = document.createElement('div');
  bar.style.cssText = 'position:absolute;bottom:8px;left:8px;right:8px;display:flex;align-items:center;flex-wrap:wrap;gap:5px 10px;padding:6px 8px;background:#192225ed;border-radius:6px;font-size:12px;color:#e6eeeb';
  function slider(title,min,max,value) {
    const label = document.createElement('label');
    label.style.cssText = 'display:inline-flex;align-items:center;gap:4px;white-space:nowrap';
    label.append(title);
    const input = document.createElement('input');
    input.type = 'range';
    Object.assign(input,{min,max,value});
    input.style.cssText = 'width:66px;accent-color:#9be4c8';
    label.append(input);
    bar.append(label);
    return input;
  }
  function button(label) {
    const element = document.createElement('button');
    element.textContent = label;
    element.type = 'button';
    element.className = 'secondary small';
    element.disabled = true;
    bar.append(element);
    return element;
  }
  const brightness = slider('本地亮度',25,200,100);
  const hue = slider('色调',-180,180,0);
  const fit = button('适应视图');
  const save = button('导出调色 PNG');
  save.dataset.export = '';
  return {bar,brightness,hue,fit,save};
}

export async function mountModelPreview(host,asset) {
  const controller = new AbortController();
  const {signal} = controller;
  const manager = new THREE.LoadingManager();
  host.classList.add('model-stage');
  const status = document.createElement('div');
  status.className = 'empty';
  status.setAttribute('role','status');
  status.textContent = '正在读取模型…';
  const tools = makeTools();
  host.replaceChildren(status,tools.bar);
  let renderer, controls, observer, loaded;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#192125');
  const camera = new THREE.PerspectiveCamera(45,1,0.01,1000);
  const dialog = host.closest('dialog');

  function release() {
    observer?.disconnect();
    renderer?.setAnimationLoop(null);
    controls?.dispose();
    loaded?.dispose();
    loaded = null;
    scene.clear();
    renderer?.dispose();
    renderer?.forceContextLoss();
    renderer?.domElement.remove();
    renderer = null;
  }
  function destroy() {
    if (signal.aborted) return;
    controller.abort();
    manager.abort?.();
    release();
    status.remove();
    tools.bar.remove();
  }
  dialog?.addEventListener('close',destroy,{signal,once:true});
  function resize() {
    const width = Math.max(host.clientWidth,1);
    const height = Math.max(host.clientHeight,1);
    renderer.setSize(width,height,false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  }
  function fit() {
    const sphere = loaded.box.getBoundingSphere(new THREE.Sphere());
    if (loaded.box.isEmpty() || !Number.isFinite(sphere.radius)) throw new Error('模型缺少有效的几何范围。');
    const radius = Math.max(sphere.radius,0.001);
    const vertical = THREE.MathUtils.degToRad(camera.fov/2);
    const horizontal = Math.atan(Math.tan(vertical)*camera.aspect);
    const distance = 1.12*radius / Math.sin(Math.min(vertical,horizontal));
    camera.near = radius/1000;
    camera.far = Math.max(radius*200,distance*4);
    camera.updateProjectionMatrix();
    controls.target.copy(sphere.center);
    camera.position.set(.8,.52,1.4).normalize().multiplyScalar(distance).add(sphere.center);
    controls.minDistance = radius/100;
    controls.maxDistance = Math.max(radius*60,distance*2);
    controls.update();
  }
  function colorFilter() {
    return 'brightness(' + tools.brightness.value + '%) hue-rotate(' + tools.hue.value + 'deg)';
  }
  async function savePng() {
    try {
      renderer.render(scene,camera);
      const source = renderer.domElement;
      const canvas = document.createElement('canvas');
      canvas.width = source.width;
      canvas.height = source.height;
      const context = canvas.getContext('2d');
      context.filter = colorFilter();
      context.drawImage(source,0,0);
      const blob = await new Promise(resolve => canvas.toBlob(resolve,'image/png'));
      if (signal.aborted) return;
      if (!blob) throw new Error('PNG 编码失败。');
      const href = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = href;
      link.download = (asset.name || '模型').replace(/\.[^.]+$/,'') + '-本地调色.png';
      link.click();
      setTimeout(()=>URL.revokeObjectURL(href),1000);
    } catch {
      status.hidden = false;
      status.textContent = 'PNG 导出失败，请确认素材允许跨域读取后重试。';
    }
  }
  async function load() {
    try {
      renderer = new THREE.WebGLRenderer({antialias:true});
      renderer.setPixelRatio(Math.min(window.devicePixelRatio,2));
      host.prepend(renderer.domElement);
      renderer.domElement.style.cssText = 'display:block;width:100%;height:100%;touch-action:none';
      renderer.domElement.setAttribute('aria-label','三维模型，拖动旋转、右键平移、滚轮缩放');
      controls = new OrbitControls(camera,renderer.domElement);
      controls.enableDamping = true;
      scene.add(new THREE.HemisphereLight(0xfff5e4,0xb3c2d3,1.9));
      const light = new THREE.DirectionalLight(0xfff8e8,2.2);
      light.position.set(3,5,4);
      scene.add(light);
      resize();
      observer = new ResizeObserver(resize);
      observer.observe(host);
      const resource = await readModel(asset,renderer,manager,signal);
      if (signal.aborted) { resource.dispose(); return; }
      loaded = resource;
      scene.add(loaded.root);
      fit();
      function updateColor() { renderer.domElement.style.filter = colorFilter(); }
      tools.hue.addEventListener('input',updateColor,{signal});
      tools.brightness.addEventListener('input',updateColor,{signal});
      tools.fit.addEventListener('click',fit,{signal});
      tools.save.addEventListener('click',savePng,{signal});
      tools.fit.disabled = false;
      tools.save.disabled = false;
      status.hidden = true;
      renderer.setAnimationLoop(()=>{ controls.update(); renderer.render(scene,camera); });
    } catch (error) {
      if (signal.aborted) return;
      release();
      tools.bar.hidden = true;
      tools.bar.style.display = 'none';
      status.hidden = false;
      status.textContent = '模型预览失败。' + (error?.message || '请检查文件格式与 WebGL 2 支持。');
    }
  }
  void load();
  return {destroy};
}
