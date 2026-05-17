# Q5 — IR 50% Cap Relief: Deferred (no eligible player)

**Status:** 🟡 Deferred — no eligible player to live-verify against.
**Tracker:** `docs/AUDIT_FOLLOWUP_TRACKERS.md` Q5 (added in PR #212).
**Canon:** `docs/league_context_v1.md` §B3 — "$20K salary → $10K cap hit while on IR."

---

## Why deferred

Per the audit follow-up batch (Keith 2026-05-16): no current UPS player is on IR, so the live-trace through the worker cap-math + client renderCaps + mobile `front_office_cap.js` cannot be exercised against real data. The §B3 rule and the worker's expected behavior are documented; the live-verification step has to wait until a player IRs.

Filing this doc so the deferral is captured in repo history. The trackers entry (`AUDIT_FOLLOWUP_TRACKERS.md` Q5) should be updated to note **"deferred — no eligible player"** at the next opportunity (e.g., piggybacked onto the next doc PR that touches the trackers file).

## Verification steps (queued for next IR event)

When a UPS player is placed on IR, run the full trace per the original tracker:

1. Note the player's salary pre-IR (`rosters` payload `salary`).
2. Capture the team's `available_cap` pre-IR.
3. Submit the IR designation (or wait for MFL ingest).
4. Capture `available_cap` post-IR.
5. Confirm the delta = exactly 50% × salary.
6. Trace which code path produced the delta:
   - `worker/src/lib/...` cap math (search for "ir" relief logic)
   - `site/team_operations/team_operations.js` `renderCaps`
   - `site/m/front_office_cap.js`
7. Cite `file:line` in `MOBILE_DRIFT_PREVENTION.md` or the audit doc.

**Done when:** one verified IR event has been traced and reported; if drift surfaces, file a fix PR.

## Tracker diff to apply once `AUDIT_FOLLOWUP_TRACKERS.md` lands on main

```diff
 ### Q5 — IR 50% cap relief live verification ⏳
+
+**Status (2026-05-16): 🟡 deferred — no eligible player.** No current UPS
+player is on IR; the live-trace through worker cap-math + client
+renderCaps + mobile front_office_cap.js cannot be exercised. See
+`docs/Q5_IR_50_PERCENT_RELIEF_DEFERRED.md` for the verification recipe
+queued for the next IR event.

 **Canon:** `docs/league_context_v1.md §B3` — "$20K salary → $10K cap hit while on IR." Live-trace deferred per Keith 2026-05-16 (no current UPS player on IR).
```
