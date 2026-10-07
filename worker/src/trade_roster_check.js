// trade_roster_check.js — after a trade accepted ENTIRELY on MFL's own site (which the War Room can't
// intercept), find any team left over the roster maximum or over five active QBs, and say exactly what
// it must do and by when. Pure: the route in index.js reads MFL/D1 and sends the DMs.
//
// Keith 2026-10-07: "We cannot block an acceptance performed entirely on MFL's site. Detect a resulting
// roster or QB overage and immediately notify the affected owner and commissioner with the actual
// counts and the required action. … within 24 hours of the trade or before that team's next player
// locks, whichever comes first. If MFL itself prevents the move, escalate for commissioner review; do
// not automatically drop a player, void a trade or impose a penalty."
//
// Active = MFL status ROSTER. Taxi and IR players don't count, for either limit (canon §B1/§B3).

const s = (v) => String(v == null ? "" : v).trim();
const pad4 = (v) => { const d = s(v).replace(/\D/g, ""); return d ? d.padStart(4, "0").slice(-4) : ""; };
const arr = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]);
export const ACTIVE_QB_LIMIT = 5;
export const CURE_WINDOW_SEC = 24 * 3600;
export const WAR_ROOM_MATCH_SEC = 180;

/** MFL TRADE transaction → { key, ts, a, b }. Key = timestamp + both teams (MFL's ledger carries no trade id). */
export function tradeKeyOf(tx) {
  const ts = parseInt(tx && tx.timestamp, 10) || 0;
  const a = pad4(tx && tx.franchise), b = pad4(tx && tx.franchise2);
  return { key: `${ts}_${[a, b].sort().join("_")}`, ts, a, b };
}

/**
 * @param a.trades       MFL transactions (TRADE) rows
 * @param a.rosters      { fid -> [{ id, status }] }
 * @param a.rosterMax    MFL league.rosterSize (number) — required
 * @param a.positions    { pid -> position } — required
 * @param a.warRoom      [{ participants: "0003,0010", mfl_executed_at_unix }] War Room executions (gated there; skipped here)
 * @param a.sinceUnix / a.nowUnix
 * @returns [{ trade_key, trade_ts, franchise_id, other_id, kind: "roster"|"qb", active, max, active_qbs }]
 */
export function planRosterChecks(a) {
  const out = [];
  const since = Math.max(Number(a.sinceUnix) || 0, (Number(a.nowUnix) || 0) - 36 * 3600);
  for (const tx of arr(a.trades)) {
    if (s(tx && tx.type).toUpperCase() !== "TRADE") continue;
    const t = tradeKeyOf(tx);
    if (!t.ts || t.ts < since || !t.a || !t.b) continue;
    const viaWarRoom = arr(a.warRoom).some((w) => {
      const parts = s(w.participants).split(",").map(pad4).sort().join("_");
      return parts === [t.a, t.b].sort().join("_") && Math.abs((Number(w.mfl_executed_at_unix) || 0) - t.ts) <= WAR_ROOM_MATCH_SEC;
    });
    if (viaWarRoom) continue;
    for (const fid of [t.a, t.b]) {
      const roster = arr(a.rosters && a.rosters[fid]);
      const active = roster.filter((p) => s(p.status).toUpperCase() === "ROSTER");
      const activeQbs = active.filter((p) => s(a.positions && a.positions[s(p.id)]).toUpperCase() === "QB").length;
      const base = { trade_key: t.key, trade_ts: t.ts, franchise_id: fid, other_id: fid === t.a ? t.b : t.a, active: active.length, max: a.rosterMax, active_qbs: activeQbs };
      if (active.length > a.rosterMax) out.push({ ...base, kind: "roster" });
      if (activeQbs > ACTIVE_QB_LIMIT) out.push({ ...base, kind: "qb" });
    }
  }
  return out;
}

/**
 * The cure deadline: 24 hours after the trade, or the team's next player lock (the earliest upcoming
 * kickoff of any of its active players' NFL teams), whichever comes first.
 * @param kickoffs   [{ team -> kickoff unix }, …] this week first, then next week (either may be {})
 * @returns { deadline_unix, basis: "24h" | "next_lock" | "24h_schedule_unread" }
 */
export function cureDeadline({ tradeTs, nflTeams, kickoffs, nowUnix }) {
  const by24 = (Number(tradeTs) || 0) + CURE_WINDOW_SEC;
  const maps = arr(kickoffs).filter((m) => m && Object.keys(m).length);
  if (!maps.length) return { deadline_unix: by24, basis: "24h_schedule_unread" };
  const teams = new Set(arr(nflTeams).map((x) => s(x).toUpperCase()).filter(Boolean));
  let next = 0;
  for (const m of maps) {
    for (const [team, ko] of Object.entries(m)) {
      const k = Number(ko) || 0;
      if (teams.has(team.toUpperCase()) && k > (Number(nowUnix) || 0) && (!next || k < next)) next = k;
    }
    if (next) break;   // this week's next lock found; next week only when this week has none left
  }
  return next && next < by24 ? { deadline_unix: next, basis: "next_lock" } : { deadline_unix: by24, basis: "24h" };
}

/** The DM both the affected owner and the commissioner receive. */
export function rosterCheckMessage({ finding, teamName, otherName, tradeWhenEt, deadlineEt, basis }) {
  const team = teamName || finding.franchise_id;
  const head = `⚠️ Roster check after your trade with ${otherName || finding.other_id} (accepted on MFL ${tradeWhenEt}): `;
  const body = finding.kind === "qb"
    ? `${team} has ${finding.active_qbs} QBs on the active roster — the maximum is ${ACTIVE_QB_LIMIT} (taxi and IR QBs don't count). Make a legal QB move to get back to ${ACTIVE_QB_LIMIT}: move a QB to IR if MFL lists him on IR, move an eligible QB to the taxi squad, or drop one.`
    : `${team} has ${finding.active} active players — the maximum is ${finding.max}. Make ${finding.active - finding.max} legal move${finding.active - finding.max === 1 ? "" : "s"} to get back to ${finding.max}: an eligible player to IR or the taxi squad, or a drop.`;
  const when = ` Do it by ${deadlineEt} (${basis === "next_lock" ? "before your next player locks" : "24 hours after the trade"} — whichever of the two comes first).`;
  const tail = " If MFL won't let you make the move, tell the commissioner. Nothing will be dropped, voided or penalized automatically.";
  return head + body + when + tail;
}
