// worker/src/discord_round.js
// UPS League Hall — thread-based vote round (Keith 2026-05-06 rebuild).
//
// Architecture: each rule in a round gets its own public thread in the
// rules channel, spawned off a pinned kickoff anchor. All voting +
// commenting + AI explainer activity happens in that thread.
//
// Lock rules (post threshold-hit):
//   • Threshold-hit moment → verdict is locked, but late votes from
//     non-voters are still accepted indefinitely.
//   • 5 minutes after threshold-hit → already-cast votes lock (no more
//     vote-changes for owners who voted before threshold).
//   • At /rules close → all voting ends; buttons disabled.
//
// On lock: the bot posts a per-rule impact analysis in the thread, edits
// the pinned tally, and posts a one-line "Rule X passed/rejected" notice
// to the cross-channel announce channel (DISCORD_ANNOUNCE_CHANNEL_ID,
// defaulting to DISCORD_RULES_CHANNEL_ID for testing).

import { callExplain, callImpactAnalysis } from "./anthropic_explain.js";

// ---------- Discord constants ----------
const RESPONSE_TYPE = {
  PONG: 1,
  CHANNEL_MESSAGE_WITH_SOURCE: 4,
  DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE: 5,
  DEFERRED_UPDATE_MESSAGE: 6,
  UPDATE_MESSAGE: 7,
  MODAL: 9,
};
const FLAG_EPHEMERAL = 64;

const BUTTON_STYLE = {
  PRIMARY: 1, SECONDARY: 2, SUCCESS: 3, DANGER: 4, LINK: 5,
};
const COMPONENT_TYPE = { ACTION_ROW: 1, BUTTON: 2, TEXT_INPUT: 4 };
const TEXT_INPUT_STYLE = { SHORT: 1, PARAGRAPH: 2 };

// 5-min vote-change lock window per Keith spec. Already-cast votes lock
// 5 minutes after threshold-hit; non-voters can still vote indefinitely
// (until /rules close).
const VOTE_CHANGE_LOCK_MINUTES = 5;

// Discord thread auto-archive: max allowed (7 days). Threads stay visible
// in the rules-channel sidebar until 7 days of zero activity.
const THREAD_AUTO_ARCHIVE_MINUTES = 10080;

// ---------- Tiny helpers ----------
function safeStr(v) { return String(v == null ? "" : v).trim(); }
function nowIso() { return new Date().toISOString(); }

// Format an ISO timestamp in US Eastern Time (auto-handles EST/EDT via Intl).
//   "May 6, 2026 at 12:07 PM EDT"
function formatDeadlineEt(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  try {
    // Pull the date parts from the ET timezone via Intl.
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
      timeZoneName: "short",
    }).formatToParts(d);
    const get = (t) => (parts.find((p) => p.type === t) || {}).value || "";
    const mon = get("month"); const day = get("day"); const yr = get("year");
    const hr = get("hour"); const mm = get("minute"); const dp = get("dayPeriod");
    const tz = get("timeZoneName");
    return `${mon} ${day}, ${yr} at ${hr}:${mm} ${dp} ${tz}`;
  } catch (_) {
    // Fallback to UTC string if Intl fails (shouldn't on Workers).
    return d.toUTCString();
  }
}
// Backwards-compat alias — older call sites referenced formatDeadlineUtc.
export const formatDeadlineUtc = formatDeadlineEt;
function jsonResponse(payload, status) {
  return new Response(JSON.stringify(payload), {
    status: status || 200,
    headers: { "content-type": "application/json" },
  });
}
function ephemeral(content) {
  return jsonResponse({
    type: RESPONSE_TYPE.CHANNEL_MESSAGE_WITH_SOURCE,
    data: { content: String(content || "").slice(0, 2000), flags: FLAG_EPHEMERAL },
  });
}
function getCallerId(interaction) {
  return safeStr(interaction?.member?.user?.id || interaction?.user?.id || "");
}
function getCallerName(interaction) {
  return safeStr(
    interaction?.member?.user?.global_name ||
    interaction?.member?.user?.username ||
    interaction?.user?.global_name ||
    interaction?.user?.username || ""
  );
}
function isCommish(interaction, env) {
  const expected = safeStr(env.COMMISH_DISCORD_USER_ID || "");
  if (!expected) return true; // open mode for solo test convenience
  return getCallerId(interaction) === expected;
}
function fitToFieldValue(s, max) {
  s = String(s || "");
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

// ---------- Discord REST helpers ----------
async function discordRequest(env, method, apiPath, body) {
  const token = safeStr(env.DISCORD_BOT_TOKEN || env.DISCORD_BOT || env.Discord_bot || "");
  if (!token) {
    return { ok: false, status: 0, error: "missing_bot_token", text: "no bot token in worker secrets" };
  }
  const res = await fetch(`https://discord.com/api/v10${apiPath}`, {
    method,
    headers: { Authorization: `Bot ${token}`, "Content-Type": "application/json" },
    body: body == null ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data = null; try { data = text ? JSON.parse(text) : null; } catch (_) {}
  return { ok: res.ok, status: res.status, data, text };
}
const discordPost = (env, p, b) => discordRequest(env, "POST", p, b);
const discordPatch = (env, p, b) => discordRequest(env, "PATCH", p, b);

export async function openDmChannel(env, userId) {
  const cleanId = safeStr(userId).replace(/\D/g, "");
  const r = await discordPost(env, "/users/@me/channels", { recipient_id: cleanId });
  return r.ok ? safeStr(r.data?.id || "") : "";
}
export async function sendDm(env, channelId, payload) {
  // DMs stay noisy — kickoff + nudges are directed messages and the user
  // expects a notification (that's the whole point).
  return await discordPost(env, `/channels/${encodeURIComponent(channelId)}/messages`, {
    ...payload,
    allowed_mentions: payload.allowed_mentions || { parse: [] },
  });
}
// SUPPRESS_NOTIFICATIONS = 1 << 12 (4096). Discord renders the message
// normally but no push/desktop/mobile notification fires. We default
// every server-channel + thread post to silent so the league isn't pinged
// once per anchor / thread / proposal / tally / vote line / comment.
// The ONLY exception is the final cross-channel "Rule PASSED/REJECTED"
// announcement — the caller explicitly passes { silent: false } there.
// DMs (kickoff + nudges) always notify (different helper).
const MSG_FLAGS_SILENT = 1 << 12;
export async function postChannelMessage(env, channelId, payload, opts = {}) {
  const silent = opts.silent !== false; // default true
  return await discordPost(env, `/channels/${encodeURIComponent(channelId)}/messages`, {
    ...payload,
    flags: (payload.flags || 0) | (silent ? MSG_FLAGS_SILENT : 0),
    allowed_mentions: payload.allowed_mentions || { parse: [] },
  });
}
export async function editMessage(env, channelId, messageId, payload) {
  return await discordPatch(env, `/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(messageId)}`, payload);
}
async function pinMessage(env, channelId, messageId) {
  return await discordRequest(env, "PUT", `/channels/${encodeURIComponent(channelId)}/pins/${encodeURIComponent(messageId)}`);
}
// Create a STANDALONE public thread in the channel (not parented to a specific
// message). Discord only allows one thread per parent message, so anchoring
// all 6 round threads to the kickoff message fails after the first. Standalone
// threads still show in the channel sidebar; the kickoff message just sits
// pinned as the round overview.
//   type 11 = GUILD_PUBLIC_THREAD
async function createStandalonePublicThread(env, channelId, name) {
  return await discordPost(env, `/channels/${encodeURIComponent(channelId)}/threads`, {
    name: fitToFieldValue(name, 95),
    type: 11,
    auto_archive_duration: THREAD_AUTO_ARCHIVE_MINUTES,
  });
}

// Tiny pause helper — small delay between thread creates to be polite to
// Discord's per-channel rate limits.
function sleepMs(ms) { return new Promise((r) => setTimeout(r, ms)); }

function announceChannelId(env) {
  return safeStr(env.DISCORD_ANNOUNCE_CHANNEL_ID || env.DISCORD_RULES_CHANNEL_ID || "").replace(/\D/g, "");
}
function rulesChannelId(env) {
  return safeStr(env.DISCORD_RULES_CHANNEL_ID || "").replace(/\D/g, "");
}
function guildIdFromInteraction(interaction) {
  return safeStr(interaction?.guild_id || "");
}
export function threadDeepLink(guildId, threadId) {
  if (!guildId || !threadId) return "";
  return `https://discord.com/channels/${guildId}/${threadId}`;
}

// ---------- league_events helpers (canonical league deadline calendar) ----------
// Reads from the D1 `league_events` table — the canonical source for any
// league deadline. Source of truth is now D1 (per Keith 2026-05-06).

async function getLeagueEventDate(env, eventName, season) {
  if (!env.UPS_MFL_DB) return null;
  try {
    const { results } = await env.UPS_MFL_DB.prepare(
      "SELECT date FROM league_events WHERE event = ? AND nfl_season = ?"
    ).bind(eventName, String(season)).all();
    return results?.[0]?.date || null;
  } catch (e) {
    // league_events table doesn't exist yet (migration 0026 not applied) or
    // some other DB error — fail soft so the rest of the round flow continues.
    console.log(`[league_events] lookup failed for ${eventName}/${season}: ${e?.message || e}`);
    return null;
  }
}

// Rookie draft = Memorial Day Sunday = ups_rookieextension_deadline (Thu) + 3 days.
// If a 'rookie_draft' row is added to league_events later, that overrides the derivation.
async function getRookieDraftDate(env, season) {
  const explicit = await getLeagueEventDate(env, "rookie_draft", String(season));
  if (explicit) return explicit;
  const ext = await getLeagueEventDate(env, "ups_rookieextension_deadline", String(season));
  if (!ext) return null;
  const d = new Date(`${ext}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 3);
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}

function seasonFromRound(round) {
  if (round?.draft_date_utc) {
    const y = new Date(round.draft_date_utc).getUTCFullYear();
    if (y >= 2010 && y <= 2050) return String(y);
  }
  const m = String(round?.round_id || "").match(/(\d{4})/);
  if (m) return m[1];
  return String(new Date().getUTCFullYear());
}

// Voting deadline coincides with the **tag deadline** (= rookie-extension
// deadline = expired-rookies deadline — all the same calendar date in this
// league: Thursday before Memorial Day). 5 PM ET ≈ 21:00 UTC during EDT.
// Rookie draft itself is on Memorial Day Sunday (tag deadline + 3 days),
// kept on the round record for downstream tooling.
async function deriveVotingDeadlineFromEvents(env, season) {
  const tagDeadline = await getLeagueEventDate(env, "ups_rookieextension_deadline", String(season));
  if (!tagDeadline) return null;
  const draftD = new Date(`${tagDeadline}T00:00:00Z`);
  draftD.setUTCDate(draftD.getUTCDate() + 3);
  const rookieDraftDate = draftD.toISOString().slice(0, 10);
  return {
    tagDeadlineDate: tagDeadline,
    rookieDraftDate,
    draftDateUtc: `${rookieDraftDate}T17:00:00Z`,
    votingDeadlineUtc: `${tagDeadline}T21:00:00Z`,
  };
}

// ---------- D1 helpers ----------
async function getActiveRound(env, roundId) {
  if (roundId) {
    const { results } = await env.UPS_MFL_DB
      .prepare("SELECT * FROM discord_rounds WHERE round_id = ?").bind(roundId).all();
    return results?.[0] || null;
  }
  const { results } = await env.UPS_MFL_DB
    .prepare("SELECT * FROM discord_rounds WHERE status = 'open' ORDER BY started_at_utc DESC LIMIT 1").all();
  return results?.[0] || null;
}
async function getRoundOwners(env, roundId) {
  const { results } = await env.UPS_MFL_DB
    .prepare("SELECT * FROM discord_round_owners WHERE round_id = ? ORDER BY discord_user_id").bind(roundId).all();
  return results || [];
}
async function getOwnerState(env, roundId, discordUserId) {
  const { results } = await env.UPS_MFL_DB
    .prepare("SELECT * FROM discord_round_owners WHERE round_id = ? AND discord_user_id = ?")
    .bind(roundId, discordUserId).all();
  return results?.[0] || null;
}
async function ensureOwnerRow(env, roundId, discordUserId, displayName) {
  const existing = await getOwnerState(env, roundId, discordUserId);
  if (existing) {
    if (displayName && !existing.display_name) {
      await env.UPS_MFL_DB.prepare(`
        UPDATE discord_round_owners SET display_name = ? WHERE round_id = ? AND discord_user_id = ?
      `).bind(displayName, roundId, discordUserId).run();
    }
    return existing;
  }
  await env.UPS_MFL_DB.prepare(`
    INSERT INTO discord_round_owners (round_id, discord_user_id, display_name, state)
    VALUES (?, ?, ?, 'not_started')
  `).bind(roundId, discordUserId, displayName || null).run();
  return await getOwnerState(env, roundId, discordUserId);
}
async function getRoundItems(env, roundId) {
  const { results } = await env.UPS_MFL_DB.prepare(`
    SELECT ri.*, p.title, p.tldr, p.body_md, p.rationale_md, p.supporting_data_md,
           p.type, p.pass_yes_count, p.discussion_only
    FROM discord_round_items ri
    JOIN hall_proposals p ON p.id = ri.proposal_id
    WHERE ri.round_id = ?
    ORDER BY ri.ordinal
  `).bind(roundId).all();
  return results || [];
}
async function getRoundItemByProposal(env, roundId, proposalId) {
  const { results } = await env.UPS_MFL_DB.prepare(`
    SELECT ri.*, p.title, p.tldr, p.body_md, p.rationale_md, p.supporting_data_md,
           p.type, p.pass_yes_count, p.discussion_only
    FROM discord_round_items ri
    JOIN hall_proposals p ON p.id = ri.proposal_id
    WHERE ri.round_id = ? AND ri.proposal_id = ?
  `).bind(roundId, proposalId).all();
  return results?.[0] || null;
}
async function getActiveResponse(env, roundId, proposalId, discordUserId) {
  const { results } = await env.UPS_MFL_DB.prepare(`
    SELECT * FROM discord_responses
    WHERE round_id = ? AND proposal_id = ? AND discord_user_id = ? AND superseded_at_utc IS NULL
  `).bind(roundId, proposalId, discordUserId).all();
  return results?.[0] || null;
}

// Multi-account-aware "has this owner voted yet?" check. Returns the active
// response row from ANY discord_user_id that shares this owner's franchise
// in discord_round_owners. Used by the auto-nudge sweep + /rules status so
// that the commish (who's on two Discord accounts) isn't nudged on his alt
// after voting from his primary.
async function getActiveResponseByFranchise(env, roundId, proposalId, discordUserId) {
  const ownerRow = await env.UPS_MFL_DB.prepare(`
    SELECT franchise_id FROM discord_round_owners
    WHERE round_id = ? AND discord_user_id = ?
  `).bind(roundId, discordUserId).first();
  const franchiseId = safeStr(ownerRow?.franchise_id || "");
  if (!franchiseId) return await getActiveResponse(env, roundId, proposalId, discordUserId);
  const { results } = await env.UPS_MFL_DB.prepare(`
    SELECT r.* FROM discord_responses r
    JOIN discord_round_owners o
      ON o.round_id = r.round_id AND o.discord_user_id = r.discord_user_id
    WHERE r.round_id = ? AND r.proposal_id = ? AND r.superseded_at_utc IS NULL
      AND o.franchise_id = ?
    ORDER BY r.created_at_utc DESC
    LIMIT 1
  `).bind(roundId, proposalId, franchiseId).all();
  return results?.[0] || null;
}
async function getActiveResponsesForProposal(env, roundId, proposalId) {
  const { results } = await env.UPS_MFL_DB.prepare(`
    SELECT * FROM discord_responses
    WHERE round_id = ? AND proposal_id = ? AND superseded_at_utc IS NULL
    ORDER BY created_at_utc
  `).bind(roundId, proposalId).all();
  return results || [];
}

// Per-vote write. Supersedes existing (for vote-change). New vote message
// in the thread is created/edited by the caller and its message_id is
// stored on the inserted row.
//
// Multi-account note: this only supersedes prior votes from the SAME
// discord_user_id. The cross-account "first to vote locks the franchise"
// rule is enforced upstream in classifyVoteAttempt — by the time we hit
// recordVote, we've already confirmed that no OTHER account on the same
// franchise has an active vote (or that this user is the original voter
// changing their own ballot).
async function recordVote(env, roundId, proposalId, discordUserId, value, reasoning, threadMessageId) {
  const ts = nowIso();
  await env.UPS_MFL_DB.prepare(`
    UPDATE discord_responses SET superseded_at_utc = ?
    WHERE round_id = ? AND proposal_id = ? AND discord_user_id = ? AND superseded_at_utc IS NULL
  `).bind(ts, roundId, proposalId, discordUserId).run();
  const r = await env.UPS_MFL_DB.prepare(`
    INSERT INTO discord_responses
      (round_id, proposal_id, discord_user_id, value, reasoning, thread_message_id, created_at_utc)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).bind(roundId, proposalId, discordUserId, value, reasoning || null, threadMessageId || null, ts).run();
  return r?.meta?.last_row_id || null;
}

async function recordComment(env, roundId, proposalId, discordUserId, displayName, body, threadMessageId) {
  return await env.UPS_MFL_DB.prepare(`
    INSERT INTO discord_comments
      (round_id, proposal_id, discord_user_id, display_name, body, thread_message_id, created_at_utc)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).bind(roundId, proposalId, discordUserId, displayName || null, body, threadMessageId || null, nowIso()).run();
}

// ---------- Lock state ----------
function isPastVoteChangeLock(itemRow) {
  if (!itemRow?.votes_locked_at_utc) return false;
  const t = new Date(itemRow.votes_locked_at_utc).getTime();
  if (isNaN(t)) return false;
  return Date.now() >= t;
}

// Decision per Keith's spec:
//   • If the item's threshold has been hit and 5 min have elapsed AND the
//     caller already has an active vote → REJECT (vote is locked).
//   • If a DIFFERENT discord account on the SAME franchise has already
//     voted on this item → REJECT (franchise is locked from this side;
//     the other account stays read-only). Vote-changes go through the
//     account that originally voted, not this one.
//   • If never voted, OR threshold not reached, OR within the 5-min window
//     → ACCEPT.
//   • If round is fully closed (closed_at_utc set) → REJECT all.
async function classifyVoteAttempt(env, round, item, discordUserId) {
  if (round.status !== "open" || round.closed_at_utc) {
    return { allowed: false, reason: "round_closed" };
  }
  const existing = await getActiveResponse(env, round.round_id, item.proposal_id, discordUserId);
  if (item.threshold_reached_at_utc && isPastVoteChangeLock(item) && existing) {
    return { allowed: false, reason: "vote_changes_locked", lockedAt: item.votes_locked_at_utc, existing };
  }

  // Franchise-level lockout: if some OTHER account on the same franchise
  // has already cast an active vote, this account is read-only for the
  // item. The original voter can change their vote from THEIR account
  // (the existing-vote path above handles that within the grace window).
  if (!existing) {
    const franchiseExisting = await getActiveResponseByFranchise(env, round.round_id, item.proposal_id, discordUserId);
    if (franchiseExisting && franchiseExisting.discord_user_id !== discordUserId) {
      return {
        allowed: false,
        reason: "franchise_locked_by_other_account",
        existing: franchiseExisting,
      };
    }
  }

  return { allowed: true, existing };
}

// ---------- Tally rendering ----------
function tallyForCounts(responses) {
  const buckets = { yes: [], no: [], abstain: [] };
  for (const r of responses) {
    if (buckets[r.value]) buckets[r.value].push(r);
  }
  return buckets;
}
function ownerNameMap(owners) {
  const m = {};
  for (const o of owners || []) {
    m[o.discord_user_id] = o.display_name || `<@${o.discord_user_id}>`;
  }
  return m;
}

// Collapse multi-account owners (e.g. the commish on two Discord IDs)
// into one display row per franchise. Returns one row per franchise_id,
// preferring the row with the lower discord_user_id (deterministic).
// Owners without a franchise_id pass through unchanged so we don't lose
// non-franchise voters.
function dedupeOwnersByFranchise(owners) {
  const byFranchise = new Map();
  const ungrouped = [];
  for (const o of owners || []) {
    const fid = o?.franchise_id ? String(o.franchise_id) : "";
    if (!fid) { ungrouped.push(o); continue; }
    const existing = byFranchise.get(fid);
    if (!existing) { byFranchise.set(fid, o); continue; }
    // Deterministic tiebreak: keep the row with the lower discord_user_id.
    if (String(o.discord_user_id) < String(existing.discord_user_id)) {
      byFranchise.set(fid, o);
    }
  }
  return [...byFranchise.values(), ...ungrouped];
}
function buildTallyContent(item, responses, owners, comments) {
  const buckets = tallyForCounts(responses);
  const nameOf = ownerNameMap(owners); // keyed by ALL discord_user_ids (including alt accounts) for vote-name lookup
  const passYes = item.pass_yes_count || 7;

  // Display roster collapses multi-account owners to one row per franchise.
  // Vote attribution still uses the full responses list — if the alt voted,
  // the name resolves via nameOf since both accounts are in `owners`.
  const dedupedOwners = dedupeOwnersByFranchise(owners);
  const total = dedupedOwners.length;

  // "Has the franchise voted?" is franchise-aware: any discord_user_id on
  // the same franchise as the deduped row counts as voted. Build a set of
  // franchise_ids that have at least one active response.
  const fidByUser = {};
  for (const o of owners || []) {
    if (o?.franchise_id) fidByUser[o.discord_user_id] = String(o.franchise_id);
  }
  const votedFranchises = new Set();
  const votedIds = new Set();
  for (const r of responses || []) {
    votedIds.add(r.discord_user_id);
    const fid = fidByUser[r.discord_user_id];
    if (fid) votedFranchises.add(fid);
  }
  const notVoted = dedupedOwners.filter((o) => {
    const fid = o?.franchise_id ? String(o.franchise_id) : "";
    if (fid) return !votedFranchises.has(fid);
    return !votedIds.has(o.discord_user_id);
  }).map((o) => nameOf[o.discord_user_id]);

  const fmt = (list) => list.length ? list.join(", ") : "—";
  const yesNames = buckets.yes.map((r) => nameOf[r.discord_user_id] || r.discord_user_id);
  const noNames = buckets.no.map((r) => nameOf[r.discord_user_id] || r.discord_user_id);
  const absNames = buckets.abstain.map((r) => nameOf[r.discord_user_id] || r.discord_user_id);

  const lines = ["🗳 **TALLY**"];
  if (item.threshold_reached_at_utc) {
    const verdictWord = item.final_outcome === "passed" ? "PASSED"
                      : item.final_outcome === "rejected" ? "REJECTED"
                      : item.final_outcome === "discussion" ? "DISCUSSION"
                      : "CLOSED";
    const verdictEmoji = item.final_outcome === "passed" ? "✅"
                       : item.final_outcome === "rejected" ? "❌"
                       : item.final_outcome === "discussion" ? "🗣" : "🔒";
    if (isPastVoteChangeLock(item)) {
      // Final, frozen verdict.
      const lockStamp = formatDeadlineUtc(item.votes_locked_at_utc) || item.votes_locked_at_utc;
      lines.push(`${verdictEmoji} **${verdictWord}** · verdict locked at ${lockStamp}`);
      lines.push(`🔒 Cast votes locked. Late votes from non-voters still accepted until /rules close.`);
    } else {
      // Within the 5-min grace window — verdict is provisional; can still flip
      // if a vote changes. Re-evaluated on every interaction.
      const lockStamp = formatDeadlineUtc(item.votes_locked_at_utc) || item.votes_locked_at_utc;
      lines.push(`🟡 **PROVISIONAL ${verdictWord}** — final lock at ${lockStamp}`);
      lines.push(`⏳ Within the ${VOTE_CHANGE_LOCK_MINUTES}-min change window — verdict can still flip if a vote changes.`);
    }
  }
  lines.push("");
  lines.push(`✅ Yes (${buckets.yes.length}) — ${fmt(yesNames)}`);
  lines.push(`❌ No (${buckets.no.length}) — ${fmt(noNames)}`);
  lines.push(`➖ Abstain (${buckets.abstain.length}) — ${fmt(absNames)}`);
  lines.push(`⏳ Not voted (${notVoted.length}) — ${fmt(notVoted)}`);
  lines.push("");
  if (!item.discussion_only) {
    lines.push(`Threshold: **${passYes} yes** to pass · pool ${total}`);
  } else {
    lines.push(`*Discussion-only item — no pass/fail; closes at /rules close.*`);
  }
  return lines.join("\n").slice(0, 1990);
}
function round_status_closed(item) {
  // Helper guard so we don't claim closed when we're just lock-pending.
  return false; // tally-pin-side; the round-level close fact is set on item.discord_round_items.closed_at_utc by /rules close
}

// ---------- Vote line rendering (one-message-per-voter) ----------
function voteLineContent(displayName, value, reasoning) {
  const verbal = value === "yes" ? "✅" : value === "no" ? "❌" : "➖";
  const word = value.toUpperCase();
  const base = `${verbal} **${displayName || "Owner"}** voted **${word}**`;
  if (reasoning && String(reasoning).trim()) {
    const r = fitToFieldValue(String(reasoning).trim().replace(/\n/g, " "), 600);
    return `${base} — _"${r}"_`;
  }
  return base;
}

// ---------- Proposal-message rendering (the parent thread message) ----------
function buildProposalMessage(round, item) {
  const headerLines = [`**Item ${item.ordinal} of ${round_total_items_cached || "?"} · ${item.title}**`];
  if (item.discussion_only) {
    headerLines.push(`🗣 _Discussion item — vote here is **advisory** (won't auto-close)._`);
  }
  if (item.tldr) headerLines.push(`*${item.tldr}*`);
  headerLines.push("");
  const headerStr = headerLines.join("\n") + "\n";
  const bodyAvail = 1900 - headerStr.length;
  const body = fitToFieldValue(item.body_md || "", bodyAvail);
  const cid = (val) => `t:vote:${round.round_id}:${item.proposal_id}:${val}`;
  return {
    content: (headerStr + body).slice(0, 1990),
    components: [
      {
        type: COMPONENT_TYPE.ACTION_ROW,
        components: [
          { type: COMPONENT_TYPE.BUTTON, style: BUTTON_STYLE.SUCCESS, label: "✅ Yes", custom_id: cid("yes") },
          { type: COMPONENT_TYPE.BUTTON, style: BUTTON_STYLE.DANGER, label: "❌ No", custom_id: cid("no") },
          { type: COMPONENT_TYPE.BUTTON, style: BUTTON_STYLE.SECONDARY, label: "➖ Abstain", custom_id: `t:abstain:${round.round_id}:${item.proposal_id}` },
        ],
      },
      {
        type: COMPONENT_TYPE.ACTION_ROW,
        components: [
          { type: COMPONENT_TYPE.BUTTON, style: BUTTON_STYLE.PRIMARY, label: "Questions? 🤖", custom_id: `t:explain:${round.round_id}:${item.proposal_id}` },
        ],
      },
    ],
  };
}
let round_total_items_cached = null;
function setTotalItemsCache(n) { round_total_items_cached = n; }

// Build a button-row clone with all components disabled — used when the
// round closes and we lock the proposal-message buttons.
function disabledComponents(components) {
  return (components || []).map((row) => ({
    ...row,
    components: (row.components || []).map((c) => ({ ...c, disabled: true })),
  }));
}

// ---------- Modal payloads ----------
function abstainModalPayload(round, item) {
  return {
    type: RESPONSE_TYPE.MODAL,
    data: {
      custom_id: `t:abstain_modal:${round.round_id}:${item.proposal_id}`,
      title: `Abstain — ${fitToFieldValue(item.title, 30)}`,
      components: [
        {
          type: COMPONENT_TYPE.ACTION_ROW,
          components: [
            {
              type: COMPONENT_TYPE.TEXT_INPUT,
              custom_id: "txt",
              label: "Why abstain? (required)",
              style: TEXT_INPUT_STYLE.PARAGRAPH,
              required: true,
              min_length: 3,
              max_length: 800,
              placeholder: "Tell the league why you're abstaining — needed for the record.",
            },
          ],
        },
      ],
    },
  };
}
function commentModalPayload(round, item) {
  return {
    type: RESPONSE_TYPE.MODAL,
    data: {
      custom_id: `t:comment_modal:${round.round_id}:${item.proposal_id}`,
      title: `Comment — ${fitToFieldValue(item.title, 30)}`,
      components: [
        {
          type: COMPONENT_TYPE.ACTION_ROW,
          components: [
            {
              type: COMPONENT_TYPE.TEXT_INPUT,
              custom_id: "txt",
              label: "Your thought",
              style: TEXT_INPUT_STYLE.PARAGRAPH,
              required: true,
              min_length: 1,
              max_length: 1500,
              placeholder: "Share with the league — vote not required to comment.",
            },
          ],
        },
      ],
    },
  };
}
// Yes / No modal — opens immediately on click so owners are prompted to add
// a reason while the vote is fresh. Reason is OPTIONAL (parity with what
// owners would have done via a follow-up "Add reason" button, but in one
// fewer click). Submit empty → vote recorded, no reason. Submit with text
// → vote recorded with reason. Cancel → vote not recorded (Discord
// limitation — interaction can return EITHER a modal or a record-and-ack,
// not both).
function voteWithReasonModalPayload(round, item, value) {
  const verb = value === "yes" ? "✅ YES" : value === "no" ? "❌ NO" : "Vote";
  return {
    type: RESPONSE_TYPE.MODAL,
    data: {
      custom_id: `t:vote_modal:${round.round_id}:${item.proposal_id}:${value}`,
      title: `Voting ${verb} — ${fitToFieldValue(item.title, 30)}`,
      components: [
        {
          type: COMPONENT_TYPE.ACTION_ROW,
          components: [
            {
              type: COMPONENT_TYPE.TEXT_INPUT,
              custom_id: "txt",
              label: "Reason (optional)",
              style: TEXT_INPUT_STYLE.PARAGRAPH,
              required: false,
              max_length: 800,
              placeholder: "Why this vote? Skip the field if you'd rather not say.",
            },
          ],
        },
      ],
    },
  };
}

function explainModalPayload(round, item) {
  return {
    type: RESPONSE_TYPE.MODAL,
    data: {
      custom_id: `t:explain_modal:${round.round_id}:${item.proposal_id}`,
      title: `Ask about: ${fitToFieldValue(item.title, 30)}`,
      components: [
        {
          type: COMPONENT_TYPE.ACTION_ROW,
          components: [
            {
              type: COMPONENT_TYPE.TEXT_INPUT,
              custom_id: "q",
              label: "Your question",
              style: TEXT_INPUT_STYLE.PARAGRAPH,
              required: true,
              min_length: 3,
              max_length: 1500,
              placeholder: "How does this differ from today's rule? Show me a worked example.",
            },
          ],
        },
      ],
    },
  };
}
function modalTextValue(interaction, customId) {
  const rows = interaction?.data?.components || [];
  for (const row of rows) {
    for (const comp of row.components || []) {
      if (comp.custom_id === customId) return safeStr(comp.value || "");
    }
  }
  return "";
}

// ---------- Threshold + lock + announcement ----------
// Re-evaluate verdict on every vote until the 5-min lock kicks in.
//   • Past lock: do nothing — verdict is FROZEN at whatever final_* was at lock.
//   • Within grace window:
//       - threshold met now & wasn't before → set lock timer + final_*
//       - threshold met now & was before    → just refresh final_* (verdict can flip!)
//       - threshold NOT met now & was before → clear flags (verdict reverts to "open")
//       - threshold NOT met & never was      → no-op
// This way an owner who voted YES and triggered threshold can change to NO
// within the window and the verdict updates accordingly. Tally stays honest.
async function checkAndMarkThreshold(env, round, item) {
  if (item.discussion_only) return { reached: false, discussionOnly: true };
  if (item.votes_locked_at_utc && isPastVoteChangeLock(item)) {
    return { reached: !!item.threshold_reached_at_utc, locked: true, frozen: true };
  }

  const responses = await getActiveResponsesForProposal(env, round.round_id, item.proposal_id);
  const buckets = tallyForCounts(responses);
  const yes = buckets.yes.length;
  const no = buckets.no.length;
  const abstain = buckets.abstain.length;
  const totalOwners = await env.UPS_MFL_DB
    .prepare("SELECT COUNT(*) AS n FROM discord_round_owners WHERE round_id = ?").bind(round.round_id).all()
    .then((r) => Number(r.results?.[0]?.n || 0));
  const passYes = Math.max(1, item.pass_yes_count || 7);

  let outcome = null;
  if (yes >= passYes) outcome = "passed";
  else {
    const decided = yes + no;
    const remaining = Math.max(0, totalOwners - decided);
    const maxPossibleYes = yes + remaining;
    if (maxPossibleYes < passYes) outcome = "rejected";
  }

  // Threshold currently met.
  if (outcome) {
    if (!item.threshold_reached_at_utc) {
      // First time crossing the threshold — set the timer + final_*.
      const ts = nowIso();
      const lockTs = new Date(Date.now() + VOTE_CHANGE_LOCK_MINUTES * 60 * 1000).toISOString();
      await env.UPS_MFL_DB.prepare(`
        UPDATE discord_round_items
        SET threshold_reached_at_utc = ?, votes_locked_at_utc = ?,
            final_outcome = ?, final_yes = ?, final_no = ?, final_abstain = ?
        WHERE round_id = ? AND proposal_id = ? AND threshold_reached_at_utc IS NULL
      `).bind(ts, lockTs, outcome, yes, no, abstain, round.round_id, item.proposal_id).run();
      return { reached: true, firstTime: true, outcome, yes, no, abstain };
    }
    // Already in the grace window — refresh final_* (verdict may have flipped).
    await env.UPS_MFL_DB.prepare(`
      UPDATE discord_round_items
      SET final_outcome = ?, final_yes = ?, final_no = ?, final_abstain = ?
      WHERE round_id = ? AND proposal_id = ?
    `).bind(outcome, yes, no, abstain, round.round_id, item.proposal_id).run();
    return { reached: true, firstTime: false, outcome, yes, no, abstain };
  }

  // Threshold NOT met right now. If it was set previously (verdict crossed
  // then uncrossed within the grace window), clear the flags so the tally
  // pin shows "open" again.
  if (item.threshold_reached_at_utc) {
    await env.UPS_MFL_DB.prepare(`
      UPDATE discord_round_items
      SET threshold_reached_at_utc = NULL, votes_locked_at_utc = NULL,
          final_outcome = NULL, final_yes = NULL, final_no = NULL, final_abstain = NULL
      WHERE round_id = ? AND proposal_id = ?
    `).bind(round.round_id, item.proposal_id).run();
    return { reached: false, reverted: true };
  }
  return { reached: false };
}

async function refreshTallyPin(env, round, item) {
  if (!item.tally_message_id || !item.discord_thread_id) return;
  const owners = await getRoundOwners(env, round.round_id);
  const responses = await getActiveResponsesForProposal(env, round.round_id, item.proposal_id);
  const { results: comments } = await env.UPS_MFL_DB.prepare(`
    SELECT comment_id FROM discord_comments WHERE round_id = ? AND proposal_id = ?
  `).bind(round.round_id, item.proposal_id).all();
  await editMessage(env, item.discord_thread_id, item.tally_message_id, {
    content: buildTallyContent(item, responses, owners, comments || []),
  });
}

async function postAnnouncementAndImpact(env, round, item) {
  // Post a one-line cross-channel announcement with deep link to the thread,
  // then post the AI-generated impact analysis IN the thread, then rename
  // the thread to reflect the verdict.
  if (!item.discord_thread_id) return { ok: false, error: "no_thread" };
  if (item.summary_posted_at_utc) return { ok: true, alreadyPosted: true };

  // Generate the impact analysis FIRST. If it fails transiently (Anthropic
  // 429/5xx), bail without claiming — the next sweep retries cleanly.
  const impact = await callImpactAnalysis(env, {
    proposalTitle: item.title,
    proposalBody: item.body_md,
    finalOutcome: item.final_outcome,
    finalYes: item.final_yes,
    finalNo: item.final_no,
    finalAbstain: item.final_abstain,
  });
  if (!impact.ok && impact.transient) {
    console.log(`[announce] transient impact failure for ${item.proposal_id}; will retry next sweep`);
    return { ok: false, transient: true };
  }
  const impactText = (impact?.text || "(impact analysis unavailable)").slice(0, 1990);

  // Atomically claim ONLY after we have a usable impact analysis. This keeps
  // retries idempotent — if Anthropic 429s, summary_posted_at_utc stays NULL
  // and next sweep tries again.
  const claim = await env.UPS_MFL_DB.prepare(`
    UPDATE discord_round_items SET summary_posted_at_utc = ?
    WHERE round_id = ? AND proposal_id = ? AND summary_posted_at_utc IS NULL
  `).bind(nowIso(), round.round_id, item.proposal_id).run();
  if (!claim?.meta?.changes) return { ok: true, alreadyPosted: true };

  // 1. Cross-channel announcement (DISCORD_ANNOUNCE_CHANNEL_ID, defaults to RULES channel).
  // TEST ROUNDS announce to their own broadcast channel instead — a passing
  // test proposal must never push-notify Coffee Shop. Without this guard the
  // Rule Proposals dark-launch rehearsal would @ the whole league.
  const isTestRound = Number(round.test_only || 0) === 1;
  const annCid = isTestRound
    ? safeStr(round.broadcast_channel_id || "")
    : announceChannelId(env);
  const verdictWord = item.final_outcome === "passed" ? "PASSED"
                    : item.final_outcome === "rejected" ? "REJECTED"
                    : "CLOSED";
  const verdictEmoji = item.final_outcome === "passed" ? "✅"
                     : item.final_outcome === "rejected" ? "❌" : "🗣";
  const guildId = safeStr(env.DISCORD_GUILD_ID || "");
  const link = guildId ? threadDeepLink(guildId, item.discord_thread_id) : "";
  const rulingSuffix = item.close_reason === "commish_ruling" ? " (commish ruling)" : "";
  const announceContent = link
    ? `${verdictEmoji} **Rule ${verdictWord}: ${item.title}**${rulingSuffix} — [click for details](${link})`
    : `${verdictEmoji} **Rule ${verdictWord}: ${item.title}**${rulingSuffix} — see thread in rules channel.`;
  let annMsgId = "";
  if (annCid) {
    // Loud: this is the one channel post that's allowed to push-notify
    // the league. Everything else (anchor, threads, tally, votes,
    // comments, AI replies, in-thread impact summary) is silent.
    const ar = await postChannelMessage(env, annCid, { content: announceContent }, { silent: false });
    if (ar.ok) annMsgId = safeStr(ar.data?.id || "");
    else console.log(`[announce] failed: status=${ar.status} body=${(ar.text || "").slice(0, 300)}`);
  }

  // 2. Impact analysis posted in the thread.
  await postChannelMessage(env, item.discord_thread_id, { content: impactText });

  // 3. Rename the thread to reflect the verdict — drop the "Item N:" prefix
  // and prepend a Passed/Rejected/Discussion verb.
  const verbalPrefix = item.final_outcome === "passed" ? "Passed - "
                     : item.final_outcome === "rejected" ? "Rejected - "
                     : item.final_outcome === "discussion" ? "Discussion - "
                     : "Closed - ";
  const newName = fitToFieldValue(`${verbalPrefix}${item.title}`, 95);
  await discordPatch(env, `/channels/${encodeURIComponent(item.discord_thread_id)}`, { name: newName }).catch((e) => {
    console.log(`[announce] thread rename failed: ${e?.message || e}`);
  });

  // Persist announcement message id.
  await env.UPS_MFL_DB.prepare(`
    UPDATE discord_round_items
    SET announce_message_id = ?, announce_channel_id = ?, summary_message_id = ?, summary_thread_id = ?
    WHERE round_id = ? AND proposal_id = ?
  `).bind(annMsgId || null, annCid || null, annMsgId || null, item.discord_thread_id, round.round_id, item.proposal_id).run();

  // 4. Refresh the tally pin to reflect the locked state.
  await refreshTallyPin(env, round, item);

  // 5. Fire-and-forget the rule-integration workflow for passed rules.
  // Sonnet researches the impact surface across league_context_v1.md,
  // appends a structured changelog entry, and opens a PR with a
  // checklist for the commish to review + merge. Idempotent — re-runs
  // detect an existing PR. Network/AI errors here MUST NOT roll back
  // the announcement (which already landed); we just log + retry via
  // the manual /admin/hall/integrate-rule/:id endpoint.
  if (item.final_outcome === "passed" && !isTestRound) {
    try {
      const { integrateApprovedRule } = await import("./rule_integrator.js");
      // Don't await — keep the sweep snappy. The integrator can take
      // 30-60s with 5 Sonnet calls; if we awaited, it would steal CPU
      // budget from other items waiting in the same sweep.
      integrateApprovedRule(env, item.proposal_id).then((r) => {
        if (r?.ok) console.log(`[integrate] PR opened for ${item.proposal_id}: ${r.pr_url || r.pr_number}`);
        else console.log(`[integrate] failed for ${item.proposal_id}: ${r?.error || "unknown"}`);
      }).catch((e) => {
        console.log(`[integrate] threw for ${item.proposal_id}: ${e?.message || e}`);
      });
    } catch (e) {
      console.log(`[integrate] dispatch failed for ${item.proposal_id}: ${e?.message || e}`);
    }
  } else if (item.final_outcome === "rejected" && !isTestRound) {
    // Symmetric to the passed path (Keith 2026-07-18): a REJECTED proposal
    // leaves a version-controlled trace too. No canon edits (nothing passed) —
    // just a changelog-record PR. Fire-and-forget; errors never roll back the
    // announcement (which already landed).
    try {
      const { recordRejectedRule } = await import("./rule_integrator.js");
      recordRejectedRule(env, item.proposal_id).then((r) => {
        if (r?.ok) console.log(`[integrate] reject-record for ${item.proposal_id}: ${r.pr_url || r.pr_number || "already"}`);
        else console.log(`[integrate] reject-record failed for ${item.proposal_id}: ${r?.error || "unknown"}`);
      }).catch((e) => console.log(`[integrate] reject-record threw for ${item.proposal_id}: ${e?.message || e}`));
    } catch (e) {
      console.log(`[integrate] reject-record dispatch failed for ${item.proposal_id}: ${e?.message || e}`);
    }
  }

  return { ok: true, posted: true };
}

// Sweep: find items where threshold was hit AND vote-change lock has elapsed
// AND we haven't yet posted the summary thread + cross-channel announcement.
export async function processPendingSummaries(env, opts) {
  const ignoreLock = !!(opts && opts.ignoreLock);
  const cutoffIso = ignoreLock
    ? new Date(Date.now() + 60 * 1000).toISOString()
    : nowIso();
  // LIMIT 1: each cron tick processes at most ONE item. Anthropic's
  // long-context impact analysis can take 8-15s; doing 2+ in a single
  // tick blows the worker's CPU/runtime budget (observed 2026-05-08:
  // every */2 cron showed "Exceeded CPU Limit" with 2 stuck items).
  // With LIMIT 1, an N-item backlog clears in N ticks (≤ 2N min),
  // and steady-state is ~2-4 min lag from lock to announce.
  const { results } = await env.UPS_MFL_DB.prepare(`
    SELECT ri.round_id, ri.proposal_id, ri.discord_thread_id, ri.tally_message_id,
           ri.threshold_reached_at_utc, ri.votes_locked_at_utc, ri.summary_posted_at_utc,
           ri.final_outcome, ri.final_yes, ri.final_no, ri.final_abstain,
           p.title, p.body_md, p.discussion_only
    FROM discord_round_items ri
    JOIN hall_proposals p ON p.id = ri.proposal_id
    WHERE ri.threshold_reached_at_utc IS NOT NULL
      AND ri.votes_locked_at_utc IS NOT NULL
      AND ri.votes_locked_at_utc <= ?
      AND ri.summary_posted_at_utc IS NULL
    ORDER BY ri.votes_locked_at_utc ASC
    LIMIT 1
  `).bind(cutoffIso).all();
  let posted = 0;
  for (const it of results || []) {
    const round = await getActiveRound(env, it.round_id);
    if (!round) continue;
    const result = await postAnnouncementAndImpact(env, round, it);
    if (result.posted) posted++;
  }
  return { posted, candidates: (results || []).length };
}

// ---------- Subcommand: /rules start ----------
// Discord requires the interaction response within 3 seconds. Creating the
// kickoff anchor + 6 threads + per-thread proposal/tally + DM blast is well
// over that, so we DEFER immediately and do the work in ctx.waitUntil. The
// commish gets a final ack via the deferred-response webhook patch.
async function handleStart(interaction, env, ctx) {
  if (!isCommish(interaction, env)) return ephemeral("`/rules start` is commish-only.");
  const opts = interaction?.data?.options?.[0]?.options || [];
  const roundId = safeStr(opts.find((o) => o.name === "round_id")?.value || "");
  if (!roundId) return ephemeral("Need `round_id` (e.g. `May2026`).");

  const applicationId = safeStr(env.DISCORD_APPLICATION_ID || "");
  const interactionToken = safeStr(interaction?.token || "");

  // Run the whole heavy build in the background and patch the deferred message
  // when it's done. We have up to 15 minutes to follow up via the webhook.
  if (ctx && typeof ctx.waitUntil === "function") {
    ctx.waitUntil(
      runStartFlow(env, roundId, interaction, applicationId, interactionToken)
        .catch((e) => {
          console.log(`[rules start] background flow failed: ${e?.message || e}`);
          if (applicationId && interactionToken) {
            patchDeferredOriginal(env, applicationId, interactionToken, {
              content: `❌ Start failed: ${e?.message || e}`,
            }).catch(() => {});
          }
        })
    );
  } else {
    // Fallback (no ctx): do it inline. Will hit the 3s timeout for sure but
    // at least state still gets persisted.
    runStartFlow(env, roundId, interaction, applicationId, interactionToken).catch(() => {});
  }

  // Deferred ephemeral ack — Discord shows "Bot is thinking…" until the
  // background flow patches this message with the result.
  return jsonResponse({
    type: RESPONSE_TYPE.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
    data: { flags: FLAG_EPHEMERAL },
  });
}

async function patchDeferredOriginal(env, applicationId, interactionToken, body) {
  const url = `https://discord.com/api/v10/webhooks/${encodeURIComponent(applicationId)}/${encodeURIComponent(interactionToken)}/messages/@original`;
  try {
    const res = await fetch(url, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      console.log(`[deferred-patch] failed: status=${res.status} body=${text.slice(0, 300)}`);
    }
  } catch (e) {
    console.log(`[deferred-patch] threw: ${e?.message || e}`);
  }
}

export async function runStartFlow(env, roundId, interaction, applicationId, interactionToken, opts = {}) {
  const ack = (msg) => applicationId && interactionToken
    ? patchDeferredOriginal(env, applicationId, interactionToken, { content: msg.slice(0, 1990) })
    : Promise.resolve();

  const round = await getActiveRound(env, roundId);
  if (!round) return await ack(`No round \`${roundId}\` found. Seed it first.`);
  if (round.status !== "open") return await ack(`Round \`${roundId}\` is **${round.status}**.`);

  // Auto-derive voting_deadline from league_events. Source of truth = D1
  // league_events (rookie_draft event, or rookie_extension_deadline + 3 days
  // as a fallback). Voting deadline = rookie draft − 7 days.
  // Wrapped — any failure here MUST NOT crash runStartFlow because the
  // deferred response has to be patched at the bottom of this function.
  //
  // opts.skipDeadlineDerivation: the Rule Proposals publish path sets an
  // explicit deadline on the round and MUST NOT have it overwritten — the
  // derived date is rookie-draft−7d (May), which for a July publish is in
  // the PAST, and processOverdueRoundCloses would then close the round on
  // the next hourly cron. Found 2026-07-15 during the v2 design review.
  if (!opts.skipDeadlineDerivation) try {
    const season = seasonFromRound(round);
    const derived = await deriveVotingDeadlineFromEvents(env, season);
    if (derived) {
      await env.UPS_MFL_DB.prepare(`
        UPDATE discord_rounds SET draft_date_utc = ?, voting_deadline_utc = ? WHERE round_id = ?
      `).bind(derived.draftDateUtc, derived.votingDeadlineUtc, round.round_id).run();
      round.draft_date_utc = derived.draftDateUtc;
      round.voting_deadline_utc = derived.votingDeadlineUtc;
      console.log(`[rules start] derived deadline from league_events: rookie_draft=${derived.rookieDraftDate} season=${season} voting_deadline=${derived.votingDeadlineUtc}`);
    } else {
      console.log(`[rules start] league_events has no rookie deadline for season ${season}; using seeded round.voting_deadline_utc=${round.voting_deadline_utc}`);
    }
  } catch (e) {
    console.log(`[rules start] deadline derivation failed: ${e?.message || e}; continuing with seeded deadline`);
  }

  // broadcast_channel_id was stored-but-never-read since 0021; it now wins
  // when set — the Rule Proposals dark/test path points it at the test
  // channel so a whole round can run without the league seeing anything.
  const channelId = safeStr(round.broadcast_channel_id || "") || rulesChannelId(env);
  if (!channelId) return await ack("`DISCORD_RULES_CHANNEL_ID` not configured.");

  const items = await getRoundItems(env, round.round_id);
  if (!items.length) return await ack("Round has no items.");
  const owners = await getRoundOwners(env, round.round_id);
  if (!owners.length) return await ack("Round has no owners attached.");

  setTotalItemsCache(items.length);

  // Don't double-create if /rules start was already run successfully.
  if (round.kickoff_anchor_message_id) {
    return await ack(`⚠️ Round \`${roundId}\` already has an active kickoff (anchor msg ${round.kickoff_anchor_message_id}). Re-seed first to clean up + retry.`);
  }

  // 1. Post the kickoff anchor in the rules channel.
  // Pool count = unique franchises (collapses multi-account commish).
  const dedupedPool = dedupeOwnersByFranchise(owners).length;
  const anchorLines = [
    `🏛 **${round.title}** is now open.`,
    `${items.length} items · pool ${dedupedPool} · threshold per item shown in each thread`,
    ``,
    `**In this round of voting:**`,
  ];
  for (const it of items) anchorLines.push(`${it.ordinal}. ${it.title}`);
  anchorLines.push(``);
  anchorLines.push(`Each item has its own thread below. Vote, comment, or ask the bot to explain. I'll DM nudges to non-voters every 48h for the first 6 days, then daily.`);
  const anchorPost = await postChannelMessage(env, channelId, { content: anchorLines.join("\n").slice(0, 1990) });
  if (!anchorPost.ok || !anchorPost.data?.id) {
    return await ack(`❌ Failed to post kickoff anchor: ${(anchorPost.text || "").slice(0, 300)}`);
  }
  const anchorMsgId = anchorPost.data.id;
  await pinMessage(env, channelId, anchorMsgId).catch(() => {});
  await env.UPS_MFL_DB.prepare(`
    UPDATE discord_rounds
    SET kickoff_anchor_message_id = ?, kickoff_channel_id = ?
    WHERE round_id = ?
  `).bind(anchorMsgId, channelId, round.round_id).run();

  // 2. Create one standalone public thread per item (NOT parented to the
  // kickoff message — Discord allows only one thread per parent, and
  // standalone threads show in the channel sidebar just the same).
  const guildId = safeStr(env.DISCORD_GUILD_ID || guildIdFromInteraction(interaction));
  const threadLinks = [];
  let createdCount = 0;
  let failedCount = 0;
  for (const it of items) {
    const threadName = items.length === 1
      ? fitToFieldValue(it.title, 90)
      : `Item ${it.ordinal}: ${fitToFieldValue(it.title, 80)}`;
    const tr = await createStandalonePublicThread(env, channelId, threadName);
    if (!tr.ok || !tr.data?.id) {
      console.log(`[rules start] thread create failed for ${it.proposal_id}: status=${tr.status} body=${(tr.text || "").slice(0, 200)}`);
      failedCount++;
      // Small backoff if Discord 429'd; safer to wait and continue than to bail.
      if (tr.status === 429) await sleepMs(1000);
      continue;
    }
    const threadId = tr.data.id;

    const proposalMsg = await postChannelMessage(env, threadId, buildProposalMessage(round, it));
    const proposalMsgId = proposalMsg.ok ? safeStr(proposalMsg.data?.id || "") : "";

    const tallyMsg = await postChannelMessage(env, threadId, {
      content: buildTallyContent(it, [], owners, []),
    });
    const tallyMsgId = tallyMsg.ok ? safeStr(tallyMsg.data?.id || "") : "";
    if (tallyMsgId) await pinMessage(env, threadId, tallyMsgId).catch(() => {});

    // Structured authoring (Rule Proposals v2): the WHY and the DATA are their
    // own messages so the proposal message keeps its 2000-char budget for the
    // rule text itself. Both optional; chunked at message-size boundaries.
    const postLong = async (header, md) => {
      const bodyText = safeStr(md);
      if (!bodyText) return;
      let rest = `${header}\n${bodyText}`;
      while (rest.length) {
        let cut = Math.min(1950, rest.length);
        if (cut < rest.length) {
          const nl = rest.lastIndexOf("\n", cut);
          if (nl > 500) cut = nl;
        }
        await postChannelMessage(env, threadId, { content: rest.slice(0, cut) });
        rest = rest.slice(cut);
      }
    };
    await postLong("📋 **Why this came up**", it.rationale_md);
    await postLong("📊 **Supporting data**", it.supporting_data_md);

    await env.UPS_MFL_DB.prepare(`
      UPDATE discord_round_items
      SET discord_thread_id = ?, proposal_message_id = ?, tally_message_id = ?
      WHERE round_id = ? AND proposal_id = ?
    `).bind(threadId, proposalMsgId || null, tallyMsgId || null, round.round_id, it.proposal_id).run();

    threadLinks.push(guildId
      ? `${it.ordinal}. [${it.title}](${threadDeepLink(guildId, threadId)})`
      : `${it.ordinal}. ${it.title}`);
    createdCount++;
    // Small pause between thread creates to stay under Discord's per-channel
    // rate limit. ~200ms is well under the typical 1-per-2-seconds bucket.
    await sleepMs(250);
  }

  // 3. DM each owner. Two shapes:
  //    - legacy digest: thread links + deadline (batch rounds, /rules start)
  //    - opts.dmVoteCards (Rule Proposals v2): the interactive card with
  //      Approve/Decline/Discuss buttons. Approve/Decline carry the same
  //      t:vote customIds as the thread — one vote pipeline, zero sync code.
  const channelLink = guildId ? `https://discord.com/channels/${guildId}/${channelId}` : "the rules channel";
  const deadlineFormatted = formatDeadlineUtc(round.voting_deadline_utc);
  const dmLines = [
    `🏛 **${round.title}** is open${guildId ? ` in ${channelLink}` : ""}.`,
    ``,
    `**In this round of voting** — ${createdCount} items, each in its own thread:`,
    ...threadLinks,
    ``,
  ];
  if (deadlineFormatted) {
    dmLines.push(`**Deadline:** ${deadlineFormatted} — coincides with the Tag & Expired Rookies deadline.`);
    dmLines.push(``);
  }
  dmLines.push(`Vote, comment, or ask the bot to explain.`);
  dmLines.push(`If you don't vote, I'll nudge you here **every 48 hours for the first 6 days, then daily** until you respond or the round closes.`);
  // Rule Proposals v2 DM cards: ONE interactive card per item so a round can
  // carry N rules (each card's Approve/Decline/Discuss custom_ids embed the
  // proposal_id, so one vote pipeline serves them all). Single-item rounds send
  // just the one card (unchanged UX); multi-item rounds lead with a short intro.
  let dmVoteCardPayloads = null;
  if (opts.dmVoteCards) {
    // Re-read items so each card carries the thread id stamped moments ago.
    const freshItems = await getRoundItems(env, round.round_id);
    const { buildDmVoteCard } = await import("./discord_rule_proposal.js");
    dmVoteCardPayloads = freshItems.map((it) => buildDmVoteCard(round, it, guildId)).filter(Boolean);
  }
  const multiCard = !!(dmVoteCardPayloads && dmVoteCardPayloads.length > 1);
  const cardIntro = multiCard
    ? [
        `🏛 **${round.title}** is open — **${dmVoteCardPayloads.length} rules** to vote on this round.`,
        deadlineFormatted ? `**Deadline:** ${deadlineFormatted}.` : ``,
        `A card for each rule follows — Approve / Decline / Discuss right here, or open its thread.`,
      ].filter(Boolean).join("\n").slice(0, 1990)
    : null;
  let dmsSent = 0;
  const dmFailures = [];
  for (const o of owners) {
    const cid = await openDmChannel(env, o.discord_user_id);
    if (!cid) { dmFailures.push({ discord_user_id: o.discord_user_id, reason: "dm_channel_open_failed" }); continue; }
    let ok = false;
    let lastStatus = "failed";
    if (dmVoteCardPayloads && dmVoteCardPayloads.length) {
      if (cardIntro) {
        const introDr = await sendDm(env, cid, { content: cardIntro });
        if (introDr.ok) ok = true; else lastStatus = introDr.status || "failed";
        await sleepMs(200);
      }
      for (const card of dmVoteCardPayloads) {
        const cardDr = await sendDm(env, cid, card);
        if (cardDr.ok) ok = true; else lastStatus = cardDr.status || "failed";
        await sleepMs(200);
      }
    } else {
      const dr = await sendDm(env, cid, { content: dmLines.join("\n").slice(0, 1990) });
      if (dr.ok) ok = true; else lastStatus = dr.status || "failed";
    }
    // Stamp last_nudge_utc on a successful kickoff DM so the cron treats the
    // kickoff itself as nudge-zero — the first *actual* nudge then waits the
    // full 48h cadence instead of firing on the next sweep.
    const stampNow = nowIso();
    if (ok) {
      await env.UPS_MFL_DB.prepare(`
        UPDATE discord_round_owners
           SET bot_dm_channel_id = ?, last_active_utc = ?, last_nudge_utc = ?
         WHERE round_id = ? AND discord_user_id = ?
      `).bind(cid, stampNow, stampNow, round.round_id, o.discord_user_id).run();
      dmsSent++;
    } else {
      dmFailures.push({ discord_user_id: o.discord_user_id, reason: `dm_send_${lastStatus}` });
      await env.UPS_MFL_DB.prepare(`
        UPDATE discord_round_owners SET bot_dm_channel_id = ?, last_active_utc = ?
        WHERE round_id = ? AND discord_user_id = ?
      `).bind(cid, stampNow, round.round_id, o.discord_user_id).run();
    }
  }

  await ack(
    `▶ Started **${round.title}** — ${createdCount}/${items.length} threads, ${dmsSent}/${owners.length} kickoff DMs.${failedCount ? ` (${failedCount} thread(s) failed — see logs.)` : ""}`
  );
  // The publish route (Rule Proposals v2) runs this in waitUntil and reads
  // nothing, but logs + future callers get the real accounting. A DM failure
  // is survivable — the thread buttons remain that owner's vote path — but
  // it must be VISIBLE, not silent (the dmAll 50007 lesson).
  if (dmFailures.length) console.log(`[rules start] DM failures: ${JSON.stringify(dmFailures)}`);
  return { ok: true, created: createdCount, dms_sent: dmsSent, dm_failures: dmFailures };
}

// ---------- Subcommand: /rules status ----------
async function handleStatus(interaction, env) {
  const round = await getActiveRound(env);
  if (!round) return ephemeral("No active round.");
  const owners = await getRoundOwners(env, round.round_id);
  const items = await getRoundItems(env, round.round_id);
  // Show franchise count, not Discord-account count, so the multi-account
  // commish counts as one owner.
  const ownerCount = dedupeOwnersByFranchise(owners).length;
  const lines = [`**📊 ${safeStr(round.title)}** · ${ownerCount} owner(s) · ${items.length} item(s)`, ""];
  for (const it of items) {
    const responses = await getActiveResponsesForProposal(env, round.round_id, it.proposal_id);
    const b = tallyForCounts(responses);
    let stateLabel = it.discord_thread_id ? "🟢 thread live" : "⚪ no thread";
    if (it.threshold_reached_at_utc && !isPastVoteChangeLock(it)) stateLabel = "🟡 verdict locked, vote-change window open";
    if (it.threshold_reached_at_utc && isPastVoteChangeLock(it)) stateLabel = "🔴 vote-changes locked";
    if (round.closed_at_utc) stateLabel = "🔒 round closed";
    lines.push(`**${it.ordinal}. ${it.title}** — ${stateLabel}`);
    lines.push(`   ✅ ${b.yes.length} · ❌ ${b.no.length} · ➖ ${b.abstain.length} · verdict: ${it.final_outcome || "—"}`);
  }
  return jsonResponse({
    type: RESPONSE_TYPE.CHANNEL_MESSAGE_WITH_SOURCE,
    data: { content: lines.join("\n").slice(0, 1990), flags: FLAG_EPHEMERAL },
  });
}

// ---------- Internal: close a round (extracted for /rules close + cron deadline-close) ----------
export async function closeRoundInternal(env, round, opts) {
  const reason = opts?.reason || "manual";
  // Finalize any items that didn't auto-close.
  const items = await getRoundItems(env, round.round_id);
  const ts = nowIso();
  for (const it of items) {
    if (it.threshold_reached_at_utc) continue;
    const responses = await getActiveResponsesForProposal(env, round.round_id, it.proposal_id);
    const b = tallyForCounts(responses);
    let outcome;
    if (it.discussion_only) outcome = "discussion";
    else if (b.yes.length >= (it.pass_yes_count || 7)) outcome = "passed";
    else if (b.yes.length > b.no.length) outcome = "passed";
    else outcome = "rejected";
    await env.UPS_MFL_DB.prepare(`
      UPDATE discord_round_items
      SET threshold_reached_at_utc = COALESCE(threshold_reached_at_utc, ?),
          votes_locked_at_utc = COALESCE(votes_locked_at_utc, ?),
          final_outcome = ?, final_yes = ?, final_no = ?, final_abstain = ?
      WHERE round_id = ? AND proposal_id = ?
    `).bind(ts, ts, outcome, b.yes.length, b.no.length, b.abstain.length, round.round_id, it.proposal_id).run();
  }
  // Mark round closed.
  await env.UPS_MFL_DB.prepare(`
    UPDATE discord_rounds SET status = 'closed', closed_at_utc = ? WHERE round_id = ?
  `).bind(ts, round.round_id).run();
  // Disable buttons + freeze tally on every thread.
  const itemsAfter = await getRoundItems(env, round.round_id);
  for (const it of itemsAfter) {
    if (it.discord_thread_id && it.proposal_message_id) {
      const proposal = buildProposalMessage(round, it);
      await editMessage(env, it.discord_thread_id, it.proposal_message_id, {
        content: proposal.content,
        components: disabledComponents(proposal.components),
      }).catch(() => {});
    }
    await refreshTallyPin(env, round, it);
  }
  // Force announcement + impact sweep regardless of lock window.
  await processPendingSummaries(env, { ignoreLock: true }).catch((e) =>
    console.log(`[close-round] sweep err: ${e?.message || e}`));
  console.log(`[close-round] round=${round.round_id} closed (reason=${reason})`);
}

// Sweep — auto-close any open round whose voting_deadline_utc has passed.
// Called from the cron. Idempotent — once closed, won't re-close.
export async function processOverdueRoundCloses(env) {
  const { results } = await env.UPS_MFL_DB.prepare(`
    SELECT * FROM discord_rounds
    WHERE status = 'open'
      AND voting_deadline_utc IS NOT NULL
      AND voting_deadline_utc <= ?
  `).bind(nowIso()).all();
  let closed = 0;
  for (const round of results || []) {
    try {
      await closeRoundInternal(env, round, { reason: "deadline_passed" });
      closed++;
    } catch (e) {
      console.log(`[overdue-close] round=${round.round_id} failed: ${e?.message || e}`);
    }
  }
  return { closed, candidates: (results || []).length };
}

// ---------- Subcommand: /rules close ----------
async function handleClose(interaction, env, ctx) {
  if (!isCommish(interaction, env)) return ephemeral("`/rules close` is commish-only.");
  const round = await getActiveRound(env);
  if (!round) return ephemeral("No active round.");
  if (round.status !== "open") return ephemeral(`Round \`${round.round_id}\` is already **${round.status}**.`);
  await closeRoundInternal(env, round, { reason: "manual" });
  return jsonResponse({
    type: RESPONSE_TYPE.CHANNEL_MESSAGE_WITH_SOURCE,
    data: { content: `🔒 **${round.title}** closed. All buttons disabled; threads stay readable.`, flags: FLAG_EPHEMERAL },
  });
}

// ---------- Auto-nudge cron sweep ----------
// Cadence (per Keith spec):
//   • First 6 days of the round: nudge every 48 hours
//   • Day 7+: nudge every 24 hours
//   • Stops when the owner has voted on every item OR /rules close runs
//
// Tone shifts: nudges 1–3 are polite, 4+ get progressively more pointed.
// Runs as part of the existing hourly cron (worker/src/index.js scheduled()).
export async function processAutoNudges(env) {
  // Quiet hours — never DM owners between 10 PM and 6 AM Eastern. Belt
  // -and-suspenders alongside the cron schedule (which already only fires
  // at 8 PM / 8 AM / 2 PM ET during EDT). This guard is DST-aware via
  // Intl.DateTimeFormat and protects against any future cron tweak that
  // accidentally schedules an overnight tick.
  const etHourStr = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    hour12: false,
  }).format(new Date());
  const etHour = parseInt(etHourStr, 10);
  if (Number.isFinite(etHour) && (etHour < 6 || etHour >= 22)) {
    console.log(`[auto-nudge] quiet hours (ET hour=${etHour}) — skipping sweep`);
    return { nudged: 0, rounds: 0, skipped: "quiet_hours" };
  }

  const { results: rounds } = await env.UPS_MFL_DB
    .prepare("SELECT * FROM discord_rounds WHERE status = 'open'").all();
  if (!rounds || !rounds.length) return { nudged: 0, rounds: 0 };

  const guildId = safeStr(env.DISCORD_GUILD_ID || "");
  let totalNudged = 0;

  for (const round of rounds) {
    // CRITICAL GATE: never nudge for a round whose /rules start hasn't fired
    // yet. Without this, a stale-seeded round (or a re-seeded round before
    // kickoff) will compare cadence against `started_at_utc` from the seed
    // moment — and if that's older than 48h, the cron blasts every owner a
    // nudge for a round that has no threads in Discord. This actually
    // happened on 2026-05-06; this guard prevents a repeat.
    if (!round.kickoff_anchor_message_id) {
      console.log(`[auto-nudge] skipping round ${round.round_id} — kickoff not yet fired (no anchor message)`);
      continue;
    }

    const startedAtMs = new Date(round.started_at_utc).getTime();
    const ageMs = Date.now() - startedAtMs;
    const cadenceMs = ageMs < 6 * 24 * 60 * 60 * 1000
      ? 48 * 60 * 60 * 1000   // 48h cadence in the first 6 days
      : 24 * 60 * 60 * 1000;  // daily after day 6

    const owners = await getRoundOwners(env, round.round_id);
    const items = await getRoundItems(env, round.round_id);

    for (const o of owners) {
      // Find items the owner hasn't voted on yet AND that are still open.
      // Franchise-aware: if a multi-account user already voted from their
      // OTHER account, both rows count as "voted" and we skip the nudge.
      const missingItems = [];
      for (const it of items) {
        if (round.closed_at_utc) continue; // shouldn't happen since round.status='open' but defensive
        const r = await getActiveResponseByFranchise(env, round.round_id, it.proposal_id, o.discord_user_id);
        if (!r) missingItems.push(it);
      }
      if (!missingItems.length) continue;

      // Cadence check: reference = last nudge OR round start.
      const lastRefMs = o.last_nudge_utc
        ? new Date(o.last_nudge_utc).getTime()
        : startedAtMs;
      if (Date.now() - lastRefMs < cadenceMs) continue;

      // Open or reuse the DM channel.
      const cid = o.bot_dm_channel_id || (await openDmChannel(env, o.discord_user_id));
      if (!cid) continue;
      if (!o.bot_dm_channel_id && cid) {
        await env.UPS_MFL_DB.prepare(`
          UPDATE discord_round_owners SET bot_dm_channel_id = ? WHERE round_id = ? AND discord_user_id = ?
        `).bind(cid, round.round_id, o.discord_user_id).run();
      }

      // Build the nudge content. Tone escalates over time.
      // Nudge #1 = ICYMI (soft, assumes they just haven't seen it yet)
      // Nudges #2-3 = polite reminder
      // Nudges #4+ = pointed; the league is waiting
      const nudgeNumber = Number(o.nudges_sent || 0) + 1;
      const lines = [];
      if (nudgeNumber === 1) {
        lines.push(`ICYMI ${o.display_name || "there"} — **${round.title}** is open and you've got items waiting.`);
      } else if (nudgeNumber <= 3) {
        lines.push(`Hey ${o.display_name || "there"} — friendly reminder on **${round.title}**.`);
      } else {
        lines.push(`Heads up — you're now at nudge **#${nudgeNumber}** for **${round.title}**. The league is waiting on you.`);
      }
      lines.push(`You haven't voted on ${missingItems.length} item${missingItems.length === 1 ? "" : "s"}:`);
      lines.push(``);
      for (const it of missingItems) {
        const link = guildId && it.discord_thread_id ? threadDeepLink(guildId, it.discord_thread_id) : "";
        lines.push(link ? `${it.ordinal}. [${it.title}](${link})` : `${it.ordinal}. ${it.title}`);
      }
      lines.push(``);
      lines.push(`Tap a thread to vote, comment, or ask the bot to explain.`);
      if (ageMs < 6 * 24 * 60 * 60 * 1000) {
        lines.push(`*Next nudge: in ~48 hours unless you vote first.*`);
      } else {
        lines.push(`*Next nudge: tomorrow unless you vote first.*`);
      }

      const dr = await sendDm(env, cid, { content: lines.join("\n").slice(0, 1990) });
      if (!dr.ok) {
        console.log(`[auto-nudge] DM failed for ${o.discord_user_id}: status=${dr.status}`);
        continue;
      }
      await env.UPS_MFL_DB.prepare(`
        UPDATE discord_round_owners
        SET nudges_sent = COALESCE(nudges_sent, 0) + 1, last_nudge_utc = ?
        WHERE round_id = ? AND discord_user_id = ?
      `).bind(nowIso(), round.round_id, o.discord_user_id).run();
      totalNudged++;
    }
  }
  return { nudged: totalNudged, rounds: rounds.length };
}

// ---------- Subcommand: /rules nudge ----------
async function handleNudge(interaction, env) {
  if (!isCommish(interaction, env)) return ephemeral("`/rules nudge` is commish-only.");
  const round = await getActiveRound(env);
  if (!round) return ephemeral("No active round.");
  const items = await getRoundItems(env, round.round_id);
  const owners = await getRoundOwners(env, round.round_id);
  const guildId = safeStr(env.DISCORD_GUILD_ID || guildIdFromInteraction(interaction));

  let nudged = 0;
  for (const o of owners) {
    // Find items the owner hasn't voted on AND that are still open to votes.
    // Franchise-aware so multi-account users aren't nudged twice.
    const missingItems = [];
    for (const it of items) {
      const r = await getActiveResponseByFranchise(env, round.round_id, it.proposal_id, o.discord_user_id);
      if (!r) missingItems.push(it);
    }
    if (!missingItems.length) continue;
    const cid = o.bot_dm_channel_id || (await openDmChannel(env, o.discord_user_id));
    if (!cid) continue;
    const lines = [
      `Quick nudge — you haven't weighed in on ${missingItems.length} item${missingItems.length === 1 ? "" : "s"} in **${round.title}**:`,
      ``,
    ];
    for (const it of missingItems) {
      const link = guildId && it.discord_thread_id ? threadDeepLink(guildId, it.discord_thread_id) : "";
      lines.push(link ? `${it.ordinal}. [${it.title}](${link})` : `${it.ordinal}. ${it.title}`);
    }
    lines.push(``);
    lines.push(`Tap a thread to vote, comment, or ask the bot to explain.`);
    await sendDm(env, cid, { content: lines.join("\n").slice(0, 1990) });
    await env.UPS_MFL_DB.prepare(`
      UPDATE discord_round_owners SET nudges_sent = COALESCE(nudges_sent,0)+1, last_nudge_utc = ?
      WHERE round_id = ? AND discord_user_id = ?
    `).bind(nowIso(), round.round_id, o.discord_user_id).run();
    nudged++;
  }
  return ephemeral(`Nudged ${nudged} owner${nudged === 1 ? "" : "s"}.`);
}

// ---------- Component (button) handlers ----------
async function handleButton(interaction, env, ctx) {
  const customId = safeStr(interaction?.data?.custom_id || "");
  const parts = customId.split(":");
  if (parts[0] !== "t") return ephemeral("Unknown button.");
  const action = parts[1];
  const roundId = parts[2];
  const proposalId = parts[3];
  const round = await getActiveRound(env, roundId);
  if (!round) return ephemeral("That round isn't active anymore.");
  const item = await getRoundItemByProposal(env, round.round_id, proposalId);
  if (!item) return ephemeral("Item not found in this round.");

  const callerId = getCallerId(interaction);
  const callerName = getCallerName(interaction);
  await ensureOwnerRow(env, round.round_id, callerId, callerName);

  if (action === "vote") {
    const value = parts[4];
    if (!["yes", "no"].includes(value)) return ephemeral("Use the Abstain button for abstain (reason required).");
    // Open the optional-reason modal. Vote isn't recorded until modal submit.
    return jsonResponse(voteWithReasonModalPayload(round, item, value));
  }
  if (action === "abstain") {
    // Open the abstain modal — reasoning is mandatory.
    return jsonResponse(abstainModalPayload(round, item));
  }
  if (action === "comment") {
    return jsonResponse(commentModalPayload(round, item));
  }
  if (action === "explain" || action === "explain_again") {
    return jsonResponse(explainModalPayload(round, item));
  }
  return ephemeral("Button not recognized.");
}

// Cast / change a vote. Posts a per-voter line in the thread (or edits the
// existing one), then refreshes the tally pin and checks for threshold.
async function castVote(env, ctx, round, item, discordUserId, displayName, value, reasoning) {
  const decision = await classifyVoteAttempt(env, round, item, discordUserId);
  if (!decision.allowed) {
    if (decision.reason === "round_closed") {
      return ephemeral("🔒 The round is closed. Voting is no longer accepted.");
    }
    if (decision.reason === "vote_changes_locked") {
      return ephemeral(`🔒 Your vote is locked. The threshold was hit and the ${VOTE_CHANGE_LOCK_MINUTES}-minute change window has closed. Late votes from non-voters are still accepted.`);
    }
    if (decision.reason === "franchise_locked_by_other_account") {
      const e = decision.existing || {};
      const v = String(e.value || "").toUpperCase();
      const otherId = safeStr(e.discord_user_id || "");
      const mention = otherId ? `<@${otherId}>` : "your other account";
      return ephemeral(`🔒 Read-only — ${mention} already voted **${v}** on this item from your other account. To change the vote, use that account.`);
    }
    return ephemeral("Vote rejected.");
  }

  const existing = decision.existing;
  const verbalLine = voteLineContent(displayName, value, reasoning);

  // Post or edit the per-voter message in the thread.
  let threadMsgId = existing?.thread_message_id || "";
  if (item.discord_thread_id) {
    if (threadMsgId) {
      const er = await editMessage(env, item.discord_thread_id, threadMsgId, { content: verbalLine });
      if (!er.ok) {
        // If edit failed (message deleted, etc.), post a fresh one.
        const pr = await postChannelMessage(env, item.discord_thread_id, { content: verbalLine });
        if (pr.ok) threadMsgId = safeStr(pr.data?.id || "");
      }
    } else {
      const pr = await postChannelMessage(env, item.discord_thread_id, { content: verbalLine });
      if (pr.ok) threadMsgId = safeStr(pr.data?.id || "");
    }
  }

  await recordVote(env, round.round_id, item.proposal_id, discordUserId, value, reasoning, threadMsgId);

  // Threshold check (and verdict-lock if hit).
  const refreshed = await getRoundItemByProposal(env, round.round_id, item.proposal_id);
  await checkAndMarkThreshold(env, round, refreshed);

  // Refresh tally pin.
  const reFinal = await getRoundItemByProposal(env, round.round_id, item.proposal_id);
  await refreshTallyPin(env, round, reFinal);

  // If threshold-already-set + lock-elapsed and we haven't announced, sweep.
  if (ctx && typeof ctx.waitUntil === "function") {
    ctx.waitUntil(processPendingSummaries(env).catch((e) => console.log(`[vote] sweep err: ${e?.message || e}`)));
  }

  // The reason (if any) was already captured via the vote modal (Yes/No)
  // or the abstain modal. Plain confirmation back to the voter.
  return ephemeral(`✓ Recorded **${value.toUpperCase()}** on _${item.title}_${reasoning ? " (reason saved)" : ""}.`);
}

// ---------- Modal handlers ----------
async function handleModalSubmit(interaction, env, ctx) {
  const customId = safeStr(interaction?.data?.custom_id || "");
  const parts = customId.split(":");
  if (parts[0] !== "t") return ephemeral("Unknown modal.");
  const action = parts[1];
  const roundId = parts[2];
  const proposalId = parts[3];
  const round = await getActiveRound(env, roundId);
  if (!round) return ephemeral("Round isn't active anymore.");
  const item = await getRoundItemByProposal(env, round.round_id, proposalId);
  if (!item) return ephemeral("Item not found.");
  const callerId = getCallerId(interaction);
  const callerName = getCallerName(interaction);
  await ensureOwnerRow(env, round.round_id, callerId, callerName);

  if (action === "abstain_modal") {
    const txt = modalTextValue(interaction, "txt");
    if (!txt || txt.length < 3) return ephemeral("Reason is required (minimum 3 chars).");
    return await castVote(env, ctx, round, item, callerId, callerName, "abstain", txt);
  }
  if (action === "comment_modal") {
    const txt = modalTextValue(interaction, "txt");
    if (!txt) return ephemeral("Comment is empty.");
    return await postCommentToThread(env, round, item, callerId, callerName, txt);
  }
  if (action === "explain_modal") {
    return await handleExplainModalSubmit(env, ctx, round, item, callerId, interaction);
  }
  if (action === "vote_modal") {
    // Yes/No vote with optional reason — modal opened from the vote button.
    const value = parts[4];
    if (!["yes", "no"].includes(value)) return ephemeral("Bad vote value.");
    const txt = modalTextValue(interaction, "txt");
    return await castVote(env, ctx, round, item, callerId, callerName, value, txt || null);
  }
  return ephemeral("Modal not recognized.");
}

async function postCommentToThread(env, round, item, discordUserId, displayName, body) {
  if (!item.discord_thread_id) return ephemeral("Thread missing for this item.");
  const line = `💬 **${displayName || "Owner"}**: ${fitToFieldValue(body.replace(/\n/g, " "), 1500)}`;
  const r = await postChannelMessage(env, item.discord_thread_id, { content: line });
  const tmid = r.ok ? safeStr(r.data?.id || "") : null;
  await recordComment(env, round.round_id, item.proposal_id, discordUserId, displayName, body, tmid);
  await refreshTallyPin(env, round, item).catch(() => {});
  return ephemeral(`💬 Comment posted in the thread.`);
}

async function handleExplainModalSubmit(env, ctx, round, item, callerId, interaction) {
  const question = modalTextValue(interaction, "q");
  if (!question) return ephemeral("Type a question first.");
  if (!item.discord_thread_id) return ephemeral("Thread missing for this item.");

  // Defer ephemeral, run Claude in background, post the answer to the thread.
  const work = async () => {
    let answer;
    try {
      // Per-proposal memory: prior Q&A + commish rulings ride along so the
      // bot stops re-answering settled questions and never contradicts a
      // ruling ("always trust my voice as the determining factor").
      let grounding = "";
      try {
        const { fetchQaGrounding } = await import("./discord_rule_proposal.js");
        grounding = await fetchQaGrounding(env, item.proposal_id);
      } catch (_) { /* grounding is additive — never block the answer */ }
      const result = await callExplain(env, {
        proposalTitle: item.title,
        proposalBody: item.body_md,
        question,
        extraContext: grounding,
      });
      answer = result.ok ? result.answer : (result.answer || "(error)");
    } catch (e) {
      console.log(`[explain] callExplain threw: ${e?.message || e}`);
      answer = "🤖 Something went sideways calling the explain service.";
    }
    // Log the exchange — thread Q&A is learning data exactly like DM Discuss.
    try {
      await env.UPS_MFL_DB.prepare(`
        INSERT INTO hall_qa_log
          (proposal_id, round_id, discord_user_id, display_name, kind,
           question_text, bot_answer, source, created_at_utc)
        VALUES (?, ?, ?, ?, 'question', ?, ?, 'thread_explain', ?)
      `).bind(item.proposal_id, round.round_id, getCallerId(interaction) || null,
        getCallerName(interaction) || null, question, answer, nowIso()).run();
    } catch (e) {
      console.log(`[explain] qa_log insert failed (non-fatal): ${e?.message || e}`);
    }
    const callerName = getCallerName(interaction);
    const lines = [
      `🤔 **${callerName || "Someone"} asked:** _${question.replace(/\n/g, " ").slice(0, 200)}${question.length > 200 ? "…" : ""}_`,
      ``,
      answer,
    ];
    // Include an "Ask follow-up" button so anyone in the thread can chain
    // another question without leaving the thread or hunting for the
    // Explain button on the proposal message.
    await postChannelMessage(env, item.discord_thread_id, {
      content: lines.join("\n").slice(0, 1990),
      components: [
        {
          type: COMPONENT_TYPE.ACTION_ROW,
          components: [
            { type: COMPONENT_TYPE.BUTTON, style: BUTTON_STYLE.PRIMARY, label: "Questions? 🤖", custom_id: `t:explain:${round.round_id}:${item.proposal_id}` },
          ],
        },
      ],
    });
  };
  if (ctx && typeof ctx.waitUntil === "function") {
    ctx.waitUntil(work().catch((e) => console.log(`[explain] err: ${e?.message || e}`)));
  } else {
    work().catch(() => {});
  }
  // Ack the modal — the actual answer will land in the thread momentarily.
  return ephemeral("🤖 Working on it — your question + the answer will appear in the thread.");
}

// ---------- Public entry points ----------
export async function runHallSubcommand(interaction, env, ctx) {
  const subRoot = interaction?.data?.options?.[0];
  const subName = safeStr(subRoot?.name).toLowerCase();
  if (subName === "start") return await handleStart(interaction, env, ctx);
  if (subName === "status") return await handleStatus(interaction, env);
  if (subName === "close") return await handleClose(interaction, env, ctx);
  if (subName === "nudge") return await handleNudge(interaction, env);
  return null;
}

export async function handleComponentInteraction(interaction, env, ctx) {
  return await handleButton(interaction, env, ctx);
}

export async function handleModalInteraction(interaction, env, ctx) {
  return await handleModalSubmit(interaction, env, ctx);
}

// One-shot: re-render the kickoff anchor + every per-item tally pin for an
// open round, using whatever the current code says (e.g. after the
// franchise dedupe was added). Edits in place — Discord PATCH does not
// notify recipients, so no DMs/pings fire. Idempotent: safe to run any
// number of times.
export async function refreshRoundDisplays(env, roundId) {
  const round = await getActiveRound(env, roundId);
  if (!round) return { ok: false, error: "round_not_found" };
  const items = await getRoundItems(env, round.round_id);
  const owners = await getRoundOwners(env, round.round_id);
  const dedupedPool = dedupeOwnersByFranchise(owners).length;
  let anchorEdited = false;
  let talliesEdited = 0;

  // 1. Edit the kickoff anchor in place.
  if (round.kickoff_anchor_message_id && round.kickoff_channel_id) {
    const anchorLines = [
      `🏛 **${round.title}** is now open.`,
      `${items.length} items · pool ${dedupedPool} · threshold per item shown in each thread`,
      ``,
      `**In this round of voting:**`,
    ];
    for (const it of items) anchorLines.push(`${it.ordinal}. ${it.title}`);
    anchorLines.push(``);
    anchorLines.push(`Each item has its own thread below. Vote, comment, or ask the bot to explain. I'll DM nudges to non-voters every 48h for the first 6 days, then daily.`);
    const er = await editMessage(env, round.kickoff_channel_id, round.kickoff_anchor_message_id, {
      content: anchorLines.join("\n").slice(0, 1990),
    });
    anchorEdited = !!er.ok;
  }

  // 2. Refresh each item's pinned tally message.
  for (const it of items) {
    if (!it.tally_message_id || !it.discord_thread_id) continue;
    await refreshTallyPin(env, round, it);
    talliesEdited++;
  }

  return { ok: true, round_id: round.round_id, pool: dedupedPool, anchor_edited: anchorEdited, tallies_edited: talliesEdited };
}

// Test-fire endpoint (kept for previewing summary output without running a real round).
export async function fireTestSummary(env, { proposalId, finalOutcome, finalYes, finalNo, finalAbstain, roundTitle }) {
  const { results } = await env.UPS_MFL_DB
    .prepare("SELECT id, title, body_md, discussion_only FROM hall_proposals WHERE id = ?").bind(proposalId).all();
  const proposal = results?.[0];
  if (!proposal) return { ok: false, error: "proposal_not_found" };
  const outcome = proposal.discussion_only ? "discussion" : (finalOutcome || "passed");
  const annCid = announceChannelId(env);
  if (!annCid) return { ok: false, error: "no_announce_channel_configured" };
  const verdictWord = outcome === "passed" ? "PASSED" : outcome === "rejected" ? "REJECTED" : "CLOSED";
  const verdictEmoji = outcome === "passed" ? "✅" : outcome === "rejected" ? "❌" : "🗣";
  const r = await postChannelMessage(env, annCid, {
    content: `${verdictEmoji} **Rule ${verdictWord}: ${proposal.title}** — _(test fire — no thread link)_`,
  });
  return r.ok
    ? { ok: true, message_id: safeStr(r.data?.id || ""), thread_id: "" }
    : { ok: false, error: `discord_post_failed status=${r.status}` };
}
