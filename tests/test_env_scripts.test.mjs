// #1475: the first-test preflight and the production-untouched comparison, offline on fixtures.
// Neither script's network half runs here; only the pure evaluators.
import { t, test, run } from "./fixtures/mini_test.mjs";
import { evaluateProposal, PROPOSAL } from "../scripts/test_env/first_adddrop_preflight.mjs";
import { diffSnapshots, indexMfl } from "../scripts/test_env/prod_untouched_check.mjs";

// A recorded-shape fixture of the TEST league as it read on 2026-11-24 (trimmed to the fields used).
function testLeagueData({ faStatus = "unlocked", rosterExtra = 0, dropSalary = "1000", dropStatus = "WW", dropCy = "1" } = {}) {
  const roster = [{ id: "17509", status: "ROSTER", salary: dropSalary, contractYear: dropCy, contractStatus: dropStatus, contractInfo: "CL 1|" }];
  for (let i = 0; i < 26 + rosterExtra; i++) roster.push({ id: String(20000 + i), status: "ROSTER", salary: "6000", contractYear: "2", contractStatus: "Veteran" });
  return {
    league: { league: { id: "25625", name: "TEST UPS", rosterSize: "30", salaryCapAmount: "300000.49", lockout: "No" } },
    rosters: { rosters: { franchise: [{ id: "0003", player: roster }, { id: "0012", player: [] }] } },
    freeAgents: { freeAgents: { leagueUnit: { player: [{ id: "13348", status: faStatus, salary: "1000", contractStatus: "WW" }] } } },
    nflSchedule: { nflSchedule: { matchup: [{ kickoff: String(Date.parse("2026-12-01T01:15:00Z") / 1000), team: [{ id: "CAR" }, { id: "TBB" }] }] } },
    players: { players: { player: [{ id: "13348", name: "Moore, David", position: "WR", team: "CAR" }, { id: "17509", name: "Brazzell II, Chris", position: "WR", team: "CAR" }] } },
  };
}
const SUNDAY_1000_ET = Date.parse("2026-11-29T15:00:00Z");
const status = (r, id) => (r.checks.find((c) => c.id === id) || {}).status;

test("preflight: the proposal passes only inside the window, with MFL unlocked, in roster and cap limits", () => {
  const ok = evaluateProposal(testLeagueData(), PROPOSAL, SUNDAY_1000_ET);
  t.equal(ok.ready, true, JSON.stringify(ok.checks.filter((c) => c.status !== "pass")));
  t.equal(PROPOSAL.league, "25625"); t.equal(PROPOSAL.franchise_id, "0003");
  const today = evaluateProposal(testLeagueData({ faStatus: "locked" }), PROPOSAL, Date.parse("2026-11-24T13:00:00Z"));
  t.equal(today.ready, false); t.equal(status(today, "ups_fcfs_window"), "fail"); t.equal(status(today, "mfl_free_agent_unlocked"), "fail");
  t.equal(status(evaluateProposal(testLeagueData(), PROPOSAL, Date.parse("2026-12-01T01:30:00Z")), "add_kickoff_not_started"), "fail", "after kickoff");
  t.equal(status(evaluateProposal(testLeagueData({ rosterExtra: 4 }), PROPOSAL, SUNDAY_1000_ET), "roster_count_in_range"), "fail", "31 players is over the max");
  t.equal(status(evaluateProposal(testLeagueData({ rosterExtra: -1 }), PROPOSAL, SUNDAY_1000_ET), "roster_count_in_range"), "fail", "26 players is under the minimum");
  t.equal(status(evaluateProposal(testLeagueData({ dropSalary: "5000" }), PROPOSAL, SUNDAY_1000_ET), "drop_is_cap_free_class"), "fail", "a $5K drop is not cap-free");
  t.equal(status(evaluateProposal(testLeagueData({ dropStatus: "Veteran", dropCy: "3" }), PROPOSAL, SUNDAY_1000_ET), "drop_is_cap_free_class"), "fail", "a multi-year veteran is not cap-free");
  const prodData = testLeagueData(); prodData.league.league.id = "74598";
  t.equal(status(evaluateProposal(prodData, PROPOSAL, SUNDAY_1000_ET), "league_is_test"), "fail", "the production league is never accepted");
});

// Production snapshots: before and after one test operation.
function prodSnap({ tx = [], roster0003 = ["13348:ROSTER:1000:1:Vet-WW:"], runs = [], commits = [], d1New = [], settings = [{ key: "feature_flags", value: "{}" }] } = {}) {
  return {
    taken_at: "2026-11-29T14:00:00Z",
    mfl: {
      transactions: { transactions: { transaction: [{ type: "FREE_AGENT", franchise: "0005", timestamp: String(Date.parse("2026-11-22T14:32:00Z") / 1000), transaction: "16387,|15733," }, ...tx] } },
      rosters: { rosters: { franchise: [{ id: "0003", player: roster0003.map((s) => { const [id, st, sal, cy, cs] = s.split(":"); return { id, status: st, salary: sal, contractYear: cy, contractStatus: cs }; }) }, { id: "0005", player: [{ id: "16387", status: "ROSTER", salary: "1000", contractYear: "1", contractStatus: "Vet-WW" }] }] } },
      salaries: { salaries: { leagueUnit: { player: [{ id: "16387", salary: "1000", contractYear: "1" }] } } },
    },
    github: { commits: [{ sha: "a".repeat(40), message: "data(mfl-snapshot): daily pull" }, ...commits], runs: [{ id: 1, name: "pages", event: "push" }, ...runs] },
    d1: { tables: { ups_transactions: { max_rowid: 100, new_rows: d1New }, salary_change_log: { max_rowid: 50, new_rows: [] } }, small: { ups_settings: { hash: JSON.stringify(settings), rows: settings } } },
  };
}
const MARKERS = { window_start_utc: "2026-11-29T14:00:00Z", window_end_utc: "2026-11-29T15:00:00Z", player_ids: ["13348", "17509"], franchise_ids: ["0003"], idempotency_key: "adddrop-2026-11-29-0003", test_league: "25625" };
const at = (iso) => String(Date.parse(iso) / 1000);

test("production check: identical snapshots are untouched; unrelated owner activity is listed but not counted against the test", () => {
  const same = diffSnapshots(prodSnap(), prodSnap(), MARKERS);
  t.equal(same.untouched, true, JSON.stringify(same));
  t.equal(same.associated.length, 0); t.equal(same.unrelated_production_activity.length, 0);
  const owner = diffSnapshots(prodSnap(), prodSnap({ tx: [{ type: "FREE_AGENT", franchise: "0010", timestamp: at("2026-11-29T14:20:00Z"), transaction: "15000,|16001," }] }), MARKERS);
  t.equal(owner.untouched, true, "a real owner's add in the window is not the test's doing");
  t.equal(owner.unrelated_production_activity.length, 1);
  t.equal(owner.unrelated_production_activity[0].area, "mfl_74598_transactions");
});

test("production check: content changes tied to the test operation are found even when counts don't change", () => {
  const cases = [
    ["a 74598 transaction naming a test player", { tx: [{ type: "FREE_AGENT", franchise: "0003", timestamp: at("2026-11-29T14:20:00Z"), transaction: "13348,|17509," }] }, "mfl_74598_transactions"],
    ["the test franchise's 74598 roster changed in place (same count)", { roster0003: ["13348:ROSTER:1000:1:Rookie-WW:"] }, "mfl_74598_rosters"],
    ["a repository_dispatch run in the window", { runs: [{ id: 9, name: "log-contract-activity", event: "repository_dispatch" }] }, "github_workflow_runs"],
    ["a production D1 row carrying the idempotency key", { d1New: [{ _rowid: 101, league_id: "74598", note: "adddrop-2026-11-29-0003" }] }, "d1_ups_transactions"],
    ["a production D1 row naming the test league", { d1New: [{ _rowid: 101, league_id: "25625" }] }, "d1_ups_transactions"],
    ["global flags changed in the window", { settings: [{ key: "feature_flags", value: "{\"WAIVERS_INAPP_ENABLED\":\"1\"}" }] }, "d1_ups_settings"],
    ["a commit mentioning a test label", { commits: [{ sha: "b".repeat(40), message: "Log contract activity [TEST]" }] }, "github_commits"],
  ];
  for (const [label, over, area] of cases) {
    const r = diffSnapshots(prodSnap(), prodSnap(over), MARKERS);
    t.equal(r.untouched, false, label);
    t.ok(r.associated.some((f) => f.area === area), `${label}: ${JSON.stringify(r.associated)}`);
  }
  const removed = prodSnap(); removed.mfl.transactions.transactions.transaction = [];
  t.equal(diffSnapshots(prodSnap(), removed, MARKERS).untouched, false, "a production transaction disappearing is flagged");
});

test("production check: a missing snapshot part is a gap, never a pass", () => {
  const noMfl = prodSnap(); delete noMfl.mfl;
  t.equal(diffSnapshots(prodSnap(), noMfl, MARKERS).untouched, false);
  const noD1a = prodSnap(), noD1b = prodSnap(); delete noD1a.d1; delete noD1b.d1;
  const r = diffSnapshots(noD1a, noD1b, MARKERS);
  t.equal(r.untouched, true, "without --prod-d1 the D1 part is reported as not compared");
  t.ok(r.gaps.some((g) => /not compared/.test(g)));
  const err = prodSnap(); err.d1.tables.ups_transactions = { error: "D1_ERROR" };
  t.equal(diffSnapshots(prodSnap(), err, MARKERS).untouched, false, "an unreadable table is not a pass");
  t.equal(Object.keys(indexMfl(prodSnap().mfl).tx).length, 1);
});

await run("test_env_scripts");
