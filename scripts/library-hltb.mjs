#!/usr/bin/env node
// Fills library-hltb.json: HowLongToBeat estimates for the owl's wildcards, so a half-hour
// session can favour a short game and a long haul a big one the way they already do for tracked
// games (which have `h` in games.json). Keyed like owl-skips.json (`steam:<appid>`,
// `ra:<normTitle>`), bot-owned, and read by pick.js's wildcards().
//
// Only wildcard candidates are looked up, and the candidate list is pick.js's own wildcards()
// (favourites, never-started Metacritic 80+, unfinished RA games, unclaimed club picks), not a
// second copy of those rules. The retro canon is skipped: it carries its own `h`. A slice a day
// (PER_RUN), best-scoring first, and a title that has been answered is never asked again:
// found, or declined because HLTB has no exact match, shares one title between several games,
// or has no times. To retry a declined title (say after adding an alias to STEAM_NAME_ALIASES in
// sync-apis.mjs), delete its entry. A lookup that *failed* is not recorded, so it is retried.
//
// Matching is backfill-hltb.mjs's: the same client, the same endpoint discovery, exact
// normalized title only. Never fails the sync: if HowLongToBeat can't be reached the run says so
// and exits 0, and the next day tries again.

import fs from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { HltbClient, hltbCandidates, pickMatch, formatHours } from "./backfill-hltb.mjs";
import { loadPicker, refreshGotm } from "./owl-pick.mjs";

const FILE = "library-hltb.json";
export const PER_RUN = 40;
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };

// Wildcards not yet answered, most likely to be suggested first. `src` is the owl's own source
// bundle ({ library, meta, canon, gotm }), so what counts as a candidate can't drift from what
// the owl would offer.
export function chooseCandidates(GTPick, games, src, known, n = PER_RUN, now = new Date()) {
  const all = GTPick.wildcards(games, { ...src, gotm: refreshGotm(src.gotm, now), hltb: {} }, { device: "any", now });
  const seen = new Set();
  return Array.from(all).filter(w => {
    if (w.kind === "retro-canon" || w.key in known || seen.has(w.key)) return false;
    seen.add(w.key);
    return true;
  }).slice(0, n).map(w => ({ key: w.key, t: w.t, kind: w.kind }));
}

// Looks each candidate up and returns { found, declined, errors, fatal } without throwing.
// `known` is mutated: every definitive answer is added under its key.
export async function fillEstimates(candidates, known, log, { client = new HltbClient(), delayMs = 1000, now = today() } = {}) {
  const declined = [];
  let found = 0, errors = 0, fatal = null;
  for (const c of candidates) {
    let hit = null, why = "no exact title match", offered = [];
    try {
      for (const q of hltbCandidates(c.t)) {
        const results = await client.search(q);
        for (const r of results) if (r.game_name && !offered.includes(r.game_name)) offered.push(r.game_name);
        const { match, reason } = pickMatch(results, q, {});
        if (match) { hit = match; break; }
        why = reason;
      }
    } catch (e) {
      errors++;
      log.push(`HLTB lookup failed for "${c.t}": ${e.message}`);
      // An init failure won't fix itself mid-run: stop rather than hammer the site.
      if (/init/.test(e.message)) { fatal = e.message; break; }
      continue;
    }
    if (delayMs) await new Promise(r => setTimeout(r, delayMs));
    // Main story, else main + extras; never completionist (see backfill-hltb.mjs).
    const secs = hit ? (Number(hit.comp_main) > 0 ? Number(hit.comp_main) : Number(hit.comp_plus)) : 0;
    if (hit && secs > 0) {
      known[c.key] = { t: c.t, h: formatHours(secs), checked: now };
      found++;
      log.push(`HLTB · ${c.t}: ${known[c.key].h}${hit.game_name !== c.t ? ` (as "${hit.game_name}")` : ""}`);
    } else {
      const reason = hit ? `matched "${hit.game_name}", but HLTB has no times for it` : why;
      known[c.key] = { t: c.t, h: null, why: reason, checked: now };
      declined.push({ title: c.t, reason, candidates: offered.slice(0, 5) });
    }
  }
  return { found, declined, errors, fatal };
}

export function formatEstimates(known) {
  const keys = Object.keys(known).sort();
  return keys.length ? "{\n" + keys.map(k => `  ${JSON.stringify(k)}: ${JSON.stringify(known[k])}`).join(",\n") + "\n}\n" : "{}\n";
}

async function readJson(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, "utf8")); } catch { return fallback; }
}

async function main() {
  const GTPick = await loadPicker(await fs.readFile("pick.js", "utf8"));
  const games = await readJson("games.json", []);
  const src = { library: await readJson("library.json", {}), meta: await readJson("library-meta.json", {}),
                canon: await readJson("retro-canon.json", []), gotm: await readJson("gotm.json", null) };
  const known = await readJson(FILE, {});
  const todo = chooseCandidates(GTPick, games, src, known);
  const log = [`${todo.length} wildcard(s) without an HLTB estimate; checking HowLongToBeat`];
  const r = await fillEstimates(todo, known, log);
  await fs.writeFile(FILE, formatEstimates(known));
  log.push(`Filled ${r.found}, declined ${r.declined.length}, ${r.errors} lookup(s) failed (retried next run).`);
  console.log(log.join("\n"));
  if (r.fatal) console.log(`::warning::HowLongToBeat unreachable (${r.fatal}); wildcard estimates will wait for tomorrow`);

  if (process.env.GITHUB_STEP_SUMMARY && (r.declined.length || r.fatal)) {
    const md = [
      `### Wildcard estimates: ${r.found} filled, ${r.declined.length} declined${r.fatal ? ", HowLongToBeat unreachable" : ""}`,
      "",
      ...(r.declined.length ? [
        "| Game | Why | HLTB offered |",
        "|---|---|---|",
        ...r.declined.map(m => `| ${m.title} | ${m.reason} | ${m.candidates.length ? m.candidates.join("<br>") : "—"} |`),
        "",
        "A declined title is not asked again. To retry one (after a `STEAM_NAME_ALIASES` entry in",
        "`scripts/sync-apis.mjs`), delete its entry from `library-hltb.json`.",
      ] : []),
    ].join("\n");
    await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, md + "\n");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // Never fails the sync, whatever goes wrong.
  main().catch(e => console.log(`Wildcard estimates skipped: ${e.message}`)).finally(() => process.exit(0));
}
