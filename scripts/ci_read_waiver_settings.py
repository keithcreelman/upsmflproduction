#!/usr/bin/env python3
"""Dump the FORM STATE of MFL's waiver setup pages.

Neither setting is in the API: TYPE=league gives bbidTiebreaker='SORT' but
never says what the sort IS, and there is no waiverOrder export. These pages
are the only source, and they need the commish cookie.

Prints selected <option>s, checked inputs, and ordered <select> contents —
i.e. what the league is ACTUALLY set to, not the menu of what it could be.
"""
import html
import re
import sys


def txt(v: str) -> str:
    return re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", v or ""))).strip()


def auth_state(page: str) -> str:
    m = re.search(r'class="welcome"[^>]*>(.{0,400}?)</td>', page, re.S | re.I)
    if not m:
        return "unreadable"
    if re.search(r"\bGuest\b", m.group(1), re.I) or re.search(r"/login\?", m.group(1), re.I):
        return "guest"
    return "authenticated: " + txt(m.group(1))[:60]


def dump(path: str) -> None:
    page = open(path, encoding="utf-8", errors="replace").read()
    name = path.split("/")[-1].replace(".html", "")
    state = auth_state(page)
    print(f"\n{'='*72}\n{name}   ({len(page):,} bytes)   auth: {state}")
    if state in ("guest", "unreadable"):
        # A signed-out setup page renders empty; that is NOT "no settings".
        print("  !! not authenticated — cannot read settings. Skipping.")
        return

    # SELECTs: report the SELECTED option, and the full order when it looks
    # like a ranked list (the custom waiver order is exactly that).
    for sel in re.finditer(r"<select\b([^>]*)>(.*?)</select>", page, re.S | re.I):
        attrs, body = sel.group(1), sel.group(2)
        nm = (re.search(r'name="([^"]+)"', attrs) or [None, "?"])[1]
        opts = re.findall(r"<option\b([^>]*)>(.*?)</option>", body, re.S | re.I)
        chosen = [txt(o[1]) for o in opts if re.search(r"\bselected\b", o[0], re.I)]
        print(f"\n  SELECT {nm}  ({len(opts)} options)")
        if chosen:
            print(f"    SELECTED: {chosen}")
        else:
            print("    SELECTED: (none marked)")

    # Checked radios/checkboxes and populated text inputs.
    print("\n  INPUTS (checked / non-empty):")
    any_input = False
    for inp in re.finditer(r"<input\b([^>]*)>", page, re.I):
        a = inp.group(1)
        nm = (re.search(r'name="([^"]+)"', a) or [None, ""])[1]
        if not nm or re.search(r'type="(hidden|submit|button)"', a, re.I):
            continue
        val = (re.search(r'value="([^"]*)"', a) or [None, ""])[1]
        checked = bool(re.search(r"\bchecked\b", a, re.I))
        typ = (re.search(r'type="([^"]+)"', a) or [None, "text"])[1].lower()
        if typ in ("radio", "checkbox"):
            if checked:
                any_input = True
                print(f"    [x] {nm} = {val!r}")
        elif val:
            any_input = True
            print(f"    {nm} = {val!r}")
    if not any_input:
        print("    (none)")

    # FULL form recon — every field a write would have to reproduce, hidden
    # ones included. MFL setup forms post the WHOLE form back, so a write that
    # omits a field silently blanks it; this is the inventory that makes a
    # settings write reviewable BEFORE it runs.
    for f in re.finditer(r"<form\b([^>]*)>", page, re.I):
        a = f.group(1)
        act = (re.search(r'action="([^"]*)"', a) or [None, ""])[1]
        mth = (re.search(r'method="([^"]*)"', a) or [None, "GET"])[1]
        if act:
            print(f"\n  FORM action={act!r} method={mth.upper()}")
    hidden = re.findall(r'<input\b[^>]*type="hidden"[^>]*>', page, re.I)
    if hidden:
        print(f"\n  HIDDEN FIELDS ({len(hidden)}):")
        for h in hidden[:25]:
            nm = (re.search(r'name="([^"]+)"', h) or [None, "?"])[1]
            vl = (re.search(r'value="([^"]*)"', h) or [None, ""])[1]
            print(f"    {nm} = {vl[:60]!r}")
    named = sorted({(re.search(r'name="([^"]+)"', t) or [None, ""])[1]
                    for t in re.findall(r"<(?:input|select|textarea)\b[^>]*>", page, re.I)} - {""})
    if named:
        print(f"\n  ALL FIELD NAMES ({len(named)}): {named}")

    # Ordered rows — the custom waiver order renders as a table of franchises.
    rows = []
    for tr in re.findall(r"<tr\b.*?</tr>", page, re.S | re.I):
        cells = [txt(c) for c in re.findall(r"<t[dh][^>]*>(.*?)</t[dh]>", tr, re.S | re.I)]
        cells = [c for c in cells if c]
        if 2 <= len(cells) <= 4:
            rows.append(cells)
    if rows:
        print(f"\n  TABLE ROWS ({len(rows)}) — first 20:")
        for r in rows[:20]:
            print(f"    {r}")


if __name__ == "__main__":
    for p in sys.argv[1:]:
        dump(p)
