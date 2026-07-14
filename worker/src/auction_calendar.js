// auction_calendar.js — commish-editable FA-Auction date config + the mapping
// that pushes those dates into MFL's league calendar.
//
// Stored in D1 ups_settings key 'auction_calendar' (same store/pattern as
// feature_flags.js). The commish fills the dates in once per year from the
// Commish Settings → Auction Calendar panel; POST /admin/auction/push-mfl-calendar
// then writes them to MFL via import?TYPE=calendarEvent (a real, commissioner-
// authed MFL write — verified against MFL's live api_info).
//
// MFL EVENT_TYPE vocabulary (from api_info): AUCTION_START, WAIVER_LOCK,
// WAIVER_UNLOCK, DRAFT_START, TRADE, WAIVER_REVERSE, WAIVER_BBID, CUSTOM.
// calendarEvent params: EVENT_TYPE, START_TIME (unix, req), END_TIME (unix, opt).
//
// Auction *rules* (cap/roster/format) are NOT API-settable — MFL exposes those
// read-only. They stay a one-time Commissioner-Setup task; see
// docs/auction/mfl_auction_setup_runbook.md.

function safeStr(v) { return String(v == null ? "" : v).trim(); }

// The dates the commish fills in. Each value is a wall-clock datetime string
// "YYYY-MM-DDTHH:mm" interpreted in America/New_York (the league runs on ET) —
// no stored offset, so it stays correct across DST without the commish thinking
// about it. Keith 2026-07-13: only the auction START and CLOSE are needed (no
// roster-cut / waiver-lock) — written to MFL as one AUCTION_START event whose
// START_TIME is the open and END_TIME is the close.
export const AUCTION_CAL_FIELDS = [
  { key: "auction_open_at",  label: "Auction opens",  help: "FA Auction opens (Day-1 kickoff). Written to MFL as the AUCTION_START event." },
  { key: "auction_close_at", label: "Auction closes", help: "Target close of the FA Auction. Written as the AUCTION_START event's END_TIME." },
];
const FIELD_KEYS = AUCTION_CAL_FIELDS.map((f) => f.key);

async function ensureTable(env) {
  await env.UPS_MFL_DB.prepare(
    "CREATE TABLE IF NOT EXISTS ups_settings (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)"
  ).run();
}

// Read the stored config: { season, faa: { <field>: "YYYY-MM-DDTHH:mm" | "" }, updated_at }.
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
// Only known fields are kept. Empty string clears a field.
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

// Interpret a wall-clock "YYYY-MM-DDTHH:mm[:ss]" string as America/New_York and
// return unix SECONDS. DST-correct (resolves the offset at that instant), so a
// late-July date lands on EDT and a November date on EST automatically.
export function etWallClockToUnix(wall, timeZone = "America/New_York") {
  const s = safeStr(wall);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(s)) return null;
  const withSec = s.length === 16 ? s + ":00" : s;
  const asUTC = Date.parse(withSec + "Z");        // pretend the wall-clock is UTC
  if (isNaN(asUTC)) return null;
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone, hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const p = {};
  for (const part of dtf.formatToParts(new Date(asUTC))) p[part.type] = part.value;
  const hh = p.hour === "24" ? "00" : p.hour;      // Intl can emit 24 at midnight
  const tzAsUTC = Date.parse(`${p.year}-${p.month}-${p.day}T${hh}:${p.minute}:${p.second}Z`);
  if (isNaN(tzAsUTC)) return null;
  const offsetMs = tzAsUTC - asUTC;                // how far ahead of UTC the tz is at that wall time
  return Math.round((asUTC - offsetMs) / 1000);
}

// Map the stored auction open/close to the MFL calendar event to write.
// Returns { events: [...], missing: [...fieldKeys with no date] }. Each event:
//   { field, event_type, label, start_at (iso in), start_unix, end_unix|null, note }
//   auction_open_at (+ auction_close_at) -> AUCTION_START (START=open, END=close)
export function buildCalendarEvents(cfg) {
  const faa = (cfg && cfg.faa) || {};
  const missing = [];
  const open = safeStr(faa.auction_open_at);
  const close = safeStr(faa.auction_close_at);
  if (!open) missing.push("auction_open_at");
  if (!close) missing.push("auction_close_at");
  const events = [];
  if (open) {
    events.push({
      field: "auction_open_at", event_type: "AUCTION_START",
      label: "Auction window",
      start_at: open, end_at: close || null,
      start_unix: etWallClockToUnix(open),
      end_unix: close ? etWallClockToUnix(close) : null,
      note: close ? "FA Auction window: opens at START_TIME, closes at END_TIME." : "FA Auction opens (no close date set).",
    });
  }
  return { events, missing };
}
