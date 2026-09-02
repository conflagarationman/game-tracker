#!/usr/bin/env node
// Mirrors r/SBCGaming's Game of the Month club into gotm.json, so index.html can show which
// club picks are still claimable and how long is left on each.
//
// The club's own post is the single source of truth and it's unusually convenient: every
// month's post carries a "Previous Games of the Month:" list covering the entire history with
// RETIRED / LAST CHANCE markers. So one fetch reproduces the whole club state — there's no
// month-by-month accumulation to get out of step, and a missed run self-heals on the next one.
//
// Reddit needs OAuth here. Unauthenticated reddit.com 403s from cloud IP ranges, which is
// exactly where GitHub Actions runners live (three separate fetchers hit this during
// development). REDDIT_CLIENT_ID/REDDIT_CLIENT_SECRET come from a Reddit "script" app.
//
// Everything above the network boundary is a pure function so the parsing and the date maths
// are unit-tested against a captured post, the same discipline as sync-apis.mjs.

import fs from "node:fs/promises";
import { pathToFileURL } from "node:url";

const FILE = "gotm.json";
const SUBREDDIT = "SBCGaming";

// Reddit asks for a descriptive User-Agent in the form <platform>:<app id>:<version> (by
// /u/<user>), and throttles or outright blocks generic ones more aggressively — which would
// look like a credentials problem when it isn't. REDDIT_USERNAME is optional and is only used
// to complete that string; the request authenticates purely on client id/secret.
function userAgent() {
  const who = process.env.REDDIT_USERNAME;
  return `script:game-tracker-gotm:v1.0${who ? ` (by /u/${who})` : ""}`;
}


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
// is optional in both: not every month has carried one.
const STANDARD_TITLE_RE = /^([A-Za-z]+)\s+(\d{4})\s+Game of the Month\s*[-–—]\s*(.+?)\s*$/;
const HOST_TITLE_RE = /^.+?\s+Presents\s+([A-Za-z]+)\s*['’](\d{2})\s+GotM\s*[-–—]\s*(.+?)\s*$/i;

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
export function buildPicks({ current, previous }, nowYm) {
  const byMonth = new Map();
  for (const p of previous) byMonth.set(p.month, { ...p });
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
async function redditToken(fetchImpl = fetch) {
  const id = process.env.REDDIT_CLIENT_ID, secret = process.env.REDDIT_CLIENT_SECRET;
  if (!id || !secret) throw new Error("missing REDDIT_CLIENT_ID/REDDIT_CLIENT_SECRET");
  const res = await fetchImpl("https://www.reddit.com/api/v1/access_token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": userAgent(),
    },
    body: "grant_type=client_credentials",
  });
  if (!res.ok) throw new Error(`reddit auth -> ${res.status}`);
  const data = await res.json();
  if (!data.access_token) throw new Error("reddit auth returned no access_token");
  return data.access_token;
}

// Newest matching post wins. Searching the subreddit rather than the host's profile so a
// change of host doesn't silently stop the sync.
export async function fetchLatestGotmPost(fetchImpl = fetch) {
  const token = await redditToken(fetchImpl);
  const url = new URL(`https://oauth.reddit.com/r/${SUBREDDIT}/search`);
  url.searchParams.set("q", '"Game of the Month"');
  url.searchParams.set("restrict_sr", "true");
  url.searchParams.set("sort", "new");
  url.searchParams.set("limit", "25");
  const res = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}`, "User-Agent": userAgent() } });
  if (!res.ok) throw new Error(`reddit search -> ${res.status}`);
  const data = await res.json();
  const posts = (data?.data?.children || []).map(c => c.data).filter(Boolean);
  for (const p of posts) {
    if (parseTitle(p.title)) {
      return { title: p.title, body: p.selftext || "", url: p.permalink ? `https://www.reddit.com${p.permalink}` : null };
    }
  }
  throw new Error(`no post matching the "<Month> <Year> Game of the Month - <Game>" title found in the newest ${posts.length}`);
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
    const picks = buildPicks({ current: { ...current, url: post.url }, previous }, nowYm);
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
