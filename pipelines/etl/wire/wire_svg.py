#!/usr/bin/env python3
"""Inline SVG charts, generated at build time.

WHY INLINE SVG AND NOT A CHART LIBRARY
  An article has to render in three places from one file, and one of them is a
  Claude Artifact with no network access. That rules out any CDN script. It also
  has to survive a strict sandbox with no same-origin, print correctly, and cost
  nothing at runtime. Inline SVG does all of it, and because it is inline it can
  reference CSS custom properties -- an <img src="chart.svg"> cannot see
  var(--gold), so it could never be theme-aware.

RULES
  * viewBox + width:100%, never fixed pixel widths -- a fixed width would fight
    the height beacon and the frame would never settle.
  * Colours come from var(--...) so light and dark both work.
  * role="img" plus a <title>, and every chart carries an altText from the pack.
  * ASCII only.
  * No vh units, obviously (see site/wire/README.md rule 2).

Phase 3 ships `hbar`, which is what the Pre-Season Review pack actually uses.
line / dotstrip / meter arrive with the weekly recaps in Phase 4.
"""

BAR_H = 22
BAR_GAP = 8
PAD_TOP = 8
PAD_BOTTOM = 22
LABEL_W = 132
VALUE_W = 92


def esc(s):
    return (str(s).replace("&", "&amp;").replace("<", "&lt;")
            .replace(">", "&gt;").replace('"', "&quot;"))


def _fmt(value, unit):
    if unit == "usd":
        return "$%s" % format(int(round(value)), ",d")
    if unit == "percent":
        return "%.1f%%" % value
    return format(int(value), ",d")


def hbar(chart, width=680):
    """Horizontal bars. `chart` is a pack chart dict."""
    series = chart.get("series") or []
    if not series:
        return ""
    unit = (chart.get("axis") or {}).get("unit", "count")
    top = (chart.get("axis") or {}).get("max") or max(s["value"] for s in series) or 1
    plot_w = width - LABEL_W - VALUE_W
    height = PAD_TOP + len(series) * (BAR_H + BAR_GAP) - BAR_GAP + PAD_BOTTOM

    out = [
        '<svg viewBox="0 0 %d %d" width="100%%" height="auto" role="img" '
        'aria-label="%s" preserveAspectRatio="xMinYMin meet" '
        'xmlns="http://www.w3.org/2000/svg">' % (width, height, esc(chart["altText"])),
        "<title>%s</title>" % esc(chart.get("title") or "chart"),
    ]

    for i, s in enumerate(series):
        y = PAD_TOP + i * (BAR_H + BAR_GAP)
        w = max(1, int(round(plot_w * (float(s["value"]) / float(top))))) if top else 1
        fill = "var(--gold)" if s.get("accent") == "gold" else "var(--cool)"
        out.append(
            '<text x="%d" y="%d" text-anchor="end" font-size="12" '
            'font-family="ui-sans-serif, system-ui, sans-serif" fill="var(--ink-dim)">%s</text>'
            % (LABEL_W - 10, y + BAR_H - 7, esc(s["label"])))
        out.append('<rect x="%d" y="%d" width="%d" height="%d" fill="var(--surface-2)" '
                   'stroke="var(--line)"/>' % (LABEL_W, y, plot_w, BAR_H))
        out.append('<rect x="%d" y="%d" width="%d" height="%d" fill="%s"/>'
                   % (LABEL_W, y, w, BAR_H, fill))
        out.append(
            '<text x="%d" y="%d" font-size="12" font-family="ui-monospace, Menlo, monospace" '
            'fill="var(--ink)">%s</text>'
            % (LABEL_W + plot_w + 10, y + BAR_H - 7, esc(_fmt(s["value"], unit))))

    out.append('<line x1="%d" y1="%d" x2="%d" y2="%d" stroke="var(--line)"/>'
               % (LABEL_W, height - PAD_BOTTOM + 4, LABEL_W + plot_w, height - PAD_BOTTOM + 4))
    out.append("</svg>")
    return "\n".join(out)


RENDERERS = {"hbar": hbar}


def render_chart(chart, caption=None):
    """A full <figure>: the SVG, a caption, and a numbers fallback.

    The <details> table is not decoration. A chart with more than a handful of
    points is unreadable to anyone using a screen reader, printing it, or
    checking a number -- the data has to be available as text too."""
    fn = RENDERERS.get(chart["kind"])
    if not fn:
        return ('<figure class="wire-fig"><figcaption>Chart type %s is not '
                'available yet.</figcaption></figure>' % esc(chart["kind"]))

    unit = (chart.get("axis") or {}).get("unit", "count")
    rows = "".join(
        "<tr><td>%s</td><td class=\"wire-num\">%s</td></tr>"
        % (esc(s["label"]), esc(_fmt(s["value"], unit)))
        for s in chart.get("series") or [])

    parts = ['<figure class="wire-fig">', fn(chart)]
    if caption:
        parts.append("<figcaption>%s</figcaption>" % esc(caption))
    if len(chart.get("series") or []) > 6:
        parts.append('<details><summary>Numbers</summary>'
                     '<div class="wire-tablewrap"><table><tbody>%s</tbody></table></div>'
                     '</details>' % rows)
    parts.append("</figure>")
    return "\n".join(parts)
