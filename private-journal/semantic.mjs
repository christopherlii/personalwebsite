import { digest } from './auth.mjs';
import { ftsQuery, THOUGHT_FIELDS } from './search.mjs';
import { plainPhotoLinks } from './public/photo-links.js';

export const MODEL = '@cf/baai/bge-small-en-v1.5';
export const DIMENSIONS = 384;
// Related thoughts (reading page) and the composer's search share one ranking:
// the closest stored vectors above this similarity, fused with word matches.
export const RELATED_SIMILARITY = 0.55;
const SEARCH_POOL = 20;
const encoder = new TextEncoder();

export function chunksOf(text) {
  // <=400 UTF-8 bytes also bounds byte-fallback tokenization below 512 tokens.
  // Overlap preserves concepts that cross a chunk boundary. Never truncate.
  const points = Array.from(text), chunks = [];
  for (let start = 0; start < points.length;) {
    let end = start, bytes = 0;
    while (end < points.length && bytes + encoder.encode(points[end]).length <= 400) bytes += encoder.encode(points[end++]).length;
    chunks.push(points.slice(start, end).join(''));
    if (end === points.length) break;
    start = Math.max(start + 1, end - 30);
  }
  return chunks;
}

async function embed(texts, env) {
  const result = await env.AI.run(MODEL, { text: texts });
  if (!Array.isArray(result.data) || result.data.length !== texts.length) throw new Error('Invalid embedding response.');
  return result.data.map(vector => {
    if (!Array.isArray(vector) || vector.length !== DIMENSIONS || !vector.every(Number.isFinite)) throw new Error('Invalid embedding vector.');
    const length = Math.hypot(...vector);
    if (length === 0) throw new Error('Empty embedding vector.');
    return vector.map(value => value / length);
  });
}

async function embedAll(chunks, env) {
  const vectors = [];
  for (let start = 0; start < chunks.length; start += 8) vectors.push(...await embed(chunks.slice(start, start + 8), env));
  return vectors;
}

export async function indexEntry(entry, env) {
  if (!env.AI) return;
  const body=plainPhotoLinks(entry.body);
  const content = entry.title ? `${entry.title}\n\n${body}` : body;
  const bodyHash = await digest(content);
  const existing = await env.JOURNAL_DB.prepare('SELECT body_hash, model FROM embeddings WHERE thought_id = ?').bind(entry.id).first();
  if (existing?.body_hash === bodyHash && existing.model === MODEL) return;
  const vectors = await embedAll(chunksOf(content), env);
  const packed = new Float32Array(vectors.flat());
  // An old async indexing job cannot replace an embedding for a newer edit.
  await env.JOURNAL_DB.prepare(`INSERT OR REPLACE INTO embeddings(thought_id, body_hash, model, vectors, chunks, dimensions)
    SELECT ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM thoughts WHERE id = ? AND body = ? AND title = ? AND updated_at = ?)`)
    .bind(entry.id, bodyHash, MODEL, packed.buffer, vectors.length, DIMENSIONS, entry.id, entry.body, entry.title || '', entry.updated_at).run();
}

function similarityMatch(query, blob, count, dimensions) {
  const bytes = blob instanceof ArrayBuffer ? blob : ArrayBuffer.isView(blob) ? blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength) : new Uint8Array(blob).buffer;
  if (dimensions !== query.length || bytes.byteLength !== count * dimensions * 4) return { score: -1, chunk: 0 };
  const vectors = new Float32Array(bytes);
  let best = { score: -1, chunk: 0 };
  for (let chunk = 0; chunk < count; chunk++) {
    let score = 0;
    for (let i = 0; i < dimensions; i++) score += query[i] * vectors[chunk * dimensions + i];
    if (score > best.score) best = { score, chunk };
  }
  return best;
}
export function maximumSimilarity(query, blob, count, dimensions) {
  return similarityMatch(query, blob, count, dimensions).score;
}

export async function closestEmbeddings(env, query, { table = 'embeddings', key = 'thought_id', exclude = '', saved = false, limit = 12 } = {}) {
  const savedOnly = saved ? ` AND ${key} IN (SELECT id FROM thoughts WHERE bookmarked = 1)` : '';
  const candidates = [];
  let after = '';
  while (true) {
    const { results } = await env.JOURNAL_DB.prepare(`SELECT ${key} AS id, vectors, chunks, dimensions FROM ${table}
      WHERE ${key} > ? AND ${key} != ? AND model = ?${savedOnly} ORDER BY ${key} LIMIT 80`).bind(after, exclude, MODEL).all();
    for (const row of results) {
      const score = maximumSimilarity(query, row.vectors, row.chunks, row.dimensions);
      if (score >= RELATED_SIMILARITY) candidates.push({ id: row.id, score });
    }
    // Bound request memory while considering vectors from the full archive.
    candidates.sort((a, b) => b.score - a.score); candidates.length = Math.min(candidates.length, limit);
    if (results.length < 80) break;
    after = results.at(-1).id;
  }
  return candidates.map(row => row.id);
}

// Reciprocal-rank fusion: an id ranked well by both lists rises to the top.
export function fuse(scores, ids) {
  ids.forEach((id, rank) => scores.set(id, (scores.get(id) || 0) + 1 / (60 + rank)));
}

export async function semanticSearch(query, saved, cursor, env) {
  // Recover missed background jobs and existing entries in bounded batches.
  const pendingSql = `FROM thoughts t LEFT JOIN embeddings e ON e.thought_id = t.id
    WHERE e.thought_id IS NULL OR e.model != ?`;
  const pending = await env.JOURNAL_DB.prepare(`SELECT t.* ${pendingSql} ORDER BY t.seq LIMIT 4`).bind(MODEL).all();
  for (const entry of pending.results) await indexEntry(entry, env);
  const remaining = await env.JOURNAL_DB.prepare(`SELECT count(*) AS count ${pendingSql}`).bind(MODEL).first();
  const queryVectors = await embedAll(chunksOf(query), env);
  const queryVector = Array.from({ length: DIMENSIONS }, (_, index) => queryVectors.reduce((sum, vector) => sum + vector[index], 0));
  const norm = Math.hypot(...queryVector);
  if (!norm) throw new Error('Empty query vector.');
  for (let i = 0; i < queryVector.length; i++) queryVector[i] /= norm;
  const scores = new Map();
  // Typed words must all appear for a word match, so one shared word ("out")
  // can't pull an unrelated thought up beside the meaning matches.
  const terms = ftsQuery(query, true);
  if (terms) {
    const lexical = await env.JOURNAL_DB.prepare(`SELECT t.id FROM thoughts t JOIN thoughts_fts ON thoughts_fts.rowid = t.seq
      WHERE thoughts_fts MATCH ?${saved ? ' AND t.bookmarked = 1' : ''} ORDER BY bm25(thoughts_fts), t.seq DESC LIMIT ${SEARCH_POOL}`).bind(terms).all();
    fuse(scores, lexical.results.map(row => row.id));
  }
  fuse(scores, await closestEmbeddings(env, queryVector, { saved, limit: SEARCH_POOL }));
  const ids = [...scores].sort((a, b) => b[1] - a[1]).map(([id]) => id).slice(cursor, cursor + 40);
  let entries = [];
  if (ids.length) {
    const { results } = await env.JOURNAL_DB.prepare(`SELECT ${THOUGHT_FIELDS.map(field => `t.${field}`).join(', ')} FROM thoughts t WHERE t.id IN (${ids.map(() => '?').join(',')})`).bind(...ids).all();
    const byId = new Map(results.map(entry => [entry.id, entry]));
    entries = ids.map(id => byId.get(id)).filter(Boolean);
  }
  return { entries, next: null, indexing: remaining.count > 0 };
}
