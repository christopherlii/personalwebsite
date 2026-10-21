// Goals: a short list of things committed to, kept beside the writing. A goal
// is done once and then kept; a habit is marked on each day it is done.
export class GoalError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const fail = (status, message) => { throw new GoalError(status, message); };
const fields = 'id, kind, text, created_at, done_at';
// Days come from the browser, in the writer's own time zone, so they are
// checked loosely against the server's clock: nothing far in the future.
function validDay(day) {
  if (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day) || Number.isNaN(Date.parse(`${day}T00:00:00Z`))) return false;
  const at = Date.parse(`${day}T00:00:00Z`), now = Date.now();
  return at <= now + 2 * 86400000 && at >= now - 3660 * 86400000;
}

export async function goalApi(request, env, path, readBody) {
  if (path === '/api/goals' && request.method === 'GET') {
    // Every open goal and habit, then the most recently kept few goals. A
    // habit carries its recent days, newest first, for its week and streak.
    const days = `(SELECT json_group_array(day) FROM (SELECT day FROM goal_days d WHERE d.goal_id = g.id ORDER BY day DESC LIMIT 1000)) AS days`;
    const { results } = await env.JOURNAL_DB.prepare(`SELECT ${fields}, ${days} FROM goals g WHERE done_at IS NULL
      UNION ALL SELECT * FROM (SELECT ${fields}, '[]' AS days FROM goals g WHERE done_at IS NOT NULL ORDER BY done_at DESC LIMIT 5)`).all();
    const goals = results.map(goal => ({ ...goal, days: goal.kind === 'habit' ? JSON.parse(goal.days) : undefined }));
    const open = goals.filter(goal => !goal.done_at).sort((a, b) => a.created_at.localeCompare(b.created_at));
    return Response.json({ goals: [...open, ...goals.filter(goal => goal.done_at)] });
  }
  if (path === '/api/goals' && request.method === 'POST') {
    const data = await readBody(request);
    const kind = data.kind ?? 'goal';
    if (!/^[a-f0-9]{32}$/.test(data.id || '') || !['goal', 'habit'].includes(kind)) fail(400, 'Invalid goal.');
    const text = typeof data.text === 'string' ? data.text.trim() : '';
    if (!text || text.length > 280 || /[\r\n]/.test(text)) fail(400, 'Write a goal of up to 280 characters on one line.');
    const existing = await env.JOURNAL_DB.prepare(`SELECT ${fields} FROM goals WHERE id = ?`).bind(data.id).first();
    if (existing) return Response.json({ goal: existing });
    const goal = await env.JOURNAL_DB.prepare(`INSERT INTO goals(id, kind, text, created_at) VALUES (?, ?, ?, ?) RETURNING ${fields}`).bind(data.id, kind, text, new Date().toISOString()).first();
    return Response.json({ goal: kind === 'habit' ? { ...goal, days: [] } : goal }, { status: 201 });
  }
  const day = path.match(/^\/api\/goals\/([a-f0-9]{32})\/days\/([0-9-]+)$/);
  if (day && request.method === 'PUT') {
    const data = await readBody(request);
    if (typeof data.done !== 'boolean' || !validDay(day[2])) fail(400, 'Invalid day.');
    const habit = await env.JOURNAL_DB.prepare('SELECT kind FROM goals WHERE id = ?').bind(day[1]).first();
    if (!habit) fail(404, 'Goal not found.');
    if (habit.kind !== 'habit') fail(400, 'Only habits are kept by the day.');
    await env.JOURNAL_DB.prepare(data.done ? 'INSERT OR IGNORE INTO goal_days(goal_id, day) VALUES (?, ?)' : 'DELETE FROM goal_days WHERE goal_id = ? AND day = ?').bind(day[1], day[2]).run();
    return Response.json({ ok: true });
  }
  const goal = path.match(/^\/api\/goals\/([a-f0-9]{32})$/);
  if (goal && request.method === 'PATCH') {
    const data = await readBody(request);
    if (typeof data.done !== 'boolean') fail(400, 'Invalid goal.');
    const row = await env.JOURNAL_DB.prepare(`UPDATE goals SET done_at = ? WHERE id = ? AND kind = 'goal' RETURNING ${fields}`).bind(data.done ? new Date().toISOString() : null, goal[1]).first();
    if (!row) fail(404, 'Goal not found.');
    return Response.json({ goal: row });
  }
  if (goal && request.method === 'DELETE') {
    if (!await env.JOURNAL_DB.prepare('DELETE FROM goals WHERE id = ? RETURNING id').bind(goal[1]).first()) fail(404, 'Goal not found.');
    return Response.json({ ok: true });
  }
  return null;
}
