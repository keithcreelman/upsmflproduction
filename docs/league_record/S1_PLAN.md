# League Record S1: multi-hop trade and draft-pick lineage (Phase 2 plan, sanitized)

**Scope of this pull request:** Step 1 only: local, read-only extraction and evidence reconciliation for one real historical trade, with its methodology (`S1_METHODOLOGY.md`), evidence scripts (`scripts/league_record/s1/`), a committed evidence bundle and report (`docs/league_record/pilot/`) and tests. **Not authorized and not done:** D1 tables or writes, ETL production changes, Worker routes, desk tools, deployments, migrations, flags, secrets, paid model calls, whole-archive ingestion. This pull request is separate from the Commissioner Desk (#1478), the mobile beta and Project A.

## 1. The questions the capability must eventually answer

- What did a franchise ultimately receive from a trade, and where did every player and pick in it go afterward?
- Which drafted players did those picks become (only where authoritative draft records support it)?
- How many points did those players produce for each franchise during its ownership, and what salary and contract obligations came with them?
- Which parts of the history are proven, calculated, inferred, or missing?

## 2. The pilot

The primary trade is `trade2025_5` (2025-03-05), in which HammerTime (franchise 0005) traded A.J. Brown. The upstream starting point is `trade2024_30` (2024-07-24), in which HammerTime acquired him. The report follows the economic history from HammerTime's side: what it surrendered, what Brown produced and cost while on its roster, what it received (including the 20,000 cap transfer), what happened to each received pick and player, and the final known position of each asset, tracing every branch to a stated generation limit and listing what lies beyond it.

## 3. What already exists, and what does not

| Need | Existing source | Used how |
|---|---|---|
| Trades 2010-2025 with pick identity and slot | archive `transactions_trades` | the extraction's trade ledger (the production D1 mirror drops the pick identity; D1 is not touched) |
| Trades 2026 | committed daily snapshots | token parsing (`FP_`, `DP_`, `BB_`) |
| Draft results | archive `draftresults_*`, snapshot `draftResults.json` | the only source of a slot's selection |
| MFL pre-draft slot lists with trade notes | snapshots from 2026-04-21 | inventory of slots on a date; notes are corroboration only |
| Adds, drops, auction wins | archive `transactions_adddrop`, `transactions_auction`; snapshot transactions | stint boundaries |
| Weekly rosters, scores, contracts | archive `rosters_weekly`, `player_weeklyscoringresults`, `playerscores_weekly` | points and salary |
| A stored per-season draft order | **none** | never derived (see the methodology) |
| Trades 2025-11-28 to 2026-03-07 | **none** (no archive or snapshot covers it) | listed as incomplete coverage on every chain that crosses it |
| Points for 2026, owner identity, team cap totals | **none** | explicit gaps (slices S2 and S3) |

## 4. Data model (for later phases; none of it is built here)

Evidence classes CONFIRMED, CALCULATED, INFERRED, UNRESOLVED (see the methodology), and these records, each carrying a source reference, a method id and a version: `trade`, `trade_asset` (identity and cap amount preserved), `slot_evidence`, `pick_hop`, `pick_resolution`, `stint`, `outcome`, `gap`. The pilot's JSON bundle is the working shape. Whether and where this is stored (new read-only tables behind new read-only routes) is a separate decision that needs its own approval, a measured query plan and a migration go.

## 5. Acceptance tests T1-T16

The pilot passes only if all of these hold (`scripts/league_record/s1/acceptance.mjs`; T16 is recorded on the pull request):

1. Every asset, link and event carries a class and a source.
2. Every trade equals its raw archive rows or snapshot entry (a second code path).
3. Dates, times, date quality, asset identity and both franchise ids are preserved.
4. Chains replay the recorded trades; discontinuities are listed, not repaired.
5. Every slot comes from an MFL slot token and the MFL draft result; a future pick is never confirmed to a slot.
6. The uniqueness inference applies only when all of its conditions hold; otherwise UNRESOLVED.
7. No owner field or claim anywhere.
8. Possession comes from events; roster-record disagreements are listed.
9. The build fails if a ranking, bracket, projection or derived draft order is read.
10. Points are per franchise and possession; copy weeks excluded; disputed weeks not verified; inferred assets excluded from confirmed totals.
11. Every salary equals the recorded roster row; none estimated.
12. The trace stops at the generation limit and lists the frontier.
13. The 2025-11-28 to 2026-03-07 gap and every break are listed; no pick that crosses the gap is resolved.
14. Two builds are byte-identical and match the committed bundle; read-only; no network.
15. Only franchise ids, team names and player names; no private data.
16. Independent review and CI on the exact head.

## 6. Sequence and what needs a decision

1. **This pull request:** pilot evidence and methodology. Stop for review.
2. Only after approval: broader extraction (still local), then any storage design, then routes and tools, each with its own approval.

## 7. Roadmap items and their dependencies (not built)

- **Dated rule versions:** a "Rule changes by year" heading establishes the year of that historical entry; it does not universally prove the effective season or implementation date. For other rules the heading year, effective season, vote date and implementation date must be kept apart. Superflex is supported as beginning in 2022 by the wording of its historical entry.
- **Contract timelines and salary implications (S2):** weekly roster records in a queryable store, grandfathered-tag rulings, recorded contract history.
- **Owner identity (S3):** an owner registry and rulings; until then franchise id only.
- **Cross-season comparison:** stable lineage, contracts and owners first.
