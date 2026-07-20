// auction_windows.js — FA-Auction nomination window math.
//
// §A2 (commish, 2026-07-14): a franchise nominates EXACTLY 2 players per
// window. 2 is both a MINIMUM (missing them carries an escalating fine) and
// a MAXIMUM (a 3rd nomination in the same window is blocked).
//
// A window is an ET CALENDAR DAY — midnight → midnight America/New_York.
// Anchoring on the civil day makes Day 1 self-clipping: when the auction
// opens 12 PM ET there simply are no nominations before noon, so the short
// first day needs no branch of its own. The boundary is midnight either way.
//
// Two things this deliberately does NOT do:
//   • assume a window is 86400s. ET days are 23h / 24h / 25h across the DST
//     flips, so any *_SEC constant would be a lie. Callers that need the
//     length compute end_unix - start_unix.
//   • hand-roll a UTC-5/-4 offset. etWallClockToUnix resolves the offset via
//     Intl at that instant. ET DST flips at 2 AM, never midnight, so a day
//     boundary is always unambiguous — no skipped/doubled midnight exists.

import { etWallClockToUnix } from "./auction_calendar.js";

// Both are 2 today. They stay separate because they encode two DIFFERENT
// rules with different trigger conditions: the floor is waived once a
// franchise can field a legal lineup, the ceiling never is. Collapsing them
// into one constant is what produced the old FA_MAX_IN_WINDOW misnomer — a
// constant named MAX that was only ever read as a floor.
export const FAA_NOMS_REQUIRED = 2;
export const FAA_NOMS_MAX = 2;

export const ET_TZ = "America/New_York";

const _etDayFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: ET_TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

// unix seconds → the ET calendar day that instant falls in, "YYYY-MM-DD".
export function etDayKey(unixSec) {
  const n = Number(unixSec);
  if (!isFinite(n)) return "";
  const p = {};
  for (const part of _etDayFmt.formatToParts(new Date(n * 1000))) p[part.type] = part.value;
  if (!p.year || !p.month || !p.day) return "";
  return `${p.year}-${p.month}-${p.day}`;
}

// "YYYY-MM-DD" → the next calendar day. Stepped in UTC purely as date
// arithmetic on a civil date; no instant is implied, so DST can't bite.
export function etNextDayKey(dayKey) {
  const s = String(dayKey || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return "";
  const d = new Date(s + "T00:00:00Z");
  if (isNaN(d.getTime())) return "";
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

// Half-open [start_unix, end_unix) bounds of one ET calendar day.
export function etDayBounds(dayKey) {
  const key = String(dayKey || "");
  const next = etNextDayKey(key);
  if (!next) return null;
  const start_unix = etWallClockToUnix(key + "T00:00");
  const end_unix = etWallClockToUnix(next + "T00:00");
  if (start_unix == null || end_unix == null) return null;
  return { window_key: key, start_unix, end_unix };
}

// The window containing `unixSec` (default: now).
export function faaWindowAt(unixSec) {
  const at = Number.isFinite(Number(unixSec)) ? Number(unixSec) : Math.floor(Date.now() / 1000);
  const key = etDayKey(at);
  return key ? etDayBounds(key) : null;
}

// ── Nomination schedule (§A2 + commish 2026-07-20) ─────────────────────────
// The auction has a LAST DAY TO NOMINATE (2026: Tue 8/3), configured as
// auction_calendar.faa_nom_deadline_at. Three phases, keyed on ET days:
//   regular   — before the final day: the 2/day floor+ceiling applies.
//   final_day — the deadline's own ET day: the CEILING is waived ("the 2
//               nomination rule gets thrown out the door") so a franchise can
//               nominate as many as it takes to fill its roster. The floor
//               (and its fine) still applies to franchises with illegal rosters.
//   closed    — after the final day: no NEW nominations. Bidding on open lots
//               continues untouched — an overtaken bidder may re-bid until the
//               lot's own clock awards it.
// Unset/invalid deadline ⇒ { configured:false, phase:"regular" } — the
// pre-2026 behavior, so nothing changes until the commish fills the field.
export function faaNomSchedule(nomDeadlineWall, nowUnix) {
  const now = Number.isFinite(Number(nowUnix)) ? Number(nowUnix) : Math.floor(Date.now() / 1000);
  const dl = etWallClockToUnix(String(nomDeadlineWall || ""));
  if (dl == null) return { configured: false, phase: "regular", final_day_key: "", deadline_unix: null };
  const finalKey = etDayKey(dl);
  const nowKey = etDayKey(now);
  // "YYYY-MM-DD" compares correctly as a string.
  const phase = nowKey < finalKey ? "regular" : nowKey === finalKey ? "final_day" : "closed";
  return { configured: true, phase, final_day_key: finalKey, deadline_unix: dl };
}

// Per-franchise window state from an already-day-scoped nomination COUNT.
// `roster_met` waives the FLOOR only — over_cap is unconditional.
//
// A count, not a timestamp list, on purpose: the number that matters is the one
// the write gate enforces on — live MFL AUCTION_INIT ∪ ups_auction_bids ∪
// in-flight slot claims, deduped by player_id (see faaNomPidsByFidForDay). That
// union has no timestamps to filter, and a read surface that recounts from a
// narrower source is how the tracker ends up saying "0/2 · Owes 2" at the same
// moment the API 409s the owner's 3rd nomination.
export function faaWindowStateFromCount(usedCount, opts = {}) {
  const now = Number.isFinite(Number(opts.nowUnix)) ? Number(opts.nowUnix) : Math.floor(Date.now() / 1000);
  const win = faaWindowAt(now);
  const used = Math.max(0, Number(usedCount) || 0);
  const roster_met = !!opts.rosterMet;
  // opts.nomPhase: "regular" (default) | "final_day" | "closed" — from
  // faaNomSchedule. final_day waives the ceiling; closed blocks nominations
  // entirely. Numeric fields keep their regular-day values so existing UI
  // math never sees a null; consumers key off the flags.
  const phase = opts.nomPhase === "final_day" || opts.nomPhase === "closed" ? opts.nomPhase : "regular";
  const unlimitedToday = phase === "final_day";
  const nomsClosed = phase === "closed";
  return {
    window_key: win ? win.window_key : "",
    window_start_unix: win ? win.start_unix : 0,
    window_end_unix: win ? win.end_unix : 0,
    // 23h/24h/25h — computed, never assumed.
    window_sec: win ? win.end_unix - win.start_unix : 0,
    noms_used: used,
    noms_required: FAA_NOMS_REQUIRED,
    noms_max: FAA_NOMS_MAX,
    noms_remaining: nomsClosed ? 0 : Math.max(0, FAA_NOMS_REQUIRED - used),
    // Keys off the CEILING so it stays right if floor and ceiling diverge.
    can_nominate_now: nomsClosed ? false : (unlimitedToday || used < FAA_NOMS_MAX),
    over_cap: !unlimitedToday && !nomsClosed && used > FAA_NOMS_MAX,
    owes_noms: !nomsClosed && !roster_met && used < FAA_NOMS_REQUIRED,
    nom_phase: phase,
    unlimited_today: unlimitedToday,
    noms_closed: nomsClosed,
    // Anchored: every franchise resets at the same ET midnight.
    next_window_start_unix: win ? win.end_unix : now,
    seconds_until_reset: win ? Math.max(0, win.end_unix - now) : 0,
  };
}
