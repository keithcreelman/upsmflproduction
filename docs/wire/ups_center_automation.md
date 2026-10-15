# UPS Center: scheduled draft builder

**Status:** PROPOSAL (draft PR). The schedule is **not installed**. `scripts/install_ups_center_auto.sh` only prints the plist unless it's run with `--install`, after Keith approves.

## What Keith asked for (2026-10-08)

> "Build a scheduled process that, after a week finishes, gathers MFL results, the corrected D1 standings, player scoring, saved pre-kickoff projections, expected fantasy points, league chat, transactions and any Elias changes. It must create or update one reviewable draft PR and rendered preview for that week in the actual UPS Center format … Make the process idempotent … Validate every score, record, projection timestamp, quote link and derived claim against its source … it should never publish or post on its own."

## Proposed schedule

The schedule is a LaunchAgent on Keith's Mac, `com.upsmfl.ups-center-auto`, like the live sync. All times are local.

| When | Why |
|---|---|
| **Tue 10:00** | First draft. The week ended Monday night, and the 01:00 live sync has settled D1. This run freezes the projection evidence before Wednesday's projection ingest re-stamps the week (`mfl_projection_ingest_wednesday_overwrite`). |
| **Wed 10:00** | Retry or update. xFP and a late D1 settle often land by then. |
| **Thu 09:00** | Elias update, after the 08:00 live-sync refresh. Same PR, with the changed claims listed. |
| **Fri 09:00** | A second look for Elias. |
| **At login** | `RunAtLoad`: a Mac that was off or asleep through a slot catches up when it starts. |

**Catch-up.** Each run builds the latest finished week **and the two before it** (newest first). A week already live stops at the duplicate check, so this costs one lookup per week. The run also compares `last_run.json` with the slots above. Slots it slept through are reported in the run log, the notification ("caught up after a missed run") and the PR body ("Built late: ...").

**Why Keith's Mac, not GitHub Actions:**
- The job needs the Discord bot token in the Keychain (the Actions Discord token returns 401), wrangler's D1 access, and `gh` as Keith.
- The live sync already runs the same way, with the same PATH fix.
- **The independent backstop stays on GitHub:** `ups-center-due.yml` still fails at 12:30 PM ET Thursday and Friday when an issue is missing. So a powered-off Mac still produces an alert.

## One run (`pipelines/etl/wire/ups_center_auto.py run`)

1. **Duplicate check.** `ups_center_due.preflight_findings` covers the repo index, the Pages index and page, `ups_wire_threads`, and #league-announcements. If the issue is already live or announced, the run stops; it never builds a second issue.
2. **Evidence that would otherwise be lost:**
   - `projection_evidence_<s>_wkNN.json`;
   - `scores_published_<s>_wkNN.json`: the first numbers, so a later Elias change becomes a list of changed claims;
   - then `elias.py check`.
3. **D1 must equal MFL** for the week's scores and the standings (`ups_center_sources.d1_matches_mfl`). If not, the run is **BLOCKED** with the reasons. It never guesses.
3b. **The forecast** (Builder A, 2026-10-14). The job runs `season_sim.py --through-week N` and `week_preview.py --week N+1` itself.
   - Both read one cached input snapshot, so the Playoff Picture and the next-week scenarios are the same simulated seasons.
   - Both refuse to overwrite, so a rerun keeps the files it made.
   - A failure is recorded in the run's reasons and never stops the draft. The issue then shows a blocker box.
   - **Consistency** (merge gate, 2026-10-14). The odds print only if the forecast holds together:
     - every franchise appears once, and every value is a probability;
     - bye ≤ division ≤ playoffs, and title ≤ playoffs (byes go only to division winners, and every division winner is in the field);
     - the playoff odds total the six-team field, byes total two, titles total one, and each division's title odds total one;
     - the Week N+1 scenario cells sum to the forecast's playoff, division and bye counts for every team, since they are the same simulated seasons.
     - Otherwise an `odds:inconsistent` box replaces the table. Its text names the teams and has no numbers in it.
3c. **The season snapshot** (Builder B, 2026-10-14): `ups_center_sources.season_history`. It reads:
   - this season's weeks 1..N: scores, best possible lineups and results;
   - weeks 1..N of every season since 2017, nothing later;
   - each past playoff field from `/api/playoff-bracket?YEAR=`.

   `season IN (...)` keeps D1 on the primary key. Measured for Week 5: rows_read 60, 156, 558 and 790, for 60, 156, 540 and 780 rows returned.
4. **Inputs:** league chat (`ingest_discord_chat.py --incremental`, which only reads Discord), then xFP (`wire_xfp.py fetch`).
5. **Build and check:**
   - `wire.py build --pack`;
   - an **independent** sources snapshot (`ups_center_sources.gather`);
   - render (`ups_center_issue.py`);
   - validate (`ups_center_validate.py`).
6. **One draft PR** (`ups_center_pr.py`), decided from the open PRs that touch the article file:
   - **None:** create a draft PR from `wire/auto/<id>`.
   - **The automation's own PR, claims unchanged:** no-op.
   - **The automation's own PR, claims moved:** rebuild the branch from `origin/main`, force-push it, rewrite the PR body, and comment the **changed claims**.
   - **A PR an editor owns** (another branch, or an auto-branch commit without the `Ups-Center-Auto:` trailer): never overwritten. A comment re-checks it against current sources (changed claims, quote problems), once per distinct result.
   - **Two PRs for one issue:** stop and alert.
7. **Tell Keith:**
   - A macOS notification plus `~/Library/Caches/upsmfl-ups-center-auto/<id>.status.json`.
   - The full-issue preview PDF goes to `<id>.review.pdf`.
   - A BLOCKED or failed run within 24 hours of the deadline (8 hours before the next week's first kickoff) opens or updates **one GitHub issue for the week**, in plain words.

## Chat that may never be used

Keith 2026-10-08: the automated preview listed an excluded injury post among its editor candidates. Ruled-out chat is now filtered **before** anything is generated or committed (`pipelines/etl/wire/chat_exclusions.py`):

1. **`site/wire/data/chat_exclusions.json`:** message ids an editor has ruled out, with a category. It holds **ids only**; the text never enters the repo. If the file is missing or malformed, the run fails rather than allowing everything.
2. **A pattern net** for what the owner dossier calls never material (family, health, recovery) and for crude sexual or graphic-injury lines. Editor picks may clear an NFL-news false positive with `"clearedPattern": "<why>"`.
3. **Private names** (owners' family members) come from `chat_exclusion_terms.local.json`, which is gitignored and sits next to the owner dossier in the main checkout. They are never in the public module.

Applied in four places:
- **The sources snapshot:** withheld text is blanked at gather time; the post still counts.
- **Pack auto-picks:** `wire_data.week_quotes`.
- **Editor picks:** `weekly_recap`; a ruled-out pick fails the build.
- **The Coffee Shop candidates and the validator:** a forced ruled-out quote fails.

Ids and private names cannot be cleared.

## Sandbox demo

`ups_center_auto.py run --sandbox --week N` builds under a demo id at `site/wire/articles/_sandbox/` (`wire.py` never indexes, verifies or publishes a `_` folder). It opens a `[SANDBOX demo -- will be closed]` draft PR that commits only its own article and claims, and never opens a GitHub alert. This shows draft-PR creation and update on GitHub without a second copy of a live issue. Before a change merges, `--code-ref <branch>` (sandbox only) overlays that branch's pipeline code on the work tree, without staging it, so the demo runs the code under review.

## What the draft contains

It is the real show markup (`.uc`), the same as Weeks 1–4:

| Segment | Built from | Marked for editor review when |
|---|---|---|
| Opening desk | MFL scores; the closest and biggest games; sweeps; the record book | n/a |
| Boomer's Rundown | top performers and box lines | n/a |
| Division desk | one game page per division or crossover, every result and margin | n/a |
| Plays of the Week | play cards; NFL.com link (page title checked) or NFL-channel YouTube (oEmbed) | no verified link |
| Above and below | bust/bargain lists, each row with its **projection capture time and kickoff** | no pregame evidence, or a row that cannot be matched to a pregame capture (postgame numbers are never used) |
| League landscape | standings in the **site's order** (§F.1); the prior-preview audit | the site's order differs from §F.1; no preview to grade; a head-to-head tiebreak needed |
| Playoff Picture | the job's `season_sim_<s>_live_wkNN.json`: playoffs, bye, division and title odds; division and title rounded to keep each group at 100.0% | **odds missing, stale or internally inconsistent** (not through this week, run before the week went final, or failing the consistency checks above): a blocker box replaces the table; next-week preview missing or stale: its own box |
| Heat Check | `ups_center_stories.heat`, using the Week 5 issue's definitions: all-play over the last three weeks and the season; scoring rank first window → last; the reading (Dominant/Sinking/Rising/Cooling/Holding); bench points; losses the best lineup would have won; wins vs expected | **always**: the story leads (`stories:leads`). Each lead is "Look at <team>: <row in the tables>". A lead has no numbers, no verdict and no host voice, so it is a pointer, not a finding. The box blocks publication until the editor removes it, and `verify` fails a live page that still has it. The snapshot is missing: a blocker. |
| Survival Line | `ups_center_stories.survival`: past teams with the same all-play pair (2017+) and the same win band (2021+, same number of decisions) who made the playoffs. Categories come from the Playoff Picture's odds when they are current. | the snapshot is missing: a blocker. No current odds: no categories, said in the caption. |
| Coffee Shop | post counts; the number of usable chat lines | **always**: Kenny's jokes are an editor's job (owner dossier). The verbatim, linked candidates appear only in the **local** review copy, because raw chat stays off the public repo. Family, health and similar lines are withheld from both. |
| Elias changes | MFL Official Statistics Changes vs the first numbers | Elias not posted yet |

The prose is plain templates, with no model call, so every sentence is reproducible. It is a draft for an editor to polish, not a finished voice.

## Validation

Every printed value is a **claim** with a source. A claim kind with no independent check is reported as a warning, not passed silently.

| Claim | Checked against |
|---|---|
| score, margin, week all-play | MFL `weeklyResults` |
| record, all-play, PF | MFL `leagueStandings` |
| projection | D1 `ups_player_projections`: the value, the capture time, and **capture before the player's own kickoff** (MFL `nflSchedule`) |
| quote | D1 `ups_discord_messages` by message ID, verbatim. The link must resolve to that message, and dossier-sensitive lines fail. |
| post counts | recounted |
| graded preview rows | the finals and "called it" result, against MFL |
| pack facts | equal to the pack |
| heat, hist | recomputed in the validator by separate code from the raw snapshot (D1 rows and bracket fields), not by `ups_center_stories` |
| rule | the fixed definitions printed in captions: the 28-of-33 and 5-of-33 readings, and the category cutoffs |
| odds | the job's forecast file. Playoffs and bye to one decimal; division and title under the same largest-remainder rounding (`season_sim.display_percentages`). A draft with **neither odds nor an odds blocker fails**, so the Playoff Picture cannot silently disappear. Printed odds are also re-checked for consistency by separate code that works in whole simulated seasons (`forecast_inconsistent`). |
| **every number on the page** | must be the printed form of a registered claim (a stray number fails), and **every claim must name its source** |

A draft with any error is **not** pushed. The run is BLOCKED and alerts. A draft with editor items is pushed but marked not publishable.

## Never publishes

- Every article is `status: draft`.
- `ups_center_pr` refuses `gh pr merge`, `ready` and `close`.
- The pipeline has no Discord write. Tests assert both.
- Publication and the announcement stay with Keith's review of the specific issue, through the existing `preflight --stage publish|announce` steps.
- `wire.py verify`, which CI runs on every Wire PR and on main, fails a `status: live` page that still has an EDITOR REVIEW box. A blocker box is therefore a hard stop, not only a warning.

## Post-build check (GitHub Actions, every draft)

Keith 2026-10-15: a production validation cannot depend on the Claude app or his Mac staying open. Every automated draft is therefore checked in GitHub Actions by `.github/workflows/ups-center-post-build-check.yml`, running `pipelines/etl/wire/ups_center_check.py`. The check is permanent and applies to every week.

- **When it runs:** whenever the job opens or updates a draft PR from `wire/auto/<season>-wkNN-ups-center` (`pull_request_target`, draft PRs only, sandbox branches skipped). It can also be run by hand: Actions → "UPS Center post-build check" → Run workflow with the season and week, or locally with `python3 pipelines/etl/wire/ups_center_check.py --season 2026 --week 6`.
- **What it reads:** the draft's committed files at the PR's head commit, read as data with `git show`; the branch is never checked out or run, and the workflow and checker come from `main`. These are the same recorded inputs the draft was built from:
  - the article, `claims.json`, `validation.json`;
  - `run.json`, the build's run record: when the week went final and the forecast it rendered from, with no chat;
  - the two forecast files and the branch's index.

  It also reads live publication state: main's index, the Pages index and page, `ups_wire_threads` (one SELECT through `wire_data.d1`, which refuses anything else) and #league-announcements (one Discord GET).
- **What it checks:**
  1. the draft was created (an open DRAFT PR into main, with its files, clean validation and a draft index entry);
  2. the forecast is fresh (through this week, run after the week went final, the next-week preview from the same seasons, and the committed files are the ones the draft recorded);
  3. six playoff teams in every simulated season, two byes, one champion, and bye ≤ division ≤ playoffs;
  4. every division totals 100%, in seasons and as printed;
  5. the scenario cells sum to each team's playoff, division and bye counts;
  6. every displayed number has a source, and every printed probability equals the committed forecast;
  7. every editor-review box is a registered editor item and blocks publication (not publishable, and `wire.py verify` refuses the page as live);
  8. the article is still a draft and no announcement exists.
- **Output:** one report comment on the draft PR, edited in place on later runs, and the same report kept as a workflow artifact (`report.md`, `report.json`). **Any mismatch fails the workflow.** A check it cannot complete, such as an unreadable D1 or Discord, fails. It is never assumed safe.
- **Never writes:** no publish, no announcement, no MFL, D1 or Discord write. The only writes are its own report and the PR comment.
- **Editor-owned drafts:** if the head commit has no `Ups-Center-Auto` trailer, the draft is checked the same way except the claim ledger (check 6 and the claim/box pairing in 7), which describes the automation's own render. The report says which checks it skipped.
- **The build itself** still runs on Keith's Mac (the LaunchAgent above), because it needs the Mac's local credentials and tools. Once it has pushed the draft, the Mac can sleep; the check runs in the cloud.

## Replay (no publish)

To re-run a finished week's build and check the job without touching anything:

    python3 pipelines/etl/wire/ups_center_auto.py replay --season 2026 --week 5 \
        --workdir <throwaway checkout of the code under test> --out <folder> [--inputs <recorded forecast inputs>]

- **What it runs:** the D1 == MFL check, the forecast (from scratch, into `--out`), the pack build, the sources snapshot, render and validate.
- **What it never does:** stop at the duplicate check, fetch or reset git, commit, push, open a PR or GitHub issue, notify, ingest chat, write the job's state folder, or write the site.
- **`--inputs`:** replays the forecast on recorded MFL responses with `season_sim --reuse-cache`, which refetches nothing however old the files are. Any input the recording lacked is fetched live and listed under `inputsFetchedLive` in `replay.json`.
- **Week 5, 2026-10-14:** replayed on the inputs the published forecast used. Every playoff, bye, division and title probability, and all 428 Week 6 scenario cells, came out identical to the published files. The only differences were the run timestamp and the order of one unprinted diagnostic list. The 112-check Week 5 verifier passes against the replayed files.

## Tests

`python3 pipelines/etl/wire/test_ups_center_auto.py` runs offline against Week 4 sources recorded 2026-10-08 (140 checks), with synthetic chat. The Builder A checks use a synthetic forecast relabelled from the real Week 5 files (odds and scenario cells). They include five kinds of inconsistent forecast, the replay's no-publish guarantees and the live-page rule in `verify`. The Builder B checks use recorded season snapshots (scores, results and franchise IDs only) and include a Week 5 regression that reproduces the published issue's Heat Check and Survival Line exactly. The post-build check's tests cover a clean draft passing all eight groups, 21 separate ways to fail (from no draft PR to an unreadable D1 or Discord), an editor-owned draft, the post-season, and static guards that the checker and its workflow have no write path and never run the draft branch. The checks include the chat exclusions, catch-up and sandbox. It also runs in `check-wire.yml`.
