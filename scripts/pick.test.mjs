// pick.js is a plain browser script (index.html loads it with <script src>), so it's run here
// in a fresh VM context the same way, rather than being reshaped into a module for the test.
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import assert from "node:assert/strict";

const ctx = {};
vm.createContext(ctx);
vm.runInContext(await readFile(new URL("../pick.js", import.meta.url), "utf8"), ctx);
const { pickGames, remaining, devicesWithGames, achLeft, wildcards, owlLineup, nextSkip, isHidden, wildKey } = ctx.GTPick;

let pass = 0, fail = 0;
const test = async (name, fn) => {
  try { await fn(); pass++; console.log(`PASS  ${name}`); }
  catch (e) { fail++; console.log(`FAIL  ${name}\n        ${e.message}`); }
};

const NOW = new Date(2026, 9, 11);
const g = (id, over = {}) => ({ id, t: `Game ${id}`, p: "steam", s: "queue", h: null, actualHours: null,
  lastPlayed: null, release: null, gotm: null, gotmFlair: false, ...over });
// Arrays made inside the VM context fail deepEqual's prototype check, so copy them out.
const titles = (r) => Array.from(r, x => x.g.t);

await test("remaining subtracts real playtime and never reaches zero", () => {
  assert.equal(remaining(g(1, { h: "20h", actualHours: 5 })), 15);
  assert.equal(remaining(g(1, { h: "10-14h" })), 12);
  assert.equal(remaining(g(1, { h: "10h", actualHours: 30 })), 1);
  assert.equal(remaining(g(1, { h: null, actualHours: 3 })), null);
});

await test("only playing/queue are offered by default; someday, done and ongoing stay out", () => {
  const games = [g(1, { s: "soon" }), g(2, { s: "done" }), g(3, { s: "ongoing" }), g(4), g(5, { s: "playing" })];
  assert.deepEqual(titles(pickGames(games, { now: NOW })).sort(), ["Game 4", "Game 5"]);
});

await test("ongoing games are offered for a quick session", () => {
  const games = [g(3, { s: "ongoing", t: "Marvel Snap" }), g(4, { h: "40h" })];
  assert.equal(titles(pickGames(games, { time: "quick", now: NOW }))[0], "Marvel Snap");
});

await test("the device filter is strict: Thor sees AYN and retro only", () => {
  const games = [g(1, { p: "ayn" }), g(2, { p: "retro" }), g(3, { p: "switch2" }), g(4, { p: "steam" })];
  assert.deepEqual(titles(pickGames(games, { device: "thor", now: NOW })).sort(), ["Game 1", "Game 2"]);
});

await test("unreleased games are never suggested", () => {
  const games = [g(1, { release: "2026-11-05" }), g(2, { release: "2026-10-11" })];
  assert.deepEqual(titles(pickGames(games, { now: NOW })), ["Game 2"]);
});

await test("a game you could finish tonight beats a long one ahead of it in the queue", () => {
  const games = [g(1, { h: "50h" }), g(2, { h: "3h", actualHours: 1 })];
  const r = pickGames(games, { time: "evening", now: NOW });
  assert.equal(r[0].g.t, "Game 2");
  assert.match(r[0].reasons[0], /Could finish it \(~2h left\)/);
});

await test("Up Next order still matters when nothing else separates two games", () => {
  const games = [g(1, { h: "40h" }), g(2, { h: "40h" })];
  assert.deepEqual(titles(pickGames(games, { now: NOW })), ["Game 1", "Game 2"]);
});

await test("an expiring GOTM pick pulls a Someday game in and to the top", () => {
  const gotm = { picks: [{ tag: "Nov 2025", monthsLeft: 1, retired: false }] };
  const games = [g(1, { s: "playing" }), g(2, { s: "soon", gotm: "Nov 2025", t: "Club pick" })];
  const r = pickGames(games, { gotm, now: NOW });
  assert.equal(r[0].g.t, "Club pick");
  assert.equal(r[0].reasons[0], "GOTM: last month to claim");
});

await test("a claimed (flaired) or retired pick is not a reason", () => {
  const gotm = { picks: [{ tag: "Nov 2025", monthsLeft: 1, retired: false }, { tag: "Oct 2025", monthsLeft: 0, retired: true }] };
  const games = [g(1, { s: "soon", gotm: "Nov 2025", gotmFlair: true }), g(2, { s: "soon", gotm: "Oct 2025" })];
  assert.equal(pickGames(games, { gotm, now: NOW }).length, 0);
});

await test("recent real play counts, even for a game not marked playing", () => {
  const play = { windowDays: 14, recent: { 2: { mins: 600 } } };
  const games = [g(1, { s: "playing" }), g(2, { t: "Secretly playing" })];
  const r = pickGames(games, { play, now: NOW });
  assert.equal(r[0].g.t, "Secretly playing");
  assert.ok(r[0].reasons.includes("10h in the last 14 days"));
});

await test("a quick session doesn't suggest starting a big new game over one in progress", () => {
  const games = [g(1, { h: "60h" }), g(2, { s: "playing", h: "40h", actualHours: 10 })];
  assert.equal(titles(pickGames(games, { time: "quick", now: NOW }))[0], "Game 2");
});

await test("a long-dormant Now Playing game says so instead of 'in progress'", () => {
  const r = pickGames([g(1, { s: "playing", lastPlayed: "2026-08-01" })], { now: NOW });
  assert.match(r[0].reasons.join(" "), /Dormant 71 days/);
});

await test("device chips only list devices that have something to play", () => {
  const games = [g(1, { p: "ayn" }), g(2, { p: "ps5", s: "done" })];
  assert.deepEqual(Array.from(devicesWithGames(games)), ["any", "thor"]);
});

await test("the real games.json produces suggestions for every time, device and mood it lists", async () => {
  const games = JSON.parse(await readFile(new URL("../games.json", import.meta.url), "utf8"));
  for (const device of devicesWithGames(games))
    for (const time of ["quick", "evening", "long"])
      for (const mood of [undefined, "chill", "deep", "finish"]) {
        const r = pickGames(games, { device, time, mood, now: NOW });
        assert.ok(r.length > 0, `${device}/${time}/${mood} produced nothing`);
        r.forEach(x => {
          assert.ok(x.reasons.length > 0, `${x.g.t} has no reason`);
          assert.equal(new Set(x.reasons).size, x.reasons.length, `${x.g.t} repeats a reason: ${x.reasons}`);
        });
      }
});

await test("being a few achievements from 100% is a reason; casual and unstarted games aren't", () => {
  assert.equal(achLeft(g(1, { achCount: [27, 30] })), 3);
  assert.equal(achLeft(g(1, { achCount: [27, 30], casual: true })), null);
  assert.equal(achLeft(g(1, { achCount: [0, 3] })), null);
  assert.equal(achLeft(g(1, { achCount: [10, 30] })), null);
  assert.equal(achLeft(g(1, { achCount: [30, 30] })), null);
  const r = pickGames([g(1, { s: "playing", achCount: [29, 30] })], { now: NOW });
  assert.ok(r[0].reasons.includes("1 achievement from 100%"));
});

await test("chill mood steers away from soulslikes and lets Ongoing in at any length", () => {
  const games = [g(1, { s: "playing", g: "Soulslike" }), g(2, { s: "playing", g: "Puzzle" }), g(3, { s: "ongoing", g: "CCG", t: "Snap" })];
  const r = titles(pickGames(games, { mood: "chill", time: "evening", now: NOW }));
  assert.ok(r.includes("Snap"));
  assert.equal(r[r.length - 1], "Game 1");
});

await test("finish mood prefers what's nearly done over the top of Up Next", () => {
  const games = [g(1, { h: "30h" }), g(2, { s: "playing", h: "12h", actualHours: 9 })];
  assert.equal(titles(pickGames(games, { mood: "finish", time: "quick", now: NOW }))[0], "Game 2");
});

await test("deep mood prefers a long game over a short one", () => {
  const games = [g(1, { s: "playing", h: "4h" }), g(2, { s: "playing", h: "60h", g: "RPG" })];
  assert.equal(titles(pickGames(games, { mood: "deep", time: "long", now: NOW }))[0], "Game 2");
});


// ─── owl.html: Someday, wildcards and the lineup ─────────
const kinds = (r) => Array.from(r, x => x.kind);
const canon = [{ t: "Tetris Attack", c: "SNES", y: 1996, g: "Puzzle", h: "5h", why: "chains" },
               { t: "Contra III", c: "SNES", y: 1992, g: "Run and Gun", h: "1h", why: "boom" }];

await test("Someday stays out of the plain picker and comes in for the owl", () => {
  const games = [g(1, { s: "soon", t: "Someday game" })];
  assert.equal(pickGames(games, { now: NOW }).length, 0);
  const r = pickGames(games, { someday: true, now: NOW });
  assert.equal(r[0].kind, "someday");
  assert.ok(r[0].reasons.includes("From your Someday pile"));
});

await test("chill: shooters and action platformers don't count as easy on the mind", () => {
  const r = pickGames([g(1, { s: "playing", g: "Shooter" }), g(2, { s: "playing", g: "Action Platformer" }),
                       g(3, { s: "playing", g: "Puzzle" })], { mood: "chill", now: NOW });
  assert.deepEqual(Array.from(r, x => [x.g.id, x.fits]), [[3, true], [1, false], [2, false]]);
});

await test("God of War is not the owl's first answer for a chill half-hour on the Thor", () => {
  const games = [g(400, { t: "God of War", p: "ayn", g: "Action-Adventure", h: "9h", lastPlayed: "2026-10-09" }),
                 g(401, { t: "Pokemon Lazarus", p: "ayn", g: "RPG" })];
  const r = owlLineup(games, { canon }, { device: "thor", time: "quick", mood: "chill", now: NOW }, () => 0.5);
  assert.notEqual(r[0].t, "God of War");
  assert.equal(r[0].t, "Tetris Attack");
  assert.ok(r[0].fits);
});

await test("wildcards: favourites, acclaimed-unplayed, Deck-unsupported and already-tracked", () => {
  const library = { steam: [
    { appid: 1, name: "Brotato", hours: 112, lastPlayed: "2026-07-07" },
    { appid: 2, name: "Balatro", hours: 88, lastPlayed: "2026-10-10" },        // played lately: not a wildcard
    { appid: 3, name: "Hades", hours: 0, lastPlayed: null },
    { appid: 4, name: "Meh Game", hours: 0, lastPlayed: null },                 // no score: skipped
    { appid: 5, name: "Farmed", hours: 3, lastPlayed: "2025-01-01" },           // card-idle range
    { appid: 6, name: "Steep™", hours: 40, lastPlayed: "2025-01-01" },          // tracked as "Steep"
    { appid: 7, name: "No Deck", hours: 0, lastPlayed: null } ], ra: [] };
  const meta = { 3: { g: ["Action"], m: 93, d: 3 }, 4: { g: [], m: null, d: 0 }, 7: { g: [], m: 90, d: 1 } };
  const games = [g(9, { t: "Steep" })];
  const pc = wildcards(games, { library, meta }, { device: "pc", now: NOW });
  assert.deepEqual(Array.from(pc, w => w.t).sort(), ["Brotato", "Hades", "No Deck"]);
  assert.equal(pc.find(w => w.t === "Brotato").reasons[0], "112h logged · last played Jul 2026");
  const deck = wildcards(games, { library, meta }, { device: "deck", now: NOW });
  assert.ok(!deck.some(w => w.t === "No Deck"));
  assert.equal(wildcards(games, { library, meta }, { device: "thor", now: NOW }).length, 0);
});

await test("retro wildcards: half-finished RA runs, unclaimed club picks, and the canon minus what you've logged", () => {
  const library = { steam: [], ra: [
    { title: "Super Mario Kart", console: "SNES", earned: 8, total: 40 },
    { title: "Tetris Attack", console: "SNES", earned: 0, total: 30 },       // touched on RA: not "unlogged"
    { title: "Done Deal", console: "NES", earned: 39, total: 40 } ] };       // 98%: not half-finished
  const gotm = { picks: [{ tag: "Sep 2026", game: "Kirby's Dream Land", monthsLeft: 11, retired: false },
                         { tag: "Aug 2026", game: "Tracked Pick", monthsLeft: 10, retired: false },
                         { tag: "Jan 2025", game: "Retired Pick", monthsLeft: 0, retired: true }] };
  const games = [g(1, { t: "Something", gotm: "Aug 2026" })];
  const r = wildcards(games, { library, canon, gotm }, { device: "thor", now: NOW });
  assert.deepEqual(Array.from(r, w => w.kind + ":" + w.t).sort(),
    ["retro-canon:Contra III", "retro-club:Kirby's Dream Land", "retro-started:Super Mario Kart"]);
  assert.equal(wildcards(games, { library, canon, gotm }, { device: "pc", now: NOW }).length, 0);
});

await test("lineup: a wildcard every third suggestion, and wildcards alone when nothing is tracked", () => {
  const games = [1, 2, 3, 4, 5].map(i => g(i, { h: "40h" }));
  const r = owlLineup(games, { canon }, { device: "any", now: NOW }, () => 0.5);
  assert.deepEqual(kinds(r).slice(0, 6), ["tracked", "tracked", "retro-canon", "tracked", "tracked", "retro-canon"]);
  assert.deepEqual(kinds(owlLineup([], { canon }, { device: "thor", now: NOW }, () => 0.5)), ["retro-canon", "retro-canon"]);
});

// ─── Snoozes and drops ─────────────────────────────────
const D = (y, m, d) => new Date(y, m - 1, d);

await test("snoozes escalate 7, 30, 90 days and stay at 90; a drop is only a flag", () => {
  let e = null;
  const seen = [];
  for (let i = 0; i < 4; i++) { e = nextSkip(e, "Game 1", { now: NOW }); seen.push([e.count, e.until]); }
  assert.deepEqual(seen, [[1, "2026-10-18"], [2, "2026-11-10"], [3, "2027-01-09"], [4, "2027-01-09"]]);
  assert.equal(Array.from(ctx.GTPick.SNOOZE_DAYS).join(), "7,30,90");
  const d = nextSkip({ t: "Game 1", count: 3, until: null, dropped: false }, "Game 1", { drop: true, now: NOW });
  assert.deepEqual({ ...d }, { t: "Game 1", count: 4, until: null, dropped: true, last: "2026-10-11" });
});

await test("a snooze lapses on its day, a drop never does", () => {
  const snooze = nextSkip(null, "Game 1", { now: NOW });                 // until 2026-10-18
  assert.equal(isHidden(snooze, D(2026, 10, 17)), true);
  assert.equal(isHidden(snooze, D(2026, 10, 18)), false);
  assert.equal(isHidden(nextSkip(null, "Game 1", { drop: true, now: NOW }), D(2030, 1, 1)), true);
  assert.equal(isHidden(undefined, NOW), false);
});

await test("keys: id for tracked, appid for Steam, normalised title for RA, club and canon", () => {
  const games = [g(7, { h: "5h" })];
  const library = { steam: [{ appid: 1145360, name: "Hades", hours: 40, lastPlayed: "2026-01-01" }],
    ra: [{ title: "Super Mario Kart", console: "SNES", earned: 8, total: 40 }] };
  const gotm = { picks: [{ tag: "Sep 2026", game: "Kirby's Dream Land", monthsLeft: 11, retired: false }] };
  const canon = [{ t: "Contra III: The Alien Wars", c: "SNES", y: 1992, g: "Run and Gun", h: "2h", why: "x" }];
  const lineup = owlLineup(games, { library, canon, gotm }, { device: "any", now: NOW }, () => 0.5);
  assert.equal(lineup.find(r => r.g).key, "id:7");
  const keys = Object.fromEntries(Array.from(wildcards(games, { library, canon, gotm }, { device: "any", now: NOW }), w => [w.kind, w.key]));
  assert.deepEqual(keys, { "steam-favourite": "steam:1145360", "retro-started": "ra:super mario kart",
    "retro-club": "ra:kirby s dream land", "retro-canon": "canon:contra iii the alien wars" });
  assert.equal(wildKey({ kind: "retro-canon", t: "Contra III: The Alien Wars" }), "canon:contra iii the alien wars");
});

await test("lineup leaves out snoozed and dropped games, tracked and wildcard, and restoring brings them back", () => {
  const games = [1, 2, 3].map(i => g(i, { h: "40h" }));
  const canon = [{ t: "Contra III", c: "SNES", y: 1992, g: "Run and Gun", h: "2h", why: "x" }];
  const all = (skips) => Array.from(owlLineup(games, { canon, skips }, { device: "any", now: NOW }, () => 0.5), r => r.key).sort();
  assert.deepEqual(all({}), ["canon:contra iii", "id:1", "id:2", "id:3"]);
  const skips = { "id:1": nextSkip(null, "Game 1", { now: NOW }), "canon:contra iii": nextSkip(null, "Contra III", { drop: true, now: NOW }) };
  assert.deepEqual(all(skips), ["id:2", "id:3"]);
  delete skips["canon:contra iii"];                                       // Restore deletes the entry
  assert.deepEqual(all(skips), ["canon:contra iii", "id:2", "id:3"]);
  assert.deepEqual(all({ "id:1": skips["id:1"] }).includes("id:1"), false);
  // Once the 7 days are up, he's back.
  const later = Array.from(owlLineup(games, { skips }, { device: "any", now: D(2026, 10, 18) }, () => 0.5), r => r.key);
  assert.ok(later.includes("id:1"));
});

await test("snoozing the top pick doesn't shorten the lineup while there are games to fill it", () => {
  const games = Array.from({ length: 14 }, (_, i) => g(i + 1, { h: "40h" }));
  const skips = { "id:1": nextSkip(null, "Game 1", { now: NOW }), "id:2": nextSkip(null, "Game 2", { now: NOW }) };
  assert.equal(owlLineup(games, { skips }, { device: "any", now: NOW }, () => 0.5).length, 12);
});

console.log(`\n${pass}/${pass + fail} passing`);
process.exit(fail ? 1 : 0);
