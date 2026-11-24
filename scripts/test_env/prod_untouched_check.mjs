#!/usr/bin/env node
// Production-untouched check for a connected test (#1475). READ-ONLY.
//
// Takes a snapshot of production BEFORE and AFTER one test operation, then compares record CONTENTS
// (not just counts) and names any production activity associated with the test operation.
//
//   node scripts/test_env/prod_untouched_check.mjs snapshot --out before.json [--prod-d1]
//   ...run the approved test operation...
//   node scripts/test_env/prod_untouched_check.mjs snapshot --out after.json  [--prod-d1]
//   node scripts/test_env/prod_untouched_check.mjs compare before.json after.json --markers markers.json
//
// What a snapshot reads:
//   - MFL league 74598 PUBLIC exports (no cookie): transactions, rosters, salaries. Every record is kept
//     with a content hash, so a changed record is found even when the count is unchanged.
//   - GitHub (public API, no token): commits on main and workflow runs in the window, which is where a
//     contract-log dispatch or a trade-offer file commit would show up.
//   - Production D1, ONLY with --prod-d1 (explicit opt-in; never in tests or CI). Per table, the
//     highest rowid (1 row read each) plus the full content of the small global tables (ups_settings,
//     ups_runtime_flags). The AFTER snapshot also reads every row above the BEFORE rowid, so the new rows'
//     contents can be compared. Measured cost is printed (rows_read from wrangler's meta).
//
// Discord cannot be read here (no bot token, by design). The test worker's own egress log
// (ups_test_egress_log in the TEST database) records every Discord call it refused or allowed; the
// production channels are checked by eye for the window (TEST_ENVIRONMENT.md section 7).
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
  // per-league records an add/drop, lineup or contract action could touch
  "ups_transactions", "ups_add_events", "ups_drop_events", "salary_change_log", "ups_lineup_submissions",
  "ups_tag_submissions", "ups_extension_submissions", "ups_restructure_submissions", "ups_mym_submissions",
  "ups_taxi_callups", "ups_ir_roster_status", "twb_trade_outbox", "trade_offer_dm", "ups_trade_executions",
  // global, league-less state a misrouted test could change
  "league_events", "ups_bot_heartbeat",
];
export const D1_SMALL_TABLES = ["ups_settings", "ups_runtime_flags"];

const arr = (x) => (x == null ? [] : Array.isArray(x) ? x : [x]);
export const hash = (v) => crypto.createHash("sha256").update(typeof v === "string" ? v : JSON.stringify(v)).digest("hex").slice(0, 16);

// Index MFL exports by a stable record key, value = { hash, record }.
export function indexMfl(exports) {
  const tx = {}, rosters = {}, salaries = {};
  for (const t of arr(exports.transactions && exports.transactions.transactions && exports.transactions.transactions.transaction)) {
    const key = `${t.timestamp}|${t.type}|${t.franchise || ""}|${t.transaction || ""}`;
    tx[key] = { hash: hash(t), record: t };
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
  for (const id of markers.player_ids || []) if (new RegExp(`(^|[^0-9])${id}([^0-9]|$)`).test(text)) hits.push(`player ${id}`);
  if (markers.idempotency_key && text.includes(markers.idempotency_key)) hits.push("idempotency key");
  if (markers.test_league && new RegExp(`(^|[^0-9])${markers.test_league}([^0-9]|$)`).test(text)) hits.push(`league ${markers.test_league}`);
  if (/\bTEST\b|\[TEST|ups-test|ups_test/i.test(text)) hits.push("test label");
  return hits;
}

// before/after: snapshots. Returns every production change in the window and which of them are
// ASSOCIATED with the test operation (mention a test player, the idempotency key, the test league or
// a test label). untouched = no associated change anywhere and nothing unreadable.
export function diffSnapshots(before, after, markers) {
  const findings = [], unrelated = [], gaps = [];
  const ws = Date.parse(markers.window_start_utc || before.taken_at), we = Date.parse(markers.window_end_utc || after.taken_at);
  const inWindow = (unixSec) => { const ms = Number(unixSec) * 1000; return ms >= ws - 60000 && ms <= we + 60000; };
  const note = (area, what, record, hits) => (hits.length ? findings : unrelated).push({ area, what, associated_with: hits, record });

  if (!before.mfl || !after.mfl) gaps.push("MFL snapshot missing");
  else {
    const b = indexMfl(before.mfl), a = indexMfl(after.mfl);
    for (const [k, v] of Object.entries(a.tx)) if (!b.tx[k] && inWindow(v.record.timestamp)) note("mfl_74598_transactions", `new ${v.record.type} ${v.record.franchise || ""}`, v.record, mentions(v.record, markers));
    for (const k of Object.keys(b.tx)) if (!a.tx[k]) note("mfl_74598_transactions", "a transaction disappeared", b.tx[k].record, ["record removed"]);
    for (const [fid, v] of Object.entries(a.rosters)) {
      const old = b.rosters[fid];
      if (!old) { note("mfl_74598_rosters", `new franchise ${fid}`, v.record, ["unexpected franchise"]); continue; }
      if (old.hash !== v.hash) {
        const added = v.record.filter((x) => !old.record.includes(x)), removed = old.record.filter((x) => !v.record.includes(x));
        note("mfl_74598_rosters", `franchise ${fid} changed`, { added, removed }, mentions({ added, removed }, markers).concat((markers.franchise_ids || []).includes(fid) ? [`test franchise ${fid}`] : []));
      }
    }
    for (const [pid, v] of Object.entries(a.salaries)) {
      const old = b.salaries[pid];
      if (!old || old.hash !== v.hash) note("mfl_74598_salaries", `player ${pid} ${old ? "changed" : "added"}`, { before: old && old.record, after: v.record }, mentions({ pid, after: v.record }, markers));
    }
    for (const pid of Object.keys(b.salaries)) if (!a.salaries[pid]) note("mfl_74598_salaries", `player ${pid} removed`, b.salaries[pid].record, mentions({ pid }, markers));
  }

  if (!after.github) gaps.push("GitHub snapshot missing");
  else {
    const seen = new Set(arr(before.github && before.github.commits).map((c) => c.sha));
    for (const c of arr(after.github.commits)) if (!seen.has(c.sha)) note("github_commits", `commit ${c.sha.slice(0, 8)}`, c, mentions(c, markers));
    const seenRuns = new Set(arr(before.github && before.github.runs).map((r) => r.id));
    for (const r of arr(after.github.runs)) if (!seenRuns.has(r.id)) note("github_workflow_runs", `${r.event} ${r.name}`, r, mentions(r, markers).concat(r.event === "repository_dispatch" ? ["repository_dispatch in the window"] : []));
  }

  if (before.d1 && after.d1) {
    for (const [table, v] of Object.entries(after.d1.tables || {})) {
      const old = (before.d1.tables || {})[table];
      if (!old) { gaps.push(`D1 ${table}: no BEFORE value`); continue; }
      if (v.error || old.error) { gaps.push(`D1 ${table}: ${v.error || old.error}`); continue; }
      for (const row of arr(v.new_rows)) note(`d1_${table}`, "new row", row, mentions(row, markers));
      if (v.max_rowid < old.max_rowid) note(`d1_${table}`, "rows deleted (max rowid fell)", { before: old.max_rowid, after: v.max_rowid }, ["rows removed"]);
    }
    for (const [table, v] of Object.entries(after.d1.small || {})) {
      const old = (before.d1.small || {})[table];
      if (!old || old.hash !== v.hash) note(`d1_${table}`, "global setting content changed", { before: old && old.rows, after: v.rows }, ["global state changed in the window"]);
    }
  } else gaps.push("production D1 not compared (run both snapshots with --prod-d1 to include it)");

  return { untouched: findings.length === 0 && !gaps.some((g) => /missing|no BEFORE|error/i.test(g)), associated: findings, unrelated_production_activity: unrelated, gaps };
}

// ── network side (CLI only) ─────────────────────────────────────────────────────────────────────
async function getJson(url) {
  if (/myfantasyleague\.com/.test(url) && !url.includes(`L=${PROD_LEAGUE}`) && !/TYPE=players/.test(url)) throw new Error("production check reads league 74598 only");
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
  const base = `https://www48.myfantasyleague.com/${season}/export`;
  const snap = { taken_at: new Date().toISOString(), league: PROD_LEAGUE };
  snap.mfl = {
    transactions: await getJson(`${base}?TYPE=transactions&L=${PROD_LEAGUE}&DAYS=7&JSON=1`),
    rosters: await getJson(`${base}?TYPE=rosters&L=${PROD_LEAGUE}&JSON=1`),
    salaries: await getJson(`${base}?TYPE=salaries&L=${PROD_LEAGUE}&JSON=1`),
  };
  const since = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
  const gh = "https://api.github.com/repos/keithcreelman/upsmflproduction";
  snap.github = {
    commits: (await getJson(`${gh}/commits?sha=main&since=${since}&per_page=50`)).map((c) => ({ sha: c.sha, date: c.commit.author.date, message: c.commit.message.split("\n")[0] })),
    runs: ((await getJson(`${gh}/actions/runs?created=%3E%3D${since}&per_page=50`)).workflow_runs || []).map((r) => ({ id: r.id, name: r.name, event: r.event, created_at: r.created_at, head_sha: r.head_sha })),
  };
  if (args["prod-d1"]) {
    const before = args.before ? JSON.parse(fs.readFileSync(args.before, "utf8")) : null;
    let rowsRead = 0;
    snap.d1 = { tables: {}, small: {} };
    for (const t of D1_TABLES) {
      try {
        const m = d1(`SELECT max(rowid) AS m FROM ${t}`); rowsRead += m.rows_read;
        const entry = { max_rowid: Number(m.rows[0] && m.rows[0].m) || 0 };
        const prior = before && before.d1 && before.d1.tables[t];
        if (prior && !prior.error) { const n = d1(`SELECT rowid AS _rowid, * FROM ${t} WHERE rowid > ${Number(prior.max_rowid) || 0} ORDER BY rowid LIMIT 500`); rowsRead += n.rows_read; entry.new_rows = n.rows; }
        snap.d1.tables[t] = entry;
      } catch (e) { snap.d1.tables[t] = { error: String((e && e.message) || e).split("\n")[0].slice(0, 160) }; }
    }
    for (const t of D1_SMALL_TABLES) {
      try { const r = d1(`SELECT * FROM ${t}`); rowsRead += r.rows_read; snap.d1.small[t] = { hash: hash(r.rows), rows: r.rows }; }
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
    console.log(`snapshot written: ${args.out} (${Object.keys(snap.mfl).length} MFL exports${snap.d1 ? `, D1 rows_read ${snap.d1.rows_read}` : ", no D1"})`);
    return;
  }
  if (cmd === "compare") {
    const [b, a] = args._.slice(1).map((f) => JSON.parse(fs.readFileSync(f, "utf8")));
    const markers = args.markers ? JSON.parse(fs.readFileSync(args.markers, "utf8")) : {};
    const r = diffSnapshots(b, a, markers);
    console.log(JSON.stringify(r, null, 2));
    process.exit(r.untouched ? 0 : 2);
  }
  console.log("usage: snapshot --out f.json [--prod-d1 [--before before.json]] | compare before.json after.json --markers m.json");
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error(String((e && e.message) || e)); process.exit(1); });
