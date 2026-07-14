// auction_nudge.js — nightly 9 PM ET FA-Auction compliance nudge.
//
// Once a night during the live FA Auction this:
//   1. Posts an out-of-compliance summary to the Auction Bidding Discord
//      channel (who still owes nominations to fill a legal lineup).
//   2. DMs each owner who still owes their personal nudge.
//
// Gated DARK by default — nothing sends unless ALL of these hold:
//   • AUCTION_NIGHTLY_NUDGE_ENABLED = "1"  (master kill switch, FO panel)
//   • AUCTION_FAA_ENABLED          = "1"  (only while the auction is live)
//   • the owner is on AUCTION_NUDGE_TEST_FRANCHISES (empty CSV = everyone)
//
// Compliance data comes from /api/auction/fa-schedule via env.SELF.fetch, so
// the scoreboard the owners see in the app is exactly what drives the nudge.

import { getFeatureFlag } from "./feature_flags.js";
import { resolveDiscordUserIds, dmAll } from "./trade_dm.js";
import { sendDm } from "./discord_round.js";

function safeStr(v) { return String(v == null ? "" : v).trim(); }
function padFid(v) { const d = safeStr(v).replace(/\D/g, ""); return d ? d.padStart(4, "0") : ""; }
function plural(n, one, many) { return Number(n) === 1 ? one : (many || one + "s"); }

// Rollout allowlist — empty = every owner (go-live). Mirrors TRADE_DM_*.
function nudgeAllowlist(env) {
  return safeStr(env.AUCTION_NUDGE_TEST_FRANCHISES).split(",").map(padFid).filter(Boolean);
}
function nudgeTargetAllowed(env, fid) {
  const list = nudgeAllowlist(env);
  if (!list.length) return true;
  return list.includes(padFid(fid));
}

// The Auction-Bidding channel post — a nightly compliance roll-up.
function buildChannelMessage(data) {
  const rows = data.rows || [];
  const owing = rows.filter((r) => r.out_of_compliance);
  const met = rows.filter((r) => r.roster_met);
  const lines = ["**🏈 FA Auction — Nightly Nomination Check**"];
  if (!owing.length) {
    lines.push("✅ Everyone who still needs roster spots has made their nominations today. Nicely done.");
  } else {
    lines.push(`⚠️ **${owing.length}** ${plural(owing.length, "team", "teams")} still ${plural(owing.length, "owes", "owe")} nominations today:`);
    for (const r of owing) {
      lines.push(`• **${r.franchise_name}** — ${r.noms_remaining} of ${r.noms_required} noms left · ${r.total_deficit} roster ${plural(r.total_deficit, "gap", "gaps")} to fill`);
    }
    lines.push("");
    lines.push("_You must make your daily nominations until you can field a legal lineup. Windows are ET calendar days — everyone resets at midnight ET. 2 is the floor AND the ceiling: a 3rd nomination in the same day is a rules violation._");
  }
  if (met.length) {
    lines.push("");
    lines.push(`🟢 ${met.length} ${plural(met.length, "team has", "teams have")} met the roster requirement — continuing is optional.`);
  }
  return lines.join("\n");
}

// Per-owner DM body for someone who still owes.
function buildOwnerDm(row) {
  return {
    content:
      `**FA Auction nudge — ${row.franchise_name}**\n` +
      `You still need to make **${row.noms_remaining}** of your ${row.noms_required} nominations today, ` +
      `and you have **${row.total_deficit}** roster ${plural(row.total_deficit, "spot", "spots")} to fill before you can field a legal lineup.\n` +
      `Nominate in the app (FA Auction → Players) or on MFL. Once you've met the roster requirement you can stop. ` +
      `Either way, ${row.noms_required} per day is the cap — don't nominate a 3rd. Your window resets at midnight ET.`,
    allowed_mentions: { parse: [] },
  };
}

// Fetch the compliance scoreboard from our own endpoint.
async function fetchSchedule(env, leagueId, season) {
  const res = await env.SELF.fetch(
    `https://self.invalid/api/auction/fa-schedule?L=${encodeURIComponent(leagueId)}&YEAR=${encodeURIComponent(season)}`
  );
  return await res.json();
}

// opts: { leagueId, season, channelId, dryRun, force }
//   dryRun = compute + return the preview but DON'T post/DM.
//   force  = bypass the enable/faa gates (admin test only).
export async function runFaNightlyJob(env, opts = {}) {
  const leagueId = safeStr(opts.leagueId || env.LEAGUE_ID || "74598");
  const season = safeStr(opts.season || new Date().getUTCFullYear());
  const out = {
    ok: false, dry_run: !!opts.dryRun, forced: !!opts.force,
    posted: false, dms_sent: 0, dms_skipped: 0, owners_owing: 0,
  };

  if (!opts.force) {
    if (!(await getFeatureFlag(env, "AUCTION_NIGHTLY_NUDGE_ENABLED"))) return { ...out, skipped: "nudge_disabled" };
    if (!(await getFeatureFlag(env, "AUCTION_FAA_ENABLED"))) return { ...out, skipped: "faa_not_live" };
  }

  let data;
  try { data = await fetchSchedule(env, leagueId, season); }
  catch (e) { return { ...out, error: "fa_schedule_fetch_failed: " + (e && e.message || e) }; }
  if (!data || !data.ok) return { ...out, error: (data && data.error) || "fa_schedule_not_ok" };

  const owing = (data.rows || []).filter((r) => r.out_of_compliance);
  out.owners_owing = owing.length;

  // 1) Channel post (sendDm posts to /channels/{id}/messages — works for a
  //    public channel just the same).
  const channelId = safeStr(opts.channelId).replace(/\D/g, "");
  out.channel_preview = buildChannelMessage(data);
  if (channelId && !opts.dryRun) {
    const r = await sendDm(env, channelId, { content: out.channel_preview, allowed_mentions: { parse: [] } });
    out.posted = !!(r && r.ok);
    if (!out.posted) out.post_error = `discord ${r && r.status}`;
  }

  // 2) DM each owner who still owes (allowlist-gated).
  for (const row of owing) {
    if (!nudgeTargetAllowed(env, row.franchise_id)) { out.dms_skipped++; continue; }
    let userIds = [];
    try { userIds = await resolveDiscordUserIds(env, row.franchise_id); } catch (_) {}
    if (!userIds || !userIds.length) { out.dms_skipped++; continue; }
    if (opts.dryRun) { out.dms_sent += userIds.length; continue; }
    try {
      const r = await dmAll(env, userIds, buildOwnerDm(row));
      out.dms_sent += Number(r && r.sent) || 0;
    } catch (_) { /* one bad DM shouldn't abort the sweep */ }
  }

  out.ok = true;
  return out;
}
