#!/usr/bin/env node
// Backfills cover art for games missing an entry in covers.json, via SteamGridDB — the
// same source Cocoon (the actual launcher running on the AYN Thor) uses to scrape box art
// for its library, and the same source Jonny's own original hand-curated comment in
// game_tracker.html already pointed at ("For non-Steam games, grab a URL from
// steamgriddb.com") before any of this was automated. Unlike Steam's storefront API,
// SteamGridDB is crowd-sourced across every platform, so it actually covers the AYN
// Thor/Retro/Switch/Wii U gap the Steam-only sync can't touch.
//
// Endpoints/response shapes below are verified against SteamGridDB's own official Node
// client source (github.com/SteamGridDB/node-steamgriddb/blob/master/src/index.ts), not
// guessed — search returns {success, data:[{id,name,types,verified,release_date}]}, grids
// returns {success, data:[{id,score,style,url,thumb,...}]}.
//
// Not part of the daily sync-games workflow: box art doesn't change day-to-day, and
// re-searching already-resolved or already-known-unmatched titles on every run would just
// burn API quota for nothing. Run manually via `node scripts/backfill-covers.mjs` or the
// backfill-covers workflow's "Run workflow" button whenever new games need art.

import fs from "node:fs/promises";
import { pathToFileURL } from "node:url";

const SGDB_BASE = "https://www.steamgriddb.com/api/v2";

// Loose title normalization for comparing search results against the query — strips
// punctuation/case so "Chained Echoes" and "chained echoes" match, but two genuinely
// different games never do. This is the fix for a real bug hit earlier: blindly trusting
// a search API's top result matched "ITTA" to an unrelated "It Takes Two" bundle, and
// "Tomb Raider I Remastered" to the wrong remaster pack. Only an exact normalized match
// is ever auto-accepted; anything else is left for a manual pick rather than guessed.
export function normalize(title) {
  return title.toLowerCase().replace(/[:'".!™®]/g, "").replace(/\s+/g, " ").trim();
}

async function sgdbGet(path) {
  const key = process.env.STEAMGRIDDB_API_KEY;
  if (!key) throw new Error("missing STEAMGRIDDB_API_KEY");
  const res = await fetch(`${SGDB_BASE}${path}`, {
    headers: { Authorization: `Bearer ${key}` },
  });
  const body = await res.json();
  if (!res.ok || !body.success) {
    throw new Error(`SteamGridDB ${path} -> ${res.status}: ${(body.errors || []).join(", ") || "unknown error"}`);
  }
  return body.data;
}

// Resolves a single title to a cover URL, or null if nothing can be confidently matched.
export async function findCover(title) {
  const target = normalize(title);
  const results = await sgdbGet(`/search/autocomplete/${encodeURIComponent(title)}`);
  const match = results.find(r => normalize(r.name) === target);
  if (!match) return null;

  const grids = await sgdbGet(`/grids/game/${match.id}`);
  if (!grids.length) return null;
  const best = [...grids].sort((a, b) => b.score - a.score)[0];
  return best.url;
}

// Mutates `covers` in place (same shape as sync-apis.mjs's syncSteam/syncRA), appends to
// `log`, and returns the titles that still need a manual pick so the caller can report them.
export async function backfillCovers(games, covers, log) {
  const missing = games.filter(g => !covers[g.t.toLowerCase()]);
  log.push(`${missing.length} games missing cover art — checking SteamGridDB`);

  const stillMissing = [];
  let added = 0;

  for (const g of missing) {
    try {
      const url = await findCover(g.t);
      if (!url) {
        stillMissing.push(g.t);
        continue;
      }
      const check = await fetch(url, { method: "HEAD" });
      if (!check.ok) {
        stillMissing.push(g.t);
        continue;
      }
      covers[g.t.toLowerCase()] = url;
      added++;
      log.push(`Cover found: ${g.t}`);
    } catch (e) {
      log.push(`Cover check skipped for "${g.t}": ${e.message}`);
      stillMissing.push(g.t);
    }
    await new Promise(r => setTimeout(r, 400)); // be polite to SteamGridDB's API
  }

  log.push(`Added ${added} cover(s). ${stillMissing.length} still need a manual pick.`);
  return stillMissing;
}

async function main() {
  const games = JSON.parse(await fs.readFile("games.json", "utf8"));
  const covers = JSON.parse(await fs.readFile("covers.json", "utf8"));
  const log = [];

  const stillMissing = await backfillCovers(games, covers, log);

  await fs.writeFile("covers.json", JSON.stringify(covers, null, 2) + "\n");

  console.log(log.join("\n"));
  if (stillMissing.length) {
    console.log("\nStill need a manual pick (no exact title match, no grids, or a dead image URL):");
    stillMissing.forEach(t => console.log(`  - ${t}`));
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(e => {
    console.error(e);
    process.exit(1);
  });
}
