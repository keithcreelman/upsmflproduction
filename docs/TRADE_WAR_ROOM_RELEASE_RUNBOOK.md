# Trade War Room — coordinated release and rollback runbook

**Branch:** `integration/trade-war-room-authz-2026-09-25`, merged with current `origin/main` `122b3fb6` (merge commits, no rebase; earlier `8d12de4d`). **Nothing here has been run — no push, no PR, no migration applied, no deploy.** Do not start until Keith says go.
**What ships:**
1. **Admin-route security** — every `/admin/*` request is matched against an exact route table before any handler runs; an unrecognized path is `404`, a recognized one needs a credential (`401`/`403`), and the old catch-all that answered *any* unmatched path with admin-state JSON (including owner-email counts and the commissioner franchise id) is gone (`docs/TRADE_WAR_ROOM.md` §10a).
2. **Irreversible-execution safety** — an execution ledger (`ups_trade_executions`, migration `0160`): a conditional lock before MFL is called, MFL's success kept permanently, post-processing only after MFL executed, `executed_needs_review` instead of "failed" when a contract step breaks, reconciliation against MFL for a lost response (§8a).
3. **Recoverable three-team cap blocks** — `blocked_cap`: every accept is kept, the trade stays open, a re-check recomputes the cap from scratch (§8b).
4. **Pre-trade extension eligibility re-proven at the accept** from authoritative data, failing closed (§14a).
5. **One cap authority** for the Front Office and the Trade War Room (`worker/src/cap_math.js`) with byte-equivalent totals (§14b).
6. Already accepted earlier and unchanged: 2-way authorization + accept integrity, the commissioner administrative cancel (migration `0159`), signed-out/empty/error states, the salary-cap hard block + roster-count advisory, review-before-accept clients. Mobile build is now **`2026.09.25.3`** (the accepted `2026.09.25.2` plus the executed/needs-review/held-trade messaging).
**Live trade to protect:** the collecting 3-way `54a0306a-552e-4f79-8d34-98d72eb704a0`. Nothing in this runbook cancels it; §7 says when it may be.

## 1. The facts that shape the order

Four things ship, by **independent, non-atomic** mechanisms (`reference_deploy_model_worker_vs_sha`):

| Layer | How it deploys | Trigger | Time |
|---|---|---|---|
| D1 migrations `0159`, `0160` | **manual** — CI never applies migrations | `cd worker && npx wrangler d1 migrations apply ups-mfl-db --remote` | seconds |
| Worker (`worker/**`, and `docs/league_context_v1.md` — bundled) | auto, `deploy-worker.yml`: ESLint `no-undef` gate, then `wrangler deploy` | push to `main` touching those paths | ~30 s; a newer push cancels an in-flight deploy |
| Site (`site/**`): mobile PWA, desktop War Room, rookie hub | auto, `pages-deploy.yml` | push to `main` touching `site/**` | ~30 s + CDN (a few minutes for the desktop file; the **mobile service worker is cache-first keyed by `?v=BUILD`**, so phones pick it up through the in-app "new version" banner) |

One merge to `main` fires the worker and Pages workflows **in parallel**; either can finish first, and either can fail alone. They cannot be made atomic, so every release has an interval where worker and site disagree. The plan below makes both orders safe, and offers a two-step landing that removes the worse order.

**Migration `0160` is not a hard prerequisite** — the ledger creates its own table on first use (`CREATE TABLE IF NOT EXISTS`, byte-identical DDL). It ships as a migration so the tracker and the schema stay in step, and so the table exists before the first live trade needs it. Migration `0159` *is* required for the administrative cancel (which fails closed with `503 migration_required` until then).

## 2. Compatibility matrix — what an owner sees in each interval

| State | Worker | Site | What works | What does not (and why it's safe) |
|---|---|---|---|---|
| **S0** today | old | old | everything as today | (the holes this release closes) |
| **S1** after migrations only | old | old | identical to S0 | nothing — `0159` adds four nullable columns the old worker ignores; `0160` adds a table the old worker never reads |
| **S2** worker live, site old | **new** | old | every legitimate request from the **deployed** mobile/desktop bundles (39/39 compatibility tests). An over-cap accept is refused by the worker and the deployed client shows the worker's message. | No pre-accept review sheet; an accept that executed but whose contract step failed shows the OLD client a generic "Done" (the trade **was** executed — the response says so, the old client just doesn't word it); the held-3-way Re-check button is absent (the trade still waits safely, the commissioner or Discord retry re-runs it). Rookie-hub trade dialog shows a sign-in error until the site ships. |
| **S3** site live, worker old | old | **new** | everything except the accept review and the held-trade view | **The new clients call `action: PREVIEW` and `/api/trades/3way/recheck`, which the old worker rejects, so the review sheet says "Can't review this trade" and there is no Accept button: in-app 2-way accepts are blocked until the worker is live.** Nothing is written; owners can still accept in MFL itself. Avoid this order. |
| **S4** both live | new | new | everything | — |

**Recommendation — land in two steps so S3 can never happen** (by path, no code changes):
1. **Release A = `worker/**`, `tests/**`, `scripts/**`, `docs/**`** (the worker, its tests, the route-table generator, the docs). `docs/league_context_v1.md` is bundled into the worker, so a docs change redeploys it — expected. Merges to S2.
2. **Release B = `site/**`** (including the regenerated `site/m/data/rules*.json/js`). Merges S2 → S4.
   `git checkout <release-commit> -- worker tests scripts docs` on a branch from `main` gives A; `-- site` gives B.

If a single merge is preferred, accept S2 *or* S3 for up to a couple of minutes; §5 gives the rollback for each.

## 3. Migrations — evidence

`wrangler d1 migrations list ups-mfl-db --remote` (read-only, 2026-09-25): the tracker is aligned through `0158`; `0159` was the only pending migration. Re-run `list` immediately before applying — **`0160` is new in this release** and the tracker can drift when a migration is hand-applied (`reference_d1_migration_tracker_drift`); never `ALTER` in D1 without `list` first.

**`0159_ups_3way_admin_cancel.sql`** — four nullable `TEXT` columns on `ups_3way_trades` (`cancel_basis`, `cancelled_by`, `cancel_reason`, `cancelled_at_utc`). Additive and byte-preserving for every existing row (verified on a real SQLite DB with the real earlier migrations and four legacy rows). The base worker tolerates them (explicit-column `INSERT`s, `SELECT *`, named-column `UPDATE`s). **Structure accepted as-is.**

**`0160_ups_trade_executions.sql`** — `CREATE TABLE IF NOT EXISTS ups_trade_executions (league_id, season, exec_key, kind, state, lock_token, actor_fid, participants, payload_hash, payload_json, mfl_evidence_json, steps_json, failed_step, failure_detail, block_json, created_at_utc, updated_at_utc, mfl_executed_at_utc, completed_at_utc, PRIMARY KEY (league_id, season, exec_key))`. A new table: no existing row or table is touched; rolling back means leaving it (nothing else reads it). The worker's runtime DDL is the same statement, so the order of "migration vs worker" cannot matter.

**Rollback of the migrations:** none needed. The columns/table are inert to the old worker; dropping them is riskier than leaving them.

## 4. The runbook

Set once: `W=https://upsmflproduction.keith-creelman.workers.dev` and `K=<the commissioner API key>` (never paste it into a shared channel). Every check below is **read-only** unless it says otherwise. Do **not** smoke-test 2-way *write* routes against production without a session.

> **The deployment discriminator is `GET /admin/release-info` with the key — an exact, authenticated, non-mutating endpoint that returns a fixed release marker.** Do **not** infer "new worker is live" from how an *unmatched* `/admin/*` path answers: the old worker's generic catch-all returned `200` admin-state JSON for anything, so "a 4xx means the new worker" is a guess, and the old behavior is itself the bug being fixed.
> ```bash
> curl -s "$W/admin/release-info?L=74598&YEAR=2026" -H "X-COMMISH-APIKEY: $K" | jq -e '.ok == true and .release == "trade-war-room-2026-09-25.3" and .features.execution_ledger and .features.admin_front_door and .features.recoverable_cap_block'
> ```
> `true` ⇒ the new worker; anything else (including a `200` without a `.release`) ⇒ **not** deployed yet. Without the key the same call is `401`/`403` and reveals nothing.

### Step 0 — pre-flight (nothing changes)
1. `git fetch origin main` → still `122b3fb6`, or merge any newer tip in first (merge, don't rebase; main receives automated data commits all day). `gh run list --workflow=deploy-worker.yml --limit 3` and `--workflow=pages-deploy.yml --limit 3` are green.
2. CI-equivalent gates on the release commit: worker ESLint, `wrangler deploy --dry-run`, the trade suites (`TRADE_WAR_ROOM.md` §19).
3. The live trade (already inspected read-only): `curl -s "$W/admin/3way/inspect?L=74598&id=54a0306a-552e-4f79-8d34-98d72eb704a0&APIKEY=$K"` → `status: "collecting"`. Record its `updated_at_utc`.
4. **Expected:** nothing changes for anyone. **Rollback:** n/a.

### Step 1 — apply the migrations (before either deploy)
```bash
cd worker && npx wrangler d1 migrations list ups-mfl-db --remote      # exactly: 0159 and 0160 pending
npx wrangler d1 migrations apply ups-mfl-db --remote                    # applies them in order
npx wrangler d1 migrations list ups-mfl-db --remote                     # "No migrations to apply"
npx wrangler d1 execute ups-mfl-db --remote --command "PRAGMA table_info(ups_3way_trades)"          # read-only: the 4 audit columns
npx wrangler d1 execute ups-mfl-db --remote --command "PRAGMA table_info(ups_trade_executions)"     # read-only: the ledger columns
```
- **Expected (S1):** identical behavior for owners; the live trade's row is untouched.
- **If it errors:** `list` again. `0159` is four independent `ADD COLUMN`s (a repeat fails with "duplicate column" = already applied — verify with `PRAGMA`); `0160` is `IF NOT EXISTS`. **Do not proceed until both `PRAGMA`s show their columns.** **Rollback:** none.

### Step 2 — worker (Release A, or the single merge)
Merge → `deploy-worker.yml` (ESLint gate, then deploy). `gh run watch` green; `npx wrangler deployments list` (in `worker/`) shows the new version. **Then run the discriminator above.**

**2a. Admin-route security smoke (read-only; each line is a `curl` and the expected status):**
```bash
code() { curl -s -o /tmp/twr_body -w '%{http_code}' "$@"; }
# a recognized admin route, no credential → 401 ; wrong credential → 403 ; the body reveals nothing
code "$W/admin/d1-status?L=74598"                                         # 401
code "$W/admin/d1-status?L=74598&APIKEY=wrong"                            # 403
# an unrecognized /admin path (top level, nested, trailing slash, duplicate slash, encoded slash, other methods) → 404, exact matching only
code "$W/admin/this-route-does-not-exist"                                  # 404
code "$W/admin/d1-status/"                                                  # 404   (trailing slash is a different path)
code "$W//admin/d1-status?L=74598"                                          # 404   (duplicate slash is a different path)
code "$W/admin%2Fd1-status?L=74598"                                         # 404   (an encoded separator is not a separator)
code -X POST "$W/admin/d1-status?L=74598"                                   # 404   (the wrong method is the same uniform 404 — no route inventory leaks)
code -X OPTIONS "$W/admin/d1-status?L=74598" -H 'Origin: https://x' -H 'Access-Control-Request-Method: GET'   # minimal CORS preflight; no data
# nothing sensitive may appear in ANY of those bodies
for p in "/admin/d1-status?L=74598" "/admin/nope" "/roster-workbench/admin-state?L=74598&YEAR=2026"; do
  curl -s "$W$p" | grep -Eqi 'emailCount|commissionerFranchise|0008|isAdmin.*true|Private owner data' && echo "LEAK in $p" || echo "clean: $p"
done
```
Every `code` line must be exactly the listed status (**never `200`**); every loop line must print `clean`. (Measured against production **2026-09-25, before this release**: an unknown `/admin/*` path answered `200` with `"reason":"Private owner data visible (commish)"` and an owner-email count. That is the defect; these checks failing on the old worker is expected, and is **not** how you tell old from new — use the discriminator.)

**2b. Trade-route smoke (unchanged from the earlier gate):**
- `curl -s -o /dev/null -w '%{http_code}\n' -X POST "$W/api/trades/3way/cancel" -H 'content-type: application/json' -d '{"id":"nonexistent-id-0000"}'` → **`401`**;
- `curl -s -o /dev/null -w '%{http_code}\n' "$W/api/trades/outbox?L=74598&YEAR=2026&OUTBOX_ID=1"` → **`401`**;
- `curl -s -o /dev/null -w '%{http_code}\n' -X POST "$W/api/trades/3way/recheck?L=74598" -H 'content-type: application/json' -d '{"id":"x"}'` → **`401`**;
- `curl -s -o /dev/null -w '%{http_code}\n' -X POST "$W/admin/3way/cancel?L=74598" -H 'content-type: application/json' -d '{"id":"x","reason":"x"}'` → **`401`** (no credential).

**2c. FO / Trade War Room cap-parity check (read-only; a required gate — if it disagrees, roll back the worker):** run `scratchpad`-style parity: fetch `GET $W/roster-workbench?L=74598&YEAR=2026` (the Front Office, now on the shared module) and, per franchise, `POST $W/admin/3way/compliance?L=74598&YEAR=2026` with `X-COMMISH-APIKEY` and a 2-team hypothetical (`{"league_id":"74598","season":"2026","offer_created_at_utc":"<any past ISO time>","movements":[{"from":"<A>","to":"<B>","tokens":["<a player A owns>"]},{"from":"<B>","to":"<A>","tokens":["<a player B owns>"]}]}`); each team's `used_before` in the compliance result must equal the Front Office's `cap_total_dollars + salary_adjustment_total_dollars` for that team. **Recorded result against production (read-only, all 12 franchises, after the blank contracts were resolved — table in `TRADE_WAR_ROOM.md` §14b / the final report):** every franchise resolves and equals the Front Office. The two franchises that were unresolved earlier (`0004`, `0005`: FCFS pickups `16619` and `13418` with a blank MFL salary/contract — the shared module fails closed instead of counting blank as $0) were stamped through the **existing** commissioner workflow (`POST /admin/import-salaries`, `APPEND=1`, audited in `salary_change_log` 1872/1873, re-read and verified in MFL and the Front Office). If a future blank appears, do the same: prove the governing rule and the transaction first (FCFS = $1K flat, 1-year WW, canon §A5 — but confirm from the transaction; never assume), then stamp through that workflow; no direct SQL.

**2d. Execution-state reconciliation smoke (read-only / non-mutating):**
```bash
curl -s "$W/admin/trade/execution?L=74598&YEAR=2026&id=00000000-0000-4000-8000-000000000000" -H "X-COMMISH-APIKEY: $K"   # 404 {"code":"not_found"}   (503 ledger_unavailable would mean D1 is unreadable)
curl -s -X POST "$W/admin/trade/reconcile-execution?L=74598&YEAR=2026" -H "X-COMMISH-APIKEY: $K" -H 'content-type: application/json' -d '{"id":"nope"}'   # 404 not_found — nothing changed
```
These prove the route, the auth, and the ledger read path without touching any trade.

**2e. Extension-eligibility boundary check (read-only):** `POST /admin/3way/compliance` never writes. With a real final-year player (pick one from the roster workbench) and `offer_created_at_utc` set to a past time:
- a normal final-year veteran **before** the September deadline → `extension_skipped: []`;
- **today (after the 2026-09-06 21:00 ET deadline)** the same player with no acquisition in the last 28 days → `extension_skipped: [{"reason":"deadline_passed"}]` (this is correct behavior, not a bug); a player the extender got by trade/pickup within the window → `[]`;
- a player with more than one year left → `not_final_year`; a player in `ups_tag_master` (`npx wrangler d1 execute … --command "SELECT player_id FROM ups_tag_master WHERE season='2026'"`) → `tagged`;
- omit `offer_created_at_utc` → `authority_unavailable:restructure_history` (proves it fails closed);
- **no request may ever return `authority_unavailable:*` for a healthy league** — if one does, an authority (rosters, tag master, extension master, restructure log, contract calendar, transactions export) is unreadable and every extension trade is being held; check that source first.

**2f. Extension-pricing smoke (read-only):** `GET $W/admin/trade/extension-review?L=74598&YEAR=2026&trade=<mfl trade id or 3-way id>` with `X-COMMISH-APIKEY` prints, per stored extension request, the stored terms, the canonical terms (`pricing_version`), the diffs and the eligibility verdict; it never writes. Expected for an offer built after this release: `pricing.ok: true` and `verdict: "will_proceed"`. A stored offer created before it that does not match canon is **not repaired in place** — the sender withdraws it and sends a new one (a new MFL trade id / outbox row, priced from the current contract); the old row stays as history. An accept of a stale offer answers `409 extension_terms_stale` with the diffs and executes nothing. An unreadable pricing input answers `503 extension_check_unavailable`. Known pre-release state (production audit, read-only): the Bowers offers (MFL trades 1201/1209) price-match canon but are past the extension deadline (`deadline_passed`); the live 3-way has no extensions; live pending 2-way offers can't be read from the commissioner side (MFL lockout), so ask owners to re-send any pending extension offer that predates the release.

- **If the worker deploy fails** (ESLint gate or `wrangler`): production stays on the old worker (S0/S1, or S3 if the site already went out). Fix forward and re-run `workflow_dispatch`; Cloudflare deploys a version atomically. **Rollback of a bad deploy:** revert the merge on `main` (auto-redeploys in ~30 s) or `cd worker && npx wrangler rollback`. The old worker tolerates `0159`/`0160`, so the migrations stay.
  - **Caveat on rollback after a trade has executed under the new worker:** `ups_trade_executions` rows written by the new worker are ignored by the old one. The old worker has no lock, so **do not roll back while any trade is `executing` / `executed_needs_review`** — resolve or reconcile it first (§5).

### Step 3 — site (Release B, or already fired by the single merge)
Merge → `pages-deploy.yml`. Confirm green, then:
- `curl -s "https://keithcreelman.github.io/upsmflproduction/m/version.json" | jq -r .build` → **`2026.09.25.3`**;
- `curl -s https://keithcreelman.github.io/upsmflproduction/m/index.html | grep -o 'trade.js?v=[0-9.]*'` → `2026.09.25.3` (and `app.js?v=`, `trade_3way_view.js?v=` the same);
- `curl -s https://keithcreelman.github.io/upsmflproduction/trades/trade_workbench.html | grep -o 'trade_workbench.js?v=[0-9a-z]*'` → **`20260925d`** (Pages' CDN ignores `?v=` for the file itself, so also confirm `Last-Modified`);
- the desktop War Room and rookie hub load through the header's release SHA: confirm it resolves to the new `main` SHA (auto-resolved since 2026-07-18; if pinned, bump `UPS_RELEASE_SHA` and **warm jsDelivr first** — a new SHA can 502 for minutes, and this repo exceeds jsDelivr's 50 MB limit, so prefer the raw/Pages fallback the loaders already use).
- **Expected (S4):** mobile users get the update banner; Accept opens the review sheet; signed-out says "Sign in to view trades"; a held 3-way shows who/how much with a Re-check button.
- **Authenticated smoke (Keith, read-only):** open a real incoming offer → Accept → confirm the review sheet with cap numbers → press **Not now**. Do not confirm an accept for a test.
- **If Pages fails:** you are in S2 — safe; re-run `pages-deploy.yml` (`workflow_dispatch`). **Rollback:** revert the site commit(s); phones see a different `version.json` build and show the banner.

### Step 4 — final verification (read-only)
1. Re-run 2a–2e. 2. `GET /admin/3way/inspect?…` → the live trade is **still `collecting`**, `cancel_*` `NULL`, `updated_at_utc` unchanged. 3. `gh run list` for both workflows green. 4. `wrangler tail` for `[3way] … blocked by the cap gate` and `[trade-exec] CRITICAL` (the latter means MFL executed and D1 could not record it — §5 tells you what to do) and any `authority_unavailable` / `cap_check_unavailable` bursts (MFL exports failing: nothing can be accepted until they recover — the fail-closed design).

## 5. Recovery scenarios

| What went wrong | State | Action |
|---|---|---|
| Migration errored / partial | S0 | re-`list`; `PRAGMA` decides; `0159` gates the administrative cancel only, `0160` is optional (the worker creates the table itself) |
| Worker deploy failed (lint / wrangler) | S0/S1 (or S3) | fix forward, `workflow_dispatch`; if S3, ship the worker next or revert the site commit |
| Cap-parity or discriminator check disagrees | S2 | `npx wrangler rollback` (or revert) **immediately** — unless a trade is mid-execution (see the caveat above) |
| **Worker deploy succeeds, Pages fails** | **S2** | **Safe to leave.** Owners lose only the review sheet / held-trade Re-check button; the server still enforces every rule. Re-run `pages-deploy.yml`; if it keeps failing, the worker stays. Do **not** revert the worker to "match". |
| **Pages succeeds, worker deploy fails** | **S3** | **Fix the worker first** (owners cannot accept in-app until it is live; they can accept in MFL directly). Re-run `deploy-worker.yml`; if the worker cannot ship within minutes, revert the site commit so the clients match the old worker. |
| Both failed | S1 | nothing user-visible changed; investigate; migrations are inert |
| Bad site build after both shipped | S4 → S2 | revert the site commit; the worker's guards remain |
| **MFL executed a trade but D1 persistence failed** (`[trade-exec] CRITICAL`, response `execution_persisted:false`, or ledger stuck `executing`) | ledger `executing`; **the trade DID execute** | Never re-run it. **Two-way:** `GET /admin/trade/execution?id=<mfl trade id>` shows the row; `POST /admin/trade/reconcile-execution {"id":"<mfl trade id>"}` asks MFL (transactions ledger first, then pending list): `reconciled_executed` moves it to `mfl_executed` and runs only the missing post-processing (cap-money rows already in MFL are detected and not re-posted); `still_ambiguous` changes nothing — check the trade in MFL and repeat. **Three-way:** verify each leg in MFL (`GET /admin/3way/inspect` shows `mfl_trade_ids` if D1 recorded them); the route deliberately refuses to guess (`manual_reconcile_required`). If every leg is in MFL, record it once: `UPDATE ups_trade_executions SET state='mfl_executed', mfl_executed_at_utc=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE exec_key='<uuid>' AND state='executing'` (only after checking MFL by eye), then `POST /admin/trade/postprocess-retry {"id":"<uuid>","kind":"three_way"}`. |
| **MFL executed a trade but the extension / cap-money step failed** (`executed_needs_review`) | the trade executed; one step did not | `GET /admin/trade/execution?id=…` shows `failed_step` and `steps`. `POST /admin/trade/postprocess-retry {"id":"…"}` re-runs **only** the steps not yet proven done — never the trade. If it answers `manual_verification_required` (an earlier extension attempt reached MFL but couldn't be verified), **look at the player's contract in MFL first**; only if it did **not** apply, repeat with `"force":true`. A three-way that only partly executed (`failed_step` = a leg) answers `legs_need_manual_fix` — fix it in MFL by hand; retry cannot repair missing legs. |
| An owner reports "it says not confirmed" | ledger `executing` | The accept was **not** re-sent. `POST /admin/trade/reconcile-execution` as above. |

## 6. Point at which the live collecting 3-way may safely be canceled

- **Owner cancel by the initiator (`0008`) through the UI** is safe once **Step 2 has passed 2a–2b** (the worker no longer answers `400 Missing L param`; the initiator's own MFL session is required). **Canon (A6): once both partners have accepted, an owner cannot cancel** — including a trade that is only waiting on the cap. Until then, recommended **after Step 4**.
- **Commissioner administrative cancel** (`POST $W/admin/3way/cancel?L=74598` with `X-COMMISH-APIKEY` and `{"id":"54a0306a-…","reason":"…"}`; reason required; the commissioner key required; no session or "acting as" works) is safe once **Step 1 shows the four columns *and* the discriminator returns the new release marker**. Before Step 1 it returns `503 migration_required` and changes nothing. It is also the only way out of a trade that everyone accepted and the cap is holding.
- **Neither is part of any smoke test.** Cancelling the live trade is Keith's decision. After the release the partners' Discord Accept runs the salary-cap gate: an over-cap accept is **recorded** (consent is kept) and reported; execution is blocked recoverably until the cap allows it.

## 7. What this runbook cannot prove

- Production behavior of MFL's own responses (roster-limit refusals, the salaries import, what MFL's `transactions` export returns for a real trade) — stubbed at the network edge in tests, never exercised against production by design. The reconciliation matcher uses the documented `TRADE` transaction fields; if MFL's real shape differs, reconciliation answers `still_ambiguous` (fail-safe), never a false "executed".
- That the cap authority matches the Front Office **in production after the deploy** — verified by formula, tests and the pre-deploy comparison above; step 2c is the required gate.
- Pending 2-way offers created **before** this release were priced by the old builder; they are re-priced (and refused if different) at the accept but cannot be listed from the commissioner side while MFL's lockout is on. Expired-rookie and loaded (FL/BL) extensions are not priceable and fail closed. The production worker still runs the old code until the release deploy; migrations `0159`/`0160` are unapplied.
- The header's `UPS_RELEASE_SHA` mechanics for the desktop War Room — take the current state at release time.
