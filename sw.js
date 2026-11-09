// Service worker for the installed tracker. Its only job is an offline fallback.
//
// NETWORK-FIRST FOR EVERYTHING. Every same-origin GET goes to the network, and only a failed
// network (offline, or the server unreachable) falls back to the last copy this worker saw. It
// never answers from the cache while the network works. That matters because the pages
// cache-bust their JSON with ?_=<timestamp> on purpose: stale data once looked like a failed save
// (see the comment above fresh() in index.html).
//
// Because the cache is only ever a fallback and is refreshed on every successful fetch, there is
// no cache version to bump and nothing anyone has to remember when a file changes. Don't add one.
//
// Cache entries are keyed by the URL WITHOUT its query or hash, so the timestamped JSON requests
// share one entry per file instead of piling up one per timestamp, and an offline lookup finds
// `games.json` whatever `_` it was asked with. (owl.html?pick=… and index.html?x share their page's
// entry for the same reason.)
//
// It never touches other origins (the Cloudflare Worker, the hub beacon, fonts, cover art,
// YouTube), and its scope is this site's folder only. Steph's TV log loads korok.js from here as
// a plain cross-site <script>; that request comes from her page, which this worker doesn't control.
var CACHE = 'gt-offline';

// DOM-free helpers, unit-tested in Node (scripts/sw.test.mjs).
function cacheKey(url) {
  var u = new URL(url);
  u.search = '';
  u.hash = '';
  return u.toString();
}
// Should this request be handled at all? Same origin, GET only.
function handles(method, url, origin) {
  if (method !== 'GET') return false;
  try { return new URL(url).origin === origin; } catch (e) { return false; }
}
// Only a good, same-origin answer is worth keeping as the fallback.
function cacheable(res) {
  return !!res && res.ok && res.type === 'basic';
}

if (typeof self !== 'undefined' && self.addEventListener && typeof caches !== 'undefined') {
  self.addEventListener('install', function () { self.skipWaiting(); });
  self.addEventListener('activate', function (e) { e.waitUntil(self.clients.claim()); });
  self.addEventListener('fetch', function (e) {
    var req = e.request;
    if (!handles(req.method, req.url, self.location.origin)) return; // not ours: the browser does its normal thing
    e.respondWith(
      fetch(req).then(function (res) {
        if (cacheable(res)) {
          var copy = res.clone();
          e.waitUntil(caches.open(CACHE).then(function (c) { return c.put(cacheKey(req.url), copy); }).catch(function () {}));
        }
        return res;
      }).catch(function () {
        // Network failed. A cached copy beats an error page; with none, the failure stands.
        return caches.match(cacheKey(req.url)).then(function (hit) { return hit || Promise.reject(new TypeError('offline and not cached')); });
      })
    );
  });
}

if (typeof module !== 'undefined' && module.exports) module.exports = { cacheKey: cacheKey, handles: handles, cacheable: cacheable, CACHE: CACHE };
