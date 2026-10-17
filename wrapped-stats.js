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
  // A return trip (games.json `replay`): 'replay', '100pct' or '1.0'; true is the old plain replay.
  const RETURN_KINDS = ['replay', '100pct', '1.0'];
  const returnKind = (g) => g.replay === true ? 'replay' : RETURN_KINDS.includes(g.replay) ? g.replay : null;
  // The release year that matters for old-vs-new and "played at launch": a 1.0 launch counts as
  // coming out the year it was finished (Palworld left early access in 2026), everything else its `y`.
  const relYear = (g) => returnKind(g) === '1.0' && g.cy ? g.cy : g.y;
  const deviceOf = (p) => Object.keys(DEVICE).find(k => DEVICE[k].includes(p)) || 'desk';

  function basic(games, year) {
    const done = games.filter(g => g.cy === year && g.s === 'done');
    const rated = done.filter(g => g.r > 0);
    const totalH = done.reduce((s, g) => s + hours(g), 0);
    return { done, rated, totalH, avg: rated.length ? rated.reduce((s, g) => s + g.r, 0) / rated.length : null };
  }

  // Best first: rating, then hours, then title so ties don't shuffle between loads.
  const byStanding = (a, b) => (b.r || 0) - (a.r || 0) || hours(b) - hours(a) || a.t.localeCompare(b.t);

  // ─── From the ledgers (ledger.json, achievements-log.json) ──────────────────────────────
  // Hours actually played in a year, every game, finished or not. A snapshot can dip (a game's
  // hours froze while ASF farmed it, or the sync's definition moved), so play is only a rise
  // above the game's previous high. A game's first number is a baseline, not play, except for a
  // game that came out this year (`y`): then every hour of it was played this year (when in the
  // year isn't known, so it isn't in the month chart). A `start` in the year is not enough: Palworld
  // and Brotato were restarted in 2026 with hours from earlier years (Jonny, 2026-10-17), so an
  // older game counts only what the log saw. Idle-genre games are left out.
  function playedHours(ledger, games, year) {
    if (!ledger || !ledger.days) return null;
    const byId = new Map(games.map(g => [g.id, g]));
    const from = `${year}-01-01`, to = `${year}-12-31`;
    const high = {}, first = {}, per = {}, months = Array(12).fill(0);
    const counts = (id) => byId.has(id) && !isIdle(byId.get(id));
    const add = (id, h, m) => { if (!counts(id)) return; per[id] = (per[id] || 0) + h; if (m != null) months[m] += h; };
    for (const d of Object.keys(ledger.days).sort()) {
      if (d > to) break;
      for (const [k, h] of Object.entries(ledger.days[d])) {
        const id = Number(k);
        if (!(id in high)) { high[id] = h; first[id] = { d, h }; continue; }
        if (h > high[id]) { if (d >= from) add(id, h - high[id], Number(d.slice(5, 7)) - 1); high[id] = h; }
      }
    }
    // Hours from before the log that are this year's: all of them for a game released this year;
    // for a game with `priorH` (hours from before this run, e.g. Palworld's early access), the rest.
    const fromStart = new Set(), credited = {};
    for (const [k, f] of Object.entries(first)) {
      const g = byId.get(Number(k));
      if (!g || f.h <= 0 || f.d < from) continue;
      const h = typeof g.priorH === 'number' ? Math.max(0, f.h - g.priorH) : g.y === year ? f.h : 0;
      if (h > 0) { add(g.id, h, null); fromStart.add(g.id); credited[g.id] = h; }
    }
    const list = Object.entries(per).map(([k, h]) => ({ g: byId.get(Number(k)), hours: Math.round(h * 10) / 10 }))
      .filter(x => x.g && !isIdle(x.g) && x.hours > 0)
      .map(x => ({ ...x, fromStart: fromStart.has(x.g.id), replay: returnKind(x.g) }))
      .sort((a, b) => b.hours - a.hours || a.g.t.localeCompare(b.g.t));
    const total = Math.round(list.reduce((s, x) => s + x.hours, 0) * 10) / 10;
    return { total, games: list, months: months.map(h => Math.round(h * 10) / 10),
      since: ledger.since && ledger.since > from ? ledger.since : null,
      untimed: Math.round(list.filter(x => x.fromStart).reduce((s, x) => s + (credited[x.g.id] || 0), 0) * 10) / 10 };
  }

  // Unlock times are UTC; every hour and day here is Eastern, so an 11 PM Dec 31 unlock is
  // 2026's and the night-owl hours are the ones on your clock.
  const ET = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', hourCycle: 'h23', weekday: 'short' });
  function etParts(ts) {
    const p = {};
    for (const x of ET.formatToParts(new Date(ts * 1000))) p[x.type] = x.value;
    return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) % 24, dow: p.weekday };
  }
  const dayNum = (iso) => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) / 86400000;
  const NIGHT = (h) => h >= 22 || h < 4;

  function unlockStats(unlocks, year) {
    const rows = (unlocks || []).map(r => Object.assign({}, r, etParts(r.ts))).filter(r => r.date.slice(0, 4) === String(year));
    if (!rows.length) return null;
    rows.sort((a, b) => a.ts - b.ts);
    const hours = Array(24).fill(0), byDay = new Map(), games = new Set();
    for (const r of rows) {
      hours[r.hour]++;
      games.add(r.game);
      if (!byDay.has(r.date)) byDay.set(r.date, []);
      byDay.get(r.date).push(r);
    }
    const peakHour = hours.indexOf(Math.max(...hours));
    const night = rows.filter(r => NIGHT(r.hour)).length;
    let busiest = null;
    for (const [date, list] of byDay) if (!busiest || list.length > busiest.n) {
      const count = {};
      list.forEach(r => { count[r.game] = (count[r.game] || 0) + 1; });
      busiest = { date, n: list.length, game: Object.entries(count).sort((a, b) => b[1] - a[1])[0][0] };
    }
    const days = [...byDay.keys()].sort();
    let streak = { len: 0, from: null, to: null }, run = 0;
    days.forEach((d, i) => {
      run = i && dayNum(d) - dayNum(days[i - 1]) === 1 ? run + 1 : 1;
      if (run > streak.len) streak = { len: run, from: days[i - run + 1], to: d };
    });
    const rare = rows.filter(r => r.pct != null && r.pct > 0);
    const rarest = rare.length ? rare.reduce((a, b) => (b.pct < a.pct ? b : a)) : null;
    return { count: rows.length, games: games.size, days: days.length, hours, peakHour, nightPct: Math.round(night / rows.length * 100),
      busiest, streak, rarest, first: rows[0], last: rows[rows.length - 1],
      steam: rows.filter(r => r.src === 'steam').length, ra: rows.filter(r => r.src === 'ra').length };
  }

  // Added to the backlog vs taken off it, from the dates the tracker keeps (`queued`, `start`, `cy`).
  // A day with IMPORT_BURST or more games queued is the tracker being filled in (2026-06-16: 51
  // games the day it was built), not games being added, so it's counted apart as `imported`.
  const IMPORT_BURST = 15;
  function backlogMath(games, year) {
    const ys = String(year), inYear = (d) => !!d && String(d).slice(0, 4) === ys;
    const perDay = {};
    games.forEach(g => { if (inYear(g.queued)) perDay[g.queued] = (perDay[g.queued] || 0) + 1; });
    const burst = (d) => perDay[d] >= IMPORT_BURST;
    const added = games.filter(g => inYear(g.queued) && !burst(g.queued));
    const imported = games.filter(g => inYear(g.queued) && burst(g.queued)).length;
    const finished = games.filter(g => g.s === 'done' && g.cy === year).length;
    const dropped = games.filter(g => g.s === 'dropped' && g.cy === year).length;
    return { added: added.length, imported, started: games.filter(g => inYear(g.start)).length, finished, dropped,
      net: added.length - finished - dropped,
      waiting: added.filter(g => g.s === 'queue' || g.s === 'soon').length };
  }

  function yearStats(games, year, now = new Date(), asfIdle = null, extra = {}) {
    const { done, rated, totalH, avg } = basic(games, year);
    const current = year === now.getFullYear();
    const monthsElapsed = current ? now.getMonth() + 1 : 12;

    // Share of the year's hours (Steam Replay's headline view).
    const hoursShare = done.filter(g => hours(g) > 0)
      .map(g => ({ g, hours: hours(g), pct: totalH ? hours(g) / totalH * 100 : 0, real: !!g.actualHours }))
      .sort((a, b) => b.hours - a.hours);

    // New / recent / classic, weighted by hours like Steam's, with counts alongside.
    const cutoff = year - RECENT_YEARS;
    const eraOf = (g) => { const y = relYear(g); return !y ? null : y >= year ? 'new' : y >= cutoff ? 'recent' : 'classic'; };
    const eras = { new: { n: 0, h: 0 }, recent: { n: 0, h: 0 }, classic: { n: 0, h: 0 } };
    done.forEach(g => { const e = eraOf(g); if (e) { eras[e].n++; eras[e].h += hours(g); } });
    const eraH = eras.new.h + eras.recent.h + eras.classic.h;
    const eraN = eras.new.n + eras.recent.n + eras.classic.n;
    for (const e of Object.values(eras)) e.pct = eraH ? e.h / eraH * 100 : eraN ? e.n / eraN * 100 : 0;
    const launchYear = done.filter(g => relYear(g) === year).sort(byStanding);
    const withY = done.filter(g => relYear(g));
    const oldest = withY.length ? withY.reduce((a, b) => (relYear(b) < relYear(a) ? b : a)) : null;

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
      // Replays count like any other finish or hour; the page just labels them.
      replays: done.filter(g => returnKind(g)),
      genres: Object.entries(done.reduce((o, g) => { if (g.g) o[g.g] = (o[g.g] || 0) + 1; return o; }, {})).sort((a, b) => b[1] - a[1]),
      played: playedHours(extra.ledger, games, year),
      unlocks: unlockStats(extra.unlocks, year),
      backlog: backlogMath(games, year),
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
      { title: 'The Night Owl', score: s.unlocks && s.unlocks.count >= 30 ? s.unlocks.nightPct / 30 : 0,
        line: `${s.unlocks ? s.unlocks.nightPct : 0}% of your unlocks came between 10 PM and 4 AM` },
      { title: 'The Backlog Slayer', score: s.backlog && s.backlog.added >= 5 ? (s.backlog.finished / s.backlog.added) / 0.9 : 0,
        line: `${s.backlog ? s.backlog.finished : 0} finished against ${s.backlog ? s.backlog.added : 0} added` },
      { title: 'The Collector', score: s.backlog && s.backlog.finished >= 3 ? (s.backlog.added / s.backlog.finished) / 2 : 0,
        line: `${s.backlog ? s.backlog.added : 0} games added to the list, ${s.backlog ? s.backlog.finished : 0} finished` },
    ].filter(c => c.score >= 1).sort((a, b) => b.score - a.score);
    if (candidates.length) return { title: candidates[0].title, line: candidates[0].line, also: candidates[1] ? candidates[1].title : null };
    const genres = s.genres.length;
    return { title: 'The Explorer', line: `${n} games across ${genres} genre${genres === 1 ? '' : 's'}`, also: null };
  }


  // ─── Year of Play poster ───────────────────────────────────────────────────────────────
  // Every game finished in the year is a cartridge on a shelf, sized by hours, with the year's
  // Game of the Year on its own pedestal in the middle. This is only the numbers and the
  // geometry (poster units, a 4:3-tall 900x1200 sheet); wrapped.html draws it, at preview size
  // and again at 4x for the PNG, so nothing here touches a canvas or a cover image.
  const POSTER = { W: 900, H: 1200, GRID: 4, MARGIN: 60, SHELF_TOP: 215, SHELF_BOTTOM: 1030,
    BOARD: 16, GAP: 12, ROW_GAP: 18, GOTY_W: 188 };

  const snap = (n, grid) => Math.max(grid * 2, Math.round(n / grid) * grid);
  // Cartridge width 56..104 by hours, rising fast then flattening (a 60h game is not 6x a 10h one).
  const cartWidth = (h) => 56 + 48 * Math.min(1, Math.sqrt(Math.max(0, h) / 80));
  const cartHeight = (w) => w * 1.18;

  // Chronological like the Year Log: by month finished (undated last), then title.
  const byFinish = (a, b) => (a.cm == null ? 99 : a.cm) - (b.cm == null ? 99 : b.cm) || a.t.localeCompare(b.t);

  // Fill rows left to right inside `inner` width, each row centred, every cart bottom-aligned.
  function packRows(games, scale, inner) {
    const G = POSTER.GRID, rows = [];
    let row = null;
    for (const g of games) {
      const w = snap(cartWidth(hours(g)) * scale, G), h = snap(cartHeight(w), G);
      const cart = { g, w, h, hours: hours(g) };
      if (!row || row.w + POSTER.GAP + w > inner) { row = { carts: [], w: -POSTER.GAP, h: 0 }; rows.push(row); }
      row.carts.push(cart); row.w += POSTER.GAP + w; row.h = Math.max(row.h, h);
    }
    return rows;
  }

  function posterStats(games, year) {
    const done = games.filter(g => g.cy === year && g.s === 'done' && !isIdle(g));
    const rated = done.filter(g => g.r > 0).sort(byStanding);
    const goty = rated[0] || null;
    const others = done.filter(g => g !== goty).sort(byFinish);
    const totalH = done.reduce((t, g) => t + hours(g), 0);
    const byPlat = {};
    done.forEach(g => { const o = byPlat[g.p] || (byPlat[g.p] = { p: g.p, n: 0, h: 0 }); o.n++; o.h += hours(g); });
    const topPlatform = Object.values(byPlat).sort((a, b) => b.n - a.n || b.h - a.h || a.p.localeCompare(b.p))[0] || null;
    // Longest streak uses every finish that year (idle games included), same as the page's streak.
    const months = new Set(games.filter(g => g.cy === year && g.s === 'done' && g.cm != null).map(g => g.cm));
    let streak = 0, run = 0;
    for (let m = 0; m < 12; m++) { run = months.has(m) ? run + 1 : 0; streak = Math.max(streak, run); }
    return { year, games: done.length, hours: totalH, topPlatform, streak, goty, others,
      layout: layoutPoster(goty, others) };
  }

  // Shrinks the carts until the shelves fit between the header and the footer. Positions are in
  // poster units; a cart's y is its top edge and its bottom sits on the board of its shelf.
  function layoutPoster(goty, others) {
    const P = POSTER, inner = P.W - P.MARGIN * 2, avail = P.SHELF_BOTTOM - P.SHELF_TOP;
    const gotyH = goty ? snap(cartHeight(P.GOTY_W), P.GRID) + 70 : 0;     // plaque + pedestal
    const split = goty ? Math.ceil(others.length / 2) : others.length;
    let scale = 1.5, top, bottom, total;   // sparse years get bigger carts, up to 1.5x
    for (;;) {
      top = packRows(others.slice(0, split), scale, inner);
      bottom = packRows(others.slice(split), scale, inner);
      const rows = top.length + bottom.length + (goty ? 1 : 0);
      total = [...top, ...bottom].reduce((t, r) => t + r.h + P.BOARD, 0) + gotyH + (rows - 1) * P.ROW_GAP;
      if (total <= avail || scale <= 0.25) break;
      scale = Math.round((scale - 0.05) * 100) / 100;
    }
    let y = P.SHELF_TOP + Math.max(0, (avail - total) / 2);
    const carts = [], shelves = [];
    const place = (rows) => rows.forEach(r => {
      let x = (P.W - r.w) / 2;
      r.carts.forEach(c => { carts.push({ g: c.g, x, y: y + r.h - c.h, w: c.w, h: c.h, hours: c.hours }); x += c.w + P.GAP; });
      shelves.push({ y: y + r.h, x0: P.MARGIN - 20, x1: P.W - P.MARGIN + 20 });
      y += r.h + P.BOARD + P.ROW_GAP;
    });
    place(top);
    let gotyCart = null;
    if (goty) {
      const w = P.GOTY_W, h = snap(cartHeight(w), P.GRID), gy = y + 54;       // 54 = plaque above
      gotyCart = { g: goty, x: (P.W - w) / 2, y: gy, w, h, hours: hours(goty), plaqueY: y };
      shelves.push({ y: gy + h, x0: P.MARGIN - 20, x1: P.W - P.MARGIN + 20, goty: true });
      y += gotyH + P.ROW_GAP;
    }
    place(bottom);
    return { carts, goty: gotyCart, shelves, scale, W: P.W, H: P.H, grid: P.GRID };
  }

  const api = { posterStats, layoutPoster, POSTER, yearStats, persona, hours, isIdle, parseHltb, DEVICE, RECENT_YEARS,
    playedHours, unlockStats, backlogMath, etParts, returnKind, relYear };
  root.GTWrapped = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
