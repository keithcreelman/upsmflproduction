// discord_rule_proposal.js — Rule Proposals v2: the interactive layer on top
// of the Hall Gen-2 voting engine (discord_round.js).
//
// What lives here and why it's separate:
//   - buildDmVoteCard    — the per-owner DM with Approve/Decline/Discuss.
//                          Approve/Decline carry the EXISTING `t:vote` customIds,
//                          so the whole vote pipeline (reason modal → castVote →
//                          thread voter-line → tally pin → threshold) is reused
//                          verbatim with zero new vote code. Only Discuss is new.
//   - rp:* interactions  — the Discuss → classify/answer → Surface loop. This is
//                          the genuinely new machinery: a member talks to the bot
//                          privately, the bot answers (grounded on the rulebook +
//                          this proposal's prior Q&A + commish rulings), and the
//                          member ALWAYS holds the "📢 Surface to league" button —
//                          "no matter what the owner can always surface up to the
//                          league" (Keith, 2026-07-15). Nothing goes public unless
//                          the member clicks it; Keith sees everything in the tab
//                          regardless.
//   - commishVerdictOverride — "always trust my voice as the determining factor
//                          unless there's a clear vote." Refuses to override an
//                          auto-pass that already locked (the clear vote stands);
//                          anything else closes with close_reason='commish_ruling'.
//   - fetchQaGrounding   — the learning loop: recent Q&A + all rulings for a
//                          proposal, fed back into every explain/synthesis call.
import {
  openDmChannel, sendDm, postChannelMessage,
  formatDeadlineUtc, threadDeepLink, closeRoundInternal,
} from "./discord_round.js";
import { callDiscussSynthesis } from "./anthropic_explain.js";
import { getFeatureFlag } from "./feature_flags.js";

const safeStr = (v) => String(v == null ? "" : v).trim();
const nowIso = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

// Discord API constants (local copies — these are protocol numbers, not
// app state; duplicating three enums beats exporting discord_round internals).
const RESPONSE_TYPE = { MESSAGE: 4, UPDATE_MESSAGE: 7, MODAL: 9 };
const COMPONENT_TYPE = { ACTION_ROW: 1, BUTTON: 2, TEXT_INPUT: 4 };
const BUTTON_STYLE = { PRIMARY: 1, SECONDARY: 2, SUCCESS: 3, DANGER: 4, LINK: 5 };
const TEXT_INPUT_STYLE = { PARAGRAPH: 2 };
const EPHEMERAL = 64;

// Interaction handlers in this codebase return real Response objects (the
// dispatcher in discord_bot.js passes them straight through) — not plain
// payloads. Every return below goes through jsonResponse.
const jsonResponse = (payload) => new Response(JSON.stringify(payload), {
  status: 200, headers: { "content-type": "application/json" },
});
const ephemeral = (content) => jsonResponse({
  type: RESPONSE_TYPE.MESSAGE,
  data: { content: String(content).slice(0, 1990), flags: EPHEMERAL },
});
const getCallerId = (i) => safeStr(i?.member?.user?.id || i?.user?.id || "");
const getCallerName = (i) => safeStr(
  i?.member?.user?.global_name || i?.member?.user?.username ||
  i?.user?.global_name || i?.user?.username || ""
);
const modalTextValue = (interaction, customId) => {
  for (const row of interaction?.data?.components || []) {
    for (const comp of row.components || []) {
      if (comp.custom_id === customId) return safeStr(comp.value || "");
    }
  }
  return "";
};

// ── The DM vote card ────────────────────────────────────────────────────
// Approve/Decline reuse `t:vote:...` — clicking them in the DM opens the same
// optional-reason modal and lands in castVote, which posts the voter line into
// the PUBLIC thread (castVote resolves the thread from D1, not the interaction)
// and refreshes the tally. One vote store, no sync problem, by construction.
export function buildDmVoteCard(round, item, guildId) {
  const link = guildId && item.discord_thread_id
    ? threadDeepLink(guildId, item.discord_thread_id) : "";
  const deadline = formatDeadlineUtc(round.voting_deadline_utc);
  const L = [];
  L.push(`🏛 **RULE PROPOSAL — ${safeStr(item.title)}**`);
  if (safeStr(item.tldr)) { L.push(""); L.push(safeStr(item.tldr)); }
  L.push("");
  if (deadline) L.push(`**Voting deadline:** ${deadline}`);
  L.push(`**Passes at:** ${Number(item.pass_yes_count || 7)} YES votes`);
  L.push("");
  L.push(`**Approve/Decline records your official vote** — same vote as the thread buttons, and your name + any reason you give appears there. **Discuss** is private: ask me anything or raise a concern, and only you decide if it goes to the league.`);
  if (link) { L.push(""); L.push(`📄 Full rule text, rationale + data, and discussion are in the thread — tap **For more details** below.`); }
  // Vote/Discuss buttons, plus a Link button to the full proposal thread when
  // we have a deep link (guild + thread stamped). Link buttons carry a `url`
  // and NO custom_id; up to 5 buttons fit in one action row.
  const row = [
    { type: COMPONENT_TYPE.BUTTON, style: BUTTON_STYLE.SUCCESS, label: "✅ Approve", custom_id: `t:vote:${round.round_id}:${item.proposal_id}:yes` },
    { type: COMPONENT_TYPE.BUTTON, style: BUTTON_STYLE.DANGER, label: "❌ Decline", custom_id: `t:vote:${round.round_id}:${item.proposal_id}:no` },
    { type: COMPONENT_TYPE.BUTTON, style: BUTTON_STYLE.PRIMARY, label: "💬 Discuss", custom_id: `rp:discuss:${round.round_id}:${item.proposal_id}` },
  ];
  if (link) row.push({ type: COMPONENT_TYPE.BUTTON, style: BUTTON_STYLE.LINK, label: "📄 For more details", url: link });
  return {
    content: L.join("\n").slice(0, 1990),
    components: [{ type: COMPONENT_TYPE.ACTION_ROW, components: row }],
  };
}

// ── Learning-loop grounding ─────────────────────────────────────────────
// Recent Q&A (capped) + EVERY ruling (never capped — the commish's voice is
// the point). Returned as a text block for the prompt suffix; empty string
// when the proposal has no history yet.
export async function fetchQaGrounding(env, proposalId) {
  const db = env.UPS_MFL_DB;
  if (!db) return "";
  try {
    const { results: rulings } = await db.prepare(
      `SELECT keith_ruling, created_at_utc FROM hall_qa_log
        WHERE proposal_id = ? AND kind IN ('keith_ruling','commish_verdict')
          AND keith_ruling IS NOT NULL
        ORDER BY created_at_utc ASC`
    ).bind(proposalId).all();
    const { results: qa } = await db.prepare(
      `SELECT kind, question_text, bot_answer FROM hall_qa_log
        WHERE proposal_id = ? AND kind IN ('question','concern','feedback')
        ORDER BY created_at_utc DESC LIMIT 12`
    ).bind(proposalId).all();
    const L = [];
    for (const r of rulings || []) {
      L.push(`[COMMISH RULING — AUTHORITATIVE] ${safeStr(r.keith_ruling)}`);
    }
    for (const row of (qa || []).reverse()) {
      if (safeStr(row.question_text)) L.push(`[owner ${row.kind}] ${safeStr(row.question_text).slice(0, 400)}`);
      if (safeStr(row.bot_answer)) L.push(`[bot answer] ${safeStr(row.bot_answer).slice(0, 400)}`);
    }
    return L.join("\n\n");
  } catch (e) {
    console.log(`[rp] fetchQaGrounding failed: ${e?.message || e}`);
    return "";
  }
}

// Round+item lookup by ids (mirrors discord_round's internal helpers — kept
// local so this module needs no extra exports).
async function loadRoundItem(env, roundId, proposalId) {
  const db = env.UPS_MFL_DB;
  const { results: rounds } = await db.prepare(
    `SELECT * FROM discord_rounds WHERE round_id = ?`
  ).bind(roundId).all();
  const round = rounds?.[0] || null;
  if (!round) return { round: null, item: null };
  const { results: items } = await db.prepare(
    `SELECT ri.*, p.title, p.tldr, p.body_md, p.rationale_md, p.type, p.pass_yes_count, p.discussion_only
       FROM discord_round_items ri JOIN hall_proposals p ON p.id = ri.proposal_id
      WHERE ri.round_id = ? AND ri.proposal_id = ?`
  ).bind(roundId, proposalId).all();
  return { round, item: items?.[0] || null };
}

// ── rp:* component interactions ─────────────────────────────────────────
export async function handleRuleProposalComponent(interaction, env, ctx) {
  const customId = safeStr(interaction?.data?.custom_id);
  const parts = customId.split(":");
  const action = parts[1] || "";

  if (!(await getFeatureFlag(env, "RULE_PROPOSALS_ENABLED"))) {
    return ephemeral("Rule proposals are currently disabled.");
  }

  // rp:discuss:<roundId>:<proposalId> → private discuss modal
  if (action === "discuss") {
    const [, , roundId, proposalId] = parts;
    return jsonResponse({
      type: RESPONSE_TYPE.MODAL,
      data: {
        custom_id: `rp:discuss_modal:${roundId}:${proposalId}`,
        title: "Discuss — just between us",
        components: [{
          type: COMPONENT_TYPE.ACTION_ROW,
          components: [{
            type: COMPONENT_TYPE.TEXT_INPUT,
            custom_id: "txt",
            label: "Question, concern, or thought",
            style: TEXT_INPUT_STYLE.PARAGRAPH,
            required: true,
            min_length: 3,
            max_length: 1500,
            placeholder: "Ask me anything about this rule, or tell me what worries you. Private unless YOU surface it.",
          }],
        }],
      },
    });
  }

  // rp:surface:<qaId> → the member publishes their own concern to the league.
  if (action === "surface") {
    const qaId = Number(parts[2] || 0);
    const db = env.UPS_MFL_DB;
    const row = await db.prepare(`SELECT * FROM hall_qa_log WHERE qa_id = ?`).bind(qaId).first();
    if (!row) return ephemeral("Couldn't find that discussion to surface.");
    const callerId = getCallerId(interaction);
    // Only the author surfaces their own words.
    if (safeStr(row.discord_user_id) && safeStr(row.discord_user_id) !== callerId) {
      return ephemeral("Only the person who raised this can surface it.");
    }
    if (Number(row.surfaced) === 1) {
      return ephemeral("Already surfaced to the league — check the proposal thread.");
    }
    const { round, item } = await loadRoundItem(env, safeStr(row.round_id), safeStr(row.proposal_id));
    if (!round || !item || !item.discord_thread_id) {
      return ephemeral("The proposal thread is missing — tell the commish.");
    }

    const kindWord = row.kind === "question" ? "question" : row.kind === "feedback" ? "feedback" : "concern";
    const L = [];
    L.push(`📢 **${kindWord === "concern" ? "Concern" : kindWord === "question" ? "Question" : "Feedback"} raised by <@${callerId}>:**`);
    L.push(`> ${safeStr(row.question_text).replace(/\n/g, "\n> ").slice(0, 900)}`);
    if (safeStr(row.bot_answer)) {
      L.push("");
      L.push(`🤖 **Bot's take:** ${safeStr(row.bot_answer).slice(0, 700)}`);
    }
    L.push("");
    L.push(`<@${callerId}> — add any context we missed, right here in the thread.`);
    // LOUD on purpose, with a real @mention: the default parse:[] would
    // swallow the ping and the member would never see their own invitation.
    const pr = await postChannelMessage(env, item.discord_thread_id, {
      content: L.join("\n").slice(0, 1990),
      allowed_mentions: { users: [callerId] },
    }, { silent: false });
    if (!pr.ok) return ephemeral("Couldn't post to the thread — try again in a minute.");

    await db.prepare(
      `UPDATE hall_qa_log SET surfaced = 1, surfaced_at_utc = ?, surface_message_id = ? WHERE qa_id = ?`
    ).bind(nowIso(), safeStr(pr.data?.id || ""), qaId).run();

    // Swap the button on the bot's DM message for a disabled "Surfaced ✓".
    const oldRows = interaction?.message?.components || [];
    const disabled = oldRows.map((r) => ({
      ...r,
      components: (r.components || []).map((c) => ({
        ...c, disabled: true,
        label: String(c.custom_id || "").startsWith("rp:surface:") ? "📢 Surfaced ✓" : c.label,
      })),
    }));
    return jsonResponse({ type: RESPONSE_TYPE.UPDATE_MESSAGE, data: { components: disabled } });
  }

  return ephemeral("Unknown action.");
}

// ── rp:discuss_modal submit — the synthesize/answer/offer loop ──────────
export async function handleRuleProposalModal(interaction, env, ctx) {
  const customId = safeStr(interaction?.data?.custom_id);
  const parts = customId.split(":");
  if (parts[1] !== "discuss_modal") return ephemeral("Unknown modal.");
  const [, , roundId, proposalId] = parts;
  const text = modalTextValue(interaction, "txt");
  if (!text) return ephemeral("Type something first.");
  const callerId = getCallerId(interaction);
  const callerName = getCallerName(interaction);
  // In a DM interaction, channel_id IS the DM channel — reuse it and skip an
  // openDmChannel round-trip; fall back to opening one (thread-origin clicks).
  const dmChannelHint = safeStr(interaction?.channel_id || "");

  const work = async () => {
    const db = env.UPS_MFL_DB;
    const { round, item } = await loadRoundItem(env, roundId, proposalId);
    if (!round || !item) return;

    const aiOn = await getFeatureFlag(env, "RULE_PROPOSALS_AI_ENABLED");
    let category = "valid_concern";
    let reply = "";
    let classification = null;
    if (aiOn) {
      const grounding = await fetchQaGrounding(env, proposalId);
      const syn = await callDiscussSynthesis(env, {
        proposalTitle: item.title,
        proposalBody: item.body_md,
        rationale: item.rationale_md,
        memberText: text,
        extraContext: grounding,
      });
      category = syn.category || "valid_concern";
      reply = safeStr(syn.reply);
      classification = syn.classification_json || (syn.error ? JSON.stringify({ error: syn.error }) : null);
    } else {
      reply = "_(bot synthesis is offline — logged for the commish, and you can still surface this to the league as-is)_";
      classification = JSON.stringify({ ai_disabled: true });
    }

    const kind = category === "answerable_question" ? "question"
               : category === "feedback" ? "feedback" : "concern";
    const ins = await db.prepare(
      `INSERT INTO hall_qa_log
         (proposal_id, round_id, discord_user_id, display_name, kind,
          question_text, bot_answer, classification_json, source, created_at_utc)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'dm_discuss', ?)`
    ).bind(proposalId, roundId, callerId, callerName || null, kind,
      text, reply || null, classification, nowIso()).run();
    const qaId = Number(ins?.meta?.last_row_id || 0);

    const L = [];
    if (kind === "question") {
      L.push(`🤖 ${reply}`);
      L.push("");
      L.push(`_Answered privately. If you think the league should see this Q&A, surface it below — that's always your call._`);
    } else if (kind === "concern") {
      L.push(`🤖 **That reads like a real concern.** Here's how I'd frame it for the league:`);
      L.push("");
      L.push(reply);
      L.push("");
      L.push(`_Nothing has been shared. Hit the button to put it in front of the league (you'll be @'d to add context), or leave it here — the commish sees it either way._`);
    } else {
      L.push(`🤖 ${reply}`);
      L.push("");
      L.push(`_Logged. Want the league to see it? That's your button below._`);
    }
    const payload = {
      content: L.join("\n").slice(0, 1990),
      components: qaId ? [{
        type: COMPONENT_TYPE.ACTION_ROW,
        components: [
          { type: COMPONENT_TYPE.BUTTON, style: BUTTON_STYLE.PRIMARY, label: "📢 Surface to league", custom_id: `rp:surface:${qaId}` },
        ],
      }] : [],
    };
    const cid = dmChannelHint || await openDmChannel(env, callerId);
    if (cid) await sendDm(env, cid, payload);
  };

  if (ctx && typeof ctx.waitUntil === "function") {
    ctx.waitUntil(work().catch((e) => console.log(`[rp] discuss err: ${e?.message || e}`)));
  } else {
    work().catch(() => {});
  }
  return ephemeral("🤖 On it — my reply lands here in a few seconds.");
}

// ── Commish verdict override ────────────────────────────────────────────
// "So if someone bitches about something and i say this is the way it is
// then so be it" — with his own carve-out: a clear vote stands. If the item
// already auto-passed at threshold and the 5-min lock has elapsed, refuse.
export async function commishVerdictOverride(env, { proposalId, outcome, reason, who }) {
  const db = env.UPS_MFL_DB;
  if (!db) return { ok: false, error: "no_db" };
  const want = safeStr(outcome).toLowerCase();
  if (!["passed", "rejected"].includes(want)) {
    return { ok: false, error: "outcome must be 'passed' or 'rejected'" };
  }
  if (!safeStr(reason)) return { ok: false, error: "a reason is required — it's posted to the league" };

  // Newest open round containing this proposal.
  const { results } = await db.prepare(
    `SELECT ri.*, r.round_id AS r_round_id, r.status AS round_status, r.test_only,
            p.title, p.pass_yes_count
       FROM discord_round_items ri
       JOIN discord_rounds r ON r.round_id = ri.round_id
       JOIN hall_proposals p ON p.id = ri.proposal_id
      WHERE ri.proposal_id = ? AND r.status = 'open'
      ORDER BY r.started_at_utc DESC LIMIT 1`
  ).bind(proposalId).all();
  const item = results?.[0];
  if (!item) return { ok: false, error: "no open round holds this proposal" };

  // The clear-vote guard.
  const lockedAt = safeStr(item.votes_locked_at_utc);
  const clearVote = item.final_outcome === "passed"
    && Number(item.final_yes || 0) >= Number(item.pass_yes_count || 7)
    && lockedAt && new Date(lockedAt).getTime() <= Date.now();
  if (clearVote) {
    return { ok: false, error: `clear vote stands: PASSED ${item.final_yes} YES (threshold ${item.pass_yes_count}) and locked — the override doesn't apply to a clear vote` };
  }

  // Live tally from active responses.
  const { results: tally } = await db.prepare(
    `SELECT value, COUNT(*) AS n FROM discord_responses
      WHERE round_id = ? AND proposal_id = ? AND superseded_at_utc IS NULL
      GROUP BY value`
  ).bind(item.round_id, proposalId).all();
  const count = (v) => Number((tally || []).find((t) => t.value === v)?.n || 0);
  const ts = nowIso();

  await db.prepare(
    `UPDATE discord_round_items
        SET final_outcome = ?, final_yes = ?, final_no = ?, final_abstain = ?,
            threshold_reached_at_utc = COALESCE(threshold_reached_at_utc, ?),
            votes_locked_at_utc = ?,
            closed_at_utc = ?, close_reason = 'commish_ruling'
      WHERE round_id = ? AND proposal_id = ?`
  ).bind(want, count("yes"), count("no"), count("abstain"), ts, ts, ts, item.round_id, proposalId).run();

  await db.prepare(
    `INSERT INTO hall_qa_log
       (proposal_id, round_id, discord_user_id, display_name, kind,
        keith_ruling, source, created_at_utc)
     VALUES (?, ?, NULL, ?, 'commish_verdict', ?, 'tab', ?)`
  ).bind(proposalId, item.round_id, safeStr(who) || "commish",
    `VERDICT: ${want.toUpperCase()} — ${safeStr(reason)}`, ts).run();

  // Tell the thread, in the commish's voice, before the machinery announces.
  if (item.discord_thread_id) {
    await postChannelMessage(env, item.discord_thread_id, {
      content: `⚖️ **Commish ruling:** this proposal is **${want.toUpperCase()}**.\n> ${safeStr(reason).slice(0, 1500)}`,
    }, { silent: false }).catch(() => {});
  }

  // closeRoundInternal disables buttons, freezes the tally, and forces the
  // summary sweep — which produces the standard announcement (suffixed
  // "(commish ruling)" via close_reason).
  const { results: rounds } = await db.prepare(`SELECT * FROM discord_rounds WHERE round_id = ?`).bind(item.round_id).all();
  const round = rounds?.[0];
  if (round) await closeRoundInternal(env, round, { reason: "commish_ruling" });

  return { ok: true, proposal_id: proposalId, round_id: item.round_id, outcome: want, yes: count("yes"), no: count("no"), abstain: count("abstain") };
}
