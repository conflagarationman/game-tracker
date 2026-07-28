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

// Tracker title -> Steam store name (matches game_tracker_update.py's STEAM_TITLE_MAP).
const STEAM_TITLE_MAP = {
  "Brotato": "Brotato",
  "Mina the Hollower": "Mina the Hollower",
  "Red Dead Redemption 2": "Red Dead Redemption 2",
  "ITTA": "ITTA",
  "Nodebuster": "Nodebuster",
  "Subnautica 2": "Subnautica 2",
  "Bzzzt": "BZZZT",
  "Vampire Crawlers": "Vampire Crawlers",
  "Summerhouse": "SUMMERHOUSE",
  "Steamworld Build": "SteamWorld Build",
  "Palworld": "Palworld",
  "Ori and the Blind Forest": "Ori and the Blind Forest: Definitive Edition",
  "A Plague Tale: Requiem": "A Plague Tale: Requiem",
  "Blasphemous": "Blasphemous",
  "Born of Bread": "Born of Bread",
  "To the Moon": "To the Moon",
  "The Messenger": "The Messenger",
  "Pentiment": "Pentiment",
  "Another Crab's Treasure": "Another Crab's Treasure",
  "Everhood": "Everhood",
  "Thymesia": "Thymesia",
  "Slay the Spire 2": "Slay the Spire 2",
  "Far Far West": "Far Far West",
  "Mail Time": "Mail Time",
  "V Rising": "V Rising",
  "The Invincible": "The Invincible",
};

// Tracker title -> Steam appid, only for the games achievement progress is tracked for.
const STEAM_ACH_APPIDS = {
  "Brotato": 1942280,
  "Mina the Hollower": 1875580,
  "Red Dead Redemption 2": 1174180,
  "ITTA": 775580,
  "Palworld": 1623730,
  "Nodebuster": 3107330,
  "Bzzzt": 1293170,
  "Vampire Crawlers": 3265700,
  "Summerhouse": 2533960,
  "Steamworld Build": 2134770,
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

export async function syncSteam(games, log) {
  const steamId = process.env.STEAM_ID;
  if (!process.env.STEAM_API_KEY || !steamId) {
    log.push("Steam: missing STEAM_API_KEY/STEAM_ID, skipped");
    return;
  }
  const owned = await steamGet("IPlayerService", "GetOwnedGames", 1, {
    steamid: steamId, include_appinfo: true, include_played_free_games: true,
  });
  const byName = new Map((owned.response.games || []).map(g => [g.name, g]));

  for (const [trackerTitle, steamName] of Object.entries(STEAM_TITLE_MAP)) {
    const sg = byName.get(steamName);
    if (!sg) continue;
    const entry = games.find(g => g.t === trackerTitle);
    if (!entry) continue;

    const hours = Math.round((sg.playtime_forever / 60) * 10) / 10;
    const lastPlayed = toDateStr(sg.rtime_last_played);
    let changed = false;
    if (hours && entry.actualHours !== hours) { entry.actualHours = hours; changed = true; }
    if (lastPlayed && entry.lastPlayed !== lastPlayed) { entry.lastPlayed = lastPlayed; changed = true; }

    const appid = STEAM_ACH_APPIDS[trackerTitle];
    if (appid) {
      try {
        const achRes = await steamGet("ISteamUserStats", "GetPlayerAchievements", 1, {
          steamid: steamId, appid, l: "en",
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
        log.push(`Steam achievements failed for "${trackerTitle}" (appid ${appid}): ${e.message}`);
      }
      await new Promise(r => setTimeout(r, 200)); // be polite to Steam's API
    }

    if (changed) log.push(`Steam · ${trackerTitle}: ${hours ?? "?"}h, achPct=${entry.achPct ?? "n/a"}`);
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

  const upNext = games
    .filter(g => g.s === "queue" && g.queued)
    .sort((a, b) => (b.queued || "").localeCompare(a.queued || ""))
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

  await syncSteam(games, log);
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
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(e => {
    console.error(e);
    process.exit(1);
  });
}
