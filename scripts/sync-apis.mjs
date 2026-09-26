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
  return title.toLowerCase().replace(/[:'".!™®]/g, "").replace(/\s+/g, " ").trim();
}

// A handful of tracker titles genuinely differ from their Steam store listing beyond
// case/punctuation (a real subtitle, not just formatting) — normalize() alone can't bridge
// these. Kept intentionally small: everything else matches automatically, no map upkeep.
const STEAM_NAME_ALIASES = {
  "Ori and the Blind Forest": "Ori and the Blind Forest: Definitive Edition",
  "Shadow of Mordor": "Middle-earth: Shadow of Mordor",
  "Midnight Suns": "Marvel's Midnight Suns",
  "Placid Duck Simulator": "Placid Plastic Duck Simulator",
};

// Tracker title -> RetroAchievements game title (matches game_tracker_update.py's RA_TITLE_MAP).
const RA_TITLE_MAP = {
  "Zelda: A Link to the Past": "The Legend of Zelda: A Link to the Past",
  "The Legendary Starfy": "The Legendary Starfy",
  "God of War": "God of War",
  "Tetris": "Tetris",
  "Castlevania: Symphony of the Night": "Castlevania: Symphony of the Night",
  "Castlevania: Aria of Sorrow": "Castlevania: Aria of Sorrow",
  "Super Mario World 2: Yoshi's Island": "Super Mario World 2: Yoshi's Island",
  "Zelda: Oracle of Seasons": "The Legend of Zelda: Oracle of Seasons",
  "Zelda: Oracle of Ages": "The Legend of Zelda: Oracle of Ages",
  "Zelda: Phantom Hourglass": "The Legend of Zelda: Phantom Hourglass",
  "Zelda: Spirit Tracks": "The Legend of Zelda: Spirit Tracks",
  "999: Nine Hours, Nine Persons": "999: Nine Hours, Nine Persons, Nine Doors",
  "Alien Hominid": "Alien Hominid",
  "Chrono Trigger": "Chrono Trigger",
  "Super Metroid": "Super Metroid",
  "DuckTales": "DuckTales",
  "Super Mario RPG": "Super Mario RPG",
  "Pokemon Odyssey": "Pokemon Odyssey",
  "Advance Wars": "Advance Wars",
  "Wario Land 4": "Wario Land 4",
  "Metroid: Samus Returns": "Metroid: Samus Returns",
  "Pokemon Lazarus": "~Hack~ Pokémon Lazarus",
};

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

// ASF idles owned games in the background to farm trading cards, which bumps Steam's own
// playtime_forever/rtime_last_played exactly like real play would — so a tracked game that
// still has unfarmed cards can falsely show as "played today" with inflated hours purely
// from idling. The hub's /asf/recently-farmed endpoint greps ASF's own Docker logs for
// "Now/Still farming: <appid>" lines, which is ground truth for which appids are currently
// being idled. Achievement progress is unaffected by idling (ASF doesn't unlock those), so
// only actualHours/lastPlayed need to be skipped for a farmed appid, not achievements.
export async function getRecentlyFarmedAppids(log) {
  const hubToken = process.env.HUB_STATUS_TOKEN;
  if (!hubToken) {
    log.push("ASF farmed-appids check: missing HUB_STATUS_TOKEN, skipped (playtime may include idle time)");
    return new Set();
  }
  try {
    const res = await fetch(`https://familyholocron.duckdns.org/asf/recently-farmed?token=${hubToken}`);
    if (!res.ok) throw new Error(`-> ${res.status}`);
    const data = await res.json();
    return new Set(data.recently_farmed_appids || []);
  } catch (e) {
    log.push(`ASF farmed-appids check failed: ${e.message} (playtime may include idle time)`);
    return new Set();
  }
}

export async function syncSteam(games, log, farmedAppids = new Set()) {
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
    const hours = Math.round((sg.playtime_forever / 60) * 10) / 10;
    const lastPlayed = toDateStr(sg.rtime_last_played);
    let changed = false;
    if (isFarming) {
      log.push(`Steam · ${entry.t}: skipped playtime/lastPlayed (ASF is idling appid ${sg.appid} for cards)`);
    } else {
      if (hours && entry.actualHours !== hours) { entry.actualHours = hours; changed = true; }
      if (lastPlayed && entry.lastPlayed !== lastPlayed) { entry.lastPlayed = lastPlayed; changed = true; }
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

export async function syncRA(games, log) {
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

  for (const [trackerTitle, raTitle] of Object.entries(RA_TITLE_MAP)) {
    const entry = games.find(g => g.t === trackerTitle);
    if (!entry) continue;
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

export function buildPlayCheck(games, { steamOwned = [], farmedAppids = new Set(), raPlayed = new Map() } = {}, today = new Date()) {
  // Title lookup across every platform: a game tracked as "switch" but played on Steam is
  // still a known game, and reporting it as untracked would be wrong.
  const byName = new Map();
  for (const g of games) {
    byName.set(normalize(g.t), g);
    if (STEAM_NAME_ALIASES[g.t]) byName.set(normalize(STEAM_NAME_ALIASES[g.t]), g);
    if (RA_TITLE_MAP[g.t]) byName.set(normalize(RA_TITLE_MAP[g.t]), g);
  }

  const recent = {};   // tracked id -> { mins?, lastPlayed? }
  const untracked = [];
  for (const sg of steamOwned) {
    const mins = sg.playtime_2weeks || 0;
    // ASF idling inflates playtime_2weeks exactly like playtime_forever (see above).
    if (!mins || farmedAppids.has(sg.appid)) continue;
    const g = byName.get(normalize(sg.name));
    if (g) recent[g.id] = { ...recent[g.id], mins };
    else if (mins >= UNTRACKED_MIN_MINUTES) untracked.push({ title: sg.name, source: "steam", mins });
  }

  const cutoff = new Date(today.getTime() - PLAY_CHECK_DAYS * 86400000).toISOString().slice(0, 10);
  for (const [raTitle, date] of raPlayed) {
    if (date < cutoff) continue;
    const g = byName.get(normalize(raTitle));
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

  const farmedAppids = await getRecentlyFarmedAppids(log);
  const steamOwned = await syncSteam(games, log, farmedAppids);
  const raPlayed = await syncRA(games, log);
  const check = buildPlayCheck(games, { steamOwned, farmedAppids, raPlayed });

  await fs.writeFile("games.json", JSON.stringify(games, null, 2) + "\n");
  await fs.writeFile("play-check.json", JSON.stringify(check, null, 2) + "\n");
  if (process.env.GITHUB_STEP_SUMMARY) {
    await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, playCheckSummary(check, games));
  }
  await fs.writeFile("last-synced.json", JSON.stringify({ syncedAt: new Date().toISOString() }, null, 2) + "\n");

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
