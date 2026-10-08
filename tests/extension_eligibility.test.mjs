// PRE-TRADE EXTENSION ELIGIBILITY — re-proven at the accept from authoritative data, every rule with its boundary, and fail-closed
// when an authority can't be read. Two layers:
//   1. the pure rule module (worker/src/extension_eligibility.js): every rule, every boundary to the second
//   2. the REAL worker on real SQLite (two-team accept + three-team gate) reading the real authorities: rosters, salaries, ups_tag_master,
//      ups_extension_master, ups_restructure_submissions, the contract-deadline calendar, MFL transactions
//   node tests/extension_eligibility.test.mjs
import { t, test, run } from "./fixtures/mini_test.mjs";
import { makeWorkerEnv, makeMfl, callWorker, bindSelf, quiet, ADMIN_KEY } from "./fixtures/worker_harness.mjs";
import * as F from "./fixtures/trade_3way_fixture.mjs";
await import("./fixtures/register_md_loader.mjs");
const { evaluateExtensionEligibility: judge, latestAcquisition, DAY, WINDOW_DAYS, EXT_RULES, parseLiveContract } = await import("../worker/src/extension_eligibility.js");
const { handle3WayButton } = await import("../worker/src/trade_3way.js");

const restore = quiet();

// ───────────────────────────────── layer 1: the rules ─────────────────────────────────
const DEADLINE = Math.floor(Date.parse("2026-09-07T03:59:59Z") / 1000);        // 2026-09-06 23:59:59 ET — the approved 2026 deadline (23:59 ET, open through that minute; contract_deadline.js)
const NOW_STD = DEADLINE - 10 * DAY;
const REQ = () => ({ player_id: "14056", from_franchise_id: "0001", to_franchise_id: "0002", extension_term: "2YR", new_contract_length: 3, new_TCV: 15000, new_aav_future: 5000 });
const FACTS = (o) => ({
  tradeLeagueId: "74598", tradeSeason: "2026", currentSeason: "2026",
  ownerFid: "0001", contract: { cy: "1", status: "Vet-FAA", salary: "5000", info: "CL 1|TCV 5K|AAV 5K|Y1-5K" },
  tagged: false, extension: { thisSeason: false, pairActive: false }, restructuredSinceOffer: false,
  septDeadlineUnix: DEADLINE, rookieWindowOpen: false, acquisition: null,
  plan: { year1Salary: 5000, length: 3, tcv: 15000 },
  ...(o || {}),
});
const j = (facts, now, req) => judge({ request: req || REQ(), facts, nowUnix: now == null ? NOW_STD : now });

test("RULES: a valid extension is eligible, and every rule has a documented authority", () => {
  const r = j(FACTS()); t.equal(r.ok, true); t.equal(r.window, "standard");
  for (const k of ["scope", "owner", "contract", "final_year", "tag", "era_myac", "deadline", "window", "history", "restructure", "amount"]) t.ok(EXT_RULES[k] && EXT_RULES[k].length > 20, `authority documented for ${k}`);
});
test("BOUNDARY: the September deadline — one second before and AT it are allowed; one second after is closed (no acquisition window)", () => {
  t.equal(j(FACTS(), DEADLINE - 1).ok, true, "1s before"); t.equal(j(FACTS(), DEADLINE).ok, true, "exactly at");
  const after = j(FACTS(), DEADLINE + 1); t.equal(after.ok, false); t.equal(after.reason, "deadline_passed", "1s after");
});
test("BOUNDARY: the four-week window after the deadline — TRADE-acquired: 0..28 days inclusive, one second past is closed", () => {
  const base = DEADLINE + 20 * DAY;
  const f = (ageSec) => FACTS({ acquisition: { kind: "trade", ts: base - ageSec } });
  t.equal(j(f(0), base).ok, true, "acquired this second"); t.equal(j(f(1), base).ok, true);
  t.equal(j(f(WINDOW_DAYS * DAY - 1), base).ok, true, "1s before the window closes"); t.equal(j(f(WINDOW_DAYS * DAY), base).ok, true, "exactly at 28 days");
  const late = j(f(WINDOW_DAYS * DAY + 1), base); t.equal(late.ok, false); t.equal(late.reason, "window_closed", "1s after");
  t.equal(j(f(-5), base).reason, "window_unresolved", "an acquisition 'in the future' is untrustworthy → closed");
  t.equal(j(f(0), base).window, "trade_window");
});
test("BOUNDARY: FCFS / waiver / auction pickup — days 1-14 are the MYM window (not open), 14..28 days is the extension window", () => {
  const base = DEADLINE + 20 * DAY;
  const f = (ageSec) => FACTS({ acquisition: { kind: "pickup", ts: base - ageSec } });
  const early = j(f(14 * DAY - 1), base); t.equal(early.ok, false); t.equal(early.reason, "window_not_open", "1s before day 15");
  t.equal(j(f(14 * DAY), base).ok, true, "exactly at day 15 opening"); t.equal(j(f(28 * DAY), base).ok, true, "exactly at day 28");
  t.equal(j(f(28 * DAY + 1), base).reason, "window_closed"); t.equal(j(f(20 * DAY), base).window, "pickup_window");
});
test("RULE: tagged (by the D1 tag master OR by the MFL contract status) — a tag overrides extension eligibility", () => {
  t.equal(j(FACTS({ tagged: true })).reason, "tagged");
  t.equal(j(FACTS({ contract: { cy: "1", status: "Tag", salary: "5000", info: "CL 1|TCV 5K|AAV 5K|Y1-5K" } })).reason, "tagged", "MFL says Tag even if D1 doesn't");
  t.equal(j(FACTS({ contract: { cy: "1", status: "Vet-Ext2-FL", salary: "5000", info: "CL 1|TCV 5K|AAV 5K|Y1-5K" } })).ok, true, "a status that merely contains letters t-a-g is not a tag");
});
test("RULE: previously extended — this season by anyone, or by this franchise while that contract is still running", () => {
  t.equal(j(FACTS({ extension: { thisSeason: true, pairActive: false } })).reason, "already_extended");
  t.equal(j(FACTS({ extension: { thisSeason: false, pairActive: true } })).reason, "already_extended");
});
test("RULE: stale contract / changed years / changed owner / unreadable contract", () => {
  t.equal(j(FACTS({ contract: { cy: "1", status: "Vet-FAA", salary: "12000", info: "CL 1|TCV 12K|AAV 12K|Y1-12K" } })).reason, "stale_current_salary", "the salary moved on");
  t.equal(j(FACTS({ contract: { cy: "3", status: "Vet-FAA", salary: "5000", info: "CL 3|TCV 15K|AAV 5K" } })).reason, "not_final_year", "years changed");
  t.equal(j(FACTS({ ownerFid: "0003" })).reason, "not_current_owner", "the player moved teams");
  t.equal(j(FACTS({ ownerFid: "" })).reason, "not_current_owner", "the player is on no roster");
  t.equal(j(FACTS({ contract: null })).reason, "no_live_contract");
  t.equal(j(FACTS({ contract: { cy: "", status: "Vet-FAA", salary: "5000", info: "CL 1|TCV 5K|AAV 5K" } })).reason, "live_contract_unreadable");
  t.equal(j(FACTS({ contract: { cy: "1", status: "Vet-FAA", salary: "", info: "CL 1|TCV 5K|AAV 5K" } })).reason, "live_contract_unreadable", "a blank salary is unresolved, not $0");
  t.equal(j(FACTS({ contract: { cy: "1", status: "Vet-FAA", salary: "5000", info: "" } })).reason, "live_contract_unreadable", "no contract info → can't anchor the amount");
});
test("RULE: exact league and season, current season only", () => {
  t.equal(j(FACTS({ tradeSeason: "2025", currentSeason: "2026" })).reason, "wrong_season");
  const r = REQ(); r.season = "2025"; t.equal(j(FACTS(), NOW_STD, r).reason, "wrong_season");
  const l = REQ(); l.league_id = "12345"; t.equal(j(FACTS(), NOW_STD, l).reason, "wrong_league");
});
test("RULE: rookies — an expired rookie (0 years) only while the rookie window is open; a vet at 0 years never; Vet-ERA is locked until the deadline", () => {
  const rk = (o) => FACTS({ contract: { cy: "0", status: "Rookie", salary: "5000", info: "CL 3|TCV 15K|AAV 5K" }, plan: { year1Salary: 5000, length: 2, tcv: 10000 }, ...(o || {}) });
  const rq = () => ({ ...REQ(), extension_term: "2YR", new_contract_length: 2, new_TCV: 10000 });
  t.equal(j(rk({ rookieWindowOpen: true }), NOW_STD, rq()).ok, true, "window open");
  t.equal(j(rk({ rookieWindowOpen: false }), NOW_STD, rq()).reason, "rookie_window_closed");
  t.equal(j(FACTS({ contract: { cy: "0", status: "Veteran", salary: "5000", info: "" }, rookieWindowOpen: true }), NOW_STD, rq()).reason, "not_final_year");
  const era = { cy: "1", status: "Vet-ERA", salary: "5000", info: "CL 1|TCV 5K|AAV 5K|Y1-5K" };
  t.equal(j(FACTS({ contract: era }), DEADLINE).reason, "vet_era_myac_window", "ERA winner inside the MYAC window (through the deadline)");
  t.equal(j(FACTS({ contract: era, acquisition: { kind: "trade", ts: DEADLINE + 5 * DAY - 3 * DAY } }), DEADLINE + 5 * DAY).ok, true, "after the deadline the ERA lock is lifted (and a trade window is open)");
});
test("RULE: restructured after the offer was made → the contract moved on", () => {
  t.equal(j(FACTS({ restructuredSinceOffer: true })).reason, "contract_restructured_since_offer");
});
test("RULE: the offer's own terms must agree with each other and with the live contract", () => {
  const bad = (mut) => { const r = REQ(); mut(r); return j(FACTS(), NOW_STD, r).reason; };
  t.equal(bad((r) => { r.new_contract_length = 4; }), "terms_inconsistent", "length ≠ its own year-by-year");
  t.equal(bad((r) => { r.new_TCV = 40000; }), "terms_inconsistent", "TCV ≠ the sum of its years");
  t.equal(bad((r) => { r.extension_term = "1YR"; }), "terms_inconsistent", "term ≠ length");
  t.equal(j(FACTS({ plan: null })).reason, "missing_salary_for_contract_year");
});
test("FAIL CLOSED: every authority that is missing refuses the extension with authority_unavailable:<fact> — never 'no restriction'", () => {
  const cases = {
    rosters: { ownerFid: null }, tags: { tagged: null }, extension_history: { extension: null }, restructure_history: { restructuredSinceOffer: null },
    contract_deadline: { septDeadlineUnix: null }, season: { currentSeason: "" },
  };
  for (const [fact, over] of Object.entries(cases)) t.equal(j(FACTS(over)).reason, `authority_unavailable:${fact}`, fact);
  t.equal(j(FACTS({ contract: { cy: "0", status: "Rookie", salary: "5000", info: "" }, rookieWindowOpen: null })).reason, "authority_unavailable:rookie_deadline");
  t.equal(j(FACTS({ acquisition: undefined }), DEADLINE + 1).reason, "authority_unavailable:transactions", "after the deadline an unreadable ledger closes it (it does NOT read as 'no acquisition')");
  t.equal(judge({ request: REQ(), facts: FACTS(), nowUnix: NaN }).reason, "authority_unavailable:clock");
  t.equal(judge({ request: {}, facts: FACTS(), nowUnix: NOW_STD }).reason, "missing_player_id");
});
test("ACQUISITION: read from MFL's real transaction shapes (FCFS/waiver/auction 'added|dropped'; trade franchise1/2_gave_up); the latest one wins", () => {
  const tx = { transactions: { transaction: [
    { type: "FREE_AGENT", franchise: "0001", transaction: "14056,|13000,", timestamp: "1000" },
    { type: "TRADE", franchise: "0003", franchise1_gave_up: "14056,", franchise2: "0001", franchise2_gave_up: "9,", timestamp: "2000" },
    { type: "BBID_WAIVER", franchise: "0002", transaction: "14056_500,|", timestamp: "3000" },
    { type: "FREE_AGENT", franchise: "0001", transaction: "|14056,", timestamp: "4000" },       // a DROP, not an add
  ] } };
  t.deepEqual(latestAcquisition(tx, "14056", "0001"), { kind: "trade", ts: 2000 }, "latest ADD/receive by that franchise (the drop at 4000 and the other team's claim don't count)");
  t.deepEqual(latestAcquisition(tx, "14056", "0002"), { kind: "pickup", ts: 3000 });
  t.equal(latestAcquisition(tx, "99999", "0001"), null); t.equal(latestAcquisition({}, "14056", "0001"), null); t.equal(latestAcquisition(null, "14056", "0001"), null);
  t.deepEqual(parseLiveContract("CL 2|TCV 12K|AAV 6K"), { tcv: 12000, cl: 2, aav: 6000 });
});

// ───────────────────────────────── layer 2: the real worker ─────────────────────────────────
const Q = "L=74598&YEAR=2026";
const clone = (o) => JSON.parse(JSON.stringify(o));
const player = (pid, salary = 5000) => ({ asset_id: `P_${pid}`, type: "PLAYER", player_id: String(pid), player_name: `P${pid}`, salary, taxi: false, contract_info: "" });
const LIVE = () => [{ id: "14056", salary: "5000", contractYear: "1", contractStatus: "Vet-FAA", contractInfo: "CL 1|TCV 5K|AAV 5K|Y1-5K" }];
const EXT = () => [{
  player_id: "14056", player_name: "P14056", from_franchise_id: "0001", to_franchise_id: "0002", extension_term: "2YR", option_key: "2YR|NONE",
  new_contract_status: "Vet-Ext2", new_TCV: 55000, new_aav_future: 25000, new_contract_length: 3, preview_contract_info_string: "CL 3| TCV 55K| AAV 5K, 25K| Y1-5K, Y2-25K, Y3-25K",
}];
const payloadOf = (ext) => ({
  schema_version: 1, source: "test", league_id: "74598", season: "2026",
  teams: [{ role: "left", franchise_id: "0001", selected_assets: [player(14056)], traded_salary_adjustment_k: 0 }, { role: "right", franchise_id: "0002", selected_assets: [player(13100)], traded_salary_adjustment_k: 0 }],
  extension_requests: ext || [], ui: { left_team_id: "0001", right_team_id: "0002" }, validation: { status: "ready" },
});
function fresh(over) { const env = makeWorkerEnv(over); const mfl = makeMfl({ tokens: { "tok-H": "0012" } }); mfl.install(); mfl.st.salaries = LIVE(); mfl.st.rosters["0002"] = [{ id: "13100", salary: 5000, contractStatus: "Vet-FAA", contractYear: "1", contractInfo: "CL 1|TCV 5K|AAV 5K|Y1-5K" }]; return { env, mfl }; }
async function sendOffer(env, mfl) {
  const r = await callWorker(env, "POST", `/api/trades/proposals?${Q}&MFL_USER_ID=tok-B`, { body: { league_id: "74598", season: "2026", from_franchise_id: "0001", to_franchise_id: "0002", message: "", payload: payloadOf(EXT()) } });
  t.ok(r.status < 300, `offer sent ${r.status}`);
  return mfl.st.pending[mfl.st.pending.length - 1].trade_id;
}
const accept = (env, id) => callWorker(env, "POST", `/api/trades/proposals/action?${Q}&MFL_USER_ID=tok-C`, { body: { action: "ACCEPT", trade_id: id, league_id: "74598", franchise_id: "0002", year: "2026", message: "" } });
const untouched = (mfl, label) => { t.equal(mfl.st.done.length, 0, `${label}: MFL never accepted`); t.equal(mfl.writes("tradeResponse").length, 0, `${label}: no tradeResponse`); t.equal(mfl.writes("salaries").length, 0, `${label}: no contract import`); };
async function refused(over, prep, expectReason, label) {
  const { env, mfl } = fresh(over);
  const id = await sendOffer(env, mfl);
  prep({ env, mfl });
  const r = await accept(env, id);
  // how a refusal is reported: an unreadable authority is a 503 (retry later), a stale PRICE is its own code, everything else is "no longer eligible"
  const [status, code] = /^authority_unavailable/.test(expectReason) ? [503, "extension_check_unavailable"] : expectReason === "extension_terms_stale" ? [409, "extension_terms_stale"] : [409, "extension_no_longer_eligible"];
  t.equal(r.status, status, `${label}: ${r.text.slice(0, 200)}`); t.equal(r.json.code, code, label);
  t.deepEqual(r.json.skipped.map((x) => x.reason), [expectReason], `${label}: the refusal says why`);
  untouched(mfl, label);
}
const sql = (env, q, ...a) => env.UPS_MFL_DB.raw.prepare(q).run(...a);

test("WORKER (2-way): a valid extension goes through; each rule refuses the accept BEFORE any MFL call, with its reason", async () => {
  { const { env, mfl } = fresh(); const id = await sendOffer(env, mfl); const r = await accept(env, id);
    t.equal(r.status, 200, r.text.slice(0, 200)); t.equal(mfl.st.done.length, 1); t.equal(mfl.writes("salaries").length >= 1, true); }
  await refused({}, ({ env }) => sql(env, "INSERT INTO ups_tag_master (league_id, season, franchise_id, tag_side, player_id) VALUES ('74598','2026','0001','OFFENSE','14056')"), "tagged", "tagged (D1 tag master)");
  await refused({}, ({ mfl }) => { mfl.st.salaries = [{ ...LIVE()[0], contractStatus: "Tag" }]; }, "tagged", "tagged (MFL contract status)");
  await refused({}, ({ env }) => sql(env, "INSERT INTO ups_extension_master (league_id, season, franchise_id, player_id, contract_end_year) VALUES ('74598','2026','0009','14056',2027)"), "already_extended", "extended this season by another team");
  await refused({}, ({ env }) => sql(env, "INSERT INTO ups_extension_master (league_id, season, franchise_id, player_id, contract_end_year) VALUES ('74598','2025','0001','14056',2026)"), "already_extended", "this franchise's earlier extension still running");
  await refused({}, ({ env }) => sql(env, "INSERT INTO ups_restructure_submissions (league_id, season, franchise_id, player_id, submitted_at_utc) VALUES ('74598','2026','0001','14056', ?)", new Date(Date.now() + 120000).toISOString()), "contract_restructured_since_offer", "restructured after the offer");
  await refused({}, ({ mfl }) => { mfl.st.salaries = [{ ...LIVE()[0], salary: "12000", contractInfo: "CL 1|TCV 12K|AAV 12K|Y1-12K" }]; }, "extension_terms_stale", "the contract moved on: the stored price is stale");
  await refused({}, ({ mfl }) => { mfl.st.salaries = [{ ...LIVE()[0], contractYear: "2", contractInfo: "CL 2|TCV 10K|AAV 5K" }]; }, "not_final_year", "years changed");
  // a restructure made BEFORE the offer is history, not a change since — the extension still goes through
  { const { env, mfl } = fresh(); sql(env, "INSERT INTO ups_restructure_submissions (league_id, season, franchise_id, player_id, submitted_at_utc) VALUES ('74598','2026','0001','14056', ?)", new Date(Date.now() - 3600000).toISOString());
    const id = await sendOffer(env, mfl); const r = await accept(env, id); t.equal(r.status, 200, "a restructure before the offer doesn't block: " + r.text.slice(0, 160)); }
});
test("WORKER (2-way): FAIL CLOSED — an authority that can't be read refuses the extension (authority_unavailable) and MFL is never called", async () => {
  await refused({}, ({ env }) => sql(env, "DROP TABLE ups_tag_master"), "authority_unavailable:tags", "tag table unreadable");
  await refused({}, ({ env }) => sql(env, "DROP TABLE ups_extension_master"), "authority_unavailable:extension_history", "extension history unreadable");
  await refused({}, ({ env }) => sql(env, "DROP TABLE ups_restructure_submissions"), "authority_unavailable:restructure_history", "restructure history unreadable");
});
test("WORKER (2-way): after the September deadline only the four-week acquisition window opens it — exact boundaries through the real calendar", async () => {
  const at = (iso) => ({ TWR_TEST_NOW_MS: String(Date.parse(iso)) });
  // The league calendar is deliberately UNSET in this harness, so this is the PINNED 2026 fallback — which now agrees with
  // the approved time (Keith 2026-10-08): 23:59 ET, open through 23:59:59 ET = 2026-09-07T03:59:59Z. (It was 21:00 ET.)
  // exactly at the deadline and 1s before: standard window
  for (const iso of ["2026-09-07T03:59:58Z", "2026-09-07T03:59:59Z", "2026-09-07T01:00:01Z"]) {
    const { env, mfl } = fresh(at(iso)); const id = await sendOffer(env, mfl); const r = await accept(env, id);
    t.equal(r.status, 200, `${iso}: ${r.text.slice(0, 160)}`);
  }
  // 1s after, no acquisition on record → closed
  await refused(at("2026-09-07T04:00:00Z"), () => {}, "deadline_passed", "1s after the deadline, no acquisition");
  // 1s after, but the extender got him by TRADE 10 days ago → the four-week window is open
  const tradeAt = (nowIso, ageSec) => (m) => { const now = Math.floor(Date.parse(nowIso) / 1000); m.st.transactions = [{ type: "TRADE", franchise: "0003", franchise1_gave_up: "14056,", franchise2: "0001", franchise2_gave_up: "9,", timestamp: String(now - ageSec) }]; };
  const NOW = "2026-09-20T12:00:00Z";
  { const { env, mfl } = fresh(at(NOW)); tradeAt(NOW, 10 * DAY)(mfl); const id = await sendOffer(env, mfl); const r = await accept(env, id); t.equal(r.status, 200, "10 days after a trade: " + r.text.slice(0, 160)); }
  { const { env, mfl } = fresh(at(NOW)); tradeAt(NOW, 28 * DAY)(mfl); const id = await sendOffer(env, mfl); const r = await accept(env, id); t.equal(r.status, 200, "exactly 28 days: " + r.text.slice(0, 160)); }
  await refused(at(NOW), ({ mfl }) => tradeAt(NOW, 28 * DAY + 1)(mfl), "window_closed", "28 days and 1 second after the trade");
  // a waiver/FCFS pickup: days 1-14 are the MYM window; the extension window opens on day 15
  const pickupAt = (ageSec) => ({ mfl }) => { const now = Math.floor(Date.parse(NOW) / 1000); mfl.st.transactions = [{ type: "FREE_AGENT", franchise: "0001", transaction: "14056,|", timestamp: String(now - ageSec) }]; };
  await refused(at(NOW), pickupAt(14 * DAY - 1), "window_not_open", "1s before day 15 of a pickup");
  { const { env, mfl } = fresh(at(NOW)); pickupAt(14 * DAY)({ mfl }); const id = await sendOffer(env, mfl); const r = await accept(env, id); t.equal(r.status, 200, "day 15 of a pickup: " + r.text.slice(0, 160)); }
  // the transactions ledger unreadable after the deadline → closed (NOT read as "no acquisition")
  await refused(at(NOW), ({ mfl }) => { mfl.st.exportFail = { transactions: 503 }; }, "authority_unavailable:transactions", "transactions unreadable after the deadline");
  { const { env, mfl } = fresh({ ...at(NOW), COMMISH_API_KEY: "k" }); void env; void mfl; }
});
test("WORKER (3-way): the same rules at the Discord accept — a changed owner, a tag and a restructure refuse it (accept NOT recorded, nothing changes)", async () => {
  const ext3 = () => [{ player_id: "16614", player_name: "P16614", from_franchise_id: "0008", to_franchise_id: "0001", applies_to_acquirer: true, option_key: "2YR|NONE", extension_term: "2YR", loaded_indicator: "NONE",
    new_contract_status: "Vet-Ext2", new_contract_length: 3, new_TCV: 55000, new_aav_future: 25000, preview_contract_info_string: "CL 3| TCV 55K| AAV 5K, 25K| Y1-5K, Y2-25K, Y3-25K" }];
  const world = () => {
    const env = makeWorkerEnv({ TRADE_3WAY_EXECUTE: "0" }); const mfl = makeMfl({ tokens: { "tok-H": "0012" } }); mfl.install(); bindSelf(env);
    for (const [fid, d] of [["0008", F.DISCORD.A], ["0001", F.DISCORD.B], ["0012", F.DISCORD.C]]) env.UPS_MFL_DB.raw.prepare("INSERT INTO discord_owners VALUES (?,?,?)").run(fid, "Y", d);
    F.seedTrade(env, { legs_json: JSON.stringify([{ from: "0008", to: "0001", asset_tokens: ["P_16614"], cap_k: 0 }, { from: "0001", to: "0012", asset_tokens: ["P_16181"], cap_k: 0 }, { from: "0012", to: "0008", asset_tokens: ["P_16650"], cap_k: 0 }]), extension_requests_json: JSON.stringify(ext3()) });
    mfl.st.rosters = { "0008": [{ id: "16614", salary: 5000 }], "0001": [{ id: "16181", salary: 5000, contractStatus: "Vet-FAA", contractYear: "1", contractInfo: "CL 1|TCV 5K|AAV 5K|Y1-5K" }], "0012": [{ id: "16650", salary: 5000, contractStatus: "Vet-FAA", contractYear: "1", contractInfo: "CL 1|TCV 5K|AAV 5K|Y1-5K" }] };
    mfl.st.salaries = [{ id: "16614", salary: "5000", contractYear: "1", contractStatus: "Vet-FAA", contractInfo: "CL 1|TCV 5K|AAV 5K|Y1-5K" }];
    return { env, mfl };
  };
  const press = (u) => ({ data: { custom_id: `tr3:accept:${F.TRADE_ID}` }, member: { user: { id: u } } });
  const say = async (r) => (await r.json()).data.content;
  { const { env } = world(); t.match(await say(await handle3WayButton(press(F.DISCORD.B), env, { waitUntil() {} })), /You're in/); t.equal(F.readRow(env).team_b_state, "accepted", "control: eligible → recorded"); }
  const cases = {
    "the player was tagged": ({ env }) => sql(env, "INSERT INTO ups_tag_master (league_id, season, franchise_id, tag_side, player_id) VALUES ('74598','2026','0008','OFFENSE','16614')"),
    "the contract was restructured after the trade was built": ({ env }) => sql(env, "INSERT INTO ups_restructure_submissions (league_id, season, franchise_id, player_id, submitted_at_utc) VALUES ('74598','2026','0008','16614', ?)", new Date(Date.now() + 120000).toISOString().replace("T", " ").slice(0, 19)),
  };
  for (const [name, prep] of Object.entries(cases)) {
    const w = world(); prep(w);
    const msg = await say(await handle3WayButton(press(F.DISCORD.B), w.env, { waitUntil() {} }));
    t.match(msg, /pre-trade extension in this trade is no longer allowed/, `${name}: ${msg.slice(0, 200)}`); t.match(msg, /wasn't recorded/, name);
    t.equal(F.readRow(w.env).team_b_state, "pending", `${name}: not recorded`); t.equal(F.readRow(w.env).status, "collecting"); t.equal(w.mfl.writes().length, 0);
  }
  { // an authority that cannot be READ is not a verdict on the extension: the accept is kept, execution is held, and it is recoverable (a re-check retries)
    const w = world(); sql(w.env, "DROP TABLE ups_tag_master");
    const msg = await say(await handle3WayButton(press(F.DISCORD.B), w.env, { waitUntil() {} }));
    t.match(msg, /couldn't verify a pre-trade extension in this trade right now/); t.equal(F.readRow(w.env).team_b_state, "accepted", "the accept is KEPT"); t.equal(w.mfl.writes().length, 0);
  }
  // Rules that need a movement the trade itself wouldn't survive (a player who left the extender; another season) are judged by the shared
  // authority the gate calls — asked directly, so the reason is visible.
  const w = world();
  const ask = async (extReq, season) => {
    const r = await callWorker(w.env, "POST", `/admin/3way/compliance?L=74598&YEAR=2026&APIKEY=${ADMIN_KEY}`, { body: { league_id: "74598", season: season || "2026", offer_created_at_utc: new Date(Date.now() - 3600000).toISOString(),
      movements: [{ from: "0008", to: "0001", tokens: ["16614"] }, { from: "0001", to: "0012", tokens: ["16181"] }, { from: "0012", to: "0008", tokens: ["16650"] }], extension_requests: [extReq] } });
    t.equal(r.status, 200, r.text.slice(0, 200)); return r.json.compliance.extension_skipped.map((x) => x.reason);
  };
  const good = { player_id: "16614", player_name: "P16614", from_franchise_id: "0008", to_franchise_id: "0001", option_key: "2YR|NONE", extension_term: "2YR", new_contract_status: "Vet-Ext2", new_contract_length: 3, new_TCV: 55000, new_aav_future: 25000, preview_contract_info_string: "CL 3| TCV 55K| AAV 5K, 25K| Y1-5K, Y2-25K, Y3-25K" };
  t.deepEqual(await ask(good), [], "control: the extension is eligible");
  t.deepEqual(await ask({ ...good, from_franchise_id: "0012" }), ["not_current_owner"], "a team that does not own the player cannot extend him");
  t.deepEqual(await ask(good, "2025"), ["wrong_season"], "an offer from another season");
  w.mfl.st.exportFail = { rosters: 503 };
  t.ok((await ask(good)).length >= 1, "rosters unreadable → the extension is not confirmed");
});

await run("extension_eligibility");
restore();
