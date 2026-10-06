// Lineup editors must show — and refuse to start — a bye-week player.
//   node tests/lineup_bye_week.test.mjs
//   GAMEDAY_HTML=<…> FO_LINEUP_JS=<…> LIVE_SCORING_JS=<…> LINEUP_JS=<…> WORKER_JS=<…> (defect check)
//
// Keith 2026-10-06 (screenshot, Game Day → Submit Lineup to MFL): "Lineup NOT
// submitted … League rules forbid starting players on a Bye week - Bolton,
// Nick KCC LB is on a bye on week 5", shown as raw XML — and nothing on the
// lineup screen had said Bolton was on a bye. Neither Game Day nor the mobile
// lineup read MFL's bye list at all: a bye player simply had no matchup line.
//
// Real data: MFL TYPE=nflByeWeeks&W=5 for 2026 (read 2026-10-06) = CAR + KCC;
// Nick Bolton = MFL 15355, KCC LB. The rejection text is the one MFL returned.
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { t, test, run } from "./fixtures/mini_test.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => fs.readFileSync(path.isAbsolute(p) ? p : path.join(ROOT, p), "utf8");
const GAMEDAY = read(process.env.GAMEDAY_HTML || "site/gameday/gameday.html");
const FO_LINEUP = read(process.env.FO_LINEUP_JS || "site/m/front_office_lineup.js");
const LIVE = read(process.env.LIVE_SCORING_JS || "site/shared/live_scoring.js");
const LINEUP = read(process.env.LINEUP_JS || "site/m/views/lineup.js");
const WORKER = read(process.env.WORKER_JS || "worker/src/index.js");

function sliceFn(src, sig) {
  const at = src.indexOf(sig);
  if (at < 0) throw new Error("not found: " + sig);
  let i = src.indexOf("{", at), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(at, i + 1);
  }
  throw new Error("unbalanced: " + sig);
}

const BYES_W5 = { version: "1.0", nflByeWeeks: { year: "2026", week: "5", team: [{ id: "CAR", bye_week: "5" }, { id: "KCC", bye_week: "5" }] }, encoding: "utf-8" };
const LS = (() => { const c = vm.createContext({}); c.window = c; vm.runInContext(LIVE, c); return c.UPSLive; })();

test("shared parser: MFL's real Week 5 bye export → { CAR: 5, KCC: 5 }", () => {
  t.equal(typeof LS.parseByeTeams, "function", "LS.parseByeTeams exists");
  t.equal(JSON.stringify(LS.parseByeTeams(BYES_W5, 5)), JSON.stringify({ CAR: 5, KCC: 5 }));
  t.equal(JSON.stringify(LS.parseByeTeams(BYES_W5, 6)), "{}", "another week's request keeps nothing");
  t.equal(JSON.stringify(LS.parseByeTeams({ error: { $t: "nope" } }, 5)), "{}", "an error payload = unknown, no tags");
  t.equal(JSON.stringify(LS.parseByeTeams({ nflByeWeeks: { team: { id: "KCC", bye_week: "5" } } }, 5)), JSON.stringify({ KCC: 5 }), "a single team (MFL's non-array form)");
});

// ── Mobile (site/m/front_office_lineup.js, shared by the mobile lineup view) ──
const FO = (() => { const c = vm.createContext({}); c.window = c; vm.runInContext(FO_LINEUP, c); return c.UPS_FRONT_OFFICE_LINEUP; })();
function roster(byeWeekForKcc) {
  // A full, legal 18 with Bolton (KCC LB) in LB1 — plus a bench LB to replace him.
  const mk = (id, name, pos, team) => ({ id, name, pos, team, group: FO.posGroup(pos), bye: team === "KCC" ? byeWeekForKcc : 0 });
  return [mk("1", "QB A", "QB", "BUF"), mk("2", "RB A", "RB", "DET"), mk("3", "RB B", "RB", "SFO"), mk("4", "WR A", "WR", "MIA"),
    mk("5", "WR B", "WR", "MIN"), mk("6", "TE A", "TE", "PHI"), mk("7", "Flex A", "WR", "LAR"), mk("8", "Flex B", "RB", "BAL"),
    mk("9", "SF A", "QB", "HOU"), mk("10", "K A", "PK", "TBB"), mk("11", "P A", "PN", "NYG"), mk("12", "DL A", "DE", "PIT"),
    mk("13", "DL B", "DT", "CLE"), mk("15355", "Nick Bolton", "LB", "KCC"), mk("15", "LB B", "LB", "SEA"), mk("16", "DB A", "CB", "DAL"),
    mk("17", "DB B", "S", "GBP"), mk("18", "DF A", "LB", "NOS"), mk("19", "LB bench", "LB", "ATL")]
    .map((r) => Object.assign(r, { eligible: FO.lineupEligibleRow(r) }));
}
const DRAFT = { QB1: "1", RB1: "2", RB2: "3", WR1: "4", WR2: "5", TE1: "6", OF1: "7", OF2: "8", SF1: "9", PK1: "10", PN1: "11",
  DL1: "12", DL2: "13", LB1: "15355", LB2: "15", DB1: "16", DB2: "17", DF1: "18" };
const byPid = (rows) => Object.fromEntries(rows.map((r) => [r.id, r]));

test("mobile rules: a bye-week player is ineligible and a lineup starting him is BLOCKED with a plain reason", () => {
  const rows = roster(5);
  t.equal(byPid(rows)["15355"].eligible, false, "Bolton (KCC, Week 5 bye) is not a startable candidate");
  const v = FO.validateSlots(DRAFT, byPid(rows));
  t.equal(v.problems, 1, "one blocking problem");
  t.equal(v.ok, false, "cannot be saved");
  t.ok(v.errors.some((e) => e === "Nick Bolton (KCC) is on a bye in Week 5 — bench him; MFL won't accept a bye-week starter"), v.errors.join(" | "));
  const playing = roster(0);
  t.equal(FO.validateSlots(DRAFT, byPid(playing)).problems, 0, "the same lineup the week KCC plays: fine");
  const auto = FO.autoFillSlots(rows, null);
  t.ok(!Object.values(auto).includes("15355"), "Optimal never starts the bye player");
});

test("mobile view: BYE on the bench, and the saved starter stays visible in his slot with a 'bench him' badge", () => {
  const c = vm.createContext({});
  vm.runInContext(sliceFn(LINEUP, "function benchBlockedTag(") + "\nthis.f = benchBlockedTag;", c);
  t.equal(JSON.stringify(c.f({ bye: 5, eligible: false })), JSON.stringify({ cls: "bye", label: "BYE · WK 5" }), "bench tag");
  t.match(LINEUP, /ups-m-bye-badge">BYE · Week ' \+ U\.escapeHtml\(String\(currentRow\.bye\)\) \+\s*' — bench him; MFL won’t accept a bye-week starter/,
    "slot badge text");
  t.match(LINEUP, /if \(!\(r\.eligible \|\| \(r\.bye && r\.id === current\)\)\) return false;/, "a saved bye starter stays selectable in his own slot only");
  t.match(LINEUP, /API\.mflExportUrl\("nflByeWeeks", \{ W: wk \}\)/, "reads MFL's nflByeWeeks for the lineup week");
});

// ── Game Day (site/gameday/gameday.html) — its own copies of the same rules ──
function gameday(byes) {
  const c = vm.createContext({});
  c.STATE = { byes, byesWeek: 5, lineupWeek: 5 };
  const fns = ["function s(", "function posGroup(", "function slotAccepts(", "function eligibleRow(", "function isOnBye(", "function validate("];
  vm.runInContext("var SLOTS, TOTAL = 18;\n" + GAMEDAY.slice(GAMEDAY.indexOf("  var SLOTS = ["), GAMEDAY.indexOf("  var TOTAL = 18")).replace("var SLOTS", "SLOTS") +
    "\n" + fns.map((f) => sliceFn(GAMEDAY, f)).join("\n") + "\nthis.api = { eligibleRow, isOnBye, validate, posGroup };", c);
  return c.api;
}
test("Game Day rules: same — Bolton tagged bye, ineligible, and the submit is blocked before MFL sees it", () => {
  const G = gameday({ CAR: 5, KCC: 5 });
  t.equal(G.isOnBye("KCC"), true); t.equal(G.isOnBye("kcc"), true); t.equal(G.isOnBye("BUF"), false);
  const rows = roster(5).map((r) => Object.assign({}, r, { bye: G.isOnBye(r.team) }));
  rows.forEach((r) => { r.eligible = G.eligibleRow(r); });
  t.equal(byPid(rows)["15355"].eligible, false, "Bolton is no slot's candidate");
  const v = G.validate(DRAFT, byPid(rows));
  t.equal(v.problems, 1); t.equal(v.ok, false, "→ the button reads 'Fix lineup errors' and is disabled");
  t.ok(v.errors.some((e) => e === "Nick Bolton (KCC) is on a bye in Week 5 — bench him; MFL won't accept a bye-week starter"), v.errors.join(" | "));
  const none = gameday({});
  const rows2 = roster(0).map((r) => Object.assign({}, r, { bye: none.isOnBye(r.team) }));
  t.equal(none.validate(DRAFT, byPid(rows2)).problems, 0, "bye list unread → no false block (MFL still decides)");
});

test("Game Day screen: BYE in the option text, the slot badge, the bench tag, and the bye list fetch", () => {
  t.match(GAMEDAY, /\(r\.bye \? "  ·  BYE" : ""\)/, "option text marks BYE");
  t.match(GAMEDAY, /gd-bye-badge">BYE · Week ' \+ esc\(STATE\.byesWeek \|\| STATE\.lineupWeek\) \+ ' — bench him; MFL won’t accept a bye-week starter/, "slot badge");
  t.match(GAMEDAY, /gd-bye-badge" title="His NFL team is on a bye in Week/, "bench tag");
  t.match(GAMEDAY, /\/api\/mfl-export\?TYPE=nflByeWeeks&L=/, "bye list read through the worker proxy (MFL refuses it on the league shard)");
});

test("MFL's rejection is shown as a sentence, not raw XML", () => {
  const c = vm.createContext({});
  vm.runInContext(sliceFn(WORKER, "function mflReadableError(") + "\nthis.f = mflReadableError;", c);
  const raw = '<?xml version="1.0" encoding="utf-8"?> <error>Error(s) submitting lineup: &lt;br/&gt;League rules forbid starting players on a Bye week - Bolton, Nick KCC LB is on a bye on week 5</error>';
  t.equal(c.f(raw), "League rules forbid starting players on a Bye week - Bolton, Nick KCC LB is on a bye on week 5");
  t.equal(c.f("Lineup deadline has passed"), "Lineup deadline has passed", "plain text passes through");
  t.equal(c.f(""), "");
  t.match(WORKER, /error: mflReadableError\(errMsg\) \|\| String\(errMsg \|\| "MFL rejected lineup"\),/, "submit-lineup uses it; raw reply stays in mfl_response");
});

await run("lineup_bye_week");
