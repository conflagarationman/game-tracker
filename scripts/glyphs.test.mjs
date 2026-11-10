// Tests for glyphs.js: every platform in games.json has a glyph, every glyph is a 12x10 grid with
// something drawn, the SVG takes its colour from currentColor (no literal colours), and unknown
// platforms don't throw. Run: node scripts/glyphs.test.mjs
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
const G = createRequire(import.meta.url)("../glyphs.js");
let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; } catch (e) { fail++; console.log(`FAIL ${name}\n  ${e.message}`); } };
const ok = (c, m) => { if (!c) throw new Error(m); };

const PLATFORMS = ["steam", "steamdeck", "pc", "ps5", "switch", "switch2", "ayn", "retro", "wiiu"];
t("every platform maps to a glyph that exists", () => PLATFORMS.forEach(p => ok(G.ART[G.familyOf(p)], p)));
t("every platform used in games.json is covered", () => {
  const used = new Set(JSON.parse(readFileSync(new URL("../games.json", import.meta.url), "utf8")).map(g => g.p));
  for (const p of used) ok(Object.prototype.hasOwnProperty.call(G.FAMILY, p), `no glyph for ${p}`);
});
t("every glyph is 12 columns by 10 rows with only . X o", () => {
  for (const [name, rows] of Object.entries(G.ART)) {
    ok(rows.length === 10, `${name} has ${rows.length} rows`);
    rows.forEach(r => ok(/^[.Xo]{12}$/.test(r), `${name} row "${r}"`));
    ok(rows.join("").includes("X"), `${name} draws nothing`);
  }
});
t("families are distinct: at least six different glyphs across the platforms", () => ok(new Set(PLATFORMS.map(G.familyOf)).size >= 6, "too few"));
t("svg is rect-based, crisp, uses currentColor and no literal colours", () => {
  for (const p of PLATFORMS) {
    const s = G.svg(p);
    ok(s.startsWith("<svg") && s.includes("<rect") && s.includes('fill="currentColor"') && s.includes("crispEdges"), p);
    ok(!/#[0-9a-f]{3,8}|rgb\(|fill="(?!currentColor)/i.test(s), `${p} has a literal colour`);
    ok(s.includes('aria-hidden="true"'), "decorative svg should be aria-hidden");
  }
});
t("unknown or missing platforms fall back to the gamepad", () => {
  ok(G.familyOf("dreamcast") === "pad" && G.familyOf(undefined) === "pad" && G.familyOf("__proto__") === "pad", "fallback");
  ok(G.svg(null).includes("<rect"), "svg(null)");
});
t("runs merge adjacent pixels and keep detail separate", () => {
  const r = G.runs(["XXoo.X"]);
  ok(r.length === 3 && r[0].w === 2 && !r[0].detail && r[1].w === 2 && r[1].detail && r[2].x === 5, JSON.stringify(r));
});

console.log(`${pass}/${pass + fail} passing`);
process.exit(fail ? 1 : 0);
