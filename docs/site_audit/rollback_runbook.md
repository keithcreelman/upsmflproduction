# Rollback Runbook — UPS MFL Site / HPMs / Worker / ETL

**Version:** v1 (draft, 2026-04-28)
**Owner:** Keith Creelman
**Status:** Draft for review

When a prod change breaks something, **rollback first, diagnose second.** This runbook lists the standard rollback procedures for each surface so we don't lose minutes deciding what to do.

> **Principle:** restoring a known-good state is always preferable to a forward-fix under pressure. Every PR's description includes a rollback line specifically so we don't have to figure this out at 11pm during the MYM window.

---

## 0. Decide: rollback or forward-fix?

Default to **rollback** if any of these are true:
- The break affects a Critical surface (cap, contracts, trades, tags, restructures, MYM, auction).
- More than one owner is impacted.
- The break is during a time-sensitive window (MYM, restructure window, auction).
- The fix is non-obvious or would take more than 15 minutes.
- It's after-hours and Keith isn't available to review a forward-fix PR.

Default to **forward-fix** only if all of these are true:
- The break is on a Low-severity surface (cosmetic).
- The fix is one or two lines and obvious.
- Keith is available to approve the fix PR within minutes.

When in doubt: rollback.

---

## 1. Static site asset rollback

Symptom: a `site/*.html`, `site/*.js`, `site/*.css`, or `site/**/*.json` change broke a page.

### Steps

1. **Identify the merge commit** that introduced the bad change:
   ```sh
   git log --oneline --first-parent main -- site/path/to/file
   ```
2. **Revert the merge commit:**
   ```sh
   git checkout main
   git pull
   git revert -m 1 <merge-commit-sha>
   git push origin main
   ```
3. **If the static assets are served from a CDN / external host** (e.g. GitHub Pages, Cloudflare Pages, R2): trigger a redeploy against the post-revert `main` and wait for cache invalidation.
4. **If the asset is also embedded directly in an MFL HPM body**: copy the post-revert file content back into the MFL HPM config manually. (This is the gotcha — site repo and MFL HPM body can drift if you only revert one.)
5. **Verify on prod league `74598`** that the page renders correctly.
6. **Open a fresh PR** with the actual fix (don't try to amend the revert).

### Common gotchas

- HPM-embedded HTML/JS doesn't auto-update from the repo — rolling back the file in git doesn't fix the live HPM until the HPM body is also reverted.
- Browser/CDN caches can mask a successful rollback. Hard-refresh (Cmd+Shift+R) and check `?_=<timestamp>` busters where used.
- Some HPMs use the `loader.js` pattern that fetches from a CDN — rollback may need a cache purge there too.

---

## 2. Cloudflare Worker rollback

Symptom: a Worker deploy broke a route, the cron handler is failing, or a migration corrupted D1 data.

### Steps for code rollback

1. **List recent Worker deployments:**
   ```sh
   cd worker
   wrangler deployments list
   ```
2. **Roll back to the previous version:**
   ```sh
   wrangler rollback <deployment-id>
   ```
   (Or, if `rollback` is unavailable, redeploy from the prior commit:)
   ```sh
   git checkout <prior-good-sha>
   wrangler deploy
   git checkout main  # don't leave repo in detached HEAD
   ```
3. **Verify** the affected route returns correctly (`curl https://<worker-host>/<route>`).
4. **Open a fresh PR** with the fix, including a regression test if possible.

### Steps for D1 migration rollback

D1 migrations are **forward-only by default**. There is no automatic down-migration. The rollback strategy depends on what the migration did:

- **Schema-only change (added column, added table):** usually safe to leave the schema in place even after rolling back code. Code rollback alone is enough.
- **Data-mutating migration (renamed column, dropped column, modified rows):** restore from the latest D1 backup in R2.
  ```sh
  # The Worker's scheduled() handler at 09:05 UTC writes daily MFL snapshots to
  # R2 bucket `ups-mfl-backups`. For schema rollback, use the most recent SQL
  # dump if one exists, OR restore D1 from the prior day's daily backup.
  wrangler d1 export ups-mfl-db --output rollback-current-state.sql
  # ...inspect, decide, then either:
  wrangler d1 execute ups-mfl-db --file rollback-known-good.sql --remote
  ```
- **If no usable backup exists:** escalate to Keith. Manual data reconstruction may be needed; the league should be put in a "read-only" comm state (post in Discord) until resolved.

### Common gotchas

- `wrangler rollback` rolls the Worker code but NOT D1 schema or data. Plan for both.
- The cron-triggered scheduled handler runs every hour at `:05` past — if a bad cron handler shipped, it may have already executed. Check the recent execution log via Cloudflare dashboard.
- The `salaryAdjustments` ledger on MFL is the canonical record — D1 is a cache. Restoring D1 doesn't roll back actual MFL state.

### MFL-side state to consider

If the Worker wrote to MFL (e.g. posted a cap penalty via `/admin/import-drop-penalties`), rolling back the Worker doesn't undo the MFL post. Check MFL's salary adjustment history for unexpected entries with `ups_drop_penalty` ledger keys and remove them manually if they were erroneous.

---

## 3. ETL pipeline rollback

Symptom: an ETL script wrote bad data into a `site/**/*.json` file and that JSON is now being served to owners.

### Steps

1. **Identify the bad output file** and the script that wrote it.
2. **Restore the JSON from git** to the version before the bad run:
   ```sh
   git log --oneline -- site/path/to/output.json
   git checkout <prior-good-sha> -- site/path/to/output.json
   git commit -m "rollback(etl): restore <file> to <prior-sha>"
   git push origin main
   ```
3. **Disable the broken script's schedule** (comment out the cron in `.github/workflows/<name>.yml`, push the change) until the underlying bug is fixed. Otherwise the next scheduled run will overwrite the rollback.
4. **Verify on prod** that the consuming HPM renders correct data again.
5. **Open a fresh PR** with the actual ETL fix; re-enable the workflow there.

### Common gotchas

- Some ETL scripts UPSERT directly to D1 (per the planned `direct_to_d1_etl_plan.md`). For those, rollback also requires a D1 restore — not just a git checkout of the JSON.
- If the bad data has been propagated to MFL via a Worker route, rolling back the JSON doesn't undo the MFL writes. See section 2's "MFL-side state" note.
- Check `.github/workflows/refresh-*.yml` — these auto-run on schedule and will overwrite manual rollbacks.

---

## 4. MFL HPM config rollback

Symptom: the MFL HPM body itself was edited to bad content (regardless of what's in the repo).

### Steps

1. **Get the prior good content** from the repo (whichever HPM file is the canonical source — likely `site/hpm-*.html` or one of the embed loaders).
2. **Log into MFL admin** for league `74598`, navigate to `Setup > League > Home Page Modules`.
3. **Replace the HPM body** with the prior good content.
4. **Save and verify** the HPM renders correctly on the league home page.
5. **Open a fresh PR** to fix whatever caused the bad content to be deployed (likely a missing checklist item or a process gap — capture that in the PR).

### Common gotchas

- MFL doesn't have HPM version history. Once you save, the prior content is gone unless you have it in git or a screenshot.
- **Always grab a snapshot of the HPM body before editing it in MFL.** This should be in the PR description per the workflow's documentation gate.
- Some HPMs are loaded via `mfl_hpm_embed_loader.js` — those are thin shims and the actual content is in the repo. Others are static HTML pasted directly into the HPM body. Rollback procedure differs.

---

## 5. GitHub Actions rollback

Symptom: a scheduled workflow is failing or producing bad commits.

### Steps

1. **Disable the workflow immediately** to stop further damage:
   ```sh
   gh workflow disable <workflow-name>
   ```
2. **Identify the bad workflow file change** and revert it via standard PR-revert flow.
3. **Roll back any commits the bad workflow made** to `main`:
   ```sh
   git log --author="github-actions" --oneline | head -10
   git revert <bad-commit-sha>
   git push origin main
   ```
4. **Re-enable the workflow** after the fix lands:
   ```sh
   gh workflow enable <workflow-name>
   ```

### Common gotchas

- Workflows that auto-commit to `main` (like `log-mym-submission.yml`) can produce a long chain of bad commits if not caught quickly. Disable first, then revert.
- The file-restriction guard in `log-mym-submission.yml` (lines 41-47) refuses to push if unexpected files were modified — verify all auto-committing workflows have a similar guard.

---

## 6. Communication during a rollback

If the break is owner-visible (i.e. any Critical-severity issue):

1. **Post in Discord** (whichever channel the league uses) within 5 minutes of detecting the break: "Aware of issue with [feature]. Rolling back. Will update when resolved."
2. **Don't make excuses or speculate** about cause until rollback is complete and verified.
3. **Post resolution** when verified: "Rolled back. [Feature] should be working — let me know if you still see issues."
4. **Post root cause + prevention** within 24 hours, in the same channel: "RCA: [what broke and why], [what we're changing to prevent recurrence]."

---

## 7. After every rollback

- Update `docs/site_audit/site_audit_findings.md` with a new finding documenting the gap that allowed the bad change through Tier-2 vetting.
- Update `release_checklist.md` if a new check should have caught it.
- Update the relevant inventory CSV if the rollback revealed a misclassified artifact.
- If the rollback exposed a missing test, add it to the enhancement parking lot (`site_enhancement_proposals.md`).

---

## Cross-references

- `release_workflow.md` — the three-tier release flow this runbook is the safety net for
- `release_checklist.md` — the checks that should have prevented the rollback
- `~/.claude/projects/-Users-keithcreelman-Code-upsmflproduction/memory/site_audit_governance.md` — durable governance facts
- `worker/wrangler.toml` — Worker bindings and cron config (relevant for Worker rollback)
- `.github/workflows/` — workflow files (relevant for Actions rollback)
