/* Front Office v2 — state machine + renderers
 *
 * Checkpoint 1 (2026-05-19): scaffold + Roster tab end-to-end + universal
 * right-side slide-over modal pattern + one fully-wired submit (Extension)
 * proving the byte-for-byte mirror from roster_workbench.js works through
 * the new chrome. Cap Plan / Tagging / Activity tabs are stubs until Keith
 * signs off on the look-and-feel.
 *
 * Submit paths are SACRED — they mirror site/rosters/roster_workbench.js
 * verbatim per CROSS_CODEBASE_ALIGNMENT.md §2 and memory
 * feedback_roster_workbench_is_truth_not_ccc.md. Renderers are new.
 *
 * URL overrides (off-MFL local testing):
 *   ?worker_base=...       worker origin (defaults to prod)
 *   ?franchise_id=0001     viewer franchise (no HPM injection needed)
 *   ?dry_run=1             every submit gets {dry_run: 1}; no MFL writes
 *   ?L=74598 &YEAR=2026    league + season (defaults: 74598, current year)
 */
(function () {
  "use strict";

  // ── URL overrides + worker resolution ───────────────────────────────
  const QS = (function () {
    try { return new URL(window.location.href).searchParams; } catch (e) { return new URLSearchParams(); }
  })();

  const WORKER_BASE = (function () {
    const override = QS.get("worker_base");
    if (override) return String(override).replace(/\/$/, "");
    if (typeof window.UPS_FO_API_BASE === "string" && window.UPS_FO_API_BASE) {
      return String(window.UPS_FO_API_BASE).replace(/\/$/, "");
    }
    if (typeof window.UPS_RWB_API_BASE === "string" && window.UPS_RWB_API_BASE) {
      return String(window.UPS_RWB_API_BASE).replace(/\/$/, "");
    }
    return "https://upsmflproduction.keith-creelman.workers.dev";
  })();

  // FO's own asset base. Relative data fetches (VERSION.json,
  // ../player_acquisition_lookup, ../../ccc/tag_tracking.json,
  // ../contract_submissions/*) must resolve against GitHub Pages when FO runs
  // INSIDE MFL's HPM embed (page origin = MFL, not Pages). We derive the base
  // from FO's own <script> src — works for the loader's async-injected tag
  // (document.currentScript is null there) AND the standalone body-end tag, so
  // both contexts behave identically. Standalone simply resolves relatives
  // against the same dir they already lived in.
  const ASSET_BASE = (function () {
    function dirOf(src) { try { return new URL(".", src).toString(); } catch (e) { return ""; } }
    try {
      var tags = document.querySelectorAll('script[src]');
      for (var i = tags.length - 1; i >= 0; i -= 1) {
        if (/front_office\.js(\?|$)/.test(tags[i].src || "")) return dirOf(tags[i].src);
      }
    } catch (e) {}
    try { if (document.currentScript && document.currentScript.src) return dirOf(document.currentScript.src); } catch (e) {}
    if (typeof window.UPS_FO_ASSET_BASE === "string" && window.UPS_FO_ASSET_BASE) return dirOf(window.UPS_FO_ASSET_BASE);
    return "";
  })();
  // Resolve a possibly-relative asset URL against ASSET_BASE. Absolute http(s)/
  // protocol-relative/root-relative URLs (worker apiUrl(), etc.) pass through.
  function assetUrl(u) {
    if (!u) return u;
    if (/^https?:\/\//i.test(u) || u.indexOf("//") === 0 || u.charAt(0) === "/") return u;
    if (!ASSET_BASE) return u;
    try { return new URL(u, ASSET_BASE).toString(); } catch (e) { return u; }
  }

  const LEAGUE_ID = QS.get("L") || QS.get("league_id") || "74598";
  const SEASON    = QS.get("YEAR") || QS.get("year") || String(new Date().getUTCFullYear());
  const IS_DRY_RUN = (function () {
    const q = (QS.get("dry_run") || QS.get("DRY_RUN") || "").toLowerCase();
    if (q === "1" || q === "true" || q === "yes") return true;
    return !!window.UPS_FO_DRY_RUN || !!window.UPS_RWB_DRY_RUN;
  })();

  function viewerFranchiseId() {
    const fromQs = QS.get("franchise_id");
    if (fromQs) return pad4(fromQs);
    if (window.UPS_FO_FRANCHISE_ID) return pad4(window.UPS_FO_FRANCHISE_ID);
    if (window.UPS_RWB_FRANCHISE_ID) return pad4(window.UPS_RWB_FRANCHISE_ID);
    if (window.UPS_HPM_FRANCHISE_ID) return pad4(window.UPS_HPM_FRANCHISE_ID);
    // MFL exposes the LOGGED-IN franchise on owner pages — login-scoped, so it
    // distinguishes Keith's 0000 commish login from his 0008 team. The
    // MFLPlayerPopup cookie below CANNOT (it sticks to the last team-popup
    // context, which is why it always returned 0008). Prefer these when present.
    const mflGlobal = pad4((window.FRANCHISE_ID != null ? window.FRANCHISE_ID : window.franchise_id) || "");
    if (mflGlobal) return mflGlobal;
    try {
      const m = String(window.location.pathname || "").match(/\/home\/\d+\/(\d{1,4})(?:\/|$)/i);
      if (m && m[1]) return pad4(m[1]);
    } catch (e) {}
    // Last resort: MFLPlayerPopup cookie (ambiguous for dual-identity logins).
    const fromCookie = franchiseIdFromCookies(LEAGUE_ID, SEASON);
    if (fromCookie) return pad4(fromCookie);
    return null;
  }

  // MFL writes a MFLPlayerPopup_{year}_{league}_{franchise} cookie keyed to the
  // logged-in owner's own team. Ported verbatim from roster_workbench.js so the
  // embedded FO knows "who am I" without a ?franchise_id= param.
  function getCookieString() {
    try { return safeStr(document.cookie || ""); } catch (e) { return ""; }
  }
  function franchiseIdFromCookies(leagueId, year) {
    var lid = safeStr(leagueId).replace(/\D/g, "");
    if (!lid) return "";
    var yy = safeStr(year).replace(/\D/g, "");
    var raw = getCookieString();
    if (!raw) return "";
    var re = /(?:^|;\s*)MFLPlayerPopup_(\d{4})_(\d+)_(\d{1,4})=/g;
    var m, hits = [];
    while ((m = re.exec(raw))) {
      var hitLeague = safeStr(m[2]).replace(/\D/g, "");
      var hitFranchise = pad4(m[3]);
      if (!hitLeague || hitLeague !== lid) continue;
      if (!hitFranchise || hitFranchise === "0000") continue;
      hits.push({ year: safeStr(m[1]), franchiseId: hitFranchise });
    }
    if (!hits.length) return "";
    if (yy) {
      for (var i = 0; i < hits.length; i += 1) {
        if (hits[i].year === yy) return hits[i].franchiseId;
      }
    }
    hits.sort(function (a, b) { return safeInt(b.year, 0) - safeInt(a.year, 0); });
    return hits[0].franchiseId;
  }

  // ── Viewer session forwarding ───────────────────────────────────────
  // Ported from roster_workbench.js appendViewerSessionQuery(). FO v2 shipped
  // WITHOUT it, and the failure mode was invisible: with no MFL_USER_ID the
  // worker falls back to its stored commish MFL_COOKIE, and MFL answers an
  // owner-scoped import (drop / IR / taxi) sent under a commish cookie with
  // HTTP 200 and NO state change. So FO v2's Drop button "succeeded" every
  // time and never dropped anybody, while Roster Workbench and mobile — both
  // of which forward the session — worked. Every /roster-workbench/action POST
  // must go through appendViewerSessionQuery().
  function readCookieValue(name) {
    try {
      const m = getCookieString().match(new RegExp("(?:^|;\\s*)" + name + "=([^;]+)"));
      return m ? decodeURIComponent(m[1]) : "";
    } catch (e) { return ""; }
  }
  function resolveApiKey() {
    const candidates = [
      window.UPS_MFL_APIKEY,
      window.MFL_APIKEY,
      window.APIKEY,
      readCookieValue("MFL_APIKEY")
    ];
    for (let i = 0; i < candidates.length; i += 1) {
      const k = safeStr(candidates[i]);
      if (k) return k;
    }
    return "";
  }
  function appendViewerSessionQuery(url) {
    try {
      const next = new URL(String(url), window.location.href);
      const mflUserId = readCookieValue("MFL_USER_ID");
      const apiKey = resolveApiKey();
      if (mflUserId) next.searchParams.set("MFL_USER_ID", mflUserId);
      if (apiKey) next.searchParams.set("APIKEY", apiKey);
      return next.toString();
    } catch (e) { return String(url); }
  }

  const apiUrl = (p) => WORKER_BASE + p;

  // Mirror roster_workbench.js endpoint resolvers (byte-for-byte targets).
  const EP_ROSTER          = () => apiUrl("/roster-workbench");
  const EP_ROSTER_ACTION   = () => apiUrl("/roster-workbench/action");
  const EP_ADMIN_STATE     = () => apiUrl("/roster-workbench/admin-state");
  const EP_CONTRACT_UPDATE = () => apiUrl("/commish-contract-update");
  const EP_RESTRUCTURE     = () => apiUrl("/offer-restructure");
  const EP_PLAYER_NEWS     = () => apiUrl("/api/player-news");
  const EP_PLAYER_BUNDLE   = () => apiUrl("/api/player-bundle");
  // Relative to this file's location (site/rosters/v2/) — fetches the
  // commish-maintained per-season acquisition lookup that feeds taxi
  // §A1.4 salary derivation and the "Acquired via" line in Bio.
  const URL_ACQUISITION_LOOKUP = (yr) => "../player_acquisition_lookup_" + encodeURIComponent(yr) + ".json";
  // (Cap adjustments now load straight from MFL's salaryAdjustments feed —
  // see loadMflSalaryAdjustments. The old /reports/salary_adjustments JSON
  // was empty for 2025-2026, so it's no longer used here.)
  // Tag plan data — same sources live FO uses
  // (roster_workbench.js:2745 resolveTagTrackingUrl / :2768 submissions).
  const URL_TAG_TRACKING    = "../../ccc/tag_tracking.json";
  const URL_TAG_SUBMISSIONS = "../../ccc/tag_submissions.json";
  // Activity & Audit feeds — same files live FO embeds in the toolbar.
  const URL_CONTRACT_ACTIVITY = (yr) => "../contract_submissions/contract_activity_" + encodeURIComponent(yr) + ".json";
  const URL_DEADLINES         = (yr) => "../contract_submissions/deadline_reminders_" + encodeURIComponent(yr) + ".json";
  // Rookie-draft history JSON published by the Rookie Draft Hub. Has
  // EVERY UPS rookie pick 2012-2025 with pid, season, round, slot,
  // pick_label, salary. Keith 2026-05-19: the source-of-truth for
  // taxi-rookie salary derivation when worker fields + acquisition
  // lookup come up empty (Mayer / Bennett / Wilson Tyree etc.).
  const URL_ROOKIE_HISTORY = "../../rookies/rookie_draft_history.json";

  function fetchJSON(url, opts) {
    // assetUrl() rebases relative JSON paths onto Pages in the embed; absolute
    // worker URLs (apiUrl(...)) pass through unchanged.
    return fetch(assetUrl(url), Object.assign({ cache: "no-store" }, opts || {})).then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status + " " + url);
      return r.json();
    });
  }

  // ── State ───────────────────────────────────────────────────────────
  const STATE = {
    version: null,
    me: null,           // { configured, franchise_id, franchise_name, isAdmin }
    nflStatus: {},      // pid -> MFL injury status string ("Questionable", "Out", ...)
    newsFlags: {},      // pid -> "injury" | "news" when the player has a news item
    contractDeadline: null, // ISO date of the Sept contract deadline (league_events)
    // Sept contract deadline as a real unix instant (ms) — set from
    // contractDeadlineDateFO() in loadContractDeadline, alongside the ISO day
    // above. null = unresolved. Feeds contractLadderStageFO_desktop.
    contractDeadlineMs: null,
    // NFL Week 1 / 3 / 5 first-kickoff instants (epoch ms), read from
    // /api/league-events&kickoffs=1,3,5 — the worker resolves these off
    // MFL's OWN nflSchedule (the same helper the Discord waiver post and
    // mobile's contractLadder use), not a hand-typed calendar row, so all
    // three surfaces describe the same instant. null = unresolved; an
    // older/failed response leaves these null rather than fabricating a
    // number. See loadContractDeadline / isPreseasonWwPickupFO.
    weekKickoffs: { 1: null, 3: null, 5: null },
    capAmount: 0,
    teams: [],          // worker payload normalized
    activeTab: "roster",
    // Active subview under the Contracts parent tab (Auction/Extensions/
    // Restructures/MYM/Tagging). Defaults to Auction.
    contractsSubtab: "myac",
    // MYM test mode (?mymtest=1) — surfaces the §C3 MYM action on ANY player so
    // the commish can exercise the wiring out of season; the form then forces a
    // dry run (no live MFL write). See renderActionsTab / submitMymContract.
    mymTest: (QS.get("mymtest") === "1" || QS.get("mymTest") === "1"),
    selectedTeamId: "__all__",
    search: "",
    filters: { pos: "ALL", type: "", status: "", years: "", action: "", loaded: false },
    // userChosen flips the first time the commish clicks a column header.
    // Until then the By-Position view uses its own default row order
    // (status then name — see orderGroupRows); after it, the clicked column
    // wins as the secondary key inside each position group.
    sort: { key: "salary", dir: -1, userChosen: false },
    groupByPosition: true,   // Roster defaults to By Position (Keith 2026-06-06)
    capSubview: "summary",
    miscSubview: "log",   // Misc tab: "log" (Contract Log) | "glossary"
    capFocusedTeamFid: null,
    // Per-player preview state in Cap Plan Detail. Key = "pid:fid",
    // value = "ext1" | "ext2" | "myac2" | "myac3" | "myacl2" | "myacl3" |
    // "drop" | "promote" | "restructure". Toggling re-runs the projection.
    // Values are PLAIN STRINGS on purpose — every consumer compares
    // with === (=== "drop", === "promote", …), so a preview that needs to carry
    // extra state parks it in a parallel map instead of boxing this one.
    capPreviews: Object.create(null),
    // Restructure-preview drafts, keyed the SAME "pid:fid" way:
    //   { amounts: [y1, y2, y3?] }   ← raw dollars, one entry per remaining year
    // Only meaningful while capPreviews[key] === "restructure"; cleared in
    // lockstep with the preview (clearCapRestructureDraft) so a stale draft can
    // never resurface on a later toggle.
    capRestructureDrafts: Object.create(null),
    // Loaded-MYAC (§C2) preview drafts — same "pid:fid" key, same lockstep
    // clearing rule (clearCapMyacLoadedDraft):
    //   { kind: "myacl2" | "myacl3", amounts: [y1, y2, y3?] }
    // `kind` is carried so a 2-year draft can never be read as a 3-year one
    // when the owner switches lengths on the same row.
    capMyacLoadedDrafts: Object.create(null),
    // Last saved-scenario action for the Cap Detail view, so the screen can say
    // whether what's showing is a RESTORED plan or live working state:
    //   { fid, kind: "saved"|"restored", at, applied: [names], dropped: [{name,why}], edited }
    // `edited` flips the moment a preview is toggled after a restore. Null =
    // nothing restored/saved this session for the focused team.
    capScenarioNotice: null,
    // Summary table filters (aggregate across teams).
    capSummaryFilters: { pos: "ALL", type: "", years: "", status: "" },
    capSummarySort: { key: "totalSalary", dir: -1 },
    // Cap Plan Detail — stable player order so toggling previews doesn't
    // reshuffle rows (Keith 2026-05-19). Only changes when user clicks
    // a header. Recomputed when team changes.
    capDetailSort: { key: "y0", dir: -1 },
    capDetailOrder: [],
    capDetailOrderForFid: null,
    // Tagging tab state — loaded from /ccc/tag_tracking.json +
    // tag_submissions.json (same sources live FO uses, see
    // roster_workbench.js:2745+ resolveTagTrackingUrl).
    tagData: null,            // { rows, meta, submissions } when loaded
    tagDataLoading: false,
    tagDataError: "",
    // Live in-season points-rank data for the PROJECTED tag year's tier
    // assignment — see loadTagPointsData().
    tagPointsData: null,      // { rankByPid, maxGames, season } when loaded
    tagPointsDataLoading: false,
    tagPointsDataError: "",
    tagSort: { key: "tagSalary", dir: -1 },
    tagFilter: { pos: "ALL", side: "ALL", franchise: "", search: "" },
    // Optimistic dry-run state. In dry-run mode the worker doesn't
    // persist tags/untags to MFL, so loadRosterData() afterwards still
    // sees the old type. We track "just tagged" / "just untagged"
    // locally so the Tag↔Untag button flips visibly during the test
    // session. Cleared on hard reload. Keys: "pid:fid".
    optimisticTags:  Object.create(null),
    optimisticUntags: Object.create(null),
    // Activity & Audit tab
    activityData: null,
    activityLoading: false,
    activitySort: { key: "submitted", dir: -1 },
    activityFilter: { type: "", franchise: "", search: "" },
    deadlines: null,
    tagSubview: "players",
    // Calc Breakdown year selector. The 2026 tag deadline has passed, so the
    // forward-looking projection (2027) is the default. SEASON+1 set at init.
    tagBreakdownYear: null,
    // Slide-over state
    slideoverPid: null,
    slideoverFid: null,
    slideoverSubtab: "actions",   // open player profile on Actions (Keith 2026-06-07: Bio redundant w/ header)
    extensionPreview: Object.create(null), // "{pid}:{fid}" → years
  };

  // ── Tiny utils ──────────────────────────────────────────────────────
  function pad4(v) {
    var s = String(v == null ? "" : v).replace(/[^0-9]/g, "");
    if (!s) return "";
    while (s.length < 4) s = "0" + s;
    return s.slice(-4);
  }
  function safeStr(v) { return v == null ? "" : String(v); }
  function safeInt(v, d) { var n = parseInt(v, 10); return Number.isFinite(n) ? n : (d || 0); }
  const $  = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  const escapeHtml = (s) =>
    String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  // Display helpers — salaries are stored as RAW DOLLARS in the worker
  // payload (Watson Y1 = 2000 = $2,000), not K-units. Keith 2026-05-19:
  // prefer comma-separated full dollars in this table view.
  const fmtUSD = (n) => {
    const v = Number(n);
    if (!Number.isFinite(v)) return "—";
    if (v === 0) return "$0";
    return "$" + Math.round(v).toLocaleString("en-US");
  };
  // K-unit formatter (used inside the slide-over and chip sub-text, where
  // canon's "$15K rookie scale" lingo reads naturally). Mirrors
  // formatContractK at roster_workbench.js:361.
  const fmtK = (n) => {
    const dollars = Math.round(Number(n) || 0);
    if (dollars <= 0) return "$0";
    const k = dollars / 1000;
    const text = Math.round(k * 10) / 10;
    return "$" + String(text).replace(/\.0$/, "") + "K";
  };
  const fmtDateTime = (iso) => {
    if (!iso) return "—";
    try { return new Date(iso).toLocaleString(); } catch (e) { return iso; }
  };

  // ── Canonical contract-info parsers (byte-for-byte mirror of
  //     roster_workbench.js — see CROSS_CODEBASE_ALIGNMENT.md §2). All
  //     downstream cap math derives from these; do not branch logic.
  function parseContractMoneyToken(token) {
    var raw = safeStr(token).toUpperCase().replace(/\$/g, "");
    if (!raw) return 0;
    var cleaned = raw.replace(/[^0-9K.\-]/g, "");
    if (!cleaned) return 0;
    var mult = cleaned.indexOf("K") !== -1 ? 1000 : 1;
    cleaned = cleaned.replace(/K/g, "");
    if (!cleaned) return 0;
    var num = Number(cleaned);
    if (!isFinite(num)) return 0;
    var amount = Math.round(num * mult);
    if (mult === 1 && amount > 0 && amount < 1000) amount *= 1000;
    return amount;
  }
  function parseContractTcvValue(contractInfo) {
    var info = safeStr(contractInfo);
    if (!info) return 0;
    var match = info.match(/(?:^|\|)\s*TCV\s+([^|]+)/i);
    return match && safeStr(match[1]) ? parseContractMoneyToken(match[1]) : 0;
  }
  function parseContractLengthValue(contractInfo) {
    var info = safeStr(contractInfo);
    if (!info) return 0;
    var match = info.match(/(?:^|\|)\s*CL\s*:?\s*(\d+)/i);
    return match && safeStr(match[1]) ? Math.max(0, safeInt(match[1], 0)) : 0;
  }
  function parseContractYearValues(contractInfo) {
    var info = safeStr(contractInfo);
    var out = Object.create(null);
    if (!info) return out;
    var re = /Y(\d+)\s*-\s*([0-9]+(?:\.[0-9]+)?K?)(?=\s*(?:,|\||Y\d+\s*-|$))/ig;
    var match;
    while ((match = re.exec(info))) {
      var idx = safeInt(match[1], 0);
      var amount = parseContractMoneyToken(match[2]);
      if (idx > 0 && amount > 0) out[idx] = amount;
    }
    return out;
  }
  // "MFL has not said" — the row carries no contractStatus, no contractInfo and
  // no contractYear. This is NOT the same as expired (years 0 with a real
  // status), and it must never be rendered as a contract shape. Every derived
  // column (TCV, CL, Yrs, AAV, GTD) is unknowable for such a row, so they all
  // render "pending" rather than a number computed from nothing.
  //
  // ⚠️ ONE definition, four enforcers that must agree, or a row renders
  // "pending" forever and never qualifies to be stamped:
  //   * worker /roster-workbench (`contract_unknown`, authoritative),
  //   * finalizeWaiverContracts GUARD 1 (all three fields blank before a write),
  //   * this fallback (used only when the payload predates the field), and
  //   * the identical helper in site/rosters/roster_workbench.js — the LIVE
  //     desktop surface, which consumes the same payload.
  //
  // The worker's flag is authoritative and is checked FIRST, because only the
  // worker can see the raw contractYear string: MFL's "" (has not said) and "0"
  // (said the contract is expired) both arrive here already parsed to 0. So the
  // fallback below is deliberately the lossy one — on a stale payload it can
  // call a cy="0" row pending. That is the safe direction: "pending" withholds
  // a claim, where "Expired" would assert one MFL never made, and it corrects
  // itself the moment a current worker payload lands.
  function contractUnknownForPlayer(player) {
    if (!player) return false;
    if (player.contractUnknown === true) return true;
    if (player.contractUnknown === false) return false;
    var t = safeStr(player.type);
    var s = safeStr(player.special);
    return safeInt(player.years, 0) <= 0 &&
           (!t || t === "-") &&
           (!s || s === "-");
  }
  function contractLengthForPlayer(player) {
    var values = parseContractYearValues(player && player.special);
    var keys = Object.keys(values);
    var explicitLength = parseContractLengthValue(player && player.special);
    var parsedLength = keys.length
      ? keys.reduce(function (max, key) { return Math.max(max, safeInt(key, 0)); }, 0)
      : 0;
    return Math.max(parsedLength, explicitLength, Math.max(0, safeInt(player && player.years, 0)));
  }
  function totalContractValueForPlayer(player) {
    var explicitTcv = parseContractTcvValue(player && player.special);
    if (explicitTcv > 0) return explicitTcv;
    var yearValues = parseContractYearValues(player && player.special);
    var keys = Object.keys(yearValues);
    if (keys.length) {
      var total = 0;
      for (var i = 0; i < keys.length; i += 1) total += safeInt(yearValues[keys[i]], 0);
      if (total > 0) return total;
    }
    var length = Math.max(0, contractLengthForPlayer(player));
    var salary = Math.max(0, safeInt(player && player.salary, 0));
    return salary * length;
  }
  // currentCapHit — current-year cap allocation. Mirrors
  // roster_workbench.js:676. Taxi off-cap (§6.E), IR 50% relief (§6.C).
  function currentCapHit(player) {
    if (!player) return 0;
    var amt = safeInt(player.salary, 0);
    var y = Math.max(0, safeInt(player.years, 0));
    if (player.isTaxi) return 0;
    // A contract MFL has not described yet is UNKNOWN, not expired — years
    // reads 0 only because contractYear is blank. The player is rostered and
    // MFL has recorded a real salary, and MFL's cap math is Σ roster salaries,
    // so he must still count. (Mirrors the worker's currentCapHit.)
    if (y <= 0 && !contractUnknownForPlayer(player)) return 0;
    if (player.isIr) return Math.round(amt * 0.5);
    return amt;
  }

  // ── Drop-penalty machinery (mirrors roster_workbench.js byte-for-byte
  //     so v2 numbers match live FO for side-by-side validation).
  //     CROSS_CODEBASE_ALIGNMENT.md §3.2 notes the per-week-prorate
  //     migration (canon §6.B1 2026-05-08) is still tabled in desktop
  //     FO — these helpers use legacy calendar-monthly proration
  //     intentionally so v2 ↔ live FO match. Migration tracked in
  //     memory `project_ww_penalty_prorate_migration.md`.

  function safeNum(v, fallback) {
    var n = Number(v);
    return Number.isFinite(n) ? n : (fallback || 0);
  }
  function money(n) {
    var v = Math.round(safeNum(n, 0));
    var sign = v < 0 ? "-" : "";
    var abs = Math.abs(v);
    try { return sign + "$" + abs.toLocaleString("en-US"); }
    catch (e) { return sign + "$" + String(abs); }
  }
  function formatContractK(amount) {
    var dollars = Math.round(safeNum(amount, 0));
    if (dollars <= 0) return "0K";
    var k = dollars / 1000;
    var text = Math.round(k * 10) / 10;
    return String(text).replace(/\.0$/, "") + "K";
  }
  function roundToK(n) { return Math.round(safeNum(n, 0) / 1000) * 1000; }

  function parseContractAavValues(contractInfo) {
    var info = safeStr(contractInfo);
    if (!info) return [];
    var match = info.match(/(?:^|\|)\s*AAV\s*([^|]+)/i);
    if (!match || !safeStr(match[1])) return [];
    var segment = safeStr(match[1]).replace(/\bY\d+\s*-[^|]*$/i, "");
    return segment.split(/[\/,]/).map(function (token) {
      var m = safeStr(token).match(/-?\d+(?:\.\d+)?K?/i);
      return parseContractMoneyToken(m ? m[0] : "");
    }).filter(function (a) { return a > 0; });
  }
  // Extract the raw AAV token string VERBATIM (e.g. "42K, 52K") so a restructure
  // can preserve the extension's dual AAV byte-for-byte instead of re-averaging
  // TCV/CL (the Cook/London bug). Returns "" when no AAV token is present.
  function parseContractAavRawToken(contractInfo) {
    var info = safeStr(contractInfo);
    if (!info) return "";
    var match = info.match(/(?:^|\|)\s*AAV\s+([^|]+)/i);
    if (!match) return "";
    return safeStr(match[1]).replace(/\bY\d+\s*-[^|]*$/i, "").trim();
  }
  function parseContractGuaranteeValue(contractInfo) {
    var info = safeStr(contractInfo);
    if (!info) return 0;
    var match = info.match(/(?:^|\|)\s*GTD\s*:?\s*([^|]+)/i);
    return match && safeStr(match[1]) ? parseContractMoneyToken(match[1]) : 0;
  }
  function currentAavForContractInfo(contractInfo) {
    var values = parseContractAavValues(contractInfo);
    return values.length ? safeInt(values[0], 0) : 0;
  }
  function displayAavForPlayer(player) {
    var explicit = currentAavForContractInfo(player && player.special);
    if (explicit > 0) return explicit;
    if (player && player.isTaxi && safeInt(player.salary, 0) > 0) return safeInt(player.salary, 0);
    return Math.max(0, safeInt(player && player.aav, 0));
  }
  function contractYearIndexForPlayer(player) {
    var length = contractLengthForPlayer(player);
    var years = Math.max(0, safeInt(player && player.years, 0));
    if (length <= 0 || years <= 0) return 0;
    return Math.max(1, length - years + 1);
  }
  function currentContractYearValue(player) {
    var yv = parseContractYearValues(player && player.special);
    var idx = contractYearIndexForPlayer(player);
    if (idx > 0 && yv[idx] > 0) return safeInt(yv[idx], 0);
    return Math.max(0, safeInt(player && player.salary, 0));
  }
  function contractYearFallbackValue(player, yearIndex) {
    var idx = Math.max(1, safeInt(yearIndex, 1));
    var currentIdx = Math.max(1, contractYearIndexForPlayer(player));
    var length = Math.max(0, contractLengthForPlayer(player));
    var salary = Math.max(0, safeInt(player && player.salary, 0));
    var aavValues = parseContractAavValues(player && player.special);
    var aav = Math.max(0, safeInt(player && player.aav, 0) || currentAavForContractInfo(player && player.special));
    if (idx === currentIdx && salary > 0) return salary;
    if (aavValues[idx - 1] > 0) return safeInt(aavValues[idx - 1], 0);
    if (aavValues.length > 1 && aavValues[aavValues.length - 1] > 0) {
      return safeInt(aavValues[aavValues.length - 1], 0);
    }
    if (aav > 0) return aav;
    var explicitTcv = parseContractTcvValue(player && player.special);
    if (explicitTcv > 0 && length > 0) return Math.round(explicitTcv / Math.max(1, length));
    return salary;
  }
  function contractYearValueMapForPlayer(player) {
    var out = parseContractYearValues(player && player.special);
    if (Object.keys(out).length) return out;
    var length = Math.max(0, contractLengthForPlayer(player));
    for (var i = 1; i <= length; i += 1) {
      var v = contractYearFallbackValue(player, i);
      if (v > 0) out[i] = v;
    }
    return out;
  }
  function guaranteedContractValueForPlayer(player) {
    var explicit = parseContractGuaranteeValue(player && player.special);
    if (explicit > 0) return explicit;
    var total = totalContractValueForPlayer(player);
    if (total <= 0) return 0;
    if (total <= 4000) {
      var first = safeInt(contractYearValueMapForPlayer(player)[1], contractYearFallbackValue(player, 1));
      return Math.max(0, total - Math.max(0, first));
    }
    return Math.round(total * 0.75);
  }
  // Canon §D1 guarantee that drives the cap penalty (Keith 2026-05-22).
  //   • TCV  > $4K → standard 75% of TCV.
  //   • TCV ≤ $4K → OVERRIDE the 75%/earned formula entirely (sub-$5K TCV rule):
  //       years remaining ≥ 2  → fixed $1,000
  //       years remaining ≤ 1 (final year) → $0
  // Used by every contract-CREATION GTD token (MYAC, extension, restructure) so
  // a small 2/3-year deal (e.g. 3-yr Vet-ERA, $1K/yr, TCV $3K) reads GTD $1,000
  // — not $0 (final-year branch) and not 75% (= $2,250).
  function guaranteeForContract(tcv, yearsRemaining) {
    var t = safeInt(tcv, 0);
    if (t > 4000) return Math.round(t * 0.75);
    return safeInt(yearsRemaining, 0) >= 2 ? 1000 : 0;
  }
  function earnedBeforeCurrentContractYear(player) {
    var idx = contractYearIndexForPlayer(player);
    if (idx <= 1) return 0;
    var explicit = parseContractYearValues(player && player.special);
    if (!Object.keys(explicit).length) {
      var length = contractLengthForPlayer(player);
      var total = totalContractValueForPlayer(player);
      var cy = currentContractYearValue(player);
      if (length > 1 && idx >= length && total > cy) {
        return Math.max(0, total - Math.max(0, cy));
      }
    }
    var earned = 0;
    var yv = contractYearValueMapForPlayer(player);
    for (var i = 1; i < idx; i += 1) {
      earned += safeInt(yv[i], contractYearFallbackValue(player, i));
    }
    return earned;
  }
  function seasonEndEstimateDate(season) {
    var yr = safeInt(season, 0);
    if (yr <= 0) return null;
    return new Date(yr, 11, 31, 23, 59, 59, 999);
  }
  function proratedEarnedForDrop(season, amount, dropDate) {
    // Calendar-monthly era (2019-01-01 → 2026-05-07). Per-week canon
    // (effective 2026-05-08) is NOT yet wired in desktop FO; mirroring
    // legacy to keep numbers aligned for side-by-side comparison.
    var yr = safeInt(season, 0);
    var salary = Math.max(0, safeInt(amount, 0));
    if (yr <= 0 || salary <= 0 || !(dropDate instanceof Date) || isNaN(dropDate.getTime())) return 0;
    var milestones = [
      new Date(yr, 8, 30, 23, 59, 59, 999),
      new Date(yr, 9, 31, 23, 59, 59, 999),
      new Date(yr, 10, 30, 23, 59, 59, 999),
      seasonEndEstimateDate(yr)
    ];
    var steps = 0;
    for (var i = 0; i < milestones.length; i += 1) {
      if (milestones[i] && dropDate >= milestones[i]) steps += 1;
    }
    steps = Math.max(0, Math.min(steps, 4));
    return Math.round((salary / 4) * steps);
  }
  function earnedToDateBreakdownForPlayer(player, season, now) {
    var years = Math.max(0, safeInt(player && player.years, 0));
    var total = totalContractValueForPlayer(player);
    if (years <= 0) {
      return { currentYearSalary: 0, priorEarned: total, accrued: 0, earned: total };
    }
    var cys = currentContractYearValue(player);
    var prior = earnedBeforeCurrentContractYear(player);
    var accrued = proratedEarnedForDrop(season, cys, now);
    return { currentYearSalary: cys, priorEarned: prior, accrued: accrued, earned: prior + accrued };
  }
  function acquisitionTextForPlayer(player) {
    return safeStr(player && (
      player.acquisitionText || player.acquisition_text || player.notes ||
      player.acquired || player.acquiredText
    )).toUpperCase();
  }
  function isLikelyWaiverPickup(player) {
    var type = safeStr(player && player.type).toUpperCase();
    var acq = acquisitionTextForPlayer(player);
    return !!(type === "WW" ||
      acq.indexOf("BBID_WAIVER") !== -1 || acq.indexOf("WAIVER") !== -1 ||
      acq.indexOf(" BB ") !== -1 || acq.indexOf("BB $") !== -1 || acq.indexOf("BB$") !== -1);
  }
  function isTagCutPreAuctionAssumption(player, season, now) {
    var type = safeStr(player && player.type).toUpperCase();
    if (type !== "TAG") return false;
    var yr = safeInt(season, 0);
    if (yr <= 0 || !(now instanceof Date) || isNaN(now.getTime())) return false;
    if (now.getFullYear() < yr) return true;
    if (now.getFullYear() > yr) return false;
    return now < new Date(yr, 7, 1, 0, 0, 0, 0);
  }

  // dropPenaltyEstimate — mirrors roster_workbench.js:1903. Returns the
  // §D1 (TCV × 75% − Earned) cut cost, plus tax-pickup short-circuits.
  function dropPenaltyEstimate(player) {
    var years = Math.max(0, safeInt(player && player.years, 0));
    var season = safeInt(SEASON, 0);
    var now = new Date();
    var tcv = totalContractValueForPlayer(player);
    var br = earnedToDateBreakdownForPlayer(player, season, now);
    var guaranteed = guaranteedContractValueForPlayer(player);
    var contractLength = Math.max(0, contractLengthForPlayer(player));

    if (years <= 0) return { amount: 0, tcv: tcv, guaranteed: guaranteed, earned: br.earned,
      note: "Expired contracts do not carry a projected cap penalty." };
    if (player && player.isTaxi) return { amount: 0, tcv: tcv, guaranteed: guaranteed, earned: br.earned,
      note: "Taxi players carry no current cap penalty (§6.E)." };
    if (isTagCutPreAuctionAssumption(player, season, now)) return { amount: 0, tcv: tcv, guaranteed: guaranteed, earned: br.earned,
      note: "Pre-auction tag cut: penalty $0. Standard earned-salary rules apply once auction opens." };

    // Sub-$5K TCV rule (canon §D1, Keith 2026-05-22): for ANY deal with TCV ≤ $4K,
    // the standard guaranteed-minus-earned formula is OVERRIDDEN — 2+ years
    // remaining → fixed $1K, final year (≤1) → $0. Catches small multi-year MYACs
    // (e.g. a 3-yr Vet-ERA $1K/yr / TCV $3K) the generic formula would mis-price.
    // The 1-yr $4K–$5K band stays with the §D2.1 check below (threshold is salary
    // < $5K, not TCV ≤ $4K).
    if (tcv <= 4000) {
      return years >= 2
        ? { amount: 1000, tcv: tcv, guaranteed: guaranteed, earned: br.earned,
            note: "Sub-$5K TCV, 2+ yrs remaining → fixed $1K cap penalty (§D1)." }
        : { amount: 0, tcv: tcv, guaranteed: guaranteed, earned: br.earned,
            note: "Sub-$5K TCV, final year → cap-free cut (§D1)." };
    }

    var type = safeStr(player && player.type).toUpperCase();
    if (contractLength === 1 && br.currentYearSalary < 5000 && (type === "VETERAN" || type === "WW")) {
      return { amount: 0, tcv: tcv, guaranteed: guaranteed, earned: br.earned,
        note: "1-yr veteran/waiver under $5K is cap-free cut (§D2.1)." };
    }
    if (isLikelyWaiverPickup(player) && contractLength === 1 && br.currentYearSalary >= 5000) {
      return { amount: Math.round(br.currentYearSalary * 0.35), tcv: tcv, guaranteed: guaranteed, earned: br.earned,
        note: "Waiver pickup rule: 35% of current-year salary." };
    }
    var penalty = Math.max(0, guaranteed - br.earned);
    return { amount: penalty, tcv: tcv, guaranteed: guaranteed, earned: br.earned,
      note: penalty === 0
        ? "Guarantee fully earned — no penalty."
        : "GTD " + money(guaranteed) + " − Earned " + money(br.earned) + " = " + money(penalty) + "." };
  }

  // Per-Week Earning = current-year salary spread over the 17-week earning window.
  // Sub-$5K (flat-$1K penalty) deals show "1K Per Yr"; taxi players with TCV > $4K
  // DO get the per-week calc (Keith 2026-06-01); only expired / $0 show "—".
  function perWeekEarningInfo(p) {
    var tcv = totalContractValueForPlayer(p);
    var yrs = safeInt(p && p.years, 0);
    if (tcv > 0 && tcv <= 4000) return { label: "1K Per Yr", sort: 0 };
    if (yrs <= 0 || safeInt(p && p.salary, 0) <= 0) return { label: "—", sort: -1 };
    var v = Math.round(safeInt(p.salary, 0) / 17);
    return { label: fmtUSD(v), sort: v };
  }
  function perWeekEarningValue(p) { return perWeekEarningInfo(p).sort; }
  function perWeekEarningCell(p) { return perWeekEarningInfo(p).label; }

  // ── Taxi-data repair + eligibility ──────────────────────────────────
  // Keith 2026-05-19: "Taxi guys need TCV/Salary derived; only Watson
  // got it today, should be ALL taxi." Mirrors roster_workbench.js:517.
  function rookieLikeContractStatus(value) {
    var s = safeStr(value).toLowerCase();
    return s === "r" || s.indexOf("r-") === 0 || s.indexOf("rookie") !== -1;
  }
  function rookieTaxiYearsRemainingFromDraftSeason(draftSeason, season) {
    var drafted = safeInt(draftSeason, 0);
    var current = safeInt(season, 0);
    if (drafted <= 0 || current <= 0) return 0;
    return Math.max(0, 3 - Math.max(0, current - drafted));
  }
  function standardRookieTaxiContractInfo(salary, contractLength) {
    var years = Math.max(1, safeInt(contractLength, 0) || 3);
    var current = Math.max(1000, roundToK(safeInt(salary, 0)));
    var yearParts = [];
    for (var i = 1; i <= years; i += 1) yearParts.push("Y" + i + "-" + formatContractK(current));
    return [
      "CL " + years,
      "TCV " + formatContractK(current * years),
      "AAV " + formatContractK(current),
      yearParts.join(", "),
      "GTD: " + formatContractK(guaranteeForContract(current * years, years))  // §D1 sub-$5K rule
    ].join("| ");
  }
  // ── Worker-raw adjustment summer ────────────────────────────────────
  // Sums the worker's per-team salary_adjustment_raw_rows by category
  // exactly as live FO does (roster_workbench.js:4128). Trades preserve
  // sign so counterparty offsets net to zero. Drop-penalty totals are
  // OVERRIDDEN later by the canonical report loaded from
  // /reports/salary_adjustments/salary_adjustments_<year>.json.
  function sumWorkerAdjustmentRows(rows) {
    const out = { cut: 0, trade: 0, other: 0 };
    for (let i = 0; i < rows.length; i += 1) {
      const r = rows[i] || {};
      const cat = safeStr(r.category);
      const amt = safeInt(r.amount, 0);
      if      (cat === "cut_players_dollars")   out.cut   += amt;
      else if (cat === "traded_salary_dollars") out.trade += amt;
      else                                       out.other += amt;
    }
    return out;
  }

  // ── MFL salary-adjustments loader (single source of truth) ──────────
  // MFL's salaryAdjustments export IS the league's authoritative cap-
  // adjustment feed — exact dollars + a description carrying the player +
  // reason. We bucket Drop / Trade / Other by the description (same idea as
  // live FO's salaryAdjustmentCategory) and itemize per player for the Cap
  // Allocation "?" popup. This replaces the old /reports/salary_adjustments
  // JSON (empty for 2025-2026) AND the worker's raw rows (which carry a
  // <$1K K-multiplier glitch + null descriptions, e.g. Bates/0008 read
  // $5,453 instead of MFL's $5,450). Returns { ok, byFid: { fid:
  // {cut, trade, other, items:[{kind,player,amount,when}]} } }.
  function adjCategoryFromDesc(desc) {
    const t = String(desc || "").toLowerCase();
    if (t.indexOf("trade") !== -1) return "trade";
    if (t.indexOf("drop") !== -1 || t.indexOf("cut") !== -1 ||
        t.indexOf("penalt") !== -1 || t.indexOf("waiv") !== -1) return "cut";
    return "other";
  }
  function adjPlayerFromDesc(desc) {
    const s = String(desc || "");
    // "UPS drop penalty <name> <amount> id:<key>" — the name sits between the
    // keyword and the trailing amount + id. Captures both "Chark, D.J." (old
    // report format) and "Dyami Brown" (drop-tracker format). Trade settlements
    // (no "drop penalty") yield no name (Flag-don't-fake).
    let m = s.match(/drop penalty\s+(.+?)\s+-?\d+\s+id:/i);
    let name = m && m[1] ? m[1].trim() : "";
    if (!name) {
      m = s.match(/(?:dropped|cut)\s+([A-Z][\w.'’-]+,\s*[A-Z][\w.'’-]+)/i);
      name = m ? m[1].replace(/\s+/g, " ").trim() : "";
    }
    // Normalize "Firstname Lastname" → "Lastname, Firstname" so it matches the
    // rest of the popup (e.g. "Chark, D.J."). Only for clean 2-token names.
    if (name && name.indexOf(",") === -1) {
      const parts = name.split(/\s+/);
      if (parts.length === 2) name = parts[1] + ", " + parts[0];
    }
    return name;
  }
  function adjWhenFromTs(ts) {
    const n = safeInt(ts, 0);
    if (!n) return "";
    try { return new Date(n * 1000).toISOString().slice(0, 10); } catch (e) { return ""; }
  }
  async function loadMflSalaryAdjustments(season) {
    try {
      const url = apiUrl("/api/mfl-export") + "?TYPE=salaryAdjustments&L=" +
        encodeURIComponent(LEAGUE_ID) + "&YEAR=" + encodeURIComponent(season) + "&JSON=1";
      const payload = await fetchJSON(url);
      let rows = payload && payload.salaryAdjustments && payload.salaryAdjustments.salaryAdjustment;
      rows = Array.isArray(rows) ? rows : (rows ? [rows] : []);
      const byFid = Object.create(null);
      for (let i = 0; i < rows.length; i += 1) {
        const r = rows[i] || {};
        // Skip our own posted rounding line (id:ups_drop_rounding_…) — it's
        // represented by the computed "Rounding" line in showAdjPopup; summing it
        // here would double-count once the deadline true-up has posted it to MFL.
        if (/id:ups_drop_rounding_/i.test(String(r.description || ""))) continue;
        const fid = pad4(r.franchise_id);
        if (!fid) continue;
        // MFL amounts are full dollars. Parse as a FLOAT then round — some rows
        // carry a corrupted near-zero scientific-notation value (e.g. Blake
        // Watson's penalty-free taxi drop is stored as "2e-124"); safeInt's
        // parseInt would read that as $2, so round the real numeric value to $0.
        let amt = Math.round(Number(r.amount));
        if (!Number.isFinite(amt)) amt = 0;
        const cat = adjCategoryFromDesc(r.description);
        if (!byFid[fid]) byFid[fid] = { cut: 0, trade: 0, other: 0, items: [] };
        if      (cat === "cut")   byFid[fid].cut   += amt;
        else if (cat === "trade") byFid[fid].trade += amt;
        else                      byFid[fid].other += amt;
        if (amt !== 0) {
          byFid[fid].items.push({
            kind: cat === "cut" ? "Drop" : cat === "trade" ? "Trade" : "Other",
            player: adjPlayerFromDesc(r.description),
            amount: amt,
            when: adjWhenFromTs(r.timestamp)
          });
        }
      }
      return { ok: true, byFid: byFid };
    } catch (e) {
      console.warn("[fo] MFL salaryAdjustments load failed, keeping worker raw sums:", e.message || e);
      return { ok: false, byFid: {} };
    }
  }
  // NEXT-SEASON drop penalties (canon §6 penalty timing bucket 2). A drop from
  // the FA Auction start through the end of the season hits the FOLLOWING
  // season's cap, and — like the §F RULE 2 next-season fine — is LEDGER-ONLY
  // until the rollover, so it is deliberately absent from MFL's
  // salaryAdjustments feed. It still has to be visible: an owner who cut
  // someone in August is carrying that money into next year whether or not MFL
  // shows it. Rendered under its own year heading in the Cap Adjustments popup,
  // and NEVER added to the current-season total.
  //
  // A failed / unresolved read returns ok:false, and the popup then says so
  // rather than implying the next-season ledger is empty.
  async function loadNextSeasonDropPenalties(season) {
    try {
      const url = apiUrl("/api/cap-adjustments/next-season") + "?L=" +
        encodeURIComponent(LEAGUE_ID) + "&YEAR=" + encodeURIComponent(season);
      const payload = await fetchJSON(url);
      if (!payload || payload.ok !== true) {
        return { ok: false, byFid: {}, nextSeason: safeInt(season, 0) + 1, error: (payload && payload.error) || "unavailable" };
      }
      return {
        ok: true,
        byFid: payload.by_fid || {},
        nextSeason: safeInt(payload.next_season, 0) || (safeInt(season, 0) + 1),
        needsReview: payload.needs_review || [],
      };
    } catch (e) {
      console.warn("[fo] next-season drop penalty ledger unavailable:", e.message || e);
      return { ok: false, byFid: {}, nextSeason: safeInt(season, 0) + 1, error: e.message || String(e) };
    }
  }
  function mergeMflSalaryAdjustments(teams, mflAdj) {
    if (!mflAdj || !mflAdj.ok) return; // fetch failed → keep worker raw-sum fallback
    const byFid = mflAdj.byFid || {};
    for (let i = 0; i < teams.length; i += 1) {
      const t = teams[i];
      const r = byFid[t.fid];
      // MFL feed is complete + authoritative: a team with no rows has $0
      // (this also clears the worker raw-row K-multiplier glitch).
      t.summary.adj_cut   = r ? r.cut   : 0;
      t.summary.adj_trade = r ? r.trade : 0;
      t.summary.adj_other = r ? r.other : 0;
    }
  }

  // §A1.4 rookie pay scale (canon §A1.4):
  //   R1.01 → 1.10 linear $15K → $6K (−$1K per pick)
  //   R1.11, R1.12 → $5K
  //   R2 (any pick) → $5K
  //   R3-5 → $2K
  //   R6 → $1K (IDP only)
  function rookieScaleSalaryForSlot(round, pick) {
    var r = safeInt(round, 0), p = safeInt(pick, 0);
    if (r <= 0) return 0;
    if (r === 1) {
      if (p >= 1 && p <= 10) return (15 - (p - 1)) * 1000;  // 15K, 14K, ..., 6K
      if (p === 11 || p === 12) return 5000;
      return 0;
    }
    if (r === 2) return 5000;
    if (r >= 3 && r <= 5) return 2000;
    if (r === 6) return 1000;
    return 0;
  }
  // Parse "Round N | Pick M" into {round, pick}; tolerates "R2P22" too.
  function parseDraftSlotDetail(detail) {
    var d = safeStr(detail).toUpperCase();
    if (!d) return { round: 0, pick: 0 };
    var m = d.match(/ROUND\s*(\d+)[^0-9]+PICK\s*(\d+)/);
    if (m) return { round: safeInt(m[1], 0), pick: safeInt(m[2], 0) };
    m = d.match(/\bR\s*(\d+)\s*P\s*(\d+)\b/);
    if (m) return { round: safeInt(m[1], 0), pick: safeInt(m[2], 0) };
    m = d.match(/^(\d+)\.(\d+)/);
    if (m) return { round: safeInt(m[1], 0), pick: safeInt(m[2], 0) };
    return { round: 0, pick: 0 };
  }

  function repairTaxiContractFallbacks(teams, season) {
    var current = safeInt(season, 0);
    for (var i = 0; i < teams.length; i += 1) {
      var players = teams[i].players || [];
      for (var j = 0; j < players.length; j += 1) {
        var p = players[j];
        if (!p) continue;
        // Repair runs on:
        //   1. Taxi players (existing — derive missing rookie contracts)
        //   2. ACTIVE players with no contract data at all (the Jalen
        //      Carter case 2026-05-19: traded-in expired rookie still
        //      rostered, worker returns type='-' salary=0 special='-').
        var isActiveOrphan = !p.isTaxi && !p.isIr &&
          safeStr(p.type) === "-" && safeStr(p.special) === "-" &&
          safeInt(p.salary, 0) <= 0 && safeInt(p.years, 0) <= 0;
        if (!p.isTaxi && !isActiveOrphan) continue;

        var salary = Math.max(0, safeInt(p.salary, 0));

        // §A1.4 salary derivation: MFL strips taxi salaries to $0.
        // Resolution order (Keith 2026-05-19 — worker debug session):
        //   1. WORKER FIELDS: ups_draft_round + ups_draft_year are
        //      first-class on the payload for every rookie. Round
        //      alone is enough for R2-R6 (flat scale). For R1, try
        //      to also parse pick from acquisition_text "1.06 (YYYY)".
        //   2. Acquisition-lookup JSON (current franchise row labeled
        //      Rookie Draft) — secondary source if worker fields blank.
        //   3. CROSS-FRANCHISE rookie-draft index — catches traded
        //      rookies whose CURRENT row is Trade/Auction.
        //
        // Group with years=0 AND no draft-round signal = expired rookie
        // contract. Mark special accordingly, leave $0 (we genuinely
        // don't know the contract). Memory feedback_no_default_substitution.
        if (salary <= 0) {
          var slot = { round: 0, pick: 0 };
          var slotSource = "";
          // Path 1: rookie_draft_history.json — most reliable. Has every
          // pid + exact slot + salary. Catches the expired-rookie group
          // (Mayer/Bennett/Wilson Tyree/Perry/Washington Darnell).
          var rh = ROOKIE_HISTORY_INDEX[safeStr(p.id).replace(/\D/g, "")];
          if (rh && rh.round > 0) {
            slot.round = rh.round;
            slot.pick  = rh.pick;
            slotSource = "rookie_draft_history.json";
          }
          // Path 2: worker fields.
          if (slot.round === 0 && p.upsDraftRound > 0) {
            slot.round = p.upsDraftRound;
            var slotMatch = safeStr(p.acquisitionText).match(/^\s*(\d+)\.(\d+)/);
            if (slotMatch && safeInt(slotMatch[1], 0) === slot.round) {
              slot.pick = safeInt(slotMatch[2], 0);
            }
            slotSource = "worker ups_draft_round";
          }
          // Path 3: current acquisition row.
          if (slot.round === 0 && safeStr(p.acquisitionTypeLabel).toLowerCase().indexOf("rookie draft") >= 0) {
            slot = parseDraftSlotDetail(p.acquisitionDetail);
            slotSource = "acquisition lookup (current row)";
          }
          // Path 4: cross-franchise fallback.
          if (slot.round === 0 && p.rookieDraftRow) {
            slot = parseDraftSlotDetail(p.rookieDraftRow.acquisition_detail);
            slotSource = "acquisition lookup (cross-franchise)";
          }
          var derived = rookieScaleSalaryForSlot(slot.round, slot.pick);
          // Prefer salary directly from rookie_draft_history if present
          // (catches edge cases where canon §A1.4 doesn't apply, e.g.
          // pre-2025 rules where Y1 salaries differed).
          if (rh && rh.salary > 0) derived = rh.salary;
          if (derived > 0) {
            salary = derived;
            p.salary = derived;
            p.salaryDerivedFromRookieScale = {
              round: slot.round, pick: slot.pick, source: "§A1.4 via " + slotSource
            };
          }
        }

        if (salary > 0 && safeInt(p.aav, 0) <= 0) p.aav = salary;

        var special = safeStr(p.special);
        if (special && special !== "-") continue;

        // ── Active-orphan branch (Carter case) ─────────────────────
        // Expired rookie on the active roster — synthesize a full
        // contract_info string from the rookie-draft history so the
        // table columns (TCV, CL, AAV) populate. Type stays Rookie
        // and the row chips EXPIRED via the years=0 + isExpiredRookie
        // marker (chip class handled in renderRosterRow).
        if (isActiveOrphan) {
          if (rh && rh.salary > 0) {
            p.salary = rh.salary;
            p.aav = rh.salary;
            p.special = standardRookieTaxiContractInfo(rh.salary, 3);
            p.type = "Rookie";
          } else {
            p.type = "Expired";
          }
          p.isExpiredRookie = true;
          // This repair derives from the UPS rookie-draft record (§A1.4) — real
          // evidence, not silence — so the row is no longer "MFL has not said".
          p.contractUnknown = false;
          continue;
        }
        // ── Taxi branch (existing) ─────────────────────────────────
        var years = Math.max(0, safeInt(p.years, 0));
        if (years <= 0) {
          years = rookieTaxiYearsRemainingFromDraftSeason(p.originalDraftSeason, current);
        }
        if (years > 0) p.years = years;
        if (salary > 0) p.special = standardRookieTaxiContractInfo(salary, 3);

        // Type — Rookie clock still ticking → Rookie; clock done → Expired
        // chip (handled at render via isExpiredRookie + years=0). For
        // expired guys we STILL synthesize CL/TCV/AAV from the rookie
        // history so columns light up — bundle prefetch overrides with
        // exact D1 data once it loads. Keith 2026-05-19: "no nulls."
        var clockDone = Math.max(0, safeInt(p.years, 0)) <= 0;
        if (clockDone) {
          p.isExpiredRookie = true;
          if (rh && rh.salary > 0) {
            if (!salary || salary <= 0) { salary = rh.salary; p.salary = rh.salary; }
            if (safeInt(p.aav, 0) <= 0)  p.aav = rh.salary;
            p.special = standardRookieTaxiContractInfo(rh.salary, 3);
            p.type = "Rookie";
          } else if (salary > 0) {
            // Worker gave us a salary but no rookie history — derive
            // standard 3yr flat contract from it. Better than null.
            p.special = standardRookieTaxiContractInfo(salary, 3);
            p.type = "Rookie";
          } else {
            // No history, no salary, no signal. Mark as expired but
            // don't fake numbers.
            p.type = "Expired";
            p.special = "Expired Contract — no derivable data";
          }
        } else if (!rookieLikeContractStatus(p.type)) {
          p.type = "Rookie";
        }
        // Same reasoning as the active-orphan branch: this taxi repair derives
        // from the UPS rookie-draft record, so the row is no longer silent.
        p.contractUnknown = false;
      }
    }
  }

  // ── Acquisition lookup loader ────────────────────────────────────────
  // Loads site/rosters/player_acquisition_lookup_<year>.json (commish-
  // maintained) and stamps every player with acquisitionTypeLabel,
  // acquisitionDetail, originalDraftSeason. Mirrors
  // roster_workbench.js:2517 mergeAcquisitionLookupRows.
  function acquisitionLookupKey(fid, pid) {
    return pad4(fid) + ":" + safeStr(pid).replace(/\D/g, "");
  }
  async function loadAcquisitionLookup(year) {
    try {
      const payload = await fetchJSON(URL_ACQUISITION_LOOKUP(year));
      if (Array.isArray(payload)) return payload;
      if (payload && Array.isArray(payload.rows)) return payload.rows;
      return [];
    } catch (e) {
      console.warn("[fo] acquisition lookup load failed (continuing without taxi salary derivation):", e.message || e);
      return [];
    }
  }
  function mergeAcquisitionLookupRows(teams, rows) {
    if (!teams || !teams.length || !rows || !rows.length) return;
    // Primary index: franchise_id + player_id → current-acquisition row.
    const byKey = Object.create(null);
    // Secondary index: player_id → original rookie-draft row (across ALL
    // franchises). Catches traded rookies whose current row says
    // "Trade" with no slot — the original draft slot lives under the
    // OTHER franchise's row for that same player. Keith 2026-05-19:
    // ~100 such rows exist; without this fallback those taxi guys
    // can't be derived via §A1.4.
    const rookieDraftByPid = Object.create(null);
    for (let i = 0; i < rows.length; i += 1) {
      const row = rows[i] || {};
      const key = acquisitionLookupKey(row.franchise_id || row.franchiseId, row.player_id || row.playerId);
      if (!key || key === ":") continue;
      byKey[key] = row;
      if (safeStr(row.acquisition_label || row.label).toLowerCase() === "rookie draft") {
        const pid = safeStr(row.player_id || row.playerId).replace(/\D/g, "");
        if (pid) rookieDraftByPid[pid] = row;
      }
    }
    for (let t = 0; t < teams.length; t += 1) {
      const players = teams[t].players || [];
      for (let p = 0; p < players.length; p += 1) {
        const player = players[p];
        const match = byKey[acquisitionLookupKey(player.fid, player.id)];
        if (match) {
          player.acquisitionDate = safeStr(match.acquisition_date || match.date_et);
          player.acquisitionDateTime = safeStr(match.acquisition_datetime_et || match.datetime_et);
          player.acquisitionTypeLabel = safeStr(match.acquisition_label || match.label);
          player.acquisitionDetail = safeStr(match.acquisition_detail || match.detail);
          player.originalDraftSeason = safeInt(match.original_draft_season || match.originalDraftSeason, 0);
          if (!player.acquisitionText) player.acquisitionText = safeStr(match.notes_fallback || "");
        }
        // Stash original rookie-draft row (if any). Repair will use this
        // for §A1.4 derivation when the current row isn't rookie-draft.
        const pidKey = safeStr(player.id).replace(/\D/g, "");
        if (pidKey && rookieDraftByPid[pidKey]) {
          player.rookieDraftRow = rookieDraftByPid[pidKey];
          if (!player.originalDraftSeason) {
            player.originalDraftSeason = safeInt(rookieDraftByPid[pidKey].original_draft_season, 0);
          }
        }
      }
    }
  }

  // ── Auction-win display overlay (interim correctness; client-only) ───
  // When an FA-Auction (or ERA) lot closes, MFL adds the won player to the
  // roster but leaves the contract a STUB: contractYear=0 + a $1,000
  // placeholder. Until the worker's auction poller writes the real 1-year
  // contract (Vet-FAA at the won price — gated behind
  // AUCTION_FAA_FINALIZE_ENABLED; Vet-ERA already auto-writes), that stub
  // renders as "EXPIRED $1K" AND — because MYAC eligibility requires
  // years===1 — HIDES the 2/3-year MYAC buttons. This overlay reconstructs
  // the won-price 1-year contract from the acquisition-lookup row (label +
  // "$X,000" detail) so the row reads correctly and MYAC re-enables, BEFORE
  // any MFL write. ZERO WRITES — purely cosmetic client state.
  //   GUARDS (all must hold): the acquisition label is an auction win; it is
  //   NOT the un-auctioned expired-rookie synth case; the win is THIS season;
  //   and it is still sitting at years<=0. The years<=0 guard is strict so a
  //   finalized contract (cy>=1, whether written by the poller or a manual
  //   backfill) is NEVER overwritten.
  function applyAuctionWinOverlay(teams, season) {
    if (!teams || !teams.length) return;
    var seasonStr = String(season);
    for (var t = 0; t < teams.length; t += 1) {
      var players = teams[t].players || [];
      for (var pi = 0; pi < players.length; pi += 1) {
        var pl = players[pi];
        if (!pl) continue;
        var label = safeStr(pl.acquisitionTypeLabel);
        if (!/auction|faa/i.test(label)) continue;              // auction wins only
        if (pl.isExpiredRookie) continue;                       // not the un-auctioned expired-rookie synth
        if (safeStr(pl.acquisitionDate).slice(0, 4) !== seasonStr) continue; // this season only
        if (safeInt(pl.years, 0) > 0) continue;                 // finalized (cy>=1) → never overwrite
        var price = parseContractMoneyToken(pl.acquisitionDetail);
        if (price <= 0) continue;
        // 'Expired Rookie Auction' → Vet-ERA; 'Free Agent Auction' → Vet-FAA.
        var isEraWin = /expired\s*rookie|\bera\b/i.test(label);
        pl.salary = price;
        pl.aav = price;
        pl.years = 1;
        pl.type = isEraWin ? "Vet-ERA" : "Vet-FAA";
        pl.special = "CL 1| TCV " + fmtK(price) + "| AAV " + fmtK(price);
      }
    }
  }

  // ── Rookie draft history loader ──────────────────────────────────────
  // Indexes EVERY UPS rookie pick (2012-2025) by player_id so taxi
  // rookies who lack ups_draft_round can still derive their original
  // contract from canon §A1.4 — and so we can populate TCV/special on
  // expired-rookie taxi guys (Mayer Michael, Bennett, Wilson Tyree, …).
  const ROOKIE_HISTORY_INDEX = Object.create(null);
  async function loadRookieDraftHistory() {
    try {
      const payload = await fetchJSON(URL_ROOKIE_HISTORY);
      const picks = Array.isArray(payload) ? payload : (payload && payload.picks) || [];
      for (let i = 0; i < picks.length; i += 1) {
        const row = picks[i] || {};
        const pid = safeStr(row.player_id).replace(/\D/g, "");
        if (!pid) continue;
        // Most-recent draft entry wins (so 2024 R3 beats 2018 R5 if the
        // pid was re-drafted somehow — defensive).
        const prev = ROOKIE_HISTORY_INDEX[pid];
        if (!prev || safeInt(row.season, 0) > safeInt(prev.season, 0)) {
          ROOKIE_HISTORY_INDEX[pid] = {
            season: safeInt(row.season, 0),
            round:  safeInt(row.round, 0),
            pick:   safeInt(row.slot, 0),
            pick_label: safeStr(row.pick_label),
            salary: safeInt(row.salary, 0),
            franchise_id: safeStr(row.franchise_id),
            franchise_name: safeStr(row.franchise_name)
          };
        }
      }
    } catch (e) {
      console.warn("[fo] rookie_draft_history.json load failed — expired-rookie taxi guys will stay blank:", e.message || e);
    }
  }

  // (Extension previews are delivered inline on each player by the
  // worker payload — no separate JSON fetch needed. The earlier
  // extension_previews_<year>.json fallback was speculative; removed
  // 2026-05-19 to silence the harmless 404.)

  // ── Bundle prefetch for expired-rookie rows ─────────────────────────
  // After initial render, pull /api/player-bundle for every flagged-
  // expired player (throttled to 8 concurrent). When each returns,
  // override the synthesized contract_info with the most-recent row
  // from bundle.contract_history (actual per-year salary from D1
  // src_contracts). Re-renders debounced 150ms. Keith 2026-05-19:
  // "bring in the entire contract view... NO NULLS."
  let _bundleRerenderTimer = null;
  function scheduleRerender() {
    if (_bundleRerenderTimer) return;
    _bundleRerenderTimer = setTimeout(function () {
      _bundleRerenderTimer = null;
      renderRosterTable();
    }, 150);
  }
  async function kickoffExpiredRookieBundlePrefetch() {
    const targets = [];
    STATE.teams.forEach(function (t) {
      (t.players || []).forEach(function (p) {
        if (p.isExpiredRookie) targets.push(p);
      });
    });
    if (!targets.length) return;
    const CONCURRENCY = 8;
    let cursor = 0;
    async function worker() {
      while (cursor < targets.length) {
        const p = targets[cursor++];
        try {
          const bundle = await loadPlayerBundle(p.id);
          if (!bundle) continue;
          const rows = Array.isArray(bundle.contract_history) ? bundle.contract_history : [];
          if (!rows.length) continue;
          const latest = rows.slice().sort(function (a, b) {
            return safeInt(b.season, 0) - safeInt(a.season, 0);
          })[0];
          if (!latest) continue;
          const info = safeStr(latest.contract_info);
          if (info) p.special = info;
          if (safeInt(latest.salary, 0) > 0) p.salary = safeInt(latest.salary, 0);
          if (safeInt(latest.aav, 0) > 0)    p.aav    = safeInt(latest.aav, 0);
          p.bundleEnriched = true;
        } catch (e) { /* synth stays in place */ }
        scheduleRerender();
      }
    }
    const workers = [];
    for (let i = 0; i < CONCURRENCY; i += 1) workers.push(worker());
    await Promise.all(workers);
  }

// ── Player bundle cache (Contract History, Stats, News) ──────────────
  // credentials: "omit" — same CORS reason as admin-state. Local cross-
  // origin testing trips Access-Control-Allow-Origin: * + credentials.
  const BUNDLE_CACHE = Object.create(null);
  async function loadPlayerBundle(pid) {
    // Worker contract: GET /api/player-bundle?pid=<singular>&L=&YEAR=
    // Response is FLAT at the top level (no .bundles[pid] wrapper).
    // Probed live 2026-05-19; relevant keys: contract_history, contracts,
    // contract_stints, career_summary, weekly, trade_history, profile.
    if (!pid) return null;
    if (BUNDLE_CACHE[pid]) return BUNDLE_CACHE[pid];
    const url = EP_PLAYER_BUNDLE() +
      "?pid=" + encodeURIComponent(pid) +
      "&L=" + encodeURIComponent(LEAGUE_ID) +
      "&YEAR=" + encodeURIComponent(SEASON);
    try {
      const r = await fetch(url, { credentials: "omit", cache: "no-store" });
      if (!r.ok) throw new Error("HTTP " + r.status);
      const data = await r.json();
      BUNDLE_CACHE[pid] = data;
      return data;
    } catch (e) {
      console.warn("[fo] player-bundle load failed for pid=" + pid + ":", e.message || e);
      return null;
    }
  }

  // Action eligibility — mirrors rosterContractEligibility at
  // roster_workbench.js:558. Used to HIDE inapplicable rows in the
  // slide-over Actions tab (Keith 2026-05-19: "If a player doesn't have
  // an option don't show it").
  //
  // §C6 1st-Round Rookie Option (effective 2025+):
  //   • Round 1 rookie (slot 1.01-1.12)
  //   • 2025 NFL draft class FORWARD
  //   • Currently in last contract year (years === 1)
  //   • Option not yet exercised
  //   • Exercise Y3 + $5K to add a 4th option year (deadline: Sept of
  //     final rookie year)
  //
  // The worker doesn't always set rookieOptionEligible — when it's
  // missing we derive from the acquisition lookup (acquisition_label
  // = "Rookie Draft", original_draft_season >= 2025, round === 1).
  function rookieOptionStateForPlayer(p) {
    if (!p) return null;
    // Path 1: worker explicitly marked the flag.
    if (p.rookieOptionEligible || p.rookie_option_eligible || p.rookieOptionExercised || p.rookie_option_exercised) {
      return {
        eligible:  !!(p.rookieOptionEligible || p.rookie_option_eligible),
        exercised: !!(p.rookieOptionExercised || p.rookie_option_exercised),
        source: "worker"
      };
    }
    // Path 2: derive from acquisition lookup. Rookie-draft, R1, 2025+
    // class, NOT already extended (status starting with "EXT" or "TAG"
    // means the option moment has passed or been pre-empted).
    var label = safeStr(p.acquisitionTypeLabel).toLowerCase();
    var draftYr = safeInt(p.originalDraftSeason, 0);
    if (label.indexOf("rookie draft") < 0 || draftYr < 2025) return null;
    var slot = parseDraftSlotDetail(p.acquisitionDetail);
    if (slot.round !== 1) return null;
    var status = safeStr(p.type).toUpperCase();
    if (status.indexOf("EXT") !== -1 || status.indexOf("TAG") !== -1) return null;
    return { eligible: true, exercised: false, source: "derived", round: slot.round, pick: slot.pick };
  }
  function rookieOptionActionEligible(p) {
    var opt = rookieOptionStateForPlayer(p);
    if (!opt || !opt.eligible || opt.exercised) return false;
    return safeInt(p && p.years, 0) === 1;
  }
  // ── Extension preview synthesis (canon §C4 + §C4.6) ─────────────────
  // Mirrors roster_workbench.js synthesizedExtensionOptionsForPlayer.
  // Used when the worker payload's extension_previews is empty
  // (Marvin Harrison Jr. class — Keith 2026-05-19, checkpoint 2).
  // §C4.6 escalator (forward years only):
  //   Sched 1 (QB/RB/WR/TE):  +$10K (1yr), +$20K (2yr)
  //   Sched 2 (DL/LB/DB/PK/PN): +$3K (1yr), +$5K (2yr)
  const EXTENSION_RATES = {
    QB: { 1: 10000, 2: 20000 }, RB: { 1: 10000, 2: 20000 },
    WR: { 1: 10000, 2: 20000 }, TE: { 1: 10000, 2: 20000 },
    DL: { 1: 3000,  2: 5000  }, DB: { 1: 3000,  2: 5000  },
    LB: { 1: 3000,  2: 5000  }, PK: { 1: 3000,  2: 5000  },
    PN: { 1: 3000,  2: 5000  }, OTHER: { 1: 3000, 2: 5000 }
  };
  function positionGroupKey(pos) {
    const p = safeStr(pos).toUpperCase();
    if (p === "DE" || p === "DT" || p === "DL" || p === "NT" || p === "EDGE" || p === "ED") return "DL";
    if (p === "CB" || p === "S" || p === "FS" || p === "SS" || p === "DB") return "DB";
    if (p === "K" || p === "PK") return "PK";
    if (p === "P" || p === "PN") return "PN";
    if (p === "QB" || p === "RB" || p === "WR" || p === "TE" || p === "LB") return p;
    return "OTHER";
  }
  function extensionRaiseForPlayer(p, years) {
    const y = safeInt(years, 0);
    if (y !== 1 && y !== 2) return 0;
    const key = safeStr(p && p.positionGroup).toUpperCase() || "OTHER";
    const rec = EXTENSION_RATES[key] || EXTENSION_RATES.OTHER;
    return safeInt(rec && rec[y], 0);
  }
  function projectedExtensionSalary(p, years) {
    const y = safeInt(years, 0);
    if (y !== 1 && y !== 2) return 0;
    return Math.max(1000, roundToK(safeInt(p && p.salary, 0) + extensionRaiseForPlayer(p, y)));
  }
  // RULE-EXT-003 — same franchise can't extend the same player twice.
  // Parses the `Ext: <team1>, <team2>` segment from contract_info and
  // checks the current owning franchise against it.
  function parseExtensionHistoryTokens(info) {
    const match = safeStr(info).match(/(?:^|\|)\s*Ext:\s*([^|]+)/i);
    if (!match || !safeStr(match[1])) return [];
    return safeStr(match[1]).split(/[,/;&]|\band\b/i).map(safeStr).filter(Boolean);
  }
  function normalizeIdentityToken(token) {
    const s = safeStr(token).toLowerCase();
    let out = "";
    for (let i = 0; i < s.length; i += 1) {
      const c = s.charCodeAt(i);
      if (c <= 0x7F) {
        if ((c >= 0x30 && c <= 0x39) || (c >= 0x61 && c <= 0x7A)) out += s.charAt(i);
      } else { out += s.charAt(i); }
    }
    return out;
  }
  function teamIdentityTokenMap(team) {
    const map = Object.create(null);
    function add(raw) {
      const text = safeStr(raw); if (!text) return;
      const n = normalizeIdentityToken(text); if (n) map[n] = true;
      const parts = text.split(/[\s/,&().-]+/);
      for (let i = 0; i < parts.length; i += 1) {
        const t = normalizeIdentityToken(parts[i]); if (!t) continue;
        map[t] = true;
        if (t.length >= 5 && /ers$/.test(t)) map[t.slice(0, -3)] = true;
        if (t.length >= 5 && /s$/.test(t))   map[t.slice(0, -1)] = true;
      }
    }
    add(team && team.name); add(team && team.abbrev);
    return map;
  }
  function lastExtensionIdentityToken(info) {
    const tokens = parseExtensionHistoryTokens(info);
    return tokens.length ? normalizeIdentityToken(tokens[tokens.length - 1]) : "";
  }
  function identityTokenMatchesTeam(token, team) {
    const n = normalizeIdentityToken(token); if (!n) return false;
    const id = teamIdentityTokenMap(team);
    if (id[n]) return true;
    const keys = Object.keys(id);
    for (let i = 0; i < keys.length; i += 1) {
      const k = keys[i]; if (!k) continue;
      if (n.length >= 4 && k.indexOf(n) === 0) return true;
      if (k.length >= 4 && n.indexOf(k) === 0) return true;
    }
    return false;
  }
  function findTeamById(fid) {
    return STATE.teams.find(function (t) { return t.fid === pad4(fid); }) || null;
  }
  function extensionBlockedByCurrentOwner(p) {
    if (!p) return false;
    const team = findTeamById(p.fid); if (!team) return false;
    const tok = lastExtensionIdentityToken(p.special || "");
    return identityTokenMatchesTeam(tok, team);
  }
  function extensionOwnerTokenForTeam(team, p) {
    const abbrev = safeStr(team && team.abbrev).trim();
    if (abbrev) return abbrev;
    const name = safeStr(team && team.name || p && p.franchise || "").trim();
    return name ? name.split(/\s+/)[0] : "";
  }

  // Synthesize one extension option. loading ∈ "NONE" (flat) / "FL" / "BL".
  // 1yr is always flat per canon §C4.3.
  function synthesizeExtensionOption(p, yearsToAdd, loadingChoice) {
    if (!p) return null;
    const years = safeInt(yearsToAdd, 0);
    if (years !== 1 && years !== 2) return null;
    let loading = safeStr(loadingChoice).toUpperCase();
    if (loading !== "FL" && loading !== "BL") loading = "NONE";
    if (years === 1) loading = "NONE";

    const currentYears  = Math.max(0, safeInt(p.years, 0));
    const currentSalary = Math.max(1000, roundToK(safeInt(p.salary, 0)));
    const futureSalary  = projectedExtensionSalary(p, years);
    if (futureSalary <= 0) return null;
    const totalLength = currentYears + years;
    if (totalLength <= 0) return null;

    // Distribute extension-years salary by loading. FL: 80/20; BL: 20/80;
    // Flat: futureSalary each year. All rounded to $1K. Canon §C4.3 +
    // LaPorta example 2026-05-15.
    const extensionTotal = futureSalary * years;
    let extYearSalaries = [];
    // Canon §C4.3: each extension year ≥ 20% of the extension TCV. CEIL the 20%
    // floor to the next $1K (matches the loaded-extension form) so the loaded
    // extreme never dips below a true 20%.
    const minExtYr = Math.max(1000, Math.ceil(extensionTotal * 0.2 / 1000) * 1000);
    if (years === 2 && loading === "FL") {
      extYearSalaries = [extensionTotal - minExtYr, minExtYr];   // Y1(ext) heavy, Y2(ext) at 20% floor
    } else if (years === 2 && loading === "BL") {
      extYearSalaries = [minExtYr, extensionTotal - minExtYr];   // Y1(ext) at 20% floor, Y2(ext) heavy
    } else {
      for (let i = 0; i < years; i += 1) extYearSalaries.push(futureSalary);
    }

    const yearParts = [];
    for (let idx = 1; idx <= totalLength; idx += 1) {
      const yearSalary = idx <= currentYears ? currentSalary : extYearSalaries[idx - currentYears - 1];
      yearParts.push("Y" + idx + "-" + formatContractK(yearSalary));
    }
    const tcv = currentSalary * currentYears + extensionTotal;
    const gtd = guaranteeForContract(tcv, totalLength);  // §D1 sub-$5K rule (extension preview)
    const aavDisplay = formatContractK(currentSalary) + ", " + formatContractK(futureSalary);

    const team = findTeamById(p.fid);
    const existingOwners = parseExtensionHistoryTokens(p.special || "");
    const ownerToken = extensionOwnerTokenForTeam(team, p);
    const ownerNorm = normalizeIdentityToken(ownerToken);
    if (ownerToken && ownerNorm) {
      const has = existingOwners.some(function (t) { return normalizeIdentityToken(t) === ownerNorm; });
      if (!has) existingOwners.push(ownerToken);
    }

    const contractStatusBase = "Vet-Ext" + years;
    const contractStatus = loading === "FL" ? contractStatusBase + "-FL"
                          : loading === "BL" ? contractStatusBase + "-BL"
                          : contractStatusBase;
    let contractInfo =
      "CL " + totalLength +
      "|TCV " + formatContractK(tcv) +
      "|AAV " + aavDisplay +
      "|" + yearParts.join(", ") +
      "|GTD: " + formatContractK(gtd);
    if (existingOwners.length) contractInfo += "|Ext: " + existingOwners.join(", ");

    // MFL `salary` = the CURRENT-year salary. A held player (currentYears≥1)
    // keeps his current-year salary as Y1..Y_currentYears carry `currentSalary`;
    // an expired rookie (currentYears=0) signs a fresh deal whose Y1 IS the first
    // extension year. NEVER ship the extension-year salary as the current salary
    // (that shipped Hurts' 52K instead of his live 67K).
    const salaryToSend = currentYears >= 1 ? currentSalary : (extYearSalaries[0] || futureSalary);
    return {
      yearsToAdd: years,
      years: years,                 // alias for legacy preview readers
      years_added: years,           // unambiguous: years ADDED (not full length)
      loadedIndicator: loading,
      contractLength: totalLength,  // FULL new length (current remaining + added)
      contract_status: contractStatus,
      contractStatus: contractStatus,
      contract_info: contractInfo,
      contractInfo: contractInfo,
      info: contractInfo,
      currentAav: currentSalary,
      futureAav: futureSalary,
      tcv: tcv,
      salary: salaryToSend,
      year1_salary: salaryToSend,
      synthesized: true,
      sourceNote: "Synthesized client-side per canon §C4.6"
    };
  }
  function synthesizedExtensionOptionsForPlayer(p) {
    if (!p) return [];
    const elig = rosterContractEligibility(p);
    if (!elig.extensionEligible || extensionBlockedByCurrentOwner(p)) return [];
    const out = [];
    const opt1 = synthesizeExtensionOption(p, 1, "NONE");        if (opt1) out.push(opt1);
    const opt2  = synthesizeExtensionOption(p, 2, "NONE");       if (opt2)  out.push(opt2);
    const opt2F = synthesizeExtensionOption(p, 2, "FL");         if (opt2F) out.push(opt2F);
    const opt2B = synthesizeExtensionOption(p, 2, "BL");         if (opt2B) out.push(opt2B);
    return out;
  }
  // Re-anchor a stale worker preview to the LIVE current-year salary.
  // The ups_extension_previews snapshot goes stale when a contract rolls a
  // year forward (Quentin Johnston: snapshot Y1-$8K while the live roster is
  // $18K), and FO v2 otherwise trusts it verbatim — so the picker showed $8K
  // and the worker's stale-salary guard would 409 the submit. For a player who
  // still has a year remaining (case A), the current year (Y1) must equal the
  // live roster salary; the per-year escalation is canon, so shift EVERY salary
  // in the preview (year tokens + AAV) by delta = liveCurrent − snapshotCurrent.
  // A uniform shift re-anchors Y1 to live, preserves the escalation AND any
  // FL/BL shape, then we recompute TCV + GTD. Expired rookies (years<=0) sign a
  // FRESH deal with no current-year carry-over, so they're left as-is.
  // Keith 2026-06-27 (QJ 8K→18K). Mirrors the re-anchor in roster_workbench.js
  // + site/m/front_office_extend_submit.js.
  function reanchorWorkerPreview(p, r, opt) {
    const curYears = Math.max(0, safeInt(p && p.years, 0));
    if (curYears < 1) return opt;                                  // case B — fresh deal, no carry-over
    const liveCur = roundToK(safeInt(p && p.salary, 0));
    const staleCur = safeInt(r && r.new_aav_current, 0);
    if (!(liveCur > 0) || !(staleCur > 0) || liveCur === staleCur) return opt;  // nothing stale to fix
    const delta = liveCur - staleCur;
    const info = safeStr(opt.contract_info);
    const yv = parseContractYearValues(info);
    const yearNums = Object.keys(yv).map(Number).sort(function (a, b) { return a - b; });
    if (!yearNums.length) return opt;
    let newTcv = 0;
    yearNums.forEach(function (n) { newTcv += Math.max(1000, roundToK(yv[n] + delta)); });
    const cl = safeInt(opt.contractLength, 0) || yearNums.length;
    const newGtd = guaranteeForContract(newTcv, cl);
    const shifted = info
      .replace(/Y(\d+)\s*-\s*[0-9.]+\s*K?/gi, function (m, n) {
        const base = yv[safeInt(n, 0)];
        return base > 0 ? "Y" + n + "-" + formatContractK(Math.max(1000, roundToK(base + delta))) : m;
      })
      .replace(/AAV\s+[0-9.]+\s*K?(?:\s*,\s*[0-9.]+\s*K?)*/i, function (m) {
        return m.replace(/[0-9.]+\s*K?/g, function (tok) {
          const d = parseContractMoneyToken(tok);
          return d > 0 ? formatContractK(Math.max(1000, roundToK(d + delta))) : tok;
        });
      })
      .replace(/TCV\s+[0-9.]+\s*K?/i, "TCV " + formatContractK(newTcv))
      .replace(/GTD:\s*[0-9.]+\s*K?/i, "GTD: " + formatContractK(newGtd));
    const firstExtIdx = curYears + 1;
    const newSalary = Math.max(1000, roundToK(
      (yv[firstExtIdx] != null ? yv[firstExtIdx] : safeInt(opt.salary, 0)) + delta
    ));
    return Object.assign({}, opt, {
      contract_info: shifted, contractInfo: shifted, info: shifted,
      currentAav: liveCur,
      futureAav: Math.max(1000, roundToK(safeInt(opt.futureAav, 0) + delta)),
      tcv: newTcv,
      salary: newSalary,
      year1_salary: newSalary,
      reanchored: true,
    });
  }
  // Worker preview rows arrive in the shape returned by the
  // ups_extension_previews table (extension_term="1YR"/"2YR",
  // loaded_indicator, new_TCV, new_aav_current/future, etc.). Normalize
  // them to the same shape synthesizeExtensionOption produces so the
  // rest of the pipeline (button render, pickExtensionOption, submit)
  // is uniform. Filter to success=1 && committed=0 && reverted=0; the
  // worker recomputes previews periodically — dedupe to the latest
  // preview_ts per (term, loading) combo.
  function normalizeWorkerPreviewRows(p, rows) {
    const valid = rows.filter(function (r) {
      return r && safeInt(r.success, 0) === 1 &&
             safeInt(r.committed, 0) === 0 &&
             safeInt(r.reverted, 0) === 0;
    });
    const byKey = Object.create(null);
    for (let i = 0; i < valid.length; i += 1) {
      const r = valid[i];
      const term = safeStr(r.extension_term).toUpperCase();
      const yrs = term === "1YR" ? 1 : term === "2YR" ? 2 : 0;
      if (!yrs) continue;
      const loading = safeStr(r.loaded_indicator).toUpperCase() || "NONE";
      const key = yrs + ":" + loading;
      const prev = byKey[key];
      if (!prev || safeStr(r.preview_ts) > safeStr(prev.preview_ts)) {
        byKey[key] = r;
      }
    }
    return Object.values(byKey).map(function (r) {
      const yrs = r.extension_term === "1YR" ? 1 : 2;
      const loading = safeStr(r.loaded_indicator).toUpperCase() || "NONE";
      const info = safeStr(r.preview_contract_info_string);
      // For a +1Y on a 1-yr-remaining player, Y2 is the extension year.
      // For +2Y, Y2 and Y3 are extension years. Pull the first ext-year
      // salary out of the contract_info Y-tokens to use as salaryToSend.
      const yv = parseContractYearValues(info);
      const curYears = Math.max(0, safeInt(p.years, 0));
      // MFL `salary` = the CURRENT-year salary — the Y-token for the season being
      // played now, NOT the extension-year salary. curYears is 1 (held final-year
      // player → Y1 is current) or 0 (expired rookie → fresh deal, Y1 is current)
      // for any extension-eligible player, so the current-year token is Y1. Sending
      // yv[curYears+1] shipped the extension year (Hurts: 52K instead of 67K). Read
      // the preview's OWN Y-tokens — NEVER player.salary (a 2026-06-27 re-anchor to
      // player.salary corrupted every loaded contract; see the NOTE below).
      const curYearIdx = Math.max(1, curYears);
      const salaryToSend = yv[curYearIdx] || safeInt(r.new_aav_current, 0);
      const baseOpt = {
        yearsToAdd: yrs,
        years: yrs,
        years_added: yrs,             // unambiguous: years ADDED (not full length)
        loadedIndicator: loading,
        contractLength:  safeInt(r.new_contract_length, 0),
        contract_status: safeStr(r.new_contract_status),
        contractStatus:  safeStr(r.new_contract_status),
        contract_info:   info,
        contractInfo:    info,
        info:            info,
        currentAav:      safeInt(r.new_aav_current, 0),
        futureAav:       safeInt(r.new_aav_future, 0),
        tcv:             safeInt(r.new_TCV, 0),
        salary:          salaryToSend,
        year1_salary:    salaryToSend,
        synthesized: false,
        sourceNote: "Worker preview (preview_ts " + safeStr(r.preview_ts) + ")"
      };
      // NOTE: the worker preview is used AS-IS. An earlier "re-anchor to live
      // salary" attempt (2026-06-27) was REVERTED — the snapshot anchors to the
      // AAV (TCV/CL), which is NOT the loaded current-year salary, so a uniform
      // shift to player.salary corrupted every back/front-loaded contract (Jalen
      // Hurts 52K→77K). Stale snapshots (the QJ class) are fixed at the SOURCE by
      // regenerating ups_extension_previews, not by client surgery.
      return baseOpt;
    });
  }

  // Resolve the effective preview list — worker rows win when present
  // (after normalization + dedup); synthesized falls in when empty
  // (MHJ-class players the worker didn't pre-compute).
  function effectiveExtensionPreviews(p) {
    const fromWorker = Array.isArray(p && p.extensionPreviews) ? p.extensionPreviews : [];
    const normalized = fromWorker.length ? normalizeWorkerPreviewRows(p, fromWorker) : [];
    if (normalized.length) return normalized;
    return synthesizedExtensionOptionsForPlayer(p);
  }

  // ── Auction month rule (Keith 2026-07-26) ────────────────────────────
  // "if month = july or august and acquisition type = auction then FAA;
  //  if auction before july and acquisition type = auction then era."
  // Matches canon §C1: the ERA runs late May, the FA Auction late July / early
  // August. Used below as the MYAC window's LOWER bound.
  //
  // WHY a lower bound is needed: the upper bound (isPastContractDeadlineFO)
  // FAILS OPEN when the season's contract_deadline event hasn't loaded. SEASON
  // rolls to the new year on Jan 1, but MFL only clears contractYear on ITS
  // league-year rollover weeks later — so every un-converted Vet-FAA sits at
  // cy=1 / CL 1 through that gap and would be re-offered MYAC on an already
  // dead contract. Requiring July-or-later closes that window.
  function currentEtMonthFO() {
    try {
      return safeInt(new Date().toLocaleString("en-US", { timeZone: "America/New_York", month: "numeric" }), 0);
    } catch (_) { return new Date().getMonth() + 1; }
  }
  function inAuctionMyacMonthWindowFO(kind) {
    var m = currentEtMonthFO();
    return kind === "era" ? m >= 5 : m >= 7;
  }

  // ── Pre-season acquisition ladder (canon ~379 / ~785) ─────────────────
  // A player acquired via FA Auction OR PRE-SEASON WAIVERS walks ONE
  // sequential ladder, each rung offered only inside its own window:
  //   Multi-Year Contract (MYAC)  now               → September contract deadline
  //   Mid-Year Multi (MYM)        contract deadline → NFL Week 3 kickoff
  //   Extension                   Week 3 kickoff    → NFL Week 5 kickoff
  //   (after Week 5)              nothing
  // Verbatim-as-possible port of the same block in site/m/front_office_actions.js
  // (contractLadderDatesFO / contractLadderStageFO / preseasonWwClassFO,
  // 2026-08-08), which shipped there first because desktop had no WW→MYAC
  // path at all — see that file's header for the full history. Read the
  // comparison operators below (<=, <) and the out-of-order refusal guards
  // as deliberate, ported unchanged from mobile.
  //
  // The IN-SEASON WW/FCFS rule (canon ~391: MYM days 1-14, Extension days
  // 15-28, isInSeasonPickup below) is a DIFFERENT rule and is untouched by
  // any of this. The split between them is NFL Week 1's kickoff INSTANT,
  // not "acquired this season".
  function finiteMsOrNullFO(v) {
    var n = typeof v === "number" ? v : parseInt(v, 10);
    return isFinite(n) && n > 0 ? n : null;
  }
  // Raw week_kickoffs values from the worker are unix SECONDS (see
  // worker/src/index.js nflWeekFirstKickoffUnix); every ms comparison below
  // needs ms, so this is the ONE place the *1000 happens — mirrors mobile's
  // app.js kickoffMsFrom exactly.
  function kickoffMsFromFO(map, week) {
    var v = map ? map[String(week)] : null;
    var n = typeof v === "number" ? v : parseInt(v, 10);
    return isFinite(n) && n > 0 ? n * 1000 : null;
  }
  // Display-only ET calendar day for an epoch-ms instant. Never used in a
  // comparison — those all run on the ms instant itself.
  function isoEtDayFromMsFO(ms) {
    if (ms == null) return "";
    try {
      var parts = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(ms));
      var map = {};
      parts.forEach(function (part) { map[part.type] = part.value; });
      return map.year && map.month && map.day ? (map.year + "-" + map.month + "-" + map.day) : "";
    } catch (e) { return ""; }
  }

  // Which rung is open RIGHT NOW. Shape (verbatim mirror of mobile's
  // contractLadderStageFO shape):
  //   { stage: "myac"|"mym"|"extension"|"closed"|"unresolved",
  //     date: ISO|"", endMs: number|null }
  // League-wide boundaries only — no player-specific input, so `p` is
  // accepted (for call-site symmetry with isPreseasonWwPickupFO(p)) but
  // unused. Reads STATE.contractDeadlineMs / STATE.weekKickoffs directly,
  // same as mobile reads window.UPS_MOBILE.state.contractLadder directly.
  function contractLadderStageFO_desktop(p) {
    var cdEnd = finiteMsOrNullFO(STATE.contractDeadlineMs);
    var mymEnd = finiteMsOrNullFO(STATE.weekKickoffs && STATE.weekKickoffs[3]);   // Week 3 kickoff
    var extEnd = finiteMsOrNullFO(STATE.weekKickoffs && STATE.weekKickoffs[5]);   // Week 5 kickoff
    var now = Date.now();
    var UNRESOLVED = { stage: "unresolved", date: "", endMs: null };
    // Out-of-order boundaries mean our inputs are telling us something we
    // can't act on. Refuse rather than pick an interpretation.
    if (cdEnd != null && mymEnd != null && mymEnd <= cdEnd) return UNRESOLVED;
    if (mymEnd != null && extEnd != null && extEnd <= mymEnd) return UNRESOLVED;
    if (cdEnd == null) return UNRESOLVED;
    if (now <= cdEnd) return { stage: "myac", date: isoEtDayFromMsFO(cdEnd), endMs: cdEnd };
    if (mymEnd == null) return UNRESOLVED;
    // Strictly BEFORE kickoff: the window closes when the week starts playing.
    if (now < mymEnd) return { stage: "mym", date: isoEtDayFromMsFO(mymEnd), endMs: mymEnd };
    if (extEnd == null) return UNRESOLVED;
    if (now < extEnd) return { stage: "extension", date: isoEtDayFromMsFO(extEnd), endMs: extEnd };
    return { stage: "closed", date: "", endMs: null };
  }

  // Is THIS player on the PRE-SEASON waiver rung of the ladder? Returns
  // "yes" | "no" | "unknown". Verbatim-as-possible port of mobile's
  // preseasonWwClassFO. Classified off the CONTRACT STATUS MFL actually
  // holds ("Vet-WW", "Vet-WW-BL", "Rookie-WW") plus the acquisition date,
  // NOT off the acquisition LABEL the way isInSeasonPickup below is — the
  // label comes from the commish-maintained static
  // player_acquisition_lookup_<year>.json, which cannot contain a claim
  // made this summer, so a label test silently misses every fresh pickup
  // (the reported Malik Davis bug).
  //
  // "unknown" whenever Week 1's kickoff instant or this player's acquisition
  // instant cannot be established — never guessed (an unreadable input is
  // never "empty").
  function isPreseasonWwPickupFO(p) {
    var status = safeStr(p && p.type).toLowerCase();
    if (!/\bww\b/.test(status)) return "no";
    if (status.indexOf("tag") !== -1) return "no";
    if (safeInt(p && p.years, 0) !== 1) return "no";
    // CL is the ORIGINAL contract length and never decays (a converted MYAC
    // writes CL 2/CL 3 and keeps the WW status token) — same gate the three
    // auction arms below (isEra/isFreshAuction/isFreshFaaStatus) carry: CL===1
    // is "still on the 1-year default"; CL 2/3 is an already-converted deal,
    // past this ladder entirely.
    if (parseContractLengthValue(p && p.special) !== 1) return "no";
    if (rookieOptionActionEligible(p)) return "no";
    // A WW contract that changed hands by TRADE was not acquired on waivers
    // by its current owner — the §C4 trade clock applies, not this ladder.
    if (safeStr(p && p.acquisitionTypeLabel).toLowerCase().indexOf("trade") !== -1) return "no";

    // The pre-season / in-season line is NFL Week 1's FIRST kickoff — the
    // real instant from MFL's own schedule (STATE.weekKickoffs[1]), not a
    // hand-typed calendar row.
    var startMs = finiteMsOrNullFO(STATE.weekKickoffs && STATE.weekKickoffs[1]);
    // Noon ET of the acquisition day — same parsing convention this file
    // already uses elsewhere (extensionDeadlineForPlayer's acqDate, the
    // mymDays acqDateMs in rosterContractEligibility below). Desktop's roster
    // rows carry only the acquisition DAY (from the static lookup), never an
    // exact unix instant the way mobile's live-transaction-log rows can, so
    // this is the one and only path (mobile's acqMs also falls back to it).
    var acqMs = (function () {
      try {
        var raw = safeStr(p && p.acquisitionDate).slice(0, 10);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
        var d = new Date(raw + "T12:00:00-04:00");
        return isNaN(d.getTime()) ? null : d.getTime();
      } catch (e) { return null; }
    })();
    if (acqMs != null) {
      if (startMs == null) return "unknown";          // can't place the pickup
      return acqMs < startMs ? "yes" : "no";           // "no" = in-season path
    }
    // No acquisition date (the usual case for a claim the static lookup
    // predates). Before Week 1 there is nothing to resolve — a WW contract
    // on the roster today cannot have been acquired in a week that hasn't
    // started. On or after Week 1 we genuinely don't know which rule applies.
    if (startMs == null) return "unknown";
    return Date.now() < startMs ? "yes" : "unknown";
  }

  function rosterContractEligibility(p) {
    var years = Math.max(0, safeInt(p && p.years, 0));
    var salary = safeInt(p && p.salary, 0);
    var status = safeStr(p && p.type).toLowerCase();
    var info = safeStr(p && p.special).toLowerCase();
    var noFurther = info.indexOf("no further extensions") !== -1 ||
                    info.indexOf("not eligible for tag or extension") !== -1;
    var expiredRookie = info.indexOf("expired rookie") !== -1 ||
                        (rookieLikeContractStatus(status) && years <= 0);
    // MYAC (Multi-Year Auction Contract, §C2): a 1-year DEFAULT from a fresh
    // acquisition can be set to 2 or 3 years until the September contract
    // deadline. Two entry paths (§C1): (1) ERA win → Vet-ERA; (2) FA Auction →
    // 1-yr Veteran THIS season. The acquisition-date + auction label separate a
    // fresh FA-auction Veteran from a HELD final-year Veteran (which gets a normal
    // Extension, not MYAC). Match the ERA token specifically (not "vetERAn").
    var acqLabel = safeStr(p && p.acquisitionTypeLabel).toLowerCase();
    var acqYr = safeStr(p && p.acquisitionDate).slice(0, 4);
    var isEra = status.indexOf("-era") !== -1;
    var isFreshAuction = !isEra && /auction|faa/.test(acqLabel) &&
                         acqLabel.indexOf("expired") === -1 && acqLabel.indexOf("rookie") === -1 &&
                         acqYr === String(SEASON) && !rookieLikeContractStatus(status) && status.indexOf("tag") === -1;
    // FAA read straight off contractStatus, exactly like ERA one line up.
    // Canon (§A3, line 174) created Vet-FAA "so a fresh auction win is never
    // treated as a held final-year veteran, and the MYAC path stays available" —
    // but only ERA ever got a contractStatus test. FAA rode entirely on
    // acquisitionTypeLabel, which is stamped from the COMMISH-MAINTAINED static
    // site/rosters/player_acquisition_lookup_<yr>.json (last regenerated
    // 2026-03-10). A player won minutes ago is not in that file, so acqLabel
    // was "" -> isFreshAuction false -> MYAC hidden and Extension wrongly
    // offered instead. Verified against all 7 finalized 2026 FAA winners.
    //
    // CL is the ORIGINAL contract length and never decays (a converted MYAC
    // writes "CL 2"/"CL 3" and keeps status Vet-FAA), so CL===1 is canon C2's
    // "currently on 1-year default". FAILS CLOSED on an unreadable CL: a hidden
    // button is recoverable, an irreversible multi-year MFL write is not.
    var isFreshFaaStatus = status.indexOf("-faa") !== -1 &&
                           parseContractLengthValue(p && p.special) === 1 &&
                           !rookieLikeContractStatus(status) && status.indexOf("tag") === -1 &&
                           inAuctionMyacMonthWindowFO("faa");

    // ── Pre-season acquisition ladder (canon ~379/~785) ─────────────────
    // A PRE-SEASON WW/FCFS/waiver pickup (Malik Davis, picked up 2026-08-09 —
    // before Week 1 kickoff) walks the SAME MYAC→MYM→Extension ladder a fresh
    // auction win does, NOT the in-season 14-day MYM / 15–28-day extension
    // clock below. wwClass "unknown" gets no ladder action at all — an
    // unresolvable window is not an open one. See isPreseasonWwPickupFO /
    // contractLadderStageFO_desktop for the boundary math.
    var wwClass = isPreseasonWwPickupFO(p);
    var ladder = wwClass === "yes" ? contractLadderStageFO_desktop(p) : null;

    var myacEligible = (isEra || isFreshAuction || isFreshFaaStatus ||
                        (wwClass === "yes" && !!ladder && ladder.stage === "myac")) &&
                       years === 1 && !isPastContractDeadlineFO();
    // MYM (Mid-Year Multi, §C3): an in-season WW/FCFS/waiver pickup can convert
    // to a FLAT 2- or 3-year deal within 14 days of acquisition. Distinct from
    // MYAC (auction wins) and Extension. Best-effort from the acquisition
    // label/date the roster carries; the worker re-validates the 14-day window +
    // the 4-per-season cap on submit. WW pickup days 1–14 = MYM, days 15–28 =
    // extension — so this is mutually exclusive with the extension window.
    //
    // `wwClass === "no"` keeps a PRE-SEASON claim off this path — the 14/28-day
    // clocks are the IN-SEASON rule; a pre-season pickup runs the ladder above
    // instead. By construction a WW/FCFS pickup can never satisfy both paths:
    // wwClass is exactly one of "yes" (ladder) / "no" (this clock) / "unknown"
    // (neither).
    // wwClass !== "yes" -- deliberately NOT === "no". "unknown" (the
    // /api/league-events kickoffs fetch failed, or never resolved this
    // session) must fall through to the SAME 14-day-from-acquisition
    // evaluation this file has always used, not fail closed.
    //
    // Before this ladder existed, mymEligible for an in-season pickup
    // depended ONLY on mymDays (derived from p.acquisitionDate) -- nothing
    // about /api/league-events. Requiring wwClass === "no" here would make
    // that fetch's success a new, previously-nonexistent dependency for a
    // completely unrelated, already-working feature: an outage would
    // silently flip mymEligible=true to false for a real in-season player
    // mid-window, for the whole browser session, with no visible error
    // (caught in review). wwClass !== "yes" preserves the pre-existing
    // behavior whenever we cannot positively confirm PRE-season instead --
    // the ladder's own arms (myacEligible's new OR-branch, and mymEligible's
    // ladder check below) stay strictly gated on wwClass === "yes" and never
    // fire on "unknown", so nothing is offered on a guess either way.
    var isInSeasonPickup = /\b(ww|fcfs|blind|waiver|free agent)\b/.test(acqLabel) &&
                           acqLabel.indexOf("auction") === -1 && acqYr === String(SEASON) &&
                           wwClass !== "yes";
    var acqDateMs = (function () {
      try { var d = new Date(safeStr(p && p.acquisitionDate).slice(0, 10) + "T12:00:00-04:00");
            return isNaN(d.getTime()) ? null : d.getTime(); } catch (_) { return null; }
    })();
    var mymDays = acqDateMs != null ? Math.floor((Date.now() - acqDateMs) / 86400000) : null;
    // wwClass "yes" — ladder rung 2 (contract deadline → Week 3 kickoff),
    // REPLACING the day-count test for this player entirely (not adding to
    // it). wwClass "no" OR "unknown" — the untouched in-season day clock,
    // byte-identical to the pre-ladder behavior (isInSeasonPickup requires
    // wwClass !== "yes", so "unknown" falls through here rather than
    // suppressing eligibility on a fetch that this rule never used to
    // depend on).
    var mymEligible = wwClass === "yes"
      ? (!!ladder && ladder.stage === "mym" && !myacEligible &&
         status.indexOf("tag") === -1 && !rookieOptionActionEligible(p))
      : (isInSeasonPickup && mymDays != null && mymDays >= 0 && mymDays <= 14 &&
         years <= 1 && status.indexOf("tag") === -1 && !myacEligible &&
         !rookieOptionActionEligible(p));
    var extCandidate = !rookieOptionActionEligible(p) && status.indexOf("tag") === -1 &&
                       !noFurther && !myacEligible && (years === 1 || expiredRookie);
    return {
      myacEligible: myacEligible,
      mymEligible: mymEligible,
      // Ladder players (wwClass "yes") carry NO day-count — their window is a
      // calendar boundary (Week 3 kickoff), not a clock started by their
      // pickup, so "Day N of 14" would misreport it. Mirrors mobile's
      // rosterContractEligibility exactly.
      mymDaysSinceAcq: wwClass === "yes" ? null : mymDays,
      // Base candidate: final year (cy=1) or expired rookie, not tag/option/MYAC.
      // extensionEligible additionally requires being inside the §C4 deadline
      // WINDOW (rookie → May of expiry year, veteran → September, WW → days 15–28,
      // trade-acquired → 4 weeks) via extensionDeadlineForPlayer().in_window — the
      // worker mirrors the same split. extensionCandidate ignores the window so
      // the Extensions tab can list everyone + their deadline.
      extensionCandidate: extCandidate,
      extensionEligible: extCandidate && extensionDeadlineForPlayer(p).in_window,
      rookieOptionEligible: rookieOptionActionEligible(p),
      restructureEligible: years >= 2 && years <= 3 && salary > 1000 && !rookieLikeContractStatus(status),
      untagEligible: status === "tag" && !isPastTagDeadlineFO(),
      // For the surfaces that print a human-readable acquisition/entry label
      // (renderMyacTab's "Auction Type" column, renderActionsTab's "Records
      // as" note) — a ladder player got here by a PRE-SEASON waiver pickup,
      // never an actual FA-Auction or ERA win, and the copy must say so.
      preseasonWaiverPickup: wwClass === "yes"
    };
  }

  // §C2 MYAC window closes at the September contract deadline (D1 league_events
  // `ups_contract_deadline`, e.g. 2026-09-06). Unknown → treat as within window
  // (show MYAC) so a load failure never blocks the option.
  function isPastContractDeadlineFO() {
    var d = STATE.contractDeadline;
    if (!d) return false;
    try { return new Date() > new Date(d + "T23:59:59-04:00"); } catch (_) { return false; }
  }

  // Tag deadline (canon §C8.2): midnight ET on the Thu→Fri boundary before
  // Memorial Day = Memorial Day (last Mon of May) − 3 days at 04:00 UTC. The TAG
  // label locks then, so untag is blocked past it (mirrors the worker guard at
  // /commish-contract-update). Computed client-side off SEASON.
  function isPastTagDeadlineFO() {
    try {
      var yr = parseInt(SEASON, 10) || new Date().getUTCFullYear();
      var may31 = new Date(Date.UTC(yr, 4, 31));
      var lastMon = 31 - ((may31.getUTCDay() + 6) % 7);   // last Monday of May
      var dl = new Date(Date.UTC(yr, 4, lastMon));
      dl.setUTCDate(dl.getUTCDate() - 3);
      dl.setUTCHours(4, 0, 0, 0);
      return Date.now() > dl.getTime();
    } catch (e) { return false; }   // fail-open: worker still enforces authoritatively
  }

  // May rookie/tag deadline (midnight ET Thu→Fri before Memorial Day) for any year.
  function tagDeadlineDateFO(year) {
    var yr = parseInt(year, 10);
    if (!yr) return null;
    var may31 = new Date(Date.UTC(yr, 4, 31));
    var lastMon = 31 - ((may31.getUTCDay() + 6) % 7); // last Monday of May
    var dl = new Date(Date.UTC(yr, 4, lastMon));
    dl.setUTCDate(dl.getUTCDate() - 3);               // Thu→Fri boundary
    dl.setUTCHours(4, 0, 0, 0);                        // 00:00 EDT
    return dl;
  }
  // September contract deadline (current season) from league_events.
  function contractDeadlineDateFO() {
    var d = STATE.contractDeadline;
    if (!d) return null;
    try { return new Date(String(d).slice(0, 10) + "T21:00:00-04:00"); } catch (_) { return null; }
  }
  // Per-player §C4 extension deadline. Returns { date, start, basis, days_until,
  // in_window }. Mirrors the worker lock:
  //   • In-season WW/FCFS pickup → extension window is days 15–28 from pickup.
  //   • In-season trade-acquired final-year → within 4 weeks of acquisition.
  //   • Rookie-draft contract → May rookie-extension deadline of (season + cy).
  //   • Veteran final-year → September contract deadline of the season.
  function extensionDeadlineForPlayer(p) {
    var seasonInt = parseInt(SEASON, 10) || new Date().getUTCFullYear();
    var cy = Math.max(0, safeInt(p && p.years, 0));
    var statusLc = safeStr(p && p.type).toLowerCase();
    var expiredRookie = safeStr(p && p.special).toLowerCase().indexOf("expired rookie") !== -1 ||
                        (rookieLikeContractStatus(statusLc) && cy <= 0) || !!(p && p.isExpiredRookie);
    var isRookieContract = rookieLikeContractStatus(statusLc) || expiredRookie;
    var acqLabel = safeStr(p && p.acquisitionTypeLabel).toLowerCase();
    var acqYr = safeStr(p && p.acquisitionDate).slice(0, 4);
    var acquiredThisSeason = acqYr === String(SEASON);
    var acqDate = null;
    try { if (p && p.acquisitionDate) acqDate = new Date(safeStr(p.acquisitionDate).slice(0, 10) + "T12:00:00-04:00"); } catch (_) {}
    var DAY = 86400000;

    // ── Pre-season acquisition ladder split (canon ~379/~785) ────────────
    // A WW/FCFS pickup made BEFORE Week 1 kickoff runs the MYAC→MYM→Extension
    // ladder (rung 3 = Extension, Week 3 → Week 5 kickoff), NOT the in-season
    // days-15-28 clock below — see isPreseasonWwPickupFO /
    // rosterContractEligibility. wwClass "no" leaves the isWW block below
    // COMPLETELY untouched for a genuine in-season pickup (byte-identical).
    var wwClass = isPreseasonWwPickupFO(p);
    if (wwClass === "yes") {
      var ladder = contractLadderStageFO_desktop(p);
      var extEndMs = finiteMsOrNullFO(STATE.weekKickoffs && STATE.weekKickoffs[5]);
      var mymEndMs = finiteMsOrNullFO(STATE.weekKickoffs && STATE.weekKickoffs[3]);
      var extDate = extEndMs != null ? new Date(extEndMs) : null;
      var extStart = mymEndMs != null ? new Date(mymEndMs) : null;
      var nowLadder = Date.now();
      // in_window comes straight from the ladder's own stage — not re-derived
      // from raw now/start/end comparisons — so this can never disagree with
      // contractLadderStageFO_desktop's out-of-order refusal.
      return {
        date: extDate,
        start: extStart,
        basis: "Pre-season WW/FCFS pickup — extension window (post-MYM)",
        days_until: extDate ? Math.ceil((extDate.getTime() - nowLadder) / DAY) : null,
        in_window: ladder.stage === "extension"
      };
    }
    if (wwClass === "unknown") {
      // Can't place this WW pickup on the ladder OR the in-season clock — no
      // extension window. Reuses the function's own null-date idiom (every
      // other branch's in_window/days_until derive from a possibly-null
      // `date` at the bottom) rather than inventing a new shape.
      return { date: null, start: null, basis: "Pre-season/in-season WW pickup — window could not be resolved", days_until: null, in_window: false };
    }

    var isWW = acquiredThisSeason && acqDate && /\b(ww|fcfs|blind|waiver|free agent)\b/.test(acqLabel) && acqLabel.indexOf("auction") === -1;
    var isTradeAcq = acquiredThisSeason && acqDate && acqLabel.indexOf("trade") !== -1;
    var date = null, start = null, basis = "";
    if (isWW) {
      start = new Date(acqDate.getTime() + 15 * DAY);  // days 1–14 = MYM
      date  = new Date(acqDate.getTime() + 28 * DAY);  // days 15–28 = extension
      basis = "WW/FCFS pickup — days 15–28";
    } else if (isTradeAcq) {
      date  = new Date(acqDate.getTime() + 28 * DAY);  // 4 weeks from acquisition
      basis = "Trade-acquired — 4 weeks";
    } else if (isRookieContract) {
      date  = tagDeadlineDateFO(seasonInt + cy);       // May of the expiry year
      basis = "Rookie — May " + (seasonInt + cy) + " (rookie-extension deadline)";
    } else {
      date  = contractDeadlineDateFO();                // September of the season
      basis = "Veteran — September contract deadline";
    }
    var now = Date.now();
    var days_until = date ? Math.ceil((date.getTime() - now) / DAY) : null;
    var in_window = !!date && now <= date.getTime() && (!start || now >= start.getTime());
    return { date: date, start: start, basis: basis, days_until: days_until, in_window: in_window };
  }

  function posBucket(p) {
    p = String(p || "").toUpperCase();
    if (["QB", "RB", "WR", "TE"].includes(p)) return p;
    if (p === "K") return "PK";
    if (p === "P") return "PN";
    if (["PK", "PN"].includes(p)) return p;
    return "IDP"; // DL/LB/DB/S/CB/DT/DE
  }

  // Contract-type CSS class: FAMILY first (rk = green, vet = blue, tag = yellow),
  // then a sub-hue to differentiate within the family. Returns "<family> <sub>"
  // (e.g. "vet vet-fl", "rk rk-draft") so the family base color always applies
  // and the sub rule (later in the stylesheet) overrides the hue. Works on raw
  // MFL statuses (FL/BL/WW/EXT1/MYM/Veteran/Rookie) AND canonical types
  // (Vet-FAA-FL, Rookie-Draft, …). FAA/ERA map to the family base per Keith.
  function ctypeClass(type) {
    var t = String(type || "").toUpperCase();
    if (!t || t === "-") return "unknown";
    if (t === "EXPIRED") return "expired";
    if (t.indexOf("TAG") >= 0) return "tag";
    var fam = t.startsWith("ROOKIE") ? "rk" : "vet";
    var sub = "";
    if (t.indexOf("FL") >= 0) sub = fam + "-fl";          // loaded (front)
    else if (t.indexOf("BL") >= 0) sub = fam + "-bl";     // loaded (back)
    else if (t.indexOf("EXT") >= 0) sub = fam + "-ext";   // extension
    else if (t.indexOf("WW") >= 0) sub = fam + "-ww";     // waiver
    else if (t.indexOf("MYM") >= 0) sub = fam + "-mym";   // make-your-mark
    // Auction wins — match the HYPHENATED token so plain "VETERAN" (which
    // contains the substring "ERA") never trips the ERA branch.
    else if (t.indexOf("-FAA") >= 0) sub = fam + "-faa";  // FA-auction win
    else if (t.indexOf("-ERA") >= 0) sub = fam + "-era";  // expired-rookie auction win
    else if (fam === "rk" && t.indexOf("DRAFT") >= 0) sub = "rk-draft";
    return sub ? (fam + " " + sub) : fam;
  }

  function rosterStatusClass(player) {
    if (player.isIr)   return "ir";
    if (player.isTaxi) return "taxi";
    return "active";
  }
  function rosterStatusLabel(player) {
    if (player.isIr)   return "IR";
    if (player.isTaxi) return "Taxi";
    return "Active";
  }

  // ── Bootstrap ───────────────────────────────────────────────────────
  async function init() {
    if (IS_DRY_RUN) {
      const banner = $("#fo-dryrun-banner");
      if (banner) banner.hidden = false;
    }

    setupTabs();
    setupSubviewChips();
    setupToolbar();
    setupSlideover();
    setupCapTabDelegation();
    setupTagTabDelegation();
    setupActivityTabDelegation();

    // Activity & Audit tab is local-dev only for now (Keith 2026-05-19:
    // "save that whole tab for local only ... not ready for prod until
    // after this week's deadlines"). Show only when the page is served
    // from localhost/127.0.0.1 or the user explicitly opts in with
    // ?activity=1 in the URL. Production MFL HPM frame stays hidden.
    const host = (window.location.hostname || "").toLowerCase();
    const isLocal = host === "localhost" || host === "127.0.0.1" || host === "0.0.0.0";
    const optIn = QS.get("activity") === "1";
    const tabBtn = $("#fo-tab-activity");
    if (tabBtn && (isLocal || optIn)) tabBtn.hidden = false;

    fetchJSON("VERSION.json?_=" + Date.now())
      .then(function (v) { STATE.version = v; renderVersionBadge(); })
      .catch(function () { renderVersionBadge(); });

    await Promise.all([loadMe(), loadRosterData()]);
    // Commish Settings moved to its own hub page (MESSAGE19&hub=commish-settings).
    renderHeaderMeta();
    populateTeamSelect();
    populateActionFilter();
    populateValueFilters();
    renderRosterTable();
    loadRosterIndicators(); // async — decorate rows with NFL status + news flags
    loadContractDeadline(); // async — Sept contract deadline gates the MYAC window
    const sumEl = $("#fo-contract-summary");
    if (sumEl) sumEl.addEventListener("click", function (e) {
      if (e.target && e.target.closest && e.target.closest(".fo-adj-info")) showAdjPopup();
    });
  }

  async function loadMe() {
    // Best effort: admin-state tells us if commish + viewer franchise.
    const fid = viewerFranchiseId();
    // Debug hook: on the real MFL page, `window.UPS_FO_FRANCHISE_DEBUG` (also
    // console-logged) shows every candidate signal so we can wire the correct
    // logged-in-franchise source (the cookie alone can't tell 0000 from 0008).
    try {
      window.UPS_FO_FRANCHISE_DEBUG = {
        resolved: fid,
        qs_franchise_id: QS.get("franchise_id") || null,
        win_FRANCHISE_ID: (typeof window.FRANCHISE_ID !== "undefined") ? window.FRANCHISE_ID : null,
        win_franchise_id: (typeof window.franchise_id !== "undefined") ? window.franchise_id : null,
        path: window.location.pathname,
        cookie_fid: franchiseIdFromCookies(LEAGUE_ID, SEASON) || null,
        popup_cookies: (String(document.cookie || "").match(/MFLPlayerPopup_[0-9_]+/g) || [])
      };
      console.log("[FO] franchise resolution →", window.UPS_FO_FRANCHISE_DEBUG);
    } catch (e) {}
    const qs = "?L=" + encodeURIComponent(LEAGUE_ID) + "&YEAR=" + encodeURIComponent(SEASON);
    // credentials: "omit" — the worker's admin-state route returns
    // useful data on IP/session bypass without cookies, and cross-origin
    // local testing trips Access-Control-Allow-Origin: * + credentials
    // (Keith reported the CORS error 2026-05-19). Submits below stay
    // with credentials: include because production runs same-origin
    // inside MFL's HPM frame.
    try {
      const r = await fetch(EP_ADMIN_STATE() + qs, { credentials: "omit", cache: "no-store" });
      STATE.me = r.ok ? await r.json() : { configured: !!fid };
    } catch (e) {
      STATE.me = { configured: !!fid };
    }
    if (fid) {
      STATE.me = Object.assign({}, STATE.me || {}, {
        configured: true,
        franchise_id: fid,
        source: STATE.me && STATE.me.source ? STATE.me.source : "url"
      });
    }
    // The worker's isAdmin reflects ITS OWN stored commish session (it reads
    // private owner emails via the MFL_COOKIE secret), so admin-state returns
    // isAdmin:true for EVERY viewer. Re-derive admin from the VIEWER's franchise
    // instead: the viewer is admin iff they ARE the commish franchise
    // (commishFranchiseId is returned by the same admin-state call). ?admin=1 /
    // ?admin=0 forces it so the commish can preview a regular-owner view.
    // NOTE: this gates the UI only — commish WRITES must still be authorized
    // server-side; do not rely on this client flag for security.
    // The worker's isAdmin reflects ITS OWN stored commish session (it reads
    // private owner emails via MFL_COOKIE), so it's true for EVERY viewer. Gate
    // the commish UI on the VIEWER's franchise instead: ONLY the dedicated MFL
    // commish login (commishFranchiseId — 0000 for UPS) gets commish
    // functionality. Keith's PLAYING team (0008) and every other franchise are
    // regular owners — Keith: "when im 0008 I dont want commish functionality, i
    // want to be a regular owner." Access commish features by viewing as the
    // commish login (or ?admin=1). ?admin=1 / ?admin=0 force it for testing.
    // (UI gate only — commish WRITES are authorized server-side.)
    const commishFid = pad4(STATE.me && STATE.me.commishFranchiseId);
    const adminQ = (QS.get("admin") || "").toLowerCase();
    let viewerIsAdmin;
    if (adminQ === "1" || adminQ === "true") viewerIsAdmin = true;
    else if (adminQ === "0" || adminQ === "false") viewerIsAdmin = false;
    else if (fid && commishFid) viewerIsAdmin = pad4(fid) === commishFid;
    else viewerIsAdmin = !!(STATE.me && STATE.me.isAdmin); // fallback: endpoint value
    STATE.me = Object.assign({}, STATE.me || {}, { isAdmin: viewerIsAdmin });
  }

  async function loadRosterData() {
    const tbody = $("#fo-roster-tbody");
    try {
      const url = EP_ROSTER() + "?L=" + encodeURIComponent(LEAGUE_ID) + "&YEAR=" + encodeURIComponent(SEASON);
      const payload = await fetchJSON(url);
      if (!payload || payload.ok !== true) {
        throw new Error(payload && payload.error ? payload.error : "Worker returned non-OK payload");
      }
      STATE.capAmount = safeInt(payload.salary_cap_dollars, 0);
      STATE.teams = normalizeTeamsPayload(payload);

      // Acquisition lookup + rookie-draft history must both run BEFORE
      // taxi repair — both feed §A1.4 salary derivation. History wins
      // when present (Keith 2026-05-19) because it has exact slot +
      // salary for every UPS rookie 2012-2025.
      const [acqRows, _historyLoaded, mflAdj, nextSeasonAdj] = await Promise.all([
        loadAcquisitionLookup(SEASON),
        loadRookieDraftHistory(),
        loadMflSalaryAdjustments(SEASON),
        loadNextSeasonDropPenalties(SEASON)
      ]);
      mergeAcquisitionLookupRows(STATE.teams, acqRows);
      // Interim client-side fix for fresh auction wins still sitting as $1K/
      // 0-year MFL stubs (before the poller finalizes them). Must run AFTER
      // the acquisition lookup (it needs the won-price detail + label) and
      // BEFORE the taxi repair. Zero writes — display-only. See
      // applyAuctionWinOverlay for the guards.
      applyAuctionWinOverlay(STATE.teams, safeInt(SEASON, 0));
      mergeMflSalaryAdjustments(STATE.teams, mflAdj);
      STATE.adjByFid = mflAdj.byFid || {}; // per-team line items for the Cap Alloc popup
      STATE.nextSeasonAdj = nextSeasonAdj; // ledger-only next-season drop penalties

      // Keith 2026-05-19: applies to ALL taxi guys, not just Watson.
      repairTaxiContractFallbacks(STATE.teams, safeInt(SEASON, 0));

      // Bundle prefetch — for expired-rookie players the synthesized
      // contract gets us "good enough" instantly, but D1's
      // src_contracts has the EXACT per-year history. Fire off bundles
      // for them in the background; each one that returns overrides
      // the synth with real numbers and re-renders. Keith 2026-05-19:
      // "bring in the entire contract view... NO NULLS."
      kickoffExpiredRookieBundlePrefetch();
    } catch (e) {
      console.error("[fo] roster load failed:", e);
      STATE.teams = [];
      if (tbody) {
        tbody.innerHTML = '<tr><td colspan="13" class="fo-table-error">Failed to load roster: ' +
          escapeHtml(e.message || String(e)) + '</td></tr>';
      }
    }
  }

  // Normalize worker payload into the shape v2 renders. Keep ALL fields
  // the submit functions need (years, contract_status / type, contract_info /
  // special, salary, aav, isIr, isTaxi, extension_previews) — these are
  // the inputs into the byte-for-byte mirrored submit paths.
  function normalizeTeamsPayload(payload) {
    const rows = Array.isArray(payload.teams) ? payload.teams : [];
    return rows.map(function (team) {
      const fid = pad4(team.franchise_id || team.id);
      const name = safeStr(team.franchise_name || team.name || ("Team " + fid));
      const playersRaw = Array.isArray(team.players) ? team.players : [];
      const players = playersRaw.map(function (p, idx) {
        const status = safeStr(p.status || p.roster_status).toUpperCase();
        const isTaxi = !!p.is_taxi || !!p.isTaxi || status === "TAXI_SQUAD";
        const isIr   = !!p.is_ir   || !!p.isIr   || status === "INJURED_RESERVE";
        return {
          id: safeStr(p.id || p.player_id),
          fid: fid,
          franchise: name,
          name: safeStr(p.name || p.player_name || ("Player " + (p.id || p.player_id))),
          position: safeStr(p.position).toUpperCase() || "-",
          positionGroup: positionGroupKey(p.position),
          nflTeam: safeStr(p.nfl_team || p.nflTeam || p.team).toUpperCase(),
          salary: safeInt(p.salary, 0),
          years: safeInt(p.years, 0),
          aav: safeInt(p.aav, 0),
          type: safeStr(p.type || p.contract_type || "-") || "-",
          special: safeStr(p.special || p.contract_info || "") || "-",
          // MFL has said NOTHING about this contract. The worker sends
          // contract_unknown when it declined to synthesize one; the local
          // derivation is belt-and-braces so a stale worker deploy still can't
          // make the table assert a contract that does not exist.
          // (Keith 2026-08-08, Brashard Smith: a blank MFL row was rendering as
          // a 2-year / $2,000 deal.)
          contractUnknown: (typeof p.contract_unknown === "boolean")
            ? p.contract_unknown
            : (safeInt(p.years, 0) <= 0 &&
               !safeStr(p.type || p.contract_type || "") &&
               !safeStr(p.special || p.contract_info || "")),
          status: status,
          isTaxi: isTaxi,
          isIr: isIr,
          order: safeInt(p.order, idx),
          extensionPreviews: Array.isArray(p.extension_previews || p.extensionPreviews)
            ? (p.extension_previews || p.extensionPreviews) : [],
          acquisitionText: safeStr(p.acquisition_text || p.notes || p.acquired || ""),
          espnId: safeStr(p.espn_id || p.espnId || ""),
          // Keith 2026-05-19: worker carries ups_draft_round + ups_draft_year
          // as first-class fields. For traded taxi rookies (acq_text =
          // "Trade (YYYY)" with no slot), these are the ONLY signal of
          // their original draft slot — primary input to §A1.4 derivation.
          upsDraftRound: safeInt(p.ups_draft_round, 0),
          upsDraftYear:  safeInt(p.ups_draft_year, 0),
          // Taxi-clock + permanent-promotion fields per canon §B2.
          taxiCallupsUsed:         safeInt(p.taxi_callups_used, 0),
          taxiCallupsMax:          safeInt(p.taxi_callups_max, 0),
          taxiCallupsPending:      safeInt(p.taxi_callups_pending, 0),
          taxiPermanentPromotion: !!p.taxi_permanent_promotion,
          taxiEligible:           !!p.taxi_eligible
        };
      });
      // Capture the worker's per-team summary so the Cap Plan Summary
      // can break out drop penalties + traded-salary + other adjustments
      // (Keith 2026-05-19: Salary / Drop / Trade / Total / %).
      //
      // Re-sum from the raw rows because the worker's pre-summed
      // breakdown has at least one known bug (Chubb row: explanation
      // says "750" but amount field = 750000, a 1000× K-multiplier
      // glitch that inflated L.A. Looks to $761K). For drop-penalty
      // rows we trust the explanation amount over the amount field
      // when they disagree by >10x. Trade rows preserve the sign so
      // counterparty offsets (e.g. Long Haulers −$20K vs HammerTime
      // +$20K) actually offset.
      // Worker raw rows are only a FALLBACK starting point (used if the MFL
      // fetch below fails). The post-load mergeMflSalaryAdjustments step
      // overrides adj_cut/trade/other from MFL's salaryAdjustments feed,
      // which is authoritative and free of the raw-row K-multiplier glitch.
      const sum = team.summary || {};
      const rawRows = Array.isArray(sum.salary_adjustment_raw_rows) ? sum.salary_adjustment_raw_rows : [];
      const workerSums = sumWorkerAdjustmentRows(rawRows);
      return {
        fid: fid, name: name,
        abbrev: safeStr(team.franchise_abbrev || team.abbrev || ""),
        logo: safeStr(team.icon_url || team.logo || ""),
        players: players,
        summary: {
          cap_total: safeInt(sum.cap_total_dollars, 0),
          adj_total: safeInt(sum.salary_adjustment_total_dollars, 0),
          adj_cut: workerSums.cut,
          adj_trade: workerSums.trade,
          adj_other: workerSums.other,
          compliance_ok: !!(sum.compliance && sum.compliance.ok),
          compliance_label: safeStr(sum.compliance && sum.compliance.label)
        }
      };
    }).sort(function (a, b) { return a.name.localeCompare(b.name); });
  }

  // ── Header / meta ───────────────────────────────────────────────────
  function renderVersionBadge() {
    const el = $("#fo-version-badge");
    if (!el) return;
    const v = STATE.version && STATE.version.version ? STATE.version.version : "0.1.0";
    el.textContent = "v" + v;
  }
  function renderHeaderMeta() {
    const meta = $("#fo-meta");
    if (!meta) return;
    const me = STATE.me || {};
    let who;
    if (!me.configured || !me.franchise_id) who = "Viewer";
    else if (me.isAdmin) who = "Commish 👑";
    else {
      const fid = pad4(me.franchise_id);
      const t = (STATE.teams || []).find(function (x) { return pad4(x.fid) === fid; });
      who = (t && t.name) || me.franchise_name || ("Franchise " + fid);
    }
    meta.textContent = "Logged in as: " + who;
  }

  // ── Tabs ────────────────────────────────────────────────────────────
  // The Contracts parent tab groups these subviews (in this order) under a
  // sub-tab chip bar (#fo-contracts-subnav). Each still has its own .fo-section.
  const CONTRACT_SUBTABS = ["myac", "extensions", "restructure", "mym", "tag"];
  function renderTabByKey(key) {
    if (key === "cap") renderCapTab();
    else if (key === "tag") renderTagTab();
    else if (key === "extensions") renderExtensionsTab();
    else if (key === "myac") renderMyacTab();
    else if (key === "restructure") renderRestructureTab();
    else if (key === "mym") renderMymTab();
    else if (key === "contractlog") renderContractLogTab();
    else if (key === "activity") renderActivityTab();
  }
  // Activate one of the Contracts subviews: its section goes active, the
  // Contracts parent button stays highlighted, and the sub-tab bar shows with
  // the matching chip active.
  function activateContractSubtab(sub) {
    if (CONTRACT_SUBTABS.indexOf(sub) === -1) sub = "myac";
    STATE.contractsSubtab = sub;
    STATE.activeTab = sub;
    $$("#fo-tabs button").forEach(function (b) { b.classList.toggle("active", b.dataset.tab === "contracts"); });
    $$(".fo-section").forEach(function (s) { s.classList.toggle("active", s.dataset.section === sub); });
    const subnav = $("#fo-contracts-subnav");
    if (subnav) {
      subnav.hidden = false;
      $$("button", subnav).forEach(function (b) { b.classList.toggle("active", b.dataset.subtab === sub); });
    }
    renderTabByKey(sub);
  }
  function setupTabs() {
    $$("#fo-tabs button").forEach(function (btn) {
      btn.addEventListener("click", function () {
        if (btn.disabled) return;
        const tab = btn.dataset.tab;
        if (!tab) return;
        // Contracts is a PARENT — open the last-used (or default) subview.
        if (tab === "contracts") { activateContractSubtab(STATE.contractsSubtab || "myac"); return; }
        if (tab === STATE.activeTab) return;
        STATE.activeTab = tab;
        $$("#fo-tabs button").forEach(function (b) { b.classList.toggle("active", b === btn); });
        $$(".fo-section").forEach(function (s) { s.classList.toggle("active", s.dataset.section === tab); });
        const subnav = $("#fo-contracts-subnav"); if (subnav) subnav.hidden = true;  // left the Contracts group
        renderTabByKey(tab);
      });
    });
    // Sub-tab chips under the Contracts parent.
    $$("#fo-contracts-subnav button").forEach(function (btn) {
      btn.addEventListener("click", function () {
        if (btn.dataset.subtab) activateContractSubtab(btn.dataset.subtab);
      });
    });
  }
  function setupSubviewChips() {
    $$(".fo-subview-chips").forEach(function (group) {
      const chips = $$(".fo-subview-chip", group);
      chips.forEach(function (chip) {
        chip.addEventListener("click", function () {
          chips.forEach(function (c) { c.classList.toggle("active", c === chip); });
          const tabSection = group.closest(".fo-section");
          if (!tabSection) return;
          if (tabSection.dataset.section === "cap") {
            STATE.capSubview = chip.dataset.subview;
            renderCapTab();
          }
          if (tabSection.dataset.section === "tag") {
            STATE.tagSubview = chip.dataset.subview;
            renderTagTab();
          }
          if (tabSection.dataset.section === "contractlog") {
            STATE.miscSubview = chip.dataset.subview;
            renderContractLogTab();
          }
        });
      });
    });
  }

  // ── Toolbar (Roster tab) ────────────────────────────────────────────
  function setupToolbar() {
    $$("#fo-group-toggle button").forEach(function (btn) {
      btn.addEventListener("click", function () {
        STATE.groupByPosition = btn.dataset.group === "position";
        $$("#fo-group-toggle button").forEach(function (b) { b.classList.toggle("active", b === btn); });
        renderRosterTable();
      });
    });
    $("#fo-team-select").addEventListener("change", function (e) {
      STATE.selectedTeamId = e.target.value || "__all__";
      // Remember the commish's "acting as" choice per league+season.
      if (STATE.me && STATE.me.isAdmin) {
        try { window.localStorage.setItem(foCommishTeamKey(), STATE.selectedTeamId); } catch (err) {}
      }
      // Re-scope the dynamic filters to the chosen team (dynamic per-team).
      populateValueFilters();
      populateActionFilter();
      renderRosterTable();
    });
    $("#fo-search").addEventListener("input", function (e) {
      STATE.search = String(e.target.value || "").toLowerCase();
      renderRosterTable();
    });
    $("#fo-reset-filters").addEventListener("click", function () {
      STATE.search = ""; $("#fo-search").value = "";
      STATE.filters = { pos: "ALL", type: "", status: "", years: "", action: "", loaded: false };
      $$("#fo-filter-pos .fo-pos-chip").forEach(function (c) {
        c.classList.toggle("active", c.dataset.pos === "ALL");
      });
      $("#fo-filter-type").value = "";
      $("#fo-filter-status").value = "";
      $("#fo-filter-years").value = "";
      $("#fo-filter-action").value = "";
      const lc = $("#fo-filter-loaded"); if (lc) lc.checked = false;
      renderRosterTable();
    });

    $$("#fo-filter-pos .fo-pos-chip").forEach(function (chip) {
      chip.addEventListener("click", function () {
        STATE.filters.pos = chip.dataset.pos || "ALL";
        $$("#fo-filter-pos .fo-pos-chip").forEach(function (c) { c.classList.toggle("active", c === chip); });
        renderRosterTable();
      });
    });
    $("#fo-filter-type").addEventListener("change", function (e) {
      STATE.filters.type = e.target.value; renderRosterTable();
    });
    $("#fo-filter-status").addEventListener("change", function (e) {
      STATE.filters.status = e.target.value; renderRosterTable();
    });
    $("#fo-filter-years").addEventListener("change", function (e) {
      STATE.filters.years = e.target.value; renderRosterTable();
    });
    $("#fo-filter-action").addEventListener("change", function (e) {
      STATE.filters.action = e.target.value; renderRosterTable();
    });
    const loadedChk = $("#fo-filter-loaded");
    if (loadedChk) loadedChk.addEventListener("change", function (e) {
      STATE.filters.loaded = !!e.target.checked; renderRosterTable();
    });

    // Sort headers
    $$("#fo-roster-table thead th[data-sort]").forEach(function (th) {
      th.addEventListener("click", function () {
        const col = th.dataset.sort;
        STATE.sort.userChosen = true;
        if (STATE.sort.key === col) STATE.sort.dir *= -1;
        else {
          STATE.sort.key = col;
          STATE.sort.dir = ["salary", "cap_hit", "aav", "years"].includes(col) ? -1 : 1;
        }
        renderRosterTable();
      });
    });
  }

  // Commish-only "Acting as" team switcher (Keith 2026-06-11). Regular owners
  // just see their own team (the field stays hidden). The commish login (0000,
  // which isn't a real team) picks which franchise to view/act-as; the choice
  // is remembered per league+season so the FO doesn't sit on the empty 0000 /
  // all-teams view. Writes already carry commish_override_flag for the acted-on
  // franchise, so acting-as is safe + audited.
  function foCommishTeamKey() { return "ups-fo-acting-as:" + LEAGUE_ID + ":" + SEASON; }
  function populateTeamSelect() {
    const sel = $("#fo-team-select");
    const opts = ['<option value="__all__">All teams (' + STATE.teams.length + ')</option>'];
    STATE.teams.forEach(function (t) {
      opts.push('<option value="' + escapeHtml(t.fid) + '">' + escapeHtml(t.name) + '</option>');
    });
    sel.innerHTML = opts.join("");
    const isAdmin = !!(STATE.me && STATE.me.isAdmin);
    const field = $("#fo-team-field");
    const lbl = $("#fo-team-field-label");
    if (isAdmin) {
      // Commish: reveal the switcher as "Acting as" and default to the
      // remembered franchise (else fall through to All teams).
      if (field) field.hidden = false;
      if (lbl) lbl.textContent = "Acting as";
      let remembered = "";
      try { remembered = window.localStorage.getItem(foCommishTeamKey()) || ""; } catch (e) {}
      if (remembered && (remembered === "__all__" || STATE.teams.find(function (t) { return t.fid === remembered; }))) {
        sel.value = remembered;
        STATE.selectedTeamId = remembered;
      }
      return;
    }
    // Regular owner: keep the switcher hidden, default to their own team.
    if (field) field.hidden = true;
    const myFid = STATE.me && STATE.me.franchise_id;
    if (myFid && STATE.teams.find(function (t) { return t.fid === myFid; })) {
      sel.value = myFid;
      STATE.selectedTeamId = myFid;
    }
  }

  // Dynamically prune the Action Eligibility filter — hide options that
  // match ZERO players so the dropdown reflects what's actually possible.
  // Keith 2026-05-19: "no Rookie Option-eligible players right now, just
  // exclude that option from the dropdown list." Same logic for all four
  // action filters; recomputes on every data load.
  function populateActionFilter() {
    const sel = $("#fo-filter-action");
    if (!sel) return;
    // Scope to the selected team so counts/options match the visible roster.
    const scopeTeams = STATE.selectedTeamId === "__all__"
      ? STATE.teams
      : STATE.teams.filter(function (t) { return t.fid === STATE.selectedTeamId; });
    const allPlayers = [];
    scopeTeams.forEach(function (t) { (t.players || []).forEach(function (p) { allPlayers.push(p); }); });
    const counts = { extension: 0, myac: 0, rookie_option: 0, restructure: 0, untag: 0 };
    for (let i = 0; i < allPlayers.length; i += 1) {
      const e = rosterContractEligibility(allPlayers[i]);
      if (e.extensionEligible)    counts.extension    += 1;
      if (e.myacEligible)         counts.myac         += 1;
      if (e.rookieOptionEligible) counts.rookie_option += 1;
      if (e.restructureEligible)  counts.restructure  += 1;
      if (e.untagEligible)        counts.untag        += 1;
    }
    const opts = ['<option value="">All</option>'];
    if (counts.extension    > 0) opts.push(`<option value="extension">Extension-eligible (${counts.extension})</option>`);
    if (counts.myac         > 0) opts.push(`<option value="myac">Auction-Contract-eligible (${counts.myac})</option>`);
    if (counts.rookie_option > 0) opts.push(`<option value="rookie_option">Rookie Option-eligible (${counts.rookie_option})</option>`);
    if (counts.restructure  > 0) opts.push(`<option value="restructure">Restructure-eligible (${counts.restructure})</option>`);
    if (counts.untag        > 0) opts.push(`<option value="untag">Currently Tagged (${counts.untag})</option>`);
    sel.innerHTML = opts.join("");
    if (STATE.filters.action && !counts[STATE.filters.action]) {
      STATE.filters.action = "";
    }
  }

  // Data-driven Years / Status / Type dropdowns — only surface values that
  // exist on the roster (Keith 2026-06-01: "years remaining 4+ but no players,
  // shouldn't be an option"). Mirrors populateActionFilter; recomputed on load.
  function populateValueFilters() {
    // Scope to the selected team so the filters are dynamic — a team with no
    // (say) MYM contract won't list MYM (Keith 2026-06-04). "All teams"
    // (__all__) spans the whole league. Re-run whenever the team changes.
    const scopeTeams = STATE.selectedTeamId === "__all__"
      ? STATE.teams
      : STATE.teams.filter(function (t) { return t.fid === STATE.selectedTeamId; });
    const all = [];
    scopeTeams.forEach(function (t) { (t.players || []).forEach(function (p) { all.push(p); }); });
    // Years Remaining
    const yset = {};
    all.forEach(function (p) { const y = safeInt(p.years, 0); yset[y >= 4 ? "4+" : String(y)] = true; });
    const yLbl = { "0": "0 (Expired)", "1": "1", "2": "2", "3": "3", "4+": "4+" };
    const ySel = $("#fo-filter-years");
    if (ySel) {
      const yo = ['<option value="">All</option>'];
      ["0", "1", "2", "3", "4+"].forEach(function (k) { if (yset[k]) yo.push('<option value="' + k + '">' + yLbl[k] + '</option>'); });
      ySel.innerHTML = yo.join("");
      if (STATE.filters.years && !yset[STATE.filters.years]) { STATE.filters.years = ""; }
      ySel.value = STATE.filters.years || "";
    }
    // Roster Status
    const sset = { active: false, taxi: false, ir: false };
    all.forEach(function (p) { if (p.isTaxi) sset.taxi = true; else if (p.isIr) sset.ir = true; else sset.active = true; });
    const sSel = $("#fo-filter-status");
    if (sSel) {
      const so = ['<option value="">All</option>'];
      if (sset.active) so.push('<option value="active">Active</option>');
      if (sset.taxi)   so.push('<option value="taxi">Taxi</option>');
      if (sset.ir)     so.push('<option value="ir">IR</option>');
      sSel.innerHTML = so.join("");
      if (STATE.filters.status && !sset[STATE.filters.status]) { STATE.filters.status = ""; }
      sSel.value = STATE.filters.status || "";
    }
    // Contract Type — HIERARCHICAL + data-driven (Keith 2026-06-04). Rookie &
    // Vet families with their sub-types (only those present on the roster), plus
    // Tag / Expired. Loaded (FL/BL) is NOT in here — it spans both families, so
    // it's the separate cross-cutting checkbox below.
    const present = {};
    let anyLoaded = false;
    all.forEach(function (p) {
      const t = String(p.type || "").toUpperCase();
      const fam = t.indexOf("TAG") >= 0 ? "tag" : (t.indexOf("ROOKIE") === 0 ? "rk" : "vet");
      if (fam === "rk" || fam === "vet") {
        present[fam] = true;
        if (t.indexOf("FAA") >= 0) present[fam + "-faa"] = true;
        if (t.indexOf("ERA") >= 0) present[fam + "-era"] = true;
        if (t.indexOf("EXT") >= 0) present[fam + "-ext"] = true;
        if (t.indexOf("WW") >= 0) present[fam + "-ww"] = true;
        if (t.indexOf("MYM") >= 0) present[fam + "-mym"] = true;
        if (fam === "rk" && t.indexOf("DRAFT") >= 0) present["rk-draft"] = true;
      } else if (fam === "tag") present.tag = true;
      if (t === "EXPIRED" || p.isExpiredRookie) present.expired = true;
      if (t.indexOf("FL") >= 0 || t.indexOf("BL") >= 0) anyLoaded = true;
    });
    const tSel = $("#fo-filter-type");
    if (tSel) {
      const valid = { "": 1 };
      const parts = ['<option value="">All types</option>'];
      const grp = function (famKey, famVal, famLabel, subs) {
        if (!present[famKey]) return;
        const g = ['<option value="' + famVal + '">All ' + famLabel + '</option>'];
        valid[famVal] = 1;
        subs.forEach(function (s) { if (present[s[0]]) { g.push('<option value="' + s[0] + '">' + s[1] + '</option>'); valid[s[0]] = 1; } });
        parts.push('<optgroup label="' + famLabel + '">' + g.join("") + '</optgroup>');
      };
      grp("rk", "rookie", "Rookie", [
        ["rk-draft", "Rookie-Draft"], ["rk-ww", "Rookie-WW"],
        ["rk-mym", "Rookie-MYM"], ["rk-ext", "Rookie-Ext"],
      ]);
      grp("vet", "veteran", "Veteran", [
        ["vet-faa", "Vet-FAA"], ["vet-era", "Vet-ERA"], ["vet-ext", "Vet-Ext"],
        ["vet-ww", "Vet-WW"], ["vet-mym", "Vet-MYM"],
      ]);
      if (present.tag)     { parts.push('<option value="tag">Tag</option>'); valid.tag = 1; }
      if (present.expired) { parts.push('<option value="expired">Expired</option>'); valid.expired = 1; }
      tSel.innerHTML = parts.join("");
      if (STATE.filters.type && !valid[STATE.filters.type]) { STATE.filters.type = ""; }
      tSel.value = STATE.filters.type || "";
    }
    // Loaded (FL/BL) cross-cut checkbox — disabled when no loaded contracts exist.
    const loadedChk = $("#fo-filter-loaded");
    if (loadedChk) {
      loadedChk.disabled = !anyLoaded;
      if (!anyLoaded && STATE.filters.loaded) STATE.filters.loaded = false;
      loadedChk.checked = !!STATE.filters.loaded;
    }
  }

  // ── Roster render ───────────────────────────────────────────────────
  function allVisiblePlayers() {
    const teams = STATE.selectedTeamId === "__all__"
      ? STATE.teams
      : STATE.teams.filter(function (t) { return t.fid === STATE.selectedTeamId; });
    const out = [];
    teams.forEach(function (t) { t.players.forEach(function (p) { out.push(p); }); });
    return out;
  }

  function applyFilters(players) {
    const f = STATE.filters;
    const q = STATE.search;
    return players.filter(function (p) {
      if (f.pos !== "ALL" && posBucket(p.position) !== f.pos) return false;
      if (f.type) {
        // Hierarchical type match on the RAW MFL status so cross-cutting
        // attributes co-exist: e.g. EXT2-BL matches BOTH "vet-ext" (it IS an
        // extension) AND the Loaded cross-cut (it's back-loaded). Keith 2026-06-04.
        const t = String(p.type || "").toUpperCase();
        const fam = t.indexOf("TAG") >= 0 ? "tag" : (t.indexOf("ROOKIE") === 0 ? "rk" : "vet");
        let ok;
        if (f.type === "rookie") ok = fam === "rk";
        else if (f.type === "veteran") ok = fam === "vet";
        else if (f.type === "tag") ok = fam === "tag";
        else if (f.type === "expired") ok = p.isExpiredRookie || t === "EXPIRED";
        else {
          // family-prefixed REAL sub (vet-faa / vet-ext / rk-draft / …) →
          // family + the actual MFL token in the raw status.
          const dash = f.type.indexOf("-");
          const wantFam = f.type.slice(0, dash);                  // "rk" | "vet"
          const sub = f.type.slice(dash + 1);                     // "faa"|"era"|"ext"|"ww"|"mym"|"draft"
          const tok = { faa: "FAA", era: "ERA", ext: "EXT", ww: "WW", mym: "MYM", draft: "DRAFT" }[sub] || sub.toUpperCase();
          ok = fam === wantFam && t.indexOf(tok) >= 0;
        }
        if (!ok) return false;
      }
      // Loaded (FL/BL) is a CROSS-CUTTING dimension — it spans Rookie & Vet, so
      // it's its own toggle, combinable with the type hierarchy (Keith 2026-06-04:
      // "I'm not sure how to show this since those are sub types of the other").
      if (f.loaded) {
        const t = String(p.type || "").toUpperCase();
        if (t.indexOf("FL") < 0 && t.indexOf("BL") < 0) return false;
      }
      if (f.status) {
        if (f.status === "active" && (p.isTaxi || p.isIr)) return false;
        if (f.status === "taxi" && !p.isTaxi) return false;
        if (f.status === "ir"   && !p.isIr)   return false;
      }
      if (f.years) {
        const yrs = safeInt(p.years, 0);
        if (f.years === "4+") { if (yrs < 4) return false; }
        else if (yrs !== safeInt(f.years, -1)) return false;
      }
      if (f.action) {
        // Filter uses the SAME eligibility helpers as the slide-over
        // Actions tab. Guarantees the filter count matches what users
        // can actually act on. Keith 2026-05-19: "your current list is
        // incorrect" — old coarse gating let everyone through.
        const elig = rosterContractEligibility(p);
        if (f.action === "extension"     && !elig.extensionEligible)    return false;
        if (f.action === "myac"          && !elig.myacEligible)         return false;
        if (f.action === "rookie_option" && !elig.rookieOptionEligible) return false;
        if (f.action === "restructure"   && !elig.restructureEligible)  return false;
        if (f.action === "untag"         && !elig.untagEligible)        return false;
      }
      if (q) {
        const hay = (p.name + " " + p.franchise + " " + p.nflTeam + " " + p.special + " " +
                     p.acquisitionText).toLowerCase();
        if (hay.indexOf(q) < 0) return false;
      }
      return true;
    });
  }

  function applySort(rows) {
    const key = STATE.sort.key;
    const dir = STATE.sort.dir;
    const numeric = ["salary", "years", "aav", "drop_pen", "tcv", "cl", "gtd", "earned", "per_week"];
    return rows.slice().sort(function (a, b) {
      let va, vb;
      if (key === "drop_pen")      { va = dropPenaltyEstimate(a).amount; vb = dropPenaltyEstimate(b).amount; }
      else if (key === "gtd")      { va = parseContractGuaranteeValue(a.special); vb = parseContractGuaranteeValue(b.special); }
      else if (key === "earned")   { va = dropPenaltyEstimate(a).earned; vb = dropPenaltyEstimate(b).earned; }
      else if (key === "per_week") { va = perWeekEarningValue(a); vb = perWeekEarningValue(b); }
      else if (key === "tcv")      { va = totalContractValueForPlayer(a); vb = totalContractValueForPlayer(b); }
      else if (key === "cl")       { va = contractLengthForPlayer(a); vb = contractLengthForPlayer(b); }
      else if (key === "roster_status") { va = rosterStatusLabel(a); vb = rosterStatusLabel(b); }
      else if (key === "contract_status") { va = a.type; vb = b.type; }
      else if (key === "name")     { va = a.name; vb = b.name; }
      else if (key === "franchise"){ va = a.franchise; vb = b.franchise; }
      else if (key === "nfl_team") { va = a.nflTeam; vb = b.nflTeam; }
      else if (key === "position") { va = a.position; vb = b.position; }
      else                         { va = a[key]; vb = b[key]; }
      if (numeric.includes(key)) {
        va = Number(va); vb = Number(vb);
        if (!Number.isFinite(va)) va = -Infinity;
        if (!Number.isFinite(vb)) vb = -Infinity;
        return (va - vb) * dir;
      }
      va = String(va || "").toLowerCase();
      vb = String(vb || "").toLowerCase();
      return va < vb ? -dir : va > vb ? dir : 0;
    });
  }

  // Grouped-by-position render (Keith 2026-06-01: option to group like the
  // current Front Office). Inserts a position header row before each bucket;
  // players keep the active sort order within their group.
  // League rank of a team's cap allocation at a position bucket (1 = highest
  // spend). Uses currentCapHit (taxi $0, IR×0.5) — same bucketing as the group.
  // Finer position bucket: like posBucket but splits IDP into DL/LB/DB so the
  // grouped view shows positional groups, not one IDP lump.
  function posGroupFine(position) {
    const b = posBucket(position);
    if (b !== "IDP") return b;
    const p = String(position || "").toUpperCase();
    if (["DE", "DT", "DL", "NT"].indexOf(p) >= 0) return "DL";
    if (["LB", "OLB", "ILB", "MLB", "EDGE"].indexOf(p) >= 0) return "LB";
    if (["CB", "S", "DB", "SS", "FS", "SAF"].indexOf(p) >= 0) return "DB";
    return "IDP";
  }
  // Rank a team's position cap allocation (TOTAL) among the league. Taxi excluded.
  function positionAllocRank(bucket, teamFid) {
    const byTeam = STATE.teams.map(function (t) {
      let sum = 0;
      (t.players || []).forEach(function (p) { if (posGroupFine(p.position) === bucket && !p.isTaxi) sum += currentCapHit(p); });
      return { fid: t.fid, sum: sum };
    }).sort(function (a, b) { return b.sum - a.sum; });
    let rank = 0;
    for (let i = 0; i < byTeam.length; i += 1) { if (byTeam[i].fid === teamFid) { rank = i + 1; break; } }
    return { rank: rank, of: byTeam.length };
  }
  // Rank a team's AVG cap spend per non-taxi player at a position among the league.
  function positionAvgRank(bucket, teamFid) {
    const byTeam = STATE.teams.map(function (t) {
      let sum = 0, n = 0;
      (t.players || []).forEach(function (p) { if (posGroupFine(p.position) === bucket && !p.isTaxi) { sum += currentCapHit(p); n += 1; } });
      return { fid: t.fid, avg: n ? sum / n : 0 };
    }).sort(function (a, b) { return b.avg - a.avg; });
    let rank = 0;
    for (let i = 0; i < byTeam.length; i += 1) { if (byTeam[i].fid === teamFid) { rank = i + 1; break; } }
    return { rank: rank, of: byTeam.length };
  }
  // ── Within-position row order ───────────────────────────────────────
  // Keith 2026-08-08: "Sort by Active/Taxi then alphabetical … you can
  // include IR with the Actives." Two keys, applied INSIDE each position
  // group (the position grouping itself is unchanged):
  //   1. roster-status bucket — Active AND IR first, Taxi last
  //   2. player name ascending, on the SAME string renderRosterRow prints
  //      (p.name), so the visible order can never disagree with the key.
  // The bucket comes from rosterStatusClass — the one helper this file
  // already uses for active/taxi/IR — rather than re-deriving the
  // distinction from raw MFL status strings. A row whose status is
  // unreadable falls through that helper to "active" and stays in the
  // list: a sort must never drop a player.
  function rosterStatusSortRank(p) {
    return rosterStatusClass(p || {}) === "taxi" ? 1 : 0;   // active + IR share 0
  }
  function orderGroupRows(rows) {
    // Once the commish has clicked a column header, that explicit sort is
    // the secondary key (status stays primary, so Active/Taxi still never
    // interleave). Header sorting in By-Position mode keeps working.
    const explicit = !!(STATE.sort && STATE.sort.userChosen);
    const incoming = new Map();
    rows.forEach(function (p, i) { incoming.set(p, i); });   // applySort order
    return rows.slice().sort(function (a, b) {
      const d = rosterStatusSortRank(a) - rosterStatusSortRank(b);
      if (d) return d;
      if (explicit) return incoming.get(a) - incoming.get(b);
      return String((a && a.name) || "").localeCompare(String((b && b.name) || ""));
    });
  }

  function renderGroupedRows(players) {
    const order = ["QB", "RB", "WR", "TE", "PK", "PN", "DL", "LB", "DB", "IDP"];
    const groups = {};
    players.forEach(function (p) { const b = posGroupFine(p.position) || "OTHER"; (groups[b] = groups[b] || []).push(p); });
    const keys = Object.keys(groups).sort(function (a, b) {
      const ia = order.indexOf(a), ib = order.indexOf(b);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    });
    const single = STATE.selectedTeamId !== "__all__";
    const rankPill = function (r) { return (r && r.rank) ? ' <span class="fo-group-rank">#' + r.rank + "/" + r.of + "</span>" : ""; };
    let html = "";
    keys.forEach(function (k) {
      const rows = orderGroupRows(groups[k]);
      // Count + allocation + avg ALL exclude taxi (taxi = $0 cap; shown separately).
      let posSal = 0, nNonTaxi = 0, taxiN = 0;
      rows.forEach(function (p) { if (p.isTaxi) { taxiN += 1; } else { posSal += currentCapHit(p); nNonTaxi += 1; } });
      const avg = nNonTaxi ? Math.round(posSal / nNonTaxi / 100) * 100 : 0;
      const rankable = single && order.indexOf(k) >= 0;
      const count = nNonTaxi + " player" + (nNonTaxi === 1 ? "" : "s") + (taxiN ? " · " + taxiN + " taxi" : "");
      const extra =
        ' <span class="fo-group-sal">' + escapeHtml(fmtUSD(posSal)) + "</span>" + rankPill(rankable ? positionAllocRank(k, STATE.selectedTeamId) : null) +
        ' <span class="fo-group-avg">' + escapeHtml(fmtUSD(avg) + "/player") + "</span>" + rankPill(rankable ? positionAvgRank(k, STATE.selectedTeamId) : null);
      html += '<tr class="fo-group-row"><td colspan="13"><span class="fo-pos ' + escapeHtml(k) + '">' + escapeHtml(k) +
              '</span> <span class="small">' + count + "</span>" + extra + "</td></tr>";
      html += rows.map(renderRosterRow).join("");
    });
    return html;
  }

  // ── NFL game status + news flags (decorate roster rows) ─────────────
  // NFL game status (O/Q/D) comes straight from MFL's injuries export; the
  // news flag from /api/player-news (same feed the News tab uses). Both load
  // after the table first renders, then trigger one re-render.
  var NFL_STATUS_ABBR = { out: "O", questionable: "Q", doubtful: "D", probable: "P", ir: "IR", pup: "PUP", suspended: "S", "injured reserve": "IR", "covid-19": "C" };
  function nflStatusBadge(pid) {
    var s = STATE.nflStatus[String(pid)];
    if (!s) return "";
    var key = String(s).toLowerCase();
    var abbr = NFL_STATUS_ABBR[key] || String(s).charAt(0).toUpperCase();
    var kls = (key.indexOf("out") >= 0 || key === "ir" || key.indexOf("reserve") >= 0 || key.indexOf("pup") >= 0) ? "out"
      : (key.indexOf("doubt") >= 0 ? "doubtful" : "questionable");
    return ' <span class="fo-nfl-status fo-nfl-' + kls + '" title="NFL game status: ' + escapeHtml(String(s)) + '">' + escapeHtml(abbr) + "</span>";
  }
  function newsFlagBadge(pid) {
    var f = STATE.newsFlags[String(pid)];
    if (!f) return "";
    // Injury/status → medical cross; news headline → newspaper. Clicking opens News.
    var icon = f === "injury" ? "🏥" : "📰";
    var title = f === "injury" ? "Injury / status news — click to open News" : "News headline — click to open News";
    return ' <span class="fo-news-flag fo-news-flag-' + f + '" data-news-pid="' + escapeHtml(String(pid)) + '" title="' + title + '">' + icon + "</span>";
  }
  async function loadRosterIndicators() {
    var pids = allVisiblePlayers().map(function (p) { return p.id; }).filter(Boolean);
    if (!pids.length) return;
    // NFL game status — straight from MFL's injuries export.
    try {
      var inj = await fetchJSON(apiUrl("/api/mfl-export") + "?TYPE=injuries&L=" + encodeURIComponent(LEAGUE_ID) + "&YEAR=" + encodeURIComponent(SEASON) + "&JSON=1");
      var arr = (inj && inj.injuries && inj.injuries.injury) || [];
      if (!Array.isArray(arr)) arr = [arr];
      var m = {};
      arr.forEach(function (x) { if (x && x.id && x.status) m[String(x.id)] = String(x.status); });
      STATE.nflStatus = m;
    } catch (e) {}
    // News flags. The /api/player-news endpoint resolves at most ~50 players per
    // request, so a single all-roster call drops everyone past ~50 (Jalen Hurts
    // had news but no flag). Chunk into ≤40-pid requests and merge.
    try {
      var chunks = [];
      for (var ci = 0; ci < pids.length; ci += 40) chunks.push(pids.slice(ci, ci + 40));
      var newsBase = apiUrl("/api/player-news") + "?L=" + encodeURIComponent(LEAGUE_ID) + "&YEAR=" + encodeURIComponent(SEASON) + "&pids=";
      var results = await Promise.all(chunks.map(function (c) {
        return fetchJSON(newsBase + encodeURIComponent(c.join(","))).catch(function () { return null; });
      }));
      var flags = {};
      results.forEach(function (news) {
        var ibp = (news && news.items_by_pid) || {};
        Object.keys(ibp).forEach(function (pid) {
          var items = (ibp[pid] || []).filter(function (it) { return it && (it.type === "injury" || it.type === "status" || it.type === "headline"); });
          if (items.length) flags[pid] = items.some(function (it) { return it.type === "injury" || it.type === "status"; }) ? "injury" : "news";
        });
      });
      STATE.newsFlags = flags;
    } catch (e) {}
    if (Object.keys(STATE.nflStatus).length || Object.keys(STATE.newsFlags).length) renderRosterTable();
  }

  // ── Contract summary strip near the top of the roster ───────────────
  // Reuses the Cap tab's canonical math: currentCapHit (taxi $0, IR×0.5),
  // CAP_CEILING $300K, per-team adj_cut/trade/other. Reflects the selected team,
  // or SUMS across the league on "All Teams" (limits scale by team count).
  // Roster limits per league_context §B1: active 27 min – 35 max (auction
  // window); taxi 10; IR 15.
  var ACTIVE_MAX = 35, ACTIVE_MIN = 27, TAXI_MAX = 10, LOADED_MAX = 5, THREEYR_MAX = 6;
  function isLoadedRow(p) {
    // Loaded = an EXPLICIT front/back-loaded contract — the -FL / -BL suffix on
    // the canonical contractStatus (Vet-FAA-FL, Vet-Ext2-BL, …). A merely
    // non-flat year shape (default escalated extension) is NOT "loaded" and was
    // over-counting (LH showed 6/8 vs the actual 3).
    var t = String(p && p.type || "").toUpperCase();
    return t.indexOf("-FL") >= 0 || t.indexOf("-BL") >= 0 || t === "FL" || t === "BL";
  }
  async function loadContractDeadline() {
    try {
      // &kickoffs=1,3,5 adds week_kickoffs to the response — the real NFL
      // Week 1/3/5 first-kickoff instants off MFL's own schedule, the same
      // mechanism mobile's contractLadder state is built from (site/m/app.js
      // fetchContractCalendar). See STATE.weekKickoffs.
      var data = await fetchJSON(apiUrl("/api/league-events") + "?season=" + encodeURIComponent(SEASON) + "&from=all&limit=50&kickoffs=1,3,5");
      var evs = (data && data.events) || [];
      var cd = evs.find(function (e) { return String(e.event || "").toLowerCase().indexOf("contract_deadline") >= 0; });
      if (cd && cd.date) STATE.contractDeadline = String(cd.date).slice(0, 10);
      // The deadline as a real instant, matching isPastContractDeadlineFO's
      // 23:59:59 ET boundary -- NOT contractDeadlineDateFO's 9pm-ET display
      // convention (used elsewhere for extension countdown copy, a different
      // purpose). isPastContractDeadlineFO is the boundary ALREADY governing
      // MYAC eligibility for every existing arm (ERA/auction/FAA) via the
      // `!isPastContractDeadlineFO()` gate on myacEligible below; feeding the
      // ladder a different, earlier instant for the SAME calendar day would
      // make the new WW-pickup arm flip to MYM up to ~3 hours before the
      // other arms flip, on deadline day itself -- caught in review.
      STATE.contractDeadlineMs = null;
      if (STATE.contractDeadline) {
        try {
          var cdMs = new Date(String(STATE.contractDeadline) + "T23:59:59-04:00").getTime();
          STATE.contractDeadlineMs = isFinite(cdMs) ? cdMs : null;
        } catch (e) { /* stays null */ }
      }
      // §D1 cut-penalty timing: a penalty incurred from AUCTION START through
      // the end of the season lands on the FOLLOWING season's cap, not this
      // one. Same feed, one more event.
      var fa = evs.find(function (e) { return String(e.event || "").toLowerCase().indexOf("fa_auction_start") >= 0; });
      if (fa && fa.date) STATE.faAuctionStart = String(fa.date).slice(0, 10);
      // Week 1/3/5 kickoff instants. An absent/malformed field must leave
      // weekKickoffs at its all-null default — never a fabricated number.
      var ko = (data && data.week_kickoffs) || null;
      STATE.weekKickoffs = {
        1: kickoffMsFromFO(ko, 1),
        3: kickoffMsFromFO(ko, 3),
        5: kickoffMsFromFO(ko, 5)
      };
    } catch (e) {}
  }
  function renderContractSummary() {
    const el = $("#fo-contract-summary");
    if (!el) return;
    const single = STATE.selectedTeamId !== "__all__";
    const teams = single ? STATE.teams.filter(function (t) { return t.fid === STATE.selectedTeamId; }) : STATE.teams;
    if (!teams.length) { el.innerHTML = ""; return; }
    const nTeams = teams.length;
    let activeN = 0, taxiN = 0, irN = 0, salaryCap = 0, irAlloc = 0, loadedN = 0, threeYrN = 0, adjTotal = 0;
    const irEligible = [];
    teams.forEach(function (team) {
      (team.players || []).forEach(function (p) {
        const hit = currentCapHit(p);                 // taxi $0, IR×0.5, expired $0
        if (p.isTaxi) { taxiN += 1; }
        else if (p.isIr) { irN += 1; irAlloc += hit; salaryCap += hit; }
        else {
          activeN += 1; salaryCap += hit;
          const st = (STATE.nflStatus[String(p.id)] || "").toLowerCase();
          if (st && (st.indexOf("out") >= 0 || st === "ir" || st.indexOf("doubt") >= 0 || st.indexOf("pup") >= 0 || st.indexOf("reserve") >= 0)) irEligible.push(p);
        }
        if (isLoadedRow(p)) loadedN += 1;
        if (safeInt(p.years, 0) === 3 && ctypeClass(p.type).split(" ")[0] !== "rk") threeYrN += 1;
      });
      const s = team.summary || {};
      // Canon §6: drop penalties (adj_cut) round by the per-franchise SUM to the
      // nearest $1K (half-up), not per-penalty. Trades/other aren't penalties.
      adjTotal += capAdjTotal(s);
    });
    const capAlloc = salaryCap + adjTotal;
    const capSpace = (CAP_CEILING * nTeams) - capAlloc;
    const card = function (val, lbl, subHtml, cls) {
      return '<div class="fo-sum-card"><div class="fo-sum-val ' + (cls || "") + '">' + val + "</div>" +
        '<div class="fo-sum-lbl">' + escapeHtml(lbl) + "</div>" +
        (subHtml ? '<div class="fo-sum-sub">' + subHtml + "</div>" : "") + "</div>";
    };
    const irLink = "https://www48.myfantasyleague.com/" + encodeURIComponent(SEASON) + "/options?L=" + encodeURIComponent(LEAGUE_ID) + "&O=18";
    const irAlert = (single && irEligible.length)
      ? '<a class="fo-ir-alert" href="' + irLink + '" target="_blank" rel="noopener noreferrer" title="Manage IR on MFL">⚠ ' + irEligible.length + " IR-eligible &rarr; manage</a>"
      : "";
    el.innerHTML =
      card(activeN + ' <span class="fo-sum-of">of ' + (ACTIVE_MAX * nTeams) + "</span>", "Active Roster",
        escapeHtml("min " + (ACTIVE_MIN * nTeams) + " · taxi " + taxiN + "/" + (TAXI_MAX * nTeams)), "") +
      card(fmtUSD(capAlloc), "Cap Allocation",
        "Sal " + escapeHtml(fmtUSD(salaryCap)) + " · Adj " + escapeHtml(fmtUSD(adjTotal)) +
        ' <button type="button" class="fo-adj-info" data-action="adj-popup" title="Cap adjustment detail">?</button>', "") +
      card(fmtUSD(capSpace), "Cap Space", escapeHtml("of " + fmtUSD(CAP_CEILING * nTeams)), capSpace < 0 ? "fo-sum-neg" : "fo-sum-pos") +
      card(irN + ' <span class="fo-sum-of">Players</span>', "Injured Reserve",
        escapeHtml(fmtUSD(irAlloc) + " allocated to IR") + (irAlert ? "<br>" + irAlert : ""), "") +
      card(loadedN + ' <span class="fo-sum-of">/ ' + (LOADED_MAX * nTeams) + "</span>", "Loaded Contracts",
        escapeHtml("max " + (LOADED_MAX * nTeams) + " (§C2)"), loadedN >= LOADED_MAX * nTeams ? "fo-sum-neg" : "") +
      card(threeYrN + ' <span class="fo-sum-of">/ ' + (THREEYR_MAX * nTeams) + "</span>", "3-Yr Non-Rookie",
        escapeHtml("max " + (THREEYR_MAX * nTeams)), threeYrN >= THREEYR_MAX * nTeams ? "fo-sum-neg" : "");
  }

  // Cap-adjustment detail popup (the "?" in the Cap Allocation box). Itemizes
  // Drop/Trade/Other per team in scope straight from MFL's salaryAdjustments
  // feed (exact dollars + player parsed from the description) — NOT the
  // worker's raw rows, which carry a <$1K K-multiplier glitch + null names.
  function adjRow(lbl, amt) {
    return '<div class="fo-adj-row"><span>' + escapeHtml(lbl) + '</span><span class="num">' + escapeHtml(fmtUSD(amt)) + "</span></div>";
  }
  // The "next season" half of the Cap Adjustments popup. Ledger-only money —
  // real, owed, and deliberately NOT on MFL yet (canon §6 penalty timing +
  // the §F next-season-fine precedent). `onlyFid` scopes it to one team when
  // the FO is filtered to a single franchise.
  function renderNextSeasonAdjBlock(onlyFid) {
    const ns = STATE.nextSeasonAdj;
    const year = (ns && ns.nextSeason) || (safeInt(SEASON, 0) + 1);
    if (!ns) return "";
    if (!ns.ok) {
      // "Could not read" is not "nothing owed" — say which one this is.
      return '<div class="fo-adj-year">' + escapeHtml(String(year)) + " cap — ledger only</div>" +
        '<div class="fo-adj-row"><span>Next-season drop penalties unavailable (' +
        escapeHtml(String(ns.error || "unreadable")) + ") — not confirmed empty.</span><span></span></div>";
    }
    const byFid = ns.byFid || {};
    const fids = Object.keys(byFid).filter(function (f) { return !onlyFid || f === onlyFid; });
    if (!fids.length) return "";
    let out = '<div class="fo-adj-year">' + escapeHtml(String(year)) +
      " cap — ledger only, not in MFL until the rollover</div>";
    let total = 0;
    fids.sort().forEach(function (fid) {
      const grp = byFid[fid] || {};
      out += '<div class="fo-adj-team">' + escapeHtml(grp.franchise_name || fid) + "</div>";
      (grp.items || []).forEach(function (it) {
        total += safeInt(it.amount, 0);
        out += adjRow("Drop · " + (it.player || it.player_id || "—") +
          (it.dropped_at_iso ? " (" + String(it.dropped_at_iso).slice(0, 10) + ")" : ""), safeInt(it.amount, 0));
      });
    });
    out += '<div class="fo-adj-row fo-adj-total"><span>Total — ' + escapeHtml(String(year)) +
      ' cap</span><span class="num">' + escapeHtml(fmtUSD(total)) + "</span></div>";
    return out;
  }
  function showAdjPopup() {
    const single = STATE.selectedTeamId !== "__all__";
    const teams = single ? STATE.teams.filter(function (t) { return t.fid === STATE.selectedTeamId; }) : STATE.teams;
    const byFid = STATE.adjByFid || {};
    let inner = "", grand = 0;
    teams.forEach(function (team) {
      const s = team.summary || {};
      const cut = safeInt(s.adj_cut, 0), trade = safeInt(s.adj_trade, 0), other = safeInt(s.adj_other, 0);
      const items = (byFid[team.fid] && byFid[team.fid].items) || [];
      if (!cut && !trade && !other && !items.length) return;
      // Canon §6: drop penalties round by the per-franchise SUM (nearest $1K,
      // half-up), not per-penalty. Show exact drops, then a single Rounding line.
      const roundedCut = roundToK(cut);
      const roundingDelta = roundedCut - cut;
      grand += roundedCut + trade + other;
      inner += '<div class="fo-adj-team">' + escapeHtml(team.name) + "</div>";
      // Itemize the drop penalties (player + amount) from the report; trades/other
      // come from the MFL feed as team totals only.
      if (items.length) {
        // MFL items already cover every category — show them and skip the
        // per-category subtotal lines below (else they'd double-count).
        items.slice().sort(function (a, b) { return (b.amount || 0) - (a.amount || 0); }).forEach(function (it) {
          inner += adjRow(it.kind + (it.player ? " · " + it.player : ""), it.amount);
        });
      } else {
        if (cut) inner += adjRow("Drop penalties", cut);
        if (trade) inner += adjRow("Traded salary", trade);
        if (other) inner += adjRow("Other adjustments", other);
      }
      if (roundingDelta !== 0) {
        const signed = (roundingDelta < 0 ? "−" : "+") + fmtUSD(Math.abs(roundingDelta));
        inner += '<div class="fo-adj-row fo-adj-rounding" style="font-style:italic;color:var(--muted);"><span>Rounding (drop penalties → nearest $1K)</span><span class="num">' + escapeHtml(signed) + "</span></div>";
      }
    });
    if (!inner) inner = '<div class="fo-adj-row"><span>No cap adjustments.</span><span></span></div>';
    else inner += '<div class="fo-adj-row fo-adj-total"><span>Total — ' + escapeHtml(String(SEASON)) + ' cap</span><span class="num">' + escapeHtml(fmtUSD(grand)) + "</span></div>";
    // The current-season block above is everything MFL holds. Anything canon
    // assigns to NEXT season is shown separately and never folded into that
    // total — a next-season penalty rendered as a current-season line is the
    // exact bug that put $2K of The Long Haulers' August drops on the 2026 cap.
    inner = '<div class="fo-adj-year">' + escapeHtml(String(SEASON)) + " cap — in MFL now</div>" + inner;
    inner += renderNextSeasonAdjBlock(single ? STATE.selectedTeamId : null);
    const overlay = document.createElement("div");
    overlay.className = "fo-adj-overlay";
    overlay.innerHTML = '<div class="fo-adj-popup" role="dialog" aria-label="Cap adjustments">' +
      '<div class="fo-adj-head"><span>Cap Adjustments</span><button type="button" class="fo-adj-close" aria-label="Close">×</button></div>' +
      '<div class="fo-adj-body">' + inner + "</div>" +
      '<div class="fo-adj-foot">Drop / Trade / Other from MFL’s salaryAdjustments feed. Drop penalties round to the nearest $1K by team total (canon §6); the rounding true-up posts to MFL at the Auction Cut Deadline. Penalties from drops on or after the FA Auction start belong to the FOLLOWING season (canon §6 penalty timing) and stay off MFL until the rollover.</div></div>';
    overlay.addEventListener("click", function (e) {
      if (e.target === overlay || (e.target.classList && e.target.classList.contains("fo-adj-close"))) {
        if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
      }
    });
    document.body.appendChild(overlay);
  }

  // Salary + AAV rank within each position group (league-wide, ALL rostered
  // players — not the filtered view). Keyed by player id → {salRank, aavRank, n}.
  // Feeds the roster "Pos Rank" column (Keith 2026-06-07).
  function computePosRankMap() {
    const byPos = Object.create(null);
    (STATE.teams || []).forEach(function (t) {
      (t.players || []).forEach(function (p) {
        const pk = posBucket(p.position);
        (byPos[pk] = byPos[pk] || []).push(p);
      });
    });
    const out = Object.create(null);
    Object.keys(byPos).forEach(function (pk) {
      const arr = byPos[pk];
      arr.slice().sort(function (a, b) { return safeInt(b.salary, 0) - safeInt(a.salary, 0); })
        .forEach(function (p, i) { (out[p.id] = out[p.id] || { n: arr.length }).salRank = i + 1; });
      arr.slice().sort(function (a, b) { return displayAavForPlayer(b) - displayAavForPlayer(a); })
        .forEach(function (p, i) { (out[p.id] = out[p.id] || { n: arr.length }).aavRank = i + 1; });
    });
    return out;
  }

  function renderRosterTable() {
    const tbody = $("#fo-roster-tbody");
    const summary = $("#fo-roster-summary");
    if (!tbody) return;

    const all = allVisiblePlayers();
    const filtered = applyFilters(all);
    const sorted   = applySort(filtered);

    STATE.posRankByPid = computePosRankMap();   // league-wide pos ranks for the Pos Rank column

    renderContractSummary();

    if (summary) {
      summary.textContent = filtered.length === all.length
        ? "Showing " + filtered.length + " player" + (filtered.length === 1 ? "" : "s")
        : "Showing " + filtered.length + " of " + all.length;
    }

    // Sort arrows
    $$("#fo-roster-table thead th[data-sort]").forEach(function (th) {
      const arrow = th.dataset.sort === STATE.sort.key ? (STATE.sort.dir > 0 ? " ▲" : " ▼") : "";
      const base  = th.textContent.replace(/[ ▲▼]+$/, "");
      th.textContent = base + arrow;
    });

    if (sorted.length === 0) {
      tbody.innerHTML = '<tr><td colspan="13" class="fo-table-empty">No players match the current filters.</td></tr>';
      return;
    }
    tbody.innerHTML = STATE.groupByPosition ? renderGroupedRows(sorted) : sorted.map(renderRosterRow).join("");

    // Wire row clicks — entire row opens the slide-over. Manage button
    // was removed (Keith 2026-05-19: "redundancy, just need a note to
    // click player name"); hint text added below the table.
    $$("#fo-roster-tbody tr").forEach(function (tr) {
      tr.addEventListener("click", function (e) {
        const pid = tr.dataset.pid; const fid = tr.dataset.fid;
        if (!pid) return;
        // Clicking the news flag jumps straight to the News tab.
        if (e.target && e.target.classList && e.target.classList.contains("fo-news-flag")) {
          openSlideover(pid, fid, "news"); return;
        }
        openSlideover(pid, fid);
      });
    });
  }

  function renderRosterRow(p) {
    const pos = posBucket(p.position);
    // ── "MFL has not said" ────────────────────────────────────────────
    // A brand-new waiver/FCFS award arrives with a SALARY and nothing else —
    // MFL leaves contractStatus / contractYear / contractInfo empty until the
    // WW stamp runs. Every contract-shape column is genuinely unknown for such
    // a row, and the honest render is "pending", not a number derived from an
    // empty string and not the EXPIRED chip (which asserts a state MFL never
    // claimed). Keith 2026-08-08, on Brashard Smith reading as CL 2 / TCV $2,000.
    const unknownContract = contractUnknownForPlayer(p);
    // Expired-rookie override — even when type is "Rookie" (so the
    // synthesized contract_info parses cleanly), chip the row EXPIRED
    // so the user sees the contract state at a glance.
    const ctype = unknownContract ? "pending" : (p.isExpiredRookie ? "expired" : ctypeClass(p.type));
    const ctypeLabel = unknownContract ? "PENDING" : (p.isExpiredRookie ? "EXPIRED" : String(p.type || "—").toUpperCase());
    const statusKls = rosterStatusClass(p);
    const statusLbl = rosterStatusLabel(p);

    const tcv = unknownContract ? 0 : totalContractValueForPlayer(p);
    const cl  = unknownContract ? 0 : contractLengthForPlayer(p);
    const yrs = unknownContract ? 0 : safeInt(p.years, 0);
    const drop = dropPenaltyEstimate(p);
    const gtd = unknownContract ? 0 : parseContractGuaranteeValue(p.special);
    // One tooltip, said once, on the cells that would otherwise read "—" and
    // look like a zero.
    const pendingCell = `<span class="fo-tt" data-tip="MFL has not recorded a contract for this player yet — only the salary. Nothing here is known until the 1-year WW contract is stamped.">pending</span>`;
    const perWeekCell = unknownContract ? pendingCell : perWeekEarningCell(p);

    // Salary / AAV combined cell — show "/AAV" only when AAV differs from
    // current-year salary. Keith 2026-05-19: keep these visually together.
    // AAV uses displayAavForPlayer (taxi fallback to salary).
    // Salary IS known on a pending row — MFL sets it on the award. AAV is not,
    // so it is suppressed rather than mirrored off the salary.
    const aav = unknownContract ? 0 : displayAavForPlayer(p);
    const salaryCell = (aav > 0 && aav !== p.salary)
      ? `${fmtUSD(p.salary)} <span class="small" style="color:var(--muted);">/ ${fmtUSD(aav)}</span>`
      : fmtUSD(p.salary);

    // Pos Rank — salary & AAV rank within position (league-wide). Keith
    // 2026-06-07: "add next to Salary/AAV the same but rank, ranked by position".
    const rk = (STATE.posRankByPid && STATE.posRankByPid[p.id]) || null;
    const rankCell = rk
      ? `<span class="fo-tt" data-tip="Salary rank #${rk.salRank} · AAV rank #${rk.aavRank} of ${rk.n} ${escapeHtml(posBucket(p.position).toUpperCase())}">#${rk.salRank} <span class="small" style="color:var(--muted);">/ #${rk.aavRank}</span></span>`
      : "—";

    return `
      <tr data-pid="${escapeHtml(p.id)}" data-fid="${escapeHtml(p.fid)}">
        <td>
          <div>${escapeHtml(p.name)}${nflStatusBadge(p.id)}${newsFlagBadge(p.id)}</div>
          <div class="small"><span class="fo-pos ${escapeHtml(pos)}">${escapeHtml(p.position)}</span> · ${escapeHtml(p.nflTeam || "FA")}</div>
        </td>
        <td class="col-md">${escapeHtml(p.franchise)}</td>
        <td><span class="fo-ctype ${ctype}">${escapeHtml(ctypeLabel)}</span></td>
        <td class="num col-md">${unknownContract ? pendingCell : (tcv > 0 ? fmtUSD(tcv) : "—")}</td>
        <td class="num col-lo">${unknownContract ? pendingCell : (cl > 0 ? cl : "—")}</td>
        <td class="num col-lo">${unknownContract ? pendingCell : (yrs > 0 ? yrs : "—")}</td>
        <td class="num">${salaryCell}</td>
        <td class="num col-lo">${rankCell}</td>
        <td class="num col-md">${unknownContract ? pendingCell : (gtd > 0 ? fmtUSD(gtd) : "—")}</td>
        <td class="num col-md">${unknownContract ? pendingCell : (drop.earned > 0 ? fmtUSD(drop.earned) : "—")}</td>
        <td class="num col-lo">${perWeekCell}</td>
        <td class="num">${unknownContract ? pendingCell : `<span class="fo-tt" data-tip="${escapeHtml(drop.note)}">${fmtUSD(drop.amount)}</span>`}</td>
        <td class="col-lo"><span class="fo-status ${statusKls}">${escapeHtml(statusLbl)}</span></td>
      </tr>`;
  }

  // ── Slide-over modal ────────────────────────────────────────────────
  function setupSlideover() {
    const root = $("#fo-slideover");
    root.addEventListener("click", function (e) {
      if (e.target.matches("[data-action='close-slideover']")) closeSlideover();
    });
    $$("#fo-slideover-tabs button").forEach(function (btn) {
      btn.addEventListener("click", function () {
        STATE.slideoverSubtab = btn.dataset.subtab;
        $$("#fo-slideover-tabs button").forEach(function (b) {
          b.classList.toggle("active", b === btn);
        });
        renderSlideoverBody();
      });
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && !$("#fo-slideover").hidden) closeSlideover();
    });
  }

  function findPlayer(pid, fid) {
    const team = STATE.teams.find(function (t) { return t.fid === fid; });
    if (!team) return null;
    return team.players.find(function (p) { return p.id === pid; }) || null;
  }

  function openSlideover(pid, fid, subtab) {
    const p = findPlayer(pid, fid);
    if (!p) return;
    STATE.slideoverPid = pid;
    STATE.slideoverFid = fid;
    STATE.slideoverSubtab = subtab || "actions";   // default to Actions (Keith 2026-06-07)
    const root = $("#fo-slideover");
    root.hidden = false;
    root.setAttribute("aria-hidden", "false");
    $("#fo-slideover-title").textContent = p.name;
    // Commish-override indicator — when viewer is admin AND not the
    // owning franchise. Tells Keith he's acting on someone else's
    // roster, every submit will carry commish_override_flag=1 to the
    // worker (auditable in D1).
    const me = STATE.me || {};
    const commishOverride = !!me.isAdmin && pad4(me.franchise_id) !== pad4(fid);
    const titleEl = $("#fo-slideover-title");
    if (titleEl) {
      titleEl.innerHTML = escapeHtml(p.name) +
        (commishOverride
          ? ` <span class="fo-commish-badge" title="Acting on behalf of ${escapeHtml(p.franchise)} — all submits will set commish_override_flag=1.">👑 commish override</span>`
          : "");
    }
    // Same "MFL has not said" rule as the table row: the salary is real, the
    // contract type and remaining years are not yet known — so say pending
    // rather than print "— · 0yr rem", which reads as expired.
    const soUnknown = contractUnknownForPlayer(p);
    $("#fo-slideover-sub").innerHTML =
      `<span class="fo-pos ${escapeHtml(posBucket(p.position))}">${escapeHtml(p.position)}</span> · ` +
      `${escapeHtml(p.nflTeam || "—")} · ${escapeHtml(p.franchise)} · ` +
      (soUnknown
        ? `<span class="fo-ctype pending">PENDING</span> · ${fmtUSD(p.salary)} (contract not yet recorded by MFL)`
        : `<span class="fo-ctype ${ctypeClass(p.type)}">${escapeHtml(String(p.type || "—").toUpperCase())}</span> · ` +
          `${fmtUSD(p.salary)} (${p.years || 0}yr rem)`);
    $$("#fo-slideover-tabs button").forEach(function (b) { b.classList.toggle("active", b.dataset.subtab === STATE.slideoverSubtab); });
    renderSlideoverBody();
  }

  function closeSlideover() {
    const root = $("#fo-slideover");
    root.hidden = true;
    root.setAttribute("aria-hidden", "true");
    STATE.slideoverPid = null;
    STATE.slideoverFid = null;
    $("#fo-slideover-body").innerHTML = "";
  }

  function renderSlideoverBody() {
    const body = $("#fo-slideover-body");
    if (!body) return;
    const p = findPlayer(STATE.slideoverPid, STATE.slideoverFid);
    if (!p) { body.innerHTML = '<div class="fo-form-note err">Player not found in current data.</div>'; return; }
    switch (STATE.slideoverSubtab) {
      case "actions":  body.innerHTML = renderActionsTab(p); wireActionsTab(body, p); return;
      case "bio":      renderBioTab(p); return;
      case "stats":    renderStatsTab(p); return;
      case "gamelog":  renderGameLogTab(p); return;
      case "history":  body.innerHTML = '<div class="fo-form-note">Loading contract history…</div>'; renderContractHistoryTab(p); return;
      case "txns":     renderTransactionLogTab(p); return;
      case "news":     renderNewsTab(p); return;
      default:         body.innerHTML = "";
    }
  }

  function renderPlaceholderTab(title, msg) {
    return `<div class="fo-placeholder"><strong>${escapeHtml(title)} — checkpoint 2</strong>${escapeHtml(msg)}</div>`;
  }

  // Player physicals (height/weight/DOB/draft) come from MFL players?DETAILS=1
  // via the worker proxy (CORS-safe off the MFL host). Cached per player id.
  var __playerDetailsCache = {};
  async function loadPlayerDetails(pid) {
    pid = safeStr(pid).replace(/\D/g, "");
    if (!pid) return {};
    if (__playerDetailsCache[pid]) return __playerDetailsCache[pid];
    try {
      var url = apiUrl("/api/mfl-export") + "?TYPE=players&L=" + encodeURIComponent(LEAGUE_ID) +
                "&YEAR=" + encodeURIComponent(SEASON) + "&PLAYERS=" + encodeURIComponent(pid) + "&DETAILS=1&JSON=1";
      var res = await fetch(url, { credentials: "omit" });
      var data = await res.json();
      var pl = data && data.players && data.players.player;
      pl = Array.isArray(pl) ? pl[0] : pl;
      __playerDetailsCache[pid] = pl || {};
    } catch (e) { __playerDetailsCache[pid] = {}; }
    return __playerDetailsCache[pid];
  }
  function bioHeight(inches) { var n = safeInt(inches, 0); return n > 0 ? (Math.floor(n / 12) + "'" + (n % 12) + '"') : "—"; }
  function bioDob(birthdate) {
    var ts = safeInt(birthdate, 0); if (ts <= 0) return "—";
    var d = new Date(ts * 1000);
    var mo = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    var age = Math.floor((Date.now() - d.getTime()) / (365.25 * 86400000));
    return mo[d.getUTCMonth()] + " " + d.getUTCDate() + ", " + d.getUTCFullYear() + " (age " + age + ")";
  }
  function bioDraft(d) {
    var rd = safeInt(d.draft_round, 0);
    if (rd <= 0) return "Undrafted";
    var parts = [];
    if (d.draft_year) parts.push(safeStr(d.draft_year));
    parts.push("Rd " + rd + (d.draft_pick ? ", Pick " + safeStr(d.draft_pick) : ""));
    if (d.draft_team) parts.push(safeStr(d.draft_team));
    return parts.join(" · ");
  }
  function bioUpsDraft(p) {
    var rh = ROOKIE_HISTORY_INDEX[safeStr(p.id).replace(/\D/g, "")];
    if (!rh || !safeInt(rh.round, 0)) return "—";   // not selected in a UPS rookie draft
    var slot = "Rd " + rh.round + (rh.pick ? ", Pick " + rh.pick : "");
    return (rh.season ? rh.season + " · " : "") + slot;
  }
  function bioLastAcquired(p) {
    var head = [safeStr(p.acquisitionTypeLabel), safeStr(p.acquisitionDetail)].filter(Boolean).join(" · ") || safeStr(p.acquisitionText) || "—";
    var date = safeStr(p.acquisitionDate);
    return date ? head + " · " + date : head;
  }
  function bioInitials(name) { return (safeStr(name).match(/\b([A-Za-z])/g) || []).slice(0, 2).join("").toUpperCase() || "?"; }
  // Year-by-year salary for the player's REMAINING contract years (Keith
  // 2026-06-04): e.g. a 3-yr deal viewed in 2026 → [2026:$20K, 2027:$20K,
  // 2028:$20K]. Each year's salary comes from the contract_info Y-tokens
  // (loaded shapes differ year-to-year), falling back to the per-year
  // escalator value. So an extended player shows every remaining year.
  function contractYearlyBreakdown(player) {
    var yearsRem = Math.max(0, safeInt(player && player.years, 0));
    if (yearsRem <= 0) return [];
    var currentIdx = Math.max(1, contractYearIndexForPlayer(player));
    var yv = contractYearValueMapForPlayer(player);
    var base = safeInt(SEASON, 0);
    var out = [];
    for (var offset = 0; offset < yearsRem; offset += 1) {
      var idx = currentIdx + offset;
      var sal = safeInt(yv[idx], 0) || contractYearFallbackValue(player, idx);
      out.push({ year: base + offset, salary: sal });
    }
    return out;
  }

  function bioHtml(p, d) {
    d = d || {};
    var espn = safeStr(p.espnId).replace(/\D/g, "");
    var avatar = espn
      ? '<div class="fo-bio-avatar" style="background-image:url(https://a.espncdn.com/i/headshots/nfl/players/full/' + espn + '.png)"></div>'
      : '<div class="fo-bio-avatar">' + escapeHtml(bioInitials(p.name)) + '</div>';
    var loading = d.__loading ? ' <span class="small" style="color:var(--muted);">· loading…</span>' : "";
    // Contract section — Years Remaining + per-year salary breakdown.
    var yrsRem = Math.max(0, safeInt(p.years, 0));
    var bd = contractYearlyBreakdown(p);
    var tcv = totalContractValueForPlayer(p);
    var bdRows = bd.map(function (r) {
      return '<div class="fo-form-row" style="padding-left:14px;"><span class="lbl" style="color:var(--muted);">' + r.year + '</span><span class="val">' + escapeHtml(fmtUSD(r.salary)) + '</span></div>';
    }).join("");
    var contractSection =
      '<div class="fo-form-row" style="border-top:1px solid var(--border);margin-top:6px;padding-top:8px;">' +
        '<span class="lbl"><strong>Years Remaining in Contract</strong></span>' +
        '<span class="val"><strong>' + yrsRem + '</strong>' + (p.type ? ' <span class="small" style="color:var(--muted);">· ' + escapeHtml(p.type) + '</span>' : '') + '</span>' +
      '</div>' +
      (yrsRem > 0
        ? '<div class="small" style="color:var(--muted);margin:4px 0 2px 14px;">Yearly breakdown</div>' + bdRows +
          '<div class="fo-form-row" style="padding-left:14px;border-top:1px dashed var(--border);"><span class="lbl">TCV</span><span class="val">' + escapeHtml(fmtUSD(tcv)) + '</span></div>'
        : '<div class="fo-form-row" style="padding-left:14px;"><span class="lbl small" style="color:var(--muted);">Expired / no remaining years</span><span class="val"></span></div>');
    return `
      <div class="fo-bio">
        <div class="fo-bio-head">
          ${avatar}
          <div>
            <div class="fo-bio-name">${escapeHtml(p.name)}</div>
            <div class="small">${escapeHtml(p.position || "—")} · ${escapeHtml(p.nflTeam || d.team || "—")}${loading}</div>
          </div>
        </div>
        <div class="fo-form">
          <div class="fo-form-row"><span class="lbl">NFL Team</span><span class="val">${escapeHtml(p.nflTeam || d.team || "—")}</span></div>
          <div class="fo-form-row"><span class="lbl">Position</span><span class="val">${escapeHtml(p.position || "—")}</span></div>
          <div class="fo-form-row"><span class="lbl">Height</span><span class="val">${escapeHtml(bioHeight(d.height))}</span></div>
          <div class="fo-form-row"><span class="lbl">Weight</span><span class="val">${d.weight ? escapeHtml(d.weight) + " lbs" : "—"}</span></div>
          <div class="fo-form-row"><span class="lbl">Born</span><span class="val">${escapeHtml(bioDob(d.birthdate))}</span></div>
          <div class="fo-form-row"><span class="lbl">College</span><span class="val">${escapeHtml(d.college || "—")}</span></div>
          <div class="fo-form-row"><span class="lbl">NFL Draft</span><span class="val">${escapeHtml(bioDraft(d))}</span></div>
          <div class="fo-form-row"><span class="lbl">UPS Draft</span><span class="val">${escapeHtml(bioUpsDraft(p))}</span></div>
          <div class="fo-form-row"><span class="lbl">Last Acquired</span><span class="val" id="fo-bio-lastacq">${escapeHtml(bioLastAcquired(p))}</span></div>
          ${contractSection}
        </div>
      </div>`;
  }
  async function renderBioTab(p) {
    var body = $("#fo-slideover-body");
    if (!body) return;
    body.innerHTML = bioHtml(p, { __loading: true });
    var d = await loadPlayerDetails(p.id);
    if (!body || STATE.slideoverPid !== p.id || STATE.slideoverSubtab !== "bio") return;
    body.innerHTML = bioHtml(p, d);
    // Last Acquired — ALWAYS derive live from the transaction log and patch the
    // cell. The MFL acquisitionDate (and the static snapshot) are stale/empty for
    // ERA + dispersal moves (e.g. Chris Rodriguez: ERA auction win, but the cell
    // showed his 2023 rookie draft). The transaction log is authoritative.
    loadPlayerTransactions(p.id).then(function (data) {
      if (!body || STATE.slideoverPid !== p.id || STATE.slideoverSubtab !== "bio") return;
      var cell = document.querySelector("#fo-bio-lastacq");
      var s = foMostRecentAcq(data && data.events);
      if (cell && s) cell.textContent = s;
    }).catch(function () {});
  }

  // Contract History — year-by-year breakdown from /api/player-bundle
  // (mirrors the table Keith showed in Image 2). Columns:
  //   Yr · Team · Type · CL · YL · TCV · Salary/AAV
  // Source: bundle.contract_history (per-season rows, sourced from D1
  // src_contracts via worker /api/player-bundle handler, lines 1900+).
  async function renderContractHistoryTab(p) {
    const body = $("#fo-slideover-body");
    const bundle = await loadPlayerBundle(p.id);
    if (!body || STATE.slideoverPid !== p.id || STATE.slideoverSubtab !== "history") return; // user moved on
    const rows = (bundle && Array.isArray(bundle.contract_history)) ? bundle.contract_history.slice() : [];
    // Keith 2026-06-01: always surface the CURRENT season. The bundle's
    // contract_history (D1 src_contracts) is historical and lags the live
    // roster, so synthesize the current-season row from the live player
    // object whenever it isn't already present.
    const curSeason = safeInt(SEASON, 0);
    if (curSeason > 0 && !rows.some(function (r) { return safeInt(r.season, 0) === curSeason; })) {
      const curCl = contractLengthForPlayer(p);
      const curYrs = safeInt(p.years, 0);
      const curYl = curCl > 0 ? Math.min(curCl, Math.max(1, curCl - curYrs + 1)) : 0;
      rows.unshift({
        season: curSeason,
        team_name: p.franchise,
        contract_status: p.type,
        contract_length: curCl,
        contract_year: curYl,
        tcv: totalContractValueForPlayer(p),
        aav: displayAavForPlayer(p),
        contract_info: p.special || "",
        __current: true
      });
    }
    if (!rows.length) {
      body.innerHTML = '<div class="fo-form-note">No contract history available for this player in the bundle (or load failed).</div>';
      return;
    }
    const sorted = rows.slice().sort(function (a, b) {
      return safeInt(b.season, 0) - safeInt(a.season, 0);
    });
    const headerRows = sorted.map(function (r) {
      const yr = safeStr(r.season);
      // Worker field is team_name (per /api/player-bundle response).
      const team = safeStr(r.team_name || r.franchise_name || r.franchise || "");
      // Current season carries the live (already-canonical) MFL status; historical
      // rows get canonicalized (Veteran→Vet, +FL/BL from the year shape).
      const rawType = safeStr(r.contract_status || r.contract_type || "");
      const _yv = parseContractYearValues(r.contract_info);
      const _years = Object.keys(_yv).map(Number).sort(function (a, b) { return a - b; }).map(function (k) { return _yv[k]; });
      const type = r.__current ? rawType : foCanonType(rawType, _years);
      const cl   = safeInt(r.contract_length, 0);
      const yl   = safeInt(r.contract_year, 0);   // year-of-contract (1..CL)
      const tcv  = safeInt(r.tcv, 0);
      const aav  = safeInt(r.aav, 0);
      // Salary-for-the-season — pull from contract_info Y# token if
      // present (year-specific), else fall back to aav.
      const yv = parseContractYearValues(r.contract_info);
      const yrSalary = yl > 0 && yv[yl] ? yv[yl] : aav;
      const salaryAavCell = (yrSalary > 0 && aav > 0 && yrSalary !== aav)
        ? `${fmtK(yrSalary)} <span class="small" style="color:var(--muted);">/ ${fmtK(aav)}</span>`
        : (yrSalary > 0 ? fmtK(yrSalary) : (aav > 0 ? fmtK(aav) : "—"));
      return `
        <tr${r.__current ? ' class="fo-ch-current"' : ""}>
          <td>${escapeHtml(yr)}${r.__current ? ' <span class="fo-ch-now" title="Current season">now</span>' : ""}</td>
          <td>${escapeHtml(team)}</td>
          <td><span class="fo-ctype ${ctypeClass(type)}">${escapeHtml(type || "—")}</span></td>
          <td class="num">${cl || "—"}</td>
          <td class="num">${yl || "—"}</td>
          <td class="num">${tcv > 0 ? fmtK(tcv) : "—"}</td>
          <td class="num">${salaryAavCell}</td>
        </tr>`;
    }).join("");
    body.innerHTML = `
      <div class="fo-card-head">
        <h2 style="margin:0;">Contract History (${sorted.length} season${sorted.length === 1 ? "" : "s"})</h2>
      </div>
      <div class="fo-review-note">⚠ Auto-derived &amp; forum-mined — this data needs to be reviewed for accuracy before you rely on it.</div>
      <table class="fo-table">
        <thead>
          <tr>
            <th>Yr</th>
            <th>Team</th>
            <th>Type</th>
            <th class="num">CL</th>
            <th class="num">YL</th>
            <th class="num">TCV</th>
            <th class="num">Salary / AAV</th>
          </tr>
        </thead>
        <tbody>${headerRows}</tbody>
      </table>`;
  }

  // ── Stats sub-tab inside slide-over ─────────────────────────────────
  // Mirrors the master player-modal Stats tab: a headline strip (Career
  // Pts / PPG / Best Season / APW) over a compact "scoring" season table.
  // Source: /api/player-bundle → career_summary (D1 src_weekly rollups) +
  // leverage_coefs for APW. Computation matches player_profile_master.js
  // buildHeadlineStripHtml / buildCompactScoringTableHtml verbatim so the
  // numbers are identical across modules (no drift — see cap_math lesson).
  function foNumComma(n) { return String(Math.round(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ","); }
  function foStatRank(r) { return (r == null || r <= 0) ? "—" : "#" + r; }

  function foStatHeadlineHtml(career, lev) {
    var tot = { g: 0, pts: 0, apw: 0 };
    var wcOk = false, bestYr = null, bestPts = -1, bestPPG = 0;
    for (var i = 0; i < career.length; i++) {
      var c = career[i];
      var g = safeInt(c.games_played, 0);
      var pts = Number(c.season_points) || 0;
      var beta = (lev && lev[c.pos_group]) || 0;
      tot.g += g; tot.pts += pts;
      if (c.win_chunks != null && c.win_chunks > 0) { wcOk = true; tot.apw += c.win_chunks * beta; }
      if (pts > bestPts) { bestPts = pts; bestYr = c.season; bestPPG = (c.avg_ppg != null ? c.avg_ppg : (g ? pts / g : 0)); }
    }
    var ppg = tot.g ? tot.pts / tot.g : 0;
    var apwPerG = tot.g ? tot.apw / tot.g : 0;
    function card(lbl, val, sub, title) {
      return '<div class="fo-stat-card"' + (title ? ' title="' + escapeHtml(title) + '"' : "") + ">" +
        '<span class="fo-stat-lbl">' + lbl + "</span>" +
        '<span class="fo-stat-val">' + val + "</span>" +
        '<span class="fo-stat-sub">' + sub + "</span></div>";
    }
    return '<div class="fo-stat-cards">' +
      card("Career Pts", foNumComma(tot.pts), tot.g + " G · " + career.length + " season" + (career.length === 1 ? "" : "s")) +
      card("Career PPG", ppg.toFixed(1), "Average per game") +
      card("Best Season", (bestYr || "—"), (bestPts >= 0 ? foNumComma(bestPts) + " pts · " + bestPPG.toFixed(1) + " PPG" : "")) +
      card("Career APW", (wcOk ? tot.apw.toFixed(1) : "—"), (wcOk ? apwPerG.toFixed(2) + " / game" : "data pending"),
           "Adjusted All-Play Wins — the all-play wins this player produced, weighted by how hard it is to win at the position.") +
      "</div>";
  }

  function foStatSeasonTableHtml(career, lev) {
    var tot = { g: 0, pts: 0, apw: 0, el_num: 0, el_den: 0 };
    var wcOk = false;
    var rows = career.map(function (c) {
      var beta = (lev && lev[c.pos_group]) || 0;
      var apw = (c.win_chunks || 0) * beta;
      var g = safeInt(c.games_played, 0);
      tot.g += g; tot.pts += (Number(c.season_points) || 0); tot.apw += apw;
      if (c.elite_pct != null) { tot.el_num += c.elite_pct * g; tot.el_den += g; }
      if (c.win_chunks != null && c.win_chunks > 0) wcOk = true;
      var apwCell = (c.win_chunks != null && c.win_chunks > 0)
        ? "<strong>" + apw.toFixed(1) + "</strong>"
        : '<span style="color:var(--muted);">—</span>';
      return "<tr>" +
        "<td>" + escapeHtml(String(c.season)) + "</td>" +
        '<td class="num">' + g + "</td>" +
        '<td class="num">' + (c.season_points != null ? Number(c.season_points).toFixed(0) : "—") + "</td>" +
        '<td class="num" style="color:var(--muted);">' + foStatRank(c.pos_rank) + "</td>" +
        '<td class="num">' + (c.avg_ppg != null ? Number(c.avg_ppg).toFixed(1) : "—") + "</td>" +
        '<td class="num" style="color:var(--muted);">' + foStatRank(c.pos_ppg_rank) + "</td>" +
        '<td class="num" style="color:var(--ok);">' + (c.elite_pct != null ? Number(c.elite_pct).toFixed(0) + "%" : "—") + "</td>" +
        '<td class="num">' + apwCell + "</td>" +
        "</tr>";
    }).join("");
    var ppg = tot.g ? tot.pts / tot.g : 0;
    var el = tot.el_den ? tot.el_num / tot.el_den : 0;
    return '<div style="overflow-x:auto;">' +
      '<table class="fo-table"><thead><tr>' +
      "<th>Yr</th><th class=\"num\">G</th><th class=\"num\">Pts</th>" +
      '<th class="num" title="Positional rank by total points">Pts Rk</th>' +
      '<th class="num">PPG</th><th class="num" title="Positional rank by PPG">PPG Rk</th>' +
      '<th class="num" title="Elite weeks (z ≥ 1.0) %">Elite%</th>' +
      '<th class="num" title="Adjusted All-Play Wins — all-play wins produced, weighted by positional difficulty">APW</th>' +
      "</tr></thead><tbody>" + rows +
      '<tr class="fo-stat-career"><td><strong>Career</strong></td>' +
      '<td class="num">' + tot.g + "</td>" +
      '<td class="num">' + tot.pts.toFixed(0) + "</td>" +
      '<td class="num" style="color:var(--muted);">—</td>' +
      '<td class="num">' + ppg.toFixed(1) + "</td>" +
      '<td class="num" style="color:var(--muted);">—</td>' +
      '<td class="num" style="color:var(--ok);">' + el.toFixed(0) + "%</td>" +
      '<td class="num">' + (wcOk ? tot.apw.toFixed(1) : '<span style="color:var(--muted);">—</span>') + "</td>" +
      "</tr></tbody></table></div>" +
      (wcOk ? "" : '<p class="fo-form-note" style="margin-top:6px;">APW shows "—" when it isn\'t available for that season.</p>');
  }

  async function renderStatsTab(p) {
    var body = $("#fo-slideover-body");
    if (!body) return;
    body.innerHTML = '<div class="fo-form-note">Loading stats…</div>';
    var bundle = await loadPlayerBundle(p.id);
    if (!body || STATE.slideoverPid !== p.id || STATE.slideoverSubtab !== "stats") return; // user moved on
    var career = (bundle && Array.isArray(bundle.career_summary)) ? bundle.career_summary.slice() : [];
    if (!career.length) {
      body.innerHTML = '<div class="fo-form-note">No scoring history in the bundle for this player (rookie / pre-NFL, or load failed).</div>';
      return;
    }
    career.sort(function (a, b) { return safeInt(b.season, 0) - safeInt(a.season, 0); });
    var lev = (bundle && bundle.leverage_coefs) || {};
    body.innerHTML =
      '<div class="fo-card-head"><h2 style="margin:0;">Scoring — Career &amp; Season Splits</h2></div>' +
      foStatHeadlineHtml(career, lev) +
      foStatSeasonTableHtml(career, lev);
  }

  // ── Game Log sub-tab inside slide-over ──────────────────────────────
  // Mirrors the master modal's Scoring (MFL) game log: a season dropdown
  // over a full-season week-by-week table (1..maxWeek) with playoff weeks
  // tagged "P" + tinted, per-week tier badges, z-score, MFL start status,
  // rostered team + positional rank. Source: bundle.weekly_by_season
  // (D1 src_weekly + baselines). Playoff weeks (W15-17 for 2021+, W14-16
  // earlier) render blank until the src_weekly playoff backfill lands.
  function foGlTierClass(t) {
    return t === "Elite" ? "elite" : t === "Plus" ? "plus" : t === "Neutral" ? "neutral" : t === "Dud" ? "dud" : "";
  }
  function foGameLogScoringHtml(seasonVal, bundle) {
    var weeks = ((bundle && bundle.weekly_by_season) || {})[seasonVal] || [];
    if (!weeks.length) return '<p class="fo-form-note">No MFL weekly data for ' + escapeHtml(String(seasonVal)) + ".</p>";
    var yr = parseInt(seasonVal, 10);
    var defaultMax = (yr >= 2021) ? 17 : 16;       // 2021+: W1-14 reg, W15-17 PO; earlier: W1-13 reg, W14-16 PO
    var regSeasonWeeks = (yr >= 2021) ? 14 : 13;
    var sorted = weeks.slice().sort(function (a, b) { return a.week - b.week; });
    var dataMax = sorted.reduce(function (m, w) { return w.week > m ? w.week : m; }, 0);
    var maxWeek = Math.max(defaultMax, dataMax);
    var byWeek = {}; sorted.forEach(function (w) { byWeek[w.week] = w; });
    var starts = 0, elite = 0, plus = 0, dud = 0, pts = 0;
    sorted.forEach(function (w) {
      if (w.status === "starter") starts++;
      if (w.week_tier === "Elite") elite++;
      if (w.week_tier === "Plus") plus++;
      if (w.week_tier === "Dud") dud++;
      pts += (Number(w.score) || 0);
    });
    var tot = sorted.length || 1;
    var rows = [];
    for (var wkN = 1; wkN <= maxWeek; wkN++) {
      var w = byWeek[wkN];
      var isPo = w ? (w.is_reg === 0) : (wkN > regSeasonWeeks);
      var ptag = isPo ? ' <span class="fo-gl-ptag" title="Playoffs">P</span>' : "";
      var cls = isPo ? ' class="fo-gl-po"' : "";
      if (w) {
        var tier = w.week_tier ? '<span class="fo-tier ' + foGlTierClass(w.week_tier) + '">' + escapeHtml(w.week_tier) + "</span>" : "—";
        rows.push("<tr" + cls + ">" +
          '<td class="num">' + w.week + ptag + "</td>" +
          '<td class="num">' + (w.score != null ? Number(w.score).toFixed(1) : "—") + "</td>" +
          '<td class="num">' + (w.z_score != null ? (w.z_score > 0 ? "+" : "") + Number(w.z_score).toFixed(2) : "—") + "</td>" +
          "<td>" + tier + "</td>" +
          "<td>" + escapeHtml(w.status || "") + "</td>" +
          '<td class="small">' + escapeHtml(w.roster_franchise_name || "") + "</td>" +
          '<td class="num">' + (w.pos_rank || "—") + "</td></tr>");
      } else {
        rows.push("<tr" + cls + ' style="color:var(--muted);">' +
          '<td class="num">' + wkN + ptag + "</td>" +
          '<td class="num">—</td><td class="num">—</td><td>—</td><td>—</td><td class="small">—</td><td class="num">—</td></tr>');
      }
    }
    return '<div class="fo-form-note" style="margin-bottom:8px;">' +
      tot + " games · " + starts + " starts · " + pts.toFixed(1) + " pts (" + (pts / tot).toFixed(1) + " ppg) · " +
      "Elite " + elite + " · Plus " + plus + " · Dud " + dud + "</div>" +
      '<div style="overflow-x:auto;"><table class="fo-table"><thead><tr>' +
      '<th class="num">Wk</th><th class="num">Pts</th><th class="num">z</th><th>Tier</th><th>Status</th><th>Team</th><th class="num">Pos Rk</th>' +
      "</tr></thead><tbody>" + rows.join("") + "</tbody></table></div>";
  }
  async function renderGameLogTab(p) {
    var body = $("#fo-slideover-body");
    if (!body) return;
    body.innerHTML = '<div class="fo-form-note">Loading game log…</div>';
    var bundle = await loadPlayerBundle(p.id);
    if (!body || STATE.slideoverPid !== p.id || STATE.slideoverSubtab !== "gamelog") return; // user moved on
    var wbs = (bundle && bundle.weekly_by_season) || {};
    var seasons = Object.keys(wbs).sort(function (a, b) { return Number(b) - Number(a); });
    if (!seasons.length) {
      body.innerHTML = '<div class="fo-form-note">No weekly scoring data in the bundle for this player.</div>';
      return;
    }
    var opts = seasons.map(function (s) { return '<option value="' + s + '">' + s + "</option>"; }).join("");
    body.innerHTML =
      '<div class="fo-card-head" style="align-items:center;"><h2 style="margin:0;">Game Log</h2>' +
      '<label class="small" style="color:var(--muted); margin-left:auto;">Season ' +
      '<select id="fo-gl-season" style="margin-left:4px; background:var(--panel-alt); color:var(--text); border:1px solid var(--border); border-radius:4px; padding:3px 6px;">' +
      opts + "</select></label></div>" +
      '<div id="fo-gl-body">' + foGameLogScoringHtml(seasons[0], bundle) + "</div>" +
      '<div class="fo-form-note" style="margin-top:8px;">' +
      '<strong>Z</strong> = standard deviations above (+) or below (−) the average starter at the position that week (0 = average). ' +
      'Tiers: <strong>Elite</strong> Z ≥ 1.0 · <strong>Plus</strong> 0.25–1.0 · <strong>Neutral</strong> −0.5–0.25 · <strong>Dud</strong> below −0.5. ' +
      '<span class="fo-gl-ptag">P</span> = playoff week.</div>';
    var sel = body.querySelector("#fo-gl-season");
    if (sel) sel.addEventListener("change", function () {
      var b2 = document.querySelector("#fo-gl-body");
      if (b2) b2.innerHTML = foGameLogScoringHtml(sel.value, bundle);
    });
  }

  // ── Transaction Log sub-tab inside slide-over ───────────────────────
  // Dated timeline of the player's transactions (auction / FA add / waiver /
  // drop / trade) + rookie draft + per-season contracts, from the worker
  // /api/player-transactions (MFL TYPE=transactions ∪ D1 src_draft_picks /
  // src_contracts). Auction wins surface here even though D1 src_adddrop
  // omits them. Franchise ids are resolved to names against STATE.teams.
  function franchiseNameByFid(fid) {
    var f = pad4(fid);
    if (!f) return "—";
    var t = (STATE.teams || []).find(function (x) { return x.fid === f; });
    return t ? (t.name || ("Team " + f)) : ("Team " + f);
  }
  var __txnsCache = {};
  async function loadPlayerTransactions(pid) {
    pid = safeStr(pid).replace(/\D/g, "");
    if (!pid) return null;
    if (__txnsCache[pid]) return __txnsCache[pid];
    try {
      var res = await fetch(apiUrl("/api/player-transactions") + "?pid=" + encodeURIComponent(pid) +
        "&L=" + encodeURIComponent(LEAGUE_ID) + "&YEAR=" + encodeURIComponent(SEASON),
        { credentials: "omit", cache: "no-store" });
      var data = await res.json();
      __txnsCache[pid] = data;
      return data;
    } catch (e) { return null; }
  }
  // Most-recent acquisition (auction/add/trade/draft) as a one-line summary,
  // for the Bio "Last Acquired" fallback. NOTE: worker events arrive ASCENDING
  // (oldest first), so we must pick the latest acquisition by timestamp — not
  // acq[0] (which was the oldest, e.g. showing a 2023 rookie draft instead of a
  // 2026 ERA auction win).
  function foMostRecentAcq(events) {
    var acq = (events || []).filter(function (e) { return ["auction", "add", "trade", "draft"].indexOf(e.kind) >= 0; });
    if (!acq.length) return "";
    acq.sort(function (a, b) {
      var ta = Number(a.ts) || 0, tb = Number(b.ts) || 0;
      if (tb !== ta) return tb - ta;
      return String(b.date || "").localeCompare(String(a.date || ""));
    });
    var e = acq[0];
    var parts = [e.label || e.kind];
    if (e.kind === "trade" && e.from_franchise_id) parts.push("from " + franchiseNameByFid(e.from_franchise_id));
    else if (e.detail) parts.push(e.detail);
    if (e.date) parts.push(safeStr(e.date).slice(0, 10));
    return parts.join(" · ");
  }
  function foTxnKindClass(k) {
    return ({ auction: "auction", add: "add", drop: "drop", trade: "trade", draft: "draft", contract: "contract", extension: "extension", tag: "tag", dispersal: "dispersal" })[k] || "";
  }
  // Curated pre-2019 deep-history events (forum-validated) merged ahead of the
  // worker's modern events — the worker reaches back only to ~2019 (D1 src_*).
  var __histAcqCache = null;
  async function loadHistoricalAcquisitions() {
    if (__histAcqCache) return __histAcqCache;
    try {
      var res = await fetch(assetUrl("historical_acquisitions.json"), { cache: "no-store" });
      __histAcqCache = await res.json();
    } catch (e) { __histAcqCache = {}; }
    return __histAcqCache || {};
  }
  function foTxnSortKey(e) {
    if (e.ts) return e.ts;
    var d = safeStr(e.date);
    if (/^\d{4}-\d{2}-\d{2}/.test(d)) { try { return Math.floor(new Date(d.slice(0, 10) + "T12:00:00Z").getTime() / 1000); } catch (_) {} }
    var yr = parseInt(safeStr(e.season || d).slice(0, 4), 10) || 0;
    return yr ? Math.floor(Date.UTC(yr, 2, 1) / 1000) : 0;
  }
  // High vs low confidence for an event (explicit on curated rows; otherwise
  // inferred from the contract — even-split / approximate terms are low).
  function foEventConf(e) {
    if (e.confidence) return (e.confidence === "high" || e.confidence === "ok") ? "high" : "low";
    var cc = e.contract && e.contract.confidence;
    return (cc === "derived" || cc === "low") ? "low" : "high";
  }
  function foTxnK(n) { return (n == null) ? "—" : "$" + Math.round(Number(n) / 1000) + "K"; }
  // Contract-TYPE color family (Keith): Rookie = one color, anything Vet
  // (Vet-FAA, Vet-ERA, FL, BL, MYM, Ext, Restructure…) = another, Tag = yellow.
  function foCtypeFamily(t) {
    var s = String(t || "").toLowerCase();
    if (/tag/.test(s)) return "tag";
    if (/rookie/.test(s)) return "rookie";
    return "vet";
  }
  // Front-loaded (decreasing) vs back-loaded (increasing) from the Y-shape.
  function foStructureOf(years) {
    if (!years || years.length < 2) return "";
    var inc = true, dec = true;
    for (var i = 1; i < years.length; i++) { if (years[i] >= years[i - 1]) dec = false; if (years[i] <= years[i - 1]) inc = false; }
    return dec ? "FL" : inc ? "BL" : "";
  }
  // Canonicalize a legacy contract status to the league vocab (Vet-FAA-FL,
  // Rookie-Draft, Vet-Ext2-BL, Tag…). Already-canonical values pass through.
  // The acquisition-method suffix (FAA/ERA/Draft/WW) for HISTORICAL seasons
  // needs the per-season acquisition lineage we don't carry here, so this
  // resolves base + structure; the current season uses the live MFL status.
  function foCanonType(status, years) {
    var s = String(status || "").trim();
    if (/^(Rookie|Vet)-/.test(s) || /^Tag$/i.test(s)) return s; // already canonical
    if (/franchise\s*tag/i.test(s)) return "Tag";
    var base = /rookie/i.test(s) ? "Rookie" : (/vet|standard|^fl$|^bl$|^gf$/i.test(s) ? "Vet" : (s || "—"));
    var st = foStructureOf(years);
    return st ? base + "-" + st : base;
  }
  // Compact inline contract summary: canonical type · CL · TCV · AAV · Y1/Y2/Y3,
  // with a low-confidence flag for derived/inferred terms.
  function foContractSummary(c) {
    if (!c) return "";
    var parts = [];
    if (c.canonical_type) parts.push('<strong class="fo-ctf-' + foCtypeFamily(c.canonical_type) + '">' + escapeHtml(c.canonical_type) + "</strong>");
    if (c.cl) parts.push("CL" + c.cl);
    if (c.tcv) parts.push("TCV " + foTxnK(c.tcv));
    if (c.aav) parts.push("AAV " + foTxnK(c.aav));
    if (c.years && c.years.length) parts.push("Y " + c.years.map(function (y) { return Math.round(Number(y) / 1000) + "K"; }).join("/"));
    var s = parts.join(" · ");
    if (c.confidence === "derived") s += ' <span class="fo-lowconf" title="Low-confidence — derived/inferred (verify)">~</span>';
    return s;
  }
  function foTxnDetail(e) {
    if (e.kind === "trade") {
      // Prefer the curated HISTORICAL from-name; franchiseNameByFid resolves the
      // CURRENT (2026) owner, which is wrong for old trades (F0005 is "HammerTime"
      // now but was "C'mon Son" — a different owner — in 2017).
      var fromName = e.from_franchise_name || (e.from_franchise_id ? franchiseNameByFid(e.from_franchise_id) : "");
      return fromName ? "from " + escapeHtml(fromName) : "";
    }
    if (e.kind === "draft") return escapeHtml(e.detail || "");
    var cs = foContractSummary(e.contract);
    // Auction/waiver carry a $ price in detail — show it alongside the contract.
    if (e.detail && cs) return escapeHtml(e.detail) + " · " + cs;
    return cs || escapeHtml(e.detail || "");
  }
  async function renderTransactionLogTab(p) {
    var body = $("#fo-slideover-body");
    if (!body) return;
    body.innerHTML = '<div class="fo-form-note">Loading transaction log…</div>';
    var data = await loadPlayerTransactions(p.id);
    var histAll = await loadHistoricalAcquisitions();
    if (!body || STATE.slideoverPid !== p.id || STATE.slideoverSubtab !== "txns") return; // user moved on
    var workerEvents = (data && Array.isArray(data.events)) ? data.events : [];
    var histEvents = (histAll && Array.isArray(histAll[p.id])) ? histAll[p.id] : [];
    // Curated deep-history SUPERSEDES the auto-derived worker events for every
    // season it covers (older MFL annotations drift, e.g. Hill's 2018) — keep
    // worker events only for seasons AFTER the curated range.
    var maxHist = histEvents.reduce(function (m, e) { return Math.max(m, parseInt(e.season, 10) || 0); }, 0);
    if (maxHist) workerEvents = workerEvents.filter(function (e) { return (parseInt(e.season, 10) || 9999) > maxHist; });
    var events = histEvents.concat(workerEvents).slice();
    // Split acquisitions (auction / FA add) into the acquisition + a separate
    // Contract event (Keith: the contract handout is its own event). MFL has no
    // distinct handout date, so the Contract shares the acquisition date.
    var expanded = [];
    events.forEach(function (e) {
      if ((e.kind === "auction" || e.kind === "add") && e.contract) {
        var acq = {}, con = {}, k;
        for (k in e) { acq[k] = e[k]; con[k] = e[k]; }
        acq.contract = null; acq._sub = 0;
        con.kind = "contract"; con.label = "Contract"; con.detail = ""; con.from_franchise_id = null; con._sub = 1;
        expanded.push(acq, con);
      } else { e._sub = 0; expanded.push(e); }
    });
    events = expanded;
    // Newest-first (Keith: newest tx up top — consistent with Contract History
    // + Stats). Primary key descending; _sub stays ascending so within a
    // same-date pair the acquisition still sits above its Contract.
    events.sort(function (a, b) { return (foTxnSortKey(b) - foTxnSortKey(a)) || ((a._sub || 0) - (b._sub || 0)); });
    events.forEach(function (e, i) { e.seq = i + 1; });
    if (!events.length) {
      body.innerHTML = '<div class="fo-form-note">No transactions found for this player' + (data && data.ok ? "" : " (load failed)") + ".</div>";
      return;
    }
    var rows = events.map(function (e) {
      var dateStr = e.date_approx
        ? "~" + escapeHtml(safeStr(e.date).slice(0, 4))
        : escapeHtml(safeStr(e.date).slice(0, 10) || String(e.season));
      var team = e.franchise_name ? escapeHtml(e.franchise_name) : escapeHtml(franchiseNameByFid(e.franchise_id));
      var src = safeStr(e.source || e.evidence);
      var info = src ? ' <span class="fo-src" title="' + escapeHtml(src) + '">ⓘ</span>' : "";
      return "<tr>" +
        '<td class="small" style="color:var(--muted);">' + (e.seq || "") + "</td>" +
        '<td class="small" style="white-space:nowrap;">' + dateStr + "</td>" +
        "<td>" + '<span class="fo-txn ' + foTxnKindClass(e.kind) + '">' + escapeHtml(e.label || e.kind) + "</span></td>" +
        "<td>" + foTxnDetail(e) + info + "</td>" +
        '<td class="small">' + team + "</td>" +
        "</tr>";
    }).join("");
    var span = (data && data.seasons_scanned) || [];
    var oldestYr = histEvents.length ? histEvents[0].season : (span.length ? span[0] : "");
    body.innerHTML =
      '<div class="fo-card-head"><h2 style="margin:0;">Transaction Log (' + events.length + ")</h2></div>" +
      '<div class="fo-review-note">⚠ Auto-derived &amp; forum-mined — this data needs to be reviewed for accuracy before you rely on it.</div>' +
      '<div style="overflow-x:auto;"><table class="fo-table"><thead><tr>' +
      '<th class="num">#</th><th>Date</th><th>Event</th><th>Detail</th><th>Team</th>' +
      "</tr></thead><tbody>" + rows + "</tbody></table></div>";
  }

  // ── News sub-tab inside slide-over ──────────────────────────────────
  // Mirrors the master player modal's News feed: live /api/player-news
  // (worker aggregates Sleeper injury/status + ESPN/Yahoo/PFT/CBS headlines).
  // Depth-chart entries are excluded (roster info, not news — Keith 2026-05-13).
  var __newsCache = {};
  async function loadPlayerNews(pid) {
    if (!pid) return null;
    if (__newsCache[pid]) return __newsCache[pid];
    try {
      var res = await fetch(apiUrl("/api/player-news") + "?pids=" + encodeURIComponent(pid) +
        "&L=" + encodeURIComponent(LEAGUE_ID) + "&YEAR=" + encodeURIComponent(SEASON), { cache: "no-store" });
      var data = await res.json();
      __newsCache[pid] = data;
      return data;
    } catch (e) { return null; }
  }
  function foNewsItemClass(t) {
    if (t === "injury" || t === "status") return "fo-news-injury";
    if (t === "headline") return "fo-news-headline";
    return "";
  }
  function foIsRealNews(it) { return !!it && (it.type === "injury" || it.type === "status" || it.type === "headline"); }
  function foRenderNewsItem(it) {
    var when = "";
    if (it.timestamp) { try { when = new Date(Number(it.timestamp) * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }); } catch (e) {} }
    var meta = (it.source ? escapeHtml(String(it.source)) : "") + (when ? " · " + when : "");
    var headline = it.url
      ? '<a href="' + escapeHtml(it.url) + '" target="_blank" rel="noopener noreferrer">' + escapeHtml(it.headline || "") + "</a>"
      : escapeHtml(it.headline || "");
    return '<div class="fo-news-item ' + foNewsItemClass(it.type) + '">' +
      '<div class="fo-news-headline">' + headline + "</div>" +
      '<div class="fo-news-meta">' + meta + "</div>" +
      (it.body ? '<div class="fo-news-body">' + escapeHtml(it.body) + "</div>" : "") + "</div>";
  }
  async function renderNewsTab(p) {
    var body = $("#fo-slideover-body");
    if (!body) return;
    body.innerHTML = '<div class="fo-card-head"><h2 style="margin:0;">News</h2></div><div class="fo-form-note">Loading news…</div>';
    var data = await loadPlayerNews(p.id);
    if (!body || STATE.slideoverPid !== p.id || STATE.slideoverSubtab !== "news") return; // user moved on
    var raw = (data && data.items_by_pid && data.items_by_pid[String(p.id)]) || [];
    var items = raw.filter(foIsRealNews);
    // Newest first (consistent with the other sub-tabs).
    items.sort(function (a, b) { return (Number(b.timestamp) || 0) - (Number(a.timestamp) || 0); });
    var feed;
    if (items.length) {
      feed = '<div class="fo-news-list">' + items.map(foRenderNewsItem).join("") + "</div>";
    } else {
      var hadDepth = raw.some(function (it) { return it && it.type === "depth"; });
      feed = '<div class="fo-form-note">No injury reports or news headlines for this player.' +
        (hadDepth ? " (Depth-chart position available — see Bio.)" : "") + "</div>";
    }
    var injuryNote = "";
    if (p && (p.injuryStatus || p.injury_status)) {
      injuryNote = '<div class="fo-news-item fo-news-injury"><div class="fo-news-headline">MFL Injury · ' +
        escapeHtml(safeStr(p.injuryStatus || p.injury_status)) + "</div>" +
        (p.injuryDetails || p.injury_details ? '<div class="fo-news-body">' + escapeHtml(safeStr(p.injuryDetails || p.injury_details)) + "</div>" : "") + "</div>";
    }
    body.innerHTML =
      '<div class="fo-card-head" style="align-items:center;"><h2 style="margin:0;">News</h2>' +
      '<span class="small" style="color:var(--muted); margin-left:auto;">Sleeper + ESPN/Yahoo/PFT/CBS</span></div>' +
      (injuryNote ? '<div class="fo-news-list" style="margin-bottom:10px;">' + injuryNote + "</div>" : "") +
      feed;
  }

  // ── Actions sub-tab inside slide-over ───────────────────────────────
  // Keith 2026-05-19: only render rows a player is ELIGIBLE for; hide
  // the rest entirely. Tag is owned by the Tagging tab — only Untag
  // belongs in this modal (and only when currently tagged).
  function renderActionsTab(p) {
    const elig = rosterContractEligibility(p);
    // Worker fields first; client-side §C4.6 synthesis as fallback.
    // Keith 2026-05-19 checkpoint 2: MHJ-class players where worker
    // doesn't ship previews now get computed inline.
    const extOpts = effectiveExtensionPreviews(p);
    const has1 = !!extOpts.find(function (o) { return safeInt(o.years, 0) === 1 || safeInt(o.years_added, 0) === 1 || safeInt(o.yearsToAdd, 0) === 1; });
    const has2 = !!extOpts.find(function (o) { return safeInt(o.years, 0) === 2 || safeInt(o.years_added, 0) === 2 || safeInt(o.yearsToAdd, 0) === 2; });
    const synthesized = extOpts.length > 0 && extOpts[0].synthesized === true;
    const rows = [];

    // §C2 MYAC — a 1-yr default (Vet-ERA or fresh FA-auction Veteran) becomes a
    // 2- or 3-year contract at the SAME salary (TCV = salary × years; NO escalator
    // — that's §C4 Extensions). Loadable (FL/BL). Shown INSTEAD of Extension while
    // the MYAC window is open (Keith: nobody extends when they can MYAC).
    if (elig.myacEligible) {
      const recAs = String(p.type || "").toLowerCase().indexOf("-era") !== -1 ? "Vet-ERA" : "Vet-FAA";
      // A pre-season WW/FCFS pickup on the ladder (canon ~379/~785) is
      // neither an ERA win nor an FA-Auction win — say so explicitly so
      // "Records as Vet-FAA" (the actual contract_status token, unchanged
      // here — that's the write path, out of scope for this fix) doesn't
      // read as "this was won at the FA Auction."
      const acqNote = elig.preseasonWaiverPickup
        ? " (this is a pre-season WW/FCFS pickup, not an FA-Auction or ERA win — see the Contracts list for its true acquisition type)"
        : "";
      // MYAC needs no worker preview — it's just bid × years — so always offer 2/3
      // year (flat + loaded). The worker doesn't ship extension previews for
      // Vet-ERA players, which is why these were wrongly hidden (e.g. M. Mayer).
      const mbtns = [
        `<button class="btn small" data-action="myac" data-years="1">2-Year</button>`,
        `<button class="btn small" data-action="myac-loaded" data-total="2">2-Year Loaded…</button>`,
        `<button class="btn small" data-action="myac" data-years="2">3-Year</button>`,
        `<button class="btn small" data-action="myac-loaded" data-total="3">3-Year Loaded…</button>`
      ];
      const dlNote = STATE.contractDeadline ? " Window closes " + escapeHtml(STATE.contractDeadline) + "." : "";
      rows.push(actionRow("Multi-Year Contract (MYAC)",
        "Set this 1-yr deal to a 2- or 3-year contract (§C2) at the SAME salary (TCV = salary × years — no raise). <strong>Loaded</strong> free-keys Y1 in whole $1,000s (FL/BL; Y1 ≥ 20% TCV). Records as " + recAs + acqNote + ". Max " + LOADED_MAX + " loaded contracts per roster." + dlNote,
        mbtns.join(" ") || '<span class="small" style="color:var(--muted);">No multi-year option computed.</span>'));
    }

    // §C3 MYM — an in-season WW/FCFS pickup converts to a FLAT 2- or 3-year deal
    // at the SAME salary within 14 days of acquisition (cannot be loaded; max
    // 4/season). STATE.mymTest (?mymtest=1) surfaces this on ANY player so the
    // commish can exercise the wiring out of season — the form then defaults to
    // a dry run. The worker re-validates the window + cap on submit.
    if (elig.mymEligible || STATE.mymTest) {
      const isTestRow = !elig.mymEligible && STATE.mymTest;
      // Label is escaped by actionRow() — keep the TEST marker plain text; the
      // rich "dry run" note lives in the (unescaped) help below.
      const testNote = isTestRow ? " — TEST" : "";
      const dayNote = (elig.mymDaysSinceAcq != null && elig.mymDaysSinceAcq >= 0)
        ? " Day " + elig.mymDaysSinceAcq + " of 14." : "";
      const mbtns = [
        `<button class="btn small" data-action="mym" data-total="2">2-Year</button>`,
        `<button class="btn small" data-action="mym" data-total="3">3-Year</button>`
      ];
      rows.push(actionRow("Mid-Year Multi (MYM)" + testNote,
        "Convert this in-season pickup to a <strong>flat</strong> 2- or 3-year contract at the SAME salary (TCV = salary × years — no raise, cannot be loaded; §C3). Max 4 MYMs per team per season."
          + dayNote + (isTestRow ? " <em>Test mode: submits a dry run.</em>" : ""),
        mbtns.join(" ")));
    }

    const extBlocked = extensionBlockedByCurrentOwner(p);
    if (elig.extensionEligible && extBlocked) {
      // Blocked path — show ONLY the blocked row, not the buttons
      // (Keith 2026-05-19: don't render Ext row if blocked).
      rows.push(actionRow("Extension — blocked",
        "RULE-EXT-003: this franchise has already extended this player. Only a different franchise can extend again.",
        `<button class="btn small secondary" disabled>Blocked</button>`));
    } else if (elig.extensionEligible) {
      const btns = [];
      if (has1) btns.push(`<button class="btn small" data-action="extend" data-years="1">+1Y</button>`);
      if (has2) btns.push(`<button class="btn small" data-action="extend" data-years="2">+2Y Flat</button>`);
      if (has2) btns.push(`<button class="btn small" data-action="extend-loaded" data-years="2">+2Y Loaded…</button>`);
      const help = "Extend the contract by 1 or 2 years (§C4). <strong>Loaded</strong> lets you split Y2/Y3 yourself (FL/BL); Y1 stays at current salary."
        + (synthesized ? " <em>Preview synthesized client-side per §C4.6 escalator.</em>" : "");
      rows.push(actionRow("Extension", help, btns.join(" ")));
    }

    if (elig.rookieOptionEligible) {
      rows.push(actionRow("Rookie Option (4th-yr)",
        "Exercise Y3 + $5K option on Round 1 rookie (§C6).",
        `<button class="btn small" data-action="rookie-option">Exercise</button>`));
    }

    if (elig.restructureEligible) {
      rows.push(actionRow("Restructure",
        "Veteran multi-year only — spread Y1 over Y2-3 (offseason, max 3/season, Y1 ≥ 20% TCV; §C5).",
        `<button class="btn small" data-action="restructure">Open form</button>`));
    }

    if (elig.untagEligible) {
      rows.push(actionRow("Untag",
        "Revert tag and restore prior contract (§C8.2).",
        `<button class="btn small warn" data-action="untag">Untag</button>`));
    }

    // Roster moves — only show the ones that apply to current state.
    const moveBtns = [];
    if (p.isIr)   moveBtns.push(`<button class="btn small" data-action="activate-ir">Activate IR</button>`);
    if (p.isTaxi) moveBtns.push(`<button class="btn small" data-action="promote-taxi">Promote Taxi</button>`);
    // Move to Taxi: a taxi-eligible active rookie (§B2 — UPS R2-5, within the
    // 3-league-year window, not yet permanently promoted) can be demoted to taxi.
    if (p.taxiEligible && !p.isTaxi && !p.isIr && !p.taxiPermanentPromotion) {
      moveBtns.push(`<button class="btn small" data-action="demote-taxi">Move to Taxi</button>`);
    }
    // Drop is available on ANY rostered player incl taxi (Keith 2026-06-02) —
    // a taxi/§D2-exempt drop just carries a $0 penalty, which the label shows.
    if (!p.isIr) {
      moveBtns.push(`<button class="btn small warn" data-action="drop">Drop (pen ${fmtUSD(dropPenaltyEstimate(p).amount)})</button>`);
    }
    if (moveBtns.length) {
      rows.push(actionRow("Roster Move",
        "Drop fires §D1 cap penalty. IR Activate / Taxi Promote are owner-confirmed.",
        moveBtns.join(" ")));
    }

    rows.push(actionRow("Trade",
      "Hand off to Trade Hub (no direct submit from FO).",
      `<button class="btn small" data-action="trade" data-pid="${escapeHtml(p.id)}" data-fid="${escapeHtml(p.fid)}">Open in Trade Hub</button>`));

    if (!rows.length) {
      return '<div class="fo-form-note">No contract actions are currently available for this player.</div>';
    }
    return rows.join("");
  }

  function actionRow(label, help, ctrlHtml) {
    // help may include trusted inline markup (e.g. <em>). All caller
    // strings are static. If we ever interpolate user data into help,
    // escapeHtml at the call site.
    return `
      <div class="fo-action-row">
        <div>
          <div class="fo-action-row-label">${escapeHtml(label)}</div>
          <div class="fo-action-row-help">${help}</div>
        </div>
        <div class="fo-action-row-ctrl">${ctrlHtml}</div>
      </div>`;
  }

  // ERA forced retention (§A3): mirror of the mobile player-sheet gate. A
  // player won in the CURRENT Expired Rookie Auction can't be cut until the FA
  // Auction closes; the worker blocks the real drop, so we hide the Drop button
  // here so the owner never taps into the error. A dry-run drop is the
  // authoritative check — the worker's ERA gate runs before the dry-run
  // short-circuit, answering precisely (current-cycle winners only, auto-lifts
  // when the auction closes, no MFL write). Only for "-era" contracts; fail-open.
  function gateEraRetentionDropFO(body, p) {
    var status = String((p && p.type) || "").toLowerCase();
    if (status.indexOf("-era") === -1) return;
    if (!body.querySelector("[data-action='drop']")) return;
    // Viewer session required — without it the worker answers under the
    // commish cookie and the dry-run gate is evaluated for the wrong identity.
    var url = appendViewerSessionQuery(
      EP_ROSTER_ACTION() + "?L=" + encodeURIComponent(LEAGUE_ID) + "&YEAR=" + encodeURIComponent(SEASON)
    );
    fetch(url, {
      method: "POST", credentials: "omit", cache: "no-store",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "drop_player", dry_run: 1, league_id: LEAGUE_ID, season: SEASON, franchise_id: p.fid, player_id: p.id })
    }).then(function (r) { return r.json().catch(function () { return {}; }); })
      .then(function (d) {
        var blocked = d && (d.code === "ERA_FORCED_RETENTION" || (d.gate && d.gate.blocked === true));
        if (!blocked) return;
        var live = body.querySelector("[data-action='drop']");
        if (!live || !live.parentNode) return;
        var note = document.createElement("span");
        note.className = "fo-era-lock";
        note.setAttribute("style", "display:inline-block;padding:5px 9px;border-radius:6px;background:rgba(255,184,107,0.14);border:1px solid rgba(255,184,107,0.34);color:#e6a85e;font-size:12px;line-height:1.4;");
        note.textContent = "🔒 Won in the " + SEASON + " Expired Rookie Auction — can’t be cut until the FA Auction closes (§A3).";
        live.parentNode.replaceChild(note, live);
      })
      .catch(function () { /* fail-open — worker still enforces the block */ });
  }

  function wireActionsTab(body, p) {
    $$("[data-action='extend']", body).forEach(function (btn) {
      btn.addEventListener("click", function () { openExtensionForm(p, safeInt(btn.dataset.years, 1)); });
    });
    $$("[data-action='extend-loaded']", body).forEach(function (btn) {
      btn.addEventListener("click", function () { openExtensionLoadedForm(p); });
    });
    $$("[data-action='myac']", body).forEach(function (btn) {
      btn.addEventListener("click", function () { openMyacForm(p, safeInt(btn.dataset.years, 1)); });
    });
    $$("[data-action='myac-loaded']", body).forEach(function (btn) {
      btn.addEventListener("click", function () { openMyacLoadedForm(p, safeInt(btn.dataset.total, 3)); });
    });
    $$("[data-action='mym']", body).forEach(function (btn) {
      btn.addEventListener("click", function () { openMymForm(p, safeInt(btn.dataset.total, 2)); });
    });
    $$("[data-action='rookie-option']", body).forEach(function (btn) {
      btn.addEventListener("click", function () { submitRookieOption(p); });
    });
    $$("[data-action='restructure']", body).forEach(function (btn) {
      btn.addEventListener("click", function () { openRestructureForm(p); });
    });
    $$("[data-action='untag']", body).forEach(function (btn) {
      btn.addEventListener("click", function () { submitUntag(p); });
    });
    $$("[data-action='drop']", body).forEach(function (btn) {
      btn.addEventListener("click", function () { submitRosterMove("drop_player", p); });
    });
    gateEraRetentionDropFO(body, p);
    $$("[data-action='activate-ir']", body).forEach(function (btn) {
      btn.addEventListener("click", function () { submitRosterMove("activate_ir", p); });
    });
    $$("[data-action='promote-taxi']", body).forEach(function (btn) {
      btn.addEventListener("click", function () { submitRosterMove("promote_taxi", p); });
    });
    $$("[data-action='demote-taxi']", body).forEach(function (btn) {
      btn.addEventListener("click", function () { submitRosterMove("demote_taxi", p); });
    });
    $$("[data-action='trade']", body).forEach(function (btn) {
      btn.addEventListener("click", function () {
        // Open the in-MFL Trade War Room (MESSAGE6) — NOT the GitHub Pages trade
        // workbench (Keith 2026-06-06). The header exposes the canonical URL
        // (window.getWarRoomUrl, format ?MODULE=MESSAGE6=N) when FO runs inside
        // MFL; otherwise build it from the current MFL origin. Player preselect
        // is parked (the war room loads its own payload).
        var warRoom = (typeof window.getWarRoomUrl === "function" && window.getWarRoomUrl()) ||
          (window.location.origin + "/" + encodeURIComponent(SEASON) + "/home/" +
           encodeURIComponent(LEAGUE_ID) + "?MODULE=MESSAGE6=N");
        window.open(warRoom, "_blank", "noopener");
      });
    });
  }

  // ── Extension form (the wired-through proof of pattern) ─────────────
  function openExtensionForm(p, years) {
    const opt = pickExtensionOption(p, years);
    if (!opt) {
      flashToast("No " + years + "-year extension option available for this player.", "warn");
      return;
    }
    const body = $("#fo-slideover-body");
    body.innerHTML = renderExtensionForm(p, opt);
    $("#fo-ext-cancel").addEventListener("click", function () { renderSlideoverBody(); });
    $("#fo-ext-submit").addEventListener("click", function () { submitExtension(p, opt); });
  }

  // MYAC flat (Veteran default) — reuses the extension form/submit, but records
  // the contract as Vet-ERA (§A3, the acquisition method survives MYAC), not
  // Vet-Ext. years 1 → 2-year total, years 2 → 3-year total.
  function myacStatusBase(p) {
    return String(p && p.type || "").toLowerCase().indexOf("-era") !== -1 ? "Vet-ERA" : "Vet-FAA";
  }
  // Submit a Multi-Year Auction Contract (§C2): flat OR loaded, at the AUCTION
  // salary — TCV = SUM(year salaries). There is NO escalator (that's §C4
  // Extensions). FL/BL suffix auto-derived from the year shape.
  async function submitMyacContract(p, totalYears, yrs, statusBase) {
    yrs = (yrs || []).map(roundToK);                      // every year in whole $1,000s
    if (yrs.some(function (v) { return v % 1000 !== 0 || v < 1000; })) {
      flashToast("All contract years must be whole $1,000 increments (no $0 year).", "err");
      return;
    }
    const tcv = yrs.reduce(function (a, b) { return a + b; }, 0);
    const aav = Math.round(tcv / totalYears);
    const loaded = yrs.some(function (v) { return v !== yrs[0]; });
    const status = statusBase + (loaded ? (yrs[0] > aav ? "-FL" : "-BL") : "");
    const gtd = guaranteeForContract(tcv, totalYears);   // §D1: sub-$5K, 2/3-yr → $1K (not $0)
    const contractInfo = "CL " + totalYears +
      "|TCV " + fmtK(tcv).replace(/\$/, "") + "|AAV " + fmtK(aav).replace(/\$/, "") +
      "|" + yrs.map(function (v, i) { return "Y" + (i + 1) + "-" + fmtK(v).replace(/\$/, ""); }).join(", ") +
      "|GTD: " + fmtK(gtd).replace(/\$/, "");
    const confirmLines = ["Confirm " + totalYears + "-year MYAC for " + p.name + "?", "", "Status: " + status]
      .concat(yrs.map(function (v, i) { return "Y" + (i + 1) + ": " + fmtUSD(v); }))
      .concat(["TCV: " + fmtUSD(tcv) + " · GTD: " + fmtUSD(gtd)]);
    if (!window.confirm(confirmLines.join("\n"))) return;
    const url = EP_CONTRACT_UPDATE() + "?L=" + encodeURIComponent(LEAGUE_ID) + "&YEAR=" + encodeURIComponent(SEASON);
    const payload = {
      L: LEAGUE_ID, YEAR: SEASON, type: "MANUAL_CONTRACT_UPDATE", submission_kind: "myac",
      dry_run: IS_DRY_RUN ? 1 : 0, source: "front-office-v2-myac-submit",
      leagueId: LEAGUE_ID, year: SEASON, player_id: p.id, player_name: p.name,
      franchise_id: p.fid, franchise_name: p.franchise, position: p.positionGroup || p.position,
      salary: yrs[0], contract_year: totalYears, contract_status: status, contract_info: contractInfo,
      prior_contract_status: p.type, prior_salary: p.salary, prior_contract_year: p.years, prior_contract_info: p.special,
      acquisition_date: p.acquisitionDate || "", acquisition_type: p.acquisitionTypeLabel || "",
      submitted_at_utc: new Date().toISOString(), commish_override_flag: commishOverrideFor(p) ? 1 : 0
    };
    try {
      await postContractUpdate(url, payload);
      flashToast((IS_DRY_RUN ? "[DRY-RUN] " : "") + p.name + " " + totalYears + "-yr MYAC submitted (" + status + ").", "ok");
      await loadRosterData(); renderRosterTable(); closeSlideover();
    } catch (e) {
      console.error("[fo] MYAC failed:", e);
      flashToast("MYAC submit failed: " + (e && e.message ? e.message : e), "err");
    }
  }
  // Flat MYAC — keep the auction salary flat across 2 or 3 years (TCV = bid × N).
  function openMyacForm(p, addedYears) {
    const totalYears = addedYears + 1;
    const bid = safeInt(p.salary, 0);
    if (bid < 1000) { flashToast("MYAC needs a base salary ≥ $1,000.", "warn"); return; }
    const yrs = []; for (let i = 0; i < totalYears; i += 1) yrs.push(bid);
    submitMyacContract(p, totalYears, yrs, myacStatusBase(p));
  }

  // §C3 MYM — convert an in-season pickup to a FLAT 2- or 3-year deal at the
  // SAME salary. TCV = salary × years; NO escalator, NO loading (loading is
  // banned because it would restructure Y1, §C3). The UPS contract_type is MYM
  // (MFL surface stays "Veteran"); sub_type preserves the origin. POSTs
  // /offer-mym (submission_kind="mym") → worker writes ups_mym_submissions.
  function mymSubType(p) {
    const t = String(p && p.type || "").toLowerCase();
    const acq = String(p && p.acquisitionTypeLabel || "").toLowerCase();
    if (/rookie/.test(t)) return "MYM-Rookie";
    if (/\b(ww|fcfs|blind|waiver|free agent)\b/.test(acq) && acq.indexOf("auction") === -1) return "WW-MYM";
    return "Veteran-MYM";
  }
  async function submitMymContract(p, totalYears) {
    const perYear = safeInt(p.salary, 0);
    if (perYear < 1000) { flashToast("MYM needs a base salary ≥ $1,000.", "warn"); return; }
    if (totalYears !== 2 && totalYears !== 3) { flashToast("MYM length must be 2 or 3 years (§C3).", "warn"); return; }
    const tcv = perYear * totalYears;            // flat — no escalator, no loading
    const aav = perYear;
    const gtd = guaranteeForContract(tcv, totalYears);   // §D1 guarantee
    const subType = mymSubType(p);
    const yrs = []; for (let i = 0; i < totalYears; i += 1) yrs.push(perYear);
    const contractInfo = "CL " + totalYears +
      "| TCV " + fmtK(tcv).replace(/\$/, "") + "| AAV " + fmtK(aav).replace(/\$/, "") +
      "| " + yrs.map(function (v, i) { return "Y" + (i + 1) + "-" + fmtK(v).replace(/\$/, ""); }).join(", ") +
      "| GTD: " + fmtK(gtd).replace(/\$/, "");
    // Test mode (?mymtest=1 surfacing the action on an INELIGIBLE player) forces
    // a dry run so no live MFL data is touched while exercising the wiring.
    const elig = rosterContractEligibility(p);
    const forceDry = !!(STATE.mymTest && !elig.mymEligible);
    const dry = (IS_DRY_RUN || forceDry) ? 1 : 0;
    const confirmLines = [(dry ? "[DRY-RUN] " : "") + "Confirm " + totalYears + "-year MYM for " + p.name + "?", "",
      "Sub-type: " + subType, "Per year: " + fmtUSD(perYear) + " (flat — cannot be loaded)",
      "TCV: " + fmtUSD(tcv) + " · GTD: " + fmtUSD(gtd)];
    if (!window.confirm(confirmLines.join("\n"))) return;
    const url = apiUrl("/offer-mym") + "?L=" + encodeURIComponent(LEAGUE_ID) + "&YEAR=" + encodeURIComponent(SEASON);
    const payload = {
      L: LEAGUE_ID, YEAR: SEASON, type: "MYM", submission_kind: "mym",
      dry_run: dry, source: forceDry ? "front-office-mym-test" : "front-office-v2-mym-submit",
      leagueId: LEAGUE_ID, year: SEASON, player_id: p.id, player_name: p.name,
      franchise_id: p.fid, franchise_name: p.franchise, position: p.positionGroup || p.position,
      salary: perYear, per_year: perYear, contract_year: totalYears, contract_status: "Veteran", contract_info: contractInfo,
      mym_length: totalYears, mym_option: "mym" + totalYears, sub_type: subType,
      tcv: tcv, aav: aav, guaranteed: gtd,
      prior_contract_status: p.type, prior_salary: p.salary, prior_contract_year: p.years, prior_contract_info: p.special,
      acquisition_date: p.acquisitionDate || "", acquisition_type: p.acquisitionTypeLabel || "",
      submitted_at_utc: new Date().toISOString(), commish_override_flag: commishOverrideFor(p) ? 1 : 0
    };
    try {
      await postContractUpdate(url, payload);
      flashToast((dry ? "[DRY-RUN] " : "") + p.name + " " + totalYears + "-yr MYM submitted (" + subType + ").", "ok");
      if (!dry) { await loadRosterData(); renderRosterTable(); }
      closeSlideover();
    } catch (e) {
      console.error("[fo] MYM failed:", e);
      flashToast("MYM submit failed: " + (e && e.message ? e.message : e), "err");
    }
  }
  function openMymForm(p, totalYears) {
    submitMymContract(p, totalYears || 2);
  }

  // Count a team's loaded (FL/BL) contracts on the active roster (taxi $0/exempt).
  // §C2 loaded count — taxi rows are NOT excluded. Keith 2026-08-01: "taxi
  // contracts can't be loaded because all rookie contracts are flat" (§B2 puts
  // only rookies on the taxi squad, and §A1 rookie deals are flat), so a loaded
  // taxi row cannot legitimately exist — verified across 104 taxi players and
  // 34 loaded contracts league-wide: zero overlap. The old `!q.isTaxi` filter
  // therefore changed nothing in practice, but it made this function disagree
  // with the hub counter (which includes taxi) on the same screen, and it
  // failed OPEN: if a bad row ever did appear, the function that GATES real
  // writes (openMyacLoadedForm, submitRestructure) would not count it and would
  // let a team past 5. Counting every loaded row is both consistent and the
  // safe direction for a write gate.
  function loadedContractCountForTeam(fid) {
    const team = (STATE.teams || []).find(function (t) { return t.fid === fid; });
    if (!team) return 0;
    return (team.players || []).filter(function (q) { return isLoadedRow(q); }).length;
  }
  // ── Loaded-MYAC basis + floors — THE one place these numbers come from ──
  //
  // §C2: a MYAC converts a 1-year default into a 2- or 3-year deal at the
  // auction price. TCV = bid × years (NO escalator — that's §C4 Extensions),
  // AAV = bid, and Year 1 must carry ≥ 20% of TCV. Both the slide-over form
  // (openMyacLoadedForm) and the Cap Planning editor read the basis from here,
  // so the two surfaces can never drift apart on the numbers.
  //
  // Resolvability is tracked on `ok`/`reason` (never on a sentinel amount): an
  // unreadable basis returns ok:false and the caller must refuse to render a
  // projection rather than fall back to something plausible-looking.
  function myacLoadedBasis(p, totalYears) {
    const out = { ok: false, reason: "", years: totalYears, bid: 0, tcv: 0, aav: 0, minY1: 0, statusBase: "" };
    if (!p) { out.reason = "No player."; return out; }
    if (totalYears !== 2 && totalYears !== 3) { out.reason = "A MYAC runs 2 or 3 years (§C2)."; return out; }
    // §C2 converts a 1-YEAR default. Anything else has no MYAC basis — and this
    // is also what retires a stale Cap Planning preview the moment a committed
    // MYAC reloads the roster as a 2/3-year deal.
    const yearsRemaining = Math.max(0, safeInt(p.years, 0));
    if (yearsRemaining !== 1) {
      out.reason = "A MYAC converts a 1-year default (§C2); this contract shows " + yearsRemaining + " year" +
                   (yearsRemaining === 1 ? "" : "s") + " remaining.";
      return out;
    }
    const bid = safeInt(p.salary, 0);
    if (bid < 1000) { out.reason = "MYAC needs a base salary ≥ $1,000."; return out; }
    out.ok = true;
    out.bid = bid;
    out.aav = bid;                          // flat basis — TCV = bid × years, NO escalator (§C2)
    out.tcv = bid * totalYears;
    // 20%-of-TCV Year-1 floor. CEIL to the next $1K so the floor never dips
    // below a true 20%. With bid ≥ $1,000 and years ≥ 2 this is always ≥ $1,000,
    // so no Math.max is needed and nothing here can launder an unresolved basis.
    out.minY1 = Math.ceil(out.tcv * 0.2 / 1000) * 1000;
    out.statusBase = myacStatusBase(p);
    return out;
  }
  // The §C2 floors submitMyacContract will re-check. Shared so the slide-over
  // form and the Cap Planning editor enforce one rule set, in one order.
  function myacLoadedYearsError(yrs, minY1) {
    if (yrs.some(function (v) { return v % 1000 !== 0; })) return "All years must be whole $1,000 increments.";
    if (yrs[0] < minY1) return "Year 1 must be ≥ " + fmtUSD(minY1) + " (20% of TCV).";
    if (yrs.some(function (v) { return v < 1000; })) return "No year can be below $1,000 — there are no $0 years.";
    return "";
  }

  // MYAC loaded (§C2): free-key Y1 (FL if Y1>AAV, BL if Y1<AAV; Y1 ≥ 20% TCV);
  // the LAST year auto-computes (TCV − keyed years). 2-yr: Y1 free → Y2 auto.
  // 3-yr: Y1 & Y2 free → Y3 auto. Hard-blocks at the 5-loaded roster cap (§C2).
  function openMyacLoadedForm(p, totalYears) {
    const basis = myacLoadedBasis(p, totalYears);
    if (!basis.ok) { flashToast(basis.reason, "warn"); return; }
    const statusBase = basis.statusBase;
    const tcv = basis.tcv;
    const aav = basis.aav;
    const minY1 = basis.minY1;
    const rows3 = totalYears === 3;
    const body = $("#fo-slideover-body");
    const loadedN = loadedContractCountForTeam(p.fid);
    if (loadedN >= LOADED_MAX) {
      body.innerHTML =
        '<div class="fo-card-head"><h2 style="margin:0;">Multi-Year Contract — Loaded</h2></div>' +
        '<div class="fo-review-note">⚠ ' + escapeHtml(p.franchise) + " is at the loaded-contract cap (" + loadedN + " of " + LOADED_MAX +
        ", §C2). You can't add another loaded contract — trade or cut a loaded player to free a slot, or use a flat MYAC instead.</div>" +
        '<button class="btn small secondary" id="fo-myacl-cancel">Back</button>';
      $("#fo-myacl-cancel").addEventListener("click", renderSlideoverBody);
      return;
    }
    body.innerHTML =
      '<div class="fo-card-head"><h2 style="margin:0;">Multi-Year Contract (MYAC) — ' + totalYears + "-Year Loaded</h2></div>" +
      '<div class="fo-form-note">TCV <strong>' + fmtUSD(tcv) + "</strong> (= " + fmtUSD(aav) + " × " + totalYears + ") · AAV " + fmtUSD(aav) +
      " · Y1 ≥ " + fmtUSD(minY1) + " (20% TCV) · whole $1,000s, no $0 year. FL if Y1 &gt; AAV, BL if Y1 &lt; AAV. Records as " + statusBase + ". " +
      loadedN + "/" + LOADED_MAX + " loaded used.</div>" +
      '<div class="fo-form-row"><label>Year 1 &nbsp;<input type="number" id="fo-myacl-y1" value="' + aav + '" step="1000" min="1000" style="width:120px;"></label></div>' +
      (rows3 ? '<div class="fo-form-row"><label>Year 2 &nbsp;<input type="number" id="fo-myacl-y2" value="' + aav + '" step="1000" min="1000" style="width:120px;"></label></div>' : "") +
      '<div class="fo-form-row"><span class="lbl">Year ' + totalYears + " (auto)</span> <span class=\"val\" id=\"fo-myacl-last\">" + fmtUSD(tcv - aav - (rows3 ? aav : 0)) + "</span></div>" +
      '<div class="fo-form-note" id="fo-myacl-err" style="color:var(--err); min-height:14px;"></div>' +
      '<div style="margin-top:8px;"><button class="btn small" id="fo-myacl-submit">Submit ' + statusBase + " MYAC</button> " +
      '<button class="btn small secondary" id="fo-myacl-cancel">Cancel</button></div>';
    const readYrs = function () {
      const y1 = safeInt(($("#fo-myacl-y1") || {}).value, 0);
      const y2 = rows3 ? safeInt(($("#fo-myacl-y2") || {}).value, 0) : (tcv - y1);
      const y3 = rows3 ? (tcv - y1 - y2) : 0;
      return rows3 ? [y1, y2, y3] : [y1, y2];
    };
    const validateYrs = function (yrs) { return myacLoadedYearsError(yrs, minY1); };
    const recalc = function () {
      const yrs = readYrs();
      $("#fo-myacl-last").textContent = fmtUSD(yrs[yrs.length - 1]);
      const err = validateYrs(yrs);
      $("#fo-myacl-err").textContent = err;
      $("#fo-myacl-submit").disabled = !!err;
    };
    $("#fo-myacl-y1").addEventListener("input", recalc);
    if (rows3) $("#fo-myacl-y2").addEventListener("input", recalc);
    $("#fo-myacl-cancel").addEventListener("click", renderSlideoverBody);
    $("#fo-myacl-submit").addEventListener("click", function () {
      const yrs = readYrs();
      const err = validateYrs(yrs);
      if (err) { flashToast(err, "err"); return; }
      if (loadedContractCountForTeam(p.fid) >= LOADED_MAX) { flashToast("At the " + LOADED_MAX + "-loaded cap — can't add another.", "err"); return; }
      submitMyacContract(p, totalYears, yrs, statusBase);
    });
    recalc();
  }

  // 2-year LOADED extension form — Y1 stays at current salary (canon
  // §C4: extension AAV bump applies only to future years), Y2 + Y3
  // are split by the owner. Owner enters Y2 and Y3; the form derives
  // the FL/BL suffix from the per-year salary array (canon §C4.3).
  function openExtensionLoadedForm(p, statusBase) {
    const baseFlat = pickExtensionOption(p, 2); // for futureAav reference
    if (!baseFlat) {
      flashToast("No +2Y extension preview available — can't compute loaded variants.", "warn");
      return;
    }
    const futureAav = safeInt(baseFlat.futureAav, 0);
    const extensionTotal = futureAav * 2;       // total $ across Y2 + Y3
    // Canon §C4.3/§C4.6: each extension year must be ≥ 20% of the extension TCV,
    // so Y2 ∈ [20%, 80%] of the total (Y3 = total − Y2 is then ≥ 20% too). CEIL to
    // the next $1K (not round) so the floor never dips below a true 20%.
    const minExtYear = Math.max(1000, Math.ceil(extensionTotal * 0.2 / 1000) * 1000);
    const maxExtY2 = extensionTotal - minExtYear;
    const currentSalary = Math.max(1000, roundToK(safeInt(p.salary, 0)));
    const defaultY2 = futureAav;
    const defaultY3 = futureAav;
    const baseYear = safeInt(SEASON, 0) || new Date().getUTCFullYear();
    const y1S = baseYear, y2S = baseYear + 1, y3S = baseYear + 2;
    const body = $("#fo-slideover-body");
    body.innerHTML = `
      <div class="fo-form">
        <h3 style="margin:0 0 4px;">Extend ${escapeHtml(p.name)} +2Y (Loaded)</h3>
        <div class="fo-form-note">
          <strong>${y1S}</strong> stays at the current salary. The two extension years
          (<strong>${y2S}</strong> + <strong>${y3S}</strong>) total <strong>${fmtUSD(extensionTotal)}</strong> — set ${y2S} and ${y3S} auto-fills.
          Each year must be ≥ <strong>${fmtUSD(minExtYear)}</strong> (20%). Bigger ${y2S} = front-loaded (FL); bigger ${y3S} = back-loaded (BL).
          <em>To change ${y1S}, submit a restructure after the extension.</em>
        </div>
        <div class="fo-form-row"><span class="lbl">${y1S} · current (locked)</span><span class="val">${fmtUSD(currentSalary)}</span></div>
        <div class="fo-form-row"><span class="lbl">${y2S} ($)</span>
          <input type="number" id="fo-extl-y2" step="1000" min="${minExtYear}" max="${maxExtY2}" value="${defaultY2}" class="num" style="background:var(--panel-alt); color:var(--text); border:1px solid var(--border); padding:6px 10px; border-radius:4px;">
        </div>
        <div class="fo-form-row"><span class="lbl">${y3S} (auto-filled)</span><span class="val" id="fo-extl-y3">${fmtUSD(defaultY3)}</span></div>
        <div class="fo-form-row"><span class="lbl">${y2S} + ${y3S} total</span><span class="val" id="fo-extl-sum">${fmtUSD(extensionTotal)}</span></div>
        <div class="fo-form-row"><span class="lbl">Derived status</span><span class="val" id="fo-extl-status">Vet-Ext2</span></div>
        <div class="fo-form-actions">
          <button class="btn secondary" id="fo-extl-cancel">Cancel</button>
          <button class="btn" id="fo-extl-submit">${IS_DRY_RUN ? "Submit (dry-run)" : "Submit Loaded Extension"}</button>
        </div>
      </div>`;
    function recalc() {
      const y2 = safeInt($("#fo-extl-y2").value, 0);
      // Y3 auto-fills so Σ(Y2,Y3) always equals the extension total (Keith
      // 2026-06-04: "make Y3 auto-calc"). Owner only sets Y2.
      const y3 = extensionTotal - y2;
      $("#fo-extl-y3").textContent = fmtUSD(y3);
      $("#fo-extl-sum").textContent = fmtUSD(y2 + y3) + " / " + fmtUSD(extensionTotal);
      // FL/BL suffix per canon §C4.3: front of the extension heavier (Y2 > Y3)
      // = FL; back heavier (Y2 < Y3) = BL; flat (Y2 == Y3) = no suffix.
      let suffix = "";
      if (y2 > y3) suffix = "-FL";
      else if (y2 < y3) suffix = "-BL";
      // Canon §C4.3: each extension year ≥ 20% of the total.
      const below20 = (y2 < minExtYear || y3 < minExtYear);
      const statusEl = $("#fo-extl-status");
      statusEl.textContent = "Vet-Ext2" + suffix + (below20 ? "  ⚠ each year must be ≥ " + fmtUSD(minExtYear) + " (20%)" : "");
      statusEl.style.color = below20 ? "#c0392b" : "";
      const submitBtn = $("#fo-extl-submit");
      if (submitBtn) submitBtn.disabled = below20;
    }
    $("#fo-extl-y2").addEventListener("input", recalc);
    recalc();
    $("#fo-extl-cancel").addEventListener("click", function () { renderSlideoverBody(); });
    $("#fo-extl-submit").addEventListener("click", function () { submitExtensionLoaded(p, baseFlat, currentSalary, extensionTotal, statusBase); });
  }

  async function submitExtensionLoaded(p, baseFlat, currentSalary, extensionTotal, statusBase) {
    const y2 = roundToK(safeInt($("#fo-extl-y2").value, 0));   // whole $1,000s
    const y3 = extensionTotal - y2;   // auto-computed — Σ(Y2,Y3) always equals extensionTotal
    if (y2 % 1000 !== 0 || y3 % 1000 !== 0) {
      flashToast("Each extension year must be a whole $1,000 increment.", "err");
      return;
    }
    // Canon §C4.3/§C4.6: each extension year must be ≥ 20% of the extension TCV.
    const minExtYear = Math.max(1000, Math.ceil(extensionTotal * 0.2 / 1000) * 1000);
    if (y2 < minExtYear || y3 < minExtYear) {
      flashToast("Canon §C4.3: each extension year must be ≥ 20% of the total (" + fmtUSD(minExtYear) + "). Y2=" + fmtUSD(y2) + ", Y3=" + fmtUSD(y3) + ".", "err");
      return;
    }
    const suffix = y2 > y3 ? "-FL" : y2 < y3 ? "-BL" : "";
    const status = (statusBase || "Vet-Ext2") + suffix;
    const tcv = currentSalary + y2 + y3;
    const gtd = guaranteeForContract(tcv, 3);            // §D1 sub-$5K rule (3-yr loaded ext)
    const futureAav = Math.round((y2 + y3) / 2);
    const contractInfo =
      "CL 3" +
      "|TCV " + fmtK(tcv).replace(/\$/, "") +
      "|AAV " + fmtK(currentSalary).replace(/\$/, "") + ", " + fmtK(futureAav).replace(/\$/, "") +
      "|Y1-" + fmtK(currentSalary).replace(/\$/, "") + ", Y2-" + fmtK(y2).replace(/\$/, "") + ", Y3-" + fmtK(y3).replace(/\$/, "") +
      "|GTD: " + fmtK(gtd).replace(/\$/, "");

    const confirmLines = [
      "Confirm +2Y loaded extension for " + p.name + "?",
      "",
      "Status: " + status,
      "Y1: " + fmtUSD(currentSalary) + " (locked)",
      "Y2: " + fmtUSD(y2),
      "Y3: " + fmtUSD(y3),
      "TCV: " + fmtUSD(tcv) + " · GTD: " + fmtUSD(gtd)
    ];
    if (!window.confirm(confirmLines.join("\n"))) return;

    const url = EP_CONTRACT_UPDATE() + "?L=" + encodeURIComponent(LEAGUE_ID) + "&YEAR=" + encodeURIComponent(SEASON);
    const payload = {
      L: LEAGUE_ID, YEAR: SEASON,
      type: "MANUAL_CONTRACT_UPDATE",
      submission_kind: (statusBase && statusBase.indexOf("ERA") >= 0) ? "myac" : "extension",
      dry_run: IS_DRY_RUN ? 1 : 0,
      source: (statusBase && statusBase.indexOf("ERA") >= 0) ? "front-office-v2-myac-loaded-submit" : "front-office-v2-extension-loaded-submit",
      leagueId: LEAGUE_ID, year: SEASON,
      player_id: p.id, player_name: p.name,
      franchise_id: p.fid, franchise_name: p.franchise,
      position: p.positionGroup || p.position,
      salary: currentSalary,             // MFL salary = CURRENT-year (Y1, locked), NOT the first extension year
      contract_year: 3,                  // full new length (Y1 + Y2 + Y3)
      contract_status: status,
      contract_info: contractInfo,
      prior_contract_status: p.type,
      prior_salary: p.salary,
      prior_contract_year: p.years,
      prior_contract_info: p.special,
      acquisition_date: p.acquisitionDate || "",
      acquisition_type: p.acquisitionTypeLabel || "",
      submitted_at_utc: new Date().toISOString(),
      commish_override_flag: commishOverrideFor(p) ? 1 : 0
    };
    try {
      await postContractUpdate(url, payload);
      flashToast((IS_DRY_RUN ? "[DRY-RUN] " : "") + p.name + " loaded +2Y extension submitted (" + status + ").", "ok");
      await loadRosterData(); renderRosterTable(); closeSlideover();
    } catch (e) {
      console.error("[fo] loaded extension failed:", e);
      flashToast("Loaded extension failed: " + (e.message || String(e)), "err");
    }
  }

  function pickExtensionOption(p, years) {
    // Same source priority as renderActionsTab — worker, then synth.
    const opts = effectiveExtensionPreviews(p);
    // For 2yr, prefer Flat (loadedIndicator "NONE") when picking via
    // the +2Y button. FL/BL choice will surface on the Cap Plan tab.
    const sameYears = opts.filter(function (o) {
      const y = safeInt(o.years, 0) || safeInt(o.years_added, 0) || safeInt(o.yearsToAdd, 0) || safeInt(o.length, 0);
      return y === years;
    });
    if (!sameYears.length) return null;
    const flat = sameYears.find(function (o) { return safeStr(o.loadedIndicator).toUpperCase() === "NONE" || !o.loadedIndicator; });
    return flat || sameYears[0];
  }

  function renderExtensionForm(p, opt) {
    const addedY = safeInt(opt.years, 0) || safeInt(opt.years_added, 0) || safeInt(opt.length, 0);
    const status = safeStr(opt.contract_status || opt.contractStatus || opt.status || ("Vet-Ext" + addedY));
    const info   = safeStr(opt.contract_info || opt.contractInfo || opt.info || "");
    // Full season-by-season schedule from the contract_info Y-tokens (1-indexed).
    // NEW LENGTH is the TOTAL contract length (current remaining + added years),
    // not just the years added — e.g. a 1-yr-left player extended +1Y → 2 years.
    const yv = parseContractYearValues(info);
    const yearNums = Object.keys(yv).map(Number).sort(function (a, b) { return a - b; });
    const cl  = safeInt(opt.contractLength || opt.contract_length, 0) || yearNums.length ||
                (Math.max(0, safeInt(p.years, 0)) + addedY);
    const tcv = safeInt(opt.tcv, 0) || yearNums.reduce(function (s, n) { return s + (yv[n] || 0); }, 0);
    const baseYear = safeInt(SEASON, 0) || new Date().getUTCFullYear();
    const schedule = (yearNums.length ? yearNums : [1]).map(function (n) {
      const season = baseYear + (n - 1);
      return '<div class="fo-form-row"><span class="lbl">' + season + (n === 1 ? " (current)" : "") +
             '</span><span class="val">' + (yv[n] != null ? fmtK(yv[n]) : "—") + "</span></div>";
    }).join("");
    return `
      <div class="fo-form">
        <h3 style="margin:0 0 4px;">Extend ${escapeHtml(p.name)} · +${addedY}Y</h3>
        <div class="fo-form-note">
          Confirm the extension terms below. ${IS_DRY_RUN
            ? "<strong style='color:var(--dryrun);'>Dry-run mode is ON</strong> — this will NOT write to MFL."
            : "This will POST to <code>/commish-contract-update</code> and write to MFL."}
        </div>
        <div class="fo-form-row"><span class="lbl">New status</span><span class="val">${escapeHtml(status)}</span></div>
        <div class="fo-form-row"><span class="lbl">New length</span><span class="val">${cl} year${cl === 1 ? "" : "s"}</span></div>
        <div class="fo-form-row"><span class="lbl">TCV (total)</span><span class="val">${fmtK(tcv)}</span></div>
        <div style="margin:10px 0 2px; font-weight:700; color:var(--muted); font-size:11px; text-transform:uppercase; letter-spacing:0.4px;">Salary by season</div>
        ${schedule}
        <div class="fo-form-note" style="margin-top:6px;"><em>${baseYear} stays at the current salary — to change it, submit a restructure after the extension.</em></div>
        <div class="fo-form-row" style="margin-top:6px;"><span class="lbl">Contract info</span><span class="val">${escapeHtml(info || "—")}</span></div>
        <div class="fo-form-actions">
          <button class="btn secondary" id="fo-ext-cancel">Cancel</button>
          <button class="btn" id="fo-ext-submit">${IS_DRY_RUN ? "Submit (dry-run)" : "Submit Extension"}</button>
        </div>
      </div>`;
  }

  // submitExtension — mirrors submitExtensionUpdate at
  // roster_workbench.js:11021 (post-LaPorta fix: contract_year carries
  // the FULL extension length, NOT length-1).
  async function submitExtension(p, opt) {
    const btn = $("#fo-ext-submit");
    btn.disabled = true; btn.textContent = "Submitting…";

    const yrs = safeInt(opt.years_added, 0) || safeInt(opt.years, 0) || safeInt(opt.length, 0);   // years ADDED (1 or 2)
    // contract_year (MFL cy = years remaining) is the FULL new contract length,
    // NOT the years added. `yrs` above is the ADDED count (used for the status
    // fallback + toast); the full length is carried on opt.contractLength (fallback
    // = current years remaining + added). Sending `yrs` shipped cy=1 for a
    // 1yr→2yr extension (Hurts must be cy 2, not 1).
    const fullLength = safeInt(opt.contractLength, 0) || safeInt(opt.contract_length, 0) ||
                       (Math.max(0, safeInt(p.years, 0)) + yrs);
    const salary = roundToK(safeInt(opt.salary, 0) || safeInt(opt.year1_salary, 0));  // whole $1,000s
    const status = safeStr(opt.contract_status || opt.status || ("Vet-Ext" + yrs));
    const info   = safeStr(opt.contract_info || opt.info || "");
    const me = STATE.me || {};
    const commishOverride = !!me.isAdmin && me.franchise_id !== p.fid;

    const payload = {
      type: "MANUAL_CONTRACT_UPDATE",
      submission_kind: opt.submission_kind || "extension",
      league_id: LEAGUE_ID,
      season: SEASON,
      franchise_id: p.fid,
      player_id: p.id,
      player_name: p.name,                // store the name so the revert list isn't a bare id
      position: p.positionGroup || p.position,
      salary: salary,
      contract_year: fullLength,          // FULL new length (MFL cy = years remaining), post-LaPorta
      contract_status: status,
      contract_info: info,
      prior_salary: p.salary,
      prior_contract_year: p.years,
      prior_contract_status: p.type,
      prior_contract_info: p.special,
      acquisition_date: p.acquisitionDate || "",
      acquisition_type: p.acquisitionTypeLabel || "",
      commish_override_flag: commishOverride ? 1 : 0,
      source: "front-office-v2-extension-submit"
    };
    if (IS_DRY_RUN) payload.dry_run = 1;

    try {
      const url = EP_CONTRACT_UPDATE() +
        "?L=" + encodeURIComponent(LEAGUE_ID) +
        "&YEAR=" + encodeURIComponent(SEASON);
      await postContractUpdate(url, payload);
      flashToast(
        (IS_DRY_RUN ? "[DRY-RUN] " : "") + "Extension submitted for " + p.name + " (+" + yrs + "Y).",
        "ok"
      );
      await loadRosterData(); renderRosterTable(); closeSlideover();
    } catch (e) {
      console.error("[fo] extension submit failed:", e);
      btn.disabled = false; btn.textContent = IS_DRY_RUN ? "Submit (dry-run)" : "Submit Extension";
      flashToast("Extension submit failed: " + (e.message || String(e)), "err");
    }
  }

  // ══════════════════════════════════════════════════════════════════
  // CAP PLAN TAB
  // ══════════════════════════════════════════════════════════════════
  //
  // Projects each player's salary across SEASON / SEASON+1 / SEASON+2
  // using their contractYearValueMap (CL/Y1-Y2-Y3 tokens). For
  // extension-eligible players (cy=1) we surface a "+Ext" delta —
  // the best 1Y or 2Y extension chosen from effectiveExtensionPreviews.
  //
  // Cap rules honored (canon §6):
  //   • Taxi off-cap entirely (§6.E)
  //   • IR gets 50% relief (§6.C)
  //   • Expired contracts (years≤0) contribute $0
  //   • $300K ceiling shown as informational reference

  const CAP_CEILING = 300000;
  const CAP_FLOOR   = 260000;

  // ── Restructure preview (§C5) — Cap Planning only ──────────────────
  //
  // Planning-view scaffolding around the EXISTING restructure. It computes
  // nothing about contract shape: the commit path is submitRestructure(),
  // which owns validation, the AAV/GTD/TCV tokens, the FL/BL suffix, the
  // confirm and the POST. Everything here only decides which numbers the
  // Cap Detail grid may show.
  //
  // 🔒 Rule: never render a cap number we didn't compute from real contract
  // data. `capRestructureRealYears` reads the contract's own Y-tokens and
  // NOTHING else — no player.salary fallback, no AAV/TCV averaging (that's
  // what contractYearValueMapForPlayer does via contractYearFallbackValue,
  // and a manufactured year salary presented as a projection is worse than
  // no editor). Unresolvable → ok:false → the control is disabled with the
  // reason in its tooltip.

  function capPreviewKey(p) { return safeStr(p && p.id) + ":" + safeStr(p && p.fid); }
  function clearCapRestructureDraft(key) { delete STATE.capRestructureDrafts[key]; }
  function clearCapMyacLoadedDraft(key) { delete STATE.capMyacLoadedDrafts[key]; }

  function capRestructureRealYears(p) {
    const out = { ok: false, reason: "", years: 0, startIdx: 0, amounts: [], tcv: 0, minY1: 0 };
    if (!p) { out.reason = "No player."; return out; }
    const years = Math.max(0, safeInt(p.years, 0));
    out.years = years;
    if (years < 2) { out.reason = "Needs 2+ contract years remaining to redistribute."; return out; }
    // Explicit Y-tokens ONLY (parseContractYearValues), never the derived map.
    const yv = parseContractYearValues(p.special);
    if (!Object.keys(yv).length) {
      out.reason = "This contract carries no per-year (Y1-… ) salary tokens, so its remaining-year salaries can't be read from the contract — nothing to redistribute without inventing numbers.";
      return out;
    }
    const len = contractLengthForPlayer(p);
    const startIdx = contractYearIndexForPlayer(p);
    out.startIdx = startIdx;
    if (startIdx <= 0 || startIdx + years - 1 > len) {
      out.reason = "Contract length (CL " + len + ") and years remaining (" + years + ") disagree — can't tell which years are still owed.";
      return out;
    }
    const amounts = [];
    for (let i = startIdx; i < startIdx + years; i += 1) {
      const v = safeInt(yv[i], 0);
      if (v <= 0) {
        out.reason = "No Y" + i + " salary token on this contract — the remaining-year salaries are incomplete.";
        return out;
      }
      amounts.push(v);
    }
    const tcv = totalContractValueForPlayer(p);
    if (tcv <= 0) { out.reason = "No readable TCV on this contract."; return out; }
    // submitRestructure requires Σ(remaining years) === TCV. When the contract's
    // OWN remaining-year salaries don't already total the TCV (typically a
    // mid-contract deal whose TCV token still covers earned years), there is no
    // neutral draft: every committable draft would have to invent money the
    // player isn't owed. Decline the editor rather than nudge an owner into a
    // cap-inflating submit — the Contracts sub-tab form is unchanged and still
    // reachable for anyone who genuinely needs it.
    const owed = amounts.reduce(function (a, b) { return a + b; }, 0);
    if (owed !== tcv) {
      out.reason = "The remaining years total " + fmtUSD(owed) + " but this contract's TCV token reads " +
        fmtUSD(tcv) + " (a restructure must re-slot the TCV exactly), so there's no honest way to " +
        "re-slot it from here — check the contract in the Contracts tab.";
      return out;
    }
    out.ok = true;
    out.amounts = amounts;
    out.tcv = tcv;
    // §C5 floor, mirrored from openRestructureForm. A THRESHOLD, not a rendered
    // cap number — `ok` above already records whether the year salaries were
    // genuinely resolved, so this Math.max can't launder a made-up projection.
    out.minY1 = Math.max(1000, Math.ceil(tcv * 0.20 / 1000) * 1000);
    return out;
  }

  // Full state of a row's restructure preview: the real remaining years, the
  // current draft, and whether that draft may be projected / committed.
  //   coherent — the draft is arithmetically the same money submitRestructure
  //              re-slots (whole $1,000s, Σ = TCV). ONLY a coherent draft is
  //              allowed to replace the real numbers in the grid.
  //   legal    — additionally clears the §C5 floors submitRestructure enforces
  //              (Y1 ≥ 20% TCV, no year under $1,000). Gates Commit.
  function capRestructureEval(p) {
    const key = capPreviewKey(p);
    const real = capRestructureRealYears(p);
    const out = {
      key: key, ok: real.ok, reason: real.reason, years: real.years,
      tcv: real.tcv, minY1: real.minY1,
      real: real.amounts.slice(), amounts: real.amounts.slice(),
      sum: 0, left: 0, dirty: false, coherent: false, legal: false, err: ""
    };
    if (!real.ok) return out;
    const draft = STATE.capRestructureDrafts[key];
    if (draft && Array.isArray(draft.amounts) && draft.amounts.length === real.years) {
      out.amounts = draft.amounts.map(function (v) { return Math.max(0, safeInt(v, 0)); });
    }
    out.sum = out.amounts.reduce(function (a, b) { return a + b; }, 0);
    out.left = real.tcv - out.sum;
    out.dirty = out.amounts.some(function (v, i) { return v !== out.real[i]; });
    const wholeK = out.amounts.every(function (v) { return v % 1000 === 0; });
    out.coherent = wholeK && out.sum === real.tcv;
    if (!wholeK) out.err = "Whole $1,000s only.";
    else if (out.sum !== real.tcv) {
      out.err = (out.left > 0 ? fmtUSD(out.left) + " left to allocate." : fmtUSD(-out.left) + " over the required total.");
    } else if (out.amounts[0] < real.minY1) {
      out.err = "Year 1 must be ≥ " + fmtUSD(real.minY1) + " (20% of TCV).";
    } else if (out.amounts.some(function (v) { return v < 1000; })) {
      out.err = "No year can be under $1,000 — there are no $0 years.";
    }
    out.legal = out.coherent && !out.err;
    // A valid-but-UNCHANGED draft must never be submittable. Opening the editor
    // seeds the contract's own years, so without this the owner can click Restr
    // to look at a shape and then Commit a no-op — and a no-op restructure is
    // NOT harmless: submitRestructure sees y1 === the prior current-year salary,
    // reads that as "flat", and writes a contractStatus with the -FL/-BL suffix
    // STRIPPED. Hurts (Vet-Ext2-BL, 47/53/53) would come back Vet-Ext2 while his
    // year shape is still back-loaded — which frees a slot under the 5-loaded
    // cap (isLoadedRow keys off that suffix), burns one of the 3 season uses,
    // and rewrites GTD. Commit requires an actual change.
    out.submittable = out.legal && out.dirty;
    return out;
  }

  // Draft amounts to PROJECT for this player, or null when the grid must fall
  // back to the real contract numbers (no draft, unresolvable, or incoherent).
  function capRestructureProjection(p) {
    const ev = capRestructureEval(p);
    return (ev.ok && ev.coherent) ? ev.amounts : null;
  }

  // ── Loaded MYAC preview (§C2) — Cap Planning only ──────────────────
  //
  // Same shape as the restructure preview above, and the same contract: this
  // computes NOTHING about the deal. The basis (TCV / AAV / 20% Y1 floor) comes
  // from myacLoadedBasis — the same function the slide-over loaded-MYAC form
  // uses — and the commit path is submitMyacContract(), which owns the FL/BL
  // suffix, GTD, contractInfo, the confirm and the POST. Everything here only
  // decides which numbers the Cap Detail grid may show.
  //
  // Full state of a row's loaded-MYAC draft:
  //   coherent — whole $1,000s and Σ = TCV, i.e. arithmetically the same money
  //              submitMyacContract would re-slot. ONLY a coherent draft may
  //              replace real numbers in the grid.
  //   legal    — additionally clears the §C2 floors (Y1 ≥ 20% TCV, no year
  //              under $1,000) that submitMyacContract re-checks.
  //   dirty    — the draft is actually LOADED (some year ≠ Y1). A flat draft is
  //              not a loaded contract: submitMyacContract would derive
  //              loaded=false and write a bare Vet-FAA / Vet-ERA, which is what
  //              the MYAC2 / MYAC3 buttons already do. Committing it from the
  //              loaded editor would burn the one-shot conversion on a deal the
  //              owner did not shape, and would consume none of the 5 loaded
  //              slots this editor is warning about — so Commit requires a real
  //              loaded shape, not merely a valid one.
  function capMyacLoadedEval(p, totalYears) {
    const key = capPreviewKey(p);
    const basis = myacLoadedBasis(p, totalYears);
    const out = {
      key: key, kind: "myacl" + totalYears, ok: basis.ok, reason: basis.reason,
      years: totalYears, tcv: basis.tcv, aav: basis.aav, minY1: basis.minY1,
      statusBase: basis.statusBase, flat: [], amounts: [],
      sum: 0, left: 0, loadedShape: false, suffix: "", dirty: false,
      coherent: false, legal: false, err: "",
      loadedNow: 0, atLoadedCap: false, submittable: false
    };
    if (!basis.ok) return out;
    // Neutral seed = the FLAT split (AAV every year). Totals don't budge until
    // the owner actually moves money, exactly like the restructure editor.
    for (let i = 0; i < totalYears; i += 1) out.flat.push(basis.aav);
    out.amounts = out.flat.slice();
    const draft = STATE.capMyacLoadedDrafts[key];
    if (draft && draft.kind === out.kind && Array.isArray(draft.amounts) && draft.amounts.length === totalYears) {
      out.amounts = draft.amounts.map(function (v) { return Math.max(0, safeInt(v, 0)); });
    }
    out.sum = out.amounts.reduce(function (a, b) { return a + b; }, 0);
    out.left = basis.tcv - out.sum;
    const wholeK = out.amounts.every(function (v) { return v % 1000 === 0; });
    out.coherent = wholeK && out.sum === basis.tcv;
    if (!wholeK) out.err = "Whole $1,000s only.";
    else if (out.sum !== basis.tcv) {
      out.err = (out.left > 0 ? fmtUSD(out.left) + " left to allocate." : fmtUSD(-out.left) + " over the required total.");
    } else {
      out.err = myacLoadedYearsError(out.amounts, basis.minY1);
    }
    out.legal = out.coherent && !out.err;
    // MIRROR of submitMyacContract's own derivation (front_office.js, the
    // `loaded` / `-FL` / `-BL` lines) so the editor can name the shape the
    // owner is building. That function stays the authority — it re-derives the
    // status from the submitted year array and shows it in the confirm dialog
    // before anything is written, so this label can never smuggle a wrong
    // status past the owner.
    out.loadedShape = out.amounts.some(function (v) { return v !== out.amounts[0]; });
    out.suffix = out.loadedShape ? (out.amounts[0] > basis.aav ? "-FL" : "-BL") : "";
    out.dirty = out.loadedShape;
    // §C2 roster cap on loaded contracts. Surfaced as information on every
    // draft; it only gates Commit (previewing a 6th loaded shape is legitimate
    // planning — you may be about to cut or trade one of the five).
    out.loadedNow = loadedContractCountForTeam(p.fid);
    out.atLoadedCap = out.loadedNow >= LOADED_MAX;
    out.submittable = out.legal && out.dirty && !out.atLoadedCap;
    return out;
  }

  // Draft amounts to PROJECT, or null when the grid must fall back to the real
  // contract numbers (no loaded preview, unresolvable basis, incoherent draft).
  function capMyacLoadedProjection(p, preview) {
    if (preview !== "myacl2" && preview !== "myacl3") return null;
    const ev = capMyacLoadedEval(p, preview === "myacl3" ? 3 : 2);
    return (ev.ok && ev.coherent) ? ev.amounts : null;
  }

  // For a single player, return the projected cap hit for year offset
  // (0 = current season, 1 = next, 2 = year after). Honors active
  // preview state (ext1 / ext2 / drop / restructure) from STATE.capPreviews;
  // pass ignorePreview=true to get the untouched real projection (used to
  // annotate "was $X" on previewed money cells).
  // Canon: taxi=$0 (§6.E), IR×0.5 (§6.C), expired=$0.
  function projectedPlayerCapForOffset(p, offset, ignorePreview) {
    if (!p) return 0;
    const preview = ignorePreview ? null : (STATE.capPreviews[p.id + ":" + p.fid] || null);

    // ── Drop preview ─────────────────────────────────────────────
    // The cut player contributes NO salary to ANY year. The dead-cap penalty is
    // surfaced as a CAP ADJUSTMENT in the Cap Detail totals (renderCapDetailBody),
    // not as a salary line (Keith 2026-06-07: "a drop penalty should apply to the
    // cap adjustment, not against salary").
    if (preview === "drop") return 0;

    // ── Promote preview (taxi → active) ──────────────────────────
    // Player comes off taxi onto the active roster. Their normal
    // year-by-year contract salary now counts against the cap.
    // Lets owners see what activating a taxi rookie would cost.
    // Must run BEFORE the isTaxi early-return below.
    if (preview === "promote") {
      const length = contractLengthForPlayer(p);
      const currentIdx = contractYearIndexForPlayer(p);
      const targetIdx = currentIdx + offset;
      if (targetIdx <= 0 || targetIdx > length) return 0;
      const yv = contractYearValueMapForPlayer(p);
      return safeInt(yv[targetIdx], 0) || safeInt(p.salary, 0);
    }

    if (p.isTaxi) return 0;

    // Base year-by-year contract projection (current contract only).
    const yrsRemaining = Math.max(0, safeInt(p.years, 0));
    let baseAmt = 0;
    if (yrsRemaining > 0 && offset < yrsRemaining) {
      const length = contractLengthForPlayer(p);
      const currentIdx = contractYearIndexForPlayer(p);
      const targetIdx = currentIdx + offset;
      if (targetIdx > 0 && targetIdx <= length) {
        const yv = contractYearValueMapForPlayer(p);
        baseAmt = safeInt(yv[targetIdx], 0) || safeInt(p.salary, 0);
      }
    }

    // ── Extension preview overlay ────────────────────────────────
    if ((preview === "ext1" || preview === "ext2") && offset > 0) {
      const ext = extensionAddByKind(p, preview);
      if (offset === 1) baseAmt = ext.add1;
      else if (offset === 2) baseAmt = ext.add2;
    }

    // ── MYAC preview overlay — FLAT (myac2 / myac3) ──────────────
    // An auction-won 1-yr default → flat 2/3-yr at the auction salary. A FLAT
    // MYAC leaves Year 1 alone (it stays the auction salary), which is exactly
    // why this branch fires only for offset > 0.
    if ((preview === "myac2" || preview === "myac3") && offset > 0) {
      const extraYears = preview === "myac3" ? 2 : 1;   // years beyond Y+0
      baseAmt = offset <= extraYears ? safeInt(p.salary, 0) : 0;
    }

    // ── MYAC preview overlay — LOADED (myacl2 / myacl3, §C2) ─────
    // Loaded shapes were deferred in 2026-06 ("show MYAC previews, don't worry
    // about loaded"); that deferral is now reversed — this is the drafted
    // front/back-loaded split from the inline Cap Planning editor.
    //
    // Unlike the flat branch above, this MUST cover offset 0. Loading
    // redistributes the SAME TCV across every year of the new deal, Year 1
    // included: front-loading lifts Year 1 above the auction salary,
    // back-loading drops it toward the 20%-of-TCV floor. Leaving offset 0 at
    // the untouched auction salary would hold the current-year number still —
    // the single number the owner is deliberately moving — while the out-years
    // changed underneath it.
    //
    // Sits HERE (after the taxi early-return, before the IR branch) for the
    // same reason the restructure overlay does: taxi still projects $0, and IR
    // still takes its 50% relief on the DRAFTED Year 1. Offsets past the end of
    // the new deal are $0 — the contract has expired by then.
    // capMyacLoadedProjection returns null for an unresolvable basis or an
    // incoherent draft, leaving baseAmt real.
    if (preview === "myacl2" || preview === "myacl3") {
      const mlAmts = capMyacLoadedProjection(p, preview);
      if (mlAmts) baseAmt = offset < mlAmts.length ? safeInt(mlAmts[offset], 0) : 0;
    }

    // ── Restructure preview overlay (§C5) ────────────────────────
    // The drafted per-year salary replaces the contract's real year map for
    // every remaining year — that's the whole mechanism by which the editor
    // reaches the year totals, the adjustment callout and the cap %; nothing
    // else is wired. Sits HERE (after the taxi early-return, before the IR
    // branch) so taxi still projects $0 and IR still takes its 50% relief on
    // the drafted Y1. capRestructureProjection returns null for an
    // unresolvable contract or an incoherent draft, leaving baseAmt real.
    if (preview === "restructure") {
      const rsAmts = capRestructureProjection(p);
      if (rsAmts) baseAmt = offset < rsAmts.length ? safeInt(rsAmts[offset], 0) : 0;
    }

    if (p.isIr && offset === 0) return Math.round(baseAmt * 0.5);
    return baseAmt;
  }

  // ══════════════════════════════════════════════════════════════════
  // ROSTER-RULE COUNTERS (§B1 / §C2) — PREVIEW-AWARE
  // ══════════════════════════════════════════════════════════════════
  //
  // Cap Planning shows what a plan COSTS. These show what it does to the roster
  // RULES — the 5-loaded cap, the 6 three-year deals, the 27–35 active / 10 taxi
  // limits — and they move as previews are built, not only on the committed
  // roster. Everything here reads the SAME STATE.capPreviews + drafts that
  // projectedPlayerCapForOffset reads, so a plan can never look legal on the
  // dollars and illegal on the rules (or the reverse).
  //
  // 🔒 Only a COHERENT draft is projected — exactly the rule the money grid
  // uses. A half-typed restructure / loaded-MYAC leaves these counters on the
  // real contract, matching the editor's own "Draft not applied — the grid above
  // is showing the real contract".
  //
  // 🔒 Nothing here writes. These are read-only derivations of state the owner
  // already built by clicking preview buttons.

  // The contract SHAPE the §C2 counters must read for one row: committed, or
  // what the active preview would make it.
  //   counts  — is there a contract at all (expired / dropped rows count nowhere)
  //   loaded  — would it carry the -FL/-BL suffix isLoadedRow keys off
  //   years   — years remaining under the projected deal
  //   rookie  — rookie-family contract (excluded from the 3-year count, §C2)
  //   note    — a preview is active but its basis wouldn't read, so the REAL
  //             contract was counted; surfaced in the UI rather than swallowed.
  function capCounterShapeForPlayer(p) {
    const committed = {
      basis: "committed",
      counts: !capContractIsExpired(p),
      loaded: isLoadedRow(p),
      years: Math.max(0, safeInt(p && p.years, 0)),
      rookie: ctypeClass(p && p.type).split(" ")[0] === "rk",
      note: ""
    };
    if (!p) return committed;
    const preview = STATE.capPreviews[capPreviewKey(p)] || "";
    if (!preview) return committed;
    const unresolved = function (why) {
      return { basis: "committed", counts: committed.counts, loaded: committed.loaded,
               years: committed.years, rookie: committed.rookie, note: safeStr(why) };
    };

    // DROP — a cut player holds no contract. Out of both counters entirely.
    if (preview === "drop") {
      return { basis: "drop", counts: false, loaded: false, years: 0, rookie: committed.rookie, note: "" };
    }
    // PROMOTE — moves a roster bucket (taxi → active), not a contract. The
    // shape, its length and its FL/BL suffix are all untouched.
    if (preview === "promote") {
      return { basis: "promote", counts: committed.counts, loaded: committed.loaded,
               years: committed.years, rookie: committed.rookie, note: "" };
    }
    // FLAT MYAC (§C2) — an even split records as Vet-FAA / Vet-ERA with NO
    // -FL/-BL suffix (submitMyacContract derives loaded=false from the year
    // array), for `n` years. So it adds a 3-year deal but never a loaded one.
    if (preview === "myac2" || preview === "myac3") {
      const n = preview === "myac3" ? 3 : 2;
      const basis = myacLoadedBasis(p, n);
      if (!basis.ok) return unresolved(basis.reason);
      return { basis: preview, counts: true, loaded: false, years: n, rookie: false, note: "" };
    }
    // LOADED MYAC (§C2) — the evaluator already derives the RESULTING shape and
    // suffix from the draft (ev.loadedShape / ev.suffix, mirrored from
    // submitMyacContract), so nothing is re-derived here.
    if (preview === "myacl2" || preview === "myacl3") {
      const n = preview === "myacl3" ? 3 : 2;
      const ev = capMyacLoadedEval(p, n);
      if (!ev.ok) return unresolved(ev.reason);
      if (!ev.coherent) return unresolved("loaded-MYAC draft isn’t balanced yet — counting the real contract.");
      return { basis: preview, counts: true, loaded: !!ev.loadedShape, years: n, rookie: false, note: "" };
    }
    // RESTRUCTURE (§C5) — same years, possibly a different SHAPE, so it can add
    // a loaded contract (flat → loaded) or free one (loaded → flat).
    // submitRestructure sets the suffix from the new Y1 vs the PRE-restructure
    // current-year salary: equal → flat (suffix stripped), higher → -FL, lower
    // → -BL. ev.real[0] IS that prior current-year salary (capRestructureRealYears
    // reads the Y-token at contractYearIndexForPlayer, the same basis
    // currentContractYearValue gives submitRestructure), so this mirrors the
    // write path instead of inventing a second rule.
    if (preview === "restructure") {
      const ev = capRestructureEval(p);
      if (!ev.ok) return unresolved(ev.reason);
      if (!ev.coherent) return unresolved("restructure draft isn’t balanced yet — counting the real contract.");
      // Only a draft that actually MOVED money can change the loaded state.
      // Opening the editor seeds it with the contract's own remaining-year
      // salaries, so an untouched draft is coherent with amounts === real —
      // and reading that as "Y1 unchanged ⇒ suffix stripped ⇒ not loaded" made
      // merely LOOKING at a loaded contract free a §C2 slot. A team at 5/5 read
      // 5 → 4 and could be talked into drafting a sixth loaded shape, against
      // an outcome that was never drafted and isn't even submittable
      // (submittable = legal && dirty). Undrafted ⇒ the committed state stands.
      return { basis: "restructure", counts: true,
               loaded: ev.dirty ? (ev.amounts[0] !== ev.real[0]) : committed.loaded,
               years: committed.years, rookie: committed.rookie, note: "" };
    }
    // EXTENSION (§C4) — adds years onto the current deal. extensionAddByKind
    // picks the FLAT option explicitly, so the preview creates no loaded
    // contract; whether an extension CLEARS an existing -FL/-BL is not something
    // this screen can determine from the data it has, so the committed loaded
    // state is carried through UNTOUCHED rather than guessed at. Same for the
    // rookie/veteran family: the resulting contract type isn't derivable here.
    if (preview === "ext1" || preview === "ext2") {
      const ext = extensionAddByKind(p, preview);
      if (safeInt(ext.add1, 0) <= 0) {
        return unresolved("no flat " + (preview === "ext2" ? "2" : "1") + "-year extension option resolves for this player.");
      }
      return { basis: preview, counts: true, loaded: committed.loaded,
               years: committed.years + (preview === "ext2" ? 2 : 1), rookie: committed.rookie, note: "" };
    }
    return committed;
  }

  // Team-wide §C2 counters: committed vs what the active previews would make it.
  // These are LEAGUE LIMITS on the whole roster, so they deliberately ignore the
  // Detail pos/years/status filters — a filtered "3 of 5 loaded" would read as
  // headroom that isn't there.
  function capRosterRuleCounts(team) {
    const out = { loadedNow: 0, loadedNext: 0, threeNow: 0, threeNext: 0, unresolved: [] };
    ((team && team.players) || []).forEach(function (p) {
      // Committed baseline — the exact tests the hub's counters use
      // (isLoadedRow for the suffix; 3 years remaining and NOT a rookie deal,
      // canon §C2 "excludes rookie 3-year deals").
      if (!capContractIsExpired(p)) {
        if (isLoadedRow(p)) out.loadedNow += 1;
        if (Math.max(0, safeInt(p.years, 0)) === 3 && ctypeClass(p.type).split(" ")[0] !== "rk") out.threeNow += 1;
      }
      const shape = capCounterShapeForPlayer(p);
      if (shape.counts) {
        if (shape.loaded) out.loadedNext += 1;
        if (shape.years === 3 && !shape.rookie) out.threeNext += 1;
      }
      if (shape.note) out.unresolved.push({ name: safeStr(p.name), why: shape.note });
    });
    return out;
  }

  // Roster PRESENCE at a year offset — the headcount twin of
  // projectedPlayerCapForOffset, branch for branch, so the counts and the
  // dollars can never disagree. Returns "active" | "taxi" | "" (no contract year
  // there).
  //
  // Money alone can't be the test: a taxi player projects $0 in EVERY year
  // (§6.E) yet still occupies a taxi slot, and a $0 year on a coherent draft is
  // genuinely a year with no player-cost. So this mirrors the same branches and
  // reports the SLOT instead of the dollars.
  function capProjectedRosterSlotForOffset(p, offset) {
    if (!p) return "";
    const preview = STATE.capPreviews[capPreviewKey(p)] || "";

    // DROP — gone from every year (the money grid returns $0 for all offsets).
    if (preview === "drop") return "";

    // PROMOTE — off taxi onto the active roster for every year of the contract.
    // Mirrors the money grid's promote branch, which runs BEFORE the taxi rule
    // and is bounded only by the contract-year index.
    if (preview === "promote") {
      const pl = contractLengthForPlayer(p);
      const pi = contractYearIndexForPlayer(p) + offset;
      return (pi > 0 && pi <= pl) ? "active" : "";
    }
    const slot = p.isTaxi ? "taxi" : "active";

    // Base presence = the money grid's own test: a remaining contract year that
    // lands inside the contract's length.
    //
    // EXCEPT for the CURRENT year, where the roster limit is a BODY count, not a
    // contract count. An expired-contract row — an expired rookie awaiting the
    // ERA, say — is a real player sitting on the active roster right now: canon
    // §B1 counts him against the roster size and MFL will refuse the add that
    // goes over. Dropping him from the headcount made a 30-man roster read
    // "Active 26 / 35" and falsely trip the under-27 flag, disagreeing with the
    // FO hub's own Active card for the same team. He costs $0 and holds a slot —
    // exactly the taxi case this function already exists to handle. Future years
    // are a different question: with no contract there, he is genuinely not on
    // the books, so he only counts at offset 0.
    if (capContractIsExpired(p)) return offset === 0 ? slot : "";
    let present = true;
    if (present) {
      const yrsRemaining = Math.max(0, safeInt(p.years, 0));
      present = yrsRemaining > 0 && offset < yrsRemaining;
      if (present) {
        const len = contractLengthForPlayer(p);
        const idx = contractYearIndexForPlayer(p) + offset;
        present = idx > 0 && idx <= len;
      }
    }

    // EXTENSION — the grid overwrites offsets 1/2 with the flat extension year,
    // so presence follows the same amounts. A $0 amount means the option didn't
    // resolve: no year, and therefore no headcount (never a phantom body).
    if ((preview === "ext1" || preview === "ext2") && offset > 0) {
      const ext = extensionAddByKind(p, preview);
      const add = offset === 1 ? safeInt(ext.add1, 0) : (offset === 2 ? safeInt(ext.add2, 0) : 0);
      present = add > 0;
    }
    // FLAT MYAC — the new deal runs Y+0 … Y+extraYears at the auction salary,
    // which is exactly the span the money grid fills.
    if ((preview === "myac2" || preview === "myac3") && offset > 0) {
      const extraYears = preview === "myac3" ? 2 : 1;
      present = offset <= extraYears && safeInt(p.salary, 0) > 0;
    }
    // LOADED MYAC / RESTRUCTURE — the drafted year array IS the contract. Both
    // projections return null for an unresolvable basis or an incoherent draft,
    // and presence then falls back to the real contract with the money.
    const mlAmts = capMyacLoadedProjection(p, preview);
    if (mlAmts) present = offset < mlAmts.length && safeInt(mlAmts[offset], 0) > 0;
    if (preview === "restructure") {
      const rsAmts = capRestructureProjection(p);
      if (rsAmts) present = offset < rsAmts.length && safeInt(rsAmts[offset], 0) > 0;
    }
    return present ? slot : "";
  }

  // Headcount for one projected year, split by roster bucket.
  //
  // IR: §B1 gives IR its own bucket (canon §B3: no team-side IR limit — MFL's
  // setting is effectively unlimited), so an IR player is NOT part of the
  // 27–35 active count in the CURRENT season — same split the hub summary uses.
  // IR is a current-season designation and does not project forward, so from
  // Y+1 on those players are counted as ACTIVE. The UI says this out loud rather
  // than letting the active number jump between years for no visible reason.
  function capYearRosterCounts(team, offset) {
    const out = { active: 0, taxi: 0, ir: 0 };
    ((team && team.players) || []).forEach(function (p) {
      const slot = capProjectedRosterSlotForOffset(p, offset);
      if (!slot) return;
      if (slot === "taxi") out.taxi += 1;
      else if (offset === 0 && p.isIr) out.ir += 1;
      else out.active += 1;
    });
    return out;
  }

  // Loaded/3-year §C2 headcount for one projected year. Presence reuses the
  // exact same capProjectedRosterSlotForOffset test Active/Taxi use, so a
  // previewed drop/MYAC/extension/restructure moves these numbers too.
  //   Loaded: front/back-loaded describes the WHOLE contract's shape, not one
  //   year of it — so once a contract is loaded, it stays loaded for every
  //   year it's still present. Only presence varies by offset, not the flag.
  //   3-Yr: a years-REMAINING test, so it decrements with the offset exactly
  //   like the presence check itself does — a contract with shape.years=4
  //   today reads as a 3-Yr contract at offset 1, not offset 0.
  function capYearLoadedThreeCounts(team, offset) {
    const out = { loaded: 0, three: 0 };
    ((team && team.players) || []).forEach(function (p) {
      if (!capProjectedRosterSlotForOffset(p, offset)) return;
      const shape = capCounterShapeForPlayer(p);
      if (!shape.counts) return;
      if (shape.loaded) out.loaded += 1;
      if ((shape.years - offset) === 3 && !shape.rookie) out.three += 1;
    });
    return out;
  }

  // For an extension-eligible player, what salary would extension years
  // carry under kind="ext1" or "ext2"? Picks Flat from effective previews.
  function extensionAddByKind(p, kind) {
    const want = kind === "ext2" ? 2 : 1;
    const opts = effectiveExtensionPreviews(p);
    const flat = opts.find(function (o) {
      const y = safeInt(o.years, 0) || safeInt(o.yearsToAdd, 0);
      return y === want && (safeStr(o.loadedIndicator).toUpperCase() === "NONE" || !o.loadedIndicator);
    });
    const fut = safeInt(flat && flat.futureAav, 0);
    if (want === 2) return { add1: fut, add2: fut };
    return { add1: fut, add2: 0 };
  }

  // Aggregate team cap at year offset.
  function teamCapForOffset(team, offset) {
    let total = 0;
    (team.players || []).forEach(function (p) {
      total += projectedPlayerCapForOffset(p, offset);
    });
    return total;
  }

  // Group current-year cap by position bucket for the chart strip.
  function teamCapByPosition(team) {
    const buckets = { QB: 0, RB: 0, WR: 0, TE: 0, IDP: 0, PK: 0, PN: 0 };
    (team.players || []).forEach(function (p) {
      const hit = projectedPlayerCapForOffset(p, 0);
      if (hit <= 0) return;
      const b = posBucket(p.position);
      if (buckets[b] != null) buckets[b] += hit;
      else buckets.IDP += hit;
    });
    return buckets;
  }

  // ── Extensions tab — every extension-eligible player + their §C4 deadline ──
  function renderExtensionsTab() {
    const body = $("#fo-extensions-body");
    const meta = $("#fo-ext-meta");
    if (!body) return;
    const fmtDt = function (d) {
      try { return d.toLocaleDateString("en-US", { timeZone: "America/New_York", year: "numeric", month: "short", day: "numeric" }); }
      catch (_) { return "—"; }
    };
    let rows = [];
    (STATE.teams || []).forEach(function (t) {
      (t.players || []).forEach(function (p) {
        let elig;
        try { elig = rosterContractEligibility(p); } catch (_) { return; }
        if (!elig || !elig.extensionCandidate) return;
        const dl = extensionDeadlineForPlayer(p);
        if (dl.days_until != null && dl.days_until < 0) return; // deadline passed — not eligible
        rows.push({
          pid: safeStr(p.id), fid: safeStr(t.fid),
          name: safeStr(p.name), team: safeStr(t.name) || safeStr(t.fid), pos: safeStr(p.position),
          type: safeStr(p.type), years: safeInt(p.years, 0), salary: safeInt(p.salary, 0),
          deadline_ms: dl.date ? dl.date.getTime() : Infinity,
          deadline_str: dl.date ? fmtDt(dl.date) : "—",
          days_until: dl.days_until == null ? Infinity : dl.days_until,
          basis: dl.basis, in_window: dl.in_window,
        });
      });
    });
    // Team & position filters.
    STATE.extFilter = STATE.extFilter || { team: "", pos: "" };
    const teamOpts = Array.from(new Set(rows.map(function (r) { return r.team; }).filter(Boolean))).sort();
    const posOpts = Array.from(new Set(rows.map(function (r) { return r.pos; }).filter(Boolean))).sort();
    const totalRows = rows.length;
    rows = rows.filter(function (r) {
      return (!STATE.extFilter.team || r.team === STATE.extFilter.team) &&
             (!STATE.extFilter.pos || r.pos === STATE.extFilter.pos);
    });
    if (meta) meta.textContent = rows.length + (rows.length === totalRows ? "" : " of " + totalRows) + " player" + (totalRows === 1 ? "" : "s") + " · " + SEASON;
    STATE.extSort = STATE.extSort || { key: "days_until", dir: 1 };
    const sk = STATE.extSort.key, sd = STATE.extSort.dir;
    rows.sort(function (a, b) {
      const av = a[sk], bv = b[sk];
      if (typeof av === "string") return sd * av.localeCompare(bv);
      return sd * ((av === Infinity ? 9e15 : av) - (bv === Infinity ? 9e15 : bv));
    });
    const selStyle = "background:var(--panel-alt);color:var(--text);border:1px solid var(--border);padding:4px 8px;border-radius:4px;";
    const opt = function (val, label, sel) { return '<option value="' + escapeHtml(val) + '"' + (sel ? " selected" : "") + ">" + escapeHtml(label) + "</option>"; };
    const teamSel = '<select id="fo-ext-team" style="' + selStyle + '">' + opt("", "All teams", !STATE.extFilter.team) +
      teamOpts.map(function (t) { return opt(t, t, STATE.extFilter.team === t); }).join("") + "</select>";
    const posSel = '<select id="fo-ext-pos" style="' + selStyle + '">' + opt("", "All positions", !STATE.extFilter.pos) +
      posOpts.map(function (pp) { return opt(pp, pp, STATE.extFilter.pos === pp); }).join("") + "</select>";
    const clearBtn = (STATE.extFilter.team || STATE.extFilter.pos) ? ' <button type="button" id="fo-ext-clear" class="btn small secondary">Clear</button>' : "";
    const toolbar = '<div class="fo-ext-toolbar" style="display:flex;gap:8px;align-items:center;margin:8px 0;flex-wrap:wrap;">' +
      '<span class="small" style="color:var(--muted);">Filter</span>' + teamSel + posSel + clearBtn + "</div>";
    const hdr = function (key, label, align) {
      const arrow = STATE.extSort.key === key ? (STATE.extSort.dir > 0 ? " ▲" : " ▼") : "";
      return '<th data-extsort="' + key + '" style="cursor:pointer;text-align:' + (align || "left") + ';white-space:nowrap;">' + escapeHtml(label) + arrow + "</th>";
    };
    const trs = rows.map(function (r) {
      const dStr = r.days_until === Infinity ? "—" : r.days_until + "d";
      const dCol = r.days_until === Infinity ? "var(--muted)" : (r.days_until <= 14 ? "#e67e22" : (r.days_until <= 45 ? "#d4a017" : "#1f8a4c"));
      return '<tr data-pid="' + escapeHtml(r.pid) + '" data-fid="' + escapeHtml(r.fid) + '" style="cursor:pointer;" title="Open ' + escapeHtml(r.name) + ' — Actions / Extension">' +
        "<td>" + escapeHtml(r.name) + "</td>" +
        "<td>" + escapeHtml(r.team) + "</td>" +
        "<td>" + escapeHtml(r.pos) + "</td>" +
        '<td class="small">' + escapeHtml(r.type) + "</td>" +
        '<td style="text-align:center;">' + r.years + "</td>" +
        '<td style="text-align:right;">' + escapeHtml(fmtUSD(r.salary)) + "</td>" +
        "<td>" + escapeHtml(r.deadline_str) + "</td>" +
        '<td style="text-align:right;color:' + dCol + ';font-weight:600;">' + dStr + "</td>" +
        '<td class="small" style="color:var(--muted);">' + escapeHtml(r.basis) + (r.in_window ? "" : " · window not open yet") + "</td>" +
        "</tr>";
    }).join("");
    const tableHtml = rows.length
      ? '<div class="fo-table-scroll"><table class="fo-table"><thead><tr>' +
        hdr("name", "Player") + hdr("team", "Team") + hdr("pos", "Pos") + hdr("type", "Type") +
        hdr("years", "Yrs", "center") + hdr("salary", "Salary", "right") + hdr("deadline_ms", "Deadline") +
        hdr("days_until", "Days Left", "right") + hdr("basis", "Window / Basis") +
        "</tr></thead><tbody>" + trs + "</tbody></table></div>"
      : '<div class="fo-table-loading">No players match the current filter.</div>';
    body.innerHTML = toolbar + tableHtml;
    const teamEl = $("#fo-ext-team"); if (teamEl) teamEl.addEventListener("change", function () { STATE.extFilter.team = this.value; renderExtensionsTab(); });
    const posEl = $("#fo-ext-pos"); if (posEl) posEl.addEventListener("change", function () { STATE.extFilter.pos = this.value; renderExtensionsTab(); });
    const clearEl = $("#fo-ext-clear"); if (clearEl) clearEl.addEventListener("click", function () { STATE.extFilter = { team: "", pos: "" }; renderExtensionsTab(); });
    // Click a row → open that player's slide-over (Actions incl. Extension).
    $$("#fo-extensions-body tbody tr").forEach(function (tr) {
      tr.addEventListener("click", function () { if (tr.dataset.pid) openSlideover(tr.dataset.pid, tr.dataset.fid); });
    });
    $$("[data-extsort]", body).forEach(function (th) {
      th.addEventListener("click", function () {
        const k = this.getAttribute("data-extsort");
        if (STATE.extSort.key === k) STATE.extSort.dir *= -1;
        else { STATE.extSort.key = k; STATE.extSort.dir = 1; }
        renderExtensionsTab();
      });
    });
  }

  // ── MID-YEAR MULTI (MYM, §C3) ──────────────────────────────────────────
  // Mirrors the Extensions tab, but for in-season WW/FCFS pickups that can
  // convert to a FLAT 2- or 3-year deal within 14 days of acquisition. Row-click
  // opens the slide-over Actions tab, which surfaces the MYM buttons
  // (mymEligible). Also shows this season's submitted MYMs + the 4/team cap,
  // straight from D1 (/admin/contract-submissions — the single source of truth).
  async function renderMymTab() {
    const body = $("#fo-mym-body");
    const meta = $("#fo-mym-meta");
    if (!body) return;
    // Eligible-now players (inside their 14-day MYM window).
    const elig = [];
    (STATE.teams || []).forEach(function (t) {
      (t.players || []).forEach(function (p) {
        let e; try { e = rosterContractEligibility(p); } catch (_) { return; }
        if (!e || !e.mymEligible) return;
        elig.push({ pid: safeStr(p.id), fid: safeStr(t.fid), name: safeStr(p.name),
          team: safeStr(t.name) || safeStr(t.fid), pos: safeStr(p.position),
          salary: safeInt(p.salary, 0), days: e.mymDaysSinceAcq });
      });
    });
    // This season's submitted MYMs from D1 (kind === "mym"), for the usage cap.
    let subs = [];
    try {
      const data = await fetchJSON(apiUrl("/admin/contract-submissions") + "?L=" + encodeURIComponent(LEAGUE_ID) + "&YEAR=" + encodeURIComponent(SEASON));
      subs = ((data && data.submissions) || []).filter(function (s) { return s.kind === "mym"; });
    } catch (_) {}
    const nameByFid = {};
    (STATE.teams || []).forEach(function (t) { nameByFid[pad4(t.fid)] = t.name; });
    const usage = {};
    subs.forEach(function (s) { const f = pad4(s.franchise_id); usage[f] = (usage[f] || 0) + 1; });
    if (meta) meta.textContent = elig.length + " eligible now · " + subs.length + " MYM" + (subs.length === 1 ? "" : "s") + " this season · " + SEASON;
    const eligHtml = elig.length
      ? '<div class="fo-table-scroll"><table class="fo-table"><thead><tr>' +
        '<th>Player</th><th>Team</th><th>Pos</th><th style="text-align:right;">Salary</th><th style="text-align:right;">MYM Day</th><th></th>' +
        "</tr></thead><tbody>" + elig.map(function (r) {
          return '<tr data-pid="' + escapeHtml(r.pid) + '" data-fid="' + escapeHtml(r.fid) + '" style="cursor:pointer;" title="Open Actions / MYM">' +
            "<td>" + escapeHtml(r.name) + "</td><td>" + escapeHtml(r.team) + "</td><td>" + escapeHtml(r.pos) + "</td>" +
            '<td style="text-align:right;">' + escapeHtml(fmtUSD(r.salary)) + "</td>" +
            '<td style="text-align:right;font-weight:600;color:' + (r.days != null && r.days <= 14 ? "#1f8a4c" : "#e67e22") + ';">' + (r.days != null ? r.days + " / 14" : "—") + "</td>" +
            '<td class="small" style="color:var(--muted);">click → MYM</td></tr>';
        }).join("") + "</tbody></table></div>"
      : '<div class="fo-table-loading">No players are in an active MYM window right now (in-season WW/FCFS pickups, days 1–14). A MYM converts a pickup to a flat 2- or 3-year deal at the same salary (§C3).' +
        (STATE.mymTest ? ' <strong>Test mode on</strong> — open any player’s Actions to exercise the MYM form (submits a dry run).' : "") + "</div>";
    const subRows = subs.slice().sort(function (a, b) { return String(b.submitted_at_utc || "").localeCompare(String(a.submitted_at_utc || "")); }).map(function (s) {
      const f = pad4(s.franchise_id);
      const nm = safeStr(s.player_name) || playerNameById(s.player_id) || safeStr(s.player_id);
      const n = s.new || {};
      return "<tr><td>" + escapeHtml(nameByFid[f] || safeStr(s.franchise_id)) + "</td><td>" + escapeHtml(nm) + "</td>" +
        "<td>" + escapeHtml(safeStr(s.sub_type) || "MYM") + '</td><td style="text-align:center;">' + (s.mym_length || n.contract_year || "") + "yr</td>" +
        '<td style="text-align:right;">' + escapeHtml(fmtUSD(n.per_year || n.salary || 0)) + "/yr</td>" +
        '<td class="small">' + escapeHtml(String(s.submitted_at_utc || "").slice(0, 10)) + "</td></tr>";
    }).join("");
    const usageHtml = Object.keys(usage).length
      ? '<div style="margin:10px 0;display:flex;gap:6px;flex-wrap:wrap;">' + Object.keys(usage).sort().map(function (f) {
          const n = usage[f], cap = 4;
          return '<span class="small" style="padding:2px 8px;border:1px solid var(--border);border-radius:10px;color:' + (n >= cap ? "var(--err)" : "var(--muted)") + ';">' +
            escapeHtml(nameByFid[f] || f) + ": " + n + "/" + cap + "</span>";
        }).join("") + "</div>"
      : "";
    const subsHtml = subs.length
      ? '<h3 style="margin:16px 0 6px;font-size:14px;">Submitted this season</h3>' + usageHtml +
        '<div class="fo-table-scroll"><table class="fo-table"><thead><tr><th>Team</th><th>Player</th><th>Sub-type</th><th style="text-align:center;">Len</th><th style="text-align:right;">Salary</th><th>Date</th></tr></thead><tbody>' +
        subRows + "</tbody></table></div>"
      : "";
    body.innerHTML = '<h3 style="margin:6px 0;font-size:14px;">Eligible now</h3>' + eligHtml + subsHtml;
    $$("#fo-mym-body tbody tr[data-pid]").forEach(function (tr) {
      tr.addEventListener("click", function () { if (tr.dataset.pid) openSlideover(tr.dataset.pid, tr.dataset.fid); });
    });
  }

  // ── AUCTION CONTRACTS (MYAC, §C2) ──────────────────────────────────────
  // Mirrors the Extensions tab, but for fresh auction wins that still need
  // their multi-year contract SET: a 1-yr default (Vet-ERA win or FA-auction
  // Veteran, Vet-FAA) the owner can convert to 2/3 years — flat or loaded —
  // until the September contract deadline. Row-click opens the slide-over
  // Actions tab, which surfaces the MYAC buttons (myacEligible).
  function renderMyacTab() {
    const body = $("#fo-myac-body");
    const meta = $("#fo-myac-meta");
    if (!body) return;
    const fmtDt = function (d) {
      try { return d.toLocaleDateString("en-US", { timeZone: "America/New_York", year: "numeric", month: "short", day: "numeric" }); }
      catch (_) { return "—"; }
    };
    const dlDate = contractDeadlineDateFO();              // Sept contract deadline (league-wide)
    const dlMs = dlDate ? dlDate.getTime() : Infinity;
    const dlStr = dlDate ? fmtDt(dlDate) : "—";
    const daysLeft = dlDate ? Math.ceil((dlMs - Date.now()) / 86400000) : Infinity;
    let rows = [];
    (STATE.teams || []).forEach(function (t) {
      (t.players || []).forEach(function (p) {
        let elig;
        try { elig = rosterContractEligibility(p); } catch (_) { return; }
        if (!elig || !elig.myacEligible) return;          // auction/ladder-eligible 1-yr, before the deadline
        const status = safeStr(p.type).toLowerCase();
        // A pre-season WW/FCFS pickup on the ladder (canon ~379/~785) is
        // NEITHER an ERA win nor an FA-Auction win — labelling it "FA
        // Auction" would claim a waiver pickup was an auction win.
        const entryLabel = elig.preseasonWaiverPickup
          ? "Pre-season WW/FCFS"
          : (status.indexOf("-era") !== -1 ? "ERA win" : "FA Auction");
        rows.push({
          pid: safeStr(p.id), fid: safeStr(t.fid),
          name: safeStr(p.name), team: safeStr(t.name) || safeStr(t.fid), pos: safeStr(p.position),
          type: safeStr(p.type), entry: entryLabel,
          salary: safeInt(p.salary, 0),
        });
      });
    });
    STATE.myacFilter = STATE.myacFilter || { team: "", pos: "", entry: "" };
    const teamOpts = Array.from(new Set(rows.map(function (r) { return r.team; }).filter(Boolean))).sort();
    const posOpts = Array.from(new Set(rows.map(function (r) { return r.pos; }).filter(Boolean))).sort();
    const entryOpts = Array.from(new Set(rows.map(function (r) { return r.entry; }).filter(Boolean))).sort();
    const totalRows = rows.length;
    rows = rows.filter(function (r) {
      return (!STATE.myacFilter.team || r.team === STATE.myacFilter.team) &&
             (!STATE.myacFilter.pos || r.pos === STATE.myacFilter.pos) &&
             (!STATE.myacFilter.entry || r.entry === STATE.myacFilter.entry);
    });
    if (meta) {
      meta.textContent = rows.length + (rows.length === totalRows ? "" : " of " + totalRows) +
        " player" + (totalRows === 1 ? "" : "s") + " · MYAC window " +
        (daysLeft === Infinity ? "open" : (daysLeft < 0 ? "CLOSED" : daysLeft + "d left (" + dlStr + ")")) + " · " + SEASON;
    }
    STATE.myacSort = STATE.myacSort || { key: "salary", dir: -1 };
    const sk = STATE.myacSort.key, sd = STATE.myacSort.dir;
    rows.sort(function (a, b) {
      const av = a[sk], bv = b[sk];
      if (typeof av === "string") return sd * av.localeCompare(bv);
      return sd * ((av || 0) - (bv || 0));
    });
    const selStyle = "background:var(--panel-alt);color:var(--text);border:1px solid var(--border);padding:4px 8px;border-radius:4px;";
    const opt = function (val, label, sel) { return '<option value="' + escapeHtml(val) + '"' + (sel ? " selected" : "") + ">" + escapeHtml(label) + "</option>"; };
    const teamSel = '<select id="fo-myac-team" style="' + selStyle + '">' + opt("", "All teams", !STATE.myacFilter.team) +
      teamOpts.map(function (tt) { return opt(tt, tt, STATE.myacFilter.team === tt); }).join("") + "</select>";
    const posSel = '<select id="fo-myac-pos" style="' + selStyle + '">' + opt("", "All positions", !STATE.myacFilter.pos) +
      posOpts.map(function (pp) { return opt(pp, pp, STATE.myacFilter.pos === pp); }).join("") + "</select>";
    const entrySel = '<select id="fo-myac-entry" style="' + selStyle + '">' + opt("", "All auction types", !STATE.myacFilter.entry) +
      entryOpts.map(function (e) { return opt(e, e, STATE.myacFilter.entry === e); }).join("") + "</select>";
    const clearBtn = (STATE.myacFilter.team || STATE.myacFilter.pos || STATE.myacFilter.entry) ? ' <button type="button" id="fo-myac-clear" class="btn small secondary">Clear</button>' : "";
    const toolbar = '<div class="fo-ext-toolbar" style="display:flex;gap:8px;align-items:center;margin:8px 0;flex-wrap:wrap;">' +
      '<span class="small" style="color:var(--muted);">Filter</span>' + teamSel + posSel + entrySel + clearBtn + "</div>";
    const hdr = function (key, label, align) {
      const arrow = STATE.myacSort.key === key ? (STATE.myacSort.dir > 0 ? " ▲" : " ▼") : "";
      return '<th data-myacsort="' + key + '" style="cursor:pointer;text-align:' + (align || "left") + ';white-space:nowrap;">' + escapeHtml(label) + arrow + "</th>";
    };
    const dCol = daysLeft === Infinity ? "var(--muted)" : (daysLeft <= 14 ? "#e67e22" : (daysLeft <= 45 ? "#d4a017" : "#1f8a4c"));
    const dStr = daysLeft === Infinity ? "open" : (daysLeft < 0 ? "closed" : daysLeft + "d");
    const trs = rows.map(function (r) {
      return '<tr data-pid="' + escapeHtml(r.pid) + '" data-fid="' + escapeHtml(r.fid) + '" style="cursor:pointer;" title="Open ' + escapeHtml(r.name) + ' — Actions / Auction Contract">' +
        "<td>" + escapeHtml(r.name) + "</td>" +
        "<td>" + escapeHtml(r.team) + "</td>" +
        "<td>" + escapeHtml(r.pos) + "</td>" +
        '<td class="small">' + escapeHtml(r.type) + "</td>" +
        '<td class="small">' + escapeHtml(r.entry) + "</td>" +
        '<td style="text-align:right;">' + escapeHtml(fmtUSD(r.salary)) + "</td>" +
        "<td>" + escapeHtml(dlStr) + "</td>" +
        '<td style="text-align:right;color:' + dCol + ';font-weight:600;">' + dStr + "</td>" +
        "</tr>";
    }).join("");
    const tableHtml = rows.length
      ? '<div class="fo-table-scroll"><table class="fo-table"><thead><tr>' +
        hdr("name", "Player") + hdr("team", "Team") + hdr("pos", "Pos") + hdr("type", "Type") +
        hdr("entry", "Auction Type") + hdr("salary", "Auction $", "right") +
        '<th>Deadline</th><th style="text-align:right;">Days Left</th>' +
        "</tr></thead><tbody>" + trs + "</tbody></table></div>"
      : '<div class="fo-table-loading">No players need an auction contract' + (daysLeft < 0 ? " (MYAC window closed)" : " right now") + '.</div>';
    body.innerHTML = toolbar + tableHtml;
    const teamEl = $("#fo-myac-team"); if (teamEl) teamEl.addEventListener("change", function () { STATE.myacFilter.team = this.value; renderMyacTab(); });
    const posEl = $("#fo-myac-pos"); if (posEl) posEl.addEventListener("change", function () { STATE.myacFilter.pos = this.value; renderMyacTab(); });
    const entryEl = $("#fo-myac-entry"); if (entryEl) entryEl.addEventListener("change", function () { STATE.myacFilter.entry = this.value; renderMyacTab(); });
    const clearEl = $("#fo-myac-clear"); if (clearEl) clearEl.addEventListener("click", function () { STATE.myacFilter = { team: "", pos: "", entry: "" }; renderMyacTab(); });
    $$("#fo-myac-body tbody tr").forEach(function (tr) {
      tr.addEventListener("click", function () { if (tr.dataset.pid) openSlideover(tr.dataset.pid, tr.dataset.fid); });
    });
    $$("[data-myacsort]", body).forEach(function (th) {
      th.addEventListener("click", function () {
        const k = this.getAttribute("data-myacsort");
        if (STATE.myacSort.key === k) STATE.myacSort.dir *= -1;
        else { STATE.myacSort.key = k; STATE.myacSort.dir = 1; }
        renderMyacTab();
      });
    });
  }

  // ── RESTRUCTURES (§C5) ─────────────────────────────────────────────────
  // Mirrors the MYAC / Extensions tabs. Lists every player eligible to
  // restructure — 2+ years remaining, redistributable salary — so the owner
  // can front- or back-load the remaining years (TCV preserved, Y1 ≥ 20% TCV).
  // Window is OFFSEASON → September contract deadline (mid-season BANNED, canon
  // §C5); limit 3 per team per season. Row-click → slide-over Actions, where
  // the restructure form already posts to MFL + Discord + GIF (/offer-restructure).
  // Restructures already USED this season (3/team/season limit, §C5). Source:
  // the contract-activity log (the Discord-posted mutation log) — the canonical
  // ups_restructure_submissions table misses them because the restructure path
  // never wrote to it (the §C5 D1-write gap; fixed worker-side separately).
  // Counts DISTINCT (franchise, player) so a double-posted submit counts once.
  const RESTRUCTURE_LIMIT = 3;
  async function loadRestructureUsage() {
    if (STATE.restructureUsage) return STATE.restructureUsage;
    const out = { byFid: {}, names: {} };
    // Off-path ledger FIRST — gives us the exclusion set (test/invalid records
    // the commish flagged, e.g. Benson) before we add from any source.
    let ledger = { restructures: [], exclusions: [] };
    try { ledger = await fetchJSON("../contract_submissions/restructure_manual_" + encodeURIComponent(SEASON) + ".json") || ledger; } catch (e) {}
    const excluded = {};
    (ledger.exclusions || []).forEach(function (e) { excluded[pad4(e.franchise_id) + "|" + safeStr(e.player_id)] = true; });
    // Keyed per EVENT, not per player. Canon §C5 limits a team to 3
    // RESTRUCTURES per season — restructuring the same player twice is two of
    // them. Keying on player_id alone made the second one overwrite the first,
    // so CBP (Jordan Love once, Nico Collins on Jul 25 AND Jul 29) displayed
    // 2/3 while actually being at the 3/3 limit. The dedupe still has to work,
    // because the same submission arrives from D1 AND the activity-log
    // fallback — so the key is player + submission instant, which is identical
    // across both sources (verified to the millisecond on all 12 overlapping
    // records) while still separating two real restructures of one player.
    // No timestamp at all (hand-written ledger rows) falls back to the player
    // id, which preserves the old collapse-to-one behavior for those only.
    const add = function (fid, pid, name, atUtc) {
      fid = pad4(fid); pid = safeStr(pid);
      if (!fid || !pid) return;
      if (excluded[fid + "|" + pid]) return;            // skip flagged test/invalid records
      const at = safeStr(atUtc);
      const key = at ? (pid + "@" + at) : pid;
      (out.byFid[fid] = out.byFid[fid] || {})[key] = safeStr(name) || pid;
    };
    // PRIMARY: D1 ups_restructure_submissions (canon — D1 is the single source
    // of truth; the restructure-ingest endpoint + action keep it complete).
    try {
      const d1 = await fetchJSON(apiUrl("/admin/contract-submissions") + "?L=" + encodeURIComponent(LEAGUE_ID) + "&YEAR=" + encodeURIComponent(SEASON));
      (d1 && d1.submissions || []).forEach(function (s) {
        if (String(s.kind || "").toLowerCase() !== "restructure") return;
        add(s.franchise_id, s.player_id, s.player_name, s.submitted_at_utc);
      });
    } catch (e) { /* D1 unreachable → fall back to the files below */ }
    // FALLBACK (transition): worker contract-activity log (real prod only) + the
    // off-path manual ledger, in case a record isn't in D1 yet. Deduped + excluded.
    try {
      const data = await fetchJSON("../contract_submissions/contract_activity_" + encodeURIComponent(SEASON) + ".json");
      (data && data.activities || []).forEach(function (a) {
        if (String(a.activity_type || "").toLowerCase() !== "restructure") return;
        if (String(a.delivery_target || "") === "test") return;
        if (/^\s*\[dry run\]/i.test(safeStr(a.player_name))) return;
        add(a.franchise_id, a.player_id, a.player_name, a.submitted_at_utc);
      });
    } catch (e) { /* no log file */ }
    (ledger.restructures || []).forEach(function (r) { add(r.franchise_id, r.player_id, r.player_name, r.submitted_at_utc); });
    STATE.restructureUsage = out;
    return out;
  }
  function restructureUsedForFid(fid) {
    const m = (STATE.restructureUsage && STATE.restructureUsage.byFid[pad4(fid)]) || null;
    return m ? Object.keys(m).length : 0;
  }

  function renderRestructureTab() {
    const body = $("#fo-restructure-body");
    const meta = $("#fo-restructure-meta");
    if (!body) return;
    if (!STATE.restructureUsage) { loadRestructureUsage().then(renderRestructureTab); }
    const fmtDt = function (d) {
      try { return d.toLocaleDateString("en-US", { timeZone: "America/New_York", year: "numeric", month: "short", day: "numeric" }); }
      catch (_) { return "—"; }
    };
    const dlDate = contractDeadlineDateFO();              // Sept contract deadline (window close)
    const dlMs = dlDate ? dlDate.getTime() : Infinity;
    const dlStr = dlDate ? fmtDt(dlDate) : "—";
    const daysLeft = dlDate ? Math.ceil((dlMs - Date.now()) / 86400000) : Infinity;
    let rows = [];
    (STATE.teams || []).forEach(function (t) {
      (t.players || []).forEach(function (p) {
        let elig;
        try { elig = rosterContractEligibility(p); } catch (_) { return; }
        if (!elig || !elig.restructureEligible || p.isTaxi || p.isIr) return;
        // Remaining Salary Owed = TCV − Earned (sum of the remaining-year
        // salaries) — what a restructure actually redistributes. Keith
        // 2026-06-05: show this instead of TCV on the restructure view.
        var _rtcv = totalContractValueForPlayer(p);
        var _rbr = earnedToDateBreakdownForPlayer(p, safeInt(SEASON, 0), new Date());
        // Per-year salary for the REMAINING contract years — what a restructure
        // actually redistributes (Keith 2026-06-07: show 2026-X, 2027-Y, …).
        var _ymap = contractYearValueMapForPlayer(p);
        var _cidx = Math.max(1, contractYearIndexForPlayer(p));
        var _clen = Math.max(0, contractLengthForPlayer(p));
        var _sched = [];
        for (var _i = _cidx; _i <= _clen; _i += 1) {
          _sched.push({
            yr: safeInt(SEASON, 2026) + (_i - _cidx),
            sal: safeInt(_ymap[_i], 0) || (_i === _cidx ? safeInt(p.salary, 0) : 0),
          });
        }
        rows.push({
          pid: safeStr(p.id), fid: safeStr(t.fid),
          name: safeStr(p.name), team: safeStr(t.name) || safeStr(t.fid), pos: safeStr(p.position),
          type: safeStr(p.type), years: safeInt(p.years, 0), tcv: _rtcv,
          remaining: Math.max(0, _rtcv - safeInt(_rbr && _rbr.earned, 0)),
          sched: _sched,
          used: restructureUsedForFid(t.fid),
        });
      });
    });
    STATE.rstrFilter = STATE.rstrFilter || { team: "", pos: "" };
    const teamOpts = Array.from(new Set(rows.map(function (r) { return r.team; }).filter(Boolean))).sort();
    const posOpts = Array.from(new Set(rows.map(function (r) { return r.pos; }).filter(Boolean))).sort();
    const totalRows = rows.length;
    rows = rows.filter(function (r) {
      return (!STATE.rstrFilter.team || r.team === STATE.rstrFilter.team) &&
             (!STATE.rstrFilter.pos || r.pos === STATE.rstrFilter.pos);
    });
    if (meta) {
      meta.textContent = rows.length + (rows.length === totalRows ? "" : " of " + totalRows) +
        " eligible · window " + (daysLeft === Infinity ? "open" : (daysLeft < 0 ? "CLOSED" : daysLeft + "d left (" + dlStr + ")")) +
        " · 3/team/season · " + SEASON;
    }
    STATE.rstrSort = STATE.rstrSort || { key: "remaining", dir: -1 };
    const sk = STATE.rstrSort.key, sd = STATE.rstrSort.dir;
    rows.sort(function (a, b) {
      const av = a[sk], bv = b[sk];
      if (typeof av === "string") return sd * av.localeCompare(bv);
      return sd * ((av || 0) - (bv || 0));
    });
    const selStyle = "background:var(--panel-alt);color:var(--text);border:1px solid var(--border);padding:4px 8px;border-radius:4px;";
    const opt = function (val, label, sel) { return '<option value="' + escapeHtml(val) + '"' + (sel ? " selected" : "") + ">" + escapeHtml(label) + "</option>"; };
    const teamSel = '<select id="fo-rstr-team" style="' + selStyle + '">' + opt("", "All teams", !STATE.rstrFilter.team) +
      teamOpts.map(function (tt) { return opt(tt, tt, STATE.rstrFilter.team === tt); }).join("") + "</select>";
    const posSel = '<select id="fo-rstr-pos" style="' + selStyle + '">' + opt("", "All positions", !STATE.rstrFilter.pos) +
      posOpts.map(function (pp) { return opt(pp, pp, STATE.rstrFilter.pos === pp); }).join("") + "</select>";
    const clearBtn = (STATE.rstrFilter.team || STATE.rstrFilter.pos) ? ' <button type="button" id="fo-rstr-clear" class="btn small secondary">Clear</button>' : "";
    const toolbar = '<div class="fo-ext-toolbar" style="display:flex;gap:8px;align-items:center;margin:8px 0;flex-wrap:wrap;">' +
      '<span class="small" style="color:var(--muted);">Filter</span>' + teamSel + posSel + clearBtn + "</div>";
    const hdr = function (key, label, align) {
      const arrow = STATE.rstrSort.key === key ? (STATE.rstrSort.dir > 0 ? " ▲" : " ▼") : "";
      return '<th data-rstrsort="' + key + '" style="cursor:pointer;text-align:' + (align || "left") + ';white-space:nowrap;">' + escapeHtml(label) + arrow + "</th>";
    };
    const dCol = daysLeft === Infinity ? "var(--muted)" : (daysLeft <= 14 ? "#e67e22" : (daysLeft <= 45 ? "#d4a017" : "#1f8a4c"));
    const dStr = daysLeft === Infinity ? "open" : (daysLeft < 0 ? "closed" : daysLeft + "d");
    const _k = function (n) { n = safeInt(n, 0); return n >= 1000 ? "$" + String(Math.round(n / 100) / 10).replace(/\.0$/, "") + "K" : "$" + n; };
    const trs = rows.map(function (r) {
      const schedVals = (r.sched || []).map(function (s) { return _k(s.sal); }).join(" · ") || "—";
      const schedTitle = (r.sched || []).map(function (s) { return s.yr + " " + _k(s.sal); }).join(" · ");
      return '<tr data-pid="' + escapeHtml(r.pid) + '" data-fid="' + escapeHtml(r.fid) + '" style="cursor:pointer;" title="Open ' + escapeHtml(r.name) + ' — Actions / Restructure">' +
        "<td>" + escapeHtml(r.name) + "</td>" +
        "<td>" + escapeHtml(r.team) + "</td>" +
        '<td style="text-align:center;color:' + (r.used >= RESTRUCTURE_LIMIT ? "var(--err)" : "var(--muted)") + ';" title="Team restructures used this season">' + r.used + "/" + RESTRUCTURE_LIMIT + "</td>" +
        "<td>" + escapeHtml(r.pos) + "</td>" +
        '<td class="small">' + escapeHtml(r.type) + "</td>" +
        '<td style="text-align:center;">' + r.years + "</td>" +
        '<td style="text-align:right;">' + escapeHtml(fmtUSD(r.remaining)) + "</td>" +
        '<td class="small" style="white-space:nowrap;" title="' + escapeHtml(schedTitle) + '">' + escapeHtml(schedVals) + "</td>" +
        "<td>" + escapeHtml(dlStr) + "</td>" +
        '<td style="text-align:right;color:' + dCol + ';font-weight:600;">' + dStr + "</td>" +
        "</tr>";
    }).join("");
    const tableHtml = rows.length
      ? '<div class="fo-table-scroll"><table class="fo-table"><thead><tr>' +
        hdr("name", "Player") + hdr("team", "Team") +
        '<th style="text-align:center;" title="Team restructures used / 3-per-season limit">R Used</th>' +
        hdr("pos", "Pos") + hdr("type", "Type") +
        hdr("years", "Yrs Rem", "center") + hdr("remaining", "Remaining Owed", "right") +
        '<th title="Per-year salary for the remaining contract years (hover for years)">Salary by Yr</th>' +
        '<th>Deadline</th><th style="text-align:right;">Days Left</th>' +
        "</tr></thead><tbody>" + trs + "</tbody></table></div>"
      : '<div class="fo-table-loading">No players eligible to restructure' + (daysLeft < 0 ? " (window closed)" : "") + '.</div>';
    // "Used this season" summary (§C5 3/team limit) from the contract-activity log.
    const usage = STATE.restructureUsage || { byFid: {} };
    const usedFids = Object.keys(usage.byFid || {});
    const usedSummary = usedFids.length
      ? '<div class="fo-card" style="margin:6px 0;padding:8px 10px;"><div class="small" style="color:var(--muted);margin-bottom:4px;">Restructures used this season (' + RESTRUCTURE_LIMIT + '/team limit):</div>' +
        usedFids.map(function (fid) {
          const team = (STATE.teams || []).find(function (t) { return pad4(t.fid) === fid; });
          const nm = (team && team.name) || fid;
          // Keys are per-EVENT now, so a player restructured twice appears
          // twice. Collapse to "Nico Collins x2" rather than repeating the name
          // — and flip "Last, First" to "First Last", because comma-joining
          // "Love, Jordan, Collins, Nico" read as four players when it was two.
          const evKeys = Object.keys(usage.byFid[fid]);
          const n = evKeys.length;
          const perName = {};
          evKeys.forEach(function (k) {
            const raw = safeStr(usage.byFid[fid][k]);
            const nice = raw.indexOf(",") > -1
              ? raw.split(",").slice(1).join(",").trim() + " " + raw.split(",")[0].trim()
              : raw;
            perName[nice] = (perName[nice] || 0) + 1;
          });
          const players = Object.keys(perName).map(function (nm) {
            return perName[nm] > 1 ? nm + " \u00d7" + perName[nm] : nm;
          });
          return '<span style="display:inline-block;margin:2px 12px 2px 0;color:' + (n >= RESTRUCTURE_LIMIT ? "var(--err)" : "var(--text)") + ';"><strong>' + escapeHtml(nm) + '</strong> ' + n + '/' + RESTRUCTURE_LIMIT + ' <span class="small" style="color:var(--muted);">(' + escapeHtml(players.join(", ")) + ')</span></span>';
        }).join("") + '</div>'
      : (STATE.restructureUsage ? '<div class="small" style="color:var(--muted);margin:6px 0;">No restructures recorded this season yet.</div>' : "");
    body.innerHTML = usedSummary + toolbar + tableHtml;
    const teamEl = $("#fo-rstr-team"); if (teamEl) teamEl.addEventListener("change", function () { STATE.rstrFilter.team = this.value; renderRestructureTab(); });
    const posEl = $("#fo-rstr-pos"); if (posEl) posEl.addEventListener("change", function () { STATE.rstrFilter.pos = this.value; renderRestructureTab(); });
    const clearEl = $("#fo-rstr-clear"); if (clearEl) clearEl.addEventListener("click", function () { STATE.rstrFilter = { team: "", pos: "" }; renderRestructureTab(); });
    $$("#fo-restructure-body tbody tr").forEach(function (tr) {
      tr.addEventListener("click", function () { if (tr.dataset.pid) openSlideover(tr.dataset.pid, tr.dataset.fid); });
    });
    $$("[data-rstrsort]", body).forEach(function (th) {
      th.addEventListener("click", function () {
        const k = this.getAttribute("data-rstrsort");
        if (STATE.rstrSort.key === k) STATE.rstrSort.dir *= -1;
        else { STATE.rstrSort.key = k; STATE.rstrSort.dir = 1; }
        renderRestructureTab();
      });
    });
  }

  function renderCapTab() {
    const body = $("#fo-cap-body");
    if (!body) return;
    if (STATE.capSubview === "detail") body.innerHTML = renderCapDetail();
    else                               body.innerHTML = renderCapSummary();
    wireCapTab();
  }

  // Filter a player through the Summary filters. Used by aggregate.
  function capSummaryPlayerMatches(p, f) {
    if (f.pos && f.pos !== "ALL" && posBucket(p.position) !== f.pos) return false;
    if (f.type) {
      const t = String(p.type || "").toUpperCase();
      if (f.type === "rookie"   && !t.startsWith("ROOKIE")) return false;
      if (f.type === "veteran"  && !(t === "VETERAN" || t === "VET")) return false;
      if (f.type === "ext"      && !t.startsWith("EXT")) return false;
      if (f.type === "tag"      && t !== "TAG") return false;
      if (f.type === "ww"       && t !== "WW") return false;
      if (f.type === "mym"      && t.indexOf("MYM") < 0) return false;
      if (f.type === "expired"  && !p.isExpiredRookie) return false;
    }
    if (f.years !== "" && f.years != null) {
      const yrs = safeInt(p.years, 0);
      if (f.years === "4+") { if (yrs < 4) return false; }
      else if (yrs !== safeInt(f.years, -1)) return false;
    }
    if (f.status) {
      if (f.status === "active" && (p.isTaxi || p.isIr)) return false;
      if (f.status === "taxi" && !p.isTaxi) return false;
      if (f.status === "ir"   && !p.isIr)   return false;
    }
    // Hide expired contracts from cap planning by default — they carry no
    // current-year cap and just clutter the view (Keith 2026-06-06: "I shouldn't
    // see expired contracts at this point"). Still reachable via the explicit
    // "Expired" (0 yrs) year filter or an expired type filter.
    const _wantExpired = String(f.years) === "0" || f.type === "expired";
    if (capContractIsExpired(p) && !_wantExpired) return false;
    return true;
  }

  // An expired contract is not a contract: no cap hit, no roster-rule slot, no
  // year in the projection grid. Catch it by ANY signal — 0 years remaining, the
  // "Expired" contract type, or the expired-rookie flag — because some expired
  // rows retain a stale positive `years` value.
  //
  // ONE definition, used by three consumers that must agree: the Detail row
  // filter above, the §C2 roster-rule counters, and the per-year roster
  // headcount. A row that isn't shown and carries no money must not be counted
  // against a roster limit either.
  function capContractIsExpired(p) {
    // A contract MFL has not described yet is UNKNOWN, not expired. It reaches
    // `years <= 0` only because contractYear is blank — the player is rostered
    // and carries a real salary, so calling him expired would drop him out of
    // cap planning AND out of the §C2 roster counts he genuinely occupies.
    if (contractUnknownForPlayer(p)) return false;
    return safeInt(p && p.years, 0) <= 0 ||
           !!(p && p.isExpiredRookie) ||
           String((p && p.type) || "").toUpperCase() === "EXPIRED";
  }

  function aggregateTeamForSummary(team, filters) {
    const out = {
      fid: team.fid, name: team.name,
      count: 0, active: 0, taxi: 0, ir: 0, loaded: 0, threeYr: 0,
      totalSalary: 0, totalAAV: 0, totalTCV: 0, deferredCash: 0
    };
    (team.players || []).forEach(function (p) {
      if (!capSummaryPlayerMatches(p, filters)) return;
      out.count += 1;
      if (p.isTaxi) out.taxi += 1;
      else if (p.isIr) out.ir += 1;
      else out.active += 1;
      // Same test as capRosterRuleCounts' committed loadedNow/threeNow: an
      // expired contract no longer counts against the §C2 caps.
      if (!capContractIsExpired(p)) {
        if (isLoadedRow(p)) out.loaded += 1;
        if (Math.max(0, safeInt(p.years, 0)) === 3 && ctypeClass(p.type).split(" ")[0] !== "rk") out.threeYr += 1;
      }
      out.totalSalary += currentCapHit(p);              // counts vs cap (taxi=0, IR×0.5)
      out.totalAAV    += displayAavForPlayer(p);
      out.totalTCV    += totalContractValueForPlayer(p);
      // Deferred cash (Keith 2026-08-04, corrected: "how much money from THIS
      // season was deferred to a future season" — NOT a cumulative TCV-vs-
      // earned figure). AAV − this season's actual salary: positive on a
      // back-loaded deal (paying LESS than the flat rate now, more later —
      // money pushed out), negative on a front-loaded one (paying MORE than
      // the flat rate now — money pulled forward from later years). AAV 30K,
      // Y1 20K → +10K, Keith's own example.
      //
      // Gated on years > 1 (Keith 2026-08-04, verified against C-Town's real
      // roster): a player in the FINAL year of their contract (or expired)
      // has no LATER year of the SAME deal for money to be deferred to, so
      // whatever gap exists between AAV and this year's salary isn't actually
      // "deferred" — it's just how the (possibly now-finished) contract was
      // shaped. Confirmed live: Tagovailoa and Higgins (both years=1, final
      // year) read $0 here even though AAV ≠ this year's salary for both.
      if (safeInt(p.years, 0) > 1) {
        out.deferredCash += displayAavForPlayer(p) - currentContractYearValue(p);
      }
    });
    // Team-level cap adjustments (drop penalties, traded salary, other) aren't
    // player-attributable, so they don't honor the position/type filters. When a
    // SPECIFIC position is selected, exclude them from Total Cap + the % so the
    // figure reflects only that position's salary (Keith 2026-06-06: "when you
    // select a position you need to exclude those from the equation"). With ALL
    // positions they're included.
    const posFiltered = !!(filters.pos && filters.pos !== "ALL");
    const s = team.summary || {};
    out.posFiltered = posFiltered;
    // Drop penalties round to the nearest $1K by TEAM TOTAL (canon §6) — same
    // roundToK() the adjustments popup applies at :2647. loadMflSalaryAdjustments
    // deliberately skips MFL's posted `id:ups_drop_rounding_*` true-up rows (:722)
    // so they aren't double-counted, which means adj_cut is the RAW un-rounded sum
    // and this row must re-apply the rounding itself. Without it the summary
    // disagreed with both the popup and MFL's own cap page by up to ±$500/team
    // (8 of 12 teams on 2026-07-25, e.g. C-Town $15,500 vs the true $16,000).
    out.dropPen   = posFiltered ? 0 : capAdjDropPen(s);
    out.tradeSal  = posFiltered ? 0 : safeInt(s.adj_trade, 0);
    out.otherAdj  = posFiltered ? 0 : safeInt(s.adj_other, 0);
    out.totalCap  = out.totalSalary + out.dropPen + out.tradeSal + out.otherAdj;
    out.pct       = Math.round((out.totalCap / CAP_CEILING) * 100);
    return out;
  }

  // Dynamic Yrs-Remaining options for the cap filters — only surface buckets
  // (and "Expired") that actually have players, so the dropdown never offers an
  // empty option (Keith 2026-06-06: don't show "Expired" when there are none).
  // Canon §6: drop penalties round to the nearest $1K on the TEAM TOTAL, not
  // per penalty. loadMflSalaryAdjustments deliberately skips MFL's posted
  // `id:ups_drop_rounding_*` true-up rows so they can't be double-counted, so
  // adj_cut is always the RAW un-rounded sum and every consumer has to apply
  // the rounding itself.
  //
  // This lived in three places and one of them forgot: the cap DETAIL callout
  // summed adj_cut raw while the hub and the cap SUMMARY rounded it, so the
  // same team read +$9,200 on one screen and +$9,000 on the other, and only
  // the rounded one matched MFL. One definition now — the rule cannot drift
  // again because there is nowhere for it to drift to.
  // §D1 — which season a NEW cut's dead cap lands on. Before the Auction Roster
  // Lock it hits the current season; from auction start through season end it
  // hits the FOLLOWING one (canon: "Penalty incurred from auction start through
  // end of season → applies to following season cap"). Keith 2026-08-01, once
  // the 2026 auction opened. Unknown date ⇒ current season, matching the old
  // behavior rather than silently moving money on a missing lookup.
  function dropPenaltyLandsNextSeason() {
    var d = safeStr(STATE.faAuctionStart);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;
    var today = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
    return today >= d;
  }

  function capAdjDropPen(s) { return roundToK(safeInt(s && s.adj_cut, 0)); }
  function capAdjTotal(s) {
    return capAdjDropPen(s) + safeInt(s && s.adj_trade, 0) + safeInt(s && s.adj_other, 0);
  }

  function capYearOptionsHtml(f) {
    const present = Object.create(null);
    let hasExpired = false;
    (STATE.teams || []).forEach(function (t) {
      (t.players || []).forEach(function (p) {
        const isExp = capContractIsExpired(p);
        if (isExp) { hasExpired = true; return; }
        const y = safeInt(p.years, 0);
        if (y > 0) present[y >= 4 ? "4+" : String(y)] = true;
      });
    });
    let html = '<option value="">All</option>';
    if (hasExpired) html += `<option value="0" ${f.years === "0" ? "selected" : ""}>Expired</option>`;
    ["1", "2", "3", "4+"].forEach(function (y) {
      if (present[y]) html += `<option value="${y}" ${f.years === y ? "selected" : ""}>${y}</option>`;
    });
    return html;
  }

  function renderCapSummary() {
    const f = STATE.capSummaryFilters;
    const sort = STATE.capSummarySort;
    const rows = STATE.teams.map(function (t) { return aggregateTeamForSummary(t, f); });
    const numericKeys = ["count", "active", "taxi", "ir", "loaded", "threeYr",
                         "totalSalary", "dropPen", "tradeSal", "totalCap",
                         "pct", "totalAAV", "totalTCV", "deferredCash"];
    rows.sort(function (a, b) {
      const va = a[sort.key], vb = b[sort.key];
      if (numericKeys.indexOf(sort.key) >= 0) {
        return ((Number(va) || 0) - (Number(vb) || 0)) * sort.dir;
      }
      return String(va || "").localeCompare(String(vb || "")) * sort.dir;
    });
    const arrow = (key) => sort.key === key ? (sort.dir > 0 ? " ▲" : " ▼") : "";

    const posChips = ["ALL", "QB", "RB", "WR", "TE", "PK", "PN", "IDP"].map(function (pos) {
      const on = (f.pos || "ALL") === pos;
      return `<button type="button" class="fo-pos-chip ${on ? "active" : ""}" data-cap-pos="${pos}">${pos === "ALL" ? "All" : pos}</button>`;
    }).join("");

    const bodyRows = rows.map(function (r) {
      const overC = r.totalCap > CAP_CEILING;
      const underF = r.totalCap < CAP_FLOOR && !f.pos && !f.type && !f.years && !f.status;
      const capCls = overC ? "fo-cap-over" : underF ? "fo-cap-under" : "";
      const dropCls  = r.dropPen   > 0 ? "fo-cap-pen"   : "";
      const tradeCls = r.tradeSal != 0 ? (r.tradeSal > 0 ? "fo-cap-trade" : "fo-cap-trade-credit") : "";
      const tradeCell = r.tradeSal === 0 ? "—"
                       : r.tradeSal > 0 ? fmtUSD(r.tradeSal)
                       : "−" + fmtUSD(Math.abs(r.tradeSal));
      // Deferred can go either way — positive (back-loaded, money pushed
      // OUT of this season) or negative (front-loaded, pulled INTO it).
      const deferredCell = r.deferredCash === 0 ? "$0"
                          : r.deferredCash > 0 ? "+" + fmtUSD(r.deferredCash)
                          : "−" + fmtUSD(Math.abs(r.deferredCash));
      return `
        <tr data-fid="${escapeHtml(r.fid)}" class="fo-cap-summary-row">
          <td><a href="#" class="fo-cap-team-link" data-fid="${escapeHtml(r.fid)}">${escapeHtml(r.name)}</a></td>
          <td class="num">${r.count}</td>
          <td class="num">${r.active}</td>
          <td class="num">${r.taxi}</td>
          <td class="num">${r.ir}</td>
          <td class="num" title="Front/back-loaded deals — the −FL / −BL suffix (§C2, max ${LOADED_MAX})">${r.loaded}</td>
          <td class="num" title="3 years remaining, rookie deals excluded (§C2, max ${THREEYR_MAX})">${r.threeYr}</td>
          <td class="num">${fmtUSD(r.totalSalary)}</td>
          <td class="num ${dropCls}">${r.dropPen > 0 ? fmtUSD(r.dropPen) : "—"}</td>
          <td class="num ${tradeCls}">${tradeCell}</td>
          <td class="num ${capCls}"><strong>${fmtUSD(r.totalCap)}</strong></td>
          <td class="num ${capCls}">${r.pct}%</td>
          <td class="num">${fmtUSD(r.totalAAV)}</td>
          <td class="num">${fmtUSD(r.totalTCV)}</td>
          <td class="num" title="AAV minus this season's actual salary, summed — positive = back-loaded (money pushed OUT of ${safeInt(SEASON, 0)}), negative = front-loaded (pulled IN). Final-year contracts read $0 — no later year of that deal to defer to.">${deferredCell}</td>
        </tr>`;
    }).join("");

    // League totals row (sums of visible columns + aggregate %).
    const totals = rows.reduce(function (acc, r) {
      acc.count += r.count; acc.active += r.active; acc.taxi += r.taxi; acc.ir += r.ir;
      acc.loaded += r.loaded; acc.threeYr += r.threeYr;
      acc.totalSalary += r.totalSalary;
      acc.dropPen   += r.dropPen;
      acc.tradeSal  += r.tradeSal;
      acc.totalCap  += r.totalCap;
      acc.totalAAV += r.totalAAV; acc.totalTCV += r.totalTCV;
      acc.deferredCash += r.deferredCash;
      return acc;
    }, { count: 0, active: 0, taxi: 0, ir: 0, loaded: 0, threeYr: 0,
         totalSalary: 0, dropPen: 0, tradeSal: 0, totalCap: 0,
         totalAAV: 0, totalTCV: 0, deferredCash: 0 });
    const leagueCeiling = CAP_CEILING * STATE.teams.length;
    totals.pct = leagueCeiling > 0 ? Math.round((totals.totalCap / leagueCeiling) * 100) : 0;

    return `
      <div class="fo-card">
        <div class="fo-toolbar-row">
          <div class="fo-pos-chips" id="fo-cap-pos-chips">${posChips}</div>
          <!-- Contract Type filter hidden 2026-05-19 pending universal
               contract-logic pass (Keith: "We're going to make a pass
               at going through and making all contracts universal with
               new logic, until we pass that to MFL"). Filter wiring is
               kept live in JS so this re-enables in one HTML edit when
               the canonical contract types are settled.
          <label class="fo-field">
            <span>Contract Type</span>
            <select id="fo-cap-filter-type">
              <option value="">All</option>
              ...
            </select>
          </label>
          -->
          <input type="hidden" id="fo-cap-filter-type" value="">
          <label class="fo-field">
            <span>Yrs Remaining</span>
            <select id="fo-cap-filter-years">
              ${capYearOptionsHtml(f)}
            </select>
          </label>
          <label class="fo-field">
            <span>Roster Status</span>
            <select id="fo-cap-filter-status">
              <option value="">All</option>
              <option value="active" ${f.status === "active" ? "selected" : ""}>Active</option>
              <option value="taxi"   ${f.status === "taxi"   ? "selected" : ""}>Taxi</option>
              <option value="ir"     ${f.status === "ir"     ? "selected" : ""}>IR</option>
            </select>
          </label>
          <button type="button" class="btn secondary" id="fo-cap-reset">Reset</button>
        </div>
      </div>
      <div class="fo-card">
        <table class="fo-table">
          <thead>
            <tr>
              <th data-cap-sort="name">Team${arrow("name")}</th>
              <th class="num" data-cap-sort="count">Players${arrow("count")}</th>
              <th class="num" data-cap-sort="active">Active${arrow("active")}</th>
              <th class="num" data-cap-sort="taxi">Taxi${arrow("taxi")}</th>
              <th class="num" data-cap-sort="ir">IR${arrow("ir")}</th>
              <th class="num" data-cap-sort="loaded" title="Front/back-loaded deals — the −FL / −BL suffix (§C2, max ${LOADED_MAX})">Loaded${arrow("loaded")}</th>
              <th class="num" data-cap-sort="threeYr" title="3 years remaining, rookie deals excluded (§C2, max ${THREEYR_MAX})">3-Yr${arrow("threeYr")}</th>
              <th class="num" data-cap-sort="totalSalary">Salary${arrow("totalSalary")}</th>
              <th class="num" data-cap-sort="dropPen">Drop Pen${arrow("dropPen")}</th>
              <th class="num" data-cap-sort="tradeSal">Trade Sal${arrow("tradeSal")}</th>
              <th class="num" data-cap-sort="totalCap">Total Cap${arrow("totalCap")}</th>
              <th class="num" data-cap-sort="pct">% of $300K${arrow("pct")}</th>
              <th class="num" data-cap-sort="totalAAV">AAV${arrow("totalAAV")}</th>
              <th class="num" data-cap-sort="totalTCV">TCV${arrow("totalTCV")}</th>
              <th class="num" data-cap-sort="deferredCash" title="AAV minus this season's actual salary, summed — positive = back-loaded (money pushed OUT of ${safeInt(SEASON, 0)}), negative = front-loaded (pulled IN). Final-year contracts read $0 — no later year of that deal to defer to.">Deferred${arrow("deferredCash")}</th>
            </tr>
          </thead>
          <tbody>${bodyRows}</tbody>
          <tfoot>
            <tr class="fo-cap-totals-row">
              <td><strong>League totals</strong></td>
              <td class="num">${totals.count}</td>
              <td class="num">${totals.active}</td>
              <td class="num">${totals.taxi}</td>
              <td class="num">${totals.ir}</td>
              <td class="num">${totals.loaded}</td>
              <td class="num">${totals.threeYr}</td>
              <td class="num">${fmtUSD(totals.totalSalary)}</td>
              <td class="num">${fmtUSD(totals.dropPen)}</td>
              <td class="num">${fmtUSD(totals.tradeSal)}</td>
              <td class="num"><strong>${fmtUSD(totals.totalCap)}</strong></td>
              <td class="num"><strong>${totals.pct}%</strong> <span class="small" style="color:var(--muted);">of ${fmtUSD(leagueCeiling)}</span></td>
              <td class="num">${fmtUSD(totals.totalAAV)}</td>
              <td class="num">${fmtUSD(totals.totalTCV)}</td>
              <td class="num">${totals.deferredCash === 0 ? "$0" : totals.deferredCash > 0 ? "+" + fmtUSD(totals.deferredCash) : "−" + fmtUSD(Math.abs(totals.deferredCash))}</td>
            </tr>
          </tfoot>
        </table>
        <p class="small" style="color:var(--muted); margin: 8px 0 0;">
          Click a team name to drill into Detail. <strong>Salary</strong> = current-year player cap hits (taxi $0, IR ×0.5) and honors the filters above. <strong>Drop Pen</strong> + <strong>Trade Sal</strong> are team-level cap adjustments. <strong>Total Cap</strong> = Salary + adjustments, and <strong>% of $300K</strong> follows it. <strong>Deferred</strong> = AAV minus this season's actual salary, summed across the roster — not a cap adjustment, it's how much of ${safeInt(SEASON, 0)}'s money moved to a different year. Positive means back-loaded (paying less than the flat rate now, more later); negative means front-loaded (paying more now, less later). A player in the <strong>final year</strong> of their contract always reads $0 — there's no later year of that same deal for the money to move to. Expired contracts (0 yrs left) are hidden. <strong>When you filter to a single position, adjustments are excluded from Total Cap + % </strong>(they're team-wide, not position-specific) — switch to <em>All</em> to see them. League % = sum of all teams' total cap / $${(CAP_CEILING / 1000) * STATE.teams.length}K ($300K × ${STATE.teams.length} teams).
        </p>
      </div>`;
  }

  function renderCapBars(buckets, total) {
    if (total <= 0) return "";
    const colors = { QB: "var(--err)", RB: "var(--ok)", WR: "var(--accent)", TE: "var(--warn)", PK: "#c084fc", PN: "#c084fc", IDP: "#94a3b8" };
    const segs = Object.keys(buckets).filter(function (k) { return buckets[k] > 0; }).map(function (k) {
      const w = (buckets[k] / total) * 100;
      return `<span class="seg" title="${k} ${fmtUSD(buckets[k])} (${Math.round(w)}%)" style="width:${w}%; background:${colors[k] || "#94a3b8"}"></span>`;
    }).join("");
    return `<div class="fo-cap-bars" aria-hidden="true">${segs}</div>`;
  }

  // ══════════════════════════════════════════════════════════════════
  // SAVED SCENARIOS — localStorage ONLY
  // ══════════════════════════════════════════════════════════════════
  //
  // 🔒 "Save" means save the PLAN IN THIS BROWSER. Cap Planning never writes to
  // MFL and never posts to the worker (Keith 2026-08-01: "cap planning should be
  // planning. ONLY"). There is no network call anywhere in this block — a
  // scenario is a bag of preview kinds + draft numbers, stored under a key
  // scoped to league + season + franchise so plans can never leak between teams
  // or seasons.
  //
  // A saved plan is only as good as the roster it was planned against, so every
  // preview travels with a CONTRACT FINGERPRINT. On restore, anything whose
  // player left the roster or whose contract moved is DROPPED with a visible
  // reason — silently re-applying stale planning data to a changed roster is
  // worse than having no save at all.

  const CAP_SCENARIO_SCHEMA = 1;
  const CAP_PREVIEW_KINDS = ["ext1", "ext2", "myac2", "myac3", "myacl2", "myacl3", "drop", "promote", "restructure"];

  function capScenarioKey(fid) {
    return "ups-fo-cap-scenario:" + LEAGUE_ID + ":" + SEASON + ":" + safeStr(fid);
  }
  // localStorage can be PRESENT but throwing (Safari private mode, a blocked
  // storage partition inside the MFL embed). Probe with a real write so the UI
  // can say the feature is unavailable instead of offering a dead button.
  //
  // Memoized: the scenario bar re-renders on every keystroke in an editor, and
  // availability can't change mid-session — an unmemoized probe would run a
  // write+delete pair per character typed.
  let _capScenarioStore;              // undefined = not probed yet; null = blocked
  function capScenarioStorage() {
    if (_capScenarioStore !== undefined) return _capScenarioStore;
    _capScenarioStore = null;
    try {
      const ls = window.localStorage;
      if (ls) {
        ls.setItem("ups-fo-scn-probe", "1");
        ls.removeItem("ups-fo-scn-probe");
        _capScenarioStore = ls;
      }
    } catch (e) { _capScenarioStore = null; }
    return _capScenarioStore;
  }

  // What the roster looked like when a preview was planned. Compared field by
  // field on restore — `special` is the raw contractInfo, so any re-slotted year,
  // changed TCV/AAV/GTD or flipped FL/BL suffix trips it.
  function capContractFingerprint(p) {
    return {
      name:    safeStr(p && p.name),
      type:    safeStr(p && p.type),
      years:   safeInt(p && p.years, 0),
      salary:  safeInt(p && p.salary, 0),
      special: safeStr(p && p.special)
    };
  }
  function capFingerprintDiff(a, b) {
    const parts = [];
    if (safeStr(a.type) !== safeStr(b.type)) parts.push("type " + (safeStr(a.type) || "—") + " → " + (safeStr(b.type) || "—"));
    if (safeInt(a.years, 0) !== safeInt(b.years, 0)) parts.push("years remaining " + safeInt(a.years, 0) + " → " + safeInt(b.years, 0));
    if (safeInt(a.salary, 0) !== safeInt(b.salary, 0)) parts.push("salary " + fmtUSD(safeInt(a.salary, 0)) + " → " + fmtUSD(safeInt(b.salary, 0)));
    if (safeStr(a.special) !== safeStr(b.special)) parts.push("contract detail rewritten");
    return parts.join("; ");
  }

  // The plan for ONE team, keyed by pid (the fid lives in the storage key).
  // Iterates the ROSTER, not the preview map, so a preview stranded on a player
  // who has since left the team is never written into a save.
  function capScenarioSnapshot(team) {
    const out = { previews: {}, restructureDrafts: {}, myacLoadedDrafts: {}, fingerprints: {} };
    ((team && team.players) || []).forEach(function (p) {
      const key = capPreviewKey(p);
      const kind = STATE.capPreviews[key];
      if (!kind) return;
      const pid = safeStr(p.id);
      out.previews[pid] = String(kind);           // plain STRING, same as STATE
      const rs = STATE.capRestructureDrafts[key];
      if (rs && Array.isArray(rs.amounts)) {
        out.restructureDrafts[pid] = rs.amounts.map(function (v) { return safeInt(v, 0); });
      }
      const ml = STATE.capMyacLoadedDrafts[key];
      if (ml && Array.isArray(ml.amounts)) {
        out.myacLoadedDrafts[pid] = { kind: String(ml.kind || ""), amounts: ml.amounts.map(function (v) { return safeInt(v, 0); }) };
      }
      out.fingerprints[pid] = capContractFingerprint(p);
    });
    return out;
  }

  // Order-independent identity of a plan, so "unsaved changes" can't be tripped
  // by the worker returning the roster in a different order. Fingerprints are
  // deliberately excluded — a roster change is not a plan change.
  function capScenarioCanon(sc) {
    if (!sc || !sc.previews) return "";
    return Object.keys(sc.previews).sort().map(function (pid) {
      const rs = (sc.restructureDrafts || {})[pid];
      const ml = (sc.myacLoadedDrafts || {})[pid];
      return pid + "=" + String(sc.previews[pid]) +
        (Array.isArray(rs) ? "|rs:" + rs.join(",") : "") +
        (ml && Array.isArray(ml.amounts) ? "|ml:" + String(ml.kind) + ":" + ml.amounts.join(",") : "");
    }).join(";");
  }

  // Read + hard-validate the stored payload. A payload from a different SCHEMA,
  // league, season or franchise is discarded whole — never partially applied.
  function capScenarioLoad(fid) {
    const ls = capScenarioStorage();
    if (!ls) return null;
    let raw = "";
    try { raw = ls.getItem(capScenarioKey(fid)) || ""; } catch (e) { return null; }
    if (!raw) return null;
    let obj = null;
    try { obj = JSON.parse(raw); } catch (e) { obj = null; }
    if (!obj || safeInt(obj.v, 0) !== CAP_SCENARIO_SCHEMA) return null;
    if (String(obj.league) !== String(LEAGUE_ID)) return null;
    if (String(obj.season) !== String(SEASON)) return null;
    if (safeStr(obj.fid) !== safeStr(fid)) return null;
    const sc = obj.scenario;
    if (!sc || typeof sc !== "object" || !sc.previews || typeof sc.previews !== "object") return null;
    return obj;
  }

  function capScenarioSave(team) {
    if (!capScenarioStorage()) {
      return { ok: false, reason: "This browser is blocking page storage (private mode, or a partitioned storage context inside the MFL embed), so scenarios can’t be saved here." };
    }
    const snap = capScenarioSnapshot(team);
    if (!Object.keys(snap.previews).length) {
      return { ok: false, reason: "Nothing to save — no previews are active for this team." };
    }
    const payload = {
      v: CAP_SCENARIO_SCHEMA,
      league: String(LEAGUE_ID),
      season: String(SEASON),
      fid: safeStr(team.fid),
      team: safeStr(team.name),
      saved_at: new Date().toISOString(),
      scenario: snap
    };
    try { capScenarioStorage().setItem(capScenarioKey(team.fid), JSON.stringify(payload)); }
    catch (e) { return { ok: false, reason: "Browser storage refused the write (" + safeStr(e && e.message ? e.message : "quota exceeded") + ")." }; }
    return { ok: true, payload: payload, count: Object.keys(snap.previews).length };
  }

  function capScenarioDiscard(fid) {
    const ls = capScenarioStorage();
    if (!ls) return false;
    try { ls.removeItem(capScenarioKey(fid)); return true; } catch (e) { return false; }
  }

  // Clear every preview AND its parallel drafts for one team. Preview and draft
  // die together — the lockstep rule the toggle handler already enforces —
  // otherwise a stranded draft resurfaces the next time that row is previewed.
  function capClearTeamPreviews(fid) {
    const suffix = ":" + safeStr(fid);
    Object.keys(STATE.capPreviews).forEach(function (k) {
      if (k.endsWith(suffix)) delete STATE.capPreviews[k];
    });
    Object.keys(STATE.capRestructureDrafts).forEach(function (k) {
      if (k.endsWith(suffix)) clearCapRestructureDraft(k);
    });
    Object.keys(STATE.capMyacLoadedDrafts).forEach(function (k) {
      if (k.endsWith(suffix)) clearCapMyacLoadedDraft(k);
    });
  }

  // Can this preview kind still be BUILT against today's contract? Same
  // substantive gates the row buttons apply when you click them — so a restored
  // plan can never project money the live roster doesn't support.
  function capPreviewStillValid(p, kind) {
    if (kind === "drop") {
      return (!p.isTaxi && safeInt(p.years, 0) > 0)
        ? { ok: true, reason: "" }
        : { ok: false, reason: "no longer droppable from this view (taxi squad, or the contract has expired)" };
    }
    if (kind === "promote") {
      return (p.isTaxi && safeInt(p.years, 0) > 0)
        ? { ok: true, reason: "" }
        : { ok: false, reason: "no longer on the taxi squad, so there is nothing to promote" };
    }
    if (kind === "ext1" || kind === "ext2") {
      const ext = extensionAddByKind(p, kind);
      return safeInt(ext.add1, 0) > 0
        ? { ok: true, reason: "" }
        : { ok: false, reason: "no flat " + (kind === "ext2" ? "2" : "1") + "-year extension option resolves for this player today" };
    }
    if (kind === "myac2" || kind === "myac3" || kind === "myacl2" || kind === "myacl3") {
      const n = (kind === "myac3" || kind === "myacl3") ? 3 : 2;
      if ((kind === "myacl2" || kind === "myacl3") && p.isTaxi) {
        return { ok: false, reason: "taxi salaries are off-cap (§6.E), so a loaded split has nothing to move" };
      }
      const basis = myacLoadedBasis(p, n);
      return basis.ok ? { ok: true, reason: "" } : { ok: false, reason: basis.reason };
    }
    if (kind === "restructure") {
      if (p.isTaxi) return { ok: false, reason: "taxi salaries are off-cap (§6.E), so there is nothing to re-slot" };
      const real = capRestructureRealYears(p);
      return real.ok ? { ok: true, reason: "" } : { ok: false, reason: real.reason };
    }
    return { ok: false, reason: "unknown preview type" };
  }

  // Apply a saved plan to the CURRENT roster, dropping anything that no longer
  // holds. Returns the applied / dropped lists so the UI can show both.
  function capScenarioRestore(team) {
    const saved = capScenarioLoad(team.fid);
    if (!saved) {
      return { ok: false, reason: "No usable saved scenario for this team — either nothing was saved, or the saved payload was written by a different version of this screen and was discarded rather than guessed at." };
    }
    const sc = saved.scenario;
    const applied = [], dropped = [];
    // Start from a clean slate for THIS team only; other teams' previews are
    // keyed by their own fid and are untouched.
    capClearTeamPreviews(team.fid);
    Object.keys(sc.previews).forEach(function (pid) {
      const kind = String(sc.previews[pid] || "");
      const fp = (sc.fingerprints || {})[pid] || null;
      const label = (fp && fp.name) ? safeStr(fp.name) : ("player " + safeStr(pid));
      if (CAP_PREVIEW_KINDS.indexOf(kind) < 0) {
        dropped.push({ name: label, why: "unrecognized preview type “" + kind + "”" });
        return;
      }
      const p = findPlayer(pid, team.fid);
      if (!p) {
        dropped.push({ name: label, why: "no longer on this roster (traded, cut, or moved)" });
        return;
      }
      if (!fp) {
        dropped.push({ name: safeStr(p.name), why: "saved without a contract fingerprint — can’t confirm the contract is unchanged" });
        return;
      }
      const diff = capFingerprintDiff(fp, capContractFingerprint(p));
      if (diff) {
        dropped.push({ name: safeStr(p.name), why: "contract changed since the save — " + diff });
        return;
      }
      const gate = capPreviewStillValid(p, kind);
      if (!gate.ok) {
        dropped.push({ name: safeStr(p.name), why: gate.reason });
        return;
      }
      const key = capPreviewKey(p);
      STATE.capPreviews[key] = kind;   // 🔒 plain STRING — every consumer uses ===
      if (kind === "restructure") {
        // The saved draft is used only when it still fits the contract's
        // remaining years; otherwise re-seed NEUTRAL (the contract's own years),
        // exactly like clicking Restr does.
        const seed = capRestructureRealYears(p);
        const amts = (sc.restructureDrafts || {})[pid];
        STATE.capRestructureDrafts[key] = {
          amounts: (Array.isArray(amts) && amts.length === seed.amounts.length)
            ? amts.map(function (v) { return Math.max(0, safeInt(v, 0)); })
            : seed.amounts.slice()
        };
      }
      if (kind === "myacl2" || kind === "myacl3") {
        const n = kind === "myacl3" ? 3 : 2;
        const basis = myacLoadedBasis(p, n);          // gate above guarantees ok
        const d = (sc.myacLoadedDrafts || {})[pid];
        let amts = null;
        if (d && String(d.kind) === kind && Array.isArray(d.amounts) && d.amounts.length === n) {
          amts = d.amounts.map(function (v) { return Math.max(0, safeInt(v, 0)); });
        }
        if (!amts) { amts = []; for (let i = 0; i < n; i += 1) amts.push(basis.aav); }
        STATE.capMyacLoadedDrafts[key] = { kind: kind, amounts: amts };
      }
      applied.push(safeStr(p.name));
    });
    return { ok: true, saved_at: safeStr(saved.saved_at), applied: applied, dropped: dropped };
  }

  // A restored plan stops being "the saved plan" the moment it's touched. Called
  // from every path that mutates previews or drafts, so the badge can't claim a
  // restore that no longer describes what's on screen.
  //
  // `fid` is required to be the team whose plan actually changed — editing team
  // B must not stamp "edited" on team A's restore banner. Accepts either a bare
  // fid or a "pid:fid" preview key, since the editor inputs carry the latter.
  function capScenarioMarkEdited(fidOrKey) {
    const n = STATE.capScenarioNotice;
    if (!n || n.kind !== "restored") return;
    const raw = safeStr(fidOrKey);
    const fid = raw.indexOf(":") >= 0 ? raw.slice(raw.indexOf(":") + 1) : raw;
    if (fid && fid !== safeStr(n.fid)) return;
    n.edited = true;
  }

  // "2026-08-01T14:03:22Z" → a short local stamp. Returns "" on an unparseable
  // value so the caller can omit the phrase rather than print a bad date.
  function capScenarioWhen(iso) {
    const d = new Date(safeStr(iso));
    if (!iso || isNaN(d.getTime())) return "";
    try { return d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }); }
    catch (e) { return safeStr(iso).slice(0, 16).replace("T", " "); }
  }

  // The team the Detail view is pinned to. Factored out so the in-place
  // re-render used while typing in the restructure editor resolves exactly
  // the same team renderCapDetail() did.
  function capFocusedTeam() {
    const teams = STATE.teams || [];
    if (!teams.length) return null;
    const focusFid = STATE.capFocusedTeamFid || (STATE.me && STATE.me.franchise_id) || teams[0].fid;
    return teams.find(function (t) { return t.fid === focusFid; }) || teams[0];
  }

  function renderCapDetail() {
    const teams = STATE.teams;
    if (!teams.length) return '<div class="fo-placeholder">No teams loaded.</div>';
    const team = capFocusedTeam();
    const yr0 = safeInt(SEASON, 0);
    const opts = teams.map(function (t) {
      return `<option value="${escapeHtml(t.fid)}" ${t.fid === team.fid ? "selected" : ""}>${escapeHtml(t.name)}</option>`;
    }).join("");

    // The preview count + its Clear control moved OUT of this toolbar and into
    // the scenario bar inside #fo-cap-detail-body (renderCapScenarioBar), which
    // re-renders on every keystroke — the toolbar does not, so a saved/unsaved
    // indicator parked here would go stale while an editor is open. Same id, so
    // the existing click delegation is unchanged, and there is still exactly ONE
    // clear control.

    // Detail filters (Keith 2026-06-04) — reuse the Summary filter state +
    // control IDs so the existing wireCapTab change-handlers + click delegation
    // pick them up. pos / years / status only (the Type filter stays hidden,
    // pending the universal-contract pass, same as Summary).
    const f = STATE.capSummaryFilters;
    const posChips = ["ALL", "QB", "RB", "WR", "TE", "PK", "PN", "IDP"].map(function (pos) {
      const on = (f.pos || "ALL") === pos;
      return `<button type="button" class="fo-pos-chip ${on ? "active" : ""}" data-cap-pos="${pos}">${pos === "ALL" ? "All" : pos}</button>`;
    }).join("");

    return `
      <div class="fo-card">
        <div class="fo-toolbar-row">
          <label class="fo-field">
            <span>Team</span>
            <select id="fo-cap-team-select">${opts}</select>
          </label>
          <button type="button" class="btn secondary" id="fo-cap-back-summary">← Back to Summary</button>
        </div>
        <div class="fo-toolbar-row" style="margin-top:8px;">
          <div class="fo-pos-chips" id="fo-cap-pos-chips">${posChips}</div>
          <input type="hidden" id="fo-cap-filter-type" value="${escapeHtml(f.type || "")}">
          <label class="fo-field"><span>Yrs Remaining</span>
            <select id="fo-cap-filter-years">
              ${capYearOptionsHtml(f)}
            </select>
          </label>
          <label class="fo-field"><span>Roster Status</span>
            <select id="fo-cap-filter-status">
              <option value="">All</option>
              <option value="active" ${f.status === "active" ? "selected" : ""}>Active</option>
              <option value="taxi"   ${f.status === "taxi"   ? "selected" : ""}>Taxi</option>
              <option value="ir"     ${f.status === "ir"     ? "selected" : ""}>IR</option>
            </select>
          </label>
          <button type="button" class="btn secondary" id="fo-cap-reset">Reset filters</button>
        </div>
      </div>
      <div class="fo-card" id="fo-cap-detail-body">
        ${renderCapDetailBody(team)}
      </div>`;
  }

  // ── Stable player order for Cap Plan Detail ─────────────────────────
  // Re-renders MUST NOT shuffle rows when previews toggle. We compute
  // the player order once per team and reuse it. Only `recomputeCapDetailOrder()`
  // (called on team switch or header click) changes the order.
  function recomputeCapDetailOrder(team) {
    const sort = STATE.capDetailSort;
    const sortedIds = (team.players || []).slice().sort(function (a, b) {
      let va, vb;
      const k = sort.key;
      if      (k === "y0")    { va = projectedPlayerCapForOffset(a, 0); vb = projectedPlayerCapForOffset(b, 0); }
      else if (k === "y1")    { va = projectedPlayerCapForOffset(a, 1); vb = projectedPlayerCapForOffset(b, 1); }
      else if (k === "y2")    { va = projectedPlayerCapForOffset(a, 2); vb = projectedPlayerCapForOffset(b, 2); }
      else if (k === "name")  { va = a.name; vb = b.name; }
      else if (k === "pos")   { va = posBucket(a.position); vb = posBucket(b.position); }
      else if (k === "type")  { va = a.type; vb = b.type; }
      else if (k === "years") { va = safeInt(a.years, 0); vb = safeInt(b.years, 0); }
      else if (k === "status"){ va = rosterStatusLabel(a); vb = rosterStatusLabel(b); }
      else                    { va = projectedPlayerCapForOffset(a, 0); vb = projectedPlayerCapForOffset(b, 0); }
      if (typeof va === "number") return ((va || 0) - (vb || 0)) * sort.dir;
      return String(va || "").localeCompare(String(vb || "")) * sort.dir;
    }).map(function (p) { return p.id; });
    STATE.capDetailOrder = sortedIds;
    STATE.capDetailOrderForFid = team.fid;
  }

  // ── Roster-rule counters + per-year headcount (rendered inside the Detail
  //    body so they move with every keystroke, like the money totals) ────
  function capLimitCls(n, max, min) {
    if (n > max) return "over";
    if (n === max) return "at";
    if (min != null && n < min) return "under";
    return "";
  }
  function renderCapRosterCounters(team) {
    const yr0 = safeInt(SEASON, 0);
    const roster = (team && team.players) || [];
    if (!roster.length) {
      return '<div class="fo-cap-rules-empty">No players on this roster, so there are no roster counts to show.</div>';
    }
    const rules = capRosterRuleCounts(team);

    // Per-year headcount. Presence comes from capProjectedRosterSlotForOffset,
    // which mirrors the money grid branch for branch — so a MYAC/extension that
    // buys a year shows up as a body in that year, and a drop empties all three.
    const yearsHtml = [0, 1, 2].map(function (off) {
      const c = capYearRosterCounts(team, off);
      const aCls = capLimitCls(c.active, ACTIVE_MAX, ACTIVE_MIN);
      const tCls = capLimitCls(c.taxi, TAXI_MAX);
      const flags = [];
      if (c.active > ACTIVE_MAX) flags.push('<span class="flag over">over the ' + ACTIVE_MAX + "-man active max</span>");
      else if (c.active < ACTIVE_MIN) {
        // The 27-man floor bites in the auction window. A FUTURE year sitting
        // under it is normal — contracts expire and you refill — so it's framed
        // as a gap to close, not a violation you're currently committing.
        flags.push(off === 0
          ? '<span class="flag under">under the ' + ACTIVE_MIN + "-man active min</span>"
          : '<span class="flag under">' + (ACTIVE_MIN - c.active) + " short of " + ACTIVE_MIN + " — refill at the auction</span>");
      }
      if (c.taxi > TAXI_MAX) flags.push('<span class="flag over">over the ' + TAXI_MAX + "-man taxi max</span>");
      // IR gets its own §B1 bucket, so it is NOT inside the active count — but
      // canon (§B3) sets NO team-side IR limit (MFL's setting is effectively
      // unlimited), so unlike Active/Taxi it renders with no "/ max" fraction.
      const irLine = '<span class="line">IR <strong>' + c.ir + "</strong></span>";
      // Loaded/3-year contract limits (§C2) ARE projected per year now, same as
      // Active/Taxi: "loaded" describes how a contract's TOTAL money is split
      // across every year it covers, so it doesn't change offset to offset —
      // only whether the contract is still present does (capYearLoadedThreeCounts
      // reuses the same capProjectedRosterSlotForOffset presence test). "3-Yr"
      // is a years-REMAINING test, so it decrements with the offset exactly like
      // the presence check already does. Offset 0 keeps using capRosterRuleCounts
      // (rules.loadedNext/threeNext) — the already-shipped, already-verified
      // current-year numbers — so this projection only ever adds NEW data,
      // never risks nudging today's card.
      const lt = off === 0
        ? { loaded: rules.loadedNext, three: rules.threeNext }
        : capYearLoadedThreeCounts(team, off);
      const lCls = capLimitCls(lt.loaded, LOADED_MAX);
      const thCls = capLimitCls(lt.three, THREEYR_MAX);
      if (lt.loaded > LOADED_MAX) flags.push('<span class="flag over">over the ' + LOADED_MAX + "-loaded cap</span>");
      else if (lt.loaded === LOADED_MAX) flags.push('<span class="flag at">at the ' + LOADED_MAX + "-loaded cap</span>");
      if (lt.three > THREEYR_MAX) flags.push('<span class="flag over">over the ' + THREEYR_MAX + "-year cap</span>");
      else if (lt.three === THREEYR_MAX) flags.push('<span class="flag at">at the ' + THREEYR_MAX + "-year cap</span>");
      const capRuleLines =
        '<span class="line' + (lCls ? " " + lCls : "") + '" title="Front/back-loaded deals — the −FL / −BL suffix (§C2)">Loaded <strong>' + lt.loaded + "</strong><span class=\"of\">/ " + LOADED_MAX + "</span></span>" +
        '<span class="line' + (thCls ? " " + thCls : "") + '" title="3 years remaining, rookie deals excluded (§C2)">3-Yr <strong>' + lt.three + "</strong><span class=\"of\">/ " + THREEYR_MAX + "</span></span>";
      return '<div class="fo-cap-year">' +
        '<span class="yr">' + (yr0 + off) + "</span>" +
        '<span class="line' + (aCls ? " " + aCls : "") + '">Active <strong>' + c.active + "</strong><span class=\"of\">/ " + ACTIVE_MAX + "</span></span>" +
        '<span class="line' + (tCls ? " " + tCls : "") + '">Taxi <strong>' + c.taxi + "</strong><span class=\"of\">/ " + TAXI_MAX + "</span></span>" +
        irLine +
        capRuleLines +
        (flags.length ? '<span class="fo-cap-year-flags">' + flags.join(" ") + "</span>" : "") +
        "</div>";
    }).join("");

    // A preview whose basis wouldn't read is NOT silently counted as zero — the
    // real contract was counted, and the row says which one and why.
    const unresolvedHtml = rules.unresolved.length
      ? '<div class="fo-cap-rules-unresolved"><strong>Counted from the real contract</strong> (the preview’s basis couldn’t be read): ' +
        rules.unresolved.map(function (u) {
          return escapeHtml(u.name) + " — " + escapeHtml(u.why);
        }).join(" · ") + "</div>"
      : "";

    const _f = STATE.capSummaryFilters || {};
    const filtered = (_f.pos && _f.pos !== "ALL") || _f.type || _f.years || _f.status;
    const filterNote = filtered
      ? " These counts cover the WHOLE roster and ignore the filters above — they’re league limits, not a view of the selection."
      : "";

    return '<div class="fo-cap-years">' + yearsHtml + "</div>" +
      unresolvedHtml +
      '<p class="fo-cap-rules-foot">A player counts in a year when he is still under contract in it, read from the same contract years the money above uses — so a MYAC or extension you preview puts him in the years it buys, and a previewed drop removes him from all three. <strong>IR</strong> has its own bucket in ' +
      (yr0) + ' and is not inside that Active count; it is a current-season designation (§6.C) that doesn’t project, so in ' + (yr0 + 1) + ' and ' + (yr0 + 2) +
      ' today’s IR players are counted as <strong>Active</strong>. Expired contracts count as a <strong>body</strong> in ' + (yr0) + ' (they occupy a roster spot today) but not in later years, where they are off the books. Taxi contracts do count toward the §C2 Loaded/3-Yr limits (they’re contracts) and also sit in their own per-year Taxi column. <strong>Loaded</strong> carries forward unchanged for every year that contract is still on the books — front/back-loaded describes the whole deal, not one year of it. <strong>3-Yr</strong> is a years-<em>remaining</em> count, so it tracks a different, shrinking set of players each year — a deal with 4 years left today shows up in ' + (yr0 + 1) + "’s 3-Yr count instead of " + (yr0) + '’s.' + filterNote + "</p>";
  }

  // ── Scenario bar — Save / Restore / Reset, plus the live-vs-restored badge.
  // Lives INSIDE the Detail body (not the toolbar) so its saved/unsaved state
  // re-renders on every keystroke along with the numbers it describes. The
  // "Clear previews" control moved in here rather than gaining a competitor.
  function renderCapScenarioBar(team) {
    const fid = safeStr(team.fid);
    const n = Object.keys(STATE.capPreviews).filter(function (k) { return k.endsWith(":" + fid); }).length;
    const storageOk = !!capScenarioStorage();
    const saved = storageOk ? capScenarioLoad(fid) : null;
    const notice = (STATE.capScenarioNotice && STATE.capScenarioNotice.fid === fid) ? STATE.capScenarioNotice : null;
    const savedWhen = saved ? capScenarioWhen(saved.saved_at) : "";
    const inSync = saved ? (capScenarioCanon(capScenarioSnapshot(team)) === capScenarioCanon(saved.scenario)) : false;

    let badge;
    if (!n) badge = '<span class="fo-cap-scn-badge live">LIVE ROSTER · no previews</span>';
    else if (notice && notice.kind === "restored") {
      badge = '<span class="fo-cap-scn-badge restored">RESTORED SCENARIO' + (notice.edited ? " · edited since" : "") + "</span>";
    } else badge = '<span class="fo-cap-scn-badge working">WORKING PLAN · ' + n + " preview" + (n === 1 ? "" : "s") + "</span>";

    const syncBadge = !n ? ""
      : (saved ? (inSync
          ? '<span class="fo-cap-scn-sync ok">matches the saved scenario</span>'
          : '<span class="fo-cap-scn-sync off">unsaved changes vs the saved scenario</span>')
        : '<span class="fo-cap-scn-sync off">not saved</span>');

    const btns = [];
    if (storageOk) {
      btns.push('<button type="button" class="btn small" id="fo-cap-scenario-save"' + (n ? "" : " disabled") +
        ' title="' + (n ? "Save this plan in THIS BROWSER only — Cap Planning never writes to MFL."
                        : "Build at least one preview first.") + '">Save scenario</button>');
      if (saved) {
        btns.push('<button type="button" class="btn small secondary" id="fo-cap-scenario-restore" title="Re-apply the saved plan. Anything whose player left the roster or whose contract changed is dropped, and listed.">Restore saved' +
          (savedWhen ? " · " + escapeHtml(savedWhen) : "") + "</button>");
        btns.push('<button type="button" class="btn small secondary" id="fo-cap-scenario-discard" title="Delete the saved scenario for this team from this browser.">Discard saved</button>');
      }
    }
    if (n) {
      btns.push('<button type="button" class="btn small secondary" id="fo-cap-clear-previews" title="Clear every preview and editor draft for this team. The saved scenario is left alone.">Reset scenario · ' +
        n + " preview" + (n === 1 ? "" : "s") + "</button>");
    }

    let msg = "";
    if (!storageOk) {
      msg = '<div class="fo-cap-scn-msg warn">Saving is unavailable — this browser is blocking page storage (private mode, or a partitioned storage context inside the MFL embed). Previews still work; they just won’t survive a reload.</div>';
    } else if (notice && notice.kind === "saved") {
      msg = '<div class="fo-cap-scn-msg ok">Saved ' + notice.count + " preview" + (notice.count === 1 ? "" : "s") +
        " to this browser" + (notice.at ? " at " + escapeHtml(capScenarioWhen(notice.at)) : "") +
        ". Nothing was sent to MFL.</div>";
    } else if (notice && notice.kind === "restored") {
      msg = '<div class="fo-cap-scn-msg ' + (notice.dropped.length ? "warn" : "ok") + '">Restored ' +
        notice.count + " preview" + (notice.count === 1 ? "" : "s") +
        (notice.at ? " saved " + escapeHtml(capScenarioWhen(notice.at)) : "") +
        (notice.dropped.length ? " · " + notice.dropped.length + " dropped as stale" : " · nothing stale") + ".</div>";
    }
    const drops = (notice && notice.dropped && notice.dropped.length)
      ? '<ul class="fo-cap-scn-drops">' + notice.dropped.map(function (d) {
          return "<li><strong>" + escapeHtml(d.name) + "</strong> — " + escapeHtml(d.why) + "</li>";
        }).join("") + "</ul>"
      : "";

    return '<div class="fo-cap-scn">' +
      '<div class="fo-cap-scn-head">' + badge + syncBadge +
        '<span class="fo-cap-scn-actions">' + btns.join(" ") + "</span></div>" +
      msg + drops +
      '<div class="fo-cap-scn-foot">Scenarios are stored in this browser only, keyed to league ' + escapeHtml(String(LEAGUE_ID)) +
      " · season " + escapeHtml(String(SEASON)) + " · " + escapeHtml(safeStr(team.name)) +
      ". Cap Planning never writes to MFL.</div></div>";
  }

  function renderCapDetailBody(team) {
    const yr0 = safeInt(SEASON, 0);
    // Compute order only if team changed or no order yet — otherwise
    // preserve. Header click clears order via recomputeCapDetailOrder.
    if (STATE.capDetailOrderForFid !== team.fid || !STATE.capDetailOrder.length) {
      recomputeCapDetailOrder(team);
    }
    const byId = Object.create(null);
    (team.players || []).forEach(function (p) { byId[p.id] = p; });
    const allOrdered = STATE.capDetailOrder.map(function (pid) { return byId[pid]; }).filter(Boolean);
    // Apply the Detail filters (pos / years / status) to the visible rows.
    // Taxi players appear unless a status filter excludes them.
    const players = allOrdered.filter(function (p) { return capSummaryPlayerMatches(p, STATE.capSummaryFilters); });
    const _f = STATE.capSummaryFilters || {};
    const anyFilter = (_f.pos && _f.pos !== "ALL") || _f.type || _f.years || _f.status;
    const filteredNote = players.length < allOrdered.length
      ? ` <span class="small" style="color:var(--muted);">· filtered: ${players.length} of ${allOrdered.length} shown (totals reflect the selection)</span>`
      : "";
    // Year totals reflect the FILTERED selection (Keith 2026-06-06: "summaries in
    // cap planning should filter down based on the filtered selection").
    const totals = {
      cy:  players.reduce(function (s, p) { return s + projectedPlayerCapForOffset(p, 0); }, 0),
      ny:  players.reduce(function (s, p) { return s + projectedPlayerCapForOffset(p, 1); }, 0),
      ny2: players.reduce(function (s, p) { return s + projectedPlayerCapForOffset(p, 2); }, 0)
    };
    // Team-level cap adjustments (drop pen / traded $ / other) are team-WIDE, not
    // per-player, so they only apply to the full-roster view — excluded (callout
    // hidden) when a filter is active, consistent with the Summary %.
    const _adj = team.summary || {};
    const adjTotal = anyFilter ? 0 : capAdjTotal(_adj);
    // Previewed-drop dead-cap — a "drop" preview's penalty is a CAP ADJUSTMENT,
    // NOT a salary line (Keith 2026-06-07). The dropped player already
    // contributes $0 to totals.cy (projectedPlayerCapForOffset).
    //
    // WHICH SEASON it lands on is §D1: before the Auction Roster Lock it hits
    // the current season; from AUCTION START through end of season it hits the
    // FOLLOWING one. The 2026 auction opened 2026-07-25, so a cut previewed now
    // is next year's money — showing it against this year overstated the current
    // cap and understated the next (Keith 2026-08-01).
    const previewDropPen = players.reduce(function (s, p) {
      return STATE.capPreviews[p.id + ":" + p.fid] === "drop" ? s + safeInt(dropPenaltyEstimate(p).amount, 0) : s;
    }, 0);
    const penNextSeason = dropPenaltyLandsNextSeason();
    const penCy = penNextSeason ? 0 : previewDropPen;
    const penNy = penNextSeason ? previewDropPen : 0;
    const adjustedCy = totals.cy + adjTotal + penCy;
    const adjustedNy = totals.ny + penNy;
    // ONE set of 3 year numbers, not a raw-salary strip plus a competing
    // "adjusted cap" box underneath (Keith 2026-08-03: the two boxes didn't
    // visually add up). Each column's big number IS the true total — salary +
    // whatever adjustments land in that specific year, §D1-routed by
    // penCy/penNy exactly as before. A small note under a column (when it has
    // a nonzero adjustment) shows the raw-salary breakdown so the adjustment
    // stays visible rather than getting buried inside one number.
    const noteCy = [];
    if (adjTotal) noteCy.push((adjTotal > 0 ? "+" : "−") + fmtUSD(Math.abs(adjTotal)) + " adj");
    if (previewDropPen && !penNextSeason) noteCy.push("+" + fmtUSD(previewDropPen) + " previewed drop");
    const noteNy = [];
    if (previewDropPen && penNextSeason) noteNy.push("+" + fmtUSD(previewDropPen) + " previewed drop (§D1)");
    const totalsNote = function (parts, rawSalary, title) {
      return parts.length
        ? `<span class="fo-cap-totals-note" title="${escapeHtml(title)}">${fmtUSD(rawSalary)} salary ${parts.join(" · ")}</span>`
        : "";
    };
    // Projected-tag-value badge (Keith 2026-08-04: link tag cost from a Cap
    // Planning row into the fixed Tag Calc Breakdown table). Needs the SAME
    // tag data the Tag tab uses — loaded lazily here too, non-blocking, so a
    // commissioner who opens Cap Planning first still gets it without
    // visiting the Tag tab first.
    if (!STATE.tagData && !STATE.tagDataLoading) loadTagPlanData().then(renderCapTab);
    if (!STATE.tagPointsData && !STATE.tagPointsDataLoading) loadTagPointsData().then(renderCapTab);
    const tagCb = STATE.tagData ? projectedCalcBreakdown() : {};
    const tagLookup = Object.keys(tagCb).length ? buildTagTierLookup(tagCb) : null;
    const rows = players.map(function (p) { return renderCapDetailRow(p, team, tagCb, tagLookup); }).join("")
      || '<tr><td colspan="9" class="fo-table-empty">No players match the current filters.</td></tr>';
    const sort = STATE.capDetailSort;
    const arrow = (key) => sort.key === key ? (sort.dir > 0 ? " ▲" : " ▼") : "";
    return `
      <p class="fo-row-hint">
        💡 Click <strong>Ext1 / Ext2 / MYAC2 / MYAC3 / MYAC2-L / MYAC3-L / Drop / Promote / Restr</strong> on any row to preview the impact on team totals (toggle off by clicking again). <strong>MYAC2 / MYAC3</strong> are flat (even-split) auction contracts. <strong>MYAC2-L / MYAC3-L</strong> open an inline editor for a <em>loaded</em> auction contract — the same TCV split front- or back-loaded, so ${yr0} moves too. <strong>Restr</strong> opens an inline editor to re-slot the same contract total across the remaining years. Either editor moves the year totals above as you type — this screen is <strong>planning only</strong> and never writes to MFL; apply a contract on the <strong>Contracts</strong> tab. Taxi players show here too (Promote to preview activating them). Row click opens the slide-over. Click any column header to sort.
      </p>
      <div class="fo-cap-totals">
        <div><span class="lbl">${yr0} cap</span><span class="val">${fmtUSD(adjustedCy)}</span>${totalsNote(noteCy, totals.cy, "Cap adjustments (drop pen · traded $ · other) from MFL's salaryAdjustments feed, plus any previewed-drop dead cap landing this season. Planning only — not written to MFL.")}</div>
        <div><span class="lbl">${yr0 + 1}</span><span class="val">${fmtUSD(adjustedNy)}</span>${totalsNote(noteNy, totals.ny, "§D1 — a cut previewed from the auction start through end of season lands on the FOLLOWING season's cap, not this one. Planning only — not written to MFL.")}</div>
        <div><span class="lbl">${yr0 + 2}</span><span class="val">${fmtUSD(totals.ny2)}</span></div>
      </div>
      ${renderCapRosterCounters(team)}
      ${renderCapScenarioBar(team)}
      ${filteredNote ? `<div style="margin:6px 0 0;">${filteredNote}</div>` : ""}
      <table class="fo-table">
        <thead>
          <tr>
            <th data-cap-detail-sort="name">Player${arrow("name")}</th>
            <th data-cap-detail-sort="pos">Pos${arrow("pos")}</th>
            <th data-cap-detail-sort="type">Type${arrow("type")}</th>
            <th class="col-lo num" data-cap-detail-sort="years">Yrs Rem${arrow("years")}</th>
            <th class="num" data-cap-detail-sort="y0">${yr0}${arrow("y0")}</th>
            <th class="num" data-cap-detail-sort="y1">${yr0 + 1}${arrow("y1")}</th>
            <th class="num" data-cap-detail-sort="y2">${yr0 + 2}${arrow("y2")}</th>
            <th>Preview</th>
            <th class="col-lo" data-cap-detail-sort="status">Status${arrow("status")}</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>`;
  }

  function renderCapDetailRow(p, team, tagCb, tagLookup) {
    const cy  = projectedPlayerCapForOffset(p, 0);
    const ny  = projectedPlayerCapForOffset(p, 1);
    const ny2 = projectedPlayerCapForOffset(p, 2);
    const elig = rosterContractEligibility(p);
    const key = p.id + ":" + p.fid;
    const active = STATE.capPreviews[key] || "";
    const opts = effectiveExtensionPreviews(p);
    const has1 = opts.some(function (o) { return (safeInt(o.years,0) || safeInt(o.yearsToAdd,0)) === 1; });
    const has2 = opts.some(function (o) { return (safeInt(o.years,0) || safeInt(o.yearsToAdd,0)) === 2; });
    const canDrop    = !p.isTaxi && safeInt(p.years, 0) > 0;
    const canPromote = p.isTaxi && safeInt(p.years, 0) > 0; // taxi-promotion preview

    const btns = [];
    if (elig.extensionEligible && has1) {
      btns.push(`<button class="btn small ${active === "ext1" ? "" : "secondary"} fo-cap-prev-btn" data-preview="ext1" data-pid="${escapeHtml(p.id)}" data-fid="${escapeHtml(team.fid)}">Ext1</button>`);
    }
    if (elig.extensionEligible && has2) {
      btns.push(`<button class="btn small ${active === "ext2" ? "" : "secondary"} fo-cap-prev-btn" data-preview="ext2" data-pid="${escapeHtml(p.id)}" data-fid="${escapeHtml(team.fid)}">Ext2</button>`);
    }
    // MYAC previews for auction-won 1-yr defaults (§C2) — show the future-year
    // cap commitment if converted to a 2/3-yr contract. MYAC2 / MYAC3 are the
    // flat (even-split) shapes; MYAC2-L / MYAC3-L open the inline loaded editor
    // where the same TCV is split front- or back-loaded across the new deal.
    // Driven by the ACTIVE preview, not by eligibility, so the editor row and
    // projectedPlayerCapForOffset always agree: whenever the overlay is moving
    // this row's numbers there is an editor under it saying why, and whenever
    // the basis stops resolving both fall back to the real contract together.
    // (Eligibility can lapse under an open preview — the deadline passes, the
    // roster reloads — and silently-shifted totals with no visible editor would
    // be the worst of both. handleCapMyacLoadedAction re-checks eligibility, so
    // a lapsed row can still be studied but never committed.)
    let mlEval = null;
    if (active === "myacl2" || active === "myacl3") {
      mlEval = capMyacLoadedEval(p, active === "myacl3" ? 3 : 2);
    }
    if (elig.myacEligible) {
      btns.push(`<button class="btn small ${active === "myac2" ? "" : "secondary"} fo-cap-prev-btn" data-preview="myac2" data-pid="${escapeHtml(p.id)}" data-fid="${escapeHtml(team.fid)}" title="Flat 2-year auction contract">MYAC2</button>`);
      btns.push(`<button class="btn small ${active === "myac3" ? "" : "secondary"} fo-cap-prev-btn" data-preview="myac3" data-pid="${escapeHtml(p.id)}" data-fid="${escapeHtml(team.fid)}" title="Flat 3-year auction contract">MYAC3</button>`);
      [2, 3].forEach(function (n) {
        const kind = "myacl" + n;
        const ev = (kind === active && mlEval) ? mlEval : capMyacLoadedEval(p, n);
        // Taxi is excluded for the same reason restructure is: a taxi player's
        // cap hit is $0 in every year (§6.E), so a loaded split has nothing to
        // move. Unreadable basis (no 1-yr default, salary under $1,000) is
        // likewise DISABLED with the reason in the tooltip — never quietly
        // backfilled into a plausible-looking projection.
        const blocked = p.isTaxi
          ? "taxi salaries are off-cap (§6.E), so every year of a loaded split would still project $0."
          : (ev.ok ? "" : ev.reason);
        if (blocked) {
          btns.push(`<button class="btn small secondary" disabled data-pid="${escapeHtml(p.id)}" data-fid="${escapeHtml(team.fid)}" title="Loaded ${n}-year MYAC unavailable — ${escapeHtml(blocked)}" style="opacity:.45; cursor:not-allowed;">MYAC${n}-L</button>`);
          return;
        }
        btns.push(`<button class="btn small ${active === kind ? "" : "secondary"} fo-cap-prev-btn" data-preview="${kind}" data-pid="${escapeHtml(p.id)}" data-fid="${escapeHtml(team.fid)}" title="Loaded ${n}-year auction contract — split ${fmtUSD(ev.tcv)} across ${n} years, front- or back-loaded (${ev.loadedNow}/${LOADED_MAX} loaded used)">MYAC${n}-L</button>`);
      });
    }
    if (canDrop) {
      btns.push(`<button class="btn small ${active === "drop" ? "warn" : "secondary"} fo-cap-prev-btn" data-preview="drop" data-pid="${escapeHtml(p.id)}" data-fid="${escapeHtml(team.fid)}">Drop</button>`);
    }
    if (canPromote) {
      btns.push(`<button class="btn small ${active === "promote" ? "ok" : "secondary"} fo-cap-prev-btn" data-preview="promote" data-pid="${escapeHtml(p.id)}" data-fid="${escapeHtml(team.fid)}">Promote</button>`);
    }
    // Restructure (§C5) — inline multi-year editor. Offered on the same terms
    // the Contracts sub-tab uses (rosterContractEligibility.restructureEligible);
    // taxi is excluded because a taxi player's cap hit is $0 in every year, so
    // there is nothing to re-slot. When the contract's remaining-year salaries
    // can't be read the button is DISABLED with the reason in its tooltip —
    // never silently backfilled from player.salary.
    let rsEval = null;
    if (elig.restructureEligible && !p.isTaxi) {
      rsEval = capRestructureEval(p);
      btns.push(rsEval.ok
        ? `<button class="btn small ${active === "restructure" ? "" : "secondary"} fo-cap-prev-btn" data-preview="restructure" data-pid="${escapeHtml(p.id)}" data-fid="${escapeHtml(team.fid)}" title="Re-slot ${fmtUSD(rsEval.tcv)} across the remaining ${rsEval.years} years">Restr</button>`
        : `<button class="btn small secondary" disabled data-pid="${escapeHtml(p.id)}" data-fid="${escapeHtml(team.fid)}" title="Restructure unavailable — ${escapeHtml(rsEval.reason)}" style="opacity:.45; cursor:not-allowed;">Restr</button>`);
    }
    const previewCell = btns.length ? btns.join(" ") : '<span class="small" style="color:var(--muted);">—</span>';
    const rsActive = active === "restructure" && rsEval && rsEval.ok;
    // Taxi is excluded here too — projectedPlayerCapForOffset returns $0 for a
    // taxi player before the overlay can run (§6.E), so an editor claiming to
    // move money would contradict the grid.
    const mlActive = !p.isTaxi && mlEval && mlEval.ok;

    // Row class — drop gets a red tint so it's obvious; promote gets
    // a green tint; ext gets the existing blue. Keith 2026-05-19:
    // "Drop should show as red and indicate penalty so we know."
    // Restructure gets violet and loaded MYAC teal, each with a distinct dashed
    // treatment when the draft is incoherent (the grid is then showing REAL
    // numbers, not the draft).
    let rowClass = "";
    if (active === "drop")                      rowClass = "fo-cap-row-drop";
    else if (active === "promote")              rowClass = "fo-cap-row-promote";
    else if (rsActive)                          rowClass = rsEval.coherent ? "fo-cap-row-restructure" : "fo-cap-row-rs-invalid";
    else if (mlActive)                          rowClass = mlEval.coherent ? "fo-cap-row-myacl" : "fo-cap-row-rs-invalid";
    else if (active === "ext1" || active === "ext2" || active === "myac2" || active === "myac3") rowClass = "fo-cap-row-active";

    // Money cell under a DRAFTED preview (restructure or loaded MYAC) — shows
    // the drafted number plus what it WAS (the real projection, recomputed with
    // the preview ignored). Only a coherent draft is projected, so an
    // in-progress one keeps the real numbers and shows no "was".
    const draftProjected = (rsActive && rsEval.coherent) || (mlActive && mlEval.coherent);
    const draftMoneyCell = function (off, val) {
      if (!draftProjected) return fmtUSD(val);
      const was = projectedPlayerCapForOffset(p, off, true);
      if (was === val) return fmtUSD(val);
      return `${fmtUSD(val)} <span class="fo-cap-was ${val > was ? "up" : "down"}" title="Current contract: ${fmtUSD(was)}">was ${fmtUSD(was)}</span>`;
    };

    // Y+0 cell annotation when dropping — "(penalty)" makes the cap charge
    // unmistakable vs a salary.
    const y0Cell = active === "drop"
      ? `<span class="fo-cap-pen">${fmtUSD(0)}</span> <span class="small" style="color:var(--err); font-style:italic;">(cut · +${fmtUSD(safeInt(dropPenaltyEstimate(p).amount, 0))} dead cap → ${dropPenaltyLandsNextSeason() ? String(safeInt(SEASON, 0) + 1) + " adj" : "adj"})</span>`
      : draftMoneyCell(0, cy);

    const statusKls = active === "drop" ? "drop-preview"
                     : active === "promote" ? "active"
                     : rsActive ? "rs-preview"
                     : mlActive ? "ml-preview"
                     : rosterStatusClass(p);
    const statusLbl = active === "drop" ? "DROPPED"
                     : active === "promote" ? "→ ACTIVE"
                     : rsActive ? (rsEval.coherent ? "RESTR (draft)" : "DRAFT ✗")
                     : mlActive ? (mlEval.coherent
                         ? (mlEval.loadedShape ? "MYAC" + mlEval.suffix + " (draft)" : "MYAC FLAT (draft)")
                         : "DRAFT ✗")
                     : rosterStatusLabel(p);

    // Projected tag-value badge — only for an untouched row (an active
    // preview already means the row is about something else this season;
    // showing a NEXT-season tag figure under "DROPPED"/"RESTR (draft)" would
    // read as if it applied to the preview). Reuses the exact same calc the
    // Tag tab's projected table uses (computeProjectedTagValue), so the two
    // screens can never disagree.
    let tagBadge = "";
    if (!active && tagLookup) {
      const tv = computeProjectedTagValue(p, tagCb, tagLookup, true);
      if (tv) {
        tagBadge = ` <button type="button" class="fo-cap-tag-badge" data-pid="${escapeHtml(p.id)}" data-fid="${escapeHtml(team.fid)}" title="Projected ${safeInt(SEASON, 0) + 1} tag cost (${tv.tier_label}) — click to open the Tag Calc Breakdown">🏷 ${fmtUSD(tv.tag_value)}</button>`;
      }
    }

    const mainRow = `
      <tr class="${rowClass}" data-pid="${escapeHtml(p.id)}" data-fid="${escapeHtml(team.fid)}">
        <td>${escapeHtml(p.name)}</td>
        <td><span class="fo-pos ${escapeHtml(posBucket(p.position))}">${escapeHtml(p.position)}</span></td>
        <td><span class="fo-ctype ${ctypeClass(p.type)}">${escapeHtml(String(p.type || "—").toUpperCase())}</span></td>
        <td class="col-lo num">${safeInt(p.years, 0) || "—"}</td>
        <td class="num">${y0Cell}</td>
        <td class="num">${draftMoneyCell(1, ny)}</td>
        <td class="num">${draftMoneyCell(2, ny2)}</td>
        <td>${previewCell}</td>
        <td class="col-lo"><span class="fo-status ${statusKls}">${escapeHtml(statusLbl)}</span>${tagBadge}</td>
      </tr>`;
    // The editor is a SIBLING <tr> right under the player's row (not a modal)
    // so the year totals stay on screen while the owner types.
    if (rsActive) return mainRow + renderCapRestructureEditorRow(p, team, rsEval);
    if (mlActive) return mainRow + renderCapMyacLoadedEditorRow(p, team, mlEval);
    return mainRow;
  }

  // Inline restructure editor (§C5) — one <tr>, colspan the full grid.
  // Purely a planning surface: Commit hands the drafted year amounts to
  // submitRestructure(), which owns validation, the confirm and the POST.
  function renderCapRestructureEditorRow(p, team, ev) {
    const yr0 = safeInt(SEASON, 0);
    const domKey = ev.key.replace(/[^A-Za-z0-9]/g, "_");
    const me = STATE.me || {};
    const isMine = !!me.franchise_id && pad4(me.franchise_id) === pad4(p.fid);
    const canCommit = isMine || !!me.isAdmin;
    const inputs = ev.amounts.map(function (v, i) {
      const changed = v !== ev.real[i];
      return `
        <label class="fo-cap-rs-field">
          <span class="lbl">${yr0 + i}</span>
          <input type="text" inputmode="numeric" autocomplete="off" spellcheck="false"
                 class="fo-cap-rs-input${changed ? " changed" : ""}"
                 id="fo-cap-rs-in-${domKey}-${i}"
                 data-rs-key="${escapeHtml(ev.key)}" data-rs-idx="${i}"
                 value="${v}">
          <span class="was">now ${fmtUSD(ev.real[i])}</span>
        </label>`;
    }).join("");
    // §C5 3-per-season usage — INFORMATION ONLY (Keith 2026-07-31: no hard
    // block here). Rendered only when the ledger happens to be loaded already;
    // the Cap tab never fetches it just to show a number.
    const usage = STATE.restructureUsage
      ? ` · <span title="Informational only — not enforced here.">team restructures used this season: ${restructureUsedForFid(p.fid)}/${RESTRUCTURE_LIMIT}</span>`
      : "";
    let msgKls = "ok", msg;
    if (!ev.coherent) {
      msgKls = "warn";
      msg = "Draft not applied — the grid above is showing the real contract. " + ev.err;
    } else if (!ev.legal) {
      msgKls = "warn";
      msg = "Projected above, but this can't be submitted: " + ev.err;
    } else if (!ev.dirty) {
      msgKls = "muted";
      msg = "Unchanged — this is the current contract. Move money between years to see the impact.";
    } else {
      msg = "Σ balances. Commit submits the restructure for confirmation.";
    }
    const commitTitle = !canCommit
      ? "Only " + safeStr(p.franchise || team.name) + " (or the commish) can commit this — preview only."
      : (ev.submittable ? "Submit this restructure"
         : (ev.legal && !ev.dirty ? "Nothing to submit — move money between years first."
            : "Balance the years first: " + ev.err));
    return `
      <tr class="fo-cap-rs-editor-row" data-rs-key="${escapeHtml(ev.key)}">
        <td colspan="9">
          <div class="fo-cap-rs-editor">
            <div class="fo-cap-rs-head">
              <strong>Restructure ${escapeHtml(p.name)}</strong>
              <span class="small">re-slot the same total across the remaining ${ev.years} year${ev.years === 1 ? "" : "s"} · required total (TCV) <strong>${fmtUSD(ev.tcv)}</strong> · ${yr0} ≥ ${fmtUSD(ev.minY1)} (20% TCV) · whole $1,000s, no $0 year${usage}</span>
            </div>
            <div class="fo-cap-rs-inputs">${inputs}</div>
            <div class="fo-cap-rs-sum">
              <span>Σ <strong class="${ev.sum === ev.tcv ? "bal" : "off"}">${fmtUSD(ev.sum)}</strong> / ${fmtUSD(ev.tcv)}</span>
              <span class="${ev.left === 0 ? "bal" : "off"}">${ev.left === 0 ? "fully allocated" : (ev.left > 0 ? fmtUSD(ev.left) + " left to allocate" : fmtUSD(-ev.left) + " over")}</span>
            </div>
            <div class="fo-cap-rs-msg ${msgKls}">${escapeHtml(msg)}</div>
            <div class="fo-cap-rs-actions">
              <button type="button" class="btn small secondary fo-cap-rs-balance" data-rs-key="${escapeHtml(ev.key)}" data-pid="${escapeHtml(p.id)}" data-fid="${escapeHtml(team.fid)}" title="Set ${yr0 + ev.years - 1} to whatever is left so Σ = TCV">Balance ${yr0 + ev.years - 1}</button>
              <button type="button" class="btn small secondary fo-cap-rs-reset" data-rs-key="${escapeHtml(ev.key)}" data-pid="${escapeHtml(p.id)}" data-fid="${escapeHtml(team.fid)}">Reset to current</button>
              <span class="small fo-cap-planonly" title="Cap Planning models contracts; it never writes to MFL. Apply this on the Contracts tab.">Planning only — not written to MFL. Apply on <strong>Contracts</strong>.</span>
            </div>
          </div>
        </td>
      </tr>`;
  }

  // Inline LOADED-MYAC editor (§C2) — one <tr>, colspan the full grid, same
  // shape as the restructure editor above. Purely a planning surface: Commit
  // hands the drafted year amounts to submitMyacContract(), which owns the
  // FL/BL suffix, GTD, contractInfo, the confirm dialog and the POST.
  function renderCapMyacLoadedEditorRow(p, team, ev) {
    const yr0 = safeInt(SEASON, 0);
    const domKey = ev.key.replace(/[^A-Za-z0-9]/g, "_");
    const me = STATE.me || {};
    const isMine = !!me.franchise_id && pad4(me.franchise_id) === pad4(p.fid);
    const canCommit = isMine || !!me.isAdmin;
    // The FINAL year is derived, never typed: it is always TCV minus the years
    // above it, so the split balances by construction and "$27,000 over" can no
    // longer happen (Keith 2026-08-01). Same rule the slide-over loaded-MYAC
    // form already uses — there Y2 (2-yr) / Y3 (3-yr) is computed, not an input.
    const lastIdx = ev.amounts.length - 1;
    const inputs = ev.amounts.map(function (v, i) {
      const changed = v !== ev.flat[i];
      const derived = i === lastIdx;
      if (derived) {
        return `
        <label class="fo-cap-ml-field derived">
          <span class="lbl">${yr0 + i}</span>
          <input type="text" readonly tabindex="-1" aria-readonly="true"
                 class="fo-cap-ml-input derived${changed ? " changed" : ""}"
                 id="fo-cap-ml-in-${domKey}-${i}"
                 title="Auto — whatever is left of the ${fmtUSD(ev.tcv)} total"
                 value="${v}">
          <span class="was">auto · flat ${fmtUSD(ev.flat[i])}</span>
        </label>`;
      }
      return `
        <label class="fo-cap-ml-field">
          <span class="lbl">${yr0 + i}</span>
          <input type="text" inputmode="numeric" autocomplete="off" spellcheck="false"
                 class="fo-cap-ml-input${changed ? " changed" : ""}"
                 id="fo-cap-ml-in-${domKey}-${i}"
                 data-ml-key="${escapeHtml(ev.key)}" data-ml-idx="${i}" data-ml-years="${ev.years}"
                 value="${v}">
          <span class="was">flat ${fmtUSD(ev.flat[i])}</span>
        </label>`;
    }).join("");
    // §C2 5-loaded roster cap. Shown on EVERY draft (not just at the limit) so
    // hitting it is never a surprise; it gates Commit only — previewing a sixth
    // loaded shape is legitimate planning (you may be about to free a slot).
    const capNote = ev.atLoadedCap
      ? `<span class="fo-cap-ml-capfull" title="§C2 caps a roster at ${LOADED_MAX} front/back-loaded contracts.">loaded contracts ${ev.loadedNow}/${LOADED_MAX} — at the cap</span>`
      : `<span title="§C2 caps a roster at ${LOADED_MAX} front/back-loaded contracts (front + back combined).">loaded contracts ${ev.loadedNow}/${LOADED_MAX}</span>`;
    // Name the resulting contract status only for a draft whose arithmetic
    // actually holds — an unbalanced draft is not going to record as anything.
    const shapeLabel = !ev.loadedShape
      ? `<span class="fo-cap-ml-shape flat">FLAT — not a loaded contract</span>`
      : (ev.coherent
          ? `<span class="fo-cap-ml-shape ${ev.suffix === "-FL" ? "fl" : "bl"}">${ev.suffix === "-FL" ? "FRONT-LOADED" : "BACK-LOADED"} · records as ${escapeHtml(ev.statusBase + ev.suffix)}</span>`
          : `<span class="fo-cap-ml-shape flat">shape pending — balance Σ to ${fmtUSD(ev.tcv)} first</span>`);
    let msgKls = "ok", msg;
    if (!ev.coherent) {
      msgKls = "warn";
      msg = "Draft not applied — the grid above is showing the real contract. " + ev.err;
    } else if (!ev.legal) {
      msgKls = "warn";
      msg = "Projected above, but this can't be submitted: " + ev.err;
    } else if (!ev.dirty) {
      msgKls = "muted";
      msg = "Every year is the same — that's a flat MYAC, which the MYAC" + ev.years +
            " button already previews. Move money between years to front- or back-load it.";
    } else if (ev.atLoadedCap) {
      msgKls = "warn";
      msg = safeStr(p.franchise || team.name) + " already has " + ev.loadedNow + " of " + LOADED_MAX +
            " loaded contracts (§C2). Preview all you like — committing needs a free slot (cut or trade a loaded player, or use a flat MYAC).";
    } else {
      msg = "Σ balances. Commit submits the loaded MYAC for confirmation.";
    }
    const commitTitle = !canCommit
      ? "Only " + safeStr(p.franchise || team.name) + " (or the commish) can commit this — preview only."
      : (ev.submittable ? "Submit this " + ev.years + "-year loaded MYAC"
         : (ev.atLoadedCap ? "At the " + LOADED_MAX + "-loaded cap (§C2) — free a slot first."
            : (ev.legal && !ev.dirty ? "Flat is not loaded — move money between years first (or use MYAC" + ev.years + ")."
               : "Balance the years first: " + ev.err)));
    return `
      <tr class="fo-cap-ml-editor-row" data-ml-key="${escapeHtml(ev.key)}">
        <td colspan="9">
          <div class="fo-cap-ml-editor">
            <div class="fo-cap-ml-head">
              <strong>Loaded MYAC — ${escapeHtml(p.name)}, ${ev.years} years</strong>
              <span class="small">split the auction price across ${ev.years} years · required total (TCV) <strong>${fmtUSD(ev.tcv)}</strong> (= ${fmtUSD(ev.aav)} × ${ev.years}, no escalator) · AAV ${fmtUSD(ev.aav)} · ${yr0} ≥ ${fmtUSD(ev.minY1)} (20% TCV) · whole $1,000s, no $0 year · ${capNote}</span>
            </div>
            <div class="fo-cap-ml-inputs">${inputs}</div>
            <div class="fo-cap-ml-sum">
              <span>Σ <strong class="${ev.sum === ev.tcv ? "bal" : "off"}">${fmtUSD(ev.sum)}</strong> / ${fmtUSD(ev.tcv)}</span>
              <span class="${ev.left === 0 ? "bal" : "off"}">${ev.left === 0 ? "fully allocated" : (ev.left > 0 ? fmtUSD(ev.left) + " left to allocate" : fmtUSD(-ev.left) + " over")}</span>
              ${shapeLabel}
            </div>
            <div class="fo-cap-ml-msg ${msgKls}">${escapeHtml(msg)}</div>
            <div class="fo-cap-ml-actions">
              <button type="button" class="btn small secondary fo-cap-ml-balance" data-ml-key="${escapeHtml(ev.key)}" data-ml-years="${ev.years}" data-pid="${escapeHtml(p.id)}" data-fid="${escapeHtml(team.fid)}" title="Set ${yr0 + ev.years - 1} to whatever is left so Σ = TCV">Balance ${yr0 + ev.years - 1}</button>
              <button type="button" class="btn small secondary fo-cap-ml-reset" data-ml-key="${escapeHtml(ev.key)}" data-ml-years="${ev.years}" data-pid="${escapeHtml(p.id)}" data-fid="${escapeHtml(team.fid)}" title="Back to the even ${ev.years}-way split">Reset to flat</button>
              <span class="small fo-cap-planonly" title="Cap Planning models contracts; it never writes to MFL. Apply this on the Contracts tab.">Planning only — not written to MFL. Apply on <strong>Contracts</strong>.</span>
            </div>
          </div>
        </td>
      </tr>`;
  }

  // wireCapTab now ONLY wires the change-event filters/selects (which
  // need direct binding because change doesn't bubble usefully via
  // delegation). All click handling is delegated below, in setupCapTab,
  // and bound ONCE at init — survives every partial re-render.
  function wireCapTab() {
    const typeSel = $("#fo-cap-filter-type");
    if (typeSel) typeSel.addEventListener("change", function (e) {
      STATE.capSummaryFilters.type = e.target.value; renderCapTab();
    });
    const yearsSel = $("#fo-cap-filter-years");
    if (yearsSel) yearsSel.addEventListener("change", function (e) {
      STATE.capSummaryFilters.years = e.target.value; renderCapTab();
    });
    const statusSel = $("#fo-cap-filter-status");
    if (statusSel) statusSel.addEventListener("change", function (e) {
      STATE.capSummaryFilters.status = e.target.value; renderCapTab();
    });
    const teamSel = $("#fo-cap-team-select");
    if (teamSel) teamSel.addEventListener("change", function (e) {
      STATE.capFocusedTeamFid = e.target.value;
      STATE.capDetailOrderForFid = null; // recompute order for new team
      renderCapTab();
    });
  }

  // Bound ONCE at init on the stable Cap Plan <section>. Every click
  // inside the tab bubbles here; we dispatch by target class. Re-renders
  // can't unbind us because we're attached to the section, not the
  // buttons that get replaced.
  function setupCapTabDelegation() {
    const section = document.querySelector('.fo-section[data-section="cap"]');
    if (!section) return;
    section.addEventListener("click", function (e) {
      // Preview-toggle button (Detail).
      const prev = e.target.closest(".fo-cap-prev-btn");
      if (prev && section.contains(prev)) {
        e.stopPropagation();
        const key = prev.dataset.pid + ":" + prev.dataset.fid;
        const kind = prev.dataset.preview;
        if (STATE.capPreviews[key] === kind) delete STATE.capPreviews[key];
        else STATE.capPreviews[key] = kind;
        const nextKind = STATE.capPreviews[key];
        // Editor drafts live in parallel maps — each one is cleared whenever the
        // preview is turned off OR switched to another kind, or a stale draft
        // reappears the next time this row is previewed.
        if (nextKind !== "restructure") clearCapRestructureDraft(key);
        else {
          // Seed NEUTRAL: the contract's real remaining-year salaries, so the
          // totals don't budge until the owner actually moves money.
          const seed = capRestructureRealYears(findPlayer(prev.dataset.pid, prev.dataset.fid));
          if (seed.ok) STATE.capRestructureDrafts[key] = { amounts: seed.amounts.slice() };
          // Unresolvable → no preview at all, and drop any draft with it. The
          // preview and its draft must always move in lockstep; deleting only
          // the preview strands the old draft, which then re-applies the next
          // time this row is previewed.
          else { delete STATE.capPreviews[key]; clearCapRestructureDraft(key); }
        }
        if (nextKind !== "myacl2" && nextKind !== "myacl3") clearCapMyacLoadedDraft(key);
        else {
          // Seed NEUTRAL for a loaded MYAC = the FLAT split (AAV every year):
          // the shape the MYAC2/MYAC3 buttons already show, so the totals only
          // move once the owner front- or back-loads it.
          const mlYears = nextKind === "myacl3" ? 3 : 2;
          const seed = myacLoadedBasis(findPlayer(prev.dataset.pid, prev.dataset.fid), mlYears);
          if (seed.ok) {
            const amts = [];
            for (let i = 0; i < mlYears; i += 1) amts.push(seed.aav);
            STATE.capMyacLoadedDrafts[key] = { kind: nextKind, amounts: amts };
          } else {
            // Unresolvable → no preview at all, and the draft dies WITH it.
            // Reachable by switching kinds (myacl2 → myacl3) on a row whose
            // basis stopped resolving under the open editor — the player was
            // traded away, or a reload left them on a 2/3-yr contract. Without
            // this clear the row keeps a draft no preview points at, which is
            // exactly the residue the lockstep rule exists to prevent.
            delete STATE.capPreviews[key];
            clearCapMyacLoadedDraft(key);
          }
        }
        capScenarioMarkEdited(prev.dataset.fid);
        renderCapTab();
        return;
      }
      // Restructure editor — Balance / Reset / Commit.
      const rsBtn = e.target.closest(".fo-cap-rs-balance, .fo-cap-rs-reset");
      if (rsBtn && section.contains(rsBtn)) {
        e.stopPropagation();
        handleCapRestructureAction(rsBtn);
        return;
      }
      // Loaded-MYAC editor — Balance / Reset / Commit.
      const mlBtn = e.target.closest(".fo-cap-ml-balance, .fo-cap-ml-reset");
      if (mlBtn && section.contains(mlBtn)) {
        e.stopPropagation();
        handleCapMyacLoadedAction(mlBtn);
        return;
      }
      // Clicks inside an editor row must never fall through to the row-click
      // slide-over (the editor <tr>s deliberately carry no data-pid).
      if (e.target.closest(".fo-cap-rs-editor-row, .fo-cap-ml-editor-row")) { e.stopPropagation(); return; }
      // Projected-tag-value badge — jump to the Tag Calc Breakdown, filtered
      // to this player's team so they're easy to find.
      const tagBadge = e.target.closest(".fo-cap-tag-badge");
      if (tagBadge && section.contains(tagBadge)) {
        e.stopPropagation();
        const badgeTeam = findTeamById(tagBadge.dataset.fid);
        STATE.tagSubview = "breakdown";
        STATE.tagBreakdownYear = safeInt(SEASON, 0) + 1;
        STATE.proj2027Filter = { team: safeStr(badgeTeam && badgeTeam.name), pos: "" };
        activateContractSubtab("tag");
        return;
      }
      // Team-name link in Summary.
      const link = e.target.closest(".fo-cap-team-link");
      if (link) {
        e.preventDefault();
        STATE.capFocusedTeamFid = link.dataset.fid;
        STATE.capSubview = "detail";
        $$(".fo-section[data-section='cap'] .fo-subview-chip").forEach(function (c) {
          c.classList.toggle("active", c.dataset.subview === "detail");
        });
        renderCapTab();
        return;
      }
      // Position-chip filter (Summary).
      const chip = e.target.closest("#fo-cap-pos-chips .fo-pos-chip");
      if (chip) {
        STATE.capSummaryFilters.pos = chip.dataset.capPos || "ALL";
        renderCapTab();
        return;
      }
      // Reset filters.
      if (e.target.closest("#fo-cap-reset")) {
        STATE.capSummaryFilters = { pos: "ALL", type: "", years: "", status: "" };
        renderCapTab();
        return;
      }
      // Back to Summary.
      if (e.target.closest("#fo-cap-back-summary")) {
        STATE.capSubview = "summary";
        $$(".fo-section[data-section='cap'] .fo-subview-chip").forEach(function (c) {
          c.classList.toggle("active", c.dataset.subview === "summary");
        });
        renderCapTab();
        return;
      }
      // Reset the scenario — clear every preview + draft for the focused team.
      // Resolves the team through capFocusedTeam() rather than reading
      // STATE.capFocusedTeamFid directly: that field is null until someone picks
      // a team, while the view is already showing the viewer's own roster, so
      // the old read cleared nothing on a first-load reset. The SAVED scenario
      // is deliberately left alone — Reset undoes the working plan, Discard
      // deletes the save.
      if (e.target.closest("#fo-cap-clear-previews")) {
        const resetTeam = capFocusedTeam();
        if (resetTeam) {
          capClearTeamPreviews(resetTeam.fid);
          // Only THIS team's notice goes — another team's saved/restored banner
          // is still true and must survive a reset over here.
          if (STATE.capScenarioNotice && STATE.capScenarioNotice.fid === resetTeam.fid) {
            STATE.capScenarioNotice = null;
          }
        }
        renderCapTab();
        return;
      }
      // Save the scenario — localStorage ONLY. No fetch, no worker, no MFL.
      if (e.target.closest("#fo-cap-scenario-save")) {
        const saveTeam = capFocusedTeam();
        if (!saveTeam) return;
        const res = capScenarioSave(saveTeam);
        if (!res.ok) { flashToast(res.reason, "warn"); return; }
        STATE.capScenarioNotice = {
          fid: saveTeam.fid, kind: "saved", at: res.payload.saved_at,
          count: res.count, applied: [], dropped: [], edited: false
        };
        flashToast("Scenario saved in this browser (" + res.count + " preview" + (res.count === 1 ? "" : "s") + ") — nothing sent to MFL.", "ok");
        renderCapTab();
        return;
      }
      // Restore a saved scenario, validated player-by-player against the live
      // roster. Stale entries are dropped and listed, never applied blind.
      if (e.target.closest("#fo-cap-scenario-restore")) {
        const rTeam = capFocusedTeam();
        if (!rTeam) return;
        const res = capScenarioRestore(rTeam);
        if (!res.ok) { flashToast(res.reason, "warn"); return; }
        STATE.capScenarioNotice = {
          fid: rTeam.fid, kind: "restored", at: res.saved_at,
          count: res.applied.length, applied: res.applied, dropped: res.dropped, edited: false
        };
        flashToast("Restored " + res.applied.length + " preview" + (res.applied.length === 1 ? "" : "s") +
          (res.dropped.length ? " · " + res.dropped.length + " dropped as stale" : ""),
          res.dropped.length ? "warn" : "ok");
        renderCapTab();
        return;
      }
      // Delete the stored scenario for this team (the working plan stays).
      if (e.target.closest("#fo-cap-scenario-discard")) {
        const dTeam = capFocusedTeam();
        if (!dTeam) return;
        const okDel = capScenarioDiscard(dTeam.fid);
        if (STATE.capScenarioNotice && STATE.capScenarioNotice.fid === dTeam.fid) STATE.capScenarioNotice = null;
        flashToast(okDel ? "Saved scenario deleted from this browser." : "Couldn’t reach browser storage to delete it.", okDel ? "ok" : "err");
        renderCapTab();
        return;
      }
      // Summary sortable header.
      const th = e.target.closest("th[data-cap-sort]");
      if (th) {
        const key = th.dataset.capSort;
        if (STATE.capSummarySort.key === key) STATE.capSummarySort.dir *= -1;
        else {
          STATE.capSummarySort.key = key;
          STATE.capSummarySort.dir = (key === "name") ? 1 : -1;
        }
        renderCapTab();
        return;
      }
      // Detail sortable header — re-sorts the stable player order. Only
      // triggered by header click; preview toggles never reshuffle.
      const dth = e.target.closest("th[data-cap-detail-sort]");
      if (dth) {
        const key = dth.dataset.capDetailSort;
        if (STATE.capDetailSort.key === key) STATE.capDetailSort.dir *= -1;
        else {
          STATE.capDetailSort.key = key;
          STATE.capDetailSort.dir = (key === "name" || key === "pos" || key === "type" || key === "status") ? 1 : -1;
        }
        STATE.capDetailOrderForFid = null; // force recompute
        renderCapTab();
        return;
      }
      // Detail row click (NOT inside a preview button) → slide-over.
      const tr = e.target.closest("#fo-cap-detail-body tbody tr[data-pid]");
      if (tr && !e.target.closest(".fo-cap-prev-btn")) {
        openSlideover(tr.dataset.pid, tr.dataset.fid);
      }
    });
    // Editor typing (restructure + loaded MYAC). `input` bubbles, so this rides
    // the same once-bound section listener and survives every partial re-render.
    //
    // Both editors read literal dollars — digits only. Deliberately NOT
    // parseContractMoneyToken: that promotes "45" to $45,000, which would
    // silently turn a typo into a plausible-looking cap number. A sub-$1,000
    // entry stays sub-$1,000, fails the coherence test, and the grid keeps
    // showing the real contract.
    section.addEventListener("input", function (e) {
      const digits = function (el) { return Math.max(0, safeInt(String(el.value).replace(/[^0-9]/g, ""), 0)); };
      const rsEl = e.target.closest && e.target.closest(".fo-cap-rs-input");
      if (rsEl) {
        const draft = STATE.capRestructureDrafts[rsEl.dataset.rsKey];
        const idx = safeInt(rsEl.dataset.rsIdx, -1);
        if (!draft || idx < 0 || idx >= draft.amounts.length) return;
        draft.amounts[idx] = digits(rsEl);
        capScenarioMarkEdited(rsEl.dataset.rsKey);
        rerenderCapDetailPreservingFocus();
        return;
      }
      const mlEl = e.target.closest && e.target.closest(".fo-cap-ml-input");
      if (mlEl) {
        const draft = STATE.capMyacLoadedDrafts[mlEl.dataset.mlKey];
        const idx = safeInt(mlEl.dataset.mlIdx, -1);
        // Length guard doubles as a kind guard: a 2-year draft can never absorb
        // a keystroke aimed at a 3-year editor.
        if (!draft || draft.kind !== "myacl" + safeInt(mlEl.dataset.mlYears, 0)) return;
        if (idx < 0 || idx >= draft.amounts.length) return;
        draft.amounts[idx] = digits(mlEl);
        // The final year is DERIVED — it absorbs whatever is left of the TCV,
        // so the split always balances and the editor can't sit in an "over by
        // $27,000" state. Recomputed on every keystroke against the same basis
        // the evaluator uses; clamped at 0 rather than going negative, which
        // keeps it a real number while the §C2 no-$0-year rule (checked in
        // myacLoadedYearsError) reports the problem.
        const mlLast = draft.amounts.length - 1;
        if (mlLast > 0 && idx !== mlLast) {
          // The preview key IS "pid:fid" (capPreviewKey), so the player is
          // recoverable from it without adding data-attrs to every input.
          const mlParts = String(mlEl.dataset.mlKey || "").split(":");
          const mlBasis = myacLoadedBasis(findPlayer(mlParts[0] || "", mlParts[1] || ""), draft.amounts.length);
          const mlTcv = (mlBasis && mlBasis.ok) ? safeInt(mlBasis.tcv, 0) : 0;
          if (mlTcv > 0) {
            let used = 0;
            for (let i = 0; i < mlLast; i += 1) used += safeInt(draft.amounts[i], 0);
            draft.amounts[mlLast] = Math.max(0, mlTcv - used);
          }
        }
        capScenarioMarkEdited(mlEl.dataset.mlKey);
        rerenderCapDetailPreservingFocus();
      }
    });
  }

  // Re-render ONLY the Detail body (totals + grid) and put the caret back where
  // it was. Keystrokes must not rebuild the toolbar (or the focused input dies),
  // and totals must not be recomputed in a second place — renderCapDetailBody
  // stays the single owner of every number on screen.
  function rerenderCapDetailPreservingFocus() {
    const host = $("#fo-cap-detail-body");
    const team = capFocusedTeam();
    if (!host || !team) { renderCapTab(); return; }
    const act = document.activeElement;
    const isEditorInput = act && act.classList &&
      (act.classList.contains("fo-cap-rs-input") || act.classList.contains("fo-cap-ml-input"));
    const focusId = (act && act.id && isEditorInput) ? act.id : "";
    let selStart = null, selEnd = null;
    if (focusId) { try { selStart = act.selectionStart; selEnd = act.selectionEnd; } catch (_) {} }
    host.innerHTML = renderCapDetailBody(team);
    if (focusId) {
      const next = document.getElementById(focusId);
      if (next) {
        next.focus();
        if (selStart != null) { try { next.setSelectionRange(selStart, selEnd); } catch (_) {} }
      }
    }
  }

  // Balance / Reset / Commit from the inline restructure editor.
  function handleCapRestructureAction(btn) {
    const key = btn.dataset.rsKey;
    const p = findPlayer(btn.dataset.pid, btn.dataset.fid);
    if (!p) return;
    const ev = capRestructureEval(p);
    if (!ev.ok) { flashToast("Restructure unavailable — " + ev.reason, "err"); return; }
    if (btn.classList.contains("fo-cap-rs-reset")) {
      STATE.capRestructureDrafts[key] = { amounts: ev.real.slice() };
      capScenarioMarkEdited(btn.dataset.fid);
      rerenderCapDetailPreservingFocus();
      return;
    }
    if (btn.classList.contains("fo-cap-rs-balance")) {
      // Same auto-fill the Contracts-tab form does: the LAST year absorbs
      // whatever is left so Σ = TCV. Refuses to write a negative year.
      const amts = ev.amounts.slice();
      const last = amts.length - 1;
      const head = amts.slice(0, last).reduce(function (a, b) { return a + b; }, 0);
      const rest = ev.tcv - head;
      if (rest < 0) { flashToast("The earlier years already exceed " + fmtUSD(ev.tcv) + " — lower one first.", "err"); return; }
      amts[last] = rest;
      STATE.capRestructureDrafts[key] = { amounts: amts };
      capScenarioMarkEdited(btn.dataset.fid);
      rerenderCapDetailPreservingFocus();
      return;
    }
    // NO COMMIT PATH. Cap Planning models contracts; it never writes one
    // (Keith 2026-08-01: "cap planning should be planning. ONLY"). The
    // button is gone, the click delegation no longer matches it, and the
    // submit call is removed outright rather than merely guarded — so a
    // stale DOM node or a later edit cannot quietly re-open a write path
    // from a planning surface. Applying it lives on the Contracts tab.
  }

  // Balance / Reset / Commit from the inline loaded-MYAC editor.
  function handleCapMyacLoadedAction(btn) {
    const key = btn.dataset.mlKey;
    const p = findPlayer(btn.dataset.pid, btn.dataset.fid);
    if (!p) return;
    const totalYears = safeInt(btn.dataset.mlYears, 0);
    const ev = capMyacLoadedEval(p, totalYears);
    if (!ev.ok) { flashToast("Loaded MYAC unavailable — " + ev.reason, "err"); return; }
    if (btn.classList.contains("fo-cap-ml-reset")) {
      STATE.capMyacLoadedDrafts[key] = { kind: ev.kind, amounts: ev.flat.slice() };
      capScenarioMarkEdited(btn.dataset.fid);
      rerenderCapDetailPreservingFocus();
      return;
    }
    if (btn.classList.contains("fo-cap-ml-balance")) {
      // Same auto-fill the slide-over loaded form does: the LAST year absorbs
      // whatever is left so Σ = TCV. Refuses to write a negative year.
      const amts = ev.amounts.slice();
      const last = amts.length - 1;
      const head = amts.slice(0, last).reduce(function (a, b) { return a + b; }, 0);
      const rest = ev.tcv - head;
      if (rest < 0) { flashToast("The earlier years already exceed " + fmtUSD(ev.tcv) + " — lower one first.", "err"); return; }
      amts[last] = rest;
      STATE.capMyacLoadedDrafts[key] = { kind: ev.kind, amounts: amts };
      capScenarioMarkEdited(btn.dataset.fid);
      rerenderCapDetailPreservingFocus();
      return;
    }
    // NO COMMIT PATH. Cap Planning models contracts; it never writes one
    // (Keith 2026-08-01: "cap planning should be planning. ONLY"). The
    // button is gone, the click delegation no longer matches it, and the
    // submit call is removed outright rather than merely guarded — so a
    // stale DOM node or a later edit cannot quietly re-open a write path
    // from a planning surface. Applying it lives on the Contracts tab.
  }

  // ══════════════════════════════════════════════════════════════════
  // SUBMIT CHAINS (port of roster_workbench.js submit functions)
  // ══════════════════════════════════════════════════════════════════

  function commishOverrideFor(p) {
    const me = STATE.me || {};
    return !!me.isAdmin && pad4(me.franchise_id) !== pad4(p.fid);
  }

  // Reusable POST helper — mirrors live FO's postContractUpdate at
  // roster_workbench.js:10831 exactly. credentials:"omit" avoids the
  // CORS preflight failure ("Load failed") that strict origin checks
  // throw on cross-origin local testing. Includes the URL-encoded
  // fallback live FO uses when JSON POST returns non-OK (some worker
  // routes parse form bodies differently than JSON).
  async function postContractUpdate(url, payload) {
    const body = payload || {};
    let r;
    try {
      r = await fetch(url, {
        method: "POST",
        credentials: "omit",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
    } catch (e) {
      throw new Error("Network: " + (e.message || String(e)));
    }
    if (r.ok) {
      const data = await r.json().catch(function () { return {}; });
      if (data && data.ok === false) throw new Error(data.error || "Worker rejected payload");
      return data;
    }
    // Fallback: same request as form-urlencoded.
    const form = new URLSearchParams();
    Object.keys(body).forEach(function (k) {
      if (body[k] != null) form.set(k, String(body[k]));
    });
    const r2 = await fetch(url, {
      method: "POST",
      credentials: "omit",
      cache: "no-store",
      headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
      body: form.toString()
    });
    const d2 = await r2.json().catch(function () { return {}; });
    if (!r2.ok || (d2 && d2.ok === false)) {
      throw new Error((d2 && d2.error) || ("HTTP " + r2.status));
    }
    return d2;
  }

  // Shared roster-action POST helper (load_player / unload_player /
  // drop_player / activate_ir / promote_taxi). Same credentials:"omit"
  // pattern. Returns the parsed JSON or throws.
  async function postRosterAction(action, fid, pid, extra) {
    // appendViewerSessionQuery is MANDATORY here. drop_player / activate_ir /
    // promote_taxi are owner-scoped MFL imports; forwarded without the viewer's
    // MFL_USER_ID the worker signs them with the commish cookie and MFL returns
    // 200 while changing nothing — the silent no-op that made FO v2's Drop
    // button do nothing at all.
    const url = appendViewerSessionQuery(
      EP_ROSTER_ACTION() +
      "?L=" + encodeURIComponent(LEAGUE_ID) +
      "&YEAR=" + encodeURIComponent(SEASON)
    );
    const body = Object.assign({
      action: action,
      league_id: LEAGUE_ID,
      season: SEASON,
      franchise_id: fid,
      player_id: pid
    }, extra || {});
    if (IS_DRY_RUN) body.dry_run = 1;
    let r;
    try {
      r = await fetch(url, {
        method: "POST", credentials: "omit", cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
    } catch (e) {
      throw new Error("Network: " + (e.message || String(e)));
    }
    const data = await r.json().catch(function () { return {}; });
    if (!r.ok || (data && data.ok === false)) {
      throw new Error((data && data.error) || ("HTTP " + r.status));
    }
    return data;
  }

  // ── Roster Move (Drop / IR Activate / Promote Taxi) ────────────────
  // Mirrors submitRosterMove at roster_workbench.js:10928.
  async function submitRosterMove(action, p) {
    const verb = action === "activate_ir" ? "activate from IR"
               : action === "drop_player" ? "drop"
               : action === "demote_taxi" ? "move to taxi"
               : "promote from taxi";
    let extra = "";
    if (action === "drop_player") {
      const pen = dropPenaltyEstimate(p);
      extra = "\n\nEstimated cap penalty: " + fmtUSD(pen.amount) + "\n" + safeStr(pen.note);
    }
    if (action === "promote_taxi") {
      const used = safeInt(p.taxiCallupsUsed, 0);
      const max = safeInt(p.taxiCallupsMax, 3) || 3;
      const pending = safeInt(p.taxiCallupsPending, 0);
      const nth = used + pending + 1;
      extra = nth >= max + 1
        ? "\n\n⚠ Call-up #" + nth + " of a 3-call-up budget. Canon §B2: 4th call-up = PERMANENT PROMOTION."
        : "\n\nCall-ups used: " + used + " of " + max + (pending ? " (+" + pending + " pending)" : "") +
          "\nCanon §B2: each NFL week active on roster burns 1 call-up.";
    }
    if (!window.confirm("Confirm " + verb + " for " + p.name + "?" + extra)) return;

    flashToast((IS_DRY_RUN ? "[DRY-RUN] " : "") + "Submitting " + verb + " for " + p.name + "…", "ok");
    try {
      await postRosterAction(action, p.fid, p.id);
      flashToast((IS_DRY_RUN ? "[DRY-RUN] " : "") + p.name + " " + verb + " submitted.", "ok");
      await loadRosterData(); renderRosterTable(); closeSlideover();
    } catch (e) {
      console.error("[fo] roster-move failed:", e);
      flashToast("Roster move failed: " + (e.message || String(e)), "err");
    }
  }

  // ── Rookie Option ──────────────────────────────────────────────────
  // Mirrors submitRookieOptionUpdate at roster_workbench.js:11107.
  async function submitRookieOption(p) {
    const opt = rookieOptionStateForPlayer(p);
    if (!opt) {
      flashToast("No rookie option data available for " + p.name + ".", "warn");
      return;
    }
    // Option year salary = current + $5K floor (canon §C6).
    const optionYearSalary = safeInt(opt.optionYearSalary, 0) || (safeInt(p.salary, 0) + 5000);
    const confirmLines = [
      "Confirm rookie option exercise for " + p.name + "?",
      "",
      "Current Year Salary: " + fmtUSD(p.salary),
      "Option Year Salary: " + fmtUSD(optionYearSalary),
      "New Contract Length: 2 years"
    ];
    if (!window.confirm(confirmLines.join("\n"))) return;

    const url = EP_CONTRACT_UPDATE() +
      "?L=" + encodeURIComponent(LEAGUE_ID) +
      "&YEAR=" + encodeURIComponent(SEASON);
    const payload = {
      L: LEAGUE_ID, YEAR: SEASON,
      type: "MANUAL_CONTRACT_UPDATE",
      source: "front-office-v2-rookie-option-submit",
      leagueId: LEAGUE_ID, year: SEASON,
      player_id: p.id, player_name: p.name,
      franchise_id: p.fid, franchise_name: p.franchise,
      position: p.positionGroup || p.position,
      salary: safeInt(p.salary, 0),
      contract_year: 2,
      contract_status: "ROPT",
      contract_info: "CL 2|TCV " + fmtK((p.salary + optionYearSalary)).replace(/\$/, "") +
        "|AAV " + fmtK(Math.round((p.salary + optionYearSalary) / 2)).replace(/\$/, "") +
        "|Y1-" + fmtK(p.salary).replace(/\$/, "") + ", Y2-" + fmtK(optionYearSalary).replace(/\$/, "") +
        "|ROPT exercised",
      submitted_at_utc: new Date().toISOString(),
      commish_override_flag: commishOverrideFor(p) ? 1 : 0
    };
    if (IS_DRY_RUN) payload.dry_run = 1;

    try {
      await postContractUpdate(url, payload);
      flashToast((IS_DRY_RUN ? "[DRY-RUN] " : "") + p.name + " rookie option submitted.", "ok");
      await loadRosterData(); renderRosterTable(); closeSlideover();
    } catch (e) {
      console.error("[fo] rookie-option submit failed:", e);
      flashToast("Rookie option failed: " + (e.message || String(e)), "err");
    }
  }

  // ── Restructure ────────────────────────────────────────────────────
  // Mirrors submitRestructureUpdate at roster_workbench.js:11170 with a
  // small Y1/Y2(/Y3) input form so owner picks the split. Y1 ≥ 20% TCV
  // and Σ years = TCV per canon §C5.
  function openRestructureForm(p) {
    const tcv = totalContractValueForPlayer(p);
    const years = safeInt(p.years, 0);
    const minY1 = Math.max(1000, Math.ceil(tcv * 0.20 / 1000) * 1000);
    const aav = Math.round(tcv / Math.max(1, years) / 1000) * 1000;
    const priorAavToken = parseContractAavRawToken(p.special);  // preserved verbatim on submit
    const is3 = years >= 3;                       // 3-yr → Y1+Y2 input, Y3 auto; else Y1 input, Y2 auto
    const inStyle = "background:var(--panel-alt); color:var(--text); border:1px solid var(--border); padding:6px 10px; border-radius:4px; width:120px;";
    const body = $("#fo-slideover-body");
    body.innerHTML = `
      <div class="fo-form">
        <h3 style="margin:0 0 4px;">Restructure ${escapeHtml(p.name)}</h3>
        <div class="fo-form-note">
          TCV ${fmtUSD(tcv)} · Years remaining ${years} · AAV ${escapeHtml(priorAavToken || fmtUSD(aav))} · Y1 ≥ ${fmtUSD(minY1)} (20% TCV) · whole $1,000s, no $0 year.
          The last year auto-fills so Σ = TCV. The AAV token is preserved from the current contract. FL if Y1 raises the current-year salary, BL if it lowers it.
        </div>
        <div class="fo-form-row"><span class="lbl">Year 1 ($)</span>
          <input type="number" id="fo-rs-y1" step="1000" min="${minY1}" value="${minY1}" class="num" style="${inStyle}">
        </div>
        ${is3 ? `<div class="fo-form-row"><span class="lbl">Year 2 ($)</span>
          <input type="number" id="fo-rs-y2" step="1000" min="1000" value="${Math.max(1000, aav)}" class="num" style="${inStyle}">
        </div>` : ""}
        <div class="fo-form-row"><span class="lbl">Year ${years} (auto)</span><span class="val" id="fo-rs-last">—</span></div>
        <div class="fo-form-row"><span class="lbl">Σ (must equal TCV)</span><span class="val" id="fo-rs-sum">${fmtUSD(tcv)}</span></div>
        <div class="fo-form-note" id="fo-rs-err" style="color:var(--err); min-height:14px;"></div>
        <div class="fo-form-actions">
          <button class="btn secondary" id="fo-rs-cancel">Cancel</button>
          <button class="btn" id="fo-rs-submit">${IS_DRY_RUN ? "Submit (dry-run)" : "Submit Restructure"}</button>
        </div>
      </div>`;
    const readYrs = function () {
      const y1 = roundToK(safeInt(($("#fo-rs-y1") || {}).value, 0));
      const y2 = is3 ? roundToK(safeInt(($("#fo-rs-y2") || {}).value, 0)) : (tcv - y1);
      const y3 = is3 ? (tcv - y1 - y2) : 0;
      return is3 ? [y1, y2, y3] : [y1, y2];
    };
    const validateYrs = function (yrs) {
      if (yrs.some(function (v) { return v % 1000 !== 0; })) return "All years must be whole $1,000 increments.";
      if (yrs[0] < minY1) return "Year 1 must be ≥ " + fmtUSD(minY1) + " (20% of TCV).";
      if (yrs.some(function (v) { return v < 1000; })) return "No year can be below $1,000 — there are no $0 years.";
      if (yrs.reduce(function (a, b) { return a + b; }, 0) !== tcv) return "Σ must equal TCV " + fmtUSD(tcv) + " — adjust the editable year(s).";
      return "";
    };
    const recalc = function () {
      const yrs = readYrs();
      $("#fo-rs-last").textContent = fmtUSD(yrs[yrs.length - 1]);
      $("#fo-rs-sum").textContent = fmtUSD(yrs.reduce(function (a, b) { return a + b; }, 0)) + " / " + fmtUSD(tcv);
      const err = validateYrs(yrs);
      $("#fo-rs-err").textContent = err;
      const btn = $("#fo-rs-submit"); if (btn) btn.disabled = !!err;
    };
    $("#fo-rs-y1").addEventListener("input", recalc);
    if (is3) $("#fo-rs-y2").addEventListener("input", recalc);
    $("#fo-rs-cancel").addEventListener("click", function () { renderSlideoverBody(); });
    $("#fo-rs-submit").addEventListener("click", function () {
      const yrs = readYrs();
      const err = validateYrs(yrs);
      if (err) { flashToast(err, "err"); return; }
      submitRestructure(p, years, yrs);
    });
    recalc();
  }
  async function submitRestructure(p, years, yrs) {
    yrs = (yrs || []).map(roundToK);
    const y1 = safeInt(yrs[0], 0);
    const y2 = safeInt(yrs[1], 0);
    const y3 = years >= 3 ? safeInt(yrs[2], 0) : 0;
    const tcv = totalContractValueForPlayer(p);
    const sum = y1 + y2 + y3;
    if (sum !== tcv) {
      flashToast("Sum must equal TCV " + fmtUSD(tcv) + " (currently " + fmtUSD(sum) + ").", "err");
      return;
    }
    if ([y1, y2, y3].slice(0, years).some(function (v) { return v % 1000 !== 0; })) {
      flashToast("All years must be whole $1,000 increments.", "err");
      return;
    }
    if (y1 < Math.round(tcv * 0.20 / 1000) * 1000) {
      flashToast("Y1 must be ≥ 20% of TCV (" + fmtUSD(Math.round(tcv * 0.20 / 1000) * 1000) + ").", "err");
      return;
    }
    // PRESERVE the prior AAV token VERBATIM — a restructure re-slots the year
    // salaries + TCV + GTD but must NOT recompute the AAV. The AAV is set forward-
    // looking at the EXTENSION (a dual "cur, cur+bump") and stays fixed; re-
    // averaging TCV/CL was the Cook/London bug (Keith 2026-07-22/23). The numeric
    // `aav` (D1 ledger + confirm display) is the current-year tier; fall back to
    // the naive average ONLY when the prior contract carries no AAV token.
    const priorAavToken = parseContractAavRawToken(p.special);
    const priorAavValues = parseContractAavValues(p.special);
    const aav = priorAavValues.length ? safeInt(priorAavValues[0], 0)
                                      : Math.round(tcv / Math.max(1, years));
    const gtd = guaranteeForContract(tcv, years);        // §D1 sub-$5K rule (restructure)
    // §C5 / T3.4: the -FL / -BL suffix on a RESTRUCTURE follows which way the money
    // MOVED — new current-year (Y1) salary vs the PRE-restructure current-year
    // salary: LOWERED → -BL (pushed back), RAISED → -FL (pulled forward). 🔒 Keith
    // ruling 2026-07-23 — do NOT use "Y1 vs AAV" (it breaks on escalated dual-AAV
    // deals: Hurts 67→47 is -BL even though Y1-47 > AAV-42). Strip any existing
    // suffix first; equal = flat = no suffix. The suffix also drives the 5-loaded
    // roster cap (isLoadedRow keys off it).
    // BASIS = the CURRENT year's salary, i.e. Y-token
    // [contractYearIndexForPlayer(player)] — NOT [1]. Y-tokens are absolute
    // across a contract's life, so [1] is the current year ONLY on an untouched
    // deal. Reading [1] mid-contract compares against a year already earned and
    // inverts the suffix: Herbert (CL 3 | Y1-61, Y2-51, Y3-41 | 2 left) has a
    // current-year salary of $51K, so re-slotting the remaining $92K to 55/37
    // moved money UP = -FL — but against Y1-61 it reads 55 < 61 and writes -BL.
    // That mis-types the contract permanently and feeds the 5-loaded cap.
    // Every fixture that verified this rule (Hurts, London, Cook, McLaurin) is a
    // contract whose current year IS year 1, which is why the bug survived.
    const priorCurrentSalary = safeInt(currentContractYearValue(p), 0) ||
                               roundToK(safeInt(p.salary, 0));
    const baseType = String(p.type || "Veteran").replace(/-(FL|BL)$/i, "");
    const loadSuffix = (priorCurrentSalary > 0 && y1 > priorCurrentSalary) ? "-FL"
                     : ((priorCurrentSalary > 0 && y1 < priorCurrentSalary) ? "-BL" : "");
    const newStatus = baseType + loadSuffix;
    // §C2.356 / §C5: hard-block a restructure that would create a NEW loaded
    // contract once the team is at the 5-loaded roster cap. Re-shaping an
    // already-loaded contract (or restructuring to flat) doesn't add a slot.
    if (loadSuffix && !isLoadedRow(p) && loadedContractCountForTeam(p.fid) >= LOADED_MAX) {
      flashToast("At the " + LOADED_MAX + "-loaded cap — this restructure would create a " +
        (loadSuffix === "-FL" ? "front" : "back") + "-loaded contract. Trade or cut a loaded player first.", "err");
      return;
    }
    const yearTokens = ["Y1-" + fmtK(y1).replace(/\$/, ""), "Y2-" + fmtK(y2).replace(/\$/, "")];
    if (years >= 3) yearTokens.push("Y3-" + fmtK(y3).replace(/\$/, ""));
    // AAV segment = the prior token VERBATIM (dual preserved); fall back to the
    // naive average only when no prior AAV token existed.
    const aavSegment = priorAavToken || fmtK(aav).replace(/\$/, "");
    const info = "CL " + years + "|TCV " + fmtK(tcv).replace(/\$/, "") +
                 "|AAV " + aavSegment + "|" + yearTokens.join(", ") +
                 "|GTD: " + fmtK(gtd).replace(/\$/, "") + "|Restructured " + new Date().getFullYear();
    const confirmLines = ["Confirm restructure for " + p.name + "?", "",
      "Y1: " + fmtUSD(y1), "Y2: " + fmtUSD(y2)];
    if (years >= 3) confirmLines.push("Y3: " + fmtUSD(y3));
    confirmLines.push("TCV: " + fmtUSD(tcv), "AAV: " + (priorAavToken || fmtUSD(aav)), "GTD: " + fmtUSD(gtd),
      "New type: " + newStatus + (loadSuffix ? (loadSuffix === "-FL" ? " (front-loaded)" : " (back-loaded)") : " (flat)"));
    if (!window.confirm(confirmLines.join("\n"))) return;

    const url = EP_RESTRUCTURE() +
      "?L=" + encodeURIComponent(LEAGUE_ID) +
      "&YEAR=" + encodeURIComponent(SEASON);
    const payload = {
      L: LEAGUE_ID, YEAR: SEASON, leagueId: LEAGUE_ID, year: SEASON,
      type: "RESTRUCTURE",
      player_id: p.id, player_name: p.name,
      franchise_id: p.fid, franchise_name: p.franchise,
      position: p.positionGroup || p.position,
      salary: y1,
      contract_year: years,
      contract_status: newStatus,
      contract_info: info,
      tcv: tcv, aav: aav, guaranteed: gtd,
      // Prior state so the restructure audit row is REVERTABLE (was omitted —
      // restructures showed "(no revert)" with a disabled checkbox). Keith
      // 2026-06-05 (Rashee Rice couldn't be reverted).
      prior_contract_status: p.type, prior_salary: p.salary,
      prior_contract_year: p.years, prior_contract_info: p.special,
      submitted_at_utc: new Date().toISOString(),
      commish_override_flag: commishOverrideFor(p) ? 1 : 0
    };
    if (IS_DRY_RUN) payload.dry_run = 1;

    try {
      await postContractUpdate(url, payload);
      flashToast((IS_DRY_RUN ? "[DRY-RUN] " : "") + p.name + " restructure submitted.", "ok");
      await loadRosterData(); renderRosterTable(); closeSlideover();
    } catch (e) {
      console.error("[fo] restructure submit failed:", e);
      flashToast("Restructure failed: " + (e.message || String(e)), "err");
    }
  }

  // ── Untag ──────────────────────────────────────────────────────────
  // Mirrors submitUntagPlayer at roster_workbench.js:11502. Two-phase:
  // (1) POST /commish-contract-update restoring the prior contract
  //     (read from tag_tracking ref row),
  // (2) POST /roster-workbench/action unload_player.
  async function submitUntag(p) {
    const ref = STATE.tagData && STATE.tagData.rows.find(function (r) {
      return r.player_id === p.id && pad4(r.franchise_id) === pad4(p.fid);
    });
    if (!ref) {
      flashToast("Untag failed: no tag-tracking reference row for " + p.name + ". Open Tagging tab once to load.", "err");
      return;
    }
    const restorePayload = {
      L: LEAGUE_ID, YEAR: SEASON,
      type: "MANUAL_CONTRACT_UPDATE",
      submission_kind: "untag",
      prior_tag_side: ref.side || "OFFENSE",
      leagueId: LEAGUE_ID, year: SEASON,
      player_id: p.id, player_name: p.name,
      franchise_id: p.fid, franchise_name: p.franchise,
      position: p.position,
      salary: safeInt(ref.salary, 0),
      contract_year: Math.max(1, safeInt(ref.contract_year, 0)),
      contract_status: safeStr(ref.contract_status || "WW"),
      contract_info: safeStr(ref.contract_info || "CL 1|"),
      submitted_at_utc: new Date().toISOString(),
      commish_override_flag: commishOverrideFor(p) ? 1 : 0
    };
    if (IS_DRY_RUN) restorePayload.dry_run = 1;
    if (!window.confirm(
      "Untag " + p.name + "?\n\n" +
      "Restore: " + restorePayload.contract_status + " at " + fmtUSD(restorePayload.salary) + "\n" +
      "Then remove from roster."
    )) return;

    const updateUrl = EP_CONTRACT_UPDATE() + "?L=" + encodeURIComponent(LEAGUE_ID) + "&YEAR=" + encodeURIComponent(SEASON);
    let contractRestored = false;
    try {
      await postContractUpdate(updateUrl, restorePayload);
      contractRestored = true;
      await postRosterAction("unload_player", p.fid, p.id);
      flashToast((IS_DRY_RUN ? "[DRY-RUN] " : "") + p.name + " untagged.", "ok");
      // Optimistic flip — dry-run won't repopulate type away from TAG,
      // so track locally to make the row show Tag (not Untag).
      const optKey = p.id + ":" + pad4(p.fid);
      STATE.optimisticUntags[optKey] = true;
      delete STATE.optimisticTags[optKey];
      STATE.tagData = null;
      await loadRosterData();
      await loadTagPlanData().catch(function () {});
      renderRosterTable(); closeSlideover();
      if (STATE.activeTab === "tag") renderTagTab();
    } catch (e) {
      console.error("[fo] untag failed:", e);
      flashToast("Untag failed: " + (e.message || String(e)) +
        (contractRestored ? " Contract was restored before the unload failed." : ""), "err");
    }
  }

  // ── Tag (called from the Tagging tab's Tag button) ─────────────────
  // Mirrors submitTagPlanSelection at roster_workbench.js:11418. Two-phase:
  // (1) POST /roster-workbench/action load_player,
  // (2) POST /commish-contract-update submission_kind=tag.
  async function submitTag(row) {
    const eff = effectiveTagSalaryForRow(row);
    const formula = effectiveTagFormulaForRow(row);
    const confirmText =
      "Tag " + row.player_name + " for " + fmtUSD(eff) + "?\n\n" +
      "Side: " + (row.side === "OFFENSE" ? "Offense" : "Defense/ST") + "\n" +
      "Tier: T" + row.tag_tier + "\n" +
      "Formula: " + formula;
    if (!window.confirm(confirmText)) return;

    const tagContractInfo = "CL 1|TCV " + fmtK(eff).replace(/\$/, "") +
                           "|AAV " + fmtK(eff).replace(/\$/, "") +
                           "|Y1-" + fmtK(eff).replace(/\$/, "") +
                           "|GTD: " + fmtK(eff).replace(/\$/, "") +
                           "|TAG (" + (row.side === "OFFENSE" ? "Off" : "Def/ST") + ") T" + row.tag_tier;
    const tagPayload = {
      L: LEAGUE_ID, YEAR: SEASON,
      type: "MANUAL_CONTRACT_UPDATE",
      submission_kind: "tag",
      leagueId: LEAGUE_ID, year: SEASON,
      player_id: row.player_id, player_name: row.player_name,
      franchise_id: row.franchise_id, franchise_name: row.franchise_name,
      position: row.position,
      side: row.side, tag_side: row.side,
      salary: eff, contract_year: 1,
      contract_status: "TAG", contract_info: tagContractInfo,
      tag_tier: row.tag_tier, tag_formula: formula,
      submitted_at_utc: new Date().toISOString(),
      commish_override_flag: (STATE.me && STATE.me.isAdmin && pad4(STATE.me.franchise_id) !== pad4(row.franchise_id)) ? 1 : 0
    };
    if (IS_DRY_RUN) tagPayload.dry_run = 1;

    const updateUrl = EP_CONTRACT_UPDATE() + "?L=" + encodeURIComponent(LEAGUE_ID) + "&YEAR=" + encodeURIComponent(SEASON);

    flashToast((IS_DRY_RUN ? "[DRY-RUN] " : "") + "Applying tag for " + row.player_name + "…", "ok");
    let loaded = false;
    try {
      // Phase 1: load_player onto the roster (idempotent if already on).
      const d1 = await postRosterAction("load_player", row.franchise_id, row.player_id);
      loaded = !!d1.ok && !d1.skipped;
      // Phase 2: post the TAG contract.
      await postContractUpdate(updateUrl, tagPayload);
      flashToast((IS_DRY_RUN ? "[DRY-RUN] " : "") + row.player_name + " tagged at " + fmtUSD(eff) + ".", "ok");
      // Optimistic flip — survives the dry-run round-trip so the row
      // shows Untag in the next render.
      const optKey = row.player_id + ":" + pad4(row.franchise_id);
      STATE.optimisticTags[optKey] = true;
      delete STATE.optimisticUntags[optKey];
      // Refresh data + re-render Tagging tab.
      STATE.tagData = null;            // force tag-data reload
      await loadRosterData();
      await loadTagPlanData();
      renderTagTab();
    } catch (e) {
      console.error("[fo] tag failed:", e);
      // Rollback the load_player if Phase 2 failed.
      if (loaded) {
        try { await postRosterAction("unload_player", row.franchise_id, row.player_id); }
        catch (_e) { /* best effort */ }
      }
      flashToast("Tag failed: " + (e.message || String(e)) + (loaded ? " Player was unloaded." : ""), "err");
    }
  }

  // ══════════════════════════════════════════════════════════════════
  // TAGGING TAB
  // ══════════════════════════════════════════════════════════════════
  //
  // Mirrors live FO data sources: /ccc/tag_tracking.json (per-player
  // eligibility + tier + tag_salary + 10%-floor inputs) and
  // /ccc/tag_submissions.json (already-submitted tags this cycle).
  //
  // Effective tag salary = max(tier base bid, AAV × 1.10) rounded up
  // to $1K. CANON: the 10% floor is grounded in AAV only — never
  // current/prior salary (Keith 2026-05-19). The live FO + the
  // JSON's pre-computed tag_salary field both include salary in
  // the MAX which is a bug — v2 computes the canonical value here
  // and surfaces it as authoritative. tag_base_bid is the tier bid
  // (AAV-ranked); tag_salary in the JSON is the (possibly bugged)
  // precomputed final, which we do NOT use as an input.
  function effectiveTagSalaryForRow(r) {
    const baseBid = safeInt(r && r.tag_base_bid, 0);
    const aavFloor = Math.max(
      safeInt(r && r.prior_aav_week1, 0),
      safeInt(r && r.aav, 0)
    );
    const bumpFloor = aavFloor > 0 ? Math.ceil((aavFloor * 1.1) / 1000) * 1000 : 0;
    return Math.max(baseBid, bumpFloor);
  }
  function effectiveTagFormulaForRow(r) {
    // Start from the canonical tier label (e.g. "Avg Top 1-5 QB AAV").
    // Strip the JSON's "10% salary floor" suffix because v2 recomputes
    // floor using AAV only — the JSON suffix is misleading when it was
    // built on the salary-inclusive formula.
    let f = safeStr(r && r.tag_formula).replace(/\s*\|\s*10% salary floor[^|]*$/i, "");
    const baseBid = safeInt(r && r.tag_base_bid, 0);
    const eff = effectiveTagSalaryForRow(r);
    if (eff > baseBid) {
      f += (f ? " | " : "") + "10% AAV floor (rounded up to $1K)";
    }
    return f;
  }

  async function loadTagPlanData() {
    if (STATE.tagData || STATE.tagDataLoading) return;
    STATE.tagDataLoading = true;
    STATE.tagDataError = "";
    try {
      const [trackingPayload, submissionsPayload] = await Promise.all([
        fetchJSON(URL_TAG_TRACKING).catch(function () { return {}; }),
        fetchJSON(URL_TAG_SUBMISSIONS).catch(function () { return {}; })
      ]);
      const rowsRaw = Array.isArray(trackingPayload) ? trackingPayload
                    : Array.isArray(trackingPayload.rows) ? trackingPayload.rows
                    : Array.isArray(trackingPayload.tag_tracking) ? trackingPayload.tag_tracking
                    : [];
      const subsRaw = Array.isArray(submissionsPayload) ? submissionsPayload
                    : Array.isArray(submissionsPayload.rows) ? submissionsPayload.rows
                    : Array.isArray(submissionsPayload.submissions) ? submissionsPayload.submissions
                    : [];
      const rows = rowsRaw.map(function (raw) {
        const r = raw || {};
        const pos = safeStr(r.position || r.pos).toUpperCase();
        const posGrp = safeStr(r.positional_grouping || r.pos_group || pos).toUpperCase();
        return {
          franchise_id: pad4(r.franchise_id || r.franchiseId),
          franchise_name: safeStr(r.franchise_name),
          player_id: safeStr(r.player_id || r.id).replace(/\D/g, ""),
          player_name: safeStr(r.player_name || r.name),
          position: pos,
          pos_group: posGrp || positionGroupKey(pos),
          side: (posGrp === "QB" || posGrp === "RB" || posGrp === "WR" || posGrp === "TE") ? "OFFENSE" : "DEFENSE",
          points_total: safeNum(r.points_total, 0),
          pos_rank: safeInt(r.pos_rank, 0),
          tag_tier: safeInt(r.tag_tier, 0),
          tag_base_bid: safeInt(r.tag_base_bid, 0),  // <- tier base bid (Amon-Ra $51K T1, etc.)
          tag_salary: safeInt(r.tag_salary || r.tag_bid || r.salary, 0),
          tag_formula: safeStr(r.tag_formula),
          is_tag_eligible: safeInt(r.is_tag_eligible, 0),
          contract_status: safeStr(r.contract_status),
          salary: safeInt(r.salary, 0),
          aav: safeInt(r.aav, 0),
          prior_aav_week1: safeInt(r.prior_aav_week1 || r.prior_aav, 0),
          prior_salary_week1: safeInt(r.prior_salary_week1 || r.prior_salary, 0),
          source_season: safeStr(r.season || r.year)
        };
      }).filter(function (r) { return r.player_id && r.franchise_id; });
      const submissions = subsRaw.map(function (raw) {
        const r = raw || {};
        return {
          franchise_id: pad4(r.franchise_id || r.franchiseId),
          player_id: safeStr(r.player_id || r.id).replace(/\D/g, ""),
          side: safeStr(r.side || r.tag_side || "OFFENSE").toUpperCase(),
          tag_salary: safeInt(r.tag_salary, 0),
          submitted_at_utc: safeStr(r.submitted_at_utc || r.submitted_at)
        };
      }).filter(function (r) { return r.player_id && r.franchise_id; });
      STATE.tagData = {
        rows: rows,
        meta: trackingPayload && trackingPayload.meta ? trackingPayload.meta : {},
        submissions: submissions
      };
    } catch (e) {
      STATE.tagDataError = "Tag plan load failed: " + (e.message || String(e));
      console.warn("[fo]", STATE.tagDataError);
    } finally {
      STATE.tagDataLoading = false;
    }
  }

  // Live in-season points rank per position, for the PROJECTED tag-year tier
  // assignment (Keith 2026-08-04: "determined by their Points Scored aligned
  // to that in canon"). Mirrors the real pipeline's split (build_tag_tracking.py):
  // tier ASSIGNMENT uses points-scored rank; tier PRICING (projectedCalcBreakdown,
  // unchanged) stays AAV-ranked — these are two different player populations by
  // design, not a bug. Source: /api/advanced-stats-leaderboard (D1 src_weekly,
  // MFL's own scoring) — same endpoint the Stats Workbench already uses, called
  // read-only with no changes to it. That table is only populated by a manual
  // backfill script mid-season (no automated writer found for it), so this can
  // go stale — surfaced via tagPointsMaxGames rather than hidden.
  async function loadTagPointsData() {
    if (STATE.tagPointsData || STATE.tagPointsDataLoading) return;
    STATE.tagPointsDataLoading = true;
    STATE.tagPointsDataError = "";
    try {
      const season = safeInt(SEASON, 0);
      const posQueries = ["skill", "qb", "idp", "kicker"];
      const payloads = await Promise.all(posQueries.map(function (posParam) {
        const url = apiUrl("/api/advanced-stats-leaderboard") +
          "?seasons=" + encodeURIComponent(season) +
          "&pos=" + encodeURIComponent(posParam) +
          "&min_games=1&limit=500";
        return fetchJSON(url).catch(function () { return { rows: [] }; });
      }));
      // "kicker" and "punter" collapse to the SAME pos_group server-side (the
      // worker's own comment: "MFL collapses — filter on raw position later"),
      // so one fetch covers both — bucket every row by RAW position through the
      // same positionGroupKey() the rest of this file already uses, rather than
      // trusting the server's pos_group label (which is wrong for punters here).
      const byPosGroup = Object.create(null); // posKey -> [{pid, points, games}]
      let maxGames = 0;
      payloads.forEach(function (payload) {
        (payload && payload.rows || []).forEach(function (row) {
          const pid = safeStr(row.mfl_pid).replace(/\D/g, "");
          if (!pid) return;
          const posKey = positionGroupKey(row.position);
          const games = safeInt(row.games, 0);
          maxGames = Math.max(maxGames, games);
          (byPosGroup[posKey] = byPosGroup[posKey] || []).push({
            pid: pid, points: safeNum(row.mfl_points, 0), name: safeStr(row.player_name), games: games
          });
        });
      });
      const rankByPid = Object.create(null);
      Object.keys(byPosGroup).forEach(function (posKey) {
        // Same tie-break the real pipeline uses: -points then name ascending.
        byPosGroup[posKey].sort(function (a, b) {
          return (b.points - a.points) || a.name.localeCompare(b.name);
        });
        byPosGroup[posKey].forEach(function (row, i) { rankByPid[row.pid] = i + 1; });
      });
      STATE.tagPointsData = { rankByPid: rankByPid, maxGames: maxGames, season: season };
    } catch (e) {
      STATE.tagPointsDataError = "Points rank load failed: " + (e.message || String(e));
      console.warn("[fo]", STATE.tagPointsDataError);
    } finally {
      STATE.tagPointsDataLoading = false;
    }
  }

  // True tag-ELIGIBILITY rank bands (build_tag_tracking.py's TAG_RULES rank_min/
  // rank_max) — DISTINCT from tag_tracking.json's calc_breakdown rank_min/
  // rank_max, which are the narrower PRICING bands (e.g. QB T3 prices off
  // ranks 16-24, but every QB ranked 16th or worse is still T3-eligible — the
  // eligibility band is unbounded at the bottom, 0 here meaning "no max").
  // PK/PN excluded — canon prices them as prior salary + $1K (T3.6), not a
  // points tier, so points-rank assignment doesn't apply to them.
  const TAG_ELIGIBILITY_BANDS = {
    QB: [[1, 5], [6, 15], [16, 0]],
    RB: [[1, 4], [5, 8], [9, 0]],
    WR: [[1, 6], [7, 14], [15, 0]],
    TE: [[1, 3], [4, 6], [7, 0]],
    DL: [[1, 6], [7, 0]],
    LB: [[1, 6], [7, 0]],
    DB: [[1, 6], [7, 0]]
  };
  // Which tier NUMBER a points rank falls into (via the real eligibility
  // bands above), then return THAT tier's entry from posBreakdown — whose
  // base_bid is still the AAV-priced value, untouched (Keith 2026-08-04:
  // the AAV tier-pricing calc is correct as-is).
  function tierForPointsRank(posKey, posBreakdown, rank) {
    const bands = TAG_ELIGIBILITY_BANDS[posKey];
    const tiers = (posBreakdown && posBreakdown.tiers) || [];
    if (!bands || !tiers.length) return null;
    for (let i = 0; i < bands.length && i < tiers.length; i++) {
      const lo = bands[i][0], hi = bands[i][1];
      if (rank >= lo && (!hi || rank <= hi)) return tiers[i];
    }
    return null;
  }

  function renderTagTab() {
    const body = $("#fo-tag-body");
    const meta = $("#fo-tag-meta");
    if (!body) return;
    if (STATE.tagDataLoading) { body.innerHTML = '<div class="fo-placeholder">Loading tag plan…</div>'; return; }
    if (!STATE.tagData) {
      body.innerHTML = '<div class="fo-placeholder">Loading tag plan…</div>';
      loadTagPlanData().then(renderTagTab);
      return;
    }
    if (STATE.tagDataError) { body.innerHTML = '<div class="fo-placeholder fo-err">' + escapeHtml(STATE.tagDataError) + '</div>'; return; }
    // Non-blocking: the projected-year table renders AAV-only immediately
    // (today's behavior) and upgrades to points-ranked tiers once this
    // resolves, rather than delaying the whole tab on a second fetch.
    if (!STATE.tagPointsData && !STATE.tagPointsDataLoading) {
      loadTagPointsData().then(renderTagTab);
    }
    const m = STATE.tagData.meta || {};
    if (meta) {
      meta.textContent =
        "Cycle: tagging for " + (m.tracking_for_season || (safeInt(SEASON, 0))) +
        " (source season " + (m.season || "?") + ") · " +
        (m.count || STATE.tagData.rows.length) + " eligible players · " +
        "scoring weeks " + (m.scoring_weeks_used || "?") + " · " +
        "prior AAV snapshot wk " + (m.aav_snapshot_week || "?");
    }
    // "proj2027" retired — the 2027 projection now lives in the Calc Breakdown
    // behind a year dropdown (Keith 2026-06-05). Migrate any stale state.
    if (STATE.tagSubview === "proj2027") STATE.tagSubview = "breakdown";
    if (STATE.tagSubview === "breakdown") {
      body.innerHTML = renderTagBreakdown();
      wireTagBreakdown(body);
    } else {
      body.innerHTML = renderTagEligible();
    }
  }

  // Wire the Calc Breakdown's year dropdown + the folded-in per-player tag-value
  // table (which reuses the proj2027 filter/sort/row-click handlers).
  function wireTagBreakdown(body) {
    const y = $("#fo-tagbd-year");
    if (y) y.addEventListener("change", function () { STATE.tagBreakdownYear = safeInt(this.value, STATE.tagBreakdownYear); renderTagTab(); });
    wireProj2027(body);
  }

  // Wire the 2027 projection subview's filters / sort / row-click (renderTagTab
  // sets innerHTML, so handlers attach after each render).
  function wireProj2027(body) {
    const t = $("#fo-p27-team"); if (t) t.addEventListener("change", function () { STATE.proj2027Filter.team = this.value; renderTagTab(); });
    const p = $("#fo-p27-pos"); if (p) p.addEventListener("change", function () { STATE.proj2027Filter.pos = this.value; renderTagTab(); });
    const c = $("#fo-p27-clear"); if (c) c.addEventListener("click", function () { STATE.proj2027Filter = { team: "", pos: "" }; renderTagTab(); });
    $$("[data-p27sort]", body).forEach(function (th) {
      th.addEventListener("click", function () {
        const k = this.getAttribute("data-p27sort");
        if (STATE.proj2027Sort.key === k) STATE.proj2027Sort.dir *= -1;
        else { STATE.proj2027Sort.key = k; STATE.proj2027Sort.dir = 1; }
        renderTagTab();
      });
    });
    $$("tbody tr[data-pid]", body).forEach(function (tr) {
      tr.addEventListener("click", function () { if (tr.dataset.pid) openSlideover(tr.dataset.pid, tr.dataset.fid); });
    });
  }

  // Resolve a player's CURRENT roster type from live STATE.teams.
  // Used to (a) hide players who've since been extended (EXT*) — they
  // burned their final-year eligibility on extension instead of tag —
  // and (b) flip Tag → Untag for players currently chipped TAG.
  function currentRosterStateFor(pid, fid) {
    const t = STATE.teams.find(function (x) { return x.fid === fid; });
    if (!t) return null;
    const p = (t.players || []).find(function (x) { return x.id === pid; });
    if (!p) return { stillRostered: false };
    const type = safeStr(p.type).toUpperCase();
    // Optimistic dry-run overlay — server didn't persist but we want
    // the UI to reflect the user's just-taken action so they can see
    // it in subsequent renders / try the inverse.
    const key = pid + ":" + fid;
    const optTagged   = !!STATE.optimisticTags[key];
    const optUntagged = !!STATE.optimisticUntags[key];
    const isTagged   = optTagged   ? true  : (optUntagged ? false : type === "TAG");
    const isExtended = type.indexOf("EXT") === 0;
    return {
      stillRostered: true,
      type: isTagged ? "TAG" : type,
      isTagged: isTagged,
      isExtended: isExtended,
      optimistic: optTagged || optUntagged
    };
  }

  function renderTagEligible() {
    const f = STATE.tagFilter;
    const sort = STATE.tagSort;
    const search = safeStr(f.search).toLowerCase();
    // §C8: tags lock at the tag deadline. Past it, no new tags can be submitted
    // (the worker also 410s them) — show a locked banner + disable Tag buttons.
    const tagsLocked = isPastTagDeadlineFO();
    const subsKey = STATE.tagData.submissions.reduce(function (acc, s) {
      acc[s.player_id + ":" + s.franchise_id + ":" + s.side] = s;
      return acc;
    }, Object.create(null));

    const filtered = STATE.tagData.rows.filter(function (r) {
      if (!r.is_tag_eligible) return false;
      // Currently-extended players burned their eligibility on Ext1/Ext2.
      // Keep tagged ones in the list so user can Untag from this view.
      const live = currentRosterStateFor(r.player_id, r.franchise_id);
      if (live && live.stillRostered && live.isExtended) return false;
      if (f.pos !== "ALL" && posBucket(r.position) !== f.pos) return false;
      if (f.side !== "ALL" && r.side !== f.side) return false;
      if (f.franchise && r.franchise_id !== f.franchise) return false;
      if (search) {
        const hay = (r.player_name + " " + r.franchise_name + " " + r.position).toLowerCase();
        if (hay.indexOf(search) < 0) return false;
      }
      return true;
    }).map(function (r) {
      const live = currentRosterStateFor(r.player_id, r.franchise_id);
      // AAV floor base — the value that gets multiplied by 1.10 in the
      // tag formula. Canon: AAV ONLY, never salary fields (Keith
      // 2026-05-19). For Mahomes that's $54K (his AAV), not $68K
      // (his BL Y2 salary). Formula = max(this, tier base bid).
      const floorBase = Math.max(
        safeInt(r.prior_aav_week1, 0),
        safeInt(r.aav, 0)
      );
      return Object.assign({}, r, {
        effective_tag_salary: effectiveTagSalaryForRow(r),
        effective_formula: effectiveTagFormulaForRow(r),
        floor_base: floorBase,
        already_submitted: !!subsKey[r.player_id + ":" + r.franchise_id + ":" + r.side],
        currently_tagged: !!(live && live.isTagged)
      });
    });
    const numericKeys = ["tagSalary", "points", "rank", "tier", "priorAav"];
    filtered.sort(function (a, b) {
      let va, vb;
      switch (sort.key) {
        case "tagSalary": va = a.effective_tag_salary; vb = b.effective_tag_salary; break;
        case "points":    va = a.points_total; vb = b.points_total; break;
        case "rank":      va = a.pos_rank || 9999; vb = b.pos_rank || 9999; break;
        case "tier":      va = a.tag_tier || 9; vb = b.tag_tier || 9; break;
        case "priorAav":  va = a.floor_base; vb = b.floor_base; break;
        case "name":      va = a.player_name; vb = b.player_name; break;
        case "pos":       va = posBucket(a.position); vb = posBucket(b.position); break;
        case "franchise": va = a.franchise_name; vb = b.franchise_name; break;
        case "side":      va = a.side; vb = b.side; break;
        default:          va = a.effective_tag_salary; vb = b.effective_tag_salary;
      }
      if (numericKeys.indexOf(sort.key) >= 0) return ((Number(va) || 0) - (Number(vb) || 0)) * sort.dir;
      return String(va || "").localeCompare(String(vb || "")) * sort.dir;
    });
    const arrow = (k) => sort.key === k ? (sort.dir > 0 ? " ▲" : " ▼") : "";

    // Filter chips + selects
    const posChips = ["ALL", "QB", "RB", "WR", "TE", "PK", "PN", "IDP"].map(function (p) {
      const on = f.pos === p;
      return `<button type="button" class="fo-pos-chip ${on ? "active" : ""}" data-tag-pos="${p}">${p === "ALL" ? "All" : p}</button>`;
    }).join("");
    const teamOpts = ['<option value="">All</option>'].concat(STATE.teams.map(function (t) {
      return `<option value="${escapeHtml(t.fid)}" ${f.franchise === t.fid ? "selected" : ""}>${escapeHtml(t.name)}</option>`;
    })).join("");

    const rows = filtered.map(function (r) {
      const sideChip = `<span class="fo-tag-side ${r.side.toLowerCase()}">${r.side === "OFFENSE" ? "OFF" : "DEF/ST"}</span>`;
      const tierChip = r.tag_tier > 0 ? `<span class="fo-tag-tier t${r.tag_tier}">T${r.tag_tier}</span>` : "—";
      // AAV Floor column — the value feeding the 1.10 floor. AAV only;
      // current/prior salary are intentionally ignored per canon.
      // Tooltip shows the breakdown.
      const floorTip = `current_aav=${fmtUSD(r.aav)} · prior_aav=${fmtUSD(r.prior_aav_week1)} → max = ${fmtUSD(r.floor_base)} × 1.10 → ${fmtUSD(Math.ceil((r.floor_base * 1.10) / 1000) * 1000)}`;
      const priorCol = r.floor_base > 0
        ? `<span class="fo-tt" data-tip="${escapeHtml(floorTip)}">${fmtUSD(r.floor_base)}</span>`
        : "—";
      let tagBtn;
      const optKey = r.player_id + ":" + pad4(r.franchise_id);
      const isOptimistic = !!STATE.optimisticTags[optKey] || !!STATE.optimisticUntags[optKey];
      if (r.currently_tagged) {
        // Player is currently chipped TAG — surface Untag so user can
        // revert from this view. In dry-run mode this might be an
        // optimistic flip (server didn't persist) — annotate it.
        const dryHint = isOptimistic && IS_DRY_RUN ? ' <span class="small" style="color:var(--warn); font-style:italic;">(dry-run local)</span>' : "";
        tagBtn = `<button class="btn small warn fo-tag-untag-btn" data-pid="${escapeHtml(r.player_id)}" data-fid="${escapeHtml(r.franchise_id)}">Untag</button>${dryHint}`;
      } else if (r.already_submitted) {
        // Submission row exists but player isn't currently chipped TAG
        // (rare — partial submission state). Show a passive marker.
        tagBtn = `<span class="fo-tt" data-tip="Tag submission recorded but player not currently chipped TAG. Check submission log."><button class="btn small secondary" disabled>Submitted</button></span>`;
      } else if (tagsLocked) {
        tagBtn = `<span class="fo-tt" data-tip="Tag deadline has passed — tags are locked for ${escapeHtml(String(SEASON))} (§C8)."><button class="btn small secondary" disabled>🔒 Locked</button></span>`;
      } else {
        tagBtn = `<button class="btn small fo-tag-tag-btn" data-pid="${escapeHtml(r.player_id)}" data-fid="${escapeHtml(r.franchise_id)}" data-side="${escapeHtml(r.side)}">Tag</button>`;
      }
      const rowCls = r.currently_tagged ? "fo-tag-row fo-tag-row-tagged" : "fo-tag-row";
      return `
        <tr data-pid="${escapeHtml(r.player_id)}" data-fid="${escapeHtml(r.franchise_id)}" class="${rowCls}">
          <td>${escapeHtml(r.player_name)}</td>
          <td><span class="fo-pos ${escapeHtml(posBucket(r.position))}">${escapeHtml(r.position)}</span></td>
          <td>${sideChip}</td>
          <td>${escapeHtml(r.franchise_name)}</td>
          <td class="num">${tierChip}</td>
          <td class="num">${r.pos_rank || "—"}</td>
          <td class="num">${r.points_total > 0 ? Math.round(r.points_total).toLocaleString() : "—"}</td>
          <td class="num">${priorCol}</td>
          <td class="num"><strong>${fmtUSD(r.effective_tag_salary)}</strong></td>
          <td><span class="fo-tt" data-tip="${escapeHtml(r.effective_formula)}"><span class="small" style="color:var(--muted);">ⓘ formula</span></span></td>
          <td>${tagBtn}</td>
        </tr>`;
    }).join("");

    const lockedBanner = tagsLocked
      ? '<div class="fo-card" style="border-left:3px solid #c0392b;padding:12px;"><strong style="color:#c0392b;">🔒 Tags locked for ' + escapeHtml(String(SEASON)) + '</strong> — the tag deadline has passed. No new tags can be submitted; committed tags are final for the season (§C8). Cut before the FA Auction starts to release a tagged player.</div>'
      : "";
    return `
      ${lockedBanner}
      <div class="fo-card">
        <div class="fo-toolbar-row">
          <label class="fo-field" style="flex:1; min-width:200px;">
            <span>Search</span>
            <input type="search" id="fo-tag-search" placeholder="Player, franchise, position…" value="${escapeHtml(f.search)}">
          </label>
          <label class="fo-field">
            <span>Tag Side</span>
            <select id="fo-tag-side">
              <option value="ALL" ${f.side === "ALL" ? "selected" : ""}>All</option>
              <option value="OFFENSE" ${f.side === "OFFENSE" ? "selected" : ""}>Offense</option>
              <option value="DEFENSE" ${f.side === "DEFENSE" ? "selected" : ""}>Defense / ST</option>
            </select>
          </label>
          <label class="fo-field">
            <span>Franchise</span>
            <select id="fo-tag-franchise">${teamOpts}</select>
          </label>
          <button type="button" class="btn secondary" id="fo-tag-reset">Reset</button>
        </div>
        <div class="fo-toolbar-row" style="margin-top:8px;">
          <div class="fo-pos-chips" id="fo-tag-pos-chips">${posChips}</div>
          <span class="small" style="color:var(--muted); margin-left:auto;">${filtered.length} of ${STATE.tagData.rows.filter(function (r) { return r.is_tag_eligible; }).length} eligible (extended players excluded)</span>
        </div>
      </div>
      <div class="fo-card">
        <p class="fo-row-hint">
          💡 Effective tag $ = max(tier base bid, <strong>max(current AAV, prior AAV) × 1.10</strong> rounded up to $1K). Canon: AAV only — current/prior salary are <em>not</em> in the floor (back-loaded contracts don't bump tag cost). Hover ⓘ for the per-row breakdown.
        </p>
        <table class="fo-table">
          <thead>
            <tr>
              <th data-tag-sort="name">Player${arrow("name")}</th>
              <th data-tag-sort="pos">Pos${arrow("pos")}</th>
              <th data-tag-sort="side">Side${arrow("side")}</th>
              <th data-tag-sort="franchise">Franchise${arrow("franchise")}</th>
              <th class="num" data-tag-sort="tier">Tier${arrow("tier")}</th>
              <th class="num" data-tag-sort="rank">Pos Rank${arrow("rank")}</th>
              <th class="num" data-tag-sort="points">Points${arrow("points")}</th>
              <th class="num" data-tag-sort="priorAav">AAV Floor${arrow("priorAav")}</th>
              <th class="num" data-tag-sort="tagSalary">Tag $${arrow("tagSalary")}</th>
              <th>Formula</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
  }

  // 2027 tag-VALUE projection (Keith 2026-06-04): for each expiring (cy=1) player,
  // what their tag would cost if tagged next year. tag value = max(positional
  // tier base bid, max(current AAV, prior AAV) × 1.10 rounded up to $1K) — canon
  // §C8, AAV-only. REUSES the pipeline's tier base bids from calc_breakdown (does
  // NOT re-derive the tier math). Tier bids reflect the current source season's
  // points; they update as the season's YTD points come in (full living
  // projection is parked in project_tag_value_2027_projection_parking_lot.md).
  // Per-player projected tag-VALUE table for `projYear`. Folded into the Calc
  // Breakdown (year dropdown) — no longer a separate subview (Keith 2026-06-05:
  // "we don't need a separate tab ... calculation should be based off this").
  // Build PROJECTED (next-season) tag tiers from CURRENT-season contracts: rank
  // the players UNDER CONTRACT (rostered, AAV > 0) by AAV per position, drop them
  // into the SAME tier rank-bands the pipeline defines (rank_min/rank_max), and
  // set each tier's base bid = the AVERAGE AAV of that band. (Keith 2026-06-06:
  // "take the players under contract and apply their 2026 AAV to the rules that
  // determine the cost for Tier 1, 2…; these numbers change as rosters fill
  // out.") Excludes free agents (not rostered) like Mahomes, so the projection
  // reflects who can actually be tagged.
  function projectedCalcBreakdown() {
    const baseCb = (STATE.tagData && STATE.tagData.meta && STATE.tagData.meta.calc_breakdown) || {};
    const byPos = Object.create(null);
    (STATE.teams || []).forEach(function (team) {
      (team.players || []).forEach(function (p) {
        const aav = Math.max(displayAavForPlayer(p), 0);   // true AAV (contractInfo token), NOT the salary fallback
        if (aav <= 0) return;                              // must be under contract
        const posKey = positionGroupKey(p.position);
        (byPos[posKey] = byPos[posKey] || []).push({ player_name: safeStr(p.name), aav: aav });
      });
    });
    const out = Object.create(null);
    Object.keys(baseCb).forEach(function (posKey) {
      const tiers = (baseCb[posKey] && baseCb[posKey].tiers) || [];
      const ranked = (byPos[posKey] || []).slice()
        .sort(function (a, b) { return b.aav - a.aav; })
        .map(function (pl, i) { return { rank: i + 1, player_name: pl.player_name, aav: pl.aav }; });
      out[posKey] = { tiers: tiers.map(function (t) {
        const lo = safeInt(t.rank_min, 0) || 1, hi = safeInt(t.rank_max, 0) || lo;
        const band = ranked.filter(function (pl) { return pl.rank >= lo && pl.rank <= hi; });
        const sum = band.reduce(function (s, pl) { return s + pl.aav; }, 0);
        const bid = band.length ? Math.round(sum / band.length / 1000) * 1000 : 0;
        return { tier: t.tier, label: t.label, rank_min: lo, rank_max: hi, base_bid: bid, players: band };
      }) };
    });
    return out;
  }

  // name → tier base bid, + lowest-tier bid per position (the position floor).
  // Shared by renderTagValueTable and the Cap Planning row badge so the two
  // screens can never disagree about a player's projected tag value.
  const _tagNameKey = function (s) { return safeStr(s).toLowerCase().replace(/[^a-z]/g, ""); };
  function buildTagTierLookup(cb) {
    const tierByName = Object.create(null);
    const lowestBidByPos = Object.create(null);
    Object.keys(cb).forEach(function (posKey) {
      const tiers = (cb[posKey] && cb[posKey].tiers) || [];
      if (tiers.length) lowestBidByPos[posKey] = safeInt(tiers[tiers.length - 1].base_bid, 0);
      tiers.forEach(function (t) {
        (t.players || []).forEach(function (pl) {
          tierByName[posKey + "|" + _tagNameKey(pl.player_name)] = { bid: safeInt(t.base_bid, 0), label: "T" + t.tier };
        });
      });
    });
    return { tierByName: tierByName, lowestBidByPos: lowestBidByPos };
  }

  // Projected tag value for ONE player, or null if they're not a tag
  // candidate. `projecting` distinguishes the locked current cycle (no points
  // rank, no already-tagged exclusion — that cycle's tags are already final)
  // from the forward projection.
  function computeProjectedTagValue(p, cb, lookup, projecting) {
    // Every final-year (cy=1) active player is a potential tag candidate —
    // including Vet-Ext / FL / BL (extension ≠ tag). Taxi/IR excluded.
    if (safeInt(p.years, 0) !== 1 || p.isTaxi || p.isIr) return null;
    // Already-tagged players CANNOT be re-tagged (canon §911 item 12: once
    // tagged → must go to next summer's FA Auction). So a player STILL
    // carrying a Tag contract is not a valid candidate for a projected tag.
    // The drop-before-auction reset (Keith 2026-06-07) is handled naturally:
    // a dropped+re-won player comes back as Vet-FAA (type ≠ Tag) and so is
    // included again here. Only the live Tag contract is excluded.
    if (projecting && /tag/i.test(safeStr(p.type))) return null;
    const posKey = positionGroupKey(p.position);
    const aav = Math.max(displayAavForPlayer(p), 0);   // true AAV (contractInfo token), NOT the salary fallback
    const floor = aav > 0 ? Math.ceil((aav * 1.10) / 1000) * 1000 : 0;   // AAV × 1.10, ceil to $1K
    // Tier ASSIGNMENT: points-scored rank when live data is available
    // (canon — matches build_tag_tracking.py's split of assignment-by-points
    // vs pricing-by-AAV). Falls back to the AAV name-match this table always
    // used when a player has no points data yet (rookies, sparse IDP, or the
    // points fetch hasn't resolved) — never a blank/broken cell.
    const ptsRank = (STATE.tagPointsData && projecting)
      ? STATE.tagPointsData.rankByPid[safeStr(p.id)] : undefined;
    const ptsTier = ptsRank ? tierForPointsRank(posKey, cb[posKey], ptsRank) : null;
    const lk = lookup.tierByName[posKey + "|" + _tagNameKey(p.name)];
    const tierBid = ptsTier ? safeInt(ptsTier.base_bid, 0) : lk ? lk.bid : (lookup.lowestBidByPos[posKey] || 0);
    const tierLabel = ptsTier ? "T" + ptsTier.tier : lk ? lk.label : "—";
    return {
      posKey: posKey, aav: aav, floor: floor, tier_bid: tierBid, tier_label: tierLabel,
      tag_value: Math.max(tierBid, floor), ytd_pts_rank: ptsRank || null,
    };
  }

  function renderTagValueTable(projYear) {
    const m = STATE.tagData.meta || {};
    const projecting = projYear > (safeInt(SEASON, 0) || 0);
    const cb = projecting ? projectedCalcBreakdown() : (m.calc_breakdown || {});
    if (!Object.keys(cb).length) {
      return '<div class="fo-placeholder">No calc_breakdown in tag_tracking.json — can\'t project tier bids.</div>';
    }
    const lookup = buildTagTierLookup(cb);
    let rows = [];
    let excludedTagged = 0;
    (STATE.teams || []).forEach(function (team) {
      (team.players || []).forEach(function (p) {
        if (projecting && /tag/i.test(safeStr(p.type)) && safeInt(p.years, 0) === 1 && !p.isTaxi && !p.isIr) {
          excludedTagged += 1; return;
        }
        const v = computeProjectedTagValue(p, cb, lookup, projecting);
        if (!v) return;
        rows.push({
          pid: safeStr(p.id), fid: safeStr(team.fid), name: safeStr(p.name), team: safeStr(team.name),
          pos: safeStr(p.position), type: safeStr(p.type), aav: v.aav, floor: v.floor, tier_bid: v.tier_bid,
          tier_label: v.tier_label, tag_value: v.tag_value, ytd_pts_rank: v.ytd_pts_rank,
        });
      });
    });
    STATE.proj2027Filter = STATE.proj2027Filter || { team: "", pos: "" };
    const teamOpts = Array.from(new Set(rows.map(function (r) { return r.team; }).filter(Boolean))).sort();
    const posOpts = Array.from(new Set(rows.map(function (r) { return r.pos; }).filter(Boolean))).sort();
    const total = rows.length;
    rows = rows.filter(function (r) {
      return (!STATE.proj2027Filter.team || r.team === STATE.proj2027Filter.team) &&
             (!STATE.proj2027Filter.pos || r.pos === STATE.proj2027Filter.pos);
    });
    STATE.proj2027Sort = STATE.proj2027Sort || { key: "tag_value", dir: -1 };
    const sk = STATE.proj2027Sort.key, sd = STATE.proj2027Sort.dir;
    rows.sort(function (a, b) {
      const av = a[sk], bv = b[sk];
      if (typeof av === "string") return sd * av.localeCompare(bv);
      return sd * ((av || 0) - (bv || 0));
    });
    const selStyle = "background:var(--panel-alt);color:var(--text);border:1px solid var(--border);padding:4px 8px;border-radius:4px;";
    const opt = function (v, l, s) { return '<option value="' + escapeHtml(v) + '"' + (s ? " selected" : "") + ">" + escapeHtml(l) + "</option>"; };
    const teamSel = '<select id="fo-p27-team" style="' + selStyle + '">' + opt("", "All teams", !STATE.proj2027Filter.team) + teamOpts.map(function (t) { return opt(t, t, STATE.proj2027Filter.team === t); }).join("") + "</select>";
    const posSel = '<select id="fo-p27-pos" style="' + selStyle + '">' + opt("", "All positions", !STATE.proj2027Filter.pos) + posOpts.map(function (pp) { return opt(pp, pp, STATE.proj2027Filter.pos === pp); }).join("") + "</select>";
    const clr = (STATE.proj2027Filter.team || STATE.proj2027Filter.pos) ? ' <button type="button" id="fo-p27-clear" class="btn small secondary">Clear</button>' : "";
    const hdr = function (key, label, align) {
      const arrow = STATE.proj2027Sort.key === key ? (STATE.proj2027Sort.dir > 0 ? " ▲" : " ▼") : "";
      return '<th data-p27sort="' + key + '" style="cursor:pointer;text-align:' + (align || "left") + ';white-space:nowrap;">' + escapeHtml(label) + arrow + "</th>";
    };
    const trs = rows.map(function (r) {
      return '<tr data-pid="' + escapeHtml(r.pid) + '" data-fid="' + escapeHtml(r.fid) + '" style="cursor:pointer;" title="Open ' + escapeHtml(r.name) + '">' +
        "<td>" + escapeHtml(r.name) + "</td><td>" + escapeHtml(r.team) + "</td>" +
        '<td><span class="fo-pos ' + escapeHtml(posBucket(r.pos)) + '">' + escapeHtml(r.pos) + "</span></td>" +
        "<td>" + escapeHtml(r.type) + "</td>" +
        '<td class="num">' + escapeHtml(fmtUSD(r.aav)) + "</td>" +
        '<td class="num">' + escapeHtml(fmtUSD(r.floor)) + "</td>" +
        '<td class="num small" style="color:var(--muted);">' + (r.ytd_pts_rank == null ? "N/A" : "#" + r.ytd_pts_rank) + "</td>" +
        '<td class="num">' + escapeHtml(fmtUSD(r.tier_bid)) + ' <span class="small" style="color:var(--muted);">' + escapeHtml(r.tier_label) + "</span></td>" +
        '<td class="num"><strong>' + escapeHtml(fmtUSD(r.tag_value)) + "</strong></td></tr>";
    }).join("");
    const isProjected = projYear > (safeInt(SEASON, 0) || 0);
    const hint = isProjected
      ? '💡 <strong>Projected ' + projYear + ' tag value</strong> for every expiring (final-year) player: <code>max(positional tier base bid, AAV × 1.10)</code>, canon §C8. <strong>Tier assignment</strong> ranks each player by their ' + safeInt(SEASON, 0) + ' points scored so far this season (falls back to the AAV rank used below when a player has no points data yet — rookies, sparse IDP samples, or before this loads). <strong>Tier pricing</strong> stays AAV-only — the average AAV of the players currently under contract in that rank band — so it shifts as rosters change and settles once the ' + projYear + ' contract deadline freezes contracts for the season. <strong>Already-tagged players are excluded</strong> — once tagged, a player can’t be re-tagged; they must go to the FA auction (a drop before that auction resets them, since they re-enter the auction).'
      : '💡 <strong>' + projYear + ' tag value</strong> for every expiring (final-year) player: <code>max(positional tier base bid, AAV × 1.10)</code>, canon §C8 AAV-only — this cycle\'s tiers (source season ' + escapeHtml(String(m.season || "?")) + ').';
    const staleness = isProjected
      ? (STATE.tagPointsDataError
          ? '<p class="fo-row-hint" style="color:var(--err);">⚠ ' + escapeHtml(STATE.tagPointsDataError) + ' — Tier assignment is running on the AAV-only fallback until this loads.</p>'
          : STATE.tagPointsData
            ? '<p class="fo-row-hint" style="color:var(--muted);font-size:11px;">Points data: up to ' + STATE.tagPointsData.maxGames + ' game' + (STATE.tagPointsData.maxGames === 1 ? "" : "s") + ' loaded per player this season' + (STATE.tagPointsData.maxGames === 0 ? ' — <strong style="color:#d4a017;">none loaded yet, every row is on the AAV-only fallback</strong>' : '') + '. This table is only as current as the last points backfill — check the game count against the real week before trusting a tier assignment.</p>'
            : '<p class="fo-row-hint" style="color:var(--muted);font-size:11px;">Loading points data…</p>')
      : "";
    return '<div class="fo-card">' +
      '<p class="fo-row-hint">' + hint + '</p>' + staleness +
      '<div style="display:flex;gap:8px;align-items:center;margin:8px 0;flex-wrap:wrap;"><span class="small" style="color:var(--muted);">Filter</span>' + teamSel + posSel + clr +
      '<span class="small" style="color:var(--muted);margin-left:auto;">' + rows.length + (rows.length === total ? "" : " of " + total) + ' expiring players' + (excludedTagged ? ' · ' + excludedTagged + ' already-tagged excluded' : '') + '</span></div>' +
      '<div class="fo-table-scroll"><table class="fo-table" id="fo-p27-table"><thead><tr>' +
      hdr("name", "Player") + hdr("team", "Team") + hdr("pos", "Pos") + hdr("type", "Type") +
      hdr("aav", "AAV", "right") + hdr("floor", "AAV×1.10", "right") +
      '<th style="text-align:right;white-space:nowrap;" title="In-season points rank within position — will drive the tag tier once the season starts (N/A in the offseason)">YTD Pts Rank</th>' +
      hdr("tier_bid", "Tier Bid", "right") +
      hdr("tag_value", "Proj. " + projYear + " Tag", "right") +
      "</tr></thead><tbody>" + (trs || '<tr><td colspan="9" class="fo-table-empty">No expiring players match.</td></tr>') + "</tbody></table></div></div>";
  }

  function renderTagBreakdown() {
    const m = STATE.tagData.meta || {};
    const cb = m.calc_breakdown || {};
    const posKeys = Object.keys(cb).sort();
    if (!posKeys.length) {
      return '<div class="fo-placeholder">No calc_breakdown in tag_tracking.json meta.</div>';
    }
    // Year selector — the 2026 deadline has passed, so default to the forward
    // projection (SEASON+1). The tier structure is the same pipeline output for
    // both years (a documented stand-in for the projection until SEASON+1's
    // source season plays out — see project_tag_value_2027_projection_parking_lot).
    const curCycle = safeInt(SEASON, 0) || 2026;
    if (STATE.tagBreakdownYear == null) STATE.tagBreakdownYear = curCycle + 1;
    const year = safeInt(STATE.tagBreakdownYear, curCycle + 1);
    const isProjected = year > curCycle;
    // Projected year → recompute tiers from CURRENT contracts (excludes FAs);
    // current cycle → the pipeline's locked tiers.
    const cbY = isProjected ? projectedCalcBreakdown() : cb;
    const yopt = function (y) { return '<option value="' + y + '"' + (y === year ? " selected" : "") + ">" + y + (y > curCycle ? " (projected)" : "") + "</option>"; };
    const yearSel = '<div style="display:flex;gap:8px;align-items:center;margin:4px 0 12px;flex-wrap:wrap;">' +
      '<label class="small" style="color:var(--muted);">Tag year</label>' +
      '<select id="fo-tagbd-year" style="background:var(--panel-alt);color:var(--text);border:1px solid var(--border);padding:4px 8px;border-radius:4px;">' +
      yopt(curCycle + 1) + yopt(curCycle) + "</select>" +
      (isProjected
        ? '<span class="small" style="color:#d4a017;">Projected ' + year + ' — built from players <strong>currently under contract</strong> (their current AAVs); finalizes at the ' + year + ' contract deadline as rosters change</span>'
        : '<span class="small" style="color:var(--muted);">current cycle (locked at the ' + year + ' tag deadline)</span>') +
      "</div>";
    const sections = posKeys.map(function (posKey) {
      const pos = cbY[posKey] || {};
      const tiers = Array.isArray(pos.tiers) ? pos.tiers : [];
      const tierCards = tiers.map(function (tier) {
        const players = Array.isArray(tier.players) ? tier.players : [];
        const playerRows = players.map(function (p) {
          return `<li><span class="rk">#${p.rank}</span> ${escapeHtml(p.player_name)} <span class="small" style="color:var(--muted);">${fmtUSD(p.aav)}</span></li>`;
        }).join("");
        return `
          <div class="fo-tag-tier-card">
            <div class="fo-tag-tier-head">
              <span class="fo-tag-tier t${tier.tier}">T${tier.tier}</span>
              <span class="fo-tag-tier-label">${escapeHtml(tier.label || "")}</span>
              <span class="fo-tag-tier-bid">${fmtUSD(tier.base_bid)}</span>
            </div>
            <div class="small" style="color:var(--muted); margin-bottom:6px;">Ranks ${tier.rank_min}-${tier.rank_max}</div>
            <ul class="fo-tag-player-list">${playerRows}</ul>
          </div>`;
      }).join("");
      return `
        <div class="fo-card">
          <h2 style="margin:0 0 12px;">${escapeHtml(positionLongLabel(posKey))} (${posKey})</h2>
          <div class="fo-tag-tier-grid">${tierCards}</div>
        </div>`;
    }).join("");
    return yearSel + `
      <p class="fo-row-hint">
        💡 ${isProjected
          ? "Projected tiers rank the players <strong>currently under contract</strong> by <strong>AAV</strong> and average each rank band — they shift as rosters fill out (free agents excluded)."
          : "Tag tiers come from prior season's <strong>positional rank</strong> by points; each tier's <strong>base bid</strong> = average AAV of that rank band."}
        Effective tag salary = max(the base bid, <strong>max(current AAV, prior AAV) × 1.10</strong>). Canon: AAV-only — never current/prior salary.
      </p>
      ${sections}
      <h2 style="margin:20px 0 4px;">Tag values by player — ${year}${isProjected ? " (projected)" : ""}</h2>
      ${renderTagValueTable(year)}`;
  }

  function positionLongLabel(k) {
    return ({QB:"Quarterbacks", RB:"Running Backs", WR:"Wide Receivers", TE:"Tight Ends",
             DL:"Defensive Line", LB:"Linebackers", DB:"Defensive Backs", PK:"Kickers", PN:"Punters"})[k] || k;
  }

  // Delegated handlers — bound once on the tag section at init.
  function setupTagTabDelegation() {
    const section = document.querySelector('.fo-section[data-section="tag"]');
    if (!section) return;
    section.addEventListener("click", function (e) {
      const chip = e.target.closest("#fo-tag-pos-chips .fo-pos-chip");
      if (chip) { STATE.tagFilter.pos = chip.dataset.tagPos || "ALL"; renderTagTab(); return; }
      if (e.target.closest("#fo-tag-reset")) {
        STATE.tagFilter = { pos: "ALL", side: "ALL", franchise: "", search: "" };
        renderTagTab(); return;
      }
      const th = e.target.closest("th[data-tag-sort]");
      if (th) {
        const key = th.dataset.tagSort;
        if (STATE.tagSort.key === key) STATE.tagSort.dir *= -1;
        else {
          STATE.tagSort.key = key;
          STATE.tagSort.dir = ["tagSalary", "points", "priorAav", "rank", "tier"].includes(key) ? -1 : 1;
        }
        renderTagTab(); return;
      }
      // Tag button → submit directly (mirrors live FO: row click in
      // Tagging tab fires submitTagPlanSelection, not modal).
      const tagBtn = e.target.closest(".fo-tag-tag-btn");
      if (tagBtn) {
        e.stopPropagation();
        const row = (STATE.tagData && STATE.tagData.rows || []).find(function (r) {
          return r.player_id === tagBtn.dataset.pid && pad4(r.franchise_id) === pad4(tagBtn.dataset.fid);
        });
        if (row) submitTag(row);
        return;
      }
      // Untag button → open slide-over (Untag flow lives in Actions tab).
      const untagBtn = e.target.closest(".fo-tag-untag-btn");
      if (untagBtn) {
        e.stopPropagation();
        openSlideover(untagBtn.dataset.pid, untagBtn.dataset.fid);
        return;
      }
      const row = e.target.closest("tr[data-pid]");
      if (row && !e.target.closest("button")) {
        openSlideover(row.dataset.pid, row.dataset.fid);
      }
    });
    section.addEventListener("change", function (e) {
      // Stop propagation so the change can't be misinterpreted by any
      // global listener (Roster's #fo-team-select / #fo-filter-* are
      // separate IDs, but defensive guard against future regressions
      // where a select inside Tag accidentally collides).
      if (e.target.id === "fo-tag-side" || e.target.id === "fo-tag-franchise") {
        e.stopPropagation();
      }
      if (e.target.id === "fo-tag-side")      { STATE.tagFilter.side = e.target.value; renderTagTab(); }
      if (e.target.id === "fo-tag-franchise") { STATE.tagFilter.franchise = e.target.value; renderTagTab(); }
    });
    // Search input — debounced so re-render doesn't fire on every keystroke.
    let _tagSearchT = null;
    section.addEventListener("input", function (e) {
      if (e.target.id !== "fo-tag-search") return;
      clearTimeout(_tagSearchT);
      const val = e.target.value;
      _tagSearchT = setTimeout(function () {
        STATE.tagFilter.search = val;
        renderTagTab();
        // Refocus + restore cursor position after re-render.
        const next = document.getElementById("fo-tag-search");
        if (next) {
          next.focus();
          const v = next.value;
          next.setSelectionRange(v.length, v.length);
        }
      }, 120);
    });
  }

  // ══════════════════════════════════════════════════════════════════
  // ACTIVITY & AUDIT TAB
  // ══════════════════════════════════════════════════════════════════
  //
  // Promotes the contract-activity feed (previously toolbar-buried in
  // live FO) into its own tab. Two cards:
  //   1. Upcoming Deadlines — from deadline_reminders_<yr>.json
  //   2. Activity Timeline — from contract_activity_<yr>.json, sortable
  //      + filterable by type / franchise / search.
  //
  // Both files are commish-maintained snapshots emitted by the worker's
  // hourly contract-activity cron. Real-time data lives in D1 but isn't
  // surfaced as a read API yet; static JSONs are the read path.

  async function loadActivityData() {
    if (STATE.activityData || STATE.activityLoading) return;
    STATE.activityLoading = true;
    try {
      const [actPayload, deadlinePayload] = await Promise.all([
        fetchJSON(URL_CONTRACT_ACTIVITY(SEASON)).catch(function () { return null; }),
        fetchJSON(URL_DEADLINES(SEASON)).catch(function () { return null; })
      ]);
      const rawActs = (actPayload && (actPayload.activities || actPayload.rows)) || [];
      STATE.activityData = {
        meta: (actPayload && actPayload.meta) || {},
        rows: rawActs.map(function (r) { return r || {}; })
      };
      STATE.deadlines = (deadlinePayload && (deadlinePayload.reminders || deadlinePayload.rows)) || [];
    } catch (e) {
      console.warn("[fo] activity load failed:", e.message || e);
      STATE.activityData = { meta: {}, rows: [] };
      STATE.deadlines = [];
    } finally {
      STATE.activityLoading = false;
    }
  }

  // Contract-string + kind formatters — still used by the Misc → Contract Log
  // tab. (The Commish Settings / Contract Revert UI moved to its own hub page,
  // MESSAGE19&hub=commish-settings.)
  function ctKindLabel(k) {
    return { myac: "MYAC", extension: "Extension", restructure: "Restructure", mym: "MYM", tag: "Tag", untag: "Untag" }[k] || k;
  }
  function ctContractStr(c, isTag) {
    if (!c) return isTag ? "(untag)" : "—";
    const sal = c.salary != null ? "$" + Number(c.salary).toLocaleString() : "$?";
    const yr = c.contract_year != null ? c.contract_year + "yr" : "";
    return [c.contract_status || "", yr, sal].filter(Boolean).join(" · ");
  }
  // Resolve a player name from the loaded rosters by id. Older submission rows
  // (e.g. flat extensions before the payload carried player_name) stored only
  // the id; the revert list would then show a bare MFL number. Falls back to ""
  // if the player isn't on any current roster (dropped) — caller keeps the id.
  function playerNameById(id) {
    if (id == null || id === "") return "";
    const key = String(id);
    const teams = STATE.teams || [];
    for (let i = 0; i < teams.length; i += 1) {
      const players = teams[i].players || [];
      for (let j = 0; j < players.length; j += 1) {
        if (players[j] && String(players[j].id) === key) return players[j].name || "";
      }
    }
    return "";
  }
  // ── CONTRACT LOG (read-only, D1-sourced) ──────────────────────────────
  // Franchise · Date · Type · Details, straight from D1 ups_* via
  // /admin/contract-submissions (the single source of truth). Filters: Team,
  // Type, Year. Year is pinned to the current season until the historical
  // backfill (forum 2012-2025) is validated (Keith 2026-06-05).
  // Plain-English glossary for owners — the contract jargon they'll see around
  // Front Office, defined simply (Keith 2026-06-06). Definitions sourced from
  // docs/league_context_v1.md: ERA = Expired Rookie Auction (§A3), FAA = Free
  // Agent Auction (§A2), MYAC/MYM/restructure/tag mechanics (§C).
  function renderGlossaryHtml() {
    const groups = [
      { title: "Contract options — things you can do", items: [
        ["MYAC", "<strong>Multi-Year Auction Contract</strong>. Right after you win a player at auction, choose the length (1, 2, or 3 years) and how the salary is spread. Skip it and the deal defaults to 1 year."],
        ["Extension", "<strong>Extend</strong> a player who’s already under contract by adding years — done before that player’s <strong>extension deadline</strong>, which varies by player and how they were acquired (e.g. rookies by late May, veterans by the September contract deadline)."],
        ["Restructure", "Reshape the salary across a deal’s <strong>remaining</strong> years (e.g. push money to later years). Offseason only, max 3 per team a season, and it does <strong>not</strong> add years."],
        ["MYM", "<strong>Mid-Year Multi</strong>. Turn an in-season waiver/FCFS pickup into a multi-year contract, within 14 days of grabbing them. Max 4 per team a season."],
        ["Tag", "A one-year contract to keep a player whose deal has <strong>expired</strong>, instead of letting them hit the auction. Each team gets <strong>1 offensive + 1 defensive</strong> tag per year. The price is set by a <strong>tier</strong> — the better the player, the higher the tier, the more it costs."],
      ]},
      { title: "Contract types — the “Type” column", items: [
        ["Rookie-Draft", "A player taken in the <strong>Rookie Draft</strong>. 3-year deal; salary is set by the draft slot and spread <strong>equally across all 3 years</strong>. 1st-rounders (2025 draft onward) get a <strong>4th-year option</strong>."],
        ["Vet-ERA", "A veteran you won in the <strong>Expired Rookie Auction</strong> (late May — the auction of players whose rookie deals expired). Starts as 1 year; use a <strong>Multi-Year Auction Contract (MYAC)</strong> to make it 2 or 3."],
        ["Vet-FAA", "A veteran you won in the <strong>Free Agent Auction</strong> (late July / early August). Same idea as Vet-ERA, just a different auction."],
        ["Vet-Ext", "A veteran you <strong>extended</strong> — you added years before the player’s extension deadline (which varies by player and how they were acquired)."],
        ["Vet-WW", "<strong>Waiver Wire</strong> — a player you grabbed in-season with a blind bid. 1-year contract; salary = your winning bid, minimum $1,000. Also covers <strong>FCFS</strong> (First-Come, First-Serve) free agents picked up in the Sunday-morning post-waivers window — those carry a flat $1,000, 1-year deal."],
        ["Rookie-MYM", "An in-season pickup who <strong>is</strong> an NFL rookie that you locked up with a <strong>MYM</strong> (keeps them on the rookie path)."],
        ["Vet-MYM", "An in-season pickup who is <strong>not</strong> an NFL rookie that you locked up with a <strong>MYM</strong>."],
        ["Tag", "A player you kept one more year with a <strong>Tag</strong> contract instead of letting them hit the auction."],
      ]},
      { title: "Money & cap terms", items: [
        ["Cap", "Your salary cap. Ceiling is <strong>$300K</strong>; you must spend at least the <strong>$260K</strong> floor."],
        ["TCV", "<strong>Total Contract Value</strong> — the whole dollar value of the deal across all its years. Locked in when the contract is signed."],
        ["AAV", "<strong>Average Annual Value</strong>. At acquisition it’s TCV ÷ number of years — the average yearly cost — and it sets a player’s <strong>tag tier</strong> and <strong>extension rate</strong>. Heads-up: once a player is extended the salary can <strong>escalate</strong> year to year (e.g. $20K this year, $30K next), so the actual yearly number isn’t always a flat AAV."],
        ["CL", "<strong>Contract Length</strong> — how many years the deal runs. The longest deal you can sign is <strong>3 years</strong> (1st-round rookies can add a 4th-year option). A team may carry at most <strong>6 three-year contracts</strong> — rookie 3-year deals don’t count toward that limit."],
        ["GTD", "<strong>Guaranteed money</strong> — the guaranteed amount locked in <strong>when the contract was signed</strong>."],
        ["Earned", "What a player has <strong>already been paid</strong> — completed past years plus what they’ve earned so far in the current year."],
        ["Cap hit", "What a player counts against your $300K cap <strong>this</strong> year."],
        ["Drop penalty (dead cap)", "What you still owe against the cap <strong>after</strong> you cut a player."],
        ["FL — Front-Loaded", "A deal that pays <strong>more than the AAV in Year 1</strong> (and less in the later years)."],
        ["BL — Back-Loaded", "A deal that pays <strong>less than the AAV in Year 1</strong> (and more in the later years). Each team may carry at most <strong>5 loaded</strong> — FL or BL — contracts."],
      ]},
      { title: "Roster status", items: [
        ["Active", "A player on your <strong>active roster</strong> — full salary counts against your cap."],
        ["Taxi", "Taxi (practice) squad — developmental players held off your active roster (cap-free to cut while on taxi)."],
        ["IR", "Injured Reserve — a spot for injured players so they don’t clog your active roster."],
      ]},
    ];
    const groupHtml = groups.map(function (g) {
      const rows = g.items.map(function (it) {
        return '<div class="fo-gloss-row" style="display:grid;grid-template-columns:minmax(120px,180px) 1fr;gap:14px;padding:9px 0;border-top:1px solid var(--border);">' +
          '<div style="font-weight:700;color:var(--text);">' + it[0] + '</div>' +
          '<div style="color:var(--muted);line-height:1.5;">' + it[1] + '</div>' +
        '</div>';
      }).join("");
      return '<div class="fo-card" style="margin-bottom:14px;">' +
        '<h3 style="margin:0 0 2px;color:var(--text);font-size:15px;">' + escapeHtml(g.title) + '</h3>' +
        rows + '</div>';
    }).join("");
    return '<div class="fo-card-head"><h2>Glossary</h2><span class="small" style="color:var(--muted);">Plain-English definitions for the jargon you’ll see around Front Office.</span></div>' +
      '<p class="fo-row-hint">💡 New here, or just need a refresher? Here’s what the contract terms actually mean — no rulebook required.</p>' +
      groupHtml;
  }

  async function renderContractLogTab() {
    const body = $("#fo-contractlog-body");
    if (!body) return;
    // Misc tab has two sub-views: the Contract Log (default) and a plain-English
    // Glossary for owners (Keith 2026-06-06: "some guys are not the brightest").
    if (STATE.miscSubview === "glossary") { body.innerHTML = renderGlossaryHtml(); return; }
    STATE.contractLogFilter = STATE.contractLogFilter || { team: "", type: "", year: String(safeInt(SEASON, 2026)), showTest: false };
    const f = STATE.contractLogFilter;
    const year = f.year || String(safeInt(SEASON, 2026));
    STATE.contractLogData = STATE.contractLogData || {};
    STATE.contractLogTest = STATE.contractLogTest || {};
    if (!STATE.contractLogData[year]) {
      body.innerHTML = '<div class="fo-table-loading">Loading contract log…</div>';
      try {
        const data = await fetchJSON(apiUrl("/admin/contract-submissions") + "?L=" + encodeURIComponent(LEAGUE_ID) + "&YEAR=" + encodeURIComponent(year));
        STATE.contractLogData[year] = (data && data.submissions) || [];
      } catch (e) {
        body.innerHTML = '<div class="fo-table-loading">Failed to load contract log: ' + escapeHtml(e.message || String(e)) + "</div>";
        return;
      }
      // Test-event config — franchises (with optional `before` cutoff) whose
      // events are test data, hidden by default (Keith 2026-06-05).
      try {
        const tcfg = await fetchJSON("../contract_submissions/contract_log_test_" + encodeURIComponent(year) + ".json");
        STATE.contractLogTest[year] = (tcfg && tcfg.test_franchises) || [];
      } catch (e) { STATE.contractLogTest[year] = []; }
    }
    const nameByFid = {};
    (STATE.teams || []).forEach(function (t) { nameByFid[pad4(t.fid)] = t.name; });
    const testFr = STATE.contractLogTest[year] || [];
    const isTestEvent = function (fid, dateStr) {
      return testFr.some(function (t) {
        if (pad4(t.franchise_id) !== fid) return false;
        return t.before ? String(dateStr || "") < String(t.before) : true;   // `before` = "thus far" cutoff
      });
    };
    let rows = (STATE.contractLogData[year] || []).map(function (s) {
      const fid = pad4(s.franchise_id);
      const isTag = s.kind === "tag" || s.kind === "untag";
      const player = safeStr(s.player_name) || playerNameById(s.player_id) || safeStr(s.player_id);
      // Details = the MFL contractInfo string that was/would be submitted
      // ("CL 2| TCV 24K| AAV 12K| Y1-…| GTD: …"); fall back to the structured form.
      const cinfo = safeStr(s.new && s.new.contract_info);
      const fallback = ctContractStr(s.new, isTag) + (s.new && s.new.tag_side ? " (" + s.new.tag_side + ")" : "");
      const lock = safeStr(s.locked_in_at);
      const detail = (player ? player + " — " : "") + (cinfo || fallback) + (lock ? " · Locked " + lock : "");
      return {
        fid: fid, franchise: nameByFid[fid] || safeStr(s.franchise_id),
        date: String(s.submitted_at_utc || ""), date_str: String(s.submitted_at_utc || "").replace("T", " ").slice(0, 16) || "—",
        type: ctKindLabel(s.kind), details: detail, test: isTestEvent(fid, s.submitted_at_utc),
      };
    });
    const teamOpts = Array.from(new Set(rows.map(function (r) { return r.franchise; }).filter(Boolean))).sort();
    const typeOpts = Array.from(new Set(rows.map(function (r) { return r.type; }).filter(Boolean))).sort();
    const testCount = rows.filter(function (r) { return r.test; }).length;
    const visible = rows.filter(function (r) { return f.showTest || !r.test; });   // test hidden unless toggled
    const total = visible.length;
    rows = visible.filter(function (r) {
      return (!f.team || r.franchise === f.team) && (!f.type || r.type === f.type);
    });
    STATE.contractLogSort = STATE.contractLogSort || { key: "date", dir: -1 };
    const sk = STATE.contractLogSort.key, sd = STATE.contractLogSort.dir;
    rows.sort(function (a, b) {
      const av = a[sk] || "", bv = b[sk] || "";
      return sd * String(av).localeCompare(String(bv));
    });
    const sel = "background:var(--panel-alt);color:var(--text);border:1px solid var(--border);padding:4px 8px;border-radius:4px;";
    const opt = function (v, l, s) { return '<option value="' + escapeHtml(v) + '"' + (s ? " selected" : "") + ">" + escapeHtml(l) + "</option>"; };
    const teamSel = '<select id="fo-clog-team" style="' + sel + '">' + opt("", "All teams", !f.team) + teamOpts.map(function (t) { return opt(t, t, f.team === t); }).join("") + "</select>";
    const typeSel = '<select id="fo-clog-type" style="' + sel + '">' + opt("", "All types", !f.type) + typeOpts.map(function (t) { return opt(t, t, f.type === t); }).join("") + "</select>";
    const yearSel = '<select id="fo-clog-year" style="' + sel + '">' + opt(year, year, true) + "</select>";
    const clr = (f.team || f.type) ? ' <button type="button" id="fo-clog-clear" class="btn small secondary">Clear</button>' : "";
    const testChk = '<label style="display:flex;align-items:center;gap:5px;cursor:pointer;color:var(--text);font-size:13px;"><input type="checkbox" id="fo-clog-test"' + (f.showTest ? " checked" : "") + "> Show test" + (testCount ? " (" + testCount + ")" : "") + "</label>";
    const hdr = function (key, label) {
      const arrow = STATE.contractLogSort.key === key ? (STATE.contractLogSort.dir > 0 ? " ▲" : " ▼") : "";
      return '<th data-clogsort="' + key + '" style="cursor:pointer;white-space:nowrap;">' + escapeHtml(label) + arrow + "</th>";
    };
    const trs = rows.map(function (r) {
      const badge = r.test ? ' <span style="background:var(--err);color:#fff;font-size:9px;font-weight:600;padding:1px 5px;border-radius:3px;vertical-align:middle;">TEST</span>' : "";
      return "<tr" + (r.test ? ' style="opacity:0.55;"' : "") + "><td>" + escapeHtml(r.franchise) + badge + '</td><td class="small" style="white-space:nowrap;">' + escapeHtml(r.date_str) + "</td>" +
        "<td>" + escapeHtml(r.type) + '</td><td class="small">' + escapeHtml(r.details) + "</td></tr>";
    }).join("");
    body.innerHTML =
      '<div class="fo-card-head"><h2>Contract Log</h2><span class="small" style="color:var(--muted);">Every contract event from D1 — Franchise · Date · Type · Details.</span></div>' +
      '<p class="fo-row-hint">💡 Straight from D1 (the single source of truth): extensions, auction contracts (MYAC), restructures, tags &amp; untags. Filter by Team / Type / Year. Pinned to the current season until the historical (forum 2012–2025) backfill is validated.</p>' +
      '<div style="display:flex;gap:8px;align-items:center;margin:8px 0;flex-wrap:wrap;"><span class="small" style="color:var(--muted);">Filter</span>' +
        teamSel + typeSel + yearSel + clr + testChk +
        '<span class="small" style="color:var(--muted);margin-left:auto;">' + rows.length + (rows.length === total ? "" : " of " + total) + " entries · " + escapeHtml(year) +
        " only (historical years unlock after validation)</span></div>" +
      '<div class="fo-table-scroll"><table class="fo-table"><thead><tr>' +
        hdr("franchise", "Franchise") + hdr("date", "Date") + hdr("type", "Type") + "<th>Details</th>" +
        "</tr></thead><tbody>" + (trs || '<tr><td colspan="4" class="fo-table-empty">No contract activity matches.</td></tr>') + "</tbody></table></div>";
    const te = $("#fo-clog-team"); if (te) te.addEventListener("change", function () { f.team = this.value; renderContractLogTab(); });
    const ty = $("#fo-clog-type"); if (ty) ty.addEventListener("change", function () { f.type = this.value; renderContractLogTab(); });
    const cl = $("#fo-clog-clear"); if (cl) cl.addEventListener("click", function () { f.team = ""; f.type = ""; renderContractLogTab(); });
    const tt = $("#fo-clog-test"); if (tt) tt.addEventListener("change", function () { f.showTest = !!this.checked; renderContractLogTab(); });
    $$("[data-clogsort]", body).forEach(function (th) {
      th.addEventListener("click", function () {
        const k = this.getAttribute("data-clogsort");
        if (STATE.contractLogSort.key === k) STATE.contractLogSort.dir *= -1;
        else { STATE.contractLogSort.key = k; STATE.contractLogSort.dir = 1; }
        renderContractLogTab();
      });
    });
  }

  function renderActivityTab() {
    const body = $("#fo-activity-body");
    if (!body) return;
    if (STATE.activityLoading) {
      body.innerHTML = '<div class="fo-placeholder">Loading activity feed…</div>';
      return;
    }
    if (!STATE.activityData) {
      body.innerHTML = '<div class="fo-placeholder">Loading activity feed…</div>';
      loadActivityData().then(renderActivityTab);
      return;
    }
    body.innerHTML = renderDeadlinesCard() + renderActivityCard();
  }

  function renderDeadlinesCard() {
    const list = STATE.deadlines || [];
    if (!list.length) return "";
    // Sort by deadline date ascending — closest first.
    const sorted = list.slice().sort(function (a, b) {
      return safeStr(a.deadline_date_et).localeCompare(safeStr(b.deadline_date_et));
    });
    const today = new Date().toISOString().slice(0, 10);
    const rows = sorted.map(function (r) {
      const d = safeStr(r.deadline_date_et);
      const t = safeStr(r.deadline_time_et);
      const daysOut = d
        ? Math.round((new Date(d + "T00:00:00Z").getTime() - new Date(today + "T00:00:00Z").getTime()) / (1000 * 60 * 60 * 24))
        : null;
      const urgency = daysOut == null ? "" :
                      daysOut < 0 ? "past" :
                      daysOut === 0 ? "today" :
                      daysOut <= 3 ? "soon" :
                      daysOut <= 14 ? "near" : "later";
      const daysLabel = daysOut == null ? "" :
                        daysOut < 0 ? "(passed)" :
                        daysOut === 0 ? "TODAY" :
                        daysOut === 1 ? "tomorrow" :
                        daysOut + " days";
      return `
        <li class="fo-deadline-row fo-deadline-${urgency}">
          <div class="fo-deadline-date">
            <span class="fo-deadline-day">${escapeHtml(d)}${t ? " " + escapeHtml(t) + " ET" : ""}</span>
            <span class="fo-deadline-days">${escapeHtml(daysLabel)}</span>
          </div>
          <div class="fo-deadline-event">
            <div class="fo-deadline-title">${escapeHtml(r.event_title || r.event_key || "Deadline")}</div>
            <div class="fo-deadline-meta small">${escapeHtml(r.reminder_label || "")} · ${escapeHtml(r.delivery_target || "")}</div>
          </div>
        </li>`;
    }).join("");
    return `
      <div class="fo-card">
        <h2 style="margin:0 0 8px;">Upcoming Deadlines</h2>
        <ul class="fo-deadline-list">${rows}</ul>
      </div>`;
  }

  function renderActivityCard() {
    const f = STATE.activityFilter;
    const sort = STATE.activitySort;
    const search = safeStr(f.search).toLowerCase();
    const rows = (STATE.activityData.rows || []).filter(function (r) {
      if (f.type && safeStr(r.activity_type) !== f.type) return false;
      if (f.franchise && pad4(r.franchise_id) !== f.franchise) return false;
      if (search) {
        const hay = (safeStr(r.player_name) + " " + safeStr(r.franchise_name) + " " +
                    safeStr(r.activity_type) + " " + safeStr(r.contract_status)).toLowerCase();
        if (hay.indexOf(search) < 0) return false;
      }
      return true;
    });
    rows.sort(function (a, b) {
      let va, vb;
      switch (sort.key) {
        case "type":      va = a.activity_type; vb = b.activity_type; break;
        case "franchise": va = a.franchise_name || a.franchise_id; vb = b.franchise_name || b.franchise_id; break;
        case "player":    va = a.player_name; vb = b.player_name; break;
        case "salary":    va = safeInt(a.salary, 0); vb = safeInt(b.salary, 0); break;
        case "tcv":       va = safeInt(a.tcv, 0); vb = safeInt(b.tcv, 0); break;
        case "submitted":
        default:          va = safeStr(a.submitted_at_utc); vb = safeStr(b.submitted_at_utc); break;
      }
      const numeric = ["salary", "tcv"];
      if (numeric.indexOf(sort.key) >= 0) return ((Number(va) || 0) - (Number(vb) || 0)) * sort.dir;
      return String(va || "").localeCompare(String(vb || "")) * sort.dir;
    });
    const arrow = (k) => sort.key === k ? (sort.dir > 0 ? " ▲" : " ▼") : "";

    // Unique types + franchises for filters.
    const typeSet = new Set();
    const fidSet = new Set();
    (STATE.activityData.rows || []).forEach(function (r) {
      if (r.activity_type) typeSet.add(safeStr(r.activity_type));
      if (r.franchise_id) fidSet.add(pad4(r.franchise_id));
    });
    const typeOpts = ['<option value="">All types</option>']
      .concat(Array.from(typeSet).sort().map(function (t) {
        return `<option value="${escapeHtml(t)}" ${f.type === t ? "selected" : ""}>${escapeHtml(t)}</option>`;
      })).join("");
    const fidOpts = ['<option value="">All franchises</option>']
      .concat(STATE.teams
        .filter(function (t) { return fidSet.has(t.fid); })
        .map(function (t) {
          return `<option value="${escapeHtml(t.fid)}" ${f.franchise === t.fid ? "selected" : ""}>${escapeHtml(t.name)}</option>`;
        })).join("");

    const tbody = rows.map(function (r) {
      const ts = formatActivityTs(r.submitted_at_utc);
      const typeCls = activityTypeClass(r.activity_type);
      const commish = safeInt(r.commish_override_flag, 0) ? ' <span class="fo-commish-badge" title="Commish override">👑</span>' : "";
      const test = safeInt(r.test_flag, 0) ? ' <span class="fo-test-badge" title="Dry-run / test submission">DRY</span>' : "";
      return `
        <tr>
          <td class="num small" style="color:var(--muted); white-space:nowrap;">${escapeHtml(ts)}</td>
          <td><span class="fo-activity-type ${typeCls}">${escapeHtml(r.activity_type || "—")}</span>${commish}${test}</td>
          <td>${escapeHtml(r.franchise_name || r.franchise_id || "—")}</td>
          <td>${escapeHtml(r.player_name || r.player_id || "—")}${r.position ? ` <span class="small" style="color:var(--muted);">${escapeHtml(r.position)}</span>` : ""}</td>
          <td><span class="fo-ctype ${ctypeClass(r.contract_status)}">${escapeHtml(safeStr(r.contract_status).toUpperCase() || "—")}</span></td>
          <td class="num">${safeInt(r.salary, 0) > 0 ? fmtUSD(r.salary) : "—"}</td>
          <td class="num">${safeInt(r.tcv, 0) > 0 ? fmtUSD(r.tcv) : "—"}</td>
          <td class="small" style="color:var(--muted);">${escapeHtml(r.contract_info || "")}</td>
        </tr>`;
    }).join("");

    return `
      <div class="fo-card">
        <div class="fo-toolbar-row">
          <label class="fo-field" style="flex:1; min-width:200px;">
            <span>Search</span>
            <input type="search" id="fo-activity-search" placeholder="Player, franchise, type…" value="${escapeHtml(f.search)}">
          </label>
          <label class="fo-field">
            <span>Activity Type</span>
            <select id="fo-activity-type">${typeOpts}</select>
          </label>
          <label class="fo-field">
            <span>Franchise</span>
            <select id="fo-activity-franchise">${fidOpts}</select>
          </label>
          <button type="button" class="btn secondary" id="fo-activity-reset">Reset</button>
        </div>
      </div>
      <div class="fo-card">
        <div class="fo-card-head" style="margin-bottom:8px;">
          <h2 style="margin:0;">Activity Timeline</h2>
          <span class="small" style="color:var(--muted);">${rows.length} of ${(STATE.activityData.rows || []).length} entries</span>
        </div>
        <table class="fo-table">
          <thead>
            <tr>
              <th data-activity-sort="submitted">When${arrow("submitted")}</th>
              <th data-activity-sort="type">Type${arrow("type")}</th>
              <th data-activity-sort="franchise">Franchise${arrow("franchise")}</th>
              <th data-activity-sort="player">Player${arrow("player")}</th>
              <th>Contract Status</th>
              <th class="num" data-activity-sort="salary">Salary${arrow("salary")}</th>
              <th class="num" data-activity-sort="tcv">TCV${arrow("tcv")}</th>
              <th>Contract Info</th>
            </tr>
          </thead>
          <tbody>${tbody || '<tr><td colspan="8" class="fo-table-empty">No matching activity.</td></tr>'}</tbody>
        </table>
      </div>`;
  }

  function formatActivityTs(iso) {
    if (!iso) return "—";
    try {
      const d = new Date(iso);
      return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
    } catch (e) { return safeStr(iso); }
  }
  function activityTypeClass(t) {
    const u = safeStr(t).toLowerCase();
    if (u.indexOf("extension") >= 0)   return "ext";
    if (u.indexOf("tag") >= 0)         return "tag";
    if (u.indexOf("restructure") >= 0) return "rstr";
    if (u.indexOf("drop") >= 0)        return "drop";
    if (u.indexOf("trade") >= 0)       return "trade";
    if (u.indexOf("rookie") >= 0)      return "rookie";
    if (u.indexOf("fa") >= 0)          return "fa";
    return "other";
  }

  function setupActivityTabDelegation() {
    const section = document.querySelector('.fo-section[data-section="activity"]');
    if (!section) return;
    section.addEventListener("click", function (e) {
      if (e.target.closest("#fo-activity-reset")) {
        STATE.activityFilter = { type: "", franchise: "", search: "" };
        renderActivityTab(); return;
      }
      const th = e.target.closest("th[data-activity-sort]");
      if (th) {
        const key = th.dataset.activitySort;
        if (STATE.activitySort.key === key) STATE.activitySort.dir *= -1;
        else {
          STATE.activitySort.key = key;
          STATE.activitySort.dir = (key === "salary" || key === "tcv" || key === "submitted") ? -1 : 1;
        }
        renderActivityTab(); return;
      }
    });
    section.addEventListener("change", function (e) {
      if (e.target.id === "fo-activity-type")      { STATE.activityFilter.type = e.target.value; renderActivityTab(); }
      if (e.target.id === "fo-activity-franchise") { STATE.activityFilter.franchise = e.target.value; renderActivityTab(); }
    });
    let _t = null;
    section.addEventListener("input", function (e) {
      if (e.target.id !== "fo-activity-search") return;
      clearTimeout(_t);
      const v = e.target.value;
      _t = setTimeout(function () {
        STATE.activityFilter.search = v;
        renderActivityTab();
        const next = document.getElementById("fo-activity-search");
        if (next) {
          next.focus();
          const vv = next.value;
          next.setSelectionRange(vv.length, vv.length);
        }
      }, 120);
    });
  }

  // ── Toast / flash ──────────────────────────────────────────────────
  function flashToast(msg, kind) {
    const t = document.createElement("div");
    t.className = "fo-toast " + (kind || "");
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(function () { t.style.opacity = "0"; }, 3500);
    setTimeout(function () { t.parentNode && t.parentNode.removeChild(t); }, 4200);
  }

  // ── Embed shell (HPM) ───────────────────────────────────────────────
  // Standalone front_office.html already ships the structure, so this no-ops
  // there. Inside MFL's My Team page the loader gives us only a mount, so we
  // fetch that SAME html (single source of truth — no duplicated template to
  // drift) and inject everything except <head>/<script> into the mount.
  async function buildShell(mount) {
    if ($("#fo-tabs")) return true;            // standalone, or already built
    const host = mount || document.getElementById("ups-front-office") || document.body;
    if (!host) return false;
    let html = "";
    try {
      const r = await fetch(assetUrl("front_office.html") + "?_=" + Date.now(), { cache: "no-store" });
      if (r.ok) html = await r.text();
    } catch (e) {}
    if (!html) return false;
    let nodes;
    try {
      const doc = new DOMParser().parseFromString(html, "text/html");
      nodes = doc && doc.body ? Array.prototype.slice.call(doc.body.childNodes) : [];
    } catch (e) { return false; }
    if (!nodes.length) return false;
    host.classList.add("fo-root");
    nodes.forEach(function (node) {
      // Skip <script> (don't re-load front_office.js); import everything else —
      // header, nav, main sections, the slide-over <aside>, and comments.
      if (node.nodeType === 1 && String(node.tagName || "").toLowerCase() === "script") return;
      host.appendChild(document.importNode(node, true));
    });
    return !!$("#fo-tabs");
  }

  // ── Go ──────────────────────────────────────────────────────────────
  // Two triggers race to bootEmbed() in the embed: front_office.js's own boot
  // (mount detected, below) AND the loader's script-onload → UPS_FO_INIT().
  // buildShell() is async, so guarding only on `_foBooted` (set AFTER the await)
  // let BOTH calls build a shell → a duplicate Front Office. `_foBooting` is set
  // SYNCHRONOUSLY on entry, so the second caller bails before the first's fetch
  // resolves.
  let _foBooted = false;
  let _foBooting = false;
  async function bootEmbed() {
    if (_foBooted || _foBooting) return;
    _foBooting = true;
    const mount = document.getElementById("ups-front-office") || document.body;
    let ok = false;
    try { ok = await buildShell(mount); } catch (e) { ok = false; }
    if (!ok) { _foBooting = false; return; }   // allow a later retry to rebuild
    _foBooted = true;
    init();
  }
  // The loader calls this after injecting us (and re-fires it on its build-cache
  // path). Idempotent — first call builds + inits, concurrent/later calls no-op.
  window.UPS_FO_INIT = function () { if (!_foBooted && !_foBooting) bootEmbed(); };

  if ($("#fo-tabs")) {
    // Standalone page — structure is already in the DOM.
    _foBooted = true;
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
    else init();
  } else if (document.getElementById("ups-front-office") || window.UPS_FO_EMBED) {
    // HPM embed — loader injected a mount; build the shell, then init.
    bootEmbed();
  } else if (document.readyState === "loading") {
    // Defensive: structure may still be parsing (e.g. script relocated to <head>).
    document.addEventListener("DOMContentLoaded", function () {
      if ($("#fo-tabs")) { _foBooted = true; init(); }
      else if (document.getElementById("ups-front-office") || window.UPS_FO_EMBED) bootEmbed();
    });
  }
})();
