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
