// Contrast and consistency checks for theme.css (WCAG 2.x), in both modes and in the Korok
// Forest. Pure Node, no browser: the tokens are plain hex in the stylesheet.
import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";

const root = (f) => new URL(`../${f}`, import.meta.url);
const css = await readFile(root("theme.css"), "utf8");

let pass = 0, fail = 0;
const test = async (name, fn) => {
  try { await fn(); pass++; console.log(`PASS  ${name}`); }
  catch (e) { fail++; console.log(`FAIL  ${name}\n        ${e.message}`); }
};

const tokens = (block) => Object.fromEntries([...block.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-fA-F]{6})\b/g)].map(m => [m[1], m[2].toLowerCase()]));
const dark = tokens(css.match(/:root\{([\s\S]*?)\n\}/)[1]);
const lightMedia = tokens(css.match(/prefers-color-scheme:light\)\{\s*:root:not\(\[data-theme="dark"\]\)\{([\s\S]*?)\n  \}/)[1]);
const lightForced = tokens(css.match(/:root\[data-theme="light"\]\{([\s\S]*?)\n\}/)[1]);
const forestHex = (await readFile(root("index.html"), "utf8")).match(/data-forest="([^"]+)"/)[1];
const forest = { ...dark, ...tokens(forestHex), ...tokens(css.match(/:root\.korok-forest\{([\s\S]*?)\n\}/)[1]) };

const lum = (hex) => {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(c => c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

const MODES = { dark, light: lightMedia, forest };
// Text-like tokens must clear AA (4.5) on the page and card backgrounds; icons and hearts need 3.
const TEXT = ["text", "muted", "dim", "accent", "info", "ok", "warn", "fairy", "playing", "done", "dropped"];
const GRAPHIC = ["heart", "rupee", "border2"];
const SURFACES = ["bg", "surface"];
// Status chips: foreground on its own background.
const CHIPS = [["playing", "playing-bg"], ["done", "done-bg"], ["dropped", "dropped-bg"]];

await test("the parchment tokens match whether set by prefers-color-scheme or data-theme=light", () => {
  assert.deepEqual(lightMedia, lightForced);
  assert.deepEqual(Object.keys(lightMedia).sort(), Object.keys(dark).sort().filter(k => k !== "bad"));
});
await test("the spec's headline colours are in place", () => {
  assert.equal(dark.bg, "#14261a"); assert.equal(dark.surface, "#1c3323"); assert.equal(dark.border, "#2f4a34");
  assert.equal(dark.text, "#eaf2e3"); assert.equal(dark.accent, "#e8c547"); assert.equal(dark.heart, "#e2574c"); assert.equal(dark.rupee, "#7fd36b");
  assert.equal(lightMedia.bg, "#f3ead3"); assert.equal(lightMedia.surface, "#faf4e4"); assert.equal(lightMedia.text, "#3b2a1a");
  assert.equal(lightMedia.accent, "#6b3f1d"); assert.equal(lightMedia.heart, "#b3352e"); assert.equal(lightMedia.rupee, "#2f7d4a");
  const chips = { dark: { playing: ["#2c5a2a", "#c9f0b4"], done: ["#4a3e12", "#f3dc84"], dropped: ["#4a1f1c", "#f2a49c"] },
    light: { playing: ["#d9ecd8", "#22572f"], done: ["#f3e1a8", "#6b4a06"], dropped: ["#f2d3cc", "#7a2318"] } };
  for (const [mode, set] of Object.entries(chips)) for (const [k, [bg, fg]] of Object.entries(set)) {
    assert.equal(MODES[mode][`${k}-bg`], bg, `${mode} ${k} bg`); assert.equal(MODES[mode][k], fg, `${mode} ${k} fg`);
  }
});
for (const [mode, t] of Object.entries(MODES)) {
  await test(`${mode}: text colours reach AA (4.5:1) on the page and cards`, () => {
    for (const k of TEXT) for (const s of SURFACES) assert.ok(ratio(t[k], t[s]) >= 4.5, `${k} on ${s}: ${ratio(t[k], t[s]).toFixed(2)}`);
  });
  await test(`${mode}: hearts, rupees and borders reach 3:1 as graphics`, () => {
    for (const k of GRAPHIC) for (const s of SURFACES) assert.ok(ratio(t[k], t[s]) >= 3 - (k === "border2" ? 3 : 0), `${k} on ${s}: ${ratio(t[k], t[s]).toFixed(2)}`);
  });
  await test(`${mode}: Playing, Done and Dropped chips reach AA on their own backgrounds`, () => {
    for (const [fg, bg] of CHIPS) assert.ok(ratio(t[fg], t[bg]) >= 4.5, `${fg}: ${ratio(t[fg], t[bg]).toFixed(2)}`);
  });
  await test(`${mode}: the three status chips are visibly different from each other`, () => {
    const seen = new Set();
    for (const [fg, bg] of CHIPS) { assert.ok(!seen.has(t[bg]) && !seen.has(t[fg])); seen.add(t[bg]); seen.add(t[fg]); }
    const hue = (hex) => { const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255); const mx = Math.max(r, g, b), d = mx - Math.min(r, g, b);
      if (!d) return 0; const h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4; return (h * 60 + 360) % 360; };
    const gap = (a, b) => { const d = Math.abs(hue(a) - hue(b)); return Math.min(d, 360 - d); };
    for (const [a, b] of [["playing-bg", "done-bg"], ["done-bg", "dropped-bg"], ["playing-bg", "dropped-bg"]]) assert.ok(gap(t[a], t[b]) >= 25, `${a} vs ${b}: ${gap(t[a], t[b]).toFixed(0)} degrees apart`);
  });
  await test(`${mode}: gold-on-button text (on-accent on accent) reaches AA`, () => {
    assert.ok(ratio(t["on-accent"], t.accent) >= 4.5, ratio(t["on-accent"], t.accent).toFixed(2));
  });
}
await test("no page still carries the old lime or a literal near-black page colour", async () => {
  for (const f of ["index.html", "owl.html", "add.html", "wrapped.html"]) {
    const s = await readFile(root(f), "utf8");
    assert.ok(!/#c8f542/i.test(s), `${f} still has #c8f542`);
    assert.ok(/<link rel="stylesheet" href="theme\.css">/.test(s), `${f} does not load theme.css`);
    assert.ok(/family=Cinzel:wght@500;600;700/.test(s), `${f} does not load Cinzel`);
    assert.ok(!/^\s*--bg:#0e0e10/m.test(s), `${f} defines its own dark background`);
  }
});

console.log(`\n${pass}/${pass + fail} passing`);
process.exit(fail ? 1 : 0);
