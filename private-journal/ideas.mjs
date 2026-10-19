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
  const { results } = await env.JOURNAL_DB.prepare(`SELECT t.id, t.body, t.updated_at ${pending} ORDER BY t.seq LIMIT 8`).all();
  for (const entry of results) await indexIdeas(entry, env);
  return Boolean(await env.JOURNAL_DB.prepare(`SELECT t.id ${pending} LIMIT 1`).first());
}

export async function ideaApi(request, env, path, readBody) {
  if (path === '/api/ideas' && request.method === 'GET') {
    const kind = new URL(request.url).searchParams.get('kind');
    if (!Object.hasOwn(IDEA_KINDS, kind)) fail(400, 'Invalid idea kind.');
    const indexing = await repairIdeaIndex(env);
    const { results } = await env.JOURNAL_DB.prepare(`SELECT i.id, i.kind, i.text, i.thought_id, i.created_at, i.done_at
      FROM thought_ideas i WHERE i.kind = ? ORDER BY i.done_at IS NOT NULL, COALESCE(i.done_at, i.created_at) DESC LIMIT 200`).bind(kind).all();
    return Response.json({ ideas: results, indexing });
  }
  const idea = path.match(/^\/api\/ideas\/([a-f0-9]{32})$/);
  if (idea && request.method === 'PATCH') {
    const data = await readBody(request);
    if (typeof data.done !== 'boolean') fail(400, 'Invalid idea.');
    const row = await env.JOURNAL_DB.prepare(`UPDATE thought_ideas SET done_at = ? WHERE id = ? RETURNING id, kind, text, thought_id, created_at, done_at`)
      .bind(data.done ? new Date().toISOString() : null, idea[1]).first();
    if (!row) fail(404, 'Idea not found.');
    return Response.json({ idea: row });
  }
  return null;
}
