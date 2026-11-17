// Visual critic capture + hard gates. NOT a test suite: tests.yml only runs *.test.mjs and
// smoke.browser.mjs, so this never runs in CI. It screenshots every page in many states (default,
// open panels, story cards, empty / tiny / huge libraries, long titles, missing art, null hours,
// load failure, light theme) at phone 390x844 and laptop 1440x900, runs numeric gates on each
// state, and writes PNGs + manifest.json + gates.json to /tmp/critic-runs/game-tracker/<stamp>/.
// The blind critic then reads only those PNGs, manifest.json and scripts/visual-rubric.md. See
// scripts/visual-critic-README.md for the loop and the round log. Never commit the screenshots.
//
//   npm i --no-save playwright@1.56.1 && npx playwright install chromium
//   node scripts/visual-capture.mjs                 # everything
//   node scripts/visual-capture.mjs --only wrapped  # states whose name matches
//   node scripts/visual-capture.mjs --offline       # cover art blocked too (fully offline)
//
// Nothing is written anywhere. The Worker is stubbed (writes recorded, never sent) and the pages are
// served from a local static server over the committed JSON. Alternate data (empty, huge...) is
// built in memory and served in place of a file for that one page; tracked files are never edited.
// Cover art (Steam / SteamGridDB image GETs) is let through by default because the real page shows
// it and a page of fallback glyphs is not what people see; --offline blocks it.
//
// PLAYWRIGHT_MODULE and CHROMIUM_PATH override the import and the browser, as in the smoke test.
import http from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const val = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const ONLY = val("--only") ? new RegExp(val("--only")) : null;
const OFFLINE = flag("--offline");
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const OUT = val("--out") || `/tmp/critic-runs/game-tracker/${stamp}`;
await mkdir(OUT, { recursive: true });

const TYPES = { ".webmanifest": "application/manifest+json", ".png": "image/png", ".html": "text/html", ".js": "text/javascript", ".json": "application/json", ".css": "text/css", ".mjs": "text/javascript" };
const server = http.createServer(async (req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url, "http://x").pathname)).replace(/^([/\\])+/, "");
  try {
    const body = await readFile(join(ROOT, path || "index.html"));
    res.writeHead(200, { "Content-Type": TYPES[extname(path)] || "application/octet-stream" });
    res.end(body);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(r => server.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${server.address().port}`;

// ─── Alternate data ────────────────────────────────────────────────────────────────────────
const readJson = async (f) => JSON.parse(await readFile(join(ROOT, f), "utf8"));
const GAMES = await readJson("games.json");
const YEAR = new Date().getFullYear();
const blank = (o) => ({ id: 0, t: "", p: "steam", s: "queue", g: "Action", y: 2020, h: "10h", r: 0, cy: null, cm: null, gotm: null, gotmFlair: false, mastery: null, diff: null, achPct: null, achCount: null, actualHours: null, lastPlayed: null, casual: false, note: null, start: null, queued: null, release: null, ...o });
const LONG = [
  "The Legend of Heroes: Trails through Daybreak II (Deluxe Edition)",
  "Shin Megami Tensei V: Vengeance - Digital Deluxe Edition",
  "Warhammer 40,000: Space Marine 2 - Ultramarines Collector's Bundle",
  "Teenage Mutant Ninja Turtles: Shredder's Revenge Anniversary Edition",
  "Supercalifragilisticexpialidocious Adventures of the Unpronounceable",
];
const variants = {
  // A brand-new tracker.
  empty: { "games.json": [] , "play-check.json": null, "achievements-log.json": { unlocks: [] } },
  // One of each: playing, up next, finished this year.
  tiny: { "games.json": [
    blank({ id: 1, t: "Hollow Knight", s: "playing", g: "Metroidvania", h: "30h", actualHours: 12.4, start: `${YEAR}-10-01`, lastPlayed: `${YEAR}-11-10` }),
    blank({ id: 2, t: "Celeste", s: "queue", g: "Platformer", h: "8h", queued: `${YEAR}-09-01` }),
    blank({ id: 3, t: "Hades", s: "done", g: "Roguelike", h: "22h", r: 9, cy: YEAR, cm: 2, actualHours: 31 }),
  ], "play-check.json": null },
  // Very long titles on what shows first, plus a few hundred extra games everywhere.
  huge: (() => {
    const g = GAMES.map((x, i) => (["playing", "queue"].includes(x.s) && i % 2 === 0) ? { ...x, t: LONG[i % LONG.length] } : x);
    let id = Math.max(...GAMES.map(x => x.id)) + 1;
    const st = ["queue", "soon", "soon", "done", "done", "dropped"];
    for (let i = 0; i < 420; i++) g.push(blank({ id: id++, t: `${i + 1}. ${LONG[i % LONG.length]}`, s: st[i % st.length], g: "Action RPG", h: `${10 + (i % 60)}h`, r: st[i % st.length] === "done" ? 1 + (i % 10) : 0, cy: st[i % st.length] === "done" ? YEAR - (i % 4) : null, cm: st[i % st.length] === "done" ? i % 12 : null, actualHours: st[i % st.length] === "done" ? 5 + (i % 90) : null }));
    return { "games.json": g };
  })(),
  // Hours unknown everywhere a game shows hours.
  nullhours: { "games.json": GAMES.map(x => (["playing", "queue", "done"].includes(x.s)) ? { ...x, h: null, actualHours: null, priorH: null } : x) },
  // Cover art missing: empty covers.json and every image host blocked (fallback glyphs).
  nocovers: { "covers.json": {}, __blockImages: true },
  // The data never arrives (offline, or Pages down).
  loaderror: { __fail: ["games.json"], __expectErrors: /Failed to load game data/ },
};

// ─── Browser plumbing ──────────────────────────────────────────────────────────────────────
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const VIEWPORTS = { phone: { width: 390, height: 844, mobile: true }, laptop: { width: 1440, height: 900, mobile: false } };

async function open(path, vpName, { variant = null, scheme = "dark", storage = null } = {}) {
  const vp = VIEWPORTS[vpName];
  const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: 1, isMobile: vp.mobile, hasTouch: vp.mobile, colorScheme: scheme, reducedMotion: "reduce" });
  const page = await ctx.newPage();
  const v = variant ? variants[variant] : {};
  const errors = [], failed = [], writes = [];
  let localBytes = 0, imageBytes = 0;
  page.on("pageerror", e => errors.push(`pageerror: ${e.message}`));
  page.on("console", m => { if (m.type() === "error" && !/Failed to load resource|net::ERR/.test(m.text()) && !(v.__expectErrors && v.__expectErrors.test(m.text()))) errors.push(`console: ${m.text()}`); });
  page.on("dialog", d => { errors.push(`dialog: ${d.message()}`); d.dismiss(); });
  page.on("requestfailed", r => { const u = r.url(); if (u.startsWith(BASE) && !(v.__fail || []).some(f => u.includes(f))) failed.push(`${new URL(u).pathname} ${r.failure()?.errorText}`); });
  page.on("response", async r => {
    const u = r.url();
    if (u.startsWith(BASE) && r.status() >= 400) failed.push(`${new URL(u).pathname} HTTP ${r.status()}`);
    try { const n = (await r.body()).length; if (u.startsWith(BASE) || /fonts\.g/.test(u)) localBytes += n; else if (r.request().resourceType() === "image") imageBytes += n; } catch {}
  });
  await page.route("**/*", route => {
    const req = route.request(), url = req.url();
    if (url.startsWith(BASE)) {
      const file = new URL(url).pathname.replace(/^\//, "");
      if ((v.__fail || []).includes(file)) return route.abort("internetdisconnected");
      if (file in v) return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(v[file]) });
      return route.continue();
    }
    if (/^https:\/\/fonts\.(googleapis|gstatic)\.com\//.test(url)) return route.continue();
    if (/workers\.dev/.test(url)) {
      if (req.method() === "POST") writes.push(new URL(url).pathname);
      return route.fulfill({ status: 200, contentType: "application/json", headers: { "Access-Control-Allow-Origin": "*" }, body: "[]" });
    }
    if (req.resourceType() === "image" && req.method() === "GET" && !OFFLINE && !v.__blockImages) return route.continue();
    return route.abort();
  });
  if (storage) await page.addInitScript((s) => { for (const [k, x] of Object.entries(s)) localStorage.setItem(k, x); }, storage);
  await page.goto(BASE + "/" + path, { waitUntil: "load" });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.waitForTimeout(600);
  return { page, ctx, errors, failed, writes, bytes: () => ({ localBytes, imageBytes }) };
}

// Waits until every <img> in the page has finished (loaded or failed), so a half-loaded cover
// is never captured as a defect (the hub loop hit exactly that with a lazy radar image). Listeners,
// never onerror=: assigning it replaced the pages' own fallback and faked broken covers (round 1).
const settleImages = (page) => page.evaluate(async () => {
  const imgs = [...document.images].filter(i => !i.complete);
  await Promise.race([Promise.all(imgs.map(i => new Promise(r => { i.addEventListener("load", r, { once: true }); i.addEventListener("error", r, { once: true }); }))), new Promise(r => setTimeout(r, 8000))]);
});

// ─── Gates ─────────────────────────────────────────────────────────────────────────────────
// Run inside the page. `scope` limits to a subtree (story card), else the whole document.
function measure({ phone, scope }) {
  const root = scope ? document.querySelector(scope) : document.body;
  const vis = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width <= 2 || r.height <= 2) return false; // includes screen-reader-only text
    for (let e = el; e; e = e.parentElement) {
      const cs = getComputedStyle(e);
      if (cs.display === "none" || cs.visibility === "hidden" || Number(cs.opacity) === 0) return false;
      if (e.hidden || e.closest("[hidden],dialog:not([open])")) return false;
    }
    return true;
  };
  const label = (el) => {
    const t = (el.innerText || el.value || el.getAttribute("aria-label") || "").trim().replace(/\s+/g, " ").slice(0, 50);
    return `${el.tagName.toLowerCase()}${el.id ? "#" + el.id : ""}${el.classList.length ? "." + [...el.classList].join(".") : ""} "${t}"`;
  };
  const out = { overflowX: null, clipped: [], truncated: [], badText: [], smallTargets: [], offscreen: [] };
  const de = document.documentElement;
  if (phone) out.overflowX = de.scrollWidth > innerWidth + 1 ? `page is ${de.scrollWidth}px wide on a ${innerWidth}px screen` : null;
  const all = [root, ...root.querySelectorAll("*")];
  for (const el of all) {
    if (["SCRIPT", "STYLE", "SVG", "CANVAS", "OPTION", "INPUT", "SELECT", "TEXTAREA", "IFRAME", "NOSCRIPT"].includes(el.tagName) || el.closest("svg")) continue;
    const ownText = [...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim());
    if (ownText && vis(el)) {
      const cs = getComputedStyle(el);
      const hx = cs.overflowX !== "visible" || cs.textOverflow === "ellipsis";
      const hy = cs.overflowY !== "visible" || cs.webkitLineClamp !== "none";
      // A deliberate ellipsis or line clamp is "truncated"; a hard cut with no ellipsis is "clipped".
      const trunc = cs.textOverflow === "ellipsis" || cs.webkitLineClamp !== "none";
      // Up Next notes are one line on purpose (equal card heights, full note in its title; the smoke
      // test pins it). Listed in the rubric's Calibration; an open question for Jonny.
      if (trunc && el.matches(".queue-grid .note-pill")) continue;
      const bucket = trunc ? out.truncated : out.clipped;
      if (hx && el.scrollWidth > el.clientWidth + 1) bucket.push(`${label(el)} cut off sideways (${el.scrollWidth}px of text in ${el.clientWidth}px)`);
      else if (hy && el.scrollHeight > el.clientHeight + 2 && cs.overflowY !== "auto" && cs.overflowY !== "scroll") bucket.push(`${label(el)} cut off at the bottom (${el.scrollHeight}px in ${el.clientHeight}px)`);
      // Text wider than its own box with nothing clipping it: it runs over whatever is next to it, or
      // off the screen (round 1: Wrapped's "2,837h" ran off a phone and no gate saw it).
      if (!hx && cs.display !== "inline" && el.scrollWidth > el.clientWidth + 1 && el.clientWidth > 0) out.clipped.push(`${label(el)} overflows its box sideways (${el.scrollWidth}px of text in ${el.clientWidth}px)`);
      // Clipped by an ancestor that hides overflow.
      const r = el.getBoundingClientRect();
      for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
        const acs = getComputedStyle(a);
        if (acs.overflowX === "hidden" || acs.overflowX === "clip") {
          const ar = a.getBoundingClientRect();
          if (r.right > ar.right + 2 || r.left < ar.left - 2) { out.clipped.push(`${label(el)} spills past the edge of ${label(a).split(" ")[0]}`); }
          break;
        }
      }
      if (phone && (r.right > innerWidth + 1 || r.left < -1) && getComputedStyle(el).position !== "fixed") out.offscreen.push(`${label(el)} off the side of the screen (x ${Math.round(r.left)}..${Math.round(r.right)})`);
    }
  }
  const text = root.innerText || "";
  for (const m of text.matchAll(/(^|[^\w])(NaN|undefined|null|Infinity|\[object Object\])(?![\w])/g)) {
    const i = m.index; out.badText.push(`"${m[2]}" in: …${text.slice(Math.max(0, i - 30), i + 30).replace(/\s+/g, " ")}…`);
  }
  if (phone) {
    const sel = 'a[href],button,input:not([type=hidden]),select,textarea,summary,[role=button],[onclick],[tabindex="0"]';
    for (const el of root.querySelectorAll(sel)) {
      if (!vis(el) || el.disabled) continue;
      if (el.parentElement && el.parentElement.closest(sel)) continue; // the bigger target counts
      if (el.closest(".korok-btn,.korok")) continue; // the hidden Korok is small on purpose (rubric Calibration)
      const r = el.getBoundingClientRect();
      // Links inside a sentence are exempt (WCAG 2.5.8's inline exception).
      if (el.tagName === "A" && getComputedStyle(el).display === "inline" && el.parentElement && [...el.parentElement.childNodes].some(n => n.nodeType === 3 && n.textContent.trim().length > 2)) continue;
      // A checkbox or radio is hit through its label, so the label is the target.
      if (/^(checkbox|radio)$/.test(el.type)) { const l = el.closest("label") || (el.id && document.querySelector(`label[for="${el.id}"]`)); if (l) { const lr = l.getBoundingClientRect(); if (lr.width >= 44 && lr.height >= 44) continue; } }
      if (r.width < 44 || r.height < 44) out.smallTargets.push(`${label(el)} ${Math.round(r.width)}x${Math.round(r.height)}`);
    }
  }
  return out;
}

// Weight budgets: own files + web fonts per page in its default phone state, set on 2026-11-17
// from that day's sizes plus 10 percent. Cover art is reported, not budgeted (it is third-party
// and varies with what is being played).
// Main on 2026-11-17 measured index 566,389, wrapped 521,518, owl about 559,000 and add 242,183 bytes.
// The bot-written JSON (achievements-log.json especially) grows daily, so expect to raise these now
// and then; a jump far past the growth is the thing to look into.
const WEIGHT_BUDGET = { "index.html": 623000, "wrapped.html": 573700, "owl.html": 615000, "add.html": 266400 };

// ─── States ────────────────────────────────────────────────────────────────────────────────
// Each state: name, page path, label (what the critic is told), viewports, optional variant,
// scheme, storage, setup(page), slices (screen-by-screen captures of a scrolling page),
// element (capture that element alone), story (story-card fit gate).
const clickAll = async (page, sel) => { for (const h of await page.$$(sel)) { await h.click().catch(() => {}); await page.waitForTimeout(150); } };
const openPanels = async (page) => { for (const id of ["so", "ar", "yl"]) await page.click(`#${id}-toggle`).catch(() => {}); await page.waitForTimeout(400); };
const BOTH = ["phone", "laptop"], PHONE = ["phone"];

const states = [
  { name: "index-default", page: "index.html", label: "Tracker home page as it opens, scrolled screen by screen from the top", vps: BOTH, slices: true, weight: "index.html" },
  { name: "index-light", page: "index.html", label: "Tracker home page in the light (parchment) theme, first screen", vps: PHONE, scheme: "light" },
  { name: "index-light-lower", page: "index.html", label: "Tracker home page in the light (parchment) theme, scrolled to the picker and stats", vps: PHONE, scheme: "light", setup: async p => { await p.evaluate(() => document.getElementById("tonight-sec").scrollIntoView()); } },
  { name: "index-panels-open", page: "index.html", label: "Tracker with the Someday, Archive and Year log panels opened, scrolled screen by screen from the Someday panel", vps: BOTH, setup: async p => { await openPanels(p); await p.evaluate(() => document.getElementById("so-toggle").scrollIntoView()); }, slices: true, sliceFromScroll: true, maxSlices: 6 },
  { name: "index-gotm-more", page: "index.html", label: "Game of the Month strip with its extra picks expanded", vps: PHONE, setup: async p => { await p.click("#gotm-toggle").catch(() => {}); await p.waitForTimeout(200); }, element: "#gotm-sec" },
  { name: "index-edit-mode", page: "index.html", label: "Tracker with Edit mode switched on, first screen", vps: BOTH, setup: async p => { await p.click("#edit-toggle"); await p.waitForTimeout(300); } },
  { name: "index-hearts-tip", page: "index.html", label: "Tracker with the hearts meter tapped open (its explanation showing)", vps: PHONE, setup: async p => { await p.click("#hearts").catch(() => {}); await p.waitForTimeout(300); } },
  { name: "index-finish-sheet", page: "index.html", label: "The 'mark as finished' sheet opened from a Now Playing game", vps: BOTH, setup: async p => { await p.evaluate(() => { const g = G.find(x => x.s === "playing"); openFinish(g.id); }); await p.waitForTimeout(400); } },
  { name: "index-triage-sheet", page: "index.html", label: "The Someday triage sheet (deciding one old backlog game at a time)", vps: PHONE, setup: async p => { await p.evaluate(() => openTriage("someday")); await p.waitForTimeout(400); } },
  { name: "index-great-fairy", page: "index.html", label: "Great Fairy celebration that appears once when a game is newly mastered", vps: PHONE, storage: { gt_gf_seen: "[]" }, setup: async p => { await p.waitForTimeout(1200); } },
  { name: "index-empty", page: "index.html", label: "Tracker with an EMPTY library (a brand-new user, no games at all)", vps: BOTH, variant: "empty", slices: true, maxSlices: 3 },
  { name: "index-tiny", page: "index.html", label: "Tracker with a TINY library: one game playing, one up next, one finished", vps: PHONE, variant: "tiny", slices: true, maxSlices: 3 },
  { name: "index-huge", page: "index.html", label: "Tracker with a HUGE library (400+ extra games) and very long titles on the first cards", vps: BOTH, variant: "huge", slices: true, maxSlices: 4 },
  { name: "index-nullhours", page: "index.html", label: "Tracker where no game has an hours estimate or tracked hours", vps: PHONE, variant: "nullhours", slices: true, maxSlices: 4 },
  { name: "index-nocovers", page: "index.html", label: "Tracker with NO cover art available (every cover missing, fallbacks showing)", vps: PHONE, variant: "nocovers", slices: true, maxSlices: 3 },
  { name: "index-loaderror", page: "index.html", label: "Tracker when the game data fails to load (offline or the site is down)", vps: BOTH, variant: "loaderror" },

  { name: "wrapped-default", page: "wrapped.html", label: "Year in Games (Wrapped) page for this year, scrolled screen by screen from the top", vps: BOTH, slices: true, weight: "wrapped.html" },
  { name: "wrapped-light", page: "wrapped.html", label: "Year in Games page in the light (parchment) theme, first screen", vps: PHONE, scheme: "light" },
  { name: "wrapped-story", page: "wrapped.html?cards=1", label: "Wrapped story mode, card", vps: BOTH, story: true },
  { name: "wrapped-share-image", page: "wrapped.html", label: "The 'Save share image' picture itself (the PNG a person posts), shown at its real size", vps: PHONE, shareImage: true },
  { name: "wrapped-tiny", page: "wrapped.html", label: "Year in Games with only ONE game finished this year", vps: PHONE, variant: "tiny", slices: true, maxSlices: 3 },
  { name: "wrapped-tiny-story", page: "wrapped.html?cards=1", label: "Wrapped story mode with only ONE game finished this year, card", vps: PHONE, variant: "tiny", story: true },
  { name: "wrapped-empty", page: "wrapped.html", label: "Year in Games with NO games at all", vps: PHONE, variant: "empty" },
  { name: "wrapped-huge", page: "wrapped.html", label: "Year in Games with a HUGE year (100+ finished games, very long titles), scrolled screen by screen", vps: PHONE, variant: "huge", slices: true, maxSlices: 7 },

  { name: "owl-ask", page: "owl.html", label: "Owl picker: the owl's first question", vps: BOTH, weight: "owl.html" },
  { name: "owl-flow", page: "owl.html", label: "Owl picker conversation, step", vps: BOTH, owlFlow: true },
  { name: "owl-empty", page: "owl.html", label: "Owl picker with an EMPTY library", vps: PHONE, variant: "empty", owlFlow: true },

  { name: "add-default", page: "add.html", label: "Add / Edit game form, empty (adding a new game), screen by screen", vps: BOTH, slices: true, weight: "add.html" },
  { name: "add-edit", page: "add.html?id=" + (GAMES.find(g => g.s === "playing") || GAMES[0]).id, label: "Add / Edit game form editing an existing Now Playing game, screen by screen", vps: PHONE, slices: true },
  { name: "add-edit-done", page: "add.html?id=" + (GAMES.find(g => g.s === "done" && g.r > 0) || GAMES[0]).id, label: "Add / Edit game form editing a finished, rated game, screen by screen", vps: PHONE, slices: true },
];

// ─── Run ───────────────────────────────────────────────────────────────────────────────────
const manifest = [], gates = [];
const weights = {};
let n = 0;
const shot = async (page, file, label, opts = {}) => {
  n++;
  const name = `${String(n).padStart(3, "0")}-${file}.png`;
  await page.screenshot({ path: join(OUT, name), ...opts });
  manifest.push({ image: name, state: label });
  return name;
};

for (const s of states) {
  if (ONLY && !ONLY.test(s.name)) continue;
  for (const vpName of s.vps) {
    const phone = vpName === "phone";
    const o = await open(s.page, vpName, { variant: s.variant, scheme: s.scheme || "dark", storage: s.storage });
    const { page } = o;
    const base = `${s.name}-${vpName}`;
    const result = { state: base, label: s.label, images: [] };
    try {
      await settleImages(page);
      if (s.setup) await s.setup(page);
      if (s.weight && phone) weights[s.weight] = o.bytes();

      if (s.story) {
        await page.waitForSelector("#story:not([hidden])", { timeout: 5000 });
        const total = await page.evaluate(() => ST.cards.length);
        result.story = [];
        for (let i = 0; i < total; i++) {
          await page.evaluate((i) => { ST.i = i; showCard(); }, i);
          await page.waitForTimeout(250);
          await settleImages(page);
          const fit = await page.evaluate(() => {
            const st = document.getElementById("story"), c = document.getElementById("st-card");
            const over = [...st.querySelectorAll("*")].filter(e => { const r = e.getBoundingClientRect(); return r.height > 0 && (r.bottom > innerHeight + 1 || r.top < -1); }).map(e => e.tagName.toLowerCase() + (e.className ? "." + String(e.className).split(" ")[0] : ""));
            return { fits: st.scrollHeight <= innerHeight + 1 && c.scrollHeight <= c.clientHeight + 1 && !over.length, over: over.slice(0, 5), kicker: document.getElementById("st-title").textContent };
          });
          const m = await page.evaluate(measure, { phone, scope: "#story" });
          const img = await shot(page, `${base}-card${String(i + 1).padStart(2, "0")}`, `${s.label} ${i + 1} of ${total} ("${fit.kicker}"), ${vpName}`);
          result.images.push(img);
          result.story.push({ card: i + 1, fits: fit.fits, over: fit.over, ...m });
        }
      } else if (s.owlFlow) {
        // Answer the owl with the first offered choice until it stops asking (or 6 steps).
        for (let i = 1; i <= 6; i++) {
          await page.waitForTimeout(500);
          const img = await shot(page, `${base}-step${i}`, `${s.label} ${i}, ${vpName}`);
          result.images.push(img);
          const btn = await page.$("#choices button:not([disabled]), #opts button:not([disabled])");
          if (!btn) break;
          await btn.click();
          await page.waitForTimeout(700);
        }
        Object.assign(result, await page.evaluate(measure, { phone }));
      } else if (s.shareImage) {
        const url = await page.evaluate(() => { const c = drawShareCard(); return c.toDataURL("image/png"); });
        n++;
        const name = `${String(n).padStart(3, "0")}-${base}.png`;
        await writeFile(join(OUT, name), Buffer.from(url.split(",")[1], "base64"));
        manifest.push({ image: name, state: s.label });
        result.images.push(name);
      } else if (s.element) {
        // Gates first: a fullPage screenshot resets mobile touch emulation, so (pointer:coarse) stops
        // matching and the tap-target gate measured desktop sizes (round 1 artifact).
        Object.assign(result, await page.evaluate(measure, { phone }));
        const el = await page.$(s.element);
        if (el) { await el.scrollIntoViewIfNeeded(); result.images.push(await shot(page, base, `${s.label}, ${vpName}`, { clip: await el.boundingBox().then(b => ({ x: 0, y: b.y, width: VIEWPORTS[vpName].width, height: Math.min(b.height, 3000) })), fullPage: true })); }
      } else if (s.slices) {
        const H = VIEWPORTS[vpName].height;
        const start = s.sliceFromScroll ? await page.evaluate(() => scrollY) : 0;
        const total = await page.evaluate(() => document.documentElement.scrollHeight);
        const count = Math.min(s.maxSlices || 10, Math.ceil((total - start) / (H - 60)));
        for (let i = 0; i < count; i++) {
          await page.evaluate((y) => scrollTo(0, y), start + i * (H - 60));
          await page.waitForTimeout(250);
          await settleImages(page);
          result.images.push(await shot(page, `${base}-${String(i + 1).padStart(2, "0")}`, `${s.label}: screen ${i + 1} of ${count}, ${vpName}`));
        }
        Object.assign(result, await page.evaluate(measure, { phone }));
      } else {
        await page.waitForTimeout(300);
        result.images.push(await shot(page, base, `${s.label}, ${vpName}`));
        Object.assign(result, await page.evaluate(measure, { phone }));
      }
    } catch (e) {
      result.captureError = String(e.message).split("\n")[0];
    }
    result.errors = o.errors; result.failedRequests = o.failed; result.workerWrites = o.writes;
    gates.push(result);
    await o.ctx.close();
    process.stdout.write(".");
  }
}

// ─── Gate summary ──────────────────────────────────────────────────────────────────────────
const fails = [], warns = [];
for (const g of gates) {
  const f = (k, v) => fails.push(`${g.state}: ${k}: ${v}`);
  if (g.captureError) f("capture", g.captureError);
  g.errors.forEach(e => f("js error", e));
  g.failedRequests.forEach(e => f("failed request", e));
  g.workerWrites.forEach(e => f("worker write attempted", e));
  const one = (m, where = "") => {
    if (!m) return;
    if (m.overflowX) f("sideways scroll" + where, m.overflowX);
    m.clipped?.forEach(e => f("clipped text" + where, e));
    // Ellipsis on real data is a failure. In the HUGE state the titles are made absurdly long on
    // purpose, so a clean ellipsis there is a warning, not a failure (the critic judges how it looks).
    m.truncated?.forEach(e => (/-huge-/.test(g.state) ? warns : fails).push(`${g.state}: truncated text${where}: ${e}`));
    m.offscreen?.forEach(e => f("off screen" + where, e));
    m.badText?.forEach(e => f("bad text" + where, e));
    m.smallTargets?.forEach(e => f("tap target < 44px" + where, e));
  };
  one(g);
  g.story?.forEach(c => { if (!c.fits) f(`story card ${c.card} does not fit one screen`, c.over.join(", ")); one(c, ` (card ${c.card})`); });
}
for (const [pg, w] of Object.entries(weights)) {
  const b = WEIGHT_BUDGET[pg];
  if (b && w.localBytes > b) fails.push(`${pg}: page weight ${w.localBytes} bytes over budget ${b}`);
}
await writeFile(join(OUT, "manifest.json"), JSON.stringify(manifest, null, 2));
await writeFile(join(OUT, "gates.json"), JSON.stringify({ when: new Date().toISOString(), offline: OFFLINE, weights, budget: WEIGHT_BUDGET, fails, warns, states: gates }, null, 2));
// Dedupe repeated failures (the same element across slices/viewports) for the console.
const uniq = [...new Set(fails.map(x => x.replace(/^[^:]+-(phone|laptop): /, "")))];
console.log(`\n${manifest.length} images, ${gates.length} states -> ${OUT}`);
console.log(`warnings: ${warns.length}`);
console.log(`gates: ${fails.length ? `${fails.length} failures (${uniq.length} distinct)` : "all pass"}`);
uniq.slice(0, 80).forEach(x => console.log("  " + x));
await browser.close();
server.close();
process.exit(fails.length ? 1 : 0);
