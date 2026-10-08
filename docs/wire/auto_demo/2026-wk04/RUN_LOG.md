# Demonstration runs: 2026 Week 4 and Week 3 (2026-10-08)

All runs used `pipelines/etl/wire/ups_center_auto.py run` against live sources, from the automation-owned worktree `~/Library/Caches/upsmfl-ups-center-auto/repo`, which is reset to `origin/main` every run.

| # | Command | Result |
|---|---|---|
| 1 | `--week 4 --pr-mode dry` | Full pipeline, `ready-with-gaps`, 0 validation errors. Found the open hand-built Week 4 draft #1195, so the decision was `editor-owned`: would comment, never overwrite. |
| 2 | `--week 4 --pr-mode live` | Same build. Posted **one** re-check comment on #1195 (0 changed claims, 0 quote problems) and pushed nothing. Plus a macOS notification. |
| 3 | `--week 4 --pr-mode live --no-ingest` | Re-run: comment `noop`. Still exactly one re-check comment on #1195, so the run is idempotent. |
| 4 | `--week 3 --pr-mode dry --no-ingest` | `already published or announced -- nothing to build`. The duplicate guard stops it before any build. |

What each Week 4 build did:
1. Duplicate check (not live, not announced).
2. Froze `projection_evidence_2026_wk04.json` and `scores_published_2026_wk04.json`.
3. Ran `elias.py check`: 13 official changes, already included.
4. Confirmed D1 equals MFL for the scores and standings.
5. Ingested chat (incremental), fetched xFP, and ran `wire.py build --pack 2026-wk04-recap`.
6. Took an independent sources snapshot, then rendered and validated.
7. Rebuilt the index and printed a full-issue preview PDF (local).

Validation (`validation.json`): the committed draft passed with **0 errors**, 185 claims checked:
- 12 scores and 12 margins against MFL;
- 12 records, all-play and PF rows against MFL standings;
- 20 projections, each with its capture time before its own kickoff;
- 13 post counts;
- 12 graded preview rows.

The local review copy also validated its 26 candidate quotes, verbatim by message ID. Those quotes are not in the committed draft: raw chat stays off the public repo.

Two editor items:
- `landscape:site-order`: the site still shows Cutting above Mannila until #1197 deploys.
- `coffee:kenny`: Kenny's lines are always an editor's job.

`automated_draft.html` is the generated issue, exactly as the run produced it, kept here for review. It is not under `site/`, so it can never be served.

**Not demonstrated live:** the CREATE and UPDATE paths. Week 4 already has an editor-owned draft, and creating a second one is exactly what the process must never do. Both paths are covered offline in `test_ups_center_auto.py`. The first live CREATE will be Week 5's Tuesday run, if the schedule is approved.
