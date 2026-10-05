#!/usr/bin/env node
// Fills blank HowLongToBeat estimates (`h`) in games.json, and a blank release year (`y`) while
// it's there. Before this, nothing filled `h` at all: every new game sat with no estimate until
// someone typed one in, so Up Next and Someday were full of blanks and "Backlog hrs" ran low.
//
// Only ever fills a BLANK field. A value already in games.json was put there by a person (or by
// an earlier run, which is the same thing once committed) and is never overwritten, so a
// hand-entered "10-15h" or "40+" survives. `ongoing` games are skipped on purpose: they have no
// finish line, and `h: null` is their correct value (see CLAUDE.md).
//
// HowLongToBeat has no public API. This speaks the same protocol its own site does, verified
// against a maintained client (srsholmes/loadout's HLTB plugin, Sept 2026):
//   GET  {SEARCH_API}/init?t=<ms>  -> { token, hpKey, hpVal }
//   POST {SEARCH_API}              -> { data: [{ game_name, comp_main, comp_plus, release_world, profile_steam, ... }] }
// with the token and the hp pair sent as headers AND the hp pair mirrored into the body.
// HLTB renames SEARCH_API every few months to shake off scrapers (/api/search -> /api/find ->
// /api/bleed -> /api/search/site). So when init 404s, discoverSearchApi() reads the site's own
// JS chunks for the "/api/<name>/init?t=" string the browser uses, rather than this script
// going quietly dead until someone notices the blanks again.
//
// Matching follows the same rule as the cover and Steam sync: exact normalized title only,
// never a fuzzy best guess. HLTB is full of near-duplicates (remakes, ports, same-named
// games), and a wrong estimate looks exactly as plausible as a right one.

import fs from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { normalize } from "./backfill-covers.mjs";
import { STEAM_NAME_ALIASES } from "./sync-apis.mjs";

const HLTB_BASE = "https://howlongtobeat.com";
export const DEFAULT_SEARCH_API = "/api/search/site";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const HEADERS = { "Content-Type": "application/json", Origin: HLTB_BASE, Referer: `${HLTB_BASE}/`, "User-Agent": UA };

// Statuses whose blank `h` is worth filling. `ongoing` is excluded by design; `dropped` is
// excluded because nothing on the page reads an estimate for a game you've walked away from.
const FILL_STATUSES = new Set(["playing", "queue", "soon", "done"]);

// The titles to try on HLTB for one tracker title, most-literal first. HLTB uses full official
// names, so this mirrors the cover backfill's rules: the Steam aliases (real subtitles), and
// "Zelda: X" -> "The Legend of Zelda: X".
export function hltbCandidates(title) {
  const out = [];
  const push = (t) => { if (t && !out.includes(t)) out.push(t); };
  push(title);
  push(STEAM_NAME_ALIASES[title]);
  if (/^Zelda:\s*/i.test(title)) push(title.replace(/^Zelda:\s*/i, "The Legend of Zelda: "));
  return out;
}

// HLTB seconds -> this library's style ("0.5h", "3.5h", "12h"). Under 10h keeps a half-hour
// step, since 3h vs 3.5h matters for a short game and 31h vs 31.5h doesn't for a long one.
export function formatHours(seconds) {
  const h = seconds / 3600;
  if (h < 1) return `${Math.max(0.1, Math.round(h * 10) / 10)}h`;
  if (h < 10) return `${Math.round(h * 2) / 2}h`;
  return `${Math.round(h)}h`;
}

// Picks the one HLTB row that is this game, or explains why none is. An exact normalized title
// is required. When several rows share it (a remake and its original, two unrelated games
// named "Tetris"), it narrows by the record's own release year, and if
// that still leaves more than one it declines: a coin flip between two plausible estimates is
// worse than a blank that shows up on the report.
export function pickMatch(results, query, game) {
  const exact = results.filter(r => normalize(String(r.game_name || "")) === normalize(query));
  if (!exact.length) return { match: null, reason: "no exact title match" };
  let pool = exact;
  if (pool.length > 1 && game.y) {
    const byYear = pool.filter(r => Number(r.release_world) === Number(game.y));
    if (byYear.length) pool = byYear;
  }
  if (pool.length > 1) return { match: null, reason: `${pool.length} HLTB games share this title; add a year to the record to pick one` };
  return { match: pool[0], reason: null };
}

// Reads the site's JS for the current search endpoint. Exported for the tests.
export async function discoverSearchApi() {
  const home = await fetch(`${HLTB_BASE}/`, { headers: { "User-Agent": UA } });
  if (!home.ok) throw new Error(`HLTB homepage -> ${home.status}`);
  const html = await home.text();
  const scripts = [...html.matchAll(/src="(\/_next\/static\/[^"]+\.js)"/g)].map(m => m[1]);
  for (const src of scripts) {
    const res = await fetch(`${HLTB_BASE}${src}`, { headers: { "User-Agent": UA } });
    if (!res.ok) continue;
    const m = /["'`](\/api\/[a-zA-Z0-9_/]+?)\/init\?t=/.exec(await res.text());
    if (m) return m[1];
  }
  throw new Error(`couldn't find the search endpoint in ${scripts.length} site script(s)`);
}

export class HltbClient {
  constructor(searchApi = DEFAULT_SEARCH_API) {
    this.searchApi = searchApi;
    this.auth = null;
    this.discovered = false;
  }

  async init() {
    const res = await fetch(`${HLTB_BASE}${this.searchApi}/init?t=${Date.now()}`, { headers: HEADERS });
    if (res.status === 404 && !this.discovered) {
      // Renamed again. Find the new name once per run, then retry.
      this.discovered = true;
      this.searchApi = await discoverSearchApi();
      return this.init();
    }
    if (!res.ok) throw new Error(`HLTB init ${this.searchApi} -> ${res.status}`);
    const d = await res.json();
    if (!d.token || !d.hpKey || !d.hpVal) throw new Error("HLTB init answered without token/hpKey/hpVal");
    this.auth = { token: d.token, hpKey: d.hpKey, hpVal: d.hpVal };
  }

  async search(query) {
    if (!this.auth) await this.init();
    const send = () => fetch(`${HLTB_BASE}${this.searchApi}`, {
      method: "POST",
      headers: { ...HEADERS, "x-auth-token": this.auth.token, "x-hp-key": this.auth.hpKey, "x-hp-val": this.auth.hpVal },
      body: JSON.stringify({
        searchType: "games",
        searchTerms: query.split(/\s+/).filter(Boolean),
        searchPage: 1,
        size: 20,
        searchOptions: {
          games: {
            userId: 0, platform: "", sortCategory: "popular", rangeCategory: "main",
            rangeTime: { min: 0, max: 0 },
            gameplay: { perspective: "", flow: "", genre: "", difficulty: "" },
            modifier: "hide_dlc",
          },
          users: {}, filter: "", sort: 0, randomizer: 0,
        },
        [this.auth.hpKey]: this.auth.hpVal,
      }),
    });
    let res = await send();
    // An expired token answers 403, a stale hp pair 404. Re-init once.
    if (res.status === 403 || res.status === 404) {
      await this.init();
      res = await send();
    }
    if (!res.ok) throw new Error(`HLTB search -> ${res.status}`);
    const body = await res.json();
    return Array.isArray(body.data) ? body.data : [];
  }
}

// Mutates `games` in place (record order untouched: it's the Up Next priority). Returns
// { filled, stillMissing, errors }. Throws only if HLTB couldn't be reached at all, so a run
// where the protocol broke goes red instead of reporting "0 filled" forever.
export async function backfillHltb(games, log, { client = new HltbClient(), delayMs = 1000 } = {}) {
  const todo = games.filter(g => FILL_STATUSES.has(g.s) && (!g.h || !g.y));
  log.push(`${todo.length} game(s) missing an HLTB estimate or release year — checking HowLongToBeat`);

  const stillMissing = [];
  let filled = 0, errors = 0, answered = 0;

  for (const g of todo) {
    let found = null, why = "no exact title match", seen = [];
    try {
      for (const q of hltbCandidates(g.t)) {
        const results = await client.search(q);
        answered++;
        for (const r of results) if (r.game_name && !seen.includes(r.game_name)) seen.push(r.game_name);
        const { match, reason } = pickMatch(results, q, g);
        if (match) { found = match; break; }
        why = reason;
      }
    } catch (e) {
      errors++;
      log.push(`HLTB lookup failed for "${g.t}": ${e.message}`);
      stillMissing.push({ title: g.t, reason: e.message, candidates: [] });
      // An init failure won't fix itself mid-run; stop rather than hammer the site.
      if (/init/.test(e.message)) break;
      continue;
    }
    if (delayMs) await new Promise(r => setTimeout(r, delayMs));

    if (!found) { stillMissing.push({ title: g.t, reason: why, candidates: seen.slice(0, 5) }); continue; }

    const changes = [];
    // Main story, else main + extras. Never completionist: it's a different question, and
    // reading it as "how long to beat" would inflate the backlog several-fold.
    const secs = Number(found.comp_main) > 0 ? Number(found.comp_main) : Number(found.comp_plus);
    if (!g.h && secs > 0) { g.h = formatHours(secs); changes.push(`h ${g.h}`); }
    const yr = Number(found.release_world);
    if (!g.y && Number.isInteger(yr) && yr >= 1970 && yr <= 2100) { g.y = yr; changes.push(`y ${yr}`); }

    if (changes.length) {
      filled++;
      log.push(`HLTB · ${g.t}: ${changes.join(", ")}${found.game_name !== g.t ? ` (as "${found.game_name}")` : ""}`);
    }
    // Matched, but HLTB has no times yet: normal for an unreleased or brand-new game. It'll be
    // asked again tomorrow, so it's reported as waiting rather than as a failure.
    if (!g.h) stillMissing.push({ title: g.t, reason: `matched "${found.game_name}", but HLTB has no times for it yet`, candidates: [] });
  }

  // Some lookups failing is tolerable; none succeeding means the protocol moved or HLTB is
  // refusing the runner, and that has to go red rather than read as "nothing to fill".
  if (errors && answered === 0) throw new Error(`no HLTB lookup succeeded (${errors} failed); the protocol has likely changed`);
  log.push(`Filled ${filled} record(s). ${stillMissing.length} still blank.`);
  return { filled, stillMissing, errors };
}

async function main() {
  const games = JSON.parse(await fs.readFile("games.json", "utf8"));
  const log = [];
  let result, fatal = null;
  try {
    result = await backfillHltb(games, log);
  } catch (e) {
    fatal = e;
  }
  // Write whatever was filled before a failure; each fill is independent.
  await fs.writeFile("games.json", JSON.stringify(games, null, 2) + "\n");
  console.log(log.join("\n"));

  const left = result ? result.stillMissing : [];
  if (process.env.GITHUB_STEP_SUMMARY && (left.length || fatal)) {
    const md = [
      `### HowLongToBeat: ${fatal ? "lookup failed" : `${left.length} still blank`}`,
      "",
      ...(fatal ? [`**${fatal.message}**`, ""] : []),
      ...(left.length ? [
        "| Game | Why | HLTB offered |",
        "|---|---|---|",
        ...left.map(m => `| ${m.title} | ${m.reason} | ${m.candidates.length ? m.candidates.join("<br>") : "—"} |`),
        "",
      ] : []),
      "A title HLTB spells differently needs a `STEAM_NAME_ALIASES` entry in `scripts/sync-apis.mjs`",
      "(shared by the Steam sync, covers, and this). Or type the estimate into `add.html`; a filled",
      "`h` is never overwritten.",
    ].join("\n");
    await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, md + "\n");
  }
  if (fatal) {
    console.error(fatal);
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(e => {
    console.error(e);
    process.exit(1);
  });
}
