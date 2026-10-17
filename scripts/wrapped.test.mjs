// wrapped-stats.js is a plain browser script (wrapped.html loads it with <script src>), so it
// runs here in a VM context the same way pick.js's test does.
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import assert from "node:assert/strict";

const ctx = {};
vm.createContext(ctx);
vm.runInContext(await readFile(new URL("../wrapped-stats.js", import.meta.url), "utf8"), ctx);
const { yearStats, posterStats, layoutPoster, POSTER } = ctx.GTWrapped;

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

await test("idle games count as finished but are left out of every hours figure", () => {
  const s = yearStats([g({ t: "Duck", g: "Idle", actualHours: 44 }), g({ t: "Real", actualHours: 10 })], 2026, NOW);
  assert.equal(s.done.length, 2);
  assert.equal(s.totalH, 10);
  assert.deepEqual(plain(s.hoursShare.map(x => x.g.t)), ["Real"]);
  assert.deepEqual(plain(s.idleGames.map(x => x.t)), ["Duck"]);
  assert.equal(yearStats([g({ g: "Idle Clicker" })], 2026, NOW).idleGames.length, 1);
  assert.equal(yearStats([g({ g: "Incremental" })], 2026, NOW).idleGames.length, 0, "only an explicit Idle tag");
});

await test("card farming for the year comes from asf-idle.json", () => {
  const asf = { coverageFrom: "2026-07-14", years: { 2026: { hours: 46.5, gameCount: 12, finished: 8, games: [] } } };
  const s = yearStats([g()], 2026, NOW, asf);
  assert.equal(s.asf.hours, 46.5);
  assert.equal(s.asf.coverageFrom, "2026-07-14");
  assert.equal(yearStats([g({ cy: 2025 })], 2025, NOW, asf).asf, null);
  assert.equal(yearStats([g()], 2026, NOW).asf, null);
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

// ─── Year of Play poster ───
const rects = (l) => [...l.carts, ...(l.goty ? [l.goty] : [])];

await test("poster: Game of the Year is the highest rating, ties go to the most hours", () => {
  const p = posterStats([g({ t: "Nine Short", r: 9, h: "5h" }), g({ t: "Nine Long", r: 9, h: "40h" }), g({ t: "Eight", r: 8, h: "90h" })], 2026);
  assert.equal(p.goty.t, "Nine Long");
  assert.equal(rects(p.layout).length, 3);
  const real = posterStats([g({ t: "Est", r: 9, h: "50h" }), g({ t: "Played", r: 9, h: "5h", actualHours: 120 })], 2026);
  assert.equal(real.goty.t, "Played", "actualHours outranks the HLTB estimate");
});

await test("poster: Idle-genre games, other years and unfinished games are left off", () => {
  const p = posterStats([g({ t: "Keep" }), g({ t: "Clicker", g: "Idle", r: 10 }), g({ t: "Old", cy: 2025 }), g({ t: "Playing", s: "playing", cy: null })], 2026);
  assert.deepEqual(plain(rects(p.layout).map(c => c.g.t)), ["Keep"]);
  assert.equal(p.games, 1);
  assert.equal(p.goty, null, "an Idle game never wins Game of the Year");
});

await test("poster: carts grow with hours, using real playtime before the estimate", () => {
  const p = posterStats([g({ t: "Tiny", h: "1h" }), g({ t: "Mid", h: "20h" }), g({ t: "Huge", h: "9h", actualHours: 200 })], 2026);
  const w = Object.fromEntries(rects(p.layout).map(c => [c.g.t, c.w]));
  assert.ok(w.Tiny < w.Mid && w.Mid < w.Huge, JSON.stringify(w));
});

await test("poster: the winner sits dead centre and every cart stays on the sheet without overlapping", () => {
  for (const n of [0, 1, 7, 42, 160]) {
    const gs = Array.from({ length: n }, (_, i) => g({ t: `G${i}`, r: i % 10 + 1, h: `${i % 40 + 1}h`, cm: i % 12 }));
    const l = posterStats(gs, 2026).layout, all = rects(l);
    assert.equal(all.length, n);
    if (n) assert.equal(l.goty.x + l.goty.w / 2, POSTER.W / 2, `${n}: goty centred`);
    for (const c of all) assert.ok(c.x >= 0 && c.x + c.w <= POSTER.W && c.y >= POSTER.SHELF_TOP - 1 && c.y + c.h <= POSTER.SHELF_BOTTOM + 1, `${n}: ${c.g.t} off the shelf area`);
    for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) {
      const a = all[i], b = all[j];
      assert.ok(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y, `${n}: ${a.g.t} overlaps ${b.g.t}`);
    }
  }
});

await test("poster: footer numbers are the year's games, hours, top platform and longest streak", () => {
  const p = posterStats([g({ p: "switch", cm: 0, h: "10h" }), g({ p: "switch", cm: 1, h: "20h" }), g({ p: "steam", cm: 2, h: "30h" }),
    g({ p: "steam", cm: 5, h: "1h" }), g({ p: "steam", cm: 5, g: "Idle" })], 2026);
  assert.equal(p.games, 4);                                   // the Idle game is off the shelf
  assert.equal(p.hours, 61);
  assert.equal(p.topPlatform.p, "steam");                     // 2 vs 2 games: steam has 31h, switch 30h
  assert.equal(p.streak, 3);                                  // Jan, Feb, Mar
  const tie = posterStats([g({ p: "ps5", h: "5h" }), g({ p: "steam", h: "50h" })], 2026);
  assert.equal(tie.topPlatform.p, "steam", "a tied platform count goes to the most hours");
});

await test("poster: the real games.json lays out for every year", async () => {
  const games = JSON.parse(await readFile(new URL("../games.json", import.meta.url), "utf8"));
  for (const y of new Set(games.filter(x => x.cy).map(x => x.cy))) {
    const p = posterStats(games, y);
    assert.equal(rects(p.layout).length, p.games, `${y}`);
  }
});

// ─── Ledgers ──────────────────────────────────────────────
const { playedHours, unlockStats, backlogMath, etParts } = ctx.GTWrapped;
const ts = (iso) => Date.parse(iso) / 1000;

await test("playedHours counts only rises above a game's previous high, by month", () => {
  const games = [g({ id: 901, t: "Steep", s: "playing" }), g({ id: 902, t: "Old", s: "done" })];
  const ledger = { since: "2026-07-28", days: {
    "2026-07-28": { 901: 1, 902: 5 },
    "2026-08-02": { 901: 3, 902: 5 },      // +2 in Aug
    "2026-09-01": { 901: 2, 902: 5 },      // a dip (farming freeze / definition change): nothing
    "2026-09-05": { 901: 2.5, 902: 6 },    // back under the high for Steep: nothing; Old +1 in Sep
    "2026-10-01": { 901: 4, 902: 6 },      // Steep +1 above its high of 3
  } };
  const p = playedHours(ledger, games, 2026);
  assert.deepEqual(plain(p.games.map(x => [x.g.t, x.hours])), [["Steep", 3], ["Old", 1]]);
  assert.equal(p.total, 4);
  assert.deepEqual(plain(p.months.slice(7, 10)), [2, 1, 1]);
  assert.equal(p.since, "2026-07-28");
});

await test("playedHours credits a baseline only for a game released this year, and skips idle games", () => {
  const games = [g({ id: 911, t: "Halo", y: 2026, start: "2026-07-28" }), g({ id: 912, t: "Palworld replay", y: 2024, start: "2026-07-11" }),
    g({ id: 913, t: "Pet", g: "Idle sim", y: 2026, start: "2026-07-01" })];
  const ledger = { since: "2026-07-28", days: { "2026-07-28": { 911: 5.8, 912: 40, 913: 100 }, "2026-08-16": { 911: 34.2, 912: 40, 913: 300 } } };
  const p = playedHours(ledger, games, 2026);
  assert.deepEqual(plain(p.games.map(x => [x.g.t, x.hours, x.fromStart])), [["Halo", 34.2, true]]);
  assert.equal(p.untimed, 5.8);
  assert.equal(p.months[7], 28.4);
});

await test("playedHours keeps last year's high as the baseline for the next year", () => {
  const games = [g({ id: 921, t: "Long" })];
  const ledger = { since: "2026-12-30", days: { "2026-12-30": { 921: 10 }, "2026-12-31": { 921: 12 }, "2027-01-02": { 921: 15 } } };
  assert.equal(playedHours(ledger, games, 2026).total, 2);
  assert.equal(playedHours(ledger, games, 2027).total, 3);
  assert.equal(playedHours(ledger, games, 2027).since, null);
  assert.equal(playedHours(null, games, 2026), null);
});

await test("etParts buckets unlocks in Eastern time, across DST", () => {
  assert.deepEqual(plain(etParts(ts("2027-01-01T03:30:00Z"))), { date: "2026-12-31", hour: 22, dow: "Thu" });
  assert.equal(etParts(ts("2026-07-04T04:00:00Z")).hour, 0);    // EDT
  assert.equal(etParts(ts("2026-12-04T04:00:00Z")).hour, 23);   // EST
});

await test("unlockStats: night share, peak hour, busiest day, streak and rarest, in Eastern days", () => {
  const u = (iso, game, pct = null, src = "steam") => ({ src, ts: ts(iso), game, name: "a", pct, key: iso + game });
  const rows = [
    u("2026-03-01T03:00:00Z", "A", 12.5),          // Feb 28, 10 PM ET (night)
    u("2026-03-02T15:00:00Z", "A", 2.1),           // Mar 2, 10 AM
    u("2026-03-02T16:00:00Z", "B", 0.4),           // Mar 2, 11 AM: rarest
    u("2026-03-03T18:00:00Z", "B"),                // Mar 3
    u("2026-03-05T05:30:00Z", "B", null, "ra"),    // Mar 5, 12:30 AM (night)
    u("2025-12-31T12:00:00Z", "Old", 0.1),         // another year
  ];
  const s = unlockStats(rows, 2026);
  assert.equal(s.count, 5);
  assert.equal(s.games, 2);
  assert.equal(s.nightPct, 40);
  assert.deepEqual(plain(s.busiest), { date: "2026-03-02", n: 2, game: "A" });
  assert.deepEqual(plain(s.streak), { len: 2, from: "2026-03-02", to: "2026-03-03" });
  assert.equal(s.rarest.pct, 0.4);
  assert.deepEqual([s.steam, s.ra], [4, 1]);
  assert.equal(s.first.date, "2026-02-28");
  assert.equal(unlockStats([], 2026), null);
});

await test("backlogMath compares games added with games finished or dropped", () => {
  const games = [g({ queued: "2026-02-01", s: "queue", cy: null }), g({ queued: "2026-03-01", s: "soon", cy: null }),
    g({ queued: "2026-04-01", s: "done", cy: 2026, start: "2026-04-02" }), g({ queued: "2025-01-01", s: "dropped", cy: 2026 })];
  assert.deepEqual(plain(backlogMath(games, 2026)), { added: 3, imported: 0, started: 1, finished: 1, dropped: 1, net: 1, waiting: 2 });
});

await test("yearStats carries the ledger numbers, and the persona can be a night owl", () => {
  const games = Array.from({ length: 4 }, () => g({ cy: 2026 }));
  const unlocks = Array.from({ length: 40 }, (_, i) => ({ src: "steam", ts: ts("2026-05-01T04:00:00Z") + i * 86400, game: "X", pct: null, key: "k" + i }));
  const s = yearStats(games, 2026, NOW, null, { unlocks, ledger: { days: {} } });
  assert.equal(s.unlocks.nightPct, 100);
  assert.equal(s.persona.title, "The Night Owl");
  assert.equal(s.played.total, 0);
  assert.equal(yearStats(games, 2026, NOW).unlocks, null);
});


await test("backlogMath counts a day the tracker was filled in as imported, not added", () => {
  const games = [...Array.from({ length: 15 }, () => g({ queued: "2026-06-16", s: "soon", cy: null })), g({ queued: "2026-08-01", s: "queue", cy: null })];
  const b = backlogMath(games, 2026);
  assert.deepEqual([b.added, b.imported, b.waiting], [1, 15, 1]);
});


await test("replays count like any other game and are listed for the page to label", () => {
  const games = [g({ id: 931, t: "Palworld", replay: true, y: 2024, actualHours: 107 }), g({ id: 932, t: "New one", y: 2026 })];
  const s = yearStats(games, 2026, NOW, null, { ledger: { since: "2026-07-28", days: { "2026-07-28": { 931: 106 }, "2026-08-01": { 931: 107 } } } });
  assert.equal(s.done.length, 2);
  assert.deepEqual(plain(s.replays.map(x => x.t)), ["Palworld"]);
  assert.deepEqual(plain(s.played.games.map(x => [x.g.t, x.hours, x.replay])), [["Palworld", 1, true]]);
});

console.log(`\n${pass}/${pass + fail} passing`);
process.exit(fail ? 1 : 0);
