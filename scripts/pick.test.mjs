// pick.js is a plain browser script (index.html loads it with <script src>), so it's run here
// in a fresh VM context the same way, rather than being reshaped into a module for the test.
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import assert from "node:assert/strict";

const ctx = {};
vm.createContext(ctx);
vm.runInContext(await readFile(new URL("../pick.js", import.meta.url), "utf8"), ctx);
const { pickGames, remaining, devicesWithGames, achLeft } = ctx.GTPick;

let pass = 0, fail = 0;
const test = async (name, fn) => {
  try { await fn(); pass++; console.log(`PASS  ${name}`); }
  catch (e) { fail++; console.log(`FAIL  ${name}\n        ${e.message}`); }
};

const NOW = new Date(2026, 9, 11);
const g = (id, over = {}) => ({ id, t: `Game ${id}`, p: "steam", s: "queue", h: null, actualHours: null,
  lastPlayed: null, release: null, gotm: null, gotmFlair: false, ...over });
// Arrays made inside the VM context fail deepEqual's prototype check, so copy them out.
const titles = (r) => Array.from(r, x => x.g.t);

await test("remaining subtracts real playtime and never reaches zero", () => {
  assert.equal(remaining(g(1, { h: "20h", actualHours: 5 })), 15);
  assert.equal(remaining(g(1, { h: "10-14h" })), 12);
  assert.equal(remaining(g(1, { h: "10h", actualHours: 30 })), 1);
  assert.equal(remaining(g(1, { h: null, actualHours: 3 })), null);
});

await test("only playing/queue are offered by default; someday, done and ongoing stay out", () => {
  const games = [g(1, { s: "soon" }), g(2, { s: "done" }), g(3, { s: "ongoing" }), g(4), g(5, { s: "playing" })];
  assert.deepEqual(titles(pickGames(games, { now: NOW })).sort(), ["Game 4", "Game 5"]);
});

await test("ongoing games are offered for a quick session", () => {
  const games = [g(3, { s: "ongoing", t: "Marvel Snap" }), g(4, { h: "40h" })];
  assert.equal(titles(pickGames(games, { time: "quick", now: NOW }))[0], "Marvel Snap");
});

await test("the device filter is strict: Thor sees AYN and retro only", () => {
  const games = [g(1, { p: "ayn" }), g(2, { p: "retro" }), g(3, { p: "switch2" }), g(4, { p: "steam" })];
  assert.deepEqual(titles(pickGames(games, { device: "thor", now: NOW })).sort(), ["Game 1", "Game 2"]);
});

await test("unreleased games are never suggested", () => {
  const games = [g(1, { release: "2026-11-05" }), g(2, { release: "2026-10-11" })];
  assert.deepEqual(titles(pickGames(games, { now: NOW })), ["Game 2"]);
});

await test("a game you could finish tonight beats a long one ahead of it in the queue", () => {
  const games = [g(1, { h: "50h" }), g(2, { h: "3h", actualHours: 1 })];
  const r = pickGames(games, { time: "evening", now: NOW });
  assert.equal(r[0].g.t, "Game 2");
  assert.match(r[0].reasons[0], /Could finish it \(~2h left\)/);
});

await test("Up Next order still matters when nothing else separates two games", () => {
  const games = [g(1, { h: "40h" }), g(2, { h: "40h" })];
  assert.deepEqual(titles(pickGames(games, { now: NOW })), ["Game 1", "Game 2"]);
});

await test("an expiring GOTM pick pulls a Someday game in and to the top", () => {
  const gotm = { picks: [{ tag: "Nov 2025", monthsLeft: 1, retired: false }] };
  const games = [g(1, { s: "playing" }), g(2, { s: "soon", gotm: "Nov 2025", t: "Club pick" })];
  const r = pickGames(games, { gotm, now: NOW });
  assert.equal(r[0].g.t, "Club pick");
  assert.equal(r[0].reasons[0], "GOTM: last month to claim");
});

await test("a claimed (flaired) or retired pick is not a reason", () => {
  const gotm = { picks: [{ tag: "Nov 2025", monthsLeft: 1, retired: false }, { tag: "Oct 2025", monthsLeft: 0, retired: true }] };
  const games = [g(1, { s: "soon", gotm: "Nov 2025", gotmFlair: true }), g(2, { s: "soon", gotm: "Oct 2025" })];
  assert.equal(pickGames(games, { gotm, now: NOW }).length, 0);
});

await test("recent real play counts, even for a game not marked playing", () => {
  const play = { windowDays: 14, recent: { 2: { mins: 600 } } };
  const games = [g(1, { s: "playing" }), g(2, { t: "Secretly playing" })];
  const r = pickGames(games, { play, now: NOW });
  assert.equal(r[0].g.t, "Secretly playing");
  assert.ok(r[0].reasons.includes("10h in the last 14 days"));
});

await test("a quick session doesn't suggest starting a big new game over one in progress", () => {
  const games = [g(1, { h: "60h" }), g(2, { s: "playing", h: "40h", actualHours: 10 })];
  assert.equal(titles(pickGames(games, { time: "quick", now: NOW }))[0], "Game 2");
});

await test("a long-dormant Now Playing game says so instead of 'in progress'", () => {
  const r = pickGames([g(1, { s: "playing", lastPlayed: "2026-08-01" })], { now: NOW });
  assert.match(r[0].reasons.join(" "), /Dormant 71 days/);
});

await test("device chips only list devices that have something to play", () => {
  const games = [g(1, { p: "ayn" }), g(2, { p: "ps5", s: "done" })];
  assert.deepEqual(Array.from(devicesWithGames(games)), ["any", "thor"]);
});

await test("the real games.json produces suggestions for every time, device and mood it lists", async () => {
  const games = JSON.parse(await readFile(new URL("../games.json", import.meta.url), "utf8"));
  for (const device of devicesWithGames(games))
    for (const time of ["quick", "evening", "long"])
      for (const mood of [undefined, "chill", "deep", "finish"]) {
        const r = pickGames(games, { device, time, mood, now: NOW });
        assert.ok(r.length > 0, `${device}/${time}/${mood} produced nothing`);
        r.forEach(x => assert.ok(x.reasons.length > 0, `${x.g.t} has no reason`));
      }
});

await test("being a few achievements from 100% is a reason; casual and unstarted games aren't", () => {
  assert.equal(achLeft(g(1, { achCount: [27, 30] })), 3);
  assert.equal(achLeft(g(1, { achCount: [27, 30], casual: true })), null);
  assert.equal(achLeft(g(1, { achCount: [0, 3] })), null);
  assert.equal(achLeft(g(1, { achCount: [10, 30] })), null);
  assert.equal(achLeft(g(1, { achCount: [30, 30] })), null);
  const r = pickGames([g(1, { s: "playing", achCount: [29, 30] })], { now: NOW });
  assert.ok(r[0].reasons.includes("1 achievement from 100%"));
});

await test("chill mood steers away from soulslikes and lets Ongoing in at any length", () => {
  const games = [g(1, { s: "playing", g: "Soulslike" }), g(2, { s: "playing", g: "Puzzle" }), g(3, { s: "ongoing", g: "CCG", t: "Snap" })];
  const r = titles(pickGames(games, { mood: "chill", time: "evening", now: NOW }));
  assert.ok(r.includes("Snap"));
  assert.equal(r[r.length - 1], "Game 1");
});

await test("finish mood prefers what's nearly done over the top of Up Next", () => {
  const games = [g(1, { h: "30h" }), g(2, { s: "playing", h: "12h", actualHours: 9 })];
  assert.equal(titles(pickGames(games, { mood: "finish", time: "quick", now: NOW }))[0], "Game 2");
});

await test("deep mood prefers a long game over a short one", () => {
  const games = [g(1, { s: "playing", h: "4h" }), g(2, { s: "playing", h: "60h", g: "RPG" })];
  assert.equal(titles(pickGames(games, { mood: "deep", time: "long", now: NOW }))[0], "Game 2");
});

console.log(`\n${pass}/${pass + fail} passing`);
process.exit(fail ? 1 : 0);
