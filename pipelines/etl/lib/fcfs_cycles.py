"""FCFS acquisition-period fields for `player_acquisition_cycles` — the generation rule and the safe, idempotent regeneration.

CANON (docs/league_context_v1.md §A5, §T1.6; worker/src/fcfs_contract.js is the runtime source of truth): every FCFS acquisition is a
$1,000, ONE-YEAR Vet-WW contract. So an FCFS acquisition cycle must carry

    salary_at_acquisition_usd     = 1000
    contract_years_at_acquisition = 1

WHY A SCOPED REGENERATION, NOT THE FULL `--pair --apply`.  Pass 2 (`backfill_cycles_pass2.py --apply`) DELETEs every row whose source is
`backfill_pass2%` and re-INSERTs every cycle. In production the table has since been ENRICHED IN PLACE by passes 3 and 4 (source
`backfill_pass3_…` / `backfill_pass4_…`: salary_at_drop, tcv_at_drop, earned_*, penalty_*). Re-running the full pass 2 would re-insert every cycle
a second time next to those enriched rows. So the generation rule (`cycle_to_row`) now writes the canonical FCFS fields for FUTURE pair runs, and the
existing rows are corrected by `plan_fcfs_cycle_updates` — an UPDATE of exactly two columns on exactly the FCFS cycles that have independent
transaction evidence, with the source/enrichment columns untouched.

WHAT IT NEVER DOES: create a cycle (a period with no cycle is reported, not invented); touch a non-FCFS row; touch a drop-time column (a later
replacement contract — an auction, waiver, MYM, extension, restructure, tag, trade — lives there and is preserved); overwrite a salary or years that
is already non-NULL and different (that is a manual-review row); merge two acquisition periods (each evidence row is matched to at most one cycle,
each cycle to at most one evidence row, so a distinct re-acquisition stays its own row).
"""
from __future__ import annotations

import re
from collections import defaultdict
from datetime import datetime, timezone

FCFS_SALARY_USD = 1000
FCFS_CONTRACT_YEARS = 1
MATCH_WINDOW_SECONDS = 2 * 86400        # tz / rounding slack between the ETL's event stamp and the transaction ledger's unix stamp

# Stated source limitations (verified against MFL's own transactions export, 2026-09-26; docs/FCFS_CONTRACTS.md §4).
SOURCE_LIMITS = {
    2010: "MFL shows no FREE_AGENT adds — FCFS did not exist",
    2011: "D1-only evidence (MFL returns no data for league 74598 in 2011)",
    2012: "D1-only evidence (MFL returns no data for league 74598 in 2012)",
    2013: "no FCFS rows in D1; MFL cannot confirm — nothing invented",
    2014: "no FCFS rows in D1; MFL cannot confirm — nothing invented",
    2015: "MFL shows no FREE_AGENT adds — FCFS did not exist",
    2016: "no FCFS rows in D1; MFL cannot confirm — nothing invented",
}


def _norm_fid(v) -> str:
    d = "".join(ch for ch in str(v or "") if ch.isdigit())
    return d.zfill(4)[-4:] if d else ""


def _norm_pid(v) -> str:
    return "".join(ch for ch in str(v or "") if ch.isdigit())


def _epoch(v) -> int | None:
    """'YYYY-MM-DD HH:MM:SS' / ISO-8601 (with or without Z / fractional seconds) → epoch seconds (a naive stamp is read as UTC)."""
    if v is None or v == "":
        return None
    if isinstance(v, (int, float)):
        return int(v)
    s = str(v).strip().replace("T", " ").replace("Z", "").split(".")[0]
    for fmt, n in (("%Y-%m-%d %H:%M:%S", 19), ("%Y-%m-%d", 10)):
        try:
            return int(datetime.strptime(s[:n], fmt).replace(tzinfo=timezone.utc).timestamp())
        except ValueError:
            continue
    return None


def evidence_from_rows(adddrop_rows: list[dict], hist_rows: list[dict]) -> list[dict]:
    """The FCFS acquisitions the ledgers PROVE: FREE_AGENT adds in D1's `src_adddrop` and `mfl_historical_transactions`. De-duplicated on (season, player, franchise, stamp)."""
    seen: dict[tuple, dict] = {}
    for r in adddrop_rows or []:
        if str(r.get("method")) != "FREE_AGENT" or str(r.get("move_type")) != "ADD":
            continue
        k = (int(r["season"]), _norm_pid(r.get("player_id")), _norm_fid(r.get("franchise_id")), int(r.get("unix_timestamp") or 0))
        seen.setdefault(k, {"season": k[0], "pid": k[1], "fid": k[2], "ts": k[3], "salary": r.get("salary"), "sources": []})["sources"].append("src_adddrop")
    by_key: dict[tuple, list[dict]] = defaultdict(list)
    for e in seen.values():
        by_key[(e["season"], e["pid"], e["fid"])].append(e)
    corroborated: set[int] = set()
    for r in hist_rows or []:
        if str(r.get("type")) != "FREE_AGENT" or not str(r.get("player_in_id") or "").strip():
            continue
        k = (int(r["season"]), _norm_pid(r.get("player_in_id")), _norm_fid(r.get("franchise_id")), int(r.get("ts_unix") or 0))
        e = seen.get(k)
        if e is None:
            # the SAME acquisition can carry a slightly different stamp in the two ledgers: it corroborates the NEAREST src row of its key within the window, ONE-TO-ONE
            near = [x for x in by_key.get(k[:3], []) if "src_adddrop" in x["sources"] and id(x) not in corroborated and abs(x["ts"] - k[3]) <= MATCH_WINDOW_SECONDS and k[3] > 0]
            near.sort(key=lambda x: abs(x["ts"] - k[3]))
            if near:
                e = near[0]
            else:
                e = {"season": k[0], "pid": k[1], "fid": k[2], "ts": k[3], "salary": r.get("salary"), "sources": []}
                seen[k] = e
                by_key[k[:3]].append(e)
        corroborated.add(id(e))
        if "mfl_historical_transactions" not in e["sources"]:
            e["sources"].append("mfl_historical_transactions")
        if e.get("salary") is None:
            e["salary"] = r.get("salary")
    return sorted(seen.values(), key=lambda e: (e["season"], e["ts"], e["pid"]))


def _match(cycles: list[dict], evidence: list[dict]) -> tuple[dict[int, dict], list[dict]]:
    """One-to-one: each evidence row ↔ at most one cycle (closest stamp within the window, same season/player/franchise)."""
    by_key: dict[tuple, list[dict]] = defaultdict(list)
    for c in cycles:
        by_key[(int(c["season"]), _norm_pid(c["player_id"]), _norm_fid(c["franchise_id"]))].append(c)
    pairs = []
    for ei, e in enumerate(evidence):
        for c in by_key.get((e["season"], e["pid"], e["fid"]), []):        # same SEASON, player and franchise — never across seasons
            cts = _epoch(c.get("acquisition_date"))
            if cts is None:
                continue
            d = abs(cts - e["ts"])
            if d <= MATCH_WINDOW_SECONDS:
                pairs.append((d, ei, c["cycle_id"]))
    pairs.sort()
    taken_e, taken_c, cycle_ev = set(), set(), {}
    for d, ei, cid in pairs:
        if ei in taken_e or cid in taken_c:
            continue
        taken_e.add(ei); taken_c.add(cid); cycle_ev[cid] = evidence[ei]
    unmatched = [e for i, e in enumerate(evidence) if i not in taken_e]
    return cycle_ev, unmatched


def plan_fcfs_cycle_updates(cycles: list[dict], evidence: list[dict], stamp: str) -> dict:
    """The regeneration plan. `cycles` = rows of player_acquisition_cycles (at least: cycle_id, player_id, franchise_id, season, acquisition_path, acquisition_date,
    salary_at_acquisition_usd, contract_years_at_acquisition). Pure: no I/O."""
    fcfs = [c for c in cycles if str(c.get("acquisition_path")) == "fcfs"]
    cycle_ev, unmatched = _match(fcfs, evidence)
    rows, updates = [], []
    for c in sorted(fcfs, key=lambda x: x["cycle_id"]):
        sal, yrs = c.get("salary_at_acquisition_usd"), c.get("contract_years_at_acquisition")
        base = {"cycle_id": c["cycle_id"], "season": c["season"], "player_id": c["player_id"], "franchise_id": c["franchise_id"], "acquisition_date": c.get("acquisition_date"),
                "source": c.get("source"), "before": {"salary_at_acquisition_usd": sal, "contract_years_at_acquisition": yrs}}
        ev = cycle_ev.get(c["cycle_id"])
        if ev is None:
            rows.append({**base, "disposition": "skipped_no_evidence", "after": base["before"], "reason": "no FCFS transaction proves this cycle — not touched, nothing invented"}); continue
        ev_sal = ev.get("salary")
        if (ev_sal is not None and int(ev_sal) != FCFS_SALARY_USD) or (sal is not None and int(sal) != FCFS_SALARY_USD):
            rows.append({**base, "disposition": "manual_review_salary_conflict", "after": base["before"], "reason": f"a stored salary differs from the canonical $1,000 (cycle {sal}, transaction {ev_sal})"}); continue
        if yrs is not None and int(yrs) != FCFS_CONTRACT_YEARS:
            rows.append({**base, "disposition": "manual_review_years_conflict", "after": base["before"], "reason": f"stored contract years {yrs} != 1"}); continue
        after = {"salary_at_acquisition_usd": FCFS_SALARY_USD, "contract_years_at_acquisition": FCFS_CONTRACT_YEARS}
        if sal == FCFS_SALARY_USD and yrs == FCFS_CONTRACT_YEARS:
            rows.append({**base, "disposition": "unchanged", "after": after, "evidence": ev["sources"]}); continue
        rows.append({**base, "disposition": "updated", "after": after, "evidence": ev["sources"]})
        updates.append({"cycle_id": c["cycle_id"], "set": after, "sql": update_sql(c["cycle_id"], stamp)})
    by_season: dict[int, dict] = defaultdict(lambda: defaultdict(int))
    for r in rows:
        by_season[int(r["season"])][r["disposition"]] += 1
    for e in unmatched:
        by_season[int(e["season"])]["periods_without_cycle"] += 1
    counts: dict[str, int] = defaultdict(int)
    for r in rows:
        counts[r["disposition"]] += 1
    return {
        "updates": updates,
        "rows": rows,
        "periods_without_cycle": unmatched,
        "summary": {"fcfs_cycles": len(fcfs), "evidence_periods": len(evidence), **dict(counts), "periods_without_cycle": len(unmatched),
                    "by_season": {y: dict(v) for y, v in sorted(by_season.items())},
                    "source_limits": {y: SOURCE_LIMITS[y] for y in sorted(SOURCE_LIMITS)}},
    }


def update_sql(cycle_id: int, stamp: str) -> str:
    """The UPDATE for one cycle. Guarded so it can only fill a NULL / already-canonical value on an FCFS row — applying it twice changes nothing."""
    return (
        "UPDATE player_acquisition_cycles SET salary_at_acquisition_usd = 1000, contract_years_at_acquisition = 1, "
        f"updated_at_utc = '{stamp}' WHERE cycle_id = {int(cycle_id)} AND acquisition_path = 'fcfs' "
        "AND (salary_at_acquisition_usd IS NULL OR salary_at_acquisition_usd = 1000) "
        "AND (contract_years_at_acquisition IS NULL OR contract_years_at_acquisition = 1) "
        "AND (salary_at_acquisition_usd IS NULL OR contract_years_at_acquisition IS NULL);"
    )


_STAMP_RE = re.compile(r"updated_at_utc = '[^']*'")


def normalized_update_lines(text: str) -> list[str]:
    """UPDATE statements with the run's own timestamp masked, sorted — two runs of the same plan compare equal whenever they ran."""
    return sorted(_STAMP_RE.sub("updated_at_utc = '<STAMP>'", ln.strip()) for ln in text.splitlines() if ln.strip())


def plan_drift(fresh_updates: list[dict], reviewed_sql: str) -> dict:
    """--apply may only write what was REVIEWED: the fresh plan (built from live D1) must equal the reviewed updates.sql, statement for statement."""
    fresh = normalized_update_lines("\n".join(u["sql"] for u in fresh_updates))
    reviewed = normalized_update_lines(reviewed_sql)
    return {"ok": fresh == reviewed, "added": len(set(fresh) - set(reviewed)), "removed": len(set(reviewed) - set(fresh))}


def rollback_sql(cycles: list[dict], updates: list[dict]) -> str:
    """The exact reverse of the planned UPDATEs (every planned row had BOTH columns NULL or partly canonical): a REVIEWED script for Keith, never run by this tool."""
    by_id = {c["cycle_id"]: c for c in cycles}
    out = []
    for u in updates:
        c = by_id[u["cycle_id"]]
        def lit(v):
            return "NULL" if v is None else str(int(v))
        prev = c.get("updated_at_utc")
        out.append(
            f"UPDATE player_acquisition_cycles SET salary_at_acquisition_usd = {lit(c.get('salary_at_acquisition_usd'))}, contract_years_at_acquisition = {lit(c.get('contract_years_at_acquisition'))}, "
            f"updated_at_utc = {('NULL' if prev is None else chr(39) + str(prev).replace(chr(39), chr(39) * 2) + chr(39))} WHERE cycle_id = {int(u['cycle_id'])} AND acquisition_path = 'fcfs' "
            "AND salary_at_acquisition_usd = 1000 AND contract_years_at_acquisition = 1;")
    return "\n".join(out) + ("\n" if out else "")


def apply_updates(cycles: list[dict], updates: list[dict], stamp: str) -> list[dict]:
    """The state of the table after the UPDATEs (used for the local before/after export and the second-run proof)."""
    by_id = {u["cycle_id"]: u for u in updates}
    out = []
    for c in cycles:
        n = dict(c)
        u = by_id.get(c["cycle_id"])
        if u and n.get("acquisition_path") == "fcfs" and (n.get("salary_at_acquisition_usd") is None or n.get("contract_years_at_acquisition") is None):
            n["salary_at_acquisition_usd"] = u["set"]["salary_at_acquisition_usd"]
            n["contract_years_at_acquisition"] = u["set"]["contract_years_at_acquisition"]
            n["updated_at_utc"] = stamp
        out.append(n)
    return out


def canonical_acquisition_fields(path: str, event_salary):
    """`cycle_to_row` (the full generation path): the acquisition-time salary and contract years for a cycle of this path.
    FCFS ⇒ ($1,000, 1) unless the transaction carries a DIFFERENT salary (kept, and flagged by the caller)."""
    if path == "fcfs":
        sal = FCFS_SALARY_USD if event_salary in (None, "", 0) else int(event_salary)
        return sal, FCFS_CONTRACT_YEARS, (sal != FCFS_SALARY_USD)
    return event_salary, None, False


# ─────────────────────────────── the key-level RECONCILIATION (do the counts balance?) ───────────────────────────────
# Keith 2026-09-26: "709 periods / 671 cycles / 56 missing" does not add up (671 + 56 = 727 ≠ 709). Every number is a COUNT OF KEYS — (season, player, franchise) — so the
# report below buckets every period and every cycle exactly once and proves the two identities
#     periods = matched + periods_without_cycle          cycles = matched + orphan_cycles
# (the 18-row difference is arithmetic: 727 − 709 = the orphan cycles src_adddrop cannot prove − the out-of-scope 2026 periods).  The 652-cycle UPDATE plan is only
# APPROVABLE when both identities hold and nothing is ambiguous.
CREATE_SOURCE = "fcfs_narrow_create_2026_09_26"     # distinct from backfill_pass2% / pass3 / pass4, so nothing that re-runs those ever deletes or re-inserts these rows
CREATE_SCOPE = (2011, 2025)                          # inclusive; 2026 belongs to the live tool (scripts/fcfs_contract_backfill.mjs) — reported here, never created here
DUPLICATE_GUARD_SECONDS = 7 * 86400                  # a same-key FCFS cycle this close to a "missing" period may already BE that acquisition (a different stamp) — never inserted over


def _key_of(season, pid, fid) -> tuple:
    return (int(season), _norm_pid(pid), _norm_fid(fid))


def _index_cycles(cycles: list[dict]) -> dict:
    by_key: dict[tuple, list[dict]] = defaultdict(list)
    for c in cycles:
        by_key[_key_of(c["season"], c["player_id"], c["franchise_id"])].append(c)
    return by_key


def _candidate_cycles(e: dict, by_key: dict) -> list[dict]:
    out = []
    for c in by_key.get((e["season"], e["pid"], e["fid"]), []):
        cts = _epoch(c.get("acquisition_date"))
        if cts is not None and abs(cts - e["ts"]) <= MATCH_WINDOW_SECONDS:
            out.append(c)
    return out


def _fmt_key(k: tuple) -> str:
    return f"{k[0]}:{k[1]}:{k[2]}"


def reconcile(cycles: list[dict], evidence: list[dict], scope: tuple = CREATE_SCOPE, out_of_scope: list[dict] | None = None) -> dict:
    """The key-level table. Pure. `evidence` = evidence_from_rows() (each row lists the ledgers that prove it in `sources`); `out_of_scope` = extra periods beyond the scope
    (the 2026 season, from ups_transactions) that are REPORTED and never counted in the balance."""
    lo, hi = scope
    fcfs = [c for c in cycles if str(c.get("acquisition_path")) == "fcfs" and lo <= int(c["season"]) <= hi]
    periods = [e for e in evidence if lo <= e["season"] <= hi]
    beyond_by_key: dict[tuple, dict] = {}
    for e in [x for x in evidence if x["season"] > hi] + list(out_of_scope or []):
        beyond_by_key.setdefault(_key_of(e["season"], e["pid"], e["fid"]), e)            # one entry per KEY (a 2026 add both ledgers know is one period)
    beyond = list(beyond_by_key.values())
    by_key = _index_cycles(fcfs)

    def basis(period_rows: list[dict]) -> dict:
        cycle_ev, unmatched = _match(fcfs, period_rows)
        matched_ids = set(cycle_ev)
        orphans = [c for c in fcfs if c["cycle_id"] not in matched_ids]
        return {"cycle_ev": cycle_ev, "unmatched": unmatched, "orphans": orphans}

    main = basis(periods)
    src_only = basis([e for e in periods if "src_adddrop" in e.get("sources", [])])
    matched = main["cycle_ev"]

    # duplicates: a key with more than one period (a distinct re-acquisition in the same season) — and how many cycles / matches it has
    period_keys: dict[tuple, list[dict]] = defaultdict(list)
    for e in periods:
        period_keys[_key_of(e["season"], e["pid"], e["fid"])].append(e)
    matched_by_key: dict[tuple, int] = defaultdict(int)
    for cid in matched:
        c = next(x for x in fcfs if x["cycle_id"] == cid)
        matched_by_key[_key_of(c["season"], c["player_id"], c["franchise_id"])] += 1
    dup_periods = [{"key": _fmt_key(k), "periods": len(v), "cycles": len(by_key.get(k, [])), "matched": matched_by_key.get(k, 0)} for k, v in sorted(period_keys.items()) if len(v) > 1]
    dup_cycles = [{"key": _fmt_key(k), "cycles": len(v), "periods": len(period_keys.get(k, [])), "matched": matched_by_key.get(k, 0)} for k, v in sorted(by_key.items()) if len(v) > 1]

    # ambiguity: a period with more than one candidate cycle in the window, or a cycle with more than one candidate period — the one-to-one matcher had to CHOOSE
    cyc_cands: dict[int, int] = defaultdict(int)
    amb_periods = []
    for e in periods:
        cands = _candidate_cycles(e, by_key)
        for c in cands:
            cyc_cands[c["cycle_id"]] += 1
        if len(cands) > 1:
            amb_periods.append({"key": _fmt_key(_key_of(e["season"], e["pid"], e["fid"])), "ts": e["ts"], "candidate_cycles": [c["cycle_id"] for c in cands]})
    amb_cycles = [{"cycle_id": cid, "candidate_periods": n} for cid, n in sorted(cyc_cands.items()) if n > 1]

    # orphan cycles: no period is matched to them — either nothing in either ledger proves them, or a period exists but a sibling cycle already took it (a duplicate cycle)
    orphan_rows = []
    for c in main["orphans"]:
        k = _key_of(c["season"], c["player_id"], c["franchise_id"])
        cts = _epoch(c.get("acquisition_date"))
        near = [e for e in period_keys.get(k, []) if cts is not None and abs(cts - e["ts"]) <= MATCH_WINDOW_SECONDS]
        orphan_rows.append({"cycle_id": c["cycle_id"], "key": _fmt_key(k), "season": int(c["season"]), "acquisition_date": c.get("acquisition_date"), "reason": "duplicate_cycle_extra" if near else "no_evidence_in_either_ledger"})
    hist_only_matches = [cid for cid, e in matched.items() if "src_adddrop" not in e.get("sources", [])]
    without = [{"key": _fmt_key(_key_of(e["season"], e["pid"], e["fid"])), "season": e["season"], "player_id": e["pid"], "franchise_id": e["fid"], "ts": e["ts"], "sources": e["sources"]} for e in main["unmatched"]]

    def by_season(rows, field="season"):
        out: dict[int, int] = defaultdict(int)
        for r in rows:
            out[int(r[field])] += 1
        return {y: out[y] for y in sorted(out)}

    n_periods, n_matched, n_without = len(periods), len(matched), len(main["unmatched"])
    n_cycles, n_orphans = len(fcfs), len(main["orphans"])
    identity = {
        "periods = matched + periods_without_cycle": {"left": n_periods, "right": n_matched + n_without, "holds": n_periods == n_matched + n_without},
        "cycles = matched + orphan_cycles": {"left": n_cycles, "right": n_matched + n_orphans, "holds": n_cycles == n_matched + n_orphans},
        # the identities above only mean something when every cycle id and every period stamp is DISTINCT — a duplicated id or an identical duplicated period would balance them falsely
        "every cycle id is distinct": {"left": n_cycles, "right": len({c["cycle_id"] for c in fcfs}), "holds": n_cycles == len({c["cycle_id"] for c in fcfs})},
        "every period (season, player, franchise, stamp) is distinct": {"left": n_periods, "right": len({(e["season"], e["pid"], e["fid"], e["ts"]) for e in periods}), "holds": n_periods == len({(e["season"], e["pid"], e["fid"], e["ts"]) for e in periods})},
    }
    balanced = all(v["holds"] for v in identity.values())
    ambiguous = bool(amb_periods or amb_cycles)

    # the bridge to the figures reported earlier ("709 periods / 671 cycles / 56 missing"): src_adddrop-only periods + the out-of-scope 2026 periods
    n_beyond = len(beyond)
    src_periods = len([e for e in periods if "src_adddrop" in e.get("sources", [])])
    earlier_periods = src_periods + n_beyond
    earlier_sum = n_cycles + len(src_only["unmatched"])
    gap = earlier_sum - earlier_periods
    bridge = {
        "earlier_report": {"periods": earlier_periods, "cycles": n_cycles, "missing": len(src_only["unmatched"]), "cycles_plus_missing": earlier_sum, "difference": gap},
        "periods_earlier_equals": f"{src_periods} src_adddrop periods in scope + {n_beyond} periods beyond the scope (2026)",
        "difference_is": f"{len(src_only['orphans'])} orphan cycles (on the src_adddrop-only basis) − {n_beyond} out-of-scope periods = {len(src_only['orphans']) - n_beyond}",
        "holds": gap == len(src_only["orphans"]) - n_beyond,
        "on_the_union_basis": f"{n_periods} + {n_orphans} orphans = {n_cycles} + {n_without} without_cycle = {n_periods + n_orphans}",
    }
    return {
        "scope": [lo, hi],
        "unique_periods": n_periods,
        "exactly_one_match": n_matched,
        "matched_proven_only_by_mfl_historical_transactions": len(hist_only_matches),
        "periods_without_cycle": {"total": n_without, "by_season": by_season(without), "keys": without},
        "orphan_cycles": {"total": n_orphans, "by_season": by_season(orphan_rows),
                          "no_evidence_in_either_ledger": len([r for r in orphan_rows if r["reason"] == "no_evidence_in_either_ledger"]),
                          "duplicate_cycle_extra": len([r for r in orphan_rows if r["reason"] == "duplicate_cycle_extra"]), "keys": orphan_rows},
        "duplicate_periods": {"keys": len(dup_periods), "detail": dup_periods},
        "duplicate_cycles": {"keys": len(dup_cycles), "detail": dup_cycles},
        "ambiguous": {"periods": amb_periods, "cycles": amb_cycles, "total": len(amb_periods) + len(amb_cycles)},
        "cycles_total": n_cycles,
        "identity": identity,
        "balanced": balanced,
        "updates_approvable": balanced and not ambiguous,
        "not_approvable_reason": "" if balanced and not ambiguous else ("the identities do not balance" if not balanced else "ambiguous matches exist"),
        "src_adddrop_only_basis": {"periods": src_periods, "matched": len(src_only["cycle_ev"]), "periods_without_cycle": len(src_only["unmatched"]), "orphan_cycles": len(src_only["orphans"])},
        "out_of_scope_periods": [{"key": _fmt_key(_key_of(e["season"], e["pid"], e["fid"])), "ts": e["ts"], "sources": e.get("sources", [])} for e in beyond],
        "bridge": bridge,
    }


def reconciliation_markdown(rec: dict) -> str:
    """A reviewable table of the reconciliation (the report Keith reads)."""
    lo, hi = rec["scope"]
    idn = rec["identity"]
    lines = [
        f"# FCFS cycle reconciliation — seasons {lo}–{hi}", "",
        "| bucket | count |", "|---|---:|",
        f"| unique FCFS periods (season, player, franchise, stamp) | {rec['unique_periods']} |",
        f"| exactly-one match (period ↔ one cycle) | {rec['exactly_one_match']} |",
        f"| — of which proven only by mfl_historical_transactions | {rec['matched_proven_only_by_mfl_historical_transactions']} |",
        f"| periods without a cycle | {rec['periods_without_cycle']['total']} |",
        f"| cycles (all FCFS) | {rec['cycles_total']} |",
        f"| orphan cycles (no period matched) | {rec['orphan_cycles']['total']} |",
        f"| — no evidence in either ledger | {rec['orphan_cycles']['no_evidence_in_either_ledger']} |",
        f"| — duplicate-cycle extras | {rec['orphan_cycles']['duplicate_cycle_extra']} |",
        f"| keys with more than one period | {rec['duplicate_periods']['keys']} |",
        f"| keys with more than one cycle | {rec['duplicate_cycles']['keys']} |",
        f"| ambiguous (period↔cycle choices the matcher had to make) | {rec['ambiguous']['total']} |", "",
        "## Identities", "",
    ]
    for name, v in idn.items():
        lines.append(f"* {name}: {v['left']} = {v['right']} → {'HOLDS' if v['holds'] else 'DOES NOT HOLD'}")
    lines += ["", f"**balanced:** {rec['balanced']} · **updates approvable:** {rec['updates_approvable']}" + (f" ({rec['not_approvable_reason']})" if rec["not_approvable_reason"] else ""), "",
              "## The earlier figures", "",
              f"* earlier report: {rec['bridge']['earlier_report']['periods']} periods / {rec['bridge']['earlier_report']['cycles']} cycles / {rec['bridge']['earlier_report']['missing']} missing — "
              f"{rec['bridge']['earlier_report']['cycles']} + {rec['bridge']['earlier_report']['missing']} = {rec['bridge']['earlier_report']['cycles_plus_missing']} ≠ {rec['bridge']['earlier_report']['periods']} (difference {rec['bridge']['earlier_report']['difference']})",
              f"* {rec['bridge']['periods_earlier_equals']}", f"* the difference is {rec['bridge']['difference_is']} → {'holds' if rec['bridge']['holds'] else 'DOES NOT HOLD'}",
              f"* on the union basis: {rec['bridge']['on_the_union_basis']}", "",
              "## Periods without a cycle, by season", ""] + [f"* {y}: {n}" for y, n in rec["periods_without_cycle"]["by_season"].items()]
    lines += ["", "## Orphan cycles, by season", ""] + [f"* {y}: {n}" for y, n in rec["orphan_cycles"]["by_season"].items()]
    if rec["ambiguous"]["total"]:
        lines += ["", "## Ambiguous choices (the one-to-one matcher had to choose — the plans are NOT approvable while any remain)", ""]
        lines += [f"* period {a['key']} @ {a['ts']}: candidate cycles {a['candidate_cycles']}" for a in rec["ambiguous"]["periods"]]
        lines += [f"* cycle {a['cycle_id']}: {a['candidate_periods']} candidate periods" for a in rec["ambiguous"]["cycles"]]
    if rec["duplicate_periods"]["detail"]:
        lines += ["", "## Keys with more than one period", "", "| key | periods | cycles | matched |", "|---|---:|---:|---:|"] + [f"| {d['key']} | {d['periods']} | {d['cycles']} | {d['matched']} |" for d in rec["duplicate_periods"]["detail"]]
    if rec["out_of_scope_periods"]:
        lines += ["", "## Beyond the scope (reported, never created here)", ""] + [f"* {d['key']} ({', '.join(d['sources'])})" for d in rec["out_of_scope_periods"]]
    return "\n".join(lines) + "\n"


def reconciliation_csv(rec: dict) -> str:
    """One line per key that is NOT an exactly-one match: periods without a cycle, orphan cycles, ambiguities."""
    rows = [["bucket", "key", "season", "detail"]]
    for r in rec["periods_without_cycle"]["keys"]:
        rows.append(["period_without_cycle", r["key"], r["season"], ",".join(r["sources"])])
    for r in rec["orphan_cycles"]["keys"]:
        rows.append(["orphan_cycle", r["key"], r["season"], f"cycle_id={r['cycle_id']} {r['reason']}"])
    for r in rec["ambiguous"]["periods"]:
        rows.append(["ambiguous_period", r["key"], r["key"].split(":")[0], f"cycles={r['candidate_cycles']}"])
    for r in rec["ambiguous"]["cycles"]:
        rows.append(["ambiguous_cycle", f"cycle_id={r['cycle_id']}", "", f"candidate_periods={r['candidate_periods']}"])
    return "\n".join(",".join('"' + str(x).replace('"', '""') + '"' for x in row) for row in rows) + "\n"


# ─────────────────────────────── INSERT-ONLY creation of the missing cycles ───────────────────────────────
# A period a transaction PROVES (src_adddrop / mfl_historical_transactions FREE_AGENT add) that no cycle carries gets ONE cycle, generated through the SAME path a pair run
# uses (`cycle_to_row`, injected as `build_row`), so the row is what a future run would have written. It NEVER deletes or re-inserts, never touches an existing row, never
# creates a duplicate (each statement is guarded by NOT EXISTS on the natural key), never reaches into 2026, and states nothing the ledger cannot prove: the end of the
# period is set ONLY from a later DROP of the same player by the same franchise in the same season (a trade, a later-season drop or nothing → the cycle stays 'open').
NATURAL_KEY_COLS = ("season", "player_id", "franchise_id", "acquisition_path", "acquisition_date")


def iso_utc(ts: int) -> str:
    """The cycle table's stamp format: the UTC-naive rendering of the unix timestamp ('YYYY-MM-DD HH:MM:SS') — identical to every matched cycle's acquisition_date."""
    return datetime.fromtimestamp(int(ts), tz=timezone.utc).strftime("%Y-%m-%d %H:%M:%S")


def sql_literal(v) -> str:
    if v is None or v == "":
        return "NULL"
    if isinstance(v, bool):
        return "1" if v else "0"
    if isinstance(v, (int, float)):
        return str(v)
    return "'" + str(v).replace("'", "''") + "'"


def _natural_key_sql(row: dict) -> str:
    return " AND ".join(f"{c} = {sql_literal(row.get(c))}" for c in NATURAL_KEY_COLS)


def insert_sql(row: dict, cols: list[str]) -> str:
    """ONE guarded INSERT: it inserts nothing when a row with the same natural key already exists (so applying it twice changes nothing)."""
    vals = ", ".join(sql_literal(row.get(c)) for c in cols)
    return f"INSERT INTO player_acquisition_cycles ({', '.join(cols)}) SELECT {vals} WHERE NOT EXISTS (SELECT 1 FROM player_acquisition_cycles WHERE {_natural_key_sql(row)});"


def rollback_delete_sql(row: dict) -> str:
    """The exact reverse of ONE insert: guarded on the natural key AND this pass's source tag, so it can only ever delete a row this pass created."""
    return f"DELETE FROM player_acquisition_cycles WHERE {_natural_key_sql(row)} AND source = {sql_literal(CREATE_SOURCE)};"


def _period_end(period: dict, moves: list[dict], next_same_key_ts: int | None) -> dict | None:
    """The end of an FCFS period: the NEXT move (ADD or DROP, any method) of this player by THIS franchise strictly after the add, in the same season — and only when it is a DROP.
    A later ADD by the same franchise (a BBID re-acquisition after a trade-away, say) means any drop after it belongs to THAT stint, so this period stays open. Never later than the next
    period of the same key (one drop is never used twice)."""
    later = []
    for m in moves or []:
        if int(m["season"]) != period["season"] or _norm_pid(m.get("player_id")) != period["pid"] or _norm_fid(m.get("franchise_id")) != period["fid"]:
            continue
        ts = int(m.get("unix_timestamp") or 0)
        if ts > period["ts"]:
            later.append((ts, str(m.get("move_type")), str(m.get("method") or "")))
    if not later:
        return None
    later.sort()
    ts, move_type, method = later[0]
    if move_type != "DROP":
        return None
    if next_same_key_ts is not None and ts >= next_same_key_ts:
        return None
    return {"ts": ts, "method": method}


def plan_fcfs_cycle_inserts(cycles: list[dict], evidence: list[dict], moves: list[dict], build_row, cols: list[str], stamp: str,
                            scope: tuple = CREATE_SCOPE, out_of_scope: list[dict] | None = None) -> dict:
    """The creation plan. Pure. `build_row(cy)` is `cycle_to_row`; `cols` the table's column order."""
    lo, hi = scope
    rec = reconcile(cycles, evidence, scope, out_of_scope)
    fcfs = [c for c in cycles if str(c.get("acquisition_path")) == "fcfs" and lo <= int(c["season"]) <= hi]
    periods = [e for e in evidence if lo <= e["season"] <= hi]
    _, unmatched = _match(fcfs, periods)
    same_key: dict[tuple, list[int]] = defaultdict(list)
    for e in periods:
        same_key[_key_of(e["season"], e["pid"], e["fid"])].append(e["ts"])
    rows, inserts = [], []
    by_key = _index_cycles(fcfs)
    for e in sorted(unmatched, key=lambda x: (x["season"], x["ts"], x["pid"])):
        base = {"season": e["season"], "player_id": e["pid"], "franchise_id": e["fid"], "acquisition_date": iso_utc(e["ts"]) if e["ts"] > 0 else "", "evidence": e["sources"]}
        # a period whose stamp / player / franchise is UNKNOWN proves nothing: never coerced to the epoch or to a NULL key
        if e["ts"] <= 0 or not e["pid"] or not e["fid"]:
            rows.append({**base, "disposition": "manual_review_unusable_evidence", "reason": "the ledger row has no usable stamp / player / franchise — no period is invented from it"})
            continue
        # any FCFS cycle of the same key within a week (matched or not) may already carry this acquisition under a slightly different stamp — a person decides, nothing is inserted
        near = [c for c in by_key.get((e["season"], e["pid"], e["fid"]), []) if _epoch(c.get("acquisition_date")) is not None and abs(_epoch(c.get("acquisition_date")) - e["ts"]) <= DUPLICATE_GUARD_SECONDS]
        if near:
            rows.append({**base, "disposition": "manual_review_possible_duplicate", "reason": f"cycle(s) {[c['cycle_id'] for c in near]} of the same season/player/franchise sit within {DUPLICATE_GUARD_SECONDS // 86400} days of this stamp"})
            continue
        ev_sal = e.get("salary")
        if ev_sal is not None and int(ev_sal) != FCFS_SALARY_USD:
            rows.append({**base, "disposition": "manual_review_salary_conflict", "reason": f"the transaction carries ${ev_sal}, not the canonical $1,000 — nothing invented"})
            continue
        later = sorted(t for t in same_key[_key_of(e["season"], e["pid"], e["fid"])] if t > e["ts"])
        end = _period_end(e, moves, later[0] if later else None)
        cy = {"player_id": e["pid"], "franchise_id": e["fid"], "season": e["season"], "acquisition_path": "fcfs", "ts_iso": iso_utc(e["ts"]), "acquisition_date": iso_utc(e["ts"]),
              "transaction_type_at_acq": "FREE_AGENT", "salary_at_acquisition_usd": ev_sal, "status": "closed" if end else "open"}
        if end:
            cy.update({"drop_date": iso_utc(end["ts"]), "drop_reason": "cut", "drop_transaction_type": end["method"] or "DROP"})
        row = build_row(cy)
        row["source"], row["created_at_utc"], row["updated_at_utc"] = CREATE_SOURCE, stamp, stamp
        note = "created_by_fcfs_narrow_pass" + ("" if end else "; end_not_proven_by_ledger")
        row["notes"] = "; ".join(x for x in [row.get("notes"), note] if x)
        sql = insert_sql(row, cols)
        rows.append({**base, "disposition": "insert", "closed_by_drop": bool(end), "drop_date": row.get("drop_date"), "row": row})
        inserts.append({"season": e["season"], "player_id": e["pid"], "franchise_id": e["fid"], "acquisition_date": row["acquisition_date"], "row": row, "sql": sql, "rollback_sql": rollback_delete_sql(row)})
    by_season: dict[int, dict] = defaultdict(lambda: defaultdict(int))
    for r in rows:
        by_season[int(r["season"])][r["disposition"]] += 1
    approvable = bool(rec["balanced"] and not rec["ambiguous"]["total"])
    return {
        "inserts": inserts, "rows": rows, "reconciliation": rec,
        "summary": {"scope": [lo, hi], "periods_without_cycle": len(unmatched), "planned_inserts": len(inserts), "approvable": approvable,
                    "not_approvable_reason": "" if approvable else ("the identities do not balance" if not rec["balanced"] else "ambiguous period↔cycle matches exist — a person resolves them first"),
                    "closed_by_drop": len([r for r in rows if r.get("closed_by_drop")]), "left_open": len([r for r in rows if r["disposition"] == "insert" and not r["closed_by_drop"]]),
                    "skipped": len([r for r in rows if r["disposition"] != "insert"]),
                    "by_season": {y: dict(v) for y, v in sorted(by_season.items())}, "out_of_scope_periods": len(rec["out_of_scope_periods"]), "source_tag": CREATE_SOURCE},
    }


def apply_inserts(cycles: list[dict], inserts: list[dict]) -> list[dict]:
    """The table after the INSERTs (local simulation: the NOT EXISTS guard is honoured, existing rows are copied untouched) — the before/after export and the second-run proof."""
    out = [dict(c) for c in cycles]
    exists = {(int(c["season"]), _norm_pid(c["player_id"]), _norm_fid(c["franchise_id"]), str(c.get("acquisition_path")), str(c.get("acquisition_date"))) for c in out}
    next_id = max([int(c["cycle_id"]) for c in out] or [0]) + 1
    for i in inserts:
        r = i["row"]
        k = (int(r["season"]), _norm_pid(r["player_id"]), _norm_fid(r["franchise_id"]), str(r["acquisition_path"]), str(r["acquisition_date"]))
        if k in exists:
            continue
        exists.add(k)
        out.append({**r, "cycle_id": next_id})
        next_id += 1
    return out


def inserts_sql_text(inserts: list[dict]) -> str:
    return "\n".join(i["sql"] for i in inserts) + ("\n" if inserts else "")


def rollback_inserts_text(inserts: list[dict]) -> str:
    return "\n".join(i["rollback_sql"] for i in inserts) + ("\n" if inserts else "")


_INSERT_STAMP_RE = re.compile(r"'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z'")     # the run's own created_at_utc / updated_at_utc (the acquisition / drop dates use a space, not a T)


def normalized_insert_lines(text: str) -> list[str]:
    return sorted(_INSERT_STAMP_RE.sub("'<STAMP>'", ln.strip()) for ln in text.splitlines() if ln.strip())


def plan_inserts_drift(fresh: list[dict], reviewed_sql: str) -> dict:
    """--apply may only write what was REVIEWED: the fresh plan (from live D1) must equal the reviewed inserts.sql, statement for statement (the run's own stamp masked)."""
    a = normalized_insert_lines(inserts_sql_text(fresh))
    b = normalized_insert_lines(reviewed_sql)
    return {"ok": a == b, "added": len(set(a) - set(b)), "removed": len(set(b) - set(a))}
