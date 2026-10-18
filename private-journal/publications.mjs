import { plainThoughtLinks } from './public/thought-links.js';
import { publishPhotoLinks, publicPhoto } from './photos.mjs';

export class PublicationError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const fail = (status, message) => { throw new PublicationError(status, message); };
const json = value => Response.json(value);
const slugPattern = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/;
const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

function text(value, maximum, name) {
  if (typeof value !== 'string' || value.length > maximum) fail(400, `Invalid ${name}.`);
  return value;
}
export function publicationData(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(400, 'Invalid public draft.');
  const slug = text(value.slug, 100, 'address');
  if (!slugPattern.test(slug)) fail(400, 'Use lowercase words, hyphens, or underscores for the address.');
  const title = text(value.title, 160, 'title');
  if (/[\r\n]/.test(title)) fail(400, 'Keep the title on one line.');
  const body = plainThoughtLinks(text(value.body, 20000, 'public text'));
  const date = text(value.date, 10, 'date');
  const timestamp = Date.parse(`${date}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== date) fail(400, 'Choose a valid date.');
  if (!Array.isArray(value.tags) || value.tags.length > 30 || value.tags.some(tag => typeof tag !== 'string' || tag.length > 80)) fail(400, 'Invalid tags.');
  const description = text(value.description, 1000, 'description');
  const cover = text(value.cover, 1000, 'cover');
  if (cover && !cover.startsWith('/static/images/') && !/^https:\/\//.test(cover)) fail(400, 'Use a public image address for the cover.');
  const coverPosition = text(value.coverPosition, 100, 'cover position');
  return { slug, title, body, date, tags: value.tags, description, cover, coverPosition };
}

function initialDraft(thought) {
  const slug = thought.title.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80).replace(/-$/, '') || thought.id;
  return { slug, title: thought.title, body: plainThoughtLinks(thought.body), date: thought.created_at.slice(0, 10), tags: [], description: '', cover: '', coverPosition: '' };
}
function ownerRecord(row, fallback) {
  if (!row) return { draft: initialDraft(fallback), version: 0, published: null, published_at: null };
  return { draft: JSON.parse(row.draft), version: row.version, published: row.published ? JSON.parse(row.published) : null, published_at: row.published_at };
}
function version(value) {
  if (!Number.isSafeInteger(value) || value < 0) fail(400, 'Invalid public draft version.');
  return value;
}
async function write(statement) {
  try { return await statement.first(); }
  catch (error) {
    if (/UNIQUE constraint failed.*published_slug/.test(error.message)) fail(409, 'That address is already published. Choose another.');
    throw error;
  }
}

export async function publicationApi(request, env, path, readBody) {
  if (path === '/api/import' && request.method === 'POST') {
    const input = await readBody(request);
    if (typeof input.source_key !== 'string' || !/^site-content\/posts\/[a-z0-9_-]+\.md$/.test(input.source_key) || !uuidPattern.test(input.id) || typeof input.published !== 'boolean') fail(400, 'Invalid import.');
    const previous = await env.JOURNAL_DB.prepare('SELECT thought_id FROM publications WHERE source_key = ?').bind(input.source_key).first();
    if (previous) return json({ id: previous.thought_id, imported: false });
    const draft = publicationData(input.draft);
    if (!draft.body.trim()) fail(400, 'Cannot import an empty post.');
    if (input.published && !draft.title.trim()) fail(400, 'Published posts need a title.');
    const now = new Date().toISOString();
    const encoded = JSON.stringify(draft);
    try {
      await env.JOURNAL_DB.batch([
        env.JOURNAL_DB.prepare('INSERT INTO thoughts(id, title, body, created_at, updated_at, source_date) VALUES (?, ?, ?, ?, ?, ?)').bind(input.id, draft.title, draft.body, `${draft.date}T12:00:00.000Z`, `${draft.date}T12:00:00.000Z`, draft.date),
        env.JOURNAL_DB.prepare(`INSERT INTO publications(thought_id, draft, published, published_slug, published_at, source_key, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)`).bind(input.id, encoded, input.published ? encoded : null, input.published ? draft.slug : null, input.published ? now : null, input.source_key, now)
      ]);
    } catch (error) {
      if (/UNIQUE constraint failed/.test(error.message)) fail(409, 'An imported post or address already exists.');
      throw error;
    }
    return Response.json({ id: input.id, imported: true }, { status: 201 });
  }
  const match = path.match(/^\/api\/thoughts\/([a-f0-9-]+)\/publication(?:\/(publish|unpublish))?$/);
  if (!match || !uuidPattern.test(match[1])) return null;
  const thought = await env.JOURNAL_DB.prepare('SELECT id, title, body, created_at FROM thoughts WHERE id = ?').bind(match[1]).first();
  if (!thought) fail(404, 'Thought not found.');
  const existing = await env.JOURNAL_DB.prepare('SELECT * FROM publications WHERE thought_id = ?').bind(thought.id).first();
  const action = match[2];
  if (!action && request.method === 'GET') return json(ownerRecord(existing, thought));
  if (!action && request.method === 'PUT') {
    const input = await readBody(request);
    const draft = publicationData(input.draft);
    const revision = version(input.version);
    const now = new Date().toISOString();
    let saved;
    if (!existing && revision === 0) {
      saved = await env.JOURNAL_DB.prepare(`INSERT INTO publications(thought_id, draft, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(thought_id) DO NOTHING RETURNING *`).bind(thought.id, JSON.stringify(draft), now).first();
    } else {
      saved = await env.JOURNAL_DB.prepare(`UPDATE publications SET draft = ?, version = version + 1, updated_at = ?
        WHERE thought_id = ? AND version = ? RETURNING *`).bind(JSON.stringify(draft), now, thought.id, revision).first();
    }
    if (!saved) fail(409, 'This public draft changed elsewhere. Reload before saving.');
    return json(ownerRecord(saved));
  }
  if (action && request.method === 'POST') {
    const input = await readBody(request);
    const revision = version(input.version);
    if (!existing || existing.version !== revision) fail(409, 'This public draft changed. Reload before continuing.');
    let result;
    if (action === 'publish') {
      const draft = publicationData(JSON.parse(existing.draft));
      if (!draft.title.trim() || !draft.body.trim()) fail(400, 'Add a title and text before publishing.');
      const published={...draft,...await publishPhotoLinks(draft.body,env)};
      result = await write(env.JOURNAL_DB.prepare(`UPDATE publications SET published = ?,
        published_slug = ?, published_at = COALESCE(published_at, ?), version = version + 1, updated_at = ?
        WHERE thought_id = ? AND version = ? RETURNING *`)
        .bind(JSON.stringify(published),draft.slug, new Date().toISOString(), new Date().toISOString(), thought.id, revision));
    } else {
      result = await env.JOURNAL_DB.prepare(`UPDATE publications SET published = NULL, published_slug = NULL,
        published_at = NULL, version = version + 1, updated_at = ? WHERE thought_id = ? AND version = ? RETURNING *`)
        .bind(new Date().toISOString(), thought.id, revision).first();
    }
    if (!result) fail(409, 'This public draft changed. Reload before continuing.');
    return json(ownerRecord(result));
  }
  fail(405, 'Method not allowed.');
}

const escapeXml = value => value.replace(/[<>&"']/g, char => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[char]);
export function markdown(post) {
  const metadata = { title: post.title, date: post.date, tags: post.tags, description: post.description, cover: post.cover, coverPosition: post.coverPosition };
  return `---\n${Object.entries(metadata).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join('\n')}\n---\n\n${post.body}\n`;
}
export async function publicWriting(request, env, url) {
  if (!['GET', 'HEAD'].includes(request.method)) fail(405, 'Method not allowed.');
  if (!env.JOURNAL_DB) fail(503, 'Writing is unavailable.');
  const photo=await publicPhoto(request,env,url.pathname);if(photo)return photo;
  let response;
  const article = url.pathname.match(/^\/public\/posts\/([a-z0-9_-]+)\.md$/);
  if (article) {
    const row = await env.JOURNAL_DB.prepare('SELECT published FROM publications WHERE published_slug = ? AND published IS NOT NULL').bind(article[1]).first();
    if (!row) fail(404, 'Post not found.');
    response = new Response(markdown(JSON.parse(row.published)), { headers: { 'Content-Type': 'text/markdown; charset=utf-8' } });
  } else if (['/public/posts/index.json', '/public/feed.xml', '/public/export.json'].includes(url.pathname)) {
    const { results } = await env.JOURNAL_DB.prepare('SELECT published FROM publications WHERE published IS NOT NULL').all();
    const posts = results.map(row => JSON.parse(row.published)).sort((a, b) => b.date.localeCompare(a.date) || a.slug.localeCompare(b.slug));
    if (url.pathname.endsWith('index.json')) {
      response = json(posts.map(({ body, slug, ...metadata }) => ({ ...metadata, file: `${slug}.md`, words: body.trim().split(/\s+/u).filter(Boolean).length })));
    } else if (url.pathname.endsWith('export.json')) response = json({ posts });
    else {
      const site = 'https://christopherli.dev';
      const items = posts.map(post => {
        const link = `${site}/#thought/${post.slug}`;
        return `<item><title>${escapeXml(post.title)}</title><link>${escapeXml(link)}</link><guid isPermaLink="false">${escapeXml(link)}</guid><pubDate>${new Date(`${post.date}T00:00:00Z`).toUTCString()}</pubDate><description>${escapeXml(post.description)}</description></item>`;
      }).join('');
      response = new Response(`<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>christopher li</title><link>${site}</link><description>writing by christopher li</description>${items}</channel></rss>`, { headers: { 'Content-Type': 'application/rss+xml; charset=utf-8' } });
    }
  } else fail(404, 'Not found.');
  response.headers.set('Access-Control-Allow-Origin', '*');
  response.headers.set('Cache-Control', 'no-store');
  return response;
}
