#!/usr/bin/env python3
"""Build the member-facing rulebook payload from canon.

Canon (`docs/league_context_v1.md`) is written for the Hall bot, not for owners:
it carries STILL-OPEN registers, D1 table references, code follow-ups and
`Keith, <date>` review annotations alongside the actual rules. This script
parses canon into a structured payload the mobile Rules tab renders, marking
every bot/implementation block `internal: true` rather than deleting it — the
commish toggle in the UI reveals them, so there is exactly ONE source of truth
and nothing is lost in translation.

Outputs (both generated — never hand-edit):
  site/m/data/rules_data.js   window.UPS_RULES_DATA = {...}
  site/m/data/rules.json      same payload, for the worker / bot / any consumer

The .js twin exists because the mobile service worker caches `.js` cache-first
but does NOT intercept `.json` (see site/m/sw.js ASSET_RE) — shipping the data
as a script is what makes the rulebook work offline.

Usage:
    python3 scripts/build_rulebook_data.py [--check]

  --check  parse and report, write nothing, exit 1 on drift (CI guard).
"""

from __future__ import annotations

import argparse
import hashlib
import html as _html
import json
import os
import re
import subprocess
import sys

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CANON = os.path.join(REPO, "docs", "league_context_v1.md")
CHANGELOG = os.path.join(REPO, "docs", "league_context_changelog.md")
# The member-facing layer: canon reorganized into the topics owners actually
# look up ("Starting Lineups"), written in the present tense. Canon stays the
# source of truth — every topic cites the canon rule ids behind it, and those
# citations are VALIDATED here, so a topic can never quietly outlive the rule
# it describes.
TOPICS = os.path.join(REPO, "docs", "rulebook_topics.json")
OUT_DIR = os.path.join(REPO, "site", "m", "data")
OUT_JS = os.path.join(OUT_DIR, "rules_data.js")
OUT_JSON = os.path.join(OUT_DIR, "rules.json")


# ---------------------------------------------------------------- classification

# A whole `##`/`###` subsection that exists for the bot or the build, not owners.
# Matched against the heading text (case-insensitive).
INTERNAL_HEADING_PATTERNS = [
    r"still[- ]open",
    r"^end section",
    r"document status & versioning",
    r"source tables on d1",
    r"upstream automation",
    r"data sources? —",
    r"implementation note",
    r"code follow-?up",
    r"^querying",
    r"methodology cutover",
    r"mfl api vs\.? our data",
    r"source-?data conflicts",
    r"implications for the \d{4} bid sheet",
    r"league rules migration",
    r"open items master list",
    r"resolved in v\d+",
    # NOT "bot grounding": the Bot Grounding Clarifications appendix holds real
    # owner-facing rules (cap-free <$5K, penalty rounding, pot splitting, taxi
    # active-week definition). It was named for who asked, not who it's for.
    r"^goal$",
    r"^approach",
    r"inputs to inventory",
    r"open scope",
]
INTERNAL_HEADING_RE = re.compile("|".join(INTERNAL_HEADING_PATTERNS), re.I)

# An individual bullet/paragraph that is implementation or review scaffolding.
# Deliberately narrow: over-stripping hides a real rule from owners, and the
# commish toggle already makes under-stripping cheap.
INTERNAL_BLOCK_PATTERNS = [
    r"AUDIT_FOLLOWUP_TRACKERS|CROSS_CODEBASE_ALIGNMENT|MASTER_PLAN",
    r"\bmigrations?\s+00\d\d\b",
    r"implementation ownership|implementation tracker|implementation note",
    r"live verification deferred|follow-?up tracker|tracker filed",
    r"\bcode follow-?up\b|read code over rulebook",
    r"services/rulebook/|pipelines/etl|worker/src|site/m/|site/ccc|\.js`",
    r"\bD1\b|src_standings|`TYPE=|mfl_database\.db|metadata_rawrules",
    r"automation candidate|parked for|is \*\*parked\*\*",
    r"pending mfl .* confirmation|need mfl .* confirmation",
    r"^\s*>\s*\*\*(source-of-truth ranking|open external sources)",
]
INTERNAL_BLOCK_RE = re.compile("|".join(INTERNAL_BLOCK_PATTERNS), re.I)

# Status badges canon uses to mark how settled a rule is.
STATUS_MAP = [
    ("✅", "locked"),
    ("🔒", "binding"),
    ("🟡", "provisional"),
    ("🆕", "new"),
    ("🟠", "ambiguous"),
    ("⚠️", "caution"),
]

# Topic tags, for the filter chips. Keyword -> tag.
TAG_RULES = [
    ("taxi", ["taxi squad", "taxi-eligib", "call-up", "callup"]),
    ("cap", ["cap ceiling", "cap floor", "salary cap", "cap hit", "available cap", "$300", "$260"]),
    ("penalty", ["penalty", "cut", "drop", "release", "cap-free", "guarantee"]),
    ("contracts", ["contract", "myac", "mym", "extension", "restructure", "loaded", "tcv", "aav"]),
    ("trades", ["trade", "trading"]),
    ("waivers", ["waiver", "blind bid", "bbid", "fcfs", "first-come"]),
    ("auction", ["auction", "nomination", "bid"]),
    ("rookies", ["rookie", "draft pick", "rookie draft", "era"]),
    ("tags", ["tag ", "tagging", "franchise tag"]),
    ("lineups", ["lineup", "starter", "superflex", "flex"]),
    ("scoring", ["scoring", "ppr", "points"]),
    ("calendar", ["deadline", "calendar", "kickoff", "week "]),
    ("ir", ["injured reserve", " ir ", "ir)"]),
    ("standings", ["standings", "all-play", "playoff", "seeding", "division"]),
    ("money", ["dues", "fine", "payout", "pot", "financ"]),
]


def classify_tags(text: str) -> list[str]:
    low = " " + text.lower() + " "
    return [tag for tag, kws in TAG_RULES if any(k in low for k in kws)]


# ---------------------------------------------------------------- markdown -> html

_INLINE_CODE = re.compile(r"`([^`]+)`")
_BOLD = re.compile(r"\*\*([^*]+)\*\*")
_ITAL = re.compile(r"(?<![*\w])\*([^*\n]+)\*(?!\*)")
_LINK = re.compile(r"\[([^\]]+)\]\(([^)\s]+)(?:\s+\"[^\"]*\")?\)")
_BARE_URL = re.compile(r"(?<![\"'=(>])\bhttps?://[^\s<)\]]+")


def inline_md(text: str) -> str:
    """Inline markdown -> HTML. Escapes first, so canon text can never inject."""
    out = _html.escape(text, quote=False)
    # Code spans first — their contents must not be re-processed.
    holds: list[str] = []

    def _hold(m: re.Match) -> str:
        holds.append("<code>" + m.group(1) + "</code>")
        return "\x00%d\x00" % (len(holds) - 1)

    out = _INLINE_CODE.sub(_hold, out)
    out = _LINK.sub(lambda m: '<a href="%s" target="_blank" rel="noopener noreferrer">%s</a>'
                    % (_html.escape(m.group(2), quote=True), m.group(1)), out)
    out = _BARE_URL.sub(lambda m: '<a href="%s" target="_blank" rel="noopener noreferrer">%s</a>'
                        % (_html.escape(m.group(0), quote=True), m.group(0)), out)
    out = _BOLD.sub(r"<b>\1</b>", out)
    out = _ITAL.sub(r"<i>\1</i>", out)
    for i, h in enumerate(holds):
        out = out.replace("\x00%d\x00" % i, h)
    return out


def _bullet_depth(line: str) -> int:
    indent = len(line) - len(line.lstrip(" "))
    return indent // 2


def blocks_to_html(lines: list[str]) -> list[dict]:
    """Group raw markdown lines into renderable blocks.

    Each block is {kind, html, text, internal}. Blocks are the unit the commish
    toggle hides/reveals, so bullet lists stay whole rather than fragmenting.
    """
    blocks: list[dict] = []
    i = 0
    n = len(lines)

    def emit(kind: str, html_s: str, raw: str) -> None:
        raw = raw.strip()
        if not raw:
            return
        # `text` is build-time only — it feeds the rule-level search string and
        # is deleted before serialization (it duplicates `html` almost exactly,
        # and duplicating 190KB onto every phone is not free).
        blocks.append({
            "kind": kind,
            "html": html_s,
            "text": re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", html_s)).strip(),
            "internal": bool(INTERNAL_BLOCK_RE.search(raw)),
        })

    while i < n:
        line = lines[i]
        stripped = line.strip()

        if not stripped or stripped == "---":
            i += 1
            continue

        # ---- table
        if stripped.startswith("|"):
            tbl = []
            while i < n and lines[i].strip().startswith("|"):
                tbl.append(lines[i].strip())
                i += 1
            if len(tbl) >= 2 and re.match(r"^\|[\s:|-]+\|$", tbl[1]):
                head = [c.strip() for c in tbl[0].strip("|").split("|")]
                rows = [[c.strip() for c in r.strip("|").split("|")] for r in tbl[2:]]
                h = ['<div class="ups-m-rb-tablewrap"><table class="ups-m-rb-table"><thead><tr>']
                h += ["<th>" + inline_md(c) + "</th>" for c in head]
                h.append("</tr></thead><tbody>")
                for r in rows:
                    h.append("<tr>" + "".join("<td>" + inline_md(c) + "</td>" for c in r) + "</tr>")
                h.append("</tbody></table></div>")
                emit("table", "".join(h), " ".join(tbl))
            continue

        # ---- blockquote
        if stripped.startswith(">"):
            q = []
            while i < n and lines[i].strip().startswith(">"):
                q.append(re.sub(r"^\s*>\s?", "", lines[i]))
                i += 1
            body = "<br>".join(inline_md(x) for x in q if x.strip())
            emit("quote", '<blockquote class="ups-m-rb-quote">' + body + "</blockquote>", " ".join(q))
            continue

        # ---- list (bulleted or numbered), possibly nested
        if re.match(r"^\s*(?:[-*+]|\d+\.)\s+", line):
            items: list[tuple[int, str, bool]] = []
            raw_all: list[str] = []
            while i < n and (re.match(r"^\s*(?:[-*+]|\d+\.)\s+", lines[i])
                             or (lines[i].strip() and lines[i].startswith("    ")
                                 and items)):
                cur = lines[i]
                m = re.match(r"^(\s*)(?:[-*+]|\d+\.)\s+(.*)$", cur)
                if m:
                    items.append((_bullet_depth(cur), m.group(2), cur.lstrip().startswith(tuple("0123456789"))))
                elif items:  # lazy continuation of the previous bullet
                    d, t, o = items[-1]
                    items[-1] = (d, t + " " + cur.strip(), o)
                raw_all.append(cur)
                i += 1

            # Classify PER ITEM, not per list. A single "Implementation
            # ownership" bullet inside B2 Taxi Squad must not hide the whole
            # taxi rule from owners — internal items get a marker class the
            # commish toggle keys off, and the block only counts as internal
            # when every item is.
            ordered = items[0][2] if items else False
            tag = "ol" if ordered else "ul"
            h = ['<%s class="ups-m-rb-list">' % tag]
            depth = 0
            n_int = 0
            public_txt = []
            for d, txt, _o in items:
                while d > depth:
                    h.append('<ul class="ups-m-rb-list ups-m-rb-sub">')
                    depth += 1
                while d < depth:
                    h.append("</ul>")
                    depth -= 1
                item_int = bool(INTERNAL_BLOCK_RE.search(txt))
                if item_int:
                    n_int += 1
                else:
                    public_txt.append(txt)   # search must never surface internal text
                h.append('<li class="ups-m-rb-int">' if item_int else "<li>")
                h.append(inline_md(txt) + "</li>")
            while depth > 0:
                h.append("</ul>")
                depth -= 1
            h.append("</%s>" % tag)
            all_internal = bool(items) and n_int == len(items)
            blocks.append({
                "kind": "list",
                "html": "".join(h),
                "text": " ".join(public_txt),
                "internal": all_internal,
                "has_int": n_int > 0 and not all_internal,
            })
            continue

        # ---- paragraph
        para = []
        while i < n and lines[i].strip() and not lines[i].strip().startswith(("|", ">", "#")) \
                and not re.match(r"^\s*(?:[-*+]|\d+\.)\s+", lines[i]) and lines[i].strip() != "---":
            para.append(lines[i].strip())
            i += 1
        joined = " ".join(para)
        emit("p", "<p>" + inline_md(joined) + "</p>", joined)

    return blocks


# ---------------------------------------------------------------- canon parsing

H_RE = re.compile(r"^(#{1,4})\s+(.*)$")
UPDATED_RE = re.compile(r"\(UPDATED\s+(\d{4}-\d{2}-\d{2})[^)]*\)", re.I)
LOCKED_RE = re.compile(r"\bLOCKED\s+(v\d+)\b", re.I)
KEITH_RE = re.compile(r"\(Keith[,\s][^)]*?(\d{4}-\d{2}-\d{2})[^)]*\)")
# `### B2. Taxi Squad` / `### T1.7 Trade` / `#### C5.1 What a restructure...`
RULE_ID_RE = re.compile(r"^([A-Z]{1,2}\d+(?:\.\d+)*[a-z]?)\.?\s+(.*)$")
GROUP_ID_RE = re.compile(r"^([A-Z](?:\.\d+)?)\.\s+(.*)$")
SECTION_RE = re.compile(r"^Section\s+([\d.]+)\s*—\s*(.*)$")
# Canon puts appendices at `#` level AND nests further appendices under them at
# `##` level ("Appendix — Bot Grounding Clarifications" sits inside "Appendix —
# Open Items Master List"). They are independent documents, not subsections, so
# both forms are promoted to top-level sections — otherwise everything after the
# first appendix gets mis-filed under the preceding numbered Section.
APPENDIX_RE = re.compile(r"^Appendix\s*(?:[A-Z]\s*)?[—:-]\s*(.*)$")


def strip_status(text: str) -> tuple[str, list[str]]:
    found = []
    for glyph, name in STATUS_MAP:
        if glyph in text:
            found.append(name)
            text = text.replace(glyph, "")
    return text.strip(), found


def clean_title(s: str) -> str:
    """Headings carry inline markdown (`TAXI`, **bold**). Titles render as plain
    text in nav/search/anchors, so flatten the markers rather than escaping them."""
    s = re.sub(r"`([^`]*)`", r"\1", s)
    s = re.sub(r"\*\*([^*]*)\*\*", r"\1", s)
    return re.sub(r"\s{2,}", " ", s).strip(" —-")


def slugify(s: str) -> str:
    s = re.sub(r"[^a-zA-Z0-9]+", "-", s).strip("-").lower()
    return re.sub(r"-{2,}", "-", s)[:60]


def parse_canon(md: str) -> dict:
    lines = md.split("\n")

    doc_title = lines[0].lstrip("# ").strip() if lines else "UPS Rulebook"
    vm = re.search(r"\(v(\d+)", doc_title)
    doc_version = "v" + vm.group(1) if vm else "v1"

    # Index every heading with its line number, then slice bodies between them.
    heads: list[tuple[int, int, str]] = []
    in_fence = False
    for idx, ln in enumerate(lines):
        if ln.strip().startswith("```"):
            in_fence = not in_fence
        if in_fence:
            continue
        m = H_RE.match(ln)
        if m:
            heads.append((idx, len(m.group(1)), m.group(2).strip()))

    sections: list[dict] = []
    cur_sec: dict | None = None
    cur_grp: dict | None = None
    cur_rule: dict | None = None

    for h_i, (line_no, level, raw_title) in enumerate(heads):
        body_start = line_no + 1
        body_end = heads[h_i + 1][0] if h_i + 1 < len(heads) else len(lines)
        body = lines[body_start:body_end]

        title, statuses = strip_status(raw_title)
        upd = UPDATED_RE.search(title)
        updated = upd.group(1) if upd else None
        if not updated:
            km = KEITH_RE.search(title)
            updated = km.group(1) if km else None
        clean = UPDATED_RE.sub("", title).strip(" —-")
        locked = LOCKED_RE.search(raw_title)
        is_internal_head = bool(INTERNAL_HEADING_RE.search(clean))

        def open_section(num: str, stitle: str, internal: bool) -> dict:
            sec = {
                "id": "s" + slugify(num) + ("-" + slugify(stitle)[:18] if num == "A" else ""),
                "num": num,
                "title": clean_title(re.sub(r"\s*\(v\d+.*?\)\s*$", "", stitle)),
                "status": "locked" if locked else (statuses[0] if statuses else None),
                "version": locked.group(1) if locked else None,
                "internal": internal,
                "groups": [],
            }
            sections.append(sec)
            return sec

        appx = APPENDIX_RE.match(clean)

        if level == 1:
            sm = SECTION_RE.match(clean)
            if sm:
                cur_sec = open_section(sm.group(1), sm.group(2), is_internal_head)
            elif appx:
                cur_sec = open_section("A", appx.group(1), is_internal_head)
            else:
                continue  # document title line
            cur_grp = None
            cur_rule = None
            continue

        # `## Appendix — …` starts its own top-level section rather than a group:
        # canon nests independent appendices under the first one.
        if level == 2 and appx:
            cur_sec = open_section("A", appx.group(1), is_internal_head)
            cur_grp = None
            cur_rule = None
            continue

        if cur_sec is None:
            continue  # pre-Section-1 front matter (doc status / versioning)

        if level == 2:
            gm = GROUP_ID_RE.match(clean)
            key = gm.group(1) if gm else None
            gtitle = clean_title(gm.group(2) if gm else clean)
            cur_grp = {
                "id": cur_sec["id"] + "-" + (slugify(key) if key else slugify(gtitle)),
                "key": key,
                "title": gtitle,
                "internal": is_internal_head,
                "updated": updated,
                "statuses": statuses,
                "intro": blocks_to_html(body),
                "rules": [],
            }
            cur_sec["groups"].append(cur_grp)
            cur_rule = None
            continue

        if level in (3, 4):
            if cur_grp is None:
                cur_grp = {
                    "id": cur_sec["id"] + "-main", "key": None, "title": "",
                    "internal": False, "updated": None, "statuses": [],
                    "intro": [], "rules": [],
                }
                cur_sec["groups"].append(cur_grp)

            rm = RULE_ID_RE.match(clean)
            rid = rm.group(1) if rm else None
            rtitle = clean_title(rm.group(2) if rm else clean)
            blocks = blocks_to_html(body)
            internal = (is_internal_head or cur_grp["internal"]
                        or bool(cur_sec.get("internal")))

            # `id` is what canon calls the rule and what owners see ("B2").
            # `anchor` must be globally unique for deep links — rule ids only
            # repeat across sections (Section 1 B2 = Taxi Squad, Section 6 B2 =
            # a code note), so it is section-scoped.
            # `id` stays None when canon numbered the rule nothing — an
            # auto-slug is not a rule number and must not be shown as one, nor
            # ranked against as if the member typed it.
            node = {
                "id": rid,
                "anchor": cur_sec["id"] + "-" + (rid or slugify(rtitle)).lower().replace(".", "-"),
                "title": rtitle,
                "updated": updated,
                "statuses": statuses,
                "internal": internal,
                "blocks": blocks,
            }
            # Everything a member could type into search, flattened once at build
            # time so the client never re-derives it.
            search_text = " ".join(
                [rid or "", rtitle] + [b["text"] for b in blocks if not b["internal"]]
            ).strip()
            node["tags"] = classify_tags(search_text)

            if level == 4 and cur_rule is not None:
                cur_rule.setdefault("children", []).append(node)
            else:
                cur_grp["rules"].append(node)
                cur_rule = node
            continue

    # Drop groups that ended up with no renderable content at all.
    for s in sections:
        s["groups"] = [g for g in s["groups"] if g["rules"] or g["intro"]]
    sections = [s for s in sections if s["groups"]]

    return {"title": doc_title, "version": doc_version, "sections": sections}


# ---------------------------------------------------------------- changelog

# The vote result is optional: commish promotions into canon (e.g. the
# 2026-07-31 §C5 restructure entry) are logged with no ballot behind them.
CL_HEAD_RE = re.compile(
    r"^##\s+(\d{4}-\d{2}-\d{2})\s+—\s+(.*?)"
    r"(?:\s*\((PASSED|REJECTED)\s+([\d-]+)\))?\s*$", re.I)


def parse_changelog(md: str) -> list[dict]:
    lines = md.split("\n")
    idxs = [i for i, ln in enumerate(lines) if CL_HEAD_RE.match(ln)]
    entries: list[dict] = []
    for n, start in enumerate(idxs):
        end = idxs[n + 1] if n + 1 < len(idxs) else len(lines)
        m = CL_HEAD_RE.match(lines[start])
        if not m:
            continue
        body = lines[start + 1:end]
        text = "\n".join(body)

        thread = None
        tm = re.search(r"\*\*Discord thread:\*\*\s*(\S+)", text)
        if tm and tm.group(1).startswith("http"):
            thread = tm.group(1)

        affected: list[str] = []
        am = re.search(r"### Sections affected\n(.*?)(?=\n### |\n---|\Z)", text, re.S)
        if am:
            for ln in am.group(1).split("\n"):
                b = re.match(r"^\s*-\s+`([^`]+)`", ln)
                if b:
                    affected.append(b.group(1))

        pm = re.search(r"### Proposal body\n(.*?)(?=\n### |\n---|\Z)", text, re.S)
        proposal = blocks_to_html(pm.group(1).split("\n")) if pm else []

        entries.append({
            "date": m.group(1),
            "title": m.group(2).strip(" —-:"),
            "result": (m.group(3) or "ADOPTED").upper(),
            "tally": m.group(4),
            "thread": thread,
            "affected": affected,
            "proposal": proposal,
        })
    return entries


# ---------------------------------------------------------------- topics

def index_rules(sections: list[dict]) -> dict[str, list[dict]]:
    """Map canon rule id -> every rule carrying it, in document order.

    Ids repeat across sections (Section 1 B2 is Taxi Squad; Section 6 B2 is a
    code note), so a topic may qualify a citation as "s1:B2" to disambiguate.
    """
    idx: dict[str, list[dict]] = {}
    for sec in sections:
        for grp in sec["groups"]:
            for rule in grp["rules"]:
                for node in [rule] + rule.get("children", []):
                    if not node.get("id"):
                        continue
                    entry = {"sec": sec, "rule": node}
                    idx.setdefault(node["id"], []).append(entry)
                    idx.setdefault(sec["id"] + ":" + node["id"], []).append(entry)
    return idx


def attach_topics(sections: list[dict]) -> tuple[list[dict], list[str]]:
    """Load the curated topics and bind each to real canon rules.

    Returns (topics, problems). A problem is a citation that no longer resolves
    — canon renamed or dropped the rule out from under a topic. That is exactly
    the drift we are guarding against, so --check treats it as a build failure.
    """
    if not os.path.exists(TOPICS):
        return [], []
    with open(TOPICS, "r", encoding="utf-8") as f:
        doc = json.load(f)

    idx = index_rules(sections)
    by_key = {t["key"]: t for t in doc.get("topics", [])}
    order = doc.get("order") or list(by_key.keys())
    problems: list[str] = []
    out: list[dict] = []

    for key in order:
        topic = by_key.get(key)
        if not topic:
            problems.append("order lists unknown topic %r" % key)
            continue
        cites = []
        for rid in topic.get("canon_rules", []):
            hits = idx.get(rid)
            if not hits:
                problems.append("topic %r cites canon rule %r, which no longer exists"
                                % (key, rid))
                continue
            # Prefer a member-visible rule when an id is ambiguous.
            pick = next((h for h in hits if not h["rule"].get("internal")), hits[0])
            # Reference only — the client resolves `anchor` against `sections`,
            # which it already holds. Embedding the blocks here doubled the
            # payload by shipping every cited rule twice.
            cites.append({
                "id": pick["rule"]["id"],
                "anchor": pick["rule"]["anchor"],
                "title": pick["rule"]["title"],
                "section": pick["sec"]["num"],
            })
        t = dict(topic)
        t["cites"] = cites
        out.append(t)

    for key in by_key:
        if key not in order:
            problems.append("topic %r is defined but missing from order" % key)
    return out, problems


# ---------------------------------------------------------------- quick answers

# The questions that actually get asked mid-argument. Each maps to canon rule
# ids so the card deep-links into the full text instead of duplicating it.
QUICK = [
    {"q": "What's my starting lineup?", "tag": "lineups", "rules": ["B1"]},
    {"q": "Can I still trade him?", "tag": "trades", "rules": ["T1.7", "E1"]},
    {"q": "What's the cut penalty?", "tag": "penalty", "rules": ["C1", "D1"]},
    {"q": "Is this cut cap-free?", "tag": "penalty", "rules": ["D2", "C2"]},
    {"q": "How do taxi call-ups work?", "tag": "taxi", "rules": ["B2", "T2.4"]},
    {"q": "When's the next deadline?", "tag": "calendar", "rules": []},
    {"q": "Can I extend him?", "tag": "contracts", "rules": ["C4", "T3.3"]},
    {"q": "How does tagging work?", "tag": "tags", "rules": ["C8", "T3.5"]},
    {"q": "What's my cap room?", "tag": "cap", "rules": ["A1", "A2", "F"]},
    {"q": "How do waivers run?", "tag": "waivers", "rules": ["A4", "A5"]},
]


# ---------------------------------------------------------------- build

def _git_log1(path: str, fmt: str) -> str | None:
    try:
        out = subprocess.run(
            ["git", "-C", REPO, "log", "-1", "--format=" + fmt, "--", path],
            capture_output=True, text=True, timeout=15,
        )
        return out.stdout.strip() or None
    except Exception:
        return None


def git_sha(path: str) -> str | None:
    return _git_log1(path, "%H")


def git_date(path: str) -> str | None:
    """Commit date of the last change to `path`, ISO-8601 UTC.

    The payload is a pure function of canon, so it must not carry a wall-clock
    build time: a timestamp that moves every run makes the generated files
    differ even when canon has not, and CI then commits a no-op on every build.
    Canon's own commit date is the honest stamp and is stable for a given canon.
    """
    return _git_log1(path, "%cI")


def build() -> dict:
    with open(CANON, "r", encoding="utf-8") as f:
        canon_md = f.read()
    changelog_md = ""
    if os.path.exists(CHANGELOG):
        with open(CHANGELOG, "r", encoding="utf-8") as f:
            changelog_md = f.read()

    parsed = parse_canon(canon_md)
    entries = parse_changelog(changelog_md)

    # Rule -> last change date, so the UI can badge a rule as recently changed.
    # Keyed on (id, first word of the label) because rule ids repeat across
    # sections — "B2 Taxi Squad" must not badge Section 6's unrelated B2.
    changed: dict[tuple[str, str], str] = {}
    for e in entries:
        for a in e["affected"]:
            parts = a.strip("`").split()
            if not parts:
                continue
            # Labels are written both ways — "B2 Taxi Squad" and "B2. Taxi
            # Squad" — so the trailing period is not part of the id.
            rid = parts[0].rstrip(".")
            hint = parts[1].lower().rstrip(".,") if len(parts) > 1 else ""
            if hint and not hint[0].isalpha():
                hint = ""   # "Section 4. 2026 …" — a number is not a title hint
            key = (rid, hint)
            if rid and (key not in changed or e["date"] > changed[key]):
                changed[key] = e["date"]

    def changed_on(rule: dict) -> str | None:
        title_low = rule["title"].lower()
        best = None
        for (rid, hint), date in changed.items():
            if rid != rule["id"]:
                continue
            if hint and hint not in title_low:
                continue
            if best is None or date > best:
                best = date
        return best

    def prune(blocks: list[dict]) -> None:
        """Drop the build-time search string; the client re-derives it from
        `html` on first search. Saves ~190KB on the wire, every load."""
        for b in blocks:
            b.pop("text", None)
            if not b["internal"]:
                b.pop("internal", None)   # absent == false; 166 rules of `false` adds up

    n_rules = 0
    n_internal = 0
    for s in parsed["sections"]:
        for g in s["groups"]:
            prune(g["intro"])
            for r in g["rules"]:
                n_rules += 1
                if r["internal"]:
                    n_internal += 1
                ch = changed_on(r)
                if ch:
                    r["changed"] = ch
                prune(r["blocks"])
                for c in r.get("children", []):
                    n_rules += 1
                    if c["internal"]:
                        n_internal += 1
                    prune(c["blocks"])
    for e in entries:
        prune(e["proposal"])

    topics, topic_problems = attach_topics(parsed["sections"])

    payload = {
        "title": parsed["title"],
        "version": parsed["version"],
        "league": "UPS Salary Cap Dynasty",
        "canon_path": "docs/league_context_v1.md",
        "canon_sha": git_sha("docs/league_context_v1.md"),
        "canon_digest": hashlib.sha256(canon_md.encode("utf-8")).hexdigest()[:12],
        "canon_date": git_date("docs/league_context_v1.md"),
        "last_changed": entries[0]["date"] if entries else None,
        "counts": {"rules": n_rules, "internal": n_internal,
                   "sections": len(parsed["sections"]), "changelog": len(entries),
                   "topics": len(topics)},
        "quick": QUICK,
        "topics": topics,
        "sections": parsed["sections"],
        "changelog": entries,
    }
    payload["_problems"] = topic_problems
    return payload


BANNER = (
    "/* GENERATED FILE — DO NOT EDIT.\n"
    "   Built by scripts/build_rulebook_data.py from docs/league_context_v1.md\n"
    "   + docs/league_context_changelog.md. Edit canon, not this file; CI\n"
    "   (.github/workflows/rulebook-build.yml) regenerates and commits it.\n"
    "   Canon last changed: %s · digest %s */\n"
)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true",
                    help="parse and report only; exit 1 if the committed output is stale")
    args = ap.parse_args()

    payload = build()
    problems = payload.pop("_problems", [])
    c = payload["counts"]
    print("canon %s · %d sections · %d rules (%d internal) · %d changelog entries · %d topics"
          % (payload["version"], c["sections"], c["rules"], c["internal"],
             c["changelog"], c["topics"]))
    if problems:
        print("\nTOPIC/CANON DRIFT — a topic no longer lines up with canon:")
        for p in problems:
            print("  - %s" % p)

    body_json = json.dumps(payload, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
    js = (BANNER % (payload["canon_date"] or "uncommitted", payload["canon_digest"])) + \
         "window.UPS_RULES_DATA = " + body_json + ";\n"

    if args.check:
        stale = bool(problems)
        for path, want in ((OUT_JSON, body_json), (OUT_JS, js)):
            if not os.path.exists(path):
                print("MISSING: %s" % path)
                stale = True
                continue
            with open(path, "r", encoding="utf-8") as f:
                have = f.read()
            # Output is deterministic for a given canon, so a byte compare is
            # enough; the digest check below is the cheap version of it.
            if path.endswith(".json"):
                same = json.loads(have).get("canon_digest") == payload["canon_digest"]
            else:
                same = payload["canon_digest"] in have
            if not same:
                print("STALE: %s — canon changed since last build" % path)
                stale = True
        if stale:
            print("\nRun: python3 scripts/build_rulebook_data.py")
            return 1
        print("up to date")
        return 0

    os.makedirs(OUT_DIR, exist_ok=True)
    with open(OUT_JSON, "w", encoding="utf-8") as f:
        f.write(body_json + "\n")
    with open(OUT_JS, "w", encoding="utf-8") as f:
        f.write(js)
    print("wrote %s (%.0f KB)" % (OUT_JS, os.path.getsize(OUT_JS) / 1024.0))
    print("wrote %s (%.0f KB)" % (OUT_JSON, os.path.getsize(OUT_JSON) / 1024.0))
    return 0


if __name__ == "__main__":
    sys.exit(main())
