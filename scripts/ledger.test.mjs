// ledger.json and achievements-log.json: the backfill's idle correction, the daily append, the
// unlock merge, and the sync's two new calls against stubbed Steam/RA responses.
import assert from "node:assert/strict";
import { buildLedgerFromHistory, appendLedgerDay, formatLedger, idleThrough, steamUnlockRows, raTimestamp,
  raUnlockRows, mergeUnlocks, raWindowStart, formatUnlocks, RAW_UNTIL } from "./ledger.mjs";
import { syncSteam, syncRaUnlocks, fillGlobalPcts } from "./sync-apis.mjs";

process.env.STEAM_API_KEY = "fake";
process.env.STEAM_ID = "76561198000000000";
process.env.RA_USER = "tester";
process.env.RA_API_KEY = "fake";

let pass = 0, fail = 0;
const test = async (name, fn) => {
  try { await fn(); pass++; console.log(`PASS  ${name}`); }
  catch (e) { fail++; console.log(`FAIL  ${name}\n        ${e.message}`); }
};
const json = (body) => new Response(JSON.stringify(body), { status: 200 });

await test("idleThrough sums the minutes idled up to and including a day, in hours", () => {
  const f = idleThrough({ 10: { days: { "2026-09-01": 60, "2026-09-03": 30 } } }, 10);
  assert.equal(f("2026-08-31"), 0);
  assert.equal(f("2026-09-01"), 1);
  assert.equal(f("2026-09-05"), 1.5);
  assert.equal(idleThrough({}, 99)("2026-09-05"), 0);
});

await test("backfill takes idling out of raw-era snapshots only, and skips null hours", () => {
  const farmApps = { 500: { days: { "2026-09-25": 456 } } };   // 7.6h idled on 9/25
  const g = (h) => [{ id: 1, actualHours: h }, { id: 2, actualHours: 3 }, { id: 3, actualHours: null }];
  const led = buildLedgerFromHistory([
    { date: "2026-09-24", games: g(0.1) },
    { date: "2026-09-26", games: g(7.7) },     // raw: real 0.1h + 7.6h idling
    { date: "2026-10-12", games: g(0.2) },     // net from here on: left alone
  ], { farmApps, appids: { 1: 500 } });
  assert.equal(led.since, "2026-09-24");
  assert.equal(led.rawUntil, RAW_UNTIL);
  assert.deepEqual(led.days["2026-09-24"], { 1: 0.1, 2: 3 });
  assert.deepEqual(led.days["2026-09-26"], { 1: 0.1, 2: 3 });
  assert.deepEqual(led.days["2026-10-12"], { 1: 0.2, 2: 3 });
});

await test("a raw value frozen while farming never goes below zero", () => {
  const led = buildLedgerFromHistory([{ date: "2026-09-26", games: [{ id: 1, actualHours: 1 }] }],
    { farmApps: { 500: { days: { "2026-09-25": 600 } } }, appids: { 1: 500 } });
  assert.equal(led.days["2026-09-26"][1], 0);
});

await test("appendLedgerDay adds today's row, replaces a same-day row, and starts a fresh ledger", () => {
  const fresh = appendLedgerDay(null, [{ id: 4, actualHours: 2.5 }, { id: 5, actualHours: null }], "2026-10-17");
  assert.deepEqual(fresh.days, { "2026-10-17": { 4: 2.5 } });
  assert.equal(fresh.since, "2026-10-17");
  appendLedgerDay(fresh, [{ id: 4, actualHours: 3 }], "2026-10-17");
  assert.deepEqual(fresh.days["2026-10-17"], { 4: 3 });
  appendLedgerDay(fresh, [{ id: 4, actualHours: 3.4 }], "2026-10-18");
  assert.equal(Object.keys(fresh.days).length, 2);
});

await test("formatLedger round-trips and writes one line per day, in date order", () => {
  const led = { version: 1, since: "2026-07-28", rawUntil: RAW_UNTIL,
    days: { "2026-07-29": { 12: 1.5, 3: 4 }, "2026-07-28": { 3: 4 } } };
  const text = formatLedger(led);
  assert.deepEqual(JSON.parse(text), led);
  const dayLines = text.split("\n").filter(l => /^\s+"2026-/.test(l));
  assert.deepEqual(dayLines.map(l => l.trim().slice(1, 11)), ["2026-07-28", "2026-07-29"]);
  assert.ok(dayLines[1].includes('{"3":4,"12":1.5}'));
});

await test("steamUnlockRows keeps only earned achievements with a real unlock time", () => {
  const rows = steamUnlockRows({ id: 7, t: "Cocoon" }, 1497440, [
    { apiname: "A", achieved: 1, unlocktime: 1790000000, name: "First" },
    { apiname: "B", achieved: 0, unlocktime: 0 },
    { apiname: "C", achieved: 1, unlocktime: 0 },
  ]);
  assert.deepEqual(rows, [{ src: "steam", id: 7, key: "steam:1497440:A", ts: 1790000000, name: "First", game: "Cocoon", pct: null }]);
});

await test("raTimestamp reads RA's zoneless dates as UTC", () => {
  assert.equal(raTimestamp("2026-10-12 21:33:05"), Date.UTC(2026, 9, 12, 21, 33, 5) / 1000);
  assert.equal(raTimestamp(""), null);
  assert.equal(raTimestamp("garbage"), null);
});

await test("raUnlockRows maps tracker ids and hardcore, and drops undated rows", () => {
  const rows = raUnlockRows([
    { Date: "2026-03-01 23:10:00", HardcoreMode: 1, AchievementID: 9, Title: "Wing Cap", GameTitle: "Super Mario 64" },
    { Date: "2026-03-02 01:00:00", HardcoreMode: 0, AchievementID: 10, Title: "Odd", GameTitle: "Untracked Game" },
    { Date: null, AchievementID: 11, Title: "Broken", GameTitle: "Super Mario 64" },
  ], (t) => (t === "Super Mario 64" ? 42 : null));
  assert.equal(rows.length, 2);
  assert.deepEqual([rows[0].id, rows[0].hc, rows[0].key], [42, true, "ra:9"]);
  assert.deepEqual([rows[1].id, rows[1].hc], [null, false]);
});

await test("mergeUnlocks never drops a row, fills a missing pct or id, and counts only new rows", () => {
  const old = [{ src: "steam", id: null, key: "k1", ts: 20, pct: null }, { src: "ra", id: 1, key: "k2", ts: 10, pct: null }];
  const { rows, added } = mergeUnlocks(old, [
    { src: "steam", id: 5, key: "k1", ts: 999, pct: 3.2 },
    { src: "ra", id: 2, key: "k3", ts: 30, pct: null },
  ]);
  assert.equal(added, 1);
  assert.deepEqual(rows.map(r => r.key), ["k2", "k1", "k3"]);
  const k1 = rows.find(r => r.key === "k1");
  assert.deepEqual([k1.ts, k1.pct, k1.id], [20, 3.2, 5]);
  assert.equal(mergeUnlocks([], []).rows.length, 0);
});

await test("raWindowStart starts an hour before the newest RA row, or at Jan 1 for an empty log", () => {
  const now = new Date("2026-10-17T12:00:00Z");
  assert.equal(raWindowStart([], now), Date.UTC(2026, 0, 1) / 1000);
  assert.equal(raWindowStart([{ src: "steam", ts: 5e9 }, { src: "ra", ts: 1790000000 }], now), 1790000000 - 3600);
});

await test("formatUnlocks round-trips one row per line", () => {
  const rows = [{ src: "ra", id: 1, key: "ra:1", ts: 1, name: "x", game: "y", pct: null, hc: true }];
  const text = formatUnlocks(rows);
  assert.deepEqual(JSON.parse(text).unlocks, rows);
  assert.equal(text.split("\n").filter(l => l.includes('"key"')).length, 1);
});

await test("syncSteam hands every tracked game's unlock rows and appid to the sink", async () => {
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes("GetOwnedGames")) return json({ response: { games: [{ appid: 77, name: "Brotato", playtime_forever: 60, rtime_last_played: 1785000000 }] } });
    if (u.includes("GetPlayerAchievements")) return json({ playerstats: { success: true, achievements: [
      { apiname: "WIN", achieved: 1, unlocktime: 1785000000, name: "Win" }, { apiname: "LOSE", achieved: 0, unlocktime: 0 }] } });
    throw new Error(`unexpected fetch ${u}`);
  };
  const sink = {};
  const games = [{ id: 1, t: "Brotato", p: "steam", s: "playing", actualHours: null, achPct: null, achCount: null, lastPlayed: null }];
  await syncSteam(games, [], new Set(), null, sink);
  assert.deepEqual(sink.steamUnlocks.map(r => r.key), ["steam:77:WIN"]);
  assert.deepEqual(sink.appidOf, { 1: 77 });
  assert.deepEqual(games[0].achCount, [1, 2]);
});

await test("syncRaUnlocks asks RA for the window since the newest logged row and maps tracked games", async () => {
  let asked;
  globalThis.fetch = async (url) => {
    asked = new URL(String(url));
    return json([{ Date: "2026-10-16 02:00:00", HardcoreMode: 1, AchievementID: 3, Title: "Hi", GameTitle: "The Legend of Zelda: The Minish Cap" }]);
  };
  const games = [{ id: 9, t: "Zelda: The Minish Cap", p: "retro" }];
  const rows = await syncRaUnlocks(games, [], [{ src: "ra", ts: 1790000000, key: "ra:1" }], new Date("2026-10-17T00:00:00Z"));
  assert.ok(asked.pathname.endsWith("API_GetAchievementsEarnedBetween.php"));
  assert.equal(asked.searchParams.get("f"), String(1790000000 - 3600));
  assert.equal(asked.searchParams.get("t"), String(Date.UTC(2026, 9, 17) / 1000));
  assert.deepEqual([rows[0].id, rows[0].key], [9, "ra:3"]);
});

await test("syncRaUnlocks logs and returns nothing when RA fails", async () => {
  globalThis.fetch = async () => new Response("down", { status: 503 });
  const log = [];
  assert.deepEqual(await syncRaUnlocks([], log, []), []);
  assert.match(log[0], /RA unlock log failed/);
});

await test("fillGlobalPcts asks once per game, only for this year's Steam rows missing a pct", async () => {
  const calls = [];
  globalThis.fetch = async (url) => {
    const u = new URL(String(url));
    calls.push(u.searchParams.get("gameid"));
    return json({ achievementpercentages: { achievements: [{ name: "WIN", percent: "2.345" }, { name: "B:C", percent: 50 }] } });
  };
  const y = Date.UTC(2026, 5, 1) / 1000, old = Date.UTC(2025, 5, 1) / 1000;
  const rows = [
    { src: "steam", id: 1, key: "steam:77:WIN", ts: y, pct: null },
    { src: "steam", id: 1, key: "steam:77:B:C", ts: y, pct: null },   // apinames can hold colons
    { src: "steam", id: 1, key: "steam:77:OLD", ts: old, pct: null },
    { src: "steam", id: 2, key: "steam:88:X", ts: y, pct: 4 },
    { src: "ra", id: 3, key: "ra:1", ts: y, pct: null },
  ];
  await fillGlobalPcts(rows, { 1: 77, 2: 88 }, [], 2026);
  assert.deepEqual(calls, ["77"]);
  assert.deepEqual(rows.map(r => r.pct), [2.3, 50, null, 4, null]);
});

console.log(`\n${pass}/${pass + fail} passing`);
process.exit(fail ? 1 : 0);
