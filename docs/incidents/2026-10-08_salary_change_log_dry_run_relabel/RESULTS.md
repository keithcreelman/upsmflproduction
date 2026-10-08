# Relabel results: APPLIED 2026-10-08 (Keith approved: all 27, Tier B included)

| Step | When (UTC) | Result |
|---|---|---|
| Writer fix live | 14:09:53 | #1192 merged as `06a534d9`; deploy run 37790141773 uploaded version `583a78cf-1a4e-4687-89d9-a4bbd206e1c6`, at 100%. A local build of the same tree is byte-for-byte the same size (3524.08 KiB / gzip 800.38 KiB) and contains both fixes. No production probe was sent. |
| No new audit rows | 14:12 | none since the deploy; 27 rows with the false label; highest id 1876 |
| **D1 restore point** | 14:12:59 | Time Travel bookmark `0000ec92-00000598-000050fe-382c3d1f0eb862745a59573931f2993f` |
| `01_verify_before.sql` | 14:13 | all 27 rows `in_original_state = 1`, `audit_records = 0`; the whole table holds exactly these 27 |
| `02_apply_tier_a.sql` | 14:14:10 | D1 reported `changes 45`: 22 audit inserts (ids 121–142), 22 updates, and 1 internal count (Tier B shows the same +1). Every Tier A row changed exactly `dry_run`, `landed` and `notes`; Tier B and 1865/1875 untouched; 5 labels left |
| `03_apply_tier_b.sql` | 14:15:39 | `changes 11`: 5 audit inserts (ids 143–147), 5 updates, and 1 internal count |
| `04_verify_after.sql` (final) | 14:16 | (1) all 27 `dry_run 1`, `landed 0`; (2) `n 27`, `dupes 0`; (3) 0 rows with any other column changed; (4) **0** rows left with the false label; (5) 1865 and 1875 still `0 / 1 / 200` |
| Row-by-row comparison with the saved before-state | 14:16 | the 27 rows differ in exactly `dry_run`, `landed` and `notes`; each audit record's `before_val` equals the complete original row |

## Each row

For **every** row: **before** `dry_run 0`, `landed 1`, `import_status 0`, `notes = import_ok_log_dispatched`. **After:** `dry_run 1`, `landed 0`, `import_status 0` (unchanged), and `notes` = the original note with this appended:
`relabeled 2026-10-08: DRY RUN, no MFL request (import_status 0); originally logged dry_run=0 landed=1 by the contract-route audit-writer bug; original row + evidence in ups_contract_gate_audit field salary_change_log_dry_run_relabel`.

No other column changed: salary, contract fields, intended values, timestamps, endpoint and actor are all as before.

| Row | Logged | Route | Player | Tier | Audit record | dry_run | landed | Timeline entry marked DRY |
|---|---|---|---|---|---|---|---|---|
| 1233 | 2026-06-01 15:51:19 | `/commish-contract-update` | 16614 | A | 121 | 0 → 1 | 1 → 0 | bc08737b50a3b072b7c7b7e2 |
| 1234 | 2026-06-01 15:56:19 | `/offer-restructure` | 14779 | A | 122 | 0 → 1 | 1 → 0 | 2e28f3f352fdba4d0ac686ac |
| 1235 | 2026-06-01 15:56:51 | `/offer-restructure` | 14779 | A | 123 | 0 → 1 | 1 → 0 | 6eee6588cbe3ac62dbc92d24 |
| 1236 | 2026-06-01 18:18:23 | `/commish-contract-update` | 16614 | A | 124 | 0 → 1 | 1 → 0 | b196efe091ca0e5dd14b3559 |
| 1237 | 2026-06-01 18:36:42 | `/commish-contract-update` | 16614 | A | 125 | 0 → 1 | 1 → 0 | 7a8b5e6fadaf731657de9030 |
| 1238 | 2026-06-03 10:08:26 | `/commish-contract-update` | 16212 | B | 143 | 0 → 1 | 1 → 0 | dbe64fb42722e6321b66a6b1 |
| 1240 | 2026-06-03 13:47:54 | `/commish-contract-update` | 16174 | A | 126 | 0 → 1 | 1 → 0 | b0ddc2f2d74a636a6ec66748 |
| 1243 | 2026-06-03 15:12:08 | `/commish-contract-update` | 16174 | A | 127 | 0 → 1 | 1 → 0 | 069e31c472ff215fd9a33eff |
| 1246 | 2026-06-03 20:54:56 | `/commish-contract-update` | 16174 | A | 128 | 0 → 1 | 1 → 0 | — |
| 1248 | 2026-06-04 13:11:41 | `/commish-contract-update` | 16194 | A | 129 | 0 → 1 | 1 → 0 | 59549decbf0f745fcdab12dc |
| 1250 | 2026-06-04 16:25:24 | `/commish-contract-update` | 13674 | A | 130 | 0 → 1 | 1 → 0 | — |
| 1253 | 2026-06-04 16:26:15 | `/commish-contract-update` | 14137 | A | 131 | 0 → 1 | 1 → 0 | 18c076258e1087f9ed4d4db0 |
| 1256 | 2026-06-04 16:27:20 | `/commish-contract-update` | 16614 | A | 132 | 0 → 1 | 1 → 0 | — |
| 1259 | 2026-06-04 17:32:58 | `/commish-contract-update` | 16252 | A | 133 | 0 → 1 | 1 → 0 | 0957d55f77024a1b28667856 |
| 1262 | 2026-06-04 22:29:11 | `/commish-contract-update` | 16193 | A | 134 | 0 → 1 | 1 → 0 | 2e55ad50b6e77d88afb1f6b8 |
| 1264 | 2026-06-05 17:41:08 | `/offer-mym` | 14836 | B | 144 | 0 → 1 | 1 → 0 | 0f4733771ff96841a1fd5678 |
| 1265 | 2026-06-05 18:21:57 | `/offer-mym` | 14836 | B | 145 | 0 → 1 | 1 → 0 | 26899c41cf0c38e9d48c7cb9 |
| 1266 | 2026-06-05 18:22:17 | `/offer-mym` | 14836 | B | 146 | 0 → 1 | 1 → 0 | 4f49b78f9fa4f0f82200ca2f |
| 1267 | 2026-06-05 18:24:01 | `/offer-mym` | 14836 | B | 147 | 0 → 1 | 1 → 0 | 8c57373f2cfa3d9fb553b244 |
| 1269 | 2026-06-05 21:39:13 | `/commish-contract-update` | 16194 | A | 135 | 0 → 1 | 1 → 0 | c612dbfdd39f7552fc02fe2b |
| 1271 | 2026-06-05 21:40:45 | `/commish-contract-update` | 16167 | A | 136 | 0 → 1 | 1 → 0 | 1dac2d05f77f6ba10265fedb |
| 1698 | 2026-07-28 02:50:50 | `/commish-contract-update` | 16185 | A | 137 | 0 → 1 | 1 → 0 | 45fa3e7438fc2c06f5227cee |
| 1699 | 2026-07-28 02:50:51 | `/commish-contract-update` | 14833 | A | 138 | 0 → 1 | 1 → 0 | — |
| 1700 | 2026-07-28 02:50:52 | `/commish-contract-update` | 13696 | A | 139 | 0 → 1 | 1 → 0 | — |
| 1704 | 2026-07-28 10:25:34 | `/commish-contract-update` | 15290 | A | 140 | 0 → 1 | 1 → 0 | e5b8c4d68bf8089a819ff4fb |
| 1705 | 2026-07-28 10:25:35 | `/commish-contract-update` | 14778 | A | 141 | 0 → 1 | 1 → 0 | — |
| 1876 | 2026-10-07 20:13:55 | `/commish-contract-update` | 99999999 | A | 142 | 0 → 1 | 1 → 0 | — |

## Front Office timeline: the 20 entries marked DRY (`test_flag 0 → 1`)

Each entry was confirmed to map to exactly one of the corrected dry runs before it was marked:
- The entry's submit time is 1–2 s before that row, for the same player, and no other row of the player falls in that window.
- Six cases had the identical REAL request close behind (1243, 1253, 1259, 1262, 1271, 1704). They were settled as follows:
  - **1243, 1253, 1259, 1262:** the entry carries the dry run's own submission timestamp, with `dry_run=1` in `ups_extension_submissions`. The logger upserts whole entries by id, so the content is that dry run's.
  - **1271:** the only successful logging run in that window started at 21:40:47Z, before the real request finished (21:40:50.95Z). The real request's run failed.
  - **1704:** the successful run's log names the entry and the dry run's start time (run 30350706398). The real request's runs were cancelled or failed.
- 1698 is confirmed the same way (run 30324268868).

Only those 20 entries changed, and only `test_flag`. The other 139 entries, `meta`, and every Discord message are untouched. The real follow-up requests in those six cases have **no** timeline entry of their own, because their logging runs failed or were cancelled. That gap is left as it is, not filled in.

