import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { loadPicker, owlPick, refreshGotm } from "./owl-pick.mjs";

const GTPick = await loadPicker(await readFile(new URL("../pick.js", import.meta.url), "utf8"));

let pass = 0, fail = 0;
const test = async (name, fn) => {
  try { await fn(); pass++; console.log(`PASS  ${name}`); }
  catch (e) { fail++; console.log(`FAIL  ${name}\n        ${e.message}`); }
};

const NOW = new Date(2026, 9, 14);
const g = (id, over = {}) => ({ id, t: `Game ${id}`, p: "steam", s: "queue", h: null, actualHours: null,
  lastPlayed: null, release: null, gotm: null, gotmFlair: false, ...over });

await test("writes the same top pick the tracker's picker shows for an evening on any device", () => {
  const games = [g(1, { h: "50h" }), g(2, { h: "3h", actualHours: 1, p: "ayn" })];
  const out = owlPick(GTPick, games, { now: NOW });
  const page = GTPick.pickGames(games, { time: "evening", device: "any", now: NOW, limit: 1 })[0];
  assert.equal(out.pick.id, page.g.id);
  assert.deepEqual(out.pick.reasons, Array.from(page.reasons));
  assert.equal(out.pick.p, "ayn");
  assert.equal(out.generated, "2026-10-14");
});

await test("an empty backlog is a null pick, not a missing file", () => {
  assert.equal(owlPick(GTPick, [g(1, { s: "done" })], { now: NOW }).pick, null);
});

await test("club deadlines are recomputed from today, not taken from gotm.json's snapshot", () => {
  const gotm = { picks: [{ month: "2025-11", tag: "Nov 2025", monthsLeft: 9, retired: false }] };
  assert.equal(refreshGotm(gotm, NOW).picks[0].monthsLeft, 1);
  const out = owlPick(GTPick, [g(1, { s: "playing" }), g(2, { s: "soon", gotm: "Nov 2025" })], { gotm, now: NOW });
  assert.equal(out.pick.id, 2);
});

await test("the real games.json yields a pick with reasons", async () => {
  const games = JSON.parse(await readFile(new URL("../games.json", import.meta.url), "utf8"));
  const out = owlPick(GTPick, games, { now: NOW });
  assert.ok(out.pick && out.pick.t && out.pick.reasons.length > 0);
});

console.log(`\n${pass}/${pass + fail} passing`);
process.exit(fail ? 1 : 0);
