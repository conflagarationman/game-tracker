// The rupee wallet and the Great Fairy's seen-set. Pure and DOM-free so it runs in Node too
// (scripts/rupees.test.mjs); index.html loads it as a plain script and reads globalThis.GTRupees.
//
// Rupees are only a lifetime score now: every unlock in achievements-log.json is worth rupees by
// rarity (nothing is for sale; the shop, masks, bombs and fairy in a bottle were cut). Steam's
// global unlock % sets the colour: green >=50 = 1, blue 20-50 = 5, red 5-20 = 20, silver 1-5 = 100,
// gold <1 = 300; no pct, and every RetroAchievements unlock, is green. Wallet tiers (Child, Adult,
// Giant, Tycoon) follow lifetime earned. The Great Fairy scene plays the first time a game's
// mastery becomes mastered/platinum/100pct (seen-set in localStorage `gt_gf_seen`, seeded silently
// on a first visit); mastered cards always carry a gold frame.
// rupees.json in the repo is a leftover of the shop: nothing reads or writes it.
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

  // Wallet size follows lifetime earned.
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

  const api = { VALUES, TIER_ORDER, WALLETS, SEEN_KEY, MASTERED,
    rupeeTier, rupeeValue, earned, tierCounts, walletTier, isMastered, newMasteries, checkMastery };
  root.GTRupees = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
