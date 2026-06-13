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
//   "Think about it" → a single courtesy reminder on day 4, then silence.

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

function expiryDays(env) { return safeInt(env?.TRADE_DM_EXPIRY_DAYS, 7); }

// Returns {due?, message?, terminal?, reason?, advanceThinkStage?}. Pure — no
// DB / Discord. nowMs + env injected so it's deterministic/testable.
export function tradeReminderDecision(row, nowMs, env) {
  const createdMs = Date.parse(row.created_at_utc);
  if (!Number.isFinite(createdMs)) return { due: false };
  const lastMs = row.last_dm_utc ? Date.parse(row.last_dm_utc) : NaN;

  // Past MFL expiry → terminal (the offer no longer exists). No final DM.
  if (nowMs - createdMs >= expiryDays(env) * DAY_MS) return { terminal: true, reason: "expired" };

  // Thinking track: exactly one courtesy reminder on day 4 (or ~24h after the
  // press if it came on/after day 4), then silence.
  if (safeStr(row.track) === "thinking") {
    if (safeInt(row.think_stage, 0) >= 1) return { due: false };
    const pressedMs = row.think_pressed_utc ? Date.parse(row.think_pressed_utc) : createdMs;
    const day4Ms = createdMs + THINK_REMINDER_DAY * DAY_MS;
    const dueAtMs = Math.max(day4Ms, (Number.isFinite(pressedMs) ? pressedMs : createdMs) + 24 * HOUR_MS);
    if (nowMs >= dueAtMs) return { due: true, message: "think_reminder", advanceThinkStage: true };
    return { due: false };
  }

  // Main track: each entry fires once. Pick the LATEST qualifying entry (skip
  // missed catch-ups — send the most current message).
  let due = null;
  for (const e of MAIN_SCHEDULE) {
    const entryMs = createdMs + e.atHours * HOUR_MS;
    if (nowMs >= entryMs && (!Number.isFinite(lastMs) || lastMs < entryMs)) due = e;
  }
  if (!due) return { due: false };
  return { due: true, message: due.key };
}
