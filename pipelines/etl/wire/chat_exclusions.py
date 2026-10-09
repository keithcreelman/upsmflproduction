#!/usr/bin/env python3
"""League chat that must never reach a pack, a draft, a preview or a review copy.

Keith 2026-10-08: "The automated preview still exposes the excluded injury post in its
editor candidates. Filter it before generating or committing packs and previews."

Two layers, both applied wherever chat is read for publication material:
  1. site/wire/data/chat_exclusions.json -- message ids an editor has ruled out
     (ids only; the text never enters the repo). Authoritative: matched by id.
  2. a pattern net for what the owner dossier says is never material -- family,
     health, recovery -- plus crude sexual and graphic-injury lines. A safety net,
     not a replacement for (1): a ruled-out message is listed by id.
  3. private terms (owners' family members' names) from a LOCAL-ONLY file next to the
     gitignored owner dossier -- never in this public file. Optional: (1) still holds
     without it, and `private_terms()` reports whether it loaded.
A missing or unreadable exclusions list raises: it never silently allows everything.
Used by wire_data.week_quotes (pack auto-picks), weekly_recap's editor picks
(fail closed), ups_center_issue (candidates) and ups_center_validate.
"""
import json
import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))
PATH = os.path.abspath(os.path.join(HERE, "..", "..", "..", "site", "wire", "data", "chat_exclusions.json"))

PRIVATE_FILE = "chat_exclusion_terms.local.json"     # {"terms": ["..."]}; gitignored with the dossier
PRIVATE_DIRS = (os.path.abspath(os.path.join(HERE, "..", "data", "bot")),        # this checkout (if it has one)
                os.path.expanduser("~/Code/MFL/upsmflproduction/pipelines/etl/data/bot"))  # the main checkout

PATTERN = re.compile(
    r"\b(wife|husband|daughter|son|sons|kid|kids|child|children|mom|mother|dad|father|girlfriend|boyfriend|family|"
    r"funeral|cancer|hospital|surgery|sober|sobriety|rehab|died|passed away|"
    r"vagina\w*|penis|genital\w*|testicl\w*|"
    r"shredded|acl|mcl|pcl|career[- ]ending|broken (?:leg|neck|back))\b", re.I)


def excluded_ids(path=PATH):
    doc = json.load(open(path, encoding="utf-8"))          # missing/unreadable -> raise (fail closed)
    msgs = doc["messages"]
    if not isinstance(msgs, list) or any("message_id" not in m for m in msgs):
        raise ValueError("%s: every entry needs a message_id" % path)
    return {str(m["message_id"]): m.get("category", "excluded") for m in msgs}


def private_terms(dirs=None):
    """(compiled pattern or None, path loaded or None)."""
    env = os.environ.get("UPSMFL_PRIVATE_DIR")
    for d in ([env] if env else []) + list(dirs or PRIVATE_DIRS):
        f = os.path.join(d, PRIVATE_FILE)
        if os.path.exists(f):
            terms = [t.strip() for t in json.load(open(f, encoding="utf-8")).get("terms", []) if t.strip()]
            if terms:
                return re.compile(r"\b(%s)\b" % "|".join(re.escape(t) for t in terms), re.I), f
            return None, f
    return None, None


_PRIVATE = None


def reason(message_id, text, ids=None, cleared=False):
    """Why a message may not be used, or None. `cleared`: an editor's explicit pick
    (weekly_recap `clearedPattern`) may clear a PATTERN-only match -- the net also catches
    NFL injury news ("season-ending surgery") -- but never an id ruling or a private name."""
    global _PRIVATE
    ids = excluded_ids() if ids is None else ids
    if str(message_id) in ids:
        return "excluded by id (%s)" % ids[str(message_id)]
    flat = " ".join((text or "").split())
    if _PRIVATE is None:
        _PRIVATE = private_terms()
    if _PRIVATE[0] is not None and _PRIVATE[0].search(flat):
        return "names someone the owner dossier puts off limits"
    if PATTERN.search(flat) and not cleared:
        return "matches the never-material pattern (an editor may clear an NFL-news false positive with clearedPattern)"
    return None


def keep(rows, id_key="message_id", text_key="content"):
    """(usable rows, number withheld)."""
    ids = excluded_ids()
    out = [r for r in rows if not reason(r.get(id_key), r.get(text_key), ids)]
    return out, len(rows) - len(out)
