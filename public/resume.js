import {$,api,esc,uid} from './ui.js';

// Keep an emergency copy until the local server acknowledges the exact edit.
const prefix='atlas-recovery-v1/',writer=uid();
const db=new Promise(resolve=>{try{const r=indexedDB.open('atlas-creation-recovery',1);
 r.onupgradeneeded=()=>r.result.createObjectStore('edits');
 r.onsuccess=()=>resolve(r.result);r.onerror=()=>resolve(null);
}catch{resolve(null)}});
async function transaction(fn){const d=await db;if(!d)return null;return new Promise(resolve=>{try{const tx=d.transaction('edits','readwrite');const r=fn(tx.objectStore('edits'));tx.oncomplete=()=>resolve(r?.result??true);tx.onerror=tx.onabort=()=>resolve(null)}catch{resolve(null)}})}
const versions=new Map();
export function journal(p){
 p.editToken=uid();p.lastWriter=writer;
 const key=prefix+writer+'/'+p.id;versions.set(key,p.editToken);
 // Small edits are durable in the same input event, including tab-close races.
 const entry={key,project:p};
 try{const json=JSON.stringify(entry);if(json.length<1800000){localStorage.setItem(key,json);return}}catch{}
 const copy=structuredClone(entry);
 transaction(s=>s.put(copy,key));
 // A smaller previous edit may have used localStorage.
 try{localStorage.removeItem(key)}catch{}
}
async function clear(key){try{localStorage.removeItem(key)}catch{}await transaction(s=>s.delete(key))}
export function acknowledged(p,token){
 const key=prefix+writer+'/'+p.id;
 if(versions.get(key)!==token)return;
 versions.delete(key);clear(key);
 // Entries from an earlier process are removed only after a successful save.
 for(const k of inherited.get(p.id)||[])clear(k);inherited.delete(p.id);
}
const inherited=new Map();
export async function recover(projects){
 const entries=new Map();
 for(const item of (await transaction(s=>s.getAll())||[]))entries.set(item.key,item);
 try{for(const k of Object.keys(localStorage)){if(k.startsWith(prefix)){const item=JSON.parse(localStorage.getItem(k));entries.set(k,item)}}}catch{}
 const changed=[];
 for(const [key,{project:draft}] of entries){
  if(!draft?.scene || !draft?.id)continue;
  const idx=projects.findIndex(p=>p.id===draft.id);const disk=projects[idx];
  if(disk?.editToken===draft.editToken){await clear(key);continue}
  if(!disk){projects.push(draft)}
  else if(draft.revision===disk.revision || disk.lastWriter===draft.lastWriter){
   if(disk.lastWriter===draft.lastWriter && (disk.editNumber||0)>(draft.editNumber||0)){await clear(key);continue}
   draft.revision=disk.revision;projects[idx]=draft
  }else{draft.id=uid();draft.revision=0;draft.name+=' · 恢复副本';projects.push(draft)}
  inherited.set(draft.id,[...(inherited.get(draft.id)||[]),key]);changed.push(draft)
 }
 return changed;
}

export async function openCheckpoints({project,showDialog,updateProject,chooseCopy,notify}){
 const url='/api/projects/'+project.id+'/checkpoints';
 const rows=await api(url);
 const time=s=>new Date(s).toLocaleString('zh-CN',{hour12:false});
 const list=rows.map(r=>'<div class="checkpoint-row"><div><strong>'+esc(r.name)+'</strong><small>'+esc(time(r.createdAt))+'</small></div><button class="secondary small" data-resume-point="'+esc(r.id)+'">从此继续</button></div>').join('');
 showDialog('创作检查点','<p class="note">保存当前场景、机位、素材和生成草稿。从检查点继续会创建一个项目副本。</p><form id="checkpoint-form"><label class="field">检查点名称<input id="checkpoint-name" required maxlength="90" placeholder="例如：中庭光照定稿"></label><button class="primary" type="submit">保存检查点</button></form><div class="divider"></div><div id="checkpoint-list">'+(list||'<p class="empty">还没有命名检查点。</p>')+'</div><div id="checkpoint-error" role="status" class="control-error"></div>');
 $('#checkpoint-form').onsubmit=async e=>{e.preventDefault();const name=$('#checkpoint-name').value.trim();if(!name)return;e.submitter.disabled=true;try{await api(url,'POST',{name,project});notify('检查点已保存');await openCheckpoints({project,showDialog,updateProject,chooseCopy,notify})}catch(err){$('#checkpoint-error').textContent=err.message;e.submitter.disabled=false}};
 $('#checkpoint-list').onclick=async e=>{const btn=e.target.closest('[data-resume-point]');if(!btn)return;btn.disabled=true;try{const record=await api(url+'/'+btn.dataset.resumePoint);chooseCopy(record.project,record.meta.name);$('#dialog').close();notify('已从检查点打开项目副本')}catch(err){$('#checkpoint-error').textContent=err.message;btn.disabled=false}}
}

