// §G3 candidate → commissioner ruling → ONE post in the week's Injury Report
// thread → penalty assessed, then applied only when verified.
//   node tests/lineup_rulings.test.mjs
//
// Keith's rulings of 2026-10-11, pinned:
//   - one violation per franchise-week; several bad starters are its reasons;
//   - the post goes ONLY into that week's existing "Week N Injury Report"
//     thread, resolved from the Saturday post's record and verified; if it is
//     missing or unverifiable, HOLD and alert — never post elsewhere;
//   - the owner is @mentioned (verified) and the post states each starter's
//     status, when it became known against the deadline, that he stayed in
//     the lineup at kickoff, and that he did not play;
//   - a pick penalty takes the franchise's EARLIEST future year holding a pick
//     in that round (no 2027 4th → 2028 4th); several in that year → Keith
//     chooses; unreadable inventory → hold; the pick is reserved at once;
//   - "assessed" until the exact pick/cap action is verified on MFL;
//   - retries and overlapping runs never add an offense, penalty, post or
//     reservation.
//
// Real SQLite (node:sqlite) with the real migrations 0093 → 0129 → 0149 → 0171.
import { makeD1, applyMigrations } from "./fixtures/d1_sqlite.mjs";
import { t, test, run } from "./fixtures/mini_test.mjs";
import * as R from "../worker/src/lineup_rulings.js";

const SEASON = 2026, L = "74598";
const SUN1 = 1791738000, SUN425 = 1791750300, MNF = 1791850500, POLL_FROM = 1791507952;
const INJURY_CH = "1550849538229534760", THREAD5 = "1558450448489259128";
const OWNER = "111111111111111111";
const ELLISS = "14303", WINGARD = "14328", X4 = "940401";

const FIDS = Array.from({ length: 12 }, (_, i) => String(i + 1).padStart(4, "0"));
const NAMES = { "0002": "CBP", "0004": "Pure Greatness", "0007": "Sex Manther", "0008": "Real Deal Creel" };
const filler = (f) => Array.from({ length: 16 }, (_, i) => `9${f}${String(i).padStart(2, "0")}`);
const LINEUPS = Object.fromEntries(FIDS.map((f) => [f, [`8${f}a`, `8${f}b`, ...filler(f)]]));
LINEUPS["0002"] = [ELLISS, WINGARD, ...filler("0002")];
LINEUPS["0004"] = [X4, "80004b", ...filler("0004")];

// ── the world, adjustable per test ──────────────────────────────────────────
function world(over = {}) {
  return {
    lineups: LINEUPS, resultsOk: true, picksOk: true, byesOk: true,
    picks: { "0004": [{ year: "2027", round: "4", originalPickFor: "0004" }], "0002": [{ year: "2027", round: "2", originalPickFor: "0002" }], "0001": [{ year: "2027", round: "4", originalPickFor: "0001" }] },
    adjustments: null,                       // null = the cap season's league is unreadable
    thread: { id: THREAD5, type: 11, name: "Week 5 Injury Report", parent_id: INJURY_CH, thread_metadata: { archived: false, locked: false } },
    threadStatus: 200, postStatus: 200,
    official: [["NO", "Kaden Elliss", "Out"], ["ARI", "Andrew Wingard", "Out"], ["NO", "John Doe", "Out"]], officialOk: true,
    ...over,
  };
}
function install(w) {
  const posts = [], gets = [];
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    const json = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
    const method = (init && init.method) || "GET";
    if (u.startsWith("https://discord.com/api/v10/channels/")) {
      const id = u.split("/channels/")[1].split("/")[0];
      discordCalls.push({ method, url: u });
      if (method === "GET" && u.includes("/messages")) return json(w.threadMessages || []);
      if (method === "GET") { gets.push(id); return w.threadStatus === 200 && id === w.thread.id ? json(w.thread) : json({ message: "Unknown Channel" }, 404); }
      posts.push({ id, body: JSON.parse(init.body) });
      return w.postStatus === 200 ? json({ id: String(990000000000000000n + BigInt(posts.length)) }) : json({ code: 50013 }, w.postStatus);
    }
    if (u.startsWith("https://github.com/nflverse/")) {
      if (!w.officialOk) return { ok: false, status: 503, text: async () => "", headers: { get: () => "" } };
      const csv = "season,season_type,game_type,team,week,gsis_id,position,full_name,first_name,last_name,report_primary_injury,report_secondary_injury,report_status,practice_primary_injury,practice_secondary_injury,practice_status\n"
        + w.official.map(([tm, n, st]) => `2026,REG,REG,${tm},5,00-1,LB,${n},x,y,Calf,,${st},Calf,,"Did Not Participate In Practice"`).join("\n")
        + "\n" + w.official.map(([tm, n, st]) => `2026,REG,REG,${tm},6,00-1,LB,${n},x,y,Calf,,${st},Calf,,DNP`).join("\n") + "\n";
      return { ok: true, status: 200, text: async () => csv, headers: { get: (h) => (h === "last-modified" ? "Sun, 11 Oct 2026 13:56:09 GMT" : "") } };
    }
    const W = new URL(u).searchParams.get("W");
    if (u.includes("TYPE=nflSchedule")) {
      return json({ nflSchedule: { matchup: [["NOS", "MIN", SUN1], ["ARI", "DET", SUN425], ["LAR", "BUF", MNF]].map(([h, a, k]) => ({ kickoff: String(k), team: [{ id: h, isHome: "1" }, { id: a, isHome: "0" }] })) } });
    }
    if (u.includes("TYPE=nflByeWeeks")) return w.byesOk ? json({ nflByeWeeks: { team: [{ id: "PHI" }] } }) : json(null, 500);
    if (u.includes("TYPE=players")) {
      const player = FIDS.flatMap((f) => w.lineups[f].map((id) => ({ id, name: `Last${id}, First`, team: "MIN", position: "LB" })));
      for (const p of player) {
        if (p.id === ELLISS) Object.assign(p, { name: "Elliss, Kaden", team: "NOS" });
        if (p.id === WINGARD) Object.assign(p, { name: "Wingard, Andrew", team: "ARI", position: "S" });
        if (p.id === X4) Object.assign(p, { name: "Doe, John", team: "NOS" });
      }
      return json({ players: { player } });
    }
    if (u.includes("TYPE=rosters")) {
      return json({ rosters: { franchise: FIDS.map((id) => ({ id, player: w.lineups[id].map((pid) => ({ id: pid, status: "ROSTER" })) })) } });
    }
    if (u.includes("TYPE=weeklyResults")) {
      if (!w.resultsOk) return json(null, 500);
      const franchise = FIDS.map((id) => ({ id, starters: w.lineups[id].join(",") + "," }));
      return json({ weeklyResults: { week: W, matchup: [{ franchise: franchise.slice(0, 6) }, { franchise: franchise.slice(6) }] } });
    }
    if (u.includes("TYPE=league")) return json({ league: { franchises: { franchise: FIDS.map((id) => ({ id, name: NAMES[id] || `Team ${id}` })) } } });
    if (u.includes("TYPE=futureDraftPicks")) {
      if (!w.picksOk) return json(null, 500);
      return json({ futureDraftPicks: { franchise: FIDS.map((id) => ({ id, futureDraftPick: w.picks[id] || [{ year: "2027", round: "1", originalPickFor: id }] })) } });
    }
    if (u.includes("TYPE=salaryAdjustments")) {
      return w.adjustments ? json({ salaryAdjustments: { salaryAdjustment: w.adjustments } }) : json(null, 404);
    }
    return json(null, 404);
  };
  return { posts, gets };
}

function env({ channel = INJURY_CH, satLog = THREAD5 } = {}) {
  const d = makeD1({});
  applyMigrations(d, ["0093_ups_bot_heartbeat.sql", "0129_lineup_compliance.sql", "0149_lineup_sat_announce_log.sql", "0171_lineup_rulings.sql"]);
  for (const wk of [5, 6]) {
    d.raw.prepare("INSERT INTO ups_injury_polls (season, week, polled_unix, rows_seen) VALUES (?, ?, ?, 400)").run(SEASON, wk, POLL_FROM);
    for (const [p, st, first] of [[ELLISS, "QUESTIONABLE", 1791507952], [ELLISS, "OUT", 1791579952], [WINGARD, "QUESTIONABLE", 1791507952], [WINGARD, "OUT", 1791569151], [X4, "OUT", 1791569151]]) {
      d.raw.prepare("INSERT INTO ups_injury_status (season, week, player_id, status, first_seen_unix, last_seen_unix) VALUES (?, ?, ?, ?, ?, ?)").run(SEASON, wk, p, st, first, MNF);
    }
  }
  if (satLog) d.raw.prepare("INSERT INTO ups_lineup_sat_announce_log (season, league_id, week, message_id, clean_count, issue_count, posted_unix) VALUES (?, ?, 5, ?, 7, 5, 1791633943)").run(SEASON, L, satLog);
  // Active owner accounts (0009 deliberately has none).
  d.raw.exec("CREATE TABLE IF NOT EXISTS discord_owners (franchise_id TEXT, active_owner TEXT, discord_user_id TEXT)");
  for (const [f, id] of [["0002", OWNER], ["0004", "222222222222222222"], ["0007", "333333333333333333"]]) d.raw.prepare("INSERT INTO discord_owners VALUES (?, 'Y', ?)").run(f, id);
  return { UPS_MFL_DB: d, DISCORD_BOT_TOKEN: "test", DISCORD_LINEUP_ANNOUNCE_CHANNEL_ID: channel, LINEUP_AUTO_PUBLISH_ENABLED: "1" };
}
const CBP_REASONS = JSON.stringify([
  { player_id: ELLISS, name: "Elliss, Kaden", verdict: "violation", reason: "out" },
  { player_id: WINGARD, name: "Wingard, Andrew", verdict: "violation", reason: "out" },
]);
const X4_REASONS = JSON.stringify([{ player_id: X4, name: "Doe, John", verdict: "violation", reason: "out" }]);
const book = (e, fid, week, reasons) => e.UPS_MFL_DB.raw.prepare(
  "INSERT INTO ups_lineup_violations (season, league_id, fid, week, offense_no, reasons_json) VALUES (?, ?, ?, ?, 0, ?)").run(SEASON, L, fid, week, reasons);
const ruling = (e, fid, week) => e.UPS_MFL_DB.raw.prepare("SELECT * FROM ups_lineup_rulings WHERE season=? AND fid=? AND week=?").get(SEASON, fid, week);
const reservations = (e) => e.UPS_MFL_DB.raw.prepare("SELECT * FROM ups_lineup_pick_reservations ORDER BY week").all();
// Spy: the ONLY code allowed to look up a real mention is the final send.
const discordCalls = [];
let mentionLookups = 0;
const mentions = async (_env, fids) => { mentionLookups += 1; return new Map(fids.filter((f) => f !== "0009").map((f) => [f, f === "0002" ? [OWNER] : ["222222222222222222"]])); };
const alerts = [];
const alertImpl = async (_env, text) => { alerts.push(text); return { sent: 1 }; };
const rule = (e, fid, week, extra) => R.recordLineupRuling(e, { season: SEASON, leagueId: L, fid, week, ruling: "confirmed", by: "0008", ...(extra || {}) });
const post = (e, fid, week) => R.postLineupNotice(e, { season: SEASON, leagueId: L, fid, week, resolveMentions: mentions, alertImpl });
const preview = (e, fid, week) => R.previewLineupNotice(e, { season: SEASON, leagueId: L, fid, week, resolveMentions: mentions });

// Keith's 2026-10-11 copy, verbatim (the owner mention is the only variable).
const CBP_EXPECTED = [
  "🚨 Lineup Violation — Week 5",
  "",
  `CBP <@${OWNER}> — 1st violation of the 2026 season`,
  "",
  "Why it occurred",
  "",
  "• Kaden Elliss (NO) was first recorded OUT on Fri Oct 9 at 5:05 PM ET—before CBP’s Sat Oct 10, 1:00 PM notice deadline. He remained in the starting lineup at the Sun Oct 11, 1:00 PM kickoff and did not play.",
  "",
  "• Andrew Wingard (ARI) was first recorded OUT on Fri Oct 9 at 2:05 PM ET—before CBP’s Sat Oct 10, 4:25 PM notice deadline. He remained in the starting lineup at the Sun Oct 11, 4:25 PM kickoff and did not play.",
  "",
  "Multiple ineligible starters in the same weekly lineup count as one lineup violation.",
  "",
  "Penalty assessed: Warning only. No draft pick or cap charge applies to a first violation.",
  "",
  "If there is another violation this season: CBP will forfeit its earliest owned future fourth-round pick and receive a $5,000 charge against the following season’s salary cap. Because CBP does not own a 2027 fourth-round pick, its own 2028 fourth-round pick is currently the applicable pick.",
].join("\n");

// Keith's preview copy (2026-10-11): identical, minus the mention.
const CBP_PLAIN = CBP_EXPECTED.replace(` <@${OWNER}>`, "");

// ── CBP Week 5 ──────────────────────────────────────────────────────────────
test("CBP Week 5: one offense (#1), exact evidence timestamps, the exact post, in the Week 5 thread", async () => {
  const e = env(); const net = install(world()); alerts.length = 0;
  book(e, "0002", 5, CBP_REASONS);
  const r = await rule(e, "0002", 5);
  t.equal(r.ok, true); t.equal(r.status, "ready"); t.equal(r.offense_no, 1);
  const row = ruling(e, "0002", 5);
  t.equal(row.sanction_status, "none", "a warning has nothing to apply");
  const ev = JSON.parse(row.evidence_json);
  t.deepEqual(ev.map((x) => [x.name, x.nfl_team, x.status_at_deadline, x.status_first_seen_unix, x.notice_deadline_unix, x.kickoff_unix, x.status_at_kickoff, x.in_final_lineup, x.played]), [
    ["Elliss, Kaden", "NOS", "OUT", 1791579952, SUN1 - 86400, SUN1, "OUT", true, false],
    ["Wingard, Andrew", "ARI", "OUT", 1791569151, SUN425 - 86400, SUN425, "OUT", true, false],
  ]);
  t.equal(ev[0].status_first_seen_et, "Fri, Oct 9, 5:05 PM ET");
  t.equal(ev[0].notice_deadline_et, "Sat, Oct 10, 1:00 PM ET");
  t.equal(ev[1].status_first_seen_et, "Fri, Oct 9, 2:05 PM ET");
  t.equal(ev[0].deadline_rule, "kickoff − 24 hours");
  t.equal(net.posts.length, 0, "ruling never posts");

  const lookupsBefore = mentionLookups;
  const pv = await preview(e, "0002", 5);
  t.equal(pv.ok, true); t.equal(pv.text, CBP_PLAIN, "preview shows the plain copy, no mention");
  t.equal(JSON.stringify(pv).includes("<@"), false, "no rendered mention anywhere in the preview");
  t.equal(mentionLookups, lookupsBefore, "preview never looks up the owner's id");
  t.equal(pv.owner_account_active, true);
  t.equal(pv.destination.thread_id, THREAD5); t.equal(pv.destination.name, "Week 5 Injury Report"); t.equal(pv.destination.parent_id, INJURY_CH);
  t.equal(net.posts.length, 0, "preview never posts");

  const p = await post(e, "0002", 5);
  t.equal(p.ok, true);
  t.equal(net.posts.length, 1); t.equal(net.posts[0].id, THREAD5, "into the Week 5 thread, nowhere else");
  t.equal(net.posts[0].body.content, CBP_EXPECTED);
  t.deepEqual(net.posts[0].body.allowed_mentions, { users: [OWNER] }, "pings only the owner");
  t.equal(mentionLookups, lookupsBefore + 1, "the mention is looked up exactly once — at the live send");
  t.equal(ruling(e, "0002", 5).status, "posted");
  t.equal(e.UPS_MFL_DB.raw.prepare("SELECT COUNT(*) n FROM ups_lineup_rulings").get().n, 1, "one ruling = one offense");
  t.equal(alerts.length, 0);
});

// ── destination failures: hold + alert, never another channel ──────────────
test("missing Injury Report thread → held, Keith alerted once, nothing posted", async () => {
  const e = env({ satLog: null }); const net = install(world()); alerts.length = 0;
  book(e, "0002", 5, CBP_REASONS);
  await rule(e, "0002", 5);
  const p = await post(e, "0002", 5);
  t.equal(p.held, true); t.equal(p.reason, "injury_thread_missing"); t.equal(p.alerted, true);
  t.equal(net.posts.length, 0, "no fallback post anywhere");
  t.match(alerts[0], /HELD for your review — Week 5, CBP: injury_thread_missing/);
  await post(e, "0002", 5);
  t.equal(alerts.length, 1, "same reason is alerted once"); t.equal(net.posts.length, 0);
  t.equal(ruling(e, "0002", 5).status, "held");
});

test("unverifiable thread → held: placeholder record, 404, wrong name, wrong parent, locked", async () => {
  const cases = [
    [{ satLog: "BLOCKED-pending-keith-review" }, {}, "injury_thread_missing"],
    [{}, { threadStatus: 404 }, "injury_thread_unreadable"],
    [{}, { thread: { ...world().thread, name: "Week 4 Injury Report" } }, "injury_thread_unverified"],
    [{}, { thread: { ...world().thread, parent_id: "1087157907419840644" } }, "injury_thread_unverified"],
    [{}, { thread: { ...world().thread, thread_metadata: { archived: true, locked: true } } }, "injury_thread_unverified"],
  ];
  for (const [envOpts, w, reason] of cases) {
    const e = env(envOpts); const net = install(world(w)); alerts.length = 0;
    book(e, "0002", 5, CBP_REASONS);
    await rule(e, "0002", 5);
    const p = await post(e, "0002", 5);
    t.equal(p.reason, reason); t.equal(net.posts.length, 0);
  }
});

test("Coffee Shop configured as the Injury Report channel → held, never posts", async () => {
  const e = env({ channel: R.COFFEE_SHOP_CHANNEL_ID }); const net = install(world());
  book(e, "0002", 5, CBP_REASONS);
  await rule(e, "0002", 5);
  t.equal((await post(e, "0002", 5)).reason, "coffee_shop_blocked"); t.equal(net.posts.length, 0);
});

test("no active owner account → held before any mention lookup", async () => {
  const e = env(); alerts.length = 0;
  book(e, "0009", 5, CBP_REASONS);
  const w = world(); w.lineups = { ...LINEUPS, "0009": [ELLISS, WINGARD, ...filler("0009")] };
  const net = install(w);
  await rule(e, "0009", 5);
  const p = await post(e, "0009", 5);
  t.equal(p.reason, "owner_account_missing"); t.equal(net.posts.length, 0);
});

test("a re-post after a hold is fixed goes out once; a failed send keeps the claim", async () => {
  const e = env({ satLog: null }); let net = install(world()); alerts.length = 0;
  book(e, "0002", 5, CBP_REASONS);
  await rule(e, "0002", 5);
  t.equal((await post(e, "0002", 5)).held, true);
  e.UPS_MFL_DB.raw.prepare("INSERT INTO ups_lineup_sat_announce_log (season, league_id, week, message_id, posted_unix) VALUES (?, ?, 5, ?, 1)").run(SEASON, L, THREAD5);
  t.equal((await post(e, "0002", 5)).ok, true); t.equal(net.posts.length, 1);

  const e2 = env(); net = install(world({ postStatus: 403 })); alerts.length = 0;
  book(e2, "0002", 5, CBP_REASONS);
  await rule(e2, "0002", 5);
  const f = await post(e2, "0002", 5);
  t.equal(f.reason, "post_failed"); t.equal(f.claimed, true); t.equal(alerts.length, 1);
  install(world());
  t.equal((await post(e2, "0002", 5)).error, "already_claimed", "never auto re-sent: a person checks the thread first");
});

// ── evidence ────────────────────────────────────────────────────────────────
test("evidence must still hold: a starter no longer in the final lineup, or unreadable results → held ruling", async () => {
  const e = env(); install(world({ lineups: { ...LINEUPS, "0002": [ELLISS, ...filler("0002"), "70000x"] } }));
  book(e, "0002", 5, CBP_REASONS);
  const r = await rule(e, "0002", 5);
  t.equal(r.held, true); t.equal(r.reason, "lineup_changed");
  t.equal(ruling(e, "0002", 5).status, "held");
  const e2 = env(); install(world({ resultsOk: false }));
  book(e2, "0002", 5, CBP_REASONS);
  t.equal((await rule(e2, "0002", 5)).reason, "lineup_unreadable");
  t.equal((await preview(e2, "0002", 5)).error, "notice_missing", "nothing to publish while the ruling is held");
});

// ── the pick ladder ─────────────────────────────────────────────────────────
async function secondOffense(w) {
  const e = env(); install(world(w));
  book(e, "0004", 5, X4_REASONS); book(e, "0004", 6, X4_REASONS);
  const first = await rule(e, "0004", 5);
  t.equal(first.offense_no, 1);
  return e;
}

test("2nd offense with a 2027 4th owned → that pick, reserved; post says ASSESSED", async () => {
  const e = await secondOffense({});
  const r = await rule(e, "0004", 6);
  t.equal(r.offense_no, 2); t.equal(r.status, "ready");
  t.deepEqual(r.penalty.pick, { year: 2027, round: 4, original_owner: "0004", basis: "mfl_future_picks" });
  t.equal(reservations(e).length, 1);
  t.match(r.notice_text, /Penalty assessed: Forfeiture of Pure Greatness’s own 2027 fourth-round pick and a \$5,000 charge against the 2027 salary cap\. Status: assessed — not yet applied on MFL\./);
  t.match(r.notice_text, /2nd violation of the 2026 season/);
  t.match(r.notice_text, /If there is another violation this season: Pure Greatness will forfeit its earliest owned future second-round pick and receive a further \$5,000 charge against the following season’s salary cap\. Because Pure Greatness does not own a 2027 second-round pick, its own 2028 second-round pick is currently the applicable pick\./);
  t.equal(ruling(e, "0004", 6).sanction_status, "assessed");
});

test("no 2027 4th → its 2028 4th (MFL lists 2028)", async () => {
  const e = await secondOffense({ picks: { "0004": [{ year: "2027", round: "3", originalPickFor: "0004" }, { year: "2028", round: "4", originalPickFor: "0004" }], "0001": [{ year: "2028", round: "1", originalPickFor: "0001" }] } });
  const r = await rule(e, "0004", 6);
  t.deepEqual(r.penalty.pick, { year: 2028, round: 4, original_owner: "0004", basis: "mfl_future_picks" });
});

test("no 2027 4th and MFL lists only 2027 → own 2028 4th, beyond the trade horizon (canon A6)", async () => {
  const e = await secondOffense({ picks: { "0004": [{ year: "2027", round: "3", originalPickFor: "0004" }] } });
  const r = await rule(e, "0004", 6);
  t.deepEqual(r.penalty.pick, { year: 2028, round: 4, original_owner: "0004", basis: "beyond_trade_horizon" });
  t.match(r.notice_text, /Forfeiture of Pure Greatness’s own 2028 fourth-round pick/);
});

test("two qualifying picks in the earliest year → Keith chooses; nothing reserved until he does", async () => {
  const two = [{ year: "2027", round: "4", originalPickFor: "0004" }, { year: "2027", round: "4", originalPickFor: "0007" }];
  const e = await secondOffense({ picks: { "0004": two } });
  const r = await rule(e, "0004", 6);
  t.equal(r.status, "needs_pick_selection");
  t.deepEqual(r.options.map((o) => o.key), ["2027-4-0004", "2027-4-0007"]);
  t.equal(reservations(e).length, 0); t.equal(ruling(e, "0004", 6).status, "needs_pick_selection");
  t.equal((await preview(e, "0004", 6)).error, "status_needs_pick_selection", "cannot publish before the choice");
  const bad = await rule(e, "0004", 6, { pickChoice: "2027-4-0011" });
  t.equal(bad.status, "needs_pick_selection"); t.equal(bad.bad_choice, "2027-4-0011");
  const ok = await rule(e, "0004", 6, { pickChoice: "2027-4-0007" });
  t.equal(ok.status, "ready");
  t.deepEqual(ok.penalty.pick, { year: 2027, round: 4, original_owner: "0007", basis: "mfl_future_picks" });
  t.match(ok.notice_text, /Forfeiture of Pure Greatness’s 2027 fourth-round pick acquired from Sex Manther/);
});

test("pick inventory unreadable → ruling held, no reservation, no post", async () => {
  const e = await secondOffense({});
  install(world({ picksOk: false }));
  const r = await rule(e, "0004", 6);
  t.equal(r.held, true); t.equal(r.reason, "pick_inventory_unreadable");
  t.equal(reservations(e).length, 0);
});

test("ownership rechecked at publication: a reserved pick traded away since → held + alert", async () => {
  const e = await secondOffense({});
  await rule(e, "0004", 6);
  await post(e, "0004", 5);
  e.UPS_MFL_DB.raw.prepare("INSERT INTO ups_lineup_sat_announce_log (season, league_id, week, message_id, posted_unix) VALUES (?, ?, 6, ?, 1)").run(SEASON, L, "1559999999999999999");
  const net = install(world({ picks: { "0004": [] }, thread: { ...world().thread, id: "1559999999999999999", name: "Week 6 Injury Report" } })); alerts.length = 0;
  const p = await post(e, "0004", 6);
  t.equal(p.reason, "reserved_pick_no_longer_owned"); t.equal(net.posts.length, 0); t.equal(alerts.length, 1);
});

// ── idempotency ─────────────────────────────────────────────────────────────
test("overlapping rulings: one ruling, one reservation; overlapping posts: one Discord message", async () => {
  const e = await secondOffense({});
  const [a, b] = await Promise.all([rule(e, "0004", 6), rule(e, "0004", 6)]);
  t.ok(a.ok && b.ok);
  t.equal(reservations(e).length, 1, "one reservation");
  t.equal(e.UPS_MFL_DB.raw.prepare("SELECT COUNT(*) n FROM ups_lineup_rulings WHERE fid='0004' AND week=6").get().n, 1);
  t.equal(e.UPS_MFL_DB.raw.prepare("SELECT COUNT(*) n FROM ups_lineup_violations WHERE fid='0004' AND voided=0").get().n, 2, "no new offense rows");

  const e2 = env(); const net = install(world());
  book(e2, "0002", 5, CBP_REASONS);
  await rule(e2, "0002", 5);
  const [p1, p2] = await Promise.all([post(e2, "0002", 5), post(e2, "0002", 5)]);
  t.equal([p1.ok, p2.ok].filter(Boolean).length, 1);
  t.equal(net.posts.length, 1, "exactly one Discord message");
  t.equal((await post(e2, "0002", 5)).error, "already_claimed");
  t.equal((await rule(e2, "0002", 5)).unchanged, true, "re-ruling after posting changes nothing");
});

test("a pick already reserved by another ruling is never taken twice", async () => {
  const e = await secondOffense({ picks: { "0004": [{ year: "2027", round: "4", originalPickFor: "0004" }, { year: "2028", round: "4", originalPickFor: "0004" }] } });
  e.UPS_MFL_DB.raw.prepare(`INSERT INTO ups_lineup_pick_reservations (season, league_id, holder_fid, week, pick_year, pick_round, original_owner, ownership_basis, reserved_at_utc)
    VALUES (2026, ?, '0004', 3, 2027, 4, '0004', 'mfl_future_picks', 'x')`).run(L);
  const r = await rule(e, "0004", 6);
  t.deepEqual(r.penalty.pick, { year: 2028, round: 4, original_owner: "0004", basis: "mfl_future_picks" }, "skips the reserved 2027 4th");
});

// ── assessed vs applied ─────────────────────────────────────────────────────
test("applied only when MFL shows BOTH the pick gone and the cap charge", async () => {
  const e = await secondOffense({});
  const r = await rule(e, "0004", 6);
  const v = (w) => { install(world(w)); return R.verifyLineupSanction(e, { season: SEASON, leagueId: L, fid: "0004", week: 6 }); };
  let x = await v({});
  t.equal(x.sanction_status, "assessed"); t.equal(x.detail.pick.reason, "pick_still_owned");
  x = await v({ picks: { "0004": [] } });
  t.equal(x.sanction_status, "assessed", "pick gone but 2027 cap league unreadable"); t.equal(x.detail.pick.verified, true);
  x = await v({ picks: { "0004": [] }, adjustments: [{ id: "77", franchise_id: "0004", amount: "5000", description: "wrong text" }] });
  t.equal(x.sanction_status, "assessed", "adjustment must carry the ruling's description");
  x = await v({ picks: { "0004": [] }, adjustments: [{ id: "78", franchise_id: "0004", amount: "5000", description: r.penalty.cap_description }] });
  t.equal(x.sanction_status, "applied");
  t.equal(ruling(e, "0004", 6).sanction_status, "applied");
  const w1 = await R.verifyLineupSanction(e, { season: SEASON, leagueId: L, fid: "0004", week: 5 });
  t.equal(w1.sanction_status, "none", "a warning is never 'applied'");
});

// ── excuse, ordering, never MFL ─────────────────────────────────────────────
test("excuse voids the candidate, releases its pick, closes the ruling; refused once posted", async () => {
  const e = await secondOffense({});
  await rule(e, "0004", 6);
  const x = await R.recordLineupRuling(e, { season: SEASON, leagueId: L, fid: "0004", week: 6, ruling: "excused", note: "family emergency", by: "0008" });
  t.equal(x.status, "closed");
  t.equal(e.UPS_MFL_DB.raw.prepare("SELECT voided FROM ups_lineup_violations WHERE fid='0004' AND week=6").get().voided, 1);
  t.ok(reservations(e)[0].released_at_utc, "pick released");
  const e2 = env(); install(world());
  book(e2, "0002", 5, CBP_REASONS);
  await rule(e2, "0002", 5); await post(e2, "0002", 5);
  t.equal((await R.recordLineupRuling(e2, { season: SEASON, leagueId: L, fid: "0002", week: 5, ruling: "excused", by: "0008" })).error, "already_published");
});

test("an unruled earlier candidate blocks numbering a later week", async () => {
  const e = env(); install(world());
  book(e, "0004", 5, X4_REASONS); book(e, "0004", 6, X4_REASONS);
  const r = await rule(e, "0004", 6);
  t.equal(r.error, "earlier_candidates_unruled"); t.deepEqual(r.weeks, [5]);
});

test("the module never writes MFL", async () => {
  const src = (await import("node:fs")).readFileSync(new URL("../worker/src/lineup_rulings.js", import.meta.url), "utf8")
    .split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
  t.doesNotMatch(src, /\/import\?|import\?TYPE|TYPE=salaryAdj(?!ustments)|method:\s*"POST"[^\n]*myfantasyleague/i);
});

// ── official report corroboration ──────────────────────────────────────────
test("official NFL report must agree: Questionable → conflict, absent → unmatched, unreadable → transient hold", async () => {
  const cases = [
    [{ official: [["NO", "Kaden Elliss", "Questionable"], ["ARI", "Andrew Wingard", "Out"]] }, "official_report_conflict"],
    [{ official: [["ARI", "Andrew Wingard", "Out"]] }, "official_report_unmatched"],
    [{ officialOk: false }, "official_report_unreadable"],
  ];
  for (const [w, reason] of cases) {
    const e = env(); install(world(w));
    book(e, "0002", 5, CBP_REASONS);
    const r = await rule(e, "0002", 5);
    t.equal(r.held, true); t.equal(r.reason, reason);
  }
  t.ok(R.TRANSIENT_HOLDS.has("official_report_unreadable")); t.equal(R.TRANSIENT_HOLDS.has("official_report_conflict"), false);
});

test("evidence record carries the official report status and source", async () => {
  const e = env(); install(world());
  book(e, "0002", 5, CBP_REASONS);
  const r = await rule(e, "0002", 5);
  t.deepEqual(r.evidence.map((x) => [x.official_report_status, x.official_source]), [["Out", "nflverse injuries_2026.csv"], ["Out", "nflverse injuries_2026.csv"]]);
});

// ── the standing rule: automatic ruling + post ─────────────────────────────
const auto = (e, nowUnix, week = 5) => R.runLineupAutoPublish(e, { season: SEASON, leagueId: L, week, nowUnix, resolveMentions: mentions, alertImpl });

test("AUTOMATIC: after the final kickoff CBP is ruled #1 and posted once in the Week 5 thread; reruns never repost", async () => {
  const e = env(); const net = install(world()); alerts.length = 0;
  book(e, "0002", 5, CBP_REASONS);
  t.equal((await auto(e, MNF - 1)).skipped, "week_not_final", "nothing before the final kickoff");
  t.equal(net.posts.length, 0);
  const a = await auto(e, MNF + 120);
  t.deepEqual(a.results.map((x) => [x.fid, x.status]), [["0002", "posted"]]);
  t.equal(net.posts.length, 1); t.equal(net.posts[0].id, THREAD5); t.equal(net.posts[0].body.content, CBP_EXPECTED);
  const row = ruling(e, "0002", 5);
  t.equal(row.ruled_by, R.AUTO_RULER); t.equal(row.status, "posted"); t.equal(row.offense_no, 1); t.equal(row.notice_thread_id, THREAD5); t.ok(row.notice_message_id);
  // the */5 tick, the hourly run, and a later retry — overlapping and after
  await Promise.all([auto(e, MNF + 300), auto(e, MNF + 300)]);
  await auto(e, MNF + 3600);
  t.equal(net.posts.length, 1, "exactly one post, ever");
  t.equal(e.UPS_MFL_DB.raw.prepare("SELECT COUNT(*) n FROM ups_lineup_rulings WHERE fid='0002'").get().n, 1);
  t.equal(e.UPS_MFL_DB.raw.prepare("SELECT COUNT(*) n FROM ups_lineup_violations WHERE fid='0002' AND week=5").get().n, 1, "one weekly offense, not two player offenses");
  t.equal(alerts.length, 0, "an obvious case never pings Keith");
});

test("AUTOMATIC stops for review: needs_review, conflicting evidence, missing thread, missing mention, several picks — one alert each, no post", async () => {
  // needs_review
  let e = env(); let net = install(world()); alerts.length = 0;
  book(e, "0002", 5, CBP_REASONS);
  e.UPS_MFL_DB.raw.prepare("UPDATE ups_lineup_violations SET needs_review=1, review_note='Out then played' WHERE fid='0002'").run();
  await auto(e, MNF + 60); await auto(e, MNF + 3600);
  t.equal(net.posts.length, 0); t.equal(alerts.length, 1); t.match(alerts[0], /needs_review/);
  t.equal(ruling(e, "0002", 5), undefined, "not ruled");
  // conflicting official report
  e = env(); net = install(world({ official: [["NO", "Kaden Elliss", "Questionable"], ["ARI", "Andrew Wingard", "Out"]] })); alerts.length = 0;
  book(e, "0002", 5, CBP_REASONS);
  await auto(e, MNF + 60); await auto(e, MNF + 3600);
  t.equal(net.posts.length, 0); t.equal(alerts.length, 1); t.match(alerts[0], /official_report_conflict/);
  // missing thread
  e = env({ satLog: null }); net = install(world()); alerts.length = 0;
  book(e, "0002", 5, CBP_REASONS);
  await auto(e, MNF + 60); await auto(e, MNF + 3600);
  t.equal(net.posts.length, 0); t.equal(alerts.length, 1); t.match(alerts[0], /injury_thread_missing/);
  t.equal(ruling(e, "0002", 5).status, "held");
  // missing mention
  e = env(); const w = world(); w.lineups = { ...LINEUPS, "0009": [ELLISS, WINGARD, ...filler("0009")] }; net = install(w); alerts.length = 0;
  book(e, "0009", 5, CBP_REASONS);
  await auto(e, MNF + 60);
  t.equal(net.posts.length, 0); t.match(alerts[0], /owner_account_missing/);
  // several qualifying picks on a 2nd offense
  e = env(); net = install(world({ picks: { "0004": [{ year: "2027", round: "4", originalPickFor: "0004" }, { year: "2027", round: "4", originalPickFor: "0007" }] } })); alerts.length = 0;
  book(e, "0004", 5, X4_REASONS); book(e, "0004", 6, X4_REASONS);
  t.equal((await rule(e, "0004", 5)).offense_no, 1);
  await auto(e, MNF + 60, 6); await auto(e, MNF + 3600, 6);
  t.equal(ruling(e, "0004", 6).status, "needs_pick_selection");
  t.equal(alerts.filter((x) => /needs_pick_selection/.test(x)).length, 1, "asked once");
  t.equal(net.posts.length, 0, "nothing posted for the week needing a choice");
});

test("AUTOMATIC: a transient read failure retries quietly, then posts once it clears", async () => {
  const e = env(); let net = install(world({ officialOk: false })); alerts.length = 0;
  book(e, "0002", 5, CBP_REASONS);
  await auto(e, MNF + 60);
  t.equal(ruling(e, "0002", 5).status, "held"); t.equal(alerts.length, 0, "no alert inside the 30-minute grace");
  net = install(world());
  await auto(e, MNF + 600);
  t.equal(ruling(e, "0002", 5).status, "posted"); t.equal(net.posts.length, 1);
});

test("AUTOMATIC kill switch: flag off → nothing ruled or posted", async () => {
  const e = env(); e.LINEUP_AUTO_PUBLISH_ENABLED = "0"; const net = install(world());
  book(e, "0002", 5, CBP_REASONS);
  t.equal((await auto(e, MNF + 60)).skipped, "auto_publish_disabled");
  t.equal(net.posts.length, 0); t.equal(ruling(e, "0002", 5), undefined);
});

test("mass-booking breaker alerts Keith once per week", async () => {
  const e = env(); install(world()); alerts.length = 0;
  await R.alertMassBooking(e, { season: SEASON, leagueId: L, week: 5, candidates: 7, alertImpl });
  await R.alertMassBooking(e, { season: SEASON, leagueId: L, week: 5, candidates: 7, alertImpl });
  t.equal(alerts.length, 1); t.match(alerts[0], /REFUSED for Week 5: 7 teams/);
});

// ── previews and dry runs can never notify anyone ───────────────────────────
const ONLY_CBP = { ...LINEUPS, "0004": ["80004a", "80004b", ...filler("0004")] };   // nobody else starts a hurt player
const snapshot = (e) => ["ups_lineup_violations", "ups_lineup_rulings", "ups_lineup_alerts", "ups_lineup_pick_reservations", "ups_bot_heartbeat"]
  .map((tb) => e.UPS_MFL_DB.raw.prepare(`SELECT COUNT(*) n FROM ${tb}`).get().n).join(",");

test("DRY RUN of the standing rule (CBP Week 5): would POST, exact plain copy, and provably sends/writes/mentions nothing", async () => {
  const e = env(); const net = install(world({ lineups: ONLY_CBP })); discordCalls.length = 0; alerts.length = 0;
  const lookups = mentionLookups;
  const before = snapshot(e);
  const d = await R.previewStandingRule(e, { season: SEASON, leagueId: L, week: 5, nowUnix: SUN425 + 7200 });
  t.equal(d.ok, true); t.equal(d.evaluated_as_if_final, true);
  t.deepEqual(d.booking.would_book, ["0002"]);
  t.equal(d.results.length, 1, "Elliss + Wingard = ONE franchise-week");
  const c = d.results[0];
  t.equal(c.would, "post"); t.deepEqual(c.holds, []);
  t.equal(c.offense_no, 1); t.equal(c.starters_behind_it, 2); t.equal(c.weekly_offenses_recorded, 1);
  t.equal(c.notice_text, CBP_PLAIN, "the approved preview copy, word for word");
  t.equal(d.thread.ok, true); t.equal(d.thread.thread_id, THREAD5); t.equal(d.thread_audit.violation_posts, 0);
  // the proof
  t.equal(JSON.stringify(d).includes("<@"), false, "no rendered mention anywhere");
  t.equal(JSON.stringify(d).includes(OWNER), false, "the owner's id never appears");
  t.equal(mentionLookups, lookups, "no mention lookup");
  t.equal(net.posts.length, 0, "no Discord message sent");
  t.deepEqual([...new Set(discordCalls.map((x) => x.method))], ["GET"], "Discord was only read");
  t.equal(snapshot(e), before, "no D1 row written (violations, rulings, alerts, reservations, heartbeat)");
  t.equal(alerts.length, 0, "nobody DMed");
});

test("DRY RUN reports HOLD (with the reason) instead of posting when a check fails", async () => {
  let e = env({ satLog: null }); let net = install(world({ lineups: ONLY_CBP }));
  let d = await R.previewStandingRule(e, { season: SEASON, leagueId: L, week: 5, nowUnix: MNF + 60 });
  t.equal(d.results[0].would, "hold"); t.deepEqual(d.results[0].holds, ["injury_thread_missing"]); t.equal(net.posts.length, 0);
  e = env(); net = install(world({ lineups: ONLY_CBP, official: [["NO", "Kaden Elliss", "Questionable"], ["ARI", "Andrew Wingard", "Out"]] }));
  d = await R.previewStandingRule(e, { season: SEASON, leagueId: L, week: 5, nowUnix: MNF + 60 });
  t.deepEqual(d.results[0].holds, ["official_report_conflict"]); t.equal(net.posts.length, 0);
  e = env(); e.UPS_MFL_DB.raw.exec("DELETE FROM discord_owners WHERE franchise_id='0002'"); net = install(world({ lineups: ONLY_CBP }));
  d = await R.previewStandingRule(e, { season: SEASON, leagueId: L, week: 5, nowUnix: MNF + 60 });
  t.deepEqual(d.results[0].holds, ["owner_account_missing"]); t.equal(net.posts.length, 0);
});

test("a ruling's notice preview never looks up or renders the owner mention", async () => {
  const e = env(); const net = install(world());
  book(e, "0002", 5, CBP_REASONS);
  await rule(e, "0002", 5);
  const lookups = mentionLookups;
  const pv = await preview(e, "0002", 5);
  t.equal(pv.text, CBP_PLAIN); t.equal(JSON.stringify(pv).includes(OWNER), false);
  t.equal(mentionLookups, lookups); t.equal(net.posts.length, 0);
  t.equal(ruling(e, "0002", 5).notice_text.includes(OWNER), false, "the stored text holds a placeholder, never the id");
});

test("booking that can't read a lineup, or finds none, alerts Keith once (never a silent skip)", async () => {
  const e = env(); install(world()); alerts.length = 0;
  const skipped = [{ fid: "0003", reason: "unknown" }, { fid: "0005", reason: "no_record" }, { fid: "0006", reason: "already_booked" }];
  await R.alertBookingSkips(e, { season: SEASON, leagueId: L, week: 5, skipped, alertImpl });
  await R.alertBookingSkips(e, { season: SEASON, leagueId: L, week: 5, skipped, alertImpl });
  t.equal(alerts.length, 2);
  t.match(alerts.join("|"), /Team 0003's locked lineup couldn't be read/); t.match(alerts.join("|"), /no lineup was recorded for Team 0005/);
});

await run("lineup_rulings");
