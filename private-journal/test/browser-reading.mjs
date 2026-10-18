import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE || '@playwright/test');
const origin=process.env.JOURNAL_TEST_URL || 'http://localhost:8788';
if(!['localhost','127.0.0.1'].includes(new URL(origin).hostname))throw new Error('Reading tests may only write locally.');
if(!process.env.JOURNAL_TEST_PASSWORD)throw new Error('Set a local test password.');
const artifacts=process.env.JOURNAL_TEST_ARTIFACTS || 'test-results/reading';await mkdir(artifacts,{recursive:true});
const browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{})});
const page=await browser.newPage({viewport:{width:1280,height:900}});page.setDefaultTimeout(12000);
const errors=[];page.on('pageerror',error=>errors.push(error.message));let savedId;const thoughtIds=[];
const api=(path,method='GET',body)=>page.evaluate(async({path,method,body})=>{
  const response=await fetch(`/api/${path}`,{method,headers:{'Content-Type':'application/json','X-Journal':'1'},...(body?{body:JSON.stringify(body)}:{})});
  const data=await response.json();if(!response.ok)throw new Error(data.error);return data;
},{path,method,body});
try{
  await page.goto(origin);await page.locator('#password').fill(process.env.JOURNAL_TEST_PASSWORD);await page.locator('#unlock').click();await page.locator('#app').waitFor({state:'visible'});
  await page.locator('#journal-menu-toggle').click();await page.getByRole('link',{name:'read later',exact:true}).click();await page.locator('#reading').waitFor({state:'visible'});
  const url=`https://example.com/walking?journal_test=${crypto.randomUUID()}`;
  await page.locator('#reading-url').fill(url);await page.locator('#reading-save').click();await page.locator('#reading-message').filter({hasText:'saved.'}).waitFor();
  const row=page.locator('.reading-item').filter({has:page.locator(`a[href="${url}"]`)});await row.waitFor();savedId=await row.getAttribute('data-id');
  await page.screenshot({path:`${artifacts}/reading-desktop.png`,fullPage:true});
  await page.reload();await page.locator(`.reading-item[data-id="${savedId}"]`).waitFor();
  await page.locator('#reading-url').fill(url);await page.locator('#reading-save').click();await page.locator('#reading-message').filter({hasText:'already saved.'}).waitFor();
  assert.equal(await page.locator(`.reading-item[data-id="${savedId}"]`).count(),1);
  await row.getByRole('button',{name:'mark read',exact:true}).click();await row.waitFor({state:'detached'});
  await page.locator('[data-reading-filter=read]').click();await row.waitFor();await row.getByRole('button',{name:'mark unread',exact:true}).click();await row.waitFor({state:'detached'});
  await page.locator('[data-reading-filter=unread]').click();await row.waitFor();
  await page.setViewportSize({width:320,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await page.screenshot({path:`${artifacts}/reading-mobile.png`,fullPage:true});
  const source=(await api('thoughts','POST',{id:crypto.randomUUID(),body:'sample thought: walking a quiet trail changes my ideas.'})).entry;thoughtIds.push(source.id);
  const target=(await api('thoughts','POST',{id:crypto.randomUUID(),title:'a walking thought',body:'sample thought: quiet walking makes space for ideas.'})).entry;thoughtIds.push(target.id);
  await page.evaluate(id=>{location.hash=`thought/${id}`;},source.id);await page.locator('#reader-content').getByText(source.body,{exact:true}).waitFor();
  await page.locator(`#related a[href="${url}"]`).waitFor();await page.locator('#related button').filter({hasText:target.title}).waitFor();
  await page.screenshot({path:`${artifacts}/related-mobile.png`,fullPage:true});
  const readerBefore=await page.locator('#reader-content').boundingBox();
  await page.locator('#reader-edit').click();await page.locator('#related').waitFor({state:'hidden'});
  await page.locator('#reader-cancel').click();await page.locator('#related').waitFor({state:'visible'});
  assert.deepEqual(await page.locator('#reader-content').boundingBox(),readerBefore,'related suggestions do not move the writing');
  await page.locator('#related button').filter({hasText:target.title}).click();await page.getByRole('heading',{name:target.title,exact:true}).waitFor();
  await page.locator('#reader-back').click();await page.locator('#reader-content').getByText(source.body,{exact:true}).waitFor();
  await page.evaluate(()=>{location.hash='reading';});await row.waitFor();
  await row.getByRole('button',{name:'remove',exact:true}).click();assert.equal(await row.count(),1);await row.getByRole('button',{name:'remove link?',exact:true}).click();await row.waitFor({state:'detached'});savedId=null;
  await page.reload();assert.equal((await api('reading')).entries.some(entry=>entry.url===url),false);
  assert.deepEqual(errors,[]);console.log(JSON.stringify({passed:true,checks:['private reading page','save and reload','duplicate handling','mark read/unread','remove confirmation','related saved links and thoughts','edit stability','back navigation','320px layout'],screenshots:artifacts}));
}catch(error){await page.screenshot({path:`${artifacts}/failure.png`,fullPage:true}).catch(()=>{});throw error;}
finally{if(savedId)await api(`reading/${savedId}`,'DELETE').catch(()=>{});for(const id of thoughtIds)await api(`thoughts/${id}`,'DELETE').catch(()=>{});await browser.close();}
