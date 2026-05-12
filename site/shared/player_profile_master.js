/* ═══════════════════════════════════════════════════════════════════════════
 * player_profile_master.js — Unified player profile modal for UPS MFL hubs
 *
 * Single source of truth for the player-profile UI. Replaces the
 * Rookie Draft Hub's showPlayerProfileCard() and Team Operations'
 * openPlayerProfileModal(). Same 4-tab layout (Bio / Stats / Game
 * Log / News), same 4-tier headshot fallback chain, same prospect-
 * board fallback for fresh rookies.
 *
 * Adds (vs Rookie Draft canonical):
 *   • Cap-math strip in Bio (TCV / AAV / Salary / Yrs Remain / Earned /
 *     Cap Penalty / Acquire Date / How Acquired) — era-aware.
 *   • College + Pre-NFL Prospect panels are gated on the MFL rookie
 *     tag AND pre-NFL-Week-1 date.
 *
 * Entry point:
 *   window.UPS_openPlayerProfile(pid, ctx)
 *
 * ctx fields:
 *   apiBase           — string, optional (Cloudflare worker base, default same-origin)
 *   leagueId, year    — strings
 *   mode              — "rookie_draft" | "front_office"  (controls minor visibility)
 *   prospects         — array of rookie prospect rows (rookie_draft mode)
 *   history           — { picks: [...] } (rookie_draft mode)
 *   leverageCoefs     — { QB: 0.88, ... } APW β coefficients (rookie_draft mode)
 *   viewerFranchise   — { id, name } (front_office mode)
 *   contractSalary    — MFL salary row for this player (front_office mode)
 *   transactions      — MFL transactions blob (front_office mode)
 *   injury            — MFL injury row for this player (front_office mode)
 *   nflWeek1Date      — "YYYY-MM-DD" — Week 1 Thursday opener (default "2026-09-11")
 *
 * Self-contained: ES5/IIFE, no imports, injects its own CSS + overlay
 * the first time it's invoked. Defensive — never throws into the host
 * hub. If the bundle fetch fails, falls back to historical/contract
 * data so the modal is never empty.
 *
 * Created 2026-05-12. v1.0.0 (Phase 1; Trade Workbench wiring deferred).
 * ═══════════════════════════════════════════════════════════════════════════ */
(function () {
  "use strict";

  if (window.UPS_openPlayerProfile) return;  // idempotent

  var DEFAULT_NFL_WEEK1 = "2026-09-11";
  var BUNDLE_CACHE = {};

  // ── Utility helpers ─────────────────────────────────────────────────────
  function escapeHtml(v) {
    if (v == null) return "";
    return String(v)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }
  function safeStr(v) { return v == null ? "" : String(v).trim(); }
  function asArr(v) { return Array.isArray(v) ? v : (v ? [v] : []); }
  function fmtUsd(n) {
    var num = Number(n) || 0;
    if (!num) return "$0";
    if (num >= 1000) return "$" + (num / 1000).toFixed(num % 1000 === 0 ? 0 : 1) + "K";
    return "$" + num.toLocaleString();
  }
  function fmtUsdFull(n) {
    var num = Number(n) || 0;
    return num ? "$" + num.toLocaleString() : "—";
  }
  function tierSlug(t) { return String(t || "Bust").replace(/\s+/g, ""); }

  function fmtMflDate(ts) {
    if (!ts) return "";
    var n = Number(ts);
    if (!isFinite(n)) return String(ts);
    try { return new Date(n * 1000).toLocaleDateString(); } catch (e) { return String(ts); }
  }

  // POS combination — mirrors rookie hub's POS_COMBINED. Falls back to raw.
  function posCombined(pos) {
    var p = String(pos || "").toUpperCase();
    if (p === "DT" || p === "DE" || p === "NT" || p === "EDGE") return "DL";
    if (p === "OLB" || p === "ILB" || p === "MLB" || p === "LB") return "LB";
    if (p === "CB" || p === "S" || p === "SS" || p === "FS" || p === "DB") return "DB";
    if (p === "PK") return "K";
    return p;
  }

  // ── Contract parsing (mirrors team_operations.js helpers) ───────────────
  function parseContractMoney(token) {
    var s = String(token || "").trim().toUpperCase();
    if (!s) return 0;
    s = s.replace(/[$,]/g, "");
    var mult = 1;
    if (/K$/.test(s)) { mult = 1000; s = s.slice(0, -1); }
    else if (/M$/.test(s)) { mult = 1000000; s = s.slice(0, -1); }
    var n = Number(s);
    return isFinite(n) ? Math.round(n * mult) : 0;
  }
  function parseContractInfo(info) {
    var s = String(info || "");
    var out = { tcv: 0, length: 0, yearVals: {}, aav: 0, gtd: 0 };
    if (!s) return out;
    var m;
    if ((m = s.match(/(?:^|\|)\s*TCV\s+([^|]+)/i))) out.tcv = parseContractMoney(m[1]);
    if ((m = s.match(/(?:^|\|)\s*CL\s*:?\s*(\d+)/i))) out.length = parseInt(m[1], 10) || 0;
    if ((m = s.match(/(?:^|\|)\s*AAV\s+([^|]+)/i))) out.aav = parseContractMoney(m[1]);
    if ((m = s.match(/(?:^|\|)\s*GTD\s*:?\s*([^|]+)/i))) out.gtd = parseContractMoney(m[1]);
    var yearRe = /(?:^|\|)\s*Y(\d+)\s*[=:]\s*([^|]+)/gi;
    while ((m = yearRe.exec(s))) {
      var idx = parseInt(m[1], 10);
      if (idx > 0) out.yearVals[idx] = parseContractMoney(m[2]);
    }
    return out;
  }
  function yearsRemain(sal, info) {
    info = info || parseContractInfo(sal && sal.contractInfo);
    var cy = parseInt(sal && sal.contractYear, 10) || 0;
    var len = info.length;
    if (len > 0 && cy > 0) return Math.max(0, len - cy + 1);
    if (len > 0) return len;
    return 0;
  }
  function earnedToDate(sal, info) {
    info = info || parseContractInfo(sal && sal.contractInfo);
    var cy = parseInt(sal && sal.contractYear, 10) || 1;
    var earned = 0;
    for (var i = 1; i < cy; i++) {
      earned += info.yearVals[i] || 0;
    }
    return earned;
  }
  // Era-aware cap penalty. Modern formula (2019+): (TCV × 75%) − Earned.
  // Pre-2019: cap hits were materially smaller than the modern guarantee
  // (per project memory + league_context_v1.md). Without a fully codified
  // pre-2019 formula in league_context, we explicitly DO NOT compute a
  // penalty for historical seasons here — show "—" so a bad number can't
  // leak into the UI. Current-season + 2019+ uses modern formula.
  function dropPenalty(sal, info, season) {
    info = info || parseContractInfo(sal && sal.contractInfo);
    var tcv = info.tcv;
    if (!tcv) return null;
    var seasonNum = Number(season) || (new Date().getFullYear());
    if (seasonNum < 2019) return null;  // pre-2019 era: unknown, suppress
    var earned = earnedToDate(sal, info);
    return Math.max(0, Math.round(tcv * 0.75) - earned);
  }
  function findAcquisition(pid, transactions, viewerFranchiseId) {
    var pidStr = String(pid);
    var txns = (transactions && transactions.transactions && asArr(transactions.transactions.transaction)) || [];
    var fid = String(viewerFranchiseId || "");
    var found = null;
    txns.forEach(function (t) {
      var tf = String(t.franchise || "").replace(/\D/g, "");
      while (tf.length < 4) tf = "0" + tf;
      tf = tf.slice(-4);
      if (fid && tf !== fid) return;
      var typ = safeStr(t.type).toUpperCase();
      var hits = [t.transaction, t.added, t.player_added, t.promoted, t.activated, t.demoted];
      for (var i = 0; i < hits.length; i++) {
        var raw = safeStr(hits[i]);
        if (!raw) continue;
        if (raw.indexOf(pidStr) === -1) continue;
        var ts = Number(t.timestamp) || 0;
        if (!found || ts > found.ts) {
          found = {
            ts: ts,
            type: typ,
            method: typ.replace(/_/g, " ").toLowerCase().replace(/\b\w/g, function (c) { return c.toUpperCase(); })
          };
        }
        break;
      }
    });
    return found;
  }

  // ── CSS injection ────────────────────────────────────────────────────────
  // Inline + scoped to .upm-overlay so we don't fight either host's CSS.
  // Pulled from rookie_draft_hub.css's .profile-* and .upm-* blocks; kept
  // identical in spirit. Color tokens are inlined (the hubs may not define
  // matching --var names).
  var CSS = [
    '.upm-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.96); display: none; align-items: center; justify-content: center; z-index: 10000; }',
    '.upm-overlay.open { display: flex; }',
    '.upm-modal { background: #141a26; color: #e8edf5; border: 1px solid #2a3446; border-radius: 8px; padding: 20px; max-width: 900px; width: 92%; max-height: 92vh; overflow: auto; box-shadow: 0 20px 60px rgba(0,0,0,0.7); font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; font-size: 13px; line-height: 1.45; }',
    '.upm-modal h3 { margin: 0 0 12px; font-size: 18px; font-weight: 600; }',
    '.upm-modal h4 { margin: 0 0 8px; font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px; color: #8a97ad; }',
    '.upm-modal .small { font-size: 11px; }',
    '.upm-modal .muted { color: #8a97ad; }',
    '.upm-modal .actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 14px; }',
    '.upm-modal .btn { background: #5b8dff; color: white; border: 0; border-radius: 4px; padding: 7px 14px; font-size: 13px; cursor: pointer; }',
    '.upm-modal .btn.secondary { background: #2a3446; color: #e8edf5; }',
    '.upm-modal .btn:hover { filter: brightness(1.15); }',
    '.upm-modal code { background: #1a2230; padding: 1px 4px; border-radius: 3px; font-size: 11px; }',
    '.upm-modal table.rdh-table { width: 100%; border-collapse: collapse; font-size: 12px; }',
    '.upm-modal table.rdh-table th, .upm-modal table.rdh-table td { padding: 6px 8px; border-bottom: 1px solid #2a3446; text-align: left; }',
    '.upm-modal table.rdh-table th { color: #8a97ad; font-weight: 500; background: #1a2230; font-size: 11px; text-transform: uppercase; letter-spacing: 0.3px; }',
    '.upm-modal table.rdh-table .num { text-align: right; font-variant-numeric: tabular-nums; }',
    '.upm-modal .profile-bio { display: grid; grid-template-columns: auto 1fr; gap: 14px; margin-bottom: 14px; }',
    '.upm-modal .profile-photo { width: 110px; height: 110px; border-radius: 6px; object-fit: cover; background: #1a2230; }',
    '.upm-modal .profile-photo-placeholder { width: 110px; height: 110px; border-radius: 6px; background: #1a2230; }',
    '.upm-modal .profile-bio-text { font-size: 12px; line-height: 1.9; }',
    '.upm-modal .profile-bio-text .lbl { color: #8a97ad; display: inline-block; width: 80px; }',
    '.upm-modal .profile-block { margin-top: 14px; padding-top: 12px; border-top: 1px solid #2a3446; }',
    '.upm-modal .profile-kv { font-size: 12px; line-height: 1.8; }',
    '.upm-modal .profile-kv .lbl { color: #8a97ad; display: inline-block; width: 90px; }',
    '.upm-modal .upm-view-switch { display: flex; gap: 2px; margin: 10px 0 12px; border-bottom: 1px solid #2a3446; overflow-x: auto; }',
    '.upm-modal .upm-view-switch button { background: transparent; border: 0; color: #8a97ad; padding: 8px 14px; font-size: 12px; font-weight: 600; letter-spacing: 0.4px; text-transform: uppercase; cursor: pointer; border-bottom: 2px solid transparent; margin-bottom: -1px; }',
    '.upm-modal .upm-view-switch button:hover { color: #e8edf5; }',
    '.upm-modal .upm-view-switch button[aria-selected="true"] { color: #5b8dff; border-bottom-color: #5b8dff; }',
    '.upm-modal .upm-tab-panel[hidden] { display: none !important; }',
    '.upm-modal .upm-salary-strip { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 8px; margin-bottom: 14px; }',
    '.upm-modal .upm-salary-card { padding: 10px 12px; background: #1a2230; border-radius: 6px; border: 1px solid #2a3446; }',
    '.upm-modal .upm-salary-card .lbl { font-size: 10px; color: #8a97ad; text-transform: uppercase; letter-spacing: 0.3px; display: block; margin-bottom: 4px; }',
    '.upm-modal .upm-salary-card .val { font-size: 16px; font-weight: 700; color: #e8edf5; }',
    '.upm-modal .profile-watch-links { display: flex; gap: 8px; flex-wrap: wrap; margin: 6px 0; }',
    '.upm-modal .profile-watch-link { display: inline-block; padding: 6px 12px; background: #1a2230; border: 1px solid #2a3446; border-radius: 4px; color: #e8edf5; text-decoration: none; font-size: 12px; }',
    '.upm-modal .profile-watch-link:hover { background: #2a3446; }',
    '.upm-modal .tier { display: inline-block; padding: 2px 8px; border-radius: 3px; font-size: 11px; font-weight: 600; }',
    '.upm-modal .tier.Smash { background: rgba(16,185,129,0.15); color: #10b981; }',
    '.upm-modal .tier.Hit { background: rgba(59,130,246,0.15); color: #3b82f6; }',
    '.upm-modal .tier.Contrib { background: rgba(234,179,8,0.15); color: #eab308; }',
    '.upm-modal .tier.Bust { background: rgba(239,68,68,0.15); color: #ef4444; }',
    '.upm-modal .upm-pre-rookie-banner { background: rgba(91,141,255,0.10); border-left: 3px solid #5b8dff; padding: 10px 14px; border-radius: 4px; margin-bottom: 14px; }',
    '.upm-modal .upm-pre-rookie-banner .hdr { font-size: 11px; color: #5b8dff; text-transform: uppercase; letter-spacing: 0.5px; font-weight: 700; }',
    '.upm-modal .upm-close { position: absolute; top: 12px; right: 12px; background: transparent; border: 0; color: #8a97ad; font-size: 22px; line-height: 1; cursor: pointer; padding: 4px 10px; }',
    '.upm-modal .upm-close:hover { color: #e8edf5; }',
    '.upm-modal-wrap { position: relative; }',
    '@media (max-width: 600px) { .upm-modal { padding: 14px; width: 96%; max-height: 96vh; } .upm-modal .upm-salary-strip { grid-template-columns: repeat(2, 1fr); } .upm-modal .profile-bio { grid-template-columns: 1fr; } }'
  ].join("\n");

  function ensureStyles() {
    if (document.getElementById("upm-master-styles")) return;
    var s = document.createElement("style");
    s.id = "upm-master-styles";
    s.type = "text/css";
    s.appendChild(document.createTextNode(CSS));
    (document.head || document.documentElement).appendChild(s);
  }

  function ensureOverlay() {
    var ov = document.getElementById("upm-overlay");
    if (ov) return ov;
    ov = document.createElement("div");
    ov.id = "upm-overlay";
    ov.className = "upm-overlay";
    ov.innerHTML = '<div class="upm-modal-wrap"><div class="upm-modal" id="upm-modal-body"></div></div>';
    document.body.appendChild(ov);
    ov.addEventListener("click", function (e) {
      if (e.target === ov) closeModal();
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") closeModal();
    });
    return ov;
  }

  function openModalHtml(html) {
    ensureStyles();
    var ov = ensureOverlay();
    var body = document.getElementById("upm-modal-body");
    body.innerHTML = '<button class="upm-close" aria-label="Close">×</button>' + html;
    ov.classList.add("open");
    var closeBtn = body.querySelector(".upm-close");
    if (closeBtn) closeBtn.addEventListener("click", closeModal);
    try { window.scrollTo(0, 0); } catch (e) {}
    try {
      if (window.parent && window.parent !== window) {
        window.parent.postMessage({ type: "draft-hub-modal-open" }, "*");
      }
    } catch (e) {}
    return body;
  }
  function closeModal() {
    var ov = document.getElementById("upm-overlay");
    if (ov) ov.classList.remove("open");
  }

  // ── Bundle fetch (cached) ───────────────────────────────────────────────
  function fetchBundle(pid, ctx) {
    var key = String(pid) + "|" + (ctx.leagueId || "") + "|" + (ctx.year || "");
    if (BUNDLE_CACHE[key]) return Promise.resolve(BUNDLE_CACHE[key]);
    var apiBase = (ctx.apiBase || "").replace(/\/+$/, "");
    var qs = "pid=" + encodeURIComponent(pid)
      + (ctx.leagueId ? "&L=" + encodeURIComponent(ctx.leagueId) : "")
      + (ctx.year ? "&YEAR=" + encodeURIComponent(ctx.year) : "");
    var url = apiBase + "/api/player-bundle?" + qs;
    return fetch(url, { cache: "no-store" })
      .then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      })
      .then(function (data) {
        BUNDLE_CACHE[key] = data || {};
        return BUNDLE_CACHE[key];
      })
      .catch(function () {
        BUNDLE_CACHE[key] = {};
        return BUNDLE_CACHE[key];
      });
  }

  // ── College / Pre-NFL Prospect gate ─────────────────────────────────────
  // Show college + Pre-NFL Prospect panels ONLY when:
  //   • MFL rookie tag is true (is_rookie === "1" or draft_year == current_year), AND
  //   • today is BEFORE the NFL Week 1 kickoff date.
  function showCollegePanels(pp, ctx) {
    var currentYear = String(ctx.year || ctx.currentYear || new Date().getFullYear());
    var draftYear = String(pp.draft_year || pp.year_drafted || "");
    var isRookieTag = String(pp.is_rookie || "") === "1" || draftYear === currentYear;
    if (!isRookieTag) return false;
    var week1 = ctx.nflWeek1Date || DEFAULT_NFL_WEEK1;
    try {
      var today = new Date();
      var w1 = new Date(week1 + "T00:00:00Z");
      return today.getTime() < w1.getTime();
    } catch (e) { return true; }  // permissive on parse fail
  }

  // ── Build photo fallback chain ──────────────────────────────────────────
  function buildPhotoChain(pid, pp, prospectRow) {
    var espnId = (prospectRow && prospectRow.espn_id) || pp.espn_id || null;
    var chain = [];
    if (pp.icon_url) chain.push(pp.icon_url);
    if (espnId) {
      chain.push("https://a.espncdn.com/i/headshots/college-football/players/full/" + espnId + ".png");
      chain.push("https://a.espncdn.com/i/headshots/nfl/players/full/" + espnId + ".png");
    }
    if (pid) chain.push("https://www48.myfantasyleague.com/player_photos_2014/" + pid + "_thumb.jpg");
    return chain;
  }

  function photoOnErrorAttr(chain) {
    if (!chain.length || chain.length === 1) {
      return "this.replaceWith(Object.assign(document.createElement('div'), {className: 'profile-photo-placeholder'}))";
    }
    var json = JSON.stringify(chain).replace(/"/g, "&quot;");
    return "(function(img,urls){var i=0;img.onerror=function(){i++;if(i<urls.length){img.src=urls[i];}else{img.replaceWith(Object.assign(document.createElement('div'),{className:'profile-photo-placeholder'}));}};})(this, " + json + ")";
  }

  // ── Bio tab ─────────────────────────────────────────────────────────────
  function renderBio(bundle, ctx, pid, name) {
    var pp = (bundle.profile && bundle.profile.playerProfile && bundle.profile.playerProfile.player)
          || (bundle.profile && bundle.profile.player)
          || {};
    var cr = bundle.current_roster || {};
    var inj = bundle.injury || ctx.injury || {};
    var add = bundle.last_add || {};
    var ch = Array.isArray(bundle.contract_history) ? bundle.contract_history : [];

    var prospectRow = {};
    if (ctx.prospects) {
      var arr = ctx.prospects.prospects || ctx.prospects;
      if (Array.isArray(arr)) {
        for (var i = 0; i < arr.length; i++) {
          if (String(arr[i].player_id) === String(pid)) { prospectRow = arr[i]; break; }
        }
      }
    }

    var showCollege = showCollegePanels(pp, ctx);

    var bioHeight = pp.height || (showCollege ? prospectRow.height : "") || "";
    var bioWeight = pp.weight || (showCollege && prospectRow.weight ? prospectRow.weight + " lb" : "") || "";
    var bioCollege = showCollege ? (pp.college || prospectRow.college || "") : "";
    var bioBornStr = pp.birthdate
      ? fmtMflDate(pp.birthdate)
      : (showCollege && prospectRow.age ? "~" + prospectRow.age + " years old" : "");
    var bioDraft = pp.draft_year
      ? (pp.draft_year
        + (pp.draft_team ? " · " + pp.draft_team : "")
        + (pp.draft_round ? " · R" + pp.draft_round + ", P" + (pp.draft_pick || "?") : ""))
      : (showCollege ? (prospectRow.nfl_draft_summary || "") : "");
    var bioJersey = pp.jersey || "";

    var photoChain = buildPhotoChain(pid, pp, prospectRow);
    var photoUrl = photoChain[0] || "";
    var photoErr = photoOnErrorAttr(photoChain);

    var career = bundle.career_summary || [];
    var isFreshRookie = showCollege && !career.length;

    // ── Pre-NFL prospect banner (gated by showCollege) ────────────────────
    var freshBanner = "";
    if (isFreshRookie && (prospectRow.player_id || prospectRow.consensus_rank || prospectRow.nfl_draft_summary)) {
      var srcRanks = prospectRow.source_ranks || {};
      var srcStr = "";
      if (srcRanks.mfl_rookie != null) srcStr += "MFL #" + srcRanks.mfl_rookie;
      if (srcRanks.fantasycalc != null) srcStr += (srcStr ? " · " : "") + "FC #" + srcRanks.fantasycalc;
      if (srcRanks.ktc != null) srcStr += (srcStr ? " · " : "") + "KTC #" + srcRanks.ktc;
      if (srcRanks.sleeper != null) srcStr += (srcStr ? " · " : "") + "SLP #" + srcRanks.sleeper;
      freshBanner = '<div class="upm-pre-rookie-banner">'
        + '<div class="hdr">' + escapeHtml(ctx.year || new Date().getFullYear()) + ' Rookie Class · Pre-NFL prospect</div>'
        + '<div style="font-size:13px; margin-top:4px; line-height:1.5;">'
        + (prospectRow.is_udfa ? "UDFA — undrafted free agent" : escapeHtml(prospectRow.nfl_draft_summary || "Draft details TBD"))
        + (prospectRow.nfl_team ? " · signed with <strong>" + escapeHtml(prospectRow.nfl_team) + "</strong>" : "")
        + '</div>'
        + (prospectRow.consensus_rank ? ('<div class="small muted" style="margin-top:6px;">'
            + 'UPS rookie consensus rank <strong style="color:#e8edf5;">#' + prospectRow.consensus_rank + '</strong>'
            + (prospectRow.consensus_n_sources ? ' <span style="opacity:0.7;">across ' + prospectRow.consensus_n_sources + ' sources</span>' : "")
            + (srcStr ? ' <span style="opacity:0.8; margin-left:8px;">' + srcStr + '</span>' : "")
            + '</div>') : "")
        + '</div>';
    }

    // Bio header (photo + key facts)
    var bioRows = [];
    if (bioHeight) bioRows.push('<div><span class="lbl">Height</span>' + escapeHtml(bioHeight) + '</div>');
    if (bioWeight) bioRows.push('<div><span class="lbl">Weight</span>' + escapeHtml(String(bioWeight)) + '</div>');
    if (bioCollege) bioRows.push('<div><span class="lbl">College</span>' + escapeHtml(bioCollege) + '</div>');
    if (bioBornStr) bioRows.push('<div><span class="lbl">' + (pp.birthdate ? "Born" : "Age") + '</span>' + escapeHtml(bioBornStr) + '</div>');
    if (bioDraft) bioRows.push('<div><span class="lbl">NFL Draft</span>' + escapeHtml(bioDraft) + '</div>');
    if (bioJersey) bioRows.push('<div><span class="lbl">Jersey</span>#' + escapeHtml(bioJersey) + '</div>');
    if (showCollege && prospectRow.espn_id) {
      bioRows.push('<div><span class="lbl">ESPN ID</span><a href="https://www.espn.com/college-football/player/_/id/'
        + escapeHtml(prospectRow.espn_id) + '" target="_blank" rel="noopener" style="color:#5b8dff;">'
        + escapeHtml(prospectRow.espn_id) + '</a></div>');
    }

    var bioHeadHtml = '<div class="profile-bio">'
      + (photoUrl
        ? '<img src="' + escapeHtml(photoUrl) + '" alt="' + escapeHtml(name) + '" class="profile-photo" onerror="' + photoErr + '">'
        : '<div class="profile-photo-placeholder"></div>')
      + '<div class="profile-bio-text">' + bioRows.join("") + '</div>'
      + '</div>';

    // ── Highlights link ───────────────────────────────────────────────────
    var ytLink = "";
    var teamForLink = (pp.team || prospectRow.nfl_team || "");
    var nameQ = encodeURIComponent;
    if (isFreshRookie && bioCollege) {
      ytLink = '<div class="profile-block"><div class="profile-watch-links"><a href="https://www.youtube.com/results?search_query='
        + nameQ(name + " " + bioCollege + " highlights") + '" target="_blank" rel="noopener noreferrer" class="profile-watch-link">College highlights</a></div></div>';
    } else if (teamForLink && teamForLink !== "FA") {
      ytLink = '<div class="profile-block"><div class="profile-watch-links"><a href="https://www.youtube.com/results?search_query='
        + nameQ(name + " " + teamForLink + " highlights") + '" target="_blank" rel="noopener noreferrer" class="profile-watch-link">NFL highlights</a></div></div>';
    }

    // ── Cap-math strip (Front Office + Rookie Draft both — uses MFL salary
    //    when ctx supplies it, otherwise current_contract from D1) ─────────
    var capHtml = "";
    var sal = ctx.contractSalary || null;
    var contractInfo = sal ? parseContractInfo(sal.contractInfo) : null;
    var currentContract = ch[0] || null;

    // Compute the 8-card cap strip. Prefer ctx (live MFL salary) for
    // Front Office; fall back to D1 contract_history.
    var tcv = 0, aav = 0, salary = 0, yrsRem = 0, earned = 0, penalty = null;
    var acqDate = "", acqMethod = "";
    if (contractInfo) {
      tcv = contractInfo.tcv || (function () {
        var s = 0; for (var k in contractInfo.yearVals) s += contractInfo.yearVals[k] || 0; return s;
      })();
      aav = contractInfo.aav || (contractInfo.length > 0 ? Math.round(tcv / contractInfo.length) : Number(sal.salary || 0));
      salary = Number(sal.salary || 0);
      yrsRem = yearsRemain(sal, contractInfo);
      earned = earnedToDate(sal, contractInfo);
      penalty = dropPenalty(sal, contractInfo, ctx.year);
      var acq = findAcquisition(pid, ctx.transactions, ctx.viewerFranchise && ctx.viewerFranchise.id);
      if (acq) {
        acqDate = acq.ts ? new Date(acq.ts * 1000).toLocaleDateString() : "";
        acqMethod = acq.method || "";
      }
    } else if (currentContract) {
      tcv = currentContract.tcv || 0;
      aav = currentContract.aav || 0;
      var len = currentContract.contract_length || 0;
      var cy = currentContract.contract_year || 1;
      yrsRem = len ? Math.max(0, len - cy + 1) : 0;
    }
    if (tcv || aav || salary || currentContract) {
      capHtml = '<div class="upm-salary-strip">'
        + '<div class="upm-salary-card"><span class="lbl">TCV</span><span class="val">' + (tcv ? fmtUsdFull(tcv) : "—") + '</span></div>'
        + '<div class="upm-salary-card"><span class="lbl">AAV</span><span class="val">' + (aav ? fmtUsdFull(aav) : "—") + '</span></div>'
        + (sal
          ? '<div class="upm-salary-card"><span class="lbl">Salary</span><span class="val">' + (salary ? fmtUsdFull(salary) : "—") + '</span></div>'
          : "")
        + '<div class="upm-salary-card"><span class="lbl">Yrs Remain</span><span class="val">' + (yrsRem > 0 ? yrsRem : "—") + '</span></div>'
        + (sal
          ? ('<div class="upm-salary-card"><span class="lbl">Earned to Date</span><span class="val">' + (earned > 0 ? fmtUsdFull(earned) : "$0") + '</span></div>'
             + '<div class="upm-salary-card"><span class="lbl">Cap Penalty</span><span class="val">' + (penalty == null ? "—" : (penalty > 0 ? fmtUsdFull(penalty) : "$0")) + '</span></div>'
             + '<div class="upm-salary-card"><span class="lbl">Acquire Date</span><span class="val" style="font-size:13px;">' + (acqDate ? escapeHtml(acqDate) : "—") + '</span></div>'
             + '<div class="upm-salary-card"><span class="lbl">How Acquired</span><span class="val" style="font-size:13px;">' + (acqMethod ? escapeHtml(acqMethod) : "—") + '</span></div>')
          : (currentContract
            ? ('<div class="upm-salary-card"><span class="lbl">Contract</span><span class="val" style="font-size:13px;">'
              + escapeHtml(currentContract.contract_status || (currentContract.extension_flag ? "Extended" : "Active"))
              + '</span></div>')
            : ""))
        + '</div>';
    }

    // ── League status block ───────────────────────────────────────────────
    var hist = {};
    if (ctx.history && Array.isArray(ctx.history.picks)) {
      for (var j = 0; j < ctx.history.picks.length; j++) {
        if (String(ctx.history.picks[j].player_id) === String(pid)) { hist = ctx.history.picks[j]; break; }
      }
    }
    var hasMeaningfulStatus = bundle.is_free_agent || bundle.is_not_rostered || cr.team_name;
    var hasInjury = inj.status && !bundle.is_free_agent && !bundle.is_not_rostered;
    var hasAcq = !bundle.is_free_agent && !bundle.is_not_rostered && add.datetime_et;
    var hasMeaningfulTier = hist.tier && hist.tier !== "Unclassified";
    var leagueStatusHtml = "";
    if (hasMeaningfulStatus || hasInjury || hasAcq || hasMeaningfulTier) {
      var rows = [];
      if (bundle.is_free_agent) {
        rows.push('<div><span class="lbl">Status</span><span style="color:#fbbf24;font-weight:600">Free Agent</span></div>');
      } else if (bundle.is_not_rostered) {
        rows.push('<div><span class="lbl">Status</span><span class="muted" style="font-weight:600">Not on any roster</span></div>');
      } else if (cr.team_name) {
        rows.push('<div><span class="lbl">Owner</span>' + escapeHtml(cr.team_name) + '</div>');
        if (cr.status) rows.push('<div><span class="lbl">Roster</span>' + escapeHtml(cr.status) + '</div>');
      }
      if (hasInjury) {
        rows.push('<div><span class="lbl">Injury</span><span style="color:#fbbf24">' + escapeHtml(inj.status)
          + (inj.details ? " — " + escapeHtml(inj.details) : "") + '</span></div>');
      }
      if (hasAcq) {
        rows.push('<div><span class="lbl">Acquired</span>' + escapeHtml(add.method || "")
          + (add.salary ? " $" + Number(add.salary).toLocaleString() : "")
          + " · " + escapeHtml(add.datetime_et.slice(0, 10))
          + " by " + escapeHtml(add.franchise_name || "") + '</div>');
      }
      if (hasMeaningfulTier) {
        rows.push('<div><span class="lbl">Hub Tier</span><span class="tier ' + tierSlug(hist.tier) + '">' + escapeHtml(hist.tier) + '</span>'
          + (hist.best_ep_rate != null ? " · Best E+P " + (hist.best_ep_rate * 100).toFixed(0) + "%" : "")
          + '</div>');
      }
      leagueStatusHtml = '<div class="profile-block"><h4>League Status</h4><div class="profile-kv">' + rows.join("") + '</div></div>';
    }

    // ── Contract history table (D1 contract_history) ──────────────────────
    var contractHistoryHtml = "";
    if (ch.length) {
      var rows2 = ch.map(function (c) {
        var extBadge = c.extension_flag ? ' <span class="small" style="color:#5b8dff;font-weight:600;">EXT</span>' : "";
        var aavCell = (c.aav == null || c.aav === 0) ? "—" : "$" + Number(c.aav).toLocaleString();
        return '<tr>'
          + '<td>' + escapeHtml(String(c.season)) + '</td>'
          + '<td>' + escapeHtml(c.team_name || "") + extBadge + '</td>'
          + '<td class="num">' + (c.contract_length || "—") + '</td>'
          + '<td>' + (c.contract_year ? "Y" + c.contract_year : "—") + '</td>'
          + '<td class="num">' + aavCell + '</td>'
          + '</tr>';
      }).join("");
      contractHistoryHtml = '<div class="profile-block">'
        + '<h4>Contract History <span class="small muted">(' + ch.length + ' season' + (ch.length === 1 ? "" : "s") + ')</span></h4>'
        + '<table class="rdh-table" style="margin-top:6px;"><thead><tr>'
        + '<th>Yr</th><th>Team</th><th class="num">Len</th><th>Yr#</th><th class="num">AAV</th>'
        + '</tr></thead><tbody>' + rows2 + '</tbody></table></div>';
    }

    // ── Pre-NFL prospect details (gated) ──────────────────────────────────
    var prospectPanelHtml = "";
    if (isFreshRookie) {
      var facts = [];
      var draftSummary = prospectRow.nfl_draft_summary
        || (pp.draft_round && pp.draft_pick ? "R" + pp.draft_round + "." + pp.draft_pick + (pp.draft_team ? " · " + pp.draft_team : "") : "")
        || (pp.team && pp.draft_year ? "UDFA · " + pp.team : "");
      if (draftSummary) facts.push('<div><span class="lbl">' + (prospectRow.is_udfa ? "Status" : "NFL Draft") + '</span><strong style="color:' + (prospectRow.is_udfa ? "#8a97ad" : "#4ade80") + '">' + escapeHtml(draftSummary) + '</strong></div>');
      if (prospectRow.college || pp.college) facts.push('<div><span class="lbl">College</span>' + escapeHtml(prospectRow.college || pp.college) + '</div>');
      if (prospectRow.age) facts.push('<div><span class="lbl">Age</span>' + prospectRow.age + '</div>');
      if (prospectRow.height || pp.height) facts.push('<div><span class="lbl">Height</span>' + escapeHtml(String(prospectRow.height || pp.height)) + '</div>');
      if (prospectRow.weight || pp.weight) facts.push('<div><span class="lbl">Weight</span>' + escapeHtml(String(prospectRow.weight || pp.weight)) + (typeof (prospectRow.weight || pp.weight) === "number" ? " lbs" : "") + '</div>');
      var adpLine = prospectRow.rookie_adp != null
        ? '<div class="small muted" style="margin-top:6px;">UPS rookie ADP <strong>' + prospectRow.rookie_adp.toFixed(1) + '</strong>'
          + (prospectRow.rookie_adp_rank ? " (#" + prospectRow.rookie_adp_rank + ")" : "")
          + ' across ' + (prospectRow.rookie_adp_n_drafts || "—") + ' mocks</div>'
        : "";
      if (facts.length) {
        prospectPanelHtml = '<div class="profile-block">'
          + '<h4>Pre-NFL Prospect — ' + escapeHtml(String(ctx.year || new Date().getFullYear())) + ' Rookie Class</h4>'
          + '<div class="profile-kv" style="display:grid; grid-template-columns:repeat(auto-fit, minmax(180px, 1fr)); gap:8px;">'
          + facts.join("\n") + '</div>'
          + adpLine + '</div>';
      }
    }

    return freshBanner + bioHeadHtml + ytLink + capHtml + leagueStatusHtml + contractHistoryHtml + prospectPanelHtml;
  }

  // ── Stats tab ────────────────────────────────────────────────────────────
  function renderStats(bundle, ctx) {
    var career = bundle.career_summary || [];
    var leverageCoefs = ctx.leverageCoefs || bundle.leverage_coefs || {};
    if (!career.length) {
      return '<p class="small muted">No career data yet — this player has no scored weeks on record.</p>';
    }
    var rows = career.slice(0, 20);
    var tot = { g: 0, starts: 0, pts: 0, wcn: 0, ep_den: 0, dud_num: 0, el_num: 0, pl_num: 0 };
    rows.forEach(function (c) {
      tot.g += (c.games_played || 0);
      tot.starts += (c.mfl_starts || 0);
      tot.pts += (c.season_points || 0);
      var wcb = leverageCoefs[c.pos_group] || 0;
      tot.wcn += (c.win_chunks || 0) * wcb;
      if (c.ep_pct != null) tot.ep_den += c.games_played;
      if (c.dud_pct != null) tot.dud_num += c.dud_pct * c.games_played;
      if (c.elite_pct != null) tot.el_num += c.elite_pct * c.games_played;
      if (c.plus_pct != null) tot.pl_num += c.plus_pct * c.games_played;
    });
    var careerPPG = tot.g ? tot.pts / tot.g : 0;
    var careerEl = tot.ep_den ? tot.el_num / tot.ep_den : 0;
    var careerPl = tot.ep_den ? tot.pl_num / tot.ep_den : 0;
    var careerDud = tot.ep_den ? tot.dud_num / tot.ep_den : 0;
    var fmtRank = function (r) { return (r == null || r <= 0) ? "—" : "#" + r; };
    var bodyRows = rows.map(function (c) {
      var wcb = leverageCoefs[c.pos_group] || 0;
      var apw = (c.win_chunks || 0) * wcb;
      var games = Math.max(1, c.games_played || 0);
      var apwPerG = apw / games;
      return '<tr>'
        + '<td>' + escapeHtml(String(c.season)) + '</td>'
        + '<td class="num">' + (c.games_played || 0) + '</td>'
        + '<td class="num">' + (c.mfl_starts || 0) + '</td>'
        + '<td class="num">' + (c.season_points != null ? c.season_points.toFixed(0) : "—") + '</td>'
        + '<td class="num muted">' + fmtRank(c.pos_rank) + '</td>'
        + '<td class="num">' + (c.avg_ppg != null ? c.avg_ppg.toFixed(1) : "—") + '</td>'
        + '<td class="num muted">' + fmtRank(c.pos_ppg_rank) + '</td>'
        + '<td class="num" style="color:#10b981">' + (c.elite_pct != null ? c.elite_pct.toFixed(0) + "%" : "—") + '</td>'
        + '<td class="num" style="color:#3b82f6">' + (c.plus_pct != null ? c.plus_pct.toFixed(0) + "%" : "—") + '</td>'
        + '<td class="num" style="color:#ef4444">' + (c.dud_pct != null ? c.dud_pct.toFixed(0) + "%" : "—") + '</td>'
        + '<td class="num"><strong>' + apw.toFixed(1) + '</strong></td>'
        + '<td class="num muted">' + fmtRank(c.wc_pos_rank) + '</td>'
        + '<td class="num">' + apwPerG.toFixed(2) + '</td>'
        + '<td class="num muted">' + fmtRank(c.wc_per_game_pos_rank) + '</td>'
        + '</tr>';
    }).join("");
    return '<div class="profile-block"><h4>Career Summary (by MFL season)</h4>'
      + '<table class="rdh-table"><thead><tr>'
      + '<th>Yr</th>'
      + '<th class="num">G</th>'
      + '<th class="num">MFL Starts</th>'
      + '<th class="num">Pts</th>'
      + '<th class="num">Pts Rk</th>'
      + '<th class="num">PPG</th>'
      + '<th class="num">PPG Rk</th>'
      + '<th class="num">Elite%</th>'
      + '<th class="num">Plus%</th>'
      + '<th class="num">Dud%</th>'
      + '<th class="num" title="Adjusted All-Play Wins = win_chunks × positional leverage β">APW</th>'
      + '<th class="num">APW Rk</th>'
      + '<th class="num">APW/G</th>'
      + '<th class="num">APW/G Rk</th>'
      + '</tr></thead><tbody>'
      + bodyRows
      + '<tr style="border-top:2px solid #2a3446; font-weight:700;">'
      + '<td>Career</td>'
      + '<td class="num">' + tot.g + '</td>'
      + '<td class="num">' + tot.starts + '</td>'
      + '<td class="num">' + tot.pts.toFixed(0) + '</td>'
      + '<td class="num muted">—</td>'
      + '<td class="num">' + careerPPG.toFixed(1) + '</td>'
      + '<td class="num muted">—</td>'
      + '<td class="num" style="color:#10b981">' + careerEl.toFixed(0) + '%</td>'
      + '<td class="num" style="color:#3b82f6">' + careerPl.toFixed(0) + '%</td>'
      + '<td class="num" style="color:#ef4444">' + careerDud.toFixed(0) + '%</td>'
      + '<td class="num">' + tot.wcn.toFixed(1) + '</td>'
      + '<td class="num muted">—</td>'
      + '<td class="num">' + (tot.g ? (tot.wcn / tot.g).toFixed(2) : "—") + '</td>'
      + '<td class="num muted">—</td>'
      + '</tr></tbody></table></div>';
  }

  // ── Game Log tab ─────────────────────────────────────────────────────────
  function renderGameLog(bundle) {
    var byYear = (bundle && bundle.weekly_by_season) || {};
    var years = Object.keys(byYear).sort(function (a, b) { return Number(b) - Number(a); });
    if (!years.length) {
      return '<p class="small muted">No weekly data available.</p>';
    }
    var defaultYear = years[0];
    var weeks = (byYear[defaultYear] || []).slice().sort(function (a, b) { return a.week - b.week; });
    var weekTierClass = function (t) { return t === "Elite" ? "Smash" : t === "Plus" ? "Hit" : t === "Neutral" ? "Contrib" : "Bust"; };
    var starts = weeks.filter(function (w) { return w.status === "starter"; }).length;
    var elite = weeks.filter(function (w) { return w.week_tier === "Elite"; }).length;
    var plus = weeks.filter(function (w) { return w.week_tier === "Plus"; }).length;
    var dud = weeks.filter(function (w) { return w.week_tier === "Dud"; }).length;
    var tot = weeks.length;
    var pts = weeks.reduce(function (s, w) { return s + (w.score || 0); }, 0);
    var rows = weeks.map(function (w) {
      var playoffTag = w.is_reg === 0 ? ' <span class="small" style="color:#5b8dff;font-weight:600;">P</span>' : "";
      return '<tr' + (w.is_reg === 0 ? ' style="background:rgba(255,158,77,0.06);"' : "") + '>'
        + '<td class="num">' + w.week + playoffTag + '</td>'
        + '<td class="num">' + (w.score != null ? w.score.toFixed(1) : "—") + '</td>'
        + '<td class="num">' + (w.z_score != null ? (w.z_score > 0 ? "+" : "") + w.z_score.toFixed(2) : "—") + '</td>'
        + '<td>' + (w.week_tier ? '<span class="tier ' + weekTierClass(w.week_tier) + '">' + w.week_tier + '</span>' : "—") + '</td>'
        + '<td>' + escapeHtml(w.status || "") + '</td>'
        + '<td class="small">' + escapeHtml(w.roster_franchise_name || "") + '</td>'
        + '<td class="num">' + (w.pos_rank || "—") + '</td>'
        + '</tr>';
    }).join("");

    return '<div class="profile-block"><h4>Game Log — Season ' + escapeHtml(String(defaultYear)) + '</h4>'
      + '<label style="font-size:11px; color:#8a97ad; display:inline-block; margin-bottom:8px;">Season '
      + '<select id="upm-season-select" style="margin-left:6px; background:#1a2230; color:#e8edf5; border:1px solid #2a3446; border-radius:4px; padding:3px 6px;">'
      + years.map(function (s) { return '<option value="' + s + '"' + (s === defaultYear ? " selected" : "") + '>' + s + '</option>'; }).join("")
      + '</select></label>'
      + '<div id="upm-game-log-body">'
      + (tot ? ('<div class="small muted" style="margin-bottom:6px;">'
          + tot + ' games · ' + starts + ' MFL starts · ' + pts.toFixed(1) + ' pts (' + (tot ? (pts / tot).toFixed(1) : "0.0") + ' ppg)'
          + ' · Elite ' + elite + ' · Plus ' + plus + ' · Dud ' + dud
          + '</div>'
          + '<table class="rdh-table"><thead><tr>'
          + '<th class="num">Wk</th><th class="num">Pts</th><th class="num">z</th><th>Week Tier</th><th>MFL Status</th><th>Roster</th><th class="num">Pos Rk</th>'
          + '</tr></thead><tbody>' + rows + '</tbody></table>') : '<p class="small muted">No data for this season.</p>')
      + '</div></div>';
  }

  // Hook season-select after Game Log render
  function wireGameLogControls(body, bundle) {
    var sel = body.querySelector("#upm-season-select");
    var glBody = body.querySelector("#upm-game-log-body");
    if (!sel || !glBody) return;
    var byYear = (bundle && bundle.weekly_by_season) || {};
    var weekTierClass = function (t) { return t === "Elite" ? "Smash" : t === "Plus" ? "Hit" : t === "Neutral" ? "Contrib" : "Bust"; };
    sel.addEventListener("change", function () {
      var weeks = (byYear[sel.value] || []).slice().sort(function (a, b) { return a.week - b.week; });
      if (!weeks.length) { glBody.innerHTML = '<p class="small muted">No data for this season.</p>'; return; }
      var starts = weeks.filter(function (w) { return w.status === "starter"; }).length;
      var elite = weeks.filter(function (w) { return w.week_tier === "Elite"; }).length;
      var plus = weeks.filter(function (w) { return w.week_tier === "Plus"; }).length;
      var dud = weeks.filter(function (w) { return w.week_tier === "Dud"; }).length;
      var tot = weeks.length;
      var pts = weeks.reduce(function (s, w) { return s + (w.score || 0); }, 0);
      var rows = weeks.map(function (w) {
        var playoffTag = w.is_reg === 0 ? ' <span class="small" style="color:#5b8dff;font-weight:600;">P</span>' : "";
        return '<tr' + (w.is_reg === 0 ? ' style="background:rgba(255,158,77,0.06);"' : "") + '>'
          + '<td class="num">' + w.week + playoffTag + '</td>'
          + '<td class="num">' + (w.score != null ? w.score.toFixed(1) : "—") + '</td>'
          + '<td class="num">' + (w.z_score != null ? (w.z_score > 0 ? "+" : "") + w.z_score.toFixed(2) : "—") + '</td>'
          + '<td>' + (w.week_tier ? '<span class="tier ' + weekTierClass(w.week_tier) + '">' + w.week_tier + '</span>' : "—") + '</td>'
          + '<td>' + escapeHtml(w.status || "") + '</td>'
          + '<td class="small">' + escapeHtml(w.roster_franchise_name || "") + '</td>'
          + '<td class="num">' + (w.pos_rank || "—") + '</td>'
          + '</tr>';
      }).join("");
      glBody.innerHTML = '<div class="small muted" style="margin-bottom:6px;">'
        + tot + ' games · ' + starts + ' MFL starts · ' + pts.toFixed(1) + ' pts (' + (tot ? (pts / tot).toFixed(1) : "0.0") + ' ppg)'
        + ' · Elite ' + elite + ' · Plus ' + plus + ' · Dud ' + dud
        + '</div><table class="rdh-table"><thead><tr>'
        + '<th class="num">Wk</th><th class="num">Pts</th><th class="num">z</th><th>Week Tier</th><th>MFL Status</th><th>Roster</th><th class="num">Pos Rk</th>'
        + '</tr></thead><tbody>' + rows + '</tbody></table>';
    });
  }

  // ── News tab ─────────────────────────────────────────────────────────────
  function renderNews(bundle, pid) {
    var inj = bundle.injury || {};
    var add = bundle.last_add || {};
    var trades = bundle.trade_history || [];
    var items = [];
    if (inj.status) {
      items.push('<div class="profile-block"><h4 style="color:#fbbf24">Injury · ' + escapeHtml(inj.status) + '</h4>'
        + '<div class="small muted">' + escapeHtml(inj.details || "No additional details from MFL.") + '</div></div>');
    }
    if (add.datetime_et) {
      items.push('<div class="profile-block"><h4>Last Acquired</h4><div class="small">'
        + escapeHtml(add.datetime_et.slice(0, 10)) + ' · ' + escapeHtml(add.method || "")
        + (add.salary ? " · $" + Number(add.salary).toLocaleString() : "")
        + ' by ' + escapeHtml(add.franchise_name || "") + '</div></div>');
    }
    if (trades.length) {
      items.push('<div class="profile-block"><h4>Recent Trades (' + trades.length + ')</h4><div class="small muted">'
        + trades.slice(0, 10).map(function (t) {
          return '<div>' + escapeHtml((t.datetime_et || "").slice(0, 10)) + ' · '
            + escapeHtml(t.franchise_name || "") + ' ' + escapeHtml(t.asset_role || "")
            + (t.comments ? ' — "' + escapeHtml(String(t.comments).slice(0, 80)) + '"' : "")
            + '</div>';
        }).join("") + '</div></div>');
    }
    var html = items.length ? items.join("") : '<p class="small muted">No recent news.</p>';
    html += '<p class="small muted" style="margin-top:10px; font-style:italic;">Richer player-news feed (RotoWire / ESPN) coming in v2.</p>';
    return html;
  }

  // ── Tab switching ────────────────────────────────────────────────────────
  function wireTabs(body) {
    var btns = body.querySelectorAll(".upm-view-switch button[data-upm-tab]");
    var panels = body.querySelectorAll(".upm-tab-panel[data-upm-panel]");
    for (var i = 0; i < btns.length; i++) {
      (function (btn) {
        btn.addEventListener("click", function () {
          var target = btn.getAttribute("data-upm-tab");
          for (var k = 0; k < btns.length; k++) {
            btns[k].setAttribute("aria-selected", btns[k] === btn ? "true" : "false");
          }
          for (var m = 0; m < panels.length; m++) {
            if (panels[m].getAttribute("data-upm-panel") === target) panels[m].removeAttribute("hidden");
            else panels[m].setAttribute("hidden", "");
          }
        });
      })(btns[i]);
    }
  }

  // ── Main entry point ─────────────────────────────────────────────────────
  function openPlayerProfile(pid, ctx) {
    ctx = ctx || {};
    if (!pid) return;

    // Resolve name + pos for header eagerly from ctx data
    var name = "Player #" + pid;
    var pos = "";
    var nflTeam = "";
    if (ctx.prospects) {
      var arr = ctx.prospects.prospects || ctx.prospects;
      if (Array.isArray(arr)) {
        for (var i = 0; i < arr.length; i++) {
          if (String(arr[i].player_id) === String(pid)) {
            name = arr[i].name || name;
            pos = arr[i].position || "";
            nflTeam = arr[i].nfl_team || "";
            break;
          }
        }
      }
    }
    if (ctx.history && Array.isArray(ctx.history.picks)) {
      for (var j = 0; j < ctx.history.picks.length; j++) {
        if (String(ctx.history.picks[j].player_id) === String(pid)) {
          name = ctx.history.picks[j].player_name || name;
          pos = ctx.history.picks[j].position || pos;
          break;
        }
      }
    }
    if (ctx.playerInfo) {
      name = ctx.playerInfo.name || name;
      pos = ctx.playerInfo.position || pos;
      nflTeam = ctx.playerInfo.team || nflTeam;
    }
    pos = posCombined(pos);

    // Eager render: skeleton with loading state, then fill once the bundle arrives.
    var header = '<h3>' + escapeHtml(name)
      + ' <span class="small muted" style="font-weight:400">' + escapeHtml(pos)
      + (nflTeam ? ' · ' + escapeHtml(nflTeam) : "") + '</span></h3>';
    var body = openModalHtml(header
      + '<div id="upm-profile-body"><p class="small muted" style="padding:30px; text-align:center;">Fetching profile from MFL…</p></div>'
      + '<div class="actions"><button class="btn secondary" id="upm-close-btn">Close</button></div>');

    var closeBtn = body.querySelector("#upm-close-btn");
    if (closeBtn) closeBtn.addEventListener("click", closeModal);

    fetchBundle(pid, ctx).then(function (bundle) {
      bundle = bundle || {};
      var bodyEl = document.getElementById("upm-profile-body");
      if (!bodyEl) return;  // modal closed before bundle arrived

      var bundleError = !bundle.profile && !bundle.career_summary && !bundle.contract_history && !bundle.weekly_by_season;
      var errorBanner = bundleError
        ? '<div class="small muted" style="margin-bottom:8px; padding:6px 8px; background:#1a2230; border-radius:4px;">Live MFL profile data unavailable in this view — showing local data only.</div>'
        : "";

      var bioHtml = renderBio(bundle, ctx, pid, name);
      var statsHtml = renderStats(bundle, ctx);
      var gameLogHtml = renderGameLog(bundle);
      var newsHtml = renderNews(bundle, pid);

      var pp = (bundle.profile && bundle.profile.playerProfile && bundle.profile.playerProfile.player) || {};
      var career = bundle.career_summary || [];
      var showCollege = showCollegePanels(pp, ctx);
      var isFreshRookie = showCollege && !career.length;

      // Fresh rookies: Bio-only (Stats/Game Log/News are empty noise).
      if (isFreshRookie) {
        bodyEl.innerHTML = errorBanner + bioHtml
          + '<div class="small muted" style="margin-top:10px; text-align:right;">MFL ID: ' + escapeHtml(String(pid)) + '</div>';
      } else {
        bodyEl.innerHTML = errorBanner
          + '<nav class="upm-view-switch" role="tablist">'
          + '<button type="button" role="tab" aria-selected="true"  data-upm-tab="bio">Bio</button>'
          + '<button type="button" role="tab" aria-selected="false" data-upm-tab="stats">Stats</button>'
          + '<button type="button" role="tab" aria-selected="false" data-upm-tab="gamelog">Game Log</button>'
          + '<button type="button" role="tab" aria-selected="false" data-upm-tab="news">News</button>'
          + '</nav>'
          + '<div class="upm-tab-panel" data-upm-panel="bio">' + bioHtml + '</div>'
          + '<div class="upm-tab-panel" data-upm-panel="stats" hidden>' + statsHtml + '</div>'
          + '<div class="upm-tab-panel" data-upm-panel="gamelog" hidden>' + gameLogHtml + '</div>'
          + '<div class="upm-tab-panel" data-upm-panel="news" hidden>' + newsHtml + '</div>'
          + '<div class="small muted" style="margin-top:10px; text-align:right;">MFL ID: ' + escapeHtml(String(pid)) + '</div>';
        wireTabs(bodyEl);
        wireGameLogControls(bodyEl, bundle);
      }
    }).catch(function (err) {
      var bodyEl = document.getElementById("upm-profile-body");
      if (bodyEl) {
        bodyEl.innerHTML = '<p class="small muted" style="padding:20px;">Profile lookup failed: '
          + escapeHtml(err && err.message ? err.message : String(err))
          + '<br><br>MFL ID: ' + escapeHtml(String(pid)) + '</p>';
      }
    });
  }

  // Expose
  window.UPS_openPlayerProfile = openPlayerProfile;
  window.UPS_closePlayerProfile = closeModal;
})();
