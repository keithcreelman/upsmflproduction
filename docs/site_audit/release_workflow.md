# Release Workflow — UPS MFL Site / HPMs / Worker / ETL

**Version:** v1 (draft, 2026-04-28)
**Owner:** Keith Creelman
**Status:** Draft for review — produced as Phase 6 of the comprehensive site audit (handoff: `~/.claude/plans/ups_site_audit_handoff.md`)

This document defines the **three-tier release flow** for any change to the UPS league site, MFL Home Page Modules (HPMs), Cloudflare Worker, or ETL pipelines. The goal is simple: **no change reaches the prod league `74598` without being vetted on the test league `25625` first.** Keith's directive — "protect me from me."

---

## 0. Scope — what this workflow governs

Every change to any of these surfaces follows this workflow:

| Surface | Examples | Tier-2 test target |
|---|---|---|
| Static site assets | `site/*.html`, `site/*.js`, `site/*.css`, `site/**/*.json` | Render in test HPM on league `25625` |
| MFL HPMs | Live HPM config on prod league `74598` | Mirror config on test league `25625` |
| Cloudflare Worker | `worker/src/**/*.js`, `worker/migrations/*.sql` | Worker preview deployment + remote D1 dev DB |
| ETL pipelines | `pipelines/etl/scripts/*.py`, `pipelines/analytics/*.py`, `scripts/*.sh` | Run against test league `25625` data; outputs land in `/tmp` not `site/` |
| GitHub Actions | `.github/workflows/*.yml` | Triggered manually with `--dry-run` flag or against test league |

**Out of scope** (changes that don't need this workflow):
- Documentation-only edits under `docs/` that don't change behavior. (They still get a PR; they just don't need test-league validation.)
- Memory files under `~/.claude/projects/.../memory/`.
- Plan files under `~/.claude/plans/`.

---

## 1. Tier 1 — Local development

**Where:** the developer's local checkout.

**Rules:**
- All changes start on a feature branch — never directly on `main`.
- Branch name follows the convention used for `docs/league-context-v1`: `<type>/<slug>`. Types: `feat`, `fix`, `docs`, `chore`, `refactor`, `data`. Example: `feat/ccc-tag-validation`, `fix/restructure-cap-check`.
- Local sandbox or local file fixtures only. **No live MFL API calls** unless explicitly behind a `--dev` or `--dry-run` flag.
- Local D1 dev database only (`wrangler d1 ... --local`). Never apply migrations to remote D1 from a Tier-1 environment.
- Run `scripts/validate_release.sh` before pushing — it checks for embedded API keys, absolute machine paths, and Python syntax errors.

**Done definition for Tier 1:**
- Code compiles / Python files import cleanly.
- `scripts/validate_release.sh` exits clean.
- Manual smoke test in local browser (for HPM-touching changes) or local CLI run (for ETL).
- Commit with a descriptive message; push the feature branch to GitHub.

---

## 2. Tier 2 — Test league (`25625` on `www48.myfantasyleague.com`)

**Where:** an alternate MFL league Keith maintains for vetting.

- League URL: `https://www48.myfantasyleague.com/2026/home/25625`
- League ID: `25625`
- Host: `www48.myfantasyleague.com`
- Year: `2026`

**Rules:**
- Promote to Tier 2 by **opening a GitHub PR** from the feature branch into `main`. Same flow as PR #8 (`docs/league-context-v1`): iterative commits, push, PR review.
- The PR description **must declare** which Tier-2 validation steps were run and what the results were. (See `release_checklist.md` for the validation list.)
- For HPM changes: deploy the changed asset(s) to the test league's MFL HPM config. **Never copy from `main` to the test league while the PR is unmerged** — the test league should reflect *the PR branch*, not main.
- For Worker changes: deploy a preview Worker (`wrangler deploy --env preview`) bound to a test D1 (or remote D1 with read-only assertions). Test league HPMs configured to call the preview Worker URL.
- For Worker migrations: apply to remote D1 dev / preview environment first. Never to the prod D1 without explicit "promote" approval.
- For ETL changes: dry-run against test league `25625` data. Outputs go to a temp path, NOT to `site/`. Diff the temp output against the current `site/` JSON to assess blast radius.
- **Hold for 72 hours minimum** before promoting to Tier 3. Reason: gives time to spot regressions, async data drift, second-order effects.
- **Hardcoded league ID gotcha:** as of 2026-04-28, prod league `74598` is hardcoded in many files (`site/hpm-standings.html`, `site/ups_options_widget.js`, `site/rosters/roster_workbench.js`, `site/rosters/player_acquisition_lookup_2026.json`, `site/champions_panels.json`, etc.). For Tier-2 testing of those files, either (a) parameterize the league ID via URL param/config before the test, or (b) maintain a `tier2-overlay/` directory with `25625`-substituted copies of the affected files. **Track this as Phase 5 duplicate-source/configuration finding.**

**Done definition for Tier 2:**
- All items in `release_checklist.md` pass.
- 72-hour hold elapsed without regressions reported.
- PR review completed by Keith with explicit "promote" approval.
- No new commits on the PR branch since Tier-2 validation finished. (Any new commit resets the 72h clock.)

---

## 3. Tier 3 — Prod league (`74598`)

**Where:** the live UPS league.

- League URL: `https://www48.myfantasyleague.com/2026/home/74598`
- League ID: `74598`
- Host: `www48.myfantasyleague.com`

**Rules:**
- Promote ONLY by **merging the PR into `main`**. No direct prod commits, no manual file copies, no out-of-band MFL HPM config edits.
- After merge, deploy:
  - Static site assets: pushed to wherever site assets serve from (verify the path during inventory).
  - HPM content: copy the merged file content to MFL prod HPM config. Capture before/after snapshot of the MFL HPM body in the PR description.
  - Worker: `wrangler deploy` (production environment).
  - Worker migrations: `wrangler d1 migrations apply ups-mfl-db --remote`.
  - ETL: GitHub Actions schedule will pick up the new code on next run; or manually trigger via `gh workflow run` with explicit confirmation.
- **Every prod deploy includes a rollback line in the PR description.** See `rollback_runbook.md` for the standard rollback procedures.

**Done definition for Tier 3:**
- Merge to `main` complete.
- Deploy artifact in place (Worker version published, HPM updated, ETL run succeeded once).
- Smoke test on prod league passes (a minimal "feature works for one team in one scenario" check).
- PR closed with deploy timestamp + rollback hash recorded in the merge commit body.

---

## 4. Severity model — what blocks prod

Per Keith's 2026-04-28 directive, severity is a two-tier model:

| Severity | Definition | Action |
|---|---|---|
| **Critical** | Anything that impacts league functionality — cap math, contract validation, trade enforcement, tag eligibility, restructure caps, MYM clock, auction nomination cadence, scoring rules, draft order, roster construction, fee/payout tracking, Calvin Johnson Rule comp picks, eligibility windows. | **Blocks prod merge.** Must be fixed (not deferred) before the PR can be promoted. |
| **Low** | Cosmetic only — visual polish, copy edits, layout tweaks that don't change any behavior or displayed-fact accuracy. | Doesn't block; track in `site_enhancement_proposals.md`. |
| **Gray zone** | Anything in between (e.g. display-only data staleness on a non-functional widget). | Escalate to Keith for tagging. Do not silently file as "Medium." |

---

## 5. Re-audit cadence

**Weekly.** Every Monday (or first business day of the week), re-run:

1. The Phase 2 inventory CSVs (`_inventory_site.csv`, `_inventory_worker.csv`, `_inventory_etl.csv`) — to catch any artifact drift since last week.
2. The Phase 4 freshness CSV (`site_data_freshness.csv`) — to flag any data source that's gone stale beyond its expected window.
3. The Phase 3 violations check (`site_audit_findings.md`) — focus on any HPM or worker route that changed in the last 7 days; re-validate against `league_context_v1.md` Sections 1-6.

**Outputs:**
- Diff report: `docs/site_audit/weekly/site_audit_diff_YYYY-MM-DD.md` — what changed since last week, what's new, what's removed.
- New findings only — don't repeat unchanged Critical/Low items in every weekly report.

The weekly run can be a GitHub Action (after we wire it up) or a manual Claude Code session triggered by Keith. Either way, the diff report becomes a first-class deliverable that Keith can scan in 5 minutes.

---

## 6. Documentation as a gate

Per `docs/ups_v2/V2_GOVERNED/governance/documentation_gate_policy.md`: **no cutover without docs.**

For this workflow, "docs" means:
- Every PR's description includes: what changed, which Tier-2 validation steps were run, the rollback line.
- Any new HPM, worker route, or ETL script gets a row in the appropriate inventory CSV in the same PR.
- Any new rule enforcement gets a citation back to `league_context_v1.md` Section 1-6.
- Any deprecation gets recorded in `site_duplicate_sources_register.csv` with a sunset date and the migration path.

If a PR doesn't carry the doc updates, it doesn't merge. No exceptions.

---

## 7. Authority and overrides

Keith is the final decision-maker for promotion to Tier 3. The workflow defaults are designed to surface decisions, not bypass them. Any of these defaults can be overridden by Keith on a per-change basis with an explicit override note in the PR:

- "Override 72h hold: emergency hotfix for [specific issue], Tier-2 smoke test sufficient." — but only for genuine emergencies (e.g. broken MYM submission during the MYM window).
- "Override critical-blocker: [specific reason]" — extremely rare, documented in the merge commit, requires Keith to type the override phrase literally.

The `claude-code` agent assisting Keith **does not have authority to override** these defaults. If a Tier-2 step is failing or skipped, the agent must surface it for Keith's decision rather than waving it through.

---

## Cross-references

- `release_checklist.md` — concrete Tier-2 → Tier-3 validation checklist
- `rollback_runbook.md` — what to do if a prod change breaks something
- `~/.claude/projects/-Users-keithcreelman-Code-upsmflproduction/memory/site_audit_governance.md` — durable governance facts
- `docs/ups_v2/V2_GOVERNED/governance/documentation_gate_policy.md` — pre-existing documentation gate
- `docs/ups_v2/V2_GOVERNED/governance/artifact_promotion_runbook.md` — pre-existing V1→V2 promotion (this workflow is the test→prod analogue)
