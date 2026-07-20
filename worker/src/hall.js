// worker/src/hall.js
// UPS League Hall — owner proposal/discussion/voting routes (Phase 1).
//
// Mounted from worker/src/index.js. Returns a Response when the path
// matches a hall route; returns null otherwise so the main dispatcher
// continues. Identity is honor-system in Phase 1 (optional self-reported
// name + opaque session token in localStorage on the client + IP-hash
// soft-throttle); the schema is identity-ready for the Phase 3 swap.

import { fireTestSummary, refreshRoundDisplays } from "./discord_round.js";
import { integrateApprovedRule } from "./rule_integrator.js";

const HALL_TYPES = new Set(["fyi", "sentiment", "vote"]);
const HALL_PUBLIC_STATUSES = new Set(["open", "closed", "passed", "rejected"]);
const HALL_RESPONSE_KINDS = new Set(["ack", "sentiment", "vote", "comment"]);
const HALL_VOTE_VALUES = new Set(["yes", "no", "abstain"]);
const HALL_SENTIMENT_VALUES = new Set(["up", "down", "meh"]);

// (The legacy site/hall/ frontend was removed 2026-05-08 — voting moved
// fully to Discord threads. A future "all rules" public site will be a
// separate build; the bot is the interactive surface in the meantime.)

function safeStr(v) {
  return String(v == null ? "" : v).trim();
}

function nowIso() {
  return new Date().toISOString();
}

function jsonOut(status, payload, corsHeaders) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json", ...corsHeaders },
  });
}

async function sha256Hex(input) {
  const data = new TextEncoder().encode(String(input || ""));
  const buf = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function clientIpFromRequest(request) {
  return safeStr(
    request.headers.get("CF-Connecting-IP") ||
      request.headers.get("X-Forwarded-For") ||
      ""
  ).split(",")[0].trim();
}

function checkAdmin(request, env) {
  const expected = safeStr(env.COMMISH_API_KEY || "");
  if (!expected) return { ok: false, reason: "Missing COMMISH_API_KEY worker secret" };
  const provided = safeStr(request.headers.get("X-Internal-Auth") || "");
  if (provided !== expected) return { ok: false, reason: "Valid COMMISH_API_KEY required" };
  return { ok: true };
}

function postDiscordMessage(env, channelId, content) {
  // Reuses the same DISCORD_BOT_TOKEN that the rest of the worker uses
  // for admin Discord posts (cap penalties, bug reports, etc.).
  const botToken = safeStr(env.DISCORD_BOT_TOKEN || env.DISCORD_BOT || "");
  const cid = safeStr(channelId).replace(/\D/g, "");
  if (!botToken) return Promise.resolve({ ok: false, error: "missing_discord_bot_token" });
  if (!cid) return Promise.resolve({ ok: false, error: "missing_channel_id" });
  return fetch(`https://discord.com/api/v10/channels/${encodeURIComponent(cid)}/messages`, {
    method: "POST",
    headers: { Authorization: `Bot ${botToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      content: safeStr(content).slice(0, 1900),
      allowed_mentions: { parse: [] },
    }),
  })
    .then(async (res) => {
      const text = await res.text();
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch (_) { data = null; }
      return { ok: res.ok, status: res.status, message_id: safeStr(data?.id || ""), error: res.ok ? "" : safeStr(text).slice(0, 400) };
    })
    .catch((e) => ({ ok: false, status: 0, error: `fetch_failed: ${e?.message || String(e)}` }));
}

function announcementChannelId(env) {
  return safeStr(env.DISCORD_HALL_CHANNEL_ID || env.DISCORD_REMINDER_CHANNEL_ID || "").replace(/\D/g, "");
}

function typeBadge(type) {
  if (type === "vote") return "🟥 Vote required";
  if (type === "sentiment") return "🟨 Sentiment check";
  return "🟦 FYI";
}

function buildAnnouncementContent(env, proposal) {
  const lines = [];
  lines.push(`🆕 **New Hall item — ${typeBadge(proposal.type)}:** ${proposal.title}`);
  if (proposal.deadline_utc) {
    const d = new Date(proposal.deadline_utc);
    if (!isNaN(d.getTime())) lines.push(`*Respond by: ${d.toUTCString()}*`);
  }
  if (proposal.tldr) {
    lines.push("");
    lines.push(proposal.tldr);
  }
  lines.push("");
  lines.push(`Voting + discussion happens in the rules channel — use \`/rules start\` to spin up the round.`);
  return lines.join("\n");
}

async function tallyForProposal(env, proposal) {
  // Active (non-superseded) responses only.
  const sql = `
    SELECT response_kind, value, COUNT(*) AS n
    FROM hall_responses
    WHERE proposal_id = ? AND superseded_at_utc IS NULL
    GROUP BY response_kind, value
  `;
  const { results } = await env.UPS_MFL_DB.prepare(sql).bind(proposal.id).all();
  const tally = {
    type: proposal.type,
    ack: 0,
    sentiment: { up: 0, down: 0, meh: 0 },
    vote: { yes: 0, no: 0, abstain: 0 },
    comment_count: 0,
    total_responders: 0,
  };
  for (const row of results || []) {
    const kind = safeStr(row.response_kind);
    const value = safeStr(row.value);
    const n = Number(row.n) || 0;
    if (kind === "ack") tally.ack += n;
    else if (kind === "sentiment" && tally.sentiment[value] != null) tally.sentiment[value] += n;
    else if (kind === "vote" && tally.vote[value] != null) tally.vote[value] += n;
    else if (kind === "comment") tally.comment_count += n;
  }
  // Distinct responders (sessions) for "X of Y voted" displays.
  const { results: distinct } = await env.UPS_MFL_DB
    .prepare("SELECT COUNT(DISTINCT COALESCE(session_token, responder_ip_hash, response_id)) AS n FROM hall_responses WHERE proposal_id = ? AND superseded_at_utc IS NULL")
    .bind(proposal.id).all();
  tally.total_responders = Number(distinct?.[0]?.n || 0);

  if (proposal.type === "vote") {
    const yes = tally.vote.yes;
    const no = tally.vote.no;
    const abstain = tally.vote.abstain;
    const decided = yes + no;
    tally.vote.decided = decided;
    tally.vote.yes_pct = decided > 0 ? Math.round((yes / decided) * 1000) / 10 : null;
    tally.vote.threshold_pct = proposal.threshold_yes_pct;
    tally.vote.quorum_min = proposal.quorum_min;
    tally.vote.quorum_met = (yes + no + abstain) >= proposal.quorum_min;
    tally.vote.would_pass = tally.vote.quorum_met && tally.vote.yes_pct != null && tally.vote.yes_pct >= proposal.threshold_yes_pct;
  }
  return tally;
}

async function recentCommentsForProposal(env, proposalId, limit) {
  const lim = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);
  const sql = `
    SELECT response_id, response_kind, value, comment_text, responder_name, responder_discord_handle, created_at_utc
    FROM hall_responses
    WHERE proposal_id = ? AND superseded_at_utc IS NULL
      AND comment_text IS NOT NULL AND length(comment_text) > 0
    ORDER BY created_at_utc DESC
    LIMIT ?
  `;
  const { results } = await env.UPS_MFL_DB.prepare(sql).bind(proposalId, lim).all();
  return (results || []).map((r) => ({
    response_id: r.response_id,
    response_kind: r.response_kind,
    value: r.value,
    comment_text: r.comment_text,
    responder_name: r.responder_name || null,
    responder_discord_handle: r.responder_discord_handle || null,
    created_at_utc: r.created_at_utc,
  }));
}

async function ownStateForSession(env, proposalId, sessionToken) {
  if (!sessionToken) return { vote: null, sentiment: null, ack: false, comments: 0 };
  const sql = `
    SELECT response_kind, value, comment_text, created_at_utc
    FROM hall_responses
    WHERE proposal_id = ? AND session_token = ? AND superseded_at_utc IS NULL
    ORDER BY created_at_utc DESC
  `;
  const { results } = await env.UPS_MFL_DB.prepare(sql).bind(proposalId, sessionToken).all();
  const state = { vote: null, sentiment: null, ack: false, comments: 0 };
  for (const r of results || []) {
    if (r.response_kind === "vote" && !state.vote) state.vote = { value: r.value, comment_text: r.comment_text || "", created_at_utc: r.created_at_utc };
    else if (r.response_kind === "sentiment" && !state.sentiment) state.sentiment = { value: r.value, comment_text: r.comment_text || "", created_at_utc: r.created_at_utc };
    else if (r.response_kind === "ack") state.ack = true;
    else if (r.response_kind === "comment") state.comments += 1;
  }
  return state;
}

function shapeProposal(row) {
  return {
    id: row.id,
    title: row.title,
    type: row.type,
    status: row.status,
    category: row.category || "",
    tldr: row.tldr || "",
    body_md: row.body_md || "",
    deadline_utc: row.deadline_utc || null,
    quorum_min: row.quorum_min,
    threshold_yes_pct: row.threshold_yes_pct,
    discord_announce_channel_id: row.discord_announce_channel_id || "",
    discord_announce_message_id: row.discord_announce_message_id || "",
    created_at_utc: row.created_at_utc,
    created_by: row.created_by || "",
    closed_at_utc: row.closed_at_utc || null,
    final_tally_json: row.final_tally_json ? safeJsonParse(row.final_tally_json) : null,
  };
}

function safeJsonParse(s) {
  try { return JSON.parse(s); } catch (_) { return null; }
}

// ---------- Route: GET /api/hall/proposals ----------
async function listProposals(request, env, corsHeaders) {
  const url = new URL(request.url);
  const includeDrafts = url.searchParams.get("include_drafts") === "1";
  const adminOk = includeDrafts ? checkAdmin(request, env).ok : false;
  const includeDraftsEffective = includeDrafts && adminOk;

  let sql, args;
  if (includeDraftsEffective) {
    sql = "SELECT * FROM hall_proposals ORDER BY created_at_utc DESC";
    args = [];
  } else {
    sql = "SELECT * FROM hall_proposals WHERE status IN ('open','closed','passed','rejected') ORDER BY (status='open') DESC, created_at_utc DESC";
    args = [];
  }
  const { results } = await env.UPS_MFL_DB.prepare(sql).bind(...args).all();
  const proposals = [];
  for (const row of results || []) {
    const p = shapeProposal(row);
    // Light tally for the list view (just open + recent counts).
    if (p.status === "open") {
      const tally = await tallyForProposal(env, p);
      p.tally = tally;
    } else if (p.final_tally_json) {
      p.tally = p.final_tally_json;
    }
    proposals.push(p);
  }
  return jsonOut(200, { ok: true, proposals }, corsHeaders);
}

// ---------- Route: GET /api/hall/proposals/:id ----------
async function getProposal(request, env, corsHeaders, proposalId) {
  const sessionToken = safeStr(request.headers.get("X-Hall-Session") || "");
  const { results } = await env.UPS_MFL_DB
    .prepare("SELECT * FROM hall_proposals WHERE id = ?")
    .bind(proposalId).all();
  const row = results?.[0];
  if (!row) return jsonOut(404, { ok: false, error: "proposal_not_found" }, corsHeaders);

  const proposal = shapeProposal(row);
  // Hide drafts from non-admins.
  if (proposal.status === "draft" && !checkAdmin(request, env).ok) {
    return jsonOut(404, { ok: false, error: "proposal_not_found" }, corsHeaders);
  }

  const tally = proposal.status === "open"
    ? await tallyForProposal(env, proposal)
    : (proposal.final_tally_json || await tallyForProposal(env, proposal));
  const comments = await recentCommentsForProposal(env, proposal.id, 50);
  const own = await ownStateForSession(env, proposal.id, sessionToken);
  return jsonOut(200, { ok: true, proposal, tally, comments, own }, corsHeaders);
}

// ---------- Route: POST /api/hall/proposals/:id/respond ----------
async function respond(request, env, corsHeaders, proposalId) {
  let body;
  try { body = await request.json(); } catch (_) { return jsonOut(400, { ok: false, error: "invalid_json" }, corsHeaders); }
  const kind = safeStr(body?.response_kind || "").toLowerCase();
  if (!HALL_RESPONSE_KINDS.has(kind)) return jsonOut(400, { ok: false, error: "invalid_response_kind" }, corsHeaders);
  const value = safeStr(body?.value || "").toLowerCase();
  const commentText = safeStr(body?.comment_text || "").slice(0, 4000);
  const responderName = safeStr(body?.responder_name || "").slice(0, 80);
  const responderHandle = safeStr(body?.responder_discord_handle || "").slice(0, 80);
  let sessionToken = safeStr(request.headers.get("X-Hall-Session") || body?.session_token || "");
  if (!sessionToken || sessionToken.length < 16 || sessionToken.length > 80) {
    sessionToken = crypto.randomUUID();
  }

  // Load proposal + validate it's open and the response shape matches the type.
  const { results } = await env.UPS_MFL_DB.prepare("SELECT * FROM hall_proposals WHERE id = ?").bind(proposalId).all();
  const row = results?.[0];
  if (!row) return jsonOut(404, { ok: false, error: "proposal_not_found" }, corsHeaders);
  const proposal = shapeProposal(row);
  if (proposal.status !== "open") return jsonOut(409, { ok: false, error: "proposal_not_open" }, corsHeaders);

  if (kind === "ack" && proposal.type !== "fyi") return jsonOut(400, { ok: false, error: "ack_only_on_fyi" }, corsHeaders);
  if (kind === "sentiment" && proposal.type !== "sentiment") return jsonOut(400, { ok: false, error: "sentiment_only_on_sentiment_proposal" }, corsHeaders);
  if (kind === "vote" && proposal.type !== "vote") return jsonOut(400, { ok: false, error: "vote_only_on_vote_proposal" }, corsHeaders);
  if (kind === "vote" && !HALL_VOTE_VALUES.has(value)) return jsonOut(400, { ok: false, error: "invalid_vote_value" }, corsHeaders);
  if (kind === "sentiment" && !HALL_SENTIMENT_VALUES.has(value)) return jsonOut(400, { ok: false, error: "invalid_sentiment_value" }, corsHeaders);
  if (kind === "comment" && !commentText) return jsonOut(400, { ok: false, error: "comment_text_required" }, corsHeaders);

  const ip = clientIpFromRequest(request);
  const ipHash = ip ? await sha256Hex(`${ip}|${env.HALL_IP_SALT || "ups-hall-v1"}`) : null;
  const ua = safeStr(request.headers.get("User-Agent") || "").slice(0, 80);
  const ts = nowIso();

  // Vote-type: enforce one ACTIVE vote per session AND per ip_hash. If the
  // same session re-votes, supersede the prior; if a different session from
  // the same IP tries, return 409 with a clear message.
  if (kind === "vote") {
    // Check IP-hash collision from a DIFFERENT session token.
    if (ipHash) {
      const { results: collide } = await env.UPS_MFL_DB
        .prepare("SELECT response_id, session_token FROM hall_responses WHERE proposal_id = ? AND response_kind = 'vote' AND superseded_at_utc IS NULL AND responder_ip_hash = ?")
        .bind(proposal.id, ipHash).all();
      const otherSession = (collide || []).find((r) => safeStr(r.session_token) !== sessionToken);
      if (otherSession) {
        return jsonOut(409, {
          ok: false,
          error: "duplicate_vote_from_ip",
          reason: "Another vote from this network is already on file. If two owners share a network, contact the commish.",
        }, corsHeaders);
      }
    }
    // Supersede this session's prior vote (if any).
    await env.UPS_MFL_DB
      .prepare("UPDATE hall_responses SET superseded_at_utc = ? WHERE proposal_id = ? AND response_kind = 'vote' AND session_token = ? AND superseded_at_utc IS NULL")
      .bind(ts, proposal.id, sessionToken).run();
  }

  // Sentiment + ack: latest-wins. Supersede prior of same kind from same session.
  if (kind === "sentiment" || kind === "ack") {
    await env.UPS_MFL_DB
      .prepare("UPDATE hall_responses SET superseded_at_utc = ? WHERE proposal_id = ? AND response_kind = ? AND session_token = ? AND superseded_at_utc IS NULL")
      .bind(ts, proposal.id, kind, sessionToken).run();
  }
  // Comments: keep all (no supersede), but throttle.
  if (kind === "comment") {
    const { results: recent } = await env.UPS_MFL_DB
      .prepare("SELECT COUNT(*) AS n FROM hall_responses WHERE proposal_id = ? AND response_kind = 'comment' AND session_token = ? AND created_at_utc > datetime('now', '-1 hour')")
      .bind(proposal.id, sessionToken).all();
    if ((Number(recent?.[0]?.n) || 0) >= 6) {
      return jsonOut(429, { ok: false, error: "comment_rate_limited", reason: "Slow down — limit 6 comments per hour per session." }, corsHeaders);
    }
  }

  const insertSql = `
    INSERT INTO hall_responses
      (proposal_id, response_kind, value, comment_text, responder_name, responder_discord_handle,
       responder_ip_hash, session_token, user_agent_short, created_at_utc)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `;
  const insertRes = await env.UPS_MFL_DB.prepare(insertSql).bind(
    proposal.id,
    kind,
    kind === "ack" ? "ack" : (kind === "comment" ? null : value),
    commentText || null,
    responderName || null,
    responderHandle || null,
    ipHash,
    sessionToken,
    ua || null,
    ts,
  ).run();

  const tally = await tallyForProposal(env, proposal);
  const own = await ownStateForSession(env, proposal.id, sessionToken);
  return jsonOut(200, {
    ok: true,
    response_id: insertRes?.meta?.last_row_id || null,
    session_token: sessionToken,
    tally,
    own,
  }, corsHeaders);
}

// ---------- Route: POST /admin/hall/proposals (create or upsert) ----------
async function adminUpsertProposal(request, env, corsHeaders) {
  const auth = checkAdmin(request, env);
  if (!auth.ok) return jsonOut(403, { ok: false, error: auth.reason }, corsHeaders);
  let body;
  try { body = await request.json(); } catch (_) { return jsonOut(400, { ok: false, error: "invalid_json" }, corsHeaders); }
  const id = safeStr(body?.id || "");
  const title = safeStr(body?.title || "");
  const type = safeStr(body?.type || "").toLowerCase();
  const tldr = safeStr(body?.tldr || "").slice(0, 500);
  const bodyMd = safeStr(body?.body_md || "");
  const category = safeStr(body?.category || "").slice(0, 80);
  const deadlineUtc = safeStr(body?.deadline_utc || "") || null;
  const quorumMin = Math.max(0, parseInt(body?.quorum_min, 10) || 8);
  const thresholdYesPct = Math.max(0, Math.min(100, parseInt(body?.threshold_yes_pct, 10) || 60));
  const createdBy = safeStr(body?.created_by || "commish").slice(0, 80);

  if (!id || !/^[a-z0-9][a-z0-9-]{2,80}$/.test(id)) return jsonOut(400, { ok: false, error: "invalid_id_slug" }, corsHeaders);
  if (!title) return jsonOut(400, { ok: false, error: "title_required" }, corsHeaders);
  if (!HALL_TYPES.has(type)) return jsonOut(400, { ok: false, error: "invalid_type" }, corsHeaders);
  if (!bodyMd) return jsonOut(400, { ok: false, error: "body_md_required" }, corsHeaders);

  const ts = nowIso();
  // Upsert: try update; if 0 changes, insert.
  const updateRes = await env.UPS_MFL_DB.prepare(`
    UPDATE hall_proposals SET
      title = ?, type = ?, category = ?, tldr = ?, body_md = ?, deadline_utc = ?,
      quorum_min = ?, threshold_yes_pct = ?
    WHERE id = ? AND status = 'draft'
  `).bind(title, type, category, tldr, bodyMd, deadlineUtc, quorumMin, thresholdYesPct, id).run();

  let action = "updated";
  if (!updateRes?.meta?.changes) {
    // Try insert (will fail with constraint if already exists in non-draft state)
    const { results: existing } = await env.UPS_MFL_DB.prepare("SELECT id, status FROM hall_proposals WHERE id = ?").bind(id).all();
    if (existing?.[0]) {
      return jsonOut(409, { ok: false, error: "proposal_already_published", reason: `Proposal '${id}' is in status '${existing[0].status}' — only drafts may be edited via this route.` }, corsHeaders);
    }
    await env.UPS_MFL_DB.prepare(`
      INSERT INTO hall_proposals
        (id, title, type, status, category, tldr, body_md, deadline_utc,
         quorum_min, threshold_yes_pct, created_at_utc, created_by)
      VALUES (?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(id, title, type, category, tldr, bodyMd, deadlineUtc, quorumMin, thresholdYesPct, ts, createdBy).run();
    action = "created";
  }
  return jsonOut(200, { ok: true, action, id }, corsHeaders);
}

// ---------- Route: POST /admin/hall/proposals/:id/publish ----------
async function adminPublishProposal(request, env, corsHeaders, proposalId) {
  const auth = checkAdmin(request, env);
  if (!auth.ok) return jsonOut(403, { ok: false, error: auth.reason }, corsHeaders);
  let body = {};
  try { body = await request.json(); } catch (_) { /* ok */ }
  const channelOverride = safeStr(body?.discord_channel_id || "").replace(/\D/g, "");
  const skipDiscord = body?.skip_discord === true;

  const { results } = await env.UPS_MFL_DB.prepare("SELECT * FROM hall_proposals WHERE id = ?").bind(proposalId).all();
  const row = results?.[0];
  if (!row) return jsonOut(404, { ok: false, error: "proposal_not_found" }, corsHeaders);
  if (row.status !== "draft") return jsonOut(409, { ok: false, error: "not_in_draft" }, corsHeaders);

  const proposal = shapeProposal(row);
  let discordResult = { ok: false, error: "skipped" };
  let channelId = "";
  if (!skipDiscord) {
    channelId = channelOverride || announcementChannelId(env);
    if (channelId) {
      discordResult = await postDiscordMessage(env, channelId, buildAnnouncementContent(env, proposal));
    } else {
      discordResult = { ok: false, error: "no_channel_configured" };
    }
  }

  await env.UPS_MFL_DB.prepare(`
    UPDATE hall_proposals SET
      status = 'open',
      discord_announce_channel_id = ?,
      discord_announce_message_id = ?
    WHERE id = ?
  `).bind(
    discordResult.ok ? channelId : (row.discord_announce_channel_id || null),
    discordResult.ok ? discordResult.message_id : (row.discord_announce_message_id || null),
    proposalId,
  ).run();

  return jsonOut(200, { ok: true, id: proposalId, discord: discordResult }, corsHeaders);
}

// ---------- Route: POST /admin/hall/proposals/:id/close ----------
async function adminCloseProposal(request, env, corsHeaders, proposalId) {
  const auth = checkAdmin(request, env);
  if (!auth.ok) return jsonOut(403, { ok: false, error: auth.reason }, corsHeaders);
  let body = {};
  try { body = await request.json(); } catch (_) { /* ok */ }
  const skipDiscord = body?.skip_discord === true;

  const { results } = await env.UPS_MFL_DB.prepare("SELECT * FROM hall_proposals WHERE id = ?").bind(proposalId).all();
  const row = results?.[0];
  if (!row) return jsonOut(404, { ok: false, error: "proposal_not_found" }, corsHeaders);
  if (row.status !== "open") return jsonOut(409, { ok: false, error: "not_open" }, corsHeaders);
  const proposal = shapeProposal(row);
  const tally = await tallyForProposal(env, proposal);

  let finalStatus = "closed";
  if (proposal.type === "vote") {
    finalStatus = tally.vote.would_pass ? "passed" : "rejected";
  }
  const ts = nowIso();
  await env.UPS_MFL_DB.prepare(`
    UPDATE hall_proposals SET status = ?, closed_at_utc = ?, final_tally_json = ? WHERE id = ?
  `).bind(finalStatus, ts, JSON.stringify(tally), proposalId).run();

  let discordResult = { ok: false, error: "skipped" };
  if (!skipDiscord) {
    const channelId = safeStr(row.discord_announce_channel_id || announcementChannelId(env));
    if (channelId) {
      const closeContent = buildCloseTallyContent(env, proposal, finalStatus, tally);
      discordResult = await postDiscordMessage(env, channelId, closeContent);
    } else {
      discordResult = { ok: false, error: "no_channel_configured" };
    }
  }

  return jsonOut(200, { ok: true, id: proposalId, status: finalStatus, tally, discord: discordResult }, corsHeaders);
}

function buildCloseTallyContent(env, proposal, finalStatus, tally) {
  const lines = [];
  if (proposal.type === "vote") {
    const verdict = finalStatus === "passed" ? "✅ **PASSED**" : "❌ **REJECTED**";
    const v = tally.vote;
    lines.push(`📊 **Vote closed:** ${proposal.title}`);
    lines.push(`${verdict} — ${v.yes} yes, ${v.no} no, ${v.abstain} abstain (${tally.total_responders} responder${tally.total_responders === 1 ? "" : "s"}, ${v.yes_pct == null ? "—" : v.yes_pct + "%"} yes of decided)`);
    if (!v.quorum_met) lines.push(`*Quorum not met (${v.yes + v.no + v.abstain}/${v.quorum_min} required) — verdict reflects threshold rule.*`);
  } else if (proposal.type === "sentiment") {
    const s = tally.sentiment;
    lines.push(`📊 **Sentiment closed:** ${proposal.title}`);
    lines.push(`👍 ${s.up} · 👎 ${s.down} · 🤷 ${s.meh} · 💬 ${tally.comment_count} comment${tally.comment_count === 1 ? "" : "s"}`);
  } else {
    lines.push(`📊 **FYI closed:** ${proposal.title}`);
    lines.push(`👁️ ${tally.ack} acknowledgment${tally.ack === 1 ? "" : "s"}`);
  }
  return lines.join("\n");
}

// ---------- Route: GET /admin/hall/proposals/:id/responses ----------
async function adminListResponses(request, env, corsHeaders, proposalId) {
  const auth = checkAdmin(request, env);
  if (!auth.ok) return jsonOut(403, { ok: false, error: auth.reason }, corsHeaders);
  const { results } = await env.UPS_MFL_DB.prepare(`
    SELECT response_id, response_kind, value, comment_text, responder_name, responder_discord_handle,
           responder_ip_hash, session_token, franchise_id, discord_user_id, magic_link_token,
           user_agent_short, superseded_at_utc, created_at_utc
    FROM hall_responses
    WHERE proposal_id = ?
    ORDER BY created_at_utc DESC
  `).bind(proposalId).all();
  return jsonOut(200, { ok: true, responses: results || [] }, corsHeaders);
}

// ---------- Route: POST /admin/hall/discord-round/seed ----------
// One-shot: accepts a payload with proposals + round metadata + owners,
// upserts each proposal as 'open', creates the discord round + items + owner
// rows. Idempotent — safe to re-run; existing proposals are updated, existing
// round/items/owners are preserved (re-running won't duplicate).
async function adminSeedDiscordRound(request, env, corsHeaders) {
  const auth = checkAdmin(request, env);
  if (!auth.ok) return jsonOut(403, { ok: false, error: auth.reason }, corsHeaders);
  let body;
  try { body = await request.json(); } catch (_) { return jsonOut(400, { ok: false, error: "invalid_json" }, corsHeaders); }

  const round = body?.round || {};
  const proposals = Array.isArray(body?.proposals) ? body.proposals : [];
  const owners = Array.isArray(body?.owners) ? body.owners : [];

  const roundId = safeStr(round.round_id || "");
  const title = safeStr(round.title || "");
  if (!roundId || !/^[A-Za-z0-9][A-Za-z0-9-]{2,80}$/.test(roundId)) return jsonOut(400, { ok: false, error: "invalid_round_id" }, corsHeaders);
  if (!title) return jsonOut(400, { ok: false, error: "round_title_required" }, corsHeaders);
  if (!proposals.length) return jsonOut(400, { ok: false, error: "no_proposals" }, corsHeaders);
  if (!owners.length) return jsonOut(400, { ok: false, error: "no_owners" }, corsHeaders);

  const ts = nowIso();

  // 1. Upsert each proposal. Set status='open' so it's votable in the round.
  const proposalIds = [];
  for (const p of proposals) {
    const id = safeStr(p.id || "");
    if (!id || !/^[a-z0-9][a-z0-9-]{2,80}$/.test(id)) {
      return jsonOut(400, { ok: false, error: "invalid_proposal_id", id }, corsHeaders);
    }
    const pTitle = safeStr(p.title || "");
    const pType = safeStr(p.type || "vote").toLowerCase();
    const pTldr = safeStr(p.tldr || "").slice(0, 500);
    const pBody = safeStr(p.body_md || "");
    const pCat = safeStr(p.category || "").slice(0, 80);
    const pQuorum = Math.max(0, parseInt(p.quorum_min, 10) || 7);
    const pThresh = Math.max(0, Math.min(100, parseInt(p.threshold_yes_pct, 10) || 60));
    const pPassYes = Math.max(1, parseInt(p.pass_yes_count, 10) || 7);
    const pDiscussionOnly = p.discussion_only === true || p.discussion_only === 1 ? 1 : 0;

    if (!pTitle || !pBody) return jsonOut(400, { ok: false, error: "proposal_missing_fields", id }, corsHeaders);
    if (!HALL_TYPES.has(pType)) return jsonOut(400, { ok: false, error: "invalid_proposal_type", id }, corsHeaders);

    const { results: existing } = await env.UPS_MFL_DB
      .prepare("SELECT id, status FROM hall_proposals WHERE id = ?").bind(id).all();
    if (existing?.[0]) {
      await env.UPS_MFL_DB.prepare(`
        UPDATE hall_proposals
        SET title = ?, type = ?, category = ?, tldr = ?, body_md = ?,
            quorum_min = ?, threshold_yes_pct = ?, pass_yes_count = ?,
            discussion_only = ?, status = 'open'
        WHERE id = ?
      `).bind(pTitle, pType, pCat, pTldr, pBody, pQuorum, pThresh, pPassYes, pDiscussionOnly, id).run();
    } else {
      await env.UPS_MFL_DB.prepare(`
        INSERT INTO hall_proposals
          (id, title, type, status, category, tldr, body_md,
           quorum_min, threshold_yes_pct, pass_yes_count, discussion_only,
           created_at_utc, created_by)
        VALUES (?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, 'commish')
      `).bind(id, pTitle, pType, pCat, pTldr, pBody, pQuorum, pThresh, pPassYes, pDiscussionOnly, ts).run();
    }
    proposalIds.push(id);
  }

  // 2. Upsert the round.
  const draftDate = safeStr(round.draft_date_utc || "") || null;
  const votingDeadline = safeStr(round.voting_deadline_utc || "") || null;
  const submissionCloses = safeStr(round.proposal_submission_closes_at || "") || null;
  const testOnly = round.test_only ? 1 : 0;
  const broadcastChannel = safeStr(round.broadcast_channel_id || "") || null;
  const startedBy = safeStr(round.started_by || "commish");

  const { results: existRound } = await env.UPS_MFL_DB
    .prepare("SELECT round_id FROM discord_rounds WHERE round_id = ?").bind(roundId).all();
  if (existRound?.[0]) {
    // Re-seeding always resets the round to a fresh 'open' state — that's the
    // point of re-seeding during iteration. To preserve a closed round, just
    // don't re-seed it.
    // Reset started_at_utc to NOW on every re-seed. Otherwise the auto-nudge
    // cron's cadence math compares against a stale start timestamp from a
    // prior seed and can fire instant nudges if that timestamp is older
    // than 48h. (Lesson from 2026-05-06 misfire — see below.)
    await env.UPS_MFL_DB.prepare(`
      UPDATE discord_rounds
      SET title = ?, draft_date_utc = ?, voting_deadline_utc = ?,
          proposal_submission_closes_at = ?, test_only = ?, broadcast_channel_id = ?,
          status = 'open', closed_at_utc = NULL, final_summary_json = NULL,
          kickoff_anchor_message_id = NULL, kickoff_channel_id = NULL,
          started_at_utc = ?
      WHERE round_id = ?
    `).bind(title, draftDate, votingDeadline, submissionCloses, testOnly, broadcastChannel, ts, roundId).run();
    // Wipe per-owner progress + per-owner responses for a clean restart.
    // last_nudge_utc is set to `ts` (now), NOT NULL — the cron treats this
    // as "we just acknowledged the owner; wait the full cadence before any
    // nudge fires." Combined with the cron's NEW kickoff_anchor gate, this
    // means re-seeding never fires a misdirected nudge before /rules start.
    await env.UPS_MFL_DB.prepare(`
      UPDATE discord_round_owners
      SET state = 'not_started', current_ordinal = NULL, last_active_utc = NULL,
          nudges_sent = 0, last_nudge_utc = ?, bot_thread_message_ids = NULL
      WHERE round_id = ?
    `).bind(ts, roundId).run();
    await env.UPS_MFL_DB.prepare(`
      DELETE FROM discord_responses WHERE round_id = ?
    `).bind(roundId).run();
    // Wipe per-item state so a re-seeded round actually re-opens every
    // item AND clears any orphan thread/message references from a prior
    // /rules start (otherwise the next /rules start sees the round
    // "already has an anchor" and bails).
    await env.UPS_MFL_DB.prepare(`
      UPDATE discord_round_items
      SET closed_at_utc = NULL, close_reason = NULL, final_outcome = NULL,
          final_yes = NULL, final_no = NULL, final_abstain = NULL,
          summary_posted_at_utc = NULL, summary_message_id = NULL, summary_thread_id = NULL,
          threshold_reached_at_utc = NULL, votes_locked_at_utc = NULL,
          discord_thread_id = NULL, proposal_message_id = NULL, tally_message_id = NULL,
          announce_message_id = NULL, announce_channel_id = NULL
      WHERE round_id = ?
    `).bind(roundId).run();
    await env.UPS_MFL_DB.prepare(`
      DELETE FROM discord_comments WHERE round_id = ?
    `).bind(roundId).run();
  } else {
    await env.UPS_MFL_DB.prepare(`
      INSERT INTO discord_rounds
        (round_id, title, status, started_at_utc, started_by, draft_date_utc,
         voting_deadline_utc, proposal_submission_closes_at, test_only, broadcast_channel_id)
      VALUES (?, ?, 'open', ?, ?, ?, ?, ?, ?, ?)
    `).bind(roundId, title, ts, startedBy, draftDate, votingDeadline, submissionCloses, testOnly, broadcastChannel).run();
  }

  // 3. Replace items (drop existing, insert fresh in order). Cascade-safe.
  await env.UPS_MFL_DB.prepare("DELETE FROM discord_round_items WHERE round_id = ?").bind(roundId).run();
  for (let i = 0; i < proposalIds.length; i++) {
    await env.UPS_MFL_DB.prepare(`
      INSERT INTO discord_round_items (round_id, ordinal, proposal_id) VALUES (?, ?, ?)
    `).bind(roundId, i + 1, proposalIds[i]).run();
  }

  // 4. Upsert owners.
  for (const o of owners) {
    const did = safeStr(o.discord_user_id || "");
    if (!did || !/^\d{15,25}$/.test(did)) {
      return jsonOut(400, { ok: false, error: "invalid_discord_user_id", value: did }, corsHeaders);
    }
    const dn = safeStr(o.display_name || "") || null;
    const fid = safeStr(o.franchise_id || "") || null;
    const { results: existOwner } = await env.UPS_MFL_DB
      .prepare("SELECT discord_user_id FROM discord_round_owners WHERE round_id = ? AND discord_user_id = ?")
      .bind(roundId, did).all();
    if (existOwner?.[0]) {
      await env.UPS_MFL_DB.prepare(`
        UPDATE discord_round_owners SET display_name = COALESCE(?, display_name), franchise_id = COALESCE(?, franchise_id)
        WHERE round_id = ? AND discord_user_id = ?
      `).bind(dn, fid, roundId, did).run();
    } else {
      await env.UPS_MFL_DB.prepare(`
        INSERT INTO discord_round_owners (round_id, discord_user_id, display_name, franchise_id, state)
        VALUES (?, ?, ?, ?, 'not_started')
      `).bind(roundId, did, dn, fid).run();
    }
  }

  return jsonOut(200, {
    ok: true,
    round_id: roundId,
    proposals: proposalIds.length,
    owners: owners.length,
  }, corsHeaders);
}

// ---------- Route: POST /admin/hall/test-summary ----------
// Body: { proposal_id, outcome?: "passed"|"rejected", yes?: int, no?: int, abstain?: int, round_title?: string }
// Outcome defaults to "passed". Tally defaults to 9-2-1.
// Fires the announcement+thread+impact-analysis flow without touching round state.
async function adminTestSummary(request, env, corsHeaders) {
  const auth = checkAdmin(request, env);
  if (!auth.ok) return jsonOut(403, { ok: false, error: auth.reason }, corsHeaders);
  let body;
  try { body = await request.json(); } catch (_) { return jsonOut(400, { ok: false, error: "invalid_json" }, corsHeaders); }
  const proposalId = safeStr(body?.proposal_id || "");
  if (!proposalId) return jsonOut(400, { ok: false, error: "proposal_id_required" }, corsHeaders);

  const result = await fireTestSummary(env, {
    proposalId,
    finalOutcome: safeStr(body?.outcome || "passed"),
    finalYes: parseInt(body?.yes, 10),
    finalNo: parseInt(body?.no, 10),
    finalAbstain: parseInt(body?.abstain, 10),
    roundTitle: safeStr(body?.round_title || "May 2026 round (test fire)"),
  });
  if (!result.ok) return jsonOut(500, { ok: false, error: result.error }, corsHeaders);
  return jsonOut(200, { ok: true, message_id: result.message_id, thread_id: result.thread_id }, corsHeaders);
}

// ---------- Public dispatcher ----------
export async function handleHallRequest(request, env, corsHeaders) {
  const url = new URL(request.url);
  const path = url.pathname || "/";
  if (!path.startsWith("/api/hall/") && !path.startsWith("/admin/hall/")) return null;
  if (!env.UPS_MFL_DB) return jsonOut(500, { ok: false, error: "D1 binding UPS_MFL_DB missing" }, corsHeaders);

  // GET /api/hall/proposals
  if (path === "/api/hall/proposals" && request.method === "GET") {
    return await listProposals(request, env, corsHeaders);
  }
  // GET /api/hall/proposals/:id
  let m = path.match(/^\/api\/hall\/proposals\/([a-z0-9][a-z0-9-]*)$/);
  if (m && request.method === "GET") {
    return await getProposal(request, env, corsHeaders, m[1]);
  }
  // POST /api/hall/proposals/:id/respond
  m = path.match(/^\/api\/hall\/proposals\/([a-z0-9][a-z0-9-]*)\/respond$/);
  if (m && request.method === "POST") {
    return await respond(request, env, corsHeaders, m[1]);
  }
  // POST /admin/hall/proposals
  if (path === "/admin/hall/proposals" && request.method === "POST") {
    return await adminUpsertProposal(request, env, corsHeaders);
  }
  // Legacy Phase-1 publish/close routes REMOVED (Keith 2026-07-20) — rule
  // proposals now run entirely through the v2 round system
  // (/admin/rule-proposals/publish + Discord threads/DM cards).
  // GET /admin/hall/proposals/:id/responses
  m = path.match(/^\/admin\/hall\/proposals\/([a-z0-9][a-z0-9-]*)\/responses$/);
  if (m && request.method === "GET") {
    return await adminListResponses(request, env, corsHeaders, m[1]);
  }
  // POST /admin/hall/discord-round/seed
  if (path === "/admin/hall/discord-round/seed" && request.method === "POST") {
    return await adminSeedDiscordRound(request, env, corsHeaders);
  }
  // POST /admin/hall/test-summary — fire a test summary thread to the rules
  // channel for a given proposal_id, with a supplied outcome + tally. Does
  // NOT mutate round state. Used to preview impact-analysis quality without
  // running a full vote round.
  if (path === "/admin/hall/test-summary" && request.method === "POST") {
    return await adminTestSummary(request, env, corsHeaders);
  }
  // POST /admin/hall/discord-round/:round_id/refresh-display — re-render the
  // kickoff anchor + every pinned tally for the round. PATCHes existing
  // messages (no notifications). Idempotent.
  m = path.match(/^\/admin\/hall\/discord-round\/([A-Za-z0-9_-]+)\/refresh-display$/);
  if (m && request.method === "POST") {
    const auth = checkAdmin(request, env);
    if (!auth.ok) return jsonOut(403, { ok: false, error: auth.reason }, corsHeaders);
    const result = await refreshRoundDisplays(env, m[1]);
    return jsonOut(result.ok ? 200 : 404, result, corsHeaders);
  }
  // POST /admin/hall/integrate-rule/:proposal_id — fires the rule-integration
  // workflow for a passed proposal: 5-pass Sonnet research → branch + commit
  // changelog entry → open PR with structured checklist → DM commish.
  // Idempotent: re-running for an already-open PR returns the existing PR
  // without doing anything new. Used for backfill (e.g., today's two passed
  // rules) and as a retry path if the auto-fire on lock fails.
  m = path.match(/^\/admin\/hall\/integrate-rule\/([a-z0-9][a-z0-9-]*)$/);
  if (m && request.method === "POST") {
    const auth = checkAdmin(request, env);
    if (!auth.ok) return jsonOut(403, { ok: false, error: auth.reason }, corsHeaders);
    try {
      const result = await integrateApprovedRule(env, m[1]);
      return jsonOut(result.ok ? 200 : 400, result, corsHeaders);
    } catch (e) {
      return jsonOut(500, { ok: false, error: `integrate_failed: ${e?.message || e}` }, corsHeaders);
    }
  }

  return jsonOut(404, { ok: false, error: "hall_route_not_found", path }, corsHeaders);
}
