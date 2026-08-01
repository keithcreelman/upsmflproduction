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
UNITS = ("usd", "usd_k", "count", "percent", "rank", "text", "date", "ratio")


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
        self._sections = []
        self._owners = {}
        self._franchises = []
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

    def section(self, section_id, title, brief, fact_ids=(), table_ids=(), chart_ids=()):
        self._sections.append({
            "id": section_id, "title": title, "brief": brief,
            "factIds": sorted(fact_ids), "tableIds": sorted(table_ids),
            "chartIds": sorted(chart_ids),
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
            },
            "facts": [self._facts[k] for k in sorted(self._facts)],
            "tables": [self._tables[k] for k in sorted(self._tables)],
            "charts": [self._charts[k] for k in sorted(self._charts)],
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

    orphans = fact_ids - set(f for s in pack["sections"] for f in s["factIds"])
    if orphans:
        # Not fatal: a fact can exist for the model to reach for. Surfaced so a
        # builder that forgot to wire a section is visible.
        problems.append("NOTE %d fact(s) not referenced by any section: %s"
                        % (len(orphans), ", ".join(sorted(orphans)[:6])))
    return problems
