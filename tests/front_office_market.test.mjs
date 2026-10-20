// Front Office → Market (#1338): free agents' status is the league's ONE waiver resolver, word for word, with the
// states kept apart (add now / claim now for a named run / can't claim yet with the first run that can award him /
// game locked); "Waivers later" lists exactly the not-yet-claimable ones; the view never sends anything.
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

test("“Waivers later” = drop-locked, game-locked or no run before his game — never claimable-now players", () => {
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

await run("front_office_market");
