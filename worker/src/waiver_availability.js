// WAIVER AVAILABILITY — when can this free agent actually be claimed? (Keith 2026-10-17)
//
// Owner report: Demario Davis was dropped, and a claim for him in Friday's run
// failed with nothing on screen saying he was ineligible or when he would be.
// This is the ONE resolver every surface reads (served by
// GET /api/waivers/availability): the Market list, the player sheet reached from
// search, the bid sheet, the Claims screen and the desktop Waivers panel. Clients
// render its states and never re-derive them, so no two screens can disagree.
//
// THE RULE IS MFL'S, read from the league's own setup page (csetup?C=ADDDROP,
// "Dropped Players Are Locked Until"). League 74598 is set to "The first waivers
// run after 1 day(s)": a player dropped at instant D can first be claimed in the
// first scheduled run that starts strictly AFTER D + 1 day, where a day is
// 86,400 seconds of elapsed time, not a calendar day. Evidence:
//   - Demario Davis was dropped in Thursday's 9:00:00 AM run (2026-10-15).
//     Friday's 9:00:00 AM run is exactly 24 hours later, not after it, and MFL
//     refused him there: "Player Is Locked" (processed_waivers report). So
//     did Akeem Davis-Gaither, dropped in the same run by another team: the lock
//     is not owner-specific.
//   - Daylight saving: players dropped Sat 2024-11-02 at 9:00 EDT were awarded
//     at Sun 11-03 9:00 EST, 25 hours later. A calendar-day reading would have
//     refused them.
//   - 2022–2026 transaction replay: 1,434 adds of a previously dropped player.
//     None came earlier than this rule allows, and 265 came at exactly the first
//     run it allows.
// A player whose game has kicked off can't be added until his NFL week ends
// (MFL setting "Prevent Owners From Making ANY Roster Moves After Kickoff Of
// That Player's Game Until The End Of The Week" = Yes). 2026: none of 131
// in-season awards went to a player after his game kicked off. The app shows
// "Game locked" from his kickoff until the league moves to the next scoring
// week, then clears it and re-reads his drop (Keith 2026-10-17).
//
// TWO MOMENTS, never confused (Keith 2026-10-17): the badge names the first
// run that can AWARD the player; Bid returns early enough to SUBMIT a claim
// before that run (bid_opens_unix says when).
//
// FAIL VISIBLY. An input that couldn't be read (the setting, the transaction
// log, the waiver calendar, the NFL schedule) yields state "unknown" with the
// reason, never a guessed run.

export const DAY_SEC = 86400;

const ET = "America/New_York";

function n(v) { const x = Number(v); return Number.isFinite(x) ? x : 0; }
function s(v) { return v == null ? "" : String(v).trim(); }

// ── MFL's setup page → the dropped-player lock rule ─────────────────────────
// The page renders the league skin instead of the form unless the session is
// in commissioner mode, without an error. Like /admin/waivers/processed, the
// identity cell is checked FIRST, and a page without the commissioner identity
// is "unreadable", never "no lock".
export function parseDropLockSetting(html) {
  const page = String(html || "");
  const welcome = /class="welcome"[^>]*>([\s\S]{0,400}?)<\/td>/i.exec(page);
  if (!welcome) return { known: false, reason: "setup_page_identity_unreadable" };
  // Commissioner mode reads "<user>: Commissioner ( Logout | Become Owner )";
  // an owner session reads "<team> ( Logout | Become Commissioner )".
  const who = welcome[1].replace(/<[^>]+>/g, " ");
  if (!/Become Owner/i.test(who) || /Become Commissioner/i.test(who)) {
    return { known: false, reason: "setup_page_not_commissioner" };
  }
  const radios = [];
  const re = /<input\b[^>]*\bname="?WAIVER_WAIT_DEADLINE"?[^>]*>/gi;
  let m;
  while ((m = re.exec(page))) {
    const tag = m[0].replace(/\bon\w+="[^"]*"/gi, "");   // the onchange handlers mention other fields
    const v = /\bvalue="([^"]*)"/i.exec(tag);
    radios.push({ value: v ? v[1].toUpperCase() : "", checked: /\bchecked\b/i.test(tag) });
  }
  const chosen = radios.filter((r) => r.checked);
  if (!radios.length) return { known: false, reason: "drop_lock_setting_missing" };
  if (chosen.length !== 1) return { known: false, reason: "drop_lock_setting_ambiguous" };
  const selected = (name) => {
    const sel = new RegExp(`<select\\b[^>]*\\bname="?${name}"?[^>]*>([\\s\\S]*?)</select>`, "i").exec(page);
    if (!sel) return null;
    const opt = /<option\b[^>]*\bvalue="([^"]*)"[^>]*\bselected\b[^>]*>/i.exec(sel[1]);
    return opt ? opt[1] : null;
  };
  const gametimeRaw = selected("PREVENT_GAMETIME_WAIVERS");
  const gametime = gametimeRaw == null ? null : /^yes$/i.test(gametimeRaw);
  const mode = chosen[0].value;
  if (mode === "NONE") {
    return { known: true, mode: "none", days: 0, prevent_gametime_moves: gametime,
      text: "Players are not locked when dropped." };
  }
  if (mode === "WAIVERS") {
    const days = Number(selected("UNLOCK_WAIVERS"));
    if (!(days >= 0)) return { known: false, reason: "drop_lock_days_unreadable" };
    return { known: true, mode: "first_run_after", days, prevent_gametime_moves: gametime,
      text: `Dropped players are locked until the first waivers run after ${days} day(s).` };
  }
  // "N day(s) later" and "the following <day> at <hour>" are real MFL options
  // this league doesn't use. Modelling them without a case to prove against
  // would be a guess, so they report unknown and the app says so.
  return { known: false, reason: `drop_lock_mode_unsupported:${mode}` };
}

// ── MFL transactions → each player's most recent drop ───────────────────────
// BBID_WAIVER is "added,|bid|dropped," (the drop half of a claim, stamped at the
// run instant); FREE_AGENT is "added,|dropped,". A later add of the same player
// cancels the drop (he was picked up again).
export function dropsFromTransactions(rows) {
  const list = Array.isArray(rows) ? rows.slice() : rows ? [rows] : [];
  list.sort((a, b) => n(a && a.timestamp) - n(b && b.timestamp));
  const csv = (v) => s(v).split(",").map((x) => x.trim()).filter(Boolean);
  const drops = {};
  for (const tx of list) {
    const type = s(tx && tx.type).toUpperCase();
    const at = n(tx && tx.timestamp);
    if (!at) continue;
    const parts = s(tx && tx.transaction).split("|");
    let added = [], dropped = [], via = "";
    if (type === "BBID_WAIVER") { added = csv(parts[0]); dropped = csv(parts[2]); via = "waiver_claim"; }
    else if (type === "FREE_AGENT" || type === "WAIVER") { added = csv(parts[0]); dropped = csv(parts[1]); via = "drop"; }
    else continue;
    for (const pid of added) delete drops[pid];
    for (const pid of dropped) drops[pid] = { dropped_at_unix: at, franchise_id: s(tx.franchise), via };
  }
  return drops;
}

// ── labels (always America/New_York, DST-correct by construction) ───────────
function etParts(unix) {
  const d = new Date(n(unix) * 1000);
  const fmt = (opts) => new Intl.DateTimeFormat("en-US", { timeZone: ET, ...opts }).format(d);
  return {
    weekday: fmt({ weekday: "long" }),
    wd: fmt({ weekday: "short" }),
    md: fmt({ month: "short", day: "numeric" }),
    time: fmt({ hour: "numeric", minute: "2-digit", hour12: true }),
  };
}
// "Thu Oct 15, 9:00 AM ET"
export function etLabel(unix) {
  if (!n(unix)) return "";
  const p = etParts(unix);
  return `${p.wd} ${p.md}, ${p.time} ET`;
}
// "Saturday's run, Oct 17 at 9:00 AM ET"
export function runLabel(unix) {
  if (!n(unix)) return "";
  const p = etParts(unix);
  return `${p.weekday}'s run, ${p.md} at ${p.time} ET`;
}
function runName(unix) { return n(unix) ? `${etParts(unix).weekday}'s run` : ""; }
// "Friday's run (Oct 16, 9:00 AM ET)"
function runShort(unix) {
  if (!n(unix)) return "";
  const p = etParts(unix);
  return `${p.weekday}'s run (${p.md}, ${p.time} ET)`;
}
function runBadge(unix) { return n(unix) ? `${etParts(unix).wd} waiver` : ""; }
function waitText(days) {
  if (days === 1) return "1 day (24 hours)";
  if (days === 0.5) return "12 hours";
  return `${days} days (${days * 24} hours)`;
}
function markText(days) {
  if (days === 1) return "24 hours";
  if (days === 0.5) return "12 hours";
  return `${days} days`;
}

// ── the resolver ────────────────────────────────────────────────────────────
// input:
//   now_unix
//   rule     { known, mode: "first_run_after"|"none", days, prevent_gametime_moves, reason }
//   runs     { known, list: [unix…] (scheduled blind-bid runs, ascending), reason }
//   window   { mode: "bbid"|"fcfs"|"blackout"|"closed", fcfs_closes_unix, mode_reason }
//   week     { known, week, kickoffs: { TEAM: unix }, last_kickoff_unix, reason }
//   drops    { known, by_player: { pid: { dropped_at_unix, franchise_id, via } }, reason }
//   teams    { pid: "NYJ" }   NFL team of each dropped player ("" = none)
//   franchise_names { "0008": "Real Deal Creel" }
// output: { known, now_unix, changes_at_unix, next_run_unix, next_run_label,
//           rule, by_team: { TEAM: state }, no_game: state, players: { pid: state } }
// A free agent's state is players[pid] || by_team[his team] || no_game.
export function resolveWaiverAvailability(input) {
  const now = n(input && input.now_unix);
  const rule = (input && input.rule) || { known: false, reason: "rule_missing" };
  const runsIn = (input && input.runs) || { known: false, reason: "runs_missing" };
  const win = (input && input.window) || { mode: "closed", mode_reason: "window_missing" };
  const week = (input && input.week) || { known: false, reason: "week_missing" };
  const dropsIn = (input && input.drops) || { known: false, reason: "drops_missing" };
  const teams = (input && input.teams) || {};
  const names = (input && input.franchise_names) || {};
  const runs = (runsIn.known && Array.isArray(runsIn.list) ? runsIn.list : []).map(n).filter(Boolean).sort((a, b) => a - b);
  const runAfter = (t) => runs.find((r) => r > t) || null;          // strictly after
  const nextRun = runAfter(now);
  const lastRun = runs.filter((r) => r <= now).pop() || null;
  const weekEnd = n(week.last_kickoff_unix);
  // When the league moves to the next scoring week: the Lineup week's own rule
  // (resolveCurrentLineupWeek, 7 hours after the week's last kickoff), passed
  // in by the route. A game lock lasts from his kickoff until then.
  const rollover = n(week.rollover_unix) || weekEnd;
  // MFL has posted a run once its BBID_AUTO_PROCESS_WAIVERS marker is in the
  // transaction log (Sat 10-17: within 43 s of 9:00). Until then, rosters may
  // still be the pre-run ones.
  const processedRuns = new Set(((input && input.processed_runs) || []).map(n));
  const lastRunProcessed = lastRun ? processedRuns.has(lastRun) : null;
  const changes = [];

  const unknown = (reason, extra) => ({
    code: "unknown", badge: "Can't confirm",
    headline: `Availability could not be confirmed — ${reason}`,
    lines: [], reason, ...(extra || {}),
  });
  const closed = () => ({
    code: "closed", badge: "Locked",
    headline: win.mode === "blackout" ? "No add/drops right now" : "Waivers aren't open",
    lines: [], reason: s(win.mode_reason),
  });
  const kickoffLine = (team, ko, rel) => {
    if (!team) return "";
    if (!ko) return `${team} has no game this NFL week.`;
    return `His game (${team}): ${etLabel(ko)}${rel ? ` — ${rel}` : ""}.`;
  };
  // After a game lock, the first run after the week rolls over (that is also
  // after any drop lock).
  const runAfterWeek = (lockEnd) => runAfter(Math.max(rollover, n(lockEnd)));
  // The run before r: once it has run, r is the next run, so a claim entered
  // then goes to r.
  const prevRun = (r) => runs.filter((x) => x < r).pop() || 0;
  // "You can enter a claim from …, in time for <run>."
  const claimsOpenLine = (opens, r) => (opens && r && opens > now)
    ? `You can enter a claim from ${etLabel(opens)}, in time for ${runName(r)}.` : "";

  const stateFor = (team, drop) => {
    if (win.mode === "blackout" || win.mode === "closed") return closed();
    if (!week.known) return unknown(s(week.reason) || "the NFL schedule couldn't be read");
    if (!runsIn.known) return unknown(s(runsIn.reason) || "the waiver run schedule couldn't be read");
    const ko = team ? n((week.kickoffs || {})[team]) : 0;
    const base = { team: team || "", kickoff_unix: ko || null };

    // Drop lock, when this player has a recent drop.
    let lockEnd = 0, firstRun = null, dropLines = [];
    if (drop) {
      if (!rule.known) return unknown(s(rule.reason) || "MFL's dropped-player setting couldn't be read", base);
      if (rule.mode === "first_run_after") {
        lockEnd = n(drop.dropped_at_unix) + Math.round(n(rule.days) * DAY_SEC);
        firstRun = runAfter(lockEnd);
        const who = names[drop.franchise_id] ? ` by ${names[drop.franchise_id]}` : "";
        const how = drop.via === "waiver_claim" ? `, as part of its claim in ${runName(drop.dropped_at_unix)}` : "";
        dropLines = [
          `Dropped ${etLabel(drop.dropped_at_unix)}${who}${how}.`,
          `League rule (MFL setting): a dropped player is locked until the first waiver run after ${waitText(n(rule.days))} from the drop.`,
          `${markText(n(rule.days))} after the drop: ${etLabel(lockEnd)}.`,
        ];
        Object.assign(base, {
          dropped_at_unix: n(drop.dropped_at_unix), dropped_by: s(drop.franchise_id), dropped_via: s(drop.via),
          lock_ends_unix: lockEnd,
        });
      }
    }
    const dropActive = !!(firstRun && nextRun && firstRun > now && firstRun >= nextRun && drop);

    if (drop && rule.known && rule.mode === "first_run_after" && !firstRun) {
      return unknown("no waiver run is scheduled after his drop lock ends", base);
    }

    // "Game locked": from his kickoff until the league moves to the next
    // scoring week, in every window — blind-bid, first-come, and after the
    // Monday 9:00 PM re-lock (Keith 2026-10-17). At the rollover the lock
    // clears and his drop, if any, is re-read for the first remaining run.
    if (ko && now >= ko && now < rollover) {
      const r = runAfterWeek(lockEnd);
      const opens = r ? Math.max(rollover, prevRun(r)) : null;
      return {
        ...base, code: "game_locked", badge: "Game locked",
        eligible_run_unix: r, eligible_run_label: runLabel(r), bid_opens_unix: opens,
        headline: `Game locked — ${r ? `eligible again for ${runLabel(r)}` : "no waiver run is scheduled after this week"}`,
        lines: [
          `His game (${team}) kicked off ${etLabel(ko)}.`,
          "League setting (MFL): once a player's game kicks off, no roster moves on him for the rest of the scoring week.",
          `The league moves to the next week ${etLabel(rollover)}.`,
          ...(dropActive ? dropLines : []),
          r ? `First eligible run: ${runLabel(r)}.` : "No waiver run is scheduled after this week.",
          claimsOpenLine(opens, r),
        ].filter(Boolean),
      };
    }

    // FCFS window: an unlocked player is first-come, first-served until kickoff.
    if (win.mode === "fcfs" && !dropActive) {
      const until = [ko, n(win.fcfs_closes_unix)].filter(Boolean).sort((a, b) => a - b)[0] || 0;
      return {
        ...base, code: "available_now", badge: "",
        eligible_run_unix: null, eligible_run_label: "", bid_opens_unix: null,
        headline: "Available now",
        lines: [
          `First-come, first-served free agency is open${until ? ` until ${etLabel(until)}` : ""}.`,
          ko ? kickoffLine(team, ko, "MFL locks him at kickoff") : kickoffLine(team, 0),
        ].filter(Boolean),
      };
    }

    // The run he could first be claimed in, ignoring kickoff.
    const target = dropActive ? firstRun : nextRun;
    if (!target) return unknown("no waiver run is scheduled", base);

    // No run he can be claimed in comes before his game.
    if (ko && now < ko && target >= ko) {
      const r = runAfterWeek(lockEnd);
      const opens = r ? Math.max(rollover, prevRun(r)) : null;
      return {
        ...base, code: "not_before_kickoff", badge: r ? runBadge(r) : "Locked",
        eligible_run_unix: r, eligible_run_label: runLabel(r), bid_opens_unix: opens,
        headline: `Not eligible before kickoff — ${r ? `first eligible run: ${runLabel(r)}` : "no later waiver run is scheduled"}`,
        lines: [
          ...(dropActive ? dropLines : []),
          `${dropActive ? "The first run he could be claimed in" : "The next run"} is ${runLabel(target)}.`,
          kickoffLine(team, ko, "before that run. From kickoff, MFL locks him for the rest of the scoring week"),
          r ? `First eligible run: ${runLabel(r)}.` : "No later waiver run is scheduled.",
          claimsOpenLine(opens, r),
        ].filter(Boolean),
      };
    }

    // Blind-bid waivers (or FCFS while a drop lock is still on).
    // Later than everyone else: a run after the next one, or — inside the FCFS
    // window, where everyone else is addable now — any run at all.
    const later = dropActive && (firstRun > nextRun || win.mode === "fcfs");
    const lines = [];
    if (drop && dropLines.length) {
      lines.push(...dropLines);
      if (later) {
        if (firstRun > nextRun) {
          lines.push(`${runShort(nextRun)} starts ${nextRun === lockEnd ? "exactly at that mark, not after it" : "before that mark"}, so MFL refuses claims for him in it.`);
        }
      } else if (n(drop.dropped_at_unix) && firstRun === nextRun) {
        lines.push(`${runName(nextRun)} starts after that mark, so he's eligible for it.`);
      }
    } else if (win.mode === "bbid") {
      lines.push("Blind-bid waivers: every claim is processed at the next run.");
    }
    if (win.mode === "fcfs" && later) {
      lines.push("First-come, first-served adds are open, but not for him until his lock ends at a waiver run.");
    }
    lines.push(`First eligible run: ${runLabel(target)}.`);
    // A later run: claims open once the run before it has run — or, inside the
    // FCFS window (no blind bids), at the Monday 9:00 PM re-lock.
    const opens = later ? Math.max(prevRun(target), win.mode === "fcfs" ? n(win.fcfs_closes_unix) : 0) : null;
    if (later) lines.push(claimsOpenLine(opens, target));
    if (team) {
      lines.push(ko && ko <= target
        ? `His game (${team}) was ${etLabel(ko)}; that NFL week is over by this run.`
        : kickoffLine(team, ko, ko ? "after that run, so it doesn't change it" : ""));
    }
    return {
      ...base, code: later ? "waivers_later" : "waivers",
      badge: later ? runBadge(target) : "",
      eligible_run_unix: target, eligible_run_label: runLabel(target), bid_opens_unix: opens,
      headline: later ? `Waivers — eligible for ${runLabel(target)}` : `Waivers — next run: ${runLabel(target)}`,
      lines: lines.filter(Boolean),
    };
  };

  // Recent drops that still matter: those whose first eligible run is at or
  // after the next run (after that run they're ordinary free agents).
  // (The route passes only the last 8 days of drops. With the rule unreadable,
  // every one of them is reported unknown rather than dropped from the list.)
  const players = {};
  if (dropsIn.known) {
    for (const [pid, drop] of Object.entries(dropsIn.by_player || {})) {
      if (rule.known && rule.mode === "none") continue;
      if (rule.known && rule.mode === "first_run_after") {
        const fr = runAfter(n(drop.dropped_at_unix) + Math.round(n(rule.days) * DAY_SEC));
        if (fr && nextRun && fr < nextRun) continue;   // his lock already ended at a past run
      }
      players[pid] = stateFor(s(teams[pid]).toUpperCase(), drop);
    }
  }

  const by_team = {};
  if (week.known) for (const team of Object.keys(week.kickoffs || {})) by_team[team] = stateFor(team, null);
  // No game this week (bye, or not on an NFL team). With an unreadable drop log
  // this state can't rule out a recent drop, so it's unknown too.
  let no_game = stateFor("", null);
  if (!dropsIn.known && no_game.code !== "closed") {
    no_game = unknown(s(dropsIn.reason) || "MFL's transaction log couldn't be read");
    for (const team of Object.keys(by_team)) {
      if (by_team[team].code !== "closed") by_team[team] = unknown(s(dropsIn.reason) || "MFL's transaction log couldn't be read", { team });
    }
  }

  // The next instant any state can change: a run, a kickoff, the FCFS close.
  if (nextRun) changes.push(nextRun);
  for (const ko of Object.values(week.kickoffs || {})) if (n(ko) > now) changes.push(n(ko));
  if (n(win.fcfs_closes_unix) > now) changes.push(n(win.fcfs_closes_unix));
  if (rollover > now) changes.push(rollover);
  // A run MFL hasn't posted yet: look again in 20 s.
  if (lastRun && lastRunProcessed === false && now - lastRun < 3600) changes.push(now + 20);
  const changesAt = changes.length ? Math.min(...changes) : null;

  return {
    known: !!(rule.known && runsIn.known && week.known && dropsIn.known),
    now_unix: now,
    changes_at_unix: changesAt,
    next_run_unix: nextRun,
    next_run_label: runLabel(nextRun),
    last_run_unix: lastRun,
    last_run_label: runLabel(lastRun),
    last_run_processed: lastRunProcessed,
    rule: { known: !!rule.known, mode: rule.mode || null, days: rule.known ? n(rule.days) : null,
      text: s(rule.text), reason: s(rule.reason), prevent_gametime_moves: rule.prevent_gametime_moves == null ? null : !!rule.prevent_gametime_moves },
    week: { known: !!week.known, week: n(week.week) || null, last_kickoff_unix: weekEnd || null, rollover_unix: rollover || null, reason: s(week.reason) },
    by_team,
    no_game,
    players,
  };
}
