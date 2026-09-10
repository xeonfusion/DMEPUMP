/* DMEPUMP TCI - service worker: enables offline / installable PWA behavior.
 * Precaches the local app shell + engine wheel, and opportunistically
 * caches the (cross-origin) Pyodide/numpy/scipy/Chart.js CDN assets so the
 * app keeps working offline after the first successful load.
 */

const CACHE_VERSION = "dmepump-tci-v2";
const APP_SHELL = [
  "./",
  "index.html",
  "style.css",
  "app.js",
  "manifest.json",
  "favicon.ico",
  "python/dist/dmepump_tci_core-1.0.0-py3-none-any.whl",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "icons/icon-512-maskable.png",
  "icons/apple-touch-icon.png",
  "icons/favicon-32.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Cache-first for same-origin app files; stale-while-revalidate for
// cross-origin CDN packages (Pyodide/numpy/scipy/Chart.js) so repeat visits
// work offline while still picking up updates in the background.
self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request)
        .then((response) => {
          if (response && response.ok) {
            const copy = response.clone();
            caches.open(CACHE_VERSION).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});
