#!/usr/bin/env node
// Production-untouched check for a connected test (#1475). READ-ONLY.
//
// Takes a snapshot of production BEFORE and AFTER one test operation, compares record CONTENTS (not just
// counts), and says plainly when the evidence is incomplete.
//
//   node scripts/test_env/prod_untouched_check.mjs snapshot --out before.json --markers m.json [--prod-d1]
//   ...run the approved test operation...
//   node scripts/test_env/prod_untouched_check.mjs snapshot --out after.json  --markers m.json [--prod-d1 --before before.json]
//   node scripts/test_env/prod_untouched_check.mjs compare before.json after.json --markers m.json
//
// Verdicts (only "untouched" exits 0):
//   associated_activity_found  a production change mentions a test player, the idempotency key, the test
//                              league or a test label
//   review_required            a relevant production record changed or was deleted and can't be attributed
//                              automatically (e.g. a row of the test franchise id, or a deletion anywhere)
//   incomplete_evidence        a source was not compared (D1 not snapshotted, a table unreadable or only
//                              partly covered, GitHub or MFL unreadable, no markers)
//   untouched                  every automated source compared fully and nothing relevant changed.
//                              Discord is always listed as a manual check (no bot token here, by design).
//
// What a snapshot reads:
//   - MFL league 74598 PUBLIC exports (no cookie): transactions (last 7 days), rosters, salaries; every
//     record kept with a content hash.
//   - GitHub public API (no token): recent commits on main and workflow runs.
//   - Production D1, ONLY with --prod-d1 (explicit opt-in; never in tests or CI). Per table in D1_TABLES:
//       * a fingerprint: count(*), max(rowid), total(rowid), which reveals deletions and replaced rows;
//       * the rows in scope of the test markers (test players, test franchise id, test league), so an
//         UPDATE to an existing row is compared by content, or the whole table when it has no such column
//         and is small;
//       * (AFTER only) every row above the BEFORE max(rowid), by content.
//     and the full content of ups_settings and ups_runtime_flags. Measured rows_read is printed; the
//     fingerprint and unindexed scopes read each table in full, so measure once and get approval first.
//
// markers.json: { "window_start_utc", "window_end_utc", "player_ids": [...], "franchise_ids": [...],
//                 "idempotency_key": "...", "test_league": "25625" }
//
// diffSnapshots() is pure; tests/test_env_scripts.test.mjs runs it offline on fixtures.
import crypto from "node:crypto";
import fs from "node:fs";
import { execFileSync } from "node:child_process";

export const PROD_LEAGUE = "74598";
export const D1_TABLES = [
  "ups_transactions", "ups_add_events", "ups_drop_events", "salary_change_log", "ups_lineup_submissions",
  "ups_tag_submissions", "ups_extension_submissions", "ups_restructure_submissions", "ups_mym_submissions",
  "ups_taxi_callups", "ups_ir_roster_status", "twb_trade_outbox", "trade_offer_dm", "ups_trade_executions",
  "league_events", "ups_bot_heartbeat",
];
export const D1_SMALL_TABLES = ["ups_settings", "ups_runtime_flags"];
export const FULL_TABLE_ROW_LIMIT = 5000;   // a table with no scope column is compared in full up to this size
export const NEW_ROW_LIMIT = 500;
export const MFL_TX_DAYS = 7;

const arr = (x) => (x == null ? [] : Array.isArray(x) ? x : [x]);
export const hash = (v) => crypto.createHash("sha256").update(typeof v === "string" ? v : JSON.stringify(v)).digest("hex").slice(0, 16);

// Which columns put a row in scope of the test markers (matched against PRAGMA table_info names).
export function scopeColumns(columns) {
  const c = arr(columns).map(String);
  return {
    player: c.filter((x) => /^(player_id|pid|add_pid|drop_pid)$/i.test(x)),
    playerList: c.filter((x) => /^(added_players|dropped_players|player_ids|players)$/i.test(x)),
    franchise: c.filter((x) => /^(franchise_id|franchise_id2|from_franchise_id|to_franchise_id|fid)$/i.test(x)),
    league: c.filter((x) => /^league_id$/i.test(x)),
  };
}
const sqlStr = (v) => `'${String(v).replace(/'/g, "''")}'`;
export function scopeWhere(columns, markers) {
  const sc = scopeColumns(columns), parts = [];
  const players = arr(markers.player_ids).map(String).filter((x) => /^\d+$/.test(x));
  const fids = arr(markers.franchise_ids).map(String).filter((x) => /^\d{4}$/.test(x));
  if (players.length) for (const col of sc.player) parts.push(`${col} IN (${players.map(sqlStr).join(",")})`);
  for (const col of sc.playerList) for (const p of players) parts.push(`(',' || ${col} || ',') LIKE ${sqlStr(`%,${p},%`)}`);
  if (fids.length) for (const col of sc.franchise) parts.push(`${col} IN (${fids.map(sqlStr).join(",")})`);
  if (markers.test_league && /^\d+$/.test(String(markers.test_league))) for (const col of sc.league) parts.push(`${col} = ${sqlStr(markers.test_league)}`);
  return parts.length ? parts.join(" OR ") : null;
}

export function indexMfl(exports) {
  const tx = {}, rosters = {}, salaries = {};
  for (const t of arr(exports.transactions && exports.transactions.transactions && exports.transactions.transactions.transaction)) {
    tx[`${t.timestamp}|${t.type}|${t.franchise || ""}|${t.transaction || ""}`] = { hash: hash(t), record: t };
  }
  for (const f of arr(exports.rosters && exports.rosters.rosters && exports.rosters.rosters.franchise)) {
    const players = arr(f.player).map((p) => `${p.id}:${p.status}:${p.salary}:${p.contractYear}:${p.contractStatus || ""}:${p.contractInfo || ""}`).sort();
    rosters[f.id] = { hash: hash(players), record: players };
  }
  const lu = exports.salaries && exports.salaries.salaries && exports.salaries.salaries.leagueUnit;
  for (const p of arr(lu && lu.player)) salaries[p.id] = { hash: hash(p), record: p };
  return { tx, rosters, salaries };
}

function mentions(value, markers) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  const hits = [];
  for (const id of arr(markers.player_ids)) if (new RegExp(`(^|[^0-9])${id}([^0-9]|$)`).test(text)) hits.push(`player ${id}`);
  if (markers.idempotency_key && text.includes(markers.idempotency_key)) hits.push("idempotency key");
  if (markers.test_league && new RegExp(`(^|[^0-9])${markers.test_league}([^0-9]|$)`).test(text)) hits.push(`league ${markers.test_league}`);
  if (/\bTEST\b|\[TEST|ups-test|ups_test/i.test(text)) hits.push("test label");
  return hits;
}

export function diffSnapshots(before, after, markers) {
  const associated = [], review = [], unrelated = [], gaps = [];
  const m = markers || {};
  if (!m.window_start_utc || !(arr(m.player_ids).length)) gaps.push("markers missing (window and test player ids are required)");
  const ws = Date.parse(m.window_start_utc || (before && before.taken_at)), we = Date.parse(m.window_end_utc || (after && after.taken_at));
  const inWindow = (unixSec) => { const ms = Number(unixSec) * 1000; return ms >= ws - 60000 && ms <= we + 60000; };
  // hits -> associated; reviewWhy -> review (relevant but not attributable); neither -> unrelated activity
  const note = (area, what, record, hits, reviewWhy) => {
    const f = { area, what, record };
    if (hits.length) associated.push({ ...f, associated_with: hits });
    else if (reviewWhy) review.push({ ...f, why: reviewWhy });
    else unrelated.push(f);
  };

  // ── MFL 74598 ──
  if (!before || !after || !before.mfl || !after.mfl || before.mfl.error || after.mfl.error) gaps.push("MFL 74598 snapshot missing or unreadable");
  else {
    const b = indexMfl(before.mfl), a = indexMfl(after.mfl);
    // Both exports cover the last MFL_TX_DAYS days from when they were taken; compare only the overlap,
    // so a transaction that aged out of the AFTER export is not reported as deleted.
    const overlapStart = Date.parse(after.taken_at) / 1000 - MFL_TX_DAYS * 86400 + 3600;
    for (const [k, v] of Object.entries(a.tx)) if (!b.tx[k] && inWindow(v.record.timestamp)) note("mfl_74598_transactions", `new ${v.record.type} ${v.record.franchise || ""}`, v.record, mentions(v.record, m));
    for (const [k, v] of Object.entries(b.tx)) if (!a.tx[k] && Number(v.record.timestamp) >= overlapStart) note("mfl_74598_transactions", "a transaction disappeared", v.record, mentions(v.record, m), "production transaction removed");
    for (const [fid, v] of Object.entries(a.rosters)) {
      const old = b.rosters[fid];
      if (!old) { note("mfl_74598_rosters", `new franchise ${fid}`, v.record, [], "unexpected franchise"); continue; }
      if (old.hash !== v.hash) {
        const added = v.record.filter((x) => !old.record.includes(x)), removed = old.record.filter((x) => !v.record.includes(x));
        note("mfl_74598_rosters", `franchise ${fid} changed`, { added, removed }, mentions({ added, removed }, m), arr(m.franchise_ids).includes(fid) ? `production franchise ${fid} has the test franchise's id` : null);
      }
    }
    for (const fid of Object.keys(b.rosters)) if (!a.rosters[fid]) note("mfl_74598_rosters", `franchise ${fid} missing`, b.rosters[fid].record, [], "franchise removed");
    for (const [pid, v] of Object.entries(a.salaries)) {
      const old = b.salaries[pid];
      if (!old || old.hash !== v.hash) note("mfl_74598_salaries", `player ${pid} ${old ? "changed" : "added"}`, { before: old && old.record, after: v.record }, mentions({ pid, after: v.record }, m));
    }
    for (const pid of Object.keys(b.salaries)) if (!a.salaries[pid]) note("mfl_74598_salaries", `player ${pid} removed`, b.salaries[pid].record, mentions({ pid }, m), "salary row removed");
  }

  // ── GitHub ──
  if (!before || !after || !before.github || !after.github || before.github.error || after.github.error) gaps.push("GitHub snapshot missing or unreadable");
  else {
    const seen = new Set(arr(before.github.commits).map((c) => c.sha));
    for (const c of arr(after.github.commits)) if (!seen.has(c.sha)) note("github_commits", `commit ${c.sha.slice(0, 8)}`, c, mentions(c, m));
    const seenRuns = new Set(arr(before.github.runs).map((r) => r.id));
    for (const r of arr(after.github.runs)) if (!seenRuns.has(r.id)) note("github_workflow_runs", `${r.event} ${r.name}`, r, mentions(r, m), r.event === "repository_dispatch" ? "repository_dispatch in the window" : null);
  }

  // ── production D1 ──
  const coverage = {};
  if (!before || !after || !before.d1 || !after.d1) gaps.push("production D1 not compared (both snapshots need --prod-d1): the D1 part of the evidence is missing");
  else {
    for (const table of D1_TABLES) {
      const o = (before.d1.tables || {})[table], v = (after.d1.tables || {})[table];
      if (!o || !v) { gaps.push(`D1 ${table}: not in both snapshots`); continue; }
      if (o.error || v.error) { gaps.push(`D1 ${table}: ${v.error || o.error}`); continue; }
      const cov = coverage[table] = { fingerprint: true, scope: v.scope_kind, new_rows: arr(v.new_rows).length };
      // new rows by content
      for (const row of arr(v.new_rows)) note(`d1_${table}`, "new row", row, mentions(row, m));
      if (v.new_rows_truncated) gaps.push(`D1 ${table}: more than ${NEW_ROW_LIMIT} new rows; the rest were not compared`);
      // deletions / replacements from the fingerprint
      const newIds = arr(v.new_rows).map((r) => Number(r._rowid) || 0);
      const deleted = Number(o.fp.n) + newIds.length - Number(v.fp.n);
      const expectedTotal = Number(o.fp.total) + newIds.reduce((s, x) => s + x, 0);
      if (deleted > 0) note(`d1_${table}`, `${deleted} row(s) deleted`, { before: o.fp, after: v.fp }, [], "rows deleted; not attributable from counts");
      else if (!v.new_rows_truncated && Math.abs(Number(v.fp.total) - expectedTotal) > 0.5) note(`d1_${table}`, "rows replaced (rowid total changed)", { before: o.fp, after: v.fp }, [], "rows replaced or re-keyed");
      // existing rows in scope, by content
      if (v.scope_kind === "none") { gaps.push(`D1 ${table}: no scope column and over ${FULL_TABLE_ROW_LIMIT} rows; updates to existing rows not compared`); cov.existing_rows = "not compared"; continue; }
      if (o.scope_truncated || v.scope_truncated) gaps.push(`D1 ${table}: scoped rows over ${FULL_TABLE_ROW_LIMIT}; not all compared`);
      const bRows = new Map(arr(o.scoped_rows).map((r) => [String(r._rowid), r]));
      const aRows = new Map(arr(v.scoped_rows).map((r) => [String(r._rowid), r]));
      const maxBefore = Number(o.fp.max) || 0;
      for (const [id, row] of aRows) {
        const old = bRows.get(id);
        if (old && hash(old) !== hash(row)) note(`d1_${table}`, `row ${id} updated`, { before: old, after: row }, mentions({ before: old, after: row }, m), `existing ${v.scope_kind === "full" ? "" : "in-scope "}row changed`);
        else if (!old && Number(id) <= maxBefore) note(`d1_${table}`, `row ${id} now in scope (updated)`, row, mentions(row, m), "existing row changed into the test scope");
      }
      for (const [id, row] of bRows) if (!aRows.has(id)) note(`d1_${table}`, `row ${id} left scope or was deleted`, row, mentions(row, m), "in-scope row deleted or changed");
      cov.existing_rows = v.scope_kind === "full" ? "all rows compared" : `rows in scope compared (${v.scope_where})`;
    }
    for (const table of D1_SMALL_TABLES) {
      const o = (before.d1.small || {})[table], v = (after.d1.small || {})[table];
      if (!o || !v || o.error || v.error) { gaps.push(`D1 ${table}: ${(v && v.error) || (o && o.error) || "not in both snapshots"}`); continue; }
      coverage[table] = { existing_rows: "all rows compared" };
      if (o.hash !== v.hash) note(`d1_${table}`, "global setting content changed", { before: o.rows, after: v.rows }, mentions(v.rows, m), "global state changed in the window");
    }
  }

  const complete = gaps.length === 0;
  const verdict = associated.length ? "associated_activity_found" : (review.length ? "review_required" : (!complete ? "incomplete_evidence" : "untouched"));
  return {
    verdict, untouched: verdict === "untouched", complete,
    associated, review, unrelated_production_activity: unrelated, evidence_gaps: gaps, d1_coverage: coverage,
    manual_checks: ["Discord: no message in any production channel during the window (the test worker's ups_test_egress_log lists every Discord call it refused or sent)"],
  };
}

// ── network side (CLI only) ─────────────────────────────────────────────────────────────────────
async function getJson(url) {
  if (/myfantasyleague\.com/.test(url) && !url.includes(`L=${PROD_LEAGUE}`)) throw new Error("this check reads league 74598 only");
  const r = await fetch(url, { headers: { "User-Agent": "ups-prod-untouched-check", Accept: "application/json" } });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
  return r.json();
}

function d1(command) {
  const out = execFileSync("npx", ["wrangler", "d1", "execute", "ups-mfl-db", "--remote", "--json", "--command", command], { cwd: new URL("../../worker", import.meta.url).pathname, encoding: "utf8" });
  const j = JSON.parse(out);
  const first = Array.isArray(j) ? j[0] : j;
  return { rows: first.results || [], rows_read: (first.meta && first.meta.rows_read) || 0 };
}

async function snapshot(args) {
  const season = args.season || "2026";
  const markers = args.markers ? JSON.parse(fs.readFileSync(args.markers, "utf8")) : null;
  const base = `https://www48.myfantasyleague.com/${season}/export`;
  const snap = { taken_at: new Date().toISOString(), league: PROD_LEAGUE };
  try {
    snap.mfl = {
      transactions: await getJson(`${base}?TYPE=transactions&L=${PROD_LEAGUE}&DAYS=${MFL_TX_DAYS}&JSON=1`),
      rosters: await getJson(`${base}?TYPE=rosters&L=${PROD_LEAGUE}&JSON=1`),
      salaries: await getJson(`${base}?TYPE=salaries&L=${PROD_LEAGUE}&JSON=1`),
    };
  } catch (e) { snap.mfl = { error: String((e && e.message) || e) }; }
  try {
    const since = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
    const gh = "https://api.github.com/repos/keithcreelman/upsmflproduction";
    snap.github = {
      commits: (await getJson(`${gh}/commits?sha=main&since=${since}&per_page=100`)).map((c) => ({ sha: c.sha, date: c.commit.author.date, message: c.commit.message.split("\n")[0] })),
      runs: ((await getJson(`${gh}/actions/runs?created=%3E%3D${since}&per_page=100`)).workflow_runs || []).map((r) => ({ id: r.id, name: r.name, event: r.event, created_at: r.created_at, head_sha: r.head_sha })),
    };
  } catch (e) { snap.github = { error: String((e && e.message) || e) }; }
  if (args["prod-d1"]) {
    if (!markers) throw new Error("--prod-d1 needs --markers (the scope of the content comparison)");
    const prior = args.before ? JSON.parse(fs.readFileSync(args.before, "utf8")) : null;
    let rowsRead = 0;
    const q = (sql) => { const r = d1(sql); rowsRead += r.rows_read; return r.rows; };
    snap.d1 = { tables: {}, small: {} };
    for (const t of D1_TABLES) {
      try {
        const cols = q(`PRAGMA table_info(${t})`).map((r) => r.name);
        const fpRow = q(`SELECT count(*) AS n, max(rowid) AS max, total(rowid) AS total FROM ${t}`)[0] || {};
        const entry = { fp: { n: Number(fpRow.n) || 0, max: Number(fpRow.max) || 0, total: Number(fpRow.total) || 0 } };
        const where = scopeWhere(cols, markers);
        if (where) { entry.scope_kind = "markers"; entry.scope_where = where; }
        else if (entry.fp.n <= FULL_TABLE_ROW_LIMIT) entry.scope_kind = "full";
        else entry.scope_kind = "none";
        if (entry.scope_kind !== "none") {
          const rows = q(`SELECT rowid AS _rowid, * FROM ${t}${where ? ` WHERE ${where}` : ""} ORDER BY rowid LIMIT ${FULL_TABLE_ROW_LIMIT + 1}`);
          entry.scope_truncated = rows.length > FULL_TABLE_ROW_LIMIT;
          entry.scoped_rows = rows.slice(0, FULL_TABLE_ROW_LIMIT);
        }
        const p = prior && prior.d1 && prior.d1.tables[t];
        if (p && !p.error) {
          const n = q(`SELECT rowid AS _rowid, * FROM ${t} WHERE rowid > ${Number(p.fp.max) || 0} ORDER BY rowid LIMIT ${NEW_ROW_LIMIT + 1}`);
          entry.new_rows_truncated = n.length > NEW_ROW_LIMIT;
          entry.new_rows = n.slice(0, NEW_ROW_LIMIT);
        } else entry.new_rows = [];
        snap.d1.tables[t] = entry;
      } catch (e) { snap.d1.tables[t] = { error: String((e && e.message) || e).split("\n")[0].slice(0, 160) }; }
    }
    for (const t of D1_SMALL_TABLES) {
      try { const r = q(`SELECT * FROM ${t}`); snap.d1.small[t] = { hash: hash(r), rows: r }; }
      catch (e) { snap.d1.small[t] = { error: String((e && e.message) || e).split("\n")[0].slice(0, 160) }; }
    }
    snap.d1.rows_read = rowsRead;
  }
  return snap;
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) { const k = argv[i].slice(2); const v = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true; out[k] = v; }
    else out._.push(argv[i]);
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];
  if (cmd === "snapshot") {
    if (!args.out) throw new Error("--out <file> is required");
    const snap = await snapshot(args);
    fs.writeFileSync(args.out, JSON.stringify(snap));
    console.log(`snapshot written: ${args.out}${snap.d1 ? ` (D1 rows_read ${snap.d1.rows_read})` : " (no D1: a compare will report incomplete evidence)"}`);
    return;
  }
  if (cmd === "compare") {
    const [b, a] = args._.slice(1).map((f) => JSON.parse(fs.readFileSync(f, "utf8")));
    const markers = args.markers ? JSON.parse(fs.readFileSync(args.markers, "utf8")) : {};
    const r = diffSnapshots(b, a, markers);
    console.log(JSON.stringify(r, null, 2));
    process.exit(r.untouched ? 0 : 2);
  }
  console.log("usage: snapshot --out f.json --markers m.json [--prod-d1 [--before before.json]] | compare before.json after.json --markers m.json");
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error(String((e && e.message) || e)); process.exit(1); });
