// hearts.js is a plain browser script; run it in a fresh VM context like pick.test.mjs does.
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import assert from "node:assert/strict";

const ctx = {};
vm.createContext(ctx);
vm.runInContext(await readFile(new URL("../hearts.js", import.meta.url), "utf8"), ctx);
const { heartMath, heartLayout, MAX_ROW, countDone, celebration, check, SEEN_KEY } = ctx.GTHearts;

let pass = 0, fail = 0;
const test = async (name, fn) => {
  try { await fn(); pass++; console.log(`PASS  ${name}`); }
  catch (e) { fail++; console.log(`FAIL  ${name}\n        ${e.message}`); }
};
const mem = (init) => { const m = new Map(init ? [[SEEN_KEY, init]] : []); return { m, getItem: k => m.has(k) ? m.get(k) : null, setItem: (k, v) => m.set(k, v) }; };

await test("heart math: 0 done is no hearts", () => {
  const m = heartMath(0);
  assert.deepEqual([m.containers, m.pieces, m.total], [0, 0, 0]);
  assert.equal(m.label, "0 Heart Containers");
});
await test("heart math: 3 done is three pieces and no container", () => {
  const m = heartMath(3);
  assert.deepEqual([m.containers, m.pieces, m.toNext], [0, 3, 1]);
  assert.equal(m.label, "0 Heart Containers · 3/4 to the next");
});
await test("heart math: 4 done is exactly one container", () => {
  const m = heartMath(4);
  assert.deepEqual([m.containers, m.pieces], [1, 0]);
  assert.equal(m.label, "1 Heart Container");
});
await test("heart math: 59 done is 14 containers and 3 pieces", () => {
  const m = heartMath(59);
  assert.deepEqual([m.containers, m.pieces], [14, 3]);
  assert.equal(m.label, "14 Heart Containers · 3/4 to the next");
});
await test("heart math tolerates junk", () => {
  assert.equal(heartMath(-5).total, 0);
  assert.equal(heartMath(undefined).total, 0);
});
await test("only done counts: ongoing, dropped, playing never do", () => {
  const gs = ["done", "done", "ongoing", "dropped", "playing", "queue", "soon"].map((s, i) => ({ id: i, s }));
  assert.equal(countDone(gs), 2);
  assert.equal(countDone(null), 0);
});
await test("first-ever visit seeds silently", () => {
  assert.equal(celebration(null, 59).kind, "none");
  assert.equal(celebration(null, 59).next, 59);
  const st = mem();
  assert.equal(check(st, Array.from({ length: 59 }, (_, i) => ({ id: i, s: "done" }))), "none");
  assert.equal(st.getItem(SEEN_KEY), "59");
});
await test("one more finished game is a Heart Piece", () => {
  assert.deepEqual({ ...celebration("58", 59) }, { next: 59, kind: "piece", gained: 1 });
});
await test("a finish that completes a container is the big moment", () => {
  assert.equal(celebration("59", 60).kind, "container");
  assert.equal(celebration("59", 60).next, 60);
  assert.equal(celebration("60", 61).kind, "piece");
  assert.equal(celebration("63", 64).kind, "container");
  assert.equal(celebration("62", 65).kind, "container");
});
await test("same or lower count does not celebrate, and lowers the stored count", () => {
  assert.equal(celebration("59", 59).kind, "none");
  const c = celebration("59", 58);
  assert.deepEqual([c.kind, c.next], ["none", 58]);
});
await test("celebrates once: the stored count moves up with it", () => {
  const st = mem("60");
  const games = Array.from({ length: 61 }, (_, i) => ({ id: i, s: "done" }));
  assert.equal(check(st, games), "piece");
  assert.equal(check(st, games), "none");
});
await test("garbage in storage counts as a first visit", () => {
  assert.equal(celebration("banana", 10).kind, "none");
  assert.equal(celebration("-3", 10).kind, "none");
});
await test("blocked or throwing storage is harmless", () => {
  const bad = { getItem() { throw new Error("denied"); }, setItem() { throw new Error("full"); } };
  assert.equal(check(bad, [{ id: 1, s: "done" }]), "none");
});

await test("layout: a few hearts that fit are one row", () => {
  const l = heartLayout(16, 358); // 4 containers
  assert.equal(l.mode, "row"); assert.equal(l.total, 4);
});
await test("layout: 64 finishes (16 containers) beside the wallet on a 390px phone is compact, not a wrapped row", () => {
  const l = heartLayout(64, 358 - 110 - 8 - 20); // 390 minus gutters, the wallet pill, the gap and the pill's padding
  assert.equal(l.mode, "compact"); assert.equal(l.containers, 16); assert.equal(l.text, "\u00d716");
});
await test("layout: the same 64 finishes on a wide screen (or alone on a line) stay in one row", () => {
  assert.equal(heartLayout(64, 1200).mode, "row");
  assert.equal(heartLayout(64, 338).mode, "row"); // 16 x 16px + gaps = 286
});
await test("layout: never more than 20 in a row, however wide", () => {
  assert.equal(heartLayout(80, 5000).mode, "row"); // exactly 20 containers
  assert.equal(heartLayout(84, 5000).mode, "compact"); // 21
  assert.equal(heartLayout(1, 5000).cap, MAX_ROW);
});
await test("layout: a partial heart counts as one more heart in the row", () => {
  assert.equal(heartLayout(79, 5000).total, 20); assert.equal(heartLayout(79, 5000).mode, "row");
  assert.equal(heartLayout(81, 5000).total, 21); assert.equal(heartLayout(81, 5000).mode, "compact");
});
await test("layout: the exact width that fits is a row, one pixel less is compact", () => {
  const need = 10 * 16 + 9 * 2; // ten hearts
  assert.equal(heartLayout(40, need).mode, "row");
  assert.equal(heartLayout(40, need - 1).mode, "compact");
});
await test("layout: compact text carries the partial heart; zero finishes is an empty row", () => {
  assert.equal(heartLayout(59, 10).text, "\u00d714 +3/4");
  const z = heartLayout(0, 300); assert.equal(z.mode, "row"); assert.equal(z.total, 0);
});
await test("layout: an unusable width falls back to compact rather than wrapping", () => {
  for (const w of [NaN, 0, -5, undefined, null]) assert.equal(heartLayout(40, w).mode, "compact");
  assert.equal(heartLayout(0, NaN).mode, "row"); // nothing to draw is never compact
});
await test("layout: the label is unchanged by layout", () => {
  assert.equal(heartLayout(59, 10).label, heartMath(59).label);
});

console.log(`\n${pass}/${pass + fail} passing`);
process.exit(fail ? 1 : 0);
