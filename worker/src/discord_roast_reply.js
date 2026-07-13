// worker/src/discord_roast_reply.js
// Discord Reply-button handler for the trade-roast bot.
//
// The Python launchd bot posts a 3-message Discord thread per trade
// (announcement → roast → GIF). The roast carries a "💬 Reply to bot"
// button with custom_id `roast_reply:<roast_msg_id>`. Discord routes
// component clicks to the worker's /discord/interactions endpoint
// (because the Discord App has an Interactions Endpoint URL set —
// the Python bot's gateway connection sees a WARNING about this).
//
// Flow:
//   1. Button click → respond with MODAL (text input)
//   2. Modal submit → defer response → async classify reply (Sonnet)
//      → if VALUE_SIGNAL/DATA_ERROR, post one-liner to thread
//      → if COPE, generate clap-back (Sonnet) + post to thread
//   3. Followup the ephemeral with "Reply posted ✓" so the user sees
//      the interaction resolved.
//
// Context source: ups_roast_threads table. The Python bot writes a
// row here after posting each roast (via POST /api/roast-thread/track
// in index.js).

const INTERACTION_RESPONSE = {
  PONG: 1,
  CHANNEL_MESSAGE_WITH_SOURCE: 4,
  DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE: 5,
  DEFERRED_UPDATE_MESSAGE: 6,
  UPDATE_MESSAGE: 7,
  APPLICATION_COMMAND_AUTOCOMPLETE_RESULT: 8,
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
const CLAPBACK_MODEL = "claude-sonnet-5";
const CLAPBACK_FALLBACK_MODEL = "claude-sonnet-4-6";

const CLASSIFY_SYSTEM = `Classify this Discord reply to a fantasy football trade roast into exactly one category.

Return ONLY valid JSON with these fields:
{"category": "VALUE_SIGNAL" | "DATA_ERROR" | "COPE", "details": "brief explanation", "clap_back_warranted": true | false}

VALUE_SIGNAL: Person disagrees with a player's value with reasoning. Extract player + direction.
DATA_ERROR: Person claims a factual error (salary, contract, pick ownership). Extract what's wrong.
COPE: Person is salty, scared, deflecting, or offering no substance. Clap back warranted.`;

const CLAPBACK_SYSTEM = `You are the UPS Trade Analyst bot. Someone just replied to your trade roast on Discord. Your job: classify the reply and respond.

If they show FEAR ("no guarantee at auction", "what if nobody bids", "it's risky") — call them a coward/pussy. Cite their record to show they should be MORE aggressive, not less.

If they show BASELESS CONFIDENCE ("we're winning the chip") — destroy them with their historical record, allplay win rate, and championship drought.

If they attack the analysis ("this is trash", "model is broken") — remind them the model uses 3 years of weekly scoring data, and their opinion is based on vibes and copium.

If they make a GOOD POINT with actual data or logic — acknowledge it briefly. "Fair point. Logged." Keep it short.

If they make a MIXED reply (one valid point + one fear/cope), structure your response in TWO short beats: (1) concede the factual point in one sentence, (2) destroy the fear/cope part. Don't pretend the valid point doesn't exist.

If it's just an emoji, "L", "ratio", or low-effort — one devastating line.

RULES:
- IDENTITY RULE (load-bearing): obey the IDENTITY block in the user message. If the replier was NOT a trade participant, never pin the trade, its grades, or the participants' stats on them — use their own record.
- Max 100 words for the clap back. Punchy.
- Always cite at least one specific number.
- Never apologize. Never back down unless they have a genuinely good point.
- Plain text only, no markdown.

CAP-FIGURE RULE (load-bearing — get this wrong and you embarrass yourself):
- Any cap-space figure in the trade context is POST-TRADE. It is what the owner has LEFT after the trade settled.
- Do NOT argue "you have $X in cap so you should have bid at auction." The trade is what produced that cap state. If they ABSORBED salary, their pre-trade cap was HIGHER. If they SHED salary, their pre-trade cap was LOWER.
- Valid framings: "You used $X of cap going INTO this trade when you could have bid at auction." Or: "Even after this trade you still have $X sitting idle — and you call yourself capped out?" Pick what fits.
- Invalid: implying the post-trade figure is "money you didn't spend at auction." It's the residual AFTER the trade you DID make.

OFFSEASON PPG RULE (load-bearing — same trap, different number):
- Most trades happen in the OFFSEASON. The current season hasn't been played yet. Any PPG (points-per-game) figure of 0.0 — or any current-season scoring figure equal to 0.0 — is DATA SHORTFALL, not a player's actual production.
- DO NOT say "Hurts scored 0.0 PPG this year" or "you paid $X for a ghost" based on 0.0 current-season scoring. That's not a player fact; it's "season hasn't started."
- If you want to argue a player is overpriced, use: prior-season PPG, multi-year average, age, contract length, salary-to-value ratio, or position scarcity — NOT current-year 0.0 figures.`;

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

const BUTTON_PREFIX = "roast_reply:";
const MODAL_PREFIX = "roast_reply_modal:";

export function isRoastReplyButton(customId) {
  return safeStr(customId).startsWith(BUTTON_PREFIX);
}

export function isRoastReplyModal(customId) {
  return safeStr(customId).startsWith(MODAL_PREFIX);
}

function parseRoastMsgIdFromButton(customId) {
  const s = safeStr(customId);
  if (!s.startsWith(BUTTON_PREFIX)) return "";
  return s.slice(BUTTON_PREFIX.length).trim();
}

function parseRoastMsgIdFromModal(customId) {
  const s = safeStr(customId);
  if (!s.startsWith(MODAL_PREFIX)) return "";
  return s.slice(MODAL_PREFIX.length).trim();
}

// ── D1 lookup ───────────────────────────────────────────────────────────────

async function loadRoastThread(env, roastMsgId) {
  if (!env.UPS_MFL_DB || !roastMsgId) return null;
  try {
    const { results } = await env.UPS_MFL_DB
      .prepare(
        "SELECT roast_message_id, trade_id, thread_id, channel_id, " +
        "announcement_message_id, context_text, roast_text, trade_franchises, posted_at " +
        "FROM ups_roast_threads WHERE roast_message_id = ? LIMIT 1"
      )
      .bind(String(roastMsgId))
      .all();
    return results?.[0] || null;
  } catch (e) {
    console.log(`[roast-reply] D1 lookup failed: ${e?.message || e}`);
    return null;
  }
}

// ── Button click → return MODAL ─────────────────────────────────────────────

export async function handleRoastReplyComponent(interaction, env, _ctx) {
  const customId = safeStr(interaction?.data?.custom_id || "");
  const roastMsgId = parseRoastMsgIdFromButton(customId);
  if (!roastMsgId) {
    return ephemeralReply("This Reply button is missing its roast id — bot may have been redeployed.");
  }

  // Optional: verify D1 row exists before opening the modal.
  // Skipping for speed — if the row is missing, the modal submit
  // handler will tell the user the context expired.

  // Discord modal — single paragraph input.
  return jsonResponse({
    type: INTERACTION_RESPONSE.MODAL,
    data: {
      custom_id: `${MODAL_PREFIX}${roastMsgId}`,
      title: "💬 Reply to the bot",
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
              placeholder: "Defend your team. Call out a stat. Vent. Whatever.",
              required: true,
            },
          ],
        },
      ],
    },
  });
}

// ── Modal submit → defer + async clap-back ──────────────────────────────────

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
  // GUARDRAIL (2026-07-13): every throw in the deferred pipeline used to leave
  // the user staring at "thinking..." forever with zero error surface (the
  // identity-patch ReferenceError did exactly this). Now: the interaction ALWAYS
  // resolves, the error is logged, and the commish gets a DM with the message.
  try {
    return await runReplyPipeline(args);
  } catch (e) {
    const msg = String(e?.stack || e?.message || e).slice(0, 500);
    console.log(`[roast-reply] PIPELINE CRASH: ${msg}`);
    try {
      await followUpInteraction(args.applicationId, args.interactionToken, {
        content: "⚠️ My reply pipeline crashed mid-thought. The commish has been notified. (Your text wasn't posted — try again in a minute.)",
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
            body: JSON.stringify({ content: `🚨 clap-back pipeline crash (replier ${args.replierName}):\n\`\`\`${msg.slice(0, 1500)}\`\`\`` }),
          });
        }
      }
    } catch (_) { /* best effort */ }
  }
}

export async function handleRoastReplyModal(interaction, env, ctx) {
  const customId = safeStr(interaction?.data?.custom_id || "");
  const roastMsgId = parseRoastMsgIdFromModal(customId);
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

  if (!roastMsgId || !replyText) {
    return ephemeralReply("Couldn't read your reply — try clicking Reply again.");
  }

  // Look up the tracked context BEFORE deferring so we can fail fast.
  const tracked = await loadRoastThread(env, roastMsgId);
  if (!tracked) {
    return ephemeralReply(
      "This roast's tracking expired (older than 30 days or never registered). " +
      "Use Discord's normal Reply on the roast message instead."
    );
  }

  // ── Defer with an ephemeral ack so Discord doesn't timeout (3s budget).
  //     Worker keeps async work alive via ctx.waitUntil; this lets us call
  //     Anthropic + Discord without holding the connection.
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
        roastMsgId,
      })
    );
  } else {
    // No ctx available — run inline (slower but still completes).
    await runReplyPipelineSafe({
      env,
      tracked,
      replyText,
      replierUserId,
      replierName,
      interactionToken,
      applicationId,
      roastMsgId,
    });
  }

  return jsonResponse({
    type: INTERACTION_RESPONSE.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
    data: { flags: FLAG_EPHEMERAL },
  });
}

// ── Async pipeline: echo → classify → clap-back → followup ──────────────────

async function runReplyPipeline({
  env,
  tracked,
  replyText,
  replierUserId,
  replierName,
  interactionToken,
  applicationId,
  roastMsgId,
}) {
  const threadId = safeStr(tracked?.thread_id);
  const contextText = safeStr(tracked?.context_text);
  const botToken = safeStr(env.DISCORD_BOT_TOKEN || env.DISCORD_BOT || "");

  // Reply-button payload — same custom_id encodes the ORIGINAL roast id,
  // so clicks on any bot response thread back to the same trade context.
  // Discord MESSAGE_COMPONENT for a button-only message:
  //   components: [ { type: 1 (ActionRow), components: [ { type: 2, ... } ] } ]
  const replyButtonComponents = [
    {
      type: COMPONENT_TYPE.ACTION_ROW,
      components: [
        {
          type: COMPONENT_TYPE.BUTTON,
          style: 1, // PRIMARY (blurple)
          label: "💬 Reply to bot",
          custom_id: `${BUTTON_PREFIX}${roastMsgId}`,
        },
      ],
    },
  ];

  // 1. Echo the user's reply into the thread so others see it.
  //    (No button on the echo — it's the user's own words relayed.)
  if (threadId && botToken) {
    await postToDiscordChannel(botToken, threadId, {
      content:
        `**${replierName}** says:\n> ${replyText.slice(0, 1900)}`,
      allowed_mentions: { parse: [] },
    });
  }

  // 2. Classify the reply (Sonnet, JSON-only).
  const classification = await classifyReply(env, replyText, contextText);
  console.log(
    `[roast-reply] classify ` +
    `cat=${classification?.category || "?"} ` +
    `replier=${replierName} (${replierUserId}) ` +
    `roast=${roastMsgId}`
  );

  let postBody = "";
  let postKind = "clapback";
  const cat = safeStr(classification?.category).toUpperCase();
  if (cat === "VALUE_SIGNAL") {
    postBody = "Interesting take. Logged for model review.";
    postKind = "value_signal";
  } else if (cat === "DATA_ERROR") {
    postBody = "Noted. We'll verify against the source data.";
    postKind = "data_error";
  } else {
    // 3a. COPE → generate clap-back (Sonnet).
    const replier = await buildReplierContext(env, replierUserId);
    postBody = await generateClapBack(env, replyText, contextText, replier.text, {
      replierName,
      replierFid: replier.fid,
      tradeFranchises: safeStr(tracked?.trade_franchises || ""),
    });
  }

  // 4. Post the bot's response to the thread WITH a Reply button so the
  //    conversation can continue (Keith 2026-05-23: "add reply back button
  //    to every response"). Button reuses the same custom_id (encodes the
  //    original roast id) so D1 lookup hits the same trade context.
  if (threadId && botToken && postBody) {
    await postToDiscordChannel(botToken, threadId, {
      content: postBody.slice(0, 1900),
      allowed_mentions: { parse: [] },
      components: replyButtonComponents,
    });
  }

  // 5. Followup the ephemeral interaction so the modal-submitter sees a ✓.
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

// ── Replier context (owner career stats) ────────────────────────────────────

async function buildReplierContext(env, replierUserId) {
  // Lookup the replier's franchise via discord_owners (D1).
  if (!env.UPS_MFL_DB || !replierUserId) return { text: "", fid: "" };
  let fid = "";
  try {
    const { results } = await env.UPS_MFL_DB
      .prepare(
        "SELECT franchise_id FROM discord_owners " +
        "WHERE discord_user_id = ? LIMIT 1"
      )
      .bind(String(replierUserId))
      .all();
    fid = safeStr(results?.[0]?.franchise_id || "").padStart(4, "0");
  } catch (e) {
    console.log(`[roast-reply] discord_owners lookup failed: ${e?.message || e}`);
  }
  if (!fid) return { text: "", fid: "" };

  // Pull OWNER-attribution career stats from ups_owner_career_stats — this
  // table is the D1 mirror of pipelines/etl/data/franchise_career_stats.json,
  // populated by rebuild_franchise_career_stats.py. Owner stats are cross-
  // franchise + override-aware, so Keith's row shows his actual 0-rings
  // career (not franchise 0008's 2010 chip from Tom Roussin). Keith
  // 2026-05-23: "still messing up the history" — root cause was the worker
  // querying franchise-keyed src_final_standings directly; that table
  // can't distinguish Roussin's 2010 chip from Keith's career.
  let row = null;
  try {
    const { results } = await env.UPS_MFL_DB
      .prepare(
        "SELECT owner_display, franchise_name, current_year, " +
        " owner_first_season, owner_seasons_count, owner_franchises_owned, " +
        " owner_championships, owner_last_championship, " +
        " owner_playoff_appearances, owner_best_finish, owner_worst_finish, " +
        " owner_allplay_w, owner_allplay_l, owner_allplay_pct, " +
        " owner_overall_w, owner_overall_l, " +
        " franchise_championships, franchise_last_championship, " +
        " franchise_championship_drought " +
        "FROM ups_owner_career_stats WHERE franchise_id = ? LIMIT 1"
      )
      .bind(fid)
      .all();
    row = results?.[0] || null;
  } catch (e) {
    console.log(`[roast-reply] ups_owner_career_stats lookup failed: ${e?.message || e}`);
  }
  if (!row) {
    // Fallback: minimal context so the clap-back still has the franchise id
    // even if the career-stats row hasn't been populated yet.
    return `Replier: franchise ${fid} (career stats row missing — fallback context)`;
  }

  const display = safeStr(row.owner_display) || "the owner";
  const teamName = safeStr(row.franchise_name);
  const seasons = Number(row.owner_seasons_count) || 0;
  const firstSeason = row.owner_first_season;
  const fids = (() => {
    try { return JSON.parse(row.owner_franchises_owned || "[]"); }
    catch (_) { return []; }
  })();
  const ownerChips = Number(row.owner_championships) || 0;
  const ownerLastChip = row.owner_last_championship;
  const playoffs = Number(row.owner_playoff_appearances) || 0;
  const bestFinish = row.owner_best_finish;
  const worstFinish = row.owner_worst_finish;
  const apW = Number(row.owner_allplay_w) || 0;
  const apL = Number(row.owner_allplay_l) || 0;
  const apPct = Number(row.owner_allplay_pct) || 0;
  const ovW = Number(row.owner_overall_w) || 0;
  const ovL = Number(row.owner_overall_l) || 0;
  const franchiseChips = Number(row.franchise_championships) || 0;
  const franchiseLastChip = row.franchise_last_championship;
  const franchiseDrought = row.franchise_championship_drought;

  const ownerRingLine = ownerChips
    ? `Owner championships: ${ownerChips} (last in ${ownerLastChip})`
    : `Owner championships: 0 (NEVER won as owner of record)`;

  // Distinguish franchise-history note from owner-attribution. Many lines
  // here look redundant but they're load-bearing for clap-back accuracy.
  const franchiseRingLine = franchiseChips
    ? `Franchise history (any owner): ${franchiseChips} ring(s)${franchiseLastChip ? ` — last in ${franchiseLastChip}` : ""}${franchiseDrought ? `, drought ${franchiseDrought} yrs` : ""}. NOTE: chips before this owner's tenure_start belong to a PREVIOUS owner — do NOT credit them to ${display}.`
    : `Franchise history (any owner): 0 rings ever.`;

  const fidsLine = fids.length > 1
    ? `Owner held multiple franchises: ${fids.join(", ")} (current is ${fid})`
    : "";

  const lines = [
    `Replier: ${display} (current franchise ${fid}${teamName ? ` — ${teamName}` : ""})`,
    fidsLine,
    `Owner tenure: ${seasons} COMPLETED season(s)${firstSeason ? ` since ${firstSeason}` : ""}`,
    `Owner allplay: ${apW}-${apL} (${apPct.toFixed(3)})`,
    `Owner overall (head-to-head): ${ovW}-${ovL}`,
    ownerRingLine,
    `Owner playoff appearances: ${playoffs}`,
    bestFinish ? `Best finish under this owner: #${bestFinish}` : "",
    worstFinish ? `Worst finish under this owner: #${worstFinish}` : "",
    franchiseRingLine,
  ].filter(Boolean);
  return { text: lines.join("\n"), fid };
}

// ── Anthropic helpers ───────────────────────────────────────────────────────

async function callAnthropic(env, { model, maxTokens, system, userText }) {
  const apiKey = safeStr(env.ANTHROPIC_API_KEY || "");
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY not configured");
  }
  // One retry on transient failures (429/5xx/529/network). The 2026-07-12
  // "clap-back service hiccupped" faceplant in #transactions was a single
  // unretried transient error — RyBo got a free W.
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 900));
    let res, text;
    try {
      res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model,
          max_tokens: maxTokens,
          system,
          messages: [{ role: "user", content: userText }],
        }),
      });
      text = await res.text();
    } catch (e) {
      lastErr = new Error(`anthropic network: ${String(e?.message || e).slice(0, 200)}`);
      continue;
    }
    if (!res.ok) {
      lastErr = new Error(`anthropic ${res.status}: ${text.slice(0, 300)}`);
      if ([408, 429, 500, 502, 503, 529].includes(res.status)) continue;
      throw lastErr; // non-transient (401/400/404) — retrying won't help
    }
    let data;
    try { data = JSON.parse(text); } catch (_) { throw new Error("anthropic non-json"); }
    return (data?.content || [])
      .filter((b) => b?.type === "text")
      .map((b) => String(b.text || ""))
      .join("\n")
      .trim();
  }
  throw lastErr || new Error("anthropic: retries exhausted");
}

async function classifyReply(env, replyText, contextText) {
  try {
    const out = await callAnthropic(env, {
      model: CLASSIFY_MODEL,
      maxTokens: 256,
      system: CLASSIFY_SYSTEM,
      userText:
        `Original trade roast context:\n${contextText.slice(0, 1000)}\n\n` +
        `Discord reply:\n${replyText}`,
    });
    try {
      return JSON.parse(out);
    } catch (_) {
      return { category: "COPE", details: "unparseable", clap_back_warranted: true };
    }
  } catch (e) {
    console.log(`[roast-reply] classify failed: ${e?.message || e}`);
    return { category: "COPE", details: `classify_error:${e?.message || ""}`.slice(0, 100), clap_back_warranted: true };
  }
}

export async function generateClapBack(env, replyText, contextText, replierContext, ident = {}) {
  // IDENTITY GROUNDING (2026-07-12: the bot ascribed Blake's trade + allplay to
  // RyBo, who wasn't in the trade — "You've got the wrong guy"). State exactly
  // who is replying and whether they were a trade participant, as a hard rule.
  const fids = safeStr(ident.tradeFranchises || "").split(",").map((x) => x.trim()).filter(Boolean);
  const isParticipant = ident.replierFid && fids.includes(ident.replierFid);
  const identityBlock =
    `IDENTITY (LOAD-BEARING — get this wrong and you embarrass yourself again):\n` +
    `The person replying is ${safeStr(ident.replierName) || "unknown"}` +
    (ident.replierFid ? ` (franchise ${ident.replierFid})` : "") + `.\n` +
    (isParticipant
      ? `They WERE a participant in this trade — their side's numbers apply to them.\n`
      : `They were NOT part of this trade (participants: ${fids.join(", ") || "unknown"}). ` +
        `Do NOT attribute the trade, its cost, its grades, or the participants' records ` +
        `(allplay, cap space, value deltas) to them. Roast them using ONLY the ` +
        `"Replier's franchise history" section and any CLAP-BACK AMMUNITION orders that name them.\n`);
  // 12KB, not 2KB: the tracked context carries a "CLAP-BACK AMMUNITION" section
  // APPENDED to the trade context (per-member verified facts + standing orders,
  // e.g. the Keith-built-you counter). The old 2000-char slice cut it off
  // entirely, so button replies never saw the ammo.
  const userText =
    identityBlock + `\n` +
    `Original trade analysis context (may include a CLAP-BACK AMMUNITION section — obey it):\n${contextText.slice(0, 12000)}\n\n` +
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
      console.log(`[roast-reply] clap-back failed on ${model}: ${e?.message || e}`);
    }
  }
  return "(Clap-back service hiccupped. Take the W for now — we'll be back.)";
}

// ── Discord helpers ─────────────────────────────────────────────────────────

async function postToDiscordChannel(botToken, channelId, body) {
  try {
    const res = await fetch(
      `https://discord.com/api/v10/channels/${encodeURIComponent(channelId)}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bot ${botToken}`,
          "Content-Type": "application/json",
          "User-Agent": "ups-roast-bot-worker (https://upsmflproduction.keith-creelman.workers.dev)",
        },
        body: JSON.stringify(body),
      }
    );
    if (!res.ok) {
      const text = await res.text();
      console.log(`[roast-reply] discord post ${res.status}: ${text.slice(0, 300)}`);
    }
    return res.ok;
  } catch (e) {
    console.log(`[roast-reply] discord post error: ${e?.message || e}`);
    return false;
  }
}

async function followUpInteraction(applicationId, interactionToken, body) {
  try {
    const res = await fetch(
      `https://discord.com/api/v10/webhooks/${encodeURIComponent(applicationId)}/${encodeURIComponent(interactionToken)}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "ups-roast-bot-worker",
        },
        body: JSON.stringify(body),
      }
    );
    return res.ok;
  } catch (e) {
    console.log(`[roast-reply] followup error: ${e?.message || e}`);
    return false;
  }
}
