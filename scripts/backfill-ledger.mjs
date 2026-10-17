#!/usr/bin/env node
// One-time backfill of ledger.json from games.json's git history (see ledger.mjs). Run locally,
// from a full clone, never in Actions (its checkout is shallow):
//
//   node scripts/backfill-ledger.mjs <farm-ledger.json>
//
// <farm-ledger.json> is the hub's ASF farm ledger (`~/asf-farm-ledger.json` on the VM, the same
// data /asf/farm-ledger serves), used to take card idling out of the raw-era snapshots. The last
// commit of each UTC day is that day's snapshot. Days the daily sync already appended are kept.

import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { buildLedgerFromHistory, formatLedger } from "./ledger.mjs";

const farmPath = process.argv[2];
if (!farmPath) { console.error("usage: node scripts/backfill-ledger.mjs <farm-ledger.json>"); process.exit(2); }
const farm = JSON.parse(fs.readFileSync(farmPath, "utf8"));
const git = (...args) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

// Oldest first; a later commit the same day replaces an earlier one.
const lastOfDay = new Map();
for (const line of git("log", "--first-parent", "--reverse", "--format=%H %cI", "main", "--", "games.json").trim().split("\n")) {
  const [sha, when] = line.split(" ");
  lastOfDay.set(new Date(when).toISOString().slice(0, 10), sha);
}
const snapshots = [...lastOfDay].map(([date, sha]) => ({ date, games: JSON.parse(git("show", `${sha}:games.json`)) }));

const appids = {};
for (const [id, g] of Object.entries(JSON.parse(fs.readFileSync("asf-idle.json", "utf8")).byGame || {})) appids[id] = g.appid;

const built = buildLedgerFromHistory(snapshots, { farmApps: farm.apps, appids });
const existing = fs.existsSync("ledger.json") ? JSON.parse(fs.readFileSync("ledger.json", "utf8")) : null;
if (existing?.days) for (const [d, row] of Object.entries(existing.days)) if (!built.days[d]) built.days[d] = row;

fs.writeFileSync("ledger.json", formatLedger(built));
const dates = Object.keys(built.days).sort();
console.log(`ledger.json: ${dates.length} days, ${dates[0]} to ${dates.at(-1)}, from ${snapshots.length} daily snapshots`);
