# Trade deadline: the worker-owned MFL lock (runbook)

**Status: draft. Production changes, including MFL's calendar, need Keith's separate go.** Nothing here has been done on league 74598.

## The rule and the operating model (Keith 2026-10-21)
> **Trading closes at kickoff of the first NFL game in the NFL schedule week that includes Thanksgiving Day.**

- **What is stored is the rule, not a time.** For each season the worker resolves the rule to an NFL **week** from the official NFL schedule (`tradeDeadlineRule`). For 2026 that is **Week 12**, which opens with GB @ LAR on **Wed Nov 25, 8:00 PM ET** (Unix 1795654800).
  - Commish Settings no longer has a typed trade-deadline field.
  - A future season has no week, and no lock is created, until the NFL schedule establishes it.
- **The worker owns MFL's setting.** It keeps MFL's league calendar at **exactly one** week-based "No Trades Allowed" event: `START_TIME=12`, MFL's native "start of Week 12". MFL places and enforces that event at the week's first kickoff.
- **Everything else reads MFL back.** Every screen and reminder shows the time MFL actually enforces, never the intended one.
  - When MFL disagrees with the rule, the commissioner is alerted, and owners still see what MFL enforces.
- **The kickoff second (ruled).** MFL's native week-start event fires at 8:00:00 PM ET.
  - A trade MFL records as completed within that second stands: MFL's completion record controls.
  - From the moment MFL refuses (8:00:01 PM, as measured), every app surface shows the deadline as passed.
  - There is no 7:59:59 override.

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

## The worker reconciliation (draft #1361)
- **`planTradeLock`** (pure, `worker/src/trade_deadline.js`) takes the rule week, MFL's calendar and MFL's ICS, and returns one of:
  - `aligned`: exactly one active week-12 lock, placed by MFL at the rule's kickoff;
  - `needs_create`;
  - `needs_commissioner_cleanup`: the ids to delete, each tagged `duplicate`, `earlier_than_rule_is_in_force` or `not_the_rule_lock`;
  - `mfl_places_week_elsewhere`;
  - `waiting_for_nfl_schedule`.

  Ended and start-less locks are ignored.
- **`reconcileTradeLock`** (`worker/src/index.js`):
  1. rule → MFL calendar + ICS (fresh) → plan;
  2. when allowed to write and no week lock exists, **one** import (`EVENT_TYPE=TRADE`, `START_TIME=<week>`);
  3. read back;
  4. DM the commissioner when not aligned. The DM lists MFL's current lock, the rule, the ids to delete and the link. It is sent once per distinct state, with a daily reminder while the state lasts (`dmCommishOncePerBatch`, one D1 heartbeat row).
- **Schedule.** Hourly, August through December, inside the hourly cron and **awaited before the deadline-reminder sweep**, so no reminder goes out before MFL is checked.
  - Flags: `TRADE_LOCK_RECONCILE_ENABLED` (check + alert) and `TRADE_LOCK_RECONCILE_WRITE` (create). **Both ship `"0"`.**
- **Cost per run:** 3 MFL reads (calendar, ICS, NFL schedule; the schedule is edge-cached an hour). D1: 0, or 1 read plus 1 write when an alert is due.
- **On demand:** `POST /admin/trade-lock/reconcile?L=&YEAR=`. It reports only, by default. `&write=1` is refused unless WRITE=1 or `&force_write=1`. `&alert=1` sends the DM.
  - Commish Settings → **Trade lock (worker-owned)** panel: "Check MFL", and "Add the Week N lock" when none exists.
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
0. Release #1360, #1361 and the Front Office card PR with **both flags off**. This is code only, and the screens still show Tue noon.
1. **Report (read-only):** Commish Settings → Trade lock → Check MFL (or `POST /admin/trade-lock/reconcile?L=74598&YEAR=2026`). Expect:
   - `needs_commissioner_cleanup`;
   - `create` = `{EVENT_TYPE: TRADE, START_TIME: 12}`;
   - `remove` = the three current ids;
   - MFL enforces "Tue, Nov 24, 12:00 PM ET".
2. **Create the week lock:** Commish Settings → "Add the Week 12 lock" (one import). The report now shows `keep` = the new id, Week 12, Wed 8:00 PM ET. MFL **still enforces Tue noon**.
3. **Commissioner cleanup:** in MFL's League Calendar setup (commissioner mode, `https://www48.myfantasyleague.com/2026/options?L=74598&O=110`), delete **the Tuesday noon lock and both absolute Wednesday 8:00 PM locks**. Keep only the new week-based one. MFL's page shows it as Wed 8:00 p.m. Use the exact ids from step 1.
   - If you would rather keep the old Wednesday event than the week-based one, the worker reports `needs_commissioner_cleanup` until it is week-based. That is by design.
4. **Report again:**
   - status `aligned`;
   - `lock.label` "Wed, Nov 25, 8:00 PM ET";
   - `/api/league-events` `trade_lock.matches_rule: true`, one event.
5. **Turn on** `TRADE_LOCK_RECONCILE_ENABLED=1` (hourly check + alerts). Recommended: `TRADE_LOCK_RECONCILE_WRITE=1`, so next season's lock is created automatically once the NFL schedule exists.
6. **Merge #1361's rule text** the same day.

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
