# UPS MFL Production

Production system for the UPS Salary Cap Dynasty league (12 teams) on MyFantasyLeague: prod league `74598`, test league `25625`.
A Cloudflare Worker (`worker/`: D1 `ups-mfl-db`, R2, 5 crons) writes to MFL and Discord; GitHub Pages serves `site/`; Python ETL lives in `pipelines/etl/`; 82 GitHub workflows.
Real owners and real cap dollars. Most bugs here are data bugs that reach production quietly. Keith has final say.

## Where things live
- `worker/src/index.js`: a ~60K-line monolith holding every HTTP route, the `scheduled()` cron handler and shared helpers. High blast radius.
- `worker/src/*.js`, `worker/src/lib/`: extracted modules (trades, waivers/FCFS, auction, cap math, Discord, `feature_flags.js`).
- `worker/migrations/NNNN_*.sql`: the D1 schema. Numbering has duplicates. Read `worker/migrations/README.md` before adding a migration.
- `worker/wrangler.toml`: crons, bindings, feature-flag defaults. `worker/wrangler.preview.toml` binds the **same prod D1 and R2**, so it is not a sandbox.
- `site/`: Pages content. Desktop hubs are `hpm-*.html`, `rosters/`, `trades/`, `rookies/`, `standings/`, `commish/` and others; the mobile PWA is `site/m/`; shared JS is `site/shared/`.
- `header_custom_v2.html`, `footer_custom_v2.html` (repo root) load on every MFL page. Keith pastes them into MFL by hand.
- `pipelines/etl/{scripts,lib,wire}`: Python ETL, contract and repair builders, and The Wire. `services/{rulebook,mcm}`: small Python APIs.
- `scripts/`: repo checks (`check_*`), `ci_*.py` helpers that workflows call, cron and launchd installers, and repair scripts.
- `tests/`: 117 plain-Node test files. `tests/fixtures/worker_harness.mjs` runs the real worker on `node:sqlite` with MFL, Discord and GitHub stubbed.
- `data/`: committed MFL snapshots, repair evidence and archives. `incidents/`: post-mortems.
- `docs/league_context_v1.md` is the league-rules canon. It is about 3,100 lines and gets bundled into the worker, so grep it; do not read it whole.

## Commands (run from the repo root; Node 22.5+ for `node:sqlite`, and python3)
Tests have no framework and no runner. Each file is a script that exits non-zero on failure:
```bash
node tests/<name>.test.mjs                       # one suite
for f in tests/*.mjs tests/*.js; do node "$f" >/dev/null 2>&1 || echo "FAIL $f"; done   # full sweep, ~2 min
```
Baseline on `origin/main` `99e335d1` (2026-10-05): 113 of 117 files pass. Four failures are known and already on main:
`leaderboard_cache_ttl`, `leaderboard_precompute`, `lineup_compliance`, `lineup_wiring`. Any other failure was caused by your change.
`deployed_clients_compat.mjs` prints SKIPPED unless `DEPLOYED_DIR` is set. Some tests extract functions **verbatim** from
`worker/src/index.js` by string search, so renaming a route or helper can break a test in a different area.

Static checks. The first six pass on main, and CI runs them when matching paths change. The last two are for your own diff:
```bash
(cd worker && npx --yes eslint@9 src/)           # no-undef gate; the worker deploy is blocked on it
node scripts/check_inline_js.mjs                 # inline <script> syntax in site/
node scripts/check_mfl_paste_safety.mjs          # header/footer: tags MFL rejects
python3 scripts/check_mobile_build.py            # site/m version stamps agree
python3 scripts/build_rulebook_data.py --check   # rulebook data matches league_context_v1.md
python3 pipelines/etl/wire/wire.py verify        # The Wire invariants
node --check <changed.js>                        # every JS file you touched
git diff --check origin/main...HEAD
```
Local worker dev: use the test harness. `cd worker && npm run dev` (wrangler dev) uses a local D1, but with a filled-in
`worker/.dev.vars` it calls the **live** MFL league and Discord, so treat it as production. `scripts/validate_release.sh`
currently fails on main (absolute paths and `APIKEY=` strings in committed files), so it is not a usable gate.

## Non-negotiable rules
1. **No hand-typed production writes.** Never send a `curl`/`fetch`/POST to MFL import endpoints or to worker write routes
   (`/admin/*`, `/commish-*`, `/api/*` writes). Never run `wrangler d1 execute --remote` for a write, `wrangler d1 migrations apply --remote`,
   `wrangler deploy` or a one-off script against prod. Never dispatch a repair or write workflow. Why: in
   `incidents/2026-07-27-contract-year-rollback.md`, an inline curl "AAV fix" also reset `salary` and `contractYear` on 3 contracts
   to Year 1. That put $26,000 of phantom cap charges on the books mid-auction, and nobody noticed for 4 days.
2. **The only production write path a session may use** is a committed, reviewed script or route that has all of these:
   (a) a dry run as the default, with writes needing an explicit flag (`--apply --yes`);
   (b) a before/after diff of **every field on every affected row** (`salary`, `contractYear`, `contractStatus`, `contractInfo`, ...),
       not only the field you meant to change;
   (c) Keith's explicit per-row approval;
   (d) a post-write re-read that verifies all of those fields again, plus proof that rows outside the plan did not change.
   Carry live values through untouched. Never rebuild a row from a template, a year list or a prior season.
   Reference pattern: `scripts/full_year_earned_repair.mjs` (dry-run default, `--apply --yes --season`, `unchanged_proof`).
3. **Contract changes follow the Contract Change Gate** (`docs/CHANGE_PLAYBOOK.md` §0). Read the relevant canon section first;
   never derive a rule from memory or from code (the code holds drifted copies). MFL `salary` is the current-year salary and
   `contractYear` is the number of years remaining. Preserve the `contractInfo` tokens (`CL`, `TCV`, `AAV`, `Y1..Yn`, `-FL`/`-BL`)
   instead of recomputing them. AAV is not TCV/CL.
4. **Merging to main deploys** (see below). Do not push, merge or open PRs unless Keith asks.
5. **Reads are fine; secrets are not.** GET exports and D1 `SELECT`s are allowed. Never print or commit cookies, API keys, PATs,
   bot tokens or signed URLs; refer to them by variable name only.
6. **Discord:** use dry_run and test channels. Never post to the league or DM owners from a dev session.
7. **Surgical edits.** Do not rewrite files, change architecture silently or remove working logic. Ask when unsure.
   Displayed numbers use thousands separators (`3,046`). Franchise ids are 4-digit strings (`"0001"`) and player ids are strings.
   Times are stored in UTC and rendered in ET.
8. **Work in a git worktree** (`.claude/worktrees/` is gitignored) because the main checkout is often dirty. Use one branch per feature,
   named `<bucket>/<kebab-feature>` (`fix/`, `fo/`, `trade/`, `infra/`, `docs/` ...), and keep the branch name free of version suffixes.
   Before you edit a high-blast-radius file, run `git worktree list`, check open PRs and run `git log --oneline -10 -- <file>`.
   High-blast-radius files: `worker/src/index.js`, the header/footer, `site/loader.js`, `site/shared/*.js`,
   `site/rosters/mflscripts_rosters_fork.js`, `site/rosters/ups_trade_offer_patch.js`, `worker/src/discord_round.js`,
   `worker/src/lib/cap_penalty.js`. A run of recent `fix` commits on a file means you are about to undo someone's fix.

## Data authority (who wins when sources disagree)
- **MFL wins** for everything its API exposes: rosters, `salary`/`contractYear`/`contractStatus`/`contractInfo`, transactions,
  draft picks, league settings and divisions, injuries, schedule and scores. D1 tables and committed snapshots are mirrors or
  backups. Flag drift; never let the copy win.
- **UPS owns** only what MFL cannot model: league rules (`docs/league_context_v1.md`), contract derivation math
  (TCV, earned, guarantee, cap hit), audit trails (`ups_*` submission tables) and the standings ranking and seeding layer.
- Cap penalties: UPS computes the amount. Once it is posted to MFL `salaryAdjustments`, MFL's value is authoritative.
- External sources (nflverse/PFR advanced stats, ADP feeds) are authoritative for their own data.
- On a rules question, `league_context_v1.md` beats code. On how the system behaves, code beats `docs/`, much of which is stale.
- Full table: `docs/DATA_AUTHORITY_MAP.md`.

## Deploy path
- **Worker:** any push to main that touches `worker/**` or `docs/league_context_v1.md` auto-deploys through
  `.github/workflows/deploy-worker.yml`. That job runs `npm ci`, the eslint gate and `wrangler deploy`. **CI does not run `tests/`**, so run the sweep before merging.
- **Site:** a push touching `site/**` or the header/footer triggers `pages-deploy.yml` to https://keithcreelman.github.io/upsmflproduction/
  (`purge-jsdelivr.yml` also purges the jsDelivr cache). Keith pastes the header and footer into MFL's Home Page Messages himself.
- **Mobile (`site/m`):** bump `version.json`, `app.js` `BUILD` and the `index.html` `?v=` stamps together (`check_mobile_build.py` enforces this).
- **D1 schema:** add a new numbered file in `worker/migrations/`. Keith applies migrations to the remote DB.
- **PR checks:** lint-site-inline-js, check-mfl-paste-safety, mobile-build-check, check-wire, rulebook-build, lint-rule-integration-pr.
- `origin/main` moves several times a day from bot commits (`Auto-refresh ...`, `data(mfl-snapshot): ...`). Fetch and rebase before you merge.
- Workflows: 17 run on cron and about 49 are manual-dispatch only, many of them one-off prod repairs or diagnostics. Dispatch one only when Keith asks.

## Feature flags and kill switches
- Flags are registered in `worker/src/feature_flags.js` (`FEATURE_FLAGS`). The default comes from `wrangler.toml` `[vars]`.
  The **live value is the D1 override** `ups_settings` key `feature_flags`, which Keith toggles in `site/commish/commish_settings.html`.
  Never infer live state from `wrangler.toml`.
- Flags fail closed: if the override cannot be read, every flag is OFF. Flags marked `danger: true` gate real MFL writes or
  league-wide posts (`TRADE_3WAY_EXECUTE`, `DROP_TRACKER_POST_MFL`, `WAIVERS_INAPP_ENABLED`, `ERA_AUTODROP_ENABLED`, ...). Never flip one.
- A new risky feature ships dark behind a new flag registered in `FEATURE_FLAGS`, with a `dry_run` path.
- Cloudflare is on the **Free plan**: 10 ms CPU per request and a D1 budget of 5M rows read per day. Expensive queries or heavy cron
  work will break production.

## Where current work is tracked
- Open PRs (`gh pr list`), active worktrees (`git worktree list`) and GitHub issues.
- `docs/CLEANUP_BACKLOG_2026_OFFSEASON.md` (structural risks; item 1 is the July incident follow-up) and `docs/AUDIT_FOLLOWUP_TRACKERS.md`.
- Feature runbooks: `docs/TRADE_WAR_ROOM.md`, `docs/FCFS_HOTFIX_RUNBOOK.md`, `docs/MOBILE_DRIFT_PREVENTION.md`.
  Rule history: `docs/league_context_changelog.md`.
- **Stale, do not trust:** `docs/CURRENT_WORK_HANDOFF.md` (May 2026), `PROJECT_STATE.md`, `TASKS.md`, `AI_HANDOFF.md`, `REPO_MAP.md`,
  `DEVELOPMENT_WORKFLOW.md`, `OPERATIONS_RUNBOOK.md`, `RELEASE_CHECKLIST.md` and `API_GUIDE_FOR_CLAUDE.md` (its paths point to
  `~/Documents/New project`). `docs/CLAUDE_SYSTEM.md`'s "avoid GitHub Actions / prefer manual deploy" rule no longer matches the repo.
