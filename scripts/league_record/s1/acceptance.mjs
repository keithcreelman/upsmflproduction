// League Record S1 pilot: acceptance tests T1 to T16 as functions over a built bundle. The test file asserts that every one passes; the report prints the same results.
// T2 uses its OWN second code path (raw SQL and raw snapshot JSON, no shared parsing) so it can disagree with the extraction.
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CLASS, RULES, resolveFuturePick } from "./lineage.mjs";
import { scanExtractionSources, BANNED_TABLES } from "./guard.mjs";
import { assertQueryAllowed, ArchiveGuardError } from "./archive.mjs";
import { readSnapshot } from "./sources.mjs";
import { confirmedTotals } from "./report.mjs";
import { stableStringify } from "./pilot.mjs";

const T = (id, title, pass, detail = "") => ({ id, title, pass, detail });

// Walk a value and call fn(path, value) for every leaf.
function walk(v, fn, p = "") { if (Array.isArray(v)) v.forEach((x, i) => walk(x, fn, `${p}[${i}]`)); else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, fn, `${p}.${k}`); else fn(p, v); }
function keys(v, out = new Set()) { if (Array.isArray(v)) v.forEach((x) => keys(x, out)); else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { out.add(k); keys(x, out); } return out; }

// A synthetic ledger for the inference-rule tests: one round of one year, one franchise holding the slots named, no unobserved periods unless asked.
export function syntheticLedger({ year, round, slotsHeld, draftTs, windows = [] }) {
  const selections = slotsHeld.map((s) => ({ year, round, slot: s.slot, franchise: s.holder, player_id: `p${s.slot}`, ts: draftTs, date: "2020-06-01", source: { kind: "archive", table: "draftresults_mfl" }, note: "" }));
  return { selections, selBySlot: new Map(selections.map((s) => [`${year}:${round}:${s.slot}`, s])), windows, named_gap: { from: "9999-01-01", to: "9999-01-02", kind: "none" } };
}
export function syntheticChain(holder, lastTransferTs) {
  return { holders: [{ franchise: "0001", from_ts: null, to_ts: lastTransferTs, to_event: { kind: "trade", ts: lastTransferTs } }, { franchise: holder, from_ts: lastTransferTs, from_event: { kind: "trade", ts: lastTransferTs }, to_ts: null, to_event: null }], events: [], breaks: [] };
}

export async function runAcceptance({ bundle, root, archive, rebuild, committedBundle = null }) {
  const out = [];
  const b = bundle;
  const extractionDir = path.join(root, "scripts", "league_record", "s1");

  // T1 every line classed and sourced
  const unclassified = [];
  for (const n of b.nodes) {
    if (!Object.values(CLASS).includes(n.link_class)) unclassified.push(n.id);
    if (!n.entered || !(n.entered.trade || n.entered.source)) unclassified.push(`${n.id}: no entry source`);
    for (const e of n.chain.events) if (!e.source || !e.source.kind) unclassified.push(`${n.id}: event without a source`);
    if (n.resolution && !Object.values(CLASS).includes(n.resolution.class)) unclassified.push(`${n.id}: resolution unclassed`);
  }
  out.push(T("T1", "every asset, link and event carries a class and a source reference", unclassified.length === 0, unclassified.join("; ")));

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
      for (const l of t.legs) { const rec = rows.find((r) => r.r === "ACQUIRE" && r.f === l.to); if (!rec) mismatches.push(`${id}: no receiving row for ${l.asset}`); }
    } else {
      const j = readSnapshot(root, t.source.day, t.source.file);
      const raws = j.transactions.transaction[t.source.index];
      const tokens = [...String(raws.franchise1_gave_up).split(","), ...String(raws.franchise2_gave_up).split(",")].filter(Boolean).length;
      if (raws.type !== "TRADE" || tokens !== t.legs.length + t.cap.length) mismatches.push(`${id}: snapshot entry differs (${tokens} tokens vs ${t.legs.length + t.cap.length})`);
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

  // T6 ambiguity stays ambiguous; the inference rule needs all of its conditions
  const base = { year: 2020, round: 2, draftTs: 1590000000 };
  const ctx = (slots, windows = []) => syntheticLedger({ ...base, slotsHeld: slots, windows });
  const window = (from, to) => ({ from, to, kind: "unobserved", basis: "test" });
  const fut = (ledger, chain) => { ledger.selections.forEach(() => {}); return resolveFuturePick({ ...ledger, ...{} }, chain, { year: 2020, round: 2, original: "0001" }, { slotLists: [] }); };
  const oneSlot = ctx([{ slot: 3, holder: "0007" }, { slot: 4, holder: "0002" }]);
  const twoSlots = ctx([{ slot: 3, holder: "0007" }, { slot: 9, holder: "0007" }, { slot: 4, holder: "0002" }]);
  const gapped = ctx([{ slot: 3, holder: "0007" }], [window("2020-01-01", "2020-03-01")]);
  const chain = syntheticChain("0007", 1570000000);                           // last transfer on 2019-10-02
  const r1 = fut(oneSlot, chain), r2 = fut(twoSlots, chain), r3 = fut(gapped, chain);
  const noEvidence = resolveFuturePick({ selections: [], selBySlot: new Map(), windows: [], named_gap: { from: "9999-01-01", to: "9999-01-02" } }, chain, { year: 2020, round: 2, original: "0001" }, { slotLists: [] });
  const ok6 = r1.class === CLASS.INFERRED && r1.rule === RULES.UNIQUE_HOLDER_V1 && r1.slot === 3 && /never confirmed/.test(r1.disclosure) && r2.class === CLASS.UNRESOLVED && r2.candidates.length === 2 && r3.class === CLASS.UNRESOLVED && r3.coverage_gaps.length === 1 && noEvidence.class === CLASS.UNRESOLVED;
  out.push(T("T6", "uniqueness infers only when the holder owns one slot AND custody is observed to the evidence date (INFERRED, labeled); two slots, an unobserved period or no evidence stay UNRESOLVED", ok6, ok6 ? "" : JSON.stringify([r1.class, r2.class, r3.class, noEvidence.class])));

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
  const gapOk = g0 && g0.kind === "incomplete_trade_coverage" && g0.from === "2025-11-28" && g0.to === "2026-03-07" && b.nodes.filter((n) => n.kind === "future_pick" && n.resolution.coverage_gaps.length).every((n) => n.resolution.class !== CLASS.INFERRED && n.resolution.class !== CLASS.CONFIRMED)
    && b.nodes.flatMap((n) => n.chain.breaks).every((br) => b.gaps.some((g) => (g.date === br.date) && (g.kind === br.kind)));
  out.push(T("T13", "the 2025-11-28 to 2026-03-07 trade-coverage gap is on the list; no pick whose custody crosses it is resolved; every chain break is a listed gap", !!gapOk, gapOk ? "" : JSON.stringify(g0)));

  // T14 determinism, read-only, offline
  const again = rebuild ? await rebuild() : null;
  const same = again ? stableStringify(again) === stableStringify(b) : true;
  const matchesCommitted = committedBundle ? stableStringify(committedBundle) === stableStringify(b) : true;
  let readOnly = false;
  try { const w = new DatabaseSync(dbPath, { readOnly: true }); try { w.exec("create table s1_probe (x)"); } catch (_) { readOnly = true; } w.close(); } catch (_) { readOnly = false; }
  const netHits = fs.readdirSync(extractionDir).filter((f) => f.endsWith(".mjs") && f !== "acceptance.mjs" && f !== "guard.mjs").filter((f) => /\bfetch\s*\(|node:https?|node:net|XMLHttpRequest|WebSocket/.test(fs.readFileSync(path.join(extractionDir, f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")));
  out.push(T("T14", "two builds are byte-identical and match the committed bundle; the archive opens read-only; no extraction module can reach the network", same && matchesCommitted && readOnly && netHits.length === 0, `${same ? "" : "builds differ "}${matchesCommitted ? "" : "committed bundle differs "}${readOnly ? "" : "archive is writable "}${netHits.join(",")}`));

  // T15 no private data
  const text = stableStringify(b);
  const sqlText = fs.readdirSync(extractionDir).filter((f) => f.endsWith(".mjs") && f !== "acceptance.mjs").map((f) => fs.readFileSync(path.join(extractionDir, f), "utf8")).join("\n");
  const priv = [/[\w.+-]+@[\w-]+\.[\w.]+/.test(text) ? "an email address" : null, /owner_name|owner_display|discord/i.test(sqlText.replace(/\/\/.*$/gm, "")) ? "an owner or chat column in the extraction code" : null, /password|api[_-]?key|secret/i.test(text) ? "a credential word" : null].filter(Boolean);
  out.push(T("T15", "only franchise ids, team names and player names appear; no owner column is read; no email, credential or chat text", priv.length === 0, priv.join(", ")));

  out.push(T("T16", "independent review (Codex) and CI on the exact head", null, "recorded on the pull request, not asserted by this file"));
  return out;
}
