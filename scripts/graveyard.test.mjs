import { readFile } from "node:fs/promises";
import vm from "node:vm";
import assert from "node:assert/strict";

const ctx = {};
vm.createContext(ctx);
vm.runInContext(await readFile(new URL("../graveyard.js", import.meta.url), "utf8"), ctx);
const { dropped, hoursPlayed, successor, epitaph, emptyLine, digUpPatch, digUpBody, digUpConfirm } = ctx.GTGraveyard;

let pass = 0, fail = 0;
const test = async (name, fn) => {
  try { await fn(); pass++; console.log(`PASS  ${name}`); }
  catch (e) { fail++; console.log(`FAIL  ${name}\n        ${e.message}`); }
};
const g = (id, over = {}) => ({ id, t: `Game ${id}`, s: "dropped", h: null, actualHours: null, lastPlayed: null,
  cy: null, cm: null, start: null, queued: null, ...over });

await test("dropped() keeps only dropped games, newest drop first", () => {
  const gs = [g(1, { lastPlayed: "2026-01-01" }), g(2, { s: "done" }), g(3, { lastPlayed: "2026-05-01" }), g(4, { s: "ongoing" })];
  assert.deepEqual(Array.from(dropped(gs), x => x.id), [3, 1]);
});
await test("hours: actualHours wins, else the HLTB estimate is flagged, else null", () => {
  assert.deepEqual({ ...hoursPlayed(g(1, { actualHours: 3.04 })) }, { text: "3h", est: false, n: 3.04 });
  assert.equal(hoursPlayed(g(1, { actualHours: 12.46 })).text, "12.5h");
  const e = hoursPlayed(g(1, { h: "3-5h" }));
  assert.deepEqual([e.text, e.est], ["3-5h", true]);
  assert.equal(hoursPlayed(g(1)), null);
});
await test("successor is the playing/done game closest after the drop", () => {
  const d = g(1, { lastPlayed: "2026-05-03" });
  const gs = [d,
    g(2, { s: "playing", start: "2026-04-01" }),            // before the drop
    g(3, { s: "playing", start: "2026-09-01" }),
    g(4, { s: "done", cy: 2026, cm: 5 }),                    // end of June: closest after
    g(5, { s: "queue", start: "2026-05-04" }),               // not playing or done
    g(6, { s: "ongoing", start: "2026-05-05" })];
  assert.equal(successor(d, gs).id, 4);
});
await test("successor: ties go to the lower id; none when nothing follows or no date", () => {
  const d = g(1, { lastPlayed: "2026-05-03" });
  assert.equal(successor(d, [d, g(9, { s: "playing", start: "2026-06-01" }), g(7, { s: "playing", start: "2026-06-01" })]).id, 7);
  assert.equal(successor(d, [d, g(2, { s: "playing", start: "2026-01-01" })]), null);
  assert.equal(successor(g(1), [g(1), g(2, { s: "playing", start: "2026-01-01" })]), null);
});
await test("epitaph is deterministic by id", () => {
  const d = g(61, { actualHours: 3, lastPlayed: "2026-05-03" });
  assert.equal(epitaph(d, [d]), epitaph(d, [d]));
});
await test("epitaph rotates through the lines available and always returns text", () => {
  const next = g(99, { s: "playing", start: "2026-06-01", t: "Hades" });
  const seen = new Set();
  for (let id = 1; id <= 12; id++) {
    const d = g(id, { actualHours: 3, lastPlayed: "2026-05-03" });
    const e = epitaph(d, [d, next]);
    assert.ok(e && typeof e === "string");
    seen.add(e);
  }
  assert.ok(seen.size >= 5, [...seen].join(" | "));
  assert.ok([...seen].includes("Hours played: 3."));
  assert.ok([...seen].includes("Fell to Hades."));
});
await test("epitaph skips lines the record can't support", () => {
  for (let id = 1; id <= 8; id++) {
    const e = epitaph(g(id), [g(id)]);
    assert.ok(!/Hours played|Fell to|Never saw/.test(e), e);
  }
  const est = epitaph(g(1, { h: "35h" }), []);
  assert.ok(/35h/.test(est) || !/Hours played/.test(est));
});
await test("empty-state line is stable", () => {
  assert.ok(emptyLine(3).length > 0);
  assert.equal(emptyLine(3), emptyLine(3));
});
await test("dig-up sends s:soon + queued through /games/edit's body shape, nothing else", () => {
  const body = digUpBody(g(61), "2026-10-26");
  assert.deepEqual({ ...body }, { id: 61, s: "soon", queued: "2026-10-26" });
});
await test("dig-up keeps an existing queued date", () => {
  assert.deepEqual({ ...digUpPatch(g(61, { queued: "2026-02-02" }), "2026-10-26") }, { s: "soon", queued: "2026-02-02" });
});
await test("dig-up confirmation text names the game and Someday", () => {
  assert.equal(digUpConfirm(g(61, { t: "Pokemon Odyssey" })), "Dig up Pokemon Odyssey? It goes back to Someday.");
});
await test("dig-up never touches hours, ratings or other bot-owned fields", () => {
  const keys = Object.keys(digUpBody(g(1, { actualHours: 3, r: 7 }), "2026-10-26")).sort();
  assert.deepEqual(keys, ["id", "queued", "s"]);
});

console.log(`\n${pass}/${pass + fail} passing`);
process.exit(fail ? 1 : 0);
