// The fixture below is hand-built from the response schema (field names as Steam's own
// ISaleFeatureService/GetUserYearInReview returns them), not captured from a live call: the
// endpoint is undocumented and only answers for a published Replay. If a real response ever
// disagrees, capture it into this file and let these tests say what broke.
import assert from "node:assert/strict";
import { normalizeReplay, yearsToFetch, merge } from "./fetch-steam-replay.mjs";

let pass = 0, fail = 0;
const test = async (name, fn) => {
  try { await fn(); pass++; console.log(`PASS  ${name}`); }
  catch (e) { fail++; console.log(`FAIL  ${name}\n        ${e.message}`); }
};

const t = (iso) => Date.parse(iso) / 1000;
const RAW = { response: {
  privacy_state: 3,
  stats: {
    account_id: 1, year: 2025,
    playtime_stats: {
      total_stats: { total_playtime_seconds: 0, total_sessions: 412, deck_sessions: 90,
        total_playtime_percentagex100: 10000, deck_playtime_percentagex100: 2750, controller_playtime_percentagex100: 6125 },
      playtime_streak: { longest_consecutive_days: 23, rtime_start: t("2025-03-02T00:00:00Z"), streak_games: [{ appid: 10 }, { appid: 20 }] },
      game_summary: [
        { appid: 10, new_this_year: true, total_playtime_percentagex100: 4200, total_sessions: 120 },
        { appid: 20, new_this_year: false, total_playtime_percentagex100: 3100, total_sessions: 80 },
        { appid: 30, new_this_year: true, total_playtime_percentagex100: 2500, total_sessions: 60 },
        { appid: 40, demo: true, total_playtime_percentagex100: 200, total_sessions: 2 },
      ],
      months: [
        { rtime_month: t("2025-02-01T00:00:00Z"), stats: { total_sessions: 30 }, relative_monthly_stats: { total_playtime_percentagex100: 900 },
          game_summary: [{ appid: 20, relative_playtime_percentagex100: 7000 }, { appid: 10, relative_playtime_percentagex100: 3000 }] },
        { rtime_month: t("2025-01-01T00:00:00Z"), stats: { total_sessions: 12 }, relative_monthly_stats: { total_playtime_percentagex100: 450 },
          game_summary: [{ appid: 30, relative_playtime_percentagex100: 10000 }] },
      ],
    },
    summary_stats: { total_achievements: 311, total_games_with_achievements: 14, total_rare_achievements: 9 },
    by_numbers: { games_played_pct: 82, achievements_pct: 91, game_streak_pct: 77 },
  },
  distribution: { new_releases: 3300, recent_releases: 4100, classic_releases: 2600, recent_cutoff_year: 2017 },
} };
const NAMES = new Map([[10, "Hades II"], [20, "Balatro"], [30, "Cocoon"]]);

await test("a published Replay normalizes to what wrapped.html reads", () => {
  const r = normalizeReplay(RAW, 2025, NAMES);
  assert.equal(r.available, true);
  assert.equal(r.sessions, 412);
  assert.equal(r.totalHours, null, "a 0-second total is 'not provided', not zero hours");
  assert.deepEqual(r.topGames.map(g => [g.name, g.pct]), [["Hades II", 42], ["Balatro", 31], ["Cocoon", 25]]);
  assert.equal(r.gamesPlayed, 3, "demos and playtests aren't games played");
  assert.equal(r.newGames, 2);
  assert.equal(r.newGamesPct, 67);
  assert.equal(r.deckPct, 27.5);
  assert.deepEqual(r.streak, { days: 23, start: "2025-03-02", games: ["Hades II", "Balatro"] });
  assert.deepEqual(r.achievements, { total: 311, rare: 9, games: 14 });
  assert.deepEqual(r.releases, { newPct: 33, recentPct: 41, classicPct: 26, recentCutoff: 2017 });
  assert.deepEqual(r.percentiles, { gamesPlayed: 82, achievements: 91, streak: 77 });
});

await test("months come out in calendar order with each month's top game", () => {
  const r = normalizeReplay(RAW, 2025, NAMES);
  assert.deepEqual(r.months.map(m => [m.m, m.pct, m.top.name]), [[0, 4.5, "Cocoon"], [1, 9, "Balatro"]]);
});

await test("an unnamed appid still renders instead of breaking", () => {
  const r = normalizeReplay(RAW, 2025, new Map());
  assert.equal(r.topGames[0].name, "App 10");
});

await test("no stats (unpublished or private) is unavailable with a reason", () => {
  const r = normalizeReplay({ response: { privacy_state: 1 } }, 2026);
  assert.equal(r.available, false);
  assert.match(r.reason, /not built yet, or not set to public/);
  assert.equal(normalizeReplay({}, 2026).available, false);
});

await test("a thin response degrades to fewer facts, not a crash", () => {
  const r = normalizeReplay({ response: { stats: { playtime_stats: { game_summary: [{ appid: 10, total_playtime_percentagex100: 10000 }] } } } }, 2025, NAMES);
  assert.equal(r.available, true);
  assert.equal(r.topGames[0].name, "Hades II");
  assert.equal(r.streak, null);
  assert.equal(r.achievements, null);
  assert.equal(r.releases, null);
});

await test("which years: December fetches this year; last year until January's final fetch", () => {
  const ok = { available: true, fetchedAt: "2025-12-20T00:00:00Z" };
  assert.deepEqual(yearsToFetch(new Date("2025-12-15T12:00:00Z"), { 2024: { available: true, fetchedAt: "2025-01-05" } }), [2025]);
  assert.deepEqual(yearsToFetch(new Date("2026-01-03T12:00:00Z"), { 2025: ok }), [2025]);
  assert.deepEqual(yearsToFetch(new Date("2026-01-20T12:00:00Z"), { 2025: { available: true, fetchedAt: "2026-01-03T00:00:00Z" } }), []);
  assert.deepEqual(yearsToFetch(new Date("2026-06-01T12:00:00Z"), { 2025: { available: true, fetchedAt: "2026-01-03" } }), []);
  assert.deepEqual(yearsToFetch(new Date("2026-06-01T12:00:00Z"), {}), [2025]);
});

await test("a failed fetch never replaces a year that already has data", () => {
  const now = new Date("2026-01-02T00:00:00Z");
  const good = { available: true, sessions: 412 };
  const kept = merge({ 2025: good }, 2025, { available: false, reason: "403" }, now);
  assert.equal(kept[2025].sessions, 412);
  assert.equal(kept[2025].lastError, "403");
  assert.equal(merge({}, 2025, { available: false, reason: "x" }, now)[2025].available, false);
});

console.log(`\n${pass}/${pass + fail} passing`);
process.exit(fail ? 1 : 0);
