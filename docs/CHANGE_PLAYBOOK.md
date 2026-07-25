# CHANGE PLAYBOOK — How to fix things without breaking other things

**Generated:** 2026-05-26
**Audience:** Keith (and any AI assistant working with Keith).
**Status:** Recommend-only. Keith picks what to actually enforce.

This doc exists because Keith's biggest pain point is that fixing one thing regresses another. There are six root causes (see Phase 1 findings in the session plan). This playbook addresses them with: (1) a pre-change checklist, (2) a danger-zone file list, (3) branch hygiene rules, (4) a guardrail menu, and (5) operating principles.

---

## 0. 🔒 CONTRACT CHANGE GATE — STANDING RULE (Keith 2026-07-23, NO EXCEPTIONS)

**Applies to ANY contract change** — code that computes/renders/submits contract fields
(salary, contractYear, contractInfo tokens: `CL`, `TCV`, `AAV`, `Y1..Yn`, `GTD`, `Ext`,
`Restructured YYYY`, `-FL`/`-BL` suffixes) AND any live contract-data edit
(`/admin/import-salaries`, D1 `ups_*` ledger writes, Discord contract-activity edits).

Adopted after four contract bugs in two days (2026-07-21/22), all caused by
re-deriving contract math instead of reading canon: restructures re-averaging AAV
(TCV÷CL) and dropping `-BL`, the Discord embed deriving AAV from year salaries
(Hurts rendered "67K, 52K AAV" when the token says **42K, 52K**), the FO extension
submit sending the extension-year salary as MFL's current salary, and
`contract_year` sent as years-added instead of full contract length.

**The gate — every contract change, every time:**

1. **READ CANON FIRST.** The relevant `docs/league_context_v1.md` section:
   §C4 Extension (AAV escalator, FL/BL, forward-looking TCV), §C5 Restructure
   (re-slot years, TCV preserved), §C7 Annual Roll-Forward, §D1 Cut/GTD
   (75% guarantee, sub-$5K rules). Never re-derive a rule from memory or from
   code — the code has ~30 drifted copies (two AAV schools, five GTD formulas).
2. **Dry-run.** `/admin/import-salaries` with `dry_run`, or the client submit's
   preview path, or the validator (`pipelines/etl/scripts/audit_contract_info.py`).
   Never a blind write.
3. **Show Keith before/after.** CSV or inline table with evidence + confidence,
   per contract.
4. **Wait for Keith's confirm.** Per-row APPROVE — not blanket, not implied.
5. **Commit + record the ruling.** Append to session memory AND
   `docs/league_context_changelog.md`; if the ruling is a new general rule,
   amend `docs/league_context_v1.md` with Keith's sign-off.

**Operating corollaries:**
- contractInfo tokens are ground truth to **PRESERVE**, not recompute. When a
  displayed number disagrees with the token, the renderer is wrong until proven
  otherwise.
- **AAV ≠ TCV/CL. Never average.** AAV is set forward-looking at the extension
  (dual `cur, cur+bump`; escalator applies to extension years only) and is
  preserved verbatim through restructures. Dual AAV **rolls**: the leading tier
  drops once its year is played (Mason `4,24` → `24`).
- A restructure re-slots year salaries + TCV + GTD, preserves the AAV token
  verbatim, re-derives `-FL`/`-BL` (Y1 vs the leading AAV tier), and appends
  `|Restructured YYYY`.
- MFL `salary` = **current-year** salary; `contractYear` = **years remaining**.
- Verified reference fixtures: Hurts 14783 (sal 67K · cy 2 · `AAV 42K, 52K`),
  London 15751 (`Vet-Ext1-BL` · `AAV 33K, 43K` · Restructured 2026),
  Mason 15972 (rolled `AAV 24K`).

This section is **not** recommend-only. It is a standing rule.

---

## 1. Pre-change checklist (the one habit that prevents 80% of regressions)

Before you (or your AI assistant) start coding on the MFL repo, answer all 5:

### ☐ Which bucket am I in?
Look up the file you're about to edit in [`docs/MODULE_INVENTORY.md`](MODULE_INVENTORY.md). Note the bucket: Front Office / Trade / Auction / Rookie Draft / Other.

### ☐ Am I touching a danger-zone file?
If yes, this is NOT a quick fix. See §2 below — read the blast radius and expand the test scope.

### ☐ Is there a pending PR or worktree touching this file?
Run:
```
git worktree list
gh pr list --search "is:open"
```
If another worktree or PR already touches the same file, **merge that first or rebase off it** — don't make conflicting edits in parallel.

### ☐ Was this file fixed recently?
Run:
```
git log --oneline -10 -- <file>
```
If the last 3+ commits on this file are all "fix(...)" you are entering a hotspot. Read the most recent fix's PR description before changing anything — you might be about to revert it.

### ☐ Have I tested OTHER pages this change could affect?
Specifically:
- **Header/footer change** → check every `hpm-*.html` page (default, draft-hub, myteam, reports, standings, stats-workbench, mcm, issue-report) + the trade offer page (`O=43`) + the roster page (`O=05`).
- **Shared util change** (`site/shared/*.js`) → check every module listed under "Consumers" in [§5i of MODULE_INVENTORY](MODULE_INVENTORY.md).
- **`worker/src/index.js` shared helper change** (`safeStr`, `jsonOut`, `_rdhPadFid`, etc.) → identify which routes use it via grep, hit each one with a smoke request.
- **Discord send-site change** → fire the corresponding test endpoint (`/admin/.../test-discord`) before letting prod post.

---

## 2. Danger-zone files (high blast radius)

These files affect 3+ buckets at once. Editing them requires §1's expanded checklist:

| File | Blast radius | Why it bites |
|---|---|---|
| `worker/src/index.js` | 40+ worker routes | Shared helpers (`safeStr`, `jsonOut`, `_rdhPadFid`, `_rdhLeagueId`) used by every route. Monolithic — easy to introduce subtle regressions. |
| `worker/src/discord_round.js` + `worker/src/lib/cap_penalty.js` | Cap penalty + contract Discord + Hall rounds | Errors here mis-post penalties to the league — visible to all owners. |
| `header_custom_v2.html` | EVERY MFL page | 11+ IIFEs, dev-league redirect, sessionStorage, CSS overrides with `!important`. The dev-league redirect (lines 58–77) can ALSO break your testing in prod-like environments. |
| `footer_custom_v2.html` | EVERY MFL page | Loads `mflscripts_rosters_fork.js`, mutation observer rewriting "Blind Bidding Dollars" → "Salary" (line 141-146 — breaks silently if MFL changes the label). |
| `site/loader.js` | EVERY MFL page | Global CSS contrast fix injection, `is_offseason` global, MFLGlobalCache shim. |
| `site/shared/player_profile_master.js` | rosters, trades, rookies, reports | 132 KB module consumed by 4 buckets. |
| `site/shared/cap_math.js` | rosters, trades, team_operations | Cap calc logic shared across multiple workbenches. |
| `site/shared/mfl_cache.js` | rosters, trades, rookies, auction | Shared MFL API cache layer. |
| `site/rosters/mflscripts_rosters_fork.js` | Native MFL roster page (`O=05`, `O=07`) | Replaces MFL's roster rendering wholesale; changes here break the roster page across the league. |
| `site/rosters/ups_trade_offer_patch.js` | Front Office + Auction | Hosts both the trade-offer patch AND the o43 auction-nomination flow (PR #266). |

**External scripts we DON'T own** (no source in repo, version-locked by URL — change silently):
- `https://www.mflscripts.com/mfl-apps/global/header.js?v=1.60`
- `https://www.mflscripts.com/mfl-apps/global/footer.js?v=1.12`
- `https://mflscripts.com/mfl-apps/playoffs/standingsColumns.js`

When MFL ships an update to one of these, behavior changes under us with zero diff in our repo. Recommend snapshotting them — see §4 guardrail menu.

---

## 3. Branch & worktree naming — LOCKED CONVENTION (2026-05-29)

**What went wrong:** the repo accumulated 200+ remote branches and 27 worktrees — including ~50 numbered iteration chains (`draft-hub-v1.7.6 … v1.7.31`, `myteam-v1.7.32 … v1.7.41`). Each "version" was a fresh branch instead of an update to one. That's what made cleanup a multi-hour forensic exercise. Cleaned up 2026-05-29 (27→5 worktrees; merged + superseded branches deleted).

### The naming rule

```
<bucket>/<short-kebab-feature>

  teamops/ir-50pct-cap
  discord/drops-channel-split
  contracts/canonical-status-vocab
  fo/extension-fl-bl-ui
  fix/o43-picker-render-guard
```

**Buckets** (matches MODULE_INVENTORY): `fo` · `teamops` · `trade` · `auction` · `draft` · `contracts` · `discord` · `infra` (worker/header/footer/shared) · `docs` · `fix` · `rescue`.

### The rule that kills the v1.7.x sprawl

**One branch per feature.** When you iterate, **amend or force-push the same branch** — never spin `-v2`, `-v3`, `-v1.7.33`. The branch name describes the *feature*, never the attempt number. If a PR needs another round of changes, push more commits to the same branch.

### Worktree rules

1. **One worktree per active feature.** Close it on merge: `git worktree remove <path>`.
2. **Max 3 simultaneous worktrees touching the same danger-zone file** (§2). Beyond that, finish-or-abandon before starting another.
3. **Rescue before delete.** If a worktree has uncommitted work, commit it to a `rescue/<name>-<date>` branch and push to origin *before* removing — never `worktree remove --force` over unsaved work. (Three WIP stashes were rescued this way on 2026-05-29.)
4. **Weekly worktree audit.** Each Sunday: `git worktree list` → per worktree decide merge / continue / delete.

### PR rule

**PR descriptions must declare blast radius:**
```
## Files touched outside primary bucket
- <file> — <why>      (or "none")
```

### Cleanup gotcha (learned 2026-05-29)

When batch-deleting branches with a generated exclusion list, `git branch -r` output has **leading whitespace** — `grep -vx 'name'` won't match `'  name'`. Strip with `tr -d ' '` / `sed 's/^ *//'` before comparing, or you'll delete the branch you meant to keep. (Happened once; the branch was merged so no loss, and it was restored — but verify exclusion lists before destructive batch ops.)

### Squash-merge caveat

This repo squash-merges, so a landed branch's commits are **never ancestors of main** and its tree drifts far from main over time. You **cannot** prove "this branch's work is in main" via `git merge-base`/`diff` alone. To retire an old feature branch, confirm the *feature* is live in main (grep the shipped file), not the branch's git ancestry.
6. **Pre-merge sanity:** before merging a branch that touches a danger-zone file, run `git log --oneline main..HEAD -- <file>` against ALL other open branches that touch it. If overlap, rebase first.

See [`docs/BRANCH_CLEANUP_2026-05-26.md`](BRANCH_CLEANUP_2026-05-26.md) for the cleanup recommendation for today's 27 worktrees / 50+ branches.

---

## 4. Guardrail menu (recommend-only — Keith picks)

Ranked by **leverage per effort**. Pick the highest-ROI ones first.

### Tier A — High leverage, low effort (1-3 hours each)

**A1. Top-of-file blast-radius headers on danger-zone files**
Add a header comment to each danger-zone file listing dependent buckets:
```js
// === DANGER ZONE ===
// Bucket: Front Office (PRIMARY)
// Also affects: Auction (o43 picker), Trade (offer page)
// Before editing: read docs/CHANGE_PLAYBOOK.md §1
```
Cost: 30 minutes total. Value: one-glance reminder every time you open the file.

**A2. Snapshot the external MFL scripts**
Run `curl https://www.mflscripts.com/mfl-apps/global/header.js?v=1.60 > vendor/mfl_global_header_v1.60.js` (and same for footer.js, standingsColumns.js). Commit them. Now you can diff when MFL changes versions.
Cost: 15 minutes. Value: visibility into upstream changes that today are invisible.

**A3. Trade-announcement idempotency guard**
Add a "skip if already posted in last 24h" check on `/admin/trade-notification/post` to prevent double-posts when commish manually re-announces. Dedup key: `(franchise_pair, trade_timestamp_minute)` stored in D1.
Cost: 30 minutes. Value: closes the one duplicate-trigger gap in the Discord audit.

**A4. `wrangler tail` warn-logs on missing tokens**
Add `console.warn()` in each `sendDiscord*()` helper when bot token is missing — today they fail silently.
Cost: 15 minutes. Value: stops invisible failures.

**A5. Verify `DISCORD_CONTRACT_USE_TEST` is unset in prod**
Run `wrangler secret list --env production` and confirm. One-time check.
Cost: 5 minutes.

**A6. Branch prefix convention**
Adopt `fo/`, `trade/`, `auction/`, `draft/`, `infra/`, `docs/` prefixes for all new branches starting today. No retroactive renaming.
Cost: zero (just discipline). Value: parallel work visible at a glance.

### Tier B — High leverage, medium effort (1-2 days each)

**B1. Extract shared worker helpers into `worker/src/lib/helpers.js`**
Move `safeStr`, `jsonOut`, `_rdhPadFid`, `_rdhLeagueId`, and the half-dozen other helpers used across many routes out of `index.js`. Add unit tests (Vitest or similar — Cloudflare's `wrangler dev` supports it).
Cost: 1 day. Value: changes to helpers become safe + testable; future modularization is easier.

**B2. Playwright smoke tests for the 5 most-trafficked pages**
- Roster page (O=07) loads + UPS workbench renders
- Trade offer page (O=43) loads + o43 picker filters correctly
- Draft hub loads + draft state populates
- MCM ballot loads
- Standings page loads
Run against the dev league. Cost: 2 days. Value: catches header/footer regressions automatically.

**B3. CI check: "blast radius" field required in PR template**
When `worker/src/index.js`, `header_custom_v2.html`, `footer_custom_v2.html`, `site/loader.js`, or any `site/shared/*.js` is touched, the PR description MUST contain `## Files touched outside primary bucket` (even if "none"). Use a GitHub Action with a regex check.
Cost: 1 day. Value: forces conscious thought about cross-bucket impact.

**B4. Weekly worktree audit script**
A shell script run on a cron (or `/loop` skill) that lists all worktrees, their last commit age, their branch's PR status. Outputs a "what to clean up" table.
Cost: 0.5 day. Value: prevents worktree sprawl.

### Tier C — High leverage, high effort (week+ projects)

**C1. Modularize `worker/src/index.js`**
Break into `worker/src/routes/{rosters,trades,draft,auction,standings,mcm,admin,bug,discord}.js`. Each file owns its bucket's routes. `index.js` becomes a router.
Cost: ~1 week. Value: changes scoped to a bucket — eliminates the "edit one helper, break 40 routes" failure mode.

**C2. Migrate global IIFEs out of header/footer into per-page modules**
Inventory the 11+ IIFEs in `header_custom_v2.html`. For each: is it truly needed on every page, or only on specific routes? Move route-specific ones into the relevant HPM wrappers.
Cost: ~1 week. Value: shrinks the "every-page blast radius" surface dramatically.

**C3. CSS regression snapshots**
Percy / Chromatic / Playwright screenshot diff for the 8 HPM pages + roster + trade offer. Run on every PR.
Cost: 2-3 days setup, ongoing maintenance. Value: catches CSS cascade regressions automatically.

**C4. Decision on `origin/codex/front-office-wip`**
Review the −4768 LoC FO refactor; decide replace / salvage / scrap. If replace, port the recent o43 / auction-hub fixes onto it and merge. If scrap, delete the branch.
Cost: 2-3 days. Value: removes the "two versions of FO" ambiguity.

---

## 5. Operating principles

Five rules of thumb that don't require any tooling to start enforcing:

### 5a. One bucket per session
Don't bounce between Front Office, Trade, and Auction in a single sitting. Finish one. Test it. Commit. Then start the next. Context-switching is where "I thought I fixed that" comes from.

### 5b. Verify in MFL before declaring done
Per memory `feedback_cta_parity_and_canonical_rules`: every CTA change must mirror desktop and be exercised in the real MFL UI before you mark the task complete. "Tests pass" ≠ "feature works."

### 5c. Read the most recent commit on a hot file before editing it
If you're about to change a file that was last touched two days ago in a fix-commit, read that PR's description first. You're often one revert away from re-breaking what's already fixed.

### 5d. Don't let an AI assistant skip the checklist
When working with Claude (or any AI), paste the §1 checklist at the start of the session if the task touches a danger-zone file. Otherwise the assistant defaults to "find the bug and patch it" — which is exactly the workflow that causes regressions.

### 5e. Surface what you touched
At the end of every change, list every file modified and which bucket it belongs to. Pin this to the PR description. This is the trail of breadcrumbs you (and future-you) will need when something breaks two weeks later.

---

## TL;DR

Three changes you can make this week that will cut regression rate significantly:

1. **Adopt the §1 checklist** for every danger-zone file edit (free, just discipline).
2. **Add top-of-file blast-radius headers** to the 10 files in §2 (Tier A1, ~30 min).
3. **Clean up worktrees + branches** per [`docs/BRANCH_CLEANUP_2026-05-26.md`](BRANCH_CLEANUP_2026-05-26.md) (one-time effort).

Everything else is gravy — but those three address the root causes today, with zero new tooling.
