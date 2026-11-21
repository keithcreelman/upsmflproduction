// League Record S1, Step 1b: read-only extraction of the archive years 2010 to 2025 (trades, draft selections, pick links, chain breaks, conflicts, production), measured season by season.
//
// Everything here comes from the committed archive through the guarded reader (archive.mjs). Draft slots come ONLY from MFL slot tokens in trades and MFL draft results; nothing is
// derived from standings, finishes, brackets or a projected order. Each trade is kept as one package (packages.mjs): nothing is credited to a single asset of a multi-asset trade.
// Classes are kept apart in every count: CONFIRMED, INFERRED (UNIQUE_HOLDER_V1 with all its conditions), UNRESOLVED. A figure is a count of records, never an estimate.
import { buildLedger, playerChain, pickChain, resolveSlotPick, resolveFuturePick, holderAt, CLASS } from "./lineage.mjs";
import { packageView } from "./packages.mjs";
import { memoryView } from "./archive.mjs";
import { playerEconomics } from "./economics.mjs";

export const FIRST_YEAR = 2010, LAST_YEAR = 2025;
const LIST_CAP = 60;                                          // detailed rows kept per category in the committed output (the total is always kept)
const years = Array.from({ length: LAST_YEAR - FIRST_YEAR + 1 }, (_, i) => FIRST_YEAR + i);
const r1 = (n) => Math.round(n * 10) / 10;
const yearOf = (iso) => Number(String(iso).slice(0, 4));
const pickParts = (a) => a.split(":").slice(1);

function newSeason(y) {
  return {
    season: y,
    trades: { count: 0, parties_distinct_pairs: 0, date_quality: {}, legs: { player: 0, future_pick: 0, slot_pick: 0, unknown: 0, unpaired: 0 }, packages: { multi_asset_trades: 0, one_for_one_trades: 0, largest_side_items: 0, assets_per_trade_max: 0 }, cap: { transfers: 0, total_amount: 0 }, same_day_trades: 0 },
    draft: { source_table: null, selections: 0, rounds: 0, scheduled_slots: 0, slot_status: { SELECTED: 0, FORFEITED: 0, UNRESOLVED: 0, MISSING_SOURCE_RECORD: 0 }, forfeited_slots: [], overall_numbers_absent: [], missing_slots: [], unresolved_slots: [], duplicate_slots: 0, rows_without_franchise_id: 0, legacy_slot_corrections: 0, selecting_franchises: 0, league_franchises: 0, franchises_without_a_selection: [], first_date: null, last_date: null },
    slot_picks: { assets_traded: 0, confirmed: 0, conflict: 0, selector_not_recorded: 0, forfeited_slot: 0, no_draft_result: 0, trades_after_selection: 0, chain_breaks: 0, resolution_rate_confirmed: null },
    future_picks: { assets_traded: 0, confirmed: 0, inferred: 0, unresolved: 0, unresolved_by_reason: { no_draft_result: 0, custody_not_observed: 0, inventory_not_complete: 0, ambiguous_candidates: 0 }, inventory_blockers: { forfeited_slot_in_round: 0, slot_token_transfer_in_round: 0, records_and_evidence_disagree: 0, slot_count_not_one_per_team: 0, earliest_record_after_evidence: 0, chain_break: 0 }, funnel: { traded: 0, custody_observed_strict: 0, inventory_complete_strict: 0, inventory_complete_if_slot_tokens_netted: 0, single_candidate_slot: 0, would_infer_if_windows_observed_and_tokens_netted: 0 } },
    chain_breaks: { players: { discontinuity: 0, implicit_release: 0 }, picks: { discontinuity: 0 } },
    production: { traded_players_with_a_scoring_row: 0, franchise_seasons: 0, points_verified: 0, weeks_verified: 0, weeks_disputed: 0, weeks_transition: 0, weeks_outside_traced_window: 0, weeks_without_franchise: 0, weeks_franchise_from_roster_record: 0, verified_share_of_scored_weeks: null },
  };
}

// DIAGNOSTIC ONLY (not the approved rule): would the round's inventory reconcile franchise by franchise if slot-token transfers were NETTED at the count level (a transfer of slot s from X to
// Y before the evidence date moves one pick from X to Y, without saying which pick it is)? The approved rule refuses any round with a slot-token transfer; this shows how many rounds
// that single refusal decides. Counts only; nothing is linked to a slot.
function nettedInventory(ledger, year, round, evidenceTs, holder) {
  const teams = ledger.franchisesFor(year);
  const sels = ledger.selections.filter((x) => x.year === year && x.round === round);
  if (!teams.length || !sels.length || evidenceTs == null) return { complete: false };
  if ((ledger.forfeitures || []).some((f) => f.season === year && f.round === round)) return { complete: false, forfeited_slot: true };      // a forfeited slot has no recorded holder, so no count-level reconciliation exists
  const slotNos = sels.map((x) => x.slot).sort((a, b) => a - b);
  if (slotNos.length !== teams.length || slotNos.some((n, i) => n !== i + 1)) return { complete: false };
  const implied = new Map(teams.map((t) => [t, 0]));
  for (const o of teams) {
    const c = pickChain(ledger, `fpick:${o}:${year}:${round}`);
    if (c.breaks.length) return { complete: false };
    const h = holderAt(c, evidenceTs) || (c.holders.length ? c.holders.at(-1).franchise : o);
    implied.set(h, (implied.get(h) || 0) + 1);
  }
  for (const [asset, entries] of ledger.tradesByAsset) {
    if (!asset.startsWith(`spick:${year}:${round}:`)) continue;
    for (const { trade, leg } of entries) if (trade.ts < evidenceTs) { implied.set(leg.from, (implied.get(leg.from) || 0) - 1); implied.set(leg.to, (implied.get(leg.to) || 0) + 1); }
  }
  const listed = new Map(teams.map((t) => [t, 0]));
  for (const x of sels) listed.set(x.franchise, (listed.get(x.franchise) || 0) + 1);
  return { complete: teams.every((t) => (implied.get(t) || 0) === (listed.get(t) || 0)) && (listed.get(holder) || 0) >= 0 };
}

export function buildArchiveExtraction({ archive, root, forfeitures = null }) {
  const ledger = buildLedger({ archive, root, forfeitures });
  const season = new Map(years.map((y) => [y, newSeason(y)]));
  const lists = { slot_conflicts: [], trades_after_selection: [], pick_chain_discontinuities: [], player_chain_breaks: [], unpaired_or_unknown_legs: [], duplicate_legs: [], draft_missing_source_records: [], draft_unresolved_slots: [], known_forfeitures: [], future_pick_ambiguous_examples: [] };
  const totals = Object.fromEntries(Object.keys(lists).map((k) => [k, 0]));
  const outOfScope = { player_chain_breaks_dated_after_2025: 0 };
  const note = (kind, row) => { totals[kind] += 1; if (lists[kind].length < LIST_CAP) lists[kind].push(row); };

  // ── A. trades: sources, packages, cap transfers ─────────────────────────────────────────────
  const archiveTrades = ledger.archiveTrades.filter((t) => t.season >= FIRST_YEAR && t.season <= LAST_YEAR);
  const pairSeen = new Map(years.map((y) => [y, new Set()]));
  const dayCount = new Map();
  for (const t of archiveTrades) {
    const s = season.get(t.season).trades;
    s.count += 1; s.date_quality[t.date_quality] = (s.date_quality[t.date_quality] || 0) + 1;
    pairSeen.get(t.season).add(t.parties.join("|"));
    dayCount.set(`${t.season}|${t.date}`, (dayCount.get(`${t.season}|${t.date}`) || 0) + 1);
    const seen = new Set();
    for (const l of t.legs) {
      if (l.unpaired) { s.legs.unpaired += 1; note("unpaired_or_unknown_legs", { trade: t.id, season: t.season, issue: "unpaired", asset: l.asset, from: l.from }); continue; }
      s.legs[l.kind === "player" || l.kind === "future_pick" || l.kind === "slot_pick" ? l.kind : "unknown"] += 1;
      if (!l.asset) note("unpaired_or_unknown_legs", { trade: t.id, season: t.season, issue: "unknown asset", token: l.token || null });
      const key = `${l.from}>${l.to}:${l.asset}`;
      if (seen.has(key)) note("duplicate_legs", { trade: t.id, season: t.season, asset: l.asset });
      seen.add(key);
    }
    for (const c of t.cap) { s.cap.transfers += 1; s.cap.total_amount += c.amount; }
    const pv = packageView(t, () => null);
    if (pv.package) s.packages.multi_asset_trades += 1; else s.packages.one_for_one_trades += 1;
    s.packages.largest_side_items = Math.max(s.packages.largest_side_items, ...pv.sides.map((x) => Math.max(x.assets_sent, x.assets_received)));
    s.packages.assets_per_trade_max = Math.max(s.packages.assets_per_trade_max, t.legs.length + t.cap.length);
  }
  for (const y of years) { season.get(y).trades.parties_distinct_pairs = pairSeen.get(y).size; season.get(y).trades.same_day_trades = [...dayCount.entries()].filter(([k, n]) => k.startsWith(`${y}|`) && n > 1).length; }

  // ── B. draft selections: coverage ───────────────────────────────────────────────────────────
  const selByYear = new Map(years.map((y) => [y, []]));
  for (const sel of ledger.selections) if (sel.source.kind === "archive" && sel.year >= FIRST_YEAR && sel.year <= LAST_YEAR) selByYear.get(sel.year).push(sel);
  for (const y of years) {
    const d = season.get(y).draft, sels = selByYear.get(y);
    const teams = ledger.franchisesFor(y);
    d.league_franchises = teams.length;
    if (!sels.length) continue;
    d.source_table = [...new Set(sels.map((x) => x.source.table))].join("+");
    d.selections = sels.length; d.rounds = Math.max(...sels.map((x) => x.round)); d.scheduled_slots = d.rounds * teams.length;
    const have = new Map();
    for (const x of sels) have.set(`${x.round}:${x.slot}`, (have.get(`${x.round}:${x.slot}`) || 0) + 1);
    // Every scheduled slot gets exactly one status. SELECTED: one recorded selection. FORFEITED: no selection and a known forfeiture from a named provenance (the player stays empty).
    // UNRESOLVED: the source has more than one row for the slot, so which is the selection is not decided. MISSING_SOURCE_RECORD: no selection and no known forfeiture (nothing explains the absence).
    for (let r = 1; r <= d.rounds; r++) for (let sl = 1; sl <= teams.length; sl++) {
      const label = `${r}.${String(sl).padStart(2, "0")}`, n = have.get(`${r}:${sl}`) || 0, ff = ledger.forfeitBySlot.get(`${y}:${r}:${sl}`);
      if (n === 1) d.slot_status.SELECTED += 1;
      else if (n > 1) { d.slot_status.UNRESOLVED += 1; d.unresolved_slots.push(label); note("draft_unresolved_slots", { season: y, slot: label, rows: n }); }
      else if (ff) { d.slot_status.FORFEITED += 1; d.forfeited_slots.push({ slot: label, overall: ff.overall, reason: ff.reason, provenance: ff.provenance, selected_player: null, not_recorded: ff.not_recorded }); note("known_forfeitures", { season: y, slot: label, overall: ff.overall, reason: ff.reason, provenance: ff.provenance, clarification_recorded_on: ff.clarification_recorded_on, selected_player: null, not_recorded: ff.not_recorded }); }
      else { d.slot_status.MISSING_SOURCE_RECORD += 1; d.missing_slots.push(label); note("draft_missing_source_records", { season: y, missing_slot: label }); }
    }
    d.duplicate_slots = [...have.values()].filter((n) => n > 1).length;
    { const ov = new Set(sels.map((x) => x.overall)); for (let k = 1; k <= d.scheduled_slots; k++) if (!ov.has(k)) d.overall_numbers_absent.push(k); }       // MFL's own overall pick numbers: any number absent from 1..scheduled is an absent selection, whatever the slot text says
    d.rows_without_franchise_id = sels.filter((x) => !x.franchise).length; d.legacy_slot_corrections = sels.filter((x) => x.slot_correction).length;
    const picked = new Set(sels.filter((x) => x.franchise).map((x) => x.franchise));
    d.selecting_franchises = picked.size; d.franchises_without_a_selection = teams.filter((t) => !picked.has(t));
    d.first_date = sels.map((x) => x.date).sort()[0]; d.last_date = sels.map((x) => x.date).sort().at(-1);
  }

  for (const f of ledger.forfeitures) {
    if (f.season < FIRST_YEAR || f.season > LAST_YEAR) continue;
    const d = season.get(f.season).draft, teams = ledger.franchisesFor(f.season).length;
    if (!d.selections) throw new Error(`forfeiture ${f.season} ${f.round}.${f.slot}: the season has no draft results to place a scheduled slot in`);
    if (f.round > d.rounds || f.slot > teams || f.overall !== (f.round - 1) * teams + f.slot) throw new Error(`forfeiture ${f.season} ${f.round}.${f.slot}: not a scheduled slot of that draft (overall ${f.overall}, ${d.rounds} rounds, ${teams} teams)`);
  }

  // ── C. slot picks: token + draft result ─────────────────────────────────────────────────────
  const assets = [...ledger.tradesByAsset.keys()].sort();
  for (const a of assets.filter((x) => x.startsWith("spick:"))) {
    const [y, r, sl] = pickParts(a).map(Number);
    if (y < FIRST_YEAR || y > LAST_YEAR) continue;
    const sp = season.get(y).slot_picks;
    sp.assets_traded += 1;
    const chain = pickChain(ledger, a);
    const res = resolveSlotPick(ledger, chain, y, r, sl);
    if (chain.breaks.length) { sp.chain_breaks += chain.breaks.length; for (const b of chain.breaks) { season.get(y).chain_breaks.picks.discontinuity += 1; note("pick_chain_discontinuities", { asset: a, date: b.date, trade: b.at, expected_holder: b.expected_holder, recorded_sender: b.recorded_sender }); } }
    if (res.class === CLASS.CONFIRMED) sp.confirmed += 1;
    else if (res.selector_not_recorded) sp.selector_not_recorded += 1;
    else if (res.forfeited) sp.forfeited_slot += 1;
    else if (res.conflict) { sp.conflict += 1; note("slot_conflicts", { asset: a, draft_year: y, selector: res.selection.franchise, chain_holder_at_selection: res.holder_at_selection, trades: chain.events.map((e) => e.trade), selection_table: res.selection.source.table }); }
    else sp.no_draft_result += 1;
    if (res.selection) { const late = chain.events.filter((e) => e.ts > res.selection.ts); if (late.length) { sp.trades_after_selection += late.length; for (const e of late) note("trades_after_selection", { asset: a, draft_year: y, trade: e.trade, date: e.date, selection_date: res.selection.date }); } }
  }
  for (const y of years) { const sp = season.get(y).slot_picks; sp.resolution_rate_confirmed = sp.assets_traded ? Math.round((sp.confirmed / sp.assets_traded) * 1000) / 1000 : null; }

  // ── D. future picks: identity is (original franchise, year, round); a slot only by UNIQUE_HOLDER_V1 with every condition ──
  for (const a of assets.filter((x) => x.startsWith("fpick:"))) {
    const [orig, ys, rs] = pickParts(a); const y = Number(ys), r = Number(rs);
    if (y < FIRST_YEAR || y > LAST_YEAR) continue;
    const fp = season.get(y).future_picks; fp.assets_traded += 1;
    const chain = pickChain(ledger, a);
    if (chain.breaks.length) for (const b of chain.breaks) { season.get(y).chain_breaks.picks.discontinuity += 1; note("pick_chain_discontinuities", { asset: a, date: b.date, trade: b.at, expected_holder: b.expected_holder, recorded_sender: b.recorded_sender }); }
    const res = resolveFuturePick(ledger, chain, { year: y, round: r, original: orig }, { slotLists: [] });
    // DIAGNOSTIC funnel (never an authoritative result): which condition stops each pick, and what would change if a condition were met some other way
    fp.funnel.traded += 1;
    if (res.inventory && res.inventory.checked.slots_listed) {
      if (!res.coverage_gaps.length) fp.funnel.custody_observed_strict += 1;
      if (res.inventory.complete) fp.funnel.inventory_complete_strict += 1;
      const netted = nettedInventory(ledger, y, r, res.evidence_ts, res.holder);
      if (netted.complete) fp.funnel.inventory_complete_if_slot_tokens_netted += 1;
      if (res.candidates.length === 1) fp.funnel.single_candidate_slot += 1;
      if (netted.complete && res.candidates.length === 1) fp.funnel.would_infer_if_windows_observed_and_tokens_netted += 1;
    }
    if (res.class === CLASS.INFERRED) { fp.inferred += 1; continue; }
    fp.unresolved += 1;
    const inv = res.inventory || null;
    const reasons = inv ? inv.reasons.join(" | ") : "";
    if (!inv || !inv.checked.slots_listed) { fp.unresolved_by_reason.no_draft_result += 1; continue; }
    // blockers are counted whichever one stops the pick first, so the table shows every obstacle and not only the first
    if (/forfeited/.test(reasons)) fp.inventory_blockers.forfeited_slot_in_round += 1;
    if (/slot-token transfer/.test(reasons)) fp.inventory_blockers.slot_token_transfer_in_round += 1;
    if (/disagree/.test(reasons)) fp.inventory_blockers.records_and_evidence_disagree += 1;
    if (/not one for each/.test(reasons)) fp.inventory_blockers.slot_count_not_one_per_team += 1;
    if (/earliest record/.test(reasons)) fp.inventory_blockers.earliest_record_after_evidence += 1;
    if (/has a break/.test(reasons)) fp.inventory_blockers.chain_break += 1;
    if (res.coverage_gaps && res.coverage_gaps.length) fp.unresolved_by_reason.custody_not_observed += 1;
    else if (!inv.complete) fp.unresolved_by_reason.inventory_not_complete += 1;
    else fp.unresolved_by_reason.ambiguous_candidates += 1;
    if (res.coverage_gaps && !res.coverage_gaps.length && inv.complete && res.candidates.length !== 1) note("future_pick_ambiguous_examples", { asset: a, holder: res.holder, candidate_slots: res.candidates.map((c) => c.slot) });
  }

  // ── E. player chains (every player traded 2010-2025): unsupported transitions ───────────────
  const tradedPlayers = new Map();
  for (const t of archiveTrades) for (const l of t.legs) if (l.asset && l.asset.startsWith("player:")) { const pid = l.asset.slice(7); if (!tradedPlayers.has(pid)) tradedPlayers.set(pid, t.season); }
  const chains = new Map();
  for (const [pid] of tradedPlayers) {
    const chain = playerChain(ledger, pid);
    chains.set(pid, chain);
    for (const b of chain.breaks) {
      const y = yearOf(b.date);
      if (y < FIRST_YEAR || y > LAST_YEAR) { outOfScope.player_chain_breaks_dated_after_2025 += 1; continue; }     // a break dated 2026 (from the snapshot) is outside the stated period
      season.get(y).chain_breaks.players[b.kind] += 1;
      note("player_chain_breaks", { player: pid, kind: b.kind, date: b.date, ...(b.expected_holder ? { expected_holder: b.expected_holder, recorded_sender: b.recorded_sender } : { holder_before: b.holder_before, added_by: b.added_by }) });
    }
  }

  // ── F. verifiable production by franchise (a sum over verified possession periods; never attributed to a pick or a package) ──
  const mem = memoryView(archive);
  const byFranchiseSeason = new Map();
  const scoredPlayers = new Map(years.map((y) => [y, new Set()]));
  try {
    for (const [pid, firstSeason] of [...tradedPlayers.entries()].sort((a, b) => a[0].localeCompare(b[0], "en", { numeric: true }))) {
      const chain = chains.get(pid);
      const seasons = []; for (let y = Math.max(FIRST_YEAR, firstSeason); y <= LAST_YEAR; y++) seasons.push(y);
      const econ = playerEconomics({ archive: mem, ledger, chain, playerId: pid, seasons });
      for (const s of econ.seasons) {
        const pr = season.get(s.season).production;
        if (s.by_franchise.length) scoredPlayers.get(s.season).add(pid);
        for (const f of s.by_franchise) {
          const k = `${s.season}|${f.franchise}`;
          const row = byFranchiseSeason.get(k) || { season: s.season, franchise: f.franchise, players: 0, points_verified: 0, weeks_verified: 0, points_started_verified: 0, weeks_disputed: 0, weeks_transition: 0, weeks_outside_traced_window: 0, weeks_without_franchise: 0 };
          row.players += f.weeks_verified > 0 ? 1 : 0; row.points_verified += f.points_verified; row.weeks_verified += f.weeks_verified; row.points_started_verified += f.points_started_verified;
          row.weeks_disputed += f.disputed_weeks.filter((d) => d.category === "disputed").length; row.weeks_transition += f.disputed_weeks.filter((d) => d.category === "transition").length; row.weeks_outside_traced_window += f.weeks_outside_traced_window; row.weeks_without_franchise += f.weeks_without_franchise;
          byFranchiseSeason.set(k, row);
          pr.points_verified += f.points_verified; pr.weeks_verified += f.weeks_verified;
          pr.weeks_disputed += f.disputed_weeks.filter((d) => d.category === "disputed").length; pr.weeks_transition += f.disputed_weeks.filter((d) => d.category === "transition").length; pr.weeks_outside_traced_window += f.weeks_outside_traced_window; pr.weeks_without_franchise += f.weeks_without_franchise; pr.weeks_franchise_from_roster_record += f.weeks_franchise_from_roster_record;
        }
      }
    }
  } finally { mem.close(); }
  for (const y of years) {
    const p = season.get(y).production;
    p.traded_players_with_a_scoring_row = scoredPlayers.get(y).size; p.points_verified = r1(p.points_verified);
    p.franchise_seasons = [...byFranchiseSeason.values()].filter((x) => x.season === y).length;
    const scored = p.weeks_verified + p.weeks_disputed + p.weeks_transition + p.weeks_outside_traced_window + p.weeks_without_franchise;
    p.verified_share_of_scored_weeks = scored ? Math.round((p.weeks_verified / scored) * 1000) / 1000 : null;
  }
  const production = [...byFranchiseSeason.values()].sort((a, b) => a.season - b.season || a.franchise.localeCompare(b.franchise)).map((x) => ({ ...x, points_verified: r1(x.points_verified), points_started_verified: r1(x.points_started_verified) }));

  // ── G. coverage windows and eras ────────────────────────────────────────────────────────────
  const windows = ledger.windows.filter((w) => yearOf(w.to) >= FIRST_YEAR && yearOf(w.from) <= LAST_YEAR + 1).map((w) => ({ from: w.from, to: w.to, days: w.days }));
  const eras = years.map((y) => {
    const s = season.get(y);
    return { season: y, trade_time_quality: Object.keys(s.trades.date_quality).sort().join("+") || "no trades", draft_source: s.draft.source_table || "no draft results", draft_rounds: s.draft.rounds, selecting_franchises_vs_league: `${s.draft.selecting_franchises} of ${s.draft.league_franchises}` };
  });

  const sum = (f) => years.reduce((a, y) => a + f(season.get(y)), 0);
  const summary = {
    seasons: years.length, trades: sum((s) => s.trades.count), multi_asset_trades: sum((s) => s.trades.packages.multi_asset_trades), cap_transfers: sum((s) => s.trades.cap.transfers), cap_total: sum((s) => s.trades.cap.total_amount),
    draft_selections: sum((s) => s.draft.selections), scheduled_slots: sum((s) => s.draft.scheduled_slots), slot_status: Object.fromEntries(["SELECTED", "FORFEITED", "UNRESOLVED", "MISSING_SOURCE_RECORD"].map((k) => [k, sum((s) => s.draft.slot_status[k])])), legacy_slot_corrections: sum((s) => s.draft.legacy_slot_corrections), draft_rows_without_franchise_id: sum((s) => s.draft.rows_without_franchise_id),
    slot_picks: { traded: sum((s) => s.slot_picks.assets_traded), confirmed: sum((s) => s.slot_picks.confirmed), conflict: sum((s) => s.slot_picks.conflict), selector_not_recorded: sum((s) => s.slot_picks.selector_not_recorded), forfeited_slot: sum((s) => s.slot_picks.forfeited_slot), no_draft_result: sum((s) => s.slot_picks.no_draft_result), trades_after_selection: sum((s) => s.slot_picks.trades_after_selection) },
    future_picks: { traded: sum((s) => s.future_picks.assets_traded), confirmed: 0, inferred: sum((s) => s.future_picks.inferred), unresolved: sum((s) => s.future_picks.unresolved), funnel: Object.fromEntries(Object.keys(season.get(FIRST_YEAR).future_picks.funnel).map((k) => [k, sum((s) => s.future_picks.funnel[k])])) },
    player_chain_breaks: { discontinuity: sum((s) => s.chain_breaks.players.discontinuity), implicit_release: sum((s) => s.chain_breaks.players.implicit_release) },
    pick_chain_discontinuities: sum((s) => s.chain_breaks.picks.discontinuity),
    traded_players: tradedPlayers.size, production_points_verified: r1(sum((s) => s.production.points_verified)),
  };
  return {
    schema: "ups.league_record.s1.archive_extraction/1",
    scope: { first_season: FIRST_YEAR, last_season: LAST_YEAR, source: "committed archive through the guarded reader; no snapshot trade, no 2026 record", rules: ["draft slots only from MFL slot tokens and MFL draft results", "a scheduled slot is SELECTED, FORFEITED (a known forfeiture from a named provenance, no player), UNRESOLVED or a MISSING_SOURCE_RECORD: an absence is never called a forfeiture without a source", "a trade is one package: nothing is credited to a single asset of a multi-asset trade", "a future pick is never CONFIRMED to a slot; INFERRED only by UNIQUE_HOLDER_V1 with a complete inventory and observed custody", "production is a sum over verified possession periods per franchise, never attributed to a pick or a trade"] },
    summary, seasons: years.map((y) => season.get(y)), eras, coverage_windows: windows, named_gap: ledger.named_gap,
    production_by_franchise_season: production,
    findings: { totals, lists, list_cap: LIST_CAP, outside_the_stated_period: outOfScope },
  };
}
