import { COOKIE, digest, hex, sessionFor, sessionCookie, SESSION_SECONDS, validPasswordConfig, verifyPassword } from './auth.mjs';
import { ftsQuery, THOUGHT_FIELDS } from './search.mjs';
import { indexEntry, semanticSearch } from './semantic.mjs';
import { PublicationError, publicationApi, publicWriting } from './publications.mjs';
import { ReadingError, readingApi, relatedToThought } from './reading.mjs';
import { indexTags, repairTagIndex } from './tags.mjs';
import { normalizeTag } from './public/tags.js';
import { photoApi, PhotoError } from './photos.mjs';
import { TranscriptionError, transcribe } from './transcription.mjs';
import { liveDictation } from './live-dictation.mjs';
import { IdeaError, ideaApi, indexIdeas } from './ideas.mjs';
import { GoalError, goalApi } from './goals.mjs';
import { DocumentError, documentApi } from './documents.mjs';

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const thoughtColumns = THOUGHT_FIELDS.join(', ');
const thoughtSelect = THOUGHT_FIELDS.map(field => `t.${field}`).join(', ');
const fail = (status, message) => { throw new HttpError(status, message); };
const json = (value, status = 200, headers = {}) => Response.json(value, { status, headers });
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
const integer = (value, fallback = 0) => value === null || value === undefined ? fallback : /^\d{1,15}$/.test(String(value)) ? Number(value) : fail(400, 'Invalid page.');

async function readBody(request) {
  if (!request.headers.get('Content-Type')?.startsWith('application/json')) fail(415, 'Expected JSON.');
  // Read with an actual byte limit; Content-Length alone is not trustworthy.
  const reader = request.body?.getReader();
  if (!reader) fail(400, 'Missing request.');
  const chunks = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.length;
    if (length > 180000) { await reader.cancel(); fail(413, 'This thought is too long.'); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try {
    const value = JSON.parse(new TextDecoder().decode(bytes));
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail(400, 'Invalid request.');
    return value;
  } catch { fail(400, 'Invalid JSON.'); }
}

function bodyText(value, allowEmpty = false) {
  if (typeof value !== 'string' || value.length > 20000 || (!allowEmpty && !value.trim())) fail(400, 'Write a thought of up to 20,000 characters.');
  return value;
}

function titleText(value = '') {
  if (typeof value !== 'string' || value.length > 160 || /[\r\n]/.test(value)) fail(400, 'Use a title of up to 160 characters.');
  return value;
}

async function limit(env, key, maximum, milliseconds) {
  const now = Date.now();
  const row = await env.JOURNAL_DB.prepare(`INSERT INTO login_limits(key, attempts, reset_at) VALUES (?, 1, ?)
    ON CONFLICT(key) DO UPDATE SET attempts = CASE WHEN reset_at <= ? THEN 1 ELSE attempts + 1 END,
    reset_at = CASE WHEN reset_at <= ? THEN excluded.reset_at ELSE reset_at END RETURNING attempts`).bind(key, now + milliseconds, now, now).first();
  if (row.attempts > maximum) fail(429, 'Too many attempts. Try again later.');
}

async function withPublicationState(entries, env) {
  if (!entries.length) return entries;
  const { results } = await env.JOURNAL_DB.prepare(`SELECT thought_id, published_slug, json_extract(published, '$.title') AS published_title FROM publications
    WHERE published IS NOT NULL AND thought_id IN (${entries.map(() => '?').join(',')})`).bind(...entries.map(entry => entry.id)).all();
  const published = new Map(results.map(row => [row.thought_id, row]));
  return entries.map(entry => ({ ...entry, published_slug: published.get(entry.id)?.published_slug || null, published_title: published.get(entry.id)?.published_title || null }));
}

async function listThoughts(env, query, saved, cursor, tag = null) {
  const terms = ftsQuery(query, true);
  if (query && !terms) return { entries: [], next: null };
  let sql = `SELECT ${thoughtSelect} FROM thoughts t`;
  const where = [], args = [];
  if (query) { sql += ' JOIN thoughts_fts ON thoughts_fts.rowid = t.seq'; where.push('thoughts_fts MATCH ?'); args.push(terms); }
  if (saved) where.push('t.bookmarked = 1');
  if (tag) { where.push('EXISTS(SELECT 1 FROM thought_tags g WHERE g.thought_id=t.id AND g.tag=?)'); args.push(tag); }
  if (!query && cursor) { where.push('t.seq < ?'); args.push(cursor); }
  if (where.length) sql += ` WHERE ${where.join(' AND ')}`;
  sql += query ? ' ORDER BY bm25(thoughts_fts), t.seq DESC LIMIT 41 OFFSET ?' : ' ORDER BY t.seq DESC LIMIT 41';
  if (query) args.push(cursor);
  const { results } = await env.JOURNAL_DB.prepare(sql).bind(...args).all();
  return { entries: await withPublicationState(results.slice(0, 40), env), next: results.length > 40 ? (query ? cursor + 40 : results[39].seq) : null };
}

// A separate, add-only door for an outside assistant (instinct, over iMessage).
// Its key can create thoughts and nothing else: it can't read, list, or edit.
async function inbox(request, env, context) {
  if (!/^[a-f0-9]{64}$/.test(env.JOURNAL_INBOX_TOKEN_HASH || '')) fail(404, 'Not found.');
  if (request.method !== 'POST') fail(405, 'Method not allowed.');
  await limit(env, 'inbox:minute', 30, 60 * 1000);
  const token = (request.headers.get('Authorization') || '').match(/^Bearer ([A-Za-z0-9_-]{32,256})$/)?.[1];
  const presented = token ? await digest(token) : '0'.repeat(64);
  let difference = 0;
  for (let i = 0; i < 64; i++) difference |= presented.charCodeAt(i) ^ env.JOURNAL_INBOX_TOKEN_HASH.charCodeAt(i);
  if (!token || difference) fail(401, 'Invalid inbox key.');
  const data = await readBody(request);
  const body = bodyText(data.text ?? data.body).trim();
  const title = titleText(data.title ?? '').trim();
  const source = data.source === undefined ? 'imessage' : /^[a-z0-9 -]{1,24}$/.test(data.source) ? data.source : fail(400, 'Invalid source.');
  // A retried message with the same id is saved once.
  const id = data.id === undefined ? crypto.randomUUID() : uuid(data.id) ? data.id : fail(400, 'Invalid thought.');
  const existing = await env.JOURNAL_DB.prepare(`SELECT ${thoughtColumns} FROM thoughts WHERE id = ?`).bind(id).first();
  if (existing) {
    if (existing.body !== body || existing.title !== title) fail(409, 'This thought already exists.');
    return json({ ok: true, id, existing: true });
  }
  const now = new Date().toISOString();
  const entry = await env.JOURNAL_DB.prepare(`INSERT INTO thoughts(id, title, body, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING ${thoughtColumns}`)
    .bind(id, title, body, source, now, now).first();
  await indexTags(entry, env); await indexIdeas(entry, env);
  if (env.AI && context) context.waitUntil(indexEntry(entry, env).catch(() => {}));
  return json({ ok: true, id }, 201);
}

async function api(request, env, url, context) {
  const path = url.pathname;
  const configured = Boolean(env.JOURNAL_DB && validPasswordConfig(env.JOURNAL_PASSWORD_HASH));
  if (!configured) {
    if (path === '/api/session' && request.method === 'GET') return json({ authenticated: false, ready: false });
    fail(503, 'The journal is unavailable. Try again later.');
  }
  if (path === '/api/inbox') return inbox(request, env, context);
  if (!['GET', 'HEAD'].includes(request.method)) {
    if (request.headers.get('Origin') !== url.origin || request.headers.get('X-Journal') !== '1') fail(403, 'Request not allowed.');
  }
  const session = await sessionFor(request, env);
  if (path === '/api/session' && request.method === 'GET') {
    return json({ authenticated: Boolean(session), ready: true, semanticSearch: Boolean(session && env.AI) });
  }
  if (path === '/api/login' && request.method === 'POST') {
    await env.JOURNAL_DB.batch([
      env.JOURNAL_DB.prepare('DELETE FROM sessions WHERE expires_at <= ?').bind(Date.now()),
      env.JOURNAL_DB.prepare('DELETE FROM login_limits WHERE reset_at <= ?').bind(Date.now())
    ]);
    await limit(env, 'login:global', 100, 15 * 60 * 1000);
    await limit(env, `login:${await digest(request.headers.get('CF-Connecting-IP') || 'local')}`, 8, 15 * 60 * 1000);
    const data = await readBody(request);
    if (typeof data.password !== 'string' || data.password.length > 1024 || !await verifyPassword(data.password, env.JOURNAL_PASSWORD_HASH)) fail(401, 'Incorrect password.');
    const token = hex(crypto.getRandomValues(new Uint8Array(32)));
    await env.JOURNAL_DB.prepare('INSERT INTO sessions(token_hash, expires_at, password_version) VALUES (?, ?, ?)').bind(await digest(token), Date.now() + SESSION_SECONDS * 1000, await digest(env.JOURNAL_PASSWORD_HASH)).run();
    return json({ authenticated: true, semanticSearch: Boolean(env.AI) }, 200, { 'Set-Cookie': sessionCookie(token) });
  }
  if (!session) fail(401, 'Sign in to continue.');
  if(path==='/api/dictation'){
    if(request.method!=='GET')fail(405,'Method not allowed.');
    if(request.headers.get('Origin')!==url.origin)fail(403,'Request not allowed.');
    if(request.headers.get('Upgrade')?.toLowerCase()!=='websocket')fail(426,'Open a live dictation connection.');
    await limit(env,'dictation:minute',20,60000);await limit(env,'dictation:hour',300,3600000);
    return liveDictation(request,env,async()=>Boolean(await sessionFor(request,env)));
  }
  if(path==='/api/transcribe'){
    if(request.method!=='POST')fail(405,'Method not allowed.');
    await limit(env,'dictation:minute',20,60000);
    await limit(env,'dictation:hour',300,3600000);
    return transcribe(request,env);
  }
  if(path.startsWith('/api/photos/')&&request.method==='PUT')await limit(env,'photos:global',30,60*1000);
  const photo=await photoApi(request,env,path);if(photo)return photo;
  if (path === '/api/reading' && request.method === 'POST') await limit(env, 'reading:global', 30, 60 * 1000);
  const reading = await readingApi(request, env, path, readBody, context);
  if (reading) return reading;
  const related = path.match(/^\/api\/thoughts\/([a-f0-9-]+)\/related$/);
  if (related && uuid(related[1]) && request.method === 'POST') {
    const result = await relatedToThought(related[1], env);
    result.thoughts = await withPublicationState(result.thoughts, env);
    return json(result);
  }
  const idea = await ideaApi(request, env, path, readBody);
  if (idea) return idea;
  const goal = await goalApi(request, env, path, readBody);
  if (goal) return goal;
  const document = await documentApi(request, env, path, readBody, limit);
  if (document) return document;
  const publication = await publicationApi(request, env, path, readBody);
  if (publication) return publication;
  if (path === '/api/logout' && request.method === 'POST') {
    await env.JOURNAL_DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(session.token_hash).run();
    return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie('', 0) });
  }
  if (path === '/api/draft' && request.method === 'GET') return json(await env.JOURNAL_DB.prepare('SELECT title, body, version FROM draft WHERE id = 1').first());
  if (path === '/api/draft' && request.method === 'PUT') {
    const data = await readBody(request);
    bodyText(data.body, true);
    const title = titleText(data.title);
    if (!Number.isSafeInteger(data.version) || data.version < 0) fail(400, 'Invalid draft.');
    const updated = await env.JOURNAL_DB.prepare('UPDATE draft SET title = ?, body = ?, version = version + 1 WHERE id = 1 AND version = ? RETURNING title, body, version').bind(title, data.body, data.version).first();
    if (!updated) fail(409, 'Your draft changed on another device. Copy this text before reloading.');
    return json(updated);
  }
  if (path === '/api/search' && request.method === 'POST') {
    const data = await readBody(request);
    const query = typeof data.query === 'string' ? data.query.trim() : '';
    const cursor = integer(data.cursor);
    if (!query || query.length > 20200 || typeof data.saved !== 'boolean' || (data.semantic !== undefined && typeof data.semantic !== 'boolean')) fail(400, 'Invalid search.');
    if (data.semantic === false) return json({ ...await listThoughts(env, query, data.saved, cursor), indexing: false });
    if (!env.AI) fail(503, 'Related search is unavailable.');
    if (cursor > 400) fail(400, 'Invalid page.');
    await limit(env, 'search:global', 120, 60 * 1000);
    try {
      const result = await semanticSearch(query, data.saved, cursor, env);
      result.entries = await withPublicationState(result.entries, env);
      return json(result);
    }
    catch { fail(502, 'Related search is unavailable.'); }
  }
  if (path === '/api/link-suggestions' && request.method === 'GET') {
    const query = (url.searchParams.get('q') || '').trim();
    const exclude = url.searchParams.get('exclude') || '';
    if (query.length > 160 || (exclude && !uuid(exclude))) fail(400, 'Invalid thought lookup.');
    const terms = ftsQuery(query);
    if (query && !terms) return json({ entries: [] });
    const { results } = await env.JOURNAL_DB.prepare(`SELECT t.id, t.title, substr(t.body, 1, 200) AS body, t.created_at, t.source_date
      FROM thoughts t${terms ? ' JOIN thoughts_fts ON thoughts_fts.rowid = t.seq' : ''}
      WHERE t.id != ?${terms ? ' AND thoughts_fts MATCH ?' : ''}
      ORDER BY ${terms ? 'bm25(thoughts_fts), ' : ''}t.seq DESC LIMIT 8`).bind(exclude, ...(terms ? [terms] : [])).all();
    return json({ entries: results });
  }
  if (path === '/api/thoughts' && request.method === 'GET') {
    const query = (url.searchParams.get('q') || '').trim();
    if (query.length > 500) fail(400, 'Use a shorter search.');
    const saved = url.searchParams.get('saved') === '1';
    const cursor = integer(url.searchParams.get('cursor'));
    const rawTag=url.searchParams.get('tag'),tag=rawTag===null?null:normalizeTag(rawTag);
    if(rawTag!==null&&!tag)fail(400,'Invalid tag.');
    const indexing=tag?await repairTagIndex(env):false;
    return json({...await listThoughts(env, query, saved, cursor,tag),...(tag?{indexing}:{})});
  }
  if (path === '/api/thoughts' && request.method === 'POST') {
    const data = await readBody(request);
    if (data.is_draft !== undefined && typeof data.is_draft !== 'boolean') fail(400, 'Invalid draft state.');
    const isDraft = data.is_draft === true;
    const body = isDraft ? bodyText(data.body) : bodyText(data.body).trim();
    const title = isDraft ? titleText(data.title) : titleText(data.title).trim();
    if (!uuid(data.id)) fail(400, 'Invalid thought.');
    const existing = await env.JOURNAL_DB.prepare(`SELECT ${thoughtColumns} FROM thoughts WHERE id = ?`).bind(data.id).first();
    if (existing) {
      if (existing.body !== body || existing.title !== title || Boolean(existing.is_draft) !== isDraft) fail(409, 'This thought already exists.');
      await indexTags(existing,env); await indexIdeas(existing,env);
      return json({ entry: (await withPublicationState([existing], env))[0], draft: await env.JOURNAL_DB.prepare('SELECT title, body, version FROM draft WHERE id = 1').first() });
    }
    const now = new Date().toISOString();
    const statements = [env.JOURNAL_DB.prepare(`INSERT INTO thoughts(id, title, body, created_at, updated_at, is_draft) VALUES (?, ?, ?, ?, ?, ?) RETURNING ${thoughtColumns}`).bind(data.id, title, body, now, now, isDraft ? 1 : 0)];
    if (Number.isSafeInteger(data.draft_version)) statements.push(env.JOURNAL_DB.prepare("UPDATE draft SET title = '', body = '', version = version + 1 WHERE id = 1 AND version = ? AND body = ? AND title = ?").bind(data.draft_version, data.body, data.title || ''));
    const result = await env.JOURNAL_DB.batch(statements);
    await indexTags(result[0].results[0],env); await indexIdeas(result[0].results[0],env);
    if (!isDraft && env.AI && context) context.waitUntil(indexEntry(result[0].results[0], env).catch(() => {}));
    return json({ entry: { ...result[0].results[0], published_slug: null, published_title: null }, draft: await env.JOURNAL_DB.prepare('SELECT title, body, version FROM draft WHERE id = 1').first() }, 201);
  }
  if (path === '/api/thoughts/drafts' && request.method === 'GET') {
    const { results } = await env.JOURNAL_DB.prepare(`SELECT id, title, substr(body, 1, 200) AS body, updated_at FROM thoughts WHERE is_draft = 1 ORDER BY updated_at DESC LIMIT 50`).all();
    return json({ entries: results });
  }
  if (path === '/api/thoughts/random' && request.method === 'GET') {
    const entry = await env.JOURNAL_DB.prepare(`SELECT ${thoughtColumns} FROM thoughts ORDER BY RANDOM() LIMIT 1`).first();
    if (!entry) fail(404, 'No thoughts yet.');
    return json({ entry: (await withPublicationState([entry], env))[0] });
  }
  const thought = path.match(/^\/api\/thoughts\/([a-f0-9-]+)$/);
  if (thought && uuid(thought[1])) {
    const id = thought[1];
    if (request.method === 'GET') {
      const entry = await env.JOURNAL_DB.prepare(`SELECT ${thoughtColumns} FROM thoughts WHERE id = ?`).bind(id).first();
      if (!entry) fail(404, 'Thought not found.');
      return json({ entry: (await withPublicationState([entry], env))[0] });
    }
    if (request.method === 'PATCH') {
      const data = await readBody(request);
      let result;
      if (Object.hasOwn(data, 'body')) {
        const current = await env.JOURNAL_DB.prepare(`SELECT ${thoughtColumns} FROM thoughts WHERE id = ?`).bind(id).first();
        if (!current) fail(404, 'Thought not found.');
        if (Object.hasOwn(data, 'is_draft') && data.is_draft !== false) fail(400, 'Invalid draft state.');
        const finishing = data.is_draft === false;
        const body = current.is_draft && !finishing ? bodyText(data.body) : bodyText(data.body).trim();
        const title = Object.hasOwn(data, 'title') ? current.is_draft && !finishing ? titleText(data.title) : titleText(data.title).trim() : null;
        if (typeof data.updated_at !== 'string') fail(400, 'Missing thought version.');
        const revision = data.revision ?? null;
        if ((current.is_draft || finishing || revision !== null) && (!Number.isSafeInteger(revision) || revision < 0)) fail(400, 'Missing thought revision.');
        if (finishing && !current.is_draft && current.body === body && (title === null || current.title === title)) return json({ entry: (await withPublicationState([current], env))[0] });
        result = await env.JOURNAL_DB.prepare(`UPDATE thoughts SET title = COALESCE(?, title), body = ?, is_draft = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND updated_at = ? AND (? IS NULL OR revision = ?) RETURNING ${thoughtColumns}`).bind(title, body, finishing ? 0 : current.is_draft, new Date().toISOString(), id, data.updated_at, revision, revision).first();
        if (!result) fail(409, 'This thought changed. Reload before editing.');
        await indexTags(result,env); await indexIdeas(result,env);
        if (!result.is_draft && env.AI && context) context.waitUntil(indexEntry(result, env).catch(() => {}));
      } else {
        if (Object.hasOwn(data, 'is_draft')) fail(400, 'Include the draft text before posting.');
        // Saved (stored as bookmarked) and liked toggle independently.
        const marks = ['bookmarked', 'liked'].filter(field => Object.hasOwn(data, field));
        if (!marks.length || marks.some(field => typeof data[field] !== 'boolean')) fail(400, 'Invalid change.');
        result = await env.JOURNAL_DB.prepare(`UPDATE thoughts SET ${marks.map(field => `${field} = ?`).join(', ')} WHERE id = ? RETURNING ${thoughtColumns}`).bind(...marks.map(field => data[field] ? 1 : 0), id).first();
        if (!result) fail(404, 'Thought not found.');
      }
      return json({ entry: (await withPublicationState([result], env))[0] });
    }
    if (request.method === 'DELETE') {
      if (await env.JOURNAL_DB.prepare('SELECT thought_id FROM publications WHERE thought_id = ? AND published IS NOT NULL').bind(id).first()) fail(409, 'Unpublish this entry before deleting it.');
      const result = await env.JOURNAL_DB.prepare('DELETE FROM thoughts WHERE id = ? RETURNING id').bind(id).first();
      if (!result) fail(404, 'Thought not found.');
      return json({ ok: true });
    }
  }
  if (path === '/api/export' && request.method === 'GET') {
    const { results } = await env.JOURNAL_DB.prepare('SELECT id, title, body, bookmarked, liked, source, created_at, updated_at, source_date, is_draft, revision FROM thoughts ORDER BY seq').all();
    const draft = await env.JOURNAL_DB.prepare('SELECT title, body FROM draft WHERE id = 1').first();
    const publications = await env.JOURNAL_DB.prepare('SELECT * FROM publications').all();
    const reading = await env.JOURNAL_DB.prepare('SELECT id,url,title,excerpt,read_at,created_at FROM reading ORDER BY seq').all();
    const photos=await env.JOURNAL_DB.prepare('SELECT id,mime,width,height,bytes,created_at FROM photos ORDER BY created_at').all();
    const ideas = await env.JOURNAL_DB.prepare(`SELECT id, kind, text, thought_id, created_at, done_at, dismissed_at, 'line' AS origin FROM thought_ideas UNION ALL SELECT id, kind, text, context_id, created_at, done_at, NULL, 'loose' FROM loose_ideas ORDER BY created_at`).all();
    const goals = await env.JOURNAL_DB.prepare(`SELECT id, kind, text, created_at, done_at, (SELECT json_group_array(day) FROM (SELECT day FROM goal_days WHERE goal_id = goals.id ORDER BY day)) AS days FROM goals ORDER BY created_at`).all();
    const documents = await env.JOURNAL_DB.prepare('SELECT id, title, bytes, pages, page, created_at, opened_at FROM documents WHERE complete = 1 ORDER BY created_at').all();
    const annotations = await env.JOURNAL_DB.prepare('SELECT id, document_id, page, start, length, top, quote, kind, question, body, created_at FROM annotations ORDER BY created_at').all();
    return json({ format: 'christopher-journal-v2', exported_at: new Date().toISOString(), entries: results, draft,
      reading: reading.results,
      photos:photos.results,
      ideas: ideas.results,
      goals: goals.results.map(goal => ({ ...goal, days: JSON.parse(goal.days) })),
      documents: documents.results,
      annotations: annotations.results,
      publications: publications.results.map(row => ({ ...row, draft: JSON.parse(row.draft), published: row.published ? JSON.parse(row.published) : null }))
    }, 200, { 'Content-Disposition': 'attachment; filename="journal.json"' });
  }
  fail(404, 'Not found.');
}

export default {
  async fetch(request, env, context) {
    const url = new URL(request.url);
    const journalPath = url.pathname === '/journal' || url.pathname.startsWith('/journal/');
    // Public pages still come from GitHub Pages. The host-only journal cookie
    // uses Path=/, so remove it before forwarding any public-page request.
    if (url.hostname === 'christopherli.dev' && !journalPath) {
      const headers = new Headers(request.headers);
      const cookies = (headers.get('Cookie') || '').split(';').map(value => value.trim()).filter(value => value && value.split('=')[0] !== COOKIE);
      if (cookies.length) headers.set('Cookie', cookies.join('; '));
      else headers.delete('Cookie');
      return fetch(new Request(request, { headers }));
    }
    let response;
    try {
      if (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) fail(400, 'HTTPS is required.');
      if (url.pathname === '/journal') {
        if (!['GET', 'HEAD'].includes(request.method)) fail(404, 'Not found.');
        url.pathname = '/journal/';
        response = Response.redirect(url.toString(), 308);
      } else {
        if (journalPath) {
          url.pathname = url.pathname.slice('/journal'.length);
          request = new Request(url, request);
        }
        if (url.pathname.startsWith('/public/')) response = await publicWriting(request, env, url);
        else if (url.pathname.startsWith('/api/')) response = await api(request, env, url, context);
        else if (['GET', 'HEAD'].includes(request.method) && (['/', '/index.html', '/journal.css', '/journal.js', '/reading.js', '/commands.js', '/ideas.js', '/goals.js', '/study.js', '/vendor/pdf.min.mjs', '/vendor/pdf.worker.min.mjs', '/vendor/pdfjs-LICENSE.txt', '/dictation.js', '/photos.js', '/photo-links.js', '/tags.js', '/search-terms.js', '/markdown.js', '/thought-links.js', '/live-editor.js', '/vendor/live-editor-LICENSE.txt', '/vendor/marked.min.js', '/fonts/instrument-sans-latin.woff2', '/fonts/instrument-sans-latin-ext.woff2', '/fonts/fraunces-latin.woff2', '/fonts/fraunces-latin-ext.woff2'].includes(url.pathname) || /^\/vendor\/standard_fonts\/[A-Za-z-]+\.(?:pfb|ttf)$/.test(url.pathname))) response = await env.ASSETS.fetch(request);
        else fail(404, 'Not found.');
      }
    } catch (error) {
      const expected = error instanceof HttpError || error instanceof PublicationError || error instanceof ReadingError || error instanceof PhotoError || error instanceof IdeaError || error instanceof GoalError || error instanceof DocumentError || error instanceof TranscriptionError;
      response = json({ error: expected ? error.message : 'The journal is unavailable. Try again later.' }, expected ? error.status : 500);
    }
    if(response.status===101)return response;
    // CodeMirror mounts its base styles at runtime. Authorize only those
    // styles with a fresh nonce in the static shell, keeping inline scripts blocked.
    let styleNonce = '';
    if (request.method === 'GET' && response.ok && ['/', '/index.html'].includes(url.pathname) && response.headers.get('Content-Type')?.startsWith('text/html')) {
      styleNonce = hex(crypto.getRandomValues(new Uint8Array(32)));
      const html = (await response.text()).replace('<head>', `<head><meta name="editor-style-nonce" content="${styleNonce}">`);
      const headers = new Headers(response.headers); headers.delete('Content-Length'); headers.delete('ETag');
      response = new Response(html, { status: response.status, headers });
    }
    const output = new Response(response.body, response);
    output.headers.set('Cache-Control', 'no-store');
    if (!url.pathname.startsWith('/public/')) output.headers.set('X-Robots-Tag', 'noindex, nofollow, noarchive');
    else output.headers.set('Access-Control-Allow-Origin', '*');
    output.headers.set('Referrer-Policy', 'no-referrer');
    output.headers.set('X-Content-Type-Options', 'nosniff');
    output.headers.set('X-Frame-Options', 'DENY');
    output.headers.set('Content-Security-Policy', `default-src 'none'; script-src 'self'; style-src 'self'${styleNonce ? ` 'nonce-${styleNonce}'` : ''}; font-src 'self'; connect-src 'self' ${url.protocol==='https:'?'wss:':'ws:'}//${url.host}; img-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`);
    return request.method === 'HEAD' ? new Response(null, output) : output;
  }
};
