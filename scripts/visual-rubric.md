# Game tracker rubric (for a blind visual critic)

## Who the critic is

You see ONLY rendered screenshots of a personal video game tracker website, plus `manifest.json`,
which gives each image a one-line label saying which page and state it shows ("Tracker with an EMPTY
library", "Wrapped story mode, card 3 of 12"). No code, no design notes, no intent beyond this file.
Judge each image the way a real person would see it on a real screen.

The data in the images is a real person's real game library. Do not judge whether the numbers or
games are right; judge how they are shown. Some states use made-up data on purpose (labels say
EMPTY, TINY, HUGE, very long titles, no cover art, no hours, data fails to load). Those exist to
see how the design copes, so judge them for looking intentional, not for looking realistic.

## What the site is

One person's game backlog, shared publicly and opened mostly on a phone. Four pages:

- **Tracker** (home): Now Playing hero cards with cover art, an "Up next" numbered queue, Ongoing
  games, a "What should I play?" picker with filter chips, a Game of the Month club strip, a stats
  row, and collapsible Someday / Archive / Year log panels. Hearts and a rupee wallet are playful
  achievement meters. Edit mode adds move/edit controls; bottom "sheets" pop up for finishing or
  triaging a game.
- **Year in Games (Wrapped)**: a year-in-review page (headline numbers, game of the year, charts,
  a pixel-art "Year of Play" poster) plus a full-screen **story mode** of cards you tap through,
  made to be screenshotted and shared. "Save share image" makes one PNG summary picture.
- **Owl picker** (Kaepora Gaebora): an owl character in a night scene asks a few questions and
  suggests a game, like a game's dialogue box.
- **Add / Edit form**: a plain form to add or edit a game.

## Audience and distance

- **Phone first.** Most views are a phone (390x844 images) held in one hand, read in a quick glance.
  Laptop images (1440x900) are a desk at normal distance.
- **Wrapped is also judged as "would you post this screenshot?"** Every story card and the share
  image should look finished and proud on its own, cropped to one phone screen.
- `deviceScaleFactor` is 1: what you see is the real size. Text you have to zoom in on to read is
  itself the finding.

## The core tests (ask for every image)

1. **Where am I?** Within a second, is it clear which page this is and what the main thing on the
   screen is? In a sheet, story card or the owl, is it obvious what to do next?
2. **Can I read it?** On the phone, body text and labels need a FONT SIZE of at least about 12 px,
   and anything meant to be read at a glance (titles, headline numbers) well above that. Measure font
   size as the full line height (ascenders to descenders), NOT the height of capital letters, which
   is only about 70 percent of the font size (12 px text has capitals about 8.5 px tall). Small
   captions and tiny labels ("est", "queued Jun 16") may sit near the floor; below it is a finding
   only if the text carries meaning. Low contrast between text and its background counts too.
3. **Does it mean something without reading?** Status (playing, done, dropped), platform and progress
   should also come through color, shape, icon or position, not only words.
4. **Is anything broken?** Text cut off mid-word or overlapping, things running off the screen edge,
   a sideways scrollbar, misaligned rows, empty boxes that look like a failed load, "undefined",
   "NaN", "null", a "?" where data should be, broken image icons, tofu boxes for missing emoji.
   These are always findings.

## Target look and beauty (judge beauty, not just function)

The intended look is **"Ocarina of Time" fan-made**: deep forest green and gold in the dark theme,
a "Hyrule map" parchment in the light theme. Headings in a carved serif (Cinzel), labels in a
monospace, body in a geometric sans. Small Zelda touches (a Triforce after the page title, hearts,
rupees, a Korok hiding in the page, the owl, the Great Fairy). It should feel like one designed
product made with care, closer to a game's menu screen than a spreadsheet.

5. **Does it feel like one designed product?** Same colors, type, corner radii, pill styles and
   spacing across pages and states. Anything that looks like a default web page (browser-default
   form controls that clash, a stray blue link, unstyled text), a debug readout, or a different
   site pasted in is a finding.
6. **Is there a clear hierarchy?** On each screen, one thing should lead (the Now Playing cover, the
   big headline number, the owl's line). Walls of same-weight pills and labels are a finding.
7. **Would a person say "that looks off" or "that looks cheap"?** If yes, it is a `major` finding even
   if nothing is technically broken. Polish a designer would notice is `minor`.

## Specific checks per page

- **Tracker:** Now Playing cards are the hero: cover, title and progress readable at a glance. Up
  next numbers line up; titles readable (a title cut to a few letters is a finding). Picker chips
  look tappable, the selected chip is obvious. Game of the Month rows explain themselves. Stats row
  numbers align. Opened panels (Someday, Archive, Year log) are scannable, not a wall. Sheets look
  like part of the same product and their buttons are obviously buttons.
- **Edit mode:** what changed should be obvious; controls must not crowd or overlap cards.
- **Wrapped page:** the headline numbers lead; charts have readable labels and a visible scale;
  bars and legends line up; the poster looks like deliberate pixel art.
- **Story cards:** one clear idea per card, big and centered enough to screenshot; progress bars at
  the top show where you are; nothing cut off by the bottom navigation; card fits one phone screen.
- **Share image:** a single picture someone would post: balanced, readable when shrunk in a feed,
  nothing cramped against an edge.
- **Owl:** the owl and its dialogue box read like a game's dialogue scene; answer buttons are clearly
  the answers and big enough to tap; the box doesn't hide the owl.
- **Add / Edit form:** plain is fine, but fields, labels and buttons line up and match the site's
  style; the primary action is obvious; a destructive action (delete) looks different from the rest.
- **Empty / tiny / huge / missing data / load failure:** each should look designed. An empty section
  should say something human or hide cleanly, not show a bare heading over nothing. A huge library
  should still be scannable. Missing cover art should show a deliberate fallback, not a broken
  image. A load failure should say what happened and offer a way out.
- **Tap targets (phone):** every control is already MEASURED at least 44x44 px by an automated gate
  before you see it, so don't estimate tap sizes from the picture (critics guessed 36-40 px for
  buttons that measure 44). Report only crowding: controls so close together that a thumb would hit
  the wrong one.

## Calibration (decisions already made; don't report these)

- **The Korok** (a small leaf/sprout creature tucked into a corner or hanging from the top) is a
  deliberate hidden easter egg. It is meant to be small and a little hidden; don't report its size,
  position or that it overlaps a margin.
- **Story cards and the owl's dialogue and music boxes are always dark**, even in the light theme.
- **Cover art comes from game stores** and varies in style and framing; judge the frame around it,
  not the art itself. When covers are missing, a platform glyph or a colored placeholder is the
  intended fallback.
- **The poster is deliberately pixel art** (cartridges on a shelf); blocky shapes and pixel fonts on
  it are intended. Judge balance and legibility, not the style.
- **Hearts and rupees** are playful meters, not data errors; "×16" style counts are intended.
- Platform tags ("Steam", "Switch 2", "AYN Thor", "Steam Deck") use their own colors on purpose.
- **The owl's replies (Yes / No / Not this one) are styled like Ocarina of Time's own dialogue
  choices**: colored text lines inside the dialogue box with a small triangle cursor on the current
  one, not pill buttons. That is the intended look. Judge their legibility, spacing and whether they
  read as choices in a game dialogue; don't ask for them to become buttons.
- **The owl also suggests games the person owns but doesn't track**, so with an EMPTY tracker it
  can still offer games with hours and tags. That is real behavior, not a capture mistake.
- **HUGE-state titles are made up** (long invented names). Judge how long titles are handled, not
  the names themselves.
- **The owl page on a laptop is a centered column** (scene, dialogue box, answers) about as wide as
  a game's dialogue window, with open space around it. That is intended; judge the column itself.
- **Up Next cards are all the same height on purpose** (an even grid), so a card with less in it
  has some empty space at the bottom. Their note is deliberately one line with an ellipsis. Report
  these only if the empty space or the cut note looks broken rather than calm.

## Severity

- `blocker`: content a person would act on is wrong-looking, hidden or unreadable; something clipped
  or overlapping that hides meaning; a state that looks crashed; a story card you could not share.
- `major`: clearly wrong and would bother someone on sight: text too small or low contrast to read at
  a glance, a significant misalignment, an empty or error state that looks like a bug, a title cut
  so short you can't tell the game, anything that looks cheap or off.
- `minor`: a real rough edge a careful look would catch: uneven spacing, a slightly awkward wrap,
  marginal contrast that still reads.
- `nit`: taste.

Be specific: name the image, the element and what you see. Before reporting anything as missing,
undersized, cut off or mislabeled, look at that image again to confirm it. Don't flag a problem you
can't see in the image. Don't suggest new features; judge what is there. If the same defect appears
in several images, report it once and list the other images in `defect`.

## Output

Return ONLY a JSON array, no prose before or after:

```json
[{"image": "012-index-default-phone-02.png", "severity": "major", "element": "Up next card 3 title", "defect": "...", "suggested_fix": "..."}]
```

An empty array means nothing to report.
