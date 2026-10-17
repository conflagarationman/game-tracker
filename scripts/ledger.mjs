// The two bot-owned ledgers behind the year in review.
//
// ledger.json: every tracked game's actualHours, one snapshot per day. Before it existed the
// only record of how hours moved was games.json's git history, which is why this repo must
// never be squashed until the backfill below has run. It is the source for "hours played this
// year" across every game, finished or not (wrapped-stats.js turns snapshots into hours).
//
// achievements-log.json: one row per unlock with its timestamp, for the night-owl, busiest-day,
// streak and rarest-unlock cards. Steam keeps unlock times forever, so the first sync fills in
// every year at once; RetroAchievements is read from a window and merged.
//
// Both are merged, never rebuilt from scratch: a Steam or RA outage keeps every row already
// there, and rows are only ever added or updated in place.

export const LEDGER_VERSION = 1;

const round1 = (h) => Math.round(h * 10) / 10;

// ─── ledger.json ──────────────────────────────────────────

// games.json's git history was written under two definitions of actualHours. Up to the sync on
// 2026-10-11 it was Steam's raw playtime, which includes ASF's card idling; from 2026-10-12 it is
// playtime minus the hub's farm ledger. RAW_UNTIL is the last day of the raw definition.
export const RAW_UNTIL = "2026-10-11";

// minutes idled per appid per day (the hub's /asf/farm-ledger `apps`) -> the cumulative hours
// idled through a given day, for one appid.
export function idleThrough(farmApps, appid) {
  const days = Object.entries(farmApps?.[appid]?.days || {}).sort(([a], [b]) => a.localeCompare(b));
  return (date) => {
    let m = 0;
    for (const [d, mins] of days) { if (d > date) break; m += mins; }
    return m / 60;
  };
}

// The backfill: dated games.json snapshots (oldest first, at most one per day) -> ledger days.
// Raw-era values have every minute idled through that day taken out, so the whole ledger reads
// as one definition and the 10/12 switch isn't a cliff. `appids` maps tracker id -> Steam appid
// for games ASF has idled (asf-idle.json's byGame); no appid means nothing to take out.
export function buildLedgerFromHistory(snapshots, { farmApps = {}, appids = {} } = {}) {
  const idleFor = {};
  const days = {};
  for (const { date, games } of snapshots) {
    const row = {};
    for (const g of games) {
      if (g.actualHours == null) continue;
      let h = g.actualHours;
      const appid = appids[g.id];
      if (date <= RAW_UNTIL && appid) {
        idleFor[appid] ||= idleThrough(farmApps, appid);
        h = Math.max(0, h - idleFor[appid](date));
      }
      row[g.id] = round1(h);
    }
    days[date] = row;
  }
  return { version: LEDGER_VERSION, since: snapshots.length ? snapshots[0].date : null, rawUntil: RAW_UNTIL, days };
}

// The daily append: today's actualHours for every game that has some. A second run the same day
// replaces the row (the later run has the later numbers).
export function appendLedgerDay(ledger, games, date) {
  const out = ledger && ledger.days ? ledger : { version: LEDGER_VERSION, since: date, rawUntil: RAW_UNTIL, days: {} };
  const row = {};
  for (const g of games) if (g.actualHours != null) row[g.id] = g.actualHours;
  out.days[date] = row;
  if (!out.since || date < out.since) out.since = date;
  return out;
}

// One day per line, days in order, ids in order, so a day's commit is one added line.
export function formatLedger(ledger) {
  const dates = Object.keys(ledger.days).sort();
  const line = (d) => {
    const row = ledger.days[d];
    const ids = Object.keys(row).map(Number).sort((a, b) => a - b);
    return `  ${JSON.stringify(d)}: {${ids.map(id => `"${id}":${row[id]}`).join(",")}}`;
  };
  return `{"version": ${ledger.version}, "since": ${JSON.stringify(ledger.since)}, "rawUntil": ${JSON.stringify(ledger.rawUntil)},\n"days": {\n${dates.map(line).join(",\n")}\n}}\n`;
}

// ─── achievements-log.json ────────────────────────────────

// A row: { src: "steam"|"ra", id (tracker id or null), key (unique per unlock), ts (unix
// seconds, UTC), name, game, pct (Steam global unlock %, when known), hc (RA hardcore) }.

// Steam's GetPlayerAchievements for one tracked game -> its unlock rows.
export function steamUnlockRows(game, appid, achievements) {
  return (achievements || [])
    .filter(a => a.achieved === 1 && a.unlocktime > 0)
    .map(a => ({ src: "steam", id: game.id, key: `steam:${appid}:${a.apiname}`, ts: a.unlocktime,
      name: a.name || a.apiname, game: game.t, pct: null }));
}

// RA's dates come back as "2026-10-12 21:33:05" with no zone. RA's servers keep UTC, so the
// string is read as UTC; wrapped-stats.js does every hour-of-day and day bucket in Eastern time.
export function raTimestamp(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(String(s || ""));
  return m ? Date.UTC(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6]) / 1000 : null;
}

// RA's API_GetAchievementsEarnedBetween rows -> unlock rows. `idOf` maps an RA game title to a
// tracker id (resolveRaTitles), or null for a game the tracker doesn't have.
export function raUnlockRows(earned, idOf = () => null) {
  return (Array.isArray(earned) ? earned : [])
    .map(a => ({ src: "ra", id: idOf(a.GameTitle), key: `ra:${a.AchievementID}`, ts: raTimestamp(a.Date),
      name: a.Title, game: a.GameTitle, pct: null, hc: Number(a.HardcoreMode) === 1 }))
    .filter(r => r.ts);
}

// Add new rows; a row already there keeps its timestamp and gains anything it was missing
// (a pct found later, a tracker id once the game is added). Never drops a row.
export function mergeUnlocks(existing, rows) {
  const byKey = new Map((existing || []).map(r => [r.key, r]));
  let added = 0;
  for (const r of rows) {
    const old = byKey.get(r.key);
    if (!old) { byKey.set(r.key, r); added++; continue; }
    if (old.pct == null && r.pct != null) old.pct = r.pct;
    if (old.id == null && r.id != null) old.id = r.id;
  }
  const out = [...byKey.values()].sort((a, b) => a.ts - b.ts || a.key.localeCompare(b.key));
  return { rows: out, added };
}

// Where the RA window should start: an hour before the newest RA unlock already logged, or
// Jan 1 of the current year for an empty log, so the first run fills in the year.
export function raWindowStart(rows, now = new Date()) {
  const newest = (rows || []).filter(r => r.src === "ra").reduce((m, r) => Math.max(m, r.ts), 0);
  return newest ? newest - 3600 : Date.UTC(now.getUTCFullYear(), 0, 1) / 1000;
}

export function formatUnlocks(rows) {
  return `{"unlocks": [\n${rows.map(r => "  " + JSON.stringify(r)).join(",\n")}\n]}\n`;
}
