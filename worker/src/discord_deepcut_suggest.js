// worker/src/discord_deepcut_suggest.js
// "Suggest a deep cut" button on every UPS Wire deep-cut post (#ups-wire).
//
// Flow:
//   1. Button click ("dc_suggest") -> MODAL with three questions: the player or moment, the season(s), what the owner remembers.
//   2. Modal submit -> validate, cap at 5 per owner per day, INSERT one row into ups_deepcut_suggestions (the review queue),
//      answer the owner privately (ephemeral) with a few things worth remembering, and DM the commissioner the suggestion.
//   3. The reply carries an "Add more details" button ("dc_more:<id>"). It opens a second modal of canned prompts (a player set or
//      an event set, picked from what the owner wrote). Each answer is appended to the row; up to 3 rounds. Only the owner who
//      made the suggestion can add to it.
//
// The reply is ephemeral and nothing is posted to the channel, so a suggestion never pings or clutters a story's thread.
// Keith reviews the queue: a suggestion that fits an existing category is added there; one that doesn't is considered as a new category.

import { followUpInteraction } from "./discord_roast_reply.js";

const INTERACTION_RESPONSE = { CHANNEL_MESSAGE_WITH_SOURCE: 4, MODAL: 9 };
const COMPONENT_TYPE = { ACTION_ROW: 1, TEXT_INPUT: 4 };
const TEXT_INPUT_STYLE = { SHORT: 1, PARAGRAPH: 2 };
const FLAG_EPHEMERAL = 64;
export const MORE_BUTTON_PREFIX = "dc_more:";
export const MORE_MODAL_PREFIX = "dc_more_modal:";
export const MAX_ROUNDS = 3;
const MAX_DETAILS = 4000;

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
export function isDeepCutModal(customId) { return safeStr(customId).startsWith(MODAL_ID) && !safeStr(customId).startsWith(MORE_MODAL_PREFIX); }
export function isDeepCutMoreButton(customId) { return safeStr(customId).startsWith(MORE_BUTTON_PREFIX); }
export function isDeepCutMoreModal(customId) { return safeStr(customId).startsWith(MORE_MODAL_PREFIX); }

// Canned prompts. A player set and an event set (a ruling, a vote, a dispute, a rule change), picked from what the owner wrote.
const EVENT_WORDS = /\b(collusion|vote|voted|ruling|ruled|rule|rules|removed|expel|expelled|quit|dispersal|fiasco|argument|dispute|scandal|deadline|lockout)\b/i;
export const PLAYER_PROMPTS = [
  ["owners", "Who owned him?", "Which teams, in what order?"],
  ["moves", "Trades, drops, bids or prices", "Anything you remember about how he moved, and what it cost."],
  ["moment", "The biggest game or moment", "The week, the score, the play."],
  ["aftermath", "What happened next?", "Where did he end up, and how did it end?"],
  ["other", "Anything else?", "Reactions, arguments, where it was written down."],
];
export const EVENT_PROMPTS = [
  ["who", "Who was involved?", "Owners, commissioner, anyone who weighed in."],
  ["lead", "What led up to it?", "The trigger, in your own words."],
  ["outcome", "What was decided or what changed?", "The result, and what came after."],
  ["where", "Where might it be written down?", "Email thread, Discord, forum, MFL board, a rulebook."],
  ["care", "Anything sensitive?", "Anything we should handle carefully or check with someone first."],
];
export function promptSet(text) { return EVENT_WORDS.test(String(text || "")) ? EVENT_PROMPTS : PLAYER_PROMPTS; }

const SCHEMA_READY = new WeakSet();   // per D1 binding, so a warm isolate checks once
async function ensureSchema(env) {
  if (!env?.UPS_MFL_DB || SCHEMA_READY.has(env.UPS_MFL_DB)) return;
  const stmts = [
    "CREATE TABLE IF NOT EXISTS ups_deepcut_suggestions (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at INTEGER NOT NULL, discord_user_id TEXT NOT NULL, discord_name TEXT, source_message_id TEXT, source_channel_id TEXT, subject TEXT NOT NULL, seasons TEXT, details TEXT, status TEXT NOT NULL DEFAULT 'new', category TEXT, reviewer_notes TEXT, rounds INTEGER NOT NULL DEFAULT 0)",
    "CREATE INDEX IF NOT EXISTS idx_deepcut_suggestions_user ON ups_deepcut_suggestions (discord_user_id, created_at)",
    "CREATE INDEX IF NOT EXISTS idx_deepcut_suggestions_status ON ups_deepcut_suggestions (status, created_at)",
  ];
  for (const sql of stmts) await env.UPS_MFL_DB.prepare(sql).run();
  SCHEMA_READY.add(env.UPS_MFL_DB);
}

function moreRow(id) {
  return { type: COMPONENT_TYPE.ACTION_ROW, components: [{ type: 2, style: 1, label: "Add more details", custom_id: `${MORE_BUTTON_PREFIX}${id}` }] };
}
function remember(set) { return set.slice(0, 3).map((p) => `• ${p[1]}`).join("\n"); }

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
  if (!env?.UPS_MFL_DB) return ephemeralReply("The suggestion box is down right now. Try again later.");
  await ensureSchema(env);

  const now = Math.floor(Date.now() / 1000);
  const used = await env.UPS_MFL_DB.prepare("SELECT COUNT(*) AS n FROM ups_deepcut_suggestions WHERE discord_user_id = ? AND created_at >= ?")
    .bind(userId, now - 86400).first();
  if (Number(used?.n || 0) >= DAILY_LIMIT) {
    return ephemeralReply(`That's ${DAILY_LIMIT} suggestions in the last day. Come back tomorrow with more.`);
  }
  const ins = await env.UPS_MFL_DB.prepare(
    "INSERT INTO ups_deepcut_suggestions (created_at, discord_user_id, discord_name, source_message_id, source_channel_id, subject, seasons, details) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  ).bind(now, userId, name, sourceMsgId || null, safeStr(interaction?.channel_id) || null, subject, seasons || null, details || null).run();
  const rowId = ins?.meta?.last_row_id;

  if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(notifyCommish(env, { rowId, name, subject, seasons, details }));
  else await notifyCommish(env, { rowId, name, subject, seasons, details });

  const set = promptSet(`${subject} ${details}`);
  return jsonResponse({
    type: INTERACTION_RESPONSE.CHANNEL_MESSAGE_WITH_SOURCE,
    data: {
      flags: FLAG_EPHEMERAL,
      content: `Got it: **${subject}**${seasons ? ` (${seasons})` : ""}. It's in the queue.\n\n` +
        `The more you can give us, the better the story. Things worth remembering:\n${remember(set)}\n\n` +
        "Tap **Add more details** and I'll walk you through a few more questions. If it fits a category we already run, it goes there. If it doesn't, we'll weigh a new category and look for others like it.",
      components: [moreRow(rowId)],
    },
  });
}

async function loadOwned(env, id, userId) {
  const row = await env.UPS_MFL_DB.prepare("SELECT id, discord_user_id, subject, details, rounds FROM ups_deepcut_suggestions WHERE id = ?").bind(Number(id)).first();
  return row && row.discord_user_id === userId ? row : null;
}
function userOf(interaction) {
  const user = interaction?.member?.user || interaction?.user || {};
  return { id: safeStr(user.id), name: safeStr(interaction?.member?.nick || user.global_name || user.username || "owner") };
}

export async function handleDeepCutMoreButton(interaction, env) {
  const id = safeStr(interaction?.data?.custom_id).slice(MORE_BUTTON_PREFIX.length);
  const u = userOf(interaction);
  if (!env?.UPS_MFL_DB || !id || !u.id) return ephemeralReply("The suggestion box is down right now. Try again later.");
  await ensureSchema(env);
  const row = await loadOwned(env, id, u.id);
  if (!row) return ephemeralReply("I can't find that suggestion. Tap Suggest a deep cut to start a new one.");
  if (Number(row.rounds) >= MAX_ROUNDS) return ephemeralReply("That's all the follow-up rounds for this one. It's with the commissioner now.");
  const set = promptSet(`${row.subject} ${row.details}`);
  return jsonResponse({
    type: INTERACTION_RESPONSE.MODAL,
    data: {
      custom_id: `${MORE_MODAL_PREFIX}${row.id}`,
      title: String(row.subject).slice(0, 45),
      components: set.map(([key, label, ph]) => textInput(key, label, TEXT_INPUT_STYLE.PARAGRAPH, 800, ph, false)),
    },
  });
}

export async function handleDeepCutMoreModal(interaction, env, ctx) {
  const id = safeStr(interaction?.data?.custom_id).slice(MORE_MODAL_PREFIX.length);
  const u = userOf(interaction);
  if (!env?.UPS_MFL_DB || !id || !u.id) return ephemeralReply("The suggestion box is down right now. Try again later.");
  await ensureSchema(env);
  const row = await loadOwned(env, id, u.id);
  if (!row) return ephemeralReply("I can't find that suggestion. Tap Suggest a deep cut to start a new one.");
  if (Number(row.rounds) >= MAX_ROUNDS) return ephemeralReply("That's all the follow-up rounds for this one. It's with the commissioner now.");
  const set = promptSet(`${row.subject} ${row.details}`);
  const lines = [];
  for (const [key, label] of set) {
    const v = extractTextInput(interaction, key).slice(0, 800);
    if (v) lines.push(`${label} ${v}`);
  }
  if (!lines.length) return ephemeralReply("You didn't add anything that time. Tap Add more details when you're ready.");
  const add = `\n\n[Round ${Number(row.rounds) + 1}]\n${lines.join("\n")}`;
  const merged = `${row.details || ""}${add}`.slice(0, MAX_DETAILS);
  await env.UPS_MFL_DB.prepare("UPDATE ups_deepcut_suggestions SET details = ?, rounds = rounds + 1 WHERE id = ?").bind(merged, row.id).run();
  const roundsLeft = MAX_ROUNDS - (Number(row.rounds) + 1);
  const note = { rowId: row.id, name: u.name, subject: `${row.subject} (more details)`, seasons: "", details: lines.join("\n") };
  if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(notifyCommish(env, note)); else await notifyCommish(env, note);
  return jsonResponse({
    type: INTERACTION_RESPONSE.CHANNEL_MESSAGE_WITH_SOURCE,
    data: {
      flags: FLAG_EPHEMERAL,
      content: roundsLeft > 0 ? "Added. Anything else you remember, tap Add more details again." : "Added. That's everything I can take on this one. It's with the commissioner now.",
      components: roundsLeft > 0 ? [moreRow(row.id)] : [],
    },
  });
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
