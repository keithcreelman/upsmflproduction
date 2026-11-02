// Trade asset eligibility — the ONE shared rule (worker/src/trade_rules.js tradeAssetEligibility, browser twin site/shared/trade_rules.js)
// and its server inputs (worker/src/trade_asset_eligibility.js), the expired-rookie cap-money basis, the War Room's early-lock fix and the
// Front Office builder showing each reason beside a disabled asset. Keith's rulings 2 and 3, 2026-10-28 (#1385); canon
// docs/league_context_v1.md §A6 (trade eligibility, cap money), §C8 (tags, early lock-in), Section 3 (tag / rookie-extension deadline).
//   node tests/trade_asset_eligibility.test.mjs
import fs from "node:fs";
import vm from "node:vm";
import { createRequire } from "node:module";
import { t, test, run } from "./fixtures/mini_test.mjs";
import { makeD1, applyMigrations } from "./fixtures/d1_sqlite.mjs";
import { makeEl, makeContext, tick, verdict, toggle, choose } from "./fixtures/trade_builder_view_harness.mjs";
await import("./fixtures/register_md_loader.mjs");
const R = await import("../worker/src/trade_rules.js");
const TWIN = createRequire(import.meta.url)("../site/shared/trade_rules.js");
const E = await import("../worker/src/trade_asset_eligibility.js");
const { capMoneyViolations, pickEligibilityViolations, indexRosters } = await import("../worker/src/trade_accept_integrity.js");

const DEADLINE = Date.parse("2026-05-22T04:00:00Z");     // canon Section 3: midnight ET Thursday → Friday before Memorial Day 2026
const CTX = (now) => ({ season: 2026, nowMs: now, rookieDeadlineMs: DEADLINE });
const pl = (years, status, tag) => ({ kind: "player", years, contract_status: status, tag_state: tag });
const pk = (year, round, forfeit, label) => ({ kind: "pick", year, round, forfeit, forfeit_label: label });

// ───────────────────────── the deadline and tag states ─────────────────────────
test("the tag / rookie-extension deadline is 04:00 UTC on the Friday before Memorial Day (the worker's getTagDeadlineUtc), in both copies", () => {
  for (const [y, iso] of [[2025, "2025-05-23T04:00:00.000Z"], [2026, "2026-05-22T04:00:00.000Z"], [2027, "2027-05-28T04:00:00.000Z"], [2028, "2028-05-26T04:00:00.000Z"]]) {
    t.equal(new Date(R.tagDeadlineUtcMs(y)).toISOString(), iso, String(y));
    t.equal(TWIN.tagDeadlineUtcMs(String(y)), R.tagDeadlineUtcMs(y));
  }
  t.ok(Number.isNaN(R.tagDeadlineUtcMs("")) && Number.isNaN(R.tagDeadlineUtcMs("abc")), "unreadable season → NaN");
});

test("tag states: provisional until locked; early lock-in counts from its own second; the deadline locks every tag (+1 s); unreadable fails closed", () => {
  const S = (o) => R.tagTradeState({ deadlineMs: DEADLINE, nowMs: DEADLINE - 1000, ...o });
  t.equal(S({ tagged: false }), "none");
  t.equal(S({ tagged: null }), "unavailable", "tag rows unreadable");
  t.equal(S({ tagged: undefined }), "unavailable");
  t.equal(S({ tagged: true }), "provisional");
  t.equal(S({ tagged: true, lockedInAtMs: DEADLINE - 1000 }), "early_locked", "locked in this very second");
  t.equal(S({ tagged: true, lockedInAtMs: DEADLINE - 999 }), "provisional", "a lock-in time still in the future is not a lock");
  t.equal(S({ tagged: true, nowMs: DEADLINE }), "provisional", "AT the deadline second: not passed yet (strictly after, like hasTagDeadlinePassed)");
  t.equal(S({ tagged: true, nowMs: DEADLINE + 1 }), "deadline_locked", "+1 ms");
  t.equal(S({ tagged: true, nowMs: DEADLINE + 1000 }), "deadline_locked", "+1 s");
  t.equal(S({ tagged: true, deadlineMs: NaN }), "unavailable", "no readable deadline");
});

// ───────────────────────── every disabled reason ─────────────────────────
test("picks: 6th round, beyond next year, forfeited (with its own label), unreadable — each with its specific reason; a forfeit list that couldn't be read is a NOTICE", () => {
  const e = (a) => R.tradeAssetEligibility(a, CTX(DEADLINE + 1));
  t.equal(e(pk(2027, 1, false)).tradeable, true);
  t.equal(e(pk(2026, 1, false)).tradeable, true, "a current-year pick");
  const r6 = e(pk(2027, 6, false)); t.equal(r6.tradeable, false); t.equal(r6.code, "pick_round_6"); t.equal(r6.reason, "6th-round picks can't be traded.");
  const far = e(pk(2028, 1, false)); t.equal(far.code, "pick_beyond_next_year"); t.equal(far.reason, "Only this year's and next year's picks can be traded.");
  const ff = e(pk(2027, 2, true, "On hold — lineup penalty")); t.equal(ff.code, "pick_forfeited"); t.equal(ff.reason, "On hold — lineup penalty", "the forfeit's own label");
  t.equal(e(pk(2027, 2, true)).reason, "Forfeited — lineup penalty.");
  t.equal(e(pk(NaN, 1, false)).code, "pick_unreadable");
  const unv = e(pk(2027, 3, null)); t.equal(unv.tradeable, true); t.equal(unv.warning_code, "pick_forfeit_unverified", "Keith 2026-10-12: stays selectable, with the notice");
});

test("players: provisional tag, tag status unavailable, expired veteran, expired rookie (before / at / after the deadline), unreadable deadline", () => {
  const before = CTX(DEADLINE - 1000), at = CTX(DEADLINE), after = CTX(DEADLINE + 1000);
  const e = (a, c) => R.tradeAssetEligibility(a, c);
  t.equal(e(pl(2, "Vet-FAA", "none"), after).tradeable, true);
  const prov = e(pl(1, "Tag", "provisional"), before); t.equal(prov.tradeable, false); t.equal(prov.code, "tag_provisional"); t.equal(prov.reason, "Provisional tag: not locked yet, so it can't be traded.");
  const unk = e(pl(1, "Tag", "unavailable"), before); t.equal(unk.code, "tag_status_unavailable"); t.equal(unk.reason, "Tag status unavailable, so it can't be traded right now.");
  t.equal(e(pl(1, "Tag"), before).code, "tag_status_unavailable", "a Tag contract with no tag state from the worker is never assumed locked");
  const vet = e(pl(0, "Vet-FAA", "none"), before); t.equal(vet.code, "expired_veteran"); t.equal(vet.reason, "Expired veteran contract: can't be traded.");
  const rk = e(pl(0, "Rookie-Draft", "none"), before); t.equal(rk.tradeable, true); t.equal(rk.expired_rookie, true); t.equal(rk.warning_code, "expired_rookie_window");
  t.equal(e(pl(0, "Rookie-Draft", "none"), at).tradeable, true, "at the deadline second");
  const late = e(pl(0, "Rookie-Draft", "none"), after); t.equal(late.code, "expired_rookie_deadline_passed"); t.equal(late.reason, "Expired rookie: the extension deadline has passed.");
  t.equal(e(pl(0, "Rookie-Draft", "none"), { season: 2026, nowMs: DEADLINE }).code, "rookie_deadline_unavailable");
  t.equal(e(pl(0, "Taxi", "none"), before).tradeable, true, "a taxi rookie (the War Room shows his status as Taxi) is a rookie");
  t.equal(e(pl(null, "", "none"), after).tradeable, true, "a BLANK contract is unstamped, never read as expired");
  t.equal(e(pl("", "Vet-FAA", "none"), after).tradeable, true);
});

test("tags: an EARLY-LOCKED or DEADLINE-LOCKED tag can be traded but can't be extended (reason shown)", () => {
  for (const [state, c] of [["early_locked", CTX(DEADLINE - 1000)], ["deadline_locked", CTX(DEADLINE + 1000)]]) {
    const r = R.tradeAssetEligibility(pl(1, "Tag", state), c);
    t.equal(r.tradeable, true, state); t.equal(r.extendable, false, state);
    t.equal(r.extension_code, "tag_locked_no_extension"); t.equal(r.extension_reason, "Locked tag: tradeable, but it can't be extended.");
  }
  t.equal(R.tradeAssetEligibility(pl(1, "Vet-FAA", "none"), CTX(DEADLINE)).extendable, null, "not decided here for an untagged player (the server's extension check is)");
});

test("the browser twin answers exactly as the worker on a grid of cases", () => {
  const cases = [pk(2027, 1, false), pk(2027, 6, false), pk(2028, 2, false), pk(2027, 2, true, "x"), pk(2027, 3, null),
    pl(1, "Tag", "provisional"), pl(1, "Tag", "early_locked"), pl(1, "Tag"), pl(0, "Vet-FAA", "none"), pl(0, "Rookie-Draft", "none"), pl(null, "", "none")];
  for (const c of cases) for (const now of [DEADLINE - 1, DEADLINE, DEADLINE + 1]) t.deepEqual(TWIN.tradeAssetEligibility(c, CTX(now)), R.tradeAssetEligibility(c, CTX(now)), JSON.stringify(c));
});

test("the worker's pick check reads the same rule (legacy reason strings kept for existing callers)", () => {
  t.deepEqual(pickEligibilityViolations({ byFranchise: { "0001": ["FP_0001_2027_6", "FP_0001_2028_1", "FP_0001_2027_1", "DP_5_1", "DP_0_3", "14056"] }, season: "2026" }), [
    { token: "FP_0001_2027_6", sender: "0001", reason: "round_6_pick_not_tradeable" },
    { token: "FP_0001_2028_1", sender: "0001", reason: "future_pick_beyond_horizon" },
    { token: "DP_5_1", sender: "0001", reason: "round_6_pick_not_tradeable" }]);
});

// ───────────────────────── ruling 3: the 50% cap-money basis ─────────────────────────
test("cap-money basis: an expired rookie counts his extension's NEW salary when one is included, else his PRIOR-season salary; null = unavailable", () => {
  const rk = { years: 0, contract_status: "Rookie-Draft", salary: 0 };
  t.equal(R.capMoneyBasisDollars(rk, { extensionYear1: 16000, priorSeasonSalary: 4000 }), 16000, "with the extension");
  t.equal(R.capMoneyBasisDollars(rk, { priorSeasonSalary: 4000 }), 4000, "without it");
  t.equal(R.capMoneyBasisDollars(rk, {}), null, "no prior salary readable");
  t.equal(R.capMoneyBasisDollars({ ...rk, taxi: true }, { priorSeasonSalary: 4000 }), 0, "taxi never counts");
  t.equal(R.capMoneyBasisDollars({ years: 2, contract_status: "Vet-FAA", salary: 9000 }, { priorSeasonSalary: 1 }), 9000, "everyone else: his current salary");
});

const ROSTERS = indexRosters({ rosters: { franchise: [
  { id: "0001", player: [{ id: "14056", salary: "", status: "ROSTER", contractYear: "0", contractStatus: "Rookie-Draft" }, { id: "15000", salary: "6000", status: "ROSTER", contractYear: "2", contractStatus: "Vet-FAA" }] },
  { id: "0002", player: [{ id: "13100", salary: "5000", status: "ROSTER", contractYear: "1", contractStatus: "Vet-FAA" }] }] } });
test("cap-money limit (server, the accept's check): prior-season basis vs extension basis, both ways; an unreadable figure counts $0 and says so", () => {
  const by = (bb) => ({ "0001": ["14056", `BB_${bb}`], "0002": ["13100"] });
  t.deepEqual(capMoneyViolations({ byFranchise: by(5000), rosters: ROSTERS, basis: { priorSalary: { "14056": 10000 } } }), [], "$5K ≤ 50% of a $10K prior salary");
  t.deepEqual(capMoneyViolations({ byFranchise: by(6000), rosters: ROSTERS, basis: { priorSalary: { "14056": 10000 } } }), [{ franchise_id: "0001", reason: "cap_money_over_50pct", traded_dollars: 6000, max_dollars: 5000 }]);
  t.deepEqual(capMoneyViolations({ byFranchise: by(8000), rosters: ROSTERS, basis: { extensionYear1: { "14056": 16000 }, priorSalary: { "14056": 4000 } } }), [], "with his extension: $8K ≤ 50% of $16K");
  t.deepEqual(capMoneyViolations({ byFranchise: by(9000), rosters: ROSTERS, basis: { extensionYear1: { "14056": 16000 } } })[0].max_dollars, 8000);
  const un = capMoneyViolations({ byFranchise: by(1000), rosters: ROSTERS, basis: {} });
  t.equal(un[0].max_dollars, 0); t.equal(un[0].basis_unavailable, true, "fails closed and says why");
  t.equal(capMoneyViolations({ byFranchise: by(1000), rosters: ROSTERS, basis: { extensionYear1: { "14056": null }, priorSalary: { "14056": 10000 } } })[0].basis_unavailable, true, "an unreadable extension never falls back to the prior salary");
  t.deepEqual(capMoneyViolations({ byFranchise: { "0001": ["15000", "BB_3000"] }, rosters: ROSTERS }), [], "an ordinary player: his live salary, exactly as before");
});

test("the extension's year-1 salary is read from its stored contract info (the price the create/accept re-pricing pins)", () => {
  t.equal(E.extensionYear1Dollars({ preview_contract_info_string: "CL 2| TCV 50K| AAV 25K| Y1-20K, Y2-30K" }), 20000);
  t.equal(E.extensionYear1Dollars({ preview_contract_info_string: "Y1-$16.5K" }), 16500);
  t.equal(E.extensionYear1Dollars({ new_aav_current: 12 }), 12000);
  t.equal(E.extensionYear1Dollars({}), null);
  t.deepEqual(E.extensionYear1ByPlayer([{ player_id: "P_14056", preview_contract_info_string: "Y1-16K" }, { player_id: "13100" }]), { "14056": 16000, "13100": null });
});

// ───────────────────────── the server's tag facts (D1 reads) ─────────────────────────
function tagDb({ submissions = true, column = true } = {}) {
  const db = makeD1({});
  applyMigrations(db, ["0030_tag_master.sql"]);
  if (submissions) db.raw.exec(`CREATE TABLE ups_tag_submissions (id INTEGER PRIMARY KEY, league_id TEXT, season TEXT, franchise_id TEXT, player_id TEXT, action TEXT, dry_run INTEGER DEFAULT 0${column ? ", locked_in_at TEXT" : ""})`);
  const sqls = []; const prepare = db.prepare.bind(db); db.prepare = (sql) => { sqls.push(sql); return prepare(sql); };
  db.tag = (pid, lock) => {
    db.raw.prepare("INSERT INTO ups_tag_master (league_id, season, franchise_id, tag_side, player_id) VALUES ('74598','2026',?,'OFFENSE',?)").run(String(db.raw.prepare("SELECT COUNT(*) AS n FROM ups_tag_master").get().n + 1).padStart(4, "0"), pid);
    if (submissions && column) db.raw.prepare("INSERT INTO ups_tag_submissions (league_id, season, franchise_id, player_id, action, locked_in_at) VALUES ('74598','2026','0001',?,'tag',?)").run(pid, lock);
  };
  db.sqls = sqls;
  return db;
}
test("tag facts: before the deadline two small reads (filtered by player); after it, NONE; a missing lock column means no early lock (stricter); a broken master fails closed", async () => {
  let db = tagDb(); db.tag("15287", "2026-05-01 10:00:00"); db.tag("15253", null);
  let f = await E.loadTagFacts(db, { leagueId: "74598", season: "2026", nowMs: DEADLINE - 1000, pids: ["15287", "15253", "999"] });
  t.equal(f.ok, true); t.equal(E.playerTagState(f, "15287", "Tag", DEADLINE - 1000), "early_locked"); t.equal(E.playerTagState(f, "15253", "Tag", DEADLINE - 1000), "provisional");
  t.equal(E.playerTagState(f, "999", "Vet-FAA", DEADLINE - 1000), "none");
  t.equal(db.sqls.length, 2); t.ok(db.sqls.every((s) => /player_id IN \(\?,\?,\?\)/.test(s)), "both filtered to the trade's players");
  db = tagDb(); f = await E.loadTagFacts(db, { leagueId: "74598", season: "2026", nowMs: DEADLINE + 1, pids: ["15287"] });
  t.equal(f.afterDeadline, true); t.equal(db.sqls.length, 0, "no D1 read after the deadline");
  t.equal(E.playerTagState(f, "15287", "Tag", DEADLINE + 1), "deadline_locked"); t.equal(E.playerTagState(f, "1", "Vet-FAA", DEADLINE + 1), "none");
  db = tagDb({ column: false }); db.tag("15287"); f = await E.loadTagFacts(db, { leagueId: "74598", season: "2026", nowMs: DEADLINE - 1, pids: ["15287"] });
  t.equal(f.ok, true); t.equal(E.playerTagState(f, "15287", "Tag", DEADLINE - 1), "provisional", "no lock column: never treated as locked");
  db = tagDb({ submissions: false }); db.tag("15287"); f = await E.loadTagFacts(db, { leagueId: "74598", season: "2026", nowMs: DEADLINE - 1, pids: ["15287"] });
  t.equal(E.playerTagState(f, "15287", "Tag", DEADLINE - 1), "provisional", "no submissions table: provisional");
  db = tagDb(); db.raw.exec("DROP TABLE ups_tag_master"); f = await E.loadTagFacts(db, { leagueId: "74598", season: "2026", nowMs: DEADLINE - 1, pids: ["15287"] });
  t.equal(f.ok, false); t.equal(E.playerTagState(f, "15287", "Vet-FAA", DEADLINE - 1), "unavailable", "an unreadable master: every player unavailable (fail closed)");
  const v = E.eligibilityVerdict(E.playerEligibilityViolations({ byFranchise: { "0001": ["15287"] }, contracts: { "15287": { years: "1", status: "Vet-FAA" } }, facts: f, season: "2026", nowMs: DEADLINE - 1 }));
  t.equal(v.http, 503); t.equal(v.code, "trade_eligibility_unavailable");
});

// ───────────────────────── the War Room's early-lock fix ─────────────────────────
const WR = fs.readFileSync(new URL("../site/trades/trade_workbench.js", import.meta.url), "utf8");
function fnOf(src, name) {
  const start = src.indexOf(`function ${name}(`); if (start < 0) throw new Error(name);
  let i = src.indexOf("{", start), depth = 0;
  for (; i < src.length; i += 1) { if (src[i] === "{") depth += 1; else if (src[i] === "}" && --depth === 0) break; }
  return src.slice(start, i + 1);
}
function warRoom(nowIso) {
  const ctx = { Object, Math, String, JSON, Array, Number, isFinite, parseInt, Date: class extends Date { static now() { return Date.parse(nowIso); } } };
  ctx.window = ctx; vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(new URL("../site/shared/trade_rules.js", import.meta.url), "utf8"), ctx);
  vm.runInContext(["function safeStr(v){ return String(v == null ? '' : v).trim(); }", "function safeInt(v, d){ var n = parseInt(v, 10); return isFinite(n) ? n : (d || 0); }",
    "function tradeRules(){ return window.UPS_TRADE_RULES; } var TRADE_RULES_UNAVAILABLE = 'x'; function getCurrentTradeSeason(){ return 2026; }",
    "function resolvePickMeta(a){ return { round: a.pick_round, year: a.pick_season }; }",
    ...["isForfeitedPick", "tradeEligibilityOf", "isTradeEligibleAsset", "isTaggedTradeIneligibleAsset", "getTradeIneligibleReason"].map((n) => fnOf(WR, n))].join("\n"), ctx);
  return ctx;
}
const tagged = (extra) => ({ type: "PLAYER", player_id: "15287", years: 1, contract_type: "Tag", contract_info: "CL 1| TCV 51K| Tag| Tier 1", ...(extra || {}) });
test("War Room EARLY-LOCK FIX: an early-locked tag is tradeable before the deadline (it used to be refused); a provisional one is not, with the reason", () => {
  const before = warRoom("2026-05-15T12:00:00Z");
  t.equal(before.isTradeEligibleAsset(tagged({ tag_state: "early_locked" })), true, "early-locked: tradeable");
  t.equal(before.isTradeEligibleAsset(tagged({ tag_state: "provisional" })), false);
  t.equal(before.getTradeIneligibleReason(tagged({ tag_state: "provisional" })), "Ineligible: Provisional tag: not locked yet, so it can't be traded.");
  t.equal(before.isTradeEligibleAsset(tagged()), false, "no tag state from the worker before the deadline: unavailable, not assumed locked");
  t.equal(before.getTradeIneligibleReason(tagged()), "Ineligible: Tag status unavailable, so it can't be traded right now.");
  t.equal(before.isTradeEligibleAsset({ type: "PLAYER", years: 0, contract_type: "Vet-FAA" }), false, "expired veteran");
  t.equal(before.isTradeEligibleAsset({ type: "PICK", pick_season: 2028, pick_round: 1 }), false, "beyond next year (the War Room didn't check this before)");
  t.equal(before.isTradeEligibleAsset({ type: "PICK", pick_season: 2027, pick_round: 3 }), true, "an unreadable forfeit list keeps picks selectable (Keith 2026-10-12)");
  // The old copy refused every Tag until Thursday 23:59:59 UTC; canon's lock is 04:00 UTC Friday. Between the two, a tag is still before the deadline.
  const between = warRoom("2026-05-22T02:00:00Z");
  t.equal(between.isTradeEligibleAsset(tagged()), false, "02:00 UTC Friday is still BEFORE the deadline (the old copy said it had passed)");
  t.equal(warRoom("2026-05-22T04:00:01Z").isTradeEligibleAsset(tagged()), true, "after the deadline every tag is locked: tradeable");
  t.doesNotMatch(WR, /setUTCHours\(23, 59, 59, 999\)/, "the War Room's own Thursday deadline is gone");
});

// ───────────────────────── the Front Office builder ─────────────────────────
const P = (id, name, extra) => ({ id, name, position: "WR", salary: 10000, years: 1, type: "Vet-FAA", special: "", isTaxi: false, isIr: false, ...(extra || {}) });
function frontOffice({ now, workbench, picks }) {
  const { ctx, calls, fireDoc } = makeContext(["site/shared/pretrade_extension.js", "site/rosters/v2/fo_trade_builder.js"]);
  const TEAMS = [
    { fid: "0008", name: "Real Deal Creel", players: [P("101", "Mine, Plain"), P("102", "Mine, Tagged", { type: "Tag" }), P("103", "Mine, Expired", { years: 0 }), P("104", "Mine, Rookie", { years: 0, type: "Rookie-Draft", salary: 0 }), P("105", "Mine, Locked", { type: "Tag" })] },
    { fid: "0010", name: "Long Haulers", players: [P("201", "Theirs, One")] }];
  const host = makeEl();
  ctx.UPS_FO = { teams: () => TEAMS, viewerFid: () => "0008", warRoomUrl: () => "", capFor: () => null, capCeiling: 0, capHit: (p) => p.salary, isLoaded: () => false, show() {} };
  ctx.UPS_FO_DATA = { config: () => ({ apiBase: "https://w.test", leagueId: "74598", season: "2026", sessionQuery: (u) => u }), get: (k) => (k === "picks" ? picks : null) };
  ctx.UPS_FO_HUB = { asArray: (x) => (Array.isArray(x) ? x : x ? [x] : []), pad4: (x) => String(x).padStart(4, "0"), teamName: (x) => x, playerButton: (a, b, c) => c, openDialog() {}, closeAbout() {} };
  ctx.UPS_FO_TRADE_BUILDER_CONFIG = { preview: () => verdict("provisional"), extensionFacts: () => null, debounceMs: 0, nowMs: Date.parse(now), workbench };
  fireDoc("fo:ready");
  host.__tbHandle = ctx.UPS_FO_TRADE_BUILDER.mount(host);
  return { ctx, host, calls, A: ctx.UPS_FO_TRADE_BUILDER };
}
const PICKS = { state: "ok", data: { futureDraftPicks: { franchise: [{ id: "0008", futureDraftPick: [{ year: "2027", round: "1" }, { year: "2027", round: "6" }, { year: "2028", round: "1" }, { year: "2027", round: "2" }] }] } } };
const WB = (marksOk = true) => ({ meta: { forfeit_marks: { ok: marksOk, marked: 1 }, tag_status: { ok: true } }, teams: [{ franchise_id: "0008", assets: [
  { type: "PLAYER", player_id: "102", tag_state: "provisional" }, { type: "PLAYER", player_id: "105", tag_state: "early_locked" }, { type: "PLAYER", player_id: "104", prior_season_salary: 10000 },
  { type: "PICK", pick_key: "FP_0008_2027_2", forfeited: true, forfeit_label: "Forfeited — lineup penalty" },
  { type: "PICK", pick_key: "DP_00_03", pick_season: 2026 }] }] });
const row = (html, name) => { const i = html.indexOf(name); return i < 0 ? "" : html.slice(i, html.indexOf("</tr>", i)); };
test("Front Office: each disabled asset says WHY beside it, its button is disabled, this year's picks are listed, and nothing is fetched", async () => {
  const fo = frontOffice({ now: "2026-05-15T12:00:00Z", workbench: WB(), picks: PICKS });
  toggle(fo.host, 1); choose(fo.host, 0, "0010"); await tick();
  const h = fo.host.innerHTML;
  const expect = [["Mine, Tagged", "Provisional tag: not locked yet, so it can&#39;t be traded."], ["Mine, Expired", "Expired veteran contract: can&#39;t be traded."],
    ["2027 6th", "6th-round picks can&#39;t be traded."], ["2028 1st", "Only this year&#39;s and next year&#39;s picks can be traded."], ["2027 2nd", "Forfeited — lineup penalty"]];
  for (const [name, why] of expect) {
    const r = row(h, name);
    t.ok(r.includes('<div class="fo-tb-why bad" data-why>' + why), name + ": reason printed beside it → " + r.slice(0, 400));
    t.ok(/<button[^>]*disabled aria-disabled="true"[^>]*>Can’t add<\/button>/.test(r), name + ": disabled");
  }
  t.ok(/Can’t add Mine, Tagged: Provisional tag/.test(h), "the reason is in the button's accessible name too");
  t.ok(row(h, "Mine, Locked").includes("Locked tag: tradeable, but it can&#39;t be extended."), "an early-locked tag: addable, with its no-extension notice");
  t.ok(/>Add<\/button>/.test(row(h, "Mine, Locked")));
  t.ok(row(h, "Mine, Rookie").includes("Expired rookie: tradeable until the extension deadline."), "expired rookie before the deadline: addable, with the notice");
  t.ok(h.includes("2026 1.04 (this year)"), "this year's pick (DP_00_03 → 1.04) is listed");
  t.ok(/>Add<\/button>/.test(row(h, "2026 1.04")), "and addable");
  t.equal(fo.calls.fetch, 0, "the workbench answer came from the seam: no network call");
});

test("Front Office: a disabled asset can't be added by a click; one brought in from another page makes the trade incomplete, with the reason", async () => {
  const fo = frontOffice({ now: "2026-05-15T12:00:00Z", workbench: WB(), picks: PICKS });
  toggle(fo.host, 1); choose(fo.host, 0, "0010"); await tick();
  const b = fo.host.node(/<button[^>]*data-tok="P_103" data-from="0008"[^>]*>/);
  t.ok(b.disabled);
  fo.host.fire("click", { ...b, disabled: false });          // even a forced click (no disabled flag) is refused by the handler
  t.equal(fo.host.__tbHandle.draft().items.length, 0, "never added");
  const r = fo.A.openDraft({ source: "Trade finder", movements: [{ from: "0008", to: "0010", tokens: ["P_103"] }, { from: "0010", to: "0008", tokens: ["P_201"] }] }, { confirm: () => true });
  t.equal(r.ok, true);
  await tick();
  t.equal(fo.A._ineligibleOf({ from: "0008", token: "P_103" }), "Expired veteran contract: can't be traded.");
  t.ok(fo.host.innerHTML.includes("Mine, Expired: Expired veteran contract: can&#39;t be traded."), "the structure check names it");
  t.ok(/fo-tb-verdict fo-tb-incomplete/.test(fo.host.innerHTML), "incomplete: never sent to the server check");
});

test("Front Office: before /trade-workbench answers, a Tag contract is 'Tag status unavailable' until the deadline, then locked; an unreadable forfeit list leaves picks addable with the notice", async () => {
  let fo = frontOffice({ now: "2026-05-15T12:00:00Z", workbench: { meta: {}, teams: [] }, picks: PICKS });
  let pls = JSON.parse(JSON.stringify(fo.A._playersOf("0008")));
  t.equal(pls.find((p) => p.id === "102").elig.code, "tag_status_unavailable");
  const fp = JSON.parse(JSON.stringify(fo.A._picksOf("0008"))).find((p) => p.token === "FP_0008_2027_1");
  t.equal(fp.elig.tradeable, true); t.equal(fp.elig.warning_code, "pick_forfeit_unverified");
  fo = frontOffice({ now: "2026-10-28T12:00:00Z", workbench: { meta: {}, teams: [] }, picks: PICKS });
  pls = JSON.parse(JSON.stringify(fo.A._playersOf("0008")));
  t.equal(pls.find((p) => p.id === "102").elig.tradeable, true, "after the deadline every tag is locked");
  t.equal(pls.find((p) => p.id === "102").elig.extendable, false, "and can't be extended");
  t.equal(pls.find((p) => p.id === "104").elig.code, "expired_rookie_deadline_passed");
  t.equal(JSON.stringify(fo.A._extensionOptions({ from: "0008", to: "0010", token: "P_102", label: "x" })), "[]", "a locked tag is never offered extension choices");
});

test("Front Office (ruling 3): an expired rookie unlocks cap money from last season's salary; nothing when that is unknown", async () => {
  let fo = frontOffice({ now: "2026-05-15T12:00:00Z", workbench: WB(), picks: PICKS });
  const C = fo.ctx.UPS_TRADE_BUILDER_CORE;
  let d = C.addItem(C.withTeams(C.emptyDraft(["0008"]), ["0008", "0010"]), { from: "0008", to: "0010", token: "P_104", label: "R", salary: 0 });
  t.equal(C.capMoneyMaxK(d, "0008", "0010", fo.A._capBasis), 5, "$10K prior salary → $5K");
  t.equal(C.capMoneyMaxK(d, "0008", "0010"), 0, "without the basis (his current salary is blank): $0");
  fo = frontOffice({ now: "2026-05-15T12:00:00Z", workbench: { meta: { tag_status: { ok: true } }, teams: [] }, picks: PICKS });
  t.equal(fo.ctx.UPS_TRADE_BUILDER_CORE.capMoneyMaxK(d, "0008", "0010", fo.A._capBasis), 0, "no prior salary readable: $0 (the server re-verifies)");
  d = C.addItem(d, { from: "0008", to: "0010", token: "P_101", label: "P", salary: 10000 });
  t.equal(C.capMoneyMaxK(d, "0008", "0010", fo.A._capBasis), 5, "an ordinary player still counts his own salary");
});

await run("trade_asset_eligibility");
