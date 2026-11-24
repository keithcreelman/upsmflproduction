// Real-data harness for the W1 team-history replay (tests/lineup_team_history.test.mjs).
//
// The fixture (tests/fixtures/team_history_2026_wk10.json) is the league as MFL and the weekly stat files
// had it on 2026-11-21 15:15 UTC (Week 11 in progress): every MFL read the route makes (league, players, 17
// schedules, 11 score weeks) and the rows the route's own SQL (fpaLoadSeasonContext) returns over the nflverse weekly
// rows joined through the id crosswalk. It was built from public files with no production database read; see
// docs/TEAM_HISTORY_MAPPING.md for the provenance and for what this does and does not prove.
import fs from "fs";

export const FIXTURE_PATH = new URL("../fixtures/team_history_2026_wk10.json", import.meta.url);
export const loadFixture = () => JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf8"));
export const jsonOut = (status, payload) => new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });

// The MFL / GitHub / weather side: every GET the route makes, answered from the fixture.
export function mflFromFixture(fx, opts) {
  opts = opts || {};
  const calls = [];
  const league = { league: { endWeek: String(fx.league.endWeek), lastRegularSeasonWeek: String(fx.league.lastRegularSeasonWeek) } };
  const players = { players: { player: fx.players.map((p) => ({ id: p[0], name: p[1], position: p[2], team: p[3] })) } };
  const sched = (w) => ({ nflSchedule: { week: String(w), matchup: (fx.sched[w] || []).map((g) => ({ kickoff: String(g[2]), gameSecondsRemaining: g[3],
    team: [{ id: g[0], isHome: "0" }, { id: g[1], isHome: "1" }] })) } });
  const fetchImpl = async (u, o) => {
    calls.push({ u, method: (o && o.method) || "GET" });
    const x = new URL(u);
    if (x.hostname === "raw.githubusercontent.com") return { ok: true, text: async () => "game_id,season,game_type,week,away_team,home_team,location,spread_line,total_line\n", headers: undefined };
    if (x.hostname.indexOf("open-meteo") >= 0) return { ok: false, json: async () => null };
    const T = x.searchParams.get("TYPE"), W = Number(x.searchParams.get("W"));
    let j;
    if (T === "league") j = league;
    else if (T === "players") j = players;
    else if (T === "nflSchedule") j = sched(W);
    else if (T === "playerScores") j = { playerScores: { week: String(W), playerScore: (fx.scores[W] || []).map((r) => ({ id: r[0], score: r[1] })) } };
    else throw new Error("unexpected " + u);
    return { ok: j != null, json: async () => j };
  };
  return { fetchImpl, calls };
}

// The database side: the route's three context statements, answered with the fixture's rows (or a perturbed copy).
export function dbFromRows(teamRows, playRows, identRows, opts) {
  opts = opts || {};
  const queries = [];
  return { queries, UPS_MFL_DB: { prepare: (sql) => ({ bind: (...b) => ({ all: async () => {
    queries.push(sql);
    if (!/^\s*(WITH|SELECT)\b/i.test(sql)) throw new Error("non-SELECT " + sql);
    if (/COUNT\(DISTINCT w\.position\)/.test(sql)) {
      if (opts.identFail) throw new Error("identity statement failed");
      return { results: (identRows || []).map((r) => ({ m: r[0], g: r[1], fname: r[2], fpos: r[3], wpos: r[4], wposx: r[5], wposn: r[6], dup: r[7] })) };
    }
    if (/WITH pw AS/.test(sql)) return { results: teamRows.map((r) => ({ m: r[0], t: r[1], lo: r[2], hi: r[3], wk: r[4] })) };
    if (/SUM\(COALESCE\(rush_att/.test(sql)) return { results: playRows.map((r) => ({ week: r[0], team: r[1], plays: r[2] })) };
    return { results: [] };
  } }) }) } };
}

export async function runHandler(LM, fx, opts) {
  opts = opts || {};
  const { fetchImpl, calls } = mflFromFixture(fx, opts);
  const env = opts.env || dbFromRows(opts.teamRows || fx.teamRows, fx.playRows, opts.identRows || fx.identRows, opts);
  const r = await LM.handleLineupMatchups(new Request("https://w.test/api/lineup-matchups?YEAR=2026&W=" + (opts.W || 11) + (opts.q || "")), env, null,
    { jsonOut, nowMs: fx.meta.nowMs, lid: "74598", fetchImpl });
  return { status: r.status, json: await r.json(), calls, env };
}
