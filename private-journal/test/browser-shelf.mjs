import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE || '@playwright/test');
const origin=process.env.JOURNAL_TEST_URL || 'http://localhost:8788';
if(!['localhost','127.0.0.1'].includes(new URL(origin).hostname)||!process.env.JOURNAL_TEST_PASSWORD)throw new Error('Use a local journal and test password.');
const artifacts=process.env.JOURNAL_TEST_ARTIFACTS||'test-results/shelf';await mkdir(artifacts,{recursive:true});
const browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{})});
const page=await browser.newPage({viewport:{width:1280,height:900}});page.setDefaultTimeout(15000);
const errors=[];page.on('pageerror',error=>errors.push(error.message));const works=[];
const api=(path,method='GET',body)=>page.evaluate(async({path,method,body})=>{
 const response=await fetch(`/api/${path}`,{method,headers:{'Content-Type':'application/json','X-Journal':'1'},...(body?{body:JSON.stringify(body)}:{})});const data=await response.json();if(!response.ok)throw new Error(data.error);return data;
},{path,method,body});
// A real (tiny) PDF: Helvetica text at given sizes, a running head and page
// numbers on every page, and an Info dictionary with a title and author.
function makePdf(pages,furniture=true){
 const escape=text=>text.replace(/[()\\]/g,'\\$&');
 const objects=['<< /Type /Catalog /Pages 2 0 R >>',null,'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>','<< /Title (A Long Walk) /Author (Sample Author) >>'],kids=[];
 pages.forEach((lines,index)=>{
  let y=700,stream=furniture?'BT\n/F1 9 Tf\n1 0 0 1 250 760 Tm\n(THE LONG WALK) Tj\n':'BT\n';
  for(const [size,text,after=1.4] of lines){stream+=`/F1 ${size} Tf\n1 0 0 1 72 ${y} Tm\n(${escape(text)}) Tj\n`;y-=size*after;}
  stream+=furniture?`/F1 9 Tf\n1 0 0 1 300 40 Tm\n(${index+1}) Tj\nET`:'ET';
  objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${objects.length+2} 0 R >>`);
  kids.push(`${objects.length} 0 R`);
  objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
 });
 objects[1]=`<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${pages.length} >>`;
 let out='%PDF-1.4\n';const offsets=[];
 objects.forEach((object,index)=>{offsets.push(out.length);out+=`${index+1} 0 obj\n${object}\nendobj\n`;});
 const xref=out.length;
 out+=`xref\n0 ${objects.length+1}\n0000000000 65535 f \n${offsets.map(offset=>`${String(offset).padStart(10,'0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length+1} /Root 1 0 R /Info 4 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
 return [...Buffer.from(out,'latin1')];
}
try{
 await page.goto(origin);await page.locator('#password').fill(process.env.JOURNAL_TEST_PASSWORD);await page.locator('#unlock').click();await page.locator('#app').waitFor({state:'visible'});
 const pdf=makePdf([
  [[22,'Chapter One',2.2],[11,'The road out of town was long and the'],[11,'morning was cold, and we walked for'],[11,'hours without stopping.',2.6],[11,'Later the sun came up over the ridge'],[11,'and the valley opened below us like'],[11,'a held breath.']],
  [[11,'Nobody spoke for a while after that,'],[11,'not even when the trail turned to'],[11,'gravel underfoot.',2.6],[15,'A Smaller Heading',2],[11,'Another paragraph begins here and'],[11,'runs onto a second line.']],
  [[11,'The end of the walk came quietly,'],[11,'the way endings do.']]
 ]);
 // Dropped on the writing field: photos let it pass, and it becomes a book.
 await page.locator('#composer-editor').evaluate((target,bytes)=>{
  const data=new DataTransfer();data.items.add(new File([new Uint8Array(bytes)],'a-long-walk.pdf',{type:'application/pdf'}));
  target.dispatchEvent(new DragEvent('drop',{dataTransfer:data,bubbles:true,cancelable:true}));
 },pdf);
 await page.waitForFunction(()=>location.hash.startsWith('#read/'),null,{timeout:30000});
 await page.locator('#work .work-title').waitFor();works.push(await page.evaluate(()=>location.hash.slice(6)));
 assert.equal(await page.locator('#work .work-title').textContent(),'A Long Walk');
 assert.equal(await page.locator('#work .work-meta').textContent(),'Sample Author · book');
 assert.deepEqual(await page.locator('#work-content h2').allTextContents(),['Chapter One']);
 assert.deepEqual(await page.locator('#work-content h3').allTextContents(),['A Smaller Heading']);
 assert.deepEqual(await page.locator('#work-content p:not(.work-meta)').allTextContents(),['The road out of town was long and the morning was cold, and we walked for hours without stopping.','Later the sun came up over the ridge and the valley opened below us like a held breath.','Nobody spoke for a while after that, not even when the trail turned to gravel underfoot.','Another paragraph begins here and runs onto a second line.','The end of the walk came quietly, the way endings do.'],'page numbers and the running head are gone');
 assert.equal(await page.locator('#app').isHidden(),true,'the reader is the only thing on the page');
 assert.equal(await page.locator('#body').inputValue(),'','the pdf never landed in the writing as a photo');
 await page.screenshot({path:`${artifacts}/reader.png`,fullPage:true});
 await page.locator('#work-back').click();await page.locator('#app').waitFor({state:'visible'});
 // Bare /read lists the shelf on the left.
 const composer=page.locator('#composer-editor .cm-content');await composer.click();await page.keyboard.type('/read');await page.keyboard.press('Enter');
 await page.waitForFunction(()=>document.querySelector('#float-left .float-heading')?.textContent==='reading');
 assert.ok((await page.locator('#float-left .float-text').allTextContents()).includes('A Long Walk'));
 await page.locator('#float-left .float-item',{hasText:'A Long Walk'}).click();await page.locator('#work .work-title').waitFor();
 assert.equal((await api(`works/${works[0]}`)).work.parts,1);
 // A scanned pdf with no text says so instead of making an empty book.
 await page.locator('#work-back').click();await page.locator('#app').waitFor({state:'visible'});
 await page.evaluate(bytes=>{const data=new DataTransfer();data.items.add(new File([new Uint8Array(bytes)],'scan.pdf',{type:'application/pdf'}));document.body.dispatchEvent(new DragEvent('drop',{dataTransfer:data,bubbles:true,cancelable:true}));},makePdf([[]],false));
 await page.waitForFunction(()=>document.querySelector('#notice').textContent.includes('scanned pages'));
 assert.equal((await api('works?status=reading')).works.length,1);
 assert.deepEqual(errors,[]);console.log(JSON.stringify({passed:true,checks:['pdf drop becomes a book','pdf drop passes the photo handler','clean reader with title and author','headings and paragraphs','page numbers and running heads removed','back','/read lists the shelf','textless pdf refused'],screenshots:artifacts}));
}catch(error){await page.screenshot({path:`${artifacts}/failure.png`,fullPage:true}).catch(()=>{});throw error;}
finally{for(const id of works)await api(`works/${id}`,'DELETE').catch(()=>{});await browser.close();}
