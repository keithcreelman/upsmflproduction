#!/usr/bin/env node
// FCFS contract inventory + idempotent backfill.
//
// Canon §A5 / §T1.6: an FCFS acquisition is a $1K, 1-year WW contract; Keith's 2026 ruling fixes its exact form: $1,000 · one year · Vet-WW (Rookie-WW for
// an NFL rookie) · CL 1 · TCV 1K · AAV 1K (worker/src/fcfs_contract.js).
// This tool rebuilds ONE ROW PER FCFS ACQUISITION PERIOD across every season D1 has, classifies each against the canon, and (only when told to,
// only for the current season) corrects what a rule can correct. It never does a blanket update.
//
//   node scripts/fcfs_contract_backfill.mjs                        # DRY RUN (default): inventory + plan + before-state, writes nothing anywhere
//   node scripts/fcfs_contract_backfill.mjs --season 2026 --player 16619 --franchise 0004 --txn <substring>   # filters
//   node scripts/fcfs_contract_backfill.mjs --verify               # read-only: exit 0 only when NOTHING is left to correct (the second-run no-op proof)
//   node scripts/fcfs_contract_backfill.mjs --crosscheck           # compare D1's per-season FCFS-add counts with MFL's own transactions export
//   node scripts/fcfs_contract_backfill.mjs --apply --yes --season 2026 --plan <reviewed dry run>/plan_proposed_after_state.json
//                                                                      # EXPLICIT write mode (needs UPS_COMMISH_API_KEY in the environment); refuses when the fresh plan differs from the reviewed one
//   options: --out DIR (default ./fcfs_backfill_out/<utc stamp>)  --cache DIR (dump raw datasets = the before-state)  --base URL
//   every run writes rollback.sql: the exact reverse of the planned D1 reprice(s) — reviewed and run by Keith, never by this tool
//
// Every action is one of (never anything else):
//   mfl_correction        stamp the canonical contract onto an ACTIVE, still-blank 2026 FCFS contract — through the EXISTING commissioner path
//                         (POST /admin/import-salaries: APPEND=1, audited in salary_change_log, verified by re-read). Preconditioned: the row is
//                         re-read immediately before the write and must still be blank and still held by the acquiring franchise.
//   d1_correction         POST /admin/drops/full-year-repair (kind reprice_unstamped_fcfs_drop) — the drop of an FCFS acquisition that was priced before its
//                         contract was ever written. Expected-before-state guarded, idempotent, audited, and REFUSED if it would change the stored penalty.
//                         (The weekly-earned clean-up of the "$1K Per Yr" drop rows is scripts/full_year_earned_repair.mjs — same route, its own dry run.)
//   derived_regen         none today (src_contracts / roster-workbench regenerate from MFL); the category exists so the report says so.
//   historical_unchanged  a closed-season record that is correct, unexplained by any defect, or replaced by a later valid event — left alone.
//   manual_review         anything a rule cannot decide (never auto-written).
// The report ALSO answers (read-only, nothing is written for any of it):
//   * the union of the two ledgers — src_adddrop AND mfl_historical_transactions (an FCFS add only the second one proves is its own period);
//   * every zero-contract period, classified (transaction-proven / superseded by a later valid contract / conflicting evidence / insufficient source evidence);
//   * the closed-season anomalies, EXPLAINED individually from the ledger (same-franchise re-add; stale prior-holder contract row);
//   * the 189 unverifiable closed-season gaps — counted and left unchanged;
//   * the closure method for every open 2026 FCFS add event (cron reconcile from a verified canonical MFL contract, or — for a DROPPED player a roster re-read can
//     never verify — the audited `close_fcfs_add_event` step that runs only AFTER that drop's own repair).
// Acquisition-period protection: a period is judged only against the events INSIDE it. A later auction / waiver / MYM / extension /
// restructure / tag contract REPLACES it (bucket replaced_by_later_event) and is never overwritten; a re-acquisition is its own period.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  canonicalFcfsContract, classifyFcfsContract, buildFcfsPeriods, decidePeriod, planUnstampedFcfsDropRepair, FCFS_SALARY,
  classifyZeroPeriod, explainClosedSeasonAnomaly, planFcfsAddEventClosure, ADD_EVENT_CLOSE_NOTE, ZERO_CLASS,
} from "../worker/src/fcfs_contract.js";

export const CURRENT_SEASON = 2026;
export const LEAGUE_ID = "74598";
export const DEFAULT_BASE = "https://upsmflproduction.keith-creelman.workers.dev";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const s = (v) => String(v == null ? "" : v).trim();
const digits = (v) => s(v).replace(/\D/g, "");
const pad4 = (v) => digits(v).padStart(4, "0").slice(-4);

// ───────────────────────────── the SELECTs (read-only; the tool refuses anything else) ─────────────────────────────
// an FCFS acquisition is proven by EITHER ledger: src_adddrop (the ETL's event log) or mfl_historical_transactions (MFL's own transaction export)
const FCFS_KEYSET = `(SELECT season, player_id FROM src_adddrop WHERE method='FREE_AGENT' AND move_type='ADD' AND season < ${CURRENT_SEASON}
    UNION SELECT season, player_in_id FROM mfl_historical_transactions WHERE type='FREE_AGENT' AND player_in_id IS NOT NULL AND player_in_id <> '' AND season < ${CURRENT_SEASON})`;
const FCFS_KEYS_OF = (seasonExpr) => `(${seasonExpr}, player_id) IN ${FCFS_KEYSET}`;
/** The stamper cron's look-back (worker/src/index.js: `days: 7`). An add event older than this can never be closed by the cron — only by the manual route (days ≤ 90). */
export const CRON_LOOKBACK_DAYS = 7;
const FCFS_KEYS = FCFS_KEYS_OF("season");
export const QUERIES = Object.freeze({
  histAdds: `SELECT season, txn_index, player_id, franchise_id, franchise_name, unix_timestamp, datetime_et FROM src_adddrop WHERE method='FREE_AGENT' AND move_type='ADD' AND season < ${CURRENT_SEASON}`,
  // the second ledger's ADDs (an FCFS acquisition) AND its DROPs of an FCFS player (`player_out_id`) — a drop only this ledger records still ends a period
  histTx: `SELECT season, txn_uid, ts_unix, franchise_id, player_in_id, player_out_id, salary FROM mfl_historical_transactions WHERE type='FREE_AGENT' AND season < ${CURRENT_SEASON}
           AND ((player_in_id IS NOT NULL AND player_in_id <> '') OR (player_out_id IS NOT NULL AND player_out_id <> '' AND (season, player_out_id) IN ${FCFS_KEYSET}))`,
  histEvents: `SELECT season, player_id, franchise_id, move_type, method, unix_timestamp, txn_index FROM src_adddrop WHERE season < ${CURRENT_SEASON} AND ${FCFS_KEYS}`,
  histTrades: `SELECT season, player_id, franchise_id, asset_role, unix_timestamp, transactionid FROM src_trades WHERE asset_type='PLAYER' AND season < ${CURRENT_SEASON} AND ${FCFS_KEYS}`,
  histContracts: `SELECT season, player_id, franchise_id, salary, contract_year, contract_status, contract_info FROM src_contracts WHERE season < ${CURRENT_SEASON} AND ${FCFS_KEYS}`,
  histContractsNext: `SELECT season, player_id, franchise_id, salary, contract_year, contract_status, contract_info FROM src_contracts WHERE season <= ${CURRENT_SEASON} AND ${FCFS_KEYS_OF("season - 1")}`,
  histNames: `SELECT season, player_id, name FROM src_players WHERE season < ${CURRENT_SEASON} AND ${FCFS_KEYS}`,
  franchises: `SELECT season, franchise_id, owner_name, team_name FROM src_franchises`,
  tx2026: `SELECT mfl_txn_id, type, unix_timestamp, franchise_id, franchise_id2, added_players, dropped_players, raw_json FROM ups_transactions WHERE season='${CURRENT_SEASON}' AND type IN ('FREE_AGENT','BBID_WAIVER','AUCTION_WON','TRADE') ORDER BY unix_timestamp`,
  addEvents2026: `SELECT id, player_id, player_name, franchise_id, acquired_at_unix, source, contract_annotated, annotated_at_utc, notes FROM ups_add_events WHERE season='${CURRENT_SEASON}' AND source='fcfs'`,
  drops2026: `SELECT id, season, league_id, player_id, player_name, franchise_id, franchise_name, dropped_at_unix, dropped_at_iso, pre_drop_contract_status, pre_drop_salary, pre_drop_contract_year, pre_drop_contract_length, pre_drop_contract_info, pre_drop_tcv, pre_drop_aav, pre_drop_years_remaining, pre_drop_taxi, earned_to_date, guaranteed_amount, penalty_amount, penalty_basis, penalty_exempt, penalty_exempt_reason, posted_to_mfl, posted_amount, applies_to_season, discord_posted, notes FROM ups_drop_events WHERE season='${CURRENT_SEASON}'`,
  stampLog2026: `SELECT id, created_ts, player_id, after_salary, after_contract_status, after_contract_year, after_contract_info, landed, endpoint FROM salary_change_log WHERE season='${CURRENT_SEASON}' AND dry_run=0 AND landed=1 AND endpoint='/admin/import-salaries'`,
  cycles: `SELECT season, player_id, franchise_id, acquisition_date, salary_at_acquisition_usd, contract_years_at_acquisition, contract_type_at_acquisition FROM player_acquisition_cycles WHERE acquisition_path='fcfs'`,
  repairAudit2026: `SELECT id, note FROM ups_contract_gate_audit WHERE field = 'fcfs_reprice_unstamped_drop' AND season = '${CURRENT_SEASON}'`,
  changeLog2026: `SELECT id, created_ts, player_id, endpoint, dry_run, landed, before_salary, before_contract_status, before_contract_year, before_contract_info, after_salary, after_contract_status, after_contract_year, after_contract_info FROM salary_change_log
                  WHERE season='${CURRENT_SEASON}' AND dry_run=0 AND landed=1 AND player_id IN (SELECT player_id FROM ups_add_events WHERE season='${CURRENT_SEASON}' AND source='fcfs' AND contract_annotated IN (0,3)) ORDER BY id`,
  ledger2026: `SELECT player_id, winner_fid, source, salary, contract_status, contract_info, finalized_at_unix FROM ups_auction_contract_finalizations WHERE season='${CURRENT_SEASON}'`,
});
const assertReadOnly = (sql) => { if (!/^\s*SELECT\b/i.test(sql) || /;\s*\S/.test(sql)) throw new Error("fcfs backfill: read-only helper refuses a non-SELECT statement"); };

// ───────────────────────────── production IO (D1 via wrangler --remote, MFL via the public proxy) ─────────────────────────────
export function productionIo({ base = DEFAULT_BASE } = {}) {
  return {
    base,
    async d1(sql) {
      assertReadOnly(sql);
      const out = execFileSync("npx", ["--yes", "wrangler", "d1", "execute", "ups-mfl-db", "--remote", "--json", "--command", sql], { cwd: path.join(ROOT, "worker"), encoding: "utf8", maxBuffer: 1 << 28, stdio: ["ignore", "pipe", "ignore"] });
      const j = JSON.parse(out);
      return (j[0] && j[0].results) || [];
    },
    async mfl(year, type, extra = "") {
      const r = await fetch(`${base}/api/mfl-export?L=${LEAGUE_ID}&YEAR=${year}&TYPE=${type}${extra}`, { headers: { "User-Agent": "curl/8.4" } });
      return r.json();
    },
    async post(pathAndQuery, body, key) {
      const sep = pathAndQuery.includes("?") ? "&" : "?";
      const r = await fetch(`${base}${pathAndQuery}${sep}APIKEY=${encodeURIComponent(key)}`, { method: "POST", headers: { "Content-Type": "application/json", "User-Agent": "curl/8.4" }, body: JSON.stringify(body) });
      let j = null; try { j = await r.json(); } catch (_) { /* non-JSON */ }
      return { status: r.status, body: j };
    },
  };
}

const asArr = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]);
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const isoOf = (unix) => (unix ? new Date(Number(unix) * 1000).toISOString() : "");

// ───────────────────────────── dataset ─────────────────────────────
export async function loadDataset(io, { cacheDir = "", offline = false } = {}) {
  const cachePath = (name) => (cacheDir ? path.join(cacheDir, `${name}.json`) : "");
  const cached = (name) => { const p = cachePath(name); return p && fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : undefined; };
  const store = (name, v) => { const p = cachePath(name); if (p) { fs.mkdirSync(cacheDir, { recursive: true }); fs.writeFileSync(p, JSON.stringify(v)); } return v; };
  const q = async (name) => {
    const hit = cached(name); if (hit !== undefined) return hit;
    if (offline) throw new Error(`--offline: no cached dataset "${name}"`);
    return store(name, await io.d1(QUERIES[name]));
  };
  const ds = {};
  for (const k of Object.keys(QUERIES)) ds[k] = await q(k);
  const mflOf = async (name, type) => { const hit = cached(name); if (hit !== undefined) return hit; if (offline) throw new Error(`--offline: no cached dataset "${name}"`); return store(name, await io.mfl(CURRENT_SEASON, type)); };
  const sal = await mflOf("mflSalaries2026", "salaries");
  const ros = await mflOf("mflRosters2026", "rosters");
  ds.mflSalaries = Object.fromEntries(asArr(sal && sal.salaries && sal.salaries.leagueUnit && sal.salaries.leagueUnit.player).map((p) => [digits(p.id), p]));
  ds.mflRoster = {};
  for (const f of asArr(ros && ros.rosters && ros.rosters.franchise)) for (const p of asArr(f.player)) ds.mflRoster[digits(p.id)] = { fid: pad4(f.id), status: s(p.status) };
  ds.mflReadable = !!(sal && sal.salaries) && !!(ros && ros.rosters);
  return ds;
}

// ───────────────────────────── events / periods ─────────────────────────────
function tradeSides(raw) {
  let r = null; try { r = typeof raw === "string" ? JSON.parse(raw) : raw; } catch (_) { return []; }
  if (!r) return [];
  const pl = (str) => (s(str).match(/\b\d{3,6}\b(?!_)/g) || []).filter((x) => !/^FP_|^DP_/.test(x));
  const out = [];
  for (const pid of pl((s(r.franchise1_gave_up).split(",").filter((t) => /^\d+$/.test(t.trim())).join(",")))) out.push({ pid, from: pad4(r.franchise), to: pad4(r.franchise2) });
  for (const pid of pl((s(r.franchise2_gave_up).split(",").filter((t) => /^\d+$/.test(t.trim())).join(",")))) out.push({ pid, from: pad4(r.franchise2), to: pad4(r.franchise) });
  return out;
}

export function buildAddsAndEvents(ds) {
  const adds = [], events = [];
  for (const r of ds.histAdds) adds.push({ season: num(r.season), txn: `${r.season}:src_adddrop:${r.txn_index}`, ts: num(r.unix_timestamp), pid: digits(r.player_id), fid: pad4(r.franchise_id), sources: ["src_adddrop"] });
  // the second ledger: an mfl_historical_transactions FREE_AGENT add that src_adddrop also holds (same season / player / franchise, stamps within the 2-day matching window) is
  // the SAME acquisition — it only adds a corroborating source; one that src_adddrop lacks is its own period, proven by this ledger alone.
  const WINDOW = 2 * 86400;
  const usedSrc = new Set(), histOnly = new Set(), histUnusable = [], histDrops = [];
  for (const r of ds.histTx || []) {
    const season = num(r.season), pid = digits(r.player_in_id), fid = pad4(r.franchise_id), ts = num(r.ts_unix);
    if (pid) {
      // a hist add without a usable stamp or franchise proves NO period (never coerced to the epoch / franchise 0000) — it is REPORTED
      if (!ts || !digits(r.franchise_id)) { histUnusable.push({ season, txn_uid: s(r.txn_uid), player_id: pid, reason: !ts ? "no_timestamp" : "no_franchise" }); }
      else {
        // an IDENTICAL hist row (same season / player / franchise / stamp) is the same row — deduped first; then ONE-TO-ONE: a src_adddrop add is corroborated by at most ONE hist row
        // (the nearest within the window) and a further, different hist row near it is its own acquisition
        const key = `${season}|${pid}|${fid}|${ts}`;
        if (!histOnly.has(key)) {
          histOnly.add(key);
          const near = adds.filter((a) => a.season === season && a.pid === pid && a.fid === fid && a.sources.includes("src_adddrop") && !usedSrc.has(a) && Math.abs(a.ts - ts) <= WINDOW).sort((x, y) => Math.abs(x.ts - ts) - Math.abs(y.ts - ts))[0];
          if (near) { usedSrc.add(near); if (!near.sources.includes("mfl_historical_transactions")) near.sources.push("mfl_historical_transactions"); }
          else adds.push({ season, txn: `${season}:mfl_historical_transactions:${s(r.txn_uid)}`, ts, pid, fid, sources: ["mfl_historical_transactions"] });
        }
      }
    }
    // the drop half of the same transaction: it ends the DROPPED player's period, unless src_adddrop already recorded that drop
    const out = digits(r.player_out_id);
    if (out && ts && digits(r.franchise_id)) histDrops.push({ season, ts, pid: out, fid });
  }
  for (const r of ds.histEvents) {
    const kind = r.move_type === "DROP" ? "drop" : r.method === "FREE_AGENT" ? "add_fcfs" : "add_bbid";
    events.push({ season: num(r.season), ts: num(r.unix_timestamp), pid: digits(r.player_id), fid: pad4(r.franchise_id), kind });
  }
  for (const r of ds.histTrades) events.push({ season: num(r.season), ts: num(r.unix_timestamp), pid: digits(r.player_id), fid: pad4(r.franchise_id), kind: r.asset_role === "RELINQUISH" ? "trade_out" : "trade_in" });
  // the second ledger's DROP half of a transaction ends the dropped player's period — unless src_adddrop already recorded that same drop
  for (const d of histDrops) if (!events.some((e) => e.kind === "drop" && e.season === d.season && e.pid === d.pid && e.fid === d.fid && Math.abs(e.ts - d.ts) <= 60)) events.push({ ...d, kind: "drop", src: "mfl_historical_transactions" });
  for (const r of ds.tx2026) {
    const ts = num(r.unix_timestamp), fid = pad4(r.franchise_id);
    const addedRaw = s(r.added_players), droppedRaw = s(r.dropped_players);
    const list = (v) => v.split(",").map(digits).filter(Boolean);
    if (r.type === "FREE_AGENT" || r.type === "BBID_WAIVER") {
      for (const pid of list(addedRaw)) {
        events.push({ season: CURRENT_SEASON, ts, pid, fid, kind: r.type === "FREE_AGENT" ? "add_fcfs" : "add_bbid", txn: s(r.mfl_txn_id) });
        if (r.type === "FREE_AGENT") adds.push({ season: CURRENT_SEASON, txn: s(r.mfl_txn_id), ts, pid, fid, sources: ["ups_transactions"] });
      }
      for (const pid of list(droppedRaw)) events.push({ season: CURRENT_SEASON, ts, pid, fid, kind: "drop", txn: s(r.mfl_txn_id) });
    } else if (r.type === "AUCTION_WON") {
      for (const pid of list(addedRaw.split("|")[0] || addedRaw)) events.push({ season: CURRENT_SEASON, ts, pid, fid, kind: "add_auction", txn: s(r.mfl_txn_id) });
    } else if (r.type === "TRADE") {
      for (const t of tradeSides(r.raw_json)) { events.push({ season: CURRENT_SEASON, ts, pid: t.pid, fid: t.from, kind: "trade_out" }); events.push({ season: CURRENT_SEASON, ts, pid: t.pid, fid: t.to, kind: "trade_in" }); }
    }
  }
  return { adds, events, histUnusable };
}

const rowOf = (p) => (p ? { salary: s(p.salary), contractStatus: s(p.contractStatus), contractYear: s(p.contractYear), contractInfo: s(p.contractInfo) } : null);

export function buildInventory(ds, filters = {}, opts = {}) {
  const now = Number.isFinite(Number(opts.now)) ? Number(opts.now) : Math.floor(Date.now() / 1000);
  const { adds, events } = buildAddsAndEvents(ds);
  const periods = buildFcfsPeriods(adds, events);
  const owner = new Map(ds.franchises.map((f) => [`${f.season}|${pad4(f.franchise_id)}`, f]));
  const names = new Map(ds.histNames.map((r) => [`${r.season}|${digits(r.player_id)}`, s(r.name)]));
  for (const r of ds.addEvents2026) names.set(`${CURRENT_SEASON}|${digits(r.player_id)}`, s(r.player_name));
  const contractHist = new Map(ds.histContracts.map((r) => [`${r.season}|${digits(r.player_id)}`, r]));
  const contractNext = new Map((ds.histContractsNext || []).map((r) => [`${r.season}|${digits(r.player_id)}`, r]));
  const eventsOf = (season, pid) => events.filter((e) => e.season === season && e.pid === pid);
  const repairAudit = ds.repairAudit2026 || [];
  const drops26 = ds.drops2026;
  const stamp26 = ds.stampLog2026;
  const ledger26 = ds.ledger2026;
  const cycles = new Map();
  for (const c of ds.cycles || []) { const k = `${c.season}|${digits(c.player_id)}|${pad4(c.franchise_id)}`; if (!cycles.has(k)) cycles.set(k, []); cycles.get(k).push(c); }
  const rows = [];
  for (const p of periods) {
    if (filters.season && num(filters.season) !== p.season) continue;
    if (filters.player && digits(filters.player) !== p.pid) continue;
    if (filters.franchise && pad4(filters.franchise) !== p.fid) continue;
    if (filters.txn && !s(p.txn).includes(s(filters.txn))) continue;
    const cur = p.season === CURRENT_SEASON;
    const name = names.get(`${p.season}|${p.pid}`) || "";
    const fr = owner.get(`${p.season}|${p.fid}`) || {};
    let contract = null, contractSource = "", firstRecorded = null, mflNow = null, rostered = null, stampedBy = null, ledgerRow = null, dropEvent = null, contractRowRaw = null;
    if (cur) {
      const live = ds.mflSalaries[p.pid];
      mflNow = rowOf(live) || null;
      contract = mflNow;
      contractSource = ds.mflReadable ? "mfl_salaries_live" : "unavailable";
      const rs = ds.mflRoster[p.pid];
      rostered = !!rs;
      // a still-held player's contract is what MFL serves NOW; a released player's is unrecoverable from MFL
      const heldByAcquirer = rs && rs.fid === p.fid;
      if (!heldByAcquirer && p.endKind === "held_to_season_end") p.endKind = rs ? "traded" : "dropped";
      const stamps = stamp26.filter((x) => digits(x.player_id) === p.pid && num(Date.parse(s(x.created_ts).replace(" ", "T") + (s(x.created_ts).endsWith("Z") ? "" : "Z"))) / 1000 >= p.ts - 1);
      if (stamps.length) { const st = stamps[0]; stampedBy = { salary_change_log_id: st.id, at: st.created_ts }; firstRecorded = { salary: s(st.after_salary), contractStatus: s(st.after_contract_status), contractYear: s(st.after_contract_year), contractInfo: s(st.after_contract_info) }; }
      ledgerRow = ledger26.find((x) => digits(x.player_id) === p.pid && (s(x.source) === "fcfs" || s(x.source) === "ww") && num(x.finalized_at_unix) >= p.ts - 1) || null;
      // this period's OWN drop: at/after the add, before the next period of the same key, and (when the ledger knows the drop's time) within a day of it — a missing drop row never binds to a LATER period's drop
      const nextSame = periods.filter((q) => q.season === p.season && q.pid === p.pid && q.fid === p.fid && q.ts > p.ts).map((q) => q.ts).sort((a, b) => a - b)[0];
      dropEvent = drops26.filter((d) => digits(d.player_id) === p.pid && pad4(d.franchise_id) === p.fid && num(d.dropped_at_unix) >= p.ts && (nextSame == null || num(d.dropped_at_unix) < nextSame) && (!p.dropTs || Math.abs(num(d.dropped_at_unix) - p.dropTs) <= 86400))
        .sort((a, b) => num(a.dropped_at_unix) - num(b.dropped_at_unix))[0] || null;
      // the contract judged for a DROPPED period is the one the drop was priced on
      if (p.endKind === "dropped" && dropEvent) contract = { salary: s(dropEvent.pre_drop_salary), contractStatus: s(dropEvent.pre_drop_contract_status), contractYear: s(dropEvent.pre_drop_contract_year), contractInfo: s(dropEvent.pre_drop_contract_info) };
      if (p.endKind === "dropped" && dropEvent && dropEvent.penalty_basis === "contract_unstamped_needs_review") contract = { salary: "", contractStatus: "", contractYear: "", contractInfo: "" };
    } else {
      const c = contractHist.get(`${p.season}|${p.pid}`);
      contractRowRaw = c || null;
      contract = c ? { salary: s(c.salary), contractStatus: s(c.contract_status), contractYear: s(c.contract_year), contractInfo: s(c.contract_info) } : null;
      contractSource = c ? "src_contracts_season_end" : "no_row";
    }
    let d = decidePeriod(p, { season: p.season, currentSeason: CURRENT_SEASON, contract, dropEvent, contractSource });
    // a closed-season anomaly is EXPLAINED from the ledger when the ledger can explain it (same-franchise re-add; a stale prior-holder contract row); an explained anomaly is not a
    // defect and needs no review — one the ledger cannot explain stays in manual review. Nothing is written either way.
    let anomaly = null;
    if (d.review_class === "closed_season_anomaly") {
      anomaly = explainClosedSeasonAnomaly(p, { contractRow: contractRowRaw, nextSeasonRow: contractNext.get(`${p.season + 1}|${p.pid}`) || null, events: eventsOf(p.season, p.pid) });
      if (anomaly.explained) d = { ...d, category: "historical_unchanged", action: "none", correctionRequired: false, autoCorrectable: false, review_class: "closed_season_anomaly_explained", reason: anomaly.conclusion };
    }
    // every ZERO-contract closed-season period ends in exactly one of four classes
    const zero = d.classification === "zero" && p.season < CURRENT_SEASON ? classifyZeroPeriod(p, { sources: p.sources || [] }) : null;
    // the 2026 add event of this acquisition (if any) and how it will be closed
    const addEv = cur ? (ds.addEvents2026 || []).find((e) => digits(e.player_id) === p.pid && pad4(e.franchise_id) === p.fid && Math.abs(num(e.acquired_at_unix) - p.ts) <= 60) || null : null;
    const closure = addEv ? planAddEventClosure(p, addEv, { dropEvent, repairAudit, changeLog: (ds.changeLog2026 || []).filter((x) => digits(x.player_id) === p.pid), mflNow, mflRoster: ds.mflRoster[p.pid], mflReadable: ds.mflReadable, now }) : null;
    const alreadyCorrected = cur && d.classification === "correct" && (stampedBy || ledgerRow) ? true : false;
    // derived artifact: the acquisition-cycle ledger (player_acquisition_cycles) should carry $1,000 / 1 year for an FCFS cycle
    const cyc = (cycles.get(`${p.season}|${p.pid}|${p.fid}`) || []).find((c) => Math.abs(Date.parse(s(c.acquisition_date)) / 1000 - p.ts) < 2 * 86400) || null;
    const derivedGap = !!cyc && (cyc.salary_at_acquisition_usd == null || cyc.contract_years_at_acquisition == null);
    const expected = canonicalFcfsContract({});
    const row = {
      season: p.season, transaction_id: p.txn, acquired_at: isoOf(p.ts), acquired_ts: p.ts, player_id: p.pid, player_name: name,
      franchise_id: p.fid, team: s(fr.team_name), owner: s(fr.owner_name),
      contract_after_acquisition: firstRecorded || null, contract_evidence: contractSource, contract_evidence_row: contract, contract_now_mfl: mflNow,
      expected_canonical: p.season >= 2026 ? expected : { salary: expected.salary, contractStatus: "WW (era: Vet-WW/WW)", contractYear: expected.contractYear, contractInfo: "(blank before the 2026 token era)" },
      active_at_evidence: cur ? !!(rostered && ds.mflRoster[p.pid] && ds.mflRoster[p.pid].fid === p.fid) : p.endKind === "held_to_season_end",
      drop_date: p.dropTs ? isoOf(p.dropTs) : "", trade_date: p.tradeTs ? isoOf(p.tradeTs) : "", reacquired_date: p.reacquiredTs ? isoOf(p.reacquiredTs) : "",
      later_replacement: p.replacementKind ? { kind: p.replacementKind, at: isoOf(p.replacementTs) } : null,
      multi_period: !!p.multiPeriod, evidence_sources: p.sources || [],
      zero_classification: zero, anomaly_explanation: anomaly && anomaly.explained ? anomaly : null, add_event_closure: closure,
      bucket: d.bucket, classification: d.classification, classification_reasons: d.classification_reasons,
      current_status: cur ? (rostered ? (ds.mflRoster[p.pid].fid === p.fid ? "rostered_by_acquirer" : `rostered_by_${ds.mflRoster[p.pid].fid}`) : "not_rostered") : (p.endKind),
      derived_regen_needed: derivedGap, derived_artifact: cyc ? { table: "player_acquisition_cycles", salary_at_acquisition_usd: cyc.salary_at_acquisition_usd, contract_years_at_acquisition: cyc.contract_years_at_acquisition, expected: { salary_at_acquisition_usd: FCFS_SALARY, contract_years_at_acquisition: 1 } } : null,
      artifacts_affected: d.category === "mfl_correction" ? ["MFL salaries (import)", "salary_change_log", "ups_auction_contract_finalizations(fcfs)"]
        : d.action === "reprice_unstamped_fcfs_drop" ? ["ups_drop_events", "ups_contract_gate_audit"] : [],
      review_class: d.review_class || "", category: d.category, action: d.action, correction_required: d.correctionRequired, auto_correctable: d.autoCorrectable, reason: d.reason,
      already_corrected: alreadyCorrected, stamped_by: stampedBy, ledger_row: !!ledgerRow,
      drop_event: dropEvent ? { id: dropEvent.id, penalty_basis: dropEvent.penalty_basis, penalty_amount: dropEvent.penalty_amount, earned_to_date: dropEvent.earned_to_date, posted_to_mfl: dropEvent.posted_to_mfl } : null,
      drop_event_row: dropEvent || null,
    };
    rows.push(row);
  }
  return rows;
}

// ───────────────────────────── how an open FCFS add event gets closed ─────────────────────────────
/**
 * Never a claim the evidence does not support:
 *   rostered by the acquirer AND MFL holds EXACTLY the canonical contract  → `stamper_reconcile_cron`: the existing stamper's reconcile step closes it on its next tick (nothing to run by hand);
 *   dropped                                                                → `close_fcfs_add_event`: a roster re-read cannot verify a dropped player, so the event is closed by the audited
 *                                                                            step that runs only AFTER that drop's own repair landed (its canonical pre-drop contract + audit row are the evidence)
 *   anything else                                                          → `manual_review`
 */
export function planAddEventClosure(p, addEv, ctx) {
  const base = { add_event_id: addEv.id, contract_annotated: num(addEv.contract_annotated) };
  if (base.contract_annotated === 1) return { ...base, method: "none_already_closed", ready: true };
  if (base.contract_annotated !== 0 && base.contract_annotated !== 3) return { ...base, method: "manual_review", ready: false, reason: `contract_annotated=${addEv.contract_annotated} (a described contract — never reverted)` };
  if (p.endKind === "dropped" && ctx.dropEvent) {
    const de = ctx.dropEvent;
    const audits = (ctx.repairAudit || []).filter((a) => s(a.note).startsWith(`drop_event_id=${de.id} `));
    const plan = planFcfsAddEventClosure({ addEvent: { ...addEv, season: CURRENT_SEASON, source: "fcfs" }, dropRow: de, auditRows: audits });
    if (plan.ok) return { ...base, method: "close_fcfs_add_event", ready: true, drop_event_id: de.id, evidence: plan.evidence, roster_verified: false, before: { ...plan.before, annotated_at_utc: addEv.annotated_at_utc == null ? null : addEv.annotated_at_utc }, after: plan.after };
    const awaiting = de.penalty_basis === "contract_unstamped_needs_review";
    return { ...base, method: "close_fcfs_add_event", ready: false, roster_verified: false, drop_event_id: de.id, blocked_by: plan.result, detail: plan.detail || "",
      depends_on: awaiting ? { kind: "reprice_unstamped_fcfs_drop", id: de.id } : null,
      before: { contract_annotated: base.contract_annotated, notes: addEv.notes == null ? null : addEv.notes, annotated_at_utc: addEv.annotated_at_utc == null ? null : addEv.annotated_at_utc },
      after: awaiting ? { contract_annotated: 1, notes: ADD_EVENT_CLOSE_NOTE(de.id) } : null,
      reason: awaiting ? "closable only AFTER the audited repair of its drop event; a roster re-read cannot verify a dropped player" : `the drop's own contract is ${plan.result} — needs review` };
  }
  // MFL holds EXACTLY the canonical contract and the acquirer rosters him: the stamper's reconcile closes it — by the cron while the add is inside its look-back, otherwise by ONE manual call
  const canonicalNow = !!(ctx.mflReadable && ctx.mflNow && ctx.mflRoster && ctx.mflRoster.fid === p.fid && classifyFcfsContract(ctx.mflNow, { season: CURRENT_SEASON }).state === "correct");
  if (canonicalNow && (p.endKind === "held_to_season_end" || p.endKind === "replaced")) {
    const ageDays = Number.isFinite(ctx.now) ? (ctx.now - num(addEv.acquired_at_unix)) / 86400 : NaN;
    if (Number.isFinite(ageDays) && ageDays <= CRON_LOOKBACK_DAYS) return { ...base, method: "stamper_reconcile_cron", ready: true, evidence: "live MFL holds exactly the canonical contract and the acquirer rosters him — the stamper's reconcile step closes it on its next tick (contract_annotated = 1)", age_days: Math.round(ageDays * 10) / 10 };
    const days = Number.isFinite(ageDays) ? Math.min(90, Math.ceil(ageDays) + 1) : 30;
    return { ...base, method: "stamper_reconcile_manual", ready: true, age_days: Number.isFinite(ageDays) ? Math.round(ageDays * 10) / 10 : null,
      evidence: `live MFL holds exactly the canonical contract and the acquirer rosters him, but the add is OUTSIDE the cron's ${CRON_LOOKBACK_DAYS}-day look-back — the cron will never close it; one manual call does: POST /admin/adds/stamp-ww-contracts { "season": "${CURRENT_SEASON}", "league_id": "${LEAGUE_ID}", "days": ${days} } (writes nothing to MFL when nothing is blank)`, manual_call: { route: "/admin/adds/stamp-ww-contracts", body: { season: String(CURRENT_SEASON), league_id: LEAGUE_ID, days } } };
  }
  // the canonical contract was written and its owner then converted it (MYM / extension …): MFL no longer holds the FCFS contract, so the cron reconcile can never close it
  const conv = !ctx.dropEvent ? planFcfsAddEventClosure({ addEvent: { ...addEv, season: CURRENT_SEASON, source: "fcfs" }, dropRow: null, auditRows: [], changeLog: ctx.changeLog }) : null;
  if (conv && conv.ok && conv.path === "owner_conversion") {
    return { ...base, method: "close_fcfs_add_event", variant: "owner_conversion", ready: true, roster_verified: false, evidence: conv.evidence,
      mfl_observed_now: ctx.mflNow ? { status: ctx.mflNow.contractStatus, info: ctx.mflNow.contractInfo, year: ctx.mflNow.contractYear } : null,
      before: { ...conv.before, annotated_at_utc: addEv.annotated_at_utc == null ? null : addEv.annotated_at_utc }, after: conv.after };
  }
  if (p.endKind === "held_to_season_end" || p.endKind === "replaced") {
    // blank → the mfl_stamp step comes first, then the reconcile. A DESCRIBED contract with no landed-stamp → owner-conversion chain proves nothing about the canonical contract: a person decides.
    const state = ctx.mflReadable && ctx.mflNow ? classifyFcfsContract(ctx.mflNow, { season: CURRENT_SEASON }).state : "";
    if (["blank", "zero", "award_salary_only"].includes(state) && p.endKind === "held_to_season_end") return { ...base, method: "stamper_reconcile_cron", ready: false, reason: "MFL does not (yet) hold the canonical contract for the acquirer — the stamp comes first, then the reconcile" };
    return { ...base, method: "manual_review", ready: false, reason: "MFL holds a contract that is not the canonical FCFS one and no landed stamp → owner-conversion chain proves it was — nothing here can close this event; a person decides" };
  }
  return { ...base, method: "manual_review", ready: false, reason: `the acquirer no longer holds him (${p.endKind}) and there is no drop record to settle against` };
}

// ───────────────────────────── plan ─────────────────────────────
const KIND_ORDER = { mfl_stamp: 0, reprice_unstamped_fcfs_drop: 1, close_fcfs_add_event: 2 };
export function buildPlan(rows) {
  const actions = [];
  for (const r of rows) {
    if (r.action === "mfl_stamp") actions.push({ kind: "mfl_stamp", category: "mfl_correction", season: r.season, player_id: r.player_id, franchise_id: r.franchise_id, transaction_id: r.transaction_id, before: r.contract_now_mfl, after: canonicalFcfsContract({}) });
    if (r.action === "reprice_unstamped_fcfs_drop" && r.drop_event_row) {
      const p = planUnstampedFcfsDropRepair(r.drop_event_row);
      // exact column-level before/after (or the conflict that stops the repair) — the same pure function the worker route uses
      actions.push({ kind: "reprice_unstamped_fcfs_drop", category: "d1_correction", season: r.season, player_id: r.player_id, franchise_id: r.franchise_id, id: r.drop_event.id, expect: { penalty_basis: r.drop_event.penalty_basis, penalty_amount: r.drop_event.penalty_amount },
        ...(p.ok ? { before: p.before, after: p.after, unchanged: p.unchanged, columns_changed: Object.keys(p.after) } : { blocked: p.result, detail: p.detail || "" }) });
    }
    const cl = r.add_event_closure;
    if (cl && cl.method === "close_fcfs_add_event" && cl.after) {
      actions.push({ kind: "close_fcfs_add_event", variant: cl.variant || "drop_repair", category: "d1_correction", season: r.season, player_id: r.player_id, franchise_id: r.franchise_id, id: cl.add_event_id, expect: { contract_annotated: cl.contract_annotated },
        depends_on: cl.depends_on || null, drop_event_id: cl.drop_event_id, before: cl.before, after: cl.after, roster_verified: false, ...(cl.ready ? {} : { applicable_after: cl.depends_on ? `${cl.depends_on.kind}:${cl.depends_on.id}` : cl.blocked_by }) });
    }
  }
  // a step that depends on another runs AFTER it (mfl stamp → drop repair → add-event closure)
  return actions.map((a, i) => [a, i]).sort((x, y) => (KIND_ORDER[x[0].kind] - KIND_ORDER[y[0].kind]) || (x[1] - y[1])).map((x) => x[0]);
}

const by2 = (list, fn) => list.reduce((m, r) => { const k = fn(r); m[k] = (m[k] || 0) + 1; return m; }, {});
/** Every zero-contract period, classified — the totals must add up to the number of zero periods (nothing is left unclassified). */
export function zeroReport(rows) {
  const zs = rows.filter((r) => r.classification === "zero" && r.season < CURRENT_SEASON);
  const classified = zs.filter((r) => r.zero_classification);
  const classes = Object.values(ZERO_CLASS);
  const count = (list, k) => list.filter((r) => r.zero_classification && r.zero_classification.zero_class === k).length;
  return {
    total: zs.length, classified: classified.length, unclassified: zs.length - classified.length, current_season_zero_rows_not_classified: rows.filter((r) => r.classification === "zero" && r.season >= CURRENT_SEASON).length,
    by_class: Object.fromEntries(classes.map((k) => [k, count(zs, k)])),
    balances: classified.length === zs.length && classes.reduce((n, k) => n + count(zs, k), 0) === zs.length,
    by_season: by2(zs, (r) => r.season),
    by_class_and_bucket: Object.fromEntries(classes.map((k) => [k, by2(zs.filter((r) => r.zero_classification && r.zero_classification.zero_class === k), (r) => r.bucket)])),
    by_class_and_review_category: Object.fromEntries(classes.map((k) => [k, by2(zs.filter((r) => r.zero_classification && r.zero_classification.zero_class === k), (r) => r.category)])),
    by_evidence_grade: by2(classified, (r) => r.zero_classification.evidence_grade),
  };
}
export function summarize(rows, plan) {
  const by = (fn) => rows.reduce((m, r) => { const k = fn(r); m[k] = (m[k] || 0) + 1; return m; }, {});
  const seasons = [...new Set(rows.map((r) => r.season))].sort();
  return {
    total: rows.length,
    by_season: by((r) => r.season),
    by_classification: by((r) => r.classification),
    by_bucket: by((r) => r.bucket),
    by_category: by((r) => r.category),
    by_season_classification: seasons.map((y) => ({ season: y, ...rows.filter((r) => r.season === y).reduce((m, r) => { m[r.classification] = (m[r.classification] || 0) + 1; return m; }, {}) })),
    correct: rows.filter((r) => r.classification === "correct").length,
    blank: rows.filter((r) => r.classification === "blank").length,
    zero: rows.filter((r) => r.classification === "zero").length,
    award_salary_only: rows.filter((r) => r.classification === "award_salary_only").length,
    non_1000: rows.filter((r) => r.classification === "non_canonical" && (r.classification_reasons || []).some((x) => x.startsWith("salary_"))).length,
    missing_contract_rows: rows.filter((r) => r.classification === "missing_row").length,
    active_affected: rows.filter((r) => r.season === CURRENT_SEASON && r.correction_required && r.active_at_evidence).length,
    review_by_class: by2(rows.filter((r) => r.category === "manual_review"), (r) => `${r.review_class || "other"}`),
    dropped_affected: rows.filter((r) => r.correction_required && /^dropped/.test(r.bucket)).length,
    traded_affected: rows.filter((r) => r.correction_required && /^traded/.test(r.bucket)).length,
    reacquired_affected: rows.filter((r) => r.correction_required && /reacquired/.test(r.bucket)).length,
    auto_correctable: rows.filter((r) => r.correction_required && r.auto_correctable).length,
    manual_review: rows.filter((r) => r.category === "manual_review").length,
    derived_regen_needed: rows.filter((r) => r.derived_regen_needed).length,
    planned_actions: plan.length,
    planned_by_kind: plan.reduce((m, a) => { m[a.kind] = (m[a.kind] || 0) + 1; return m; }, {}),
    estimated_cap_delta_dollars: 0,           // reprice: $0 → $0 (canonical FCFS drop is cap-free); stamp: the pickup is already counted at its salary by the cap authority once written
    already_corrected_2026: rows.filter((r) => r.already_corrected).map((r) => ({ player_id: r.player_id, name: r.player_name, franchise_id: r.franchise_id, stamped_by: r.stamped_by })),
    // ── the two-ledger union ──
    by_evidence_sources: by((r) => (r.evidence_sources || []).join("+") || "(none)"),
    hist_only_periods: rows.filter((r) => (r.evidence_sources || []).length === 1 && r.evidence_sources[0] === "mfl_historical_transactions").map((r) => ({ season: r.season, player_id: r.player_id, franchise_id: r.franchise_id, acquired_at: r.acquired_at })),
    // ── every zero-contract period, in exactly one of four classes ──
    zero_periods: zeroReport(rows),
    // ── the unverifiable closed-season gaps: counted, and left exactly as they are ──
    closed_season_unverifiable_gaps: { total: rows.filter((r) => r.review_class === "closed_season_unverifiable").length, unchanged: true, by_classification: by2(rows.filter((r) => r.review_class === "closed_season_unverifiable"), (r) => r.classification), by_season: by2(rows.filter((r) => r.review_class === "closed_season_unverifiable"), (r) => r.season) },
    closed_season_anomalies: rows.filter((r) => r.anomaly_explanation).map((r) => ({ season: r.season, player_id: r.player_id, player_name: r.player_name, franchise_id: r.franchise_id, contract_evidence_row: r.contract_evidence_row, explanation_class: r.anomaly_explanation.explanation_class, evidence: r.anomaly_explanation.evidence, conclusion: r.anomaly_explanation.conclusion })),
    unexplained_closed_season_anomalies: rows.filter((r) => r.review_class === "closed_season_anomaly").length,
    // ── how each open 2026 FCFS add event gets closed ──
    add_event_closures: rows.filter((r) => r.add_event_closure && r.add_event_closure.contract_annotated !== 1).map((r) => ({ add_event_id: r.add_event_closure.add_event_id, player_id: r.player_id, name: r.player_name, franchise_id: r.franchise_id, state: r.add_event_closure.contract_annotated, method: r.add_event_closure.method, ready: r.add_event_closure.ready, depends_on: r.add_event_closure.depends_on || null, roster_verified: r.add_event_closure.roster_verified === false ? false : undefined, reason: r.add_event_closure.reason || r.add_event_closure.evidence || "" })),
  };
}

// ───────────────────────────── source coverage (the "earliest complete season" answer) ─────────────────────────────
export async function crosscheck(io, ds) {
  const perSeason = buildAddsAndEvents(ds).adds.filter((a) => a.season < CURRENT_SEASON).reduce((m, a) => { m[a.season] = (m[a.season] || 0) + 1; return m; }, {});
  perSeason[CURRENT_SEASON] = ds.tx2026.filter((r) => r.type === "FREE_AGENT" && s(r.added_players)).length;
  const out = [];
  for (let y = 2010; y <= CURRENT_SEASON; y += 1) {
    let mfl = null, note = "";
    try {
      const j = await io.mfl(y, "transactions", "&TRANS_TYPE=FREE_AGENT");
      if (j && j.transactions) mfl = asArr(j.transactions.transaction).filter((t) => s(t.transaction).split("|")[0].replace(/,/g, "").trim()).length;
      else note = s(j && j.$t) || "unreadable";
    } catch (e) { note = String(e.message || e).slice(0, 80); }
    const d1 = perSeason[y] || 0;
    out.push({ season: y, d1_fcfs_adds: d1, mfl_fcfs_adds: mfl, status: mfl == null ? `mfl_unavailable (${note})` : mfl === d1 ? "match" : `MISMATCH (d1 ${d1} vs mfl ${mfl})` });
  }
  return out;
}

// ───────────────────────────── apply / verify ─────────────────────────────
export async function applyPlan(plan, io, { key, dryRun = true, season = CURRENT_SEASON } = {}) {
  const results = [];
  if (dryRun) return plan.map((a) => ({ ...a, result: "dry_run_only" }));
  if (!key) throw new Error("apply needs UPS_COMMISH_API_KEY in the environment");
  for (const a of plan) {
    if (a.season !== season) { results.push({ ...a, result: "skipped_out_of_scope_season" }); continue; }
    if (a.blocked) { results.push({ ...a, result: `blocked_${a.blocked}` }); continue; }
    // a step whose dependency did not land is never sent
    if (a.depends_on && !results.some((x) => x.kind === a.depends_on.kind && x.id === a.depends_on.id && ["applied", "noop_already_repriced"].includes(x.result))) { results.push({ ...a, result: "skipped_dependency_not_applied" }); continue; }   // e.g. conflict_penalty_would_change: the ruling forbids the write
    if (a.kind === "mfl_stamp") {
      // precondition: the row is STILL blank and STILL held by the acquiring franchise (re-read right before the write)
      const sal = await io.mfl(CURRENT_SEASON, "salaries"), ros = await io.mfl(CURRENT_SEASON, "rosters");
      const live = asArr(sal && sal.salaries && sal.salaries.leagueUnit && sal.salaries.leagueUnit.player).find((p) => digits(p.id) === a.player_id);
      let holder = "";
      for (const f of asArr(ros && ros.rosters && ros.rosters.franchise)) for (const p of asArr(f.player)) if (digits(p.id) === a.player_id) holder = pad4(f.id);
      const cls = classifyFcfsContract(rowOf(live), { season: CURRENT_SEASON });
      if (cls.state === "correct") { results.push({ ...a, result: "noop_already_canonical" }); continue; }
      if (!["blank", "zero", "award_salary_only"].includes(cls.state) || holder !== a.franchise_id) { results.push({ ...a, result: "precondition_failed", detail: `state=${cls.state} holder=${holder}` }); continue; }
      // (the plan stamps a salary-only award ONLY when the salary is exactly $1,000 — decidePeriod; a different salary is a person's call, then and now)
      if (cls.state === "award_salary_only" && num(live && live.salary) !== FCFS_SALARY) { results.push({ ...a, result: "precondition_failed", detail: `award salary ${s(live && live.salary)} is not the canonical $${FCFS_SALARY}` }); continue; }
      const c = a.after;
      const res = await io.post("/admin/import-salaries?L=" + LEAGUE_ID + "&YEAR=" + CURRENT_SEASON, { season: String(CURRENT_SEASON), league_id: LEAGUE_ID, dry_run: false, rows: [{ id: a.player_id, salary: c.salary, contractStatus: c.contractStatus, contractYear: c.contractYear, contractInfo: c.contractInfo }] }, key);
      const after = await io.mfl(CURRENT_SEASON, "salaries");
      const now = asArr(after && after.salaries && after.salaries.leagueUnit && after.salaries.leagueUnit.player).find((p) => digits(p.id) === a.player_id);
      const ok = classifyFcfsContract(rowOf(now), { season: CURRENT_SEASON }).state === "correct";
      results.push({ ...a, result: ok ? "applied_verified" : "applied_unverified", http: res.status });
    } else if (a.kind === "close_fcfs_add_event") {
      // AFTER the drop repair only (the plan is dependency-ordered); the route re-checks the canonical pre-drop contract AND the audit row, so a repair that did not land refuses this
      const res = await io.post("/admin/drops/full-year-repair?L=" + LEAGUE_ID + "&YEAR=" + CURRENT_SEASON, { season: String(CURRENT_SEASON), league_id: LEAGUE_ID, dry_run: false, actions: [{ kind: a.kind, id: a.id, expect: a.expect }] }, key);
      const r0 = res.body && res.body.results && res.body.results[0];
      results.push({ ...a, result: r0 ? r0.result : `http_${res.status}` });
    } else if (a.kind === "reprice_unstamped_fcfs_drop") {
      const res = await io.post("/admin/drops/full-year-repair?L=" + LEAGUE_ID + "&YEAR=" + CURRENT_SEASON, { season: String(CURRENT_SEASON), league_id: LEAGUE_ID, dry_run: false, actions: [{ kind: a.kind, id: a.id, expect: a.expect }] }, key);
      const r0 = res.body && res.body.results && res.body.results[0];
      results.push({ ...a, result: r0 ? r0.result : `http_${res.status}` });
    }
  }
  return results;
}

/** --apply may only send what was REVIEWED: the fresh plan must equal the reviewed plan_proposed_after_state.json (same actions, same expected before-state, same proposed after-state). */
export function planDrift(fresh, reviewed) {
  const key = (a) => JSON.stringify([a.kind, a.player_id, a.franchise_id, a.id == null ? null : a.id, a.blocked || null, a.expect || null, a.after || null]);
  const f = new Set(fresh.map(key)), r = new Set(reviewed.map(key));
  return { ok: f.size === r.size && [...f].every((k) => r.has(k)), added: [...f].filter((k) => !r.has(k)).length, removed: [...r].filter((k) => !f.has(k)).length };
}

const sqlLit = (v) => (v === null || v === undefined ? "NULL" : typeof v === "number" ? String(Number(v)) : `'${String(v).replace(/'/g, "''")}'`);
/**
 * The exact reverse of every planned D1 reprice — a REVIEWED script for Keith to run, never run by this tool. (An MFL contract stamp has no rollback by design:
 * a blank contract is the defect, and the canonical contract is what MFL should hold.) Guarded: it only fires on a row that still carries the repriced basis.
 */
export function rollbackSql(plan) {
  const lines = [];
  for (const a of plan.filter((x) => x.kind === "reprice_unstamped_fcfs_drop" && !x.blocked && x.before && x.after)) {
    const cols = Object.keys(a.before);
    lines.push(`UPDATE ups_drop_events SET ${cols.map((c) => `${c} = ${sqlLit(a.before[c])}`).join(", ")} WHERE id = ${Number(a.id)} AND penalty_basis = ${sqlLit(a.after.penalty_basis)} AND pre_drop_contract_info = ${sqlLit(a.after.pre_drop_contract_info)} AND earned_to_date IS NULL;`);
  }
  // the add-event closure: back to its refused state — guarded on the closed state (1 or 2) AND the closure note, so it can never undo a later change
  for (const a of plan.filter((x) => x.kind === "close_fcfs_add_event" && x.before && x.after)) {
    lines.push(`UPDATE ups_add_events SET contract_annotated = ${Number(a.before.contract_annotated)}, annotated_at_utc = ${sqlLit(a.before.annotated_at_utc)}, notes = ${sqlLit(a.before.notes)} WHERE id = ${Number(a.id)} AND contract_annotated = ${Number(a.after.contract_annotated)} AND notes = ${sqlLit(a.after.notes)};`);
  }
  return lines.join("\n") + (lines.length ? "\n" : "");
}

/** Second-run / verification proof: nothing left to correct, and every current-season FCFS period that is still held is canonical. */
export function verifyRows(rows, plan) {
  const failures = [];
  if (plan.length) failures.push(`${plan.length} action(s) still pending`);
  // an ACTIVE current-season FCFS contract that is blank / zero / salary-only is a defect; a contract an owner or the commissioner DESCRIBED (MYM, extension …) is theirs and is a known manual-review row, not a failure
  for (const r of rows) if (r.season === CURRENT_SEASON && r.active_at_evidence && ["blank", "zero", "award_salary_only", "missing_row"].includes(r.classification)) failures.push(`${r.player_id} (${r.franchise_id}) is ${r.classification}`);
  // an open add event that the cron can no longer see, or that nothing in the plan can close, is still to correct (a cron-closable one is not: the next tick does it)
  for (const r of rows) { const c = r.add_event_closure; if (c && c.contract_annotated !== 1 && c.contract_annotated !== 2 && (c.method === "manual_review" || c.method === "stamper_reconcile_manual")) failures.push(`add event ${c.add_event_id} (${r.player_id}) is still open: ${c.method}`); }
  return { ok: failures.length === 0, failures };
}

// ───────────────────────────── reports ─────────────────────────────
const csvCell = (v) => { const t = typeof v === "object" && v !== null ? JSON.stringify(v) : String(v == null ? "" : v); return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
export function toCsv(rows) {
  const cols = ["season", "transaction_id", "acquired_at", "player_id", "player_name", "franchise_id", "team", "owner", "evidence_sources", "contract_evidence", "contract_evidence_row", "expected_canonical", "active_at_evidence", "drop_date", "trade_date", "reacquired_date", "later_replacement", "bucket", "classification", "zero_classification", "anomaly_explanation", "add_event_closure", "current_status", "category", "review_class", "action", "correction_required", "auto_correctable", "reason", "artifacts_affected"];
  return [cols.join(","), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(","))].join("\n") + "\n";
}

export function parseArgs(argv) {
  const o = { apply: false, yes: false, verify: false, crosscheck: false, offline: false, filters: {} };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i], nx = () => argv[++i];
    if (a === "--apply") o.apply = true; else if (a === "--yes") o.yes = true; else if (a === "--verify") o.verify = true;
    else if (a === "--crosscheck") o.crosscheck = true; else if (a === "--offline") o.offline = true;
    else if (a === "--season") o.filters.season = nx(); else if (a === "--player") o.filters.player = nx();
    else if (a === "--franchise") o.filters.franchise = nx(); else if (a === "--txn") o.filters.txn = nx();
    else if (a === "--out") o.out = nx(); else if (a === "--cache") o.cache = nx(); else if (a === "--base") o.base = nx(); else if (a === "--plan") o.plan = nx();
    else throw new Error(`unknown argument ${a}`);
  }
  return o;
}

export async function run(argv, { io: ioIn, log = console.log, env = process.env, now } = {}) {
  const o = parseArgs(argv);
  if (o.apply && !(o.yes && o.filters.season)) throw new Error("--apply needs --yes and an explicit --season (write mode is never implicit)");
  if (o.apply && num(o.filters.season) !== CURRENT_SEASON) throw new Error(`--apply is only permitted for the current season (${CURRENT_SEASON}); closed seasons are never auto-written`);
  const io = ioIn || productionIo({ base: o.base || DEFAULT_BASE });
  const stampDir = o.out || path.join(process.cwd(), "fcfs_backfill_out", new Date().toISOString().replace(/[:.]/g, "-"));
  if (!o.offline && !o.cache && fs.existsSync(path.join(stampDir, "dataset_before_state"))) throw new Error(`the output directory ${stampDir} already holds a before-state dataset — use a NEW --out (a reused directory would silently reuse stale data), or --offline to deliberately reuse it`);
  fs.mkdirSync(stampDir, { recursive: true });
  const ds = await loadDataset(io, { cacheDir: o.cache || path.join(stampDir, "dataset_before_state"), offline: o.offline });
  const rows = buildInventory(ds, o.filters, { now });
  const plan = buildPlan(rows);
  const summary = summarize(rows, plan);
  summary.hist_rows_unusable = buildAddsAndEvents(ds).histUnusable;   // second-ledger adds with no usable stamp / franchise prove NO period — reported, never coerced
  const report = { mode: o.apply ? "apply" : o.verify ? "verify" : "dry_run", summary, plan };
  fs.writeFileSync(path.join(stampDir, "inventory.json"), JSON.stringify(rows, null, 1));
  fs.writeFileSync(path.join(stampDir, "inventory.csv"), toCsv(rows));
  fs.writeFileSync(path.join(stampDir, "plan_proposed_after_state.json"), JSON.stringify(plan, null, 1));
  fs.writeFileSync(path.join(stampDir, "rollback.sql"), rollbackSql(plan));
  if (o.crosscheck) { const cc = await crosscheck(io, ds); report.crosscheck = cc; fs.writeFileSync(path.join(stampDir, "source_crosscheck.json"), JSON.stringify(cc, null, 1)); }
  if (o.apply) {
    if (!o.plan) throw new Error("--apply needs --plan <plan_proposed_after_state.json from the reviewed dry run> (write mode only sends what was reviewed)");
    const drift = planDrift(plan, JSON.parse(fs.readFileSync(o.plan, "utf8")));
    if (!drift.ok) throw new Error(`the plan changed since it was reviewed (${o.plan}): +${drift.added} / -${drift.removed} — re-run the dry run and review again`);
    report.plan_bound_to = o.plan;
    const key = s(env.UPS_COMMISH_API_KEY);
    report.applied = await applyPlan(plan, io, { key, dryRun: false, season: num(o.filters.season) });
  } else if (o.verify) {
    report.verify = verifyRows(rows, plan);
  }
  fs.writeFileSync(path.join(stampDir, "report.json"), JSON.stringify(report, null, 1));
  log(JSON.stringify({ out: stampDir, mode: report.mode, summary, verify: report.verify || undefined, applied: report.applied ? report.applied.map((a) => ({ kind: a.kind, player_id: a.player_id, id: a.id, result: a.result })) : undefined }, null, 1));
  return { rows, plan, summary, report, dir: stampDir };
}

// (realpath on BOTH sides: a symlinked invocation must still run — silently doing nothing and exiting 0 would read as a passing --verify)
const isMain = (() => { try { return fs.realpathSync(process.argv[1] || "") === fs.realpathSync(fileURLToPath(import.meta.url)); } catch (_) { return false; } })();
if (isMain) {
  run(process.argv.slice(2)).then((r) => {
    if (r.report.verify && !r.report.verify.ok) process.exit(1);
    if (r.report.applied && r.report.applied.some((a) => !["applied", "applied_verified", "noop_already_canonical", "noop_already_repriced"].includes(a.result))) process.exit(1);
  }).catch((e) => { console.error(String(e && e.message || e)); process.exit(2); });
}
