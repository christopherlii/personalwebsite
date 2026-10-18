import { digest, hex, sessionFor, sessionCookie, SESSION_SECONDS, validPasswordConfig, verifyPassword } from './auth.mjs';
import { ftsQuery, THOUGHT_FIELDS } from './search.mjs';
import { indexEntry, semanticSearch } from './semantic.mjs';

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
    if (length > 90000) { await reader.cancel(); fail(413, 'This thought is too long.'); }
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

async function limit(env, key, maximum, milliseconds) {
  const now = Date.now();
  const row = await env.JOURNAL_DB.prepare(`INSERT INTO login_limits(key, attempts, reset_at) VALUES (?, 1, ?)
    ON CONFLICT(key) DO UPDATE SET attempts = CASE WHEN reset_at <= ? THEN 1 ELSE attempts + 1 END,
    reset_at = CASE WHEN reset_at <= ? THEN excluded.reset_at ELSE reset_at END RETURNING attempts`).bind(key, now + milliseconds, now, now).first();
  if (row.attempts > maximum) fail(429, 'Too many attempts. Try again later.');
}

async function listThoughts(env, query, saved, cursor) {
  const terms = ftsQuery(query);
  if (query && !terms) return { entries: [], next: null };
  let sql = `SELECT ${thoughtSelect} FROM thoughts t`;
  const where = [], args = [];
  if (query) { sql += ' JOIN thoughts_fts ON thoughts_fts.rowid = t.seq'; where.push('thoughts_fts MATCH ?'); args.push(terms); }
  if (saved) where.push('t.bookmarked = 1');
  if (!query && cursor) { where.push('t.seq < ?'); args.push(cursor); }
  if (where.length) sql += ` WHERE ${where.join(' AND ')}`;
  sql += query ? ' ORDER BY bm25(thoughts_fts), t.seq DESC LIMIT 41 OFFSET ?' : ' ORDER BY t.seq DESC LIMIT 41';
  if (query) args.push(cursor);
  const { results } = await env.JOURNAL_DB.prepare(sql).bind(...args).all();
  return { entries: results.slice(0, 40), next: results.length > 40 ? (query ? cursor + 40 : results[39].seq) : null };
}

async function api(request, env, url, context) {
  const path = url.pathname;
  const configured = Boolean(env.JOURNAL_DB && validPasswordConfig(env.JOURNAL_PASSWORD_HASH));
  if (!configured) {
    if (path === '/api/session' && request.method === 'GET') return json({ authenticated: false, ready: false });
    fail(503, 'The journal is unavailable. Try again later.');
  }
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
  if (path === '/api/logout' && request.method === 'POST') {
    await env.JOURNAL_DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(session.token_hash).run();
    return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie('', 0) });
  }
  if (path === '/api/draft' && request.method === 'GET') return json(await env.JOURNAL_DB.prepare('SELECT body, version FROM draft WHERE id = 1').first());
  if (path === '/api/draft' && request.method === 'PUT') {
    const data = await readBody(request);
    bodyText(data.body, true);
    if (!Number.isSafeInteger(data.version) || data.version < 0) fail(400, 'Invalid draft.');
    const updated = await env.JOURNAL_DB.prepare('UPDATE draft SET body = ?, version = version + 1 WHERE id = 1 AND version = ? RETURNING body, version').bind(data.body, data.version).first();
    if (!updated) fail(409, 'Your draft changed on another device. Copy this text before reloading.');
    return json(updated);
  }
  if (path === '/api/search' && request.method === 'POST') {
    const data = await readBody(request);
    const query = typeof data.query === 'string' ? data.query.trim() : '';
    const cursor = integer(data.cursor);
    if (!query || query.length > 20000 || typeof data.saved !== 'boolean' || (data.semantic !== undefined && typeof data.semantic !== 'boolean')) fail(400, 'Invalid search.');
    if (data.semantic === false) return json({ ...await listThoughts(env, query, data.saved, cursor), indexing: false });
    if (!env.AI) fail(503, 'Related search is unavailable.');
    if (cursor > 400) fail(400, 'Invalid page.');
    await limit(env, 'search:global', 120, 60 * 1000);
    try { return json(await semanticSearch(query, data.saved, cursor, env)); }
    catch { fail(502, 'Related search is unavailable.'); }
  }
  if (path === '/api/thoughts' && request.method === 'GET') {
    const query = (url.searchParams.get('q') || '').trim();
    if (query.length > 500) fail(400, 'Use a shorter search.');
    const saved = url.searchParams.get('saved') === '1';
    const cursor = integer(url.searchParams.get('cursor'));
    return json(await listThoughts(env, query, saved, cursor));
  }
  if (path === '/api/thoughts' && request.method === 'POST') {
    const data = await readBody(request);
    const body = bodyText(data.body).trim();
    if (!uuid(data.id)) fail(400, 'Invalid thought.');
    const existing = await env.JOURNAL_DB.prepare(`SELECT ${thoughtColumns} FROM thoughts WHERE id = ?`).bind(data.id).first();
    if (existing) {
      if (existing.body !== body) fail(409, 'This thought already exists.');
      return json({ entry: existing, draft: await env.JOURNAL_DB.prepare('SELECT body, version FROM draft WHERE id = 1').first() });
    }
    const now = new Date().toISOString();
    const statements = [env.JOURNAL_DB.prepare(`INSERT INTO thoughts(id, body, created_at, updated_at) VALUES (?, ?, ?, ?) RETURNING ${thoughtColumns}`).bind(data.id, body, now, now)];
    if (Number.isSafeInteger(data.draft_version)) statements.push(env.JOURNAL_DB.prepare("UPDATE draft SET body = '', version = version + 1 WHERE id = 1 AND version = ? AND body = ?").bind(data.draft_version, data.body));
    const result = await env.JOURNAL_DB.batch(statements);
    if (env.AI && context) context.waitUntil(indexEntry(result[0].results[0], env).catch(() => {}));
    return json({ entry: result[0].results[0], draft: await env.JOURNAL_DB.prepare('SELECT body, version FROM draft WHERE id = 1').first() }, 201);
  }
  const thought = path.match(/^\/api\/thoughts\/([a-f0-9-]+)$/);
  if (thought && uuid(thought[1])) {
    const id = thought[1];
    if (request.method === 'PATCH') {
      const data = await readBody(request);
      let result;
      if (Object.hasOwn(data, 'body')) {
        const body = bodyText(data.body).trim();
        if (typeof data.updated_at !== 'string') fail(400, 'Missing thought version.');
        result = await env.JOURNAL_DB.prepare(`UPDATE thoughts SET body = ?, updated_at = ? WHERE id = ? AND updated_at = ? RETURNING ${thoughtColumns}`).bind(body, new Date().toISOString(), id, data.updated_at).first();
        if (!result) fail(409, 'This thought changed. Reload before editing.');
        if (env.AI && context) context.waitUntil(indexEntry(result, env).catch(() => {}));
      } else {
        if (typeof data.bookmarked !== 'boolean') fail(400, 'Invalid bookmark.');
        result = await env.JOURNAL_DB.prepare(`UPDATE thoughts SET bookmarked = ? WHERE id = ? RETURNING ${thoughtColumns}`).bind(data.bookmarked ? 1 : 0, id).first();
        if (!result) fail(404, 'Thought not found.');
      }
      return json({ entry: result });
    }
    if (request.method === 'DELETE') {
      const result = await env.JOURNAL_DB.prepare('DELETE FROM thoughts WHERE id = ? RETURNING id').bind(id).first();
      if (!result) fail(404, 'Thought not found.');
      return json({ ok: true });
    }
  }
  if (path === '/api/export' && request.method === 'GET') {
    const { results } = await env.JOURNAL_DB.prepare('SELECT id, body, bookmarked, created_at, updated_at FROM thoughts ORDER BY seq').all();
    const draft = await env.JOURNAL_DB.prepare('SELECT body FROM draft WHERE id = 1').first();
    return json({ format: 'christopher-journal-v1', exported_at: new Date().toISOString(), entries: results, draft }, 200, { 'Content-Disposition': 'attachment; filename="journal.json"' });
  }
  fail(404, 'Not found.');
}

export default {
  async fetch(request, env, context) {
    const url = new URL(request.url);
    let response;
    try {
      if (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) fail(400, 'HTTPS is required.');
      if (url.pathname.startsWith('/api/')) response = await api(request, env, url, context);
      else if (['GET', 'HEAD'].includes(request.method) && ['/', '/index.html', '/journal.css', '/journal.js', '/search-terms.js', '/fonts/instrument-sans-latin.woff2', '/fonts/instrument-sans-latin-ext.woff2', '/fonts/fraunces-latin.woff2', '/fonts/fraunces-latin-ext.woff2'].includes(url.pathname)) response = await env.ASSETS.fetch(request);
      else fail(404, 'Not found.');
    } catch (error) {
      response = json({ error: error instanceof HttpError ? error.message : 'The journal is unavailable. Try again later.' }, error instanceof HttpError ? error.status : 500);
    }
    const output = new Response(response.body, response);
    output.headers.set('Cache-Control', 'no-store');
    output.headers.set('X-Robots-Tag', 'noindex, nofollow, noarchive');
    output.headers.set('Referrer-Policy', 'no-referrer');
    output.headers.set('X-Content-Type-Options', 'nosniff');
    output.headers.set('X-Frame-Options', 'DENY');
    output.headers.set('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; connect-src 'self'; img-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
    return output;
  }
};
