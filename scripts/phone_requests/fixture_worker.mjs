// Fixture answers for every worker GET the phone app makes. Built from the public test fixtures in the repo
// (tests/fixtures/*.json — real 2026-10-09/10 captures already committed), so a journey run reads NOTHING from
// production: no worker, no D1, no MFL. Writes are refused.
import fs from "node:fs";
import path from "node:path";

export function makeFixtureWorker(repoRoot, opts = {}) {
  const fx = JSON.parse(fs.readFileSync(path.join(repoRoot, "tests/fixtures/mobile_stats_players_2026_10_09.json"), "utf8"));
  const SEASON = "2026";
  const OWNERS = { tokA: "0008", tokB: "0005" };
  const franchises = fx.franchises.map((f, i) => ({ id: f.id, name: f.name, abbrev: f.name.slice(0, 3).toUpperCase(), icon: "", logo: "", owner_name: "Owner " + (i + 1) }));
  const players = Object.entries(fx.players).map(([id, p]) => ({ id, name: p[0], position: p[1], team: p[2] }));
  const rosters = Object.entries(fx.rosters).map(([fid, rows]) => ({
    id: fid,
    player: rows.map((r) => ({ id: r[0], status: r[1], salary: r[2] || "1000", contractYear: r[3] || "1", contractStatus: r[4] || "Vet-FAA", contractInfo: r[5] || "CL 1| TCV 1K| AAV 1K" })),
  }));
  const weeks = Object.keys(fx.weeks).sort((a, b) => a - b);
  const playerScoresAll = { playerScoresAllWeeks: { year: SEASON, playerScores: weeks.map((w) => ({ week: w, playerScore: Object.entries(fx.weeks[w]).map(([id, score]) => ({ id, week: w, score, isAvailable: "0" })) })) } };
  const ytd = {};
  weeks.forEach((w) => Object.entries(fx.weeks[w]).forEach(([id, s]) => { ytd[id] = (ytd[id] || 0) + Number(s); }));
  const playerScoresYtd = { playerScores: { week: "YTD", playerScore: Object.entries(ytd).map(([id, s]) => ({ id, score: s.toFixed(1) })) } };

  const mfl = {
    league: { league: { id: "74598", name: "UPS Dynasty", salaryCapAmount: "300000", endWeek: "17", lastRegularSeasonWeek: "14", franchises: { franchise: franchises } } },
    rosters: { rosters: { franchise: rosters } },
    players: { players: { player: players } },
    salaries: { salaries: { leagueUnit: { unit: "LEAGUE", player: [] } } },
    salaryAdjustments: { salaryAdjustments: { salaryAdjustment: [] } },
    tradeBait: { tradeBaits: { tradeBait: [] } },
    draftResults: { draftResults: { draftUnit: { unit: "LEAGUE", draftPick: [] } } },
    transactions: { transactions: { transaction: [] } },
    injuries: { injuries: { week: "6", injury: [] } },
    leagueStandings: { leagueStandings: { franchise: franchises.map((f) => ({ id: f.id, h2hw: "3", h2hl: "2", pf: "500.0" })) } },
    schedule: { schedule: { weeklySchedule: [] } },
    liveScoring: { liveScoring: { week: "6", matchup: [] } },
    weeklyResults: { weeklyResults: { week: "5", matchup: [] } },
    nflByeWeeks: { nflByeWeeks: { team: fx.byes || [] } },
    projectedScores: { projectedScores: { week: "6", playerScore: [] } },
    pendingTrades: { pendingTrades: {} },
    freeAgents: { freeAgents: { leagueUnit: { player: [] } } },
    nflSchedule: { nflSchedule: { week: "6", matchup: [] } },
  };
  const capRows = fx.cap_rows || {};
  const lb = fx.leaderboard;
  const failures = Object.assign({}, opts.failures || {});   // route → number of answers to fail with 500

  function json(status, body) { return { status, contentType: "application/json", body: JSON.stringify(body) }; }
  function maybeFail(route) {
    if (failures[route] > 0) { failures[route]--; return json(500, { ok: false, error: "fixture: induced failure" }); }
    return null;
  }

  function answer(method, u) {
    const p = u.pathname, q = u.searchParams;
    if (method !== "GET") return json(403, { ok: false, error: "fixture: writes are refused" });
    const failed = maybeFail(p);
    if (failed) return failed;
    switch (p) {
      case "/api/active-season": return json(200, { ok: true, season: SEASON, source: "fixture" });
      case "/api/me": {
        const fid = OWNERS[q.get("MFL_USER_ID") || ""];
        return json(200, fid ? { configured: true, franchise_id: fid, franchise_name: (franchises.find((f) => f.id === fid) || {}).name, is_commish: false } : { configured: false });
      }
      case "/api/mfl-export": {
        const T = q.get("TYPE");
        if (T === "playerScores") return json(200, q.get("W") === "ALL" ? playerScoresAll : playerScoresYtd);
        return mfl[T] ? json(200, mfl[T]) : json(400, { error: "fixture: TYPE " + T + " not recorded" });
      }
      case "/api/league-events": return json(200, { ok: true, events: [{ event: "ups_trade_deadline", date: "2026-11-26" }, { event: "ups_contract_deadline", date: "2026-09-06" }],
        week_kickoffs: q.get("kickoffs") ? { 1: 1788998400, 3: 1790208000, 5: 1791417600 } : undefined, contract_ladder: q.get("kickoffs") ? { stage: "in_season" } : undefined });
      case "/api/taxi-callups": return json(200, { ok: true, players: {} });
      case "/api/cap-penalty/preview": return json(200, { ok: true, season: SEASON, calculated_at: fx.cap_meta.calculated_at, earned_through_week: fx.cap_meta.earned_through_week, players: capRows });
      case "/api/waivers/state": return json(200, { ok: true, mode: "BBID_FCFS", write_enabled: false, window: { kind: "fcfs", label: "Free agents: first come, first served" }, events: [], limits: {}, last_run: null });
      case "/api/waivers/availability": return json(200, { ok: true, players: {}, by_team: {}, no_game: null, changes_at_unix: null });
      case "/api/waivers/pending": return json(200, { ok: true, known: true, rounds: [] });
      case "/api/current-lineup-week": return json(200, fx.lineup_week);
      case "/api/advanced-stats-leaderboard": {
        const a = lb[q.get("pos")] || { rows: [] };
        return json(200, Object.assign({}, a, { season: Number(q.get("season")), next_offset: null }));
      }
      case "/api/trade-bait-notes": return json(200, { ok: true, notes: [] });
      case "/api/trades/proposals": return json(200, { ok: true, incoming: [], outgoing: [] });
      case "/api/player-bundle": return json(200, Object.assign({ career_summary: [], profile: {} }, (fx.bundles || {})[q.get("pid") || q.get("player_id") || ""] || {}));
      case "/api/player-weekly-box": return json(200, { ok: true, rows: [] });
      case "/api/player-news": return json(200, { ok: true, items: [] });
      case "/api/player-status": return json(200, { ok: true, season: SEASON, players: {} });
      case "/api/player-starter-rates": return json(200, { ok: true, players: {} });
      case "/api/player-epa": case "/api/player-routes": case "/api/player-ngs": return json(200, { by_gsis: {} });
      case "/api/standings": return json(200, { ok: false, error: "fixture: standings not recorded" });
      case "/api/playoff-bracket": return json(200, { ok: false, error: "fixture: bracket not recorded" });
      case "/api/historical-finishes": return json(200, { ok: true, finishes: [] });
      case "/api/hot-cold": return json(200, { ok: true, hot: { known: true, players: [] }, cold: { known: true, players: [] } });
      default: return json(404, { ok: false, error: "fixture: no answer for " + p });
    }
  }
  return { answer, failures };
}
