import { fetchPage, readingURL } from './reading.mjs';
import { splitParts } from './public/pdf-text.js';

export class WorkError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const fail = (status, message) => { throw new WorkError(status, message); };
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
export const BLOCK_TYPES = ['h2', 'h3', 'p', 'li', 'quote', 'pre'];
const PART_BYTES = 150000, PAGE_BYTES = 3 * 1024 * 1024;
const fields = 'id, kind, title, author, url, site, status, parts, position, started_at, finished_at';

const decode = value => value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp|mdash|ndash|hellip|rsquo|lsquo|rdquo|ldquo);/gi, (raw, code) => {
  if (code[0] !== '#') return ({ amp:'&', lt:'<', gt:'>', quot:'"', apos:"'", nbsp:' ', mdash:'—', ndash:'–', hellip:'…', rsquo:'’', lsquo:'‘', rdquo:'”', ldquo:'“' })[code.toLowerCase()] || raw;
  const point = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : Number(code.slice(1));
  return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : ' ';
});
// Inline tags vanish without a space (so "slowly</a>." stays "slowly."); others separate words.
const inline = html => decode(html.replace(/<\/?(a|em|strong|b|i|u|s|span|code|sup|sub|mark|small|abbr|cite|q|time|del|ins|kbd|var)\b[^>]*>/gi, '').replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();

// A small readability pass: plain text only, from the page's main content.
// Nothing from the page (markup, scripts, images, styles) reaches the reader.
export function articleBlocks(html) {
  const clean = html.replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg|template|iframe|form|button|select|textarea|canvas|video|audio|picture|object)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ');
  const meta = new Map();
  for (const match of clean.matchAll(/<meta\b[^>]*>/gi)) {
    const attributes = new Map([...match[0].matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)].map(m => [m[1].toLowerCase(), m[2] ?? m[3] ?? m[4]]));
    const name = (attributes.get('property') || attributes.get('name') || '').toLowerCase();
    if (name && attributes.has('content') && !meta.has(name)) meta.set(name, inline(attributes.get('content')));
  }
  const title = (meta.get('og:title') || inline(clean.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i)?.[1] || '')).slice(0, 300);
  const author = (meta.get('author') || meta.get('article:author') || '').replace(/^https?:\/\/\S+$/, '').slice(0, 200);
  // The longest <article>, else <main>, else the body holds the writing.
  const candidates = [...clean.matchAll(/<article\b[^>]*>([\s\S]*?)<\/article\s*>/gi)].map(m => m[1]);
  let scope = candidates.sort((a, b) => inline(b).length - inline(a).length)[0]
    || clean.match(/<main\b[^>]*>([\s\S]*?)<\/main\s*>/i)?.[1] || clean.match(/<body\b[^>]*>([\s\S]*)<\/body\s*>/i)?.[1] || clean;
  scope = scope.replace(/<(nav|header|footer|aside|figure|figcaption)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ');
  const blocks = [];
  let chars = 0;
  for (const match of scope.matchAll(/<(h[1-6]|p|li|blockquote|pre)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi)) {
    const tag = match[1].toLowerCase();
    const t = tag === 'h1' || tag === 'h2' ? 'h2' : tag[0] === 'h' ? 'h3' : tag === 'blockquote' ? 'quote' : tag;
    const x = t === 'pre' ? decode(match[2].replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]*>/g, '')).replace(/^\n+|\s+$/g, '') : inline(match[2]);
    if (!x || (t === 'li' && x.length < 3) || (t === 'h2' && x === title)) continue;
    blocks.push({ t, x: x.slice(0, 20000) }); chars += x.length;
    if (chars > 1500000 || blocks.length >= 20000) break;
  }
  // Pages built from bare <div>s and <br>s: fall back to their text runs.
  if (blocks.length < 3) {
    const runs = scope.replace(/<\/(div|section)\s*>|<br\s*\/?>\s*<br\s*\/?>/gi, '\n\n\n').split('\n\n\n').map(inline);
    for (const run of runs) if (run.length > 40 && !blocks.some(block => block.x === run)) blocks.push({ t: 'p', x: run.slice(0, 20000) });
  }
  return { title, author, blocks };
}

function validBlocks(value) {
  if (!Array.isArray(value) || !value.length || value.length > 5000) fail(400, 'Invalid text.');
  for (const block of value) if (!block || !BLOCK_TYPES.includes(block.t) || typeof block.x !== 'string' || !block.x || block.x.length > 20000) fail(400, 'Invalid text.');
  if (JSON.stringify(value).length > PART_BYTES + 20000) fail(413, 'That part is too large.');
  return value.map(block => ({ t: block.t, x: block.x }));
}

export async function workApi(request, env, path, readBody, limit) {
  if (path === '/api/works' && request.method === 'GET') {
    const status = new URL(request.url).searchParams.get('status') || 'reading';
    if (!['reading', 'finished'].includes(status)) fail(400, 'Invalid shelf.');
    const { results } = await env.JOURNAL_DB.prepare(`SELECT ${fields} FROM works WHERE status = ? ORDER BY COALESCE(finished_at, started_at) DESC LIMIT 200`).bind(status).all();
    return Response.json({ works: results });
  }
  if (path === '/api/works' && request.method === 'POST') {
    const data = await readBody(request);
    if (!uuid(data.id)) fail(400, 'Invalid work.');
    const existingId = await env.JOURNAL_DB.prepare(`SELECT ${fields} FROM works WHERE id = ?`).bind(data.id).first();
    if (existingId) return Response.json({ work: existingId, existing: true });
    const now = new Date().toISOString();
    if (data.url !== undefined) {
      const url = readingURL(data.url);
      const existing = await env.JOURNAL_DB.prepare(`SELECT ${fields} FROM works WHERE url = ?`).bind(url).first();
      if (existing) return Response.json({ work: existing, existing: true });
      await limit(env, 'works:minute', 20, 60 * 1000);
      const page = await fetchPage(url, fetch, PAGE_BYTES, 9000);
      if (!page) fail(422, "couldn't open that page. it may be paywalled or blocked.");
      const { title, author, blocks } = articleBlocks(page.html);
      if (!blocks.length) fail(422, "couldn't find readable text on that page.");
      const parts = splitParts(blocks), site = new URL(url).hostname.replace(/^www\./, '');
      // The article and its text are saved together or not at all.
      const saved = await env.JOURNAL_DB.batch([
        env.JOURNAL_DB.prepare(`INSERT INTO works(id, kind, title, author, url, site, parts, started_at) VALUES (?, 'article', ?, ?, ?, ?, ?, ?) RETURNING ${fields}`)
          .bind(data.id, title || site, author, url, site, parts.length, now),
        ...parts.map((part, index) => env.JOURNAL_DB.prepare('INSERT INTO work_parts(work_id, part, blocks) VALUES (?, ?, ?)').bind(data.id, index, JSON.stringify(part)))
      ]);
      return Response.json({ work: saved[0].results[0] }, { status: 201 });
    }
    // A book's text is extracted in the browser (from a dropped PDF) and
    // arrives part by part after this.
    const title = typeof data.title === 'string' ? data.title.trim() : '', author = typeof data.author === 'string' ? data.author.trim() : '';
    if (data.kind !== 'book' || !title || title.length > 300 || author.length > 200 || !Number.isInteger(data.parts) || data.parts < 1 || data.parts > 400) fail(400, 'Invalid book.');
    const work = await env.JOURNAL_DB.prepare(`INSERT INTO works(id, kind, title, author, parts, started_at) VALUES (?, 'book', ?, ?, ?, ?) RETURNING ${fields}`)
      .bind(data.id, title, author, data.parts, now).first();
    return Response.json({ work }, { status: 201 });
  }
  const part = path.match(/^\/api\/works\/([a-f0-9-]{36})\/parts\/(\d{1,3})$/);
  if (part && uuid(part[1])) {
    const work = await env.JOURNAL_DB.prepare('SELECT kind, parts FROM works WHERE id = ?').bind(part[1]).first();
    const index = Number(part[2]);
    if (!work || index >= work.parts) fail(404, 'Not found.');
    if (request.method === 'GET') {
      const row = await env.JOURNAL_DB.prepare('SELECT blocks FROM work_parts WHERE work_id = ? AND part = ?').bind(part[1], index).first();
      return Response.json({ blocks: row ? JSON.parse(row.blocks) : [] });
    }
    if (request.method === 'PUT') {
      if (work.kind !== 'book') fail(409, 'Only books are uploaded.');
      const blocks = validBlocks((await readBody(request)).blocks);
      await env.JOURNAL_DB.prepare('INSERT OR REPLACE INTO work_parts(work_id, part, blocks) VALUES (?, ?, ?)').bind(part[1], index, JSON.stringify(blocks)).run();
      return Response.json({ ok: true });
    }
  }
  const one = path.match(/^\/api\/works\/([a-f0-9-]{36})$/);
  if (one && uuid(one[1])) {
    if (request.method === 'GET') {
      const work = await env.JOURNAL_DB.prepare(`SELECT ${fields} FROM works WHERE id = ?`).bind(one[1]).first();
      if (!work) fail(404, 'Not found.');
      return Response.json({ work });
    }
    if (request.method === 'PATCH') {
      const data = await readBody(request);
      if (typeof data.position !== 'number' || !(data.position >= 0 && data.position <= 1)) fail(400, 'Invalid position.');
      const work = await env.JOURNAL_DB.prepare(`UPDATE works SET position = ? WHERE id = ? RETURNING ${fields}`).bind(data.position, one[1]).first();
      if (!work) fail(404, 'Not found.');
      return Response.json({ work });
    }
    if (request.method === 'DELETE') {
      const work = await env.JOURNAL_DB.prepare('DELETE FROM works WHERE id = ? RETURNING id').bind(one[1]).first();
      if (!work) fail(404, 'Not found.');
      return Response.json({ ok: true });
    }
  }
  return null;
}
