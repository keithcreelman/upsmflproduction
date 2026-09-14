// worker/src/discord_therapy.js
// Discord "/therapy" slash command — the clap-back bot's opposite number.
//
// Keith 2026-09-13, from #on-the-sofa (channel 1291737646665699420, a joke
// "safe and completely serious therapeutic space" where owners vent about bad
// weeks): "add a Therapy Bot similar to our clap back... pull some wins for
// each owner so they can feel good about themselves."
//
// v1 shipped as /therapy [owner: user mention] with no free-text input.
// Keith's first real attempt to use it typed a whole vent ("I'm sad, I'm
// going to drop a 240 burger...") into the `owner` field, which is a
// Discord USER-mention picker and can't take prose — and separately flagged
// that @-mentioning another owner inside a vent would wrongly make the
// session ABOUT that owner. Both point at the same fix: this needs to work
// like the roast bot's "Reply to bot" button (click -> MODAL -> paragraph
// text box -> submit), always about the person who ran the command, with
// whatever they typed handed to the model as context rather than parsed as
// a target. Naming someone else in the vent is just prose -- the model may
// riff on what was SAID about them, never assert a new fact about them.
//
// Design constraint that shaped everything else below: this bot must NEVER
// invent or imply anything. A clap-back can get away with a sharp guess
// because the room pushes back in the same thread; a "make someone feel
// good" bot that gets a fact wrong, or worse states a real fact in a
// backhanded way ("only one playoff trip in 16 years"), lands as an insult
// wearing a therapy costume. So the positive-fact selection happens in
// PLAIN CODE (buildPositiveFacts below), not the model: every fact handed to
// the model is real, sourced from ups_owner_career_stats (migrations 0058 +
// 0148, already covers all 12 owners), and only ever a genuinely flattering
// one — a losing record or a zero count is simply never added to the list,
// never spun. The model's only job is to respond to what the patient said
// and phrase the real facts warmly, nothing else.
//
// positive_receipts_json (migration 0150) is an OPTIONAL, hand-curated
// counterpart to the roast bot's discord_receipts_json — empty by default.
// Keith can add real flattering quotes to a profile in
// pipelines/etl/data/bot/owner_profiles.json ("positive_receipts": [...]),
// same shape as discord_receipts, then re-run sync_owner_ammo_to_d1.py. The
// roast ammo's own discord_receipts/roast_angles/sensitivities are NEVER read
// here — those are curated for roasting and would defeat the point.
//
// VARIETY (Keith 2026-09-14: "I just don't want this to get stale"). Two
// mechanisms, both real-data-only:
//   1. The positive-facts list is shuffled before it reaches the model, so
//      repeated sessions don't always lead with the same fact in the same
//      order (buildPositiveFacts itself stays untouched -- still the only
//      thing deciding WHAT counts as a fact).
//   2. An optional "rival bad beat" from ups_bad_beats (migration 0151, a D1
//      mirror of wire_data.bench_burns() -- see sync_bad_beats_to_d1.py): if
//      the vent names another owner/team by a recognizable token of their
//      franchise name, pull a real bench-vs-start story for THAT franchise;
//      otherwise pull a random one from someone else about half the time.
//      Framing is verdict-gated same as the Wire itself -- "process" (a real
//      misplay) is fair to needle, "variance" (bad luck) is not.

import { postToDiscordChannel, followUpInteraction, callAnthropic } from "./discord_roast_reply.js";

const INTERACTION_RESPONSE = {
  CHANNEL_MESSAGE_WITH_SOURCE: 4,
  DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE: 5,
  MODAL: 9,
};

const COMPONENT_TYPE = { ACTION_ROW: 1, TEXT_INPUT: 4 };
const TEXT_INPUT_STYLE = { PARAGRAPH: 2 };
const FLAG_EPHEMERAL = 64;

const THERAPY_MODEL = "claude-opus-4-8";
const THERAPY_FALLBACK_MODEL = "claude-sonnet-5";

const THERAPY_SYSTEM = `You are the UPS Therapy Bot -- same wiseguy voice as UPS Wire and the trade-roast bot, but today the job is the opposite: make someone feel genuinely good, in public, with real receipts.

You're posting in #on-the-sofa, a joke "therapeutic space" where owners vent about bad weeks. Play the part -- a little theatrical, "you're safe here", couch-and-clipboard energy -- but the content underneath must be completely sincere. This is not a roast wearing a nice hat.

If the patient typed something (a vent, trash talk, whatever's bothering them), open by responding to it directly and specifically -- show you actually read it -- before or while working in the reassurance. If they name another owner or team in their vent, you may riff on what THEY said about that person, but never assert a new fact about that other person that wasn't in what the patient wrote -- UNLESS the OPTIONAL RIVAL BAD BEAT block below gives you a real one.

RULES:
- Facts about the patient: use ONLY the VERIFIED POSITIVE FACTS block below. Never invent a stat, year, quote or event about them, and never add context (a total, a "only", a comparison) that isn't itself in the block.
- Never imply a gap, a shortfall or a "could be better" about the patient -- if a fact is small, say it plainly and let it stand. No backhanded compliments.
- If a REAL QUOTE is provided, you may use it verbatim (never alter it) if it fits naturally -- otherwise skip it, don't force it.
- If the facts are thin, keep the message short and warm rather than padding with something not given to you. Tenure and camaraderie are real things worth saying.
- The OPTIONAL RIVAL BAD BEAT is the one place you may say something unflattering about someone who ISN'T the patient -- real data, one aside, never the point of the session. Respect its verdict: a "process" bad beat is fair to rib as a decision; a "variance" one was bad luck and the owner made the right call, so rib the universe, not them. Skip it entirely if it doesn't fit naturally or none was given.
- If the OPTIONAL TRADE HISTORY block gives you a real trade the patient made that looks bad in hindsight (they gave up a player who went on to thrive elsewhere), that's fair game and often the BEST material: be bluntly sarcastic about the L itself first -- don't soften it -- then pivot to something genuinely true and positive (what they got instead, roster flexibility, anything real in the data), then land it with a twist that turns it back on whoever benefited (a real cost they're now paying for that player -- a contract, a price -- if the data gives you one). Keith's own words for this shape: "shit on me but in a sarcastic fluff me up way." That's the shape, not a script -- write a fresh version every time, never the same joke or phrasing twice.
- The RIVAL BAD BEAT and the TRADE HISTORY are both "one aside about someone/something else" ingredients -- when both are present, pick whichever tells the sharper, more specific story and use only that one. Using both in the same 90 words reads cluttered, not clever.
- Vary yourself. Don't open the same way twice in a row, don't always lead with the same kind of fact or the same structure -- you have several real ingredients each time (the facts, an optional quote, an optional rival aside, an optional trade history); lean on a different mix and a different angle each session so this never reads like a template.
- If the patient predicts or dreads something that HASN'T happened yet (a game still to be played, a matchup still in progress), that's their anxiety talking -- respond to the feeling, never confirm or deny the outcome as if you know it. You don't.
- Max 90 words. Plain text, no markdown, no bullet points.
- Address them by name. One "session" or "couch" joke is welcome; the rest should read like you mean it.
- FAMILY AND HEALTH ARE OFF LIMITS FOR EVERYONE -- the patient and any rival -- same as every other bot in this server.`;

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
    data: { content: String(content || "").slice(0, 2000), flags: FLAG_EPHEMERAL },
  });
}

// ── invoker identity ─────────────────────────────────────────────────────

function resolveInvoker(interaction) {
  const invoker = interaction?.member?.user || interaction?.user || {};
  const name = safeStr(interaction?.member?.nick || invoker?.global_name || invoker?.username || "owner");
  return { id: safeStr(invoker?.id), name };
}

function extractVentText(interaction) {
  const rows = interaction?.data?.components || [];
  for (const row of rows) {
    for (const c of row?.components || []) {
      if (c?.custom_id === "vent_text") return safeStr(c?.value || "");
    }
  }
  return "";
}

// ── D1 lookups ───────────────────────────────────────────────────────────

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
    const arr = JSON.parse(results?.[0]?.positive_receipts_json || "[]");
    return Array.isArray(arr) ? arr : [];
  } catch (_) {
    return [];
  }
}

async function loadAllOwners(env) {
  if (!env.UPS_MFL_DB) return [];
  try {
    const { results } = await env.UPS_MFL_DB
      .prepare("SELECT franchise_id, owner_display, franchise_name FROM ups_owner_career_stats")
      .all();
    return results || [];
  } catch (e) {
    console.log(`[therapy] loadAllOwners failed: ${e?.message || e}`);
    return [];
  }
}

async function loadBadBeat(env, fid) {
  if (!env.UPS_MFL_DB || !fid) return null;
  try {
    const { results } = await env.UPS_MFL_DB
      .prepare("SELECT * FROM ups_bad_beats WHERE franchise_id = ? ORDER BY RANDOM() LIMIT 1")
      .bind(fid)
      .all();
    return results?.[0] || null;
  } catch (e) {
    console.log(`[therapy] loadBadBeat failed: ${e?.message || e}`);
    return null;
  }
}

async function loadRandomBadBeat(env, excludeFid) {
  if (!env.UPS_MFL_DB) return null;
  try {
    const { results } = await env.UPS_MFL_DB
      .prepare("SELECT * FROM ups_bad_beats WHERE franchise_id != ? ORDER BY RANDOM() LIMIT 1")
      .bind(excludeFid || "")
      .all();
    return results?.[0] || null;
  } catch (e) {
    console.log(`[therapy] loadRandomBadBeat failed: ${e?.message || e}`);
    return null;
  }
}

// A trade specifically between the patient and a named rival, if one exists
// -- the McBride/Hammer case this whole ingredient was built for.
async function loadTradeWith(env, fid, otherFid) {
  if (!env.UPS_MFL_DB || !fid || !otherFid) return null;
  try {
    const { results } = await env.UPS_MFL_DB
      .prepare(
        "SELECT * FROM ups_trade_outcomes WHERE franchise_id = ? AND other_franchise_id = ? ORDER BY RANDOM() LIMIT 1"
      )
      .bind(fid, otherFid)
      .all();
    return results?.[0] || null;
  } catch (e) {
    console.log(`[therapy] loadTradeWith failed: ${e?.message || e}`);
    return null;
  }
}

// Any real trade the patient made, any counterparty -- the general "keep it
// real but find the positive" self-deprecating material even when no rival
// was named.
async function loadRandomOwnTrade(env, fid) {
  if (!env.UPS_MFL_DB || !fid) return null;
  try {
    const { results } = await env.UPS_MFL_DB
      .prepare("SELECT * FROM ups_trade_outcomes WHERE franchise_id = ? ORDER BY RANDOM() LIMIT 1")
      .bind(fid)
      .all();
    return results?.[0] || null;
  } catch (e) {
    console.log(`[therapy] loadRandomOwnTrade failed: ${e?.message || e}`);
    return null;
  }
}

// ── rival name-matching (plain substring match, no LLM guessing) ──────────

function normalizeNameTokens(s) {
  return safeStr(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter((t) => t.length >= 4);
}

// Finds a franchise whose name (or owner's name) is recognizably present in
// the vent, e.g. "HammerTime" in a team named "HammerTime 🔨 ⏰" -- OR a
// shortened nickname of it, e.g. "Hammer" alone (people don't always say the
// full team name). Checked BOTH directions -- vent word is a substring of a
// name token, or vice versa -- since a nickname can be shorter OR longer
// than the token it stands in for. Still plain substring matching, not
// fuzzy/AI-guessed: a miss just means no rival callback that session, which
// is the safe failure direction.
export function findMentionedFranchise(ventText, owners, excludeFid) {
  const ventWords = normalizeNameTokens(ventText);
  if (!ventWords.length) return "";
  for (const o of owners) {
    const fid = safeStr(o.franchise_id);
    if (!fid || fid === excludeFid) continue;
    const nameTokens = [...normalizeNameTokens(o.franchise_name), ...normalizeNameTokens(o.owner_display)];
    const hit = nameTokens.some((nt) => ventWords.some((vw) => nt.includes(vw) || vw.includes(nt)));
    if (hit) return fid;
  }
  return "";
}

function ownerNameFor(fid, owners) {
  const o = owners.find((x) => safeStr(x.franchise_id) === fid);
  return safeStr(o?.owner_display) || safeStr(o?.franchise_name) || "an owner";
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
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

// ── slash command entry point → MODAL ───────────────────────────────────

export async function handleTherapyCommand(interaction, _env, _ctx) {
  return jsonResponse({
    type: INTERACTION_RESPONSE.MODAL,
    data: {
      custom_id: "therapy_modal",
      title: "🛋️ On the couch",
      components: [
        {
          type: COMPONENT_TYPE.ACTION_ROW,
          components: [
            {
              type: COMPONENT_TYPE.TEXT_INPUT,
              custom_id: "vent_text",
              label: "What's going on?",
              style: TEXT_INPUT_STYLE.PARAGRAPH,
              min_length: 0,
              max_length: 1900,
              // Discord caps TEXT_INPUT placeholder at 100 chars -- the first
              // version of this string was 105 and Discord silently rejects
              // an over-length modal response as invalid. The worker still
              // logs a clean 200 (it never validates Discord's own field
              // limits), so from our side nothing looks wrong at all -- the
              // only symptom is Discord showing the command as having never
              // responded. Keep any future edit here under 100 chars.
              placeholder: "Vent. Trash talk. Whatever's on your mind. (Optional -- blank for a straight pep talk.)",
              required: false,
            },
          ],
        },
      ],
    },
  });
}

export function isTherapyModal(customId) {
  return safeStr(customId) === "therapy_modal";
}

// ── modal submit → defer + generate ─────────────────────────────────────

export async function handleTherapyModal(interaction, env, ctx) {
  const invoker = resolveInvoker(interaction);
  const ventText = extractVentText(interaction);
  const interactionToken = safeStr(interaction?.token || "");
  const applicationId = safeStr(interaction?.application_id || env.DISCORD_APPLICATION_ID || "");
  const channelId = safeStr(interaction?.channel_id || "");

  if (!invoker.id) {
    return ephemeralReply("Couldn't tell who's on the couch -- try again.");
  }

  const run = () =>
    runTherapyPipelineSafe({ env, invoker, ventText, interactionToken, applicationId, channelId });
  if (ctx && typeof ctx.waitUntil === "function") {
    ctx.waitUntil(run());
  } else {
    await run();
  }

  return jsonResponse({ type: INTERACTION_RESPONSE.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE, data: { flags: FLAG_EPHEMERAL } });
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
            body: JSON.stringify({ content: `🚨 therapy pipeline crash (patient ${args.invoker?.name}):\n\`\`\`${msg.slice(0, 1500)}\`\`\`` }),
          });
        }
      }
    } catch (_) { /* best effort */ }
  }
}

async function runTherapyPipeline({ env, invoker, ventText, interactionToken, applicationId, channelId }) {
  const botToken = safeStr(env.DISCORD_BOT_TOKEN || env.DISCORD_BOT || "");
  const fid = await resolveFranchiseId(env, invoker.id);
  if (!fid) {
    await followUpInteraction(applicationId, interactionToken, {
      content: "Couldn't find you on a roster -- no session today.",
      flags: FLAG_EPHEMERAL,
    });
    return;
  }

  const [row, receipts, owners] = await Promise.all([
    loadCareerStats(env, fid),
    loadPositiveReceipts(env, fid),
    loadAllOwners(env),
  ]);

  const facts = shuffle(buildPositiveFacts(row));
  const displayName = safeStr(row?.owner_display) || invoker.name;

  const mentionedFid = findMentionedFranchise(ventText, owners, fid);
  let rival = null;
  let trade = null;
  if (mentionedFid) {
    // A named rival gets first crack at BOTH ingredients -- try the sharpest
    // one (a real trade between the two of them) before falling back to a
    // bad beat about them.
    const [tradeRow, beat] = await Promise.all([
      loadTradeWith(env, fid, mentionedFid),
      loadBadBeat(env, mentionedFid),
    ]);
    if (tradeRow) trade = { name: ownerNameFor(mentionedFid, owners), row: tradeRow };
    else if (beat) rival = { name: ownerNameFor(mentionedFid, owners), beat };
  } else {
    // No rival named -- occasionally surface the patient's OWN trade
    // history (self-deprecating material) or someone else's bad beat, but
    // not both; keep the odds low enough that most sessions carry neither.
    const roll = Math.random();
    if (roll < 0.3) {
      const tradeRow = await loadRandomOwnTrade(env, fid);
      if (tradeRow) trade = { name: ownerNameFor(tradeRow.other_franchise_id, owners), row: tradeRow };
    } else if (roll < 0.5) {
      const beat = await loadRandomBadBeat(env, fid);
      if (beat) rival = { name: ownerNameFor(beat.franchise_id, owners), beat };
    }
  }

  const body = await generateTherapy(env, displayName, facts, receipts.slice(0, 2), ventText, rival, trade);

  let posted = false;
  if (channelId && botToken) {
    posted = await postToDiscordChannel(botToken, channelId, {
      content: body.slice(0, 1900),
      allowed_mentions: { parse: [] },
    });
  }
  await followUpInteraction(applicationId, interactionToken, {
    content: posted ? "🛋️ Session posted ✓" : "Couldn't post to the channel -- try again.",
    flags: FLAG_EPHEMERAL,
  });
}

function rivalBlock(rival) {
  if (!rival) return "(none available -- skip this angle entirely, don't mention any other owner unprompted)";
  const b = rival.beat;
  const verdictNote =
    b.verdict === "process"
      ? "a real misplay -- fair to needle the DECISION"
      : b.verdict === "variance"
      ? "bad luck, not a mistake -- needle the universe/matchup, never their judgment"
      : "unclear -- keep any mention light and non-judgmental";
  const resultNote = b.matchup_result
    ? ` That week he ${b.matchup_result} by ${b.matchup_margin} points${b.swing_flips_result ? " -- that exact swing would have flipped it" : ""}.`
    : "";
  return (
    `${rival.name} -- Season ${b.season}, Week ${b.week}: benched ${b.benched_name} ` +
    `(${b.benched_score} pts) and started ${b.started_name} (${b.started_score} pts) instead. ` +
    `Verdict: ${verdictNote}.${resultNote}`
  );
}

function formatPlayerList(list) {
  if (!list.length) return "nothing";
  return list
    .map((p) => {
      let s = p.pos ? `${p.player_name} (${p.pos})` : p.player_name;
      if (p.still_there) {
        s += ` [still on that roster ${p.years_retained} yr${p.years_retained === 1 ? "" : "s"} later`;
        if (p.current_contract) s += `, now under contract for ${p.current_contract}`;
        s += "]";
      }
      return s;
    })
    .join(", ");
}

function tradeBlock(trade) {
  if (!trade) return "(none available -- skip this angle entirely, don't mention any other owner unprompted)";
  const t = trade.row;
  let gave, got, notable;
  try {
    gave = JSON.parse(t.gave_players_json || "[]");
    got = JSON.parse(t.got_players_json || "[]");
    notable = JSON.parse(t.notable_json || "[]");
  } catch (_) {
    return "(none available -- skip this angle entirely, don't mention any other owner unprompted)";
  }
  return (
    `A real trade with ${trade.name}, Season ${t.season}: the patient GAVE ${formatPlayerList(gave)}` +
    `${t.gave_extra ? " " + t.gave_extra : ""}, and GOT ${formatPlayerList(got)}${t.got_extra ? " " + t.got_extra : ""} in return. ` +
    `In ${t.next_season} (the season right after): what he gave up scored ${t.gave_next_season_pts ?? "no data"} pts total, ` +
    `what he got scored ${t.got_next_season_pts ?? "no data"} pts total.` +
    (notable.length ? ` Proven fact: ${notable.join("; ")}.` : "")
  );
}

async function generateTherapy(env, displayName, facts, receipts, ventText, rival, trade) {
  const factsBlock = facts.length
    ? facts.map((f) => `- ${f}`).join("\n")
    : "(none on record yet -- lean on tenure/camaraderie only, and keep it short)";
  const receiptsBlock = receipts.length
    ? receipts.map((r) => `- [${safeStr(r.date)}] "${safeStr(r.quote)}"${r.why ? ` -- ${safeStr(r.why)}` : ""}`).join("\n")
    : "(none provided)";
  const userText =
    `Patient: ${displayName}\n\n` +
    `WHAT THE PATIENT TYPED (may be empty -- respond to it directly if present, riff on any other owner named in it without asserting new facts about them):\n"${ventText || "(nothing typed -- go straight to the session)"}"\n\n` +
    `VERIFIED POSITIVE FACTS ABOUT THE PATIENT (the only facts you may assert about them):\n${factsBlock}\n\n` +
    `REAL QUOTES (verbatim, optional, use at most one if it fits):\n${receiptsBlock}\n\n` +
    `OPTIONAL RIVAL BAD BEAT (a real event about a DIFFERENT owner -- may be used for one light "misery loves company" aside if it fits naturally, never the focus of the session):\n${rivalBlock(rival)}\n\n` +
    `OPTIONAL TRADE HISTORY (a real trade the PATIENT made -- who they gave up, who they got, what happened next, and whether the other player stuck around and what they cost. Real and often the best material, per the patient's own rule: "shit on me but in a sarcastic fluff me up way"):\n${tradeBlock(trade)}\n\n` +
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
