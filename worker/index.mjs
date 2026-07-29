// Write endpoint for the tracker's admin page (../add.html). The page can't commit to
// GitHub itself: doing that needs a token, and anything the page holds is public because
// the site is a static public repo. So the token lives here as a Worker secret and the
// browser never sees it — same architecture as steph-tv-tracker's worker/index.mjs.
//
// Reads don't go through this Worker at all: games.json is already fully public on GitHub
// Pages, so the admin page just fetches it directly, the same way index.html does. This
// Worker only ever handles the three writes: add, edit, delete.
//
// Commits land on `main`, unlike steph-tv-tracker's `data` branch — that split exists there
// because marking an episode watched happens constantly and a `main` commit would trigger a
// Pages rebuild every time. Adding/editing a game happens rarely enough that a rebuild per
// edit isn't a real cost, and `main` is simpler: no branch to reconcile before it's visible.
//
// POST /games/add     body: {t, p, s, ...any other known field} -> appended with a fresh id
//                      and defaults for anything not supplied. Also immediately dispatches
//                      sync-games.yml and backfill-covers.yml (best-effort, see
//                      triggerSyncWorkflows below) instead of making the new game wait for
//                      their normal daily/weekly schedules.
// POST /games/edit     body: {id, ...fields to change} -> patches the matching game.
// POST /games/delete   body: {id} -> removes the matching game.
// POST /games/reorder  body: {ids} -> reorders the queue ("Up next") entries in place; the id
//                      set must match the current queue exactly or it 409s. No workflow
//                      dispatch, since no synced field changes.
//
// Every write reads the current file fresh, applies the change, and writes back with a sha
// check, retrying on conflict — safe against racing the daily sync-games.yml/
// backfill-covers.yml bots, which commit to this same file on this same branch.
//
// GITHUB_TOKEN needs Contents:read-and-write (for the writes above) AND
// Actions:read-and-write (to dispatch those two workflows on add) — see worker/README.md.

const FILE = "games.json";
const UA = "game-tracker-admin";

const VALID_PLATFORMS = new Set(["steam", "steamdeck", "ps5", "switch", "switch2", "ayn", "retro", "wiiu"]);
const VALID_STATUSES = new Set(["playing", "queue", "soon", "done", "dropped"]);
// Mirrors the badge map in index.html's masteryBadge() — an unknown value there renders as
// nothing at all, so a typo would silently vanish from the card rather than show up wrong.
const VALID_MASTERY = new Set(["in-progress", "mastered", "platinum", "100pct"]);

const DEFAULT_GAME = {
  r: 0, h: null, cy: null, cm: null, gotm: null, mastery: null, diff: null,
  achPct: null, achCount: null, actualHours: null, lastPlayed: null,
  casual: false, note: null, start: null, queued: null,
};

const json = (body, status, origin) => new Response(JSON.stringify(body), {
  status,
  headers: {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": origin,
    "Cache-Control": "no-store",
  },
});

function httpError(message, status) {
  return Object.assign(new Error(message), { status });
}

async function gh(env, path, init = {}) {
  return fetch(`https://api.github.com/repos/${env.REPO}/${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "User-Agent": UA,
      ...(init.headers || {}),
    },
  });
}

async function readGames(env) {
  const res = await gh(env, `contents/${FILE}?ref=${env.BRANCH}`);
  if (!res.ok) throw new Error(`read ${res.status}: ${await res.text()}`);
  const meta = await res.json();
  // atob is fine here: the payload is ASCII JSON, and Workers has no Buffer.
  const decoded = decodeURIComponent(escape(atob(meta.content.replace(/\n/g, ""))));
  return { games: JSON.parse(decoded), sha: meta.sha };
}

async function writeGames(env, games, sha, message) {
  const body = {
    message,
    content: btoa(unescape(encodeURIComponent(JSON.stringify(games, null, 2) + "\n"))),
    branch: env.BRANCH,
    committer: { name: "game-tracker-admin", email: "actions@users.noreply.github.com" },
    sha,
  };
  return gh(env, `contents/${FILE}`, { method: "PUT", body: JSON.stringify(body) });
}

// Applies `mutate` (games[] -> games[]) against the latest server copy, retrying on a sha
// conflict — the same read-modify-write-retry shape as steph-tv-tracker's syncWithRetry,
// just without a merge step: there's nothing to reconcile since `mutate` always starts from
// the freshest copy on each attempt, not a possibly-stale client-held one.
async function mutateWithRetry(env, mutate, message, attempts = 4) {
  let last;
  for (let i = 0; i < attempts; i++) {
    const { games, sha } = await readGames(env);
    const next = mutate(games);
    const res = await writeGames(env, next, sha, message);
    if (res.ok) return next;
    last = `${res.status}: ${await res.text()}`;
    if (res.status !== 409 && res.status !== 422) throw new Error(`write ${last}`);
    await new Promise(r => setTimeout(r, 150 * (i + 1)));
  }
  throw new Error(`write failed after ${attempts} attempts — ${last}`);
}

// Range/enum checks for the optional numeric and enum fields, shared by add and edit. Every
// one of these may legitimately be null ("unset"), so null/undefined always passes — this
// only rejects values that are *present but wrong*, which is the case that would otherwise
// fail silently rather than loudly: index.html renders an out-of-range diff/mastery as no
// badge at all, and a cm outside 0-11 indexes past the end of its month-name array.
export function validateGameFields(input) {
  const int = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
  if (input.cm != null && !int(input.cm, 0, 11)) return "completion month (cm) must be an integer 0-11";
  if (input.cy != null && !int(input.cy, 1970, 2100)) return "completion year (cy) must be an integer 1970-2100";
  if (input.y != null && !int(input.y, 1970, 2100)) return "release year (y) must be an integer 1970-2100";
  if (input.diff != null && !int(input.diff, 1, 5)) return "difficulty (diff) must be an integer 1-5";
  if (input.r != null && !(typeof input.r === "number" && input.r >= 0 && input.r <= 10)) {
    return "rating (r) must be a number 0-10";
  }
  if (input.mastery != null && !VALID_MASTERY.has(input.mastery)) {
    return `mastery must be one of: ${[...VALID_MASTERY].join(", ")}`;
  }
  return null;
}

export function validateNewGame(input) {
  if (!input || typeof input !== "object") return "body must be an object";
  if (!input.t || typeof input.t !== "string" || !input.t.trim()) return "title (t) is required";
  if (!VALID_PLATFORMS.has(input.p)) return `platform (p) must be one of: ${[...VALID_PLATFORMS].join(", ")}`;
  if (!VALID_STATUSES.has(input.s)) return `status (s) must be one of: ${[...VALID_STATUSES].join(", ")}`;
  return validateGameFields(input);
}

export async function addGame(env, input) {
  const err = validateNewGame(input);
  if (err) throw httpError(err, 400);
  return mutateWithRetry(env, (games) => {
    const id = Math.max(0, ...games.map(g => g.id)) + 1;
    const game = { ...DEFAULT_GAME, ...input, t: input.t.trim(), id };
    return [...games, game];
  }, `Add game: ${input.t.trim()}`);
}

export async function editGame(env, id, patch) {
  if (typeof id !== "number") throw httpError("id must be a number", 400);
  if (patch.p !== undefined && !VALID_PLATFORMS.has(patch.p)) throw httpError("invalid platform", 400);
  if (patch.s !== undefined && !VALID_STATUSES.has(patch.s)) throw httpError("invalid status", 400);
  const fieldErr = validateGameFields(patch);
  if (fieldErr) throw httpError(fieldErr, 400);
  return mutateWithRetry(env, (games) => {
    const idx = games.findIndex(g => g.id === id);
    if (idx === -1) throw httpError(`no game with id ${id}`, 404);
    const next = [...games];
    next[idx] = { ...next[idx], ...patch };
    return next;
  }, `Edit game #${id}`);
}

// Up Next's 1..N numbering on the page is just games.json array order, so reordering that
// array *is* the reorder — no new priority field, which is why this is possible at all
// (index.html's drag code deferred in-section reordering on the grounds that it "would need
// a new order/priority field this schema doesn't have"). The sync scripts all look games up
// by id, so array position is invisible to them.
//
// Only the queue entries move: their existing array indices are collected and refilled in the
// submitted order, leaving every other game exactly where it was. That keeps the commit diff
// to the queue rows instead of rewriting the file's whole ordering.
//
// The submitted id set must match the current queue set exactly. A stale client — one that
// loaded before a game was added to the queue, or before a drag moved one out of it — would
// otherwise silently drop or resurrect entries; 409 tells the page to reload instead.
export async function reorderQueue(env, ids) {
  if (!Array.isArray(ids) || !ids.every(n => typeof n === "number")) {
    throw httpError("ids must be an array of numbers", 400);
  }
  if (new Set(ids).size !== ids.length) throw httpError("ids must not contain duplicates", 400);
  return mutateWithRetry(env, (games) => {
    const positions = [];
    games.forEach((g, i) => { if (g.s === "queue") positions.push(i); });
    const current = positions.map(i => games[i].id);
    const same = current.length === ids.length && current.every(id => ids.includes(id));
    if (!same) {
      throw httpError(
        `up-next has changed since this list was loaded (server has ${current.length} queued, request had ${ids.length}) — reload and try again`,
        409,
      );
    }
    const byId = new Map(games.map(g => [g.id, g]));
    const next = [...games];
    positions.forEach((pos, n) => { next[pos] = byId.get(ids[n]); });
    return next;
  }, `Reorder up next (${ids.length} games)`);
}

export async function deleteGame(env, id) {
  if (typeof id !== "number") throw httpError("id must be a number", 400);
  return mutateWithRetry(env, (games) => {
    const idx = games.findIndex(g => g.id === id);
    if (idx === -1) throw httpError(`no game with id ${id}`, 404);
    return games.filter(g => g.id !== id);
  }, `Delete game #${id}`);
}

// Fires the daily Steam/RA sync and the SteamGridDB cover backfill immediately after a new
// game is added, instead of making it wait for their normal daily/weekly schedules. Reuses
// gh() as-is — the Actions dispatch endpoint needs the exact same repo base URL and auth
// header the Contents API calls already use. Both workflows have workflow_dispatch:{} with
// no required inputs, so the body only needs a ref.
//
// Best-effort and never throws: the game is already committed by the time this runs, so a
// dispatch failure (e.g. the token lacks Actions:write, or GitHub hiccups) must never fail
// or roll back the add itself — it only means the new game waits for the normal schedule
// instead of syncing immediately.
async function triggerWorkflow(env, workflowFile) {
  try {
    const res = await gh(env, `actions/workflows/${workflowFile}/dispatches`, {
      method: "POST",
      body: JSON.stringify({ ref: env.BRANCH }),
    });
    if (!res.ok) return { workflow: workflowFile, ok: false, error: `${res.status}: ${await res.text()}` };
    return { workflow: workflowFile, ok: true };
  } catch (e) {
    return { workflow: workflowFile, ok: false, error: String(e.message || e) };
  }
}

export async function triggerSyncWorkflows(env) {
  return Promise.all([
    triggerWorkflow(env, "sync-games.yml"),
    triggerWorkflow(env, "backfill-covers.yml"),
  ]);
}

export default {
  async fetch(request, env) {
    const origin = env.ALLOWED_ORIGIN || "*";
    const reqOrigin = request.headers.get("Origin");

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": origin,
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, X-Sync-Key",
          "Access-Control-Max-Age": "86400",
        },
      });
    }

    // Only the site may call this from a browser. Not a security boundary — a non-browser
    // client can send any Origin it likes — but it stops other pages using the endpoint.
    if (reqOrigin && env.ALLOWED_ORIGIN && reqOrigin !== env.ALLOWED_ORIGIN) {
      return json({ error: "origin not allowed" }, 403, origin);
    }

    // The page is public, so this key is public too: it deters drive-by writes, it does not
    // authenticate anyone. The real safety net is that every write is a git commit — anything
    // unwanted is recoverable with git revert.
    if (env.SYNC_KEY && request.headers.get("X-Sync-Key") !== env.SYNC_KEY) {
      return json({ error: "bad key" }, 401, origin);
    }

    if (request.method !== "POST") return json({ error: "method not allowed" }, 405, origin);

    const url = new URL(request.url);
    try {
      let body;
      try { body = await request.json(); }
      catch { return json({ error: "body must be JSON" }, 400, origin); }

      if (url.pathname.endsWith("/games/add")) {
        const games = await addGame(env, body);
        const triggers = await triggerSyncWorkflows(env);
        return json({ games, triggers }, 200, origin);
      }
      if (url.pathname.endsWith("/games/edit")) {
        const { id, ...patch } = body;
        const games = await editGame(env, id, patch);
        return json(games, 200, origin);
      }
      if (url.pathname.endsWith("/games/delete")) {
        const games = await deleteGame(env, body.id);
        return json(games, 200, origin);
      }
      // No triggerSyncWorkflows here, unlike /games/add: reordering changes no field that
      // Steam/RA sync or the cover backfill reads, so dispatching them would burn two
      // Actions runs to produce an identical file.
      if (url.pathname.endsWith("/games/reorder")) {
        const games = await reorderQueue(env, body.ids);
        return json(games, 200, origin);
      }
      return json({ error: "not found" }, 404, origin);
    } catch (e) {
      // Never 200 on a failed write: the page must show the error, not assume it saved.
      return json({ error: String(e.message || e) }, e.status || 502, origin);
    }
  },
};
