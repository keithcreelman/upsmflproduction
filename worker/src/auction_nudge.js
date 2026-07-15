// auction_nudge.js — nightly 9:30 PM ET FA-Auction daily report.
//
// Once a night during the live FA Auction this posts ONE parent message to the
// Auction Bidding channel (the nomination scoreboard, tagging only the owners
// who still owe) and hangs a thread off it carrying the detail: open lots with
// their leaders, and the positions-remaining matrix.
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
// Data comes from /api/auction/fa-schedule + /api/auction/lots via env.SELF.fetch,
// so the scoreboard owners see in the app is exactly what drives the report.

import { getFeatureFlag } from "./feature_flags.js";
import { resolveDiscordUserIds } from "./trade_dm.js";
import { sendDm } from "./discord_round.js";

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

// ---------- PARENT: the nomination scoreboard ----------
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
  // not rounded hours: at 9:30 PM exactly 2h30m remain, and Math.round would say
  // "3 hours" — pushing a §A2 deadline (with a §F fine behind it) half an hour
  // past midnight. Flooring instead reads "0 hours" on a late manual trigger.
  const timeLeft = humanDuration(Math.max(0,
    Number(rows[0]?.seconds_until_reset ??
      (Number(data.window_end_unix || 0) - Number(data.now_unix || 0)))
  ));

  const L = [];
  L.push("# 🧪 TEST REPORT — NOBODY IS REQUIRED TO BID TONIGHT");
  L.push("### 🏈 FA AUCTION — DAILY · 9:30 PM ET");
  L.push("_Shaking this down before the real auction. **Numbers are live.**_");
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

// ---------- THREAD §1: what closed in the last 24h ----------
// Suppressed entirely when nothing closed — on Day 1 nothing can, since the
// first lots don't lock for 24h, and an empty "Players won: 0" table is noise
// (Keith 2026-07-14). ERA wins are excluded: they're a different auction under
// §A3 and stay out of FAA counts (PR #705).
function buildWonSection(won, bidsByPid, capSpaceDollars) {
  if (!won.length) return null;
  const capSpentK = won.reduce((n, l) => n + Math.round(Number(l.current_high_bid_k || 0)), 0);
  const L = [];
  L.push("**🏆 WON — LAST 24 HOURS**");
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

// opts: { leagueId, season, channelId, dryRun, force }
//   dryRun = build + return the previews but post nothing.
//   force  = bypass the enable/faa gates (admin test only).
export async function runFaNightlyJob(env, opts = {}) {
  const leagueId = safeStr(opts.leagueId || env.LEAGUE_ID || "74598");
  const season = safeStr(opts.season || new Date().getUTCFullYear());
  const out = {
    ok: false, dry_run: !!opts.dryRun, forced: !!opts.force,
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

  // Wins in the trailing 24h, FAA only.
  const nowUnix = Math.floor(Date.now() / 1000);
  const wonRecent = allLots.filter((l) =>
    String(l.status) === "won" &&
    !l.is_era_eligible &&
    Number(l.won_at_unix || 0) > 0 &&
    (nowUnix - Number(l.won_at_unix)) <= 86400
  );
  const bidsByPid = {};
  for (const b of bids) (bidsByPid[String(b.player_id)] ||= []).push(b);
  out.won_last_24h = wonRecent.length;

  const max = Number(data.noms_max || 2);
  // Same predicate as the scoreboard — the endpoint's verdict, not a recompute.
  // This drives the @-mention allowlist, so getting it wrong pings the wrong owner.
  const owing = (data.rows || []).filter((r) => !!r.out_of_compliance && Number(r.noms_used || 0) <= max);
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

  out.parent_preview = buildParentMessage(data, mentionsByFid);
  // Won first (what closed), then the live board, then what everyone still needs.
  const threadMessages = packMessages([
    // Suppressed when nothing closed, and when cap space is unavailable the
    // headline would be wrong — so it only renders with a real number.
    out.cap_space_error ? null : buildWonSection(wonRecent, bidsByPid, capSpaceDollars),
    ...buildBoardSections(data, lots),
  ]);
  out.thread_preview = threadMessages.join("\n\n———\n\n");
  out.thread_message_count = threadMessages.length;

  const channelId = safeStr(opts.channelId).replace(/\D/g, "");
  if (!channelId || opts.dryRun) { out.ok = true; return out; }

  // Parent — allowed_mentions is an explicit allowlist of exactly the owners we
  // tagged, so a franchise name that happens to look like a role can't ping the
  // league. These SHOULD notify: the tag is the nudge.
  const parent = await sendDm(env, channelId, {
    content: out.parent_preview.slice(0, 2000),
    allowed_mentions: { parse: [], users: mentionIds },
  });
  out.posted = !!(parent && parent.ok);
  if (!out.posted) { out.post_error = `discord ${parent && parent.status}`; return { ...out, ok: true }; }

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
