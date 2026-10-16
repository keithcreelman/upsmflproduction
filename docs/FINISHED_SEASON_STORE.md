# Finished-season Player Stats store (#1266) — delivery comparison

**Status:** DRAFT for Keith's review (2026-10-15). Nothing is merged or deployed. The 300 store files
are not committed until a delivery method is chosen; the preview serves the full build.

## What is stored
Every finished season **2011–2025** × board (QB, RB/WR/TE, IDP, K, P) × preset window
(MFL Total Wks 1–17, MFL Reg 1–14, MFL Playoffs 15–17, Full + NFL playoffs 1–22): **300 boards,
91,126 player rows**. Every eligible player — 89 boards are over the old 500-row cap (largest 1,059).

Each board is the leaderboard route's own answer for the whole board, built offline by running this
worker's real route over a copy of that season's rows
(`pipelines/etl/scripts/build_leaderboard_season_store.mjs`), and records:
calculation version (`query_version`, SHA-256 of the leaderboard code), season, board, window,
build time, row count, the rows' SHA-256, the MFL-scores fingerprint and per-table input
fingerprints. The manifest records each gzip file's SHA-256.

Left out: the six fields that describe **today** (MFL owner, contract, current NFL team). Both
clients already overlay them from live MFL data.

Size: 96.8 MB of JSON → **6.97 MB gzip** (345 KB for 2011 … 576 KB for 2025; largest file 74 KB).

## The options (measured 2026-10-15)
Latency: median of the 20 boards of 2025 from one Mac, connection reused like a browser (the first
round, then two repeat rounds). Server read = time to read the stored bytes inside the worker.

| | **A. Files with the worker** (static assets) | **B. D1 rows** (one compact blob per board) | **C. R2 objects** (existing mechanism: R2) | **D. Static site** (existing mechanism: GitHub Pages; timed on a Pages preview) |
|---|---|---|---|---|
| Deployed size | 300 files, 6.97 MB gzip + 0.1 MB manifest; worker script unchanged (3.81 MB / 0.88 MB gzip vs 3.80 / 0.87 today) | 300 rows, 6.97 MB as BLOB (9.3 MB as base64 text); D1 391 → ~398 MB | 300 objects, 6.97 MB | 96.8 MB JSON (or 6.97 MB gzip) in `site/` |
| Fits the limits | Yes: 310 asset files of 20,000 (Free) / 100,000 (Paid); 74 KB of 25 MiB per file; assets don't count toward the 64 MiB script limit | Yes: 74 KB of the 2 MB row limit; **Free D1 database cap is 500 MB** (398 MB after) | Yes | Yes: GitHub Pages 1 GB site, ~100 GB/month soft bandwidth |
| D1 rows per owner action | **0** | 1 | 0 | 0 |
| Other cost per action | none (asset reads are free; the API request is one Worker request, as today) | 1 row read | 1 R2 Class B read (10M/month free) | none (no Worker request at all) |
| Build/regeneration cost | 0 D1 writes; deploy uploads changed files | 300 D1 rows written per full build (+ index) — a production write | 300 R2 Class A writes — a production write | 0 D1 |
| CPU per stored answer (warm) | **~1 ms** (no JSON parse; SHA-256 of ≤74 KB) | 9–15 ms (base64; a BLOB would be less) | 1–2 ms | — |
| Server read | **6–12 ms** | 100–114 ms | 216–343 ms | — |
| First / repeat load | **186 / 153 ms** | 238 / 250 ms | 372 / 318 ms | **91 / 77 ms** |
| Browser-cached load | instant (1 h) | instant (1 h) | instant (1 h) | instant |
| Repository growth | ~7.0 MB per full build; one season 0.35–0.58 MB | 0 | 0 | ~7–8 MB per build (git compresses JSON); 96.8 MB checkout |
| Code and store ship together | **Yes** (same deploy) | No (rows written separately) | No | No (site deploy ≠ worker deploy) |
| Missing / corrupt / wrong version | 503 with the reason, never the live query (tested; preview demo) | same check, in the worker | same check, in the worker | each client (mobile, desktop-in-MFL) must check itself |

For reference, the live query after #1313: ~1.0–1.2 s and 0.23–0.38M D1 rows per board.

## Recommendation: A — compressed, immutable files with the worker
It meets the stated preference without inflating the worker: the script is unchanged and the store
is static assets, far inside every limit. Zero D1 reads or writes, ~1 ms CPU (inside the Free plan's
10 ms), one place that validates every read, and the store can never be out of step with the code
that reads it, because both ship in the same deploy. The cost is ~7 MB of repository growth per full
rebuild (rare: a leaderboard code change or a corrected season). D (static site) is faster to the
client but moves validation into two clients and can drift from the worker; B and C need production
writes on every rebuild and can drift too.

## Behavior
- **Served from the store:** one season 2011–2025, a stored board, a preset window (or no week
  params = the phone's request), no week list / team filter / min_games > 1 / include_post.
  The whole board in one answer (`next_offset: null`); a later page is the empty last page.
  0 D1 queries; served ahead of the edge cache, so no cached answer stands in for it.
- **Fails visibly:** a missing manifest or file, a checksum mismatch, a store built by other code
  (`query_version`), or an unbound store → `503 {error: "stored_board_unavailable", reason}`,
  `Cache-Control: no-store`. Mobile Stats shows "The stored <season> stats couldn't be read (reason)";
  the desktop page shows its load error. Never the live query.
- **Unchanged:** the current season (stored board / live, as today), custom week ranges, team
  filters, two or more seasons — live, now ~0.3M rows per season after #1313.
- **Phone = desktop:** the phone's request (`season=Y&pos=P&min_games=1`) and the desktop's
  (`seasons=Y&week_min=1&week_max=17…`) get the same bytes (test + builder self-check).

## Regenerating a season
```
node pipelines/etl/scripts/build_leaderboard_season_store.mjs --replica-dir ~/ups-lb-replicas --refresh --seasons 2019
```
reads that season's rows from D1 (SELECT only; ~43–80k rows), runs the route, serves every file
back through the stored path and requires the live answer byte for byte, then rewrites the files and
the manifest. Commit, PR, merge → the worker deploy ships it. After any change to the leaderboard
code, `tests/leaderboard_store.test.mjs` fails until `LB_STORE.query_version` is updated and every
season rebuilt — until then those seasons answer 503 rather than a board the code wouldn't give.

## Proof
- Builder self-check: all 300 files served back through the worker's stored path equal the live
  route's rows; the phone and desktop requests get identical bytes (every season, Wks 1–17).
- Production: stored boards equal production's own live answers (cache bypassed) for 2015 QB
  Wks 1–14 (68 rows), 2019 K Wks 15–17 (34) and 2022 RB/WR/TE Wks 1–22 (537, two pages).
- Tests: `tests/leaderboard_store.test.mjs` (7 tests, 71 assertions); mobile failure note in
  `tests/mobile_stats_players_review.test.mjs`. Mutations: 10/10 caught.
