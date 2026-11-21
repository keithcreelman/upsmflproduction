// League Record S1, Step 1b: tests of the 2010-2025 archive extraction. Offline and read-only: the committed archive only. Every count is re-derived here with separate SQL against the
// decompressed archive (a different code path from the extraction), representative older periods are checked trade by trade, and the standing rule (no slot from standings, finishes,
// brackets or a projected order) is tested at the guard, the source scan and the data.
import fs from "node:fs";
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
import { loadArchiveSelections } from "../scripts/league_record/s1/sources.mjs";

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

test("representative older periods: 2012 (first draft), 2014 (legacy draft with the slot defect and the one conflict), 2018 (MFL draft table starts, one slot missing), 2022 (largest package)", () => {
  // 2012: sixty legacy selections, five rounds of twelve
  t.equal(seasonOf(2012).draft.selections, 60); t.equal(seasonOf(2012).draft.rounds, 5); t.equal(seasonOf(2012).draft.source_table, "draftresults_legacy");
  // the legacy slot defect: pick 1.10 of 2014 is stored with slot 1 and raw text "1.1"; MFL's overall pick number is 10
  const stored = q("select draftpick_roundorder ro, draftpick_overall ov, raw_pick rp, player_name n from draftresults_legacy where season = 2014 and draftpick_round = 1 and draftpick_overall = 10")[0];
  t.equal(stored.ro, 1); t.equal(stored.rp, "1.1"); t.equal(stored.n, "West, Terrance");
  const sels = loadArchiveSelections(archive).filter((s) => s.year === 2014 && s.round === 1);
  const ten = sels.find((s) => s.slot === 10);
  t.ok(ten && ten.player_name === "West, Terrance" && ten.slot_correction.stored_slot === 1 && ten.slot_correction.rule === "legacy_slot_from_overall_pick");
  t.equal(sels.filter((s) => s.slot === 1).length, 1, "slot 1 is no longer duplicated");
  t.equal(x.summary.legacy_slot_corrections, 30, "five rounds in each of six legacy years");
  for (const y of [2012, 2013, 2014, 2015, 2016, 2017]) t.deepEqual(seasonOf(y).draft.missing_slots, [], `${y} has every slot after the correction`);
  // the single conflict: 4.12 of 2014 was moved to 0004 by trade2014_4 but the draft result records 0006
  t.equal(x.findings.lists.slot_conflicts.length, 1);
  const c = x.findings.lists.slot_conflicts[0];
  t.deepEqual([c.asset, c.selector, c.chain_holder_at_selection, c.trades], ["spick:2014:4:12", "0006", "0004", ["trade2014_4"]]);
  t.deepEqual(q("select franchise_id f, asset_role r from transactions_trades where trade_group_id = 'trade2014_4' and asset_draftpick_round = 4 and asset_draftpick_overall = 11").map((r) => `${r.f}:${r.r}`).sort(), ["0004:ACQUIRE", "0008:RELINQUISH"]);
  t.equal(q("select franchise_id f from draftresults_legacy where season = 2014 and draftpick_round = 4 and draftpick_overall = 48")[0].f, "0006");
  // 2018: first season of MFL's own table; 4.12 is absent from it
  t.equal(seasonOf(2018).draft.source_table, "draftresults_mfl"); t.deepEqual(seasonOf(2018).draft.missing_slots, ["4.12"]);
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
  }
  t.equal(f.inferred, 0, "no archive-year future pick meets every condition under the approved rule");
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
  t.ok(/overall - 12 \* \(Number\(r\.round\) - 1\)|Number\(r\.overall\) - 12 \* \(Number\(r\.round\) - 1\)/.test(src));
});

test("gaps and conflicts are listed, not repaired: the named gap, quiet windows, chain breaks and draft-table defects are all in the extraction", () => {
  t.deepEqual({ from: x.named_gap.from, to: x.named_gap.to }, { from: "2025-11-28", to: "2026-03-07" });
  t.ok(x.coverage_windows.length > 5);
  t.equal(x.findings.totals.pick_chain_discontinuities, x.summary.pick_chain_discontinuities);
  t.ok(x.summary.player_chain_breaks.implicit_release > 0 && x.summary.player_chain_breaks.discontinuity > 0);
  t.ok(x.findings.lists.player_chain_breaks.length <= x.findings.list_cap);
  t.equal(x.findings.totals.player_chain_breaks, x.summary.player_chain_breaks.discontinuity + x.summary.player_chain_breaks.implicit_release, "findings and summary count the same 2010-2025 breaks");
  t.ok(x.findings.outside_the_stated_period.player_chain_breaks_dated_after_2025 > 0, "breaks dated 2026 are disclosed apart, not mixed into the 2010-2025 counts");
  t.equal(x.findings.totals.draft_gaps, 1, "only 2018's 4.12 is missing after the legacy correction");
  const rep = renderArchiveReport(x);
  for (const w of ["named source-coverage gap", "2025-11-28", "Quiet windows", "implicit releases", "selector not recorded", "slot_correction", "dated 2026"]) t.ok(rep.toLowerCase().includes(w.toLowerCase()), w);
  // era differences are in the report
  t.match(rep, /processing_time_likely/); t.match(rep, /draftresults_legacy/); t.match(rep, /draftresults_mfl/);
});

await run("league_record_s1_archive");
raw.close();
archive.close();
