// "What should I play?" — ranks what's worth picking up right now, given how long you've got
// and which device is in your hand. Pure and DOM-free so it runs in Node too
// (scripts/pick.test.mjs); index.html loads it as a plain script and reads globalThis.GTPick.
//
// It only ever suggests from what you've already decided to play (Now Playing, Up Next,
// Ongoing for short sessions) plus Someday games whose club pick is about to expire. It does
// not mine Someday for ideas: that's what Someday triage is for.
(function (root) {
  // Which tracker platforms each device can play. Steam games count as playable on the Deck;
  // "retro" is RetroAchievements emulation, which lives on the Thor.
  const DEVICES = {
    any:    { label: 'Any',      plats: null },
    pc:     { label: 'PC',       plats: ['steam', 'pc'] },
    deck:   { label: 'Deck',     plats: ['steam', 'steamdeck'] },
    thor:   { label: 'Thor',     plats: ['ayn', 'retro'] },
    switch: { label: 'Switch',   plats: ['switch2', 'switch'] },
    ps5:    { label: 'PS5',      plats: ['ps5'] },
    wiiu:   { label: 'Wii U',    plats: ['wiiu'] },
  };

  const TIMES = {
    quick:   { label: '30 min',     hours: 0.5 },
    evening: { label: 'An evening', hours: 2.5 },
    long:    { label: 'Long haul',  hours: 8 },
  };

  // Optional, used by owl.html (Kaepora Gaebora). No mood means the plain ranking index.html
  // has always shown. Genre is free text, so the moods match it by keyword rather than enum.
  const MOODS = {
    chill:  { label: 'Chill' },
    deep:   { label: 'Sink in' },
    finish: { label: 'Wrap one up' },
  };
  const CHILL_G = /puzzle|sim|platformer|rhythm|pinball|sports|racing|incremental|idle|visual novel|creature|ccg|cozy/i;
  const HARD_G = /soulslike|bullet hell|horror|roguelike/i;
  const DEEP_G = /rpg|metroidvania|adventure|strategy|survival|soulslike|anthology/i;

  // Achievements left to 100%, or null when it isn't worth saying: casual games, games with
  // none, games not started, and anything more than 5 away.
  function achLeft(g) {
    if (g.casual || !Array.isArray(g.achCount)) return null;
    const [e, t] = g.achCount;
    const left = t - e;
    return t > 0 && e > 0 && left >= 1 && left <= 5 ? left : null;
  }

  function parseHltb(h) {
    if (!h) return null;
    const s = String(h);
    if (s.includes('-')) {
      const [a, b] = s.replace(/h/g, '').split('-');
      const v = (parseFloat(a) + parseFloat(b)) / 2;
      return Number.isFinite(v) ? v : null;
    }
    return parseFloat(s.replace('h', '').replace('+', '')) || null;
  }

  function localDate(s) { const [y, m, d] = String(s).split('-').map(Number); return new Date(y, m - 1, d); }
  function daysSince(s, now) { return s ? Math.floor((now - localDate(s)) / 86400000) : null; }
  const round = (h) => h >= 10 ? Math.round(h) : Math.round(h * 2) / 2;

  // Hours left to the credits, or null when there's no estimate to go on. Past the estimate
  // already means "close", not "zero": HLTB is an average and you're evidently slower.
  function remaining(g) {
    const est = parseHltb(g.h);
    if (!est) return null;
    if (g.actualHours == null) return est;
    const left = est - g.actualHours;
    return left >= 0.5 ? left : Math.max(0.5, est * 0.1);
  }

  function outstandingPick(g, picks) {
    if (!g.gotm || g.gotmFlair || !Array.isArray(picks)) return null;
    const p = picks.find(x => x.tag === g.gotm);
    return p && !p.retired && p.monthsLeft > 0 ? p : null;
  }

  function devicesWithGames(games) {
    return Object.keys(DEVICES).filter(k => k === 'any'
      || games.some(g => ['playing', 'queue', 'ongoing'].includes(g.s) && DEVICES[k].plats.includes(g.p)));
  }

  // Returns [{ g, score, reasons: [string], remaining }] best first.
  function pickGames(games, opts = {}) {
    const time = TIMES[opts.time] || TIMES.evening;
    const quick = time === TIMES.quick;
    const device = DEVICES[opts.device] || DEVICES.any;
    const mood = MOODS[opts.mood] ? opts.mood : null;
    const now = opts.now || new Date();
    const recent = (opts.play && opts.play.recent) || {};
    const picks = opts.gotm && opts.gotm.picks;
    const limit = opts.limit || 3;

    const queueIds = games.filter(g => g.s === 'queue').map(g => g.id);
    const out = [];

    for (const g of games) {
      if (device.plats && !device.plats.includes(g.p)) continue;
      if (g.release && daysSince(g.release, now) < 0) continue;     // not out yet
      const pick = outstandingPick(g, picks);
      const eligible = g.s === 'playing' || g.s === 'queue'
        || (g.s === 'ongoing' && (quick || mood === 'chill'))
        || (g.s === 'soon' && pick && pick.monthsLeft <= 3);
      if (!eligible) continue;

      const reasons = [];                                            // [weight, text]
      let score = 0;
      const left = g.s === 'ongoing' ? null : remaining(g);
      const r = recent[g.id];
      const mins = r && r.mins || 0;
      const lp = daysSince(g.lastPlayed, now);

      if (g.s === 'playing') {
        score += 40;
        if (lp != null && lp > 30) { score -= 15; reasons.push([5, `Dormant ${lp} days, pick it back up?`]); }
        else reasons.push([10, 'In progress']);
      } else if (g.s === 'queue') {
        const pos = queueIds.indexOf(g.id);
        score += Math.max(30 - pos * 3, 5);
        reasons.push([pos === 0 ? 25 : 8, `#${pos + 1} in Up Next`]);
        // Starting something new in half an hour rarely sticks, unless it's tiny.
        if (quick && !mins && !(left != null && left <= 1.5)) score -= 20;
      } else if (g.s === 'ongoing') {
        score += 28;
        reasons.push([12, 'Easy to dip into']);
      }

      if (mins) {
        const hrs = mins / 60;
        score += Math.min(hrs, 10) * 2;
        reasons.push([g.s === 'playing' ? 15 : 22, `${round(hrs)}h in the last ${(opts.play && opts.play.windowDays) || 14} days`]);
        if (g.s !== 'playing') score += 15;
      } else if (lp != null && lp <= 7 && g.s !== 'ongoing') {
        score += 10;
        reasons.push([14, lp === 0 ? 'Played today' : lp === 1 ? 'Played yesterday' : `Played ${lp} days ago`]);
      }

      if (pick) {
        if (pick.monthsLeft === 1) { score += 55; reasons.push([45, 'GOTM: last month to claim']); }
        else if (pick.monthsLeft === 2) { score += 35; reasons.push([40, 'GOTM: 2 months left']); }
        else if (pick.monthsLeft <= 4) { score += 15; reasons.push([20, `GOTM: ${pick.monthsLeft} months left`]); }
        else reasons.push([3, `GOTM ${g.gotm}`]);
      }

      if (left != null) {
        const past = g.actualHours != null && g.actualHours >= parseHltb(g.h) - 0.5;
        if (left <= time.hours * 1.2) {
          score += 30;
          reasons.push([35, past ? 'Past the HLTB estimate, nearly done?' : `Could finish it (~${round(left)}h left)`]);
        }
        else if (left <= time.hours * 4) { score += 12; reasons.push([18, `~${round(left)}h left`]); }
        else if (quick && g.s !== 'playing') score -= 5;
        else reasons.push([2, `~${round(left)}h left`]);
      }

      const ach = achLeft(g);
      if (ach) {
        score += mood === 'finish' ? 25 : 8;
        reasons.push([30, ach === 1 ? '1 achievement from 100%' : `${ach} achievements from 100%`]);
      }

      if (mood === 'chill') {
        if (HARD_G.test(g.g || '') || (g.diff || 0) >= 4) score -= 25;
        else if (CHILL_G.test(g.g || '')) { score += 18; reasons.push([26, `Low-stakes ${g.g}`]); }
        else if (g.s === 'ongoing') { score += 18; if (!quick) reasons.push([26, 'Easy to dip into']); }
      } else if (mood === 'deep') {
        if (g.s === 'ongoing') score -= 15;
        if (DEEP_G.test(g.g || '')) score += 10;
        if (left != null && left >= 10) { score += 12; reasons.push([24, `A big one to sink into (~${round(left)}h)`]); }
        // Something you'd finish in one sitting isn't what "sink in" asked for.
        else if (left != null && left <= time.hours * 1.2) score -= 20;
        if (g.s === 'playing') score += 8;
      } else if (mood === 'finish') {
        if (left != null && left <= Math.max(time.hours * 2, 3)) {
          score += 25;
          // Within tonight's time it already says "Could finish it"; don't say it twice.
          if (left > time.hours * 1.2) reasons.push([36, `Nearly at the credits (~${round(left)}h)`]);
        }
        if (g.s === 'queue' && !g.actualHours && !mins) score -= 20;
      }

      out.push({ g, score, remaining: left,
        reasons: reasons.sort((a, b) => b[0] - a[0]).slice(0, 2).map(x => x[1]) });
    }

    return out.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  const api = { DEVICES, TIMES, MOODS, pickGames, achLeft, remaining, devicesWithGames, parseHltb };
  root.GTPick = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
