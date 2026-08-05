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
    return;
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
    if (!sg) continue;

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
}

export async function syncRA(games, log) {
  const raUser = process.env.RA_USER;
  if (!raUser || !process.env.RA_API_KEY) {
    log.push("RetroAchievements: missing RA_USER/RA_API_KEY, skipped");
    return;
  }
  const completed = await raGet("API_GetUserCompletedGames.php", { u: raUser });
  const byTitle = new Map();
  for (const g of completed) {
    // The endpoint lists one row per (game, hardcore/softcore) — keep whichever has more
    // awarded so a hardcore run doesn't get shadowed by a lower softcore count or vice versa.
    const existing = byTitle.get(g.Title);
    if (!existing || Number(g.NumAwarded) > Number(existing.NumAwarded)) byTitle.set(g.Title, g);
  }

  for (const [trackerTitle, raTitle] of Object.entries(RA_TITLE_MAP)) {
    const rg = byTitle.get(raTitle);
    if (!rg) continue;
    const entry = games.find(g => g.t === trackerTitle);
    if (!entry) continue;

    const earned = Number(rg.NumAwarded) || 0;
    const total = Number(rg.MaxPossible) || 0;
    const pct = total ? Math.round((earned / total) * 100) : 0;
    let changed = false;
    if (entry.achPct !== pct || JSON.stringify(entry.achCount) !== JSON.stringify([earned, total])) {
      entry.achPct = pct;
      entry.achCount = [earned, total];
      changed = true;
    }
    // API_GetUserCompletedGames doesn't carry a last-played date; leave lastPlayed alone
    // rather than guessing at one.
    if (changed) log.push(`RA · ${trackerTitle}: ${earned}/${total} (${pct}%)`);
  }
}

// Pushes the same derived shape the old PC-side PowerShell relay used to compute, straight
// to the Home Hub's existing endpoint — the hub's card, its rendering, and its Caddy route
// don't need to know or care that a GitHub Action is the one pushing now instead of a
// scheduled task on Jonny's PC re-parsing an HTML file over OneDrive.
export async function pushToHub(games, log) {
  const hubToken = process.env.HUB_STATUS_TOKEN;
  if (!hubToken) {
    log.push("Hub push: missing HUB_STATUS_TOKEN, skipped");
    return;
  }
  const detailFor = g => {
    if (g.achCount && Array.isArray(g.achCount) && g.achCount.length === 2) {
      return `${g.achCount[0]}/${g.achCount[1]} achievements`;
    }
    if (g.actualHours) return `${g.actualHours}h played`;
    return undefined;
  };

  const nowPlaying = games
    .filter(g => g.s === "playing")
    .sort((a, b) => (b.lastPlayed || "").localeCompare(a.lastPlayed || ""))
    .map(g => ({ name: g.t, platform: g.p, genre: g.g, detail: detailFor(g) }));

  // Array order, not queued-date order. The page numbers Up Next 1..N straight from
  // games.json's array order, and that order is now explicitly maintained (add.html's reorder
  // panel -> the Worker's /games/reorder). Sorting by `queued` here meant the hub card's #1
  // and the page's #1 were routinely different games — the hub showed whatever was queued most
  // recently, which is close to the opposite of a priority list. Also drops the `&& g.queued`
  // filter: a queued game with no date is still in the queue and still has a position.
  const upNext = games
    .filter(g => g.s === "queue")
    .slice(0, 4)
    .map(g => ({ name: g.t, platform: g.p, gotm: g.gotm || undefined }));

  const res = await fetch(`https://familyholocron.duckdns.org/game-tracker/update?token=${hubToken}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ now_playing: nowPlaying, up_next: upNext }),
  });
  if (!res.ok) throw new Error(`Hub push -> ${res.status}: ${await res.text()}`);
  log.push(`Hub: pushed ${nowPlaying.length} now-playing, ${upNext.length} up-next`);
}

async function main() {
  const games = JSON.parse(await fs.readFile("games.json", "utf8"));
  const log = [];

  const farmedAppids = await getRecentlyFarmedAppids(log);
  await syncSteam(games, log, farmedAppids);
  await syncRA(games, log);

  await fs.writeFile("games.json", JSON.stringify(games, null, 2) + "\n");
  await fs.writeFile("last-synced.json", JSON.stringify({ syncedAt: new Date().toISOString() }, null, 2) + "\n");

  // Hub push is independent of whether games.json actually changed today — the hub's card
  // should reflect current now-playing/up-next state even on a day with no Steam/RA deltas.
  try {
    await pushToHub(games, log);
  } catch (e) {
    log.push(`Hub push failed: ${e.message}`);
  }

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
