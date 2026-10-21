# 2026 trade deadline: reconciliation runbook

**Status: draft. The production MFL calendar change needs Keith's separate go.** Nothing here has been done on league 74598.

## The rule (Keith 2026-10-21, revised the same day)
> **Trading closes at kickoff of the first NFL game in the NFL schedule week that includes Thanksgiving Day.**

- "NFL schedule week" is deliberate. The deadline follows that week's first game on whatever day the NFL puts it: Wednesday, Thursday or another day.
- **2026:** Green Bay at the Los Angeles Rams, **Wed Nov 25, 8:00 PM ET**, Unix **1795654800**. It begins NFL Week 12, the week that includes Thanksgiving (Thu Nov 26).
  - Source: MFL's NFL schedule export, read 2026-10-21.
  - Thanksgiving Day's first game (CHI @ DET, Thu 1:00 PM) is **not** the deadline.
- **Future seasons fail closed.** The time comes only from the official NFL schedule (`worker/src/trade_deadline.js` `tradeDeadlineRule`). Until that schedule is published and establishes the week's first kickoff, there is no deadline time. The 2027 schedule is not published yet.
  - The Commish Settings push **holds** a `TRADE` event that doesn't match the rule's instant, or whose rule can't be established yet. `&allow_off_rule=1` is the commissioner's explicit override.

## Production today (read-only checks, 2026-10-21)
| Source | Value | vs the rule |
|---|---|---|
| MFL League Calendar (public page, November) | "No Trades Allowed" at **Tue Nov 24 12:00 PM**, **Wed Nov 25 8:00 PM**, **Wed Nov 25 8:00 PM** | Tue is wrong (early); one Wed event is a duplicate |
| What MFL enforces | the earliest one: **Tue Nov 24, 12:00 PM ET** | 32 hours early |
| Commish Settings `trade_deadline_at` (D1 `ups_settings`, saved 2026-08-06) | **`2026-11-25T20:00`** | **already the rule; keep it** |
| D1 `league_events` `ups_trade_deadline` | `2026-11-25` | correct date |
| Reminders on main (ESPN's Thanksgiving Day scoreboard) | Thu Nov 26 1:00 PM | **wrong under every reading. Main keeps saying this even after MFL is fixed, so #1360 must ship before Thu Nov 19** |

D1 cost of the checks: 2 rows read, 0 written.

**Until production is corrected, every owner-facing deadline shows MFL's actual lock, Tue Nov 24 12:00 PM ET** (#1360, which reads MFL's calendar).

## What MFL does: test league 25625, 2026-10-21

This was run through the API with the commissioner session, on the test league only. It added one `TRADE` event through `import?TYPE=calendarEvent`, the same shape the Commish Settings push sends. Times are on MFL's own clock (its HTTP `Date` header).

| When, vs the event start T | Action | MFL's answer |
|---|---|---|
| T−45 s, T−6 s | propose | OK |
| T−20 s | accept (the trade executed) | OK |
| **inside second T** (4 proposals sent −1.0 s … +0.4 s, all stamped T) | propose | **OK** |
| **T+1 s** | propose | **Refused:** "Trades Are Not Allowed Now According To Your League Calendar" |
| T+5 s, T+9 s | accept (commissioner path, and the owner's own path) | Refused |
| T+13 s, T+60 s | propose | Refused |
| T+17 s, T+102 s, T+104 s | revoke (by the offerer), reject (by the recipient) | Refused |
| end−2 s | propose | Refused |
| end+1 s | propose | **OK**: trading reopens at the event's end |

Findings:
- **One event is enough.** During each run the event added was the only `TRADE` event in force, and it alone blocked trading.
- **Everything stops, both ways.** MFL's own trade page offered only "reject completely". Submitting that page was not tried.
- **Pending offers stay listed but frozen.** They expire on the 7-day default.
- **A small `START_TIME` is an NFL week.** "13" shows at Week 13's first kickoff. The resolver handles it.
- **Restored.** Rosters, contracts, picks, settings and pending trades match the snapshot.
  - Two expired test events (8554815, 8554816) remain on 25625's calendar, because the API can't delete them.
  - The transaction log shows the test trade and its reversal.
  - Evidence: `~/Code/MFL/outputs/trade_deadline_rehearsal_25625_2026-10-21/` (Keith's machine).

## Decision needed: the kickoff second
**What MFL does:** with the event at 8:00:00 PM, a trade MFL processes at **8:00:00.x PM** still goes through, and from **8:00:01 PM** it is refused. The rule says trading "closes at kickoff".

| Option | MFL event | Effect |
|---|---|---|
| **A. Event at kickoff (8:00:00 PM); canon says MFL's clock decides** | 1795654800, the event production already has | One instant everywhere: canon, MFL's calendar, every screen and reminder say 8:00 PM. MFL keeps a 1-second grace that no owner can target (the scheduled kickoff is earlier than the actual snap). Needs only deletions on MFL. |
| B. Event one second early (7:59:59 PM) | 1795654799 | MFL refuses everything from 8:00:00, so the rule holds literally. But MFL's calendar and every reader then show **7:59 PM**. Commish Settings can't enter seconds, so the event must be pushed by API with `allow_off_rule=1`, and the Wed event already on MFL must be deleted too. |
| C. Event at kickoff, canon silent | 1795654800 | Same as A, but the grace second is undocumented. |

**Recommendation: A.**
- Keep the event at 8:00:00 PM.
- Add one sentence to canon: *"MFL's clock decides: a trade MFL completes within the kickoff's starting second (8:00:00 PM ET) stands; from 8:00:01 PM MFL refuses all trade actions."*
- Not written into canon yet: it waits for Keith's ruling.

## Final proposed MFL calendar (league 74598)
**Exactly one** "No Trades Allowed" (`TRADE`) event: **Wed Nov 25, 2026, 8:00 PM ET** (Unix 1795654800, no end).
- No `TRADE` event on Tue Nov 24.
- No duplicate.
- Under option B, the one event is at 7:59:59 PM instead.

## Reminder schedule (sent by the hourly sweep at :05)
| | 7 days | 24 hours | 1 hour |
|---|---|---|---|
| **Now, #1360 released before the MFL fix** (MFL: Tue noon) | Tue 11-17 9:00 AM | Mon 11-23 9:00 AM | Tue 11-24 11:00 AM |
| **After the MFL fix** (Wed 8:00 PM), pinned by test | **Wed 11-18 9:00 AM** | **Tue 11-24 9:00 AM** | **Wed 11-25 7:00 PM** |
| Main today, without #1360 (ESPN Thursday): wrong | Thu 11-19 9:00 AM | Wed 11-25 9:00 AM | Thu 11-26 12:00 PM |

Reminder text after the fix: **"Wednesday, November 25, 2026 at 8:00 PM ET"**, plus "MFL stops accepting trades at this time. Finish your deals before then." No "Happy Thanksgiving" line: that is only added when the deadline falls on Thanksgiving Day.

## Owner-facing text after the fix
**Read from MFL** (#1360; today these say Tue Nov 24, 12:00 PM ET):
- Discord reminders, as above.
- Phone Home → Events: **Nov 25 · "Trade Deadline · 8:00 PM ET"**; Events tile "Trade Deadline in Nd, 8:00 PM ET".
- Team Operations: **"Wed, Nov 25, 8:00 PM ET"**.
- MFL-page countdown: "Trade Deadline · When MFL stops accepting trades", counting to Wed 8:00 PM.
- Front Office Overview card (draft #1345): **"MFL stops trades Wed, Nov 25, 8:00 PM ET"**.

**Static text, from #1361:**
- Rules → Trades: "Trading closes at kickoff of the first NFL game in the NFL schedule week that includes Thanksgiving Day (2026: Wed Nov 25, 8:00 PM ET…)".
- 2026 calendar: "Wed Nov 25 · Trade deadline · Trading closes at kickoff of the first game of Thanksgiving week (Week 12), 8:00 PM ET: Green Bay at the Rams."
- Numbers: "Trade deadline: Wed Nov 25, 8 PM ET".

## Production execution checklist (league 74598): needs Keith's go
Do this before Tue Nov 24 noon, ideally before Tue Nov 17 when the first reminder computed from MFL goes out. It takes about 5 minutes. **No Commish Settings change and no push are needed.**

0. **Order.**
   - #1360 ships first, or on the same day. It is correct before and after the fix, and it is the only thing that corrects main's Thursday reminders.
   - #1361 merges the same day as steps 2–3, never before.
   - Keith rules on the kickoff second (A, B or C). Under B, add step 3b.
1. **Read-only check:**
   - MFL League Calendar, November (`https://www48.myfantasyleague.com/2026/options?L=74598&O=123&MONTH=10`) shows exactly Tue 24 12:00 p.m., Wed 25 8:00 p.m., Wed 25 8:00 p.m.
   - Commish Settings shows Trade deadline `2026-11-25 20:00`.
   - If anything differs, stop.
2. **MFL → Commissioner → Setup → League Calendar** (`https://www48.myfantasyleague.com/2026/options?L=74598&O=110`, in commissioner mode):
   - **delete the Tue Nov 24 12:00 PM "No Trades Allowed" event;**
   - **delete one of the two Wed Nov 25 8:00 PM "No Trades Allowed" events.** Leave the other one untouched.
3. **Dry run** (Commish Settings → Update League Calendar → dry run; writes nothing). Expected:
   - the `TRADE` row shows `already_exists: true` and `matches_rule: true`;
   - `trade_rule.label` is "Wed, Nov 25, 8:00 PM ET";
   - `stale` lists no `TRADE` event.
   - Do **not** push: nothing is missing.
   - 3b (option B only): instead, delete the remaining Wed event and push one `TRADE` at 1795654799 with `allow_off_rule=1`.
4. **Merge #1361** (with the canon sentence, under option A). The rulebook workflow regenerates the Rules data and Pages deploys it. Mobile build `2026.10.21.2`: re-stamp if main has moved.

**Verify:**
- MFL's November calendar shows **one** "No Trades Allowed starts at 8:00 p.m." on **Wed 25**, and nothing on Tue 24.
- `/api/league-events?season=2026&from=all` (allow 5 minutes) shows:
  - `trade_lock.label` "Wed, Nov 25, 8:00 PM ET";
  - `trade_lock.events` with exactly one entry;
  - `trade_lock.matches_rule: true`;
  - `trade_rule.nfl_week` 12.
- The next hourly reminder sweep logs `trade_deadline_resolution` 2026-11-25 20:00.
- The phone Home calendar, Team Operations, the countdown and Rules show Wed Nov 25, 8:00 PM ET.

## Rollback
| What went wrong | How to fix |
|---|---|
| Both Wed events deleted (no lock left) | Commish Settings → push. The `TRADE` row now shows `already_exists: false`, `matches_rule: true`, and it is pushed at 1795654800. Or add "No Trades Allowed" in MFL's web calendar at Wed Nov 25 8:00 PM. Urgent only before Nov 25. |
| The Tue event wasn't deleted | MFL keeps enforcing Tue noon, and #1360's screens keep saying so. Delete it. |
| Undo everything (back to today) | Re-add "No Trades Allowed" at Tue Nov 24 12:00 PM and a second Wed 8:00 PM event in MFL's web calendar. Not recommended: it restores the error. |
| #1361 | `git revert`, then re-stamp the mobile build. The Rules page goes back to #1360's interim text (Tue noon), which is wrong once MFL says Wed, so fix forward instead where possible. |
| #1360 | `git revert`: reminders go back to ESPN's Thursday 1:00 PM (wrong), and Home and Team Operations go back to the typed date. |
| A future season's push is held | Expected until the NFL schedule is published. Then re-run the dry run. Override only with `allow_off_rule=1`, deliberately. |

## Limits
- MFL's event is a fixed instant. If the NFL moves Week 12's opener, the event must be moved by hand. The dry run's `matches_rule` and `/api/league-events` `trade_lock.matches_rule` turn false when that happens.
- The deadline is enforced by MFL alone. The War Room has no gate of its own; its offers fail with MFL's text above.
