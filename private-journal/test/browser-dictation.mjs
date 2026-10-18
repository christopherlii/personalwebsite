import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || '@playwright/test');
const origin = process.env.JOURNAL_TEST_URL || 'http://localhost:8787';
if (!['localhost','127.0.0.1'].includes(new URL(origin).hostname)) throw new Error('Dictation checks may only write local fixtures.');
if (!process.env.JOURNAL_TEST_PASSWORD) throw new Error('Set JOURNAL_TEST_PASSWORD.');
const artifacts = process.env.JOURNAL_TEST_ARTIFACTS || 'test-results/dictation'; await mkdir(artifacts,{recursive:true});
const browser = await chromium.launch({headless:true,...(process.env.CHROMIUM_PATH ? {executablePath:process.env.CHROMIUM_PATH}: {})});
const page = await browser.newPage({viewport:{width:1280,height:900}}); page.setDefaultTimeout(12000);
const errors=[]; page.on('pageerror',error=>errors.push(error.message));
await page.addInitScript(() => {
  window.SpeechRecognition = class {
    constructor(){window.__recognition=this;this.results=[];}
    start(){queueMicrotask(()=>this.onstart?.());}
    emit(text){const result=Object.assign([{transcript:text}],{isFinal:true});this.results.push(result);this.onresult?.({resultIndex:this.results.length-1,results:this.results});}
    stop(){queueMicrotask(()=>{if(this.tail)this.emit(this.tail);this.onend?.();});}
    abort(){this.aborted=true;}
  };
});
const api = (path,method='GET',body) => page.evaluate(async({path,method,body})=>{
  const response=await fetch(`/api/${path}`,{method,headers:{'Content-Type':'application/json','X-Journal':'1'},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const value=await response.json();if(!response.ok)throw new Error(value.error);return value;
},{path,method,body});
let id, ownsDraft=false;
try {
  await page.goto(origin);await page.locator('#password').fill(process.env.JOURNAL_TEST_PASSWORD);await page.locator('#unlock').click();await page.locator('#app').waitFor({state:'visible'});
  const initial=await api('draft');assert.equal(initial.body,'');assert.equal(initial.title,'');ownsDraft=true;
  assert.equal(await page.evaluate(()=>Boolean(window.__recognition)),false,'no speech service starts on load');
  const before=await page.locator('#timeline').boundingBox();await page.locator('#dictate-composer').click();
  await page.waitForFunction(()=>document.querySelector('#dictation-composer-status').textContent==='listening…');
  assert.deepEqual(await page.locator('#timeline').boundingBox(),before,'starting dictation leaves the feed stationary');
  await page.evaluate(()=>window.__recognition.emit('sample thought: a dictated thought.'));
  await page.waitForFunction(()=>document.querySelector('#body').value==='sample thought: a dictated thought.');
  await page.evaluate(()=>window.__recognition.tail='the last phrase.');await page.locator('#dictate-composer').click();
  const text='sample thought: a dictated thought. the last phrase.';
  await page.waitForFunction(text=>document.querySelector('#body').value===text,text);
  await page.locator('#composer-editor .cm-content').press('ControlOrMeta+z');
  assert.equal(await page.locator('#body').inputValue(),'sample thought: a dictated thought.','a phrase is one undoable edit');
  await page.locator('#composer-editor .cm-content').press('ControlOrMeta+Shift+z');
  await page.waitForFunction(()=>document.querySelector('#draft-status').textContent==='draft saved');
  assert.equal((await api('draft')).body,text);
  await page.locator('#dictate-composer').click();await page.evaluate(()=>window.__recognition.tail='included when posted.');
  const posted=page.waitForResponse(response=>response.url().endsWith('/api/thoughts')&&response.request().method()==='POST');
  await page.locator('#post').click();const entry=(await (await posted).json()).entry;id=entry.id;
  assert.equal(entry.body,text+' included when posted.');
  const article=page.locator(`article[data-id="${id}"]`);await article.waitFor();await article.hover();await article.locator('[data-action=read]').click();
  await page.locator('#reader-edit').click();await page.locator('#dictate-reader').click();
  await page.evaluate(()=>window.__recognition.emit('edited by speaking.'));
  await page.setViewportSize({width:320,height:844});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await page.screenshot({path:`${artifacts}/dictation-reader-mobile.png`,fullPage:true});
  await page.evaluate(()=>window.__recognition.tail='saved tail.');await page.locator('#reader-save').click();
  await page.locator('#edit-form').waitFor({state:'hidden'});
  assert.ok((await api(`thoughts/${id}`)).entry.body.endsWith('edited by speaking. saved tail.'));
  await page.locator('#reader-edit').click();await page.locator('#dictate-reader').click();await page.evaluate(()=>window.__recognition.tail='saved on back.');
  await page.locator('#reader-back').click();await page.locator('#app').waitFor({state:'visible'});
  assert.ok((await api(`thoughts/${id}`)).entry.body.endsWith('saved on back.'));
  await page.locator('#dictate-composer').click();await page.evaluate(()=>window.__recognition.onerror({error:'not-allowed'}));
  assert.match(await page.locator('#dictation-composer-status').textContent(),/Microphone access was denied/);
  assert.equal(await page.locator('#body').inputValue(),'');
  await page.locator('#dictate-composer').click();const old=await page.evaluate(()=>{window.__late=window.__recognition.onresult;return true;});assert.equal(old,true);
  await page.evaluate(()=>{Object.defineProperty(document,'visibilityState',{configurable:true,value:'hidden'});document.dispatchEvent(new Event('visibilitychange'));delete document.visibilityState;window.__late({resultIndex:0,results:[Object.assign([{transcript:'late speech'}],{isFinal:true})]});});
  assert.equal(await page.locator('#body').inputValue(),'','hidden-tab and late results never insert into another field');
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({passed:true,recognition:'injected events; no microphone captured',checks:['explicit start','stationary controls','final phrase on stop/post/save/back','autosave','undo/redo','both editors','320px layout','denial','hidden tab and stale callbacks'],screenshots:artifacts}));
} catch(error){await page.screenshot({path:`${artifacts}/failure.png`,fullPage:true}).catch(()=>{});throw error;}
finally {
  if(ownsDraft){const draft=await api('draft').catch(()=>null);if(draft)await api('draft','PUT',{title:'',body:'',version:draft.version}).catch(()=>{});}
  if(id)await api(`thoughts/${id}`,'DELETE').catch(()=>{});await browser.close();
}
