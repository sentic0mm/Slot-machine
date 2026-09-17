// Cache-Version: bei jedem größeren Update hochzählen (v2 -> v3 ...).
// Das erzwingt, dass alte Caches gelöscht werden.
const CACHE = 'slots-v39';
const ASSETS = ['./', './index.html', './manifest.json'];

self.addEventListener('install', e => {
  // Neuen Service Worker sofort aktivieren, nicht erst beim nächsten Mal warten.
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE).map(k => caches.delete(k))
      ))
      // Sofort die Kontrolle über offene Seiten übernehmen.
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;

  // Nur GET lässt sich überhaupt cachen (Cache.put() wirft bei POST/PUT/...
  // einen Fehler). Betrifft z.B. die POST-Aufrufe an den Leaderboard-Worker -
  // die einfach ganz normal ans Netzwerk durchreichen, ohne Cache-Umweg.
  if (req.method !== 'GET') {
    e.respondWith(fetch(req));
    return;
  }

  // HTML / Seitenaufrufe: ZUERST Netzwerk, damit Updates (z.B. Multiplayer)
  // sofort ankommen. Nur wenn offline -> Cache als Fallback.
  // cache: 'no-store' erzwingt einen ECHTEN Netzwerk-Request - ohne das
  // respektiert fetch() selbst wieder den normalen HTTP-Cache-Control-Header
  // von GitHub Pages, und "zuerst Netzwerk" bekommt dann doch nur eine alte
  // gecachte Antwort statt der neuesten Version.
  if (req.mode === 'navigate' ||
      (req.headers.get('accept') || '').includes('text/html')) {
    e.respondWith(
      fetch(req, { cache: 'no-store' })
        .then(res => {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(req, copy));
          return res;
        })
        .catch(() => caches.match(req).then(r => r || caches.match('./index.html')))
    );
    return;
  }

  // Alles andere: Cache zuerst (schnell), aber im Hintergrund frisch nachladen.
  e.respondWith(
    caches.match(req).then(cached => {
      const network = fetch(req).then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(req, copy));
        return res;
      }).catch(() => cached);
      return cached || network;
    })
  );
});
