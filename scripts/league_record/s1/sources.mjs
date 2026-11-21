// League Record S1 pilot: source loaders. Every record the extraction uses is read here and carries a SOURCE REFERENCE (which archive table and rows, or which daily snapshot file),
// so every later statement can say where it came from. Nothing here reads standings, finishes, brackets or a projected order.
import fs from "node:fs";
import path from "node:path";

// The one daily snapshot whose transactions, rosters and final draft results the pilot reads. Pinned so the report is reproducible while new daily snapshots keep arriving.
export const SNAPSHOT_DAY = "2026-11-19";
export const SNAPSHOT_DIR = "data/mfl-snapshots";

// ── time ──────────────────────────────────────────────────────────────────────────────────────────
const ET = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
export function etParts(unixSeconds) {
  const p = Object.fromEntries(ET.formatToParts(new Date(Number(unixSeconds) * 1000)).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}:${p.second}` };
}
export const dayNumber = (isoDate) => Math.floor(Date.parse(`${isoDate}T00:00:00Z`) / 86400000);
export const addDays = (isoDate, n) => new Date((dayNumber(isoDate) + n) * 86400000).toISOString().slice(0, 10);

// ── ids ───────────────────────────────────────────────────────────────────────────────────────────
export const playerAsset = (id) => `player:${id}`;
export const futurePickAsset = (orig, year, round) => `fpick:${orig}:${Number(year)}:${Number(round)}`;
export const slotPickAsset = (year, round, slot) => `spick:${Number(year)}:${Number(round)}:${Number(slot)}`;

// MFL trade tokens: a bare number is a player; FP_<original franchise>_<year>_<round>; DP_<round0>_<slot0> (the year is the trade's draft year); BB_<dollars> is cap money.
export function parseTokens(text, draftYear) {
  const out = [];
  for (const raw of String(text || "").split(",")) {
    const t = raw.trim();
    if (!t) continue;
    let m;
    if ((m = /^(\d{3,6})$/.exec(t))) out.push({ kind: "player", id: asset(playerAsset(m[1])), player_id: m[1], token: t });
    else if ((m = /^FP_(\d{4})_(\d{4})_(\d{1,2})$/.exec(t))) out.push({ kind: "future_pick", id: futurePickAsset(m[1], m[2], m[3]), original_franchise: m[1], year: Number(m[2]), round: Number(m[3]), token: t });
    else if ((m = /^DP_(\d{1,2})_(\d{1,2})$/.exec(t))) out.push({ kind: "slot_pick", id: slotPickAsset(draftYear, Number(m[1]) + 1, Number(m[2]) + 1), year: draftYear, round: Number(m[1]) + 1, slot: Number(m[2]) + 1, token: t });
    else if ((m = /^BB_(\d+)$/.exec(t))) out.push({ kind: "cap", id: null, amount: Number(m[1]), token: t });
    else out.push({ kind: "unknown", id: null, token: t });
  }
  return out;
}
function asset(id) { return id; }

// ── snapshots ─────────────────────────────────────────────────────────────────────────────────────
export function snapshotDays(root) {
  return fs.readdirSync(path.join(root, SNAPSHOT_DIR)).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
}
export function readSnapshot(root, day, file) {
  const p = path.join(root, SNAPSHOT_DIR, day, file);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, "utf8"));
}
const arr = (x) => (Array.isArray(x) ? x : x == null ? [] : [x]);

export function franchiseNames(root, day) {
  const j = readSnapshot(root, day, "league.json");
  const fr = j && j.league && j.league.franchises && j.league.franchises.franchise;
  return new Map(arr(fr).map((f) => [String(f.id), String(f.name)]));
}

// ── trades ────────────────────────────────────────────────────────────────────────────────────────
// A trade: { id, source, date, time, ts, season, date_quality, parties: [a, b], legs: [{ asset, from, to }], cap: [{ amount, from, to }] }.
const ARCHIVE_TRADE_SQL = `select transactionid, trade_group_id g, season, franchise_id f, franchise_name fname, asset_role role, asset_type t, player_id pid, player_name pname,
  asset_draftpick_season ds, asset_draftpick_round dr, asset_draftpick_overall dov, asset_draftpick_future_franchiseid ff, asset_draftpick_future_year fy, asset_draftpick_future_round fr,
  asset_capadjustment cap, unix_timestamp ts, date_et, time_et from transactions_trades order by unix_timestamp, trade_group_id, transactionid`;

function archiveAssetKey(r) {
  if (r.t === "PLAYER") return playerAsset(r.pid);
  if (r.t === "DRAFTPICK_FUTURE") return futurePickAsset(r.ff, r.fy, r.fr);
  if (r.t === "DRAFTPICK_CURRENT") return slotPickAsset(r.ds, r.dr, Number(r.dov) + 1);        // the slot is stored zero-indexed in the column named "overall"
  if (r.t === "CAP") return `cap:${r.cap}`;
  return null;
}
export function loadArchiveTrades(archive) {
  const rows = archive.all(ARCHIVE_TRADE_SQL);
  const groups = new Map();
  for (const r of rows) { if (!groups.has(r.g)) groups.set(r.g, []); groups.get(r.g).push(r); }
  const trades = [];
  for (const [g, rs] of groups) {
    const rel = rs.filter((r) => r.role === "RELINQUISH"), acq = rs.filter((r) => r.role === "ACQUIRE");
    const used = new Set();
    const legs = [], cap = [];
    for (const r of rel) {
      const key = archiveAssetKey(r);
      // The cap amount is recorded on the sender's row only, so a cap movement pairs with any unused CAP row of the other franchise; every other asset pairs by identity.
      const idx = acq.findIndex((a, i) => !used.has(i) && a.f !== r.f && (r.t === "CAP" ? a.t === "CAP" : archiveAssetKey(a) === key));
      if (idx < 0) { legs.push({ asset: key, from: r.f, to: null, unpaired: true, rows: [r.transactionid] }); continue; }
      used.add(idx);
      const to = acq[idx].f;
      if (r.t === "CAP") cap.push({ amount: Number(r.cap), from: r.f, to, rows: [r.transactionid, acq[idx].transactionid] });
      else legs.push({ asset: key, kind: r.t === "PLAYER" ? "player" : r.t === "DRAFTPICK_FUTURE" ? "future_pick" : "slot_pick", from: r.f, to, label: r.t === "PLAYER" ? r.pname : null, rows: [r.transactionid, acq[idx].transactionid] });
    }
    const first = rs[0];
    const parties = [...new Set(rs.map((r) => r.f))].sort();
    trades.push({
      id: g, source: { kind: "archive", table: "transactions_trades", trade_group_id: g, transaction_ids: rs.map((r) => r.transactionid) },
      date: first.date_et, time: first.time_et, ts: Number(first.ts), season: Number(first.season), parties, legs, cap,
      names: Object.fromEntries(rs.map((r) => [r.f, r.fname])),
      // Trade times before 2024 are mostly the commissioner's processing time, not the moment of agreement (docs/ai_desk/TOOL_CATALOG.md).
      date_quality: Number(first.season) >= 2024 ? "recorded" : "processing_time_likely",
    });
  }
  return trades.sort((a, b) => a.ts - b.ts || a.id.localeCompare(b.id, "en", { numeric: true }));
}

export function loadSnapshotTrades(root, day = SNAPSHOT_DAY) {
  const j = readSnapshot(root, day, "transactions.json");
  const list = arr(j && j.transactions && j.transactions.transaction);
  const names = franchiseNames(root, day);
  const trades = [];
  list.forEach((t, index) => {
    if (t.type !== "TRADE") return;
    const { date, time } = etParts(t.timestamp);
    const season = Number(date.slice(0, 4));
    const f1 = String(t.franchise), f2 = String(t.franchise2);
    const legs = [], cap = [];
    for (const [giver, receiver, text] of [[f1, f2, t.franchise1_gave_up], [f2, f1, t.franchise2_gave_up]]) {
      for (const a of parseTokens(text, season)) {
        if (a.kind === "cap") cap.push({ amount: a.amount, from: giver, to: receiver, token: a.token });
        else if (a.id) legs.push({ asset: a.id, kind: a.kind, from: giver, to: receiver, token: a.token });
        else legs.push({ asset: null, kind: "unknown", from: giver, to: receiver, token: a.token });
      }
    }
    trades.push({
      id: `snap${season}_${t.timestamp}_${f1}_${f2}`, source: { kind: "snapshot", day, file: "transactions.json", index, timestamp: t.timestamp },
      date, time, ts: Number(t.timestamp), season, parties: [f1, f2].sort(), legs, cap, names: { [f1]: names.get(f1) || null, [f2]: names.get(f2) || null }, date_quality: "recorded",
    });
  });
  return trades.sort((a, b) => a.ts - b.ts);
}

// ── draft results ─────────────────────────────────────────────────────────────────────────────────
// A selection: { year, round, slot, overall, franchise, player_id, ts, date, source, note }. Draft results record the franchise that MADE the pick (canon T1.8: before 2018 this can
// be the clicker, not the owner).
export function loadArchiveSelections(archive) {
  const mk = (r, table) => ({
    year: Number(r.season), round: Number(r.round), slot: Number(r.slot), overall: Number(r.overall), franchise: r.f, player_id: r.pid, player_name: r.pname, ts: Number(r.ts), date: r.d,
    source: { kind: "archive", table, key: { season: Number(r.season), round: Number(r.round), slot: Number(r.slot) } }, note: r.note || "",
  });
  const a = archive.all("select season, draftpick_round round, draftpick_roundorder slot, draftpick_overall overall, franchise_id f, player_id pid, player_name pname, unix_timestamp ts, date_et d, raw_comments note from draftresults_mfl");
  const b = archive.all("select season, draftpick_round round, draftpick_roundorder slot, draftpick_overall overall, franchise_id f, player_id pid, player_name pname, unix_timestamp ts, date_et d, raw_comments note from draftresults_legacy");
  // DATA DEFECT in the legacy table (2012-2017): the tenth pick of a round ("1.10", raw text "1.1") is stored with slot 1, so slot 1 appears twice and slot 10 never. MFL's own overall pick
  // number is stored correctly, so the slot is overall - 12 x (round - 1) (twelve picks a round in every legacy year). The correction is applied only when the stored slot disagrees with it and
  // the result is a slot from 1 to 12, and every corrected row carries the stored value and the rule. Nothing here uses a finish, a standing or an order other than MFL's own pick numbers.
  const fixLegacy = (r) => {
    const calc = Number(r.overall) - 12 * (Number(r.round) - 1);
    if (calc >= 1 && calc <= 12 && Number(r.slot) !== calc) return { ...r, slot: calc, _correction: { stored_slot: Number(r.slot), rule: "legacy_slot_from_overall_pick" } };
    return r;
  };
  const fromLegacy = b.map(fixLegacy).map((r) => { const sel = mk(r, "draftresults_legacy"); if (r._correction) sel.slot_correction = r._correction; return sel; });
  return [...a.map((r) => mk(r, "draftresults_mfl")), ...fromLegacy];
}
export function loadSnapshotSelections(root, day = SNAPSHOT_DAY) {
  const j = readSnapshot(root, day, "draftResults.json");
  const unit = arr(j && j.draftResults && j.draftResults.draftUnit)[0];
  if (!unit) return [];
  const year = Number(String(readSnapshot(root, day, "_snapshot_meta.json").season_year));
  return arr(unit.draftPick).filter((p) => p.player).map((p) => ({
    year, round: Number(p.round), slot: Number(p.pick), overall: (Number(p.round) - 1) * 12 + Number(p.pick), franchise: String(p.franchise), player_id: String(p.player), player_name: null,
    ts: Number(p.timestamp), date: etParts(p.timestamp).date,
    source: { kind: "snapshot", day, file: "draftResults.json", key: { round: p.round, pick: p.pick } }, note: String(p.comments || ""),
  }));
}

// The pre-draft slot lists: every slot with the franchise that holds it on a given day and MFL's own "Pick traded from ..." notes (MFL slot data, 2026 only).
export function loadSlotList(root, day) {
  const j = readSnapshot(root, day, "draftResults.json");
  const unit = arr(j && j.draftResults && j.draftResults.draftUnit)[0];
  if (!unit) return null;
  const names = franchiseNames(root, day);
  const byName = new Map();
  for (const [id, n] of names) { if (!byName.has(n)) byName.set(n, []); byName.get(n).push(id); }
  const slots = arr(unit.draftPick).map((p) => {
    const lines = String(p.comments || "").replace(/^\[|\]\s*$/g, "").split(/\n/).map((x) => x.trim()).filter(Boolean);
    const from = lines.map((l) => /^Pick traded from (.+?)\.?$/.exec(l)).filter(Boolean).map((m) => m[1]);
    return {
      round: Number(p.round), slot: Number(p.pick), holder: String(p.franchise), filled: !!p.player, note_lines: lines,
      traded_from_names: from, traded_from_ids: from.map((n) => (byName.get(n) && byName.get(n).length === 1 ? byName.get(n)[0] : null)),
    };
  });
  return { day, file: "draftResults.json", round1_order: unit.round1DraftOrder || null, slots };
}

// ── rosters at a snapshot ─────────────────────────────────────────────────────────────────────────
export function snapshotRosterIndex(root, day = SNAPSHOT_DAY) {
  const j = readSnapshot(root, day, "rosters.json");
  const idx = new Map();
  for (const f of arr(j && j.rosters && j.rosters.franchise)) for (const p of arr(f.player)) idx.set(String(p.id), { franchise: String(f.id), status: p.status, salary: p.salary == null ? null : Number(p.salary), contract_year: p.contractYear == null ? null : Number(p.contractYear), contract_status: p.contractStatus || null, contract_info: p.contractInfo || null, drafted: p.drafted || null });
  return idx;
}
export function snapshotSalaryIndex(root, day = SNAPSHOT_DAY) {
  const j = readSnapshot(root, day, "salaries.json");
  const list = arr(j && j.salaries && j.salaries.leagueUnit && j.salaries.leagueUnit.player);
  return new Map(list.map((p) => [String(p.id), { salary: p.salary === "" ? null : Number(p.salary), contract_year: p.contractYear === "" ? null : Number(p.contractYear), contract_status: p.contractStatus || null, contract_info: p.contractInfo || null }]));
}
