import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import worker from '../worker.mjs';
import { passwordHash, digest, COOKIE } from '../auth.mjs';
import { ftsQuery } from '../search.mjs';
import { chunksOf, DIMENSIONS, indexEntry, maximumSimilarity } from '../semantic.mjs';

const password = 'a-test-only-passphrase-that-is-not-a-secret';
const salt = '12'.repeat(16);
const config = `pbkdf2-sha256$600000$${salt}$${await passwordHash(password, salt)}`;

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

function client(env = { JOURNAL_DB: database(), JOURNAL_PASSWORD_HASH: config }) {
  let cookie = '';
  return { env, setCookie(value) { cookie = value; }, async call(path, method = 'GET', body, headers = {}) {
    const response = await worker.fetch(new Request(`https://journal.example${path}`, {
      method, headers: { Cookie: cookie, Origin: 'https://journal.example', 'Content-Type': 'application/json', 'X-Journal': '1', ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    }), env);
    if (response.headers.has('Set-Cookie')) cookie = response.headers.get('Set-Cookie').split(';')[0];
    return { status: response.status, headers: response.headers, data: await response.json() };
  }, async login() { return this.call('/api/login', 'POST', { password }); } };
}
const thought = body => ({ id: crypto.randomUUID(), body });

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
  c.env.JOURNAL_PASSWORD_HASH = `pbkdf2-sha256$600000$${salt}$${'a'.repeat(64)}`;
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
