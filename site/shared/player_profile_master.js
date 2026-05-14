/* ═══════════════════════════════════════════════════════════════════════════
 * player_profile_master.js — Unified player profile modal for UPS MFL hubs
 *
 * Single source of truth for the player-profile UI. Replaces the
 * Rookie Draft Hub's showPlayerProfileCard() and Team Operations'
 * openPlayerProfileModal(). Same 4-tab layout (Bio / Stats / Game
 * Log / News), same 4-tier headshot fallback chain, same prospect-
 * board fallback for fresh rookies.
 *
 * v2.0 (2026-05-12): rewritten to be a literal port of Rookie Hub's
 * showPlayerProfileCard. Preserves the per-pos-group Raw Stats
 * templates (RB/WR/TE/IDP/QB/kicker/punter), the UPS Season / Full
 * Season scope toggle, the Stats sub-toggle (Scoring / Raw / Advanced),
 * and the Game Log Scoring/Raw views. Adds an enhanced cap-math strip
 * (TCV / AAV / Salary / Yrs Remain / Earned / Cap Penalty / Acquire
 * Date / How Acquired) on the Bio tab — era-aware (pre-2019 = "—").
 *
 * Visual style copied verbatim from rookie_draft_hub.css (.profile-*,
 * .upm-*, .rdh-table, .tier.*) — inlined so the module works
 * standalone in Front Office's iframe.
 *
 * Entry point:
 *   window.UPS_openPlayerProfile(pid, ctx)
 *
 * ctx fields:
 *   apiBase           — string, optional (Cloudflare worker base, default same-origin)
 *   leagueId, year    — strings
 *   mode              — "rookie_draft" | "front_office"
 *   prospects         — array of rookie prospect rows (rookie_draft mode)
 *   history           — { picks: [...] } (rookie_draft mode)
 *   leverageCoefs     — { QB: 0.88, ... } APW β coefficients
 *   viewerFranchise   — { id, name } (front_office mode)
 *   contractSalary    — MFL salary row for this player (front_office mode)
 *   transactions      — MFL transactions blob (front_office mode)
 *   injury            — MFL injury row for this player (front_office mode)
 *   playerInfo        — { name, position, team } (front_office mode)
 *   nflWeek1Date      — "YYYY-MM-DD" — Week 1 Thursday opener (default "2026-09-11")
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
  function fmtUsdFull(n) {
    var num = Number(n) || 0;
    return num ? "$" + num.toLocaleString() : "—";
  }
  // Compact USD — collapses thousands so contract-history rows don't
  // eat a third of the modal width. $42,000 → $42K; $1,250,000 → $1.25M.
  // Sub-$1K values stay literal so we don't lose precision on rookies.
  function fmtUsdK(n) {
    var num = Number(n) || 0;
    if (!num) return "—";
    var abs = Math.abs(num);
    if (abs >= 1000000) {
      var m = num / 1000000;
      return "$" + (m >= 10 ? m.toFixed(0) : m.toFixed(m >= 1 ? 2 : 2).replace(/\.?0+$/, "")) + "M";
    }
    if (abs >= 1000) {
      var k = num / 1000;
      // Drop trailing .0 — $42.0K reads worse than $42K.
      var kStr = k >= 100 ? k.toFixed(0) : k.toFixed(1).replace(/\.0$/, "");
      return "$" + kStr + "K";
    }
    return "$" + num.toLocaleString();
  }
  function tierSlug(t) { return String(t || "Bust").replace(/\s+/g, ""); }

  function fmtMflDate(ts) {
    if (!ts) return "";
    var n = Number(ts);
    if (!isFinite(n)) return String(ts);
    try { return new Date(n * 1000).toLocaleDateString(); } catch (e) { return String(ts); }
  }

  // POS combination — mirrors rookie hub's POS_COMBINED.
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
  // MFL's salaries-export `contractYear` field is YEARS REMAINING
  // (not years played). cy=1 means LAST year of contract; cy=0 means
  // expired. Verified 2026-05-14 by sampling 15 multi-year vets in
  // UPS L=74598 — cy ranges 0..2 for 3-yr deals, never 3. Same
  // convention as src_contracts.contract_year in D1 (already
  // documented in the D1 fallback path below).
  function yearsRemain(sal, info) {
    info = info || parseContractInfo(sal && sal.contractInfo);
    var cy = parseInt(sal && sal.contractYear, 10) || 0;
    var len = info.length;
    if (cy > 0) return cy;
    if (len > 0) return len;
    return 0;
  }
  function earnedToDate(sal, info) {
    info = info || parseContractInfo(sal && sal.contractInfo);
    var len = info.length || 0;
    var cy = parseInt(sal && sal.contractYear, 10) || 0;
    // years already played = total length minus years remaining.
    var played = Math.max(0, len - cy);
    var earned = 0;
    for (var i = 1; i <= played; i++) {
      earned += info.yearVals[i] || 0;
    }
    return earned;
  }
  // Era-aware cap penalty. Modern formula (2019+): (TCV × 75%) − Earned.
  // Pre-2019: per project memory + league_context_v1.md, cap hits are
  // materially smaller than the modern guarantee. Without a fully
  // codified pre-2019 formula we suppress the number ("—") so a
  // wrong figure can't leak into the UI.
  function dropPenalty(sal, info, season) {
    info = info || parseContractInfo(sal && sal.contractInfo);
    var tcv = info.tcv;
    if (!tcv) return null;
    var seasonNum = Number(season) || (new Date().getFullYear());
    if (seasonNum < 2019) return null;
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
  // Inlined from rookie_draft_hub.css verbatim (in spirit). Color tokens
  // hard-coded since we may run outside any host that defines --bg etc.
  // Body: 14px / line-height 1.5; profile-bio-text 12px / 1.9;
  // h3 18-22px; h4 12px UPPERCASE muted.
  var CSS = [
    /* overlay + modal shell */
    '.upm-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.96); display: none; align-items: center; justify-content: center; z-index: 10000; }',
    '.upm-overlay.open { display: flex; }',
    '.upm-modal-wrap { position: relative; }',
    '.upm-modal { background: #141a26; color: #e8edf5; border: 1px solid #2a3446; border-radius: 8px; padding: 20px; max-width: 1400px; width: 96%; max-height: 90vh; overflow-y: auto; box-shadow: 0 20px 60px rgba(0,0,0,0.7); font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; font-size: 14px; line-height: 1.5; }',
    '.upm-modal h3 { margin: 0 0 12px; font-size: 22px; font-weight: 600; }',
    '.upm-modal h4 { margin: 0 0 8px; font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px; color: #8a97ad; font-weight: 600; }',
    '.upm-modal .small { font-size: 12px; }',
    '.upm-modal .muted { color: #8a97ad; }',
    '.upm-modal .actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 14px; position: sticky; bottom: -20px; background: #141a26; padding: 10px 20px 0; margin: 14px -20px -20px; border-top: 1px solid #2a3446; }',
    '.upm-modal .btn { background: #5b8dff; color: white; border: 0; border-radius: 4px; padding: 9px 16px; font-size: 13px; cursor: pointer; }',
    '.upm-modal .btn.secondary { background: #2a3446; color: #e8edf5; }',
    '.upm-modal .btn:hover { filter: brightness(1.15); }',
    '.upm-modal code { background: #1a2230; padding: 1px 4px; border-radius: 3px; font-size: 11px; }',
    '.upm-modal a { color: #5b8dff; }',
    '.upm-close { position: absolute; top: 12px; right: 12px; background: transparent; border: 0; color: #8a97ad; font-size: 22px; line-height: 1; cursor: pointer; padding: 4px 10px; z-index: 2; }',
    '.upm-close:hover { color: #e8edf5; }',

    /* tables */
    '.upm-modal table.rdh-table { width: 100%; border-collapse: collapse; font-size: 12px; }',
    '.upm-modal table.rdh-table th, .upm-modal table.rdh-table td { padding: 8px 10px; border-bottom: 1px solid #2a3446; text-align: left; }',
    '.upm-modal table.rdh-table th { color: #8a97ad; font-weight: 500; background: #1a2230; }',
    '.upm-modal table.rdh-table .num { text-align: right; font-variant-numeric: tabular-nums; }',
    '.upm-modal table.rdh-table tbody tr:hover { background: #1a2230; }',

    /* profile bio block */
    '.upm-modal .profile-bio { display: grid; grid-template-columns: auto 1fr; gap: 14px; margin-bottom: 14px; }',
    '.upm-modal .profile-bio-actions { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 8px; }',
    '.upm-modal .profile-bio-actions button { background: #2a3446; color: #e8edf5; border: 1px solid #3a455c; border-radius: 4px; padding: 4px 10px; font-size: 11px; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; cursor: pointer; }',
    '.upm-modal .profile-bio-actions button:hover { background: #364257; }',
    '.upm-modal .profile-bio-actions button:disabled { opacity: 0.4; cursor: not-allowed; }',
    '.upm-modal .profile-bio-commish { margin-bottom: 8px; font-size: 11px; font-style: italic; opacity: 0.75; }',
    '.upm-modal .profile-photo { width: 110px; height: 110px; border-radius: 6px; object-fit: cover; background: #1a2230; }',
    '.upm-modal .profile-photo-placeholder { width: 110px; height: 110px; border-radius: 6px; background: #1a2230; }',
    '.upm-modal .profile-bio-text { font-size: 12px; line-height: 1.9; }',
    '.upm-modal .profile-bio-text .lbl { color: #8a97ad; display: inline-block; width: 80px; }',
    '.upm-modal .profile-block { margin-top: 14px; padding-top: 12px; border-top: 1px solid #2a3446; }',
    '.upm-modal .profile-block h4 { margin: 0 0 8px; }',
    '.upm-modal .profile-kv { font-size: 12px; line-height: 1.8; }',
    '.upm-modal .profile-kv .lbl { color: #8a97ad; display: inline-block; width: 90px; }',

    /* Watch links */
    '.upm-modal .profile-watch-links { display: flex; flex-wrap: wrap; gap: 6px; }',
    '.upm-modal .profile-watch-link { display: inline-flex; align-items: center; gap: 4px; background: #1a2230; color: #e8edf5; text-decoration: none; border: 1px solid #2a3446; border-radius: 4px; padding: 6px 10px; font-size: 12px; font-weight: 500; transition: border-color 100ms, color 100ms, background 100ms; }',
    '.upm-modal .profile-watch-link:hover { border-color: #5b8dff; color: #5b8dff; background: #141a26; }',
    '.upm-modal .profile-watch-link.yt:hover { border-color: #ff0033; color: #ff5566; }',

    /* Tab nav */
    '.upm-modal .upm-view-switch { display: flex; gap: 2px; margin: 10px 0 12px; border-bottom: 1px solid #2a3446; overflow-x: auto; }',
    '.upm-modal .upm-view-switch button { background: transparent; border: 0; color: #8a97ad; padding: 8px 14px; font-size: 12px; font-weight: 600; letter-spacing: 0.4px; text-transform: uppercase; cursor: pointer; border-bottom: 2px solid transparent; margin-bottom: -1px; transition: color 80ms, border-color 80ms; }',
    '.upm-modal .upm-view-switch button:hover { color: #e8edf5; }',
    '.upm-modal .upm-view-switch button[aria-selected="true"] { color: #5b8dff; border-bottom-color: #5b8dff; }',
    '.upm-modal .upm-tab-panel[hidden] { display: none !important; }',
    '.upm-modal .upm-tab-panel { animation: upm-fade 120ms ease-out; }',
    '@keyframes upm-fade { from { opacity: 0.4; } to { opacity: 1; } }',

    /* Window selector */
    '.upm-modal .upm-window-controls { display: flex; align-items: center; gap: 10px; margin: 6px 0 12px; flex-wrap: wrap; }',
    '.upm-modal .upm-window-controls label { font-size: 11px; color: #8a97ad; text-transform: uppercase; letter-spacing: 0.4px; }',
    '.upm-modal .upm-window-controls select { background: #1a2230; color: #e8edf5; border: 1px solid #2a3446; border-radius: 4px; padding: 4px 8px; font-size: 12px; }',
    '.upm-modal .upm-window-summary { display: grid; grid-template-columns: repeat(auto-fill, minmax(110px, 1fr)); gap: 8px; padding: 10px; background: #1a2230; border-radius: 6px; margin-bottom: 12px; }',
    '.upm-modal .upm-window-summary .val { font-size: 18px; font-weight: 700; color: #e8edf5; }',
    '.upm-modal .upm-window-summary .lbl { font-size: 10px; color: #8a97ad; text-transform: uppercase; letter-spacing: 0.3px; }',

    /* Cap-math strip cards */
    '.upm-modal .upm-salary-strip { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 8px; margin-bottom: 14px; }',
    '.upm-modal .upm-salary-card { padding: 10px 12px; background: #1a2230; border-radius: 6px; border: 1px solid #2a3446; }',
    '.upm-modal .upm-salary-card .lbl { font-size: 10px; color: #8a97ad; text-transform: uppercase; letter-spacing: 0.3px; display: block; margin-bottom: 4px; }',
    '.upm-modal .upm-salary-card .val { font-size: 16px; font-weight: 700; color: #e8edf5; }',
    /* Contract Options panel content (rendered inside its own tab). */
    '.upm-modal .upm-co-panel { padding: 6px 0; }',
    '.upm-modal .upm-co-panel .upm-co-empty { color: #8a97ad; padding: 30px 0; text-align: center; font-size: 13px; }',

    /* Stats tab — Raw Stats Columns dropdown (2026-05-13).
       Pattern lifted from Stats Workbench's .asw-cols-popover. */
    '.upm-modal .upm-raw-controls { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin-bottom: 6px; }',
    '.upm-modal .upm-raw-scope { display: flex; gap: 6px; }',
    '.upm-modal .upm-cols-dropdown { position: relative; }',
    '.upm-modal .upm-cols-dropdown[open] .upm-cols-pill-chev { transform: rotate(180deg); }',
    '.upm-modal .upm-cols-pill { list-style: none; cursor: pointer; user-select: none; background: #1a2230; color: #e8edf5; border: 1px solid #2a3446; border-radius: 999px; padding: 5px 12px; font-size: 12px; font-weight: 600; display: inline-flex; align-items: center; gap: 6px; transition: border-color 80ms; }',
    '.upm-modal .upm-cols-pill::-webkit-details-marker { display: none; }',
    '.upm-modal .upm-cols-pill:hover { border-color: #5b8dff; }',
    '.upm-modal .upm-cols-pill-count { color: #8a97ad; font-weight: 500; font-size: 11px; padding-left: 4px; border-left: 1px solid #2a3446; }',
    '.upm-modal .upm-cols-pill-chev { font-size: 10px; opacity: 0.7; transition: transform 120ms; }',
    '.upm-modal .upm-cols-popover { position: absolute; right: 0; top: calc(100% + 4px); z-index: 30; min-width: 220px; background: #141a26; border: 1px solid #2a3446; border-radius: 6px; box-shadow: 0 10px 30px rgba(0,0,0,0.5); padding: 6px 0; }',
    '.upm-modal .upm-cols-popover-header { font-size: 10px; color: #8a97ad; text-transform: uppercase; letter-spacing: 0.4px; padding: 6px 14px 4px; font-weight: 600; }',
    '.upm-modal .upm-cols-group-item { display: flex; align-items: center; gap: 8px; padding: 6px 14px; font-size: 12px; cursor: pointer; user-select: none; color: #e8edf5; }',
    '.upm-modal .upm-cols-group-item:hover { background: #1a2230; }',
    '.upm-modal .upm-cols-group-item.is-locked { cursor: default; opacity: 0.7; }',
    '.upm-modal .upm-cols-group-item input { accent-color: #5b8dff; cursor: pointer; }',
    '.upm-modal .upm-cols-group-item input:disabled { cursor: not-allowed; }',
    '.upm-modal .upm-cols-group-label { flex: 1; font-weight: 500; }',
    '.upm-modal .upm-cols-group-count { font-size: 10px; color: #8a97ad; }',
    '.upm-modal .upm-cols-reset { width: calc(100% - 28px); margin: 4px 14px 6px; background: transparent; color: #8a97ad; border: 1px solid #2a3446; border-radius: 4px; padding: 5px 8px; font-size: 11px; cursor: pointer; }',
    '.upm-modal .upm-cols-reset:hover { color: #e8edf5; border-color: #5b8dff; }',
    '.upm-modal .upm-raw-table { min-width: 100%; }',
    /* Mobile: popover snaps full-width below the pill for thumb access. */
    '@media (max-width: 600px) {' +
      ' .upm-modal .upm-cols-popover { left: 0; right: 0; min-width: 0; }' +
    ' }',

    /* Stats tab — Card-first redesign (2026-05-13). Zone 1: headline strip. */
    '.upm-modal .upm-headline-strip { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 10px; margin-bottom: 14px; }',
    '.upm-modal .upm-headline-card { background: #1a2230; border: 1px solid #2a3446; border-radius: 8px; padding: 12px 14px; display: flex; flex-direction: column; gap: 4px; }',
    '.upm-modal .upm-headline-lbl { font-size: 10px; color: #8a97ad; text-transform: uppercase; letter-spacing: 0.4px; font-weight: 600; }',
    '.upm-modal .upm-headline-val { font-size: 24px; font-weight: 800; color: #e8edf5; line-height: 1.1; font-variant-numeric: tabular-nums; }',
    '.upm-modal .upm-headline-sub { font-size: 11px; color: #8a97ad; }',
    /* Stats tab — Zone 2: compact season table (8 cols desktop, scroll on mobile). */
    '.upm-modal .upm-season-table-wrap { overflow-x: auto; -webkit-overflow-scrolling: touch; margin-top: 4px; }',
    '.upm-modal .upm-season-table { width: 100%; min-width: 520px; }',
    '.upm-modal .upm-season-table th, .upm-modal .upm-season-table td { padding: 6px 8px; }',
    '.upm-modal .upm-season-row:hover { background: rgba(91, 141, 255, 0.06); }',
    '.upm-modal .upm-career-row { border-top: 2px solid #2a3446; font-weight: 700; background: rgba(91, 141, 255, 0.04); }',
    /* Mobile: tighten the headline cards + shrink season-table padding. */
    '@media (max-width: 600px) {' +
      ' .upm-modal .upm-headline-strip { grid-template-columns: repeat(2, 1fr); gap: 6px; }' +
      ' .upm-modal .upm-headline-card { padding: 10px 10px; }' +
      ' .upm-modal .upm-headline-val { font-size: 20px; }' +
      ' .upm-modal .upm-season-table th, .upm-modal .upm-season-table td { padding: 4px 6px; font-size: 11px; }' +
    ' }',
    /* Player news feed (inside the News tab). */
    '.upm-modal .upm-news-list { display: flex; flex-direction: column; gap: 10px; padding: 4px 0; }',
    '.upm-modal .upm-news-item { padding: 10px 12px; background: #1a2230; border-radius: 6px; border-left: 3px solid #2a3446; }',
    '.upm-modal .upm-news-item.is-injury { border-left-color: #fbbf24; }',
    '.upm-modal .upm-news-item.is-headline { border-left-color: #5b8dff; }',
    '.upm-modal .upm-news-item.is-status { border-left-color: #4ade80; }',
    '.upm-modal .upm-news-item .upm-news-headline { font-size: 13px; font-weight: 600; color: #e8edf5; margin-bottom: 3px; line-height: 1.4; }',
    '.upm-modal .upm-news-item .upm-news-meta { font-size: 11px; color: #8a97ad; }',
    '.upm-modal .upm-news-item .upm-news-meta a { color: #5b8dff; text-decoration: none; }',
    '.upm-modal .upm-news-item .upm-news-meta a:hover { text-decoration: underline; }',
    '.upm-modal .upm-news-item .upm-news-body { font-size: 12px; color: #c2d3ee; margin-top: 4px; line-height: 1.5; }',

    /* Tier badges */
    '.upm-modal .tier { display: inline-block; padding: 2px 8px; border-radius: 3px; font-size: 11px; font-weight: 600; }',
    '.upm-modal .tier.Smash { background: rgba(16,185,129,0.15); color: #10b981; }',
    '.upm-modal .tier.Hit { background: rgba(59,130,246,0.15); color: #3b82f6; }',
    '.upm-modal .tier.Contrib { background: rgba(234,179,8,0.15); color: #eab308; }',
    '.upm-modal .tier.Bust { background: rgba(239,68,68,0.15); color: #ef4444; }',

    /* Pre-rookie banner */
    '.upm-modal .upm-pre-rookie-banner { background: rgba(91,141,255,0.10); border-left: 3px solid #5b8dff; padding: 10px 14px; border-radius: 4px; margin-bottom: 14px; }',
    '.upm-modal .upm-pre-rookie-banner .hdr { font-size: 11px; color: #5b8dff; text-transform: uppercase; letter-spacing: 0.5px; font-weight: 700; }',

    /* Chips (Stats sub-toggle, Raw scope toggle, Game Log view toggle) */
    '.upm-modal .rdh-chip { background: #1a2230; color: #e8edf5; border: 1px solid #2a3446; border-radius: 4px; padding: 6px 12px; font-size: 12px; font-weight: 500; cursor: pointer; transition: border-color 80ms, color 80ms; }',
    '.upm-modal .rdh-chip:hover { border-color: #5b8dff; color: #5b8dff; }',
    '.upm-modal .rdh-chip[aria-pressed="true"] { background: rgba(91,141,255,0.18); border-color: #5b8dff; color: #5b8dff; }',

    /* Taxi pill */
    '.upm-modal .taxi-pill { display: inline-block; margin-left: 6px; padding: 1px 5px; border-radius: 3px; font-size: 9px; font-weight: 700; letter-spacing: 0.6px; background: rgba(251,191,36,0.18); color: #fbbf24; border: 1px solid rgba(251,191,36,0.45); vertical-align: middle; text-transform: uppercase; }',

    /* Game log tier sizing */
    '.upm-modal .tier { font-size: 10px; padding: 1px 5px; }',

    /* Mobile */
    '@media (max-width: 600px) { .upm-modal { padding: 14px; width: 96%; max-height: 96vh; } .upm-modal .upm-salary-strip { grid-template-columns: repeat(2, 1fr); } .upm-modal .profile-bio { grid-template-columns: 1fr; } .upm-modal .upm-view-switch button { padding: 7px 10px; font-size: 11px; } }'
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
    var closeBtn = body.parentNode.querySelector(".upm-close");
    if (closeBtn) closeBtn.addEventListener("click", closeModal);
    // (Removed window.scrollTo(0,0): the overlay is position:fixed so scroll
    // position doesn't affect modal visibility — jumping to top just
    // disorients the user. Keep the postMessage so iframe parents can react
    // to the modal opening without resetting scroll.)
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
    // Diagnostic: when the bundle fetch fails, master modal renders the
    // "Live MFL profile data unavailable" banner with no hint why. Echo
    // the URL + failure reason to console so future bug reports can pin
    // it down without browser-side guesswork. Keith 2026-05-13.
    return fetch(url, { cache: "no-store" })
      .then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status + " from " + url);
        return r.json();
      })
      .then(function (data) {
        BUNDLE_CACHE[key] = data || {};
        return BUNDLE_CACHE[key];
      })
      .catch(function (err) {
        try { console.warn("[upm] /api/player-bundle failed:", url, err && err.message || err); } catch (_) {}
        BUNDLE_CACHE[key] = { _fetchError: String(err && err.message || err), _fetchUrl: url };
        return BUNDLE_CACHE[key];
      });
  }

  // ── College / Pre-NFL Prospect gate (preserved from prior file) ─────────
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
    } catch (e) { return true; }
  }

  // ── Photo fallback chain ────────────────────────────────────────────────
  // Photo chain — Keith 2026-05-14: dropped the www55 fflnetdynamic{YEAR}
  // entry. That host is unreachable (TCP timeout, not 404) so it stalled
  // the <img> for 15+s before onerror fired and the fallbacks were tried,
  // leaving the modal with a blank placeholder in practice. The only
  // MFL photo URL that reliably returns 200 across all pids is the
  // stable archive at /player_photos_2014/{pid}_thumb.jpg — promote it
  // to primary. Order:
  //   1) MFL icon_url            — pro shot when MFL surfaces it (rare)
  //   2) MFL stable archive      — www48/player_photos_2014/{pid}_thumb.jpg (reliable)
  //   3) ESPN college            — fallback for college-id'd prospects
  function buildPhotoChain(pid, pp, prospectRow, ctxYear) {
    var espnId = (prospectRow && prospectRow.espn_id) || pp.espn_id || null;
    var chain = [];
    if (pp.icon_url) chain.push(pp.icon_url);
    if (pid) chain.push("https://www48.myfantasyleague.com/player_photos_2014/" + pid + "_thumb.jpg");
    if (espnId) {
      chain.push("https://a.espncdn.com/i/headshots/college-football/players/full/" + espnId + ".png");
    }
    return chain;
  }
  function photoOnErrorAttr(chain) {
    if (!chain.length || chain.length === 1) {
      return "this.replaceWith(Object.assign(document.createElement('div'), {className: 'profile-photo-placeholder'}))";
    }
    var json = JSON.stringify(chain).replace(/"/g, "&quot;");
    return "(function(img,urls){var i=0;img.onerror=function(){i++;if(i<urls.length){img.src=urls[i];}else{img.replaceWith(Object.assign(document.createElement('div'),{className:'profile-photo-placeholder'}));}};})(this, " + json + ")";
  }

  // ── Lookup helpers — pull a row out of ctx.prospects / ctx.history ──────
  function lookupProspect(pid, ctx) {
    if (!ctx.prospects) return {};
    var arr = ctx.prospects.prospects || ctx.prospects;
    if (!Array.isArray(arr)) return {};
    for (var i = 0; i < arr.length; i++) {
      if (String(arr[i].player_id) === String(pid)) return arr[i];
    }
    return {};
  }
  function lookupHistPick(pid, ctx) {
    if (!ctx.history || !Array.isArray(ctx.history.picks)) return {};
    for (var j = 0; j < ctx.history.picks.length; j++) {
      if (String(ctx.history.picks[j].player_id) === String(pid)) return ctx.history.picks[j];
    }
    return {};
  }

  // ─────────────────────────────────────────────────────────────────────────
  // BIO TAB
  // ─────────────────────────────────────────────────────────────────────────
  function buildBioHtml(bundle, ctx, pid, name, nflTeam) {
    var pp = (bundle && bundle.profile && bundle.profile.playerProfile && bundle.profile.playerProfile.player)
          || (bundle && bundle.profile && bundle.profile.player)
          || {};
    var cr = (bundle && bundle.current_roster) || {};
    var inj = (bundle && bundle.injury) || ctx.injury || {};
    var add = (bundle && bundle.last_add) || {};
    var ch = (bundle && Array.isArray(bundle.contract_history)) ? bundle.contract_history : [];
    // Event-chain contract view — preferred when present. Falls back to
    // per-season ch[] for very old players without event-chain coverage.
    var contracts = (bundle && Array.isArray(bundle.contracts)) ? bundle.contracts : [];
    var contractStints = (bundle && Array.isArray(bundle.contract_stints)) ? bundle.contract_stints : [];
    var career = (bundle && bundle.career_summary) || [];
    var hist = lookupHistPick(pid, ctx);
    var prospectRow = lookupProspect(pid, ctx);

    var showCollege = showCollegePanels(pp, ctx);

    // Photo — pass ctx.year for the MFL pro headshot URL pattern.
    var photoFallbacks = buildPhotoChain(pid, pp, prospectRow, ctx && ctx.year);
    var photoUrl = photoFallbacks[0] || "";
    var photoOnError = photoOnErrorAttr(photoFallbacks);

    // Bio fields — physical bio (height/weight/born) is ALWAYS shown when
    // we have it. Earlier draft gated the prospect-row fallback on the
    // college visibility flag, which left vets without height/weight when
    // MFL's playerProfile didn't carry it. Per Keith 2026-05-13: match
    // Roster Workbench's prior behavior of always showing the physical
    // bio when any source has it.
    var bioHeight = pp.height || prospectRow.height || "";
    var bioWeight = pp.weight
      || (prospectRow.weight ? (String(prospectRow.weight).match(/lb|kg/i) ? prospectRow.weight : prospectRow.weight + " lb") : "")
      || "";
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

    var isFreshRookie = showCollege && !career.length;

    // ── Pre-NFL prospect banner (gated) ───────────────────────────────────
    var freshBanner = "";
    if (isFreshRookie && (prospectRow.player_id || prospectRow.consensus_rank || prospectRow.nfl_draft_summary)) {
      var srcRanks = prospectRow.source_ranks || {};
      var srcStr = "";
      if (srcRanks.mfl_rookie != null) srcStr += "MFL #" + srcRanks.mfl_rookie;
      if (srcRanks.fantasycalc != null) srcStr += (srcStr ? " · " : "") + "FC #" + srcRanks.fantasycalc;
      if (srcRanks.ktc != null) srcStr += (srcStr ? " · " : "") + "KTC #" + srcRanks.ktc;
      if (srcRanks.sleeper != null) srcStr += (srcStr ? " · " : "") + "SLP #" + srcRanks.sleeper;
      freshBanner = '<div class="upm-pre-rookie-banner">'
        + '<div class="hdr">' + escapeHtml(String(ctx.year || new Date().getFullYear())) + ' Rookie Class · Pre-NFL prospect</div>'
        + '<div style="font-size:13px; color:#e8edf5; margin-top:4px; line-height:1.5;">'
        + (prospectRow.is_udfa ? "UDFA — undrafted free agent" : escapeHtml(prospectRow.nfl_draft_summary || "Draft details TBD"))
        + (prospectRow.nfl_team ? " · signed with <strong>" + escapeHtml(prospectRow.nfl_team) + "</strong>" : "")
        + '</div>'
        + (prospectRow.consensus_rank ? ('<div style="font-size:12px; color:#8a97ad; margin-top:6px;">'
            + 'UPS rookie consensus rank <strong style="color:#e8edf5;">#' + prospectRow.consensus_rank + '</strong>'
            + (prospectRow.consensus_n_sources ? ' <span style="opacity:0.7;">across ' + prospectRow.consensus_n_sources + ' sources</span>' : "")
            + (srcStr ? ' <span style="opacity:0.8; margin-left:8px;">' + srcStr + '</span>' : "")
            + '</div>') : "")
        + '</div>';
    }

    // Bio header (photo + key facts)
    // Optional inline-action row supplied by the caller (Roster Workbench
    // passes Trade/Drop/IR/Taxi/Untag here so they sit next to height/weight
    // instead of consuming a full-width row above the modal). Keith
    // 2026-05-13: "Trade and Drop can be added into Bio next to height
    // and weight. There's a lot of wasted space."
    var bioActionsHtml = ctx.bioActionsHtml ? String(ctx.bioActionsHtml) : "";
    var bioCommishNote = ctx.bioCommishNote ? String(ctx.bioCommishNote) : "";
    var bioRows = [];
    if (bioActionsHtml) {
      bioRows.push('<div class="profile-bio-actions">' + bioActionsHtml + '</div>');
    }
    if (bioCommishNote) {
      bioRows.push('<div class="profile-bio-commish small muted">' + bioCommishNote + '</div>');
    }
    if (bioHeight) bioRows.push('<div><span class="lbl">Height</span>' + escapeHtml(bioHeight) + '</div>');
    if (bioWeight) bioRows.push('<div><span class="lbl">Weight</span>' + escapeHtml(String(bioWeight)) + '</div>');
    if (bioCollege) bioRows.push('<div><span class="lbl">College</span>' + escapeHtml(bioCollege) + '</div>');
    if (bioBornStr) bioRows.push('<div><span class="lbl">' + (pp.birthdate ? "Born" : "Age") + '</span>' + escapeHtml(bioBornStr) + '</div>');
    if (bioDraft) bioRows.push('<div><span class="lbl">NFL Draft</span>' + escapeHtml(bioDraft) + '</div>');
    if (bioJersey) bioRows.push('<div><span class="lbl">Jersey</span>#' + escapeHtml(bioJersey) + '</div>');
    if (showCollege && prospectRow.espn_id) {
      bioRows.push('<div><span class="lbl">ESPN ID</span><a href="https://www.espn.com/college-football/player/_/id/'
        + escapeHtml(prospectRow.espn_id) + '" target="_blank" rel="noopener">'
        + escapeHtml(prospectRow.espn_id) + '</a></div>');
    }

    // When the caller (e.g., Roster Workbench) is rendering its own header
    // photo above us, hide ours to avoid double-photo. ctx.hidePhoto OR
    // ctx.hideHeader both opt out of the Bio photo.
    var suppressPhoto = !!(ctx.hidePhoto || ctx.hideHeader);
    var bioHeadHtml = '<div class="profile-bio"'
      + (suppressPhoto ? ' style="grid-template-columns: 1fr;"' : '')
      + '>'
      + (suppressPhoto
        ? ''
        : (photoUrl
          ? '<img src="' + escapeHtml(photoUrl) + '" alt="' + escapeHtml(name) + '" class="profile-photo" onerror="' + photoOnError + '">'
          : '<div class="profile-photo-placeholder"></div>'))
      + '<div class="profile-bio-text">' + bioRows.join("") + '</div>'
      + '</div>';

    // ── Highlights link ───────────────────────────────────────────────────
    var ytLink = "";
    var teamForLink = nflTeam || prospectRow.nfl_team || pp.team || "";
    if (isFreshRookie && bioCollege) {
      ytLink = '<div class="profile-block"><div class="profile-watch-links"><a href="https://www.youtube.com/results?search_query='
        + encodeURIComponent(name + " " + bioCollege + " highlights")
        + '" target="_blank" rel="noopener noreferrer" class="profile-watch-link yt">College highlights</a></div></div>';
    } else if (teamForLink && teamForLink !== "FA") {
      ytLink = '<div class="profile-block"><div class="profile-watch-links"><a href="https://www.youtube.com/results?search_query='
        + encodeURIComponent(name + " " + teamForLink + " highlights")
        + '" target="_blank" rel="noopener noreferrer" class="profile-watch-link yt">NFL highlights</a></div></div>';
    }

    // ── Cap-math strip (8 cards when MFL salary present, 4 when only D1 contract) ──
    // Front Office: ctx.contractSalary supplies the live MFL row.
    // Rookie Draft / no salary: fall back to the D1 most-recent contract.
    // (Contract Options moved to its own tab — see buildContractOptionsHtml.)
    var capHtml = "";
    var sal = ctx.contractSalary || null;
    var contractInfo = sal ? parseContractInfo(sal.contractInfo) : null;
    var currentContract = ch[0] || null;

    if (contractInfo && (contractInfo.tcv || contractInfo.aav || sal.salary)) {
      var tcv = contractInfo.tcv || (function () {
        var s = 0; for (var k in contractInfo.yearVals) s += contractInfo.yearVals[k] || 0; return s;
      })();
      var aav = contractInfo.aav || (contractInfo.length > 0 ? Math.round(tcv / contractInfo.length) : Number(sal.salary || 0));
      var salary = Number(sal.salary || 0);
      var yrsRem = yearsRemain(sal, contractInfo);
      // Era-aware Earned: when stint data is present, sum per-stint earnings
      // across the active contract (handles pre-2019 flat / 2019 calendar /
      // 2026 per-week formulas correctly even when a contract spans eras).
      // Falls back to single-formula earnedToDate when no stint data.
      var earned = (function () {
        if (!contracts.length || !contractStints.length) return earnedToDate(sal, contractInfo);
        var active = null;
        for (var i = 0; i < contracts.length; i++) {
          if (!contracts[i].termination_event) { active = contracts[i]; break; }
        }
        if (!active) return earnedToDate(sal, contractInfo);
        var sum = 0;
        for (var j = 0; j < contractStints.length; j++) {
          if (contractStints[j].contract_id === active.contract_id) {
            sum += Number(contractStints[j].earned_during_stint_usd || 0);
          }
        }
        return sum;
      })();
      var penalty = dropPenalty(sal, contractInfo, ctx.year);
      var acq = findAcquisition(pid, ctx.transactions, ctx.viewerFranchise && ctx.viewerFranchise.id);
      var acqDate = acq && acq.ts ? new Date(acq.ts * 1000).toLocaleDateString() : "—";
      var acqMethod = acq && acq.method ? acq.method : "—";

      capHtml = '<div class="upm-salary-strip">'
        + '<div class="upm-salary-card"><span class="lbl">TCV</span><span class="val">' + (tcv > 0 ? fmtUsdFull(tcv) : "—") + '</span></div>'
        + '<div class="upm-salary-card"><span class="lbl">AAV</span><span class="val">' + (aav > 0 ? fmtUsdFull(aav) : "—") + '</span></div>'
        + '<div class="upm-salary-card"><span class="lbl">Salary</span><span class="val">' + (salary > 0 ? fmtUsdFull(salary) : "—") + '</span></div>'
        + '<div class="upm-salary-card"><span class="lbl">Yrs Remain</span><span class="val">' + (yrsRem > 0 ? yrsRem : "—") + '</span></div>'
        + '<div class="upm-salary-card"><span class="lbl">Earned</span><span class="val">' + (earned > 0 ? fmtUsdFull(earned) : "$0") + '</span></div>'
        + '<div class="upm-salary-card"><span class="lbl">Cap Penalty</span><span class="val">' + (penalty == null ? "—" : (penalty > 0 ? fmtUsdFull(penalty) : "$0")) + '</span></div>'
        + '<div class="upm-salary-card"><span class="lbl">Acquire Date</span><span class="val" style="font-size:13px;">' + escapeHtml(acqDate) + '</span></div>'
        + '<div class="upm-salary-card"><span class="lbl">How Acquired</span><span class="val" style="font-size:13px;">' + escapeHtml(acqMethod) + '</span></div>'
        + '</div>';
    } else if (currentContract) {
      // D1 fallback — Rookie Draft mode + Roster Workbench (neither
      // pass ctx.contractSalary). src_contracts.contract_year is
      // stored as YEARS-REMAINING-AS-OF-THAT-SEASON (not MFL's 1-indexed
      // year position). Verified: a 3-yr rookie has 2023:cy=3,
      // 2024:cy=2, 2025:cy=1.
      // Keith 2026-05-13 Brock Purdy bug: 2025 BL contract has
      // cy=3 (3 years remaining at start of 2025). The old math
      // (d1Len - d1Cy + 1) computed 3-3+1=1, showing "Years Remaining
      // = 1" when 2 was correct (we're in 2026; 2025+1 elapsed).
      var d1Tcv = currentContract.tcv || 0;
      var d1Aav = currentContract.aav || 0;
      var d1Len = currentContract.contract_length || 0;
      var d1Cy  = currentContract.contract_year || 0;
      var d1Season = Number(currentContract.season) || 0;
      var ctxYear = Number(ctx.year) || new Date().getFullYear();
      // Adjust for elapsed seasons since the snapshot was taken — if
      // ch[0] is 2025 (last EOS snapshot) and we're viewing in 2026,
      // one season has elapsed so subtract 1.
      var d1YrsRem = d1Cy > 0
        ? Math.max(0, d1Cy - Math.max(0, ctxYear - d1Season))
        : 0;
      var taxiBadge = (currentContract.taxi || currentContract.is_taxi || /TAXI/i.test(String(currentContract.contract_status || currentContract.roster_status || "")))
        ? '<span class="taxi-pill">TAXI</span>' : '';
      capHtml = '<div class="upm-salary-strip">'
        + '<div class="upm-salary-card"><span class="lbl">Years Remaining</span><span class="val">' + (d1YrsRem > 0 ? d1YrsRem : "—") + '</span></div>'
        + '<div class="upm-salary-card"><span class="lbl">AAV</span><span class="val">' + (d1Aav ? fmtUsdFull(d1Aav) : "—") + '</span></div>'
        + '<div class="upm-salary-card"><span class="lbl">TCV</span><span class="val">' + (d1Tcv ? fmtUsdFull(d1Tcv) : "—") + '</span></div>'
        + '<div class="upm-salary-card"><span class="lbl">Contract</span><span class="val" style="font-size:13px;">'
            + escapeHtml(currentContract.contract_status || (currentContract.extension_flag ? "Extended" : "Active"))
            + taxiBadge + '</span></div>'
        + '</div>';
    }

    // ── League status block ───────────────────────────────────────────────
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
        rows.push('<div><span class="lbl">Status</span><span class="muted" style="font-weight:600">Not on any roster</span> <span class="small muted">(retired / out of league)</span></div>');
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
    // Per Keith 2026-05-13: standardize on the UPS contract-type vocabulary
    // so the history reads consistently across eras.
    //   - Free Agent       (none rostered)
    //   - Rookie           (initial rookie contract)
    //   - Vet - Auction    (FL / BL possible)
    //   - Vet - WW         (waiver wire pickup)
    //   - Ext1             (first extension)
    //   - Ext2             (second extension — FL / BL possible)
    //   - Tag              (franchise / transition tag)
    function classifyContractType(c) {
      var rawStatus = String(c.contract_status || "").toLowerCase();
      var rawType = String(c.contract_type || c.acquisition_type || "").toLowerCase();
      var extFlag = !!c.extension_flag;
      var extGen = Number(c.extension_generation || c.extension_seq || 0) || 0;
      // Tag first — it's the most specific.
      if (/tag/.test(rawStatus) || /tag/.test(rawType)) return { label: "Tag", style: "" };
      // Extension chain — distinguish Ext1 vs Ext2 when generation is known.
      if (extFlag || /ext/.test(rawStatus)) {
        if (extGen >= 2 || /ext.?2|secondext|second.ext/.test(rawStatus)) {
          var flStyle = /\bfl\b/.test(rawStatus) ? " (FL)" : (/\bbl\b/.test(rawStatus) ? " (BL)" : "");
          return { label: "Ext2" + flStyle, style: "ext2" };
        }
        return { label: "Ext1", style: "ext1" };
      }
      // Rookie
      if (/rookie/.test(rawStatus) || /rookie/.test(rawType)) return { label: "Rookie", style: "rookie" };
      // WW
      if (/\bww\b|waiver/.test(rawStatus) || /ww|waiver/.test(rawType)) return { label: "Vet - WW", style: "" };
      // Vet auction — FL / BL when contractInfo carries the structure
      if (/auction/.test(rawType) || /\bfl\b|\bbl\b/.test(rawStatus)) {
        var struct = /\bfl\b/.test(rawStatus) ? " (FL)" : (/\bbl\b/.test(rawStatus) ? " (BL)" : "");
        return { label: "Vet - Auction" + struct, style: "" };
      }
      // Default vet
      if (/veteran|vet\b/.test(rawStatus)) return { label: "Vet - Auction", style: "" };
      return { label: rawStatus ? (rawStatus.charAt(0).toUpperCase() + rawStatus.slice(1)) : "—", style: "" };
    }

    // ── New per-contract classifier (event-chain) ────────────────────────
    // D1 player_contracts.contract_type values seen in prod:
    //   Veteran / WW / Rookie / FrontLoaded / BackLoaded /
    //   Tag-Franchise / Tag-Transition / MYM / RookieExtended /
    //   admin_adjustment / null
    // Ext1 vs Ext2 is determined by counting prior extension contracts on
    // this player (origin_event='extension' OR type in MYM/RookieExtended).
    function classifyContractTypeFromContractsRow(c, allContracts) {
      var t = String(c.contract_type || "").toLowerCase();
      var oe = String(c.origin_event || "").toLowerCase();
      var fl = t === "frontloaded";
      var bl = t === "backloaded";
      if (/^tag/.test(t)) return "Tag";
      if (t === "rookie") return "Rookie";
      if (t === "ww" || oe === "ww_bbid") return "Vet - WW";
      var isExtension = oe === "extension" || t === "mym" || t === "rookieextended";
      if (isExtension) {
        var priorExts = 0;
        var thisDate = c.origin_date_iso || "";
        for (var i = 0; i < allContracts.length; i++) {
          var o = allContracts[i];
          if (o.contract_id === c.contract_id) continue;
          var oOe = String(o.origin_event || "").toLowerCase();
          var oT = String(o.contract_type || "").toLowerCase();
          var oExt = oOe === "extension" || oT === "mym" || oT === "rookieextended";
          if (oExt && (o.origin_date_iso || "") < thisDate) priorExts++;
        }
        var suffix = fl ? " (FL)" : (bl ? " (BL)" : "");
        return priorExts >= 1 ? ("Ext2" + suffix) : "Ext1";
      }
      if (t === "veteran" || fl || bl || oe === "auction") {
        return "Vet - Auction" + (fl ? " (FL)" : (bl ? " (BL)" : ""));
      }
      return c.contract_type || "—";
    }

    function renderOwnerChain(stints) {
      // Single stint: just the name. Multi-stint: "A → B → C" — keeps
      // bug-fix visible for Sanders-style mid-contract trades. (Spec §Step 3
      // expand-on-click polish intentionally deferred.)
      return stints.map(function (s) {
        return escapeHtml(s.owner_name || "—");
      }).join(" → ");
    }

    function buildContractHistoryFromContracts(contracts, stints) {
      var stintsByContract = {};
      for (var i = 0; i < stints.length; i++) {
        var s = stints[i];
        if (!stintsByContract[s.contract_id]) stintsByContract[s.contract_id] = [];
        stintsByContract[s.contract_id].push(s);
      }
      var rows = contracts.map(function (c) {
        var cStints = stintsByContract[c.contract_id] || [];
        var startYr = c.origin_date_iso ? c.origin_date_iso.slice(0, 4) : "—";
        var endYr = c.termination_date_iso ? c.termination_date_iso.slice(0, 4) : "";
        var cl = c.contract_length_cl || 0;
        var span;
        if (endYr && endYr !== startYr) {
          span = startYr + "–" + endYr;
        } else if (endYr) {
          span = startYr;
        } else if (cl > 1) {
          span = startYr + "–" + (Number(startYr) + cl - 1) + " (active)";
        } else {
          span = startYr + (cl ? " (active)" : "");
        }
        var typeLabel = classifyContractTypeFromContractsRow(c, contracts);
        var tcv = c.tcv_usd || 0;
        var aav = c.aav_usd || 0;
        var ownerCell = cStints.length
          ? renderOwnerChain(cStints)
          : escapeHtml(c.origin_owner_name || "—");
        var earnedCell;
        if (c.earned_at_termination_usd != null) {
          earnedCell = fmtUsdK(c.earned_at_termination_usd);
        } else if (c.termination_event) {
          earnedCell = "—";
        } else {
          // Active contract — sum stint earnings to-date if available.
          var sumE = 0;
          var anyE = false;
          for (var k = 0; k < cStints.length; k++) {
            if (cStints[k].earned_during_stint_usd != null) {
              sumE += Number(cStints[k].earned_during_stint_usd || 0);
              anyE = true;
            }
          }
          earnedCell = anyE ? (fmtUsdK(sumE) + " (in progress)") : "in progress";
        }
        return '<tr>'
          + '<td>' + escapeHtml(span) + '</td>'
          + '<td>' + ownerCell + '</td>'
          + '<td>' + escapeHtml(typeLabel) + '</td>'
          + '<td class="num">' + (cl || "—") + '</td>'
          + '<td class="num">' + fmtUsdK(tcv) + '</td>'
          + '<td class="num">' + fmtUsdK(aav) + '</td>'
          + '<td class="num">' + earnedCell + '</td>'
          + '</tr>';
      }).join("");
      return '<div class="profile-block">'
        + '<h4>Contract History <span class="small muted">(' + contracts.length + ' contract' + (contracts.length === 1 ? "" : "s") + ')</span></h4>'
        + '<table class="rdh-table" style="margin-top:6px;"><thead><tr>'
        + '<th>Span</th><th>Owner</th><th>Type</th>'
        + '<th class="num" title="Contract Length">CL</th>'
        + '<th class="num">TCV</th>'
        + '<th class="num" title="Per-year salary (= AAV for non-FL/BL contracts)">Salary/AAV</th>'
        + '<th class="num">Earned</th>'
        + '</tr></thead><tbody>' + rows + '</tbody></table></div>';
    }

    // Renderer choice — Keith 2026-05-13: stick with the per-SEASON
    // legacy renderer. The newer event-chain (per-contract) view
    // collapses 3-year contracts into 1 row, losing the year-over-year
    // YL / salary clarity Keith needs for cap planning. The contracts/
    // stints data stays available on the bundle for future use; the
    // per-contract renderer (buildContractHistoryFromContracts) is
    // kept above for opt-in but no longer the default.
    var contractHistoryHtml = "";
    if (ch.length) {
      var rows2 = ch.map(function (c) {
        var typeInfo = classifyContractType(c);
        // Keith 2026-05-13: drop the team-name EXT1/EXT2 badge — the
        // Type column already shows Ext1 / Ext2. Don't double-tag.
        var teamCell = escapeHtml(c.team_name || "");
        var cl = c.contract_length || 0;
        var cy = c.contract_year || 0;
        // Years Left (YL): src_contracts.contract_year is ALREADY stored
        // as years-remaining (inverted from MFL convention). For a 3-yr
        // rookie verified in D1: 2023 cy=3, 2024 cy=2, 2025 cy=1. So YL
        // is just cy directly. No inversion needed.
        var yl = cy > 0 ? cy : null;
        var tcv = (c.tcv != null && c.tcv > 0) ? c.tcv : (cl && c.aav ? cl * c.aav : 0);
        // Salary/AAV cell — when this season's salary differs from the
        // contract's AAV (FL/BL/restructure years), show BOTH as
        // "$40K/$29K" so the year-over-year salary curve is visible.
        // When they match (vet auctions, rookies, MYM), collapse to a
        // single value. Keith 2026-05-13.
        var salary = Number(c.salary || 0);
        var aav = Number(c.aav || 0);
        var salAavCell;
        if (salary > 0 && aav > 0 && Math.abs(salary - aav) >= 500) {
          // Treat <$500 difference as a rounding artifact (MFL stores in
          // dollars; year_salaries can drift by a few hundred).
          salAavCell = fmtUsdK(salary) + '<span class="muted">/</span>' + fmtUsdK(aav);
        } else if (aav > 0) {
          salAavCell = fmtUsdK(aav);
        } else if (salary > 0) {
          salAavCell = fmtUsdK(salary);
        } else {
          salAavCell = "—";
        }
        return '<tr>'
          + '<td>' + escapeHtml(String(c.season)) + '</td>'
          + '<td>' + teamCell + '</td>'
          + '<td>' + escapeHtml(typeInfo.label) + '</td>'
          + '<td class="num">' + (cl || "—") + '</td>'
          + '<td class="num">' + (yl == null ? "—" : yl) + '</td>'
          + '<td class="num">' + fmtUsdK(tcv) + '</td>'
          + '<td class="num">' + salAavCell + '</td>'
          + '</tr>';
      }).join("");
      contractHistoryHtml = '<div class="profile-block">'
        + '<h4>Contract History <span class="small muted">(' + ch.length + ' season' + (ch.length === 1 ? "" : "s") + ')</span></h4>'
        + '<table class="rdh-table" style="margin-top:6px;"><thead><tr>'
        + '<th>Yr</th><th>Team</th><th>Type</th>'
        + '<th class="num" title="Contract Length">CL</th>'
        + '<th class="num" title="Years Left (includes current season)">YL</th>'
        + '<th class="num">TCV</th>'
        + '<th class="num" title="Year salary / AAV — collapsed to one value when they match (most contracts), split when this year\'s salary differs from the contract average (Front-Loaded / Back-Loaded / restructured)">Salary/AAV</th>'
        + '</tr></thead><tbody>' + rows2 + '</tbody></table></div>';
    }

    return freshBanner + bioHeadHtml + ytLink + capHtml + leagueStatusHtml + contractHistoryHtml;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // STATS TAB — Scoring (MFL) view
  // ─────────────────────────────────────────────────────────────────────────
  function buildScoringStatsHtml(bundle, ctx, pid, name) {
    var career = (bundle && bundle.career_summary) || [];
    var leverageCoefs = ctx.leverageCoefs || (bundle && bundle.leverage_coefs) || {};

    if (!career.length) {
      // No NFL career on record. For current-year rookies render the Pre-NFL panel.
      var pp = (bundle && bundle.profile && bundle.profile.playerProfile && bundle.profile.playerProfile.player) || {};
      var draftYear = String(pp.draft_year || "");
      var currentYear = String(ctx.year || new Date().getFullYear());
      var isFreshRookie = draftYear === currentYear || showCollegePanels(pp, ctx);
      var prospectRow = lookupProspect(pid, ctx);
      if (!isFreshRookie) {
        return '<p class="small muted">No career data yet — this player has no scored weeks on record.</p>';
      }
      var college = prospectRow.college || pp.college || null;
      var age = prospectRow.age || null;
      var height = prospectRow.height || pp.height || null;
      var weight = prospectRow.weight || pp.weight || null;
      var nflTeamCur = prospectRow.nfl_team || pp.team || null;
      var draftSummary = prospectRow.nfl_draft_summary;
      if (!draftSummary && pp.draft_round && pp.draft_pick) {
        draftSummary = "R" + pp.draft_round + "." + pp.draft_pick + (pp.draft_team ? " · " + pp.draft_team : "");
      } else if (!draftSummary && pp.team && draftYear) {
        draftSummary = "UDFA · " + pp.team;
      }
      var facts = [];
      if (draftSummary) facts.push('<div><span class="lbl">' + (prospectRow.is_udfa ? "Status" : "NFL Draft") + '</span><strong style="color:' + (prospectRow.is_udfa ? "#8a97ad" : "#4ade80") + '">' + escapeHtml(draftSummary) + '</strong></div>');
      else if (nflTeamCur) facts.push('<div><span class="lbl">NFL Team</span><strong>' + escapeHtml(nflTeamCur) + '</strong></div>');
      if (college) facts.push('<div><span class="lbl">College</span>' + escapeHtml(college) + '</div>');
      if (age) facts.push('<div><span class="lbl">Age</span>' + age + '</div>');
      if (height) facts.push('<div><span class="lbl">Height</span>' + escapeHtml(String(height)) + '</div>');
      if (weight) facts.push('<div><span class="lbl">Weight</span>' + weight + ' lbs</div>');
      var adpLine = prospectRow.rookie_adp != null
        ? '<div class="small muted" style="margin-top:6px;">UPS rookie ADP <strong>' + prospectRow.rookie_adp.toFixed(1) + '</strong>'
          + (prospectRow.rookie_adp_rank ? " (#" + prospectRow.rookie_adp_rank + ")" : "")
          + ' across ' + (prospectRow.rookie_adp_n_drafts || "—") + ' mocks</div>'
        : "";
      return '<div class="profile-block">'
        + '<h4>Pre-NFL Prospect — ' + escapeHtml(currentYear) + ' Rookie Class</h4>'
        + '<p class="small muted" style="margin: 0 0 10px;">'
        + escapeHtml(name) + " hasn't logged an NFL game yet. Below is the scouting-relevant snapshot from the MFL profile + UPS prospect board. College stats aren't pulled in (yet) — kept off the hub by design."
        + '</p>'
        + '<div class="profile-kv" style="display:grid; grid-template-columns:repeat(auto-fit, minmax(180px, 1fr)); gap:8px;">'
        + facts.join("\n") + '</div>'
        + adpLine + '</div>'
        + '<div class="profile-block">'
        + '<h4>What you\'ll see here once games start</h4>'
        + '<ul class="small muted" style="margin:6px 0 0; padding-left:18px; line-height:1.7;">'
        + '<li>Weekly score + tier classification (Elite / Plus / Neutral / Dud)</li>'
        + '<li>Season-by-season totals: games, points, PPG, positional ranks</li>'
        + '<li>Adjusted All-Play Wins (APW) — who the player actually wins matchups for</li>'
        + '<li>Snap counts + advanced stats (rushing/receiving/passing/IDP templates)</li>'
        + '</ul></div>';
    }

    var rows = career.slice(0, 20);
    var fmtRank = function (r) { return (r == null || r <= 0) ? "—" : "#" + r; };
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

    return '<div class="upm-window-controls">'
      + '<label>Window'
      + '<select id="profile-window-select">'
      + '<option value="season">Current season</option>'
      + '<option value="4">Last 4 weeks</option>'
      + '<option value="6">Last 6 weeks</option>'
      + '<option value="8">Last 8 weeks</option>'
      + '</select></label>'
      + '<span class="small muted">Summarizes the recent weekly window; career table below is full history.</span>'
      + '</div>'
      + '<div id="profile-window-summary" class="upm-window-summary" hidden></div>'
      + '<div class="profile-block">'
      + '<h4>Career Summary (by MFL season)</h4>'
      + '<table class="rdh-table"><thead><tr>'
      + '<th>Yr</th>'
      + '<th class="num">G</th>'
      + '<th class="num" title="Weeks in an MFL starting lineup">MFL Starts</th>'
      + '<th class="num">Pts</th>'
      + '<th class="num" title="Positional rank by total points that season">Pts Rk</th>'
      + '<th class="num">PPG</th>'
      + '<th class="num" title="Positional rank by PPG that season">PPG Rk</th>'
      + '<th class="num" title="Elite weeks (z ≥ 1.0) %">Elite%</th>'
      + '<th class="num" title="Plus weeks (0.25 ≤ z &lt; 1.0) %">Plus%</th>'
      + '<th class="num" title="Dud weeks (z &lt; −0.5) %">Dud%</th>'
      + '<th class="num" title="Adjusted All-Play Wins: win_chunks × positional leverage β.">APW</th>'
      + '<th class="num" title="Positional rank by APW that season">APW Rk</th>'
      + '<th class="num" title="APW divided by games played — per-game contribution">APW/G</th>'
      + '<th class="num" title="Positional rank by APW per game that season">APW/G Rk</th>'
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

  // ─────────────────────────────────────────────────────────────────────────
  // STATS TAB — Raw Stats view (per-pos-group templates + scope toggle)
  // Ported verbatim from rookie hub's aggregateNflSeasons + buildRawStatsHtml.
  // ─────────────────────────────────────────────────────────────────────────
  function aggregateNflSeasons(bundle, scope) {
    var weeks = (bundle && Array.isArray(bundle.nfl_weekly)) ? bundle.nfl_weekly : [];
    var snapBy = (bundle && bundle.nfl_snaps_by_week) || {};
    var isReg = function (w) {
      var wk = Number(w.week) || 0;
      return wk >= 1 && wk <= 17;
    };
    var fields = [
      "rush_att","rush_yds","rush_tds","rush_fumbles","rush_fumbles_lost",
      "targets","receptions","rec_yds","rec_tds",
      "pass_att","pass_cmp","pass_yds","pass_tds","pass_ints","pass_sacks",
      "def_tackles_ast","def_tfl","def_sacks","def_ff","def_fr","def_ints",
      "def_pass_def","def_tds",
      "fg_att","fg_made","fg_att_0_39","fg_made_0_39",
      "fg_att_40_49","fg_made_40_49","fg_att_50plus","fg_made_50plus",
      "xp_att","xp_made","punts","punt_yds","punt_inside20",
      "receiving_drops","receiving_broken_tackles",
      "rushing_broken_tackles","passing_drops",
      "rushing_yards_before_contact","rushing_yards_after_contact"
    ];
    var bySeason = {};
    for (var i = 0; i < weeks.length; i++) {
      var w = weeks[i];
      if (scope === "ups" && !isReg(w)) continue;
      var key = String(w.season);
      var tgt = bySeason[key];
      if (!tgt) {
        tgt = { season: Number(w.season), games: 0,
                _off_snaps: 0, _def_snaps: 0,
                _off_rate_sum: 0, _def_rate_sum: 0, _snap_weeks: 0,
                def_tackles_solo: 0 };
        for (var fi = 0; fi < fields.length; fi++) tgt[fields[fi]] = 0;
        bySeason[key] = tgt;
      }
      tgt.games += 1;
      for (var fj = 0; fj < fields.length; fj++) {
        tgt[fields[fj]] += Number(w[fields[fj]]) || 0;
      }
      tgt.def_tackles_solo += Number(w.def_tackles_solo) || 0;
      var snap = snapBy[w.season + "-" + w.week];
      if (snap) {
        tgt._off_snaps += Number(snap.off_snaps) || 0;
        tgt._def_snaps += Number(snap.def_snaps) || 0;
        tgt._off_rate_sum += Number(snap.off_snap_pct) || 0;
        tgt._def_rate_sum += Number(snap.def_snap_pct) || 0;
        tgt._snap_weeks += 1;
      }
    }
    var out = [];
    for (var k in bySeason) {
      if (!Object.prototype.hasOwnProperty.call(bySeason, k)) continue;
      var r = bySeason[k];
      r.def_tackles_total = r.def_tackles_solo;
      r.off_snaps_total = r._off_snaps || null;
      r.def_snaps_total = r._def_snaps || null;
      r.off_snap_rate = r._snap_weeks ? r._off_rate_sum / r._snap_weeks : null;
      r.def_snap_rate = r._snap_weeks ? r._def_rate_sum / r._snap_weeks : null;
      out.push(r);
    }
    out.sort(function (a, b) { return b.season - a.season; });
    return out;
  }

  function detectPosGroup(bundle) {
    var crosswalk = (bundle && bundle.crosswalk) || {};
    var raw = String(crosswalk.position || "").toUpperCase();
    if (raw === "P") return "punter";
    var pg = String(
      (bundle && bundle.career_summary && bundle.career_summary[0] && bundle.career_summary[0].pos_group) ||
      (bundle && bundle.nfl_weekly && bundle.nfl_weekly[0] && bundle.nfl_weekly[0].pos_group) ||
      raw
    ).toUpperCase();
    if (pg === "QB") return "qb";
    if (pg === "RB" || pg === "WR" || pg === "TE" || pg === "FB") return "skill";
    if (pg === "PK" || pg === "K") return "kicker";
    if (pg === "DL" || pg === "LB" || pg === "DB") return "idp";
    var idpRaw = ["DE","DT","NT","EDGE","OLB","ILB","MLB","CB","S","SS","FS"];
    if (idpRaw.indexOf(raw) >= 0) return "idp";
    if (raw === "K" || raw === "PK") return "kicker";
    return "skill";
  }

  // Per-pos-group templates — restructured 2026-05-13 into GROUPS.
  // Each pos_group has a `groups` map of { id: { label, cols } } plus a
  // `defaults` array listing which groups are visible by default. User
  // selection persists in sessionStorage as `upm.stats.rawCols.<pg>` =
  // comma-separated group IDs. Pattern lifted from Stats Workbench's
  // .asw-cols-popover Columns dropdown.
  //
  // Group `base` is always on (G + Snaps cells — the row identifier).
  // Other groups toggle independently in the Columns dropdown.
  var RAW_TMPL = {
    idp: {
      label: "IDP",
      defaults: ["base", "tackling"],
      groups: {
        base: { label: "Base + Snaps", always: true, cols: [
          { label: "G", key: "games" },
          { label: "Snaps", key: "def_snaps_total" },
          { label: "Snap%", compute: function (r) { return r.def_snap_rate; }, format: "pct0" },
          { label: "Snaps/G", compute: function (r) { return r.def_snaps_total && r.games ? r.def_snaps_total / r.games : null; }, format: "dec1" }
        ]},
        tackling: { label: "Tackling", cols: [
          { label: "Tkl", key: "def_tackles_total" },
          { label: "Ast", key: "def_tackles_ast" },
          { label: "TFL", key: "def_tfl" }
        ]},
        impact: { label: "Impact Plays", cols: [
          { label: "Sk", key: "def_sacks", format: "dec1" },
          { label: "FF", key: "def_ff" },
          { label: "FR", key: "def_fr" }
        ]},
        coverage: { label: "Coverage", cols: [
          { label: "PD", key: "def_pass_def" },
          { label: "Int", key: "def_ints" },
          { label: "DefTD", key: "def_tds" }
        ]}
      }
    },
    qb: {
      label: "QB",
      defaults: ["base", "passing"],
      groups: {
        base: { label: "Base + Snaps", always: true, cols: [
          { label: "G", key: "games" },
          { label: "Snaps", key: "off_snaps_total" },
          { label: "Snap%", compute: function (r) { return r.off_snap_rate; }, format: "pct0" },
          { label: "Snaps/G", compute: function (r) { return r.off_snaps_total && r.games ? r.off_snaps_total / r.games : null; }, format: "dec1" }
        ]},
        passing: { label: "Passing", cols: [
          { label: "Att", key: "pass_att" },
          { label: "Cmp", key: "pass_cmp" },
          { label: "Cmp%", compute: function (r) { return r.pass_att ? r.pass_cmp / r.pass_att : null; }, format: "pct" },
          { label: "PaYd", key: "pass_yds" },
          { label: "PaTD", key: "pass_tds" },
          { label: "Int", key: "pass_ints" },
          { label: "Int%", compute: function (r) { return r.pass_att ? r.pass_ints / r.pass_att : null; }, format: "pct" }
        ]},
        rushing: { label: "Rushing", cols: [
          { label: "RuAtt", key: "rush_att" },
          { label: "RuYd", key: "rush_yds" },
          { label: "RuTD", key: "rush_tds" },
          { label: "Fum", key: "rush_fumbles" },
          { label: "FumL", key: "rush_fumbles_lost" }
        ]},
        advanced: { label: "Advanced (PFR)", cols: [
          { label: "Drops", key: "passing_drops", title: "Receiver drops on this QB's throws (PFR, 2018+)" }
        ]}
      }
    },
    skill: {
      label: "RB / WR / TE",
      defaults: ["base", "receiving"],
      groups: {
        base: { label: "Base + Snaps", always: true, cols: [
          { label: "G", key: "games" },
          { label: "Snaps", key: "off_snaps_total" },
          { label: "Snap%", compute: function (r) { return r.off_snap_rate; }, format: "pct0" },
          { label: "Snaps/G", compute: function (r) { return r.off_snaps_total && r.games ? r.off_snaps_total / r.games : null; }, format: "dec1" }
        ]},
        receiving: { label: "Receiving", cols: [
          { label: "Tgt", key: "targets" },
          { label: "Rec", key: "receptions" },
          { label: "RecYd", key: "rec_yds" },
          { label: "RecTD", key: "rec_tds" },
          { label: "Y/T", compute: function (r) { return r.targets ? r.rec_yds / r.targets : null; }, format: "dec2" },
          { label: "Drops", key: "receiving_drops", title: "Dropped passes (PFR, 2018+)" },
          { label: "BrTkl", compute: function (r) { return (r.receiving_broken_tackles || 0) + (r.rushing_broken_tackles || 0); },
            title: "Broken tackles — receiving + rushing combined (PFR, 2018+)" }
        ]},
        rushing: { label: "Rushing", cols: [
          { label: "RuAtt", key: "rush_att" },
          { label: "RuYd", key: "rush_yds" },
          { label: "RuTD", key: "rush_tds" },
          { label: "Fum", key: "rush_fumbles" },
          { label: "FumL", key: "rush_fumbles_lost" }
        ]},
        advanced: { label: "Advanced (PFR)", cols: [
          { label: "YBC/A", compute: function (r) { return r.rush_att ? (r.rushing_yards_before_contact || 0) / r.rush_att : null; }, format: "dec2",
            title: "Rushing yards before contact per attempt (PFR, 2018+)" },
          { label: "YAC/A", compute: function (r) { return r.rush_att ? (r.rushing_yards_after_contact || 0) / r.rush_att : null; }, format: "dec2",
            title: "Rushing yards after contact per attempt (PFR, 2018+)" }
        ]}
      }
    },
    kicker: {
      label: "Kicker",
      defaults: ["base", "scoring"],
      groups: {
        base: { label: "Base", always: true, cols: [
          { label: "G", key: "games" }
        ]},
        scoring: { label: "Scoring", cols: [
          { label: "XPM", key: "xp_made" },
          { label: "XP Miss", compute: function (r) { return (r.xp_att || 0) - (r.xp_made || 0); } },
          { label: "FGM", key: "fg_made" },
          { label: "FG Miss", compute: function (r) { return (r.fg_att || 0) - (r.fg_made || 0); } }
        ]},
        distance: { label: "Distance", cols: [
          { label: "Avg FG", compute: function (r) {
              var m = (r.fg_made_0_39 || 0) + (r.fg_made_40_49 || 0) + (r.fg_made_50plus || 0);
              if (!m) return null;
              return ((r.fg_made_0_39 || 0) * 25 + (r.fg_made_40_49 || 0) * 44.5 + (r.fg_made_50plus || 0) * 54) / m;
            }, format: "dec1" }
        ]}
      }
    },
    punter: {
      label: "Punter",
      defaults: ["base", "production"],
      groups: {
        base: { label: "Base", always: true, cols: [
          { label: "G", key: "games" }
        ]},
        production: { label: "Production", cols: [
          { label: "Punts", key: "punts" },
          { label: "PuntYd", key: "punt_yds" },
          { label: "Att/G", compute: function (r) { return r.games ? r.punts / r.games : null; }, format: "dec1" }
        ]},
        efficiency: { label: "Efficiency", cols: [
          { label: "Net Avg", key: "punt_net_avg", format: "dec1" },
          { label: "I20", key: "punt_inside20" }
        ]}
      }
    }
  };

  // Resolve which group IDs are currently visible for the active pos_group.
  // Reads sessionStorage; falls back to template defaults; always includes
  // 'always: true' groups regardless of selection.
  function getActiveRawGroups(pg) {
    var tmpl = RAW_TMPL[pg] || RAW_TMPL.skill;
    var stored;
    try { stored = sessionStorage.getItem("upm.stats.rawCols." + pg); } catch (e) { stored = null; }
    var selected = stored ? stored.split(",").filter(Boolean) : (tmpl.defaults || []).slice();
    var out = [];
    var gids = Object.keys(tmpl.groups);
    for (var i = 0; i < gids.length; i++) {
      var gid = gids[i];
      var g = tmpl.groups[gid];
      if (g.always || selected.indexOf(gid) !== -1) out.push(gid);
    }
    return out;
  }

  function flattenRawCols(pg, activeGroupIds) {
    var tmpl = RAW_TMPL[pg] || RAW_TMPL.skill;
    var cols = [];
    for (var i = 0; i < activeGroupIds.length; i++) {
      var g = tmpl.groups[activeGroupIds[i]];
      if (g && g.cols) cols = cols.concat(g.cols);
    }
    return cols;
  }

  function rawFormatCell(v, fmt) {
    if (v == null || v === 0) return '<td class="num muted">—</td>';
    var s;
    if (fmt === "dec1") s = Number(v).toFixed(1);
    else if (fmt === "dec2") s = Number(v).toFixed(2);
    else if (fmt === "pct") s = (Number(v) * 100).toFixed(1) + "%";
    else if (fmt === "pct0") {
      var n = Number(v);
      if (n > 0 && n <= 1) n = n * 100;
      s = n.toFixed(1) + "%";
    } else s = String(v);
    return '<td class="num">' + s + '</td>';
  }

  function buildRawColumnsDropdown(pg) {
    var tmpl = RAW_TMPL[pg] || RAW_TMPL.skill;
    var activeGroups = getActiveRawGroups(pg);
    var groupIds = Object.keys(tmpl.groups);
    var nonAlwaysActive = activeGroups.filter(function (gid) { return !tmpl.groups[gid].always; });
    var totalToggleable = groupIds.filter(function (gid) { return !tmpl.groups[gid].always; }).length;

    var checkboxHtml = groupIds.map(function (gid) {
      var g = tmpl.groups[gid];
      var checked = activeGroups.indexOf(gid) !== -1;
      var disabled = !!g.always;
      var colCount = g.cols ? g.cols.length : 0;
      return '<label class="upm-cols-group-item' + (disabled ? ' is-locked' : '') + '">'
        + '<input type="checkbox" data-raw-group="' + escapeHtml(gid) + '" ' + (checked ? 'checked' : '') + (disabled ? ' disabled' : '') + '>'
        + '<span class="upm-cols-group-label">' + escapeHtml(g.label) + '</span>'
        + '<span class="upm-cols-group-count">' + colCount + ' col' + (colCount === 1 ? "" : "s") + (disabled ? " · always on" : "") + '</span>'
      + '</label>';
    }).join("");

    return '<details class="upm-cols-dropdown" data-pos-group="' + escapeHtml(pg) + '">'
      + '<summary class="upm-cols-pill">'
        + '<span>📊 Columns</span>'
        + '<span class="upm-cols-pill-count">' + nonAlwaysActive.length + '/' + totalToggleable + '</span>'
        + '<span class="upm-cols-pill-chev">▾</span>'
      + '</summary>'
      + '<div class="upm-cols-popover" role="menu">'
        + '<div class="upm-cols-popover-header">Show column groups</div>'
        + checkboxHtml
        + '<button type="button" class="upm-cols-reset" data-raw-cols-reset>Reset to defaults</button>'
      + '</div>'
    + '</details>';
  }

  function buildRawStatsHtml(bundle) {
    var scope;
    try { scope = sessionStorage.getItem("upm.stats.scope") || "ups"; } catch (e) { scope = "ups"; }
    var totals = aggregateNflSeasons(bundle, scope);
    var crosswalk = (bundle && bundle.crosswalk) || null;
    if (!crosswalk || !crosswalk.gsis_id) {
      return '<p class="small muted" style="padding:10px;">No NFL crosswalk for this player yet. '
        + 'Run <code>pipelines/etl/scripts/build_player_id_crosswalk.py</code>.</p>';
    }
    if (!totals.length) {
      return '<p class="small muted" style="padding:10px;">'
        + 'NFL raw stats not yet loaded for <code>' + escapeHtml(crosswalk.gsis_id) + '</code>. '
        + 'Run the nflverse fetchers + <code>scripts/load_local_to_d1.py --only nflweekly,nflsnaps,nflredzone</code>.</p>';
    }

    var pg = detectPosGroup(bundle);
    var tmpl = RAW_TMPL[pg] || RAW_TMPL.skill;
    var activeGroups = getActiveRawGroups(pg);
    var activeCols = flattenRawCols(pg, activeGroups);

    // Control bar: scope chips on the left, Columns dropdown on the right.
    var controlBar = '<div class="upm-raw-controls">'
      + '<div class="upm-raw-scope">'
        + '<button type="button" class="rdh-chip" data-raw-scope="ups"  aria-pressed="' + (scope === "ups" ? "true" : "false") + '" title="NFL regular season only — matches PFR season totals.">UPS Season</button>'
        + '<button type="button" class="rdh-chip" data-raw-scope="full" aria-pressed="' + (scope === "full" ? "true" : "false") + '" title="Include NFL playoff weeks.">Full Season</button>'
      + '</div>'
      + buildRawColumnsDropdown(pg)
    + '</div>';
    var scopeNote = scope === "full" ? "Full NFL Season (incl. playoffs)." : "UPS Season (NFL regular season).";

    var thRow = '<th>Yr</th>';
    for (var ti = 0; ti < activeCols.length; ti++) {
      var c = activeCols[ti];
      thRow += '<th class="num"' + (c.title ? ' title="' + c.title.replace(/"/g, "&quot;") + '"' : "") + '>' + c.label + '</th>';
    }
    var bodyRows = totals.map(function (r) {
      var tds = '<td>' + r.season + '</td>';
      for (var ci = 0; ci < activeCols.length; ci++) {
        var col = activeCols[ci];
        var v = col.compute ? col.compute(r) : r[col.key];
        tds += rawFormatCell(v, col.format || "int");
      }
      return '<tr>' + tds + '</tr>';
    }).join("");

    var confNote = (crosswalk.confidence && crosswalk.confidence !== "exact")
      ? '<div class="small" style="color:#fbbf24; margin-top:4px;">Crosswalk confidence: ' + escapeHtml(crosswalk.confidence)
        + (crosswalk.match_score ? " (" + crosswalk.match_score.toFixed(2) + ")" : "") + ' — review recommended.</div>'
      : "";

    return '<div class="profile-block" data-raw-panel-root>'
      + '<h4>Raw Stats — ' + tmpl.label + '</h4>'
      + controlBar
      + '<div class="small muted" style="margin: 4px 0 6px;">' + scopeNote + ' Real NFL on-field counts + derived rates. Independent of MFL fantasy scoring.</div>'
      + '<div class="upm-season-table-wrap"><table class="rdh-table upm-raw-table"><thead><tr>' + thRow + '</tr></thead><tbody>' + bodyRows + '</tbody></table></div>'
      + confNote
      + '</div>';
  }

  // ─────────────────────────────────────────────────────────────────────────
  // STATS TAB — redesigned 2026-05-13 (Card-first, mobile-friendly)
  //
  // Per Keith 2026-05-13: the prior layout was a 3-way chip toggle
  // (Scoring/Raw/Advanced) where Advanced was a TBD placeholder and the
  // Raw view buried the UPS/Full Season scope chips inside another layer.
  // The Career Summary table was 14 columns wide — unreadable on mobile.
  //
  // Redesign zones:
  //   Zone 1  — HEADLINE STRIP. 4 big cards: Career Pts, PPG, Best Yr, APW.
  //             Answers "is this player good?" in a glance.
  //   Zone 2  — TOGGLES + TABLE. Two flat chip groups at the same level:
  //             [Scoring (MFL) | Raw Stats (NFL)] and (when Raw selected)
  //             [UPS Season | Full Season]. Below: compact 8-column table
  //             on desktop, horizontal-scrollable on mobile.
  //   Advanced view RETIRED. (Was empty TBD placeholder. Future advanced
  //             metrics belong as inline columns in Scoring view.)
  //
  // Game Log + per-week drill-down stays in the Game Log tab — Stats is for
  // season-level summary, Game Log is for week-level. No double-rendering.
  // ─────────────────────────────────────────────────────────────────────────
  function buildHeadlineStripHtml(career, leverageCoefs) {
    if (!career || !career.length) return "";
    // Career totals weighted properly.
    // wcAvailable tracks whether the underlying src_weekly.win_chunks
    // column has any real values. As of 2026-05-13 the ETL that writes
    // win_chunks (build_metadata_positionalwinprofile.py) appears to be
    // not running — every row is NULL. We render APW as "—" instead of
    // a misleading "0.0" when that's the case.
    var tot = { g: 0, pts: 0, wcn: 0 };
    var wcAvailable = false;
    var bestYr = null, bestYrPts = -1, bestYrPPG = 0;
    for (var i = 0; i < career.length; i++) {
      var c = career[i];
      var g = c.games_played || 0;
      var pts = c.season_points || 0;
      var wcb = (leverageCoefs && leverageCoefs[c.pos_group]) || 0;
      tot.g += g;
      tot.pts += pts;
      if (c.win_chunks != null && c.win_chunks > 0) wcAvailable = true;
      tot.wcn += (c.win_chunks || 0) * wcb;
      if (pts > bestYrPts) {
        bestYrPts = pts;
        bestYr = c.season;
        bestYrPPG = c.avg_ppg != null ? c.avg_ppg : (g ? pts / g : 0);
      }
    }
    var careerPPG = tot.g ? tot.pts / tot.g : 0;
    var apwPerG = tot.g ? tot.wcn / tot.g : 0;
    var fmtPts = function (n) { return Number(n || 0).toFixed(0); };
    return '<div class="upm-headline-strip">'
      + '<div class="upm-headline-card">'
        + '<span class="upm-headline-lbl">Career Pts</span>'
        + '<span class="upm-headline-val">' + fmtPts(tot.pts).replace(/\B(?=(\d{3})+(?!\d))/g, ",") + '</span>'
        + '<span class="upm-headline-sub">' + tot.g + ' G across ' + career.length + ' season' + (career.length === 1 ? "" : "s") + '</span>'
      + '</div>'
      + '<div class="upm-headline-card">'
        + '<span class="upm-headline-lbl">Career PPG</span>'
        + '<span class="upm-headline-val">' + careerPPG.toFixed(1) + '</span>'
        + '<span class="upm-headline-sub">Average per game</span>'
      + '</div>'
      + '<div class="upm-headline-card">'
        + '<span class="upm-headline-lbl">Best Season</span>'
        + '<span class="upm-headline-val">' + (bestYr || "—") + '</span>'
        + '<span class="upm-headline-sub">' + (bestYrPts >= 0 ? fmtPts(bestYrPts) + ' pts · ' + bestYrPPG.toFixed(1) + ' PPG' : "") + '</span>'
      + '</div>'
      + '<div class="upm-headline-card" title="Adjusted All-Play Wins = win_chunks × positional leverage β. How many All-Play wins this player is responsible for if every other lineup slot turned in median output.">'
        + '<span class="upm-headline-lbl">Career APW</span>'
        + '<span class="upm-headline-val">' + (wcAvailable ? tot.wcn.toFixed(1) : "—") + '</span>'
        + '<span class="upm-headline-sub">' + (wcAvailable ? (apwPerG.toFixed(2) + ' / game') : 'data pending') + '</span>'
      + '</div>'
      + '</div>';
  }

  function buildCompactScoringTableHtml(career, leverageCoefs) {
    if (!career || !career.length) return "";
    var rows = career.slice(0, 20);
    var fmtRank = function (r) { return (r == null || r <= 0) ? "—" : "#" + r; };
    var tot = { g: 0, pts: 0, wcn: 0, el_num: 0, ep_den: 0 };
    var wcAvailable = false;
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].win_chunks != null && rows[i].win_chunks > 0) { wcAvailable = true; break; }
    }
    var bodyRows = rows.map(function (c) {
      var wcb = (leverageCoefs && leverageCoefs[c.pos_group]) || 0;
      var apw = (c.win_chunks || 0) * wcb;
      tot.g += (c.games_played || 0);
      tot.pts += (c.season_points || 0);
      tot.wcn += apw;
      if (c.elite_pct != null) { tot.el_num += c.elite_pct * c.games_played; tot.ep_den += c.games_played; }
      // APW cell: render "—" when the upstream win_chunks data isn't
      // populated for this row (avoid showing a misleading "0.0").
      var apwCell = (c.win_chunks != null && c.win_chunks > 0)
        ? '<strong>' + apw.toFixed(1) + '</strong>'
        : '<span class="muted">—</span>';
      return '<tr class="upm-season-row" data-season="' + escapeHtml(String(c.season)) + '">'
        + '<td>' + escapeHtml(String(c.season)) + '</td>'
        + '<td class="num">' + (c.games_played || 0) + '</td>'
        + '<td class="num">' + (c.season_points != null ? c.season_points.toFixed(0) : "—") + '</td>'
        + '<td class="num muted">' + fmtRank(c.pos_rank) + '</td>'
        + '<td class="num">' + (c.avg_ppg != null ? c.avg_ppg.toFixed(1) : "—") + '</td>'
        + '<td class="num muted">' + fmtRank(c.pos_ppg_rank) + '</td>'
        + '<td class="num" style="color:#10b981">' + (c.elite_pct != null ? c.elite_pct.toFixed(0) + "%" : "—") + '</td>'
        + '<td class="num">' + apwCell + '</td>'
        + '</tr>';
    }).join("");
    var careerPPG = tot.g ? tot.pts / tot.g : 0;
    var careerEl = tot.ep_den ? tot.el_num / tot.ep_den : 0;
    return '<div class="upm-season-table-wrap">'
      + '<table class="rdh-table upm-season-table"><thead><tr>'
      + '<th>Yr</th>'
      + '<th class="num">G</th>'
      + '<th class="num">Pts</th>'
      + '<th class="num" title="Positional rank by total points">Pts Rk</th>'
      + '<th class="num">PPG</th>'
      + '<th class="num" title="Positional rank by PPG">PPG Rk</th>'
      + '<th class="num" title="Elite weeks (z ≥ 1.0) %">Elite%</th>'
      + '<th class="num" title="Adjusted All-Play Wins">APW</th>'
      + '</tr></thead><tbody>'
      + bodyRows
      + '<tr class="upm-career-row">'
        + '<td><strong>Career</strong></td>'
        + '<td class="num">' + tot.g + '</td>'
        + '<td class="num">' + tot.pts.toFixed(0) + '</td>'
        + '<td class="num muted">—</td>'
        + '<td class="num">' + careerPPG.toFixed(1) + '</td>'
        + '<td class="num muted">—</td>'
        + '<td class="num" style="color:#10b981">' + careerEl.toFixed(0) + '%</td>'
        + '<td class="num">' + (wcAvailable ? tot.wcn.toFixed(1) : '<span class="muted">—</span>') + '</td>'
      + '</tr>'
      + '</tbody></table></div>'
      + (wcAvailable ? '' : '<p class="small muted" style="margin-top:6px;">APW shows "—" — upstream <code>src_weekly.win_chunks</code> not currently populated. ETL backfill pending.</p>');
  }

  function buildStatsPanelHtml(bundle, ctx, pid, name) {
    var career = (bundle && bundle.career_summary) || [];
    var leverageCoefs = ctx.leverageCoefs || (bundle && bundle.leverage_coefs) || {};
    // Fresh-rookie + no-career fallback — preserve buildScoringStatsHtml's
    // rich Pre-NFL Prospect panel when there's nothing else to show.
    if (!career.length) {
      return buildScoringStatsHtml(bundle, ctx, pid, name);
    }

    var headlineHtml = buildHeadlineStripHtml(career, leverageCoefs);
    var scoringTableHtml = buildCompactScoringTableHtml(career, leverageCoefs);
    var rawHtml = buildRawStatsHtml(bundle);

    return headlineHtml
      // View toggle (Scoring/Raw) sits at the top of the body so it
      // gates which table renders below. No more nested chips.
      + '<div class="upm-stats-view-switch" style="display:flex; gap:6px; margin: 4px 0 12px; flex-wrap:wrap;">'
        + '<button type="button" class="rdh-chip" data-stats-view="scoring" aria-pressed="true">Scoring (MFL)</button>'
        + '<button type="button" class="rdh-chip" data-stats-view="raw" aria-pressed="false">Raw Stats (NFL)</button>'
      + '</div>'
      + '<div data-stats-body="scoring">' + scoringTableHtml + '</div>'
      + '<div data-stats-body="raw" hidden>' + rawHtml + '</div>';
  }

  // ─────────────────────────────────────────────────────────────────────────
  // GAME LOG TAB — Scoring + Raw views, season-dropdown selector
  // ─────────────────────────────────────────────────────────────────────────
  function buildGameLogPanelHtml(bundle) {
    var glScoringSeasons = bundle && bundle.weekly_by_season ? Object.keys(bundle.weekly_by_season) : [];
    var glRawSeasons = bundle && bundle.nfl_weekly_by_season ? Object.keys(bundle.nfl_weekly_by_season) : [];
    var seasons = glScoringSeasons.length ? glScoringSeasons : glRawSeasons;
    if (!seasons.length) {
      return '<p class="small muted">No weekly data available.</p>';
    }
    seasons = seasons.slice().sort(function (a, b) { return Number(b) - Number(a); });
    var opts = seasons.map(function (s) { return '<option value="' + s + '">' + s + '</option>'; }).join("");
    return '<div class="profile-block">'
      + '<h4>Game Log — Every Game, Season-by-Season</h4>'
      + '<div style="display:flex; gap:6px; margin-bottom:10px;">'
      + '<button type="button" class="rdh-chip" data-gamelog-view="scoring" aria-pressed="true">Scoring (MFL)</button>'
      + '<button type="button" class="rdh-chip" data-gamelog-view="raw"     aria-pressed="false">Raw Stats (NFL)</button>'
      + '</div>'
      + '<label style="font-size:11px; color:#8a97ad; display:inline-block; margin-bottom:8px;">Season '
      + '<select id="profile-season-select" style="margin-left:6px; background:#1a2230; color:#e8edf5; border:1px solid #2a3446; border-radius:4px; padding:3px 6px;">'
      + opts + '</select></label>'
      + '<div id="profile-game-log"></div>'
      + '</div>';
  }

  // Per-pos-group weekly templates (Game Log Raw view).
  var GL_TMPL = {
    idp: { label: "IDP", snap: "def", cols: [
      { label: "Tkl",   key: "def_tackles_solo" },
      { label: "Ast",   key: "def_tackles_ast" },
      { label: "TFL",   key: "def_tfl" },
      { label: "FF",    key: "def_ff" },
      { label: "FR",    key: "def_fr" },
      { label: "Sk",    key: "def_sacks", format: "dec1" },
      { label: "PD",    key: "def_pass_def" },
      { label: "Int",   key: "def_ints" },
      { label: "DefTD", key: "def_tds" }
    ]},
    qb: { label: "QB", snap: "off", cols: [
      { label: "RuAtt", key: "rush_att" },
      { label: "RuYd",  key: "rush_yds" },
      { label: "RuTD",  key: "rush_tds" },
      { label: "Fum",   key: "rush_fumbles" },
      { label: "FumL",  key: "rush_fumbles_lost" },
      { label: "Att",   key: "pass_att" },
      { label: "Cmp",   key: "pass_cmp" },
      { label: "Cmp%",  compute: function (r) { return r.pass_att ? r.pass_cmp / r.pass_att : null; }, format: "pct" },
      { label: "PaYd",  key: "pass_yds" },
      { label: "PaTD",  key: "pass_tds" },
      { label: "Int",   key: "pass_ints" },
      { label: "Drops", key: "passing_drops", title: "Receiver drops on this QB's throws (PFR, 2018+)" }
    ]},
    skill: { label: "RB / WR / TE", snap: "off", cols: [
      { label: "Tgt",   key: "targets" },
      { label: "Rec",   key: "receptions" },
      { label: "RecYd", key: "rec_yds" },
      { label: "RecTD", key: "rec_tds" },
      { label: "Y/T",   compute: function (r) { return r.targets ? r.rec_yds / r.targets : null; }, format: "dec2" },
      { label: "Drops", key: "receiving_drops", title: "Dropped passes (PFR, 2018+)" },
      { label: "BrTkl", compute: function (r) { return (r.receiving_broken_tackles || 0) + (r.rushing_broken_tackles || 0); },
        title: "Broken tackles combined — receiving + rushing (PFR, 2018+)" },
      { label: "RuAtt", key: "rush_att" },
      { label: "RuYd",  key: "rush_yds" },
      { label: "YBC/A", compute: function (r) { return r.rush_att ? (r.rushing_yards_before_contact || 0) / r.rush_att : null; }, format: "dec2",
        title: "Rushing yards before contact per attempt (PFR, 2018+)" },
      { label: "YAC/A", compute: function (r) { return r.rush_att ? (r.rushing_yards_after_contact || 0) / r.rush_att : null; }, format: "dec2",
        title: "Rushing yards after contact per attempt (PFR, 2018+)" },
      { label: "RuTD",  key: "rush_tds" },
      { label: "Fum",   key: "rush_fumbles" },
      { label: "FumL",  key: "rush_fumbles_lost" }
    ]},
    kicker: { label: "Kicker", snap: null, cols: [
      { label: "XPM",     key: "xp_made" },
      { label: "XP Miss", compute: function (r) { return (r.xp_att || 0) - (r.xp_made || 0); } },
      { label: "FGM",     key: "fg_made" },
      { label: "FG Miss", compute: function (r) { return (r.fg_att || 0) - (r.fg_made || 0); } }
    ]},
    punter: { label: "Punter", snap: null, cols: [
      { label: "Punts",   key: "punts" },
      { label: "PuntYd",  key: "punt_yds" },
      { label: "Net Avg", key: "punt_net_avg", format: "dec1" },
      { label: "I20",     key: "punt_inside20" }
    ]}
  };

  // ─────────────────────────────────────────────────────────────────────────
  // CONTRACT OPTIONS TAB
  //
  // Renders caller-supplied HTML describing extension options, rookie-option
  // decisions, restructure eligibility, etc. The caller (Roster Workbench)
  // already knows the player's situation in depth — we just take the HTML
  // it produces and frame it in the master modal's visual language.
  //
  // Tab visibility is gated on ctx.contractOptionsHtml being non-empty —
  // tab nav hides Contract Options when there's nothing to show (e.g.,
  // Front Office viewer of a vet who has no extension options).
  // ─────────────────────────────────────────────────────────────────────────
  function buildContractOptionsHtml(ctx) {
    var html = String(ctx.contractOptionsHtml || "").trim();
    if (!html) {
      return '<div class="upm-co-panel"><p class="upm-co-empty">No contract options available for this player.</p></div>';
    }
    return '<div class="upm-co-panel">' + html + '</div>';
  }

  function hasContractOptions(ctx) {
    return !!(ctx && ctx.contractOptionsHtml && String(ctx.contractOptionsHtml).trim());
  }

  // ─────────────────────────────────────────────────────────────────────────
  // NEWS TAB
  //
  // Three sections, top to bottom:
  //   1. Live news feed (async) — fetched from /api/player-news. Worker
  //      aggregates Sleeper (injury_status / depth_chart / practice) +
  //      ESPN league-wide RSS articles tagged by player.
  //   2. MFL injury (sync, from bundle.injury) — current MFL-reported.
  //   3. Last Acquired / Recent Trades (sync) — UPS context, not news.
  // ─────────────────────────────────────────────────────────────────────────

  // Map item.type → CSS class for left-border color hint.
  function newsItemClassForType(t) {
    if (t === "injury" || t === "status") return "is-injury";
    if (t === "headline") return "is-headline";
    // depth charts are not "news" per Keith — filtered upstream.
    return "";
  }

  // Filter what counts as a "news item" for the News tab.
  // Per Keith 2026-05-13: exclude depth-chart entries (depth is roster
  // info, not news). Keep injury/status + ESPN headlines.
  function isRealNewsItem(item) {
    if (!item || !item.type) return false;
    return item.type === "injury" || item.type === "status" || item.type === "headline";
  }

  function renderNewsFeedItem(item) {
    var when = "";
    if (item.timestamp) {
      try {
        var d = new Date(Number(item.timestamp) * 1000);
        when = d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
      } catch (e) { when = ""; }
    }
    var sourceLabel = item.source ? escapeHtml(String(item.source)) : "";
    var meta = sourceLabel + (when ? " · " + when : "");
    var headline = item.url
      ? '<a href="' + escapeHtml(item.url) + '" target="_blank" rel="noopener noreferrer">' + escapeHtml(item.headline || "") + '</a>'
      : escapeHtml(item.headline || "");
    return '<div class="upm-news-item ' + newsItemClassForType(item.type) + '">'
      + '<div class="upm-news-headline">' + headline + '</div>'
      + '<div class="upm-news-meta">' + meta + '</div>'
      + (item.body ? '<div class="upm-news-body">' + escapeHtml(item.body) + '</div>' : '')
      + '</div>';
  }

  function buildNewsHtml(bundle, ctx, pid) {
    // Section 1 — async feed placeholder. wireNewsAsync fills it after
    // bundle render completes.
    var feedSection = '<div class="profile-block">'
      + '<h4>Player News <span class="small muted">(Sleeper + ESPN)</span></h4>'
      + '<div id="upm-news-feed-list" data-pid="' + escapeHtml(String(pid || "")) + '">'
        + '<p class="small muted" style="padding:6px 0;">Fetching player news…</p>'
      + '</div>'
    + '</div>';

    // Section 2 + 3 — MFL bundle context (sync, fast)
    var inj = (bundle && bundle.injury) || {};
    var add = (bundle && bundle.last_add) || {};
    var trades = (bundle && bundle.trade_history) || [];
    var ctxItems = [];
    if (inj.status) {
      ctxItems.push('<div class="profile-block"><h4 style="color:#fbbf24">MFL Injury · ' + escapeHtml(inj.status) + '</h4>'
        + '<div class="small muted">' + escapeHtml(inj.details || "No additional details from MFL.") + '</div></div>');
    }
    if (add.datetime_et) {
      ctxItems.push('<div class="profile-block"><h4>Last Acquired</h4><div class="small">'
        + escapeHtml(add.datetime_et.slice(0, 10)) + ' · ' + escapeHtml(add.method || "")
        + (add.salary ? " · $" + Number(add.salary).toLocaleString() : "")
        + ' by ' + escapeHtml(add.franchise_name || "") + '</div></div>');
    }
    if (trades.length) {
      ctxItems.push('<div class="profile-block"><h4>Recent Trades (' + trades.length + ')</h4><div class="small muted">'
        + trades.slice(0, 10).map(function (t) {
          return '<div>' + escapeHtml((t.datetime_et || "").slice(0, 10)) + ' · '
            + escapeHtml(t.franchise_name || "") + ' ' + escapeHtml(t.asset_role || "")
            + (t.comments ? ' — "' + escapeHtml(String(t.comments).slice(0, 80)) + '"' : "")
            + '</div>';
        }).join("") + '</div></div>');
    }
    return feedSection + ctxItems.join("");
  }

  // Async news fetch + render. Called from openPlayerProfile after the
  // tab panels are wired. Fills #upm-news-feed-list in place.
  function wireNewsAsync(body, ctx, pid) {
    var feedEl = body.querySelector("#upm-news-feed-list");
    if (!feedEl || !pid) return;
    var apiBase = (ctx.apiBase || "").replace(/\/+$/, "");
    var url = apiBase + "/api/player-news?pids=" + encodeURIComponent(pid)
      + (ctx.leagueId ? "&L=" + encodeURIComponent(ctx.leagueId) : "")
      + (ctx.year ? "&YEAR=" + encodeURIComponent(ctx.year) : "");
    fetch(url, { cache: "no-store" })
      .then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      })
      .then(function (data) {
        if (!feedEl.parentNode) return;  // tab torn down between fetch + render
        var rawItems = (data && data.items_by_pid && data.items_by_pid[String(pid)]) || [];
        // Filter to real news (injury / status / headline) — depth-chart
        // entries are roster info, not news. Per Keith 2026-05-13.
        var items = rawItems.filter(isRealNewsItem);
        if (!items.length) {
          var hadDepth = rawItems.some(function (it) { return it && it.type === "depth"; });
          feedEl.innerHTML = '<p class="small muted" style="padding:6px 0;">No injury reports or news headlines for this player.'
            + (hadDepth ? ' (Depth chart position available — see Bio tab.)' : '')
            + '</p>';
          return;
        }
        feedEl.innerHTML = '<div class="upm-news-list">'
          + items.map(renderNewsFeedItem).join("")
          + '</div>';
      })
      .catch(function (err) {
        if (!feedEl.parentNode) return;
        feedEl.innerHTML = '<p class="small muted" style="padding:6px 0;">News feed unavailable ('
          + escapeHtml(err && err.message ? err.message : String(err))
          + ').</p>';
      });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // INTERACTIVITY WIRING
  // ─────────────────────────────────────────────────────────────────────────
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

  function wireStatsToggle(body, bundle) {
    var pref;
    try {
      var v = sessionStorage.getItem("upm.stats.view");
      if (v === "basic") pref = "scoring";
      else if (v === "advanced") pref = "raw";
      else pref = v || "scoring";
    } catch (e) { pref = "scoring"; }

    var setView = function (view) {
      var vbtns = body.querySelectorAll("[data-stats-view]");
      var vbodies = body.querySelectorAll("[data-stats-body]");
      for (var i = 0; i < vbtns.length; i++) {
        vbtns[i].setAttribute("aria-pressed", vbtns[i].getAttribute("data-stats-view") === view ? "true" : "false");
      }
      for (var j = 0; j < vbodies.length; j++) {
        if (vbodies[j].getAttribute("data-stats-body") === view) vbodies[j].removeAttribute("hidden");
        else vbodies[j].setAttribute("hidden", "");
      }
    };
    setView(pref);

    var vbtns = body.querySelectorAll("[data-stats-view]");
    for (var i = 0; i < vbtns.length; i++) {
      (function (btn) {
        btn.addEventListener("click", function () {
          var view = btn.getAttribute("data-stats-view");
          try { sessionStorage.setItem("upm.stats.view", view); } catch (e) {}
          setView(view);
        });
      })(vbtns[i]);
    }

    // Raw Stats control wiring — UPS/Full Season scope chips AND the
    // Columns dropdown checkboxes both re-render the raw panel in place.
    // Bound together so re-rendering re-binds both control sets.
    var rebindRawControls = function () {
      // Scope chips (UPS / Full Season)
      var sbtns = body.querySelectorAll("[data-raw-scope]");
      for (var k = 0; k < sbtns.length; k++) {
        (function (sbtn) {
          sbtn.addEventListener("click", function () {
            try { sessionStorage.setItem("upm.stats.scope", sbtn.getAttribute("data-raw-scope")); } catch (e) {}
            var rawBody = body.querySelector("[data-stats-body='raw']");
            if (rawBody) {
              rawBody.innerHTML = buildRawStatsHtml(bundle);
              rebindRawControls();
            }
          });
        })(sbtns[k]);
      }
      // Columns dropdown checkboxes — toggle group visibility + persist.
      var cboxes = body.querySelectorAll(".upm-cols-dropdown [data-raw-group]");
      for (var i = 0; i < cboxes.length; i++) {
        (function (cb) {
          cb.addEventListener("change", function () {
            // Read current selection state from all checkboxes.
            var dropdown = cb.closest(".upm-cols-dropdown");
            var pg = dropdown ? dropdown.getAttribute("data-pos-group") : "";
            if (!pg) return;
            var checked = [];
            var allBoxes = dropdown.querySelectorAll("[data-raw-group]");
            for (var j = 0; j < allBoxes.length; j++) {
              if (allBoxes[j].checked || allBoxes[j].disabled) {
                // Disabled boxes are 'always' groups — include them.
                if (allBoxes[j].checked) checked.push(allBoxes[j].getAttribute("data-raw-group"));
              }
            }
            try { sessionStorage.setItem("upm.stats.rawCols." + pg, checked.join(",")); } catch (e) {}
            var rawBody = body.querySelector("[data-stats-body='raw']");
            if (rawBody) {
              rawBody.innerHTML = buildRawStatsHtml(bundle);
              rebindRawControls();
            }
          });
        })(cboxes[i]);
      }
      // Reset-to-defaults button
      var resetBtn = body.querySelector("[data-raw-cols-reset]");
      if (resetBtn) {
        resetBtn.addEventListener("click", function (e) {
          e.preventDefault();
          var dropdown = resetBtn.closest(".upm-cols-dropdown");
          var pg = dropdown ? dropdown.getAttribute("data-pos-group") : "";
          if (!pg) return;
          try { sessionStorage.removeItem("upm.stats.rawCols." + pg); } catch (e2) {}
          var rawBody = body.querySelector("[data-stats-body='raw']");
          if (rawBody) {
            rawBody.innerHTML = buildRawStatsHtml(bundle);
            rebindRawControls();
          }
        });
      }
    };
    rebindRawControls();
  }

  function wireWindowSelector(body, bundle) {
    var winSel = body.querySelector("#profile-window-select");
    var winSummary = body.querySelector("#profile-window-summary");
    if (!winSel || !winSummary) return;
    var renderWindow = function (windowVal) {
      var all = (bundle && Array.isArray(bundle.weekly)) ? bundle.weekly : [];
      if (!all.length) { winSummary.setAttribute("hidden", ""); return; }
      var seasonMax = 0;
      for (var i = 0; i < all.length; i++) seasonMax = Math.max(seasonMax, all[i].season || 0);
      var windowWeeks;
      if (windowVal === "season") {
        windowWeeks = all.filter(function (w) { return w.season === seasonMax; });
      } else {
        var n = parseInt(windowVal, 10);
        windowWeeks = all.slice().sort(function (a, b) { return (b.season - a.season) || (b.week - a.week); }).slice(0, n);
      }
      if (!windowWeeks.length) { winSummary.setAttribute("hidden", ""); return; }
      var tot = windowWeeks.length;
      var pts = 0, elite = 0, plus = 0, dud = 0, zSum = 0;
      windowWeeks.forEach(function (w) {
        pts += (w.score || 0);
        if (w.week_tier === "Elite") elite++;
        if (w.week_tier === "Plus") plus++;
        if (w.week_tier === "Dud") dud++;
        zSum += (w.z_score || 0);
      });
      var meanZ = tot ? zSum / tot : 0;
      var ppg = tot ? pts / tot : 0;
      winSummary.removeAttribute("hidden");
      winSummary.innerHTML = '<div><span class="lbl">Games</span><div class="val">' + tot + '</div></div>'
        + '<div><span class="lbl">PPG</span><div class="val">' + ppg.toFixed(1) + '</div></div>'
        + '<div><span class="lbl">Elite%</span><div class="val" style="color:#10b981">' + (elite/tot*100).toFixed(0) + '%</div></div>'
        + '<div><span class="lbl">Plus%</span><div class="val" style="color:#3b82f6">' + (plus/tot*100).toFixed(0) + '%</div></div>'
        + '<div><span class="lbl">Dud%</span><div class="val" style="color:#ef4444">' + (dud/tot*100).toFixed(0) + '%</div></div>'
        + '<div><span class="lbl">Mean z</span><div class="val">' + (meanZ >= 0 ? "+" : "") + meanZ.toFixed(2) + '</div></div>';
    };
    winSel.addEventListener("change", function (e) { renderWindow(e.target.value); });
    renderWindow("season");
  }

  function wireGameLog(body, bundle) {
    var seasonSel = body.querySelector("#profile-season-select");
    var logEl = body.querySelector("#profile-game-log");
    if (!seasonSel || !logEl) return;

    var weekTierClass = function (t) {
      return t === "Elite" ? "Smash" : t === "Plus" ? "Hit" : t === "Neutral" ? "Contrib" : "Bust";
    };

    // Snap-rate suffix attached to the Week # cell across both views.
    // Keith 2026-05-13: "add snap rate next to Week #" — surfaces
    // workload at a glance without forcing the Raw view's column scroll.
    // Off vs. def picked per pos_group (mirrors GL_TMPL.snap), then
    // looked up in bundle.nfl_snaps_by_week (keyed "season-week").
    var pgForSnap = detectPosGroup(bundle);
    var snapSide = (GL_TMPL[pgForSnap] && GL_TMPL[pgForSnap].snap) || "";  // "off" | "def" | ""
    var snapsByWeek = (bundle && bundle.nfl_snaps_by_week) || {};
    var snapPctForWeek = function (season, week) {
      if (!snapSide) return null;
      var row = snapsByWeek[season + "-" + week];
      if (!row) return null;
      var pct = snapSide === "def" ? row.def_snap_pct : row.off_snap_pct;
      if (pct == null) return null;
      var n = Number(pct);
      if (!isFinite(n) || n <= 0) return null;
      // nflverse stores snap_pct as 0–1; normalize defensively in case
      // the loader ever shifts to 0–100.
      return n <= 1 ? n : n / 100;
    };
    // Snap% as its own narrow column (Keith 2026-05-13: inline-suffix
    // form jammed "2 100%" into a single right-aligned cell — header
    // said only "Wk" so the snap rate looked unlabelled and the week
    // numbers no longer aligned with the column heading).
    var snapCellHtml = function (pct) {
      if (pct == null) return '<td class="num muted">—</td>';
      return '<td class="num" title="Snap rate (' + (snapSide === "def" ? "defense" : "offense") + ')">'
        + Math.round(pct * 100) + '%</td>';
    };

    var renderScoring = function (seasonVal) {
      var weeks = ((bundle && bundle.weekly_by_season) || {})[seasonVal] || [];
      if (!weeks.length) {
        logEl.innerHTML = '<p class="small muted">No MFL weekly data for this season.</p>';
        return;
      }
      var sorted = weeks.slice().sort(function (a, b) { return a.week - b.week; });
      var starts = 0, elite = 0, plus = 0, dud = 0, pts = 0;
      sorted.forEach(function (w) {
        if (w.status === "starter") starts++;
        if (w.week_tier === "Elite") elite++;
        if (w.week_tier === "Plus") plus++;
        if (w.week_tier === "Dud") dud++;
        pts += (w.score || 0);
      });
      var tot = sorted.length;
      var rows = sorted.map(function (w) {
        var playoffTag = w.is_reg === 0 ? ' <span class="small" style="color:#5b8dff;font-weight:600;" title="Playoffs">P</span>' : "";
        return '<tr' + (w.is_reg === 0 ? ' style="background:rgba(255,158,77,0.06);"' : "") + '>'
          + '<td class="num">' + w.week + playoffTag + '</td>'
          + (snapSide ? snapCellHtml(snapPctForWeek(w.season, w.week)) : "")
          + '<td class="num">' + (w.score != null ? w.score.toFixed(1) : "—") + '</td>'
          + '<td class="num">' + (w.z_score != null ? (w.z_score > 0 ? "+" : "") + w.z_score.toFixed(2) : "—") + '</td>'
          + '<td>' + (w.week_tier ? '<span class="tier ' + weekTierClass(w.week_tier) + '">' + w.week_tier + '</span>' : "—") + '</td>'
          + '<td>' + escapeHtml(w.status || "") + '</td>'
          + '<td class="small">' + escapeHtml(w.roster_franchise_name || "") + '</td>'
          + '<td class="num">' + (w.pos_rank || "—") + '</td>'
          + '</tr>';
      }).join("");
      logEl.innerHTML = '<div class="small muted" style="margin-bottom:6px;">'
        + tot + ' games · ' + starts + ' MFL starts · ' + pts.toFixed(1) + ' pts (' + (pts/tot).toFixed(1) + ' ppg)'
        + ' · Elite ' + elite + ' (' + (elite/tot*100).toFixed(0) + '%) · Plus ' + plus + ' (' + (plus/tot*100).toFixed(0) + '%) · Dud ' + dud + ' (' + (dud/tot*100).toFixed(0) + '%)'
        + '</div>'
        + '<table class="rdh-table"><thead><tr>'
        + '<th class="num">Wk</th>'
        + (snapSide ? '<th class="num" title="Snap rate (' + (snapSide === "def" ? "defense" : "offense") + ')">Snap%</th>' : "")
        + '<th class="num">Pts</th><th class="num">z</th><th>Week Tier</th><th>MFL Status</th><th class="small">Team</th><th class="num">Pos Rk</th>'
        + '</tr></thead><tbody>' + rows + '</tbody></table>';
    };

    var renderRaw = function (seasonVal) {
      var weeks = ((bundle && bundle.nfl_weekly_by_season) || {})[seasonVal] || [];
      if (!weeks.length) {
        logEl.innerHTML = '<p class="small muted">No NFL weekly data for this season.</p>';
        return;
      }
      var sorted = weeks.slice().sort(function (a, b) { return a.week - b.week; });
      var pg = detectPosGroup(bundle);
      var tmpl = GL_TMPL[pg] || GL_TMPL.skill;
      var snapBy = (bundle && bundle.nfl_snaps_by_week) || {};
      var header = '<th class="num">Wk</th><th>Team</th><th>Opp</th>';
      if (tmpl.snap) header += '<th class="num">Snaps</th><th class="num">Snap%</th>';
      for (var hi = 0; hi < tmpl.cols.length; hi++) {
        var col = tmpl.cols[hi];
        header += '<th class="num"' + (col.title ? ' title="' + col.title.replace(/"/g, "&quot;") + '"' : "") + '>' + col.label + '</th>';
      }
      var rows = sorted.map(function (w) {
        var snapRow = snapBy[w.season + "-" + w.week] || {};
        var snapCount = tmpl.snap === "def" ? snapRow.def_snaps : tmpl.snap === "off" ? snapRow.off_snaps : null;
        var snapPct   = tmpl.snap === "def" ? snapRow.def_snap_pct : tmpl.snap === "off" ? snapRow.off_snap_pct : null;
        // Raw view already carries dedicated Snaps + Snap% columns
        // (see tmpl.snap branch below) — no inline suffix needed.
        var cells = '<td class="num">' + w.week + '</td><td>' + escapeHtml(w.team || "") + '</td><td>' + escapeHtml(w.opponent || "") + '</td>';
        if (tmpl.snap) {
          cells += rawFormatCell(snapCount, "int");
          cells += rawFormatCell(snapPct, "pct0");
        }
        for (var ci = 0; ci < tmpl.cols.length; ci++) {
          var c2 = tmpl.cols[ci];
          var v = c2.compute ? c2.compute(w) : w[c2.key];
          cells += rawFormatCell(v, c2.format || "int");
        }
        return '<tr>' + cells + '</tr>';
      }).join("");
      logEl.innerHTML = '<div class="small muted" style="margin-bottom:6px;">'
        + 'Template: <strong>' + tmpl.label + '</strong>. ' + sorted.length + ' games · NFL weekly box score via nflverse.'
        + '</div>'
        + '<table class="rdh-table"><thead><tr>' + header + '</tr></thead><tbody>' + rows + '</tbody></table>';
    };

    var currentView = function () {
      try { return sessionStorage.getItem("upm.gamelog.view") || "scoring"; } catch (e) { return "scoring"; }
    };
    var applyView = function () {
      var v = currentView();
      var vbtns = body.querySelectorAll("[data-gamelog-view]");
      for (var i = 0; i < vbtns.length; i++) {
        vbtns[i].setAttribute("aria-pressed", vbtns[i].getAttribute("data-gamelog-view") === v ? "true" : "false");
      }
      if (v === "raw") renderRaw(seasonSel.value);
      else renderScoring(seasonSel.value);
    };
    var vbtns = body.querySelectorAll("[data-gamelog-view]");
    for (var i = 0; i < vbtns.length; i++) {
      (function (btn) {
        btn.addEventListener("click", function () {
          try { sessionStorage.setItem("upm.gamelog.view", btn.getAttribute("data-gamelog-view")); } catch (e) {}
          applyView();
        });
      })(vbtns[i]);
    }
    seasonSel.addEventListener("change", applyView);
    applyView();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // MAIN ENTRY POINT
  // ─────────────────────────────────────────────────────────────────────────
  function openPlayerProfile(pid, ctx) {
    ctx = ctx || {};
    if (!pid) return;

    // Resolve name + pos for header eagerly from ctx data.
    var name = "Player #" + pid;
    var pos = "";
    var nflTeam = "";
    var prospectRow = lookupProspect(pid, ctx);
    if (prospectRow.player_id) {
      name = prospectRow.name || name;
      pos = prospectRow.position || "";
      nflTeam = prospectRow.nfl_team || "";
    }
    var histPick = lookupHistPick(pid, ctx);
    if (histPick.player_id) {
      name = histPick.player_name || name;
      pos = histPick.position || pos;
    }
    if (ctx.playerInfo) {
      name = ctx.playerInfo.name || name;
      pos = ctx.playerInfo.position || pos;
      nflTeam = ctx.playerInfo.team || nflTeam;
    }
    var posDisplay = posCombined(pos);

    var header = ctx.hideHeader
      ? ""
      : '<h3>' + escapeHtml(name)
        + ' <span class="small muted" style="font-weight:400">' + escapeHtml(posDisplay)
        + (nflTeam ? ' · ' + escapeHtml(nflTeam) : "") + '</span></h3>';

    var loadingHtml = header
      + '<div id="upm-profile-body"><p class="small muted" style="padding:30px; text-align:center;">Fetching profile from MFL…</p></div>'
      + (ctx.hideCloseButton ? "" : '<div class="actions"><button class="btn secondary" id="upm-close-btn">Close</button></div>');

    var bodyEl;
    if (ctx.mountNode && ctx.mountNode.nodeType === 1) {
      // Inline-render mode: the caller (e.g., Roster Workbench) owns its
      // own modal shell. We render INTO their mount node, with our scoped
      // CSS classes attached so styling still applies. Caller controls
      // open/close, action buttons above us, etc.
      ensureStyles();
      var wrapper = document.createElement("div");
      wrapper.className = "upm-modal upm-modal-inline";
      wrapper.innerHTML = loadingHtml;
      ctx.mountNode.innerHTML = "";
      ctx.mountNode.appendChild(wrapper);
      bodyEl = wrapper;
    } else {
      // Overlay mode: build our own #upm-overlay over the page.
      bodyEl = openModalHtml(loadingHtml);
    }

    var closeBtn = bodyEl.querySelector("#upm-close-btn");
    if (closeBtn) closeBtn.addEventListener("click", closeModal);

    fetchBundle(pid, ctx).then(function (bundle) {
      bundle = bundle || {};
      // Scope the body lookup to the rendered wrapper so inline-render
      // mode doesn't accidentally pick a sibling instance.
      var bodyContent = bodyEl.querySelector("#upm-profile-body")
        || document.getElementById("upm-profile-body");
      if (!bodyContent) return;

      var bundleError = !bundle.profile && !bundle.career_summary && !bundle.contract_history && !bundle.weekly_by_season;
      var errorBanner = bundleError
        ? '<div class="small" style="margin-bottom:8px; padding:6px 8px; background:#3a1a1a; color:#ffb1b1; border:1px solid #5a2a2a; border-radius:4px;">'
            + 'Live MFL profile data unavailable. '
            + (bundle._fetchError
              ? '<code style="background:#1a2230;padding:1px 4px;border-radius:3px;">' + escapeHtml(bundle._fetchError) + '</code>'
              : 'Bundle returned empty.')
            + (bundle._fetchUrl
              ? ' <span class="muted" style="font-size:11px;">URL: ' + escapeHtml(bundle._fetchUrl.slice(0, 110)) + (bundle._fetchUrl.length > 110 ? '…' : '') + '</span>'
              : '')
          + '</div>'
        : "";

      var pp = (bundle.profile && bundle.profile.playerProfile && bundle.profile.playerProfile.player) || {};
      var career = bundle.career_summary || [];
      var showCollege = showCollegePanels(pp, ctx);
      var isFreshRookie = showCollege && !career.length;

      // Caller (e.g., Roster Workbench) doesn't always supply a real
      // name in ctx.playerInfo — falls back to "Player #16175" which
      // then leaks into YouTube search URLs ("Player #16175 CHI
      // highlights"). Re-derive from MFL profile if we have it. MFL
      // stores names as "Last, First Suffix" → reorder for display.
      if (pp && pp.name && /^Player #\d+$/.test(name)) {
        var mflName = String(pp.name);
        if (mflName.indexOf(",") >= 0) {
          var parts = mflName.split(",");
          var last = (parts[0] || "").trim();
          var firstRest = (parts[1] || "").trim();
          if (last && firstRest) name = firstRest + " " + last;
          else name = mflName;
        } else {
          name = mflName;
        }
      }
      // Also pick up MFL team for YT/NFL fallback when caller didn't.
      if (!nflTeam && pp && pp.team) nflTeam = pp.team;

      var bioHtml = buildBioHtml(bundle, ctx, pid, name, nflTeam);

      // Fresh rookies: Bio-only (Stats/Game Log/News are empty noise).
      if (isFreshRookie) {
        bodyContent.innerHTML = errorBanner + bioHtml
          + '<div class="small muted" style="margin-top:10px; text-align:right;">MFL ID: ' + escapeHtml(String(pid)) + '</div>';
        return;
      }

      var statsHtml = buildStatsPanelHtml(bundle, ctx, pid, name);
      var gameLogHtml = buildGameLogPanelHtml(bundle);
      var newsHtml = buildNewsHtml(bundle, ctx, pid);
      // Contract Options tab — visible only when caller supplies HTML.
      // Roster Workbench (mode: "roster_workbench") passes its extension
      // options + rookie-option summaries via ctx.contractOptionsHtml.
      // Rookie Draft / Front Office leave it empty → tab hides itself.
      var showContractOptions = hasContractOptions(ctx);
      var contractOptionsHtml = showContractOptions ? buildContractOptionsHtml(ctx) : "";

      // Initial tab — Bio by default, or ctx.openTab when supplied
      // (Roster Workbench's news-icon click opens directly to News).
      var allowedTabs = { bio: 1, stats: 1, gamelog: 1, "contract-options": showContractOptions ? 1 : 0, news: 1 };
      var openTab = ctx.openTab && allowedTabs[ctx.openTab] ? ctx.openTab : "bio";
      function tabAttrs(name) {
        return 'aria-selected="' + (openTab === name ? "true" : "false") + '" data-upm-tab="' + name + '"';
      }
      function panelAttrs(name) {
        return 'class="upm-tab-panel" data-upm-panel="' + name + '"' + (openTab === name ? '' : ' hidden');
      }

      bodyContent.innerHTML = errorBanner
        + '<nav class="upm-view-switch" role="tablist" aria-label="Player profile sections">'
        + '<button type="button" role="tab" ' + tabAttrs("bio") + '>Bio</button>'
        + '<button type="button" role="tab" ' + tabAttrs("stats") + '>Stats</button>'
        + '<button type="button" role="tab" ' + tabAttrs("gamelog") + '>Game Log</button>'
        + (showContractOptions
          ? '<button type="button" role="tab" ' + tabAttrs("contract-options") + '>Contract Options</button>'
          : '')
        + '<button type="button" role="tab" ' + tabAttrs("news") + '>News</button>'
        + '</nav>'
        + '<div ' + panelAttrs("bio") + '>' + bioHtml + '</div>'
        + '<div ' + panelAttrs("stats") + '>' + statsHtml + '</div>'
        + '<div ' + panelAttrs("gamelog") + '>' + gameLogHtml + '</div>'
        + (showContractOptions
          ? '<div ' + panelAttrs("contract-options") + '>' + contractOptionsHtml + '</div>'
          : '')
        + '<div ' + panelAttrs("news") + '>' + newsHtml + '</div>'
        + '<div class="small muted" style="margin-top:10px; text-align:right;">MFL ID: ' + escapeHtml(String(pid)) + '</div>';

      wireTabs(bodyContent);
      wireStatsToggle(bodyContent, bundle);
      wireWindowSelector(bodyContent, bundle);
      wireGameLog(bodyContent, bundle);
      // News feed kicks off async — placeholder shows until /api/player-news
      // returns. Defensive: skip silently if pid is empty.
      wireNewsAsync(bodyContent, ctx, pid);
    }).catch(function (err) {
      var bodyContent = bodyEl.querySelector("#upm-profile-body")
        || document.getElementById("upm-profile-body");
      if (bodyContent) {
        bodyContent.innerHTML = '<p class="small muted" style="padding:20px;">Profile lookup failed: '
          + escapeHtml(err && err.message ? err.message : String(err))
          + '<br><br>MFL ID: ' + escapeHtml(String(pid)) + '</p>';
      }
    });
  }

  // Expose
  window.UPS_openPlayerProfile = openPlayerProfile;
  window.UPS_closePlayerProfile = closeModal;
})();
