// wrapped-stats.js is a plain browser script (wrapped.html loads it with <script src>), so it
// runs here in a VM context the same way pick.js's test does.
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import assert from "node:assert/strict";

const ctx = {};
vm.createContext(ctx);
vm.runInContext(await readFile(new URL("../wrapped-stats.js", import.meta.url), "utf8"), ctx);
const { yearStats } = ctx.GTWrapped;

let pass = 0, fail = 0;
const test = async (name, fn) => {
  try { await fn(); pass++; console.log(`PASS  ${name}`); }
  catch (e) { fail++; console.log(`FAIL  ${name}\n        ${e.message}`); }
};
const plain = (x) => JSON.parse(JSON.stringify(x));   // VM-context arrays fail deepEqual otherwise
const NOW = new Date(2026, 9, 11);
let id = 0;
const g = (over = {}) => ({ id: ++id, t: `Game ${id}`, p: "steam", s: "done", g: "Action", y: 2020, h: "10h", r: 0,
  cy: 2026, cm: 0, gotm: null, gotmFlair: false, mastery: null, achPct: null, achCount: null, actualHours: null, casual: false, ...over });

await test("hours share uses real playtime first, the estimate otherwise", () => {
  const s = yearStats([g({ t: "Big", actualHours: 30 }), g({ t: "Small", h: "10h" })], 2026, NOW);
  assert.deepEqual(plain(s.hoursShare.map(x => [x.g.t, Math.round(x.pct), x.real])), [["Big", 75, true], ["Small", 25, false]]);
});

await test("eras split new / recent / classic at eight years back, by hours", () => {
  const s = yearStats([g({ y: 2026, h: "10h" }), g({ y: 2018, h: "30h" }), g({ y: 2017, h: "60h" }), g({ y: null })], 2026, NOW);
  assert.equal(s.cutoff, 2018);
  assert.deepEqual([s.eras.new.n, s.eras.recent.n, s.eras.classic.n], [1, 1, 1]);
  assert.deepEqual([s.eras.new.pct, s.eras.recent.pct, s.eras.classic.pct].map(Math.round), [10, 30, 60]);
  assert.deepEqual(plain(s.launchYear.map(x => x.y)), [2026]);
});

await test("each month gets its standout: best rating, then most hours", () => {
  const s = yearStats([g({ cm: 2, t: "Fine", r: 7, h: "40h" }), g({ cm: 2, t: "Great", r: 9, h: "5h" }), g({ cm: 2, t: "Great but long", r: 9, h: "20h" })], 2026, NOW);
  assert.equal(s.months[2].n, 3);
  assert.equal(s.months[2].top.t, "Great but long");
  assert.equal(s.months[3].top, null);
});

await test("the streak is the longest run of consecutive months with a finish", () => {
  const s = yearStats([0, 1, 3, 4, 5, 7].map(cm => g({ cm })), 2026, NOW);
  assert.deepEqual(plain(s.streak), { len: 3, from: 3, to: 5 });
});

await test("months after this one are marked future in the current year only", () => {
  assert.equal(yearStats([g()], 2026, NOW).months[10].future, true);
  assert.equal(yearStats([g({ cy: 2025 })], 2025, NOW).months[10].future, false);
});

await test("device split groups handhelds, Switch, and desk & TV by hours", () => {
  const s = yearStats([g({ p: "ayn", h: "30h" }), g({ p: "switch2", h: "10h" }), g({ p: "ps5", h: "60h" })], 2026, NOW);
  assert.deepEqual(plain(s.deviceSplit.map(d => [d.k, Math.round(d.pct)])), [["desk", 60], ["handheld", 30], ["hybrid", 10]]);
});

await test("achievements skip casual games; perfect means mastered/platinum/100%", () => {
  const s = yearStats([g({ achCount: [10, 20], achPct: 50 }), g({ achCount: [5, 5], achPct: 100 }), g({ achCount: [99, 99], achPct: 100, casual: true }),
    g({ mastery: "mastered" }), g({ mastery: "in-progress" })], 2026, NOW);
  assert.deepEqual(plain(s.achievements), { earned: 15, games: 2, avgPct: 75 });
  assert.equal(s.perfect.length, 3);
});

await test("you vs you compares with the closest earlier year that has finishes", () => {
  const games = [g({ cy: 2024, r: 6 }), g({ cy: 2024, r: 8 }), g({ r: 9 }), g({ r: 9 }), g({ r: 9 })];
  const s = yearStats(games, 2026, NOW);
  assert.deepEqual(plain(s.vsPrev), { year: 2024, done: 1, hours: 10, avg: 2 });
  assert.equal(s.bestYear, true);
  assert.equal(yearStats(games, 2024, NOW).vsPrev, null);
});

await test("game of the year is the top rating, ties broken by hours", () => {
  const s = yearStats([g({ t: "A", r: 10, h: "5h" }), g({ t: "B", r: 10, h: "50h" }), g({ t: "C", r: 8, h: "90h" })], 2026, NOW);
  assert.equal(s.goty.t, "B");
});

await test("persona: the strongest trait wins and says why", () => {
  const classics = [1990, 1991, 1995, 1998].map(y => g({ y, p: "ps5" }));
  const p = yearStats(classics, 2026, NOW).persona;
  assert.equal(p.title, "The Archaeologist");
  assert.equal(p.line, "4 of 4 finishes came out before 2018");
  const perfect = [1, 2, 3, 4].map(() => g({ mastery: "100pct", y: 2022, p: "ps5", h: "8h" }));
  assert.equal(yearStats(perfect, 2026, NOW).persona.title, "The Completionist");
});

await test("persona needs at least three finishes, and falls back to The Explorer", () => {
  assert.equal(yearStats([g(), g()], 2026, NOW).persona, null);
  const p = yearStats([g({ y: 2022, g: "RPG", h: "10h" }), g({ y: 2022, g: "Puzzle", h: "10h" }), g({ y: 2021, g: "RPG", h: "10h" })], 2026, NOW).persona;
  assert.deepEqual(plain(p), { title: "The Explorer", line: "3 games across 2 genres", also: null });
});

await test("the real games.json produces a full review for every year it has", async () => {
  const games = JSON.parse(await readFile(new URL("../games.json", import.meta.url), "utf8"));
  for (const y of new Set(games.filter(x => x.cy).map(x => x.cy))) {
    const s = yearStats(games, y, NOW);
    assert.ok(s.months.length === 12 && s.streak.len >= (s.done.some(x => x.cm != null) ? 1 : 0), `${y} months/streak`);
    if (s.done.length >= 3) assert.ok(s.persona && s.persona.line, `${y} has no persona`);
  }
});

console.log(`\n${pass}/${pass + fail} passing`);
process.exit(fail ? 1 : 0);
