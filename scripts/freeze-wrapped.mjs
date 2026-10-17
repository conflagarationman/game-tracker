#!/usr/bin/env node
// Freezes a finished year's review on Jan 1: wrapped-<year>.json holds the year's inputs
// (games.json, asf-idle.json, the year's ledger days and unlocks) as they stood that morning.
// wrapped.html prefers it over the live files, so later syncs, which keep moving actualHours,
// achievement counts and statuses, can't change a year that's over. Run by sync-games.yml on
// every sync; it only writes on or after Jan 1 of the next year, once, and never overwrites.
//
//   node scripts/freeze-wrapped.mjs                    # the workflow: last year, if it's time
//   node scripts/freeze-wrapped.mjs --year 2026 --force --out /tmp/w.json   # a rehearsal

import fs from "node:fs";
import { pathToFileURL } from "node:url";

export const FIRST_YEAR = 2026;   // the ledgers start in 2026; earlier years have nothing to freeze

// Whether `year` should be frozen now: the year is over (in Eastern time, so not before 5 AM UTC
// on Jan 1), it's one the ledgers cover, and it hasn't been frozen already.
export function shouldFreeze(year, now = new Date(), exists = false) {
  const nextYearET = Date.UTC(year + 1, 0, 1, 5);
  return year >= FIRST_YEAR && now.getTime() >= nextYearET && !exists;
}

// The year's slice of each input. The ledger keeps the last day before the year as its baseline;
// unlocks keep a day of margin either side, since wrapped-stats.js buckets them in Eastern time.
export function freezeSnapshot({ games, asfIdle = null, ledger = null, unlocks = [] }, year, now = new Date()) {
  const from = `${year}-01-01`, to = `${year}-12-31`;
  let days = null;
  if (ledger && ledger.days) {
    const dates = Object.keys(ledger.days).sort();
    const before = dates.filter(d => d < from).pop();
    days = {};
    for (const d of dates) if ((d >= from && d <= to) || d === before) days[d] = ledger.days[d];
  }
  const lo = Date.UTC(year, 0, 1) / 1000 - 86400, hi = Date.UTC(year + 1, 0, 1) / 1000 + 86400;
  return {
    year, frozenAt: now.toISOString(),
    games, asfIdle,
    ledger: days ? { version: ledger.version, since: ledger.since, rawUntil: ledger.rawUntil, days } : null,
    unlocks: (unlocks || []).filter(r => r.ts >= lo && r.ts < hi),
  };
}

function main() {
  const args = process.argv.slice(2);
  const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
  const now = new Date();
  const year = Number(opt("--year")) || now.getUTCFullYear() - 1;
  const out = opt("--out") || `wrapped-${year}.json`;
  if (!args.includes("--force") && !shouldFreeze(year, now, fs.existsSync(out))) {
    console.log(`Wrapped ${year}: nothing to freeze (${fs.existsSync(out) ? "already frozen" : "the year isn't over or isn't covered"}).`);
    return;
  }
  const read = (f, fallback) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return fallback; } };
  const snap = freezeSnapshot({ games: read("games.json", []), asfIdle: read("asf-idle.json", null),
    ledger: read("ledger.json", null), unlocks: read("achievements-log.json", {}).unlocks || [] }, year, now);
  fs.writeFileSync(out, JSON.stringify(snap) + "\n");
  console.log(`Wrapped ${year}: froze ${snap.games.length} games, ${Object.keys(snap.ledger?.days || {}).length} ledger days, ${snap.unlocks.length} unlocks -> ${out}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
