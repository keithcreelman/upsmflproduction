/*!
 * player_actions_native.js — real contract ACTIONS in the barebones player modal.
 *
 * The bridge (player_popup_bridge.js) opens player_profile_master.js on native
 * MFL pages in Lite Mode. That modal is a dumb renderer; this file is the
 * "brain" that supplies the Actions-tab HTML and owns the clicks — mirroring
 * how Roster Workbench drives the same modal.
 *
 * FULL PARITY with the mobile player sheet: Drop · Promote-from-Taxi ·
 * Activate-from-IR · Complete-untag cleanup · Add-to-Block · Extend (flat +
 * loaded FL/BL) · Restructure · MYAC (flat + loaded) · MYM · Tag / Untag.
 *
 * REUSE, DON'T RE-DERIVE. The contract math + payloads live in the VERBATIM
 * Front Office mobile mirrors, lazy-loaded on first owned-player click:
 *   front_office_penalty.js         → UPS_FRONT_OFFICE.dropPenaltyFor
 *   front_office_actions.js         → UPS_FRONT_OFFICE_ACTIONS (eligibility gates)
 *   front_office_extend_submit.js   → UPS_FRONT_OFFICE_EXT   (options + submitExtension)
 *   front_office_restructure_submit → UPS_FRONT_OFFICE_RSTR  (baseline/calc + submitRestructure)
 *   front_office_myac_submit.js     → UPS_M_FO_MYAC          (buildMyacContract + submitMyac)
 *   front_office_mym_submit.js      → UPS_M_FO_MYM           (buildMymContract + submitMym)
 *   front_office_tag_submit.js      → UPS_FRONT_OFFICE_TAG   (submitTag / submitUntag)
 * The brain never re-implements cap/penalty/contract math — the worker + the
 * mirrors own it. The Drop penalty shown is a DISPLAY-ONLY estimate.
 *
 * The FO eligibility mirror reads window.UPS_MOBILE.state + .data. On the
 * barebones page there is no mobile SPA, so we install a NAMESPACE-GUARDED shim
 * (only when window.UPS_MOBILE is absent) that feeds the mirror the same
 * inputs from a small set of fail-soft fetches (franchise list, acquisition
 * lookup, tag tracking + submissions, contract deadline, trade bait + notes).
 * A failed fetch degrades to FEWER buttons — never a broken submit.
 *
 * AUTH (verified against RWB appendViewerSessionQuery + mobile mirrors):
 *   Roster moves + Add-to-Block POST with ?MFL_USER_ID=<cookie> — MFL owner-
 *   restricted, the cookie is readable here because these scripts run on MFL's
 *   own origin. Contract writes (Extend/MYAC/MYM/Restructure/Tag/Untag) go to
 *   the commish-mediated worker routes (env.MFL_COOKIE) — no owner cookie.
 *
 * SAFETY: buttons only render for a player the viewer OWNS (the bridge gates
 * it: pad4(viewerFid)===pad4(ownerFid)). The worker re-validates every write
 * (windows / TCV / penalty / ERA retention); a wrongly-shown button fails at
 * the worker with a toast, never a silent bad write.
 */
(function (root) {
  "use strict";
  if (!root) return;

  var WORKER_BASE =
    (typeof root.UPS_MOBILE_API_BASE === "string" && root.UPS_MOBILE_API_BASE) ||
    "https://upsmflproduction.keith-creelman.workers.dev";
  var GH_BASE = "https://keithcreelman.github.io/upsmflproduction";
  // Version stamp for the lazy-loaded FO modules. Bump when the mirrors change.
  var MOD_V = "2026-07-16-barebones-actions";

  // ── small helpers ──────────────────────────────────────────────────────
  function safeStr(v) { return v == null ? "" : String(v).trim(); }
  function safeInt(v, f) { var n = parseInt(v, 10); return isFinite(n) ? n : (f == null ? 0 : f); }
  function pad4(v) {
    var d = safeStr(v).replace(/\D/g, "");
    return d ? ("0000" + d).slice(-4) : "";
  }
  function esc(v) {
    return safeStr(v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  function fmtUsd(n) { return "$" + (Math.round(Number(n) || 0)).toLocaleString("en-US"); }
  function readCookie(name) {
    var parts = (document.cookie || "").split(";");
    for (var i = 0; i < parts.length; i++) {
      var kv = parts[i].split("=");
      if (safeStr(kv[0]) === name) { try { return decodeURIComponent(safeStr(kv[1])); } catch (e) { return safeStr(kv[1]); } }
    }
    return "";
  }
  function normArr(j) {
    if (!j) return [];
    if (Array.isArray(j)) return j;
    if (Array.isArray(j.rows)) return j.rows;
    if (Array.isArray(j.submissions)) return j.submissions;
    return [];
  }

  // ── brain-owned toast (no mobile UI framework here) ─────────────────────
  function toast(msg, kind) {
    try {
      var el = document.createElement("div");
      el.textContent = msg;
      el.style.cssText =
        "position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:2147483001;" +
        "max-width:88vw;padding:12px 18px;border-radius:10px;font:600 13px/1.35 -apple-system," +
        "BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#fff;box-shadow:0 6px 20px rgba(0,0,0,.4);" +
        "background:" + (kind === "err" ? "#7f1d1d" : kind === "ok" ? "#14532d" : "#1e293b") + ";";
      document.body.appendChild(el);
      setTimeout(function () { try { el.remove(); } catch (e) {} }, kind === "err" ? 6000 : 3200);
    } catch (e) { try { if (kind === "err") root.alert(msg); } catch (e2) {} }
  }

  // ── fail-soft data cache (populated once on first owned-player click) ────
  var _data = {
    loaded: false, promise: null,
    franchises: [], acqMap: {}, tagTracking: [], tagSubmissions: [],
    contractDeadline: "", tradeBaitEntries: [], tradeBaitNotes: {}, tradeBaitLookingFor: ""
  };

  function fetchJson(url, opts) {
    return fetch(url, opts).then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; });
  }
  function parseFranchises(j) {
    var lg = j && j.league;
    var arr = lg && lg.franchises && lg.franchises.franchise;
    arr = Array.isArray(arr) ? arr : (arr ? [arr] : []);
    return arr.map(function (f) {
      return { id: pad4(f.id), name: safeStr(f.name), abbrev: safeStr(f.abbrev), owner: safeStr(f.owner_name) };
    });
  }
  function parseAcq(j) {
    var rows = j ? (Array.isArray(j) ? j : (Array.isArray(j.rows) ? j.rows : [])) : [];
    var map = {};
    rows.forEach(function (row) {
      if (!row) return;
      var fid = pad4(row.franchise_id || row.franchiseId);
      var pid = safeStr(row.player_id || row.playerId).replace(/\D/g, "");
      if (!fid || !pid) return;
      map[fid + ":" + pid] = {
        label: safeStr(row.acquisition_label || row.label),
        date: safeStr(row.acquisition_date || row.date_et).slice(0, 10)
      };
    });
    return map;
  }
  function parseDeadline(j) {
    var evs = (j && j.events) || [];
    for (var i = 0; i < evs.length; i++) {
      if (String(evs[i].event || "").toLowerCase().indexOf("contract_deadline") >= 0) {
        return evs[i].date ? String(evs[i].date).slice(0, 10) : "";
      }
    }
    return "";
  }
  function parseTradeBaitEntries(j) {
    if (!j) return [];
    var root2 = (j.tradeBaits && j.tradeBaits.tradeBait) ||
                (j.tradeBait && j.tradeBait.tradeBait) ||
                (j.tradeBait) || j;
    return Array.isArray(root2) ? root2 : (root2 ? [root2] : []);
  }
  function parseNotes(j) {
    if (!j || !j.notes) return {};
    var map = {};
    if (Array.isArray(j.notes)) {
      j.notes.forEach(function (row) { if (row && row.player_id != null) map[String(row.player_id)] = safeStr(row.note); });
    } else if (typeof j.notes === "object") {
      Object.keys(j.notes).forEach(function (k) { map[String(k)] = safeStr(j.notes[k]); });
    }
    return map;
  }
  function lookingForFor(fid) {
    var f4 = pad4(fid);
    for (var i = 0; i < _data.tradeBaitEntries.length; i++) {
      var e = _data.tradeBaitEntries[i];
      if (e && pad4(e.franchise_id || e.id || "") === f4) {
        return safeStr(e.inExchangeFor || e.in_exchange_for || e.lookingFor || "");
      }
    }
    return "";
  }
  function myTradeBaitIds(fid) {
    var ids = {}, f4 = pad4(fid);
    _data.tradeBaitEntries.forEach(function (e) {
      if (!e || pad4(e.franchise_id || e.id || "") !== f4) return;
      safeStr(e.willGiveUp || e.will_give_up || "").split(",").forEach(function (id) {
        var t = id.trim();
        if (t && t.indexOf("DP_") !== 0 && t.indexOf("FP_") !== 0 && t.indexOf("BB_") !== 0) ids[t] = true;
      });
    });
    return ids;
  }
  function findFranchise(fid) {
    var f4 = pad4(fid);
    for (var i = 0; i < _data.franchises.length; i++) if (_data.franchises[i].id === f4) return _data.franchises[i];
    return null;
  }
  function acqFor(fid, pid) {
    return _data.acqMap[pad4(fid) + ":" + safeStr(pid).replace(/\D/g, "")] || null;
  }

  function loadData(ctx) {
    if (_data.loaded) return Promise.resolve(_data);
    if (_data.promise) return _data.promise;
    var year = encodeURIComponent(ctx.year), lid = encodeURIComponent(ctx.leagueId);
    var fid = pad4(ctx.viewerFranchiseId);
    var same = { credentials: "include" };                          // MFL same-origin
    var cross = { mode: "cors", credentials: "omit", cache: "no-store" }; // gh.io + worker
    _data.promise = Promise.all([
      fetchJson("/" + year + "/export?TYPE=league&L=" + lid + "&JSON=1", same),
      fetchJson(GH_BASE + "/rosters/player_acquisition_lookup_" + year + ".json", cross),
      fetchJson(GH_BASE + "/ccc/tag_tracking.json", cross),
      fetchJson(GH_BASE + "/ccc/tag_submissions.json", cross),
      fetchJson(WORKER_BASE + "/api/league-events?season=" + year + "&from=all&limit=50", cross),
      fetchJson("/" + year + "/export?TYPE=tradeBait&L=" + lid + "&INCLUDE_DRAFT_PICKS=1&JSON=1", same),
      fid ? fetchJson(WORKER_BASE + "/api/trade-bait-notes?franchiseId=" + encodeURIComponent(fid), cross) : Promise.resolve(null)
    ]).then(function (res) {
      _data.franchises = parseFranchises(res[0]);
      _data.acqMap = parseAcq(res[1]);
      _data.tagTracking = normArr(res[2]);
      _data.tagSubmissions = normArr(res[3]);
      _data.contractDeadline = parseDeadline(res[4]);
      _data.tradeBaitEntries = parseTradeBaitEntries(res[5]);
      _data.tradeBaitNotes = parseNotes(res[6]);
      _data.tradeBaitLookingFor = lookingForFor(fid);
      _data.loaded = true;
      return _data;
    }).catch(function () { _data.loaded = true; return _data; });
    return _data.promise;
  }

  // ── namespace-guarded UPS_MOBILE shim ───────────────────────────────────
  // The FO eligibility mirror reads window.UPS_MOBILE.state + .data. Install a
  // shim ONLY when absent (never clobber a real mobile app). We mark ours so
  // syncShim only mutates state we own.
  function ensureShim() {
    if (root.UPS_MOBILE) return;
    root.UPS_MOBILE = {
      __upsActShim: true,
      state: { ctx: { year: "", leagueId: "" }, contractDeadline: "", tagSubmissions: [], tagTracking: [] },
      data: {
        findFranchiseById: function (fid) { return findFranchise(fid); },
        acquisitionForPlayer: function (fid, pid) { return acqFor(fid, pid); }
      }
    };
  }
  function syncShim(ctx) {
    ensureShim();
    var m = root.UPS_MOBILE;
    if (!m || !m.__upsActShim) return; // a real mobile app owns it — hands off
    m.state.ctx.year = safeStr(ctx.year);
    m.state.ctx.leagueId = safeStr(ctx.leagueId);
    m.state.contractDeadline = _data.contractDeadline || "";
    m.state.tagSubmissions = _data.tagSubmissions || [];
    m.state.tagTracking = _data.tagTracking || [];
  }

  // ── lazy-load the FO modules (memoized) ─────────────────────────────────
  var MODS = [
    ["UPS_FRONT_OFFICE", "front_office_penalty.js"],
    ["UPS_FRONT_OFFICE_ACTIONS", "front_office_actions.js"],
    ["UPS_FRONT_OFFICE_EXT", "front_office_extend_submit.js"],
    ["UPS_FRONT_OFFICE_RSTR", "front_office_restructure_submit.js"],
    ["UPS_M_FO_MYAC", "front_office_myac_submit.js"],
    ["UPS_M_FO_MYM", "front_office_mym_submit.js"],
    ["UPS_FRONT_OFFICE_TAG", "front_office_tag_submit.js"]
  ];
  var _modsPromise = null;
  function injectScript(globalName, file) {
    if (root[globalName]) return Promise.resolve(true);
    return new Promise(function (resolve) {
      var s = document.createElement("script");
      s.src = GH_BASE + "/m/" + file + "?v=" + MOD_V;
      s.onload = function () { resolve(!!root[globalName]); };
      s.onerror = function () { resolve(false); };
      (document.head || document.documentElement).appendChild(s);
    });
  }
  function loadModules() {
    if (_modsPromise) return _modsPromise;
    _modsPromise = Promise.all(MODS.map(function (m) { return injectScript(m[0], m[1]); }));
    return _modsPromise;
  }
  function modulesLoaded() {
    for (var i = 0; i < MODS.length; i++) if (!root[MODS[i][0]]) return false;
    return true;
  }

  function dropPenaltyEstimate(row, year) {
    try {
      if (root.UPS_FRONT_OFFICE && root.UPS_FRONT_OFFICE.dropPenaltyFor) {
        var p = root.UPS_FRONT_OFFICE.dropPenaltyFor(row, year);
        if (p && typeof p.amount === "number") return p.amount;
      }
    } catch (e) {}
    return null;
  }

  // ── roster-move + membership POSTs (owner cookie forwarded) ─────────────
  var __busy = false;
  function parseResp(r) {
    return r.text().then(function (t) {
      var b = null; try { b = t ? JSON.parse(t) : null; } catch (e) {}
      return { status: r.status, ok: r.ok, body: b || {} };
    });
  }
  function postRosterAction(action, row, ctx) {
    if (__busy) return Promise.reject(new Error("Another action is in progress"));
    __busy = true;
    var url = WORKER_BASE + "/roster-workbench/action";
    var mflUser = readCookie("MFL_USER_ID");
    if (mflUser) url += "?MFL_USER_ID=" + encodeURIComponent(mflUser);
    return fetch(url, {
      method: "POST", mode: "cors", credentials: "omit",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: action,
        league_id: ctx.leagueId,
        season: ctx.year,
        franchise_id: pad4(ctx.viewerFranchiseId || (row && row.ownerFid)),
        player_id: String(row.id)
      })
    }).then(function (r) { __busy = false; return parseResp(r); })
      .catch(function (e) { __busy = false; throw e; });
  }

  // ── Add-to-Block bulk overwrite (non-clobbering read-modify-write) ──────
  // /api/submit-trade-bait REPLACES the franchise's whole bait list. We read
  // the current list + notes, flip this one player, and write everything back
  // so other players + their D1 notes + lookingFor survive.
  function submitOtb(addOrRemove, note, row, ctx) {
    var fid = pad4(ctx.viewerFranchiseId);
    var ids = myTradeBaitIds(fid);
    var pid = String(row.id);
    if (addOrRemove === "add") ids[pid] = true; else delete ids[pid];
    var willGiveUp = Object.keys(ids);
    var existing = _data.tradeBaitNotes || {};
    var notes = {};
    Object.keys(existing).forEach(function (k) { if (k !== pid && ids[k]) notes[k] = existing[k]; });
    if (addOrRemove === "add") {
      if (typeof note === "string") { if (note) notes[pid] = note; }
      else if (existing[pid]) notes[pid] = existing[pid];
    }
    // We reliably know only this player's name (no players export on the
    // barebones page). Other players' names fall back to "Player <pid>" in the
    // MFL comment string; their D1 notes are preserved verbatim.
    var playerNames = {};
    playerNames[pid] = ctx.__playerName || pid;
    var url = WORKER_BASE + "/api/submit-trade-bait";
    var mflUser = readCookie("MFL_USER_ID");
    if (mflUser) url += "?MFL_USER_ID=" + encodeURIComponent(mflUser);
    return fetch(url, {
      method: "POST", mode: "cors", credentials: "omit",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        franchiseId: fid,
        franchiseName: (findFranchise(fid) || {}).name || "",
        willGiveUp: willGiveUp,
        lookingFor: _data.tradeBaitLookingFor || "",
        notes: notes,
        playerNames: playerNames
      })
    }).then(parseResp);
  }

  var FO_LABEL_LITE = " (full site) →";
  var FO_LABEL = " →";
  function foHref(ctx) {
    return "/" + encodeURIComponent(ctx.year) + "/home/" + encodeURIComponent(ctx.leagueId) +
      "?MODULE=MESSAGE7&ups_barebones=0";
  }

  function hadTagThisSeason(row, year) {
    var subs = _data.tagSubmissions || [];
    var pid = String(row.id || "").replace(/\D/g, "");
    var seasonStr = year != null ? String(year) : "";
    for (var i = 0; i < subs.length; i++) {
      var s = subs[i] || {};
      if (String(s.player_id || "").replace(/\D/g, "") !== pid) continue;
      var rowSeason = String(s.season || s.year || "");
      if (seasonStr && rowSeason && rowSeason !== seasonStr) continue;
      if (String(s.submission_kind || s.kind || "tag").toLowerCase() === "tag") return true;
    }
    return false;
  }

  // ── button + section builders ──────────────────────────────────────────
  function actBtn(act, label, extraCls) {
    return '<button type="button" class="upm-act' + (extraCls ? " " + extraCls : "") +
      '" data-upm-act="' + esc(act) + '">' + esc(label) + '</button>';
  }
  function dataBtn(act, years, label) {
    return '<button type="button" class="upm-act" data-upm-act="' + esc(act) +
      '" data-upm-years="' + esc(years) + '">' + esc(label) + '</button>';
  }

  function buildMainHtml(row, ctx) {
    var status = safeStr(row.status).toUpperCase();
    var isTaxi = status.indexOf("TAXI") !== -1;
    var isIr = status.indexOf("IR") !== -1 || status.indexOf("INJURED") !== -1;
    var cstat = safeStr(row.contractStatus);
    var cy = safeInt(row.contractYear, 0);
    var sal = safeInt(row.salary, 0);

    var FOA = root.UPS_FRONT_OFFICE_ACTIONS;
    var viewerFid = ctx.viewerFranchiseId;
    var elig = FOA ? FOA.eligibilityForRosterRow(row, viewerFid)
      : { myacEligible: false, mymEligible: false, extensionEligible: false, restructureEligible: false };
    var extAvail = (FOA && FOA.extensionAvailableFor) ? FOA.extensionAvailableFor(row, viewerFid)
      : { ok: !!elig.extensionEligible, reason: "" };
    var extEligible = !!extAvail.ok;
    var tagAction = FOA ? FOA.tagActionForPlayer({
      rosterRow: row, fid: viewerFid, rosterRowsWithPos: [],
      tagTracking: _data.tagTracking, tagSubmissions: _data.tagSubmissions, currentSeason: ctx.year
    }) : { kind: "none" };
    var tagEligible = tagAction.kind === "tag" || tagAction.kind === "untag";
    var tagLabel = tagAction.kind === "untag" ? "Untag" : "Tag";
    var tagAct = tagAction.kind === "untag" ? "untag" : "tag";

    var pen = dropPenaltyEstimate(row, ctx.year);
    var penLabel = pen == null ? " (penalty TBD)" : (pen > 0 ? " (" + fmtUsd(pen) + " penalty)" : " (no penalty)");

    var onBlock = !!myTradeBaitIds(viewerFid)[String(row.id)];

    var out = [];
    out.push('<div class="upm-act-ctx">' + esc(cstat || "—") + ' · ' + esc(cy) + ' yr' + (cy === 1 ? "" : "s") +
      ' left · ' + esc(fmtUsd(sal)) + '</div>');

    out.push('<div class="upm-act-row2">' +
      actBtn("otb-open", onBlock ? "✓ On the Block" : "Add to Block", onBlock ? "is-on" : "") +
      actBtn("drop", "Drop" + penLabel, "upm-act-danger") + '</div>');

    if (isTaxi) out.push(actBtn("promote-taxi", "Promote from Taxi"));
    if (isIr) out.push(actBtn("activate-ir", "Activate from IR"));

    if (elig.myacEligible) {
      var dl = _data.contractDeadline ? " Window closes " + esc(_data.contractDeadline) + "." : "";
      out.push('<div class="upm-act-sec">Multi-Year Contract (MYAC) · §C2' +
        '<span class="upm-act-sub">Set this 1-yr deal to 2 or 3 years at the same salary — no raise. ' +
        '<strong>Loaded</strong> free-keys Y1 (FL/BL).' + dl + '</span></div>');
      out.push('<div class="upm-act-row2">' + dataBtn("myac-flat", "2", "2-Year") +
        dataBtn("myac-loaded-open", "2", "2-Yr Loaded…") + '</div>');
      out.push('<div class="upm-act-row2">' + dataBtn("myac-flat", "3", "3-Year") +
        dataBtn("myac-loaded-open", "3", "3-Yr Loaded…") + '</div>');
    }

    if (elig.mymEligible) {
      var dn = (elig.mymDaysSinceAcq != null) ? " Day " + elig.mymDaysSinceAcq + " of 14." : "";
      out.push('<div class="upm-act-sec">Mid-Year Multi (MYM) · §C3' +
        '<span class="upm-act-sub">Lock this in-season pickup into a flat 2- or 3-year deal at the same salary — ' +
        'no raise, can’t be loaded. Max 4 per team a season.' + dn + '</span></div>');
      out.push('<div class="upm-act-row2">' + dataBtn("mym", "2", "2-Year") + dataBtn("mym", "3", "3-Year") + '</div>');
    }

    var grid = [];
    if (extEligible) grid.push(actBtn("extend-open", "Extend"));
    if (elig.restructureEligible) grid.push(actBtn("restructure-open", "Restructure"));
    if (tagEligible) grid.push(actBtn(tagAct, tagLabel));
    if (grid.length) out.push('<div class="upm-act-list">' + grid.join("") + '</div>');

    if (hadTagThisSeason(row, ctx.year) && cstat.toUpperCase() !== "TAG") {
      out.push('<button type="button" class="upm-act upm-act-danger" data-upm-act="unload-cleanup" ' +
        'title="Was tagged this season but the unload step didn’t complete — removes from active roster (no penalty).">' +
        '⚠ Complete untag (cleanup)</button>');
    }

    var lab = (root.UPS_BAREBONES ? FO_LABEL_LITE : FO_LABEL);
    out.push('<div class="upm-act-more"><a class="upm-fo-link" href="' + foHref(ctx) + '">Open Front Office' + esc(lab) + '</a></div>');
    return out.join("");
  }

  // ── sub-view rendering into #upm-actions-panel ──────────────────────────
  var PANEL_ID = "upm-actions-panel";
  function panelEl() { return document.getElementById(PANEL_ID); }
  function paint(inner) { var p = panelEl(); if (p) p.innerHTML = inner; }
  function backBtn() { return '<button type="button" class="upm-act-back" data-upm-act="back">← Back</button>'; }
  function name() { return (__activeCtx && __activeCtx.__playerName) || ("Player #" + (__activeRow && __activeRow.id)); }

  function renderMain() { paint(buildMainHtml(__activeRow, __activeCtx)); }

  // — Add-to-Block note editor —
  function renderOtbNote() {
    __view = "otb";
    var viewerFid = __activeCtx.viewerFranchiseId;
    var onBlock = !!myTradeBaitIds(viewerFid)[String(__activeRow.id)];
    var existing = _data.tradeBaitNotes[String(__activeRow.id)] || "";
    paint(backBtn() +
      '<div class="upm-act-sec">' + (onBlock ? "Update Block note" : "Add to On the Block") + '</div>' +
      '<textarea id="upm-otb-note" class="upm-act-note-input" rows="3" maxlength="240" ' +
      'placeholder="Optional note — what you want, condition, contender preference, etc.">' + esc(existing) + '</textarea>' +
      '<div class="upm-act-row2">' +
      (onBlock ? '<button type="button" class="upm-act upm-act-danger" data-upm-act="otb-remove">Remove from Block</button>' : '') +
      '<button type="button" class="upm-act is-on" data-upm-act="otb-save">' + (onBlock ? "Update" : "Add to Block") + '</button>' +
      '</div>');
  }

  // — Extension option picker —
  var __extOptions = [], __extLoaded = null;
  function renderExtLoading(msg) { __view = "ext"; paint(backBtn() + '<p class="upm-co-empty">' + esc(msg) + '</p>'); }
  function renderExtOptions() {
    __view = "ext";
    var FOX = root.UPS_FRONT_OFFICE_EXT;
    if (!__extOptions.length) { paint(backBtn() + '<p class="upm-co-empty">No extension options available for this player.</p>'); return; }
    var rows = __extOptions.map(function (opt) {
      return '<button type="button" class="upm-act upm-act-opt" data-upm-act="ext-pick" data-upm-key="' + esc(opt.optionKey) + '">' +
        '<span class="upm-act-opt-t">' + esc(FOX.extensionActionLabel(opt)) + '</span>' +
        '<span class="upm-act-opt-s">' + esc(FOX.extensionOptionSummary(opt)) + '</span>' +
        '<span class="upm-act-opt-ci">' + esc((opt.contractInfo || "").slice(0, 120)) + '</span></button>';
    });
    var twoYr = __extOptions.filter(function (o) { return safeInt(o.yearsToAdd, 0) === 2; })[0];
    if (twoYr && safeInt(twoYr.futureAav, 0) >= 1000 && FOX.buildLoadedExtensionOption) {
      __extLoaded = { base: twoYr };
      rows.push('<button type="button" class="upm-act upm-act-opt" data-upm-act="ext-loaded-open">' +
        '<span class="upm-act-opt-t">Extend +2Y — Loaded (FL/BL)…</span>' +
        '<span class="upm-act-opt-s">Y1 stays at the current salary; set Y2 and Y3 auto-fills.</span></button>');
    }
    paint(backBtn() + '<div class="upm-act-sub" style="margin:2px 0 8px">Pick the option to submit. Writes to MFL on confirm.</div>' +
      '<div class="upm-act-list">' + rows.join("") + '</div>');
  }
  function findExtOption(key) {
    for (var i = 0; i < __extOptions.length; i++) if (__extOptions[i].optionKey === key) return __extOptions[i];
    return null;
  }
  function renderExtLoaded() {
    __view = "ext-loaded";
    var FOX = root.UPS_FRONT_OFFICE_EXT;
    var futureAav = safeInt(__extLoaded.base && __extLoaded.base.futureAav, 0);
    var c = FOX.loadedExtensionConstraints(__activeRow, futureAav);
    __extLoaded.c = c;
    __extLoaded.y2 = c.futureAav;
    paint(backBtn() +
      '<div class="upm-act-sec">+2Y Loaded — Y1 locked, set Y2, Y3 auto-fills.</div>' +
      '<div class="upm-act-derived">' +
      '<div><span>Y1 (locked)</span><b>' + esc(fmtUsd(c.currentSalary)) + '</b></div>' +
      '<div><span>Y2 + Y3 total</span><b>' + esc(fmtUsd(c.extensionTotal)) + '</b></div>' +
      '<div><span>Each year ≥</span><b>' + esc(fmtUsd(c.minExtYear)) + ' (20%)</b></div></div>' +
      '<div class="upm-act-field"><label>Year 2 salary (min ' + esc(fmtUsd(c.minExtYear)) + ', 1K increments)</label>' +
      '<input type="number" step="1000" min="' + c.minExtYear + '" value="' + c.futureAav + '" id="upm-extl-y2" inputmode="numeric" class="upm-act-input" /></div>' +
      '<div class="upm-act-derived">' +
      '<div><span>Year 3 (auto)</span><b id="upm-extl-y3">—</b></div>' +
      '<div><span>Status</span><b id="upm-extl-status">—</b></div>' +
      '<div><span>TCV · GTD</span><b id="upm-extl-tcv">—</b></div></div>' +
      '<div id="upm-extl-msg"></div>' +
      '<button type="button" class="upm-act is-on" id="upm-extl-submit" data-upm-act="ext-loaded-submit">Submit Loaded Extension</button>');
    var inp = document.getElementById("upm-extl-y2");
    if (inp) inp.addEventListener("input", function (e) { __extLoaded.y2 = parseInt(e.target.value, 10) || 0; updateExtLoaded(); });
    updateExtLoaded();
  }
  function updateExtLoaded() {
    var FOX = root.UPS_FRONT_OFFICE_EXT, c = __extLoaded.c;
    var y2 = Math.round((parseInt(__extLoaded.y2, 10) || 0) / 1000) * 1000;
    var y3 = c.extensionTotal - y2;
    var opt = FOX.buildLoadedExtensionOption(c, y2);
    setText("upm-extl-y3", fmtUsd(y3));
    setText("upm-extl-status", opt.status);
    setText("upm-extl-tcv", fmtUsd(opt.tcv) + " · " + fmtUsd(opt.gtd));
    var err = FOX.validateLoadedExtensionYears(y2, y3, c.minExtYear);
    setHtml("upm-extl-msg", err ? '<div class="upm-act-err">' + esc(err) + '</div>' : '<div class="upm-act-ok">Ready to submit.</div>');
    var btn = document.getElementById("upm-extl-submit"); if (btn) btn.disabled = !!err;
  }

  // — Restructure editor —
  var __rstr = null;
  function renderRestructure() {
    __view = "restructure";
    var FOR = root.UPS_FRONT_OFFICE_RSTR;
    var adapted = FOR.adaptRosterRow(__activeRow);
    var cy = safeInt(__activeRow.contractYear, 0);
    var years = cy >= 3 ? 3 : 2;
    var baseline = FOR.restructureBaselineForPlayer(adapted, years);
    __rstr = { years: years, tcv: baseline.tcv, y1: baseline.y1, y2: years === 2 ? (baseline.tcv - baseline.y1) : baseline.y2 };
    var minY1 = Math.ceil((__rstr.tcv * 0.2) / 1000) * 1000;
    paint(backBtn() +
      '<div class="upm-act-sec">Restructure — TCV preserved, move money between years.</div>' +
      '<div class="upm-act-derived"><div><span>TCV (fixed)</span><b>' + esc(fmtUsd(__rstr.tcv)) + '</b></div>' +
      '<div><span>Years</span><b>' + __rstr.years + '</b></div></div>' +
      '<div class="upm-act-field"><label>Year 1 salary (min ' + esc(fmtUsd(minY1)) + ', 1K increments)</label>' +
      '<input type="number" step="1000" min="' + minY1 + '" value="' + __rstr.y1 + '" id="upm-rstr-y1" inputmode="numeric" class="upm-act-input" /></div>' +
      (years === 3 ? '<div class="upm-act-field"><label>Year 2 salary (1K increments)</label>' +
        '<input type="number" step="1000" min="1000" value="' + __rstr.y2 + '" id="upm-rstr-y2" inputmode="numeric" class="upm-act-input" /></div>' : '') +
      '<div class="upm-act-derived">' +
      (years === 2 ? '<div><span>Year 2 (auto)</span><b id="upm-rstr-yauto">—</b></div>'
        : '<div><span>Year 3 (auto)</span><b id="upm-rstr-yauto">—</b></div>') +
      '<div><span>AAV</span><b id="upm-rstr-aav">—</b></div>' +
      '<div><span>GTD</span><b id="upm-rstr-gtd">—</b></div></div>' +
      '<div id="upm-rstr-msg"></div>' +
      '<button type="button" class="upm-act is-on" id="upm-rstr-submit" data-upm-act="rstr-submit">Submit Restructure</button>');
    var y1 = document.getElementById("upm-rstr-y1");
    if (y1) y1.addEventListener("input", function (e) { __rstr.y1 = parseInt(e.target.value, 10) || 0; updateRstr(); });
    var y2 = document.getElementById("upm-rstr-y2");
    if (y2) y2.addEventListener("input", function (e) { __rstr.y2 = parseInt(e.target.value, 10) || 0; updateRstr(); });
    updateRstr();
  }
  function updateRstr() {
    var FOR = root.UPS_FRONT_OFFICE_RSTR;
    var calc = FOR.restructureCalc({ years: __rstr.years, tcv: __rstr.tcv, y1: __rstr.y1, y2: __rstr.y2 });
    setText("upm-rstr-yauto", __rstr.years === 2 ? fmtUsd(__rstr.tcv - __rstr.y1) : fmtUsd(__rstr.tcv - __rstr.y1 - __rstr.y2));
    setText("upm-rstr-aav", fmtUsd(calc.aav));
    setText("upm-rstr-gtd", calc.ok ? fmtUsd(calc.gtd) : "—");
    setHtml("upm-rstr-msg", calc.ok ? '<div class="upm-act-ok">Ready to submit.</div>' : '<div class="upm-act-err">' + esc(calc.error || "") + '</div>');
    var btn = document.getElementById("upm-rstr-submit"); if (btn) btn.disabled = !calc.ok;
  }

  // — MYAC loaded editor —
  var __myacL = null;
  function renderMyacLoaded(years) {
    __view = "myac-loaded";
    var MY = root.UPS_M_FO_MYAC;
    var c = MY.loadedMyacConstraints(__activeRow, years);
    __myacL = { years: years, c: c, statusBase: MY.myacStatusBase(__activeRow), y1: c.minY1, y2: c.bid };
    paint(backBtn() +
      '<div class="upm-act-sec">' + years + '-Yr Loaded MYAC — free-key Y1' + (years === 3 ? " & Y2" : "") + ', last year auto-fills.</div>' +
      '<div class="upm-act-derived"><div><span>TCV (fixed)</span><b>' + esc(fmtUsd(c.tcv)) + '</b></div>' +
      '<div><span>Y1 min (20%)</span><b>' + esc(fmtUsd(c.minY1)) + '</b></div></div>' +
      '<div class="upm-act-field"><label>Year 1 salary (min ' + esc(fmtUsd(c.minY1)) + ', 1K increments)</label>' +
      '<input type="number" step="1000" min="' + c.minY1 + '" value="' + c.minY1 + '" id="upm-myacl-y1" inputmode="numeric" class="upm-act-input" /></div>' +
      (years === 3 ? '<div class="upm-act-field"><label>Year 2 salary (1K increments)</label>' +
        '<input type="number" step="1000" min="1000" value="' + c.bid + '" id="upm-myacl-y2" inputmode="numeric" class="upm-act-input" /></div>' : '') +
      '<div class="upm-act-derived">' +
      '<div><span>Last year (auto)</span><b id="upm-myacl-last">—</b></div>' +
      '<div><span>Status</span><b id="upm-myacl-status">—</b></div>' +
      '<div><span>TCV · GTD</span><b id="upm-myacl-tcv">—</b></div></div>' +
      '<div id="upm-myacl-msg"></div>' +
      '<button type="button" class="upm-act is-on" id="upm-myacl-submit" data-upm-act="myac-loaded-submit">Submit Loaded MYAC</button>');
    var y1 = document.getElementById("upm-myacl-y1");
    if (y1) y1.addEventListener("input", function (e) { __myacL.y1 = parseInt(e.target.value, 10) || 0; updateMyacL(); });
    var y2 = document.getElementById("upm-myacl-y2");
    if (y2) y2.addEventListener("input", function (e) { __myacL.y2 = parseInt(e.target.value, 10) || 0; updateMyacL(); });
    updateMyacL();
  }
  function myacLoadedYrs() {
    var MY = root.UPS_M_FO_MYAC;
    return MY.loadedMyacYears(__myacL.c, __myacL.y1, __myacL.years === 3 ? __myacL.y2 : 0);
  }
  function updateMyacL() {
    var MY = root.UPS_M_FO_MYAC;
    var yrs = myacLoadedYrs();
    var contract = MY.buildMyacContract(__myacL.years, yrs, __myacL.statusBase);
    setText("upm-myacl-last", fmtUsd(yrs[yrs.length - 1]));
    setText("upm-myacl-status", contract.status);
    setText("upm-myacl-tcv", fmtUsd(contract.tcv) + " · " + fmtUsd(contract.gtd));
    var err = MY.validateLoadedYears(yrs, __myacL.c.minY1);
    setHtml("upm-myacl-msg", err ? '<div class="upm-act-err">' + esc(err) + '</div>' : '<div class="upm-act-ok">Ready to submit.</div>');
    var btn = document.getElementById("upm-myacl-submit"); if (btn) btn.disabled = !!err;
  }

  function setText(id, t) { var el = document.getElementById(id); if (el) el.textContent = t; }
  function setHtml(id, h) { var el = document.getElementById(id); if (el) el.innerHTML = h; }

  // ── common submit args for the contract mirrors ─────────────────────────
  function baseArgs() {
    var ctx = __activeCtx, row = __activeRow, fid = pad4(ctx.viewerFranchiseId);
    return {
      workerBase: WORKER_BASE, leagueId: ctx.leagueId, year: ctx.year,
      pid: String(row.id), playerName: name(), fid: fid,
      franchiseName: (findFranchise(fid) || {}).name || "",
      position: safeStr(ctx.position), rosterRow: row, dryRun: false, commishOverride: false
    };
  }

  // ── busy/run + delegated click handler ──────────────────────────────────
  function setBusy(btn, on) {
    if (!btn) return;
    if (on) { btn.setAttribute("data-orig", btn.textContent || ""); btn.textContent = "Working…"; btn.disabled = true; }
    else { var o = btn.getAttribute("data-orig"); if (o != null) btn.textContent = o; btn.disabled = false; }
  }
  function run(btn, promise, okMsg, noReload) {
    setBusy(btn, true);
    promise.then(function (resp) {
      if (resp && resp.ok) {
        toast(okMsg, "ok");
        if (noReload) { setBusy(btn, false); return; }
        setTimeout(function () { root.location.reload(); }, 700);
      } else {
        setBusy(btn, false);
        var m = (resp && (resp.error || (resp.body && (resp.body.reason || resp.body.error || resp.body.message)))) || ("HTTP " + (resp && resp.status));
        toast("Failed: " + m, "err");
      }
    }).catch(function (e) {
      setBusy(btn, false);
      toast("Failed: " + (e && e.message ? e.message : String(e)), "err");
    });
  }

  var __wired = false, __activeRow = null, __activeCtx = null, __view = "main";
  function wireOnce() {
    if (__wired) return;
    __wired = true;
    document.addEventListener("click", function (ev) {
      var btn = ev.target && ev.target.closest ? ev.target.closest("[data-upm-act]") : null;
      if (!btn) return;
      if (!btn.closest(".upm-act-panel")) return;
      ev.preventDefault();
      if (!__activeRow || !__activeCtx) return;
      dispatch(btn.getAttribute("data-upm-act"), btn);
    }, false);
  }

  function dispatch(act, btn) {
    var row = __activeRow, ctx = __activeCtx, nm = name();
    switch (act) {
      case "back": renderMain(); return;

      // ── one-shot roster moves ──
      case "drop": {
        var pen = dropPenaltyEstimate(row, ctx.year);
        var penLine = pen == null ? "" : (pen > 0 ? "\n\nEstimated cap penalty: " + fmtUsd(pen) : "\n\nNo cap penalty.");
        if (!root.confirm("Drop " + nm + "?" + penLine + "\n\nThis writes to MFL and cannot be undone.")) return;
        run(btn, postRosterAction("drop_player", row, ctx), "Dropped " + nm + " ✓");
        return;
      }
      case "promote-taxi":
        if (!root.confirm("Promote " + nm + " from the taxi squad to the active roster?")) return;
        run(btn, postRosterAction("promote_taxi", row, ctx), nm + " promoted ✓");
        return;
      case "activate-ir":
        if (!root.confirm("Activate " + nm + " from IR to the active roster?\n\nThey count against the cap + active-roster max again.")) return;
        run(btn, postRosterAction("activate_ir", row, ctx), nm + " activated ✓");
        return;
      case "unload-cleanup":
        if (!root.confirm("Complete the untag for " + nm + "?\n\nThis removes them from your active roster. No cap penalty — the contract was already reverted.")) return;
        run(btn, postRosterAction("unload_player", row, ctx), nm + " removed ✓");
        return;

      // ── Add-to-Block ──
      case "otb-open": renderOtbNote(); return;
      case "otb-cancel": renderMain(); return;
      case "otb-save": {
        var ta = document.getElementById("upm-otb-note");
        var note = ta ? String(ta.value || "").trim() : "";
        run(btn, submitOtb("add", note, row, ctx), "Added to On the Block ✓");
        return;
      }
      case "otb-remove":
        if (!root.confirm("Remove " + nm + " from On the Block?")) return;
        run(btn, submitOtb("remove", "", row, ctx), "Removed from On the Block ✓");
        return;

      // ── MYM (flat 2/3) ──
      case "mym": {
        var MM = root.UPS_M_FO_MYM;
        if (!MM) { toast("Actions still loading…", "err"); return; }
        var yrs = safeInt(btn.getAttribute("data-upm-years"), 2) || 2;
        var perYear = safeInt(row.salary, 0);
        var vErr = MM.validateMym(perYear, yrs);
        if (vErr) { toast(vErr, "err"); return; }
        var acq = acqFor(pad4(ctx.viewerFranchiseId), row.id);
        var acqLabel = acq ? acq.label : "";
        var subType = MM.mymSubType(row.contractStatus, acqLabel);
        var mc = MM.buildMymContract(perYear, yrs, subType);
        var mL = ["Submit " + yrs + "-year MYM for " + nm + "?", "", "Sub-type: " + mc.subType,
          "Per year: " + fmtUsd(mc.perYear) + " (flat — cannot be loaded)",
          "TCV: " + fmtUsd(mc.tcv) + " · GTD: " + fmtUsd(mc.gtd)];
        if (!root.confirm(mL.join("\n") + "\n\nThis writes to MFL and cannot be undone from the app.")) return;
        var ma = baseArgs(); ma.contract = mc; ma.acquisitionDate = acq ? acq.date : ""; ma.acquisitionType = acqLabel;
        run(btn, MM.submitMym(ma), yrs + "-yr MYM submitted ✓ (" + mc.subType + ")");
        return;
      }

      // ── MYAC flat ──
      case "myac-flat": {
        var MY = root.UPS_M_FO_MYAC;
        if (!MY) { toast("Actions still loading…", "err"); return; }
        var yy = safeInt(btn.getAttribute("data-upm-years"), 2) || 2;
        var flat = MY.flatMyacYears(row, yy);
        if (flat.error) { toast(flat.error, "err"); return; }
        var mac = MY.buildMyacContract(yy, flat.yrs, MY.myacStatusBase(row));
        var aL = ["Submit " + yy + "-year MYAC for " + nm + "?", "", "Status: " + mac.status];
        for (var i = 0; i < mac.yrs.length; i++) aL.push("Y" + (i + 1) + ": " + fmtUsd(mac.yrs[i]));
        aL.push("TCV: " + fmtUsd(mac.tcv) + " · GTD: " + fmtUsd(mac.gtd));
        if (!root.confirm(aL.join("\n") + "\n\nThis writes to MFL and cannot be undone from the app.")) return;
        var aa = baseArgs(); aa.contract = mac;
        run(btn, MY.submitMyac(aa), yy + "-yr MYAC submitted ✓");
        return;
      }
      case "myac-loaded-open": {
        if (!root.UPS_M_FO_MYAC) { toast("Actions still loading…", "err"); return; }
        renderMyacLoaded(safeInt(btn.getAttribute("data-upm-years"), 2) || 2);
        return;
      }
      case "myac-loaded-submit": {
        var MYl = root.UPS_M_FO_MYAC;
        var lyrs = myacLoadedYrs();
        var le = MYl.validateLoadedYears(lyrs, __myacL.c.minY1);
        if (le) { toast(le, "err"); return; }
        var lc = MYl.buildMyacContract(__myacL.years, lyrs, __myacL.statusBase);
        var lL = ["Submit " + __myacL.years + "-year loaded MYAC for " + nm + "?", "", "Status: " + lc.status];
        for (var j = 0; j < lc.yrs.length; j++) lL.push("Y" + (j + 1) + ": " + fmtUsd(lc.yrs[j]));
        lL.push("TCV: " + fmtUsd(lc.tcv) + " · GTD: " + fmtUsd(lc.gtd));
        if (!root.confirm(lL.join("\n") + "\n\nThis writes to MFL and cannot be undone from the app.")) return;
        var la = baseArgs(); la.contract = lc;
        run(btn, MYl.submitMyac(la), __myacL.years + "-yr loaded MYAC submitted ✓");
        return;
      }

      // ── Extension ──
      case "extend-open": {
        var FOX = root.UPS_FRONT_OFFICE_EXT;
        if (!FOX) { toast("Actions still loading…", "err"); return; }
        renderExtLoading("Loading extension options…");
        FOX.loadOptionsForPlayer({ year: ctx.year, pid: String(row.id), fid: pad4(ctx.viewerFranchiseId), rosterRow: row })
          .then(function (options) { __extOptions = options || []; if (__view === "ext" && __activeRow === row) renderExtOptions(); })
          .catch(function (e) { if (__view === "ext") paint(backBtn() + '<p class="upm-act-err">Failed to load options: ' + esc(e && e.message || e) + '</p>'); });
        return;
      }
      case "ext-pick": {
        var FOXp = root.UPS_FRONT_OFFICE_EXT;
        var opt = findExtOption(btn.getAttribute("data-upm-key"));
        if (!opt) return;
        var pm = "Submit extension for " + nm + "?\n\n" + FOXp.extensionActionLabel(opt) + "\n" + FOXp.extensionOptionSummary(opt) +
          "\n\nThis writes to MFL and cannot be undone from the app.";
        if (!root.confirm(pm)) return;
        var pa = baseArgs(); pa.option = opt;
        run(btn, FOXp.submitExtension(pa), "Extension submitted ✓");
        return;
      }
      case "ext-loaded-open": renderExtLoaded(); return;
      case "ext-loaded-submit": {
        var FOXl = root.UPS_FRONT_OFFICE_EXT, cc = __extLoaded.c;
        var ey2 = Math.round((parseInt(__extLoaded.y2, 10) || 0) / 1000) * 1000;
        var ey3 = cc.extensionTotal - ey2;
        var eErr = FOXl.validateLoadedExtensionYears(ey2, ey3, cc.minExtYear);
        if (eErr) { toast(eErr, "err"); return; }
        var eopt = FOXl.buildLoadedExtensionOption(cc, ey2);
        var eL = ["Submit +2Y loaded extension for " + nm + "?", "", "Status: " + eopt.status,
          "Y1: " + fmtUsd(eopt.yrs[0]) + " (locked)", "Y2: " + fmtUsd(eopt.yrs[1]), "Y3: " + fmtUsd(eopt.yrs[2]),
          "TCV: " + fmtUsd(eopt.tcv) + " · GTD: " + fmtUsd(eopt.gtd)];
        if (!root.confirm(eL.join("\n") + "\n\nThis writes to MFL and cannot be undone from the app.")) return;
        var ea = baseArgs(); ea.option = eopt;
        run(btn, FOXl.submitExtension(ea), eopt.status + " extension submitted ✓");
        return;
      }

      // ── Restructure ──
      case "restructure-open":
        if (!root.UPS_FRONT_OFFICE_RSTR) { toast("Actions still loading…", "err"); return; }
        renderRestructure();
        return;
      case "rstr-submit": {
        var FOR = root.UPS_FRONT_OFFICE_RSTR;
        var calc = FOR.restructureCalc({ years: __rstr.years, tcv: __rstr.tcv, y1: __rstr.y1, y2: __rstr.y2 });
        if (!calc.ok) { toast(calc.error || "Invalid restructure.", "err"); return; }
        var rL = ["Submit restructure for " + nm + "?", "", "Years: " + calc.years,
          "Year 1: " + fmtUsd(calc.y1), "Year 2: " + fmtUsd(calc.y2)];
        if (calc.years >= 3) rL.push("Year 3: " + fmtUsd(calc.y3));
        rL.push("TCV: " + fmtUsd(calc.tcv), "AAV: " + fmtUsd(calc.aav), "GTD: " + fmtUsd(calc.gtd));
        if (!root.confirm(rL.join("\n") + "\n\nThis writes to MFL and cannot be undone from the app.")) return;
        var fid = pad4(ctx.viewerFranchiseId);
        run(btn, FOR.submitRestructure({
          workerBase: WORKER_BASE, leagueId: ctx.leagueId, year: ctx.year, pid: String(row.id),
          playerName: nm, fid: fid, franchiseName: (findFranchise(fid) || {}).name || "",
          position: safeStr(ctx.position), priorContractStatus: safeStr(row.contractStatus),
          calc: calc, commishOverride: false
        }), "Restructure submitted ✓");
        return;
      }

      // ── Tag / Untag ──
      case "tag": {
        var FOAt = root.UPS_FRONT_OFFICE_ACTIONS, FOT = root.UPS_FRONT_OFFICE_TAG;
        if (!FOAt || !FOT) { toast("Actions still loading…", "err"); return; }
        var ta = FOAt.tagActionForPlayer({ rosterRow: row, fid: ctx.viewerFranchiseId, rosterRowsWithPos: [],
          tagTracking: _data.tagTracking, tagSubmissions: _data.tagSubmissions, currentSeason: ctx.year });
        if (ta.kind !== "tag" || !ta.row) { toast("This player isn’t in the tag plan.", "err"); return; }
        var trow = ta.row;
        var tsal = FOT.effectiveTagSalaryForRow(trow), tformula = FOT.effectiveTagFormulaForRow(trow);
        var tm = "Tag " + (trow.player_name || nm) + " for " + fmtUsd(tsal) + "?\n\n" +
          "Side: " + safeStr(trow.tag_side || trow.side) + "\n" +
          (trow.tag_tier ? "Tier: " + trow.tag_tier + "\n" : "") +
          (tformula ? "Formula: " + tformula + "\n" : "") +
          "\nThis writes to MFL and logs to UPS tag history.";
        if (!root.confirm(tm)) return;
        run(btn, FOT.submitTag({ workerBase: WORKER_BASE, leagueId: ctx.leagueId, year: ctx.year, row: trow, dryRun: false, commishOverride: false }),
          (trow.player_name || nm) + " tagged ✓");
        return;
      }
      case "untag": {
        var FOAu = root.UPS_FRONT_OFFICE_ACTIONS, FOTu = root.UPS_FRONT_OFFICE_TAG;
        if (!FOAu || !FOTu) { toast("Actions still loading…", "err"); return; }
        var ua = FOAu.tagActionForPlayer({ rosterRow: row, fid: ctx.viewerFranchiseId, rosterRowsWithPos: [],
          tagTracking: _data.tagTracking, tagSubmissions: _data.tagSubmissions, currentSeason: ctx.year });
        if (ua.kind !== "untag" || !ua.row) { toast("This player isn’t currently tagged.", "err"); return; }
        var urow = ua.row, ulabel = urow.player_name || nm;
        if (!root.confirm("Untag " + ulabel + "?\n\nRestore: " + safeStr(urow.contract_status) + " at " + fmtUsd(urow.salary) +
          "\nThen remove from roster.")) return;
        var ufid = pad4(ctx.viewerFranchiseId);
        run(btn, FOTu.submitUntag({ workerBase: WORKER_BASE, leagueId: ctx.leagueId, year: ctx.year, fid: ufid,
          pid: String(row.id), playerName: nm, franchiseName: (findFranchise(ufid) || {}).name || "",
          position: safeStr(ctx.position), row: urow, dryRun: false, commishOverride: false }),
          ulabel + " untagged ✓");
        return;
      }
      default:
        return;
    }
  }

  // ── entry point the bridge calls for an OWNED player ─────────────────────
  // Returns the immediate INNER HTML for #upm-actions-panel. Modules + data
  // are lazy-loaded (memoized); once ready we refill the panel with the full
  // button set (scheduleFill waits for the panel to exist since the modal
  // builds its tab content after its own async bundle fetch).
  function prepare(pid, row, ctx) {
    wireOnce();
    __activeRow = row; __activeCtx = ctx; __view = "main";
    ensureShim();
    var ready = _data.loaded && modulesLoaded();
    if (ready) syncShim(ctx);
    Promise.all([loadModules(), loadData(ctx)]).then(function () {
      syncShim(ctx); scheduleFill(row);
    }).catch(function () { scheduleFill(row); });
    return ready ? buildMainHtml(row, ctx) : '<p class="upm-co-empty">Loading actions…</p>';
  }
  function scheduleFill(row) {
    var tries = 0;
    (function tick() {
      if (__activeRow !== row) return;         // modal moved on to another player
      if (panelEl()) { if (__view === "main") renderMain(); return; }
      if (tries++ > 60) return;                 // ~4s ceiling
      setTimeout(tick, 66);
    })();
  }

  root.UPS_PLAYER_ACTIONS_NATIVE = { prepare: prepare };
})(typeof window !== "undefined" ? window : null);
