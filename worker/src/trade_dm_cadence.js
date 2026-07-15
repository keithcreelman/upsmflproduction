// trade_dm_cadence.js — PURE cadence logic for the trade-offer DM reminder
// engine. NO imports / NO I/O, so it's unit-testable in bare node (the rest of
// trade_dm.js pulls in the Discord/D1 import chain). trade_dm.js imports
// tradeReminderDecision from here.
//
// CADENCE (Keith 2026-06-13) — MFL expires a pending trade after
// TRADE_DM_EXPIRY_DAYS (default 7), so everything lives inside that window and
// every reminder states the expiry:
//   immediate (sent at enqueue) · +48h · day 3 · day 4 · day 5 · day 6
//   = 6 DMs over the 7-day life; nothing fires after expiry.
//   "Think about it" → suppress reminders until day 4, then resume the normal
//   once-a-day cadence (a nudge on day 4, then day 5 and day 6).

function safeStr(v) { return String(v == null ? "" : v).trim(); }
function safeInt(v, fb) { const n = parseInt(v, 10); return Number.isFinite(n) ? n : (fb == null ? 0 : fb); }

const DAY_MS = 86400000;
const HOUR_MS = 3600000;

// Reminder schedule as ELAPSED time from offer creation. The immediate DM is
// sent at enqueue; the cron owns these.
export const MAIN_SCHEDULE = [
  { atHours: 48,  key: "nudge" },      // +48h (day 2)
  { atHours: 72,  key: "nudge" },      // day 3
  { atHours: 96,  key: "nudge" },      // day 4
  { atHours: 120, key: "nudge" },      // day 5
  { atHours: 144, key: "last_call" },  // day 6 — last call before the day-7 expiry
];
// "Think about it" fires one courtesy reminder on this day (creation-anchored).
export const THINK_REMINDER_DAY = 4;

// Week-2 cadence for EXTENDED offers (the trade sentinel re-offers an expiring
// offer at ~day 6.5, giving it a 14-day effective life — Keith 2026-07-15:
// nudges "keep their escalating cadence as if nothing happened at day 7").
// Deliberately sparser than week 1: the recipient has already heard from us
// six times.
export const EXTENDED_TAIL = [
  { atHours: 192, key: "nudge" },      // day 8
  { atHours: 240, key: "nudge" },      // day 10
  { atHours: 312, key: "last_call" },  // day 13 — last call before the day-14 expiry
];

function expiryDays(env) { return safeInt(env?.TRADE_DM_EXPIRY_DAYS, 7); }

// An extended row lives 14 days; everything else keeps today's behavior
// exactly. The +144h entry demotes last_call → nudge when extended (day 6 is
// not the last call of a 14-day offer — that copy would be a lie).
function effectiveExpiryDays(row, env) {
  return safeInt(row?.extended, 0) === 1 ? 14 : expiryDays(env);
}
function scheduleFor(row) {
  if (safeInt(row?.extended, 0) !== 1) return MAIN_SCHEDULE;
  return MAIN_SCHEDULE
    .map((e) => (e.atHours === 144 ? { atHours: 144, key: "nudge" } : e))
    .concat(EXTENDED_TAIL);
}

// Returns {due?, message?, terminal?, reason?, advanceThinkStage?}. Pure — no
// DB / Discord. nowMs + env injected so it's deterministic/testable.
export function tradeReminderDecision(row, nowMs, env) {
  const createdMs = Date.parse(row.created_at_utc);
  if (!Number.isFinite(createdMs)) return { due: false };
  const lastMs = row.last_dm_utc ? Date.parse(row.last_dm_utc) : NaN;

  // Past MFL expiry → terminal (the offer no longer exists). No final DM.
  if (nowMs - createdMs >= effectiveExpiryDays(row, env) * DAY_MS) return { terminal: true, reason: "expired" };
  const schedule = scheduleFor(row);

  // Thinking track: suppress reminders before day 4, then resume the normal
  // once-a-day cadence — a "you wanted to sit on it" nudge on day 4, then the
  // standard day 5 / day 6 reminders. Same once-each dedup as the main track.
  if (safeStr(row.track) === "thinking") {
    const minHours = THINK_REMINDER_DAY * 24;
    let tdue = null;
    for (const e of schedule) {
      if (e.atHours < minHours) continue;
      const entryMs = createdMs + e.atHours * HOUR_MS;
      if (nowMs >= entryMs && (!Number.isFinite(lastMs) || lastMs < entryMs)) tdue = e;
    }
    if (!tdue) return { due: false };
    return { due: true, message: tdue.atHours === minHours ? "think_reminder" : tdue.key };
  }

  // Main track: each entry fires once. Pick the LATEST qualifying entry (skip
  // missed catch-ups — send the most current message).
  let due = null;
  for (const e of schedule) {
    const entryMs = createdMs + e.atHours * HOUR_MS;
    if (nowMs >= entryMs && (!Number.isFinite(lastMs) || lastMs < entryMs)) due = e;
  }
  if (!due) return { due: false };
  return { due: true, message: due.key };
}
