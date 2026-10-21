// Stats → Pts Agst finished-season store: run the REAL handler (worker/src/fpa_engine.js
// handleFpaRequest) twice on one set of recorded inputs and compare the answers.
//   LIVE   — MFL replies and D1 rows replayed exactly as they were read (the path
//            production takes without a stored copy).
//   STORED — only env.FPA_STORE (the encoded file). No MFL and no D1: a stored answer
//            that needed either would differ (or throw) and fail the comparison.
// Used by the build's self-check (build_fpa_season_store.mjs), the node tests and
// the proof sweep. Nothing here reads the network.
import * as F from "../../../worker/src/fpa_engine.js";

// MFL's reply for one export URL, from the recorded replies { league, players, sched: {w}, scores: {w} }.
export function replyFor(raw, u) {
  const q = new URL(u).searchParams, T = q.get("TYPE"), w = parseInt(q.get("W"), 10);
  if (T === "league") return raw.league;
  if (T === "players") return raw.players;
  if (T === "nflSchedule") return raw.sched[w] || null;
  if (T === "playerScores") return raw.scores[w] || null;
  return null;
}
export function replayFetch(raw, log) {
  return async (u, init) => {
    if (init && init.method && init.method !== "GET") throw new Error("non-GET " + init.method);
    if (log) log.push(u);
    const j = replyFor(raw, u);
    return { ok: j != null, json: async () => j };
  };
}

// D1 as it answered: the three context reads by their SQL, and the drill's two snap
// reads evaluated over the recorded rows (IN is an exact text match, as in SQLite).
// rec = { teamRows, playRows, paceRows, idRows, snapRows }. Any other SQL throws.
export function replayD1(rec, log) {
  const answer = (sql, b) => {
    if (/^WITH pw AS \(/.test(sql)) return rec.teamRows;
    if (/^SELECT week, team, SUM\(/.test(sql)) return rec.playRows;
    if (/^SELECT team, off_plays_pg, def_plays_pg FROM nfl_team_pace WHERE season = \?1$/.test(sql)) return rec.paceRows;
    if (/^SELECT mfl_id, pfr_id FROM ff_player_ids WHERE mfl_id IN \((\?,)*\?\)$/.test(sql)) {
      const set = new Set(b); return rec.idRows.filter((r) => set.has(r.mfl_id));
    }
    if (/^SELECT pfr_id, week, off_snaps, def_snaps FROM nfl_player_snaps WHERE season = \? AND week BETWEEN \? AND \? AND pfr_id IN \((\?,)*\?\)$/.test(sql)) {
      const [, lo, hi, ...p] = b, set = new Set(p);
      return rec.snapRows.filter((r) => Number(r.week) >= lo && Number(r.week) <= hi && set.has(r.pfr_id));
    }
    throw new Error("replayD1: unexpected SQL " + sql.slice(0, 90));
  };
  const stmt = (sql, b) => ({ all: async () => { if (log) log.push(sql.slice(0, 50)); return { results: answer(sql, b) }; } });
  return { prepare: (sql) => Object.assign(stmt(sql, []), { bind: (...b) => stmt(sql, b) }) };
}

// env.FPA_STORE as the deploy binds it: serves files by path, 404 otherwise.
export function storeBinding(files, log) {
  return {
    fetch: async (req) => {
      const p = new URL(typeof req === "string" ? req : req.url).pathname;
      if (log) log.push(p);
      return Object.prototype.hasOwnProperty.call(files, p) ? new Response(files[p], { headers: { "content-type": "application/json" } }) : new Response("Not Found", { status: 404 });
    },
  };
}

export const jsonOut = (status, payload) => new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json", "Access-Control-Allow-Origin": "*" } });

// The only fields allowed to differ: when the answer was made and when MFL was read.
export function normalize(body) {
  const j = JSON.parse(body); delete j.as_of; delete j.mfl_read_at; return JSON.stringify(j);
}

// One path through both. Returns { same, live, stored, liveSource, storedSource, mflReads, d1Reads }.
export async function runBoth(path, { raw, rec, files, nowMs, lid }) {
  const mflLog = [], d1Log = [], storeLog = [];
  const live = await F.handleFpaRequest(new Request("https://w.test" + path), { UPS_MFL_DB: replayD1(rec) }, null,
    { jsonOut, nowMs, lid, fetchImpl: replayFetch(raw) });
  const stored = await F.handleFpaRequest(new Request("https://w.test" + path), { FPA_STORE: storeBinding(files, storeLog), UPS_MFL_DB: replayD1(rec, d1Log) }, null,
    { jsonOut, nowMs, lid, fetchImpl: replayFetch(raw, mflLog) });
  const lb = await live.text(), sb = await stored.text();
  return {
    same: live.status === stored.status && normalize(lb) === normalize(sb),
    status: [live.status, stored.status], live: lb, stored: sb,
    liveSource: live.headers.get("X-UPS-FPA-Source"), storedSource: stored.headers.get("X-UPS-FPA-Source"),
    mflReads: mflLog.length, d1Reads: d1Log.length, storeReads: storeLog.length,
  };
}

// The same comparison for Player Stats "Sched Δ" (#1271): handleSosRequest, live vs stored.
export async function runBothSos(path, { raw, rec, files, nowMs }) {
  const mflLog = [], d1Log = [];
  const live = await F.handleSosRequest(new Request("https://w.test" + path), { UPS_MFL_DB: replayD1(rec) }, null,
    { jsonOut, nowMs, fetchImpl: replayFetch(raw) });
  F.fpaStoreForget();
  const stored = await F.handleSosRequest(new Request("https://w.test" + path), { FPA_STORE: storeBinding(files), UPS_MFL_DB: replayD1(rec, d1Log) }, null,
    { jsonOut, nowMs, fetchImpl: replayFetch(raw, mflLog) });
  const norm = (b) => { const j = JSON.parse(b); delete j.as_of; for (const y in j.per_season || {}) { delete j.per_season[y].mfl_read_at; delete j.per_season[y].source; } return JSON.stringify(j); };
  const lb = await live.text(), sb = await stored.text();
  return { same: live.status === stored.status && norm(lb) === norm(sb), status: [live.status, stored.status], live: lb, stored: sb,
    storedSource: stored.headers.get("X-UPS-FPA-Source"), mflReads: mflLog.length, d1Reads: d1Log.length };
}

// Every request the screens can make for one season: the list for every window
// (Full season, the desktop's 1–18, and each Custom week_min..week_max), one
// position filter, and the drill for every team × position at Full season plus
// two Custom windows.
export function sweepPaths(yr, endWeek, teams, { allDrillWindows } = {}) {
  const list = [`/api/fantasy-points-against?YEAR=${yr}&week_min=1`, `/api/fantasy-points-against?YEAR=${yr}&week_min=1&week_max=18`,
    `/api/fantasy-points-against?YEAR=${yr}&pos=QB&week_min=1`];
  for (let a = 1; a <= endWeek; a++) for (let b = a; b <= endWeek; b++) list.push(`/api/fantasy-points-against?YEAR=${yr}&week_min=${a}&week_max=${b}`);
  const drill = [];
  const half = Math.floor(endWeek / 2);
  const wins = allDrillWindows ? ["week_min=1", `week_min=1&week_max=${half}`, `week_min=${half + 1}&week_max=${endWeek}`] : ["week_min=1"];
  for (const t of teams) for (const g of F.FPA_GROUPS) for (const w of wins) drill.push(`/api/fpa-detail?YEAR=${yr}&team=${t}&pos=${g}&${w}`);
  return { list, drill };
}
