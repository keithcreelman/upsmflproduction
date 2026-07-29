"""Scrape MFL's O=102 "Auction Results - Details" for every UPS season.

O=102 is the ONLY source that covers 2012-2013 — MFL's AUCTION_BID transaction
log doesn't start until 2014, and no per-player bid ladder survives for the
earliest years (O=44 is a summary; O=43 302s on a closed season).

Per row O=102 gives: player (+ player_id via the href), winning bid, proxy bid,
winning franchise (+ franchise_id via the href), auction start, last bid.
"""
import datetime
import html as H
import json
import os
import re
import subprocess
import sys

SP = os.path.dirname(os.path.abspath(__file__))
CACHE = os.path.join(SP, "o102_cache")
os.makedirs(CACHE, exist_ok=True)

UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")

# season -> (server, league_id) from D1 mfl_league_years
LEAGUES = {
    2012: ("www45", 37227), 2013: ("www46", 42721), 2014: ("www45", 30590),
    2015: ("www44", 29015), 2016: ("www48", 27191), 2017: ("www48", 74598),
    2018: ("www48", 74598), 2019: ("www48", 74598), 2020: ("www48", 74598),
    2021: ("www48", 74598), 2022: ("www48", 74598), 2023: ("www48", 74598),
    2024: ("www48", 74598), 2025: ("www48", 74598), 2026: ("www48", 74598),
}

MONTHS = {m: i for i, m in enumerate(
    ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"], 1)}


def fetch(season):
    path = os.path.join(CACHE, f"o102_{season}.html")
    if os.path.exists(path) and os.path.getsize(path) > 5000:
        return open(path, encoding="utf-8", errors="replace").read()
    srv, lid = LEAGUES[season]
    url = f"https://{srv}.myfantasyleague.com/{season}/options?L={lid}&O=102"
    out = subprocess.run(["curl", "-sS", "-m", "60", "-A", UA, url],
                         capture_output=True, text=True, timeout=90)
    open(path, "w").write(out.stdout)
    return out.stdout


def strip(s):
    return H.unescape(re.sub(r"<[^>]+>", "", s)).strip()


def parse_dt(s, season):
    """'Sun Aug 5 7:01 a.m.' -> unix (ET assumed; MFL renders league-local).

    No year in the string, so the season supplies it. Auctions run Jul-Aug, so
    there's no year-boundary ambiguity to worry about.
    """
    s = s.replace("\xa0", " ").strip()
    if not s:
        return None
    m = re.search(r"([A-Z][a-z]{2})\s+(\d{1,2})\s+(\d{1,2}):(\d{2})\s*([ap])\.?m\.?", s)
    if not m:
        # 'noon' / 'midnight' variants MFL sometimes emits
        m2 = re.search(r"([A-Z][a-z]{2})\s+(\d{1,2})\s+(noon|midnight)", s)
        if not m2:
            return None
        mon, day, kind = m2.group(1), int(m2.group(2)), m2.group(3)
        hh = 12 if kind == "noon" else 0
        mi = 0
    else:
        mon, day, hh, mi, ap = m.group(1), int(m.group(2)), int(m.group(3)), int(m.group(4)), m.group(5)
        if ap == "p" and hh != 12:
            hh += 12
        if ap == "a" and hh == 12:
            hh = 0
    mo = MONTHS.get(mon)
    if not mo:
        return None
    # SENTINEL GUARD: when MFL has no timestamp it renders the Unix epoch as
    # "Wed Dec 31 7:00 p.m." (epoch 0 in ET). Every 2016 "Auction Started" cell
    # is that sentinel. UPS auctions only ever run May (ERA) through Aug (FAA),
    # so anything outside that window is missing data, not a real date.
    if mo not in (5, 6, 7, 8):
        return None
    # ET = UTC-4 across the May-Aug auction window (EDT)
    dt = datetime.datetime(season, mo, day, hh, mi, tzinfo=datetime.timezone(datetime.timedelta(hours=-4)))
    return int(dt.timestamp())


def money(s):
    d = re.sub(r"[^\d]", "", s or "")
    return int(d) if d else None


def parse_season(season):
    html = fetch(season)
    tables = re.findall(r"<table.*?</table>", html, re.S | re.I)
    if not tables:
        return []
    tables.sort(key=lambda t: len(re.findall(r"<tr", t, re.I)), reverse=True)
    rows = re.findall(r"<tr.*?</tr>", tables[0], re.S | re.I)
    out = []
    for r in rows:
        tds = re.findall(r"<td[^>]*>(.*?)</td>", r, re.S | re.I)
        if len(tds) < 6:
            continue
        pid_m = re.search(r"[?&]P=(\d+)", tds[0])
        # NOTE the href is HTML-encoded (`&amp;F=0004`), so the char before F is
        # ';' not '&' — matching on [?&] silently found zero franchises.
        fid_m = re.search(r"\bF=(\d{1,4})\b", tds[3])
        if not pid_m:
            continue
        label = strip(tds[0])           # 'Anderson, James CAR LB'
        pos = label.split()[-1] if label else ""
        out.append({
            "season": season,
            "league_id": str(LEAGUES[season][1]),
            "player_id": pid_m.group(1),
            "player_label": label,
            "position": pos,
            "winning_bid": money(strip(tds[1])),
            "proxy_bid": money(strip(tds[2])),
            "winner_fid": (fid_m.group(1).zfill(4) if fid_m else None),
            "winner_team_label": strip(tds[3]),
            "started_raw": strip(tds[4]),
            "last_bid_raw": strip(tds[5]),
            "comments": strip(tds[6]) if len(tds) > 6 else "",
            "started_unix": parse_dt(strip(tds[4]), season),
            "last_bid_unix": parse_dt(strip(tds[5]), season),
        })
    return out


if __name__ == "__main__":
    allrows = []
    print(f"{'season':>7} {'rows':>5} {'w/pid':>6} {'w/fid':>6} {'w/times':>8} {'kinds(month)'}")
    for s in sorted(LEAGUES):
        rs = parse_season(s)
        okp = sum(1 for r in rs if r["player_id"])
        okf = sum(1 for r in rs if r["winner_fid"])
        okt = sum(1 for r in rs if r["started_unix"] and r["last_bid_unix"])
        months = {}
        for r in rs:
            if r["started_unix"]:
                mo = datetime.datetime.fromtimestamp(r["started_unix"], datetime.UTC).strftime("%m")
                months[mo] = months.get(mo, 0) + 1
        print(f"{s:>7} {len(rs):>5} {okp:>6} {okf:>6} {okt:>8}  {dict(sorted(months.items()))}")
        allrows.extend(rs)
    json.dump(allrows, open(os.path.join(SP, "o102_parsed.json"), "w"), indent=1)
    print(f"\ntotal parsed rows: {len(allrows)} -> o102_parsed.json")
