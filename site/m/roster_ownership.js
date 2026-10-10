/* Live UPS ownership — ONE rule for every mobile surface that says who owns a
   player: the Stats list's "TEAM · owner" tag and its Rostered / Free agents
   filter (views/stats.js), and the player sheet's owner chip and the actions it
   offers (player_sheet.js). Pure: no fetch, no DOM.

   Input is the boot-loaded LIVE MFL rosters export (M.state.rosters) plus the
   league's franchise list (M.state.franchises) — never the leaderboard's
   mfl_franchise_id, which is a stale D1 join (#1203).

   THE RULE (each part is a decision):
   - On a roster → that franchise's. Positive evidence, shown even when other
     rosters are missing.
   - On NO roster → a free agent ONLY when the rosters are CONFIRMED COMPLETE:
     every franchise in the league list is present with at least one player.
     An empty, partial or unreadable export can't tell a free agent from a
     player on a roster it left out, so he is "owner unknown".
   - No player id → "owner unknown". Looking up "" used to read as a free agent
     whenever the rosters were complete (3 leaderboard rows on 2026-10-09).
   - "Owner unknown" is never offered an add or a bid (the sheet used to treat
     any player it couldn't find on a roster as a free agent, so a failed or
     partial rosters read put Bid / Add now on rostered players).

   ownerOf → { known: false, reason }                       owner unknown
           | { known: true, fid: null }                     confirmed free agent
           | { known: true, fid: "0011", name: "Cleon Ca$h" } rostered
   reason: "rosters_unreadable" | "rosters_incomplete" | "no_player_id" */
(function () {
  "use strict";

  function asArray(v) {
    if (Array.isArray(v)) return v;
    if (v == null || v === "") return [];
    return [v];
  }
  // Same normalization as app.js pad4 / the worker's padFranchiseId.
  function pad4(v) {
    var d = String(v || "").replace(/\D/g, "");
    return d ? d.padStart(4, "0").slice(-4) : "";
  }
  // MFL player ids are digits; "015698" and 15698 are the same player.
  function pidKey(id) {
    var d = String(id == null ? "" : id).replace(/\D/g, "");
    if (!d) return "";
    var n = parseInt(d, 10);
    return isFinite(n) ? String(n) : d;
  }

  // Rebuilt only when the rosters object or the franchise list is REPLACED
  // (the reload after a trade, claim or drop), so an owner change shows
  // without an app restart and a search keystroke doesn't re-walk 485 players.
  var cache = { src: undefined, fr: undefined, idx: null };
  function index(rostersPayload, leagueFranchises) {
    var rs = rostersPayload && rostersPayload.rosters;
    var fr = leagueFranchises || [];
    if (cache.src === rs && cache.fr === fr) return cache.idx;
    var idx = null;
    if (rs) {
      var map = {}, onRoster = {};
      asArray(rs.franchise).forEach(function (f) {
        var fid = pad4(f && f.id);
        if (!fid) return;
        asArray(f.player).forEach(function (p) {
          var k = pidKey(p && p.id);
          if (k) { map[k] = fid; onRoster[fid] = (onRoster[fid] || 0) + 1; }
        });
      });
      var complete = fr.length > 0 && fr.every(function (f) { return onRoster[pad4(f && f.id)] > 0; });
      idx = { map: map, complete: complete };
    }
    cache = { src: rs, fr: fr, idx: idx };
    return idx;
  }

  function ownerOf(rostersPayload, leagueFranchises, pid) {
    var idx = index(rostersPayload, leagueFranchises);
    if (!idx) return { known: false, reason: "rosters_unreadable" };
    var k = pidKey(pid);
    if (!k) return { known: false, reason: "no_player_id" };
    var fid = idx.map[k] || null;
    if (!fid) return idx.complete ? { known: true, fid: null } : { known: false, reason: "rosters_incomplete" };
    var f = (leagueFranchises || []).find(function (x) { return pad4(x && x.id) === fid; });
    return { known: true, fid: fid, name: (f && f.name) || "Rostered" };
  }

  // The sheet's one-line explanation for "owner unknown". Plain words; the fix
  // is a reload, because the rosters come from the boot read.
  function unknownReason(own) {
    if (!own || own.known) return "";
    if (own.reason === "no_player_id") return "This player has no MFL id here, so his UPS owner can’t be looked up.";
    if (own.reason === "rosters_incomplete") return "MFL’s rosters didn’t fully load, so we can’t tell whether he’s available.";
    return "MFL’s rosters couldn’t be read, so we can’t tell whether he’s available.";
  }

  window.UPS_MOBILE_OWNERSHIP = {
    index: index,
    ownerOf: ownerOf,
    pidKey: pidKey,
    unknownReason: unknownReason
  };
})();
