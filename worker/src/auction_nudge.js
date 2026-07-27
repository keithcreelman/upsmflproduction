// auction_nudge.js — FA-Auction reports: 9 AM ET + 9 PM ET.
//
// TWO runs a day doing DIFFERENT jobs, and the split is the point:
//
//   9 AM  (mode "morning") — yesterday's ET day is CLOSED, so its verdict is
//         final and unarguable. This is the ONLY run that names a miss, counts
//         a §F RULE 2 offense, or books a fine. It shows today's nominations as
//         information only: "no need to say these teams are out of compliance
//         it's 9AM" (Keith 2026-07-14).
//
//   9 PM  (mode "evening") — a WARNING about the day in progress ("you have N
//         hours"). It CANNOT judge: the ET day hasn't closed, so nobody has
//         missed anything yet. Tags whoever still owes.
//
// Each posts one parent message plus a thread carrying the detail: wins since
// the last report, §F RULE 2 standings, open lots, positions remaining.
//
// Deliberately NOT a DM job. It used to DM every owner who owed on top of the
// channel post; with an empty AUCTION_NUDGE_TEST_FRANCHISES that meant 11 DMs a
// night. Keith 2026-07-14: "we can simply tag them as still need to nominate.
// Everyone else doesn't need to be tagged." The @-tag in the channel IS the
// nudge — one notification, in the room where the auction lives.
//
// Gated DARK by default — nothing sends unless BOTH of these hold:
//   • AUCTION_NIGHTLY_NUDGE_ENABLED = "1"  (master kill switch, FO panel)
//   • AUCTION_FAA_ENABLED          = "1"  (only while the auction is live)
// NOTE: these read through D1 (ups_settings) FIRST — a D1 override beats the
// wrangler.toml default, which is how this fired on 2026-07-14 while the toml
// still said "0". Check the FO panel, not the toml, to know if it's armed.
//
// Fines are gated SEPARATELY behind AUCTION_FAA_PENALTIES_ENABLED. The report
// runs and names misses either way; only the money is switched.
//
// Data comes from /api/auction/fa-schedule + /api/auction/lots via env.SELF.fetch,
// so the scoreboard owners see in the app is exactly what drives the report.

import { getFeatureFlag } from "./feature_flags.js";
import { resolveDiscordUserIds } from "./trade_dm.js";
import { sendDm, openDmChannel } from "./discord_round.js";
import {
  closeEtDay, complianceStandings, previousEtDay, etDayKeyOf, rule2Label, rule2FineK,
  RULE2_MAX_FINED_OFFENSE,
} from "./auction_compliance.js";

function safeStr(v) { return String(v == null ? "" : v).trim(); }
function plural(n, one, many) { return Number(n) === 1 ? one : (many || one + "s"); }

// Emoji/wide glyphs break monospace column alignment inside a ``` block — a
// franchise called "HammerTime 🔨 ⏰" renders two cells wide in Discord's code
// font and shears the whole table. Strip to ASCII for table cells ONLY; prose
// lines keep the owner's real name.
function asciiName(v) { return safeStr(v).replace(/[^\x00-\x7F]+/g, "").replace(/\s+/g, " ").trim(); }
function padEnd(s, n) { s = String(s); return s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length); }
function padStart(s, n) { s = String(s); return s.length >= n ? s : " ".repeat(n - s.length) + s; }

// "16h 25m" / "42m" — the report is a nightly snapshot, so minute precision is
// as fine as it needs to be.
function humanDuration(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}h ${m}m` : `${m}m`;
}

// The two run times, in ONE place. The 9 PM header read "9:30 PM ET" for a day
// after the schedule moved, because the time was a literal buried in the copy.
// The cron (wrangler.toml "0 1,2,13,14 * * *") + the ET-hour gate (9 || 21) are
// the source of truth; these labels must track them.
const REPORT_LABEL = { morning: "9:00 AM ET", evening: "9:00 PM ET" };

// Position columns, split offense | defense to match how owners read a lineup.
const OFFENSE_COLS = [
  ["QB", "QB"], ["RB", "RB"], ["WR", "WR"], ["TE", "TE"],
  ["FLEX", "FLX"], ["SUPERFLEX", "SFX"],
];
const DEFENSE_COLS = [
  ["PK", "PK"], ["PN", "PN"], ["DL", "DL"], ["LB", "LB"],
  ["DB", "DB"], ["DFLEX", "DFX"],
];

// Drop a column no one in the league needs, so the table fits a phone. Every
// row still reconciles to TOT because a hidden column is zero for everybody.
function usedColumns(cols, rows) {
  return cols.filter(([key]) =>
    rows.some((r) => Number((r.lineup_deficits || {})[key] || 0) > 0)
  );
}

// ---------- 9 AM PARENT: yesterday's verdict ----------
// The morning report is the ONLY one that judges. At 9 AM the prior ET day is
// closed and its verdict is final, so this is where a miss gets named, tagged,
// and counted under §F RULE 2. It deliberately does NOT judge the day in
// progress — "no need to say these teams are out of compliance it's 9AM"
// (Keith 2026-07-14) — today's nominations are shown as information only.
function buildMorningMessage(data, closed, standings, mentionsByFid, penaltiesArmed) {
  const rows = data.rows || [];
  const max = Number(data.noms_max || 2);
  const used = (r) => Number(r.noms_used || 0);
  const L = [];

  L.push(`### 🌅 FA AUCTION — MORNING · ${REPORT_LABEL.morning}`);
  L.push("");

  // ---- yesterday: the verdict ----
  const misses = (closed && closed.misses) || [];
  L.push(`**📋 YESTERDAY (${closed?.day || "—"}) — FINAL**`);
  if (!closed || !closed.day) {
    L.push("_No closed day to report yet._");
  } else if (!misses.length) {
    L.push("✅ **Everyone who owed a nomination made it.** Clean sheet. 🎉");
  } else {
    for (const m of misses) {
      const st = standings.get(m.fid) || {};
      const offense = Number(st.offense_no || 0);
      const tag = (mentionsByFid[m.fid] || []).map((id) => `<@${id}>`).join(" ");
      const note = offense > RULE2_MAX_FINED_OFFENSE
        ? " — **league-fit review** (§F RULE 2)"
        : ` — **${rule2Label(offense)}**`;
      L.push(`⚠️ **${m.franchise_name}** — ${m.noms_used}/${m.noms_required}${note}${tag ? ` — ${tag}` : ""}`);
    }
    L.push("");
    if (penaltiesArmed) {
      L.push("_§F RULE 2 fines applied. The next-season half sits on the ledger and crosses over at the rollover._");
      // Immunity only matters once money is real. The CC no longer exists
      // (Keith 2026-07-15) — telling the LEAGUE ahead of time is the standard,
      // and it's a heads-up, not an application.
      L.push("_Know you'll be out of pocket — travelling, no service, life? Tell the league ahead of time and it won't count against you._");
    } else {
      L.push("🧪 _This was only a test — no penalties assessed at this time._");
    }
  }
  L.push("");

  // ---- today: information only, no judgement ----
  L.push(`**📥 TODAY SO FAR** — nominations as of ${REPORT_LABEL.morning.replace(" ET", "")} · ${max} per team due by midnight ET`);
  const withNoms = rows.filter((r) => used(r) > 0).sort((a, b) => used(b) - used(a));
  if (!withNoms.length) {
    L.push("_Nobody's nominated yet — the day just started._");
  } else {
    for (const r of withNoms) L.push(`• **${r.franchise_name}** — ${used(r)}/${max}`);
    const yet = rows.length - withNoms.length;
    if (yet > 0) L.push(`_…and ${yet} ${plural(yet, "team")} yet to nominate today._`);
  }
  L.push("");
  L.push("Recent wins, open lots + what everyone still needs → **thread** 🧵");
  return L.join("\n");
}

// §F RULE 2 standings — who's carrying what, this auction.
function buildStandingsSection(rows, standings) {
  const fined = rows
    .map((r) => ({ r, st: standings.get(String(r.franchise_id).padStart(4, "0")) }))
    .filter((x) => x.st && x.st.offenses > 0);
  if (!fined.length) return null;
  const L = [];
  L.push("**⚖️ §F RULE 2 — MISSED NOMINATIONS THIS AUCTION**");
  const nameW = Math.max(4, ...fined.map((x) => asciiName(x.r.franchise_name).length));
  L.push("```");
  L.push(`${padEnd("TEAM", nameW)}  MISSES  ${padStart("THIS YR", 8)}  ${padStart("NEXT YR", 8)}`);
  L.push("─".repeat(nameW + 2 + 6 + 2 + 8 + 2 + 8));
  for (const { r, st } of fined.sort((a, b) => b.st.offenses - a.st.offenses)) {
    L.push(
      `${padEnd(asciiName(r.franchise_name), nameW)}  ${padStart(String(st.offenses), 6)}  ` +
      `${padStart("$" + st.fined_k_this_season + "K", 8)}  ${padStart("$" + st.fined_k_next_season + "K", 8)}`
    );
  }
  L.push("```");
  L.push("_NEXT YR is booked on the ledger now but does not reach MFL until the rollover._");
  return L.join("\n");
}

// ---------- 9 PM PARENT: the nomination scoreboard ----------
// Tags ONLY the owners who still owe. An over-cap owner is NOT tagged — they
// don't owe a nomination, they owe one less, and "go nominate" would be wrong.
function buildParentMessage(data, mentionsByFid) {
  const rows = data.rows || [];
  const max = Number(data.noms_max || 2);
  const used = (r) => Number(r.noms_used || 0);

  // Trust the endpoint's own verdict — do NOT recompute. The rule is
  // "owes = !roster_met && used < required" (auction_windows.js): the floor is
  // waived once a franchise can field a legal lineup, so a team that filled its
  // roster and correctly stopped nominating is COMPLIANT at 0/2. Recomputing as
  // `used < max` drops the !roster_met term and would publicly tag the one owner
  // who's actually done. `over` stays local arithmetic — it's a ceiling breach,
  // which out_of_compliance deliberately doesn't cover.
  const over = rows.filter((r) => used(r) > max);
  const owe = rows.filter((r) => !!r.out_of_compliance && used(r) <= max);
  const met = rows.filter((r) => used(r) <= max && !r.out_of_compliance);
  const byName = (a, b) => asciiName(a.franchise_name).localeCompare(asciiName(b.franchise_name));
  const byUsedDesc = (a, b) => (used(b) - used(a)) || byName(a, b);

  // Time left in the ET nomination day, from the payload's own clock — NOT
  // hardcoded, so a late/retried cron still states the truth. Minute precision,
  // not rounded hours: at 9:00 PM exactly 3h remain, and Math.round would say
  // "3 hours" — pushing a §A2 deadline (with a §F fine behind it) half an hour
  // past midnight. Flooring instead reads "0 hours" on a late manual trigger.
  const timeLeft = humanDuration(Math.max(0,
    Number(rows[0]?.seconds_until_reset ??
      (Number(data.window_end_unix || 0) - Number(data.now_unix || 0)))
  ));

  const L = [];
  L.push(`### 🏈 FA AUCTION — EVENING · ${REPORT_LABEL.evening}`);
  L.push("");
  L.push(`**NOMINATIONS TODAY** — ${max} per team · midnight→midnight ET`);
  L.push("");

  L.push("**IN COMPLIANCE**");
  if (!over.length && !met.length) {
    L.push("_Nobody yet._");
  } else {
    for (const r of [...over, ...met].sort(byUsedDesc)) {
      const isOver = used(r) > max;
      // "✅ Hawks — 0/2" reads like a mistake without saying why it's fine: the
      // roster is legal, so the nomination floor no longer applies.
      const why = !isOver && r.roster_met && used(r) < max ? " · roster set" : "";
      L.push(`${isOver ? "⚠️" : "✅"} **${r.franchise_name}** — ${used(r)}/${max}${isOver ? " · **over cap**" : why}`);
    }
  }
  L.push("");

  L.push("**OUT OF COMPLIANCE**");
  if (!owe.length) {
    L.push("_Nobody — everyone's in. 🎉_");
  } else {
    for (const r of owe.sort(byUsedDesc)) {
      // 🟡 = made one of two. 🔴 = hasn't started.
      const dot = used(r) > 0 ? "🟡" : "🔴";
      const tag = (mentionsByFid[r.franchise_id] || []).map((id) => `<@${id}>`).join(" ");
      L.push(`${dot} **${r.franchise_name}** — ${used(r)}/${max}${tag ? ` — ${tag}` : ""}`);
    }
  }
  L.push("");

  if (over.length) {
    // Each franchise carries its OWN count — with two over-cap teams the old
    // copy printed the first one's number for both. No hardcoded "3rd" either:
    // the overage can be any size, and max is data.
    const names = over.map((r) => `**${r.franchise_name}** (${used(r)}/${max})`).join(", ");
    L.push(
      `🛠️ _${names} — ${over.length === 1 ? "that extra nomination" : "those extra nominations"} slipped ` +
      `through before the cap existed. Fix implemented to prevent more than ${max} nominations except on ` +
      `the final day moving forward._`
    );
    L.push("");
  }

  if (owe.length) {
    L.push(`**Out of compliance teams — please submit your nominations within the next ${timeLeft}.**`);
  }
  L.push("Open lots, leaders + what everyone still needs → **thread** 🧵");
  return L.join("\n");
}

// ---------- THREAD §1: what closed since the last report ----------
// Suppressed entirely when nothing closed — on Day 1 nothing can, since the
// first lots don't lock for 24h, and an empty "Players won: 0" table is noise
// (Keith 2026-07-14). ERA wins are excluded: they're a different auction under
// §A3 and stay out of FAA counts (PR #705).
function buildWonSection(won, bidsByPid, capSpaceDollars) {
  if (!won.length) return null;
  const capSpentK = won.reduce((n, l) => n + Math.round(Number(l.current_high_bid_k || 0)), 0);
  const L = [];
  L.push("**🏆 WON — SINCE THE LAST REPORT**");
  L.push(
    `Players won: **${won.length}** · Cap spent: **$${capSpentK}K** · ` +
    `Available league cap space: **$${Math.round(capSpaceDollars / 1000)}K**`
  );

  const nameW = Math.max(6, ...won.map((l) => asciiName(l.player_name).length));
  const byW = Math.max(6, ...won.map((l) => asciiName(l.winner_name || "—").slice(0, 17).length));
  L.push("```");
  L.push(`${padEnd("PLAYER", nameW)}  POS  TM   ${padEnd("WON BY", byW)}  ${padStart("SAL", 4)}  TMS   HB  UP FOR`);
  L.push("─".repeat(nameW + 2 + 3 + 2 + 3 + 3 + byW + 2 + 4 + 2 + 3 + 2 + 3 + 2 + 7));
  for (const l of won.slice().sort((a, b) => Number(b.won_at_unix || 0) - Number(a.won_at_unix || 0))) {
    const bids = bidsByPid[String(l.player_id)] || [];
    // The row's fid is always the LEADER, so distinct fids = distinct high
    // bidders. A rival who bid into someone's proxy never gets a row of their
    // own — they exist only as the forcer named in the note — so "teams
    // involved" is the union of the two.
    const leaders = new Set(bids.map((b) => asciiName(b.franchise_name)).filter(Boolean));
    const forcers = new Set(bids.map((b) => asciiName(b.forcer_name || "")).filter(Boolean));
    const involved = new Set([...leaders, ...forcers]);
    // Nomination → win. Not a constant: every lead change restarts the clock,
    // so a contested lot runs well past its nominal window.
    const upFor = Number(l.won_at_unix || 0) - Number(l.opened_at_unix || 0);
    L.push(
      `${padEnd(asciiName(l.player_name), nameW)}  ` +
      `${padEnd(safeStr(l.position).slice(0, 3), 3)}  ` +
      `${padEnd(safeStr(l.nfl_team).slice(0, 3), 3)}  ` +
      `${padEnd(asciiName(l.winner_name || "—").slice(0, 17), byW)}  ` +
      `${padStart("$" + Math.round(Number(l.current_high_bid_k || 0)) + "K", 4)}  ` +
      `${padStart(String(involved.size), 3)}  ${padStart(String(leaders.size), 3)}  ` +
      `${humanDuration(upFor)}`
    );
  }
  L.push("```");
  L.push("_TMS = teams involved (winner + anyone who nominated or forced an increase) · HB = distinct high bidders · UP FOR = nomination → win._");
  return L.join("\n");
}

// ---------- THREAD §2: open lots + positions matrix ----------
function buildBoardSections(data, lots) {
  const rows = data.rows || [];
  const open = (lots || []).filter((l) => String(l.status) === "open");
  const out = [];
  const L = [];

  if (open.length) {
    L.push(`**🔨 OPEN LOTS — who's leading** (${open.length} live)`);
    const nameW = Math.max(6, ...open.map((l) => asciiName(l.player_name).length));
    const bidW = 5;
    L.push("```");
    L.push(`${padEnd("PLAYER", nameW)}  ${padEnd("HIGH BIDDER", 17)} ${padStart("BID", bidW)}  LEFT`);
    L.push("─".repeat(nameW + 2 + 17 + 1 + bidW + 2 + 8));
    for (const l of open.slice().sort((a, b) => Number(a.seconds_remaining || 0) - Number(b.seconds_remaining || 0))) {
      L.push(
        `${padEnd(asciiName(l.player_name), nameW)}  ` +
        `${padEnd(asciiName(l.current_high_bidder_name || "—").slice(0, 17), 17)} ` +
        `${padStart("$" + Math.round(Number(l.current_high_bid_k || 0)) + "K", bidW)}  ` +
        `${humanDuration(l.seconds_remaining)}`
      );
    }
    L.push("```");
    out.push(L.join("\n"));
    L.length = 0;
  }

  L.push("**🎯 POSITIONS REMAINING** — what each team still needs for a legal 27");
  const off = usedColumns(OFFENSE_COLS, rows);
  const def = usedColumns(DEFENSE_COLS, rows);
  const teamW = Math.max(4, ...rows.map((r) => asciiName(r.franchise_name).slice(0, 16).length));
  const cells = (r, cols) => cols.map(([key]) => {
    const n = Number((r.lineup_deficits || {})[key] || 0);
    return padStart(n ? String(n) : "·", 3);
  }).join(" ");

  L.push("```");
  L.push(
    `${padEnd("TEAM", teamW)} │ ${off.map(([, lbl]) => padStart(lbl, 3)).join(" ")} ` +
    `│ ${def.map(([, lbl]) => padStart(lbl, 3)).join(" ")} │ TOT`
  );
  // Floor at 0: usedColumns() drops all-zero columns, so once the league needs
  // no offense (or no defense) at all, the side goes empty and repeat(-1) throws
  // a RangeError that kills the ENTIRE report — the likeliest night for that is
  // the end of the auction, when the report matters most.
  L.push(
    "─".repeat(teamW) + "─┼─" + "─".repeat(Math.max(0, off.length * 4 - 1)) +
    "─┼─" + "─".repeat(Math.max(0, def.length * 4 - 1)) + "─┼────"
  );
  for (const r of rows.slice().sort((a, b) => Number(b.total_deficit || 0) - Number(a.total_deficit || 0))) {
    L.push(
      `${padEnd(asciiName(r.franchise_name).slice(0, 16), teamW)} │ ${cells(r, off)} ` +
      `│ ${cells(r, def)} │ ${padStart(String(Number(r.total_deficit || 0)), 3)}`
    );
  }
  L.push("```");

  const hidden = [...OFFENSE_COLS.filter((c) => !off.includes(c)), ...DEFENSE_COLS.filter((c) => !def.includes(c))]
    .map(([, lbl]) => lbl);
  L.push(
    "_Offense │ Defense │ Total · `·` = none needed" +
    (hidden.length ? ` · ${hidden.join(", ")} hidden (nobody needs one)` : "") + "._"
  );
  out.push(L.join("\n"));
  return out;
}

// Pack whole sections into Discord messages. Sections are NEVER split: a naive
// slice(0, 2000) can cut inside a ``` fence, which Discord then renders as an
// unterminated code block that swallows the rest of the thread. A section that
// exceeds the limit on its own is emitted alone and truncated at a line break
// with the fence closed, so the worst case is a short table, not a broken one.
const DISCORD_LIMIT = 2000;
function packMessages(sections, limit = DISCORD_LIMIT) {
  const msgs = [];
  let cur = "";
  for (const s of sections.filter(Boolean)) {
    if (s.length > limit) {
      if (cur) { msgs.push(cur); cur = ""; }
      msgs.push(truncateKeepingFences(s, limit));
      continue;
    }
    const next = cur ? `${cur}\n${s}` : s;
    if (next.length > limit) { msgs.push(cur); cur = s; } else { cur = next; }
  }
  if (cur) msgs.push(cur);
  return msgs;
}
function truncateKeepingFences(s, limit) {
  const tail = "\n… (truncated)";
  const lines = s.split("\n");
  const out = [];
  let len = 0;
  for (const line of lines) {
    if (len + line.length + 1 > limit - tail.length - 4) break;
    out.push(line); len += line.length + 1;
  }
  // An odd fence count means we stopped inside a code block — close it.
  if (out.filter((l) => l.trim().startsWith("```")).length % 2 === 1) out.push("```");
  return out.join("\n") + tail;
}

async function fetchJson(env, path) {
  const res = await env.SELF.fetch(`https://self.invalid${path}`);
  return await res.json();
}

// Discord: hang a public thread off the parent message. One thread per message
// is a hard Discord limit, which is fine — one report, one thread.
async function createThreadOnMessage(env, channelId, messageId, name) {
  const token = safeStr(env.DISCORD_BOT_TOKEN || env.DISCORD_BOT || env.Discord_bot || "");
  if (!token) return { ok: false, status: 0 };
  const res = await fetch(
    `https://discord.com/api/v10/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(messageId)}/threads`,
    {
      method: "POST",
      headers: { Authorization: `Bot ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: String(name || "Daily Report").slice(0, 100), auto_archive_duration: 1440 }),
    }
  );
  const text = await res.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch (_) {}
  return { ok: res.ok, status: res.status, data: json };
}

// opts: { leagueId, season, channelId, dryRun, force, mode }
//   mode   = "morning" (9 AM — yesterday's verdict) | "evening" (9 PM — today's
//            warning). Defaults from the ET hour so the cron doesn't have to know.
//   dryRun = build + return the previews but post nothing, and DO NOT close the
//            day or book any penalty. A dry run must never move money.
//   force  = bypass the enable/faa gates (admin test only).
export async function runFaNightlyJob(env, opts = {}) {
  const leagueId = safeStr(opts.leagueId || env.LEAGUE_ID || "74598");
  const season = safeStr(opts.season || new Date().getUTCFullYear());
  const etHour = Number(new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", hour: "numeric", hour12: false,
  }).format(new Date()));
  const mode = safeStr(opts.mode) || (etHour < 12 ? "morning" : "evening");
  const out = {
    ok: false, mode, dry_run: !!opts.dryRun, forced: !!opts.force,
    posted: false, thread_posted: false, owners_owing: 0, owners_tagged: 0,
  };

  if (!opts.force) {
    if (!(await getFeatureFlag(env, "AUCTION_NIGHTLY_NUDGE_ENABLED"))) return { ...out, skipped: "nudge_disabled" };
    if (!(await getFeatureFlag(env, "AUCTION_FAA_ENABLED"))) return { ...out, skipped: "faa_not_live" };
  }

  let data;
  try {
    data = await fetchJson(env, `/api/auction/fa-schedule?L=${encodeURIComponent(leagueId)}&YEAR=${encodeURIComponent(season)}`);
  } catch (e) { return { ...out, error: "fa_schedule_fetch_failed: " + (e?.message || e) }; }
  if (!data || !data.ok) return { ...out, error: (data && data.error) || "fa_schedule_not_ok" };

  // Everything below is the thread's payload only — any of it failing must not
  // sink the report, so each fails soft to an empty section.
  const qs = `L=${encodeURIComponent(leagueId)}&YEAR=${encodeURIComponent(season)}`;
  let lots = [], allLots = [], bids = [], capSpaceDollars = 0;
  try {
    const lotsRes = await fetchJson(env, `/api/auction/lots?${qs}&status=all`);
    allLots = (lotsRes && lotsRes.lots) || [];
    lots = allLots.filter((l) => String(l.status) === "open");
  } catch (e) { out.lots_error = String(e?.message || e); }
  try {
    const bhRes = await fetchJson(env, `/api/auction/bid-history?${qs}&limit=1000`);
    bids = (bhRes && bhRes.bids) || [];
  } catch (e) { out.bids_error = String(e?.message || e); }
  try {
    // Sum of every franchise's available funds. Fetched with NO viewer, which is
    // exactly right for a public league total: the per-team allocation is
    // viewer-scoped, so with no cookie it nets out only the PUBLIC current bid
    // and can never leak anyone's proxy ceiling into the report.
    const liveRes = await fetchJson(env, `/acquisition-hub/free-agent-auction/live?${qs}`);
    const budgets = (liveRes && liveRes.team_budget_rows) || [];
    // adjustments_ok false => the adjustments feed failed and every "available"
    // is overstated. Publishing that as "the bottom line" would be a lie, so
    // drop the number rather than print a wrong one.
    if (liveRes && liveRes.adjustments_ok && budgets.length) {
      capSpaceDollars = budgets.reduce((n, r) => n + Number(r.available_funds_dollars || 0), 0);
    } else {
      out.cap_space_error = "adjustments_unavailable";
    }
  } catch (e) { out.cap_space_error = String(e?.message || e); }

  // Wins SINCE THE LAST REPORT, FAA only. With two reports a day the window is
  // 12h, not 24 — a 24h window would report the same win twice (Keith: "identify
  // recent wins since the last report").
  const REPORT_WINDOW_SEC = 12 * 3600;
  const nowUnix = Math.floor(Date.now() / 1000);
  const wonRecent = allLots.filter((l) =>
    String(l.status) === "won" &&
    !l.is_era_eligible &&
    Number(l.won_at_unix || 0) > 0 &&
    (nowUnix - Number(l.won_at_unix)) <= REPORT_WINDOW_SEC
  );
  const bidsByPid = {};
  for (const b of bids) (bidsByPid[String(b.player_id)] ||= []).push(b);
  out.won_last_24h = wonRecent.length;

  const max = Number(data.noms_max || 2);

  // ---- MORNING: close yesterday and book §F RULE 2 penalties ----
  // This is the only place a fine is created, and it happens exactly once per
  // ET day (closeEtDay is idempotent — the cron may retry and must never
  // double-fine). A dry run computes nothing and writes nothing.
  let closed = null;
  const penaltiesArmed = await getFeatureFlag(env, "AUCTION_FAA_PENALTIES_ENABLED");
  out.penalties_armed = penaltiesArmed;
  if (mode === "morning" && !opts.dryRun) {
    try {
      const yesterday = previousEtDay(etDayKeyOf(Math.floor(Date.now() / 1000)));
      // rows supply the franchise list + roster state ONLY. closeEtDay counts
      // the day's nominations from the bid ledger — fa-schedule's noms_used
      // describes the CURRENT window, which at 9 AM has already reset to zero.
      closed = await closeEtDay(env, { season, leagueId, etDay: yesterday, rows: data.rows || [] });
      if (closed && closed.ok === false && closed.error === "ledger_stale") {
        // The poll hasn't completed a run since the day ended, so the bid
        // ledger can't be trusted for a verdict. closed stays null: nothing is
        // judged, nobody is named, and the league post below is skipped
        // entirely — a wrong "X missed" in #transactions is exactly the kind
        // of confidently-stale statement that burned the Josh Allen board.
        out.close_error = "ledger_stale";
        out.ledger_stale_day = closed.day;
        out.poll_last_ts = closed.poll_last_ts;
        closed = null;
      } else {
        out.closed_day = closed?.day;
        out.already_closed = !!closed?.already_closed;
        out.misses_yesterday = (closed?.misses || []).length;
      }
    } catch (e) { out.close_error = String(e?.message || e); }
  }
  const standings = await complianceStandings(env, { season, leagueId }).catch(() => new Map());
  // Stamp each miss with its offense number for the report copy.
  for (const m of (closed?.misses || [])) {
    const p = (closed.penalties || []).find((x) => x.fid === m.fid);
    const st = standings.get(m.fid) || {};
    standings.set(m.fid, { ...st, offense_no: p?.offense_no || st.offenses || 1 });
  }

  // Same predicate as the scoreboard — the endpoint's verdict, not a recompute.
  // This drives the @-mention allowlist, so getting it wrong pings the wrong owner.
  // Morning tags YESTERDAY's confirmed misses; evening tags who still owes TODAY.
  const owing = mode === "morning"
    ? (closed?.misses || []).map((m) => ({ franchise_id: m.fid, franchise_name: m.franchise_name }))
    : (data.rows || []).filter((r) => !!r.out_of_compliance && Number(r.noms_used || 0) <= max);
  out.owners_owing = owing.length;

  // Resolve real Discord ids for the owners who owe. A franchise with no linked
  // Discord account just renders untagged — never blocks the report.
  const mentionsByFid = {};
  const mentionIds = [];
  for (const r of owing) {
    let ids = [];
    try { ids = await resolveDiscordUserIds(env, r.franchise_id); } catch (_) {}
    if (ids && ids.length) {
      mentionsByFid[r.franchise_id] = ids;
      for (const id of ids) if (!mentionIds.includes(id)) mentionIds.push(id);
    }
  }
  out.owners_tagged = Object.keys(mentionsByFid).length;

  out.parent_preview = mode === "morning"
    ? buildMorningMessage(data, closed, standings, mentionsByFid, penaltiesArmed)
    : buildParentMessage(data, mentionsByFid);
  // Won first (what closed), then RULE 2 standings, then the live board, then
  // what everyone still needs.
  const threadMessages = packMessages([
    // Suppressed when nothing closed, and when cap space is unavailable the
    // headline would be wrong — so it only renders with a real number.
    out.cap_space_error ? null : buildWonSection(wonRecent, bidsByPid, capSpaceDollars),
    buildStandingsSection(data.rows || [], standings),
    ...buildBoardSections(data, lots),
  ]);
  out.thread_preview = threadMessages.join("\n\n———\n\n");
  out.thread_message_count = threadMessages.length;

  const channelId = safeStr(opts.channelId).replace(/\D/g, "");
  if (!channelId || opts.dryRun) { out.ok = true; return out; }

  // A deferred verdict never goes to the league. The morning report's whole
  // job is yesterday's verdict; posting it built from a stale ledger names the
  // wrong owners, and posting a "we don't know yet" banner is noise. Skip the
  // channel, tell the commish privately, and let the re-run post the real one.
  if (mode === "morning" && out.close_error === "ledger_stale") {
    try {
      // COMMISH_DISCORD_USER_ID is a COMMA-SEPARATED LIST. The old
      // .replace(/\D/g,"") stripped the comma and glued the two ids into one
      // impossible 37-digit snowflake, so this "we skipped the 9 AM report"
      // notice silently went nowhere — the failure mode was invisible by
      // construction. Split, and DM each configured commish (Keith 2026-07-27).
      const ids = safeStr(env.COMMISH_DISCORD_USER_ID || "")
        .split(",")
        .map((s) => s.replace(/\D/g, "").trim())
        .filter((s) => /^\d{15,20}$/.test(s));
      const content = [
        `⏸️ **9 AM report NOT posted — bid ledger is stale.**`,
        `The auction poll hasn't completed a run since **${out.ledger_stale_day}** (ET) ended, so yesterday can't be judged without risking wrong misses/fines.`,
        `Fix: run the poll (\`POST /admin/auction/poll-now?APIKEY=…\`), then re-run the morning job (\`POST /admin/auction/run-nightly-nudge\`) — it will close ${out.ledger_stale_day} and post the real report. Nothing was fined, nothing was posted.`,
      ].join("\n");
      for (const uid of ids) {
        try {
          const dmCh = await openDmChannel(env, uid);
          if (dmCh) {
            await sendDm(env, dmCh, { content, allowed_mentions: { parse: [] } });
            out.commish_dm = true;
          }
        } catch (_) { /* one bad recipient must not block the others */ }
      }
    } catch (e) { out.commish_dm_error = String(e?.message || e); }
    out.skipped = "ledger_stale";
    out.ok = true;
    return out;
  }

  // One league post per (mode, ET day), atomically claimed. The report now has
  // two possible triggers on the same clock — the CF cron and the launchd
  // stand-in installed during the 2026-07-15 cron outage — and when Cloudflare
  // revives the cron both would fire at 9:00/21:00 ET. First to claim the slot
  // posts; the loser exits with already_posted_today. force=1 bypasses (a
  // deliberate commish re-run). If the post then FAILS, the claim is released
  // so a retry isn't locked out of the whole day.
  const postClaimKey = `faa_report:${mode}:${etDayKeyOf(Math.floor(Date.now() / 1000))}`;
  if (!opts.force && env.UPS_MFL_DB) {
    try {
      const claim = await env.UPS_MFL_DB.prepare(
        `INSERT OR IGNORE INTO ups_bot_heartbeat (bot, last_ts, status, env) VALUES (?, ?, 'posted', '')`
      ).bind(postClaimKey, Math.floor(Date.now() / 1000)).run();
      if (!claim?.meta || claim.meta.changes === 0) {
        out.skipped = "already_posted_today";
        out.ok = true;
        return out;
      }
    } catch (_) { /* dedupe unavailable → post rather than silently skip */ }
  }
  const releasePostClaim = async () => {
    try {
      await env.UPS_MFL_DB.prepare(`DELETE FROM ups_bot_heartbeat WHERE bot = ?`).bind(postClaimKey).run();
    } catch (_) { /* best effort */ }
  };

  // Parent — allowed_mentions is an explicit allowlist of exactly the owners we
  // tagged, so a franchise name that happens to look like a role can't ping the
  // league. These SHOULD notify: the tag is the nudge.
  const parent = await sendDm(env, channelId, {
    content: out.parent_preview.slice(0, 2000),
    allowed_mentions: { parse: [], users: mentionIds },
  });
  out.posted = !!(parent && parent.ok);
  if (!out.posted) {
    out.post_error = `discord ${parent && parent.status}`;
    await releasePostClaim();
    return { ...out, ok: true };
  }

  const parentId = safeStr(parent.data?.id || "");
  if (!parentId) { out.thread_error = "no_parent_message_id"; return { ...out, ok: true }; }

  const thread = await createThreadOnMessage(
    env, channelId, parentId, `FA Auction — ${data.window_key || "Daily"} detail`
  );
  if (!thread.ok) { out.thread_error = `thread_create ${thread.status}`; return { ...out, ok: true }; }

  const threadId = safeStr(thread.data?.id || "");
  let sent = 0;
  for (const msg of threadMessages) {
    const body = await sendDm(env, threadId, { content: msg, allowed_mentions: { parse: [] } });
    if (!(body && body.ok)) { out.thread_error = `discord ${body && body.status} on part ${sent + 1}`; break; }
    sent += 1;
  }
  out.thread_parts_sent = sent;
  out.thread_posted = sent === threadMessages.length;

  out.ok = true;
  return out;
}
