#!/usr/bin/env node
// Writes owl-pick.json: Kaepora Gaebora's suggestion for tonight, for the Home Hub's sneaky owl.
//
// The hub is Python and its page carries its access token in the URL, so it must neither
// re-implement pick.js's scoring (two rankings would drift) nor load pick.js into that page as
// remote script. Instead this runs the real pick.js here, in the sync job, and the hub reads the
// result as plain data, the same way it already reads play-check.json.
//
// The `weekend` pick is the Friday-evening hoot's: any device, a long session, no mood, with
// wildcards in the running and anything snoozed or struck from the list (owl-skips.json) kept
// out. It's drawn with a random seed taken from the ISO week, and from Friday to Sunday last
// run's pick is kept while it's still valid, so the nudge and the page agree all weekend even
// though the sync reruns every day.
//
// "Tonight" is the default question: any device, an evening, no mood. Run after the sync and
// the GOTM refresh so it sees today's play and club deadlines.

import fs from "node:fs/promises";
import vm from "node:vm";
import { pathToFileURL } from "node:url";

const FILE = "owl-pick.json";

export async function loadPicker(src) {
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  return ctx.GTPick;
}

// gotm.json's monthsLeft is a snapshot from the fetch; derive it from today, like the pages do.
export function refreshGotm(gotm, now) {
  if (!gotm || !Array.isArray(gotm.picks)) return gotm;
  const nowIdx = now.getFullYear() * 12 + now.getMonth();
  return { ...gotm, picks: gotm.picks.map(p => {
    const m = /^(\d{4})-(\d{2})$/.exec(p.month || "");
    if (!m) return p;
    const monthsLeft = Number(m[1]) * 12 + (Number(m[2]) - 1) + 12 - nowIdx;
    return { ...p, monthsLeft, retired: monthsLeft <= 0 };
  }) };
}

// { generated, pick: { id, t, p, reasons } | null }. Null when nothing is in Now Playing or
// Up Next, so the hub's owl can say so rather than the file going missing.
export function owlPick(GTPick, games, { play = null, gotm = null, now = new Date() } = {}) {
  const [best] = GTPick.pickGames(games, { time: "evening", device: "any", play, gotm: refreshGotm(gotm, now), now, limit: 1 });
  const d = now;
  const generated = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return {
    generated,
    pick: best ? { id: best.g.id, t: best.g.t, p: best.g.p, reasons: Array.from(best.reasons) } : null,
  };
}

// ISO 8601 week of a local date, e.g. "2026-W42" (weeks start Monday; Thursday decides the year).
export function isoWeek(d) {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
  const week = Math.ceil(((t - Date.UTC(t.getUTCFullYear(), 0, 1)) / 86400000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

// A small seeded generator (mulberry32) over a string, so a week always shuffles the same way.
export function seeded(str) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) { h = Math.imul(h ^ str.charCodeAt(i), 3432918353); h = (h << 13) | (h >>> 19); }
  let a = h >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// { key, t, p, reasons, week } or null. `src` is { library, meta, canon, gotm, skips }.
export function weekendPick(GTPick, games, { src = {}, play = null, now = new Date(), previous = null } = {}) {
  const gotm = refreshGotm(src.gotm, now);
  const full = { ...src, gotm };
  const week = isoWeek(now);
  const opts = { ...GTPick.WEEKEND, play, gotm, now };
  const shape = (e) => ({ key: e.key, t: e.t, p: e.p, reasons: Array.from(e.reasons), week });
  const skips = src.skips || {};

  // Friday to Sunday, stick with what the week already said, if it still stands.
  const weekday = now.getDay();
  if (previous && previous.week === week && previous.key && (weekday === 5 || weekday === 6 || weekday === 0)) {
    const still = GTPick.owlFind(games, full, previous.key, opts);
    if (still && !GTPick.isHidden(skips[previous.key], now)) return shape(still);
  }
  const rand = seeded(week);
  const lineup = GTPick.owlLineup(games, { ...full, skips }, opts, rand);
  if (!lineup.length) return null;
  // Not always the very top game: a weekend is a good time for a wildcard, so the seed picks
  // among the first three.
  return shape(lineup[Math.floor(rand() * Math.min(3, lineup.length))]);
}

async function readJson(file) {
  try { return JSON.parse(await fs.readFile(file, "utf8")); } catch { return null; }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const GTPick = await loadPicker(await fs.readFile("pick.js", "utf8"));
  const games = JSON.parse(await fs.readFile("games.json", "utf8"));
  const play = await readJson("play-check.json"), gotm = await readJson("gotm.json");
  const out = owlPick(GTPick, games, { play, gotm });
  const previous = ((await readJson(FILE)) || {}).weekend || null;
  out.weekend = weekendPick(GTPick, games, {
    src: { library: await readJson("library.json") || {}, meta: await readJson("library-meta.json") || {},
           canon: await readJson("retro-canon.json") || [], gotm, skips: await readJson("owl-skips.json") || {} },
    play, previous,
  });
  await fs.writeFile(FILE, JSON.stringify(out, null, 2) + "\n");
  console.log(out.pick ? `Owl's pick: ${out.pick.t} (${out.pick.reasons.join(" · ")})` : "Owl's pick: nothing to suggest");
  console.log(out.weekend ? `Weekend pick (${out.weekend.week}): ${out.weekend.t} [${out.weekend.key}] (${out.weekend.reasons.join(" · ")})` : "Weekend pick: nothing to suggest");
}
