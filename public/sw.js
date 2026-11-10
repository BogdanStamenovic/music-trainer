// Service worker: app shell + today's lesson data offline.
// - navigations and /_next/static: stale-while-revalidate (pages work offline)
// - GET /api/today, /api/lesson/*: network-first, cached copy when offline
// - POST /api/submit is never cached: the page queues it in IndexedDB instead
const VERSION = "mt-v2";
const SHELL = ["/", "/review", "/test", "/placement", "/progress", "/settings", "/voice", "/manifest.webmanifest", "/icon-192.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL).catch(() => {})).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

async function networkFirst(req, ignoreSearch = false) {
  const c = await caches.open(VERSION);
  try {
    const r = await fetch(req);
    if (r.ok) c.put(req, r.clone());
    return r;
  } catch {
    const hit = await c.match(req, { ignoreSearch });
    if (hit) return hit;
    throw new Error("offline and not cached");
  }
}
async function staleWhileRevalidate(req, fallbackUrl) {
  const c = await caches.open(VERSION);
  const hit = await c.match(req, { ignoreSearch: true });
  const net = fetch(req)
    .then((r) => {
      if (r.ok) c.put(req, r.clone());
      return r;
    })
    .catch(() => null);
  if (hit) return hit;
  const r = await net;
  if (r) return r;
  if (fallbackUrl) {
    const fb = await c.match(fallbackUrl);
    if (fb) return fb;
  }
  return new Response("offline", { status: 503 });
}

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  if (url.pathname.startsWith("/api/today") || url.pathname.startsWith("/api/lesson/") || url.pathname === "/api/settings") {
    e.respondWith(networkFirst(req));
  } else if (url.pathname.startsWith("/api/voice/")) {
    return; // recordings and uploads: always live
  } else if (url.pathname.startsWith("/_next/static/") || url.pathname.startsWith("/icon") || url.pathname.endsWith(".webmanifest") || url.pathname.startsWith("/ort/") || url.pathname.startsWith("/voice-score/")) {
    // /ort and /voice-score: the browser voice fallback (15 MB WASM) is cached after first use so it works offline
    e.respondWith(staleWhileRevalidate(req));
  } else if (req.mode === "navigate" || (url.pathname.startsWith("/lesson/") && !req.headers.get("RSC"))) {
    // pages: fresh when online; offline, the cached copy (query ignored) or the home shell
    e.respondWith(networkFirst(req, true).catch(() => staleWhileRevalidate(req, "/")));
  }
});
