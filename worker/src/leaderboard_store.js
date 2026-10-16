// Finished-season leaderboard store (#1266, DRAFT — Keith reviews the comparison and preview
// before any of this merges or deploys).
//
// A finished season's Player Stats board never changes, yet computing it live reads ~0.3M D1
// rows per board and window (after #1313; ~17M before). Every finished season 2011-2025 x every
// board x every preset window is built ONCE, offline, by running this worker's own route over a
// copy of that season's rows (pipelines/etl/scripts/build_leaderboard_season_store.mjs), and
// shipped as gzip files in the worker's static assets (worker/fpa_store/lb1/..., the FPA_STORE
// binding the Sched store already uses). Serving one costs 0 D1 rows.
//
// The rules (Keith 2026-10-15):
//   * every eligible player — no 500-row cap; a stored board is served WHOLE (next_offset null);
//   * each file records its calculation version, season, board, window, build time and checksum;
//   * a finished-season view whose stored copy is missing, corrupt or the wrong version FAILS
//     VISIBLY (503 with the reason) — it never falls back to the live query;
//   * the current season stays live (it is never in LB_STORE.seasons).
//
// What is NOT stored: the six fields that describe today rather than the season (MFL owner,
// contract, current NFL team). Both clients already overlay those from live MFL data.

// The store this code serves. LB_STORE.query_version is the SHA-256 (first 16 hex) of the
// leaderboard SQL template in index.js; tests/leaderboard_store.test.mjs recomputes it, so a SQL
// change without a store rebuild fails CI instead of serving boards the new SQL wouldn't give.
export const LB_STORE = {
  format: 1,
  query_version: "6b8fbdf84c3e8a17",
  firstSeason: 2011,
  lastSeason: 2025,
  boards: ["qb", "skill", "idp", "kicker", "punter"],
  // The Stats page's preset windows (MFL Total, MFL Reg, MFL Playoffs, Full + NFL playoffs).
  // Mobile sends no week params: its board is week <= 17, the same rows as 1-17.
  windows: [[1, 17], [1, 14], [15, 17], [1, 22]],
};
export const LB_STORE_VOLATILE = ["current_team", "mfl_franchise_id", "mfl_franchise_name", "mfl_salary", "mfl_aav", "mfl_years_remaining"];

export const lbStoreDir = (s = LB_STORE) => `lb${s.format}/${s.query_version}`;
export const lbStoreFile = (season, board, lo, hi) => `${season}/${board}_${lo}-${hi}.json.gz`;

// Which requests the store answers: ONE season inside LB_STORE's range, a stored board, a preset
// window (or no week params = 1-17), and nothing the stored board can't reproduce exactly
// (a week list, a team filter, min_games > 1, include_post, an explicit live rebuild).
// Returns { season, board, lo, hi } or null (null = not a stored view; the caller runs as before).
export function lbStoreRequest(p, s = LB_STORE) {
  if (!p || p.noPrecompute) return null;
  if (!Array.isArray(p.seasons) || p.seasons.length !== 1) return null;
  const season = Number(p.seasons[0]);
  if (!(season >= s.firstSeason && season <= s.lastSeason)) return null;
  if (s.boards.indexOf(p.pos) < 0) return null;
  if (p.weeksParam || p.teamFilter || p.includePost || Number(p.minGames) !== 1) return null;
  const has = (v) => Number.isFinite(v);
  const lo = has(p.weekMin) ? Math.max(1, p.weekMin) : 1;
  const hi = has(p.weekMax) ? Math.min(22, p.weekMax) : (has(p.weekMin) ? 22 : 17);
  if (!s.windows.some(([a, b]) => a === lo && b === hi)) return null;
  return { season, board: p.pos, lo, hi };
}

// Why a manifest can't be used for this code (null = usable).
export function lbManifestProblem(m, s = LB_STORE) {
  if (!m || typeof m !== "object") return "manifest unreadable";
  if (m.format !== s.format) return `format ${m.format} (this worker reads ${s.format})`;
  if (m.query_version !== s.query_version) return `built by query ${m.query_version} (this worker runs ${s.query_version})`;
  if (!m.files || typeof m.files !== "object") return "manifest lists no files";
  return null;
}

const hex = (buf) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
// One manifest read per isolate and binding; a failure is not remembered (the next request retries).
let manifestMemo = new WeakMap();   // FPA_STORE binding -> { dir, manifest }
export function _resetLbStoreMemo() { manifestMemo = new WeakMap(); }

async function readManifest(env, s) {
  const dir = lbStoreDir(s);
  const bin = env && env.FPA_STORE;
  if (!bin || typeof bin.fetch !== "function") return { problem: "the store isn't bound to this worker" };
  const memo = manifestMemo.get(bin);
  if (memo && memo.dir === dir) return { manifest: memo.manifest };
  let r;
  try { r = await bin.fetch(new Request(`https://fpa-store.local/${dir}/manifest.json`)); } catch (e) { return { problem: "manifest read failed" }; }
  if (!r || !r.ok) return { problem: `manifest missing (HTTP ${r ? r.status : "?"})` };
  let m;
  try { m = await r.json(); } catch (_) { return { problem: "manifest unreadable" }; }
  const why = lbManifestProblem(m, s);
  if (why) return { problem: why };
  manifestMemo.set(bin, { dir, manifest: m });
  return { manifest: m };
}

const unavailable = (key, reason, s, corsHeaders) => new Response(JSON.stringify({
  ok: false, error: "stored_board_unavailable", reason,
  season: key.season, pos: key.board, window: { week_min: key.lo, week_max: key.hi }, store: lbStoreDir(s),
  note: "This finished season is served only from its stored copy, and that copy can't be used, so nothing is shown rather than a different computation.",
}), { status: 503, headers: { "content-type": "application/json", "Cache-Control": "no-store", ...(corsHeaders || {}) } });

// Serve one stored board: the gzip bytes exactly as built, after checking them against the
// manifest's SHA-256. Every failure is a visible 503 naming the reason.
export async function lbServeStored(env, key, opts = {}) {
  const s = opts.store || LB_STORE;
  const { manifest, problem } = await readManifest(env, s);
  if (problem) return unavailable(key, problem, s, opts.corsHeaders);
  const name = lbStoreFile(key.season, key.board, key.lo, key.hi);
  const entry = manifest.files[name];
  if (!entry || !entry.sha256_gz) return unavailable(key, `${name} isn't in the manifest`, s, opts.corsHeaders);
  let bytes;
  try {
    const r = await env.FPA_STORE.fetch(new Request(`https://fpa-store.local/${lbStoreDir(s)}/${name}`));
    if (!r || !r.ok) return unavailable(key, `${name} missing (HTTP ${r ? r.status : "?"})`, s, opts.corsHeaders);
    bytes = await r.arrayBuffer();
  } catch (_) { return unavailable(key, `${name} read failed`, s, opts.corsHeaders); }
  const sha = hex(await crypto.subtle.digest("SHA-256", bytes));
  if (sha !== entry.sha256_gz) return unavailable(key, `${name} checksum mismatch`, s, opts.corsHeaders);
  return new Response(bytes, {
    status: 200,
    encodeBody: "manual",
    headers: {
      "content-type": "application/json", "content-encoding": "gzip",
      // An hour: a rebuild (new query_version) changes what this URL answers.
      "Cache-Control": "public, max-age=3600",
      "X-UPS-Store": `${lbStoreDir(s)}/${name}`, "X-UPS-Store-Built": String(entry.built_at_utc || ""),
      ...(opts.corsHeaders || {}),
    },
  });
}
