import { TranscriptionError } from './transcription.mjs';

// One bounded stream, held only in the two socket connections. Never log audio.
export function bridgeDictation(client,upstream,{authorize,maximumMilliseconds=125000}={}){
  let closed=false,stopping=false,closeSent=false,bytes=0,header=false,flushTimer,finalizeTimer;
  const send=message=>{try{client.send(JSON.stringify(message));}catch{close();}};
  function close({error,done=false}={}){
    if(closed)return;closed=true;clearTimeout(timer);clearTimeout(flushTimer);clearTimeout(finalizeTimer);clearInterval(sessionCheck);
    try{if(error)client.send(JSON.stringify({type:'error',error}));else if(done)client.send(JSON.stringify({type:'done'}));}catch{}
    try{client.close(error?1011:1000);}catch{}try{upstream.close(1000);}catch{}
  }
  const timer=setTimeout(()=>close({error:'Dictation reached its time limit. Start it again to continue.'}),maximumMilliseconds);
  function endStream(){if(closed||closeSent)return;closeSent=true;clearTimeout(finalizeTimer);try{upstream.send(JSON.stringify({type:'CloseStream'}));}catch{close({error:'Could not finish dictation. Try again.'});}}
  const sessionCheck=authorize?setInterval(()=>{Promise.resolve().then(authorize).then(valid=>{if(!valid)close({error:'Your session ended. Unlock the journal to continue.'});}).catch(()=>close({error:'Live dictation is unavailable. Try again.'}));},15000):null;
  client.addEventListener('message',event=>{
    if(closed)return;
    try{
      if(typeof event.data==='string'){
        if(event.data.length>64||JSON.parse(event.data).type!=='stop'){close({error:'Invalid dictation request.'});return;}
        if(stopping)return;stopping=true;upstream.send(JSON.stringify({type:'Finalize'}));
        finalizeTimer=setTimeout(endStream,1500);
        flushTimer=setTimeout(()=>close({error:'Dictation could not finish. Check the last phrase and try again.'}),10000);return;
      }
      if(stopping)return;
      const data=event.data instanceof ArrayBuffer?new Uint8Array(event.data):ArrayBuffer.isView(event.data)?new Uint8Array(event.data.buffer,event.data.byteOffset,event.data.byteLength):null;
      if(!data){close({error:'This audio stream could not be read. Try again.'});return;}
      if(data.length>262144||(bytes+=data.length)>2000000){close({error:'This recording is too long. Start a new dictation.'});return;}
      if(!data.length)return;
      if(!header){
        const ascii=(from,to)=>String.fromCharCode(...data.subarray(from,to));
        header=data.length>=12&&((data[0]===26&&data[1]===69&&data[2]===223&&data[3]===163)||ascii(0,4)==='OggS'||ascii(4,8)==='ftyp');
        if(!header){close({error:'This recording format could not be read. Try again.'});return;}
      }
      upstream.send(event.data);
    }catch{close({error:'Live dictation disconnected. Try again.'});}
  });
  upstream.addEventListener('message',event=>{
    if(closed)return;
    try{
      if(typeof event.data!=='string'||event.data.length>131072)throw new Error();
      const result=JSON.parse(event.data);
      if(result.type==='Results'){
        const text=result.channel?.alternatives?.[0]?.transcript;
        if(typeof text!=='string'||text.length>20000||typeof result.is_final!=='boolean'||!Number.isFinite(result.start)||!Number.isFinite(result.duration)||result.start<0||result.duration<0)throw new Error();
        send({type:'transcript',text,final:result.is_final,start:result.start,duration:result.duration});
        if(stopping&&result.is_final&&result.from_finalize===true)endStream();
      }else if(result.type==='Metadata'&&stopping)close({done:true});
      else if(result.type==='Error')throw new Error();
    }catch{close({error:'Live dictation stopped. Check the last phrase and try again.'});}
  });
  client.addEventListener('close',()=>close());client.addEventListener('error',()=>close());
  upstream.addEventListener('close',event=>close(stopping&&event.code===1000?{done:true}:{error:'Live dictation disconnected. Check the last phrase and try again.'}));
  upstream.addEventListener('error',()=>close({error:'Live dictation is unavailable. Try again.'}));
  send({type:'ready'});return{close};
}

export async function liveDictation(request,env,authorize){
  if(!env.AI)throw new TranscriptionError(503,'Live dictation is unavailable. Try again later.');
  let response;
  try{response=await env.AI.run('@cf/deepgram/nova-3',{interim_results:'true',smart_format:'true',punctuate:'true',endpointing:'300',mip_opt_out:'true'},{websocket:true});}
  catch{throw new TranscriptionError(502,'Live dictation is unavailable. Try again.');}
  if(response.status!==101||!response.webSocket)throw new TranscriptionError(502,'Live dictation is unavailable. Try again.');
  const upstream=response.webSocket;upstream.binaryType='arraybuffer';upstream.accept();
  if(request.signal.aborted){upstream.close(1000);throw new TranscriptionError(400,'Dictation was canceled.');}
  const pair=new WebSocketPair();pair[1].binaryType='arraybuffer';pair[1].accept();bridgeDictation(pair[1],upstream,{authorize});
  return new Response(null,{status:101,webSocket:pair[0],headers:{'Cache-Control':'no-store'}});
}
