# FA Auction 2026 — Commish Runbook

**Open: Sat Jul 25, 12:00 PM ET · Last day to nominate: Tue Aug 3 (unlimited that day) · Resolves: ~Wed Aug 5 · Roster lock: Jul 23 → Aug 5**

---

## Page 1 — How the machine works + the timeline

### Architecture (who owns what)

**MFL's native auction (O=43, "email" kind) is the source of truth.** Lots, clocks, and awards all happen ON MFL. Our stack wraps it:

1. **Nominate/Bid (in-app)** → `POST /api/auction/nominate|bid` → the worker POSTs into MFL's O=43 form **as the owner** (their `MFL_USER_ID` cookie). MFL creates the lot / registers the bid and enforces increments. Our worker never creates lots.
2. **The `*/5` poll** (Cloudflare cron, recovered since the 7/15 outage; launchd backup on the Mac is harmless redundancy) ingests MFL's `AUCTION_INIT/BID/WON` transactions → D1 `ups_auction_lots`/`ups_auction_bids`, and drives all Discord narration.
3. **Clocks:** a lot closes **24h after the last lead change** — MFL's own "Time Left" is authoritative; the app board overlays it live (D1's computed lock is fallback only). Countdowns tick against the viewer's browser clock (cosmetic drift possible; MFL enforces truth).
4. **Wins → contracts:** `finalizeFaaContracts` writes each won lot to MFL salaries as **1 yr `Vet-FAA` @ the winning bid** (`CL 1|TCV|AAV`), ERA-pool excluded, verified against MFL's completed-auction list (fail-closed), MYAC-conversion-safe, audited in D1.
5. **Quota (§A2):** exactly **2 nominations per ET calendar day** — floor AND ceiling. Floor waived once a roster is legal; misses fine $3K → $7K → $15K (1st/2nd/3rd offense, this season + next). **NEW (this PR): on Tue 8/3 the ceiling is waived (nominate as many as needed); from 8/4 nominations are closed while bidding on open lots continues.**

### Timeline — one line per date

| Date | What happens | Enforced by |
|---|---|---|
| **Wed 7/22** | Last day for cuts | App calendar chip; honor system + commish |
| **Thu 7/23 12:00 AM** | Roster lock — no add/drops until auction ends | MFL `WAIVER_NONE` (push after test wraps) |
| **Sat 7/25 12:00 PM** | **Auction opens** | YOU open MFL's auction + flags (Page 2) |
| Daily 7/25→8/2 | 2 noms per team per ET day; 9 AM + 9 PM reports; fines close each day at the 9 AM report | Worker + cron |
| **Tue 8/3** | LAST nomination day — quota ceiling waived (unlimited) | Worker (this PR) |
| **Wed 8/4+** | No new noms; open lots run out their 24h clocks (outbid → you may re-bid) | Worker blocks noms; MFL runs lots |
| **~Wed 8/5** | All lots resolved → run the finalize sweep; lift roster lock | You (Page 2 close-out) |

**Special rules with NO automated enforcement (manual, yours):** once an owner makes a drop (post-8/5, lots still open) they may not bid/nominate again; exception for mid-auction retirement cuts **only if the "Amari Cooper Rule" passes — put it to a vote THIS WEEK** (multi-rule proposal system is live).

---

## Page 2 — Your checklist

### This week (after your 7/13 test wraps — say the word)
1. **Purge test residue** (D1-only; MFL rosters verified clean): the 18 July "won" lots (Burrow 16K, Lamar 17K…), test bids, nomination-day ledger + pre-voided fines, `faa_report:*` dedupe keys. I stage the SQL, you approve, I run it.
2. **Enter real dates** in Commish Settings → Update League Calendar (new fields ship with this PR): Roster lock `7/23 12:00 AM` · Opens `7/25 12:00 PM` · Last day to nominate `8/3 11:59 PM` · Ends `8/5 11:59 PM`.
3. **Push the calendar**: dry-run → review → commit (writes MFL + app calendar in one shot).
4. **MFL manual cleanup** (calendar page, O=110 — API cannot delete): remove stale `AUCTION_START 7/13→8/1`, `WAIVER_NONE 8/8→8/19`, `WAIVER_NONE 1/4`.
5. **Rule vote**: publish the Amari Cooper Rule (+ any others) via Rule Proposals so it's decided before Saturday.
6. **Verify MFL auction module** is configured and ready to open (budget already $300K ✓). Check whether MFL's `AUCTION_START` calendar event auto-opens bidding — if O=43 shows no biddable form by Friday, plan to open it manually at noon Saturday.

### Saturday 7/25, before noon
| Step | How |
|---|---|
| 1. Open MFL's auction | MFL commish setup → auction live so O=43 serves the bid form. **Nothing in our stack does this.** Owners get *"auction may not be open right now"* until it's done. |
| 2. Flip three switches (Kill Switches tab) | `AUCTION_NIGHTLY_NUDGE_ENABLED=1` (9/9 reports) · `AUCTION_FAA_PENALTIES_ENABLED=1` (**fines armed — your call confirmed**) · `AUCTION_FAA_FINALIZE_ENABLED=1` (wins auto-write Vet-FAA contracts) |
| 3. Smoke test ~12:05 | Nominate one real player in-app. Within ≤5 min (one poll tick): lot on O=43 ✓ · Discord hype thread ✓ · board countdown ✓. |

### Daily during (mostly nothing)
- 9 AM report closes yesterday (names misses, books fines), 9 PM warns today. Reports double-covered (CF cron + launchd) with a per-day dedupe — one post, guaranteed.
- A 3rd-nom attempt via MFL's native page (bypassing the app) → you get a **private DM** from the over-cap detector; unwind it manually if needed.
- Fines void UI exists if you need to excuse a miss.

### Close-out (~8/5, all lots resolved)
1. `POST /admin/auction/finalize-faa-contracts?...&dry_run=1` → review → re-run without `dry_run`. **Required even with the flag on** — the auto-hook only catches wins while it's live; any backlog needs this sweep.
2. Spot-check 2-3 contracts on MFL (salary = bid, `Vet-FAA`, 1 yr) + D1 audit table.
3. Lift the roster lock on MFL when you declare the auction done; announce reopening of add/drops.

---

## Page 3 — Discord map + break-glass

### What posts where (channel: `DISCORD_AUCTION_CHANNEL_ID`, falls back to the transactions channel; test mode → test channel)

| Post | When | Gated by |
|---|---|---|
| Nomination announcement + per-lot hype thread | Poll tick after `AUCTION_INIT` | narrator on (default) |
| Bid narration (overtakes, forced increases; GIFs) | Poll tick after `AUCTION_BID` | narrator |
| Win announcement (into the lot's thread) | Poll tick after `AUCTION_WON` | narrator |
| Morning report (9 AM): yesterday's verdict + fines, today so far, won/open lots, roster needs | cron | NUDGE + FAA flags |
| Evening report (9 PM): compliance countdown warning | cron | NUDGE + FAA flags |
| Over-cap (3rd nom) alert | Poll detection | → **private commish DM** |
| Finalize | — | silent (no Discord post) |

### Break-glass

| Symptom | Do this |
|---|---|
| Board stale / no narration ≥15 min | `POST /admin/auction/poll-now?APIKEY=…&L=74598&YEAR=2026` (idempotent lifeline). Check `ups_bot_heartbeat.auction_poll` age. Launchd backup keeps polling if CF cron dies again. |
| Owner: "auction may not be open" (409 `auction_not_live`) | MFL's O=43 has no bid form — MFL-side auction not open. |
| Owner: "session expired" (401 `auction_auth_required`) | They re-log into MFL; or they bid on MFL's native page directly. |
| Owner blocked nominating (409) | `nomination_quota_reached` = used 2 today (correct thru 8/2) · `nominations_closed` = after 8/3 (correct) · on 8/3 they should NEVER see the quota error (unlimited — if they do, that's a bug, ping me). |
| MFL rejected a bid (`auction_post_failed`) | Message includes MFL's own reason (usually increment/funds). Native O=43 link is the fallback path — it always works. |
| Wrong fine booked | Fines void UI (commish settings) — void with reason; ladder ignores voided rows. |
| Nuclear | Kill Switches: `AUCTION_FAA_ENABLED=0` hides boards + blocks in-app actions (MFL native auction keeps running — pause that on MFL if truly needed). |

**Known soft edges (accepted):** countdowns use the viewer's clock (MFL enforces truth) · in-app actions without an `MFL_USER_ID` would fall back to YOUR cookie (site pages always inject it; don't share bare API URLs with owners) · finalize posts nothing to Discord (announce manually if you want fanfare).
