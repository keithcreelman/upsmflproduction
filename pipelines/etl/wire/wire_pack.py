#!/usr/bin/env python3
"""UPS Wire data pack: the deterministic half of report generation.

A pack is every verified number a report is allowed to use, with provenance,
built with NO language model involved. Phase 3 hands the pack to Claude, which
may write prose but may not write digits -- it references `{{fact_id}}` tokens
that the renderer substitutes from here, fail-closed on an unknown id.

That split is the whole safety story. It makes a fabricated NUMBER structurally
impossible. It does nothing about a fabricated CLAIM ("he has never made the
playoffs"), which is why a human still reads the draft before it goes live and
why there must never be an auto-publish path.

STRUCTURE
  sources[]   what was read, as of when, how many rows -- rendered into the
              article's "How this was built" panel
  coverage    which seasons are complete, whether the current one is partial
  warnings[]  a NON-EMPTY warnings list is fine; a silently missing one is not
  entities    owners and franchises, attributed via src_franchises
  facts[]     THE ONLY PLACE A NUMBER MAY COME FROM. Pre-formatted (`fmt`) so
              the model never formats currency either.
  tables[]    generated markup later; the model picks which one goes where and
              writes the caption, never the rows
  charts[]    same contract as tables; inline SVG is generated at build time
  sections[]  the outline the model fills in, rather than one it invents

DETERMINISM
  Two runs over unchanged data must be byte-identical except generatedAtUtc.
  Everything is sorted; nothing depends on dict ordering or wall-clock.
"""

import json
import re

SCHEMA = 1
FACT_ID_RE = re.compile(r'^f\.[a-z0-9]+(?:[._-][a-z0-9]+)*$', re.I)
UNITS = ("usd", "usd_k", "points", "count", "percent", "rank", "text", "date", "ratio")


class PackError(ValueError):
    pass


def fmt_usd(v):
    return "$%s" % format(int(round(v)), ",d")


def fmt_count(v):
    return format(int(v), ",d")


def fmt_percent(v, places=1):
    return "%.*f%%" % (places, v)


class Pack(object):
    def __init__(self, pack_id, season, week=None, title=None):
        self.pack_id = pack_id
        self.season = int(season)
        self.week = week
        self.title = title or pack_id
        self._sources = []
        self._warnings = []
        self._facts = {}
        self._tables = {}
        self._charts = {}
        self._quotes = {}
        self._playcards = {}
        self._games = {}
        self._sections = []
        self._owners = {}
        self._franchises = []
        self._divisions = []
        self.coverage = {}

    # ---------------------------------------------------------- provenance

    def source(self, name, asof, rows=None, note=None):
        self._sources.append({"name": name, "asof": asof, "rows": rows, "note": note})

    def warn(self, message):
        if message not in self._warnings:
            self._warnings.append(message)

    # ------------------------------------------------------------ entities

    def owner(self, key, display):
        self._owners[key] = {"key": key, "display": display}

    def division(self, name):
        """A division's real name, e.g. "DOG POUND 4 LIFE".

        Registered as an entity because the digit audit has to know it is a
        NAME. One of this league's four divisions contains a numeral, and
        writing it correctly was rejected as a fabricated quantity until the
        audit could tell a proper noun from a measurement.
        """
        if name and name not in self._divisions:
            self._divisions.append(name)
        return name

    def franchise(self, season, franchise_id, owner_key, name):
        self._franchises.append({
            "season": int(season),
            "franchiseId": str(franchise_id).zfill(4),
            "ownerKey": owner_key,
            "name": name,
            "attributionSource": "src_franchises",
        })

    # --------------------------------------------------------------- facts

    def fact(self, fact_id, label, value, unit, source, asof, fmt=None):
        """Register a number. Anything a report says numerically comes from here."""
        if not FACT_ID_RE.match(fact_id):
            raise PackError("bad fact id %r (want f.dotted.lower_snake)" % fact_id)
        if fact_id in self._facts:
            raise PackError("duplicate fact id %r" % fact_id)
        if unit not in UNITS:
            raise PackError("fact %s has unknown unit %r" % (fact_id, unit))
        if fmt is None:
            fmt = (fmt_usd(value) if unit == "usd" else
                   fmt_usd(value * 1000) if unit == "usd_k" else
                   ("%.1f" % float(value)) if unit == "points" else
                   fmt_percent(value) if unit == "percent" else
                   fmt_count(value) if unit in ("count", "rank") else
                   str(value))
        self._facts[fact_id] = {
            "id": fact_id, "label": label, "value": value, "unit": unit,
            "fmt": fmt, "source": source, "asof": asof,
        }
        return fact_id

    # ------------------------------------------------------- tables/charts

    def table(self, table_id, title, columns, rows, note=None):
        if table_id in self._tables:
            raise PackError("duplicate table id %r" % table_id)
        for c in columns:
            if "key" not in c or "label" not in c:
                raise PackError("table %s column needs key+label" % table_id)
        self._tables[table_id] = {"id": table_id, "title": title,
                                  "columns": columns, "rows": rows, "note": note}
        return table_id

    def quote(self, quote_id, text, author, when, owner_key=None, context=None,
              source="discord", permalink=None):
        """Real league chat, carried verbatim.

        Quotes are TEXT, so the {{fact_id}} contract that makes fabricated
        NUMBERS impossible does not cover them -- and a misquote attributed to a
        real person is a worse failure than a wrong number. So quotes follow the
        same rule as tables and charts: the model PLACES them by id and the
        renderer prints the stored text. The model never types a quotation, and
        wire_render refuses any quote id it was not given.
        """
        if quote_id in self._quotes:
            raise PackError("duplicate quote id %r" % quote_id)
        if not str(text).strip():
            raise PackError("quote %s is empty" % quote_id)
        self._quotes[quote_id] = {
            "id": quote_id, "text": text, "author": author, "when": when,
            "ownerKey": owner_key, "context": context, "source": source,
            "permalink": permalink,
        }
        return quote_id

    def playcard(self, card_id, player, position, nfl_matchup, score, box_line=None,
                 owner=None, note=None, watch_url=None, video=None):
        """A visual callout for a big performance. Placed by id, like a table.

        This is the "call out the big plays" surface. It states what the box
        score says, and carries footage when -- and only when -- a specific clip
        cleared every conviction test in wire_video: official channel, surname
        in the title, a highlight, published inside the game's own window. A
        wrong clip asserts a falsehood more convincingly than a wrong sentence
        does, so a near miss is recorded as no match and the card falls back to
        a search link.

        The card's DEFAULT rendering has no network dependency at all, so the
        article still works pasted into a Claude Artifact. Where a real player
        can run, the runtime upgrades it in place.
        """
        if card_id in self._playcards:
            raise PackError("duplicate playcard id %r" % card_id)
        self._playcards[card_id] = {
            "id": card_id, "player": player, "position": position,
            "nflMatchup": nfl_matchup, "score": score, "boxLine": box_line,
            "owner": owner, "note": note, "watchUrl": watch_url,
            # {"videoId", "title", "channel"} or None -- a VERIFIED clip, never
            # a guess. See wire_video.find_highlight for what verified means.
            "video": video or None,
        }
        return card_id

    def game(self, game_id, winner, loser, winner_score, loser_score, margin,
             winner_best=None, loser_best=None, loser_bench_miss=None,
             loser_ceiling=None, divisional=False, note=None,
             tale=None, billing=None, headline=None, tag=None,
             card_id=None, quote_ids=(), fact_ids=()):
        """One game, as a full page in the flip-through deck.

        Everything a reader needs about one matchup lives HERE, not scattered
        across the section: the tale of the tape, the big performance from THIS
        game, and the league chat about THESE two owners. The first version hung
        cards and quotes off the section instead, so a game page about Martel and
        Dunn rendered a card for a player neither of them owned -- correct data
        in a place it meant nothing.

        `note` is the model's own blurb for this game, written per matchup, and
        it goes through the same substitution and digit audit as every other line
        of prose.

        The block itself is generated. The writer places the set and writes the
        blurb; it never authors a row.
        """
        if game_id in self._games:
            raise PackError("duplicate game id %r" % game_id)
        self._games[game_id] = {
            "id": game_id, "winner": winner, "loser": loser,
            "winnerScore": winner_score, "loserScore": loser_score, "margin": margin,
            "winnerBest": winner_best, "loserBest": loser_best,
            "loserBenchMiss": loser_bench_miss, "loserCeiling": loser_ceiling,
            "divisional": divisional, "note": note,
            # tale = [{label, a, b, better}] -- the head-to-head comparison rows.
            # billing = combined incoming all-play, used to order the deck so the
            # biggest matchup leads rather than the biggest blowout.
            "tale": tale or [], "billing": billing, "headline": headline,
            # tag names the competitive context: which division, or that the two
            # are from different ones. A reader cannot tell from the names alone.
            "tag": tag,
            "cardId": card_id, "quoteIds": sorted(quote_ids),
            # The fact ids that belong to THIS matchup, so the writer's blurb has
            # tokens for it without hunting the whole pack.
            "factIds": sorted(fact_ids),
        }
        return game_id

    def chart(self, chart_id, kind, title, series, axis=None, alt_text=None):
        if chart_id in self._charts:
            raise PackError("duplicate chart id %r" % chart_id)
        if kind not in ("hbar", "line", "dotstrip", "meter"):
            raise PackError("chart %s has unsupported kind %r" % (chart_id, kind))
        if not alt_text:
            raise PackError("chart %s needs altText; a chart without one is "
                            "unreadable to anyone not looking at it" % chart_id)
        self._charts[chart_id] = {"id": chart_id, "kind": kind, "title": title,
                                  "series": series, "axis": axis or {}, "altText": alt_text}
        return chart_id

    # ------------------------------------------------------------ sections

    def section(self, section_id, title, brief, fact_ids=(), table_ids=(),
                chart_ids=(), quote_ids=(), card_ids=(), game_ids=()):
        self._sections.append({
            "id": section_id, "title": title, "brief": brief,
            "factIds": sorted(fact_ids), "tableIds": sorted(table_ids),
            "chartIds": sorted(chart_ids), "quoteIds": sorted(quote_ids),
            "cardIds": sorted(card_ids), "gameIds": sorted(game_ids),
        })

    # ------------------------------------------------------------ assemble

    def to_dict(self, generated_at):
        return {
            "schema": SCHEMA,
            "packId": self.pack_id,
            "title": self.title,
            "generatedAtUtc": generated_at,
            "season": self.season,
            "week": self.week,
            "sources": sorted(self._sources, key=lambda s: s["name"]),
            "coverage": self.coverage,
            "warnings": self._warnings,
            "entities": {
                "owners": [self._owners[k] for k in sorted(self._owners)],
                "franchises": sorted(self._franchises,
                                     key=lambda f: (f["season"], f["franchiseId"])),
                "divisions": sorted(self._divisions),
            },
            "facts": [self._facts[k] for k in sorted(self._facts)],
            "tables": [self._tables[k] for k in sorted(self._tables)],
            "charts": [self._charts[k] for k in sorted(self._charts)],
            "quotes": [self._quotes[k] for k in sorted(self._quotes)],
            "playcards": [self._playcards[k] for k in sorted(self._playcards)],
            "games": [self._games[k] for k in sorted(self._games)],
            "sections": self._sections,
        }

    def to_json(self, generated_at):
        return json.dumps(self.to_dict(generated_at), indent=2,
                          ensure_ascii=False, sort_keys=False) + "\n"


# ------------------------------------------------------------- validation

def validate(pack):
    """Structural checks a builder cannot skip. Returns a list of problems."""
    problems = []
    if pack.get("schema") != SCHEMA:
        problems.append("schema is %r, expected %d" % (pack.get("schema"), SCHEMA))
    for key in ("packId", "generatedAtUtc", "season", "sources", "coverage",
                "warnings", "entities", "facts", "tables", "charts", "sections"):
        if key not in pack:
            problems.append("missing top-level key %r" % key)
    if problems:
        return problems

    if not pack["sources"]:
        problems.append("sources[] is empty -- a pack with no provenance is not publishable")

    fact_ids = set()
    for f in pack["facts"]:
        if f["id"] in fact_ids:
            problems.append("duplicate fact id %s" % f["id"])
        fact_ids.add(f["id"])
        for k in ("label", "value", "unit", "fmt", "source", "asof"):
            if f.get(k) in (None, ""):
                problems.append("fact %s is missing %s" % (f["id"], k))

    table_ids = set(t["id"] for t in pack["tables"])
    chart_ids = set(c["id"] for c in pack["charts"])
    quote_ids = set(q["id"] for q in pack.get("quotes", []))
    card_ids = set(c["id"] for c in pack.get("playcards", []))
    game_ids = set(g["id"] for g in pack.get("games", []))

    for t in pack["tables"]:
        width = len(t["columns"])
        for i, row in enumerate(t["rows"]):
            if len(row) != width:
                problems.append("table %s row %d has %d cells, expected %d"
                                % (t["id"], i, len(row), width))
                break

    # Owner attribution: every franchise must point at a declared owner. This
    # is the check that stops a report crediting the wrong person.
    owner_keys = set(o["key"] for o in pack["entities"]["owners"])
    for fr in pack["entities"]["franchises"]:
        if fr["ownerKey"] not in owner_keys:
            problems.append("franchise %s/%s references undeclared owner %s"
                            % (fr["season"], fr["franchiseId"], fr["ownerKey"]))
        if fr.get("attributionSource") != "src_franchises":
            problems.append("franchise %s/%s was not attributed via src_franchises"
                            % (fr["season"], fr["franchiseId"]))

    if not pack["sections"]:
        problems.append("sections[] is empty -- the model would have to invent the outline")
    seen = set()
    for s in pack["sections"]:
        if s["id"] in seen:
            problems.append("duplicate section id %s" % s["id"])
        seen.add(s["id"])
        if not s.get("brief"):
            problems.append("section %s has no brief" % s["id"])
        for fid in s["factIds"]:
            if fid not in fact_ids:
                problems.append("section %s references unknown fact %s" % (s["id"], fid))
        for tid in s["tableIds"]:
            if tid not in table_ids:
                problems.append("section %s references unknown table %s" % (s["id"], tid))
        for cid in s["chartIds"]:
            if cid not in chart_ids:
                problems.append("section %s references unknown chart %s" % (s["id"], cid))
        for qid in s.get("quoteIds", []):
            if qid not in quote_ids:
                problems.append("section %s references unknown quote %s" % (s["id"], qid))
        for cid in s.get("cardIds", []):
            if cid not in card_ids:
                problems.append("section %s references unknown playcard %s" % (s["id"], cid))
        for gid in s.get("gameIds", []):
            if gid not in game_ids:
                problems.append("section %s references unknown game %s" % (s["id"], gid))

    # A game page owns its own card, quotes and facts -- that is the whole point
    # of the rebuild -- so the same referential check has to apply there.
    for g in pack.get("games", []):
        if g.get("cardId") and g["cardId"] not in card_ids:
            problems.append("game %s references unknown playcard %s" % (g["id"], g["cardId"]))
        for qid in g.get("quoteIds", []):
            if qid not in quote_ids:
                problems.append("game %s references unknown quote %s" % (g["id"], qid))
        for fid in g.get("factIds", []):
            if fid not in fact_ids:
                problems.append("game %s references unknown fact %s" % (g["id"], fid))

    reached = set(f for s in pack["sections"] for f in s["factIds"])
    reached |= set(f for g in pack.get("games", []) for f in g.get("factIds", []))
    orphans = fact_ids - reached
    if orphans:
        # Not fatal: a fact can exist for the model to reach for. Surfaced so a
        # builder that forgot to wire a section is visible.
        problems.append("NOTE %d fact(s) not referenced by any section: %s"
                        % (len(orphans), ", ".join(sorted(orphans)[:6])))
    return problems
