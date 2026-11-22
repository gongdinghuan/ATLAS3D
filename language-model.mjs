import {randomUUID} from 'node:crypto';
import {inlineReference} from './model-reference.mjs';
import {validWorkspace} from './domestic-providers.mjs';
import {fail} from './storage.mjs';
import {geometryTypes,validateModel} from './public/model-spec.js';

const jsonOptions={response_format:{type:'json_object'},max_tokens:8192};
const services={
 deepseek:{
  label:'DeepSeek',keyEnv:'DEEPSEEK_API_KEY',models:['deepseek-flash'],
  endpoint:()=>'https://api.deepseek.com/chat/completions',
  options:()=>({...jsonOptions,thinking:{type:'disabled'}})
 },
 qwen:{
  label:'通义千问',keyEnv:'DASHSCOPE_API_KEY',models:['qwen3-coder-flash','qwen-plus','qwen3-vl-plus'],
  endpoint:()=>validWorkspace(process.env.DASHSCOPE_WORKSPACE_ID)
   ?'https://'+process.env.DASHSCOPE_WORKSPACE_ID+'.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/chat/completions':null,
  options:model=>({...jsonOptions,...(['qwen-plus','qwen3-vl-plus'].includes(model)?{enable_thinking:false}:{})})
 },
 minimax:{
  label:'MiniMax',keyEnv:'MINIMAX_API_KEY',models:['MiniMax-M3.1-Flash','MiniMax-M3'],
  endpoint:()=>'https://api.minimax.cn/v1/chat/completions',
  options:model=>({reasoning_split:true,max_completion_tokens:16384,...(model==='MiniMax-M3.1-Flash'?{reasoning_effort:'medium'}:{})})
 }
};
export const isLanguageProvider=id=>Object.hasOwn(services,id);
export function languageProviders(){
 return Object.entries(services).map(([id,service])=>({id,label:service.label,tasks:['threeModel'],
  configured:Boolean(process.env[service.keyEnv]?.trim()&&service.endpoint())}));
}
const instructions=[
 '你是建筑和产品 Three.js 建模师。输出一个 JSON 对象，含 name 和 parts。把用户的自然语言要求转换为比例可信、可编辑的三维部件。单位为米，Y 轴向上，地面 y=0。',
 '每个构件字段为 name、geometry、position:[x,y,z]（中心）、size:[宽,高,深]（全部正数）、rotation:[rx,ry,rz]（XYZ 欧拉角，度）、color（#RRGGBB）。',
 '支持 Three.js 几何类型：'+geometryTypes.join('、')+'。Box、Cylinder、Cone、Sphere、Torus 都以构件中心定位，圆柱和圆锥轴向为 Y，圆环位于 XY。',
 'ExtrudeGeometry 提供 profile:[[x,y],...]，至少三个不同的点形成简单闭合轮廓，沿 Z 挤出。LatheGeometry 的 profile 为 [[非负半径,y],...]，以 Y 为轴旋转。每种几何均居中、缩放到 size，然后旋转、平移。',
 '自由曲面或不规则多面体可以使用 BufferGeometry，通过 vertices:[[x,y,z],...] 和 triangles:[[a,b,c],...] 给出顶点和从零开始的索引，正面按逆时针排列。每件最多 256 个顶点、512 个三角面。',
 '格式示例：{"name":"圆凳","parts":[{"name":"凳面","geometry":"CylinderGeometry","position":[0,0.45,0],"size":[0.4,0.06,0.4],"rotation":[0,0,0],"color":"#966e45"}]}。',
 '重复的栏杆、门窗、台阶可以用可选字段 repeat:{count:整数,step:[dx,dy,dz]} 表示线性阵列。展开后最多 96 个构件，每条轮廓最多 48 个点。为构件起简洁可辨的中文名称。',
 '新增模型放在原点附近，主体落地。用户给出现有模型时，在同一坐标系中返回修改后的完整模型，保留未提及的构件、位置和材质。请返回完整 JSON 数据。'
].join('\n');
export async function generateModel(provider,task,input,mediaDirectory){
 if(task!=='threeModel')throw fail(400,'语言模型只接受 Three.js 建模任务');
 const quality=input?.modelDetail??'standard';
 if(!['standard','fine'].includes(quality))throw fail(400,'请选择标准或精细建模');
 const fine=quality==='fine';
 const hasImage=input?.referenceImage!==undefined;
 const prompt=typeof input?.prompt==='string'?input.prompt.trim():'';
 if(!hasImage&&!prompt)throw fail(400,'请填写建模描述或选择参考图');
 if(prompt.length>6000)throw fail(400,'建模描述最多 6000 字');
 let previous;
 if(input.previous){try{previous=validateModel(input.previous)}catch(e){throw fail(400,'已有模型无法读取：'+e.message)}}
 const service=services[provider],key=process.env[service.keyEnv]?.trim(),url=service.endpoint();
 if(!key||!url)throw fail(503,'请先配置'+(provider==='qwen'?'阿里云百炼北京业务空间和 API Key':service.label+' API Key'));
 const model=input.model??(hasImage&&provider==='qwen'?'qwen3-vl-plus':service.models[0]);
 if(!service.models.includes(model))throw fail(400,'所选服务不支持此建模模型');
 if(hasImage&&provider==='qwen'&&model!=='qwen3-vl-plus')throw fail(400,'千问参考图建模请选择 Qwen3-VL-Plus');
 const request=prompt||'依据参考图建立可编辑的三维模型。';
 const text=JSON.stringify({request,...(previous?{previous}:{})});
 const contentBlocks=hasImage?[{type:'text',text},{type:'image_url',image_url:{url:await inlineReference(mediaDirectory,input.referenceImage),...(fine&&provider!=='qwen'?{detail:'high'}:{})}}]:text;
 const visualGuide='观察参考图中的主体、轮廓、构件连接、比例和材质，优先表达这些可辨认特征。按文字给出的实际尺寸建模，未给尺寸时估算。续改已有模型时，仅按用户要求调整。';
 const guides=[instructions,'挤出构件可指定 holes:[[[x,y],...],...] 表示贯穿开孔。所有孔在外轮廓内部且不相交，最多 12 个。'];
 if(hasImage)guides.push(visualGuide);
 if(fine)guides.push('精细建模。先校核主体的比例与结构连接，再用可独立编辑的构件表达看得见的檐口、窗框、栏杆或材质边界。窗洞使用 holes，通向边界的门洞用带凹口的外轮廓。重复构件用 repeat。依据主体选择有辨识度的细节，不必用完构件额度，保持原模型坐标。');
 const payload={model,...service.options(model),messages:[{role:'system',content:guides.join('\n')},{role:'user',content:contentBlocks}]};
 let response;
 try{response=await fetch(url,{method:'POST',headers:{Authorization:'Bearer '+key,'Content-Type':'application/json'},body:JSON.stringify(payload),redirect:'error',signal:AbortSignal.timeout(180000)})}
 catch{throw fail(502,'语言模型请求中断，请核对本地回执与供应商记录')}
 const body=await response.json().catch(()=>null);
 if(!response.ok)throw fail(response.status,'语言模型 HTTP '+response.status+' · '+String(body?.error?.message||'请求未成功').replaceAll(key,'[已隐藏]').slice(0,240));
 if(provider==='minimax'&&body?.base_resp?.status_code)throw fail(422,'MiniMax 服务错误 '+body.base_resp.status_code+' · '+String(body.base_resp.status_msg||'请求未成功').replaceAll(key,'[已隐藏]').slice(0,240));
 const choice=body?.choices?.[0];
 if(choice?.finish_reason==='length')throw fail(422,'模型输出超过长度限制，请将建模要求拆成较小的模型组');
 if(typeof choice?.message?.content!=='string'||!choice.message.content.trim())throw fail(422,'语言模型没有返回建模数据');
 let content=choice.message.content.trim();
 if(provider==='minimax'){
  const fenced=/^`{3}(?:json)?\s*\n([\s\S]+?)\n\s*`{3}$/i.exec(content);
  if(fenced)content=fenced[1];
 }
 let result;
 try{result=validateModel(JSON.parse(content))}catch(e){throw fail(422,'无法构建 Three.js 模型：'+(e instanceof SyntaxError?'输出不是完整 JSON':e.message))}
 return {id:'model_'+randomUUID(),done:true,response:{model:body.model||model,threeModel:result}};
}

