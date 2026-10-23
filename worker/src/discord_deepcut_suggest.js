// worker/src/discord_deepcut_suggest.js
// "Suggest a deep cut" button on every UPS Wire deep-cut post (#ups-wire).
//
// Flow:
//   1. Button click ("dc_suggest") -> MODAL with three questions: the player or moment, the season(s), what the owner remembers.
//   2. Modal submit -> validate, cap at 5 per owner per day, INSERT one row into ups_deepcut_suggestions (the review queue),
//      answer the owner privately (ephemeral), and DM the commissioner the suggestion.
//
// The reply is ephemeral and nothing is posted to the channel, so a suggestion never pings or clutters a story's thread.
// Keith reviews the queue: a suggestion that fits an existing category is added there; one that doesn't is considered as a new category.

import { followUpInteraction } from "./discord_roast_reply.js";

const INTERACTION_RESPONSE = { CHANNEL_MESSAGE_WITH_SOURCE: 4, MODAL: 9 };
const COMPONENT_TYPE = { ACTION_ROW: 1, TEXT_INPUT: 4 };
const TEXT_INPUT_STYLE = { SHORT: 1, PARAGRAPH: 2 };
const FLAG_EPHEMERAL = 64;

export const BUTTON_ID = "dc_suggest";
export const MODAL_ID = "dc_suggest_modal";
export const DAILY_LIMIT = 5;

function safeStr(v) { return String(v == null ? "" : v).trim(); }

function jsonResponse(payload) {
  return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
}

function ephemeralReply(content) {
  return jsonResponse({ type: INTERACTION_RESPONSE.CHANNEL_MESSAGE_WITH_SOURCE, data: { content: String(content || "").slice(0, 2000), flags: FLAG_EPHEMERAL } });
}

export function isDeepCutButton(customId) { return safeStr(customId) === BUTTON_ID; }
export function isDeepCutModal(customId) { return safeStr(customId).startsWith(MODAL_ID); }

// The button every deep-cut post carries. Static custom_id, so it can be attached when the post is created.
export const SUGGEST_BUTTON_ROW = {
  type: COMPONENT_TYPE.ACTION_ROW,
  components: [{ type: 2, style: 2, label: "Suggest a deep cut", custom_id: BUTTON_ID }],
};

function textInput(custom_id, label, style, max_length, placeholder, required) {
  return { type: COMPONENT_TYPE.ACTION_ROW, components: [{ type: COMPONENT_TYPE.TEXT_INPUT, custom_id, label, style, min_length: required ? 2 : 0, max_length, placeholder, required }] };
}

export function handleDeepCutButton(interaction) {
  // The post the button was on rides in the modal's custom_id so the submission can name it (ids are < 100 chars).
  const msgId = safeStr(interaction?.message?.id);
  return jsonResponse({
    type: INTERACTION_RESPONSE.MODAL,
    data: {
      custom_id: msgId ? `${MODAL_ID}:${msgId}` : MODAL_ID,
      title: "Suggest a deep cut",
      components: [
        textInput("subject", "The player or moment", TEXT_INPUT_STYLE.SHORT, 100, "A Joique Bell. A Josh Hill. The name or the moment.", true),
        textInput("seasons", "When? (season, even a guess)", TEXT_INPUT_STYLE.SHORT, 100, "2013, or 'early on'", false),
        textInput("details", "What do you remember?", TEXT_INPUT_STYLE.PARAGRAPH, 1000, "Who owned him, what happened, why it stuck with you. The bot looks up the rest.", false),
      ],
    },
  });
}

function extractTextInput(interaction, customId) {
  for (const row of interaction?.data?.components || []) {
    for (const c of row?.components || []) if (c?.custom_id === customId) return safeStr(c?.value);
  }
  return "";
}

export async function handleDeepCutModal(interaction, env, ctx) {
  const customId = safeStr(interaction?.data?.custom_id);
  const sourceMsgId = customId.includes(":") ? customId.split(":")[1] : "";
  const subject = extractTextInput(interaction, "subject").slice(0, 100);
  const seasons = extractTextInput(interaction, "seasons").slice(0, 100);
  const details = extractTextInput(interaction, "details").slice(0, 1000);
  const user = interaction?.member?.user || interaction?.user || {};
  const userId = safeStr(user.id);
  const name = safeStr(interaction?.member?.nick || user.global_name || user.username || "owner");
  if (!subject || !userId) return ephemeralReply("I couldn't read that. Tap Suggest a deep cut and try again.");
  if (!env?.DB) return ephemeralReply("The suggestion box is down right now. Try again later.");

  const now = Math.floor(Date.now() / 1000);
  const used = await env.DB.prepare("SELECT COUNT(*) AS n FROM ups_deepcut_suggestions WHERE discord_user_id = ? AND created_at >= ?")
    .bind(userId, now - 86400).first();
  if (Number(used?.n || 0) >= DAILY_LIMIT) {
    return ephemeralReply(`That's ${DAILY_LIMIT} suggestions in the last day. Come back tomorrow with more.`);
  }
  const ins = await env.DB.prepare(
    "INSERT INTO ups_deepcut_suggestions (created_at, discord_user_id, discord_name, source_message_id, source_channel_id, subject, seasons, details) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  ).bind(now, userId, name, sourceMsgId || null, safeStr(interaction?.channel_id) || null, subject, seasons || null, details || null).run();
  const rowId = ins?.meta?.last_row_id;

  if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(notifyCommish(env, { rowId, name, subject, seasons, details }));
  else await notifyCommish(env, { rowId, name, subject, seasons, details });

  return ephemeralReply(
    `Got it: **${subject}**${seasons ? ` (${seasons})` : ""}. It's in the queue. ` +
    "If it fits a category we already run, it goes there. If it doesn't, we'll weigh a new category and look for others like it."
  );
}

async function notifyCommish(env, s) {
  try {
    const botToken = safeStr(env.DISCORD_BOT_TOKEN);
    const commish = safeStr(env.COMMISH_DISCORD_USER_ID).split(",")[0];
    if (!botToken || !commish) return;
    const ch = await fetch("https://discord.com/api/v10/users/@me/channels", {
      method: "POST", headers: { Authorization: `Bot ${botToken}`, "content-type": "application/json" }, body: JSON.stringify({ recipient_id: commish }),
    }).then((r) => r.json());
    if (!ch?.id) return;
    const body = `Deep cut suggestion #${s.rowId} from ${s.name}: **${s.subject}**${s.seasons ? ` (${s.seasons})` : ""}${s.details ? `\n${s.details}` : ""}`.slice(0, 1900);
    await fetch(`https://discord.com/api/v10/channels/${ch.id}/messages`, {
      method: "POST", headers: { Authorization: `Bot ${botToken}`, "content-type": "application/json" },
      body: JSON.stringify({ content: body, allowed_mentions: { parse: [] } }),
    });
  } catch (e) {
    console.log(`[deepcut-suggest] commish DM failed: ${e && e.message}`);
  }
}
