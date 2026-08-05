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
  return title
    // Fold diacritics before anything else: SteamGridDB carries official titles, which use
    // them ("Pokémon Pokopia"), while this library types them plainly ("Pokemon Pokopia").
    // Without this the exact-match rule below rejects the correct game over one accent, which
    // is what left every Pokémon title uncovered.
    // NFD splits "é" into "e" + a combining accent; ̀-ͯ is that combining block.
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[:'".!™®]/g, "").replace(/\s+/g, " ").trim();
}

// Tracker titles that are genuinely shorter than the catalogue's, in ways no rule derives:
// a dropped subtitle. Kept explicit and small for the same reason sync-apis.mjs keeps its
// own alias map small — anything a rule can handle belongs in candidateQueries() instead.
// Every entry below was read off the run summary's "catalogue offered" column rather than
// guessed — that report exists precisely so this map can be filled in from evidence.
export const SGDB_TITLE_ALIASES = {
  "999: Nine Hours, Nine Persons": "999",
  "Marvel vs. Capcom 2": "Marvel vs. Capcom 2: New Age of Heroes",
  "Zelda: Wind Waker HD": "The Legend of Zelda: The Wind Waker HD",
  // The standalone release the catalogue actually carries; plain "Four Swords" only exists
  // there bundled into A Link to the Past.
  "Zelda: Four Swords": "The Legend of Zelda: Four Swords Anniversary Edition",
  "Pokemon LeafGreen": "Pokémon LeafGreen Version",
  "Donkey Kong: Tropical Freeze": "Donkey Kong Country: Tropical Freeze",
  "Cadence of Hyrule": "Cadence of Hyrule: Crypt of the NecroDancer Featuring The Legend of Zelda",
  // The PICO-8 build has its own catalogue entry under its own name, which is why refusing to
  // strip "(PICO-8)" was right: this gets the prototype's art, not the 2018 game's.
  "Celeste (PICO-8)": "Celeste Classic",
};

// Deliberately NOT aliased, and why — so nobody "fixes" these by adding an entry later:
//   Lies of P: Overture  -> the catalogue has no Overture entry, only "Lies of P", which is
//                           already a separate game in this library. Aliasing would hand both
//                           records the same art.
//   Zelda: Link's Awakening (2019) -> the catalogue's "The Legend of Zelda: Link's Awakening"
//                           is the Game Boy original, also in this library.
//   Tetris, Sesame St: Elmo's Number Journey -> no matching catalogue entry at all.

// Parenthetical suffixes safe to drop, because they name a fan PORT of the same game and the
// catalogue only lists the original: 2 Ship 2 Harkinian (Majora's Mask) and Ship of Harkinian
// (Ocarina of Time). Deliberately a fixed list rather than "strip any (...)": a parenthetical
// usually marks a DIFFERENT edition with its own art — "Link's Awakening (2019)" is the Switch
// remake, not the Game Boy original, and "Celeste (PICO-8)" is the 2015 prototype, not Celeste.
// Stripping those would hand each the wrong box art, silently, which is the exact failure mode
// the exact-match rule above exists to prevent. Anything not listed here is left for the
// still-missing report to surface, where a deliberate alias can be added instead.
const PORT_SUFFIXES = ["2S2H", "SoH", "Ship of Harkinian", "2 Ship 2 Harkinian"];

// The search terms to try for one tracker title, most-literal first. This widens what gets
// *asked*, never what gets *accepted* — every candidate still has to come back as an exact
// normalized match, so the ITTA-class mismatch this script exists to prevent stays prevented.
// Each rule below encodes a shortening this library actually uses:
//   "Zelda: X"        -> the catalogue's "The Legend of Zelda: X"
//   "Foo (2S2H)"      -> the same game, minus a fan-port tag
export function candidateQueries(title) {
  const out = [];
  const push = (t) => { const v = String(t).trim(); if (v && !out.includes(v)) out.push(v); };

  push(title);
  if (SGDB_TITLE_ALIASES[title]) push(SGDB_TITLE_ALIASES[title]);

  const port = /\s*\(([^)]*)\)\s*$/.exec(title);
  const noPort = port && PORT_SUFFIXES.some(s => s.toLowerCase() === port[1].trim().toLowerCase())
    ? title.slice(0, port.index)
    : title;
  push(noPort);

  for (const base of [title, noPort]) {
    if (/^Zelda:\s*/i.test(base)) push(base.replace(/^Zelda:\s*/i, "The Legend of Zelda: "));
  }
  return out;
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
// Returns { url, matchedAs, seen } so callers can report WHY a title failed: previously a
// decline was indistinguishable from "no such game", which is what made a third of the
// library silently uncovered with no way to tell which titles just needed an alias.
export async function findCoverDetailed(title) {
  const seen = [];
  for (const query of candidateQueries(title)) {
    const results = await sgdbGet(`/search/autocomplete/${encodeURIComponent(query)}`);
    for (const r of results) if (!seen.includes(r.name)) seen.push(r.name);

    const match = results.find(r => normalize(r.name) === normalize(query));
    if (!match) continue;

    const grids = await sgdbGet(`/grids/game/${match.id}`);
    if (!grids.length) return { url: null, matchedAs: match.name, seen, reason: "matched, but the catalogue has no grids for it" };
    const best = [...grids].sort((a, b) => b.score - a.score)[0];
    return { url: best.url, matchedAs: match.name, seen, reason: null };
  }
  return {
    url: null,
    matchedAs: null,
    seen,
    reason: seen.length ? "no exact title match among the search results" : "the search returned nothing",
  };
}

// Kept as the simple boolean-ish form the tests and any existing callers use.
export async function findCover(title) {
  return (await findCoverDetailed(title)).url;
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
      const found = await findCoverDetailed(g.t);
      if (!found.url) {
        // Carry the near-misses through. Turning an alias into a one-line fix depends on
        // knowing what the catalogue actually calls the thing.
        stillMissing.push({ title: g.t, reason: found.reason, candidates: found.seen.slice(0, 5) });
        continue;
      }
      const check = await fetch(found.url, { method: "HEAD" });
      if (!check.ok) {
        stillMissing.push({ title: g.t, reason: `image URL returned ${check.status}`, candidates: [] });
        continue;
      }
      covers[g.t.toLowerCase()] = found.url;
      added++;
      log.push(`Cover found: ${g.t}${found.matchedAs !== g.t ? ` (matched as "${found.matchedAs}")` : ""}`);
    } catch (e) {
      log.push(`Cover check skipped for "${g.t}": ${e.message}`);
      stillMissing.push({ title: g.t, reason: e.message, candidates: [] });
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
    const lines = ["", "Still need a manual pick:"];
    for (const m of stillMissing) {
      lines.push(`  - ${m.title} — ${m.reason}`);
      if (m.candidates.length) lines.push(`      catalogue offered: ${m.candidates.join(" | ")}`);
    }
    console.log(lines.join("\n"));

    // Also into the Actions run summary, so the answer is on the run page rather than buried
    // in step logs nobody opens. This is the whole difference between "some covers are
    // missing" and "here is the name to alias".
    if (process.env.GITHUB_STEP_SUMMARY) {
      const md = [
        `### Cover art: ${stillMissing.length} still unmatched`,
        "",
        "| Game | Why | Catalogue offered |",
        "|---|---|---|",
        ...stillMissing.map(m =>
          `| ${m.title} | ${m.reason} | ${m.candidates.length ? m.candidates.join("<br>") : "—"} |`),
        "",
        "Fix by adding a `SGDB_TITLE_ALIASES` entry in `scripts/backfill-covers.mjs`, or by",
        "pasting a URL from steamgriddb.com straight into `covers.json`.",
      ].join("\n");
      await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, md + "\n");
    }
  }
}

// argv[1] is undefined under `node -e` / `--input-type=module`, and pathToFileURL throws on
// undefined rather than returning null — so guard it, or merely *importing* this module from
// such a context crashes before any of its exports can be used.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(e => {
    console.error(e);
    process.exit(1);
  });
}
