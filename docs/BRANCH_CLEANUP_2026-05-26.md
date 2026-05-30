# BRANCH CLEANUP — 2026-05-26

**Goal:** Cut to a sane, reviewable set without losing work.

---

## ✅ EXECUTED 2026-05-29 (with Keith)

| | Before | After |
|---|---|---|
| Worktrees | 27 | **5** |
| Remote branches | 207 | **143** |
| Work lost | — | **zero** |

**Worktrees removed (22):** all merged/no-diff worktrees + superseded ones. **3 WIP stashes rescued** to `origin/rescue/roast-bot-wip-2026-05-29`, `origin/rescue/stoic-index-wip-2026-05-29`, `origin/rescue/cross-codebase-doc-2026-05-29` before removal (760 / 209 / 359 lines of uncommitted work preserved).

**Remote branches deleted (64):**
- 20 merged-into-main (commits already in main)
- 26 `draft-hub-v1.7.x` iterations (hub live in main)
- 18 `myteam-v1.7.x` + `teamops-*` iterations (Team Ops live in main — IR@50%, WIP banner, standings-v2 wiring all verified present)

**5 worktrees remaining:**
- root (`fix/extension-cy-and-default-prod-channel`) — your active checkout
- `condescending-keller-4fc8cc` — the docs session
- `elastic-tesla-f7a65c` — **decide:** 5 unmerged taxi/tag fixes (§B2, §C8) + untracked `site/rosters/v2/` experiment
- `serene-mendeleev-62034a` — **decide:** 16-ahead cap backfill, 10 dirty
- `strange-lewin-62390f` (`drops-single-message-redesign`) — **decide:** 118-ahead, 16 dirty

**143 remote branches remain** (long tail: `codex/*`, `feat/*`, `fix/*`, `chore/*`, assorted `claude/*`). No clean series left to batch — these need per-branch judgment in a future pass. Confirmed-but-not-yet-executed: `codex/front-office-wip` → SCRAP (per MODULE_INVENTORY decision); `fix/q19-*` → ~5 duplicate attempts, keep one.

**Naming convention to prevent recurrence:** locked in [`CHANGE_PLAYBOOK.md`](CHANGE_PLAYBOOK.md) §3 — `<bucket>/<feature>`, one branch per feature, amend/force-push instead of `-v2`/`-v1.7.x`.

---

## Original recommendations (2026-05-26) — for the remaining 143

The per-branch recommendations below were written before execution. The worktree section + the merged/versioned-series branches are now done (above); the feature/fix-branch recommendations still apply to the 143 remaining.

---

## Quick stats

- **Worktrees:** 27 (including the root + `/private/tmp/week1-auction` which is `prunable`)
- **Remote branches:** 204 total
  - 21 already merged into `origin/main` — safe to delete after a quick sanity check
  - 182 unmerged
    - ~50 `draft-hub-v1.7.*` and `myteam-v1.7.*` versioned iterations — almost certainly all superseded by main
    - ~20 `audit-followup-*` branches — check if landed via different commits
    - ~30 specific fix/feat branches still in motion
- **Codex branches** (3 important): `front-office-wip`, `acquisition-hub-ia-cleanup`, `worker-wip` — may contain salvageable work

---

## A. Worktree recommendations (27 worktrees)

| # | Worktree path / branch | Last commit | Ahead/Dirty | Bucket | Action |
|---|---|---|---|---|---|
| 1 | `/Users/keithcreelman/Code/MFL/upsmflproduction` (`fix/extension-cy-and-default-prod-channel`) | 2 days ago — D1-backed draft-state coalesce | 0/17 dirty | infra | **Keep — root checkout.** But 17 dirty files: commit or stash before doing anything else. |
| 2 | `/private/tmp/week1-auction` (`claude/week1-auction-endpoints`) | — | MISSING PATH | auction | **Prune now.** `git worktree prune` — listed as prunable in `git worktree list`. |
| 3 | `.claude/worktrees/angry-raman-af2133` (`claude/angry-raman-af2133`) | 11 days ago — Discord prod-channel fix | 0/0 | infra/discord | **Delete worktree.** No diff vs main; landed. |
| 4 | `.claude/worktrees/condescending-keller-4fc8cc` (`claude/condescending-keller-4fc8cc`) | 16h ago — auction-hub modal #266 | 0/3 dirty | **THIS SESSION** | **Keep until docs land.** This is the current session producing this cleanup doc. |
| 5 | `.claude/worktrees/crazy-bhaskara-3d55de` (`claude/crazy-bhaskara-3d55de`) | 2 days ago — merge of extension-cy fix | 0/0 | infra | **Delete worktree.** Merge commit, no diff. |
| 6 | `.claude/worktrees/crazy-heyrovsky-213acd` (`claude/crazy-heyrovsky-213acd`) | 10 days ago — docs cross-codebase audit | 0/0 | docs | **Delete worktree.** Already at #210 merged. |
| 7 | `.claude/worktrees/determined-cohen-754326` (`claude/determined-cohen-754326`) | 6 days ago — SHA-pin Stage 1-8 assets via UPS_RELEASE_SHA | **5 ahead** | infra | **Review & merge or close.** Real work ahead of main — has a PR? |
| 8 | `.claude/worktrees/elastic-tesla-f7a65c` (`claude/elastic-tesla-f7a65c`) | 6 days ago — taxi chip fix | 5 ahead / 1 dirty | draft | **Review & merge or close.** Real work pending. |
| 9 | `.claude/worktrees/exciting-tharp-235716` (`hotfix/o43-picker-v2`) | 16h ago — o43 picker silence harmless error | **17 ahead** | auction/FO | **HIGH PRIORITY — open a PR.** This is active hotfix work and 17 commits ahead. Currently floating outside main. |
| 10 | `.claude/worktrees/fervent-shannon-316a2d` (`claude/fervent-shannon-316a2d`) | 2 days ago — merge | 0/0 | — | **Delete worktree.** Merge commit. |
| 11 | `.claude/worktrees/festive-turing-513cf1` (`claude/festive-turing-513cf1`) | 11 days ago — same SHA as angry-raman | 0/2 dirty | infra/discord | **Delete worktree.** Dup of angry-raman; landed. (Both point to `f3cfe96`.) |
| 12 | `.claude/worktrees/focused-margulis-c0af64` (`claude/focused-margulis-c0af64`) | 8 days ago — revert #235 | 0/1 dirty | infra | **Delete worktree.** Revert landed. |
| 13 | `.claude/worktrees/funny-bohr-bf31e2` (`claude/funny-bohr-bf31e2`) | 2 weeks ago — Draft Hub v1.7.30 | 0/8 dirty | draft | **Stash dirty + delete worktree.** Old iteration. |
| 14 | `.claude/worktrees/goofy-darwin-e4dc37` (`main`) | 16h ago | 0/0 | — | **Keep or delete — your call.** It's just a checkout of `main`. If you don't use it, delete. |
| 15 | `.claude/worktrees/great-cartwright-b55d2a` (`claude/great-cartwright-b55d2a`) | 2 weeks ago — Pass 2 cap backfill | 0/0 | data/cap | **Delete worktree.** Landed; reference docs (`docs/cap_penalty_data_migration_plan.md`) sufficient. |
| 16 | `.claude/worktrees/keen-knuth-623b0f` (`claude/keen-knuth-623b0f`) | 2 days ago — trades contract_end_year gate | 0/0 | trade | **Delete worktree.** Landed. |
| 17 | `.claude/worktrees/peaceful-feistel-0aeeaf` (`docs/audit-six-q-resolutions`) | 9 days ago | 1 ahead | docs | **Open PR & merge or close.** One commit pending. |
| 18 | `.claude/worktrees/quirky-swirles-525948` (`claude/quirky-swirles-525948`) | 6 days ago — taxi block demote rule-transition | 0/0 | draft/taxi | **Delete worktree.** Landed. Note: this worktree contains experimental `front_office_*.js` modules — verify they're not unsalvaged before deleting (cross-reference with the FO-v2 decision). |
| 19 | `.claude/worktrees/recursing-fermat-767d5e` (`claude/recursing-fermat-767d5e`) | 10 days ago — mobile UX batch | 3 ahead | mobile | **Open PR & merge or close.** Real work pending. |
| 20 | `.claude/worktrees/serene-mendeleev-62034a` (`claude/serene-mendeleev-62034a`) | 2 weeks ago — 2021 player_contracts backfill | **16 ahead / 10 dirty** | data/cap | **HIGH PRIORITY — review.** Significant uncommitted + commit work. May be the in-progress 2021 backfill from memory. |
| 21 | `.claude/worktrees/sleepy-hodgkin-41c397` (`claude/sleepy-hodgkin-41c397`) | 10 days ago — docs audit | 0/1 dirty | docs | **Delete worktree.** Landed at #210. |
| 22 | `.claude/worktrees/stoic-dubinsky-6c176f` (`claude/stoic-dubinsky-6c176f`) | 25h ago — daily MFL snapshot | 0/2 dirty | data | **Delete worktree.** Auto-snapshot, not feature work. |
| 23 | `.claude/worktrees/strange-lewin-62390f` (`drops-single-message-redesign`) | 3 days ago — merge main into branch | **118 ahead / 16 dirty** | trade/drops | **HIGH PRIORITY — review.** Massive ahead-count + dirty. Could be a long-running redesign. |
| 24 | `.claude/worktrees/stupefied-liskov-d7ad04` (`claude/master-player-modal-2026-05-12`) | 13 days ago — D1 backfill chunks | 2 ahead | shared | **Open PR & merge or close.** Player modal work. |
| 25 | `.claude/worktrees/unruffled-hamilton-52a53d` (`claude/unruffled-hamilton-52a53d`) | 3 days ago — env.SELF binding fix | 2 ahead | infra | **Open PR & merge or close.** Real fix pending. |
| 26 | `.claude/worktrees/vigorous-beaver-aaa4af` (`claude/vigorous-beaver-aaa4af`) | 6 days ago — daily snapshot | 0/0 | data | **Delete worktree.** Auto-snapshot. |
| 27 | `.claude/worktrees/wonderful-goldstine-24fa98` (`feat/shared-cap-math`) | 7 days ago — extract `site/shared/cap_math.js` | 1 ahead / 2 dirty | shared | **Open PR & merge or close.** Already landed as `site/shared/cap_math.js` in main. Verify before deleting. |

### Worktree action summary
- **Prune now (1):** `/private/tmp/week1-auction`
- **Delete worktree (immediately, no work lost) (12):** #3, #5, #6, #10, #11, #12, #13, #14 (optional), #15, #16, #18, #21, #22, #26
- **Review & open PR / merge / close (7):** #7, #8, #17, #19, #24, #25, #27
- **HIGH PRIORITY (3):** #9 (hotfix/o43-picker-v2 — 17 ahead, active fixes), #20 (cap backfill — 16 ahead + 10 dirty), #23 (drops-single-message-redesign — 118 ahead)
- **Keep (2):** #1 (root), #4 (this session — delete after docs land)

### How to delete a worktree safely
```bash
# Verify the branch is merged or has a PR you don't want to lose
git -C /Users/keithcreelman/Code/MFL/upsmflproduction log --oneline main..<branch> -- 2>/dev/null

# If no diff vs main (and no PR you care about):
git -C /Users/keithcreelman/Code/MFL/upsmflproduction worktree remove <path>
git -C /Users/keithcreelman/Code/MFL/upsmflproduction branch -D <branch>  # only if you also want to delete the local branch
# And the remote, if you also want to delete it:
git -C /Users/keithcreelman/Code/MFL/upsmflproduction push origin --delete <branch>
```

---

## B. Remote-branch recommendations (204 remote branches)

### B1. Already merged into `origin/main` (21 — safe to delete after sanity check)

```bash
git -C /Users/keithcreelman/Code/MFL/upsmflproduction branch -r --merged origin/main | grep -v "HEAD ->" | grep -v "origin/main$"
```

For each, confirm no active worktree depends on it (cross-check §A above), then:
```bash
git push origin --delete <branch_name_without_origin_prefix>
```

### B2. Versioned iterations — almost certainly all superseded by main

These are sequential development iterations; the LATEST one in each series is usually the only one worth keeping, and if its content landed in main, even that's deletable.

**`draft-hub-1.6.x` and `draft-hub-1.7.x`** (about 30 branches):
- `claude/draft-hub-1.6.3-followup`, `1.6.4-trade-fixes`
- `claude/draft-hub-1.7.0` through `1.7.31` (numbered iterations)

**Recommended:** verify the latest landed in main (`git log origin/main -- site/rookies/rookie_draft_hub.js | head -20`), then bulk-delete the entire series.

**`myteam-v1.7.x`** (about 10 branches):
- `claude/myteam-v1.7.32-align` through `claude/myteam-v1.7.41-bundle-shape-fix`
- Plus `claude/scroll-fixes-v1.7.42`

**Recommended:** same — verify the latest landed in `site/team_operations/team_operations.js`, bulk-delete.

**`teamops-*`** (about 9 branches):
- `claude/teamops-cap-with-adjustments`, `claude/teamops-header-only`, `claude/teamops-home-autoload`, `claude/teamops-ir-50pct-cap`, `claude/teamops-pop-pill-teal`, `claude/teamops-popout-mfl-and-cap-breakdown`, `claude/teamops-popout-msg-confirm`, `claude/teamops-red-to-teal`, `claude/teamops-wip-banner`

**Recommended:** spot-check each for unique unmerged content; bulk delete those without.

### B3. `audit-followup-*` and `audit-*` (about 13 branches)

Spread across `docs/audit-*`, `feat/audit-followup-q*`, `claude/extension-audit-master`. Many of these were created during the cross-codebase audit (memory references PR #210 / `docs/audit-six-q-resolutions`).

**Recommended:** review each for landed-vs-pending; the docs branches are likely all merged or superseded.

### B4. Codex branches (3 — flag for individual review)

| Branch | Likely value |
|---|---|
| `origin/codex/front-office-wip` | **The "newer FO" candidate** — net −4768 LoC roster_workbench refactor. **Review this with Keith before deletion.** Either merge, salvage, or scrap. |
| `origin/codex/acquisition-hub-ia-cleanup` | May have unmerged auction-hub work pre-redesign. Diff against `site/auction/`. |
| `origin/codex/worker-wip` | Generic WIP — check date + content. Likely deletable. |
| `origin/codex/fix-roster-workbench-contract-years` | Specific fix; verify landed. |
| `origin/codex/reports-rulebook-etl-wip` | Possibly long-abandoned WIP. |
| `origin/codex/rulebook-mobile-preview` | Verify content vs current rulebook service. |
| `origin/codex/tag-fix-clean`, `tag-worker-live-roster-fix` | Tag-related fixes; verify landed. |
| `origin/codex/trade-cap-consistency`, `transactions-pick-metadata` | Likely landed. |

### B5. Active feature branches to triage individually (~30)

Sample of representative branches that need per-branch review:

- `origin/feat/shared-cap-math` — landed as `site/shared/cap_math.js` ✓ delete
- `origin/feat/silence-discord-on-contract-update`
- `origin/feat/team-ops-lineup-submit` + `v2` + `roster-lineup-merged` — pick one, delete others
- `origin/feat/trade-bait-*` (4 branches) — pick latest, delete rest
- `origin/feat/otb-*` (4 branches) — same
- `origin/feat/q17-ext2-fl-bl-ui`, `q18-mobile-taxi-promote-demote`, `q20-taxi-counter-pending-state-machine` — audit-followup features; check landed status
- `origin/fix/q19-*` (5 branches) — five parallel attempts at the same Q19 fix; **only one should survive**
- `origin/fix/mfl-cookie-*` (2 branches), `origin/fix/mfl-imports-target-league-server-not-api` — verify which landed
- `origin/hotfix/o43-picker-loop`, `origin/hotfix/o43-picker-v2`, `origin/hotfix/revert-238-cpu-blowup` — o43 hotfix series

### B6. Always keep

- `origin/main` (obvious)
- `origin/dev` if you use a dev branch flow (verify usage)
- Any branch in active PR that you intend to merge

---

## C. Recommended execution order (low-risk first)

**Phase 1 — Zero-risk cleanup (~30 min)**
1. `git worktree prune` — removes the listed-as-prunable `/private/tmp/week1-auction`.
2. Delete the 12 "no-diff" worktrees listed in §A. For each: verify with `git log main..<branch>` then `git worktree remove <path>`.
3. Delete the 21 already-merged remote branches (§B1). Use a one-line bash loop after a final visual scan.

**Phase 2 — Versioned-iteration cleanup (~1 hour)**
4. For draft-hub-1.7.x series: confirm v1.7.31 (or whichever was the last) is fully merged into main's `rookie_draft_hub.js`. If so, bulk-delete the v1.6.3 through v1.7.31 series.
5. Same for myteam-v1.7.32-41 and teamops-*.

**Phase 3 — High-priority worktrees (~2 hours, your time)**
6. Review the 3 HIGH PRIORITY worktrees (§A #9, #20, #23). For each: decide merge/continue/abandon. Open a PR or close-and-delete.
7. Review the 7 "open PR or close" worktrees (§A #7, #8, #17, #19, #24, #25, #27).

**Phase 4 — Codex + audit cleanup (~1-2 hours)**
8. Sit down with each codex branch (§B4) and decide replace/salvage/scrap. **`origin/codex/front-office-wip` is the priority** — open it side-by-side with `roster_workbench.js` on main and decide.
9. Triage `audit-followup-*` branches (§B3).

**Phase 5 — Per-feature triage (~3-4 hours)**
10. Walk through the ~30 active feature branches in §B5 individually.

---

## D. Going forward — prevent regrowth

Adopt the rules in [`docs/CHANGE_PLAYBOOK.md`](CHANGE_PLAYBOOK.md) §3:

1. **One worktree per active feature** — close on merge.
2. **Max 3 worktrees touching any danger-zone file** simultaneously.
3. **Bucket-prefix new branches:** `fo/`, `trade/`, `auction/`, `draft/`, `infra/`, `docs/`.
4. **Don't iterate via numbered branches** (`v1.7.32`, `v1.7.33`, …) — amend or force-push within a single PR's branch instead.
5. **Weekly worktree audit** — run `git worktree list` every Sunday and decide what to close.

A simple shell script can be added later to automate the audit (see Tier B4 in the Change Playbook).
