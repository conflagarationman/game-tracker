// Korok/Hestu counting, migration and milestones. DOM-free: korok.js's first block is pure.
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
const K = createRequire(import.meta.url)("../korok.js");
let pass = 0, fail = 0;
const t = (name, cond) => { if (cond) pass++; else { fail++; console.log("FAIL " + name); } };
const mem = (init = {}) => { const d = { ...init }; return { d, getItem: k => (k in d ? d[k] : null), setItem: (k, v) => { d[k] = String(v); } }; };

t("parseSpots reads left and top", JSON.stringify(K.parseSpots("a:8%, b:40%:top")) === JSON.stringify([{ id: "a", left: "8%", top: false }, { id: "b", left: "40%", top: true }]));
t("parseSpots ignores blanks", K.parseSpots("").length === 0 && K.parseSpots(null).length === 0);

// migration: per-repo keys fold into the shared one, qualified; the two repos' "index" don't collide
let st = mem({ "korok:game-tracker": '["index","owl"]', "korok:steph-tv-tracker": '["index"]' });
let f = K.load(st, "korok:all", ["korok:game-tracker", "korok:steph-tv-tracker"]);
t("migration qualifies ids", JSON.stringify(f) === JSON.stringify(["game-tracker/index", "game-tracker/owl", "steph-tv-tracker/index"]));
t("migration persisted", JSON.parse(st.d["korok:all"]).length === 3);
t("legacy keys kept for old pages", "korok:game-tracker" in st.d);
st.setItem("korok:steph-tv-tracker", '["index","extra"]');   // an old page still writing
f = K.load(st, "korok:all", ["korok:game-tracker", "korok:steph-tv-tracker"]);
t("re-load unions later legacy writes, no duplicates", f.length === 4 && new Set(f).size === 4);
t("garbage storage is an empty list", K.load(mem({ "korok:all": "{nope" }), "korok:all", []).length === 0);
t("non-string ids dropped", K.load(mem({ "korok:all": '[1,"a/b",null]' }), "korok:all", []).join() === "a/b");

// counting
st = mem();
let r = K.add(st, "korok:all", [], "game-tracker/index");
t("first find is new", r.isNew && r.found.length === 1 && st.d["korok:all"] === '["game-tracker/index"]');
r = K.add(st, "korok:all", r.found, "game-tracker/index");
t("repeat find is not new", !r.isNew && r.found.length === 1);
t("seeds label caps at total", K.seedsLabel(new Array(15).fill("x"), 12) === "Seeds: 12/12");
t("seeds label", K.seedsLabel(["a", "b", "c", "d", "e", "f", "g"], 12) === "Seeds: 7/12");

// milestones: 3, 6, and all
t("3 is a milestone", K.milestone(3, 12, []).kind === "three");
t("6 is a milestone and unlocks the forest", K.milestone(6, 12, []).kind === "six" && K.milestone(6, 12, []).unlock);
t("12 of 12 is 'all'", K.milestone(12, 12, []).kind === "all");
t("in-between counts are not", [1, 2, 4, 5, 7, 11].every(n => K.milestone(n, 12, []) === null));
t("a milestone only fires once", K.milestone(3, 12, [3]) === null);
t("hub: 6 of 6 is 'all' and still unlocks", K.milestone(6, 6, []).kind === "all" && K.milestone(6, 6, []).unlock);
t("hub: 3 of 6 is a milestone", K.milestone(3, 6, []).kind === "three");
t("forest needs 6 seeds", !K.forestUnlocked(new Array(5).fill("x"), 12) && K.forestUnlocked(new Array(6).fill("x"), 12));

// sprite sanity
t("Hestu grid is 26x29", K.HESTU.length === 29 && K.HESTU.every(r => r.length === 26));
t("Hestu uses only palette letters", /^[.KCcsGgtnFfobBmWhT]+$/.test(K.HESTU.join("")));
t("Hestu svg renders, maracas split left/right", /<svg/.test(K.hestuSvg()) && /class="hs-l"><rect/.test(K.hestuSvg()) && /class="hs-r"><rect/.test(K.hestuSvg()));
t("Korok grid is 16x21", K.KOROK.length === 21 && K.KOROK.every(r => r.length === 16));
t("Korok uses only palette letters", /^[.ADLXalotw]+$/.test(K.KOROK.join("")));
t("every Korok look colours every letter", K.KOROK_LOOKS.every((_, i) => !/undefined/.test(K.korokSvg(i))));
t("a spot always gets the same Korok", K.variantFor("game-tracker/index") === K.variantFor("game-tracker/index"));
t("the spots use more than one look", new Set(["index", "index-hang", "index-end", "owl", "wrapped", "add"].map(s => K.variantFor("game-tracker/" + s))).size > 1);

// the pages: spot count matches what data-total promises (10 here + 2 on Steph's log = 12)
let spots = 0;
for (const p of ["index", "owl", "wrapped", "add"]) {
  const m = readFileSync(new URL("../" + p + ".html", import.meta.url), "utf8").match(/<script src="korok\.js"[^>]*data-spots="([^"]+)"[^>]*data-total="(\d+)"|<script src="korok\.js"[^>]*data-total="(\d+)"[^>]*data-spots="([^"]+)"/);
  t(p + " has a korok tag", !!m);
  if (m) { const ids = K.parseSpots(m[1] || m[4]); spots += ids.length; t(p + " says total 12", (m[2] || m[3]) === "12"); }
}
t("game-tracker holds 10 spots (Steph's log holds the other 2)", spots === 10);

console.log(pass + "/" + (pass + fail) + " passing");
process.exit(fail ? 1 : 0);
