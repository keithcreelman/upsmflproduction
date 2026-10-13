#!/usr/bin/env python3
"""Builds REPORT.md (and report.html, a fragment for the review page) from the locked results only."""
import json, os, html
HERE = os.path.dirname(os.path.abspath(__file__)); L = os.path.join(HERE, "locked")
J = lambda f: json.load(open(os.path.join(L, f)))
sel, r24, r25, prod = J("selection.json"), J("results_2019_2024.json"), J("results_2025.json"), J("pts_agst_default_window.json")
GROUPS = ["QB", "RB", "WR", "TE", "DL", "LB", "DB", "PK", "PN"]
LBL = {"PK": "K", "PN": "P"}
WINDOWS = ["Season to date", "Last 1", "Last 2", "Last 3", "Last 4", "Last 5", "Last 6", "Last 8", "Previous season",
           "Blend c=0.2", "Blend c=0.5", "Blend c=1.0", "EW half-life 1", "EW half-life 2", "EW half-life 4", "EW half-life 8"]
BASE = ["No defensive adjustment", "League average"]
NAME = {"Season to date": "Full season (to date)", "No defensive adjustment": "Baseline: players' usual, no defense adj.", "League average": "Baseline: league average"}
def f(x, d=3, pct=False, sign=False):
    if x is None: return "—"
    if pct: return f"{100 * x:.1f}%"
    return (f"{x:+.{d}f}" if sign else f"{x:.{d}f}")
md, ht = [], []
def P(s=""): md.append(s)
P("# Stats → Pts Agst: which window predicts the next game? (walk-forward backtest, locked)")
P()
P(f"Selection on 2019–2024 only (selection.json sha256 `{prod['selection_sha256'][:16]}…`), then the locked 2025 holdout. "
  f"Product rule: a window replaces Full season only if it beats it by ≥ {int(prod['material_gain']*100)} points of rank accuracy in BOTH periods with both 95% intervals above 0.")
P()
P("**Rank accuracy** = share of team pairs (same week, same position) that the window put in the same order as the next game's actual Allowed ÷ Usual. A coin flip = 50%. "
  "**MAE / RMSE** = error of the next game's points against those players (adjusted family: players' usual × the window's Allowed ÷ Usual; no leakage). "
  "**Shrunk MAE** = the same with the ratio pulled toward the league ratio by k games (k chosen leaving out the scored season). "
  "**Q-lift** = next-game Allowed ÷ Usual of the top quarter of teams by the window minus the bottom quarter. **Dir.** = share right about above/below the players' usual.")
P()
P("## Decision by position")
P()
P("| Pos | Default | Statistical winner 2019–24 | Gain vs Full 2019–24 | Gain vs Full 2025 | Material? | Full-season rank acc 2019–24 → 2025 | Next-game signal? |")
P("|---|---|---|---|---|---|---|---|")
for g in GROUPS:
    p = prod["positions"][g]
    P(f"| {LBL.get(g, g)} | **Full season** | {p['winner_2019_2024']} | {f(p['gain_vs_full_2019_2024'], 4, sign=True)} | {f(p['gain_vs_full_2025'], 4, sign=True)} | {'yes' if p['material'] else 'no'} | "
      f"{f(p['rank_acc_2019_2024'], pct=True)} → {f(p['rank_acc_2025'], pct=True)} | {'yes, weak (~' + str(p['pct']) + ' in 100)' if p['signal'] else 'no'} |")
P()
for g in GROUPS + ["ALL"]:
    A, A25 = r24["positions"][g]["adj"], r25["positions"][g]["adj"]
    R, R25 = r24["positions"][g]["raw"], r25["positions"][g]["raw"]
    P(f"## {LBL.get(g, g) if g != 'ALL' else 'All positions combined'} (2019–2024: {A['Season to date']['n']} target games; 2025 holdout: {A25['Season to date']['n']})")
    P()
    P("| Method | Rank acc | MAE | RMSE | Pearson | Spearman | Q-lift | Dir. | Shrunk MAE (k) | Raw-pts MAE | 2025 rank acc | 2025 MAE | 2025 raw MAE |")
    P("|---|---|---|---|---|---|---|---|---|---|---|---|---|")
    for m in BASE + WINDOWS:
        a, r, a5, r5 = A[m], R[m], A25[m], R25[m]
        sh = a.get("shrunk_loso") or {}
        P(f"| {NAME.get(m, m)} | {f(a['rank_acc'], pct=True)} | {f(a['MAE'], 2)} | {f(a['RMSE'], 2)} | {f(a['pearson'])} | {f(a['spearman'])} | {f(a['q_lift'])} | {f(a['dir_acc'], pct=True)} | "
          f"{f(sh.get('MAE'), 2)} ({'∞' if (sh.get('k_all_train') or 0) > 1e8 else sh.get('k_all_train', '—')}) | {f(r['MAE'], 2)} | {f(a5['rank_acc'], pct=True)} | {f(a5['MAE'], 2)} | {f(r5['MAE'], 2)} |")
    P()
    P("By season (rank accuracy): " + " · ".join(
        f"{y}: Full {f(A['Season to date']['by_season'][str(y)]['rank_acc'], pct=True)}, Last 3 {f(A['Last 3']['by_season'][str(y)]['rank_acc'], pct=True)}, Last 8 {f(A['Last 8']['by_season'][str(y)]['rank_acc'], pct=True)}"
        for y in range(2019, 2025)) + f" · 2025: Full {f(A25['Season to date']['rank_acc'], pct=True)}")
    P()
    P("By point in the season (games already played → rank accuracy, 2019–2024): " + " · ".join(
        f"{b}: Full {f(A['Season to date']['by_bin'][b]['rank_acc'], pct=True)} / Last 3 {f(A['Last 3']['by_bin'][b]['rank_acc'], pct=True)} / Prev season {f(A['Previous season']['by_bin'][b]['rank_acc'], pct=True)} / Blend .5 {f(A['Blend c=0.5']['by_bin'][b]['rank_acc'], pct=True)} (n {A['Season to date']['by_bin'][b]['n']})"
        for b in ["1–2", "3–4", "5–7", "8–11", "12+"]))
    P()
open(os.path.join(HERE, "REPORT.md"), "w").write("\n".join(md) + "\n")
# minimal HTML (tables) for the review page
import re
def md_to_html(lines):
    out, table = [], False
    for ln in lines:
        if ln.startswith("|"):
            cells = [c.strip() for c in ln.strip("|").split("|")]
            if set("".join(cells)) <= set("-: "): continue
            if not table: out.append('<div class="tw"><table>'); table = True; tag = "th"
            else: tag = "td"
            out.append("<tr>" + "".join(f"<{tag}>{re.sub(r'[*][*](.+?)[*][*]', r'<b>\\1</b>', html.escape(c))}</{tag}>" for c in cells) + "</tr>")
            continue
        if table: out.append("</table></div>"); table = False
        if ln.startswith("## "): out.append(f"<h3>{html.escape(ln[3:])}</h3>")
        elif ln.startswith("# "): continue
        elif ln.strip(): out.append(f"<p class=\"mut\">{re.sub(r'[*][*](.+?)[*][*]', r'<b>\\1</b>', html.escape(ln))}</p>")
    if table: out.append("</table></div>")
    return "\n".join(out)
open(os.path.join(HERE, "report.html"), "w").write(md_to_html(md))
print("wrote REPORT.md and report.html")
