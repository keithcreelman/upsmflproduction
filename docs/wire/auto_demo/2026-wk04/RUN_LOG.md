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

(Runs 1-4 above predate #1197; the `landscape:site-order` item cleared once it deployed. The sandbox runs below show only `coffee:kenny`.)

## Chat exclusions, catch-up, CREATE / UPDATE / NOOP (2026-10-08, after Keith's review)

Keith: "The automated preview still exposes the excluded injury post in its editor candidates. Filter it before generating or committing packs and previews, test that exclusion, and demonstrate safe draft-PR creation and update plus catch-up after a missed Mac run."

**Simulated missed run.** `last_run.json` and `last_run_sandbox.json` were set to Mon Oct 5, 11:00 PM ET, as if the Mac had slept through Tuesday, Wednesday and Thursday morning.

| # | Command | Result |
|---|---|---|
| A | `run` (real mode, no `--week`) | `catching up: scheduled run(s) missed since the last run -- Tue Oct 06 10:00 AM, Wed Oct 07 10:00 AM, Thu Oct 08 09:00 AM`. It then built nothing:<br>• **Week 4:** stopped by the repo index (live), the Pages index (live) and Pages HTTP 200. No announcement was found, which matches: Week 4 has not been announced.<br>• **Weeks 3 and 2:** also stopped by their `ups_wire_threads` row and their #league-announcements message.<br>No second issue was built. |
| B | `run --sandbox --code-ref <this branch>` | Same three missed slots. Built Week 4 under the demo id `2026-wk04-ups-center-sandbox`: **created** draft PR #1200, `[SANDBOX demo -- will be closed]`. The PR holds only 3 files: `site/wire/articles/_sandbox/...html` and `docs/wire/auto/<id>/{claims,validation}.json`. The PR body carried "Built late: scheduled run(s) missed ...". Status `ready-with-gaps` (`coffee:kenny`), 0 validation errors. |
| C1 | `--week 4 --no-ingest --chat-since <one day earlier>` | **noop.** The window really widened, but D1 has no owner chat in that day, so no claim moved and nothing was pushed. |
| C2 | `--chat-since 1790686000` (a window reaching back to real chat) | First attempt **BLOCKED** (fail-closed). The validator called a quote link's text altered, because the post itself begins and ends with curly quotes and the check stripped them. A validator bug, fixed in this PR with a regression test. Re-run: **updated** PR #1200 in place. The branch was rebuilt to one commit, and one comment listed the 5 changed claims: `count:candidates` 25→29, `posts:Eric Martel` 0→2, `posts:Josh Martel` 7→9, `posts:Shawn Blake` 10→11, `posts:total` 41→46. Still one PR. |
| D | the same command again | **noop.** Same commit, still one comment, still one open PR for the issue. |

**Where the two ruled-out posts went** (ids 1556369890321899692 and 1557163194651254845, now on `site/wire/data/chat_exclusions.json`). Every output was scanned for their message ids and text: PR #1200's diff, the committed article, the rebuilt Week 4 pack, the local review copy (HTML and PDF), and `status.json`. **Neither appears in any of them.** The local sources snapshot keeps both rows (they still count as posts) with `content: null` and `withheld: "excluded by id (...)"`. The review copy's editor box says "2 message(s) ruled out by an editor or touching family, health or similar were withheld and must not be used", and it lists 25 candidates without them.

PR #1200 was closed by hand after the demo, and its branch was deleted. The automation itself refuses `gh pr close/merge/ready`.
