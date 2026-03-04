(function () {
  "use strict";

  const TIMEZONE = "America/New_York";
  const MFL_API_BASE = "https://api.myfantasyleague.com";
  const THEME_KEY = "uow_theme_v1";
  const BUG_REPORT_WORKER_DEFAULT = "https://upsmflproduction.keith-creelman.workers.dev";

  const BUG_MODULE_OPTIONS_BY_APP = {
    "contract-command-center": [
      { value: "mym", label: "MYM" },
      { value: "extensions", label: "Extensions" },
      { value: "restructure", label: "Restructure" },
      { value: "tag", label: "Tag a Player" },
      { value: "expired-rookie-draft", label: "Expired Rookie Draft" },
      { value: "reports-audit", label: "Reports & Audit" },
      { value: "settings", label: "Settings / Commish" },
      { value: "other", label: "Other" }
    ],
    "trade-war-room": [
      { value: "proposal-builder", label: "Proposal Builder" },
      { value: "pending-trades", label: "Pending Trades" },
      { value: "accept-decline", label: "Accept / Decline" },
      { value: "review-submit", label: "Review / Submit" },
      { value: "other", label: "Other" }
    ],
    "roster-workbench": [
      { value: "roster-grid", label: "Roster Grid" },
      { value: "salary-columns", label: "Salary / Contract Columns" },
      { value: "owner-view", label: "Owner View" },
      { value: "other", label: "Other" }
    ],
    "ups-hot-links": [
      { value: "countdown-widget", label: "Countdown Widget" },
      { value: "owner-hub-stack", label: "Owner Hub Modules" },
      { value: "other", label: "Other" }
    ],
    other: [{ value: "other", label: "Other" }]
  };

  const BUG_ISSUE_TYPE_OPTIONS_BY_APP = {
    "contract-command-center": [
      { value: "eligibility-list-wrong", label: "Eligibility List Wrong" },
      { value: "extension-math-wrong", label: "Extension Math Wrong" },
      { value: "restructure-math-wrong", label: "Restructure Math Wrong" },
      { value: "tag-cost-wrong", label: "Tag Cost Wrong" },
      { value: "filters-not-working", label: "Filters Not Working" },
      { value: "submission-failed", label: "Submission Failed" },
      { value: "ui-visual", label: "UI / Visual" },
      { value: "other", label: "Other" },
    ],
    "trade-war-room": [
      { value: "pre-trade-extension-not-working", label: "Pre-Trade Extension Not Working" },
      { value: "trade-not-processing", label: "Trade Not Processing" },
      { value: "cap-validation-wrong", label: "Cap Validation Wrong" },
      { value: "review-submit-failed", label: "Review / Submit Failed" },
      { value: "xml-submit-failed", label: "MFL XML Submit Failed" },
      { value: "ui-visual", label: "UI / Visual" },
      { value: "other", label: "Other" },
    ],
    "roster-workbench": [
      { value: "data-incorrect", label: "Data Incorrect" },
      { value: "filters-not-working", label: "Filters Not Working" },
      { value: "ui-visual", label: "UI / Visual" },
      { value: "performance", label: "Performance" },
      { value: "other", label: "Other" },
    ],
    "ups-hot-links": [
      { value: "countdown-wrong", label: "Countdown / Date Wrong" },
      { value: "module-load-failed", label: "Module Not Loading" },
      { value: "ui-visual", label: "UI / Visual" },
      { value: "other", label: "Other" },
    ],
    other: [
      { value: "data-incorrect", label: "Data Incorrect" },
      { value: "submission-failed", label: "Submission Failed" },
      { value: "ui-visual", label: "UI / Visual" },
      { value: "performance", label: "Performance" },
      { value: "other", label: "Other" },
    ],
  };

  const BUG_HIDE_MODULE_FOR_APPS = new Set(["trade-war-room"]);
  const BUG_MAX_ATTACHMENTS = 3;
  const BUG_MAX_ATTACHMENT_FILE_BYTES = 8 * 1024 * 1024;
  const BUG_MAX_ATTACHMENT_DATA_URL_CHARS = 450000;

  const EVENT_OVERRIDES = {
    "2026": {
      seasonStart: { month: 3, day: 1, hour: 0, minute: 0 },
      ownersMeeting: { month: 3, day: 19, hour: 21, minute: 0 },
      expiringDeadline: { month: 5, day: 21, hour: 12, minute: 0 },
      rookieDraft: { month: 5, day: 24, hour: 18, minute: 30 },
      cutDeadline: { month: 7, day: 29, hour: 12, minute: 0 },
    faAuction: { month: 7, day: 31, hour: 12, minute: 0 }
    }
  };

  const DEFAULT_PLAYOFF_END_WEEK = 17;
  const DEFAULT_REGULAR_END_WEEK = 14;

  const INLINE_SCHEDULES = {
    "2026": [
      { week: 1, kickoff: 1789086000 },
      { week: 2, kickoff: 1789690500 },
      { week: 3, kickoff: 1790295300 },
      { week: 4, kickoff: 1790900100 },
      { week: 5, kickoff: 1791504900 },
      { week: 6, kickoff: 1792109700 },
      { week: 7, kickoff: 1792714500 },
      { week: 8, kickoff: 1793319300 },
      { week: 9, kickoff: 1793927700 },
      { week: 10, kickoff: 1794532500 },
      { week: 11, kickoff: 1795137300 },
      { week: 12, kickoff: 1795742100 },
      { week: 13, kickoff: 1796320800 },
      { week: 14, kickoff: 1796951700 },
      { week: 15, kickoff: 1797556500 },
      { week: 16, kickoff: 1798161300 },
      { week: 17, kickoff: 1798740000 },
      { week: 18, kickoff: 1799530200 }
    ]
  };

  const PUBLIC_ASSETS_BASE = (function () {
    const script = document.currentScript;
    if (script && script.src) {
      try {
        const url = new URL(script.src, window.location.href);
        url.search = "";
        url.hash = "";
        return url.href.replace(/ups_options_widget\.js$/, "");
      } catch (e) {
        // fall through to default
      }
    }
    return "https://keithcreelman.github.io/upsmflproduction/";
  })();

  const LOCAL_SCHEDULE_MANIFEST = {
    "2026": "ups_options_widget_schedule_2026.json"
  };

  const state = {
    mode: "countdown",
    selectedId: "",
    scheduleByYear: {},
    scheduleFetch: {},
    leagueDetailsByYear: {},
    leagueDetailsFetch: {},
    theme: loadThemeSetting(),
    manualSelection: false,
    bugBusy: false,
    bugAttachments: []
  };

  const $ = (sel) => document.querySelector(sel);

  function normalizeThemeValue(value, allowAuto) {
    const v = String(value || "").toLowerCase();
    if (v === "light" || v === "dark") return v;
    return allowAuto ? "auto" : "";
  }

  function getThemeFromQuery() {
    try {
      const params = new URLSearchParams(window.location.search || "");
      return normalizeThemeValue(params.get("THEME") || params.get("theme"), false);
    } catch (e) {
      return "";
    }
  }

  function parseLeagueId() {
    const params = new URLSearchParams(window.location.search || "");
    const raw = params.get("L") || "";
    return raw || "74598";
  }

  function parseFranchiseId() {
    const params = new URLSearchParams(window.location.search || "");
    const raw =
      params.get("FRANCHISE_ID") ||
      params.get("FRANCHISEID") ||
      params.get("franchise_id") ||
      params.get("F") ||
      "";
    const digits = String(raw || "").replace(/\D/g, "");
    return digits ? digits.padStart(4, "0").slice(-4) : "";
  }

  function parseMflUserId() {
    const params = new URLSearchParams(window.location.search || "");
    const raw =
      params.get("MFL_USER_ID") ||
      params.get("MFLUSERID") ||
      params.get("mfl_user_id") ||
      "";
    return String(raw || "").trim();
  }

  function parseWorkerBaseUrl() {
    const params = new URLSearchParams(window.location.search || "");
    const candidate = String(
      params.get("WORKER_URL") ||
      params.get("UPS_WORKER_URL") ||
      window.UPS_WORKER_URL ||
      BUG_REPORT_WORKER_DEFAULT
    ).trim();
    if (!candidate) return BUG_REPORT_WORKER_DEFAULT;
    try {
      const u = new URL(candidate);
      return `${u.protocol}//${u.host}`;
    } catch (e) {
      return BUG_REPORT_WORKER_DEFAULT;
    }
  }

  function loadThemeSetting() {
    const forcedByQuery = getThemeFromQuery();
    if (forcedByQuery) return forcedByQuery;
    try {
      const raw = localStorage.getItem(THEME_KEY);
      if (!raw) return "auto";
      return normalizeThemeValue(raw, true);
    } catch (e) {
      return "auto";
    }
  }

  function saveThemeSetting(theme) {
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch (e) {}
  }

  function applyThemeSetting(theme) {
    const prefersDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
    const sanitized = normalizeThemeValue(theme, true);
    const next = sanitized === "auto" ? (prefersDark ? "dark" : "light") : sanitized;
    document.body.setAttribute("data-theme", next);
    const themeSelect = $("#themeSelect");
    if (themeSelect && themeSelect.value !== sanitized) themeSelect.value = sanitized;
  }

  function applyHostTheme(theme) {
    const forced = normalizeThemeValue(theme, false);
    if (!forced) return;
    state.theme = forced;
    saveThemeSetting(state.theme);
    applyThemeSetting(state.theme);
    notifyParentTheme(state.theme);
  }

  function wireThemeListener() {
    if (!window.matchMedia) return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = () => {
      if (state.theme === "auto") applyThemeSetting("auto");
    };
    if (media.addEventListener) {
      media.addEventListener("change", handler);
    } else if (media.addListener) {
      media.addListener(handler);
    }
  }

  function notifyParentTheme(theme) {
    if (!window.parent || window.parent === window) return;
    const t = normalizeThemeValue(theme, true);
    try {
      window.parent.postMessage({ type: "uow-theme", theme: t }, "*");
    } catch (e) {}
  }

  function wireHostThemeMessages() {
    window.addEventListener("message", (e) => {
      const data = e && e.data ? e.data : {};
      if (!data || data.type !== "ups-theme") return;
      applyHostTheme(data.mode || data.theme || "");
    });
  }

  function safeInt(x) {
    const n = parseInt(String(x).replace(/[^\d-]/g, ""), 10);
    return Number.isFinite(n) ? n : 0;
  }

  function safeStr(v) {
    return String(v == null ? "" : v).trim();
  }

  function parseSeasonYear() {
    const params = new URLSearchParams(window.location.search || "");
    const raw = params.get("YEAR") || "";
    const match = raw.match(/\d{4}/);
    if (match) return safeInt(match[0]);
    return new Date().getFullYear();
  }

  function getHashParams() {
    const raw = String(window.location.hash || "").replace(/^#/, "");
    return new URLSearchParams(raw);
  }

  function shouldAutoOpenBugModal() {
    const params = new URLSearchParams(window.location.search || "");
    const hashParams = getHashParams();
    const v = safeStr(
      params.get("OPEN_BUG") ||
      params.get("OPEN_ISSUE") ||
      params.get("OPEN_REPORT") ||
      hashParams.get("OPEN_BUG") ||
      hashParams.get("OPEN_ISSUE") ||
      hashParams.get("OPEN_REPORT") ||
      ""
    ).toLowerCase();
    return v === "1" || v === "true" || v === "yes" || v === "open";
  }

  function getNow() {
    return new Date();
  }

  function makeZonedDate(year, month, day, hour, minute) {
    const utc = new Date(Date.UTC(year, month - 1, day, hour, minute, 0));
    const asTz = new Date(utc.toLocaleString("en-US", { timeZone: TIMEZONE }));
    const offset = utc.getTime() - asTz.getTime();
    return new Date(utc.getTime() + offset);
  }

  function toTimeZoneDate(d) {
    if (!d || Number.isNaN(d.getTime())) return null;
    return new Date(d.toLocaleString("en-US", { timeZone: TIMEZONE }));
  }

  function addDays(d, days) {
    const out = new Date(d.getTime());
    out.setDate(out.getDate() + days);
    return out;
  }

  function getMemorialDay(year) {
    const d = new Date(year, 4, 31, 12, 0, 0, 0);
    const day = d.getDay();
    const offset = (day + 6) % 7;
    d.setDate(d.getDate() - offset);
    return d;
  }

  function getLastWeekdayOfMonth(year, monthIndex, weekday) {
    const d = new Date(year, monthIndex + 1, 0, 12, 0, 0, 0);
    const day = d.getDay();
    const offset = (day - weekday + 7) % 7;
    d.setDate(d.getDate() - offset);
    return d;
  }

  function getThanksgivingDate(year) {
    const first = new Date(year, 10, 1, 12, 0, 0, 0);
    const firstDay = first.getDay();
    const offset = (4 - firstDay + 7) % 7;
    first.setDate(first.getDate() + offset);
    first.setDate(first.getDate() + 21);
    return first;
  }

  function formatCountdown(diffMs) {
    if (!Number.isFinite(diffMs)) return "TBD";
    const totalSeconds = Math.floor(Math.abs(diffMs) / 1000);
    const days = Math.floor(totalSeconds / 86400);
    const hours = Math.floor((totalSeconds % 86400) / 3600);
    const mins = Math.floor((totalSeconds % 3600) / 60);
    const parts = [];
    if (days > 0) parts.push(`${days}d`);
    if (hours > 0) parts.push(`${hours}h`);
    parts.push(`${mins}m`);
    return parts.join(" ");
  }

  function formatDate(d) {
    if (!d || Number.isNaN(d.getTime())) return "TBD";
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: TIMEZONE,
      year: "numeric",
      month: "short",
      day: "2-digit",
      hour: "numeric",
      minute: "2-digit"
    });
    return `${fmt.format(d)} ET`;
  }

  function ymdInTz(d) {
    if (!d || Number.isNaN(d.getTime())) return "";
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: TIMEZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).formatToParts(d);
    const map = {};
    parts.forEach((p) => (map[p.type] = p.value));
    return `${map.year}-${map.month}-${map.day}`;
  }

  function getOverride(id, year) {
    const yearKey = String(year);
    const table = EVENT_OVERRIDES[yearKey];
    return table ? table[id] : null;
  }

  function resolveFixedDate(id, year, now, fallbackFn) {
    const override = getOverride(id, year);
    let date = override
      ? makeZonedDate(year, override.month, override.day, override.hour, override.minute)
      : fallbackFn(year);
    if (date && date.getTime() < now.getTime()) {
      const nextYear = year + 1;
      const nextOverride = getOverride(id, nextYear);
      date = nextOverride
        ? makeZonedDate(nextYear, nextOverride.month, nextOverride.day, nextOverride.hour, nextOverride.minute)
        : fallbackFn(nextYear);
    }
    return date;
  }

  function buildScheduleUrl(year) {
    return `${MFL_API_BASE}/${encodeURIComponent(year)}/export?TYPE=nflSchedule&W=ALL&JSON=1`;
  }

  function buildLeagueDetailsUrl(year, leagueId) {
    return `${MFL_API_BASE}/${encodeURIComponent(year)}/export?TYPE=league&L=${encodeURIComponent(leagueId)}&JSON=1`;
  }

  function extractLeagueWeeks(data) {
    if (!data) return null;
    const league = data.league || data.leagueDetails || data;
    if (!league || typeof league !== "object") return null;
    const endWeek = safeInt(league.end_week || league.endWeek || league.end_week_id || league.endWeekId);
    const lastRegular = safeInt(
      league.last_regular_season_week ||
        league.lastRegularSeasonWeek ||
        league.regular_season_end_week ||
        league.regularSeasonEndWeek
    );
    const franchiseNameById = extractFranchiseNameMap(league);
    return { endWeek, lastRegularWeek: lastRegular, franchiseNameById };
  }

  function extractFranchiseNameMap(league) {
    const block =
      (league && (league.franchises || league.franchise || (league.league && league.league.franchises))) ||
      null;
    const rowsRaw = (block && (block.franchise || block)) || [];
    const rows = Array.isArray(rowsRaw) ? rowsRaw : [rowsRaw].filter(Boolean);
    const out = {};
    rows.forEach((row) => {
      if (!row || typeof row !== "object") return;
      const idRaw = safeStr(
        row.id || row.franchise_id || row.franchiseId || row.franchiseID || ""
      ).replace(/\D/g, "");
      if (!idRaw) return;
      const id = idRaw.padStart(4, "0").slice(-4);
      const name = safeStr(row.name || row.franchise_name || row.franchiseName || row.owner_name || "");
      if (!name) return;
      out[id] = name;
    });
    return out;
  }

  function getFranchiseNameById(year, franchiseId) {
    const id = safeStr(franchiseId).replace(/\D/g, "").padStart(4, "0").slice(-4);
    if (!id) return "";
    const y = String(year || "");
    const cached = y ? state.leagueDetailsByYear[y] : null;
    const name =
      safeStr(cached && cached.franchiseNameById && cached.franchiseNameById[id]) ||
      "";
    if (name) return name;
    if (y && !state.leagueDetailsFetch[y]) fetchLeagueDetails(y, parseLeagueId());
    return "";
  }

  async function fetchLeagueDetails(year, leagueId) {
    const y = String(year);
    if (state.leagueDetailsFetch[y]) return;
    state.leagueDetailsFetch[y] = true;
    try {
      const res = await fetch(buildLeagueDetailsUrl(y, leagueId), { cache: "no-store" });
      if (!res.ok) throw new Error(`League HTTP ${res.status}`);
      const data = await res.json();
      const info = extractLeagueWeeks(data);
      state.leagueDetailsByYear[y] = info || {};
    } catch (e) {
      state.leagueDetailsByYear[y] = { error: e && e.message ? e.message : String(e) };
    } finally {
      updateDisplay();
      renderBugContextNote();
    }
  }

  function getLeagueWeekConfig(year, leagueId) {
    const y = String(year);
    const cached = state.leagueDetailsByYear[y];
    if (!cached && !state.leagueDetailsFetch[y]) fetchLeagueDetails(y, leagueId);
    return cached || null;
  }

  function parseKickoffToDate(val) {
    if (val === null || val === undefined) return null;
    const raw = String(val).trim();
    if (!raw) return null;
    if (/^\d+$/.test(raw)) {
      const n = Number(raw);
      if (!Number.isNaN(n)) {
        if (raw.length >= 13) return new Date(n);
        if (raw.length >= 10) return new Date(n * 1000);
      }
    }
    const t = raw.replace(" ", "T");
    const iso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(t) ? `${t}:00` : t;
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  function collectKickoffEntries(node, out) {
    if (!node) return;
    if (Array.isArray(node)) {
      node.forEach((item) => collectKickoffEntries(item, out));
      return;
    }
    if (typeof node !== "object") return;
    if (node.kickoff !== undefined) {
      const weekVal = safeInt(node.week || node.week_id || node.week_no || "");
      out.push({ week: weekVal, kickoff: node.kickoff });
    }
    Object.keys(node).forEach((k) => collectKickoffEntries(node[k], out));
  }

  function extractWeekKickoffs(scheduleData) {
    const entries = [];
    collectKickoffEntries(scheduleData, entries);
    const map = new Map();
    entries.forEach((entry) => {
      const week = safeInt(entry && entry.week);
      const kickoff = parseKickoffToDate(entry && entry.kickoff);
      if (!week || !kickoff || Number.isNaN(kickoff.getTime())) return;
      const existing = map.get(week);
      if (!existing || kickoff.getTime() < existing.getTime()) {
        map.set(week, kickoff);
      }
    });
    const out = Array.from(map.entries()).map(([week, kickoff]) => ({ week, kickoff }));
    out.sort((a, b) => a.week - b.week);
    return out;
  }

  function getScheduleMaxWeek(year) {
    const weeks = getWeekKickoffs(year);
    if (!weeks || !weeks.length) return 0;
    return weeks.reduce((max, entry) => Math.max(max, safeInt(entry && entry.week)), 0);
  }

  async function loadLocalSchedule(year) {
    const key = String(year);
    const inline = INLINE_SCHEDULES[key];
    if (inline) {
      return inline
        .map((item) => {
          const week = safeInt(item && item.week);
          const kickoff = parseKickoffToDate(item && item.kickoff);
          return week && kickoff ? { week, kickoff } : null;
        })
        .filter(Boolean)
        .sort((a, b) => a.week - b.week);
    }
    const manifestPath = LOCAL_SCHEDULE_MANIFEST[key];
    if (!manifestPath) return null;
    try {
      const res = await fetch(PUBLIC_ASSETS_BASE + manifestPath, { cache: "no-store" });
      if (!res.ok) throw new Error(`Local schedule HTTP ${res.status}`);
      const data = await res.json();
      if (!data || !Array.isArray(data.weekKickoffs)) return null;
      const parsed = data.weekKickoffs
        .map((item) => {
          const week = safeInt(item && item.week);
          const kickoff = parseKickoffToDate(item && item.kickoff);
          return week && kickoff ? { week, kickoff } : null;
        })
        .filter(Boolean)
        .sort((a, b) => a.week - b.week);
      return parsed.length ? parsed : null;
    } catch (e) {
      return null;
    }
  }

  async function applyScheduleFallback(year) {
    const y = String(year);
    const fallback = await loadLocalSchedule(year);
    if (fallback && fallback.length) {
      state.scheduleByYear[y] = { weekKickoffs: fallback };
      updateDisplay();
    }
  }

  async function fetchSchedule(year) {
    const y = String(year);
    if (state.scheduleFetch[y]) return;
    state.scheduleFetch[y] = true;
    try {
      const res = await fetch(buildScheduleUrl(y), { cache: "no-store" });
      if (!res.ok) throw new Error(`Schedule HTTP ${res.status}`);
      const data = await res.json();
      state.scheduleByYear[y] = { weekKickoffs: extractWeekKickoffs(data) };
    } catch (e) {
      state.scheduleByYear[y] = { weekKickoffs: [], error: e && e.message ? e.message : String(e) };
      applyScheduleFallback(year);
    } finally {
      updateDisplay();
    }
  }

  function getWeekKickoffs(year) {
    const y = String(year);
    const cached = state.scheduleByYear[y];
    if (cached && cached.weekKickoffs) return cached.weekKickoffs;

    // Try inline/local immediately
    const inline = INLINE_SCHEDULES[y];
    if (inline) {
      const parsed = inline
        .map((item) => {
          const week = safeInt(item && item.week);
          const kickoff = parseKickoffToDate(item && item.kickoff);
          return week && kickoff ? { week, kickoff } : null;
        })
        .filter(Boolean)
        .sort((a, b) => a.week - b.week);
      if (parsed.length) {
        state.scheduleByYear[y] = { weekKickoffs: parsed, inline: true };
        if (!state.scheduleFetch[y]) fetchSchedule(y); // still fetch live for freshness
        return parsed;
      }
    }

    if (!cached && !state.scheduleFetch[y]) fetchSchedule(y);
    return null;
  }

  function computeWeekStart(kickoffDate) {
    const local = toTimeZoneDate(kickoffDate);
    if (!local) return null;
    const day = local.getDay();
    const daysBack = (day - 2 + 7) % 7;
    local.setDate(local.getDate() - daysBack);
    local.setHours(0, 0, 0, 0);
    return local;
  }

  function resolveNextKickoffInfo(year, now) {
    const y = safeInt(year);
    const nowTz = toTimeZoneDate(now) || now;
    const tryYear = (yy) => {
      const weeks = getWeekKickoffs(yy);
      if (!weeks || !weeks.length) return null;
      const sorted = weeks.slice().sort((a, b) => a.kickoff.getTime() - b.kickoff.getTime());
      let candidate = null;
      sorted.forEach((w) => {
        if (!w || !w.kickoff || Number.isNaN(w.kickoff.getTime())) return;
        const start = computeWeekStart(w.kickoff);
        if (!start) return;
        if (start.getTime() <= nowTz.getTime()) candidate = w;
      });
      if (candidate) return { week: candidate.week, kickoff: candidate.kickoff, season: yy };
      return sorted[0] ? { week: sorted[0].week, kickoff: sorted[0].kickoff, season: yy } : null;
    };

    return tryYear(y) || tryYear(y + 1);
  }

  function resolveWeekKickoff(year, week) {
    const weeks = getWeekKickoffs(year);
    if (!weeks || !weeks.length) return null;
    const entry = weeks.find((w) => safeInt(w.week) === safeInt(week));
    return entry && entry.kickoff ? entry.kickoff : null;
  }

  function computePriorSunday(kickoffDate) {
    if (!kickoffDate || Number.isNaN(kickoffDate.getTime())) return null;
    const base = new Date(kickoffDate.getTime());
    base.setHours(12, 0, 0, 0);
    const day = base.getDay();
    const daysBack = day === 0 ? 7 : day;
    return addDays(base, -daysBack);
  }

  function resolveContractDeadline(year) {
    const weeks = getWeekKickoffs(year);
    if (!weeks || !weeks.length) return null;
    const week1 = weeks.find((w) => safeInt(w.week) === 1);
    if (!week1 || !week1.kickoff) return null;
    return computePriorSunday(week1.kickoff);
  }

  function resolveTradeDeadline(year) {
    const thanksgiving = getThanksgivingDate(year);
    const weeks = getWeekKickoffs(year);
    if (weeks && weeks.length) {
      const target = ymdInTz(thanksgiving);
      const match = weeks
        .map((w) => w.kickoff)
        .filter((d) => d && ymdInTz(d) === target)
        .sort((a, b) => a.getTime() - b.getTime())[0];
      if (match) return match;
    }
    return thanksgiving;
  }

  function resolveActiveSeasonYear(baseYear, now) {
    const currentYear = now.getFullYear();
    const seedYear = Math.max(baseYear, currentYear);
    const week1Seed = resolveWeekKickoff(seedYear, 1);
    if (week1Seed && week1Seed.getTime() >= now.getTime()) return seedYear;
    const week1Next = resolveWeekKickoff(seedYear + 1, 1);
    if (week1Next) return seedYear + 1;
    return seedYear;
  }

  function buildEvents() {
    const now = getNow();
    const baseYear = parseSeasonYear();
    const seasonYear = resolveActiveSeasonYear(baseYear, now);

    const faFallback = (year) => makeZonedDate(year, 7, getLastWeekdayOfMonth(year, 6, 6).getDate(), 12, 0);
    const scheduleMaxWeek = getScheduleMaxWeek(seasonYear);
    const fallbackRegularWeek = Math.max(
      1,
      scheduleMaxWeek ? Math.min(scheduleMaxWeek, DEFAULT_REGULAR_END_WEEK) : DEFAULT_REGULAR_END_WEEK
    );
    const fallbackPlayoffWeek = Math.max(
      fallbackRegularWeek + 1,
      scheduleMaxWeek ? Math.min(scheduleMaxWeek, DEFAULT_PLAYOFF_END_WEEK) : DEFAULT_PLAYOFF_END_WEEK
    );
    let regularWeek = fallbackRegularWeek;
    let endWeek = fallbackPlayoffWeek;
    regularWeek = Math.min(regularWeek, Math.max(1, endWeek - 1));
    endWeek = Math.max(endWeek, regularWeek + 1, fallbackPlayoffWeek);

    const events = [
      {
        id: "seasonStart",
        label: "Start of UPS Season",
        date: resolveFixedDate("seasonStart", seasonYear, now, (y) => makeZonedDate(y, 3, 1, 0, 0)),
        hint: "March 1"
      },
      {
        id: "ownersMeeting",
        label: "Annual Owner's Meeting",
        date: resolveFixedDate("ownersMeeting", seasonYear, now, (y) => makeZonedDate(y, 3, 19, 21, 0)),
        hint: "March 19, 9:00 PM ET"
      },
      {
        id: "expiringDeadline",
        label: "Expiring Rookie Extension/Tagged Player Deadline",
        date: resolveFixedDate("expiringDeadline", seasonYear, now, (y) => makeZonedDate(y, 4, 30, 12, 0)),
        hint: "Deadline time ET"
      },
      {
        id: "rookieDraft",
        label: "Rookie Draft",
        date: resolveFixedDate("rookieDraft", seasonYear, now, (y) => {
          const memorial = getMemorialDay(y);
          const draft = addDays(memorial, -1);
          draft.setHours(18, 30, 0, 0);
          return draft;
        }),
        hint: "Memorial Day weekend"
      },
      {
        id: "cutDeadline",
        label: "Deadline to Cut Players",
        date: resolveFixedDate("cutDeadline", seasonYear, now, (y) => {
          const fa = faFallback(y);
          return addDays(fa, -2);
        }),
        hint: "Offseason roster lock"
      },
      {
        id: "faAuction",
        label: "FA Auction",
        date: resolveFixedDate("faAuction", seasonYear, now, faFallback),
        hint: "Auction kickoff"
      }
    ];

    const kickoffInfo = resolveNextKickoffInfo(seasonYear, now);
    events.push({
      id: "contractDeadline",
      label: "Contract Deadline",
      date: resolveContractDeadline(seasonYear),
      hint: "Last Sunday before Week 1"
    });

    events.push({
      id: "weekKickoff",
      label: kickoffInfo && kickoffInfo.week ? `Week ${kickoffInfo.week} - NFL` : "Week 1 - NFL",
      date: kickoffInfo ? kickoffInfo.kickoff : null,
      hint: "Next kickoff (rolls Tuesday)"
    });

    events.push({
      id: "tradeDeadline",
      label: "Trade Deadline",
      date: resolveTradeDeadline(seasonYear),
      hint: "Thanksgiving kickoff"
    });

    events.push({
      id: "regularSeasonEnd",
      label: "End of UPS Regular Season",
      date: resolveWeekKickoff(seasonYear, regularWeek),
      hint: `Week ${regularWeek} kickoff`
    });

    const playoffEndKickoff = resolveWeekKickoff(seasonYear, endWeek);

    events.push({
      id: "playoffsEnd",
      label: "End of UPS Playoffs",
      date: playoffEndKickoff,
      hint: `Week ${endWeek} kickoff`
    });

    return { events, now };
  }

  function pickNextEventId(events, now) {
    const candidates = (events || []).filter((e) => e && e.date && !Number.isNaN(e.date.getTime()));
    candidates.sort((a, b) => a.date.getTime() - b.date.getTime());
    const next = candidates.find((e) => e.date.getTime() >= now.getTime());
    const pick = next || candidates[0] || events[0];
    return pick ? pick.id : "";
  }

  function syncSelection(events, now) {
    if (!state.selectedId) {
      state.selectedId = pickNextEventId(events, now);
      return;
    }
    const current = events.find((e) => e.id === state.selectedId);
    const hasValidDate = current && current.date && !Number.isNaN(current.date.getTime());
    const isManual = state.manualSelection;
    if (!hasValidDate) {
      if (!isManual) {
        state.selectedId = pickNextEventId(events, now);
        state.manualSelection = false;
      }
      return;
    }
    if (!isManual && current.date.getTime() < now.getTime()) {
      state.selectedId = pickNextEventId(events, now);
      state.manualSelection = false;
    }
  }

  function populateOptions(selectEl, events) {
    if (!selectEl) return;
    selectEl.innerHTML = "";
    (events || []).forEach((e) => {
      const opt = document.createElement("option");
      opt.value = e.id;
      opt.textContent = e.label;
      opt.selected = e.id === state.selectedId;
      selectEl.appendChild(opt);
    });
  }

  function updateDisplay() {
    const payload = buildEvents();
    const events = payload.events;
    const now = payload.now;
    syncSelection(events, now);

    const selectEl = $("#eventSelect");
    if (selectEl && !selectEl.options.length) {
      populateOptions(selectEl, events);
    }

    const current = events.find((e) => e.id === state.selectedId) || events[0];
    const dateText = current && current.date ? formatDate(current.date) : "TBD";
    const diffMs = current && current.date ? current.date.getTime() - now.getTime() : NaN;
    const rawCountdown = current && current.date ? formatCountdown(diffMs) : "TBD";
    const isPast = current && current.date && diffMs < 0;
    const countdownText = rawCountdown === "TBD" ? "TBD" : isPast ? `${rawCountdown} Ago` : rawCountdown;
    const primary = state.mode === "date" ? dateText : countdownText;
    const secondary = state.mode === "date" ? countdownText : dateText;

    const labelEl = $("#eventLabel");
    const valueEl = $("#eventValue");
    const hintEl = $("#eventHint");
    if (labelEl) labelEl.textContent = current ? current.label : "Event";
    if (valueEl) valueEl.textContent = primary;
    if (hintEl) {
      const parts = [];
      parts.push(`${state.mode === "date" ? "Countdown" : "Date"}: ${secondary}`);
      if (current && current.hint) parts.push(current.hint);
      hintEl.textContent = parts.join(" | ");
    }

    if (selectEl) {
      const option = selectEl.querySelector(`option[value="${state.selectedId}"]`);
      if (option && current && option.textContent !== current.label) option.textContent = current.label;
      if (selectEl.value !== state.selectedId) selectEl.value = state.selectedId;
    }
  }

  function getBugModuleOptions(appKey) {
    return BUG_MODULE_OPTIONS_BY_APP[safeStr(appKey).toLowerCase()] || BUG_MODULE_OPTIONS_BY_APP.other;
  }

  function getBugIssueTypeOptions(appKey) {
    return (
      BUG_ISSUE_TYPE_OPTIONS_BY_APP[safeStr(appKey).toLowerCase()] ||
      BUG_ISSUE_TYPE_OPTIONS_BY_APP.other
    );
  }

  function appHidesBugModule(appKey) {
    return BUG_HIDE_MODULE_FOR_APPS.has(safeStr(appKey).toLowerCase());
  }

  function updateBugModuleVisibility() {
    const appSel = $("#uowBugApp");
    const moduleWrap = $("#uowBugModuleWrap");
    const moduleSel = $("#uowBugModule");
    if (!appSel || !moduleSel || !moduleWrap) return;
    const hideModule = appHidesBugModule(appSel.value);
    moduleWrap.style.display = hideModule ? "none" : "";
    moduleSel.required = !hideModule;
    moduleSel.disabled = hideModule;
  }

  function populateBugModuleOptions() {
    const appSel = $("#uowBugApp");
    const moduleSel = $("#uowBugModule");
    if (!appSel || !moduleSel) return;
    if (appHidesBugModule(appSel.value)) {
      moduleSel.innerHTML = "";
      const hiddenOpt = document.createElement("option");
      hiddenOpt.value = "issue-type-driven";
      hiddenOpt.textContent = "Issue Type Driven";
      hiddenOpt.selected = true;
      moduleSel.appendChild(hiddenOpt);
      updateBugModuleVisibility();
      return;
    }
    const options = getBugModuleOptions(appSel.value);
    const prev = safeStr(moduleSel.value);
    moduleSel.innerHTML = "";
    options.forEach((opt, idx) => {
      const el = document.createElement("option");
      el.value = safeStr(opt.value);
      el.textContent = safeStr(opt.label);
      if (prev && prev === el.value) el.selected = true;
      if (!prev && idx === 0) el.selected = true;
      moduleSel.appendChild(el);
    });
    updateBugModuleVisibility();
  }

  function populateBugTypeOptions() {
    const appSel = $("#uowBugApp");
    const typeSel = $("#uowBugType");
    if (!appSel || !typeSel) return;
    const options = getBugIssueTypeOptions(appSel.value);
    const prev = safeStr(typeSel.value);
    typeSel.innerHTML = "";
    options.forEach((opt, idx) => {
      const el = document.createElement("option");
      el.value = safeStr(opt.value);
      el.textContent = safeStr(opt.label);
      if (prev && prev === el.value) el.selected = true;
      if (!prev && idx === 0) el.selected = true;
      typeSel.appendChild(el);
    });
  }

  function setBugStatus(message, tone) {
    const statusEl = $("#uowBugStatus");
    if (!statusEl) return;
    statusEl.textContent = safeStr(message);
    statusEl.classList.remove("is-error", "is-ok");
    if (tone === "error") statusEl.classList.add("is-error");
    if (tone === "ok") statusEl.classList.add("is-ok");
  }

  function setBugSubmitBusy(busy) {
    const submitBtn = $("#uowBugSubmit");
    if (submitBtn) {
      submitBtn.disabled = !!busy;
      submitBtn.textContent = busy ? "Submitting..." : "Submit Report";
    }
    state.bugBusy = !!busy;
  }

  function renderBugAttachmentList(message) {
    const listEl = $("#uowBugAttachmentList");
    if (!listEl) return;
    if (safeStr(message)) {
      listEl.textContent = safeStr(message);
      return;
    }
    if (!state.bugAttachments.length) {
      listEl.textContent = "No screenshots attached.";
      return;
    }
    const names = state.bugAttachments.map((a) => safeStr(a && a.name)).filter(Boolean);
    listEl.textContent = `${names.length} attached: ${names.join(", ")}`;
  }

  function resetBugAttachments() {
    state.bugAttachments = [];
    const input = $("#uowBugScreenshots");
    if (input) input.value = "";
    renderBugAttachmentList();
  }

  function loadImageFromObjectUrl(url) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("Image decode failed"));
      img.src = url;
    });
  }

  async function fileToScreenshotAttachment(file) {
    if (!file || !file.type || !file.type.startsWith("image/")) {
      throw new Error("Unsupported file type");
    }
    if (safeInt(file.size) > BUG_MAX_ATTACHMENT_FILE_BYTES) {
      throw new Error(`File too large (${Math.round(file.size / (1024 * 1024))}MB)`);
    }

    const objectUrl = URL.createObjectURL(file);
    try {
      const img = await loadImageFromObjectUrl(objectUrl);
      const maxDim = 1280;
      const ratio = Math.min(1, maxDim / Math.max(img.width || 1, img.height || 1));
      const width = Math.max(1, Math.round((img.width || 1) * ratio));
      const height = Math.max(1, Math.round((img.height || 1) * ratio));

      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("Canvas unavailable");
      ctx.drawImage(img, 0, 0, width, height);

      let quality = 0.82;
      let dataUrl = canvas.toDataURL("image/jpeg", quality);
      while (dataUrl.length > BUG_MAX_ATTACHMENT_DATA_URL_CHARS && quality > 0.45) {
        quality = Math.max(0.45, quality - 0.12);
        dataUrl = canvas.toDataURL("image/jpeg", quality);
      }
      if (dataUrl.length > BUG_MAX_ATTACHMENT_DATA_URL_CHARS) {
        throw new Error("Compressed image is still too large");
      }

      return {
        name: safeStr(file.name || "screenshot.jpg"),
        type: "image/jpeg",
        original_type: safeStr(file.type || ""),
        size_bytes: safeInt(file.size),
        data_url: dataUrl,
      };
    } finally {
      URL.revokeObjectURL(objectUrl);
    }
  }

  async function setBugAttachments(fileList) {
    const files = Array.from(fileList || []).slice(0, BUG_MAX_ATTACHMENTS);
    if (!files.length) {
      resetBugAttachments();
      return;
    }
    const out = [];
    const errors = [];
    for (const file of files) {
      try {
        const item = await fileToScreenshotAttachment(file);
        out.push(item);
      } catch (err) {
        errors.push(`${safeStr(file && file.name) || "file"}: ${err && err.message ? err.message : "failed"}`);
      }
    }
    state.bugAttachments = out;
    renderBugAttachmentList(
      errors.length
        ? `${out.length} attached. Skipped ${errors.length}: ${errors.join(" | ")}`
        : ""
    );
    if (!errors.length) renderBugAttachmentList();
  }

  function buildBugContext() {
    let href = "";
    try {
      href = window.location.href;
    } catch (e) {
      href = "";
    }
    const params = new URLSearchParams(window.location.search || "");
    const hashParams = getHashParams();
    const width = window.innerWidth || 0;
    const height = window.innerHeight || 0;
    let tz = "";
    try {
      tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "";
    } catch (e) {
      tz = "";
    }
    const season = String(parseSeasonYear() || "");
    const franchiseId = parseFranchiseId();
    const franchiseName = getFranchiseNameById(season, franchiseId);
    return {
      captured_at_utc: new Date().toISOString(),
      league_id: parseLeagueId(),
      season,
      franchise_id: franchiseId,
      franchise_name: franchiseName,
      mfl_user_id: parseMflUserId(),
      host: safeStr(window.location.host || ""),
      page_url: href,
      query_module: safeStr(params.get("MODULE") || params.get("module")),
      query_action: safeStr(params.get("ACTION") || params.get("action")),
      query_source_app: safeStr(
        params.get("SOURCE_APP") ||
        params.get("source_app") ||
        hashParams.get("SOURCE_APP") ||
        hashParams.get("source_app")
      ),
      ups_release_sha: safeStr(params.get("UPS_RELEASE_SHA") || params.get("SHA") || ""),
      user_agent: safeStr(navigator.userAgent || ""),
      platform: safeStr(navigator.platform || ""),
      language: safeStr(navigator.language || ""),
      timezone: tz,
      viewport: `${width}x${height}`,
      screen: `${safeInt(window.screen && window.screen.width)}x${safeInt(window.screen && window.screen.height)}`,
      theme: safeStr(document.body.getAttribute("data-theme") || state.theme || ""),
      referrer: safeStr(document.referrer || ""),
      screenshot_count: safeInt(state.bugAttachments && state.bugAttachments.length),
    };
  }

  function renderBugContextNote() {
    const note = $("#uowBugContextNote");
    if (!note) return;
    const ctx = buildBugContext();
    const franchiseLabel = safeStr(ctx.franchise_name || "Unknown");
    note.textContent = `Auto-attached: League ${ctx.league_id || "—"} | Season ${ctx.season || "—"} | Franchise ${franchiseLabel} | User ${ctx.mfl_user_id ? "Yes" : "Unknown"} | Theme ${ctx.theme || "—"}`;
  }

  function openBugModal() {
    const modal = $("#uowBugModal");
    if (!modal) return;
    modal.hidden = false;
    resetBugAttachments();
    populateBugModuleOptions();
    populateBugTypeOptions();
    renderBugContextNote();
    setBugStatus("", "");
    const summary = $("#uowBugSummary");
    if (summary) summary.focus();
  }

  function closeBugModal() {
    const modal = $("#uowBugModal");
    if (!modal) return;
    modal.hidden = true;
    setBugSubmitBusy(false);
    resetBugAttachments();
  }

  async function submitBugReportForm(e) {
    e.preventDefault();
    if (state.bugBusy) return;
    const appSel = $("#uowBugApp");
    const moduleSel = $("#uowBugModule");
    const typeSel = $("#uowBugType");
    const severitySel = $("#uowBugSeverity");
    const summaryInput = $("#uowBugSummary");
    const detailsInput = $("#uowBugDetails");
    const stepsInput = $("#uowBugSteps");
    const expectedActualInput = $("#uowBugExpectedActual");
    const hideModule = appHidesBugModule(appSel && appSel.value);
    const app = safeStr(appSel && appSel.value);
    const moduleName = hideModule ? "issue-type-driven" : safeStr(moduleSel && moduleSel.value);
    const issueType = safeStr(typeSel && typeSel.value);
    const severity = safeStr(severitySel && severitySel.value);
    const summary = safeStr(summaryInput && summaryInput.value);
    const details = safeStr(detailsInput && detailsInput.value);
    const steps = safeStr(stepsInput && stepsInput.value);
    const expectedActual = safeStr(expectedActualInput && expectedActualInput.value);

    if (!app || (!hideModule && !moduleName) || !issueType || !severity || !summary || !details) {
      setBugStatus("Please fill all required fields.", "error");
      return;
    }

    const ctx = buildBugContext();
    const workerBase = parseWorkerBaseUrl();
    const endpoint =
      `${workerBase}/bug-report?L=${encodeURIComponent(ctx.league_id || "")}` +
      `&YEAR=${encodeURIComponent(ctx.season || "")}`;

    const payload = {
      app,
      module: moduleName,
      issue_type: issueType,
      severity,
      franchise_name: safeStr(ctx.franchise_name || ""),
      summary,
      details,
      steps_to_reproduce: steps,
      expected_vs_actual: expectedActual,
      attachments: state.bugAttachments.map((item) => ({
        name: safeStr(item && item.name),
        type: safeStr(item && item.type),
        original_type: safeStr(item && item.original_type),
        size_bytes: safeInt(item && item.size_bytes),
        data_url: safeStr(item && item.data_url),
      })),
      context: ctx,
      source: "ups-hot-links-widget",
    };

    setBugSubmitBusy(true);
    setBugStatus("Submitting report...", "");
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      let out = {};
      try {
        out = await res.json();
      } catch (err) {
        out = {};
      }
      if (!res.ok || !out || out.ok === false) {
        const msg =
          safeStr(out && (out.error || out.reason || out.message)) ||
          `Report failed (HTTP ${res.status}).`;
        setBugStatus(msg, "error");
        return;
      }
      const bugId = safeStr(out.bug_id || out.report_id);
      const discordOk = out.notify && out.notify.ok ? "Discord sent" : "Discord pending";
      setBugStatus(`Submitted${bugId ? ` (${bugId})` : ""}. ${discordOk}.`, "ok");
      const form = $("#uowBugForm");
      if (form) form.reset();
      populateBugModuleOptions();
      populateBugTypeOptions();
      resetBugAttachments();
      renderBugContextNote();
      window.setTimeout(closeBugModal, 900);
    } catch (err) {
      setBugStatus(err && err.message ? err.message : "Failed to submit report.", "error");
    } finally {
      setBugSubmitBusy(false);
    }
  }

  function wireBugReportModal() {
    const openBtn = $("#uowBugBtn");
    const closeBtn = $("#uowBugClose");
    const cancelBtn = $("#uowBugCancel");
    const backdrop = $("#uowBugBackdrop");
    const appSel = $("#uowBugApp");
    const screenshotInput = $("#uowBugScreenshots");
    const form = $("#uowBugForm");
    if (openBtn) openBtn.addEventListener("click", openBugModal);
    if (closeBtn) closeBtn.addEventListener("click", closeBugModal);
    if (cancelBtn) cancelBtn.addEventListener("click", closeBugModal);
    if (backdrop) backdrop.addEventListener("click", closeBugModal);
    if (appSel) {
      appSel.addEventListener("change", () => {
        populateBugModuleOptions();
        populateBugTypeOptions();
        renderBugContextNote();
      });
    }
    if (screenshotInput) {
      screenshotInput.addEventListener("change", (evt) => {
        const files = evt && evt.target ? evt.target.files : null;
        setBugAttachments(files);
        renderBugContextNote();
      });
    }
    if (form) form.addEventListener("submit", submitBugReportForm);
    document.addEventListener("keydown", (evt) => {
      if (evt.key !== "Escape") return;
      const modal = $("#uowBugModal");
      if (modal && !modal.hidden) closeBugModal();
    });
    populateBugModuleOptions();
    populateBugTypeOptions();
    renderBugAttachmentList();
    renderBugContextNote();
  }

  function wireEvents() {
    const themeSelect = $("#themeSelect");
    if (themeSelect) {
      themeSelect.value = state.theme;
      themeSelect.addEventListener("change", (e) => {
        state.theme = normalizeThemeValue(e.target.value || "auto", true);
        saveThemeSetting(state.theme);
        applyThemeSetting(state.theme);
        notifyParentTheme(state.theme);
      });
    }

    const selectEl = $("#eventSelect");
    if (selectEl) {
      selectEl.addEventListener("change", (e) => {
        state.selectedId = String(e.target.value || "");
        state.manualSelection = true;
        updateDisplay();
      });
    }

    document.querySelectorAll("[data-mode]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const mode = btn.getAttribute("data-mode") === "date" ? "date" : "countdown";
        state.mode = mode;
        document.querySelectorAll("[data-mode]").forEach((el) => {
          el.classList.toggle("active", el.getAttribute("data-mode") === mode);
        });
        updateDisplay();
      });
    });

    wireBugReportModal();
  }

  function startTicker() {
    updateDisplay();
    window.setInterval(updateDisplay, 60000);
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) updateDisplay();
    });
  }

  function getDocHeight() {
    const body = document.body;
    const html = document.documentElement;
    const app = document.getElementById("uowApp");
    const appRect = app ? app.getBoundingClientRect() : null;
    const appBottom = appRect ? appRect.top + appRect.height + window.scrollY : 0;
    return Math.max(
      body ? body.scrollHeight : 0,
      body ? body.offsetHeight : 0,
      html ? html.clientHeight : 0,
      html ? html.scrollHeight : 0,
      html ? html.offsetHeight : 0,
      appBottom
    );
  }

  function startAutoHeightMessaging() {
    if (!window.parent || window.parent === window) return;
    let lastHeight = 0;
    let rafId = null;
    const send = () => {
      rafId = null;
      const height = Math.ceil(getDocHeight());
      if (!height || Math.abs(height - lastHeight) < 2) return;
      lastHeight = height;
      window.parent.postMessage({ type: "uow-height", height }, "*");
    };
    const schedule = () => {
      if (rafId !== null) return;
      rafId = window.requestAnimationFrame(send);
    };
    schedule();
    window.addEventListener("resize", schedule);
    window.addEventListener("load", schedule);
    document.addEventListener("visibilitychange", schedule);
    if ("ResizeObserver" in window) {
      const ro = new ResizeObserver(schedule);
      if (document.body) ro.observe(document.body);
      const app = document.getElementById("uowApp");
      if (app) ro.observe(app);
    } else {
      window.setInterval(schedule, 500);
    }
  }

  function init() {
    const parsedYear = parseSeasonYear();
    const year = Math.max(parsedYear, new Date().getFullYear());
    const leagueId = parseLeagueId();
    applyThemeSetting(state.theme);
    wireThemeListener();
    wireHostThemeMessages();
    notifyParentTheme(state.theme);
    applyScheduleFallback(year);
    applyScheduleFallback(year + 1);
    fetchSchedule(year);
    fetchSchedule(year + 1);
    fetchLeagueDetails(year, leagueId);
    fetchLeagueDetails(year + 1, leagueId);
    wireEvents();
    startTicker();
    startAutoHeightMessaging();
    if (shouldAutoOpenBugModal()) {
      window.setTimeout(openBugModal, 50);
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
