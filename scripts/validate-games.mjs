#!/usr/bin/env node
// Validates a proposed games.json against the current one. auto-merge-data.yml runs this on
// any pull request that changes games.json and nothing else, and merges it only if this finds
// no errors. That is the path a chat-style Claude session takes for "I finished X, mark it
// 10/10": it edits games.json, opens a PR, and the change goes live without a click.
//
// Merging unreviewed is only safe because of what this refuses. The rules are the ones
// CLAUDE.md spells out about the record shape, plus two guards against the failure modes an
// edit made by rewriting the whole file actually has: re-sorting the array (array order IS the
// Up Next priority, and nothing else records it) and silently dropping records.
//
//   node scripts/validate-games.mjs <base games.json> <proposed games.json>

import fs from "node:fs/promises";
import { pathToFileURL } from "node:url";

export const KEYS = [
  "id", "t", "p", "s", "g", "y", "h", "r", "cy", "cm", "gotm", "gotmFlair", "mastery", "diff",
  "achPct", "achCount", "actualHours", "lastPlayed", "casual", "note", "start", "queued", "release",
];
const PLATFORMS = ["steam", "steamdeck", "pc", "ps5", "switch", "switch2", "ayn", "retro", "wiiu"];
const STATUSES = ["playing", "ongoing", "queue", "soon", "done", "dropped"];
const MASTERY = [null, "in-progress", "mastered", "platinum", "100pct"];
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const GOTM = /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4}$/;

// A deliberate reprioritisation moves a few records; a sort or a regenerated file moves most
// of them. Measured as the fewest records that would have to move to restore the old order.
export const MAX_MOVED = 6;
// Deleting a record or two is a normal edit. More than this in one PR is far likelier to be a
// truncated rewrite than an intent, so it waits for a person.
export const MAX_REMOVED = 3;

const isNullOr = (v, test) => v === null || test(v);
const isInt = Number.isInteger;

function checkRecord(r, i) {
  const where = `record ${i} (${r && r.t ? JSON.stringify(r.t) : `id ${r && r.id}`})`;
  const errs = [];
  if (!r || typeof r !== "object" || Array.isArray(r)) return [`${where} is not an object`];
  for (const k of KEYS) if (!(k in r)) errs.push(`${where} is missing "${k}" (every record carries every key, null when unset)`);
  for (const k of Object.keys(r)) if (!KEYS.includes(k)) errs.push(`${where} has unknown field "${k}"`);
  if (!isInt(r.id) || r.id <= 0) errs.push(`${where}: id must be a positive integer`);
  if (typeof r.t !== "string" || !r.t.trim()) errs.push(`${where}: t (title) is required`);
  if (!PLATFORMS.includes(r.p)) errs.push(`${where}: p "${r.p}" is not one of ${PLATFORMS.join(", ")}`);
  if (!STATUSES.includes(r.s)) errs.push(`${where}: s "${r.s}" is not one of ${STATUSES.join(", ")}`);
  if (!isInt(r.r) || r.r < 0 || r.r > 10) errs.push(`${where}: r must be 0-10 (0 = unrated)`);
  if (!isNullOr(r.cm, v => isInt(v) && v >= 0 && v <= 11)) errs.push(`${where}: cm is ZERO-indexed, 0-11 (0 = January)`);
  if (!isNullOr(r.cy, v => isInt(v) && v >= 1970 && v <= 2100)) errs.push(`${where}: cy must be a year`);
  if (!isNullOr(r.y, v => isInt(v) && v >= 1970 && v <= 2100)) errs.push(`${where}: y must be a year`);
  if (!isNullOr(r.diff, v => isInt(v) && v >= 1 && v <= 5)) errs.push(`${where}: diff must be 1-5`);
  if (!MASTERY.includes(r.mastery)) errs.push(`${where}: mastery "${r.mastery}" is not one of ${MASTERY.slice(1).join(", ")}`);
  if (!isNullOr(r.gotm, v => GOTM.test(v))) errs.push(`${where}: gotm must look like "Oct 2025"`);
  if (typeof r.gotmFlair !== "boolean") errs.push(`${where}: gotmFlair must be true or false`);
  if (typeof r.casual !== "boolean") errs.push(`${where}: casual must be true or false`);
  for (const k of ["start", "queued", "release", "lastPlayed"]) {
    if (!isNullOr(r[k], v => typeof v === "string" && DATE.test(v))) errs.push(`${where}: ${k} must be YYYY-MM-DD`);
  }
  for (const k of ["g", "h", "note"]) {
    if (!isNullOr(r[k], v => typeof v === "string")) errs.push(`${where}: ${k} must be text or null`);
  }
  return errs;
}

// Length of the longest increasing subsequence: the records that can stay put.
function lisLength(seq) {
  const tails = [];
  for (const x of seq) {
    let lo = 0, hi = tails.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (tails[m] < x) lo = m + 1; else hi = m; }
    tails[lo] = x;
  }
  return tails.length;
}

// Returns { errors, summary }. Empty errors means safe to merge.
export function validateGames(base, head) {
  const errors = [];
  if (!Array.isArray(head)) return { errors: ["games.json must be one flat array"], summary: [] };
  head.forEach((r, i) => errors.push(...checkRecord(r, i)));

  const seen = new Set();
  for (const r of head) {
    if (r && seen.has(r.id)) errors.push(`id ${r.id} appears more than once`);
    if (r) seen.add(r.id);
  }

  const baseIds = base.map(r => r.id);
  const headIds = new Set(head.map(r => r && r.id));
  const removed = base.filter(r => !headIds.has(r.id));
  if (removed.length > MAX_REMOVED) {
    errors.push(`${removed.length} records removed (more than ${MAX_REMOVED}); that looks like a truncated rewrite, so it needs a person to merge`);
  }

  // Order of the records both versions share.
  const basePos = new Map(baseIds.map((id, i) => [id, i]));
  const shared = head.filter(r => r && basePos.has(r.id)).map(r => basePos.get(r.id));
  const moved = shared.length - lisLength(shared);
  if (moved > MAX_MOVED) {
    errors.push(`${moved} records changed position (more than ${MAX_MOVED}). Array order is the Up Next priority, so a re-sorted or regenerated file is refused; move only the records you mean to`);
  }

  const baseById = new Map(base.map(r => [r.id, r]));
  const added = head.filter(r => r && !baseById.has(r.id));
  const changed = head.filter(r => r && baseById.has(r.id) && JSON.stringify(r) !== JSON.stringify(baseById.get(r.id)));
  const summary = [
    ...added.map(r => `added: ${r.t} (${r.s})`),
    ...changed.map(r => {
      const was = baseById.get(r.id);
      const diffs = KEYS.filter(k => JSON.stringify(r[k]) !== JSON.stringify(was[k])).map(k => `${k} ${JSON.stringify(was[k])} -> ${JSON.stringify(r[k])}`);
      return `changed: ${r.t}: ${diffs.join(", ")}`;
    }),
    ...removed.map(r => `removed: ${r.t}`),
    ...(moved ? [`${moved} record(s) moved`] : []),
  ];
  return { errors, summary };
}

async function main() {
  const [basePath, headPath] = process.argv.slice(2);
  if (!basePath || !headPath) {
    console.error("usage: node scripts/validate-games.mjs <base games.json> <proposed games.json>");
    process.exit(2);
  }
  let base, head;
  try {
    base = JSON.parse(await fs.readFile(basePath, "utf8"));
    head = JSON.parse(await fs.readFile(headPath, "utf8"));
  } catch (e) {
    console.error(`games.json is not valid JSON: ${e.message}`);
    process.exit(1);
  }
  const { errors, summary } = validateGames(base, head);
  console.log(summary.length ? summary.join("\n") : "no record changes");
  if (errors.length) {
    console.error(`\n${errors.length} problem(s):\n- ${errors.join("\n- ")}`);
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(e => { console.error(e); process.exit(1); });
}
