# Trade deadline: the MFL trade lock, reconciled and monitored by the worker (runbook)

**Status: draft. Production changes, including MFL's calendar, need Keith's separate go.** Nothing here has been done on league 74598.

## The rule and the operating model (Keith 2026-10-21)
> **Trading closes at kickoff of the first NFL game in the NFL schedule week that includes Thanksgiving Day.**

- **What is stored is the rule, not a time.** For each season the worker resolves the rule to an NFL **week** from the official NFL schedule (`tradeDeadlineRule`). For 2026 that is **Week 12**, which opens with GB @ LAR on **Wed Nov 25, 8:00 PM ET** (Unix 1795654800).
  - Commish Settings no longer has a typed trade-deadline field.
  - A future season has no week, and no lock is created, until the NFL schedule establishes it.
- **The worker reconciles and monitors MFL's lock. It does not fully own MFL's calendar:** MFL's API can add an event but cannot edit or delete one.
  - The target is **exactly one** week-based "No Trades Allowed" event: `START_TIME=12`, MFL's native "start of Week 12", which MFL places and enforces at the week's first kickoff.
  - The worker **creates** that lock when none exists, and **never creates its own duplicate** (it reads first, holds a 10-minute claim, and identifies the new event).
  - It **identifies incorrect or duplicate events** and **alerts the commissioner with their event ids**.
  - **The commissioner performs every deletion** in MFL's web calendar (commissioner mode). The worker cannot repair every drift state by itself.
- **Everything else reads MFL back.** Every screen and reminder shows the time MFL actually enforces, never the intended one.
  - When MFL disagrees with the rule, the commissioner is alerted, and owners still see what MFL enforces.
- **The kickoff second (ruled).** MFL's native week-start event is used as is; there is no 7:59:59 override.
  - A trade MFL records as completed stands: MFL's completion record controls.
  - From the moment MFL refuses, every app surface shows the deadline as passed.
  - **Pending:** on fixed-time events MFL accepted inside the start second and refused from the next. The same measurement for a **week-number** lock runs on the test league at Week 7's kickoff (Thu Oct 22, 2026, 8:15:00 PM ET). Until it confirms that, the one-second detail is not written into canon.

## What MFL's API can do (test league 25625, 2026-10-21)

### Endpoints and fields
| Purpose | Request | Fields / answer |
|---|---|---|
| Read the calendar | `GET https://api.myfantasyleague.com/{YEAR}/export?TYPE=calendar&L={L}&JSON=1` (league member's cookie) | `calendar.event[]`: `id`, `type` (`TRADE` = "No Trades Allowed"), `start_time` (Unix seconds, **or a week number**: `"12"`), `end_time`, `happens`, `title` |
| Read MFL's resolved instants | `GET …/export?TYPE=ics&L={L}` (league member's cookie) | `VEVENT` → `UID:{id}@myfantasyleague.com`, `DTSTART:YYYYMMDDTHHMMSS` (UTC). Week 12 → `20261126T010000` = Wed Nov 25 8:00 PM ET |
| Create a lock | `POST https://www48.myfantasyleague.com/{YEAR}/import?TYPE=calendarEvent&L={L}&JSON=1`, form `EVENT_TYPE=TRADE&START_TIME=12` (commissioner cookie) | `<status>OK</status>`; no id is returned (read the calendar back) |
| Update a lock | **none** | `EVENT_ID` is ignored. A new event was created instead (8554895), and 8554816 was unchanged |
| Delete a lock | **none through the API** | `EVENT_ID`, `ID`, `DELETE=1`, `ACTION=DELETE` are all ignored: without `EVENT_TYPE` → "Invalid EVENT_TYPE:"; with it, a new (start-less) event is created (8554892). Deleting needs MFL's web calendar (`options?O=110`) in **commissioner mode** (`/logout?BECOME=0000`). The worker's MFL session is shared with every production read, so it does not switch modes. |

### What happened (test league records)
| Step | Calendar before → after (TRADE events) | MFL's behavior |
|---|---|---|
| Baseline | `8330110` start "13", end 2027-01-06 · `8458722` Tue Nov 24 12:00 PM · `8554815`, `8554816` (expired rehearsal locks) | — |
| Create, week-based | + `8554893` start **"12"**, no end | Accepted. MFL's calendar page: "No Trades Allowed starts at 8:00 p.m." on Wed Nov 25. ICS: Wed 8:00 PM ET. |
| Same import again | + `8554894` start "12" | **Duplicate created.** MFL never de-duplicates, so the worker reads before it writes. |
| "Update" `8554816` (with `EVENT_ID`) | + `8554895` (Oct 20, already ended) | No update; `8554816` unchanged |
| "Delete" (`EVENT_ID` + `DELETE=1`, with type) | + `8554892` with no start | No delete. A start-less TRADE event is **inert**: trading stayed open. |
| Week-6 lock, ending 150 s later | + `8554896` start "6" | **Enforced:** "Trades Are Not Allowed Now According To Your League Calendar" (Week 6 had kicked off). Trading reopened 2 s after the end. |
| Two Week-12 locks present | — | Trading open (not yet in force). Tue noon `8458722` remains the effective lock. |

**Enforcement precision** (earlier the same day, on fixed-time events):
- MFL accepted proposals inside the start second and refused from the next.
- Propose, accept, reject and revoke are all refused while a lock is in force.
- Trading reopens at the event's end, to the second.

### Capability summary
| Requirement | Result |
|---|---|
| Create a week-based lock | **Yes** (API) |
| Replace or update an existing lock | **No** (API). Replacing = create the right one and delete the wrong one in MFL's web calendar |
| Delete stale or duplicate locks | **No** (API). Commissioner, MFL web calendar. The worker lists exactly which ids |
| Preserve exactly one effective lock | **Yes, with the commissioner's deletions.** The worker never creates when a week lock exists, and alerts until only one remains |
| Rerun without adding another event | **Yes.** Worker-side read-before-write (tested: second run, 0 imports) |
| Follow a kickoff-time change | **Partly proven.** MFL stores the week, not a time, and its ICS resolves it to the current first kickoff (Weeks 6, 12, 13 all matched the schedule). Not tested: MFL re-resolving after an actual NFL schedule change. The worker compares MFL's ICS instant with the NFL schedule each run and alerts on any difference (`mfl_places_week_elsewhere`). |

**Adding the Wednesday lock alone does not fix production.** The earliest active lock is what MFL enforces: Tuesday noon stays in force until it is deleted. The tests pin this.

## The worker's reconcile-and-monitor (draft #1361)
- **`planTradeLock`** (pure, `worker/src/trade_deadline.js`) takes the rule week, MFL's calendar and MFL's ICS, and returns one of:
  - `aligned`: exactly one active week-12 lock, placed by MFL at the rule's kickoff;
  - `needs_create`;
  - `needs_commissioner_cleanup`: the ids to delete, each tagged `duplicate`, `earlier_than_rule_is_in_force` or `not_the_rule_lock`;
  - `mfl_places_week_elsewhere`;
  - `waiting_for_nfl_schedule`.

  Ended and start-less locks are ignored.
- **`reconcileTradeLock`** (`worker/src/index.js`):
  1. rule → MFL calendar + ICS (fresh) → plan;
  2. when allowed to write and no week lock exists, take a **10-minute D1 claim** (an atomic upsert; a second writer is held), then **one** import (`EVENT_TYPE=TRADE`, `START_TIME=<week>`);
  3. read back, and **identify the new event**: the calendar after minus the calendar before must be exactly one new `TRADE` event at the week. Anything else (none, two, or another event appearing) is **held for review** with the new ids listed, never guessed;
  4. DM the commissioner when not aligned. The DM lists MFL's current lock, the rule, the ids to delete and the link. It is sent once per distinct state, with a daily reminder while the state lasts (`dmCommishOncePerBatch`, one D1 heartbeat row).
- **Schedule.** Hourly, August through December, inside the hourly cron and **awaited before the deadline-reminder sweep**, so no reminder goes out before MFL is checked.
  - Flags: `TRADE_LOCK_RECONCILE_ENABLED` (check + alert) and `TRADE_LOCK_RECONCILE_WRITE` (create). **Both ship `"0"`.**
- **Cost per run:** 3 MFL reads (calendar, ICS, NFL schedule; the schedule is edge-cached an hour). D1: 0, or 1 read plus 1 write when an alert is due.
- **On demand:** `POST /admin/trade-lock/reconcile?L=&YEAR=`. It reports only, by default; `&alert=1` sends the DM.
  - **Who:** the `/admin` front door admits only the commissioner API key, or an MFL session that MFL itself proves is a commissioner franchise of the league. An owner's session gets **403** and no credential gets **401**, before any MFL call (tested).
  - **Confirmation:** `&write=1` needs WRITE=1 or `&force_write=1` **and** `&confirm=week-<N>` naming the week to lock. A bare or wrong confirmation gets 409, and nothing is written.
  - **Idempotent:** reruns read first (0 imports when the lock exists); concurrent writers are stopped by the claim.
  - Commish Settings → **Trade lock** panel: "Check MFL", and "Add the Week N lock" when none exists. It asks for a confirmation that names the week and league and warns that MFL can't undo it, then reports the created event id, or "needs review".
- **Commish Settings push** no longer plans or reports TRADE events. The stored `trade_deadline_at` (2026-11-25T20:00) is ignored and left in D1 untouched.

## Every consumer reads MFL's actual lock
| Surface | How (draft) | Shows after reconciliation |
|---|---|---|
| Discord reminders (7 d, 1 d, 1 h) | `readMflTradeLock`, MFL calendar + ICS (#1360) | "Wednesday, November 25, 2026 at 8:00 PM ET". Sent Wed 11-18 9 AM, Tue 11-24 9 AM, Wed 11-25 7 PM |
| `/api/league-events` | `ups_trade_deadline` row + `trade_lock`, and `trade_rule` + `trade_lock.matches_rule` (#1360/#1361) | date 2026-11-25, `time_et` 20:00, label |
| Phone Home (calendar, Events tile) | `/api/league-events` (#1360) | "Nov 25 · Trade Deadline · 8:00 PM ET"; "passed" from 8:00:01 PM |
| Team Operations | `/api/league-events` (#1360) | "Wed, Nov 25, 8:00 PM ET"; "passed" from 8:00:01 PM |
| MFL-page countdown widget | `/api/league-events` `trade_lock` (#1360) | counts to Wed 8:00 PM; TBD if unreadable |
| Rules → Deadlines (current season) | live `trade_lock` (#1360, `live_trade_lock`) | "Wed Nov 25, 8:00 PM ET"; "Passed: …" afterward |
| Front Office Overview card | `/api/league-events` `trade_lock` (stacked draft on #1350) | "MFL stops trades Wed, Nov 25, 8:00 PM ET" |
| Commish Settings | `/admin/trade-lock/reconcile` (#1361) | rule week, MFL's lock, status, ids to delete |

**Until production is corrected, all of these show Tue Nov 24, 12:00 PM ET,** because that is what MFL enforces.

## Production plan (league 74598): needs Keith's go

### Part A: one-time commissioner cleanup
Needed because MFL's API can't delete. Production holds three wrong absolute locks: Tue Nov 24 12:00 PM, and Wed Nov 25 8:00 PM ×2. None is week-based.

### Part B: automated reconciliation
Prevents future drift.

### Steps
0. **Before the go (read-only):**
   - Week 7 boundary result on the test league.
   - Test-league cleanup inventory.
   - **Final production inventory, read immediately before execution:** the live production lock ids, MFL's resolved time for each, and the exact deletion list. This is a read of MFL's calendar and ICS for 74598; no write.
1. Release #1360, #1361 and #1368 with **both flags off**. This is code only, and the screens still show Tue noon.
2. **Report:** Commish Settings → Trade lock → Check MFL. Expect:
   - `needs_commissioner_cleanup`;
   - `create` = `{EVENT_TYPE: TRADE, START_TIME: 12}`;
   - `remove` = the inventory's ids;
   - MFL enforces "Tue, Nov 24, 12:00 PM ET".
3. **Create the week lock:** "Add the Week 12 lock" → confirm. The result names the new MFL event id (`wrote.identified: true`). If it says "needs review", stop. MFL **still enforces Tue noon**.
4. **Commissioner cleanup** in MFL's League Calendar setup (commissioner mode, `https://www48.myfantasyleague.com/2026/options?L=74598&O=110`): delete exactly the ids in the inventory's deletion list (Tuesday noon and both absolute Wednesday 8:00 PM locks). Keep only the new week lock.
5. **Report again:** `aligned`; `lock.label` "Wed, Nov 25, 8:00 PM ET"; `/api/league-events` `trade_lock.matches_rule: true`, one event.
6. **Switches:**
   - `TRADE_LOCK_RECONCILE_ENABLED=1` turns on the hourly check and alerts.
   - `TRADE_LOCK_RECONCILE_WRITE=1` is optional: the worker would then create next season's lock once the NFL schedule exists, under the same claim and identification rules.
7. **Merge #1361's rule text** the same day.

Do all of this before Tue Nov 17, when the first reminder computed from MFL's current lock would go out. In any case, ship #1360 before Thu Nov 19: main's reminders use the wrong Thursday time.

**Verify:**
- MFL's November page shows one "No Trades Allowed starts at 8:00 p.m." on Wed 25, and nothing on Tue 24.
- The phone, Team Operations, the countdown, Rules and the Front Office all show Wed Nov 25, 8:00 PM ET.
- The next hourly log line reads `trade-lock status=aligned`.

## Rollback
| Situation | Action |
|---|---|
| Alerts misbehave | Set `TRADE_LOCK_RECONCILE_ENABLED=0` (no MFL change). |
| A wrong lock was created | Delete it in MFL's web calendar. Set `WRITE=0` while investigating. |
| Back to today's MFL state | Add "No Trades Allowed" at Tue Nov 24 12:00 PM (and Wed 8:00 PM ×2) in MFL's web calendar, and delete the week lock. Not recommended: it restores the error. |
| Code | `git revert` #1361 (the push managed TRADE before; the typed field returns) and/or #1360 (reminders go back to ESPN's Thursday, which is wrong). Re-stamp the mobile build. |

## Still unproven
- **MFL re-placing a week lock after a real NFL schedule change.** The worker detects the difference and alerts.
- **Precision at a week lock's own start.** The second-level boundary was measured on fixed-time locks, and a week lock resolves to a fixed instant. To measure it directly: put a bounded Week-7 lock on the test league and probe around Week 7's first kickoff, Thu Oct 22, 2026 8:15 PM ET.

## Test-league leftovers (25625)
MFL can't delete through the API. These are cosmetic for the test league:
- the rehearsal locks `8554815` and `8554816` (ended);
- `8554892` (start-less, inert);
- `8554895` (ended);
- `8554896` (Week 6, ended);
- the two Week-12 locks `8554893` and `8554894`.

The test league's effective lock is still `8458722` (Tue Nov 24 noon), as before. The commissioner can delete the leftovers in 25625's web calendar.

Evidence: `~/Code/MFL/outputs/trade_deadline_rehearsal_25625_2026-10-21/` on Keith's machine.
