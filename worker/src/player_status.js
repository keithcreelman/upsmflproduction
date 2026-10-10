// Each player's CURRENT reported status for the mobile Stats → Players list
// and player sheet (Keith 2026-10-10), from two sources kept apart:
//
//   report — this week's OFFICIAL NFL injury report game designation (Out /
//            Doubtful / Questionable), plus the injury and practice status,
//            from nflverse's copy of the league's report (injuries_<season>.csv,
//            refreshed daily; checked 2026-10-10: updated 13:33 UTC that day).
//   roster — the NFL roster designation (IR, IR – designated to return, PUP,
//            NFI, Suspended …) from MFL's injuries export, the source the
//            league's IR rules already use.
//
// WHY two sources. MFL's export mixes both kinds in one `status` field and
// keeps game designations long after they lapse: on 2026-10-10 (Wk 5) 66 of
// its Questionable/Out rows were on unsigned free agents and 26 more were on
// rostered players absent from their team's Wk 5 report (many dated Wk 1 or
// the offseason), while 26 players the official report listed Q/Out showed
// only "IR-R"/"IR-PUP" there. Its roster designations do match NFL
// transactions (IR = reserve/injured 132 of 141, IR-R 39 of 43, PUP 23 of 25;
// the rest are no longer on an NFL roster).
//
// Never "healthy" by default: a feed that can't be read, a report for a week
// other than the current one, or one older than STALE_HOURS is unavailable,
// and the reply says which. A player is "not on the report" only when his
// team's current report was read.
import { TEAM_NORM } from "./starter_rates.js";

export const STALE_HOURS = 36;
export const REPORT_URL = (season) => `https://github.com/nflverse/nflverse-data/releases/download/injuries/injuries_${season}.csv`;
export const MFL_INJURIES_URL = (season) => `https://api.myfantasyleague.com/${season}/export?TYPE=injuries&JSON=1`;
const GAME = { OUT: "Out", DOUBTFUL: "Doubtful", QUESTIONABLE: "Questionable" };
// MFL status token -> the roster designation shown, and its short chip.
export const ROSTER = {
  "IR": { label: "Injured reserve", chip: "IR" },
  "IR-R": { label: "Injured reserve – designated to return", chip: "IR-R" },
  "IR-PUP": { label: "Physically unable to perform", chip: "PUP" },
  "IR-NFI": { label: "Non-football injury list", chip: "NFI" },
  "SUSPENDED": { label: "Suspended", chip: "SUSP" },
  "HOLDOUT": { label: "Holdout", chip: "HOLD" },
  "RETIRED": { label: "Retired", chip: "RET" },
};
const MFL_TEAM = Object.fromEntries(Object.entries(TEAM_NORM).map(([mfl, nfl]) => [nfl, mfl]));

// RFC 4180-ish: quoted fields, doubled quotes, CRLF.
export function parseCsv(text) {
  const rows = [];
  let row = [], f = "", q = false;
  const s = String(text || "");
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '"') { if (s[i + 1] === '"') { f += '"'; i++; } else q = false; }
      else f += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(f); f = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && s[i + 1] === "\n") i++;
      row.push(f); f = ""; rows.push(row); row = [];
    } else f += c;
  }
  if (f !== "" || row.length) { row.push(f); rows.push(row); }
  const head = rows.shift() || [];
  return rows.filter((r) => r.length > 1).map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] == null ? "" : r[i]])));
}

// The newest report week in the file, and its rows by gsis.
export function reportFrom(rows) {
  const reg = rows.filter((r) => /^(REG|POST)$/i.test(r.season_type || r.game_type || "REG"));
  const week = reg.reduce((m, r) => Math.max(m, parseInt(r.week, 10) || 0), 0);
  const byGsis = {}, teams = new Set();
  for (const r of reg) {
    if ((parseInt(r.week, 10) || 0) !== week) continue;
    if (r.team) teams.add(r.team);
    if (!/^00-\d+/.test(r.gsis_id || "")) continue;
    const g = GAME[String(r.report_status || "").trim().toUpperCase()] || null;
    byGsis[r.gsis_id] = {
      status: g,                                         // null = listed with a practice status only
      injury: [r.report_primary_injury, r.report_secondary_injury].filter(Boolean).join(", ") ||
              [r.practice_primary_injury, r.practice_secondary_injury].filter(Boolean).join(", ") || null,
      practice: r.practice_status || null,
      team: r.team || null,
    };
  }
  return { week, byGsis, teams: [...teams].sort() };
}

export function rosterFrom(payload) {
  const node = payload && payload.injuries;
  if (!node) return { ok: false, week: null, ts: null, byMfl: {} };
  const byMfl = {};
  for (const r of [].concat(node.injury || [])) {
    if (!r || r.id == null) continue;
    const tok = String(r.status || "").trim().toUpperCase();
    if (!ROSTER[tok]) continue;                          // Q / D / Out come from the official report instead
    byMfl[String(parseInt(r.id, 10))] = { status: tok, label: ROSTER[tok].label, chip: ROSTER[tok].chip,
      detail: String(r.details || "").trim() || null, exp_return: String(r.exp_return || "").trim() || null };
  }
  const week = parseInt(node.week, 10) || null, ts = parseInt(node.timestamp, 10) || null;
  return { ok: true, week, ts, byMfl };
}

/** gsisToMfl: { gsis: mflId } from the verified id map. now: ms. */
export function assemble({ reportRows, reportModified, reportError, mflPayload, mflError, gsisToMfl, mapError, now }) {
  const roster = mflError ? { ok: false, week: null, ts: null, byMfl: {} } : rosterFrom(mflPayload);
  const currentWeek = roster.ok ? roster.week : null;
  const report_feed = { ok: false, source: "Official NFL injury report (nflverse)", week: null, current_week: currentWeek,
                        updated_utc: null, age_hours: null, current: false, reason: null, teams: [], teams_mfl: [] };
  let rep = null;
  if (reportError || !reportRows) report_feed.reason = "unreadable: " + (reportError || "no data");
  else {
    rep = reportFrom(reportRows);
    report_feed.ok = rep.week > 0;
    report_feed.week = rep.week || null;
    const mod = reportModified ? Date.parse(reportModified) : NaN;
    report_feed.updated_utc = isFinite(mod) ? new Date(mod).toISOString() : null;
    report_feed.age_hours = isFinite(mod) ? Math.round((now - mod) / 360000) / 10 : null;
    report_feed.teams = rep.teams;
    report_feed.teams_mfl = rep.teams.map((t) => MFL_TEAM[t] || t);
    if (!report_feed.ok) report_feed.reason = "no report rows";
    // Without the verified id map nobody can be matched, and "not on the
    // report" would be said of players listed Out (QA 2026-10-10).
    else if (mapError || !gsisToMfl || !Object.keys(gsisToMfl).length) report_feed.reason = "the NFL id map couldn’t be read, so players can’t be matched to the report";
    else if (currentWeek == null) report_feed.reason = "current NFL week unknown (MFL unreadable)";
    else if (rep.week !== currentWeek) report_feed.reason = `the newest report is Wk ${rep.week}; Wk ${currentWeek}'s is not out yet`;
    else if (report_feed.age_hours == null) report_feed.reason = "report age unknown";
    else if (report_feed.age_hours > STALE_HOURS) report_feed.reason = `report not updated for ${report_feed.age_hours} h`;
    else report_feed.current = true;
  }
  const players = {};
  if (report_feed.current) {
    for (const [g, r] of Object.entries(rep.byGsis)) {
      const m = gsisToMfl[g];
      if (m) (players[m] = players[m] || {}).report = r;
    }
  }
  for (const [m, r] of Object.entries(roster.byMfl)) (players[m] = players[m] || {}).roster = r;
  return {
    report_feed,
    roster_feed: { ok: roster.ok, source: "MFL injuries export", week: roster.week,
                   updated_utc: roster.ts ? new Date(roster.ts * 1000).toISOString() : null,
                   reason: roster.ok ? null : "unreadable: " + (mflError || "no injuries node") },
    players,
  };
}

export async function loadPlayerStatus(db, { season, fetchImpl = fetch, now = Date.now() }) {
  const opts = (ttl) => ({ headers: { "User-Agent": "upsmflproduction-worker" }, cf: { cacheTtl: ttl, cacheEverything: true } });
  const [rep, mfl, map] = await Promise.all([
    fetchImpl(REPORT_URL(season), opts(300)).then(async (r) => r.ok
      ? { rows: parseCsv(await r.text()), modified: r.headers.get("last-modified") }
      : { error: "HTTP " + r.status }).catch((e) => ({ error: String(e && e.message || e) })),
    fetchImpl(MFL_INJURIES_URL(season), opts(120)).then(async (r) => r.ok ? { payload: await r.json() } : { error: "HTTP " + r.status })
      .catch((e) => ({ error: String(e && e.message || e) })),
    db.prepare("SELECT mfl_id, gsis_id, accepted FROM player_id_map").all()
      .then((x) => ({ rows: (x && x.results) || [] })).catch((e) => ({ rows: [], error: String(e && e.message || e) })),
  ]);
  const gsisToMfl = {}, mapped = [];
  for (const r of map.rows) {
    if (Number(r.accepted) === 1 && /^00-\d+/.test(r.gsis_id || "")) { gsisToMfl[r.gsis_id] = String(r.mfl_id); mapped.push(String(r.mfl_id)); }
  }
  const out = assemble({ reportRows: rep.rows, reportModified: rep.modified, reportError: rep.error,
                         mflPayload: mfl.payload, mflError: mfl.error || (mfl.payload && !mfl.payload.injuries ? "no injuries node" : null),
                         gsisToMfl, mapError: map.error, now });
  out.id_map_rows = map.rows.length;
  // The MFL ids that CAN be matched to the report. Anyone else — an
  // unaccepted id, or a player signed since the map was built — is "no
  // verified NFL id", never "not on the report".
  out.mapped_mfl_ids = mapped.sort();
  return out;
}
