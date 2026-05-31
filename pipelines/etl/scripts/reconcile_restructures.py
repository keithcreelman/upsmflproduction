#!/usr/bin/env python3
"""Cross-confirm restructures from two independent sources and surface any
disagreement (Keith 2026-05-31):

  1. Discord (authoritative) — the bot's "Restructure Alert" posts, via
     GET /admin/discord/restructures (passed in as --discord <json>).
  2. MFL fingerprint — a contract-diff over 2023-2026 rosters: a dual-AAV token
     in any year, or a mid-contract TCV change with no new extension.

Player names are matched order-independently (Discord posts "Ja'Marr Chase";
MFL is "Chase, Ja'Marr") and a post's player is recovered from its raw embed
text when the structured Player field is absent. MFL-API-native; no local DB.
"""
import argparse, json, re, sys, urllib.request

LEAGUE = "74598"
SERVER = "https://www48.myfantasyleague.com"
SUFFIXES = {"jr", "sr", "ii", "iii", "iv", "v"}


def fetch(u):
    return json.load(urllib.request.urlopen(urllib.request.Request(u, headers={"User-Agent": "Mozilla/5.0"}), timeout=30))


def as_list(x):
    return [] if x is None else (x if isinstance(x, list) else [x])


def roster(yr):
    out = {}
    try:
        for f in as_list(fetch(f"{SERVER}/{yr}/export?TYPE=rosters&L={LEAGUE}&JSON=1")["rosters"]["franchise"]):
            for p in as_list(f.get("player")):
                out[str(p["id"])] = p.get("contractInfo", "") or ""
    except Exception as e:
        print(f"warn {yr}: {e}", file=sys.stderr)
    return out


def name_tokens(n):
    """Order-independent token set: lowercase alpha tokens, drop punctuation + suffixes."""
    toks = re.findall(r"[a-z]+", (n or "").lower())
    return frozenset(t for t in toks if t not in SUFFIXES)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--discord", required=True)
    ap.add_argument("--out")
    a = ap.parse_args()

    players = {p["id"]: p.get("name", "") for p in fetch(f"{SERVER}/2026/export?TYPE=players&L={LEAGUE}&JSON=1")["players"]["player"]}
    R = {y: roster(y) for y in (2023, 2024, 2025, 2026)}
    # roster name index: token-set -> display name (current players only)
    idx = {}
    for pid in R[2026]:
        nm = players.get(pid, pid)
        idx[name_tokens(nm)] = nm

    tcv = lambda ci: (float(m.group(1)) if (m := re.search(r"TCV\s*([\d.]+)K", ci or "")) else None)
    dual = lambda ci: bool(re.search(r"AAV\s*[\d.]+ ?K?,\s*[\d.]+ ?K?", ci or ""))
    ext = lambda ci: "Ext" in (ci or "")
    fp = {}
    for pid in R[2026]:
        sig = []
        for y in (2023, 2024, 2025, 2026):
            if dual(R[y].get(pid, "")):
                sig.append(f"{y}:dual-AAV")
        for a2, b2 in ((2023, 2024), (2024, 2025), (2025, 2026)):
            ca, cb = R[a2].get(pid, ""), R[b2].get(pid, "")
            if ca and cb and tcv(ca) and tcv(cb) and tcv(ca) != tcv(cb) and ext(ca) == ext(cb) and ext(cb):
                sig.append(f"{b2}:TCV {tcv(ca)}->{tcv(cb)}")
        if sig:
            fp[name_tokens(players.get(pid, pid))] = {"name": players.get(pid, pid), "sig": sig}

    disc = json.load(open(a.discord))
    drows = disc.get("restructures", []) if isinstance(disc, dict) else disc
    discord = {}
    unmatched = []
    for r in drows:
        key = None
        name = r.get("player")
        if name and name_tokens(name) in idx:
            key = name_tokens(name)
        else:
            # recover the player by scanning the raw embed/content text for a roster name
            raw = (str(r.get("raw") or "") + " " + str(r.get("player") or "")).lower()
            rawtok = set(re.findall(r"[a-z]+", raw))
            best = None
            for tk, disp in idx.items():
                if tk and tk <= rawtok:   # all of the player's name tokens appear in the post
                    if best is None or len(tk) > len(best[0]):
                        best = (tk, disp)
            if best:
                key, name = best
        if key:
            d = discord.setdefault(key, {"name": idx[key], "years": set()})
            d["years"].add(r.get("season"))
        else:
            unmatched.append({"player": r.get("player"), "raw": (r.get("raw") or "")[:90]})

    dn, fn = set(discord), set(fp)
    both, donly, fonly = (dn & fn), (dn - fn), (fn - dn)
    yrs = lambda s: sorted(y for y in s if y)
    by = lambda S, src: sorted((src[k]["name"] for k in S), key=str.lower)

    L = ["# Restructure reconcile — Discord (authoritative) vs. MFL fingerprint", ""]
    L.append(f"Discord posts matched to a current player: **{len(dn)}** · fingerprint: **{len(fn)}** · agree on **{len(both)}**. "
             f"Unmatched Discord posts: {len(unmatched)}.")
    L.append(f"\n## ✅ Confirmed by BOTH ({len(both)})")
    for k in sorted(both, key=lambda k: discord[k]["name"].lower()):
        L.append(f"- **{discord[k]['name']}** — Discord {yrs(discord[k]['years'])} · fingerprint `{fp[k]['sig']}`")
    L.append(f"\n## ⚠️ Discord ONLY — bot posted a restructure, fingerprint didn't flag ({len(donly)})")
    L.append("_Structure didn't visibly change, or the fingerprint missed it — verify._")
    for k in sorted(donly, key=lambda k: discord[k]["name"].lower()):
        L.append(f"- **{discord[k]['name']}** — Discord {yrs(discord[k]['years'])}")
    L.append(f"\n## ⚠️ Fingerprint ONLY — structural change, no bot post ({len(fonly)})")
    L.append("_Likely a **loaded** auction contract (dual-AAV is normal there), or an **unposted** restructure._")
    for k in sorted(fonly, key=lambda k: fp[k]["name"].lower()):
        L.append(f"- **{fp[k]['name']}** — `{fp[k]['sig']}`")
    if unmatched:
        L.append(f"\n## ℹ️ Discord posts not matched to a current roster player ({len(unmatched)})")
        L.append("_Old players no longer rostered, or a name the matcher couldn't resolve._")
        for u in unmatched[:30]:
            L.append(f"- player={u['player']!r} raw=`{u['raw']}`")
    rep = "\n".join(L)
    print(rep)
    if a.out:
        open(a.out, "w").write(rep)


if __name__ == "__main__":
    main()
