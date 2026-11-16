#!/usr/bin/env python3
"""Drop the free-text `comments` field from the MFL transactions rows in a daily snapshot file.

The daily snapshot (.github/workflows/mfl-daily-snapshot.yml) commits MFL's own exports under data/mfl-snapshots/<date>/.
Nothing that reads those files uses a trade's free-text note, so the transactions file is committed without it. Every other
field, the key order and the formatting are exactly what the workflow's own pretty-printer writes.

  python3 pipelines/etl/scripts/strip_snapshot_comments.py data/mfl-snapshots/<date>/transactions.json

Exit 0: the file now holds no `comments` key (or has no transactions block). Exit 1: unreadable file or a `comments` key
survived; the workflow stops before anything is committed.
"""
import json
import sys


def _strip(node):
    """Remove every `comments` key below `node`. Returns how many were removed."""
    removed = 0
    if isinstance(node, dict):
        if "comments" in node:
            del node["comments"]
            removed += 1
        for v in list(node.values()):
            removed += _strip(v)
    elif isinstance(node, list):
        for v in node:
            removed += _strip(v)
    return removed


def _has_comments(node):
    if isinstance(node, dict):
        return "comments" in node or any(_has_comments(v) for v in node.values())
    if isinstance(node, list):
        return any(_has_comments(v) for v in node)
    return False


def strip_comments(doc):
    """Strip `comments` from the transactions block only. Returns (document, removed_count). A document without a
    transactions block (for example MFL's error envelope) is returned untouched."""
    if not isinstance(doc, dict) or "transactions" not in doc:
        return doc, 0
    removed = _strip(doc["transactions"])
    if _has_comments(doc["transactions"]):
        raise ValueError("a comments key survived the strip")
    return doc, removed


def dumps(doc):
    """The exact serialization the daily snapshot workflow uses for every export file."""
    return json.dumps(doc, indent=2, sort_keys=True, ensure_ascii=True)


def main(argv):
    if len(argv) != 2:
        print("usage: strip_snapshot_comments.py <transactions.json>", file=sys.stderr)
        return 1
    path = argv[1]
    try:
        with open(path, "r", encoding="utf-8") as fh:
            doc = json.load(fh)
        doc, removed = strip_comments(doc)
    except (OSError, ValueError) as exc:
        print(f"strip_snapshot_comments: {exc.__class__.__name__}: {exc}", file=sys.stderr)
        return 1
    if removed:
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(dumps(doc))
    print(f"strip_snapshot_comments: removed {removed} comments field(s) from {path}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
