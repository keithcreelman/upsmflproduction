#!/usr/bin/env python3
"""Cross-confirm restructures from two independent sources and surface any
disagreement (Keith 2026-05-31):

  1. Discord (authoritative) — the bot's own "Restructure Alert" posts, via
     GET /admin/discord/restructures (passed in as --discord <json>).
  2. MFL fingerprint — a contract-diff over 2023-2026 rosters: a dual-AAV token
     in any year, or a mid-contract TCV change with no new extension.

Buckets: confirmed-by-both, Discord-only (posted but no structural signal →
verify), fingerprint-only (structural change but no bot post → a loaded contract
OR an unposted restructure). MFL-API-native; no local DB.
"""
import argparse, json, re, sys, urllib.request

LEAGUE = "74598"
SERVER = "https://www48.myfantasyleague.com"


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


def norm(n):
    return re.sub(r"\s+", " ", (n or "").strip()).lower()


def fingerprint():
    players = {p["id"]: p.get("name", "") for p in fetch(f"{SERVER}/2026/export?TYPE=players&L={LEAGUE}&JSON=1")["players"]["player"]}
    R = {y: roster(y) for y in (2023, 2024, 2025, 2026)}
    tcv = lambda ci: (float(m.group(1)) if (m := re.search(r"TCV\s*([\d.]+)K", ci or "")) else None)
    dual = lambda ci: bool(re.search(r"AAV\s*[\d.]+ ?K?,\s*[\d.]+ ?K?", ci or ""))
    ext = lambda ci: "Ext" in (ci or "")
    fp = {}
    for pid in R[2026]:
        name = players.get(pid, pid)
        sig = []
        for y in (2023, 2024, 2025, 2026):
            if dual(R[y].get(pid, "")):
                sig.append(f"{y}:dual-AAV")
        for a, b in ((2023, 2024), (2024, 2025), (2025, 2026)):
            ca, cb = R[a].get(pid, ""), R[b].get(pid, "")
            if ca and cb and tcv(ca) and tcv(cb) and tcv(ca) != tcv(cb) and ext(ca) == ext(cb) and ext(cb):
                sig.append(f"{b}:TCV {tcv(ca)}->{tcv(cb)}")
        if sig:
            fp[name] = sig
    return fp


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--discord", required=True, help="JSON from /admin/discord/restructures")
    ap.add_argument("--out")
    a = ap.parse_args()

    disc = json.load(open(a.discord))
    drows = disc.get("restructures", []) if isinstance(disc, dict) else disc
    discord = {}
    for r in drows:
        p = r.get("player")
        if p:
            discord.setdefault(norm(p), {"name": p, "years": set()})["years"].add(r.get("season"))

    fp = fingerprint()
    fpn = {norm(k): k for k in fp}
    dn, fn = set(discord), set(fpn)
    both, donly, fonly = sorted(dn & fn), sorted(dn - fn), sorted(fn - dn)

    def yrs(s):
        return sorted(y for y in s if y)

    L = ["# Restructure reconcile — Discord (authoritative) vs. MFL fingerprint", ""]
    L.append(f"Discord posts: **{len(dn)}** players · fingerprint: **{len(fn)}** players · agree on **{len(both)}**.")
    L.append(f"\n## ✅ Confirmed by BOTH ({len(both)})")
    for k in both:
        L.append(f"- **{discord[k]['name']}** — Discord {yrs(discord[k]['years'])} · fingerprint `{fp[fpn[k]]}`")
    L.append(f"\n## ⚠️ Discord ONLY — bot posted a restructure, fingerprint didn't flag ({len(donly)})")
    L.append("_Either the structure didn't visibly change, or the fingerprint missed it — verify._")
    for k in donly:
        L.append(f"- **{discord[k]['name']}** — Discord {yrs(discord[k]['years'])}")
    L.append(f"\n## ⚠️ Fingerprint ONLY — structural change, no bot post ({len(fonly)})")
    L.append("_Likely a **loaded** auction contract (dual-AAV is normal there), or an **unposted** restructure — Keith's call._")
    for k in fonly:
        L.append(f"- **{fpn[k]}** — `{fp[fpn[k]]}`")
    rep = "\n".join(L)
    print(rep)
    if a.out:
        open(a.out, "w").write(rep)


if __name__ == "__main__":
    main()
