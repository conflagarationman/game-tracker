#!/usr/bin/env node
// Daily Steam + RetroAchievements sync — the actual automation this tracker exists for.
// Runs via GitHub Actions (.github/workflows/sync-games.yml), commits games.json changes
// directly (no Cloudflare Worker needed: this is the only writer, there's no client-side
// editing yet, so there's nothing to merge/race against).
//
// Looks games up by id in the parsed JSON array rather than regex-matching text in an HTML
// file the way the old game_tracker_update.py did — that approach had a real bug (the
// Majora's Mask t:/start: collision) baked into its design; mutating parsed objects directly
// removes that whole class of problem rather than patching around it.

import fs from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { appendLedgerDay, formatLedger, steamUnlockRows, raUnlockRows, mergeUnlocks, raWindowStart, formatUnlocks } from "./ledger.mjs";

// Read inside functions, not cached as module-level consts at import time: ESM import
// statements are hoisted above other top-level code in the importing file, so a test that
// sets process.env.X before its own `import` line still loses the race — the module body
// (and any module-level `const X = process.env.X`) evaluates first regardless of source
// order. Reading fresh on each call sidesteps that entirely and is what actually let this
// get caught by a test instead of silently only working in production.
const STEAM_BASE = "https://api.steampowered.com";
const RA_BASE = "https://retroachievements.org/API";

// Steam sync used to require every game to be hand-added to a tracker-title -> Steam-name
// map (and a separate map just for achievement appids) before it would sync at all. That
// silently broke tracking for Halo: Campaign Evolved on its own release day — it was never
// added to the map, so syncSteam never even looked at it, despite hours of real playtime.
// Matching by normalized title against the actual owned-games list (same discipline as
// backfill-covers.mjs's cover-art matching) means a new game just needs the right title and
// platform in games.json — no code change needed to start syncing. The appid comes straight
// off the matched owned-game record, so the separate achievement-appid map is gone too.
function normalize(title) {
  // Diacritics folded first, same as backfill-covers.mjs: RA and Steam write "Pokémon", this
  // library writes "Pokemon".
  return title.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[:'".!™®]/g, "").replace(/\s+/g, " ").trim();
}

// A handful of tracker titles genuinely differ from their Steam store listing beyond
// case/punctuation (a real subtitle, not just formatting) — normalize() alone can't bridge
// these. Kept intentionally small: everything else matches automatically, no map upkeep.
// Exported for backfill-covers.mjs, which looks the same titles up on the Steam store.
export const STEAM_NAME_ALIASES = {
  "Ori and the Blind Forest": "Ori and the Blind Forest: Definitive Edition",
  "Shadow of Mordor": "Middle-earth: Shadow of Mordor",
  "Midnight Suns": "Marvel's Midnight Suns",
  "Placid Duck Simulator": "Placid Plastic Duck Simulator",
};

// RetroAchievements games are matched by title, the same way Steam is. This used to be a
// 22-entry map that every RA game had to be added to before it would sync, which is the exact
// shape that broke Halo on the Steam side: half the ayn/retro library was never on it, so the
// next retro game started would have silently never synced. Most of the old entries were
// either identical on both sides or the "Zelda: X" -> "The Legend of Zelda: X" pattern, both
// now handled by rule in raCandidates(). What's left are real title differences no rule
// derives. RA's "~Hack~ " style prefixes are also handled by rule (see raIndex()).
const RA_TITLE_MAP = {
  "999: Nine Hours, Nine Persons": "999: Nine Hours, Nine Persons, Nine Doors",
};

// Platforms that run through RA. Switch/PS5/Wii U have no RA support, so a same-titled game
// there must not pick up a handheld run's achievements.
const RA_PLATFORMS = new Set(["ayn", "retro"]);

// The RA titles to try for one tracker title, most-literal first.
export function raCandidates(title) {
  const out = [];
  const push = (t) => { if (t && !out.includes(t)) out.push(t); };
  push(RA_TITLE_MAP[title]);
  push(title);
  if (/^Zelda:\s*/i.test(title)) push(title.replace(/^Zelda:\s*/i, "The Legend of Zelda: "));
  return out;
}

// normalized RA title -> RA title. An exact title always wins over a prefix-stripped one, so a
// tracker "Tetris" can never be claimed by a "~Homebrew~ Tetris" when RA also has "Tetris".
function raIndex(raTitles) {
  const exact = new Map(), stripped = new Map();
  for (const t of raTitles) {
    exact.set(normalize(t), t);
    const m = /^~[^~]+~\s*(.+)$/.exec(t);
    if (m) stripped.set(normalize(m[1]), t);
  }
  return (key) => exact.get(key) || stripped.get(key) || null;
}

// tracker game id -> RA title, for every RA-platform game that matches one of `raTitles`.
// Only ever an exact normalized match: "Super Mario World" must never claim
// "Super Mario World 2: Yoshi's Island".
export function resolveRaTitles(games, raTitles) {
  const lookup = raIndex(raTitles);
  const out = new Map();
  for (const g of games) {
    if (!RA_PLATFORMS.has(g.p)) continue;
    for (const c of raCandidates(g.t)) {
      const hit = lookup(normalize(c));
      if (hit) { out.set(g.id, hit); break; }
    }
  }
  return out;
}

async function steamGet(iface, method, version, params) {
  const url = new URL(`${STEAM_BASE}/${iface}/${method}/v${version}/`);
  url.searchParams.set("key", process.env.STEAM_API_KEY);
  url.searchParams.set("format", "json");
  for (const [k, v] of Object.entries(params || {})) url.searchParams.set(k, v);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Steam ${method} -> ${res.status}`);
  return res.json();
}

async function raGet(endpoint, params) {
  const url = new URL(`${RA_BASE}/${endpoint}`);
  url.searchParams.set("z", process.env.RA_USER);
  url.searchParams.set("y", process.env.RA_API_KEY);
  for (const [k, v] of Object.entries(params || {})) url.searchParams.set(k, v);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`RA ${endpoint} -> ${res.status}`);
  return res.json();
}

function toDateStr(unixSeconds) {
  if (!unixSeconds) return null;
  return new Date(unixSeconds * 1000).toISOString().slice(0, 10);
}

// RA's own lastPlayed comes back like "2026-06-15 22:21:05" — normalize the same way.
function raDateStr(s) {
  if (!s) return null;
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

// GET a read-only ASF route on the hub. With HUB_ASF_TOKEN set it goes in an Authorization
// header (nothing secret in the URL, so it stays out of Caddy's access log). While that secret
// is unset, fall back to the old master-token query string. TODO: drop the fallback once
// HUB_ASF_TOKEN is set in the repo secrets.
async function hubAsfFetch(path) {
  const asfToken = process.env.HUB_ASF_TOKEN;
  const base = `https://familyholocron.duckdns.org${path}`;
  if (asfToken) return fetch(base, { headers: { Authorization: `Bearer ${asfToken}` } });
  return fetch(`${base}?token=${process.env.HUB_STATUS_TOKEN}`);
}

// Soft failures: pushed to the run log as before, and also to `warnings`, which main() writes
// into last-synced.json so the hub's health check can see them. Short strings, no secrets.
function softFail(log, warnings, msg, warning) {
  log.push(msg);
  warnings.push(warning);
}

// ASF idles owned games in the background to farm trading cards, which bumps Steam's own
// playtime_forever/rtime_last_played exactly like real play would — so a tracked game that
// still has unfarmed cards can falsely show as "played today" with inflated hours purely
// from idling. The hub's /asf/recently-farmed endpoint greps ASF's own Docker logs for
// "Now/Still farming: <appid>" lines, which is ground truth for which appids are currently
// being idled. Achievement progress is unaffected by idling (ASF doesn't unlock those), so
// only actualHours/lastPlayed need to be skipped for a farmed appid, not achievements.
// Despite the name, "recently" has no time limit: it is every appid in the hub's last 3000 log
// lines, which on ASF's quiet log reaches back about two months. So it is now only the fallback
// for when the farm ledger is unavailable; see getFarmingNow().
export async function getRecentlyFarmedAppids(log, warnings = []) {
  if (!process.env.HUB_ASF_TOKEN && !process.env.HUB_STATUS_TOKEN) {
    softFail(log, warnings, "ASF farmed-appids check: missing HUB_STATUS_TOKEN, skipped (playtime may include idle time)",
      "ASF recently-farmed skipped: no hub token set");
    return new Set();
  }
  try {
    const res = await hubAsfFetch("/asf/recently-farmed");
    if (!res.ok) throw new Error(`-> ${res.status}`);
    const data = await res.json();
    return new Set(data.recently_farmed_appids || []);
  } catch (e) {
    softFail(log, warnings, `ASF farmed-appids check failed: ${e.message} (playtime may include idle time)`,
      `ASF recently-farmed fetch failed: ${e.message}`);
    return new Set();
  }
}

// The hub's ASF farm ledger (/asf/farm-ledger): minutes ASF idled each appid, per UTC day,
// since the ledger began. getRecentlyFarmedAppids() above only lists what ASF farmed lately, so
// before this the idled hours landed in actualHours once farming moved on. With it, actualHours
// is Steam playtime minus known idling, and the play check's 14-day minutes are too. Idling from
// before the ledger's coverage can't be known. `openAppids` is what ASF is farming at this
// minute (the ledger's open interval), the only games whose playtime still has to be skipped.
export function summarizeLedger(ledger, today = new Date()) {
  const cutoff = new Date(today.getTime() - PLAY_CHECK_DAYS * 86400000).toISOString().slice(0, 10);
  const byAppid = new Map();
  for (const [appid, app] of Object.entries(ledger?.apps || {})) {
    const days = Object.entries(app.days || {});
    const total = days.reduce((s, [, m]) => s + m, 0);
    const recent = days.filter(([d]) => d >= cutoff).reduce((s, [, m]) => s + m, 0);
    byAppid.set(Number(appid), { name: app.name || null, total, recent, days: new Map(days),
      lastDay: days.map(([d]) => d).sort().pop() || null, finished: app.finished || null });
  }
  return { byAppid, coverageFrom: ledger?.coverage_from ? ledger.coverage_from.slice(0, 10) : null,
    openAppids: new Set((ledger?.open?.appids || []).map(Number)) };
}

// Which appids to skip outright this run, because ASF is idling them right now and the ledger
// hasn't credited the current minutes yet. With the ledger, that is exactly its open interval.
// Using the hub's recently-farmed list instead (as the sync did until 2026-10) froze actualHours
// and lastPlayed for every game farmed in the last ~2 months, 50+ of them, including games being
// played for real (Steep stayed at 9.2h while being played). Recently-farmed is the fallback only.
export async function getFarmingNow(asf, log, warnings = []) {
  return asf ? asf.openAppids : getRecentlyFarmedAppids(log, warnings);
}

export async function getAsfLedger(log, warnings = []) {
  if (!process.env.HUB_ASF_TOKEN && !process.env.HUB_STATUS_TOKEN) {
    softFail(log, warnings, "ASF farm ledger: missing HUB_STATUS_TOKEN, skipped (hours include past idling)",
      "ASF farm ledger skipped: no hub token set; hours include idling");
    return null;
  }
  try {
    const res = await hubAsfFetch("/asf/farm-ledger");
    if (!res.ok) throw new Error(`-> ${res.status}`);
    return summarizeLedger(await res.json());
  } catch (e) {
    softFail(log, warnings, `ASF farm ledger failed: ${e.message} (hours include past idling)`,
      `ASF farm ledger fetch failed: ${e.message}; hours include idling`);
    return null;
  }
}

// asf-idle.json: what wrapped.html shows about card farming, and per tracked game how much
// idling was taken out of its hours.
export function buildAsfIdle(games, steamOwned, asf, today = new Date()) {
  if (!asf) return null;
  const nameOf = new Map(steamOwned.map(sg => [sg.appid, sg.name]));
  const gameByName = new Map();
  for (const g of games) {
    gameByName.set(normalize(g.t), g);
    if (STEAM_NAME_ALIASES[g.t]) gameByName.set(normalize(STEAM_NAME_ALIASES[g.t]), g);
  }
  const byGame = {}, years = {};
  for (const [appid, a] of asf.byAppid) {
    const name = nameOf.get(appid) || a.name || `App ${appid}`;
    const g = gameByName.get(normalize(name));
    if (g && a.total >= 6) byGame[g.id] = { appid, idleHours: Math.round(a.total / 6) / 10, lastIdle: a.lastDay, finished: a.finished };
    const perYear = {};
    for (const [day, m] of a.days) perYear[day.slice(0, 4)] = (perYear[day.slice(0, 4)] || 0) + m;
    for (const [y, m] of Object.entries(perYear)) {
      const Y = (years[y] ||= { minutes: 0, games: [], finished: 0 });
      Y.minutes += m;
      Y.games.push({ name, hours: Math.round(m / 6) / 10, id: g ? g.id : null });
      if (a.finished && a.finished.startsWith(y)) Y.finished++;
    }
  }
  for (const Y of Object.values(years)) {
    Y.hours = Math.round(Y.minutes / 6) / 10;
    Y.gameCount = Y.games.length;
    Y.games = Y.games.sort((a, b) => b.hours - a.hours).slice(0, 8);
    delete Y.minutes;
  }
  return { asOf: today.toISOString(), coverageFrom: asf.coverageFrom, years, byGame };
}

// `sink.steamUnlocks`, when passed, receives every tracked game's unlock rows (with timestamps,
// which the counts below throw away) and `sink.appidOf` each matched game's appid, for
// achievements-log.json.
export async function syncSteam(games, log, farmedAppids = new Set(), asf = null, sink = {}) {
  sink.steamUnlocks = [];
  sink.appidOf = {};
  const steamId = process.env.STEAM_ID;
  if (!process.env.STEAM_API_KEY || !steamId) {
    log.push("Steam: missing STEAM_API_KEY/STEAM_ID, skipped");
    return [];
  }
  const owned = await steamGet("IPlayerService", "GetOwnedGames", 1, {
    steamid: steamId, include_appinfo: true, include_played_free_games: true,
  });
  const byNormalizedName = new Map(
    (owned.response.games || []).map(g => [normalize(g.name), g])
  );

  for (const entry of games) {
    if (entry.p !== "steam" && entry.p !== "steamdeck") continue; // only these run through Steam
    const searchName = STEAM_NAME_ALIASES[entry.t] || entry.t;
    const sg = byNormalizedName.get(normalize(searchName));
    if (!sg) {
      // A silent miss here is exactly what broke Halo (see above) — except that had playtime
      // to notice missing. A game GetOwnedGames simply never returns (some free/tool-type
      // apps aren't included even with include_played_free_games) would otherwise sit at
      // null forever with no signal anything was wrong. Same discipline as backfill-covers.mjs's
      // declines: name what the source actually offered instead of just saying "not found".
      const firstWord = normalize(searchName).split(" ")[0];
      const near = firstWord
        ? [...byNormalizedName.values()].filter(g => normalize(g.name).includes(firstWord)).slice(0, 5)
        : [];
      const suffix = near.length
        ? ` — closest owned titles: ${near.map(g => `"${g.name}"`).join(", ")}`
        : "";
      log.push(`Steam: no library match for "${entry.t}" among ${byNormalizedName.size} owned titles${suffix}`);
      continue;
    }

    const isFarming = farmedAppids.has(sg.appid);
    const idle = asf ? asf.byAppid.get(sg.appid) : null;
    // Steam playtime minus every minute the ledger saw ASF idle this appid.
    const rawMinutes = sg.playtime_forever || 0;
    const netMinutes = Math.max(0, rawMinutes - (idle ? idle.total : 0));
    const hours = Math.round((netMinutes / 60) * 10) / 10;
    const lastPlayed = toDateStr(sg.rtime_last_played);
    // Idling bumps rtime_last_played too. A last-played day ASF spent idling, with no real
    // play left in the 14-day window once idling is taken out, isn't a day you played.
    const realRecentMins = (sg.playtime_2weeks || 0) - (idle ? idle.recent : 0);
    const idleOnlyDay = idle && lastPlayed && idle.days.has(lastPlayed) && realRecentMins < 5;
    let changed = false;
    if (isFarming) {
      log.push(`Steam · ${entry.t}: skipped playtime/lastPlayed (ASF is idling appid ${sg.appid} for cards)`);
    } else {
      if (rawMinutes && entry.actualHours !== (hours || null)) { entry.actualHours = hours || null; changed = true; }
      if (lastPlayed && entry.lastPlayed !== lastPlayed && !idleOnlyDay) { entry.lastPlayed = lastPlayed; changed = true; }
      if (idle && idle.total >= 6 && changed) log.push(`Steam · ${entry.t}: ${Math.round(idle.total / 6) / 10}h of ASF idling taken out of ${Math.round(rawMinutes / 6) / 10}h`);
    }

    // appid comes straight off the matched owned-game record now, so every matched game
    // gets checked for achievements, not just the ones on a separately curated list. Games
    // with no achievement schema (Steam responds 200 with success:false, not an error) just
    // silently don't update achPct below — nothing to log, that's an expected, common case.
    try {
      const achRes = await steamGet("ISteamUserStats", "GetPlayerAchievements", 1, {
        steamid: steamId, appid: sg.appid, l: "en",
      });
      const stats = achRes.playerstats;
      if (stats && stats.success && stats.achievements) {
        sink.steamUnlocks.push(...steamUnlockRows(entry, sg.appid, stats.achievements));
        sink.appidOf[entry.id] = sg.appid;
        const total = stats.achievements.length;
        const earned = stats.achievements.filter(a => a.achieved === 1).length;
        const pct = total ? Math.round((earned / total) * 100) : 0;
        if (entry.achPct !== pct || JSON.stringify(entry.achCount) !== JSON.stringify([earned, total])) {
          entry.achPct = pct;
          entry.achCount = [earned, total];
          changed = true;
        }
      }
    } catch (e) {
      log.push(`Steam achievements failed for "${entry.t}" (appid ${sg.appid}): ${e.message}`);
    }
    await new Promise(r => setTimeout(r, 200)); // be polite to Steam's API

    if (changed) log.push(`Steam · ${entry.t}: ${hours ?? "?"}h, achPct=${entry.achPct ?? "n/a"}`);
  }
  // Returned for buildPlayCheck(), which needs the whole library (including games the
  // tracker doesn't know about) and each game's playtime_2weeks.
  return owned.response.games || [];
}

// `sink.raGames`, when passed, receives every RA game with any progress (one row per game,
// the better of hardcore/softcore), for buildLibrary().
export async function syncRA(games, log, sink = {}) {
  const raUser = process.env.RA_USER;
  if (!raUser || !process.env.RA_API_KEY) {
    log.push("RetroAchievements: missing RA_USER/RA_API_KEY, skipped");
    return new Map();
  }
  const completed = await raGet("API_GetUserCompletedGames.php", { u: raUser });
  const byTitle = new Map();
  for (const g of Array.isArray(completed) ? completed : []) {
    // The endpoint lists one row per (game, hardcore/softcore) — keep whichever has more
    // awarded so a hardcore run doesn't get shadowed by a lower softcore count or vice versa.
    const existing = byTitle.get(g.Title);
    if (!existing || Number(g.NumAwarded) > Number(existing.NumAwarded)) byTitle.set(g.Title, g);
  }
  sink.raGames = [...byTitle.values()];

  // API_GetUserCompletedGames carries no play date, so for a long time NOTHING updated
  // lastPlayed on a RetroAchievements game — only the Steam path ever wrote that field.
  // The visible symptom: Castlevania: Symphony of the Night sat at lastPlayed 2026-07-08
  // while actively being played, which made the tracker badge it "dormant" and the Home
  // Hub's Backlog Pressure card call it stale. Its achievement counts were updating the
  // whole time, so the record looked synced.
  //
  // API_GetUserRecentlyPlayedGames does carry LastPlayed. One extra call covers every
  // actively-played game, which is exactly the case that was broken. A game that has
  // dropped off the recent window is genuinely not recent, so leaving its stored date
  // alone is the right outcome rather than a gap worth N per-game calls to close.
  const playedByTitle = new Map();
  try {
    const recent = await raGet("API_GetUserRecentlyPlayedGames.php", { u: raUser, c: 50 });
    for (const g of Array.isArray(recent) ? recent : []) {
      const d = raDateStr(g.LastPlayed);
      if (!d || !g.Title) continue;
      const prev = playedByTitle.get(g.Title);
      if (!prev || d > prev) playedByTitle.set(g.Title, d);
    }
  } catch (e) {
    // Achievement counts above already synced — don't lose them to a failure here.
    log.push(`RA recently-played lookup failed: ${e.message} (lastPlayed not refreshed)`);
  }

  const matched = resolveRaTitles(games, [...byTitle.keys(), ...playedByTitle.keys()]);
  for (const entry of games) {
    if (!RA_PLATFORMS.has(entry.p)) continue;
    const raTitle = matched.get(entry.id);
    if (!raTitle) {
      // Only worth a line for something being played now: most of the retro library is
      // finished games that simply have no RA activity, and listing them daily is noise.
      if (entry.s === "playing" || entry.s === "ongoing") {
        log.push(`RA: no match for "${entry.t}" among ${byTitle.size} awarded + ${playedByTitle.size} recent titles (add an RA_TITLE_MAP entry if RA names it differently)`);
      }
      continue;
    }
    const trackerTitle = entry.t;
    let changed = false;
    const parts = [];

    // Achievements and lastPlayed come from different endpoints and are handled
    // independently: a game freshly started has a recent play date but may not appear in
    // the completed-games list at all yet.
    const rg = byTitle.get(raTitle);
    if (rg) {
      const earned = Number(rg.NumAwarded) || 0;
      const total = Number(rg.MaxPossible) || 0;
      const pct = total ? Math.round((earned / total) * 100) : 0;
      if (entry.achPct !== pct || JSON.stringify(entry.achCount) !== JSON.stringify([earned, total])) {
        entry.achPct = pct;
        entry.achCount = [earned, total];
        changed = true;
      }
      parts.push(`${earned}/${total} (${pct}%)`);
    }

    // Only ever move lastPlayed forward. The recent-games list is a rolling window, and a
    // stale row from it must never drag a newer date backwards.
    const played = playedByTitle.get(raTitle);
    if (played && (!entry.lastPlayed || played > entry.lastPlayed)) {
      entry.lastPlayed = played;
      changed = true;
      parts.push(`lastPlayed -> ${played}`);
    }

    if (changed) log.push(`RA · ${trackerTitle}: ${parts.join(", ")}`);
  }
  // RA title -> latest play date, for buildPlayCheck().
  return playedByTitle;
}

// ─── Unlock log (achievements-log.json) ───────────────────
// RA's unlocks over a window: from just before the newest RA row already logged (or Jan 1 for
// an empty log) to now. Every RA game counts, tracked or not; `id` is set when the tracker has it.
export async function syncRaUnlocks(games, log, existingRows = [], now = new Date()) {
  const raUser = process.env.RA_USER;
  if (!raUser || !process.env.RA_API_KEY) return [];
  try {
    const earned = await raGet("API_GetAchievementsEarnedBetween.php", {
      u: raUser, f: Math.floor(raWindowStart(existingRows, now)), t: Math.floor(now.getTime() / 1000) });
    const titles = [...new Set((Array.isArray(earned) ? earned : []).map(a => a.GameTitle).filter(Boolean))];
    const byTitle = new Map([...resolveRaTitles(games, titles)].map(([id, t]) => [t, id]));
    return raUnlockRows(earned, (t) => byTitle.get(t) ?? null);
  } catch (e) {
    log.push(`RA unlock log failed: ${e.message} (achievements-log.json keeps its rows)`);
    return [];
  }
}

// Steam's global unlock percentage for this year's unlocks that don't have one yet, one call per
// game, for the "rarest unlock" card. A game whose stats are hidden just stays without.
export async function fillGlobalPcts(rows, appidOf, log, year = new Date().getUTCFullYear()) {
  const from = Date.UTC(year, 0, 1) / 1000;
  const want = new Map();
  for (const r of rows) {
    if (r.src !== "steam" || r.pct != null || r.ts < from || !appidOf[r.id]) continue;
    const appid = appidOf[r.id];
    if (!want.has(appid)) want.set(appid, []);
    want.get(appid).push(r);
  }
  for (const [appid, list] of want) {
    try {
      const res = await steamGet("ISteamUserStats", "GetGlobalAchievementPercentagesForApp", 2, { gameid: appid });
      const pct = new Map((res.achievementpercentages?.achievements || []).map(a => [a.name, Number(a.percent)]));
      for (const r of list) {
        const p = pct.get(r.key.split(":").slice(2).join(":"));
        if (Number.isFinite(p)) r.pct = Math.round(p * 10) / 10;
      }
    } catch (e) {
      log.push(`Steam global achievement % failed for appid ${appid}: ${e.message}`);
    }
    await new Promise(r => setTimeout(r, 200));
  }
}

// ─── Library (for the owl's wildcards) ────────────────────
// Every owned Steam game and every RetroAchievements game with progress, so owl.html can
// suggest games that aren't in the tracker yet: old favourites, acclaimed games never started,
// half-finished retro runs. Published in full on purpose (Jonny's call; this repo is public).
// Steam hours have the ASF ledger's recorded card idling taken out, like actualHours, so a
// farmed-but-never-played game doesn't pass for a favourite. Idling from before the ledger
// existed can't be known, which is why the owl's "favourite" bar is set well above what card
// farming typically leaves behind.
export function buildLibrary(steamOwned = [], raGames = [], asf = null) {
  const steam = steamOwned.map(g => {
    const idle = asf && asf.byAppid.get(g.appid);
    const mins = Math.max(0, (g.playtime_forever || 0) - (idle ? idle.total : 0));
    return {
      appid: g.appid,
      name: g.name,
      hours: Math.round(mins / 6) / 10,
      lastPlayed: g.rtime_last_played ? toDateStr(g.rtime_last_played) : null,
    };
  }).sort((a, b) => a.appid - b.appid);
  const ra = raGames.map(g => ({
    gameId: Number(g.GameID) || null,
    title: g.Title,
    console: g.ConsoleName || null,
    earned: Number(g.NumAwarded) || 0,
    total: Number(g.MaxPossible) || 0,
  })).filter(g => g.title).sort((a, b) => String(a.title).localeCompare(String(b.title)));
  return { steam, ra };
}

// One game per line: the file is rewritten daily, and this keeps a day's commit to the rows
// whose hours actually moved. No timestamp inside, so an unchanged library is no commit at all
// (last-synced.json already says when the sync ran).
export function formatLibrary(lib) {
  const rows = (xs) => xs.length ? "\n" + xs.map(x => "  " + JSON.stringify(x)).join(",\n") + "\n" : "";
  return `{"steam": [${rows(lib.steam)}],\n"ra": [${rows(lib.ra)}]}\n`;
}

// ─── Play check ───────────────────────────────────────────
// Compares what games.json says you're playing against what Steam and RA say you actually
// played. This replaces a Mac scheduled task that used to do a version of this locally and
// died quietly; living in the daily sync means it runs where failures are already watched.
//
// Deliberately does NOT re-flag idle Now Playing games: index.html already badges those
// "dormant" from lastPlayed. What nothing else could see is the other direction, a game with
// real recent play that isn't marked playing, plus actual recent hours rather than lifetime.
//
// Only Steam and RA are sources. pc/switch/ps5/wiiu games without RA have no play data at
// all, so they can never appear here, which is the right outcome rather than a gap.
export const PLAY_CHECK_DAYS = 14;         // Steam's playtime_2weeks window; RA uses the same
export const UNTRACKED_MIN_MINUTES = 60;   // below this, a stray launch isn't worth a nudge

// Steam "games" that run in the background rather than get played, so their hours say nothing
// about what you're playing. Read off a real run's untracked list, never guessed: Bongo Cat
// (a desktop pet) logged 13.8h in the first run's window. Only affects the untracked list.
const PLAY_CHECK_IGNORE = new Set(["Bongo Cat"].map(normalize));

export function buildPlayCheck(games, { steamOwned = [], farmedAppids = new Set(), raPlayed = new Map(), asf = null } = {}, today = new Date()) {
  // Title lookup across every platform: a game tracked as "switch" but played on Steam is
  // still a known game, and reporting it as untracked would be wrong.
  const byName = new Map();
  for (const g of games) {
    byName.set(normalize(g.t), g);
    if (STEAM_NAME_ALIASES[g.t]) byName.set(normalize(STEAM_NAME_ALIASES[g.t]), g);
  }
  const raMatched = resolveRaTitles(games, [...raPlayed.keys()]);
  const raToGame = new Map([...raMatched].map(([id, t]) => [t, games.find(g => g.id === id)]));

  const recent = {};   // tracked id -> { mins?, lastPlayed? }
  const untracked = [];
  for (const sg of steamOwned) {
    // ASF idling inflates playtime_2weeks exactly like playtime_forever (see above): skip what
    // it's farming now, and take the ledger's last 14 days of idling out of everything else.
    const idleRecent = asf && asf.byAppid.get(sg.appid) ? asf.byAppid.get(sg.appid).recent : 0;
    const mins = Math.max(0, Math.round((sg.playtime_2weeks || 0) - idleRecent));
    if (!mins || farmedAppids.has(sg.appid)) continue;
    const g = byName.get(normalize(sg.name));
    if (g) recent[g.id] = { ...recent[g.id], mins };
    else if (mins >= UNTRACKED_MIN_MINUTES && !PLAY_CHECK_IGNORE.has(normalize(sg.name))) untracked.push({ title: sg.name, source: "steam", mins });
  }

  const cutoff = new Date(today.getTime() - PLAY_CHECK_DAYS * 86400000).toISOString().slice(0, 10);
  for (const [raTitle, date] of raPlayed) {
    if (date < cutoff) continue;
    const g = raToGame.get(raTitle) || byName.get(normalize(raTitle));
    if (g) recent[g.id] = { ...recent[g.id], lastPlayed: date };
    else untracked.push({ title: raTitle, source: "ra", lastPlayed: date });
  }

  const offList = games
    .filter(g => recent[g.id] && g.s !== "playing" && g.s !== "ongoing")
    .map(g => ({ id: g.id, t: g.t, s: g.s, ...recent[g.id] }));

  const byMins = (a, b) => (b.mins || 0) - (a.mins || 0) || String(b.lastPlayed).localeCompare(String(a.lastPlayed));
  offList.sort(byMins);
  untracked.sort(byMins);
  return { windowDays: PLAY_CHECK_DAYS, recent, offList, untracked };
}

function fmtActivity(x) {
  const bits = [];
  if (x.mins) bits.push(`${Math.round(x.mins / 6) / 10}h in ${PLAY_CHECK_DAYS}d`);
  if (x.lastPlayed) bits.push(`RA ${x.lastPlayed}`);
  return bits.join(", ");
}

export function playCheckSummary(check, games) {
  const lines = ["## Play check", ""];
  const playing = games.filter(g => g.s === "playing");
  lines.push(`**Now Playing, last ${check.windowDays} days**`, "");
  for (const g of playing) {
    const r = check.recent[g.id];
    lines.push(`- ${g.t}: ${r ? fmtActivity(r) : "no Steam/RA play"}`);
  }
  if (!playing.length) lines.push("- (nothing marked playing)");
  lines.push("", "**Played lately but not marked playing**", "");
  for (const x of check.offList) lines.push(`- ${x.t} (${x.s}): ${fmtActivity(x)}`);
  if (!check.offList.length) lines.push("- none");
  lines.push("", "**Played lately but not in the tracker**", "");
  for (const x of check.untracked) lines.push(`- ${x.title}: ${fmtActivity(x)}`);
  if (!check.untracked.length) lines.push("- none");
  return lines.join("\n") + "\n";
}

async function main() {
  const games = JSON.parse(await fs.readFile("games.json", "utf8"));
  const log = [];
  const warnings = [];

  const asf = await getAsfLedger(log, warnings);
  const farmedAppids = await getFarmingNow(asf, log, warnings);
  const steamSink = {};
  const steamOwned = await syncSteam(games, log, farmedAppids, asf, steamSink);
  const raSink = {};
  const raPlayed = await syncRA(games, log, raSink);

  // The year in review's two ledgers (see ledger.mjs). Read back if they exist, merged, written.
  const readJson = async (f) => { try { return JSON.parse(await fs.readFile(f, "utf8")); } catch { return null; } };
  const ledger = appendLedgerDay(await readJson("ledger.json"), games, new Date().toISOString().slice(0, 10));
  await fs.writeFile("ledger.json", formatLedger(ledger));
  const logged = (await readJson("achievements-log.json"))?.unlocks || [];
  const unlocks = mergeUnlocks(logged, [...steamSink.steamUnlocks, ...await syncRaUnlocks(games, log, logged)]);
  await fillGlobalPcts(unlocks.rows, steamSink.appidOf, log);
  await fs.writeFile("achievements-log.json", formatUnlocks(unlocks.rows));
  if (unlocks.added) log.push(`Unlock log: ${unlocks.added} new unlocks (${unlocks.rows.length} in all)`);
  const check = buildPlayCheck(games, { steamOwned, farmedAppids, raPlayed, asf });
  const asfIdle = buildAsfIdle(games, steamOwned, asf);
  // Only rewritten when the ledger answered, so a hub outage keeps the last good copy.
  if (asfIdle) await fs.writeFile("asf-idle.json", JSON.stringify(asfIdle, null, 2) + "\n");

  await fs.writeFile("games.json", JSON.stringify(games, null, 2) + "\n");
  await fs.writeFile("play-check.json", JSON.stringify(check, null, 2) + "\n");
  // Only rewritten when Steam answered, so a Steam outage keeps the last good library.
  if (steamOwned.length) await fs.writeFile("library.json", formatLibrary(buildLibrary(steamOwned, raSink.raGames || [], asf)));
  if (process.env.GITHUB_STEP_SUMMARY) {
    await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, playCheckSummary(check, games));
  }
  await fs.writeFile("last-synced.json", JSON.stringify({ syncedAt: new Date().toISOString(), warnings }, null, 2) + "\n");

  console.log(log.length ? log.join("\n") : "No changes.");
}

// Only runs when executed directly (node scripts/sync-apis.mjs) — importing this module for
// tests must not trigger a real sync against the actual games.json file and live APIs.
// pathToFileURL (not manual string-building) so this is correct on Windows too, not just
// the Linux Actions runner this actually ships on.
// argv[1] is undefined under `node -e` / `--input-type=module`, and pathToFileURL throws on
// undefined rather than returning null — so guard it, or merely *importing* this module from
// such a context crashes before any of its exports can be used.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(e => {
    console.error(e);
    process.exit(1);
  });
}
