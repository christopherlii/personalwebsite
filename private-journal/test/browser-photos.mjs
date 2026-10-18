import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE || '@playwright/test');
const origin=process.env.JOURNAL_TEST_URL || 'http://localhost:8788';
if(!['localhost','127.0.0.1'].includes(new URL(origin).hostname)||!process.env.JOURNAL_TEST_PASSWORD)throw new Error('Use only a local journal and test password.');
const artifacts=process.env.JOURNAL_TEST_ARTIFACTS||'test-results/photos';await mkdir(artifacts,{recursive:true});
const browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{})});
const page=await browser.newPage({viewport:{width:1280,height:1000},reducedMotion:'reduce'});page.setDefaultTimeout(15000);
const errors=[];page.on('pageerror',error=>errors.push(error.message));const photoIds=[];let thoughtId,ownsDraft=false,releaseUpload,heldResolve;
const held=new Promise(resolve=>heldResolve=resolve);let hold=true;
await page.route('**/api/photos/**',async route=>{if(route.request().method()==='PUT'&&hold){hold=false;heldResolve();await new Promise(resolve=>releaseUpload=resolve);}await route.continue();});
const api=(path,method='GET',body)=>page.evaluate(async({path,method,body})=>{
 const response=await fetch(`/api/${path}`,{method,headers:{'Content-Type':'application/json','X-Journal':'1'},...(body?{body:JSON.stringify(body)}:{})});const data=await response.json();if(!response.ok)throw new Error(data.error);return data;
},{path,method,body});
const uploaded=()=>page.waitForResponse(response=>response.url().includes('/api/photos/')&&response.request().method()==='PUT');
try{
 await page.goto(origin);await page.locator('#password').fill(process.env.JOURNAL_TEST_PASSWORD);await page.locator('#unlock').click();await page.locator('#app').waitFor({state:'visible'});
 const draft=await api('draft');assert.equal(draft.body,'');assert.equal(draft.title,'');ownsDraft=true;
 const png=await page.evaluate(()=>{const canvas=document.createElement('canvas');canvas.width=3000;canvas.height=1800;const c=canvas.getContext('2d');c.fillStyle='#dedede';c.fillRect(0,0,3000,1800);c.fillStyle='#555';c.fillRect(300,300,1000,1200);c.fillStyle='#999';c.fillRect(1600,300,1100,500);return canvas.toDataURL('image/png').split(',')[1];});
 const editor=page.locator('#composer-editor .cm-content');await editor.click();await page.keyboard.insertText('sample thought: a photo from today.');
 const chooser=page.waitForEvent('filechooser');await page.locator('#photo-composer').click();const response=uploaded();await(await chooser).setFiles({name:'test-photo.png',mimeType:'image/png',buffer:Buffer.from(png,'base64')});
 await Promise.race([held,new Promise((_,reject)=>setTimeout(()=>reject(new Error("Photo upload did not start.")),12000))]);await editor.click();await editor.press('ControlOrMeta+End');await page.keyboard.insertText(' a sentence while uploading.');releaseUpload();
 const photo=(await(await response).json()).photo;photoIds.push(photo.id);assert.ok(photo.width<=2048&&photo.height<=2048&&photo.bytes<=1000000);
 await page.locator('#composer-editor .cm-content .cm-photo img').waitFor();
 const source=await page.locator('#body').inputValue();assert.ok(source.startsWith('sample thought: a photo from today. a sentence while uploading.'));
 await editor.press('ControlOrMeta+z');assert.equal((await page.locator('#body').inputValue()).includes('./api/photos/'),false);
 await editor.press('ControlOrMeta+Shift+z');await page.locator('#composer-editor .cm-content .cm-photo img').waitFor();assert.equal(await page.locator('#body').inputValue(),source);
 await page.waitForFunction(source=>document.querySelector('#composer').dataset.draftState==='saved'&&document.querySelector('#body').value===source,source);
 assert.equal((await api('draft')).body,source,'reload starts only after the exact photo draft is persisted');
 await page.reload();await page.locator('#composer-editor .cm-content .cm-photo img').waitFor();assert.equal(await page.locator('#body').inputValue(),source);
 await page.locator('#composer-editor .cm-content .cm-photo img').scrollIntoViewIfNeeded();await page.waitForFunction(()=>document.querySelector('#composer-editor .cm-content .cm-photo img').naturalWidth>0);
 await page.screenshot({path:`${artifacts}/composer-photo-desktop.png`,fullPage:true});
 const post=page.waitForResponse(response=>response.url().endsWith('/api/thoughts')&&response.request().method()==='POST');await page.locator('#post').click();const thought=(await(await post).json()).entry;thoughtId=thought.id;
 const article=page.locator(`article[data-id="${thoughtId}"]`);await article.locator('img.journal-photo').waitFor();assert.ok((await article.locator('img').boundingBox()).height<=160);
 await article.hover();await article.locator('[data-action=read]').click();await page.locator('#reader-content img').waitFor();await page.locator('#reader-edit').click();
 await page.locator('#live-editor .cm-content .cm-photo img').waitFor();const geometry=await page.locator('#live-editor .cm-content .cm-photo img').boundingBox();await page.locator('#live-editor .cm-content').press('ControlOrMeta+End');assert.deepEqual(await page.locator('#live-editor .cm-content .cm-photo img').boundingBox(),geometry,'a photo stays rendered when its line is active');
 const paste=uploaded();await page.evaluate(png=>{const bytes=Uint8Array.from(atob(png),c=>c.charCodeAt(0)),data=new DataTransfer();data.items.add(new File([bytes],'pasted.png',{type:'image/png'}));document.querySelector('#live-editor .cm-content').dispatchEvent(new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true}));},png);
 photoIds.push((await(await paste).json()).photo.id);await page.waitForFunction(()=>document.querySelectorAll('#live-editor .cm-content .cm-photo img').length===2);
 await page.waitForFunction(()=>document.querySelector('#photo-reader').textContent==='photo');
 const drop=uploaded();await page.evaluate(png=>{const bytes=Uint8Array.from(atob(png),c=>c.charCodeAt(0)),data=new DataTransfer();data.items.add(new File([bytes],'dropped.png',{type:'image/png'}));document.querySelector('#live-editor .cm-content').dispatchEvent(new DragEvent('drop',{dataTransfer:data,bubbles:true,cancelable:true}));},png);
 await page.locator('#reader-save').click();photoIds.push((await(await drop).json()).photo.id);await page.locator('#reader-edit').waitFor({state:'visible'});assert.equal(await page.locator('#reader-content img').count(),3,'save waits for the uploaded photo');
 await page.setViewportSize({width:320,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await page.screenshot({path:`${artifacts}/photos-mobile.png`,fullPage:true});
 await page.reload();await page.locator('#reader-content img').first().waitFor();assert.equal(await page.locator('#reader-content img').count(),3);
 const guest=await browser.newContext();assert.equal((await guest.request.get(`${origin}/api/photos/${photo.id}`)).status(),401);assert.equal((await guest.request.get(`${origin}/public/photos/${photo.id}`)).status(),404);
 const saved=(await api(`thoughts/${thoughtId}`)).entry;
 const draftPub=await api(`thoughts/${thoughtId}/publication`,'PUT',{draft:{slug:'sample-photo-note',title:'sample photo note',body:saved.body,date:'2026-10-18',tags:[],description:'',cover:'',coverPosition:''},version:0});
 const published=await api(`thoughts/${thoughtId}/publication/publish`,'POST',{version:draftPub.version});assert.equal((await guest.request.get(`${origin}/public/photos/${photo.id}`)).status(),200);
 await api(`thoughts/${thoughtId}/publication/unpublish`,'POST',{version:published.version});assert.equal((await guest.request.get(`${origin}/public/photos/${photo.id}`)).status(),404);await guest.close();
 assert.equal((await api('export')).photos.filter(item=>photoIds.includes(item.id)).length,3);
 await page.goto(origin);await page.locator('#composer-editor .cm-content').click();await page.keyboard.insertText('keep this draft when its photo cannot upload.');
 let failedUploadReady,failUpload;const failing=new Promise(resolve=>failedUploadReady=resolve);
 await page.route('**/api/photos/**',async route=>{if(route.request().method()==='PUT'){failedUploadReady();await new Promise(resolve=>failUpload=resolve);await route.fulfill({status:500,contentType:'application/json',body:JSON.stringify({error:'Photo upload failed.'})});}else await route.continue();});
 let posts=0;page.on('request',request=>{if(request.method()==='POST'&&request.url().endsWith('/api/thoughts'))posts++;});
 const failedChooser=page.waitForEvent('filechooser');await page.locator('#photo-composer').click();await(await failedChooser).setFiles({name:'failed.png',mimeType:'image/png',buffer:Buffer.from(png,'base64')});
 await failing;await page.locator('#post').click();failUpload();await page.waitForFunction(()=>document.querySelector('#photo-composer').textContent==='photo');
 assert.equal(posts,0,'posting waits for an upload and stops if it fails');assert.equal(await page.locator('#body').inputValue(),'keep this draft when its photo cannot upload.');assert.deepEqual(errors,[]);
 console.log(JSON.stringify({passed:true,checks:['file chooser','browser resizing','typing during upload','one-step undo/redo','draft reload','feed thumbnail','stable live photo rendering','paste','drop','save waits for upload','320px layout','private photo access','explicit publication and unpublish','export manifest','failed upload preserves the draft and stops posting'],screenshots:artifacts}));
}catch(error){releaseUpload?.();await page.screenshot({path:`${artifacts}/failure.png`,fullPage:true}).catch(()=>{});throw error;}
finally{
 if(ownsDraft){const draft=await api('draft').catch(()=>null);if(draft)await api('draft','PUT',{title:'',body:'',version:draft.version}).catch(()=>{});}
 if(thoughtId){const pub=await api(`thoughts/${thoughtId}/publication`).catch(()=>null);if(pub?.published)await api(`thoughts/${thoughtId}/publication/unpublish`,'POST',{version:pub.version}).catch(()=>{});await api(`thoughts/${thoughtId}`,'DELETE').catch(()=>{});}
 for(const id of photoIds)await api(`photos/${id}`,'DELETE').catch(()=>{});await browser.close();
}
