// The rupee wallet, its shop and the Great Fairy's seen-set. Pure and DOM-free so it runs in
// Node too (scripts/rupees.test.mjs); index.html and owl.html load it as a plain script and read
// globalThis.GTRupees. Earned comes from achievements-log.json (every unlock is worth rupees by
// rarity); spent comes from the purchases kept in rupees.json (Worker-only, like owl-skips.json).
// All names and numbers here are in one place on purpose: change a price here, nowhere else.
(function (root) {
  // ─── Earning ─────────────────────────────────────────
  // Steam unlocks are coloured by global rarity (pct); an unlock with no pct, and every
  // RetroAchievements unlock (no points data yet), is green.
  const VALUES = { green: 1, blue: 5, red: 20, silver: 100, gold: 300 };
  const TIER_ORDER = ['green', 'blue', 'red', 'silver', 'gold'];
  function rupeeTier(u) {
    const p = u && u.pct;
    if (!u || u.src !== 'steam' || typeof p !== 'number' || !isFinite(p)) return 'green';
    if (p >= 50) return 'green';
    if (p >= 20) return 'blue';
    if (p >= 5) return 'red';
    if (p >= 1) return 'silver';
    return 'gold';
  }
  const rupeeValue = (u) => VALUES[rupeeTier(u)];
  function earned(unlocks) {
    let sum = 0;
    for (const u of unlocks || []) sum += rupeeValue(u);
    return sum;
  }
  function tierCounts(unlocks) {
    const c = { green: 0, blue: 0, red: 0, silver: 0, gold: 0 };
    for (const u of unlocks || []) c[rupeeTier(u)]++;
    return c;
  }

  // Wallet size follows lifetime earned (spending never shrinks it).
  const WALLETS = [
    { name: 'Child', min: 0 },
    { name: 'Adult', min: 500 },
    { name: 'Giant', min: 2500 },
    { name: 'Tycoon', min: 12000 },
  ];
  function walletTier(lifetime) {
    let t = WALLETS[0], i = 0;
    WALLETS.forEach((w, k) => { if (lifetime >= w.min) { t = w; i = k; } });
    const nextW = WALLETS[i + 1] || null;
    return { name: t.name, index: i, next: nextW ? { name: nextW.name, need: nextW.min - lifetime } : null };
  }

  // ─── The shop ────────────────────────────────────────
  const THEMES = { autumn: 'Autumn', lostwoods: 'Lost Woods fog', bloodmoon: 'Blood Moon' };
  const MASKS = {
    majora: { name: "Majora's Mask", mood: 'deep',   hint: 'Sink in: it wants you somewhere deep.' },
    bunny:  { name: 'Bunny Hood',    mood: 'finish', hint: 'Wrap one up: you are fast in this thing.' },
    keaton: { name: 'Keaton Mask',   mood: 'chill',  hint: 'Chill: a fox does not hurry.' },
    moss:   { name: 'Moss Cap',      mood: 'chill',  hint: 'Chill: soft, green and in no rush.' },
    lantern:{ name: 'Lantern Mask',  mood: 'deep',   hint: 'Sink in: a small light for a long night.' },
  };

  // Pixel art for the masks, 12x10 each, original. Rows are strings, palette letters below.
  const MASK_ART = {
    majora: { pal: { Y: '#f2c94c', P: '#7a4fb0', K: '#1b1230', R: '#d23a3a' }, rows: [
      'Y..Y....Y..Y', 'YP.PPPPPP.PY', '.PPPPPPPPPP.', 'PPKKPPPPKKPP', 'PPKYPPPPYKPP',
      'PPPPPPPPPPPP', '.PPPKKKKPPP.', '.PPKRRRRKPP.', '..PPKKKKPP..', '...PPPPPP...'] },
    bunny: { pal: { W: '#f4efe6', P: '#f2a0b4', K: '#2a2a2a' }, rows: [
      '.WW......WW.', 'WPPW....WPPW', 'WPPW....WPPW', '.WPW....WPW.', '..WWWWWWWW..',
      '.WWWWWWWWWW.', '.WWKWWWWKWW.', '.WWWWWWWWWW.', '..WWWPPWWW..', '...WWWWWW...'] },
    keaton: { pal: { O: '#e8782a', W: '#f6f1e4', K: '#2b1b12' }, rows: [
      'O..........O', 'OO........OO', 'OOOO....OOOO', 'OOOOOOOOOOOO', 'OOKOOOOOOKOO',
      'OOOOOOOOOOOO', 'OWWOOOOOOWWO', '.WWWOKKOWWW.', '..WWWKKWWW..', '...WWWWWW...'] },
    moss: { pal: { G: '#4f8f3a', g: '#9bd05a', B: '#c9a46a', K: '#2b2216' }, rows: [
      '....GGGG....', '..GGGggGGG..', '.GGgGGGGgGG.', 'GGGGGGGGGGGG', 'GgGGGGGGGGgG',
      'BBBBBBBBBBBB', '.BBKBBBBKBB.', '.BBBBBBBBBB.', '..BBBBBBBB..', '...BBBBBB...'] },
    lantern: { pal: { D: '#33405c', Y: '#ffd86b', K: '#10141f' }, rows: [
      '.....YY.....', '....YYYY....', '.....KK.....', '..DDDDDDDD..', '.DDDDDDDDDD.',
      'DDYYDDDDYYDD', 'DDYYDDDDYYDD', 'DDDDDDDDDDDD', '.DDDKKKKDDD.', '..DDDDDDDD..'] },
  };
  const PRICES = { maracas: 500, bomb: 50, fairy: 300, mask: 200, majora: 400 };
  const priceOf = (item, meta) => item === 'mask' && meta && meta.mask === 'majora' ? PRICES.majora : PRICES[item];
  const ITEMS = ['maracas', 'bomb', 'fairy', 'mask'];
  const BOMBS_PER_QUARTER = 10;
  const FAIRY_DAYS = 7;
  const REFUND_MS = 24 * 3600 * 1000;

  // A purchase: { id, item, cost, ts (ISO), meta?, refunded?: true, used?: 'YYYY-MM-DD' (fairy) }.
  const live = (state) => ((state && state.purchases) || []).filter(p => !p.refunded);
  const spent = (state) => live(state).reduce((s, p) => s + (p.cost || 0), 0);
  function balance(unlocks, state) { return earned(unlocks) - spent(state); }

  const ownedThemes = (state) => live(state).filter(p => p.item === 'maracas' && p.meta && THEMES[p.meta.theme]).map(p => p.meta.theme);
  const ownedMasks = (state) => live(state).filter(p => p.item === 'mask' && p.meta && MASKS[p.meta.mask]).map(p => p.meta.mask);

  // YYYY-Qn from a date (local fields, so "this quarter" matches the household's calendar).
  function quarterKey(d) { return `${d.getFullYear()}-Q${Math.floor(d.getMonth() / 3) + 1}`; }
  function bombsLeft(state, now) {
    const q = quarterKey(now);
    // A refunded bomb gives its slot back; a bomb that went off is never refunded by the page.
    const used = live(state).filter(p => p.item === 'bomb' && quarterKey(new Date(p.ts)) === q).length;
    return Math.max(0, BOMBS_PER_QUARTER - used);
  }
  const holdsFairy = (state) => live(state).some(p => p.item === 'fairy' && !p.used);

  // Why a purchase can't happen right now, or null when it can. `ctx`: { unlocks, now, game, meta }.
  function whyNot(item, state, ctx) {
    const { unlocks, now, game, meta } = ctx;
    if (!ITEMS.includes(item)) return 'not for sale';
    const cost = priceOf(item, meta);
    if (balance(unlocks, state) < cost) return `needs ${cost} rupees`;
    if (item === 'maracas') {
      if (!meta || !THEMES[meta.theme]) return 'pick a theme';
      if (ownedThemes(state).includes(meta.theme)) return 'already yours';
    }
    if (item === 'mask') {
      if (!meta || !MASKS[meta.mask]) return 'pick a mask';
      if (ownedMasks(state).includes(meta.mask)) return 'already yours';
    }
    if (item === 'fairy' && holdsFairy(state)) return 'you can only hold one fairy';
    if (item === 'bomb') {
      if (!game || game.s !== 'queue') return 'bombs only work on games in Up Next';
      if (bombsLeft(state, now) <= 0) return `no bombs left this quarter (${BOMBS_PER_QUARTER} max)`;
    }
    return null;
  }
  // Refunds: same day (24h) only, never a bomb that already went off, never a fairy already used.
  function canRefund(p, now) {
    if (!p || p.refunded) return false;
    if (p.item === 'bomb' || p.used) return false;
    return now.getTime() - new Date(p.ts).getTime() <= REFUND_MS;
  }

  // ─── Fairy in a bottle ───────────────────────────────
  const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const addDays = (d, n) => { const x = new Date(d.getFullYear(), d.getMonth(), d.getDate() + n); return ymd(x); };
  // Under a fairy's protection until the end of the stored day.
  function fairyActive(state, gameId, now) {
    const u = state && state.fairyUntil && state.fairyUntil[gameId];
    return !!u && u >= ymd(now);
  }
  // The game (if any) the owned fairy should save now: playing, stale and not already covered.
  // `isStale(g)` is the page's own rule (isDormant); the first match wins, one fairy per call.
  function fairyTarget(state, games, isStale, now) {
    if (!holdsFairy(state)) return null;
    return (games || []).find(g => g.s === 'playing' && !fairyActive(state, g.id, now) && isStale(g)) || null;
  }
  const fairyUntilDate = (now) => addDays(now, FAIRY_DAYS);

  // ─── Masks ───────────────────────────────────────────
  // The owl's mood question starts on the mood the worn mask suggests (only a default).
  function owlDefaultMood(worn, moods) {
    const m = MASKS[worn];
    return m && (!moods || moods[m.mood]) ? m.mood : null;
  }

  // ─── Great Fairy ─────────────────────────────────────
  const MASTERED = ['mastered', 'platinum', '100pct'];
  const isMastered = (g) => !!g && MASTERED.includes(g.mastery);
  // `seen`: the stored list of game ids (null = never visited, which seeds silently).
  function newMasteries(seen, games) {
    const ids = (games || []).filter(isMastered).map(g => g.id);
    if (!Array.isArray(seen)) return { next: ids, fresh: [] };
    const fresh = ids.filter(id => !seen.includes(id));
    return { next: seen.concat(fresh), fresh };
  }
  const SEEN_KEY = 'gt_gf_seen';
  function checkMastery(storage, games) {
    let seen = null;
    try { const v = JSON.parse(storage.getItem(SEEN_KEY)); seen = Array.isArray(v) ? v : null; } catch (e) {}
    const r = newMasteries(seen, games);
    try { storage.setItem(SEEN_KEY, JSON.stringify(r.next)); } catch (e) {}
    return r.fresh;
  }

  const api = { MASK_ART, VALUES, TIER_ORDER, WALLETS, THEMES, MASKS, PRICES, ITEMS, BOMBS_PER_QUARTER, FAIRY_DAYS, REFUND_MS, SEEN_KEY, MASTERED,
    rupeeTier, rupeeValue, earned, tierCounts, walletTier, priceOf, spent, balance, ownedThemes, ownedMasks,
    quarterKey, bombsLeft, holdsFairy, whyNot, canRefund, fairyActive, fairyTarget, fairyUntilDate, ymd,
    owlDefaultMood, isMastered, newMasteries, checkMastery };
  root.GTRupees = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
