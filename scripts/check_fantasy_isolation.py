#!/usr/bin/env python3
"""Structurally prevent the multi-platform fantasy pipeline from writing to the
UPS/MFL side of the database. Read-only static check; stdlib only.

WHAT THIS DOES. It reads every file the Yahoo/fantasy ingestion is allowed to
consist of — the pipelines/fantasy/ Python, the Worker OAuth module, migrations
0132-0139, and the manual analytical-views file — and fails the job if any of
them contains a WRITE statement (INSERT / UPDATE / DELETE / REPLACE / DROP /
ALTER / TRUNCATE) naming a table on the UPS/MFL side of the house, or a
committed credential, or a command that would target production implicitly.

WHY IT EXISTS. The fantasy_* family shares one D1 database with the ledgers that
run a real 12-team money league, and that database has already been damaged four
separate ways by code that had no intention of damaging it:

  2026-08-02  a FAA finalize sweep whose guard failed OPEN flattened 18 owner
              contracts in one pass.
  2026-08-06  an ERA auto-drop cron unloaded 3 live contracts via MFL's commish
              web form — grepping for `import?TYPE=rosters` found NOTHING,
              because the write did not look like a write.
  2026-08-07  a contractInfo-only salaries import BLANKED salary/status/year on
              3 live contracts, because MFL's import replaces rather than
              patches.
  ongoing     `wrangler d1 migrations apply` is ~47 entries behind and corrupts
              contracts if anyone ever runs it.

Every one of those was written by someone who knew the rules. Documentation in a
header did not stop them; a gate that fails the pull request is a different kind
of object. 0127's header states the separation rule in prose — "Nothing in the
fantasy_* family may read or write ups_* / src_* / mfl_* / nfl_* rows" — and
this file is the machine that holds the prose to account.

The Yahoo league is somebody else's league on somebody else's platform that
happens to share our database. It has no business touching UPS contracts, and
the cheapest moment to discover that it tried is before the merge.

WHAT THIS DELIBERATELY DOES NOT DO.
  - It does not parse SQL properly. It is a lexical scan with a comment stripper,
    not a grammar. Known and accepted blind spot, stated plainly so nobody
    mistakes a green check for a proof: the table name must be VISIBLE. These
    are caught —
        conn.execute("DELETE FROM ups_transactions ...")     (strict rule)
        conn.execute("DELETE FROM " + "ups_waiver_claims")   (loose rule)
    and this is NOT, because the name and the verb are on different lines and
    this check does no dataflow analysis:
        tbl = "ups_waiver_claims"
        conn.execute("DELETE FROM " + tbl)
    A tripwire that catches the honest mistake, not a sandbox that contains a
    determined one. Isolation is ultimately a design property of the pipeline;
    this is the thing that notices when the design slips.
  - It does not check the rest of the repo. pipelines/etl/ writes ups_* tables
    on purpose, all day, and always will.
  - It does not run any query, open any database, or reach the network.
  - It does not lint style, imports, or types. One job, legible failure.

⚠️ NO FAIL-OPEN. A path that does not exist, a file that cannot be decoded, or a
scan set that came back empty is a REFUSAL, not a pass. That rule is not
decoration here: the specific way this check could betray its purpose is by
"passing" because it silently scanned nothing after somebody renamed a
directory. Every expected kind of input has a declared minimum count, asserted
before any result is reported, and the run prints how many files of each kind it
actually read so a green check is falsifiable by eye.

Run:  python3 scripts/check_fantasy_isolation.py
      python3 scripts/check_fantasy_isolation.py --root /path/to/checkout
Exit: 0 = clean, 1 = violation OR refusal. There is no other exit code.

TESTABLE ON PURPOSE. All detection lives in find_violations(text, filename) ->
list[Violation], which is pure, takes no filesystem, and can be called directly
from a test with a synthetic string. The filesystem walk and the refusal logic
live in main(); they are the untestable part and are kept small.

This file exists because Python inside a YAML `run:` heredoc broke three
workflows on 2026-08-08. Checks live in .py files. See ci_check_health_summary.py.
"""
from __future__ import annotations

import fnmatch
import re
import sys
from dataclasses import dataclass
from pathlib import Path

# ─────────────────────────────────────────────────────────────────────────────
# What counts as the other side of the house.
#
# These are the table-name prefixes the fantasy pipeline may never write:
#   ups_      league state MFL cannot model — contracts, caps, tags, waivers.
#             The 2026-08-02 and 2026-08-06 incidents both landed here.
#   src_      verbatim mirrors of MFL exports; a write makes the mirror a lie.
#   mfl_      MFL-side metadata and league-year bookkeeping.
#   nfl_      external NFL stats, shared by every model in the repo.
#   model_    derived features; a stray write silently poisons projections.
#   discord_  bot state; a rewrite re-posts or double-posts to a live server.
#   hall_     hall-of-fame / historical records.
PROTECTED_PREFIXES = ("ups_", "src_", "mfl_", "nfl_", "model_", "discord_", "hall_")

# Unprefixed tables that are nonetheless MFL-side and shared.
#
# ff_player_ids is the canonical all-eras player-identity table (12,468 rows),
# refreshed weekly by pipelines/etl/scripts/fetch_ff_playerids.py from
# DynastyProcess. 0132's own header records the design decision that the fantasy
# pipeline keeps its resolutions OUT of this table — in fantasy_player_crosswalk
# — precisely so the weekly refresh can never overwrite a manual decision, and
# so our guesses never masquerade as upstream fact. Protecting it by exact name
# is what turns that stated decision into an enforced one, and it is what makes
# the allowlist below load-bearing rather than ornamental.
PROTECTED_EXACT = ("ff_player_ids",)

# Identifiers that carry a protected prefix but are NOT tables.
#
# The Worker's D1 and R2 bindings are declared in worker/wrangler.toml as
# UPS_MFL_DB, UPS_MFL_BACKUPS and TWB_OUTBOX_DB. `env.UPS_MFL_DB` lowercases to
# `ups_mfl_db`, which trips the ups_ prefix — so the entirely correct line
#     await env.UPS_MFL_DB.prepare("INSERT INTO fantasy_oauth_tokens ...").run()
# would be reported as a write to a protected table. That is the accessor for
# EVERY query the Worker makes, read or write, so leaving it in would fail the
# build on correct code the first time somebody wrote a one-line D1 call.
#
# Excluding them costs nothing: no table in this database is named after a
# binding, so `DELETE FROM ups_mfl_db` is not a statement anyone can write.
NOT_A_TABLE = frozenset({"ups_mfl_db", "ups_mfl_backups", "twb_outbox_db"})

# ─────────────────────────────────────────────────────────────────────────────
# The allowlist. ONE entry. Adding a second is a decision, not a formality:
# write the justification and the date next to it, the way this one is written.
#
# 0132 adds a column to ff_player_ids so a Yahoo player id can resolve to an
# mfl_id. It is sanctioned because it is purely additive — no existing column is
# read, written, renamed or dropped, and no existing row's values change — and
# because the alternative (a parallel crosswalk table) would create a competing
# authority for the same fact, which is exactly what DATA_AUTHORITY_MAP.md
# exists to prevent. It is a schema change applied once by hand, not a data path
# the pipeline can reach at runtime.
#
# Note that ff_player_ids carries no protected PREFIX; it is protected by the
# exact-name list above. The allowlist entry is recorded regardless so the
# intent is on the record and survives any later widening of the protected set.
ALLOWLISTED_STATEMENTS = (
    # 2026-08-11 — migration 0132_fantasy_player_crosswalk.sql, additive column.
    "ALTER TABLE ff_player_ids ADD COLUMN yahoo_id TEXT",
)

# ─────────────────────────────────────────────────────────────────────────────
# Write-statement detection.
#
# Word-bounded on purpose: \bTRUNCATE\b must not fire on the word "truncated",
# which appears four times in the pipeline's prose about refusing to clip an
# oversized payload. Schema-qualified and quoted names ("t", `t`, [t], main.t)
# are unwrapped before the prefix test.
WRITE_VERB = r"""
      INSERT\s+(?:OR\s+\w+\s+)?INTO
    | REPLACE\s+INTO
    | DELETE\s+FROM
    | UPDATE(?:\s+OR\s+\w+)?
    | DROP\s+(?:TABLE|INDEX|VIEW|TRIGGER)(?:\s+IF\s+EXISTS)?
    | ALTER\s+TABLE
    | TRUNCATE(?:\s+TABLE)?
"""
_IDENT = r"""[`"\[]?[A-Za-z_][A-Za-z0-9_$]*[`"\]]?"""

WRITE_RE = re.compile(
    r"\b(?P<verb>" + WRITE_VERB + r")\s+(?P<table>" + _IDENT + r"(?:\." + _IDENT + r")?)",
    re.IGNORECASE | re.VERBOSE,
)

# The loose net: a write verb anywhere in the same statement as a protected
# table name, even when the strict rule could not bind the two together —
# e.g. "DELETE FROM " + TABLE where TABLE = "ups_waiver_claims".
WRITE_VERB_ANY_RE = re.compile(r"\b(?:" + WRITE_VERB + r")\b", re.IGNORECASE | re.VERBOSE)

# ...but a protected PREFIX on a COLUMN name is not a protected table.
# fantasy_player_crosswalk (0132) legitimately carries a column called `mfl_id`,
# so an entirely correct `INSERT INTO fantasy_player_crosswalk (..., mfl_id, ...)`
# would trip the loose net on every single write the pipeline is supposed to
# make. A gate that cries wolf on correct code gets deleted, and then it stops
# catching the real thing. Column-shaped names are therefore exempt from the
# LOOSE rule only — the strict rule still binds `UPDATE mfl_league_years`, and
# no table in this database is named `<prefix>_id`.
COLUMN_SHAPED_RE = re.compile(r"_(?:id|ids|key|keys|uid|name|abbr|url|status|code|hash)$", re.I)

# ...except when the "column-shaped" name IS a real table. The comment above
# claims "no table in this database is named `<prefix>_id`" -- false as of
# ups_injury_status (worker/migrations/0129_lineup_compliance.sql), which ends
# in _status and was being silently exempted by the loose net: verified live
# 2026-08-28, `DELETE FROM ups_injury_status` produced ZERO violations while
# the identical construction against ups_transactions correctly fired.
#
# Derived by (re-run whenever a new protected-prefix table is added):
#   grep -hoE "CREATE TABLE( IF NOT EXISTS)? [a-zA-Z_]+" worker/migrations/*.sql \
#     | awk '{print $NF}' | sort -u \
#     | grep -E "^(ups_|src_|mfl_|nfl_|model_|discord_|hall_)" \
#     | grep -E "_(id|ids|key|keys|uid|name|abbr|url|status|code|hash)$"
# ups_injury_status was the only hit against main as of 2026-08-28.
COLUMN_SHAPED_TABLE_EXCEPTIONS = frozenset({"ups_injury_status"})

# ─────────────────────────────────────────────────────────────────────────────
# Prohibition prose is not a violation.
#
# House style REQUIRES the dangerous string to appear in the warning that bans
# it: every one of 0132-0139 opens with "NEVER `wrangler d1 migrations apply`".
# A checker that fired on its own safety documentation would be deleted within a
# day. So a match is exempt when a negation word appears BEFORE it on the same
# line — the shape a prohibition actually takes in prose. "Before", not
# "anywhere on the line", so `INSERT INTO ups_x` cannot be excused by a trailing
# "-- do not do this".
NEGATION_RE = re.compile(
    r"(?i)(?:\b(?:never|not|no|none|nothing|don't|dont|do\s+not|must\s+not|cannot|can't|"
    r"forbid(?:s|den)?|prohibit(?:s|ed)?|refus(?:e|es|ed|al)|disallow(?:s|ed)?|banned|"
    r"illegal|avoid|instead\s+of|rather\s+than|unsafe|dangerous)\b|✗|❌|⛔|🚫)"
)

# ─────────────────────────────────────────────────────────────────────────────
# Committed-credential detection.
#
# fantasy_oauth_tokens (0127) is the only place a refresh token may live, and it
# lives there encrypted. Nothing token-shaped belongs in git. The client secret
# in particular is long-lived: a leak is not fixed by waiting an hour.
#
# Yahoo specifics that make these patterns tight rather than generic:
#   - a Yahoo OAuth client id always begins with the literal "dj0y" and runs on
#     for ~100 characters; nothing else in this repo looks like that.
#   - a Yahoo consumer secret is 40 lowercase hex characters, which is also what
#     a sha1 looks like — so that pattern only fires on a line that is already
#     talking about a secret, to keep fixture hashes out of it.
CREDENTIAL_CHECKS = (
    (
        "yahoo_client_id_literal",
        re.compile(r"\bdj0y[A-Za-z0-9_\-]{20,}"),
        "a literal Yahoo OAuth client id (dj0y...) is committed in source",
    ),
    (
        "credential_assignment",
        re.compile(
            r"(?i)\b(client_secret|consumer_secret|refresh_token|access_token|"
            r"authorization_code|yahoo_secret)\b[\"']?\s*[:=]\s*[\"']([^\"'\s]{16,})[\"']"
        ),
        "a credential is assigned a literal value in source",
    ),
    (
        "hex40_secret",
        re.compile(r"[\"']([0-9a-fA-F]{40})[\"']"),
        "a 40-hex literal on a line about secrets — Yahoo consumer secrets are 40 hex",
    ),
    (
        "long_token_literal",
        re.compile(r"[\"']([A-Za-z0-9_\-]{50,})[\"']"),
        "a long opaque literal on a line about tokens — refresh tokens look like this",
    ),
)

# Values that are obviously not credentials. A placeholder must stay legal:
# telling somebody to put their secret in YAHOO_CLIENT_SECRET is the fix, not
# the bug. Matched case-insensitively as substrings of the captured value.
PLACEHOLDER_MARKERS = (
    "redact", "example", "placeholder", "changeme", "change_me", "your_", "yourclient",
    "xxxx", "dummy", "fake", "sample", "notreal", "test-token", "test_token",
    "<", ">", "***", "${", "{{", "os.environ", "process.env", "env.",
)
# An ALL_CAPS_SNAKE token is an environment-variable NAME, not a value.
ENV_NAME_RE = re.compile(r"^[A-Z][A-Z0-9_]{2,}$")

# Lines must already be discussing credentials before the two broad patterns
# above are allowed to fire, otherwise every sha1 fixture becomes a "leak".
SECRET_CONTEXT_RE = re.compile(r"(?i)\b(secret|token|credential|consumer|client|password|auth)\b")

# ─────────────────────────────────────────────────────────────────────────────
# Forbidden commands.
#
# The separators are \W rather than \s because Python does not invoke wrangler as
# a shell string — it invokes it as an argv LIST:
#     subprocess.run(["npx", "wrangler", "d1", "migrations", "apply", "ups-mfl-db"])
# A \s-only pattern reads that as clean, which is the same class of blind spot as
# the 2026-08-06 ERA incident: the destructive call was invisible to grep because
# it did not look like the thing being searched for. `wrangler@4` is matched too,
# since that is the pinned form used in this repo.
#
# The separator budget is generous (60) because an argv list wraps and indents —
# `"d1",\n<20 spaces>"migrations"` is already 24 characters. It costs nothing in
# precision: \W cannot cross a word, so any real prose between the tokens breaks
# the match immediately. Being stingy here just recreates the blind spot.
MIGRATIONS_APPLY_RE = re.compile(
    r"(?i)\bwrangler(?:@[\d.]+)?\W{1,60}d1\W{1,60}migrations\W{1,60}apply\b"
)
REMOTE_FLAG_RE = re.compile(r"(?<![\w-])--remote\b")


@dataclass(frozen=True)
class Violation:
    """One finding. `kind` is stable and greppable; `detail` is for a human."""

    filename: str
    line: int
    kind: str
    detail: str
    excerpt: str

    def render(self) -> str:
        return f"{self.filename}:{self.line}: [{self.kind}] {self.detail}\n      {self.excerpt}"


# ─────────────────────────────────────────────────────────────────────────────
# Helpers


def _normalize(statement: str) -> str:
    """Collapse whitespace and drop a trailing semicolon, for allowlist compare."""
    return re.sub(r"\s+", " ", statement).strip().rstrip(";").strip()


_ALLOWLIST_NORMALIZED = frozenset(_normalize(s).casefold() for s in ALLOWLISTED_STATEMENTS)


def _is_allowlisted(statement: str) -> bool:
    return _normalize(statement).casefold() in _ALLOWLIST_NORMALIZED


def _bare_name(table: str) -> str:
    """Unwrap main.`tbl` / "tbl" / [tbl] down to the identifier itself.

    Also used for the dedupe key: without it, the strict rule's `nfl_x"` (which
    keeps the closing quote of a Python string literal) and the loose rule's
    `nfl_x` look like two different tables and the same finding gets reported
    twice.
    """
    return table.split(".")[-1].strip("`\"'[] \t").lower()


def _is_protected(table: str) -> bool:
    """True if `table` belongs to the UPS/MFL side of the database."""
    bare = _bare_name(table)
    if bare in NOT_A_TABLE:
        return False
    return bare.startswith(PROTECTED_PREFIXES) or bare in PROTECTED_EXACT


def _protected_names_in(text: str) -> list[str]:
    """Protected table names appearing as whole words.

    Word-bounded so `idx_ff_player_ids_yahoo` — an index name, not a table — does
    not read as a reference to ff_player_ids.
    """
    found = []
    for m in re.finditer(r"\b([A-Za-z_][A-Za-z0-9_$]*)\b", text):
        if _is_protected(m.group(1)):
            found.append(m.group(1))
    return found


def _excused_by_negation(line: str, match_start_in_line: int) -> bool:
    """A prohibition that quotes the dangerous thing is not the dangerous thing."""
    return bool(NEGATION_RE.search(line[:match_start_in_line]))


def _excused_by_negation_in_prose(
    line: str, match_start_in_line: int, *, line_start_offset: int, inert: list[tuple[int, int]]
) -> bool:
    """Same idea as _excused_by_negation, but for the WRITE checks only -- never
    credentials (inertness is irrelevant to a leak; see inert_spans' own
    docstring) -- and tightened so the negation word must itself be PROSE.

    _excused_by_negation matched a negation word ANYWHERE earlier on the line,
    with no distinction between prose and live control flow. Verified live
    2026-08-28: `if not dry_run: loader.execute("DELETE FROM ups_transactions
    WHERE id=1")` -- real, executing Python, not a comment -- produced ZERO
    violations against find_violations(). A single-line guard or a negated
    boolean earlier in an expression is a common, unremarkable Python idiom;
    none of it makes the write that follows safe.

    So the negation word must now sit inside an INERT span -- a comment or
    docstring, the exact same detection every write-match POSITION already
    uses via _in_spans -- to count as the "prose" the exemption was always
    meant to excuse. `# NEVER wrangler d1 migrations apply` still exempts
    itself; `if not dry_run: <a real write>` no longer does.
    """
    m = NEGATION_RE.search(line[:match_start_in_line])
    if not m:
        return False
    return _in_spans(line_start_offset + m.start(), inert)


def _line_of(text: str, offset: int) -> int:
    return text.count("\n", 0, offset) + 1


def _line_text(lines: list[str], line_no: int) -> str:
    if 1 <= line_no <= len(lines):
        return lines[line_no - 1]
    return ""


def _excerpt(s: str, limit: int = 160) -> str:
    s = s.strip()
    return s if len(s) <= limit else s[: limit - 1] + "…"


def comment_spans(text: str, *, line_token: str, backslash_escapes: bool) -> list[tuple[int, int]]:
    """Character spans covered by comments, skipping quoted strings.

    One scanner for both dialects: `line_token` is '--' for SQL and '//' for
    JavaScript; block comments are /* */ in both. Quoted strings are tracked so
    that a '--' inside a string literal, or the '//' in an 'https://' URL, is
    read as data rather than as the start of a comment. Missing that distinction
    would blank the rest of a line and could HIDE a real violation sitting after
    a URL — a fail-open bug in the checker itself.
    """
    spans: list[tuple[int, int]] = []
    i, n = 0, len(text)
    while i < n:
        ch = text[i]
        if ch in ("'", '"', "`"):
            quote = ch
            i += 1
            while i < n:
                if backslash_escapes and text[i] == "\\":
                    i += 2
                    continue
                if text[i] == quote:
                    if not backslash_escapes and i + 1 < n and text[i + 1] == quote:
                        i += 2  # SQL doubles a quote to escape it
                        continue
                    i += 1
                    break
                i += 1
            continue
        if text.startswith(line_token, i):
            start = i
            while i < n and text[i] != "\n":
                i += 1
            spans.append((start, i))
            continue
        if text.startswith("/*", i):
            start = i
            end = text.find("*/", i + 2)
            i = n if end == -1 else end + 2
            spans.append((start, i))
            continue
        i += 1
    return spans


def strip_sql_comments(text: str) -> str:
    """Blank out -- and /* */ comments, preserving offsets and line numbers.

    Offsets are preserved (comment characters become spaces, newlines survive) so
    a violation's line number still points at the real line.
    """
    out = list(text)
    for start, end in comment_spans(text, line_token="--", backslash_escapes=False):
        for j in range(start, end):
            if out[j] != "\n":
                out[j] = " "
    return "".join(out)


def inert_spans(text: str, filename: str) -> list[tuple[int, int]]:
    """Spans that cannot execute: comments, and bare string-expression statements.

    WHY THIS EXISTS. House style REQUIRES the dangerous thing to be named in the
    warning that bans it — every one of 0132-0139 opens with "NEVER `wrangler d1
    migrations apply`", and pipelines/fantasy/d1.py documents at length why it
    refuses to hardcode `--remote`. A checker that failed on its own safety
    documentation would be switched off inside a day, and then it would stop
    catching the real thing.

    The discrimination is structural, not lexical: a `#` comment and a bare
    string-expression statement (a docstring) are INERT — no command runs from
    them, ever — while `SQL = \"\"\"DELETE FROM ...\"\"\"` is an assignment and
    stays live, because that string does get used.

    ⚠️ APPLIES TO THE COMMAND AND WRITE CHECKS ONLY, NEVER TO CREDENTIALS. A
    secret pasted into a comment is still committed, still valid, and still has
    to be rotated. Inertness is irrelevant to a leak.

    ⚠️ NO FAIL-OPEN. If the file cannot be tokenized or parsed, this returns NO
    inert spans, so everything is treated as live code. A parse failure must make
    the check stricter, never laxer.
    """
    lowered = filename.lower()
    if lowered.endswith(".sql"):
        return comment_spans(text, line_token="--", backslash_escapes=False)
    if lowered.endswith((".js", ".mjs", ".cjs", ".ts")):
        return comment_spans(text, line_token="//", backslash_escapes=True)
    if not lowered.endswith(".py"):
        return []

    import ast
    import io
    import tokenize

    starts = _line_start_offsets(text)

    def pos(line: int, col: int) -> int:
        return starts[line - 1] + col if 1 <= line <= len(starts) else 0

    spans: list[tuple[int, int]] = []
    try:
        for tok in tokenize.generate_tokens(io.StringIO(text).readline):
            if tok.type == tokenize.COMMENT:
                spans.append((pos(*tok.start), pos(*tok.end)))
    except Exception:  # noqa: BLE001 — a file we cannot tokenize gets no exemptions
        return []
    try:
        tree = ast.parse(text)
    except Exception:  # noqa: BLE001 — same: fail closed, keep the comment spans
        return spans
    for node in ast.walk(tree):
        # A string sitting alone as a statement is a docstring or a comment-in-
        # prose. It is never executed against anything.
        if (
            isinstance(node, ast.Expr)
            and isinstance(node.value, ast.Constant)
            and isinstance(node.value.value, str)
            and node.end_lineno is not None
        ):
            spans.append(
                (pos(node.lineno, node.col_offset), pos(node.end_lineno, node.end_col_offset or 0))
            )
    return spans


def _line_start_offsets(text: str) -> list[int]:
    starts = [0]
    for i, ch in enumerate(text):
        if ch == "\n":
            starts.append(i + 1)
    return starts


def _in_spans(offset: int, spans: list[tuple[int, int]]) -> bool:
    return any(start <= offset < end for start, end in spans)


def sql_statements(scrubbed: str) -> list[tuple[int, int, str]]:
    """Split comment-scrubbed SQL into (start_offset, start_line, statement).

    Semicolons inside quotes do not end a statement.
    """
    statements: list[tuple[int, int, str]] = []
    start = 0
    i, n = 0, len(scrubbed)
    while i < n:
        ch = scrubbed[i]
        if ch in ("'", '"', "`"):
            quote = ch
            i += 1
            while i < n:
                if scrubbed[i] == quote:
                    if i + 1 < n and scrubbed[i + 1] == quote:
                        i += 2
                        continue
                    i += 1
                    break
                i += 1
            continue
        if ch == ";":
            body = scrubbed[start : i + 1]
            if body.strip():
                statements.append((start, _line_of(scrubbed, start), body))
            start = i + 1
        i += 1
    tail = scrubbed[start:]
    if tail.strip():
        statements.append((start, _line_of(scrubbed, start), tail))
    return statements


def _sanctioned_r2_remote(lines: list[str], line_no: int) -> bool:
    """Is this `--remote` the raw-payload R2 archive upload, and not D1?

    The blanket ban exists because a backfill must never reach production D1
    implicitly. pipelines/fantasy/raw/sink.py shells out to
    `wrangler r2 object put ... --remote` when the operator explicitly selects
    --raw-sink=r2; that is an opt-in, additive upload into the raw-payload prefix
    of an object bucket, and it is not a database write of any kind.

    The exception is deliberately narrow and structural rather than textual: the
    surrounding command must name r2/object/put and must NOT mention d1. A
    `wrangler d1 ... --remote` anywhere under pipelines/fantasy/ is a hard
    failure with no escape hatch, which is the case the rule was written for.
    """
    lo = max(0, line_no - 1 - 12)
    hi = min(len(lines), line_no + 3)
    window = "\n".join(lines[lo:hi])
    if re.search(r"\bd1\b", window, re.IGNORECASE):
        return False
    return bool(
        re.search(r"\br2\b", window, re.IGNORECASE)
        and re.search(r"\bobject\b", window, re.IGNORECASE)
        and re.search(r"\bput\b", window, re.IGNORECASE)
    )


def _looks_like_placeholder(value: str) -> bool:
    low = value.lower()
    if any(marker in low for marker in PLACEHOLDER_MARKERS):
        return True
    if ENV_NAME_RE.match(value):
        return True
    return False


# ─────────────────────────────────────────────────────────────────────────────
# The detector. Pure: text in, violations out. Call this from a test.


def find_violations(text: str, filename: str) -> list[Violation]:
    """Return every isolation violation in `text`.

    `filename` decides two things and nothing else: whether SQL comment
    stripping applies (.sql), and whether the --remote ban applies (anything
    under pipelines/fantasy/). Pass a realistic path when testing.
    """
    violations: list[Violation] = []
    lines = text.splitlines()
    line_starts = _line_start_offsets(text)
    is_sql = filename.endswith(".sql")
    in_fantasy_pipeline = "pipelines/fantasy/" in filename.replace("\\", "/")
    # Comments and docstrings cannot run a command or issue a write. Credentials
    # are checked against the raw text regardless — see inert_spans().
    inert = inert_spans(text, filename)

    def offset_of(line_no: int, col: int) -> int:
        return line_starts[line_no - 1] + col if 1 <= line_no <= len(line_starts) else 0

    # ── 1. writes against the UPS/MFL side ───────────────────────────────────
    # SQL files are scrubbed of comments first; .py/.js keep their strings,
    # because that is where SQL text lives, and rely on the negation rule for
    # prose. Offsets are preserved by the scrubber so line numbers stay true.
    body = strip_sql_comments(text) if is_sql else text
    units: list[tuple[int, int, str]]
    if is_sql:
        units = sql_statements(body)
    else:
        units = []
        offset = 0
        for idx, raw in enumerate(body.split("\n"), start=1):
            units.append((offset, idx, raw))
            offset += len(raw) + 1

    seen: set[tuple[int, str]] = set()
    for unit_offset, unit_line, unit in units:
        # Strict: verb immediately followed by a protected table name.
        for m in WRITE_RE.finditer(unit):
            table = m.group("table")
            if not _is_protected(table):
                continue
            abs_offset = unit_offset + m.start()
            abs_line = _line_of(body, abs_offset)
            line_src = _line_text(lines, abs_line)
            col = m.start() - (unit.rfind("\n", 0, m.start()) + 1)
            if _in_spans(abs_offset, inert):
                continue
            if _excused_by_negation_in_prose(
                line_src, max(col, 0), line_start_offset=line_starts[abs_line - 1], inert=inert
            ):
                continue
            if _is_allowlisted(unit) or _is_allowlisted(m.group(0)):
                continue
            bare = _bare_name(table)
            key = (abs_line, bare)
            if key in seen:
                continue
            seen.add(key)
            verb = _normalize(m.group("verb")).upper()
            violations.append(
                Violation(
                    filename,
                    abs_line,
                    "protected_table_write",
                    f"{verb} against protected table `{bare}` — the fantasy "
                    f"pipeline may never write the UPS/MFL side of the database",
                    _excerpt(line_src or unit),
                )
            )

        # Loose: a write verb and a protected name in the same statement, bound
        # by something the strict rule cannot see (concatenation, a constant).
        verb_hit = WRITE_VERB_ANY_RE.search(unit)
        if not verb_hit:
            continue
        for name in dict.fromkeys(_protected_names_in(unit)):
            if COLUMN_SHAPED_RE.search(name) and _bare_name(name) not in COLUMN_SHAPED_TABLE_EXCEPTIONS:
                continue
            pos = unit.find(name)
            abs_offset = unit_offset + max(pos, 0)
            abs_line = _line_of(body, abs_offset)
            key = (abs_line, name.lower())
            if key in seen:
                continue
            line_src = _line_text(lines, abs_line)
            col = pos - (unit.rfind("\n", 0, pos) + 1) if pos >= 0 else 0
            if _in_spans(abs_offset, inert) or _in_spans(unit_offset + verb_hit.start(), inert):
                continue
            if _excused_by_negation_in_prose(
                line_src, max(col, 0), line_start_offset=line_starts[abs_line - 1], inert=inert
            ):
                continue
            if _is_allowlisted(unit):
                continue
            seen.add(key)
            violations.append(
                Violation(
                    filename,
                    abs_line,
                    "protected_table_write_indirect",
                    f"a write verb ({_normalize(verb_hit.group(0)).upper()}) shares a "
                    f"statement with protected table `{name}`",
                    _excerpt(line_src or unit),
                )
            )

    # ── 2. committed credentials ─────────────────────────────────────────────
    for line_no, line in enumerate(lines, start=1):
        for kind, pattern, detail in CREDENTIAL_CHECKS:
            for m in pattern.finditer(line):
                value = m.group(m.lastindex) if m.lastindex else m.group(0)
                if _looks_like_placeholder(value):
                    continue
                if kind in ("hex40_secret", "long_token_literal") and not SECRET_CONTEXT_RE.search(line):
                    continue
                if _excused_by_negation(line, m.start()):
                    continue
                violations.append(
                    Violation(
                        filename,
                        line_no,
                        kind,
                        f"{detail} — credential material belongs in a Worker secret or "
                        f"encrypted in fantasy_oauth_tokens, never in git",
                        _excerpt(line),
                    )
                )

    # ── 3. forbidden commands ────────────────────────────────────────────────
    # Scanned over the WHOLE text rather than line by line, because an argv list
    # wraps:
    #     subprocess.run(["npx", "wrangler", "d1",
    #                     "migrations", "apply", "ups-mfl-db"])
    # A per-line scan reads both halves of that as harmless.
    def _command_hit(m: re.Match, kind: str, detail: str) -> Violation | None:
        line_no = _line_of(text, m.start())
        col = m.start() - line_starts[line_no - 1]
        line_src = _line_text(lines, line_no)
        if _in_spans(m.start(), inert):
            return None
        if _excused_by_negation(line_src, col):
            return None
        return Violation(filename, line_no, kind, detail, _excerpt(line_src))

    for m in MIGRATIONS_APPLY_RE.finditer(text):
        hit = _command_hit(
            m,
            "wrangler_migrations_apply",
            "`wrangler d1 migrations apply` — the migration tracker is ~47 "
            "entries behind and running it corrupts contracts; use "
            "`wrangler d1 execute --file=`",
        )
        if hit:
            violations.append(hit)

    if in_fantasy_pipeline:
        for m in REMOTE_FLAG_RE.finditer(text):
            hit = _command_hit(
                m,
                "implicit_remote_target",
                "`--remote` under pipelines/fantasy/ — a backfill must never "
                "target production implicitly; run against a local D1 or pass "
                "the target explicitly at the call site",
            )
            if hit and not _sanctioned_r2_remote(lines, hit.line):
                violations.append(hit)

    violations.sort(key=lambda v: (v.filename, v.line, v.kind))
    return violations


# ─────────────────────────────────────────────────────────────────────────────
# The scan set. Every entry declares a minimum count, and a count below the
# minimum is a refusal — see the NO FAIL-OPEN note at the top of this file.


@dataclass(frozen=True)
class ScanKind:
    label: str
    patterns: tuple[str, ...]  # repo-relative globs, resolved in order
    minimum: int
    why: str


SCAN_KINDS = (
    ScanKind(
        "fantasy pipeline python",
        ("pipelines/fantasy/**/*.py",),
        1,
        "the ingestion itself — the code that could actually issue a write",
    ),
    ScanKind(
        "worker OAuth module",
        ("worker/src/yahoo_oauth.js",),
        1,
        "the only Worker-side fantasy code path, and the one that handles tokens",
    ),
    ScanKind(
        "fantasy standalone scripts",
        # Matched by NAME PREFIX, same principle as the migrations kind below:
        # a number or a directory cannot identify what a file IS, but a fixed
        # platform-name prefix can. Before this kind existed, SCAN_KINDS only
        # covered pipelines/fantasy/ -- and 18 real scripts under scripts/
        # (cbs_persist_scoring_fits.py, cbs_draft_backfill.py, and 16 more,
        # several writing to D1 directly via D1Loader.write_rows) were never
        # scanned at all. CI could report "OK -- no UPS/MFL writes" without
        # ever having opened the file that contained one. Verified 2026-08-28:
        # find_violations() is never even invoked on these paths, because
        # collect() only walks SCAN_KINDS patterns.
        ("scripts/cbs_*.py", "scripts/espn_*.py"),
        1,
        "standalone analysis/backfill scripts that write to or read fantasy_* "
        "tables outside the pipelines/fantasy/ package. NOT scripts/yahoo_*.py "
        "-- that glob matches zero files today, and this checker treats an "
        "empty glob as a refusal, same as a moved file (collect()'s own "
        "docstring). Add it back the day a real yahoo_*.py script exists, not "
        "before -- a speculative pattern for a file that doesn't exist yet "
        "just breaks every CI run until one does.",
    ),
    ScanKind(
        "fantasy migrations",
        # Matched by NAME, not by number.
        #
        # This was a numeric range (0132-0139). Migration numbers are assigned by
        # whoever merges first, and while this branch sat unmerged main took
        # 0127-0131 for the penalty/lineup work. The globs then matched main's UPS
        # migrations, and the isolation check reported `ALTER TABLE ups_drop_events`
        # as "the fantasy pipeline writing UPS tables" — a false positive that
        # blocked the PR (2026-08-24). The companion test failed the same way,
        # finding ups_lineup_* tables inside what it believed was a fantasy
        # migration. Second collision of this kind; wire's 0113 was the first.
        #
        # A number cannot identify what a file IS. The name can.
        ("worker/migrations/*_fantasy_*.sql",),
        6,
        "the schema contract; the crosswalk is the one file that touches an existing table",
    ),
    ScanKind(
        "manual analytical views",
        ("worker/migrations/manual/2026-08-11_fantasy_analytical_views.sql",),
        1,
        "hand-applied SQL, which no migration runner will ever review",
    ),
)

# __pycache__ is build output; scanning it proves nothing and its .pyc files are
# not text. Nothing else is excluded — an exclusion is a hole.
EXCLUDE_GLOBS = ("**/__pycache__/**", "**/*.pyc")


def _excluded(rel: str) -> bool:
    return any(fnmatch.fnmatch(rel, pat) for pat in EXCLUDE_GLOBS)


def collect(root: Path, kind: ScanKind) -> tuple[list[Path], list[str]]:
    """Resolve a kind's globs. Returns (files, unresolved-patterns).

    A literal path that does not exist and a glob that matches nothing are the
    same failure and are both reported: the check cannot tell the difference
    between "this moved" and "this was deleted", and must not guess.
    """
    files: list[Path] = []
    missing: list[str] = []
    for pattern in kind.patterns:
        hits = sorted(p for p in root.glob(pattern) if p.is_file() and not _excluded(str(p.relative_to(root))))
        if not hits:
            missing.append(pattern)
        files.extend(hits)
    # A glob can legitimately overlap another; keep each file once.
    unique: list[Path] = []
    seen: set[Path] = set()
    for f in files:
        if f not in seen:
            seen.add(f)
            unique.append(f)
    return unique, missing


def main(argv: list[str]) -> int:
    root = Path(argv[1]).resolve() if len(argv) > 1 else Path(__file__).resolve().parents[1]
    if not root.is_dir():
        print(f"::error::fantasy isolation check — repo root {root} is not a directory. Refusing.")
        return 1

    print(f"Fantasy isolation check — root {root}")

    refusals: list[str] = []
    scanned: list[tuple[str, Path]] = []
    counts: dict[str, int] = {}

    for kind in SCAN_KINDS:
        files, missing = collect(root, kind)
        for pattern in missing:
            refusals.append(
                f"{kind.label}: pattern '{pattern}' matched no file. A missing input is "
                f"NOT an empty one — this check cannot vouch for code it never read. "
                f"({kind.why})"
            )
        if len(files) < kind.minimum:
            refusals.append(
                f"{kind.label}: found {len(files)} file(s), expected at least "
                f"{kind.minimum}. Refusing to report a pass on a short scan set."
            )
        counts[kind.label] = len(files)
        for f in files:
            scanned.append((kind.label, f))

    if refusals:
        for line in refusals:
            print(f"::error::fantasy isolation check REFUSED — {line}")
        print(
            "::error::fantasy isolation check REFUSED — the scan set is incomplete, so this "
            "run proves nothing. If a file legitimately moved, update SCAN_KINDS in "
            "scripts/check_fantasy_isolation.py; do not delete the requirement."
        )
        return 1

    violations: list[Violation] = []
    allowlist_sightings: list[str] = []
    for label, path in scanned:
        rel = str(path.relative_to(root))
        try:
            text = path.read_text(encoding="utf-8")
        except Exception as exc:  # noqa: BLE001 — any read failure is a refusal
            # An undecodable file is not a clean file. This is the exact shape of
            # the fail-open bug that has cost this repo four incidents.
            print(f"::error::fantasy isolation check REFUSED — could not read {rel}: {exc}")
            return 1
        violations.extend(find_violations(text, rel))
        # Report where each exception is actually being used, so an allowlist
        # entry that has outlived its statement shows up as unused rather than
        # sitting there quietly widening the rule for a file that no longer exists.
        flat = _normalize(text).casefold()
        for stmt in ALLOWLISTED_STATEMENTS:
            if _normalize(stmt).casefold() in flat:
                allowlist_sightings.append(f"{rel}: {_normalize(stmt)}")

    for kind in SCAN_KINDS:
        print(f"  scanned {counts[kind.label]:>2} × {kind.label}")
    print(f"  {len(scanned)} file(s) read in total")

    for sighting in allowlist_sightings:
        print(f"  allowlisted exception in use — {sighting}")
    unused = len(ALLOWLISTED_STATEMENTS) - len({s.split(': ', 1)[1] for s in allowlist_sightings})
    if unused > 0:
        # Not a failure — an entry may legitimately precede the file that needs
        # it — but an unused exception is a widened rule with nothing behind it.
        print(f"  note: {unused} allowlisted statement(s) matched nothing in the scan set")

    if violations:
        for v in violations:
            print(f"::error file={v.filename},line={v.line}::{v.detail}")
        print("")
        print(f"::error::fantasy isolation check FAILED — {len(violations)} violation(s):")
        for v in violations:
            print("  " + v.render())
        print("")
        print(
            "  The fantasy_* family shares a database with the ledgers that run a real "
            "money league. It may read the crosswalk and write fantasy_*/raw_yahoo_* "
            "only. If an exception is genuinely warranted, add it to "
            "ALLOWLISTED_STATEMENTS with a dated justification — do not weaken the rule."
        )
        return 1

    print("  OK — no UPS/MFL writes, no committed credentials, no implicit prod targets")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
