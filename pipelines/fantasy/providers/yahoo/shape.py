"""Yahoo Fantasy JSON shape normalizer.

⚠️ READ THIS BEFORE CHANGING ANYTHING HERE. Yahoo's JSON is a mechanical
XML→JSON transform and it has two pathologies that compound. Every wrapper
library in every language ships its own version of this file; that is how bad
it is. Getting it wrong does not raise — it silently returns fewer rows.

PATHOLOGY 1 — COLLECTIONS ARE OBJECTS, NOT ARRAYS.
A collection of N things serializes as an object whose keys are the numeric
STRINGS "0".."N-1", plus a sibling "count" integer:

    "players": {"0": {...}, "1": {...}, "count": 2}

So `for p in players` iterates the strings "0", "1", "count", and any code that
treats it as a list gets nothing. `count` is a sibling key, not an element, and
must be skipped — including it produces a phantom trailing element that is an
integer where a dict was expected.

PATHOLOGY 2 — RESOURCES ARE HETEROGENEOUS ARRAYS AT SHIFTING INDICES.
A resource serializes as an ARRAY mixing flat metadata dicts and nested
sub-resource objects:

    "player": [ {...meta...}, {"selected_position": {...}}, {"player_stats": {...}} ]

Index 0 is *usually* the metadata dict — but the positions shift depending on
which sub-resources were requested. Hardcoding `[1]` is the single most common
bug in Yahoo client code. This module never indexes positionally: it merges
every dict member and pulls named sub-resources out by key.

PATHOLOGY 3 — SINGLE-ELEMENT COLLAPSE.
A collection with exactly one element sometimes serializes as a bare object
rather than the {"0": ..., "count": 1} wrapper. `eligible_positions`,
`bye_weeks`, `team_logos`, `managers` and `transaction_data` on trades are the
usual offenders. Everything that can be plural goes through `as_list`.

PATHOLOGY 4 — TYPES ARE UNRELIABLE.
Numeric values arrive as strings far more often than not, and inconsistently
within a single object: `"waiver_priority": 4` (int) can sit beside
`"number_of_moves": "19"` (string). Booleans are "0"/"1" strings. Percentages
arrive with a LEADING DOT — `"percentage": ".571"` — which `int()` and a naive
`parseInt` both choke on. Every field is coerced explicitly at this boundary;
nothing downstream may rely on the wire type.

PATHOLOGY 6 — SUB-RESOURCES HIDE UNDER A NUMERIC WRAPPER KEY.
When a resource serializes as an OBJECT rather than an array, its scalar metadata
stays at the top level while its sub-resource COLLECTIONS are pushed one level
down under the numeric-string key "0" (and "1", "2"… when several were
requested):

    "roster": {"coverage_type": "week", "week": "5", "is_editable": 0,
               "0": {"players": {"0": {...}, "count": 9}}}
    "scoreboard": {"0": {"matchups": {...}}, "week": "15"}
    "matchup":  {"week": "15", …, "0": {"teams": {...}}}

This is the same array-of-mixed-members idea as pathology 2, expressed as an
object, and `flatten_resource` does NOT reach it — it merges the members of an
ARRAY, not the numeric-key children of an OBJECT. So a plain
`get(roster, "players")` returns MISSING, `as_list(MISSING)` yields nothing, and
the parse produces ZERO ROWS WITHOUT RAISING. Published wrappers all encode the
wrapper positionally (yfpy's key path for a team roster is literally
["team","roster","0","players"]); `subresource()` below finds it by name
instead, so a payload that omits the wrapper works identically.

PATHOLOGY 5 — EMPTY IS NOT MISSING.
Yahoo emits self-closing empty elements for known-but-unset fields, which become
"" in JSON: `<renew/>` → `"renew": ""`. A field that is genuinely inapplicable
is ABSENT entirely. Those are different claims — an empty `renew` means "this
league was not renewed" (real information) while an absent one means "this
sub-resource did not return it". `MISSING` distinguishes them and callers decide;
this module never coalesces "" to None on their behalf.
"""

from __future__ import annotations

from typing import Any, Iterable, Iterator


class _Missing:
    """Sentinel for 'the key was absent', distinct from a present empty value."""

    _instance = None

    def __new__(cls):
        if cls._instance is None:
            cls._instance = super().__new__(cls)
        return cls._instance

    def __repr__(self) -> str:  # pragma: no cover - debug aid
        return "MISSING"

    def __bool__(self) -> bool:
        return False


MISSING = _Missing()


class YahooShapeError(ValueError):
    """Raised when a payload cannot be interpreted.

    ⚠️ This is deliberately an EXCEPTION and not a None return. An unreadable
    payload is never an empty one — that conflation is the single root cause
    behind every data-destruction incident recorded in this repo. Callers catch
    it, record a fantasy_api_errors row, and mark the run partial or failed;
    they never proceed as though the collection was empty.
    """


# ─────────────────────────────────────────────────────────────────────────────
# Collections
# ─────────────────────────────────────────────────────────────────────────────

def iter_collection(node: Any) -> Iterator[Any]:
    """Yield the elements of a Yahoo collection, in index order.

    Handles all four shapes seen in the wild:
      {"0": x, "1": y, "count": 2}   → x, y        (the normal case)
      {"count": 0}                    → (nothing)   (a real empty collection)
      [x, y]                          → x, y        (already a list)
      {...}                           → the object  (single-element collapse)

    `count` is skipped, never yielded. Numeric-string keys are ordered
    NUMERICALLY, not lexically — otherwise element "10" sorts before "2" and a
    12-team league comes back in the wrong order, which matters for draft picks
    and matchups where position is meaning.
    """
    if node is None or node is MISSING:
        return
    if isinstance(node, list):
        yield from node
        return
    if not isinstance(node, dict):
        raise YahooShapeError(f"expected a collection, got {type(node).__name__}")

    numeric_keys = []
    for key in node:
        if key == "count":
            continue
        try:
            numeric_keys.append((int(key), key))
        except (TypeError, ValueError):
            # A non-numeric key means this is not a collection wrapper at all —
            # it is a single collapsed element (pathology 3).
            yield node
            return
    if not numeric_keys:
        # {"count": 0} — a genuinely empty collection. Distinct from an
        # unreadable payload, which raises above.
        return
    for _, key in sorted(numeric_keys):
        yield node[key]


def as_list(node: Any) -> list:
    """Materialize a collection (or a single collapsed element) as a list."""
    return list(iter_collection(node))


def collection_count(node: Any) -> int | None:
    """The provider's own declared count, when it gave one.

    Worth checking against len(as_list(...)): a mismatch means the payload was
    truncated, which is exactly the kind of silent short-read that pagination
    bugs produce.
    """
    if isinstance(node, dict) and "count" in node:
        return to_int(node.get("count"))
    return None


# ─────────────────────────────────────────────────────────────────────────────
# Resources
# ─────────────────────────────────────────────────────────────────────────────

def flatten_resource(node: Any) -> dict:
    """Collapse a Yahoo resource into one flat dict.

    A resource arrives as an array mixing flat metadata dicts with single-key
    sub-resource wrappers. This merges every dict member into one mapping, so
    `flatten_resource(payload["player"])["player_key"]` works regardless of
    which index the metadata landed at and which sub-resources were requested.

    Later members win on key collision, which is the right precedence: a
    sub-resource that restates a field is more specific than the bare metadata.

    Non-dict members (Yahoo emits stray empty lists in some resources) are
    skipped rather than raising — they carry no data and are not a shape error.
    """
    if node is None or node is MISSING:
        return {}
    if isinstance(node, dict):
        return dict(node)
    if not isinstance(node, list):
        raise YahooShapeError(f"expected a resource, got {type(node).__name__}")

    merged: dict = {}
    for member in node:
        if isinstance(member, dict):
            merged.update(member)
        elif isinstance(member, list):
            # Nested one level deeper in some payloads (e.g. team metadata).
            for inner in member:
                if isinstance(inner, dict):
                    merged.update(inner)
    return merged


def subresource(node: Any, key: str, *, default: Any = MISSING) -> Any:
    """Fetch a named sub-resource, descending through a numeric wrapper key.

    Pathology 6. Looks for `key` directly first, so a payload WITHOUT the wrapper
    behaves exactly as `get` does; only when it is absent does it look one level
    down through the numeric-string children ("0", "1", …) in numeric order.

    ⚠️ ONE LEVEL, AND ONLY THROUGH NUMERIC KEYS. A deeper or unrestricted search
    would start finding same-named keys in unrelated sub-trees — 'teams' exists
    on a league, on a matchup and on a standings block — and silently attach a
    parse to the wrong one. Returning MISSING when the key genuinely is not
    there is the correct answer; the caller decides whether that is an error.
    """
    if node is None or node is MISSING:
        return default
    if isinstance(node, list):
        node = flatten_resource(node)
    if not isinstance(node, dict):
        return default
    if key in node:
        return node[key]

    numeric_keys = []
    for k in node:
        if k == "count":
            continue
        try:
            numeric_keys.append((int(k), k))
        except (TypeError, ValueError):
            continue
    for _, k in sorted(numeric_keys):
        inner = node[k]
        if isinstance(inner, list):
            inner = flatten_resource(inner)
        if isinstance(inner, dict) and key in inner:
            return inner[key]
    return default


def get(node: Any, *path: str, default: Any = MISSING) -> Any:
    """Walk a key path, returning MISSING (not None) when a key is absent.

    The MISSING-vs-None distinction is the whole point: `get(x, "renew")`
    returning "" means Yahoo said "not renewed", while MISSING means Yahoo did
    not mention renewal at all. Callers that genuinely do not care use
    `default=None`.
    """
    cur = node
    for key in path:
        if isinstance(cur, list):
            cur = flatten_resource(cur)
        if not isinstance(cur, dict) or key not in cur:
            return default
        cur = cur[key]
    return cur


def unwrap_content(payload: Any) -> dict:
    """Strip the fantasy_content envelope every response is wrapped in.

    Raises rather than returning {} when the envelope is absent, because a
    response without it is not an empty response — it is an error page, a
    throttle body, or a login redirect, and treating it as empty data is how a
    backfill silently writes "this season had no transactions".
    """
    if not isinstance(payload, dict):
        raise YahooShapeError(
            f"response is not a JSON object (got {type(payload).__name__}) — "
            "this is usually an HTML error or throttle page, not data"
        )
    content = payload.get("fantasy_content")
    if content is None:
        keys = sorted(payload.keys())[:8]
        raise YahooShapeError(
            f"response has no 'fantasy_content' envelope; top-level keys were {keys}"
        )
    if not isinstance(content, dict):
        raise YahooShapeError(
            f"'fantasy_content' is {type(content).__name__}, expected object"
        )
    return content


# ─────────────────────────────────────────────────────────────────────────────
# Coercion
# ─────────────────────────────────────────────────────────────────────────────

def to_int(value: Any) -> int | None:
    """Coerce to int, or None when the value carries no number.

    Returns None for MISSING and for the empty string. Does NOT return 0 for
    either — "the provider did not say" and "the provider said zero" are
    different claims and collapsing them corrupts every downstream count.
    """
    if value is None or value is MISSING or value == "":
        return None
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return int(value)
    try:
        # via float so "3.0" and " 12 " both work; int("3.0") raises.
        return int(float(str(value).strip()))
    except (TypeError, ValueError):
        return None


def to_float(value: Any) -> float | None:
    """Coerce to float, or None when the value carries no number.

    ⚠️ Handles Yahoo's leading-dot decimals (".571"). float(".571") is fine in
    Python, but the value also arrives as "-.5" and as "1,234" in rare locale
    cases; both are handled rather than silently becoming None.
    """
    if value is None or value is MISSING or value == "":
        return None
    if isinstance(value, bool):
        return float(value)
    if isinstance(value, (int, float)):
        return float(value)
    text = str(value).strip().replace(",", "")
    if not text:
        return None
    try:
        return float(text)
    except (TypeError, ValueError):
        return None


def to_bool_int(value: Any) -> int | None:
    """Coerce a provider boolean to 1/0, or None when unstated.

    Yahoo sends booleans as the strings "0"/"1", sometimes as real ints, and
    occasionally as "true"/"false". None is preserved so a NOT NULL 0 never
    stands in for "the provider did not say".
    """
    if value is None or value is MISSING or value == "":
        return None
    if isinstance(value, bool):
        return int(value)
    text = str(value).strip().lower()
    if text in {"1", "true", "yes", "y"}:
        return 1
    if text in {"0", "false", "no", "n"}:
        return 0
    num = to_int(value)
    if num is None:
        return None
    return 1 if num != 0 else 0


def to_text(value: Any) -> str | None:
    """Coerce to a stripped string; MISSING becomes None, "" stays "".

    The empty string surviving is deliberate — see pathology 5. A caller that
    wants "" treated as absent must say so explicitly.
    """
    if value is None or value is MISSING:
        return None
    if isinstance(value, (dict, list)):
        raise YahooShapeError(f"expected a scalar, got {type(value).__name__}")
    return str(value).strip()


def first_text(node: Any, *keys: str) -> str | None:
    """Return the first key present with a non-empty value.

    Yahoo renames fields between game keys (e.g. a stat's `name` vs
    `display_name`), so several parsers need "whichever of these exists".
    """
    for key in keys:
        val = get(node, key)
        if val is not MISSING:
            text = to_text(val)
            if text:
                return text
    return None


# ─────────────────────────────────────────────────────────────────────────────
# Unmapped-field tracking
# ─────────────────────────────────────────────────────────────────────────────

def unmapped_keys(node: Any, mapped: Iterable[str], *, prefix: str = "") -> list[str]:
    """Field paths present in the payload that the parser did not consume.

    WHY THIS MATTERS. Yahoo adds fields without notice, and a parser that
    silently drops them is indistinguishable from one that handled them. The
    result is stored on the row (unmapped_fields) so a new provider field
    surfaces as data to look at rather than vanishing — which is the difference
    between discovering `faab_bid` exists and never knowing.

    Sub-resource containers are not reported: they are structure, not data, and
    reporting them would bury the real signal in noise.
    """
    if isinstance(node, list):
        node = flatten_resource(node)
    if not isinstance(node, dict):
        return []
    known = set(mapped)
    out = []
    for key, value in node.items():
        if key in known or key == "count":
            continue
        # Containers are structure; their leaves are reported by their own parser.
        if isinstance(value, (dict, list)):
            continue
        out.append(f"{prefix}{key}")
    return sorted(out)
