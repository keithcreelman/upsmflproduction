# Cross-Codebase Alignment

**Last updated:** 2026-05-16 (post-§6 disposition pass — Keith review session)
**Owner:** Keith Creelman
**Status:** Living document — update before every multi-codebase PR.

---

## ⚠️ THE NON-NEGOTIABLE RULE

> **EVERYTHING NEEDS TO BE ALIGNED.**
>
> Desktop client, mobile client, and worker MUST agree. When they disagree, the worker wins (it's the enforcement boundary). When canon is unclear, the rulebook wins. When the rulebook is unclear, ASK KEITH and document the answer in this file under §6 below.

---

## 🚨 THE FOUR IMPERATIVES

1. **READ `docs/league_context_v1.md` IN FULL DETAIL BEFORE TOUCHING ANY CODE.**
   Not a skim. Not "I remember roughly." Open it, read every section relevant to what you're changing, then read one section adjacent that you didn't plan to. The audits in §3 below caught real rule mismatches because someone DIDN'T do this.

2. **DON'T ASSUME ANYTHING.**
   If you find yourself thinking "I think the rule is…", stop. Open `league_context_v1.md` and find the literal text. Cite it: `§C4.6 — Schedule 1 escalators`. If the text is ambiguous, jump to §6 of this doc.

3. **NEVER MAKE AMBIGUOUS DECISIONS ALONE.**
   If the rule isn't 100% certain in `league_context_v1.md`:
   1. Re-read the section + adjacent sections.
   2. Re-read for 5 minutes. Sometimes the answer is two paragraphs above where you're looking.
   3. If still unsure: STOP. Ask Keith. Don't guess. Don't ship the "best interpretation."
   4. Once Keith answers, document it under §6 with date.

4. **EVERY SUBMISSION FIRES ALL FOUR HOOKS (UNLESS DOCUMENTED OTHERWISE).**
   - **MFL write** — the actual transaction lands on MFL servers
   - **D1 audit row** — `ups_*_submissions` table captures the action with `source` field discriminator
   - **Discord post** — the right channel (or DM, per §C8 untag rule)
   - **Cap-penalty cron** — if the action affects cap, the hourly cron picks it up via `ledger_key` dedup

   The only documented exception is **Lineup** (skips D1 + Discord by Keith's call 2026-05-16, pending the DM-fan-out plan in `MOBILE_DRIFT_PREVENTION.md §2.8`). Every other action that skips ANY of the four needs explicit Keith approval and a row here.

---

## §1 — How to use this doc

When you're about to ship a multi-codebase change:

1. **Find your rule category in §3.** Read the audit results. If your change touches anything marked DRIFT or GAP, you MUST address it.
2. **Cite `league_context_v1.md`.** Every PR description for a contract/cap/rule change includes the canon citation (`§C4.6` style).
3. **Verify with real data.** Pull from worker URLs (in `MOBILE_DRIFT_PREVENTION.md §4 Step 4`); compare against canon; against what the worker actually writes.
4. **If you DIVERGE intentionally**, document it under §5 below with re-converge plan.
5. **If something is AMBIGUOUS**, document the question under §6, get Keith's answer, encode it back into `league_context_v1.md` as a clarifying paragraph.

---

## §2 — Files under cross-codebase scope

| Concern | Worker (canonical) | Desktop (preview) | Mobile (preview) |
|---|---|---|---|
| Drop penalty math | `worker/src/lib/cap_penalty.js` | `site/rosters/roster_workbench.js` `dropPenaltyEstimate` | `site/m/front_office_penalty.js` `dropPenaltyEstimate` |
| Cap math | (writes via cron) | `site/team_operations/team_operations.js renderCaps` ~660-708 | `site/m/front_office_cap.js` |
| Lineup validation | `worker/src/index.js` `/api/submit-lineup` | `site/team_operations/team_operations.js` ~829-883 | `site/m/front_office_lineup.js` |
| Contract eligibility | (worker validates payloads) | `site/rosters/roster_workbench.js rosterContractEligibility` 558-576 | `site/m/front_office_actions.js` |
| Extension blocks (§C4.7, §C8.2) | (worker rejects on submit) | `roster_workbench.js extensionBlockedByCurrentOwner` 1264-1271 | `site/m/front_office_actions.js extensionBlockedByCurrentOwner` |
| Tag/Untag submit + Discord | `worker/src/index.js` `/commish-contract-update` | `roster_workbench.js submitTagPlanSelection` 11216, `submitUntagPlayer` 11307 | `site/m/front_office_tag_submit.js` |
| Extension submit | `worker/src/index.js` `/commish-contract-update` (`submission_kind=extension`) | `roster_workbench.js submitExtensionUpdate` 10839 | `site/m/front_office_extend_submit.js` |
| Restructure submit | `worker/src/index.js` `/offer-restructure` | `roster_workbench.js submitRestructureUpdate` ~10975 | `site/m/front_office_restructure_submit.js` |
| Cap-penalty cron | `worker/src/index.js` hourly cron (`5 * * * *`) | n/a | n/a |
| Discord routing | `worker/src/index.js sendDiscordContractActivity` ~15437 + `sendDiscordContractActivityDm` ~15594 | n/a | n/a |

---

## §3 — Audit results (2026-05-16, 7-agent deep dive)

Each agent read `league_context_v1.md` in full and traced its rule category to enforcement in all three codebases. Findings tagged:

- **✓ ALIGNED** — canon matches enforcement on all three sides
- **⚠ DRIFT** — one or more codebases diverges; cross-codebase PR required
- **🔴 GAP** — canonical rule has NO enforcement anywhere
- **❓ AMBIGUOUS** — rule unclear, needs Keith's clarification (→ §6)

### §3.1 — Contract Actions (Drop, Tag, Untag, Extension, Restructure, MYM, Rookie Option)

| Rule | Canon | Worker | Desktop | Mobile | Overall |
|---|---|---|---|---|---|
| §D1 cap penalty formula | `(TCV × 75%) − Salary Earned` (era-aware) | ✓ `worker/src/lib/cap_penalty.js` per-week (post 2026-05-08), calendar-monthly (2019-2026-05-07), pre-2019 flat | ✓ Mirror via `dropPenaltyEstimate` | ✓ Mirror | ✓ ALIGNED |
| §D2.1 WW <$4K cap-free | Code uses `<$5K` boundary (not $4K) | ⚠ `cap_penalty.js:49-54` — $5K threshold | n/a | n/a | ⚠ DRIFT — see §6 Q1 |
| §D2.4 multi-year TCV<$5K → $1K floor | Worker has it; clients lack | ✓ `multiYearLowTcvPenalty` | 🔴 Missing | 🔴 Missing | ⚠ DRIFT (`MOBILE_DRIFT_PREVENTION.md §2.3`) |
| §D2.5 tag pre-Aug-1 cut → $0 | Tag-cut pre-FA-auction nullifies tag | ✓ Worker + clients all enforce | ✓ | ✓ | ✓ ALIGNED |
| §C4.1 extension eligibility (cy=1 OR expired rookie) | Client gates; worker trusts | ⚠ No server validation | ✓ `rosterContractEligibility` | ✓ Mirror | ⚠ DRIFT — worker should re-validate |
| §C4.2/§C4.3 Ext1 no FL/BL; Ext2 FL/BL allowed | Suffix auto-derivation gap | ⚠ No validation | ⚠ `-FL`/`-BL` suffix NOT auto-derived from year salaries | ⚠ Same | ⚠ DRIFT — see §6 Q2 |
| §C4.6 AAV escalators (Sch1 +$10K/$20K, Sch2 +$3K/$5K) | All sides have constants | ⚠ No validation | ✓ `EXTENSION_RATES` matches canon | ✓ Mirror | ✓ ALIGNED |
| §C4.7 in-season extension windows (4-week trade, 14-28 day WW) | NO enforcement anywhere | 🔴 GAP | 🔴 GAP | 🔴 GAP | 🔴 GAP (`MOBILE_DRIFT_PREVENTION.md §2.6`) |
| RULE-EXT-003 same franchise can't extend twice | All three need + have it | ⚠ No server validation | ✓ `extensionBlockedByCurrentOwner` | ✓ Mirror (PR #194) | ✓ ALIGNED on clients; worker should backstop |
| §C8.2 tagged player can't be extended or MYM'd | Mobile-only gate added 2026-05-16 | ⚠ No server validation | ✓ via `status.indexOf("tag")` | ✓ `wasTaggedThisSeason` (PR #205) | ✓ ALIGNED on clients |
| §C3 MYM 14-day window post-pickup | No enforcement anywhere | 🔴 GAP | 🔴 No MYM UI found | 🔴 No MYM UI | 🔴 GAP |
| §C3 MYM max 4/season | No enforcement anywhere | 🔴 GAP | 🔴 GAP | 🔴 GAP | 🔴 GAP |
| §C3 MYM type = "MYM" (not Veteran) | Worker sets `"MYM - Vet" / "MYM - Rookie"` | ✓ | (no UI) | (no UI) | ✓ ALIGNED (worker only) |
| §C5.1.b restructure OFFSEASON ONLY | NO date enforcement | 🔴 GAP | 🔴 No offseason check in eligibility | (relies on desktop) | 🔴 GAP (`MOBILE_DRIFT_PREVENTION.md §2.5`) |
| §C5 restructure max 3/season | No enforcement | 🔴 GAP | 🔴 GAP | 🔴 GAP | 🔴 GAP |
| §C5 restructure years 2-3 + Y1 ≥ 20% TCV | Client-side gates | ⚠ No server validation | ✓ `years >= 2 && years <= 3` + Y1 check | ✓ Mirror | ✓ ALIGNED on clients |
| §C6 rookie option Y3+$5K, Sept deadline | Client-side gates | ⚠ No server validation | ✓ `rookieOptionActionEligible` | ✓ Mirror | ✓ ALIGNED on clients |
| §C8 tag side OFFENSE = {QB,RB,WR,TE} | All three honor | ✓ `TAG_OFFENSE_POSITIONS` | ✓ | ✓ | ✓ ALIGNED |
| §C8 tag salary = max(formula tier, prior AAV × 1.10) | Verify WW $1K floor (MobileNotesV1) | ⚠ Unknown — see §6 Q13 | ⚠ Unknown | ⚠ Unknown | ❓ AMBIGUOUS |

### §3.2 — Cap Math + Roster Constraints

| Rule | Canon | Worker | Desktop | Mobile | Overall |
|---|---|---|---|---|---|
| §6.A1 $300K cap ceiling | FA Auction start → season end only; offseason OFF | ⚠ Calc agnostic — no ceiling validation | ⚠ Cap math correct, no hard reject | ⚠ Same | ⚠ DRIFT — see §6 Q4 |
| §6.A2 $260K cap floor | "Hit some point during auction OR by Sept deadline" | 🔴 No floor compliance check | 🔴 Same | 🔴 Same | 🔴 GAP — see §6 Q4 |
| §6.B1 per-week pro-rated earning | Effective 2026-05-08 | ✓ `earnedPerWeek` correct denominator | ⚠ Legacy calendar quarters | ⚠ Legacy calendar quarters | ⚠ DRIFT (tabled — `MOBILE_DRIFT_PREVENTION.md §2.2`) |
| §6.C TCV fixed at creation/extension | Worker stores `original_tcv_usd` and `tcv_at_drop_usd` | ✓ | ✓ Display reads from worker | ✓ Mirror | ✓ ALIGNED |
| §6.C2 multi-year TCV<$5K → $1K | Worker has it | ✓ `multiYearLowTcvPenalty` | 🔴 Missing | 🔴 Missing | ⚠ DRIFT (`MOBILE_DRIFT_PREVENTION.md §2.3`) |
| §6.C IR 50% relief | All sides should apply | ✓ Cap math overlay | ⚠ Display unclear — needs live trace | ⚠ Same | ⚠ DRIFT — see §6 Q5 (live verification) |
| §6.E1 trade cap-money 50% rule | Each side capped at 50% of THEIR OWN player salary | ⚠ No server validation | ⚠ Trade workbench shows cap impact, no 50% block | n/a | ⚠ DRIFT — see §6 Q6 |
| §6.E taxi off-cap entirely | All three exclude | ✓ | ✓ | ✓ | ✓ ALIGNED |
| §A roster size 27 (min, auction close) – 30 (max, post-deadline) | Display; enforcement unclear | ⚠ No auction-close cron | ⚠ Display only | ⚠ Display only | ⚠ DRIFT — see §6 Q7 |
| §6G max 5 loaded contracts | Display chips (red over) | n/a | ✓ `contractLimitSummaryForPlayers` | ✓ Mirror | ✓ Display ALIGNED; submission blocking unclear |
| §6G max 6 three-year contracts (years remaining = 3) | Per Keith 2026-05-16 — counts cy=3 not original CL | n/a | ✓ `safeInt(player.years, 0) === 3` | ✓ Mirror | ✓ ALIGNED |
| §6G max 4 MYM/season | NO enforcement | 🔴 GAP | 🔴 GAP | 🔴 GAP | 🔴 GAP |
| §6G max 3 restructure/season | NO enforcement | 🔴 GAP | 🔴 GAP | 🔴 GAP | 🔴 GAP |
| §B2 taxi 3-year clock | "Auditable" per canon | ⚠ Tracking field unclear | ⚠ Same | ⚠ Same | ❓ AMBIGUOUS — see §6 Q9 |
| §B2 temporary call-ups (3 weeks then permanent) | UPDATED 2026-05-08 | ⚠ Counter unclear | ⚠ Same | ⚠ Same | ❓ AMBIGUOUS — see §6 Q10 |
| Taxi salary derivation (MFL strips, UPS derives via §A1.4) | Mobile has it, Rosters page doesn't | ✓ (data MFL-side) | 🔴 Shows $0 | ✓ Taxi tab; 🔴 Rosters tab | ⚠ DRIFT — Mobile UX backlog item |

### §3.3 — Acquisitions (Rookie Draft, FA Auction, Expired Rookie Auction, Dispersal)

| Rule | Canon | Worker | Desktop | Mobile | Overall |
|---|---|---|---|---|---|
| §A1.4 rookie pay table | 1.01=$15K, slot-decremented, R2=$5K, R3-5=$2K, R6=$1K | ✓ `_rdhRookieContract` | n/a (read-only display) | ✓ `rookieSalaryForPick` (PR #199) | ✓ ALIGNED |
| §A Round 1 NOT taxi-eligible | Must stay active | ❓ No code block found | ❓ Same | ❓ Same | ❓ AMBIGUOUS — see §6 Q12 |
| §A Round 6 IDP-only | 2025+ class | 🔴 No position validation | 🔴 No check | 🔴 No check | 🔴 GAP — see §6 Q11 |
| §C6 4th-year option (Y3 + $5K, Sept deadline) | All clients correct | ⚠ No server validation | ✓ Synthesizes option year | ✓ Mirror | ✓ ALIGNED on clients |
| §A4 cut-then-rebid prohibition | NO automation | 🔴 GAP (commissioner-enforced only) | 🔴 GAP | 🔴 GAP | 🔴 GAP |
| §A3 ERA forced retention | NO mechanism | 🔴 GAP | 🔴 GAP | 🔴 GAP | 🔴 GAP |
| §A4 cap floor $260K + ceiling $300K during auction | NO validation by UPS | ⚠ MFL may enforce ceiling | ⚠ Display only | ⚠ Display only | ⚠ DRIFT — see §6 Q4 |

### §3.4 — Lineup + Scoring + Tag-Side Derivation

| Rule | Canon | Worker | Desktop | Mobile | Overall |
|---|---|---|---|---|---|
| §B lineup spec (1QB/2RB/2WR/1TE/2FLEX/1SFLEX/1PK/1PN/2DL/2LB/2DB/1DFLEX) | Worker matches | ✓ `readAcquisitionRules()` | ✓ MFL-delegated | ✓ `LINEUP_GROUPS` mirror | ✓ ALIGNED |
| §S TE Premium 1.5 PPR (2025+) | MFL-delegated | ✓ | ✓ | ✓ | ✓ ALIGNED |
| §S RB PPR 0.80 (2018+) | MFL-delegated | ✓ | ✓ | ✓ | ✓ ALIGNED |
| §S IDP tackle boost (2018+) | MFL-delegated | ✓ | ✓ | ✓ | ✓ ALIGNED |
| §C8 tag side OFFENSE = {QB,RB,WR,TE} | All sides | ✓ | ✓ | ✓ | ✓ ALIGNED |
| §C8 PK/PN tag side | Canon doesn't explicitly assign | ⚠ Coded as DEFENSE | ⚠ Same | ⚠ Same | ❓ AMBIGUOUS — see §6 Q3 |
| §C standings tiebreaker | Canon: AllPlay% → PF → H2H%. Worker: H2H% → AllPlay% → PF | 🔴 MISMATCH — `ORDER BY s.h2h_pct DESC, s.allplay_pct DESC, s.pf DESC` (worker `index.js:3339`) | (uses worker output) | (uses worker output) | ⚠ DRIFT — see §6 Q8 |
| §V All-Play % = W/(W+L+T) | Worker SQL correct | ✓ | n/a | n/a | ✓ ALIGNED |
| §V playoff seeding by All-Play % | Worker bracket logic | ✓ | ✓ | ✓ | ✓ ALIGNED |

### §3.5 — Trade + OTB + Waiver

| Rule | Canon | Worker | Desktop | Mobile | Overall |
|---|---|---|---|---|---|
| §A6 trade window through NFL Thanksgiving | MFL-enforced | ✓ Delegates | ✓ UI | ✓ Works | ✓ ALIGNED |
| §A6 trade 50% cap-money rule | Each side max 50% of own player salary | ⚠ No server validation | ⚠ Trade workbench shows but doesn't block | n/a (mobile no offer builder) | ⚠ DRIFT — see §6 Q6 |
| §A6 pre-trade extension | Last action before trade closes | ✓ Pass-through | ✓ Trade workbench `extensionModal` | n/a | ✓ ALIGNED |
| OTB asset tokens (P_, FP_, DP_, BB_) | Worker accepts all | ✓ | ✓ Desktop renders all | ✓ Mobile hides DP_/FP_/BB_ (PR #194) | ✓ ALIGNED (mobile UX choice) |
| OTB D1 audit | Per principle, every submission writes D1 row | 🔴 GAP — no `ups_tradebait_submissions` table | n/a | n/a | 🔴 GAP |
| OTB Discord post (war-room channel) | Worker posts | ✓ `postOtbDiscord()` | ✓ | ✓ | ✓ ALIGNED |
| §W BBID conditional waivers | All settings match canon | ✓ Config verified | ✓ MFL-delegated | ✓ Same | ✓ ALIGNED |
| §C3/§W 14-day MYM window post-WW pickup | NO enforcement | 🔴 GAP | 🔴 No MYM UI | 🔴 No MYM UI | 🔴 GAP |
| Mobile OTB Add/Update/Remove buttons | Keith MobileNotesV1: "all of them are set" (broken) | ✓ Worker route works | ✓ Desktop works | 🔴 Unverified — investigate | 🔴 GAP (Mobile UX backlog) |

### §3.6 — Discord + D1 Audit Trail Alignment

| Action | MFL | D1 audit | Discord | Cap-penalty cron | Verdict |
|---|---|---|---|---|---|
| Drop | ✓ | ⚠ `salary_change_log` (no `source` field) | ✓ Cap-penalty channel | ✓ Hourly cron, dedup via MFL ledger | ⚠ DRIFT (drop source discriminator) |
| OTB (add/remove/note) | ✓ | 🔴 NO D1 row | ✓ OTB channel | n/a | 🔴 GAP |
| Tag | ✓ | ✓ `ups_tag_submissions` + master | ✓ DM pre-deadline (`DISCORD_DM_USER_IDS`) | n/a | ✓ ALIGNED |
| Untag | ✓ | ✓ `ups_tag_submissions` + master DELETE | ✓ DM to `COMMISH_DISCORD_USER_ID` (no channel) | n/a | ✓ ALIGNED (PR #204) |
| Extension | ✓ | ✓ `ups_extension_submissions` + master | ✓ Contract-activity channel | n/a | ✓ ALIGNED |
| Restructure | ✓ | ❓ Event-based (`log-restructure-submission`); no dedicated table found | ✓ Contract-activity channel | n/a | ❓ AMBIGUOUS — see §6 Q14 |
| Lineup | ✓ | 🔴 None (by design — `MOBILE_DRIFT_PREVENTION.md §2.8`) | 🔴 None (by design) | n/a | 🔴 INTENTIONAL GAP (future work) |
| Draft pick | ✓ | ✓ via `log-draft-pick` event | ✓ Draft channel | n/a | ✓ ALIGNED |
| Trade accept/decline/cancel | ✓ | ✓ via `log-trade` event | ✓ Contract-activity channel | n/a | ✓ ALIGNED |

### §3.7 — Verbatim Mirror Discipline (mobile mirror byte-level audit)

| Mobile file | Desktop source | Verdict | Notes |
|---|---|---|---|
| `front_office_penalty.js` | `roster_workbench.js` 1604-1927 | ✓ ALIGNED | One acceptable adaptation: `dropPenaltyEstimate(player, season)` takes optional season for stateless operation |
| `front_office_cap.js` | `team_operations.js` 660-708 | ✓ ALIGNED | Zero drift |
| `front_office_lineup.js` | `team_operations.js` 829-883 | ✓ ALIGNED | Cleanest mirror, zero drift |
| `front_office_actions.js` | `roster_workbench.js` 558-1288 | ✓ ALIGNED | All recent PR changes (extension blocks, tag season filter, `wasTaggedThisSeason`) byte-mirrored |
| `front_office_tag_submit.js` | `roster_workbench.js` 11075-11330 | ✓ ALIGNED | Two-step untag (revert + unload) matches desktop verbatim |
| `front_office_extend_submit.js` | `roster_workbench.js` 10839-10910 + reshape | ✓ ALIGNED | Mobile submit is callback-driven; reshape math byte-identical |
| `front_office_restructure_submit.js` | `roster_workbench.js` 7285-11041 | ✓ ALIGNED | Y1 ≥ 20% TCV, 1K increment, 2yr/3yr logic all mirrored |

**Conclusion:** The Verbatim Mirror Discipline is **MAINTAINED**. All 7 pairs aligned. Only intentional divergence is the optimistic tag/untag layer (`MOBILE_DRIFT_PREVENTION.md §3`).

---

## §4 — Items tagged for future work / improvements

Captured during the 2026-05-16 audit. Each row is a discrete future PR or league-process discussion.

### §4.1 — Auction Room (in-app digital auction)

Keith asked specifically about this. Current state: NO digital auction room. FA Auctions run through MFL's native auction UI (live email-based per `auction_kind: 'email'` config).

**MVP scope (a single-PR starter):**
- Owner sees their roster + cap state in one pane.
- Real-time current high bid display per lot (player or pick).
- Bid input gated to `auction_room_open` window + `bbidMinimum`.
- Touch-to-bid + bid-increment buttons; confirm modal showing post-bid cap impact.
- Lot queue with timer.
- Live socket / poll for bid updates.

**Phase 2 — compliance + UX:**
- $260K cap floor reminder ("you're $X away from compliance").
- $300K ceiling enforcement (block bids that exceed).
- Cut-then-rebid prohibition surfacing (list of players this owner CAN'T bid on).
- Loaded count + 3-year count warnings as the owner builds their roster mid-auction.
- 27-active min check at "close auction" time.

**Phase 3 — automation + history:**
- Auto-write to MFL on auction close.
- D1 `ups_auction_lots` table for the full bid history (with `source` discriminator).
- Discord auction channel narrating each pick.
- Post-auction compliance report ("Long Haulers ended $258K — under floor by $2K").

**Worker dependencies:**
- New endpoint `/api/auction/state` returning current lots + bids.
- New endpoint `/api/auction/bid` accepting bids (auth-gated).
- New cron `auction-close-cron` to finalize lots at timeout.
- D1 table `ups_auction_lots(league_id, season, lot_id, player_id, current_high_bid, current_high_bidder_fid, status, opened_at, closed_at)`.
- D1 table `ups_auction_bids(lot_id, franchise_id, bid_amount, bid_at, source)`.

**Client dependencies:**
- Mobile: new `views/auction.js`. Polls or websockets for state. Bid form.
- Desktop: optional parallel implementation OR delegate to MFL native auction.

**Open question for Keith:** Do we want this as a UPS-side full auction tool, or as a "war room dashboard" that watches MFL's email auction state and overlays UPS rule warnings? The full tool is bigger but eliminates the email-back-and-forth pain.

### §4.2 — Worker-side rule enforcement

A pattern emerges in the audit: the worker is the canonical enforcement boundary, but it currently TRUSTS the client on most validations. Several rules that NO codebase enforces today:

- §C5.1.b — restructure offseason-only window
- §C5 — max 3 restructures/season
- §C3 — max 4 MYM/season
- §C3 — 14-day MYM window post-pickup
- §C4.7 — 4-week in-season trade-acquired extension window
- §C4.7 — 14-28 day WW extension window
- §6.A2 — $260K cap floor (auction compliance)
- §A4 — cut-then-rebid prohibition
- §A3 — ERA forced retention
- §A — Round 6 IDP-only validation

**Proposed pattern:** Add a `/api/league-rules?season=X` endpoint returning the current rule set (computed from MFL settings + UPS-side overrides + season-relative dates). All write endpoints (`/commish-contract-update`, `/offer-restructure`, etc.) gate on these rules at the worker boundary. Clients fetch + display the same rule state for UI gating.

This addresses Keith MobileNotesV1: "Make sure you review those sorts of rules in settings that we have for transactions within the API."

### §4.3 — D1 audit completeness

Per the principle "every submission writes a D1 row":

- 🔴 **OTB submissions** — no audit table today; add `ups_tradebait_submissions`.
- 🔴 **Lineup submissions** — `MOBILE_DRIFT_PREVENTION.md §2.8` (Keith parked migration).
- ⚠ **Drop** — `salary_change_log` has no `source` field to discriminate mobile vs. desktop. Add.
- ❓ **Restructure** — Event-dispatched but no dedicated table verified. Confirm or add `ups_restructure_submissions`.

### §4.4 — Mobile UX backlog (Keith MobileNotesV1)

Tracked in `MOBILE_DRIFT_PREVENTION.md §5.1`. After this alignment doc lands, the next pass works through:
- Drop UX when owner-drops disabled (gated on §4.2 above)
- Expired-player `-$1K` cap delta → $0
- OTB Remove/Update/Add Block buttons (mobile audit)
- Refresh icon (wire or remove)
- Per-fetch timeout + retry banner
- Tre Harris / Isaac Tesla wrongly Expired (investigate)
- Taxi salaries on Rosters → Team Detail (extend §A1.4 derivation to that view)
- Championship title count per owner (data already loaded via `champions_panels.json`)
- Expiring Salary column on Salary Summary

---

## §5 — Intentional divergences (mirror of `MOBILE_DRIFT_PREVENTION.md §3`)

Anytime mobile/desktop intentionally diverges (because a fix can't ship cross-codebase yet), it lives in `MOBILE_DRIFT_PREVENTION.md §3`. This doc just links there. Active intentional divergences are also surfaced in the audit results above.

---

## §6 — Open questions / clarifications needed from Keith

When the audit hit something ambiguous in `league_context_v1.md`, the question lands here. Keith answers; the answer goes back into `league_context_v1.md` as a clarifying paragraph; the row gets resolved.

**Status legend:** ✅ Resolved (canon updated) · 🔵 Follow-up (canon updated + implementation tracker filed) · 🟡 Parked (no canon change; deferred or pending discussion)

**Disposition (Keith, 2026-05-16 review session — captured in this doc-update PR):**

| # | Topic | Status | Resolution pointer |
|---|---|---|---|
| Q1 | WW cap-free boundary | ✅ Resolved | Code `< $5K` is correct; rule phrasing is "WW salary ≤ $4K is cap-free" (equivalent for integer dollars). → `league_context_v1.md §D1` + Bot Grounding appendix ("Cap-penalty-free pickups") updated. |
| Q2 | Ext2 FL/BL suffix auto-derivation | 🔵 Follow-up | Canon is correct; code missing the auto-derive step across desktop + mobile + any other extension submitters. Doc unchanged. → tracker `AUDIT_FOLLOWUP_TRACKERS.md` Q2. |
| Q3 | PK/PN tag side | ✅ Resolved | PK/PN belong on the **DEFENSE/ST** side; code grouping is correct. → `league_context_v1.md §C8` (new explicit assignment paragraph). |
| Q4 | Cap ceiling + floor enforcement | ✅ Resolved + 🟡 Parked (impl) | $300K ceiling: MFL-native + UPS advisory warnings, no worker block. $260K floor: deadline extended to "end of auction OR Roster Contract Deadline, whichever comes later." → `league_context_v1.md §6.A1` + `§6.A2` updated. Auction-tooling floor warnings parked under §4.1. |
| Q5 | IR 50% relief — verify live | 🔵 Follow-up | Rule confirmed ($20K player → $10K cap hit on IR). Live verification deferred (no player currently on IR). → `league_context_v1.md §B3` notes deferral; tracker `AUDIT_FOLLOWUP_TRACKERS.md` Q5. |
| Q6 | Trade cap-money 50% rule | ✅ Resolved | UPS-owned (not MFL-enforced). Trade War Room already enforces client-side: `site/trades/trade_workbench.js:4220` (max calc) + `:5237-5238` (validation). Worker-side backstop is a follow-up. → `league_context_v1.md §6.E1` cites file:line. Tracker `AUDIT_FOLLOWUP_TRACKERS.md` Q6 (worker backstop). |
| Q7 | 27-active minimum + 30-max post-deadline | ✅ Resolved + 🟡 Parked (impl) | 27-min only at end of auction + complete-lineup requirement. 30-max via MFL settings (no UPS code). Safeguarding parked for auction tooling. → `league_context_v1.md §B1` updated. |
| Q8 | Standings tiebreaker | ✅ Resolved + 🔵 Follow-up | Two distinct concepts. Division-champ tiebreaker = MFL setting (`lg.standingsSort`, year-specific). UPS playoff seeding = canon §F.1 (AP% → PF → H2H). Worker `index.js:3339` is the full-standings-page sort, separate from both. → `league_context_v1.md §F.2` added (separation + code-pointer table). Tracker `AUDIT_FOLLOWUP_TRACKERS.md` Q8 (verify current MFL `standingsSort` + decide whether standings-page sort should align). |
| Q9 | Taxi 3-year clock tracking | ✅ Resolved | MFL native + derivation path from `players.draft_year`. → `league_context_v1.md §B2` updated. |
| Q10 | Taxi call-up counter + auto-promotion | 🔵 Follow-up | UPS-owned, 3 total across the 3-year window (NOT per-season), 4th = permanent. Counter + worker increment + auto-promotion block + UI to build. → `league_context_v1.md §B2` updated. Tracker `AUDIT_FOLLOWUP_TRACKERS.md` Q10. |
| Q11 | Round 6 IDP-only validation | 🔵 Follow-up | Greenlit on worker-side hard block at `/api/pick`. Historical precedent captured: reversed + pick lost as penalty. → `league_context_v1.md §A1 Round 6` updated. Tracker `AUDIT_FOLLOWUP_TRACKERS.md` Q11. |
| Q12 | Round 1 active-only lock | 🔵 Follow-up | Greenlit on demote endpoint rejecting R1 → taxi. → `league_context_v1.md §A1 Round 1` updated. Tracker `AUDIT_FOLLOWUP_TRACKERS.md` Q12. |
| Q13 | Tag WW players → $1K floor | 🟡 Parked (rule proposal) | NOT confirmed; Keith to propose via league pipeline. Existing partial implementation found: `build_tag_tracking.py:436-457` blocks WW from `prior_aav_map`. → `league_context_v1.md §C8` documents current behavior + proposal status. Tracker `AUDIT_FOLLOWUP_TRACKERS.md` Q13 (rule-proposal). |
| Q14 | Restructure D1 audit table | 🔵 Follow-up | Add `ups_restructure_submissions` (or `ups_restructure_history`); wire existing `log-restructure-submission` event. → `league_context_v1.md §C5` updated. Tracker `AUDIT_FOLLOWUP_TRACKERS.md` Q14. |
| Q15 | Late dues + missed-nomination fines | ✅ Closed | Late dues fine **retired** 2026-08-17 (§T4.4, Keith). Missed-nomination fines are **cap** adjustments — settled 2026-07-14 with the §F RULE 2 schedule (§T4.3a), code-enforced in `auction_compliance.js`. No cash-vs-cap question remains. |
| Q16 | Auction Room scope | 🟡 Parked | Scope undecided; Keith will circle back. §4 context preserved. No canon change. |

### §6.1 — Original audit questions (kept for traceability)

| # | Topic | Question | Audit source |
|---|---|---|---|
| Q1 | WW cap-free boundary | Canon §D2.1 says WW pickups **under $4K** are cap-free. Worker `cap_penalty.js` uses `< $5K`. Is the $5K boundary an intentional broadening (e.g., to match §D2.4 multi-year buffer) or a bug? | §3.1 |
| Q2 | Ext2 FL/BL suffix auto-derivation | Canon §C4 line 315 says "the extension submitter should **auto-derive** the `-FL` / `-BL` suffix from the per-year salary array." Desktop's `playerExtensionOptions` doesn't derive it (contractStatus stays plain "EXT2"). Is MFL's import handler applying the suffix server-side, or is the desktop code missing this step? | §3.1 |
| Q3 | PK/PN tag side | Canon §C8 doesn't explicitly say whether PK/PN tags are OFFENSE or DEFENSE. Code groups them with DEFENSE (everything outside QB/RB/WR/TE → DEFENSE). Is that the intended assignment? | §3.4 |
| Q4 | Cap ceiling + floor enforcement | Canon §6.A1 says $300K cap is hard during the FA Auction → season end window, off otherwise. Canon §6.A2 says the $260K floor must be hit at some point during the auction. NEITHER ceiling nor floor is currently enforced anywhere in code. What should the enforcement model look like — worker-side hard block, bid-sheet preflight, post-auction audit? | §3.2 |
| Q5 | IR 50% relief — verify live | Canon §6.C says IR salary gets 50% cap relief. Code paths exist but no live-data trace has confirmed cap-room rises by exactly 50% when a player IRs. Confirm with one current example so we can pin the math? | §3.2 |
| Q6 | Trade cap-money 50% rule | Canon §6.E1 says each side is independently capped at 50% of THEIR OWN traded-away player salary. UPS currently has NO server-side validation — relies entirely on MFL. Should UPS enforce server-side as a backstop? | §3.5 |
| Q7 | 27-active minimum + 30-max post-deadline | When (cron / event) should these be enforced? Currently display-only. | §3.2 |
| Q8 | Standings tiebreaker | Canon §C line 180/1289 says tiebreaker order is **AllPlay% → PF → H2H%**. Worker SQL sorts `ORDER BY s.h2h_pct DESC, s.allplay_pct DESC, s.pf DESC` — **H2H% first**. Is the worker's order an intentional override or a bug? | §3.4 |
| Q9 | Taxi 3-year clock tracking | Canon §B2 says taxi eligibility is "auditable" — but no clear tracking field surfaced in the audit. Where does the 3-league-year counter live? `contract_info`? Separate D1 table? | §3.2 |
| Q10 | Taxi call-up counter + auto-promotion | Canon §B2 (UPDATED 2026-05-08) says 3 weekly call-ups allowed; 4th = permanent. Counter location + auto-promotion logic both unclear. Manual or automated? | §3.2 |
| Q11 | Round 6 IDP-only validation | Canon §A says R6 picks are IDP-only (2025+). No code validates this — owners could draft a QB/RB/WR/TE with a R6 pick. Should worker block at `/api/pick`? | §3.3 |
| Q12 | Round 1 active-only lock | Canon §A says R1 rookies "must stay on active roster" — NOT taxi-eligible. No code blocks demoting a R1 to taxi. Should the demote endpoint reject? | §3.3 |
| Q13 | Tag WW players → $1K floor | Keith MobileNotesV1: "Tag - WW guys are considered 1K for tag purpose purpose in other words lowest tier." This isn't explicit in `league_context_v1.md §C8`. Confirm the rule + add to canon. Tag salary calc may need a check: if `prior_contract_type === "WW"` → treat prior AAV as $1K when applying the `max(formula tier, prior AAV × 1.10)` rule. | §3.1 (`MOBILE_DRIFT_PREVENTION.md §5.1`) |
| Q14 | Restructure D1 audit table | Restructure submissions dispatch `log-restructure-submission` event but no dedicated `ups_restructure_submissions` table found. Where does the audit row land? Should there be a dedicated table for consistency with tags + extensions? | §3.6 |
| Q15 | Late dues + missed-nomination fines | ✅ Answered 2026-08-17. Late dues: retired, no fine to classify (§T4.4). Missed nomination: cap adjustment, ratified 2026-07-14 (§T4.3a). | §3.2 |
| Q16 | Auction Room scope | Full UPS-side auction tool, or "war room dashboard" overlaying MFL's email auction with UPS rule warnings? See §4.1. | §4.1 |
