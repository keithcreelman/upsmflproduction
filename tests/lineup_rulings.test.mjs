// §G3 candidate → commissioner ruling → final notice → manual sanction.
//   node tests/lineup_rulings.test.mjs
//
// Real SQLite (node:sqlite) with the real migrations 0129 → 0149 → 0171.
// Pins the separation the 2026 weeks 1-4 false bookings made necessary: a
// booked row is only a candidate; nothing posts or prices off it until the
// commissioner rules; an unruled earlier week blocks numbering a later one;
// the notice posts exactly once; and no code path writes MFL.
import { makeD1, applyMigrations } from "./fixtures/d1_sqlite.mjs";
import { t, test, run } from "./fixtures/mini_test.mjs";
import * as R from "../worker/src/lineup_rulings.js";

const SEASON = 2026, L = "74598";
const OUT2 = JSON.stringify([
  { player_id: "14303", name: "Elliss, Kaden", verdict: "violation", reason: "out", detail: "x" },
  { player_id: "14328", name: "Wingard, Andrew", verdict: "violation", reason: "out", detail: "y" },
]);

function env({ channel = "1550849538229534760" } = {}) {
  const d = makeD1({});
  applyMigrations(d, ["0129_lineup_compliance.sql", "0149_lineup_sat_announce_log.sql", "0171_lineup_rulings.sql"]);
  return { UPS_MFL_DB: d, DISCORD_BOT_TOKEN: "test-token", DISCORD_LINEUP_ANNOUNCE_CHANNEL_ID: channel };
}
const book = (e, fid, week, reasons = OUT2, voided = 0) =>
  e.UPS_MFL_DB.raw.prepare(`INSERT INTO ups_lineup_violations (season, league_id, fid, week, offense_no, reasons_json, voided) VALUES (?, ?, ?, ?, 0, ?, ?)`)
    .run(SEASON, L, fid, week, reasons, voided);
const ruling = (e, fid, week) => e.UPS_MFL_DB.raw.prepare(`SELECT * FROM ups_lineup_rulings WHERE season=? AND league_id=? AND fid=? AND week=?`).get(SEASON, L, fid, week);

// Discord stand-in: records every POST, answers with an id.
function discord({ failTarget } = {}) {
  const posts = [];
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    posts.push({ url: u, body: init && init.body ? JSON.parse(init.body) : null });
    if (failTarget && u.includes(`/channels/${failTarget}/`)) return { ok: false, status: 403, json: async () => ({ code: 50001 }) };
    return { ok: true, status: 200, json: async () => ({ id: String(900000000000000000n + BigInt(posts.length)) }) };
  };
  return posts;
}
const dmOk = async () => ({ sent: 1, undeliverable: false });
const mentions = async () => new Map([["0002", ["111111111111111111"]]]);

test("notice text: owner terms, grouped players, warning at #1, next rung named", () => {
  const n = R.composeFinalNotices({ teamName: "CBP", week: 5, season: SEASON, offenseNo: 1, violations: JSON.parse(OUT2) });
  t.match(n.owner, /Kaden Elliss and Andrew Wingard were listed OUT before the notice deadline and did not play\./);
  t.match(n.owner, /1st this season: warning, no penalty/);
  t.match(n.owner, /2nd violation this season means loss of a 4th-round pick \+ \$5K against the 2027 cap/);
  t.match(n.league, /\*\*CBP\*\*\{\{MENTION\}\}: \*\*1st violation \(warning, no penalty\)\.\*\*/);
  t.doesNotMatch(n.owner + n.league, /inside your 24-hour mark/, "never the contradictory 'inside' wording");
});

test("sanction plan follows the ladder and is always MANUAL", () => {
  t.equal(R.sanctionPlan(1, SEASON).status, "none");
  const p2 = R.sanctionPlan(2, SEASON);
  t.equal(p2.pick_round, "4th"); t.equal(p2.cap_k, 5); t.equal(p2.cap_season, 2027); t.equal(p2.status, "pending_manual");
  t.equal(R.sanctionPlan(3, SEASON).pick_round, "2nd");
  t.equal(R.sanctionPlan(4, SEASON).membership, "retention");
  t.equal(R.sanctionPlan(5, SEASON).membership, "expulsion");
  t.equal(R.sanctionPlan(9, SEASON).membership, "expulsion", "clamped, no invented 6th rung");
});

test("confirm: records the ruling, offense #, notice text and plan; no Discord call", async () => {
  const e = env(); const posts = discord();
  book(e, "0002", 5);
  const r = await R.recordLineupRuling(e, { season: SEASON, leagueId: L, fid: "0002", week: 5, ruling: "confirmed", by: "0008", teamName: "CBP" });
  t.equal(r.ok, true); t.equal(r.offense_no, 1);
  const row = ruling(e, "0002", 5);
  t.equal(row.ruling, "confirmed"); t.equal(row.ruled_by, "0008"); t.equal(row.sanction_status, "none");
  t.match(row.league_notice, /CBP/); t.equal(row.notice_claimed_at_utc, null);
  t.equal(posts.length, 0, "ruling never posts by itself");
  const again = await R.recordLineupRuling(e, { season: SEASON, leagueId: L, fid: "0002", week: 5, ruling: "confirmed", by: "0008", teamName: "CBP" });
  t.equal(again.unchanged, true, "same ruling twice is a no-op");
});

test("an UNRULED earlier candidate blocks confirming a later week (the bogus #1-#4 → #5 trap)", async () => {
  const e = env();
  for (const w of [1, 2, 3, 4]) book(e, "0002", w, JSON.stringify([{ reason: "missing_starter", detail: "Only 0 of 18 starting slots filled." }]));
  book(e, "0002", 5);
  const r = await R.recordLineupRuling(e, { season: SEASON, leagueId: L, fid: "0002", week: 5, ruling: "confirmed", by: "0008" });
  t.equal(r.ok, false); t.equal(r.error, "earlier_candidates_unruled"); t.deepEqual(r.weeks, [1, 2, 3, 4]);
  t.equal(ruling(e, "0002", 5), undefined, "nothing written");
  // Excuse the four (commissioner immunity) and the real one is #1.
  for (const w of [1, 2, 3, 4]) {
    const x = await R.recordLineupRuling(e, { season: SEASON, leagueId: L, fid: "0002", week: w, ruling: "excused", note: "booking bug #1220", by: "0008" });
    t.equal(x.ok, true);
  }
  const voided = e.UPS_MFL_DB.raw.prepare(`SELECT COUNT(*) n FROM ups_lineup_violations WHERE fid='0002' AND voided=1`).get().n;
  t.equal(voided, 4, "excused weeks are voided, not deleted");
  const ok = await R.recordLineupRuling(e, { season: SEASON, leagueId: L, fid: "0002", week: 5, ruling: "confirmed", by: "0008" });
  t.equal(ok.ok, true); t.equal(ok.offense_no, 1);
});

test("excuse: voids the candidate and never posts", async () => {
  const e = env(); const posts = discord();
  book(e, "0002", 5);
  const r = await R.recordLineupRuling(e, { season: SEASON, leagueId: L, fid: "0002", week: 5, ruling: "excused", note: "family emergency", by: "0008" });
  t.equal(r.ok, true); t.equal(r.notices, null);
  t.equal(e.UPS_MFL_DB.raw.prepare(`SELECT voided, void_reason, voided_by FROM ups_lineup_violations WHERE fid='0002' AND week=5`).get().void_reason, "family emergency");
  const p = await R.postLineupNotice(e, { season: SEASON, leagueId: L, fid: "0002", week: 5, dmImpl: dmOk });
  t.equal(p.ok, false); t.equal(p.error, "not_confirmed"); t.equal(posts.length, 0);
});

test("no candidate, voided candidate, needs_review without a note: refused", async () => {
  const e = env();
  t.equal((await R.recordLineupRuling(e, { season: SEASON, leagueId: L, fid: "0003", week: 5, ruling: "confirmed", by: "0008" })).error, "no_candidate");
  book(e, "0004", 5, OUT2, 1);
  t.equal((await R.recordLineupRuling(e, { season: SEASON, leagueId: L, fid: "0004", week: 5, ruling: "confirmed", by: "0008" })).error, "candidate_voided");
  book(e, "0005", 5);
  e.UPS_MFL_DB.raw.prepare(`UPDATE ups_lineup_violations SET needs_review=1, review_note='Out then played' WHERE fid='0005'`).run();
  t.equal((await R.recordLineupRuling(e, { season: SEASON, leagueId: L, fid: "0005", week: 5, ruling: "confirmed", by: "0008" })).error, "review_note_required");
  t.equal((await R.recordLineupRuling(e, { season: SEASON, leagueId: L, fid: "0005", week: 5, ruling: "maybe", by: "0008" })).error, "bad_ruling");
});

test("notice posts ONCE, into the week's Injury Report thread, with the owner mention", async () => {
  const e = env(); const posts = discord();
  book(e, "0002", 5);
  e.UPS_MFL_DB.raw.prepare(`INSERT INTO ups_lineup_sat_announce_log (season, league_id, week, message_id, posted_unix) VALUES (?, ?, 5, '1558450448489259128', 1)`).run(SEASON, L);
  await R.recordLineupRuling(e, { season: SEASON, leagueId: L, fid: "0002", week: 5, ruling: "confirmed", by: "0008", teamName: "CBP" });
  const p = await R.postLineupNotice(e, { season: SEASON, leagueId: L, fid: "0002", week: 5, resolveMentions: mentions, dmImpl: dmOk });
  t.equal(p.ok, true);
  t.equal(posts.length, 1);
  t.match(posts[0].url, /\/channels\/1558450448489259128\/messages$/, "into the week's thread");
  t.match(posts[0].body.content, /\*\*CBP\*\* <@111111111111111111>: \*\*1st violation/);
  t.doesNotMatch(posts[0].body.content, /\{\{MENTION\}\}/);
  const row = ruling(e, "0002", 5);
  t.ok(row.notice_posted_at_utc); t.equal(JSON.parse(row.notice_refs_json).dm_sent, 1);
  const twice = await R.postLineupNotice(e, { season: SEASON, leagueId: L, fid: "0002", week: 5, resolveMentions: mentions, dmImpl: dmOk });
  t.equal(twice.ok, false); t.equal(twice.error, "already_claimed"); t.equal(posts.length, 1, "no second post");
  const change = await R.recordLineupRuling(e, { season: SEASON, leagueId: L, fid: "0002", week: 5, ruling: "excused", by: "0008" });
  t.equal(change.error, "notice_already_claimed", "a posted ruling is frozen");
});

test("thread refuses → falls back to the channel; total failure keeps the claim (no auto-retry)", async () => {
  const e = env();
  book(e, "0002", 5);
  e.UPS_MFL_DB.raw.prepare(`INSERT INTO ups_lineup_sat_announce_log (season, league_id, week, message_id, posted_unix) VALUES (?, ?, 5, '1558450448489259128', 1)`).run(SEASON, L);
  await R.recordLineupRuling(e, { season: SEASON, leagueId: L, fid: "0002", week: 5, ruling: "confirmed", by: "0008" });
  let posts = discord({ failTarget: "1558450448489259128" });
  const p = await R.postLineupNotice(e, { season: SEASON, leagueId: L, fid: "0002", week: 5, mention: false, dmImpl: dmOk });
  t.equal(p.ok, true); t.equal(posts.length, 2); t.match(posts[1].url, /\/channels\/1550849538229534760\/messages$/);

  const e2 = env();
  book(e2, "0002", 5);
  await R.recordLineupRuling(e2, { season: SEASON, leagueId: L, fid: "0002", week: 5, ruling: "confirmed", by: "0008" });
  posts = discord({ failTarget: "1550849538229534760" });
  const f = await R.postLineupNotice(e2, { season: SEASON, leagueId: L, fid: "0002", week: 5, dmImpl: dmOk });
  t.equal(f.ok, false); t.equal(f.error, "league_post_failed");
  const row = ruling(e2, "0002", 5);
  t.ok(row.notice_claimed_at_utc); t.equal(row.notice_posted_at_utc, null); t.ok(row.notice_error);
  t.equal((await R.postLineupNotice(e2, { season: SEASON, leagueId: L, fid: "0002", week: 5, dmImpl: dmOk })).error, "already_claimed");
});

test("Coffee Shop is refused before anything is claimed", async () => {
  const e = env({ channel: R.COFFEE_SHOP_CHANNEL_ID }); const posts = discord();
  book(e, "0002", 5);
  await R.recordLineupRuling(e, { season: SEASON, leagueId: L, fid: "0002", week: 5, ruling: "confirmed", by: "0008" });
  const p = await R.postLineupNotice(e, { season: SEASON, leagueId: L, fid: "0002", week: 5, dmImpl: dmOk });
  t.equal(p.error, "coffee_shop_blocked"); t.equal(posts.length, 0);
  t.equal(ruling(e, "0002", 5).notice_claimed_at_utc, null);
});

test("sanction: a 2nd offense is pending_manual until a person marks it done", async () => {
  const e = env();
  book(e, "0007", 3); book(e, "0007", 6);
  await R.recordLineupRuling(e, { season: SEASON, leagueId: L, fid: "0007", week: 3, ruling: "confirmed", by: "0008" });
  const r = await R.recordLineupRuling(e, { season: SEASON, leagueId: L, fid: "0007", week: 6, ruling: "confirmed", by: "0008" });
  t.equal(r.offense_no, 2); t.equal(ruling(e, "0007", 6).sanction_status, "pending_manual");
  t.equal((await R.markSanctionApplied(e, { season: SEASON, leagueId: L, fid: "0007", week: 3, by: "0008" })).error, "nothing_pending", "a warning has nothing to apply");
  const m = await R.markSanctionApplied(e, { season: SEASON, leagueId: L, fid: "0007", week: 6, by: "0008", note: "2027 R4 stripped; $5K adj posted" });
  t.equal(m.ok, true); t.equal(ruling(e, "0007", 6).sanction_status, "applied_manual");
  const x = await R.recordLineupRuling(e, { season: SEASON, leagueId: L, fid: "0007", week: 3, ruling: "excused", by: "0008" });
  t.equal(x.error, "later_ruling_exists", "excusing week 3 would silently renumber the confirmed week 6");
  t.deepEqual(x.weeks, [6]);
});

test("cases list: preview offense numbers skip voided weeks", async () => {
  const e = env();
  book(e, "0002", 1, OUT2, 1); book(e, "0002", 5);
  const c = await R.listLineupCases(e, { season: SEASON, leagueId: L });
  t.deepEqual(c.cases.map((x) => [x.week, x.preview_offense_no]), [[1, 0], [5, 1]]);
});

test("the module never calls MFL", async () => {
  const src = (await import("node:fs")).readFileSync(new URL("../worker/src/lineup_rulings.js", import.meta.url), "utf8")
    .split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
  t.doesNotMatch(src, /\/import\?|TYPE=salaryAdj|TYPE=draftResults|import\?TYPE/i);
});

await run("lineup_rulings");
