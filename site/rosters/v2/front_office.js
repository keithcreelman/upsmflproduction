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
    return null;
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
    return fetch(url, Object.assign({ cache: "no-store" }, opts || {})).then(function (r) {
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
    capAmount: 0,
    teams: [],          // worker payload normalized
    activeTab: "roster",
    selectedTeamId: "__all__",
    search: "",
    filters: { pos: "ALL", type: "", status: "", years: "", action: "" },
    sort: { key: "salary", dir: -1 },
    capSubview: "summary",
    capFocusedTeamFid: null,
    // Per-player preview state in Cap Plan Detail. Key = "pid:fid",
    // value = "ext1" | "ext2" | "drop". Toggling re-runs the projection.
    capPreviews: Object.create(null),
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
    // Slide-over state
    slideoverPid: null,
    slideoverFid: null,
    slideoverSubtab: "bio",
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
    if (y <= 0) return 0;
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
      "GTD: " + formatContractK(Math.round(current * years * 0.75))
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
    if (years === 2 && loading === "FL") {
      const fl1 = Math.max(1000, roundToK(Math.round(extensionTotal * 0.8)));
      extYearSalaries = [fl1, extensionTotal - fl1];
    } else if (years === 2 && loading === "BL") {
      const bl1 = Math.max(1000, roundToK(Math.round(extensionTotal * 0.2)));
      extYearSalaries = [bl1, extensionTotal - bl1];
    } else {
      for (let i = 0; i < years; i += 1) extYearSalaries.push(futureSalary);
    }

    const yearParts = [];
    for (let idx = 1; idx <= totalLength; idx += 1) {
      const yearSalary = idx <= currentYears ? currentSalary : extYearSalaries[idx - currentYears - 1];
      yearParts.push("Y" + idx + "-" + formatContractK(yearSalary));
    }
    const tcv = currentSalary * currentYears + extensionTotal;
    const gtd = tcv > 4000 ? Math.round(tcv * 0.75) : Math.max(0, tcv - currentSalary);
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

    const salaryToSend = extYearSalaries[0] || futureSalary;
    return {
      yearsToAdd: years,
      years: years,                 // alias for legacy preview readers
      loadedIndicator: loading,
      contractLength: totalLength,
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
      const firstExtYearIdx = curYears + 1;
      const salaryToSend = yv[firstExtYearIdx] || safeInt(r.new_aav_future, 0);
      return {
        yearsToAdd: yrs,
        years: yrs,
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
    var myacEligible = (isEra || isFreshAuction) && years === 1 && !isPastContractDeadlineFO();
    return {
      myacEligible: myacEligible,
      extensionEligible: !rookieOptionActionEligible(p) && (years === 1 || expiredRookie) &&
                          status.indexOf("tag") === -1 && !noFurther && !myacEligible,
      rookieOptionEligible: rookieOptionActionEligible(p),
      restructureEligible: years >= 2 && years <= 3 && salary > 1000 && !rookieLikeContractStatus(status),
      untagEligible: status === "tag" && !isPastTagDeadlineFO()
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
    // Contract Revert tab — commish-only (admin state from /api/me), or ?contracts=1
    // opt-in for testing. Writes are constrained to restoring audited prior states.
    if ($("#fo-tab-contracts") && ((STATE.me && STATE.me.isAdmin) || QS.get("contracts") === "1")) {
      $("#fo-tab-contracts").hidden = false;
    }
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
      const [acqRows, _historyLoaded, mflAdj] = await Promise.all([
        loadAcquisitionLookup(SEASON),
        loadRookieDraftHistory(),
        loadMflSalaryAdjustments(SEASON)
      ]);
      mergeAcquisitionLookupRows(STATE.teams, acqRows);
      mergeMflSalaryAdjustments(STATE.teams, mflAdj);
      STATE.adjByFid = mflAdj.byFid || {}; // per-team line items for the Cap Alloc popup

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
        tbody.innerHTML = '<tr><td colspan="14" class="fo-table-error">Failed to load roster: ' +
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
    const who = me.configured && me.franchise_id
      ? "You: " + (me.franchise_name || ("franchise " + me.franchise_id))
      : "Viewer (no franchise context)";
    const adminBit = me.isAdmin ? " · 👑 admin" : "";
    const teamCount = STATE.teams.length;
    meta.textContent = who + adminBit + " · " + teamCount + " teams · season " + SEASON + " · L " + LEAGUE_ID;
  }

  // ── Tabs ────────────────────────────────────────────────────────────
  function setupTabs() {
    $$("#fo-tabs button").forEach(function (btn) {
      btn.addEventListener("click", function () {
        if (btn.disabled) return;
        const tab = btn.dataset.tab;
        if (!tab || tab === STATE.activeTab) return;
        STATE.activeTab = tab;
        $$("#fo-tabs button").forEach(function (b) { b.classList.toggle("active", b === btn); });
        $$(".fo-section").forEach(function (s) { s.classList.toggle("active", s.dataset.section === tab); });
        if (tab === "cap") renderCapTab();
        if (tab === "tag") renderTagTab();
        if (tab === "activity") renderActivityTab();
        if (tab === "contracts") renderContractsTab();
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
      renderRosterTable();
    });
    $("#fo-search").addEventListener("input", function (e) {
      STATE.search = String(e.target.value || "").toLowerCase();
      renderRosterTable();
    });
    $("#fo-reset-filters").addEventListener("click", function () {
      STATE.search = ""; $("#fo-search").value = "";
      STATE.filters = { pos: "ALL", type: "", status: "", years: "", action: "" };
      $$("#fo-filter-pos .fo-pos-chip").forEach(function (c) {
        c.classList.toggle("active", c.dataset.pos === "ALL");
      });
      $("#fo-filter-type").value = "";
      $("#fo-filter-status").value = "";
      $("#fo-filter-years").value = "";
      $("#fo-filter-action").value = "";
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

    // Sort headers
    $$("#fo-roster-table thead th[data-sort]").forEach(function (th) {
      th.addEventListener("click", function () {
        const col = th.dataset.sort;
        if (STATE.sort.key === col) STATE.sort.dir *= -1;
        else {
          STATE.sort.key = col;
          STATE.sort.dir = ["salary", "cap_hit", "aav", "years"].includes(col) ? -1 : 1;
        }
        renderRosterTable();
      });
    });
  }

  function populateTeamSelect() {
    const sel = $("#fo-team-select");
    const opts = ['<option value="__all__">All teams (' + STATE.teams.length + ')</option>'];
    STATE.teams.forEach(function (t) {
      opts.push('<option value="' + escapeHtml(t.fid) + '">' + escapeHtml(t.name) + '</option>');
    });
    sel.innerHTML = opts.join("");
    // Default to viewer's own team if known.
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
    const allPlayers = [];
    STATE.teams.forEach(function (t) { (t.players || []).forEach(function (p) { allPlayers.push(p); }); });
    const counts = { extension: 0, rookie_option: 0, restructure: 0, untag: 0 };
    for (let i = 0; i < allPlayers.length; i += 1) {
      const e = rosterContractEligibility(allPlayers[i]);
      if (e.extensionEligible)    counts.extension    += 1;
      if (e.rookieOptionEligible) counts.rookie_option += 1;
      if (e.restructureEligible)  counts.restructure  += 1;
      if (e.untagEligible)        counts.untag        += 1;
    }
    const opts = ['<option value="">All</option>'];
    if (counts.extension    > 0) opts.push(`<option value="extension">Extension-eligible (${counts.extension})</option>`);
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
    const all = [];
    STATE.teams.forEach(function (t) { (t.players || []).forEach(function (p) { all.push(p); }); });
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
    // Contract Type (rookie / loaded / other) — same buckets the matcher uses
    const tset = { rookie: false, loaded: false, other: false };
    all.forEach(function (p) {
      const t = String(p.type || "").toUpperCase();
      if (t.startsWith("ROOKIE")) tset.rookie = true;
      else if (safeInt(p.years, 0) >= 2) tset.loaded = true;
      else tset.other = true;
    });
    const tSel = $("#fo-filter-type");
    if (tSel) {
      const to = ['<option value="">All</option>'];
      if (tset.rookie) to.push('<option value="rookie">Rookie</option>');
      if (tset.loaded) to.push('<option value="loaded">Loaded (multi-year)</option>');
      if (tset.other)  to.push('<option value="other">Other</option>');
      tSel.innerHTML = to.join("");
      if (STATE.filters.type && !tset[STATE.filters.type]) { STATE.filters.type = ""; }
      tSel.value = STATE.filters.type || "";
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
        // Match the family+sub class from ctypeClass ("vet vet-fl" / "rk rk-draft"
        // / "tag" / "expired"): families match the whole bucket, specific subs
        // match exactly, "loaded" matches any FL/BL.
        const cls = ctypeClass(p.type);
        const fam = cls.split(" ")[0];
        let ok;
        if (f.type === "rookie") ok = fam === "rk";
        else if (f.type === "veteran") ok = fam === "vet";
        else if (f.type === "tag") ok = cls === "tag";
        else if (f.type === "expired") ok = p.isExpiredRookie || cls === "expired";
        else if (f.type === "loaded") ok = cls.indexOf("-fl") >= 0 || cls.indexOf("-bl") >= 0;
        else ok = (" " + cls + " ").indexOf(" " + f.type + " ") >= 0;
        if (!ok) return false;
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
      // Count + allocation + avg ALL exclude taxi (taxi = $0 cap; shown separately).
      let posSal = 0, nNonTaxi = 0, taxiN = 0;
      groups[k].forEach(function (p) { if (p.isTaxi) { taxiN += 1; } else { posSal += currentCapHit(p); nNonTaxi += 1; } });
      const avg = nNonTaxi ? Math.round(posSal / nNonTaxi / 100) * 100 : 0;
      const rankable = single && order.indexOf(k) >= 0;
      const count = nNonTaxi + " player" + (nNonTaxi === 1 ? "" : "s") + (taxiN ? " · " + taxiN + " taxi" : "");
      const extra =
        ' <span class="fo-group-sal">' + escapeHtml(fmtUSD(posSal)) + "</span>" + rankPill(rankable ? positionAllocRank(k, STATE.selectedTeamId) : null) +
        ' <span class="fo-group-avg">' + escapeHtml(fmtUSD(avg) + "/player") + "</span>" + rankPill(rankable ? positionAvgRank(k, STATE.selectedTeamId) : null);
      html += '<tr class="fo-group-row"><td colspan="14"><span class="fo-pos ' + escapeHtml(k) + '">' + escapeHtml(k) +
              '</span> <span class="small">' + count + "</span>" + extra + "</td></tr>";
      html += groups[k].map(renderRosterRow).join("");
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
      var data = await fetchJSON(apiUrl("/api/league-events") + "?season=" + encodeURIComponent(SEASON) + "&from=all&limit=50");
      var evs = (data && data.events) || [];
      var cd = evs.find(function (e) { return String(e.event || "").toLowerCase().indexOf("contract_deadline") >= 0; });
      if (cd && cd.date) STATE.contractDeadline = String(cd.date).slice(0, 10);
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
      adjTotal += safeInt(s.adj_cut, 0) + safeInt(s.adj_trade, 0) + safeInt(s.adj_other, 0);
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
      grand += cut + trade + other;
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
    });
    if (!inner) inner = '<div class="fo-adj-row"><span>No cap adjustments.</span><span></span></div>';
    else inner += '<div class="fo-adj-row fo-adj-total"><span>Total</span><span class="num">' + escapeHtml(fmtUSD(grand)) + "</span></div>";
    const overlay = document.createElement("div");
    overlay.className = "fo-adj-overlay";
    overlay.innerHTML = '<div class="fo-adj-popup" role="dialog" aria-label="Cap adjustments">' +
      '<div class="fo-adj-head"><span>Cap Adjustments</span><button type="button" class="fo-adj-close" aria-label="Close">×</button></div>' +
      '<div class="fo-adj-body">' + inner + "</div>" +
      '<div class="fo-adj-foot">Drop / Trade / Other from MFL’s salaryAdjustments feed — the league’s authoritative cap-adjustment source.</div></div>';
    overlay.addEventListener("click", function (e) {
      if (e.target === overlay || (e.target.classList && e.target.classList.contains("fo-adj-close"))) {
        if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
      }
    });
    document.body.appendChild(overlay);
  }

  function renderRosterTable() {
    const tbody = $("#fo-roster-tbody");
    const summary = $("#fo-roster-summary");
    if (!tbody) return;

    const all = allVisiblePlayers();
    const filtered = applyFilters(all);
    const sorted   = applySort(filtered);

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
      tbody.innerHTML = '<tr><td colspan="14" class="fo-table-empty">No players match the current filters.</td></tr>';
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
    // Expired-rookie override — even when type is "Rookie" (so the
    // synthesized contract_info parses cleanly), chip the row EXPIRED
    // so the user sees the contract state at a glance.
    const ctype = p.isExpiredRookie ? "expired" : ctypeClass(p.type);
    const ctypeLabel = p.isExpiredRookie ? "EXPIRED" : String(p.type || "—").toUpperCase();
    const statusKls = rosterStatusClass(p);
    const statusLbl = rosterStatusLabel(p);

    const tcv = totalContractValueForPlayer(p);
    const cl  = contractLengthForPlayer(p);
    const yrs = safeInt(p.years, 0);
    const drop = dropPenaltyEstimate(p);
    const gtd = parseContractGuaranteeValue(p.special);
    const perWeekCell = perWeekEarningCell(p);

    // Salary / AAV combined cell — show "/AAV" only when AAV differs from
    // current-year salary. Keith 2026-05-19: keep these visually together.
    // AAV uses displayAavForPlayer (taxi fallback to salary).
    const aav = displayAavForPlayer(p);
    const salaryCell = (aav > 0 && aav !== p.salary)
      ? `${fmtUSD(p.salary)} <span class="small" style="color:var(--muted);">/ ${fmtUSD(aav)}</span>`
      : fmtUSD(p.salary);

    return `
      <tr data-pid="${escapeHtml(p.id)}" data-fid="${escapeHtml(p.fid)}">
        <td>
          <div>${escapeHtml(p.name)}${nflStatusBadge(p.id)}${newsFlagBadge(p.id)}</div>
          <div class="small">${escapeHtml(p.special || "")}</div>
        </td>
        <td><span class="fo-pos ${escapeHtml(pos)}">${escapeHtml(p.position)}</span></td>
        <td class="col-md">${escapeHtml(p.nflTeam || "—")}</td>
        <td class="col-md">${escapeHtml(p.franchise)}</td>
        <td><span class="fo-ctype ${ctype}">${escapeHtml(ctypeLabel)}</span></td>
        <td class="num col-md">${tcv > 0 ? fmtUSD(tcv) : "—"}</td>
        <td class="num col-lo">${cl > 0 ? cl : "—"}</td>
        <td class="num col-lo">${yrs > 0 ? yrs : "—"}</td>
        <td class="num">${salaryCell}</td>
        <td class="num col-md">${gtd > 0 ? fmtUSD(gtd) : "—"}</td>
        <td class="num col-md">${drop.earned > 0 ? fmtUSD(drop.earned) : "—"}</td>
        <td class="num col-lo">${perWeekCell}</td>
        <td class="num"><span class="fo-tt" data-tip="${escapeHtml(drop.note)}">${fmtUSD(drop.amount)}</span></td>
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
    STATE.slideoverSubtab = subtab || "bio";
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
    $("#fo-slideover-sub").innerHTML =
      `<span class="fo-pos ${escapeHtml(posBucket(p.position))}">${escapeHtml(p.position)}</span> · ` +
      `${escapeHtml(p.nflTeam || "—")} · ${escapeHtml(p.franchise)} · ` +
      `<span class="fo-ctype ${ctypeClass(p.type)}">${escapeHtml(String(p.type || "—").toUpperCase())}</span> · ` +
      `${fmtUSD(p.salary)} (${p.years || 0}yr rem)`;
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
  function bioHtml(p, d) {
    d = d || {};
    var espn = safeStr(p.espnId).replace(/\D/g, "");
    var avatar = espn
      ? '<div class="fo-bio-avatar" style="background-image:url(https://a.espncdn.com/i/headshots/nfl/players/full/' + espn + '.png)"></div>'
      : '<div class="fo-bio-avatar">' + escapeHtml(bioInitials(p.name)) + '</div>';
    var loading = d.__loading ? ' <span class="small" style="color:var(--muted);">· loading…</span>' : "";
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
      </table>
      <div class="fo-form-note" style="margin-top:8px;">
        Source: <code>/api/player-bundle?pid=${escapeHtml(p.id)}</code> → <code>bundle.contract_history</code>
        (D1 <code>src_contracts</code>). YL = year-of-contract (1..CL).
      </div>`;
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
           "Adjusted All-Play Wins = win_chunks × positional leverage β. All-Play wins this player is responsible for if every other lineup slot turned in median output.") +
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
      '<th class="num" title="Adjusted All-Play Wins = win_chunks × leverage β">APW</th>' +
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
      (wcOk ? "" : '<p class="fo-form-note" style="margin-top:6px;">APW shows "—" — upstream <code>win_chunks</code> not populated for these seasons.</p>');
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
      foStatSeasonTableHtml(career, lev) +
      '<div class="fo-form-note" style="margin-top:8px;">Source: <code>/api/player-bundle?pid=' + escapeHtml(p.id) +
      "</code> → <code>career_summary</code> (MFL scoring). Pts&nbsp;Rk / PPG&nbsp;Rk are positional. APW = win_chunks × leverage β.</div>";
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
      '<div class="fo-form-note" style="margin-top:8px;">Source: <code>bundle.weekly_by_season</code> (D1 <code>src_weekly</code> + baselines). ' +
      '<span class="fo-gl-ptag">P</span> = playoff week; tier from regular-season positional baselines.</div>';
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
      var res = await fetch("historical_acquisitions.json", { cache: "no-store" });
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
      "</tr></thead><tbody>" + rows + "</tbody></table></div>" +
      '<div class="fo-form-note" style="margin-top:8px;">Newest first. Live: <code>/api/player-transactions</code> (MFL txns ∪ D1 draft/contracts/extensions/tags)' +
      (histEvents.length ? "; deep-history (pre-2019) curated from forum/MFL validation (<code>historical_acquisitions.json</code>)" : "") + ". " +
      '<span class="fo-lowconf">~</span> low-confidence · <span class="fo-src">ⓘ</span> hover for source.' +
      (oldestYr ? " Back to " + escapeHtml(String(oldestYr)) + "." : "") + "</div>";
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
      feed +
      '<div class="fo-form-note" style="margin-top:8px;">Live: <code>/api/player-news</code> — injury/status + headlines (depth-chart excluded). Newest first.</div>';
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
        "Set this 1-yr deal to a 2- or 3-year contract (§C2) at the SAME salary (TCV = salary × years — no raise). <strong>Loaded</strong> free-keys Y1 in whole $1,000s (FL/BL; Y1 ≥ 20% TCV). Records as " + recAs + ". Max " + LOADED_MAX + " loaded contracts per roster." + dlNote,
        mbtns.join(" ") || '<span class="small" style="color:var(--muted);">No multi-year option computed.</span>'));
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
    $$("[data-action='activate-ir']", body).forEach(function (btn) {
      btn.addEventListener("click", function () { submitRosterMove("activate_ir", p); });
    });
    $$("[data-action='promote-taxi']", body).forEach(function (btn) {
      btn.addEventListener("click", function () { submitRosterMove("promote_taxi", p); });
    });
    $$("[data-action='trade']", body).forEach(function (btn) {
      btn.addEventListener("click", function () {
        // Hand-off to Trade Hub.
        // Critical: pass ?api=<worker>/trade-workbench so Trade Hub
        // loads the FULL 12-team payload from the worker. Without
        // ?api= it falls back to trade_workbench_sample.json which
        // has only 3 demo teams (Keith 2026-05-19: "Trade WarRoom
        // doesn't have all teams"). The api param's value is forwarded
        // to fetchJson with L= + YEAR= appended automatically by
        // Trade Hub's buildApiRequestUrlFromQuery.
        const apiUrl = WORKER_BASE + "/trade-workbench";
        const qs = "?api=" + encodeURIComponent(apiUrl) +
                   "&L=" + encodeURIComponent(LEAGUE_ID) +
                   "&YEAR=" + encodeURIComponent(SEASON) +
                   "&franchise_id=" + encodeURIComponent(p.fid) +
                   "&focus_pid=" + encodeURIComponent(p.id) +
                   "&focus_fid=" + encodeURIComponent(p.fid);
        window.open("/trades/trade_workbench.html" + qs, "_blank", "noopener");
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
    const tcv = yrs.reduce(function (a, b) { return a + b; }, 0);
    const aav = Math.round(tcv / totalYears);
    const loaded = yrs.some(function (v) { return v !== yrs[0]; });
    const status = statusBase + (loaded ? (yrs[0] > aav ? "-FL" : "-BL") : "");
    const gtd = tcv > 4000 ? Math.round(tcv * 0.75) : 0;
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

  // Count a team's loaded (FL/BL) contracts on the active roster (taxi $0/exempt).
  function loadedContractCountForTeam(fid) {
    const team = (STATE.teams || []).find(function (t) { return t.fid === fid; });
    if (!team) return 0;
    return (team.players || []).filter(function (q) { return !q.isTaxi && isLoadedRow(q); }).length;
  }
  // MYAC loaded (§C2): free-key Y1 (FL if Y1>AAV, BL if Y1<AAV; Y1 ≥ 20% TCV);
  // the LAST year auto-computes (TCV − keyed years). 2-yr: Y1 free → Y2 auto.
  // 3-yr: Y1 & Y2 free → Y3 auto. Hard-blocks at the 5-loaded roster cap (§C2).
  function openMyacLoadedForm(p, totalYears) {
    const bid = safeInt(p.salary, 0);
    if (bid < 1000) { flashToast("MYAC needs a base salary ≥ $1,000.", "warn"); return; }
    const statusBase = myacStatusBase(p);
    const tcv = bid * totalYears;          // flat — TCV = bid × years, NO escalator (§C2)
    const aav = bid;
    const minY1 = Math.ceil(tcv * 0.2 / 1000) * 1000;
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
    const validateYrs = function (yrs) {
      if (yrs.some(function (v) { return v % 1000 !== 0; })) return "All years must be whole $1,000 increments.";
      if (yrs[0] < minY1) return "Year 1 must be ≥ " + fmtUSD(minY1) + " (20% of TCV).";
      if (yrs.some(function (v) { return v < 1000; })) return "No year can be below $1,000 — there are no $0 years.";
      return "";
    };
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
    const currentSalary = Math.max(1000, roundToK(safeInt(p.salary, 0)));
    const defaultY2 = futureAav;
    const defaultY3 = futureAav;
    const body = $("#fo-slideover-body");
    body.innerHTML = `
      <div class="fo-form">
        <h3 style="margin:0 0 4px;">Extend ${escapeHtml(p.name)} +2Y (Loaded)</h3>
        <div class="fo-form-note">
          §C4.6 escalator: extension AAV = <strong>${fmtUSD(futureAav)}</strong>/yr · total extension $ = <strong>${fmtUSD(extensionTotal)}</strong>.
          Y1 is locked at current salary. Split Y2 + Y3 however you like; Σ(Y2,Y3) must equal ${fmtUSD(extensionTotal)}.
          Owner-chosen split derives the FL/BL suffix per canon §C4.3 (Y2 > Y3 = BL, Y2 &lt; Y3 = FL, Y2 = Y3 = flat).
        </div>
        <div class="fo-form-row"><span class="lbl">Y1 (locked — current salary)</span><span class="val">${fmtUSD(currentSalary)}</span></div>
        <div class="fo-form-row"><span class="lbl">Y2 ($)</span>
          <input type="number" id="fo-extl-y2" step="1000" min="1000" value="${defaultY2}" class="num" style="background:var(--panel-alt); color:var(--text); border:1px solid var(--border); padding:6px 10px; border-radius:4px;">
        </div>
        <div class="fo-form-row"><span class="lbl">Y3 ($)</span>
          <input type="number" id="fo-extl-y3" step="1000" min="1000" value="${defaultY3}" class="num" style="background:var(--panel-alt); color:var(--text); border:1px solid var(--border); padding:6px 10px; border-radius:4px;">
        </div>
        <div class="fo-form-row"><span class="lbl">Σ Y2+Y3 (must equal extension total)</span><span class="val" id="fo-extl-sum">${fmtUSD(extensionTotal)}</span></div>
        <div class="fo-form-row"><span class="lbl">Derived status</span><span class="val" id="fo-extl-status">Vet-Ext2</span></div>
        <div class="fo-form-actions">
          <button class="btn secondary" id="fo-extl-cancel">Cancel</button>
          <button class="btn" id="fo-extl-submit">${IS_DRY_RUN ? "Submit (dry-run)" : "Submit Loaded Extension"}</button>
        </div>
      </div>`;
    function recalc() {
      const y2 = safeInt($("#fo-extl-y2").value, 0);
      const y3 = safeInt($("#fo-extl-y3").value, 0);
      $("#fo-extl-sum").textContent = fmtUSD(y2 + y3) + " / " + fmtUSD(extensionTotal);
      let suffix = "";
      if (y2 > y3) suffix = "-BL";        // back-loaded (Y2 > Y3 means contract loads OUTWARD: Y2 high, Y3 low... wait)
      // Per canon §C4.3 + LaPorta example: EXT2-FL = Y1 > Y2 (front-loaded);
      // EXT2-BL = Y1 < Y2 (back-loaded). For LOADED 2yr (Y1 current + Y2+Y3
      // extension), FL means Y2 > Y3 (front of extension is heavier); BL
      // means Y2 < Y3 (back of extension is heavier). Flat = Y2 == Y3.
      if (y2 > y3) suffix = "-FL";
      else if (y2 < y3) suffix = "-BL";
      else suffix = "";
      $("#fo-extl-status").textContent = "Vet-Ext2" + suffix;
    }
    $("#fo-extl-y2").addEventListener("input", recalc);
    $("#fo-extl-y3").addEventListener("input", recalc);
    $("#fo-extl-cancel").addEventListener("click", function () { renderSlideoverBody(); });
    $("#fo-extl-submit").addEventListener("click", function () { submitExtensionLoaded(p, baseFlat, currentSalary, extensionTotal, statusBase); });
  }

  async function submitExtensionLoaded(p, baseFlat, currentSalary, extensionTotal, statusBase) {
    const y2 = safeInt($("#fo-extl-y2").value, 0);
    const y3 = safeInt($("#fo-extl-y3").value, 0);
    if (y2 + y3 !== extensionTotal) {
      flashToast("Σ(Y2, Y3) must equal " + fmtUSD(extensionTotal) + " (currently " + fmtUSD(y2 + y3) + ").", "err");
      return;
    }
    if (y2 < 1000 || y3 < 1000) {
      flashToast("Both Y2 and Y3 must be at least $1,000.", "err");
      return;
    }
    const suffix = y2 > y3 ? "-FL" : y2 < y3 ? "-BL" : "";
    const status = (statusBase || "Vet-Ext2") + suffix;
    const tcv = currentSalary + y2 + y3;
    const gtd = tcv > 4000 ? Math.round(tcv * 0.75) : Math.max(0, tcv - currentSalary);
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
      salary: y2,                        // Y2 is the first extension year's $$
      contract_year: 3,                  // full new length (Y1 + Y2 + Y3)
      contract_status: status,
      contract_info: contractInfo,
      prior_contract_status: p.type,
      prior_salary: p.salary,
      prior_contract_year: p.years,
      prior_contract_info: p.special,
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
    const yrs = safeInt(opt.years, 0) || safeInt(opt.years_added, 0) || safeInt(opt.length, 0);
    const salary = safeInt(opt.salary, 0) || safeInt(opt.year1_salary, 0);
    const status = safeStr(opt.contract_status || opt.status || ("Vet-Ext" + yrs));
    const info   = safeStr(opt.contract_info || opt.info || "");
    return `
      <div class="fo-form">
        <h3 style="margin:0 0 4px;">Extend ${escapeHtml(p.name)} · +${yrs}Y</h3>
        <div class="fo-form-note">
          Confirm the extension terms below. ${IS_DRY_RUN
            ? "<strong style='color:var(--dryrun);'>Dry-run mode is ON</strong> — this will NOT write to MFL."
            : "This will POST to <code>/commish-contract-update</code> and write to MFL."}
        </div>
        <div class="fo-form-row"><span class="lbl">New status</span><span class="val">${escapeHtml(status)}</span></div>
        <div class="fo-form-row"><span class="lbl">New salary (Y1)</span><span class="val">${fmtK(salary)}</span></div>
        <div class="fo-form-row"><span class="lbl">New length</span><span class="val">${yrs} year${yrs === 1 ? "" : "s"}</span></div>
        <div class="fo-form-row"><span class="lbl">Contract info</span><span class="val">${escapeHtml(info || "—")}</span></div>
        <div class="fo-form-row"><span class="lbl">Prior salary</span><span class="val">${fmtK(p.salary)}</span></div>
        <div class="fo-form-row"><span class="lbl">Prior status</span><span class="val">${escapeHtml(p.type)}</span></div>
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

    const yrs = safeInt(opt.years, 0) || safeInt(opt.years_added, 0) || safeInt(opt.length, 0);
    const salary = safeInt(opt.salary, 0) || safeInt(opt.year1_salary, 0);
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
      salary: salary,
      contract_year: yrs,                 // full length, post-LaPorta
      contract_status: status,
      contract_info: info,
      prior_salary: p.salary,
      prior_contract_year: p.years,
      prior_contract_status: p.type,
      prior_contract_info: p.special,
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

  // For a single player, return the projected cap hit for year offset
  // (0 = current season, 1 = next, 2 = year after). Honors active
  // preview state (ext1 / ext2 / drop) from STATE.capPreviews.
  // Canon: taxi=$0 (§6.E), IR×0.5 (§6.C), expired=$0.
  function projectedPlayerCapForOffset(p, offset) {
    if (!p) return 0;
    const preview = STATE.capPreviews[p.id + ":" + p.fid] || null;

    // ── Drop preview ─────────────────────────────────────────────
    // Y+0 cap = drop penalty (the cap charge for cutting).
    // Y+1, Y+2 = $0 (player no longer on roster).
    if (preview === "drop") {
      if (offset === 0) return dropPenaltyEstimate(p).amount;
      return 0;
    }

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

    if (p.isIr && offset === 0) return Math.round(baseAmt * 0.5);
    return baseAmt;
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

  function renderCapTab() {
    const body = $("#fo-cap-body");
    if (!body) return;
    if (STATE.capSubview === "detail") body.innerHTML = renderCapDetail();
    else                               body.innerHTML = renderCapSummary();
    wireCapTab();
    renderDropReconciliationPanel(); // async — SUM-rounding true-up preview (canon §6)
  }

  // Drop-penalty SUM rounding (canon §6: round the per-franchise SUM, not each
  // penalty). Individual penalties stay exact all season; the per-franchise
  // true-up to the nearest $1,000 posts to MFL automatically at the FA Auction
  // Cut Deadline. This panel previews what that true-up will be.
  async function renderDropReconciliationPanel() {
    const body = $("#fo-cap-body");
    if (!body) return;
    let panel = $("#fo-cap-reconciliation");
    if (!panel) {
      panel = document.createElement("div");
      panel.id = "fo-cap-reconciliation";
      panel.style.marginTop = "16px";
      body.appendChild(panel);
    }
    const head = '<div class="fo-card-head"><h3 style="margin:0;">Drop-Penalty Rounding</h3><span class="small" style="color:var(--muted);">Canon §6 — round the SUM, not per-penalty</span></div>';
    panel.innerHTML = '<div class="fo-card">' + head + '<p class="small" style="color:var(--muted);">Loading…</p></div>';
    let data;
    try {
      const url = apiUrl("/admin/drops/reconciliation") + "?L=" + encodeURIComponent(LEAGUE_ID) + "&YEAR=" + encodeURIComponent(SEASON);
      data = await fetchJSON(url);
    } catch (e) {
      panel.innerHTML = '<div class="fo-card">' + head + '<p class="small">Unavailable: ' + escapeHtml(e.message || String(e)) + '</p></div>';
      return;
    }
    const frs = (data && data.franchises) || [];
    const anyDelta = frs.some(function (f) { return f.rounding_delta !== 0; });
    const posted = !!(data && data.reconciliation_posted);
    const dl = (data && data.deadline_date_et) || "the FA Auction Cut Deadline";
    let rows = "";
    frs.forEach(function (f) {
      const d = f.rounding_delta;
      const dStr = d === 0 ? "—" : (d > 0 ? "+" : "−") + "$" + Math.abs(d).toLocaleString();
      const dCol = d === 0 ? "var(--muted)" : (d > 0 ? "#c0392b" : "#1f8a4c");
      rows += '<tr><td>' + escapeHtml(f.franchise_name) + '</td>' +
        '<td style="text-align:right;">$' + Number(f.exact_sum).toLocaleString() + '</td>' +
        '<td style="text-align:right;font-weight:600;">$' + Number(f.rounded_total).toLocaleString() + '</td>' +
        '<td style="text-align:right;color:' + dCol + ';">' + dStr + '</td>' +
        '<td style="text-align:center;color:var(--muted);">' + safeInt(f.penalty_count, 0) + '</td></tr>';
    });
    const note = posted
      ? '✅ Reconciliation has posted to MFL — franchise totals are final.'
      : (anyDelta
          ? '⏳ The per-franchise true-up posts to MFL automatically at the FA Auction Cut Deadline (' + escapeHtml(dl) + '). Individual penalties stay exact until then.'
          : 'No rounding adjustment pending — every franchise total is already a clean $1,000.');
    panel.innerHTML =
      '<div class="fo-card">' + head +
      '<p class="fo-row-hint">' + note + '</p>' +
      (frs.length
        ? '<div class="fo-table-scroll"><table class="fo-table"><thead><tr><th>Team</th>' +
          '<th style="text-align:right;">Penalties (exact)</th><th style="text-align:right;">Rounded total</th>' +
          '<th style="text-align:right;">Δ true-up</th><th style="text-align:center;"># drops</th></tr></thead><tbody>' +
          rows + '</tbody></table></div>'
        : '<p class="small" style="color:var(--muted);">No cap penalties accrued yet this season.</p>') +
      '</div>';
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
    return true;
  }

  function aggregateTeamForSummary(team, filters) {
    const out = {
      fid: team.fid, name: team.name,
      count: 0, active: 0, taxi: 0, ir: 0,
      totalSalary: 0, totalAAV: 0, totalTCV: 0
    };
    (team.players || []).forEach(function (p) {
      if (!capSummaryPlayerMatches(p, filters)) return;
      out.count += 1;
      if (p.isTaxi) out.taxi += 1;
      else if (p.isIr) out.ir += 1;
      else out.active += 1;
      out.totalSalary += currentCapHit(p);              // counts vs cap (taxi=0, IR×0.5)
      out.totalAAV    += displayAavForPlayer(p);
      out.totalTCV    += totalContractValueForPlayer(p);
    });
    // Team-level cap adjustments from the worker summary — these aren't
    // player-attributable so they don't honor the position/type/etc
    // filters. Surfaced as their own columns so users see the breakdown.
    const s = team.summary || {};
    out.dropPen   = safeInt(s.adj_cut, 0);
    out.tradeSal  = safeInt(s.adj_trade, 0);
    out.otherAdj  = safeInt(s.adj_other, 0);
    // Total cap = filtered salary + ALL adjustments (adjustments are
    // team-level commitments; can't be filtered).
    out.totalCap  = out.totalSalary + out.dropPen + out.tradeSal + out.otherAdj;
    out.pct       = Math.round((out.totalCap / CAP_CEILING) * 100);
    return out;
  }

  function renderCapSummary() {
    const f = STATE.capSummaryFilters;
    const sort = STATE.capSummarySort;
    const rows = STATE.teams.map(function (t) { return aggregateTeamForSummary(t, f); });
    const numericKeys = ["count", "active", "taxi", "ir",
                         "totalSalary", "dropPen", "tradeSal", "totalCap",
                         "pct", "totalAAV", "totalTCV"];
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
      return `
        <tr data-fid="${escapeHtml(r.fid)}" class="fo-cap-summary-row">
          <td><a href="#" class="fo-cap-team-link" data-fid="${escapeHtml(r.fid)}">${escapeHtml(r.name)}</a></td>
          <td class="num">${r.count}</td>
          <td class="num">${r.active}</td>
          <td class="num">${r.taxi}</td>
          <td class="num">${r.ir}</td>
          <td class="num">${fmtUSD(r.totalSalary)}</td>
          <td class="num ${dropCls}">${r.dropPen > 0 ? fmtUSD(r.dropPen) : "—"}</td>
          <td class="num ${tradeCls}">${tradeCell}</td>
          <td class="num ${capCls}"><strong>${fmtUSD(r.totalCap)}</strong></td>
          <td class="num ${capCls}">${r.pct}%</td>
          <td class="num">${fmtUSD(r.totalAAV)}</td>
          <td class="num">${fmtUSD(r.totalTCV)}</td>
        </tr>`;
    }).join("");

    // League totals row (sums of visible columns + aggregate %).
    const totals = rows.reduce(function (acc, r) {
      acc.count += r.count; acc.active += r.active; acc.taxi += r.taxi; acc.ir += r.ir;
      acc.totalSalary += r.totalSalary;
      acc.dropPen   += r.dropPen;
      acc.tradeSal  += r.tradeSal;
      acc.totalCap  += r.totalCap;
      acc.totalAAV += r.totalAAV; acc.totalTCV += r.totalTCV;
      return acc;
    }, { count: 0, active: 0, taxi: 0, ir: 0,
         totalSalary: 0, dropPen: 0, tradeSal: 0, totalCap: 0,
         totalAAV: 0, totalTCV: 0 });
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
              <option value="">All</option>
              <option value="0" ${f.years === "0" ? "selected" : ""}>Expired</option>
              <option value="1" ${f.years === "1" ? "selected" : ""}>1</option>
              <option value="2" ${f.years === "2" ? "selected" : ""}>2</option>
              <option value="3" ${f.years === "3" ? "selected" : ""}>3</option>
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
              <th class="num" data-cap-sort="totalSalary">Salary${arrow("totalSalary")}</th>
              <th class="num" data-cap-sort="dropPen">Drop Pen${arrow("dropPen")}</th>
              <th class="num" data-cap-sort="tradeSal">Trade Sal${arrow("tradeSal")}</th>
              <th class="num" data-cap-sort="totalCap">Total Cap${arrow("totalCap")}</th>
              <th class="num" data-cap-sort="pct">% of $300K${arrow("pct")}</th>
              <th class="num" data-cap-sort="totalAAV">AAV${arrow("totalAAV")}</th>
              <th class="num" data-cap-sort="totalTCV">TCV${arrow("totalTCV")}</th>
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
              <td class="num">${fmtUSD(totals.totalSalary)}</td>
              <td class="num">${fmtUSD(totals.dropPen)}</td>
              <td class="num">${fmtUSD(totals.tradeSal)}</td>
              <td class="num"><strong>${fmtUSD(totals.totalCap)}</strong></td>
              <td class="num"><strong>${totals.pct}%</strong> <span class="small" style="color:var(--muted);">of ${fmtUSD(leagueCeiling)}</span></td>
              <td class="num">${fmtUSD(totals.totalAAV)}</td>
              <td class="num">${fmtUSD(totals.totalTCV)}</td>
            </tr>
          </tfoot>
        </table>
        <p class="small" style="color:var(--muted); margin: 8px 0 0;">
          Click a team name to drill into Detail. <strong>Salary</strong> = current-year player cap hits (taxi $0, IR ×0.5) and honors the filters above. <strong>Drop Pen</strong> + <strong>Trade Sal</strong> are team-level cap adjustments from the worker (not filterable). <strong>Total Cap</strong> = Salary + adjustments. League % = sum of all teams' total cap / $${(CAP_CEILING / 1000) * STATE.teams.length}K (= $300K × ${STATE.teams.length} teams).
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

  function renderCapDetail() {
    const teams = STATE.teams;
    if (!teams.length) return '<div class="fo-placeholder">No teams loaded.</div>';
    const focusFid = STATE.capFocusedTeamFid || (STATE.me && STATE.me.franchise_id) || teams[0].fid;
    const team = STATE.teams.find(function (t) { return t.fid === focusFid; }) || teams[0];
    const yr0 = safeInt(SEASON, 0);
    const opts = teams.map(function (t) {
      return `<option value="${escapeHtml(t.fid)}" ${t.fid === team.fid ? "selected" : ""}>${escapeHtml(t.name)}</option>`;
    }).join("");

    // Active-preview count for the toolbar pill.
    const activePreviews = Object.keys(STATE.capPreviews).filter(function (k) {
      return k.endsWith(":" + team.fid);
    }).length;

    return `
      <div class="fo-card">
        <div class="fo-toolbar-row">
          <label class="fo-field">
            <span>Team</span>
            <select id="fo-cap-team-select">${opts}</select>
          </label>
          <button type="button" class="btn secondary" id="fo-cap-back-summary">← Back to Summary</button>
          ${activePreviews ? `<button type="button" class="btn secondary" id="fo-cap-clear-previews">Clear ${activePreviews} preview${activePreviews === 1 ? "" : "s"}</button>` : ""}
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

  function renderCapDetailBody(team) {
    const yr0 = safeInt(SEASON, 0);
    // Compute order only if team changed or no order yet — otherwise
    // preserve. Header click clears order via recomputeCapDetailOrder.
    if (STATE.capDetailOrderForFid !== team.fid || !STATE.capDetailOrder.length) {
      recomputeCapDetailOrder(team);
    }
    const byId = Object.create(null);
    (team.players || []).forEach(function (p) { byId[p.id] = p; });
    const players = STATE.capDetailOrder.map(function (pid) { return byId[pid]; }).filter(Boolean);
    const totals = {
      cy:  teamCapForOffset(team, 0),
      ny:  teamCapForOffset(team, 1),
      ny2: teamCapForOffset(team, 2)
    };
    const rows = players.map(function (p) { return renderCapDetailRow(p, team); }).join("");
    const sort = STATE.capDetailSort;
    const arrow = (key) => sort.key === key ? (sort.dir > 0 ? " ▲" : " ▼") : "";
    return `
      <p class="fo-row-hint">
        💡 Click <strong>Ext1 / Ext2 / Drop / Promote</strong> on any row to preview the impact on team totals (toggle off by clicking again). Row click opens the slide-over. Click any column header to sort.
      </p>
      <div class="fo-cap-totals">
        <div><span class="lbl">${yr0}</span><span class="val">${fmtUSD(totals.cy)}</span></div>
        <div><span class="lbl">${yr0 + 1}</span><span class="val">${fmtUSD(totals.ny)}</span></div>
        <div><span class="lbl">${yr0 + 2}</span><span class="val">${fmtUSD(totals.ny2)}</span></div>
      </div>
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

  function renderCapDetailRow(p, team) {
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
    if (canDrop) {
      btns.push(`<button class="btn small ${active === "drop" ? "warn" : "secondary"} fo-cap-prev-btn" data-preview="drop" data-pid="${escapeHtml(p.id)}" data-fid="${escapeHtml(team.fid)}">Drop</button>`);
    }
    if (canPromote) {
      btns.push(`<button class="btn small ${active === "promote" ? "ok" : "secondary"} fo-cap-prev-btn" data-preview="promote" data-pid="${escapeHtml(p.id)}" data-fid="${escapeHtml(team.fid)}">Promote</button>`);
    }
    const previewCell = btns.length ? btns.join(" ") : '<span class="small" style="color:var(--muted);">—</span>';

    // Row class — drop gets a red tint so it's obvious; promote gets
    // a green tint; ext gets the existing blue. Keith 2026-05-19:
    // "Drop should show as red and indicate penalty so we know."
    let rowClass = "";
    if (active === "drop")                      rowClass = "fo-cap-row-drop";
    else if (active === "promote")              rowClass = "fo-cap-row-promote";
    else if (active === "ext1" || active === "ext2") rowClass = "fo-cap-row-active";

    // Y+0 cell annotation when dropping — "(penalty)" makes the cap charge
    // unmistakable vs a salary.
    const y0Cell = active === "drop"
      ? `<span class="fo-cap-pen">${fmtUSD(cy)}</span> <span class="small" style="color:var(--err); font-style:italic;">(penalty)</span>`
      : fmtUSD(cy);

    const statusKls = active === "drop" ? "drop-preview"
                     : active === "promote" ? "active"
                     : rosterStatusClass(p);
    const statusLbl = active === "drop" ? "DROPPED"
                     : active === "promote" ? "→ ACTIVE"
                     : rosterStatusLabel(p);

    return `
      <tr class="${rowClass}" data-pid="${escapeHtml(p.id)}" data-fid="${escapeHtml(team.fid)}">
        <td>${escapeHtml(p.name)}</td>
        <td><span class="fo-pos ${escapeHtml(posBucket(p.position))}">${escapeHtml(p.position)}</span></td>
        <td><span class="fo-ctype ${ctypeClass(p.type)}">${escapeHtml(String(p.type || "—").toUpperCase())}</span></td>
        <td class="col-lo num">${safeInt(p.years, 0) || "—"}</td>
        <td class="num">${y0Cell}</td>
        <td class="num">${fmtUSD(ny)}</td>
        <td class="num">${fmtUSD(ny2)}</td>
        <td>${previewCell}</td>
        <td class="col-lo"><span class="fo-status ${statusKls}">${escapeHtml(statusLbl)}</span></td>
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
        renderCapTab();
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
      // Clear previews for focused team.
      if (e.target.closest("#fo-cap-clear-previews")) {
        const fid = STATE.capFocusedTeamFid;
        Object.keys(STATE.capPreviews).forEach(function (k) {
          if (k.endsWith(":" + fid)) delete STATE.capPreviews[k];
        });
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
    const url = EP_ROSTER_ACTION() +
      "?L=" + encodeURIComponent(LEAGUE_ID) +
      "&YEAR=" + encodeURIComponent(SEASON);
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
    const minY1 = Math.max(1000, Math.round(tcv * 0.20 / 1000) * 1000);
    const body = $("#fo-slideover-body");
    body.innerHTML = `
      <div class="fo-form">
        <h3 style="margin:0 0 4px;">Restructure ${escapeHtml(p.name)}</h3>
        <div class="fo-form-note">
          TCV ${fmtUSD(tcv)} · Years remaining ${years} · Y1 minimum (20% TCV) ${fmtUSD(minY1)}.
          Σ year salaries must equal TCV.
        </div>
        <div class="fo-form-row"><span class="lbl">Year 1 ($)</span>
          <input type="number" id="fo-rs-y1" step="1000" min="${minY1}" value="${minY1}" class="num" style="background:var(--panel-alt); color:var(--text); border:1px solid var(--border); padding:6px 10px; border-radius:4px;">
        </div>
        <div class="fo-form-row"><span class="lbl">Year 2 ($)</span>
          <input type="number" id="fo-rs-y2" step="1000" min="1000" value="${Math.max(1000, tcv - minY1)}" class="num" style="background:var(--panel-alt); color:var(--text); border:1px solid var(--border); padding:6px 10px; border-radius:4px;">
        </div>
        ${years >= 3 ? `<div class="fo-form-row"><span class="lbl">Year 3 ($)</span>
          <input type="number" id="fo-rs-y3" step="1000" min="0" value="0" class="num" style="background:var(--panel-alt); color:var(--text); border:1px solid var(--border); padding:6px 10px; border-radius:4px;">
        </div>` : ""}
        <div class="fo-form-row"><span class="lbl">Sum (must equal TCV)</span><span class="val" id="fo-rs-sum">${fmtUSD(tcv)}</span></div>
        <div class="fo-form-actions">
          <button class="btn secondary" id="fo-rs-cancel">Cancel</button>
          <button class="btn" id="fo-rs-submit">${IS_DRY_RUN ? "Submit (dry-run)" : "Submit Restructure"}</button>
        </div>
      </div>`;
    function recalcSum() {
      const y1 = safeInt($("#fo-rs-y1").value, 0);
      const y2 = safeInt($("#fo-rs-y2").value, 0);
      const y3 = years >= 3 ? safeInt(($("#fo-rs-y3") || {}).value, 0) : 0;
      $("#fo-rs-sum").textContent = fmtUSD(y1 + y2 + y3) + " / " + fmtUSD(tcv);
    }
    $("#fo-rs-y1").addEventListener("input", recalcSum);
    $("#fo-rs-y2").addEventListener("input", recalcSum);
    if (years >= 3) $("#fo-rs-y3").addEventListener("input", recalcSum);
    $("#fo-rs-cancel").addEventListener("click", function () { renderSlideoverBody(); });
    $("#fo-rs-submit").addEventListener("click", function () { submitRestructure(p, years); });
  }
  async function submitRestructure(p, years) {
    const y1 = safeInt($("#fo-rs-y1").value, 0);
    const y2 = safeInt($("#fo-rs-y2").value, 0);
    const y3 = years >= 3 ? safeInt(($("#fo-rs-y3") || {}).value, 0) : 0;
    const tcv = totalContractValueForPlayer(p);
    const sum = y1 + y2 + y3;
    if (sum !== tcv) {
      flashToast("Sum must equal TCV " + fmtUSD(tcv) + " (currently " + fmtUSD(sum) + ").", "err");
      return;
    }
    if (y1 < Math.round(tcv * 0.20 / 1000) * 1000) {
      flashToast("Y1 must be ≥ 20% of TCV (" + fmtUSD(Math.round(tcv * 0.20 / 1000) * 1000) + ").", "err");
      return;
    }
    const aav = Math.round(tcv / Math.max(1, years));
    const gtd = tcv > 4000 ? Math.round(tcv * 0.75) : Math.max(0, tcv - y1);
    const yearTokens = ["Y1-" + fmtK(y1).replace(/\$/, ""), "Y2-" + fmtK(y2).replace(/\$/, "")];
    if (years >= 3) yearTokens.push("Y3-" + fmtK(y3).replace(/\$/, ""));
    const info = "CL " + years + "|TCV " + fmtK(tcv).replace(/\$/, "") +
                 "|AAV " + fmtK(aav).replace(/\$/, "") + "|" + yearTokens.join(", ") +
                 "|GTD: " + fmtK(gtd).replace(/\$/, "") + "|Restructured " + new Date().getFullYear();
    const confirmLines = ["Confirm restructure for " + p.name + "?", "",
      "Y1: " + fmtUSD(y1), "Y2: " + fmtUSD(y2)];
    if (years >= 3) confirmLines.push("Y3: " + fmtUSD(y3));
    confirmLines.push("TCV: " + fmtUSD(tcv), "AAV: " + fmtUSD(aav), "GTD: " + fmtUSD(gtd));
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
      contract_status: p.type || "Veteran",
      contract_info: info,
      tcv: tcv, aav: aav, guaranteed: gtd,
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
    const m = STATE.tagData.meta || {};
    if (meta) {
      meta.textContent =
        "Cycle: tagging for " + (m.tracking_for_season || (safeInt(SEASON, 0))) +
        " (source season " + (m.season || "?") + ") · " +
        (m.count || STATE.tagData.rows.length) + " eligible players · " +
        "scoring weeks " + (m.scoring_weeks_used || "?") + " · " +
        "prior AAV snapshot wk " + (m.aav_snapshot_week || "?");
    }
    if (STATE.tagSubview === "breakdown") body.innerHTML = renderTagBreakdown();
    else                                  body.innerHTML = renderTagEligible();
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

    return `
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

  function renderTagBreakdown() {
    const m = STATE.tagData.meta || {};
    const cb = m.calc_breakdown || {};
    const posKeys = Object.keys(cb).sort();
    if (!posKeys.length) {
      return '<div class="fo-placeholder">No calc_breakdown in tag_tracking.json meta.</div>';
    }
    const sections = posKeys.map(function (posKey) {
      const pos = cb[posKey] || {};
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
    return `
      <p class="fo-row-hint">
        💡 Tag tiers come from prior season's <strong>positional rank</strong> by points. Each tier's <strong>base bid</strong> = average AAV of the players in that rank band. Effective tag salary on the Eligible Players view = max(this base bid, <strong>max(current AAV, prior AAV) × 1.10</strong>). Canon: AAV-only — never current/prior salary.
      </p>
      ${sections}`;
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

  // ── Contract Revert tab (commish-only) ────────────────────────────────
  // Lists recent contract submissions (extension / MYAC / restructure / tag)
  // for the season from GET /admin/contract-submissions, lets the commish pick
  // one or more and revert them via POST /admin/contract-revert (restores the
  // PRIOR contract in MFL; tags -> untag). Dry-run preview + confirm before write.
  function contractRevertState() {
    if (!STATE._cr) STATE._cr = { subs: [], sel: {} };
    return STATE._cr;
  }
  async function postJSONRaw(url, payload) {
    const r = await fetch(url, {
      method: "POST", credentials: "omit", cache: "no-store",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload || {})
    });
    const txt = await r.text();
    let data; try { data = txt ? JSON.parse(txt) : {}; } catch (_) { data = { raw: txt }; }
    if (!r.ok) throw new Error((data && data.error) || ("HTTP " + r.status));
    return data;
  }
  function ctKindLabel(k) {
    return { myac: "MYAC", extension: "Extension", restructure: "Restructure", tag: "Tag", untag: "Untag" }[k] || k;
  }
  function ctContractStr(c, isTag) {
    if (!c) return isTag ? "(untag)" : "—";
    const sal = c.salary != null ? "$" + Number(c.salary).toLocaleString() : "$?";
    const yr = c.contract_year != null ? c.contract_year + "yr" : "";
    return [c.contract_status || "", yr, sal].filter(Boolean).join(" · ");
  }
  async function renderContractsTab() {
    const body = $("#fo-contracts-body");
    const meta = $("#fo-contracts-meta");
    if (!body) return;
    body.innerHTML = '<div class="fo-table-loading">Loading contract submissions…</div>';
    const cr = contractRevertState();
    try {
      const url = apiUrl("/admin/contract-submissions") + "?L=" + encodeURIComponent(LEAGUE_ID) + "&YEAR=" + encodeURIComponent(SEASON);
      const data = await fetchJSON(url);
      cr.subs = (data && data.submissions) || [];
      cr.sel = {};
    } catch (e) {
      body.innerHTML = '<div class="fo-table-loading">Failed to load: ' + escapeHtml(e.message || String(e)) + '</div>';
      return;
    }
    if (meta) meta.textContent = cr.subs.length + " submission" + (cr.subs.length === 1 ? "" : "s") + " · " + SEASON;
    renderContractsBody();
  }
  function renderContractsBody() {
    const body = $("#fo-contracts-body");
    if (!body) return;
    const cr = contractRevertState();
    if (!cr.subs.length) { body.innerHTML = '<div class="fo-table-loading">No contract submissions this season.</div>'; return; }
    const fmtDt = (s) => String(s || "").replace("T", " ").slice(0, 16);
    let rows = "";
    cr.subs.forEach(function (s) {
      const key = s.table + ":" + s.id;
      const checked = cr.sel[key] ? "checked" : "";
      const disabled = s.revertable ? "" : "disabled";
      const isTag = s.kind === "tag" || s.kind === "untag";
      const newStr = ctContractStr(s.new, false) + (s.new && s.new.tag_side ? " (" + s.new.tag_side + ")" : "");
      const priorStr = ctContractStr(s.prior, isTag);
      const team = (STATE.teams || []).find(function (t) { return pad4(t.fid) === pad4(s.franchise_id); });
      const fr = (team && team.name) || s.franchise_id || "";
      rows += '<tr>' +
        '<td style="text-align:center;"><input type="checkbox" class="fo-cr-chk" data-key="' + key + '" ' + checked + ' ' + disabled + '></td>' +
        '<td>' + escapeHtml(s.player_name || s.player_id || "") + '</td>' +
        '<td>' + escapeHtml(ctKindLabel(s.kind)) + '</td>' +
        '<td>' + escapeHtml(fr) + '</td>' +
        '<td class="small">' + escapeHtml(newStr) + '</td>' +
        '<td class="small">' + escapeHtml(priorStr) + (s.revertable ? '' : ' <span style="color:var(--muted);">(no revert)</span>') + '</td>' +
        '<td class="small">' + escapeHtml(fmtDt(s.submitted_at_utc)) + '</td>' +
        '</tr>';
    });
    const nSel = Object.keys(cr.sel).filter(function (k) { return cr.sel[k]; }).length;
    body.innerHTML =
      '<div class="fo-cr-toolbar" style="margin:8px 0;display:flex;gap:10px;align-items:center;flex-wrap:wrap;">' +
        '<button type="button" class="btn small warn" id="fo-cr-revert"' + (nSel ? '' : ' disabled') + '>Revert selected (' + nSel + ')</button>' +
        '<button type="button" class="btn small secondary" id="fo-cr-refresh">↻ Refresh</button>' +
        '<span class="small" id="fo-cr-status" style="color:var(--muted);"></span>' +
      '</div>' +
      '<div class="fo-table-scroll"><table class="fo-table fo-cr-table"><thead><tr>' +
        '<th style="width:32px;"></th><th>Player</th><th>Kind</th><th>Team</th>' +
        '<th>Submitted (new)</th><th>Reverts to (prior)</th><th>When (UTC)</th>' +
      '</tr></thead><tbody>' + rows + '</tbody></table></div>';
    $$(".fo-cr-chk", body).forEach(function (chk) {
      chk.addEventListener("change", function () {
        const k = this.getAttribute("data-key");
        if (this.checked) cr.sel[k] = true; else delete cr.sel[k];
        renderContractsBody();
      });
    });
    const revBtn = $("#fo-cr-revert");
    if (revBtn) revBtn.addEventListener("click", doContractRevert);
    const refBtn = $("#fo-cr-refresh");
    if (refBtn) refBtn.addEventListener("click", renderContractsTab);
  }
  async function doContractRevert() {
    const cr = contractRevertState();
    const reverts = Object.keys(cr.sel).filter(function (k) { return cr.sel[k]; }).map(function (k) {
      const i = k.lastIndexOf(":");
      return { table: k.slice(0, i), id: safeInt(k.slice(i + 1), 0) };
    });
    if (!reverts.length) return;
    const status = $("#fo-cr-status");
    const setStatus = (m) => { if (status) status.textContent = m; };
    const revertUrl = apiUrl("/admin/contract-revert") + "?L=" + encodeURIComponent(LEAGUE_ID) + "&YEAR=" + encodeURIComponent(SEASON);
    // Dry-run preview first so the commish sees exactly what each revert restores.
    setStatus("Previewing (dry-run)…");
    let dry;
    try {
      dry = await postJSONRaw(revertUrl, { league_id: LEAGUE_ID, season: SEASON, dry_run: true, reverts: reverts });
    } catch (e) { setStatus("Preview failed: " + (e.message || e)); return; }
    const lines = (dry.results || []).map(function (r) {
      const to = r.restored && r.restored.contract_status
        ? r.restored.contract_status + " " + r.restored.contract_year + "yr $" + Number(r.restored.salary || 0).toLocaleString()
        : "untag";
      return (r.ok ? "✓" : "✗") + " " + (r.player_name || r.id) + " → " + to + (r.error ? " (" + r.error + ")" : "");
    });
    if (!window.confirm("Revert " + reverts.length + " contract(s) in MFL?\n\n" + lines.join("\n") + "\n\nThis writes to MFL (Discord silenced) and is not undoable from here.")) {
      setStatus("");
      return;
    }
    setStatus("Reverting…");
    try {
      const res = await postJSONRaw(revertUrl, { league_id: LEAGUE_ID, season: SEASON, dry_run: false, reverts: reverts });
      const all = res.results || [];
      const okN = all.filter(function (r) { return r.ok; }).length;
      const failed = all.filter(function (r) { return !r.ok; });
      setStatus("Reverted " + okN + "/" + all.length + (failed.length ? " — failed: " + failed.map(function (f) { return (f.player_name || f.id) + " (" + (f.error || f.status || "?") + ")"; }).join(", ") : "") + ". Reloading…");
      cr.sel = {};
      await loadRosterData();        // refresh cap/contract figures off the new MFL state
      renderRosterTable();
      await renderContractsTab();
    } catch (e) { setStatus("Revert failed: " + (e.message || e)); }
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

  // ── Go ──────────────────────────────────────────────────────────────
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
