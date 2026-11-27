#!/usr/bin/env node
// First connected test (#1475): READ-ONLY preflight for the proposed FCFS add/drop in TEST league 25625.
//
//   node scripts/test_env/first_adddrop_preflight.mjs            reads MFL's PUBLIC exports (no login, no write)
//   node scripts/test_env/first_adddrop_preflight.mjs --json     same, machine-readable
//
// It never writes, never sends a cookie, never reads league 74598, and never calls the worker.
// It answers one question: is the exact proposed transaction still valid right now? The write itself
// is a separate, approved step through the TEST worker (docs/test_env/TEST_ENVIRONMENT.md section 7).
//
// evaluateProposal() is pure, so tests/test_env_scripts.test.mjs runs it offline on recorded exports.

export const PROPOSAL = Object.freeze({
  league: "25625",
  season: "2026",
  week: 12,
  franchise_id: "0003",
  add: Object.freeze({ id: "13348", name: "Moore, David", pos: "WR", team: "CAR" }),
  drop: Object.freeze({ id: "17509", name: "Brazzell II, Chris", pos: "WR", team: "CAR" }),
  roster_min: 27,   // MFL refused "Less Than Lower Limit of 27" in 25625 on 2026-10-07 (API, recorded)
  roster_max: 30,   // TYPE=league rosterSize for 25625
  // UPS canon section A5: FCFS opens after the SUNDAY 9:00 AM ET waiver run and lasts until each player's
  // kickoff; waivers re-lock Monday 9:00 PM ET. Both players play Monday night (CAR at TB, 8:15 PM ET),
  // so the window for THIS transaction is Sunday 9:05 AM ET to Monday 8:00 PM ET (a margin before kickoff).
  window_start_utc: "2026-11-29T14:05:00Z",   // Sun Nov 29 09:05 ET
  window_end_utc: "2026-12-01T01:00:00Z",     // Mon Nov 30 20:00 ET
});

const PROD = "74598";
const arr = (x) => (x == null ? [] : Array.isArray(x) ? x : [x]);

// data: { league, rosters, freeAgents, nflSchedule, players }: MFL JSON exports for the TEST league.
export function evaluateProposal(data, proposal, nowMs) {
  const p = proposal || PROPOSAL;
  const checks = [];
  const add = (id, status, detail) => checks.push({ id, status, detail });   // pass | fail | unknown
  const lg = data.league && data.league.league;
  if (!lg) add("league_readable", "unknown", "league export missing");
  else {
    add("league_is_test", String(lg.id) === p.league && String(lg.id) !== PROD ? "pass" : "fail", `league ${lg.id} "${lg.name}"`);
    add("roster_max_setting", String(lg.rosterSize) === String(p.roster_max) ? "pass" : "fail", `rosterSize ${lg.rosterSize}`);
  }
  const fr = arr(data.rosters && data.rosters.rosters && data.rosters.rosters.franchise).find((f) => f.id === p.franchise_id);
  const roster = fr ? arr(fr.player) : null;
  let dropRow = null;
  if (!roster) add("franchise_roster", "unknown", `no roster for ${p.franchise_id}`);
  else {
    const n = roster.length;
    const has = (id) => roster.some((x) => x.id === id);
    const after = n + (has(p.add.id) ? 0 : 1) - (has(p.drop.id) ? 1 : 0);
    add("drop_on_roster", has(p.drop.id) ? "pass" : "fail", `${p.drop.name} (${p.drop.id}) on ${p.franchise_id}`);
    add("add_not_on_roster", has(p.add.id) ? "fail" : "pass", `${p.add.name} (${p.add.id})`);
    add("roster_count_in_range", n >= p.roster_min && n <= p.roster_max && after >= p.roster_min && after <= p.roster_max ? "pass" : "fail",
      `${n} now, ${after} after (limits ${p.roster_min}-${p.roster_max})`);
    dropRow = roster.find((x) => x.id === p.drop.id) || null;
    if (dropRow) {
      const capFree = /^(WW|Vet-WW|Rookie-WW)$/.test(String(dropRow.contractStatus || "")) && Number(dropRow.salary) <= 4000 && String(dropRow.contractYear) === "1";
      add("drop_is_cap_free_class", capFree ? "pass" : "fail",
        `${dropRow.contractStatus} $${dropRow.salary} contractYear ${dropRow.contractYear} "${dropRow.contractInfo || ""}" (canon A5/C3: a one-year WW of $4K or less is a cap-free cut)`);
      add("drop_not_taxi_or_ir", String(dropRow.status || "ROSTER") === "ROSTER" ? "pass" : "fail", `status ${dropRow.status}`);
    }
    const salary = roster.reduce((s, x) => s + (Number(x.salary) || 0), 0);
    const cap = lg ? Number(lg.salaryCapAmount) || 0 : 0;
    const afterSalary = salary + 1000 - (dropRow ? Number(dropRow.salary) || 0 : 0);
    add("cap_room", !cap ? "unknown" : (afterSalary <= cap ? "pass" : "fail"), `roster salary $${salary} -> $${afterSalary} vs cap $${cap}`);
  }
  const lu = data.freeAgents && data.freeAgents.freeAgents && data.freeAgents.freeAgents.leagueUnit;
  const faRow = arr(lu && lu.player).find((x) => x.id === p.add.id);
  add("add_is_free_agent", faRow ? "pass" : "fail", faRow ? `listed, MFL status "${faRow.status}"` : "not in the free-agent export");
  // MFL marks every free agent "locked" while waivers are locked (Monday night until the Sunday run).
  add("mfl_free_agent_unlocked", !faRow ? "unknown" : (faRow.status === "locked" ? "fail" : "pass"), faRow ? `status "${faRow.status}"` : "");
  const players = arr(data.players && data.players.players && data.players.players.player);
  const games = arr(data.nflSchedule && data.nflSchedule.nflSchedule && data.nflSchedule.nflSchedule.matchup);
  for (const who of ["add", "drop"]) {
    const pl = players.find((x) => x.id === p[who].id);
    add(`${who}_player_identity`, pl && pl.team === p[who].team ? "pass" : "fail", pl ? `${pl.name} ${pl.position} ${pl.team}` : "not in players export");
    const g = games.find((m) => arr(m.team).some((t) => t.id === p[who].team));
    const kick = g ? Number(g.kickoff) * 1000 : null;
    add(`${who}_kickoff_not_started`, kick == null ? "unknown" : (nowMs < kick ? "pass" : "fail"), kick == null ? `no week ${p.week} game found` : `kickoff ${new Date(kick).toISOString()}`);
  }
  const ws = Date.parse(p.window_start_utc), we = Date.parse(p.window_end_utc);
  add("ups_fcfs_window", nowMs >= ws && nowMs <= we ? "pass" : "fail", `now ${new Date(nowMs).toISOString()}, window ${p.window_start_utc} to ${p.window_end_utc}`);
  return { ready: checks.every((c) => c.status === "pass"), proposal: p, checks };
}

async function main() {
  const p = PROPOSAL;
  const www = `https://www48.myfantasyleague.com/${p.season}/export`;
  const api = `https://api.myfantasyleague.com/${p.season}/export`;
  const urls = {
    league: `${www}?TYPE=league&L=${p.league}&JSON=1`,
    rosters: `${www}?TYPE=rosters&L=${p.league}&JSON=1`,
    freeAgents: `${www}?TYPE=freeAgents&L=${p.league}&JSON=1`,
    nflSchedule: `${api}?TYPE=nflSchedule&W=${p.week}&JSON=1`,
    players: `${api}?TYPE=players&PLAYERS=${p.add.id},${p.drop.id}&JSON=1`,
  };
  const data = {};
  for (const [k, u] of Object.entries(urls)) {
    if (u.includes(PROD)) throw new Error("refusing: the production league id is in a URL");
    const r = await fetch(u, { headers: { "User-Agent": "ups-test-env-preflight" } });   // no cookie: public data only
    if (!r.ok) throw new Error(`HTTP ${r.status} for ${k}`);
    data[k] = await r.json();
  }
  const out = evaluateProposal(data, p, Date.now());
  if (process.argv.includes("--json")) { console.log(JSON.stringify(out, null, 2)); return; }
  console.log(`Proposed: league ${p.league}, season ${p.season}, week ${p.week}, franchise ${p.franchise_id}: ADD ${p.add.name} (${p.add.id}) / DROP ${p.drop.name} (${p.drop.id})`);
  for (const c of out.checks) console.log(`  ${c.status.padEnd(7)} ${c.id.padEnd(26)} ${c.detail}`);
  console.log(out.ready ? "\nREADY: every check passes. Still needs Keith's approval and the prerequisites in TEST_ENVIRONMENT.md section 7." : "\nNOT READY: do not send.");
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error(String((e && e.message) || e)); process.exit(1); });
