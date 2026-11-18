# Visual critic loop

Jonny's standing rule for anything visual: hard numeric gates first, then a BLIND critic that sees
only screenshots plus a rubric, repeated until a fresh critic finds nothing above "minor".

- `visual-capture.mjs` takes the screenshots and runs the gates. It is not a test: `tests.yml` only
  runs `*.test.mjs` and `smoke.browser.mjs`. Output goes to `/tmp/critic-runs/game-tracker/<stamp>/`
  (PNGs, `manifest.json` = image to plain-English state, `gates.json`). Never commit screenshots.
- `visual-rubric.md` is the only thing the critic reads besides the images and the manifest.

## Running a round

```
npm i --no-save playwright@1.56.1 && npx playwright install chromium
node scripts/visual-capture.mjs            # exits 1 if any gate fails; --only <regex>, --offline
```

1. Fix gate failures until `gates: all pass`.
2. Copy the rubric into the run folder and split `manifest.json` by page (tracker, Wrapped, owl +
   form) so each critic stays well inside its context.
3. Spawn one FRESH critic per group (a Sonnet subagent) whose prompt lets it read only the rubric,
   its manifest and the PNGs, and says: "Before reporting anything as missing, undersized or
   mislabeled, look at that image again to confirm it." Fresh every round so it can't anchor.
4. Triage every finding: fix real ones, add intentional choices to the rubric's Calibration, reject
   false alarms (tighten the rubric), and check each one isn't a capture artifact.
5. Stop when one fresh round has nothing above minor after triage.

## What the gates check (every state)

JS errors and failed local requests; no Worker write attempted; no sideways scroll at 390px; no text
clipped, truncated with an ellipsis, or overflowing its box (ellipsis is a warning only in the
made-up HUGE state); no NaN / undefined / null / Infinity in visible text; every control at least
44x44 on the phone (inline links in a sentence and the hidden Korok are exempt); every Wrapped story
card fits one phone screen; page weight (own files + web fonts) within budget.

States: every page's default; light theme; panels, sheets, edit mode, hearts tip, Great Fairy;
empty, tiny and huge libraries; very long titles; no cover art; no hours; data fails to load;
every Wrapped story card and the share image; the owl conversation step by step; the form adding,
editing a playing game and editing a finished one. Phone 390x844 and laptop 1440x900, scale 1.
Alternate data is built in memory and served in place of the file; tracked files are never edited.
Cover art is fetched by default (read-only image GETs) because the real page shows it.

## Round log

| Round | Run folder | Findings above minor (after triage) | What changed |
|---|---|---|---|
| Gates | `2026-11-17T18-16-20` | 1,045 gate failures, 347 distinct | Baseline. Truncated titles and notes everywhere, ~40 kinds of control under 44px. |
| 1 | `2026-11-17T18-16-20` | 1 blocker, 4 major real (7 reported) | See below. |
| 2 | `2026-11-17T18-53-58` | 0 real (2 major reported, both rejected) | Smoke test failures fixed; calibrations added. |
| 3 | `2026-11-17T20-40-53` | 3 major real (Wrapped) | Share image titles, empty Wrapped, laptop story frame. |
| 4 | `2026-11-17T20-54-34` | 1 major real (tracker) | Designed empty sections. |
| 5 | `2026-11-18T02-22-26` | 1 major real (tracker) | Koroks hidden on the load-failure page; rubric tightened. |
| 6 | `2026-11-18T02-37-39` | **none** (1 minor) | Stop rule met. Hyphenation on card titles; capture skips repeat slices. |

### Round 1

Real, fixed:
- **Blocker:** Wrapped story card "Behind the scenes": "2,837h" ran off the right edge of a phone.
  Big numbers now step their font down until they fit. A new gate ("overflows its box") catches it;
  the old gates missed it because nothing clipped the text.
- Light theme: the platform tag on cover art vanished into dark art ("witch 2"). Opaque backing.
- Load failure left three bare headings under the error. The sections hide now.
- Edit mode changed only the toggle's label. Now a how-to line and dashed outlines on movable cards.
- Wrapped: a lone "0h" read as "oh". Syne defaults to old-style figures; lining figures site-wide.
- Nits/minors fixed while there: "1 games finished", themed checkbox, owl answer chips to 44px.

Rejected / artifacts:
- Broken cover icons in Someday: capture artifact. The script's image wait assigned `img.onerror`,
  replacing the page's own fallback. Now uses listeners. (Three Steam header URLs in `covers.json`
  really do 404, but the page falls back cleanly; `covers.json` is bot-owned, left alone.)
- Duplicate rows in the HUGE Wrapped: mock data (repeated titles whose suffix numbers were cut off).
- Gate artifact: a full-page element screenshot resets touch emulation, so the tap gate measured
  desktop sizes in that one state. Gates now run before the screenshot.
- Empty-state copy (minor): left as is.

### Round 2

- Major "owl replies are plain text, not buttons": intentional Ocarina of Time dialogue style.
  Calibrated.
- Major "numbers glued to titles" in the HUGE Wrapped: my mock data again (`89. Title`). Mock titles
  are now unique invented names.
- Minor "empty owl still suggests games": real behavior (owned Steam games). Label and Calibration fixed.
- Minor "GOTM crop shows the top of the page": capture artifact (viewport coordinates on a full-page
  shot). Fixed.
- Minors fixed: form row misaligned when a label wraps; "days in" pill contrast on parchment.
- The smoke test caught that equal Up Next heights weren't real (the grid stretched the link, not the
  card), that the hearts pill check read 44px as a wrap, and that the owl title touched the bigger
  sound buttons. All fixed; the hearts check now looks at the hearts themselves.

### Round 3

- Major: the share image cut "Zelda: Ocarina of Time (SoH)" to "(S…". Titles shrink 44 to 32px
  first, and any cut lands on a word break.
- Major: Wrapped with no games was one line over a blank screen. Now a designed card with a way back.
- Major: on a laptop, story mode's progress bar spanned the full width over a narrow text column.
  Bars, header and footer now share the card's column.
- Minor fixed: form fields don't inherit `font-variant-numeric`, so a placeholder read "e.g. 2oh".
- Rejected: reorder arrows "under 44px" (the gate measures them at 44x44). Left as a minor: native
  date-picker icons on the form.
- Tracker critic: one nit (empty-state wording).

### Round 4

- Wrapped critic: nothing.
- Owl/form critic: one minor, an EMPTY tracker offers only the "Any" platform chip. That is the
  owl's logic (no tracked platforms), an open question for Jonny rather than a visual fix.
- Tracker critic, major: empty Now playing / Up next / Ongoing were bare sentences under their
  headings (rated minor in round 1 and nit in round 3, unchanged since). Now dashed cards with an
  icon and an in-voice line, plus "+ Add a game" under Now playing.

### Round 5

- Tracker, major: on the load-failure page two Koroks floated alone on the blank page (their
  sections are hidden there). Hidden in that state with CSS in index.html; korok.js untouched.
- Owl, major "laptop owl is a narrow column in a big empty screen" (it also said top-left, but it is
  centered): calibrated as intended, a dialogue-window column. Whether the desktop owl should be
  bigger is an open taste question for Jonny.
- Owl/form and Wrapped, minors "buttons look 32-40px": false alarm, measured 44x44 in the browser.
  The rubric now says tap sizes are measured by the gate and only crowding should be reported.

### Round 6 (clean)

- Wrapped: nothing. Owl/form: nothing. Tracker: one minor, a made-up 34-letter word in the HUGE
  state broke mid-word with no hyphen; card titles now hyphenate (`hyphens:auto`).
- Capture fix: a short page repeated its last slice on a laptop; repeat slices are skipped.
- Noted, not a defect: Wrapped says 47 finished while the poster has 46 cartridges. The poster
  leaves out Idle games by design (see wrapped.html's header).

## Decisions (Jonny, 2026-11-18: "go with your recommendations")

- Up Next notes stay one line with an ellipsis: equal card heights, and tapping a card opens its
  edit page with the full note. Wrapping would make every card as tall as the longest note.
- Lining figures site-wide stay: they fix a real misreading ("0h" as "oh").
- The owl on a laptop stays a centered dialogue-window column.
- An EMPTY tracker giving the owl only the "Any" platform chip stays (the owl's own logic, rare state).
- Empty-section copy stays: "No adventure underway.", "The road ahead is clear.", "No long-running games."
- Left alone: the form's native date-picker icons (minor), and three 404 cover URLs in the
  bot-owned covers.json (the page falls back cleanly).
