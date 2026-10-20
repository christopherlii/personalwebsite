import { ideaLines, IDEA_KINDS } from './public/ideas.js';

export class IdeaError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const fail = (status, message) => { throw new IdeaError(status, message); };

export async function indexIdeas(entry, env) {
  const ideas = ideaLines(entry.body);
  // Every write is guarded by the exact version it was computed from, so an
  // older pass can't undo a newer edit.
  const current = 'EXISTS(SELECT 1 FROM thoughts WHERE id = ? AND body = ? AND updated_at = ?)';
  const args = [entry.id, entry.body, entry.updated_at];
  await env.JOURNAL_DB.batch([
    env.JOURNAL_DB.prepare(`DELETE FROM thought_ideas WHERE thought_id = ? AND kind || char(10) || text NOT IN (SELECT value FROM json_each(?)) AND ${current}`)
      .bind(entry.id, JSON.stringify(ideas.map(idea => `${idea.kind}\n${idea.text}`)), ...args),
    env.JOURNAL_DB.prepare(`INSERT OR IGNORE INTO thought_ideas(id, thought_id, kind, text, created_at)
      SELECT lower(hex(randomblob(16))), ?, json_extract(value, '$.kind'), json_extract(value, '$.text'), (SELECT created_at FROM thoughts WHERE id = ?)
      FROM json_each(?) WHERE ${current}`).bind(entry.id, entry.id, JSON.stringify(ideas), ...args),
    env.JOURNAL_DB.prepare(`INSERT OR IGNORE INTO thought_idea_index(thought_id) SELECT ? WHERE ${current}`).bind(entry.id, ...args)
  ]);
}

export async function repairIdeaIndex(env) {
  const pending = 'FROM thoughts t LEFT JOIN thought_idea_index i ON i.thought_id = t.id WHERE i.thought_id IS NULL';
  const { results } = await env.JOURNAL_DB.prepare(`SELECT t.id, t.body, t.updated_at ${pending} ORDER BY t.seq LIMIT 25`).all();
  // Usually nothing is pending, so the common case costs a single query.
  if (!results.length) return false;
  await Promise.all(results.map(entry => indexIdeas(entry, env)));
  return results.length === 25 && Boolean(await env.JOURNAL_DB.prepare(`SELECT t.id ${pending} LIMIT 1`).first());
}

export async function ideaApi(request, env, path, readBody) {
  if (path === '/api/ideas' && request.method === 'GET') {
    const kind = new URL(request.url).searchParams.get('kind');
    if (!Object.hasOwn(IDEA_KINDS, kind)) fail(400, 'Invalid idea kind.');
    const indexing = await repairIdeaIndex(env);
    const { results } = await env.JOURNAL_DB.prepare(`SELECT * FROM (
      SELECT id, kind, text, thought_id, created_at, done_at, 'line' AS origin FROM thought_ideas WHERE kind = ? AND dismissed_at IS NULL
      UNION ALL SELECT id, kind, text, context_id, created_at, done_at, 'loose' FROM loose_ideas WHERE kind = ?
    ) ORDER BY done_at IS NOT NULL, COALESCE(done_at, created_at) DESC LIMIT 200`).bind(kind, kind).all();
    return Response.json({ ideas: results, indexing });
  }
  if (path === '/api/ideas' && request.method === 'POST') {
    const data = await readBody(request);
    if (!/^[a-f0-9]{32}$/.test(data.id || '') || !Object.hasOwn(IDEA_KINDS, data.kind)) fail(400, 'Invalid idea.');
    const text = typeof data.text === 'string' ? data.text.trim() : '';
    if (!text || text.length > 280 || /[\r\n]/.test(text)) fail(400, 'Write an idea of up to 280 characters on one line.');
    const existing = await env.JOURNAL_DB.prepare('SELECT id, kind, text, context_id AS thought_id, created_at, done_at FROM loose_ideas WHERE id = ?').bind(data.id).first();
    if (existing) return Response.json({ idea: { ...existing, origin: 'loose' } });
    // A standalone idea stands alone; an idea written in a note links to it.
    const idea = await env.JOURNAL_DB.prepare(`INSERT INTO loose_ideas(id, kind, text, created_at)
      VALUES (?, ?, ?, ?) RETURNING id, kind, text, context_id AS thought_id, created_at, done_at`)
      .bind(data.id, data.kind, text, new Date().toISOString()).first();
    return Response.json({ idea: { ...idea, origin: 'loose' } }, { status: 201 });
  }
  const idea = path.match(/^\/api\/ideas\/([a-f0-9]{32})$/);
  if (idea && request.method === 'PATCH') {
    const data = await readBody(request);
    if (typeof data.done !== 'boolean') fail(400, 'Invalid idea.');
    const done = data.done ? new Date().toISOString() : null;
    const row = await env.JOURNAL_DB.prepare(`UPDATE thought_ideas SET done_at = ? WHERE id = ? RETURNING id, kind, text, thought_id, created_at, done_at`).bind(done, idea[1]).first()
      || await env.JOURNAL_DB.prepare(`UPDATE loose_ideas SET done_at = ? WHERE id = ? RETURNING id, kind, text, context_id AS thought_id, created_at, done_at`).bind(done, idea[1]).first();
    if (!row) fail(404, 'Idea not found.');
    return Response.json({ idea: row });
  }
  // Crossing an idea off: a standalone one is deleted; one from a note leaves
  // the list but stays in the note's text.
  if (idea && request.method === 'DELETE') {
    const removed = await env.JOURNAL_DB.prepare('DELETE FROM loose_ideas WHERE id = ? RETURNING id').bind(idea[1]).first()
      || await env.JOURNAL_DB.prepare('UPDATE thought_ideas SET dismissed_at = ? WHERE id = ? RETURNING id').bind(new Date().toISOString(), idea[1]).first();
    if (!removed) fail(404, 'Idea not found.');
    return Response.json({ ok: true });
  }
  return null;
}
