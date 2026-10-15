// The ACTIVE season and the strict Week 17 finality behind it (worker/src/league_year.js, #1237; Keith 2026-10-14/15).
// The old season stays until its own last week (the league export's endWeek) is PROVABLY final AND the new league is
// live; evidence that a game isn't over keeps the old season; anything unreadable or contradictory is { ok: false }.
// Never early, never the calendar. A fake MFL plays 2026 Week 17 by its REAL kickoffs (MFL's own 2026 nflSchedule,
// tests/fixtures/nfl_schedule_2026_wk17.json: 16 games, Fri 2027-01-01 01:15 UTC → Tue 2027-01-05 01:15 UTC) and can
// postpone, delay, suspend, drop the clock of, or withhold the points of any game.
//   node tests/season_active_finality.test.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test, t, run } from "./fixtures/mini_test.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LY = await import(process.env.LEAGUE_YEAR_JS ? "file://" + process.env.LEAGUE_YEAR_JS : "../worker/src/league_year.js");
const WK17 = JSON.parse(fs.readFileSync(path.join(ROOT, "tests/fixtures/nfl_schedule_2026_wk17.json"), "utf8"));
const KICKOFFS = [...new Set(WK17.games.map((g) => g.kickoff * 1000))].sort((a, b) => a - b);
const FIRST = KICKOFFS[0], LAST = KICKOFFS[KICKOFFS.length - 1];
const H = 3600e3, MIN = 60e3, DAY = 24 * H;
const GAME = 3.25 * H, LAG = 20 * MIN;          // a game's length; MFL posts its points 20 minutes after it ends
const MNF = WK17.games.find((g) => g.kickoff * 1000 === LAST).teams[0];   // HOU (@ GBP), the last game
const iso = (ms) => new Date(ms).toISOString().replace(".000", "");
const NOT_FOUND_HTML = "<H1>Not Found</H1>\n<p>The requested URL was not found on this server.</p>\n";

// ── The fake MFL ──
// o.renewed: 2027 exists (created early) and every linked year's history lists it. o.y2027: "notfound" | "invalid".
// o.down: league years whose export answers 500. o.schedDown / o.scoresDown / o.liveDown: those reads fail.
// o.histLists2027: override 2026's history (a contradiction when it differs from renewed). o.schedWeek: wrong echo.
// o.livePlaying: franchises MFL's live scoring shows still playing.
// o.game[awayTeam]: { kickoff (ms, moved), delay (ms), length (ms), suspendAt (ms after start), noClock, points:
//   "both" | "one" | "none", glitch0: true (clock reads 0 from kickoff) } for one game.
function fakeMfl(o) {
  o = Object.assign({ renewed: false, y2027: "notfound", down: [], game: {}, livePlaying: 0 }, o || {});
  const lists2027 = o.histLists2027 == null ? o.renewed : o.histLists2027;
  const hist = (upto) => Array.from({ length: upto - 2009 }, (_, i) => ({ year: String(2010 + i) }));
  const leagueText = (y) => JSON.stringify({ league: { id: "74598", endWeek: "17", history: { league: hist(y === 2027 || lists2027 ? 2027 : 2026) } } });
  const play = (g, now, shift) => {
    const x = o.game[g.teams[0]] || {};
    const ko = (x.kickoff || g.kickoff * 1000) + shift, start = ko + (x.delay || 0), len = x.length || GAME;
    let clock, live = false;
    if (now < start) clock = "3600";
    else if (x.suspendAt != null && now >= start + x.suspendAt) clock = "1234";
    else if (now < start + len) { clock = x.glitch0 || (len > GAME && now >= start + GAME) ? "0" : "900"; live = true; }
    else clock = "0";
    const ended = clock === "0" && !live, done = ended ? start + len : Infinity;
    const m = { kickoff: String(Math.floor(ko / 1000)), team: g.teams.map((id, i) => ({ id, score: now >= start ? String(20 - i) : "", hasPossession: live && i === 0 ? "1" : "0" })) };
    if (!x.noClock) m.gameSecondsRemaining = clock;
    const pts = x.points || "both";
    const posted = x.suspendAt != null ? (now >= start + x.suspendAt ? g.teams : []) : (now >= done + LAG ? g.teams : []);
    return { m, scored: pts === "none" ? [] : (pts === "one" ? posted.slice(0, 1) : posted) };
  };
  const calls = [];
  const week = (y, now) => WK17.games.map((g) => play(g, now, y === 2026 ? 0 : -364 * DAY));
  return {
    calls,
    readLeague: async (y) => {
      calls.push("league " + y);
      if (o.down.includes(y)) return { status: 500, text: "MFL error" };
      if (y === 2027 && !o.renewed) return o.y2027 === "invalid" ? { status: 200, text: JSON.stringify({ version: "1.0", error: { $t: "Invalid league ID 74598" } }) } : { status: 404, text: NOT_FOUND_HTML };
      if (y > 2027 || y < 2010) return { status: 404, text: NOT_FOUND_HTML };
      return { status: 200, text: leagueText(y) };
    },
    at(now) {
      return {
        readSchedule: async (y, w) => { calls.push(`nflSchedule ${y} w${w}`); if (y === 2026 && o.schedDown) throw new Error("http_500");
          return { nflSchedule: { week: String(o.schedWeek || w), matchup: week(y, now).map((x) => x.m) } }; },
        readScores: async (y, w) => { calls.push(`playerScores ${y} w${w}`); if (o.scoresDown) throw new Error("http_500");
          const rows = week(y, now).flatMap((x) => x.scored.map((tm) => ({ id: "P_" + tm, score: "12.5" })));
          return { playerScores: { week: String(w), playerScore: rows.length ? rows : { id: "", score: "" } } }; },
        readPlayers: async (y) => { calls.push("players " + y);
          return { players: { player: WK17.games.flatMap((g) => g.teams.map((tm) => ({ id: "P_" + tm, team: tm, position: "PK", name: "Kicker, " + tm }))) } }; },
        readLive: async (y, w) => { calls.push(`liveScoring ${y} w${w}`); if (o.liveDown) throw new Error("http_500");
          return { liveScoring: { week: String(w), matchup: [{ franchise: [{ id: "0001", playersCurrentlyPlaying: String(o.livePlaying) }, { id: "0002", playersCurrentlyPlaying: "0" }] }] } }; },
      };
    },
  };
}
async function decide(o, now, extra) {
  const fx = fakeMfl(o);
  const r = await LY.resolveActiveSeason(Object.assign({ leagueId: "74598", nowMs: now, readLeague: fx.readLeague }, fx.at(now), extra || {}));
  return Object.assign(r, { calls: fx.calls });
}
const END = LAST + GAME + LAG;      // MNF over and its points posted: Week 17 provably final
const MOMENTS = [
  ["Thu Dec 31 2026 6:59 PM ET", Date.parse("2026-12-31T23:59:00Z")],
  ["Jan 1 2027 00:00 UTC (the calendar turns)", Date.parse("2027-01-01T00:00:00Z")],
  ...KICKOFFS.map((k) => ["kickoff " + iso(k), k]),
  ["MNF in its 4th quarter", LAST + 3 * H],
  ["MNF over, its points not posted yet", LAST + GAME + 5 * MIN],
];

test("fixture: MFL's real 2026 Week 17 — 16 games, Fri 2027-01-01 01:15 UTC → Tue 2027-01-05 01:15 UTC (HOU @ GBP last)", () => {
  t.equal(WK17.games.length, 16); t.equal(iso(FIRST), "2027-01-01T01:15:00Z"); t.equal(iso(LAST), "2027-01-05T01:15:00Z"); t.equal(MNF, "HOU");
});

// ── 1. one game ──
test("seasonGameFinal: the rule, one game at a time", () => {
  const ko = 1799111700, now = (h) => ko * 1000 + h * H, S = (...t) => new Set(t);
  const g = (x) => Object.assign({ kickoff: String(ko), gameSecondsRemaining: "0", team: [{ id: "HOU", hasPossession: "0" }, { id: "GBP", hasPossession: "0" }] }, x);
  const cases = [
    ["clock 0, both teams' points", g({}), 4, S("HOU", "GBP"), true, "clock_0+both_scored"],
    ["overtime: clock 0 at 4 h (after the regulation window), both points", g({}), 4.2, S("HOU", "GBP"), true, "clock_0+both_scored"],
    ["clock 0, ONE team's points", g({}), 4, S("HOU"), false, "no_points_GBP"],
    ["clock 0, no points", g({}), 4, S(), false, "no_points_HOU_GBP"],
    ["clock 0 but a team has the ball (overtime drive)", g({ team: [{ id: "HOU", hasPossession: "1" }, { id: "GBP" }] }), 3.6, S("HOU", "GBP"), false, "a_team_has_the_ball"],
    ["clock 0 only 30 minutes after kickoff (feed glitch)", g({}), 0.5, S("HOU", "GBP"), false, "clock_0_too_soon_after_kickoff"],
    ["suspended: clock stuck at 1234 for 3 days", g({ gameSecondsRemaining: "1234" }), 72, S("HOU", "GBP"), false, "clock_1234"],
    ["delayed: clock still 3600 two hours after kickoff", g({ gameSecondsRemaining: "3600" }), 2, S("HOU", "GBP"), false, "clock_3600"],
    ["postponed in place: no clock, no points, 30 h after the old kickoff", g({ gameSecondsRemaining: undefined }), 30, S(), false, "no_points_HOU_GBP"],
    ["postponed: kickoff moved to tomorrow", g({ kickoff: String(ko + 86400), gameSecondsRemaining: "3600" }), 5, S(), false, "not_started"],
    ["missing clock, 4 h after kickoff, both points", g({ gameSecondsRemaining: "" }), 4, S("HOU", "GBP"), false, "no_clock_under_5h"],
    ["missing clock, 5 h after kickoff, both points", g({ gameSecondsRemaining: "" }), 5, S("HOU", "GBP"), true, "no_clock+5h+both_scored"],
    ["missing clock, 5 h after kickoff, ONE team's points", g({ gameSecondsRemaining: undefined }), 6, S("GBP"), false, "no_points_HOU"],
    ["negative clock (an overtime count)", g({ gameSecondsRemaining: "-120" }), 4, S("HOU", "GBP"), false, "clock_-120"],
    ["points unread", g({}), 4, null, false, "points_unread"],
  ];
  for (const [label, m, h, scored, final, why] of cases) {
    const r = LY.seasonGameFinal(m, now(h), scored);
    t.ok(r.final === final && r.why === why, `${label}: ${JSON.stringify(r)}`);
  }
});

// ── 2. the season ──
test("(a) no 2027 league (404 or 'Invalid league ID'): 2026 on Oct 14, at every Week 17 moment, after it, on Jan 20", async () => {
  for (const y2027 of ["notfound", "invalid"]) {
    for (const [label, now] of [["Oct 14 2026", Date.parse("2026-10-14T16:00:00Z")], ...MOMENTS, ["after Week 17", END + H], ["Jan 20", Date.parse("2027-01-20T12:00:00Z")]]) {
      const r = await decide({ y2027 }, now);
      t.ok(r.ok && r.season === "2026", `${y2027} · ${label}: ${JSON.stringify(r)}`);
    }
  }
});
test("(b) 2027 created early: 2026 at every Week 17 moment up to MNF's points (the players export isn't read while games are still on)", async () => {
  for (const [label, now] of [["Dec 20", Date.parse("2026-12-20T12:00:00Z")], ...MOMENTS]) {
    const r = await decide({ renewed: true }, now);
    t.ok(r.ok && r.season === "2026" && /^season_2026_not_complete:w17:/.test(r.source), `${label}: ${JSON.stringify(r)}`);
    if (now < LAST + GAME) t.ok(!r.calls.some((c) => /^players |^playerScores |^liveScoring /.test(c)), label + ": " + r.calls.join(", "));
  }
});
test("(c) Week 17 provably final (MNF clock 0, both teams' points, nobody playing) + 2027 live → 2027 at that moment; settled after 4 days", async () => {
  t.equal((await decide({ renewed: true }, END - MIN)).season, "2026");
  const r = await decide({ renewed: true }, END);
  t.ok(r.ok && r.season === "2027", JSON.stringify(r));
  t.equal(r.source, "season_2026_complete:w17:all_16_games_final+league_2027_live");
  const s = await decide({ renewed: true, scoresDown: true, liveDown: true }, LAST + 4 * DAY + H);
  t.equal(s.season, "2027"); t.ok(!s.calls.some((c) => /playerScores|players |liveScoring/.test(c)), s.calls.join(", "));
  t.equal((await decide({}, END + DAY)).season, "2026", "without 2027, completion changes nothing");
});
const TUE_NOON = Date.parse("2027-01-05T17:00:00Z");   // Tue Jan 5, noon ET: 16 h after MNF's kickoff
for (const [label, game, now, want, why] of [
  ["POSTPONED: MNF moved to Wed Jan 6 8:15 PM ET → Tue noon", { kickoff: Date.parse("2027-01-07T01:15:00Z") }, TUE_NOON, "2026", /HOU@GBP:not_started$/],
  ["… and once it's been played and scored (Thu 1 AM ET)", { kickoff: Date.parse("2027-01-07T01:15:00Z") }, Date.parse("2027-01-07T06:00:00Z"), "2027", null],
  ["POSTPONED IN PLACE: old kickoff unchanged, no clock, no points → Tue noon", { noClock: true, points: "none", delay: 30 * DAY }, TUE_NOON, "2026", /HOU@GBP:no_points_HOU_GBP$/],
  ["DELAYED kickoff (2 h): 1½ h after the scheduled kickoff the clock still reads 3600", { delay: 2 * H }, LAST + 1.5 * H, "2026", /HOU@GBP:clock_3600$/],
  ["DELAYED kickoff (2 h): 4¾ h after the scheduled kickoff it's still being played", { delay: 2 * H }, LAST + 4.75 * H, "2026", /HOU@GBP:(a_team_has_the_ball|clock_900)$/],
  ["… then over and scored", { delay: 2 * H }, LAST + 2 * H + GAME + LAG + MIN, "2027", null],
  ["SUSPENDED: clock stuck at 1234 for 3 days (points from the part played)", { suspendAt: 1.5 * H }, LAST + 3 * DAY, "2026", /HOU@GBP:clock_1234$/],
  ["SUSPENDED: … still stuck 6 days later (past the 4-day settled mark)", { suspendAt: 1.5 * H }, LAST + 6 * DAY, "2026", /HOU@GBP:clock_1234$/],
  ["MISSING CLOCK, 4 h after kickoff (both teams' points posted)", { noClock: true }, LAST + 4 * H, "2026", /HOU@GBP:no_clock_under_5h$/],
  ["MISSING CLOCK, 5 h after kickoff, both teams' points → final", { noClock: true }, LAST + 5 * H, "2027", null],
  ["MISSING CLOCK, 6 h, ONE team's points", { noClock: true, points: "one" }, LAST + 6 * H, "2026", /HOU@GBP:no_points_GBP$/],
  ["MISSING CLOCK and NO POINTS, 5 days later (past the 4-day settled mark: only clock-0 weeks settle)", { noClock: true, points: "none" }, LAST + 5 * DAY, "2026", /HOU@GBP:no_points_HOU_GBP$/],
  ["ONE-SIDED POINTS (clock 0)", { points: "one" }, TUE_NOON, "2026", /HOU@GBP:no_points_GBP$/],
  ["MISSING POINTS (clock 0)", { points: "none" }, TUE_NOON, "2026", /HOU@GBP:no_points_HOU_GBP$/],
  ["OVERTIME: 4 h game, clock reads 0 during OT while a team has the ball", { length: 4 * H }, LAST + 3.6 * H, "2026", /HOU@GBP:a_team_has_the_ball$/],
  ["OVERTIME: clock 0 after the regulation window, OT over, both scored → final", { length: 4 * H }, LAST + 4 * H + LAG + MIN, "2027", null],
  ["GLITCH: MNF's clock reads 0 from kickoff (30 min in)", { glitch0: true }, LAST + 0.5 * H, "2026", /HOU@GBP:a_team_has_the_ball$|clock_0_too_soon/],
]) {
  test(`(b/c) ${label} → ${want}`, async () => {
    const r = await decide({ renewed: true, game: { [MNF]: game } }, now);
    t.ok(r.ok && r.season === want, JSON.stringify(r));
    if (why) t.match(r.source, why);
  });
}
test("(b) MFL's live scoring still shows a franchise playing (every clock 0, points posted) → 2026", async () => {
  const r = await decide({ renewed: true, livePlaying: 2 }, END + H);
  t.equal(r.season, "2026"); t.match(r.source, /mfl_live_scoring_1_franchises_still_playing$/);
});
test("(d) unresolvable → { ok: false } with the reason, never a season (and never the calendar's)", async () => {
  const cases = [
    [{ down: [2027] }, Date.parse("2027-01-02T18:00:00Z"), /^league_2027_unreadable:http_500$/],
    [{ down: [2026] }, Date.parse("2026-10-14T16:00:00Z"), /^league_2026_unreadable:http_500$/],
    [{ down: [2026] }, Date.parse("2027-01-02T18:00:00Z"), /^league_2027_absent:http_404\+league_2026_unknown:http_500$/],
    [{ renewed: true, down: [2026] }, Date.parse("2027-01-02T18:00:00Z"), /^league_2026_unknown:http_500$/],
    [{ renewed: true, schedDown: true }, Date.parse("2027-01-02T18:00:00Z"), /^season_2026_completion_unreadable:nflSchedule_2026_w17_unreadable$/],
    [{ renewed: true, schedWeek: 16 }, END, /^season_2026_completion_unreadable:nflSchedule_2026_w17_no_games$/],
    [{ renewed: true, scoresDown: true }, END, /^season_2026_completion_unreadable:mfl_points_or_live_scoring_2026_w17_unreadable$/],
    [{ renewed: true, liveDown: true }, END, /^season_2026_completion_unreadable:mfl_points_or_live_scoring_2026_w17_unreadable$/],
    [{ histLists2027: true }, Date.parse("2027-01-02T18:00:00Z"), /^contradiction:league_2026_history_lists_2027_but_league_2027_http_404$/],
    [{ renewed: true, histLists2027: false }, END, /^contradiction:league_2026_history_does_not_list_2027$/],
  ];
  for (const [o, now, re] of cases) {
    const r = await decide(o, now);
    t.ok(r.ok === false && r.season === null && re.test(r.reason), JSON.stringify(o) + " → " + JSON.stringify(r));
  }
});
test("operator pin (env.YEAR) wins; a completion is remembered only from the moment it was proven", async () => {
  t.equal((await decide({}, Date.parse("2027-01-02T18:00:00Z"), { pinnedYear: "2025" })).season, "2025");
  const memo = new Map();
  await decide({ renewed: true }, END + H, { completeMemo: memo });
  const later = await decide({ renewed: true }, END + 2 * DAY, { completeMemo: memo });
  t.equal(later.season, "2027"); t.ok(!later.calls.some((c) => /nflSchedule 2026/.test(c)), "remembered: " + later.calls.join(", "));
  const earlier = await decide({ renewed: true }, LAST, { completeMemo: memo });
  t.equal(earlier.season, "2026", "an earlier moment isn't answered from a later proof");
});
test("resolveLiveLeagueYear (#1207's rule) is unchanged and still exported: 2027 created early → it alone would say 2027 on Jan 2", async () => {
  const fx = fakeMfl({ renewed: true });
  const r = await LY.resolveLiveLeagueYear({ leagueId: "74598", nowMs: Date.parse("2027-01-02T18:00:00Z"), readLeague: fx.readLeague });
  t.equal(r.season, "2027");
});

await run("season_active_finality");
