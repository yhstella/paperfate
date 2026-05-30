/* PaperFate service worker — minimal cache-shell */
const CACHE_NAME = 'paperfate-shell-v1';
const SHELL_ASSETS = [
  '/',
  '/index.html',
  '/og-default.svg',
  '/manifest.webmanifest'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      // Best-effort: don't fail install if any asset 404s.
      await Promise.all(
        SHELL_ASSETS.map(async (url) => {
          try {
            const res = await fetch(url, { cache: 'no-store' });
            if (res && res.ok) {
              await cache.put(url, res.clone());
            }
          } catch (_) {
            /* ignore individual failures */
          }
        })
      );
      self.skipWaiting();
    })()
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((k) => k.startsWith('paperfate-shell-') && k !== CACHE_NAME)
          .map((k) => caches.delete(k))
      );
      await self.clients.claim();
    })()
  );
});

function isHtmlRequest(request) {
  if (request.mode === 'navigate') return true;
  const accept = request.headers.get('accept') || '';
  return accept.includes('text/html');
}

self.addEventListener('fetch', (event) => {
  const request = event.request;

  // Never cache non-GET (POST, PUT, etc.)
  if (request.method !== 'GET') return;

  let url;
  try {
    url = new URL(request.url);
  } catch (_) {
    return;
  }

  // Only handle same-origin requests
  if (url.origin !== self.location.origin) return;

  const isApi = url.pathname.startsWith('/api/');
  const isHtml = isHtmlRequest(request);

  if (isApi || isHtml) {
    // Network-first for HTML and /api/*
    event.respondWith(
      (async () => {
        try {
          const networkRes = await fetch(request);
          // Only cache HTML shell responses (not API responses) on success
          if (isHtml && networkRes && networkRes.ok) {
            try {
              const cache = await caches.open(CACHE_NAME);
              cache.put(request, networkRes.clone());
            } catch (_) { /* ignore */ }
          }
          return networkRes;
        } catch (err) {
          const cached = await caches.match(request);
          if (cached) return cached;
          if (isHtml) {
            const fallback = await caches.match('/index.html');
            if (fallback) return fallback;
          }
          throw err;
        }
      })()
    );
    return;
  }

  // Cache-first for other static assets
  event.respondWith(
    (async () => {
      const cached = await caches.match(request);
      if (cached) return cached;
      try {
        const networkRes = await fetch(request);
        if (networkRes && networkRes.ok && networkRes.type === 'basic') {
          try {
            const cache = await caches.open(CACHE_NAME);
            cache.put(request, networkRes.clone());
          } catch (_) { /* ignore */ }
        }
        return networkRes;
      } catch (err) {
        throw err;
      }
    })()
  );
});
