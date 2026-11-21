// League Record S1 pilot: the lineage engine. It traces an asset (a player, a future pick, a slot pick) through the recorded trades, drafts, adds and drops, keeps every transition
// with its source reference, classifies every link, and never fills a hole.
//
// Link classes (docs/league_record/S1_METHODOLOGY.md):
//   CONFIRMED   a recorded MFL event states it (a trade leg, a draft result for a slot the chain names, a roster record).
//   CALCULATED  code arithmetic over confirmed inputs (points, salary), graded no higher than its inputs.
//   INFERRED    a link no record states, derived by a named rule whose conditions are all met; always labeled, never confirmed.
//   UNRESOLVED  the evidence is incomplete or competing; a candidate may be listed, but it counts for nothing.
// Draft slots come ONLY from MFL draft results, MFL's own slot lists and the slot tokens in MFL trades. Nothing here reads standings, finishes, brackets or a projected order.
import { etParts, dayNumber, addDays, playerAsset, slotPickAsset, loadArchiveTrades, loadSnapshotTrades, loadArchiveSelections, loadSnapshotSelections, loadSlotList, snapshotDays, readSnapshot, SNAPSHOT_DAY } from "./sources.mjs";

export const CLASS = Object.freeze({ CONFIRMED: "CONFIRMED", CALCULATED: "CALCULATED", INFERRED: "INFERRED", UNRESOLVED: "UNRESOLVED", MISSING: "MISSING" });
export const RULES = Object.freeze({
  SLOT_TOKEN_DRAFT_RESULT: "SLOT_TOKEN_DRAFT_RESULT",          // a slot named by an MFL slot token, and the MFL draft result for that slot
  UNIQUE_HOLDER_V1: "UNIQUE_HOLDER_V1",                         // Keith's conditional rule (2026-11-20): the holder owns exactly one slot in the round and custody of the pick is observed up to the evidence date
});

// ── ledger ────────────────────────────────────────────────────────────────────────────────────────
const arr = (x) => (Array.isArray(x) ? x : x == null ? [] : [x]);

export function loadAddDrops(archive, root, day = SNAPSHOT_DAY) {
  const byPlayer = new Map();
  const push = (pid, e) => { if (!byPlayer.has(pid)) byPlayer.set(pid, []); byPlayer.get(pid).push(e); };
  for (const r of archive.all("select season, txn_index idx, franchise_id f, player_id pid, move_type mt, method, unix_timestamp ts, date_et d, time_et tm, transactionid tid from transactions_adddrop")) {
    push(r.pid, { kind: r.mt === "ADD" ? "add" : "drop", franchise: r.f, ts: Number(r.ts), date: r.d, time: r.tm, method: r.method, source: { kind: "archive", table: "transactions_adddrop", transactionid: r.tid } });
  }
  // auction wins (the archive's winning-bid rows; owner columns are never selected)
  for (const r of archive.all("select transactionid tid, player_id pid, franchise_id f, bid_amount amount, unix_timestamp ts, date_et d, time_et tm from transactions_auction where auction_event_type = 'WON'")) {
    push(r.pid, { kind: "add", franchise: r.f, ts: Number(r.ts), date: r.d, time: r.tm, method: "AUCTION_WON", amount: r.amount, source: { kind: "archive", table: "transactions_auction", transactionid: r.tid } });
  }
  const j = readSnapshot(root, day, "transactions.json");
  arr(j && j.transactions && j.transactions.transaction).forEach((t, index) => {
    const ts = Number(t.timestamp), { date, time } = etParts(ts);
    const src = { kind: "snapshot", day, file: "transactions.json", index, type: t.type };
    const list = (s) => String(s || "").split(",").map((x) => x.trim()).filter((x) => /^\d{3,6}$/.test(x));
    if (t.type === "FREE_AGENT") { const [a, d] = String(t.transaction).split("|"); for (const p of list(a)) push(p, { kind: "add", franchise: t.franchise, ts, date, time, method: t.type, source: src }); for (const p of list(d)) push(p, { kind: "drop", franchise: t.franchise, ts, date, time, method: t.type, source: src }); }
    else if (t.type === "BBID_WAIVER") { const [a, , d] = String(t.transaction).split("|"); for (const p of list(a)) push(p, { kind: "add", franchise: t.franchise, ts, date, time, method: t.type, source: src }); for (const p of list(d)) push(p, { kind: "drop", franchise: t.franchise, ts, date, time, method: t.type, source: src }); }
    else if (t.type === "AUCTION_WON") { const [a] = String(t.transaction).split("|"); for (const p of list(a)) push(p, { kind: "add", franchise: t.franchise, ts, date, time, method: t.type, source: src }); }
  });
  for (const list of byPlayer.values()) list.sort((a, b) => a.ts - b.ts);
  return byPlayer;
}

// Coverage windows: the periods no source observes. Data-driven: any run of at least 14 days with no recorded transaction of any kind, plus the tail after the last recorded TRADE
// of the archive (trading closes at the Thanksgiving-week deadline, canon A6) up to the first 2026 transaction. All dates are Eastern.
export function coverageWindows(archive) {
  const dates = new Set();
  for (const r of archive.all("select distinct date_et d from transactions_base")) if (r.d) dates.add(r.d);
  const sorted = [...dates].sort();
  const windows = [];
  for (let i = 1; i < sorted.length; i++) {
    const gap = dayNumber(sorted[i]) - dayNumber(sorted[i - 1]);
    if (gap >= 14) windows.push({ from: addDays(sorted[i - 1], 1), to: addDays(sorted[i], -1), kind: "unobserved", days: gap - 1, basis: "no recorded transaction of any kind in the archive for 14 or more days" });
  }
  return windows;
}

export function buildLedger({ archive, root }) {
  const archiveTrades = loadArchiveTrades(archive);
  const snapshotTrades = loadSnapshotTrades(root);
  const trades = [...archiveTrades, ...snapshotTrades].sort((a, b) => a.ts - b.ts || String(a.id).localeCompare(String(b.id), "en", { numeric: true }));
  const tradesByAsset = new Map();
  for (const t of trades) for (const leg of t.legs) { if (!leg.asset) continue; if (!tradesByAsset.has(leg.asset)) tradesByAsset.set(leg.asset, []); tradesByAsset.get(leg.asset).push({ trade: t, leg }); }
  const selections = [...loadArchiveSelections(archive), ...loadSnapshotSelections(root)];
  const selBySlot = new Map(selections.map((s) => [`${s.year}:${s.round}:${s.slot}`, s]));
  const selByPlayer = new Map();
  for (const s of selections) { if (!selByPlayer.has(s.player_id)) selByPlayer.set(s.player_id, []); selByPlayer.get(s.player_id).push(s); }
  const lastArchiveTrade = archiveTrades.at(-1);
  const lastArchiveTx = archive.get("select max(date_et) d from transactions_base").d;
  const firstSnapTradeTs = snapshotTrades.length ? snapshotTrades[0].ts : null;
  const txs = arr(readSnapshot(root, SNAPSHOT_DAY, "transactions.json").transactions.transaction);
  const firstSnapTx = Math.min(...txs.map((t) => Number(t.timestamp)));
  const windows = coverageWindows(archive);
  // The window the owner named: from the day after the last recorded TRADE (the deadline) to the evening before the first 2026 transaction.
  const gapFrom = addDays(lastArchiveTrade.date, 1), gapTo = etParts(firstSnapTx).date;
  const named = { from: gapFrom, to: addDays(gapTo, 0), kind: "incomplete_trade_coverage", last_archive_trade: lastArchiveTrade.date, last_archive_transaction: lastArchiveTx, first_snapshot_transaction_et: `${etParts(firstSnapTx).date} ${etParts(firstSnapTx).time}`,
    first_snapshot_trade: firstSnapTradeTs ? etParts(firstSnapTradeTs).date : null,
    basis: "the archive's last TRADE is the deadline day; other archive transaction types run to the last archive transaction date; the first 2026 snapshot transaction starts the next observed period. Nothing observes a trade between them." };
  // The franchises of a season (the league's team list): archive weekly rosters for archived seasons, the pinned snapshot's rosters for later ones. Used to test that a round's slot inventory is complete.
  const franchiseCache = new Map();
  const franchisesFor = (year) => {
    if (!franchiseCache.has(year)) {
      let ids = archive.all("select distinct franchise_id f from rosters_weekly where season = ?", year).map((r) => String(r.f));
      if (!ids.length) ids = arr(readSnapshot(root, SNAPSHOT_DAY, "rosters.json").rosters.franchise).map((f) => String(f.id));
      franchiseCache.set(year, ids.sort());
    }
    return franchiseCache.get(year);
  };
  return { trades, tradesByAsset, selections, selBySlot, selByPlayer, addDrops: loadAddDrops(archive, root), windows, named_gap: named, archiveTrades, snapshotTrades, root, archive, franchisesFor };
}

// Does an unobserved period overlap [fromTs, toTs]? Dates are compared in Eastern time. Returns the overlapping windows.
export function gapsBetween(ledger, fromTs, toTs) {
  const a = etParts(fromTs).date, b = etParts(toTs).date;
  const out = [];
  const consider = (w) => { if (!(w.to < a || w.from > b)) out.push(w); };
  for (const w of ledger.windows) consider(w);
  consider(ledger.named_gap);
  return out;
}

// ── player and pick chains ────────────────────────────────────────────────────────────────────────
// events: the recorded movements of one asset, in time order, each with its source. holders: the possession periods they imply. breaks: where a record does not continue the last one.
export function playerChain(ledger, playerId, { sinceTs = 0 } = {}) {
  const asset = playerAsset(playerId);
  const events = [];
  for (const { trade, leg } of ledger.tradesByAsset.get(asset) || []) events.push({ kind: "trade", ts: trade.ts, date: trade.date, time: trade.time, from: leg.from, to: leg.to, trade: trade.id, source: trade.source, rows: leg.rows || null, date_quality: trade.date_quality });
  for (const s of ledger.selByPlayer.get(String(playerId)) || []) events.push({ kind: "draft_selection", ts: s.ts, date: s.date, time: etParts(s.ts).time, to: s.franchise, year: s.year, round: s.round, slot: s.slot, source: s.source });
  for (const e of ledger.addDrops.get(String(playerId)) || []) events.push({ kind: e.kind, ts: e.ts, date: e.date, time: e.time, [e.kind === "add" ? "to" : "from"]: e.franchise, method: e.method, source: e.source });
  events.sort((a, b) => a.ts - b.ts || (a.kind === "draft_selection" ? -1 : 0));
  const use = events.filter((e) => e.ts >= sinceTs);
  return buildHolders(asset, use);
}

export function pickChain(ledger, assetId, { sinceTs = 0 } = {}) {
  const events = (ledger.tradesByAsset.get(assetId) || []).map(({ trade, leg }) => ({ kind: "trade", ts: trade.ts, date: trade.date, time: trade.time, from: leg.from, to: leg.to, trade: trade.id, source: trade.source, rows: leg.rows || null, date_quality: trade.date_quality }));
  events.sort((a, b) => a.ts - b.ts);
  return buildHolders(assetId, events.filter((e) => e.ts >= sinceTs));
}

function buildHolders(asset, events) {
  const holders = [], breaks = [];
  let cur = null;
  for (const e of events) {
    if (e.kind === "trade") {
      if (cur && cur.franchise !== e.from) breaks.push({ kind: "discontinuity", at: e.trade, date: e.date, expected_holder: cur.franchise, recorded_sender: e.from, note: "the record's sender is not the holder the previous records leave: something between them is missing or recorded differently" });
      if (cur) { cur.to_ts = e.ts; cur.to_event = e; holders.push(cur); }
      else holders.push({ franchise: e.from, from_ts: null, from_event: null, to_ts: e.ts, to_event: e, origin: "asserted_by_first_record" });
      cur = { franchise: e.to, from_ts: e.ts, from_event: e, to_ts: null, to_event: null };
    } else if (e.kind === "draft_selection" || e.kind === "add") {
      // an add by another franchise while a holder is open means the holder released the player without a recorded release (a contract that expired before an auction, for example)
      if (cur && cur.franchise !== e.to) breaks.push({ kind: "implicit_release", at: e.source, date: e.date, holder_before: cur.franchise, added_by: e.to, note: "the previous holder's release is not recorded; the add by another franchise is the first record that ends the stint" });
      if (cur) { cur.to_ts = e.ts; cur.to_event = e; holders.push(cur); }
      cur = { franchise: e.to, from_ts: e.ts, from_event: e, to_ts: null, to_event: null };
    } else if (e.kind === "drop") {
      if (cur && cur.franchise !== e.from) breaks.push({ kind: "discontinuity", at: e.source, date: e.date, expected_holder: cur.franchise, recorded_sender: e.from, note: "a drop is recorded by a franchise that is not the holder" });
      if (cur) { cur.to_ts = e.ts; cur.to_event = e; holders.push(cur); }
      cur = null;
    }
  }
  if (cur) holders.push(cur);
  return { asset, events, holders, breaks };
}

export const holderAt = (chain, ts) => { const h = chain.holders.find((x) => (x.from_ts == null || x.from_ts <= ts) && (x.to_ts == null || ts < x.to_ts)); return h ? h.franchise : null; };
export const lastHolder = (chain) => (chain.holders.length ? chain.holders.at(-1) : null);

// ── slot picks (an MFL slot token names the slot) ─────────────────────────────────────────────────
// The slot pick (year, round, slot) is identified by MFL itself; its draft result is the selection recorded for that slot. CONFIRMED when the franchise that made the selection is the
// franchise the chain leaves holding the slot at the moment of the selection; a difference is disclosed as a conflict (canon T1.8: draft results record who clicked).
export function resolveSlotPick(ledger, chain, year, round, slot) {
  const sel = ledger.selBySlot.get(`${year}:${round}:${slot}`) || null;
  if (!sel) return { class: CLASS.UNRESOLVED, rule: RULES.SLOT_TOKEN_DRAFT_RESULT, reason: "no draft result is recorded for this slot", selection: null };
  const holder = holderAt(chain, sel.ts - 1);
  const gaps = chain.holders.length ? gapsBetween(ledger, chain.holders.at(-1).from_ts || sel.ts, sel.ts) : [];
  if (holder === sel.franchise) return { class: CLASS.CONFIRMED, rule: RULES.SLOT_TOKEN_DRAFT_RESULT, selection: sel, holder_at_selection: holder, coverage_gaps: gaps };
  return { class: CLASS.UNRESOLVED, rule: RULES.SLOT_TOKEN_DRAFT_RESULT, reason: `the chain leaves franchise ${holder || "(nobody)"} holding the slot but the draft result records franchise ${sel.franchise}`, selection: sel, holder_at_selection: holder, conflict: true, coverage_gaps: gaps };
}

// ── future picks (an MFL token names the ORIGINAL franchise, not the slot) ─────────────────────────
// The identity of a future pick is (original franchise, year, round). Which SLOT it became is not stated by any recorded token. Evidence, in order:
//   1. a slot token whose own chain contains this pick: impossible to link by tokens alone, so never used;
//   2. UNIQUE_HOLDER_V1 (conditional approval): the chain's last holder H owns exactly ONE slot in that round on the evidence date, AND custody of the pick by H is observed from its
//      last recorded transfer to the evidence date (no unobserved period in between), AND the draft or slot-list record of the evidence date is authoritative. Then the link is INFERRED.
//   3. otherwise UNRESOLVED, with the candidate slots H holds, MFL's slot notes for them and every missing period listed. Notes never upgrade a link by themselves.
// Is the round's pick inventory demonstrably complete on the evidence date? Every condition must hold (Keith's condition for UNIQUE_HOLDER_V1, 2026-11-20):
//   1. the league's team list for the season is known, and the evidence lists exactly one slot per team for the round (slots 1..N, each with a holder that is a league franchise);
//   2. no slot-token (DP_) transfer exists for this season and round (a slot-named transfer would need its own accounting, which this pilot does not do);
//   3. every future pick of the round (one per original franchise) has a chain without a break, and the holder each chain leaves equals the holder the evidence lists, franchise by franchise
//      (the count of picks the records say a franchise holds equals the count of slots the evidence gives it), so every possible competing pick is accounted for.
// Returns { complete, reasons, checked }. Any failed condition is a reason; the caller reports UNRESOLVED.
export function inventoryCheck(ledger, chain, { year, round, original }, inventory, evidenceTs = null) {
  const reasons = [];
  const teams = typeof ledger.franchisesFor === "function" ? ledger.franchisesFor(year) : [];
  if (!teams.length) reasons.push("the league's team list for the season is not known, so a complete round cannot be shown");
  const slotNos = inventory.map((x) => x.slot).sort((a, b) => a - b);
  if (teams.length && (slotNos.length !== teams.length || slotNos.some((n, i) => n !== i + 1))) reasons.push(`the evidence lists ${slotNos.length} slot(s) for round ${round} (${[...new Set(slotNos)].join(", ")}), not one for each of the league's ${teams.length} teams`);
  if (teams.length && inventory.some((x) => !teams.includes(String(x.holder)))) reasons.push("the evidence names a holder that is not a franchise of the season");
  const prefix = `spick:${year}:${round}:`;
  if ([...(ledger.tradesByAsset ? ledger.tradesByAsset.keys() : [])].some((k) => k.startsWith(prefix))) reasons.push("a slot-token transfer exists for this season and round: slot-named transfers are not accounted for here");
  if (teams.length) {
    const implied = new Map(teams.map((t) => [t, 0]));
    for (const o of teams) {
      const asset = `fpick:${o}:${year}:${round}`;
      const c = o === original && chain ? chain : pickChain(ledger, asset);
      if (c.breaks && c.breaks.length) reasons.push(`the chain of the ${o} pick has a break, so the records do not say who holds it`);
      // the holder ON THE EVIDENCE DATE (a transfer after it belongs to a later inventory), the last holder when no date is given
      const onDate = evidenceTs != null && c.holders ? holderAt(c, evidenceTs) : null;
      // a chain whose first record comes AFTER the evidence date starts with an asserted sender: it is accepted only when that sender is the original franchise (nothing earlier is missing)
      const first = c.holders && c.holders[0];
      if (evidenceTs != null && first && first.from_ts == null && first.to_ts != null && evidenceTs < first.to_ts && first.franchise !== o) reasons.push(`the earliest record of the ${o} pick comes after the evidence date and names ${first.franchise} as the sender, so who held it on the evidence date is not recorded`);
      const h = onDate || (c.holders && c.holders.length ? c.holders.at(-1).franchise : o);
      implied.set(h, (implied.get(h) || 0) + 1);
    }
    const listed = new Map(teams.map((t) => [t, 0]));
    for (const x of inventory) listed.set(String(x.holder), (listed.get(String(x.holder)) || 0) + 1);
    const diff = teams.filter((t) => (implied.get(t) || 0) !== (listed.get(t) || 0)).map((t) => `${t}: records say ${implied.get(t) || 0}, the evidence lists ${listed.get(t) || 0}`);
    if (diff.length) reasons.push(`the records and the evidence disagree on who holds the picks of the round (${diff.slice(0, 4).join("; ")})`);
  }
  return { complete: reasons.length === 0, reasons, checked: { teams: teams.length, slots_listed: inventory.length } };
}

// evidence: a slot list (loadSlotList) for a pre-draft day, or null to use the final draft results.
export function resolveFuturePick(ledger, chain, { year, round, original }, { slotLists = [] } = {}) {
  const last = lastHolder(chain);
  const holder = last ? last.franchise : original;                               // a never-traded pick is held by its original franchise
  const lastLegTs = last && last.from_ts ? last.from_ts : null;
  const selections = ledger.selections.filter((s) => s.year === year && s.round === round);
  const draftStart = selections.length ? Math.min(...selections.map((s) => s.ts)) : null;
  // the evidence list: the latest pre-draft slot list before the draft, else the final draft results
  let evidence = null;
  for (const l of slotLists) if (l && l.year === year) { if (!draftStart || l.ts < draftStart) evidence = !evidence || l.ts > evidence.ts ? l : evidence; }
  const candidates = [];
  if (evidence) for (const s of evidence.slots.filter((x) => x.round === round && x.holder === holder)) candidates.push({ slot: s.slot, via: "mfl_slot_list", day: evidence.day, notes: s.note_lines, traded_from_ids: s.traded_from_ids, traded_from_names: s.traded_from_names });
  else for (const s of selections.filter((x) => x.franchise === holder)) candidates.push({ slot: s.slot, via: "draft_result", notes: String(s.note || "").split(/\n/).map((x) => x.replace(/^\[|\]$/g, "").trim()).filter(Boolean), selection: s });
  const evidenceTs = evidence ? evidence.ts : draftStart;
  const gaps = lastLegTs && evidenceTs ? gapsBetween(ledger, lastLegTs, evidenceTs) : [];
  const base = { holder, original, year, round, candidates, last_transfer_ts: lastLegTs, evidence_day: evidence ? evidence.day : null, evidence_kind: evidence ? "mfl_slot_list" : "draft_results", coverage_gaps: gaps };
  // the evidence inventory of the round: the slot list's slots, or the draft results' selections
  const inventory = evidence ? evidence.slots.filter((x) => x.round === round).map((x) => ({ slot: x.slot, holder: x.holder })) : selections.map((x) => ({ slot: x.slot, holder: x.franchise }));
  const inv = inventoryCheck(ledger, chain, { year, round, original }, inventory, evidenceTs);
  if (evidenceTs) base.inventory = inv;
  if (!evidenceTs) return { ...base, class: CLASS.UNRESOLVED, reason: "no slot list or draft result exists for this year and round" };
  if (gaps.length) return { ...base, class: CLASS.UNRESOLVED, reason: "custody of the pick is not observed between its last recorded transfer and the evidence date: a transfer in the unobserved period would change which slot it is, so uniqueness cannot be used as proof", rule_considered: RULES.UNIQUE_HOLDER_V1 };
  if (!inv.complete) return { ...base, class: CLASS.UNRESOLVED, reason: `the round's pick inventory is not demonstrably complete on the evidence date, so uniqueness cannot be used as proof: ${inv.reasons.join(" | ")}`, rule_considered: RULES.UNIQUE_HOLDER_V1 };
  if (candidates.length === 1) return { ...base, class: CLASS.INFERRED, rule: RULES.UNIQUE_HOLDER_V1, slot: candidates[0].slot, selection: ledger.selBySlot.get(`${year}:${round}:${candidates[0].slot}`) || null,
    disclosure: "inferred, never confirmed: the holder owns exactly one slot in this round on the evidence date, the round's inventory is complete and every pick of the round is accounted for, and custody is observed to that date; a competing reading would need an unrecorded transfer" };
  return { ...base, class: CLASS.UNRESOLVED, reason: candidates.length ? `the holder owns ${candidates.length} slots in this round on the evidence date, so the pick's slot is one of them` : "the holder owns no slot in this round on the evidence date, which the chain cannot explain", rule_considered: RULES.UNIQUE_HOLDER_V1 };
}

// The pre-draft slot lists of a year, as { year, day, ts, slots } sorted by day (2026 only: the daily snapshots start on 2026-04-21).
export function loadYearSlotLists(root, year) {
  const out = [];
  for (const day of snapshotDays(root)) {
    if (!day.startsWith(`${year}-`)) continue;
    const l = loadSlotList(root, day);
    if (!l) continue;
    out.push({ ...l, year, ts: Math.floor(Date.parse(`${day}T12:00:00Z`) / 1000) });
  }
  return out;
}

export { slotPickAsset };
