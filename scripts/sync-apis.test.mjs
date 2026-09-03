// Exercises the sync script's actual data-mutation logic against stubbed Steam/RA/hub
// responses — same stubbed-fetch pattern as worker/index.test.mjs in steph-tv-tracker. The
// whole point of this file: it can only pass if syncSteam/syncRA/pushToHub genuinely read
// the fake API responses and mutate `games` correctly. A commented-out placeholder loop
// (which is what the first version of this idea shipped with, before it was caught and
// rebuilt) would fail every test here immediately.
import { syncSteam, syncRA, pushToHub, getRecentlyFarmedAppids } from "./sync-apis.mjs";
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

await test("syncSteam skips actualHours/lastPlayed for an appid ASF is currently farming, but still updates achievements", async () => {
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes("GetOwnedGames")) {
      return new Response(JSON.stringify({
        response: { games: [{ appid: 1942280, name: "Brotato", playtime_forever: 754, rtime_last_played: 1785000000 }] },
      }), { status: 200 });
    }
    if (u.includes("GetPlayerAchievements")) {
      return new Response(JSON.stringify({
        playerstats: { success: true, achievements: [{ achieved: 1 }, { achieved: 1 }, { achieved: 0 }] },
      }), { status: 200 });
    }
    throw new Error(`unexpected fetch ${u}`);
  };
  const games = [baseGame({ actualHours: 5, lastPlayed: "2026-01-01" })];
  const log = [];
  await syncSteam(games, log, new Set([1942280])); // Brotato's real appid, marked as currently farming
  assert.equal(games[0].actualHours, 5, "idle-inflated playtime must not overwrite the prior real value");
  assert.equal(games[0].lastPlayed, "2026-01-01", "idle session must not fake a lastPlayed bump");
  assert.equal(games[0].achPct, 67, "achievements are unaffected by idling and should still sync");
  assert.ok(log.some(l => l.includes("skipped playtime/lastPlayed")), "should log why it was skipped");
});

await test("getRecentlyFarmedAppids returns the appid set from the hub's stubbed response", async () => {
  globalThis.fetch = async (url) => {
    assert.ok(String(url).includes("/asf/recently-farmed?token=fake-hub-token"));
    return new Response(JSON.stringify({ recently_farmed_appids: [346010, 1942280] }), { status: 200 });
  };
  const log = [];
  const appids = await getRecentlyFarmedAppids(log);
  assert.deepEqual([...appids].sort((a, b) => a - b), [346010, 1942280]);
});

await test("getRecentlyFarmedAppids fails safe to an empty set (not a throw) on a hub error", async () => {
  globalThis.fetch = async () => new Response("nope", { status: 502 });
  const log = [];
  const appids = await getRecentlyFarmedAppids(log);
  assert.equal(appids.size, 0);
  assert.ok(log.some(l => l.includes("ASF farmed-appids check failed")));
});

await test("syncSteam leaves a game untouched when it's not in the owned-games response", async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({ response: { games: [] } }), { status: 200 });
  const games = [baseGame({ t: "Not Actually Owned", actualHours: 5 })];
  await syncSteam(games, []);
  assert.equal(games[0].actualHours, 5, "no match in Steam's own library means nothing changes");
});

await test("syncSteam matches a brand-new game by title alone — no hand-added map entry needed (the Halo regression)", async () => {
  // Regression test for the actual incident that prompted this rewrite: Halo: Campaign
  // Evolved had real playtime on release day but never synced, because the old design
  // required every game to be hand-added to a title map first. This game is deliberately
  // NOT special-cased anywhere in sync-apis.mjs — matching purely by normalized title +
  // platform is the whole point.
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes("GetOwnedGames")) {
      return new Response(JSON.stringify({
        response: { games: [{ appid: 2806050, name: "Halo: Campaign Evolved", playtime_forever: 180, rtime_last_played: 1785000000 }] },
      }), { status: 200 });
    }
    if (u.includes("GetPlayerAchievements")) {
      return new Response(JSON.stringify({ playerstats: { success: false, error: "Requested app has no stats" } }), { status: 200 });
    }
    throw new Error(`unexpected fetch ${u}`);
  };
  const games = [baseGame({ t: "Halo: Campaign Evolved", p: "steam", s: "queue", actualHours: null })];
  const log = [];
  await syncSteam(games, log);
  assert.equal(games[0].actualHours, 3, "180 minutes -> 3 hours, synced with zero code changes for this title");
  assert.ok(games[0].lastPlayed);
});

await test("syncSteam ignores a same-titled game on a non-Steam platform", async () => {
  globalThis.fetch = async (url) => {
    if (String(url).includes("GetOwnedGames")) {
      return new Response(JSON.stringify({
        response: { games: [{ appid: 1, name: "Tetris", playtime_forever: 600, rtime_last_played: 1785000000 }] },
      }), { status: 200 });
    }
    throw new Error("achievements should never be requested for a non-Steam-platform game");
  };
  const games = [baseGame({ t: "Tetris", p: "ayn", actualHours: null })]; // AYN Thor Tetris, not the Steam one
  await syncSteam(games, []);
  assert.equal(games[0].actualHours, null, "a retro/AYN-Thor game must never pick up Steam library data just because the title matches");
});

await test("syncSteam applies STEAM_NAME_ALIASES for the one known real subtitle mismatch", async () => {
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes("GetOwnedGames")) {
      return new Response(JSON.stringify({
        response: { games: [{ appid: 5, name: "Ori and the Blind Forest: Definitive Edition", playtime_forever: 300, rtime_last_played: 1785000000 }] },
      }), { status: 200 });
    }
    return new Response(JSON.stringify({ playerstats: { success: false } }), { status: 200 });
  };
  const games = [baseGame({ t: "Ori and the Blind Forest", p: "steam", actualHours: null })];
  await syncSteam(games, []);
  assert.equal(games[0].actualHours, 5, "should match via the alias despite the store listing's extra subtitle");
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

await test("pushToHub sorts now_playing by lastPlayed but takes up_next in array order, matching the page", async () => {
  let captured = null;
  globalThis.fetch = async (url, init) => {
    captured = { url: String(url), body: JSON.parse(init.body) };
    return new Response("{}", { status: 200 });
  };
  // Queued dates here are deliberately shuffled relative to array order: the point is that
  // they no longer influence the result. index.html numbers Up Next 1..N from array position,
  // and that position is what add.html's reorder panel maintains, so the hub must read the
  // same signal or the two surfaces disagree about what's #1 (which they used to).
  const games = [
    baseGame({ id: 1, t: "Older", s: "playing", lastPlayed: "2026-01-01" }),
    baseGame({ id: 2, t: "Newer", s: "playing", lastPlayed: "2026-06-01" }),
    baseGame({ id: 3, t: "Q-first", s: "queue", queued: "2026-01-01" }),
    baseGame({ id: 4, t: "Q-second", s: "queue", queued: "2026-06-01" }),
    baseGame({ id: 5, t: "NoQueueDate-still-counts", s: "queue", queued: null }),
    baseGame({ id: 6, t: "Q-fourth", s: "queue", queued: "2026-04-01" }),
    baseGame({ id: 7, t: "Q-fifth-dropped-by-cap", s: "queue", queued: "2026-12-01" }),
    baseGame({ id: 8, t: "Backlog", s: "soon" }),
  ];
  await pushToHub(games, []);
  assert.ok(captured.url.includes("/game-tracker/update?token=fake-hub-token"));
  assert.deepEqual(captured.body.now_playing.map(g => g.name), ["Newer", "Older"], "newest lastPlayed first");
  assert.equal(captured.body.up_next.length, 4, "capped to the first 4");
  assert.deepEqual(
    captured.body.up_next.map(g => g.name),
    ["Q-first", "Q-second", "NoQueueDate-still-counts", "Q-fourth"],
    "first four queue entries in array order, regardless of queued date",
  );
  assert.ok(
    !captured.body.up_next.some(g => g.name === "Q-fifth-dropped-by-cap"),
    "the newest queued date does not jump the cap any more",
  );
});

await test("pushToHub omits an ongoing game from now_playing", async () => {
  // Passes today by construction (pushToHub filters g.s === "playing", a strict-equality
  // check "ongoing" never matches) — pinning it anyway, since the exclusion is load-bearing
  // for the hub card and is currently accidental rather than deliberately tested.
  let captured = null;
  globalThis.fetch = async (url, init) => {
    captured = { url: String(url), body: JSON.parse(init.body) };
    return new Response("{}", { status: 200 });
  };
  const games = [
    baseGame({ id: 1, t: "World of Warcraft", s: "ongoing", lastPlayed: "2026-09-01" }),
    baseGame({ id: 2, t: "Real Now Playing", s: "playing", lastPlayed: "2026-01-01" }),
  ];
  await pushToHub(games, []);
  assert.deepEqual(captured.body.now_playing.map(g => g.name), ["Real Now Playing"]);
});

await test("pushToHub throws on a non-OK response so a failed push isn't silently swallowed", async () => {
  globalThis.fetch = async () => new Response("nope", { status: 502 });
  await assert.rejects(() => pushToHub([baseGame()], []));
});

console.log(`\n${pass}/${pass + fail} passing`);
process.exit(fail ? 1 : 0);
