import { hex } from './auth.mjs';

// PDFs to read closely, with notes and explanations in the margin.
export class DocumentError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const fail = (status, message) => { throw new DocumentError(status, message); };
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
export const MAXIMUM_BYTES = 20 * 1024 * 1024;
// Each stored part stays well under D1's 2 MB row limit.
const PART_BYTES = 1500000;
const EXPLAIN_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
const fields = 'id, title, bytes, pages, page, created_at, opened_at';
const noteFields = 'id, document_id, page, start, length, top, quote, kind, question, body, created_at';

async function readPdf(request) {
  if (request.headers.get('Content-Type') !== 'application/pdf') fail(415, 'Drop a PDF.');
  const reader = request.body?.getReader(); if (!reader) fail(400, 'Drop a PDF.');
  const chunks = []; let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      size += value.length;
      if (size > MAXIMUM_BYTES) { await reader.cancel(); fail(413, 'This PDF is too large. PDFs can be up to 20 MB.'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const data = new Uint8Array(size); let at = 0;
  for (const chunk of chunks) { data.set(chunk, at); at += chunk.length; }
  // The header may follow a little leading junk, but it has to be there.
  if (!String.fromCharCode(...data.subarray(0, 1024)).includes('%PDF-')) fail(415, 'This file is not a PDF.');
  return data;
}

async function explain(env, document, data) {
  if (!env.AI) fail(503, 'Explain is unavailable here.');
  const question = typeof data.question === 'string' ? data.question.trim() : '';
  const context = typeof data.context === 'string' ? data.context.slice(0, 6000) : '';
  if (question.length > 500) fail(400, 'Ask a question of up to 500 characters.');
  const messages = [
    { role: 'system', content: 'You help someone read a document closely. They selected a passage and want to understand it. ' +
      'Explain what it means in plain words, define any jargon, and say why it matters where it appears. ' +
      'If they ask a question, answer that. Be brief: at most about 120 words, no preamble, no headings, no lists unless they help. ' +
      'Write in lowercase, like a friend\'s note in the margin.' },
    { role: 'user', content: `document: ${document.title}\n\nsurrounding text:\n${context}\n\nselected passage:\n"${data.quote}"\n\n${question ? `question: ${question}` : 'explain the selected passage.'}` }
  ];
  let result;
  try { result = await env.AI.run(EXPLAIN_MODEL, { messages, max_tokens: 400 }); }
  catch { fail(502, 'Explain is unavailable. Try again.'); }
  const answer = (typeof result?.response === 'string' ? result.response : result?.choices?.[0]?.message?.content || '').trim().slice(0, 4000);
  if (!answer) fail(502, 'Explain is unavailable. Try again.');
  return { question, answer };
}

export async function documentApi(request, env, path, readBody, limit) {
  const db = env.JOURNAL_DB;
  if (path === '/api/documents' && request.method === 'GET') {
    // An upload interrupted partway leaves an incomplete row; clear old ones.
    await db.prepare('DELETE FROM documents WHERE complete = 0 AND created_at < ?').bind(new Date(Date.now() - 3600000).toISOString()).run();
    const { results } = await db.prepare(`SELECT ${fields.split(', ').map(field => `d.${field}`).join(', ')}, (SELECT count(*) FROM annotations a WHERE a.document_id = d.id) AS notes
      FROM documents d WHERE complete = 1 ORDER BY COALESCE(opened_at, created_at) DESC LIMIT 100`).all();
    return Response.json({ documents: results });
  }
  const note = path.match(/^\/api\/annotations\/([a-f0-9-]+)$/);
  if (note && uuid(note[1]) && request.method === 'DELETE') {
    if (!await db.prepare('DELETE FROM annotations WHERE id = ? RETURNING id').bind(note[1]).first()) fail(404, 'Note not found.');
    return Response.json({ ok: true });
  }
  const match = path.match(/^\/api\/documents\/([a-f0-9-]+)(\/file|\/annotations)?$/);
  if (!match || !uuid(match[1])) return null;
  const id = match[1], part = match[2];
  if (!part && request.method === 'PUT') {
    await limit(env, 'documents:global', 10, 60 * 1000);
    const url = new URL(request.url);
    const title = (url.searchParams.get('title') || '').replace(/\s+/g, ' ').trim();
    const pages = Number(url.searchParams.get('pages'));
    if (!title || title.length > 160) fail(400, 'Give the PDF a title of up to 160 characters.');
    if (!Number.isSafeInteger(pages) || pages < 1 || pages > 5000) fail(400, 'Invalid page count.');
    const data = await readPdf(request);
    const sha256 = hex(new Uint8Array(await crypto.subtle.digest('SHA-256', data)));
    const existing = await db.prepare(`SELECT ${fields}, sha256, complete FROM documents WHERE id = ?`).bind(id).first();
    if (existing) {
      if (existing.sha256 !== sha256 || !existing.complete) fail(409, 'This PDF already exists.');
      const { sha256: hash, complete, ...document } = existing; return Response.json({ document });
    }
    await db.prepare('INSERT INTO documents(id, title, bytes, pages, sha256, created_at) VALUES (?, ?, ?, ?, ?, ?)').bind(id, title, data.length, pages, sha256, new Date().toISOString()).run();
    try {
      for (let at = 0, index = 0; at < data.length; at += PART_BYTES, index++) {
        const slice = data.slice(at, at + PART_BYTES);
        await db.prepare('INSERT INTO document_parts(document_id, part, data) VALUES (?, ?, ?)').bind(id, index, slice.buffer).run();
      }
      const document = await db.prepare(`UPDATE documents SET complete = 1 WHERE id = ? RETURNING ${fields}`).bind(id).first();
      return Response.json({ document: { ...document, notes: 0 } }, { status: 201 });
    } catch (error) {
      await db.prepare('DELETE FROM documents WHERE id = ?').bind(id).run().catch(() => {});
      throw error;
    }
  }
  const document = await db.prepare(`SELECT ${fields} FROM documents WHERE id = ? AND complete = 1`).bind(id).first();
  if (!document) fail(404, 'PDF not found.');
  if (!part && request.method === 'GET') return Response.json({ document });
  if (!part && request.method === 'PATCH') {
    // Opening a PDF, and where you were in it, so it reopens there.
    const data = await readBody(request);
    if (!Number.isSafeInteger(data.page) || data.page < 1 || data.page > document.pages) fail(400, 'Invalid page.');
    return Response.json({ document: await db.prepare(`UPDATE documents SET page = ?, opened_at = ? WHERE id = ? RETURNING ${fields}`).bind(data.page, new Date().toISOString(), id).first() });
  }
  if (!part && request.method === 'DELETE') {
    await db.prepare('DELETE FROM documents WHERE id = ?').bind(id).run();
    return Response.json({ ok: true });
  }
  if (part === '/file' && ['GET', 'HEAD'].includes(request.method)) {
    const count = Math.ceil(document.bytes / PART_BYTES);
    let index = 0;
    const body = request.method === 'HEAD' ? null : new ReadableStream({
      async pull(controller) {
        if (index >= count) { controller.close(); return; }
        const row = await db.prepare('SELECT data FROM document_parts WHERE document_id = ? AND part = ?').bind(id, index++).first();
        if (!row) { controller.error(new Error('Missing PDF part.')); return; }
        controller.enqueue(new Uint8Array(row.data));
      }
    });
    return new Response(body, { headers: { 'Content-Type': 'application/pdf', 'Content-Length': String(document.bytes), 'Content-Disposition': 'inline' } });
  }
  if (part === '/annotations' && request.method === 'GET') {
    const { results } = await db.prepare(`SELECT ${noteFields} FROM annotations WHERE document_id = ? ORDER BY page, top, created_at`).bind(id).all();
    return Response.json({ annotations: results });
  }
  if (part === '/annotations' && request.method === 'POST') {
    const data = await readBody(request);
    if (!uuid(data.id) || !['note', 'ai'].includes(data.kind)) fail(400, 'Invalid note.');
    const existing = await db.prepare(`SELECT ${noteFields} FROM annotations WHERE id = ?`).bind(data.id).first();
    if (existing) {
      if (existing.document_id !== id) fail(409, 'This note already exists.');
      return Response.json({ annotation: existing });
    }
    const quote = typeof data.quote === 'string' ? data.quote.replace(/\s+/g, ' ').trim() : '';
    if (!quote || quote.length > 2000) fail(400, 'Select up to 2,000 characters.');
    if (!Number.isSafeInteger(data.page) || data.page < 1 || data.page > document.pages ||
      !Number.isSafeInteger(data.start) || data.start < 0 || !Number.isSafeInteger(data.length) || data.length < 1 || data.length > 20000 ||
      typeof data.top !== 'number' || !(data.top >= 0 && data.top <= 1)) fail(400, 'Invalid passage.');
    let question = '', body;
    if (data.kind === 'note') {
      body = typeof data.body === 'string' ? data.body.trim() : '';
      if (!body || body.length > 4000) fail(400, 'Write a note of up to 4,000 characters.');
    } else {
      await limit(env, 'explain:minute', 20, 60 * 1000);
      await limit(env, 'explain:hour', 200, 3600 * 1000);
      ({ question, answer: body } = await explain(env, document, { ...data, quote }));
    }
    const annotation = await db.prepare(`INSERT INTO annotations(id, document_id, page, start, length, top, quote, kind, question, body, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING ${noteFields}`)
      .bind(data.id, id, data.page, data.start, data.length, data.top, quote, data.kind, question, body, new Date().toISOString()).first();
    return Response.json({ annotation }, { status: 201 });
  }
  return null;
}
