import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'@playwright/test');
const origin=process.env.JOURNAL_TEST_URL||'http://localhost:8788';
if(!['localhost','127.0.0.1'].includes(new URL(origin).hostname)||!process.env.JOURNAL_TEST_PASSWORD)throw new Error('Use only local test fixtures.');
const artifacts=process.env.JOURNAL_TEST_ARTIFACTS||'test-results/dictation';await mkdir(artifacts,{recursive:true});
const browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{}),args:['--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream',...(process.env.JOURNAL_TEST_AUDIO?[`--use-file-for-fake-audio-capture=${process.env.JOURNAL_TEST_AUDIO}`]:[])]});
const context=await browser.newContext({viewport:{width:1280,height:900},permissions:['microphone'],reducedMotion:'reduce'});const page=await context.newPage();page.setDefaultTimeout(15000);
const errors=[];page.on('pageerror',e=>errors.push(e.message));
await page.addInitScript(()=>{window.SpeechRecognition=window.webkitSpeechRecognition=undefined;const get=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);navigator.mediaDevices.getUserMedia=async options=>{window.__stream=await get(options);return window.__stream;};});
let nextText='sample thought: a dictated thought.',fail=false,hold=false,release,heldResolve,requests=0;let id,ownsDraft=false;
await page.route('**/api/transcribe',async route=>{
 requests++;assert.ok(route.request().postDataBuffer().length>12,'real MediaRecorder sends audio');assert.match(route.request().headers()['content-type'],/^audio\//);
 if(hold){hold=false;heldResolve();await new Promise(resolve=>release=resolve);}
 await route.fulfill({status:fail?502:200,contentType:'application/json',body:JSON.stringify(fail?{error:'Could not transcribe. Try again.'}:{text:nextText})});
});
const api=(path,method='GET',body)=>page.evaluate(async({path,method,body})=>{const r=await fetch(`/api/${path}`,{method,headers:{'Content-Type':'application/json','X-Journal':'1'},...(body===undefined?{}:{body:JSON.stringify(body)})});const data=await r.json();if(!r.ok)throw new Error(data.error);return data;},{path,method,body});
const recording=async owner=>{await page.locator(`#dictate-${owner}`).click();await page.waitForFunction(owner=>document.querySelector(`#dictation-${owner}-status`).textContent==='listening…',owner);await page.waitForTimeout(350);};
const inactive=()=>page.waitForFunction(()=>!window.__stream||window.__stream.getTracks().every(track=>track.readyState==='ended'));
try{
 await page.goto(origin);await page.locator('#password').fill(process.env.JOURNAL_TEST_PASSWORD);await page.locator('#unlock').click();await page.locator('#app').waitFor({state:'visible'});
 const initial=await api('draft');assert.equal(initial.body,'');assert.equal(initial.title,'');ownsDraft=true;
 assert.equal(await page.evaluate(()=>Boolean(window.__stream)),false);assert.equal(await page.locator('#clear-input').count(),0);
 const before=await page.locator('#timeline').boundingBox();await recording('composer');assert.deepEqual(await page.locator('#timeline').boundingBox(),before,'recording controls reserve their space');
 await page.screenshot({path:`${artifacts}/recording-desktop.png`,fullPage:true});await page.locator('#dictate-composer').click();
 await page.waitForFunction(()=>document.querySelector('#body').value==='sample thought: a dictated thought.');await inactive();assert.equal(requests,1);
 await page.locator('#composer-editor .cm-content').press('ControlOrMeta+z');assert.equal(await page.locator('#body').inputValue(),'');await page.locator('#composer-editor .cm-content').press('ControlOrMeta+Shift+z');
 await page.waitForFunction(async()=>document.querySelector('#composer').dataset.draftState==='saved'&&(await(await fetch('/api/draft')).json()).body===document.querySelector('#body').value);assert.equal(await page.locator('#draft-status').textContent(),'');
 nextText='included when posted.';await recording('composer');const posted=page.waitForResponse(r=>r.url().endsWith('/api/thoughts')&&r.request().method()==='POST');await page.locator('#post').click();const entry=(await(await posted).json()).entry;id=entry.id;assert.equal(entry.body,'sample thought: a dictated thought. included when posted.');await inactive();
 const article=page.locator(`article[data-id="${id}"]`);await article.hover();await article.locator('[data-action=read]').click();await page.locator('#reader-edit').click();nextText='edited by speaking.';await recording('reader');
 await page.setViewportSize({width:320,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await page.screenshot({path:`${artifacts}/recording-mobile.png`,fullPage:true});
 await page.locator('#reader-save').click();await page.locator('#edit-form').waitFor({state:'hidden'});assert.ok((await api(`thoughts/${id}`)).entry.body.endsWith('edited by speaking.'));await inactive();
 await page.locator('#reader-edit').click();nextText='saved on back.';await recording('reader');await page.locator('#reader-back').click();await page.locator('#app').waitFor({state:'visible'});assert.ok((await api(`thoughts/${id}`)).entry.body.endsWith('saved on back.'));
 await page.locator('#composer-editor .cm-content').click();await page.keyboard.insertText('keep this draft.');fail=true;await recording('composer');await page.locator('#post').click();await page.waitForFunction(()=>document.querySelector('#dictation-composer-status').textContent.includes('Could not transcribe'));assert.equal(await page.locator('#body').inputValue(),'keep this draft.');await inactive();fail=false;
 const held=new Promise(resolve=>heldResolve=resolve);hold=true;nextText='late words';await recording('composer');await page.locator('#dictate-composer').click();await held;
 await page.evaluate(()=>{Object.defineProperty(document,'visibilityState',{configurable:true,value:'hidden'});document.dispatchEvent(new Event('visibilitychange'));delete document.visibilityState;});release();await page.waitForTimeout(150);assert.equal(await page.locator('#body').inputValue(),'keep this draft.');await inactive();assert.deepEqual(errors,[]);
 console.log(JSON.stringify({passed:true,checks:['MediaRecorder with synthetic microphone','no SpeechRecognition required','explicit start','fixed control geometry','final transcript on stop/post/save/back','autosave without success label','undo/redo','both editors','320px layout','provider failure preserves draft','hidden tab rejects late results','microphone tracks released'],screenshots:artifacts}));
}catch(error){release?.();await page.screenshot({path:`${artifacts}/failure.png`,fullPage:true}).catch(()=>{});throw error;}
finally{if(ownsDraft){const draft=await api('draft').catch(()=>null);if(draft)await api('draft','PUT',{title:'',body:'',version:draft.version}).catch(()=>{});}if(id)await api(`thoughts/${id}`,'DELETE').catch(()=>{});await browser.close();}
