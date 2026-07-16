/*!
 * player_actions_native.js — real contract ACTIONS in the barebones player modal.
 *
 * The bridge (player_popup_bridge.js) opens player_profile_master.js on native
 * MFL pages in Lite Mode. That modal is a dumb renderer; this file is the
 * "brain" that supplies the Actions-tab HTML and owns the clicks — mirroring
 * how Roster Workbench drives the same modal.
 *
 * v1 wires the THREE bulletproof one-shot roster moves — single POSTs with
 * verified payloads, no read-modify-write, no option pickers, no extra fetches:
 *   Drop (with cap-penalty confirm) · Promote-from-Taxi · Activate-from-IR.
 * Everything else (Extend / Restructure / MYAC / MYM / Tag / Add-to-Block) is a
 * single "Open in Front Office" hand-off for now. The option-picker actions +
 * the read-modify-write Add-to-Block are the focused follow-up (they need the
 * tag/acquisition fetches and, for OTB, a non-clobbering bulk overwrite).
 *
 * AUTH (verified against RWB appendViewerSessionQuery + mobile app.js:1144):
 *   Roster moves POST /roster-workbench/action with ?MFL_USER_ID=<cookie> —
 *   MFL owner-restricted; the worker acts as that owner and MFL itself enforces
 *   ownership. The cookie is readable here because these scripts run on MFL's
 *   own origin (unlike the github.io PWA, which must bounce the token).
 *
 * SAFETY: buttons only render for a player the viewer OWNS (the bridge gates
 * it). The worker re-validates every write (ERA retention, R1/taxi rules); a
 * wrongly-shown button fails at the worker with a toast, never a silent bad
 * write. The cap penalty shown is a DISPLAY-ONLY estimate — the worker's
 * _computeDropPenalty + drop-tracker pipeline own the authoritative value.
 */
(function (root) {
  "use strict";
  if (!root) return;

  var WORKER_BASE =
    (typeof root.UPS_MOBILE_API_BASE === "string" && root.UPS_MOBILE_API_BASE) ||
    "https://upsmflproduction.keith-creelman.workers.dev";
  var GH_BASE = "https://keithcreelman.github.io/upsmflproduction";
  var PEN_V = "2026-07-16-barebones";

  function safeStr(v) { return v == null ? "" : String(v).trim(); }
  function pad4(v) { return safeStr(v).replace(/\D/g, "").padStart(4, "0").slice(-4); }
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

  // ── brain-owned toast (no mobile UI framework here) ────────────────────
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

  // ── memoized load of the drop-penalty module (only extra module v1 needs) ──
  var __penPromise = null;
  function ensurePenalty() {
    if (root.UPS_FRONT_OFFICE && root.UPS_FRONT_OFFICE.dropPenaltyFor) return Promise.resolve(true);
    if (__penPromise) return __penPromise;
    __penPromise = new Promise(function (resolve) {
      var s = document.createElement("script");
      s.src = GH_BASE + "/m/front_office_penalty.js?v=" + PEN_V;
      s.onload = function () { resolve(!!(root.UPS_FRONT_OFFICE && root.UPS_FRONT_OFFICE.dropPenaltyFor)); };
      s.onerror = function () { resolve(false); };
      (document.head || document.documentElement).appendChild(s);
    });
    return __penPromise;
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

  // ── the roster-move POST (drop / promote_taxi / activate_ir), verified ──
  var __busy = false;
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
    }).then(function (r) {
      return r.text().then(function (t) {
        var b = null; try { b = t ? JSON.parse(t) : null; } catch (e) {}
        __busy = false;
        return { status: r.status, ok: r.ok, body: b || {} };
      });
    }).catch(function (e) { __busy = false; throw e; });
  }

  var FO_LABEL_LITE = " (full site) →";
  var FO_LABEL = " →";
  function foHref(ctx) {
    return "/" + encodeURIComponent(ctx.year) + "/home/" + encodeURIComponent(ctx.leagueId) +
      "?MODULE=MESSAGE7&ups_barebones=0";
  }

  // ── render the Actions HTML for an OWNED player's row ──────────────────
  // Gating uses ONLY the roster row status — no extra fetches — so it can't
  // over-show. Everything not one-shot routes to the Front Office.
  function buildActionsHtml(row, ctx) {
    var status = safeStr(row.status).toUpperCase();
    var isTaxi = status.indexOf("TAXI") !== -1;
    var isIr = status.indexOf("IR") !== -1 || status.indexOf("INJURED") !== -1;

    var pen = dropPenaltyEstimate(row, ctx.year);
    var penLabel = pen == null ? " (penalty TBD)"
      : (pen > 0 ? " (" + fmtUsd(pen) + " penalty)" : " (no penalty)");

    var rows = [];
    if (isTaxi) rows.push('<button type="button" class="upm-act" data-upm-act="promote-taxi">Promote from Taxi</button>');
    if (isIr) rows.push('<button type="button" class="upm-act" data-upm-act="activate-ir">Activate from IR</button>');
    rows.push('<button type="button" class="upm-act upm-act-danger" data-upm-act="drop">Drop' + esc(penLabel) + "</button>");

    var lab = (root.UPS_BAREBONES ? FO_LABEL_LITE : FO_LABEL);
    return '<div class="upm-act-list">' + rows.join("") + "</div>" +
      '<div class="upm-act-note">Extend, restructure, MYAC/MYM, tag, and Add-to-Block run in the ' +
      '<a class="upm-fo-link" href="' + foHref(ctx) + '">Front Office</a>' +
      (root.UPS_BAREBONES ? " (full site)." : ".") + "</div>" +
      '<div class="upm-act-more"><a class="upm-fo-link" href="' + foHref(ctx) + '">Open Front Office' + esc(lab) + "</a></div>";
  }

  // ── one delegated click handler for the modal's Actions panel ──────────
  var __wired = false, __activeRow = null, __activeCtx = null;
  function wireOnce() {
    if (__wired) return;
    __wired = true;
    document.addEventListener("click", function (ev) {
      var btn = ev.target && ev.target.closest ? ev.target.closest("[data-upm-act]") : null;
      if (!btn) return;
      if (!btn.closest(".upm-act-panel")) return;
      ev.preventDefault();
      var act = btn.getAttribute("data-upm-act");
      var row = __activeRow, ctx = __activeCtx;
      if (!row || !ctx) return;
      var name = ctx.__playerName || ("Player #" + row.id);

      if (act === "drop") {
        var pen = dropPenaltyEstimate(row, ctx.year);
        var penLine = pen == null ? "" : (pen > 0 ? "\n\nEstimated cap penalty: " + fmtUsd(pen) : "\n\nNo cap penalty.");
        if (!root.confirm("Drop " + name + "?" + penLine + "\n\nThis writes to MFL and cannot be undone.")) return;
        run(btn, postRosterAction("drop_player", row, ctx), "Dropped " + name + " ✓");
      } else if (act === "promote-taxi") {
        if (!root.confirm("Promote " + name + " from the taxi squad to the active roster?")) return;
        run(btn, postRosterAction("promote_taxi", row, ctx), name + " promoted ✓");
      } else if (act === "activate-ir") {
        if (!root.confirm("Activate " + name + " from IR to the active roster?")) return;
        run(btn, postRosterAction("activate_ir", row, ctx), name + " activated ✓");
      }
    }, false);
  }

  function setBusy(btn, on) {
    if (!btn) return;
    if (on) { btn.setAttribute("data-orig", btn.textContent || ""); btn.textContent = "Working…"; btn.disabled = true; }
    else { var o = btn.getAttribute("data-orig"); if (o != null) btn.textContent = o; btn.disabled = false; }
  }
  function run(btn, promise, okMsg) {
    setBusy(btn, true);
    promise.then(function (resp) {
      if (resp && resp.ok) {
        toast(okMsg, "ok");
        setTimeout(function () { root.location.reload(); }, 700);
      } else {
        setBusy(btn, false);
        toast("Failed: " + ((resp && resp.body && (resp.body.message || resp.body.error)) || ("HTTP " + (resp && resp.status))), "err");
      }
    }).catch(function (e) {
      setBusy(btn, false);
      toast("Failed: " + (e && e.message ? e.message : String(e)), "err");
    });
  }

  // ── entry point the bridge calls for an OWNED player ───────────────────
  function prepare(pid, row, ctx) {
    wireOnce();
    __activeRow = row;
    __activeCtx = ctx;
    // Load the penalty module, then refill the panel with the real penalty label.
    ensurePenalty().then(function () {
      var panel = document.getElementById("upm-actions-panel");
      if (panel && __activeRow === row) panel.innerHTML = buildActionsHtml(row, ctx);
    });
    return buildActionsHtml(row, ctx); // immediate first paint (penalty may read "TBD" until the module loads)
  }

  root.UPS_PLAYER_ACTIONS_NATIVE = { prepare: prepare };
})(typeof window !== "undefined" ? window : null);
