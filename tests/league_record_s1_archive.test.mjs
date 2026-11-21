// League Record S1, Step 1b: tests of the 2010-2025 archive extraction. Offline and read-only: the committed archive only. Every count is re-derived here with separate SQL against the
// decompressed archive (a different code path from the extraction), representative older periods are checked trade by trade, and the standing rule (no slot from standings, finishes,
// brackets or a projected order) is tested at the guard, the source scan and the data.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { test, run, t } from "./fixtures/mini_test.mjs";
import { openArchive, assertQueryAllowed, ArchiveGuardError, memoryView, BANNED_COLUMNS, MEMORY_COLUMNS } from "../scripts/league_record/s1/archive.mjs";
import { scanExtractionSources } from "../scripts/league_record/s1/guard.mjs";
import { buildArchiveExtraction, FIRST_YEAR, LAST_YEAR } from "../scripts/league_record/s1/archive_extract.mjs";
import { renderArchiveReport } from "../scripts/league_record/s1/archive_report.mjs";
import { packageView, creditByAsset, ALLOCATION } from "../scripts/league_record/s1/packages.mjs";
import { buildLedger, pickChain, resolveSlotPick } from "../scripts/league_record/s1/lineage.mjs";
import { stableStringify } from "../scripts/league_record/s1/pilot.mjs";
import { classifyIntervals, buildCoverageModel, custodyObserved, validateVerification, coverageSummary, loadVerifications, COVERAGE_STATE } from "../scripts/league_record/s1/coverage.mjs";
import { resolveFuturePick } from "../scripts/league_record/s1/lineage.mjs";
import { etParts } from "../scripts/league_record/s1/sources.mjs";
import { loadArchiveSelections, loadKnownForfeitures, FORFEITURE_FILE, FORFEITURE_FIELDS, LEGACY_DEFECT } from "../scripts/league_record/s1/sources.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "docs", "league_record", "archive");
const archive = await openArchive({ root: ROOT });
const x = buildArchiveExtraction({ archive, root: ROOT });
const raw = new DatabaseSync(archive.dbPath, { readOnly: true });
const seasonOf = (y) => x.seasons.find((s) => s.season === y);
const q = (sql, ...p) => raw.prepare(sql).all(...p);

test("the committed extraction and report equal a fresh build (regenerate with scripts/league_record/s1/run_archive_extract.mjs)", () => {
  t.equal(fs.readFileSync(path.join(OUT, "extraction.json"), "utf8"), `${stableStringify(x)}\n`);
  t.equal(fs.readFileSync(path.join(OUT, "archive_report.md"), "utf8"), renderArchiveReport(x));
});

test("coverage by season equals separate SQL on the raw archive: trades, legs by kind, cap transfers and draft selections", () => {
  t.equal(x.seasons.length, LAST_YEAR - FIRST_YEAR + 1);
  for (const s of x.seasons) {
    const trades = q("select count(distinct trade_group_id) n from transactions_trades where season = ?", s.season)[0].n;
    t.equal(s.trades.count, trades, `${s.season} trades`);
    const by = Object.fromEntries(q("select asset_type t, count(*) n from transactions_trades where season = ? and asset_role = 'RELINQUISH' group by asset_type", s.season).map((r) => [r.t, r.n]));
    t.equal(s.trades.legs.player, by.PLAYER || 0, `${s.season} player legs`);
    t.equal(s.trades.legs.future_pick, by.DRAFTPICK_FUTURE || 0, `${s.season} future pick legs`);
    t.equal(s.trades.legs.slot_pick, by.DRAFTPICK_CURRENT || 0, `${s.season} slot pick legs`);
    t.equal(s.trades.cap.transfers, by.CAP || 0, `${s.season} cap transfers`);
    t.equal(s.trades.cap.total_amount, q("select coalesce(sum(asset_capadjustment), 0) n from transactions_trades where season = ? and asset_role = 'RELINQUISH' and asset_type = 'CAP'", s.season)[0].n, `${s.season} cap total`);
    const sel = q("select (select count(*) from draftresults_mfl where season = ?) + (select count(*) from draftresults_legacy where season = ?) n", s.season, s.season)[0].n;
    t.equal(s.draft.selections, sel, `${s.season} selections`);
    t.equal(s.trades.legs.unpaired + s.trades.legs.unknown, 0, `${s.season} no unpaired or unknown legs`);
  }
  t.equal(x.summary.trades, q("select count(distinct trade_group_id) n from transactions_trades where season between 2010 and 2025")[0].n);
});

test("representative older periods: 2012 (first draft), 2014 (legacy draft with the slot defect and the one conflict), 2018 (MFL draft table starts, one known forfeiture), 2022 (largest package)", () => {
  // 2012: sixty legacy selections, five rounds of twelve
  t.equal(seasonOf(2012).draft.selections, 60); t.equal(seasonOf(2012).draft.rounds, 5); t.equal(seasonOf(2012).draft.source_table, "draftresults_legacy");
  // the legacy slot defect: pick 1.10 of 2014 is stored with slot 1 and raw text "1.1"; MFL's overall pick number is 10
  const stored = q("select draftpick_roundorder ro, draftpick_overall ov, raw_pick rp, player_name n from draftresults_legacy where season = 2014 and draftpick_round = 1 and draftpick_overall = 10")[0];
  t.equal(stored.ro, 1); t.equal(stored.rp, "1.1"); t.equal(stored.n, "West, Terrance");
  const sels = loadArchiveSelections(archive).filter((s) => s.year === 2014 && s.round === 1);
  const ten = sels.find((s) => s.slot === 10);
  t.ok(ten && ten.player_name === "West, Terrance" && ten.slot_correction.stored_slot === 1 && ten.slot_correction.corrected_slot === 10 && ten.slot_correction.method.startsWith("slot = overall - 12"));
  t.equal(sels.filter((s) => s.slot === 1).length, 1, "slot 1 is no longer duplicated");
  t.equal(x.summary.legacy_slot_corrections, 30, "five rounds in each of six legacy years");
  for (const y of [2012, 2013, 2014, 2015, 2016, 2017]) t.deepEqual(seasonOf(y).draft.missing_slots, [], `${y} has every slot after the correction`);
  // the single conflict: 4.12 of 2014 was moved to 0004 by trade2014_4 but the draft result records 0006
  t.equal(x.findings.lists.slot_conflicts.length, 1);
  const c = x.findings.lists.slot_conflicts[0];
  t.deepEqual([c.asset, c.selector, c.chain_holder_at_selection, c.trades], ["spick:2014:4:12", "0006", "0004", ["trade2014_4"]]);
  t.deepEqual(q("select franchise_id f, asset_role r from transactions_trades where trade_group_id = 'trade2014_4' and asset_draftpick_round = 4 and asset_draftpick_overall = 11").map((r) => `${r.f}:${r.r}`).sort(), ["0004:ACQUIRE", "0008:RELINQUISH"]);
  t.equal(q("select franchise_id f from draftresults_legacy where season = 2014 and draftpick_round = 4 and draftpick_overall = 48")[0].f, "0006");
  // 2018: first season of MFL's own table; 4.12 has no selection in it and is a known forfeiture (commissioner clarification), not a missing record
  t.equal(seasonOf(2018).draft.source_table, "draftresults_mfl"); t.deepEqual(seasonOf(2018).draft.missing_slots, []); t.deepEqual(seasonOf(2018).draft.forfeited_slots.map((f) => f.slot), ["4.12"]);
  t.equal(q("select count(*) n from draftresults_mfl where season = 2018")[0].n, 71);
  // 2022: the largest package of the archive, trade2022_36, is kept as one package with every leg in its direction
  const rows = q("select franchise_id f, asset_role r, asset_type t from transactions_trades where trade_group_id = 'trade2022_36'");
  t.equal(rows.length, 106); t.equal(seasonOf(2022).trades.packages.assets_per_trade_max, rows.filter((r) => r.r === "RELINQUISH").length);
  const led = buildLedger({ archive, root: ROOT });
  const tr = led.trades.find((z) => z.id === "trade2022_36"); const pv = packageView(tr, () => null);
  t.equal(pv.package, true); t.equal(pv.sides.reduce((n, sd) => n + sd.sent.length + sd.cap_sent.length, 0), rows.filter((r) => r.r === "RELINQUISH").length);
  for (const sd of pv.sides) { t.equal(sd.allocation.status, ALLOCATION.NOT_ESTABLISHED); t.equal(creditByAsset(sd, 1000).total, 0, "no double credit in a 53-asset package"); }
});

test("slot picks: confirmed only when the chain holder made the selection; a draft row without a franchise id is never confirmed or called a conflict", () => {
  const led = buildLedger({ archive, root: ROOT });
  for (const s of x.seasons) {
    const sp = s.slot_picks;
    t.equal(sp.confirmed + sp.conflict + sp.selector_not_recorded + sp.no_draft_result, sp.assets_traded, `${s.season} classes add up`);
  }
  // a legacy row with no franchise id: 2012 has nine; the traded slot picks that land on them are selector_not_recorded
  const blank = q("select draftpick_round r, draftpick_roundorder ro, draftpick_overall ov from draftresults_legacy where season = 2012 and (franchise_id is null or franchise_id = '')");
  t.equal(blank.length, 9); t.equal(seasonOf(2012).draft.rows_without_franchise_id, 9);
  let found = 0;
  for (const b of blank) { const slot = b.ov - 12 * (b.r - 1); const asset = `spick:2012:${b.r}:${slot}`; if (!led.tradesByAsset.has(asset)) continue; const res = resolveSlotPick(led, pickChain(led, asset), 2012, b.r, slot); t.equal(res.selector_not_recorded, true, asset); t.equal(res.class, "UNRESOLVED"); t.ok(!res.conflict, asset); found += 1; }
  t.ok(found >= 1, "at least one traded slot pick lands on a row with no franchise id");
  t.equal(seasonOf(2012).slot_picks.selector_not_recorded, found);
  // every confirmed pick in the modern era (2018 on) is confirmed because the chain holder made the selection
  for (const y of [2019, 2022, 2025]) t.equal(seasonOf(y).slot_picks.confirmed, seasonOf(y).slot_picks.assets_traded);
});

test("future picks: none is CONFIRMED to a slot; INFERRED only under UNIQUE_HOLDER_V1; the strict rule infers nothing in the archive years, and the diagnostic funnel is monotone and labeled", () => {
  const f = x.summary.future_picks;
  t.equal(f.confirmed, 0); t.equal(f.inferred + f.unresolved, f.traded);
  for (const s of x.seasons) {
    const p = s.future_picks;
    t.equal(p.inferred + p.unresolved, p.assets_traded, `${s.season}`);
    t.equal(p.confirmed, 0);
    const fn = p.funnel;
    t.ok(fn.would_infer_if_windows_observed_and_tokens_netted <= Math.min(fn.inventory_complete_if_slot_tokens_netted, fn.single_candidate_slot), `${s.season} funnel is monotone`);
    t.ok(fn.traded === p.assets_traded);
    t.ok(fn.event_accounting_eligible_if_custody_verified <= p.assets_traded, `${s.season} event accounting evaluates at most the traded picks`);
  }
  t.equal(f.inferred, 0, "no archive-year future pick meets every condition under the approved rule");
  // event accounting is a diagnostic: it adds no link, and every pick it could evaluate still crosses at least one unverified interval
  t.equal(f.funnel.event_accounting_eligible_if_custody_verified, 122); t.equal(f.funnel.custody_observed_strict, 0);
  t.equal(f.event_accounting_blockers.holder_holds_several_picks, 343, "a franchise that holds several picks is never resolved");
  t.equal(f.event_accounting_windows_needed.length, 31, "unverified intervals across the whole rounds (a lower bound)"); t.ok(f.event_accounting_windows_needed.every((w) => w.kind === "unobserved"));
  // an eligible pick still rests on disclosed assumptions: 67 on the first-sender reading of a slot-token trail, 33 with several final slots, 115 with a token trade within a day of a selection
  t.equal(f.funnel.event_accounting_flag_first_sender_assumption, 67); t.equal(f.funnel.event_accounting_flag_holder_has_several_final_slots, 33); t.equal(f.funnel.event_accounting_flag_token_trade_within_24h_of_a_selection, 115);
  t.equal(f.funnel.event_accounting_eligible_without_flags, 1, "only one pick passes the screen with none of the three assumptions");
  t.equal(f.inferred, 0); t.equal(f.unresolved, 597);
  t.equal(f.funnel.custody_observed_strict, 0); t.equal(f.funnel.inventory_complete_strict, 0);
  // the diagnostic is reported as a diagnostic
  const rep = renderArchiveReport(x);
  t.match(rep, /DIAGNOSTICS/); t.match(rep, /not something this report assumes/);
});

test("trades are packages everywhere: every archive trade carries every leg in its direction, and no package credits one asset", () => {
  const led = buildLedger({ archive, root: ROOT });
  let multi = 0;
  for (const tr of led.archiveTrades.filter((z) => z.season >= FIRST_YEAR && z.season <= LAST_YEAR)) {
    const pv = packageView(tr, () => null);
    t.equal(pv.sides.reduce((n, sd) => n + sd.sent.length, 0), tr.legs.length, tr.id);
    t.equal(pv.sides.reduce((n, sd) => n + sd.cap_sent.length, 0), tr.cap.length, `${tr.id} cap`);
    for (const sd of pv.sides) { const c = creditByAsset(sd, 100); t.ok(c.total === 0 || (sd.allocation.status === ALLOCATION.ESTABLISHED && c.total === 100), tr.id); }
    if (pv.package) multi += 1;
  }
  t.equal(multi, x.summary.multi_asset_trades);
});

test("production is a sum over verified possession periods per franchise; it is never attached to a pick or a trade; 2012-2016 cannot be verified because no source names the weekly franchise", () => {
  const rows = x.production_by_franchise_season;
  t.equal(Math.round(rows.reduce((n, r) => n + r.points_verified, 0) * 10) / 10, Math.round(x.summary.production_points_verified * 10) / 10);
  for (const r of rows) t.ok(!("asset" in r) && !("trade" in r) && !("pick" in r), `${r.season} ${r.franchise}`);
  // 2012-2016: the scoring table's franchise column holds the placeholder FA and there is no weekly roster record, so nothing is verified
  for (const y of [2012, 2013, 2014, 2015, 2016]) { t.equal(seasonOf(y).production.weeks_verified, 0, String(y)); t.ok(seasonOf(y).production.weeks_without_franchise > 0, String(y)); }
  t.equal(q("select count(distinct roster_franchise_id) n from player_weeklyscoringresults where season = 2014")[0].n, 1);
  t.equal(q("select distinct roster_franchise_id f from player_weeklyscoringresults where season = 2014")[0].f, "FA");
  t.equal(q("select count(*) n from rosters_weekly where season between 2012 and 2016")[0].n, 0);
  // 2017-2019: the weekly roster record names the franchise, so weeks are verified
  for (const y of [2017, 2018, 2019]) { t.ok(seasonOf(y).production.weeks_verified > 1000, String(y)); t.ok(seasonOf(y).production.weeks_franchise_from_roster_record > 1000, String(y)); }
  // independent bounds from raw SQL for every 2020-2025 franchise-season: the verified points and weeks can never exceed the franchise's own scoring rows in MFL's weekly table
  for (const r of rows.filter((z) => z.season >= 2020 && /^\d{4}$/.test(z.franchise))) {
    const raw2 = q("select count(*) n, coalesce(sum(score), 0) pts from player_weeklyscoringresults where season = ? and roster_franchise_id = ? and week between 1 and ?", r.season, r.franchise, r.season >= 2021 ? 17 : 16)[0];
    t.ok(r.weeks_verified <= raw2.n, `${r.season} ${r.franchise} weeks`);
    t.ok(r.points_verified <= Math.round(raw2.pts * 10) / 10 + 0.1, `${r.season} ${r.franchise} points`);
  }
  const row = rows.find((r) => r.season === 2021 && r.franchise === "0005");
  t.ok(row && row.points_verified > 0 && row.weeks_verified > 0);
});

test("the copy used for the 2010-2025 extraction holds only the columns the extraction reads; owner names and rank columns never leave the archive; wildcards are refused", () => {
  const mem = memoryView(archive);
  for (const [tbl, cols] of Object.entries(MEMORY_COLUMNS)) {
    t.deepEqual(Object.keys(mem.all(`select ${cols.join(", ")} from ${tbl} limit 1`)[0]), cols, tbl);
    t.throws(() => mem.all(`select owner_name from ${tbl} limit 1`), ArchiveGuardError, `${tbl} owner_name`);
  }
  t.throws(() => mem.all("select * from rosters_weekly limit 1"), ArchiveGuardError);
  t.throws(() => mem.all("select r.* from rosters_weekly r limit 1"), ArchiveGuardError);
  t.throws(() => archive.all("select * from player_weeklyscoringresults limit 1"), ArchiveGuardError);
  t.throws(() => archive.all("select owner_name from player_weeklyscoringresults limit 1"), ArchiveGuardError);
  t.throws(() => archive.all("select pos_rank, overall_rank from player_weeklyscoringresults limit 1"), ArchiveGuardError);
  t.equal(mem.all("select count(*) n from rosters_weekly")[0].n, q("select count(*) n from rosters_weekly")[0].n, "count(*) is still allowed");
  const mc = new DatabaseSync(":memory:"); mc.close();
  mem.close();
  for (const f of ["archive_extract.mjs", "archive.mjs", "economics.mjs", "pilot.mjs", "lineage.mjs", "sources.mjs"]) { const src = fs.readFileSync(path.join(ROOT, "scripts", "league_record", "s1", f), "utf8"); t.ok(!/owner_name/.test(src.replace(/\/\/.*$/gm, "")) || f === "archive.mjs", `${f} never names the owner column`); }
});

test("the standing rule holds for the new code: no standings-derived slot, banned columns refused, the memory copy obeys the guard, and the source scan covers every new module", () => {
  t.deepEqual(scanExtractionSources(path.join(ROOT, "scripts", "league_record", "s1")), []);
  t.ok(BANNED_COLUMNS.includes("waiver_sort_order"));
  t.throws(() => archive.all("select waiver_sort_order from metadata_franchise"), ArchiveGuardError);
  t.throws(() => archive.all("select season, franchise_id, waiver_sort_order from metadata_franchise"), ArchiveGuardError);
  t.deepEqual(assertQueryAllowed("select season, franchise_id from metadata_franchise where season = 2014", ["metadata_franchise"]), ["metadata_franchise"]);
  t.equal(archive.all("select distinct franchise_id f from metadata_franchise where season = 2014").length, 12);
  const mem = memoryView(archive);
  t.throws(() => mem.all("select * from trade_winning_team_analysis"), ArchiveGuardError);
  t.throws(() => mem.all("select a.* from rosters_weekly a, standings b"), ArchiveGuardError);
  t.throws(() => mem.all("select waiver_sort_order from rosters_weekly"), ArchiveGuardError);
  t.equal(mem.all("select count(*) n from rosters_weekly")[0].n, q("select count(*) n from rosters_weekly")[0].n);
  mem.close();
  // the draft-slot source never reads a finish: the slot of every selection is MFL's own round pick number or the overall pick number
  const src = fs.readFileSync(path.join(ROOT, "scripts", "league_record", "s1", "sources.mjs"), "utf8");
  t.ok(/Number\(r\.overall\) - LEGACY_DEFECT\.teams \* \(Number\(r\.round\) - 1\)/.test(src), "the slot is derived from MFL's own overall pick number");
});

test("gaps and conflicts are listed, not repaired: the named gap, quiet windows, chain breaks and draft-table defects are all in the extraction", () => {
  t.deepEqual({ from: x.named_gap.from, to: x.named_gap.to }, { from: "2025-11-28", to: "2026-03-07" });
  t.ok(x.coverage_windows.length > 5);
  t.equal(x.findings.totals.pick_chain_discontinuities, x.summary.pick_chain_discontinuities);
  t.ok(x.summary.player_chain_breaks.implicit_release > 0 && x.summary.player_chain_breaks.discontinuity > 0);
  t.ok(x.findings.lists.player_chain_breaks.length <= x.findings.list_cap);
  t.equal(x.findings.totals.player_chain_breaks, x.summary.player_chain_breaks.discontinuity + x.summary.player_chain_breaks.implicit_release, "findings and summary count the same 2010-2025 breaks");
  t.ok(x.findings.outside_the_stated_period.player_chain_breaks_dated_after_2025 > 0, "breaks dated 2026 are disclosed apart, not mixed into the 2010-2025 counts");
  t.equal(x.findings.totals.draft_missing_source_records, 0, "no scheduled slot is missing a source record: the one slot without a selection is a known forfeiture");
  t.equal(x.findings.totals.known_forfeitures, 1);
  const rep = renderArchiveReport(x);
  for (const w of ["named source-coverage gap", "2025-11-28", "Quiet windows", "implicit releases", "selector not recorded", "slot_correction", "dated 2026"]) t.ok(rep.toLowerCase().includes(w.toLowerCase()), w);
  // era differences are in the report
  t.match(rep, /processing_time_likely/); t.match(rep, /draftresults_legacy/); t.match(rep, /draftresults_mfl/);
});

// ── known forfeitures: a scheduled slot with no selection, explained by a named provenance ───────────
test("2018 pick 4.12 is FORFEITED (commissioner clarification): the slot is kept, no player is attached, nothing beyond the clarification is invented", () => {
  const d = seasonOf(2018).draft;
  t.deepEqual(d.slot_status, { SELECTED: 71, FORFEITED: 1, UNRESOLVED: 0, MISSING_SOURCE_RECORD: 0 }, "71 recorded selections plus one known forfeiture, nothing unexplained");
  t.equal(d.selections, 71); t.equal(d.scheduled_slots, 72); t.equal(d.slot_status.SELECTED + d.slot_status.FORFEITED, d.scheduled_slots);
  t.deepEqual(d.missing_slots, []); t.deepEqual(d.overall_numbers_absent, [48], "MFL's own overall numbers: 47 and 49 recorded; 48 (4.12) is the scheduled slot with no selection");
  const [f] = d.forfeited_slots;
  t.deepEqual([f.slot, f.overall, f.reason, f.provenance, f.selected_player], ["4.12", 48, "owner violation", "commissioner clarification", null]);
  t.deepEqual(f.not_recorded, ["the particular violation", "the offending owner or franchise", "the penalty ruling date", "a supporting MFL transaction"]);
  // separate SQL: the draft table holds 71 rows, none for overall 48, none for round 4 slot 12
  t.equal(q("select count(*) n from draftresults_mfl where season = 2018")[0].n, 71);
  t.equal(q("select count(*) n from draftresults_mfl where season = 2018 and (draftpick_overall = 48 or (draftpick_round = 4 and draftpick_roundorder = 12))")[0].n, 0);
  t.deepEqual(q("select draftpick_overall ov from draftresults_mfl where season = 2018 and draftpick_overall in (47, 49) order by 1").map((r) => Number(r.ov)), [47, 49]);
  // no fabricated player: the ledger has no selection for the slot or for overall 48, and the forfeiture record carries no player
  const led = buildLedger({ archive, root: ROOT });
  t.equal(led.selBySlot.get("2018:4:12"), undefined); t.equal(led.selections.filter((z) => z.year === 2018 && (z.overall === 48 || (z.round === 4 && z.slot === 12))).length, 0);
  const rec = led.forfeitBySlot.get("2018:4:12");
  t.ok(rec && rec.selected_player === null && rec.status === "FORFEITED");
  for (const k of ["player", "player_id", "player_name", "franchise", "franchise_id", "owner", "violation", "ruling_date", "penalty_date", "transaction", "transaction_id"]) t.ok(!(k in rec), `the record has no ${k} field`);
  // the committed file holds exactly the allowed fields
  const file = JSON.parse(fs.readFileSync(path.join(ROOT, FORFEITURE_FILE), "utf8"));
  t.equal(file.records.length, 1); for (const r of file.records) t.deepEqual(Object.keys(r).filter((k) => !FORFEITURE_FIELDS.includes(k)), []);
  // the report counts it as a forfeiture, never as a missing result
  const rep = renderArchiveReport(x);
  t.match(rep, /\*\*1 FORFEITED\*\*/); t.match(rep, /\*\*0 MISSING_SOURCE_RECORD\*\*/); t.match(rep, /\| 2018 \|[^\n]*\| 71 \| 1 \(4\.12\) \| 72 \|/);
  t.match(rep, /2018 pick 4\.12 \(overall 48\): reason "owner violation", provenance: commissioner clarification/);
  t.ok(!/MISSING_DRAFT_RESULT/.test(rep) && !/MISSING_DRAFT_RESULT/.test(JSON.stringify(x)));
  const missingLine = rep.split("\n").find((l) => l.startsWith("- **Draft slots with no selection and no known forfeiture"));
  t.ok(missingLine && /MISSING_SOURCE_RECORD \(0\):\*\* none\./.test(missingLine) && !/4\.12/.test(missingLine.split("**Slots with more than one row")[0]), "the missing-record line lists nothing for 2018");
});

test("an absence is never called a forfeiture without a source: with no forfeiture record the same slot is a MISSING_SOURCE_RECORD, and a forfeiture that contradicts the sources is refused", () => {
  const without = buildArchiveExtraction({ archive, root: ROOT, forfeitures: [] });
  const d = without.seasons.find((s) => s.season === 2018).draft;
  t.deepEqual(d.slot_status, { SELECTED: 71, FORFEITED: 0, UNRESOLVED: 0, MISSING_SOURCE_RECORD: 1 }); t.deepEqual(d.missing_slots, ["4.12"]);
  t.equal(without.findings.totals.draft_missing_source_records, 1); t.equal(without.findings.totals.known_forfeitures, 0);
  // the other seasons are the same with or without the record: only the one sourced slot changes status
  for (const s of x.seasons) if (s.season !== 2018) t.deepEqual(without.seasons.find((z) => z.season === s.season).draft.slot_status, s.draft.slot_status, `${s.season} unchanged`);
  const rec = (over) => [{ season: 2018, round: 4, slot: 12, overall: 48, status: "FORFEITED", reason: "owner violation", provenance: "commissioner clarification", clarification_recorded_on: "2026-11-21", scheduled_slot_basis: "test", not_recorded: [], ...over }];
  // a forfeiture beside a recorded selection for the same slot is a contradiction
  t.throws(() => buildLedger({ archive, root: ROOT, forfeitures: rec({ season: 2019, round: 3, slot: 5, overall: 29 }) }), /contradict/);
  // a slot that is not on the scheduled grid, a season with no draft results, a wrong overall number are refused by the extraction
  t.throws(() => buildArchiveExtraction({ archive, root: ROOT, forfeitures: rec({ round: 7, overall: 84 }) }), /not a scheduled slot/);
  t.throws(() => buildArchiveExtraction({ archive, root: ROOT, forfeitures: rec({ overall: 49 }) }), /not a scheduled slot/);
  t.throws(() => buildArchiveExtraction({ archive, root: ROOT, forfeitures: rec({ season: 2011 }) }), /no draft results/);
});

test("the forfeiture file accepts only what its provenance supplies: an added violation, owner, franchise, ruling date, transaction or player is refused", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "s1_forfeit_"));
  try {
    const write = (records) => { fs.mkdirSync(path.join(dir, "docs", "league_record"), { recursive: true }); fs.writeFileSync(path.join(dir, FORFEITURE_FILE), JSON.stringify({ schema: "ups.league_record.known_forfeitures/1", records })); return () => loadKnownForfeitures(dir); };
    const ok = { season: 2018, round: 4, slot: 12, overall: 48, status: "FORFEITED", reason: "owner violation", provenance: "commissioner clarification", clarification_recorded_on: "2026-11-21", scheduled_slot_basis: "x", not_recorded: [] };
    t.equal(write([ok])().length, 1);
    for (const extra of [{ player_id: "13000" }, { player_name: "A, B" }, { franchise_id: "0001" }, { owner: "x" }, { violation: "x" }, { ruling_date: "2018-08-01" }, { transaction_id: "t1" }]) t.throws(write([{ ...ok, ...extra }]), /not allowed/, Object.keys(extra)[0]);
    t.throws(write([{ ...ok, status: "SELECTED" }]), /status must be FORFEITED/);
    t.throws(write([{ ...ok, provenance: "" }]), /provenance is required/);
    t.throws(write([{ ...ok, reason: "" }]), /reason is required/);
    t.throws(write([ok, ok]), /recorded twice/);
    t.equal(loadKnownForfeitures(path.join(dir, "nowhere")).length, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("a forfeited slot is not a draft result: a traded slot pick on it is not CONFIRMED, and the future picks of its round are not reconciled against a holder nobody recorded", () => {
  const forfeit = { season: 2018, round: 4, slot: 12, reason: "owner violation", provenance: "commissioner clarification" };
  const res = resolveSlotPick({ selBySlot: new Map(), forfeitBySlot: new Map([["2018:4:12", forfeit]]) }, { holders: [], events: [] }, 2018, 4, 12);
  t.equal(res.forfeited, true); t.equal(res.selection, null); t.ok(res.class !== "CONFIRMED"); t.match(res.reason, /forfeited/);
  const none = resolveSlotPick({ selBySlot: new Map(), forfeitBySlot: new Map() }, { holders: [], events: [] }, 2018, 4, 12);
  t.ok(!none.forfeited && /no draft result/.test(none.reason), "without a forfeiture record the same slot is only 'no draft result'");
  // the 2018 round 4 future picks: blocked because the round has a forfeited slot, no longer miscounted as a round with eleven slots
  const fp = seasonOf(2018).future_picks;
  const traded = q("select count(distinct asset_draftpick_future_franchiseid) n from transactions_trades where asset_type = 'DRAFTPICK_FUTURE' and asset_role = 'RELINQUISH' and asset_draftpick_future_year = 2018 and asset_draftpick_future_round = 4")[0].n;
  t.ok(traded > 0 && fp.inventory_blockers.forfeited_slot_in_round > 0, "2018 round 4 future picks were traded and each names the forfeited slot as a blocker");
  t.equal(fp.inventory_blockers.slot_count_not_one_per_team, 0);
  t.equal(x.summary.future_picks.inferred, 0); t.equal(x.summary.future_picks.unresolved, x.summary.future_picks.traded);
});

test("the 2014 pick 4.12 selector conflict is a different record: still a conflict, still SELECTED, and the 2018 forfeiture is not applied to it", () => {
  t.equal(x.findings.lists.slot_conflicts.length, 1);
  const c = x.findings.lists.slot_conflicts[0];
  t.deepEqual([c.asset, c.draft_year, c.selector, c.chain_holder_at_selection], ["spick:2014:4:12", 2014, "0006", "0004"]);
  t.deepEqual(seasonOf(2014).draft.slot_status, { SELECTED: 60, FORFEITED: 0, UNRESOLVED: 0, MISSING_SOURCE_RECORD: 0 }); t.deepEqual(seasonOf(2014).draft.forfeited_slots, []);
  t.equal(seasonOf(2014).slot_picks.conflict, 1); t.equal(seasonOf(2014).slot_picks.forfeited_slot, 0);
  const led = buildLedger({ archive, root: ROOT });
  t.deepEqual([...led.forfeitBySlot.keys()], ["2018:4:12"], "the only known forfeiture is 2018 4.12");
  const sel = led.selBySlot.get("2014:4:12"); t.ok(sel && sel.player_id && sel.franchise === "0006", "2014 4.12 has a recorded selection by 0006");
  // the investigation record exists, is pointed to from the report, and keeps the two records apart
  const doc = fs.readFileSync(path.join(ROOT, "docs", "league_record", "S1_CONFLICT_2014_4_12.md"), "utf8");
  t.match(doc, /different record/); t.match(doc, /not resolved/); t.match(doc, /none chosen/);
  t.match(renderArchiveReport(x), /S1_CONFLICT_2014_4_12\.md[^\n]*different record from the 2018 forfeiture/);
  // separate SQL: the facts the record states about the trade and the draft row
  t.deepEqual(q("select franchise_id f, asset_role r from transactions_trades where trade_group_id = 'trade2014_4' and asset_type = 'DRAFTPICK_CURRENT' and asset_draftpick_round = 4 and asset_draftpick_overall = 11 order by 2").map((r) => `${r.f}:${r.r}`), ["0004:ACQUIRE", "0008:RELINQUISH"]);
  t.equal(q("select count(*) n from draftresults_legacy where season = 2014 and franchise_id = '0004'")[0].n, 0, "0004 made no selection in 2014");
  t.equal(q("select count(*) n from draftresults_legacy d join metadata_franchise m on m.season = d.season and m.franchise_id = d.franchise_id where d.franchise_id is not null and m.franchise_name != d.raw_franchise")[0].n, 0, "every legacy draft row's franchise name matches the name of its id for the season");
});

test("the legacy slot correction (approved 2026-11-21) applies only to the documented defect and keeps its provenance", () => {
  // separate SQL: the rows the documented pattern describes (legacy table, 2012-2017, stored slot 1, raw text "<round>.1", overall pick = 12 x (round - 1) + 10)
  const expected = q("select season, draftpick_round r, draftpick_overall o, raw_pick rp, raw_overall ro from draftresults_legacy where season between 2012 and 2017 and draftpick_round between 1 and 5 and draftpick_roundorder = 1 and raw_pick = draftpick_round || '.1' and draftpick_overall = 12 * (draftpick_round - 1) + 10 order by season, r");
  t.equal(expected.length, 30);
  const fixed = loadArchiveSelections(archive).filter((s) => s.slot_correction);
  t.equal(fixed.length, 30);
  t.deepEqual(fixed.map((s) => `${s.year}:${s.round}:${s.overall}`).sort(), expected.map((r) => `${r.season}:${r.r}:${r.o}`).sort(), "exactly the rows the documented pattern describes");
  for (const s of fixed) {
    const c = s.slot_correction;
    t.equal(c.stored_slot, 1); t.equal(c.corrected_slot, 10); t.equal(s.slot, 10); t.equal(c.defect, LEGACY_DEFECT.id); t.equal(c.method, LEGACY_DEFECT.method);
    t.deepEqual(c.source_reference, { table: "draftresults_legacy", season: s.year, round: s.round, overall: s.overall, raw_pick: `${s.round}.1`, raw_overall: String(s.overall) });
    t.equal(s.source.table, "draftresults_legacy");
  }
  // nothing else disagrees with its overall pick number: no unexplained mismatch in the archive, and the MFL table (2018 onward) has none either
  t.equal(x.summary.legacy_slot_mismatches_unexplained, 0);
  t.equal(q("select count(*) n from draftresults_mfl where draftpick_overall - 12 * (draftpick_round - 1) != draftpick_roundorder")[0].n, 0);
  t.equal(loadArchiveSelections(archive).filter((s) => s.source.table === "draftresults_mfl" && s.slot_correction).length, 0, "the MFL table is never corrected");
  // the committed extraction lists all thirty with their provenance
  t.equal(x.findings.totals.legacy_slot_corrections, 30); t.equal(x.findings.lists.legacy_slot_corrections.length, 30);
  t.deepEqual(Object.keys(x.findings.lists.legacy_slot_corrections[0]).sort(), ["corrected_slot", "method", "overall", "round", "season", "source_reference", "stored_slot"]);
  // a stub archive: every other disagreement is left as stored and reported, never corrected
  const row = (over) => ({ season: 2014, round: 1, slot: 1, overall: 10, f: "0001", pid: "1", pname: "X", ts: 1, d: "2014-06-15", note: "", raw_pick: "1.1", raw_overall: "10", ...over });
  const stub = (legacy, mfl = []) => ({ all: (sql) => (sql.includes("draftresults_legacy") ? legacy : mfl) });
  const run1 = (over, mfl) => loadArchiveSelections(stub([row(over)], mfl)).find((s) => s.source.table === "draftresults_legacy");
  const ok = run1({}); t.equal(ok.slot, 10); t.ok(ok.slot_correction, "the documented pattern is corrected");
  for (const [label, over] of [["a season outside 2012-2017", { season: 2018 }], ["a stored slot other than 1", { slot: 3, raw_pick: "1.3" }], ["raw text that is not the dropped-zero form", { raw_pick: "1.01" }],
    ["a round beyond the five legacy rounds", { round: 6, overall: 70, raw_pick: "6.1", raw_overall: "70" }], ["a derived slot other than 10", { overall: 11, raw_overall: "11" }], ["a derived slot outside 1-12", { overall: 40, raw_overall: "40" }]]) {
    const r = run1(over); t.ok(!r.slot_correction, `${label}: not corrected`); t.ok(r.slot_mismatch_unexplained, `${label}: reported as an unexplained mismatch`); t.equal(r.slot, over.slot || 1, `${label}: slot left as stored`);
  }
  const m = loadArchiveSelections(stub([], [{ season: 2019, round: 1, slot: 1, overall: 10, f: "0001", pid: "1", pname: "X", ts: 1, d: "2019-06-15", note: "" }])).find((s) => s.source.table === "draftresults_mfl");
  t.ok(!m.slot_correction && !m.slot_mismatch_unexplained && m.slot === 1, "an MFL-table row is never touched");
});

test("the source-coverage model (decision of 2026-11-21): four things kept apart, a quiet period is not a coverage state, nothing relaxes without a valid verification", () => {
  // today's archive: no verification record exists, so every quiet window is UNVERIFIED and the named gap is a KNOWN_GAP (separate SQL recomputes the windows)
  const dates = q("select distinct date_et d from transactions_base where date_et is not null order by 1").map((r) => r.d);
  const dn = (d) => Math.floor(Date.parse(`${d}T00:00:00Z`) / 86400000);
  let quiet = 0, quietDays = 0; for (let i = 1; i < dates.length; i++) { const gap = dn(dates[i]) - dn(dates[i - 1]); if (gap >= 14) { quiet += 1; quietDays += gap - 1; } }
  const cov = x.summary.coverage;
  t.equal(loadVerifications(ROOT).length, 0, "the registry is empty"); t.equal(cov.verification_records, 0);
  t.deepEqual(cov.by_state, { VERIFIED_COMPLETE: 0, UNVERIFIED: quiet, KNOWN_GAP: 1 }); t.equal(cov.days_by_state.UNVERIFIED, quietDays); t.equal(cov.days_by_state.KNOWN_GAP, 100, "2025-11-28 to 2026-03-07");
  t.equal(cov.named_gap_state, "KNOWN_GAP"); t.equal(x.coverage_windows.length, quiet, "every quiet window is classified");
  t.ok(x.coverage_windows.every((w) => w.state === "UNVERIFIED"));
  // a verification record is accepted only when every condition holds
  const good = { id: "v1", event_class: "pick_transfer", from: "2020-01-10", to: "2020-03-16", source: { kind: "mfl_export", type: "transactions", year: 2019, league_id: "74598", params: "TYPE=transactions&TRANS_TYPE=*", captured_on: "2026-12-01", truncated: false },
    checks: [{ kind: "archive_comparison", passed: true, ref: "r1" }, { kind: "end_state_reconciliation", passed: true, ref: "r2" }] };
  t.ok(validateVerification(good).ok, "a complete record is valid");
  const bad = (over) => validateVerification({ ...good, ...over });
  for (const [label, rec] of [["unknown event class", bad({ event_class: "contract" })], ["reversed dates", bad({ from: "2020-04-01" })], ["not an MFL export", bad({ source: { ...good.source, kind: "forum_post" } })],
    ["truncated response", bad({ source: { ...good.source, truncated: true } })], ["COUNT parameter", bad({ source: { ...good.source, params: "TYPE=transactions&COUNT=100" } })], ["DAYS parameter", bad({ source: { ...good.source, params: "TYPE=transactions&DAYS=30" } })],
    ["captured before the interval ends", bad({ source: { ...good.source, captured_on: "2020-03-01" } })], ["a failed check", bad({ checks: [...good.checks, { kind: "end_state_reconciliation", passed: false }] })],
    ["no archive comparison", bad({ checks: [{ kind: "chain_continuity", passed: true, ref: "x" }, { kind: "end_state_reconciliation", passed: true, ref: "y" }] })], ["no independent corroboration", bad({ checks: [{ kind: "archive_comparison", passed: true, ref: "x" }] })],
    ["comparison and chain continuity only: both come from MFL's own log", bad({ checks: [{ kind: "archive_comparison", passed: true, ref: "x" }, { kind: "chain_continuity", passed: true, ref: "y" }] })], ["no league id", bad({ source: { ...good.source, league_id: undefined } })],
    ["no instance year", bad({ source: { ...good.source, year: undefined } })], ["an interval outside the instance year and the next", bad({ source: { ...good.source, year: 2015 } })], ["a check with no evidence reference", bad({ checks: [{ kind: "archive_comparison", passed: true }, { kind: "end_state_reconciliation", passed: true, ref: "y" }] })],
    ["a leading ?COUNT parameter", bad({ source: { ...good.source, params: "COUNT=5&TYPE=transactions" } })],
    ["unknown check kind", bad({ checks: [...good.checks, { kind: "vibes", passed: true }] })], ["no object", validateVerification(null)],
    ["an impossible date", bad({ to: "2020-02-30" })], ["a non-string date", bad({ from: new Date("2020-01-10") })], ["no recorded parameters", bad({ source: { ...good.source, params: undefined } })],
    ["a duplicated check kind", bad({ checks: [...good.checks, { kind: "archive_comparison", passed: true }] })], ["a null check", bad({ checks: [...good.checks, null] })], ["checks that are not an array", bad({ checks: "none" })],
    ["a lowercase COUNT parameter", bad({ source: { ...good.source, params: "TYPE=transactions&count=100" } })], ["passed as a string", bad({ checks: [{ kind: "archive_comparison", passed: "true", ref: "a" }, { kind: "end_state_reconciliation", passed: "true", ref: "b" }] })]]) t.ok(!rec.ok, `${label}: refused`);
  // classification
  const win = [{ from: "2020-01-10", to: "2020-03-16", days: 67 }], gap = { from: "2025-11-28", to: "2026-03-07", days: 100 };
  const st = (vs, cls = "pick_transfer", w = win, g = gap) => classifyIntervals({ windows: w, namedGap: g, verifications: vs, eventClass: cls });
  t.equal(st([])[0].state, COVERAGE_STATE.UNVERIFIED, "a quiet window with no verification is UNVERIFIED");
  t.equal(st([good])[0].state, COVERAGE_STATE.VERIFIED_COMPLETE, "the same window inside a verified interval is VERIFIED_COMPLETE, although no transaction occurred in it");
  t.equal(st([good], "player_move")[0].state, COVERAGE_STATE.UNVERIFIED, "a verification of another event class verifies nothing");
  t.equal(st([{ ...good, checks: [{ kind: "archive_comparison", passed: false, ref: "r" }] }])[0].state, COVERAGE_STATE.UNVERIFIED, "an invalid record verifies nothing");
  t.equal(st([{ ...good, to: "2020-03-01" }])[0].state, COVERAGE_STATE.UNVERIFIED, "a partly covered window keeps its weaker state");
  const halves = [{ ...good, id: "a", from: "2020-01-10", to: "2020-02-01" }, { ...good, id: "b", from: "2020-02-02", to: "2020-03-16" }];
  t.equal(st(halves)[0].state, COVERAGE_STATE.VERIFIED_COMPLETE, "adjacent verified intervals together cover the window");
  t.equal(st([])[1].state, COVERAGE_STATE.KNOWN_GAP, "the named gap is a KNOWN_GAP without a source");
  const gapV = { ...good, id: "g", from: "2025-11-28", to: "2026-03-07", source: { ...good.source, year: 2025, captured_on: "2026-12-05" } };
  t.equal(st([gapV])[1].state, COVERAGE_STATE.VERIFIED_COMPLETE, "valid verifications covering all of the gap close it");
  t.equal(st([{ ...gapV, to: "2026-03-06" }])[1].state, COVERAGE_STATE.KNOWN_GAP, "one uncovered day keeps it a KNOWN_GAP");
  // would custody be observed? Every day of the span must be verified: a day outside any verification blocks, in a quiet window or not.
  const model = (vs, cls = "pick_transfer") => buildCoverageModel({ windows: win, namedGap: gap, verifications: vs, eventClass: cls });
  t.ok(custodyObserved(model([good]), "2020-01-20", "2020-02-10").observed, "custody inside a verified window is observed, although no transaction occurred in it");
  t.ok(custodyObserved(model([good]), "2020-01-10", "2020-03-16").observed, "the whole verified window, inclusive of both ends");
  t.ok(!custodyObserved(model([good]), "2020-01-01", "2020-04-01").observed, "days around a verified window that nobody verified block custody");
  t.ok(!custodyObserved(model([good]), "2020-01-09", "2020-01-10").observed, "one unverified day at the start blocks"); t.ok(!custodyObserved(model([good]), "2020-03-16", "2020-03-17").observed, "one unverified day at the end blocks");
  t.ok(!custodyObserved(model([]), "2020-01-20", "2020-02-10").observed, "an unverified quiet period does not prove custody");
  t.ok(!custodyObserved(model([]), "2019-05-01", "2019-05-02").observed, "an unverified day outside any quiet window blocks too: a busy stretch is not proof");
  t.ok(custodyObserved(model([]), "2019-05-01", "2019-05-02").uncovered && custodyObserved(model([]), "2019-05-01", "2019-05-02").blockers.length === 0, "and the reader is told the days are uncovered even when no labelled interval touches them");
  t.ok(!custodyObserved(model([good]), "2025-12-01", "2026-01-15").observed, "a known gap blocks even when other intervals are verified");
  t.ok(!custodyObserved(model([good], "player_move"), "2020-01-20", "2020-02-10").observed, "a verification of another event class observes nothing");
  t.ok(custodyObserved(model(halves), "2020-01-12", "2020-03-01").observed, "adjacent verified intervals observe a span across their join");
  t.deepEqual(coverageSummary(st([good])).by_state, { VERIFIED_COMPLETE: 1, UNVERIFIED: 0, KNOWN_GAP: 1 });
  // the property that makes the model safe to test before use: with no verification it is never more permissive than today's quiet-window rule, for every traded future pick
  const led = buildLedger({ archive, root: ROOT });
  const modelNow = buildCoverageModel({ windows: led.windows, namedGap: led.named_gap, verifications: [] });
  let checked = 0;
  for (const asset of [...led.tradesByAsset.keys()].filter((k) => k.startsWith("fpick:"))) {
    const [, orig, ys, rs] = asset.split(":"); const yr = Number(ys); if (yr < 2010 || yr > 2025) continue;
    const res = resolveFuturePick(led, pickChain(led, asset), { year: yr, round: Number(rs), original: orig }, { slotLists: [] });
    if (!res.last_transfer_ts || !res.evidence_ts) continue;
    const m = custodyObserved(modelNow, etParts(res.last_transfer_ts).date, etParts(res.evidence_ts).date);
    t.ok(!(res.coverage_gaps.length > 0 && m.observed), `${asset}: the model never observes custody where the quiet-window rule does not`); t.ok(!m.observed, `${asset}: with no verification no custody is observed at all`); checked += 1;
  }
  t.ok(checked > 400, "the property was checked on the traded future picks that have a last transfer and an evidence date");
  t.equal(x.summary.future_picks.unresolved, 597, "all 597 unresolved future picks are preserved");
});

test("the proposed D1 schema in S1_D1_DESIGN.md is valid SQL and its constraints refuse the uncertain-as-definitive cases (in-memory SQLite only; no D1, no migration)", () => {
  const doc = fs.readFileSync(path.join(ROOT, "docs", "league_record", "S1_D1_DESIGN.md"), "utf8");
  t.match(doc, /DESIGN ONLY/); t.match(doc, /not a migration/);
  const m = doc.match(/```sql\n([\s\S]*?)```/); t.ok(m, "the document holds one SQL block");
  const db = new DatabaseSync(":memory:"); db.exec("PRAGMA foreign_keys = ON"); db.exec(m[1]);
  const tables = db.prepare("select name from sqlite_master where type = 'table' and name like 'lr_%' order by 1").all().map((r) => r.name);
  t.ok(tables.length >= 20 && tables.every((n) => n.startsWith("lr_")), "every table is prefixed lr_ (additive; no existing table is touched)");
  t.ok(!/raw_object_key|R2 by hash/.test(doc.replace(/no raw response[^.]*\./g, "")), "no raw payload is stored");
  const fails = (sql) => { try { db.exec(sql); return false; } catch { return true; } };
  const ok = (sql) => { db.exec(sql); return true; };
  ok("insert into lr_run (run_id, kind, created_utc, code_sha, source_set_sha256) values (1, 'build', '2026-11-21T00:00:00Z', 'sha', 'sha'), (2, 'build', '2026-11-22T00:00:00Z', 'sha', 'sha')");
  ok("insert into lr_method values ('DIAG', 1, 'd', null, 'diagnostic'), ('OK', 1, 'd', 'ref', 'approved')");
  ok("insert into lr_source (source_id, kind, authority) values ('S', 'archive_db', 'derived')");
  ok("insert into lr_draft_row (draft_row_id, loaded_run, season, round, slot_raw, overall, raw_pick_text, franchise_id, player_id, ts, source_id, source_key) values (1, 1, 2018, 4, 11, 47, '4.11', '0001', 'P', 1, 'S', 'k'), (2, 1, 2014, 1, 1, 10, '1.1', '0002', 'Q', 1, 'S', 'k2'), (3, 1, 2018, 4, 12, 48, '4.12', '0003', 'R', 1, 'S', 'k3')");   // row 3 exists only to prove the unique index, not the trigger, stops a second open row
  const slot = (s, r, sl, ov, st, row, from = 1, to = "null") => `insert into lr_draft_slot values (${s}, ${r}, ${sl}, ${ov}, '${st}', ${row}, ${from}, ${to})`;
  // the draft-slot statuses
  t.ok(!fails(slot(2018, 4, 11, 47, "SELECTED", 1)), "a SELECTED slot with its matching draft row is accepted");
  t.ok(fails(slot(2018, 4, 10, 46, "SELECTED", 1)), "a SELECTED slot 4.10 pointing at the raw row for 4.11 is refused");
  t.ok(fails(slot(2018, 4, 9, 45, "SELECTED", "null")), "a SELECTED slot with no draft row is refused");
  t.ok(fails(slot(2014, 1, 10, 10, "SELECTED", 2)), "a slot that differs from the stored slot, with no correction record, is refused");
  ok("insert into lr_correction (target_table, target_key, field, original_value, corrected_value, method_id, defect_id, approved_ref, source_ref, run_id) values ('lr_draft_row', '2', 'slot', '1', '10', 'm', 'd', 'a', 's', 1)");
  t.ok(!fails(slot(2014, 1, 10, 10, "SELECTED", 2)), "the same slot with its correction record (original, corrected value, method, approval) is accepted");
  t.ok(fails(slot(2018, 4, 12, 48, "FORFEITED", "null")), "a FORFEITED slot with no forfeiture record is refused: an absence is never called a forfeiture without a source");
  ok("insert into lr_forfeiture values (2018, 4, 12, 48, 'owner violation', 'commissioner clarification', '2026-11-21', '[]', 1)");
  t.ok(!fails(slot(2018, 4, 12, 48, "FORFEITED", "null")), "a FORFEITED slot with its forfeiture record and no player is accepted");
  t.ok(fails(slot(2018, 4, 12, 48, "SELECTED", 3)), "the same slot cannot be open as SELECTED beside the FORFEITED one");
  t.ok(fails(slot(2018, 4, 12, 48, "MISSING_SOURCE_RECORD", "null", 2)), "nor as MISSING_SOURCE_RECORD: one open row per slot");
  t.ok(fails(slot(2018, 4, 8, 44, "FORFEITED", 1)), "a FORFEITED slot that carries a player is refused");
  t.ok(fails(slot(2018, 4, 8, 44, "MISSING", "null")), "an unknown slot status is refused");
  t.ok(!fails(slot(2018, 4, 7, 43, "MISSING_SOURCE_RECORD", "null")), "a genuinely missing record is its own status");
  t.ok(fails(slot(2018, 4, 6, 42, "MISSING_SOURCE_RECORD", "null", 2, 1)), "a row closed before it opened is refused");
  // assets and links
  ok("insert into lr_asset (asset_key, loaded_run, asset_type, player_id, orig_franchise, pick_year, pick_round, pick_slot) values ('fpick:0001:2018:4', 1, 'FUTURE_PICK', null, '0001', 2018, 4, null), ('fpick:0002:2018:4', 1, 'FUTURE_PICK', null, '0002', 2018, 4, null), ('spick:2018:4:11', 1, 'SLOT_PICK', null, null, 2018, 4, 11)");
  t.ok(fails("insert into lr_asset values ('fpick:bad', 1, 'FUTURE_PICK', null, null, 2018, 4, null)"), "a future pick needs its original franchise");
  t.ok(fails("insert into lr_asset values ('spick:bad', 1, 'SLOT_PICK', null, '0001', 2018, 4, 3)"), "a slot pick has no original franchise");
  const link = (id, asset, type, ts, rd, sl, cls, meth, ver, ev, from = 1, to = "null") => `insert into lr_link values (${id}, '${type}', '${asset}', ${ts}, ${rd}, ${sl}, '${cls}', '${meth}', ${ver}, null, ${ev}, ${from}, ${to})`;
  const F = "FUTURE_PICK_TO_SLOT";
  t.ok(!fails(link(1, "fpick:0001:2018:4", F, "null", "null", "null", "UNRESOLVED", "DIAG", 1, "null")), "an UNRESOLVED link with no slot is accepted");
  t.ok(fails(link(2, "fpick:0002:2018:4", F, 2018, 4, 11, "UNRESOLVED", "DIAG", 1, "null")), "an UNRESOLVED link that names a slot is refused");
  t.ok(fails(link(3, "fpick:0002:2018:4", F, 2018, 4, 11, "CONFIRMED", "OK", 1, "'e'")), "a future pick can never be CONFIRMED to a slot");
  t.ok(fails(link(3, "fpick:0002:2018:4", F, 2018, 4, 11, "CALCULATED", "OK", 1, "'e'")), "nor CALCULATED (count netting cannot be stored as a calculation)");
  t.ok(fails(link(4, "fpick:0002:2018:4", F, 2018, 4, 11, "INFERRED", "DIAG", 1, "'e'")), "an INFERRED link from a diagnostic method is refused");
  t.ok(fails(link(5, "fpick:0002:2018:4", F, 2018, 4, 11, "INFERRED", "NOPE", 1, "'e'")), "a link must name a method that exists");
  t.ok(fails(link(6, "fpick:0002:2018:4", F, 2018, 4, 11, "INFERRED", "OK", 1, "null")), "an INFERRED link with no evidence is refused");
  t.ok(fails(link(7, "fpick:0002:2018:4", F, 2019, 4, 11, "INFERRED", "OK", 1, "'e'")), "a future pick of 2018 cannot resolve to a 2019 slot");
  t.ok(fails(link(8, "fpick:0002:2018:4", F, 2018, "null", 11, "INFERRED", "OK", 1, "'e'")), "a resolved link with no round is refused");
  t.ok(fails(link(9, "spick:2018:4:11", F, "null", "null", "null", "UNRESOLVED", "DIAG", 1, "null")), "a future-pick link cannot start from a slot pick");
  t.ok(fails(link(10, "fpick:0001:2018:4", F, "null", "null", "null", "UNRESOLVED", "DIAG", 1, "null", 2)), "two open links for the same pick and type are refused");
  t.ok(fails(link(11, "fpick:0002:2018:4", F, "null", "null", "null", "LIKELY", "DIAG", 1, "null")), "an unknown evidence class is refused");
  t.ok(!fails(link(12, "fpick:0002:2018:4", F, 2018, 4, 11, "INFERRED", "OK", 1, "'e'")), "an INFERRED link with an approved method, its own year and round, and evidence is accepted");
  t.ok(!fails("insert into lr_link_candidate values (1, 2018, 4, 11, 'mfl_slot_list')"), "candidates attach to an UNRESOLVED link");
  t.ok(fails("insert into lr_link_candidate values (12, 2018, 4, 11, 'mfl_slot_list')"), "candidates on an INFERRED link are refused");
  // coverage, releases, cap
  const cov = (id, cls, st, src, to = "null") => `insert into lr_coverage values (${id}, ${src}, '${cls}', '2020-01-01', '2020-02-01', '${st}', 'b', 1, ${to})`;
  t.ok(fails(cov(1, "contract", "UNVERIFIED", "'S'")), "an unknown event class is refused"); t.ok(fails(cov(2, "pick_transfer", "QUIET", "'S'")), "a quiet period is not a coverage state");
  t.ok(fails(cov(3, "pick_transfer", "VERIFIED_COMPLETE", "null")), "a VERIFIED_COMPLETE interval with no source is refused");
  t.ok(!fails(cov(4, "pick_transfer", "UNVERIFIED", "'S'")), "an unverified interval is accepted");
  t.ok(!fails(cov(5, "pick_transfer", "VERIFIED_COMPLETE", "'S'")), "a verified interval row can be written");
  t.ok(fails("insert into lr_coverage_check (coverage_id, check_kind, passed) values (5, 'archive_comparison', 0)"), "a failed check beside a verified interval is refused");
  t.ok(fails("insert into lr_release (run_id, activated_utc, activated_by_ref) values (1, 'x', 'r')"), "a release cannot activate while a verified interval lacks its passing checks");
  ok("insert into lr_coverage_check (coverage_id, check_kind, passed) values (5, 'archive_comparison', 1)");
  t.ok(fails("insert into lr_release (run_id, activated_utc, activated_by_ref) values (1, 'x', 'r')"), "the comparison alone is not enough: the end-state reconciliation is required too");
  ok("insert into lr_coverage_check (coverage_id, check_kind, passed) values (5, 'end_state_reconciliation', 1)");
  t.ok(!fails("insert into lr_release (run_id, activated_utc, activated_by_ref) values (1, 'x', 'r')"), "with both checks the release activates");
  t.ok(fails("insert into lr_release (run_id, activated_utc, activated_by_ref) values (2, 'y', 'r')"), "a second active release is refused");
  ok("update lr_release set retired_utc = 'z' where run_id = 1");
  t.ok(!fails("insert into lr_release (run_id, activated_utc, activated_by_ref) values (2, 'y', 'r')"), "after the first is retired, the next activates");
  ok("insert into lr_trade (trade_id, loaded_run, season, ts, date_et, date_quality, source_id, source_key) values ('t1', 1, 2025, 1, '2025-01-01', 'recorded', 'S', 'k')");
  t.ok(fails("insert into lr_trade_cap values ('t1', 1, '0001', '0002', 0)"), "a cap amount of 0 is refused (a missing amount must be handled, never stored as 0)");
  t.ok(!fails("insert into lr_trade_cap values ('t1', 1, '0001', '0002', 3000)"), "a cap transfer keeps its direction and amount");
  // the query plans of the design's hot paths use the indexes the document defines
  const plan = (sql) => db.prepare(`explain query plan ${sql}`).all().map((r) => r.detail).join(" | ");
  t.match(plan("select * from lr_trade_leg where asset_key = 'x' order by ts"), /USING (COVERING )?INDEX lr_leg_asset/);
  t.match(plan("select * from lr_possession where franchise_id = '0001' order by from_ts limit 100"), /USING (COVERING )?INDEX lr_poss_franchise/);
  t.match(plan("select * from lr_link where from_asset_key = 'x' and valid_from_run <= 1"), /USING (COVERING )?INDEX lr_(link_asset|one_open_link)/);
  t.match(plan("select * from lr_draft_slot where season = 2018 and round = 4"), /USING (COVERING )?INDEX|PRIMARY KEY/);
  db.close();
});

await run("league_record_s1_archive");
raw.close();
archive.close();
