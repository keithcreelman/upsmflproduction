// worker/src/discord_bot.js
// UPS League Hall — Discord interaction edge.
//
// Responsibilities:
//   1. Verify Ed25519 signature on every POST to /discord/interactions
//   2. Reply to Discord PING with PONG (dev-portal "Save URL" handshake)
//   3. Dispatch APPLICATION_COMMAND / MESSAGE_COMPONENT / MODAL_SUBMIT to
//      worker/src/discord_round.js (the round state machine).
//
// All round/vote/state logic lives in discord_round.js — this file is just
// signature verification + dispatch.

import { runHallSubcommand, handleComponentInteraction, handleModalInteraction } from "./discord_round.js";
import {
  isRoastReplyButton,
  isRoastReplyModal,
  handleRoastReplyComponent,
  handleRoastReplyModal,
} from "./discord_roast_reply.js";
import { handleTradeThinkButton } from "./trade_dm.js";
import { handle3WayButton } from "./trade_3way.js";

const INTERACTION_TYPE = {
  PING: 1,
  APPLICATION_COMMAND: 2,
  MESSAGE_COMPONENT: 3,
  APPLICATION_COMMAND_AUTOCOMPLETE: 4,
  MODAL_SUBMIT: 5,
};

const RESPONSE_TYPE = {
  PONG: 1,
  CHANNEL_MESSAGE_WITH_SOURCE: 4,
};

const FLAG_EPHEMERAL = 64;

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
    type: RESPONSE_TYPE.CHANNEL_MESSAGE_WITH_SOURCE,
    data: { content: String(content || "").slice(0, 2000), flags: FLAG_EPHEMERAL },
  });
}

function hexToBytes(hex) {
  const clean = String(hex || "").replace(/[^0-9a-fA-F]/g, "");
  if (clean.length % 2 !== 0) return new Uint8Array(0);
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
  return out;
}

async function verifySignature(rawBody, signatureHex, timestamp, publicKeyHex) {
  if (!signatureHex || !timestamp || !publicKeyHex) return false;
  try {
    const publicKey = hexToBytes(publicKeyHex);
    const signature = hexToBytes(signatureHex);
    if (publicKey.length !== 32 || signature.length !== 64) return false;
    const message = new TextEncoder().encode(timestamp + rawBody);
    const cryptoKey = await crypto.subtle.importKey(
      "raw",
      publicKey,
      { name: "Ed25519" },
      false,
      ["verify"]
    );
    return await crypto.subtle.verify("Ed25519", cryptoKey, signature, message);
  } catch (e) {
    console.log(`[discord-sig] EXCEPTION: ${e && e.message}`);
    return false;
  }
}

async function countOpenRounds(env) {
  if (!env.UPS_MFL_DB) return null;
  try {
    const { results } = await env.UPS_MFL_DB
      .prepare("SELECT COUNT(*) AS n FROM discord_rounds WHERE status = 'open'")
      .all();
    return Number(results?.[0]?.n || 0);
  } catch (_) {
    return null;
  }
}

async function handlePing(interaction, env) {
  const openRounds = await countOpenRounds(env);
  const userId = safeStr(interaction?.member?.user?.id || interaction?.user?.id || "");
  const lines = [
    "🏓 pong from **UPS Hall** — bot wiring is live.",
    `· Discord interaction received and signature-verified ✓`,
    `· D1 reachable: ${openRounds == null ? "❌ no" : "✓ yes"}`,
    `· Open rounds: ${openRounds == null ? "?" : openRounds}`,
    `· Caller Discord ID: ${userId || "(unknown)"}`,
  ];
  return ephemeralReply(lines.join("\n"));
}

async function dispatchApplicationCommand(interaction, env, ctx) {
  const cmdName = safeStr(interaction?.data?.name).toLowerCase();
  // Accept both /rules (new) and /hall (legacy alias during transition).
  if (cmdName !== "rules" && cmdName !== "hall") {
    return ephemeralReply(`Unknown command \`${cmdName}\`.`);
  }
  const subRoot = interaction?.data?.options?.[0];
  const subName = safeStr(subRoot?.name).toLowerCase();
  if (subName === "ping") return await handlePing(interaction, env);
  const handled = await runHallSubcommand(interaction, env, ctx);
  if (handled) return handled;
  return ephemeralReply(`Subcommand \`${subName || "(none)"}\` not recognized.`);
}

export async function handleDiscordInteraction(request, env, ctx) {
  // ctx comes from the Workers fetch handler. Used to keep async work alive
  // (e.g. Claude API calls + Discord webhook follow-up) after we return a
  // deferred interaction response.
  const url = new URL(request.url);
  const path = url.pathname || "/";
  if (path !== "/discord/interactions") return null;
  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const publicKey = safeStr(env.DISCORD_PUBLIC_KEY || "");
  if (!publicKey) {
    return new Response("DISCORD_PUBLIC_KEY worker secret not configured", { status: 500 });
  }

  const signatureHex = safeStr(request.headers.get("X-Signature-Ed25519") || "");
  const timestamp = safeStr(request.headers.get("X-Signature-Timestamp") || "");
  const rawBody = await request.text();

  const valid = await verifySignature(rawBody, signatureHex, timestamp, publicKey);
  if (!valid) {
    return new Response("invalid request signature", { status: 401 });
  }

  let interaction;
  try {
    interaction = JSON.parse(rawBody);
  } catch (_) {
    return new Response("invalid json", { status: 400 });
  }

  const type = Number(interaction?.type || 0);

  if (type === INTERACTION_TYPE.PING) {
    return jsonResponse({ type: RESPONSE_TYPE.PONG });
  }
  if (type === INTERACTION_TYPE.APPLICATION_COMMAND) {
    try {
      return await dispatchApplicationCommand(interaction, env, ctx);
    } catch (e) {
      console.log(`[hall-cmd] EXCEPTION: ${e && e.message} ${e && e.stack}`);
      return ephemeralReply(`Command failed: ${e && e.message ? e.message : "unknown error"}`);
    }
  }
  if (type === INTERACTION_TYPE.MESSAGE_COMPONENT) {
    const customId = safeStr(interaction?.data?.custom_id || "");
    // Route roast-bot reply buttons to their own handler (worker-side
    // because the Discord App's Interactions Endpoint URL bypasses
    // the launchd Python bot's gateway).
    if (isRoastReplyButton(customId)) {
      try {
        return await handleRoastReplyComponent(interaction, env, ctx);
      } catch (e) {
        console.log(`[roast-btn] EXCEPTION: ${e && e.message} ${e && e.stack}`);
        return ephemeralReply(`Reply button failed: ${e && e.message ? e.message : "unknown error"}`);
      }
    }
    // 3-way trade buttons ("tr3:accept|decline:<id>") — checked before "tr:".
    if (customId.startsWith("tr3:")) {
      try {
        return await handle3WayButton(interaction, env, ctx);
      } catch (e) {
        console.log(`[3way-btn] EXCEPTION: ${e && e.message} ${e && e.stack}`);
        return ephemeralReply(`3-way trade button failed: ${e && e.message ? e.message : "unknown error"}`);
      }
    }
    // Trade-offer DM buttons ("tr:think:<tradeId>"). Checked before the Hall
    // fallthrough; the "tr:" prefix can't collide with Hall's strict "t:" check.
    if (customId.startsWith("tr:")) {
      try {
        return await handleTradeThinkButton(interaction, env, ctx);
      } catch (e) {
        console.log(`[trade-btn] EXCEPTION: ${e && e.message} ${e && e.stack}`);
        return ephemeralReply(`Trade button failed: ${e && e.message ? e.message : "unknown error"}`);
      }
    }
    try {
      return await handleComponentInteraction(interaction, env, ctx);
    } catch (e) {
      console.log(`[hall-btn] EXCEPTION: ${e && e.message} ${e && e.stack}`);
      return ephemeralReply(`Button failed: ${e && e.message ? e.message : "unknown error"}`);
    }
  }
  if (type === INTERACTION_TYPE.MODAL_SUBMIT) {
    const customId = safeStr(interaction?.data?.custom_id || "");
    if (isRoastReplyModal(customId)) {
      try {
        return await handleRoastReplyModal(interaction, env, ctx);
      } catch (e) {
        console.log(`[roast-modal] EXCEPTION: ${e && e.message} ${e && e.stack}`);
        return ephemeralReply(`Reply modal failed: ${e && e.message ? e.message : "unknown error"}`);
      }
    }
    try {
      return await handleModalInteraction(interaction, env, ctx);
    } catch (e) {
      console.log(`[hall-modal] EXCEPTION: ${e && e.message} ${e && e.stack}`);
      return ephemeralReply(`Modal failed: ${e && e.message ? e.message : "unknown error"}`);
    }
  }

  return jsonResponse({
    type: RESPONSE_TYPE.CHANNEL_MESSAGE_WITH_SOURCE,
    data: { content: "Unhandled interaction type.", flags: FLAG_EPHEMERAL },
  });
}
