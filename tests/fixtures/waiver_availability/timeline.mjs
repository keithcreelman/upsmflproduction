// Keith's four availability cases (2026-10-17), on a controllable clock, for the waiver-availability tests.
// One definition shared by the resolver test and the phone-surfaces test.
//
// The badge names the first run that can AWARD the player; Bid returns early enough to SUBMIT a claim before it.
// Inputs mirror what GET /api/waivers/availability passes: Thu/Fri/Sat/Sun 9:00 AM ET runs, the Sunday 9:00 AM →
// Monday 9:00 PM first-come window, NFL Weeks 6 and 7 of 2026 (MFL nflSchedule), and the league's weekly rollover
// 7 hours after a week's last kickoff (resolveCurrentLineupWeek).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveWaiverAvailability } from "../../../worker/src/waiver_availability.js";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const J = (f) => JSON.parse(fs.readFileSync(path.join(DIR, f), "utf8"));
export const W6 = J("nfl_2026_w6.json");
export const W7 = J("nfl_2026_w7.json");
export const GRACE = 7 * 3600;

// hh:mm:ss America/New_York on (y, m, d) as unix seconds (EDT = UTC−4, EST = UTC−5).
export function et(y, m, d, hh = 9, mm = 0, ss = 0) {
  for (const off of [4, 5]) {
    const u = Date.UTC(y, m - 1, d, hh + off, mm, ss) / 1000;
    const got = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(u * 1000));
    if (got === `${String(m).padStart(2, "0")}/${String(d).padStart(2, "0")}/${y}, ${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`) return u;
  }
  throw new Error(`no such ET time ${y}-${m}-${d} ${hh}:${mm}`);
}
// The league's Thu/Fri/Sat/Sun 9:00 AM ET runs, Oct 1 – Nov 15 2026.
export const RUNS = [];
for (let k = 0; k < 46; k++) {
  const d = new Date(Date.UTC(2026, 9, 1 + k));
  if ([4, 5, 6, 0].includes(d.getUTCDay())) RUNS.push(et(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()));
}
export const THU_RUN = et(2026, 10, 15), FRI_RUN = et(2026, 10, 16), SAT_RUN = et(2026, 10, 17), SUN_RUN = et(2026, 10, 18);
export const NEXT_THU = et(2026, 10, 22), NEXT_FRI = et(2026, 10, 23), MON_RELOCK = et(2026, 10, 19, 21, 0);
export const ROLL6 = W6.last_kickoff_unix + GRACE;   // Tue Oct 20, 3:15 AM ET

export const weekAt = (t) => (t < ROLL6
  ? { known: true, week: 6, kickoffs: W6.kickoffs, last_kickoff_unix: W6.last_kickoff_unix, rollover_unix: ROLL6 }
  : { known: true, week: 7, kickoffs: W7.kickoffs, last_kickoff_unix: W7.last_kickoff_unix, rollover_unix: W7.last_kickoff_unix + GRACE });
export const fcfsOpen = (t) => {
  const p = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", hour: "2-digit", hourCycle: "h23" }).formatToParts(new Date(t * 1000));
  const wd = p.find((x) => x.type === "weekday").value, h = +p.find((x) => x.type === "hour").value;
  return (wd === "Sun" && h >= 9) || (wd === "Mon" && h < 21);
};

// The whole server answer at time t, with player "1" dropped at dropAt (or never) and on NFL team `team`.
export function payloadAt(t, dropAt, team) {
  const fc = fcfsOpen(t);
  return {
    ok: true,
    window: { mode: fc ? "fcfs" : "bbid", fcfs_closes_unix: fc ? MON_RELOCK : null },
    ...resolveWaiverAvailability({
      now_unix: t,
      rule: { known: true, mode: "first_run_after", days: 1, prevent_gametime_moves: true },
      runs: { known: true, list: RUNS },
      window: { mode: fc ? "fcfs" : "bbid", fcfs_closes_unix: fc ? MON_RELOCK : null },
      week: weekAt(t),
      drops: { known: true, by_player: dropAt && dropAt <= t ? { 1: { dropped_at_unix: dropAt, franchise_id: "0008", via: "waiver_claim" } } : {} },
      teams: { 1: team }, franchise_names: { "0008": "Real Deal Creel" },
      processed_runs: RUNS.filter((r) => r <= t),
    }),
  };
}
export function stateAt(t, dropAt, team) {
  if (dropAt && t < dropAt) return { code: "rostered" };
  const p = payloadAt(t, dropAt, team);
  return p.players["1"] || p.by_team[team] || p.no_game;
}
// What an owner sees where the control goes.
export const control = (s) => s.code === "rostered" ? "(on a roster)" : s.code === "available_now" ? "Add now" : s.code === "waivers" ? "Bid" : s.badge;

const KO_NYJ = W6.kickoffs.NYJ, KO_SEA = W6.kickoffs.SEA;
// [case, drop instant (null = never dropped), NFL team, [event, instant, control before, first-award run before, control after, run after]]
export const CASES = [
  ["1. dropped Thu 9:00 AM (Demario Davis, NYJ)", THU_RUN, "NYJ", [
    ["the drop", THU_RUN, "(on a roster)", null, "Sat waiver", SAT_RUN],
    ["the 24-hour mark = Friday's run", FRI_RUN, "Sat waiver", SAT_RUN, "Bid", SAT_RUN],
    ["Saturday's run = the claim deadline", SAT_RUN, "Bid", SAT_RUN, "Bid", SUN_RUN],
    ["Sunday's run", SUN_RUN, "Bid", SUN_RUN, "Add now", null],
    ["his kickoff", KO_NYJ, "Add now", null, "Game locked", NEXT_THU],
    ["the Monday 9:00 PM re-lock", MON_RELOCK, "Game locked", NEXT_THU, "Game locked", NEXT_THU],
    ["the weekly rollover", ROLL6, "Game locked", NEXT_THU, "Bid", NEXT_THU]]],
  ["2. dropped Fri 9:00 AM (NYJ)", FRI_RUN, "NYJ", [
    ["the drop", FRI_RUN, "(on a roster)", null, "Sun waiver", SUN_RUN],
    ["the 24-hour mark = Saturday's run", SAT_RUN, "Sun waiver", SUN_RUN, "Bid", SUN_RUN],
    ["Sunday's run = the claim deadline", SUN_RUN, "Bid", SUN_RUN, "Add now", null],
    ["his kickoff", KO_NYJ, "Add now", null, "Game locked", NEXT_THU],
    ["the weekly rollover", ROLL6, "Game locked", NEXT_THU, "Bid", NEXT_THU]]],
  ["3. dropped Sat 9:00 AM (NYJ, Sunday 1:00 PM game)", SAT_RUN, "NYJ", [
    ["the drop", SAT_RUN, "(on a roster)", null, "Thu waiver", NEXT_THU],
    ["the 24-hour mark = Sunday's run (no FCFS for him)", SUN_RUN, "Thu waiver", NEXT_THU, "Thu waiver", NEXT_THU],
    ["his kickoff", KO_NYJ, "Thu waiver", NEXT_THU, "Game locked", NEXT_THU],
    ["the Monday 9:00 PM re-lock", MON_RELOCK, "Game locked", NEXT_THU, "Game locked", NEXT_THU],
    ["the weekly rollover", ROLL6, "Game locked", NEXT_THU, "Bid", NEXT_THU],
    ["Thursday's run = the claim deadline", NEXT_THU, "Bid", NEXT_THU, "Bid", NEXT_FRI]]],
  ["4. never dropped, game started (SEA, Thursday night)", null, "SEA", [
    ["his kickoff", KO_SEA, "Thu waiver", NEXT_THU, "Game locked", NEXT_THU],
    ["Friday's run", FRI_RUN, "Game locked", NEXT_THU, "Game locked", NEXT_THU],
    ["the Monday 9:00 PM re-lock", MON_RELOCK, "Game locked", NEXT_THU, "Game locked", NEXT_THU],
    ["the weekly rollover", ROLL6, "Game locked", NEXT_THU, "Bid", NEXT_THU],
    ["Thursday's run = the claim deadline", NEXT_THU, "Bid", NEXT_THU, "Bid", NEXT_FRI]]],
];
