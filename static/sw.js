// GaLib service worker — app-shell caching for installable PWA + offline shell.
// Network-first for the shell (so rebuilds are picked up), cache fallback when offline.
// Cover art is cached separately so it's available offline.

const CACHE = "manga-dl-v4";
const COVER_CACHE = "manga-dl-covers-v1";
const SHELL = [
  "/",
  "/index.html",
  "/app.js",
  "/chapter-picker.js",
  "/style.css",
  "/manifest.webmanifest",
  "/img/logo.png",
  "/img/icon-192.png",
  "/img/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== CACHE && k !== COVER_CACHE).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);

  // Cover art: network-first, cache for offline fallback.
  if (url.pathname.match(/^\/api\/series\/[^/]+\/cover$/)) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res && res.ok) {
            caches.open(COVER_CACHE).then((c) => c.put(req, res.clone())).catch(() => {});
          }
          return res;
        })
        .catch(() => caches.open(COVER_CACHE).then((c) => c.match(req)))
    );
    return;
  }

  // All other API calls and page images go to the network only.
  if (url.pathname.startsWith("/api/")) return;

  // Network-first for everything else, falling back to cache when offline.
  event.respondWith(
    fetch(req)
      .then((res) => {
        // Don't cache auth redirects (e.g. the login page served for "/").
        if (res && res.ok && !res.redirected && url.origin === self.location.origin) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() =>
        caches.match(req).then((hit) => hit || caches.match("/index.html"))
      )
  );
});
