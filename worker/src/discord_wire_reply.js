// worker/src/discord_wire_reply.js
// Discord Reply-button handler for UPS Wire post challenges.
//
// Mirrors discord_roast_reply.js (the trade-roast bot's "💬 Reply to bot"
// button) for the Wire's own Discord announcements: the announcement carries
// a "💬 Challenge this" button. Clicking it opens a modal; submitting
// classifies the reply and, for anything short of a clean correction, fires
// back a clap-back grounded in the article's own words plus the replier's
// owner dossier -- the same ups_roast_owner_ammo ammunition the roast bot
// already draws from, reused here via the exported helpers in
// discord_roast_reply.js rather than duplicated.
//
// Flow:
//   1. Button click -> respond with MODAL (text input)
//   2. Modal submit -> defer response -> async classify reply (Sonnet)
//      -> if FAIR_POINT/DATA_ERROR, post a one-liner to the thread
//      -> if COPE, generate clap-back (Opus/Sonnet) + post to thread
//   3. Followup the ephemeral with "Reply posted ✓" so the user sees the
//      interaction resolved.
//
// Context source: ups_wire_threads table (worker/migrations/0148_...). A row
// is written per Wire Discord post -- article id/title + the section the
// bot roasted the league with -- so a challenge has something to argue against.

import {
  buildReplierContext,
  postToDiscordChannel,
  followUpInteraction,
  callAnthropic,
} from "./discord_roast_reply.js";

const INTERACTION_RESPONSE = {
  CHANNEL_MESSAGE_WITH_SOURCE: 4,
  DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE: 5,
  MODAL: 9,
};

const COMPONENT_TYPE = {
  ACTION_ROW: 1,
  BUTTON: 2,
  TEXT_INPUT: 4,
};

const TEXT_INPUT_STYLE = {
  SHORT: 1,
  PARAGRAPH: 2,
};

const FLAG_EPHEMERAL = 64;

const CLASSIFY_MODEL = "claude-sonnet-4-6";
export const CLAPBACK_MODEL = "claude-opus-4-8";
export const CLAPBACK_FALLBACK_MODEL = "claude-sonnet-5";

const CLASSIFY_SYSTEM = `Classify this Discord reply to a UPS Wire post (a league newsletter article, which sometimes roasts owners by name) into exactly one category.

Return ONLY valid JSON with these fields:
{"category": "FAIR_POINT" | "DATA_ERROR" | "COPE", "details": "brief explanation", "clap_back_warranted": true | false}

FAIR_POINT: person disagrees with something the Wire wrote, with actual reasoning.
DATA_ERROR: person claims a factual error in the article (a stat, a record, a quote, a ranking).
COPE: person is salty, deflecting, or offering no substance about a roast line that named them. Clap back warranted.`;

const CLAPBACK_SYSTEM = `You are UPS Wire -- the same voice that writes the season forecast and its roast lines. Someone just challenged your post on Discord. Your job: classify the reply and respond.

If they're mad about a roast line that named them, own it -- the line was accurate when you wrote it, so defend it with what's actually true, not by escalating past what you already said.

If they attack the article ("this is trash", "the model is wrong", "you don't know what you're talking about") -- remind them what the piece actually ran on (real season data, not vibes) and that their objection is vibes.

If they assert something FACTUALLY FALSE about the article -- a stat, a quote, a ranking, a record -- correct it ONCE, plainly, in one sentence, with the actual fact, then move on. Do not argue it twice. Do not gloat about the correction. Do not let it slide either.

If they make a GOOD POINT with actual data or logic -- acknowledge it briefly. "Fair point. Logged." Keep it short.

If it's just an emoji, "L", "ratio", or low-effort -- one devastating line.

RULES:
- Max 100 words. Punchy.
- Lead with one of their own DISCORD RECEIPTS where one fits -- verbatim, with its date. That is the sharpest thing in the file.
- AT MOST ONE number in the whole reply, and none at all is fine.
- Never apologize. Never back down unless they have a genuinely good point.
- Plain text only, no markdown.
- FRESHNESS: never reuse a phrase, joke structure, opener or closer from the ARTICLE CONTEXT below verbatim -- riff on it, don't repeat it back to them.
- FAMILY IS OFF LIMITS FOR EVERYONE. NO PERSONAL FAMILY ATTACKS -- a spouse, a child, a parent, any family member of any owner, under any framing, ever. This is absolute. Health is the same rule.
- MATCH THE ROOM. These twelve men are extremely crude with each other. Do not be prissier than the league you cover. Never a slur, never a stereotype -- specific is what hurts, lazy is what gets you heckled.`;

function safeStr(v) {
  return String(v == null ? "" : v).trim();
}

function jsonResponse(payload, status) {
  return new Response(JSON.stringify(payload), {
    status: status || 200,
    headers: { "content-type": "application/json" },
  });
}

function ephemeralReply(content) {
  return jsonResponse({
    type: INTERACTION_RESPONSE.CHANNEL_MESSAGE_WITH_SOURCE,
    data: {
      content: String(content || "").slice(0, 2000),
      flags: FLAG_EPHEMERAL,
    },
  });
}

// ── custom_id helpers ───────────────────────────────────────────────────────

const BUTTON_PREFIX = "wire_reply:";
const MODAL_PREFIX = "wire_reply_modal:";

export function isWireReplyButton(customId) {
  return safeStr(customId).startsWith(BUTTON_PREFIX);
}

export function isWireReplyModal(customId) {
  return safeStr(customId).startsWith(MODAL_PREFIX);
}

function parseWireMsgIdFromButton(customId) {
  const s = safeStr(customId);
  if (!s.startsWith(BUTTON_PREFIX)) return "";
  return s.slice(BUTTON_PREFIX.length).trim();
}

function parseWireMsgIdFromModal(customId) {
  const s = safeStr(customId);
  if (!s.startsWith(MODAL_PREFIX)) return "";
  return s.slice(MODAL_PREFIX.length).trim();
}

// ── D1 lookup ───────────────────────────────────────────────────────────────

async function loadWireThread(env, wireMsgId) {
  if (!env.UPS_MFL_DB || !wireMsgId) return null;
  try {
    const { results } = await env.UPS_MFL_DB
      .prepare(
        "SELECT wire_message_id, article_id, thread_id, channel_id, " +
        "article_title, context_text, posted_at " +
        "FROM ups_wire_threads WHERE wire_message_id = ? LIMIT 1"
      )
      .bind(String(wireMsgId))
      .all();
    return results?.[0] || null;
  } catch (e) {
    console.log(`[wire-reply] D1 lookup failed: ${e?.message || e}`);
    return null;
  }
}

// ── Button click -> return MODAL ────────────────────────────────────────────

export async function handleWireReplyComponent(interaction, env, _ctx) {
  const customId = safeStr(interaction?.data?.custom_id || "");
  const wireMsgId = parseWireMsgIdFromButton(customId);
  if (!wireMsgId) {
    return ephemeralReply("This Challenge button is missing its post id -- bot may have been redeployed.");
  }

  return jsonResponse({
    type: INTERACTION_RESPONSE.MODAL,
    data: {
      custom_id: `${MODAL_PREFIX}${wireMsgId}`,
      title: "💬 Challenge the Wire",
      components: [
        {
          type: COMPONENT_TYPE.ACTION_ROW,
          components: [
            {
              type: COMPONENT_TYPE.TEXT_INPUT,
              custom_id: "reply_text",
              label: "Your take",
              style: TEXT_INPUT_STYLE.PARAGRAPH,
              min_length: 1,
              max_length: 1900,
              placeholder: "Tell the Wire it's wrong. Defend yourself. Whatever.",
              required: true,
            },
          ],
        },
      ],
    },
  });
}

// ── Modal submit -> defer + async clap-back ─────────────────────────────────

function extractTextInput(interaction, customId) {
  const rows = interaction?.data?.components || [];
  for (const row of rows) {
    const comps = row?.components || [];
    for (const c of comps) {
      if (c?.custom_id === customId) return safeStr(c?.value || "");
    }
  }
  return "";
}

async function runReplyPipelineSafe(args) {
  // Same guardrail as the roast bot's runReplyPipelineSafe: every throw in
  // the deferred pipeline used to leave the user staring at "thinking..."
  // forever with zero error surface. Now the interaction ALWAYS resolves,
  // the error is logged, and the commish gets a DM with the message.
  try {
    return await runReplyPipeline(args);
  } catch (e) {
    const msg = String(e?.stack || e?.message || e).slice(0, 500);
    console.log(`[wire-reply] PIPELINE CRASH: ${msg}`);
    try {
      await followUpInteraction(args.applicationId, args.interactionToken, {
        content: "⚠️ My reply pipeline crashed mid-thought. The commish has been notified. (Your text wasn't posted -- try again in a minute.)",
        flags: FLAG_EPHEMERAL,
      });
    } catch (_) { /* interaction may have expired */ }
    try {
      const botToken = safeStr(args.env.DISCORD_BOT_TOKEN || "");
      const commish = safeStr(args.env.COMMISH_DISCORD_USER_ID || "").split(",")[0];
      if (botToken && commish) {
        const ch = await fetch("https://discord.com/api/v10/users/@me/channels", {
          method: "POST",
          headers: { Authorization: `Bot ${botToken}`, "content-type": "application/json" },
          body: JSON.stringify({ recipient_id: commish }),
        }).then((r) => r.json());
        if (ch?.id) {
          await fetch(`https://discord.com/api/v10/channels/${ch.id}/messages`, {
            method: "POST",
            headers: { Authorization: `Bot ${botToken}`, "content-type": "application/json" },
            body: JSON.stringify({ content: `🚨 wire clap-back pipeline crash (replier ${args.replierName}):\n\`\`\`${msg.slice(0, 1500)}\`\`\`` }),
          });
        }
      }
    } catch (_) { /* best effort */ }
  }
}

export async function handleWireReplyModal(interaction, env, ctx) {
  const customId = safeStr(interaction?.data?.custom_id || "");
  const wireMsgId = parseWireMsgIdFromModal(customId);
  const replyText = extractTextInput(interaction, "reply_text").slice(0, 1900);
  const replier = interaction?.member?.user || interaction?.user || {};
  const replierUserId = safeStr(replier?.id);
  const replierName = safeStr(
    interaction?.member?.nick ||
      replier?.global_name ||
      replier?.username ||
      "owner"
  );
  const interactionToken = safeStr(interaction?.token || "");
  const applicationId = safeStr(
    interaction?.application_id || env.DISCORD_APPLICATION_ID || ""
  );

  if (!wireMsgId || !replyText) {
    return ephemeralReply("Couldn't read your reply -- try clicking Challenge again.");
  }

  // Look up the tracked context BEFORE deferring so we can fail fast.
  const tracked = await loadWireThread(env, wireMsgId);
  if (!tracked) {
    return ephemeralReply(
      "This post's tracking expired or was never registered. " +
      "Use Discord's normal Reply on the post instead."
    );
  }

  if (ctx && typeof ctx.waitUntil === "function") {
    ctx.waitUntil(
      runReplyPipelineSafe({
        env,
        tracked,
        replyText,
        replierUserId,
        replierName,
        interactionToken,
        applicationId,
        wireMsgId,
      })
    );
  } else {
    await runReplyPipelineSafe({
      env,
      tracked,
      replyText,
      replierUserId,
      replierName,
      interactionToken,
      applicationId,
      wireMsgId,
    });
  }

  return jsonResponse({
    type: INTERACTION_RESPONSE.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
    data: { flags: FLAG_EPHEMERAL },
  });
}

// ── Async pipeline: echo -> classify -> clap-back -> followup ──────────────

async function runReplyPipeline({
  env,
  tracked,
  replyText,
  replierUserId,
  replierName,
  interactionToken,
  applicationId,
  wireMsgId,
}) {
  const threadId = safeStr(tracked?.thread_id);
  const contextText = safeStr(tracked?.context_text);
  const botToken = safeStr(env.DISCORD_BOT_TOKEN || env.DISCORD_BOT || "");

  const replyButtonComponents = [
    {
      type: COMPONENT_TYPE.ACTION_ROW,
      components: [
        {
          type: COMPONENT_TYPE.BUTTON,
          style: 1, // PRIMARY (blurple)
          label: "💬 Challenge this",
          custom_id: `${BUTTON_PREFIX}${wireMsgId}`,
        },
      ],
    },
  ];

  // 1. Echo the user's reply into the thread so others see it.
  if (threadId && botToken) {
    await postToDiscordChannel(botToken, threadId, {
      content: `**${replierName}** says:\n> ${replyText.slice(0, 1900)}`,
      allowed_mentions: { parse: [] },
    });
  }

  // 2. Classify the reply (Sonnet, JSON-only).
  const classification = await classifyReply(env, replyText, contextText);
  console.log(
    `[wire-reply] classify ` +
    `cat=${classification?.category || "?"} ` +
    `replier=${replierName} (${replierUserId}) ` +
    `wire=${wireMsgId}`
  );

  let postBody = "";
  let postKind = "clapback";
  const cat = safeStr(classification?.category).toUpperCase();
  if (cat === "FAIR_POINT") {
    postBody = "Fair point. Logged.";
    postKind = "fair_point";
  } else if (cat === "DATA_ERROR") {
    postBody = "Fair -- that one's on us. Logged for a look at the source data.";
    postKind = "data_error";
  } else {
    const replier = await buildReplierContext(env, replierUserId);
    postBody = await generateWireClapBack(env, replyText, contextText, replier.text, {
      replierName,
      replierFid: replier.fid,
      articleTitle: safeStr(tracked?.article_title || ""),
    });
  }

  // 3. Post the bot's response to the thread WITH a Challenge button so the
  //    conversation can continue.
  if (threadId && botToken && postBody) {
    await postToDiscordChannel(botToken, threadId, {
      content: postBody.slice(0, 1900),
      allowed_mentions: { parse: [] },
      components: replyButtonComponents,
    });
  }

  // 4. Followup the ephemeral interaction so the modal-submitter sees a ✓.
  if (interactionToken && applicationId) {
    await followUpInteraction(applicationId, interactionToken, {
      content:
        postKind === "clapback"
          ? "Clap-back posted to thread ✓"
          : "Reply logged ✓",
      flags: FLAG_EPHEMERAL,
    });
  }
}

async function classifyReply(env, replyText, contextText) {
  try {
    const out = await callAnthropic(env, {
      model: CLASSIFY_MODEL,
      maxTokens: 256,
      system: CLASSIFY_SYSTEM,
      userText:
        `Wire article context:\n${contextText.slice(0, 1000)}\n\n` +
        `Discord reply:\n${replyText}`,
    });
    try {
      return JSON.parse(out);
    } catch (_) {
      return { category: "COPE", details: "unparseable", clap_back_warranted: true };
    }
  } catch (e) {
    console.log(`[wire-reply] classify failed: ${e?.message || e}`);
    return { category: "COPE", details: `classify_error:${e?.message || ""}`.slice(0, 100), clap_back_warranted: true };
  }
}

export async function generateWireClapBack(env, replyText, contextText, replierContext, ident = {}) {
  const identityBlock =
    `IDENTITY: The person replying is ${safeStr(ident.replierName) || "unknown"}` +
    (ident.replierFid ? ` (franchise ${ident.replierFid})` : "") + `.\n`;
  const userText =
    identityBlock + `\n` +
    `ARTICLE CONTEXT (the Wire post being challenged -- includes any roast lines):\n${contextText.slice(0, 12000)}\n\n` +
    `Replier's franchise history:\n${replierContext}\n\n` +
    `Their reply: "${replyText}"\n\n` +
    `Destroy them.`;
  for (const model of [CLAPBACK_MODEL, CLAPBACK_FALLBACK_MODEL]) {
    try {
      return await callAnthropic(env, {
        model,
        maxTokens: 512,
        system: CLAPBACK_SYSTEM,
        userText,
      });
    } catch (e) {
      console.log(`[wire-reply] clap-back failed on ${model}: ${e?.message || e}`);
    }
  }
  return "(Clap-back service hiccupped. Take the W for now -- we'll be back.)";
}
