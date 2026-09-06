#!/usr/bin/env python3
"""UPS Wire authoring toolchain: restyle / index / verify.

    python pipelines/etl/wire/wire.py restyle   # re-inline CSS + runtime, stamp sentinel
    python pipelines/etl/wire/wire.py index     # rebuild site/wire/index.json from the articles
    python pipelines/etl/wire/wire.py verify    # enforce every invariant (this is what CI runs)

WHY THIS EXISTS
    Phase 1 shipped three articles whose CSS and runtime were inlined by hand.
    That is fine for three and a disaster for thirty: change the gold in
    wire_tokens.css and every already-published article silently keeps the old
    one. `restyle` makes a palette change mechanical and `verify` makes a missed
    one a build failure instead of a visual regression nobody notices for a month.

INVOCATION STYLE
    Called by path, not as `python -m`. The approved plan said
    `python -m pipelines.etl.wire`, but this repo has no Python packages at all
    (no __init__.py anywhere under pipelines/), and every one of the 136 existing
    builders is invoked as `python pipelines/etl/scripts/<name>.py`. Matching that
    beats adding package plumbing for one tool.

    Stdlib only -- the repo has no requirements file and CI installs nothing.

SOURCE OF TRUTH
    The ARTICLE FILES are authoritative; index.json is derived. Everything the
    index needs that markup cannot express lives in a `wire-meta` comment inside
    the article itself, so metadata travels with the file to all three surfaces.
    The one exception is the `families` array, which is curated by hand in
    index.json and preserved across regeneration.
"""

import argparse
import hashlib
import io
import json
import os
import re
import sys
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
WIRE = os.path.join(REPO, "site", "wire")
ARTICLES = os.path.join(WIRE, "articles")
INDEX = os.path.join(WIRE, "index.json")
TOKENS_CSS = os.path.join(WIRE, "wire_tokens.css")
ARTICLE_CSS = os.path.join(WIRE, "wire_article.css")
RUNTIME_JS = os.path.join(ARTICLES, "_template", "article_runtime.js")

WARN_BYTES = 250 * 1024
FAIL_BYTES = 600 * 1024
WORDS_PER_MINUTE = 200

STYLE_RE = re.compile(
    r'(<style data-wire-style="tokens\+article" data-wire-style-sha=")([^"]*)(">)([\s\S]*?)(</style>)')
RUNTIME_RE = re.compile(r'(<script data-wire-runtime>)([\s\S]*?)(</script>)')
SECTION_RE = re.compile(r'<section class="wire-sec" id="([^"]+)" data-title="([^"]+)"')
META_RE = re.compile(r'<!--\s*wire-meta\s*([\s\S]*?)-->')
TITLE_RE = re.compile(r'<title>([\s\S]*?)</title>', re.I)
KICKER_RE = re.compile(r'<div class="wire-eyebrow">([\s\S]*?)</div>')
DEK_RE = re.compile(r'<p class="wire-dek">([\s\S]*?)</p>')

STYLE_BANNER = (
    "/* GENERATED - do not edit here.\n"
    "   Source: site/wire/wire_tokens.css + site/wire/wire_article.css\n"
    "   data-wire-style-sha above is sha256(tokens + LF + article)[:8]; `verify`\n"
    "   recomputes it and fails any article whose stamp has gone stale.\n"
    "   Regenerate: python pipelines/etl/wire/wire.py restyle */\n")


# ---------------------------------------------------------------- helpers

def read(path):
    return io.open(path, encoding="utf-8").read()


def write(path, text):
    io.open(path, "w", encoding="utf-8", newline="\n").write(text)


def article_paths():
    out = []
    for season in sorted(os.listdir(ARTICLES)):
        d = os.path.join(ARTICLES, season)
        if season.startswith("_") or not os.path.isdir(d):
            continue
        for name in sorted(os.listdir(d)):
            if name.endswith(".html"):
                out.append(os.path.join(d, name))
    return out


def rel(path):
    return os.path.relpath(path, WIRE).replace(os.sep, "/")


def style_sha():
    combined = read(TOKENS_CSS) + "\n" + read(ARTICLE_CSS)
    return hashlib.sha256(combined.encode("utf-8")).hexdigest()[:8], combined


def strip_html_comments(s):
    return re.sub(r'<!--[\s\S]*?-->', '', s)


def strip_css_comments(s):
    return re.sub(r'/\*[\s\S]*?\*/', '', s)


def unescape_basic(s):
    return (s.replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">")
             .replace("&middot;", "·").replace("&mdash;", "—")
             .replace("&ndash;", "–").replace("&nbsp;", " "))


def text_of(html):
    """Visible text, for the word count behind readMinutes."""
    s = strip_html_comments(html)
    s = re.sub(r'<style[\s\S]*?</style>', ' ', s, flags=re.I)
    s = re.sub(r'<script[\s\S]*?</script>', ' ', s, flags=re.I)
    s = re.sub(r'<[^>]+>', ' ', s)
    return unescape_basic(s)


def parse_meta(html):
    """The wire-meta block: `key: value` lines, blank values become None."""
    m = META_RE.search(html)
    if not m:
        return None
    meta = {}
    for line in m.group(1).splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if ":" not in line:
            continue
        k, v = line.split(":", 1)
        v = v.strip()
        meta[k.strip()] = v if v else None
    return meta


def first(rx, html, default=""):
    m = rx.search(html)
    return unescape_basic(re.sub(r'\s+', ' ', m.group(1)).strip()) if m else default


# ---------------------------------------------------------------- restyle

def cmd_restyle(args):
    sha, combined = style_sha()
    runtime = read(RUNTIME_JS)
    if "</script" in runtime.lower():
        fail("article_runtime.js contains a script close tag; it would truncate every article")

    changed = 0
    for path in article_paths():
        html = read(path)
        before = html

        if not STYLE_RE.search(html):
            fail("%s has no <style data-wire-style> block to fill" % rel(path))
        if not RUNTIME_RE.search(html):
            fail("%s has no <script data-wire-runtime> block to fill" % rel(path))

        html = STYLE_RE.sub(
            lambda m: m.group(1) + "sha256-" + sha + m.group(3) + "\n" + STYLE_BANNER + combined + m.group(5),
            html, count=1)
        html = RUNTIME_RE.sub(lambda m: m.group(1) + "\n" + runtime + m.group(3), html, count=1)

        if html != before:
            write(path, html)
            changed += 1
            print("  restyled %s" % rel(path))

    print("restyle: %d/%d article(s) updated, style sha %s" % (changed, len(article_paths()), sha))
    if changed:
        print("         run `index` next -- contentHash is now stale")
    return 0


# ---------------------------------------------------------------- index

def build_entry(path, html):
    meta = parse_meta(html)
    if meta is None:
        fail("%s has no <!--wire-meta ... --> block" % rel(path))

    raw = io.open(path, "rb").read()
    sections = [{"id": sid, "title": unescape_basic(t)} for sid, t in SECTION_RE.findall(html)]
    words = len(text_of(html).split())

    title = first(TITLE_RE, html)
    # Strip the " - UPS Wire" suffix the <title> carries for the standalone tab.
    title = re.sub(r'\s*[-—]\s*UPS Wire\s*$', '', title)

    entry = {
        "id": os.path.basename(path)[:-5],
        "familyId": meta.get("familyId"),
        "season": int(meta["season"]) if meta.get("season") else None,
        "week": int(meta["week"]) if meta.get("week") else None,
        "kicker": first(KICKER_RE, html),
        "title": title,
        "dek": first(DEK_RE, html),
        "status": meta.get("status") or "draft",
        "publishedAt": meta.get("publishedAt"),
        "updatedAt": meta.get("updatedAt") or meta.get("publishedAt"),
        "path": rel(path),
        "contentHash": hashlib.sha256(raw).hexdigest()[:8],
        "bytes": len(raw),
        "readMinutes": max(1, round(words / float(WORDS_PER_MINUTE))),
        "sections": sections,
        "tags": [t.strip() for t in (meta.get("tags") or "").split(",") if t.strip()],
        "hero": ({"kind": "stat", "value": meta["heroValue"], "label": meta.get("heroLabel") or ""}
                 if meta.get("heroValue") else None),
        "provenance": None,
    }
    return entry


def cmd_index(args):
    existing = json.load(io.open(INDEX, encoding="utf-8")) if os.path.exists(INDEX) else {}
    families = existing.get("families") or []
    if not families:
        fail("index.json has no families[]; that array is curated by hand and must exist")

    entries = [build_entry(p, read(p)) for p in article_paths()]
    entries.sort(key=lambda e: (str(e.get("publishedAt") or ""), e["id"]), reverse=True)

    out = {
        "schema": 1,
        "generatedAtUtc": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "builder": "pipelines/etl/wire/wire.py index",
        "note": existing.get("note", ""),
        "families": families,
        "articles": entries,
    }

    # Ignore pure-timestamp churn, same rule nightly-builders.yml uses: rewriting
    # the file on every run would put a meaningless diff in every PR.
    if existing:
        a = dict(existing); a.pop("generatedAtUtc", None); a.pop("builder", None)
        b = dict(out);      b.pop("generatedAtUtc", None); b.pop("builder", None)
        if a == b:
            print("index: no change (%d article(s))" % len(entries))
            return 0

    write(INDEX, json.dumps(out, indent=2, ensure_ascii=False) + "\n")
    print("index: wrote %d article(s) across %d family(ies)" % (len(entries), len(families)))
    return 0


# ---------------------------------------------------------------- verify

class Problems(object):
    def __init__(self):
        self.items = []

    def add(self, where, what):
        self.items.append((where, what))


PACK_STAMP_RE = re.compile(r'packGeneratedAtUtc:\s*([^\n]+)')
PACK_ID_RE_V = re.compile(r'pack:\s*([^\n]+)')


def pack_path_for(pack_id):
    """Where a pack id's built pack lives, or None if the id is not season-scoped."""
    m = re.match(r'^(\d{4})-', pack_id or "")
    if not m:
        return None
    return os.path.join(REPO, "site", "wire", "packs", m.group(1), "%s.pack.json" % pack_id)


def cmd_verify(args):
    p = Problems()
    sha, combined = style_sha()
    runtime = read(RUNTIME_JS)
    paths = article_paths()

    for path in paths:
        html = read(path)
        where = rel(path)
        raw = io.open(path, "rb").read()

        # -- stale render ---------------------------------------------------
        # An article rendered from an OLDER pack than the one now on disk is
        # serving claims the data no longer supports, and nothing about it looks
        # wrong. This is not hypothetical: after did_not_play was corrected, five
        # articles still accused named owners of starting players who never took
        # a snap -- accusations the rebuilt packs no longer contain at all,
        # because every one of them was false. The render stage fail-closes only
        # if a fact id disappeared; if the VALUES changed it renders happily.
        #
        # Compared on the pack's own generatedAtUtc, recorded in the article's
        # provenance comment at render time, rather than on file mtimes, which a
        # checkout or a copy silently rewrites.
        prov = PACK_STAMP_RE.search(html)
        pid = PACK_ID_RE_V.search(html)
        if prov and pid:
            pack_path = pack_path_for(pid.group(1).strip())
            if pack_path and os.path.exists(pack_path):
                try:
                    current = json.load(io.open(pack_path, encoding="utf-8")).get("generatedAtUtc")
                except ValueError:
                    current = None
                if current and current != prov.group(1).strip():
                    p.add(where, "STALE RENDER -- built from pack %s but %s is now %s. "
                                 "Re-run `write` then `render`; do not publish this file."
                                 % (prov.group(1).strip(), rel(pack_path), current))

        # -- style sentinel -------------------------------------------------
        m = STYLE_RE.search(html)
        if not m:
            p.add(where, "no <style data-wire-style> block")
        else:
            if m.group(2) != "sha256-" + sha:
                p.add(where, "style sentinel is stale (%s, expected sha256-%s) -- run `restyle`"
                             % (m.group(2), sha))
            if combined not in m.group(4):
                p.add(where, "inlined CSS does not match wire_tokens.css + wire_article.css -- run `restyle`")

        # -- runtime drift --------------------------------------------------
        r = RUNTIME_RE.search(html)
        if not r:
            p.add(where, "no <script data-wire-runtime> block")
        elif runtime.strip() != r.group(2).strip():
            p.add(where, "inlined runtime differs from articles/_template/article_runtime.js -- run `restyle`")

        # -- rule 1: fragment links ----------------------------------------
        markup = strip_html_comments(html)
        markup = re.sub(r'<style[\s\S]*?</style>', '', markup, flags=re.I)
        markup = re.sub(r'<script[\s\S]*?</script>', '', markup, flags=re.I)
        if re.search(r'href\s*=\s*"#', markup, re.I):
            p.add(where, 'rule 1: href="#..." -- resolves against <base> and navigates the frame to jsDelivr')

        # -- rule 2: viewport-height units ----------------------------------
        for st in re.findall(r'<style[^>]*>([\s\S]*?)</style>', html, re.I):
            if re.search(r'[\d.]+\s*(vh|svh|dvh)\b', strip_css_comments(st)):
                p.add(where, "rule 2: vh/svh/dvh unit -- ratchets the frame height on every beacon tick")

        # -- rule 3: JSON data island ---------------------------------------
        if re.search(r'<script[^>]*type\s*=\s*"application/json"', strip_html_comments(html), re.I):
            p.add(where, "rule 3: <script type=application/json> -- node --check treats it as a SyntaxError")

        # -- rule 4: webfonts ------------------------------------------------
        if re.search(r'fonts\.googleapis|fonts\.gstatic|@font-face|@import\s+url', html, re.I):
            p.add(where, "rule 4: webfont reference -- breaks the Artifact surface, which has no network")

        # -- rule 5: phantom script block ------------------------------------
        # A stray "<script" desyncs scripts/check_inline_js.mjs: its regex knows
        # nothing about HTML comments, so it opens a block early and swallows the
        # next real one. Found the hard way in P1 on the article skeleton.
        #
        # Checked by reproducing the linter's own regex and asserting it sees
        # EXACTLY the runtime block -- comparing what CI sees against what is
        # really there. (An earlier version counted open tags minus nested
        # mentions; that arithmetic is invariant to a leading phantom, because
        # the phantom becomes the opener and the real opener is then counted as
        # nested. It could never fire. Do not go back to counting.)
        lint_blocks = re.findall(r'<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)</script>', html, re.I)
        if len(lint_blocks) != 1 or lint_blocks[0].strip() != runtime.strip():
            p.add(where, "rule 5: check_inline_js.mjs does not see exactly the runtime block "
                         "(%d block(s) extracted) -- a stray '<script' is desyncing it; "
                         "write &lt;script in prose" % len(lint_blocks))
        for c in re.findall(r'<!--[\s\S]*?-->', html):
            if re.search(r'<script', c, re.I):
                p.add(where, "rule 5: '<script' inside an HTML comment -- the linter does not "
                             "understand comments and will open a phantom block there")
                break

        # -- size -------------------------------------------------------------
        if len(raw) > FAIL_BYTES:
            p.add(where, "%.0f KB exceeds the %.0f KB srcdoc limit -- split it into more sections"
                         % (len(raw) / 1024.0, FAIL_BYTES / 1024.0))
        elif len(raw) > WARN_BYTES:
            print("  warn: %s is %.0f KB (soft limit %.0f KB); srcdoc parse gets slow"
                  % (where, len(raw) / 1024.0, WARN_BYTES / 1024.0))

        # -- metadata ----------------------------------------------------------
        if parse_meta(html) is None:
            p.add(where, "no <!--wire-meta ... --> block -- `index` cannot place it")

    # -- index.json agreement --------------------------------------------------
    if not os.path.exists(INDEX):
        p.add("index.json", "missing")
    else:
        idx = json.load(io.open(INDEX, encoding="utf-8"))
        family_ids = set(f["id"] for f in idx.get("families", []))
        by_id = {}
        for a in idx.get("articles", []):
            if a["id"] in by_id:
                p.add("index.json", "duplicate article id %s" % a["id"])
            by_id[a["id"]] = a

        on_disk = dict((os.path.basename(x)[:-5], x) for x in paths)
        for missing in sorted(set(on_disk) - set(by_id)):
            p.add("index.json", "article %s exists on disk but is not indexed -- run `index`" % missing)
        for orphan in sorted(set(by_id) - set(on_disk)):
            p.add("index.json", "indexed article %s has no file" % orphan)

        for aid, a in sorted(by_id.items()):
            if aid not in on_disk:
                continue
            html = read(on_disk[aid])
            raw = io.open(on_disk[aid], "rb").read()

            if a.get("familyId") not in family_ids:
                p.add("index.json", "%s has unknown familyId %r" % (aid, a.get("familyId")))
            if a.get("status") not in ("live", "draft", "archived"):
                p.add("index.json", "%s has invalid status %r" % (aid, a.get("status")))

            want = [{"id": s, "title": unescape_basic(t)} for s, t in SECTION_RE.findall(html)]
            if a.get("sections") != want:
                p.add("index.json", "%s sections[] does not match the file -- a deep link would land "
                                    "on the wrong chapter. Run `index`." % aid)

            h = hashlib.sha256(raw).hexdigest()[:8]
            if a.get("contentHash") != h or a.get("bytes") != len(raw):
                p.add("index.json", "%s contentHash/bytes stale -- the jsDelivr cache buster would not "
                                    "fire. Run `index`." % aid)

    if p.items:
        print("\nverify: %d problem(s)\n" % len(p.items))
        for where, what in p.items:
            print("  FAIL  %-42s %s" % (where, what))
        return 1

    print("verify: %d article(s), all invariants hold" % len(paths))
    return 0


def fail(msg):
    print("error: " + msg, file=sys.stderr)
    sys.exit(2)


# ---------------------------------------------------------------- packs

PACKS_DIR = os.path.join(WIRE, "packs")
PACK_BUILDERS = {"2026-preseason-review": "preseason_review"}
# weekly_recap is generic (season, week) -- one module, five 2025 instances:
# the last two regular-season weeks plus the full 3-round playoffs. Each pack
# id is registered explicitly (no wildcard matching) so `_load_builder` keeps
# failing loudly on a typo rather than silently routing somewhere unintended.
for _wk in (13, 14, 15, 16, 17):
    PACK_BUILDERS["2025-wk%02d-recap" % _wk] = "weekly_recap"


def _load_builder(pack_id):
    if pack_id not in PACK_BUILDERS:
        fail("unknown pack %r (known: %s)" % (pack_id, ", ".join(sorted(PACK_BUILDERS))))
    sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "packs"))
    return __import__(PACK_BUILDERS[pack_id])


def pack_path(pack_id, season):
    return os.path.join(PACKS_DIR, str(season), "%s.pack.json" % pack_id)


def cmd_build(args):
    """Build a data pack. Deterministic: no LLM, and no wall-clock anywhere
    except generatedAtUtc, so two runs over unchanged data differ by one line."""
    import wire_pack

    mod = _load_builder(args.pack)
    print("building %s ..." % args.pack)
    pack = mod.build(args.pack)
    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    payload = pack.to_dict(stamp)

    problems = wire_pack.validate(payload)
    hard = [p for p in problems if not p.startswith("NOTE")]
    for p in problems:
        print("  %s %s" % ("note:" if p.startswith("NOTE") else "FAIL", p))
    if hard:
        print("\nbuild aborted: %d schema problem(s)" % len(hard))
        return 1

    out = pack_path(args.pack, pack.season)
    os.makedirs(os.path.dirname(out), exist_ok=True)

    # Same timestamp-churn rule as `index`: rewriting on every run would put a
    # meaningless one-line diff in every PR.
    if os.path.exists(out):
        old = json.load(io.open(out, encoding="utf-8"))
        a = dict(old); a.pop("generatedAtUtc", None)
        b = dict(payload); b.pop("generatedAtUtc", None)
        if a == b:
            print("build: no change (%d facts, %d tables, %d charts, %d warnings)"
                  % (len(payload["facts"]), len(payload["tables"]),
                     len(payload["charts"]), len(payload["warnings"])))
            return 0

    write(out, pack.to_json(stamp))
    print("build: wrote %s" % os.path.relpath(out, REPO))
    print("       %d facts, %d tables, %d charts, %d section(s), %d warning(s), %d source(s)"
          % (len(payload["facts"]), len(payload["tables"]), len(payload["charts"]),
             len(payload["sections"]), len(payload["warnings"]), len(payload["sources"])))
    for w in payload["warnings"]:
        print("       warn: %s" % w[:110])
    return 0


def cmd_check_pack(args):
    """Re-validate a committed pack without rebuilding it (no network, no D1)."""
    import wire_pack

    path = None
    for season in sorted(os.listdir(PACKS_DIR)) if os.path.isdir(PACKS_DIR) else []:
        cand = os.path.join(PACKS_DIR, season, "%s.pack.json" % args.pack)
        if os.path.exists(cand):
            path = cand
            break
    if not path:
        fail("no committed pack for %r" % args.pack)

    payload = json.load(io.open(path, encoding="utf-8"))
    problems = wire_pack.validate(payload)
    hard = [p for p in problems if not p.startswith("NOTE")]
    for p in problems:
        print("  %s %s" % ("note:" if p.startswith("NOTE") else "FAIL", p))
    if hard:
        print("check-pack: %d problem(s) in %s" % (len(hard), os.path.relpath(path, REPO)))
        return 1
    print("check-pack: %s is schema-valid (%d facts, %d warnings)"
          % (os.path.relpath(path, REPO), len(payload["facts"]), len(payload["warnings"])))
    return 0


PACK_FAMILY = {"2026-preseason-review": "season-review"}
PACK_ARTICLE = {"2026-preseason-review": "2026-preseason-review"}
for _wk in (13, 14, 15, 16, 17):
    PACK_FAMILY["2025-wk%02d-recap" % _wk] = "weekly"


def _load_pack(pack_id):
    for season in sorted(os.listdir(PACKS_DIR)) if os.path.isdir(PACKS_DIR) else []:
        cand = os.path.join(PACKS_DIR, season, "%s.pack.json" % pack_id)
        if os.path.exists(cand):
            return json.load(io.open(cand, encoding="utf-8")), cand
    fail("no committed pack for %r -- run `build` first" % pack_id)


def prose_path(pack_id, season):
    return os.path.join(PACKS_DIR, str(season), "%s.prose.json" % pack_id)


def cmd_write(args):
    """The ONE stage that calls a model. Everything it produces is committed as
    an artifact so the render stage stays reproducible without a key."""
    import wire_write

    pack, pack_file = _load_pack(args.pack)
    family = PACK_FAMILY.get(args.pack, "dispatch")
    print("writing prose for %s (family %s, model %s)"
          % (args.pack, family, args.model))
    print("  pack: %s facts, %s tables, %s charts, %s warnings"
          % (len(pack["facts"]), len(pack["tables"]), len(pack["charts"]),
             len(pack["warnings"])))

    prose, meta = wire_write.write_prose(pack, family, model=args.model)
    out = prose_path(args.pack, pack["season"])
    os.makedirs(os.path.dirname(out), exist_ok=True)
    write(out, json.dumps({"meta": meta, "prose": prose}, indent=2, ensure_ascii=False) + "\n")
    print("write: wrote %s" % os.path.relpath(out, REPO))
    print("       engine %s, %s in / %s out tokens, %d section(s)"
          % (meta["engine"], meta.get("inputTokens"), meta.get("outputTokens"),
             len(prose.get("sections", []))))
    print("       next: render, then restyle + index, then read it before flipping to live")
    return 0


def cmd_render(args):
    """pack + prose -> article HTML. Deterministic and key-free, which is what
    lets a palette or template change be re-applied without re-running a model."""
    import wire_render

    pack, _ = _load_pack(args.pack)
    p_path = prose_path(args.pack, pack["season"])
    if not os.path.exists(p_path):
        fail("no prose for %r -- run `write` first" % args.pack)
    blob = json.load(io.open(p_path, encoding="utf-8"))
    prose, pmeta = blob["prose"], blob.get("meta", {})

    article_id = PACK_ARTICLE.get(args.pack, args.pack)
    meta = {
        "familyId": PACK_FAMILY.get(args.pack, "dispatch"),
        "season": pack["season"],
        "week": pack.get("week") or "",
        # Always born as a draft. Promotion to live is a separate, deliberate
        # commit -- merging for preview must never be the same act as publishing.
        "status": "draft",
        "publishedAt": pack["generatedAtUtc"],
        "tags": "",
        "heroValue": "",
        "heroLabel": "",
        "engine": pmeta.get("engine", "unknown"),
    }

    try:
        html = wire_render.render_article(pack, prose, meta)
    except wire_render.RenderError as exc:
        print("render FAILED: %s" % exc, file=sys.stderr)
        return 1

    out = os.path.join(ARTICLES, str(pack["season"]), "%s.html" % article_id)
    os.makedirs(os.path.dirname(out), exist_ok=True)
    write(out, html)
    print("render: wrote %s" % os.path.relpath(out, REPO))
    print("        numeric audit passed -- every quantity came from the pack")
    print("        status=draft (hidden from the index until you flip it)")
    print("        next: restyle, then index, then verify")
    return 0


def main():
    ap = argparse.ArgumentParser(description="UPS Wire authoring toolchain")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("restyle", help="re-inline CSS + runtime into every article and stamp the sentinel")
    sub.add_parser("index", help="rebuild site/wire/index.json from the article files")
    sub.add_parser("verify", help="enforce every article invariant (CI runs this)")
    b = sub.add_parser("build", help="build a data pack from live data (needs D1 + worker)")
    b.add_argument("--pack", required=True, help="pack id, e.g. 2026-preseason-review")
    c = sub.add_parser("check-pack", help="re-validate a committed pack offline")
    c.add_argument("--pack", required=True)
    w = sub.add_parser("write", help="pack -> prose via Claude (needs ANTHROPIC_API_KEY)")
    w.add_argument("--pack", required=True)
    w.add_argument("--model", default="claude-opus-5")
    r = sub.add_parser("render", help="pack + prose -> article HTML (deterministic, no key)")
    r.add_argument("--pack", required=True)
    args = ap.parse_args()
    return {"restyle": cmd_restyle, "index": cmd_index, "verify": cmd_verify,
            "build": cmd_build, "check-pack": cmd_check_pack,
            "write": cmd_write, "render": cmd_render}[args.cmd](args)


if __name__ == "__main__":
    sys.exit(main())
