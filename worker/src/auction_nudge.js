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

  const over = rows.filter((r) => used(r) > max);
  const met = rows.filter((r) => used(r) === max);
  const owe = rows.filter((r) => used(r) < max);
  const byName = (a, b) => asciiName(a.franchise_name).localeCompare(asciiName(b.franchise_name));
  const byUsedDesc = (a, b) => (used(b) - used(a)) || byName(a, b);

  // Hours left in the ET nomination day, from the payload's own clock — NOT
  // hardcoded, so a late/retried cron still states the truth.
  const secsLeft = Number(
    rows[0]?.seconds_until_reset ??
    (Number(data.window_end_unix || 0) - Number(data.now_unix || 0))
  );
  const hoursLeft = Math.max(0, Math.round(secsLeft / 3600));

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
      L.push(`${isOver ? "⚠️" : "✅"} **${r.franchise_name}** — ${used(r)}/${max}${isOver ? " · **over cap**" : ""}`);
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
    const names = over.map((r) => `**${r.franchise_name}**`).join(", ");
    L.push(
      `🛠️ _${names} shows ${used(over[0])}/${max} — that 3rd nomination slipped through before the cap ` +
      `existed. Fix implemented to prevent 3 nominations except on the final day moving forward._`
    );
    L.push("");
  }

  if (owe.length) {
    L.push(`**Out of compliance teams — please submit your nominations within the next ${hoursLeft} ${plural(hoursLeft, "hour")}.**`);
  }
  L.push("Open lots, leaders + what everyone still needs → **thread** 🧵");
  return L.join("\n");
}

// ---------- THREAD: open lots + positions matrix ----------
function buildThreadMessage(data, lots) {
  const rows = data.rows || [];
  const open = (lots || []).filter((l) => String(l.status) === "open");
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
  L.push(
    "─".repeat(teamW) + "─┼─" + "─".repeat(off.length * 4 - 1) +
    "─┼─" + "─".repeat(def.length * 4 - 1) + "─┼────"
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
  return L.join("\n");
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

  // Lots are the thread's payload only — a lots failure must not sink the
  // report, so fail soft to an empty board.
  let lots = [];
  try {
    const lotsRes = await fetchJson(env, `/api/auction/lots?L=${encodeURIComponent(leagueId)}&YEAR=${encodeURIComponent(season)}&status=open`);
    lots = (lotsRes && lotsRes.lots) || [];
  } catch (e) { out.lots_error = String(e?.message || e); }

  const max = Number(data.noms_max || 2);
  const owing = (data.rows || []).filter((r) => Number(r.noms_used || 0) < max);
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
  out.thread_preview = buildThreadMessage(data, lots);

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
  const body = await sendDm(env, threadId, {
    content: out.thread_preview.slice(0, 2000),
    allowed_mentions: { parse: [] },
  });
  out.thread_posted = !!(body && body.ok);
  if (!out.thread_posted) out.thread_error = `discord ${body && body.status}`;

  out.ok = true;
  return out;
}
