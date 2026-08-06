// Same stubbed-fetch pattern as sync-apis.test.mjs. The point of the "rejects a wrong
// match" test specifically: this is a regression test for a real incident — the Steam
// storefront search API once matched "ITTA" to an unrelated "It Takes Two" bundle, and
// "Tomb Raider I Remastered" to the wrong remaster pack, both silently. That must not
// happen again here, so the exact-match rule gets its own test, not just a happy path.
import { normalize, findCover, backfillCovers } from "./backfill-covers.mjs";
import assert from "node:assert/strict";

process.env.STEAMGRIDDB_API_KEY = "fake-key";

let pass = 0, fail = 0;
const test = async (name, fn) => {
  try { await fn(); pass++; console.log(`PASS  ${name}`); }
  catch (e) { fail++; console.log(`FAIL  ${name}\n        ${e.message}`); }
};

function stubSgdb({ searchResults, grids }) {
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    if (opts && opts.method === "HEAD") {
      return new Response(null, { status: 200 });
    }
    if (u.includes("/search/autocomplete/")) {
      return new Response(JSON.stringify({ success: true, data: searchResults }), { status: 200 });
    }
    if (u.includes("/grids/game/")) {
      return new Response(JSON.stringify({ success: true, data: grids }), { status: 200 });
    }
    throw new Error(`unexpected fetch ${u}`);
  };
}

await test("normalize() strips punctuation/case so equivalent titles compare equal", async () => {
  assert.equal(normalize("ITTA"), normalize("itta"));
  assert.equal(normalize("Zelda: A Link to the Past"), normalize("zelda a link to the past"));
  assert.notEqual(normalize("Tomb Raider I Remastered"), normalize("Tomb Raider IV-VI Remastered"));
});

await test("normalize() folds accents so plain-ASCII titles match their accented SteamGridDB listing", async () => {
  // Regression test: every Pokemon title in games.json is stored without the accent
  // ("Pokemon Pokopia"), but SteamGridDB and every other real source list it as
  // "Pokémon Pokopia" -- the exact-match rule was silently rejecting all of them.
  assert.equal(normalize("Pokemon Pokopia"), normalize("Pokémon Pokopia"));
});

await test("findCover matches a plain-ASCII title against an accented SteamGridDB result (the Pokemon regression)", async () => {
  stubSgdb({
    searchResults: [{ id: 5503567, name: "Pokémon Pokopia", types: ["steam"], verified: true }],
    grids: [{ id: 1, score: 8, url: "https://example.com/pokopia.jpg" }],
  });
  const url = await findCover("Pokemon Pokopia");
  assert.equal(url, "https://example.com/pokopia.jpg");
});

await test("findCover accepts an exact normalized title match and returns the highest-score grid", async () => {
  stubSgdb({
    searchResults: [{ id: 42, name: "Chained Echoes", types: ["steam"], verified: true }],
    grids: [
      { id: 1, score: 3, url: "https://example.com/low-score.jpg" },
      { id: 2, score: 9, url: "https://example.com/best.jpg" },
    ],
  });
  const url = await findCover("Chained Echoes");
  assert.equal(url, "https://example.com/best.jpg");
});

await test("findCover rejects a wrong/fuzzy match instead of guessing (the ITTA regression)", async () => {
  stubSgdb({
    searchResults: [{ id: 99, name: "It Takes Two Friend's Pass", types: ["steam"], verified: true }],
    grids: [{ id: 1, score: 10, url: "https://example.com/wrong.jpg" }],
  });
  const url = await findCover("ITTA");
  assert.equal(url, null, "no exact match should exist, so findCover must return null, not a guess");
});

await test("findCover returns null when the matched game has no grids at all", async () => {
  stubSgdb({
    searchResults: [{ id: 7, name: "Some Obscure Game", types: ["steam"], verified: true }],
    grids: [],
  });
  const url = await findCover("Some Obscure Game");
  assert.equal(url, null);
});

await test("backfillCovers only queries games missing from covers, mutates covers, and reports leftovers", async () => {
  stubSgdb({
    searchResults: [{ id: 1, name: "New Game", types: ["steam"], verified: true }],
    grids: [{ id: 1, score: 5, url: "https://example.com/new-game.jpg" }],
  });
  const games = [
    { t: "Already Covered" },
    { t: "New Game" },
  ];
  const covers = { "already covered": "https://example.com/existing.jpg" };
  const log = [];
  const stillMissing = await backfillCovers(games, covers, log);
  assert.equal(covers["new game"], "https://example.com/new-game.jpg");
  assert.equal(covers["already covered"], "https://example.com/existing.jpg", "must not re-query or touch an existing entry");
  assert.deepEqual(stillMissing, []);
});

await test("backfillCovers reports a title as still-missing when nothing matches, without throwing", async () => {
  stubSgdb({ searchResults: [], grids: [] });
  const games = [{ t: "Totally Unknown Game" }];
  const covers = {};
  const log = [];
  const stillMissing = await backfillCovers(games, covers, log);
  assert.deepEqual(stillMissing, ["Totally Unknown Game"]);
  assert.equal(Object.keys(covers).length, 0);
});

console.log(`\n${pass}/${pass + fail} passing`);
process.exit(fail ? 1 : 0);
