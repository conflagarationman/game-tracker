#!/usr/bin/env node
// Fills library-meta.json: Steam store genres, Metacritic score and Steam Deck rating for the
// games in library.json, so the owl can tell a cosy sim from a shooter and skip what won't run
// on the Deck. Keyed by appid; bot-owned.
//
// The library is ~1,600 games and the store asks callers to stay around 200 requests per five
// minutes, so this fills a slice per run (two requests per game) rather than all at once, most
// relevant first: games with real hours, then never-started ones. Known appids are never
// re-fetched; a game that has since gained a Metacritic score or a Deck rating just keeps the
// first answer, which is fine for picking a wildcard.
//
// Runs on the daily schedule only (not on every Worker-dispatched sync), and never fails it.

import fs from "node:fs/promises";
import { pathToFileURL } from "node:url";

const FILE = "library-meta.json";
export const PER_RUN = 120;
const PAUSE_MS = 1300;   // ~92 requests a minute at worst; well under the store's informal cap

// Appids still missing meta, most useful first: played ones by hours, then the never-started.
export function chooseAppids(lib, meta, n = PER_RUN) {
  const todo = (lib.steam || []).filter(g => !(String(g.appid) in meta));
  todo.sort((a, b) => (b.hours || 0) - (a.hours || 0) || a.appid - b.appid);
  return todo.slice(0, n).map(g => g.appid);
}

// appdetails?filters=genres,metacritic → { genres, meta }. A delisted or region-blocked app
// answers success:false; it's recorded as empty so it isn't asked about again every day.
export function parseDetails(json, appid) {
  const row = json && json[String(appid)];
  if (!row || !row.success || !row.data) return { genres: [], meta: null };
  return {
    genres: (row.data.genres || []).map(x => x.description).filter(Boolean),
    meta: (row.data.metacritic && Number(row.data.metacritic.score)) || null,
  };
}

// Deck compatibility: 3 verified, 2 playable, 1 unsupported, 0 unknown.
export function parseDeck(json) {
  const c = json && json.results && Number(json.results.resolved_category);
  return Number.isFinite(c) ? c : 0;
}

export function formatMeta(meta) {
  const keys = Object.keys(meta).sort((a, b) => Number(a) - Number(b));
  return "{\n" + keys.map(k => `  ${JSON.stringify(k)}: ${JSON.stringify(meta[k])}`).join(",\n") + "\n}\n";
}

async function getJson(url) {
  const res = await fetch(url, { headers: { "User-Agent": "game-tracker-owl/1.0 (+https://github.com/conflagarationman/game-tracker)" } });
  if (res.status === 429) throw Object.assign(new Error("rate limited"), { stop: true });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function main() {
  const lib = JSON.parse(await fs.readFile("library.json", "utf8"));
  let meta = {};
  try { meta = JSON.parse(await fs.readFile(FILE, "utf8")); } catch {}
  const ids = chooseAppids(lib, meta);
  let done = 0;
  for (const appid of ids) {
    try {
      const d = parseDetails(await getJson(`https://store.steampowered.com/api/appdetails?appids=${appid}&filters=genres,metacritic`), appid);
      await new Promise(r => setTimeout(r, PAUSE_MS));
      const deck = parseDeck(await getJson(`https://store.steampowered.com/saleaction/ajaxgetdeckappcompatibilityreport?nAppID=${appid}`));
      meta[appid] = { g: d.genres, m: d.meta, d: deck };
      done++;
    } catch (e) {
      console.log(`appid ${appid}: ${e.message}`);
      if (e.stop) break;   // back off for today; the next run picks up where this left off
    }
    await new Promise(r => setTimeout(r, PAUSE_MS));
  }
  await fs.writeFile(FILE, formatMeta(meta));
  const left = (lib.steam || []).filter(g => !(String(g.appid) in meta)).length;
  console.log(`Library meta: ${done} filled this run, ${left} still to go`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(e => { console.error(e); process.exit(1); });
}
