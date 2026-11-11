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
