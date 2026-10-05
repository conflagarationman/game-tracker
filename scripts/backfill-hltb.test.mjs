// Stubbed-fetch tests, same pattern as the other suites: no network, no HLTB.
import { backfillHltb, parseInit, pickMatch, formatHours, hltbCandidates, HltbClient, discoverSearchApi } from "./backfill-hltb.mjs";
import assert from "node:assert/strict";

let pass = 0, fail = 0;
const test = async (name, fn) => {
  try { await fn(); pass++; console.log(`PASS  ${name}`); }
  catch (e) { fail++; console.log(`FAIL  ${name}\n        ${e.message}`); }
};

const hrs = (h) => h * 3600;

// A fake HLTB. `db` maps a search query to its result rows. Records what was sent.
function stubHltb({ db = {}, initStatus = () => 200, searchStatus = () => 200, home = "", chunks = {} } = {}) {
  const sent = [];
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    const path = u.replace("https://howlongtobeat.com", "");
    if (path.includes("/init?t=")) {
      const api = path.split("/init?t=")[0];
      const st = initStatus(api);
      if (st !== 200) return new Response("nope", { status: st });
      return new Response(JSON.stringify({ token: "tok", hpKey: "k1", hpVal: "v1" }), { status: 200 });
    }
    if (path === "/") return new Response(home, { status: 200 });
    if (path.startsWith("/_next/")) return new Response(chunks[path] || "", { status: chunks[path] ? 200 : 404 });
    if (opts.method === "POST") {
      const body = JSON.parse(opts.body);
      sent.push({ api: path, headers: opts.headers, body });
      const st = searchStatus(path);
      if (st !== 200) return new Response("nope", { status: st });
      const q = body.searchTerms.join(" ");
      return new Response(JSON.stringify({ data: db[q] || [] }), { status: 200 });
    }
    throw new Error(`unexpected fetch ${u}`);
  };
  return sent;
}

const run = (games, opts = {}) => backfillHltb(games, [], { delayMs: 0, ...opts });

await test("formatHours matches the library's own style", () => {
  assert.equal(formatHours(hrs(0.3)), "0.3h");
  assert.equal(formatHours(hrs(3.4)), "3.5h");
  assert.equal(formatHours(hrs(6)), "6h");
  assert.equal(formatHours(hrs(12.4)), "12h");
  assert.equal(formatHours(hrs(49.6)), "50h");
});

await test("fills a blank h (main story) and a blank year, and keeps record order", async () => {
  stubHltb({ db: { "Animal Well": [{ game_name: "Animal Well", comp_main: hrs(5.2), comp_plus: hrs(9), release_world: 2024 }] } });
  const games = [
    { id: 1, t: "First", s: "queue", h: "8h", y: 2020 },
    { id: 2, t: "Animal Well", s: "queue", h: null, y: null },
    { id: 3, t: "Last", s: "queue", h: "2h", y: 2021 },
  ];
  const { filled } = await run(games);
  assert.equal(filled, 1);
  assert.deepEqual(games.map(g => g.id), [1, 2, 3], "array order is the Up Next priority");
  assert.equal(games[1].h, "5h");
  assert.equal(games[1].y, 2024);
});

await test("never overwrites a value a person typed, and skips ongoing and dropped games", async () => {
  const sent = stubHltb({ db: { "Hades": [{ game_name: "Hades", comp_main: hrs(22), release_world: 2020 }] } });
  const games = [
    { t: "Hades", s: "queue", h: "10-15h", y: 2020 },
    { t: "World of Warcraft", s: "ongoing", h: null, y: null },
    { t: "Gave Up", s: "dropped", h: null, y: null },
  ];
  await run(games);
  assert.equal(games[0].h, "10-15h");
  assert.equal(games[1].h, null, "ongoing has no finish line; null is correct");
  assert.equal(sent.length, 0, "nothing needed asking");
});

await test("exact match only: a sequel or near name is declined and reported (the Yoshi's Island rule)", async () => {
  stubHltb({ db: { "Super Mario World": [{ game_name: "Super Mario World 2: Yoshi's Island", comp_main: hrs(12) }] } });
  const games = [{ t: "Super Mario World", s: "soon", h: null, y: 1990 }];
  const { stillMissing } = await run(games);
  assert.equal(games[0].h, null);
  assert.equal(stillMissing[0].reason, "no exact title match");
  assert.deepEqual(stillMissing[0].candidates, ["Super Mario World 2: Yoshi's Island"]);
});

await test("same-named games are told apart by the record's year, or declined", () => {
  const rows = [
    { game_name: "Tetris", release_world: 1984, comp_main: hrs(1) },
    { game_name: "Tetris", release_world: 1989, comp_main: hrs(2) },
  ];
  assert.equal(pickMatch(rows, "Tetris", { y: 1989 }).match.comp_main, hrs(2));
  const none = pickMatch(rows, "Tetris", { y: null });
  assert.equal(none.match, null, "no year to go on, so no coin flip");
  assert.match(none.reason, /2 HLTB games share this title/);
});

await test("tries the fuller official name: Steam aliases and the Zelda rule", async () => {
  assert.ok(hltbCandidates("Midnight Suns").includes("Marvel's Midnight Suns"));
  assert.ok(hltbCandidates("Zelda: Spirit Tracks").includes("The Legend of Zelda: Spirit Tracks"));
  stubHltb({ db: { "Marvel's Midnight Suns": [{ game_name: "Marvel's Midnight Suns", comp_main: hrs(40) }] } });
  const games = [{ t: "Midnight Suns", s: "soon", h: null, y: 2022 }];
  await run(games);
  assert.equal(games[0].h, "40h");
});

await test("an unreleased game with no times yet stays blank and is reported as waiting", async () => {
  stubHltb({ db: { "Slay the Spire 2": [{ game_name: "Slay the Spire 2", comp_main: 0, comp_plus: 0, release_world: 2026 }] } });
  const games = [{ t: "Slay the Spire 2", s: "soon", h: null, y: 2026 }];
  const { stillMissing } = await run(games);
  assert.equal(games[0].h, null);
  assert.match(stillMissing[0].reason, /no times for it yet/);
});

await test("sends the auth triple as headers and mirrors the hp pair into the body", async () => {
  const sent = stubHltb({ db: { "Steep": [{ game_name: "Steep", comp_main: hrs(9) }] } });
  await run([{ t: "Steep", s: "soon", h: null, y: 2016 }]);
  assert.equal(sent[0].api, "/api/search/site");
  assert.equal(sent[0].headers["x-auth-token"], "tok");
  assert.equal(sent[0].headers["x-hp-key"], "k1");
  assert.equal(sent[0].headers["x-hp-val"], "v1");
  assert.equal(sent[0].body.k1, "v1", "HLTB rejects a search without the body mirror");
});

await test("a renamed endpoint is rediscovered from the site's own JS", async () => {
  const sent = stubHltb({
    db: { "Steep": [{ game_name: "Steep", comp_main: hrs(9) }] },
    initStatus: api => (api === "/api/search/site" ? 404 : 200),
    home: '<script src="/_next/static/chunks/a.js"></script><script src="/_next/static/chunks/b.js"></script>',
    chunks: {
      "/_next/static/chunks/a.js": "nothing here",
      "/_next/static/chunks/b.js": 'fetch("/api/lookup/v2/init?t=".concat(Date.now()))',
    },
  });
  const games = [{ t: "Steep", s: "soon", h: null, y: 2016 }];
  await run(games);
  assert.equal(games[0].h, "9h");
  assert.equal(sent[0].api, "/api/lookup/v2");
  assert.equal(await discoverSearchApi(), "/api/lookup/v2");
});

await test("an expired token is refreshed once", async () => {
  let calls = 0;
  stubHltb({
    db: { "Steep": [{ game_name: "Steep", comp_main: hrs(9) }] },
    searchStatus: () => (++calls === 1 ? 403 : 200),
  });
  const games = [{ t: "Steep", s: "soon", h: null, y: 2016 }];
  await run(games);
  assert.equal(games[0].h, "9h");
});

await test("a broken protocol fails loudly instead of reporting nothing to fill", async () => {
  stubHltb({ initStatus: () => 500 });
  await assert.rejects(run([{ t: "Steep", s: "soon", h: null, y: 2016 }]), /no HLTB lookup succeeded/);
});

await test("one failed lookup among working ones doesn't fail the run", async () => {
  stubHltb({
    db: { "Steep": [{ game_name: "Steep", comp_main: hrs(9) }] },
    searchStatus: () => 200,
  });
  const client = new HltbClient();
  const real = client.search.bind(client);
  client.search = async (q) => { if (q === "Broken") throw new Error("HLTB search -> 502"); return real(q); };
  const games = [{ t: "Broken", s: "soon", h: null, y: 2000 }, { t: "Steep", s: "soon", h: null, y: 2016 }];
  const { filled, errors } = await run(games, { client });
  assert.equal(filled, 1);
  assert.equal(errors, 1);
});

await test("init fields are found by name, not hardcoded (the first live run's failure)", () => {
  assert.deepEqual(parseInit({ token: "t", hpKey: "k", hpVal: "v" }), { token: "t", hpKey: "k", hpVal: "v" });
  assert.deepEqual(parseInit({ token: "t", abcKey: "k2", someVal: "v2" }), { token: "t", hpKey: "k2", hpVal: "v2" });
  assert.deepEqual(parseInit({ token: "t" }), { token: "t", hpKey: null, hpVal: null }, "the hp pair is optional");
  assert.throws(() => parseInit({ auth: "x", hpKey: "k" }), /without a token \(fields: auth, hpKey\)/,
    "a failure names the fields it did get, so the next fix is evidence-based");
});

await test("a token-only init still searches, without an hp pair", async () => {
  const sent = [];
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u.includes("/init?t=")) return new Response(JSON.stringify({ token: "only" }), { status: 200 });
    sent.push({ headers: opts.headers, body: JSON.parse(opts.body) });
    return new Response(JSON.stringify({ data: [{ game_name: "Steep", comp_main: hrs(9) }] }), { status: 200 });
  };
  const games = [{ t: "Steep", s: "soon", h: null, y: 2016 }];
  await run(games);
  assert.equal(games[0].h, "9h");
  assert.equal(sent[0].headers["x-auth-token"], "only");
  assert.ok(!("x-hp-key" in sent[0].headers));
  assert.ok(!("null" in sent[0].body) && !("undefined" in sent[0].body));
});

console.log(`\n${pass}/${pass + fail} passing`);
process.exit(fail ? 1 : 0);
