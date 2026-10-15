import assert from "node:assert/strict";
import { chooseAppids, parseDetails, parseDeck, formatMeta } from "./library-meta.mjs";

let pass = 0, fail = 0;
const test = async (name, fn) => {
  try { await fn(); pass++; console.log(`PASS  ${name}`); }
  catch (e) { fail++; console.log(`FAIL  ${name}\n        ${e.message}`); }
};

await test("fills the most-played games first and never re-asks a known appid", () => {
  const lib = { steam: [{ appid: 1, hours: 0 }, { appid: 2, hours: 100 }, { appid: 3, hours: 5 }, { appid: 4, hours: 50 }] };
  assert.deepEqual(chooseAppids(lib, { 4: {} }, 2), [2, 3]);
});

await test("store details: genres and Metacritic, and a delisted app is recorded as empty", () => {
  const ok = { 548430: { success: true, data: { genres: [{ description: "Action" }, { description: "Co-op" }], metacritic: { score: 85 } } } };
  assert.deepEqual(parseDetails(ok, 548430), { genres: ["Action", "Co-op"], meta: 85 });
  assert.deepEqual(parseDetails({ 9: { success: false } }, 9), { genres: [], meta: null });
  assert.deepEqual(parseDetails({ 9: { success: true, data: {} } }, 9), { genres: [], meta: null });
});

await test("Deck rating: the resolved category, 0 when unknown", () => {
  assert.equal(parseDeck({ success: 1, results: { resolved_category: 3 } }), 3);
  assert.equal(parseDeck({ success: 1 }), 0);
  assert.equal(parseDeck(null), 0);
});

await test("one appid per line, sorted numerically, and round-trips", () => {
  const m = { 100: { g: ["RPG"], m: null, d: 2 }, 20: { g: [], m: 90, d: 0 } };
  const text = formatMeta(m);
  assert.deepEqual(JSON.parse(text), m);
  assert.ok(text.indexOf('"20"') < text.indexOf('"100"'));
});

console.log(`\n${pass}/${pass + fail} passing`);
process.exit(fail ? 1 : 0);
