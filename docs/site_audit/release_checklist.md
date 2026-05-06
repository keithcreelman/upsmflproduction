# Release Checklist — Tier 2 → Tier 3 Promotion

**Version:** v1 (draft, 2026-04-28)
**Owner:** Keith Creelman
**Status:** Draft for review

This checklist is the gate between **Tier 2 (test league `25625`)** and **Tier 3 (prod league `74598`)**. Every PR that touches site / HPMs / Worker / ETL must complete the relevant sections of this checklist before merge.

The PR description copies the relevant section into the body and ticks each box. Unticked items block the merge.

---

## A. Universal checks (every PR)

- [ ] Feature branch named per convention (`<type>/<slug>`).
- [ ] `scripts/validate_release.sh` passes locally.
- [ ] No machine-specific paths (`/Users/`, `Desktop/`, `~/`) in code.
- [ ] No embedded API keys or secrets.
- [ ] No hardcoded league ID `74598` introduced where a configurable value should be used.
- [ ] PR description states: what changed, why, and the **rollback line** (commit hash to revert to + any data restore steps).
- [ ] Severity tagged: Critical / Low / Gray-zone-escalated.
- [ ] If Critical: explicit citation to the `league_context_v1.md` rule(s) the change implements or affects.
- [ ] Inventory CSV(s) updated if a new artifact (HPM, worker route, ETL script) was added or removed.

---

## B. Static site / HPM changes

Required when the PR touches `site/**/*.html`, `site/**/*.js`, `site/**/*.css`, `site/**/*.json`, or any file that ships into an MFL HPM.

- [ ] Change deployed to a test HPM on league `25625` (not prod).
- [ ] HPM rendered in a real browser; no console errors.
- [ ] All API endpoints the HPM calls return successfully when pointed at test-league IDs (or test-Worker URL).
- [ ] If the HPM calls the Worker: verify the Tier-2 Worker URL is in use, not the prod Worker.
- [ ] Visual regression: compare against the prior version. Note any intentional differences in the PR description.
- [ ] **Critical-only:** verify the HPM still enforces the relevant `league_context_v1.md` rule. Specific spot-checks:
  - CCC: 15 cross-section validation rules from Section 2.G.
  - Trade modules: 50%-per-traded-away-player cap, asset requirement, tag locks, MYM-clock-no-reset.
  - Tag tracking: "0 years remaining" eligibility AND "no extension/MYM after tag" lock.
  - Restructure: 3/season cap, 5-loaded roster cap, offseason-only window.
  - Auction: 2/24hr nomination cadence.
- [ ] Mobile rendering check (HPM should render on phone — most owners check on mobile).
- [ ] **72-hour hold elapsed** with no regression reports.

---

## C. Cloudflare Worker changes

Required when the PR touches `worker/src/**/*.js` or adds/modifies `worker/migrations/*.sql`.

- [ ] `wrangler deploy --env preview` succeeded (or equivalent preview deployment).
- [ ] Preview Worker URL captured in the PR description.
- [ ] All affected routes tested with curl/Postman against the preview Worker:
  - GET routes return expected schema.
  - POST routes accept valid payloads and reject invalid ones.
  - Auth-required routes reject unauthenticated requests with 401.
- [ ] D1 migration applied to preview/dev DB; no migration errors.
- [ ] D1 migration is **forward-only safe** (or includes an explicit down migration with rollback steps in the PR).
- [ ] If the change writes to MFL: verified writes go to test league `25625` only during Tier 2; no prod-league write attempts in the test phase.
- [ ] Cron-triggered handlers (`wrangler.toml [triggers]`) tested by manually invoking the scheduled handler against preview.
- [ ] R2 / KV bindings updated only if `wrangler.toml` reflects the change.
- [ ] **Critical-only:** for any route that does cap math or contract validation, manually run the calculation through a known test case (use Section 2 examples from `league_context_v1.md` if available) and confirm the result matches.
- [ ] Rollback strategy documented: previous Worker version retained via `wrangler deployments list` so we can revert.
- [ ] **72-hour hold elapsed** with no regression reports.

---

## D. ETL pipeline changes

Required when the PR touches `pipelines/etl/scripts/*.py`, `pipelines/analytics/*.py`, or `scripts/*.sh`.

- [ ] Dry-run executed against test league `25625` data (or against fixture data).
- [ ] Output written to a temp path (NOT to `site/`) during Tier 2.
- [ ] Diff between temp output and current `site/` JSON: blast-radius is understood (PR notes which fields changed and by how much).
- [ ] If the script feeds an HPM: that HPM still renders correctly with the new output schema.
- [ ] If the script writes to D1: only the test/dev DB is touched in Tier 2. Prod D1 is read-only from Tier-2 ETL runs.
- [ ] No new hardcoded years (e.g., `2024`, `2026`) introduced where `currentSeason` or a config value should be used.
- [ ] Failure mode documented: what happens if the script fails on next scheduled run? Does the site display silently-stale data or surface an error?
- [ ] If the script is a replacement for an older script: the old script is marked deprecated in `site_duplicate_sources_register.csv` with a sunset date.
- [ ] If the script runs via GitHub Actions: workflow file updated; manual `gh workflow run --ref <branch>` succeeded.
- [ ] **Critical-only:** if the script feeds cap math, contract data, or rule-enforcement logic, the diff is reviewed line-by-line for unexpected changes.
- [ ] **72-hour hold elapsed** with no regression reports.

---

## E. GitHub Actions / scheduled jobs

Required when the PR touches `.github/workflows/*.yml`.

- [ ] Workflow YAML linted (`actionlint` or `gh workflow view`).
- [ ] Workflow tested via `gh workflow run --ref <branch>` against test league `25625`.
- [ ] Concurrency group correct (e.g. `log-mym-submission` ensures no double-logging).
- [ ] Retry / failure handling reviewed; no silent failures.
- [ ] Permissions block (`permissions:` in YAML) is the minimum needed (don't grant write where read is enough).
- [ ] If the workflow commits to `main`: the file-restriction guard (like the one in `log-mym-submission.yml`) is in place to prevent accidental commits to unintended files.
- [ ] **72-hour hold elapsed** with no regression reports.

---

## F. Documentation updates

Required for **every** PR — non-negotiable per the documentation gate policy.

- [ ] PR description: the "what / why / rollback / severity" four-line summary.
- [ ] Inventory CSVs updated for any added/removed/renamed artifact.
- [ ] Any new rule enforcement: cite the source line in `league_context_v1.md`.
- [ ] Any deprecation: row added to `site_duplicate_sources_register.csv` with sunset date.
- [ ] If the change introduces new auth, new external API calls, new bindings, or new env vars: `mfl_platform_constraints.md` updated.
- [ ] CLAUDE.md updated if the change introduces new conventions agents should follow.
- [ ] Memory updated if the change is a durable governance decision (use `~/.claude/projects/-Users-keithcreelman-Code-upsmflproduction/memory/`).

---

## G. Smoke test on prod (post-merge)

After merging to `main` and deploying to prod, before closing the PR:

- [ ] Visit the affected HPM/page on prod league `74598` in a browser.
- [ ] Run one minimal happy-path scenario end-to-end (e.g., view a contract, submit a test MYM in the test league mode if applicable, check a standings number).
- [ ] Confirm no console errors, no 500 responses, no missing data.
- [ ] If a regression is detected: trigger rollback per `rollback_runbook.md` immediately. Don't try to forward-fix on main.

---

## H. Optional but encouraged

- Visual diff screenshot in the PR (before/after) for HPM changes.
- Curl transcript for Worker route changes.
- Diff-stat summary for ETL output changes.
- Manual exploratory testing notes for changes touching the high-risk modules listed in the handoff (CCC, trades, tags, restructures, auction, comp picks).
