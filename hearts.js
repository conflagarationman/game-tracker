// Heart Containers: every finished game (s:"done") is one Heart Piece, four make a container.
// Pure and DOM-free so it runs in Node too (scripts/hearts.test.mjs); index.html loads it as a
// plain script and reads globalThis.GTHearts. Only "done" counts -- ongoing and dropped never do.
// index.html draws the pixel hearts under the title and plays a "Heart Piece!" moment when the
// finished count rises past what this browser last saw (localStorage `gt_hearts_seen`); a first
// visit seeds that silently, so nobody gets a celebration for a backlog they already had.
(function (root) {
  const PER = 4;
  const SEEN_KEY = 'gt_hearts_seen';

  function countDone(games) {
    return (Array.isArray(games) ? games : []).filter(g => g && g.s === 'done').length;
  }

  // 59 done -> { containers: 14, pieces: 3, total: 59, toNext: 1, label: "14 Heart Containers · 3/4 to the next" }
  function heartMath(done) {
    const n = Math.max(0, Math.floor(Number(done)) || 0);
    const containers = Math.floor(n / PER), pieces = n % PER;
    const word = containers === 1 ? 'Heart Container' : 'Heart Containers';
    const label = pieces
      ? `${containers} ${word} · ${pieces}/${PER} to the next`
      : `${containers} ${word}`;
    return { containers, pieces, total: n, toNext: PER - pieces, label };
  }

  // What to do when the page now sees `count` finished games and this browser last saw `seen`
  // (null/garbage = never visited). A first visit is seeded silently, and a lower count (a game
  // reopened, a failed write rolled back) just lowers the stored number so the next real finish
  // still counts. Returns { next, kind }: kind is 'none', 'piece' or 'container'.
  function celebration(seen, count) {
    const n = Math.max(0, Math.floor(Number(count)) || 0);
    const s = Number(seen);
    if (seen === null || seen === undefined || seen === '' || !Number.isFinite(s) || s < 0) return { next: n, kind: 'none' };
    if (n <= s) return { next: n, kind: 'none' };
    const kind = Math.floor(n / PER) > Math.floor(s / PER) ? 'container' : 'piece';
    return { next: n, kind, gained: n - Math.floor(s) };
  }

  // localStorage can be missing, full or blocked; every caller must work without it.
  function readSeen(storage) {
    try { const v = storage.getItem(SEEN_KEY); return v === null ? null : v; } catch (e) { return null; }
  }
  function writeSeen(storage, n) {
    try { storage.setItem(SEEN_KEY, String(n)); } catch (e) {}
  }

  // One call for the page: compares, stores the new count, returns the celebration kind.
  function check(storage, games) {
    const c = celebration(readSeen(storage), countDone(games));
    writeSeen(storage, c.next);
    return c.kind;
  }

  // How the meter is drawn. At most MAX_ROW hearts in a single row that never wraps; if that many
  // wouldn't fit in `availablePx` (a phone), or there are more than MAX_ROW, switch to the compact
  // form: one heart plus a count ("x14 +3/4"), with the full row shown on tap. A heart is `size`
  // px wide with `gap` px between. An unusable width (NaN, 0, negative) means "can't tell", which
  // is treated as no room, so the page errs toward the compact form rather than wrapping.
  const MAX_ROW = 20;
  function heartLayout(done, availablePx, opts) {
    const size = (opts && opts.size) || 16, gap = opts && opts.gap != null ? opts.gap : 2;
    const m = heartMath(done);
    const total = m.containers + (m.pieces ? 1 : 0);
    const w = Number(availablePx);
    const fits = Number.isFinite(w) && w > 0 ? Math.floor((w + gap) / (size + gap)) : 0;
    const cap = Math.min(MAX_ROW, fits);
    const compact = total > cap;
    const text = m.pieces ? `\u00d7${m.containers} +${m.pieces}/${PER}` : `\u00d7${m.containers}`;
    return { mode: compact ? 'compact' : 'row', total, cap, containers: m.containers, pieces: m.pieces, text, label: m.label };
  }

  const api = { PER, MAX_ROW, SEEN_KEY, countDone, heartMath, heartLayout, celebration, readSeen, writeSeen, check };
  root.GTHearts = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
