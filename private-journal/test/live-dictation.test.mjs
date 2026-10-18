import {test} from 'node:test';
import assert from 'node:assert/strict';
import {bridgeDictation} from '../live-dictation.mjs';
class Socket extends EventTarget{
 sent=[];send(value){this.sent.push(value);}close(code){this.closed=code;}
 receive(data){this.dispatchEvent(new MessageEvent('message',{data}));}
 json(value){this.receive(JSON.stringify(value));}
}
const audio=()=>new Uint8Array([26,69,223,163,0,0,0,0,0,0,0,0]).buffer;
const result=(text,final=false)=>({type:'Results',channel:{alternatives:[{transcript:text}]},is_final:final,start:0,duration:1});
test('the private relay streams audio and sanitized results, then flushes before done',()=>{
 const client=new Socket(),upstream=new Socket(),bridge=bridgeDictation(client,upstream);
 try{client.receive(audio());assert.equal(upstream.sent[0].byteLength,12);upstream.json(result('live words'));upstream.json(result('live words',true));
 const messages=client.sent.map(JSON.parse);assert.deepEqual(messages.slice(1),[{type:'transcript',text:'live words',final:false,start:0,duration:1},{type:'transcript',text:'live words',final:true,start:0,duration:1}]);
 client.json({type:'stop'});assert.deepEqual(JSON.parse(upstream.sent.at(-1)),{type:'Finalize'});upstream.json({...result('last words',true),from_finalize:true});assert.deepEqual(JSON.parse(upstream.sent.at(-1)),{type:'CloseStream'});upstream.json({type:'Metadata',request_id:'not forwarded'});assert.deepEqual(JSON.parse(client.sent.at(-1)),{type:'done'});assert.equal(client.closed,1000);assert.equal(upstream.closed,1000);
 }finally{bridge.close();}
});
test('bad containers, oversized frames, and arbitrary control messages never reach the model',()=>{
 for(const data of [new Uint8Array(20).buffer,new Uint8Array(262145).buffer,JSON.stringify({type:'Configure',model:'other'})]){
 const c=new Socket(),u=new Socket(),b=bridgeDictation(c,u);try{c.receive(data);assert.equal(u.sent.length,0);assert.equal(JSON.parse(c.sent.at(-1)).type,'error');assert.equal(c.closed,1011);}finally{b.close();}
 }
});
test('provider details are not forwarded and dropped clients close the provider',()=>{
 const c=new Socket(),u=new Socket(),b=bridgeDictation(c,u);try{u.json({type:'Error',message:'provider private details'});assert.equal(JSON.parse(c.sent.at(-1)).type,'error');assert.equal(c.sent.some(m=>m.includes('provider private')),false);}finally{b.close();}
 const cc=new Socket(),uu=new Socket(),bb=bridgeDictation(cc,uu);cc.dispatchEvent(new Event('close'));assert.equal(uu.closed,1000);bb.close();
});
test('a server deadline closes both sides',async()=>{
 const c=new Socket(),u=new Socket(),b=bridgeDictation(c,u,{maximumMilliseconds:5});try{await new Promise(resolve=>setTimeout(resolve,20));assert.equal(c.closed,1011);assert.equal(u.closed,1000);}finally{b.close();}
});
