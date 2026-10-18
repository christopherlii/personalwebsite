// Recordings remain in memory; only their transcript enters the editor.
export function createDictation({onState,onMessage,transcribe,
  getMedia=globalThis.navigator?.mediaDevices?.getUserMedia?.bind(globalThis.navigator.mediaDevices),
  Recorder=globalThis.MediaRecorder,maximumMilliseconds=120000}){
  let session=null;
  function finish(current,success){
    if(session!==current)return;
    session=null;clearTimeout(current.timer);current.controller.abort();
    if(current.recorder){
      current.recorder.ondataavailable=current.recorder.onstop=current.recorder.onerror=null;
      if(current.recorder.state!=='inactive')try{current.recorder.stop();}catch{}
    }
    current.stream?.getTracks().forEach(track=>track.stop());current.chunks=[];
    onState(current.owner,'idle');current.resolve(success);
  }
  function fail(current,message){if(session===current){onMessage(current.owner,message);finish(current,false);}}
  function cancel(){if(session)finish(session,false);}
  async function convert(current){
    if(session!==current)return;
    clearTimeout(current.timer);current.phase='transcribing';onState(current.owner,'transcribing');
    current.stream.getTracks().forEach(track=>track.stop());
    const audio=new Blob(current.chunks,{type:current.recorder.mimeType||current.chunks[0]?.type});current.chunks=[];
    if(!audio.size){fail(current,'No speech detected. Try again.');return;}
    current.timer=setTimeout(()=>fail(current,'Transcription timed out. Try again.'),45000);
    try{
      const {text}=await transcribe(audio,current.controller.signal);
      if(session!==current)return;
      if(typeof text!=='string'||!text.trim()){fail(current,'No speech detected. Try again.');return;}
      if(!current.editor.insertText(text.trim())){finish(current,false);return;}
      finish(current,true);
    }catch(error){if(session===current)fail(current,error.message||'Could not transcribe. Try again.');}
  }
  function stop(){
    const current=session;if(!current)return Promise.resolve(true);
    if(current.phase==='starting'){cancel();return Promise.resolve(true);}
    if(current.phase==='listening'){
      current.phase='transcribing';onState(current.owner,'transcribing');clearTimeout(current.timer);
      // The final data event precedes onstop.
      try{current.recorder.stop();}catch{fail(current,'Could not finish recording. Try again.');}
    }
    return current.done;
  }
  async function start(owner,editor){
    if(!editor)return;
    onMessage(owner,'');
    if(!Recorder||!getMedia){onMessage(owner,'Microphone recording is unavailable in this browser.');return;}
    const current={owner,editor,phase:'starting',chunks:[],bytes:0,controller:new AbortController()};
    current.done=new Promise(resolve=>current.resolve=resolve);session=current;onState(owner,'starting');
    current.timer=setTimeout(()=>fail(current,'Microphone access timed out. Allow it in your browser and try again.'),30000);
    try{
      const stream=await getMedia({audio:{echoCancellation:true,noiseSuppression:true},video:false});
      if(session!==current){stream.getTracks().forEach(track=>track.stop());return;}
      current.stream=stream;clearTimeout(current.timer);
      const mimeType=['audio/webm;codecs=opus','audio/mp4','audio/ogg;codecs=opus'].find(type=>Recorder.isTypeSupported(type));
      current.recorder=new Recorder(stream,{...(mimeType?{mimeType}:{}),audioBitsPerSecond:64000});
      current.recorder.ondataavailable=event=>{
        if(session!==current||!event.data.size)return;
        current.bytes+=event.data.size;
        if(current.bytes>2000000){fail(current,'This recording is too long. Try a shorter thought.');return;}
        current.chunks.push(event.data);
      };
      current.recorder.onstop=()=>{void convert(current);};
      current.recorder.onerror=()=>fail(current,'The microphone stopped. Try again.');
      current.recorder.start(1000);current.phase='listening';onState(owner,'listening');editor.focus();
      current.timer=setTimeout(()=>{void stop();},maximumMilliseconds);
    }catch(error){
      fail(current,error.name==='NotAllowedError'?'Microphone access was denied. Allow it in your browser, then try again.':error.name==='NotFoundError'?'No microphone is available.':'Could not start the microphone. Check its permission and try again.');
    }
  }
  return{get owner(){return session?.owner||null;},get phase(){return session?.phase||'idle';},stop,cancel,
    async toggle(owner,editor){if(session?.owner===owner)return stop();if(session&&!await stop())return;return start(owner,editor);}
  };
}
