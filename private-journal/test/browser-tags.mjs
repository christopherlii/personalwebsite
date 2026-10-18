import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE || '@playwright/test');
const origin=process.env.JOURNAL_TEST_URL || 'http://localhost:8788';
if(!['localhost','127.0.0.1'].includes(new URL(origin).hostname)||!process.env.JOURNAL_TEST_PASSWORD)throw new Error('Use a local journal and test password.');
const artifacts=process.env.JOURNAL_TEST_ARTIFACTS||'test-results/tags';await mkdir(artifacts,{recursive:true});
const browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{})});
const page=await browser.newPage({viewport:{width:1280,height:900}});page.setDefaultTimeout(12000);
const errors=[];page.on('pageerror',error=>errors.push(error.message));const ids=[];let ownsDraft=false;
const api=(path,method='GET',body)=>page.evaluate(async({path,method,body})=>{
 const response=await fetch(`/api/${path}`,{method,headers:{'Content-Type':'application/json','X-Journal':'1'},...(body?{body:JSON.stringify(body)}:{})});const data=await response.json();if(!response.ok)throw new Error(data.error);return data;
},{path,method,body});
try{
 await page.goto(origin);await page.locator('#password').fill(process.env.JOURNAL_TEST_PASSWORD);await page.locator('#unlock').click();await page.locator('#app').waitFor({state:'visible'});
 const draft=await api('draft');assert.equal(draft.body,'');assert.equal(draft.title,'');ownsDraft=true;
 const create=async body=>{const entry=(await api('thoughts','POST',{id:crypto.randomUUID(),body})).entry;ids.push(entry.id);return entry;};
 const one=await create('sample thought: ideas arrive on walks. #Ideas\n\n`#code` [link #not-a-tag](https://example.com/#fragment)');
 const two=await create('sample thought: another angle. #ideas');
 const other=await create('sample thought: different topic. #ideas-more');
 await page.reload();await page.locator(`article[data-id="${one.id}"] a[data-tag=ideas]`).waitFor();
 assert.equal(await page.locator(`article[data-id="${one.id}"] a[data-tag=code]`).count(),0);
 await page.locator(`article[data-id="${one.id}"] a[data-tag=ideas]`).click();await page.locator('#tag-filter').waitFor({state:'visible'});
 await page.waitForFunction(id=>document.querySelectorAll('#feed article').length===2&&!document.querySelector(`#feed article[data-id="${id}"]`),other.id);
 assert.equal(await page.locator('#active-tag').textContent(),'#ideas');
 await page.screenshot({path:`${artifacts}/tag-desktop.png`,fullPage:true});
 await page.reload();await page.locator('#tag-filter').waitFor({state:'visible'});assert.equal(await page.locator('#feed article').count(),2);
 await page.locator('#composer-editor .cm-content').click();await page.keyboard.insertText('unfinished writing while browsing a tag');
 await page.waitForFunction(async()=>document.querySelector('#composer').dataset.draftState==='saved'&&(await (await fetch('/api/draft')).json()).body===document.querySelector('#body').value);assert.equal(await page.locator('#feed article').count(),2);
 await page.locator(`article[data-id="${one.id}"]`).hover();await page.locator(`article[data-id="${one.id}"] [data-action=read]`).click();
 await page.locator('#reader-content a[data-tag=ideas]').waitFor();assert.equal(await page.locator('#reader-content a[data-tag=code]').count(),0);assert.equal(await page.locator('#reader-content a[data-tag=not-a-tag]').count(),0);
 await page.locator('#reader-back').click();await page.locator('#tag-filter').waitFor({state:'visible'});assert.equal(await page.locator('#body').inputValue(),'unfinished writing while browsing a tag');
 await page.setViewportSize({width:320,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await page.screenshot({path:`${artifacts}/tag-mobile.png`,fullPage:true});
 await page.locator(`article[data-id="${one.id}"]`).hover();await page.locator(`article[data-id="${one.id}"] [data-action=read]`).click();await page.locator('#reader-edit').click();
 const editor=page.locator('#live-editor .cm-content');await editor.click();await editor.press('ControlOrMeta+a');await page.keyboard.insertText('sample thought: now #life');await page.locator('#reader-save').click();await page.locator('#reader-edit').waitFor({state:'visible'});
 await page.locator('#reader-back').click();await page.waitForFunction(id=>!document.querySelector(`#feed article[data-id="${id}"]`),one.id);assert.equal(await page.locator('#feed article').count(),1);
 await page.locator('#tag-filter a').click();await page.locator('#tag-filter').waitFor({state:'hidden'});
 await page.locator('#composer-editor .cm-content').click();await page.keyboard.press('ControlOrMeta+a');await page.keyboard.press('Backspace');await page.waitForFunction(()=>document.querySelector('#body').value==='');
 const longTag='long-tag'.repeat(8);await create(`sample thought: #${longTag}`);
 await page.evaluate(tag=>{location.hash=`tag/${tag}`;},longTag);await page.locator('#active-tag').filter({hasText:longTag}).waitFor();
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'long tag names wrap on mobile');
 assert.deepEqual(errors,[]);console.log(JSON.stringify({passed:true,checks:['click tags in feed and reader','exact case-insensitive filtering','code and URL exclusions','direct reload','draft preservation while filtering','back to tag','editing updates index','clear filter','320px layout'],screenshots:artifacts}));
}catch(error){await page.screenshot({path:`${artifacts}/failure.png`,fullPage:true}).catch(()=>{});throw error;}
finally{if(ownsDraft){const draft=await api('draft').catch(()=>null);if(draft)await api('draft','PUT',{title:'',body:'',version:draft.version}).catch(()=>{});}for(const id of ids)await api(`thoughts/${id}`,'DELETE').catch(()=>{});await browser.close();}
