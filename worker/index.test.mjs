// Exercises the Worker against a stubbed GitHub contents API, so the read-modify-write path
// and its conflict retry are covered without needing a token or a network — same pattern as
// steph-tv-tracker's worker/index.test.mjs.
import worker, { validateNewGame } from "./index.mjs";
import assert from "node:assert/strict";

let pass = 0, fail = 0;
const test = async (name, fn) => {
  try { await fn(); pass++; console.log(`PASS  ${name}`); }
  catch (e) { fail++; console.log(`FAIL  ${name}\n        ${e.message}`); }
};

const ORIGIN = "https://conflagarationman.github.io";
const env = {
  REPO: "conflagarationman/game-tracker",
  BRANCH: "main",
  GITHUB_TOKEN: "fake",
  ALLOWED_ORIGIN: ORIGIN,
  SYNC_KEY: "k",
};

const b64 = (s) => btoa(unescape(encodeURIComponent(s)));

// Minimal in-memory stand-in for the contents API, including sha-based optimistic locking.
function fakeGitHub({ games = [], failWrites = 0 } = {}) {
  const state = { file: JSON.stringify(games), sha: "sha0", commits: [], writes: 0 };
  globalThis.fetch = async (url, init = {}) => {
    const method = init.method || "GET";
    if (method === "GET") {
      return new Response(JSON.stringify({ content: b64(state.file), sha: state.sha }), { status: 200 });
    }
    if (method === "PUT") {
      state.writes++;
      const body = JSON.parse(init.body);
      if (state.writes <= failWrites) return new Response("conflict", { status: 409 });
      if (body.sha !== state.sha) return new Response("sha mismatch", { status: 409 });
      state.file = decodeURIComponent(escape(atob(body.content)));
      state.sha = "sha" + state.writes;
      state.commits.push(body.message);
      return new Response("{}", { status: 200 });
    }
    return new Response("nope", { status: 405 });
  };
  return state;
}

const post = (path, body, headers = {}) => worker.fetch(new Request(`https://w.dev${path}`, {
  method: "POST",
  headers: { Origin: ORIGIN, "X-Sync-Key": "k", "Content-Type": "application/json", ...headers },
  body: JSON.stringify(body),
}), env);

const baseGame = (overrides) => ({
  id: 1, t: "Brotato", p: "steam", s: "playing", r: 9, g: "Roguelike", y: 2023,
  h: null, cy: null, cm: null, gotm: null, mastery: null, diff: null, achPct: null,
  achCount: null, actualHours: null, lastPlayed: null, casual: false, note: null,
  start: null, queued: null, ...overrides,
});

await test("validateNewGame requires title, a known platform, and a known status", () => {
  assert.ok(validateNewGame({ t: "", p: "steam", s: "queue" }));
  assert.ok(validateNewGame({ t: "Foo", p: "xbox", s: "queue" }));
  assert.ok(validateNewGame({ t: "Foo", p: "steam", s: "bogus" }));
  assert.equal(validateNewGame({ t: "Foo", p: "steam", s: "queue" }), null);
});

await test("POST /games/add appends a new game with a fresh id and filled-in defaults", async () => {
  const gh = fakeGitHub({ games: [baseGame({ id: 5 })] });
  const res = await post("/games/add", { t: "New Game", p: "switch2", s: "soon", g: "RPG", y: 2026 });
  assert.equal(res.status, 200);
  const games = await res.json();
  assert.equal(games.length, 2);
  const added = games.find(g => g.t === "New Game");
  assert.equal(added.id, 6, "id should be one past the current max");
  assert.equal(added.p, "switch2");
  assert.equal(added.r, 0, "unsupplied fields should get their default");
  assert.equal(added.casual, false);
  assert.ok(gh.commits[0].includes("New Game"));
});

await test("POST /games/add rejects an invalid platform without writing anything", async () => {
  const gh = fakeGitHub({ games: [baseGame()] });
  const res = await post("/games/add", { t: "Bad Game", p: "xbox", s: "queue" });
  assert.equal(res.status, 400);
  assert.equal(gh.writes, 0, "a validation failure must never touch the file");
});

await test("POST /games/edit patches only the matching game by id", async () => {
  const gh = fakeGitHub({ games: [baseGame({ id: 1, s: "queue", start: null }), baseGame({ id: 2, t: "Other" })] });
  const res = await post("/games/edit", { id: 1, s: "playing", start: "2026-07-28" });
  assert.equal(res.status, 200);
  const games = await res.json();
  assert.equal(games.find(g => g.id === 1).s, "playing");
  assert.equal(games.find(g => g.id === 1).start, "2026-07-28");
  assert.equal(games.find(g => g.id === 2).t, "Other", "the other game must be untouched");
});

await test("POST /games/edit 404s on an id that doesn't exist, without writing", async () => {
  const gh = fakeGitHub({ games: [baseGame({ id: 1 })] });
  const res = await post("/games/edit", { id: 999, s: "playing" });
  assert.equal(res.status, 404);
  assert.equal(gh.writes, 0);
});

await test("POST /games/delete removes the matching game and leaves the rest", async () => {
  fakeGitHub({ games: [baseGame({ id: 1 }), baseGame({ id: 2, t: "Keep Me" })] });
  const res = await post("/games/delete", { id: 1 });
  assert.equal(res.status, 200);
  const games = await res.json();
  assert.equal(games.length, 1);
  assert.equal(games[0].t, "Keep Me");
});

await test("a write retries and succeeds after a sha conflict from a concurrent bot commit", async () => {
  const gh = fakeGitHub({ games: [baseGame({ id: 1 })], failWrites: 1 });
  const res = await post("/games/add", { t: "Retried Game", p: "steam", s: "queue" });
  assert.equal(res.status, 200);
  const games = await res.json();
  assert.ok(games.some(g => g.t === "Retried Game"));
  assert.equal(gh.writes, 2, "first write should have been rejected, second should have succeeded");
});

await test("wrong sync key is rejected before touching GitHub", async () => {
  const gh = fakeGitHub({ games: [baseGame()] });
  const res = await post("/games/add", { t: "Nope", p: "steam", s: "queue" }, { "X-Sync-Key": "wrong" });
  assert.equal(res.status, 401);
  assert.equal(gh.writes, 0);
});

await test("wrong origin is rejected before touching GitHub", async () => {
  const gh = fakeGitHub({ games: [baseGame()] });
  const res = await worker.fetch(new Request("https://w.dev/games/add", {
    method: "POST",
    headers: { Origin: "https://evil.example", "X-Sync-Key": "k", "Content-Type": "application/json" },
    body: JSON.stringify({ t: "Nope", p: "steam", s: "queue" }),
  }), env);
  assert.equal(res.status, 403);
  assert.equal(gh.writes, 0);
});

await test("GET is not allowed — reads go straight to the public games.json, not through this Worker", async () => {
  fakeGitHub({ games: [baseGame()] });
  const res = await worker.fetch(new Request("https://w.dev/games/add", {
    method: "GET",
    headers: { Origin: ORIGIN, "X-Sync-Key": "k" },
  }), env);
  assert.equal(res.status, 405);
});

console.log(`\n${pass}/${pass + fail} passing`);
process.exit(fail ? 1 : 0);
