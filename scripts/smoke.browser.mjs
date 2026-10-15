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

await browser.close();
server.close();
console.log(`\n${pass}/${pass + fail} passing`);
process.exit(fail ? 1 : 0);
