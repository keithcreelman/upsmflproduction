"""
rookie_meta_model_2026_v2.py — N-source generic meta-model.

Auto-discovers any `<analyst>_2026*.csv` in inputs/ and treats each as a source.
Computes:
  - Per-prospect score per source (normalized to 0-100 ZAP 2.0 scale)
  - Consensus score: trimmed mean (drop highest + lowest) when n_sources >= 4,
    else simple mean
  - Cross-source agreement: count of sources within ±1 tier of consensus
  - Cross-source disagreement: range (max - min) across sources
  - "Lover" / "fader" surfacing: which analyst loves each player most, who fades

Source CSV format (any of these patterns work):
  - {jj_zap, koalaty_2026_postdraft, winks, kerrane, barrett, pff, harmon,
     hermsmeyer, elequin, howard, sanderson, fantasypros_consensus, dlf,
     tej_seth, gretch, ...}_2026*.csv
  - Columns: player_name, position, ..., model_score (0-100) or zap_score
  - Optional: tier, nfl_team, source

Outputs:
  - site/rookies/2026_meta_prospects_v2.json
  - docs/league-context/2026_rookie_buy_list_v2.md
"""
from __future__ import annotations

import csv
import json
import statistics
import sys
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "pipelines" / "analytics" / "meta_model"))
from tier_compression import assign_tier, normalize_name, ZAP2_TIERS, TIER_ORDER  # noqa: E402

INPUTS_DIR = ROOT / "pipelines" / "analytics" / "meta_model" / "inputs"
NFL_2026_CSV = INPUTS_DIR / "nfl_draft_picks_2026.csv"
ADP_CSV = INPUTS_DIR / "rookie_adp_2026.csv"
OUT_JSON = ROOT / "site" / "rookies" / "2026_meta_prospects_v2.json"
OUT_MD = ROOT / "docs" / "league-context" / "2026_rookie_buy_list_v2.md"

# Anchor file (must include every prospect we want to evaluate)
ANCHOR_CSV = INPUTS_DIR / "jj_zap_2026.csv"

# UDFA capital floor cap for sources that don't penalize undrafted (Koalaty mostly)
UDFA_FLOOR = 35.0
SOURCES_WITH_UDFA_GAP = {"koalaty"}  # add more if verification finds them


def is_source_file(p: Path) -> bool:
    """Source CSVs are 2026-tagged but exclude meta files."""
    name = p.name.lower()
    if "2026" not in name: return False
    if name.startswith("nfl_draft"): return False
    if name.startswith("rookie_adp"): return False
    if name.startswith("blend_weights"): return False
    if name.startswith("jj_zap_2024") or name.startswith("jj_zap_2022"): return False
    # Dropped sources (per user feedback 2026-04-29):
    # - DraftSharks: rankings are NFL-pick-order in disguise, not analysis
    if name.startswith("draftsharks"): return False
    # Howard CSVs are paywall-limited "directional only" — exclude until real ranks are accessible
    if name.startswith("howard"): return False
    # Tice: NFL big board grades ALL positions (OL, DL, etc.) — different lens than fantasy
    # projection. Conflating his rank with fantasy sources over-penalizes fantasy-friendly
    # role players. Surfaced as separate "NFL talent context" column instead of consensus input.
    if name.startswith("tice"): return False
    return name.endswith(".csv")


def source_name(p: Path) -> str:
    """Derive analyst name from filename: jj_zap_2026.csv → 'jj'."""
    base = p.stem.lower()
    base = base.replace("_2026_postdraft", "")
    base = base.replace("_2026", "")
    base = base.replace("_zap", "").replace("_consensus", "_aggregate")
    return base


def get_score(row: dict) -> float | None:
    """Extract a 0-100 model score from any source CSV."""
    for col in ("model_score", "zap_score", "score"):
        v = row.get(col)
        if v not in (None, "", "—"):
            try:
                return float(v)
            except (TypeError, ValueError):
                continue
    return None


def get_tier_from_score(score: float | None) -> str:
    if score is None:
        return "—"
    return assign_tier(score)


def fuzzy_lookup(name: str, pos: str, idx: dict) -> dict | None:
    norm = normalize_name(name)
    if (norm, pos) in idx:
        return idx[(norm, pos)]
    last = name.split()[-1].lower()
    for (n, p), r in idx.items():
        if p != pos: continue
        if (n in norm or norm in n) and len(n) >= 5: return r
        # Last-name match
        try: r_last = r.get("player_name","").split()[-1].lower().replace(",","").replace(".","").replace("Jr","").strip()
        except: r_last = ""
        if last and r_last and len(last) >= 5 and last == r_last: return r
    return None


def load_csv(path: Path) -> list[dict]:
    if not path.exists():
        return []
    with path.open() as f:
        return list(csv.DictReader(f))


def main() -> int:
    # Discover all source CSVs
    source_files = sorted([p for p in INPUTS_DIR.iterdir() if is_source_file(p)])
    print(f"Discovered {len(source_files)} source CSVs:")
    for p in source_files:
        print(f"  {p.name} ({source_name(p)})")

    # Load all sources
    sources: dict[str, dict] = {}  # source_name -> {row data, idx}
    for p in source_files:
        rows = load_csv(p)
        idx = {(normalize_name(r["player_name"]), r.get("position","")): r for r in rows}
        sources[source_name(p)] = {"rows": rows, "idx": idx, "path": str(p.relative_to(ROOT))}

    # Load Tice as a separate "NFL talent context" signal (not in consensus)
    tice_path = INPUTS_DIR / "tice_2026.csv"
    tice_idx = {}
    if tice_path.exists():
        for r in load_csv(tice_path):
            tice_idx[(normalize_name(r["player_name"]), r.get("position",""))] = r
        print(f"Tice big board (NFL talent context, NOT in consensus): {len(tice_idx)} entries")

    # Load NFL + ADP
    nfl_rows = load_csv(NFL_2026_CSV)
    nfl_idx = {(normalize_name(r["player_name"]), r["position"]): r for r in nfl_rows}
    adp_rows = load_csv(ADP_CSV)
    adp_idx = {(normalize_name(r["player_name"]), r["position"]): r for r in adp_rows}
    print(f"\nNFL picks: {len(nfl_rows)}, ADP entries: {len(adp_rows)}\n")

    # Anchor: UNION of all source CSVs (so QB candidates from non-JJ sources are included).
    # Deduplicate by (normalized_name, position).
    seen: dict[tuple, dict] = {}
    for src_data in sources.values():
        for r in src_data["rows"]:
            key = (normalize_name(r["player_name"]), r.get("position", ""))
            if key not in seen:
                seen[key] = r
    anchor_rows = list(seen.values())
    print(f"Anchor cohort (union of all sources): {len(anchor_rows)} unique prospects")

    cohort = []
    for a in anchor_rows:
        name = a["player_name"]
        pos = a.get("position", "")

        # NFL pick lookup
        nfl_match = fuzzy_lookup(name, pos, nfl_idx)
        nfl_pick = int(nfl_match["pick_overall"]) if nfl_match else None
        nfl_round = int(nfl_match["round"]) if nfl_match else None
        nfl_team = nfl_match["nfl_team"] if nfl_match else "UDFA"

        # Per-source scores
        per_source = {}
        for src, src_data in sources.items():
            row = fuzzy_lookup(name, pos, src_data["idx"])
            if row:
                score = get_score(row)
                if score is not None:
                    # Apply UDFA floor for sources with documented refit gaps
                    effective = score
                    if src in SOURCES_WITH_UDFA_GAP and not nfl_match and score > UDFA_FLOOR:
                        effective = UDFA_FLOOR
                    per_source[src] = {
                        "raw": score,
                        "effective": effective,
                        "tier": get_tier_from_score(effective),
                        "label": row.get("tier") or "",
                    }

        # Consensus: trimmed mean (drop high + low) if n >= 4, else simple mean
        scores = [s["effective"] for s in per_source.values()]
        if len(scores) >= 4:
            sorted_scores = sorted(scores)
            trimmed = sorted_scores[1:-1]
            consensus = round(statistics.mean(trimmed), 1)
            consensus_method = "trimmed_mean"
        elif scores:
            consensus = round(statistics.mean(scores), 1)
            consensus_method = "mean"
        else:
            consensus = None
            consensus_method = "none"

        consensus_tier = assign_tier(consensus) if consensus else "—"

        # Cross-source range (disagreement signal)
        score_range = max(scores) - min(scores) if len(scores) >= 2 else 0
        # Tier disagreement: count how many sources fall outside ±1 tier of consensus
        consensus_tier_idx = TIER_ORDER.get(consensus_tier, 3) if consensus else 3
        sources_in_band = 0
        sources_high = []
        sources_low = []
        for src, s in per_source.items():
            src_tier_idx = TIER_ORDER.get(s["tier"], 3)
            if abs(src_tier_idx - consensus_tier_idx) <= 1:
                sources_in_band += 1
            elif src_tier_idx < consensus_tier_idx:  # source loves more (better tier)
                sources_high.append((src, s["effective"]))
            else:
                sources_low.append((src, s["effective"]))

        # ADP lookup
        adp_match = fuzzy_lookup(name, pos, adp_idx)
        adp_sf = adp_match.get("adp_sf") if adp_match else None

        # Tice NFL talent context (separate signal, NOT in consensus)
        tice_row = fuzzy_lookup(name, pos, tice_idx)
        if tice_row:
            try:
                tice_overall_rank = int((tice_row.get("notes") or "").replace("BigBoard_Overall_", "").strip()) if "BigBoard" in (tice_row.get("notes") or "") else None
            except (ValueError, TypeError):
                tice_overall_rank = None
            tice_context = {
                "overall_rank": tice_overall_rank,
                "tier": tice_row.get("tier") or "",
            }
        else:
            tice_context = None

        cohort.append({
            "player_name": name,
            "position": pos,
            "nfl_pick": nfl_pick,
            "nfl_round": nfl_round,
            "nfl_team": nfl_team,
            "n_sources": len(per_source),
            "per_source": per_source,
            "consensus_score": consensus,
            "consensus_tier": consensus_tier,
            "consensus_method": consensus_method,
            "score_range": round(score_range, 1),
            "sources_in_band": sources_in_band,
            "sources_loving": [s for s, _ in sources_high],
            "sources_fading": [s for s, _ in sources_low],
            "adp_sf": adp_sf,
            "tice_nfl_context": tice_context,
        })

    # Sort cohort: position then consensus desc
    cohort.sort(key=lambda r: (r["position"], -(r["consensus_score"] or 0)))

    # Write JSON
    OUT_JSON.parent.mkdir(parents=True, exist_ok=True)
    OUT_JSON.write_text(json.dumps({
        "meta": {
            "generated_at": "2026-04-29",
            "n_prospects": len(cohort),
            "sources": list(sources.keys()),
            "udfa_floor": UDFA_FLOOR,
            "consensus_method": "trimmed mean (drop high+low) if n>=4 sources, else simple mean",
        },
        "prospects": cohort,
    }, indent=2))
    print(f"wrote {OUT_JSON.relative_to(ROOT)}")

    # Build markdown buy list
    lines: list[str] = []
    lines.append(f"# 2026 UPS Rookie Buy List — {len(sources)}-Source Meta-Model\n")
    lines.append(
        f"Auto-loaded {len(sources)} analyst sources: **{', '.join(sources.keys())}**. "
        f"Plus NFL 2026 draft capital + dynasty ADP.\n"
        f"Consensus = trimmed mean (drop highest + lowest source) when n≥4 sources; "
        f"simple mean otherwise. Each prospect's `n_sources` shows coverage depth.\n"
    )

    # Highest disagreement (top of class)
    high_dis = sorted(
        [c for c in cohort if c["n_sources"] >= 3 and c["score_range"] >= 30],
        key=lambda r: -r["score_range"],
    )
    if high_dis:
        lines.append("\n## ⚡ Highest cross-source disagreements (range ≥30)\n")
        lines.append(
            "| Player | Pos | NFL | n | Range | Consensus | Tier | Sources LOVE | Sources FADE |\n"
            "|:-------|:---:|:---:|:-:|------:|----------:|:-----|:-------------|:-------------|"
        )
        for c in high_dis[:20]:
            pick = f"R{c['nfl_round']}.{c['nfl_pick']}" if c["nfl_pick"] else "UDFA"
            lines.append(
                f"| {c['player_name']} | {c['position']} | {pick} | {c['n_sources']} | "
                f"{c['score_range']} | {c['consensus_score']} | {c['consensus_tier']} | "
                f"{', '.join(c['sources_loving']) or '—'} | "
                f"{', '.join(c['sources_fading']) or '—'} |"
            )

    # Per-position tier-grouped buy list
    by_pos = defaultdict(list)
    for c in cohort:
        by_pos[c["position"]].append(c)

    for pos in ("QB", "RB", "WR", "TE"):
        rows = by_pos.get(pos, [])
        if not rows: continue
        lines.append(f"\n## {pos} — full {pos} list ({len(rows)} prospects)\n")
        # Group by consensus tier
        by_tier = defaultdict(list)
        for r in rows:
            by_tier[r["consensus_tier"]].append(r)
        for tier_name, _, _ in ZAP2_TIERS:
            tier_rows = by_tier.get(tier_name, [])
            if not tier_rows: continue
            lines.append(f"\n### {tier_name}\n")
            # Per-source headers
            src_list = list(sources.keys())
            header = "| Player | NFL | n | " + " | ".join(src_list) + " | Consensus | ADP |"
            sep = "|:-------|:---:|:-:|" + "|".join([":-:" for _ in src_list]) + "|----------:|:---:|"
            lines.append(header)
            lines.append(sep)
            for r in sorted(tier_rows, key=lambda x: -x["consensus_score"]):
                pick = f"R{r['nfl_round']}.{r['nfl_pick']}" if r["nfl_pick"] else "UDFA"
                cells = []
                for src in src_list:
                    if src in r["per_source"]:
                        score = r["per_source"][src]["effective"]
                        cells.append(f"{score:.0f}")
                    else:
                        cells.append("—")
                adp_str = r["adp_sf"] or "—"
                lines.append(
                    f"| {r['player_name']} | {pick} | {r['n_sources']} | " +
                    " | ".join(cells) +
                    f" | **{r['consensus_score']}** | {adp_str} |"
                )

    OUT_MD.parent.mkdir(parents=True, exist_ok=True)
    OUT_MD.write_text("\n".join(lines))
    print(f"wrote {OUT_MD.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
