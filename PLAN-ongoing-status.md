# Plan: `s: "ongoing"` — a status for continuous games

**Handoff doc for the implementing session. Delete this file in the final commit.**

Branch: `claude/continuous-games-tracking-53lbjq`

---

## 1. The problem

WoW (id 506) and Marvel Snap are *continuous* games: live-service / evergreen titles that are
played indefinitely and never reach `done`. Today WoW is filed as `s: "playing"`, which is
wrong in four measurable ways:

| Consumer | Symptom |
|---|---|
| `render()` stats, `index.html:734` | `Playing: 7` counts a game that will never decrement it |
| `pushToHub`, `scripts/sync-apis.mjs:253` | WoW permanently occupies the Family Holocron hub card |
| `isDormant`, `index.html:389` | a 30-day gap reads as "you stalled"; for WoW that's just a Tuesday |
| backlog hours, `index.html:729` | would absorb any HLTB estimate, and HLTB for WoW is meaningless |

Now Playing is also a hero-card grid; a permanent resident there costs the most expensive
real estate on the page for a card that carries no decision.

## 2. The design decision — already made, do not relitigate

**Add a sixth value to `s`. Do NOT add a `continuous: true` boolean.**

The obvious alternative is a boolean modifier alongside `s: "playing"`, mirroring the existing
`casual: true`. It was considered and rejected:

- Every consumer in this codebase filters by strict equality (`g.s === 'playing'`,
  `g.s === 'queue'`, `g.s === 'done' || g.s === 'dropped'`). A new **enum value** excludes
  itself from all of them for free. A **boolean** must be remembered and excluded in six
  places, and its failure mode is silent over-counting — precisely the class of bug CLAUDE.md
  opens by warning about ("re-derived from scratch more than once").
- `casual: true` already exists and Marvel Snap probably wants it too. It suppresses
  achievement display, not placement — which is the proof that a modifier flag doesn't solve
  the actual ask anyway.

Data value and human-facing label are the same word: **`ongoing`** / **"Ongoing"**.
Jonny settled this; do not substitute "In rotation" or "Always on".

## 3. Changes, file by file

### 3.1 `worker/index.mjs`

Line 40 — one word:

```js
const VALID_STATUSES = new Set(["playing", "queue", "soon", "done", "dropped", "ongoing"]);
```

Extend the adjacent comment to say what `ongoing` means and why it is a status rather than a
flag (one or two lines; match the tone of the `VALID_PLATFORMS` comment above it, which
explains `pc` vs `steam` the same way).

`reorderQueue` (line 188) needs **no change** — it filters `g.s === "queue"`, so ongoing rows
are invisible to it and its 409 membership invariant is unaffected.

### 3.2 `add.html`

Line ~127, add one option directly under Playing so the ordering reads as a lifecycle:

```html
<option value="playing">Playing</option>
<option value="ongoing">Ongoing</option>
```

Nothing else in this file changes:
- `isFinished` (line 305) is `done || dropped` — correct as-is; the completion block stays
  hidden for ongoing, which is right, since an ongoing game has no `cy`/`cm`.
- `onStatusChange` only stamps a completion date on a transition *into* done/dropped. An
  ongoing game moving to dropped ("I quit WoW") correctly gets today's month.
- The reorder panel (`roLoad`, line ~582) filters `g.s === 'queue'`. Unaffected.
- `needsDate` (line 519) is done/dropped-only. Unaffected.

### 3.3 `index.html` — the section

Insert **between Up next (ends line 305) and Soon™ (starts line 306)**:

```html
<section aria-labelledby="ongoing-heading">
  <h2 class="slabel" id="ongoing-heading">Ongoing</h2>
  <div class="ong-list" id="ongoing"></div>
</section>
```

**Not `queue-grid`.** That class (line 183) is a multi-column
`repeat(auto-fill,minmax(280px,1fr))` grid, which would lay ongoing games out as cards side by
side — the opposite of the slim stacked list §3.4 specifies. Add a new container class
modelled on `.gotm-rows` (line 82):

```css
.ong-list{display:flex;flex-direction:column;gap:6px;}
```

**Render it unconditionally with an empty state — never `display:none` when empty.** A hidden
section cannot be a drop target, so hiding it would make "drag WoW here" impossible from a
clean slate. Follow the pattern already used at line 741-744: `'<div class="empty">Nothing
ongoing.</div>'`.

### 3.4 `index.html` — the row

**Reuse `.card`, do not invent a new row type.** Build it as
`<div class="card ong" data-id="${g.id}">`, wrapped in `cardLink(g, ...)`.

This matters mechanically, not just stylistically. `onPointerDown` (line 863) and
`handleTapMove` (line 986) both find draggables via `e.target.closest('.hero-card, .card')`,
and `.drop-hover` / `.dragging` / `.move-picked` are all styled against `.card`. A bespoke
`.ong-row` element would silently opt out of the entire drag and tap-to-move engine.

`.ong` is a slimming modifier on top: smaller thumb, tighter padding, no `row3`/achievement
bar. Add one CSS rule near the existing `.card` rules (line ~136). Target visual weight:
noticeably lighter than an Up Next card, roughly the density of `.gotm-row` (line 83).

Row content — deliberately minimal, because none of this is a decision:

```
[thumb] [platform pill] Title          [played Aug 28 | ❄ cold]  [📌 note]
```

No queue number, no HLTB, no achievement bar, no `startEl`. Add a dedicated `ongC(g)`
alongside `qC` (line 497) rather than overloading `qC` with a third mode — `qC` already
carries a `showNum` flag for the Up Next / Soon split, and a third variant would tip it over.

**Sort by `lastPlayed` descending, nulls last.** Not array order: array order is the Up Next
priority contract (CLAUDE.md, "Array order is meaningful") and `/games/reorder` cannot touch
ongoing rows, so presenting them in array order would imply an ordering nothing maintains.

### 3.5 `index.html` — the cold signal

Do **not** reuse `isDormant`. Add a sibling:

```js
// Dormancy means opposite things for the two kinds of in-progress game. For a backlog game,
// 30 days idle is a stall. For an ongoing game it's unremarkable — but 90+ days is a habit
// that quietly ended, and the useful nudge is "demote this to dropped", not "get back to it".
function isCold(g){
  if(!g.lastPlayed) return false;
  return (NOW - new Date(g.lastPlayed))/(1000*60*60*24) > 90;
}
```

Render as a muted `❄ cold` pill in the ongoing row, styled like `.dormant-pill`.

**Known limitation, state it in the comment rather than working around it:** WoW is
`p: "pc"`, which `syncSteam` skips by design (`sync-apis.mjs:139`), so its `lastPlayed` stays
`null` and `isCold` can never fire for it. Do not fall back to `start` — a game started in
August and played daily would falsely read cold in November. Show nothing; an honest blank
beats a wrong pill.

### 3.6 `index.html` — wire up the move targets

Three selector strings and two arrays currently hardcode the three sections — five sites,
listed below. **Replace all five with two shared constants** rather than adding a fourth entry
to each. This is the change most likely to be half-applied, and a half-applied version fails
asymmetrically: miss `cardSectionAt` and you can drag out of Ongoing but not into it.

```js
const MOVE_SECTIONS = ['now','queue','soon','ongoing'];
const MOVE_SEL = MOVE_SECTIONS.map(id => '#' + id).join(', ');
```

Sites to update:

| Line | Current |
|---|---|
| 820 | `cardSectionAt`: `el.closest('#now, #queue, #soon')` |
| 865 | `onPointerDown`: `cardEl.closest('#now, #queue, #soon')` |
| 957 | `cancelMoveMode`: `['now','queue','soon'].forEach(...)` |
| 972 | `beginMoveMode`: `['now','queue','soon'].filter(...)` |
| 981 | `handleTapMove`: `e.target.closest('#now, #queue, #soon')` |

And `sectionPatch` (line 801):

```js
if (sectionId==='ongoing') return { s:'ongoing', start: g.start || todayStr() };
```

Note `g.start || todayStr()`, **not** the unconditional `todayStr()` that `'now'` uses —
moving WoW to ongoing must not reset its `start: "2026-08-11"`. `moveGameToSection` already
snapshots `{s, start, queued}` for rollback, so this patch shape needs no other change.

### 3.7 `index.html` — remaining small sites

- **`render()` (line 725):** add `const ongoing = G.filter(g => g.s === 'ongoing');` and the
  `document.getElementById('ongoing').innerHTML = ...` line. Do **not** add it to `backlogHrs`
  (line 729) — an ongoing game has no finish line to estimate.
- **Stats row (line 733-740):** leave it alone. It is already six wide and tight on mobile,
  and "2 ongoing" is not a number anyone acts on. If it feels absent, that's the correct
  feeling.
- **`gotmRow` (line 672):** **no change needed.** The state ternary falls through to raw
  `g.s`, which now prints exactly `ongoing` — a free consequence of the data value and the
  label being the same word (§2). Do not add a branch that maps `'ongoing'` to `'ongoing'`.
- **`showSkeletons` (line 1021)** and the **load-error handler (lines 1052-1054):** add
  `#ongoing` to both so the section doesn't read as "loaded and empty" during a fetch, or
  keep stale rows after a failure. Both currently touch `now` and `queue` only.
- **`renderPanels` (line 611):** no change. Archive and Year Log filter `done || dropped`;
  ongoing correctly appears in neither.

### 3.8 `scripts/sync-apis.mjs`

**No code change required.** Verify and leave alone:

- `pushToHub` (line 253) filters `g.s === "playing"` — ongoing self-excludes from the hub card.
  That is the intended v1 behaviour (see §6 for the open question).
- `syncSteam` (line 139) filters on *platform*, not status, so a Steam-hosted ongoing game
  (Marvel Snap) keeps syncing playtime and achievements. This is correct and is what makes the
  `isCold` signal work for anything on Steam.

### 3.9 `CLAUDE.md`

Update three places:

1. The `games.json` record shape block — extend the `"s"` comment line to
   `playing | ongoing | queue | soon | done | dropped` and add a line explaining `ongoing`.
2. "Things that are easy to get wrong" — add a bullet: an ongoing game has no completion and
   no HLTB by design; `h`, `cy`, `cm` stay null and that is not missing data.
3. A short paragraph recording the enum-vs-boolean reasoning from §2, so it isn't relitigated.
   This is exactly the class of decision CLAUDE.md exists to preserve.

## 4. Data migration

- **WoW, id 506:** `"s": "playing"` → `"s": "ongoing"`. Keep `start: "2026-08-11"`. Leave
  `h: null` and `cy: null` as they are. Edit `games.json` in place; **do not** reformat or
  re-sort the array (CLAUDE.md: array order is the Up Next priority contract).
- **Marvel Snap:** not currently in `games.json`. Jonny adds it through `add.html` once
  deployed — do not hand-write a record with a guessed id, since the Worker owns `max(id)+1`.
  It will likely want `casual: true` alongside `ongoing`: its achievement total keeps growing,
  so a percentage is meaningless.

## 5. Verification

Existing suites must stay green (nothing enumerates the statuses, so nothing should break):

```
node scripts/sync-apis.test.mjs        # 12
node scripts/backfill-covers.test.mjs  # 11
node scripts/fetch-gotm.test.mjs       # 13
cd worker && node index.test.mjs       # 23 -> 24
```

**Add one worker test:** `POST /games/add` with `s: "ongoing"` is accepted, and an invalid
status is still rejected with the full list in the message.

**Consider one `sync-apis` test:** `pushToHub` omits an ongoing game from `now_playing`. It
passes today by construction, which is exactly why it's worth pinning — the exclusion is
load-bearing and currently accidental.

**Browser verification is required, not optional.** CLAUDE.md notes the pages have no unit
tests and that headless-browser driving has caught real bugs that reading the code did not.
Chromium is preinstalled at `/opt/pw-browsers/chromium`; do not run `playwright install`.
Check specifically:

1. WoW renders under "Ongoing", not "Now playing"; `Playing` stat reads 6.
2. The section renders its empty state when no game is ongoing, **and is still a valid drop
   target in that state** — this is the failure mode §3.3 exists to prevent.
3. Desktop: drag a card from Now Playing into Ongoing and back. Confirm `.drop-hover`
   highlights, and that auto-scroll still reaches the new section (it sits below Up Next, so
   it will often be below the fold from Now Playing).
4. Mobile emulation (coarse pointer): tap-to-move picks up an ongoing row and the move bar
   offers the other three sections.
5. With `WORKER` unset, rows are not links and edit mode is hidden — same as every other card.

## 6. Open question for Jonny — ask, don't guess

**The hub card.** v1 drops ongoing games from the Family Holocron `now_playing` push entirely.
The alternative is a third array in the payload, but that needs a matching change on the
familyholocron side, which is outside this repo. Confirm the exclusion is what he wants before
shipping, since the hub card visibly loses WoW.

*(Label wording was the other open question. It is settled — see §2. "Ongoing", everywhere.)*

## 7. Out of scope — do not bundle

Now Playing currently holds seven games, four with no `lastPlayed` at all (Splatoon Raiders,
Pokopia, Pokemon Lazarus, and SotN last touched 2026-07-08). That is a *separate* problem:
`playing` is accumulating games that were started and drifted away from, and no status change
fixes it. Jonny has been told it exists and has not asked for it. Do not fold a staleness
sweep into this change.
