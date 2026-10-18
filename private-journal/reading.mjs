import { ftsQuery } from './search.mjs';
import { chunksOf, DIMENSIONS, MODEL, maximumSimilarity } from './semantic.mjs';
import { plainThoughtLinks } from './public/thought-links.js';

export class ReadingError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const fail = (status, message) => { throw new ReadingError(status, message); };
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
const fields = 'id, url, title, read_at, created_at';
export function readingURL(value) {
  let url;
  try { url = new URL(value); } catch { fail(400, 'Paste a complete web address.'); }
  const host = url.hostname.toLowerCase();
  if (typeof value !== 'string' || value.length > 2048 || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port ||
    !/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(host) || /^\d+(?:\.\d+){3}$/.test(host) ||
    /(?:^|\.)(?:localhost|local|internal|test|invalid|example|onion)$/.test(host) ||
    (host === 'christopherli.dev' && url.pathname.startsWith('/journal')) || host.endsWith('.workers.dev')) fail(400, 'Use a public web address.');
  url.hash = '';
  for (const key of [...url.searchParams.keys()]) if (/^(utm_.+|fbclid|gclid)$/i.test(key)) url.searchParams.delete(key);
  return url.href;
}
const text = value => value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (raw, code) => {
  if (code[0] !== '#') return ({ amp:'&', lt:'<', gt:'>', quot:'"', apos:"'", nbsp:' ' })[code.toLowerCase()] || raw;
  const point = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : Number(code.slice(1));
  return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : ' ';
}).replace(/\s+/g, ' ').trim();
export function readingMetadata(html) {
  // Only plain text is retained. Scripts, markup, images, and publisher code
  // never enter the journal DOM or run in the browser.
  const clean = html.replace(/<(script|style|noscript|svg|nav|footer|header)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ');
  let title = text(clean.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i)?.[1] || '');
  let description = '';
  for (const match of clean.matchAll(/<meta\b[^>]*>/gi)) {
    const attributes = new Map([...match[0].matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)].map(m => [m[1].toLowerCase(), m[2] ?? m[3] ?? m[4]]));
    const name = (attributes.get('property') || attributes.get('name') || '').toLowerCase();
    if (name === 'og:title') title = text(attributes.get('content') || '') || title;
    if (['description', 'og:description'].includes(name)) description = text(attributes.get('content') || '') || description;
  }
  const article = clean.match(/<(article|main)\b[^>]*>([\s\S]*?)<\/\1\s*>/i)?.[2] || clean;
  const paragraphs = [...article.matchAll(/<(?:p|h[1-3])\b[^>]*>([\s\S]*?)<\/(?:p|h[1-3])\s*>/gi)].map(m => text(m[1].replace(/<[^>]*>/g, ' '))).filter(Boolean);
  return { title: title.replace(/<[^>]*>/g, '').slice(0, 160), excerpt: [description, ...paragraphs].filter(Boolean).join('\n\n').slice(0, 8000) };
}
export async function fetchReadingMetadata(address, fetcher = fetch) {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 4500);
  let reader;
  try {
    let url = readingURL(address), response;
    for (let redirects = 0; redirects <= 3; redirects++) {
      response = await fetcher(url, { redirect: 'manual', signal: controller.signal, headers: { Accept:'text/html', 'User-Agent':'ChristopherJournal/1.0' } });
      if (![301,302,303,307,308].includes(response.status)) break;
      await response.body?.cancel();
      if (redirects === 3 || !response.headers.get('Location')) return {};
      url = readingURL(new URL(response.headers.get('Location'), url).href);
    }
    if (!response.ok || !response.headers.get('Content-Type')?.includes('text/html')) { await response.body?.cancel(); return {}; }
    reader = response.body?.getReader(); if (!reader) return {};
    const decoder = new TextDecoder(); let html = '', bytes = 0;
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      const remaining = 196608 - bytes; html += decoder.decode(value.subarray(0, remaining), { stream:true }); bytes += value.length;
      if (bytes >= 196608) { await reader.cancel(); break; }
    }
    html += decoder.decode(); return readingMetadata(html);
  } catch { return {}; }
  finally { await reader?.cancel().catch(() => {}); clearTimeout(timer); }
}
export async function indexReading(entry, env) {
  if (!env.AI) return;
  const passages = chunksOf(`${entry.title}\n\n${entry.excerpt || entry.url}`), vectors = [];
  for (let start = 0; start < passages.length; start += 8) {
    const result = await env.AI.run(MODEL, { text:passages.slice(start, start + 8) });
    if (!Array.isArray(result.data) || result.data.length !== Math.min(8, passages.length-start)) throw new Error('Invalid reading vectors.');
    for (const vector of result.data) {
      if (!Array.isArray(vector) || vector.length !== DIMENSIONS || !vector.every(Number.isFinite) || !Math.hypot(...vector)) throw new Error('Invalid reading vector.');
      const norm = Math.hypot(...vector); vectors.push(...vector.map(value => value/norm));
    }
  }
  await env.JOURNAL_DB.prepare(`INSERT OR REPLACE INTO reading_embeddings(reading_id,model,vectors,chunks,dimensions)
    SELECT ?,?,?,?,? WHERE EXISTS(SELECT 1 FROM reading WHERE id = ?)`).bind(entry.id,MODEL,new Float32Array(vectors).buffer,passages.length,DIMENSIONS,entry.id).run();
}
export async function readingApi(request, env, path, readBody, context) {
  if (path === '/api/reading' && request.method === 'GET') {
    const url = new URL(request.url), read = url.searchParams.get('read') === '1', cursor = Number(url.searchParams.get('cursor') || 0);
    if (!Number.isSafeInteger(cursor) || cursor < 0) fail(400,'Invalid page.');
    const { results } = await env.JOURNAL_DB.prepare(`SELECT seq,${fields} FROM reading WHERE read_at IS ${read ? 'NOT ' : ''}NULL${cursor ? ' AND seq < ?' : ''} ORDER BY seq DESC LIMIT 41`).bind(...(cursor ? [cursor] : [])).all();
    return Response.json({ entries:results.slice(0,40), next:results.length > 40 ? results[39].seq : null });
  }
  if (path === '/api/reading' && request.method === 'POST') {
    const data = await readBody(request); if (!uuid(data.id)) fail(400,'Invalid saved link.');
    const url = readingURL(data.url);
    const existing = await env.JOURNAL_DB.prepare(`SELECT ${fields} FROM reading WHERE url = ? OR id = ?`).bind(url,data.id).first();
    if (existing) {
      if (existing.url !== url) fail(409,'This saved link already exists.');
      return Response.json({ entry:existing, existing:true });
    }
    const metadata = await fetchReadingMetadata(url);
    const entry = await env.JOURNAL_DB.prepare(`INSERT INTO reading(id,url,title,excerpt,created_at) VALUES(?,?,?,?,?) ON CONFLICT(url) DO NOTHING RETURNING *`).bind(data.id,url,metadata.title || '',metadata.excerpt || '',new Date().toISOString()).first();
    if (!entry) return Response.json({ entry:await env.JOURNAL_DB.prepare(`SELECT ${fields} FROM reading WHERE url = ?`).bind(url).first(), existing:true });
    if (context && env.AI) context.waitUntil(indexReading(entry,env).catch(()=>{}));
    const { excerpt, seq, ...result } = entry; return Response.json({ entry:result },{status:201});
  }
  const match = path.match(/^\/api\/reading\/([a-f0-9-]+)$/);
  if (!match || !uuid(match[1])) return null;
  if (request.method === 'PATCH') {
    const data = await readBody(request); if (typeof data.read !== 'boolean') fail(400,'Invalid reading status.');
    const entry = await env.JOURNAL_DB.prepare(`UPDATE reading SET read_at = ? WHERE id = ? RETURNING ${fields}`).bind(data.read ? new Date().toISOString() : null,match[1]).first();
    if (!entry) fail(404,'Saved link not found.'); return Response.json({entry});
  }
  if (request.method === 'DELETE') {
    const row = await env.JOURNAL_DB.prepare('DELETE FROM reading WHERE id = ? RETURNING id').bind(match[1]).first();
    if (!row) fail(404,'Saved link not found.'); return Response.json({ok:true});
  }
  return null;
}

function vectorArray(blob) {
  const bytes = blob instanceof ArrayBuffer ? blob : ArrayBuffer.isView(blob) ? blob.buffer.slice(blob.byteOffset,blob.byteOffset+blob.byteLength) : new Uint8Array(blob).buffer;
  return new Float32Array(bytes);
}
export async function relatedToThought(id, env) {
  const entry = await env.JOURNAL_DB.prepare('SELECT title,body FROM thoughts WHERE id = ?').bind(id).first();
  if (!entry) fail(404,'Thought not found.');
  const terms = ftsQuery(plainThoughtLinks(`${entry.title}\n${entry.body}`));
  const thoughts = new Map(), reading = new Map();
  if (terms) {
    const own = await env.JOURNAL_DB.prepare(`SELECT t.id FROM thoughts t JOIN thoughts_fts ON thoughts_fts.rowid=t.seq WHERE thoughts_fts MATCH ? AND t.id != ? ORDER BY bm25(thoughts_fts) LIMIT 12`).bind(terms,id).all();
    own.results.forEach((row,index)=>thoughts.set(row.id,1/(60+index)));
    const saved = await env.JOURNAL_DB.prepare(`SELECT r.id FROM reading r JOIN reading_fts ON reading_fts.rowid=r.seq WHERE reading_fts MATCH ? ORDER BY bm25(reading_fts) LIMIT 12`).bind(terms).all();
    saved.results.forEach((row,index)=>reading.set(row.id,1/(60+index)));
  }
  const source = await env.JOURNAL_DB.prepare('SELECT vectors,chunks,dimensions FROM embeddings WHERE thought_id = ? AND model = ?').bind(id,MODEL).first();
  if (source?.dimensions === DIMENSIONS) {
    const vectors = vectorArray(source.vectors);
    if (vectors.length === source.chunks * DIMENSIONS) {
      const query = new Float32Array(DIMENSIONS);
      for (let start=0;start<vectors.length;start+=DIMENSIONS) for (let i=0;i<DIMENSIONS;i++) query[i]+=vectors[start+i];
      const norm=Math.hypot(...query);
      if (norm) for (let i=0;i<DIMENSIONS;i++) query[i]/=norm;
      for (const [table,foreign,target] of norm ? [['embeddings','thought_id',thoughts],['reading_embeddings','reading_id',reading]] : []) {
        let after = '';
        const candidates = [];
        while (true) {
          const {results} = await env.JOURNAL_DB.prepare(`SELECT ${foreign} AS id,vectors,chunks,dimensions FROM ${table} WHERE ${foreign} > ? AND ${foreign} != ? AND model = ? ORDER BY ${foreign} LIMIT 80`).bind(after,id,MODEL).all();
          for (const row of results) {
            const score=maximumSimilarity(query,row.vectors,row.chunks,row.dimensions);
            if (score >= 0.55) candidates.push({id:row.id,score});
          }
          candidates.sort((a,b)=>b.score-a.score); candidates.length=Math.min(candidates.length,12);
          if (results.length<80) break; after=results.at(-1).id;
        }
        candidates.forEach((row,index)=>target.set(row.id,(target.get(row.id)||0)+1/(60+index)));
      }
    }
  }
  const select = async (map,table,columns) => {
    const ids=[...map].sort((a,b)=>b[1]-a[1]).slice(0,3).map(([id])=>id); if (!ids.length) return [];
    const {results}=await env.JOURNAL_DB.prepare(`SELECT ${columns} FROM ${table} WHERE id IN (${ids.map(()=>'?').join(',')})`).bind(...ids).all();
    const rows=new Map(results.map(row=>[row.id,row])); return ids.map(id=>rows.get(id)).filter(Boolean);
  };
  return { thoughts:await select(thoughts,'thoughts','id,title,substr(body,1,180) AS body'), reading:await select(reading,'reading',fields) };
}
