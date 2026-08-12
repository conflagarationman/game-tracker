// Exercises the Worker against a stubbed GitHub contents API, so the read-modify-write path
// and its conflict retry are covered without needing a token or a network — same pattern as
// steph-tv-tracker's worker/index.test.mjs.
import worker, { validateNewGame, validateGameFields } from "./index.mjs";
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

// Minimal in-memory stand-in for the contents API, including sha-based optimistic locking,
// plus the Actions dispatch endpoint triggerSyncWorkflows calls after a successful add.
function fakeGitHub({ games = [], failWrites = 0, failDispatch = false } = {}) {
  const state = { file: JSON.stringify(games), sha: "sha0", commits: [], writes: 0, dispatches: [] };
  globalThis.fetch = async (url, init = {}) => {
    const method = init.method || "GET";
    const u = String(url);
    if (u.includes("/dispatches")) {
      const workflow = u.match(/workflows\/([^/]+)\/dispatches/)[1];
      const body = JSON.parse(init.body);
      state.dispatches.push({ workflow, ref: body.ref });
      return failDispatch ? new Response("boom", { status: 500 }) : new Response(null, { status: 204 });
    }
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

await test("pc is a valid platform, distinct from steam so the sync skips it", async () => {
  assert.equal(validateNewGame({ t: "Some GOG Game", p: "pc", s: "playing" }), null);
  fakeGitHub({ games: [baseGame({ id: 1 })] });
  const res = await post("/games/add", { t: "Offline Server Thing", p: "pc", s: "playing" });
  assert.equal(res.status, 200);
  const { games } = await res.json();
  assert.equal(games.find(g => g.t === "Offline Server Thing").p, "pc");
});

await test("validateGameFields passes on unset (null) optional fields — null means 'not set', not invalid", () => {
  assert.equal(validateGameFields({}), null);
  assert.equal(validateGameFields({ cy: null, cm: null, r: null, diff: null, mastery: null, y: null }), null);
});

await test("validateGameFields rejects out-of-range cm, cy, y, diff, r and unknown mastery", () => {
  assert.match(validateGameFields({ cm: 12 }), /cm/, "cm is 0-indexed, so 12 is past December");
  assert.match(validateGameFields({ cm: -1 }), /cm/);
  assert.match(validateGameFields({ cm: 1.5 }), /cm/, "a fractional month would break M[] lookup");
  assert.match(validateGameFields({ cy: 1800 }), /cy/);
  assert.match(validateGameFields({ y: 3000 }), /y/);
  assert.match(validateGameFields({ diff: 0 }), /diff/, "diff is 1-5, and 0 renders as no badge");
  assert.match(validateGameFields({ diff: 6 }), /diff/);
  assert.match(validateGameFields({ r: 11 }), /rating/);
  assert.match(validateGameFields({ r: -1 }), /rating/);
  assert.match(validateGameFields({ mastery: "gold-star" }), /mastery/);
  // The values index.html's masteryBadge() actually knows how to render.
  for (const m of ["in-progress", "mastered", "platinum", "100pct"]) {
    assert.equal(validateGameFields({ mastery: m }), null, `${m} should be accepted`);
  }
  assert.equal(validateGameFields({ cm: 0, cy: 2026, diff: 5, r: 10, y: 1986 }), null, "boundaries are valid");
});

await test("validateGameFields guards the gotm tag format and gotmFlair's type", () => {
  assert.equal(validateGameFields({ gotm: "Jul 2026" }), null);
  assert.match(validateGameFields({ gotm: "July 2026" }), /gotm/, "full month name would match no club pick");
  assert.match(validateGameFields({ gotm: "Jul 26" }), /gotm/);
  assert.match(validateGameFields({ gotm: "2026-07" }), /gotm/);
  assert.equal(validateGameFields({ gotm: null }), null, "untagged is valid");
  assert.equal(validateGameFields({ gotmFlair: true }), null);
  assert.equal(validateGameFields({ gotmFlair: false }), null);
  assert.match(validateGameFields({ gotmFlair: "yes" }), /gotmFlair/);
  assert.match(validateGameFields({ gotmFlair: 1 }), /gotmFlair/);
});

await test("gotmFlair defaults to false on add and survives an unrelated edit", async () => {
  fakeGitHub({ games: [baseGame({ id: 1 })] });
  const res = await post("/games/add", { t: "Club Pick", p: "ayn", s: "soon", gotm: "Aug 2026" });
  const { games } = await res.json();
  const added = games.find(g => g.t === "Club Pick");
  assert.equal(added.gotmFlair, false, "a new game has not earned flair");

  // Flair earned is human-owned state; it must not be disturbed by edits to anything else,
  // the same way the completion fields aren't.
  await post("/games/edit", { id: added.id, gotmFlair: true });
  const res2 = await post("/games/edit", { id: added.id, s: "done" });
  // A status-changing edit's response is {games, triggers}, same shape as add — unwrap it.
  const edited = (await res2.json()).games.find(g => g.id === added.id);
  assert.equal(edited.gotmFlair, true, "flair must survive a later status change");
  assert.equal(edited.gotm, "Aug 2026");
});

await test("POST /games/add persists completion fields, and /games/edit round-trips them unchanged", async () => {
  fakeGitHub({ games: [baseGame({ id: 5 })] });
  const res = await post("/games/add", {
    t: "Finished Thing", p: "ps5", s: "done", cy: 2026, cm: 6, r: 9, mastery: "platinum", diff: 4, gotm: "Jul 2026",
  });
  assert.equal(res.status, 200);
  const { games } = await res.json();
  const added = games.find(g => g.t === "Finished Thing");
  assert.deepEqual(
    { cy: added.cy, cm: added.cm, r: added.r, mastery: added.mastery, diff: added.diff, gotm: added.gotm },
    { cy: 2026, cm: 6, r: 9, mastery: "platinum", diff: 4, gotm: "Jul 2026" },
  );

  // Editing an unrelated field must not disturb the completion data — this is the case that
  // would silently wipe a rating if the form ever dropped hidden fields from its payload.
  const res2 = await post("/games/edit", { id: added.id, p: "switch2" });
  const games2 = await res2.json();
  const edited = games2.find(g => g.id === added.id);
  assert.equal(edited.p, "switch2");
  assert.equal(edited.r, 9, "rating must survive an unrelated edit");
  assert.equal(edited.cm, 6, "completion month must survive an unrelated edit");
});

await test("both add and edit reject an out-of-range completion month without writing", async () => {
  const gh = fakeGitHub({ games: [baseGame({ id: 1 })] });
  const addRes = await post("/games/add", { t: "Bad Month", p: "steam", s: "done", cy: 2026, cm: 12 });
  assert.equal(addRes.status, 400);
  const editRes = await post("/games/edit", { id: 1, cm: 99 });
  assert.equal(editRes.status, 400);
  assert.equal(gh.writes, 0, "neither malformed request may touch the file");
});

await test("POST /games/add appends a new game with a fresh id and filled-in defaults", async () => {
  const gh = fakeGitHub({ games: [baseGame({ id: 5 })] });
  const res = await post("/games/add", { t: "New Game", p: "switch2", s: "soon", g: "RPG", y: 2026 });
  assert.equal(res.status, 200);
  const { games } = await res.json();
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
  // A status-changing edit's response is {games, triggers}, same shape as add — unwrap it.
  const { games } = await res.json();
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
  const { games } = await res.json();
  assert.ok(games.some(g => g.t === "Retried Game"));
  assert.equal(gh.writes, 2, "first write should have been rejected, second should have succeeded");
});

await test("a successful add dispatches both sync-games.yml and backfill-covers.yml with ref:main", async () => {
  const gh = fakeGitHub({ games: [baseGame({ id: 1 })] });
  const res = await post("/games/add", { t: "Fresh Release", p: "steam", s: "queue" });
  assert.equal(res.status, 200);
  const { triggers } = await res.json();
  assert.deepEqual(gh.dispatches.sort((a, b) => a.workflow.localeCompare(b.workflow)), [
    { workflow: "backfill-covers.yml", ref: "main" },
    { workflow: "sync-games.yml", ref: "main" },
  ]);
  assert.ok(triggers.every(t => t.ok), "both triggers should report ok:true in the response");
});

await test("add still succeeds (200) even when both workflow dispatches fail — best-effort, never blocks the add", async () => {
  const gh = fakeGitHub({ games: [baseGame({ id: 1 })], failDispatch: true });
  const res = await post("/games/add", { t: "Unlucky Release", p: "steam", s: "queue" });
  assert.equal(res.status, 200, "a dispatch failure must never fail the add itself");
  const { games, triggers } = await res.json();
  assert.ok(games.some(g => g.t === "Unlucky Release"), "the game must still be committed");
  assert.ok(triggers.every(t => t.ok === false), "both triggers should report the failure, not hide it");
  assert.equal(gh.dispatches.length, 2, "both dispatches should still have been attempted");
});

await test("an edit that changes status dispatches both workflows, same as add", async () => {
  // The actual bug this guards against: moving a game from queue to playing via edit wrote
  // to games.json immediately, but the hub push (now_playing/up_next) only reflected it on
  // the next scheduled sync run — up to a day of the hub/digest email showing stale data.
  const gh = fakeGitHub({ games: [baseGame({ id: 1, s: "queue" })] });
  const res = await post("/games/edit", { id: 1, s: "playing" });
  assert.equal(res.status, 200);
  const { games, triggers } = await res.json();
  assert.equal(games.find(g => g.id === 1).s, "playing");
  assert.equal(gh.dispatches.length, 2, "a status change should trigger both workflows");
  assert.ok(triggers.every(t => t.ok), "and report success");
});

await test("an edit that doesn't touch status, and delete, never dispatch either workflow", async () => {
  const gh = fakeGitHub({ games: [baseGame({ id: 1 }), baseGame({ id: 2, t: "Other" })] });
  const res = await post("/games/edit", { id: 1, note: "just a note change" });
  assert.equal(res.status, 200);
  const games = await res.json();
  assert.ok(Array.isArray(games), "a non-status edit's response shape is unchanged — plain array, no triggers key");
  await post("/games/delete", { id: 2 });
  assert.equal(gh.dispatches.length, 0);
});

await test("POST /games/reorder reorders queue entries in place and leaves every other game put", async () => {
  const gh = fakeGitHub({ games: [
    baseGame({ id: 1, t: "Playing One", s: "playing" }),
    baseGame({ id: 2, t: "Queue A", s: "queue" }),
    baseGame({ id: 3, t: "Soon One", s: "soon" }),
    baseGame({ id: 4, t: "Queue B", s: "queue" }),
    baseGame({ id: 5, t: "Queue C", s: "queue" }),
    baseGame({ id: 6, t: "Done One", s: "done" }),
  ] });
  const res = await post("/games/reorder", { ids: [5, 2, 4] });
  assert.equal(res.status, 200);
  const games = await res.json();
  assert.deepEqual(games.map(g => g.t), [
    "Playing One", "Queue C", "Soon One", "Queue A", "Queue B", "Done One",
  ], "queue slots take the new order; non-queue rows never move");
  assert.deepEqual(games.filter(g => g.s === "queue").map(g => g.id), [5, 2, 4]);
  assert.ok(gh.commits[0].includes("Reorder up next"));
});

await test("POST /games/reorder 409s when the queue changed since the list was loaded", async () => {
  const gh = fakeGitHub({ games: [
    baseGame({ id: 1, s: "queue" }), baseGame({ id: 2, s: "queue" }), baseGame({ id: 3, s: "queue" }),
  ] });
  // Client thinks there are two queued games; the server has three.
  const res = await post("/games/reorder", { ids: [2, 1] });
  assert.equal(res.status, 409);
  assert.match((await res.json()).error, /reload/);
  assert.equal(gh.writes, 0, "a stale reorder must never be written");

  // Right count, but one id isn't actually queued any more.
  const res2 = await post("/games/reorder", { ids: [1, 2, 99] });
  assert.equal(res2.status, 409);
  assert.equal(gh.writes, 0);
});

await test("POST /games/reorder rejects a malformed or duplicate-bearing id list without writing", async () => {
  const gh = fakeGitHub({ games: [baseGame({ id: 1, s: "queue" }), baseGame({ id: 2, s: "queue" })] });
  assert.equal((await post("/games/reorder", { ids: "nope" })).status, 400);
  assert.equal((await post("/games/reorder", { ids: [1, "2"] })).status, 400);
  assert.equal((await post("/games/reorder", { ids: [1, 1] })).status, 400);
  assert.equal(gh.writes, 0);
});

await test("reorder dispatches no workflow — nothing it changes is a synced field", async () => {
  const gh = fakeGitHub({ games: [baseGame({ id: 1, s: "queue" }), baseGame({ id: 2, s: "queue" })] });
  const res = await post("/games/reorder", { ids: [2, 1] });
  assert.equal(res.status, 200);
  assert.equal(gh.dispatches.length, 0, "only /games/add should ever dispatch");
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
