// Registers the service worker (sw.js) so the tracker can be installed and opens offline.
// Skipped on localhost and file:// so local runs and the CI browser test never get a worker
// between them and the files; skipped where service workers don't exist. Loaded by all four pages.
(function () {
  if (!('serviceWorker' in navigator)) return;
  var h = location.hostname;
  if (location.protocol !== 'https:' || h === 'localhost' || h === '127.0.0.1' || h === '[::1]') return;
  window.addEventListener('load', function () {
    // Relative to the page, so it registers at this site's folder (scope = where sw.js lives).
    navigator.serviceWorker.register('sw.js').catch(function () {});
  });
})();
