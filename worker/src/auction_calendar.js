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
  { key: "faa_roster_lock_at", label: "Roster lock (no cuts)", help: "No add/drops from here until the auction ends — e.g. 3 days before open. → MFL WAIVER_NONE start + app 'last day for cuts' (the day before this instant)." },
  { key: "faa_open_at",       label: "FA Auction opens",  help: "Free Agent Auction opens. → MFL AUCTION_START + app calendar. (The No-Add/Drops period comes from Roster lock, NOT from this date.)" },
  { key: "faa_nom_deadline_at", label: "Last day to nominate", help: "Final nomination day (its ET day = unlimited noms; after it, no new noms — bidding continues). → app calendar + the in-app nomination gate." },
  { key: "faa_close_at",      label: "FA Auction ends",   help: "Auction fully resolved; roster lock lifts. → the AUCTION_START & No-Add/Drops END_TIME." },
  // Added 2026-08-05 so the reminder calendar has a single editable source. Both
  // are app-calendar + Discord-reminder only — MFL has no matching EVENT_TYPE, so
  // neither appears in buildCalendarEvents.
  { key: "rookie_ext_tag_deadline_at", label: "Rookie extension + tag deadline",
    help: "Expiring-rookie extensions and franchise tags close (league rule §A1). → app calendar + Discord reminders. Does NOT move the automated midnight auto-drop, which still follows the Memorial-Day rule." },
  { key: "contract_deadline_at", label: "Contract deadline",
    help: "⚠️ ENFORCED. Final-year veteran extensions + MYAC close (league rule §C4/§C2). → app calendar + Discord reminders AND the live lockout: past this instant, veteran extension / MYAC / restructure submissions are rejected. Changing it requires an explicit confirmation and is written to an audit log. Cannot be set to a date already past." },
];
const FIELD_KEYS = AUCTION_CAL_FIELDS.map((f) => f.key);

async function ensureTable(env) {
  await env.UPS_MFL_DB.prepare(
    "CREATE TABLE IF NOT EXISTS ups_settings (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)"
  ).run();
}

// ── LEAGUE SCOPING (2026-08-06) ─────────────────────────────────────────────
// The config used to live under ONE literal key, 'auction_calendar', for every
// league. The "Test league (25625)" toggle only ever changed the PUSH target, so
// there was no way to try a date change without editing the production calendar —
// and that calendar now enforces the veteran extension / MYAC lockout.
//
// Production keeps the LEGACY BARE KEY. That is deliberate: it means zero
// migration and zero risk to the row that gates real contract writes. Every other
// league gets 'auction_calendar:<leagueId>', which simply does not exist until
// something writes it, so a sandbox starts empty rather than inheriting prod.
export function productionLeagueId(env) {
  return safeStr((env && env.LEAGUE_ID) || "74598").replace(/\D/g, "") || "74598";
}

export function calendarSettingsKey(env, leagueId) {
  const want = safeStr(leagueId).replace(/\D/g, "");
  const prod = productionLeagueId(env);
  return (!want || want === prod) ? "auction_calendar" : `auction_calendar:${want}`;
}

// Read the stored config: { season, faa: { <field>: "YYYY-MM-DDTHH:mm" | "" }, updated_at }.
// ('faa' is the historical sub-key name; it now holds the whole league timeline.)
//
// LOSSLESS ROUND-TRIP (2026-08-05). This used to rebuild the object from a
// whitelist — season + faa only — so ANY other top-level key was silently dropped
// on read, and setAuctionCalendar then persisted that lossy copy. Adding a
// `reminders` block (or anything else) would have survived exactly until the next
// Save from the panel and then vanished, with no error anywhere. `extra` now
// carries every unrecognised top-level key straight back out to the writer.
// `leagueId` is OPTIONAL and defaults to the PRODUCTION league. That default is
// load-bearing: all thirteen existing readers — the contract-deadline gate, the
// nomination gate, the deadline-reminder overrides, the ERA close gate — are
// about the real league, so they must keep resolving to prod without being
// touched. Only surfaces that explicitly act on a chosen league (the settings
// save, the calendar push) pass one.
export async function getAuctionCalendar(env, leagueId) {
  const empty = {
    season: null,
    faa: Object.fromEntries(FIELD_KEYS.map((k) => [k, ""])),
    reminders: {},
    extra: {},
    updated_at: null,
  };
  // read_error DISTINGUISHES "could not read" FROM "nothing configured" (2026-08-05).
  //
  // This used to swallow every failure and return `empty`, which is byte-identical
  // to a never-configured league. That is a fail-OPEN read, and it bit for real:
  // D1 intermittently returns `exceeded its CPU time limit [code: 7429]`, and on
  // those ticks the contract-deadline save gate saw the CURRENT value as "" and
  // reported `before: null` — telling the commish a field was unset when it held
  // 2026-09-06T23:59, and comparing his new value against nothing.
  //
  // Callers that merely DISPLAY the calendar can keep ignoring read_error and use
  // the empty shape. Callers that GATE something must check it and refuse.
  // See rule_no_fail_open_guards.
  if (!env || !env.UPS_MFL_DB) return { ...empty, read_error: "no_d1_binding" };
  try {
    await ensureTable(env);
    const key = calendarSettingsKey(env, leagueId);
    const row = await env.UPS_MFL_DB.prepare("SELECT value, updated_at FROM ups_settings WHERE key=?").bind(key).first();
    if (!row || !row.value) return { ...empty, read_error: "", league_id: safeStr(leagueId) || productionLeagueId(env), settings_key: key };   // genuinely unset
    const cfg = JSON.parse(row.value);
    const faa = (cfg && cfg.faa && typeof cfg.faa === "object") ? cfg.faa : {};
    const reminders = (cfg && cfg.reminders && typeof cfg.reminders === "object") ? cfg.reminders : {};
    const extra = {};
    for (const k of Object.keys(cfg || {})) {
      if (k === "season" || k === "faa" || k === "reminders") continue;
      extra[k] = cfg[k];
    }
    return {
      season: cfg && cfg.season != null ? cfg.season : null,
      faa: Object.fromEntries(FIELD_KEYS.map((k) => [k, safeStr(faa[k])])),
      reminders,
      extra,
      updated_at: row.updated_at || null,
      read_error: "",
      league_id: safeStr(leagueId) || productionLeagueId(env),
      settings_key: key,
    };
  } catch (e) {
    return { ...empty, read_error: String((e && e.message) || e || "unknown_read_error") };
  }
}

// Merge + persist a partial update:
//   { season?, faa?: { <field>: "YYYY-MM-DDTHH:mm" }, reminders?: { <event_key>: {...} } }
// Unknown top-level keys already in the row are preserved verbatim (see `extra`).
export async function setAuctionCalendar(env, partial, leagueId) {
  if (!env || !env.UPS_MFL_DB) return { ok: false, error: "no_db" };
  const cur = await getAuctionCalendar(env, leagueId);
  // REFUSE TO WRITE ON AN UNREADABLE CURRENT CONFIG (2026-08-05).
  //
  // This is a read-modify-write: `next` is built by merging the partial onto
  // whatever the read returned. Before read_error existed, a transient D1 failure
  // (`exceeded its CPU time limit [code: 7429]`, observed live) made the read
  // return the EMPTY shape — so a save of one field would have merged onto blanks
  // and WIPED every other date in the league calendar. That is not hypothetical
  // damage: faa_nom_deadline_at fails OPEN (blanking it disables the auction
  // nomination gate) and faa_close_at gates ERA forced-retention cuts.
  //
  // A failed read is never "no existing config". Refuse; the caller retries.
  if (cur.read_error) {
    return { ok: false, error: `calendar_read_failed: ${cur.read_error}`, retryable: true };
  }
  const next = { ...cur.extra, season: cur.season, faa: { ...cur.faa }, reminders: { ...cur.reminders } };
  if (partial && partial.season != null && safeStr(partial.season)) next.season = safeStr(partial.season);
  const inFaa = (partial && partial.faa && typeof partial.faa === "object") ? partial.faa : {};
  for (const k of Object.keys(inFaa)) {
    if (FIELD_KEYS.indexOf(k) === -1) continue;
    next.faa[k] = safeStr(inFaa[k]);   // "" clears
  }
  // Reminder overrides merge PER EVENT rather than wholesale, so a panel that only
  // knows about one event cannot blank the others. `null` for an event clears it
  // (back to the hardcoded DEADLINE_REMINDER_CALENDAR default).
  const inRem = (partial && partial.reminders && typeof partial.reminders === "object") ? partial.reminders : {};
  for (const k of Object.keys(inRem)) {
    if (inRem[k] === null) { delete next.reminders[k]; continue; }
    if (typeof inRem[k] !== "object") continue;
    next.reminders[k] = { ...(next.reminders[k] || {}), ...inRem[k] };
  }
  if (!Object.keys(next.reminders).length) delete next.reminders;
  try {
    await ensureTable(env);
    const key = calendarSettingsKey(env, leagueId);
    await env.UPS_MFL_DB.prepare(
      "INSERT INTO ups_settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at"
    ).bind(key, JSON.stringify(next), new Date().toISOString()).run();
    return { ok: true, settings_key: key, league_id: safeStr(leagueId) || productionLeagueId(env) };
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
  const rosterLock = val("faa_roster_lock_at", false);
  const faaOpen = val("faa_open_at", true);
  const faaClose = val("faa_close_at", true);

  add("trade_deadline_at", "TRADE", trade, null, "Trade deadline", "In-season trade deadline.");
  add("rookie_draft_at", "DRAFT_START", rookie, null, "Rookie draft", "Rookie draft start.");
  add("era_open_at", "AUCTION_START", eraOpen, eraClose, "ERA auction", "Expired Rookie Auction window.");
  add("faa_open_at", "AUCTION_START", faaOpen, faaClose, "FA Auction", "Free Agent Auction window.");
  // The no-add/drops lockout starts at the ROSTER LOCK (e.g. 3 days before the
  // auction opens — the league rule), not at auction open. Fall back to
  // faa_open_at only when the lock field is unset, preserving the pre-2026
  // shape for old configs.
  add("faa_roster_lock_at", "WAIVER_NONE", rosterLock || faaOpen, faaClose, "FAA — No Add/Drops", "No add/drops from roster lock through auction end.");
  return { events, missing };
}

// The last CALENDAR DAY on which cuts are still allowed, from the lock wall
// time: a midnight lock means yesterday was the last day; any intra-day lock
// means cuts were possible earlier that same day. Pure civil-date arithmetic
// on the ET wall string — no instants, so DST can't bite.
function lastCutDayFromLock(lockWall) {
  const s = safeStr(lockWall);
  const m = s.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})/);
  if (!m) return null;
  if (m[2] !== "00" || m[3] !== "00") return m[1];
  const d = new Date(m[1] + "T00:00:00Z");
  if (isNaN(d.getTime())) return null;
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
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
  add("ups_faa_nom_deadline", f.faa_nom_deadline_at, "Last day to nominate — unlimited noms this day; bidding continues after");
  // Added 2026-08-05. These keys ALREADY EXIST in league_events (seeded by
  // migration 0026), so this updates the rows the app renders rather than adding
  // new ones. ups_tag_deadline and ups_rookieextension_deadline are the same
  // instant in canon (Thursday before Memorial Day) and are written from one field.
  add("ups_rookieextension_deadline", f.rookie_ext_tag_deadline_at, "Expiring rookie extensions close");
  add("ups_tag_deadline", f.rookie_ext_tag_deadline_at, "Franchise tag deadline — same instant as the rookie extension deadline");
  add("ups_contract_deadline", f.contract_deadline_at, "Final-year veteran extensions + MYAC close");
  // Replaces the migration-0026 hardcoded placeholder: derived from the actual
  // roster-lock instant, so the app's "Roster Cutdown" chip tracks the config.
  const lastCut = lastCutDayFromLock(f.faa_roster_lock_at);
  if (lastCut) rows.push({ event: "ups_last_day_for_cuts", date: lastCut, nfl_season: season, description: "Auction Roster Lock — last day for cuts before the FA Auction" });
  return { rows, season };
}

// ── Discord deadline-reminder overrides ─────────────────────────────────────
// Which editable field supplies which reminder event_key. Only these six reminder
// events have a calendar field; anything else in DEADLINE_REMINDER_CALENDAR keeps
// its hardcoded values.
export const REMINDER_FIELD_MAP = {
  rookie_ext_tag_deadline_at: "rookie_extensions_and_tags",
  rookie_draft_at:            "rookie_draft",
  faa_roster_lock_at:         "cut_deadline",
  faa_open_at:                "free_agent_auction",
  contract_deadline_at:       "contract_deadline",
  trade_deadline_at:          "trade_deadline",
};

// Build the `overrides` argument for deadlineReminderCatalogForSeason(season, …)
// from the stored calendar config. Returns {} when nothing applies, which makes
// the caller fall back to the hardcoded DEADLINE_REMINDER_CALENDAR wholesale.
//
// SEASON GUARD: the ups_settings row holds exactly ONE season and is not keyed by
// it, so applying a 2026 config to a 2027 sweep would silently send reminders for
// last year's dates. When cfg.season is set and does not match, return {} — the
// hardcoded calendar is stale-but-honest, whereas a mismatched config is wrong.
// A config with NO season is treated as applying to the requested season, which
// preserves behaviour for rows written before `season` was populated.
export function deadlineOverridesFromCalendar(cfg, season) {
  const out = {};
  if (!cfg || typeof cfg !== "object") return out;
  const cfgSeason = safeStr(cfg.season);
  if (cfgSeason && cfgSeason !== safeStr(season)) return out;
  const f = (cfg.faa && typeof cfg.faa === "object") ? cfg.faa : {};
  const rem = (cfg.reminders && typeof cfg.reminders === "object") ? cfg.reminders : {};

  for (const [fieldKey, eventKey] of Object.entries(REMINDER_FIELD_MAP)) {
    const wall = safeStr(f[fieldKey]);
    const m = wall.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/);
    if (!m) continue;                       // unset or malformed -> hardcoded default
    out[eventKey] = { deadline_date_et: m[1], deadline_time_et: m[2] };
  }
  // Sparse per-event reminder tuning (summary / send time / offsets). Merged on top
  // of the dates above, and allowed even for events whose date is not set here.
  for (const [eventKey, patch] of Object.entries(rem)) {
    if (!patch || typeof patch !== "object") continue;
    const clean = {};
    if (safeStr(patch.summary)) clean.summary = safeStr(patch.summary);
    if (/^\d{2}:\d{2}$/.test(safeStr(patch.reminder_send_time_et))) clean.reminder_send_time_et = safeStr(patch.reminder_send_time_et);
    if (Array.isArray(patch.reminder_offsets_days)) {
      clean.reminder_offsets_days = patch.reminder_offsets_days.map((v) => Number(v) || 0).filter((v) => v > 0);
    }
    if (Array.isArray(patch.reminder_offsets_hours)) {
      clean.reminder_offsets_hours = patch.reminder_offsets_hours.map((v) => Number(v) || 0).filter((v) => v > 0);
    }
    if (Object.keys(clean).length) out[eventKey] = { ...(out[eventKey] || {}), ...clean };
  }
  return out;
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
