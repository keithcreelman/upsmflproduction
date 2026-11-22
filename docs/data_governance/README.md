# UPS data governance

Working records for UPS data infrastructure: what data exists, where it comes from, what depends on it, which controls protect it, and what to fix first.

- [`BASELINE_2026-11-21.md`](BASELINE_2026-11-21.md): current-state map, asset inventory, UPS 2.0 gaps, top risks, control plan, decisions needed.
- [`AI_DATA_DEPENDENCIES.md`](AI_DATA_DEPENDENCIES.md): what each AI feature reads, transforms, assumes and produces, with lineage, confidence, freshness, controls and open conflicts with the AI session.
- [`CHANGE_AND_DEPENDENCY_LOG.md`](CHANGE_AND_DEPENDENCY_LOG.md): data changes, findings and decisions that affect other work.
- [`evidence/`](evidence/): file:line evidence behind the baseline (D1 tables, jobs, assets and consumers, controls).

**Rules for these files**
- Public repository: no credentials, private messages, owner-session data or trade notes. Security findings go to Keith's private project only.
- Label conclusions verified, derived, assumed or unknown, with the evidence.
- A finding here is not a fix. Production writes, schema changes, deploys and flag changes need Keith's explicit go.
- Older entries go stale: recheck code, run history and live state before acting on them. Date every update.
- These records supersede the drifted parts of `docs/SCHEDULED_PIPELINE_AUDIT.md` (2026-05-30) and `docs/BACKUP_STRATEGY.md` (2026-04-21); `docs/DATA_AUTHORITY_MAP.md` stays the statement of authority principles.
