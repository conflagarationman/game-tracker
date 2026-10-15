import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { chooseCandidates, fillEstimates, formatEstimates, PER_RUN } from "./library-hltb.mjs";
import { loadPicker } from "./owl-pick.mjs";

const GTPick = await loadPicker(await readFile(new URL("../pick.js", import.meta.url), "utf8"));

let pass = 0, fail = 0;
const test = async (name, fn) => {
  try { await fn(); pass++; console.log(`PASS  ${name}`); }
  catch (e) { fail++; console.log(`FAIL  ${name}\n        ${e.message}`); }
};

const NOW = new Date(2026, 9, 14);
const hrs = (h) => h * 3600;
const library = {
  steam: [
    { appid: 1, name: "Old Favourite", hours: 40, lastPlayed: "2025-01-01" },
    { appid: 2, name: "Never Opened", hours: 0, lastPlayed: null },
    { appid: 3, name: "Low Score", hours: 0, lastPlayed: null },
    { appid: 4, name: "Tracked Already", hours: 40, lastPlayed: "2025-01-01" },
  ],
  ra: [{ title: "Super Mario Kart", console: "SNES", earned: 8, total: 40 }],
};
const meta = { 2: { g: [], m: 90, d: 3 }, 3: { g: [], m: 60, d: 3 } };
const canon = [{ t: "Contra III", c: "SNES", y: 1992, g: "Run and Gun", h: "2h", why: "x" }];
const gotm = { picks: [{ month: "2026-09", tag: "Sep 2026", game: "Kirby's Dream Land", monthsLeft: 11, retired: false }] };
const games = [{ id: 1, t: "Tracked Already", p: "steam", s: "queue", h: null }];
const src = { library, meta, canon, gotm };

// A fake HowLongToBeat: query -> rows. `fail` makes a query throw.
const fakeClient = (db, { fail = {} } = {}) => {
  const asked = [];
  return { asked, async search(q) {
    asked.push(q);
    if (fail[q]) throw new Error(fail[q]);
    return db[q] || [];
  } };
};
const row = (name, main, plus = 0, year = 2020) => ({ game_name: name, comp_main: hrs(main), comp_plus: hrs(plus), release_world: year });

await test("candidates are the owl's own wildcards, minus the canon and anything already answered", () => {
  const all = chooseCandidates(GTPick, games, src, {}, 99, NOW);
  assert.deepEqual(all.map(c => c.key).sort(),
    ["ra:kirby s dream land", "ra:super mario kart", "steam:1", "steam:2"]);
  const left = chooseCandidates(GTPick, games, src, { "steam:1": { t: "Old Favourite", h: "30h" }, "ra:super mario kart": { t: "x", h: null, why: "declined" } }, 99, NOW);
  assert.deepEqual(left.map(c => c.key).sort(), ["ra:kirby s dream land", "steam:2"], "found and declined are never re-asked");
});

await test("a run asks for at most PER_RUN titles", () => {
  const big = { ...src, library: { steam: Array.from({ length: 100 }, (_, i) => ({ appid: 1000 + i, name: `Fav ${i}`, hours: 30, lastPlayed: "2025-01-01" })) } };
  assert.equal(PER_RUN, 40);
  assert.equal(chooseCandidates(GTPick, [], big, {}, PER_RUN, NOW).length, 40);
});

await test("a found game is recorded in the library's style: main story, else main + extras", async () => {
  const known = {};
  const client = fakeClient({ "Old Favourite": [row("Old Favourite", 12.4)], "Never Opened": [row("Never Opened", 0, 9.2)] });
  const r = await fillEstimates([{ key: "steam:1", t: "Old Favourite" }, { key: "steam:2", t: "Never Opened" }], known, [], { client, delayMs: 0, now: "2026-10-14" });
  assert.equal(r.found, 2);
  assert.deepEqual(known, { "steam:1": { t: "Old Favourite", h: "12h", checked: "2026-10-14" }, "steam:2": { t: "Never Opened", h: "9h", checked: "2026-10-14" } });
});

await test("no exact match, an ambiguous title, and no times are all declined, with the reason, and recorded", async () => {
  const known = {};
  const client = fakeClient({
    "Fuzzy": [row("Fuzzy Wuzzy", 5)],
    "Tetris": [row("Tetris", 2, 0, 1989), row("Tetris", 3, 0, 2006)],
    "Unfinished": [row("Unfinished", 0, 0)],
  });
  const r = await fillEstimates([{ key: "steam:10", t: "Fuzzy" }, { key: "steam:11", t: "Tetris" }, { key: "steam:12", t: "Unfinished" }], known, [], { client, delayMs: 0, now: "2026-10-14" });
  assert.equal(r.found, 0);
  assert.equal(r.declined.length, 3);
  assert.deepEqual(r.declined[0].candidates, ["Fuzzy Wuzzy"], "the report names what HLTB offered");
  assert.match(known["steam:11"].why, /share this title/);
  assert.match(known["steam:12"].why, /no times/);
  assert.ok(Object.values(known).every(e => e.h === null && e.checked === "2026-10-14"));
});

await test("a lookup that fails is retried next run, not recorded as declined", async () => {
  const known = {};
  const client = fakeClient({ "Fine": [row("Fine", 4)] }, { fail: { "Flaky": "HLTB search -> 500" } });
  const log = [];
  const r = await fillEstimates([{ key: "steam:1", t: "Flaky" }, { key: "steam:2", t: "Fine" }], known, log, { client, delayMs: 0 });
  assert.equal(r.errors, 1);
  assert.deepEqual(Object.keys(known), ["steam:2"]);
  assert.ok(log.some(l => /Flaky/.test(l)));
});

await test("HowLongToBeat being unreachable stops the run quietly instead of throwing", async () => {
  const known = {};
  const client = fakeClient({}, { fail: { "A": "HLTB init /api/search/site -> 503" } });
  const r = await fillEstimates([{ key: "steam:1", t: "A" }, { key: "steam:2", t: "B" }], known, [], { client, delayMs: 0 });
  assert.match(r.fatal, /init/);
  assert.deepEqual(known, {});
  assert.deepEqual(client.asked, ["A"], "didn't hammer the site after the init failed");
});

await test("the file is written sorted, one answer per line, and an empty one is {}", () => {
  assert.equal(formatEstimates({}), "{}\n");
  const text = formatEstimates({ "steam:2": { t: "B", h: "3h", checked: "d" }, "ra:a": { t: "A", h: null, why: "w", checked: "d" } });
  assert.deepEqual(text.trim().split("\n").map(l => l.trim().split(":")[0]), ["{", '"ra', '"steam', "}"]);
  assert.deepEqual(Object.keys(JSON.parse(text)), ["ra:a", "steam:2"]);
});

await test("the committed library-hltb.json parses and every found entry has hours", async () => {
  const data = JSON.parse(await readFile(new URL("../library-hltb.json", import.meta.url), "utf8"));
  for (const [k, e] of Object.entries(data)) {
    assert.match(k, /^(steam:\d+|ra:.+)$/);
    assert.ok(e.t && e.checked && (e.h ? GTPick.parseHltb(e.h) > 0 : e.why), k);
  }
});

console.log(`\n${pass}/${pass + fail} passing`);
process.exit(fail ? 1 : 0);
