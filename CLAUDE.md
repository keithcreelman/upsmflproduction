# UPS MFL production: Claude project instructions

This public repository is the UPS platform source. Do not store private chat, credentials, owner-session data, or personal notes here. Read `docs/WORK_OPERATING_SYSTEM.md` for the workflow. Read the relevant section of `docs/league_context_v1.md` before changing a league rule or contract calculation. Older handoff/status documents may be stale; verify code, GitHub PR state, and live state before stating what is deployed.

## Start each task
- Identify the UPS issue or PR and the desired owner outcome. Classify it as a **fix**, **enhancement**, **data discrepancy**, or **rule decision**. Do not fold unrelated work into the same PR.
- Check current `main`, the target branch, dirty files, open PRs and worktrees touching the same files. Preserve other sessions' changes. Use isolated worktrees for independent edits.
- Write a short definition of done and a phone-review plan before building a UI change. Continue routine work without repeatedly asking Keith to approve implementation details.
- Use parallel agents for independent evidence or reviews. Give each a bounded task and one integrator; avoid simultaneous edits to shared files.

## Verification and release
- Fix: reproduce, change the smallest safe path, test the actual behavior, show before/after evidence.
- Enhancement: explain the owner need, compare viable designs, build one focused draft, then provide an interactive preview Keith can open on a phone.
- Data discrepancy: report source, timestamp, scope and examples. Do not quietly rewrite pipelines or production data.
- For UI: provide a phone-openable HTTPS preview of the real interaction, plus screenshots at 320px and 375px. A screenshot alone is not an interactive preview. State when authenticated MFL behavior or real Safari was not verified.
- For any contract change follow the standing gate in `docs/CHANGE_PLAYBOOK.md` §0. Never use a dry run as proof that an endpoint has no side effects.
- Before claiming release, distinguish local tests, CI, deployed asset/worker, and authenticated owner behavior. Do not perform a real roster, cap, trade, or Discord write as a smoke test.
- Keep draft PRs reviewable. Present the exact diff, preview, test result, and remaining risk before merging or publishing. Keith makes league-rule, production-setting, financial-data, publication, and final release decisions.

## Database queries (D1): efficiency is required
Production D1 is shared and metered. Keith wants to return to Cloudflare's Free plan: 5M rows read and 100k rows written per day. Write every query and every write as if that limit applies. Rules and examples are in `docs/D1_QUERY_RULES.md`. The essentials:
- **Measure before shipping** a new or changed query: `rows_read` from `wrangler d1 execute ups-mfl-db --remote --json --command "…"` (meta) and `EXPLAIN QUERY PLAN`. Filter and join only on indexed columns. Over ~100k rows per run needs an index, a precompute or a stored copy, and a note in the PR.
- **Write only what changed.** Don't rewrite finished seasons or unchanged rows; every upserted row and index entry counts as written.
- **No production D1 by default** in tests or scripts. Production access is an explicit opt-in (the #1239 pattern).
- **Check usage** with `python3 scripts/d1_usage.py`. The Free-plan budget is its exact account-wide counter for the current UTC day (resets 00:00 UTC). Its per-query list is Cloudflare's sampled estimate (one 1-in-145 sample read as "145 runs" in #1354): never add it up or quote it as usage.

## Reply format
1. **Plain English:** what an owner will notice.
2. **Technical why:** source → transformation → storage → API → UI, and why this design.
3. **Preview and proof:** link Keith can open on his phone, test evidence, exact unverified areas.
4. **Decision needed:** one concrete choice with a recommended option, or "none".

Keep this file short. Put current task state in GitHub issues/PRs, not here. At the end of a session, update the relevant issue or PR so a new session can resume from facts rather than a transcript.
