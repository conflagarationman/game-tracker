// recaps.json is hand-entered (PlayStation Wrap-Up and Nintendo Year in Review have no API),
// so the only guard on it is this: wrapped.html must be able to read whatever is in it.
import assert from "node:assert/strict";
import { readFile, access } from "node:fs/promises";

let pass = 0, fail = 0;
const test = async (name, fn) => {
  try { await fn(); pass++; console.log(`PASS  ${name}`); }
  catch (e) { fail++; console.log(`FAIL  ${name}\n        ${e.message}`); }
};

const PLATFORMS = new Set(["playstation", "nintendo"]);
const FIELDS = new Set(["hours", "gamesPlayed", "topGames", "highlights", "images", "note"]);
const ROOT = new URL("../", import.meta.url);
const recaps = JSON.parse(await readFile(new URL("recaps.json", ROOT), "utf8"));

function problems(recaps) {
  const out = [];
  for (const [key, year] of Object.entries(recaps)) {
    if (key.startsWith("_")) continue;
    if (!/^\d{4}$/.test(key)) { out.push(`"${key}" isn't a year`); continue; }
    for (const [plat, r] of Object.entries(year || {})) {
      const at = `${key}.${plat}`;
      if (!PLATFORMS.has(plat)) { out.push(`${at}: unknown platform (playstation | nintendo)`); continue; }
      if (r == null) continue;
      for (const f of Object.keys(r)) if (!FIELDS.has(f)) out.push(`${at}.${f}: unknown field`);
      for (const f of ["hours", "gamesPlayed"]) if (r[f] != null && !(typeof r[f] === "number" && r[f] >= 0)) out.push(`${at}.${f}: must be a number`);
      if (r.topGames != null && !(Array.isArray(r.topGames) && r.topGames.every(g => g && typeof g.name === "string" && (g.hours == null || typeof g.hours === "number"))))
        out.push(`${at}.topGames: [{ name, hours? }]`);
      if (r.highlights != null && !(Array.isArray(r.highlights) && r.highlights.every(h => h && typeof h.label === "string" && h.value != null)))
        out.push(`${at}.highlights: [{ label, value }]`);
      if (r.images != null && !(Array.isArray(r.images) && r.images.every(i => typeof i === "string" && /^recaps\/[\w.-]+\.(png|jpe?g|webp)$/i.test(i))))
        out.push(`${at}.images: paths like recaps/2025-playstation-1.png`);
    }
  }
  return out;
}

await test("recaps.json is readable by wrapped.html", () => {
  assert.deepEqual(problems(recaps), []);
});

await test("the documented example is itself valid", () => {
  assert.deepEqual(problems({ 2025: recaps._example }), []);
});

await test("every image it names is committed", async () => {
  for (const [key, year] of Object.entries(recaps)) {
    if (key.startsWith("_")) continue;
    for (const r of Object.values(year || {})) for (const img of (r && r.images) || [])
      await access(new URL(img, ROOT)).catch(() => { throw new Error(`${img} is listed but not in the repo`); });
  }
});

await test("the checker catches the likely typos", () => {
  const p = problems({ 2025: { switch: {}, playstation: { hours: "212", topGames: ["Astro Bot"], images: ["C:/shot.png"], trophies: 4 } } });
  assert.equal(p.length, 5, p.join("\n"));
});

console.log(`\n${pass}/${pass + fail} passing`);
process.exit(fail ? 1 : 0);
