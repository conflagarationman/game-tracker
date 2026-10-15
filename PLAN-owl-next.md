# Kaepora Gaebora: what's next (plan, not built)

Written 2026-10-14 after PRs #33–#35 shipped the owl (owl.html), its wildcards and its music box.
Nothing here is implemented yet. Build in the order below; each phase is one PR.

## Phase 1: "Not this one" with escalating snoozes, plus the owl's memory (ideas #1 + #4)

Jonny's constraint: **nothing should disappear for good by accident.** So turning a game down
starts out temporary, and only the fourth time does the owl offer to drop it, with a clear
warning, and even a drop can be undone.

### How it behaves
- A third option in the box under Yes / No: **"Not this one"**. It snoozes that game from
  the owl's suggestions and moves on to the next pick, like Yes does.
- The snooze gets longer each time the same game is turned down:

  | Times turned down | What happens | Owl's line (draft) |
  |---|---|---|
  | 1 | Snoozed 7 days | "Hoo. Another time, then." |
  | 2 | Snoozed 30 days | "Hoo… not this one again? I'll leave it a while." |
  | 3 | Snoozed 90 days | "That's three times now. I'll keep quiet about it for a season." |
  | 4 | **DROP warning** in red, OoT style: "Hoo! You've turned *X* away four times. Shall I strike it from my list **for good**?" with **"Drop it"** (red) / **"Just snooze it"** (snoozes 90 days and asks again next time) | |

- **Drops can be undone.** A small "Struck from the list (N)" link in the page footer opens the
  dropped games, each with a **Restore**. Restoring clears that game's count back to zero.
- **The memory (idea #4) comes from the same data.** The owl can remark on it: "Hoo… you've
  turned down No Man's Sky three times." When you say **No** (accept), that game's count resets
  to zero, so a game you went and played doesn't stay "unwanted".
- For **tracked** games (Up Next and the like), snoozes and drops affect **only the owl**. They
  never change the game's status. On a drop, also offer: "Move it to Someday instead?"

### Where the data lives
Recommended: **shared, not per-browser.** That way phone and desktop agree, and Phase 2's
Friday hoot can respect the same skips.
- New file `owl-skips.json`, written only by the Worker, keyed by a stable key: `id:<n>` for
  tracked games, and `steam:<appid>` / `ra:<normTitle>` / `canon:<normTitle>` for wildcards. Each
  entry is `{ "t": title, "count": n, "until": "YYYY-MM-DD"|null, "dropped": bool, "last": "YYYY-MM-DD" }`.
- Worker: add `POST /owl/skip` (count +1, set `until` from the table, or `dropped: true` when the
  body says `drop: true`) and `POST /owl/restore` (delete the entry), both using the existing
  `mutateWithRetry` against `owl-skips.json` instead of `games.json`. Same `X-Sync-Key` model.
  Add Worker tests next to the existing 27.
- `pick.js`: `owlLineup()` takes `src.skips`. It filters out snoozed (`until` in the future) and
  dropped entries, and attaches `skipCount` to each pick so the owl can comment on it. This is
  pure logic, so it gets unit tests: escalation table, expiry, restore, and keys for each kind.
- `validate-games.mjs` / auto-merge are unaffected (the file isn't `games.json`).
- Fallback if the Worker change feels too big: the same logic in `localStorage` first (one
  device only), then move to the Worker later. The keys and table stay the same either way.

### Tests and checks
pick tests for filtering and escalation, Worker tests for the endpoints, a smoke case that
walks "Not this one" four times and sees the DROP warning, and that Restore brings the game back.

## Phase 2: OoT text sounds (idea #3)
- **Text blips:** a short, quiet square-wave blip every ~2 characters as the owl types (throttled
  to ≥40ms apart, tiny random pitch wobble). Skipping a line with a tap stops them.
- **Hoot:** at the start of each owl line, an original two-note "hoo-hoo" (falling minor third,
  soft sine with a little pitch bend), not Nintendo's sound.
- All Web Audio in the page (reuse the scheduler idea from the retired Hoo-Hoo Waltz in git
  history, commit aab23d3). Starts on the first tap like the music does.
- Its own small toggle (🔈) next to the ♪, remembered separately, since some people want the
  blips without the music or the other way round. Respect `prefers-reduced-motion`? No, that's
  motion. Instead, keep the volume low and the toggle easy to reach.
- Smoke test: no change needed (no network); add a check that blips stop when the toggle is off.

## Phase 3: The Friday-evening hoot (idea #2), mostly home-hub
- **Tracker side:** `scripts/owl-pick.mjs` also writes a `weekend` pick to `owl-pick.json`: an
  evening-to-long-haul session on any device with no mood, **including wildcards**, and
  respecting `owl-skips.json` (Phase 1). It uses a random seed from the ISO week, so the pick
  stays the same all weekend. Keep the existing `pick` field as-is; the hub's peeking owl uses it.
- **Hub side:** in `nudges.py`, add a weekly nudge on **Friday between 17:00 and 20:00**, once per
  ISO week (state key `owl-weekend-<YYYY-Www>`), via the existing ntfy push. Example: "🦉 Hoo!
  This weekend: Super Mario RPG, 15 achievements from 100%". The tap opens
  `owl.html?pick=<key>`. Quiet hours (21:00–08:00) are already enforced by the nudge runner.
- `owl.html?pick=<key>` opens straight to that pick (the owl says "You came about the weekend,
  hoo?"), with the usual Yes / No / Not this one.
- Hub tests in `test_hub.py` (offline, stub `_owl_pick_json`): sends once per week, only on Fridays
  in the window, skipped when there's no weekend pick.

## Phase 4: Play-length estimates for wildcards (idea #5)
- Reuse `backfill-hltb.mjs`'s lookup (exact normalized title, same HLTB endpoint-discovery
  logic) in a new scheduled step that fills `library-hltb.json` for **wildcard candidates only**:
  favourites, never-started Steam games with Metacritic 80+, unfinished RA games, and club picks.
  About 40 a day, never re-asking a title that was found (or declined).
- `pick.js` `wildcards()` uses that estimate for time scoring (30-min sessions favour short or
  replayable games, long-haul ones favour big games), the same way tracked games use `h`.
  The canon already has `h`.
- Never fails the sync; the run summary lists declined titles, like the cover backfill does.

## Small things noticed along the way
- **Elmo:** *Sesame Street: Elmo's Number Journey* shows up as an unfinished RA game (probably not
  Jonny's play). Phase 1's Drop handles it. If it's needed sooner, add a one-line
  `OWL_IGNORE` list in `pick.js`.
- **Pushing:** the GitHub CLI's login lacks the `workflow` scope, so pushes that touch
  `.github/workflows/` must go over SSH
  (`git push git@github.com:conflagarationman/game-tracker.git <branch>`), or run
  `gh auth refresh -s workflow` once.
- **Never-started Steam wildcards** appear only once `library-meta.json` reaches unplayed games
  (most-played are filled first, ~120/day, about two weeks for the whole library).
