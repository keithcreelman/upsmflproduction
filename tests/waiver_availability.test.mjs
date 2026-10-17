// When can a free agent actually be claimed? (Keith 2026-10-17, Demario Davis)
//   node tests/waiver_availability.test.mjs
//
// Demario Davis was dropped in Thursday's 9:00 AM run (2026-10-15). A claim for him
// in Friday's 9:00 AM run failed — MFL: "Player Is Locked" — and nothing in the app
// said he was ineligible or when he would be. MFL's league setting is "Dropped
// Players Are Locked Until: The first waivers run after 1 day(s)", so Friday's run,
// exactly 24 hours after the drop and not after it, was too early; Saturday's was
// his first. These tests run the REAL resolver (worker/src/waiver_availability.js)
// on constructed cases, on this week's real MFL data, and on every drop-then-add
// in MFL's 2022–2026 transaction log.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { t, test, run } from "./fixtures/mini_test.mjs";
import {
  DAY_SEC, parseDropLockSetting, dropsFromTransactions, resolveWaiverAvailability, runLabel,
} from "../worker/src/waiver_availability.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FX = path.join(ROOT, "tests/fixtures/waiver_availability");
const J = (f) => JSON.parse(fs.readFileSync(path.join(FX, f), "utf8"));

// hh:mm:ss America/New_York on (y, m, d) as unix seconds (EDT = UTC−4, EST = UTC−5).
function et(y, m, d, hh = 9, mm = 0, ss = 0) {
  for (const off of [4, 5]) {
    const u = Date.UTC(y, m - 1, d, hh + off, mm, ss) / 1000;
    const got = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(u * 1000));
    const want = `${String(m).padStart(2, "0")}/${String(d).padStart(2, "0")}/${y}, ${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
    if (got === want) return u;
  }
  throw new Error(`no such ET time ${y}-${m}-${d} ${hh}:${mm}`);
}
// The league's Thu/Fri/Sat/Sun 9:00 AM ET runs, Oct 1 – Nov 15 2026.
const RUNS = [];
for (let k = 0; k < 46; k++) {
  const d = new Date(Date.UTC(2026, 9, 1 + k));
  if ([4, 5, 6, 0].includes(d.getUTCDay())) RUNS.push(et(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()));
}
const RULE = { known: true, mode: "first_run_after", days: 1, prevent_gametime_moves: true, text: "Dropped players are locked until the first waivers run after 1 day(s)." };
const W6 = J("nfl_2026_w6.json");   // NFL week 6, 2026: SEA–DEN Thu 10-15 8:15 PM … MNF 10-19
const NAMES = { "0008": "Real Deal Creel", "0010": "Blake Bombers", "0007": "Sex Manther" };

function resolve({ now, drops = {}, teams = {}, rule = RULE, week, mode = "bbid", runs = RUNS, fcfsCloses = null, dropsKnown = true }) {
  return resolveWaiverAvailability({
    now_unix: now, rule,
    runs: runs ? { known: true, list: runs } : { known: false, reason: "the waiver calendar couldn't be read" },
    window: { mode, fcfs_closes_unix: fcfsCloses },
    week: week === undefined ? { known: true, week: 6, kickoffs: W6.kickoffs, last_kickoff_unix: W6.last_kickoff_unix } : week,
    drops: dropsKnown ? { known: true, by_player: drops } : { known: false, reason: "MFL's transaction log couldn't be read" },
    teams, franchise_names: NAMES,
  });
}
const drop = (at, fid = "0008", via = "drop") => ({ dropped_at_unix: at, franchise_id: fid, via });

const THU_RUN = et(2026, 10, 15), FRI_RUN = et(2026, 10, 16), SAT_RUN = et(2026, 10, 17), SUN_RUN = et(2026, 10, 18), NEXT_THU = et(2026, 10, 22);

test("MFL's setting, read from the league's own setup page: the first waivers run after 1 day; game-time moves blocked", () => {
  const r = parseDropLockSetting(fs.readFileSync(path.join(FX, "csetup_adddrop_2026.html"), "utf8"));
  t.equal(r.known, true); t.equal(r.mode, "first_run_after"); t.equal(r.days, 1); t.equal(r.prevent_gametime_moves, true);
});

test("Demario Davis's real sequence: dropped in Thursday's 9:00:00 AM run → Friday's run refused (exactly 24 h, not after) → Saturday's run", () => {
  const tx = J("transactions_2026_10_08_16.json").transaction;
  const drops = dropsFromTransactions(tx);
  t.deepEqual(drops["10816"], { dropped_at_unix: THU_RUN, franchise_id: "0008", via: "waiver_claim" }, "the drop half of 0008's claim, stamped at the run instant");
  const before = resolve({ now: FRI_RUN - 30 * 60, drops, teams: { 10816: "NYJ", 14943: "IND" } });   // Fri 8:30 AM, when the claim was entered
  const d = before.players["10816"];
  t.equal(d.code, "waivers_later"); t.equal(d.badge, "Sat waiver");
  t.equal(d.headline, "Waivers — eligible for Saturday's run, Oct 17 at 9:00 AM ET");
  t.equal(d.eligible_run_unix, SAT_RUN); t.equal(d.lock_ends_unix, FRI_RUN);
  t.ok(d.lines.some((l) => l === "Friday's run (Oct 16, 9:00 AM ET) starts exactly at that mark, not after it, so MFL refuses claims for him in it."));
  t.ok(d.lines.some((l) => /^Dropped Thu Oct 15, 9:00 AM ET by Real Deal Creel, as part of its claim in Thursday's run\.$/.test(l)));
  t.ok(d.lines.some((l) => /His game \(NYJ\): Sun Oct 18, 1:00 PM ET — after that run/.test(l)), "the game lock can't supersede Saturday's run");
  // Akeem Davis-Gaither, dropped in the same run by ANOTHER team, was refused the same way.
  t.equal(before.players["14943"].code, "waivers_later"); t.equal(before.players["14943"].eligible_run_unix, SAT_RUN);
});

test("boundaries: just before (eligible), exactly equal (not), just after (not) — strictly after drop + 86,400 s", () => {
  const at = (dropAt) => resolve({ now: dropAt + 60, drops: { 1: drop(dropAt) }, teams: { 1: "NYJ" } }).players["1"];
  t.equal(at(THU_RUN - 1).eligible_run_unix, FRI_RUN, "dropped 8:59:59 Thu → lock ends 8:59:59 Fri → Friday's run");
  t.equal(at(THU_RUN - 1).code, "waivers", "eligible for the very next run: no badge");
  t.equal(at(THU_RUN).eligible_run_unix, SAT_RUN, "exactly 24 h before Friday's run → Saturday");
  t.equal(at(THU_RUN + 1).eligible_run_unix, SAT_RUN, "a second after → Saturday");
  // Real: Tyson Bagent dropped Thu 8:53:40 AM, six minutes before that run → eligible Friday.
  const bag = resolve({ now: FRI_RUN - 1800, drops: dropsFromTransactions(J("transactions_2026_10_08_16.json").transaction), teams: { 16384: "CHI" } }).players["16384"];
  t.equal(bag.code, "waivers"); t.equal(bag.eligible_run_unix, FRI_RUN);
  t.ok(bag.lines.includes("Friday's run starts after that mark, so he's eligible for it."));
});

test("Friday drops: before 9 AM → Saturday; after 9 AM → misses Saturday, moves to Sunday", () => {
  const fri8 = et(2026, 10, 16, 8, 0), fri10 = et(2026, 10, 16, 10, 0);
  t.equal(resolve({ now: fri8 + 60, drops: { 1: drop(fri8) }, teams: { 1: "NYJ" } }).players["1"].eligible_run_unix, SAT_RUN);
  const s = resolve({ now: fri10 + 60, drops: { 1: drop(fri10) }, teams: { 1: "NYJ" } }).players["1"];
  t.equal(s.eligible_run_unix, SUN_RUN); t.equal(s.badge, "Sun waiver");
  t.ok(s.lines.includes("Saturday's run (Oct 17, 9:00 AM ET) starts before that mark, so MFL refuses claims for him in it."));
});

test("no eligible run before kickoff: dropped Sat 10 AM, game Sun 1 PM → lock ends Sun 10 AM, after Sunday's run → Thursday's run", () => {
  const sat10 = et(2026, 10, 17, 10, 0);
  const s = resolve({ now: sat10 + 60, drops: { 1: drop(sat10) }, teams: { 1: "NYJ" } }).players["1"];
  t.equal(s.code, "not_before_kickoff"); t.equal(s.eligible_run_unix, NEXT_THU); t.equal(s.badge, "Thu waiver");
  t.equal(s.headline, "Not eligible before kickoff — first eligible run: Thursday's run, Oct 22 at 9:00 AM ET");
  // A plain (undropped) Thursday-night player after Thursday's run: Friday's run is after his game.
  const den = resolve({ now: THU_RUN + 3600 }).by_team.DEN;
  t.equal(den.code, "not_before_kickoff"); t.equal(den.eligible_run_unix, NEXT_THU);
});

test("already game-locked: Zach Allen (DEN) dropped Thu 8:00 PM, 14 min before his game; Cooper Kupp (SEA) dropped in Thursday's run", () => {
  const drops = dropsFromTransactions(J("transactions_2026_10_08_16.json").transaction);
  const r = resolve({ now: FRI_RUN - 1800, drops, teams: { 14153: "DEN", 13164: "SEA" } });
  for (const pid of ["14153", "13164"]) {
    t.equal(r.players[pid].code, "game_locked"); t.equal(r.players[pid].eligible_run_unix, NEXT_THU); t.equal(r.players[pid].badge, "Game locked");
  }
  t.equal(r.by_team.SEA.code, "game_locked", "every SEA/DEN free agent, dropped or not");
  t.equal(r.by_team.NYJ.code, "waivers");
});

test("no owner-specific restriction: the state is the same whoever dropped him (MFL has none; UPS's re-add rule limits only an MYM)", () => {
  const a = resolve({ now: FRI_RUN - 60, drops: { 1: drop(THU_RUN, "0008") }, teams: { 1: "NYJ" } }).players["1"];
  const b = resolve({ now: FRI_RUN - 60, drops: { 1: drop(THU_RUN, "0010") }, teams: { 1: "NYJ" } }).players["1"];
  t.equal(a.code, b.code); t.equal(a.eligible_run_unix, b.eligible_run_unix); t.equal(a.headline, b.headline);
});

test("MFL decides, not a hard-coded canon number: the display follows the setting MFL reports", () => {
  const two = resolve({ now: FRI_RUN - 60, drops: { 1: drop(THU_RUN) }, teams: { 1: "NYJ" }, rule: { ...RULE, days: 2 } }).players["1"];
  t.equal(two.eligible_run_unix, SUN_RUN, "2 days → Sunday");
  const none = resolve({ now: FRI_RUN - 60, drops: { 1: drop(THU_RUN) }, teams: { 1: "NYJ" }, rule: { known: true, mode: "none", days: 0 } });
  t.equal(none.players["1"], undefined, "no lock → an ordinary free agent (by_team)");
  const page = fs.readFileSync(path.join(FX, "csetup_adddrop_2026.html"), "utf8");
  const period = page.replace(/value="WAIVERS" checked="checked"/, 'value="WAIVERS"').replace(/value="PERIOD"/, 'value="PERIOD" checked="checked"');
  t.equal(parseDropLockSetting(period).known, false, "an MFL option this league doesn't use is reported, never guessed");
});

test("missing or unreadable inputs fail visibly (unknown + reason), never a guessed run", () => {
  t.equal(parseDropLockSetting("<html>league skin, no identity cell</html>").known, false);
  t.equal(parseDropLockSetting('<td class="welcome">Real Deal Creel ( Logout | Become Commissioner )</td>').reason, "setup_page_not_commissioner");
  const page = fs.readFileSync(path.join(FX, "csetup_adddrop_2026.html"), "utf8");
  t.equal(parseDropLockSetting(page.replace(/ checked="checked"/g, "")).reason, "drop_lock_setting_ambiguous");
  const noRule = resolve({ now: FRI_RUN - 60, drops: { 1: drop(THU_RUN) }, teams: { 1: "NYJ" }, rule: { known: false, reason: "MFL's dropped-player setting couldn't be read" } });
  t.equal(noRule.players["1"].code, "unknown"); t.match(noRule.players["1"].headline, /^Availability could not be confirmed — MFL's dropped-player setting couldn't be read$/);
  t.equal(noRule.by_team.NYJ.code, "waivers", "a player with no recent drop doesn't depend on that setting");
  const noTx = resolve({ now: FRI_RUN - 60, dropsKnown: false });
  t.equal(noTx.by_team.NYJ.code, "unknown", "without the drop log, any free agent might be recently dropped");
  t.equal(noTx.no_game.code, "unknown");
  t.equal(resolve({ now: FRI_RUN - 60, runs: null }).by_team.NYJ.code, "unknown");
  t.equal(resolve({ now: FRI_RUN - 60, week: { known: false, reason: "this week's NFL kickoffs couldn't be read" } }).no_game.headline,
    "Availability could not be confirmed — this week's NFL kickoffs couldn't be read");
  t.equal(resolve({ now: FRI_RUN - 60 }).known, true);
  t.equal(noRule.known, false, "the payload says an input was unreadable (and the route won't cache it)");
});

test("daylight saving: dropped Sat 10-31 9:00 EDT → Sunday 11-01 9:00 EST (25 h later) is after the 24-hour mark", () => {
  const sat = et(2026, 10, 31), sun = et(2026, 11, 1);
  t.equal(sun - sat, 25 * 3600);
  const s = resolve({ now: sat + 60, drops: { 1: drop(sat) }, teams: { 1: "XXX" }, week: { known: true, week: 9, kickoffs: {}, last_kickoff_unix: et(2026, 11, 2, 20, 15) } }).players["1"];
  t.equal(s.eligible_run_unix, sun, "a calendar-day reading would wrongly say the following Thursday");
  t.equal(runLabel(sun), "Sunday's run, Nov 1 at 9:00 AM ET");
});

test("availability changes after a waiver run: Friday 8:30 → Sat waiver; Friday 9:01 → next run (no badge); Saturday 9:01 → an ordinary free agent", () => {
  const drops = { 10816: drop(THU_RUN, "0008", "waiver_claim") };
  const teams = { 10816: "NYJ" };
  t.equal(resolve({ now: FRI_RUN - 1800, drops, teams }).players["10816"].code, "waivers_later");
  const fri = resolve({ now: FRI_RUN + 60, drops, teams });
  t.equal(fri.players["10816"].code, "waivers"); t.equal(fri.players["10816"].eligible_run_unix, SAT_RUN);
  t.equal(fri.last_run_unix, FRI_RUN);
  const sat = resolve({ now: SAT_RUN + 60, drops, teams });
  t.equal(sat.players["10816"], undefined); t.equal(sat.by_team.NYJ.eligible_run_unix, SUN_RUN);
  t.equal(resolve({ now: FRI_RUN - 1800, drops, teams }).changes_at_unix, FRI_RUN, "the payload expires at the run");
});

test("FCFS window: everyone else is Available now; a player dropped Sunday morning is locked until Thursday's run", () => {
  const sun11 = et(2026, 10, 18, 11, 0);
  const r = resolve({ now: sun11 + 60, drops: { 1: drop(sun11) }, teams: { 1: "XXX" }, mode: "fcfs", fcfsCloses: et(2026, 10, 19, 21, 0) });
  t.equal(r.by_team.NYJ.code, "available_now");
  t.equal(r.players["1"].code, "waivers_later"); t.equal(r.players["1"].eligible_run_unix, NEXT_THU); t.equal(r.players["1"].badge, "Thu waiver");
});

test("historical replay, 2022–2026: of 1,434 adds of a previously dropped player, none came before the resolver's first eligible run", () => {
  const fx = J("drop_readd_2022_2026.json");
  let early = 0, exact = 0;
  for (const [season, dropAt, addAt] of fx.pairs) {
    const runs = fx.runs[season];
    const st = resolve({ now: dropAt + 1, drops: { 1: drop(dropAt) }, teams: { 1: "" }, runs,
      week: { known: true, week: 1, kickoffs: {}, last_kickoff_unix: 0 } }).players["1"];
    const first = st ? st.eligible_run_unix : runs.find((r) => r > dropAt);
    if (addAt < first) early++;
    if (addAt === first) exact++;
  }
  t.equal(fx.pairs.length, 1434);
  t.equal(early, 0, "never earlier than the rule allows");
  t.equal(exact, 265, "and 265 landed on exactly that run, so it is the real first run, not just a safe one");
});

test("the route serves the one resolver and caches only a fully-read answer; the mobile app renders it", () => {
  const SRC = fs.readFileSync(path.join(ROOT, "worker/src/index.js"), "utf8");
  t.match(SRC, /import \{ parseDropLockSetting, dropsFromTransactions, resolveWaiverAvailability \} from "\.\/waiver_availability\.js";/);
  t.match(SRC, /if \(path === "\/api\/waivers\/availability" && request\.method === "GET"\)/);
  t.match(SRC, /csetup\?L=\$\{encodeURIComponent\(avLeagueId\)\}&C=ADDDROP/);
  t.match(SRC, /if \(av\.known\) \{\s*try \{ ctx\.waitUntil\(caches\.default\.put\(avCacheKey/);
  t.match(SRC, /if \(rule\.known\) \{\s*rule\.read_at_unix/, "only a READ setting is cached");
  const APP = fs.readFileSync(path.join(ROOT, "site/m/app.js"), "utf8");
  t.match(APP, /availability: waiverAvailabilityFor,/);
  const PL = fs.readFileSync(path.join(ROOT, "site/m/views/players.js"), "utf8");
  t.doesNotMatch(PL, /KO\.kickedOff\(/, "no second copy of the game lock in the Market");
  t.match(PL, /var av = availabilityFor\(pid\);\s*if \(!av \|\| availBlocks\(av\)\)/);
  t.equal(DAY_SEC, 86400);
});

await run("waiver_availability");
