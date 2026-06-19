const CACHE_NAME = 'pwa-novel-v1';
const ASSETS = ['/', '/index.html', '/manifest.json', '/icon-192.png', '/icon-512.png', '/apple-touch-icon.png'];

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
  const url = new URL(e.request.url);
  // navigation -> serve index.html (app shell)
  if (e.request.mode === 'navigate') {
    e.respondWith(caches.match('/index.html').then(r => r || fetch('/index.html')));
    return;
  }

  if (e.request.method !== 'GET') return;

  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request).then(res => {
      try { if (e.request.url.startsWith(self.location.origin)) { const copy = res.clone(); caches.open(CACHE_NAME).then(cache => cache.put(e.request, copy)); } } catch(e){}
      return res;
    }).catch(()=> cached || new Response('', { status: 504 })))
  );
});

self.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting();
});