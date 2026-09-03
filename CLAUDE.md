# game-tracker

A static personal game-backlog tracker. `index.html` reads `games.json` and renders it;
`add.html` writes to it through a Cloudflare Worker. No build step, no dependencies, no
framework — plain HTML/CSS/JS served by GitHub Pages, and Node scripts run by GitHub Actions.

This file is reference material about how the data and the moving parts fit together. It
exists because several of the rules below are not recoverable by reading the JSON — they were
re-derived from scratch more than once, and one of them (the difference between "finished" and
"flair earned") is not representable in the data at all yet.

**This is a public repo.** Nothing secret belongs in this file, in the tracked JSON, or in any
comment. Credentials live in GitHub Actions secrets and Cloudflare Worker secrets; see
`worker/README.md` for how the write path is set up and what its threat model actually is.

## Layout

| File | Written by | Notes |
|---|---|---|
| `games.json` | you, via `add.html` → Worker; **and** the sync bot | The whole library. Human-owned fields and bot-owned fields share each record — see below. |
| `covers.json` | bot only (`backfill-covers.yml`, Sundays) | Cover art URLs, **keyed by lowercase title**. |
| `gotm.json` | bot only (`fetch-gotm.mjs`, daily) | Mirror of the r/SBCGaming club's pick list. Overwritten wholesale — never put human state here. |
| `last-synced.json` | bot only (`sync-games.yml`, daily) | Drives the freshness stamp on the page. |
| `worker-config.js` | you | Points the pages at the deployed Worker. |
| `index.html` / `add.html` | you | Read and write surfaces. Self-contained. |
| `scripts/*.mjs` | you | Run by Actions, not by the pages. |
| `worker/` | you | The only thing that can commit to `games.json` from a browser. |

Bot-written files are overwritten wholesale on each run. Anything a human needs to edit and
keep belongs in `games.json`, never in `covers.json` or `last-synced.json`.

## `games.json` record shape

One flat array. Every record carries every key, with `null` for unset.

```jsonc
{
  "id": 410,              // unique, assigned by the Worker as max(id)+1
  "t": "Halo: Campaign Evolved",
  "p": "steam",           // steam | steamdeck | pc | ps5 | switch | switch2 | ayn | retro | wiiu
                          // "pc" = a PC game NOT in the Steam library (Battle.net, GOG,
                          // itch, a private server). The sync skips it, so achPct /
                          // actualHours stay null by design, not by failure.
  "s": "playing",         // playing | ongoing | queue | soon | done | dropped
                          // "ongoing" = a live-service/evergreen game (WoW, Marvel Snap) played
                          // indefinitely, never reaching "done" — no completion date, no HLTB
                          // estimate, by design. See "Ongoing vs a boolean flag" below.
  "g": "FPS",             // genre, free text
  "y": 2026,              // release year
  "h": "20h",             // HowLongToBeat estimate, free text ("20h", "10-15h", "40+")
  "r": 0,                 // rating 0-10. 0 means UNRATED, not "rated zero" — see below
  "cy": null,             // completion year
  "cm": null,             // completion month, ZERO-INDEXED (0 = January)
  "gotm": null,           // r/SBCGaming Game of the Month tag, "Mon YYYY" — see below
  "gotmFlair": false,     // club flair actually earned. NOT implied by s:"done" — see below
  "mastery": null,        // in-progress | mastered | platinum | 100pct
  "diff": null,           // 1-5 (Easy..Brutal)
  "achPct": null,         // bot-owned
  "achCount": null,       // bot-owned, [earned, total]
  "actualHours": null,    // bot-owned
  "lastPlayed": null,     // bot-owned, YYYY-MM-DD
  "casual": false,        // true = deliberately excluded from achievement display
  "note": null,
  "start": null,          // YYYY-MM-DD
  "queued": null          // YYYY-MM-DD
}
```

### Things that are easy to get wrong

- **`cm` is zero-indexed** so it can index the month-name array in `index.html` directly.
  `cm: 6` is July. The Worker rejects anything outside 0–11.
- **`r: 0` means unrated.** The stats row averages only `r > 0` and shows the count it used, so
  treating 0 as a real score would silently drag the average down.
- **`casual: true` suppresses achievement display**, it does not mean the game has no
  achievements.
- **A finished game with `cy: null` is invisible in the Year Log**, which filters on a truthy
  `cy`, and lands in the Archive's "Unknown" group. 13 records are in that state; `add.html`
  flags them as "— needs date" in its dropdown so they can be found and filled in.
- **`achPct` / `achCount` / `actualHours` / `lastPlayed` are bot-owned.** Editing them by hand
  is pointless — the next sync overwrites them.
- **An `ongoing` game having `h: null`, `cy: null`, and `cm: null` is not missing data.** A
  live-service game has no finish line to estimate and no completion date to record; those
  fields stay null by design, the same way `pc`'s null `achPct` is a design choice and not a
  sync failure.

### Ongoing vs a boolean flag

`ongoing` is a sixth value of `s`, not a `casual`-style boolean modifier on `"playing"`. A
modifier was considered and rejected: every consumer in this codebase filters statuses by
strict equality (`g.s === 'playing'`, `g.s === 'queue'`, `g.s === 'done' || g.s === 'dropped'`),
so a new enum value excludes itself from all of them for free, while a boolean would need
remembering — and excluding — in every one of those places, with silent over-counting as the
failure mode. Don't relitigate this by proposing a `continuous: true` flag; it was already
weighed and it's the wrong shape for how this codebase reads status.

### Array order is meaningful

**The order of records in `games.json` is the Up Next priority.** `index.html` numbers the
queue 1..N straight from array position, `pushToHub` sends the first four in the same order,
and the reorder panel in `add.html` exists to change it (via the Worker's `/games/reorder`,
which moves only `queue` rows and leaves every other record's position untouched).

Sorting or regenerating the array — for tidiness, or as a side effect of a rewrite — silently
destroys that ordering. Nothing else in the codebase depends on array position; every script
looks records up by `id`.

## The r/SBCGaming Game of the Month club

`gotm` tags a game as a monthly club pick, e.g. `"Oct 2025"`. The club's rules matter for
interpreting it:

- **Picks stay claimable for 12 months, then retire.** The useful question about a tagged game
  is therefore "how long is left", not "is it late". A pick whose year has elapsed is expired —
  the reward is unobtainable and there is no point flagging it as outstanding.
- **Each month sets its own completion criteria, on its own post.** They differ substantially
  month to month (beat a specific boss; post a multiplayer screenshot; finish arcade mode).
  They are not derivable from the game or from this repo — the month's own post is the only
  authority, so anything built here should link to it rather than assert what counts.
- **Finishing a game is not the same as meeting that month's criteria.** `s: "done"` says you
  played it; **`gotmFlair: true` says the club requirement was met and proof was posted.** They
  are independent, and only `gotmFlair` clears a pick from the tracker's GOTM strip. A finished
  pick without flair shows as "played · verify flair" rather than disappearing.
- Club titles and tracker titles drift ("The Legend of Zelda: A Link to the Past" vs
  "Zelda: A Link to the Past"; "999" vs "999: Nine Hours, Nine Persons"). **The `gotm` tag is
  the reliable join, not the title.** Fuzzy title matching against the club's list is unsafe:
  it pairs the club's "Super Mario World" with this library's "Super Mario World 2: Yoshi's
  Island", which is a different game.

## Automation

- `sync-games.yml` — daily. Pulls Steam playtime/achievements and RetroAchievements progress
  into `games.json`, writes `last-synced.json`, and pushes a summary to the home dashboard.
  Steam games are matched by normalised title against the owned-games list rather than a
  hand-maintained map, so a new game only needs the right title and platform to start syncing.
  Playtime is skipped for any app currently being idled for trading cards, since idling inflates
  Steam's own counters; achievements are unaffected and still sync.
- `backfill-covers.yml` — Sundays. Fills gaps in `covers.json` from SteamGridDB. It declines
  uncertain matches rather than guessing, so some titles stay uncovered on purpose; the pages
  fall back to a coloured platform glyph. Matching folds diacritics (the catalogue writes
  "Pokémon", this library writes "Pokemon") and tries a few derived search terms — the
  catalogue's "The Legend of Zelda: X" for a "Zelda: X" tag, and known fan-port suffixes
  like `(2S2H)` dropped. A parenthetical that marks a *different edition* — `(2019)`,
  `(PICO-8)` — is deliberately kept, since those have their own art. Titles it still can't
  place are listed on the workflow's run summary alongside what the catalogue offered, so
  the fix is an `SGDB_TITLE_ALIASES` entry.
- `fetch-gotm.mjs` — daily, alongside the Steam sync. Rebuilds `gotm.json` from the club's
  newest post. It needs `REDDIT_CLIENT_ID` / `REDDIT_CLIENT_SECRET`, because unauthenticated
  Reddit refuses cloud IP ranges, which is where Actions runners live. A failed or unparseable
  fetch keeps the last known picks, records the error, and then fails the step on purpose — a
  red run is the notification that the club list has gone stale.
- Adding a game through `add.html` triggers the sync and cover workflows immediately,
  best-effort — a failed trigger never fails the add, it just means waiting for the schedule.

## Tests

No test runner, no dependencies — each suite is a plain Node script that prints `N/N passing`
and exits non-zero on failure.

```
node scripts/sync-apis.test.mjs        # 12
node scripts/backfill-covers.test.mjs  # 11
node scripts/fetch-gotm.test.mjs       # 13
cd worker && node index.test.mjs       # 23
```

`fetch-gotm.test.mjs` runs against a captured club post. Its strongest assertion is that the
12-month rule, applied from scratch, reproduces every RETIRED / LAST CHANCE marker the host
wrote by hand — so the derived eligibility is checked against the club's own bookkeeping
rather than against itself.

The Worker tests run against a stubbed GitHub contents API, including its sha-conflict retry,
so they need no token and no network.

The browser pages have no unit tests; they are verified by driving them in a headless browser.
That has caught real bugs that reading the code did not — a date defaulting on form load rather
than on status change, and focus being lost when a button disabled itself mid-list.
