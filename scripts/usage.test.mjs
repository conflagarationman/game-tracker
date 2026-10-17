// Usage counts (usage.js): page and section names, and that every page loads it. DOM-free.
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
const U = createRequire(import.meta.url)("../usage.js");
let pass = 0, fail = 0;
const t = (name, cond) => { if (cond) pass++; else { fail++; console.log("FAIL " + name); } };

t("page from a GitHub Pages path", U.pageOf("/game-tracker/owl.html") === "owl");
t("the bare site root is index", U.pageOf("/game-tracker/") === "index" && U.pageOf("") === "index");
t("innermost counted section wins", U.sectionOf("index", ["g-123", "queue", "stats"]) === "queue");
t("uncounted ids are ignored", U.sectionOf("index", ["toast", "g-1"]) === null);
t("a section only counts on its own page", U.sectionOf("owl", ["queue"]) === null);
t("only the live site sends", U.LIVE_HOST === "conflagarationman.github.io");
t("names fit the hub's pattern (lowercase, digits, dashes)", Object.values(U.SECTIONS).flat().every(s => /^[a-z0-9-]{1,32}$/.test(s)));
for (const p of Object.keys(U.SECTIONS)) {
  const html = readFileSync(new URL(`../${p}.html`, import.meta.url), "utf8");
  t(`${p}.html loads usage.js`, /<script src="usage\.js"( defer)?><\/script>/.test(html));
  for (const id of U.SECTIONS[p]) t(`${p}.html still has #${id}`, html.includes(`id="${id}"`));
}

console.log(pass + "/" + (pass + fail) + " passing");
process.exit(fail ? 1 : 0);
