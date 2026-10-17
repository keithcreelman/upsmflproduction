// The phone app shows the worker's waiver-availability answer and never re-derives it (Keith 2026-10-17, Demario Davis).
//   node tests/mobile_waiver_availability.test.mjs
//
// One lookup for every surface: players[pid] (a recent drop) || by_team[his NFL team] || no_game. Past a run, the
// rosters on screen may predate it, so the app says so ("pull down to refresh") instead of showing a pre-run answer.
// The functions below are the REAL ones from site/m/app.js and site/m/views/players.js, cut out by their text.
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { t, test, run } from "./fixtures/mini_test.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const APP = fs.readFileSync(path.join(ROOT, "site/m/app.js"), "utf8");
const PL = fs.readFileSync(path.join(ROOT, "site/m/views/players.js"), "utf8");
const sliceFn = (src, sig) => {
  const at = src.indexOf(sig); if (at < 0) throw new Error("not found: " + sig);
  let i = src.indexOf("{", at), depth = 0;
  for (; i < src.length; i++) { if (src[i] === "{") depth++; else if (src[i] === "}" && --depth === 0) return src.slice(at, i + 1); }
  throw new Error("unbalanced: " + sig);
};

const FRI_RUN = 1792155600, SAT_RUN = 1792242000;   // Fri / Sat Oct 16 / 17 2026, 9:00 AM ET
const PAYLOAD = {
  ok: true, now_unix: FRI_RUN - 1800, changes_at_unix: FRI_RUN, next_run_unix: FRI_RUN, next_run_label: "Friday's run, Oct 16 at 9:00 AM ET",
  last_run_unix: FRI_RUN - 86400, last_run_label: "Thursday's run, Oct 15 at 9:00 AM ET",
  players: { 10816: { code: "waivers_later", badge: "Sat waiver", headline: "Waivers — eligible for Saturday's run, Oct 17 at 9:00 AM ET", lines: ["…"], eligible_run_unix: SAT_RUN } },
  by_team: { NYJ: { code: "waivers", badge: "", headline: "Waivers — next run: Friday's run, Oct 16 at 9:00 AM ET", eligible_run_label: "Friday's run, Oct 16 at 9:00 AM ET", lines: [] },
             SEA: { code: "game_locked", badge: "Game locked", headline: "Game locked — eligible again for Thursday's run, Oct 22 at 9:00 AM ET", lines: [] } },
  no_game: { code: "waivers", badge: "", headline: "Waivers — next run: Friday's run, Oct 16 at 9:00 AM ET", lines: [] },
};

function loadApp({ nowSec, rostersReadSec, payload = PAYLOAD, error = "" }) {
  const ctx = vm.createContext({ JSON, String, Object, console });
  ctx.Date = { now: () => nowSec * 1000 };
  ctx.refetches = 0;
  ctx.state = { waiverAvail: payload, waiverAvailError: error, rostersReadAt: rostersReadSec * 1000, waiverAvailTriedAt: 0 };
  ctx.fetchWaiverAvailability = () => { ctx.refetches++; return { then() {} }; };
  vm.runInContext(sliceFn(APP, "function waiverAvailabilityFor(") + "\nthis.forPid = waiverAvailabilityFor;", ctx);
  return ctx;
}

test("one lookup: a recent drop, else his NFL team's state, else no-game; null while loading; a failed load says so", () => {
  const a = loadApp({ nowSec: FRI_RUN - 1200, rostersReadSec: FRI_RUN - 1500 });
  t.equal(a.forPid("10816", "NYJ").badge, "Sat waiver", "Demario Davis: his own entry wins over NYJ's");
  t.equal(a.forPid("99999", "nyj").code, "waivers");
  t.equal(a.forPid("88888", "SEA").code, "game_locked");
  t.equal(a.forPid("77777", "").code, "waivers", "no team → no_game");
  t.equal(loadApp({ nowSec: FRI_RUN - 1200, rostersReadSec: FRI_RUN - 1500, payload: null }).forPid("1", "NYJ"), null);
  t.match(loadApp({ nowSec: FRI_RUN - 1200, rostersReadSec: 0, payload: null, error: "the availability check didn't load" }).forPid("1", "NYJ").headline,
    /^Availability could not be confirmed — the availability check didn't load\. Pull down to refresh\.$/);
});

test("after a waiver run: re-read, and say the rosters may be pre-run until they're refreshed", () => {
  const during = loadApp({ nowSec: FRI_RUN + 60, rostersReadSec: FRI_RUN - 1500 });
  const st = during.forPid("10816", "NYJ");
  t.equal(st.code, "unknown"); t.equal(st.stale, true);
  t.match(st.headline, /Friday's run, Oct 16 at 9:00 AM ET is processing\. Pull down to refresh in a few minutes\.$/);
  t.equal(during.refetches, 1, "the availability payload is re-read once its changes_at passes");
  const later = loadApp({ nowSec: FRI_RUN + 900, rostersReadSec: FRI_RUN - 1500 });
  t.match(later.forPid("1", "NYJ").headline, /has processed since your rosters loaded\. Pull down to refresh\.$/);
  // A fresh payload (next run Sat) with rosters read after Friday's run + 5 min: the real answer again.
  const fresh = loadApp({ nowSec: FRI_RUN + 900, rostersReadSec: FRI_RUN + 600,
    payload: { ...PAYLOAD, now_unix: FRI_RUN + 800, changes_at_unix: SAT_RUN, next_run_unix: SAT_RUN, last_run_unix: FRI_RUN, last_run_label: "Friday's run, Oct 16 at 9:00 AM ET" } });
  t.equal(fresh.forPid("1", "NYJ").code, "waivers");
  t.equal(fresh.refetches, 0);
});

test("the Market shows the status badge instead of Bid / Add whenever MFL would refuse him at the next run", () => {
  const ctx = vm.createContext({ String, Object, console });
  ctx.U = { escapeHtml: (s) => String(s) };
  vm.runInContext(PL.slice(PL.indexOf("  var AVAIL_NOT_NOW ="), PL.indexOf("  // The explanation itself:")) + "\nthis.blocks = availBlocks; this.chip = availChipHtml;", ctx);
  for (const c of ["waivers_later", "game_locked", "not_before_kickoff", "unknown", "closed"]) t.equal(ctx.blocks({ code: c }), true, c);
  for (const c of ["waivers", "available_now", "claim_pending"]) t.equal(ctx.blocks({ code: c }), false, c);
  const chip = ctx.chip("10816", PAYLOAD.players["10816"]);
  t.match(chip, /data-act="waiver-why" data-pid="10816"/); t.match(chip, />Sat waiver<\/button>$/);
  t.match(ctx.chip("1", null), /Checking…/, "still loading: a neutral chip, never a Bid button");
  t.match(PL, /else if \(act === "waiver-why"\) \{ if \(M\.sheet\) M\.sheet\.open\(wpid\); \}/, "tapping the badge opens the player sheet (the explanation)");
  t.match(PL, /if \(!stagedRoundsFor\(pid\)\.length && refuseUnlessAvailable\(pid\)\) return;/, "Bid re-checks before a new claim");
  t.match(PL, /if \(refuseUnlessAvailable\(pid\)\) return;/, "Add now re-checks too");
  t.match(PL, /availWarnHtml\(p\.add_pid\)/, "Claims screen flags a staged claim MFL would refuse");
  t.match(PL, /availWarnHtml\(bidView\.addPid\)/, "so does the bid sheet");
});

await run("mobile_waiver_availability");
