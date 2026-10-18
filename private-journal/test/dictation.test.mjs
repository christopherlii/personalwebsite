import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createDictation} from '../public/dictation.js';
class Socket{
 constructor(url){Socket.latest=this;this.url=url;this.bufferedAmount=0;this.sent=[];queueMicrotask(()=>this.onopen?.());}
 send(data){this.sent.push(data);if(typeof data==='string'&&this.autoFinish){this.result('the last phrase',2,1,true);this.emit({type:'done'});}}
 close(){this.closed=true;}
 emit(data){this.onmessage?.({data:JSON.stringify(data)});}
 result(text,start=0,duration=1,final=false){this.emit({type:'transcript',text,start,duration,final});}
}
class Recorder{
 static isTypeSupported(type){return type.startsWith('audio/webm');}
 constructor(){Recorder.latest=this;this.state='inactive';}
 start(interval){this.interval=interval;this.state='recording';}
 stop(){this.state='inactive';queueMicrotask(()=>{this.ondataavailable?.({data:new Blob(['audio'])});this.onstop?.();});}
}
function setup(extra={}){
 const states=[],messages=[],inserted=[],previews=[],track={stopped:false,stop(){this.stopped=true;}};
 const controller=createDictation({Recorder,Socket,url:'https://journal.example/journal/',getMedia:async()=>({getTracks:()=>[track]}),onState:(...v)=>states.push(v),onMessage:(...v)=>messages.push(v),...extra});
 const editor={focus(){},insertText(text){inserted.push(text);return true;},previewText(text){previews.push(text);return true;}};
 return{controller,editor,states,messages,inserted,previews,track};
}
const tick=()=>new Promise(resolve=>setImmediate(resolve));
test('live interim words revise in place and final phrases enter once before stop',async()=>{
 const s=setup();assert.equal(s.controller.owner,null);await s.controller.toggle('composer',s.editor);const socket=Socket.latest;
 assert.equal(socket.url,'wss://journal.example/journal/api/dictation');assert.equal(Recorder.latest.interval,250);
 socket.result('some');socket.result('some words');assert.deepEqual(s.inserted,[]);assert.equal(s.previews.at(-1),'some words');
 socket.result('some words',0,1,true);socket.result('some words',0,1,true);socket.result('stale partial',0,.5,false);
 assert.deepEqual(s.inserted,['some words']);assert.equal(s.previews.at(-1),'');assert.equal(s.controller.phase,'listening');
 const done=s.controller.stop();assert.equal(s.controller.phase,'transcribing');await tick();assert.equal(JSON.parse(socket.sent.at(-1)).type,'stop');assert.equal(s.track.stopped,true);
 socket.result('last words',1,1,true);socket.emit({type:'done'});assert.equal(await done,true);assert.deepEqual(s.inserted,['some words','last words']);assert.equal(s.controller.owner,null);assert.equal(socket.closed,true);
});
test('cancel, late microphone grants, and late socket messages cannot edit a different note',async()=>{
 let media;const s=setup({getMedia:()=>new Promise(resolve=>media=resolve)});const pending=s.controller.toggle('composer',s.editor);s.controller.cancel();media({getTracks:()=>[s.track]});await pending;assert.equal(s.track.stopped,true);
 const t=setup();await t.controller.toggle('reader',t.editor);const socket=Socket.latest,late=socket.onmessage;socket.result('partial');const done=t.controller.stop();t.controller.cancel();assert.equal(await done,false);
 late({data:JSON.stringify({type:'transcript',text:'late words',start:1,duration:1,final:true})});assert.deepEqual(t.inserted,[]);assert.equal(t.previews.at(-1),'');assert.equal(t.track.stopped,true);
});
test('microphone denial and unsupported capture preserve typed text',async()=>{
 const s=setup({getMedia:async()=>{throw new DOMException('denied','NotAllowedError');}});await s.controller.toggle('composer',s.editor);assert.match(s.messages.at(-1)[1],/Microphone access was denied/);assert.equal(s.controller.owner,null);
 const u=setup({Recorder:null});await u.controller.toggle('composer',u.editor);assert.match(u.messages.at(-1)[1],/unavailable/);
});
test('a failed connection preserves visible interim words and stops a dependent save',async()=>{
 const s=setup();await s.controller.toggle('reader',s.editor);Socket.latest.result('words already visible');const done=s.controller.stop();Socket.latest.emit({type:'error',error:'Live dictation disconnected.'});
 assert.equal(await done,false);assert.deepEqual(s.inserted,['words already visible']);assert.equal(s.track.stopped,true);assert.equal(s.previews.at(-1),'');assert.match(s.messages.at(-1)[1],/disconnected/);
});
test('silence, limits, and slow connections stop without an overflow',async()=>{
 const s=setup();await s.controller.toggle('composer',s.editor);const done=s.controller.stop();Socket.latest.emit({type:'done'});assert.equal(await done,false);assert.match(s.messages.at(-1)[1],/No speech/);
 const t=setup();await t.controller.toggle('reader',{focus(){},previewText(){return false;},insertText(){return false;}});Socket.latest.result('overflow');assert.equal(t.controller.owner,null);
 const u=setup();await u.controller.toggle('composer',u.editor);Recorder.latest.ondataavailable({data:new Blob([new Uint8Array(2000001)])});assert.equal(u.controller.owner,null);assert.equal(u.track.stopped,true);
 const v=setup();await v.controller.toggle('composer',v.editor);Socket.latest.bufferedAmount=524289;Recorder.latest.ondataavailable({data:new Blob(['audio'])});assert.equal(v.controller.owner,null);
});
test('the time limit flushes the final phrase and releases capture',async()=>{
 const s=setup({maximumMilliseconds:10});await s.controller.toggle('composer',s.editor);Socket.latest.autoFinish=true;await new Promise(resolve=>setTimeout(resolve,30));assert.deepEqual(s.inserted,['the last phrase']);assert.equal(s.track.stopped,true);
});
