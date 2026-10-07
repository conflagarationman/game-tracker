// The gate in front of auto-merge. Each refusal here is a change that would otherwise go live
// unreviewed, so the tests lean on what it must refuse rather than on the happy path.
import { validateGames, KEYS, MAX_MOVED, MAX_REMOVED } from "./validate-games.mjs";
import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";

let pass = 0, fail = 0;
const test = async (name, fn) => {
  try { await fn(); pass++; console.log(`PASS  ${name}`); }
  catch (e) { fail++; console.log(`FAIL  ${name}\n        ${e.message}`); }
};

const rec = (id, over = {}) => ({
  ...Object.fromEntries(KEYS.map(k => [k, null])),
  id, t: `Game ${id}`, p: "steam", s: "queue", r: 0, gotmFlair: false, casual: false, ...over,
});
const lib = (n) => Array.from({ length: n }, (_, i) => rec(i + 1));
const clone = (x) => JSON.parse(JSON.stringify(x));

await test("the real games.json passes against itself", async () => {
  const games = JSON.parse(await readFile(new URL("../games.json", import.meta.url), "utf8"));
  const { errors } = validateGames(games, games);
  assert.deepEqual(errors, []);
});

await test("the everyday edit passes: finish a game, rate it 10, archive it", () => {
  const base = lib(5);
  const head = clone(base);
  Object.assign(head[2], { s: "done", r: 10, cy: 2026, cm: 9 });
  const { errors, summary } = validateGames(base, head);
  assert.deepEqual(errors, []);
  assert.match(summary[0], /changed: Game 3: s "queue" -> "done", r 0 -> 10, cy null -> 2026, cm null -> 9/);
});

await test("adding a record at the end and deleting one pass", () => {
  const base = lib(5);
  const head = clone(base).filter(r => r.id !== 4);
  head.push(rec(6, { t: "HELLDIVERS 2", s: "ongoing" }));
  assert.deepEqual(validateGames(base, head).errors, []);
});

await test("a missing key or an unknown one is refused", () => {
  const base = lib(3);
  const head = clone(base);
  delete head[0].h;
  head[1].rating = 9;
  const { errors } = validateGames(base, head);
  assert.ok(errors.some(e => /missing "h"/.test(e)));
  assert.ok(errors.some(e => /unknown field "rating"/.test(e)));
});

await test("the easy-to-get-wrong values are refused", () => {
  const base = lib(1);
  const bad = [
    { cm: 12 }, { cm: "Oct" }, { r: 11 }, { r: "10" }, { s: "finished" }, { p: "xbox" },
    { gotm: "October 2025" }, { start: "10/06/2026" }, { mastery: "complete" }, { gotmFlair: "yes" },
  ];
  for (const over of bad) {
    const { errors } = validateGames(base, [rec(1, over)]);
    assert.ok(errors.length, `${JSON.stringify(over)} should be refused`);
  }
});

await test("duplicate ids are refused", () => {
  const base = lib(2);
  const { errors } = validateGames(base, [...clone(base), rec(2, { t: "Copy" })]);
  assert.ok(errors.some(e => /id 2 appears more than once/.test(e)));
});

await test("moving a few Up Next games is fine; a re-sort is refused (array order is the priority)", () => {
  const base = lib(40);
  const few = clone(base);
  few.splice(0, 0, ...few.splice(10, 3)); // three games bumped to the top
  assert.deepEqual(validateGames(base, few).errors, []);

  const sorted = clone(base).sort((a, b) => (a.id % 7) - (b.id % 7) || a.id - b.id);
  const { errors } = validateGames(base, sorted);
  assert.ok(errors.some(e => /changed position/.test(e)), "a sorted file must not auto-merge");
  assert.ok(MAX_MOVED < 20);
});

await test("a truncated rewrite that drops many records is refused", () => {
  const base = lib(20);
  const { errors } = validateGames(base, clone(base).slice(0, 20 - (MAX_REMOVED + 1)));
  assert.ok(errors.some(e => /records removed/.test(e)));
});

await test("not an array is refused", () => {
  assert.ok(validateGames(lib(1), { games: [] }).errors.length);
});

console.log(`\n${pass}/${pass + fail} passing`);
process.exit(fail ? 1 : 0);
