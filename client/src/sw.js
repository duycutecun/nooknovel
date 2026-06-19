const CACHE_NAME = 'pwa-novel-v1';
const ASSETS = ['/', '/index.html', '/manifest.json', '/assets/apple-splash-B_SY1GJM.png', '/assets/manifest-BeX8ap84.json'];

self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS).catch(()=>{}))
  );
});

self.addEventListener('activate', (e) => {
  clients.claim();
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.map(k => { if (k !== CACHE_NAME) return caches.delete(k); })))
  );
});

self.addEventListener('fetch', (e) => {
  // network-first for API requests, cache-first for navigation/assets
  const url = new URL(e.request.url);
  if (url.origin === location.origin && (e.request.mode === 'navigate' || e.request.destination === 'document')) {
    e.respondWith(caches.match('/index.html').then(r => r || fetch(e.request)));
    return;
  }

  if (e.request.method !== 'GET') return;

  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request).then(res => {
      // cache fetched assets
      if (e.request.url.startsWith(location.origin)) {
        const copy = res.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(e.request, copy));
      }
      return res;
    }).catch(()=> cached || new Response('', { status: 504 })) )
  );
});

// Background sync stub (best-effort); Firestore SDK handles offline writes which sync automatically.
self.addEventListener('sync', (event) => {
  if (event.tag === 'sync-novels') {
    event.waitUntil(fetch('/health').catch(()=>{}));
  }
});