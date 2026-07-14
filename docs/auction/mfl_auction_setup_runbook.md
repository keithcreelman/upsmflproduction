# MFL FA-Auction Setup Runbook

**What this covers:** setting up the yearly Free Agent Auction (FAA) on MFL to match
the dates posted on the website — both the **automated** path (the commish control
that pushes dates into MFL) and the **manual** fallback, plus the one-time auction
**rules** that MFL's API can't set.

**Two categories, one API-settable, one not:**
1. **Auction open & close dates** — **API-settable** via `import?TYPE=calendarEvent`
   (`AUCTION_START`, START = open, END = close). This is what the commish control
   automates.
2. **Rules** (salary cap / budget, roster max & min, contract format, auction on/off)
   — **NOT** API-settable. MFL exposes these read-only; they're a one-time
   Commissioner-Setup task, and they rarely change year to year.

---

## Part A — Auction open & close dates (automated, preferred)

**Commish Settings → 🗓️ Auction Dates → MFL.**

1. Set **Auction opens** and **Auction closes** (interpreted as **ET**, DST-handled
   automatically — enter wall-clock time).
2. **Save dates** (writes to D1 `ups_settings` key `auction_calendar` — reusable next
   year, just change the values).
3. Pick the **target league**: start with **Test league (25625)** to rehearse.
4. **Preview → MFL** — shows the exact MFL calendar event that will be written.
   Nothing is sent. Confirm the ET times look right.
5. **Push to MFL** — writes it. No key to type (commish-gated automatically); a
   confirm prompt guards the real-league write. The result table shows ✔/✗.
6. Verify on MFL: **↗ MFL calendar** button (or `options?L=<league>&O=110`).
7. Repeat step 3–6 with **Real league (74598)** once the test-league run looks right.

**Event mapping:**

| UPS date | MFL `EVENT_TYPE` | Notes |
|---|---|---|
| Auction opens (+ closes) | `AUCTION_START` | `START_TIME` = open; `END_TIME` = close (one event carries both). |

**Auth model:** *Preview* needs nothing (writes nothing). *Push* is commish-gated by
`franchise_id` (the UI passes it automatically — no key prompt).

**Endpoint (for reference / scripting):**
```
# Preview (safe, no write):
curl -X POST "https://upsmflproduction.keith-creelman.workers.dev/admin/auction/push-mfl-calendar?L=25625&YEAR=2026"

# Commit to the TEST league (commish franchise gate; APIKEY also accepted for scripts):
curl -X POST "https://upsmflproduction.keith-creelman.workers.dev/admin/auction/push-mfl-calendar?L=25625&YEAR=2026&commit=1&franchise_id=0008"

# Commit to the REAL league (only after the test run looks right):
curl -X POST "https://upsmflproduction.keith-creelman.workers.dev/admin/auction/push-mfl-calendar?L=74598&YEAR=2026&commit=1&franchise_id=0008"
```

---

## Part B — Auction dates (manual fallback)

If the API write ever fails (MFL form change, expired `MFL_COOKIE`, etc.), set it
by hand:

1. Log into MFL as the commissioner for the league.
2. **Commissioner → League Calendar** (`options?L=<league>&O=110`).
3. Add an **Auction Start** event — set its start to the auction open, and its end
   to the auction close.
4. Save. Confirm the calendar shows it.

> The automated Push does exactly this via the API; the manual path is just the same
> event entered by hand.

---

## Part C — Auction RULES (manual, one-time — NOT API-settable)

MFL does not expose an import to configure the auction's rules; do these once in
Commissioner Setup and they carry year to year:

1. **Salary cap / budget** — the $300K cap (Commissioner → Salary Cap / League Setup).
   The auction operates in **dollars** (not FAAB points).
2. **Roster limits** — max **35** during the auction, min **27** at close (per
   `docs/league_context_v1.md` §A2). Set/verify roster size limits.
3. **Auction module / format** — the eBay-style proxy auction with a **24-hour** lock
   window. This is the `O=43` auction module the app reads; it's already configured
   from prior years. Verify it's enabled and the lock window is 24h.
4. **Nominations** — 2 per 24-hour window (mandatory, escalating fines) is a UPS rule
   enforced by our worker (`/api/auction/fa-schedule` + the nightly nudge), **not** by
   MFL. Nothing to set in MFL for this.

If MFL ever adds an API for auction rules, automate Part C too; until then it's a
manual checklist.

---

## Part D — App-side switches for auction week (not MFL)

Separate from MFL, flip these in **Commish Settings → Kill Switches** when the auction
actually opens (they control our app, not MFL):

- **`AUCTION_FAA_ENABLED`** → ON when the FAA opens (last weekend of July). OFF = the
  app shows a read-only pool.
- **`AUCTION_INAPP_BID_ENABLED`** (master) must also be ON for in-app bidding. In-app
  bidding is still **Phase 1** (fragile MFL form-scrape) — dry-run a low real bid in
  the app and confirm it on MFL's `O=43` page before relying on it.
- **`AUCTION_NIGHTLY_NUDGE_ENABLED`** → ON only **after** the auction is live (off-season
  it would DM all 12 owners "you owe 2 noms"). Dry-run first:
  `POST /admin/auction/run-nightly-nudge?APIKEY=…&force=1`.

Refresh the commish-gated intel before auction week (run manually):
`build_auction_intel.py`, `build_faa_report.py --push-d1`, `build_draft_intel.py
--push-d1`, `build_roster_fit.py --push-d1`.
