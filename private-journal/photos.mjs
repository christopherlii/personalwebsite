import './public/vendor/marked.min.js';
import { photoReference } from './public/photo-links.js';
import { hex } from './auth.mjs';

export class PhotoError extends Error{constructor(status,message){super(message);this.status=status;}}
const fail=(status,message)=>{throw new PhotoError(status,message);};
const ids=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const maximum=1000000,publicRoot='https://christopherli.dev/journal/public/photos/';
export function imageInfo(bytes){
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),ascii=(from,to)=>String.fromCharCode(...bytes.subarray(from,to));
  if(bytes.length>=24&&ascii(1,4)==='PNG'&&bytes[0]===137&&ascii(12,16)==='IHDR')return{mime:'image/png',width:view.getUint32(16),height:view.getUint32(20)};
  if(bytes.length>=30&&ascii(0,4)==='RIFF'&&ascii(8,12)==='WEBP'){
    const type=ascii(12,16);
    if(type==='VP8X')return{mime:'image/webp',width:1+bytes[24]+(bytes[25]<<8)+(bytes[26]<<16),height:1+bytes[27]+(bytes[28]<<8)+(bytes[29]<<16)};
    if(type==='VP8 '&&ascii(23,26)==='\x9d\x01\x2a')return{mime:'image/webp',width:view.getUint16(26,true)&0x3fff,height:view.getUint16(28,true)&0x3fff};
    if(type==='VP8L'&&bytes[20]===47)return{mime:'image/webp',width:1+bytes[21]+((bytes[22]&63)<<8),height:1+(bytes[22]>>6)+(bytes[23]<<2)+((bytes[24]&15)<<10)};
  }
  if(bytes[0]===255&&bytes[1]===216){
    let at=2;
    while(at+4<bytes.length){
      if(bytes[at++]!==255)return null;while(bytes[at]===255)at++;const marker=bytes[at++];
      if(at+2>bytes.length)return null;
      if(marker===217||marker===218)break;const size=view.getUint16(at);if(size<2||at+size>bytes.length)return null;
      if([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker)&&size>=7)return{mime:'image/jpeg',width:view.getUint16(at+5),height:view.getUint16(at+3)};
      at+=size;
    }
  }
  return null;
}
async function readPhoto(request){
  const reader=request.body?.getReader();if(!reader)fail(400,'Choose a photo.');
  const chunks=[];let size=0;
  try{while(true){const {value,done}=await reader.read();if(done)break;size+=value.length;if(size>maximum){await reader.cancel();fail(413,'This photo is too large. Try a smaller image.');}chunks.push(value);}}
  finally{reader.releaseLock();}
  const data=new Uint8Array(size);let at=0;for(const chunk of chunks){data.set(chunk,at);at+=chunk.length;}return data;
}
const fields='id,mime,width,height,bytes,created_at';
export async function photoApi(request,env,path){
  const match=path.match(/^\/api\/photos\/([a-f0-9-]+)$/);if(!match||!ids.test(match[1]))return null;
  const id=match[1];
  if(['GET','HEAD'].includes(request.method)){
    const row=await env.JOURNAL_DB.prepare('SELECT mime,data FROM photos WHERE id=?').bind(id).first();
    if(!row)fail(404,'Photo not found.');return new Response(request.method==='HEAD'?null:new Uint8Array(row.data),{headers:{'Content-Type':row.mime,'Content-Disposition':'inline'}});
  }
  if(request.method==='PUT'){
    const data=await readPhoto(request),info=imageInfo(data);
    if(!info||info.mime!==request.headers.get('Content-Type')||!info.width||!info.height||info.width>4096||info.height>4096||info.width*info.height>12000000)fail(415,'Use a JPEG, PNG, or WebP photo.');
    const sha256=hex(new Uint8Array(await crypto.subtle.digest('SHA-256',data)));
    const existing=await env.JOURNAL_DB.prepare(`SELECT ${fields},sha256 FROM photos WHERE id=?`).bind(id).first();
    if(existing){if(existing.sha256!==sha256)fail(409,'This photo already exists.');const {sha256:hash,...photo}=existing;return Response.json({photo});}
    const photo=await env.JOURNAL_DB.prepare(`INSERT OR IGNORE INTO photos(id,mime,width,height,bytes,sha256,data,created_at) VALUES(?,?,?,?,?,?,?,?) RETURNING ${fields}`).bind(id,info.mime,info.width,info.height,data.length,sha256,data.buffer,new Date().toISOString()).first();
    if(!photo){const winner=await env.JOURNAL_DB.prepare(`SELECT ${fields},sha256 FROM photos WHERE id=?`).bind(id).first();if(winner.sha256!==sha256)fail(409,'This photo already exists.');const {sha256:hash,...saved}=winner;return Response.json({photo:saved});}
    return Response.json({photo},{status:201});
  }
  if(request.method==='DELETE'){
    const used=await env.JOURNAL_DB.prepare(`SELECT 1 AS used WHERE EXISTS(SELECT 1 FROM thoughts WHERE instr(body,?)>0)
      OR EXISTS(SELECT 1 FROM draft WHERE instr(body,?)>0)
      OR EXISTS(SELECT 1 FROM publications WHERE instr(draft,?)>0 OR instr(COALESCE(published,''),?)>0)`).bind(id,id,id,id).first();
    if(used)fail(409,'This photo is still used in your writing.');
    if(!await env.JOURNAL_DB.prepare('DELETE FROM photos WHERE id=? RETURNING id').bind(id).first())fail(404,'Photo not found.');return Response.json({ok:true});
  }
  fail(405,'Method not allowed.');
}
const parser=new globalThis.marked.Marked({gfm:true});
export async function publishPhotoLinks(body,env){
  const replacements=new Map(),needed=new Set();
  parser.walkTokens(parser.lexer(body),token=>{
    if(token.type!=='image')return;const photo=photoReference(token.href);if(!photo)return;
    needed.add(photo.id);replacements.set(token.raw,token.raw.replace(token.href,publicRoot+photo.id+`?width=${photo.width}&height=${photo.height}`));
  });
  const list=[...needed];
  for(let start=0;start<list.length;start+=80){const group=list.slice(start,start+80);const {results}=await env.JOURNAL_DB.prepare(`SELECT id FROM photos WHERE id IN (${group.map(()=>'?').join(',')})`).bind(...group).all();if(results.length!==group.length)fail(400,'A photo in this draft is unavailable.');}
  for(const [raw,published]of replacements)body=body.replaceAll(raw,published);return list.length?{body,photos:list}:{body};
}
export async function publicPhoto(request,env,path){
  const match=path.match(/^\/public\/photos\/([a-f0-9-]+)$/);if(!match||!ids.test(match[1]))return null;
  const row=await env.JOURNAL_DB.prepare(`SELECT mime,data FROM photos WHERE id=? AND EXISTS(
    SELECT 1 FROM publications p,json_each(p.published,'$.photos') j WHERE p.published IS NOT NULL AND j.value=?)`).bind(match[1],match[1]).first();
  if(!row)fail(404,'Photo not found.');return new Response(request.method==='HEAD'?null:new Uint8Array(row.data),{headers:{'Content-Type':row.mime,'Content-Disposition':'inline'}});
}
