const paths={
 folder:'M3 6h7l2 2h9v11H3z',
 sliders:'M4 6h6m4 0h6M4 12h10m4 0h2M4 18h2m4 0h10M10 4v4m4 2v4m-6 2v4',
 spark:'m12 3 2.3 6.7L21 12l-6.7 2.3L12 21l-2.3-6.7L3 12l6.7-2.3Z',
 aperture:'M21 12a9 9 0 1 1-18 0 9 9 0 1 1 18 0Zm-12-8 5 8m5-7-5 8m7 1h-9m4 6-5-8m-5 6 5-8M4 9h9',
 cube:'m12 2 9 5v10l-9 5-9-5V7zm-9 5 9 5 9-5m-9 5v10',
 sun:'M16 12a4 4 0 1 1-8 0 4 4 0 1 1 8 0ZM12 2v3m0 14v3M2 12h3m14 0h3M5 5l2 2m10 10 2 2M5 19l2-2M17 7l2-2',
 mesh:'m12 2 9 17H3zM3 19l9-8 9 8M12 2v9m0 0v8',
 keyboard:'M2 6h20v13H2zM5 10h1m3 0h1m3 0h1m3 0h1M7 15h10',
 upload:'M12 16V3m-5 5 5-5 5 5M4 15v5h16v-5',
 download:'M12 3v13m-5-5 5 5 5-5M4 16v4h16v-4',
 grid:'M3 3h18v18H3zM9 3v18m6-18v18M3 9h18M3 15h18',
 focus:'M3 9V3h6m6 0h6v6m0 6v6h-6m-6 0H3v-6m12-3a3 3 0 1 1-6 0 3 3 0 1 1 6 0Z',
 expand:'M4 9V4h5m6 0h5v5m0 6v5h-5m-6 0H4v-5',
 film:'M3 5h18v14H3zM7 5v14m10-14v14M3 10h4m10 0h4M3 14h4m10 0h4',
 play:'m7 4 13 8-13 8z',image:'M3 4h18v16H3zM3 16l5-5 5 5 3-3 5 5m-6-10h1',
 camera:'M3 7h4l2-3h6l2 3h4v13H3zM15 13a3 3 0 1 1-6 0 3 3 0 1 1 6 0Z',
 file:'M5 3h9l5 5v13H5zM14 3v6h5',layers:'m12 3 9 5-9 5-9-5zm-9 9 9 5 9-5m-18 4 9 5 9-5',
 eye:'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zm13 0a3 3 0 1 1-6 0 3 3 0 1 1 6 0Z'
};
export const $=s=>document.querySelector(s);
export const esc=value=>String(value??'').replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
export function icons(root=document){for(const el of root.querySelectorAll('[data-icon]')){const path=paths[el.dataset.icon];if(path&&!el.firstChild)el.innerHTML='<svg aria-hidden="true" class="i" viewBox="0 0 24 24"><path d="'+path+'"/></svg>'}}
export async function api(url,method='GET',input) {
 const init={method};if(input!==undefined){init.headers={'content-type':'application/json'};init.body=JSON.stringify(input)}
 const r=await fetch(url,init);const data=await r.json();if(!r.ok)throw Object.assign(new Error(data.error?.message||data.error||'请求失败'),{status:r.status});return data;
}
export function download(name,source,type='application/octet-stream') {
 const object=source instanceof Blob?source:new Blob([source],{type});const link=document.createElement('a');link.href=URL.createObjectURL(object);link.download=name;link.click();setTimeout(()=>URL.revokeObjectURL(link.href),3000);
}
export function blobToData(blob){return new Promise((ok,no)=>{const r=new FileReader();r.onload=()=>ok(r.result);r.onerror=()=>no(r.error);r.readAsDataURL(blob)})}
export function safeAssetURL(url){if(typeof url!=='string')return '';if(/^\/media\/[a-f0-9-]{36}\.[a-z0-9]+$/i.test(url))return url;try{const u=new URL(url);if(['https:','http:'].includes(u.protocol)&&!u.username&&!u.password)return u.href}catch{}return ''}
export function kindOf(a){const mime=a.type||'',file=a.name?.toLowerCase()||'';if(mime.startsWith('image/')||mime==='image'||/\.(png|jpe?g|webp|avif|gif)$/.test(file))return'image';if(mime.startsWith('video/')||/\.(mp4|webm)$/.test(file))return'video';if(/\.(spz|ply|splat|ksplat|glb)$/.test(file)||['model','splat'].includes(mime))return'model';return'file'}
export function tweenCamera(a,b,t){const mix=(a,b)=>a+(b-a)*t;const yawDiff=((b.yaw-a.yaw+540)%360)-180;return {yaw:a.yaw+yawDiff*t,pitch:mix(a.pitch,b.pitch),distance:mix(a.distance,b.distance),target:a.target.map((v,i)=>mix(v,b.target[i]))}}
export function alongPath(frames,t){const pos=Math.max(0,Math.min(1,t))*(frames.length-1);const i=Math.floor(pos);return tweenCamera(frames[i].camera,frames[Math.min(i+1,frames.length-1)].camera,pos-i)}
export const uid=()=>crypto.randomUUID();

