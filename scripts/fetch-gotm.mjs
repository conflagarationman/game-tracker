#!/usr/bin/env node
// Mirrors r/SBCGaming's Game of the Month club into gotm.json, so index.html can show which
// club picks are still claimable and how long is left on each.
//
// The club's own post is the single source of truth and it's unusually convenient: every
// month's post carries a "Previous Games of the Month:" list covering the entire history with
// RETIRED / LAST CHANCE markers. So one fetch reproduces the whole club state — there's no
// month-by-month accumulation to get out of step, and a missed run self-heals on the next one.
//
// The post is read from Arctic Shift, a free, maintained Reddit archive, not from Reddit. Reddit
// itself is a dead end for this: unauthenticated reddit.com 403s from cloud IP ranges, which is
// where GitHub Actions runners live, and since late 2025 its Responsible Builder Policy puts
// every new OAuth app behind manual pre-approval that personal scripts rarely get. This repo
// never had working keys (gotm.json was seeded by hand). Arctic Shift needs no key, archives
// new posts as they appear, and returns the full selftext. It's a third party with no uptime
// guarantee, which is why a failed fetch keeps the last known picks and turns the run red.
//
// Everything above the network boundary is a pure function so the parsing and the date maths
// are unit-tested against a captured post, the same discipline as sync-apis.mjs.

import fs from "node:fs/promises";
import { pathToFileURL } from "node:url";

const FILE = "gotm.json";
const SUBREDDIT = "SBCGaming";

const ARCTIC_SHIFT = "https://arctic-shift.photon-reddit.com/api/posts/search";
// A free service asking callers to go easy: identify this job so a problem can be traced to it.
const USER_AGENT = "game-tracker-gotm/2.0 (+https://github.com/conflagarationman/game-tracker)";
// One search per title format parseTitle() accepts. The host-picked months are titled
// "<host> Presents SEP '26 GotM - ...", which a "Game of the Month" search never returns.
const TITLE_QUERIES = ["Game of the Month", "GotM"];
// Who posts the picks. Every pick post since at least March 2026 is hbi2k's, in both title
// formats. Looking up a host's recent posts is an indexed filter, not a full-text search:
// probed from an Actions runner on 2026-10-01 it answered in 1.3s, while the title searches
// took 5-8s and intermittently hit Arctic Shift's "Timeout. Maybe slow down a bit" 422,
// with or without a date range. The title searches stay only as a fallback for a new host.
export const GOTM_HOSTS = ["hbi2k"];
const HOST_LOOKBACK_DAYS = 75;


const MONTHS = ["January","February","March","April","May","June",
                "July","August","September","October","November","December"];
const SHORT = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

// The club's window: a pick stays claimable for twelve months after its own month, then
// retires. Verified against the August 2026 post, where Aug 2025 reads RETIRED (12 months
// elapsed) and Sep 2025 reads LAST CHANCE! (one month remaining).
export const ELIGIBLE_MONTHS = 12;

// "2026-08" <-> absolute month index, so arithmetic never has to think about year boundaries.
export function monthIndex(ym) {
  const m = /^(\d{4})-(\d{2})$/.exec(ym || "");
  if (!m) return null;
  return Number(m[1]) * 12 + (Number(m[2]) - 1);
}

export function toYm(name, year) {
  let i = MONTHS.findIndex(x => x.toLowerCase() === String(name).toLowerCase());
  if (i === -1) i = SHORT.findIndex(x => x.toLowerCase() === String(name).toLowerCase());
  if (i === -1) return null;
  const y = String(year).length === 2 ? Number(year) + 2000 : Number(year);
  return `${y}-${String(i + 1).padStart(2, "0")}`;
}

// The "Mon YYYY" form games.json stores in its gotm tag, which is the join key between a
// tracked game and a club pick.
export function toTag(ym) {
  const idx = monthIndex(ym);
  if (idx == null) return null;
  return `${SHORT[idx % 12]} ${Math.floor(idx / 12)}`;
}

// Months of eligibility remaining, counted from `nowYm`. 0 or less means retired; exactly 1 is
// the club's "LAST CHANCE!". Derived rather than read from the post's markers, because those
// markers are a snapshot from whenever the post was written and go stale as months pass —
// while this stays correct even if the fetch has been failing for weeks.
export function monthsLeft(pickYm, nowYm) {
  const pick = monthIndex(pickYm), now = monthIndex(nowYm);
  if (pick == null || now == null) return null;
  return pick + ELIGIBLE_MONTHS - now;
}

// Post titles normally look like "August 2026 Game of the Month - Marvel vs. Capcom 2
// (Dreamcast)". Starting Sep 2026 the club alternates that with a second host-picked format
// — "hbi2k Presents SEP '26 GotM - Civilization Revolution (DS)" — for months where a
// randomly-chosen mod gets carte blanche instead of the usual by-committee pick. The platform
// is optional in both: not every month has carried one. The "<host> Presents" prefix is
// optional too: the Oct 2026 post was plain "OCT '26 GotM - Parasite Eve (PS1)".
const STANDARD_TITLE_RE = /^([A-Za-z]+)\s+(\d{4})\s+Game of the Month\s*[-–—]\s*(.+?)\s*$/;
const HOST_TITLE_RE = /^(?:.+?\s+Presents\s+)?([A-Za-z]+)\s*['’](\d{2})\s+GotM\s*[-–—]\s*(.+?)\s*$/i;

export function parseTitle(title) {
  const t = String(title || "");
  const m = STANDARD_TITLE_RE.exec(t) || HOST_TITLE_RE.exec(t);
  if (!m) return null;
  const ym = toYm(m[1], m[2]);
  if (!ym) return null;
  let game = m[3], platform = null;
  const p = /^(.*?)\s*\(([^()]+)\)\s*$/.exec(game);
  if (p) { game = p[1].trim(); platform = p[2].trim(); }
  return { month: ym, game: game.trim(), platform };
}

// The body's history block. Lines look like:
//   December 2024 - Super Mario World - RETIRED
//   September 2025 - Age of Zombies - LAST CHANCE!
//   October 2025 - Castlevania: Symphony of the Night
// Game titles legitimately contain hyphens and colons, so the trailing status is matched as a
// specific keyword rather than "whatever follows the last dash".
export function parsePreviousList(body) {
  const out = [];
  const seen = new Set();
  for (const raw of String(body || "").split(/\r?\n/)) {
    const line = raw.replace(/^[*\-+]\s+/, "").trim();
    const m = /^([A-Za-z]+)\s+(\d{4})\s*[-–—]\s*(.+?)\s*(?:[-–—]\s*(RETIRED|LAST CHANCE!?)\s*)?$/i.exec(line);
    if (!m) continue;
    const ym = toYm(m[1], m[2]);
    if (!ym || seen.has(ym)) continue;
    seen.add(ym);
    out.push({
      month: ym,
      game: stripMarkdownLink(m[3]),
      url: linkTarget(m[3]),
      postedStatus: m[4] ? m[4].toUpperCase().replace(/!$/, "") : null,
    });
  }
  // Chronological, but never assume the months are contiguous: the August 2026 post's own list
  // jumps June 2026 straight to the current pick, with no July 2026 entry at all.
  return out.sort((a, b) => monthIndex(a.month) - monthIndex(b.month));
}

function stripMarkdownLink(s) {
  const m = /^\[([^\]]+)\]\([^)]*\)$/.exec(s.trim());
  return (m ? m[1] : s).trim();
}

function linkTarget(s) {
  const m = /^\[[^\]]+\]\(([^)]*)\)$/.exec(s.trim());
  return m ? m[1] : null;
}

// Merges the current pick into the history and decorates every entry with derived eligibility.
// `flairEarned` is deliberately absent here: that's human-owned state living in games.json, and
// this file is bot-written and overwritten wholesale on every run.
// `known` is the last gotm.json's picks. The newest post is not always a full record: the
// host-presented months ("hbi2k Presents SEP '26 GotM") carry no "Previous Games of the
// Month" list at all, so rebuilding from the post alone would wipe the whole history down to
// one pick. Months are therefore only ever added or updated, never dropped: known picks
// first, then the post's own list over them, then the current pick over both.
export function buildPicks({ current, previous, known = [] }, nowYm) {
  const byMonth = new Map();
  for (const p of known) {
    if (!p || !p.month) continue;
    // isCurrent is re-derived below from the newest post, never carried over.
    byMonth.set(p.month, { month: p.month, game: p.game, platform: p.platform ?? null, url: p.url ?? null });
  }
  for (const p of previous) byMonth.set(p.month, { ...(byMonth.get(p.month) || {}), ...p });
  if (current) {
    byMonth.set(current.month, { ...(byMonth.get(current.month) || {}), ...current, isCurrent: true });
  }
  return [...byMonth.values()]
    .map(p => {
      const left = monthsLeft(p.month, nowYm);
      return {
        month: p.month,
        tag: toTag(p.month),
        game: p.game,
        platform: p.platform ?? null,
        url: p.url ?? null,
        monthsLeft: left,
        retired: left != null && left <= 0,
        lastChance: left === 1,
        isCurrent: !!p.isCurrent,
      };
    })
    .sort((a, b) => monthIndex(a.month) - monthIndex(b.month));
}

export function ymNow(date = new Date()) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

// ─── Network ──────────────────────────────────────────────────────────────────
// Arctic Shift sheds load by rejecting requests (it has answered 422 to a search that
// succeeded moments later from elsewhere), and says rate limits are "calculated dynamically
// based on server load and request complexity". So: one retry after a pause for those
// statuses, and the response body in the error, since a bare status code gave nothing to
// diagnose the first time.
const RETRY_STATUSES = new Set([422, 429, 500, 502, 503, 504]);

async function searchPosts(params, label, fetchImpl, { retryDelayMs = 5000 } = {}) {
  const url = new URL(ARCTIC_SHIFT);
  url.searchParams.set("subreddit", SUBREDDIT);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set("sort", "desc");
  url.searchParams.set("limit", "25");
  for (let attempt = 1; ; attempt++) {
    const res = await fetchImpl(url, { headers: { "User-Agent": USER_AGENT } });
    if (res.ok) {
      const data = await res.json();
      if (data?.error) throw new Error(`arctic shift search ${label}: ${data.error}`);
      return Array.isArray(data?.data) ? data.data : [];
    }
    if (attempt < 2 && RETRY_STATUSES.has(res.status)) {
      await new Promise(r => setTimeout(r, retryDelayMs));
      continue;
    }
    const body = (await res.text().catch(() => "")).replace(/\s+/g, " ").slice(0, 200);
    throw new Error(`arctic shift search ${label} -> ${res.status}${body ? `: ${body}` : ""}`);
  }
}

function newestPick(posts) {
  const byId = new Map();
  for (const p of posts) if (p && p.title) byId.set(p.id ?? p.permalink ?? p.title, p);
  const sorted = [...byId.values()].sort((a, b) => (Number(b.created_utc) || 0) - (Number(a.created_utc) || 0));
  const p = sorted.find(x => parseTitle(x.title));
  return p ? { title: p.title, body: p.selftext || "", url: p.permalink ? `https://www.reddit.com${p.permalink}` : null } : null;
}

// Newest pick post. First the hosts' own recent posts (fast and reliable, see GOTM_HOSTS),
// then, only if that finds nothing parseable, the slow title searches, each tolerated on its
// own. A title search alone can miss the newest format and land on last month's post; main()
// refuses any pick older than the one already known, so that can't move "current" backwards.
export async function fetchLatestGotmPost(fetchImpl = fetch, opts = {}) {
  const now = opts.now || new Date();
  const after = new Date(now.getTime() - HOST_LOOKBACK_DAYS * 86400000).toISOString().slice(0, 10);
  const errors = [];

  const hostPosts = [];
  for (const author of GOTM_HOSTS) {
    try { hostPosts.push(...await searchPosts({ author, after }, `author=${author}`, fetchImpl, opts)); }
    catch (e) { errors.push(e.message); }
  }
  const fromHost = newestPick(hostPosts);
  if (fromHost) return fromHost;

  // One after the other, not in parallel: concurrent full-text searches are exactly the
  // "request complexity" a load-shedding free service pushes back on.
  const titlePosts = [];
  for (const q of TITLE_QUERIES) {
    try { titlePosts.push(...await searchPosts({ title: q }, `"${q}"`, fetchImpl, opts)); }
    catch (e) { errors.push(e.message); }
  }
  const fromTitle = newestPick(titlePosts);
  if (fromTitle) return fromTitle;

  throw new Error(errors.length ? errors.join("; ")
    : `no post matching a Game of the Month title (${hostPosts.length} host posts, ${titlePosts.length} title-search posts)`);
}

// A fallback title search can come back without the newest post and land on an older pick.
// The month already known is the floor: anything older is an incomplete search, not news.
export function assertNotBackwards(current, knownPicks, title) {
  const knownLatest = (knownPicks || []).map(p => p.month).filter(Boolean)
    .sort((a, b) => monthIndex(a) - monthIndex(b)).pop();
  if (knownLatest && monthIndex(current.month) < monthIndex(knownLatest)) {
    throw new Error(`newest post found is for ${current.month}, older than the known ${knownLatest}: refusing to move the current pick backwards (${title})`);
  }
}

// Merge, never replace: a fetch that fails or returns something unparseable must leave the
// last known-good picks intact. Wiping the list on a bad night would take the banner down
// precisely when nobody is looking at why.
export function mergeResult(previousFile, next, nowYm, error) {
  const base = previousFile && Array.isArray(previousFile.picks) ? previousFile : { picks: [], current: null, sourceUrl: null };
  if (error) {
    return { ...base, fetchedAt: new Date().toISOString(), error: String(error.message || error) };
  }
  return {
    fetchedAt: new Date().toISOString(),
    sourceUrl: next.sourceUrl ?? base.sourceUrl ?? null,
    generatedFor: nowYm,
    current: next.current ?? null,
    picks: next.picks,
    error: null,
  };
}

async function main() {
  let previousFile = null;
  try { previousFile = JSON.parse(await fs.readFile(FILE, "utf8")); } catch { /* first run */ }

  const nowYm = ymNow();
  let out, failure = null;
  try {
    const post = await fetchLatestGotmPost();
    const current = parseTitle(post.title);
    const previous = parsePreviousList(post.body);
    if (!current) throw new Error(`could not parse a pick from title: ${post.title}`);
    assertNotBackwards(current, previousFile?.picks, post.title);
    const picks = buildPicks({ current: { ...current, url: post.url }, previous, known: previousFile?.picks }, nowYm);
    out = mergeResult(previousFile, { sourceUrl: post.url, current: { ...current, url: post.url }, picks }, nowYm, null);
    console.log(`GOTM: ${picks.length} picks, current ${current.month} — ${current.game}`);
  } catch (e) {
    failure = e;
    out = mergeResult(previousFile, null, nowYm, e);
    console.error(`GOTM fetch failed: ${e.message}`);
    if (previousFile) console.error(`Kept ${previousFile.picks?.length ?? 0} previously-known picks; the banner will show this as stale.`);
  }

  await fs.writeFile(FILE, JSON.stringify(out, null, 2) + "\n");

  // The error marker is written first, then this exits non-zero so the workflow goes red and
  // GitHub's own failure notification fires. That's the "tell me when the fetch breaks"
  // channel, and it needs no extra service or secret.
  if (failure) process.exit(1);
}

// argv[1] is undefined under `node -e` / `--input-type=module`, and pathToFileURL throws on
// undefined rather than returning null — so guard it, or merely *importing* this module from
// such a context crashes before any of its exports can be used.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(e => { console.error(e); process.exit(1); });
}
