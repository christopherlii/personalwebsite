import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import worker from '../worker.mjs';
import { passwordHash, digest, COOKIE } from '../auth.mjs';
import { ftsQuery } from '../search.mjs';
import { chunksOf, DIMENSIONS, indexEntry, maximumSimilarity, RELATED_SIMILARITY } from '../semantic.mjs';
import { thoughtLink, thoughtLinks, plainThoughtLinks } from '../public/thought-links.js';
import { readingURL, readingMetadata, fetchReadingMetadata, indexReading, relatedToThought } from '../reading.mjs';
import { tagNames, markdownTags } from '../public/tags.js';
import { indexTags } from '../tags.mjs';
import { imageInfo } from '../photos.mjs';
import { photoSource } from '../public/photo-links.js';

const password = 'a-test-only-passphrase-that-is-not-a-secret';
const salt = '12'.repeat(16);
const config = `pbkdf2-sha256$100000$${salt}$${await passwordHash(password, salt)}`;

function database() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON;');
  for (const file of readdirSync(new URL('../migrations/', import.meta.url)).sort()) sqlite.exec(readFileSync(new URL(`../migrations/${file}`, import.meta.url), 'utf8'));
  const prepare = sql => {
    let args = [];
    return {
      bind(...values) { args = values.map(value => value instanceof ArrayBuffer ? new Uint8Array(value) : value); return this; },
      async first() { return sqlite.prepare(sql).get(...args) || null; },
      async all() { return { results: sqlite.prepare(sql).all(...args) }; },
      async run() { sqlite.prepare(sql).run(...args); return { success: true }; },
      execute() { return { results: sqlite.prepare(sql).all(...args) }; }
    };
  };
  return { prepare, sqlite, async batch(statements) {
    sqlite.exec('BEGIN');
    try { const result = statements.map(statement => statement.execute()); sqlite.exec('COMMIT'); return result; }
    catch (error) { sqlite.exec('ROLLBACK'); throw error; }
  } };
}

function client(env = { JOURNAL_DB: database(), JOURNAL_PASSWORD_HASH: config }, origin = 'https://journal.example') {
  let cookie = '';
  return { env, setCookie(value) { cookie = value; }, async call(path, method = 'GET', body, headers = {}) {
    const response = await worker.fetch(new Request(`${origin}${path}`, {
      method, headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json', 'X-Journal': '1', ...headers },
      ...(body === undefined ? {} : { body: body instanceof Uint8Array ? body : JSON.stringify(body) })
    }), env);
    if (response.headers.has('Set-Cookie')) cookie = response.headers.get('Set-Cookie').split(';')[0];
    if(response.headers.get('Content-Type')?.startsWith('image/'))return{status:response.status,headers:response.headers,data:new Uint8Array(await response.arrayBuffer())};
    const raw = await response.text();
    let data;
    try { data = JSON.parse(raw); } catch { data = raw; }
    return { status: response.status, headers: response.headers, data };
  }, async login() { return this.call('/api/login', 'POST', { password }); } };
}
const thought = body => ({ id: crypto.randomUUID(), body });
const publicDraft = (body = 'the public version') => ({ slug: 'a-public-note', title: 'a public note', body, date: '2026-10-17', tags: ['writing'], description: 'a public description', cover: '/static/images/blogs/example/cover.jpg', coverPosition: 'center 40%' });

test('essay drafts share the timeline and retain their original identity and start date when edited or posted',async()=>{
  const c=client();await c.login();
  const input={id:crypto.randomUUID(),title:'an unfinished essay',body:'  a first paragraph\n\n',is_draft:true};
  const created=await c.call('/api/thoughts','POST',input);assert.equal(created.status,201);const draft=created.data.entry;
  assert.equal(draft.is_draft,1);assert.equal(draft.revision,0);assert.equal(draft.body,input.body);
  assert.equal((await c.call('/api/thoughts','POST',input)).status,200,'creation retry does not duplicate the draft');
  const second=(await c.call('/api/thoughts','POST',{...thought('another essay in progress'),is_draft:true})).data.entry;
  const posted=(await c.call('/api/thoughts','POST',thought('a later thought'))).data.entry;
  const saved=await c.call(`/api/thoughts/${draft.id}`,'PATCH',{body:'a first paragraph\n\nmore writing\n',title:'a developing essay',updated_at:draft.updated_at,revision:draft.revision});
  assert.equal(saved.status,200);assert.equal(saved.data.entry.is_draft,1);assert.equal(saved.data.entry.body.endsWith('\n'),true);assert.equal(saved.data.entry.revision,1);
  const finish={body:saved.data.entry.body,title:saved.data.entry.title,is_draft:false,updated_at:saved.data.entry.updated_at,revision:1};
  const finished=await c.call(`/api/thoughts/${draft.id}`,'PATCH',finish);assert.equal(finished.status,200);assert.equal(finished.data.entry.is_draft,0);
  assert.equal(finished.data.entry.id,draft.id);assert.equal(finished.data.entry.created_at,draft.created_at);assert.equal(finished.data.entry.seq,draft.seq);
  assert.equal((await c.call(`/api/thoughts/${draft.id}`,'PATCH',finish)).status,200,'posting retry is idempotent');
  assert.deepEqual((await c.call('/api/thoughts')).data.entries.map(e=>e.id),[posted.id,second.id,draft.id]);
  assert.equal((await c.call('/api/thoughts?q=progress')).data.entries[0].is_draft,1);
  assert.equal((await c.call('/api/export')).data.entries.find(e=>e.id===second.id).is_draft,1);
  c.env.JOURNAL_DB.sqlite.close();
});

test('essay autosave rejects stale revisions and cannot restore draft state after posting',async()=>{
  const c=client();await c.login();const entry=(await c.call('/api/thoughts','POST',{...thought('a draft'),is_draft:true})).data.entry;
  const input={body:'saved on another tab',updated_at:entry.updated_at,revision:entry.revision};
  assert.equal((await c.call(`/api/thoughts/${entry.id}`,'PATCH',{body:'no revision',updated_at:entry.updated_at})).status,400);
  const saved=(await c.call(`/api/thoughts/${entry.id}`,'PATCH',input)).data.entry;
  c.env.JOURNAL_DB.sqlite.prepare('UPDATE thoughts SET updated_at=? WHERE id=?').run(entry.updated_at,entry.id);
  assert.equal((await c.call(`/api/thoughts/${entry.id}`,'PATCH',{...input,body:'stale overwrite'})).status,409,'revision protects even identical timestamps');
  const finished=await c.call(`/api/thoughts/${entry.id}`,'PATCH',{body:saved.body,is_draft:false,updated_at:entry.updated_at,revision:saved.revision});assert.equal(finished.status,200);
  assert.equal((await c.call(`/api/thoughts/${entry.id}`,'PATCH',{...input,body:'late autosave'})).status,409);
  assert.equal((await c.call(`/api/thoughts/${entry.id}`,'PATCH',{body:saved.body,is_draft:true,updated_at:finished.data.entry.updated_at,revision:finished.data.entry.revision})).status,400);
  assert.equal((await c.call(`/api/thoughts/${entry.id}`)).data.entry.is_draft,0);c.env.JOURNAL_DB.sqlite.close();
});

test('unfinished essays cannot enter the public publishing flow',async()=>{
  const c=client();await c.login();const entry=(await c.call('/api/thoughts','POST',{...thought('private unfinished writing'),is_draft:true})).data.entry;
  const path=`/api/thoughts/${entry.id}/publication`;
  assert.equal((await c.call(path)).status,409);assert.equal((await c.call(path,'PUT',{draft:publicDraft(),version:0})).status,409);
  assert.deepEqual((await c.call('/public/posts/index.json')).data,[]);
  assert.equal((await c.call('/api/thoughts','POST',{...thought('invalid'),is_draft:'true'})).status,400);
  c.env.JOURNAL_DB.sqlite.close();
});

test('live dictation requires the owner session, same-origin upgrade, and an available binding',async()=>{
 const c=client(),upgrade={Upgrade:'websocket'};
 assert.equal((await c.call('/api/dictation','GET',undefined,upgrade)).status,401);await c.login();
 assert.equal((await c.call('/api/dictation','GET',undefined,{...upgrade,Origin:'https://elsewhere.example'})).status,403);
 assert.equal((await c.call('/api/dictation')).status,426);assert.equal((await c.call('/api/dictation','POST',{})).status,405);
 assert.equal((await c.call('/api/dictation','GET',undefined,upgrade)).status,503);
 c.env.AI={async run(){throw new Error('private provider error');}};const failed=await c.call('/api/dictation','GET',undefined,upgrade);assert.equal(failed.status,502);assert.equal(failed.data.error,'Live dictation is unavailable. Try again.');
 c.env.JOURNAL_DB.sqlite.close();
});

test('transcription requires authentication, CSRF, bounded audio, and never saves recordings',async()=>{
  const c=client(),audio=new Uint8Array([26,69,223,163,0,0,0,0,0,0,0,0]),headers={'Content-Type':'audio/webm;codecs=opus'};
  let calls=0;
  c.env.AI={async run(model,input){calls++;assert.equal(model,'@cf/openai/whisper-large-v3-turbo');assert.deepEqual(new Uint8Array(Buffer.from(input.audio,'base64')),audio);assert.equal(input.vad_filter,true);return{text:' a transcribed thought '};}};
  assert.equal((await c.call('/api/transcribe','POST',audio,headers)).status,401);await c.login();
  assert.equal((await c.call('/api/transcribe','POST',audio,{...headers,Origin:'https://elsewhere.example'})).status,403);
  assert.equal((await c.call('/api/transcribe','POST',audio,{'Content-Type':'application/json'})).status,415);
  assert.equal((await c.call('/api/transcribe','POST',new Uint8Array(2000001),headers)).status,413);
  assert.equal((await c.call('/api/transcribe','POST',new Uint8Array(16),headers)).status,415);assert.equal(calls,0);
  const response=await c.call('/api/transcribe','POST',audio,headers);assert.equal(response.status,200);assert.deepEqual(response.data,{text:'a transcribed thought'});assert.equal(calls,1);assert.equal(response.headers.get('Cache-Control'),'no-store');
  assert.deepEqual((await c.call('/api/thoughts')).data.entries,[]);assert.equal((await c.call('/api/draft')).data.body,'');
  c.env.AI.run=async()=>{throw new Error('private provider details');};const failed=await c.call('/api/transcribe','POST',audio,headers);assert.equal(failed.status,502);assert.equal(failed.data.error,'Could not transcribe. Try again.');
  delete c.env.AI;assert.equal((await c.call('/api/transcribe','POST',audio,headers)).status,503);c.env.JOURNAL_DB.sqlite.close();
});

test('photo uploads are private, bounded, immutable, export metadata, and become public only through published writing',async()=>{
  const c=client(),id=crypto.randomUUID(),path=`/api/photos/${id}`;
  const png=new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jP1sAAAAASUVORK5CYII=','base64'));
  const headers={'Content-Type':'image/png'};
  assert.equal((await c.call(path,'PUT',png,headers)).status,401);await c.login();
  assert.equal((await c.call(path,'PUT',png,{...headers,Origin:'https://elsewhere.example'})).status,403);
  const uploaded=await c.call(path,'PUT',png,headers);assert.equal(uploaded.status,201);assert.equal(uploaded.data.photo.width,1);
  assert.deepEqual((await c.call(path)).data,png);assert.equal((await c.call(path,'PUT',png,headers)).status,200);
  const changed=png.slice();changed[19]=2;assert.equal((await c.call(path,'PUT',changed,headers)).status,409);
  assert.equal((await c.call(`/api/photos/${crypto.randomUUID()}`,'PUT',new Uint8Array(1000001),headers)).status,413);
  assert.equal((await c.call(`/api/photos/${crypto.randomUUID()}`,'PUT',new TextEncoder().encode('<svg></svg>'),{'Content-Type':'image/svg+xml'})).status,415);
  assert.equal((await c.call(`/api/photos/${crypto.randomUUID()}`,'PUT',new Uint8Array([255,216,255,255,255,255]),{'Content-Type':'image/jpeg'})).status,415);
  const source=`![photo](${photoSource(uploaded.data.photo)})`;
  const entry=(await c.call('/api/thoughts','POST',thought(source))).data.entry;
  assert.equal((await c.call(path,'DELETE')).status,409);
  const guest=client(c.env),publicPath=`/public/photos/${id}`;
  assert.equal((await guest.call(path)).status,401);assert.equal((await guest.call(publicPath)).status,404);
  const publication=`/api/thoughts/${entry.id}/publication`;
  const draft=(await c.call(publication,'PUT',{draft:publicDraft(source),version:0})).data;
  const published=(await c.call(publication+'/publish','POST',{version:draft.version})).data;
  assert.equal((await guest.call(publicPath)).status,200);assert.equal((await guest.call(path)).status,401);
  assert.ok((await guest.call('/public/posts/a-public-note.md')).data.includes(`https://christopherli.dev/journal/public/photos/${id}`));
  assert.equal((await c.call(`/api/thoughts/${entry.id}`)).data.entry.body,source,'publishing preserves the private source');
  const manifest=(await c.call('/api/export')).data.photos[0];assert.equal(manifest.id,id);assert.equal(Object.hasOwn(manifest,'data'),false);
  await c.call(publication+'/unpublish','POST',{version:published.version});assert.equal((await guest.call(publicPath)).status,404);
  const after=await c.call(publication);
  const codeOnly=await c.call(publication,'PUT',{draft:publicDraft('`'+source+'`\n\n`https://christopherli.dev/journal'+publicPath+'`'),version:after.data.version});
  const codePublished=await c.call(publication+'/publish','POST',{version:codeOnly.data.version});
  assert.equal((await guest.call(publicPath)).status,404,'literal private syntax and public-address examples cannot expose a photo');
  await c.call(publication+'/unpublish','POST',{version:codePublished.data.version});
  await c.call(`/api/thoughts/${entry.id}`,'DELETE');assert.equal((await c.call(path,'DELETE')).status,200);
  assert.equal((await c.call(path)).status,404);assert.equal(imageInfo(new Uint8Array([1,2,3])),null);
});

test('tags respect Markdown contexts, Unicode, case, nesting, and exact source positions', () => {
  const source='# Heading\n\n#Ideas #IDEAS #life/notes #café #1984\n\n> quote #one\n> more #two\n\n- item #three\n\n| a | b |\n|---|---|\n|#four|#five|\n\n`#code` \\#escaped [link #hidden](https://example.com/#url)\n\n```\n#fenced\n```\n\n<div>#html</div>';
  assert.deepEqual(tagNames(source),['ideas','life/notes','café','one','two','three','four','five']);
  for(const match of markdownTags(source))assert.equal(source.slice(match.from,match.to),match.text);
  assert.deepEqual(tagNames(thoughtLink({id:crypto.randomUUID(),title:'#not-a-tag'})),[]);
});

test('tag filtering is private, exact, paginated, and repairs existing thoughts without stale edits', async () => {
  const c=client();assert.equal((await c.call('/api/thoughts?tag=ideas')).status,401);await c.login();
  const input=thought('sample thought #Ideas #ideas #life/notes');
  const saved=(await c.call('/api/thoughts','POST',input)).data.entry;
  const other=(await c.call('/api/thoughts','POST',thought('sample thought #ideas-more `#ideas`'))).data.entry;
  assert.deepEqual((await c.call('/api/thoughts?tag=IDEAS')).data.entries.map(row=>row.id),[saved.id]);
  assert.equal((await c.call('/api/thoughts?tag=life%2Fnotes')).data.entries[0].id,saved.id);
  assert.equal((await c.call('/api/thoughts?tag=1984')).status,400);
  assert.equal((await c.call('/api/thoughts?tag=a%20b')).status,400);
  await c.call(`/api/thoughts/${saved.id}`,'PATCH',{body:'changed #life',updated_at:saved.updated_at});
  await indexTags(saved,c.env);
  assert.equal((await c.call('/api/thoughts?tag=ideas')).data.entries.length,0,'an old indexing job cannot resurrect removed tags');
  assert.equal((await c.call('/api/thoughts?tag=life')).data.entries.length,1);
  for(let i=0;i<42;i++)await c.env.JOURNAL_DB.prepare('INSERT INTO thoughts(id,title,body,created_at,updated_at) VALUES(?,?,?,?,?)').bind(crypto.randomUUID(),'','legacy #archive',new Date().toISOString(),new Date().toISOString()).run();
  let page,calls=0;do{page=await c.call('/api/thoughts?tag=archive');calls++;}while(page.data.indexing);
  assert.ok(calls>1,'legacy indexing is bounded per request');assert.equal(page.data.entries.length,40);
  const second=await c.call(`/api/thoughts?tag=archive&cursor=${page.data.next}`);assert.equal(second.data.entries.length,2);
  await c.call(`/api/thoughts/${other.id}`,'DELETE');
  assert.equal((await c.call('/api/thoughts?tag=ideas-more')).data.entries.length,0);
  assert.equal((await c.call('/api/thoughts?tag=archive&saved=1')).data.entries.length,0);
});

test('saved reading stays private, deduplicates URLs, tracks read status, exports, and supplies related reading', async t => {
  const fetched=[];
  t.mock.method(globalThis,'fetch',async (url,options)=>{
    fetched.push(url); assert.equal(options.redirect,'manual');assert.equal(Object.hasOwn(options.headers,'Cookie'),false);
    return new Response('<title>Walking &amp; ideas</title><article><p>walking makes room for unfinished ideas.</p></article>',{headers:{'Content-Type':'text/html'}});
  });
  const c=client();
  assert.equal((await c.call('/api/reading')).status,401);
  assert.equal((await c.call('/api/reading','POST',{id:crypto.randomUUID(),url:'https://example.com/essay'})).status,401);
  await c.login();
  const input={id:crypto.randomUUID(),url:'https://example.com/essay?utm_source=email#section'};
  const saved=await c.call('/api/reading','POST',input);assert.equal(saved.status,201);assert.equal(saved.data.entry.title,'Walking & ideas');
  assert.equal(saved.data.entry.url,'https://example.com/essay');assert.equal(saved.data.entry.read_at,null);
  assert.equal((await c.call('/api/reading','POST',{...input,id:crypto.randomUUID(),url:'https://example.com/essay'})).data.existing,true);
  assert.equal(fetched.length,1,'a duplicate does not fetch again');
  assert.equal((await c.call('/api/reading','POST',{...input,url:'https://example.com/different'})).status,409);
  assert.equal((await c.call('/api/reading')).data.entries.length,1);
  const source=(await c.call('/api/thoughts','POST',thought('walking gives ideas room'))).data.entry;
  const related=(await c.call(`/api/thoughts/${source.id}/related`,'POST',{})).data;
  assert.equal(related.reading[0].id,input.id);assert.equal(related.thoughts.length,0,'the current thought is excluded');
  await c.call(`/api/reading/${input.id}`,'PATCH',{read:true});
  assert.equal((await c.call('/api/reading')).data.entries.length,0);
  assert.equal((await c.call('/api/reading?read=1')).data.entries.length,1);
  assert.equal((await c.call(`/api/thoughts/${source.id}/related`,'POST',{})).data.reading.length,1,'read articles remain in the matching collection');
  const exported=(await c.call('/api/export')).data.reading[0];assert.ok(exported.read_at);assert.ok(exported.excerpt.includes('unfinished ideas'));
  await c.call(`/api/reading/${input.id}`,'PATCH',{read:false});assert.equal((await c.call('/api/reading')).data.entries.length,1);
  assert.equal((await c.call('/api/reading?cursor=-1')).status,400);
  assert.equal((await c.call(`/api/reading/${input.id}`,'PATCH',{read:'yes'})).status,400);
  assert.equal((await c.call(`/api/reading/${input.id}`,'DELETE')).status,200);
  assert.equal((await c.call(`/api/reading/${input.id}`,'DELETE')).status,404);
  assert.equal((await c.call(`/api/thoughts/${source.id}/related`,'POST',{})).data.reading.length,0);
  assert.equal((await c.call('/public/reading')).status,404);
  await c.call('/api/logout','POST',{});assert.equal((await c.call('/api/reading?read=1')).status,401);
});

test('reading metadata is bounded plain text and unsafe destinations and redirects never fetch', async () => {
  for(const url of ['javascript:alert(1)','file:///etc/passwd','http://127.0.0.1/','http://2130706433/','https://[::1]/','https://localhost/','https://host.local/','https://user:pass@example.com/','https://example.com:8080/','https://christopherli.dev/journal/','https://private.workers.dev/'])assert.throws(()=>readingURL(url));
  const metadata=readingMetadata('<title>fallback</title><meta property="og:title" content="A &quot;title&quot;"><script><p>secret script</p></script><article><p>hello <em>world</em></p></article>');
  assert.equal(metadata.title,'A "title"');assert.equal(metadata.excerpt,'hello world');
  const calls=[];
  const redirected=await fetchReadingMetadata('https://example.com/',async url=>{calls.push(url);return new Response(null,{status:302,headers:{Location:'http://127.0.0.1/private'}});});
  assert.deepEqual(redirected,{});assert.equal(calls.length,1);
  assert.deepEqual(await fetchReadingMetadata('https://example.com/',async()=>{throw new Error('blocked');}),{});
  const large=await fetchReadingMetadata('https://example.com/',async()=>new Response('<title>bounded</title><p>'+ 'x'.repeat(300000)+'</p>',{headers:{'Content-Type':'text/html'}}));
  assert.equal(large.title,'bounded');assert.ok(large.excerpt.length<=8000);
});

test('related reading reuses stored semantic vectors without sending journal text to publishers', async () => {
  const c=client();await c.login();
  const entry=(await c.call('/api/thoughts','POST',thought('garden orchard'))).data.entry;
  c.env.AI={run:async(model,{text})=>({data:text.map(()=>[1,...Array(DIMENSIONS-1).fill(0)])})};
  await indexEntry(entry,c.env);
  const id=crypto.randomUUID();
  await c.env.JOURNAL_DB.prepare('INSERT INTO reading(id,url,title,excerpt,created_at) VALUES(?,?,?,?,?)').bind(id,'https://example.com/botany','Botany','Cultivating plants',new Date().toISOString()).run();
  await indexReading({id,title:'Botany',excerpt:'Cultivating plants'},c.env);
  c.env.AI.run=()=>{throw new Error('related lookup must reuse vectors');};
  assert.equal((await relatedToThought(entry.id,c.env)).reading[0].id,id);
  await c.env.JOURNAL_DB.prepare('DELETE FROM reading WHERE id=?').bind(id).run();
  assert.equal((await c.env.JOURNAL_DB.prepare('SELECT count(*) AS count FROM reading_embeddings').first()).count,0);
});


test('internal links use stable targets, suggest untitled thoughts privately, and never publish private targets', async () => {
  const c = client();
  assert.equal((await c.call('/api/link-suggestions?q=walking')).status, 401);
  await c.login();
  const target = (await c.call('/api/thoughts', 'POST', thought('walking helped me notice this'))).data.entry;
  const reference = thoughtLink(target);
  assert.equal(thoughtLinks(reference)[0].id, target.id);
  assert.equal(plainThoughtLinks(reference), target.body);
  assert.equal(plainThoughtLinks('[[just text]]'), '[[just text]]');
  assert.equal(thoughtLinks('[[javascript:alert(1)|unsafe]]').length, 0);
  assert.equal((await c.call('/api/link-suggestions?q=walk')).data.entries[0].id, target.id);
  assert.equal((await c.call(`/api/link-suggestions?q=walk&exclude=${target.id}`)).data.entries.length, 0);
  assert.equal((await c.call('/api/link-suggestions?exclude=invalid')).status, 400);
  assert.equal((await c.call('/api/link-suggestions?q=' + 'a'.repeat(161))).status, 400);
  const source = (await c.call('/api/thoughts', 'POST', thought(`return to ${reference}`))).data.entry;
  assert.equal(thoughtLinks(thoughtLink(source))[0].label, `return to ${target.body}`, 'untitled suggestions show linked words rather than nested target IDs');
  await c.call(`/api/thoughts/${target.id}`, 'PATCH', { title: 'a new title', body: target.body, updated_at: target.updated_at });
  assert.equal(thoughtLinks((await c.call(`/api/thoughts/${source.id}`)).data.entry.body)[0].id, target.id);
  const path = `/api/thoughts/${source.id}/publication`;
  assert.equal((await c.call(path)).data.draft.body, `return to ${target.body}`);
  const saved = await c.call(path, 'PUT', { draft: publicDraft(`return to ${reference}`), version: 0 });
  assert.equal(saved.data.draft.body, `return to ${target.body}`);
  await c.call(path + '/publish', 'POST', { version: saved.data.version });
  const published = (await c.call('/public/posts/a-public-note.md')).data;
  assert.ok(published.includes(target.body)); assert.ok(!published.includes(target.id));
  await c.call(`/api/thoughts/${target.id}`, 'DELETE');
  assert.equal((await c.call(`/api/thoughts/${target.id}`)).status, 404);
  assert.equal((await c.call(`/api/thoughts/${source.id}`)).data.entry.body, `return to ${reference}`, 'a deleted target cannot delete its referring thought');
});

test('thought status reflects live publication snapshots across reads, search, and bookmark changes', async () => {
  const c = client(); await c.login();
  const input = thought('status marker');
  const entry = (await c.call('/api/thoughts', 'POST', input)).data.entry;
  assert.equal(entry.published_slug, null);
  const path = `/api/thoughts/${entry.id}/publication`;
  const saved = await c.call(path, 'PUT', { draft: publicDraft(), version: 0 });
  assert.equal((await c.call(`/api/thoughts/${entry.id}`)).data.entry.published_slug, null, 'an unpublished draft is not published');
  const live = await c.call(path + '/publish', 'POST', { version: saved.data.version });
  assert.equal((await c.call('/api/thoughts')).data.entries[0].published_slug, 'a-public-note');
  assert.equal((await c.call(`/api/thoughts/${entry.id}`)).data.entry.published_title, 'a public note', 'an untitled private thought retains the required published name');
  assert.equal((await c.call('/api/thoughts?q=status')).data.entries[0].published_slug, 'a-public-note');
  assert.equal((await c.call('/api/search', 'POST', { query: 'status', saved: false, semantic: false })).data.entries[0].published_slug, 'a-public-note');
  const bookmarked = (await c.call(`/api/thoughts/${entry.id}`, 'PATCH', { bookmarked: true })).data.entry;
  assert.equal(bookmarked.bookmarked, 1); assert.equal(bookmarked.published_slug, 'a-public-note');
  assert.equal((await c.call('/api/thoughts', 'POST', input)).data.entry.published_slug, 'a-public-note', 'idempotent posting retains publication state');
  const revised = await c.call(path, 'PUT', { draft: publicDraft('a private revision'), version: live.data.version });
  assert.equal((await c.call(`/api/thoughts/${entry.id}`)).data.entry.published_slug, 'a-public-note', 'editing a draft keeps the live snapshot published');
  await c.call(path + '/unpublish', 'POST', { version: revised.data.version });
  assert.equal((await c.call(`/api/thoughts/${entry.id}`)).data.entry.published_slug, null);
  assert.equal((await c.call('/api/thoughts?saved=1')).data.entries[0].bookmarked, 1, 'unpublishing does not change the bookmark');
});

test('saved and liked toggle independently and survive reads, filters, and export', async () => {
  const c = client(); await c.login();
  const entry = (await c.call('/api/thoughts', 'POST', thought('marks marker'))).data.entry;
  assert.equal(entry.liked, 0); assert.equal(entry.bookmarked, 0);
  const liked = (await c.call(`/api/thoughts/${entry.id}`, 'PATCH', { liked: true })).data.entry;
  assert.equal(liked.liked, 1); assert.equal(liked.bookmarked, 0, 'liking does not save');
  const both = (await c.call(`/api/thoughts/${entry.id}`, 'PATCH', { bookmarked: true })).data.entry;
  assert.equal(both.liked, 1, 'saving keeps the like'); assert.equal(both.bookmarked, 1);
  assert.equal((await c.call(`/api/thoughts/${entry.id}`)).data.entry.liked, 1);
  assert.equal((await c.call('/api/thoughts?saved=1')).data.entries[0].liked, 1);
  assert.equal((await c.call('/api/search', 'POST', { query: 'marks', saved: false, semantic: false })).data.entries[0].liked, 1);
  assert.equal((await c.call('/api/export')).data.entries[0].liked, 1);
  const cleared = (await c.call(`/api/thoughts/${entry.id}`, 'PATCH', { liked: false, bookmarked: false })).data.entry;
  assert.equal(cleared.liked, 0); assert.equal(cleared.bookmarked, 0);
  for (const body of [{}, { liked: 'yes' }, { liked: true, bookmarked: 1 }, { pinned: true }]) assert.equal((await c.call(`/api/thoughts/${entry.id}`, 'PATCH', body)).status, 400);
});

test('editor styles use a fresh shell nonce while scripts and arbitrary inline styles stay restricted', async () => {
  const c = client();
  c.env.ASSETS = { fetch: async () => new Response('<!doctype html><html><head></head><body></body></html>', { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': '1', ETag: 'original' } }) };
  const first = await c.call('/');
  const second = await c.call('/journal/');
  const nonce = first.data.match(/name="editor-style-nonce" content="([a-f0-9]{64})"/)[1];
  assert.ok(first.headers.get('Content-Security-Policy').includes(`style-src 'self' 'nonce-${nonce}'`));
  assert.match(first.headers.get('Content-Security-Policy'), /script-src 'self';/);
  assert.doesNotMatch(first.headers.get('Content-Security-Policy'), /unsafe-inline|unsafe-eval/);
  assert.ok(!second.data.includes(nonce), 'each HTML response gets a new nonce');
  assert.equal(first.headers.has('Content-Length'), false);
  assert.equal(first.headers.has('ETag'), false);
  assert.doesNotMatch((await c.call('/api/session')).headers.get('Content-Security-Policy'), /nonce-/);
});

test('individual reading links require authentication and return the complete saved thought', async () => {
  const c = client();
  const input = { ...thought('a long private thought\n\n' + 'full writing. '.repeat(100)), title: '<private title>' };
  assert.equal((await c.call(`/api/thoughts/${input.id}`)).status, 401);
  await c.login();
  const created = await c.call('/api/thoughts', 'POST', input);
  assert.deepEqual((await c.call(`/api/thoughts/${input.id}`)).data.entry, created.data.entry);
  assert.equal((await c.call(`/api/thoughts/${crypto.randomUUID()}`)).status, 404);
  await c.call('/api/logout', 'POST', {});
  assert.equal((await c.call(`/api/thoughts/${input.id}`)).status, 401);
});

test('the journal runs under its domain path with the same authenticated API and assets', async () => {
  const c = client(undefined, 'https://christopherli.dev');
  c.env.ASSETS = { fetch: async request => new Response(new URL(request.url).pathname) };
  const redirect = await c.call('/journal?from=bookmark');
  assert.equal(redirect.status, 308);
  assert.equal(redirect.headers.get('Location'), 'https://christopherli.dev/journal/?from=bookmark');
  for (const path of ['/', '/journal.js', '/journal.css', '/fonts/fraunces-latin.woff2']) {
    assert.equal((await c.call('/journal' + path)).data, path);
  }
  assert.equal((await c.call('/journal/api/thoughts')).status, 401);
  assert.equal((await c.call('/journal/api/login', 'POST', { password })).status, 200);
  const entry = thought('a private thought behind the domain path');
  assert.equal((await c.call('/journal/api/thoughts', 'POST', entry)).status, 201);
  assert.equal((await c.call('/journal/api/thoughts')).data.entries[0].id, entry.id);
  assert.equal((await c.call('/journal/api/thoughts', 'POST', thought('cross-origin'), { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await c.call('/journal/api/logout', 'POST', {})).status, 200);
  assert.equal((await c.call('/journal/api/thoughts')).status, 401);
});

test('public-site paths retain their origin without forwarding the journal session cookie', async t => {
  const paths = [];
  t.mock.method(globalThis, 'fetch', async request => {
    paths.push(new URL(request.url).pathname);
    assert.equal(request.headers.get('Cookie'), 'theme=light');
    return new Response('public site');
  });
  for (const path of ['/journalism', '/journal-other', '/']) {
    const result = await worker.fetch(new Request('https://christopherli.dev' + path, { headers: { Cookie: `theme=light; ${COOKIE}=synthetic-session-token` } }), {});
    assert.equal(await result.text(), 'public site');
  }
  assert.deepEqual(paths, ['/journalism', '/journal-other', '/']);
  t.mock.method(globalThis, 'fetch', async request => {
    assert.equal(request.headers.has('Cookie'), false);
    return new Response('public site');
  });
  await worker.fetch(new Request('https://christopherli.dev/', { headers: { Cookie: `${COOKIE}=synthetic-session-token` } }), {});
});

test('publication editing and importing require owner authentication', async () => {
  const c = client();
  const id = crypto.randomUUID();
  for (const [path, method, input] of [
    [`/api/thoughts/${id}/publication`, 'GET'],
    [`/api/thoughts/${id}/publication`, 'PUT', { draft: publicDraft(), version: 0 }],
    [`/api/thoughts/${id}/publication/publish`, 'POST', { version: 1 }],
    [`/api/thoughts/${id}/publication/unpublish`, 'POST', { version: 1 }],
    ['/api/import', 'POST', {}],
  ]) assert.equal((await c.call(path, method, input)).status, 401);
  assert.deepEqual((await c.call('/public/posts/index.json')).data, []);
  assert.equal((await c.call('/public/posts/index.json', 'POST', {})).status, 405);
});

test('public writing exposes only explicit published snapshots, with independent edits and unpublishing', async () => {
  const owner = client(); await owner.login();
  const visitor = client(owner.env);
  const entry = (await owner.call('/api/thoughts', 'POST', { ...thought('a private memory that must stay private'), title: 'private title' })).data.entry;
  const path = `/api/thoughts/${entry.id}/publication`;
  const initial = await owner.call(path);
  assert.equal(initial.data.draft.body, entry.body);
  const saved = await owner.call(path, 'PUT', { draft: publicDraft(), version: 0 });
  assert.equal(saved.status, 200);
  assert.deepEqual((await visitor.call('/public/export.json')).data, { posts: [] });
  assert.equal((await visitor.call('/public/posts/a-public-note.md')).status, 404);
  const published = await owner.call(path + '/publish', 'POST', { version: saved.data.version });
  assert.equal(published.status, 200);
  const index = await visitor.call('/public/posts/index.json');
  assert.equal(index.headers.get('Access-Control-Allow-Origin'), '*');
  assert.equal(index.headers.get('Cache-Control'), 'no-store');
  assert.equal(index.data[0].file, 'a-public-note.md');
  assert.equal(index.data[0].title, 'a public note');
  assert.equal(Object.hasOwn(index.data[0], 'thought_id'), false);
  assert.equal(Object.hasOwn(index.data[0], 'body'), false);
  const publicText = (await visitor.call('/public/posts/a-public-note.md')).data;
  assert.match(publicText, /the public version/);
  assert.doesNotMatch(publicText, /private memory|private title/);
  const rss = await visitor.call('/public/feed.xml');
  assert.match(rss.headers.get('Content-Type'), /application\/rss\+xml/);
  assert.match(rss.data, /a public note/);
  assert.doesNotMatch(rss.data, /private memory/);
  assert.equal((await owner.call(`/api/thoughts/${entry.id}`, 'DELETE', {})).status, 409, 'deleting a private entry cannot silently delete its published version');
  await owner.call(`/api/thoughts/${entry.id}`, 'PATCH', { body: 'a changed private memory', updated_at: entry.updated_at });
  assert.equal((await visitor.call('/public/posts/a-public-note.md')).data, publicText, 'journal edits remain private');
  const draft = publicDraft('an unpublished revision'); draft.slug = 'a-new-address';
  const revised = await owner.call(path, 'PUT', { draft, version: published.data.version });
  assert.equal((await owner.call(path, 'PUT', { draft, version: published.data.version })).status, 409, 'another tab cannot overwrite a newer public draft');
  assert.equal((await visitor.call('/public/posts/a-public-note.md')).data, publicText, 'saving public drafts does not update the snapshot');
  assert.equal((await visitor.call('/public/posts/a-new-address.md')).status, 404);
  assert.equal((await owner.call(path + '/publish', 'POST', { version: published.data.version })).status, 409);
  const update = await owner.call(path + '/publish', 'POST', { version: revised.data.version });
  assert.match((await visitor.call('/public/posts/a-new-address.md')).data, /an unpublished revision/);
  assert.equal((await visitor.call('/public/posts/a-public-note.md')).status, 404);
  const archive = (await owner.call('/api/export')).data;
  assert.equal(archive.publications[0].draft.body, 'an unpublished revision');
  assert.equal(archive.publications[0].published.slug, 'a-new-address');
  assert.equal((await owner.call(path + '/unpublish', 'POST', { version: update.data.version })).status, 200);
  assert.equal((await visitor.call('/public/posts/a-new-address.md')).status, 404);
  assert.deepEqual((await visitor.call('/public/posts/index.json')).data, []);
  assert.deepEqual((await visitor.call('/public/export.json')).data.posts, []);
  assert.doesNotMatch((await visitor.call('/public/feed.xml')).data, /<item>/);
  assert.equal((await owner.call(path)).data.draft.body, draft.body, 'unpublishing retains the editable draft');
  assert.equal((await owner.call(`/api/thoughts/${entry.id}`, 'DELETE', {})).status, 200);
});

test('publication addresses are unique and validation prevents invalid metadata from reaching public routes', async () => {
  const c = client(); await c.login();
  const a = (await c.call('/api/thoughts', 'POST', thought('private a'))).data.entry;
  const b = (await c.call('/api/thoughts', 'POST', thought('private b'))).data.entry;
  const path = id => `/api/thoughts/${id}/publication`;
  const one = await c.call(path(a.id), 'PUT', { draft: publicDraft(), version: 0 });
  await c.call(path(a.id) + '/publish', 'POST', { version: one.data.version });
  const two = await c.call(path(b.id), 'PUT', { draft: publicDraft('another public draft'), version: 0 });
  assert.equal((await c.call(path(b.id) + '/publish', 'POST', { version: two.data.version })).status, 409);
  assert.match((await c.call('/public/posts/a-public-note.md')).data, /the public version/);
  for (const patch of [{ slug: '../private' }, { slug: 'x/y' }, { date: '2026-02-30' }, { date: 'invalid' }, { title: 'x'.repeat(161) }, { tags: 'not an array' }, { cover: 'file:///secret' }]) {
    assert.equal((await c.call(path(b.id), 'PUT', { draft: { ...publicDraft(), ...patch }, version: two.data.version })).status, 400);
  }
  const empty = await c.call(path(b.id), 'PUT', { draft: { ...publicDraft(), title: '' }, version: two.data.version });
  assert.equal((await c.call(path(b.id) + '/publish', 'POST', { version: empty.data.version })).status, 400);
  assert.equal((await c.call('/public/posts/unknown.md')).status, 404);
});

test('existing writing import preserves publication status and metadata without replacing later edits', async () => {
  const owner = client(); await owner.login();
  const imports = [
    { id: crypto.randomUUID(), source_key: 'site-content/posts/old-published.md', published: true, draft: { ...publicDraft('previously published text'), slug: 'old-published', date: '2024-01-17' } },
    { id: crypto.randomUUID(), source_key: 'site-content/posts/old_draft.md', published: false, draft: { ...publicDraft('an old private draft'), slug: 'old_draft' } },
  ];
  for (const data of imports) assert.equal((await owner.call('/api/import', 'POST', data)).status, 201);
  assert.equal((await owner.call('/api/import', 'POST', imports[0])).data.imported, false);
  const visitor = client(owner.env);
  assert.deepEqual((await visitor.call('/public/posts/index.json')).data.map(post => post.file), ['old-published.md']);
  assert.equal((await visitor.call('/public/posts/old_draft.md')).status, 404);
  assert.doesNotMatch(JSON.stringify((await visitor.call('/public/export.json')).data), /private draft/);
  const draft = (await owner.call(`/api/thoughts/${imports[1].id}/publication`)).data;
  assert.equal(draft.draft.coverPosition, 'center 40%');
  assert.equal(draft.published, null);
  const entry = (await owner.call('/api/thoughts')).data.entries.find(item => item.id === imports[0].id);
  assert.equal(entry.source_date, '2024-01-17', 'date-only source metadata does not invent a visible time');
  const revised = { ...imports[1].draft, body: 'a new private revision' };
  await owner.call(`/api/thoughts/${imports[1].id}/publication`, 'PUT', { draft: revised, version: draft.version });
  await owner.call('/api/import', 'POST', imports[1]);
  assert.equal((await owner.call(`/api/thoughts/${imports[1].id}/publication`)).data.draft.body, 'a new private revision');
  assert.equal((await owner.call('/api/export')).data.entries.length, 2);
});

test('every private read/write fails closed, including an unconfigured deployment', async () => {
  const c = client();
  for (const path of ['/api/thoughts', '/api/draft', '/api/export']) {
    const result = await c.call(path);
    assert.equal(result.status, 401);
    assert.equal(result.headers.get('Cache-Control'), 'no-store');
    assert.match(result.headers.get('Content-Security-Policy'), /frame-ancestors 'none'/);
    assert.equal(result.headers.get('X-Robots-Tag'), 'noindex, nofollow, noarchive');
  }
  assert.equal((await c.call('/api/thoughts', 'POST', thought('private'))).status, 401);
  const missing = client({});
  assert.deepEqual((await missing.call('/api/session')).data, { authenticated: false, ready: false });
  assert.equal((await missing.call('/api/login', 'POST', { password })).status, 503);
  assert.equal((await missing.call('/api/thoughts')).status, 503);
});

test('password login, CSRF protection, hashed sessions, logout, expiry, and password rotation', async () => {
  const c = client();
  assert.equal((await c.call('/api/login', 'POST', { password }, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await c.call('/api/login', 'POST', { password: 'wrong' })).status, 401);
  const login = await c.login();
  assert.equal(login.status, 200);
  const cookie = login.headers.get('Set-Cookie');
  assert.match(cookie, /HttpOnly; Secure; SameSite=Strict/);
  assert.ok(cookie.startsWith(`${COOKIE}=`));
  const token = cookie.split('=')[1].split(';')[0];
  const session = await c.env.JOURNAL_DB.prepare('SELECT * FROM sessions').first();
  assert.equal(session.token_hash, await digest(token));
  assert.equal((await c.call('/api/thoughts', 'POST', thought('no'), { 'X-Journal': '' })).status, 403);
  assert.equal((await c.call('/api/session')).data.authenticated, true);
  c.env.JOURNAL_PASSWORD_HASH = `pbkdf2-sha256$100000$${salt}$${'a'.repeat(64)}`;
  assert.equal((await c.call('/api/thoughts')).status, 401);
  c.env.JOURNAL_PASSWORD_HASH = config;
  await c.env.JOURNAL_DB.prepare('UPDATE sessions SET expires_at = 0').run();
  assert.equal((await c.call('/api/thoughts')).status, 401);
  await c.login();
  assert.equal((await c.call('/api/logout', 'POST', {})).status, 200);
  assert.equal((await c.call('/api/thoughts')).status, 401);
});

test('login attempts are limited in the database', async () => {
  const c = client();
  await c.env.JOURNAL_DB.prepare('INSERT INTO login_limits VALUES (?, 8, ?)').bind(`login:${await digest('local')}`, Date.now() + 900000).run();
  assert.equal((await c.login()).status, 429);
});

test('thoughts survive sessions, post retries are idempotent, and drafts do not overwrite newer work', async () => {
  const c = client(); await c.login();
  const draft = await c.call('/api/draft', 'PUT', { body: 'a thought to keep', version: 0 });
  assert.equal(draft.data.version, 1);
  assert.equal((await c.call('/api/draft', 'PUT', { body: 'stale text', version: 0 })).status, 409);
  const data = thought('a thought to keep');
  const post = await c.call('/api/thoughts', 'POST', { ...data, draft_version: 1 });
  assert.equal(post.status, 201);
  assert.equal(post.data.draft.body, '');
  assert.equal((await c.call('/api/thoughts', 'POST', data)).status, 200);
  assert.equal((await c.call('/api/thoughts')).data.entries.length, 1);
  await c.call('/api/logout', 'POST', {}); await c.login();
  assert.equal((await c.call('/api/thoughts')).data.entries[0].body, data.body);
  const version = (await c.call('/api/draft')).data.version;
  await c.call('/api/draft', 'PUT', { body: 'a newer draft', version });
  const old = await c.call('/api/thoughts', 'POST', { ...thought('old device text'), draft_version: version });
  assert.equal(old.data.draft.body, 'a newer draft');
});

test('Unicode/prefix search, punctuation, bookmark filtering, editing, and deleted text indexing', async () => {
  const c = client(); await c.login();
  const a = (await c.call('/api/thoughts', 'POST', thought('café hopping after basketball'))).data.entry;
  const b = (await c.call('/api/thoughts', 'POST', thought('finishing a book'))).data.entry;
  assert.equal((await c.call('/api/thoughts?q=cafe')).data.entries[0].id, a.id);
  assert.equal((await c.call('/api/thoughts?q=basket')).data.entries.length, 1);
  const privateQuery = await c.call('/api/search', 'POST', { query: 'basketball '.repeat(100), saved: false, semantic: false });
  assert.equal(privateQuery.status, 200);
  assert.equal(privateQuery.data.entries[0].id, a.id);
  assert.equal((await c.call('/api/thoughts?q=%22%20OR%20%2A')).status, 200);
  assert.deepEqual((await c.call('/api/thoughts?q=%22%2A')).data.entries, []);
  assert.equal(ftsQuery('café "x"* OR'), '"café"* OR "x"*');
  assert.equal(ftsQuery('i want to remember a book'), '"want"* OR "remember"* OR "book"*');
  assert.equal(ftsQuery('start of blog', true), '"start"* AND "blog"*');
  assert.deepEqual((await c.call('/api/search', 'POST', { query: 'basketball book', saved: false, semantic: false })).data.entries, [], 'keyword fallback cannot include a thought matching just one word');
  await c.call(`/api/thoughts/${b.id}`, 'PATCH', { bookmarked: true });
  assert.deepEqual((await c.call('/api/thoughts?saved=1')).data.entries.map(e => e.id), [b.id]);
  await c.call(`/api/thoughts/${a.id}`, 'PATCH', { body: 'soccer instead', updated_at: a.updated_at });
  assert.equal((await c.call('/api/thoughts?q=cafe')).data.entries.length, 0);
  assert.equal((await c.call('/api/thoughts?q=soccer')).data.entries[0].id, a.id);
  assert.equal((await c.call(`/api/thoughts/${a.id}`, 'PATCH', { body: 'stale change', updated_at: a.updated_at })).status, 409);
  await c.call(`/api/thoughts/${a.id}`, 'DELETE', {});
  assert.equal((await c.call('/api/thoughts?q=soccer')).data.entries.length, 0);
});

test('timeline pagination preserves independent thoughts and deletion removes only one entry', async () => {
  const c = client(); await c.login();
  for (let i = 0; i < 45; i++) await c.call('/api/thoughts', 'POST', thought(`thought ${i}`));
  const page = (await c.call('/api/thoughts')).data;
  const next = (await c.call(`/api/thoughts?cursor=${page.next}`)).data;
  assert.equal(new Set([...page.entries, ...next.entries].map(e => e.id)).size, 45);
  await c.call(`/api/thoughts/${page.entries[0].id}`, 'DELETE', {});
  const remaining = (await c.call('/api/export')).data;
  assert.equal(remaining.entries.length, 44);
});

test('optional titles persist with drafts, participate in search, and invalidate edited embeddings', async () => {
  const c = client(); await c.login();
  const input = { title: 'quiet mornings', body: 'a little space to think' };
  const draft = (await c.call('/api/draft', 'PUT', { ...input, version: 0 })).data;
  assert.equal((await c.call('/api/draft')).data.title, input.title);
  const data = { ...thought(input.body), title: input.title, draft_version: draft.version };
  const post = await c.call('/api/thoughts', 'POST', data);
  assert.equal(post.status, 201);
  assert.equal(post.data.draft.title, '');
  assert.equal(post.data.draft.body, '');
  assert.equal((await c.call('/api/thoughts', 'POST', data)).status, 200);
  assert.equal((await c.call('/api/thoughts', 'POST', { ...data, title: 'changed title' })).status, 409);
  assert.equal((await c.call('/api/thoughts?q=morning')).data.entries[0].title, input.title);
  assert.equal((await c.call('/api/search', 'POST', { query: 'morning', saved: false, semantic: false })).data.entries[0].id, data.id);
  const embedded = [];
  c.env.AI = { async run(model, input) {
    embedded.push(...input.text);
    return { data: input.text.map(() => [1, ...Array(DIMENSIONS - 1).fill(0)]) };
  } };
  await indexEntry(post.data.entry, c.env);
  assert.equal(embedded[0], `${input.title}\n\n${input.body}`, 'semantic content includes the title');
  const edited = await c.call(`/api/thoughts/${data.id}`, 'PATCH', { title: 'evening walks', body: input.body, updated_at: post.data.entry.updated_at });
  assert.equal(edited.status, 200);
  assert.equal((await c.call('/api/thoughts?q=morning')).data.entries.length, 0);
  assert.equal((await c.call('/api/thoughts?q=evening')).data.entries[0].id, data.id);
  assert.equal(await c.env.JOURNAL_DB.prepare('SELECT * FROM embeddings WHERE thought_id = ?').bind(data.id).first(), null);
  await indexEntry(post.data.entry, c.env);
  assert.equal(await c.env.JOURNAL_DB.prepare('SELECT * FROM embeddings WHERE thought_id = ?').bind(data.id).first(), null, 'stale title cannot be indexed');
  assert.equal((await c.call('/api/export')).data.entries[0].title, 'evening walks');
  const version = (await c.call('/api/draft')).data.version;
  await c.call('/api/draft', 'PUT', { title: 'another device title', body: input.body, version });
  const conflict = await c.call('/api/thoughts', 'POST', { ...thought(input.body), title: input.title, draft_version: version + 1 });
  assert.equal(conflict.data.draft.title, 'another device title', 'posting cannot clear a differently titled draft');
  for (const title of ['x'.repeat(161), 'two\nlines', 42, null]) {
    assert.equal((await c.call('/api/thoughts', 'POST', { ...thought('body'), title })).status, 400);
  }
  await c.call(`/api/thoughts/${data.id}`, 'DELETE', {});
  assert.equal((await c.call('/api/thoughts?q=evening')).data.entries.length, 0);
});

test('title migration preserves existing entries, drafts, and their search index', () => {
  const db = new DatabaseSync(':memory:');
  const migrations = readdirSync(new URL('../migrations/', import.meta.url)).sort();
  for (const name of migrations.slice(0, 2)) db.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), 'utf8'));
  db.exec("INSERT INTO thoughts(id, body, created_at, updated_at) VALUES ('old-id', 'an existing memory', '2026-01-01', '2026-01-01'); UPDATE draft SET body = 'unfinished text', version = 7;");
  db.exec(readFileSync(new URL('../migrations/0003_titles.sql', import.meta.url), 'utf8'));
  assert.equal(db.prepare('SELECT body FROM thoughts').get().body, 'an existing memory');
  assert.equal(db.prepare('SELECT title FROM thoughts').get().title, '');
  assert.equal(db.prepare("SELECT count(*) AS n FROM thoughts_fts WHERE thoughts_fts MATCH 'memory'").get().n, 1);
  assert.deepEqual({ ...db.prepare('SELECT title, body, version FROM draft').get() }, { title: '', body: 'unfinished text', version: 7 });
  db.close();
});

test('HTML stays data, input limits are enforced, and exports include the private draft', async () => {
  const c = client(); await c.login();
  assert.equal((await c.call('/api/thoughts', 'POST', thought('   '))).status, 400);
  assert.equal((await c.call('/api/thoughts', 'POST', thought('x'.repeat(20001)))).status, 400);
  const body = '<img src=x onerror=alert(1)> https://example.com';
  await c.call('/api/thoughts', 'POST', thought(body));
  await c.call('/api/draft', 'PUT', { body: 'not posted', version: 0 });
  const exported = await c.call('/api/export');
  assert.equal(exported.data.entries[0].body, body);
  assert.equal(exported.data.draft.body, 'not posted');
  assert.equal(exported.headers.get('Cache-Control'), 'no-store');
});

test('semantic transport, ranking, indexing reuse, and stale-vector invalidation', async () => {
  // Deterministic vectors test our storage and retrieval pipeline, not the
  // hosted model's real-world recall quality. Live model testing needs auth.
  const calls = [];
  const ai = { async run(model, input) {
    calls.push(input.text);
    return { data: input.text.map(text => {
      const vector = Array(DIMENSIONS).fill(0);
      if (/worn out|exhausted|tired/i.test(text)) vector[0] = 1;
      else if (/soccer|sport/i.test(text)) vector[1] = 1;
      else vector[2] = 1;
      return vector;
    }) };
  } };
  const c = client(); c.env.AI = ai; await c.login();
  const a = (await c.call('/api/thoughts', 'POST', thought('i felt worn out after that week'))).data.entry;
  const b = (await c.call('/api/thoughts', 'POST', thought('soccer on sunday'))).data.entry;
  const search = await c.call('/api/search', 'POST', { query: 'exhausted', saved: false, cursor: 0 });
  assert.equal(search.status, 200);
  assert.equal(search.data.entries[0].id, a.id, 'vector match can recall an entry with no shared search words');
  assert.equal(search.data.entries.some(entry => entry.id === b.id), false);
  const previous = calls.length;
  await c.call('/api/search', 'POST', { query: 'tired', saved: false, cursor: 0 });
  assert.equal(calls.length, previous + 1, 'indexed thoughts are not embedded again on each search');
  assert.deepEqual(calls.at(-1), ['tired']);
  const longQuery = await c.call('/api/search', 'POST', { query: 'exhausted '.repeat(100), saved: false });
  assert.equal(longQuery.status, 200, 'a composed thought can exceed a short search-bar query');
  assert.equal(longQuery.data.entries[0].id, a.id);
  const edited = await c.call(`/api/thoughts/${a.id}`, 'PATCH', { body: 'soccer all afternoon', updated_at: a.updated_at });
  assert.equal((await c.env.JOURNAL_DB.prepare('SELECT * FROM embeddings WHERE thought_id = ?').bind(a.id).first()), null);
  await indexEntry(a, c.env);
  assert.equal((await c.env.JOURNAL_DB.prepare('SELECT * FROM embeddings WHERE thought_id = ?').bind(a.id).first()), null, 'old indexing job cannot restore an edited-away meaning');
  await indexEntry(edited.data.entry, c.env);
  assert.equal((await c.call('/api/search', 'POST', { query: 'exhausted', saved: false })).data.entries.length, 0);
  await c.call(`/api/thoughts/${a.id}`, 'PATCH', { bookmarked: true });
  assert.deepEqual((await c.call('/api/search', 'POST', { query: 'sport', saved: true })).data.entries.map(entry => entry.id), [a.id]);
  await c.call(`/api/thoughts/${a.id}`, 'DELETE', {});
  assert.equal((await c.env.JOURNAL_DB.prepare('SELECT * FROM embeddings WHERE thought_id = ?').bind(a.id).first()), null);
});

test('typing search ranks like related thoughts: meaning matches without shared words, fused with word matches', async () => {
  const c = client(); await c.login();
  // Axis 0 is "starting to write", 1 is basketball, 3 is spaceships. The
  // sunday thought leans toward writing but stays just under the line.
  const near = RELATED_SIMILARITY - 0.01;
  const vector = text => /first (post|entry)|writ|blog/i.test(text) ? [1, 0, 0, 0] : /basketball/i.test(text) ? [0, 1, 0, 0]
    : /spaceship/i.test(text) ? [0, 0, 0, 1] : [near, 0, Math.sqrt(1 - near * near), 0];
  c.env.AI = { async run(model, input) { return { data: input.text.map(text => [...vector(text), ...Array(DIMENSIONS - 4).fill(0)]) }; } };
  const unrelated = (await c.call('/api/thoughts', 'POST', thought('practicing basketball after school'))).data.entry;
  const paraphrase = (await c.call('/api/thoughts', 'POST', thought('my first entry about why i want to write publicly'))).data.entry;
  const both = (await c.call('/api/thoughts', 'POST', thought('my first post: starting a blog'))).data.entry;
  const weak = (await c.call('/api/thoughts', 'POST', thought('a quiet sunday morning'))).data.entry;
  const result = await c.call('/api/search', 'POST', { query: 'starting a blog', saved: false });
  assert.equal(result.status, 200);
  const ids = result.data.entries.map(entry => entry.id);
  assert.equal(ids[0], both.id, 'a thought close in meaning and sharing words ranks first');
  assert.ok(ids.includes(paraphrase.id), 'a thought close in meaning is found without sharing a word');
  assert.ok(!ids.includes(unrelated.id) && !ids.includes(weak.id), 'vectors below the related-thoughts line stay out');
  assert.equal(result.data.next, null);
  const empty = await c.call('/api/search', 'POST', { query: 'repairing a spaceship', saved: false });
  assert.deepEqual(empty.data.entries, [], 'nothing close in meaning or words returns no thoughts');
});

test('typing search finds a meaning near the end of a long essay by its closest passage', async () => {
  const c = client(); await c.login();
  c.env.AI = { async run(model, input) {
    return { data: input.text.map(text => /first post|start of blog/.test(text) ? [1, ...Array(DIMENSIONS - 1).fill(0)] : [0, 1, ...Array(DIMENSIONS - 2).fill(0)]) };
  } };
  const essay = (await c.call('/api/thoughts', 'POST', thought('a memory of walking home after class. '.repeat(100) + '\n\nmy first post: beginning a personal space.'))).data.entry;
  const result = await c.call('/api/search', 'POST', { query: 'start of blog', saved: false });
  assert.deepEqual(result.data.entries.map(entry => entry.id), [essay.id]);
});

test('semantic chunks preserve long Unicode inputs and provider failure is explicit', async () => {
  const text = '漢字🌱 '.repeat(1200) + 'the final thought';
  const chunks = chunksOf(text);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every(chunk => new TextEncoder().encode(chunk).length <= 400));
  assert.ok(chunks.at(-1).endsWith('the final thought'));
  assert.equal(maximumSimilarity([1, 0], new Float32Array([0, 1, 1, 0]), 2, 2), 1);
  const c = client(); await c.login();
  assert.equal((await c.call('/api/search', 'POST', { query: 'hello', saved: false })).status, 503);
  c.env.AI = { async run() { throw new Error('private provider failure details'); } };
  const failed = await c.call('/api/search', 'POST', { query: 'hello', saved: false });
  assert.equal(failed.status, 502);
  assert.equal(failed.data.error, 'Related search is unavailable.');
});
