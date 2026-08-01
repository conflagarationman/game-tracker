// Exercises the GOTM parsing and eligibility maths against a captured August 2026 post, with
// no network. Same plain-script shape as the other suites here: prints N/N and exits non-zero.
import assert from "node:assert/strict";
import {
  parseTitle, parsePreviousList, buildPicks, monthsLeft, monthIndex, toTag, mergeResult,
  fetchLatestGotmPost, ELIGIBLE_MONTHS,
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
  const merged = mergeResult(null, null, "2026-08", new Error("missing REDDIT_CLIENT_ID/REDDIT_CLIENT_SECRET"));
  assert.deepEqual(merged.picks, []);
  assert.match(merged.error, /REDDIT_CLIENT_ID/);
});

await test("a successful fetch clears a previously recorded error", () => {
  const stale = { fetchedAt: "old", sourceUrl: "https://old", picks: [{ month: "2026-07" }], error: "reddit search -> 503" };
  const merged = mergeResult(stale, { sourceUrl: "https://new", current: { month: "2026-08" }, picks: [{ month: "2026-08" }] }, "2026-08", null);
  assert.equal(merged.error, null);
  assert.equal(merged.sourceUrl, "https://new");
  assert.equal(merged.picks.length, 1);
});

await test("fetchLatestGotmPost skips non-matching posts and reports missing credentials", async () => {
  const prev = { id: process.env.REDDIT_CLIENT_ID, secret: process.env.REDDIT_CLIENT_SECRET };
  delete process.env.REDDIT_CLIENT_ID;
  delete process.env.REDDIT_CLIENT_SECRET;
  await assert.rejects(() => fetchLatestGotmPost(async () => new Response("{}", { status: 200 })), /REDDIT_CLIENT_ID/);

  process.env.REDDIT_CLIENT_ID = "id";
  process.env.REDDIT_CLIENT_SECRET = "secret";
  const stub = async (url) => {
    if (String(url).includes("access_token")) return new Response(JSON.stringify({ access_token: "t" }), { status: 200 });
    return new Response(JSON.stringify({ data: { children: [
      { data: { title: "Weekly Discussion Thread", selftext: "", permalink: "/r/x/1" } },
      { data: { title: TITLE, selftext: BODY, permalink: "/r/SBCGaming/2" } },
    ] } }), { status: 200 });
  };
  const post = await fetchLatestGotmPost(stub);
  assert.equal(post.title, TITLE, "the first title that parses as a pick wins");
  assert.equal(post.url, "https://www.reddit.com/r/SBCGaming/2");

  if (prev.id) process.env.REDDIT_CLIENT_ID = prev.id; else delete process.env.REDDIT_CLIENT_ID;
  if (prev.secret) process.env.REDDIT_CLIENT_SECRET = prev.secret; else delete process.env.REDDIT_CLIENT_SECRET;
});

console.log(`\n${pass}/${pass + fail} passing`);
process.exit(fail ? 1 : 0);
