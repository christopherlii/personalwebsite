import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE || '@playwright/test');
const origin=process.env.JOURNAL_TEST_URL || 'http://localhost:8787';
if(!['localhost','127.0.0.1'].includes(new URL(origin).hostname))throw new Error('Study tests may only write locally.');
if(!process.env.JOURNAL_TEST_PASSWORD)throw new Error('Set a local test password.');
const artifacts=process.env.JOURNAL_TEST_ARTIFACTS || 'test-results/study';await mkdir(artifacts,{recursive:true});

// A synthetic two-page PDF with real text in standard (non-embedded) fonts.
function samplePdf(){
  const pages=[['Attention, briefly','We propose a new simple network architecture, the Transformer, based solely','on attention mechanisms, dispensing with recurrence and convolutions entirely.'],
    ['Why self-attention','Self-attention relates different positions of a single sequence','in order to compute a representation of the sequence.']];
  const esc=text=>text.replace(/[\\()]/g,match=>`\\${match}`);
  const objects=['<< /Type /Catalog /Pages 2 0 R >>',`<< /Type /Pages /Kids [${pages.map((_,i)=>`${5+2*i} 0 R`).join(' ')}] /Count ${pages.length} >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Times-Roman >>','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>'];
  pages.forEach(([title,...lines],i)=>{
    const content=['BT','/F2 20 Tf','72 720 Td',`(${esc(title)}) Tj`,'/F1 11 Tf','0 -36 Td',...lines.flatMap(line=>[`(${esc(line)}) Tj`,'0 -16 Td']),'ET'].join('\n');
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${6+2*i} 0 R >>`);
    objects.push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  });
  let out='%PDF-1.4\n';const offsets=objects.map((object,i)=>{const at=out.length;out+=`${i+1} 0 obj\n${object}\nendobj\n`;return at;});
  const xref=out.length;
  out+=`xref\n0 ${objects.length+1}\n0000000000 65535 f \n${offsets.map(at=>`${String(at).padStart(10,'0')} 00000 n \n`).join('')}`;
  out+=`trailer\n<< /Size ${objects.length+1} /Root 1 0 R /Info << /Title (Attention, briefly) >> >>\nstartxref\n${xref}\n%%EOF\n`;
  return [...new TextEncoder().encode(out)];
}

const browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{})});
const page=await browser.newPage({viewport:{width:1360,height:900}});page.setDefaultTimeout(12000);
const errors=[];page.on('pageerror',error=>errors.push(error.message));
// The local explain check expects one 503; anything else logged is a failure.
page.on('console',message=>{if(message.type()==='error'&&!message.text().includes('status of 503'))errors.push(message.text());});
const api=(path,method='GET',body)=>page.evaluate(async({path,method,body})=>{
  const response=await fetch(`./api/${path}`,{method,headers:{'Content-Type':'application/json','X-Journal':'1'},...(body?{body:JSON.stringify(body)}:{})});
  const data=await response.json();if(!response.ok)throw new Error(data.error);return data;
},{path,method,body});
const command=async text=>{await page.locator('#composer-editor .cm-content').click();await page.keyboard.type(text);await page.keyboard.press('Enter');};
// Select a phrase inside the first rendered page's text layer.
const select=phrase=>page.evaluate(phrase=>{
  const walker=document.createTreeWalker(document.querySelector('.study-page .textLayer'),NodeFilter.SHOW_TEXT);
  for(let text=walker.nextNode();text;text=walker.nextNode()){
    const at=text.data.indexOf(phrase);if(at<0)continue;
    const range=document.createRange();range.setStart(text,at);range.setEnd(text,at+phrase.length);
    getSelection().removeAllRanges();getSelection().addRange(range);return true;
  }
  return false;
},phrase);
let documentId=null;const goalIds=[];
try{
  await page.goto(origin);await page.locator('#password').fill(process.env.JOURNAL_TEST_PASSWORD);await page.locator('#unlock').click();await page.locator('#app').waitFor({state:'visible'});

  // Goals: set one from the command bar; it stays on the right and can be kept.
  const goalText=`run every morning ${crypto.randomUUID().slice(0,6)}`;
  await command(`/goal ${goalText}`);
  const goal=page.locator('#float-right .float-goal').filter({hasText:goalText});await goal.waitFor();
  goalIds.push(...(await api('goals')).goals.filter(item=>item.text===goalText).map(item=>item.id));
  assert.equal(await goal.locator('.float-date-idle').textContent(),'day 1');
  assert.equal(await page.locator('#body').inputValue(),'','the command leaves the writing empty');
  await goal.locator('.float-item').click();await page.locator('#float-right .float-goal.is-done').filter({hasText:goalText}).waitFor();
  await goal.locator('.float-item').click();await page.locator('#float-right .float-goal:not(.is-done)').filter({hasText:goalText}).waitFor();
  await page.reload();await page.locator('#app').waitFor({state:'visible'});
  await page.locator('#float-right .float-goal').filter({hasText:goalText}).waitFor();
  await page.screenshot({path:`${artifacts}/goals.png`});
  // Habits: kept by the day, with the last week as dots.
  const habitText=`stretch ${crypto.randomUUID().slice(0,6)}`;
  await command(`/habit ${habitText}`);
  const habit=page.locator('#float-right .float-goal').filter({hasText:habitText});await habit.waitFor();
  goalIds.push(...(await api('goals')).goals.filter(item=>item.text===habitText).map(item=>item.id));
  assert.deepEqual(await page.locator('#float-right .float-heading').allTextContents(),['habits','goals']);
  assert.equal(await habit.locator('.habit-day').count(),7);assert.equal(await habit.locator('.habit-day.is-kept').count(),0);
  await habit.locator('.float-item').hover();await habit.locator('.float-date-hint').filter({hasText:'press to mark today'}).waitFor();
  await habit.locator('.float-item').click();await habit.locator('.habit-day.is-kept').waitFor();
  assert.equal(await habit.locator('.habit-day').last().getAttribute('class'),'habit-day is-kept','today is the rightmost dot');
  assert.equal(await habit.locator('.habit-streak').textContent(),'done today');
  await page.screenshot({path:`${artifacts}/habits.png`,clip:{x:980,y:120,width:340,height:200}});
  await page.reload();await page.locator('#app').waitFor({state:'visible'});
  await page.locator('#float-right .float-goal').filter({hasText:habitText}).locator('.habit-day.is-kept').waitFor();
  await page.locator('#float-right .float-goal').filter({hasText:habitText}).locator('.float-item').click();
  await page.locator('#float-right .float-goal').filter({hasText:habitText}).locator('.habit-streak').waitFor({state:'detached'});
  await command('/cr');await page.locator('#float-right').waitFor({state:'hidden'});
  await command('/goals');await page.locator('#float-right .float-goal').filter({hasText:goalText}).waitFor();

  // Dropping a PDF on the writing adds it to reading instead of pasting it.
  await page.evaluate(bytes=>{
    const transfer=new DataTransfer();transfer.items.add(new File([new Uint8Array(bytes)],'attention.pdf',{type:'application/pdf'}));
    const target=document.querySelector('#composer-editor .cm-content');
    target.dispatchEvent(new DragEvent('dragover',{bubbles:true,cancelable:true,dataTransfer:transfer}));
    target.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:transfer,clientX:400,clientY:200}));
  },samplePdf());
  const row=page.locator('#float-left .float-idea').filter({hasText:'Attention, briefly'});await row.waitFor();
  assert.equal(await page.locator('#body').inputValue(),'','the PDF bytes never enter the writing');
  documentId=(await api('documents')).documents.find(item=>item.title==='Attention, briefly').id;
  assert.match(await row.locator('.float-date').textContent(),/pdf · p\. 1 of 2/);
  await page.screenshot({path:`${artifacts}/reading-float.png`});

  // Opening it leaves only the pages.
  await row.locator('.float-item').click();await page.locator('#study').waitFor({state:'visible'});
  assert.equal(await page.locator('#app').isHidden(),true);
  await page.locator('.study-page canvas').first().waitFor();await page.locator('.study-page .textLayer span').first().waitFor();
  assert.equal(await page.locator('.study-page').count(),2);
  assert.equal(await page.locator('#study-title').textContent(),'Attention, briefly');

  // A note on a selected passage sits in the margin beside it.
  assert.ok(await select('the Transformer'));await page.locator('#study-actions').waitFor({state:'visible'});
  await page.locator('#study-actions [data-study=note]').click();
  await page.locator('.study-note-field').waitFor();await page.keyboard.type('the name for the whole model');await page.keyboard.press('Enter');
  const note=page.locator('.study-note.is-note').filter({hasText:'the name for the whole model'});await note.waitFor();
  await page.waitForFunction(()=>!document.querySelector('.study-note.is-pending'));
  assert.equal(await page.evaluate(()=>CSS.highlights.get('study-note')?.size),1,'the passage is highlighted');
  const noteBox=await note.boundingBox(),sheetBox=await page.locator('.study-sheet').first().boundingBox();
  assert.ok(noteBox.x>sheetBox.x+sheetBox.width,'the note is in the margin');

  // Explain: the model's answer is a controlled fixture here.
  await page.route('**/api/documents/*/annotations',async route=>{
    const input=route.request().postDataJSON();
    if(route.request().method()!=='POST'||input.kind!=='ai')return route.continue();
    assert.ok(input.context.includes('recurrence and convolutions'),'the surrounding text goes with the passage');
    await route.fulfill({status:201,contentType:'application/json',body:JSON.stringify({annotation:{...input,document_id:documentId,question:input.question||'',body:'a mechanism that lets each word **look at** every other word.',created_at:new Date().toISOString()}})});
  });
  assert.ok(await select('attention mechanisms'));await page.locator('#study-actions').waitFor({state:'visible'});
  await page.locator('#study-actions [data-study=explain]').click();
  await page.locator('.study-note.is-ai').filter({hasText:'every other word'}).waitFor();
  assert.equal(await page.locator('.study-note.is-ai strong').textContent(),'look at');
  assert.ok(await select('recurrence'));await page.locator('#study-actions').waitFor({state:'visible'});
  await page.locator('#study-actions [data-study=ask]').click();await page.locator('.study-note-field').waitFor();
  await page.keyboard.type('what came before this?');await page.keyboard.press('Enter');
  await page.locator('.study-note.is-ai').filter({hasText:'what came before this?'}).waitFor();
  await page.screenshot({path:`${artifacts}/study-desktop.png`});
  await page.unroute('**/api/documents/*/annotations');

  // Without the AI binding locally, a real explain fails visibly and saves nothing.
  assert.ok(await select('dispensing'));await page.locator('#study-actions').waitFor({state:'visible'});
  await page.locator('#study-actions [data-study=explain]').click();
  await page.locator('.study-note.is-failed').filter({hasText:'Explain is unavailable here.'}).waitFor();
  await page.locator('.study-note.is-failed .study-note-remove').click();await page.locator('.study-note.is-failed').waitFor({state:'detached'});

  // Notes and the place in the PDF survive a reload.
  await page.evaluate(()=>document.querySelectorAll('.study-page')[1].scrollIntoView({block:'start'}));
  await page.locator('#study-position').filter({hasText:'2 / 2'}).waitFor();
  await page.waitForTimeout(1800);
  await page.reload();await page.locator('#study').waitFor({state:'visible'});
  await page.locator('.study-note.is-note').filter({hasText:'the name for the whole model'}).waitFor();
  await page.locator('#study-position').filter({hasText:'2 / 2'}).waitFor();
  await page.evaluate(()=>scrollTo(0,0));await page.waitForFunction(()=>CSS.highlights.get('study-note')?.size===1);

  // Escape leaves; the reading list counts the note.
  await page.keyboard.press('Escape');await page.locator('#app').waitFor({state:'visible'});
  assert.equal(await page.locator('#study').isHidden(),true);
  await command('/read');await page.locator('#float-left .float-idea').filter({hasText:'Attention, briefly'}).filter({hasText:'1 note'}).waitFor();

  // A narrow screen keeps the notes under each page.
  await page.locator('#float-left .float-item').filter({hasText:'Attention, briefly'}).click();await page.locator('.study-page canvas').first().waitFor();
  await page.setViewportSize({width:390,height:844});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await page.evaluate(()=>scrollTo(0,0));
  await page.screenshot({path:`${artifacts}/study-mobile.png`,fullPage:true});
  await page.setViewportSize({width:1360,height:900});

  // Removing a PDF takes a second press.
  await page.keyboard.press('Escape');await page.locator('#app').waitFor({state:'visible'});await command('/read');
  const listed=page.locator('#float-left .float-idea').filter({hasText:'Attention, briefly'});await listed.waitFor();
  await listed.hover();await listed.locator('.float-remove').click();await listed.filter({hasText:'press × again'}).waitFor();
  await listed.locator('.float-remove').click();await listed.waitFor({state:'detached'});documentId=null;
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({passed:true,checks:['goal command','day count','keep and reopen','habit command','week dots','mark and undo today','goals after reload','/cr and /goals','pdf drop on the writing','reading float','reading view','note in the margin','highlight','explain and ask (fixture)','explain failure','reload keeps notes and page','escape back','narrow layout','remove confirmation'],screenshots:artifacts}));
}catch(error){await page.screenshot({path:`${artifacts}/failure.png`,fullPage:true}).catch(()=>{});console.error(errors);throw error;}
finally{if(documentId)await api(`documents/${documentId}`,'DELETE').catch(()=>{});for(const id of goalIds)await api(`goals/${id}`,'DELETE').catch(()=>{});await browser.close();}
