#!/usr/bin/env python3
"""Scan MFL's "Previously Processed Waivers" pages for the most CONTESTED claims.

Why this exists: MFL has no export for denied waiver claims. This page is the
only source that carries both the denial and MFL's own "Reason Not Granted"
text, and it is league-wide. We want the busiest real run in league history —
most requests, and especially most TEAMS on one player — because that is the
case the Discord report design has to survive (Keith 2026-08-20).

Takes one or more saved HTML pages (fetched with the commish cookie) and
prints, per season: the table shape, then the players drawing the most
competing requests.

FAILS LOUD on a signed-out page. MFL serves HTTP 200 with the report section
EMPTY when unauthenticated, which is indistinguishable from "no claims" unless
you check — the same trap the worker route guards against.
"""
import html
import re
import sys
from collections import Counter, defaultdict


def strip_tags(v: str) -> str:
    """Text of a cell — falling back to image metadata when there is no text.

    The Franchise column renders as a franchise LOGO, not a name, so a naive
    tag-strip returns "" and the report looks franchise-less. That is what made
    an earlier read of this page look like it was scoped to one team when it is
    in fact league-wide (Keith 2026-08-21: "You can see this from the report
    whether you're commish or not"). Recover the name from alt/title, or the
    fid from the icon filename (…74598_franchise_icon0005.jpg -> 0005).
    """
    raw = v or ""
    text = re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", raw))).strip()
    if text:
        return text
    for attr in ("alt", "title"):
        m = re.search(rf'{attr}="([^"]+)"', raw, re.I)
        if m and m.group(1).strip():
            return html.unescape(m.group(1)).strip()
    m = re.search(r"franchise_(?:icon|logo)(\d{4})", raw, re.I)
    if m:
        return f"fid:{m.group(1)}"
    return ""


def auth_state(page: str) -> str:
    m = re.search(r'class="welcome"[^>]*>(.{0,400}?)</td>', page, re.S | re.I)
    if not m:
        return "unreadable"
    cell = m.group(1)
    if re.search(r"\bGuest\b", cell, re.I) or re.search(r"/login\?", cell, re.I):
        return "guest"
    return "authenticated:" + strip_tags(cell)[:60]


def tables(page: str):
    i = page.find('id="processed_waivers"')
    if i < 0:
        return []
    region = page[i:]
    region = re.sub(r"<script.*?</script>", "", region, flags=re.S | re.I)
    region = re.sub(r"<style.*?</style>", "", region, flags=re.S | re.I)
    out = []
    for t in re.findall(r"<table.*?</table>", region, re.S | re.I):
        rows = []
        for tr in re.findall(r"<tr.*?</tr>", t, re.S | re.I):
            cells = [strip_tags(c) for c in re.findall(r"<t[dh][^>]*>(.*?)</t[dh]>", tr, re.S | re.I)]
            if any(cells):
                rows.append(cells)
        if rows:
            out.append(rows)
    return out


def scan(path: str) -> None:
    season = re.search(r"(\d{4})", path)
    season = season.group(1) if season else path
    page = open(path, encoding="utf-8", errors="replace").read()

    state = auth_state(page)
    print(f"\n{'=' * 72}\nSEASON {season}   ({len(page):,} bytes)   auth: {state}")
    if state == "guest":
        print("  !! SIGNED OUT — report renders empty. This is NOT 'no claims'. Skipping.")
        return
    if state == "unreadable":
        print("  !! Could not read MFL's identity cell — auth state unknown. Skipping.")
        return

    tbls = tables(page)
    print(f"  tables in report region: {len(tbls)}")
    if not tbls:
        print("  (no report tables — league may have run no waivers this season)")
        return

    for ti, rows in enumerate(tbls):
        widths = Counter(len(r) for r in rows)
        print(f"\n  --- table {ti}: {len(rows)} rows, cell-count distribution {dict(widths)} ---")
        for r in rows[:3]:
            print(f"      {r}")
        if len(rows) > 3:
            print(f"      ... {len(rows) - 3} more")

    # Contested analysis on the widest table (the real report).
    rows = max(tbls, key=len)
    if len(rows) < 2:
        return
    header = rows[0]
    body = rows[1:]
    print(f"\n  HEADER: {header}")

    # Find the column most likely to hold a player name: the one whose values
    # repeat across rows (several teams chasing the same guy) while not being
    # the franchise column. Reported rather than assumed — the real column
    # mapping gets pinned once this output is read.
    ncols = max(len(r) for r in body)
    print(f"\n  per-column distinct-value counts over {len(body)} rows:")
    for c in range(ncols):
        vals = [r[c] for r in body if len(r) > c and r[c]]
        if not vals:
            continue
        top = Counter(vals).most_common(3)
        name = header[c] if c < len(header) else f"col{c}"
        print(f"    [{c}] {name[:28]:<28} distinct={len(set(vals)):<4} top={top}")

    print("\n  MOST-CONTESTED (value repeated most within a column, excluding col0):")
    for c in range(1, ncols):
        vals = [r[c] for r in body if len(r) > c and r[c]]
        if not vals:
            continue
        common = Counter(vals).most_common(5)
        multi = [(v, n) for v, n in common if n > 1]
        if multi:
            name = header[c] if c < len(header) else f"col{c}"
            print(f"    [{c}] {name[:28]}: " + ", ".join(f"{v!r}×{n}" for v, n in multi[:5]))


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("usage: ci_processed_waivers_scan.py <page.html> [...]")
        raise SystemExit(2)
    for p in sys.argv[1:]:
        scan(p)
