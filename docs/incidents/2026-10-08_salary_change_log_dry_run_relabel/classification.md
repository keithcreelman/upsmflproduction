# The 27 mislabeled `salary_change_log` rows: classification

Read-only evidence gathered 2026-10-08 from production D1 (`ups-mfl-db`), git history, the GitHub deploy-run log and the contract activity log. **Nothing has been changed in production.** The prepared, guarded correction is in this folder; it runs only on Keith's approval.

## How each row was judged

A row is corrected only if it is **proven** to be a dry run. Equal before/after salary is not enough on its own: in a real write, the handler decides "changed" on contract year, contract info and status, not salary. Row 1875, for example, kept $1,000 while it moved Vet-WW to Vet-MYM. Four kinds of evidence were used:

- **Code path (every row).** The worker version live when the row was written is the last successful `deploy-worker` run before it. Where the row is within 15 minutes of a deploy, the version before that was checked too (rollout overlap). 18 versions were checked; in **every one**:
  - the dry-run branch sets the simulated success and skips the MFL import loop;
  - `mflRes`, `looksOk`, `anyChanged` and `postCheck` are assigned only by that branch or by a real MFL fetch and re-read;
  - the audit row stores `import_status = mflRes ? mflRes.status : 0` and hard-codes `dry_run: false`;
  - `landed` requires `import_ok_*`, which requires `looksOk && verifyAvailable && anyChanged`;
  - no other writer logs these three endpoints.

  So in all of that code, a row with `landed = 1` and `import_status = 0` can only come from a dry run.
- **The row's own MFL result (every row).** `import_status` is 0, meaning no MFL response. All **four** contract fields (salary, status, years, info) are identical before and after. A real landed write needs an observed change.
- **The request's own mode:**
  - **Same-request record.** The same handler wrote a submission row from the request's own flag (`ups_extension_submissions` / `ups_restructure_submissions`, `dry_run = 1`, same player, same submit time).
  - **Real request just after.** The identical real request followed within seconds, with MFL status 200, and its before-state equals this row's.
  - **Row 1876:** the probe I sent myself.
- **MFL's later state.** The next MFL-confirmed read of the player (status 200) shows whether the intended contract ever landed.

**Tier A (22 rows):** a record of the request's own mode survives. **Tier B (5 rows):** no such record survives. They are proven by the code path, the row's own MFL result, and MFL's later reads showing the contract never changed. Tier B has its own SQL file so it can be approved separately. Tier B's Discord cards (message ids below) would move four of them to Tier A if they show "[DRY RUN]". **No row is ambiguous.**

## Rows

| Row | Logged (UTC) | Route | Player | Intended | Request-mode evidence | MFL afterwards | Activity log | Tier |
|---|---|---|---|---|---|---|---|---|
| 1233 | 2026-06-01 15:51:19 | `/commish-contract-update` | 16614 | 24000 EXT1 y1 | ups_extension_submissions #10 dry_run=1 | next confirmed read 1255 (2026-06-04): unchanged | Extension → test | **A** |
| 1234 | 2026-06-01 15:56:19 | `/offer-restructure` | 14779 | 31000 Vet-FAA-FL y2 | ups_restructure_submissions #1 dry_run=1 | no later confirmed read | Restructure → test | **A** |
| 1235 | 2026-06-01 15:56:51 | `/offer-restructure` | 14779 | 76500 Vet-FAA-FL y2 | ups_restructure_submissions #2 dry_run=1 | no later confirmed read | Restructure → test | **A** |
| 1236 | 2026-06-01 18:18:23 | `/commish-contract-update` | 16614 | 14000 EXT1 y2 | ups_extension_submissions #11 dry_run=1 | next confirmed read 1255 (2026-06-04): unchanged | Extension → test | **A** |
| 1237 | 2026-06-01 18:36:42 | `/commish-contract-update` | 16614 | 24000 EXT1 y1 | ups_extension_submissions #12 dry_run=1 | next confirmed read 1255 (2026-06-04): unchanged | Extension → test | **A** |
| 1238 | 2026-06-03 10:08:26 | `/commish-contract-update` | 16212 | 2000 Vet-ERA y2 | none surviving | next confirmed read 1834 (2026-09-05): unchanged | FA Contract → test | **B** |
| 1240 | 2026-06-03 13:47:54 | `/commish-contract-update` | 16174 | 3000 Vet-ERA y1 | ups_extension_submissions #13 dry_run=1 | next confirmed read 1241 (2026-06-03): unchanged | Multi-Year Contract → silenced | **A** |
| 1243 | 2026-06-03 15:12:08 | `/commish-contract-update` | 16174 | 3000 Vet-ERA y1 | ups_extension_submissions #16 dry_run=1 | next confirmed read 1244 (2026-06-03): unchanged | Multi-Year Contract → silenced | **A** |
| 1246 | 2026-06-03 20:54:56 | `/commish-contract-update` | 16174 | 3000 Vet-ERA y1 | ups_extension_submissions #19 dry_run=1 | next confirmed read 1247 (2026-06-03): unchanged | — | **A** |
| 1248 | 2026-06-04 13:11:41 | `/commish-contract-update` | 16194 | 6000 Vet-Ext2 y3 | ups_extension_submissions #21 dry_run=1 | next confirmed read 1268 (2026-06-05): unchanged | Extension → test, Discord msg 1512081410863796296 | **A** |
| 1250 | 2026-06-04 16:25:24 | `/commish-contract-update` | 13674 | 7000 Vet-FAA y1 | ups_extension_submissions #23 dry_run=1 | next confirmed read 1251 (2026-06-04): unchanged | — | **A** |
| 1253 | 2026-06-04 16:26:15 | `/commish-contract-update` | 14137 | 4000 Vet-FAA y1 | ups_extension_submissions #26 dry_run=1 | next confirmed read 1254 (2026-06-04): unchanged | Extension → silenced | **A** |
| 1256 | 2026-06-04 16:27:20 | `/commish-contract-update` | 16614 | 14000 Rookie-Draft y1 | ups_extension_submissions #29 dry_run=1 | next confirmed read 1257 (2026-06-04): unchanged | — | **A** |
| 1259 | 2026-06-04 17:32:58 | `/commish-contract-update` | 16252 | 1000 Vet-ERA y1 | ups_extension_submissions #32 dry_run=1 | next confirmed read 1260 (2026-06-04): unchanged | Multi-Year Contract → silenced | **A** |
| 1262 | 2026-06-04 22:29:11 | `/commish-contract-update` | 16193 | 2000 Vet-ERA y1 | ups_extension_submissions #35 dry_run=1 | next confirmed read 1263 (2026-06-04): unchanged | Multi-Year Contract → silenced | **A** |
| 1264 | 2026-06-05 17:41:08 | `/offer-mym` | 14836 | 71000 Vet-MYM y2 | none surviving | next confirmed read 1806 (2026-08-06): unchanged | FA Contract → test, Discord msg 1512511604405698580 | **B** |
| 1265 | 2026-06-05 18:21:57 | `/offer-mym` | 14836 | 1000 Vet-MYM y2 | none surviving | next confirmed read 1806 (2026-08-06): unchanged | MYM → test, Discord msg 1512521877523005451 | **B** |
| 1266 | 2026-06-05 18:22:17 | `/offer-mym` | 14836 | 1000 Vet-MYM y2 | none surviving | next confirmed read 1806 (2026-08-06): unchanged | MYM → test, Discord msg 1512521963019567197 | **B** |
| 1267 | 2026-06-05 18:24:01 | `/offer-mym` | 14836 | 1000 Vet-MYM y2 | none surviving | next confirmed read 1806 (2026-08-06): unchanged | MYM → test, Discord msg 1512522397046276268 | **B** |
| 1269 | 2026-06-05 21:39:13 | `/commish-contract-update` | 16194 | 25000 Veteran y2 | ups_extension_submissions #658 dry_run=1 | next confirmed read 1620 (2026-07-19): changed by later events | Extension → silenced | **A** |
| 1271 | 2026-06-05 21:40:45 | `/commish-contract-update` | 16167 | 25000 Vet-Ext2-BL y2 | identical real request 1272 seconds later (status 200) | next confirmed read 1272 (2026-06-05): unchanged | Extension → silenced | **A** |
| 1698 | 2026-07-28 02:50:50 | `/commish-contract-update` | 16185 | 1000 Vet-Ext2-FL y2 | identical real request 1701 seconds later (status 200) | next confirmed read 1701 (2026-07-28): unchanged | FA Contract → silenced | **A** |
| 1699 | 2026-07-28 02:50:51 | `/commish-contract-update` | 14833 | 1000 Vet-FAA-FL y1 | identical real request 1702 seconds later (status 200) | next confirmed read 1702 (2026-07-28): unchanged | — | **A** |
| 1700 | 2026-07-28 02:50:52 | `/commish-contract-update` | 13696 | 1000 Vet-FAA-FL y1 | identical real request 1703 seconds later (status 200) | next confirmed read 1703 (2026-07-28): unchanged | — | **A** |
| 1704 | 2026-07-28 10:25:34 | `/commish-contract-update` | 15290 | 30000 Vet-Ext2-BL y2 | identical real request 1706 seconds later (status 200) | next confirmed read 1706 (2026-07-28): unchanged | FA Contract → silenced | **A** |
| 1705 | 2026-07-28 10:25:35 | `/commish-contract-update` | 14778 | 15000 Vet-Ext2-FL y1 | identical real request 1707 seconds later (status 200) | next confirmed read 1707 (2026-07-28): unchanged | — | **A** |
| 1876 | 2026-10-07 20:13:55 | `/commish-contract-update` | 99999999 | 1000 Vet-FAA y1 | the 2026-10-07 auth-check probe (body `dry_run=1`) | not an MFL player | reverted in #1188 | **A** |

Full per-row evidence: `classification.json`. Code-path checks: re-run with the commands in `README.md`.

