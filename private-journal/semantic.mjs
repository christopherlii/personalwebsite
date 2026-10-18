import { digest } from './auth.mjs';
import { ftsQuery, THOUGHT_FIELDS } from './search.mjs';
import { searchTerms } from './public/search-terms.js';
import { plainPhotoLinks } from './public/photo-links.js';

export const MODEL = '@cf/baai/bge-small-en-v1.5';
export const DIMENSIONS = 384;
export const RERANKER = '@cf/baai/bge-reranker-base';
const MIN_RELEVANCE = 0.4;
const MIN_PARAPHRASE_RELEVANCE = 0.02;
const MIN_RELATIVE_RELEVANCE = 0.2;
const MIN_LONG_QUERY_SIMILARITY = 0.65;
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

async function refine(query, candidates, matches, env) {
  if (!candidates.length) return [];
  const fold = text => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
  const terms = [...new Set(searchTerms(query).map(fold))];
  const contexts = [], owners = [];
  for (const entry of candidates) {
    const body=plainPhotoLinks(entry.body);
    const passages = chunksOf(entry.title ? `${entry.title}\n\n${body}` : body);
    const selected = new Set();
    const semantic = matches.get(entry.id);
    if (semantic) selected.add(semantic.chunk);
    let lexical = 0, coverage = 0;
    passages.forEach((passage, index) => {
      const words = (fold(passage).match(/[\p{L}\p{N}]+/gu) || []);
      const count = terms.filter(term => words.some(word => word.startsWith(term))).length;
      if (count > coverage) { coverage = count; lexical = index; }
    });
    if (coverage || !selected.size) selected.add(lexical);
    for (const index of selected) { contexts.push({ text: passages[index] }); owners.push(entry.id); }
  }
  // At most 40 thoughts, two 400-byte passages each. A word match is only a
  // candidate; every returned thought must pass the same relevance check.
  const result = await env.AI.run(RERANKER, { query, contexts, top_k: contexts.length });
  if (!Array.isArray(result.response) || result.response.length !== contexts.length) throw new Error('Invalid relevance response.');
  const scores = new Map(), seen = new Set();
  for (const item of result.response) {
    if (!Number.isInteger(item.id) || item.id < 0 || item.id >= contexts.length || seen.has(item.id) || !Number.isFinite(item.score) || item.score < 0 || item.score > 1) throw new Error('Invalid relevance score.');
    seen.add(item.id);
    const id = owners[item.id]; scores.set(id, Math.max(scores.get(id) || 0, item.score));
  }
  const best = Math.max(...scores.values());
  return candidates.filter(entry => {
    const score = scores.get(entry.id) || 0;
    // Strong direct relevance can stand alone. Lower-scoring paraphrases need
    // agreement from the embedding model and must stay near the best result.
    return score >= best * MIN_RELATIVE_RELEVANCE && (score >= MIN_RELEVANCE ||
      (score >= MIN_PARAPHRASE_RELEVANCE && matches.get(entry.id)?.score >= MIN_LONG_QUERY_SIMILARITY));
  })
    .sort((a, b) => scores.get(b.id) - scores.get(a.id) || b.seq - a.seq);
}

export async function semanticSearch(query, saved, cursor, env) {
  // Recover missed background jobs and existing entries in bounded batches.
  const pendingSql = `FROM thoughts t LEFT JOIN embeddings e ON e.thought_id = t.id
    WHERE e.thought_id IS NULL OR e.model != ?`;
  const pending = await env.JOURNAL_DB.prepare(`SELECT t.* ${pendingSql} ORDER BY t.seq LIMIT 4`).bind(MODEL).all();
  for (const entry of pending.results) await indexEntry(entry, env);
  const remaining = await env.JOURNAL_DB.prepare(`SELECT count(*) AS count ${pendingSql}`).bind(MODEL).first();
  const queryChunks = chunksOf(query);
  const refineShortQuery = queryChunks.length === 1;
  const queryVectors = await embedAll(queryChunks, env);
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
      const match = similarityMatch(queryVector, entry.vectors, entry.chunks, entry.dimensions);
      if (match.score >= (refineShortQuery ? 0.45 : MIN_LONG_QUERY_SIMILARITY)) ranked.push({ id: entry.id, ...match });
    }
    // Bound request memory while considering vectors from the full archive.
    ranked.sort((a, b) => b.score - a.score); ranked.length = Math.min(ranked.length, 200);
    if (results.length < 80) break;
    after = results.at(-1).seq;
  }
  const combined = new Map(ranked.map((entry, rank) => [entry.id, refineShortQuery ? 1 / (60 + rank) : entry.score]));
  const terms = ftsQuery(query);
  if (terms && refineShortQuery) {
    const lexical = await env.JOURNAL_DB.prepare(`SELECT t.id FROM thoughts t JOIN thoughts_fts ON thoughts_fts.rowid = t.seq
      WHERE thoughts_fts MATCH ?${saved ? ' AND t.bookmarked = 1' : ''} ORDER BY bm25(thoughts_fts), t.seq DESC LIMIT 200`).bind(terms).all();
    lexical.results.forEach((entry, rank) => combined.set(entry.id, (combined.get(entry.id) || 0) + 1 / (60 + rank)));
  }
  let ordered = [...combined].sort((a, b) => b[1] - a[1]);
  if (refineShortQuery && ordered.length) {
    const candidates = ordered.slice(0, 40).map(([id]) => id);
    const { results } = await env.JOURNAL_DB.prepare(`SELECT ${THOUGHT_FIELDS.map(field => `t.${field}`).join(', ')} FROM thoughts t WHERE t.id IN (${candidates.map(() => '?').join(',')})`).bind(...candidates).all();
    const refined = await refine(query, results, new Map(ranked.map(entry => [entry.id, entry])), env);
    return { entries: refined.slice(cursor, cursor + 40), next: null, indexing: remaining.count > 0 };
  }
  const ids = ordered.slice(cursor, cursor + 40).map(([id]) => id);
  let entries = [];
  if (ids.length) {
    const { results } = await env.JOURNAL_DB.prepare(`SELECT ${THOUGHT_FIELDS.map(field => `t.${field}`).join(', ')} FROM thoughts t WHERE t.id IN (${ids.map(() => '?').join(',')})`).bind(...ids).all();
    const byId = new Map(results.map(entry => [entry.id, entry]));
    entries = ids.map(id => byId.get(id)).filter(Boolean);
  }
  return { entries, next: ordered.length > cursor + 40 ? cursor + 40 : null, indexing: remaining.count > 0 };
}
