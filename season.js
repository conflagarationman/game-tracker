// Seasonal looks: the same Thanksgiving and Christmas looks as the Home Hub
// (conflagarationman/home-hub: hub_assets/season.css and _hub_season() in status_server.py).
// Steph's TV log carries its own copy of this file. Keep the dates the same in all three places.
//
// Dates (Jonny, 2026-11-19): Christmas runs November 1 through January 1, except that
// Thanksgiving takes the Thursday a week before US Thanksgiving through Thanksgiving Day.
// ?season=thanksgiving, ?season=christmas or ?season=off previews a look any day of the year.
//
// Decoration only. It sets <html data-season>, adds a soft glow and a few falling leaves or
// snowflakes behind the page (z-index -1, so never over a card), a strip along the top edge
// (z-index 4: under the Korok spots, which are 5, so the Korok hanging from the top dangles in
// front of it). No title emoji here, unlike the hub: the tracker's titles already wear their own
// mark (h1::after). It never uses body::before or ::after, which korok.js's forest skins own.
// Falling things are ::before content, not text, and stand still under prefers-reduced-motion.
// The date logic is DOM-free and tested in scripts/season.test.mjs.
var GTSeason = (function () {
  // US Thanksgiving: the 4th Thursday of November.
  function thanksgivingDay(year) {
    var first = new Date(year, 10, 1).getDay();
    return 1 + (4 - first + 7) % 7 + 21;
  }
  function season(date) {
    var y = date.getFullYear(), m = date.getMonth(), d = date.getDate();
    if (m === 10) {
      var t = thanksgivingDay(y);
      if (d >= t - 7 && d <= t) return 'thanksgiving';
    }
    if (m === 10 || m === 11 || (m === 0 && d === 1)) return 'christmas';
    return '';
  }
  // null when the URL says nothing; '' for ?season=off.
  function fromQuery(search) {
    var m = /[?&]season=(off|thanksgiving|christmas)\b/.exec(search || '');
    return m ? (m[1] === 'off' ? '' : m[1]) : null;
  }

  var CSS = [
    '.season-glow,.season-fx{position:fixed;inset:0;z-index:-1;pointer-events:none}',
    '.season-fx{overflow:hidden}',
    '.season-top{position:absolute;left:0;right:0;top:0;z-index:4;pointer-events:none}',
    '.season-fx i{position:absolute;top:-8vh;display:block;font-style:normal;line-height:1;animation:season-fall linear infinite}',
    '.season-fx i:nth-child(1){left:4%;font-size:22px;animation-duration:19s;animation-delay:-3s}',
    '.season-fx i:nth-child(2){left:15%;font-size:16px;animation-duration:24s;animation-delay:-14s}',
    '.season-fx i:nth-child(3){left:27%;font-size:20px;animation-duration:21s;animation-delay:-8s}',
    '.season-fx i:nth-child(4){left:38%;font-size:14px;animation-duration:27s;animation-delay:-20s}',
    '.season-fx i:nth-child(5){left:50%;font-size:18px;animation-duration:22s;animation-delay:-1s}',
    '.season-fx i:nth-child(6){left:61%;font-size:24px;animation-duration:25s;animation-delay:-11s}',
    '.season-fx i:nth-child(7){left:72%;font-size:15px;animation-duration:20s;animation-delay:-17s}',
    '.season-fx i:nth-child(8){left:83%;font-size:21px;animation-duration:23s;animation-delay:-6s}',
    '.season-fx i:nth-child(9){left:88%;font-size:17px;animation-duration:26s;animation-delay:-23s}',
    '@keyframes season-fall{0%{transform:translate(0,0) rotate(0deg)}50%{transform:translate(28px,58vh) rotate(160deg)}100%{transform:translate(-12px,118vh) rotate(320deg)}}',
    '@keyframes season-twinkle{0%,100%{opacity:1}50%{opacity:.6}}',
    '@media (prefers-reduced-motion:reduce){.season-fx i,.season-top{animation:none!important}',
    '  .season-fx i:nth-child(odd){top:18%}.season-fx i:nth-child(3n){top:52%}.season-fx i:nth-child(4n){top:78%}}',
    // Thanksgiving: warm harvest light, a thin harvest ribbon, a few leaves.
    'html[data-season="thanksgiving"] .season-glow{background:radial-gradient(60% 42% at 12% 0%,rgba(255,140,40,.24),transparent 62%),radial-gradient(52% 38% at 88% 6%,rgba(200,60,50,.18),transparent 60%),radial-gradient(46% 34% at 62% 96%,rgba(230,170,60,.16),transparent 62%)}',
    'html[data-season="thanksgiving"] .season-top{height:6px;background:linear-gradient(90deg,#c8453a,#e8822a,#e9b44c,#8a9a3b,#e8822a,#c8453a)}',
    'html[data-season="thanksgiving"] .season-fx i{opacity:.75}',
    'html[data-season="thanksgiving"] .season-fx i::before{content:"\\1F342"}',
    'html[data-season="thanksgiving"] .season-fx i:nth-child(3n)::before{content:"\\1F341"}',
    // Christmas: a twinkling bulb strand, red and pine light, slow snowflakes.
    'html[data-season="christmas"] .season-glow{background:radial-gradient(60% 42% at 12% 0%,rgba(220,50,60,.20),transparent 62%),radial-gradient(52% 38% at 88% 6%,rgba(40,160,90,.20),transparent 60%),radial-gradient(46% 34% at 62% 96%,rgba(150,200,240,.14),transparent 62%)}',
    'html[data-season="christmas"] .season-top{height:14px;background:radial-gradient(circle at 12px 8px,#ff4d5e 0 4px,transparent 5px) 0 0/96px 14px repeat-x,radial-gradient(circle at 36px 8px,#3fd47e 0 4px,transparent 5px) 0 0/96px 14px repeat-x,radial-gradient(circle at 60px 8px,#ffc94a 0 4px,transparent 5px) 0 0/96px 14px repeat-x,radial-gradient(circle at 84px 8px,#5aa8ff 0 4px,transparent 5px) 0 0/96px 14px repeat-x,linear-gradient(#2c3a2c,#2c3a2c) 0 3px/100% 1px no-repeat;filter:drop-shadow(0 0 4px rgba(255,220,120,.55));animation:season-twinkle 2.4s ease-in-out infinite}',
    'html[data-season="christmas"] .season-fx i{color:#fff;opacity:.8;text-shadow:0 0 6px rgba(160,200,255,.9)}',
    'html[data-season="christmas"] .season-fx i::before{content:"\\2744\\FE0E"}',
    '@media (prefers-color-scheme:light){html[data-season="christmas"] .season-fx i{color:#3f7fc4;opacity:.95;text-shadow:0 0 3px rgba(255,255,255,.95)}}'
  ].join('\n');

  function apply(doc, loc, now) {
    var q = fromQuery(loc.search);
    var s = q !== null ? q : season(now);
    if (!s) return '';
    doc.documentElement.setAttribute('data-season', s);
    var st = doc.createElement('style');
    st.textContent = CSS;
    doc.head.appendChild(st);
    var add = function () {
      var glow = doc.createElement('div'); glow.className = 'season-glow';
      var top = doc.createElement('div'); top.className = 'season-top';
      var fx = doc.createElement('div'); fx.className = 'season-fx';
      fx.innerHTML = new Array(10).join('<i></i>');
      [glow, top, fx].forEach(function (el) { el.setAttribute('aria-hidden', 'true'); doc.body.prepend(el); });
    };
    if (doc.body) add(); else doc.addEventListener('DOMContentLoaded', add);
    return s;
  }

  if (typeof document !== 'undefined' && typeof location !== 'undefined') apply(document, location, new Date());
  return { season: season, fromQuery: fromQuery, thanksgivingDay: thanksgivingDay };
})();
