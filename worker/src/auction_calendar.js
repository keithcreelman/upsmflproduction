// auction_calendar.js — commish-editable LEAGUE CALENDAR config + the mappings
// that push those dates into (a) MFL's league calendar and (b) our D1
// league_events table (what the mobile app + FO + team_ops read). One config
// feeds both, so the calendar stays in sync everywhere.
//
// Stored in D1 ups_settings key 'auction_calendar' (kept for back-compat; the
// panel is "Update League Calendar"). Commish fills dates once per year;
// POST /admin/auction/push-mfl-calendar writes them out.
//
// MFL EVENT_TYPE vocabulary (verified against the LIVE calendar export):
//   TRADE          -> "Trade Deadline"
//   DRAFT_START    -> "Draft" (rookie draft)
//   AUCTION_START  -> "Auction" (START=open, END=close)
//   WAIVER_NONE    -> "No Add/Drops Allowed" (a start->end SPAN)
// calendarEvent import params: EVENT_TYPE, START_TIME (unix req), END_TIME (opt).
// NOTE: MFL's API can ADD calendar events but has NO delete/update — the D1
// side (league_events) is the idempotent one; MFL is add-with-skip.

function safeStr(v) { return String(v == null ? "" : v).trim(); }

// The dates the commish fills in. Each value is a wall-clock "YYYY-MM-DDTHH:mm"
// interpreted in America/New_York (ET) — no stored offset, DST-correct.
export const AUCTION_CAL_FIELDS = [
  { key: "trade_deadline_at", label: "Trade deadline",    help: "In-season trade deadline. → MFL TRADE event + app calendar." },
  { key: "rookie_draft_at",   label: "Rookie draft",      help: "Rookie draft start. → MFL DRAFT_START + app calendar." },
  { key: "era_open_at",       label: "ERA opens",         help: "Expired Rookie Auction opens. → MFL AUCTION_START + app calendar." },
  { key: "era_close_at",      label: "ERA closes",        help: "ERA close (optional). → the ERA AUCTION_START END_TIME." },
  { key: "faa_open_at",       label: "FA Auction opens",  help: "Free Agent Auction opens. → MFL AUCTION_START + a WAIVER_NONE (No Add/Drops) period + app calendar." },
  { key: "faa_close_at",      label: "FA Auction closes", help: "FA Auction close. → the AUCTION_START & No-Add/Drops END_TIME." },
];
const FIELD_KEYS = AUCTION_CAL_FIELDS.map((f) => f.key);

async function ensureTable(env) {
  await env.UPS_MFL_DB.prepare(
    "CREATE TABLE IF NOT EXISTS ups_settings (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)"
  ).run();
}

// Read the stored config: { season, faa: { <field>: "YYYY-MM-DDTHH:mm" | "" }, updated_at }.
// ('faa' is the historical sub-key name; it now holds the whole league timeline.)
export async function getAuctionCalendar(env) {
  const empty = { season: null, faa: Object.fromEntries(FIELD_KEYS.map((k) => [k, ""])), updated_at: null };
  if (!env || !env.UPS_MFL_DB) return empty;
  try {
    await ensureTable(env);
    const row = await env.UPS_MFL_DB.prepare("SELECT value, updated_at FROM ups_settings WHERE key='auction_calendar'").first();
    if (!row || !row.value) return empty;
    const cfg = JSON.parse(row.value);
    const faa = (cfg && cfg.faa && typeof cfg.faa === "object") ? cfg.faa : {};
    return {
      season: cfg && cfg.season != null ? cfg.season : null,
      faa: Object.fromEntries(FIELD_KEYS.map((k) => [k, safeStr(faa[k])])),
      updated_at: row.updated_at || null,
    };
  } catch (_) { return empty; }
}

// Merge + persist a partial update: { season?, faa?: { <field>: "YYYY-MM-DDTHH:mm" } }.
export async function setAuctionCalendar(env, partial) {
  if (!env || !env.UPS_MFL_DB) return { ok: false, error: "no_db" };
  const cur = await getAuctionCalendar(env);
  const next = { season: cur.season, faa: { ...cur.faa } };
  if (partial && partial.season != null && safeStr(partial.season)) next.season = safeStr(partial.season);
  const inFaa = (partial && partial.faa && typeof partial.faa === "object") ? partial.faa : {};
  for (const k of Object.keys(inFaa)) {
    if (FIELD_KEYS.indexOf(k) === -1) continue;
    next.faa[k] = safeStr(inFaa[k]);   // "" clears
  }
  try {
    await ensureTable(env);
    await env.UPS_MFL_DB.prepare(
      "INSERT INTO ups_settings (key, value, updated_at) VALUES ('auction_calendar', ?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at"
    ).bind(JSON.stringify(next), new Date().toISOString()).run();
    return { ok: true };
  } catch (e) { return { ok: false, error: e?.message || String(e) }; }
}

// Interpret a wall-clock "YYYY-MM-DDTHH:mm[:ss]" as America/New_York → unix SECONDS.
// DST-correct (resolves the offset at that instant).
export function etWallClockToUnix(wall, timeZone = "America/New_York") {
  const s = safeStr(wall);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(s)) return null;
  const withSec = s.length === 16 ? s + ":00" : s;
  const asUTC = Date.parse(withSec + "Z");
  if (isNaN(asUTC)) return null;
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone, hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const p = {};
  for (const part of dtf.formatToParts(new Date(asUTC))) p[part.type] = part.value;
  const hh = p.hour === "24" ? "00" : p.hour;
  const tzAsUTC = Date.parse(`${p.year}-${p.month}-${p.day}T${hh}:${p.minute}:${p.second}Z`);
  if (isNaN(tzAsUTC)) return null;
  const offsetMs = tzAsUTC - asUTC;
  return Math.round((asUTC - offsetMs) / 1000);
}

// ── MFL calendar events to write ────────────────────────────────────────────
// Returns { events: [...], missing: [...] }. Each event carries field,
// event_type, label, start/end (wall + unix), note. Unset dates are skipped
// (partial updates allowed) and reported in `missing`.
export function buildCalendarEvents(cfg) {
  const f = (cfg && cfg.faa) || {};
  const missing = [];
  const events = [];
  const val = (k, required) => { const v = safeStr(f[k]); if (!v && required) missing.push(k); return v; };
  const add = (field, event_type, startWall, endWall, label, note) => {
    if (!startWall) return;
    events.push({
      field, event_type, label,
      start_at: startWall, end_at: endWall || null,
      start_unix: etWallClockToUnix(startWall),
      end_unix: endWall ? etWallClockToUnix(endWall) : null,
      note,
    });
  };
  const trade = val("trade_deadline_at", true);
  const rookie = val("rookie_draft_at", true);
  const eraOpen = val("era_open_at", true);
  const eraClose = val("era_close_at", false);
  const faaOpen = val("faa_open_at", true);
  const faaClose = val("faa_close_at", true);

  add("trade_deadline_at", "TRADE", trade, null, "Trade deadline", "In-season trade deadline.");
  add("rookie_draft_at", "DRAFT_START", rookie, null, "Rookie draft", "Rookie draft start.");
  add("era_open_at", "AUCTION_START", eraOpen, eraClose, "ERA auction", "Expired Rookie Auction window.");
  add("faa_open_at", "AUCTION_START", faaOpen, faaClose, "FA Auction", "Free Agent Auction window.");
  add("faa_open_at", "WAIVER_NONE", faaOpen, faaClose, "FAA — No Add/Drops", "No add/drops during the FA Auction (start→close).");
  return { events, missing };
}

// ── D1 league_events rows (what the app reads via /api/league-events) ─────────
// Keyed by (event, nfl_season) → INSERT OR REPLACE is idempotent. Uses the
// EXISTING canonical UPS event keys (verified live in league_events) so this
// UPDATES the rows the app already renders instead of creating duplicates.
export function buildLeagueEventRows(cfg, seasonOverride) {
  const f = (cfg && cfg.faa) || {};
  const season = safeStr(seasonOverride) || safeStr(cfg && cfg.season) || String(new Date().getUTCFullYear());
  const rows = [];
  const dateOf = (wall) => { const s = safeStr(wall); return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null; };
  const add = (event, wall, description) => { const d = dateOf(wall); if (d) rows.push({ event, date: d, nfl_season: season, description }); };
  add("ups_trade_deadline", f.trade_deadline_at, "In-season trade deadline");
  add("ups_rookie_draft", f.rookie_draft_at, "Rookie draft");
  add("ups_expired_rookie_auction_start", f.era_open_at, "Expired Rookie Auction opens");
  add("ups_fa_auction_start", f.faa_open_at, "Free Agent Auction opens");
  return { rows, season };
}

// Normalize an MFL calendar export into [{event_type, title, start_unix, end_unix, id}].
export function normalizeMflCalendar(cal) {
  const root = (cal && cal.calendar) || cal || {};
  let evs = root && root.event;
  if (!evs) return [];
  if (!Array.isArray(evs)) evs = [evs];
  return evs.map((e) => ({
    id: safeStr(e && (e.id != null ? e.id : e.event_id)),
    event_type: safeStr(e && (e.type || e.event_type)).toUpperCase(),
    title: safeStr(e && (e.title || e.name)),
    start_unix: Number(e && (e.start_time || e.start)) || null,
    end_unix: Number(e && (e.end_time || e.end)) || null,
  })).filter((e) => e.event_type);
}
