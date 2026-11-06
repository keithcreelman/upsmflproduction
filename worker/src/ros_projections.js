// ros_projections.js — GET /api/ros-projections (Keith 2026-10-30, recorded on #1433). Serves the rest-of-season file
// pipelines/etl/scripts/build_ros_projections.py stores at ros/latest.json in R2 for the Front Office's Projected ROS PPG.
// One R2 read, no D1. Each player's number leaves with his weekly line and why any week is missing (`avail`): the Front
// Office builds a best lineup for each remaining week and averages them ("ROS availability A", Keith 2026-10-30, #1435).
//
// A GAME THAT HAS KICKED OFF IS NEVER COUNTED, whichever day the file was built (Keith 2026-10-31, #1434). The build leaves
// out what has started by then, but Wednesday's file is read after Thursday's game, and a failed Sunday run leaves it in
// place for days. So the file keeps each remaining week's kickoffs and each player's team, and this draws the same line
// at read time: his game's cell goes, his number is worked out again over the weeks he has left, and the week joins
// `playedExcluded`, which keeps it out of the Front Office's lineups. `nextKick` is when this answer stops being right;
// the cache never outlives it and a page held open past it reads again.
//
// FAILS CLOSED: no file, an unreadable file, another season, a file older than ROS_MAX_AGE_DAYS or one missing a week's
// kickoffs gets ok:false, never numbers. The screen then says the projection is unavailable and stays on season PPG.
export const ROS_KEY = "ros/latest.json";
export const ROS_MAX_AGE_DAYS = 8;
export const ROS_CACHE_SECONDS = 1800;
const DAY_MS = 86400000;
const MIN_TEAMS = 20;          // a week's schedule with fewer is short (the build refuses the same)

function fail(status, error, extra) {
  return { status, payload: { ok: false, error, ...(extra || {}) } };
}

// { played: {week: [teams]}, fresh: {week: {team: 1}} (kicked off since the build), nextKick }, or null if a week's kickoffs
// are missing or unreadable: it is never assumed that nothing has been played.
function readTimePlayed(file, nowMs) {
  if (!file.kickoffs || typeof file.kickoffs !== "object") return null;
  const now = nowMs / 1000, played = {}, fresh = {};
  let nextKick = null;
  for (let i = 0; i < file.nWeeks; i++) {
    const week = file.weeks[0] + i, kicks = file.kickoffs[week], built = (file.playedExcluded || {})[week] || [];
    if (!kicks || typeof kicks !== "object" || Object.keys(kicks).length < MIN_TEAMS) return null;
    const started = new Set(built);
    for (const [team, kick] of Object.entries(kicks)) {
      if (typeof kick !== "number" || !Number.isFinite(kick)) return null;
      if (kick > now) { if (nextKick === null || kick < nextKick) nextKick = kick; continue; }
      if (!started.has(team)) { started.add(team); (fresh[week] = fresh[week] || {})[team] = 1; }
    }
    if (started.size) played[week] = [...started].sort();
  }
  return { played, fresh, nextKick };
}

// The player's row with his newly started games taken out, on the build's own definition: the sum over the weeks he has
// left divided by how many. Worked from the rounded weekly line, so at most 0.05 from the unrounded build. A player with
// nothing left has no number.
function afterKickoffs(row, file, seen) {
  const w = row.w.slice();
  let left = file.nWeeks, gone = false;
  for (let i = 0; i < file.nWeeks; i++) {
    const week = file.weeks[0] + i;
    if (!(seen.played[week] || []).includes(row.team)) continue;
    left -= 1;
    if (seen.fresh[week] && seen.fresh[week][row.team]) { w[i] = null; gone = true; }
  }
  if (!gone) return row;
  const have = w.filter((v) => v !== null);
  return { ppg: left && have.length ? Math.round(have.reduce((a, b) => a + b, 0) / left * 100) / 100 : null, w };
}

export function rosAnswer(file, season, nowMs) {
  if (!file || typeof file !== "object" || file.version !== 1 || !file.players || typeof file.players !== "object") return fail(503, "unreadable");
  if (file.season !== season) return fail(404, "wrong_season", { fileSeason: file.season });
  const asOf = Date.parse(file.asOf);
  if (!Number.isFinite(asOf)) return fail(503, "unreadable");
  if (nowMs - asOf > ROS_MAX_AGE_DAYS * DAY_MS) return fail(503, "stale", { asOf: file.asOf });
  if (!Array.isArray(file.weeks) || !Number.isInteger(file.nWeeks) || file.nWeeks < 1 || !file.avail || typeof file.avail !== "object") return fail(503, "unreadable");
  const seen = readTimePlayed(file, nowMs);
  if (!seen) return fail(503, "unreadable");
  const players = {}, weekly = {};
  for (const [pid, stored] of Object.entries(file.players)) {
    if (!stored || typeof stored.ppg !== "number" || !Number.isFinite(stored.ppg)) continue;
    if (!Array.isArray(stored.w) || stored.w.length !== file.nWeeks || typeof stored.team !== "string") return fail(503, "unreadable");
    const row = afterKickoffs(stored, file, seen);
    if (row.ppg === null) continue;
    players[pid] = row.ppg;
    weekly[pid] = row.w;
  }
  return { status: 200, payload: { ok: true, season, throughWeek: file.throughWeek, weeks: file.weeks, nWeeks: file.nWeeks,
    asOf: file.asOf, label: file.label, sources: file.sources, playedExcluded: seen.played, nextKick: seen.nextKick, rule: file.rule, players, weekly, avail: file.avail } };
}

// Good answers cache, never past the next kickoff. A refusal is never cached.
export function rosCacheControl(payload, nowMs) {
  if (!payload.ok) return "no-store";
  const left = payload.nextKick === null ? ROS_CACHE_SECONDS : Math.floor(payload.nextKick - nowMs / 1000);
  return "public, max-age=" + Math.max(0, Math.min(ROS_CACHE_SECONDS, left));
}

export async function rosProjections(bucket, seasonParam, nowMs) {
  const season = Number(seasonParam);
  if (!Number.isInteger(season) || season < 2000 || season > 2100) return fail(400, "bad_season");
  if (!bucket) return fail(503, "storage_missing");
  let file;
  try {
    const obj = await bucket.get(ROS_KEY);
    if (!obj) return fail(404, "not_built");
    file = await obj.json();
  } catch (e) {
    return fail(503, "unreadable");
  }
  return rosAnswer(file, season, nowMs);
}
