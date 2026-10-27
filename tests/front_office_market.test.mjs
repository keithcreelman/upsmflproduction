// Front Office → Market (#1338): free agents' status is the league's ONE waiver resolver, word for word, with the
// states kept apart (add now / claim now for a named run / can't claim yet with the first run that can award him /
// game locked); one Free agents view lists every unrostered player with each row's own status; the view never sends anything.
//   node tests/front_office_market.test.mjs
//   FO_MARKET_JS=<path> node tests/front_office_market.test.mjs   (defect check against another copy)
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { t, test, run } from "./fixtures/mini_test.mjs";
import { CASES, stateAt, THU_RUN, SAT_RUN, FRI_RUN, SUN_RUN, ROLL6, W6 } from "./fixtures/waiver_availability/timeline.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = fs.readFileSync(process.env.FO_MARKET_JS || path.join(ROOT, "site/rosters/v2/fo_market.js"), "utf8");
const ctx = vm.createContext({ document: { addEventListener() {} } });
ctx.window = ctx;
vm.runInContext(SRC, ctx);
const MK = ctx.UPS_FO_MARKET;

test("every resolver state at every instant of Keith's four cases maps to a distinct, honest Status", () => {
  const seen = {};
  for (const [name, dropAt, team, events] of CASES) {
    for (const [ev, at] of events) {
      for (const tt of [at - 1, at + 1]) {
        const s = stateAt(tt, dropAt, team);
        if (s.code === "rostered") continue;
        const st = MK.statusFor(s);
        seen[s.code] = st.label;
        if (s.code === "available_now") t.equal(st.label, "Add now", name + " / " + ev);
        if (s.code === "waivers") { t.equal(st.label, "Claim now", name + " / " + ev); t.ok(st.sub && st.sub === MK.compactRun(s.eligible_run_label) && /run$/.test(st.sub), "names the run the claim goes to: " + st.sub); }
        if (s.code === "waivers_later") { t.equal(st.label, "Can't claim yet"); t.ok(/^first eligible: /.test(st.sub), "names the first run that can award him: " + st.sub); }
        if (s.code === "game_locked") { t.equal(st.label, "Game locked"); t.ok(/first eligible: /.test(st.sub), st.sub); }
        t.ok(st.title.length > 0, "the resolver's headline and reasons ride along");
      }
    }
  }
  for (const code of ["available_now", "waivers", "waivers_later", "game_locked"]) t.ok(seen[code], "covered: " + code);
  const labels = Object.values(MK.AVAIL).map((a) => a.label);
  t.equal(new Set(labels).size, labels.length, "no two states share a label");
});

test("Demario Davis (dropped in Thursday's run): Can't claim yet → first eligible Saturday; Friday after the run: Claim now", () => {
  const thu = MK.statusFor(stateAt(THU_RUN + 60, THU_RUN, "NYJ"));
  t.equal(thu.label, "Can't claim yet"); t.ok(/Sat/.test(thu.sub), thu.sub);
  const fri = MK.statusFor(stateAt(FRI_RUN + 60, THU_RUN, "NYJ"));
  t.equal(fri.label, "Claim now"); t.ok(/Sat/.test(fri.sub), "goes to Saturday's run: " + fri.sub);
  const sun = MK.statusFor(stateAt(SUN_RUN + 60, THU_RUN, "NYJ"));
  t.equal(sun.label, "Add now", "Sunday after the run: first come, first served");
  const ko = MK.statusFor(stateAt(W6.kickoffs.NYJ + 60, THU_RUN, "NYJ"));
  t.equal(ko.label, "Game locked");
  t.equal(MK.statusFor(stateAt(ROLL6 + 60, THU_RUN, "NYJ")).label, "Claim now", "after the weekly rollover: claim for Thursday");
});

test("run labels are shortened for the cell, never changed", () => {
  t.equal(MK.compactRun("Thursday's run, Oct 22 at 9:00 AM ET"), "Thu Oct 22 run");
  t.equal(MK.compactRun("Saturday's run, Oct 17 at 9:00 AM ET"), "Sat Oct 17 run");
  t.equal(MK.compactRun("something else"), "something else", "an unexpected label passes through untouched");
});

test("isLater = drop-locked, game-locked or no run before his game — never claimable-now players", () => {
  t.equal(MK.isLater("waivers_later"), true); t.equal(MK.isLater("game_locked"), true); t.equal(MK.isLater("not_before_kickoff"), true);
  t.equal(MK.isLater("waivers"), false); t.equal(MK.isLater("available_now"), false); t.equal(MK.isLater("unknown"), false);
  t.equal(MK.statusFor({ code: "unknown", headline: "x" }).label, "Can't confirm", "an unreadable answer is never 'available'");
  t.equal(MK.statusFor(undefined).label, "Can't confirm");
});

test("the Market only reads: bids/adds hand off to the phone app, trades to the one War Room route", () => {
  t.ok(!/fetch\(/.test(SRC) && !/method:\s*"POST"/.test(SRC), "no fetch, no POST in the view");
  t.ok(/Bids and adds are made in the phone app/.test(SRC), "says where acting happens");
  t.ok(/FO\.warRoomUrl\(\{ twb_left_team: me, twb_right_team: r\.fid, twb_player_id: r\.pid/.test(SRC), "War Room link preselects partner + player");
  t.ok(/ranked\(a\) !== ranked\(b\)/.test(SRC), "PPG sort puts ranked players first (phone rule)");
});

test("launch revision (Keith 2026-10-26): no 'Claim now' chip, no Contract column for free agents, no 'On the block' chip inside the On the block view", () => {
  t.ok(/if \(st\.cls === "claim"\) return '<span class="fo-muted"/.test(SRC), "a claimable free agent shows the named run as plain text, not a Claim now chip");
  t.ok(/var showContract = view\.scope !== "fa";/.test(SRC) && /\(showContract \? th\("salary", "Contract"/.test(SRC) && /\(showContract \? '<td class="num">' \+ \(r\.p \?/.test(SRC), "the Contract header and cells only where rostered players can be listed");
  t.ok(/colspan="' \+ \(showContract \? 11 : 10\)/.test(SRC), "the empty-state row spans the visible columns");
  t.ok(/r\.bait && r\.bait === r\.fid && view\.scope !== "bait"/.test(SRC), "the On the block chip is dropped inside the On the block view only");
  t.ok(/\["bait", "On the block"\]/.test(SRC), "the On the block view stays");
  t.ok(/\(st\.sub \? "Claim for " : ""\) \+ H\.esc\(st\.sub\)/.test(SRC), "the plain-text cell says the claim is FOR the named run, never 'now'");
  t.equal(MK.statusFor({ code: "waivers", eligible_run_label: "Thursday's run, Oct 22 at 9:00 AM ET" }).sub, "Thu Oct 22 run", "the run name is still produced for the plain-text cell");
});

test("Market choices (Keith 2026-10-27): one Free agents view, On the block, All players; the team filter belongs to the last two only", () => {
  t.ok(/\[\["fa", "Free agents"\], \["bait", "On the block"\], \["all", "All players"\]\]/.test(SRC), "exactly three choices, in that order");
  t.ok(!/Waivers later|Other teams|scope === "(later|rostered)"|\["(later|rostered)",/.test(SRC), "no Waivers later or Other teams choice, and no filter branch for them");
  t.ok(/if \(view\.scope === "fa" && r\.fid\) return false;/.test(SRC) && !/isLater\(a\.code\)\) return false/.test(SRC), "Free agents = every unrostered player; none is hidden for a later run");
  t.ok(/function teamFilterApplies\(\) \{ return view\.scope === "bait" \|\| view\.scope === "all"; \}/.test(SRC), "the team filter is defined for On the block and All players only");
  t.ok(/teamFilterApplies\(\) && view\.team && r\.fid !== view\.team/.test(SRC), "a team picked elsewhere never filters (and never silently filters Free agents)");
  t.ok(/\(teamFilterApplies\(\) \? '<label class="fo-field fo-inline">Team <select data-mk-team>/.test(SRC), "the Team control is drawn only in those two views");
  // A row's own status is the waiver check's, with the first eligible run beside it; a row that can't be claimed gets no Bid/Add link.
  const later = MK.statusFor({ code: "waivers_later", eligible_run_label: "Saturday's run, Oct 24 at 9:00 AM ET", headline: "h" });
  t.equal(later.label, "Can't claim yet"); t.equal(later.sub, "first eligible: Sat Oct 24 run");
  t.ok(/a\.code === "available_now" \|\| a\.code === "waivers"\)/.test(SRC), "the Bid / Add link appears only for add-now and claim-now rows");
  t.ok(/th\("", "Status", "Free agents: when the player can be added or claimed/.test(SRC), "the Status column is kept for Free agents");
});

await run("front_office_market");
