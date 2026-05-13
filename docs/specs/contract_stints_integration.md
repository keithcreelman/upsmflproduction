# Player Profile — Contract History rewrite using `player_contracts` + `player_contract_stints`

**Status:** post-draft rainy-day work. Estimated effort: **~2–3 hours**.

**Goal:** replace the current per-season Contract History (built from `src_contracts` snapshots) with a per-contract view built from the canonical event-chain tables in D1. Fixes three known data bugs that the frontend can't paper over.

---

## Why this matters — three concrete bugs the new data model fixes

| Player | Current (broken) | Correct |
|---|---|---|
| **Dallas Goedert 2021** | `Ext1 · CL=2 · YL=1 · TCV=$34K · AAV=$17K` | `Ext1 · CL=1 · YL=1 · TCV=$17K · AAV=$17K` (he was 1-yr Ext1, went to auction in 2022) |
| **Cleon Ca$h player split** | Two rows (2019 cy=3, 2020 cy=2) for one rookie contract | One row spanning **2018–2020 (3 yr)** |
| **Jatavian Sanders 2025** | `Team: Gride EXT1` (the season-opener owner) | `Team: Real Deal Creel` (mid-season trade-in; **extension was given by Real Deal Creel after the trade**) |

Plus a general win: era-aware **Earned** calculation (pre_2019_flat / 2019_calendar_monthly / 2026_per_week) is already encoded per stint — the modal's current Earned column uses one formula across all eras, which is wrong by design for pre-2019.

---

## D1 tables (already built — just need to be exposed)

### `player_contracts` (~9,700 rows) — one row per CONTRACT

```sql
CREATE TABLE player_contracts (
  contract_id           INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id             TEXT    NOT NULL,
  contract_seq          INTEGER NOT NULL,

  origin_event          TEXT    NOT NULL,    -- 'auction' / 'rookie_draft' / 'waiver' / ...
  origin_date_iso       TEXT    NOT NULL,
  origin_franchise_id   TEXT    NOT NULL,
  origin_owner_name     TEXT,

  contract_type         TEXT,                -- canonical UPS type
  contract_length_cl    INTEGER,             -- CL (number of seasons)
  aav_usd               INTEGER,
  tcv_usd               INTEGER,
  year_salaries_json    TEXT,                -- per-year salary detail

  last_modification_event TEXT,
  last_modification_date_iso TEXT,
  origin_aav_usd        INTEGER,             -- values AT SIGNING (vs current)
  origin_tcv_usd        INTEGER,
  origin_cl             INTEGER,

  termination_event     TEXT,                -- 'trade_out' / 'cut' / 'expiration' / NULL=active
  termination_date_iso  TEXT,
  termination_franchise_id TEXT,
  termination_owner_name TEXT,
  cap_hit_usd           INTEGER,
  earned_at_termination_usd INTEGER,

  source                TEXT NOT NULL DEFAULT 'event_chain_2026',
  notes                 TEXT,
  created_at_utc        TEXT NOT NULL DEFAULT (datetime('now')),

  UNIQUE(player_id, contract_seq)
);
```

### `player_contract_stints` (~9,758 rows) — one row per OWNER-STINT within a contract

```sql
CREATE TABLE player_contract_stints (
  stint_id              INTEGER PRIMARY KEY AUTOINCREMENT,
  contract_id           INTEGER NOT NULL,    -- FK → player_contracts.contract_id
  stint_seq             INTEGER NOT NULL,    -- 1 = origin owner, 2 = first trade-in, ...

  start_date_iso        TEXT    NOT NULL,
  end_date_iso          TEXT,                -- NULL = ongoing/active
  start_event           TEXT    NOT NULL,    -- 'origin' / 'trade_in' / 'dispersal_in'
  end_event             TEXT,                -- 'trade_out' / 'cut' / 'expiration' / 'ongoing'

  franchise_id          TEXT    NOT NULL,
  owner_name            TEXT,

  -- Earnings during this stint (era-at-time)
  earned_during_stint_usd INTEGER NOT NULL DEFAULT 0,
  earned_era            TEXT,                -- 'pre_2019_flat' / '2019_calendar_monthly' / '2026_per_week'

  -- Running totals at stint boundaries
  cumulative_earned_at_start_usd INTEGER NOT NULL DEFAULT 0,
  cumulative_earned_at_end_usd   INTEGER,

  notes                 TEXT,
  created_at_utc        TEXT NOT NULL DEFAULT (datetime('now')),

  FOREIGN KEY (contract_id) REFERENCES player_contracts(contract_id),
  UNIQUE(contract_id, stint_seq)
);
```

---

## Current state (the thing we're replacing)

**Modal reads `bundle.contract_history`.** The worker sources this from `src_contracts` (per-season snapshots) at `worker/src/index.js:1737`:

```js
db.prepare(
  `SELECT season, franchise_id, team_name, salary,
          contract_year, contract_length, contract_status,
          contract_info, tcv, aav, extension_flag
     FROM src_contracts
    WHERE player_id = ?
    ORDER BY season DESC`
).bind(pid).all()
```

Renderer: `site/shared/player_profile_master.js` around line 610 — `buildBioHtml` builds the Contract History table from `bundle.contract_history`.

---

## Implementation plan (~2-3 hours)

### Step 1 — Expand `/api/player-bundle` (worker)

**File:** `worker/src/index.js`, around the existing contract_history fetch (~line 1737).

Add two parallel queries:

```js
// Canonical contract view — one row per contract (event-chain reconstruction).
db.prepare(
  `SELECT contract_id, contract_seq,
          origin_event, origin_date_iso, origin_franchise_id, origin_owner_name,
          contract_type, contract_length_cl, aav_usd, tcv_usd, year_salaries_json,
          last_modification_event, last_modification_date_iso,
          origin_aav_usd, origin_tcv_usd, origin_cl,
          termination_event, termination_date_iso,
          termination_franchise_id, termination_owner_name,
          cap_hit_usd, earned_at_termination_usd, notes
     FROM player_contracts
    WHERE player_id = ?
    ORDER BY origin_date_iso DESC`
).bind(pid).all(),

// Per-stint owner chain for those contracts.
db.prepare(
  `SELECT s.contract_id, s.stint_seq,
          s.start_date_iso, s.end_date_iso, s.start_event, s.end_event,
          s.franchise_id, s.owner_name,
          s.earned_during_stint_usd, s.earned_era,
          s.cumulative_earned_at_start_usd, s.cumulative_earned_at_end_usd
     FROM player_contract_stints s
     JOIN player_contracts c ON c.contract_id = s.contract_id
    WHERE c.player_id = ?
    ORDER BY s.contract_id, s.stint_seq`
).bind(pid).all(),
```

Attach to bundle:

```js
const contracts = contractsRes.results || [];
if (contracts.length) {
  bundle.contracts = contracts;
}
const stints = stintsRes.results || [];
if (stints.length) {
  bundle.contract_stints = stints;
}
// KEEP bundle.contract_history as legacy fallback when the new tables
// don't have data for a given player (e.g., very old / pre-event-chain).
```

### Step 2 — Rewrite Contract History renderer (master modal)

**File:** `site/shared/player_profile_master.js`, find the contract-history block in `buildBioHtml` (currently around line 610).

Strategy:
- If `bundle.contracts` exists AND has rows: use the new per-contract view.
- Else: fall back to the existing `bundle.contract_history` per-season renderer (preserve for backward compat).

New per-contract render:

```js
function buildContractHistoryFromContracts(contracts, stints) {
  // Group stints by contract_id
  var stintsByContract = {};
  for (var i = 0; i < (stints || []).length; i++) {
    var s = stints[i];
    if (!stintsByContract[s.contract_id]) stintsByContract[s.contract_id] = [];
    stintsByContract[s.contract_id].push(s);
  }
  // Render newest contract first.
  var rows = contracts.map(function (c) {
    var contractStints = stintsByContract[c.contract_id] || [];
    var startYr = c.origin_date_iso ? c.origin_date_iso.slice(0, 4) : "—";
    var endYr = c.termination_date_iso ? c.termination_date_iso.slice(0, 4) : "";
    var cl = c.contract_length_cl || 0;
    var ylSpan = endYr ? (startYr + "–" + endYr) : (cl > 1 ? (startYr + "–" + (Number(startYr) + cl - 1) + " (active)") : startYr);
    var typeLabel = classifyContractTypeFromContractsRow(c);
    var tcv = c.tcv_usd || 0;
    var aav = c.aav_usd || 0;
    // Owner chain: collapsed to last/current owner with optional expand.
    var ownerChain = contractStints.length > 1
      ? renderOwnerChain(contractStints)
      : escapeHtml(c.origin_owner_name || "—");
    return '<tr>'
      + '<td>' + escapeHtml(ylSpan) + '</td>'
      + '<td>' + ownerChain + '</td>'
      + '<td>' + escapeHtml(typeLabel) + '</td>'
      + '<td class="num">' + (cl || "—") + '</td>'
      + '<td class="num">' + (tcv ? "$" + tcv.toLocaleString() : "—") + '</td>'
      + '<td class="num">' + (aav ? "$" + aav.toLocaleString() : "—") + '</td>'
      + '<td class="num">' + (c.earned_at_termination_usd != null
        ? "$" + c.earned_at_termination_usd.toLocaleString()
        : (c.termination_event ? "—" : "in progress")) + '</td>'
      + '</tr>';
  }).join("");
  return '<div class="profile-block">'
    + '<h4>Contract History <span class="small muted">(' + contracts.length + ' contract' + (contracts.length === 1 ? "" : "s") + ')</span></h4>'
    + '<table class="rdh-table"><thead><tr>'
      + '<th>Span</th><th>Owner</th><th>Type</th>'
      + '<th class="num">CL</th><th class="num">TCV</th><th class="num">AAV</th>'
      + '<th class="num">Earned</th>'
    + '</tr></thead><tbody>' + rows + '</tbody></table></div>';
}

function classifyContractTypeFromContractsRow(c) {
  // contract_type from D1 should already be the canonical UPS vocabulary,
  // but normalize just in case. Maps to:
  //   Free Agent / Rookie / Vet - Auction / Vet - WW / Ext1 / Ext2 / Tag
  var t = String(c.contract_type || "").toLowerCase();
  if (/tag/.test(t)) return "Tag";
  if (/ext.?2|second.ext/.test(t)) return "Ext2";
  if (/ext/.test(t)) return "Ext1";
  if (/rookie/.test(t)) return "Rookie";
  if (/ww|waiver/.test(t)) return "Vet - WW";
  if (/auction|veteran/.test(t)) return "Vet - Auction";
  return c.contract_type || "—";
}

function renderOwnerChain(stints) {
  // Render: "Real Deal Creel" (clickable to expand → modal with full chain)
  // OR for first iteration: just show "Gride → Real Deal Creel"
  return stints.map(function (s) {
    return escapeHtml(s.owner_name || "—");
  }).join(" → ");
}
```

Wire it into `buildBioHtml`:

```js
// Replace the existing contractHistoryHtml block with:
var contractHistoryHtml = "";
if (Array.isArray(bundle.contracts) && bundle.contracts.length) {
  contractHistoryHtml = buildContractHistoryFromContracts(bundle.contracts, bundle.contract_stints || []);
} else if (ch.length) {
  // Legacy fallback — original per-season renderer
  contractHistoryHtml = /* existing legacy code */;
}
```

### Step 3 — Owner-chain expand-on-click (optional polish, ~30 min)

For multi-stint contracts (Sanders example), instead of showing the chain inline, render the current/last owner as a clickable cell. Click → expand a sub-row showing each stint's franchise + dates + earned-during-stint.

CSS: add `.upm-stint-expand` styles + a tiny `▾` chevron when stints.length > 1.

### Step 4 — Cap-math strip refresh (in Bio header)

The cap-math strip currently reads from `bundle.contract_history[0]` (most recent season). Update to read from `bundle.contracts[0]` (most recent ACTIVE contract — `termination_event` is null or `'ongoing'`).

Era-aware Earned:
```js
// Sum earned_during_stint_usd across all stints of the active contract.
// This gives true era-aware Earned even when the contract spans eras.
var activeContract = bundle.contracts.find(function (c) { return !c.termination_event; });
var activeStints = (bundle.contract_stints || []).filter(function (s) { return s.contract_id === activeContract.contract_id; });
var earned = activeStints.reduce(function (sum, s) { return sum + (s.earned_during_stint_usd || 0); }, 0);
```

This replaces the master modal's current `earnedToDate(sal, contractInfo)` helper for active contracts. (Keep `earnedToDate` as a fallback for players without event-chain data.)

---

## Test cases

After implementation, verify with these specific players:

| Test | Expected |
|---|---|
| **Marvin Harrison Jr** (active rookie) | 1 row: `2024–2026 (active) · Real Deal Creel · Rookie · CL 3 · TCV $42K · AAV $14K · Earned in progress` |
| **Dallas Goedert 2021** | Row exists with `2021 · C-Town Chivalry · Ext1 · CL 1 · TCV $17K · AAV $17K · Earned $17K` (NOT CL=2) |
| **Cleon Ca$h player** | One rookie row `2018–2020 · Cleon Ca$h · Rookie · CL 3 · TCV $6K · AAV $2K` (NOT split 2019+2020) |
| **Jatavian Sanders** | 2025 contract shows `Gride → Real Deal Creel` in the Owner column. Hover/expand shows: stint 1 (Gride, 2024-03 → 2025-W6), stint 2 (Real Deal Creel, 2025-W6 → ongoing) |
| **Any pre-2019 vet (e.g., Brees 2015 cut)** | Earned uses era_at_time `pre_2019_flat` formula — small Earned values, not modern 75% |

---

## What stays the same / out of scope

- **Game Log tab** — unchanged. Reads `bundle.weekly_by_season` and `bundle.nfl_weekly_by_season`. Independent of contract history.
- **Stats tab** — unchanged. Reads `bundle.career_summary`.
- **News + Contract Options tabs** — unchanged.
- **Cap-math strip fields** other than Earned (TCV / AAV / CL / YL) still read from MFL contractInfo for the CURRENT active contract. Only Earned switches to the stint-aware formula.
- **Worker write paths** — NO changes. This is read-only.
- **ETL pipeline** — NO changes. `player_contracts` + `player_contract_stints` are already populated. If they ever fall behind, the legacy `bundle.contract_history` fallback path keeps the modal functional.

---

## Files to modify

| File | Change |
|---|---|
| `worker/src/index.js` (~line 1737) | Add 2 parallel D1 queries for `player_contracts` + `player_contract_stints`; attach as `bundle.contracts` + `bundle.contract_stints`. |
| `site/shared/player_profile_master.js` (`buildBioHtml` ~line 610) | Add `buildContractHistoryFromContracts(contracts, stints)` helper. Branch in render: new path if `bundle.contracts` present, else legacy `bundle.contract_history`. |
| `site/shared/player_profile_master.js` (cap-math strip ~line 543) | Era-aware Earned via stint sum (active contract only) when `bundle.contract_stints` present. |

**No other files modified.** This is a worker + master modal change only.

---

## Auth/security

`player_contracts` and `player_contract_stints` are RECONSTRUCTION tables — they describe historical UPS league events. No PII beyond `owner_name` (which is already public on every MFL page). No special auth needed; piggybacks on the existing `/api/player-bundle` endpoint.

---

## Rollback

If anything renders weirdly:
1. Comment out the new queries in `worker/src/index.js` (the bundle won't have `contracts` / `contract_stints` → master modal's branch falls through to the legacy renderer).
2. Push. jsDelivr + worker auto-purge handles cache. Site reverts to pre-change behavior in ~60 seconds.

---

## Reference — where the data comes from

- D1 tables built by `pipelines/etl/scripts/build_contract_history_snapshots.py` (function `build_owner_lineage_rows_for_season` around line 1822).
- Re-run that pipeline if `player_contracts` falls behind (e.g., after a new season). The frontend doesn't need re-deploying.

---

## Effort breakdown

| Step | Time |
|---|---|
| 1. Worker queries + bundle attachment | ~30 min |
| 2. `buildContractHistoryFromContracts` helper + integration | ~45 min |
| 3. Owner-chain expand-on-click (optional polish) | ~30 min |
| 4. Cap-math era-aware Earned | ~30 min |
| 5. Smoke test against 4-5 known players (Goedert / Cleon / Sanders / MHJ / vet) | ~30 min |
| **Total** | **~2-3 hr** |
