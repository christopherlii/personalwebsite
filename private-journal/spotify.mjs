import { digest, hex } from './auth.mjs';

const DAY = 86400000;
const TOKEN_URL = 'https://accounts.spotify.com/api/token';
const STATE_COOKIE = '__Host-spotify-state';
export class SpotifyError extends Error {
  constructor(status, message, retry = 900000, revoked = false) {
    super(message); this.status = status; this.retry = retry; this.revoked = revoked;
  }
}
const fail = (status, message) => { throw new SpotifyError(status, message); };
const random = () => hex(crypto.getRandomValues(new Uint8Array(32)));
const stateCookie = (value, seconds = 600) => `${STATE_COOKIE}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${seconds}`;
const redirectPath = url => url.hostname === 'christopherli.dev' ? '/journal/api/spotify/callback' : '/api/spotify/callback';
const setupPath = url => url.hostname === 'christopherli.dev' ? '/journal/spotify' : '/spotify';
export function spotifyRedirect(url) {
  const target = new URL(url.origin + redirectPath(url));
  if (target.hostname === 'localhost') target.hostname = '127.0.0.1';
  return target.href;
}

async function jsonBody(response) {
  const reader = response.body?.getReader();
  if (!reader) fail(502, 'Spotify returned an empty response.');
  const chunks = []; let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > 262144) { await reader.cancel(); fail(502, 'Spotify returned too much data.'); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try { return JSON.parse(new TextDecoder().decode(bytes)); }
  catch { fail(502, 'Spotify returned an invalid response.'); }
}

async function spotifyFetch(url, options, fetcher) {
  let response;
  try { response = await fetcher(url, { ...options, signal: AbortSignal.timeout(8000), redirect: 'manual' }); }
  catch { fail(502, 'Spotify is unavailable. Try again later.'); }
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel();
    fail(502, 'Spotify returned an unexpected redirect. Try connecting again.');
  }
  const body = await jsonBody(response);
  if (!response.ok) {
    const revoked = body.error === 'invalid_grant';
    const retry = response.status === 429 ? Math.max(60000, Math.min(DAY, Number(response.headers.get('Retry-After')) * 1000 || 900000)) : 900000;
    throw new SpotifyError(response.status === 429 ? 429 : 502,
      revoked ? 'Reconnect Spotify to update your listening stats.' : 'Spotify could not update your listening stats. Try again later.', retry, revoked);
  }
  return body;
}
const tokens = (body, fetcher) => spotifyFetch(TOKEN_URL, {
  method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body)
}, fetcher);

function item(value, type) {
  if (!value) return null;
  const id = value.id;
  if (!/^[A-Za-z0-9]{22}$/.test(id || '') || typeof value.name !== 'string' || !value.name.trim() || value.name.length > 300) fail(502, 'Spotify returned an invalid item.');
  const result = { name: value.name, url: `https://open.spotify.com/${type}/${id}` };
  if (type === 'track') result.artists = (value.artists || []).slice(0, 12).map(artist => String(artist.name || '').slice(0, 200)).filter(Boolean);
  return result;
}

async function snapshot(accessToken, fetcher) {
  if (typeof accessToken !== 'string' || !accessToken) fail(502, 'Spotify did not return an access token.');
  const [tracks, artists] = await Promise.all(['tracks', 'artists'].map(type => spotifyFetch(
    `https://api.spotify.com/v1/me/top/${type}?time_range=short_term&limit=1`,
    { headers: { Authorization: `Bearer ${accessToken}` } }, fetcher)));
  if (!Array.isArray(tracks.items) || !Array.isArray(artists.items)) fail(502, 'Spotify returned invalid rankings.');
  return { track: item(tracks.items[0], 'track'), artist: item(artists.items[0], 'artist'), time_range: 'short_term', updated_at: new Date().toISOString() };
}

// One database lease bounds public traffic to one refresh per day, across isolates.
export async function refreshListening(env, fetcher = fetch) {
  const now = Date.now();
  const row = await env.JOURNAL_DB.prepare(`UPDATE spotify_connection SET lease_until = ?
    WHERE id = 1 AND refresh_token IS NOT NULL AND refresh_after <= ? AND lease_until <= ? RETURNING *`).bind(now + 60000, now, now).first();
  if (!row) return;
  let refreshToken = row.refresh_token;
  try {
    const result = await tokens({ grant_type: 'refresh_token', client_id: row.client_id, refresh_token: refreshToken }, fetcher);
    if (typeof result.refresh_token === 'string' && result.refresh_token) {
      const retained = await env.JOURNAL_DB.prepare('UPDATE spotify_connection SET refresh_token = ? WHERE id = 1 AND refresh_token = ? AND lease_until = ? RETURNING id')
        .bind(result.refresh_token, refreshToken, row.lease_until).first();
      if (!retained) return; // Disconnected or replaced while Spotify was responding.
      refreshToken = result.refresh_token;
    }
    const data = await snapshot(result.access_token, fetcher);
    await env.JOURNAL_DB.prepare(`UPDATE spotify_connection SET public_json = ?, refresh_after = ?, lease_until = 0
      WHERE id = 1 AND refresh_token = ? AND lease_until = ?`).bind(JSON.stringify(data), Date.now() + DAY, refreshToken, row.lease_until).run();
  } catch (error) {
    if (error.revoked) {
      await env.JOURNAL_DB.prepare('UPDATE spotify_connection SET refresh_token = NULL, public_json = NULL, lease_until = 0 WHERE id = 1 AND refresh_token = ? AND lease_until = ?').bind(refreshToken, row.lease_until).run();
    } else {
      await env.JOURNAL_DB.prepare('UPDATE spotify_connection SET refresh_after = ?, lease_until = 0 WHERE id = 1 AND refresh_token = ? AND lease_until = ?')
        .bind(Date.now() + (error.retry || 900000), refreshToken, row.lease_until).run();
    }
  }
}

export async function publicListening(request, env, context) {
  if (!['GET', 'HEAD'].includes(request.method)) fail(405, 'Method not allowed.');
  const row = await env.JOURNAL_DB.prepare('SELECT public_json, refresh_after, refresh_token IS NOT NULL AS connected FROM spotify_connection WHERE id = 1').first();
  if (row?.connected && row.refresh_after <= Date.now()) {
    const refresh = refreshListening(env);
    if (context) context.waitUntil(refresh);
    else await refresh;
  }
  const data = row?.connected && row.public_json ? JSON.parse(row.public_json) : { track: null, artist: null, time_range: 'short_term', updated_at: null };
  return Response.json(data);
}

export async function spotifyApi(request, env, url, session, readBody) {
  const path = url.pathname;
  if (path === '/api/spotify' && request.method === 'GET') {
    const row = await env.JOURNAL_DB.prepare('SELECT client_id, public_json, refresh_token IS NOT NULL AS connected FROM spotify_connection WHERE id = 1').first();
    return Response.json({ connected: Boolean(row?.connected), client_id: row?.client_id || '', redirect_uri: spotifyRedirect(url), listening: row?.public_json ? JSON.parse(row.public_json) : null });
  }
  if (path === '/api/spotify' && request.method === 'DELETE') {
    await env.JOURNAL_DB.batch([env.JOURNAL_DB.prepare('DELETE FROM spotify_authorizations'), env.JOURNAL_DB.prepare('DELETE FROM spotify_connection')]);
    return Response.json({ connected: false });
  }
  if (path !== '/api/spotify/connect' || request.method !== 'POST') fail(405, 'Method not allowed.');
  const { client_id: clientId } = await readBody(request);
  if (!/^[a-f0-9]{32}$/i.test(clientId || '')) fail(400, 'Enter the Client ID from your Spotify app settings.');
  const state = random(), browser = random(), verifier = random(), redirectUri = spotifyRedirect(url);
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  const challenge = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  await env.JOURNAL_DB.batch([
    env.JOURNAL_DB.prepare('DELETE FROM spotify_authorizations WHERE expires_at <= ? OR session_hash = ?').bind(Date.now(), session.token_hash),
    env.JOURNAL_DB.prepare('INSERT INTO spotify_authorizations VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(await digest(state), await digest(browser), session.token_hash, clientId, verifier, redirectUri, Date.now() + 600000)
  ]);
  const authorization = new URL('https://accounts.spotify.com/authorize');
  authorization.search = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: redirectUri,
    scope: 'user-top-read', state, code_challenge_method: 'S256', code_challenge: challenge });
  return Response.json({ url: authorization.href }, { headers: { 'Set-Cookie': stateCookie(browser) } });
}

// Spotify returns cross-site, where the journal's SameSite=Strict cookie is absent.
// A separate Lax cookie and one-use state bind this callback to the owner session.
export async function spotifyCallback(request, env, url, fetcher = fetch) {
  if (request.method !== 'GET') fail(405, 'Method not allowed.');
  const state = url.searchParams.get('state') || '';
  const browser = (request.headers.get('Cookie') || '').split(';').map(s => s.trim()).find(s => s.startsWith(STATE_COOKIE + '='))?.slice(STATE_COOKIE.length + 1) || '';
  if (!/^[a-f0-9]{64}$/.test(state) || !/^[a-f0-9]{64}$/.test(browser)) fail(400, 'This Spotify connection expired. Start again.');
  const row = await env.JOURNAL_DB.prepare(`DELETE FROM spotify_authorizations WHERE state_hash = ? AND browser_hash = ? AND expires_at > ? RETURNING *`)
    .bind(await digest(state), await digest(browser), Date.now()).first();
  if (!row) fail(400, 'This Spotify connection expired. Start again.');
  const session = await env.JOURNAL_DB.prepare('SELECT expires_at, password_version FROM sessions WHERE token_hash = ?').bind(row.session_hash).first();
  if (!session || session.expires_at <= Date.now() || session.password_version !== await digest(env.JOURNAL_PASSWORD_HASH)) fail(401, 'Sign in and connect Spotify again.');
  if (row.redirect_uri !== spotifyRedirect(url)) fail(400, 'Spotify returned to a different address. Start again.');
  let outcome = 'cancelled';
  if (!url.searchParams.has('error')) {
    const code = url.searchParams.get('code');
    if (!code || code.length > 4096) fail(400, 'Spotify did not return an authorization code.');
    const result = await tokens({ grant_type: 'authorization_code', code, redirect_uri: row.redirect_uri, client_id: row.client_id, code_verifier: row.verifier }, fetcher);
    if (typeof result.refresh_token !== 'string' || !result.refresh_token || !String(result.scope || '').split(' ').includes('user-top-read')) fail(502, 'Spotify did not grant access to your top items.');
    const data = await snapshot(result.access_token, fetcher);
    await env.JOURNAL_DB.prepare(`INSERT INTO spotify_connection(id, client_id, refresh_token, public_json, refresh_after, lease_until) VALUES (1, ?, ?, ?, ?, 0)
      ON CONFLICT(id) DO UPDATE SET client_id=excluded.client_id, refresh_token=excluded.refresh_token, public_json=excluded.public_json, refresh_after=excluded.refresh_after, lease_until=0`)
      .bind(row.client_id, result.refresh_token, JSON.stringify(data), Date.now() + DAY).run();
    outcome = 'connected';
  }
  return new Response(null, { status: 303, headers: { Location: `${url.origin}${setupPath(url)}?spotify=${outcome}`, 'Set-Cookie': stateCookie('', 0) } });
}
