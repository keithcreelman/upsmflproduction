#!/usr/bin/env python3
"""Fold verified round-by-round analyst picks into the draft list.

WHAT THIS IS. JJ Zachariason runs a two-part segment where a co-host reads the
twelve players in each round's FantasyPros ADP tier and JJ names his single
favourite pick in that round; Scott Barrett does the inverse on a Fantasy
Points episode, one player he refuses to draft in every round. Both cover
rounds 1-10 only — JJ's co-host says on air that rounds 11-15 are behind the
paid guide. Evan Silva has no such series.

⚠️ TWO WAYS THIS DATA LIES, BOTH SILENT.

  1. THE ROUND FIELD IS NOT ALWAYS A ROUND. The extractor wrote relative
     distances into it — "4 rounds after Loveland", "7 rounds before
     Jefferson", "5 rounds cheaper than fair". Keyed naively, Harold Fannin
     becomes a round-4 pick when the source says he goes four rounds LATER
     than someone else. Anything that is not a bare integer 1-18 is refused
     and reported, never coerced.

  2. THE ANALYST'S ROUND IS NOT THIS PAGE'S ROUND. JJ reads FantasyPros ADP
     tiers; the draft list is cut on FantasyFootballCalculator ADP. The same
     player can sit in different rounds under the two. His round is what he
     said, so that is what is stored — and where FFC disagrees, the
     disagreement is shown rather than reconciled away.

Only items that a second reader confirmed BOTH said and round-tied survive.
"""
from __future__ import annotations

import argparse
import collections
import json
import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "pipelines"))
sys.path.insert(0, str(REPO / "scripts"))

import importlib.util                                            # noqa: E402
_s = importlib.util.spec_from_file_location(
    "bdb", str(REPO / "scripts" / "cbs_build_draft_board.py"))
bdb = importlib.util.module_from_spec(_s)
_s.loader.exec_module(bdb)

BARE_ROUND = re.compile(r"^\s*(\d{1,2})\s*$")
MAX_ROUND = 18
#: ⚠️ THE SAME PERSON ARRIVES UNDER DIFFERENT LABELS. One sweep angle returned
#: "JJ Zachariason", another "JJ Zachariason (Late-Round Fantasy Football /
#: LateRound.com, @LateRoundQB)" — so keying on the raw string left his rounds
#: 1-5 picks rendered twice and reported one corroboration instead of five.
#: Canonicalise to the person; the surname is the only stable part.
CANON = {"zachariason": "JJ Zachariason", "barrett": "Scott Barrett",
         "silva": "Evan Silva"}


def canon_analyst(a: str | None) -> str:
    low = (a or "").lower()
    for surname, name in CANON.items():
        if surname in low:
            return name
    # Never guess. An unrecognised byline keeps its own text, trimmed of the
    # parenthetical, so it cannot silently merge with someone else.
    return re.split(r"\s*[(/]", (a or "unattributed").strip())[0] or "unattributed"


def clean_round(v) -> int | None:
    """A round is a bare integer in 1..18. Everything else is refused."""
    if isinstance(v, bool):
        return None
    if isinstance(v, int):
        return v if 1 <= v <= MAX_ROUND else None
    m = BARE_ROUND.match(str(v or ""))
    if not m:
        return None
    n = int(m.group(1))
    return n if 1 <= n <= MAX_ROUND else None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--result", required=True, help="workflow output JSON")
    ap.add_argument("--board", default=str(REPO / "data/analyst/board_payload.json"))
    ap.add_argument("--out", default=str(REPO / "data/analyst/round_picks.json"))
    a = ap.parse_args()

    blob = json.loads(Path(a.result).read_text())
    res = blob.get("result", blob)
    if "verified" not in res:
        raise SystemExit("no 'verified' key in the workflow result — refusing to "
                         "build from a shape I do not recognise.")

    board = [r[0] for r in json.loads(Path(a.board).read_text())["p4"]]
    by_key = {}
    for nm in board:
        by_key.setdefault(bdb.akey(nm), nm)

    kept, refused, unjoined = [], [], []
    for t in res["verified"]:
        rd = clean_round(t.get("round"))
        if rd is None:
            refused.append({"player": t.get("player"), "round": t.get("round"),
                            "analyst": t.get("analyst")})
            continue
        nm = by_key.get(bdb.akey(t.get("player", "")))
        if nm is None:
            unjoined.append(t.get("player"))
            continue
        kept.append({"round": rd, "player": nm,
                     "analyst": canon_analyst(t.get("analyst")),
                     "stance": t.get("stance"), "take": t.get("take"),
                     "url": t.get("source_url"),
                     "quoted": t.get("quoted_or_paraphrased")})

    # ── collapse the same call found more than once ──────────────────────────
    # ⚠️ A DUPLICATE HERE IS CORROBORATION, NOT NOISE. Two angles reached JJ's
    # rounds 1-5 by different routes — one pulled the omny.fm word-level JSON
    # transcript, the other yt-dlp auto-captions off the YouTube stream — and
    # both landed on the same picks. Rendering him twice is wrong; throwing the
    # second away loses the fact that two independent extractions agree. So the
    # call collapses and carries the count, and the longer take wins because
    # the two transcripts garble different words.
    merged: dict = {}
    for k in kept:
        key = (k["round"], k["player"], k["analyst"], k["stance"])
        cur = merged.get(key)
        if cur is None:
            merged[key] = {**k, "sources": [k["url"]] if k["url"] else []}
            continue
        if k["url"] and k["url"] not in cur["sources"]:
            cur["sources"].append(k["url"])
        if len(k.get("take") or "") > len(cur.get("take") or ""):
            cur["take"], cur["url"] = k["take"], k["url"]
        # A quoted reading beats a paraphrased one.
        if k.get("quoted") == "quoted":
            cur["quoted"] = "quoted"
    dupes = len(kept) - len(merged)
    kept = sorted(merged.values(), key=lambda k: (k["round"], k["stance"], k["player"]))

    Path(a.out).write_text(json.dumps(
        {"picks": kept, "refused_rounds": refused, "unjoined": unjoined},
        indent=1))

    by_rd = collections.defaultdict(list)
    for k in kept:
        by_rd[k["round"]].append(k)
    print(f"wrote {a.out}")
    corrob = sum(1 for k in kept if len(k.get("sources") or []) > 1)
    print(f"  {len(kept)} verified round-tied calls across {len(by_rd)} rounds "
          f"({dupes} duplicate extractions collapsed; {corrob} corroborated by "
          f"two independent sources)")
    print(f"  {len(refused)} refused: the round field held a relative phrase, "
          f"not a round" + (f" (e.g. {refused[0]['round']!r})" if refused else ""))
    print(f"  {len(unjoined)} named a player outside the board" +
          (f": {', '.join(sorted(set(unjoined))[:5])}" if unjoined else ""))
    for rd in sorted(by_rd):
        for k in sorted(by_rd[rd], key=lambda x: x["stance"]):
            who = (k["analyst"] or "?").split("(")[0].strip()
            print(f"  R{rd:>2} [{k['stance']:<7}] {k['player']:<24}{who[:22]}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
