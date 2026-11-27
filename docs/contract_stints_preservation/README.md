# Preserved: the contract-stint backfill branch (`claude/serene-mendeleev-62034a`)

Issues: #1355 (contract lineage), #1486 (register). **Draft, preservation only. This PR is not approved for merge, and nothing in it is approved as the UPS 2.0 contract model.** Everything below is stored **inert**: no file here is executable, nothing outside this folder is changed, and nothing reads from it.

> **Plain English.** An earlier working session built scripts that rebuild 2011–2021 contract histories. That work only ever existed on one local branch. It is preserved here so UPS 2.0 can learn from it. Some of its ideas are good, but its scripts have limits that matter (below), and two of them wrote to production. So the code is kept as inert evidence with a manifest, not as code to run.

## 1. What is here

| Path | What |
|---|---|
| `original/scripts/*.py.preserved` (13) | the original scripts, **byte-for-byte**, renamed so they cannot be run or imported |
| `original/changes/cap_penalty.py.diff.txt` | the original's change to `pipelines/etl/lib/cap_penalty.py`, as a diff against its base (main's file is unchanged since that base, so it applies cleanly) |
| `original/changes/league_context_v1.md.diff.txt` | its additions to the canon doc, as a diff. **It is not applied to canon**, and canon is not touched here |
| `original/changes/CURRENT_WORK_HANDOFF.md.diff.txt` | the original session's handoff notes (what it claimed was done) |
| `MANIFEST.json` | per file: original path, sha256 of the original blob, size, classification, hazards; plus the 16 original commits |

Owner names appear in the diffs as written. They are legitimate league history and are kept.

**Provenance.** Branch `claude/serene-mendeleev-62034a`, 16 commits on top of `6d009e12`. A local bundle of the original commits exists outside the repository. The commit subjects are in `MANIFEST.json`.

## 2. Safeguards against accidental production execution

- Every script is stored as `*.py.preserved`, so there is nothing to `python` or `import`. The hazards are recorded in the manifest.
- `tests/contract_stints_preservation.test.mjs` (default safe suite, no database, no network) fails if: any file in this folder has an executable extension or a shebang, a preserved script reappears under `pipelines/etl/scripts/`, a manifest hash no longer matches, or a script that executes a remote database write is not flagged in the manifest.
- **Production hooks in the original code** (line numbers refer to the preserved files):
  - `backfill_cycles_pass3.py:506-512` and `backfill_cycles_pass4.py:612-618` run `wrangler d1 execute ups-mfl-db --remote --file=<batch>`: **production D1 writes**. Both also read D1 first (`:252` and `:272`, a remote SELECT).
  - `backfill_2012_alldrops.py:126` runs one remote **SELECT** (a production read, not a write).
  - The eleven contract scripts do **not** execute anything remotely: they write a `.sql` file into a `/tmp` work folder (for example `backfill_2013_contracts.py:587`). Whether and when that SQL was applied to production is not recorded in the code.

## 3. Reuse assessment

Technical and historical justification is from reading the scripts and from the archive findings on #1355. **Nothing is adopted as code.**

| Category | Component | Decision | Why (evidence) |
|---|---|---|---|
| Worth adopting | none | — | no script here is reproducible or validated independently (see §4) |
| Worth extending | **Contract-identity rules** (agreement vs ownership stint, canon additions §1.C9/§1.C10) | EXTEND | they match the agreement / stint / modification model #1355 needs. Each rule must be re-verified against forum, MFL and rulebook evidence before any canon edit |
| Worth extending | **Tag-cut-before-FA-auction cap-free rule** in `cap_penalty.py` (the diff) | EXTEND | a real rule (canon §1.C8), but it uses a hard-coded `FA_AUCTION_START_BY_YEAR` table of "conservative cutoff dates" 2019–2026 (its own comment says it should come from a `league_events` row). Use only through a dated rule-version table once the auction dates are evidenced |
| Supporting evidence only | **Salary-adjustment description classifier** (per-year scripts, about lines 118–130) | REFERENCE | categories (primary drop, rounding, multi-aggregate) are useful vocabulary, but it classifies free text and special-cases individual players (for example a named-player branch at `backfill_2014_contracts.py:130`) |
| Supporting evidence only | **`contractInfo` parser** (`backfill_cycles_pass3.py:116`, `:196`: the GF suffix and contract fields) | REFERENCE | compare with the current `extension_lineage.py` and the MFL contract vocabulary before reuse |
| Supporting evidence only | **2011–2012 method and results** (`backfill_2011_2012_contracts.py`) | REFERENCE | closest to the inaugural-auction start point, but its inputs are `/tmp` dumps (`:19`) not in the repository and it hard-codes a 0.20 × salary-remaining pre-2019 formula (`:22`) that must be tested against MFL's own 2011 penalty records |
| Supporting evidence only | **`CURRENT_WORK_HANDOFF.md` claims** | REFERENCE | records what the session believed was populated; not evidence that it is |
| Replace | **The eleven per-year contract scripts as an implementation** | REPLACE | see §4: `/tmp` inputs, placeholder contract type, earned salary hard-coded to 0, last-name matching, synthetic identities, no schema, self-referential totals. 2015–2021 are 556-line copies of one template that differ from their neighbors in about 50–60 lines |
| Replace | **Synthetic identities** `_MULTI_`, `_ROUND_`, `_STANDALONE_` (2013–2021 scripts) as contract keys | REPLACE | they are not contracts; they are buckets for unmatched adjustment rows, and they are what makes the totals reconcile |
| Investigate | **`backfill_cycles_pass3.py` and `_pass4.py`** and the production rows they wrote | INVESTIGATE | their subjects claim 2,142 enriched and 2,338 deferred cycles, written with `--remote --file`. Main's `pipelines/etl/lib/fcfs_cycles.py:11` refers to columns written by `backfill_pass3_…` / `backfill_pass4_…`, so production probably holds those rows. **Auditing production is a read of production D1 and needs separate approval** |
| Investigate | **`backfill_2012_alldrops.py`** | INVESTIGATE | the only script besides pass 3/4 that touches production (a read); its output rows are unverified |

## 4. Limitations (what must not be inherited)

1. **Self-referential validation.** The "per-year reconciliation" compares sums of derived contracts with sums of the same salary-adjustment rows they were built from (`backfill_2014_contracts.py:163`, `:267-274`, `:330-337`). The unmatched remainder is placed in synthetic rows so the totals close. A matching total is therefore not evidence of correctness.
2. **Money is not computed.** `earned_at_termination_usd` is hard-coded to 0 in every contract script (for example `backfill_2014_contracts.py:530`). Recorded, assessed, historically reconstructed and current-rule amounts are not separated.
3. **Placeholder terms.** 2014–2021 write `contract_type: 'Veteran'` with a `# placeholder` comment (`backfill_2014_contracts.py:470`); 2013 uses a placeholder `contract_seq = 1` (`backfill_2013_contracts.py:505`).
4. **Heuristic player matching.** 2014–2021 match a salary-adjustment description to a player by **last name within a franchise**, with a hand-maintained `NAME_ALIASES` table (`backfill_2014_contracts.py:145`, `:302`).
5. **Unreproducible inputs.** Each 2013–2021 script reads four `/tmp/*.json` inputs that are not in the repository (for example `backfill_2014_contracts.py:41-44`) and writes into a `/tmp` work folder; the 2011–2012 script reads seven `/tmp` paths.
6. **No schema.** No script or migration defines the `player_contracts` / stint tables; the cited migration and builder named in the handoff are not in this branch.
7. **A claim the code does not support.** The commit "2019 … backfill with GF/era detection" (`b70fc22e`): GF and era handling exists in the cycle scripts (`backfill_cycles_pass3.py:116`, `:397-411`), not in `backfill_2019_contracts.py`.
8. **Production writes cannot be dry-run.** Pass 3 and pass 4 load batches straight to production D1.

## 5. Unresolved assumptions (research needed before any reuse)

| Assumption | What would settle it |
|---|---|
| Which generated SQL files were applied to production D1, when, and in what order | a read-only audit of `player_contracts` rows whose `source` starts with `event_chain_` or `backfill_pass` (separate approval) |
| Whether the tables now in production match this code's output | the same audit, compared with the archive's event chain |
| That 2011 drops cost 20% of remaining salary | MFL's own 2011 penalty records (the #1355 review reported MFL's 2011 penalties at $0; that is itself to be re-verified) |
| That the FA auction start dates in the `cap_penalty.py` diff are right | league announcements and MFL calendar records |
| That "Veteran" is correct where the scripts wrote it | contract status vocabulary and forum posts for each case |
| What the `NAME_ALIASES` pairs mean | review each pair against player records |

## 6. Relation to UPS 2.0

D1 stays the single source of truth for contracts. Contract history is rebuilt as evidence-tagged candidate records from the original sources (the 2011 auction onward), with the ownership-stint model from `_owner_lineage`, rules chosen by event date, and recorded / assessed / reconstructed / hypothetical amounts kept apart. These scripts are reference material for that rebuild. Details: the #1355 assessment and the #1486 register (LR-55 to LR-58).
