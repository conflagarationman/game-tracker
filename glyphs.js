// Platform glyphs: small original pixel-art SVGs that stand in for cover art, one per platform
// family, drawn as rects in the same style as the hearts and rupees. They replace the emoji
// fallbacks (a monitor/gamepad/phone emoji looks different on every OS). Each uses
// fill="currentColor", so the caller colours it with the existing platform colour (PC in
// index.html), and the "screen" or "detail" pixels are the same colour at lower opacity.
// DOM-free: loaded as a plain script by index.html, owl.html and wrapped.html (globalThis.GTGlyph)
// and unit-tested in Node (scripts/glyphs.test.mjs, which smoke.browser.mjs also runs).
(function (root) {
  // 12 x 10 grid. X = solid, o = detail (drawn at lower opacity), . = empty.
  const ART = {
    monitor: ['XXXXXXXXXXXX', 'XooooooooooX', 'XooooooooooX', 'XooooooooooX', 'XooooooooooX', 'XXXXXXXXXXXX', '....XXXX....', '....XXXX....', '..XXXXXXXX..', '............'],
    laptop: ['............', '..XXXXXXXX..', '..XooooooX..', '..XooooooX..', '..XooooooX..', '..XXXXXXXX..', 'XXXXXXXXXXXX', 'XXXXXXXXXXXX', '.XXXXXXXXXX.', '............'],
    handheld: ['............', '..XXXXXXXX..', 'XXXooooooXXX', 'XoXooooooXoX', 'XXXooooooXXX', 'XXXXXXXXXXXX', 'XXXXXXXXXXXX', '.XXX....XXX.', '............', '............'],
    pad: ['...XX..XX...', '.XXXXXXXXXX.', 'XXXXXXXXXXXX', 'XXoXXXXXXoXX', 'XoooXXXXoooX', 'XXoXXXXXXoXX', 'XXXXXXXXXXXX', 'XXXX....XXXX', '.XX......XX.', '............'],
    joycons: ['............', 'XXXXXXXXXXXX', 'XoXooooooXXX', 'XXXooooooXoX', 'XXXooooooXXX', 'XXXooooooXXX', 'XXXXXXXXXXXX', '............', '............', '............'],
    tablet: ['............', 'XXXXXXXXXXXX', 'XXooooooooXX', 'XXooooooooXX', 'XXooooooooXX', 'XXooooooooXX', 'XXXXXXXXXXXX', '.XXXXXXXXXX.', '............', '............'],
    cart: ['.XXXXXXXXXX.', '.XXXXXXXXXX.', '.XooooooooX.', '.XooooooooX.', '.XXXXXXXXXX.', '.XXXXXXXXXX.', '.XXXXXXXXXX.', '..X.X.X.X.X.', '............', '............']
  };
  // Platform key (games.json "p") -> glyph. Unknown platforms get the gamepad.
  const FAMILY = { steam: 'monitor', pc: 'laptop', steamdeck: 'handheld', ayn: 'handheld', ps5: 'pad', switch: 'joycons', switch2: 'joycons', wiiu: 'tablet', retro: 'cart' };

  function familyOf(p) { return Object.prototype.hasOwnProperty.call(FAMILY, p) ? FAMILY[p] : 'pad'; }

  // Rows -> merged horizontal runs: [{x, y, w, detail}]
  function runs(rows) {
    const out = [];
    rows.forEach((row, y) => {
      let x = 0;
      while (x < row.length) {
        const c = row[x];
        if (c !== 'X' && c !== 'o') { x++; continue; }
        let e = x; while (e < row.length && row[e] === c) e++;
        out.push({ x, y, w: e - x, detail: c === 'o' });
        x = e;
      }
    });
    return out;
  }

  function svg(p) {
    const fam = familyOf(p);
    const rects = runs(ART[fam]).map(r => `<rect x="${r.x}" y="${r.y}" width="${r.w}" height="1"${r.detail ? ' opacity=".45"' : ''}/>`).join('');
    return `<svg class="pglyph" viewBox="0 0 12 10" fill="currentColor" shape-rendering="crispEdges" aria-hidden="true" focusable="false">${rects}</svg>`;
  }

  const api = { ART, FAMILY, familyOf, runs, svg };
  root.GTGlyph = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
