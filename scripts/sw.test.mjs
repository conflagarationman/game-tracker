// Unit tests for the DOM-free parts of sw.js (the cache key and the request filter). The worker's
// real behaviour (network-first, offline fallback, never touching other origins) is exercised in
// scripts/smoke.browser.mjs. Run: node scripts/sw.test.mjs
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
const sw = createRequire(import.meta.url)("../sw.js");

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; } catch (e) { fail++; console.log(`FAIL ${name}\n  ${e.message}`); } };
const eq = (a, b) => { if (a !== b) throw new Error(`${JSON.stringify(a)} !== ${JSON.stringify(b)}`); };

const O = "https://example.github.io";
t("cache key drops the cache-bust query", () => eq(sw.cacheKey(`${O}/game-tracker/games.json?_=1731000000000`), `${O}/game-tracker/games.json`));
t("two timestamps share one key", () => eq(sw.cacheKey(`${O}/g/games.json?_=1`), sw.cacheKey(`${O}/g/games.json?_=2`)));
t("cache key drops other queries and the hash", () => eq(sw.cacheKey(`${O}/g/owl.html?pick=id%3A12#x`), `${O}/g/owl.html`));
t("cache key keeps the path", () => eq(sw.cacheKey(`${O}/g/`), `${O}/g/`));
t("different files keep different keys", () => { if (sw.cacheKey(`${O}/g/a.json?_=1`) === sw.cacheKey(`${O}/g/b.json?_=1`)) throw new Error("collided"); });
t("same-origin GET is handled", () => eq(sw.handles("GET", `${O}/g/games.json?_=1`, O), true));
t("a POST is not handled", () => eq(sw.handles("POST", `${O}/g/games.json`, O), false));
t("another origin is not handled (the Worker, fonts, covers, YouTube)", () => {
  for (const u of ["https://x.workers.dev/games/edit", "https://fonts.googleapis.com/css2", "https://cdn.example.com/c.jpg", "https://www.youtube.com/iframe_api", "https://familyholocron.duckdns.org/usage/beacon?e=1"])
    eq(sw.handles("GET", u, O), false);
});
t("a different port or scheme is a different origin", () => { eq(sw.handles("GET", "http://example.github.io/g/", O), false); eq(sw.handles("GET", "https://example.github.io:8443/g/", O), false); });
t("a garbage URL is not handled and does not throw", () => eq(sw.handles("GET", "not a url", O), false));
t("only ok basic responses are cached", () => {
  eq(sw.cacheable({ ok: true, type: "basic" }), true);
  eq(sw.cacheable({ ok: false, type: "basic" }), false);
  eq(sw.cacheable({ ok: true, type: "opaque" }), false);
  eq(sw.cacheable(null), false);
});
t("the cache name is fixed: no version to bump", () => eq(sw.CACHE, "gt-offline"));
t("sw.js has no versioned cache name", () => { if (/CACHE\s*=\s*['"][^'"]*v?\d/.test(readFileSync(new URL("../sw.js", import.meta.url), "utf8"))) throw new Error("versioned"); });

console.log(`${pass}/${pass + fail} passing`);
process.exit(fail ? 1 : 0);
