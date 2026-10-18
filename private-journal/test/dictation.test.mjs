import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createDictation} from '../public/dictation.js';
class Recorder{
 static isTypeSupported(type){return type.startsWith('audio/webm');}
 constructor(){Recorder.latest=this;this.state='inactive';this.mimeType='audio/webm;codecs=opus';}
 start(){this.state='recording';}
 stop(){this.state='inactive';queueMicrotask(()=>{this.ondataavailable?.({data:new Blob(['recording'],{type:this.mimeType})});this.onstop?.();});}
}
function setup(extra={}){
 const states=[],messages=[],inserted=[],track={stopped:false,stop(){this.stopped=true;}},calls=[];
 const controller=createDictation({Recorder,getMedia:async()=>({getTracks:()=>[track]}),transcribe:async(audio,signal)=>{calls.push({audio,signal});return{text:'spoken words'};},onState:(...v)=>states.push(v),onMessage:(...v)=>messages.push(v),...extra});
 const editor={focus(){},insertText(text){inserted.push(text);return true;}};
 return{controller,editor,states,messages,inserted,track,calls};
}
test('dictation captures only on request, releases the mic, and waits for the final transcript',async()=>{
 const s=setup();assert.equal(s.controller.owner,null);assert.equal(s.calls.length,0);
 await s.controller.toggle('composer',s.editor);assert.equal(s.controller.phase,'listening');assert.deepEqual(s.inserted,[]);
 const done=s.controller.stop();assert.equal(s.controller.phase,'transcribing');assert.equal(await done,true);
 assert.deepEqual(s.inserted,['spoken words']);assert.equal(s.calls[0].audio.type,'audio/webm;codecs=opus');assert.equal(s.track.stopped,true);assert.equal(s.controller.owner,null);
});
test('cancel and late microphone or transcription results never change text',async()=>{
 let media;const s=setup({getMedia:()=>new Promise(resolve=>media=resolve)});
 const pending=s.controller.toggle('composer',s.editor);s.controller.cancel();media({getTracks:()=>[s.track]});await pending;assert.equal(s.track.stopped,true);assert.deepEqual(s.inserted,[]);
 let transcript;const t=setup({transcribe:()=>new Promise(resolve=>transcript=resolve)});await t.controller.toggle('reader',t.editor);const done=t.controller.stop();await new Promise(resolve=>setImmediate(resolve));t.controller.cancel();transcript({text:'late words'});assert.equal(await done,false);await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(t.inserted,[]);
});
test('permission errors, unsupported recording, and provider failure preserve text',async()=>{
 const s=setup({getMedia:async()=>{throw new DOMException('denied','NotAllowedError');}});await s.controller.toggle('composer',s.editor);assert.match(s.messages.at(-1)[1],/Microphone access was denied/);assert.equal(s.controller.owner,null);
 const u=setup({Recorder:null});await u.controller.toggle('composer',u.editor);assert.match(u.messages.at(-1)[1],/unavailable/);
 const t=setup({transcribe:async()=>{throw new Error('Could not transcribe.');}});await t.controller.toggle('reader',t.editor);assert.equal(await t.controller.stop(),false);assert.deepEqual(t.inserted,[]);assert.equal(t.track.stopped,true);
});
test('empty speech, editor limits, and recording limits stop safely',async()=>{
 const s=setup({transcribe:async()=>({text:''})});await s.controller.toggle('composer',s.editor);assert.equal(await s.controller.stop(),false);assert.match(s.messages.at(-1)[1],/No speech/);
 const t=setup();await t.controller.toggle('reader',{focus(){},insertText(){return false;}});assert.equal(await t.controller.stop(),false);
 const u=setup();await u.controller.toggle('composer',u.editor);Recorder.latest.ondataavailable({data:new Blob([new Uint8Array(2000001)])});assert.equal(u.controller.owner,null);assert.equal(u.track.stopped,true);assert.equal(u.calls.length,0);
});
test('recordings stop and transcribe at the time limit',async()=>{
 const s=setup({maximumMilliseconds:10});await s.controller.toggle('composer',s.editor);await new Promise(resolve=>setTimeout(resolve,30));assert.deepEqual(s.inserted,['spoken words']);assert.equal(s.track.stopped,true);
});
