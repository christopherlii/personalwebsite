import { digest } from './auth.mjs';
import { ftsQuery, THOUGHT_FIELDS } from './search.mjs';

export const MODEL = '@cf/baai/bge-small-en-v1.5';
export const DIMENSIONS = 384;
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
  const content = entry.title ? `${entry.title}\n\n${entry.body}` : entry.body;
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

export function maximumSimilarity(query, blob, count, dimensions) {
  const bytes = blob instanceof ArrayBuffer ? blob : ArrayBuffer.isView(blob) ? blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength) : new Uint8Array(blob).buffer;
  if (dimensions !== query.length || bytes.byteLength !== count * dimensions * 4) return -1;
  const vectors = new Float32Array(bytes);
  let best = -1;
  for (let chunk = 0; chunk < count; chunk++) {
    let score = 0;
    for (let i = 0; i < dimensions; i++) score += query[i] * vectors[chunk * dimensions + i];
    best = Math.max(best, score);
  }
  return best;
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
  const ranked = [];
  let after = 0;
  while (true) {
    const { results } = await env.JOURNAL_DB.prepare(`SELECT t.seq, t.id, e.vectors, e.chunks, e.dimensions
      FROM thoughts t JOIN embeddings e ON e.thought_id = t.id WHERE t.seq > ? AND e.model = ?${saved ? ' AND t.bookmarked = 1' : ''} ORDER BY t.seq LIMIT 80`).bind(after, MODEL).all();
    for (const entry of results) {
      const score = maximumSimilarity(queryVector, entry.vectors, entry.chunks, entry.dimensions);
      if (score >= 0.45) ranked.push({ id: entry.id, score });
    }
    // Bound request memory while considering vectors from the full archive.
    ranked.sort((a, b) => b.score - a.score); ranked.length = Math.min(ranked.length, 200);
    if (results.length < 80) break;
    after = results.at(-1).seq;
  }
  const combined = new Map(ranked.map((entry, rank) => [entry.id, 1 / (60 + rank)]));
  const terms = ftsQuery(query);
  if (terms) {
    const lexical = await env.JOURNAL_DB.prepare(`SELECT t.id FROM thoughts t JOIN thoughts_fts ON thoughts_fts.rowid = t.seq
      WHERE thoughts_fts MATCH ?${saved ? ' AND t.bookmarked = 1' : ''} ORDER BY bm25(thoughts_fts), t.seq DESC LIMIT 200`).bind(terms).all();
    lexical.results.forEach((entry, rank) => combined.set(entry.id, (combined.get(entry.id) || 0) + 1 / (60 + rank)));
  }
  const ordered = [...combined].sort((a, b) => b[1] - a[1]);
  const ids = ordered.slice(cursor, cursor + 40).map(([id]) => id);
  let entries = [];
  if (ids.length) {
    const { results } = await env.JOURNAL_DB.prepare(`SELECT ${THOUGHT_FIELDS.map(field => `t.${field}`).join(', ')} FROM thoughts t WHERE t.id IN (${ids.map(() => '?').join(',')})`).bind(...ids).all();
    const byId = new Map(results.map(entry => [entry.id, entry]));
    entries = ids.map(id => byId.get(id)).filter(Boolean);
  }
  return { entries, next: ordered.length > cursor + 40 ? cursor + 40 : null, indexing: remaining.count > 0 };
}
