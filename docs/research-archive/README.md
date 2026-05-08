# Research archive

One-shot research artifacts kept for traceability. **Not actively read** by any worker code or production system.

## Contents

### Divisional co-tenancy history (May 2026)
Computed which owner pairs have shared a division historically and the rolling 3-year All-Play percentages used as input for the captain-based realignment proposal.

- `owner_pair_division_history.py` — script that read franchises + standings from local mfl_database.db and produced the analysis
- `owner_pair_division_history.csv` — raw pairwise tally
- `owner_pair_division_history.md` — formatted summary
- `owner_divisional_history_for_context.md` — final markdown that was merged into [`league_context_v1.md`](../league_context_v1.md) as the "Divisional Co-tenancy History" appendix

**Future:** A D1 table for historical divisional + AP% reference is planned (per Keith, May 2026). When that lands, this archive becomes the import seed.
