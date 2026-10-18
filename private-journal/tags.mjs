import { tagNames } from './public/tags.js';

export async function indexTags(entry,env) {
  const tags=tagNames(`${entry.title || ''}\n\n${entry.body}`);
  const current='EXISTS(SELECT 1 FROM thoughts WHERE id=? AND title=? AND body=? AND updated_at=?)';
  const args=[entry.id,entry.title || '',entry.body,entry.updated_at];
  await env.JOURNAL_DB.batch([
    env.JOURNAL_DB.prepare(`INSERT OR IGNORE INTO thought_tags(thought_id,tag) SELECT ?,value FROM json_each(?) WHERE ${current}`).bind(entry.id,JSON.stringify(tags),...args),
    env.JOURNAL_DB.prepare(`INSERT OR IGNORE INTO thought_tag_index(thought_id) SELECT ? WHERE ${current}`).bind(entry.id,...args)
  ]);
}
export async function repairTagIndex(env) {
  const pending='FROM thoughts t LEFT JOIN thought_tag_index i ON i.thought_id=t.id WHERE i.thought_id IS NULL';
  const {results}=await env.JOURNAL_DB.prepare(`SELECT t.id,t.title,t.body,t.updated_at ${pending} ORDER BY t.seq LIMIT 8`).all();
  for(const entry of results)await indexTags(entry,env);
  return Boolean((await env.JOURNAL_DB.prepare(`SELECT t.id ${pending} LIMIT 1`).first()));
}
