// ros_projections.js — GET /api/ros-projections (Keith 2026-10-30, recorded on #1433). Serves the rest-of-season file
// pipelines/etl/scripts/build_ros_projections.py stores at ros/latest.json in R2 for the Front Office's Projected ROS PPG.
// One R2 read, no D1. Each player's number leaves with his weekly line and why any week is missing (`avail`): the Front
// Office builds a best lineup for each remaining week and averages them ("ROS availability A", Keith 2026-10-30, #1435).
//
// FAILS CLOSED: no file, an unreadable file, another season or a file older than ROS_MAX_AGE_DAYS gets ok:false, never
// numbers. The screen then says the projection is unavailable and stays on season PPG.
export const ROS_KEY = "ros/latest.json";
export const ROS_MAX_AGE_DAYS = 8;
const DAY_MS = 86400000;

function fail(status, error, extra) {
  return { status, payload: { ok: false, error, ...(extra || {}) } };
}

export function rosAnswer(file, season, nowMs) {
  if (!file || typeof file !== "object" || file.version !== 1 || !file.players || typeof file.players !== "object") return fail(503, "unreadable");
  if (file.season !== season) return fail(404, "wrong_season", { fileSeason: file.season });
  const asOf = Date.parse(file.asOf);
  if (!Number.isFinite(asOf)) return fail(503, "unreadable");
  if (nowMs - asOf > ROS_MAX_AGE_DAYS * DAY_MS) return fail(503, "stale", { asOf: file.asOf });
  if (!Array.isArray(file.weeks) || !Number.isInteger(file.nWeeks) || file.nWeeks < 1 || !file.avail || typeof file.avail !== "object") return fail(503, "unreadable");
  const players = {}, weekly = {};
  for (const [pid, row] of Object.entries(file.players)) {
    if (!row || typeof row.ppg !== "number" || !Number.isFinite(row.ppg)) continue;
    if (!Array.isArray(row.w) || row.w.length !== file.nWeeks) return fail(503, "unreadable");
    players[pid] = row.ppg;
    weekly[pid] = row.w;
  }
  return { status: 200, payload: { ok: true, season, throughWeek: file.throughWeek, weeks: file.weeks, nWeeks: file.nWeeks,
    asOf: file.asOf, label: file.label, sources: file.sources, playedExcluded: file.playedExcluded, rule: file.rule, players, weekly, avail: file.avail } };
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
