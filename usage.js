// Usage counts for the game tracker, sent to the Home Hub (Jonny, 2026-10-17: measure before
// building more, then prune what nobody uses). Counts only: which page was opened and which section
// was tapped. Nothing about who, no ids, no times. Read them at the hub's /usage page.
// The hub's /usage/beacon is public (GitHub Pages can't send the hub cookie), so it only accepts
// the names in SECTIONS; its twin is USAGE_TRACKER in home-hub's status_server.py, so a new section
// needs adding in both. Only the live site counts: local runs and the CI browser test never send.
// The first block is DOM-free and unit-tested in Node (scripts/usage.test.mjs).
var TrackerUsage = (function () {
  var SECTIONS = {
    index: ['stats', 'tonight-sec', 'gotm-sec', 'now', 'play-check', 'ongoing', 'queue', 'so-toggle', 'ar-toggle', 'yl-toggle'],
    owl: ['opts', 'choices', 'struck', 'yt'],
    wrapped: ['years', 'poster-sec'],
    add: ['form-area', 'ro-sec']
  };
  var LIVE_HOST = 'conflagarationman.github.io';
  var BEACON = 'https://familyholocron.duckdns.org/usage/beacon?e=';
  function pageOf(pathname) {
    var p = String(pathname || '').split('/').pop().replace(/\.html$/, '');
    return p || 'index';
  }
  // The section a tap landed in: the nearest ancestor id (innermost first) that this page counts.
  function sectionOf(page, ids) {
    var list = SECTIONS[page] || [];
    for (var i = 0; i < ids.length; i++) if (list.indexOf(ids[i]) >= 0) return ids[i];
    return null;
  }
  return { SECTIONS: SECTIONS, LIVE_HOST: LIVE_HOST, BEACON: BEACON, pageOf: pageOf, sectionOf: sectionOf };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = TrackerUsage;

(function () {
  if (typeof document === 'undefined' || typeof navigator === 'undefined' || !navigator.sendBeacon) return;
  if (location.hostname !== TrackerUsage.LIVE_HOST) return;
  var page = TrackerUsage.pageOf(location.pathname);
  if (!TrackerUsage.SECTIONS[page]) return;
  function send(ev) { try { navigator.sendBeacon(TrackerUsage.BEACON + encodeURIComponent(ev)); } catch (e) {} }
  send('tracker:page:' + page);
  document.addEventListener('click', function (e) {
    var ids = [];
    for (var el = e.target; el && el !== document; el = el.parentNode) if (el.id) ids.push(el.id);
    var s = TrackerUsage.sectionOf(page, ids);
    if (s) send('tracker:' + page + ':' + s);
  }, true);
})();
