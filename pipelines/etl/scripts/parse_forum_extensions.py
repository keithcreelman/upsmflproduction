#!/usr/bin/env python3
"""Parse the forum contract archive into ups_extension_master rows.

Accuracy strategy: NEVER guess a player from an arbitrary name string. Instead,
for each (year, thread) iterate that year's ROSTERED players (a player being
extended was on a roster) and test whether each is mentioned in the thread by
last name + first name/initial. Extract the duration ("N year") and any salary
("$Nk", "yr1 = .. yr2 = ..") near the mention. Records where the duration is
unclear, or where the name is ambiguous among rostered players, are FLAGGED for
review and NOT emitted (no faking).

Input : docs/league_context/forum_contract_archive_2012_2017.json
Output: docs/league_context/forum_extensions_parsed.json  (+ a review report)

Convention matches migration 0060: new_contract_status = EXT1 (1-yr) / EXT2
(2-yr) by duration; extension_term_years = duration; new_salary NULL unless the
post states it; evidence_grade = evidenced (forum thread URL is the evidence).
"""
import json
import re
import sys
import urllib.request

WORKER = "https://upsmflproduction.keith-creelman.workers.dev"
LEAGUE_BY_YEAR = {2012: "37227", 2013: "42721", 2014: "30590", 2015: "29015", 2016: "27191", 2017: "74598"}
ARCHIVE = "docs/league_context/forum_contract_archive_2012_2017.json"
OUT = "docs/league_context/forum_extensions_parsed.json"


def fetch(url):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (ups-etl)"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)


def mfl(typ, year, extra=""):
    lid = LEAGUE_BY_YEAR[year]
    return fetch(f"{WORKER}/api/mfl-export?TYPE={typ}&L={lid}&YEAR={year}&JSON=1{extra}")


DUR_RE = re.compile(r"(\d+)\s*(?:-|\s)?\s*(?:yr|year)s?\b", re.I)
# salary tokens like $14k / 14k / 39K
SAL_RE = re.compile(r"\$?\s*(\d{1,3})\s*[kK]\b")


def rostered_players(year):
    """Return {pid: {'last','first','name','pos'}} for players rostered in `year`."""
    ros = mfl("rosters", year)
    pl = mfl("players", year)
    names = {p["id"]: (p.get("name", ""), p.get("position", "")) for p in pl.get("players", {}).get("player", [])}
    out = {}
    units = ros.get("rosters", {}).get("franchise", [])
    units = units if isinstance(units, list) else [units]
    for f in units:
        players = f.get("player", [])
        players = players if isinstance(players, list) else [players]
        for p in players:
            pid = p.get("id")
            if not pid or pid in out:
                continue
            nm, pos = names.get(pid, ("", ""))
            if "," not in nm:
                continue
            last, first = [x.strip() for x in nm.split(",", 1)]
            out[pid] = {"last": last, "first": first, "name": nm, "pos": pos}
    return out


def find_mention(text, last, first):
    """Index of a mention of this player (last name as a word, with first name
    or first-initial nearby), or -1. Returns (idx, strength)."""
    for m in re.finditer(r"\b" + re.escape(last) + r"\b", text, re.I):
        i = m.start()
        window = text[max(0, i - 24):i]  # text just before the surname
        if re.search(r"\b" + re.escape(first) + r"\b", window, re.I):
            return i, "full"
        if first and re.search(r"\b" + re.escape(first[0]) + r"\.?\s*$", window, re.I):
            return i, "initial"
        return i, "surname"  # bare surname match
    return -1, None


def nearby(regex, text, idx, span=60):
    seg = text[idx: idx + span]
    return regex.findall(seg)


def main():
    arch = json.load(open(ARCHIVE))["threads"]
    by_year = {}
    for t in arch:
        if t.get("kind") in ("extension", "midseason") and t.get("season"):
            by_year.setdefault(int(t["season"]), []).append(t)

    records, review = [], []
    for year in sorted(by_year):
        if year not in LEAGUE_BY_YEAR:
            continue
        try:
            ros = rostered_players(year)
        except Exception as e:
            sys.stderr.write(f"  {year} roster fetch failed: {e}\n")
            continue
        # group rostered players by last name (lowercase) for ambiguity checks
        by_last = {}
        for pid, info in ros.items():
            by_last.setdefault(info["last"].lower(), []).append(pid)

        for t in by_year[year]:
            text = (t.get("title", "") + " . " + t.get("body", "")).strip()
            if len(text) < 8:
                continue
            hits = []
            for pid, info in ros.items():
                idx, strength = find_mention(text, info["last"], info["first"])
                if idx < 0:
                    continue
                # bare-surname match is only safe when that surname is unique among rostered
                if strength == "surname" and len(by_last.get(info["last"].lower(), [])) > 1:
                    continue
                hits.append((idx, pid, info, strength))
            if not hits:
                review.append({"year": year, "tid": t["tid"], "title": t["title"], "body": t["body"][:160], "reason": "no rostered player matched"})
                continue
            # Clause-bound each player's terms: a player owns the text from their
            # mention up to the NEXT player's mention. Prevents salary/duration
            # bleed across players in multi-player franchise threads.
            hits.sort(key=lambda h: h[0])
            for hi, (idx, pid, info, strength) in enumerate(hits):
                clause_end = hits[hi + 1][0] if hi + 1 < len(hits) else len(text)
                clause = text[idx:clause_end]
                durs = DUR_RE.findall(clause)
                sals = [int(s) * 1000 for s in SAL_RE.findall(clause)]
                dur = int(durs[0]) if durs else None
                # Pre-2018 extensions are 1-2 yrs. Anything else (or none) → review,
                # not a guessed value.
                if dur not in (1, 2):
                    review.append({"year": year, "tid": t["tid"], "player": info["name"], "pid": pid, "reason": ("no clear 1-2yr duration" if dur is None else f"unexpected duration {dur}"), "clause": clause[:120]})
                    continue
                rec = {
                    "league_id": "74598",
                    "season": str(year),
                    "player_id": pid,
                    "player_name": info["name"],
                    "position": info["pos"],
                    "new_contract_status": f"EXT{dur}",
                    "new_salary": (sals[0] if sals else None),  # year-1 salary; clause-bounded
                    "extension_term_years": dur,
                    "new_contract_info": (", ".join(f"${s // 1000}k" for s in sals) if sals else None),
                    "evidence_grade": "evidenced",
                    "evidence_source": f"forum:{t['url']} match={strength}",
                    "source": "forum-mining:forum_contract_archive_2012_2017",
                }
                records.append(rec)

    # de-dupe to one row per (player, season): keep the longest-duration / most-salaried
    best = {}
    for r in records:
        k = (r["season"], r["player_id"])
        cur = best.get(k)
        score = (r["extension_term_years"] or 0, 1 if r["new_salary"] else 0)
        if not cur or score > (cur["extension_term_years"] or 0, 1 if cur["new_salary"] else 0):
            best[k] = r
    final = sorted(best.values(), key=lambda r: (r["season"], r["player_name"]))

    json.dump({"_meta": {"source": ARCHIVE, "convention": "0060 (EXT1=1yr, EXT2=2yr); salary NULL unless stated", "count": len(final)}, "rows": final}, open(OUT, "w"), indent=2)
    json.dump(review, open("/tmp/forum_ext_review.json", "w"), indent=2)
    print(f"Parsed {len(final)} confident extension rows -> {OUT}")
    print(f"  {len(review)} flagged for review -> /tmp/forum_ext_review.json")
    from collections import Counter
    print("  by season:", dict(sorted(Counter(r["season"] for r in final).items())))
    print("  with salary:", sum(1 for r in final if r["new_salary"]), "| salary NULL:", sum(1 for r in final if not r["new_salary"]))


if __name__ == "__main__":
    main()
