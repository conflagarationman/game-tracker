// Same stubbed-fetch pattern as sync-apis.test.mjs. The point of the "rejects a wrong
// match" test specifically: this is a regression test for a real incident — the Steam
// storefront search API once matched "ITTA" to an unrelated "It Takes Two" bundle, and
// "Tomb Raider I Remastered" to the wrong remaster pack, both silently. That must not
// happen again here, so the exact-match rule gets its own test, not just a happy path.
import { normalize, findCover, findCoverDetailed, candidateQueries, backfillCovers } from "./backfill-covers.mjs";
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

await test("normalize() folds diacritics, so an accented catalogue title matches a plain one", () => {
  // The Pokopia regression: the catalogue calls it "Pokémon Pokopia", this library calls it
  // "Pokemon Pokopia", and one accent was enough for the exact-match rule to decline it.
  assert.equal(normalize("Pokémon Pokopia"), normalize("Pokemon Pokopia"));
  assert.equal(normalize("Pokémon LeafGreen"), normalize("Pokemon LeafGreen"));
  assert.equal(normalize("Ōkami"), normalize("Okami"));
  // Folding must not make genuinely different games collide.
  assert.notEqual(normalize("Pokemon Ultra Sun"), normalize("Pokemon Ultra Moon"));
});

await test("candidateQueries widens the search without loosening acceptance", () => {
  assert.deepEqual(candidateQueries("Chained Echoes"), ["Chained Echoes"], "an ordinary title asks once");

  const zelda = candidateQueries("Zelda: Spirit Tracks");
  assert.ok(zelda.includes("Zelda: Spirit Tracks"), "the literal title is tried first");
  assert.ok(zelda.includes("The Legend of Zelda: Spirit Tracks"), "and the catalogue's fuller form");

  const port = candidateQueries("Zelda: Majora's Mask (2S2H)");
  assert.ok(port.includes("Zelda: Majora's Mask"), "a known fan-port tag is dropped");
  assert.ok(port.includes("The Legend of Zelda: Majora's Mask"), "both rules compose");

  // A parenthetical that marks a DIFFERENT edition must survive, or the edition silently
  // inherits the wrong game's art — the same class of error as the ITTA mismatch.
  const remake = candidateQueries("Zelda: Link's Awakening (2019)");
  assert.ok(!remake.includes("Zelda: Link's Awakening"),
    "a year marks a distinct remake with its own art, so it must not be stripped");
  assert.ok(remake.every(q => q.includes("(2019)")), "every candidate keeps the edition marker");

  assert.deepEqual(candidateQueries("Celeste (PICO-8)"), ["Celeste (PICO-8)"],
    "the PICO-8 prototype is not the 2018 game and must not borrow its art");

  assert.ok(candidateQueries("999: Nine Hours, Nine Persons").includes("Nine Hours, Nine Persons, Nine Doors"),
    "an irreducible difference comes from the alias map");
});

await test("a Pokemon title now resolves against the catalogue's accented name", async () => {
  stubSgdb({
    searchResults: [{ id: 5, name: "Pokémon Pokopia", types: ["nswitch"], verified: true }],
    grids: [{ id: 1, score: 8, url: "https://example.com/pokopia.jpg" }],
  });
  const found = await findCoverDetailed("Pokemon Pokopia");
  assert.equal(found.url, "https://example.com/pokopia.jpg");
  assert.equal(found.matchedAs, "Pokémon Pokopia");
});

await test("a Zelda title resolves via the fuller catalogue name, on the second query", async () => {
  const queried = [];
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    if (opts && opts.method === "HEAD") return new Response(null, { status: 200 });
    if (u.includes("/search/autocomplete/")) {
      const q = decodeURIComponent(u.split("/search/autocomplete/")[1]);
      queried.push(q);
      // The catalogue only knows the full name, so the literal short title finds nothing.
      const data = q.startsWith("The Legend of Zelda")
        ? [{ id: 9, name: "The Legend of Zelda: Spirit Tracks", verified: true }]
        : [];
      return new Response(JSON.stringify({ success: true, data }), { status: 200 });
    }
    if (u.includes("/grids/game/")) {
      return new Response(JSON.stringify({ success: true, data: [{ id: 1, score: 4, url: "https://example.com/st.jpg" }] }), { status: 200 });
    }
    throw new Error(`unexpected fetch ${u}`);
  };
  const found = await findCoverDetailed("Zelda: Spirit Tracks");
  assert.equal(found.url, "https://example.com/st.jpg");
  assert.deepEqual(queried, ["Zelda: Spirit Tracks", "The Legend of Zelda: Spirit Tracks"],
    "the literal title is tried before the derived one");
});

await test("a decline explains itself and names what the catalogue offered", async () => {
  stubSgdb({
    searchResults: [{ id: 99, name: "It Takes Two Friend's Pass", verified: true }],
    grids: [{ id: 1, score: 10, url: "https://example.com/wrong.jpg" }],
  });
  const found = await findCoverDetailed("ITTA");
  assert.equal(found.url, null, "still declines rather than guessing");
  assert.match(found.reason, /no exact title match/);
  assert.deepEqual(found.seen, ["It Takes Two Friend's Pass"], "the near-miss is reported so an alias is one line away");
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

await test("backfillCovers reports a still-missing title with the reason it failed, without throwing", async () => {
  stubSgdb({ searchResults: [], grids: [] });
  const games = [{ t: "Totally Unknown Game" }];
  const covers = {};
  const log = [];
  const stillMissing = await backfillCovers(games, covers, log);
  assert.equal(stillMissing.length, 1);
  assert.equal(stillMissing[0].title, "Totally Unknown Game");
  assert.match(stillMissing[0].reason, /returned nothing/, "a decline must say why, not just that it declined");
  assert.deepEqual(stillMissing[0].candidates, []);
  assert.equal(Object.keys(covers).length, 0);
});

console.log(`\n${pass}/${pass + fail} passing`);
process.exit(fail ? 1 : 0);
