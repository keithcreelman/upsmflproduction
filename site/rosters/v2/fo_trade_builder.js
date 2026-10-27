/* Front Office → Trades → Trade builder (#1385 P3). The adapter between the Front Office's data and the shared
   builder (site/shared/trade_builder_view.js): who the teams are, what each can send (players and MFL's future
   picks), and how the server's verdict is asked for.

   READ-ONLY TODAY. The Send step is wired in the view but this adapter gives it NO send function, so a confirmed
   send says plainly that sending is not available and nothing leaves the page. No write route is named here.
   Making Send live is a separate decision (needs Keith's go, an authz and behavior review, and parity with every
   two- and three-team War Room rule; see the PR).

   Optional test/preview seam: window.UPS_FO_TRADE_BUILDER_CONFIG = { preview(body) -> json, sendNotice, warRoomUrl }.
   A build that blocks every POST (the preview) answers the verdict from recorded examples through it. */
(function (root) {
  "use strict";
  var FO, DATA, H;
  function cfg() { return root.UPS_FO_TRADE_BUILDER_CONFIG || {}; }
  function ord(n) { return n + (["th", "st", "nd", "rd"][(n % 100 > 10 && n % 100 < 14) ? 0 : Math.min(n % 10, 4) % 4] || "th"); }

  function teams() { return FO.teams().map(function (t) { return { fid: t.fid, name: t.name }; }); }
  function playersOf(fid) {
    var t = FO.teams().filter(function (x) { return x.fid === fid; })[0];
    return t ? (t.players || []).map(function (p) {
      return { id: p.id, name: p.name, pos: p.position, salary: p.salary, years: p.years, taxi: !!p.isTaxi };
    }) : [];
  }
  // MFL's future picks held by this team: FP_<original owner>_<year>_<round>, the token the server reads.
  function picksOf(fid) {
    var e = DATA.get("picks");
    if (!e || e.state !== "ok") return [];
    var out = [];
    H.asArray(e.data.futureDraftPicks && e.data.futureDraftPicks.franchise).forEach(function (row) {
      if (H.pad4(row.id) !== fid) return;
      H.asArray(row.futureDraftPick).forEach(function (p) {
        var y = String(p.year), r = parseInt(p.round, 10), orig = H.pad4(p.originalPickFor || fid);
        if (!y || !(r >= 1)) return;
        out.push({ year: y, round: r, token: "FP_" + orig + "_" + y + "_" + r, label: y + " " + ord(r) + (orig !== fid ? " (" + H.teamName(orig) + ")" : "") });
      });
    });
    return out.sort(function (a, b) { return a.year === b.year ? a.round - b.round : a.year < b.year ? -1 : 1; });
  }

  function preview(body) {
    var c = cfg();
    if (typeof c.preview === "function") return Promise.resolve(c.preview(body));
    var url = DATA.config().sessionQuery(DATA.config().apiBase + "/api/trades/compliance-preview?L=" + encodeURIComponent(DATA.config().leagueId) + "&YEAR=" + encodeURIComponent(DATA.config().season));
    // The server's read-only compliance preview. Any failure is "can't be checked", never a pass.
    return fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, credentials: "omit", body: JSON.stringify(body) })
      .then(function (r) { return r.json(); }, function () { return null; });
  }

  function mount(host) {
    var c = cfg();
    return root.UPS_TRADE_BUILDER_VIEW.mount(host, {
      teams: teams(),
      assets: function (fid) { return { players: playersOf(fid), picks: picksOf(fid) }; },
      ctx: { leagueId: DATA.config().leagueId, season: DATA.config().season, viewerFid: FO.viewerFid() },
      preview: preview,
      // No send(): see the header. The notice is what the owner reads on the Review step.
      sendNotice: c.sendNotice || "Sending from the Front Office is not turned on yet. Nothing here sends a trade; use the Trade War Room to send.",
      warRoomUrl: c.warRoomUrl || (FO.warRoomUrl ? FO.warRoomUrl({}) : "")
    });
  }

  root.UPS_FO_TRADE_BUILDER = { mount: mount, _picksOf: picksOf, _playersOf: playersOf };
  document.addEventListener("fo:ready", function () { FO = root.UPS_FO; DATA = root.UPS_FO_DATA; H = root.UPS_FO_HUB; });
})(typeof window !== "undefined" ? window : this);
