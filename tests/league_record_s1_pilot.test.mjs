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
  const holder = "0007", lastTs = 1570000000, draftTs = 1590000000;
  const mk = (slots, windows = []) => syntheticLedger({ year: 2020, round: 2, slotsHeld: slots, draftTs, windows });
  const res = (ledger) => resolveFuturePick(ledger, syntheticChain(holder, lastTs), { year: 2020, round: 2, original: "0001" }, { slotLists: [] });
  const one = res(mk([{ slot: 3, holder }, { slot: 4, holder: "0002" }]));
  t.equal(one.class, CLASS.INFERRED); t.equal(one.rule, RULES.UNIQUE_HOLDER_V1); t.equal(one.slot, 3); t.match(one.disclosure, /inferred, never confirmed/); t.equal(one.status_for_totals, undefined);
  const two = res(mk([{ slot: 3, holder }, { slot: 9, holder }]));
  t.equal(two.class, CLASS.UNRESOLVED); t.deepEqual(two.candidates.map((c) => c.slot), [3, 9]); t.equal(two.slot, undefined);
  const gapped = res(mk([{ slot: 3, holder }], [{ from: "2019-12-01", to: "2020-02-01", kind: "unobserved", basis: "test" }]));
  t.equal(gapped.class, CLASS.UNRESOLVED); t.equal(gapped.coverage_gaps.length, 1);
  const none = res(mk([{ slot: 4, holder: "0002" }]));
  t.equal(none.class, CLASS.UNRESOLVED); t.match(none.reason, /owns no slot/);
  t.equal(resolveFuturePick({ selections: [], selBySlot: new Map(), windows: [], named_gap: { from: "9999-01-01", to: "9999-01-02" } }, syntheticChain(holder, lastTs), { year: 2020, round: 2, original: "0001" }, { slotLists: [] }).class, CLASS.UNRESOLVED);
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
  for (const bad of ["const a = standings;", "const x = row.final_finish;", "const f = 'finishes';", "const b = bracket;", "SLOT_BY_FINISH[1]", "const p = projectedOrder;", "const o = deriveDraftOrder();", "fetch('/api/historical-finishes')", "import x from '../worker/src/desk/tools/history_finishes.js';", "const s = seed;"]) t.ok(scanSource(bad).length > 0, bad);
  t.equal(scanSource("// standings in a comment are only words\nconst ok = 1;").length, 0, "comments are not code");
  t.equal(scanSource("const order = unit.round1DraftOrder;").length, 0, "MFL's own round-1 holder list is allowed");
  t.deepEqual(scanExtractionSources(path.join(ROOT, "scripts", "league_record", "s1")), []);
  t.ok(ALLOWED_TABLES.every((x) => !BANNED_TABLES.includes(x)));
});

test("guard: introducing a banned idea into an extraction module fails the scan (the build-failure requirement)", () => {
  const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR || "/tmp", "s1-guard-"));
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

await run("league_record_s1_pilot");
archive.close();
