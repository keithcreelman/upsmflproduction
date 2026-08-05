# DISCORD INVENTORY — UPS MFL Production

**Generated:** 2026-05-26 · **Revised:** 2026-05-29 (after full walkthrough with Keith)
**Purpose:** Complete map of every Discord send-site, channel, trigger, and the cleanup/rebuild work. SSOT for "what fires to Discord, when, why, and where."

This doc reflects DECISIONS made in the 2026-05-29 walkthrough. Items marked **BUILD** / **DELETE** / **MOVE** are not yet implemented — see the action lists. Items marked **LIVE** are running today.

---

## Final channel map (target state)

| Channel ID | Name | Receives | Mentions |
|---|---|---|---|
| **1059111651846131833** | **Transactions** | Drops (LIVE ✓) · Trades · **Trade roasts** (posted right after each trade — reads as a reply; year-round) · Tags · Rookie picks · Auction wins (ERA + FA — each spawns a per-lot thread) | — |
| **1059113303059730494** | **Contract-Activity** | Signings · Extensions · MYM · Restructures | — |
| **1087157907419840644** | **Coffee Shop** | Deadline reminders · "Rule passed" cross-posts | **@everyone** on every post |
| **1066399931574779914** | **Rules** | Rule proposal threads + voting buttons | — |
| **1089538054236160010** | **Test** | All `*-test-discord` / test-target sends | — |
| ~~1066390675207233618~~ | (old cap penalty) | **DEAD** — archive channel; delete env var | — |
| ~~bug channel~~ | — | **DEAD** — kill endpoints + env vars | — |
| 1498680803419357234 | 2026 Rookie Draft thread | **DECISION DEFERRED** — keep / archive / repurpose | — |

---

## 1. Deadline Reminders → Coffee Shop (LIVE, needs calendar expansion)

**Channel:** `1087157907419840644` (Coffee Shop), **@everyone** on every post.
**Mechanism:** worker hourly cron checks for due reminders, fires at `09:00 ET` on each configured offset day (idempotent via `(season, event_key, reminder_code, deliveryTarget)`). NOT hourly spam — each unique reminder fires once.
**Backup:** `.github/workflows/post-deadline-reminders.yml` — calls the same `/admin/deadline-reminders/run` endpoint the cron uses (no logic to drift). Keep; rename to indicate manual-backup. **No rework — verify alignment only** (Keith).

**Target calendar (7 events, 2026):**

| # | Event | Deadline (ET) | Reminders | Status |
|---|---|---|---|---|
| 1 | Expiring Rookie Extensions + Tag Deadline | 2026-05-21 21:00 | 7d / 2d / 1d @ 9am | LIVE |
| 2 | Rookie Draft | 2026-05-24 18:30 | 7d / 3d @ 9am + 1hr before | LIVE |
| 3 | **ERA Start** | 2026-05-25 06:00 (day after draft) | single notice 9am day before | **BUILD** |
| 4 | **Auction Cut / FA Drop Deadline** | 72 hours before FA Auction opens | 7d / 1d @ 9am | **BUILD** (one event; supersedes old 21:00 value) |
| 5 | Free Agent Auction Opens | 2026-07-25 12:00 | 7d / 1d @ 9am | LIVE |
| 6 | Contract Deadline (= Roster Deadline Day; restructure window close) | 2026-09-06 21:00 | 7d / 1d @ 9am | LIVE |
| 7 | Trade Deadline | 2026-11-26 13:00 | 7d / 1d @ 9am + 1hr before | LIVE |

Dropped/merged: old #5 "Expiring Non-Rookie Extensions" = same as Contract Deadline (#6); old separate FA Drop = #4.
**Not reminders** (per Keith): MYM (used all season), OTB/On-the-Block (no deadline), weekly lineup (everyone knows), waivers (everyone knows).

**NEW — yearly DM prompt:** scheduled Jan-1 DM to commish: "time to update DEADLINE_REMINDER_CALENDAR for season {year}" + link to `worker/src/index.js` `DEADLINE_REMINDER_CALENDAR`. **BUILD.**
**Dropped:** the on-demand `/deadlines` slash command (Keith: owners won't use slash commands).

---

## 2. Drops + Cap Penalty → Transactions (LIVE new flow; OLD flow must be deleted)

**Canonical (LIVE):** every 5 min, the drop tracker scans MFL → writes `ups_drop_events` → posts the rich per-player embed to **Transactions `1059111651846131833`** (`DISCORD_DROPS_CHANNEL_ID`). Gated by `DROP_TRACKER_ENABLED=1` + `DROP_TRACKER_AUTO_POST=1`. Format = the canonical drop record (header `# 💰 Cap Penalty: $X` or `# ✅ No Cap Penalty`, Team/Player/Position/Contract/Pre-drop state/Cap penalty/Dropped fields, tiered GIF).

**DELETE — OLD duplicate flow (verified still present in main 2026-05-29, NOT cleaned up):**
- ✅ **DONE 2026-08-05.** Hourly cron block — grouped-by-franchise penalty post to `1066390675207233618`. The Discord half went 2026-07-20; the remaining MFL-import half was removed 2026-08-05. It had never actually run on this cron: it self-fetched the worker's own public workers.dev hostname (404, silent — the response status was never checked), and once PR #808 routed it through `env.SELF` and added a status check it surfaced 403, because the route authenticates off `?APIKEY=` in the query string while the block sent an `X-Internal-Auth` header. Redundant regardless — the `*/5` drop tracker already writes penalties to MFL via `/admin/drops/post-mfl`.
- `sendDiscordCapPenaltyAnnouncement` function (`:~20532`)
- `/admin/cap-penalty/post` + `/admin/cap-penalty/test-discord` routes (`:~30707`)
- `DISCORD_CAP_PENALTY_CHANNEL_ID` env var (`:1996`, `:2205`)
- Archive Discord channel `1066390675207233618` (held the one-time 2025 rollforward penalties)
**KEEP:** `/admin/import-drop-penalties` route as a manual-only endpoint for future rollforwards.

---

## 3. Contract Activity → split into TWO channels (BUILD — env split + rich-format rebuild)

**Today:** one `DISCORD_CONTRACT_CHANNEL_ID` handles trade + restructure + contract activity. **Split into two env vars:**
- `DISCORD_TRADES_CHANNEL_ID` → **1059111651846131833** (Transactions)
- `DISCORD_CONTRACTS_CHANNEL_ID` → **1059113303059730494** (Contract-Activity)

**Routing by activity type (in `sendDiscordContractActivity`):**

| Activity | Channel |
|---|---|
| Trade | Transactions |
| Tag (single tag type now — no Franchise/Transition split) | Transactions |
| Signing | Contract-Activity |
| Extension | Contract-Activity |
| MYM | Contract-Activity |
| Restructure | Contract-Activity |

**DELETE:** standalone `sendDiscordRestructureAlert` + `/admin/restructure-alert/post` + `/admin/restructure-alert/test-discord`. Restructures go only through the unified contract-activity path (Keith: "only via A").

**BUILD — rebuild contract-activity posts to match the drops rich format:**
- Header banner per type, positive tone (e.g. "🤝 Signed", "💍 Extended", "💸 Restructured") — distinct from the drop's penalty framing.
- Fields: Team / Player / Position / Contract details (CL, TCV, AAV, year schedule) / pre→post where relevant (restructure) / Eastern timestamp.
- Positive GIF pool per activity type (refine queries later).
- Color-coded per type.
- **MVP:** ship with header = "Player Name (NFL Team fallback)"; refine GIFs iteratively.

**Trade idempotency:** auto-post fires on `/api/trade/process` accept; manual `/admin/trade-notification/post` has no dedup guard. Leave as-is per Keith; adjust if it becomes a real double-post problem.

---

## 4. Hall Voting / Rule Proposals (LIVE; nudge cadence + close-message rewrite)

**Channels:** Rules `1066399931574779914` (proposal threads + voting buttons); "rule passed" cross-post → Coffee Shop `1087157907419840644` with **@everyone**.
**Inbound:** `/discord/interactions` (button clicks; Ed25519-verified via `DISCORD_PUBLIC_KEY`).

**BUILD — round-age-driven nudge cadence** (today: fixed `5 0,12,18 * * *` 3×/day):

| Round age | Nudge frequency |
|---|---|
| Days 1–7 | every 72h |
| Days 8–14 | every 48h |
| Day 15+ | every 24h |

Implementation: cron fires daily; each open round computes `days_since_last_nudge` vs. its age-tier and decides nudge-or-skip.

**BUILD — overdue-close message format:**
```
The poll is now closed. Vote was open {N} days.
Result: {YES} YES · {NO} NO · {ABSTAIN} ABSTAIN
The following members did not vote: @{m1}, @{m2}, ...
```

**Slash commands:** disregard (Keith). Audit + unregister any currently-registered slash commands; keep button interactions.

---

## 5. Rookie Draft Picks + Auction Wins + Trade Roast (mostly LIVE; config moves)

**Rookie picks:** ONCE only, in Transactions (pick IS the auto-signing — no separate Contract-Activity post). Currently default channel `DISCORD_PICKS_THREAD_PARENT_CHANNEL_ID`=`1059111651846131833`. ✓

**Auction wins (ERA + FA):** the auction narrator (`narrateAuctionEvents`, worker `index.js:757`) posts per-lot to the auction channel and **spawns a per-lot thread** (`Auction · {Player} ({Pos · NFL Team})`); bids + win post in-thread. **MOVE:** set `DISCORD_AUCTION_CHANNEL_ID` = **1059111651846131833** (Transactions) — currently falls back to `DISCORD_DRAFT_CHANNEL_ID`. FA auction wins post the same way once FA folds into the Auction Hub (see CONTRACT_AUTOMATION_PLAN Gap 1).

**Trade roast:** `pipelines/etl/scripts/trade_roast_bot.py`. By design the trade-notification embed omits its Analysis section so the roast completes it as the next post in the **same channel** (reads as a reply). **MOVE:** `PROD_CHANNEL_ID` → Transactions `1059111651846131833` (currently stale `1498680803419357234`). Runs year-round. Clap-back loop: tracks roast message IDs, owner replies trigger context-aware Claude responses.
- **BUILD (follow-up K):** port the roast bot from a hand-launched Python process to a worker-cron trigger so it's always-on, co-located with trade detection (LLM already proxies via `/api/anthropic-proxy/v1/messages`).

---

## 6. Bug Reports → DELETE (circle back later)

**DELETE:** `/bug-report`, `/bug-reports`, `/admin/bug-report/{status,triage-note,test-discord}`, `sendDiscordNotificationForBug`, `DISCORD_BUG_CHANNEL_ID` + `DISCORD_BUG_TEST_CHANNEL_ID`, and the widget mounts in `site/ups_issue_report.html` + `site/hpm-issue-report.html`. **Keep** any existing bug data in D1 (don't drop the table). Simpler bug reporting returns in a future iteration.

---

## Env var changes (rollup)

| Env var | Action |
|---|---|
| `DISCORD_CONTRACT_CHANNEL_ID` | **Split** → `DISCORD_TRADES_CHANNEL_ID` (1059111651846131833) + `DISCORD_CONTRACTS_CHANNEL_ID` (1059113303059730494) |
| `DISCORD_AUCTION_CHANNEL_ID` | **Set** = 1059111651846131833 (Transactions) |
| `DISCORD_CAP_PENALTY_CHANNEL_ID` | **Delete** (old flow removed) |
| `DISCORD_BUG_CHANNEL_ID` / `DISCORD_BUG_TEST_CHANNEL_ID` | **Delete** (bug reports removed) |
| `DISCORD_RULES_CHANNEL_ID` | Confirm = 1066399931574779914 |
| `DISCORD_ANNOUNCE_CHANNEL_ID` | Confirm = 1087157907419840644 (Coffee Shop) |
| `DISCORD_CONTRACT_USE_TEST` | **Verify NOT set in prod** (would silently route contract activity to test) |
| `DISCORD_DRAFT_CHANNEL_ID` (1498680803419357234) | Decision deferred — keep until rookie-draft-channel call is made |

---

## Active sends — quick reference (post-cleanup target)

| Trigger | Channel | Send |
|---|---|---|
| Hourly cron @ due | Coffee Shop (@everyone) | Deadline reminder |
| 5-min drop tracker | Transactions | Drop + cap penalty (rich) |
| `/api/trade/process` accept | Transactions | Trade announcement |
| Trade roast bot (year-round) | Transactions | Roast (after the trade post) |
| Contract activity (sign/ext/mym/restructure) | Contract-Activity | Rich contract post |
| Tag apply | Transactions | Tag post |
| Auction narrator (ERA + FA) | Transactions (threads) | Nom/bid/overtake/won |
| Rookie pick | Transactions | Pick post |
| Hall round lock | Rules + Coffee Shop (@everyone) | Vote result |
| Hall nudge (age-driven) | Rules | Voter nudge |

---

## Idempotency contracts (don't re-break these)

- **Deadline reminders:** `(season, event_key, reminder_code, deliveryTarget)` in D1.
- **Drops/cap penalty:** `ups_drop_events.discord_posted` flag + `ledger_key`.
- **ERA/FA contract finalize:** compare current MFL `contractInfo`, skip if equal.
- **Hall rounds:** `(round_id, phase)`.
- **Rookie kickoff / final order:** D1 marker tag, once per cycle.
- **Trade announce:** auto-post on accept; manual path has NO guard (accepted risk).
- **Auction narrator:** per-event classification keyed off prior bid in lot.

---

## How to use this doc

When adding/changing a Discord send: pick a channel from the map (reuse, don't proliferate), pair with a test-target, define an idempotency key before going live, and add a row to "Active sends." If silencing/removing, update the channel map + env rollup.
