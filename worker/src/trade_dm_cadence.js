// trade_dm_cadence.js — PURE cadence logic for the trade-offer DM reminder
// engine. NO imports / NO I/O, so it's unit-testable in bare node (the rest of
// trade_dm.js pulls in the Discord/D1 import chain). trade_dm.js imports
// tradeReminderDecision + THINK_INTERVALS_HOURS from here. See migration 0076
// and the plan for the cadence spec.

function safeStr(v) { return String(v == null ? "" : v).trim(); }
function safeInt(v, fb) { const n = parseInt(v, 10); return Number.isFinite(n) ? n : (fb == null ? 0 : fb); }

const DAY_MS = 86400000;
const HOUR_MS = 3600000;

// Main-track schedule (anchor = created_at_utc, day 1 = creation instant). The
// Day-1 DM is sent at enqueue; the cron owns days 3+. Tone escalates to a final
// "rip 'em" at day 11, which is terminal (stop reminding).
export const MAIN_SCHEDULE = [
  { day: 3, key: "gentle_1" },
  { day: 5, key: "gentle_2" },
  { day: 6, key: "checking_in" },
  { day: 7, key: "just_decline" },
  { day: 8, key: "just_decline" },
  { day: 9, key: "just_decline" },
  { day: 10, key: "just_decline" },
  { day: 11, key: "rip_them", terminal: true },
];
// Thinking sub-cadence (after the recipient presses "Think about it"): +5 days,
// then +48h, +48h, +24h, then every 24h thereafter, until resolved or capped.
export const THINK_INTERVALS_HOURS = [120, 48, 48, 24];
export const THINK_TAIL_HOURS = 24;

function thinkCapDays(env) { return safeInt(env?.TRADE_DM_THINK_CAP_DAYS, 14); }
function hardAgeCapDays(env) { return safeInt(env?.TRADE_DM_HARD_AGE_CAP_DAYS, 21); }

// Returns {due?, message?, terminal?, reason?, advanceThinkStage?}. Pure — no
// DB / Discord. nowMs + env injected so it's fully deterministic/testable.
export function tradeReminderDecision(row, nowMs, env) {
  const createdMs = Date.parse(row.created_at_utc);
  const lastMs = row.last_dm_utc ? Date.parse(row.last_dm_utc) : NaN;
  // Hard age cap (both tracks) — absolute anti-spam ceiling.
  if (Number.isFinite(createdMs) && nowMs - createdMs >= hardAgeCapDays(env) * DAY_MS) {
    return { terminal: true, reason: "age_cap" };
  }
  if (safeStr(row.track) === "thinking") {
    const pressedMs = row.think_pressed_utc ? Date.parse(row.think_pressed_utc) : createdMs;
    if (Number.isFinite(pressedMs) && nowMs - pressedMs >= thinkCapDays(env) * DAY_MS) {
      return { terminal: true, reason: "think_cap", message: "think_final" };
    }
    const stage = safeInt(row.think_stage, 0);
    const intervalH = stage < THINK_INTERVALS_HOURS.length ? THINK_INTERVALS_HOURS[stage] : THINK_TAIL_HOURS;
    // stage 0 anchors off the press; later stages off the last reminder.
    const refMs = stage > 0 && Number.isFinite(lastMs) ? lastMs : pressedMs;
    if (Number.isFinite(refMs) && nowMs - refMs >= intervalH * HOUR_MS) {
      return { due: true, message: "think_reminder", advanceThinkStage: true };
    }
    return { due: false };
  }
  // Main track: each scheduled entry fires exactly once. An entry is due iff its
  // scheduled time has passed AND no DM went out at/after that time. Pick the
  // LATEST qualifying entry (skip missed catch-ups; send the current message).
  if (!Number.isFinite(createdMs)) return { due: false };
  let due = null;
  for (const e of MAIN_SCHEDULE) {
    const entryMs = createdMs + (e.day - 1) * DAY_MS; // day 1 = creation instant
    if (nowMs >= entryMs && (!Number.isFinite(lastMs) || lastMs < entryMs)) due = e;
  }
  if (!due) return { due: false };
  if (due.terminal) return { due: true, terminal: true, message: due.key, reason: "day11_terminal" };
  return { due: true, message: due.key };
}
