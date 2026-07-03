// Cache-Version: bei jedem größeren Update hochzählen (v2 -> v3 ...).
// Das erzwingt, dass alte Caches gelöscht werden.
const CACHE = 'slots-v10';
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

  // HTML / Seitenaufrufe: ZUERST Netzwerk, damit Updates (z.B. Multiplayer)
  // sofort ankommen. Nur wenn offline -> Cache als Fallback.
  if (req.mode === 'navigate' ||
      (req.headers.get('accept') || '').includes('text/html')) {
    e.respondWith(
      fetch(req)
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
