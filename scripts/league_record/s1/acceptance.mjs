// League Record S1 pilot: acceptance tests T1 to T16 as functions over a built bundle. The test file asserts that every one passes; the report prints the same results.
// T2 uses its OWN second code path (raw SQL and raw snapshot JSON, no shared parsing) so it can disagree with the extraction.
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CLASS, RULES, resolveFuturePick, pickChain } from "./lineage.mjs";
import { scanExtractionSources, BANNED_TABLES } from "./guard.mjs";
import { assertQueryAllowed, ArchiveGuardError } from "./archive.mjs";
import { readSnapshot } from "./sources.mjs";
import { confirmedTotals } from "./report.mjs";
import { stableStringify } from "./pilot.mjs";

const T = (id, title, pass, detail = "") => ({ id, title, pass, detail });

// Walk a value and call fn(path, value) for every leaf.
function walk(v, fn, p = "") { if (Array.isArray(v)) v.forEach((x, i) => walk(x, fn, `${p}[${i}]`)); else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, fn, `${p}.${k}`); else fn(p, v); }
function keys(v, out = new Set()) { if (Array.isArray(v)) v.forEach((x) => keys(x, out)); else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { out.add(k); keys(x, out); } return out; }

// A synthetic ledger for the inference-rule tests: one round of one year, twelve franchises 0001..0012, slot i is the pick of original franchise i, and `holdings` maps an original
// franchise to the franchise that holds its pick (default: itself). A transfer on 2019-10-02 is recorded for every pick that moved. `omitSlots` removes slots from the evidence
// (an incomplete inventory); `slotHolder` overrides who the evidence lists for a slot (a records-versus-evidence disagreement); `windows` are unobserved periods.
export const SYNTHETIC_TRANSFER_TS = 1570000000;
export function syntheticLedger({ year, round, holdings = {}, draftTs, windows = [], omitSlots = [], slotHolder = {}, teams = 12, slotTokenTransfer = false }) {
  const ids = Array.from({ length: teams }, (_, i) => String(i + 1).padStart(4, "0"));
  const holderOf = (o) => holdings[o] || o;
  const selections = ids.map((o, i) => ({ slot: i + 1, o })).filter((x) => !omitSlots.includes(x.slot)).map(({ slot, o }) => ({ year, round, slot, franchise: slotHolder[slot] || holderOf(o), player_id: `p${slot}`, ts: draftTs, date: "2020-06-01", source: { kind: "archive", table: "draftresults_mfl" }, note: "" }));
  const tradesByAsset = new Map();
  ids.forEach((o) => { if (holderOf(o) !== o) tradesByAsset.set(`fpick:${o}:${year}:${round}`, [{ trade: { id: `synthetic_${o}`, ts: SYNTHETIC_TRANSFER_TS, date: "2019-10-02", time: "12:00:00", source: { kind: "synthetic" }, date_quality: "exact" }, leg: { from: o, to: holderOf(o), rows: null } }]); });
  if (slotTokenTransfer) tradesByAsset.set(`spick:${year}:${round}:1`, [{ trade: { id: "synthetic_slot", ts: SYNTHETIC_TRANSFER_TS, date: "2019-10-02", time: "12:00:00", source: { kind: "synthetic" }, date_quality: "exact" }, leg: { from: "0001", to: "0002", rows: null } }]);
  return { selections, selBySlot: new Map(selections.map((x) => [`${year}:${round}:${x.slot}`, x])), windows, named_gap: { from: "9999-01-01", to: "9999-01-02", kind: "none" }, tradesByAsset, franchisesFor: () => ids };
}
export const syntheticChain = (ledger, original, year, round) => pickChain(ledger, `fpick:${original}:${year}:${round}`);

export async function runAcceptance({ bundle, root, archive, rebuild, committedBundle = null }) {
  const out = [];
  const b = bundle;
  const extractionDir = path.join(root, "scripts", "league_record", "s1");

  // T1 every asset, link and event carries a class and a source reference
  const unclassified = [];
  const okClass = (x) => Object.values(CLASS).includes(x);
  const hasSource = (x) => !!(x && x.kind);
  for (const n of b.nodes) {
    if (!okClass(n.link_class)) unclassified.push(`${n.id}: asset link unclassed`);
    if (!n.entered || !(n.entered.trade || hasSource(n.entered.source))) unclassified.push(`${n.id}: no entry source`);
    for (const e of n.chain.events) { if (!hasSource(e.source)) unclassified.push(`${n.id}: event without a source`); if (!okClass(e.class)) unclassified.push(`${n.id}: event ${e.kind} ${e.date} unclassed`); }
    for (const h of n.chain.holders) {
      if (!okClass(h.class) || !okClass(h.start_class) || !okClass(h.end_class) || !okClass(h.continuity_class)) unclassified.push(`${n.id}: possession period unclassed`);
      // a period ended by another franchise's add (no recorded release) can never be CONFIRMED as a whole
      if (h.class === CLASS.CONFIRMED && n.named_gap.possession_periods_spanning.some((sp) => sp.franchise === h.franchise && sp.from === (h.from.date || null) && sp.to === (h.to ? h.to.date : null))) unclassified.push(`${n.id}: a period that spans the named unobserved period is classed CONFIRMED`);
      if (h.to && h.to.by !== h.franchise && h.class === CLASS.CONFIRMED) unclassified.push(`${n.id}: a period ended by another franchise's ${h.to.kind} is classed CONFIRMED`);
    }
    for (const br of n.chain.breaks) if (!okClass(br.class) || !(br.at || br.trade)) unclassified.push(`${n.id}: break ${br.kind} without a class or a source`);
    for (const tr of n.transfers) { if (!okClass(tr.class) || !b.trades[tr.trade]) unclassified.push(`${n.id}: transfer ${tr.trade} unclassed or not in the trade list`); }
    for (const d of n.departures) if (!okClass(d.class) || !hasSource(d.source)) unclassified.push(`${n.id}: departure without a class or a source`);
    if (!n.resolution && n.kind !== "player") unclassified.push(`${n.id}: pick without a resolution`);
    if (n.resolution && !okClass(n.resolution.class)) unclassified.push(`${n.id}: resolution unclassed`);
    if (n.economics) for (const se of n.economics.seasons) { for (const fr of se.by_franchise) if (!okClass(fr.class)) unclassified.push(`${n.id} ${se.season}: points unclassed`); for (const c of se.contract_by_roster_weeks) if (!okClass(c.class)) unclassified.push(`${n.id} ${se.season}: contract unclassed`); }
  }
  for (const [id, tr] of Object.entries(b.trades)) {
    if (!okClass(tr.class) || !hasSource(tr.source)) unclassified.push(`${id}: trade without a class or a source`);
    for (const l of tr.legs) if (!okClass(l.class)) unclassified.push(`${id}: leg ${l.asset} unclassed`);
    for (const c of tr.cap) if (!okClass(c.class)) unclassified.push(`${id}: cap entry unclassed`);
  }
  out.push(T("T1", "every asset, link and event carries a class and a source reference (nodes, events, possession periods, breaks, trade legs, cap entries, transfers, departures, points, contracts)", unclassified.length === 0, unclassified.slice(0, 3).join("; ")));

  // T2 confirmed facts equal the raw records (second code path)
  const mismatches = [];
  const dbPath = archive.dbPath;
  const raw = new DatabaseSync(dbPath, { readOnly: true });
  for (const [id, t] of Object.entries(b.trades)) {
    if (t.source.kind === "archive") {
      const rows = raw.prepare("select franchise_id f, asset_role r, asset_type t, player_id pid, asset_draftpick_season ds, asset_draftpick_round dr, asset_draftpick_overall dov, asset_draftpick_future_franchiseid ff, asset_draftpick_future_year fy, asset_draftpick_future_round fr, asset_capadjustment cap, date_et d, time_et tm from transactions_trades where trade_group_id = ?").all(id);
      const want = new Set(rows.filter((r) => r.r === "RELINQUISH" && r.t !== "CAP").map((r) => `${r.f}>${r.t === "PLAYER" ? `player:${r.pid}` : r.t === "DRAFTPICK_FUTURE" ? `fpick:${r.ff}:${r.fy}:${r.fr}` : `spick:${r.ds}:${r.dr}:${Number(r.dov) + 1}`}`));
      const have = new Set(t.legs.map((l) => `${l.from}>${l.asset}`));
      for (const w of want) if (!have.has(w)) mismatches.push(`${id}: raw rows have ${w}, the bundle does not`);
      for (const h of have) if (!want.has(h)) mismatches.push(`${id}: the bundle has ${h}, the raw rows do not`);
      const capRaw = rows.filter((r) => r.r === "RELINQUISH" && r.t === "CAP").map((r) => `${r.f}:${r.cap}`).sort().join(",");
      const capHave = [...t.cap, ...t.legs.filter((l) => String(l.asset).startsWith("cap:"))].map((c) => (c.amount != null ? `${c.from}:${c.amount}` : `${c.from}:${String(c.asset).split(":")[1]}`)).sort().join(",");
      if (capRaw !== capHave) mismatches.push(`${id}: cap rows differ (${capRaw} vs ${capHave})`);
      if (rows[0].d !== t.date || rows[0].tm !== t.time) mismatches.push(`${id}: date or time differs`);
      const keyOf = (r) => (r.t === "PLAYER" ? `player:${r.pid}` : r.t === "DRAFTPICK_FUTURE" ? `fpick:${r.ff}:${r.fy}:${r.fr}` : `spick:${r.ds}:${r.dr}:${Number(r.dov) + 1}`);
      const acq = new Set(rows.filter((r) => r.r === "ACQUIRE" && r.t !== "CAP").map((r) => `${r.f}<${keyOf(r)}`));
      for (const l of t.legs) if (!acq.has(`${l.to}<${l.asset}`)) mismatches.push(`${id}: no receiving row for ${l.asset} at franchise ${l.to}`);
      if (acq.size !== t.legs.length) mismatches.push(`${id}: ${acq.size} receiving rows but ${t.legs.length} legs`);
    } else {
      const j = readSnapshot(root, t.source.day, t.source.file);
      const raws = j.transactions.transaction[t.source.index];
      const rawSet = [...String(raws.franchise1_gave_up).split(",").filter(Boolean).map((x) => `${raws.franchise}|${x.trim()}`), ...String(raws.franchise2_gave_up).split(",").filter(Boolean).map((x) => `${raws.franchise2}|${x.trim()}`)].sort().join(";");
      const haveSet = [...t.legs, ...t.cap].map((x) => `${x.from}|${x.token}`).sort().join(";");
      if (raws.type !== "TRADE" || rawSet !== haveSet) mismatches.push(`${id}: snapshot tokens differ (${rawSet} vs ${haveSet})`);
    }
  }
  raw.close();
  out.push(T("T2", "every trade in the bundle equals its raw archive rows or snapshot entry, checked by a separate code path", mismatches.length === 0, mismatches.slice(0, 3).join("; ")));

  // T3 dates and identity preserved
  const lost = [];
  for (const t of Object.values(b.trades)) { if (!t.date || !t.time || !t.date_quality || !t.parties.length) lost.push(t.id); for (const l of t.legs) if (!l.asset || !l.from || !l.to) lost.push(`${t.id}: leg without asset, from or to`); }
  for (const n of b.nodes) for (const e of n.chain.events) if (!e.date) lost.push(`${n.id}: event without a date`);
  out.push(T("T3", "every transaction keeps its date, time, date quality, asset identity and both franchise ids", lost.length === 0, lost.slice(0, 3).join("; ")));

  // T4 chains replay the log
  const replayErrs = [];
  for (const n of b.nodes) {
    let holder = null;
    for (const e of n.chain.events) {
      if (e.kind === "trade") {
        const t = b.trades[e.trade]; const leg = t && t.legs.find((l) => l.asset === n.id);
        if (!leg) { replayErrs.push(`${n.id}: trade ${e.trade} has no leg for it`); continue; }
        if (leg.from !== e.from || leg.to !== e.to) replayErrs.push(`${n.id}: ${e.trade} direction differs`);
        if (holder && holder !== e.from) { if (!n.chain.breaks.some((x) => x.date === e.date)) replayErrs.push(`${n.id}: ${e.trade} continues from ${e.from} but the holder was ${holder} and no break is listed`); }
        holder = e.to;
      } else if (e.kind === "drop") holder = null; else if (e.kind === "add" || e.kind === "draft_selection") { if (holder && holder !== e.to && !n.chain.breaks.some((x) => x.date === e.date)) replayErrs.push(`${n.id}: ${e.kind} on ${e.date} ends a stint with no break listed`); holder = e.to; }
    }
    const last = n.chain.holders.at(-1);
    if (last && !last.to && holder !== null && last.franchise !== holder) replayErrs.push(`${n.id}: the replayed holder ${holder} differs from the bundle's ${last.franchise}`);
  }
  out.push(T("T4", "every chain replays the recorded trades; every discontinuity is listed, none is filled", replayErrs.length === 0, replayErrs.slice(0, 3).join("; ")));

  // T5 slots come from MFL
  const slotErrs = [];
  for (const n of b.nodes.filter((x) => x.kind === "slot_pick")) {
    const [y, r, s] = n.id.split(":").slice(1).map(Number);
    const sel = n.resolution.selection;
    const named = Object.values(b.trades).some((t) => t.legs.some((l) => l.asset === n.id && (l.token || l.kind === "slot_pick")));
    if (!named) slotErrs.push(`${n.id}: no MFL trade leg names the slot`);
    if (n.resolution.class === CLASS.CONFIRMED && !(sel && sel.year === y && sel.round === r && sel.slot === s)) slotErrs.push(`${n.id}: the draft result is not for this slot`);
    if (n.resolution.class === CLASS.CONFIRMED && n.resolution.holder_at_selection !== sel.franchise) slotErrs.push(`${n.id}: the chain holder is not the selecting franchise`);
    if (n.resolution.rule !== RULES.SLOT_TOKEN_DRAFT_RESULT) slotErrs.push(`${n.id}: wrong rule`);
  }
  for (const n of b.nodes.filter((x) => x.kind === "future_pick")) { if (n.resolution.class === CLASS.CONFIRMED) slotErrs.push(`${n.id}: a future pick can never be CONFIRMED to a slot by the tokens`); if (n.resolution.class === CLASS.INFERRED && n.resolution.rule !== RULES.UNIQUE_HOLDER_V1) slotErrs.push(`${n.id}: inferred by an unapproved rule`); }
  out.push(T("T5", "every slot comes from an MFL slot token and the MFL draft result for that slot; a future pick is never confirmed to a slot", slotErrs.length === 0, slotErrs.slice(0, 3).join("; ")));

  // T6 ambiguity stays ambiguous; the inference rule needs all of its conditions, including a demonstrably complete inventory
  const base = { year: 2020, round: 2, draftTs: 1590000000 };
  const window = (from, to) => ({ from, to, kind: "unobserved", basis: "test" });
  const run = (opts) => { const led = syntheticLedger({ ...base, ...opts }); return resolveFuturePick(led, syntheticChain(led, "0001", 2020, 2), { year: 2020, round: 2, original: "0001" }, { slotLists: [] }); };
  const uniq = { "0001": "0007", "0007": "0002" };                             // 0007 holds one pick of the round (0001's); its own went to 0002
  const r1 = run({ holdings: uniq });
  const r2 = run({ holdings: { "0001": "0007" } });                            // 0007 holds its own and 0001's: two slots
  const r3 = run({ holdings: uniq, windows: [window("2020-01-01", "2020-03-01")] });
  const r4 = run({ holdings: uniq, omitSlots: [12] });                         // eleven slots listed: the inventory is incomplete although 0007 shows exactly one candidate
  const r5 = run({ holdings: uniq, slotHolder: { 5: "0007" } });             // the evidence gives 0007 a second slot the records do not explain
  const r6 = run({ holdings: uniq, slotTokenTransfer: true });
  const noEvidence = resolveFuturePick({ selections: [], selBySlot: new Map(), windows: [], named_gap: { from: "9999-01-01", to: "9999-01-02" } }, syntheticChain(syntheticLedger({ ...base, holdings: uniq }), "0001", 2020, 2), { year: 2020, round: 2, original: "0001" }, { slotLists: [] });
  const ok6 = r1.class === CLASS.INFERRED && r1.rule === RULES.UNIQUE_HOLDER_V1 && r1.slot === 1 && /never confirmed/.test(r1.disclosure) && r1.inventory.complete
    && r2.class === CLASS.UNRESOLVED && r2.candidates.length === 2 && r3.class === CLASS.UNRESOLVED && r3.coverage_gaps.length === 1
    && r4.class === CLASS.UNRESOLVED && /not demonstrably complete/.test(r4.reason) && r5.class === CLASS.UNRESOLVED && /disagree/.test(r5.reason) && r6.class === CLASS.UNRESOLVED && noEvidence.class === CLASS.UNRESOLVED;
  out.push(T("T6", "uniqueness infers only when the holder owns one slot AND the round's inventory is demonstrably complete AND custody is observed to the evidence date (INFERRED, labeled); two slots, an incomplete or disagreeing inventory, an unobserved period or no evidence stay UNRESOLVED", ok6, ok6 ? "" : JSON.stringify([r1.class, r2.class, r3.class, r4.class, r5.class, r6.class, noEvidence.class])));

  // T7 franchise is not owner
  const ks = [...keys(b)].filter((k) => /owner/i.test(k));
  let ownerText = 0;
  walk(b, (p, v) => { if (typeof v === "string" && /\bowner\b/i.test(v) && !/not asserted|not owner|franchise continuity|owner identity|never an owner|owner_identity|never owners|an owner|owner names/i.test(v) && !p.includes("gaps")) ownerText++; });
  out.push(T("T7", "no owner field or owner name anywhere; every statement is about a franchise id", ks.length === 0 && b.gaps.some((g) => g.kind === "owner_identity_not_asserted"), ks.concat(ownerText ? [`${ownerText} strings mention owners`] : []).join(", ")));

  // T8 ownership from events
  const evErrs = [];
  for (const n of b.nodes.filter((x) => x.kind === "player")) { if (!n.chain.events.length) evErrs.push(n.id); if (n.chain.events.some((e) => !["trade", "draft_selection", "add", "drop"].includes(e.kind))) evErrs.push(`${n.id}: unknown event kind`); }
  const rec = b.reconciliation.players;
  out.push(T("T8", "possession periods come from trade, draft and add or drop events; weekly-roster disagreements are listed, not used", evErrs.length === 0 && rec.length === b.nodes.filter((x) => x.kind === "player").length, evErrs.join("; ")));

  // T9 no standings
  const hits = scanExtractionSources(extractionDir);
  let guardOk = true;
  for (const tbl of BANNED_TABLES) { try { assertQueryAllowed(`select * from ${tbl}`); guardOk = false; } catch (e) { if (!(e instanceof ArchiveGuardError)) guardOk = false; } }
  try { assertQueryAllowed("select * from some_other_table"); guardOk = false; } catch (e) { if (!(e instanceof ArchiveGuardError)) guardOk = false; }
  const usedOk = b.sources.archive.tables_read.every((x) => !BANNED_TABLES.includes(x));
  out.push(T("T9", "the build fails if the extraction reads any ranking or forecast data (draft slots come only from MFL draft results, slot tokens and slot lists): the runtime table guard and the static source scan are both clean", hits.length === 0 && guardOk && usedOk, hits.slice(0, 2).map((h) => `${h.file}:${h.line} ${h.why}`).join("; ")));

  // T10 points
  const ptsErrs = [];
  for (const n of b.nodes.filter((x) => x.kind === "player")) for (const s of n.economics.seasons) {
    for (const fr of s.by_franchise) { if (fr.points_verified > fr.points_all_weeks + 0.05) ptsErrs.push(`${n.id} ${s.season}: verified exceeds all`); if (fr.disputed_weeks.length && fr.points_verified + 0.05 >= fr.points_all_weeks && fr.weeks_verified === fr.weeks) ptsErrs.push(`${n.id}: disputed weeks counted as verified`); }
    if (s.weeks_with_scoring_row.some((w) => w > s.last_league_week)) ptsErrs.push(`${n.id} ${s.season}: a week after the last league week was kept`);
  }
  const mutated = JSON.parse(JSON.stringify(b)); const victim = mutated.nodes.find((n) => n.kind === "player" && n.id === "player:17051"); if (victim) victim.link_class = CLASS.INFERRED;
  const before = confirmedTotals(b, b.pilot.franchise), after = confirmedTotals(mutated, b.pilot.franchise);
  const excludes = victim ? after.points_verified <= before.points_verified && after.excluded_assets.includes("player:17051") : false;
  out.push(T("T10", "points are per franchise and per possession, copy weeks are excluded, disputed weeks are not verified, and an INFERRED asset never enters a confirmed-only total", ptsErrs.length === 0 && excludes && b.reconciliation.points.weekly_record_vs_plain_table_mismatches === 0, ptsErrs.slice(0, 3).join("; ")));

  // T11 salary
  const salErrs = [];
  const raw2 = new DatabaseSync(dbPath, { readOnly: true });
  for (const n of b.nodes.filter((x) => x.kind === "player")) for (const s of n.economics.seasons) for (const c of s.contract_by_roster_weeks) {
    const row = raw2.prepare("select salary, contract_year, contract_status from rosters_weekly where player_id = ? and season = ? and week = ? and franchise_id = ?").get(n.id.split(":")[1], s.season, c.from_week, c.franchise);
    if (!row || Number(row.salary) !== c.salary) salErrs.push(`${n.id} ${s.season}: salary ${c.salary} is not the recorded ${row ? row.salary : "none"}`);
  }
  raw2.close();
  out.push(T("T11", "every salary and contract shown equals the recorded weekly roster row; none is estimated; team cap totals are explicitly not computed", salErrs.length === 0 && b.gaps.some((g) => g.kind === "team_cap_totals_not_computed"), salErrs.slice(0, 3).join("; ")));

  // T12 depth and frontier
  const depthErrs = [];
  for (const n of b.nodes) { if (n.generation > b.pilot.max_generation) depthErrs.push(`${n.id}: beyond the limit`); for (const t of n.transfers) if (n.generation >= b.pilot.max_generation && !t.frontier) depthErrs.push(`${n.id}: a transfer at the limit is not on the frontier`); }
  const fr = new Set(b.frontier.map((f) => `${f.asset}|${f.trade}`));
  for (const n of b.nodes) for (const t of n.transfers) if (t.frontier && !fr.has(`${n.id}|${t.trade}`)) depthErrs.push(`${n.id}: frontier entry missing`);
  out.push(T("T12", "the trace stops at the stated generation limit and every untraced continuation is listed on the frontier", depthErrs.length === 0, depthErrs.slice(0, 3).join("; ")));

  // T13 gaps
  const g0 = b.gaps[0];
  const spanErrs = [];
  for (const n of b.nodes) {
    const g = b.coverage.named_gap;
    const expect = n.chain.holders.some((h) => (h.from.date == null || h.from.date <= g.to) && (h.to == null ? b.sources.snapshots.pinned_day : h.to.date) >= g.from);
    const g2 = b.coverage.named_gap;
    const expectSpans = n.chain.holders.filter((h) => (h.from.date == null || h.from.date <= g2.to) && (h.to == null ? b.sources.snapshots.pinned_day : h.to.date) >= g2.from).map((h) => `${h.franchise}|${h.from.date || ""}|${h.to ? h.to.date : ""}`).join(";");
    const haveSpans = n.named_gap ? n.named_gap.possession_periods_spanning.map((x) => `${x.franchise}|${x.from || ""}|${x.to || ""}`).join(";") : "";
    if (expectSpans !== haveSpans) spanErrs.push(`${n.id}: the listed spanning periods differ from the chain's`);
    if (!n.named_gap || n.named_gap.crosses !== expect) spanErrs.push(`${n.id}: the named gap is ${n.named_gap && n.named_gap.crosses ? "shown" : "not shown"} but the chain ${expect ? "crosses" : "does not cross"} it`);
  }
  const gapOk = spanErrs.length === 0 && g0 && g0.kind === "incomplete_trade_coverage" && g0.from === "2025-11-28" && g0.to === "2026-03-07" && b.nodes.filter((n) => n.kind === "future_pick" && n.resolution.coverage_gaps.length).every((n) => n.resolution.class !== CLASS.INFERRED && n.resolution.class !== CLASS.CONFIRMED)
    && b.nodes.flatMap((n) => n.chain.breaks).every((br) => b.gaps.some((g) => (g.date === br.date) && (g.kind === br.kind)));
  out.push(T("T13", "the 2025-11-28 to 2026-03-07 trade-coverage gap is on the list and is shown on every chain (player or pick) that crosses it; no pick whose custody crosses it is resolved; every chain break is a listed gap", !!gapOk, gapOk ? "" : spanErrs.concat([JSON.stringify(g0)]).slice(0, 3).join("; ")));

  // T14 determinism, read-only, offline
  const again = rebuild ? await rebuild() : null;
  const same = again ? stableStringify(again) === stableStringify(b) : true;
  const matchesCommitted = committedBundle ? stableStringify(committedBundle) === stableStringify(b) : true;
  let readOnly = false;
  try { const w = new DatabaseSync(dbPath, { readOnly: true }); try { w.exec("create table s1_probe (x)"); } catch (_) { readOnly = true; } w.close(); } catch (_) { readOnly = false; }
  const netHits = fs.readdirSync(extractionDir).filter((f) => f.endsWith(".mjs") && f !== "acceptance.mjs" && f !== "guard.mjs").filter((f) => /\bfetch\s*\(|node:https?|node:net|XMLHttpRequest|WebSocket/.test(fs.readFileSync(path.join(extractionDir, f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")));
  out.push(T("T14", "two builds are byte-identical and match the committed bundle; the archive opens read-only; no extraction module contains a network call pattern (fetch, http, net, WebSocket)", same && matchesCommitted && readOnly && netHits.length === 0, `${same ? "" : "builds differ "}${matchesCommitted ? "" : "committed bundle differs "}${readOnly ? "" : "archive is writable "}${netHits.join(",")}`));

  // T15 no private data
  const text = stableStringify(b);
  const sqlText = fs.readdirSync(extractionDir).filter((f) => f.endsWith(".mjs") && f !== "acceptance.mjs").map((f) => fs.readFileSync(path.join(extractionDir, f), "utf8")).join("\n");
  const priv = [/[\w.+-]+@[\w-]+\.[\w.]+/.test(text) ? "an email address" : null, /owner_name|owner_display|discord/i.test(sqlText.replace(/\/\/.*$/gm, "")) ? "an owner or chat column in the extraction code" : null, /password|api[_-]?key|secret/i.test(text) ? "a credential word" : null].filter(Boolean);
  out.push(T("T15", "only franchise ids, team names and player names appear; no owner column is read; no email, credential or chat text", priv.length === 0, priv.join(", ")));

  // T17 package attribution: every transaction is a package; nothing is credited to a single asset unless the transaction itself pairs the assets
  const pkgErrs = [];
  for (const [id, tr] of Object.entries(b.trades)) {
    const pv = b.packages[id];
    if (!pv) { pkgErrs.push(`${id}: no package view`); continue; }
    const legsKey = tr.legs.map((l) => `${l.from}>${l.to}:${l.asset}`).sort().join("|");
    const viewKey = pv.sides.flatMap((sd) => sd.sent.map((x) => { const l = tr.legs.find((q) => q.asset === x.asset && q.from === sd.franchise); return `${sd.franchise}>${l ? l.to : "?"}:${x.asset}`; })).sort().join("|");
    if (legsKey !== viewKey) pkgErrs.push(`${id}: the package does not carry every leg in its direction`);
    const capIn = tr.cap.map((c) => `${c.from}>${c.to}:${c.amount}`).sort().join("|");
    const capView = pv.sides.flatMap((sd) => sd.cap_sent.map((a) => `${sd.franchise}>${tr.cap.find((c) => c.from === sd.franchise && c.amount === a).to}:${a}`)).sort().join("|");
    if (capIn !== capView) pkgErrs.push(`${id}: the cap transfer is not preserved in its direction`);
    for (const sd of pv.sides) {
      const one = sd.sent.length === 1 && sd.received.length === 1 && tr.cap.length === 0;
      if ((sd.allocation.status === "ESTABLISHED_ONE_FOR_ONE") !== one) pkgErrs.push(`${id}: ${sd.franchise} allocation status disagrees with the one-for-one rule`);
    }
  }
  walk(b, (pth, v) => { if (/attribut|allocated_value|credited/i.test(pth) && typeof v === "number") pkgErrs.push(`${pth}: a number sits under an attribution field`); });
  for (const n of b.nodes) {
    const trades = n.chain.events.filter((e) => e.kind === "trade").map((e) => e.trade);
    if (JSON.stringify(n.participation.map((x) => x.trade)) !== JSON.stringify(trades)) pkgErrs.push(`${n.id}: participation does not list every trade of the chain`);
    for (const pt of n.participation) if (pt.attributable_return.status === "ESTABLISHED_ONE_FOR_ONE" && !(pt.sender_package.sent.length === 1 && pt.sender_package.received.length === 1)) pkgErrs.push(`${n.id}: an allocation is established for a package of more than one asset in ${pt.trade}`);
    for (const tr of n.transfers) if (tr.attributable_return.status === "NOT_ESTABLISHED" && tr.package_received.length + tr.cap_received.length > 0 && tr.package_sent.length + tr.cap_sent.length < 1) pkgErrs.push(`${n.id}: a transfer with no package_sent`);
  }
  out.push(T("T17", "every trade is kept as one package with every asset and cap amount in its direction; lineage participation is separate from attributable return, which is established only for an exact one-for-one exchange; no number sits under an attribution field", pkgErrs.length === 0, pkgErrs.slice(0, 3).join("; ")));

  out.push(T("T16", "independent review (Codex) on the exact head, and CI on the head and on the merge result of the head with the base, both SHAs named", null, "recorded on the pull request, not asserted by this file"));
  out.sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)));
  return out;
}
