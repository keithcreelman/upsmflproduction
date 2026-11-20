/* UPS Commissioner Desk: pure card renderer.
 *
 * No DOM, no network, no globals read. renderCardHtml(card, opts) returns an HTML string.
 * Every dynamic string goes through esc(); the only markup that is not escaped text is
 * markup this file builds itself. Runs in the browser (window.UPSDeskRender) and in node.
 *
 * Contract: docs/ai_desk/DESK_CONTRACT.md "The card", docs/ai_desk/DESK_UX_SPEC.md.
 *   card = { state, lead_md, blocks[], facts_used[], cites[], gaps[], conflicts[], ruling_question,
 *            follow_ups[], facts{id -> {value, unit, display, grade, source, as_of, tool, call_id}},
 *            header{ai_generated, as_of, canon_sha, phase}, footer{tools[], cost_usd}, request_id }
 * Optional fields this renderer also reads (all escaped text): caveat, injection_note, question,
 *   header.league_record_version, fact.label, fact.inputs, fact.code_sha, fact.raw_url (https only),
 *   block.expand_question, footer.sources.
 */
(function (global) {
  "use strict";

  // ── Vocabulary ────────────────────────────────────────────────────────────────────────────
  var GRADE_INFO = {
    A: { text: "A", name: "MFL record" },
    B: { text: "B", name: "League document" },
    C: { text: "C", name: "Derived by code" },
    D: { text: "D", name: "Inferred" },
    NO_RECORD: { text: "NO RECORD", name: "Looked, found nothing" }
  };
  var GRADE_ORDER = ["A", "B", "C", "D", "NO_RECORD"];

  // tone: ok | grey | amber | blue | red | info. `copy` is the one-line banner text (short on purpose).
  var STATE_META = {
    answer: { label: "Answer", tone: "ok", copy: "" },
    answer_with_caveat: { label: "Answer, with a caveat", tone: "grey", copy: "" },
    answer_with_gap: { label: "Partly answered", tone: "amber", copy: "Some of this is not on record. The gaps are listed below." },
    partial: { label: "Partly answered", tone: "amber", copy: "Only part of this is covered. The gaps are listed below." },
    answer_with_conflict: { label: "Sources disagree", tone: "amber", copy: "Two sources give different answers. Both are shown. The desk does not pick one." },
    cite_and_abstain: { label: "Rules found, can't settle it", tone: "info", copy: "The rule text is cited below. The facts or the era can't be settled." },
    needs_ruling: { label: "Needs your ruling", tone: "blue", copy: "Canon is silent or unclear here. A draft question is below for you to edit." },
    abstain: { label: "Not determinable", tone: "grey", copy: "The records needed are not on file. The missing source is named below." },
    refuse_privacy: { label: "Can't share this", tone: "grey", copy: "This data is not available to the desk." },
    refuse_fairness: { label: "Declined", tone: "grey", copy: "The desk will not answer this one." },
    ignore_injection: { label: "Answer, with a notice", tone: "info", copy: "" },
    tool_failure: { label: "Couldn't verify", tone: "red", copy: "A check failed. No numbers were substituted." },
    stale_data: { label: "Stale data", tone: "red", copy: "A source is older than its limit. Treat any value here as out of date." },
    budget_exceeded: { label: "Paused: AI budget reached for this period", tone: "amber", copy: "No model call was made for this question." },
    out_of_scope: { label: "Outside the desk's scope", tone: "grey", copy: "The desk answers league questions. It never posts, sends or changes anything." },
    not_ready: { label: "Desk not ready", tone: "grey", copy: "The desk is not ready yet. Try again shortly." }
  };
  var UNKNOWN_META = { label: "Can't show this answer", tone: "red", copy: "This card has a state the page does not know. Nothing here is shown as fact." };

  var WHY_LABEL = {
    NO_RECORD: "No record",
    unsupported_as_of: "Not available for that date",
    partial_coverage: "Partly covered",
    stale: "Out of date",
    unverified_calculation: "Calculation not verified",
    conflict_in_canon: "Canon disagrees with itself"
  };

  var PHASE_LABEL = { P1: "Phase 1 · draft", P2: "Phase 2", P3: "Phase 3", P4: "Phase 4" };

  var TOKEN_RE = /\{\{([^{}]*)\}\}/g;
  var FACT_TOKEN_RE = /^\s*f\.(c\d{1,3}\.[a-z][a-z0-9_]{0,63})\s*$/;
  var NUMERIC_UNITS = { usd: 1, count: 1, pct: 1, rank: 1, years: 1, week: 1 };

  // ── Small helpers ─────────────────────────────────────────────────────────────────────────
  function str(v) { return v == null ? "" : String(v); }
  function esc(v) {
    return str(v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  function own(o, k) { return !!o && typeof o === "object" && Object.prototype.hasOwnProperty.call(o, k); }
  function arr(v) { return Array.isArray(v) ? v : []; }
  function plain(o) { return o && typeof o === "object" && !Array.isArray(o) ? o : {}; }
  function gradeKey(g) { var k = str(g).toUpperCase().replace(/[\s-]+/g, "_"); return own(GRADE_INFO, k) ? k : ""; }

  // Same deterministic formatting as worker/src/desk/contract.js formatFact; used only when a fact has no server display.
  function ordinal(n) {
    var m = n % 100; if (m >= 11 && m <= 13) return "th";
    return ({ 1: "st", 2: "nd", 3: "rd" })[n % 10] || "th";
  }
  function formatFact(fact) {
    if (!fact || typeof fact !== "object") return "";
    var v = fact.value, n;
    switch (fact.unit) {
      case "usd":
        n = Number(v); if (!isFinite(n)) return str(v);
        var a = Math.abs(n), sign = n < 0 ? "-" : "";
        return a >= 1000 && a % 1000 === 0 ? sign + "$" + (a / 1000) + "K" : sign + "$" + a.toLocaleString("en-US");
      case "pct": return Number(v) + "%";
      case "rank": n = Number(v); return isFinite(n) ? n + ordinal(n) : str(v);
      case "years": return Number(v) === 1 ? "1 year" : str(v) + " years";
      case "week": return "Week " + str(v);
      default: return str(v);
    }
  }
  function factDisplay(fact) {
    if (fact && typeof fact.display === "string" && fact.display !== "") return fact.display;
    if (fact && gradeKey(fact.grade) === "NO_RECORD" && (fact.value == null || fact.value === "")) return "No record";
    return formatFact(fact);
  }
  function getFact(card, id) { return card && own(card.facts, id) && card.facts[id] && typeof card.facts[id] === "object" ? card.facts[id] : null; }

  // The "what I checked" lookup: call id -> tool id.
  function toolByCall(card) {
    var m = {};
    arr(plain(card.footer).tools).forEach(function (t) { if (t && t.call_id != null) m[str(t.call_id)] = str(t.id); });
    return m;
  }

  // ── Grade chip and fact chip ──────────────────────────────────────────────────────────────
  function gradeBadge(g) {
    var k = gradeKey(g); if (!k) return "";
    var i = GRADE_INFO[k];
    return '<span class="ud-gr ud-g-' + k + '" title="' + esc("Grade " + i.text + ": " + i.name) + '"><span class="ud-sr">Evidence grade </span>' + esc(i.text) + "</span>";
  }

  function factChip(id, fact) {
    var k = gradeKey(fact.grade), i = k ? GRADE_INFO[k] : null;
    var disp = factDisplay(fact);
    var label = disp + (i ? ", evidence grade " + i.text + ", " + i.name : ", no evidence grade") + ". Show where it comes from.";
    return '<button type="button" class="ud-fact' + (k ? " ud-fg-" + k : "") + '" data-act="fact" data-fact="' + esc(id) + '" aria-haspopup="dialog" aria-label="' + esc(label) + '">' +
      '<span class="ud-fv">' + esc(disp) + "</span>" + (i ? '<span class="ud-gr ud-g-' + k + '" aria-hidden="true">' + esc(i.text) + "</span>" : "") + "</button>";
  }

  function missingMarker(shown) {
    return '<span class="ud-missing" role="note"><span class="ud-missing-t">Missing fact</span> <code>' + esc(shown) + "</code></span>";
  }

  function inlineText(s) {
    return esc(s).replace(/\*\*([^*\n]{1,200}?)\*\*/g, "<strong>$1</strong>");
  }

  // Fill {{f.cN.key}} tokens with fact chips. A token with no fact becomes a visible marker and is reported; never a guess.
  function fill(text, card, ctx) {
    var src = str(text), out = "", last = 0, m;
    TOKEN_RE.lastIndex = 0;
    while ((m = TOKEN_RE.exec(src)) !== null) {
      out += inlineText(src.slice(last, m.index));
      last = m.index + m[0].length;
      var t = FACT_TOKEN_RE.exec(m[1]);
      var fact = t ? getFact(card, t[1]) : null;
      if (fact) out += factChip(t[1], fact);
      else {
        var shown = t ? t[1] : m[1].trim().slice(0, 40);
        if (ctx) { ctx.missing.push(shown); if (typeof ctx.onMissing === "function") { try { ctx.onMissing(shown); } catch (e) { /* logging must never break rendering */ } } }
        out += missingMarker(shown);
      }
    }
    return out + inlineText(src.slice(last));
  }

  // Every fact id a piece of text points at (for tests and the controller).
  function tokenIds(text) {
    var ids = [], m; TOKEN_RE.lastIndex = 0;
    while ((m = TOKEN_RE.exec(str(text))) !== null) { var t = FACT_TOKEN_RE.exec(m[1]); if (t) ids.push(t[1]); }
    return ids;
  }

  function paragraphs(text, card, ctx, cls) {
    var parts = str(text).split(/\n{2,}/).map(function (p) { return p.trim(); }).filter(Boolean);
    return parts.map(function (p) { return '<p class="' + cls + '">' + fill(p, card, ctx).replace(/\n/g, "<br>") + "</p>"; }).join("");
  }

  // ── Blocks ────────────────────────────────────────────────────────────────────────────────
  function blockSource(block, card) {
    var calls = arr(block.tool_call_ids).map(str).filter(Boolean);
    if (!calls.length) return "";
    var map = toolByCall(card);
    var bits = calls.map(function (c) { return (map[c] ? "<code>" + esc(map[c]) + "</code> " : "") + "(call " + esc(c) + ")"; });
    return '<p class="ud-block-src">Checked by ' + bits.join(", ") + "</p>";
  }

  function cellHtml(cell, card, ctx) {
    if (cell == null || cell === "") return "—";
    return fill(cell, card, ctx);
  }
  function isNumericCell(cell, card) {
    var m = /^\s*\{\{([^{}]*)\}\}\s*$/.exec(str(cell)); if (!m) return false;
    var t = FACT_TOKEN_RE.exec(m[1]); var f = t ? getFact(card, t[1]) : null;
    return !!(f && own(NUMERIC_UNITS, f.unit));
  }

  function tableHtml(columns, rows, card, ctx, cls, caption) {
    var cols = arr(columns), body = arr(rows);
    var head = cols.length ? "<thead><tr>" + cols.map(function (c) { return '<th scope="col">' + fill(c, card, ctx) + "</th>"; }).join("") + "</tr></thead>" : "";
    var trs = body.map(function (r) {
      var cells = arr(r);
      return "<tr>" + cells.map(function (c, i) {
        var num = i > 0 && isNumericCell(c, card) ? ' class="ud-num"' : "";
        return i === 0 ? '<th scope="row">' + cellHtml(c, card, ctx) + "</th>" : "<td" + num + ">" + cellHtml(c, card, ctx) + "</td>";
      }).join("") + "</tr>";
    }).join("");
    return '<div class="ud-scroll" tabindex="0" role="region" aria-label="' + esc(caption || "Table") + '"><table class="ud-table ' + cls + '"><caption class="ud-sr">' + esc(caption || "Table") + "</caption>" + head + "<tbody>" + trs + "</tbody></table></div>";
  }

  function titleHtml(block, fallback) {
    var t = str(block.title) || fallback;
    return t ? '<h3 class="ud-block-t">' + esc(t) + "</h3>" : "";
  }

  function timelineHtml(block, card, ctx) {
    var rows = arr(block.rows).map(function (r) {
      r = plain(r);
      var kind = r.kind === "gap" ? " ud-tl-gap" : r.kind === "final" ? " ud-tl-final" : "";
      var move = r.from != null || r.to != null ? '<span class="ud-tl-move">' + fill(r.from, card, ctx) + ' <span class="ud-arrow"><span aria-hidden="true">→</span><span class="ud-sr"> to </span></span> ' + fill(r.to, card, ctx) + "</span>" : "";
      var what = r.what != null && r.what !== "" ? '<span class="ud-tl-what">' + fill(r.what, card, ctx) + "</span>" : "";
      var det = arr(r.detail).length
        ? '<details class="ud-det ud-tl-det"><summary>What was exchanged</summary><ul>' + arr(r.detail).map(function (d) { return "<li>" + fill(d, card, ctx) + "</li>"; }).join("") + "</ul></details>" : "";
      var gr = r.kind === "gap" ? '<span class="ud-gap-tag">Gap</span>' : gradeBadge(r.grade);
      return '<li class="ud-tl-row' + kind + '"><span class="ud-tl-date">' + fill(r.date, card, ctx) + '</span><div class="ud-tl-main">' + move + what + det + '</div><span class="ud-tl-g">' + gr + "</span></li>";
    }).join("");
    return '<ol class="ud-timeline">' + rows + "</ol>";
  }

  function chartHtml(block, card, ctx) {
    var cols = arr(block.columns), rows = arr(block.rows);
    var pts = rows.map(function (r) {
      var cells = arr(r), label = str(cells[0]), raw = cells[1], v = NaN;
      var m = /^\s*\{\{([^{}]*)\}\}\s*$/.exec(str(raw)), t = m ? FACT_TOKEN_RE.exec(m[1]) : null, f = t ? getFact(card, t[1]) : null;
      if (f) v = Number(f.value); else if (!m && raw != null && raw !== "") v = Number(raw);
      return { label: label, v: v, disp: f ? factDisplay(f) : str(raw) };
    });
    var table = tableHtml(cols, rows, card, ctx, "ud-chart-table", str(block.title) + " (values)");
    var good = pts.filter(function (p) { return isFinite(p.v); });
    if (pts.length < 4 || good.length < 2) return '<p class="ud-note">A chart appears only for a trend across four or more seasons. The table has the values.</p>' + table;
    var W = 320, H = 156, padL = 6, padR = 6, padT = 30, padB = 26;
    var max = Math.max.apply(null, good.map(function (p) { return p.v; }).concat([0]));
    var min = Math.min.apply(null, good.map(function (p) { return p.v; }).concat([0]));
    var span = max - min || 1;
    var pw = (W - padL - padR) / pts.length;
    var y = function (v) { return padT + (max - v) / span * (H - padT - padB); };
    var y0 = y(0), svg = "";
    var every = pts.length > 8 ? 2 : 1;
    pts.forEach(function (p, i) {
      var x = padL + i * pw;
      if (isFinite(p.v)) {
        var top = Math.min(y(p.v), y0), h = Math.max(Math.abs(y(p.v) - y0), 1);
        svg += '<rect class="ud-bar" x="' + (x + pw * 0.15).toFixed(1) + '" y="' + top.toFixed(1) + '" width="' + (pw * 0.7).toFixed(1) + '" height="' + h.toFixed(1) + '"></rect>';
      }
      if (i % every === 0) svg += '<text class="ud-axis" x="' + (x + pw / 2).toFixed(1) + '" y="' + (H - 9) + '" text-anchor="middle">' + esc(p.label) + "</text>";
    });
    arr(block.eras).forEach(function (e, ei) {
      e = plain(e);
      var idx = -1; pts.forEach(function (p, i) { if (idx < 0 && p.label === str(e.at)) idx = i; });
      if (idx < 0) return;
      var x = padL + idx * pw;
      svg += '<line class="ud-era" x1="' + x.toFixed(1) + '" x2="' + x.toFixed(1) + '" y1="' + (padT - 6 - (ei % 2) * 11) + '" y2="' + (H - padB) + '"></line>';
      svg += '<text class="ud-era-t" x="' + (x + 3).toFixed(1) + '" y="' + (padT - 10 - (ei % 2) * 11) + '">' + esc(e.label) + "</text>";
    });
    svg += '<line class="ud-base" x1="' + padL + '" x2="' + (W - padR) + '" y1="' + y0.toFixed(1) + '" y2="' + y0.toFixed(1) + '"></line>';
    var aria = str(block.title) + ": " + good.length + " seasons from " + str(pts[0].label) + " to " + str(pts[pts.length - 1].label) + ". The table below has every value.";
    return '<figure class="ud-chart"><svg viewBox="0 0 ' + W + " " + H + '" role="img" aria-label="' + esc(aria) + '" preserveAspectRatio="xMidYMid meet">' + svg + "</svg></figure>" + table;
  }

  function branchHtml(block, card, ctx) {
    return '<div class="ud-branches">' + arr(block.branches).map(function (b) {
      b = plain(b); var rule = plain(b.rule);
      return '<section class="ud-branch"><h4 class="ud-branch-t">' + esc(b.label) + "</h4>" +
        (b.reading ? '<p class="ud-branch-r">' + fill(b.reading, card, ctx) + "</p>" : "") +
        (rule.anchor ? '<p class="ud-branch-rule"><span class="ud-anchor">' + esc("§ " + rule.anchor) + "</span> " + esc(rule.claim) + "</p>" : "") +
        (b.needs ? '<p class="ud-branch-needs"><strong>It would need:</strong> ' + fill(b.needs, card, ctx) + "</p>" : "") + "</section>";
    }).join("") + "</div>";
  }

  function blockHtml(block, idx, card, ctx) {
    block = plain(block);
    var type = str(block.type), inner = "";
    if (type === "table") inner = titleHtml(block, "") + tableHtml(block.columns, block.rows, card, ctx, "", block.title || "Table");
    else if (type === "comparison") inner = titleHtml(block, "Comparison") + tableHtml(block.columns, block.rows, card, ctx, "ud-compare", block.title || "Comparison") +
      (block.owner_registry === true ? "" : '<p class="ud-note">Franchise, not owner: these columns follow the franchise id until the owner registry exists.</p>');
    else if (type === "timeline") inner = titleHtml(block, "Timeline") + timelineHtml(block, card, ctx);
    else if (type === "chart") inner = titleHtml(block, "Trend") + chartHtml(block, card, ctx);
    else if (type === "branch") inner = titleHtml(block, "Readings") + branchHtml(block, card, ctx);
    else inner = '<p class="ud-note">This block type is not shown: ' + esc(type || "none") + ".</p>";
    var expand = block.expand_question
      ? '<button type="button" class="ud-btn ud-btn-ghost" data-act="expand" data-busy-off="1" data-block="' + idx + '">' + esc(block.expand_label || "Expand the next level") + "</button>" : "";
    return '<section class="ud-block ud-b-' + esc(type.replace(/[^a-z_]/g, "")) + '" data-block="' + idx + '">' + inner + blockSource(block, card) + expand + "</section>";
  }

  // ── Boxes ─────────────────────────────────────────────────────────────────────────────────
  function gapsBox(gaps, card, ctx) {
    if (!arr(gaps).length) return "";
    return '<section class="ud-box ud-box-amber" aria-labelledby="ud-gaps-h"><h3 id="ud-gaps-h" class="ud-box-t">Gaps: what is missing</h3><ul class="ud-list">' +
      arr(gaps).map(function (g) {
        g = plain(g);
        return "<li><strong>" + fill(g.what, card, ctx) + '</strong> <span class="ud-why">' + esc(own(WHY_LABEL, g.why) ? WHY_LABEL[g.why] : str(g.why)) + "</span>" +
          (g.source_needed ? '<span class="ud-need">Would settle it: ' + esc(g.source_needed) + "</span>" : "") + "</li>";
      }).join("") + "</ul></section>";
  }

  function conflictsBox(conflicts, card, ctx) {
    if (!arr(conflicts).length) return "";
    return '<section class="ud-box ud-box-amber" aria-labelledby="ud-conf-h"><h3 id="ud-conf-h" class="ud-box-t">Sources disagree</h3>' +
      arr(conflicts).map(function (c) {
        c = plain(c);
        var side = function (key, tag) {
          var f = getFact(card, str(key).replace(/^f\./, ""));
          var id = str(key).replace(/^f\./, "");
          if (!f) { if (ctx) { ctx.missing.push(id); if (typeof ctx.onMissing === "function") { try { ctx.onMissing(id); } catch (e) { /* ignore */ } } } return '<div class="ud-side"><span class="ud-side-t">' + tag + "</span>" + missingMarker(id) + "</div>"; }
          return '<div class="ud-side"><span class="ud-side-t">' + tag + "</span>" + factChip(id, f) + '<span class="ud-side-s">' + esc(f.source) + (f.label ? " · " + esc(f.label) : "") + "</span></div>";
        };
        return '<div class="ud-conflict"><div class="ud-sides">' + side(c.fact_a, "Source A") + side(c.fact_b, "Source B") + "</div>" + (c.note ? '<p class="ud-conflict-n">' + fill(c.note, card, ctx) + "</p>" : "") + "</div>";
      }).join("") + "</section>";
  }

  function rulingBox(card) {
    var q = str(card.ruling_question).trim();
    if (!q) return "";
    return '<section class="ud-box ud-box-blue" aria-labelledby="ud-rule-h"><h3 id="ud-rule-h" class="ud-box-t">Draft ruling question</h3>' +
      '<p class="ud-note">The desk drafts this. It never sends it or decides it. Edit it, then use it your way.</p>' +
      '<label class="ud-sr" for="ud-ruling-text">Draft ruling question, editable</label>' +
      '<textarea id="ud-ruling-text" class="ud-input ud-ruling" rows="4" data-role="ruling">' + esc(q) + "</textarea>" +
      '<button type="button" class="ud-btn ud-btn-ghost" data-act="copy-ruling">Copy question</button></section>';
  }

  function citesHtml(cites) {
    if (!arr(cites).length) return "";
    return '<section class="ud-cites"><h3 class="ud-block-t">Rules cited</h3><ul class="ud-list">' + arr(cites).map(function (c) {
      c = plain(c);
      return '<li><span class="ud-anchor">' + esc("§ " + str(c.anchor)) + '</span> <span class="ud-canon">canon ' + esc(str(c.canon_sha).slice(0, 7)) + "</span><span class=\"ud-claim\">" + esc(c.claim) + "</span></li>";
    }).join("") + "</ul></section>";
  }

  function fmtMs(ms) {
    var n = Number(ms); if (!isFinite(n)) return "";
    return n >= 1000 ? (n / 1000).toFixed(1) + " s" : Math.round(n) + " ms";
  }
  function fmtCost(c) { var n = Number(c); return c == null || !isFinite(n) ? "not recorded" : "$" + n.toFixed(4); }

  function footerHtml(card) {
    var foot = plain(card.footer), tools = arr(foot.tools);
    var seen = {}, sources = [];
    var ids = arr(card.facts_used).length ? card.facts_used.map(function (x) { return str(x).replace(/^f\./, ""); }) : Object.keys(plain(card.facts));
    ids.forEach(function (id) { var f = getFact(card, id); if (f && f.source && !own(seen, f.source)) { seen[f.source] = 1; sources.push(str(f.source)); } });
    arr(foot.sources).forEach(function (s) { if (s && !own(seen, str(s))) { seen[str(s)] = 1; sources.push(str(s)); } });
    arr(card.cites).forEach(function (c) { var s = "Canon section " + str(plain(c).anchor); if (!own(seen, s)) { seen[s] = 1; sources.push(s); } });
    var src = '<details class="ud-det"><summary>Sources (' + sources.length + ")</summary>" + (sources.length ? '<ul class="ud-list">' + sources.map(function (s) { return "<li>" + esc(s) + "</li>"; }).join("") + "</ul>" : '<p class="ud-note">No sources: this card states no facts.</p>') + "</details>";
    var chk = '<details class="ud-det"><summary>What I checked (' + tools.length + " tool" + (tools.length === 1 ? "" : "s") + ")</summary>" + (tools.length ? '<ul class="ud-list">' + tools.map(function (t) {
      t = plain(t);
      return "<li><code>" + esc(t.id) + "</code>" + (t.call_id != null ? " call " + esc(t.call_id) : "") + (t.ms != null ? " · " + esc(fmtMs(t.ms)) : "") + (t.status ? " · " + esc(t.status) : "") + (t.code ? " (" + esc(t.code) + ")" : "") + "</li>";
    }).join("") + "</ul>" : '<p class="ud-note">No tools ran for this card.</p>') + "</details>";
    return '<footer class="ud-foot">' + src + chk + '<p class="ud-cost">Model cost: ' + esc(fmtCost(foot.cost_usd)) + '</p><button type="button" class="ud-btn ud-btn-ghost" data-act="report">Report a problem</button></footer>';
  }

  function headerHtml(card) {
    var h = plain(card.header);
    var asOf = str(h.as_of);
    var chips = ['<span class="ud-chip ud-chip-ai">AI-generated</span>',
      '<span class="ud-chip">' + (asOf ? (asOf === "current" ? "Current data" : "Data as of " + esc(asOf)) : "As of: not given") + "</span>",
      '<span class="ud-chip">Canon ' + (h.canon_sha ? esc(str(h.canon_sha).slice(0, 7)) : "not given") + "</span>"];
    if (h.league_record_version) chips.push('<span class="ud-chip">League Record ' + esc(h.league_record_version) + "</span>");
    chips.push('<span class="ud-chip ud-chip-phase">' + esc(own(PHASE_LABEL, h.phase) ? PHASE_LABEL[h.phase] : "Phase " + str(h.phase || "?")) + "</span>");
    return '<header class="ud-head">' + chips.join("") + "</header>";
  }

  // ── Card ──────────────────────────────────────────────────────────────────────────────────
  function syntheticCard(state, extra) {
    var meta = own(STATE_META, state) ? STATE_META[state] : UNKNOWN_META;
    var base = {
      state: state, lead_md: "", blocks: [], facts_used: [], cites: [], gaps: [], conflicts: [], ruling_question: "", follow_ups: [], facts: {},
      header: { ai_generated: true, as_of: "", canon_sha: "", phase: "P1" }, footer: { tools: [], cost_usd: 0 }, request_id: ""
    };
    if (state === "budget_exceeded") base.lead_md = "Paused: the AI budget for this period is used up. Ask again when the next period starts.";
    else if (state === "not_ready") base.lead_md = "The desk is not ready to answer yet. Try again in a minute.";
    else if (state === "tool_failure") base.lead_md = "The desk could not check the records just now. Try the question again.";
    base.synthetic = meta.label;
    var e = plain(extra); Object.keys(e).forEach(function (k) { base[k] = e[k]; });
    return base;
  }

  function renderCardHtml(card, opts) {
    opts = opts || {};
    var ctx = { onMissing: opts.onMissing, missing: [] };
    if (!card || typeof card !== "object" || Array.isArray(card)) card = syntheticCard("tool_failure", { lead_md: "The desk got an answer it could not read. Try the question again." });
    var known = own(STATE_META, card.state);
    var meta = known ? STATE_META[card.state] : UNKNOWN_META;
    var stateKey = known ? card.state : "unknown";
    var q = str(opts.question || card.question).trim();
    var live = known; // an unknown state withholds the body entirely
    var out = '<article class="ud-card ud-state-' + stateKey + '" data-state="' + stateKey + '" data-request="' + esc(card.request_id) + '" aria-label="' + esc("Answer card: " + meta.label) + '">';
    out += headerHtml(card);
    if (q) out += '<p class="ud-qline"><span class="ud-qlabel">Question</span> ' + esc(q) + "</p>";
    out += '<div class="ud-banner ud-tone-' + meta.tone + '" role="note"><strong class="ud-banner-t">' + esc(meta.label) + "</strong>" + (meta.copy ? ' <span class="ud-banner-c">' + esc(meta.copy) + "</span>" : "") + "</div>";
    if (live) {
      if (str(card.lead_md).trim()) out += '<div class="ud-lead">' + paragraphs(card.lead_md, card, ctx, "ud-lead-p") + "</div>";
      if (card.state === "answer_with_caveat") out += '<p class="ud-caveat"><strong>Caveat.</strong> ' + esc(card.caveat || "This answer has a known limitation. See the notes below.") + "</p>";
      if (card.state === "ignore_injection") out += '<p class="ud-notice"><strong>Notice.</strong> ' + esc(card.injection_note || "Ignored instructions found in source text. The answer uses only the authoritative sources.") + "</p>";
      out += arr(card.blocks).map(function (b, i) { return blockHtml(b, i, card, ctx); }).join("");
      out += conflictsBox(card.conflicts, card, ctx);
      out += gapsBox(card.gaps, card, ctx);
      out += rulingBox(card);
      out += citesHtml(card.cites);
    }
    if (card.state === "tool_failure" || card.state === "not_ready") out += '<div class="ud-actions"><button type="button" class="ud-btn ud-btn-primary" data-act="retry" data-busy-off="1">Try again</button></div>';
    if (live && arr(card.follow_ups).length) {
      out += '<nav class="ud-follow" aria-label="Follow-up questions"><h3 class="ud-block-t">Follow-ups</h3><div class="ud-chips">' +
        arr(card.follow_ups).map(function (f, i) { return '<button type="button" class="ud-btn ud-btn-chip" data-act="followup" data-busy-off="1" data-i="' + i + '">' + esc(f) + "</button>"; }).join("") + "</div></nav>";
    }
    out += footerHtml(card);
    out += '<div class="ud-report" data-role="report" hidden></div>';
    return out + "</article>";
  }

  // ── Provenance drawer body ────────────────────────────────────────────────────────────────
  function renderProvenanceHtml(card, factId) {
    var f = getFact(card, str(factId));
    if (!f) return '<h2 id="ud-drawer-t" class="ud-drawer-t">Where this comes from</h2><p class="ud-note">No record for this value in the card.</p>';
    var k = gradeKey(f.grade), i = k ? GRADE_INFO[k] : null, h = plain(card.header);
    var rows = [
      ["Value", factDisplay(f) + (f.value != null && str(f.value) !== factDisplay(f) ? " (raw: " + str(f.value) + ")" : "")],
      ["Unit", f.unit], ["As of", f.as_of], ["Source", f.source], ["Tool", f.tool], ["Call id", f.call_id]
    ];
    if (f.inputs != null) { var j; try { j = typeof f.inputs === "string" ? f.inputs : JSON.stringify(f.inputs); } catch (e) { j = ""; } rows.push(["Inputs", String(j).slice(0, 400)]); }
    var sha = f.code_sha || h.code_sha; if (sha) rows.push(["Code version", str(sha).slice(0, 12)]);
    var dl = rows.map(function (r) { return "<dt>" + esc(r[0]) + "</dt><dd>" + (str(r[1]) === "" ? '<span class="ud-muted">not given</span>' : esc(r[1])) + "</dd>"; }).join("");
    dl += "<dt>Evidence grade</dt><dd>" + (i ? '<span class="ud-gr ud-g-' + k + '">' + esc(i.text) + "</span> " + esc(i.name) : '<span class="ud-muted">not given</span>') + "</dd>";
    var raw = str(f.raw_url);
    if (/^https:\/{2}[^\s"'<>]+$/.test(raw)) dl += '<dt>Raw record</dt><dd><a href="' + esc(raw) + '" target="_blank" rel="noopener noreferrer">Open the record</a></dd>';
    var legend = GRADE_ORDER.map(function (g) { return '<li><span class="ud-gr ud-g-' + g + '">' + esc(GRADE_INFO[g].text) + "</span> " + esc(GRADE_INFO[g].name) + "</li>"; }).join("");
    return '<h2 id="ud-drawer-t" class="ud-drawer-t">Where this comes from</h2><p class="ud-prov-val">' + esc(factDisplay(f)) + "</p>" + (f.label ? '<p class="ud-prov-label">' + esc(f.label) + "</p>" : "") +
      '<dl class="ud-prov">' + dl + '</dl><details class="ud-det"><summary>What the grades mean</summary><ul class="ud-list ud-legend">' + legend + "</ul></details>";
  }

  // ── History and suggestions ───────────────────────────────────────────────────────────────
  function stateLabel(state) { return own(STATE_META, state) ? STATE_META[state].label : "Unknown state"; }
  function stateTone(state) { return own(STATE_META, state) ? STATE_META[state].tone : "red"; }
  function fmtWhen(s) {
    var m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})/.exec(str(s));
    return m ? m[1] + " " + m[2] + (/Z$/.test(str(s)) ? " UTC" : "") : str(s);
  }
  function renderHistoryHtml(items) {
    var list = arr(items).slice(0, 50);
    if (!list.length) return '<li class="ud-empty">No questions yet. Ask one above.</li>';
    return list.map(function (it) {
      it = plain(it);
      return '<li><button type="button" class="ud-hist" data-act="hist" data-busy-off="1" data-id="' + esc(it.id) + '"><span class="ud-hist-q">' + esc(it.question) + '</span><span class="ud-hist-m"><span class="ud-tag ud-tone-' + stateTone(it.state) + '">' + esc(stateLabel(it.state)) + "</span> " + esc(fmtWhen(it.created_at)) + "</span></button></li>";
    }).join("");
  }
  function normalizeSuggestions(list) {
    return arr(list).map(function (s) { return typeof s === "string" ? { q: s } : plain(s); }).filter(function (s) { return str(s.q).trim(); });
  }
  function renderSuggestionsHtml(list) {
    var items = normalizeSuggestions(list);
    var flagged = items.some(function (x) { return x.suggested; });
    var main = [], more = [];
    items.forEach(function (s, i) { ((flagged ? s.suggested : i < 6) ? main : more).push({ q: s.q, i: i }); });
    var btn = function (s) { return '<button type="button" class="ud-btn ud-btn-chip" data-act="suggest" data-busy-off="1" data-i="' + s.i + '">' + esc(s.q) + "</button>"; };
    return '<div class="ud-chips">' + main.map(btn).join("") + "</div>" + (more.length ? '<details class="ud-det ud-more"><summary>More examples (' + more.length + ')</summary><div class="ud-chips">' + more.map(btn).join("") + "</div></details>" : "");
  }

  global.UPSDeskRender = {
    esc: esc, formatFact: formatFact, factDisplay: factDisplay, tokenIds: tokenIds, fill: fill,
    renderCardHtml: renderCardHtml, renderProvenanceHtml: renderProvenanceHtml, renderHistoryHtml: renderHistoryHtml, renderSuggestionsHtml: renderSuggestionsHtml, normalizeSuggestions: normalizeSuggestions,
    syntheticCard: syntheticCard, stateLabel: stateLabel, stateTone: stateTone, STATE_META: STATE_META, GRADE_INFO: GRADE_INFO
  };
})(typeof globalThis !== "undefined" ? globalThis : typeof self !== "undefined" ? self : this);
