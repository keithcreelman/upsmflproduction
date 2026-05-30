# FOLLOW-UP TASKS — 2026-05-26 review

Surfaced during Keith's review of [`docs/MODULE_INVENTORY.md`](MODULE_INVENTORY.md) on 2026-05-26.

Decisions made are already reflected in MODULE_INVENTORY. This doc captures the **new work** those decisions imply, so nothing gets lost.

---

## A. Front Office → Team Operations transition

**Decision:** Team Operations (`site/team_operations/team_operations.js`) will eventually REPLACE Roster Workbench (`site/rosters/roster_workbench.js`). But not until it's ready.

### A1. Functionality audit (BLOCKING — do before any transition)

Produce a side-by-side feature matrix: every capability of the current Roster Workbench, mapped to its Team Operations equivalent (or "missing"). For each "missing" row, decision: **keep / scrap / salvage**.

Capabilities to audit at minimum (this is a starter list — expand by walking the actual workbench):
- Drop / cut player flow
- Cut + reserve flow
- Taxi promote / demote
- IR slot management
- Extension UI (existing FL/BL/Veteran/Rookie types)
- Tagging UI (Franchise / Transition)
- MYM submission
- Restructure submission
- Contract submission & audit trail (recent: `site/rosters/contract_submissions/`)
- Lineup submission
- Cap penalty preview
- Trade bait toggle
- Player profile modal integration
- Salary cap visualization (current + projected)
- Position leverage / max bid display
- Free agent acquisition flow

Deliverable: `docs/FO_TRANSITION_AUDIT.md` with a 3-column table (Capability · Roster Workbench · Team Ops · Decision · Notes).

### A2. Data-alignment audit

Both workbenches WRITE to MFL. The transition is unsafe if they emit different payloads for the same action. Confirm parity on:

- **Extension submissions** — same `IMPORT_EXTENSION` payload shape? Same per-year salary parsing? Same handling of `Underpay N` tokens? (See repo memory `mfl_underpay_token_load_bearing`.)
- **Tagging submissions** — same Franchise/Transition tag write path? Same comp-pick attribution?
- **Drop / penalty flow** — same `IMPORT_DROP` payload? Same Discord cap-penalty trigger?
- **Lineup submission** — same 14-player serialization? (Per memory `feedback_cta_parity_and_canonical_rules`: "every new action button must reuse the desktop worker route + payload shape.")
- **MYM / restructure** — same forms, same canonical rules from `docs/league_context_v1.md`?
- **Worker routes** — do both consume `/api/me`, `/api/settings`, `/roster-workbench/action`, `/api/submit-lineup`? Are there any routes that one calls and the other doesn't?

Deliverable: 2nd section in `docs/FO_TRANSITION_AUDIT.md` — "Data alignment" — with a verdict per write path: **aligned / divergent / N/A**. For each divergent, document the difference and why.

### A3. Cutover plan

Only after A1 + A2 land:
- Pick a cutover date
- Decide on a feature flag (header/footer flag or D1 runtime flag)
- Plan a regression test pass against the audit matrix
- Plan an announcement to the league

---

## B. Auction Module

### B1. Mobile view (`site/m/`)

Auction Hub is desktop-only today. Add a mobile view under `site/m/views/auction.js` mirroring the existing patterns in `site/m/views/contracts.js` and `site/m/views/draft.js`. Per repo memory `feedback_mobile_site_isolation_scope`, code is isolated but actions write to real MFL via shared worker routes — reuse `/acquisition-hub/*` endpoints.

Scope MVP: at minimum the active War Room / current bids view. Defer Expired Rookie Pool table (large) if needed.

### B2. O=43 CSS bug list

Specific rendering issues on the MFL O=43 page (nomination flow), all related to the alert / form elements UPS injects:

1. **Border overlaps text on hint alert** (top of page)
   - Element: `<span class="alert alert-info-body"><span class="reportnavigationheader">Hint:</span> All bids must be in increments of $1000.00. ...</span>`
   - Fix: tune padding / line-height in the `.alert.alert-info-body` rule (likely in `header_custom_v2.html` or `site/rosters/ups_trade_offer_patch.js`)

2. **MSG textarea renders wonky**
   - Element: `<textarea name="MSG" rows="1" cols="50" placeholder="Optional Bid Comment"></textarea>`
   - Fix: explicit width / box-sizing / padding override in our trade-offer CSS

3. **"Select a player for nomination" button is blue-on-blue at rest**
   - Element: `<button type="button" class="ups-picker-trigger">...</button>`
   - Fix: make button GOLD at rest (not just on hover). Current default state has poor contrast.

4. **Border overlaps text on second hint alert** (max-bid hint)
   - Element: `<span class="alert alert-info-body"><span class="reportnavigationheader">Hint:</span> In order to have enough money...</span>`
   - Fix: same root cause as #1 — fix the `.alert.alert-info-body` rule once, both go away.

Recommended approach: dig through the existing O=43-specific CSS rules in `header_custom_v2.html` lines 481-565 and `footer_custom_v2.html` lines 156-490 and `site/rosters/ups_trade_offer_patch.js`. Pick the right home for the fix; don't add a 3rd location. Cross-reference with the TOS removal plan (B4 below) since some of these styles are TOS-mirror rules.

### B3. Auction mobile + O=43 fixes — execution order

Do O=43 CSS fixes first (small, immediate UX wins). Mobile view can be a separate effort.

### B4. Cross-reference: TOS removal

Some auction-page styling is currently "TOS-mirror" CSS — written to mimic what `mflscripts.com/.../header.js` does to the DOM. As TOS sunsets per `docs/mfl_native/tos_removal_plan.md`, audit which auction styles still need to exist as overrides vs which can become first-party UPS-owned CSS.

---

## C. Trade Module

### C1. Mobile view

Add Trade Workbench surface to `site/m/`. Reuse the desktop trade routes (`/api/trade`, `/api/trade/process`, `/api/trades/proposals*`).

### C2. Future: 3-team trade capability (backlog)

Not for the next release — captured here so it doesn't get lost. Will require:
- MFL API support for 3-way trades (verify — MFL's `tradeProposal` may only accept 2 franchises)
- Trade workbench UI redesign (acceptance state across 3 franchises, who-must-accept logic)
- Discord announcement template

---

## D. Stats Workbench

### D1. Verify automated data ingestion

Season-long stats depend on continuous ingestion. Confirm:
- Which pipeline populates `d1/advanced_stats` table feeding `/api/advanced-stats-*` endpoints?
- Is it running on a cron? Which `.github/workflows/*.yml` or `pipelines/etl/` script?
- Are there gaps in the snapshot history (weeks not ingested)?
- Does the per-week breakdown (`/api/advanced-stats-player-weekly`) need a backfill pass before week 1 of next season?

Deliverable: confirm the ingestion runs without manual intervention all the way through the regular season + playoffs.

---

## E. MFL injected-CSS rendering audit

Walk every MFL page that we customize and screenshot it. Compare against expected design. The known issue surface:

- Roster page (`O=05`, `O=07`)
- Trade offer page (`O=43`) — see B2
- Submit Lineup page (`O=07`)
- All `hpm-*.html` pages (default, draft-hub, myteam, reports, standings, stats-workbench, mcm, issue-report)
- Home page (`?MODULE=HOME`)
- Any MESSAGE<N> page that loads our HPM content

Inputs to check:
- Header `<style>` blocks (lines 481+ in `header_custom_v2.html`)
- Footer `<style>` blocks (lines 494+ in `footer_custom_v2.html`)
- `site/loader.js` global CSS injection (line 37 contrast fix)
- All `*.css` files referenced from each module

Output: a checklist with screenshots — rendering OK / needs fix. The O=43 bugs in §B2 are entry items #1-4 on this list.

---

## F. External MFL scripts — execute existing TOS sunset

There's already a comprehensive plan at [`docs/mfl_native/tos_removal_plan.md`](mfl_native/tos_removal_plan.md) — 12-20 person-days across 10 stages, "drain don't yank" strategy. The decision today is to **execute it**, not redesign it.

**Immediate step (decision made today):** snapshot the remaining vendor files into the repo, so we have a versioned copy to diff against if TOS pushes a mid-flight change while we sunset:

```bash
mkdir -p vendor/mflscripts
curl -fSL "https://www.mflscripts.com/mfl-apps/global/header.js?v=1.60" \
  -o vendor/mflscripts/header_v1.60.js
curl -fSL "https://www.mflscripts.com/mfl-apps/global/footer.js?v=1.12" \
  -o vendor/mflscripts/footer_v1.12.js
curl -fSL "https://mflscripts.com/mfl-apps/playoffs/standingsColumns.js" \
  -o vendor/mflscripts/standingsColumns.js
git add vendor/mflscripts/
git commit -m "snapshot: vendor MFL scripts at pre-sunset baseline"
```

Then drive the TOS removal plan stages. Already partially complete:
- ✅ Stage 8c — Rosters fork audit (`docs/mfl_native/rosters_fork_audit.md`)
- ⏳ Other stages — see plan document

---

## Priority order (proposed)

If you can only pick a few to start:

1. **Worktree/branch cleanup** (zero risk, see [`docs/BRANCH_CLEANUP_2026-05-26.md`](BRANCH_CLEANUP_2026-05-26.md)) — do this before any other work; it removes the regression accelerator.
2. **O=43 CSS bug fixes** (§B2) — small, immediate user-visible wins, plus a useful warmup for the broader CSS audit.
3. **Vendor script snapshot** (§F first step) — 5 minutes, immediately closes a silent-change risk.
4. **Stats Workbench ingestion verification** (§D) — important to confirm before regular season starts.
5. **FO transition audit** (§A1 + A2) — biggest payoff, biggest effort. Schedule a dedicated session.
6. Mobile views for Auction + Trade (§B1, §C1) — can run in parallel with FO audit since they're separate code.
7. Everything else as scheduled.

---

---

# Sections added 2026-05-29 (Discord walkthrough + data-authority pass)

## G. Discord rebuild

Full spec + channel map in [`docs/DISCORD_INVENTORY.md`](DISCORD_INVENTORY.md). Work items:

- **G1. Cap-penalty cleanup (verified NOT done).** Delete OLD hourly drop block (`worker/src/index.js:~1957-2010`) + `sendDiscordCapPenaltyAnnouncement` + `/admin/cap-penalty/post` routes + `DISCORD_CAP_PENALTY_CHANNEL_ID`. Keep `/admin/import-drop-penalties` manual-only. Archive Discord channel `1066390675207233618`. ~0.5 day.
- **G2. Contract-channel split + rich rebuild.** Split `DISCORD_CONTRACT_CHANNEL_ID` → `DISCORD_TRADES_CHANNEL_ID` (Transactions) + `DISCORD_CONTRACTS_CHANNEL_ID` (Contract-Activity); route trade+tag → Transactions, sign/ext/mym/restructure → Contract-Activity; delete standalone restructure path; rebuild contract posts to drops-style rich format with positive GIFs. ~2-3 days.
- **G3. Deadline calendar expansion.** Add ERA Start (9am day-before) + Auction Cut/FA Drop (72hr-before-auction) events; add `@everyone` to coffee-shop posts; add yearly Jan-1 DM prompt to update the calendar. ~0.5 day.
- **G4. Hall nudge rewrite + close message.** Age-driven cadence (72h/48h/24h); overdue-close message format; unregister slash commands. ~0.5 day.
- **G5. Channel moves.** `DISCORD_AUCTION_CHANNEL_ID` → Transactions; trade roast `PROD_CHANNEL_ID` → Transactions. Verify `DISCORD_CONTRACT_USE_TEST` unset in prod. ~0.25 day.
- **G6. Bug reports — delete.** Endpoints, function, env vars, widget mounts. Keep D1 data. ~0.25 day.

## H. Lineup compliance DM system (sizable — new)

1.5hr before each NFL game window, DM each owner their lineup status vs. the injury report. Window triggers: Wed (1.5hr before), Sun early-9:30am-ET (8:00am), Sun 1pm (11:30am), Sun 4:00/4:25 collapsed (3:00pm — 1hr before 4:00 / 1.5hr before 4:25), SNF (6:50pm), MNF (6:45pm), TNF (6:45pm), Black Friday / Saturday games (base off NFL schedule, 1.5hr before window).
- **Rule (verify against canon — may be new):** injury reference snapshot = Friday midnight ET. Player declared OUT as of that snapshot in your starting lineup = **possible violation**. DOUBTFUL Friday = start at own risk; if later declared OUT Sunday = violation. Any other status that later turns OUT = NOT a violation but a **courtesy advisory**.
- DM clearly distinguishes **"possible lineup violation"** vs **"courtesy heads-up."** Clean lineup = "in compliance" message.
- Injury source: `https://api.myfantasyleague.com/2026/export?TYPE=injuries&W=&JSON=0`.
- Log every DM to D1. Future enhancement: button in DM → lineup submission page.

## I. Injury Report module (new)

- Source: MFL `TYPE=injuries`. Designate as the **SSOT for injury status** across UPS (per `DATA_AUTHORITY_MAP.md`).
- Build a standalone injury report view + integrate into `site/shared/player_profile_master.js` (universal player modal).
- Feeds the §H lineup-compliance system. Add as a new bucket in MODULE_INVENTORY once built.

## J. Schedule audit (the Standings V2 canary)

The V2 division bug = a build script that isn't scheduled, so MFL's updated divisions never re-render. Fix the class, not just the instance:
- Walk every `pipelines/etl/scripts/build_*.py`; classify each as **needs-recurring-schedule** vs **manual-only**.
- Stand up a single `nightly-builders.yml` (runs after `mfl-daily-snapshot.yml`) for the recurring ones — `build_standings_snapshot.py` is the immediate one.
- **Roster anomaly/transaction-validation pass** (per `DATA_AUTHORITY_MAP.md` drift hotspot #0): daily job that diffs today's roster/salary pull vs. yesterday and flags any change with no matching MFL transaction.
- **Contract reconciliation-on-read** (per `CONTRACT_AUTOMATION_PLAN.md`): nightly re-parse of MFL `contractInfo` vs. D1; flag mismatches, never auto-overwrite.
- Make the schedule itself a doc: scheduled Discord / scheduled MFL pulls / scheduled builders — one table so cadence is never a mystery.
~1 day for the audit + nightly-builders; reconciler is in the contract plan.

## K. Trade roast bot → worker port

Move the roast bot from a hand-launched Python process to an always-on worker-cron trigger that fires on new-trade detection and posts to Transactions. LLM already proxies via `/api/anthropic-proxy/v1/messages`. ~1-2 days. (Interim: keep Python, just point `PROD_CHANNEL_ID` at Transactions per G5.)

## L. Auction Discord verification + FA fold-in

- Verify the per-lot thread mechanic posts correctly to Transactions once `DISCORD_AUCTION_CHANNEL_ID` moves.
- FA Auction folds into the Auction Hub (kill Acquisition Hub) with owner-selected Contract Options — full spec in [`docs/CONTRACT_AUTOMATION_PLAN.md`](CONTRACT_AUTOMATION_PLAN.md) Gap 1. Before July.

---

## Updated priority order

1. **Worktree/branch cleanup** ([`BRANCH_CLEANUP_2026-05-26.md`](BRANCH_CLEANUP_2026-05-26.md)) — removes the regression accelerator. First.
2. **Schedule audit + reconcilers** (§J) — fixes the Standings V2 bug AND installs the drift safety nets. High leverage.
3. **Discord cleanup** (§G1, G5, G6) — delete dead/duplicate paths; low risk, removes confusion.
4. **O=43 CSS fixes** (§B2) + **vendor script snapshot** (§F) — quick visible wins.
5. **FA auction → Auction Hub + Contract Options** (§L + Contract Plan Gap 1) — before July.
6. **Discord rich-format rebuilds** (§G2, G3, G4) — meatier; schedule after cleanup.
7. **FO transition audit** (§A) — biggest payoff, dedicated session.
8. **Lineup compliance DM + Injury module** (§H, §I) — before regular season.
9. Mobile views (§B1, §C1), roast bot port (§K), history backfill — as scheduled.

---

## What's NOT in this doc

- Pre-existing TOS plan stages — see [`docs/mfl_native/tos_removal_plan.md`](mfl_native/tos_removal_plan.md), don't restate.
- Regression-prevention guardrails — see [`docs/CHANGE_PLAYBOOK.md`](CHANGE_PLAYBOOK.md) §4.
- Data-authority rules + contract automation — see [`docs/DATA_AUTHORITY_MAP.md`](DATA_AUTHORITY_MAP.md) + [`docs/CONTRACT_AUTOMATION_PLAN.md`](CONTRACT_AUTOMATION_PLAN.md).
