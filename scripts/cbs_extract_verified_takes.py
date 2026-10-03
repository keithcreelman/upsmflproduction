#!/usr/bin/env python3
"""Turn a verify-sweep workflow run into the draft board's analyst overlay.

WHY THIS IS A SCRIPT AND NOT A COPY-PASTE. Two attribution traps sit between
the workflow's output and a line on the board that says a named person believes
something, and both are the kind of error that is invisible once it is rendered:

  1. THE SWEEP DROPS THE ANALYST. Each sweep agent returns
     {analyst, takes[]} — but the takes themselves carry no analyst field, and
     the workflow flattens `takes` before verification. Recovering it means
     re-joining every verified take to the sweep result it came from on
     (player, source_url). A take that does not re-join is emitted UNATTRIBUTED
     rather than assigned to whoever seems likely.

  2. THE ANALYST SEARCHED FOR IS NOT ALWAYS THE ANALYST SPEAKING. These are
     podcasts with guests. One verified take from JJ Zachariason's own feed is
     Rich Hribar talking; another is Evan Silva as a guest. The verifier caught
     both and said so in its reasoning. Anything whose verdict text raises a
     speaker question is flagged so the page can credit the SHOW rather than
     assert a person.

Reads the workflow's returned JSON plus the run's journal (for the sweep
results), and writes data/analyst/verified_takes.json.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
#: Phrases meaning "someone other than the analyst I was told about is the one
#: saying this". Tight on purpose: a bare mention of "speaker" is usually the
#: verifier QUOTING a transcript's own `[Speaker 1:]` labels, which is evidence
#: of support, not doubt — matching it flagged 56 of 116 takes and buried the
#: 11 that are real attribution problems.
SPEAKER_DOUBT = re.compile(
    r"\bnot (?:the )?(?:host|guest)\b|voiced by|belongs to (?:the )?(?:host|guest)|"
    r"not necessarily from the same person|the speaker is |"
    r"rather than (?:the )?(?:host|guest)|spoken by (?:the )?guest|"
    r"is a guest\b|guest\b[^.]{0,40}\bnot\b", re.I)


#: Sentence boundary that ignores the abbreviations these verdicts are full of
#: ("HTTP 200.", "Ep. 1117", "vs.") — a naive split on "." shreds them.
_SENT = re.compile(r"(?<=[.!?])\s+(?=[A-Z(\u2022\-])")


def _sentence_around(text: str, m: re.Match, limit: int = 340) -> str:
    """Return the whole sentence containing the match, not a character window."""
    parts, pos = [], 0
    for chunk in _SENT.split(text):
        parts.append((pos, pos + len(chunk), chunk))
        pos += len(chunk) + 1
    for start, end, chunk in parts:
        if start <= m.start() < end:
            out = chunk.strip()
            return out if len(out) <= limit else out[:limit].rsplit(" ", 1)[0] + "\u2026"
    return text[max(0, m.start() - 150):m.end() + 150].strip()


def key(player: str, url: str) -> tuple[str, str]:
    return (re.sub(r"[^a-z]", "", (player or "").lower()), (url or "").strip())


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--result", required=True, help="workflow output JSON")
    ap.add_argument("--journal", required=True, help="run journal.jsonl")
    ap.add_argument("--out", default=str(REPO / "data" / "analyst" / "verified_takes.json"))
    a = ap.parse_args()

    blob = json.loads(Path(a.result).read_text())
    res = blob.get("result", blob)
    verified = res.get("verified")
    if verified is None:
        raise SystemExit("no 'verified' key in the workflow result — refusing to "
                         "write an overlay from a shape I do not recognise.")

    # ── recover the attribution the flatten threw away ───────────────────────
    owner: dict[tuple[str, str], str] = {}
    for line in Path(a.journal).read_text().splitlines():
        if not line.strip():
            continue
        try:
            ev = json.loads(line)
        except json.JSONDecodeError:
            continue
        r = ev.get("result")
        if ev.get("type") != "result" or not isinstance(r, dict) or "takes" not in r:
            continue
        who = r.get("analyst")
        for t in (r.get("takes") or []):
            owner.setdefault(key(t.get("player", ""), t.get("source_url", "")), who)

    out, unattributed, flagged = [], 0, 0
    for t in verified:
        who = owner.get(key(t.get("player", ""), t.get("source_url", "")))
        why = t.get("why") or ""
        m = SPEAKER_DOUBT.search(why)
        doubt = bool(m)
        # Quote the verifier's own words rather than resolving the attribution
        # myself — the page can then show what the doubt actually is. Snap to
        # sentence boundaries: a fixed character window starts mid-word and
        # reads like a corrupted excerpt.
        caveat = _sentence_around(why, m) if m else None
        if who is None:
            unattributed += 1
        if doubt:
            flagged += 1
        out.append({
            "player": t.get("player"),
            "position": t.get("position"),
            "stance": t.get("stance"),
            "take": t.get("take"),
            "source_url": t.get("source_url"),
            "season": t.get("season"),
            # ⚠️ NEVER a guess. Either the sweep says who, or the page does.
            "analyst": who or "unattributed",
            "speaker_uncertain": doubt,
            "speaker_caveat": caveat,
        })

    Path(a.out).write_text(json.dumps(out, indent=1))
    players = len({t["player"] for t in out})
    print(f"wrote {a.out}")
    print(f"  {len(out)} verified takes on {players} players")
    print(f"  {unattributed} could not be re-joined to a sweep result "
          f"(emitted as 'unattributed', never guessed)")
    print(f"  {flagged} carry a speaker caveat in the verifier's own reasoning")
    print(f"  rejected by the verify pass: {len(res.get('rejected') or [])}; "
          f"dead ends: {len(res.get('dead_ends') or [])}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
