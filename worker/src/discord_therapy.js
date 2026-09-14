// worker/src/discord_therapy.js
// Discord "/therapy" slash command — the clap-back bot's opposite number.
//
// Keith 2026-09-13, from #on-the-sofa (channel 1291737646665699420, a joke
// "safe and completely serious therapeutic space" where owners vent about bad
// weeks): "add a Therapy Bot similar to our clap back... pull some wins for
// each owner so they can feel good about themselves."
//
// Design constraint that shaped everything below: this bot must NEVER invent
// or imply anything. A clap-back can get away with a sharp guess because the
// room pushes back in the same thread; a "make someone feel good" bot that
// gets a fact wrong, or worse states a real fact in a backhanded way ("only
// one playoff trip in 16 years"), lands as an insult wearing a therapy
// costume. So the positive-fact selection happens in PLAIN CODE
// (buildPositiveFacts below), not the model: every fact handed to the model
// is real, sourced from ups_owner_career_stats (migrations 0058 + 0148,
// already covers all 12 owners), and only ever a genuinely flattering one —
// a losing record or a zero count is simply never added to the list, never
// spun. The model's only job is to phrase what it's given, warmly, and nothing
// else.
//
// positive_receipts_json (migration 0150) is an OPTIONAL, hand-curated
// counterpart to the roast bot's discord_receipts_json — empty by default.
// Keith can add real flattering quotes to a profile in
// pipelines/etl/data/bot/owner_profiles.json ("positive_receipts": [...]),
// same shape as discord_receipts, then re-run sync_owner_ammo_to_d1.py. The
// roast ammo's own discord_receipts/roast_angles/sensitivities are NEVER read
// here — those are curated for roasting and would defeat the point.

import { postToDiscordChannel, followUpInteraction, callAnthropic } from "./discord_roast_reply.js";

const INTERACTION_RESPONSE = {
  CHANNEL_MESSAGE_WITH_SOURCE: 4,
  DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE: 5,
};

const THERAPY_MODEL = "claude-opus-4-8";
const THERAPY_FALLBACK_MODEL = "claude-sonnet-5";

const THERAPY_SYSTEM = `You are the UPS Therapy Bot -- same wiseguy voice as UPS Wire and the trade-roast bot, but today the job is the opposite: make someone feel genuinely good, in public, with real receipts.

You're posting in #on-the-sofa, a joke "therapeutic space" where owners vent about bad weeks. Play the part -- a little theatrical, "you're safe here", couch-and-clipboard energy -- but the content underneath must be completely sincere. This is not a roast wearing a nice hat.

RULES:
- Use ONLY the VERIFIED POSITIVE FACTS block below. Never invent a stat, year, quote or event, and never add context (a total, a "only", a comparison) that isn't itself in the block.
- Never imply a gap, a shortfall or a "could be better" -- if a fact is small, say it plainly and let it stand. No backhanded compliments.
- If a REAL QUOTE is provided, you may use it verbatim (never alter it) if it fits naturally -- otherwise skip it, don't force it.
- If the facts are thin, keep the message short and warm rather than padding with something not given to you. Tenure and camaraderie are real things worth saying.
- Max 80 words. Plain text, no markdown, no bullet points.
- Address them by name. One "session" or "couch" joke is welcome; the rest should read like you mean it.`;

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
    data: { content: String(content || "").slice(0, 2000), flags: 64 },
  });
}

// ── target resolution ───────────────────────────────────────────────────────

function resolveTargetUser(interaction) {
  const invoker = interaction?.member?.user || interaction?.user || {};
  const invokerId = safeStr(invoker?.id);
  const opts = interaction?.data?.options || [];
  const ownerOpt = opts.find((o) => o?.name === "owner");
  const uid = safeStr(ownerOpt?.value);
  if (!uid || uid === invokerId) {
    const name = safeStr(interaction?.member?.nick || invoker?.global_name || invoker?.username || "owner");
    return { id: invokerId, name };
  }
  const resolvedMembers = interaction?.data?.resolved?.members || {};
  const resolvedUsers = interaction?.data?.resolved?.users || {};
  const m = resolvedMembers[uid];
  const u = resolvedUsers[uid] || {};
  const name = safeStr(m?.nick || u?.global_name || u?.username || "owner");
  return { id: uid, name };
}

// ── D1 lookups ───────────────────────────────────────────────────────────────

async function resolveFranchiseId(env, discordUserId) {
  if (!env.UPS_MFL_DB || !discordUserId) return "";
  try {
    const { results } = await env.UPS_MFL_DB
      .prepare("SELECT franchise_id FROM discord_owners WHERE discord_user_id = ? LIMIT 1")
      .bind(String(discordUserId))
      .all();
    return safeStr(results?.[0]?.franchise_id || "").padStart(4, "0");
  } catch (e) {
    console.log(`[therapy] discord_owners lookup failed: ${e?.message || e}`);
    return "";
  }
}

async function loadCareerStats(env, fid) {
  if (!env.UPS_MFL_DB || !fid) return null;
  try {
    const { results } = await env.UPS_MFL_DB
      .prepare(
        "SELECT owner_display, owner_first_season, owner_seasons_count, " +
        "owner_championships, owner_title_years, owner_runner_ups, owner_runner_up_years, " +
        "owner_allplay_titles, owner_allplay_title_years, owner_division_titles, " +
        "owner_playoff_appearances, owner_allplay_pct, owner_overall_w, owner_overall_l " +
        "FROM ups_owner_career_stats WHERE franchise_id = ? LIMIT 1"
      )
      .bind(fid)
      .all();
    return results?.[0] || null;
  } catch (e) {
    console.log(`[therapy] ups_owner_career_stats lookup failed: ${e?.message || e}`);
    return null;
  }
}

async function loadPositiveReceipts(env, fid) {
  if (!env.UPS_MFL_DB || !fid) return [];
  try {
    const { results } = await env.UPS_MFL_DB
      .prepare("SELECT positive_receipts_json FROM ups_roast_owner_ammo WHERE franchise_id = ? LIMIT 1")
      .bind(fid)
      .all();
    const raw = results?.[0]?.positive_receipts_json;
    const arr = JSON.parse(raw || "[]");
    return Array.isArray(arr) ? arr : [];
  } catch (_) {
    return [];
  }
}

// ── positive-fact selection (plain code — see file header) ────────────────

function parseYears(s) {
  try {
    const a = JSON.parse(s || "[]");
    return Array.isArray(a) ? a : [];
  } catch (_) {
    return [];
  }
}

export function buildPositiveFacts(row) {
  if (!row) return [];
  const facts = [];

  const chips = Number(row.owner_championships) || 0;
  if (chips > 0) {
    const years = parseYears(row.owner_title_years);
    facts.push(`${chips} league championship${chips > 1 ? "s" : ""}${years.length ? ` (${years.join(", ")})` : ""}`);
  }

  const apTitles = Number(row.owner_allplay_titles) || 0;
  if (apTitles > 0) {
    const years = parseYears(row.owner_allplay_title_years);
    facts.push(
      `${apTitles}-time regular-season all-play scoring champion${years.length ? ` (${years.join(", ")})` : ""} -- the best-scoring roster in the league that year`
    );
  }

  const divTitles = Number(row.owner_division_titles) || 0;
  if (divTitles > 0) {
    facts.push(`${divTitles} division title${divTitles > 1 ? "s" : ""}`);
  }

  const runnerUps = Number(row.owner_runner_ups) || 0;
  if (runnerUps > 0) {
    const years = parseYears(row.owner_runner_up_years);
    facts.push(`${runnerUps} runner-up finish${runnerUps > 1 ? "es" : ""}${years.length ? ` (${years.join(", ")})` : ""} -- one step from the chip`);
  }

  const playoffs = Number(row.owner_playoff_appearances) || 0;
  if (playoffs > 0) {
    facts.push(`${playoffs} career playoff appearance${playoffs > 1 ? "s" : ""}`);
  }

  const ovW = Number(row.owner_overall_w) || 0;
  const ovL = Number(row.owner_overall_l) || 0;
  if (ovW > ovL && ovW + ovL > 0) {
    facts.push(`a winning head-to-head record, ${ovW}-${ovL}`);
  }

  const apPct = Number(row.owner_allplay_pct) || 0;
  if (apPct > 0.5) {
    facts.push(`a winning all-play record (${(apPct * 100).toFixed(1)}%) -- the scoreboard likes this team`);
  }

  const seasons = Number(row.owner_seasons_count) || 0;
  if (seasons > 0) {
    facts.push(`${seasons} season${seasons > 1 ? "s" : ""} in this league${row.owner_first_season ? `, since ${row.owner_first_season}` : ""}`);
  }

  return facts;
}

// ── slash command entry point ───────────────────────────────────────────────

export async function handleTherapyCommand(interaction, env, ctx) {
  const target = resolveTargetUser(interaction);
  const interactionToken = safeStr(interaction?.token || "");
  const applicationId = safeStr(interaction?.application_id || env.DISCORD_APPLICATION_ID || "");
  const channelId = safeStr(interaction?.channel_id || "");

  if (!target.id) {
    return ephemeralReply("Couldn't tell who this session is for -- try again.");
  }

  const run = () =>
    runTherapyPipelineSafe({ env, target, interactionToken, applicationId, channelId });
  if (ctx && typeof ctx.waitUntil === "function") {
    ctx.waitUntil(run());
  } else {
    await run();
  }

  // Deferred EPHEMERAL ack -- same shape as the roast/wire reply pipelines.
  // The real message posts as a normal bot message via postToDiscordChannel
  // below; a public deferred response would instead leave a stray "UPS
  // Therapy Bot is thinking..." placeholder sitting above it unless the
  // @original message is explicitly edited, which the existing button flows
  // deliberately avoid.
  return jsonResponse({ type: INTERACTION_RESPONSE.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE, data: { flags: 64 } });
}

async function runTherapyPipelineSafe(args) {
  try {
    return await runTherapyPipeline(args);
  } catch (e) {
    const msg = String(e?.stack || e?.message || e).slice(0, 500);
    console.log(`[therapy] PIPELINE CRASH: ${msg}`);
    try {
      await followUpInteraction(args.applicationId, args.interactionToken, {
        content: "⚠️ Therapy session crashed mid-sentence. The commish has been notified.",
        flags: 64,
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
            body: JSON.stringify({ content: `🚨 therapy pipeline crash (target ${args.target?.name}):\n\`\`\`${msg.slice(0, 1500)}\`\`\`` }),
          });
        }
      }
    } catch (_) { /* best effort */ }
  }
}

async function runTherapyPipeline({ env, target, interactionToken, applicationId, channelId }) {
  const botToken = safeStr(env.DISCORD_BOT_TOKEN || env.DISCORD_BOT || "");
  const fid = await resolveFranchiseId(env, target.id);
  if (!fid) {
    await followUpInteraction(applicationId, interactionToken, {
      content: `Couldn't find ${target.name} on a roster -- no session today.`,
      flags: 64,
    });
    return;
  }

  const [row, receipts] = await Promise.all([
    loadCareerStats(env, fid),
    loadPositiveReceipts(env, fid),
  ]);

  const facts = buildPositiveFacts(row);
  const displayName = safeStr(row?.owner_display) || target.name;

  const body = await generateTherapy(env, displayName, facts, receipts.slice(0, 2));

  let posted = false;
  if (channelId && botToken) {
    posted = await postToDiscordChannel(botToken, channelId, {
      content: body.slice(0, 1900),
      allowed_mentions: { parse: [] },
    });
  }
  await followUpInteraction(applicationId, interactionToken, {
    content: posted ? "🛋️ Session posted ✓" : "Couldn't post to the channel -- try again.",
    flags: 64,
  });
}

async function generateTherapy(env, displayName, facts, receipts) {
  const factsBlock = facts.length
    ? facts.map((f) => `- ${f}`).join("\n")
    : "(none on record yet -- lean on tenure/camaraderie only, and keep it short)";
  const receiptsBlock = receipts.length
    ? receipts.map((r) => `- [${safeStr(r.date)}] "${safeStr(r.quote)}"${r.why ? ` -- ${safeStr(r.why)}` : ""}`).join("\n")
    : "(none provided)";
  const userText =
    `Patient: ${displayName}\n\n` +
    `VERIFIED POSITIVE FACTS (the only facts you may use):\n${factsBlock}\n\n` +
    `REAL QUOTES (verbatim, optional, use at most one if it fits):\n${receiptsBlock}\n\n` +
    `Open the session.`;
  for (const model of [THERAPY_MODEL, THERAPY_FALLBACK_MODEL]) {
    try {
      return await callAnthropic(env, { model, maxTokens: 400, system: THERAPY_SYSTEM, userText });
    } catch (e) {
      console.log(`[therapy] generation failed on ${model}: ${e?.message || e}`);
    }
  }
  return `(The couch is full right now. ${displayName}, come back in a bit -- we'll be back.)`;
}
