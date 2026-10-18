export class TranscriptionError extends Error{constructor(status,message){super(message);this.status=status;}}
const fail=(status,message)=>{throw new TranscriptionError(status,message);};
export async function transcribe(request,env){
  if(!env.AI)fail(503,'Dictation is unavailable. Try again later.');
  const mime=(request.headers.get('Content-Type')||'').split(';')[0].trim();
  if(!['audio/webm','audio/mp4','audio/ogg','audio/wav','audio/x-wav'].includes(mime))fail(415,'This audio format is not supported.');
  const reader=request.body?.getReader();if(!reader)fail(400,'No audio was recorded.');
  let length=0;const chunks=[];
  try{while(true){const {value,done}=await reader.read();if(done)break;length+=value.length;if(length>2000000){await reader.cancel();fail(413,'This recording is too long. Try a shorter thought.');}chunks.push(value);}}
  finally{reader.releaseLock();}
  const bytes=new Uint8Array(length);let at=0;for(const chunk of chunks){bytes.set(chunk,at);at+=chunk.length;}
  const ascii=(from,to)=>String.fromCharCode(...bytes.subarray(from,to));
  const valid=length>=12&&(mime==='audio/webm'?bytes[0]===26&&bytes[1]===69&&bytes[2]===223&&bytes[3]===163:mime==='audio/ogg'?ascii(0,4)==='OggS':mime==='audio/mp4'?ascii(4,8)==='ftyp':ascii(0,4)==='RIFF'&&ascii(8,12)==='WAVE');
  if(!valid)fail(415,'This recording could not be read. Try again.');
  let binary='';for(let offset=0;offset<bytes.length;offset+=8192)binary+=String.fromCharCode(...bytes.subarray(offset,offset+8192));
  let result;
  try{result=await env.AI.run('@cf/openai/whisper-large-v3-turbo',{audio:btoa(binary),task:'transcribe',vad_filter:true,condition_on_previous_text:false});}
  catch{fail(502,'Could not transcribe. Try again.');}
  if(typeof result?.text!=='string'||result.text.length>20000)fail(502,'Could not transcribe. Try a shorter thought.');
  return Response.json({text:result.text.trim()});
}
