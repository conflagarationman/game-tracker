import { readFile } from "node:fs/promises";
import vm from "node:vm";
import assert from "node:assert/strict";

const ctx = {};
vm.createContext(ctx);
vm.runInContext(await readFile(new URL("../rupees.js", import.meta.url), "utf8"), ctx);
const R = ctx.GTRupees;

let pass = 0, fail = 0;
const test = async (name, fn) => {
  try { await fn(); pass++; console.log(`PASS  ${name}`); }
  catch (e) { fail++; console.log(`FAIL  ${name}\n        ${e.message}`); }
};
const u = (pct, src = "steam") => ({ src, id: 1, key: "k", ts: 1, name: "n", game: "g", pct });
const P = (id, item, ts, over = {}) => ({ id, item, cost: R.priceOf(item, over.meta), ts, ...over });
const NOW = new Date("2026-10-26T12:00:00");
const iso = (d) => new Date(d).toISOString();
const none = { purchases: [], fairyUntil: {} };

await test("rupee tiers by Steam rarity, with the boundaries on the higher-value side below them", () => {
  const t = (p) => R.rupeeTier(u(p));
  assert.deepEqual([t(100), t(50), t(49.9), t(20), t(19.9), t(5), t(4.9), t(1), t(0.9), t(0)], ["green", "green", "blue", "blue", "red", "red", "silver", "silver", "gold", "gold"]);
});
await test("no pct is green; RA is green whatever it carries", () => {
  assert.equal(R.rupeeTier(u(null)), "green");
  assert.equal(R.rupeeTier(u(undefined)), "green");
  assert.equal(R.rupeeTier(u(0.1, "ra")), "green");
  assert.equal(R.rupeeTier(null), "green");
});
await test("values are one constant: 1 / 5 / 20 / 100 / 300", () => {
  assert.deepEqual({ ...R.VALUES }, { green: 1, blue: 5, red: 20, silver: 100, gold: 300 });
  assert.equal(R.earned([u(80), u(30), u(10), u(2), u(0.5), u(null), u(0.5, "ra")]), 1 + 5 + 20 + 100 + 300 + 1 + 1);
  assert.equal(R.earned(null), 0);
});
await test("the real log earns what we think it does", async () => {
  const log = JSON.parse(await readFile(new URL("../achievements-log.json", import.meta.url), "utf8")).unlocks;
  const e = R.earned(log), c = R.tierCounts(log);
  assert.equal(e, c.green + c.blue * 5 + c.red * 20 + c.silver * 100 + c.gold * 300);
  assert.ok(e > 1000);
});
await test("wallet tiers by lifetime earned: Child, Adult, Giant, Tycoon", () => {
  const n = (x) => R.walletTier(x).name;
  assert.deepEqual([n(0), n(499), n(500), n(2499), n(2500), n(11999), n(12000), n(99999)], ["Child", "Child", "Adult", "Adult", "Giant", "Giant", "Tycoon", "Tycoon"]);
  assert.equal(R.walletTier(2000).next.need, 500 + 0);
  assert.equal(R.walletTier(12000).next, null);
});
await test("balance is earned minus spent; a refund gives it back", () => {
  const log = [u(null), u(null), u(0.5)];                      // 1 + 1 + 300
  const bought = { purchases: [P("a", "fairy", iso(NOW))] };   // 300
  assert.equal(R.balance(log, none), 302);
  assert.equal(R.balance(log, bought), 2);
  const refunded = { purchases: [{ ...bought.purchases[0], refunded: true }] };
  assert.equal(R.balance(log, refunded), 302);
  assert.equal(R.spent(refunded), 0);
});
await test("lifetime earned never shrinks when you spend", () => {
  const log = Array.from({ length: 600 }, () => u(null));
  assert.equal(R.walletTier(R.earned(log)).name, "Adult");
});
await test("can't buy what you can't afford", () => {
  assert.match(R.whyNot("fairy", none, { unlocks: [u(null)], now: NOW }), /needs 300/);
  assert.equal(R.whyNot("fairy", none, { unlocks: [u(0.5, "steam"), u(0.5)], now: NOW }), null);
});
await test("themes and masks: pick one, own it once; Majora's costs more", () => {
  const rich = Array.from({ length: 3000 }, () => u(null));
  const c = (item, meta, st = none) => R.whyNot(item, st, { unlocks: rich, now: NOW, meta });
  assert.match(c("maracas", {}), /pick a theme/);
  assert.equal(c("maracas", { theme: "autumn" }), null);
  assert.match(c("maracas", { theme: "autumn" }, { purchases: [P("a", "maracas", iso(NOW), { meta: { theme: "autumn" } })] }), /already yours/);
  assert.equal(c("mask", { mask: "bunny" }), null);
  assert.equal(R.priceOf("mask", { mask: "majora" }), 400);
  assert.equal(R.priceOf("mask", { mask: "bunny" }), 200);
  assert.equal(R.ownedMasks({ purchases: [P("a", "mask", iso(NOW), { meta: { mask: "keaton" } }), P("b", "mask", iso(NOW), { meta: { mask: "moss" }, refunded: true })] }).join(), "keaton");
});
await test("bomb: queue-only", () => {
  const rich = Array.from({ length: 3000 }, () => u(null));
  const c = (g) => R.whyNot("bomb", none, { unlocks: rich, now: NOW, game: g });
  assert.equal(c({ id: 1, s: "queue" }), null);
  for (const s of ["playing", "soon", "done", "ongoing", "dropped"]) assert.match(c({ id: 1, s }), /only work on games in Up Next/, s);
  assert.match(c(undefined), /only work/);
});
await test("bomb: ten a calendar quarter, resets next quarter, a refund returns the slot", () => {
  const bombs = (n, when) => ({ purchases: Array.from({ length: n }, (_, i) => P(`b${i}`, "bomb", iso(when), { meta: { gameId: i + 1 } })) });
  assert.equal(R.bombsLeft(none, NOW), 10);
  assert.equal(R.bombsLeft(bombs(10, NOW), NOW), 0);
  assert.equal(R.bombsLeft(bombs(9, NOW), NOW), 1);
  assert.equal(R.bombsLeft(bombs(10, new Date("2026-06-30T12:00:00")), NOW), 10, "last quarter's bombs don't count");
  assert.equal(R.quarterKey(new Date(2026, 9, 1)), "2026-Q4");
  assert.equal(R.quarterKey(new Date(2026, 8, 30)), "2026-Q3");
  const rich = Array.from({ length: 3000 }, () => u(null));
  assert.match(R.whyNot("bomb", bombs(10, NOW), { unlocks: rich, now: NOW, game: { id: 1, s: "queue" } }), /no bombs left/);
  const st = bombs(10, NOW); st.purchases[0].refunded = true;
  assert.equal(R.bombsLeft(st, NOW), 1);
});
await test("fairy: hold at most one; a used one frees the slot", () => {
  const rich = Array.from({ length: 3000 }, () => u(null));
  const held = { purchases: [P("f1", "fairy", iso(NOW))] };
  assert.equal(R.holdsFairy(held), true);
  assert.match(R.whyNot("fairy", held, { unlocks: rich, now: NOW }), /only hold one/);
  const used = { purchases: [P("f1", "fairy", iso(NOW), { used: "2026-10-26" })] };
  assert.equal(R.holdsFairy(used), false);
  assert.equal(R.whyNot("fairy", used, { unlocks: rich, now: NOW }), null);
});
await test("fairy: saves the first stale playing game, once, for 7 more days", () => {
  const held = { purchases: [P("f1", "fairy", iso(NOW))], fairyUntil: {} };
  const games = [{ id: 1, s: "queue" }, { id: 2, s: "playing", stale: false }, { id: 3, s: "playing", stale: true }, { id: 4, s: "playing", stale: true }];
  const stale = (g) => !!g.stale;
  assert.equal(R.fairyTarget(held, games, stale, NOW).id, 3);
  assert.equal(R.fairyTarget(none, games, stale, NOW), null, "no fairy, no rescue");
  assert.equal(R.fairyTarget(held, [{ id: 1, s: "queue", stale: true }], stale, NOW), null, "only playing games");
  assert.equal(R.fairyUntilDate(NOW), "2026-11-02");
  const covered = { ...held, fairyUntil: { 3: "2026-11-02" } };
  assert.equal(R.fairyActive(covered, 3, NOW), true);
  assert.equal(R.fairyTarget(covered, games, stale, NOW).id, 4, "a covered game is skipped");
  assert.equal(R.fairyActive({ fairyUntil: { 3: "2026-10-25" } }, 3, NOW), false, "expired cover");
  assert.equal(R.fairyActive({ fairyUntil: { 3: "2026-10-26" } }, 3, NOW), true, "through the last day");
});
await test("refunds: within a day only; never a bomb or a used fairy", () => {
  const p = (item, over = {}) => P("x", item, iso(NOW), over);
  assert.equal(R.canRefund(p("mask", { meta: { mask: "bunny" } }), new Date(NOW.getTime() + 3600e3)), true);
  assert.equal(R.canRefund(p("mask", { meta: { mask: "bunny" } }), new Date(NOW.getTime() + 25 * 3600e3)), false);
  assert.equal(R.canRefund(p("bomb"), NOW), false);
  assert.equal(R.canRefund(p("fairy", { used: "2026-10-26" }), NOW), false);
  assert.equal(R.canRefund(p("fairy", { refunded: true }), NOW), false);
});
await test("mask → owl default mood", () => {
  const moods = { chill: {}, deep: {}, finish: {} };
  assert.equal(R.owlDefaultMood("bunny", moods), "finish");
  assert.equal(R.owlDefaultMood("majora", moods), "deep");
  assert.equal(R.owlDefaultMood("keaton", moods), "chill");
  assert.equal(R.owlDefaultMood(null, moods), null);
  assert.equal(R.owlDefaultMood("nope", moods), null);
  assert.equal(R.owlDefaultMood("bunny", { chill: {} }), null, "a mood the owl doesn't have is no default");
  for (const [k, m] of Object.entries(R.MASKS)) assert.ok(m.name && m.hint && ["chill", "deep", "finish"].includes(m.mood), k);
  assert.ok(Object.keys(R.MASKS).length >= 5);
});
await test("every mask has art: 12x10, and only palette letters", () => {
  for (const id of Object.keys(R.MASKS)) {
    const a = R.MASK_ART[id];
    assert.ok(a, id);
    assert.equal(a.rows.length, 10, id);
    for (const row of a.rows) {
      assert.equal(row.length, 12, `${id}: ${row}`);
      for (const c of row) assert.ok(c === "." || c in a.pal, `${id}: ${c}`);
    }
  }
});
await test("Great Fairy: first visit seeds silently, then only new masteries show once", () => {
  const games = [{ id: 1, mastery: "mastered" }, { id: 2, mastery: "in-progress" }, { id: 3, mastery: null }, { id: 4, mastery: "platinum" }];
  const first = R.newMasteries(null, games);
  assert.equal(JSON.stringify([first.next, first.fresh]), "[[1,4],[]]");
  assert.equal(R.newMasteries(first.next, games).fresh.length, 0);
  const later = games.concat([{ id: 5, mastery: "100pct" }]);
  const r = R.newMasteries(first.next, later);
  assert.equal(JSON.stringify([r.fresh, r.next]), "[[5],[1,4,5]]");
  assert.equal(JSON.stringify(R.newMasteries([1, 4], games.map(g => g.id === 2 ? { ...g, mastery: "mastered" } : g)).fresh), "[2]");
  assert.equal(R.MASTERED.join(), "mastered,platinum,100pct");
});
await test("Great Fairy storage: garbage or blocked storage counts as a first visit", () => {
  const mem = (v) => { const m = new Map(v === undefined ? [] : [[R.SEEN_KEY, v]]); return { m, getItem: k => m.has(k) ? m.get(k) : null, setItem: (k, x) => m.set(k, x) }; };
  const games = [{ id: 1, mastery: "mastered" }];
  const st = mem();
  assert.deepEqual(Array.from(R.checkMastery(st, games)), []);
  assert.equal(st.getItem(R.SEEN_KEY), "[1]");
  assert.deepEqual(Array.from(R.checkMastery(mem("banana"), games)), []);
  assert.deepEqual(Array.from(R.checkMastery(mem("[]"), games)), [1]);
  const bad = { getItem() { throw new Error("x"); }, setItem() { throw new Error("y"); } };
  assert.deepEqual(Array.from(R.checkMastery(bad, games)), []);
});

console.log(`\n${pass}/${pass + fail} passing`);
process.exit(fail ? 1 : 0);
