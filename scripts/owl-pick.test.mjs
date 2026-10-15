import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { loadPicker, owlPick, refreshGotm, weekendPick, isoWeek, seeded } from "./owl-pick.mjs";

const GTPick = await loadPicker(await readFile(new URL("../pick.js", import.meta.url), "utf8"));

let pass = 0, fail = 0;
const test = async (name, fn) => {
  try { await fn(); pass++; console.log(`PASS  ${name}`); }
  catch (e) { fail++; console.log(`FAIL  ${name}\n        ${e.message}`); }
};

const NOW = new Date(2026, 9, 14);
const g = (id, over = {}) => ({ id, t: `Game ${id}`, p: "steam", s: "queue", h: null, actualHours: null,
  lastPlayed: null, release: null, gotm: null, gotmFlair: false, ...over });

await test("writes the same top pick the tracker's picker shows for an evening on any device", () => {
  const games = [g(1, { h: "50h" }), g(2, { h: "3h", actualHours: 1, p: "ayn" })];
  const out = owlPick(GTPick, games, { now: NOW });
  const page = GTPick.pickGames(games, { time: "evening", device: "any", now: NOW, limit: 1 })[0];
  assert.equal(out.pick.id, page.g.id);
  assert.deepEqual(out.pick.reasons, Array.from(page.reasons));
  assert.equal(out.pick.p, "ayn");
  assert.equal(out.generated, "2026-10-14");
});

await test("an empty backlog is a null pick, not a missing file", () => {
  assert.equal(owlPick(GTPick, [g(1, { s: "done" })], { now: NOW }).pick, null);
});

await test("club deadlines are recomputed from today, not taken from gotm.json's snapshot", () => {
  const gotm = { picks: [{ month: "2025-11", tag: "Nov 2025", monthsLeft: 9, retired: false }] };
  assert.equal(refreshGotm(gotm, NOW).picks[0].monthsLeft, 1);
  const out = owlPick(GTPick, [g(1, { s: "playing" }), g(2, { s: "soon", gotm: "Nov 2025" })], { gotm, now: NOW });
  assert.equal(out.pick.id, 2);
});

await test("the real games.json yields a pick with reasons", async () => {
  const games = JSON.parse(await readFile(new URL("../games.json", import.meta.url), "utf8"));
  const out = owlPick(GTPick, games, { now: NOW });
  assert.ok(out.pick && out.pick.t && out.pick.reasons.length > 0);
});

// ─── The weekend pick ──────────────────────────────────
const FRI = new Date(2026, 9, 16, 12), SAT = new Date(2026, 9, 17, 12), MON = new Date(2026, 9, 19, 12);
const canon = [{ t: "Contra III", c: "SNES", y: 1992, g: "Run and Gun", h: "2h", why: "x" },
               { t: "Chrono Trigger", c: "SNES", y: 1995, g: "RPG", h: "25h", why: "y" }];
const keyOf = (games, src, now, previous = null) => (weekendPick(GTPick, games, { src, now, previous }) || {}).key;

await test("ISO weeks: Wednesday 14 Oct 2026 is W42, and the year boundary follows Thursday", () => {
  assert.equal(isoWeek(new Date(2026, 9, 14)), "2026-W42");
  assert.equal(isoWeek(new Date(2026, 0, 1)), "2026-W01");
  assert.equal(isoWeek(new Date(2027, 0, 1)), "2026-W53");
  assert.equal(isoWeek(new Date(2026, 9, 18)), "2026-W42");     // Sunday still belongs to the week
  assert.equal(isoWeek(new Date(2026, 9, 19)), "2026-W43");
});

await test("the same seed always shuffles the same way", () => {
  const a = seeded("2026-W42"), b = seeded("2026-W42");
  assert.deepEqual([a(), a(), a()], [b(), b(), b()]);
  assert.notEqual(seeded("2026-W42")(), seeded("2026-W43")());
});

await test("the weekend pick is the same all week, whatever the day, and carries a key the owl page can open", () => {
  const games = [1, 2, 3, 4].map(i => g(i, { h: "40h" }));
  const picks = [FRI, SAT, MON].map(d => weekendPick(GTPick, games, { src: { canon }, now: d }));
  assert.equal(picks[0].week, "2026-W42");
  assert.equal(picks[0].key, picks[1].key);
  assert.ok(/^(id:\d+|canon:.+)$/.test(picks[0].key));
  assert.ok(picks[0].t && picks[0].reasons.length > 0);
  assert.equal(picks[2].week, "2026-W43");
});

await test("wildcards can be the weekend pick (here the only thing to suggest)", () => {
  const p = weekendPick(GTPick, [], { src: { canon }, now: FRI });
  assert.ok(p.key.startsWith("canon:"), p.key);
});

await test("snoozed and struck-off games are never the weekend pick", () => {
  const skips = {};
  const seen = new Set();
  for (let i = 0; i < 3; i++) {
    const k = keyOf([], { canon, skips }, FRI);
    if (k) { seen.add(k); skips[k] = { t: "x", count: 4, until: null, dropped: true, last: "2026-10-01" }; }
  }
  assert.deepEqual([...seen].sort(), ["canon:chrono trigger", "canon:contra iii"]);
  assert.equal(keyOf([], { canon, skips }, FRI), undefined, "nothing left means a null pick, not a hidden game");
  assert.equal(weekendPick(GTPick, [], { src: { canon, skips }, now: FRI }), null);
});

await test("Friday to Sunday keeps last run's pick while it stands; Monday to Thursday and a hidden pick redraw", () => {
  const games = [1, 2, 3, 4].map(i => g(i, { h: "40h" }));
  const mine = { key: "canon:chrono trigger", t: "Chrono Trigger", p: "retro", reasons: ["old"], week: "2026-W42" };
  assert.equal(keyOf(games, { canon }, SAT, mine), "canon:chrono trigger");
  assert.equal(keyOf(games, { canon }, FRI, mine), "canon:chrono trigger");
  // Its reasons come from today's data, not the old file.
  assert.notDeepEqual(weekendPick(GTPick, games, { src: { canon }, now: SAT, previous: mine }).reasons, ["old"]);
  const skips = { "canon:chrono trigger": { t: "x", count: 1, until: "2026-12-01", dropped: false, last: "2026-10-16" } };
  assert.notEqual(keyOf(games, { canon, skips }, SAT, mine), "canon:chrono trigger", "a snoozed pick is dropped");
  assert.notEqual(keyOf(games, { canon }, SAT, { ...mine, key: "id:999" }), "id:999", "a game that's gone is dropped");
  const wed = new Date(2026, 9, 14, 12);
  assert.equal(keyOf(games, { canon }, wed, mine), keyOf(games, { canon }, wed), "midweek ignores the old pick");
  assert.notEqual(weekendPick(GTPick, games, { src: { canon }, now: MON, previous: mine }).week, "2026-W42");
});

await test("the page can find the pick by its key, and not just in today's lineup", () => {
  const games = [1, 2, 3].map(i => g(i, { h: "40h" }));
  const e = GTPick.owlFind(games, { canon }, "canon:contra iii");
  assert.equal(e.t, "Contra III");
  assert.equal(GTPick.owlFind(games, { canon }, "id:2").t, "Game 2");
  assert.equal(GTPick.owlFind(games, { canon }, "id:77"), null);
});

await test("owlPick's own `pick` is untouched by the weekend work", () => {
  const out = owlPick(GTPick, [g(1, { h: "50h" })], { now: NOW });
  assert.deepEqual(Object.keys(out).sort(), ["generated", "pick"]);
});

console.log(`\n${pass}/${pass + fail} passing`);
process.exit(fail ? 1 : 0);
