// Exercises the sync script's actual data-mutation logic against stubbed Steam/RA
// responses — same stubbed-fetch pattern as worker/index.test.mjs in steph-tv-tracker. The
// whole point of this file: it can only pass if syncSteam/syncRA genuinely read
// the fake API responses and mutate `games` correctly. A commented-out placeholder loop
// (which is what the first version of this idea shipped with, before it was caught and
// rebuilt) would fail every test here immediately.
import { syncSteam, syncRA, getRecentlyFarmedAppids, buildPlayCheck, playCheckSummary, resolveRaTitles } from "./sync-apis.mjs";
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

await test("syncSteam applies STEAM_NAME_ALIASES for Shadow of Mordor despite Steam's trademark glyphs", async () => {
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes("GetOwnedGames")) {
      return new Response(JSON.stringify({
        response: { games: [{ appid: 6, name: "Middle-earth™: Shadow of Mordor™", playtime_forever: 120, rtime_last_played: 1785000000 }] },
      }), { status: 200 });
    }
    return new Response(JSON.stringify({ playerstats: { success: false } }), { status: 200 });
  };
  const games = [baseGame({ t: "Shadow of Mordor", p: "steam", actualHours: null })];
  await syncSteam(games, []);
  assert.equal(games[0].actualHours, 2, "should match via the alias even though normalize() has to strip the trademark glyphs first");
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

// syncRA now calls two endpoints, so the stub has to answer by URL rather than blindly.
const raStub = ({ completed = [], recent = [] } = {}) => async (url) => {
  const u = String(url);
  if (u.includes("API_GetUserCompletedGames")) {
    return new Response(JSON.stringify(completed), { status: 200 });
  }
  if (u.includes("API_GetUserRecentlyPlayedGames")) {
    return new Response(JSON.stringify(recent), { status: 200 });
  }
  throw new Error(`unexpected fetch ${u}`);
};

await test("syncRA updates achievement counts from stubbed API, picks the higher-awarded row", async () => {
  globalThis.fetch = raStub({ completed: [
    { Title: "Tetris", NumAwarded: "3", MaxPossible: "10" },    // softcore-ish, lower
    { Title: "Tetris", NumAwarded: "8", MaxPossible: "10" },    // should win
  ] });
  const games = [baseGame({ id: 2, t: "Tetris", p: "retro" })];
  const log = [];
  await syncRA(games, log);
  assert.deepEqual(games[0].achCount, [8, 10]);
  assert.equal(games[0].achPct, 80);
});

// The bug this fixes: API_GetUserCompletedGames carries no play date, so a RetroAchievements
// game's lastPlayed was never written by anything, and an actively-played game read as
// dormant/stale while its achievement counts kept updating.
await test("syncRA sets lastPlayed from recently-played, which nothing used to write at all", async () => {
  globalThis.fetch = raStub({
    completed: [{ Title: "Castlevania: Symphony of the Night", NumAwarded: "23", MaxPossible: "105" }],
    recent: [{ Title: "Castlevania: Symphony of the Night", LastPlayed: "2026-09-10 22:21:05" }],
  });
  const games = [baseGame({ id: 3, t: "Castlevania: Symphony of the Night", p: "ayn",
                           lastPlayed: "2026-07-08" })];
  const log = [];
  await syncRA(games, log);
  assert.equal(games[0].lastPlayed, "2026-09-10", "RA play date should refresh lastPlayed");
  assert.deepEqual(games[0].achCount, [23, 105], "achievements still sync alongside it");
  assert.ok(log.some(l => l.includes("lastPlayed -> 2026-09-10")), "should log the bump");
});

await test("syncRA never moves lastPlayed backwards", async () => {
  globalThis.fetch = raStub({
    completed: [{ Title: "Tetris", NumAwarded: "8", MaxPossible: "10" }],
    recent: [{ Title: "Tetris", LastPlayed: "2026-01-01 10:00:00" }],  // older than stored
  });
  const games = [baseGame({ id: 4, t: "Tetris", p: "retro", lastPlayed: "2026-08-20" })];
  const log = [];
  await syncRA(games, log);
  assert.equal(games[0].lastPlayed, "2026-08-20",
    "a stale row from the rolling recent window must not drag a newer date backwards");
});

await test("syncRA keeps achievement sync when the recently-played call fails", async () => {
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes("API_GetUserCompletedGames")) {
      return new Response(JSON.stringify(
        [{ Title: "Tetris", NumAwarded: "8", MaxPossible: "10" }]), { status: 200 });
    }
    return new Response("nope", { status: 500 });   // recently-played is down
  };
  const games = [baseGame({ id: 5, t: "Tetris", p: "retro", lastPlayed: "2026-08-20" })];
  const log = [];
  await syncRA(games, log);
  assert.deepEqual(games[0].achCount, [8, 10], "achievements must still land");
  assert.equal(games[0].lastPlayed, "2026-08-20", "lastPlayed left alone");
  assert.ok(log.some(l => l.includes("recently-played lookup failed")), "should say why");
});

await test("syncRA sets lastPlayed for a game not yet in the completed-games list", async () => {
  // A freshly-started game has a play date but no awards row yet; the two endpoints are
  // handled independently so it still gets a date.
  globalThis.fetch = raStub({
    completed: [],
    recent: [{ Title: "Castlevania: Aria of Sorrow", LastPlayed: "2026-09-11 08:00:00" }],
  });
  const games = [baseGame({ id: 6, t: "Castlevania: Aria of Sorrow", p: "ayn", lastPlayed: null })];
  const log = [];
  await syncRA(games, log);
  assert.equal(games[0].lastPlayed, "2026-09-11");
});

// ─── Play check ───
const TODAY = new Date("2026-09-26T12:00:00Z");

await test("buildPlayCheck records recent Steam minutes for a Now Playing game", async () => {
  const games = [baseGame({ id: 1, t: "Brotato", s: "playing" })];
  const c = buildPlayCheck(games, { steamOwned: [{ appid: 1, name: "Brotato", playtime_2weeks: 190 }] }, TODAY);
  assert.deepEqual(c.recent, { 1: { mins: 190 } });
  assert.deepEqual(c.offList, [], "a playing game is not a mismatch");
});

await test("buildPlayCheck flags a queued or done game with recent play, but not ongoing", async () => {
  const games = [
    baseGame({ id: 2, t: "Coffee Talk", s: "done" }),
    baseGame({ id: 3, t: "Hades", s: "queue" }),
    baseGame({ id: 4, t: "Marvel Snap", s: "ongoing" }),
  ];
  const c = buildPlayCheck(games, { steamOwned: [
    { appid: 2, name: "Coffee Talk", playtime_2weeks: 45 },
    { appid: 3, name: "Hades", playtime_2weeks: 300 },
    { appid: 4, name: "MARVEL SNAP", playtime_2weeks: 500 },
  ] }, TODAY);
  assert.deepEqual(c.offList.map(x => [x.t, x.s]), [["Hades", "queue"], ["Coffee Talk", "done"]], "sorted by minutes");
});

await test("buildPlayCheck ignores ASF-idled appids entirely", async () => {
  const games = [baseGame({ id: 3, t: "Hades", s: "queue" })];
  const c = buildPlayCheck(games, {
    steamOwned: [{ appid: 3, name: "Hades", playtime_2weeks: 900 }, { appid: 9, name: "Idle Only", playtime_2weeks: 900 }],
    farmedAppids: new Set([3, 9]),
  }, TODAY);
  assert.deepEqual(c.offList, []);
  assert.deepEqual(c.untracked, [], "card farming is not play");
});

await test("buildPlayCheck lists untracked Steam games only above the minimum", async () => {
  const c = buildPlayCheck([baseGame()], { steamOwned: [
    { appid: 5, name: "Balatro", playtime_2weeks: 240 },
    { appid: 6, name: "Wallpaper Engine", playtime_2weeks: 20 },
  ] }, TODAY);
  assert.deepEqual(c.untracked, [{ title: "Balatro", source: "steam", mins: 240 }]);
});

await test("buildPlayCheck matches Steam aliases and other-platform titles as tracked", async () => {
  const games = [
    baseGame({ id: 7, t: "Midnight Suns", s: "soon" }),
    baseGame({ id: 8, t: "Hollow Knight", p: "switch", s: "playing" }),
  ];
  const c = buildPlayCheck(games, { steamOwned: [
    { appid: 7, name: "Marvel's Midnight Suns", playtime_2weeks: 120 },
    { appid: 8, name: "Hollow Knight", playtime_2weeks: 120 },
  ] }, TODAY);
  assert.deepEqual(c.untracked, []);
  assert.deepEqual(c.offList.map(x => x.id), [7]);
});

await test("buildPlayCheck uses RA dates inside the window only, via RA_TITLE_MAP", async () => {
  const games = [baseGame({ id: 10, t: "Zelda: Oracle of Ages", p: "ayn", s: "queue" })];
  const raPlayed = new Map([
    ["The Legend of Zelda: Oracle of Ages", "2026-09-20"],
    ["Kirby's Dream Land", "2026-09-25"],
    ["Metroid Fusion", "2026-08-01"],
  ]);
  const c = buildPlayCheck(games, { raPlayed }, TODAY);
  assert.deepEqual(c.offList, [{ id: 10, t: "Zelda: Oracle of Ages", s: "queue", lastPlayed: "2026-09-20" }]);
  assert.deepEqual(c.untracked, [{ title: "Kirby's Dream Land", source: "ra", lastPlayed: "2026-09-25" }], "old RA rows drop out");
});

await test("syncSteam and syncRA hand back the data the play check needs", async () => {
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes("GetOwnedGames")) return new Response(JSON.stringify({ response: { games: [{ appid: 1, name: "Balatro", playtime_2weeks: 90 }] } }));
    if (u.includes("GetUserCompletedGames")) return new Response("[]");
    if (u.includes("GetUserRecentlyPlayedGames")) return new Response(JSON.stringify([{ Title: "Tetris", LastPlayed: "2026-09-24 10:00:00" }]));
    throw new Error(`unexpected fetch ${u}`);
  };
  const owned = await syncSteam([], []);
  const played = await syncRA([], []);
  assert.equal(owned[0].name, "Balatro");
  assert.equal(played.get("Tetris"), "2026-09-24");
});

await test("playCheckSummary names Now Playing games with no recorded play", async () => {
  const games = [baseGame({ id: 1, t: "Brotato", s: "playing" }), baseGame({ id: 2, t: "Hades", s: "playing" })];
  const out = playCheckSummary(buildPlayCheck(games, { steamOwned: [{ appid: 1, name: "Brotato", playtime_2weeks: 90 }] }, TODAY), games);
  assert.ok(out.includes("- Brotato: 1.5h in 14d"));
  assert.ok(out.includes("- Hades: no Steam/RA play"));
});

// ─── RA title matching (no hand-maintained map) ───
const row = (Title, NumAwarded, MaxPossible) => ({ Title, NumAwarded, MaxPossible });

await test("syncRA picks up a brand-new retro game by title alone, no map entry (the Halo regression, RA side)", async () => {
  globalThis.fetch = raStub({ completed: [row("Metroid Fusion", 12, 40)] });
  const games = [baseGame({ id: 20, t: "Metroid Fusion", p: "ayn" })];
  await syncRA(games, []);
  assert.deepEqual(games[0].achCount, [12, 40]);
});

await test("resolveRaTitles derives \"The Legend of Zelda: X\" from a \"Zelda: X\" title", async () => {
  const m = resolveRaTitles([baseGame({ id: 21, t: "Zelda: Minish Cap", p: "retro" })], ["The Legend of Zelda: Minish Cap"]);
  assert.equal(m.get(21), "The Legend of Zelda: Minish Cap");
});

await test("resolveRaTitles folds diacritics and RA's ~Hack~ prefix (Pokemon Lazarus)", async () => {
  const m = resolveRaTitles([baseGame({ id: 22, t: "Pokemon Lazarus", p: "ayn" })], ["~Hack~ Pokémon Lazarus"]);
  assert.equal(m.get(22), "~Hack~ Pokémon Lazarus");
});

await test("resolveRaTitles prefers an exact title over a prefix-stripped hack of the same name", async () => {
  const m = resolveRaTitles([baseGame({ id: 23, t: "Tetris", p: "retro" })], ["~Homebrew~ Tetris", "Tetris"]);
  assert.equal(m.get(23), "Tetris");
});

await test("resolveRaTitles never fuzzy-matches (Super Mario World vs Yoshi's Island)", async () => {
  const m = resolveRaTitles([baseGame({ id: 24, t: "Super Mario World", p: "retro" })], ["Super Mario World 2: Yoshi's Island"]);
  assert.equal(m.has(24), false);
});

await test("resolveRaTitles ignores non-RA platforms, and RA_TITLE_MAP still covers real renames", async () => {
  const games = [
    baseGame({ id: 25, t: "Chrono Trigger", p: "switch" }),
    baseGame({ id: 26, t: "999: Nine Hours, Nine Persons", p: "ayn" }),
  ];
  const m = resolveRaTitles(games, ["Chrono Trigger", "999: Nine Hours, Nine Persons, Nine Doors"]);
  assert.equal(m.has(25), false, "a Switch copy must not take a handheld run's achievements");
  assert.equal(m.get(26), "999: Nine Hours, Nine Persons, Nine Doors");
});

await test("syncRA names a Now Playing retro game it can't match, and stays quiet about finished ones", async () => {
  globalThis.fetch = raStub({ completed: [] });
  const log = [];
  await syncRA([
    baseGame({ id: 27, t: "Obscure Hack", p: "ayn", s: "playing" }),
    baseGame({ id: 28, t: "Old Finished Game", p: "ayn", s: "done" }),
  ], log);
  assert.ok(log.some(l => l.includes('no match for "Obscure Hack"')));
  assert.ok(!log.some(l => l.includes("Old Finished Game")));
});

await test("buildPlayCheck resolves RA titles with the same rules, so a Zelda game isn't called untracked", async () => {
  const games = [baseGame({ id: 29, t: "Zelda: Oracle of Seasons", p: "ayn", s: "playing" })];
  const c = buildPlayCheck(games, { raPlayed: new Map([["The Legend of Zelda: Oracle of Seasons", "2026-09-24"]]) }, TODAY);
  assert.deepEqual(c.untracked, []);
  assert.deepEqual(c.recent[29], { lastPlayed: "2026-09-24" });
});

console.log(`\n${pass}/${pass + fail} passing`);
process.exit(fail ? 1 : 0);
