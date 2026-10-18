import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Real public-site code reading the real local Worker's anonymous endpoints.
// All writing used by the calling browser test is explicitly synthetic.
export async function publicSitePreview(context, journalOrigin) {
  const page = await context.newPage();
  const root = fileURLToPath(new URL('../../', import.meta.url));
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.hostname === 'journal-preview.test' && url.pathname.startsWith('/public/')) {
      const response = await context.request.get(journalOrigin + url.pathname, { headers: { Cookie: '' } });
      return route.fulfill({ response, headers: { ...response.headers(), 'access-control-allow-origin': '*' } });
    }
    if (url.hostname !== 'site-preview.test') return route.abort();
    if (url.pathname === '/writing-source.json') return route.fulfill({ json: { posts: 'https://journal-preview.test/public/posts', feed: 'https://journal-preview.test/public/feed.xml' } });
    const relative = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    if (relative.includes('..') || relative.startsWith('private-journal/') || relative.startsWith('content/')) return route.fulfill({ status: 404 });
    const type = relative.endsWith('.html') ? 'text/html' : relative.endsWith('.js') ? 'application/javascript' : relative.endsWith('.css') ? 'text/css' : relative.endsWith('.json') ? 'application/json' : relative.endsWith('.woff2') ? 'font/woff2' : relative.endsWith('.jpg') ? 'image/jpeg' : relative.endsWith('.png') ? 'image/png' : 'application/octet-stream';
    try { return route.fulfill({ contentType: type, body: await readFile(resolve(root, relative)) }); }
    catch { return route.fulfill({ status: 404, contentType: type, body: relative.endsWith('.json') ? '[]' : '' }); }
  });
  return page;
}
