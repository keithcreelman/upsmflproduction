# MFL League Settings Automation — Planning Doc

**Created:** 2026-05-20
**Status:** FUTURE — not yet built
**Trigger:** Keith 2026-05-20 — flipped "Available Auction Funds Are Reduced By"
to "Current open auction bids only" before nominations went live; wondered if
a scheduled agent could handle these toggles automatically.

## The use case

UPS league has ~20 MFL settings that need to flip on/off at specific points in
the season calendar. Today this is manual — Keith logs in, navigates to each
form, makes the change, clicks Save. Some examples:

- "Available Auction Funds Are Reduced By" — toggles between "Current open
  bids only" (auction phase) and "All current bids + reserved roster spots"
  (post-auction)
- Trade processing window — open / closed
- Waiver wire run cadence — daily / weekly / off
- Salary cap type — soft / hard
- Lineup submission deadline — different days/times by phase
- ERA forced-retention window — open through FA Auction close
- Cut-then-rebid prohibition deadline — pinned to FA_Auction_Cut_Deadline
- Roster Lock Date — 3 days pre-auction (legacy) → "no cuts during auction"

## Two paths

### Path A — Scheduled worker-side toggling (full automation)

**Mechanic:** worker hits MFL's commish form URLs via authenticated POST
using `MFL_COOKIE`. Form-payload reverse-engineered per setting once,
then the toggle is a one-line worker call.

**Pros:**
- Zero-touch for Keith on routine seasonal flips
- Auditable — every toggle logged to D1 with timestamp + before/after
- Reversible — worker can store the "previous" payload and roll back

**Cons / risks:**
- MFL doesn't publish a settings API; we reverse-engineer form posts
- Form payloads change between MFL versions (rare but happens)
- A bug in payload construction could brick a setting silently
- Commish cookie rotation breaks every scheduled toggle until re-set
- Cross-checking that "the toggle actually took effect" requires fetching
  the form post-change and parsing — error-prone

**Implementation outline:**
- One generic worker endpoint `POST /admin/mfl/league-setting`
  - Body: `{ setting_id, value, dry_run }`
- D1 table `ups_league_setting_audit(id, season, setting_id, old_value,
  new_value, applied_at_unix, applied_by, dry_run)`
- Per-setting handler module: form URL + field name + valid-values
- Cron schedule via Cloudflare cron triggers OR our existing
  `scripts/scheduler` launchd setup

**Effort:** Medium. One-time payload mapping (~1 day for 20 settings),
then ~1 day per new setting to add.

### Path B — Documented checklist (manual reminders, no automation)

**Mechanic:** seasonal-calendar doc lists every setting toggle Keith should
make + when. Optional Discord reminder via existing
`sendDiscordDeadlineReminder` pipeline.

**Pros:**
- Zero MFL-API risk; Keith stays in MFL's commish UI
- No cookie/form-payload dependencies to maintain
- Doc itself is useful even with Path A (knowing what TO toggle)

**Cons:**
- Still manual
- Easy to forget mid-season (Keith's original concern)

**Implementation outline:**
- New doc `docs/league_calendar.md` (or extend `docs/league_context_v1.md`
  with §H "Settings Schedule")
- Per-row: setting name + MFL form URL + when it should change + value
- Optional: add to `scripts/scheduler` to fire a Discord reminder N hours
  before each flip date

**Effort:** Small. ~2 hours to inventory + write up.

## Recommendation

Do **Path B first** (the documentation), then **Path A incrementally** once
the doc is solid. The doc itself is required input for the automation
anyway, and shipping the doc gives Keith immediate value while the
automation gets scoped.

## Settings inventory (TO POPULATE)

This section is empty until we do the walk-through. Format per row:

```
### "Available Auction Funds Are Reduced By"
- MFL form: https://www48.myfantasyleague.com/2026/options?L=74598&O=12  (TBD)
- Field name: AVAILABLE_FUNDS_REDUCED_BY  (TBD)
- Values: "open_bids_only" | "all_bids_and_reservations"
- When to flip:
    - PRE-AUCTION: "all_bids_and_reservations"
    - AUCTION OPEN: "open_bids_only"
    - POST-AUCTION: "all_bids_and_reservations"
- Reason: Keith 2026-05-20 — no cap during auction means we don't need
  the reservation math complicating live bidding.
```

(Keith to populate; or we run a one-time crawl of all MFL commish forms
via `MFL_COOKIE` and stub each one.)

## Open questions for Keith

1. Path A vs Path B priority? (Recommendation: B first, A incrementally.)
2. Which settings are "must automate" vs "doc-only is fine"?
3. Comfort level with worker auto-flipping settings on a schedule, or
   prefer "doc + Discord reminder + Keith clicks Save manually"?
4. Cookie rotation cadence — how often does `MFL_COOKIE` expire? (Affects
   reliability of Path A.)
