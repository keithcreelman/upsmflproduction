#!/usr/bin/env node
// Build the Stats → Pts Agst finished-season store. READ-ONLY on every source:
// MFL export GETs (league 74598) and D1 SELECTs through `wrangler d1 execute --remote`.
//
// For each finished season it reads exactly what the live engine reads, refuses a
// season that is not complete (every week 1..endWeek final, with posted scores),
// encodes it (worker/src/fpa_engine.js fpaStoreEncode), and proves the stored path
// answers every list window and every drill exactly as the live path does on the
// same inputs (fpa_store_harness.mjs). Only then does it write
//   worker/fpa_store/<FPA_ENGINE_VERSION>/<season>.json
// and remove other engine versions' folders. The worker ships that folder as static
// assets (wrangler.toml [assets], binding FPA_STORE); nothing is written to MFL, D1,
// KV or R2.
//
//   node pipelines/etl/scripts/build_fpa_season_store.mjs                  # 2017 .. last season
//   node pipelines/etl/scripts/build_fpa_season_store.mjs --seasons 2024,2025
//   node pipelines/etl/scripts/build_fpa_season_store.mjs --check          # re-read, compare with the committed files, write nothing
//   --wrangler-cwd <dir>   a directory whose wrangler.toml binds ups-mfl-db (default worker/)
//   --mfl-cache <dir>      keep MFL replies on disk (outside the repo) so a rerun after an
//                          MFL 429 doesn't read the same exports again
//
// Rebuild after any FPA_ENGINE_VERSION change (until then past seasons are computed
// live, as before) or if a finished season's MFL scores or nflverse rows are corrected.
import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";
import { fileURLToPath, pathToFileURL } from "url";
import * as F from "../../../worker/src/fpa_engine.js";
import { runBoth, sweepPaths } from "./fpa_store_harness.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
export const STORE_ROOT = path.join(ROOT, "worker", "fpa_store");
const LID = "74598";
const SNAP_GROUPS = new Set(["QB", "RB", "WR", "TE", "DL", "LB", "DB"]);   // K and P drills show no snaps

// ── sources (read-only) ──
// MFL throttles a client (IP + User-Agent) with HTTP 429 after roughly 100-150 reads in
// ten minutes (seen 2026-10-13), so reads go one at a time, 2 s apart, and a 429 backs off
// for minutes; a full 2017-2025 build reads ~320 exports. --mfl-cache
// <dir> keeps each reply on disk, so a rerun reads MFL only for what it hasn't got.
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
let mflQueue = Promise.resolve(), mflCache = null;
function getJson(u) {
  const run = async () => {
    const cf = mflCache ? path.join(mflCache, u.replace(/^https:\/\//, "").replace(/[^A-Za-z0-9]+/g, "_") + ".json") : null;
    if (cf && fs.existsSync(cf)) return JSON.parse(fs.readFileSync(cf, "utf8"));
    let last = null;
    for (let i = 0; i < 5; i++) {
      try {
        const r = await fetch(u, { method: "GET", headers: { "User-Agent": "ups-fpa-store-build (read-only)", Accept: "application/json" } });
        if (r.ok) {
          const t = await r.text(), j = JSON.parse(t);
          if (cf) fs.writeFileSync(cf, t);
          await sleep(2000); return j;
        }
        last = "HTTP " + r.status;
        await sleep(r.status === 429 ? 30000 * 2 ** i : 2000 * (i + 1));
      } catch (e) { last = String(e && e.message || e); await sleep(2000 * (i + 1)); }
    }
    console.error("  MFL read failed: " + u + " (" + last + ")");
    return null;
  };
  const p = mflQueue.then(run);
  mflQueue = p.catch(() => null);
  return p;
}
const SAFE = /^\s*(SELECT|WITH)\b/i, UNSAFE = /\b(INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER|PRAGMA|ATTACH|DETACH|VACUUM|REINDEX|BEGIN|COMMIT)\b/i;
function d1Runner(cwd) {
  const lit = (v) => {
    if (Number.isInteger(v)) return String(v);
    if (typeof v === "string") return "'" + v.replace(/'/g, "''") + "'";
    throw new Error("bind " + typeof v);
  };
  const inline = (sql, b) => { let i = 0; return sql.replace(/\?(\d+)?/g, (m, n) => lit(n ? b[Number(n) - 1] : b[i++])); };
  return function queryAll(sql, ...binds) {
    const q = inline(sql, binds);
    if (!SAFE.test(q) || UNSAFE.test(q)) throw new Error("refused: only SELECT is allowed here");
    for (let i = 0; ; i++) {
      try {
        const out = execFileSync("npx", ["--yes", "wrangler@4.87.0", "d1", "execute", "ups-mfl-db", "--remote", "--json", "--command", q],
          { cwd, maxBuffer: 1 << 29, stdio: ["ignore", "pipe", "pipe"] }).toString();
        return JSON.parse(out)[0].results;
      } catch (e) {
        if (i >= 3) throw e;
        execFileSync("sleep", [String(3 * (i + 1))]);
      }
    }
  };
}

// ── file format: one line per player / week / snap record, so a rebuild diffs readably ──
export function serialize(s) {
  const J = JSON.stringify, head = {};
  for (const k of Object.keys(s)) if (!["players", "sched", "scores", "ctx", "snaps"].includes(k)) head[k] = s[k];
  const obj = (o) => "{\n" + Object.keys(o).map((k) => J(k) + ":" + J(o[k])).join(",\n") + "\n}";
  let t = J(head).slice(0, -1) + ',\n"players":[\n' + s.players.map((p) => J(p)).join(",\n") + "\n],\n";
  t += '"sched":' + obj(s.sched) + ',\n"scores":' + obj(s.scores) + ',\n"ctx":' + J(s.ctx) + ',\n"snaps":';
  t += s.snaps ? '{"ids":' + J(s.snaps.ids) + ',\n"wk":' + obj(s.snaps.wk) + "}" : "null";
  t += "\n}\n";
  if (J(JSON.parse(t)) !== J(s)) throw new Error("serialize: round trip differs");
  return t;
}

// Read one season the way the live engine does. Returns { raw, rec, mfl, ctx }.
export async function readSeason(yr, { queryAll, nowMs, idRowsAll }) {
  const raw = { league: null, players: null, sched: {}, scores: {} };
  const fetchJson = async (u) => {
    const j = await getJson(u);
    const q = new URL(u).searchParams, T = q.get("TYPE"), w = parseInt(q.get("W"), 10);
    if (T === "league") raw.league = j; else if (T === "players") raw.players = j;
    else if (T === "nflSchedule") raw.sched[w] = j; else if (T === "playerScores") raw.scores[w] = j;
    return j;
  };
  const mfl = await F.fpaLoadMfl({ yr: String(yr), wMin: 1, wMax: 99, lid: LID, fetchJson, nowMs, currentSeason: false });
  const rec = { teamRows: null, playRows: null, paceRows: null, idRows: idRowsAll, snapRows: null };
  const recQuery = async (sql, ...b) => {
    const rows = queryAll(sql, ...b);
    if (/^WITH pw AS \(/.test(sql)) rec.teamRows = rows; else if (/^SELECT week, team, SUM\(/.test(sql)) rec.playRows = rows; else rec.paceRows = rows;
    return rows;
  };
  const ctx = await F.fpaLoadSeasonContext(recQuery, String(yr));
  // The drill's snap read covers the season's weeks; the encoder keeps the rows of
  // players a drill can list (exact pfr match, as the live IN query does).
  rec.snapRows = queryAll("SELECT pfr_id, week, off_snaps, def_snaps FROM nfl_player_snaps WHERE season = ?1 AND week BETWEEN 1 AND ?2", Number(yr), mfl.endWeek);
  return { raw, rec, mfl, ctx };
}

// Is the season complete by the engine's own rule? { ok, why }
export function seasonComplete(mfl, ctx, nowMs) {
  const E = F.fpaCompute(mfl, ctx, { wMin: 1, wMax: mfl.endWeek, nowMs, baseline: F.FPA_BASELINE });
  const facts = F.fpaSeasonFacts(E), ws = F.fpaWeekStates(mfl, nowMs);
  const notFinal = Object.keys(ws.weekState).filter((w) => ws.weekState[w] !== "final");
  const ok = facts.seasonState === "complete" && ws.lastComplete === mfl.endWeek && !notFinal.length;
  const pending = facts.pending.map((g) => "W" + g.wk + " " + g.away + "@" + g.home + " " + g.status);
  return { ok, why: ok ? "" : "state " + facts.seasonState + ", weeks not final: " + notFinal.join(",") + (pending.length ? " (" + pending.join("; ") + ")" : ""), teams: Object.keys(E.teamsAll).sort() };
}

export function encodeSeason(yr, { raw, rec, mfl, ctx }, { nowMs, builtAtMs }) {
  const pInfo = F.fpaPlayerIndex(mfl.players), snapPids = new Set();
  for (const w in mfl.scoresByWeek) for (const s of mfl.scoresByWeek[w]) {
    const id = typeof s.id === "string" ? s.id : String(s.id).trim(), i = pInfo.get(id);
    if (i && SNAP_GROUPS.has(i.grp) && !isNaN(parseFloat(s.score))) snapPids.add(id);
  }
  return F.fpaStoreEncode({ yr: String(yr), lid: LID, endWeek: mfl.endWeek, raw, ctx, readAtMs: nowMs, builtAtMs,
    snapPids: [...snapPids].sort(), idRows: rec.idRows, snapRows: rec.snapRows });
}

// The self-check: every list window and every drill, live vs stored, on these inputs.
export async function proveSeason(yr, season, store, text, { nowMs, teams, allDrillWindows, onDiff }) {
  F.fpaStoreForget();
  const files = { [F.fpaStorePath(yr)]: text };
  const { list, drill } = sweepPaths(yr, store.endWeek, teams, { allDrillWindows });
  const out = { list: 0, drill: 0, diff: 0, storedReadsMfl: 0, storedReadsD1: 0, notStored: 0 };
  for (const [kind, paths] of [["list", list], ["drill", drill]]) {
    for (const p of paths) {
      const r = await runBoth(p, { raw: season.raw, rec: season.rec, files, nowMs, lid: LID });
      out[kind]++;
      if (r.mflReads) out.storedReadsMfl++;
      if (r.d1Reads) out.storedReadsD1++;
      if (r.storedSource !== "stored") out.notStored++;
      if (!r.same) { out.diff++; if (onDiff) onDiff(p, r); }
    }
  }
  return out;
}

async function main() {
  const args = process.argv.slice(2);
  const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
  const check = args.includes("--check");
  const nowMs = Date.now(), cur = F.fpaCurrentSeason(nowMs);
  let seasons = [];
  const sv = opt("--seasons");
  if (sv) for (const part of sv.split(",")) { const [a, b] = part.split("-").map(Number); for (let y = a; y <= (b || a); y++) seasons.push(y); }
  else for (let y = 2017; y < cur; y++) seasons.push(y);
  const queryAll = d1Runner(path.resolve(opt("--wrangler-cwd") || path.join(ROOT, "worker")));
  if (opt("--mfl-cache")) { mflCache = path.resolve(opt("--mfl-cache")); fs.mkdirSync(mflCache, { recursive: true }); }
  const dir = path.join(STORE_ROOT, F.FPA_ENGINE_VERSION);
  console.log(`engine ${F.FPA_ENGINE_VERSION} · current season ${cur} · ${check ? "CHECK (no writes)" : "write " + path.relative(ROOT, dir)}`);
  const idRowsAll = queryAll("SELECT mfl_id, pfr_id FROM ff_player_ids");
  const rows = [];
  let failed = 0;
  for (const yr of seasons) {
    if (yr >= cur) { console.log(`${yr}: REFUSED — not a finished season (current season is ${cur})`); failed++; continue; }
    let season;
    try { season = await readSeason(yr, { queryAll, nowMs, idRowsAll }); }
    catch (e) { console.log(`${yr}: NOT STORED — could not read it (${e && e.message || e}); nothing written`); failed++; continue; }
    const done = seasonComplete(season.mfl, season.ctx, nowMs);
    if (!done.ok) { console.log(`${yr}: NOT STORED — ${done.why}`); failed++; continue; }
    const store = encodeSeason(yr, season, { nowMs, builtAtMs: nowMs });
    const text = serialize(store);
    const proof = await proveSeason(String(yr), season, store, text, { nowMs, teams: done.teams, allDrillWindows: true,
      onDiff: (p, r) => console.log("  DIFF " + p + " status " + r.status.join("/")) });
    const bad = proof.diff || proof.storedReadsMfl || proof.storedReadsD1 || proof.notStored;
    const file = path.join(dir, yr + ".json");
    let drift = "";
    if (check) {
      const old = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
      const strip = (s) => { const c = { ...s }; delete c.readAtMs; delete c.builtAt; return JSON.stringify(c); };
      drift = !old ? "no committed file" : (strip(old) === strip(store) ? "same as committed" : "DIFFERS from committed");
    }
    rows.push({ yr, endWeek: store.endWeek, players: store.players.length, scoreRows: Object.values(store.scores).reduce((a, x) => a + x.length, 0),
      kb: Math.round(text.length / 1024), list: proof.list, drill: proof.drill, diff: proof.diff, drift });
    console.log(`${yr}: ${bad ? "FAILED self-check" : "ok"} · ${store.players.length} players · ${rows[rows.length - 1].scoreRows} score rows · ${rows[rows.length - 1].kb} KB · list ${proof.list} + drill ${proof.drill} answers, ${proof.diff} differ; stored path read MFL ${proof.storedReadsMfl}×, D1 ${proof.storedReadsD1}×${drift ? " · " + drift : ""}`);
    if (bad) { failed++; continue; }
    if (!check) { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(file, text); }
  }
  if (!check && fs.existsSync(STORE_ROOT)) {
    // Only Pts Agst engine folders (fpa*): the Player Stats store lives beside them (lb1/, #1266).
    for (const d of fs.readdirSync(STORE_ROOT)) if (d !== F.FPA_ENGINE_VERSION && /^fpa/.test(d) && fs.statSync(path.join(STORE_ROOT, d)).isDirectory()) {
      fs.rmSync(path.join(STORE_ROOT, d), { recursive: true }); console.log("removed old engine folder " + d);
    }
  }
  console.table(rows);
  process.exit(failed ? 1 : 0);
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) main().catch((e) => { console.error(e); process.exit(1); });
