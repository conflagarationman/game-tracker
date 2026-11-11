// Browser smoke test for the pages, which have no unit tests of their own. Drives index.html,
// add.html, owl.html and wrapped.html in headless Chromium against the real committed JSON.
//
// Nothing is written anywhere: the Worker is stubbed (every write is recorded, none is sent)
// and every off-site request except web fonts is aborted, so cover art takes its fallback path. That
// keeps the run deterministic and means a passing run can't have written to games.json.
//
//   npm i --no-save playwright@1.56.1 && npx playwright install chromium
//   node scripts/smoke.browser.mjs
//
// PLAYWRIGHT_MODULE overrides where playwright is imported from (e.g. a global install).
import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const TYPES = { ".webmanifest": "application/manifest+json", ".png": "image/png", ".html": "text/html", ".js": "text/javascript", ".json": "application/json", ".mjs": "text/javascript" };

// A counter the service-worker test reads: every request gets a new number, so a stale cached
// answer is detectable. Nothing in the pages asks for it.
let probeN = 0;
// "Offline" for the service-worker test: the server drops every connection. (Playwright's
// context.setOffline doesn't reliably reach a service worker's own fetches, so CI saw the network
// answer when the test expected a failure.)
let serverDown = false;
const server = http.createServer(async (req, res) => {
  if (serverDown) return req.destroy();
  if (new URL(req.url, "http://x").pathname === "/__probe.json") {
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    return res.end(JSON.stringify({ n: ++probeN }));
  }
  const path = normalize(decodeURIComponent(new URL(req.url, "http://x").pathname)).replace(/^([/\\])+/, "");
  try {
    const body = await readFile(join(ROOT, path || "index.html"));
    res.writeHead(200, { "Content-Type": TYPES[extname(path)] || "application/octet-stream" });
    res.end(body);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(r => server.listen(0, "127.0.0.1", r));
// A second origin (another port) standing in for the Worker, fonts, covers and the like.
let otherHits = 0;
const other = http.createServer((req, res) => {
  otherHits++;
  res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" });
  res.end('{"other":true}');
});
await new Promise(r => other.listen(0, "127.0.0.1", r));
const OTHER = `http://127.0.0.1:${other.address().port}`;
const BASE = `http://127.0.0.1:${server.address().port}`;

let pass = 0, fail = 0;
const test = async (name, fn) => {
  try { await fn(); pass++; console.log(`PASS  ${name}`); }
  catch (e) { fail++; console.log(`FAIL  ${name}\n        ${String(e.message).split("\n")[0]}`); }
};
const ok = (cond, msg) => { if (!cond) throw new Error(msg); };

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});

// A page with the Worker stubbed and the outside world cut off. Returns the page, the writes
// it attempted, and the uncaught errors it hit.
async function open(path, width, { clock = false, reducedMotion = "no-preference", init = null } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height: 900 }, hasTouch: width < 500, isMobile: width < 500, reducedMotion });
  const page = await ctx.newPage();
  const writes = [], errors = [];
  page.on("pageerror", e => errors.push(e.message));
  page.on("console", m => { if (m.type() === "error" && !/Failed to load resource|net::ERR/.test(m.text())) errors.push(m.text()); });
  page.on("dialog", d => { errors.push(`alert: ${d.message()}`); d.dismiss(); });
  await page.route("**/*", route => {
    const url = route.request().url();
    // Web fonts are let through on purpose: layout bugs depend on them. The phone header only
    // overflowed (455px on a 390px screen) once Syne had loaded; the fallback font fit.
    if (url.startsWith(BASE) || /^https:\/\/fonts\.(googleapis|gstatic)\.com\//.test(url)) return route.continue();
    if (/workers\.dev/.test(url)) {
      if (route.request().method() === "POST") writes.push({ path: new URL(url).pathname, body: JSON.parse(route.request().postData() || "{}") });
      return route.fulfill({ status: 200, contentType: "application/json", headers: { "Access-Control-Allow-Origin": "*" }, body: "[]" });
    }
    return route.abort();
  });
  if (init) await page.addInitScript(init);
  if (clock) await page.clock.install();
  await page.goto(BASE + "/" + path);
  return { page, writes, errors, ctx };
}

const noSideScroll = (page) => page.evaluate(async () => {
  await document.fonts.ready;
  return document.documentElement.scrollWidth <= window.innerWidth + 1;
});

// The installable shell: every page links the manifest and the Apple icon, the manifest points at
// icons that exist, and the service worker is network-first (never a cached copy while the network
// answers), keys its fallback without the ?_= cache-buster, and leaves other origins alone.

await test("PWA: every page links the manifest and icon; manifest and its icons load", async () => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  for (const f of ["index", "add", "owl", "wrapped"]) {
    await page.goto(`${BASE}/${f}.html`);
    ok(await page.locator('link[rel="manifest"][href="manifest.webmanifest"]').count() === 1, `${f}.html has no manifest link`);
    ok(await page.locator('link[rel="apple-touch-icon"]').count() === 1, `${f}.html has no apple-touch-icon`);
  }
  const m = await (await ctx.request.get(`${BASE}/manifest.webmanifest`)).json();
  ok(m.name === "Game Log" && m.display === "standalone", "manifest name/display");
  ok(/^#[0-9a-f]{6}$/i.test(m.theme_color) && /^#[0-9a-f]{6}$/i.test(m.background_color), "manifest colours");
  for (const sz of ["180x180", "192x192", "512x512"]) ok(m.icons.some(i => i.sizes === sz), `no ${sz} icon`);
  for (const i of m.icons) {
    const r = await ctx.request.get(`${BASE}/${i.src}`);
    ok(r.ok() && r.headers()["content-type"] === "image/png", `${i.src} didn't load as a PNG`);
  }
  ok(await page.evaluate(() => !navigator.serviceWorker.controller), "a local run must not register the worker by itself");
  await ctx.close();
});

await test("service worker: network-first, one cache entry per file, offline fallback, other origins untouched", async () => {
  const ctx = await browser.newContext({ serviceWorkers: "allow" });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/add.html`);
  await page.evaluate(async () => {
    await navigator.serviceWorker.register("sw.js");
    await navigator.serviceWorker.ready;
  });
  await page.reload();
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  const get = (u) => page.evaluate(async (u) => { try { const r = await fetch(u); return { ok: r.ok, text: await r.text() }; } catch (e) { return { err: String(e) }; } }, u);
  // Online: every answer is fresh, never a cached copy.
  const a = JSON.parse((await get("/__probe.json?_=1")).text).n;
  const b = JSON.parse((await get("/__probe.json?_=2")).text).n;
  ok(b === a + 1, `online answers must come from the network (got ${a} then ${b})`);
  await get("/games.json?_=111"); await get("/games.json?_=222"); await get("/games.json?_=333");
  const keys = await page.evaluate(async () => (await (await caches.open("gt-offline")).keys()).map(r => r.url));
  ok(keys.filter(u => u.includes("games.json")).length === 1, `one games.json entry expected, got ${keys.filter(u => u.includes("games.json")).length}`);
  ok(!keys.some(u => u.includes("?")), "no cache key may carry a query");
  // Offline: the last copy comes back, whatever cache-buster is asked for; other origins just fail.
  serverDown = true;
  const off = await get("/__probe.json?_=999");
  ok(!off.err && JSON.parse(off.text).n === b, `offline fallback should be the last copy (${b}), got ${JSON.stringify(off)}`);
  const g = await get("/games.json?_=never-seen");
  ok(!g.err && Array.isArray(JSON.parse(g.text)), "games.json should load offline under a new ?_=");
  const miss = await get("/never-fetched.json");
  ok(miss.err, "an uncached file offline must fail, not be invented");
  otherHits = 0;
  // Another origin keeps working while ours is down, goes straight to its own server, and is never cached.
  const far = await get(`${OTHER}/x.json`);
  ok(!far.err && otherHits === 1, `cross-origin request should pass straight through (hits ${otherHits}, ${JSON.stringify(far)})`);
  const farKeys = await page.evaluate(async () => (await (await caches.open("gt-offline")).keys()).map(r => r.url));
  ok(!farKeys.some(u => u.includes("x.json")), "a cross-origin response was cached");
  serverDown = false;
  await ctx.close();
});

for (const width of [390, 1280]) {
  await test(`index.html renders at ${width}px with no sideways scroll and no errors`, async () => {
    const { page, errors, ctx } = await open("index.html", width);
    await page.waitForSelector("#stats .stat-n");
    await page.waitForSelector("#tn-list .tn-row");
    ok(await noSideScroll(page), "page scrolls sideways");
    for (const id of ["now", "queue", "gotm-sec", "tonight-sec"])
      ok(await page.locator("#" + id).isVisible(), `#${id} not visible`);
    // Open every panel too: their contents only render once expanded.
    for (const k of ["so", "ar", "yl"]) await page.click(`#${k}-toggle`);
    ok(await noSideScroll(page), "page scrolls sideways with every panel open");
    ok(errors.length === 0, errors.join(" | "));
    await ctx.close();
  });
}

await test("picker: chips change the suggestions and Start writes s:playing", async () => {
  const { page, writes, errors, ctx } = await open("index.html", 1280);
  await page.waitForSelector("#tn-list .tn-row");
  const before = await page.locator("#tn-list").innerText();
  await page.click('#tn-time .chip:has-text("30 min")');
  ok(await page.locator('#tn-time .chip:has-text("30 min")').getAttribute("aria-pressed") === "true", "chip not pressed");
  const after = await page.locator("#tn-list").innerText();
  ok(before !== after, "changing the time changed nothing");
  await page.click('#tn-time .chip:has-text("Long haul")');
  const start = page.locator("#tn-list .tn-go").first();
  ok(await start.count() === 1, "no Start button on any suggestion");
  await start.click();
  await page.waitForTimeout(100);
  ok(writes.length === 1 && writes[0].path.endsWith("/games/edit") && writes[0].body.s === "playing" && writes[0].body.start,
    "Start sent " + JSON.stringify(writes));
  ok(errors.length === 0, errors.join(" | "));
  await ctx.close();
});

await test("a save survives a reload before Pages publishes it, and stands aside once stale", async () => {
  // games.json here never changes, exactly like the minute before Pages republishes.
  const { page, writes, errors, ctx } = await open("index.html", 1280);
  await page.waitForSelector("#tn-list .tn-row");
  await page.click('#tn-time .chip:has-text("Long haul")');
  await page.locator("#tn-list .tn-go").first().click();
  await page.waitForTimeout(100);
  const id = writes.at(-1).body.id;
  const status = () => page.evaluate(id => G.find(g => g.id === id).s, id);
  ok(await status() === "playing", "Start didn't apply");
  await page.reload(); await page.waitForSelector("#tn-list .tn-row");
  ok(await status() === "playing", "the started game reverted on reload");
  // Ten minutes on with the file still unchanged, the published copy wins again.
  await page.evaluate(() => { const l = JSON.parse(localStorage.getItem("gt_saved_edits")); l.forEach(e => e.ts -= 11*60*1000); localStorage.setItem("gt_saved_edits", JSON.stringify(l)); });
  await page.reload(); await page.waitForSelector("#tn-list .tn-row");
  ok(await status() !== "playing", "an expired save still overrode games.json");
  ok(await page.evaluate(() => localStorage.getItem("gt_saved_edits")) === null, "expired save wasn't cleared");
  ok(errors.length === 0, errors.join(" | "));
  await ctx.close();
});

await test("someday triage: keep, up next, and remove-with-undo", async () => {
  const { page, writes, errors, ctx } = await open("index.html", 390, { clock: true });
  await page.waitForSelector("#tn-list .tn-row");
  await page.click("#so-toggle");
  await page.click('#so-actions .mini-btn');
  ok(await page.locator("#sheet").isVisible(), "triage sheet did not open");
  const kicker = () => page.locator("#sheet-kicker").textContent();
  ok(/1 of \d+/.test(await kicker()), "no progress counter: " + await kicker());
  await page.click('#sheet .sh-btn:has-text("Keep in Someday")');
  ok(/2 of/.test(await kicker()), "Keep didn't advance");
  ok(writes.length === 0, "Keep wrote something");
  await page.click('#sheet .sh-btn:has-text("Up Next")');
  ok(/3 of/.test(await kicker()), "Up Next didn't advance");
  for (let i = 0; i < 20 && !writes.some(w => w.path.endsWith("/games/reorder")); i++) await page.waitForTimeout(50);
  const promoted = writes.find(w => w.body.s === "queue");
  const reorder = writes.find(w => w.path.endsWith("/games/reorder"));
  ok(promoted, "Up Next sent nothing");
  ok(reorder && reorder.body.ids.at(-1) === promoted.body.id, "promoted game wasn't moved to the bottom of Up Next: " + JSON.stringify(reorder));
  await page.click('#sheet .sh-btn:has-text("Remove")');
  await page.click('#toast button:has-text("Undo")');
  await page.clock.fastForward(8000);
  ok(!writes.some(w => w.path.endsWith("/games/delete")), "an undone remove was still sent");
  await page.click('#sheet .sh-btn:has-text("Remove")');
  await page.clock.fastForward(8000);
  for (let i = 0; i < 20 && !writes.some(w => w.path.endsWith("/games/delete")); i++) await page.waitForTimeout(50);
  ok(writes.some(w => w.path.endsWith("/games/delete")), "remove was never sent");
  await page.keyboard.press("Escape");
  ok(!(await page.locator("#sheet").isVisible()), "Escape didn't close the sheet");
  ok(errors.length === 0, errors.join(" | "));
  await ctx.close();
});

// Someday and Archive each get a search box: title, genre and platform, case-insensitive,
// diacritics folded, and the Archive's year groups vanish when nothing in them matches.
for (const width of [390, 1280]) {
  await test(`panel search at ${width}px: Someday and Archive filter by title, genre and platform`, async () => {
    const games = JSON.parse(await readFile(join(ROOT, "games.json"), "utf8"));
    const someday = games.filter(g => g.s === "soon"), arch = games.filter(g => g.s === "done" || g.s === "dropped");
    const { page, errors, ctx } = await open("index.html", width);
    await page.waitForSelector("#tn-list .tn-row");
    // Someday
    ok(!(await page.locator("#so-search").isVisible()), "Someday search shows before the panel opens");
    await page.click("#so-toggle");
    ok(await page.locator("#so-search").isVisible(), "Someday search isn't visible in the open panel");
    const n0 = await page.locator("#soon .card").count();
    ok(n0 === someday.length, `Someday shows ${n0} cards, data has ${someday.length}`);
    const pick = someday.find(g => g.g && /[a-z]/i.test(g.g)) || someday[0];
    const word = pick.t.split(/\s+/).find(w => w.length > 3) || pick.t;
    await page.fill("#so-search", word.toUpperCase());
    const byTitle = await page.locator("#soon .card").count();
    ok(byTitle >= 1 && byTitle <= n0, "title search found nothing");
    ok(await page.locator("#soon").innerText().then(t => t.toLowerCase().includes(word.toLowerCase())), "result doesn't contain the searched word");
    await page.fill("#so-search", pick.g);
    const byGenre = await page.locator("#soon .card").count();
    ok(byGenre >= 1 && byGenre === someday.filter(g => (g.g || "").toLowerCase().includes(pick.g.toLowerCase())).length, `genre search count ${byGenre}`);
    await page.fill("#so-search", "qzxjv no such game");
    ok(await page.locator("#soon .empty").isVisible() && await page.locator("#soon .card").count() === 0, "no-match state missing");
    await page.fill("#so-search", "");
    ok(await page.locator("#soon .card").count() === n0, "clearing the search didn't restore Someday");
    ok(/Someday \(\d+\)/i.test(await page.locator("#so-lbl").innerText()), "label should show the plain count with no search");
    // Triage still works from the full list while a filter is typed
    await page.fill("#so-search", "qzxjv");
    if (width === 390) {
      await page.click("#so-actions .mini-btn");
      ok(await page.locator("#sheet").isVisible(), "triage sheet didn't open with a filter active");
      await page.keyboard.press("Escape");
    }
    await page.fill("#so-search", "");
    // Archive
    await page.click("#ar-toggle");
    ok(await page.locator("#ar-search").isVisible(), "Archive search isn't visible in the open panel");
    const groups0 = await page.locator("#ar-list .mg").count();
    const titled = arch.find(g => g.t) ;
    await page.fill("#ar-search", titled.t.slice(0, 5).toUpperCase());
    const g1 = await page.locator("#ar-list .mg").count();
    ok(g1 >= 1 && g1 <= groups0, "archive title search");
    const withAccent = arch.find(g => /[\u00c0-\u024f]/.test(g.t));
    if (withAccent) {
      const plain = withAccent.t.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
      await page.fill("#ar-search", plain.toLowerCase());
      ok((await page.locator("#ar-list").innerText()).includes(withAccent.t), `diacritics weren't folded for ${withAccent.t}`);
    }
    const plat = arch[0].p;
    await page.fill("#ar-search", plat);
    const hits = await page.locator("#ar-list .mg").count();
    ok(hits >= 1, "archive platform search found nothing");
    // every visible group has a game: empty groups are hidden
    ok(await page.locator("#ar-list .mg").evaluateAll(els => els.every(e => e.querySelectorAll(".mg-g, .ag, .gi, [class*=row], .card, div").length > 1)), "an empty group is showing");
    await page.fill("#ar-search", "qzxjv no such game");
    ok(await page.locator("#ar-list .mg").count() === 0 && await page.locator("#ar-list .empty").isVisible(), "archive no-match state");
    await page.fill("#ar-search", "");
    ok(await page.locator("#ar-list .mg").count() === groups0, "clearing the archive search didn't restore the groups");
    ok(await noSideScroll(page), "page scrolls sideways");
    ok(errors.length === 0, errors.join(" | "));
    await ctx.close();
  });
}

// Reduced motion: nothing on any page keeps moving, hover doesn't shift a card, and the
// content is still there. (The Heart Piece, Great Fairy and Hestu moments have their own tests.)
for (const path of ["index.html", "add.html", "owl.html", "wrapped.html"]) {
  await test(`${path}: reduced motion leaves no animation running`, async () => {
    const { page, errors, ctx } = await open(path, 390, { reducedMotion: "reduce" });
    await page.waitForTimeout(1200);
    const running = await page.evaluate(() => document.getAnimations().filter(a => a.playState === "running").map(a => a.animationName || a.transitionProperty || a.constructor.name));
    ok(running.length === 0, `still animating: ${[...new Set(running)].join(", ")}`);
    ok(errors.length === 0, errors.join(" | "));
    await ctx.close();
  });
}
await test("index.html: reduced motion keeps card hover from moving the card", async () => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: "reduce" });
  const page = await ctx.newPage();
  await page.route("**/*", r => r.request().url().startsWith(BASE) ? r.continue() : r.abort());
  await page.goto(BASE + "/index.html");
  await page.waitForSelector("#queue .card");
  await page.hover("#queue .card");
  ok(await page.locator("#queue .card").first().evaluate(e => getComputedStyle(e).transform) === "none", "card moved on hover");
  await ctx.close();
});

await test("fill-in finished games: picking a year and rating sends cy/cm/r", async () => {
  const { page, writes, errors, ctx } = await open("index.html", 390);
  await page.waitForSelector("#tn-list .tn-row");
  await page.click("#ar-toggle");
  const btn = page.locator('#ar-actions .mini-btn');
  ok(await btn.count() === 1, "no Fill in button (are there still finished games missing data?)");
  await btn.click();
  // A game released this year offers just one year chip (e.g. Digseum, 2026), so only pick the
  // second, non-default chip when there is one.
  const chips = page.locator("#fin-y .chip");
  await chips.first().waitFor();
  const y = chips.nth((await chips.count()) > 1 ? 1 : 0);
  const year = Number(await y.textContent());
  await y.click();
  await page.selectOption("#fin-m", "3");
  if (await page.locator("#fin-r").count()) await page.click('#fin-r .chip:has-text("8")');
  await page.click("#fin-save");
  const w = writes.at(-1);
  ok(w && w.body.cy === year && w.body.cm === 3, "sent " + JSON.stringify(w));
  ok(errors.length === 0, errors.join(" | "));
  await ctx.close();
});

await test("play check: Playing writes s:playing; ✕ hides the row and survives a reload", async () => {
  const { page, writes, errors, ctx } = await open("index.html", 1280);
  await page.waitForSelector("#tn-list .tn-row");
  const items = page.locator("#play-check .pc-item");
  const n = await items.count();
  if (n === 0) { await ctx.close(); return; }            // nothing to check today; not a failure
  const goBtn = page.locator('#play-check button.pc-btn.go').first();
  let started = 0;
  if (await goBtn.count()) {
    await goBtn.click();
    ok(writes.at(-1).body.s === "playing", "sent " + JSON.stringify(writes.at(-1)));
    started = 1;
  }
  const left = await items.count();
  if (left) {
    await page.locator("#play-check .pc-btn.x").first().click();
    ok(await items.count() === left - 1, "✕ didn't hide the row");
    await page.reload();
    await page.waitForSelector("#tn-list .tn-row");
    // The stubbed Worker answers 200, so a game "started" above is remembered as saved and
    // stays started across the reload, and the hidden row stays gone.
    ok(await page.locator("#play-check .pc-item").count() === n - 1 - started, "a row came back after reload");
  }
  ok(errors.length === 0, errors.join(" | "));
  await ctx.close();
});

await test("add.html: ?s=playing&p=retro prefills a new playing game from today", async () => {
  const { page, errors, ctx } = await open("add.html?t=Yoshi%27s%20Story&s=playing&p=retro", 390);
  await page.waitForFunction(() => document.getElementById("t").value === "Yoshi's Story");
  ok(await page.inputValue("#s") === "playing", "status not prefilled");
  ok(await page.inputValue("#p") === "retro", "platform not prefilled");
  ok(/^\d{4}-\d{2}-\d{2}$/.test(await page.inputValue("#start")), "start not set");
  ok(await noSideScroll(page), "add.html scrolls sideways");
  ok(errors.length === 0, errors.join(" | "));
  await ctx.close();
});

for (const width of [390, 1280]) {
  await test(`owl.html at ${width}px: three answers, Yes rerolls, No starts the game`, async () => {
    // Reduced motion skips the typewriter, so every line lands at once.
    const { page, writes, errors, ctx } = await open("owl.html", width, { reducedMotion: "reduce" });
    const answer = async () => { const b = page.locator(".choice:not([disabled])").first(); await b.waitFor(); await b.click(); };
    await answer(); await answer(); await answer();               // device, time, mood
    await page.waitForSelector("#pick.show");
    ok(await page.locator("#count").innerText() !== "", "no pick counter");
    const first = await page.locator(".pick-title").innerText();
    await page.locator('.opt:has-text("Yes"):not([disabled])').click();
    await page.waitForFunction(() => /^2 of|^1 of 1$/.test(document.getElementById("count").textContent));
    const total = await page.locator("#count").innerText();
    if (!/of 1$/.test(total)) ok(await page.locator(".pick-title").innerText() !== first, "Yes didn't change the pick");
    await page.locator(".opt:not([disabled])", { hasText: /^No$/ }).click();
    await page.waitForFunction(() => /off you go/i.test(document.getElementById("text").textContent));
    // "No" starts a tracked game (/games/edit) or adds a wildcard as Now Playing (/games/add).
    ok(writes.every(w => /\/games\/(edit|add)$/.test(w.path) && w.body.s === "playing" && w.body.start), "No sent " + JSON.stringify(writes));
    ok(writes.length <= 1, "more than one write");
    ok(await noSideScroll(page), "page scrolls sideways");
    ok(errors.length === 0, errors.join(" | "));
    await ctx.close();
  });
}

for (const width of [390, 1280]) {
  await test(`owl.html at ${width}px: Not this one snoozes, the fourth asks before dropping, and Restore undoes it`, async () => {
    const { page, writes, errors, ctx } = await open("owl.html", width, { reducedMotion: "reduce" });
    const answer = async () => { const b = page.locator(".choice:not([disabled])").first(); await b.waitFor(); await b.click(); };
    await answer(); await answer(); await answer();
    await page.waitForSelector("#pick.show");
    const notThis = () => page.locator('.opt:has-text("Not this one"):not([disabled])').click();
    const asked = () => page.waitForFunction(() => document.querySelectorAll(".opt").length === 3 && !document.getElementById("box").classList.contains("danger"));
    await asked();
    const first = await page.locator(".pick-title").innerText();
    await notThis();
    await page.waitForFunction(t => document.querySelector(".pick-title").textContent !== t && document.querySelectorAll(".opt").length === 3, first);
    ok(writes.length === 1 && writes[0].path.endsWith("/owl/skip") && writes[0].body.drop === false && writes[0].body.key, "first turn-down wrote " + JSON.stringify(writes));
    ok(!writes.some(w => /\/games\//.test(w.path)), "a snooze touched the tracker");
    // Pretend the game now showing has been turned down three times already: the fourth asks.
    await asked();
    const key = await page.evaluate(() => { const p = PICKS[AT]; SKIPS = { ...SKIPS, [p.key]: { t: p.t, count: 3, until: null, dropped: false, last: "2026-01-01" } }; return p.key; });
    await notThis();
    await page.waitForFunction(() => document.getElementById("box").classList.contains("danger"));
    const warn = await page.locator("#said").innerText();
    ok(/four times/.test(warn) && /for good/.test(warn), "no DROP warning: " + warn);
    ok(await page.locator(".opt").first().innerText() === "Just snooze it", "the safe answer isn't first");
    ok(writes.length === 1, "the warning wrote before an answer");
    await page.locator('.opt:has-text("Drop it")').click();
    await page.waitForSelector("#struck-link:not([hidden])");
    const drop = writes[writes.length - 1];
    ok(drop.path.endsWith("/owl/skip") && drop.body.drop === true && drop.body.key === key, "drop wrote " + JSON.stringify(drop));
    ok(/\(1\)/.test(await page.locator("#struck-link").innerText()), "footer link didn't count the drop");
    if (await page.locator('.opt:has-text("Move it to Someday")').count()) await page.locator('.opt:has-text("No, leave it")').click();
    await page.locator("#struck-link").click();
    ok(await noSideScroll(page), "page scrolls sideways with the struck list open");
    await page.locator("#struck .restore").click();
    await page.waitForSelector("#struck-link", { state: "hidden" });
    ok(writes[writes.length - 1].path.endsWith("/owl/restore") && writes[writes.length - 1].body.key === key, "restore wrote " + JSON.stringify(writes[writes.length - 1]));
    ok(await page.evaluate(k => !(k in SKIPS), key), "restored game still has an entry");
    ok(errors.length === 0, errors.join(" | "));
    await ctx.close();
  });
}

for (const width of [390, 1280]) {
  await test(`owl.html at ${width}px: text blips and the hoot play after a tap, and stop when 🔈 is off`, async () => {
    const { page, errors, ctx } = await open("owl.html", width, { init: () => {
      // A stand-in for Web Audio that only counts the tones asked of it: headless Chromium
      // plays nothing anyway, and the count is what says whether the owl is making sound.
      window.__tones = 0;
      const param = { value: 0, setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} };
      const node = () => ({ gain: { ...param }, frequency: { ...param }, connect: (x) => x, start() {}, stop() {} });
      window.AudioContext = class {
        constructor() { this.currentTime = 0; this.state = "running"; this.destination = {}; }
        resume() { return Promise.resolve(); }
        createGain() { return node(); }
        createOscillator() { window.__tones++; return node(); }
      };
    } });
    const tones = () => page.evaluate(() => window.__tones);
    ok(await tones() === 0, "sound before any tap");
    await page.locator(".choice:not([disabled])").first().waitFor();
    await page.locator(".choice:not([disabled])").first().click();      // the first tap wakes the audio
    await page.waitForFunction(() => window.__tones >= 3);               // a hoot (2 tones) and a blip
    ok(await page.locator("#sfx").getAttribute("aria-pressed") === "true", "🔈 not on by default");
    await page.locator("#sfx").click();
    ok(await page.locator("#sfx").getAttribute("aria-pressed") === "false", "🔈 didn't switch off");
    ok(await page.evaluate(() => localStorage.getItem("gt_owl_sfx")) === "0", "the choice wasn't remembered");
    const quiet = await tones();
    await page.locator(".choice:not([disabled])").first().click();      // the next question, typed out in silence
    await page.waitForFunction(() => document.getElementById("box").classList.contains("done") && document.querySelectorAll(".choice").length > 0);
    ok(await tones() === quiet, "sound after switching it off");
    await page.locator("#sfx").click();                                  // back on: a hoot to say so
    await page.waitForFunction(n => window.__tones > n, quiet);
    ok(await noSideScroll(page), "page scrolls sideways with both toggles");
    // Syne's wide title once ran under the buttons on a phone without making the page scroll.
    ok(await page.evaluate(async () => {
      await document.fonts.ready;
      const r = document.createRange(); r.selectNodeContents(document.querySelector("h1"));
      return r.getBoundingClientRect().right <= document.querySelector(".tools").getBoundingClientRect().left;
    }), "the title runs under the sound and music buttons");
    ok(errors.length === 0, errors.join(" | "));
    await ctx.close();
  });
}

for (const width of [390, 1280]) {
  await test(`owl.html?pick= at ${width}px opens on the weekend pick, and a key that's gone falls back to the questions`, async () => {
    const games = JSON.parse(await readFile(join(ROOT, "games.json"), "utf8"));
    const want = games.find(g => g.s === "queue" && !g.release);
    const { page, writes, errors, ctx } = await open(`owl.html?pick=${encodeURIComponent("id:" + want.id)}`, width, { reducedMotion: "reduce" });
    await page.waitForSelector("#pick.show");
    ok(await page.locator(".pick-title").innerText() === want.t, "opened on " + await page.locator(".pick-title").innerText());
    await page.waitForFunction(() => document.querySelectorAll(".opt").length === 3);
    ok(await page.evaluate(() => /weekend/.test(document.getElementById("said").textContent) || document.getElementById("count").textContent.startsWith("1 of")), "no weekend greeting");
    ok(writes.length === 0, "opening the link wrote something");
    ok(await noSideScroll(page), "page scrolls sideways");
    ok(errors.length === 0, errors.join(" | "));
    await ctx.close();
    const gone = await open("owl.html?pick=id%3A99999999", width, { reducedMotion: "reduce" });
    await gone.page.waitForSelector(".choice");
    ok(await gone.page.locator("#pick.show").count() === 0, "a missing game was shown");
    ok(gone.errors.length === 0, gone.errors.join(" | "));
    await gone.ctx.close();
  });
}

for (const width of [390, 1280]) {
  await test(`wrapped.html renders at ${width}px and draws a share image`, async () => {
    const { page, errors, ctx } = await open("wrapped.html", width);
    await page.waitForSelector("#wr-hero .wr-big");
    ok(await noSideScroll(page), "page scrolls sideways");
    for (const sel of [".persona-t", "#h-hours", "#h-eras", ".standouts li", "#h-how", "#h-ach", "#h-asf"])
      ok(await page.locator(sel).count() > 0, `${sel} missing`);
    const png = await page.evaluate(() => drawShareCard().toDataURL("image/png").length);
    ok(png > 20000, `share image looks empty (${png} bytes)`);
    ok(errors.length === 0, errors.join(" | "));
    await ctx.close();
  });
}

for (const path of ["index.html", "add.html", "owl.html", "wrapped.html"]) {
  await test(`${path}: the hidden Koroks say Yahaha, count once, and work from the keyboard`, async () => {
    const { page, errors, ctx } = await open(path, 390);
    await page.waitForSelector(".korok-btn", { state: "attached" });
    // usage.js is on every page, and a local or CI run never counts as live use
    ok(await page.evaluate(() => typeof TrackerUsage === "object" && TrackerUsage.pageOf(location.pathname) in TrackerUsage.SECTIONS), "usage.js not loaded");
    ok(await page.evaluate(() => location.hostname !== TrackerUsage.LIVE_HOST), "a test run would count as live use");
    ok(await page.locator(".korok-btn").count() >= 2, "expected 2+ Koroks on the page");
    ok(await page.getAttribute(".korok-btn", "aria-label"), "Korok has no aria-label");
    ok(await page.locator("#korok-foot").isHidden(), "seed counter shows before the first find");
    await page.focus(".korok-btn"); await page.keyboard.press("Enter");
    const first = await page.textContent("#korok-say");
    ok(/Yahaha! You found me!/.test(first) && /\(1\/12 Koroks found\)/.test(first), first);
    ok(/Seeds: 1\/12/.test(await page.textContent("#korok-foot")), "counter should read Seeds: 1/12");
    await page.click(".korok-btn");
    ok(/again/.test(await page.textContent("#korok-say")), "a second tap should not recount");
    ok(await noSideScroll(page), "page scrolls sideways");
    ok(errors.length === 0, errors.join(" | "));
    await ctx.close();
  });
}

// Hestu: stub storage with 2 seeds already found (and the old per-repo key to migrate), find a
// third, and he dances. Six seeds unlock the Forest toggle. Reduced motion stops the animation.
for (const path of ["index.html", "owl.html"]) {
  await test(`${path}: Hestu dances at 3 seeds, 6 unlock the Korok Forest, reduced motion holds still`, async () => {
    const init = () => { localStorage.setItem("korok:game-tracker", '["add","wrapped"]'); };
    const { page, errors, ctx } = await open(path, 390, { init, reducedMotion: "reduce" });
    await page.waitForSelector(".korok-btn", { state: "attached" });
    ok(await page.evaluate(() => JSON.parse(localStorage.getItem("korok:all")).join()) === "game-tracker/add,game-tracker/wrapped", "legacy key not migrated");
    await page.locator(".korok-btn").first().click();
    await page.waitForSelector("#korok-hestu:not([hidden])");
    ok(/Shaka-laka/.test(await page.textContent("#korok-hestu")), "Hestu's line missing");
    ok(await page.evaluate(() => getComputedStyle(document.querySelector("#korok-hestu .hs-body")).animationName) === "none", "dance should stop under reduced motion");
    ok(await noSideScroll(page), "page scrolls sideways with Hestu out");
    ok(await page.locator("#korok-forest-btn").isHidden(), "forest unlocks at 6, not 3");
    await page.evaluate(() => localStorage.setItem("korok:all", JSON.stringify(["a/1", "a/2", "a/3", "a/4", "a/5"])));
    await page.reload(); await page.waitForSelector(".korok-btn", { state: "attached" });
    await page.locator(".korok-btn").first().click();
    await page.waitForSelector("#korok-forest-btn:not([hidden])");
    await page.click("#korok-forest-btn");
    ok(await page.evaluate(() => document.documentElement.classList.contains("korok-forest")), "forest theme not applied");
    ok(await page.evaluate(() => getComputedStyle(document.body).backgroundColor) === "rgb(14, 47, 18)", "forest background not the leaf green (and distinct from the base #14261a)");
    await page.reload();
    ok(await page.evaluate(() => document.documentElement.classList.contains("korok-forest")), "forest theme should persist");
    ok(errors.length === 0, errors.join(" | "));
    await ctx.close();
  });
}

for (const width of [390, 1280]) {
  await test(`wrapped.html poster at ${width}px draws, exports a 3600x4800 PNG and prints on its own`, async () => {
    const { page, errors, ctx } = await open("wrapped.html?year=2026", width);
    await page.waitForSelector("#poster-canvas");
    await page.evaluate(() => document.fonts.ready);
    ok(await noSideScroll(page), "page scrolls sideways");
    const drawn = await page.evaluate(() => document.getElementById("poster-canvas").toDataURL("image/png").length);
    ok(drawn > 50000, `poster preview looks empty (${drawn} bytes)`);
    const [download] = await Promise.all([page.waitForEvent("download"), page.click("text=Download poster")]);
    ok(/^year-of-play-\d{4}\.png$/.test(download.suggestedFilename()), `odd filename ${download.suggestedFilename()}`);
    const { readFile: rf } = await import("node:fs/promises");
    const png = await rf(await download.path());
    ok(png.readUInt32BE(16) === 3600 && png.readUInt32BE(20) === 4800, `export is ${png.readUInt32BE(16)}x${png.readUInt32BE(20)}, not 3600x4800`);
    // Print: everything but the poster is hidden. (visibility, so check the computed style.)
    await page.emulateMedia({ media: "print" });
    const vis = await page.evaluate(() => [getComputedStyle(document.getElementById("wr-hero")).visibility, getComputedStyle(document.getElementById("poster-canvas")).visibility]);
    ok(vis[0] === "hidden" && vis[1] === "visible", `print visibility ${vis}`);
    ok(errors.length === 0, errors.join(" | "));
    await ctx.close();
  });
}

// Heart Containers: a first visit seeds silently, a higher count plays the moment once, and a
// reduced-motion visitor still gets the text.
for (const width of [390, 1280]) {
  await test(`hearts at ${width}px: header meter, silent first visit, one celebration per new finish`, async () => {
    const { page, errors, ctx } = await open("index.html", width);
    await page.waitForSelector("#hearts svg");
    ok(await page.locator("#hearts svg").count() > 1, "no hearts drawn");
    ok(/Heart Container/.test(await page.getAttribute("#hearts", "title")), "no tooltip title");
    ok(await page.locator("#hp-banner").count() === 0, "celebrated on a first-ever visit");
    ok(await noSideScroll(page), "sideways scroll");
    await page.click("#hearts");
    ok(await page.locator("#hearts-tip.show").count() === 1, "tap did not show the tip");
    const done = await page.evaluate(() => GTHearts.countDone(G));
    await page.evaluate(n => localStorage.setItem("gt_hearts_seen", String(n - 1)), done);
    await page.reload();
    await page.waitForSelector("#hp-banner");
    await page.reload();
    await page.waitForSelector("#hearts svg");
    ok(await page.locator("#hp-banner").count() === 0, "celebrated twice for one finish");
    ok(errors.length === 0, errors.join(" | "));
    await ctx.close();
  });
}

await test("hearts: a finish that completes a container is the big banner; reduced motion still shows it", async () => {
  const { page, errors, ctx } = await open("index.html", 390, { reducedMotion: "reduce" });
  await page.waitForSelector("#hearts svg");
  const done = await page.evaluate(() => GTHearts.countDone(G));
  // Last seen = one short of the current container's first piece, so this visit crosses it.
  await page.evaluate(n => localStorage.setItem("gt_hearts_seen", String(Math.floor(n / 4) * 4 - 1)), done);
  await page.reload();
  await page.waitForSelector("#hp-banner");
  ok(await page.locator("#hp-banner.big").count() === 1, "completing a container should be the big banner");
  ok(/Heart/.test(await page.locator("#hp-banner").innerText()), "banner has no text");
  ok(errors.length === 0, errors.join(" | "));
  await ctx.close();
});

// Dropped games live in the Archive (the graveyard that once held them is gone).
await test("archive: dropped games are listed with the finished ones, and the count includes them", async () => {
  const { page, errors, ctx } = await open("index.html", 1280);
  await page.waitForSelector("#stats .stat-n");
  const [n, t] = await page.evaluate(() => { const d = G.filter(g => g.s === "dropped"); return [G.filter(g => g.s === "done" || g.s === "dropped").length, d[0] && d[0].t]; });
  ok(t, "fixture has no dropped games");
  ok((await page.locator("#ar-lbl").innerText()).includes(`(${n})`), "archive count should include dropped games");
  await page.click("#ar-toggle");
  ok((await page.locator("#ar-list").innerText()).includes(t), `dropped game ${t} missing from the Archive`);
  ok(await page.locator("#gy-toggle, #gy-panel, .gy-stone").count() === 0, "graveyard leftovers in the page");
  ok(errors.length === 0, errors.join(" | "));
  await ctx.close();
});

for (const width of [390, 1280]) {
  await test(`wallet at ${width}px: lifetime rupees and tier in the header, honest tooltip, not a button, no sideways scroll`, async () => {
    const { page, errors, ctx } = await open("index.html", width);
    await page.waitForSelector("#wallet:not([style*='none'])");
    ok(/\d+/.test(await page.locator("#wallet").innerText()), "no total");
    const tip = await page.getAttribute("#wallet", "title");
    ok(/earned/i.test(tip) && /Wallet/.test(tip), "tooltip should say these are lifetime earnings: " + tip);
    ok(await page.evaluate(() => document.getElementById("wallet").tagName !== "BUTTON"), "wallet still looks like a button");
    ok(await noSideScroll(page), "sideways scroll");
    await page.click("#wallet");
    ok(await page.locator("dialog[open]").count() === 0, "clicking the wallet opened something");
    ok(await page.locator("#shop, .shop-btn, #worn-mask").count() === 0, "shop leftovers in the page");
    ok(errors.length === 0, errors.join(" | "));
    await ctx.close();
  });
}

for (const width of [390, 1280]) {
  await test(`leftover shop state at ${width}px: a worn skin and mask change nothing and are cleared`, async () => {
    const init = () => {
      // Runs before every page script, on every load, exactly like a browser that bought things once.
      localStorage.setItem("korok:all", JSON.stringify(["a/1", "a/2", "a/3", "a/4", "a/5", "a/6"]));
      localStorage.setItem("korok:all:forest", "1");
      localStorage.setItem("korok:all:skin", "autumn");
      localStorage.setItem("gt_mask", "bunny");
    };
    for (const file of ["index.html", "owl.html", "add.html", "wrapped.html"]) {
      const { page, errors, ctx } = await open(file, width, { init });
      await page.waitForTimeout(400);
      const r = await page.evaluate(() => ({ cls: document.documentElement.className, skin: localStorage.getItem("korok:all:skin"), mask: localStorage.getItem("gt_mask") }));
      ok(/korok-forest/.test(r.cls), `${file}: the Korok Forest itself should still work: ${r.cls}`);
      ok(!/korok-skin/.test(r.cls), `${file}: a skin class is on <html>: ${r.cls}`);
      ok(r.skin === null && r.mask === null, `${file}: leftover keys not cleared ${JSON.stringify(r)}`);
      ok(errors.length === 0, `${file}: ` + errors.join(" | "));
      await ctx.close();
    }
  });
}

await test("owl: the mood question offers the three moods and suggests none (a worn mask no longer matters)", async () => {
  const { page, errors, ctx } = await open("owl.html", 390, { init: () => localStorage.setItem("gt_mask", "bunny") });
  for (let i = 0; i < 2; i++) { await page.locator("#choices .choice").first().click(); await page.waitForSelector("#choices .choice:not([disabled])"); }
  await page.waitForSelector("#choices .choice");
  ok(await page.locator("#choices .choice").count() === 3, "three moods expected");
  ok(await page.locator("#choices .choice.suggested, #choices .choice small").count() === 0, "a mood is suggested");
  ok(await page.evaluate(() => document.activeElement === document.body || !document.activeElement.classList.contains("choice")), "a mood button was auto-focused");
  ok(await noSideScroll(page), "sideways scroll");
  ok(errors.length === 0, errors.join(" | "));
  await ctx.close();
});

await test("Great Fairy: a first visit is silent, a new mastery plays once and can be skipped, mastered cards are gold", async () => {
  const { page, errors, ctx } = await open("index.html", 390);
  await page.waitForSelector("#wallet:not([style*='none'])");
  ok(await page.locator("#gf").count() === 0, "played on a first visit");
  const m = await page.evaluate(() => G.filter(g => GTRupees.isMastered(g)).length);
  ok(m > 0, "fixture has no mastered game");
  await page.evaluate(() => { if (!open.ar) tog("ar"); });
  ok(await page.locator("#ar-list .gf-gold").count() > 0, "no gold frames on mastered cards in the Archive");
  await page.evaluate(() => { const seen = JSON.parse(localStorage.getItem("gt_gf_seen")); seen.pop(); localStorage.setItem("gt_gf_seen", JSON.stringify(seen)); });
  await page.reload();
  await page.waitForSelector("#gf");
  ok(await noSideScroll(page), "sideways scroll");
  await page.click("#gf-skip");
  ok(await page.locator("#gf").count() === 0, "skip did not close it");
  await page.reload();
  await page.waitForSelector("#wallet:not([style*='none'])");
  await page.waitForTimeout(500);
  ok(await page.locator("#gf").count() === 0, "played twice");
  ok(errors.length === 0, errors.join(" | "));
  await ctx.close();
});

await test("Great Fairy: Esc skips it, and reduced motion still shows the scene", async () => {
  const { page, ctx } = await open("index.html", 1280, { reducedMotion: "reduce" });
  await page.waitForSelector("#wallet:not([style*='none'])");
  await page.evaluate(() => { const seen = JSON.parse(localStorage.getItem("gt_gf_seen")); seen.pop(); localStorage.setItem("gt_gf_seen", JSON.stringify(seen)); });
  await page.reload();
  await page.waitForSelector("#gf");
  ok(await page.evaluate(() => getComputedStyle(document.getElementById("gf")).animationName) === "none", "animating under reduced motion");
  await page.keyboard.press("Escape");
  ok(await page.locator("#gf").count() === 0, "Esc did not close it");
  await ctx.close();
});

await browser.close();
server.close();
other.close();
console.log(`\n${pass}/${pass + fail} passing`);
process.exit(fail ? 1 : 0);
