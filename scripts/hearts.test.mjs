// hearts.js is a plain browser script; run it in a fresh VM context like pick.test.mjs does.
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import assert from "node:assert/strict";

const ctx = {};
vm.createContext(ctx);
vm.runInContext(await readFile(new URL("../hearts.js", import.meta.url), "utf8"), ctx);
const { heartMath, countDone, celebration, check, SEEN_KEY } = ctx.GTHearts;

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

console.log(`\n${pass}/${pass + fail} passing`);
process.exit(fail ? 1 : 0);
