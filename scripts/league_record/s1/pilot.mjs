// League Record S1 pilot: the A.J. Brown / HammerTime lineage. Builds one deterministic evidence bundle (plain data, no clock, no network) from the committed archive and snapshots.
//
// From franchise 0005's (HammerTime) side: what it surrendered to acquire Brown (trade2024_30), what Brown produced and cost while it held him, what it received when it traded him
// (trade2025_5, with the 20K cap transfer), and where every received asset went afterward, branch by branch, to a stated generation limit; the frontier beyond it is listed, not hidden.
import fs from "node:fs";
import path from "node:path";
import { openArchive, ARCHIVE_GZ_PATH, ARCHIVE_GZ_SHA256, ALLOWED_TABLES } from "./archive.mjs";
import { SNAPSHOT_DAY, snapshotDays, snapshotRosterIndex, etParts, franchiseNames } from "./sources.mjs";
import { buildLedger, playerChain, pickChain, lastHolder, holderAt, resolveSlotPick, resolveFuturePick, loadYearSlotLists, gapsBetween, CLASS, RULES } from "./lineage.mjs";
import { playerEconomics, kickoffDates, lastLeagueWeek } from "./economics.mjs";

export const PILOT = Object.freeze({
  id: "aj_brown_hammertime",
  franchise: "0005",
  upstream_trade: "trade2024_30",
  primary_trade: "trade2025_5",
  max_generation: 4,
  last_archive_season: 2025,
});

const SCHEMA = "ups.league_record.s1.pilot/1";

const assetKind = (a) => (a.startsWith("player:") ? "player" : a.startsWith("spick:") ? "slot_pick" : a.startsWith("fpick:") ? "future_pick" : "other");
const pickParts = (a) => a.split(":").slice(1);

function tradeSummary(t) {
  return { id: t.id, class: CLASS.CONFIRMED, class_basis: "a recorded MFL trade", date: t.date, time: t.time, date_quality: t.date_quality, source: t.source, parties: t.parties, team_names: t.names, legs: t.legs.map((l) => ({ class: l.unpaired ? CLASS.UNRESOLVED : CLASS.CONFIRMED, asset: l.asset, kind: l.kind || null, from: l.from, to: l.to, label: l.label || null, token: l.token || null, rows: l.rows || null, unpaired: l.unpaired || false })), cap: t.cap.map((c) => ({ class: CLASS.CONFIRMED, amount: c.amount, from: c.from, to: c.to, rows: c.rows || null, token: c.token || null })) };
}
function eventRef(e) {
  if (!e) return null;
  return { class: CLASS.CONFIRMED, kind: e.kind, date: e.date, time: e.time, trade: e.trade || null, from: e.from || null, to: e.to || null, round: e.round || null, slot: e.slot || null, method: e.method || null, date_quality: e.date_quality || null, source: e.source };
}
function holderRef(h) {
  return { class: CLASS.CONFIRMED, franchise: h.franchise, from: h.from_event ? { date: h.from_event.date, time: h.from_event.time, kind: h.from_event.kind, trade: h.from_event.trade || null } : { origin: h.origin || "before_the_first_record" }, to: h.to_event ? { date: h.to_event.date, time: h.to_event.time, kind: h.to_event.kind, trade: h.to_event.trade || null } : null };
}

export async function buildPilotBundle({ root, cacheDir } = {}) {
  const archive = await openArchive({ root, cacheDir });
  try { return buildFrom({ archive, root }); } finally { archive.close(); }
}

function buildFrom({ archive, root }) {
  const ledger = buildLedger({ archive, root });
  const names = franchiseNames(root, SNAPSHOT_DAY);
  const tradeById = new Map(ledger.trades.map((t) => [t.id, t]));
  const up = tradeById.get(PILOT.upstream_trade), pri = tradeById.get(PILOT.primary_trade);
  if (!up || !pri) throw new Error("the pilot trades are not in the archive");
  const F = PILOT.franchise;
  const rosterNow = snapshotRosterIndex(root);
  const slotLists2026 = loadYearSlotLists(root, 2026);
  const draftStart2026 = Math.min(...ledger.selections.filter((s) => s.year === 2026).map((s) => s.ts));
  const preDraft = slotLists2026.filter((l) => l.ts < draftStart2026);
  const firstList = slotLists2026[0] || null, lastPre = preDraft.at(-1) || null;
  const usedTrades = new Map();
  const nodes = new Map();
  const order = [];
  const gapsFound = [];
  const playerEcon = new Map();

  const useTrade = (id) => { if (!usedTrades.has(id)) usedTrades.set(id, tradeSummary(tradeById.get(id))); };

  function econFor(playerId, chain, fromTs) {
    if (playerEcon.has(playerId)) return playerEcon.get(playerId);
    const startSeason = Number(etParts(fromTs).date.slice(0, 4));
    const seasons = [];
    for (let s = Math.max(startSeason, 2010); s <= PILOT.last_archive_season; s++) seasons.push(s);
    const e = playerEconomics({ archive, ledger, chain, playerId, seasons });
    for (const se of e.seasons) { for (const fr of se.by_franchise) fr.class = CLASS.CALCULATED; for (const c of se.contract_by_roster_weeks) c.class = CLASS.CONFIRMED; }
    playerEcon.set(playerId, e);
    return e;
  }

  // classOfLink: how the asset got into the graph (CONFIRMED by a recorded event, or INFERRED through a rule); inheritedFrom: the node a non-confirmed class came through
  function addNode(assetId, { generation, role, entered, classOfLink = CLASS.CONFIRMED, via = null, sinceTs, expand = true }) {
    if (nodes.has(assetId)) return nodes.get(assetId);
    const kind = assetKind(assetId);
    const node = { id: assetId, kind, generation, role, entered, link_class: classOfLink, via, transfers: [], departures: [], notes: [] };
    nodes.set(assetId, node); order.push(assetId);
    if (kind === "player") {
      const pid = assetId.split(":")[1];
      const chain = playerChain(ledger, pid, { sinceTs });
      node.label = playerLabel(pid) || `player ${pid}`;
      node.chain = { holders: chain.holders.map(holderRef), breaks: chain.breaks.map((b) => ({ class: CLASS.UNRESOLVED, ...b })), events: chain.events.map(eventRef) };
      for (const e of chain.events) if (e.trade) useTrade(e.trade);
      if (chain.breaks.length) for (const b of chain.breaks) gapsFound.push({ kind: "chain_break", asset: assetId, ...b });
      const last = lastHolder(chain);
      node.final_position = finalPosition(pid, last, chain);
      node._chain = chain;
      node.economics = econFor(pid, chain, sinceTs);
      if (expand) expandTransfers(node, chain);
    } else {
      const chain = pickChain(ledger, assetId, { sinceTs });
      node.chain = { holders: chain.holders.map(holderRef), breaks: chain.breaks.map((b) => ({ class: CLASS.UNRESOLVED, ...b })), events: chain.events.map(eventRef) };
      for (const e of chain.events) if (e.trade) useTrade(e.trade);
      if (chain.breaks.length) for (const b of chain.breaks) gapsFound.push({ kind: "chain_break", asset: assetId, ...b });
      node._chain = chain;
      if (kind === "slot_pick") {
        const [y, r, s] = pickParts(assetId).map(Number);
        const res = resolveSlotPick(ledger, chain, y, r, s);
        node.resolution = packResolution(res);
        node.label = `${y} round ${r}, slot ${s} (pick ${r}.${String(s).padStart(2, "0")})`;
        node.final_position = { kind: "slot_pick", resolved: res.class === CLASS.CONFIRMED, selected_player: res.selection ? res.selection.player_id : null };
        if (res.selection && res.class === CLASS.CONFIRMED) {
          const pn = addNode(`player:${res.selection.player_id}`, { generation: generation + 1, role: "drafted_player", entered: { via: "draft_selection", date: res.selection.date, source: res.selection.source }, classOfLink: classOfLink, via: assetId, sinceTs: res.selection.ts });
          node.became = pn.id;
        }
      } else {
        const [orig, y, r] = pickParts(assetId);
        const res = resolveFuturePick(ledger, chain, { year: Number(y), round: Number(r), original: orig }, { slotLists: preDraft.map((l) => ({ ...l })) });
        node.resolution = packFuture(res, { firstList, lastPre, ledger, years: Number(y), round: Number(r), labelOf: playerLabel });
        node.label = `${y} round ${r} pick, original franchise ${orig}`;
        node.final_position = { kind: "future_pick", resolved: res.class === CLASS.INFERRED, holder_at_evidence: res.holder, candidate_slots: res.candidates.map((c) => c.slot) };
        if (res.class === CLASS.INFERRED && res.selection) {
          const pn = addNode(`player:${res.selection.player_id}`, { generation: generation + 1, role: "drafted_player", entered: { via: "inferred_draft_link", date: res.selection.date, source: res.selection.source }, classOfLink: CLASS.INFERRED, via: assetId, sinceTs: res.selection.ts });
          node.became = pn.id;
        }
      }
      if (expand) expandTransfers(node, chain);
    }
    return node;
  }

  function playerLabel(pid) {
    const r = archive.get("select name from players where player_id = ? order by season desc limit 1", String(pid));
    return r ? r.name : null;
  }

  function finalPosition(pid, last, chain) {
    const snap = rosterNow.get(String(pid)) || null;
    const chainHolder = last && last.to_ts == null ? last.franchise : null;
    const out = { chain_last_holder: chainHolder, chain_ended_by: last && last.to_event ? last.to_event.kind : null, snapshot_day: SNAPSHOT_DAY, snapshot_franchise: snap ? snap.franchise : null,
      snapshot_contract: snap ? { salary: snap.salary, years_remaining: snap.contract_year, status: snap.contract_status, info: snap.contract_info, roster_status: snap.status } : null };
    out.consistent = chainHolder && snap ? chainHolder === snap.franchise : null;
    if (chainHolder && snap && chainHolder !== snap.franchise) gapsFound.push({ kind: "position_conflict", asset: `player:${pid}`, chain_last_holder: chainHolder, snapshot_franchise: snap.franchise, note: "the recorded transfers leave the player with one franchise and the latest roster snapshot shows another: a transfer is missing from the records, or happened in an unobserved period" });
    return out;
  }

  // what franchise F received when it sent this asset on: the consideration (confirmed by the trade record) and the other assets in the same deal (companions, not traced)
  function expandTransfers(node, chain) {
    for (const h of chain.holders.filter((x) => x.franchise === F && x.to_event && x.to_event.kind !== "trade")) node.departures.push({ class: CLASS.CONFIRMED, kind: h.to_event.kind, date: h.to_event.date, time: h.to_event.time, method: h.to_event.method || null, source: h.to_event.source, note: "released rather than traded: no consideration was recorded" });
    const heldByF = chain.holders.filter((h) => h.franchise === F && h.to_event && h.to_event.kind === "trade");
    for (const h of heldByF) {
      const t = tradeById.get(h.to_event.trade); useTrade(t.id);
      const sentByF = t.legs.filter((l) => l.from === F), recvByF = t.legs.filter((l) => l.to === F);
      const consideration = recvByF.map((l) => l.asset), companionsSent = sentByF.filter((l) => l.asset !== node.id).map((l) => l.asset);
      const capIn = t.cap.filter((c) => c.to === F), capOut = t.cap.filter((c) => c.from === F);
      const rec = { class: CLASS.CONFIRMED, trade: t.id, date: t.date, time: t.time, sent_asset: node.id, sent_to: h.to_event.to, consideration, cap_received: capIn.map((c) => c.amount), cap_sent: capOut.map((c) => c.amount), companions_sent: companionsSent, expanded: node.generation < PILOT.max_generation };
      node.transfers.push(rec);
      if (node.generation < PILOT.max_generation && node.link_class !== CLASS.UNRESOLVED) {
        for (const cid of consideration) if (cid && !nodes.has(cid)) addNode(cid, { generation: node.generation + 1, role: "consideration", entered: { via: "trade", trade: t.id, date: t.date, received_for: node.id }, classOfLink: node.link_class, via: node.id, sinceTs: t.ts });
      } else rec.frontier = true;
    }
  }

  // ── roots ────────────────────────────────────────────────────────────────────────────────────
  // upstream: what F surrendered and what it acquired
  const surrendered = up.legs.filter((l) => l.from === F), acquired = up.legs.filter((l) => l.to === F);
  useTrade(up.id); useTrade(pri.id);
  const roots = { upstream: { trade: up.id, surrendered: surrendered.map((l) => l.asset), acquired: acquired.map((l) => l.asset), cap: up.cap.map((c) => ({ amount: c.amount, from: c.from, to: c.to })) }, primary: { trade: pri.id, sent: pri.legs.filter((l) => l.from === F).map((l) => l.asset), received: pri.legs.filter((l) => l.to === F).map((l) => l.asset), cap_sent: pri.cap.filter((c) => c.from === F).map((c) => c.amount), cap_received: pri.cap.filter((c) => c.to === F).map((c) => c.amount) } };
  // the surrendered asset is shown with its own history (not expanded: it is what 0005 gave up, its later life is context); the acquired asset (Brown) is the root of the downstream trace
  for (const l of surrendered) addNode(l.asset, { generation: 0, role: "surrendered_upstream", entered: { via: "trade", trade: up.id, date: up.date, sent_by: F }, sinceTs: up.ts - 400 * 86400, expand: false });
  for (const l of acquired) addNode(l.asset, { generation: 0, role: "acquired_upstream", entered: { via: "trade", trade: up.id, date: up.date, received_by: F }, sinceTs: up.ts - 1 });

  // ── bundle ────────────────────────────────────────────────────────────────────────────────────
  const nodeList = order.map((id) => { const n = nodes.get(id); const { _chain, ...rest } = n;
    // a slot pick stops existing as a pick when it is used: its last possession period ends at the selection
    if (rest.kind === "slot_pick" && rest.resolution && rest.resolution.selection && rest.chain.holders.length) { const h = rest.chain.holders.at(-1); if (!h.to) h.to = { date: rest.resolution.selection.date, time: rest.resolution.selection.time, kind: "draft_selection", trade: null }; }
    rest.named_gap = namedGapExposure(ledger, rest.chain.holders);
    return rest; });
  const frontier = nodeList.flatMap((n) => n.transfers.filter((t) => t.frontier).map((t) => ({ asset: n.id, trade: t.trade, date: t.date, consideration: t.consideration, note: `generation limit ${PILOT.max_generation} reached: this transfer's consideration is listed, not traced` })));
  const views = buildViews(nodeList);
  const trades = Object.fromEntries([...usedTrades.entries()].sort((a, b) => a[1].date.localeCompare(b[1].date) || a[0].localeCompare(b[0], "en", { numeric: true })));
  const coverage = { named_gap: ledger.named_gap, windows_overlapping_the_chains: collectWindows(ledger, nodes), historical_pattern: tradeSeasonPattern(ledger), first_pre_draft_slot_list: firstList ? firstList.day : null, last_pre_draft_slot_list: lastPre ? lastPre.day : null, archive_last_trade: ledger.archiveTrades.at(-1).date, snapshot_first_trade: ledger.snapshotTrades[0] ? ledger.snapshotTrades[0].date : null };
  const reconciliation = reconcile({ ledger, nodes, nodeList, archive, rosterNow, firstList, lastPre });
  const bundle = {
    schema: SCHEMA,
    pilot: { ...PILOT, team_names: Object.fromEntries([...names].filter(([id]) => ["0004", "0005", "0006", "0007", "0008", "0009", "0010", "0011", "0001"].includes(id))) },
    sources: { archive: { path: ARCHIVE_GZ_PATH, sha256: ARCHIVE_GZ_SHA256, tables_read: ALLOWED_TABLES }, snapshots: { dir: "data/mfl-snapshots", pinned_day: SNAPSHOT_DAY, days_available: snapshotDays(root).length, files: ["transactions.json", "draftResults.json", "rosters.json", "league.json", "_snapshot_meta.json"] }, notes: ["owner names and other personal fields are never read or written", "no ranking or forecast data is read: draft slots come only from MFL draft results, MFL slot tokens and MFL slot lists (docs/league_record/S1_METHODOLOGY.md)"] },
    roots, coverage, trades, nodes: nodeList, frontier, views, reconciliation,
    gaps: dedupeGaps(gapsFound, coverage),
  };
  return bundle;
}

// Does any possession period of the chain overlap the named unobserved trade period? An open period runs to the pinned snapshot day. Dates are Eastern, compared as text.
function namedGapExposure(ledger, holders) {
  const g = ledger.named_gap;
  const spans = holders.filter((h) => (h.from.date == null || h.from.date <= g.to) && (h.to == null ? SNAPSHOT_DAY : h.to.date) >= g.from).map((h) => ({ franchise: h.franchise, from: h.from.date || null, to: h.to ? h.to.date : null }));
  return { crosses: spans.length > 0, gap: { from: g.from, to: g.to }, possession_periods_spanning: spans,
    note: spans.length ? "a possession period of this chain spans the unobserved trade period: a transfer inside it would not be in any source, so the chain's holders there are as recorded before and after, not proven in between" : "no possession period of this chain overlaps the unobserved trade period" };
}

function packResolution(res) {
  return { class: res.class, rule: res.rule || null, reason: res.reason || null, conflict: res.conflict || false, selection: res.selection ? selectionRef(res.selection) : null, holder_at_selection: res.holder_at_selection || null, coverage_gaps: (res.coverage_gaps || []).map((g) => ({ from: g.from, to: g.to, kind: g.kind })) };
}
const selectionRef = (s) => ({ year: s.year, round: s.round, slot: s.slot, overall: s.overall, franchise: s.franchise, player_id: s.player_id, date: s.date, time: etParts(s.ts).time, source: s.source, note: String(s.note || "").replace(/\s+/g, " ").trim() || null });

function packFuture(res, { firstList, lastPre, ledger, years, round, labelOf }) {
  const slotOn = (list, slot) => { if (!list) return null; const s = list.slots.find((x) => x.round === round && x.slot === slot); return s ? { day: list.day, holder: s.holder, notes: s.note_lines, traded_from_ids: s.traded_from_ids } : null; };
  const cands = res.candidates.map((c) => {
    const sel = ledger.selBySlot.get(`${years}:${round}:${c.slot}`) || null;
    const last = slotOn(lastPre, c.slot);
    return { slot: c.slot, on_first_list: slotOn(firstList, c.slot), on_last_pre_draft_list: last, draft_result: sel ? { franchise: sel.franchise, player_id: sel.player_id, player_name: labelOf(sel.player_id), date: sel.date, source: sel.source } : null,
      moved_after_last_list: !!(sel && last && sel.franchise !== last.holder) };
  });
  return { class: res.class, rule: res.rule || null, rule_considered: res.rule_considered || null, reason: res.reason || null, holder_at_evidence: res.holder, original_franchise: res.original, evidence_kind: res.evidence_kind, evidence_day: res.evidence_day, last_recorded_transfer_ts: res.last_transfer_ts ? etParts(res.last_transfer_ts).date : null,
    coverage_gaps: (res.coverage_gaps || []).map((g) => ({ from: g.from, to: g.to, kind: g.kind })), candidate_slots: cands, inventory: res.inventory ? { complete: res.inventory.complete, reasons: res.inventory.reasons, teams: res.inventory.checked.teams, slots_listed: res.inventory.checked.slots_listed } : null, slot: res.slot || null, disclosure: res.disclosure || null,
    status_for_totals: res.class === CLASS.INFERRED ? "excluded_from_confirmed_totals" : "no_link_no_totals" };
}

function collectWindows(ledger, nodes) {
  const seen = new Map();
  for (const n of nodes.values()) {
    const ch = n._chain; if (!ch || !ch.events.length) continue;
    const from = ch.events[0].ts, to = ch.events.at(-1).ts;
    for (const w of gapsBetween(ledger, from, Math.max(to, from + 1))) seen.set(`${w.from}..${w.to}`, { from: w.from, to: w.to, kind: w.kind, basis: w.basis });
  }
  return [...seen.values()].sort((a, b) => a.from.localeCompare(b.from));
}
// Supporting indication only (never proof): in which months the archive has ever recorded a trade.
function tradeSeasonPattern(ledger) {
  const byMonth = {};
  for (const t of ledger.archiveTrades) { const m = t.date.slice(5, 7); byMonth[m] = (byMonth[m] || 0) + 1; }
  const years = {};
  for (const t of ledger.archiveTrades) { const y = t.date.slice(0, 4); if (!years[y]) years[y] = { first: t.date, last: t.date }; years[y].first = t.date < years[y].first ? t.date : years[y].first; years[y].last = t.date > years[y].last ? t.date : years[y].last; }
  const december = ledger.archiveTrades.filter((t) => t.date.slice(5, 7) === "12").map((t) => t.date);
  return { trades_by_calendar_month: Object.fromEntries(Object.keys(byMonth).sort().map((k) => [k, byMonth[k]])), first_and_last_trade_by_year: Object.fromEntries(Object.entries(years).filter(([y]) => Number(y) >= 2018)), months_with_no_recorded_trade: ["01"].filter((m) => !byMonth[m]), december_trades: december, note: `indication only: across ${Object.keys(years).length} seasons the archive records no trade in January and ${december.length} in December (${december.join(", ")}), which fits a closed window after the deadline, but the records cannot prove an empty window` };
}

function dedupeGaps(found, coverage) {
  const out = [{ kind: "incomplete_trade_coverage", from: coverage.named_gap.from, to: coverage.named_gap.to, basis: coverage.named_gap.basis, last_archive_trade: coverage.named_gap.last_archive_trade, last_archive_transaction: coverage.named_gap.last_archive_transaction, first_snapshot_transaction_et: coverage.named_gap.first_snapshot_transaction_et }];
  const seen = new Set();
  for (const g of found) { const k = JSON.stringify(g); if (!seen.has(k)) { seen.add(k); out.push(g); } }
  out.push({ kind: "points_horizon", note: "the archive's weekly scoring record ends with the 2025 season; no 2026 weekly scores exist in any committed source, so no 2026 points are shown for any asset" });
  out.push({ kind: "salary_horizon", note: "weekly roster contracts end with the 2025 season; 2026 contracts are shown only from the latest daily roster snapshot, as recorded on that day" });
  out.push({ kind: "team_cap_totals_not_computed", note: "per-player salary and the recorded cap transfers are shown; a franchise's total cap position on a date needs the full roster and adjustment record (League Record slice S2)" });
  out.push({ kind: "owner_identity_not_asserted", note: "every statement is about a franchise id; franchise continuity is not owner continuity (League Record slice S3)" });
  return out;
}

// The confirmed view and the inferred view are built from the same nodes: a node is in the confirmed view only when its entire path of links is CONFIRMED.
function buildViews(nodeList) {
  const confirmed = [], inferred = [], unresolved = [];
  for (const n of nodeList) {
    if (n.link_class === CLASS.CONFIRMED) confirmed.push(n.id);
    else if (n.link_class === CLASS.INFERRED) inferred.push(n.id);
    else unresolved.push(n.id);
    if ((n.kind === "future_pick") && n.resolution && n.resolution.class === CLASS.UNRESOLVED) unresolved.push(`${n.id}#slot`);
  }
  return { confirmed_assets: confirmed, inferred_assets: inferred, unresolved_links: unresolved, rule: "confirmed totals use only assets in confirmed_assets; an inferred or unresolved link never contributes to a confirmed total" };
}

function reconcile({ ledger, nodes, nodeList, archive, rosterNow, firstList, lastPre }) {
  const out = { trade_legs: {}, players: [], picks: [], points: { weekly_record_vs_plain_table_mismatches: 0, excluded_copy_weeks: [], disputed_weeks: [] }, salary: [], slot_lists: [] };
  const used = new Set();
  for (const n of nodeList) for (const e of n.chain.events) if (e.trade) used.add(e.trade);
  const legs = ledger.trades.filter((t) => used.has(t.id)).flatMap((t) => t.legs);
  out.trade_legs = { trades_used: used.size, legs: legs.length, unpaired_legs: legs.filter((l) => l.unpaired).length, note: "every leg pairs the sender's row with the receiver's row" };
  for (const n of nodeList) {
    if (n.kind === "player") {
      const econ = n.economics;
      const disagreements = [];
      for (const s of econ.seasons) for (const fr of s.by_franchise) for (const w of fr.disputed_weeks) disagreements.push({ season: s.season, ...w });
      const copy = econ.seasons.filter((s) => s.excluded_copy_weeks.length).map((s) => ({ season: s.season, weeks: s.excluded_copy_weeks }));
      const mism = econ.seasons.flatMap((s) => s.by_franchise.flatMap((f) => f.plain_score_mismatches.map((m) => ({ season: s.season, ...m }))));
      out.players.push({ asset: n.id, chain_breaks: n.chain.breaks.length, disputed_weeks: disagreements, copy_weeks_excluded: copy, score_table_mismatches: mism, final_position_consistent: n.final_position ? n.final_position.consistent : null });
      out.points.weekly_record_vs_plain_table_mismatches += mism.length;
      for (const c of copy) out.points.excluded_copy_weeks.push({ asset: n.id, ...c });
      for (const d of disagreements) out.points.disputed_weeks.push({ asset: n.id, ...d });
      for (const s of econ.seasons) for (const c of s.contract_by_roster_weeks) {
        const y1 = c.year_values_k.find((v) => v.year_index === 1);
        out.salary.push({ asset: n.id, season: s.season, franchise: c.franchise, weeks: `${c.from_week}-${c.to_week}`, salary: c.salary, years_remaining: c.years_remaining, contract_text_year1_k: y1 ? y1.value : null, salary_matches_text: y1 ? (y1.value * 1000 === c.salary || c.years_remaining === 1) : null });
      }
    } else if (n.resolution) {
      out.picks.push({ asset: n.id, class: n.resolution.class, holder_check: n.kind === "slot_pick" ? { chain_holder_at_selection: n.resolution.holder_at_selection, draft_result_franchise: n.resolution.selection ? n.resolution.selection.franchise : null, agree: n.resolution.selection ? n.resolution.holder_at_selection === n.resolution.selection.franchise : null } : { chain_holder_at_evidence: n.resolution.holder_at_evidence, candidates: n.resolution.candidate_slots.length } });
    }
  }
  for (const l of [firstList, lastPre].filter(Boolean)) out.slot_lists.push({ day: l.day, round1_order_recorded: l.round1_order });
  return out;
}

export function stableStringify(v) { return JSON.stringify(sortDeep(v), null, 2); }
function sortDeep(v) {
  if (Array.isArray(v)) return v.map(sortDeep);
  if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortDeep(v[k])]));
  return v;
}
export { CLASS, RULES, lastLeagueWeek, kickoffDates, holderAt, path, fs };
