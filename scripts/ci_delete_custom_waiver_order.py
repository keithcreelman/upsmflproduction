#!/usr/bin/env python3
"""Remove MFL's CUSTOM waiver order once Week 1's Sunday run is done.

Keith 2026-08-21: "Delete after Week 1 Sunday Waiver Run at 9AM ... so let's
do Sunday at 8 PM." Until then the league uses a manual order (prior year's
draft finish); after it, waivers follow WAIVER_SORT_* (All-Play % first).

MFL has no settings API. WAIVORD is its own small form — 20 fields, only the
waiver order — so unlike BBIDWAIV a write here cannot blank the BBID sort or
the per-franchise adjustments. It carries `input_expires`, a nonce that must
be scraped fresh and posted back promptly, so this is load -> post in one go.

FAIL-CLOSED THROUGHOUT:
  - not authenticated as Commissioner   -> refuse (an owner-mode page renders
    a different body entirely, and would look like "no custom order")
  - form/nonce unreadable               -> refuse
  - no custom order in effect           -> no-op, exit 0 (re-runs are safe)
  - after writing, RE-READ and confirm  -> a POST that 200s proves nothing
"""
import html
import re
import sys
import urllib.parse


def txt(v):
    return re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", v or ""))).strip()


def is_commissioner(page):
    m = re.search(r'class="welcome"[^>]*>(.{0,400}?)</td>', page, re.S | re.I)
    if not m:
        return None                      # unknown, never assume
    cell = txt(m.group(1))
    # Test the ACTION LINK, not the word: owner mode reads
    #   "Real Deal Creel ( Logout | Become Commissioner )"
    # which contains "Commissioner" as a substring and passed a naive check.
    # Commish mode is the only state offering "Become Owner".
    if re.search(r"Become\s+Owner", cell, re.I):
        return True
    if re.search(r"Become\s+Commissioner", cell, re.I):
        return False
    return None                          # neither link — can't tell, refuse


def order_rows(page):
    """The franchises currently in the custom order, by rank."""
    rows = []
    for tr in re.findall(r"<tr\b.*?</tr>", page, re.S | re.I):
        cells = [txt(c) for c in re.findall(r"<t[dh][^>]*>(.*?)</t[dh]>", tr, re.S | re.I)]
        cells = [c for c in cells if c and c not in ("▲", "▼")]
        if len(cells) == 2 and cells[0].isdigit():
            rows.append((int(cells[0]), cells[1]))
    return sorted(rows)


def hidden_fields(page):
    out = {}
    for h in re.findall(r"<input\b[^>]*type=\"hidden\"[^>]*>", page, re.I):
        n = re.search(r'name="([^"]+)"', h)
        v = re.search(r'value="([^"]*)"', h)
        if n:
            out[n.group(1)] = v.group(1) if v else ""
    return out


def main(path, out_body):
    page = open(path, encoding="utf-8", errors="replace").read()

    auth = is_commissioner(page)
    if auth is None:
        print("REFUSE: could not read MFL's identity cell — auth state unknown.")
        return 2
    if not auth:
        print("REFUSE: not in Commissioner mode. Owner mode serves a different "
              "page body, which would read as 'no custom order'.")
        return 2
    print("auth: Commissioner ✅")

    fields = hidden_fields(page)
    if fields.get("form_name") != "WAIVORD" or not fields.get("input_expires"):
        print(f"REFUSE: WAIVORD form/nonce not found (form_name={fields.get('form_name')!r}).")
        return 2

    rows = order_rows(page)
    if not rows:
        print("NO-OP: no custom waiver order in effect — nothing to delete.")
        return 0
    print(f"custom order in effect ({len(rows)} teams):")
    for rank, name in rows:
        print(f"    {rank:>2}  {name}")

    # Post the form back with the delete box ticked. Every hidden field is
    # echoed so nothing this form owns gets blanked.
    body = dict(fields)
    body["DELETE_CUSTOM"] = "1"
    body["SUBMIT"] = "Save Custom Waiver Order"
    encoded = urllib.parse.urlencode(body)
    open(out_body, "w").write(encoded)
    print(f"\nPOST body ({len(body)} fields) written to {out_body}")
    print("  " + "\n  ".join(f"{k} = {v!r}" for k, v in sorted(body.items())))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1], sys.argv[2]))
