# League Record S1: the source-coverage model (proposal, decision 2 of 2026-11-21)

**Status:** a model and a tested diagnostic (`scripts/league_record/s1/coverage.mjs`), not a rule change. The resolution rules in `lineage.mjs` are unchanged, all 597 unresolved future picks stay in every report, and no link is added. The model changes what a *future* decision could rely on; it relaxes nothing today. Local and read-only: no external call, no production system, no D1.

## 1. The problem the model solves

Today a "quiet window" (a gap of 14 or more days between two recorded dates, so at least 13 quiet days; a record of any type counts as activity, including automatic lock and unlock rows) marks custody as unobserved. That is deliberately conservative, but it conflates two different facts:

- *No transaction happened* (a quiet period inside a source that would have recorded one), and
- *The source may not have recorded what happened* (a source that is incomplete, or absent).

The commissioner's ruling (2026-11-21): a quiet period must not by itself prove uninterrupted custody, and inactivity must not be treated as missing coverage either. The model therefore describes **how much we trust the source over an interval** separately from **what happened in it**.

## 2. Four things, kept apart

| Concept | What it is | Where it lives | Can it block or prove custody? |
|---|---|---|---|
| **Recorded activity** | A transaction event with its timestamp and date quality | the event ledger | Never by itself. An event is a fact about one asset, not a statement about an interval. |
| **VERIFIED_COMPLETE** | An authoritative, complete source covers the interval **and** the completeness checks in section 4 passed, whether or not any transaction occurred | a verification record | Yes: custody is *observed* across the interval, including a quiet stretch inside it. |
| **UNVERIFIED** | A source exists but its completeness for the event class is not established | the default for **every day**: the quiet windows and the named gap are labels for reporting, not the only unverified days | Blocks (as today). A quiet period here proves nothing, and neither does a busy stretch. |
| **KNOWN_GAP** | No adequate source covers the interval | the named gap (2025-11-28 to 2026-03-07) | Blocks. Becomes VERIFIED_COMPLETE only if verifications cover all of it. |

Two more rules:

- **Per event class.** Coverage is stated for `pick_transfer` and `player_move` separately. A verified add/drop log does not verify trades.
- **Point observations are a different kind of evidence.** A dated end-state (the draft results, an MFL future-picks export on a call date) says who held an asset *on that date*. It is used to *test* an interval (check E3 below) and is never an interval state.

## 3. What the archive actually offers today

Facts checked on 2026-11-21 against the committed archive (read-only):

- **No interval is verified.** The extraction now carries a state on every interval: 38 quiet windows (1,532 days) are UNVERIFIED, the named gap (100 days) is a KNOWN_GAP, 0 are VERIFIED_COMPLETE.
- **Record numbering proves nothing.** `txn_index` in `transactions_base` runs 0..n-1 without a hole in every season, and trade ids run 1..n without a hole in every year, but both are assigned by the load, so their continuity is true by construction. A missing trade would not leave a hole. This is why continuity of ids is **not** accepted as a completeness check.
- **The archive is one copy, captured once.** It is a database dated 2026-06-05; nothing in it records a request, a capture time per season or a response count. So it cannot attest to its own completeness.
- **Recorded activity is uneven in quality.** 2,546 of the 26,141 rows are administrative or automatic (`LOCK_ALL_PLAYERS`, `UNLOCK_ALL_PLAYERS`, `LOAD_ROSTERS`, auto-processed waivers); 68 `AUCTION_WON` rows in the 2011, 2012, 2013, 2015 and 2016 league instances carry dates of 2017-02-17 to 2017-02-25, after the instance year they belong to, so those dates are probably entry or rollover dates rather than event dates (not verified); trades before 2024 carry the commissioner's processing time. Such dates show that the log was written on that day, not that every trade was captured. The late-dated auction rows also end the quiet window of 2016-12-26 at 2017-02-16 instead of later, so doubtful dates currently count as observation.
- **Internal consistency is weak but real evidence.** The archive has 3 pick-chain discontinuities (all in slot-token chains of the 2013 first round, one trade; none in a future-pick chain) and 49 across traded players. A missed transfer usually breaks the next recorded sender; the one thing chains cannot detect is a missed *final* transfer, which is exactly what the evidence-date check (E3) is for.

## 4. When days become VERIFIED_COMPLETE

A verification record (`docs/league_record/coverage_verifications.json`, empty today) covers one interval of one league instance and one event class, and is accepted only if **all** of this holds (`validateVerification`, refusing malformed input without throwing):

1. **Authoritative source:** an MFL export, with the request parameters, the **league id** (it differs by year before 2017) and the **instance year** recorded; the interval must lie inside that year and the next.
2. **Untruncated:** the response is shown to be whole; `COUNT` and `DAYS` (which MFL documents as restricting the result) are refused, including as a leading parameter.
3. **Captured after the interval ended**, on a real calendar date.
4. **Check E1, required, `archive_comparison`:** the export and the archive agree record for record in the interval. **E1 detects loss in the copy only.** The archive is a copy of MFL's own transaction log (the row index is the position in MFL's response), so E1 cannot detect a record MFL never logged as a trade (a commissioner edit of pick ownership, for example).
5. **Check E3, required, `end_state_reconciliation`:** a dated end-state export (the holder of every traded pick) equals the holder the chains give. It is the one check that does not come from the transaction log. **Chain continuity (E2) is accepted as supporting evidence but never sufficient**, because it is computed from the same log.
6. **Every check cites its evidence** (`ref`) and each kind appears once. **Any failed check voids the record.** The truncation and pass flags are asserted by whoever records them; the `ref` is what a reviewer follows.

A commissioner statement is provenance, not a check.

**Honest limit:** for the 2013-2025 quiet windows an end-state export as of a past date probably does not exist (an export shows the state on the capture date). Until an independent source for past dates is found, those windows cannot be verified under this model, and only intervals bracketed by a dated end state (the 2025-26 gap, with the exports in `S1_MFL_EXPORT_REQUESTS.md`) can. That is a feature of the standard, not an oversight.

## 5. How it would be used (not wired yet)

Custody of an asset between two dates (inclusive) is **observed** only if **every day** of the span lies inside valid verifications (`custodyObserved`). Consequences:

- A quiet stretch inside a verified interval does not invalidate custody.
- A quiet stretch inside an unverified interval does not prove it (as today).
- **A busy stretch does not prove it either**: a day outside any verification blocks even when it falls between two days with recorded activity (the model is stricter than today's quiet-window rule here; today's strict-custody count is already 0 of 597, so no current result differs).
- A known gap blocks even when neighbouring intervals are verified.
- A test checks that, with no verification, no custody is observed for any traded future pick and the model is never more permissive than today's rule.

## 6. How it is tested before any use

`tests/league_record_s1_archive.test.mjs`, test "the source-coverage model":

- the archive's state counts equal a separate SQL recomputation of the quiet windows (38 windows, 1,532 days, plus the 100-day gap);
- more than twenty refused verification records (unknown class, impossible or non-string dates, reversed dates, not an MFL export, truncated, `COUNT` and `DAYS` in either case or position, capture before the interval ends, a failed check, a string `"true"`, no comparison, comparison plus chain continuity only, no league id, no year, an interval outside the instance year, a check without a reference, a duplicated check, a null check, checks that are not an array, no parameters, a null record);
- a verified window with no transaction in it is VERIFIED_COMPLETE; the same window with no verification, with a record for the other event class, with a failed check, or only partly covered, is not;
- custody across the whole verified window, inclusive of both ends, is observed; **one unverified day at either end, or a day outside any quiet window, blocks**; adjacent verified intervals observe a span across their join; a known gap blocks beside verified intervals;
- the safety property over every traded future pick of 2010-2025, and all 597 unresolved future picks are still unresolved.

## 7. What would be needed to verify real intervals (for the commissioner's decision)

- **The 2025-11-28 to 2026-03-07 gap:** the read-only requests in `S1_MFL_EXPORT_REQUESTS.md` (section 2): E1 against the archive and the 2026 snapshot, and E3 with the two future-picks exports.
- **Earlier quiet windows:** see the honest limit in section 4. Verifying a past window needs a source for a past date that is independent of MFL's transaction log; none is known. The 31 unverified intervals that the pick screen in `S1_FUTURE_PICK_ASSESSMENT.md` would need (a lower bound) therefore stay unverified. This is not requested.
- Nothing is verified by the verification file alone: each record must cite a real, recorded export and passing checks.

## 8. Open points

- **Is MFL's transaction export complete for old seasons?** MFL's documentation does not promise it; E1 cannot prove a negative for a record MFL itself no longer holds. A verification therefore says "this export, captured on this date, agrees with the archive", never "no trade ever occurred".
- **Pre-2024 trade timestamps are processing times**, so an event near an interval boundary has a day of slack; the date quality travels with the event and a boundary day is never treated as certain. The model does not shrink verified spans for this.
- **Event class for commissioner-processed trades** (pre-2024) is `pick_transfer` like any other; the date quality travels with the event.
