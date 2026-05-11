# Rookie Draft Hub — Methodology Changelog

All changes to the Draft Hub's analytics methodology are documented here.
The visible **version badge** in the hub header is sourced from `VERSION.json`
(same directory). The two must be kept in sync when updating.

## Versioning scheme

- **MAJOR** (V1 → V2): methodology overhaul that changes what the classifier
  itself measures (e.g. replacing the NET formula, swapping the tier metric).
- **MINOR** (V1.0 → V1.1): threshold tuning, added metric, or new feature that
  extends the model without breaking comparability.
- **PATCH** (V1.0.0 → V1.0.1): bug fixes that affect output (e.g. a data-source
  correction, attribution fix).

**Bump the version only on GitHub commit**, not on local tweaks. When a change
lands, update both:

1. `VERSION.json` — bump `version`, add an entry to `changes` (type: `major` /
   `minor` / `patch` / `initial`), and update `released` + `label` / `description`.
2. This file (`CHANGELOG.md`) — add a matching narrative entry.

Update `methodology_signature` in `VERSION.json` whenever the change alters the
mathematical pipeline (so anyone loading the hub sees exactly what the current
logic is doing without digging into code).

---

## v1.7.8 — 2026-05-11 — Defensive commish detection for the Go LIVE toggle

The v1.7.6 fix made the worker default `COMMISH_FRANCHISE_IDS` include `0008`,
but the **Go LIVE** toggle still wasn't reliably appearing for Keith because
the frontend's `/api/me` call could race the HPM franchise-id injection (or
fail entirely on workers.dev preview / direct page loads).

Three layers of belt-and-suspenders:

1. **Client-side commish allowlist.** After `/api/me` + HPM overlay, the hub
   cross-checks `STATE.me.franchise_id` against `["0008","0001"]` and forces
   `is_commish:true` on match. So the toggle appears as long as the hub
   knows your franchise — regardless of whether the worker round-tripped it.
2. **`?commish=1` URL override.** Append to the URL to force-show the
   toggle (or `?commish=0` to hide). Useful for testing on workers.dev.
3. **`console.info("[draft-hub] me:", ...)`** debug log on every load — open
   DevTools and you can see exactly what `STATE.me` resolved to.

---

## v1.7.7 — 2026-05-11 — Per-pick countdown clock in the banner

A real-time pick countdown now sits next to the on-the-clock headline.

- **Default 10 minutes** (UPS slow-draft cadence). Configurable from a small
  selector in the banner right column: Off / 2m / 5m / 10m / 15m / 30m / 1h / 4h / 8h.
  Saved to `localStorage` so it persists across refreshes.
- **Color bands**: green >2min, amber 1–2min, red <60s, blinking-red OT
  (over time, owner is past the limit).
- **LIVE mode**: seeds from the MFL timestamp of the most recent pick (the
  moment the previous pick was recorded IS when the next slot started).
  Falls back to "first time we observed this slot" for pick #1.
- **SIM mode**: stamps now whenever the auto-sim or a manual pick advances
  active_pick. Revert + Reset both restart the clock cleanly.
- **↺ reset button**: commish-friendly do-over — restarts the current pick's
  clock from the moment of click (e.g. after a connectivity blip).
- **Mobile**: countdown stays visible (smaller); selector + reset hidden.

The clock does NOT auto-submit picks. MFL is still the authority on what
happens at expiry — the on-clock owner sees a flashing red OT and the
commish can intervene.

---

## v1.7.6 — 2026-05-11 — Commish toggle visible in prod + slow-draft speeds

- Worker default `COMMISH_FRANCHISE_IDS` now `"0008,0001"` (was `"0001"` only).
  Keith's franchise (0008 — Real Deal Creel) now sees the **Go LIVE** button on
  the live-mode banner without needing a Cloudflare secret. Override via env
  still wins.
- Auto-sim **Speed** dropdown gains `1 min / pick`, `5 min / pick`, and
  `10 min / pick` options for slow real-time drafts. Existing fast options
  (5s / 10s / 20s / Instant) unchanged. Tick progress bar already uses an
  elapsed-ratio fill so it scales correctly to multi-minute intervals.

---

## v1.1.0 — 2026-05-10 — Live Draft tab built out (simulate + LIVE modes)

The Live Draft tab is no longer a placeholder. Owners can now run picks and
trades from the hub itself, with a default-ON SIMULATE mode for risk-free
rehearsal before draft day.

**UI**
- Modern 3-column live layout (prospects | board | on-the-clock).
- Sticky mode banner at top — SIMULATE (amber, default) vs LIVE (red,
  commissioner-only flip with a confirmation dialog). Mode persists across
  refreshes.
- Filter chips (status) + segmented control (ADP source) replace dropdown
  soup. Visible-count badge on the prospect rail. Empty-state hint when
  filters yield zero results.
- Keyboard: `/` focuses search, `Esc` closes modals, `?` opens help.
- Reduced-motion media query honored; mobile/tablet collapses gracefully.

**Auth**
- Auto-login via MFL HPM context — when an owner opens the hub from MFL's
  homepage iframe, FRANCHISE_ID is detected from URL params (no cookie
  paste in the happy path). Cookie fallback retained for non-HPM contexts.

**Submit a pick**
- Confirm modal shows the rookie contract MFL will apply (Y1 AAV, 3yr TCV,
  length, taxi/IDP/option-year notes) computed per slot from
  `docs/league_context_v1.md` §A1.
- Simulate mode: validates + previews + posts to test Discord channel.
- Live mode: POSTs to MFL `draftResults` import + announces in
  #1498680803419357234.

**Propose a trade**
- Existing trade modal carries the simulate flag through to the worker —
  simulate validates, live POSTs to MFL `tradeProposal`.

**Player search**
- New collapsible panel — searches the entire MFL player pool by name and
  opens the same rich profile card used by Front Office.

**Worker**
- 6 new endpoints: `/api/me`, `/api/settings`, `/api/pick`, `/api/trade`,
  `/api/franchise-assets`, `/api/players-search` (under
  `worker/src/index.js` near `/api/player-bundle`).
- Discord posting reuses the existing bot-token + allowed-mentions
  pattern. Channels controlled by env vars
  `DISCORD_DRAFT_CHANNEL_ID` and `DISCORD_DRAFT_TEST_CHANNEL_ID`.
- Commish gate driven by `COMMISH_FRANCHISE_IDS` env var.

---

## v1.0.1 — 2026-04-20 — Best/Worst → NET; Bang-for-$ → Draft Rating

**Patch** — methodology realignment to the NET-centric model.

Changes:
- **Best Pick** on Team Tendencies cards now = highest 3yr NET (was: tier-ranked
  composite of tier × 1000 + Draft Rating). NET correlates with AP% at +0.850
  across 192 team-seasons, making it the authoritative "impact on winning"
  metric.
- **Worst Pick** now = lowest 3yr NET. Same reasoning.
- **Bang-for-$** now = highest Draft Rating (NET Δ vs slot-expected). Was:
  raw points above slot-median. Lavonte David 2012 3.04 (Draft Rating +77.4)
  correctly surfaces as Keith Creelman's Bang-for-$.
- **Cell-level popup definitions** now resolve by per-cell SEMANTIC, not by the
  current metric view. Clicking Slot-Exp NET always shows Slot-Exp NET's
  definition regardless of whether you're in Draft Rating view or somewhere
  else. Fixes a reported bug where 3yr NET and Draft Rating popups returned
  the same description.
- Added **Slot Percentile** field per pick — 0-100 rank of this pick's 3yr NET
  within the exact (round, slot) population. TRich 2012 1.01 = 0 (worst 1.01
  ever); Zeke 2016 1.01 = 92.9 (best 1.01 nearly ever). More interpretable
  than raw Draft Rating for individual picks.
- Introduced **VERSION.json** + **CHANGELOG.md** + visible version badge in
  hub header with click-through methodology history.
- Per-year positional rank averaging switched from simple average to
  games-weighted (matches existing 3yr E+P / Dud / NET behavior).
- **Tier popup** and **metric-cell popup** now lead with a "In plain English"
  block before the technical definition.
- **Shrinkage explanation** in the Draft Rating audit popup rewritten with
  plain-English first, then technical, then a concrete walk-through of what
  "raw +X / shrunk +Y / 0-100 scale Z" mean for the specific owner.

---

## v1.0.0 — 2026-04-20 — Initial release

**Baseline methodology locked.** This is the V1 reference point for all future
Draft Hub analytics.

Key components as shipped:

- **Tier classifier**: `NET = 3yr-games-weighted E+P rate − 0.5 × 3yr-games-weighted Dud rate`
  - Smash ≥ +30, Hit +15 to +30, Contrib 0 to +15, Bust < 0
  - No "Injury Bust" tier — games-played context surfaced separately
- **Weekly grading**: z-score against rostered-starter baseline at that
  (season, position). Elite (z≥1.0), Plus (0.25≤z<1.0), Neutral (−0.5≤z<0.25),
  Dud (z<−0.5).
- **Baselines**: rostered-starter methodology applied uniformly 2011-2025
  (ignoring stored `metadata_positionalwinprofile` values that used a different
  methodology and caused era drift).
- **Draft Rating**: per-pick Δ = actual 3yr NET − slot-expected NET, averaged
  per owner, shrunk via 20-pick Bayesian prior at league mean (0), then scaled
  0-100 anchored to the observed distribution.
- **Pick ownership**: resolved via `franchises` table + `transactions_adddrop`
  fallback + normalized team-name lookup; pre-2017 weekly ownership inferred by
  replaying drafts + adds + trades + drops chronologically.
- **Future pick projection**: 10yr owner-tracked reg-season AP% base + bracket-
  aware playoff-Δ adjustment; brackets sealed; `FINISH_TO_SLOT` mapping
  7→1.01 … 1→1.12.
- **R6**: random drawing (not projected), IDP-only.
- **Contract parsing**: MFL `contractStatus="TAG"` alone is not authoritative;
  only the literal `Tag` chunk inside `contractInfo` pipe-string marks a
  franchise tag.

Validation (correlations with All-Play%, n=192 team-seasons 2010-2025):

| Metric | r |
|---|---|
| Overall NET | +0.850 |
| Offense E+P | +0.844 |
| Offense Dud | −0.790 |
| Defense E+P | +0.319 |
| Defense Dud | −0.336 |
| Raw Points For | +0.505 |
| Lineup Efficiency | +0.012 |
