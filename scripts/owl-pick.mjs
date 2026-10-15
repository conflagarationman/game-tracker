#!/usr/bin/env node
// Writes owl-pick.json: Kaepora Gaebora's suggestion for tonight, for the Home Hub's sneaky owl.
//
// The hub is Python and its page carries its access token in the URL, so it must neither
// re-implement pick.js's scoring (two rankings would drift) nor load pick.js into that page as
// remote script. Instead this runs the real pick.js here, in the sync job, and the hub reads the
// result as plain data, the same way it already reads play-check.json.
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

async function readJson(file) {
  try { return JSON.parse(await fs.readFile(file, "utf8")); } catch { return null; }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const GTPick = await loadPicker(await fs.readFile("pick.js", "utf8"));
  const games = JSON.parse(await fs.readFile("games.json", "utf8"));
  const out = owlPick(GTPick, games, { play: await readJson("play-check.json"), gotm: await readJson("gotm.json") });
  await fs.writeFile(FILE, JSON.stringify(out, null, 2) + "\n");
  console.log(out.pick ? `Owl's pick: ${out.pick.t} (${out.pick.reasons.join(" · ")})` : "Owl's pick: nothing to suggest");
}
