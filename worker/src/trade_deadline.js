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
//   - a START_TIME that is a small number is an NFL WEEK: "12" is MFL's native
//     "start of Week 12" event. MFL enforces it from that week's first kickoff
//     (a Week-6 event refused trades on 2026-10-21; Week 6 had kicked off) and
//     its ICS export (TYPE=ics) gives the instant MFL resolved it to
//     (Week 12 → 2026-11-26T01:00:00Z = Wed Nov 25 8:00 PM ET);
//   - a TRADE event with NO start time is accepted by the import and not
//     enforced (trading stayed open); it is inert.
//
// So the deadline is the EARLIEST TRADE event that has not already ended. A
// week-numbered event is placed where MFL itself places it: the caller passes
// MFL's ICS start for that event id (icsStarts) — MFL's read-back, so it follows
// MFL if the NFL moves the week's first game.
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

// events: normalizeMflCalendar(...) rows. icsStarts: { [event id]: unix seconds } from MFL's ICS export (parseMflIcsStarts).
export function mflTradeLock(events, { nowUnix, icsStarts = {} } = {}) {
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
    const start = week ? Number(icsStarts[String(e.id || "")]) || 0 : raw;
    const end = Number(e.end_unix) || null;
    if (!raw) { out.events.push({ id: String(e.id || ""), start_unix: null, end_unix: end, nfl_week: null, inert: true }); continue; }
    out.events.push({ id: String(e.id || ""), start_unix: start || null, end_unix: end, nfl_week: week });
    if (end && end <= now) continue;               // a blackout that already ended doesn't count
    if (!(start > 0)) { out.reason = `week_${week}_start_not_in_mfl_ics`; return out; }
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

// MFL's ICS export → { event id: start, Unix seconds }. DTSTART is UTC ("20261126T010000"); UID is "<id>@myfantasyleague.com".
export function parseMflIcsStarts(text) {
  const out = {};
  for (const block of String(text || "").split("BEGIN:VEVENT").slice(1)) {
    const uid = /\nUID:(\d+)@/.exec("\n" + block.replace(/\r/g, ""));
    const st = /\nDTSTART(?:;[^:\n]*)?:(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z?/.exec("\n" + block.replace(/\r/g, ""));
    if (!uid || !st) continue;
    const t = Date.UTC(+st[1], +st[2] - 1, +st[3], +st[4], +st[5], +st[6]) / 1000;
    if (t > 0) out[uid[1]] = t;
  }
  return out;
}

// The week numbers a calendar's TRADE events refer to (when any are present, the caller reads MFL's ICS export).
export function tradeEventWeeks(events) {
  return [...new Set((Array.isArray(events) ? events : [])
    .filter((e) => e && e.event_type === "TRADE")
    .map((e) => Number(e.start_unix) || 0)
    .filter((n) => n > 0 && n <= WEEK_NUMBER_MAX))];
}

// ── THE RULE (Keith 2026-10-21, revised): "Trading closes at kickoff of the first NFL game in the NFL schedule week that
// includes Thanksgiving Day." Deliberately the WEEK, not the day: it follows Wednesday, Thursday or any other day the NFL
// gives that week's opener (2026: Week 12 opens Wed Nov 25 8:00 PM ET, GB @ LAR — a Thanksgiving Eve game). Read from the
// official NFL schedule only, and FAIL CLOSED: no published schedule, no week whose games span Thanksgiving, more than
// one such week, or a game in it without a kickoff time → "unresolved", never a guessed weekday.

// The fourth Thursday of November, as an ET calendar date "YYYY-MM-DD".
export function thanksgivingDateEt(season) {
  const yr = parseInt(season, 10);
  if (!(yr > 1900)) return "";
  const firstDow = new Date(Date.UTC(yr, 10, 1)).getUTCDay();
  const day = 1 + ((4 - firstDow + 7) % 7) + 21;
  return `${yr}-11-${String(day).padStart(2, "0")}`;
}

// weeks: [{ week, kickoffs: [unix seconds, 0 = time not set] }] from MFL's nflSchedule (W=ALL).
export function tradeDeadlineRule(season, weeks) {
  const out = { state: "unresolved", source: "nfl_schedule", rule: "first kickoff of the NFL week that includes Thanksgiving Day",
    thanksgiving_et: thanksgivingDateEt(season), nfl_week: null, start_unix: null, date_et: "", time_et: "", label: "", reason: "" };
  if (!out.thanksgiving_et) { out.reason = "season_missing"; return out; }
  const list = (Array.isArray(weeks) ? weeks : []).filter((w) => w && Array.isArray(w.kickoffs) && w.kickoffs.length);
  if (!list.length) { out.reason = "nfl_schedule_unavailable"; return out; }
  const spans = list.map((w) => {
    const ks = w.kickoffs.map(Number);
    const set = ks.filter((k) => k > 0);
    return { week: Number(w.week), ks, first: set.length ? Math.min(...set) : 0,
      from: set.length ? etParts(Math.min(...set)).date_et : "", to: set.length ? etParts(Math.max(...set)).date_et : "" };
  });
  const holds = spans.filter((s) => s.from && s.from <= out.thanksgiving_et && out.thanksgiving_et <= s.to);
  if (!holds.length) { out.reason = "no_nfl_week_includes_thanksgiving"; return out; }
  if (holds.length > 1) { out.reason = "more_than_one_nfl_week_includes_thanksgiving"; return out; }
  const w = holds[0];
  if (w.ks.some((k) => !(k > 0))) { out.reason = `week_${w.week}_has_a_game_without_a_kickoff_time`; return out; }
  const et = etParts(w.first);
  return { ...out, state: "resolved", nfl_week: w.week, start_unix: w.first, date_et: et.date_et, time_et: et.time_et, label: et.label };
}

// ── RECONCILE AND MONITOR (Keith 2026-10-21): the target is exactly ONE week-based "No Trades Allowed" event —
// START_TIME = the rule's NFL week (MFL's native "start of Week N"). The worker can create it and can find what's wrong;
// it cannot edit or delete MFL events, so a commissioner removes incorrect or duplicate ones. MFL's enforcement is read back.
//
// What MFL's API can and cannot do (test league 25625, 2026-10-21):
//   - import TYPE=calendarEvent EVENT_TYPE=TRADE START_TIME=<week> creates the week-based lock;
//   - the same import again creates a DUPLICATE (MFL never de-duplicates) → the worker reads before it writes;
//   - there is no update or delete: EVENT_ID / ID / DELETE / ACTION are ignored (a new event is created instead);
//     deleting needs the commissioner's MFL web calendar (commissioner mode), so stale and duplicate locks are
//     reported to the commissioner, never "fixed" by adding another event.
// Pure: events = normalizeMflCalendar rows; rule = tradeDeadlineRule(); icsStarts = parseMflIcsStarts().
export function planTradeLock({ events, rule, icsStarts = {}, nowUnix } = {}) {
  const now = Number(nowUnix) || Math.floor(Date.now() / 1000);
  const trade = (Array.isArray(events) ? events : []).filter((e) => e && e.event_type === "TRADE");
  const rows = trade.map((e) => {
    const raw = Number(e.start_unix) || 0, end = Number(e.end_unix) || null;
    const week = raw > 0 && raw <= WEEK_NUMBER_MAX ? raw : null;
    const start = week ? Number(icsStarts[String(e.id || "")]) || null : raw || null;
    const kind = !raw ? "inert" : end && end <= now ? "ended" : "active";
    return { id: String(e.id || ""), week, start_unix: start, end_unix: end, kind,
      label: start ? etParts(start).label : (week ? `Week ${week} (time unread)` : "no start time") };
  });
  const out = { status: "unresolved", rule_week: null, rule_start_unix: null, create: null, keep: null, remove: [], inert: [],
    rows, aligned: false, effective_start_unix: null, reason: "" };
  if (!rule || rule.state !== "resolved") { out.status = "waiting_for_nfl_schedule"; out.reason = (rule && rule.reason) || "rule_unresolved"; return out; }
  out.rule_week = rule.nfl_week; out.rule_start_unix = rule.start_unix;
  const active = rows.filter((r) => r.kind === "active");
  const targets = active.filter((r) => r.week === rule.nfl_week && !r.end_unix).sort((a, b) => Number(a.id) - Number(b.id));
  out.keep = targets[0] || null;
  out.create = targets.length ? null : { EVENT_TYPE: "TRADE", START_TIME: String(rule.nfl_week) };
  out.remove = active.filter((r) => r !== out.keep).map((r) => ({ ...r,
    why: r.week === rule.nfl_week ? "duplicate" : (r.start_unix && r.start_unix < rule.start_unix ? "earlier_than_rule_is_in_force" : "not_the_rule_lock") }));
  out.inert = rows.filter((r) => r.kind === "inert");
  const starts = active.map((r) => r.start_unix).filter((x) => x > 0);
  out.effective_start_unix = starts.length ? Math.min(...starts) : null;
  const keepAtRule = out.keep && out.keep.start_unix === rule.start_unix;
  out.aligned = !!(keepAtRule && !out.remove.length);
  out.status = out.aligned ? "aligned"
    : out.keep && !keepAtRule && out.keep.start_unix ? "mfl_places_week_elsewhere"
    : out.remove.length ? "needs_commissioner_cleanup"
    : out.create ? "needs_create" : "unresolved";
  return out;
}
