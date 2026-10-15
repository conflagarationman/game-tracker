# game-tracker

A static personal game-backlog tracker. `index.html` reads `games.json` and renders it;
`add.html` writes to it through a Cloudflare Worker. No build step, no dependencies, no
framework — plain HTML/CSS/JS served by GitHub Pages, and Node scripts run by GitHub Actions.

This file is reference material about how the data and the moving parts fit together. It
exists because several of the rules below are not recoverable by reading the JSON — they were
re-derived from scratch more than once, and one of them (the difference between "finished" and
"flair earned") lives in two independent fields, `s` and `gotmFlair`.

**This is a public repo.** Nothing secret belongs in this file, in the tracked JSON, or in any
comment. Credentials live in GitHub Actions secrets and Cloudflare Worker secrets; see
`worker/README.md` for how the write path is set up and what its threat model actually is.

## Layout

| File | Written by | Notes |
|---|---|---|
| `games.json` | you, via `add.html` → Worker, or a session's PR (auto-merged); **and** the sync bot | The whole library. Human-owned fields and bot-owned fields share each record — see below. |
| `covers.json` | bot only (`backfill-covers.yml`, daily + on `games.json` push) | Cover art URLs, **keyed by lowercase title**. |
| `gotm.json` | bot only (`fetch-gotm.mjs`, daily) | Mirror of the r/SBCGaming club's pick list. Overwritten wholesale — never put human state here. |
| `last-synced.json` | bot only (`sync-games.yml`, daily) | Drives the freshness stamp on the page. |
| `play-check.json` | bot only (`sync-games.yml`, daily) | Recent real play vs. status — see "Play check" below. Keyed by `id`. |
| `asf-idle.json` | bot only (`sync-games.yml`, daily) | ASF card farming per year, and per tracked game how much idling was taken out of its hours. Kept as-is when the hub doesn't answer. |
| `worker-config.js` | you | Points the pages at the deployed Worker. |
| `index.html` / `add.html` | you | Read and write surfaces. Self-contained. |
| `pick.js` | you | The "What should I play?" scorer. Plain script, DOM-free, loaded by `index.html` and unit-tested in Node. |
| `owl.html` | you | **Kaepora Gaebora**: the picker as a conversation with the OoT owl. Asks device, time and mood, then offers `pick.js`'s ranking one game at a time. "Do you want to hear it again?" Yes = next pick, No = Start (or, for a wildcard, add it as Now Playing via `/games/add`), `?pick=<key>` opens straight on that game ("You came about the weekend, hoo?") with the usual three answers, looked up in the whole pool so a Friday link survives the data moving on. Not this one = snooze it for the owl (see `owl-skips.json`; the fourth turn-down shows a red DROP warning whose safe answer comes first, and drops are listed under "Struck from the list" in the footer with a Restore). Uses `GTPick.owlLineup()`: tracked + Someday games, with a wildcard every third pick and in the lead when nothing tracked fits the mood. Music is The 8-Bit Big Band's cover of Kaepora's theme through YouTube's player, in a credited "music box" at the bottom of the page: YouTube's terms need the player visible (200px+), and the recording isn't ours to host. On by default from the first tap or key press; nothing loads from YouTube before it. **Text sounds** are made in the page with Web Audio (no files): a quiet square blip every couple of typed letters (≥40ms apart) and an original falling-minor-third "hoo-hoo" at the start of each line (≥1.5s apart). They start on the first tap too, and have their own 🔈 toggle (`gt_owl_sfx`), separate from the ♪. |
| `library.json` | bot only (`sync-games.yml`, daily) | Every owned Steam game (hours minus the ASF ledger's recorded idling) and every RetroAchievements game with progress, one per line. For the owl's wildcards. **Published in full on purpose** (Jonny's call). Only rewritten when Steam answers. |
| `library-meta.json` | bot only (`scripts/library-meta.mjs`, scheduled runs only) | Steam genres (`g`), Metacritic (`m`) and Deck rating (`d`: 3 verified, 2 playable, 1 unsupported, 0 unknown) per appid. Filled ~120 games a day, most-played first; known appids are never re-fetched. |
| `retro-canon.json` | you | Hand-curated retro must-plays (`t`, `c` console, `y`, `g`, `h`, `why`) for the owl's "never logged" wildcard. Anything tracked or with RA progress is skipped automatically, so it never needs pruning. |
| `owl-pick.json` | bot only (`sync-games.yml`, daily, via `scripts/owl-pick.mjs`) | The owl's pick for tonight (any device, an evening, no mood), for the Home Hub's peeking owl. Runs the real `pick.js` so the hub (Python, token in its URL) neither re-implements the ranking nor loads remote script. `pick` is null when there's nothing to suggest. **`weekend`** is the Friday hoot's pick (`{ key, t, p, reasons, week }`, or null): any device, a long session, no mood, wildcards included, anything in `owl-skips.json` left out, drawn with a seed from the ISO week. Friday to Sunday the previous run's pick is kept while it still stands, so the hub's nudge and the page agree all weekend. `key` is what `owl.html?pick=<key>` opens (URL-encode it: `id:12`, `steam:730`, `ra:…`, `canon:…`). |
| `owl-skips.json` | **Worker only** (`/owl/skip`, `/owl/restore`) | What the owl has set aside, from "Not this one": `{ key: { t, count, until, dropped, last } }`, keyed `id:<n>` (tracked), `steam:<appid>`, `ra:<normTitle>` (RA runs and club picks) or `canon:<normTitle>`. Turn-downs snooze 7, 30, then 90 days; the fourth asks before a drop, and a drop is only `dropped: true`. Restore deletes the entry (count back to zero), and so does accepting the game with "No". **Never touches `games.json`**, and nothing writes it but the Worker, so keep human edits out. |
| `wrapped.html` + `wrapped-stats.js` | you | Year in review (`?year=2026`) with a canvas-drawn share image. Read-only. The numbers are `wrapped-stats.js` (DOM-free, unit-tested); see "Year in review" below. |
| `scripts/*.mjs` | you | Run by Actions, not by the pages. |
| `worker/` | you | The only thing that can commit to `games.json` (and `owl-skips.json`) from a browser. `worker/index.mjs` keeps its own copy of the 7/30/90 snooze table; its test compares it with `pick.js`'s. |

Bot-written files are overwritten wholesale on each run. Anything a human needs to edit and
keep belongs in `games.json`, never in `covers.json` or `last-synced.json`.

## Updating the tracker from a session

"I finished X, mark it 10/10 and archive it" needs no code and no click. **Edit `games.json`
only, and open a PR against `main`.** `auto-merge-data.yml` validates it and merges it within
a minute or two, then dispatches the backfill and sync so new games get art, an HLTB estimate
and achievements.

It merges only when the PR changes `games.json` and nothing else, comes from a branch in this
repo, is not a draft, has no `hold` label, merges cleanly into `main`, and passes
`scripts/validate-games.mjs`: every record has every key with a legal value (the rules below),
ids are unique, no more than 6 records change position (so a re-sorted or regenerated file
is refused), and no more than 3 are removed. Anything else waits for a person, and the run
summary says why. Draft or `hold` is the way to stop it.

So when editing: change records in place, add new ones at the end of the array (or where they
belong in Up Next), and never rewrite the file from a sorted or filtered copy. "Archive" means
`s: "done"` with `cy`/`cm` set (`cm` zero-indexed), and a rating in `r`.

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
  "h": "20h",             // HowLongToBeat estimate, free text ("20h", "10-15h", "40+").
                          // Filled by the bot only while blank (backfill-hltb.mjs); a typed
                          // value is never overwritten. Same for a blank "y".
  "r": 0,                 // rating 0-10. 0 means UNRATED, not "rated zero" — see below
  "cy": null,             // completion year
  "cm": null,             // completion month, ZERO-INDEXED (0 = January)
  "gotm": null,           // r/SBCGaming Game of the Month tag, "Mon YYYY" — see below
  "gotmFlair": false,     // club flair actually earned. NOT implied by s:"done" — see below
  "mastery": null,        // in-progress | mastered | platinum | 100pct
  "diff": null,           // 1-5 (Easy..Brutal)
  "achPct": null,         // bot-owned
  "achCount": null,       // bot-owned, [earned, total]
  "actualHours": null,    // bot-owned. Steam playtime MINUS the ASF card idling the hub's
                          // farm ledger has recorded for that appid (see Automation)
  "lastPlayed": null,     // bot-owned, YYYY-MM-DD
  "casual": false,        // true = deliberately excluded from achievement display
  "note": null,
  "start": null,          // YYYY-MM-DD
  "queued": null,         // YYYY-MM-DD
  "release": null         // YYYY-MM-DD, only for a game that isn't out yet. index.html shows
                          // "out in N days" until then and nothing after, so it never needs
                          // clearing. Use this, not the note, for release dates.
}
```

### Things that are easy to get wrong

- **`cm` is zero-indexed** so it can index the month-name array in `index.html` directly.
  `cm: 6` is July. The Worker rejects anything outside 0–11.
- **`r: 0` means unrated.** The stats row averages only `r > 0` and shows the count it used, so
  treating 0 as a real score would silently drag the average down.
- **`casual: true` suppresses achievement display**, it does not mean the game has no
  achievements.
- **Genre `"Idle"`** (any `g` containing the word) marks a desk pet or clicker left running.
  The game still counts as finished, but its hours are left out of every hours figure
  (year in review, the "Up next ETA" pace). It's a genre on purpose: editable in `add.html`,
  and a data-only PR still auto-merges.
- **A finished game with `cy: null` is invisible in the Year Log**, which filters on a truthy
  `cy`, and lands in the Archive's "Unknown" group. `add.html`
  lists them in a "Needs attention" group at the top of its dropdown, alongside `done` games
  with `r: 0` and `playing`/`queue`/`soon` games with no `h`, with counts under the dropdown.
- **`achPct` / `achCount` / `actualHours` / `lastPlayed` are bot-owned.** Editing them by hand
  is pointless — the next sync overwrites them. The exception worth knowing: `lastPlayed` on a
  non-Steam, non-RA platform (`pc`, `switch`, `ps5`, `wiiu` with no RA entry) has no source at
  all and will stay wherever it was, so any "stale/dormant" logic reading it is only meaningful
  for Steam and RetroAchievements titles.
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

### In-page writes from `index.html`

Everything below goes through the Worker's existing `/games/edit` and `/games/delete`; none of
it needed a Worker change. Per-viewer choices (picker chips, dismissed play-check rows, Someday
games you chose to keep) live in `localStorage` only.

- **What should I play?** ranks Now Playing and Up Next (plus Ongoing for a 30-minute session,
  and Someday games whose club pick has 3 months or less left) by time left to the credits
  (`h` minus `actualHours`), recent real play, Up Next position and GOTM deadline, filtered by
  device. The device-to-platform map is `DEVICES` in `pick.js`. "Start" sets `s:"playing"`.
  **The owl (`owlLineup`) differs from this picker on purpose:** it lets Someday in
  (`someday: true`) and adds wildcards from outside the tracker (`wildcards()`): Steam
  favourites (15h+ after idling, not played in 45 days), never-started Steam games with
  Metacritic 80+, RA games 5-90% done, unclaimed club picks, and `retro-canon.json`. Steam
  wildcards go to PC/Deck (Deck skips "unsupported"), retro ones to the Thor. Each result
  carries `fits` (does it match the mood?), and the owl says so when his best doesn't.
  `pickGames` also takes an optional `mood` (`MOODS`: chill / deep / finish), used only by
  `owl.html`; with no mood the ranking is unchanged. Moods match the free-text genre by keyword,
  so a new genre may need adding to `CHILL_G` / `HARD_G` / `DEEP_G`. Every mode names a game
  1-5 achievements from 100% (`achLeft`, never for `casual` games).
- **Play check rows act**: Playing, Finished (date + rating sheet), or ✕, which hides a row
  until that game's `lastPlayed` changes. "Add as playing" deep-links to
  `add.html?t=…&s=playing&p=…`.
- **Someday triage** (Someday panel): one game at a time, oldest first: Up Next, Keep (hidden
  from triage for 90 days), Already played, Remove. Remove waits 6 seconds with an Undo before
  the delete is sent. **Fill in finished games** (Archive panel) walks the done/dropped records
  missing a year or rating.
- The "Up next ETA" stat is Up Next + Now Playing hours left divided by the hours finished per
  month over the last 12 months; the whole-backlog figure is in its tooltip.

### Year in review

`wrapped-stats.js` borrows the ideas behind Steam Replay, PlayStation Wrap-Up and Nintendo
Year in Review but computes them from this file's own fields; nothing is fetched from the
platforms. Hours are `actualHours` (lifetime Steam playtime for that game) else the HLTB
estimate, and the page marks which. New / recent / classic splits at 8 years back, like
Steam's. "Played at launch" means `y === cy`. The streak is consecutive months with a
finish (there's no daily play data). Devices: handheld = steamdeck/ayn/retro, Switch =
switch/switch2, everything else PC & TV (Steam can't be told apart from Deck play). The
persona is whichever trait clears its threshold by the most, with the number behind it, and
"vs last year" compares with the closest earlier year that has finishes.

### Array order is meaningful

**The order of records in `games.json` is the Up Next priority.** `index.html` numbers the
queue 1..N straight from array position, the Home Hub reads `games.json` directly and takes
the first four `queue` rows in that same array order, and the reorder panel in `add.html`
exists to change it (via the Worker's `/games/reorder`, which moves only `queue` rows and
leaves every other record's position untouched).

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
  into `games.json` and writes `last-synced.json`.
  **RetroAchievements needs two endpoints, not one.** `API_GetUserCompletedGames` carries
  achievement counts but no play date; without the second endpoint an actively-played RA game
  reads as "dormant" here and "stale" on the Home Hub while its achievement counts keep
  updating. `API_GetUserRecentlyPlayedGames` supplies `LastPlayed`;
  `syncRA()` merges the two, and only ever moves `lastPlayed` **forward** — that endpoint is a
  rolling window, so an old row from it must never drag a newer date backwards. The two are
  handled independently, so a freshly-started game with no awards row still gets a date.
  Steam games are matched by normalised title against the owned-games list rather than a
  hand-maintained map, so a new game only needs the right title and platform to start syncing.
  **RA games are matched the same way** (`resolveRaTitles()`), for `ayn`/`retro` only:
  diacritics folded, "Zelda: X" tried as "The Legend of Zelda: X", RA's `~Hack~ `-style
  prefixes stripped as a fallback that never beats an exact title. `RA_TITLE_MAP` holds only
  renames no rule can derive (999); don't grow it into an allow-list, because any retro game
  missing from an allow-list silently never syncs. A `playing`/`ongoing`
  retro game that still doesn't match is named in the sync log.
  Playtime is skipped for any app currently being idled for trading cards, since idling inflates
  Steam's own counters; achievements are unaffected and still sync. **Past idling is
  subtracted too:** the hub's `/asf/farm-ledger` (built from ASF's own log, per appid per
  day) is taken out of `playtime_forever` for `actualHours`, out of `playtime_2weeks` for the
  play check, and a last-played day ASF spent idling with no real play left in the window
  doesn't move `lastPlayed`. Idling from before the ledger existed can't be known, so older
  farmed games may still carry some. If the hub is down the sync logs it and uses raw playtime
  for that run.
- **Play check**, same run. `buildPlayCheck()` compares status against real recent play and
  writes `play-check.json` plus a section on the workflow's run summary: each tracked game's
  Steam minutes over the last 14 days (`playtime_2weeks`), tracked games played in that window
  that aren't `playing`/`ongoing`, and Steam (60+ min) or RA games played that aren't in the
  tracker at all. `index.html` shows the recent hours on Now Playing cards and a note under
  them only when there's a mismatch. It does **not** re-flag idle Now Playing games; the page's
  "dormant" pill already does that. ASF-idled appids are excluded, as are background apps in
  `PLAY_CHECK_IGNORE` (e.g. Bongo Cat), and titles match across
  every platform, so a game tracked as `switch` but played on Steam isn't called untracked.
- `backfill-covers.yml` — daily, **and on every push to main that touches `games.json`**, so a
  game added by a direct commit (no Worker dispatch) gets art and an estimate within minutes.
  Bot pushes
  use `GITHUB_TOKEN`, which never re-triggers a workflow, so it can't loop on itself.
  **Steam/Steam Deck games ask the Steam store first** (exact name -> appid -> the store's
  header image, `STEAM_NAME_ALIASES` shared with the sync): a store page exists months before
  release, while SteamGridDB often has nothing until launch. Everything else, and any Steam
  miss, goes to SteamGridDB. It declines
  uncertain matches rather than guessing, so some titles stay uncovered on purpose; the pages
  fall back to a coloured platform glyph. Matching folds diacritics (the catalogue writes
  "Pokémon", this library writes "Pokemon") and tries a few derived search terms — the
  catalogue's "The Legend of Zelda: X" for a "Zelda: X" tag, and known fan-port suffixes
  like `(2S2H)` dropped. A parenthetical that marks a *different edition* — `(2019)`,
  `(PICO-8)` — is deliberately kept, since those have their own art. Titles it still can't
  place are listed on the workflow's run summary alongside what the catalogue offered, so
  the fix is an `SGDB_TITLE_ALIASES` entry.
  The same workflow runs **`backfill-hltb.mjs`**, which fills a blank `h` (main story, else
  main + extras, never completionist) and a blank `y` from HowLongToBeat for
  `playing`/`queue`/`soon`/`done` games. Exact normalized title only; same-named games are
  told apart by the record's `y` or declined. HLTB has no public API and renames its search
  endpoint every few months (`/api/find` -> `/api/bleed` -> `/api/search/site`); on a 404 the
  script reads the new name out of the site's own JS. The init response's field names move
  too (a 200 can arrive without `hpKey`/`hpVal`), so `parseInit()` takes `token`
  plus any field named like `*key*`/`*val*`, and on failure logs the field names it got. If no lookup succeeds at all, the run
  goes red (covers still commit) rather than quietly filling nothing. An unreleased game
  matches with no times yet and is simply retried the next day.
- `fetch-gotm.mjs` — daily, alongside the Steam sync. Refreshes `gotm.json` from the club's
  newest post, read from **Arctic Shift** (a free Reddit archive, no key) rather than Reddit.
  Reddit is a dead end here: unauthenticated requests are refused from cloud IP ranges, which
  is where Actions runners live, and since late 2025 every new OAuth app needs manual
  pre-approval that personal scripts rarely get. **It looks up the host's recent posts
  first** (`GOTM_HOSTS`, an indexed `author=` filter) and matches titles locally; the
  full-text title searches ("Game of the Month", "GotM") are only a fallback for a new
  host. From an Actions runner the host lookup answers in ~1s, while the title searches take
  5-8s and intermittently hit Arctic Shift's "Timeout. Maybe slow down a bit" 422, with or
  without a date range. A pick
  older than the newest known month is refused, so an incomplete fallback search can't
  move "current" backwards.
  **Picks are merged, never rebuilt:** the host-presented months carry no "Previous Games
  of the Month" list, so gotm.json's known picks are kept and the post only adds or
  updates months. A failed or unparseable
  fetch keeps the last known picks, records the error, and then fails the step on purpose — a
  red run is the notification that the club list has gone stale.
- Adding a game through `add.html` triggers the sync and cover workflows immediately,
  best-effort — a failed trigger never fails the add, it just means waiting for the schedule.

## Tests

No test runner, no dependencies — each suite is a plain Node script that prints `N/N passing`
and exits non-zero on failure.

```
node scripts/sync-apis.test.mjs        # 44
node scripts/backfill-covers.test.mjs  # 18
node scripts/backfill-hltb.test.mjs    # 14
node scripts/validate-games.test.mjs   # 9
node scripts/fetch-gotm.test.mjs       # 26
node scripts/pick.test.mjs             # 29
node scripts/wrapped.test.mjs          # 14
node scripts/owl-pick.test.mjs         # 12
node scripts/library-meta.test.mjs     # 4
cd worker && node index.test.mjs       # 35
```

`tests.yml` runs all ten on every pull request and on pushes to `main`. They need no
install step, no secrets and no network, so that job is just checkout, Node 20, and the
ten commands above.

A second job runs **`scripts/smoke.browser.mjs`**: `index.html`, `add.html`, `owl.html` and
`wrapped.html` in headless Chromium at 390px and 1280px against the committed JSON. It fails
on sideways scroll, page errors, or a broken picker/triage/play-check/share-image flow. The
Worker is stubbed inside the test (writes are recorded, never sent), and every other off-site
request is aborted except web fonts, which are let through because the phone header only
overflowed once Syne loaded. Locally: `npm i --no-save playwright@1.56.1 && npx playwright
install chromium`, then `node scripts/smoke.browser.mjs`.

`fetch-gotm.test.mjs` runs against a captured club post. Its strongest assertion is that the
12-month rule, applied from scratch, reproduces every RETIRED / LAST CHANCE marker the host
wrote by hand — so the derived eligibility is checked against the club's own bookkeeping
rather than against itself.

The Worker tests run against a stubbed GitHub contents API, including its sha-conflict retry,
so they need no token and no network.

Beyond the smoke test, page changes are verified by driving them in a headless browser.
That has caught real bugs that reading the code did not — a date defaulting on form load rather
than on status change, and focus being lost when a button disabled itself mid-list.
