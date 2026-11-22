const fs=require('node:fs/promises');
const path=require('node:path');
const originalFetch=globalThis.fetch;
const root=process.env.ATLAS_DATA_DIR;
const roof={name:'测试坡屋顶',geometry:'ExtrudeGeometry',position:[0,3,0],size:[6,1.2,4],rotation:[0,0,0],color:'#ac7645',profile:[[-1,0],[1,0],[0,1]]};
globalThis.fetch=async(url,options)=>{
 const host=new URL(url).hostname;
 const keys={'api.deepseek.com':'fixture-model','ws-smoke.cn-beijing.maas.aliyuncs.com':'fixture-wan','api.minimax.cn':'fixture-minimax'};
 if(!Object.hasOwn(keys,host))return originalFetch(url,options);
 if(options.headers.Authorization!=='Bearer '+keys[host])throw Error('测试仅允许该服务的模拟凭据');
 const body=JSON.parse(options.body),content=body.messages[1].content;
 const input=JSON.parse(Array.isArray(content)?content.find(c=>c.type==='text').text:content);
 const image=Array.isArray(content)&&content.find(c=>c.type==='image_url')?.image_url;
 const imageHash=image?require('node:crypto').createHash('sha256').update(image.url).digest('hex'):null;
 await fs.appendFile(path.join(root,'chat-requests.jsonl'),JSON.stringify({host,model:body.model,input,imageHash,detail:image?.detail,fine:body.messages[0].content.includes('精细建模。')})+'\n');
 if(input.request==='等待时手动改色'){
  for(let i=0;i<300;i++){
   try{await fs.access(path.join(root,'reply-now'));break}catch{await new Promise(ok=>setTimeout(ok,100))}
  }
 }
 const model=input.previous?structuredClone(input.previous):{name:'文字生成木亭',parts:[roof]};
 if(input.previous)model.parts[0].size[1]=1.8;
 if(input.request==='模拟坏面'||input.request==='模拟全坏网格'){
  const triangles=input.request==='模拟坏面'?[[0,1,2],[0,2,10]]:[[0,2,10]];
  model.parts=[{...roof,geometry:'BufferGeometry',vertices:[[0,0,0],[1,0,0],[0,1,0]],triangles}];
 }
 return Response.json({model:body.model,choices:[{finish_reason:'stop',message:{content:JSON.stringify(model)}}]});
};

