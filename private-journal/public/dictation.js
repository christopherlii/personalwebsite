// A live connection carries audio in memory. Interim words stay out of autosave.
export function createDictation({onState,onMessage,onUnavailable=()=>{},
  getMedia=globalThis.navigator?.mediaDevices?.getUserMedia?.bind(globalThis.navigator.mediaDevices),
  Recorder=globalThis.MediaRecorder,Socket=globalThis.WebSocket,url=globalThis.location?.href,maximumMilliseconds=120000}){
  let session=null;
  function clearPreview(current){current.preview='';current.editor.previewText?.('');}
  function finish(current,success){
    if(session!==current)return;
    session=null;clearTimeout(current.timer);clearTimeout(current.limitTimer);clearPreview(current);
    if(current.recorder){current.recorder.ondataavailable=current.recorder.onstop=current.recorder.onerror=null;if(current.recorder.state!=='inactive')try{current.recorder.stop();}catch{}}
    current.stream?.getTracks().forEach(track=>track.stop());
    if(current.socket){current.socket.onopen=current.socket.onmessage=current.socket.onclose=current.socket.onerror=null;try{current.socket.close(1000);}catch{}}
    onState(current.owner,'idle');current.resolve(success);
  }
  function fail(current,message){
    if(session!==current)return;
    // Keep words already visible if a connection fails before its last final.
    const provisional=current.preview;clearPreview(current);
    if(provisional)current.editor.insertText(provisional);
    onMessage(current.owner,message);finish(current,false);
  }
  function cancel(){if(session)finish(session,false);}
  function stop(){
    const current=session;if(!current)return Promise.resolve(true);
    if(current.phase==='starting'){cancel();return Promise.resolve(true);}
    if(current.phase==='listening'){
      current.phase='transcribing';onState(current.owner,'transcribing');clearTimeout(current.limitTimer);
      current.timer=setTimeout(()=>fail(current,'Dictation could not finish. Check the last phrase and try again.'),12000);
      try{current.recorder.stop();}catch{fail(current,'Could not finish dictation. Try again.');}
    }
    return current.done;
  }
  function receive(current,event){
    if(session!==current)return;
    let message;try{message=JSON.parse(event.data);}catch{fail(current,'Live dictation stopped. Try again.');return;}
    if(message.type==='error'){fail(current,message.error||'Live dictation stopped. Try again.');return;}
    if(message.type==='done'){
      if(current.preview){const text=current.preview;clearPreview(current);if(!current.editor.insertText(text)){finish(current,false);return;}current.finals++;}
      if(!current.finals){fail(current,'No speech detected. Try again.');return;}
      finish(current,true);return;
    }
    if(message.type!=='transcript')return;
    if(typeof message.text!=='string'||message.text.length>20000||!Number.isFinite(message.start)||!Number.isFinite(message.duration)){
      fail(current,'Live dictation stopped. Try again.');return;
    }
    if(message.start<current.committedUntil-.01)return;
    const text=message.text.trim(),key=`${message.start}:${message.duration}`;
    if(message.final){
      if(current.seen.has(key))return;current.seen.add(key);clearPreview(current);
      current.committedUntil=Math.max(current.committedUntil,message.start+message.duration);
      if(text){if(!current.editor.insertText(text)){finish(current,false);return;}current.finals++;}
    }else{
      current.preview=text;
      if(current.editor.previewText?.(text)===false)finish(current,false);
    }
  }
  function record(current){
    if(session!==current)return;
    clearTimeout(current.timer);
    try{
      const mimeType=['audio/webm;codecs=opus','audio/mp4','audio/ogg;codecs=opus'].find(type=>Recorder.isTypeSupported(type));
      current.recorder=new Recorder(current.stream,{...(mimeType?{mimeType}:{}),audioBitsPerSecond:64000});
      current.recorder.ondataavailable=event=>{
        if(session!==current||!event.data.size)return;
        current.bytes+=event.data.size;
        if(current.bytes>2000000||current.socket.bufferedAmount>524288){fail(current,'Dictation could not keep up. Check the last phrase and try again.');return;}
        try{current.socket.send(event.data);}catch{fail(current,'Live dictation disconnected. Try again.');}
      };
      current.recorder.onstop=()=>{
        current.stream.getTracks().forEach(track=>track.stop());
        if(session!==current)return;
        try{current.socket.send(JSON.stringify({type:'stop'}));}catch{fail(current,'Could not finish dictation. Try again.');}
      };
      current.recorder.onerror=()=>fail(current,'The microphone stopped. Try again.');
      current.recorder.start(250);current.phase='listening';onState(current.owner,'listening');current.editor.focus();
      current.limitTimer=setTimeout(()=>{void stop();},maximumMilliseconds);
    }catch{fail(current,'Could not start the microphone. Try again.');}
  }
  async function start(owner,editor){
    if(!editor)return;onMessage(owner,'');
    if(!Recorder||!Socket||!getMedia){onMessage(owner,'Microphone recording is unavailable in this browser.');return;}
    const current={owner,editor,phase:'starting',bytes:0,finals:0,preview:'',seen:new Set(),committedUntil:0};
    current.done=new Promise(resolve=>current.resolve=resolve);session=current;onState(owner,'starting');
    current.timer=setTimeout(()=>fail(current,'Dictation could not start. Check microphone permission and try again.'),30000);
    try{
      const stream=await getMedia({audio:{echoCancellation:true,noiseSuppression:true},video:false});
      if(session!==current){stream.getTracks().forEach(track=>track.stop());return;}
      current.stream=stream;const address=new URL('./api/dictation',url);address.protocol=address.protocol==='https:'?'wss:':'ws:';
      current.socket=new Socket(address.href);current.socket.onopen=()=>record(current);
      current.socket.onmessage=event=>receive(current,event);
      current.socket.onerror=()=>{fail(current,'Live dictation is unavailable. Try again.');onUnavailable();};
      current.socket.onclose=()=>fail(current,'Live dictation disconnected. Check the last phrase and try again.');
    }catch(error){fail(current,error.name==='NotAllowedError'?'Microphone access was denied. Allow it in your browser, then try again.':error.name==='NotFoundError'?'No microphone is available.':'Could not start live dictation. Try again.');}
  }
  return{get owner(){return session?.owner||null;},get phase(){return session?.phase||'idle';},stop,cancel,
    async toggle(owner,editor){if(session?.owner===owner)return stop();if(session&&!await stop())return;return start(owner,editor);}
  };
}
