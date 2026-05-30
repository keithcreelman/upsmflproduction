# Cross-Codebase Alignment

**Last updated:** 2026-05-16 (second-pass deep-dive — §3.8 added)
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

### §3.8 — Deep-dive audit (file-level, line-cited) — 2026-05-16 second pass

Complements §3.1–§3.7 (domain-organized) with a per-file deep dive matching §2's file inventory. Each subsection cites worker / desktop / mobile by `file:line`, scores all four hooks, and lists every rule found. Items marked **NEW** weren't surfaced in the first-pass audit. New §4 follow-ups and §6 questions are consolidated in their respective sections (Q17+).

#### §3.8.1 — Drop penalty math — `cap_penalty.js` / `dropPenaltyEstimate`

**Canon:** §1.D1, §1.D2, §2.T4.1, §2.T5.1–T5.3, §6.C1–C5, Appendix Bot Grounding (cap-penalty-free pickups / multi-year low-TCV / rounding)
**Files traced:**
- Worker (canonical, era-aware): `worker/src/lib/cap_penalty.js` (203 lines) — **but see NEW finding: never imported by `index.js`**
- Desktop (preview): `site/rosters/roster_workbench.js` → `dropPenaltyEstimate` L1830
- Mobile (preview, verbatim mirror): `site/m/front_office_penalty.js` → `dropPenaltyEstimate` L319

**Hook coverage when owner drops via `/roster-workbench/action` (`action=drop_player`, worker `index.js:23853`):**

| Hook | Fires at submission? | Where |
|---|---|---|
| MFL write | ✓ | `index.js:23860` posts `TYPE=taxi_squad&DROP=...` |
| D1 audit row | 🔴 NO | No `ups_drop_submissions` table. `salary_change_log` (`index.js:21778`) is keyed off salary-import events, not raw drop submits |
| Discord post | ⚠ DEFERRED | No post fires at submit. Cap-penalty channel post happens only on next hourly cron, which regex-parses player name from salaryAdjustment explanation |
| Cap-penalty cron | ✓ | `index.js:103-274` — hourly `5 * * * *`, dedup via MFL `salaryAdjustments` export |

**Verdict on Four Imperatives for cut:** ⚠ 2 of 4 hooks fire cleanly (MFL, cron). Discord async via cron; D1 audit row is a documented gap (§4.3).

| # | Rule | Canon § | Worker (`cap_penalty.js`) | Desktop (`roster_workbench.js`) | Mobile (`front_office_penalty.js`) | Status |
|---|---|---|---|---|---|---|
| 1 | Era determination (pre-2019 / 2019-Calendar / 2026-05-08 per-week) | §6.B + §6.C3 | L36-41 `determineRuleEra` | n/a (current-rule only) | n/a (same) | ⚠ Acceptable (preview-only) |
| 2 | Canonical formula `(TCV × 0.75) − Earned` | §6.C1 | L138-140, L145-147 | L1910 `Math.max(0, guaranteed - earned)` | L389 (mirror) | ✓ ALIGNED |
| 3 | TCV fixed at signing / extension | §6.C1 r1 | implicit (input `tcv_at_drop_usd`) | L174 `totalContractValueForPlayer` | L174 (mirror) | ✓ ALIGNED |
| 4 | Earned uses YEAR's actual salary (not AAV) | §6.C1 r2 | L89-95, L77-87 | L205-225 `earnedBeforeCurrentContractYear` + L139-144 | L205, L139 (mirror) | ✓ ALIGNED |
| 5 | Per-week pro-rated earning (2026-05-08) | §1.D1, §6.B, §6.C3 | L89-95 `earnedPerWeek` | L1777-1793 LEGACY calendar-quarter | L248-264 (verbatim legacy, self-flagged "TABLED") | ⚠ DRIFT (tabled, `project_ww_penalty_prorate_migration.md`) |
| 6 | Auction/Week-1 acq → 17 eligible weeks | §1.D1 | implicit via `totalEligibleWeeks` helper L188-192 | 🔴 NOT MODELED | 🔴 NOT MODELED | ⚠ DRIFT (= rule 5) |
| 7 | Mid-season pickups → denom = `18 − pickup_week` | §1.D1, §6.C3 | L188-192 | 🔴 NOT MODELED | 🔴 NOT MODELED | ⚠ DRIFT (= rule 5) |
| 8 | WW $5K+ in-season flat 35% — RETIRED 2026-05-08 | §6.C3 (retired) | NOT present (uniform per-week) | L1896-1908 — STILL ACTIVE legacy short-circuit | L379-388 — STILL ACTIVE (verbatim mirror) | ⚠ DRIFT (clients apply retired rule) |
| 9 | Cap-free: 1-yr Vet/WW with TCV<$5K | §1.D2, §6.C2 | L49-55 — includes `"auction"` in type list | L1882-1894 — only VETERAN/WW | L361-369 (mirror) | ⚠ DRIFT subtle (worker accepts `auction`, clients don't) — **NEW** |
| 10 | Cap-free: Taxi player never permanently promoted | §1.D2, §6.C2 | L47 `drop_reason==="taxi_drop"` | L1856-1867 `isTaxi` short-circuit | L342-350 (mirror) | ✓ ALIGNED |
| 11 | Cap-free: Retired player | §1.D2 | L44 `drop_reason==="retired"` | 🔴 NOT MODELED | 🔴 NOT MODELED | ⚠ DRIFT (preview unaware) — **NEW** |
| 12 | Cap-free: Trade-away | §1.D2 / §1.D3 | L46 `drop_reason==="trade"` | n/a (drop UI not used for trades) | n/a | ✓ ALIGNED |
| 13 | Cap-free: Expired naturally | §1.D2 | L45 `drop_reason==="expired"` | L1844-1855 (`years<=0`) | L333-341 (mirror) | ✓ ALIGNED |
| 14 | Cap-free: Tag cut pre-FA-Auction | §6.C2, §C4.9 | catch-all `drop_reason="cap_free_cut"` L57 | L1820-1828 `isTagCutPreAuctionAssumption` + L1869 (Aug 1 hardcode) | L310-318, L351-359 (mirror) | ⚠ DRIFT (Aug 1 vs canon "FA Auction start") — **NEW** |
| 15 | Cap-free: Jail Bird | §1.D2 | L57-59 catch-all | 🔴 NOT MODELED | 🔴 NOT MODELED | ⚠ Acceptable (commish-only) |
| 16 | Cap-free: Off-season suspension opt-out | §1.D2, §B3 | L57-59 catch-all | 🔴 NOT MODELED | 🔴 NOT MODELED | ⚠ Acceptable (commish-only) |
| 17 | Cap-free: New-owner onboarding | §1.D2, §6.C2 | L57-59 catch-all | 🔴 NOT MODELED | 🔴 NOT MODELED | ⚠ Acceptable (commish-only) |
| 18 | Multi-year TCV<$5K → fixed $1K floor | Appendix Bot Grounding | L64-71 `multiYearLowTcvPenalty` | 🔴 MISSING | 🔴 MISSING | ⚠ DRIFT (`MOBILE_DRIFT_PREVENTION.md §2.3`) |
| 19 | WW under $4K cap-free | Appendix Bot Grounding L2269 | L49-55 uses `<5000` (NOT `<4000`) | L1883 uses `<5000` | L361 uses `<5000` | ❓ AMBIGUOUS (§6 Q1) |
| 20 | Pre-2019 flat / loaded-correction formula | §6 (era) | L97-120 AAV-based loaded correction | 🔴 NOT MODELED | 🔴 NOT MODELED | ⚠ Acceptable (preview-only) |
| 21 | Pre-2019 buffer-zone: TCV<$5K → $0 | memory `mfl_pre2019_no_low_tcv_1k_rule.md` | L111 | n/a | n/a | ✓ ALIGNED |
| 22 | Penalty timing (which season's cap) | §1.D1, §2.T4.1 | computed by cron path, not `cap_penalty.js` | 🔴 NO LABEL in preview | 🔴 NO LABEL | ⚠ UX GAP — **NEW** |
| 23 | "Earned across years" — prior years at 100% of THAT year's salary | §6.C1 r2, §6.C4.3 | L150-185 `computeCycle` | L205-225 sums prior-year salaries from contractInfo Y[] tokens | L205-225 (mirror) | ✓ ALIGNED (AAV fallback when Y[] missing) |
| 24 | Penalty rounding on the SUM (not per-penalty) | Appendix Bot Grounding L2280 | All paths `Math.round(...)` per-penalty | per-penalty rounding | per-penalty (mirror) | ⚠ DRIFT (literal canon) — **NEW** |
| 25 | Tag-cut "pre-auction" date source | §6.C2 L1687 | catch-all | hardcoded Aug 1 | hardcoded Aug 1 (mirror) | ⚠ DRIFT (= rule 14) |
| 26 | Drop from Taxi (`TAXI`+`DROP`) is cap-free | §2.T5.3 | L47 `taxi_drop` | L1856 `isTaxi` | L342 (mirror) | ✓ ALIGNED |

**Drift/gap highlights (NEW):**
- **`cap_penalty.js` is dead code from `worker/src/index.js`'s perspective.** No `import` of `cap_penalty.js` exists in `index.js`. The hourly cron at L:103-274 dispatches to `/admin/import-drop-penalties` (L:22198) which reads a pre-computed JSON report from `pipelines/etl/lib/cap_penalty.py`. Worker enforces canon transitively via Python pipeline; the JS lib is parity mirror only.
- **`/api/drop-player` does not accept a `drop_reason` parameter.** All owner-driven drops fall through to the default formula path. The `retired`/`trade`/`cap_free_cut` branches in `cap_penalty.js` (L44-59) are unreachable by owner submits — only the commish import path supplies them.
- **Discord on drop is async via the hourly cron** and regex-parses the player name from the salaryAdjustment explanation string (`index.js:243`). If MFL ever changes the format, the post degrades to "Player dropped" without a name.

#### §3.8.2 — Cap math / earning curve / available cap

**Canon:** §6.A (floor/ceiling), §6.B (per-week earning), §6.D (cap adjustments), §6.E (trade cap money), §6.F (available cap), §6.G (validation)
**Files traced:**
- Worker — `worker/src/index.js` (hourly cron `5 * * * *` L:103-274; `/admin/import-drop-penalties` L:22198-22398; live cap helpers `currentCapHitAcq` L:8391-8398, `teamBudgetRowsFromLive` L:8467-8568, `salaryCapDollars` L:8571-8578)
- Worker mirror lib (**unused**) — `worker/src/lib/cap_penalty.js`
- Desktop — `site/team_operations/team_operations.js` `renderCaps` / `renderSummary` L:670-708 + `getMyAdjustmentTotal` L:378-392; `site/rosters/roster_workbench.js` `currentCapHit` L:676-683 + `proratedEarnedForDrop` L:1777-1793 + flat WW 35% L:1897
- Mobile — `site/m/front_office_cap.js` `computeCapMath` L:191-229 + `getCombinedAdjustmentTotalFor` L:126-128; `site/m/front_office_penalty.js` legacy calendar-quarter L:248-264

| # | Rule | Canon § | Worker | Desktop | Mobile | Status |
|---|---|---|---|---|---|---|
| 1 | Cap ceiling = MFL `salaryCapAmount` (no hardcode) | §6.A1 | `index.js:8571-8578` | `team_operations.js:259` `lg.salaryCapAmount` | `front_office_cap.js:211,242` | ✓ ALIGNED |
| 2 | Tagged salaries count vs ceiling | §6.A1 | `teamBudgetRowsFromLive:8471-8474` (no tag-filter) | `getMySalaries` whole roster | mirror L196-209 | ✓ ALIGNED |
| 3 | Taxi salaries do NOT count vs ceiling | §6.A1 | `currentCapHitAcq:8394` `isTaxi → 0` | `roster_workbench.js:679` + `team_operations.js:681` | `front_office_cap.js:202-203` | ✓ ALIGNED |
| 4 | IR cap relief = 50% | §6.A1, §6.D | `currentCapHitAcq:8396` `round(amt * 0.5)` | `roster_workbench.js:681` + `team_operations.js:683-685` | `front_office_cap.js:204-206` | ✓ ALIGNED |
| 5 | Expired contract (cy=0) → $0 | §6.A1 (implicit) | `currentCapHitAcq:8395` `y<=0 → 0` | `roster_workbench.js:680` + `team_operations.js:677-680` | `front_office_cap.js:199-201` | ✓ ALIGNED |
| 6 | Cap floor $260K touch-and-go enforcement | §6.A2 | 🔴 No tracker — only overage text at `index.js:21672-21675` | 🔴 Not enforced | 🔴 Not enforced | 🔴 GAP — **NEW** |
| 7 | Cap floor stored as constant | §6.A2 | 🔴 No `cap_floor` in code or DB | n/a | n/a | 🔴 GAP — **NEW** |
| 8 | Earning curve = per-week pro-rated | §6.B1 | `cap_penalty.js:89-95` correct **but module imported NOWHERE in `index.js`**; cron consumes pre-computed JSON from `pipelines/etl/lib/cap_penalty.py` | `roster_workbench.js:1777-1793` LEGACY calendar-quarter milestones | `front_office_penalty.js:248-264` LEGACY (verbatim mirror, self-flagged "TABLED") | ⚠ DRIFT — **NEW** (worker JS dead; clients show legacy) |
| 9 | Legacy bucket boundaries `[Sep30, Oct31, Nov30]` vs canon §6.B2 `[Oct1, Nov1, Dec1]` | §6.B2 | n/a | `roster_workbench.js:1782-1785` off-by-one | `front_office_penalty.js:253-256` identical bug | ⚠ DRIFT — **NEW** (compound: wrong rule AND wrong anchors) |
| 10 | WW pickup flat 35% — RETIRED 2026-05-08 | §6.B1, §6.C3 | retained in `cap_penalty.js:130-136` but era-gated, correctly skipped post-2026-05-08 | `roster_workbench.js:1896-1907` STILL applies for WW 1yr ≥ $5K | mirror | ⚠ DRIFT (= §3.8.1 rule 8) |
| 11 | TCV × 75% guarantee formula | §6.C1 | `cap_penalty.js:138-139, 145-146` | `roster_workbench.js:1723` `round(total * 0.75)` | n/a in mobile cap module | ✓ ALIGNED (formula) |
| 12 | TCV-low override threshold | §6.B/§6.C5 | `index.js:22238-22243` uses `<=4000 → $1K`; `cap_penalty.js:64-71` uses `<5000`+multi-year; `cap_penalty.js:49-55` uses `<5000` 1-yr cap-free | n/a | `front_office_cap.js:102-107` matches worker `<=4000` | ❓ AMBIGUOUS — **NEW** (three thresholds) |
| 13 | Salary adjustments — sum signed for franchise | §6.D | `/admin/import-drop-penalties` L:22198-22398 + `buildSalaryAdjXml` L:13730-13737 | `team_operations.js:378-392` | `front_office_cap.js:42-56` (mirror) | ✓ ALIGNED |
| 14 | Adjustment ledger merge (MFL feed + JSON report overlay) | §6.D | n/a | `roster_workbench.js:4193-4222` per-category overlay | `front_office_cap.js:126-128` — helpers exist but NOT called by `getCombinedAdjustmentTotalFor` | ⚠ DRIFT — **NEW** (mobile silently falls back to MFL-only) |
| 15 | Trade cap money each side ≤ 50% of own outgoing salary | §6.E1 | Collected at `index.js:11919-12085`; no 50% guard visible | n/a (trade workbench) | n/a | 🔴 GAP — confirms existing Q6 |
| 16 | Trade cap money recorded as paired signed `salary_adjustment` | §6.E1 | `index.js:12164-12165, 16877-16904` | n/a | n/a | ✓ ALIGNED |
| 17 | Available-cap = `300K − salaries + IR refunds + adj` | §6.F | `teamBudgetRowsFromLive:8475-8476` uses MFL-provided `available_salary_dollars` with fallback | `renderSummary:704-707` `cap − (playerSalary + adjTotal)` | `computeCapMath:212-216` mirror | ❓ AMBIGUOUS — clients recompute; worker prefers MFL number |
| 18 | Reserve $1K × roster_slots_needed_to_27 from max bid | §6.F1, §6.F2 | `reserveCostForScenario:8449-8459` + `teamBudgetRowsFromLive:8477-8499` + `computeLineupNeeds:8400-8447` | n/a (defers to worker) | n/a | ✓ ALIGNED (worker authoritative) |
| 19 | Cap-OFF in offseason (ceiling does not apply) | §6.A1, §6.F | No explicit gate; negative cap shown | `renderSummary:707` allows negative | mirror | ✓ ALIGNED (display, no block) |
| 20 | Rounding ($1K bucket) | §6.G | Raw dollars in worker | `team_operations.js:703-708` rounds each to $1K | mirror | ✓ ALIGNED |

**Drift/gap highlights (NEW):**
- **The hourly cron is computing penalties under the OLD rule today.** Worker's `cap_penalty.js` (the per-week canonical) is never called by `index.js`. The cron consumes `salary_adjustments_<year>.json` produced by `pipelines/etl/lib/cap_penalty.py`. That Python script still uses calendar-quarter milestones (Sep30/Oct31/Nov30/EOS) AND the retired flat 35% WW rule (`candidate_rule="waiver_35pct"`).
- **TCV-low threshold inconsistency: three different cutoffs in adjacent files.** `<=$4K` in worker import + mobile feed; `<$5K` in `cap_penalty.js` cap-free; `<$5K` in `cap_penalty.js` multi-year override. Likely a real ambiguity, not a bug — needs Keith.
- **Cap floor $260K compliance has zero enforcement and isn't even stored as a constant.** No worker code computes whether a franchise crossed $260K at any auction timestamp.

#### §3.8.3 — Lineup validation + four-hooks exception

**Canon:** §2.T6.1 (L804), §3.5.A/D/D.1/F.1, §4 (eras: 2015 RB-min 1→2 L1380; 2018 roster+starter expansion 14→17 L1414-1428; 2022 Superflex QB 1→1-2 L1467-1468; 2025 TE Premium L1483)
**Files traced:** `worker/src/index.js:2454-2559` (`/api/submit-lineup`), `site/team_operations/team_operations.js:829-883` (LINEUP_GROUPS + validators) + `:939-967` (submit), `site/m/front_office_lineup.js:1-89` (verbatim mirror)

**Hook coverage (lineup submit):** MFL ✓ (`import?TYPE=lineup`, worker:2506), D1 ✗ (by Keith 2026-05-16), Discord ✗ (DM fan-out pending `MOBILE_DRIFT_PREVENTION.md §2.8`), Cap cron N/A

| # | Rule | Canon § | Worker | Desktop | Mobile | Status |
|---|---|---|---|---|---|---|
| 1 | Submit-lineup endpoint exists, owner-scoped via cookie | §2.T6.1 | `worker:2470-2498` (403 on franchise mismatch) | `team_operations.js:947` POST | `front_office_lineup.js` validators only; submit in `site/m/app.js` | ✓ ALIGNED |
| 2 | Total starters = 14 (current era) | §4 2018 says **17** | n/a (forwards verbatim) | `team_operations.js:881` hard-codes `total !== 14` | `front_office_lineup.js:76, 84` mirrors `14` | ⚠ DRIFT vs §4 — **NEW** (Q23) |
| 3 | Superflex era: QB max 1→1-2 | §4.2022 L1468 | n/a | `team_operations.js:830` `QB {min:1, max:1}` | `front_office_lineup.js:22` same | ⚠ DRIFT vs §4 — **NEW** (= rule 2) |
| 4 | Position groups (QB/RB/WR/TE/PK/PN/DT+DE/LB/CB+S) | §4 post-2018 IDP | n/a | `team_operations.js:829-841` | `front_office_lineup.js:21-33` byte-equal | ✓ ALIGNED (mobile = desktop) |
| 5 | Eligibility excludes taxi / IR / expired | §G14 (implicit) | n/a | `team_operations.js:856-861` | `front_office_lineup.js:51-56` byte-equal | ✓ ALIGNED |
| 6 | Lineup validation is informational — partial lineups accepted | Keith 2026-05-15 (`team_operations.js:936-938`) | n/a | `team_operations.js:939-967` ships any starters[] regardless of validator | mirror | ✓ ALIGNED (intentional) |
| 7 | Lineup deadline / kickoff lock | Not codified in canon | n/a — MFL enforces server-side | not enforced | not enforced | ❓ AMBIGUOUS — **NEW** |
| 8 | Bye-week handling: bye still gets all-play row | §3.5.D L1160-1165 | n/a | `team_operations.js:69, 225` loads `nflByeWeeks` for display only | mobile mirror lacks bye check | ⚠ Display-only gap (acceptable per §3.5.D) |
| 9 | `/api/submit-lineup` **skips D1 logging** | Keith 2026-05-16 (MOBILE_DRIFT_PREVENTION §2.8) | `worker:2470-2559` — **VERIFIED zero D1 writes** | n/a | n/a | ✓ ALIGNED (documented exception) |
| 10 | `/api/submit-lineup` **skips Discord** | Keith 2026-05-16 | `worker:2470-2559` — **VERIFIED no Discord calls** | n/a | n/a | ✓ ALIGNED (documented exception) |
| 11 | No OTHER write paths inherit the lineup exception | (cross-check) | Audited: trade-bait (worker:2735), tag (24991), extension (25118), MYM (25329) — ALL write D1 AND Discord. Lineup is the only one. | n/a | n/a | ✓ ALIGNED |
| 12 | `?L=` skip-list correctly includes `/api/submit-lineup` | (plumbing) | `worker:415` | n/a | n/a | ✓ ALIGNED |

**Drift/gap highlights (NEW):**
- **Rules 2+3 — LINEUP_GROUPS encodes 14 starters / max-1-QB.** Code comment at `team_operations.js:826` says "verified 2026-05-15 against L=74598". Canon §4 says 17 starters since 2018 + 1-2 QB since 2022 Superflex. Either canon is stale or constants are. Mitigated by Rule 6 — validation is informational only — so MFL is the actual gatekeeper. The visible bug is an inaccurate "12/14" counter, not a blocked submit (Q23).
- **Four-hooks exception confirmed intact.** `/api/submit-lineup` handler contains exactly: cookie franchise auth, MFL `import?TYPE=lineup`, response forwarder. Zero D1, zero Discord. Cross-checked every other MFL-write endpoint — all fire D1 + Discord. Lineup is the only exception.

#### §3.8.4 — Contract eligibility — `rosterContractEligibility` + worker `/commish-contract-update` / `/offer-*`

**Canon:** §1.C1–C8, §3.C
**Files traced:**
- Worker — `worker/src/index.js` combined handler L24519-24740 for `/offer-mym`, `/offer-restructure`, `/commish-contract-update`; tag-conflict helpers L11211-11407
- Desktop — `site/rosters/roster_workbench.js` `rosterContractEligibility` L558-576; consumers L902-909, L1359-1377, tag gating L6859-6924; submit handlers `submitExtensionUpdate` L10839, `submitRookieOptionUpdate` L10912, `submitRestructureUpdate` L10975, `submitTagPlanSelection` L11223, `submitUntagPlayer` L11307
- Mobile — `site/m/front_office_actions.js` `rosterContractEligibility` L111-129, `extensionBlockedByCurrentOwner` L235-242, `tagActionForPlayer` L357-397; submit modules `front_office_extend_submit.js`, `front_office_restructure_submit.js`, `front_office_tag_submit.js` (**no MYM submit module**)

| # | Event | Eligibility rule | Canon § | Worker | Desktop | Mobile | Status |
|---|---|---|---|---|---|---|---|
| 1 | MYAC | Auction-won players only, pre-Sept window | §1.C2 | 🔴 none | 🔴 no desktop MYAC submit flow | 🔴 no flow | 🔴 GAP (no MYAC submit pipeline anywhere) — **NEW** |
| 2 | MYAC | Loaded cap ≤ 5 FL+BL per roster | §1.C2 | 🔴 none | display chip `Loaded N/5` L6535 only | 🔴 none | ⚠ DRIFT (display-only) |
| 3 | MYAC | Max 6 three-year contracts per roster | §1.C2 | 🔴 none | 🔴 none | 🔴 none | 🔴 GAP |
| 4 | MYM | Max 4/season (2025+) | §1.C3 | 🔴 `/offer-mym` checks fields only L24645-24667 | 🔴 no desktop MYM flow | 🔴 no mobile MYM submit | 🔴 GAP — only 1 MYM banner in mobile rules.js |
| 5 | MYM | Window: pre-Week-3 kickoff (preseason holdover) | §1.C3 | 🔴 none | 🔴 none | 🔴 none | 🔴 GAP |
| 6 | MYM | Window: 14-day clock from in-season WW/FCFS | §1.C3 | 🔴 none | 🔴 none | 🔴 none | 🔴 GAP |
| 7 | MYM | Cannot be loaded (FL/BL ban) | §1.C3 | ⚠ hardcodes status="MYM-Rookie/Vet" no FL/BL suffix L24853; does NOT reject loaded `contract_info` payload | n/a | n/a | ❓ AMBIGUOUS — **NEW** (Q28) |
| 8 | MYM | Length must be 2 or 3 years | §1.C3 | 🔴 accepts any positive `contract_year` L24663 | n/a | n/a | 🔴 GAP — **NEW** |
| 9 | Extension | Player in final year OR expired rookie | §1.C4 | 🔴 no worker check | ✓ L572 `(years===1 \|\| expiredRookie)` | ✓ mirror L125 | ⚠ DRIFT (UI-only) |
| 10 | Extension | Status not `tag`; no `no further extensions` token | §1.C4 / §1.C8 | 🔴 none | ✓ L572 + L564-566 | ✓ mirror L117-125 | ⚠ DRIFT (UI-only) |
| 11 | Extension | Same franchise can't extend twice (RULE-EXT-003) | §1.C4 | 🔴 none | ✓ `extensionBlockedByCurrentOwner` L1264 + emoji-safe L1290-1314 | ✓ L235 + identity-token mirror L155-222 | ⚠ DRIFT (UI-only; not in canon — Q31) |
| 12 | Extension | Length 1 (Ext1) or 2 (Ext2) | §1.C4 | 🔴 none | ✓ `extensionPreviewYears` L980-1090 | ✓ preview JSON | ⚠ DRIFT (UI-only) |
| 13 | Extension | Ext1 no FL/BL; Ext2 allows; suffix auto-derived | §1.C4 (Keith 2026-05-15) | 🔴 none | ✓ preview-driven + `extractExtensionSuffix` L7406 | ✓ preview JSON | ⚠ DRIFT (UI-only; suffix derivation upstream in preview generator) |
| 14 | Extension | Calendar window (pre-Sept / pre-May / 4-week trade / 14-28 WW) | §1.C4 deadlines | 🔴 none | label-only `extensionDeadlineForPlayer` L2513, no block | 🔴 none | 🔴 GAP — **NEW** |
| 15 | Extension | Sch1/Sch2 AAV escalator applied to extension years only | §1.C4 | 🔴 none | ✓ `extensionRaiseForPlayer` L1473 + Schedule tables | inherits preview | ✓ ALIGNED desktop / ⚠ DRIFT mobile / 🔴 GAP worker |
| 16 | Restructure | `years 2-3` | §1.C5 | 🔴 accepts any positive `contract_year` L24663 | ✓ L574 | ✓ mirror L127 | ⚠ DRIFT (UI-only) |
| 17 | Restructure | `salary > $1K` | §1.C5 | 🔴 none | ✓ L574 | ✓ L127 | ⚠ DRIFT (UI-only) |
| 18 | Restructure | Not rookie-status | §1.C5 | ⚠ only skips rookie status string lookup L24841 | ✓ L574 `!rookieLikeContractStatus(status)` | ✓ L127 | ⚠ DRIFT (UI-only) |
| 19 | Restructure | Offseason-only window | §1.C5 | 🔴 none | 🔴 no date check on L10975 | 🔴 none | 🔴 GAP (canonical hard rule) |
| 20 | Restructure | Max 3 per team per season | §1.C5 | 🔴 none | 🔴 none | 🔴 none | 🔴 GAP |
| 21 | Restructure | Counts toward 5-loaded cap | §1.C5 | 🔴 none | display chip L6535 only | 🔴 none | ⚠ DRIFT |
| 22 | Rookie Option | Eligible only if `rookieOptionEligible && !exercised && cy===1` | §1.C6 | 🔴 none | ✓ `rookieOptionActionEligible` L615-619 | ✓ mirror L105-109 | ⚠ DRIFT (UI-only) |
| 23 | Rookie Option | Salary = base + $5K | §1.C6 | 🔴 none | ✓ `buildRookieOptionContractPayload` L633-652 | inherits preview | ⚠ DRIFT |
| 24 | Rookie Option | Deadline = Sept of final original-contract year | §1.C6 | 🔴 none | label-only L2547-2551 | 🔴 none | 🔴 GAP |
| 25 | Tag | Commissioner-only submit | §1.C8 | ✓ `getLeagueAdminState` L24669-24679 | UI allows OWN-team non-admin submit; worker rejects | mobile similar | ⚠ DRIFT (UI may show button non-admin) |
| 26 | Tag | 1 Offense + 1 Def/ST per team/year | §1.C8 | ✓ `fetchFranchiseTaggedPlayersBySide` L11267 + L24685-24739 (409 on conflict) | ✓ tag-tracking JSON filter L6875-6891 | ✓ `tagActionForPlayer` L357-397 | ✓ ALIGNED |
| 27 | Tag | Player must be in `tag_tracking.json` plan | §1.C8 | ⚠ reads to resolve side, doesn't reject off-plan tag | ✓ `currentTagPlanRows` L6893 | ✓ `tagActionForPlayer` step 1 L379-382 | ⚠ DRIFT (UI-only enforcement) — **NEW** |
| 28 | Tag | Tagged player CANNOT be extended OR MYM'd by ANY team | §1.C8 (2025) | 🔴 no worker cross-check | ✓ `liveRosterBlocksTagRow` L6875 + L572 | ✓ L125 | ⚠ DRIFT (UI-only) |
| 29 | Tag | Cannot be pre-extended by same owner in year tagged | §1.C8 | 🔴 none | inferred via RULE-EXT-003 byproduct | inferred similarly | ❓ AMBIGUOUS — **NEW** (Q27) |
| 30 | Tag | Taxi players cannot be tagged | §1.C8 | 🔴 none | ✓ `liveRosterBlocksTagRow` L6879 | ✓ L946 | ⚠ DRIFT (UI-only) |
| 31 | Tag | EXT-status player cannot be tagged | §1.C8 | 🔴 none | ✓ `liveRosterBlocksTagRow` L6883 (`type.indexOf("EXT") === 0`) | ⚠ inferred via no_further_ext, no explicit EXT-prefix block | ❓ AMBIGUOUS — **NEW** (mobile gap) |
| 32 | Untag | Only for currently-tagged player on viewer's team | §1.C8 | ✓ admin gate + state re-read | ✓ `playerContractActionFlags.untag` L908 | ✓ `tagActionForPlayer` L392 | ✓ ALIGNED |
| 33 | Calendar timing | Bucket-stamping for cut penalty | §3.C | 🔴 worker doesn't stamp which season's cap | n/a (cut is separate) | n/a | (covered in §3.8.1 rule 22) |
| 34 | Submitter authority | Only player's owner or commish may submit | §1.C (implicit) | ⚠ admin gate on manual updates only; `/offer-mym` + `/offer-restructure` do NOT verify caller franchise == player.franchise | ✓ `canManageRosterPlayer` L6859-6861 | ✓ same pattern | ⚠ DRIFT — **NEW** (security; Q30) |

**Drift/gap highlights (NEW):**
- **Systemic finding: most eligibility is UI-only.** A scripted POST to `/offer-restructure` with `contract_year=1` and `salary=500` would succeed. Same for `/offer-mym` (any length, any FL/BL payload), `/commish-contract-update` (any extension length, any rookie-option salary). Desktop and mobile mirror gates faithfully; worker is the missing layer.
- **`/offer-mym` and `/offer-restructure` don't enforce submitter == owner.** A logged-in owner could submit on another team's player.
- **No MYAC submit pipeline in any codebase.** Despite §1.C2 being a central pre-season event, no desktop or mobile MYAC submit handler exists.
- **Per-season caps unenforced (MYM ≤4, Restructure ≤3, Loaded ≤5, 3-year ≤6).** No D1 counter; restructure doesn't even have an audit table to count from (see §3.8.7).
- **Calendar windows entirely unenforced** (MYM 14-day, extension pre-Sept / pre-May / 4-week / 14-28 day, restructure offseason-only).

#### §3.8.5 — Extension flow (blocks + submit)

**Canon:** §1.C4, §1.C8, §2.T3.3 (L642), §3.C, §6.C4.6 (forward-looking TCV)
**Files traced:** `worker/src/index.js` `/commish-contract-update` L24519-25493 (esp. L24576-24582 extension detection, L25093-25205 D1 audit+master), `site/rosters/roster_workbench.js` (L558-576 eligibility, L1264-1271 + L1273-1282 block-by-current-owner / history, L1298-1355 synthesizeExtensionOption, L10839-10910 submitExtensionUpdate), `site/m/front_office_actions.js` (L235-256 block, L484-501 wasTaggedThisSeason, L503-529 extensionAvailableFor), `site/m/front_office_extend_submit.js` (L231-308 reshape, L356-396 submit)

**Hook coverage (extension submit):** MFL ✓ (L24856-24989), D1 ✓ (L25117 `ups_extension_submissions` + L25160 `ups_extension_master` UPSERT + L25426-25458 `salary_change_log`), Discord ✓ (L25329), Cap cron ⚠ (no `ledger_key` integration — extensions reset TCV/guarantee; the next cut's penalty math reads the post-extension contract from MFL. Architecturally correct.)

| # | Rule | Canon § | Worker | Desktop | Mobile | Status |
|---|---|---|---|---|---|---|
| 1 | Extension forward-looking TCV (no past years) | §1.C4 / §6.C4.6 | parses contractInfo upstream L25099-25109; trusts caller | `synthesizeExtensionOption` L1331 — correct | `applyExtensionOptionReshape` L255 + L279 — correct | ✓ ALIGNED |
| 2 | Length: Ext1=1, Ext2=2, no Ext3+ | §1.C4 | 🔴 no clamp | ✓ L1301 hard clamp | ✓ preview pre-clamped + `normalizeExtensionTermValue` L94-99 | ✓ ALIGNED clients / ⚠ worker trusts |
| 3 | FL/BL allowed on Ext2 only; Ext1 plain | §1.C4 (Keith 2026-05-15) | 🔴 no check | hardcodes `loadedIndicator: "NONE"` in synthesizer; preview JSON can carry FL/BL | preview JSON reshape preserves `loadedIndicator` L114, L192 | ❓ AMBIGUOUS (preview generator out of scope; no client/worker guard rejects Ext1-with-FL/BL) |
| 4 | Same team can't extend same player twice (RULE-EXT-003) | NOT in canon (only code comment L1274-1281) | 🔴 no block | ✓ L1264-1271 token match | ✓ L235-242 verbatim port | ⚠ DRIFT — **NEW** (Q31 — belongs in canon) |
| 5 | Tagged player CANNOT be extended by ANY team (incl. tagged-then-untagged) | §1.C8 | 🔴 no check | ✓ L572 catches CURRENT contract_status=TAG, NOT tagged-then-untagged | ✓ `wasTaggedThisSeason` L484-501 scans tag_submissions — catches the untag-then-extend exploit | ⚠ DRIFT — **NEW** (mobile stronger than desktop; Q32) |
| 6 | Eligibility: cy=1 OR expired rookie OR in-season pickup d15-28 OR trade-4wk | §1.C4 | 🔴 no window check | ✓ L572 covers cy=1 + expired rookie; ⚠ NOT in-season windows | mirror | 🔴 GAP — calendar windows unenforced |
| 7 | "no further extensions" / "not eligible for tag or extension" tokens | (code-only) | 🔴 none | ✓ L564-566 | ✓ mirror | ✓ ALIGNED (clients) |
| 8 | `contract_year` = full extension length (not length-1) | §C4 + memory | trusts payload; writes raw L25138 | ✓ L10876 explicit fix comment | ✓ L374 verbatim match | ✓ ALIGNED |
| 9 | `submission_kind: "extension"` discriminator | (operational) | ✓ L24576-24582 lenient detection | ✓ L10857 | ✓ L364 distinct source tag for forensics | ✓ ALIGNED |
| 10 | Payload shape parity (desktop ↔ mobile) | (operational) | accepts both via aliases L24555-24605 | 24 fields incl. prior_* snapshot | mirror EXCEPT `dry_run` from `IS_DRY_RUN_MODE` vs `args.dryRun` | ✓ ALIGNED (functionally) |
| 11 | All four hooks fire on success | §4 imperatives | MFL L24944, D1 audit+master L25117/L25160, Discord L25329, salary_change_log L25432 — gated on `looksOk && anyChanged` | n/a | n/a | ✓ ALIGNED |
| 12 | Discord activity_type uses extension flavor | (operational) | `deriveContractActivityType` L25265 | n/a | n/a | ✓ ALIGNED |
| 13 | Cap-cron/penalty-ledger pickup of extension | §3.C | none — extensions reset TCV/guarantee; impact realized on subsequent cut | n/a | n/a | ✓ ALIGNED (by design) |
| 14 | Commish-override flag captured | (operational) | L24598-24605 normalizes + propagates | ✓ L10852 `viewerCanManageAnyRoster() && !isOwnRosterPlayer` | ⚠ forwards `args.commishOverride` but caller doesn't compute it L382 | ⚠ DRIFT — **NEW** (mobile loses telemetry) |
| 15 | Admin-only `/commish-contract-update` | (security) | ✓ L24669-24679 admin check (403) | n/a | n/a | ✓ ALIGNED |

#### §3.8.6 — Tag / Untag + Discord routing

**Canon:** §1.C8 (Tags 2025), §2.T3.5 (Offense), §2.T3.6 (Def/ST), §3.A (Tag deadline = Memorial Day − 4), Appendix Bot Grounding (apply vs lock)
**Files traced:**
- Worker — `worker/src/index.js` `/commish-contract-update` (tag-conflict L24681-24740; audit+master L24991-25087; untag DM L25280-25326; channel post L25327-25358); `sendDiscordContractActivity` L15446; `sendDiscordContractActivityDm` L15603; `hasTagDeadlinePassed` L14389
- Desktop — `site/rosters/roster_workbench.js` `submitTagPlanSelection` L11223 (2-step), `submitUntagPlayer` L11307 (restore + unload), `buildTagContractPayload` L11075, `buildUntagContractPayload` L11106, `effectiveTagSalaryForRow` L2776 (10% floor), `conflictingTaggedPlayerForRow` L7158
- Mobile — `site/m/front_office_tag_submit.js` L102 + L131 + L223 + L267 — verbatim mirror per file header

**Hook coverage (tag submit):** MFL ✓, D1 ✓ (`ups_tag_submissions` + `ups_tag_master` UPSERT on `(season,league,franchise,tag_side)`), Discord ✓ (pre-deadline DM → `DISCORD_DM_USER_IDS`; post-deadline channel — L15484-15509), Cap cron n/a
**Hook coverage (untag submit):** MFL ✓, D1 ✓ (audit action="untag" + master DELETE on `(league,season,franchise,player_id)`), Discord ✓ **DM-only** to `COMMISH_DISCORD_USER_ID` via `sendDiscordDmEmbed` L25296. Channel branch is `else if` L25327 — mutually exclusive. Falls back to `dm:not-configured` skip if env var missing (no channel leak). Cap cron n/a

| # | Rule | Canon § | Worker | Desktop | Mobile | Status |
|---|---|---|---|---|---|---|
| 1 | 1 Offense + 1 Def/ST per franchise/year | §1.C8 | ✓ per-side conflict check L24728 (409) | ✓ `conflictingTaggedPlayerForRow` L7158 + stale-tag auto-clear L11142+L11177 | ⚠ no client-side pre-check; relies on worker 409 | ⚠ DRIFT — **NEW** (mobile UX rougher) |
| 2 | Tag salary = `max(tier-formula bid, prior AAV × 1.10 ↑$1K)` | §1.C8 / §T3.5 | ✗ no recompute; trusts client | ✓ `effectiveTagSalaryForRow` L2776 | ✓ verbatim mirror L61-72 | ✓ ALIGNED |
| 3 | Tier formulas (QB T1=top 1-5, RB T1=top 1-4, etc.) | §T3.5 / §T3.6 | n/a (upstream) | n/a (consumed via `row.tag_salary`) | n/a (same) | ❓ AMBIGUOUS — **NEW** (lives only in `pipelines/etl/scripts/build_tag_tracking.py`; canon flags "open for review") |
| 4 | PK/PN tag = prior salary + $1K | §T3.6 | n/a | n/a (upstream) | n/a | ❓ AMBIGUOUS (= rule 3) |
| 5 | Tagged player CANNOT be extended OR MYM'd by ANY team | §1.C8 | 🔴 no extension/MYM cross-check | ⚠ not enforced in extension submit path | ⚠ same | 🔴 GAP — **NEW** (high-impact) |
| 6 | Tagged players blocked from trading until deadline auto-lock | Appendix Bot Grounding | ✓ `isTaggedTradeIneligibleAsset` L11842 | n/a (trade flow) | n/a | ✓ ALIGNED with "apply ≠ lock" |
| 7 | Tag deadline = Thursday before Memorial Day | §3.A | ✓ `getTagDeadlineUtc` L14380 | n/a — label-only L11247 | n/a | ✓ ALIGNED with `ccc.js` formula |
| 8 | Tag deadline enforcement (block post-deadline submits?) | §3.A | ⚠ `hasTagDeadlinePassed` used for trade-eligibility + Discord routing, NOT to reject submits | ⚠ no precheck | ⚠ no precheck | 🔴 GAP — **NEW** (Q35) |
| 9 | Untag eligibility (who/when) | §1.C8 implicit | ⚠ no explicit check | ✓ `findTagTrackingReferenceRow` returns null if prior data missing → friendly error L11311 | ✓ mirror L131-141 | ✓ ALIGNED on prior-contract reconstruction; ❓ AMBIGUOUS on canon |
| 10 | Tag cap effect = 1-yr at tag salary, 75% GTD | §T3.5 / §T3.6 | n/a | ✓ `buildTagContractInfo` L2834 | ✓ verbatim mirror L82-97 | ✓ ALIGNED |
| 11 | Untag restores prior contract | §1.C8 | ✓ accepts arbitrary salary/status/info | ✓ from `findTagTrackingReferenceRow` | ✓ caller passes tag_tracking row | ✓ ALIGNED |
| 12 | Untag → unload from active roster after revert | derived | n/a (2-step from client) | ✓ `unload_player` L11337 | ✓ mirror L280-296 | ✓ ALIGNED |
| 13 | **Discord: tag pre-deadline → DM, post-deadline → channel** | Appendix + Keith 2026-05-16 | ✓ `sendDiscordContractActivity` L15484 routes to DM when `kind==='tag' && !hasTagDeadlinePassed` | n/a | n/a | ✓ ALIGNED |
| 14 | **Discord: untag → DM commish ONLY (no channel)** | §1.C8 / Keith 2026-05-16 | ✓ L25285-25326 `isUntagAction && looksOk && anyChanged` → `sendDiscordDmEmbed`; channel branch is `else if` L25327 (mutually exclusive) | n/a | n/a | ✓ CONFIRMED ALIGNED |
| 15 | D1 audit row for both tag and untag | derived | ✓ L25002-25035 `ups_tag_submissions` INSERT — gated on `looksOk && anyChanged` | n/a | n/a | ✓ ALIGNED |
| 16 | D1 master state updated (tag UPSERT, untag DELETE) | derived | ✓ L25048-25083; dry runs skip master L25046 | n/a | n/a | ✓ ALIGNED |
| 17 | Tagged player MUST enter next FA Auction unless cut pre-auction | §1.C8 | n/a | n/a | n/a | NOT ENFORCED IN SUBMIT (annual roll-forward / auction pipeline) |
| 18 | Eligibility: only 1-yr-remaining from prior season's ending roster | §1.C8 / §T3.5 | ⚠ no verify | ✓ upstream in tag_tracking.json | ✓ same | ✓ ALIGNED (upstream gating) |

**Drift/gap highlights (NEW):**
- **All four hooks confirmed firing for both tag and untag.** Untag DM-to-commish-only path explicitly verified — no channel fallback even if `COMMISH_DISCORD_USER_ID` env var missing (`delivery_target:"dm:not-configured"`).
- **Rule 5 (tagged → no extension/MYM "period")** is a canon directive with zero enforcement in the actual extension/MYM submit endpoints. Tag is preserved by `contract_status` token through MFL, but a determined owner could push around it.
- **Mobile rougher on per-side conflict (rule 1) and missing EXT-prefix tag block.** Desktop has `liveRosterBlocksTagRow:6883 type.indexOf("EXT") === 0`; mobile relies on `tag_tracking.json` membership instead — for a recently-extended player erroneously listed in the plan, mobile would show "Tag" while desktop shows blocked.

#### §3.8.7 — Restructure submit + hourly cap-penalty cron + ledger_key dedup

**Canon:** §1.C5 (L329), §2.T3.4 (L661), §3.C (L1070), §6.C1 (L1660), §6.D (L1787), Appendix Bot Grounding (rounding ~L2278)
**Files traced:**
- Worker — `worker/src/index.js` `/offer-restructure` handler L24519-25420 (shared with `/offer-mym` + `/commish-contract-update`); hourly cron `scheduled()` L97-314; `/admin/import-drop-penalties` L22198-22403; schedule `worker/wrangler.toml:32` (`crons = ["5 * * * *", "*/2 * * * *", "5 0,12,18 * * *"]`)
- Desktop — `site/rosters/roster_workbench.js` `submitRestructureUpdate` L10975-11041; eligibility L574+L907; action menu L1945; endpoint resolver L3745-3755
- Mobile — `site/m/front_office_restructure_submit.js` full file verbatim mirror; `submitRestructure` L320-330
- Report builder — `pipelines/etl/scripts/build_salary_adjustments_report.py` (penalty math L1395-1438, calendar milestones L196-208); published JSON at `https://keithcreelman.github.io/upsmflproduction/reports/salary_adjustments/salary_adjustments_${YEAR}.json` (cf. worker L22212)
- GH audit sink — `.github/workflows/log-restructure-submission.yml`

**Hook coverage (restructure submit):** MFL ✓ (L24856-24989), D1 ✗ (no `ups_restructure_submissions` table), Discord ✓ (L25327-25357 `activityType="Restructure"`), GH `dispatchRepoEvent("log-restructure-submission")` ✓ (L25216-25238), Cap cron N/A (no penalty)
**Cron schedule:** `5 * * * *` ✓ (gated `event.cron === "5 * * * *"` L143-148)
**Cron action coverage:** ONLY `adjustment_type === "DROP_PENALTY_CANDIDATE"` rows from the published JSON (L22226). TRADED_SALARY rows (also `import_eligible: true`) are NOT processed. Restructures/extensions/tags carry no penalty.
**ledger_key uniqueness:** worker L22269 uses `safeStr(row.ledger_key) || safeStr(row.source_id) || \`${row.player_id}_${row.transaction_datetime_et}\``. Python report builder does NOT emit a `ledger_key` field — worker always falls back to `source_id` (e.g. `adddrop2024_141.1`). Idempotency via MFL-side dedup: fetches existing `salaryAdjustments`, parses `id:<KEY>` from explanation (L22254-22258, L22332-22344) before posting.

| # | Rule | Canon § | Worker | Desktop | Mobile | Status |
|---|---|---|---|---|---|---|
| 1 | Restructure offseason-only (mid-season BANNED) | §1.C5, §2.T3.4 | 🔴 no window check on `/offer-restructure` | 🔴 `restructureEligible` checks years+salary only L574 | 🔴 no date gate | 🔴 GAP |
| 2 | Restructure ≥ 2 years remaining | §1.C5 | 🔴 no server validation | ✓ L574 `years >= 2 && years <= 3` | ✓ baseline computed for 2-3 only | ⚠ DRIFT (client-only) |
| 3 | Per-team annual ≤ 3 restructures | §1.C5, §3-Verification#7 | 🔴 no counter (no D1 audit table to count from) | 🔴 no UI counter | 🔴 none | 🔴 GAP |
| 4 | Restructure payload parity desktop↔mobile | §4 imperatives | n/a | L11001-11021 | `buildRestructurePayload` L295-318 — same fields | ✓ ALIGNED |
| 5 | Restructure four-hook coverage | §4 imperatives | MFL ✓ L24856; D1 ✗; Discord ✓ L25329; cron n/a | sends `commish_override_flag`, `dry_run` | ⚠ `dry_run` not passed | ⚠ DRIFT — **NEW** (D1 missing; mobile dry-run flag absent) |
| 6 | Cap cron schedule `5 * * * *` | (alignment doc) | ✓ wrangler.toml:32; gated L110/L143 | n/a | n/a | ✓ ALIGNED |
| 7 | Cron coverage = cuts (DROP_PENALTY_CANDIDATE) | §6.C, §6.D | ✓ L22226 filter correct | n/a | n/a | ✓ ALIGNED for cuts |
| 8 | Cron coverage = in-season trade cap money | §6.E1 | 🔴 TRADED_SALARY rows skipped despite `import_eligible: true` | n/a | n/a | ❓ AMBIGUOUS — **NEW** (Q38) |
| 9 | Cron penalty formula `(TCV × 75%) − Earned` | §6.C1 | ✓ Report L1420-1427 computes `tcv * 0.75 − total_salary_earned`; worker imports as-is | n/a | n/a | ✓ ALIGNED (formula shape) |
| 10 | Earned uses per-week pro-rated (2026-05-08) | §3.B, §6.B | 🔴 Report uses calendar milestones Sep30/Oct31/Nov30/EOS (L200-204) | n/a | n/a | 🔴 DRIFT — **NEW** (canon §3.B2 already tracks) |
| 11 | WW $5K+ uses uniform 75%+per-week (35% RETIRED) | §6.C3 | 🔴 Report L1408-1411 STILL applies `current_year_salary * 0.35` → `candidate_rule="waiver_35pct"` | n/a | n/a | 🔴 DRIFT — **NEW** (retired rule still active) |
| 12 | TCV < $5K → fixed $1K override | §6.C / Bot Grounding | ✓ Report L1429-1431; worker re-applies L22240-22242 | n/a | n/a | ✓ ALIGNED (double-applied) |
| 13 | 1-yr Vet/WW < $5K cap-free | §6.C2 | ✓ Report L1399-1400 | n/a | n/a | ✓ ALIGNED |
| 14 | Tag-cut-pre-auction cap-free | §6.C2 | ✓ Report L1397-1398 + L249-258 | n/a | n/a | ✓ ALIGNED |
| 15 | Rounding at TEAM level (not per-drop) | Appendix Bot Grounding | ✓ Worker L22232-22244 comment: "RULE-CAP-002 rounds at the TEAM level" | n/a | n/a | ✓ ALIGNED |
| 16 | Penalty timing buckets (current vs following season) | §3.C | ✓ Report `effective_drop_adjustment_season` L334-355 | n/a | n/a | ✓ ALIGNED |
| 17 | ledger_key dedup uniqueness | (alignment doc) | ✓ resolves to `source_id`; dedup against MFL salaryAdjustments by `id:KEY` parse (L22254-22258, L22332-22344). `ledger_key` field never actually emitted by report — doc comment L102 misleading | n/a | n/a | ⚠ ALIGNED in practice — **NEW** (doc misleading) |
| 18 | Cron preserves existing salaryAdj rows on import | (alignment doc) | ✓ L22325-22353 merge (default `preserve_existing=true`) | n/a | n/a | ✓ ALIGNED |
| 19 | Cron requires commissioner admin | (alignment doc) | ✓ L22314-22323 | n/a | n/a | ✓ ALIGNED |
| 20 | Discord cap-penalty announce per franchise | §3.C downstream | ✓ scheduled() L235-268 batches by franchise → `/admin/cap-penalty/post` with `DISCORD_CAP_PENALTY_CHANNEL_ID` | n/a | n/a | ✓ ALIGNED |

**Drift/gap highlights (NEW):**
- **Restructure is the only Group 3 transaction with NO D1 audit table.** Tag has `ups_tag_submissions` + `_master`, Extension has `ups_extension_submissions` + `_master`, Restructure has only GH workflow dispatch. No way to count "3 restructures per team per season" anywhere in code. (Resolves Q14 — there is no dedicated table.)
- **The cron is computing penalties under the OLD rule today.** Report builder (`pipelines/etl/scripts/build_salary_adjustments_report.py`) uses retired calendar-quarter milestones AND retired flat 35% WW. The cron consumes that JSON as-is.
- **`ledger_key` field literally never present.** Worker doc at `index.js:102` advertising "idempotent by `ups_drop_penalty:{ledger_key}`" is misleading. Dedup works because `source_id` is unique per-transaction-line.
- **TRADED_SALARY rows orphaned.** Report emits paired ±amount TRADED_SALARY rows with `import_eligible: true` (sample `trade2025_5.2a/b`). Cron skips by adjustment_type filter. Either intentional (trade-war-room module posts separately) or gap.
- **Cron schedule, dedup, formula shape, admin gate, team-level rounding, Discord per-team announce all correct.** The architecture is sound; only the formula INPUTS are stale.

---

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

**Additions from 2026-05-16 second pass (§3.8):**
- **Submitter-authority gate on `/offer-mym` and `/offer-restructure`** — neither verifies `cookie_franchise == body.franchise_id`. A logged-in owner could submit on another team's player. Mirror the admin gate from `/commish-contract-update` (§3.8.4 r34).
- **Worker-side RULE-EXT-003 re-check** — query `ups_extension_master` for `(league_id, season, franchise_id, player_id)` before allowing INSERT. Today the gate is client-only (§3.8.5 r4).
- **Worker-side §C8.2 tag-block on extension/MYM submit** — query `ups_tag_submissions` for any `action=tag` matching `(season, player_id)` regardless of franchise; reject extension/MYM if found. Today only mobile enforces via `wasTaggedThisSeason` (§3.8.5 r5, §3.8.6 r5).
- **Subject-state re-validation on `/offer-restructure`** — re-fetch the subject player's current `salaries` row and confirm `contractYear >= 2`, `salary > 1000`, status not rookie. Today only the UI checks (§3.8.4 r16-18).
- **MYM payload — reject loaded FL/BL `contract_info`** OR silently strip the suffix. Today worker labels MYM as `MYM-Rookie/Vet` but doesn't reject loaded payload (§3.8.4 r7).
- **MYM length clamp** — `contract_year ∈ {2, 3}`. Today accepts any positive value (§3.8.4 r8).
- **Auto-derive `-FL`/`-BL` suffix on extension** from `Y1/Y2` parse of contractInfo, and reject Ext1 with `-FL`/`-BL` suffix (§3.8.5 r3).
- **Tag-deadline rejection on submit** — `if (isTagAction && hasTagDeadlinePassed(year) && !commish_override_flag) return validation_fail`. Today only client-side label warns (§3.8.6 r8).
- **Tag-plan membership check** — worker should reject a tag for a player missing from `tag_tracking.json`. Today only client UIs filter (§3.8.6 r27).
- **Calendar-window enforcement** for MYM (14-day WW + pre-Week-3), extensions (pre-Sept / pre-May / 4-week trade / 14-28 day WW), restructures (offseason-only) — inject a calendar-aware gate consulting `event_window_matrix.csv` / `mfl_league_years` / `league_events.nfl_kickoff`.

**Proposed pattern:** Add a `/api/league-rules?season=X` endpoint returning the current rule set (computed from MFL settings + UPS-side overrides + season-relative dates). All write endpoints (`/commish-contract-update`, `/offer-restructure`, etc.) gate on these rules at the worker boundary. Clients fetch + display the same rule state for UI gating.

This addresses Keith MobileNotesV1: "Make sure you review those sorts of rules in settings that we have for transactions within the API."

### §4.3 — D1 audit completeness

Per the principle "every submission writes a D1 row":

- 🔴 **OTB submissions** — no audit table today; add `ups_tradebait_submissions`.
- 🔴 **Lineup submissions** — `MOBILE_DRIFT_PREVENTION.md §2.8` (Keith parked migration).
- ⚠ **Drop** — `salary_change_log` has no `source` field to discriminate mobile vs. desktop. Add. **Confirmed §3.8.1:** no `ups_drop_submissions` exists at all; `salary_change_log` is keyed off salary-import events, not raw drop submits. Drop fires only 2 of 4 hooks at submit (MFL + deferred cron). Add `ups_drop_submissions(league_id, season, franchise_id, player_id, ts, source, action_payload)` written synchronously at `drop_player` submit time.
- 🔴 **Restructure** — **Confirmed §3.8.7:** no dedicated `ups_restructure_submissions` table. Tag and Extension both have `ups_*_submissions` + `_master`; restructure has only GH workflow dispatch. Without a table, "max 3 restructures/season" (§4.2) is uncountable. Add `ups_restructure_submissions` + `ups_restructure_master` matching the Tag/Extension precedent.

### §4.5 — Earning curve migration (CROSS-CODEBASE, P0)

Three independent code paths still encode the pre-2026-05-08 calendar-quarter earning curve and/or the retired flat 35% WW rule. Per `~/.claude/.../memory/project_ww_penalty_prorate_migration.md` Keith tabled this 2026-05-15. Re-surfacing here so the full surface area is visible when the migration ships:

- **Python report builder** (`pipelines/etl/scripts/build_salary_adjustments_report.py`, `pipelines/etl/lib/cap_penalty.py`) — calendar milestones at L196-208; `candidate_rule="waiver_35pct"` branch at L1408. This is the canonical input to the hourly cron, so the cron is currently computing penalties under the OLD rule.
- **Desktop preview** (`site/rosters/roster_workbench.js:1777-1793` `proratedEarnedForDrop` + L1896-1908 35% WW short-circuit). Calendar-bucket anchors are off-by-one (uses `[Sep30, Oct31, Nov30]` vs canon §6.B2 `[Oct1, Nov1, Dec1]`) — compound bug.
- **Mobile preview** (`site/m/front_office_penalty.js:248-264` verbatim mirror; self-flagged "TABLED CROSS-CODEBASE MIGRATION" at L231-247 + L370-378).
- **Worker JS lib** (`worker/src/lib/cap_penalty.js`) HAS the correct per-week formula (L89-95) but is **never imported by `worker/src/index.js`**. Either wire it in for live (non-batch) computation or mark as deprecated. Today it's parity mirror that nothing calls.

Single coordinated PR: port the per-NFL-week formula (anchored to `league_events.nfl_kickoff`) into the Python report; retire the `waiver_35pct` branch; port to both clients in lockstep; either wire `cap_penalty.js` into `index.js` for live preview OR delete it.

### §4.6 — Lineup starters constants vs canon §4 reconciliation

`LINEUP_GROUPS` in `site/team_operations/team_operations.js:829-841` and its byte-equal mirror `site/m/front_office_lineup.js:21-33` encode **14 total starters, max 1 QB**. Canon §4 records **17 starters since 2018** (L1414-1428) and **1-2 QBs since 2022 Superflex** (L1467-1468). Code comment at `team_operations.js:826` claims "verified 2026-05-15 against L=74598" — so either the constants are stale OR canon §4 is stale OR the league actually reverted/never adopted those starter changes. Per §3.8.3 the visible bug is only an inaccurate "12/14" counter (validation is informational per Keith 2026-05-15) — but the discrepancy needs Keith's call.

**Action:** pull live `/api/league` for L=74598, compare against canon §4, update whichever side is wrong. If code is wrong, update both LINEUP_GROUPS constants in lockstep.

### §4.7 — Cap floor $260K compliance tracker

Canon §6.A2 specifies the $260K floor must be touched at some point during the FA Auction (with a Sept-deadline backstop). **Zero enforcement and zero computation exists** — `worker/src/index.js` has no `cap_floor` constant, no DB column, no touch-and-go aggregator. Today the floor is honor-system + commish manual review at season end.

**Proposed:** worker emits a daily compliance report during the auction window — reads `salaryAdjustments` + `rosters` timestamps across the auction window, computes whether each franchise crossed $260K at any timestamp, surfaces violators to a commish-only Discord DM.

### §4.8 — Cron / report cleanup

- **`ledger_key` field never emitted** by the report builder. Worker doc comment at `index.js:102` advertises "idempotent by `ups_drop_penalty:{ledger_key}`" — misleading. Either have the Python report emit `f"{player_id}_{source_id}"` so the contract is real, or update the comment to reference `source_id` as the actual dedup key.
- **TRADED_SALARY rows orphaned in cron.** Report emits paired ±amount TRADED_SALARY rows with `import_eligible: true`, but the cron filters to `DROP_PENALTY_CANDIDATE` only. Confirm with Keith (Q38) whether trade-war-room posts these directly on accept (making the report flag advisory) or whether cron coverage should extend.
- **TCV<$5K override applied twice** — report L1429-1431 emits $1K, worker L22240-22242 re-overrides to $1K. Harmless but should be single source of truth.
- **Penalty rounding** — canon Appendix Bot Grounding L2280 says round on the SUM; all three code paths round per-penalty. Low impact; literal canon violation.

### §4.9 — Mobile parity gaps surfaced by §3.8

- **Mobile per-side tag conflict pre-check** — desktop has `conflictingTaggedPlayerForRow` L7158; mobile relies on worker 409. Add mobile prompt for cleaner UX (§3.8.6 r1).
- **Mobile EXT-prefix tag block** — desktop has `liveRosterBlocksTagRow:6883 type.indexOf("EXT") === 0`; mobile relies only on `tag_tracking.json` membership. Add the EXT-prefix block (§3.8.6 r31).
- **Mobile `dry_run` flag** — desktop sends `dry_run: IS_DRY_RUN_MODE ? 1 : 0`; mobile `buildRestructurePayload` doesn't set it (§3.8.7 r5).
- **Mobile commish_override telemetry** — `front_office_extend_submit.js:382` forwards `args.commishOverride` but caller doesn't compute it from viewer role. Add mobile equivalent of `viewerCanManageAnyRoster() && !isOwnRosterPlayer` (§3.8.5 r14).

### §4.10 — Tier-formula visibility

Canon §C8 says "read the code, not the rulebook" — but the code in question is `pipelines/etl/scripts/build_tag_tracking.py`, not in `worker/` or `site/`. Tag tier formulas (QB T1=top 1-5 AAV, RB T1=top 1-4, WR T1=top 1-6, TE T1=top 1-3, PK/PN = prior salary + $1K) are invisible from the worker/UI codepath. Surface them in a shared constants file or worker-side reference doc so the canon citation has a code anchor (§3.8.6 r3).

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
| Q15 | Late dues + missed-nomination fines | Canon §6.D flags these for review. Are they real-dollar cash penalties (don't touch cap) or cap adjustments? Implementation differs based on answer. | §3.2 |
| Q16 | Auction Room scope | Full UPS-side auction tool, or "war room dashboard" overlaying MFL's email auction with UPS rule warnings? See §4.1. | §4.1 |
| Q17 | Tag-cut "pre-auction" cutoff date | Canon §6.C2 "Tag cut BEFORE FA Auction starts → $0 (tag nullified)". Clients hard-code Aug 1 (`new Date(yr, 7, 1)`); FA Auction start varies year-to-year per league config. Should clients query a worker endpoint for the per-season cutoff (vs hard-coded Aug 1)? | §3.8.1 r14/25 |
| Q18 | `drop_reason` field source | Worker's `cap_penalty.js` has cap-free branches for `drop_reason ∈ {"retired", "trade", "cap_free_cut", "taxi_drop", "expired"}`, but `/api/drop-player` doesn't accept a `drop_reason` parameter. All owner-driven drops hit the default formula path. Where is `drop_reason` inferred (cron-side from MFL `move_type`?), or is this why commissioner-flag drops aren't surfacing correctly? | §3.8.1 (NEW) |
| Q19 | Penalty rounding — sum vs per-penalty | Appendix Bot Grounding L2280 says "round on the SUM of penalties accrued." Code rounds per-penalty. Does this mean (a) accumulate raw decimals, then `round(sum)` once; or (b) round each, sum the rounded values? Today is (b). If (a), it matters when multiple drops happen the same cron cycle. | §3.8.1 r24 |
| Q20 | FL/BL Y[] backfill for client preview parity | For pre-2021 FL/BL contracts without explicit `Y1-`/`Y2-`/`Y3-` tokens in `contractInfo`, the client fallback uses AAV-style derivation (`roster_workbench.js:153-160`). Acceptable approximation, or backfill Y[] tokens on all historical contracts so client preview matches worker exactly? | §3.8.1 r23 |
| Q21 | TCV-low threshold inconsistency | Three different cutoffs across adjacent files: `<=$4K` in worker import override + mobile feed; `<$5K` in `cap_penalty.js` 1-yr cap-free; `<$5K` in `cap_penalty.js` multi-year override. Canon §6.C2 says "1-yr Vet/WW under $5K → $0 cap-free." Are the codebases right and canon wrong, or should everything converge on `<$5K`? Note: relates to but is distinct from Q1 (which is WW-specific). | §3.8.2 r12 |
| Q22 | Remove `cap_penalty.js` JS lib? | `worker/src/lib/cap_penalty.js` has the correct per-week formula but is never imported by `worker/src/index.js`. The hourly cron consumes a pre-built JSON from `pipelines/etl/lib/cap_penalty.py`. Keep both (slow drift risk), wire the JS lib in for live preview, or delete the JS lib and treat the Python script as canonical? | §3.8.2 r8 |
| Q23 | LINEUP_GROUPS 14 starters / max-1-QB vs canon §4 (17 / 1-2 QB) | Both clients encode 14 starters + max 1 QB; canon §4 records 17 starters since 2018 and 1-2 QBs since 2022 Superflex. Code comment claims "verified 2026-05-15 against L=74598". Is the live 2026 UPS league actually 14/1, or are LINEUP_GROUPS constants stale and need updating to 17/1-2? Single Front-Office check would resolve. | §3.8.3 r2-3 |
| Q24 | Lineup DM fan-out + D1 audit ship timing | Currently the only documented four-hooks exception (MOBILE_DRIFT_PREVENTION §2.8). Should the lineup DM fan-out + `ups_lineup_submissions` migration ship before next season kickoff, or stay parked indefinitely? | §3.8.3 |
| Q25 | MYAC submit pipeline | No MYAC submit handler exists in any codebase — MYAC is manual in MFL today. Build a UPS-side MYAC submit flow (FL/BL config, TCV preservation, 20%-min-Y1 BL check, 5-loaded-roster cap, 6-3yr-roster cap), or keep manual indefinitely? | §3.8.4 r1 |
| Q26 | MYM 14-day pickup-window clock | Should the 14-day clock be measured from (a) MFL transaction timestamp, (b) MFL acquisition-game-week, or (c) `R-D-1` event_log? Today no layer enforces, so no answer is encoded. | §3.8.4 r6 |
| Q27 | Pre-extension-in-tag-year — explicit check or rely on RULE-EXT-003? | Canon §1.C8 says "tagged player CANNOT be pre-extended in the year tagged." Should this be a worker hard-block based on a calendar+tag-state check, or is RULE-EXT-003 (same-owner-cannot-double-extend) considered sufficient coverage? | §3.8.4 r29 |
| Q28 | MYM FL/BL payload handling | Worker `/offer-mym` accepts loaded `contract_info`. Canon §1.C3 says MYMs cannot be FL/BL. Reject outright (400), or silently strip the FL/BL suffix? | §3.8.4 r7 |
| Q29 | Restructure salary >$1K floor — canonical? | Desktop's `restructureEligible` L574 adds `salary > $1K`; canon §1.C5 says "2+ years remaining" but doesn't explicitly exclude $1K floors. Confirm the rule, then either canonize it or drop the UI check. | §3.8.4 r17 |
| Q30 | Worker eligibility validators — re-fetch MFL state or trust client? | Currently only `/commish-contract-update` tag-side path does live verification; other paths trust client payload. Should all eligibility checks re-fetch the subject player's current `salaries` row before accepting? | §3.8.4 r34 |
| Q31 | RULE-EXT-003 belongs in canon | "A player cannot be extended twice by the same franchise" is enforced in both clients with explicit RULE-EXT-003 reference, but the rule is not in `docs/league_context_v1.md §1.C4`. Add to canon so worker enforcement (§4.2) has explicit canon backing. | §3.8.5 r4 |
| Q32 | Desktop adopt mobile's `wasTaggedThisSeason` gate? | Mobile's `wasTaggedThisSeason` (scans `tag_submissions` for any prior tag this season) catches the tagged-then-untagged-then-extend exploit. Desktop only checks current `contract_status` — would pass eligibility on the same exploit. Backport to desktop? | §3.8.5 r5 |
| Q33 | Extension-deadline server enforcement scope | Should the worker reject post-deadline extension submits, or stay permissive and rely on commish review? Today only client labels warn. | §3.8.5 r6 |
| Q34 | Tier-formula re-review | Canon §C8 explicitly flags Keith wants to revisit tier math. Formulas live in `pipelines/etl/scripts/build_tag_tracking.py` (not traced here). Confirm the live formulas match the canon list (QB T1=top 1-5, RB T1=top 1-4, WR T1=top 1-6, TE T1=top 1-3, PK/PN = prior salary + $1K) before locking. | §3.8.6 r3-4 |
| Q35 | Untag-after-deadline allowed? | Appendix Bot Grounding says player "auto-locks on tag deadline day." Should untag be rejected after deadline (today: silently allowed since `submission_kind:"untag"` has no deadline gate)? | §3.8.6 r8 |
| Q36 | Early "Lock in" button | Appendix mentions "proposed early-lock-in rule (May 2026 round)." Not present in either submit path. Ship the Lock-in button + tradeable-flag flip server-side? | §3.8.6 |
| Q37 | DM recipient lists clarification | `DISCORD_DM_USER_IDS` (pre-deadline tag) vs `COMMISH_DISCORD_USER_ID` (untag) are different env keys with different intended audiences. Document who each targets (commish only, commish + Keith, whole admin group). | §3.8.6 r13-14 |
| Q38 | TRADED_SALARY cron behavior | Report emits paired ±amount TRADED_SALARY rows with `import_eligible: true`, but the hourly cron filters to `DROP_PENALTY_CANDIDATE` only. Is trade-war-room posting trade salary adjustments directly to MFL on accept (making the report flag advisory), or do these rows need a parallel cron path? | §3.8.7 r8 |
| Q39 | Restructure offseason window — server enforce or honor system? | Tag and extension flows DO have window enforcement upstream; restructure has none. Server-enforce (with commissioner-override flag), or treat as honor-system + commish audit? | §3.8.7 r1 |
