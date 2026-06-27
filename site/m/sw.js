/* UPS Mobile — service worker.
 *
 * Why this exists: GitHub Pages serves every asset with `Cache-Control: max-age=600`
 * (a 10-minute cache). So opening the app after ~10 min idle makes the browser
 * re-validate ALL ~27 script/CSS requests over mobile latency — that's the "slow to
 * load." This SW serves the app SHELL from a local cache (no network round-trips),
 * so opens are near-instant and the app works offline.
 *
 * Strategy (conservative, correctness-first):
 *   • index.html / navigations → NETWORK-FIRST (always the current `?v=BUILD` script
 *     refs when online; falls back to cache offline). It's tiny (~6KB), so the cost is
 *     one small round-trip, while the heavy scripts come from cache.
 *   • same-origin .js/.css/icons/manifest → CACHE-FIRST + background revalidate. They're
 *     versioned by `?v=BUILD` in the URL, so a deploy's new URLs are fetched fresh once
 *     and then cached. Instant on every subsequent open.
 *   • version.json → NOT intercepted (the in-app update check must hit network, no-store).
 *   • cross-origin (the Cloudflare worker API, MFL) → straight to network, never cached.
 *
 * Updates: app.js still polls version.json and shows the reload banner on a new BUILD;
 * because index.html is network-first, the reload pulls the new script refs and the SW
 * caches the new versioned files. No manual cache bump needed.
 */
const CACHE = "ups-m-shell-v1";
const ASSET_RE = /\.(?:js|css|png|svg|webp|webmanifest|woff2?|ico)$/i;

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.map((k) => (k === CACHE ? null : caches.delete(k)))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;                       // never cache writes
  let url;
  try { url = new URL(req.url); } catch (_) { return; }
  if (url.origin !== self.location.origin) return;        // worker / MFL API → network, untouched

  const isDoc = req.mode === "navigate" || /\/m\/(index\.html)?$/.test(url.pathname);
  if (isDoc) {
    // network-first so the shell's ?v=BUILD references are always current; cache fallback offline
    e.respondWith(
      fetch(req)
        .then((resp) => {
          if (resp && resp.status === 200) {
            const copy = resp.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return resp;
        })
        .catch(() => caches.match(req).then((c) => c || caches.match("./index.html")))
    );
    return;
  }

  if (url.pathname.endsWith("version.json")) return;      // update-check must reach the network (no-store)

  if (ASSET_RE.test(url.pathname)) {
    // cache-first (the asset is versioned by ?v=BUILD), revalidate in the background
    e.respondWith(
      caches.open(CACHE).then((cache) =>
        cache.match(req).then((cached) => {
          const net = fetch(req)
            .then((resp) => { if (resp && resp.status === 200) cache.put(req, resp.clone()); return resp; })
            .catch(() => cached);
          return cached || net;
        })
      )
    );
  }
});
