# League Record S1: an evidence-first proposal for future-pick custody and identity (register LR-03, LR-13, LR-14, LR-15)

**Status:** a proposal and analysis. It changes no classification, no resolution rule and no count: the 597 traded future picks stay UNRESOLVED, `UNIQUE_HOLDER_V1` infers 0, count-only matching stays diagnostic. Nothing external was queried; every number is a count of records in the committed extraction (`summary.future_picks`, `findings.lists`) and is pinned by tests. Prepared at the commissioner's request of 2026-11-21 ("not a permanent architectural dead end").

## 1. Four questions, kept apart

A "which slot did this pick become?" answer silently combines four different questions. Each has its own authority, its own evidence and its own status today.

| # | Question | What answers it | Status today |
|---|---|---|---|
| **Q1** | **Transaction-log completeness:** does our data hold every trade of the interval? | An authoritative source that is independent of the log, or a complete export checked against an independent end state. A quiet period or a matching count is not evidence. | **Unverified** for every interval (0 of 38 quiet windows verified; the 100-day gap is a known gap). A1-A4 are approved to start on the gap. |
| **Q2** | **Asset possession:** who held the pick, and when? | The chain of recorded transfers, bracketed by authoritative observations of the holder at a date. | Chains are recorded; 3 pick-chain breaks (all slot-token chains, 2013 round 1). Continuous possession is **recorded, not verified** (it depends on Q1). |
| **Q3** | **Original-franchise identity:** whose pick is it? | The future-pick token itself: `FP_<original>_<year>_<round>` names the original franchise, year and round. | **Known** for every future pick (the token is MFL's own identity). This is *not* the uncertain part. |
| **Q4** | **Draft-slot identity:** which slot did that pick become? | A direct MFL statement of the original franchise for a slot, or complete event accounting of who held which pick and which slot when the slots were first listed. **Never** standings, finishes, brackets or a projected order. | **Unresolved for all 597.** The one fact the data never states. |

The practical consequence: the question is not "can we prove custody everywhere" but "which of Q1, Q2 and Q4 can an authoritative source answer, for which picks, and for the rest what must the owner-visible answer say".

## 2. What the data says today

| Fact | Count |
|---|---|
| Traded future picks (draft years 2012-2025) | 597 (181 in 2012-2016, 416 in 2017-2025) |
| Custody observed under the strict rule | 0 |
| Pass the event screen (diagnostic, not identity) | 122 (40 in 2013-2016, 82 in 2018-2025) |
| ...and rest on none of the three disclosed assumptions | **1** |
| Held by a franchise with several picks in the round (cannot be resolved from these events) | 343 |
| Rounds the screen cannot evaluate (accounts disagree 96, selector missing 68, slot-token chain ends elsewhere 54, forfeited 10, slot count 10, chain break 8; picks can have several reasons) | the rest |

## 3. Evidence inventory: what each source can and cannot prove

| Source | Authority | Q1 | Q2 | Q4 | Limits |
|---|---|---|---|---|---|
| MFL trade log (the archive copy, A1/A2 exports) | authoritative, but one source | **cannot verify itself**; an export only detects loss in the copy | recorded events | partial: slot-token trades name the slot | The archive is a copy of MFL's own log; comparing the two is circular. |
| Draft results (MFL table 2018+, legacy 2012-2017) | authoritative | none | the holder **at the selection** (an end-state observation) | names the slot and the selector | Before 2018 the selector can be whoever clicked, not the owner (canon T1.8); 20 legacy rows name no franchise. |
| Dated end-state exports (A4 now; A3 undated) | authoritative for **its own date** | the only check outside the log, for that date | holder of every pick on that date | none after the order is set | An export shows the state on its capture date; no source for a **past** date is known. |
| MFL's slot notes ("Pick traded from X") | MFL-authored text on the draft row | none | partial hop lists | corroboration only (commissioner's ruling) | Present from 2017. See section 4. |
| Pre-draft slot lists | authoritative at their date | none | holder of each slot at a date | slot holders | Committed snapshots start 2026-04-21 only. |
| Forum, Discord, e-mail announcements | secondary | hints about a missing trade | hints | none | Not authoritative; the Discord export is private chat and must not be copied. The public forum (2012-2017) is external and was not queried. |
| Standings, finishes, brackets, projected order | **forbidden** | | | | Never used, directly or by reconstruction. |

## 4. What the diagnostics show (all reproducible; pinned by tests)

**The 122.** A franchise's slots when MFL first listed them (S0) are derived from the slot-token trails and the draft results; a round is consistent when, for every franchise, |S0| equals the picks the chains leave with it; a holder with exactly one pick and one S0 slot gets that slot. 122 picks pass. They are **not** evidence of identity: 67 rest on the reading that the first recorded slot-token sender held the slot when MFL listed it, 33 end with several slots, 115 have a slot-token trade within a day of a selection (pre-2024 trade times are processing times).

**The one with no disclosed assumption: `fpick:0004:2013:2`.** Franchise 0004's 2013 second-round pick was traded once, 0004 to 0010 on 2012-10-23 (`trade2012_25`, recorded with processing time), and franchise 0010 is the recorded selector of slot 2.08. Across the whole round there are 16 future-pick trades and 17 slot-token trades between 2012-06-20 and the draft on 2013-07-01, and exactly **one** unverified quiet interval lies inside that span (2013-03-16 to 2013-05-12, 58 days). It is the single best test case, and still not resolved: (a) that interval cannot be verified by an export under the coverage model (an end-state source for a past date is not known to exist; an export of the 2013 instance, league 42721 on `www46`, would only compare the log with itself); (b) the draft result names the selector, which before 2018 may be the clicker; (c) the round's creation-time picks and any never-traded pick have no recorded event, so custody before the first trade is asserted by the first record, not observed. **It shows what a supportable case would need, and that today none is complete.**

**MFL's notes as a second, MFL-authored source (corroboration only).** The draft rows of 2017 onward carry "Pick traded from X" notes; 2012-2016 rows carry none (181 of the 597 picks fall there). Reading each note as a list of franchise ids and comparing it with each pick's own recorded sender sequence and the selector:

| Result (draft years 2017-2025; 416 traded picks) | Picks |
|---|---|
| Exactly one slot of the round matches the pick | 108 |
| No slot matches | 308 |
| Several slots match | 0 |
| Of the 82 event-screen picks: the note agrees with the screen's slot | 20 |
| ...the note is absent | 21 |
| ...a name cannot be read to one franchise | 7 |
| ...the note exists but differs from the chain | 34 |
| ...the note matches a different slot (a contradiction) | **0** |

Reading: notes never contradict the screen where they match, but they are **partial hop lists** (an example note names only the original franchise and the last sender of a longer chain), so a difference is not by itself an error and a match is not proof. They cannot carry identity (the commissioner's ruling stands); they can **corroborate** a link that an approved method has already supported, and a difference is a research flag, not a verdict.

**Where MFL does not help.** No committed MFL export names the original franchise of a slot: the draft-result rows carry round, pick, franchise, player, time and comments only; the D1 mirror `src_draft_picks` is a copy of the same results. Whether any other MFL report (a draft-order setting, an audit log) names it is **unknown and unqueried**.

## 5. Proposal: a staged, evidence-first plan

Each stage says what it can change and what it cannot. Stages marked **needs approval** are not started.

| # | Stage | What it can establish | What it cannot | Approval |
|---|---|---|---|---|
| **0** | **Show the four layers in every output.** Each pick reports: identity (Q3, known from the token), possession (Q2, recorded / unverified / broken), log coverage (Q1, state), slot identity (Q4, unresolved) and, if unresolved, the evidence needed and the register item. | Honest answers today: *known*, *calculated*, *inferred*, *needs research* never blend. | Resolves nothing. | none (design only) |
| **1** | **A1-A4** (approved), reconciled against the archive when you supply the sanitized output. | The gap's trades compared with the log (copy-loss check); A4 as a current dated observation; per-instance verification **candidates**. | A clean export is not "nothing happened"; A3 is undated; A4 is not historical proof. | approved (LR-02) |
| **2** | **Go-forward dated captures.** From now on, capture the same exports at fixed milestones (after the trade deadline; after rollover; when slots are first listed; at draft start; after the draft) with the same runner and sanitizer. | For draft years 2027 and later, an end-state observation **at each end of each interval**: Q1 verified by an independent check, Q2 bracketed, Q4 directly observed at listing. The dead end becomes a protocol for the future. | Nothing for the past. | **needs approval** for each run (A4 is the first capture) |
| **3** | **Ask what MFL can supply.** A question for you or MFL support: is there a report or admin log that names a slot's original franchise, or that shows pick ownership on a past date? | If yes, a direct Q4 source and possibly a past-date end state for Q1. | Unknown; may not exist. | you decide (external contact) |
| **4** | **Local secondary checks** (no external call): search the local rulebooks and committed archives for dated trade or draft-night statements that bear on a specific window (e.g. 2013-03-16 to 2013-05-12). | Research hints; may reveal a missing trade. | Secondary: never promotes a class. The Discord export is private: counts and dates only, no text copied. | needs your go |
| **5** | **N1-N3 (2014 only)** when you authorize them. | The 2014 4.12 conflict, one record. | Nothing about other picks. | not approved |
| **6** | **Approve a method** (working name `EVENT_ACCOUNTING_V1`) only against the conditions in `S1_FUTURE_PICK_ASSESSMENT.md` section 6, including verified custody over the whole round, and with a second source (notes agreement where they exist) as corroboration. | At most INFERRED links, never CONFIRMED, disclosed with their assumptions. | Cannot be approved until Q1 can be satisfied for the picks concerned. | decision after stages 1-3 |
| **7** | **Accept the rest as limitations, visibly.** For every pick that stays unresolved, the owner-visible answer shows the candidate slots, the evidence, what is missing and the register item (`lr_evidence_need`), never a default. | Nothing is hidden or defaulted. | Does not resolve anything. | per limitation, cited in the register |

## 6. Realistic outlook (what could become supportable, and what will not)

| Group | Picks | Outlook |
|---|---|---|
| Draft years 2027 and later | future | Resolvable **end to end** if stage 2 is adopted: observations at both ends of every interval. |
| 2018-2025, passes the screen | 82 | Candidates only. Supportable **only if** an independent end state for the past dates exists (stage 3) or the window is bracketed some other way; otherwise ACCEPTED_LIMITATION with the evidence shown. Notes agree for 20, never contradict. |
| 2012-2016, passes the screen | 40 | Same, with no MFL notes and a clicker-versus-owner uncertainty: the weakest group. |
| Held by a franchise with several picks | 343 | **Not resolvable from events.** Needs a direct MFL statement of the original franchise per slot (stage 3) or stays UNRESOLVED. |
| Rounds that fail the screen (accounts disagree, selector missing, forfeited, chain break) | the remainder | Each reason names its own evidence need; several (the 20 legacy rows with no franchise id, a missing token event) are research items, not data states. |

The honest ceiling for the past is therefore a **minority** of the 597, conditional on evidence we do not yet have. The product that is reliable today is the layered answer: identity known, possession recorded, coverage unverified, slot unresolved, with the next evidence named.

## 7. Decision needed

**One, recommended:** approve designing the go-forward capture protocol (stage 2) as the way out of the dead end for future seasons, and tell me whether you will ask MFL support the stage 3 question. Neither needs any action from me beyond documentation until you approve a run.
