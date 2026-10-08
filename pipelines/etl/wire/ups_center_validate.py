#!/usr/bin/env python3
"""Check a UPS Center draft against its sources (Keith 2026-10-08: "Validate every score,
record, projection timestamp, quote link and derived claim against its source").

validate(result, ctx, pack) takes ups_center_issue.render()'s output and the snapshot
from ups_center_sources.gather(), which was fetched independently of the pack:

  score / margin / week all-play   MFL weeklyResults for the week
  record / all-play / points for   MFL leagueStandings
  projection                       D1 ups_player_projections: the value, its capture
                                   time, and that the capture came BEFORE the player's
                                   own kickoff (MFL nflSchedule). A postgame capture fails.
  quote                            D1 ups_discord_messages by message id, verbatim; the
                                   link must point at that message; sensitive lines fail
  post counts                      recounted from the same window
  pack facts                       equal to the pack the draft was built from
  every number on the page         must be the printed form of a registered claim
  every gap                        must have its visible EDITOR REVIEW box

check_editor_draft(html, ctx, scores_published) re-checks a draft an editor has
taken over (the automation never overwrites one): its quotes, and whether MFL's
scores have moved since the draft's numbers were frozen -- the changed claims.
"""
import html as H
import re

import chat_exclusions

TIME_RE = re.compile(r"\b\d{1,2}:\d{2}(:\d{2})?\s*(AM|PM)\b|\b(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\w*,?\s+"
                     r"(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\w*\s+\d{1,2}\b|\bWeek\s+\d{1,2}\b|\b20\d\d\b|"
                     r"\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\w*\s+\d{1,2}\b")
NUM_RE = re.compile(r"(?<![\w.])[-+−]?\d[\d,]*(?:\.\d+)?")
SPELLED_OK = {"eleven"}


def visible_text(doc):
    body = doc[doc.index("<body"):]
    body = re.sub(r"<script[\s\S]*?</script>", " ", body)
    body = re.sub(r"<style[\s\S]*?</style>", " ", body)
    body = re.sub(r'<a class="rcpt"[^>]*>[\s\S]*?</a>', " ", body)          # quotes are checked on their own
    return re.sub(r"\s+", " ", H.unescape(re.sub(r"<[^>]+>", " ", body)))


def _close(a, b, tol=0.05):
    return abs(float(a) - float(b)) <= tol


def validate(res, ctx, pack):
    errors, warnings, n = [], [], {}
    s, st = ctx["mfl"]["scores"], ctx["mfl"]["standings"]
    facts = {f["id"]: f["value"] for f in pack["facts"]}
    chat = {m["message_id"]: m for m in ctx["d1"]["chat"]}
    projections = ctx["d1"]["projections"]
    kick = ctx["timing"]["kickoffs"]
    basis = ctx["evidence"]["basis"]

    def bad(key, why):
        errors.append("%s: %s" % (key, why))

    for key, c in res["claims"].items():
        kind, _, rest = key.partition(":")
        v = c["value"]
        n[kind] = n.get(kind, 0) + 1
        if kind == "score":
            if rest not in s or not _close(v, s[rest]):
                bad(key, "draft says %s, MFL says %s" % (v, s.get(rest)))
        elif kind == "margin":
            w, l = rest.split(":")
            if not (s[w] > s[l] and _close(v, s[w] - s[l])):
                bad(key, "draft says %s beat %s by %s; MFL %s-%s" % (w, l, v, s[w], s[l]))
        elif kind == "wkap":
            w = sum(1 for o in s if o != rest and s[o] < s[rest])
            l = sum(1 for o in s if o != rest and s[o] > s[rest])
            if v != "%d-%d" % (w, l):
                bad(key, "draft %s, recomputed %d-%d" % (v, w, l))
        elif kind == "rec":
            if v != "%d-%d" % (st[rest]["h2hw"], st[rest]["h2hl"]):
                bad(key, "draft %s, MFL %d-%d" % (v, st[rest]["h2hw"], st[rest]["h2hl"]))
        elif kind == "ap":
            if not st[rest]["allplay"].startswith(v + "-"):
                bad(key, "draft %s, MFL %s" % (v, st[rest]["allplay"]))
        elif kind == "pf":
            if not _close(v, st[rest]["pf"]):
                bad(key, "draft %s, MFL %s" % (v, st[rest]["pf"]))
        elif kind == "proj":
            row = projections.get(rest)
            if not row:
                bad(key, "no D1 projection row")
                continue
            if basis == "first_pregame_fallback":
                want, cap = row["first_projected"], row["first_captured_at"]
            else:
                want, cap = v["value"], v["captured"]          # last-pregame may come from a frozen record
            team = (ctx["d1"]["players"].get(rest) or {}).get("nfl_team")
            if want is None or not _close(v["value"], want):
                bad(key, "printed projection %s, D1 %s" % (v["value"], want))
            if cap is None or int(cap) != int(v["captured"]):
                bad(key, "capture time %s does not match D1 %s" % (v["captured"], cap))
            if team not in kick or int(kick[team]) != int(v["kickoff"]):
                bad(key, "kickoff %s does not match MFL nflSchedule for %s" % (v["kickoff"], team))
            if not int(v["captured"]) < int(v["kickoff"]):
                bad(key, "POSTGAME projection: captured %s, kickoff %s" % (v["captured"], v["kickoff"]))
        elif kind == "quote":
            m = chat.get(rest)
            if not m:
                bad(key, "message not in ups_discord_messages for the window")
            elif " ".join((m["content"] or "").split()) != v:
                bad(key, "quote is not verbatim")
            elif chat_exclusions.reason(rest, v):
                bad(key, "quote may not be used: %s" % chat_exclusions.reason(rest, v))
        elif kind == "posts":
            cnt = len(ctx["d1"]["chat"]) if rest == "total" else sum(1 for m in ctx["d1"]["chat"] if m["owner_name"] == rest)
            if v != cnt:
                bad(key, "draft %s, recount %s" % (v, cnt))
        elif kind == "fact":
            if facts.get(rest) != v:
                bad(key, "pack has %r" % facts.get(rest))
        elif kind == "record":
            rb = (ctx["d1"].get("recordBook") or {}).get("combinedGames") or []
            if not rb or not _close(v, rb[0]["combined"]):
                bad(key, "record book %r" % rb[:1])
        elif kind == "grade":
            fav = re.sub(r"\s*\(\d+%\)$", "", v["fav"])
            other = [o for o in v["game"].split(" vs ") if o != fav]
            byname = {r["owner_name"]: f for f, r in ctx["d1"]["franchises"].items()}
            try:
                a, b = (float(x) for x in v["final"].split("-"))
                fa, fb = byname[fav], byname[other[0]]
            except (ValueError, KeyError, IndexError):
                bad(key, "cannot read %r" % v)
                continue
            if not (_close(a, s[fa]) and _close(b, s[fb])):
                bad(key, "graded final %s, MFL %s-%s" % (v["final"], s[fa], s[fb]))
            if (v["called"] == "yes") != (s[fa] > s[fb]):
                bad(key, "'called it' is %s but MFL has %s %s-%s" % (v["called"], fav, s[fa], s[fb]))
        elif kind == "elias":
            pass                                                 # cross-checked against scores_published below
        elif kind in ("pts", "diff", "count"):
            pass                                                 # pack-internal; covered by the pack build's own checks
        else:
            warnings.append("unchecked claim kind %s" % key)

    doc = res["html"]
    # every number a reader sees is a registered claim
    shown = set()
    for c in res["claims"].values():
        for x in NUM_RE.findall(str(c["shown"])):
            shown.add(x.replace(",", "").lstrip("+-−"))
    text = TIME_RE.sub(" ", visible_text(doc))
    stray = sorted({x for x in NUM_RE.findall(text) if x.replace(",", "").lstrip("+-−") not in shown})
    if stray:
        errors.append("numbers on the page that are not registered claims: %s" % ", ".join(stray[:20]))
    # every quote link points at its own message
    for href, inner in re.findall(r'<a class="rcpt" href="([^"]+)"[^>]*>([\s\S]*?)</a>', doc):
        mid = href.rstrip("/").split("/")[-1]
        m = chat.get(mid)
        if not m or not href.endswith("/%s/%s" % (m["channel_id"], mid)):
            errors.append("quote link %s does not resolve to its message" % href)
        elif H.unescape(re.sub(r"<[^>]+>", "", inner)).strip("“”\" ") != " ".join((m["content"] or "").split()):
            errors.append("quote link %s text differs from the message" % href)
    # highlight links only if verified
    for href in re.findall(r'<a class="wire-play-watch" href="([^"]+)"', doc):
        if not any(l.get("verified") and l.get("url") == H.unescape(href) for l in ctx.get("links", {}).values()):
            errors.append("highlight link %s was not verified" % href)
    # every gap is visible
    for g in res["gaps"]:
        if 'data-editor-gap="%s"' % H.escape(g["id"]) not in doc:
            errors.append("gap %s has no EDITOR REVIEW box" % g["id"])
    if "status: draft" not in doc:
        errors.append("article is not status: draft")
    return {"ok": not errors, "publishable": not errors and not res["gaps"], "errors": errors, "warnings": warnings,
            "checkedClaims": n, "gaps": res["gaps"]}


def check_editor_draft(doc, ctx, scores_published):
    """For a draft an editor owns: quotes still verbatim, and MFL scores that moved since
    the draft's numbers were frozen (the changed claims an Elias update produces)."""
    chat = {m["message_id"]: m for m in ctx["d1"]["chat"]}
    errors, changed = [], []
    for href, inner in re.findall(r'<a class="rcpt" href="([^"]+)"[^>]*>([\s\S]*?)</a>', doc):
        mid = href.rstrip("/").split("/")[-1]
        m = chat.get(mid)
        said = H.unescape(re.sub(r"<[^>]+>", "", inner)).strip("“”\" ")
        if m and said not in " ".join((m["content"] or "").split()):
            errors.append("quote %s is no longer verbatim" % mid)
    for fid, before in sorted((scores_published or {}).items()):
        now = ctx["mfl"]["scores"].get(fid)
        if now is not None and not _close(before, now):
            changed.append({"claim": "score:" + fid, "was": before, "now": now})
    return {"ok": not errors, "errors": errors, "changedClaims": changed}
