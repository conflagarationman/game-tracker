// Exercises the sync script's actual data-mutation logic against stubbed Steam/RA/hub
// responses — same stubbed-fetch pattern as worker/index.test.mjs in steph-tv-tracker. The
// whole point of this file: it can only pass if syncSteam/syncRA/pushToHub genuinely read
// the fake API responses and mutate `games` correctly. A commented-out placeholder loop
// (which is what the first version of this idea shipped with, before it was caught and
// rebuilt) would fail every test here immediately.
import { syncSteam, syncRA, pushToHub } from "./sync-apis.mjs";
import assert from "node:assert/strict";

process.env.STEAM_API_KEY = "fake";
process.env.STEAM_ID = "76561198000000000";
process.env.RA_USER = "tester";
process.env.RA_API_KEY = "fake";
process.env.HUB_STATUS_TOKEN = "fake-hub-token";

let pass = 0, fail = 0;
const test = async (name, fn) => {
  try { await fn(); pass++; console.log(`PASS  ${name}`); }
  catch (e) { fail++; console.log(`FAIL  ${name}\n        ${e.message}`); }
};

const baseGame = (overrides) => ({
  id: 1, t: "Brotato", p: "steam", s: "playing", r: 9, g: "Roguelike", y: 2023,
  actualHours: null, achPct: null, achCount: null, lastPlayed: null, gotm: null, queued: null,
  ...overrides,
});

await test("syncSteam updates hours, lastPlayed, and achievements from stubbed API responses", async () => {
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes("GetOwnedGames")) {
      return new Response(JSON.stringify({
        response: { games: [{ name: "Brotato", playtime_forever: 754, rtime_last_played: 1785000000 }] },
      }), { status: 200 });
    }
    if (u.includes("GetPlayerAchievements")) {
      return new Response(JSON.stringify({
        playerstats: { success: true, achievements: [{ achieved: 1 }, { achieved: 1 }, { achieved: 0 }] },
      }), { status: 200 });
    }
    throw new Error(`unexpected fetch ${u}`);
  };
  const games = [baseGame()];
  const log = [];
  await syncSteam(games, log);
  assert.equal(games[0].actualHours, 12.6, "754 minutes -> 12.6 hours");
  assert.ok(games[0].lastPlayed, "lastPlayed should be set from rtime_last_played");
  assert.equal(games[0].achPct, 67, "2 of 3 achieved -> 67%");
  assert.deepEqual(games[0].achCount, [2, 3]);
  assert.ok(log.some(l => l.includes("Brotato")), "should log the change");
});

await test("syncSteam leaves untracked games untouched", async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({ response: { games: [] } }), { status: 200 });
  const games = [baseGame({ t: "Not In The Title Map", actualHours: 5 })];
  await syncSteam(games, []);
  assert.equal(games[0].actualHours, 5, "a game not in STEAM_TITLE_MAP must be left alone");
});

await test("syncSteam skips cleanly (no throw) when credentials are missing", async () => {
  const savedKey = process.env.STEAM_API_KEY;
  delete process.env.STEAM_API_KEY;
  const games = [baseGame()];
  const log = [];
  await syncSteam(games, log);
  assert.equal(games[0].actualHours, null, "nothing should change without credentials");
  assert.ok(log.some(l => l.includes("skipped")));
  process.env.STEAM_API_KEY = savedKey;
});

await test("syncRA updates achievement counts from stubbed API, picks the higher-awarded row", async () => {
  globalThis.fetch = async () => new Response(JSON.stringify([
    { Title: "Tetris", NumAwarded: "3", MaxPossible: "10" },    // softcore-ish, lower
    { Title: "Tetris", NumAwarded: "8", MaxPossible: "10" },    // should win
  ]), { status: 200 });
  const games = [baseGame({ id: 2, t: "Tetris", p: "retro" })];
  const log = [];
  await syncRA(games, log);
  assert.deepEqual(games[0].achCount, [8, 10]);
  assert.equal(games[0].achPct, 80);
});

await test("pushToHub derives now_playing sorted by lastPlayed and up_next top-4 by queued date", async () => {
  let captured = null;
  globalThis.fetch = async (url, init) => {
    captured = { url: String(url), body: JSON.parse(init.body) };
    return new Response("{}", { status: 200 });
  };
  const games = [
    baseGame({ id: 1, t: "Older", s: "playing", lastPlayed: "2026-01-01" }),
    baseGame({ id: 2, t: "Newer", s: "playing", lastPlayed: "2026-06-01" }),
    baseGame({ id: 3, t: "Q-oldest-dropped-by-cap", s: "queue", queued: "2026-01-01" }),
    baseGame({ id: 4, t: "Q-newest", s: "queue", queued: "2026-06-01" }),
    baseGame({ id: 5, t: "Q-2nd", s: "queue", queued: "2026-05-01" }),
    baseGame({ id: 6, t: "Q-3rd", s: "queue", queued: "2026-04-01" }),
    baseGame({ id: 7, t: "Q-4th", s: "queue", queued: "2026-03-01" }),
    baseGame({ id: 8, t: "NoQueueDate", s: "queue", queued: null }),
    baseGame({ id: 9, t: "Backlog", s: "soon" }),
  ];
  await pushToHub(games, []);
  assert.ok(captured.url.includes("/game-tracker/update?token=fake-hub-token"));
  assert.deepEqual(captured.body.now_playing.map(g => g.name), ["Newer", "Older"], "newest lastPlayed first");
  assert.equal(captured.body.up_next.length, 4, "capped to top 4");
  assert.deepEqual(captured.body.up_next.map(g => g.name), ["Q-newest", "Q-2nd", "Q-3rd", "Q-4th"], "newest-queued 4 survive, oldest dropped by the cap");
  assert.ok(!captured.body.up_next.some(g => g.name === "NoQueueDate"), "no queued date excludes it");
});

await test("pushToHub throws on a non-OK response so a failed push isn't silently swallowed", async () => {
  globalThis.fetch = async () => new Response("nope", { status: 502 });
  await assert.rejects(() => pushToHub([baseGame()], []));
});

console.log(`\n${pass}/${pass + fail} passing`);
process.exit(fail ? 1 : 0);
