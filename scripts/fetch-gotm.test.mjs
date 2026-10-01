// Exercises the GOTM parsing and eligibility maths against a captured August 2026 post, with
// no network. Same plain-script shape as the other suites here: prints N/N and exits non-zero.
import assert from "node:assert/strict";
import {
  parseTitle, parsePreviousList, buildPicks, monthsLeft, monthIndex, toTag, mergeResult,
  fetchLatestGotmPost, assertNotBackwards, GOTM_HOSTS, ELIGIBLE_MONTHS,
} from "./fetch-gotm.mjs";

let pass = 0, fail = 0;
const test = async (name, fn) => {
  try { await fn(); pass++; console.log(`PASS  ${name}`); }
  catch (e) { fail++; console.log(`FAIL  ${name}\n        ${e.message}`); }
};

// Captured from the club's own August 2026 post. The RETIRED / LAST CHANCE markers below are
// the host's, which makes them an independent check on our derived eligibility: reproducing
// them from the 12-month rule alone proves the rule is right.
const TITLE = "August 2026 Game of the Month - Marvel vs. Capcom 2 (Dreamcast)";
const BODY = `Now, this sub is pretty focused on handhelds these days...

As always, you have up to a year to complete past Games of the Month for flair, which means that this month is your last chance to complete Age of Zombies for the PSP.

Useful links:
HowLongToBeat (~1 hour)
Retroachievements: Dreamcast PS2

Previous Games of the Month:
December 2024 - Super Mario World - RETIRED
January 2025 - Metroid Fusion - RETIRED
February 2025 - Metal Gear Solid - RETIRED
March 2025 - Streets of Rage 2 - RETIRED
April 2025 - Chrono Trigger - RETIRED
May 2025 - Mega Man X - RETIRED
June 2025 - Kirby's Dream Land 2 - RETIRED
July 2025 - Devil's Crush - RETIRED
August 2025 - Twisted Metal 2 - RETIRED
September 2025 - Age of Zombies - LAST CHANCE!
October 2025 - Castlevania: Symphony of the Night
November 2025 - Alien Hominid
December 2025 - The Legend of Zelda: A Link to the Past
January 2026 - Ducktales
February 2026 - 999
March 2026 - Sonic the Hedgehog 2
April 2026 - Advance Wars
May 2026 - Celeste
June 2026 - Tomb Raider`;

const NOW = "2026-08";

await test("parseTitle pulls month, game and platform out of the post title", () => {
  assert.deepEqual(parseTitle(TITLE), { month: "2026-08", game: "Marvel vs. Capcom 2", platform: "Dreamcast" });
  assert.deepEqual(parseTitle("March 2026 Game of the Month - Sonic the Hedgehog 2"),
    { month: "2026-03", game: "Sonic the Hedgehog 2", platform: null });
  assert.equal(parseTitle("Weekly discussion thread"), null, "unrelated posts must not match");
  assert.equal(parseTitle("Bogusmonth 2026 Game of the Month - Nope"), null, "an unreal month is not a pick");
});

// Captured from the club's September 2026 post. Starting this month the club alternates the
// usual by-committee title with a "Host Presents" format for months where a randomly-picked
// mod gets carte blanche — same club, same history block, different title shape.
const HOST_TITLE = "hbi2k Presents SEP '26 GotM - Civilization Revolution (DS)";

await test("parseTitle handles a 'MON 'YY GotM' title with no host prefix", () => {
  assert.deepEqual(parseTitle("OCT '26 GotM - Parasite Eve (PS1)"),
    { month: "2026-10", game: "Parasite Eve", platform: "PS1" });
});

await test("parseTitle also handles the alternating 'Host Presents MON 'YY GotM' format", () => {
  assert.deepEqual(parseTitle(HOST_TITLE), { month: "2026-09", game: "Civilization Revolution", platform: "DS" });
  assert.deepEqual(parseTitle("u/somehost Presents jan '27 gotm - Some Game"),
    { month: "2027-01", game: "Some Game", platform: null }, "case must not matter");
  assert.equal(parseTitle("hbi2k Presents Bogusmonth '26 GotM - Nope"), null, "an unreal month is not a pick here either");
});

await test("parsePreviousList reads the whole history block", () => {
  const list = parsePreviousList(BODY);
  assert.equal(list.length, 19, `expected 19 previous picks, got ${list.length}`);
  assert.equal(list[0].month, "2024-12");
  assert.equal(list[0].game, "Super Mario World");
  assert.equal(list.at(-1).month, "2026-06");
  assert.equal(list.at(-1).game, "Tomb Raider");
});

await test("game titles containing hyphens, colons and digits survive parsing", () => {
  const list = parsePreviousList(BODY);
  const byMonth = Object.fromEntries(list.map(p => [p.month, p.game]));
  assert.equal(byMonth["2025-10"], "Castlevania: Symphony of the Night", "colon must not be eaten");
  assert.equal(byMonth["2025-12"], "The Legend of Zelda: A Link to the Past");
  assert.equal(byMonth["2026-02"], "999", "an all-digit title is still a title");
  assert.equal(byMonth["2025-09"], "Age of Zombies", "the LAST CHANCE marker must not stick to the name");
  assert.equal(byMonth["2025-08"], "Twisted Metal 2", "the RETIRED marker must not stick to the name");
});

await test("the list is not assumed contiguous — July 2026 is genuinely absent from it", () => {
  const list = parsePreviousList(BODY);
  assert.ok(!list.some(p => p.month === "2026-07"), "the club's own post skips July 2026");
  assert.ok(list.some(p => p.month === "2026-06"));
  const picks = buildPicks({ current: parseTitle(TITLE), previous: list }, NOW);
  assert.ok(!picks.some(p => p.month === "2026-07"), "a gap must not be invented to fill the hole");
});

await test("derived eligibility reproduces every RETIRED / LAST CHANCE marker in the post", () => {
  const list = parsePreviousList(BODY);
  const picks = buildPicks({ current: parseTitle(TITLE), previous: list }, NOW);
  const byMonth = Object.fromEntries(picks.map(p => [p.month, p]));
  for (const p of list) {
    const derived = byMonth[p.month];
    if (p.postedStatus === "RETIRED") {
      assert.equal(derived.retired, true, `${p.month} ${p.game}: post says RETIRED, we derived ${derived.monthsLeft} months left`);
    } else if (p.postedStatus === "LAST CHANCE") {
      assert.equal(derived.lastChance, true, `${p.month} ${p.game}: post says LAST CHANCE, we derived ${derived.monthsLeft}`);
      assert.equal(derived.retired, false);
    } else {
      assert.equal(derived.retired, false, `${p.month} ${p.game}: post lists it as live, we derived it retired`);
    }
  }
});

await test("months-left maths, including the boundaries the club's markers pin down", () => {
  assert.equal(ELIGIBLE_MONTHS, 12);
  assert.equal(monthsLeft("2025-08", "2026-08"), 0, "twelve months elapsed = retired");
  assert.equal(monthsLeft("2025-09", "2026-08"), 1, "eleven months elapsed = last chance");
  assert.equal(monthsLeft("2025-10", "2026-08"), 2);
  assert.equal(monthsLeft("2026-08", "2026-08"), 12, "the current pick has the full year");
  assert.equal(monthsLeft("2025-12", "2026-01"), 11, "arithmetic must cross the year boundary");
  assert.equal(monthsLeft("bogus", "2026-08"), null);
});

await test("toTag emits the games.json join key, and monthIndex round-trips", () => {
  assert.equal(toTag("2025-10"), "Oct 2025");
  assert.equal(toTag("2026-01"), "Jan 2026");
  assert.equal(toTag("bogus"), null);
  assert.equal(monthIndex("2026-08") - monthIndex("2025-08"), 12);
});

await test("the current pick is merged in and marked, not duplicated", () => {
  const picks = buildPicks({ current: parseTitle(TITLE), previous: parsePreviousList(BODY) }, NOW);
  const aug = picks.filter(p => p.month === "2026-08");
  assert.equal(aug.length, 1, "current month must not appear twice");
  assert.equal(aug[0].isCurrent, true);
  assert.equal(aug[0].game, "Marvel vs. Capcom 2");
  assert.equal(picks.filter(p => p.isCurrent).length, 1);
  assert.equal(picks.length, 20, "19 previous + the current one");
});

await test("markdown-linked entries keep their title and expose the permalink", () => {
  const list = parsePreviousList("Previous Games of the Month:\nOctober 2025 - [Castlevania: Symphony of the Night](https://reddit.com/r/SBCGaming/abc) - RETIRED");
  assert.equal(list[0].game, "Castlevania: Symphony of the Night", "link markup must not leak into the name");
  assert.equal(list[0].url, "https://reddit.com/r/SBCGaming/abc", "each pick links to its own post, the criteria authority");
});

await test("a failed fetch keeps the previous picks and records the error", () => {
  const good = { fetchedAt: "2026-08-01T13:00:00Z", sourceUrl: "https://x", current: { month: "2026-08" },
                 picks: [{ month: "2026-08", game: "Marvel vs. Capcom 2" }], error: null };
  const merged = mergeResult(good, null, "2026-09", new Error("reddit search -> 503"));
  assert.equal(merged.picks.length, 1, "a bad night must not empty the list");
  assert.equal(merged.picks[0].game, "Marvel vs. Capcom 2");
  assert.equal(merged.current.month, "2026-08", "the last known current pick is retained");
  assert.match(merged.error, /503/);
  assert.notEqual(merged.fetchedAt, good.fetchedAt, "the attempt is still stamped, so staleness shows");
});

await test("a failed first run degrades to an empty list rather than throwing", () => {
  const merged = mergeResult(null, null, "2026-08", new Error("arctic shift search \"GotM\" -> 503"));
  assert.deepEqual(merged.picks, []);
  assert.match(merged.error, /503/);
});

await test("a successful fetch clears a previously recorded error", () => {
  const stale = { fetchedAt: "old", sourceUrl: "https://old", picks: [{ month: "2026-07" }], error: "reddit search -> 503" };
  const merged = mergeResult(stale, { sourceUrl: "https://new", current: { month: "2026-08" }, picks: [{ month: "2026-08" }] }, "2026-08", null);
  assert.equal(merged.error, null);
  assert.equal(merged.sourceUrl, "https://new");
  assert.equal(merged.picks.length, 1);
});

// Arctic Shift stub: answers each title search from `byTitle`, recording what was asked.
const arcticStub = (byTitle, calls = []) => async (url) => {
  const u = new URL(String(url));
  assert.equal(u.hostname, "arctic-shift.photon-reddit.com");
  assert.equal(u.searchParams.get("subreddit"), "SBCGaming");
  // Keyed by the title searched, or "author:<name>" for a host lookup.
  const key = u.searchParams.get("title") ?? `author:${u.searchParams.get("author")}`;
  calls.push(key);
  let r = byTitle[key];
  if (typeof r === "function") r = r();
  if (r instanceof Response) return r;
  return new Response(JSON.stringify({ data: r || [] }), { status: 200 });
};

await test("fetchLatestGotmPost needs no credentials and skips posts that aren't a pick", async () => {
  const calls = [];
  const post = await fetchLatestGotmPost(arcticStub({
    "Game of the Month": [
      { id: "b", title: "Game of the Month discussion thread", selftext: "", created_utc: 300 },
      { id: "a", title: "August 2026 Game of the Month - Marvel vs. Capcom 2 (Dreamcast)",
        selftext: "body", permalink: "/r/SBCGaming/comments/a/x/", created_utc: 200 },
    ],
  }, calls));
  assert.deepEqual(calls, [...GOTM_HOSTS.map(h => `author:${h}`), "Game of the Month", "GotM"],
    "host lookup first; with nothing from it, both title formats, one after the other");
  assert.equal(post.title, "August 2026 Game of the Month - Marvel vs. Capcom 2 (Dreamcast)");
  assert.equal(post.body, "body");
  assert.equal(post.url, "https://www.reddit.com/r/SBCGaming/comments/a/x/");
});

await test("fetchLatestGotmPost picks the newest pick across both formats (a host-presented month)", async () => {
  const post = await fetchLatestGotmPost(arcticStub({
    "Game of the Month": [{ id: "a", title: "August 2026 Game of the Month - Marvel vs. Capcom 2", created_utc: 200 }],
    "GotM": [{ id: "c", title: "hbi2k Presents SEP '26 GotM - Civilization Revolution (DS)", created_utc: 400 }],
  }));
  assert.match(post.title, /Civilization Revolution/);
});

await test("the host lookup answers alone when it finds a pick, so the slow title searches never run", async () => {
  // The probe from Actions on 2026-10-01: author=hbi2k in 1.3s, both title searches 5-8s with
  // intermittent "Timeout. Maybe slow down a bit" 422s.
  const calls = [];
  const post = await fetchLatestGotmPost(arcticStub({
    "author:hbi2k": [
      { id: "x", title: "What's your \"old faithful\" handheld?", created_utc: 500 },
      { id: "o", title: "OCT '26 GotM - Parasite Eve (PS1)", created_utc: 400, permalink: "/r/SBCGaming/comments/o/x/" },
      { id: "s", title: "hbi2k Presents SEP '26 GotM - Civilization Revolution (DS)", created_utc: 300 },
    ],
  }, calls), { retryDelayMs: 0 });
  assert.match(post.title, /Parasite Eve/);
  assert.deepEqual(calls, ["author:hbi2k"]);
});

await test("a failed host lookup falls back to the title searches, and one failing title search is tolerated", async () => {
  const post = await fetchLatestGotmPost(arcticStub({
    "author:hbi2k": () => new Response(JSON.stringify({ data: null, error: "Timeout. Maybe slow down a bit" }), { status: 422 }),
    "Game of the Month": () => new Response(JSON.stringify({ data: null, error: "Timeout. Maybe slow down a bit" }), { status: 422 }),
    "GotM": [{ id: "o", title: "OCT '26 GotM - Parasite Eve (PS1)", created_utc: 400 }],
  }), { retryDelayMs: 0 });
  assert.match(post.title, /Parasite Eve/);
});

await test("when every search fails, the error names each one with Arctic Shift's own message", async () => {
  const busy = () => new Response(JSON.stringify({ data: null, error: "Timeout. Maybe slow down a bit" }), { status: 422 });
  await assert.rejects(() => fetchLatestGotmPost(arcticStub({
    "author:hbi2k": busy, "Game of the Month": busy, "GotM": busy,
  }), { retryDelayMs: 0 }), (e) => {
    assert.match(e.message, /author=hbi2k -> 422: .*Timeout/);
    assert.match(e.message, /"GotM" -> 422/);
    return true;
  });
  await assert.rejects(() => fetchLatestGotmPost(async () =>
    new Response(JSON.stringify({ error: "Timeout" }), { status: 200 }), { retryDelayMs: 0 }), /Timeout/);
});

await test("a pick older than the one already known never becomes current (incomplete fallback search)", async () => {
  const known = [{ month: "2026-09" }, { month: "2026-10" }];
  assert.throws(() => assertNotBackwards({ month: "2026-09" }, known, "t"), /refusing to move the current pick backwards/);
  assert.doesNotThrow(() => assertNotBackwards({ month: "2026-10" }, known, "t"), "the same month is fine");
  assert.doesNotThrow(() => assertNotBackwards({ month: "2026-11" }, known, "t"));
  assert.doesNotThrow(() => assertNotBackwards({ month: "2026-01" }, [], "t"), "nothing known yet");
});

await test("fetchLatestGotmPost retries once on a load-shedding 422, then succeeds", async () => {
  // Seen for real on 2026-09-27: "GotM" -> 422 from Actions, while the same request worked
  // moments later from elsewhere.
  const calls = [];
  let gotmCalls = 0;
  const post = await fetchLatestGotmPost(arcticStub({
    "GotM": () => (++gotmCalls === 1
      ? new Response("busy", { status: 422 })
      : new Response(JSON.stringify({ data: [
          { id: "c", title: "hbi2k Presents SEP '26 GotM - Civilization Revolution (DS)", created_utc: 400 }] }), { status: 200 })),
  }, calls), { retryDelayMs: 0 });
  assert.match(post.title, /Civilization Revolution/);
  assert.equal(gotmCalls, 2);
});

await test("a post with no history list keeps every known pick instead of wiping them (host-presented months)", async () => {
  // The real SEP '26 "hbi2k Presents" post has no "Previous Games of the Month" list at all.
  // Rebuilding from it alone would have replaced 22 known picks with one.
  const known = [
    { month: "2025-10", game: "Castlevania: Symphony of the Night", platform: null, url: "u1", isCurrent: false },
    { month: "2026-08", game: "Marvel vs. Capcom 2", platform: "Dreamcast", url: "u2", isCurrent: true },
  ];
  const cur = parseTitle("hbi2k Presents SEP '26 GotM - Civilization Revolution (DS)");
  const picks = buildPicks({ current: cur, previous: parsePreviousList("Happy September! No list this month."), known }, "2026-09");
  assert.deepEqual(picks.map(p => p.month), ["2025-10", "2026-08", "2026-09"]);
  assert.deepEqual(picks.filter(p => p.isCurrent).map(p => p.month), ["2026-09"], "only the new post's pick is current");
  assert.equal(picks[0].monthsLeft, 1, "windows are recomputed, not carried over");
  assert.equal(picks[1].url, "u2", "known details survive");
});

await test("the post's own list still wins over a known pick for the same month", async () => {
  const known = [{ month: "2026-02", game: "999", url: null }];
  const picks = buildPicks({ current: null, previous: [{ month: "2026-02", game: "999: Nine Hours", url: "p" }], known }, "2026-09");
  assert.deepEqual([picks[0].game, picks[0].url], ["999: Nine Hours", "p"]);
});

console.log(`\n${pass}/${pass + fail} passing`);
process.exit(fail ? 1 : 0);
