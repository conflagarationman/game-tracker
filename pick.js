// "What should I play?" — ranks what's worth picking up right now, given how long you've got
// and which device is in your hand. Pure and DOM-free so it runs in Node too
// (scripts/pick.test.mjs); index.html loads it as a plain script and reads globalThis.GTPick.
//
// By default it only suggests from what you've already decided to play (Now Playing, Up Next,
// Ongoing for short sessions) plus Someday games whose club pick is about to expire; that's
// index.html's picker, which doesn't mine Someday for ideas (Someday triage does that).
// owl.html (Kaepora Gaebora) asks for more: `someday: true` lets the Someday pile in, and
// owlLineup() mixes in wildcards from outside the tracker: the Steam library, half-finished
// RetroAchievements games, unclaimed club picks and retro-canon.json's must-plays.
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
  const CHILL_G = /puzzle|sim|platformer|rhythm|pinball|sports|racing|incremental|idle|visual novel|creature|ccg|cozy|casual|party/i;
  const HARD_G = /soulslike|bullet hell|horror|roguelike/i;
  // Not hard, but not "easy on the mind" either.
  const INTENSE_G = /shooter|fps|fighting|beat 'em up|run and gun|hack and slash|stealth|action platformer/i;
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

  // Mood scoring shared by tracked games and wildcards. `genre` is free text (the tracker's,
  // or Steam's genre list joined); unknown genre is neutral rather than a miss.
  function moodFit(mood, genre, { ongoing = false, diff = null, left = null, ach = null, time = TIMES.evening, quick = false } = {}) {
    const gen = genre || '';
    if (!mood) return { score: 0, fits: true, reason: null };
    if (mood === 'chill') {
      if (HARD_G.test(gen) || INTENSE_G.test(gen) || (diff || 0) >= 4) return { score: -25, fits: false, reason: null };
      if (CHILL_G.test(gen)) return { score: 18, fits: true, reason: [26, `Low-stakes ${gen.split(',')[0]}`] };
      if (ongoing) return { score: 18, fits: true, reason: null };         // already says "Easy to dip into"
      return { score: gen ? -12 : 0, fits: false, reason: null };
    }
    if (mood === 'deep') {
      let score = ongoing ? -15 : 0, fits = false, reason = null;
      if (DEEP_G.test(gen)) { score += 10; fits = true; }
      if (left != null && left >= 10) { score += 12; fits = true; reason = [24, `A big one to sink into (~${round(left)}h)`]; }
      else if (left != null && left <= time.hours * 1.2) { score -= 20; fits = false; }   // one sitting isn't "sink in"
      return { score, fits, reason };
    }
    if (mood === 'finish') {
      let score = 0, fits = false, reason = null;
      if (left != null && left <= Math.max(time.hours * 2, 3)) {
        score += 25; fits = true;
        // Within tonight's time it already says "Could finish it"; don't say it twice.
        if (left > time.hours * 1.2) reason = [36, `Nearly at the credits (~${round(left)}h)`];
      }
      if (ach) fits = true;
      return { score, fits, reason };
    }
    return { score: 0, fits: true, reason: null };
  }

  // Returns [{ g, score, reasons: [string], remaining, fits, kind }] best first.
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
        || (g.s === 'soon' && pick && pick.monthsLeft <= 3)
        || (g.s === 'soon' && opts.someday);
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
      } else if (g.s === 'soon' && !pick) {
        score += 6;
        reasons.push([9, 'From your Someday pile']);
        if (quick && !mins && !(left != null && left <= 1.5)) score -= 20;
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

      // `fits` says whether the game actually matches the mood asked for, so the owl can admit
      // when nothing does instead of passing off the least-bad option as a match.
      const m = moodFit(mood, g.g, { ongoing: g.s === 'ongoing', diff: g.diff, left, ach, time, quick });
      score += m.score;
      if (m.reason) reasons.push(m.reason);
      if (mood === 'finish' && g.s === 'queue' && !g.actualHours && !mins) score -= 20;
      if (mood === 'deep' && g.s === 'playing') score += 8;
      const fits = m.fits;

      out.push({ g, score, remaining: left, fits, kind: g.s === 'soon' && !pick ? 'someday' : 'tracked',
        reasons: reasons.sort((a, b) => b[0] - a[0]).slice(0, 2).map(x => x[1]) });
    }

    return out.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  // ─── Snoozes and drops (owl.html only) ──────────────────
  // "Not this one" doesn't remove a game, it sets it aside for longer each time it's turned
  // down: 7 days, then 30, then 90. From the fourth the owl offers to drop it for good, and even
  // that is only a flag in owl-skips.json that "Struck from the list" can undo. Nothing here
  // ever touches games.json: this is about what the owl suggests, not what the game is.
  //
  // owl-skips.json is { key: { t, count, until: 'YYYY-MM-DD'|null, dropped, last } }, written
  // only by the Worker (worker/index.mjs keeps its own copy of this table; its tests compare).
  const SNOOZE_DAYS = [7, 30, 90];

  // A stable key per game, so a turn-down survives the title being retyped or the lineup
  // shuffling: tracked games by id, Steam by appid, and the retro kinds (RA runs, club picks)
  // by normalised title, since that's all they have in common with each other and with RA.
  function wildKey(w) {
    if (w.kind === 'retro-canon') return 'canon:' + normTitle(w.t);
    if (w.appid != null) return 'steam:' + w.appid;
    return 'ra:' + normTitle(w.t);
  }
  const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

  // What the entry becomes when the game is turned down once more. `drop` is the fourth
  // answer's "Drop it"; every other turn-down snoozes, and past the third it stays at 90 days.
  function nextSkip(entry, title, { drop = false, now = new Date() } = {}) {
    const count = ((entry && entry.count) || 0) + 1;
    const last = ymd(now);
    if (drop) return { t: title, count, until: null, dropped: true, last };
    const days = SNOOZE_DAYS[Math.min(count, SNOOZE_DAYS.length) - 1];
    return { t: title, count, until: ymd(new Date(now.getFullYear(), now.getMonth(), now.getDate() + days)), dropped: false, last };
  }
  // Out of the owl's sight? A snooze lapses on its `until` day; a drop never lapses by itself.
  function isHidden(entry, now = new Date()) {
    if (!entry) return false;
    return !!entry.dropped || (!!entry.until && entry.until > ymd(now));
  }

  // ─── Wildcards (owl.html only) ──────────────────────────
  // Games from outside the tracker, for the owl's every-third suggestion. `src` is
  //   { library: library.json, meta: library-meta.json, canon: retro-canon.json, gotm: gotm.json }
  // Anything already in the tracker, under any status, is left out: the tracker's own games
  // come through pickGames().
  const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  function normTitle(t) {
    return String(t || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[™®©]/g, '').replace(/^the legend of zelda: /, 'zelda: ').replace(/[^a-z0-9]+/g, ' ').trim();
  }
  const FAVOURITE_HOURS = 15;      // well above what ASF card idling leaves on a game
  const STEAM_DEVICES = ['any', 'pc', 'deck'];
  const RETRO_DEVICES = ['any', 'thor'];

  function wildcards(games, src = {}, opts = {}) {
    const time = TIMES[opts.time] || TIMES.evening;
    const quick = time === TIMES.quick;
    const mood = MOODS[opts.mood] ? opts.mood : null;
    const device = DEVICES[opts.device] ? opts.device : 'any';
    const now = opts.now || new Date();
    const tracked = new Set(games.map(g => normTitle(g.t)));
    const out = [];
    const add = (w, genre, base, extra = {}) => {
      const m = moodFit(mood, genre, { time, quick, ...extra });
      const reasons = [w.reason];
      if (m.reason) reasons.push(m.reason[1]);
      out.push({ ...w, key: wildKey(w), score: base + m.score + (w.timeScore || 0), fits: m.fits, reasons });
    };

    const lib = src.library || {};
    const meta = src.meta || {};
    if (STEAM_DEVICES.includes(device)) {
      for (const sg of lib.steam || []) {
        if (tracked.has(normTitle(sg.name))) continue;
        const mt = meta[sg.appid] || {};
        if (device === 'deck' && mt.d === 1) continue;            // Deck: unsupported
        const genre = (mt.g || []).join(', ');
        if (sg.hours >= FAVOURITE_HOURS && (!sg.lastPlayed || daysSince(sg.lastPlayed, now) > 45)) {
          const when = sg.lastPlayed ? ` · last played ${MONTHS[localDate(sg.lastPlayed).getMonth()]} ${localDate(sg.lastPlayed).getFullYear()}` : '';
          add({ kind: 'steam-favourite', t: sg.name, p: 'steam', appid: sg.appid, hours: sg.hours,
                reason: `${round(sg.hours)}h logged${when}`, timeScore: quick ? 10 : 0 },
              genre, 20 + Math.min(sg.hours, 100) / 10);
        } else if (sg.hours < 0.5 && (mt.m || 0) >= 80) {
          add({ kind: 'steam-unplayed', t: sg.name, p: 'steam', appid: sg.appid, meta: mt.m,
                reason: `Metacritic ${mt.m}`, timeScore: quick ? -5 : 0 },
              genre, 15 + (mt.m - 80) / 2);
        }
      }
    }

    if (RETRO_DEVICES.includes(device)) {
      const raSeen = new Set();
      for (const r of lib.ra || []) {
        raSeen.add(normTitle(r.title));
        if (tracked.has(normTitle(r.title)) || !r.total) continue;
        const pct = Math.round(r.earned / r.total * 100);
        if (r.earned < 1 || pct < 5 || pct > 90) continue;
        add({ kind: 'retro-started', t: r.title, p: 'retro', console: r.console,
              reason: `${r.earned}/${r.total} achievements${r.console ? ' on ' + r.console : ''}`, timeScore: quick ? 5 : 0 },
            '', 18 + pct / 10);
      }
      const clubTags = new Set(games.map(g => g.gotm).filter(Boolean));
      for (const c of (src.gotm && src.gotm.picks) || []) {
        if (!c.game || c.retired || !(c.monthsLeft > 0) || clubTags.has(c.tag) || tracked.has(normTitle(c.game))) continue;
        add({ kind: 'retro-club', t: c.game, p: 'retro', tag: c.tag, url: c.url || null, monthsLeft: c.monthsLeft,
              reason: `Club pick (${c.tag}), ${c.monthsLeft === 1 ? 'last month' : c.monthsLeft + ' months'} to claim` },
            '', 16 + (c.monthsLeft <= 2 ? 12 : 0));
      }
      for (const c of src.canon || []) {
        const key = normTitle(c.t);
        if (tracked.has(key) || raSeen.has(key)) continue;
        const hrs = parseHltb(c.h);
        const timeScore = hrs == null ? 0 : quick ? (hrs <= 3 ? 10 : hrs >= 20 ? -10 : 0) : time.hours >= 8 && hrs >= 20 ? 8 : 0;
        add({ kind: 'retro-canon', t: c.t, p: 'retro', console: c.c, year: c.y, g: c.g, h: c.h,
              reason: `${c.c}, ${c.y}: ${c.why}`, timeScore },
            c.g, 14, { left: hrs });
      }
    }
    return out.sort((a, b) => b.score - a.score);
  }

  // Weighted random order (Efraimidis–Spirakis): higher scores tend to come first, but every
  // visit to the owl shuffles them, so "Yes" keeps turning up something new.
  function shuffleByScore(xs, rand) {
    return xs.map(x => ({ x, k: Math.pow(rand(), 1 / Math.max(1, x.score)) }))
      .sort((a, b) => b.k - a.k).map(o => o.x);
  }

  // The owl's running order: tracked and Someday games by rank, with a wildcard every third
  // suggestion, and one in the lead when a mood was asked for and the best tracked game doesn't
  // fit it (or there is no tracked game at all). Each entry: { kind, t, p, reasons, fits, key, g|w }.
  // `src.skips` (owl-skips.json) hides snoozed and dropped games from both groups.
  function owlLineup(games, src = {}, opts = {}, rand = Math.random) {
    const skips = src.skips || {};
    const now = opts.now || new Date();
    const live = (key) => !isHidden(skips[key], now);
    // Ask for more than we show, so snoozed games leaving the top doesn't leave the lineup short.
    let tracked = pickGames(games, { ...opts, someday: true, limit: 40 })
      .map(r => ({ kind: r.kind, t: r.g.t, p: r.g.p, reasons: r.reasons, fits: r.fits, g: r.g, key: 'id:' + r.g.id }))
      .filter(r => live(r.key)).slice(0, 12);
    // With a mood asked for, games that fit it go first (rank kept within each group).
    if (MOODS[opts.mood]) tracked = [...tracked.filter(r => r.fits), ...tracked.filter(r => !r.fits)];
    const all = wildcards(games, src, opts).filter(w => live(w.key));
    // Prefer ones that fit the mood; take the top slice, then shuffle within it.
    const pool = [...all.filter(w => w.fits), ...all.filter(w => !w.fits)].slice(0, 15);
    const wild = shuffleByScore(pool.filter(w => w.fits), rand)
      .concat(shuffleByScore(pool.filter(w => !w.fits), rand))
      .map(w => ({ kind: w.kind, t: w.t, p: w.p, reasons: w.reasons, fits: w.fits, w, key: w.key }));
    const out = [];
    let ti = 0, wi = 0;
    const lead = !tracked.length || (opts.mood && !tracked[0].fits && wild.length && wild[0].fits);
    if (lead && wild.length) out.push(wild[wi++]);
    while (out.length < 12 && (ti < tracked.length || wi < wild.length)) {
      const wildTurn = (out.length + 1) % 3 === 0;
      if ((wildTurn && wi < wild.length) || ti >= tracked.length) out.push(wild[wi++]);
      else out.push(tracked[ti++]);
    }
    return out;
  }

  const api = { DEVICES, TIMES, MOODS, pickGames, achLeft, remaining, devicesWithGames, parseHltb,
    wildcards, owlLineup, normTitle, SNOOZE_DAYS, nextSkip, isHidden, wildKey };
  root.GTPick = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
