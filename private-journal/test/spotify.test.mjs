import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import worker from '../worker.mjs';
import { digest, COOKIE } from '../auth.mjs';
import { refreshListening, spotifyRedirect } from '../spotify.mjs';
import { listeningItem } from '../../static/spotify-listening.js';

const origin = 'https://journal.example';
const clientId = 'c'.repeat(32);
const trackId = 't'.repeat(22), artistId = 'a'.repeat(22);
const track = { id: trackId, name: '<a favorite track>', artists: [{ name: 'an artist' }] };
const artist = { id: artistId, name: 'an artist' };
const snapshot = { track: { name: track.name, artists: ['an artist'], url: `https://open.spotify.com/track/${trackId}` }, artist: { name: artist.name, url: `https://open.spotify.com/artist/${artistId}` }, time_range: 'short_term', updated_at: '2026-11-10T12:00:00Z' };
function database() {
  const sqlite = new DatabaseSync(':memory:');
  for (const file of readdirSync(new URL('../migrations/', import.meta.url)).sort()) sqlite.exec(readFileSync(new URL(`../migrations/${file}`, import.meta.url), 'utf8'));
  const prepare = sql => {
    let args = [];
    return { bind(...values) { args = values; return this; },
      async first() { return sqlite.prepare(sql).get(...args) || null; },
      async run() { return sqlite.prepare(sql).run(...args); },
      async all() { return { results: sqlite.prepare(sql).all(...args) }; },
      execute() { return { results: sqlite.prepare(sql).all(...args) }; } };
  };
  return { sqlite, prepare, async batch(statements) {
    sqlite.exec('BEGIN');
    try { const result = statements.map(s => s.execute()); sqlite.exec('COMMIT'); return result; }
    catch (error) { sqlite.exec('ROLLBACK'); throw error; }
  } };
}
async function owner(t) {
  const env = { JOURNAL_DB: database(), JOURNAL_PASSWORD_HASH: `pbkdf2-sha256$100000$${'12'.repeat(16)}$${'ab'.repeat(32)}` };
  t.after(() => env.JOURNAL_DB.sqlite.close());
  const token = 'a'.repeat(64), hash = await digest(token);
  env.JOURNAL_DB.sqlite.prepare('INSERT INTO sessions VALUES (?, ?, ?)').run(hash, Date.now() + 3600000, await digest(env.JOURNAL_PASSWORD_HASH));
  return { env, hash, async call(path, { method = 'GET', body, cookie = `${COOKIE}=${token}`, headers = {}, context } = {}) {
    return worker.fetch(new Request(origin + path, { method, headers: { Cookie: cookie, Origin: origin, 'X-Journal': '1', 'Content-Type': 'application/json', ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) }), env, context);
  } };
}
function seed(env, due = 0) {
  env.JOURNAL_DB.sqlite.prepare('INSERT INTO spotify_connection VALUES (1, ?, ?, ?, ?, 0)').run(clientId, 'private-refresh', JSON.stringify(snapshot), due);
}
async function start(c) {
  const response = await c.call('/api/spotify/connect', { method: 'POST', body: { client_id: clientId } });
  assert.equal(response.status, 200);
  return { authorization: new URL((await response.json()).url), cookie: response.headers.get('Set-Cookie').split(';')[0] };
}
function provider(calls, token = { access_token: 'private-access', refresh_token: 'rotated-refresh', scope: 'user-top-read' }) {
  return async (url, options) => {
    assert.equal(options.redirect, 'manual', 'Cloudflare supports manual/follow, not error');
    calls.push({ url: String(url), options });
    if (url === 'https://accounts.spotify.com/api/token') return Response.json(token);
    assert.equal(options.headers.Authorization, 'Bearer private-access');
    assert.match(String(url), /time_range=short_term&limit=1$/);
    return Response.json({ items: [String(url).includes('/tracks?') ? track : artist] });
  };
}

test('Spotify setup requires an owner session and same-origin writes', async t => {
  const c = await owner(t);
  assert.equal((await c.call('/api/spotify', { cookie: '' })).status, 401);
  assert.equal((await c.call('/api/spotify/connect', { method: 'POST', body: { client_id: clientId }, headers: { Origin: 'https://evil.example' } })).status, 403);
  assert.equal((await c.call('/api/spotify/connect', { method: 'POST', body: { client_id: 'bad' } })).status, 400);
  assert.equal((await c.call('/api/spotify', { method: 'DELETE', cookie: '' })).status, 401);
});

test('PKCE requests only top-item access and stores no verifier in the browser', async t => {
  const c = await owner(t), { authorization, cookie } = await start(c);
  assert.equal(authorization.origin, 'https://accounts.spotify.com');
  assert.equal(authorization.searchParams.get('scope'), 'user-top-read');
  assert.equal(authorization.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(authorization.searchParams.has('code_verifier'), false);
  assert.match(cookie, /^__Host-spotify-state=[a-f0-9]{64}$/);
  const row = c.env.JOURNAL_DB.sqlite.prepare('SELECT * FROM spotify_authorizations').get();
  assert.equal(row.session_hash, c.hash);
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(row.verifier)));
  assert.equal(authorization.searchParams.get('code_challenge'), Buffer.from(bytes).toString('base64url'));
});

test('callback accepts the browser-bound owner flow without the Strict journal cookie, but cannot be replayed', async t => {
  const c = await owner(t), { authorization, cookie } = await start(c), calls = [];
  t.mock.method(globalThis, 'fetch', provider(calls));
  const callback = `/api/spotify/callback?code=one-time-code&state=${authorization.searchParams.get('state')}`;
  assert.equal((await c.call(callback, { cookie: '' })).status, 400);
  assert.equal(calls.length, 0);
  const response = await c.call(callback, { cookie });
  assert.equal(response.status, 303);
  assert.equal(response.headers.get('Location'), origin + '/spotify?spotify=connected');
  assert.equal(calls[0].options.body.get('grant_type'), 'authorization_code');
  assert.ok(calls[0].options.body.get('code_verifier'));
  const publicResponse = await c.call('/public/listening', { cookie: '' });
  const data = await publicResponse.json();
  assert.deepEqual(data.track, snapshot.track);
  assert.deepEqual(data.artist, snapshot.artist);
  assert.equal(data.time_range, 'short_term');
  assert.equal(JSON.stringify(data).includes('private-'), false);
  assert.equal(JSON.stringify(data).includes('refresh'), false);
  assert.equal(publicResponse.headers.get('Access-Control-Allow-Origin'), '*');
  assert.equal((await c.call(callback, { cookie })).status, 400);
  assert.equal(calls.length, 3);
});

test('expired or revoked owner authorization cannot connect a Spotify account', async t => {
  const c = await owner(t), { authorization, cookie } = await start(c);
  c.env.JOURNAL_DB.sqlite.prepare('DELETE FROM sessions').run();
  t.mock.method(globalThis, 'fetch', () => { throw new Error('must not contact Spotify'); });
  const response = await c.call(`/api/spotify/callback?code=x&state=${authorization.searchParams.get('state')}`, { cookie });
  assert.equal(response.status, 401);
  assert.equal(c.env.JOURNAL_DB.sqlite.prepare('SELECT count(*) AS n FROM spotify_connection').get().n, 0);
});

test('public reads serve a snapshot while one refresh runs; fresh reads never contact Spotify', async t => {
  const c = await owner(t); seed(c.env);
  const calls = []; t.mock.method(globalThis, 'fetch', provider(calls));
  const jobs = [], context = { waitUntil(job) { jobs.push(job); } };
  const responses = await Promise.all(Array.from({ length: 6 }, () => c.call('/public/listening', { cookie: '', context })));
  for (const response of responses) assert.deepEqual((await response.json()).track, snapshot.track);
  await Promise.all(jobs);
  assert.equal(calls.length, 3, 'one token refresh and two ranking calls');
  const row = c.env.JOURNAL_DB.sqlite.prepare('SELECT * FROM spotify_connection').get();
  assert.equal(row.refresh_token, 'rotated-refresh');
  assert.ok(row.refresh_after > Date.now() + 86000000);
  await c.call('/public/listening', { cookie: '', context });
  assert.equal(calls.length, 3);
});

test('rate limits preserve the last good results and honor Retry-After', async t => {
  const c = await owner(t); seed(c.env);
  t.mock.method(globalThis, 'fetch', async () => Response.json({ error: 'rate limit' }, { status: 429, headers: { 'Retry-After': '3600' } }));
  await refreshListening(c.env);
  const row = c.env.JOURNAL_DB.sqlite.prepare('SELECT * FROM spotify_connection').get();
  assert.deepEqual(JSON.parse(row.public_json), snapshot);
  assert.ok(row.refresh_after > Date.now() + 3500000);
  assert.equal(row.lease_until, 0);
});

test('refresh rotation survives a ranking failure, and invalid grants clear published data', async t => {
  const c = await owner(t); seed(c.env);
  t.mock.method(globalThis, 'fetch', async url => String(url).includes('/api/token')
    ? Response.json({ access_token: 'private-access', refresh_token: 'new-refresh' })
    : Response.json({ error: 'unavailable' }, { status: 503 }));
  await refreshListening(c.env);
  let row = c.env.JOURNAL_DB.sqlite.prepare('SELECT * FROM spotify_connection').get();
  assert.equal(row.refresh_token, 'new-refresh');
  assert.deepEqual(JSON.parse(row.public_json), snapshot);
  c.env.JOURNAL_DB.sqlite.prepare('UPDATE spotify_connection SET refresh_after = 0').run();
  t.mock.method(globalThis, 'fetch', async () => Response.json({ error: 'invalid_grant', error_description: 'private provider detail' }, { status: 400 }));
  await refreshListening(c.env);
  row = c.env.JOURNAL_DB.sqlite.prepare('SELECT * FROM spotify_connection').get();
  assert.equal(row.refresh_token, null); assert.equal(row.public_json, null);
  assert.equal((await (await c.call('/public/listening', { cookie: '' })).json()).track, null);
});

test('disconnect during refresh cannot republish data or recreate the connection', async t => {
  const c = await owner(t); seed(c.env);
  t.mock.method(globalThis, 'fetch', async url => {
    if (String(url).includes('/api/token')) return Response.json({ access_token: 'private-access' });
    await c.call('/api/spotify', { method: 'DELETE' });
    return Response.json({ items: [String(url).includes('/tracks?') ? track : artist] });
  });
  await refreshListening(c.env);
  assert.equal(c.env.JOURNAL_DB.sqlite.prepare('SELECT count(*) AS n FROM spotify_connection').get().n, 0);
  assert.equal((await (await c.call('/public/listening', { cookie: '' })).json()).track, null);
});

test('empty rankings are valid and do not invent a favorite', async t => {
  const c = await owner(t), { authorization, cookie } = await start(c);
  t.mock.method(globalThis, 'fetch', async url => String(url).includes('/api/token')
    ? Response.json({ access_token: 'private-access', refresh_token: 'private-refresh', scope: 'user-top-read' })
    : Response.json({ items: [] }));
  assert.equal((await c.call(`/api/spotify/callback?code=x&state=${authorization.searchParams.get('state')}`, { cookie })).status, 303);
  const data = await (await c.call('/public/listening', { cookie: '' })).json();
  assert.equal(data.track, null); assert.equal(data.artist, null);
});

test('Spotify public display accepts only canonical track/artist links and preserves names as text', () => {
  assert.equal(listeningItem({ ...snapshot.track, url: 'javascript:alert(1)' }, 'track'), null);
  assert.equal(listeningItem({ ...snapshot.track, url: 'https://open.spotify.com.evil/track/' + trackId }, 'track'), null);
  assert.equal(listeningItem({ ...snapshot.track, url: snapshot.artist.url }, 'track'), null);
  assert.equal(listeningItem(null, 'track'), null);
  assert.equal(listeningItem(snapshot.track, 'track').text, '<a favorite track> by an artist');
  assert.equal(spotifyRedirect(new URL('https://christopherli.dev/api/spotify')), 'https://christopherli.dev/journal/api/spotify/callback');
  assert.equal(spotifyRedirect(new URL('http://localhost:8787/api/spotify')), 'http://127.0.0.1:8787/api/spotify/callback');
});
