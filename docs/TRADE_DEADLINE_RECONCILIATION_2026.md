# 2026 trade deadline: reconciliation runbook

**Status: draft. Production MFL calendar changes need Keith's separate go.** Nothing here has been done on league 74598.

**Rule (Keith 2026-10-21):** "Trading closes at kickoff of the first NFL game on Thanksgiving Day (2026: Thu Nov 26, 1:00 PM ET)."
- That is CHI @ DET, MFL Week 12, at Unix **1795716000**.
- Week 12 itself opens Wed Nov 25 at 8:00 PM ET (GB @ LAR). That game is not the deadline.

**Today (read 2026-10-21, MFL's public League Calendar):** league 74598 has three "No Trades Allowed" (`TRADE`) events:
- Tue Nov 24, 12:00 PM ET
- Wed Nov 25, 8:00 PM ET
- Wed Nov 25, 8:00 PM ET (a duplicate)

MFL enforces the earliest one, so trading stops **Tue Nov 24 at 12:00 PM ET**. Until production is reconciled, every owner-facing deadline states that time (PR "every owner-facing deadline states when MFL actually stops accepting trades").

## What MFL does: test league 25625, 2026-10-21

This was run through the API with the commissioner session, on the test league only:
- The account used was the commissioner, acting as its own team 0008 (owner path) and through `FRANCHISE_ID` (lockout is off on 25625).
- One `TRADE` event was added through `import?TYPE=calendarEvent`, the same shape the Commish Settings push sends, with `START_TIME` on the minute.
- A second short event was then used to pin the boundary to the second.
- Times below are on MFL's own clock (its HTTP `Date` header).

| When, vs the event start T | Action | MFL's answer |
|---|---|---|
| T−45 s | propose | OK |
| T−20 s | accept (the trade executed) | OK |
| T−6 s | propose | OK |
| inside second T (4 proposals sent −1.0 s … +0.4 s, all stamped T) | propose | **OK** |
| T+1 s | propose | **Refused:** "Trades Are Not Allowed Now According To Your League Calendar" |
| T+5 s, T+9 s | accept (commissioner path, and the owner's own path) | Refused, same text |
| T+13 s | propose (owner path) | Refused |
| T+17 s, T+102 s, T+104 s | revoke (by the offerer), reject (by the recipient) | Refused |
| T+60 s, T+1 s of the second event | propose | Refused |
| end−2 s | propose | Refused |
| end+1 s | propose | **OK**: trading reopens at the event's end |

Findings:
- **Precision: one second.** MFL accepts inside the start second and refuses from the next one. For the 2026 rule: a trade at 1:00:00 PM ET goes through, and one at 1:00:01 PM is refused.
- **Everything stops, both ways.** Proposing, accepting, rejecting and revoking are all refused through the API. MFL's own trade page shows only "No, I'd like to reject this trade completely", with "Potentially Invalid Trade: Trades are not allowed now". Submitting that page's reject was not tried.
- **Pending offers stay listed** after the cutoff. They can't be acted on and expire on MFL's normal 7-day clock (`defaultTradeExpirationDays` = 7).
- **One event is enough.** During each run the event added was the only `TRADE` event in force, and it alone blocked trading.
  - 25625 also holds a Week-13 event (`START_TIME` "13") and a Tue Nov 24 noon event. Both start later, so they were not in force.
- **A small `START_TIME` is an NFL week.** "13" shows on MFL's calendar as "No Trades Allowed starts at 8:15 p.m." on Thu Dec 3, Week 13's first kickoff. `worker/src/trade_deadline.js` places such events there, and fails closed if that week's kickoff can't be read.
- **Restored.** Every rehearsal offer was revoked and the one executed trade was reversed. Rosters, contracts, draft picks, league settings and pending trades match the pre-run snapshot.
  - MFL's API cannot delete calendar events, so the two expired test events (8554815, 8554816) remain on 25625's calendar.
  - MFL's transaction log shows the test trade and its reversal.
  - Evidence (45 records): `~/Code/MFL/outputs/trade_deadline_rehearsal_25625_2026-10-21/` on Keith's machine.

## Production execution checklist (league 74598): needs Keith's go

Do it well before Tue Nov 24 noon. It takes about 10 minutes. Every write is the commissioner's own action on MFL or in Commish Settings.

0. **Order.** The owner-facing PR (MFL-following deadlines) can ship first or alone: it is correct before and after. This PR (rule wording) ships **with** steps 3–5, never before.
1. **Read-only check (anyone):** MFL League Calendar, November 2026 (`https://www48.myfantasyleague.com/2026/options?L=74598&O=123&MONTH=10`) shows exactly the three events above. Note anything different and stop.
2. **Snapshot:**
   - Screenshot the Commish Settings calendar.
   - Read `/api/league-events?season=2026&from=all`, then `trade_lock` and the `ups_trade_deadline` row.
3. **Commish Settings → Update League Calendar → Trade deadline = `2026-11-26 13:00`** (Eastern). Save. This writes one D1 row: `ups_settings` `auction_calendar`.
4. **MFL → Commissioner → Setup → League Calendar** (`https://www48.myfantasyleague.com/2026/options?L=74598&O=110`, in commissioner mode): **delete all three "No Trades Allowed" events.** MFL then has no trade lock until step 5. That is harmless in October and November, before the 24th.
5. **Commish Settings → Push to MFL:**
   - Run the **dry run** first. Expected:
     - exactly one new event: `TRADE` with `START_TIME=1795716000`;
     - every other managed event (`DRAFT_START`, `AUCTION_START`, `WAIVER_NONE`) shows `already_exists: true`;
     - `stale` is empty.
     If anything else is marked new, stop: the push is add-only and would duplicate it.
   - Then **Push** (commit). It writes one MFL calendar event and upserts the D1 `league_events` rows (`ups_trade_deadline` → 2026-11-26).
6. **Merge the rule-wording PR.** The rulebook workflow regenerates the Rules data and Pages deploys it. Mobile build `2026.10.21.2`: re-stamp if main has moved.

**Verify:**
- MFL calendar for November shows **one** "No Trades Allowed starts at 1:00 p.m." on **Thu 26**, and nothing on Tue 24 or Wed 25.
- `/api/league-events?season=2026&from=all` → `trade_lock.label` = "Thu, Nov 26, 1:00 PM ET", `state` "upcoming", **one** event (allow up to 5 minutes for the isolate memo).
- The next hourly reminder sweep logs `trade_deadline_resolution` 2026-11-26 13:00. The reminders then go out:
  - Thu 11-19 9:05 AM ("in 1 Week")
  - Wed 11-25 9:05 AM ("in 24 Hours")
  - Thu 11-26 12:05 PM ("in 1 Hour", with "Happy Thanksgiving.")
- Owner-facing surfaces show Thu Nov 26, 1:00 PM ET:
  - phone Home calendar;
  - Team Operations;
  - the MFL-page countdown;
  - Front Office Overview (when released);
  - Rules → Trades and the 2026 calendar.

## Rollback

| Step undone | How |
|---|---|
| 5 (event pushed at the wrong time) | Delete it in MFL's League Calendar (`O=110`), fix the Commish Settings value, and push again. MFL's API cannot delete events. |
| 4 (events deleted, push failed) | Push again. Or add "No Trades Allowed" in MFL's web calendar at Thu Nov 26 1:00 PM. Either is urgent only before Nov 24. |
| Back to today's state | Commish Settings = `2026-11-25 20:00` and push. Add Tue Nov 24 12:00 PM in MFL's web calendar if Keith wants that back. Not recommended. |
| 6 (rule wording) | `git revert` the PR, then re-stamp the mobile build. |
| Owner-facing PR | Not needed after the MFL change, because it follows MFL either way. To undo it, `git revert`: reminders go back to ESPN's Thursday 1:00 PM, and Home and Team Operations go back to the typed date. |

## Limits
- MFL's event is a fixed instant. If the NFL moves the Thanksgiving opener, the event must be moved by hand.
- The deadline is enforced by MFL alone. The War Room has no deadline gate of its own. Its offers fail with MFL's text above.
