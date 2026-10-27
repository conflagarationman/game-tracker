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
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".json": "application/json", ".mjs": "text/javascript" };

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

await test("fill-in finished games: picking a year and rating sends cy/cm/r", async () => {
  const { page, writes, errors, ctx } = await open("index.html", 390);
  await page.waitForSelector("#tn-list .tn-row");
  await page.click("#ar-toggle");
  const btn = page.locator('#ar-actions .mini-btn');
  ok(await btn.count() === 1, "no Fill in button (are there still finished games missing data?)");
  await btn.click();
  const y = page.locator("#fin-y .chip").nth(1);
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
  if (await goBtn.count()) {
    await goBtn.click();
    ok(writes.at(-1).body.s === "playing", "sent " + JSON.stringify(writes.at(-1)));
  }
  const left = await items.count();
  if (left) {
    await page.locator("#play-check .pc-btn.x").first().click();
    ok(await items.count() === left - 1, "✕ didn't hide the row");
    await page.reload();
    await page.waitForSelector("#tn-list .tn-row");
    // The stubbed Worker never saves, so a game "started" above is back after the reload;
    // only the hidden row should stay gone.
    ok(await page.locator("#play-check .pc-item").count() === n - 1, "a hidden row came back after reload");
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
    ok(await page.evaluate(() => getComputedStyle(document.body).backgroundColor) === "rgb(11, 26, 16)", "forest background not green");
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

// Dampé's graveyard: dropped games get stones; digging one up asks first and sends the usual edit.
await test("graveyard: stones for dropped games, dig-up confirms then writes s:soon through /games/edit", async () => {
  const { page, writes, ctx } = await open("index.html", 1280);
  await page.waitForSelector("#stats .stat-n");
  const dropped = await page.evaluate(() => G.filter(g => g.s === "dropped").length);
  ok(dropped > 0, "fixture has no dropped games");
  ok(await page.locator("#gy-panel").isHidden(), "graveyard should start closed");
  await page.click("#gy-toggle");
  ok(await page.locator(".gy-stone").count() === dropped, "one stone per dropped game");
  ok((await page.locator(".gy-epi").first().innerText()).length > 4, "no epitaph");
  page.removeAllListeners("dialog"); // the harness's default handler dismisses everything
  let asked = "";
  page.once("dialog", d => { asked = d.message(); d.dismiss(); });
  await page.locator(".gy-dig").first().click();
  ok(/^Dig up .+\? It goes back to Someday\.$/.test(asked), "confirm text: " + asked);
  await page.waitForTimeout(100);
  ok(writes.length === 0, "wrote after the confirm was declined");
  page.once("dialog", d => d.accept());
  await page.locator(".gy-dig").first().click();
  await page.waitForTimeout(150);
  ok(writes.length === 1 && writes[0].path.endsWith("/games/edit") && writes[0].body.s === "soon" && writes[0].body.queued,
    "dig-up sent " + JSON.stringify(writes));
  ok(await page.locator(".gy-stone").count() === dropped - 1, "stone should be gone after digging up");
  await ctx.close();
});

await test("graveyard: empty state when nothing is dropped, and no sideways scroll on a phone", async () => {
  const { page, ctx } = await open("index.html", 390);
  await page.waitForSelector("#stats .stat-n");
  await page.evaluate(() => { G.forEach(g => { if (g.s === "dropped") g.s = "soon"; }); render(); tog("gy"); });
  ok(/Dampé|dead|Quiet|quiet|Nothing/.test(await page.locator("#gy-panel").innerText()), "no Dampé line");
  ok(await page.locator(".gy-stone").count() === 0, "stones in an empty graveyard");
  ok(await noSideScroll(page), "sideways scroll");
  await ctx.close();
});

// Rupee wallet, shop, bombs, fairy, Great Fairy and forest skins. /rupees/* is faked in memory
// on top of the harness's stub (later routes win), so nothing is ever sent anywhere.
async function fakeRupees(page, writes, start = { purchases: [], fairyUntil: {} }) {
  const state = JSON.parse(JSON.stringify(start));
  await page.route("**/rupees/**", async route => {
    const path = new URL(route.request().url()).pathname, body = JSON.parse(route.request().postData() || "{}");
    writes.push({ path, body });
    if (path.endsWith("/buy")) state.purchases.push({ id: body.id, item: body.item, cost: 50, ts: new Date().toISOString(), ...(body.meta ? { meta: body.meta } : {}) });
    if (path.endsWith("/use")) {
      const f = state.purchases.find(p => p.item === "fairy" && !p.used);
      if (f) f.used = "today";
      state.fairyUntil[body.gameId] = "2999-01-01";
    }
    await route.fulfill({ status: 200, contentType: "application/json", headers: { "Access-Control-Allow-Origin": "*" }, body: JSON.stringify(state) });
  });
  return state;
}

for (const width of [390, 1280]) {
  await test(`wallet at ${width}px: balance and tier in the header, the shop opens, no sideways scroll`, async () => {
    const { page, errors, ctx } = await open("index.html", width);
    await page.waitForSelector("#wallet:not([style*='none'])");
    ok(/\d+/.test(await page.locator("#wallet").innerText()), "no balance");
    ok(/Wallet/.test(await page.getAttribute("#wallet", "title")), "no tooltip");
    ok(await noSideScroll(page), "sideways scroll");
    await page.click("#wallet");
    await page.waitForSelector("#shop[open] .shop-bal");
    const text = (await page.locator("#shop").innerText()).toLowerCase();
    for (const w of ["hestu", "bomb a game", "fairy in a bottle", "mask shop"]) ok(text.includes(w), `shop is missing ${w}`);
    ok(await noSideScroll(page), "sideways scroll with the shop open");
    ok(errors.length === 0, errors.join(" | "));
    await ctx.close();
  });
}

await test("shop: buying and wearing a mask records one purchase, shows it in the header, and the owl suggests its mood", async () => {
  const { page, writes, errors, ctx } = await open("index.html", 1280);
  await fakeRupees(page, writes);
  await page.waitForSelector("#wallet:not([style*='none'])");
  await page.click("#wallet");
  await page.locator("#shop .shop-row", { hasText: "Bunny Hood" }).locator(".shop-btn").click();
  await page.waitForSelector("#worn-mask svg");
  ok(writes.length === 1 && writes[0].path.endsWith("/rupees/buy") && writes[0].body.item === "mask" && writes[0].body.meta.mask === "bunny", JSON.stringify(writes));
  ok(await page.evaluate(() => localStorage.getItem("gt_mask")) === "bunny", "mask not worn");
  await page.click("#shop .shop-close");
  const owl = await ctx.newPage();
  await owl.route("**/*", r => /^http:\/\/127/.test(r.request().url()) ? r.continue() : r.abort());
  await owl.goto(page.url().replace("index.html", "owl.html"));
  for (let i = 0; i < 2; i++) { await owl.locator("#choices .choice").first().click(); await owl.waitForSelector("#choices .choice:not([disabled])"); }
  await owl.waitForSelector("#choices .choice.suggested");
  ok(/Wrap one up|wrap/i.test(await owl.locator("#choices .choice.suggested").innerText()), "Bunny Hood should suggest Wrap one up");
  ok(await owl.locator("#choices .choice").count() === 3, "the other moods must still be offered");
  ok(errors.length === 0, errors.join(" | "));
  await ctx.close();
});

await test("bomb: confirm first, then drops through /games/edit and buys one; the game lands in the graveyard", async () => {
  const { page, writes, errors, ctx } = await open("index.html", 1280);
  await fakeRupees(page, writes);
  await page.waitForSelector("#wallet:not([style*='none'])");
  const q = await page.evaluate(() => { const g = G.find(x => x.s === "queue"); return { id: g.id, t: g.t }; });
  await page.click("#wallet");
  page.removeAllListeners("dialog");
  let asked = "";
  page.once("dialog", d => { asked = d.message(); d.dismiss(); });
  await page.locator("#shop .bomb-list .shop-row", { hasText: q.t }).first().locator(".shop-btn").click();
  await page.waitForTimeout(150);
  ok(asked.includes("Bomb") && asked.includes("graveyard"), "confirm: " + asked);
  ok(writes.length === 0, "wrote before the confirm was accepted");
  page.once("dialog", d => d.accept());
  await page.locator("#shop .bomb-list .shop-row", { hasText: q.t }).first().locator(".shop-btn").click();
  await page.waitForTimeout(400);
  const edit = writes.find(w => w.path.endsWith("/games/edit")), bomb = writes.find(w => w.path.endsWith("/rupees/buy"));
  ok(edit && edit.body.id === q.id && edit.body.s === "dropped", "drop sent " + JSON.stringify(writes));
  ok(bomb && bomb.body.item === "bomb" && bomb.body.meta.gameId === q.id, "bomb purchase " + JSON.stringify(writes));
  ok(await page.evaluate(id => GTGraveyard.dropped(G).some(g => g.id === id), q.id), "not in the graveyard");
  ok(errors.length === 0, errors.join(" | "));
  await ctx.close();
});

await test("bomb: only Up Next games are offered", async () => {
  const { page, ctx } = await open("index.html", 1280);
  await page.waitForSelector("#wallet:not([style*='none'])");
  const [offered, queue] = await page.evaluate(() => { openShop(); return [document.querySelectorAll("#shop .bomb-list .shop-row").length, G.filter(g => g.s === "queue").length]; });
  ok(offered === queue && queue > 0, `${offered} offered for ${queue} queued`);
  await ctx.close();
});

await test("fairy: an owned fairy rescues a dormant Now Playing game once, and the card says so", async () => {
  const { page, writes, errors, ctx } = await open("index.html", 1280);
  await fakeRupees(page, writes);
  await page.waitForSelector("#wallet:not([style*='none'])");
  const id = await page.evaluate(() => {
    const g = G.find(x => x.s === "playing"); g.lastPlayed = "2000-01-01";
    RUP = { purchases: [{ id: "fairy-test-1", item: "fairy", cost: 300, ts: new Date().toISOString() }], fairyUntil: {} };
    render(); tryFairy(); return g.id;
  });
  await page.waitForSelector("#fairy-pop");
  ok(writes.length === 1 && writes[0].path.endsWith("/rupees/use") && writes[0].body.gameId === id, JSON.stringify(writes));
  await page.waitForSelector(".fairy-pill");
  ok(await page.locator(`.hero-card[data-id="${id}"] .dormant-pill`).count() === 0, "still shows dormant");
  await page.evaluate(() => tryFairy());
  await page.waitForTimeout(150);
  ok(writes.length === 1, "used a fairy it no longer had");
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

await test("forest skin: an owned, worn skin dresses the Korok Forest; Blood Moon waits for a full moon", async () => {
  const { page, ctx } = await open("index.html", 1280);
  await page.waitForSelector("#wallet:not([style*='none'])");
  // korok.js reads its finds when the page loads, so set the storage and reload, as a real visit would.
  await page.evaluate(() => {
    localStorage.setItem("korok:all", JSON.stringify(["a/1", "a/2", "a/3", "a/4", "a/5", "a/6"]));
    localStorage.setItem("korok:all:forest", "1");
    localStorage.setItem("korok:all:skin", "autumn");
  });
  await page.reload();
  await page.waitForSelector("#wallet:not([style*='none'])");
  const a = await page.evaluate(() => document.documentElement.className);
  await page.evaluate(() => { localStorage.setItem("korok:all:skin", "bloodmoon"); window.KorokApply(); });
  const cls = await page.evaluate(() => ({ a: null, b: document.documentElement.className, full: KorokCore.isFullMoon(new Date()) }));
  cls.a = a;
  ok(/korok-skin-autumn/.test(cls.a) && /korok-forest/.test(cls.a), cls.a);
  ok(/korok-skin-bloodmoon/.test(cls.b) === cls.full, `bloodmoon ${cls.b} full=${cls.full}`);
  await ctx.close();
});

await browser.close();
server.close();
console.log(`\n${pass}/${pass + fail} passing`);
process.exit(fail ? 1 : 0);
