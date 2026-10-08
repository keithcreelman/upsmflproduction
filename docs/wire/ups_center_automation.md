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
| **every number on the page** | must be the printed form of a registered claim (a stray number fails) |

A draft with any error is **not** pushed. The run is BLOCKED and alerts. A draft with editor items is pushed but marked not publishable.

## Never publishes

- Every article is `status: draft`.
- `ups_center_pr` refuses `gh pr merge`, `ready` and `close`.
- The pipeline has no Discord write. Tests assert both.
- Publication and the announcement stay with Keith's review of the specific issue, through the existing `preflight --stage publish|announce` steps.

## Tests

`python3 pipelines/etl/wire/test_ups_center_auto.py` runs offline against Week 4 sources recorded 2026-10-08 (66 checks), with synthetic chat. The checks include the chat exclusions, catch-up and sandbox. It also runs in `check-wire.yml`.
