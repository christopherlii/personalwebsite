import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'@playwright/test');
const origin=process.env.JOURNAL_TEST_URL||'http://localhost:8788';
if(!['localhost','127.0.0.1'].includes(new URL(origin).hostname)||!process.env.JOURNAL_TEST_PASSWORD)throw new Error('Use only local test fixtures.');
const artifacts=process.env.JOURNAL_TEST_ARTIFACTS||'test-results/dictation';await mkdir(artifacts,{recursive:true});
const browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{}),args:['--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream']});
const context=await browser.newContext({viewport:{width:1280,height:900},permissions:['microphone'],reducedMotion:'reduce'});const page=await context.newPage();page.setDefaultTimeout(15000);
const errors=[];page.on('pageerror',e=>errors.push(e.message));
await page.addInitScript(()=>{window.SpeechRecognition=window.webkitSpeechRecognition=undefined;const get=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);navigator.mediaDevices.getUserMedia=async options=>{window.__stream=await get(options);return window.__stream;};});
let socket,push,nextTail='',fail=false,hold=false,release,heldResolve,connections=0,audioFrames=0,id,ownsDraft=false;
await page.routeWebSocket('**/api/dictation',route=>{
 socket=route;connections++;let cursor=0;
 push=(text,final=false)=>{route.send(JSON.stringify({type:'transcript',text,final,start:cursor,duration:1}));if(final)cursor++;};
 route.onMessage(async data=>{
  if(typeof data!=='string'){assert.ok(data.length>0);audioFrames++;return;}
  assert.equal(JSON.parse(data).type,'stop');
  if(hold){hold=false;heldResolve();await new Promise(resolve=>release=resolve);}
  try{if(fail)route.send(JSON.stringify({type:'error',error:'Live dictation stopped. Try again.'}));else{if(nextTail)push(nextTail,true);route.send(JSON.stringify({type:'done'}));}await route.close({code:1000});}catch{}
 });
});
const api=(path,method='GET',body)=>page.evaluate(async({path,method,body})=>{const r=await fetch(`/api/${path}`,{method,headers:{'Content-Type':'application/json','X-Journal':'1'},...(body===undefined?{}:{body:JSON.stringify(body)})});const data=await r.json();if(!r.ok)throw new Error(data.error);return data;},{path,method,body});
const recording=async owner=>{await page.locator(`#dictate-${owner}`).click();await page.waitForFunction(owner=>document.querySelector(`#dictation-${owner}-status`).textContent==='listening…',owner);};
const inactive=()=>page.waitForFunction(()=>!window.__stream||window.__stream.getTracks().every(track=>track.readyState==='ended'));
const persisted=async expected=>{await page.waitForFunction(text=>document.querySelector('#composer').dataset.draftState==='saved'&&document.querySelector('#body').value===text,expected);assert.equal((await api('draft')).body,expected);};
try{
 await page.goto(origin);await page.locator('#password').fill(process.env.JOURNAL_TEST_PASSWORD);await page.locator('#unlock').click();await page.locator('#app').waitFor({state:'visible'});
 const initial=await api('draft');assert.equal(initial.body,'');assert.equal(initial.title,'');ownsDraft=true;
 assert.equal(connections,0);assert.equal(await page.locator('#add-title').count(),0);assert.equal(await page.locator('#title').getAttribute('placeholder'),'no title');assert.equal(await page.locator('#title').isVisible(),true);
 const title=await page.locator('#title').boundingBox(),body=await page.locator('#composer-editor').boundingBox();assert.ok(title.y+title.height<=body.y);
 const tools=await Promise.all(['#photo-composer','#dictate-composer','#post'].map(selector=>page.locator(selector).boundingBox()));assert.ok(tools[0].x<tools[1].x&&tools[1].x<tools[2].x);assert.ok(Math.abs(tools[2].x+tools[2].width-(await page.locator('.composer-toolbar').boundingBox()).x-(await page.locator('.composer-toolbar').boundingBox()).width)<1);
 const before=await page.locator('#timeline').boundingBox();await recording('composer');assert.deepEqual(await page.locator('#timeline').boundingBox(),before);
 push('sample thought:');await page.locator('.cm-dictation-preview').waitFor();assert.equal(await page.locator('#body').inputValue(),'');assert.equal(await page.locator('#composer-editor .cm-placeholder').isVisible(),false);
 push('sample thought: a dictated thought.');await page.waitForFunction(()=>document.querySelector('.cm-dictation-preview')?.textContent==='sample thought: a dictated thought.');
 const editor=page.locator('#composer-editor .cm-content');await editor.click();await page.keyboard.insertText('typed words.');assert.equal(await page.locator('#body').inputValue(),'typed words.');
 push('sample thought: a dictated thought.',true);const text='typed words. sample thought: a dictated thought.';await page.waitForFunction(text=>document.querySelector('#body').value===text,text);
 socket.send(JSON.stringify({type:'transcript',text:'sample thought: a dictated thought.',start:0,duration:1,final:true}));await page.waitForTimeout(60);assert.equal(await page.locator('#body').inputValue(),text);assert.equal(await page.locator('#dictate-composer').getAttribute('aria-pressed'),'true','text arrives before stop');
 await editor.press('ControlOrMeta+z');assert.equal(await page.locator('#body').inputValue(),'typed words.');await editor.press('ControlOrMeta+Shift+z');await persisted(text);
 await page.locator('#dictate-composer').click();await inactive();await page.waitForFunction(()=>document.querySelector('#dictate-composer').getAttribute('aria-pressed')==='false');
 await page.locator('#title').fill('a live thought');await page.waitForFunction(()=>document.querySelector('#composer').dataset.draftState==='saved');assert.equal((await api('draft')).title,'a live thought');await page.reload();await page.locator('#app').waitFor({state:'visible'});assert.equal(await page.locator('#title').inputValue(),'a live thought');assert.equal(await page.locator('#body').inputValue(),text);assert.equal(await page.locator('.cm-dictation-preview').count(),0);
 nextTail='included when posted.';await recording('composer');const posted=page.waitForResponse(r=>r.url().endsWith('/api/thoughts')&&r.request().method()==='POST');await page.locator('#post').click();const entry=(await(await posted).json()).entry;id=entry.id;assert.equal(entry.body,text+' included when posted.');assert.equal(entry.title,'a live thought');await inactive();
 const article=page.locator(`article[data-id="${id}"]`);await article.hover();await article.locator('[data-action=read]').click();await page.locator('#reader-edit').click();nextTail='saved tail.';await recording('reader');push('edited while speaking.');await page.locator('#live-editor .cm-dictation-preview').waitFor();push('edited while speaking.',true);await page.waitForFunction(()=>document.querySelector('#edit-body').value.endsWith('edited while speaking.'));
 await page.setViewportSize({width:320,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await page.screenshot({path:`${artifacts}/live-reader-mobile.png`,fullPage:true});await page.locator('#reader-save').click();await page.locator('#edit-form').waitFor({state:'hidden'});assert.ok((await api(`thoughts/${id}`)).entry.body.endsWith('edited while speaking. saved tail.'));
 await page.locator('#reader-edit').click();nextTail='saved on back.';await recording('reader');await page.locator('#reader-back').click();await page.locator('#app').waitFor({state:'visible'});assert.ok((await api(`thoughts/${id}`)).entry.body.endsWith('saved on back.'));
 await page.locator('#composer-editor .cm-content').click();await page.keyboard.insertText('keep this draft.');fail=true;await recording('composer');push('heard before disconnect');await page.locator('.cm-dictation-preview').waitFor();await page.locator('#post').click();await page.waitForFunction(()=>document.querySelector('#dictation-composer-status').textContent.includes('Live dictation stopped'));const kept='keep this draft. heard before disconnect';assert.equal(await page.locator('#body').inputValue(),kept);await inactive();await persisted(kept);fail=false;
 const held=new Promise(resolve=>heldResolve=resolve);hold=true;nextTail='late words';await recording('composer');await page.locator('#dictate-composer').click();await held;await page.evaluate(()=>{Object.defineProperty(document,'visibilityState',{configurable:true,value:'hidden'});document.dispatchEvent(new Event('visibilitychange'));delete document.visibilityState;});release();await page.waitForTimeout(100);assert.equal(await page.locator('#body').inputValue(),kept);await inactive();assert.ok(audioFrames>0);assert.deepEqual(errors,[]);
 console.log(JSON.stringify({passed:true,checks:['actual synthetic microphone streaming','live partial revisions','interim words excluded from draft','typing preserved','final words before stop','duplicate final suppression','undo/redo','persistent no-title field','right-aligned actions','title autosave/reload','tail on post/save/back','both editors','320px layout','dropped connection preserves visible words','hidden-tab cancellation','microphone cleanup'],screenshots:artifacts}));
}catch(error){release?.();await page.screenshot({path:`${artifacts}/failure.png`,fullPage:true}).catch(()=>{});throw error;}
finally{if(ownsDraft){const draft=await api('draft').catch(()=>null);if(draft)await api('draft','PUT',{title:'',body:'',version:draft.version}).catch(()=>{});}if(id)await api(`thoughts/${id}`,'DELETE').catch(()=>{});await browser.close();}
