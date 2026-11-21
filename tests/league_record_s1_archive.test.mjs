// League Record S1, Step 1b: tests of the 2010-2025 archive extraction. Offline and read-only: the committed archive only. Every count is re-derived here with separate SQL against the
// decompressed archive (a different code path from the extraction), representative older periods are checked trade by trade, and the standing rule (no slot from standings, finishes,
// brackets or a projected order) is tested at the guard, the source scan and the data.
import fs from "node:fs";
import os from "node:os";
import { spawnSync } from "node:child_process";
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
import { APPROVED, StopError, sanitizeTransactions, sanitizeFuturePicks, checkIdentity, sanitizeRun, readRequestLog, checkRequestRecord } from "../scripts/league_record/s1/export_package/sanitize_exports.mjs";
import { classifyIntervals, buildCoverageModel, custodyObserved, validateVerification, coverageSummary, loadVerifications, COVERAGE_STATE } from "../scripts/league_record/s1/coverage.mjs";
import { resolveFuturePick } from "../scripts/league_record/s1/lineage.mjs";
import { etParts } from "../scripts/league_record/s1/sources.mjs";
import { loadArchiveSelections, loadKnownForfeitures, FORFEITURE_FILE, FORFEITURE_FIELDS, LEGACY_DEFECT, parseCapToken, capAmount, parseTokens, loadArchiveTrades } from "../scripts/league_record/s1/sources.mjs";

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
    // the archive's amount column, plus (separate SQL on the raw payload) the decimal-token amount of every transfer whose column is blank: the register LR-05 correction
    const colSum = q("select coalesce(sum(asset_capadjustment), 0) n from transactions_trades where season = ? and asset_role = 'RELINQUISH' and asset_type = 'CAP'", s.season)[0].n;
    const blankSum = q("select franchise_id f, json_extract(raw_json, '$.franchise') jf, json_extract(raw_json, '$.franchise1_gave_up') g1, json_extract(raw_json, '$.franchise2_gave_up') g2 from transactions_trades where season = ? and asset_role = 'RELINQUISH' and asset_type = 'CAP' and asset_capadjustment is null", s.season)
      .reduce((acc, r) => acc + Number(/BB_(\d+(?:\.\d+)?)/.exec(r.f === r.jf ? r.g1 : r.g2)[1]), 0);        // a plain regex on the sender's own list: a second code path
    t.equal(s.trades.cap.total_amount, colSum + blankSum, `${s.season} cap total (archive column + decimal-token amounts of the blank rows)`);
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
  // the one pick that rests on none of the three assumptions, and the notes diagnostic (corroboration only: it changes no class and no count above)
  t.deepEqual(x.findings.lists.event_accounting_unflagged, [{ asset: "fpick:0004:2013:2", year: 2013, round: 2, holder: "0010", slot: 8, quiet_windows_over_the_round: 1, span_days: 376 }]);
  const nc = f.note_corroboration;
  t.deepEqual(nc, { traded_picks: 597, before_notes_era: 181, unique_note_match: 108, no_note_match: 308, several_note_matches: 0, event_screen_picks_in_notes_era: 82, event_screen_note_matches_same_slot: 20, event_screen_note_matches_other_slot: 0, event_screen_slot_note_absent: 21, event_screen_slot_note_unresolved: 7, event_screen_slot_note_differs: 34 });
  t.equal(nc.before_notes_era + nc.unique_note_match + nc.no_note_match + nc.several_note_matches, nc.traded_picks, "every traded pick is counted once");
  t.equal(nc.event_screen_note_matches_same_slot + nc.event_screen_note_matches_other_slot + nc.event_screen_slot_note_absent + nc.event_screen_slot_note_unresolved + nc.event_screen_slot_note_differs, nc.event_screen_picks_in_notes_era);
  t.equal(q("select count(*) n from draftresults_legacy where season < 2017 and raw_comments like '%Pick traded from%'")[0].n, 0, "the legacy draft rows of 2012-2016 carry no MFL notes, so those picks cannot be corroborated this way");
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
  const good = { id: "v1", event_class: "pick_transfer", from: "2020-01-10", to: "2020-03-16", source: { kind: "mfl_export", type: "transactions", year: 2020, league_id: "74598", params: "TYPE=transactions&TRANS_TYPE=*", captured_on: "2026-12-01", truncated: false },
    checks: [{ kind: "archive_comparison", passed: true, ref: "r1" }, { kind: "end_state_reconciliation", passed: true, ref: "r2" }] };
  t.ok(validateVerification(good).ok, "a complete record is valid");
  const bad = (over) => validateVerification({ ...good, ...over });
  for (const [label, rec] of [["unknown event class", bad({ event_class: "contract" })], ["reversed dates", bad({ from: "2020-04-01" })], ["not an MFL export", bad({ source: { ...good.source, kind: "forum_post" } })],
    ["truncated response", bad({ source: { ...good.source, truncated: true } })], ["COUNT parameter", bad({ source: { ...good.source, params: "TYPE=transactions&COUNT=100" } })], ["DAYS parameter", bad({ source: { ...good.source, params: "TYPE=transactions&DAYS=30" } })],
    ["captured before the interval ends", bad({ source: { ...good.source, captured_on: "2020-03-01" } })], ["a failed check", bad({ checks: [...good.checks, { kind: "end_state_reconciliation", passed: false }] })],
    ["no archive comparison", bad({ checks: [{ kind: "chain_continuity", passed: true, ref: "x" }, { kind: "end_state_reconciliation", passed: true, ref: "y" }] })], ["no independent corroboration", bad({ checks: [{ kind: "archive_comparison", passed: true, ref: "x" }] })],
    ["comparison and chain continuity only: both come from MFL's own log", bad({ checks: [{ kind: "archive_comparison", passed: true, ref: "x" }, { kind: "chain_continuity", passed: true, ref: "y" }] })], ["no league id", bad({ source: { ...good.source, league_id: undefined } })],
    ["no instance year", bad({ source: { ...good.source, year: undefined } })], ["an interval outside the instance's calendar year", bad({ source: { ...good.source, year: 2015 } })], ["an interval that runs into the next year", bad({ to: "2021-01-02" })], ["an URL-encoded COUNT", bad({ source: { ...good.source, params: "TYPE=transactions&%43OUNT=1" } })], ["a check with no evidence reference", bad({ checks: [{ kind: "archive_comparison", passed: true }, { kind: "end_state_reconciliation", passed: true, ref: "y" }] })],
    ["a leading ?COUNT parameter", bad({ source: { ...good.source, params: "COUNT=5&TYPE=transactions" } })], ["an encoded COUNT beside a malformed percent sequence", bad({ source: { ...good.source, params: "TYPE=transactions&%43OUNT=1&x=%ZZ" } })], ["a semicolon-separated COUNT", bad({ source: { ...good.source, params: "TYPE=transactions;COUNT=1" } })],
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
  const gap25 = { ...good, id: "g25", from: "2025-11-28", to: "2025-12-31", source: { ...good.source, year: 2025, captured_on: "2026-12-05" } };
  const gap26 = { ...good, id: "g26", from: "2026-01-01", to: "2026-03-07", source: { ...good.source, year: 2026, captured_on: "2026-12-05" } };
  t.equal(st([gap25, gap26])[1].state, COVERAGE_STATE.VERIFIED_COMPLETE, "one valid record per instance, together covering all of the gap, close it");
  t.equal(st([gap25])[1].state, COVERAGE_STATE.KNOWN_GAP, "the 2025 instance alone cannot close days that belong to the 2026 instance");
  t.ok(!validateVerification({ ...gap25, to: "2026-03-07" }).ok, "a 2025-instance record claiming 2026 days is refused");
  t.equal(st([gap25, { ...gap26, to: "2026-03-06" }])[1].state, COVERAGE_STATE.KNOWN_GAP, "one uncovered day keeps it a KNOWN_GAP");
  // would custody be observed? Every day of the span must be verified: a day outside any verification blocks, in a quiet window or not.
  const model = (vs, cls = "pick_transfer") => buildCoverageModel({ windows: win, namedGap: gap, verifications: vs, eventClass: cls });
  t.ok(custodyObserved(model([good]), "2020-01-20", "2020-02-10").observed, "custody inside a verified window is observed, although no transaction occurred in it");
  t.ok(custodyObserved(model([good]), "2020-01-10", "2020-03-16").observed, "the whole verified window, inclusive of both ends");
  t.ok(!custodyObserved(model([good]), "2020-01-01", "2020-04-01").observed, "days around a verified window that nobody verified block custody");
  t.ok(!custodyObserved(model([good]), "2020-01-09", "2020-01-10").observed, "one unverified day at the start blocks"); t.ok(!custodyObserved(model([good]), "2020-03-16", "2020-03-17").observed, "one unverified day at the end blocks");
  t.ok(!custodyObserved(model([]), "2020-01-20", "2020-02-10").observed, "an unverified quiet period does not prove custody");
  t.ok(!custodyObserved(model([good]), "2020-02-10", "2020-01-20").observed, "a reversed span observes nothing"); t.ok(!custodyObserved(model([good]), "2020-01-20", "2020-2-10").observed, "a malformed date observes nothing");
  t.ok(!custodyObserved(model([]), "2019-05-01", "2019-05-02").observed, "an unverified day outside any quiet window blocks too: a busy stretch is not proof");
  t.ok(custodyObserved(model([]), "2019-05-01", "2019-05-02").uncovered && custodyObserved(model([]), "2019-05-01", "2019-05-02").blockers.length === 0, "and the reader is told the days are uncovered even when no labeled interval touches them");
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
  ok("insert into lr_source (source_id, kind, authority, loaded_run) values ('S', 'archive_db', 'derived', 1)");
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
  // unresolved evidence is recorded explicitly: an UNRESOLVED link (link 1) cannot be released without an evidence need that cites the register
  t.ok(fails("insert into lr_release (run_id, activated_utc, activated_by_ref) values (1, 'x', 'r')"), "an UNRESOLVED link with no recorded evidence need blocks a release");
  t.ok(fails("insert into lr_evidence_need (subject_type, subject_id, need_code, register_ref, description, status, valid_from_run) values ('LINK', 1, 'SLOT_EVIDENCE', 'LR-03', 'd', 'ACCEPTED_LIMITATION', 1)"), "a limitation cannot be accepted without a cited decision");
  t.ok(fails("insert into lr_evidence_need (subject_type, subject_id, need_code, register_ref, description, status, valid_from_run) values ('FOO', 1, 'x', 'LR-03', 'd', 'OPEN', 1)"), "an unknown subject type is refused");
  ok("insert into lr_evidence_need (subject_type, subject_id, need_code, register_ref, description, status, valid_from_run) values ('LINK', 1, 'SLOT_EVIDENCE', 'LR-03', 'which original franchise became this slot', 'OPEN', 1)");
  t.ok(fails("update lr_evidence_need set status = 'RESOLVED' where need_id = 1"), "an evidence need is never edited into RESOLVED: a changed status is a new row");
  t.ok(fails("insert into lr_release (run_id, activated_utc, activated_by_ref) values (1, 'x', 'r')"), "a release still cannot activate while a verified interval lacks its passing checks");
  ok("insert into lr_coverage_check (coverage_id, check_kind, passed) values (5, 'archive_comparison', 1)");
  t.ok(fails("insert into lr_release (run_id, activated_utc, activated_by_ref) values (1, 'x', 'r')"), "the comparison alone is not enough: the end-state reconciliation is required too");
  ok("insert into lr_coverage_check (coverage_id, check_kind, passed) values (5, 'end_state_reconciliation', 1)");
  t.ok(!fails("insert into lr_release (run_id, activated_utc, activated_by_ref) values (1, 'x', 'r')"), "with both checks the release activates");
  t.ok(fails("insert into lr_release (run_id, activated_utc, activated_by_ref) values (2, 'y', 'r')"), "a second active release is refused");
  ok("update lr_release set retired_utc = 'z' where run_id = 1");
  t.ok(!fails("insert into lr_release (run_id, activated_utc, activated_by_ref) values (2, 'y', 'r')"), "after the first is retired, the next activates");
  ok("insert into lr_trade (trade_id, loaded_run, season, ts, date_et, date_quality, source_id, source_key) values ('t1', 1, 2025, 1, '2025-01-01', 'recorded', 'S', 'k')");
  const cap = (n, amt, src, tok = "null") => `insert into lr_trade_cap (trade_id, cap_no, from_franchise, to_franchise, amount, amount_source, token) values ('t1', ${n}, '0001', '0002', ${amt}, '${src}', ${tok})`;
  t.ok(fails(cap(1, 0, "archive_column")), "a cap amount of 0 is refused (a missing amount must be handled, never stored as 0)");
  t.ok(fails(cap(1, 3000.5, "archive_column")), "a fractional cap amount is refused, never rounded");
  t.ok(fails(cap(1, 3000, "guess")), "an amount must name where it came from: the archive column or the raw token");
  t.ok(fails(cap(1, 3000, "raw_token")), "an amount read from a raw token must cite the token"); t.ok(fails(cap(1, 3000, "raw_token", "''")), "an empty token is not a citation");
  t.ok(!fails(cap(1, 3000, "raw_token", "'BB_3000.00'")), "a cap transfer keeps its direction, amount, source and token"); t.ok(!fails(cap(2, 500, "archive_column")));
  // updates cannot walk around the insert rules: a derived row may only be closed, facts never change
  t.ok(fails("update lr_link set class = 'INFERRED', to_season = 2018, to_round = 4, to_slot = 11, evidence_json = 'e', method_id = 'DIAG' where link_id = 1"), "an UNRESOLVED link cannot be turned into INFERRED by an update");
  t.ok(fails("update lr_draft_slot set status = 'FORFEITED', draft_row_id = null where season = 2018 and round = 4 and slot = 7"), "a missing slot cannot be turned into a forfeiture by an update");
  t.ok(fails("update lr_coverage set state = 'VERIFIED_COMPLETE' where coverage_id = 4"), "an unverified interval cannot be promoted by an update");
  t.ok(fails("update lr_trade set season = 2024 where trade_id = 't1'"), "a trade fact is never updated"); t.ok(fails("update lr_trade_cap set amount = 1 where trade_id = 't1'"), "a cap amount is never updated");
  t.ok(fails("update lr_correction set corrected_value = '9' where target_key = '2'"), "a correction is never edited"); t.ok(fails("update lr_coverage_check set passed = 1 where coverage_id = 5"), "a check is never edited");
  t.ok(!fails("update lr_link set valid_to_run = 2 where link_id = 1"), "closing a derived row is the one update allowed");
  t.ok(fails("update lr_link set valid_to_run = null where link_id = 1"), "a closed derived row is never reopened"); t.ok(fails("update lr_link set valid_to_run = 4 where link_id = 1"), "nor re-closed at another run");
  ok("insert into lr_trade_party values ('t1', '0001')"); t.ok(fails("update lr_trade_party set franchise_id = '0002' where trade_id = 't1'"), "a trade party is never updated");
  t.ok(fails("update lr_release set run_id = 2 where run_id = 1"), "a release row's run never changes");
  // an abandoned run can never be released
  ok("insert into lr_run (run_id, kind, created_utc, code_sha, source_set_sha256) values (3, 'build', 'z', 'sha', 'sha'), (4, 'rollback', 'z', 'sha', 'sha')");
  t.ok(fails("insert into lr_run_excluded values (3, 2)"), "an exclusion recorded by an earlier run is refused"); ok("insert into lr_run_excluded values (3, 4)");
  ok("update lr_release set retired_utc = 'z2' where retired_utc is null");
  t.ok(fails("insert into lr_release (run_id, activated_utc, activated_by_ref) values (3, 'y', 'r')"), "an excluded run cannot be released");
  // the evidence-need release gate, in isolation (fresh databases, no other gate involved): the need must exist, apply to the run being released, and not be a resolved or closed one
  const fresh = (conflict = false) => {
    const d = new DatabaseSync(":memory:"); d.exec("PRAGMA foreign_keys = ON"); d.exec(m[1]);
    d.exec("insert into lr_run (run_id, kind, created_utc, code_sha, source_set_sha256) values (1, 'build', 'a', 's', 's'), (2, 'build', 'b', 's', 's'), (3, 'build', 'c', 's', 's'), (4, 'rollback', 'd', 's', 's'), (5, 'build', 'e', 's', 's')");
    d.exec("insert into lr_method values ('DIAG', 1, 'd', null, 'diagnostic')");
    d.exec("insert into lr_source (source_id, kind, authority, loaded_run) values ('S', 'archive_db', 'derived', 1)");
    d.exec("insert into lr_asset (asset_key, loaded_run, asset_type, player_id, orig_franchise, pick_year, pick_round, pick_slot) values ('fpick:0001:2018:4', 1, 'FUTURE_PICK', null, '0001', 2018, 4, null)");
    if (conflict) d.exec("insert into lr_conflict (conflict_id, subject_key, kind, left_ref, right_ref, status, run_id) values (1, 'slot:2014:4:12', 'selector', 'trade', 'draft', 'open', 1)");
    else d.exec("insert into lr_link values (1, 'FUTURE_PICK_TO_SLOT', 'fpick:0001:2018:4', null, null, null, 'UNRESOLVED', 'DIAG', 1, null, null, 1, null)");
    const fails2 = (sql) => { try { d.exec(sql); return false; } catch { return true; } };
    const rel = (run) => `insert into lr_release (run_id, activated_utc, activated_by_ref) values (${run}, 'x', 'r')`;
    const need = (type, from, to, status, acc = "null") => `insert into lr_evidence_need (subject_type, subject_id, need_code, register_ref, description, status, accepted_by_ref, valid_from_run, valid_to_run) values ('${type}', 1, 'C', 'LR-03', 'd', '${status}', ${acc}, ${from}, ${to})`;
    return { d, fails2, rel, need };
  };
  for (const [kind, subject] of [["link", false], ["conflict", true]]) {
    const T = subject ? "CONFLICT" : "LINK";
    let f = fresh(subject); t.ok(f.fails2(f.rel(1)), `${kind}: with no evidence need the release is refused`); f.d.close();
    f = fresh(subject); f.d.exec(f.need(T, 2, "null", "OPEN")); t.ok(f.fails2(f.rel(1)), `${kind}: a need that only starts at run 2 does not apply to run 1`); f.d.close();
    f = fresh(subject); f.d.exec(f.need(T, 1, 2, "OPEN")); t.ok(f.fails2(f.rel(2)), `${kind}: a need closed at run 2 does not apply to run 2`); t.ok(!f.fails2(f.rel(1)), `${kind}: it did apply to run 1`); f.d.close();
    f = fresh(subject); f.d.exec(f.need(T, 1, "null", "RESOLVED")); t.ok(f.fails2(f.rel(1)), `${kind}: a RESOLVED need is not an open evidence need`); f.d.close();
    f = fresh(subject); f.d.exec("insert into lr_coverage values (1, null, 'pick_transfer', '2020-01-01', '2020-02-01', 'UNVERIFIED', 'b', 1, null)"); f.d.exec(f.need("COVERAGE", 1, "null", "OPEN")); t.ok(f.fails2(f.rel(1)), `${kind}: a need about something else does not count`); f.d.close();
    f = fresh(subject); f.d.exec(f.need(T, 1, "null", "INVESTIGATING")); t.ok(!f.fails2(f.rel(1)), `${kind}: an investigating need applies`); f.d.close();
    f = fresh(subject); f.d.exec(f.need(T, 1, "null", "ACCEPTED_LIMITATION", "'issue 1486 comment (decision)'")); t.ok(!f.fails2(f.rel(1)), `${kind}: an accepted limitation with its cited decision applies`); f.d.close();
  }
  // the exclusion read rule inside the gates: a link closed by an abandoned run is open again, and a need begun by an abandoned run does not count
  { let f = fresh(false); f.d.exec("update lr_link set valid_to_run = 3 where link_id = 1"); f.d.exec("insert into lr_run_excluded values (3, 4)");
    t.ok(f.fails2(f.rel(5)), "a link closed only by an excluded run counts as open: it needs an evidence need"); f.d.exec(f.need("LINK", 1, "null", "OPEN")); t.ok(!f.fails2(f.rel(5)), "and a valid need satisfies it"); f.d.close();
    f = fresh(false); f.d.exec("insert into lr_run_excluded values (3, 4)"); f.d.exec(f.need("LINK", 3, "null", "OPEN")); t.ok(f.fails2(f.rel(5)), "a need begun by an excluded run does not count"); f.d.close();
    f = fresh(false); f.d.exec("update lr_link set valid_to_run = 3 where link_id = 1"); t.ok(!f.fails2(f.rel(5)), "a link closed by a normal run needs nothing at the later run"); f.d.close(); }
  // the conflict path in isolation: closing an open conflict without its resolution cannot hide it from the release gate
  { const f = fresh(true); t.ok(f.fails2("update lr_conflict set valid_to_run = 2 where conflict_id = 1"), "an open conflict cannot be closed without a resolution row"); t.ok(f.fails2(f.rel(1)), "and it still blocks a release without an evidence need"); f.d.close(); }
  { const f = fresh(true); f.d.exec("insert into lr_run_excluded values (3, 4)"); f.d.exec("insert into lr_conflict (conflict_id, subject_key, kind, left_ref, right_ref, status, run_id) values (2, 'slot:x', 'selector', 'a', 'b', 'open', 3)");
    f.d.exec(f.need("CONFLICT", 1, "null", "OPEN")); t.ok(!f.fails2(f.rel(5)), "an open conflict begun by an excluded run does not count at the later release"); f.d.close(); }
  // the coverage gate's exclusion rule in isolation: a verified interval begun by an abandoned run does not count, one closed only by an abandoned run still does
  { let f = fresh(false); f.d.exec(f.need("LINK", 1, "null", "OPEN")); f.d.exec("insert into lr_run_excluded values (3, 4)");
    f.d.exec("insert into lr_coverage values (1, 'S', 'pick_transfer', '2020-01-01', '2020-02-01', 'VERIFIED_COMPLETE', 'b', 3, null)"); t.ok(!f.fails2(f.rel(5)), "a verified interval begun by an excluded run is ignored"); f.d.close();
    f = fresh(false); f.d.exec(f.need("LINK", 1, "null", "OPEN")); f.d.exec("insert into lr_run_excluded values (3, 4)");
    f.d.exec("insert into lr_coverage values (1, 'S', 'pick_transfer', '2020-01-01', '2020-02-01', 'VERIFIED_COMPLETE', 'b', 1, null)"); f.d.exec("update lr_coverage set valid_to_run = 3 where coverage_id = 1");
    t.ok(f.fails2(f.rel(5)), "a verified interval closed only by an excluded run is still live, so its missing checks block the release"); f.d.close(); }
  // no bypass by update, delete or a free-form resolution
  t.ok(!fails("insert into lr_asset (asset_key, loaded_run, asset_type, player_id, orig_franchise, pick_year, pick_round, pick_slot) values ('player:9', 1, 'PLAYER', '9', null, null, null, null), ('player:10', 4, 'PLAYER', '10', null, null, null, null)"));
  t.ok(fails("delete from lr_coverage_check where coverage_id = 5"), "a check of a released run cannot be deleted to pass the release gate"); t.ok(fails("delete from lr_asset where asset_key = 'player:9'"), "a fact of a released run is never deleted");
  t.ok(!fails("delete from lr_asset where asset_key = 'player:10'"), "a row of a never-released run (a failed load) can be dropped"); t.ok(fails("delete from lr_release"), "release history is never deleted"); t.ok(fails("delete from lr_run_excluded"), "an exclusion is permanent"); t.ok(fails("update lr_run_excluded set excluded_by_run = 5"), "nor edited");
  t.ok(fails("insert into lr_evidence_need (subject_type, subject_id, need_code, register_ref, description, status, accepted_by_ref, valid_from_run) values ('LINK', 1, 'C', 'LR-03', 'd', 'ACCEPTED_LIMITATION', '', 1)"), "an accepted limitation with an empty citation is refused");
  t.ok(fails("insert into lr_evidence_need (subject_type, subject_id, need_code, register_ref, description, status, valid_from_run) values ('LINK', 999, 'C', 'LR-03', 'd', 'OPEN', 1)"), "an evidence need must point at an existing link"); t.ok(fails("insert into lr_evidence_need (subject_type, subject_id, need_code, register_ref, description, status, valid_from_run) values ('CONFLICT', 999, 'C', 'LR-03', 'd', 'OPEN', 1)"), "or conflict");
  ok("insert into lr_conflict (conflict_id, subject_key, kind, left_ref, right_ref, status, run_id) values (7, 'slot:2014:4:12', 'selector', 'trade', 'draft', 'open', 1)");
  t.ok(fails("update lr_conflict set status = 'resolved_by_ruling' where conflict_id = 7"), "a conflict is never edited into a resolution");
  t.ok(fails("update lr_conflict set valid_to_run = 2 where conflict_id = 7"), "an open conflict cannot be closed (and so dropped from the release gate) without its resolution row");
  t.ok(fails("insert into lr_conflict (conflict_id, subject_key, kind, left_ref, right_ref, status, ruling_ref, run_id) values (8, 'slot:2014:4:12', 'selector', 'trade', 'draft', 'resolved_by_ruling', null, 2)"), "a resolution without its ruling or source is refused");
  t.ok(!fails("insert into lr_conflict (conflict_id, subject_key, kind, left_ref, right_ref, status, ruling_ref, run_id) values (8, 'slot:2014:4:12', 'selector', 'trade', 'draft', 'resolved_by_source', 'MFL 2014 export hash', 2)"), "with its source it is accepted");
  t.ok(fails("update lr_conflict set valid_to_run = 3 where conflict_id = 7"), "the resolution must begin in the closing run"); t.ok(!fails("update lr_conflict set valid_to_run = 2 where conflict_id = 7"), "an open conflict can be closed together with its resolution row");
  // possession: continuity over unverified days is INFERRED, never CONFIRMED or CALCULATED
  const poss = (cls, cov) => `insert into lr_possession (asset_key, franchise_id, from_ts, to_ts, from_basis, evidence_class, weakest_coverage, valid_from_run) values ('fpick:0001:2018:4', '0001', 1, 2, 'event', '${cls}', '${cov}', 1)`;
  t.ok(fails(poss("CONFIRMED", "KNOWN_GAP")), "a CONFIRMED possession resting on a known gap is refused"); t.ok(fails(poss("CONFIRMED", "UNVERIFIED")), "nor on unverified coverage"); t.ok(fails(poss("CALCULATED", "UNVERIFIED")), "CALCULATED continuity over unverified days is refused");
  t.ok(!fails(poss("INFERRED", "UNVERIFIED")), "continuity over unverified days is INFERRED, with its coverage shown"); t.ok(!fails(poss("CONFIRMED", "VERIFIED_COMPLETE")), "CONFIRMED needs a verified interval");
  // the query plans of the design's hot paths use the indexes the document defines
  const plan = (sql) => db.prepare(`explain query plan ${sql}`).all().map((r) => r.detail).join(" | ");
  t.match(plan("select * from lr_trade_leg where asset_key = 'x' order by ts"), /USING (COVERING )?INDEX lr_leg_asset/);
  t.match(plan("select * from lr_possession where franchise_id = '0001' order by from_ts limit 100"), /USING (COVERING )?INDEX lr_poss_franchise/);
  t.match(plan("select * from lr_link where from_asset_key = 'x' and valid_from_run <= 1"), /USING (COVERING )?INDEX lr_(link_asset|one_open_link)/);
  t.match(plan("select * from lr_draft_slot where season = 2018 and round = 4"), /USING (COVERING )?INDEX|PRIMARY KEY/);
  db.close();
});

// ── the approved local export package (requests A1-A4; Keith's rulings of 2026-11-21): the runner, the sanitizer and their guarantees ─────────────────────────────────────────────────────────────────
const PKG = path.join(ROOT, "scripts", "league_record", "s1", "export_package");
const RUNNER = path.join(PKG, "run_a1_a4.sh");
const tx = (over = {}) => ({ franchise: "0005", franchise2: "0008", franchise1_gave_up: "14836,", franchise2_gave_up: "16583,FP_0008_2026_1,BB_3000.00,", comments: "PRIVATE-COMMENT", expires: "1743681600", timestamp: "1740414405", type: "TRADE", ...over });
const txBody = (list) => JSON.stringify({ version: "1.0", encoding: "utf-8", transactions: list.length ? { transaction: list } : "" });
const fpBody = (ids, over = {}) => JSON.stringify({ version: "1.0", futureDraftPicks: { franchise: ids.map((id) => ({ id, futureDraftPick: [{ year: "2027", round: "1", originalPickFor: id, description: "PRIVATE-DESCRIPTION", ...over }] })) } });
const LEAGUE = ["0005", "0008", "0009", "0010"];
const trades25 = txBody([tx(), tx({ franchise: "0009", franchise2: "0010", franchise1_gave_up: "DP_3_11,", franchise2_gave_up: "17000,", timestamp: "1750000000", comments: "" })]);
const trades26 = txBody([tx({ timestamp: "1775000000" })]);
const mkdir = () => fs.mkdtempSync(path.join(os.tmpdir(), "lr-pkg-"));

test("the approved export package: the runner sends exactly the four approved GET requests, with no key on any command line, and stops at the first problem (curl is a stub; no network)", () => {
  const src = fs.readFileSync(RUNNER, "utf8");
  // the request list in the runner is exactly the approved set, and equals the approved document
  const rows = [...src.matchAll(/^  '([A-Z]\d_[^|']+)\|(\d{4})\|([^']+)'$/gm)].map((m) => ({ name: m[1], year: Number(m[2]), pathq: m[3] }));
  t.deepEqual(rows, APPROVED.map((a) => ({ name: a.name, year: a.year, pathq: a.pathq })), "the runner and the sanitizer hold the same four requests");
  t.equal(APPROVED.length, 4);
  const doc = fs.readFileSync(path.join(ROOT, "docs", "league_record", "S1_MFL_EXPORT_REQUESTS.md"), "utf8");
  for (const a of APPROVED) t.ok(doc.includes(`GET https://${a.host}${a.pathq}&APIKEY=`), `${a.name} is in the approved request document`);
  t.ok(APPROVED.every((a) => a.host === "www48.myfantasyleague.com" && /^\/(2025|2026)\/export\?TYPE=(transactions|futureDraftPicks)&L=74598&/.test(a.pathq) && !/COUNT=|DAYS=|import/i.test(a.pathq)), "every request is a 2025 or 2026 export of league 74598, with no COUNT, DAYS or import");
  // the script never builds a mutating call and never follows a redirect
  const code = src.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
  const curlCall = (code.match(/curl --silent[\s\S]*?--config -\)/) || [""])[0];                         // the one curl invocation, with its continuation line
  t.ok(curlCall.length > 50 && (code.match(/\bcurl --/g) || []).length === 1, "exactly one curl invocation");
  t.ok(!/(^|\s)-X\b|--data|\s-d\s|--form|\s-F\s|--upload|\s-T\s|--location|\s-L\s|--post|--request/.test(curlCall), "no mutating option and no redirect following in the curl call");
  t.ok(!/\bwget\b|\bnc\b|\bssh\b|\bscp\b/.test(code), "no other network tool");
  t.ok(/--max-redirs 0/.test(code) && /--config -/.test(code) && /read -r -s/.test(code), "redirects refused, key on stdin, keys read without echo");
  t.ok(!/printenv|\benv\b|\bsecurity (find|dump)|\bsecret-tool|\bop (read|item)|gh auth|git config|git credential|\.env\b|\bsource\b|\$\{?(MFL_|APIKEY|TOKEN)/i.test(code), "no credential is fetched from the environment, a keychain, a password manager or a repository");
  t.ok(!/APIKEY=\$|APIKEY=\$\{/.test(code), "the key is never placed on a command line");
  // --print: shows the requests, redacted, reads nothing, uses no network
  const pr = spawnSync("bash", [RUNNER, "--print"], { encoding: "utf8" });
  t.equal(pr.status, 0); t.equal((pr.stdout.match(/GET https:/g) || []).length, 4); t.ok(pr.stdout.includes("APIKEY=REDACTED") && !/APIKEY=(?!REDACTED)/.test(pr.stdout));
  // a stub curl records what it is given
  const dir = mkdir(), stubDir = path.join(dir, "stub"), bin = path.join(dir, "bin"); fs.mkdirSync(stubDir); fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "curl"), `#!/usr/bin/env bash
out=""; args="$*"
while [ $# -gt 0 ]; do case "$1" in --output) out="$2"; shift;; esac; shift; done
n=$(cat "${stubDir}/n" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "${stubDir}/n"
cfg=$(cat)
printf 'ARGS: %s\\n' "$args" >> "${stubDir}/log"; printf 'STDIN: %s\\n' "$cfg" >> "${stubDir}/log"
env | sort > "${stubDir}/env$n"
code=$(echo $STUB_CODES | cut -d' ' -f$n)
cp "${stubDir}/body$n" "$out"
printf '%s' "$code"
`, { mode: 0o755 });
  const bodies = [trades25, trades26, fpBody(LEAGUE), fpBody(LEAGUE)];
  const run = (codes, keys = "KEY2025SECRET\nKEY2026SECRET\n", out = path.join(dir, "out"), bodyList = bodies) => {
    fs.rmSync(stubDir, { recursive: true, force: true }); fs.mkdirSync(stubDir); bodyList.forEach((b, i) => fs.writeFileSync(path.join(stubDir, `body${i + 1}`), b));
    fs.rmSync(out, { recursive: true, force: true });
    const r = spawnSync("bash", [RUNNER], { input: keys, encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, OUT: out, STUB_CODES: codes } });
    const log = fs.existsSync(path.join(stubDir, "log")) ? fs.readFileSync(path.join(stubDir, "log"), "utf8") : "";
    return { r, log, out };
  };
  // an inherited, exported key variable of the same name must never reach a child process, and neither must the typed key
  fs.rmSync(stubDir, { recursive: true, force: true });
  { const env = { ...process.env, KEY_2025: "ENVLEAK2025", KEY_2026: "ENVLEAK2026", _LR_K2025: "ENVLEAK3", _LR_K2026: "ENVLEAK4", _lr_key: "ENVLEAK5", _lr_enc: "ENVLEAK6", key: "ENVLEAK7", enc: "ENVLEAK8", k: "ENVLEAK9", v: "ENVLEAK10" };    // every name the script has ever used for a key, exported by the caller
    const r0 = (() => { fs.mkdirSync(stubDir); bodies.forEach((b, i) => fs.writeFileSync(path.join(stubDir, `body${i + 1}`), b)); return spawnSync("bash", [RUNNER], { input: "KEY2025SECRET\nKEY2026SECRET\n", encoding: "utf8", env: { ...env, PATH: `${bin}:${process.env.PATH}`, OUT: path.join(dir, "out-env"), STUB_CODES: "200 200 200 200" } }); })();
    t.equal(r0.status, 0);
    for (let i = 1; i <= 4; i++) { const e = fs.readFileSync(path.join(stubDir, `env${i}`), "utf8"); t.ok(!/^(KEY_2025|KEY_2026|_LR_K2025|_LR_K2026|_lr_key|_lr_enc|key|enc|k|v)=/m.test(e) && !/ENVLEAK|KEY2025SECRET|KEY2026SECRET/.test(e), `child ${i}: no key variable, inherited or typed, in its environment`); }
    t.ok(!/ENVLEAK|KEY2025SECRET|KEY2026SECRET/.test(r0.stdout + r0.stderr), "no key printed"); }
  // all four succeed
  let a = run("200 200 200 200");
  t.equal(a.r.status, 0, "four clean responses: success");
  const argLines = a.log.split("\n").filter((l) => l.startsWith("ARGS:")), cfgLines = a.log.split("\n").filter((l) => l.startsWith("STDIN:"));
  t.equal(argLines.length, 4); t.equal(cfgLines.length, 4);
  t.ok(!/KEY2025SECRET|KEY2026SECRET/.test(argLines.join("\n")), "no key on any command line (the process list would show it)");
  t.ok(!/KEY2025SECRET|KEY2026SECRET/.test(a.r.stdout + a.r.stderr), "no key in any printed line");
  t.ok(argLines.every((l) => l.includes("--max-redirs 0") && l.includes("--config -") && !/--location|--data|-X /.test(l)), "every call is a plain GET with redirects refused");
  t.deepEqual(cfgLines.map((l) => l.replace(/^STDIN: url = "https:\/\//, "").replace(/&APIKEY=.*$/, "")), APPROVED.map((x) => `${x.host}${x.pathq}`), "the four URLs sent are exactly the approved ones, in order");
  t.ok(cfgLines[0].includes("KEY2025SECRET") && cfgLines[1].includes("KEY2026SECRET") && cfgLines[2].includes("KEY2025SECRET") && cfgLines[3].includes("KEY2026SECRET"), "each instance gets its own key, and only on stdin");
  t.ok(!/KEY\d{4}SECRET/.test(fs.readFileSync(path.join(a.out, "requests.log"), "utf8")), "the request log holds no key");
  t.equal(fs.readFileSync(path.join(a.out, "requests.log"), "utf8").trim().split("\n").length, 4);
  t.equal(fs.statSync(path.join(a.out, "raw")).mode & 0o777, 0o700, "the raw folder is private (700)"); t.equal(fs.statSync(path.join(a.out, "raw", "A1_transactions_2025_trade.json")).mode & 0o777, 0o600, "raw files are 600");
  // the sanitizer accepts exactly what the runner recorded
  const s = sanitizeRun(a.out);
  t.equal(s.exit, 0); t.equal(s.manifest.status, "completed");
  // a redirect stops everything after it
  a = run("200 302 200 200"); t.equal(a.r.status, 1, "a redirect stops the run"); t.equal(a.log.split("\n").filter((l) => l.startsWith("ARGS:")).length, 2, "no request is sent after the failing one"); t.ok(/stop and report/.test(a.r.stderr));
  a = run("401 200 200 200"); t.equal(a.r.status, 1, "an authorization failure stops at the first request"); t.equal(a.log.split("\n").filter((l) => l.startsWith("ARGS:")).length, 1);
  // an MFL error body inside an HTTP 200 stops too
  a = run("200 200 200 200", undefined, undefined, [trades25, JSON.stringify({ error: { $t: "API requests per minute exceeded" } }), fpBody(LEAGUE), fpBody(LEAGUE)]); t.equal(a.r.status, 1, "an error body is not data"); t.ok(/error body/.test(a.r.stderr));
  // a bad key is refused before any request
  a = run("200 200 200 200", "has a space\nKEY2026SECRET\n"); t.equal(a.r.status, 1); t.equal(a.log, "", "no request is sent with a malformed key");
  // the output folder may never be inside a git work tree
  a = run("200 200 200 200", undefined, path.join(ROOT, "tmp-should-never-exist")); t.equal(a.r.status, 1); t.ok(/git work tree|outside the repository/.test(a.r.stderr)); t.ok(!fs.existsSync(path.join(ROOT, "tmp-should-never-exist")), "nothing is created inside the repository");
  // the git guard on its own: a folder inside any git work tree is refused, and nothing is created there
  const gitDir = path.join(dir, "somerepo"); fs.mkdirSync(gitDir); spawnSync("git", ["init", "-q", gitDir]);
  a = run("200 200 200 200", undefined, path.join(gitDir, "exports")); t.equal(a.r.status, 1); t.ok(/git work tree/.test(a.r.stderr), "refused inside a git work tree"); t.ok(!fs.existsSync(path.join(gitDir, "exports")), "nothing created there");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("the sanitizer keeps only what is needed, drops comments, descriptions, expiry and unrecognized records, and stops on anything unexpected (synthetic data only)", () => {
  const stops = (fn, re) => { try { fn(); return false; } catch (e) { return e instanceof StopError && re.test(e.message); } };
  const a = sanitizeTransactions(trades25, { year: 2025, name: "A1" });
  t.equal(a.report.kept, 2); t.equal(a.report.comments_dropped, 1); t.equal(a.report.expires_dropped, 2);
  t.ok(!/PRIVATE-COMMENT|expires/.test(JSON.stringify(a.records)), "no comment and no expiry in the extract");
  t.deepEqual(a.records[0], { ts: 1740414405, franchise: "0005", franchise2: "0008", gave_up_by_franchise: ["14836"], gave_up_by_franchise2: ["16583", "FP_0008_2026_1", "BB_3000.00"] }, "a decimal cap token is kept exactly as recorded");
  // pending offers and unrecognized records are dropped and counted, never kept
  const pending = { type: "TRADE", franchise: "0005", offeringteam: "0005", will_give_up: "1,2,", will_receive: "3,", comments: "PRIVATE-PENDING" };
  const p = sanitizeTransactions(txBody([tx(), pending]), { year: 2025 });
  t.equal(p.report.kept, 1); t.equal(p.report.dropped_unrecognized_shape, 1); t.ok(!/PRIVATE-PENDING|offeringteam/.test(JSON.stringify(p)), "a pending offer never reaches the extract");
  // an empty export is reported as empty and never as proof
  const e = sanitizeTransactions(txBody([]), { year: 2025 }); t.equal(e.report.empty_export, true); t.equal(e.report.kept, 0);
  // unexpected situations stop
  t.ok(stops(() => sanitizeTransactions("not json", { year: 2025 }), /not JSON/), "not JSON");
  t.ok(stops(() => sanitizeTransactions(JSON.stringify({ error: "x" }), { year: 2025 }), /error object/), "an error object");
  t.ok(stops(() => sanitizeTransactions(JSON.stringify({ transactions: "", extra: 1 }), { year: 2025 }), /unexpected top-level/), "an unexpected top-level field");
  t.ok(stops(() => sanitizeTransactions(txBody([tx({ timestamp: "1640000000" })]), { year: 2025 }), /outside 2025/), "a trade outside the instance year: a different instance");
  t.ok(stops(() => sanitizeTransactions(txBody([tx({ type: "FREE_AGENT" })]), { year: 2025 }), /not TRADE/), "a non-trade record in a trade-only export");
  t.ok(stops(() => sanitizeTransactions(txBody([tx({ franchise2_gave_up: "WEIRD_TOKEN," })]), { year: 2025 }), /unknown shape/), "an unknown token");
  // a STOP message holds a fixed label and counts only: private text in a token, a field name or a malformed body is never echoed
  const msgOf = (fn) => { try { fn(); return ""; } catch (e) { return String(e.message); } };
  t.ok(!/PRIVATE-TOKEN/.test(msgOf(() => sanitizeTransactions(txBody([tx({ franchise2_gave_up: "PRIVATE-TOKEN-john@example.com," })]), { year: 2025 }))), "an unknown token is not printed");
  t.ok(!/PRIVATE-FIELD/.test(msgOf(() => sanitizeTransactions(JSON.stringify({ transactions: "", "PRIVATE-FIELD": 1 }), { year: 2025 }))), "an unexpected top-level field name is not printed");
  t.ok(!/PRIVATE-FIELD/.test(msgOf(() => sanitizeFuturePicks(JSON.stringify({ futureDraftPicks: {}, "PRIVATE-FIELD": 1 }), { year: 2025 }))), "nor in a future-pick response");
  t.ok(!/PRIVATE-BODY/.test(msgOf(() => sanitizeTransactions("PRIVATE-BODY {not json", { year: 2025 }))), "a malformed body is not quoted");
  t.equal(sanitizeTransactions(txBody([tx({ franchise2: "0005" })]), { year: 2025 }).report.dropped_unrecognized_shape, 1, "a trade with itself is dropped");
  // future picks
  const f = sanitizeFuturePicks(fpBody(LEAGUE), { year: 2025 }); t.equal(f.report.picks, 4); t.equal(f.report.fields_dropped, 4); t.ok(!/PRIVATE-DESCRIPTION/.test(JSON.stringify(f)), "no description kept");
  t.deepEqual(f.picks[0], { holder: "0005", year: 2027, round: 1, original: "0005" });
  t.ok(stops(() => sanitizeFuturePicks(JSON.stringify({ futureDraftPicks: { franchise: [{ id: "0005", futureDraftPick: [{ year: "2027", round: "1" }] }] } }), { year: 2025 }), /original franchise/), "a pick without originalPickFor stops: no default is substituted");
  t.ok(stops(() => sanitizeFuturePicks(JSON.stringify({ nothing: 1 }), { year: 2025 }), /unexpected top-level|no "futureDraftPicks"/), "no future-pick object");
  t.equal(sanitizeFuturePicks(JSON.stringify({ futureDraftPicks: {} }), { year: 2025 }).report.empty_export, true, "an empty future-pick list is reported as empty");
  // source identity
  t.ok(stops(() => checkIdentity(a.report, sanitizeFuturePicks(fpBody(["0005", "0008"]), { year: 2025 }).report, "2025 instance"), /not franchises of the league/), "trades whose franchises are not in the league's future-pick list: a different league");
  t.ok(stops(() => checkIdentity(a.report, sanitizeFuturePicks(JSON.stringify({ futureDraftPicks: {} }), { year: 2025 }).report, "2025 instance"), /cannot be checked/), "no franchise list: identity cannot be checked");
  // the run record must match the approved request exactly
  const spec = APPROVED[0], good = { name: spec.name, host: spec.host, pathq: spec.pathq, code: 200, bytes: 10, captured_utc: "2026-11-22T12:00:00Z" };
  checkRequestRecord(spec, good, 10);
  t.ok(stops(() => checkRequestRecord(spec, undefined, 10), /no record/), "a missing run record");
  t.ok(stops(() => checkRequestRecord(spec, { ...good, pathq: spec.pathq.replace("TRADE", "*") }, 10), /differs from the approved/), "a request that is not the approved one");
  t.ok(stops(() => checkRequestRecord(spec, { ...good, host: "www45.myfantasyleague.com" }, 10), /differs from the approved/), "another host");
  t.ok(stops(() => checkRequestRecord(spec, { ...good, code: 302 }, 10), /not 200/), "a redirect");
  t.ok(stops(() => checkRequestRecord(spec, good, 11), /size differs/), "a changed file");
  t.equal(readRequestLog("A1\th\tp\t200\t5\t2026-11-22T12:00:00Z\n").get("A1").bytes, 5);
  // a whole run: dropped records give exit 3 with the manifest, a stop writes nothing shareable
  const dir = mkdir(), raw = path.join(dir, "raw"); fs.mkdirSync(raw);
  const bodies = [txBody([tx(), { type: "TRADE", franchise: "0005", offeringteam: "0005" }]), trades26, fpBody(LEAGUE), fpBody(LEAGUE)];
  let logText = ""; APPROVED.forEach((x, i) => { fs.writeFileSync(path.join(raw, `${x.name}.json`), bodies[i]); logText += `${x.name}\t${x.host}\t${x.pathq}\t200\t${Buffer.byteLength(bodies[i])}\t2026-11-22T12:00:0${i}Z\n`; });
  fs.writeFileSync(path.join(dir, "requests.log"), logText);
  const run = sanitizeRun(dir); t.equal(run.exit, 3); t.equal(run.manifest.status, "completed_with_dropped_records");
  const man = fs.readFileSync(path.join(dir, "manifest.json"), "utf8");
  t.ok(!/PRIVATE-|KEY|APIKEY=(?!REDACTED)/.test(man + fs.readdirSync(path.join(dir, "sanitized")).map((f) => fs.readFileSync(path.join(dir, "sanitized", f), "utf8")).join("")), "nothing private in the manifest or the sanitized extract");
  t.ok(man.includes("UNKNOWN") && man.includes("CURRENT dated observation") && man.includes("EMPTY export does not establish"), "the manifest states what A3, A4 and an empty export do and do not show");
  t.deepEqual(run.manifest.requests.map((r) => r.request), APPROVED.map((x) => x.name)); t.ok(run.manifest.requests.every((r) => r.key === "REDACTED" && /^[0-9a-f]{64}$/.test(r.raw_sha256)));
  fs.rmSync(dir, { recursive: true, force: true });
  // the command line: a stop prints a fixed label only, and any other failure prints no message and no stack
  { const d2 = mkdir(), r2 = path.join(d2, "raw"); fs.mkdirSync(r2);
    let log2 = ""; APPROVED.forEach((x, i) => { const b = i === 0 ? JSON.stringify({ transactions: { transaction: [tx({ franchise2_gave_up: "PRIVATE-TOKEN," })] } }) : bodies[i]; fs.writeFileSync(path.join(r2, `${x.name}.json`), b); log2 += `${x.name}\t${x.host}\t${x.pathq}\t200\t${Buffer.byteLength(b)}\t2026-11-22T12:00:0${i}Z\n`; });
    fs.writeFileSync(path.join(d2, "requests.log"), log2);
    const cli = spawnSync("node", ["--no-warnings", path.join(PKG, "sanitize_exports.mjs"), "--dir", d2], { encoding: "utf8" });
    t.equal(cli.status, 2); t.ok(/^STOP: /.test(cli.stderr) && !/PRIVATE-TOKEN|at file:|node:internal/.test(cli.stdout + cli.stderr), "the command line prints a fixed label and no content or stack");
    // an error that is NOT a StopError (here: the output folder cannot be created because a file stands where it must go) prints a fixed label and no path, message or stack
    let log3 = ""; APPROVED.forEach((x, i) => { fs.writeFileSync(path.join(r2, `${x.name}.json`), bodies[i]); log3 += `${x.name}\t${x.host}\t${x.pathq}\t200\t${Buffer.byteLength(bodies[i])}\t2026-11-22T12:00:0${i}Z\n`; });
    fs.writeFileSync(path.join(d2, "requests.log"), log3); fs.writeFileSync(path.join(d2, "sanitized"), "x");
    const cliErr = spawnSync("node", ["--no-warnings", path.join(PKG, "sanitize_exports.mjs"), "--dir", d2], { encoding: "utf8" });
    t.equal(cliErr.status, 2); t.match(cliErr.stderr, /unexpected internal error/); t.ok(!/EEXIST|ENOTDIR|mkdir|lr-pkg|at file:|node:internal/.test(cliErr.stdout + cliErr.stderr), "no path, system message or stack");
    fs.rmSync(path.join(d2, "sanitized")); fs.writeFileSync(path.join(d2, "requests.log"), "garbage");
    const cli2 = spawnSync("node", ["--no-warnings", path.join(PKG, "sanitize_exports.mjs"), "--dir", d2], { encoding: "utf8" });
    t.equal(cli2.status, 2); t.ok(!/at file:|node:internal|Error:/.test(cli2.stdout + cli2.stderr), "a missing or garbled record prints no stack");
    fs.rmSync(d2, { recursive: true, force: true }); }
  // the sanitizer reads and writes only the folder it is given (no network, no repository path)
  const ssrc = fs.readFileSync(path.join(PKG, "sanitize_exports.mjs"), "utf8").split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
  t.ok(!/fetch\(|https?\.request|node:http|node:net|child_process|process\.env/.test(ssrc), "no network, no subprocess, no environment");
});

test("the cap-token correction (register LR-05): decimal cap tokens are read exactly, from the sender's own token, only when unambiguous; raw records and populated amounts are never altered", () => {
  // the two 2025 trades whose archive amount is blank: their amounts, their direction and the 2025 total
  const blank = q("select trade_group_id g, franchise_id f, asset_role r, asset_capadjustment c from transactions_trades where asset_type = 'CAP' and asset_capadjustment is null order by 1, 3");
  t.equal(blank.length, 4, "four blank archive rows = two transfers"); t.deepEqual([...new Set(blank.map((b) => b.g))].sort(), ["trade2025_35", "trade2025_60"]);
  const trades = loadArchiveTrades(archive);
  const t35 = trades.find((x) => x.id === "trade2025_35"), t60 = trades.find((x) => x.id === "trade2025_60");
  t.equal(t35.cap.length, 1); t.equal(t35.cap[0].amount, 3000); t.equal(t35.cap[0].from, "0006"); t.equal(t35.cap[0].to, "0010"); t.equal(t35.cap[0].amount_source, "raw_token"); t.equal(t35.cap[0].token, "BB_3000.00");
  t.equal(t60.cap[0].amount, 5000); t.equal(t60.cap[0].from, "0006"); t.equal(t60.cap[0].to, "0011"); t.equal(t60.cap[0].token, "BB_5000.00");
  t.equal(seasonOf(2025).trades.cap.total_amount, 274000 + 8000, "the 2025 aggregate is no longer understated by 8,000"); t.equal(seasonOf(2025).trades.cap.transfers, 22, "no transfer is added or removed");
  t.equal(x.summary.cap_total, 1692000 + 8000); t.equal(x.summary.cap_transfers, 130); t.equal(x.summary.cap_amounts_from_raw_token, 2); t.equal(x.summary.cap_amounts_unrecoverable, 0);
  t.equal(x.findings.totals.cap_amount_from_raw_token, 2); t.equal(x.findings.totals.cap_amount_conflicts, 0); t.equal(x.findings.totals.cap_amount_unrecoverable, 0);
  // validation of the method on the 128 populated transfers: reading the sender's raw token reproduces the archive column EXACTLY, so the method is not a guess
  const rows = q("select franchise_id f, cast(asset_capadjustment as real) c, json_extract(raw_json, '$.franchise') jf1, json_extract(raw_json, '$.franchise1_gave_up') jg1, json_extract(raw_json, '$.franchise2_gave_up') jg2 from transactions_trades where asset_type = 'CAP' and asset_role = 'RELINQUISH' and asset_capadjustment is not null");
  t.equal(rows.length, 128); let agree = 0;
  for (const r of rows) { const fromToken = capAmount({ ...r, cap: null }); if (fromToken.source === "raw_token" && fromToken.amount === r.c) agree += 1; }
  t.equal(agree, 128, "the raw-token reading equals the populated archive amount in all 128 cases");
  for (const r of rows) t.equal(capAmount({ ...r, cap: r.c }).source, "archive_column", "a populated amount is never replaced");
  // the grammar: exact decimals only, malformed tokens refused, nothing guessed
  t.deepEqual(parseCapToken("BB_3000.00"), { amount: 3000, fractional: false, token: "BB_3000.00" }); t.equal(parseCapToken("BB_3000").amount, 3000); t.deepEqual(parseCapToken("BB_3000.5"), { amount: 3000.5, fractional: true, token: "BB_3000.5" });
  for (const bad of ["BB_", "BB_-5", "BB_1e3", "BB_3.0.0", "BB_3,000", "BB_ 5", "bb_5", "BB_.5", "BB_1234567890", "BB_5.1234567", "BB_NaN", "FP_0001_2026_1", ""]) t.equal(parseCapToken(bad), null, `refused: ${JSON.stringify(bad)}`);
  t.deepEqual(parseTokens("14836,BB_3000.00,", 2025).map((k) => k.kind), ["player", "cap"], "the 2026 snapshot parser reads a decimal cap token too"); t.equal(parseTokens("BB_3000.00", 2025)[0].amount, 3000); t.equal(parseTokens("BB_3.0.0", 2025)[0].kind, "unknown");
  // a stub archive: ambiguous, malformed, absent and conflicting cases are never defaulted
  const row = (over) => ({ transactionid: "t.1a", g: "tradeX_1", season: 2025, f: "0001", fname: "A", role: "RELINQUISH", t: "CAP", pid: null, pname: null, ds: null, dr: null, dov: null, ff: null, fy: null, fr: null, cap: null, ts: 1740000000, date_et: "2025-02-19", time_et: "12:00:00", jf1: "0001", jg1: "BB_3000.00,", jg2: "5,", ...over });
  const pair = (a) => [row(a), row({ ...a, transactionid: "t.1b", f: "0002", fname: "B", role: "ACQUIRE" })];
  const load = (a) => loadArchiveTrades({ all: () => pair(a) })[0].cap[0];
  t.equal(load({}).amount, 3000); t.equal(load({}).amount_source, "raw_token");
  t.equal(load({ jg1: "BB_3000.00,BB_100," }).amount, null, "two cap tokens in the sender's list are ambiguous"); t.equal(load({ jg1: "BB_3000.00,BB_100," }).amount_source, "unrecoverable"); t.match(load({ jg1: "BB_3000.00,BB_100," }).problem, /several/);
  t.equal(load({ jg1: "BB_3.0.0," }).amount, null, "a malformed token is refused"); t.equal(load({ jg1: "5," }).amount, null, "no cap token: no default"); t.match(load({ jg1: "5," }).problem, /no cap token/);
  t.equal(load({ f: "0001", jf1: "0002", jg2: "BB_7000.00," }).amount, 7000, "the sender's own list is read: franchise 0001 is franchise2 here"); t.equal(load({ jg1: "BB_9999," }).amount, 9999);
  t.equal(load({ f: "0001", jf1: "0002", jg1: "BB_1,", jg2: "5," }).amount, null, "the other side's token is never used");
  t.equal(load({ cap: 100, jg1: "BB_3000.00," }).amount, 100, "a populated amount wins"); t.equal(load({ cap: 100, jg1: "BB_3000.00," }).conflict_token, "BB_3000.00", "and a disagreement is recorded, never silently resolved");
  t.equal(load({ cap: 3000, jg1: "BB_3000.00," }).conflict_token, undefined, "agreement records nothing");
  t.equal(load({ jg1: "BB_3000.5," }).fractional, true, "a fractional amount is flagged");
  // the raw archive is not altered and the correction is a read-only derivation
  t.equal(q("select count(*) n from transactions_trades where asset_type = 'CAP' and asset_capadjustment is null")[0].n, 4, "the blank archive rows are still blank");
});

await run("league_record_s1_archive");
raw.close();
archive.close();
