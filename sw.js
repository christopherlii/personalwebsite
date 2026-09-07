// Asset cache: photos and fonts only, served stale-while-revalidate — a
// repeat visit paints them from disk instantly while a background fetch
// keeps the copy fresh. HTML, CSS, JS, and JSON never enter this cache, so
// a deploy is live on the very next load, same as before.
const CACHE = 'assets-v1';

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== location.origin) return;
  if (!url.pathname.startsWith('/static/images/') &&
      !url.pathname.startsWith('/static/fonts/')) return;
  event.respondWith(
    caches.open(CACHE).then(cache =>
      cache.match(event.request).then(hit => {
        const refresh = fetch(event.request).then(resp => {
          if (resp.ok) cache.put(event.request, resp.clone());
          return resp;
        });
        if (hit) refresh.catch(() => {}); // offline refresh is fine — we have the copy
        return hit || refresh;
      })
    )
  );
});
