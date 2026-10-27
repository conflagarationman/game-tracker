// Dampé's graveyard: the dropped games, each with a headstone, an epitaph generated from its
// record, and a way to dig it back up. Pure and DOM-free (scripts/graveyard.test.mjs);
// index.html loads it as a plain script and reads globalThis.GTGraveyard. All lines are original.
(function (root) {
  const pad = n => String(n).padStart(2, '0');
  const monthEnd = (y, m) => `${y}-${pad(m + 1)}-${pad(new Date(Date.UTC(y, m + 1, 0)).getUTCDate())}`;

  function dropped(games) {
    // Latest drop first, so the newest headstone is the one nearest the gate.
    return (games || []).filter(g => g && g.s === 'dropped')
      .sort((a, b) => (dropDate(b) || '').localeCompare(dropDate(a) || '') || b.id - a.id);
  }

  // When the game was laid to rest, as YYYY-MM-DD (or null): last play, else the completion
  // month the Fill-in sheet records for drops, else when it was started or queued.
  function dropDate(g) {
    if (g.lastPlayed) return g.lastPlayed;
    if (g.cy != null && g.cm != null) return monthEnd(g.cy, g.cm);
    return g.start || g.queued || null;
  }

  // Hours played: the sync's real number when there is one, else the HLTB estimate (flagged).
  function hoursPlayed(g) {
    if (g.actualHours > 0) return { text: `${Math.round(g.actualHours * 10) / 10}h`, est: false, n: g.actualHours };
    if (g.h) return { text: String(g.h), est: true, n: null };
    return null;
  }

  // The game that took its place: the playing or done game dated closest after the drop.
  // Playing games are dated by `start`; done ones by `start` if set, else the end of their
  // completion month. Ties go to the lower id so the answer never wobbles.
  function successor(g, games) {
    const ref = dropDate(g);
    if (!ref) return null;
    let best = null, bestWhen = null;
    for (const o of games || []) {
      if (!o || o.id === g.id) continue;
      let when = null;
      if (o.s === 'playing') when = o.start;
      else if (o.s === 'done') when = o.start || (o.cy != null && o.cm != null ? monthEnd(o.cy, o.cm) : null);
      if (!when || when <= ref) continue;
      if (!best || when < bestWhen || (when === bestWhen && o.id < best.id)) { best = o; bestWhen = when; }
    }
    return best;
  }

  // A few gentle lines, picked by id so a headstone always says the same thing. Lines that need
  // data the record lacks are skipped, so every game gets an epitaph.
  function epitaph(g, games) {
    const hrs = hoursPlayed(g);
    const next = successor(g, games);
    const pool = [];
    if (hrs && !hrs.est) pool.push(`Hours played: ${hrs.text.replace(/h$/, '')}.`);
    if (hrs && hrs.est) pool.push(`Never saw the end of its ${hrs.text}.`);
    if (next) pool.push(`Fell to ${next.t}.`);
    pool.push('Gone, but not forgotten. Mostly gone.');
    pool.push('It said it would be back by Friday.');
    pool.push('Here lies a good idea at the wrong time.');
    pool.push('Rest easy. The backlog carries on.');
    return pool[Math.abs(Number(g.id) || 0) % pool.length];
  }

  const QUIET = [
    'Heh. Quiet tonight. Nobody has been laid to rest.',
    'Nothing buried here. Dampé is leaning on his shovel.',
  ];
  function emptyLine(seed) { return QUIET[Math.abs(Number(seed) || 0) % QUIET.length]; }

  // Digging up goes back to Someday, the same patch a drag into that section sends
  // (sectionPatch in index.html), through the same /games/edit write. Nothing else changes,
  // so the old completion date, rating and notes ride along in case it comes back to life.
  function digUpPatch(g, today) { return { s: 'soon', queued: g.queued || today }; }
  // The exact body saveEdit posts to the Worker's /games/edit.
  function digUpBody(g, today) { return { id: g.id, ...digUpPatch(g, today) }; }
  function digUpConfirm(g) { return `Dig up ${g.t}? It goes back to Someday.`; }

  const api = { dropped, dropDate, hoursPlayed, successor, epitaph, emptyLine, digUpPatch, digUpBody, digUpConfirm };
  root.GTGraveyard = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
