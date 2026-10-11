// Steam Replay (Steam's own year in review) into steam-replay.json, for wrapped.html.
//
// The source is ISaleFeatureService/GetUserYearInReview, the endpoint the Replay page itself
// reads. Valve doesn't document it, so normalizeReplay() reads it defensively: every field is
// optional, and a shape change degrades to fewer facts rather than a crash. It answers for a
// year only once Steam has built that Replay (mid-December) and only if that year's Replay is
// set to public on the Steam profile; until then the year is recorded as unavailable with the
// reason, and a year already fetched successfully is never overwritten by a failed fetch.
//
// Which years: the current one during December (it keeps changing until the year ends), and
// last year until it has been fetched once in the new year (January's run gets the final
// numbers). `node scripts/fetch-steam-replay.mjs 2025` fetches a given year on demand.
//
// Run by sync-games.yml after the main sync, best-effort: a failure here never fails the sync.
import fs from "node:fs/promises";

const OUT = new URL("../steam-replay.json", import.meta.url);

const pct = (x) => (typeof x === "number" ? Math.round(x) / 100 : null);
const int = (x) => (typeof x === "number" && Number.isFinite(x) ? x : null);
const isoDay = (rtime) => (int(rtime) ? new Date(rtime * 1000).toISOString().slice(0, 10) : null);
const headerArt = (appid) => `https://cdn.cloudflare.steamstatic.com/steam/apps/${appid}/header.jpg`;

// The raw response -> the small, stable shape wrapped.html reads. `names` maps appid -> title.
export function normalizeReplay(raw, year, names = new Map()) {
  const stats = raw?.response?.stats;
  if (!stats || !stats.playtime_stats) {
    // Valve doesn't say which of the two it is, and privacy_state's values are undocumented.
    return { available: false, reason: `Steam returned no Replay for ${year}: not built yet, or not set to public on the profile` };
  }
  const name = (appid) => names.get(appid) || `App ${appid}`;
  const pt = stats.playtime_stats;
  const total = pt.total_stats || {};
  const summary = (pt.game_summary || []).filter(g => !g.demo && !g.playtest && int(g.appid));

  const topGames = [...summary]
    .sort((a, b) => (b.total_playtime_percentagex100 || 0) - (a.total_playtime_percentagex100 || 0))
    .slice(0, 10)
    .map(g => ({ appid: g.appid, name: name(g.appid), pct: pct(g.total_playtime_percentagex100),
      sessions: int(g.total_sessions), newThisYear: !!g.new_this_year, art: headerArt(g.appid) }));

  const months = (pt.months || []).map(m => {
    const idx = int(m.rtime_month) != null ? new Date(m.rtime_month * 1000).getUTCMonth() : null;
    const top = [...(m.game_summary || [])].sort((a, b) =>
      (b.relative_playtime_percentagex100 || 0) - (a.relative_playtime_percentagex100 || 0))[0];
    const share = m.relative_monthly_stats?.total_playtime_percentagex100 ?? m.stats?.total_playtime_percentagex100;
    return { m: idx, pct: pct(share), sessions: int(m.stats?.total_sessions),
      top: top ? { appid: top.appid, name: name(top.appid) } : null };
  }).filter(m => m.m != null).sort((a, b) => a.m - b.m);

  const streak = pt.playtime_streak;
  const newShare = summary.filter(g => g.new_this_year).reduce((s, g) => s + (g.total_playtime_percentagex100 || 0), 0);
  const ss = stats.summary_stats || {};
  const dist = raw.response.distribution || {};
  const bn = stats.by_numbers || {};

  return {
    available: true,
    year,
    // Valve often reports 0 here for a public (non-owner) view; 0 hours played all year is
    // never the real answer, so it's treated as "not provided" rather than shown.
    totalHours: int(total.total_playtime_seconds) ? Math.round(total.total_playtime_seconds / 360) / 10 : null,
    sessions: int(total.total_sessions),
    gamesPlayed: summary.length || null,
    newGames: summary.filter(g => g.new_this_year).length,
    newGamesPct: summary.length ? Math.round(newShare) / 100 : null,
    deckPct: pct(total.deck_playtime_percentagex100),
    controllerPct: pct(total.controller_playtime_percentagex100),
    topGames,
    months,
    streak: int(streak?.longest_consecutive_days) ? {
      days: streak.longest_consecutive_days, start: isoDay(streak.rtime_start),
      games: (streak.streak_games || []).map(g => name(g.appid)) } : null,
    achievements: int(ss.total_achievements) != null ? {
      total: ss.total_achievements, rare: int(ss.total_rare_achievements), games: int(ss.total_games_with_achievements) } : null,
    // Steam's split of playtime by how old the games are: new = released this year.
    releases: [dist.new_releases, dist.recent_releases, dist.classic_releases].every(v => typeof v === "number")
      ? { newPct: pct(dist.new_releases), recentPct: pct(dist.recent_releases), classicPct: pct(dist.classic_releases),
          recentCutoff: int(dist.recent_cutoff_year) } : null,
    percentiles: bn.games_played_pct != null || bn.achievements_pct != null || bn.game_streak_pct != null
      ? { gamesPlayed: int(bn.games_played_pct), achievements: int(bn.achievements_pct), streak: int(bn.game_streak_pct) } : null,
  };
}

export function yearsToFetch(now, stored) {
  const y = now.getUTCFullYear(), month = now.getUTCMonth();
  const years = [];
  const last = stored[String(y - 1)];
  if (!last?.available || (month === 0 && last.fetchedAt?.slice(0, 4) !== String(y))) years.push(y - 1);
  if (month === 11) years.push(y);
  return years;
}

// A failed or private fetch never replaces a year that already has real data.
export function merge(stored, year, result, now) {
  const prev = stored[String(year)];
  if (!result.available && prev?.available) return { ...stored, [year]: { ...prev, lastError: result.reason, lastTried: now.toISOString() } };
  return { ...stored, [year]: { ...result, fetchedAt: now.toISOString() } };
}

async function steamGet(path, params) {
  const url = new URL(`https://api.steampowered.com/${path}/`);
  for (const [k, v] of Object.entries({ key: process.env.STEAM_API_KEY, ...params })) url.searchParams.set(k, v);
  const res = await fetch(url, { headers: { "User-Agent": "game-tracker (personal)" } });
  if (!res.ok) throw new Error(`${path} ${res.status}`);
  return res.json();
}

async function main() {
  if (!process.env.STEAM_API_KEY || !process.env.STEAM_ID) {
    console.log("STEAM_API_KEY / STEAM_ID not set; skipping Steam Replay.");
    return;
  }
  let stored = {};
  try { stored = JSON.parse(await fs.readFile(OUT, "utf8")); } catch {}
  const now = new Date();
  const asked = process.argv.slice(2).map(Number).filter(Boolean);
  const years = asked.length ? asked : yearsToFetch(now, stored);
  if (!years.length) { console.log("No Steam Replay year due (December-January only)."); return; }

  const owned = await steamGet("IPlayerService/GetOwnedGames/v1", {
    steamid: process.env.STEAM_ID, include_appinfo: 1, include_played_free_games: 1 });
  const names = new Map((owned.response?.games || []).map(g => [g.appid, g.name]));

  for (const year of years) {
    let result;
    try {
      const raw = await steamGet("ISaleFeatureService/GetUserYearInReview/v1", { steamid: process.env.STEAM_ID, year });
      result = normalizeReplay(raw, year, names);
    } catch (e) {
      result = { available: false, reason: String(e.message || e) };
    }
    stored = merge(stored, year, result, now);
    console.log(`Steam Replay ${year}: ${result.available ? `${result.topGames.length} top games, ${result.sessions ?? "?"} sessions` : result.reason}`);
  }
  await fs.writeFile(OUT, JSON.stringify(stored, null, 2) + "\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(e => { console.error(e); process.exit(1); });
}
