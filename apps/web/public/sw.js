/**
 * Prahari service worker. Network-first for pages and assets with a cache
 * fallback, so a traveller dashboard opened once still opens offline. Signed-in
 * pages are cached when visited, never precached, so a login redirect is not
 * stored in their place.
 */

const CACHE_NAME = 'prahari-pwa-v4';
const OFFLINE_MAP_CACHE_NAME = 'prahari-offline-map-v1';

const STATIC_ASSETS = ['/', '/login', '/manifest.json', '/icon-192.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(STATIC_ASSETS).catch(() => undefined))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames
          .filter((name) => name !== CACHE_NAME && name !== OFFLINE_MAP_CACHE_NAME)
          .map((name) => caches.delete(name))
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);

  // API calls go straight to the network; the SOS queue handles failures.
  if (request.method !== 'GET' || !url.protocol.startsWith('http') || url.pathname.startsWith('/api/')) {
    return;
  }

  event.respondWith(
    caches.open(CACHE_NAME).then(async (cache) => {
      try {
        const networkResponse = await fetch(request);
        if (networkResponse.status === 200 && !networkResponse.redirected) {
          cache.put(request, networkResponse.clone());
        }
        return networkResponse;
      } catch (err) {
        const offlineMapCache = await caches.open(OFFLINE_MAP_CACHE_NAME);
        const cachedResponse = await cache.match(request) || await offlineMapCache.match(request);
        if (cachedResponse) {
          return cachedResponse;
        }

        if (request.mode === 'navigate') {
          const fallbackPage = await cache.match('/citizen') || await cache.match('/');
          if (fallbackPage) return fallbackPage;
        }

        throw err;
      }
    })
  );
});

// The onboarding flow may request an explicit offline area download. We only
// receive URLs from a configured self-hosted/licensed provider; the app never
// prefetches public OpenStreetMap raster tiles because that is prohibited by
// OSM's tile policy. The cache is separate from the app shell so an upgrade
// never discards a traveller's selected regional map.
self.addEventListener('message', (event) => {
  if (event.data?.type !== 'PRAHARI_CACHE_OFFLINE_TILES') return;
  const urls = Array.isArray(event.data.urls)
    ? event.data.urls.filter((url) => typeof url === 'string' && url.startsWith('https://')).slice(0, 180)
    : [];
  const port = event.ports?.[0];

  event.waitUntil((async () => {
    if (!urls.length) {
      port?.postMessage({ cached: 0, error: 'No approved base-map tiles were supplied.' });
      return;
    }
    try {
      const cache = await caches.open(OFFLINE_MAP_CACHE_NAME);
      let cached = 0;
      let index = 0;
      const worker = async () => {
        while (index < urls.length) {
          const url = urls[index++];
          try {
            const request = new Request(url, { mode: 'no-cors' });
            const response = await fetch(request);
            if (response && (response.ok || response.type === 'opaque')) {
              await cache.put(request, response);
              cached += 1;
            }
          } catch {
            // A partial regional map remains useful; the caller receives the
            // successful count rather than failing the whole safety pack.
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(4, urls.length) }, worker));
      port?.postMessage({ cached });
    } catch {
      port?.postMessage({ cached: 0, error: 'Base-map cache could not be opened.' });
    }
  })());
});
