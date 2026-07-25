#!/usr/bin/env python3
"""DEPRECATED (2026-07-21) — produces an artifact nothing reads. Do not wire this
into a schedule; either revive it deliberately or delete it with its output.

WHY IT IS FLAGGED: `docs/auction/data/market_rate.json` has ZERO code consumers.
Verified by repo-wide search — the only references outside this file are prose
mentions in `analysis_v11_fa_value.md` / `analysis_v12_fa_value.md` under "source
artifacts". The live FA pricing chain (build_fa_value.py → build_roster_fit.py →
build_ep_v5_calibration.py) does not read it. The committed market_rate.json is a
snapshot of a one-off analysis, not a pipeline output; re-running this changes
nothing downstream.

KEPT RATHER THAN DELETED because the v11/v12 analyses cite the artifact by name —
the file is evidence for a published writeup. If those analyses are superseded,
delete this script and docs/auction/data/market_rate.json together.

ALSO: this hits D1 via `wrangler d1 execute --remote` and builds a local /tmp
SQLite. Read-only against D1, but not free — another reason not to schedule it
while nothing consumes the result.

── original docstring ───────────────────────────────────────────────────────
Phase C — market willingness-to-pay: $ per expected-APW.

For every historical FA auction win, look up the winner-season's DYNASTY-SF rank
for that player → E[APW] p50 from the dynasty curve (Phase B) → $/E[APW]. This is
the EX-ANTE rate (the player's expected APW at their pre-auction slot, NOT their
realized APW) so busts stay in the denominator. Aggregate by position × era.

We use the DYNASTY axis (not redraft) so the rate R[pos,SF] is on the same E[APW]
basis the FA value engine uses → value_ratio is calibrated apples-to-apples.

Eras (limited by dynasty-ADP coverage 2020+): preSF=2020-2021, SF=2022-2025.
Output: docs/auction/data/market_rate.json.
"""
from __future__ import annotations
import csv, json, sqlite3, subprocess, statistics
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
DATA = REPO / "docs" / "auction" / "data"
WORKER = REPO / "worker"
DB = "/tmp/ups_auction_canon.db"
SKILL = ["QB", "RB", "WR", "TE"]
EAPW_FLOOR = 0.5     # ignore wins whose expected APW is ~0 (divide-by-near-zero)


def d1(sql):
    res = subprocess.run(
        ["npx", "--yes", "wrangler@latest", "d1", "execute", "ups-mfl-db", "--remote", "--json", "--command", sql],
        cwd=WORKER, capture_output=True, text=True, timeout=180)
    if res.returncode != 0:
        raise RuntimeError(res.stderr[-1500:])
    out = res.stdout
    return json.loads(out[out.find("["):])[0]["results"]


def rank_of(s):
    d = "".join(c for c in (s or "") if c.isdigit())
    return int(d) if d else None


def main():
    curves = json.loads((DATA / "eapw_curves.json").read_text())["curves"]["dynasty"]

    def eapw(pos, rank):
        c = curves.get(pos)
        if not c or not rank:
            return None
        return c["p50"][min(rank, len(c["p50"])) - 1]

    # mfl_id → fp_id, and (season, fp_id) → dynasty-SF rank
    mfl2fp = {str(r["mfl_id"]): str(r["fantasypros_id"])
              for r in d1("SELECT mfl_id, fantasypros_id FROM ff_player_ids WHERE fantasypros_id IS NOT NULL")}
    dyn_rank = {}
    for r in csv.DictReader(open(DATA / "dynasty_adp_history.csv")):
        dyn_rank[(int(r["season"]), str(r["fp_id"]))] = (r["pos"], rank_of(r["sf_pos_rank"]))

    # historical FA wins
    c = sqlite3.connect(DB)
    buckets = {p: {"preSF": [], "SF": []} for p in SKILL}
    examples = {p: [] for p in SKILL}
    matched = unmatched = 0
    for season, pid, nm, pos, amt in c.execute(
        "SELECT season, player_id, player_name, position, bid_amount FROM transactions_auction "
        "WHERE auction_type='FreeAgent' AND finalbid_ind=1 AND season>=2020"):
        if pos not in SKILL:
            continue
        fp = mfl2fp.get(str(pid))
        pr = dyn_rank.get((season, fp)) if fp else None
        rank = pr[1] if pr else None
        e = eapw(pos, rank)
        if e is None or e < EAPW_FLOOR:
            unmatched += 1
            continue
        matched += 1
        era = "SF" if season >= 2022 else "preSF"
        rate = amt / e
        buckets[pos][era].append(rate)
        examples[pos].append((season, nm, rank, amt, e, rate))

    out = {"meta": {
        "method": "median $ per expected-APW (dynasty p50, ex-ante). preSF=2020-2021, SF=2022-2025. wins with E[APW]<0.5 or no dynasty rank excluded.",
        "matched_wins": matched, "excluded_wins": unmatched, "eapw_floor": EAPW_FLOOR,
    }, "rate": {}}
    # first pass: per-pos era medians
    for pos in SKILL:
        row = {}
        for era in ("preSF", "SF"):
            v = buckets[pos][era]
            row[era] = {"median": round(statistics.median(v)) if v else None,
                        "mean": round(statistics.mean(v)) if v else None, "n": len(v)}
        out["rate"][pos] = row
    # operative rate R[pos] — prefer the position's OWN signal (a TE-APW is not
    # priced like an RB-APW, so never borrow cross-position unless a position has
    # literally no APW-delivering wins):
    #   SF n>=5            → SF median            (high confidence)
    #   pooled n>=2        → pooled-era median    (low confidence; flagged)
    #   else               → cross-position median (last resort; flagged)
    reliable = {}
    for pos in SKILL:
        if len(buckets[pos]["SF"]) >= 5:
            reliable[pos] = round(statistics.median(buckets[pos]["SF"]))
    for pos in SKILL:
        sf = buckets[pos]["SF"]; pooled = buckets[pos]["preSF"] + buckets[pos]["SF"]
        if len(sf) >= 5:
            R, conf = round(statistics.median(sf)), "high"
        elif len(pooled) >= 2:
            R, conf = round(statistics.median(pooled)), "low"
        else:
            others = [v for p, v in reliable.items() if p != pos]
            R, conf = (round(statistics.median(others)) if others else None), "cross-pos"
        out["rate"][pos]["R"] = R
        out["rate"][pos]["R_conf"] = conf

    (DATA / "market_rate.json").write_text(json.dumps(out, indent=2))
    print(f"wrote {(DATA / 'market_rate.json').relative_to(REPO)} "
          f"({matched} wins priced, {unmatched} excluded)")
    print("\n=== market $ per expected-APW (median) — validate QB preSF≪SF revaluation ===")
    print(f"  {'pos':<4}{'preSF $/APW':>14}{'SF $/APW':>12}{'  n(pre/SF)':>14}   R[pos,SF]")
    for pos in SKILL:
        r = out["rate"][pos]
        print(f"  {pos:<4}{str(r['preSF']['median'] or '-'):>14}{str(r['SF']['median'] or '-'):>12}"
              f"{(str(r['preSF']['n'])+'/'+str(r['SF']['n'])):>14}   ${r['R']}")
    print("\n=== sample SF QB wins ($ / rank / E[APW] / $perAPW) ===")
    for season, nm, rank, amt, e, rate in sorted([x for x in examples["QB"] if x[0] >= 2022], key=lambda x: -x[3])[:8]:
        print(f"  {season} {nm[:22]:<23} QB{rank:<3} ${amt:>6} / E[APW] {e:>4.1f} = ${round(rate):>6}/APW")


if __name__ == "__main__":
    main()
