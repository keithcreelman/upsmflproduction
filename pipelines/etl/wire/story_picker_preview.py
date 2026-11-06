#!/usr/bin/env python3
"""Static preview site for the Big Story picker (Keith 2026-11-06: "show me how each was selected" and "can I see the prior weeks' reports").

  python3 pipelines/etl/wire/story_picker_preview.py --out <dir>

Writes index.html (every week's pick), picker.html (EVERY trigger evaluated each week, with raw value, p and n, surprise score, phase
gating, weight, repeat-ledger penalty, merge group, rank and a one-line reason) and wkNN.html + wkNN_new.html + wkNN_ran.html (the generated
story draft built from that week's inputs, beside what actually ran). Offline: reads the repo's committed data files, the local archive and the
job's cached snapshots (~/Library/Caches/upsmfl-ups-center-auto, weeks 5-8) or the committed test fixture (week 4). Weeks without a recorded
snapshot are RECONSTRUCTED from the Week 8 snapshot's season history and say so on their page. No D1, no network, no chat text (only message
ids already picked by an editor), noindex.
"""
import argparse
import copy
import html
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
sys.path.insert(0, HERE)
import ups_center_issue as I  # noqa: E402
import ups_center_sources as S  # noqa: E402
import ups_center_story_triggers as T  # noqa: E402
import ups_center_validate as V  # noqa: E402

CACHE = os.path.expanduser("~/Library/Caches/upsmfl-ups-center-auto")
DATA = os.path.join(REPO, "site/wire/data")
e = html.escape
SEASON = 2026


def jl(path):
    return json.load(open(path)) if os.path.exists(path) else None


def slice_history(h, k):
    return dict(h, week=k, seasonScores=[r for r in h["seasonScores"] if int(r["week"]) <= k],
                seasonGames=[g for g in h["seasonGames"] if int(g["week"]) <= k],
                pastScores=[r for r in h["pastScores"] if int(r["week"]) <= k])


def context_for(k, base8):
    """(ctx, note, recorded) for week k."""
    note, recorded = "", True
    cached = jl(os.path.join(CACHE, "%d-wk%02d-ups-center.sources.json" % (SEASON, k)))
    if k == 4:
        fx = os.path.join(REPO, "tests/fixtures/ups_center_auto/2026_wk04")
        ctx = jl(os.path.join(fx, "context.json"))
        ctx["history"] = jl(os.path.join(fx, "history.json"))
        note = "Inputs: the recorded Week 4 snapshot (committed test fixture, 2026-10-08)."
    elif cached:
        ctx = cached
        if "history" not in ctx or not ctx.get("history"):
            ctx["history"] = slice_history(base8["history"], k)
            ctx["history"]["pastResults"] = []
            note = ("Inputs: the recorded Week %d snapshot, but it has no season history, so the history was sliced from the Week 8 snapshot's seasons "
                    "(the win-total half of the Survival Line is not reconstructable)." % k)
            recorded = False
        else:
            note = "Inputs: the recorded Week %d snapshot cached by the job when it ran (%s)." % (k, ctx.get("gatheredAtUtc"))
    else:
        recorded = False
        ctx = copy.deepcopy(base8)
        ctx["week"] = k
        sc = {}
        for r in base8["history"]["seasonScores"]:
            if int(r["week"]) <= k:
                sc.setdefault(int(r["week"]), {})[r["franchise_id"]] = float(r["team_score"])
        games = [g for g in base8["history"]["seasonGames"] if int(g["week"]) == k]
        ctx["mfl"]["scores"] = dict(sc[k])
        seen, gl = set(), []
        for g in games:
            key = tuple(sorted((g["franchise_id"], g["opponent_franchise_id"])))
            if key in seen:
                continue
            seen.add(key)
            a, b = g["franchise_id"], g["opponent_franchise_id"]
            gl.append({"a": a, "b": b, "as": sc[k][a], "bs": sc[k][b], "ar": g["result"], "br": {"W": "L", "L": "W", "T": "T"}[g["result"]]})
        ctx["mfl"]["games"] = gl
        ap, rec = {f: [0, 0] for f in sc[k]}, {f: [0, 0] for f in sc[k]}
        for w, ws in sc.items():
            for f, x in ws.items():
                ap[f][0] += sum(1 for g, y in ws.items() if g != f and x > y)
                ap[f][1] += sum(1 for g, y in ws.items() if g != f and x < y)
        for g in base8["history"]["seasonGames"]:
            if int(g["week"]) <= k:
                rec[g["franchise_id"]][0 if g["result"] == "W" else 1] += g["result"] in ("W", "L")
        ctx["mfl"]["standings"] = {f: {"h2hw": rec[f][0], "h2hl": rec[f][1], "h2ht": 0, "allplay": "%d-%d-0" % tuple(ap[f]),
                                       "pf": round(sum(ws[f] for ws in sc.values()), 1)} for f in sc[k]}
        ctx["d1"]["teamScores"] = dict(sc[k])
        ctx["d1"]["standings"] = {f: {"franchise_id": f, "h2h_w": rec[f][0], "h2h_l": rec[f][1], "allplay_w": ap[f][0], "allplay_l": ap[f][1],
                                      "pf": round(sum(ws[f] for ws in sc.values()), 1)} for f in sc[k]}
        ctx["d1"]["projections"], ctx["d1"]["chat"], ctx["d1"]["recordBook"] = {}, [], {"combinedGames": []}
        ctx["d1"]["regGames"] = [g for g in base8["d1"]["regGames"]]            # division records are Week 8's: not used in a Week %d story
        ctx["evidence"] = {"basis": "none", "ranked": [], "unranked": []}
        ctx["links"] = {}
        ctx["timing"] = dict(ctx["timing"], finalAt=0)
        ctx["history"] = slice_history(base8["history"], k)
        ctx["history"]["pastResults"] = []
        ctx["site"]["standings"] = []
        note = ("Inputs RECONSTRUCTED: no snapshot of Week %d's sources was kept. Scores, games, records and All-Play come from the Week 8 snapshot's "
                "season history; the pregame projections, chat and highlight links for that week do not exist here, so the Plays segment has no graded "
                "bargains and busts and there are no Kenny candidates. The picker itself ran on real scores, the archive and the sim files that exist." % k)
    ctx["week"] = k
    ctx["archive"] = S.archive_history(SEASON, k)
    ctx["forecast"] = dict(ctx.get("forecast") or {}, **S.load_forecast(SEASON, k, DATA))
    if not ctx["forecast"].get("sim"):
        note += " No forecast file exists for Week %d (sim files exist for weeks 1, 2, 5, 6, 7, 8), so the Playoff Picture shows its blocker box and the odds triggers cannot run." % k
    ctx["eliasReport"] = jl(os.path.join(DATA, "elias_%d_wk%02d.json" % (SEASON, k)))
    ctx["scoresPublished"] = jl(os.path.join(DATA, "scores_published_%d_wk%02d.json" % (SEASON, k)))
    ctx["kennyPicks"] = jl(os.path.join(DATA, "kenny_picks_%d_wk%02d.json" % (SEASON, k)))
    return ctx, note, recorded


def pack_for(k):
    p = os.path.join(REPO, "site/wire/packs/%d/%d-wk%02d-recap.pack.json" % (SEASON, SEASON, k))
    return jl(p) if k != 4 else jl(os.path.join(REPO, "tests/fixtures/ups_center_auto/2026_wk04/pack.json"))


STYLE = """<style>:root{--bg:#f6f1e7;--fg:#241c15;--mut:#6b5d4d;--card:#fffdf8;--line:#d9ccb8;--acc:#5b3a8c;--ok:#1e7a46;--no:#9a3412}
@media(prefers-color-scheme:dark){:root{--bg:#1b1713;--fg:#f1e9dc;--mut:#b8a994;--card:#26211b;--line:#40382e;--acc:#c1a4f0;--ok:#6fd49b;--no:#f0a070}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.45 system-ui,sans-serif;padding:16px}h1{font-size:1.35rem;margin:.2rem 0 .6rem}h2{font-size:1.1rem;margin:1.4rem 0 .4rem;color:var(--acc)}
a{color:var(--acc)}.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:.7rem .8rem;margin:.6rem 0}.mut{color:var(--mut);font-size:.9rem}
.scroll{overflow-x:auto}table{border-collapse:collapse;font-size:.82rem;min-width:640px}th,td{border-bottom:1px solid var(--line);padding:.3rem .45rem;text-align:left;vertical-align:top}th{color:var(--mut);font-weight:600}
.y{color:var(--ok);font-weight:700}.n{color:var(--no)}.pill{display:inline-block;border:1px solid var(--line);border-radius:99px;padding:.05rem .5rem;font-size:.8rem}
.tabs{display:flex;gap:.5rem;margin:.6rem 0}.tabs button{flex:1;padding:.55rem;border:1px solid var(--line);background:var(--card);color:var(--fg);border-radius:8px;font:inherit}.tabs button.on{background:var(--acc);color:#fff}
iframe{width:100%;height:78vh;border:1px solid var(--line);border-radius:8px;background:#fff}.pair{display:block}.pair .col{display:none}.pair .col.on{display:block}
@media(min-width:1000px){.tabs{display:none}.pair{display:grid;grid-template-columns:1fr 1fr;gap:12px}.pair .col{display:block}}</style>"""
HEAD = '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>@@T@@</title>' + STYLE + "</head><body>"


def fmt_p(r):
    return "%.1f%% of %s" % (100 * r["p"], "{:,}".format(r["n"])) if r.get("p") is not None and r.get("n") else (("%.2g" % r["p"]) if r.get("p") is not None else "no archive pool")


def picker_table(tr):
    out = ['<div class="scroll"><table><tr><th>Trigger</th><th>Team</th><th>Raw value</th><th>p (share at least this extreme)</th><th>s</th><th>Phase gate</th><th>Weight</th><th>Ledger</th><th>Adj. s</th><th>Fired</th><th>Rank</th></tr>']
    for r in tr["rows"]:
        out.append("<tr><td>%s<br><span class='mut'>%s</span></td><td>%s</td><td>%s</td><td>%s</td><td>%s</td><td>%s</td><td>&times;%s</td><td>&times;%s</td><td>%s</td><td class='%s'>%s</td><td>%s</td></tr>" % (
            e(r["trigger"]), r["kind"], e(r.get("owner") or "&mdash;"), e(r["raw"] or ""), e(fmt_p(r)) if r["s"] is not None else "&mdash;",
            ("%.3f" % r["s"]) if r["s"] is not None else "&mdash;", e(r["gate"] or "open"), r["weight"], r["ledger"],
            ("%.3f" % r["adj"]) if r["adj"] is not None else "&mdash;", "y" if r["fired"] else "n", "yes" if r["fired"] else "no", r.get("rank") or ""))
    return "".join(out) + "</table></div>"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--weeks", default="1-8")
    a = ap.parse_args()
    lo, hi = (int(x) for x in a.weeks.split("-"))
    os.makedirs(a.out, exist_ok=True)
    open(os.path.join(a.out, "_headers"), "w").write("/*\n  X-Robots-Tag: noindex, nofollow\n")
    base8 = jl(os.path.join(REPO, "tests/fixtures/ups_center_auto/2026_wk08/context.json"))
    prior, summary, picker = [], [], []
    for k in range(lo, hi + 1):
        ctx, note, recorded = context_for(k, base8)
        pack = pack_for(k)
        tr = T.trace(ctx, prior)
        pk = T.pick(ctx, prior)
        lead = pk["lead"]
        name = lambda f: ctx["d1"]["franchises"][f]["owner_name"]
        pick_txt = ("%s: %s (s %.3f)" % (name(lead["fid"]), lead["headline"]["trigger"], lead["headline"]["adj"])) if lead else "fallback: %s-phase first look" % pk["fallback"]
        prior = [{"week": k, "fid": lead["fid"], "trigger": lead["headline"]["trigger"], "s": lead["headline"]["s"]}] if lead else []
        # the generated draft
        built, status = None, ""
        try:
            res = I.render(copy.deepcopy(pack), copy.deepcopy(ctx), generated_at=1793886000, local_candidates=False, fmt="story")
            built = res["html"]
            if res.get("formatFallback"):
                status = "Story build fell back to legacy: %s" % res["formatFallback"]
            elif recorded:
                rep = V.validate(res, ctx, pack)
                status = "Validated against the recorded sources: %s%s" % ("0 errors" if rep["ok"] else "%d error(s): %s" % (len(rep["errors"]), "; ".join(rep["errors"][:2])),
                                                                          "; %d editor box(es) left" % len(res["gaps"]) if res["gaps"] else "")
            else:
                status = "Not validated (reconstructed inputs)."
        except Exception as exc:                                              # a week the inputs cannot support
            status = "COULD NOT BE BUILT: %s: %s" % (type(exc).__name__, str(exc)[:200])
        if built:
            open(os.path.join(a.out, "wk%02d_new.html" % k), "w").write(built.replace("<head>", '<head>\n<meta name="robots" content="noindex,nofollow">', 1))
        ran_src = os.path.join(REPO, "site/wire/articles/%d/%d-wk%02d-ups-center.html" % (SEASON, SEASON, k))
        ran = open(ran_src).read() if os.path.exists(ran_src) else None
        if ran:
            open(os.path.join(a.out, "wk%02d_ran.html" % k), "w").write(ran.replace("<head>", '<head>\n<meta name="robots" content="noindex,nofollow">', 1))
        kind_ran = {7: "Week 7's hand rewrite (published)", 8: "Week 8's hand-built story edition (published)"}.get(k, "the article that ran (automated draft, edited, published)")
        summary.append((k, pick_txt, tr["phase"], bool(built)))
        picker.append("<h2 id='w%d'>Week %d &middot; %s phase</h2><div class='card'><b>Pick:</b> %s<br><span class='mut'>Winner:</span> %s<br><span class='mut'>Runner-up:</span> %s<br><span class='mut'>%s</span></div>%s" % (
            k, k, tr["phase"], e(pick_txt), e(tr["why_winner"] or ""), e(tr["why_runner_up"] or "&mdash;"), e(note), picker_table(tr)))
        page = [HEAD.replace('@@T@@', "Week %d: old vs new" % k), "<p><a href='index.html'>&larr; all weeks</a> &middot; <a href='picker.html#w%d'>how it was picked</a></p><h1>Week %d: old vs new</h1>" % (k, k),
                "<div class='card'><b>Pick:</b> %s<br><span class='mut'>%s</span><br><span class='mut'>%s</span></div>" % (e(pick_txt), e(note), e(status))]
        page.append("<div class='tabs'><button class='on' onclick=\"t(0)\">New (generated)</button><button onclick=\"t(1)\">What ran</button></div><div class='pair'>")
        page.append("<div class='col on'><h2>New: story format, built from this week's inputs</h2>%s</div>" % (
            "<iframe src='wk%02d_new.html' title='new'></iframe>" % k if built else "<div class='card'>%s</div>" % e(status)))
        page.append("<div class='col'><h2>What ran: %s</h2>%s</div></div>" % (kind_ran, "<iframe src='wk%02d_ran.html' title='ran'></iframe>" % k if ran else "<div class='card'>No article in site/wire/articles.</div>"))
        page.append("<script>function t(i){document.querySelectorAll('.tabs button').forEach(function(b,j){b.classList.toggle('on',i==j)});document.querySelectorAll('.pair .col').forEach(function(c,j){c.classList.toggle('on',i==j)})}</script></body></html>")
        open(os.path.join(a.out, "wk%02d.html" % k), "w").write("".join(page))
        print(k, pick_txt, "|", status[:120])
    idx = [HEAD.replace("@@T@@", "Big Story picker preview"), "<h1>UPS Center story format: how each Big Story was picked</h1>",
           "<p class='mut'>PR #1438 preview, noindex. Weeks 1-8 of 2026. Each week shows the generated story draft beside what actually ran, and a full table of every trigger the picker evaluated. Weeks without a recorded snapshot are reconstructed and say so.</p>",
           "<p><a href='picker.html'><b>The picker: every trigger, every week</b></a></p><div class='card'><table style='min-width:0'><tr><th>Wk</th><th>Phase</th><th>Pick</th><th>Compare</th></tr>"]
    for k, txt, ph, ok in summary:
        idx.append("<tr><td>%d</td><td>%s</td><td>%s</td><td><a href='wk%02d.html'>old vs new</a>%s</td></tr>" % (k, ph, e(txt), k, "" if ok else " (new draft could not be built)"))
    idx.append("</table></div></body></html>")
    open(os.path.join(a.out, "index.html"), "w").write("".join(idx))
    open(os.path.join(a.out, "picker.html"), "w").write(HEAD.replace("@@T@@", "Big Story picker: every trigger") + "<p><a href='index.html'>&larr; all weeks</a></p><h1>Every trigger, every week</h1><p class='mut'>s = 1 &minus; (1 &minus; p)^12; fires at adjusted s &le; 0.15. Gate = phase / minimum-week rule. Weight: from Week 11 stakes &times;0.5, rarity &times;1.5. Ledger: &times;3 if the same team and trigger led last week (unless 30% better). Merge: fired triggers about one team are one story. The odds, division and bubble triggers have no archived odds to calibrate on.</p>" + "".join(picker) + "</body></html>")


if __name__ == "__main__":
    main()
