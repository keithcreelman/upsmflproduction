# Auction Hub — Changelog

## v0.7.0 — 2026-06-19

FA Auction tab goes live + both auctions honor the commish switches.

### Added
- **FA Auction Pool tab activated** (was a "coming soon" placeholder): Live Lots, Team Budgets (available funds + max legal bid under the 27% / 35% guarantee scenarios), Roster Needs (roster count, total need, per-slot lineup deficits), and the Available-player pool — all from `/acquisition-hub/free-agent-auction/live`, the same payload the mobile app uses.
- **ERA + FA commish switches**: both tabs now read `era_enabled` / `faa_enabled` (added to `/api/auction/lots`). When an auction is off, the tab shows a read-only "isn't running right now" banner over a browsable pool; when on, it's a live board. State refreshes on the existing 30s cadence, so a commish flip reflects without a reload.
- Viewer's own row highlighted in the FA budgets/needs tables; player names open the unified profile modal; Bid/Nominate deep-link to MFL's O=43 page (in-app bidding stays mobile-only for now).

### Why
- Keith wanted one set of ERA/FAA kill switches to control **both** the mobile app and the desktop hub. This brings the desktop hub to parity with the mobile redesign.

## v0.1.0 — 2026-05-18

Initial scaffold + Expired Rookie Pool MVP.

### Added
- Tab strip with 6 tabs: Expired Rookie Pool (populated), FA Auction Pool, Nominations, Cap & Roster War Room, Bid History, Rules & Calendar (placeholders).
- Expired Rookie Pool table backed by `/api/auction/era-eligible?L=&YEAR=`.
- Eligibility derivation: `contract_type='Rookie'` AND `contractYear=0` (no extension event). R1-option-declined and taxi-3yr-clock-expired players land here by construction.
- Filters: position chips (QB / RB / WR / TE / PK / PN / IDP), prior-owner dropdown, min Y3 salary, free-text search.
- Sortable columns: Player, Pos, NFL Team, Age, Prior Owner, Rookie Slot, Y3 Salary, Current Bid.
- Hover popover on the Nominate action: current high bid, current high bidder, your proxy bid, cap delta @ $1K / $5K / $10K (informational — offseason has no $300K ceiling per `league_context_v1.md §6.A1`).
- "Why eligible" tooltip per row (rule reason + extension deadline).
- Mobile column priorities (`.col-md` / `.col-lo`) and overflow scroll.

### Canon (lands in same PR)
- `docs/league_context_v1.md §A3` — ERA nomination cadence rule (1 / 12-hour rolling), AAV escalator basis (winning bid), forced-retention end pinned to `FA_Auction.close_at`, no-fine clarification, MYAC window note.
- `docs/league_context_v1.md §A2` — Cut-then-rebid machine-enforceable rule spec.
- `docs/league_context_v1.md §C2` — Loaded-contract cap enforcement timing (hard block at contract-load).

### Deferred
- Nominate / bid worker endpoints (parked in `CROSS_CODEBASE_ALIGNMENT.md §4.1`).
- Live MFL contract-status-suffix parsing for distinguishing R1-option vs. taxi-clock vs. rookie-expired (rendered uniformly today; refinement is a UI nicety, not a rule nicety).
- D1 `ups_auction_lots` / `ups_auction_bids` tables (also §4.1).
