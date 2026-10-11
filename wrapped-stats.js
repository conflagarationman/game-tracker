// The year-in-review numbers behind wrapped.html, borrowing the ideas the platforms' own recaps
// are built on (Steam Replay, PlayStation Wrap-Up, Nintendo Year in Review) but computed from
// this tracker's data:
//   - share of the year's hours per game, not just a count        (Steam Replay)
//   - new releases vs recent vs classics, by hours                 (Steam Replay)
//   - played in its launch year / oldest game of the year          (Nintendo)
//   - each month's standout game                                    (Nintendo, Steam)
//   - a streak: consecutive months with something finished         (Steam's play streak)
//   - how you played: handheld, hybrid, desk & TV                   (Steam Deck share, Switch modes)
//   - trophies/achievements: earned, and games completed to 100%   (PlayStation)
//   - a play-style persona with its reason                          (Wrap-Up / Year in Review)
//   - you vs your own past years, in place of "more than X% of players"
// Pure and DOM-free like pick.js: index.html-style plain script, unit-tested in Node
// (scripts/wrapped.test.mjs).
(function (root) {
  const DEVICE = {
    handheld: ['steamdeck', 'ayn', 'retro'],      // retro = RetroAchievements on the Thor
    hybrid:   ['switch', 'switch2'],
    desk:     ['steam', 'pc', 'ps5', 'wiiu'],
  };
  const DEVICE_LABEL = { handheld: 'Handheld', hybrid: 'Switch (either way)', desk: 'PC & TV' };
  // Steam Replay splits playtime at roughly eight years back; same rule here.
  const RECENT_YEARS = 8;
  const PERFECT = new Set(['mastered', 'platinum', '100pct']);

  function parseHltb(h) {
    if (!h) return null;
    const s = String(h);
    if (s.includes('-')) { const [a, b] = s.replace(/h/g, '').split('-'); const v = (parseFloat(a) + parseFloat(b)) / 2; return Number.isFinite(v) ? v : null; }
    return parseFloat(s.replace('h', '').replace('+', '')) || null;
  }
  // Idle games (genre "Idle": desk pets, clickers left running) still count as finished, but
  // their hours say nothing about play, so they're left out of every hours figure.
  const isIdle = (g) => /\bidle\b/i.test(g.g || '');
  // Real Steam playtime where the sync has it (already net of ASF card idling, see
  // sync-apis.mjs), else the HowLongToBeat estimate.
  const hours = (g) => isIdle(g) ? 0 : (g.actualHours || parseHltb(g.h) || 0);
  const median = (xs) => { const s = [...xs].sort((a, b) => a - b); const n = s.length; return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : null; };
  const isPerfect = (g) => PERFECT.has(g.mastery) || g.achPct === 100;
  const deviceOf = (p) => Object.keys(DEVICE).find(k => DEVICE[k].includes(p)) || 'desk';

  function basic(games, year) {
    const done = games.filter(g => g.cy === year && g.s === 'done');
    const rated = done.filter(g => g.r > 0);
    const totalH = done.reduce((s, g) => s + hours(g), 0);
    return { done, rated, totalH, avg: rated.length ? rated.reduce((s, g) => s + g.r, 0) / rated.length : null };
  }

  // Best first: rating, then hours, then title so ties don't shuffle between loads.
  const byStanding = (a, b) => (b.r || 0) - (a.r || 0) || hours(b) - hours(a) || a.t.localeCompare(b.t);

  function yearStats(games, year, now = new Date(), asfIdle = null) {
    const { done, rated, totalH, avg } = basic(games, year);
    const current = year === now.getFullYear();
    const monthsElapsed = current ? now.getMonth() + 1 : 12;

    // Share of the year's hours (Steam Replay's headline view).
    const hoursShare = done.filter(g => hours(g) > 0)
      .map(g => ({ g, hours: hours(g), pct: totalH ? hours(g) / totalH * 100 : 0, real: !!g.actualHours }))
      .sort((a, b) => b.hours - a.hours);

    // New / recent / classic, weighted by hours like Steam's, with counts alongside.
    const cutoff = year - RECENT_YEARS;
    const eraOf = (g) => !g.y ? null : g.y >= year ? 'new' : g.y >= cutoff ? 'recent' : 'classic';
    const eras = { new: { n: 0, h: 0 }, recent: { n: 0, h: 0 }, classic: { n: 0, h: 0 } };
    done.forEach(g => { const e = eraOf(g); if (e) { eras[e].n++; eras[e].h += hours(g); } });
    const eraH = eras.new.h + eras.recent.h + eras.classic.h;
    const eraN = eras.new.n + eras.recent.n + eras.classic.n;
    for (const e of Object.values(eras)) e.pct = eraH ? e.h / eraH * 100 : eraN ? e.n / eraN * 100 : 0;
    const launchYear = done.filter(g => g.y === year).sort(byStanding);
    const withY = done.filter(g => g.y);
    const oldest = withY.length ? withY.reduce((a, b) => (b.y < a.y ? b : a)) : null;

    // Month by month, with each month's standout.
    const months = Array.from({ length: 12 }, (_, m) => {
      const list = done.filter(g => g.cm === m).sort(byStanding);
      return { m, n: list.length, top: list[0] || null, future: current && m >= monthsElapsed };
    });
    let streak = { len: 0, from: null, to: null }, run = 0;
    months.forEach(({ m, n }) => {
      run = n ? run + 1 : 0;
      if (run > streak.len) streak = { len: run, from: m - run + 1, to: m };
    });

    // How you played: device split by hours.
    const device = { handheld: 0, hybrid: 0, desk: 0 };
    done.forEach(g => { device[deviceOf(g.p)] += hours(g); });
    const deviceSplit = Object.entries(device).map(([k, h]) => ({ k, label: DEVICE_LABEL[k], h, pct: totalH ? h / totalH * 100 : 0 }))
      .filter(d => d.h > 0).sort((a, b) => b.h - a.h);

    // Trophies and achievements.
    const withAch = done.filter(g => Array.isArray(g.achCount) && !g.casual);
    const achievements = withAch.length ? {
      earned: withAch.reduce((s, g) => s + (g.achCount[0] || 0), 0),
      games: withAch.length,
      avgPct: Math.round(withAch.reduce((s, g) => s + (g.achPct || 0), 0) / withAch.length),
    } : null;
    const perfect = done.filter(isPerfect);

    // You vs you: the closest earlier year with anything finished.
    const years = [...new Set(games.filter(g => g.s === 'done' && g.cy).map(g => g.cy))].sort((a, b) => a - b);
    const prevYear = years.filter(y => y < year).pop() || null;
    let vsPrev = null;
    if (prevYear) {
      const p = basic(games, prevYear);
      vsPrev = { year: prevYear, done: done.length - p.done.length, hours: Math.round(totalH - p.totalH),
        avg: avg != null && p.avg != null ? Math.round((avg - p.avg) * 10) / 10 : null };
    }
    const counts = years.map(y => basic(games, y).done.length);
    const bestYear = done.length > 0 && done.length >= Math.max(0, ...counts) && years.length > 1;

    const stats = {
      year, current, monthsElapsed, done, rated, totalH, avg,
      top: [...rated].sort(byStanding).slice(0, 5),
      goty: rated.length ? [...rated].sort(byStanding)[0] : null,
      hoursShare, eras, cutoff, launchYear, oldest, months, streak, deviceSplit,
      achievements, perfect, vsPrev, bestYear,
      medianHours: median(done.map(hours).filter(Boolean)),
      flairs: done.filter(g => g.gotm && g.gotmFlair),
      idleGames: done.filter(isIdle),
      // ASF card farming that year, from asf-idle.json (the hub's farm ledger, via the sync).
      asf: asfIdle && asfIdle.years && asfIdle.years[year] ? { ...asfIdle.years[year], coverageFrom: asfIdle.coverageFrom } : null,
      asfCoverageFrom: asfIdle ? asfIdle.coverageFrom || null : null,
      dropped: games.filter(g => g.cy === year && g.s === 'dropped'),
      genres: Object.entries(done.reduce((o, g) => { if (g.g) o[g.g] = (o[g.g] || 0) + 1; return o; }, {})).sort((a, b) => b[1] - a[1]),
    };
    stats.persona = persona(stats);
    return stats;
  }

  // A play-style label in the spirit of Wrap-Up's and Year in Review's, picked by how far past
  // its threshold each trait is, with the number that earned it. Too little data: none.
  function persona(s) {
    const n = s.done.length;
    if (n < 3) return null;
    const handheldPct = s.deviceSplit.filter(d => d.k !== 'desk').reduce((t, d) => t + d.pct, 0);
    const classicCount = s.eras.classic.n, newCount = s.eras.new.n;
    const candidates = [
      { title: 'The Completionist', score: s.perfect.length / n / 0.25,
        line: `${s.perfect.length} of ${n} games mastered or 100%’d` },
      { title: 'The Archaeologist', score: (classicCount / n) / 0.4,
        line: `${classicCount} of ${n} finishes came out before ${s.cutoff}` },
      { title: 'The Day-Oner', score: (newCount / n) / 0.3,
        line: `${newCount} of ${n} finishes came out this year` },
      { title: 'The Handheld Hero', score: handheldPct / 65,
        line: `${Math.round(handheldPct)}% of your hours were on handhelds or the Switch` },
      { title: 'The Sampler', score: n >= 12 && s.medianHours ? 6 / s.medianHours : 0,
        line: `${n} games, most of them under ${Math.ceil(s.medianHours || 0)} hours` },
      { title: 'The Marathoner', score: s.medianHours ? s.medianHours / 25 : 0,
        line: `a typical game this year ran ${Math.round(s.medianHours || 0)} hours` },
      { title: 'The Club Regular', score: s.flairs.length / 3,
        line: `${s.flairs.length} Game of the Month flairs` },
    ].filter(c => c.score >= 1).sort((a, b) => b.score - a.score);
    if (candidates.length) return { title: candidates[0].title, line: candidates[0].line, also: candidates[1] ? candidates[1].title : null };
    const genres = s.genres.length;
    return { title: 'The Explorer', line: `${n} games across ${genres} genre${genres === 1 ? '' : 's'}`, also: null };
  }

  const api = { yearStats, persona, hours, isIdle, parseHltb, DEVICE, RECENT_YEARS };
  root.GTWrapped = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
