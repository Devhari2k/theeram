// Bumping this is what repairs an already-installed device: changing the bytes
// of this file is the ONLY thing that makes the browser re-run install, and
// activate then deletes every cache whose name no longer matches — including
// the stale index.html that theeram-v2 was holding.
const CACHE_NAME = 'theeram-v3';

// index.html is deliberately NOT here.
//
// It was, and it was served cache-first, which meant an install that updated
// its APK kept rendering the index.html it had cached the first time. The app
// shell only re-cached when the bytes of THIS file changed, and they had not
// changed since the source was restored — so fixes that live in index.html
// (the stored-XSS escaping in cardTemplate, the rainfall timezone anchoring in
// fetchRainfall) could never reach a device that upgraded in place.
//
// Caching it bought nothing anyway: inside the packaged Capacitor app every
// shell file is already on local storage, so "the network" is a local read.
// Leave index.html out, and an upgraded APK always runs the code it shipped.
const SHELL_FILES = ['./manifest.json', './icon.svg'];

// The external CDN scripts (Leaflet, QRCode, Firebase SDK modules) were not
// cached at all before — every single app launch re-fetched all of them
// over the network from scratch, which is the real cause of "slow and
// laggy every time I open the app" on a mobile connection. These origins
// are cached stale-while-revalidate: serve instantly from cache once
// available, and refresh the cache in the background for next time.
const CDN_ORIGINS = ['unpkg.com', 'cdn.jsdelivr.net', 'www.gstatic.com'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  const isShell = SHELL_FILES.some((f) => url.pathname.endsWith(f.replace('./', '')));
  if (isShell) {
    event.respondWith(
      caches.match(event.request).then((cached) => cached || fetch(event.request))
    );
    return;
  }

  if (CDN_ORIGINS.includes(url.hostname)) {
    event.respondWith(
      caches.open(CACHE_NAME).then(async (cache) => {
        const cached = await cache.match(event.request);
        const networkFetch = fetch(event.request)
          .then((response) => { cache.put(event.request, response.clone()); return response; })
          .catch(() => cached);
        return cached || networkFetch;
      })
    );
  }
  // Everything else (Open-Meteo, Nominatim, Firestore, map tiles) always
  // goes straight to the network — this is live data that must stay fresh.
});
