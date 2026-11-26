const cache = 'ideamemo-5';
const files = ['./', 'index.html', 'style.css', 'app.js', 'icon-192.png', 'icon-512.png', 'manifest.webmanifest'];
self.addEventListener('install', event => event.waitUntil(caches.open(cache).then(store => store.addAll(files))));
self.addEventListener('activate', event => event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('ideamemo-') && key !== cache).map(key => caches.delete(key))))));
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET' || new URL(event.request.url).origin !== location.origin) return;
  event.respondWith(fetch(event.request).catch(() => caches.match(event.request).then(saved => saved || (event.request.mode === 'navigate' ? caches.match('./') : Response.error()))));
});
