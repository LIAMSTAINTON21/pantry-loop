// Keep every offline dependency in this release cache. Bump the version when
// the asset set changes so activation removes stale application bundles.
const CACHE = "pantry-loop-v1.6.0-auth-2";
const ASSETS = [
  "./src/bootstrap.js?release=auth-2",
  "./src/nutrition.js", "./src/views/food.js",
  "./", "./index.html", "./app.css", "./manifest.webmanifest",
  "./src/main.js", "./src/ui.js", "./src/icons.js", "./src/sheet.js", "./src/auth.js", "./src/supabase-config.js", "./src/sync.js", "./src/tesco.js", "./src/confirmation.js", "./src/identification.js", "./src/db.js", "./src/barcode.js", "./src/inventory.js", "./src/scanner.js", "./src/lookup.js", "./src/list.js", "./src/export.js",
  "./src/views/scan.js", "./src/views/stock.js", "./src/views/list.js", "./src/views/catalogue.js", "./src/views/settings.js",
  "./vendor/idb-8.0.3.umd.js", "./vendor/zxing-wasm-reader-3.1.4.js", "./vendor/zxing_reader-3.1.4.wasm", "./vendor/xlsx-0.20.3.full.min.js", "./vendor/supabase-2.117.2.js",
  "./icons/icon-192.png", "./icons/icon-512.png", "./icons/icon-maskable-512.png"
];

self.addEventListener("install", event => {
  // Bypass the HTTP cache so a new release never installs stale copies of its own files.
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(ASSETS.map(asset => new Request(asset, { cache: "reload" })))));
});

self.addEventListener("activate", event => {
  event.waitUntil(Promise.all([
    caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith("pantry-loop-") && key !== CACHE).map(key => caches.delete(key)))),
    self.clients.claim()
  ]));
});

self.addEventListener("fetch", event => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  // API responses may contain account data, so they must not enter the public
  // offline cache alongside the static application assets.
  if (url.pathname.includes("/api/")) return;
  event.respondWith(caches.match(event.request).then(cached => cached || fetch(event.request).then(response => {
    if (response.ok) caches.open(CACHE).then(cache => cache.put(event.request, response.clone()));
    return response;
  })));
});

self.addEventListener("message", event => { if (event.data?.type === "SKIP_WAITING") self.skipWaiting(); });
