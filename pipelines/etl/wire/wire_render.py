#!/usr/bin/env python3
"""Turn a pack + model prose into an article. Deterministic; no model involved.

This stage being key-free and repeatable is what makes palette changes, template
fixes and chart tweaks safe forever: you never have to re-run the model to
re-render an article.

THE NUMERIC CONTRACT, in four layers, cheapest first:
  1. The prompt forbids digits (wire_voice.WIRE_SYSTEM).
  2. Token substitution is FAIL-CLOSED: an unknown {{fact_id}} aborts the build
     rather than passing through as literal braces.
  3. A post-render audit scans the rendered prose for any surviving digit run,
     excluding generated markup, and aborts on anything not in a narrow
     allowlist.
  4. Tables and charts are generated from the pack. The model chooses placement
     and writes captions; there is no path by which it authors a row.

Layers 1-4 make a fabricated NUMBER impossible. They do nothing about a
fabricated CLAIM, which is why the human review gate before draft->live exists
and why there is no auto-publish path.
"""

import re

import wire_svg

TOKEN_RE = re.compile(r'\{\{\s*([a-zA-Z0-9._-]+)\s*\}\}')
# Years read naturally in prose and cannot be confused with a league quantity.
YEAR_RE = re.compile(r'\b(19[5-9]\d|20[0-4]\d)\b')
# Rookie pick notation ("1.05") is a league idiom, not a fabricated statistic.
PICK_RE = re.compile(r'\b\d\.\d{2}\b')
DIGIT_RUN_RE = re.compile(r'\d+')


class RenderError(RuntimeError):
    pass


def esc(s):
    return (str(s).replace("&", "&amp;").replace("<", "&lt;")
            .replace(">", "&gt;"))


def substitute(text, facts, where):
    """{{f.some.id}} -> a marked span carrying the value. Fail-closed."""
    missing = []

    def repl(m):
        fid = m.group(1)
        f = facts.get(fid)
        if not f:
            missing.append(fid)
            return m.group(0)
        return ('<span class="wire-num" data-fact="%s">%s</span>'
                % (esc(fid), esc(f["fmt"])))

    out = TOKEN_RE.sub(repl, text)
    if missing:
        raise RenderError("%s references unknown fact id(s): %s"
                          % (where, ", ".join(sorted(set(missing)))))
    return out


def audit_prose(html_fragment, where):
    """Any digit surviving in model-authored prose is a fabricated number.

    Substituted facts are wrapped in .wire-num and stripped before the scan, so
    what remains is text the model typed itself.
    """
    text = re.sub(r'<span class="wire-num"[\s\S]*?</span>', ' ', html_fragment)
    text = re.sub(r'<[^>]+>', ' ', text)
    text = YEAR_RE.sub(' ', text)
    text = PICK_RE.sub(' ', text)
    hits = DIGIT_RUN_RE.findall(text)
    if hits:
        snippet = re.sub(r'\s+', ' ', text).strip()
        idx = snippet.find(hits[0])
        context = snippet[max(0, idx - 70):idx + 70]
        raise RenderError(
            "%s contains digits the model typed itself (%s). Every quantity must be a "
            "{{fact_id}} token.\n    ...%s..." % (where, ", ".join(hits[:5]), context))


def render_table(table, caption=None):
    cols = table["columns"]
    head = "".join('<th%s>%s</th>' % (' class="wire-num"' if c.get("align") == "right" else "",
                                      esc(c["label"])) for c in cols)
    body = []
    for row in table["rows"]:
        cells = []
        for c, v in zip(cols, row):
            kind = c.get("type")
            if kind == "usd":
                txt, cls = "$%s" % format(int(round(v)), ",d"), "wire-num"
            elif kind == "count":
                txt, cls = format(int(v), ",d"), "wire-num"
            elif kind == "percent":
                txt, cls = "%.1f%%" % v, "wire-num"
            else:
                txt, cls = str(v), ""
            cells.append('<td%s>%s</td>' % ((' class="%s"' % cls) if cls else "", esc(txt)))
        body.append("<tr>%s</tr>" % "".join(cells))

    parts = ['<figure class="wire-fig">',
             '<div class="wire-tablewrap"><table><thead><tr>%s</tr></thead><tbody>%s</tbody>'
             '</table></div>' % (head, "".join(body))]
    if caption:
        parts.append("<figcaption>%s</figcaption>" % esc(caption))
    if table.get("note"):
        parts.append("<figcaption>%s</figcaption>" % esc(table["note"]))
    parts.append("</figure>")
    return "\n".join(parts)


def render_sections(pack, prose):
    facts = dict((f["id"], f) for f in pack["facts"])
    tables = dict((t["id"], t) for t in pack["tables"])
    charts = dict((c["id"], c) for c in pack["charts"])

    outline = [s["id"] for s in pack["sections"]]
    written = dict((s["id"], s) for s in prose.get("sections", []))
    missing = [s for s in outline if s not in written]
    if missing:
        raise RenderError("prose is missing section(s) the pack requires: %s"
                          % ", ".join(missing))

    out = []
    for spec in pack["sections"]:
        sid = spec["id"]
        s = written[sid]
        where = "section %s" % sid

        body = []
        if s.get("lead"):
            frag = substitute(esc(s["lead"]), facts, where)
            audit_prose(frag, where)
            body.append("<p>%s</p>" % frag)

        for para in s.get("paragraphs") or []:
            frag = substitute(esc(para), facts, where)
            audit_prose(frag, where)
            body.append("<p>%s</p>" % frag)

        bullets = s.get("bullets") or []
        if bullets:
            items = []
            for b in bullets:
                frag = substitute(esc(b), facts, where)
                audit_prose(frag, where)
                items.append("<li>%s</li>" % frag)
            body.append("<ul>%s</ul>" % "".join(items))

        captions = s.get("captions") or {}
        for pid in s.get("place") or []:
            cap = captions.get(pid)
            if cap:
                cap_frag = substitute(esc(cap), facts, "%s caption %s" % (where, pid))
                audit_prose(cap_frag, "%s caption %s" % (where, pid))
            else:
                cap_frag = None
            if pid in tables:
                body.append(render_table(tables[pid], cap_frag))
            elif pid in charts:
                body.append(wire_svg.render_chart(charts[pid], cap))
            else:
                raise RenderError("%s places unknown id %s" % (where, pid))

        out.append(
            '<section class="wire-sec" id="%s" data-title="%s">\n'
            '    <h2 class="wire-sechead">%s</h2>\n    %s\n  </section>'
            % (esc(sid), esc(spec["title"]), esc(spec["title"]), "\n    ".join(body)))
    return "\n\n  ".join(out)


def render_method(pack):
    """The 'how this was built' panel: sources and every warning, verbatim.

    Warnings are rendered, never summarised -- a caveat the writer paraphrased
    away is a caveat the reader never saw.

    COLLAPSED behind a disclosure, because the list grows with every source
    added and at nine notes it filled the entire first screen, pushing the
    headline off the page. The count is in the summary so the reader knows how
    much is there, and print CSS forces it open.
    """
    rows = []
    src = "; ".join("%s (%s)" % (s["name"], s["asof"]) for s in pack["sources"])
    rows.append("<div><b>Sources.</b> %s</div>" % esc(src))
    for w in pack["warnings"]:
        rows.append("<div><b>Caveat.</b> %s</div>" % esc(w))

    n = len(pack["warnings"])
    label = "%d note%s" % (n, "" if n == 1 else "s")
    return ('<div class="wire-method">\n'
            '    <details>\n'
            '      <summary class="wire-mh">How this was built '
            '<span class="wire-method-count">&mdash; %s</span></summary>\n'
            '      <div class="wire-method-body">\n        %s\n      </div>\n'
            '    </details>\n  </div>' % (label, "\n        ".join(rows)))


def render_article(pack, prose, meta):
    """Full self-contained document, minus the style and runtime bodies --
    `restyle` fills those, so this stage never duplicates them."""
    kicker = prose.get("kicker") or meta.get("kicker") or ""
    title = prose.get("title") or pack.get("title") or pack["packId"]
    dek = prose.get("dek") or ""

    for label, value in (("kicker", kicker), ("title", title), ("dek", dek)):
        audit_prose(esc(value), "the %s" % label)

    meta_lines = "\n".join("  %s: %s" % (k, meta.get(k, "")) for k in
                           ("familyId", "season", "week", "status", "publishedAt",
                            "tags", "heroValue", "heroLabel"))

    return """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>%(title)s &mdash; UPS Wire</title>
<!--wire-meta
  Generated by pipelines/etl/wire/wire.py render. Rebuild the index with:
  python pipelines/etl/wire/wire.py index
%(meta_lines)s
-->
<!--wire-provenance
  pack: %(pack_id)s
  packGeneratedAtUtc: %(pack_stamp)s
  engine: %(engine)s
-->
<style data-wire-style="tokens+article" data-wire-style-sha="sha256-PLACEHOLDER">
</style>
</head>
<body>

<div class="wire-page">
<div class="wire-wrap">

  <div class="wire-topbar">
    <button class="wire-back" data-wire-back type="button">All stories</button>
    <span class="wire-topbar-title">UPS Wire</span>
  </div>

  <header class="wire-hero">
    <div class="wire-eyebrow">%(kicker)s</div>
    <h1>%(title)s</h1>
    <p class="wire-dek">%(dek)s</p>
  </header>

  %(method)s

  <nav class="wire-rail" data-wire-rail aria-label="Sections"></nav>

  %(sections)s

  <footer>
    UPS Wire &middot; built from %(pack_id)s &middot; league 74598
  </footer>

</div>
</div>

<script data-wire-runtime>
</script>
</body>
</html>
""" % {
        "title": esc(title),
        "kicker": esc(kicker),
        "dek": esc(dek),
        "meta_lines": meta_lines,
        "pack_id": esc(pack["packId"]),
        "pack_stamp": esc(pack["generatedAtUtc"]),
        "engine": esc(meta.get("engine", "unknown")),
        "method": render_method(pack),
        "sections": render_sections(pack, prose),
    }
