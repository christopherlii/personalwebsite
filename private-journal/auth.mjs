const encoder = new TextEncoder();
export const SESSION_SECONDS = 60 * 60 * 24 * 7;
export const COOKIE = '__Host-journal';

export function hex(bytes) {
  return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
}

export async function digest(value) {
  return hex(await crypto.subtle.digest('SHA-256', encoder.encode(value)));
}

// Workers production caps WebCrypto PBKDF2 at 100,000 iterations; local workerd does not.
// https://github.com/cloudflare/workerd/issues/1346
export async function passwordHash(password, salt, iterations = 100000) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  return hex(await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: encoder.encode(salt), iterations, hash: 'SHA-256' }, key, 256));
}

export function validPasswordConfig(value) {
  return /^pbkdf2-sha256\$100000\$[a-f0-9]{32}\$[a-f0-9]{64}$/.test(value || '');
}

export async function verifyPassword(password, config) {
  if (!validPasswordConfig(config)) return false;
  const [, iterations, salt, expected] = config.split('$');
  const actual = await passwordHash(password, salt, Number(iterations));
  let difference = 0;
  for (let i = 0; i < expected.length; i++) difference |= expected.charCodeAt(i) ^ actual.charCodeAt(i);
  return difference === 0;
}

export function sessionCookie(token, maxAge = SESSION_SECONDS) {
  return `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;
}

export async function sessionFor(request, env) {
  const token = (request.headers.get('Cookie') || '').split(';').map(s => s.trim()).find(s => s.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
  const tokenHash = await digest(token);
  const session = await env.JOURNAL_DB.prepare('SELECT token_hash, expires_at, password_version FROM sessions WHERE token_hash = ?').bind(tokenHash).first();
  if (!session || session.expires_at <= Date.now() || session.password_version !== await digest(env.JOURNAL_PASSWORD_HASH)) return null;
  return session;
}
