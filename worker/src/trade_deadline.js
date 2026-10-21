// worker/src/trade_deadline.js
// ─────────────────────────────────────────────────────────────────────────────
// WHEN MFL STOPS ACCEPTING TRADES — one resolver for every owner-facing
// deadline (Keith 2026-10-21: "every owner-facing deadline must show MFL's
// actual current enforcement time … the earliest active blocking event").
//
// MFL has no trade-deadline setting. Trading is stopped by League Calendar
// events of type TRADE ("No Trades Allowed"). Verified on test league 25625,
// 2026-10-21 (one TRADE event, START_TIME on the minute):
//   - 20 s before the start an accept executed the trade; proposals that reached
//     MFL inside the start second itself (MFL's clock 07:53:00) were accepted;
//   - from the next second (07:53:01) MFL refused every trade action through the API
//     — propose, accept, reject and revoke — with "Trades Are Not Allowed Now
//     According To Your League Calendar"; MFL's own trade page offered only
//     "reject completely";
//   - pending offers stay listed; trading reopens at the event's end (refused 2 s
//     before it, accepted 1 s after);
//   - a START_TIME that is a small number is an NFL WEEK: "13" is shown on the
//     calendar as "No Trades Allowed starts at" Week 13's first kickoff.
//
// So the deadline is the EARLIEST TRADE event that has not already ended. A
// week-numbered event is placed at that week's first kickoff (the caller passes
// nflWeekFirstKickoffUnix, the one implementation of "when does a week start").
//
// NO FAIL-OPEN. An empty calendar (what a failed login looks like) or a
// week-numbered event whose kickoff can't be read returns state "unresolved"
// with no time: callers say nothing rather than a time MFL may not honour. A
// calendar with events but no TRADE event still in force is "none".
// ─────────────────────────────────────────────────────────────────────────────

// MFL stores real instants as Unix seconds; anything this small is a week number.
const WEEK_NUMBER_MAX = 30;

const ET_PARTS = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});
const ET_LABEL = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
});

// Unix seconds → { date_et: "YYYY-MM-DD", time_et: "HH:MM", label: "Tue, Nov 24, 12:00 PM ET" }.
// The label is built from parts: some engines put " at " between date and time.
export function etParts(unix) {
  const d = new Date(Number(unix) * 1000);
  const p = {};
  for (const x of ET_PARTS.formatToParts(d)) p[x.type] = x.value;
  const q = {};
  for (const x of ET_LABEL.formatToParts(d)) q[x.type] = x.value;
  return {
    date_et: `${p.year}-${p.month}-${p.day}`,
    time_et: `${p.hour}:${p.minute}`,
    label: `${q.weekday}, ${q.month} ${q.day}, ${q.hour}:${q.minute} ${q.dayPeriod} ET`,
  };
}

// events: normalizeMflCalendar(...) rows. weekKickoff: { [week]: unix seconds, 0 = unreadable }.
export function mflTradeLock(events, { nowUnix, weekKickoff = {} } = {}) {
  const now = Number(nowUnix) || Math.floor(Date.now() / 1000);
  const all = Array.isArray(events) ? events : [];
  const out = { state: "unresolved", source: "mfl_calendar", start_unix: null, end_unix: null, event_id: "",
    date_et: "", time_et: "", label: "", events: [], reason: "" };
  if (!all.length) { out.reason = "calendar_has_no_events"; return out; }
  const trade = all.filter((e) => e && e.event_type === "TRADE");
  if (!trade.length) { out.state = "none"; out.reason = "no_trade_event_on_mfl_calendar"; return out; }
  const placed = [];
  for (const e of trade) {
    const raw = Number(e.start_unix) || 0;
    const week = raw > 0 && raw <= WEEK_NUMBER_MAX ? raw : null;
    const start = week ? Number(weekKickoff[week]) || 0 : raw;
    const end = Number(e.end_unix) || null;
    out.events.push({ id: String(e.id || ""), start_unix: start || null, end_unix: end, nfl_week: week });
    if (end && end <= now) continue;               // a blackout that already ended doesn't count
    if (!(start > 0)) { out.reason = week ? `week_${week}_kickoff_unreadable` : "trade_event_without_start"; return out; }
    placed.push({ id: String(e.id || ""), start, end });
  }
  out.events.sort((a, b) => (a.start_unix || 0) - (b.start_unix || 0));
  if (!placed.length) { out.state = "none"; out.reason = "every_trade_event_has_ended"; return out; }
  placed.sort((a, b) => a.start - b.start);
  const first = placed[0];
  const et = etParts(first.start);
  // MFL still accepts inside the start second and refuses from the next one.
  return { ...out, state: now > first.start ? "closed" : "upcoming", start_unix: first.start, end_unix: first.end,
    event_id: first.id, date_et: et.date_et, time_et: et.time_et, label: et.label, reason: "" };
}

// The week numbers a calendar's TRADE events refer to, so the caller looks up only those kickoffs.
export function tradeEventWeeks(events) {
  return [...new Set((Array.isArray(events) ? events : [])
    .filter((e) => e && e.event_type === "TRADE")
    .map((e) => Number(e.start_unix) || 0)
    .filter((n) => n > 0 && n <= WEEK_NUMBER_MAX))];
}
