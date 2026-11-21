// League Record S1 pilot (trade and draft-pick lineage): acceptance tests T1-T16 plus unit tests of the extraction. Offline, read-only, deterministic.
//   node tests/league_record_s1_pilot.test.mjs
// Reads only committed files: the archive data/db-archives/mfl_database_2026-06-05.db.gz (decompressed into a temp directory and opened read-only) and data/mfl-snapshots/2026-11-19.
// No D1, no network, no Worker, no model.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test, run, t } from "./fixtures/mini_test.mjs";
import { openArchive, assertQueryAllowed, ArchiveGuardError, ALLOWED_TABLES, ARCHIVE_GZ_SHA256 } from "../scripts/league_record/s1/archive.mjs";
import { BANNED_TABLES, scanSource, scanExtractionSources } from "../scripts/league_record/s1/guard.mjs";
import { parseTokens, etParts, slotPickAsset, futurePickAsset } from "../scripts/league_record/s1/sources.mjs";
import { buildLedger, playerChain, pickChain, resolveSlotPick, resolveFuturePick, holderAt, gapsBetween, CLASS, RULES } from "../scripts/league_record/s1/lineage.mjs";
import { calendarKickoff, kickoffDates, lastLeagueWeek } from "../scripts/league_record/s1/economics.mjs";
import { buildPilotBundle, stableStringify, PILOT } from "../scripts/league_record/s1/pilot.mjs";
import { renderReport, confirmedTotals } from "../scripts/league_record/s1/report.mjs";
import { runAcceptance, syntheticLedger, syntheticChain } from "../scripts/league_record/s1/acceptance.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "docs", "league_record", "pilot");

const archive = await openArchive({ root: ROOT });
const bundle = await buildPilotBundle({ root: ROOT });
const nodeOf = (id) => bundle.nodes.find((n) => n.id === id);

// ── acceptance tests T1-T16 ──────────────────────────────────────────────────────────────────────
test("acceptance T1-T15 pass on the pilot bundle (T16, the independent review and CI, is recorded on the pull request)", async () => {
  const committedPath = path.join(OUT, "aj_brown_bundle.json");
  const committed = fs.existsSync(committedPath) ? JSON.parse(fs.readFileSync(committedPath, "utf8")) : null;
  const results = await runAcceptance({ bundle, root: ROOT, archive, rebuild: () => buildPilotBundle({ root: ROOT }), committedBundle: committed });
  t.equal(results.length, 16);
  for (const r of results) { if (r.id === "T16") { t.equal(r.pass, null); continue; } t.equal(r.pass, true, `${r.id}: ${r.title} ${r.detail}`); }
  t.ok(committed, "the committed bundle exists (run: node scripts/league_record/s1/run_pilot.mjs)");
});

test("the committed bundle, report and acceptance results equal a fresh build (regenerate with scripts/league_record/s1/run_pilot.mjs)", async () => {
  const results = await runAcceptance({ bundle, root: ROOT, archive, rebuild: null, committedBundle: null });
  const want = { "aj_brown_bundle.json": `${stableStringify(bundle)}\n`, "aj_brown_report.md": renderReport(bundle, results), "acceptance.json": `${stableStringify(results)}\n` };
  for (const [name, text] of Object.entries(want)) { const p = path.join(OUT, name); t.ok(fs.existsSync(p), name); t.equal(fs.readFileSync(p, "utf8"), text, `${name} is stale`); }
});

// ── the pilot facts (golden values from the committed sources) ────────────────────────────────────
test("pilot: the upstream and primary trades, with the 20K cap transfer, equal the archive rows", () => {
  const up = bundle.trades.trade2024_30, pri = bundle.trades.trade2025_5;
  t.deepEqual(up.legs.map((l) => `${l.from}>${l.to} ${l.asset}`).sort(), ["0005>0008 player:13130", "0008>0005 player:14104"]);
  t.equal(up.date, "2024-07-24"); t.equal(up.date_quality, "recorded");
  t.deepEqual(pri.legs.map((l) => `${l.from}>${l.to} ${l.asset}`).sort(), ["0005>0006 player:14104", "0006>0005 fpick:0006:2026:3", "0006>0005 spick:2025:1:8"]);
  t.deepEqual(pri.cap.map((c) => [c.from, c.to, c.amount]), [["0005", "0006", 20000]]);
  t.equal(pri.date, "2025-03-05"); t.equal(pri.time, "13:18:22");
});

test("pilot: Brown's possession periods and production for 0005 (confirmed view)", () => {
  const brown = nodeOf("player:14104");
  t.deepEqual(brown.chain.holders.map((h) => h.franchise), ["0008", "0005", "0006"]);
  const s24 = brown.economics.seasons.find((s) => s.season === 2024).by_franchise.find((f) => f.franchise === "0005");
  t.equal(s24.points_verified, 239.1); t.equal(s24.weeks_verified, 13); t.deepEqual(s24.disputed_weeks, []);
  const c24 = brown.economics.seasons.find((s) => s.season === 2024).contract_by_roster_weeks.find((c) => c.franchise === "0005");
  t.equal(c24.salary, 19000); t.equal(c24.contract_status, "BL");
  const c25 = brown.economics.seasons.find((s) => s.season === 2025).contract_by_roster_weeks.find((c) => c.franchise === "0006");
  t.equal(c25.salary, 73000);
  t.deepEqual(brown.economics.seasons.find((s) => s.season === 2024).weeks_with_scoring_row, [1, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17], "weeks 2 to 5 have no scoring row and are never filled with zero");
});

test("pilot: the 2025 slot picks are CONFIRMED from MFL slot tokens and MFL draft results; the Judkins branch is traced trade by trade", () => {
  const p = nodeOf("spick:2025:1:8");
  t.equal(p.resolution.class, CLASS.CONFIRMED); t.equal(p.resolution.rule, RULES.SLOT_TOKEN_DRAFT_RESULT);
  t.equal(p.resolution.selection.player_id, "17051"); t.equal(p.resolution.selection.franchise, "0005"); t.equal(p.resolution.holder_at_selection, "0005");
  t.deepEqual(p.chain.holders.map((h) => h.franchise), ["0006", "0005"]);
  const j = nodeOf("player:17051");
  t.deepEqual(j.chain.holders.map((h) => h.franchise), ["0005", "0010"]);
  t.equal(j.transfers[0].trade, "trade2025_34");
  t.deepEqual(j.transfers[0].consideration.sort(), ["fpick:0007:2026:2", "fpick:0010:2026:2", "player:16644"]);
  const r3 = nodeOf("spick:2025:3:8");
  t.deepEqual(r3.chain.holders.map((h) => h.franchise), ["0004", "0005", "0001", "0011"], "the draft-day hand-offs are kept");
  t.equal(r3.resolution.selection.player_id, "17108");
  t.equal(nodeOf("player:17106").role, "drafted_player");
});

test("pilot: no 2026 pick is resolved: custody crosses 2025-11-28 to 2026-03-07, so uniqueness is not proof; candidates count for nothing", () => {
  for (const id of ["fpick:0010:2026:2", "fpick:0007:2026:2", "fpick:0006:2026:3"]) {
    const n = nodeOf(id);
    t.equal(n.resolution.class, CLASS.UNRESOLVED, id); t.equal(n.resolution.slot, null); t.equal(n.became, undefined);
    t.ok(n.resolution.coverage_gaps.some((g) => g.from === "2025-11-28" && g.to === "2026-03-07"), `${id} crosses the named gap`);
    t.ok(n.resolution.candidate_slots.length >= 1);
  }
  t.deepEqual(nodeOf("fpick:0006:2026:3").resolution.candidate_slots.map((c) => c.slot), [3, 4, 6]);
  t.deepEqual(bundle.views.inferred_assets, []);
  t.deepEqual(bundle.views.unresolved_links.sort(), ["fpick:0006:2026:3#slot", "fpick:0007:2026:2#slot", "fpick:0010:2026:2#slot"]);
  t.ok(confirmedTotals(bundle, "0005").excluded_assets.length === 0, "no player came from an unresolved link");
});

test("pilot: the named gap, the chain breaks and the horizons are listed; final positions agree with the latest roster snapshot", () => {
  const g = bundle.gaps[0];
  t.equal(g.kind, "incomplete_trade_coverage"); t.equal(g.from, "2025-11-28"); t.equal(g.to, "2026-03-07"); t.equal(g.last_archive_trade, "2025-11-27"); t.equal(g.last_archive_transaction, "2025-12-29");
  t.equal(g.first_snapshot_transaction_et, "2026-03-07 19:13:45");
  t.ok(bundle.gaps.some((x) => x.kind === "implicit_release" && x.asset === "player:13130"), "McCaffrey's auction add by 0004 follows no recorded release by 0008");
  t.ok(bundle.gaps.some((x) => x.kind === "points_horizon") && bundle.gaps.some((x) => x.kind === "salary_horizon") && bundle.gaps.some((x) => x.kind === "owner_identity_not_asserted"));
  for (const n of bundle.nodes.filter((x) => x.kind === "player")) t.equal(n.final_position.consistent, true, n.id);
  t.equal(bundle.coverage.historical_pattern.december_trades.length, 1);
});

// ── engine unit tests ─────────────────────────────────────────────────────────────────────────────
test("tokens: players, future picks, slot picks (zero-indexed round and slot become one-indexed), cap money, unknowns", () => {
  const a = parseTokens("16186,FP_0006_2027_1,DP_2_7,BB_18000,XX_9,", 2026);
  t.deepEqual(a.map((x) => x.kind), ["player", "future_pick", "slot_pick", "cap", "unknown"]);
  t.equal(a[1].id, futurePickAsset("0006", 2027, 1)); t.equal(a[2].id, slotPickAsset(2026, 3, 8)); t.equal(a[3].amount, 18000);
  t.equal(etParts(1741198702).date, "2025-03-05"); t.equal(etParts(1741198702).time, "13:18:22");
});

test("the archive stores a current-pick slot zero-indexed in the column named overall; the loader makes it one-indexed (pick 1.08 is stored 7)", () => {
  const r = archive.get("select asset_draftpick_round r, asset_draftpick_overall ov, asset_draftpick_roundorder ro from transactions_trades where trade_group_id = 'trade2025_5' and asset_type = 'DRAFTPICK_CURRENT' limit 1");
  t.equal(r.r, 1); t.equal(r.ov, 7); t.equal(r.ro, null);
  const led = buildLedger({ archive, root: ROOT });
  t.ok(led.tradesByAsset.has("spick:2025:1:8"));
  t.equal(led.archiveTrades.length, 1036); t.equal(led.archiveTrades.filter((x) => x.legs.some((l) => l.unpaired)).length, 0);
});

test("chains: a draft selection starts a stint; a sender who is not the holder is a listed discontinuity; an add by another franchise is a listed implicit release", () => {
  const led = buildLedger({ archive, root: ROOT });
  const judkins = playerChain(led, "17051");
  t.deepEqual(judkins.events.map((e) => e.kind), ["draft_selection", "trade"]);
  t.deepEqual(judkins.breaks, []);
  const swift = playerChain(led, "14797", { sinceTs: 1759000000 });
  t.ok(swift.breaks.some((b) => b.kind === "implicit_release" && b.holder_before === "0005" && b.added_by === "0002"));
  // a synthetic discontinuity: a record whose sender is not the holder the previous record leaves
  const fake = { tradesByAsset: new Map([["player:1", [{ trade: { id: "a", ts: 10, date: "2020-01-01", time: "00:00:00", source: {}, date_quality: "recorded" }, leg: { from: "0001", to: "0002" } }, { trade: { id: "b", ts: 20, date: "2020-01-02", time: "00:00:00", source: {}, date_quality: "recorded" }, leg: { from: "0003", to: "0004" } }]]]), selByPlayer: new Map(), addDrops: new Map() };
  const c = playerChain(fake, "1");
  t.equal(c.breaks.length, 1); t.equal(c.breaks[0].kind, "discontinuity"); t.equal(c.breaks[0].expected_holder, "0002"); t.equal(c.breaks[0].recorded_sender, "0003");
  t.equal(holderAt(c, 15), "0002");
});

test("slot picks: a draft result for a different franchise than the chain leaves is a conflict, never confirmed", () => {
  const led = buildLedger({ archive, root: ROOT });
  const chain = pickChain(led, "spick:2025:1:8");
  const ok = resolveSlotPick(led, chain, 2025, 1, 8);
  t.equal(ok.class, CLASS.CONFIRMED);
  const bad = resolveSlotPick({ ...led, selBySlot: new Map([["2025:1:8", { ...ok.selection, franchise: "0009" }]]) }, chain, 2025, 1, 8);
  t.equal(bad.class, CLASS.UNRESOLVED); t.equal(bad.conflict, true); t.match(bad.reason, /records franchise 0009/);
  t.equal(resolveSlotPick({ ...led, selBySlot: new Map() }, chain, 2025, 1, 8).class, CLASS.UNRESOLVED);
});

test("UNIQUE_HOLDER_V1: INFERRED only with every condition; the label, the rule and the alternatives are recorded; an inferred pick adds nothing to confirmed totals", () => {
  const draftTs = 1590000000;
  const res = (opts) => { const led = syntheticLedger({ year: 2020, round: 2, draftTs, ...opts }); return resolveFuturePick(led, syntheticChain(led, "0001", 2020, 2), { year: 2020, round: 2, original: "0001" }, { slotLists: [] }); };
  const uniq = { "0001": "0007", "0007": "0002" };
  const one = res({ holdings: uniq });
  t.equal(one.class, CLASS.INFERRED); t.equal(one.rule, RULES.UNIQUE_HOLDER_V1); t.equal(one.slot, 1); t.match(one.disclosure, /inferred, never confirmed/); t.equal(one.status_for_totals, undefined); t.equal(one.inventory.complete, true);
  const two = res({ holdings: { "0001": "0007" } });
  t.equal(two.class, CLASS.UNRESOLVED); t.deepEqual(two.candidates.map((c) => c.slot), [1, 7]); t.equal(two.slot, undefined);
  const gapped = res({ holdings: uniq, windows: [{ from: "2019-12-01", to: "2020-02-01", kind: "unobserved", basis: "test" }] });
  t.equal(gapped.class, CLASS.UNRESOLVED); t.equal(gapped.coverage_gaps.length, 1);
  // incomplete inventory (MAT-2): one candidate is not enough when the round is not shown to be complete
  const short = res({ holdings: uniq, omitSlots: [12] });
  t.equal(short.class, CLASS.UNRESOLVED); t.equal(short.inventory.complete, false); t.match(short.reason, /not demonstrably complete/); t.match(short.reason, /11 slot/);
  const disagree = res({ holdings: uniq, slotHolder: { 5: "0007" } });
  t.equal(disagree.class, CLASS.UNRESOLVED); t.match(disagree.reason, /disagree/);
  const slotTok = res({ holdings: uniq, slotTokenTransfer: true });
  t.equal(slotTok.class, CLASS.UNRESOLVED); t.match(slotTok.reason, /slot-token transfer/);
  // the reconciliation uses each pick's holder ON the evidence date: a transfer after it must not make a complete round look incomplete
  const lateLed = syntheticLedger({ year: 2020, round: 2, draftTs, holdings: uniq });
  lateLed.tradesByAsset.set("fpick:0003:2020:2", [{ trade: { id: "late", ts: draftTs + 86400, date: "2020-06-02", time: "12:00:00", source: { kind: "synthetic" }, date_quality: "exact" }, leg: { from: "0003", to: "0009", rows: null } }]);
  const lateRes = resolveFuturePick(lateLed, syntheticChain(lateLed, "0001", 2020, 2), { year: 2020, round: 2, original: "0001" }, { slotLists: [] });
  t.equal(lateRes.class, CLASS.INFERRED, "a transfer after the evidence date is not part of that date's inventory");
  const noTeams = (() => { const led = syntheticLedger({ year: 2020, round: 2, draftTs, holdings: uniq }); delete led.franchisesFor; return resolveFuturePick(led, syntheticChain(syntheticLedger({ year: 2020, round: 2, draftTs, holdings: uniq }), "0001", 2020, 2), { year: 2020, round: 2, original: "0001" }, { slotLists: [] }); })();
  t.equal(noTeams.class, CLASS.UNRESOLVED); t.match(noTeams.reason, /team list/);
  const none = res({ holdings: { "0001": "0002", "0007": "0002" }, slotHolder: {} });
  t.equal(none.class, CLASS.UNRESOLVED);
  t.equal(resolveFuturePick({ selections: [], selBySlot: new Map(), windows: [], named_gap: { from: "9999-01-01", to: "9999-01-02" } }, syntheticChain(syntheticLedger({ year: 2020, round: 2, draftTs, holdings: uniq }), "0001", 2020, 2), { year: 2020, round: 2, original: "0001" }, { slotLists: [] }).class, CLASS.UNRESOLVED);
  // an inferred link never enters a confirmed-only total
  const mutated = JSON.parse(JSON.stringify(bundle)); mutated.nodes.find((n) => n.id === "player:17051").link_class = CLASS.INFERRED;
  t.ok(confirmedTotals(mutated, "0005").excluded_assets.includes("player:17051"));
  t.ok(confirmedTotals(mutated, "0005").points_verified <= confirmedTotals(bundle, "0005").points_verified);
});

test("coverage windows: the named gap and the data-driven offseason windows are found; a custody check across them reports them", () => {
  const led = buildLedger({ archive, root: ROOT });
  t.deepEqual({ from: led.named_gap.from, to: led.named_gap.to }, { from: "2025-11-28", to: "2026-03-07" });
  t.ok(led.windows.some((w) => w.from === "2024-12-31" && w.to === "2025-02-17"));
  const across = gapsBetween(led, Date.parse("2025-10-03T12:00:00Z") / 1000, Date.parse("2026-04-21T12:00:00Z") / 1000);
  t.ok(across.some((w) => w.kind === "incomplete_trade_coverage"));
  t.equal(gapsBetween(led, Date.parse("2025-03-06T12:00:00Z") / 1000, Date.parse("2025-03-19T12:00:00Z") / 1000).length, 0, "a short span inside an observed period is clean");
});

test("weeks: league weeks end at 16 through 2020 and 17 from 2021; the calendar kickoff rule equals the recorded 2024, 2025 and 2026 dates; copy weeks are excluded", () => {
  t.equal(lastLeagueWeek(2020), 16); t.equal(lastLeagueWeek(2021), 17); t.equal(lastLeagueWeek(2025), 17);
  const rec = kickoffDates(archive);
  for (const y of [2024, 2025, 2026]) t.equal(calendarKickoff(y), rec.get(y), String(y));
  const copy = archive.all("select count(*) n from player_weeklyscoringresults where season = 2025 and week > 17")[0].n;
  void copy;
  for (const n of bundle.nodes.filter((x) => x.kind === "player")) for (const s of n.economics.seasons) t.ok(s.weeks_with_scoring_row.every((w) => w >= 1 && w <= s.last_league_week), `${n.id} ${s.season}`);
  const swift = nodeOf("player:14797").economics.seasons[0].by_franchise.find((f) => f.franchise === "0010");
  t.ok(swift.weeks_outside_traced_window > 0 && swift.points_verified === 0, "weeks before the chain starts are outside the window, never verified");
});

// ── guards ────────────────────────────────────────────────────────────────────────────────────────
test("guard: the archive reader refuses every banned or unlisted table and anything but SELECT; the static scan catches each banned idea", () => {
  for (const tbl of BANNED_TABLES) t.throws(() => assertQueryAllowed(`select * from ${tbl}`), ArchiveGuardError, tbl);
  t.throws(() => assertQueryAllowed("select * from sqlite_master"), ArchiveGuardError);
  t.throws(() => assertQueryAllowed("delete from transactions_trades"), ArchiveGuardError);
  t.throws(() => assertQueryAllowed("select * from transactions_trades join standings on 1=1"), ArchiveGuardError);
  t.deepEqual(assertQueryAllowed("select a from transactions_trades t join rosters_weekly r on 1=1"), ["transactions_trades", "rosters_weekly"]);
  // MAT-1: every query form that can name a table is authorized, not only FROM and JOIN. trade_winning_team_analysis holds final_finish and is not on the allowlist.
  const known = ["trade_winning_team_analysis", "transactions_trades", "rosters_weekly", "players", "draftresults_combined"];
  const forms = [
    "select a.* from transactions_trades t, trade_winning_team_analysis a limit 1",
    "select * from transactions_trades t cross join trade_winning_team_analysis a",
    "select * from transactions_trades where trade_group_id in (select trade_group_id from trade_winning_team_analysis)",
    "select (select final_finish from trade_winning_team_analysis limit 1) x from transactions_trades",
    "select * from transactions_trades t left join (select * from trade_winning_team_analysis) a on 1=1",
    'select * from transactions_trades, "trade_winning_team_analysis"',
    "select * from transactions_trades,[trade_winning_team_analysis]",
    "select * from transactions_trades t natural join trade_winning_team_analysis",
    "select * from draftresults_combined",
    "with x as (select * from trade_winning_team_analysis) select * from x",
    "select * from transactions_trades; select * from trade_winning_team_analysis",
    "select * from pragma_table_info('players')",
    // MAT-1 round 2: a comment marker inside a string must not hide the rest of the statement, and strings and comments are recognized where they start
    "select '--' as marker, a.final_finish from trade_winning_team_analysis a limit 1",
    "select '/*' x, a.final_finish from trade_winning_team_analysis a /* */ limit 1",
    "select 'it''s --' x from transactions_trades t, trade_winning_team_analysis a",
    "select 1 from transactions_trades /* unterminated comment hides nothing from the guard , trade_winning_team_analysis",
    "select 1 from transactions_trades where x = 'unterminated , trade_winning_team_analysis",
    "select [a--b] from transactions_trades t, [trade_winning_team_analysis]",
  ];
  for (const f of forms) t.throws(() => assertQueryAllowed(f, known), ArchiveGuardError, f);
  t.deepEqual(assertQueryAllowed("select r.x, 'trade_winning_team_analysis' lit from transactions_trades t, rosters_weekly r -- standings", known), ["transactions_trades", "rosters_weekly"], "a banned name inside a string or a comment is not a table");
  t.deepEqual(assertQueryAllowed("select * from players where player_id in (select player_id from rosters_weekly)", known), ["players", "rosters_weekly"]);
  // the same forms through the real archive reader
  for (const f of forms) t.throws(() => archive.all(f), ArchiveGuardError, `archive: ${f}`);
  for (const bad of ["const a = standings;", "const x = row.final_finish;", "const f = 'finishes';", "const b = bracket;", "SLOT_BY_FINISH[1]", "const p = projectedOrder;", "const o = deriveDraftOrder();", "fetch('/api/historical-finishes')", "import x from '../worker/src/desk/tools/history_finishes.js';", "const s = seed;"]) t.ok(scanSource(bad).length > 0, bad);
  t.equal(scanSource("// standings in a comment are only words\nconst ok = 1;").length, 0, "comments are not code");
  t.equal(scanSource("const order = unit.round1DraftOrder;").length, 0, "MFL's own round-1 holder list is allowed");
  t.deepEqual(scanExtractionSources(path.join(ROOT, "scripts", "league_record", "s1")), []);
  t.ok(ALLOWED_TABLES.every((x) => !BANNED_TABLES.includes(x)));
});

test("guard: introducing a banned idea into an extraction module fails the scan (the build-failure requirement)", () => {
  // in memory first (needs no temporary directory): a module that derives a slot from a finish produces hits, a clean one produces none
  t.deepEqual(scanSource("export const a = 1;\n", "good.mjs"), []);
  const memHits = scanSource("export const slot = (finish) => 13 - finish; // derive a slot from standings\nexport const q = 'select final_finish from x';\n", "bad.mjs");
  t.ok(memHits.length >= 1 && memHits.every((h) => h.file === "bad.mjs"), JSON.stringify(memHits));
  // then through scanExtractionSources on a real directory, when the sandbox allows a temporary directory
  let tmp = null;
  try { tmp = fs.mkdtempSync(path.join(process.env.TMPDIR || "/tmp", "s1-guard-")); } catch (e) { if (e && (e.code === "EPERM" || e.code === "EACCES")) return; throw e; }
  fs.writeFileSync(path.join(tmp, "good.mjs"), "export const a = 1;\n");
  t.deepEqual(scanExtractionSources(tmp), []);
  fs.writeFileSync(path.join(tmp, "bad.mjs"), "export const slot = (finish) => 13 - finish; // derive a slot from standings\nexport const q = 'select final_finish from x';\n");
  const hits = scanExtractionSources(tmp);
  t.ok(hits.length >= 1 && hits.every((h) => h.file === "bad.mjs"), JSON.stringify(hits));
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("the archive is the pinned file, opened read-only, and the report states every class", () => {
  t.equal(bundle.sources.archive.sha256, ARCHIVE_GZ_SHA256);
  t.throws(() => archive.all("insert into transactions_trades select * from transactions_trades"), ArchiveGuardError);
  const report = renderReport(bundle, null);
  for (const w of ["CONFIRMED", "CALCULATED", "INFERRED", "UNRESOLVED", "2025-11-28 to 2026-03-07", "owner_identity: not_asserted", "Judkins", "Sinnott"]) t.ok(report.includes(w), w);
  t.equal(bundle.pilot.franchise, PILOT.franchise);
});

test("classes and the named gap are on every link and every crossing chain (MAT-3, MAT-4)", () => {
  const ok = (c) => Object.values(CLASS).includes(c);
  for (const n of bundle.nodes) {
    t.ok(n.chain.events.every((e) => ok(e.class) && e.source && e.source.kind), `${n.id} events`);
    t.ok(n.chain.holders.every((h) => ok(h.class)), `${n.id} holders`);
    t.ok(n.chain.breaks.every((b) => ok(b.class)), `${n.id} breaks`);
    t.ok(typeof n.named_gap.crosses === "boolean", `${n.id} gap flag`);
  }
  for (const tr of Object.values(bundle.trades)) t.ok(ok(tr.class) && tr.legs.every((l) => ok(l.class)) && tr.cap.every((c) => ok(c.class)), tr.id);
  // the four reported players and the three future picks all cross the unobserved period
  for (const id of ["player:14104", "player:17051", "player:16644", "player:13130", "fpick:0006:2026:3"]) t.equal(nodeOf(id).named_gap.crosses, true, id);
  // a slot pick selected in June 2025 does not cross it, and its possession ends at the selection
  const sp = nodeOf("spick:2025:1:8");
  t.equal(sp.named_gap.crosses, false); t.equal(sp.chain.holders.at(-1).to.kind, "draft_selection");
  // the report names every crossing chain
  const report = renderReport(bundle, null);
  for (const n of bundle.nodes.filter((x) => x.named_gap.crosses)) t.ok(report.includes(`(${n.id}): `), `report lists ${n.id}`);
  // MAT-3 round 2: a period ended only by another franchise's add is never CONFIRMED as a whole, and its departure is UNRESOLVED
  const swift = nodeOf("player:14797");
  const sw = swift.chain.holders.find((h) => h.franchise === "0005");
  t.equal(sw.to.kind, "add"); t.equal(sw.end_class, CLASS.UNRESOLVED); t.equal(sw.class, CLASS.UNRESOLVED); t.equal(sw.start_class, CLASS.CONFIRMED);
  t.ok(swift.departures.length >= 1 && swift.departures.every((d) => d.class === CLASS.UNRESOLVED));
  t.ok(swift.chain.breaks.some((b) => b.kind === "implicit_release" && b.class === CLASS.UNRESOLVED));
  // a period ended by the franchise's own trade out is CONFIRMED at both ends
  const brown0 = nodeOf("player:14104").chain.holders.find((h) => h.franchise === "0005");
  t.equal(brown0.class, CLASS.CONFIRMED);
  // a banned finish-bearing table cannot be reached by a comma join through the real reader
  t.throws(() => archive.all("select a.* from transactions_trades t, trade_winning_team_analysis a limit 1"), ArchiveGuardError);
});

await run("league_record_s1_pilot");
archive.close();
