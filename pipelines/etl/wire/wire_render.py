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
# Years read naturally in prose. NARROW ON PURPOSE: the old band was 1950-2049,
# a hundred blind values, and this league's cap figures land inside it -- the
# preseason pack's median auction price is $2,000, so "paid 2000 for him"
# published unchecked. 2010 is the league's first season and 2035 is past any
# article it will write; outside that, a four-digit run is a quantity, not a date.
YEAR_RE = re.compile(r'\b(201\d|202\d|203[0-5])\b')
# Rookie pick notation ("1.05") is a league idiom, not a fabricated statistic.
# Bounded to REAL picks -- rounds 1-6, slots 01-12 in a twelve-team league --
# because the old \d\.\d{2} blanked everything from 0.00 to 9.99, which is
# exactly where margins, per-week averages and all-play rates live. "won by
# 3.75" and "all-play sits at 8.25" both published as pick references.
PICK_RE = re.compile(r'\b[1-6]\.(?:0[1-9]|1[0-2])\b')
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


# Spelled-out quantities big enough to be a statistic. Small numbers read
# naturally ("a dozen teams", "twice", "the last three weeks") and are allowed;
# these are not -- "he lost by seventy" is a MEASUREMENT wearing a word costume
# and slips past the digit audit entirely.
#
# ANY of these words, ANYWHERE. The first version required the quantity to sit
# immediately after one of by/of/for/about/..., which a single article defeats:
# "lost by seventy" was a hard build failure while "lost by a hundred", "hung
# seventy on him", "benched seventy points" and "a seventy-point beating" all
# published as unverified measurements. In this register a spelled number this
# large is a measurement essentially every time, so it is banned outright and
# the writer uses a token.
SPELLED_QUANTITY_RE = re.compile(
    r'\b(twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand)\b', re.I)
# The one genuine idiom, where the word is emphasis rather than measurement.
SPELLED_OK_RE = re.compile(r'\b(?:a\s+|one\s+)?hundred\s+percent\b', re.I)


def audit_spelled_quantities(text, where):
    """Reject spelled-out large quantities used as statistics.

    The digit audit makes a typed number impossible; without this, the model can
    simply write the number as a word and nothing checks it against the pack.
    """
    scrubbed = SPELLED_OK_RE.sub(" ", text)
    hit = SPELLED_QUANTITY_RE.search(scrubbed)
    if hit:
        raise RenderError(
            "%s spells out a quantity (\"%s\") instead of using a fact token. Spelled-out "
            "measurements bypass the numeric audit entirely -- use a {{fact_id}}."
            % (where, hit.group(0)))


def audit_prose(html_fragment, where, proper=()):
    """Any digit surviving in model-authored prose is a fabricated number.

    Substituted facts are wrapped in .wire-num and stripped before the scan, so
    what remains is text the model typed itself.

    `proper` is the league's own proper nouns -- owners, teams, divisions --
    removed before the scan because some of them CONTAIN a numeral. This league
    has a division called DOG POUND 4 LIFE, and naming it correctly failed the
    audit as a fabricated quantity. A name is not a measurement. Longest first,
    so a name that contains another name is removed whole.
    """
    text = re.sub(r'<span class="wire-num"[\s\S]*?</span>', ' ', html_fragment)
    text = re.sub(r'<[^>]+>', ' ', text)
    for name in sorted((p for p in proper if p and any(c.isdigit() for c in p)),
                       key=len, reverse=True):
        text = re.sub(re.escape(name), ' ', text, flags=re.I)
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


# "his division game", "a divisional matchup", "inside the division". Deliberately
# narrow: it must be a claim ABOUT THIS GAME's competitive context, so a note that
# merely mentions a division name or a division RECORD does not trip it.
DIVISION_CLAIM_RE = re.compile(
    # division(?:al)? -- NOT `divisional?`, where the ? binds to the l alone and
    # so demands the 'a'. Plain "division game" never matched.
    r'\b(?:intra-)?division(?:al)?\s+'
    r'(?:game|matchup|meeting|clash|rivalry|tilt|showdown|battle|opponent|series|'
    r'rival|rivals|foe|test|date|fixture)\b'
    r'|\bshares?\s+a\s+division\b'
    r'|\bsame\s+division\b', re.I)


# Sentences pointing FORWARD. A division game a team has next week is a real,
# checkable statement that says nothing about the game on this page.
FUTURE_CUE_RE = re.compile(
    r'\bnext\b|\bupcoming\b|\bstill\s+to\s+(?:come|play)\b|\bleft\s+on\s+the\s+schedule\b'
    r'|\brest\s+of\s+the\s+way\b|\bfrom\s+here\b|\bahead\s+of\s+(?:him|them)\b', re.I)


def audit_game_note(text, where, game):
    """Claims about a game that the pack can check, and therefore must.

    The numeric contract makes a fabricated NUMBER impossible and does nothing
    about a fabricated CLAIM -- that limit was always stated, and an adversarial
    read of the first eighteen game notes found it three times. One is
    mechanically checkable and is checked here.

    THE DIVISION CLAIM. A note wrote "Martel wins his division game" about two
    owners in different divisions, in a week where src_schedule flags zero games
    divisional. That is not a matter of taste or emphasis: the pack knows, per
    game, whether it was a division game. So if the note says it was and the
    pack says it was not, the build fails.

    The other two -- "the highest ceiling of any loser" (it was third) and "the
    second-biggest beating of the slate" (also third) -- are ordinal claims over
    a set. Rather than parse English rankings, the builder now hands the writer
    the true rank as a fact so it never has to count; see weekly_recap's
    margin_rank and ceiling_rank.
    """
    if game.get("divisional"):
        return
    # Deliberately does NOT match a team's POSITION in its division -- "worst in
    # the division", "best record in the division", "alone at the top of it".
    # Those are standings claims, the weekly brief explicitly asks for them, and
    # an earlier version failed builds on correct prose because of it.
    for hit in DIVISION_CLAIM_RE.finditer(text):
        # A division game the owner has NEXT is not a claim about this one.
        # "Dunn's next opponent is a division rival" is true, checkable elsewhere,
        # and failed the build until this carve-out existed.
        start = text.rfind(".", 0, hit.start()) + 1
        end = text.find(".", hit.end())
        sentence = text[start:end if end != -1 else len(text)]
        if FUTURE_CUE_RE.search(sentence):
            continue
        raise RenderError(
            "%s calls this a division game (\"%s\") but %s v %s is not one -- src_schedule "
            "flags it is_divisional=0.\n    Say what the matchup actually was; the page "
            "already prints both divisions."
            % (where, hit.group(0), game.get("winner"), game.get("loser")))


def audit_and_substitute(text, where, facts, proper=()):
    """THE single gate every model-authored string passes through.

    Four checks in one place, because splitting them was the bug: captions ran
    only two of the four, and the kicker, headline and dek ran only one. A
    fabricated quotation attributed to a real owner and a spelled-out fabricated
    margin both published in a headline while the identical sentence was
    rejected in body copy. There is now exactly one door.

    Returns finished HTML: escaped, tokens substituted, audited.
    """
    audit_no_typed_quotes(text, where)
    audit_spelled_quantities(text, where)
    frag = substitute(esc(text), facts, where)
    audit_prose(frag, where, proper)
    return frag


def render_table(table, caption_html=None):
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
            elif kind == "points":
                # Fantasy points, NOT money. Margins and scores were typed "usd"
                # and rendered as "$91" for a 91.3-point margin -- currency
                # symbol on a football score, and the decimal truncated away.
                # One decimal, no symbol.
                txt, cls = "%.1f" % float(v), "wire-num"
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
    if caption_html:
        # Already escaped and substituted by audit_and_substitute. Escaping it
        # again printed the substitution span as literal tag text, so a caption
        # using the one sanctioned way to state a number rendered as
        # `&lt;span class="wire-num"...&gt;35&lt;/span&gt;` to the reader.
        parts.append("<figcaption>%s</figcaption>" % caption_html)
    if table.get("note"):
        parts.append("<figcaption>%s</figcaption>" % esc(table["note"]))
    parts.append("</figure>")
    return "\n".join(parts)


def render_quote(q):
    """A verbatim blockquote. The text comes from the pack, never from the model."""
    who = esc(q["author"])
    when = esc(q.get("when") or "")
    attribution = who + ((" &middot; " + when) if when else "")
    return ('<blockquote>%s<span>&mdash; %s</span></blockquote>'
            % (esc(q["text"]), attribution))


# A run of words inside double quotes, long enough to be a real quotation rather
# than a scare-quoted term. Used to catch the model typing dialogue itself.
#
# TYPOGRAPHIC QUOTES COUNT. The first version matched ASCII double quotes only,
# so the identical invented quotation written with curly quotes -- which is what
# a model reaching for dialogue actually produces -- sailed straight through and
# published attributed to a real owner. Both forms, and the closing character is
# not required to match the opening one.
_Q = '"\u201c\u201d\u201e\u201f\u00ab\u00bb'
TYPED_QUOTE_RE = re.compile(r'[%s][^%s]{25,}[%s]' % (_Q, _Q, _Q))


def audit_no_typed_quotes(text, where):
    """Reject model-authored quotations.

    Quotes are placed by id and rendered from the pack. If a quotation appears
    in the model's own prose it was either invented or paraphrased from a real
    message -- and a misquote attributed to a real owner is worse than a wrong
    number, because it reads as a receipt.
    """
    hit = TYPED_QUOTE_RE.search(text)
    if hit:
        raise RenderError(
            "%s contains a typed quotation: %s\n    Quotes must be placed by id in the "
            "section's \"quotes\" array so they render verbatim from the pack."
            % (where, hit.group(0)[:120]))


def render_playcard(c):
    """A big-performance callout.

    FOOTAGE, WITHOUT BREAKING THE OTHER TWO SURFACES. When wire_video found a
    clip that cleared every conviction test, the card names that exact video and
    links to it -- and marks itself `data-wire-video` so the runtime can swap in
    a real player where one can actually run.

    It does not ship an <iframe> in the markup, and that is deliberate. An
    article renders in three places and has to work in all of them: a Claude
    Artifact's CSP blocks every external host, and the MFL embed sandboxes
    articles WITHOUT allow-same-origin -- which is what stops model-written HTML
    from running with MFL-origin privileges, and is not worth trading for a
    video player. So the default markup is network-free everywhere, and the
    standalone page upgrades itself. Degrading to a named link is fine;
    weakening the sandbox is not.
    """
    parts = ['<aside class="wire-play">']
    parts.append('<div class="wire-play-head">')
    parts.append('<span class="wire-play-name">%s</span>' % esc(c["player"]))
    meta = " &middot; ".join(esc(x) for x in (c.get("position"), c.get("nflMatchup")) if x)
    if meta:
        parts.append('<span class="wire-play-meta">%s</span>' % meta)
    parts.append("</div>")
    parts.append('<div class="wire-play-score">%s</div>' % esc("%.1f" % float(c["score"])))
    if c.get("owner"):
        parts.append('<div class="wire-play-owner">started by %s</div>' % esc(c["owner"]))
    if c.get("boxLine"):
        parts.append('<div class="wire-play-line">%s</div>' % esc(c["boxLine"]))
    if c.get("note"):
        parts.append('<div class="wire-play-note">%s</div>' % esc(c["note"]))
    vid = c.get("video") or {}
    if vid.get("videoId"):
        # A specific, verified clip. data-* carries the id so the runtime can
        # build a player; the anchor works with scripting off, in an Artifact,
        # and in the sandboxed MFL frame.
        parts.append('<div class="wire-play-video" data-wire-video="%s">'
                     '<a class="wire-play-watch" href="https://www.youtube.com/watch?v=%s" '
                     'target="_blank" rel="noopener">&#9654;&#65039; %s</a>'
                     '<span class="wire-play-vsrc">%s</span></div>'
                     % (esc(vid["videoId"]), esc(vid["videoId"]),
                        esc(vid.get("title") or "Watch the highlights"),
                        esc(vid.get("channel") or "")))
    elif c.get("watchUrl"):
        # No clip cleared the bar. A search link is an honest "go look"; naming
        # a video we are not sure of would be a claim.
        # Absolute + target=_blank: rule 1 bans fragment links, and the frame's
        # sandbox carries the allow-popups pair so this actually opens.
        parts.append('<a class="wire-play-watch" href="%s" target="_blank" '
                     'rel="noopener">Find the highlights &#8599;</a>' % esc(c["watchUrl"]))
    parts.append("</aside>")
    return "\n".join(parts)


def render_tale(rows, winner, loser):
    """Tale of the tape: the two teams compared line by line.

    The visual spine of a game page. Each row is one metric with both values and
    a marker on whichever side is better, so the shape of the matchup reads
    before a word of prose does.
    """
    if not rows:
        return ""
    out = ['<div class="wire-tott">',
           '<div class="wire-tott-head"><span>%s</span><span></span><span>%s</span></div>'
           % (esc(winner), esc(loser))]
    for r in rows:
        better = r.get("better")
        acls = " wire-tott-win" if better == "a" else ""
        bcls = " wire-tott-win" if better == "b" else ""
        out.append('<div class="wire-tott-row">'
                   '<span class="wire-tott-v%s">%s</span>'
                   '<span class="wire-tott-l">%s</span>'
                   '<span class="wire-tott-v%s">%s</span></div>'
                   % (acls, esc(r["a"]), esc(r["label"]), bcls, esc(r["b"])))
    out.append("</div>")
    return "".join(out)


def render_game(g, blurb_html=None, card=None, quotes=()):
    """One game as a full page in the flip-through deck.

    Ordered by billing (combined incoming all-play), so the deck opens on the
    biggest matchup of the week rather than the biggest blowout.

    EVERYTHING ON THIS PAGE IS ABOUT THESE TWO TEAMS. The card is the biggest
    performance in THIS game and the quotes are chat about THESE owners -- both
    are passed in already resolved by the caller. The first version hung the
    section's cards and quotes after the deck instead, which put a card for a
    player in someone else's matchup on top of a game page.

    `blurb_html` is the writer's own paragraph for this matchup, already
    substituted and audited. Without one the page still stands up on its
    generated parts, which is the graceful-degradation default everywhere here.
    """
    parts = ['<article class="wire-gamepage" id="%s" data-title="%s">'
             % (esc(g["id"]), esc("%s v %s" % (g["winner"], g["loser"])))]
    parts.append('<div class="wire-gamepage-head">')
    tags = []
    if g.get("headline"):
        tags.append('<span class="wire-gamepage-kicker">%s</span>' % esc(g["headline"]))
    if g.get("tag"):
        tags.append('<span class="wire-game-tag%s">%s</span>'
                    % (" wire-game-tag-div" if g.get("divisional") else "", esc(g["tag"])))
    if tags:
        parts.append('<div class="wire-gamepage-tags">%s</div>' % "".join(tags))
    parts.append('<div class="wire-gamepage-score">'
                 '<span class="wire-gp-team">%s</span>'
                 '<span class="wire-gp-num">%s</span>'
                 '<span class="wire-gp-dash">&ndash;</span>'
                 '<span class="wire-gp-num wire-gp-lose">%s</span>'
                 '<span class="wire-gp-team wire-gp-lose">%s</span></div>'
                 % (esc(g["winner"]), esc("%.1f" % float(g["winnerScore"])),
                    esc("%.1f" % float(g["loserScore"])), esc(g["loser"])))
    parts.append("</div>")

    if blurb_html:
        parts.append('<div class="wire-game-blurb"><p>%s</p></div>' % blurb_html)

    parts.append(render_tale(g.get("tale"), g["winner"], g["loser"]))

    if card:
        parts.append(render_playcard(card))

    rows = []
    if g.get("winnerBest"):
        rows.append(("Led %s" % g["winner"], g["winnerBest"]))
    if g.get("loserBest"):
        rows.append(("Led %s" % g["loser"], g["loserBest"]))
    if g.get("loserBenchMiss"):
        rows.append(("%s left on the bench" % g["loser"], g["loserBenchMiss"]))
    if rows:
        parts.append('<div class="wire-gamepage-body">')
        for k, v in rows:
            parts.append('<div class="wire-game-row"><span>%s</span><span>%s</span></div>'
                         % (esc(k), esc(v)))
        parts.append("</div>")
    if g.get("note"):
        parts.append('<div class="wire-game-note">%s</div>' % esc(g["note"]))
    for q in quotes or []:
        parts.append(render_quote(q))
    parts.append("</article>")
    return "".join(parts)


def render_sections(pack, prose):
    facts = dict((f["id"], f) for f in pack["facts"])
    tables = dict((t["id"], t) for t in pack["tables"])
    charts = dict((c["id"], c) for c in pack["charts"])
    quotes = dict((q["id"], q) for q in pack.get("quotes", []))
    cards = dict((c["id"], c) for c in pack.get("playcards", []))
    games = dict((g["id"], g) for g in pack.get("games", []))

    # The league's own proper nouns, for the digit audit. Divisions especially:
    # "DOG POUND 4 LIFE" is a name, not a quantity, and the first run of the
    # rebuilt landscape section failed on it.
    ents = pack.get("entities") or {}
    proper = ([o.get("display") for o in ents.get("owners") or []]
              + [f.get("name") for f in ents.get("franchises") or []]
              + list(ents.get("divisions") or []))
    proper = [p for p in proper if p]

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
            body.append("<p>%s</p>" % audit_and_substitute(s["lead"], where, facts, proper))

        for para in s.get("paragraphs") or []:
            body.append("<p>%s</p>" % audit_and_substitute(para, where, facts, proper))

        bullets = s.get("bullets") or []
        if bullets:
            body.append("<ul>%s</ul>" % "".join(
                "<li>%s</li>" % audit_and_substitute(b, where, facts, proper)
                for b in bullets))

        gids = s.get("games") or []
        if gids:
            # A blurb PER MATCHUP. One league-wide paragraph in front of eighteen
            # game pages is a lead, not analysis -- so the writer owes each game
            # its own, and it goes through the identical numeric contract.
            notes = s.get("gameNotes") or {}
            unknown = [k for k in notes if k not in gids]
            if unknown:
                raise RenderError("%s writes a game note for a game it does not place: %s"
                                  % (where, ", ".join(sorted(unknown))))
            blocks = []
            for gid in gids:
                if gid not in games:
                    raise RenderError("%s places unknown game id %s" % (where, gid))
                g = games[gid]
                blurb = None
                raw = notes.get(gid)
                if raw:
                    gw = "%s note %s" % (where, gid)
                    audit_game_note(raw, gw, g)
                    blurb = audit_and_substitute(raw, gw, facts, proper)
                card = cards.get(g.get("cardId")) if g.get("cardId") else None
                if g.get("cardId") and not card:
                    raise RenderError("game %s carries unknown playcard %s"
                                      % (gid, g["cardId"]))
                gq = []
                for qid in g.get("quoteIds") or []:
                    if qid not in quotes:
                        raise RenderError("game %s carries unknown quote %s" % (gid, qid))
                    gq.append(quotes[qid])
                blocks.append(render_game(g, blurb, card, gq))
            body.append('<div class="wire-gamedeck" data-wire-gamedeck>'
                        '<nav class="wire-gamedeck-rail" data-wire-gamerail></nav>'
                        '%s</div>' % "".join(blocks))

        for cid in s.get("cards") or []:
            if cid not in cards:
                raise RenderError("%s places unknown playcard id %s" % (where, cid))
            body.append(render_playcard(cards[cid]))

        for qid in s.get("quotes") or []:
            if qid not in quotes:
                raise RenderError("%s places unknown quote id %s" % (where, qid))
            body.append(render_quote(quotes[qid]))

        captions = s.get("captions") or {}
        for pid in s.get("place") or []:
            cap = captions.get(pid)
            cap_frag = (audit_and_substitute(cap, "%s caption %s" % (where, pid),
                                             facts, proper) if cap else None)
            if pid in tables:
                body.append(render_table(tables[pid], cap_frag))
            elif pid in charts:
                # cap_frag, NOT cap. Passing the raw string here shipped literal
                # {{f.some.id}} braces to the reader -- and the digits inside the
                # fact id had never been seen by the audit that approved it.
                body.append(wire_svg.render_chart(charts[pid], cap_frag))
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

    # The three most-read strings in the article went through ONE of the four
    # audits. A headline could carry an invented quotation and a spelled-out
    # fabricated margin that body copy rejects. Same gate as everything else.
    ents = pack.get("entities") or {}
    proper = [x for x in ([o.get("display") for o in ents.get("owners") or []]
                          + [f.get("name") for f in ents.get("franchises") or []]
                          + list(ents.get("divisions") or [])) if x]
    facts = dict((f["id"], f) for f in pack["facts"])
    kicker = audit_and_substitute(kicker, "the kicker", facts, proper) if kicker else ""
    title_html = audit_and_substitute(title, "the title", facts, proper) if title else ""
    dek = audit_and_substitute(dek, "the dek", facts, proper) if dek else ""

    meta_lines = "\n".join("  %s: %s" % (k, meta.get(k, "")) for k in
                           ("familyId", "season", "week", "status", "publishedAt",
                            "tags", "heroValue", "heroLabel"))

    return """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>%(doc_title)s &mdash; UPS Wire</title>
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
        # <title> is plain text and cannot carry markup, so it uses the raw
        # string; the on-page headline uses the audited HTML.
        # From the RAW title, escaped once. Building it from title_html escaped
        # an already-escaped string, so "Cross & Dunn" reached the browser tab
        # and the hub card as "Cross &amp;amp; Dunn".
        "doc_title": esc(title),
        "title": title_html,
        "kicker": kicker,
        "dek": dek,
        "meta_lines": meta_lines,
        "pack_id": esc(pack["packId"]),
        "pack_stamp": esc(pack["generatedAtUtc"]),
        "engine": esc(meta.get("engine", "unknown")),
        "method": render_method(pack),
        "sections": render_sections(pack, prose),
    }
