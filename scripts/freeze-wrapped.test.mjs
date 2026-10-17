// The Jan 1 freeze: when it fires, and what slice of each input it keeps.
import assert from "node:assert/strict";
import { shouldFreeze, freezeSnapshot, FIRST_YEAR } from "./freeze-wrapped.mjs";

let pass = 0, fail = 0;
const test = async (name, fn) => {
  try { await fn(); pass++; console.log(`PASS  ${name}`); }
  catch (e) { fail++; console.log(`FAIL  ${name}\n        ${e.message}`); }
};

await test("freezes only once the year is over in Eastern time, only once, and not before the ledgers", () => {
  assert.equal(shouldFreeze(2026, new Date("2026-12-31T23:00:00Z")), false);
  assert.equal(shouldFreeze(2026, new Date("2027-01-01T04:59:00Z")), false);   // still Dec 31 in New York
  assert.equal(shouldFreeze(2026, new Date("2027-01-01T13:00:00Z")), true);    // the 8 AM ET sync
  assert.equal(shouldFreeze(2026, new Date("2027-01-01T13:00:00Z"), true), false);
  assert.equal(shouldFreeze(FIRST_YEAR - 1, new Date("2027-01-01T13:00:00Z")), false);
});

await test("the snapshot keeps the year's ledger days plus the last day before as a baseline", () => {
  const ledger = { version: 1, since: "2025-12-20", rawUntil: "2026-10-11",
    days: { "2025-12-20": { 1: 1 }, "2025-12-30": { 1: 2 }, "2026-03-01": { 1: 3 }, "2026-12-31": { 1: 4 }, "2027-01-01": { 1: 5 } } };
  const s = freezeSnapshot({ games: [{ id: 1 }], ledger }, 2026, new Date("2027-01-01T13:00:00Z"));
  assert.deepEqual(Object.keys(s.ledger.days), ["2025-12-30", "2026-03-01", "2026-12-31"]);
  assert.equal(s.ledger.since, "2025-12-20");
  assert.equal(s.frozenAt, "2027-01-01T13:00:00.000Z");
  assert.deepEqual(s.games, [{ id: 1 }]);
});

await test("the snapshot keeps the year's unlocks with a day of margin for Eastern-time bucketing", () => {
  const t = (iso) => Date.parse(iso) / 1000;
  const unlocks = ["2025-12-30T00:00:00Z", "2025-12-31T12:00:00Z", "2026-06-01T00:00:00Z", "2027-01-01T03:00:00Z", "2027-01-03T00:00:00Z"]
    .map((iso, i) => ({ key: "k" + i, ts: t(iso) }));
  const s = freezeSnapshot({ games: [], unlocks }, 2026);
  assert.deepEqual(s.unlocks.map(r => r.key), ["k1", "k2", "k3"]);
  assert.equal(freezeSnapshot({ games: [] }, 2026).ledger, null);
});

console.log(`\n${pass}/${pass + fail} passing`);
process.exit(fail ? 1 : 0);
