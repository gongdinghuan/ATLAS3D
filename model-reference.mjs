import {open} from 'node:fs/promises';
import {join} from 'node:path';
import {fail} from './storage.mjs';

export async function inlineReference(mediaDirectory,reference){
 const match=typeof reference==='string'&&/^\/media\/([a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}\.(?:jpe?g|png|webp))$/i.exec(reference);
 if(!match||!mediaDirectory)throw fail(400,'请从本机项目选择一张 JPEG、PNG 或 WebP 参考图');
 let file;
 try{
  file=await open(join(mediaDirectory,match[1]),'r');
  const info=await file.stat();
  if(!info.isFile()||!info.size)throw fail(415,'参考图为空或无法读取');
  if(info.size>7*1024*1024)throw fail(413,'参考图过大，请重新选择图片以生成缩小版本');
  const data=await file.readFile();
  let mime;
  if(data.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex')))mime='image/png';
  else if(data.subarray(0,3).equals(Buffer.from('ffd8ff','hex')))mime='image/jpeg';
  else if(data.toString('ascii',0,4)==='RIFF'&&data.toString('ascii',8,12)==='WEBP')mime='image/webp';
  if(!mime)throw fail(415,'参考图内容不是 JPEG、PNG 或 WebP');
  return 'data:'+mime+';base64,'+data.toString('base64');
 }catch(e){
  if(e.code==='ENOENT')throw fail(404,'找不到参考图，请重新选择');
  throw e;
 }finally{await file?.close()}
}

