# game-tracker

A static personal game-backlog tracker. `index.html` reads `games.json` and renders it;
`add.html` writes to it through a Cloudflare Worker. No build step, no dependencies, no
framework: plain HTML/CSS/JS on GitHub Pages, Node scripts run by GitHub Actions. The owner is Jonny.

This file holds only what you can't get from reading the code and what would cause damage if
missed. Feature lore (how the owl talks, picker rules, story mode, localStorage keys) lives in the
header comment of the file that implements it: `pick.js`, `owl.html`, `index.html`, `wrapped.html`,
`wrapped-stats.js`, `hearts.js`, `rupees.js`, `sw.js`, `theme.css`, `usage.js`, `scripts/*.mjs`.

**This is a public repo.** Nothing secret belongs in this file, the tracked JSON, or any comment.
Credentials live in GitHub Actions secrets and Cloudflare Worker secrets; see `worker/README.md`
for the write path and its threat model.

## Who writes what

Bot-written files are overwritten wholesale on each run. Anything a human needs to keep belongs in
`games.json`, never in a bot file.

| File | Written by |
|---|---|
| `games.json` | You (via `add.html` → Worker, or a session PR) **and** the sync bot: human and bot-owned fields share each record |
| `covers.json` | bot (`backfill-covers.yml`), keyed by **lowercase title** |
| `gotm.json` | bot (`fetch-gotm.mjs`): mirror of the club's pick list, never put human state here |
| `last-synced.json` | bot: freshness stamp, plus `warnings` (empty when clean) that the hub's health check reads |
| `play-check.json` | bot: recent real play vs. status, keyed by `id` |
| `asf-idle.json` | bot: ASF card farming per year and per game; kept as-is when the hub doesn't answer |
| `ledger.json` | bot (daily); backfilled once from git on 2026-10-17: every game's `actualHours`, one line per UTC day |
| `achievements-log.json` | bot: one row per unlock, merged never rebuilt |
| `wrapped-<year>.json` | bot (`freeze-wrapped.mjs`): a finished year's inputs, written once on Jan 1, never overwritten |
| `library.json` | bot: every owned Steam game and RA game with progress. **Published in full on purpose (Jonny's call).** Only rewritten when Steam answers |
| `library-meta.json`, `library-hltb.json` | bot: genres/Metacritic/Deck rating and HLTB lengths for the owl's wildcards; a title already answered is never asked again (delete its entry to retry) |
| `owl-pick.json` | bot (`owl-pick.mjs`): runs the real `pick.js` for the Home Hub's owl, so the hub never re-implements the ranking |
| `owl-skips.json` | **Worker only** (`/owl/skip`, `/owl/restore`). Never touches `games.json`; keep human edits out |
| `rupees.json` | **Worker only, dormant**: see "Dormant leftovers" |
| `retro-canon.json`, `worker-config.js` | you (hand-curated retro must-plays; the Worker URL) |
| `worker/` | you, **deployed by hand with wrangler**. The pages must never call something the deployed Worker lacks, so a page change that needs a Worker change waits for the deploy |

`scripts/*.mjs` are run by Actions, not by the pages. `pick.js`, `hearts.js`, `rupees.js`,
`wrapped-stats.js` and `usage.js` are DOM-free plain scripts that Node tests load directly.

**Dormant leftovers.** The rupee shop was removed. The Worker's `/rupees/buy|refund|use`
endpoints and `rupees.json` still exist but no page uses them. `rupees.js` keeps its four price
constants only because `worker/index.test.mjs` compares the Worker's copy with them. The wallet
pill is just lifetime rupees earned from `achievements-log.json` by rarity.

## Updating the tracker from a session

"I finished X, mark it 10/10 and archive it" needs no code and no click. **Edit `games.json`
only, and open a PR against `main`.** `auto-merge-data.yml` validates and merges it within a
minute or two, then dispatches the backfill and sync so new games get art, an HLTB estimate and
achievements. It merges only when the PR changes `games.json` and nothing else, comes from a
branch in this repo, is not a draft, has no `hold` label, merges cleanly, and passes
`scripts/validate-games.mjs`: every record has every key with a legal value, ids are unique, at
most 6 records change position and at most 3 are removed. Anything else waits for a person; the
run summary says why. Draft or `hold` is how you stop it.

**Code PRs merge themselves too** (`auto-merge-code.yml`): once the whole Tests workflow (every
suite and the browser smoke test) is green on the PR's head and it merges cleanly. It holds back,
for a person: anything touching `worker/` or `.github/`; any non-test script under `scripts/`
(everything except `*.test.mjs` and `smoke.browser.mjs`) and `pick.js`, because the scheduled
workflows run those with the API keys and a token that can push to main; and `games.json` mixed
with code. So open a PR **ready, not draft, only when the work is finished and verified**.

When editing `games.json`: change records in place, add new ones at the end of the array (or where
they belong in Up Next), and **never rewrite the file from a sorted or filtered copy**. "Archive"
means `s: "done"` with `cy`/`cm` set (`cm` zero-indexed) and a rating in `r`.

## `games.json` record shape

One flat array. Every record carries every key, `null` for unset.

```jsonc
{
  "id": 410,              // unique, assigned by the Worker as max(id)+1
  "t": "Halo: Campaign Evolved",
  "p": "steam",           // steam | steamdeck | pc | ps5 | switch | switch2 | ayn | retro | wiiu
                          // "pc" = a PC game NOT in the Steam library (Battle.net, GOG, itch). The
                          // sync skips it, so achPct / actualHours stay null by design.
  "s": "playing",         // playing | ongoing | queue | soon | done | dropped
                          // "ongoing" = live-service/evergreen (WoW, Marvel Snap): no completion
                          // date, no HLTB estimate, by design.
  "g": "FPS",             // genre, free text
  "y": 2026,              // release year
  "h": "20h",             // HLTB estimate, free text ("20h", "10-15h", "40+"). The bot fills it
                          // only while blank; a typed value is never overwritten. Same for "y".
  "r": 0,                 // rating 0-10. 0 means UNRATED, not "rated zero"
  "cy": null,             // completion year
  "cm": null,             // completion month, ZERO-INDEXED (0 = January)
  "gotm": null,           // r/SBCGaming Game of the Month tag, "Mon YYYY"
  "gotmFlair": false,     // club flair actually earned. NOT implied by s:"done"
  "mastery": null,        // in-progress | mastered | platinum | 100pct
  "diff": null,           // 1-5 (Easy..Brutal)
  "achPct": null,         // bot-owned
  "achCount": null,       // bot-owned, [earned, total]
  "actualHours": null,    // bot-owned: Steam playtime MINUS the ASF card idling the hub recorded
  "lastPlayed": null,     // bot-owned, YYYY-MM-DD
  "casual": false,        // true = deliberately excluded from achievement display
  "replay": false,        // OPTIONAL (absent = false): "replay" | "100pct" | "1.0" (true = "replay")
  "priorH": null,         // OPTIONAL: hours from before this run (Palworld 75, Brotato 74)
  "note": null,
  "start": null,          // YYYY-MM-DD
  "queued": null,         // YYYY-MM-DD
  "release": null         // YYYY-MM-DD, only for a game not out yet; use this, not the note
}
```

### Easy to get wrong

- **`cm` is zero-indexed** (`cm: 6` is July); the Worker rejects anything outside 0-11.
- **`r: 0` means unrated.** Averages use only `r > 0`; treating 0 as a score drags them down.
- **`casual: true` suppresses achievement display**; it doesn't mean the game has no achievements.
- **Genre containing `Idle`** marks a desk pet or clicker left running: still counts as finished,
  but its hours are left out of every hours figure. It's a genre so a data-only PR still merges.
- **A finished game with `cy: null`** is invisible in the Year Log and lands in the Archive's
  "Unknown" group. `add.html` lists these under "Needs attention".
- **`achPct` / `achCount` / `actualHours` / `lastPlayed` are bot-owned**; hand edits are overwritten
  by the next sync. Exception: `lastPlayed` on a non-Steam, non-RA platform has no source and
  stays where it was, so "dormant" is only meaningful for Steam and RetroAchievements titles.
- **An `ongoing` game with null `h`, `cy` and `cm` is not missing data.**
- **Finished is not flair.** `s` and `gotmFlair` are independent (see the club rules below).

### Array order is the Up Next priority

`index.html` numbers the queue 1..N straight from array position, the Home Hub takes the first
four `queue` rows in that order, and `add.html`'s reorder panel changes it (Worker
`/games/reorder` moves only `queue` rows). Sorting or regenerating the array destroys it. Nothing
else depends on position; every script looks records up by `id`.

### `ongoing` is a status, not a flag

It is a sixth value of `s`, not a `casual`-style boolean on `"playing"`. Every consumer filters
by strict equality (`g.s === 'playing'`, `'queue'`, `'done' || 'dropped'`), so a new enum value
excludes itself from all of them for free, while a boolean would need remembering everywhere with
silent over-counting as the failure mode. Don't relitigate this with a `continuous: true` flag.

## The r/SBCGaming Game of the Month club

- **Picks stay claimable for 12 months, then retire.** The useful question is "how long is left",
  not "is it late"; an expired pick is not outstanding.
- **Each month sets its own criteria, on its own post**, and they differ a lot. They aren't
  derivable from the game or this repo, so link to the month's post, never assert what counts.
- **Finishing is not meeting the criteria.** `s: "done"` says you played it; `gotmFlair: true` says
  the requirement was met and proof posted. Only `gotmFlair` clears a pick from the GOTM strip; a
  finished pick without flair shows "played · verify flair".
- **The `gotm` tag is the reliable join, not the title.** Club and tracker titles drift, and fuzzy
  matching pairs the club's "Super Mario World" with "Super Mario World 2: Yoshi's Island".
- `fetch-gotm.mjs` reads the club's host posts from **Arctic Shift** (a free Reddit archive; Reddit
  itself refuses cloud IPs). Picks are merged, never rebuilt; a pick older than the newest known
  month is refused; a failed fetch keeps the last picks, records the error, and goes red on purpose.

## Sync invariants (`sync-games.yml`, daily; `backfill-covers.yml`, daily and on every `games.json` push)

- **RetroAchievements needs two endpoints.** `API_GetUserCompletedGames` has counts but no play
  date; `API_GetUserRecentlyPlayedGames` supplies `LastPlayed`. `lastPlayed` only ever moves
  **forward** (the second endpoint is a rolling window). Steam and RA games are matched by
  normalised title (`resolveRaTitles()` for `ayn`/`retro`), so a new game needs only the right
  title and platform. `RA_TITLE_MAP` holds only renames no rule can derive: don't grow it into an
  allow-list, or any retro game missing from it silently never syncs.
- **ASF idling is subtracted.** The hub's `/asf/farm-ledger` is taken out of `playtime_forever`
  (for `actualHours`) and `playtime_2weeks` (play check); a last-played day ASF spent idling with
  no real play doesn't move `lastPlayed`; an app being idled right now has its playtime skipped.
  Idling from before the ledger can't be known. If the hub is down the run uses raw playtime.
- **Read `ledger.json` as rises above the game's previous high**, never plain differences:
  snapshots dip (a game frozen while ASF farmed it). A game's first number is a baseline, not play
  (null-then-populated is a sync change). Days up to `rawUntil` were raw Steam playtime, backfilled
  with the farm ledger's idling removed. Don't squash git history casually.
- **Bucket hours and days in America/New_York, never UTC.** RA's zoneless dates are read as UTC.
- **Play check** (`buildPlayCheck`) compares status with real recent play; it does not re-flag idle
  Now Playing games (the page's "dormant" pill does that). ASF-idled appids and
  `PLAY_CHECK_IGNORE` apps are excluded.
- **Cover art**: Steam/Steam Deck games ask the Steam store first, then SteamGridDB; uncertain
  matches are declined on purpose (the pages fall back to a platform glyph); misses are listed on
  the run summary, and the fix is an `SGDB_TITLE_ALIASES` entry. `backfill-hltb.mjs` fills a blank
  `h` and `y` by exact normalized title only. HLTB renames its search endpoint every few months;
  the script reads the new name from the site's JS, and goes red if no lookup succeeds.
- Bot pushes use `GITHUB_TOKEN`, which never re-triggers a workflow, so nothing loops.
- **Never put cover art on a canvas** (`wrapped.html` poster and share image): cross-origin
  images taint it and `toBlob` fails.

## Korok.js contract

`korok.js` is **byte-identical** to the hub's `KOROK_SRC` twin in home-hub's `status_server.py`
(its health check emails when they drift), and **Steph's TV log loads it live** from this site, so
a merged change reaches her page: don't edit it casually, and keep the `data-repo` / `data-total` /
`data-spots="id:left[:top],..."` tag contract working. Finds live under one localStorage key,
`korok:all`, as `repo/id`, shared with her page. There are **12 spots: 10 here (index 3, owl 3,
wrapped 2, add 2) + 2 on her log**; every tag says `data-total="12"`, so add a spot and bump it
everywhere. `retired.js` runs before it on every page and deletes the retired `korok:all:skin`
and `gt_mask` keys (korok.js can still paint a skin named there).

## Tests

No runner, no dependencies: each suite is a plain Node script that prints `N/N passing` and exits
non-zero on failure.

```
for f in scripts/*.test.mjs; do node "$f" || echo "FAILED $f"; done
cd worker && node index.test.mjs
```

`tests.yml` discovers every `scripts/*.test.mjs` plus `worker/index.test.mjs` (no hand-kept list),
names each failing suite, and fails if it finds no suites; a new suite runs the day it is added.
The suites need no install, secrets or network. `fetch-gotm.test.mjs` runs against a captured club
post and checks that the 12-month rule reproduces every RETIRED / LAST CHANCE marker the host wrote
by hand. The Worker tests run against a stubbed GitHub contents API.

A second job runs **`scripts/smoke.browser.mjs`**: `index.html`, `add.html`, `owl.html` and
`wrapped.html` in headless Chromium at 390px and 1280px against the committed JSON. It fails on
sideways scroll, page errors, anything animating under reduced motion, or a broken
picker/triage/play-check/share-image flow, plus the service worker. The Worker is stubbed inside
the test (writes are recorded, never sent) and every other off-site request is aborted except web
fonts (the phone header only overflowed once Syne loaded). Locally:
`npm i --no-save playwright@1.56.1 && npx playwright install chromium`, then
`node scripts/smoke.browser.mjs` (`PLAYWRIGHT_MODULE` and `CHROMIUM_PATH` override the import and
the browser). Beyond the smoke test, verify page changes by driving them in a headless browser:
that has caught real bugs reading the code did not.
