/* PaperFate service worker — minimal cache-shell */
const CACHE_NAME = 'paperfate-shell-v1';
const SHELL_ASSETS = [
  '/',
  '/index.html',
  '/offline.html',
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
            const offline = await caches.match('/offline.html');
            if (offline) return offline;
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

// Allow the page to tell the waiting worker to take over immediately.
self.addEventListener('message', (event) => {
  if (event && event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

// Web Push receive side. Server-side delivery (web-push lib, VAPID
// signing) is not yet wired — this handler exists so that once the
// delivery sprint lands, push payloads already render correctly.
//
// Payload contract (best-effort): JSON { title, body, url, tag, icon }.
// Any field can be missing; we degrade to sensible defaults rather than
// dropping the notification, because Chrome/Firefox both penalise SWs
// that receive a push and then show nothing (userVisibleOnly:true).
function parsePushData(data) {
  if (!data) return {};
  try {
    return data.json() || {};
  } catch (_) {
    try {
      const text = data.text();
      if (!text) return {};
      try { return JSON.parse(text); } catch (_) { return { body: text }; }
    } catch (_) {
      return {};
    }
  }
}

self.addEventListener('push', (event) => {
  const payload = parsePushData(event && event.data);
  const title = (payload && typeof payload.title === 'string' && payload.title) || 'PaperFate';
  const options = {
    body: (payload && typeof payload.body === 'string' && payload.body) || '',
    icon: (payload && typeof payload.icon === 'string' && payload.icon) || '/favicon.svg',
    badge: '/favicon.svg',
    tag: (payload && typeof payload.tag === 'string' && payload.tag) || 'paperfate',
    data: {
      url: (payload && typeof payload.url === 'string' && payload.url) || '/',
    },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  if (event && event.notification && typeof event.notification.close === 'function') {
    try { event.notification.close(); } catch (_) { /* ignore */ }
  }
  const target = (event && event.notification && event.notification.data && event.notification.data.url) || '/';
  event.waitUntil((async () => {
    try {
      const allClients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      // Prefer focusing an existing same-origin window if there is one.
      for (const client of allClients) {
        try {
          const url = new URL(client.url);
          if (url.origin === self.location.origin) {
            if (typeof client.focus === 'function') {
              try {
                if (typeof client.navigate === 'function' && target && target !== '/' && url.pathname !== target) {
                  try { await client.navigate(target); } catch (_) { /* ignore */ }
                }
              } catch (_) { /* ignore */ }
              return client.focus();
            }
          }
        } catch (_) { /* ignore individual client */ }
      }
      if (self.clients && typeof self.clients.openWindow === 'function') {
        return self.clients.openWindow(target || '/');
      }
    } catch (_) {
      /* swallow — nothing actionable from a SW context */
    }
    return undefined;
  })());
});
