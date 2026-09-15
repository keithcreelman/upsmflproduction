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
- If the OPTIONAL TRADE HISTORY block gives you a real trade the patient made that looks bad in hindsight (they gave up a player who went on to thrive elsewhere), that's fair game and often the BEST material: be bluntly sarcastic about the L itself first -- don't soften it -- then pivot to something genuinely true and positive (what they got instead, roster flexibility, anything real in the data). Keith's own words for this shape: "shit on me but in a sarcastic fluff me up way." That's the shape, not a script -- write a fresh version every time, never the same joke or phrasing twice.
- A current_contract or latest_season_arc fact in the TRADE HISTORY is a CURRENT / recent fact (as of right now, or the most recently completed season) -- NEVER the trade-time value. Never imply a contract figure or a season's stats were true back when the trade happened (don't say "he was a $22K player back then" or "he was already the #1 TE that year" about a fact that is actually from years later) -- if you cite one, frame it as "now" / "since then" / "as of today," not as the trade-year price or performance.
- If the TRADE HISTORY gives you REAL individual per-player numbers (the bracketed points next to a specific name, not just the side totals), naming the SPECIFIC weakest player received in return is great, pointed material -- e.g. "...and the guy you got instead, [Name], barely did anything" -- grounded only in the real number given, never invented, and never about a player who wasn't actually the low one by that real number.
- A CLOSING TWIST (turning it back on whoever benefited) is optional, and MUST be grounded: only use it if you have a real number or real fact to hang it on -- a current_contract dollar figure already in the trade history, or something from the OPTIONAL TWIST AMMO block. If neither gives you anything concrete, skip the twist entirely rather than write a rhetorical line implying a real consequence with nothing behind it (a past version of this bot said "he's paying you" about someone who, in fact, was not paying anyone anything -- don't repeat that).
- The RIVAL BAD BEAT and the TRADE HISTORY are both "one aside about someone/something else" ingredients -- when both are present, pick whichever tells the sharper, more specific story and use only that one. The TWIST AMMO is separate and can pair with either. The WIN TRADE is its own thing too, meant to pair with a rough TRADE HISTORY as the "but here's a win" pivot. Using every single ingredient at once still reads cluttered, not clever -- pick the mix that makes the sharpest, most specific session, not the most crowded one.
- Vary yourself. Don't open the same way twice in a row, don't always lead with the same kind of fact or the same structure -- you have several real ingredients each time (the facts, an optional quote, an optional rival aside, an optional trade history); lean on a different mix and a different angle each session so this never reads like a template.
- If the patient predicts or dreads something that HASN'T happened yet (a game still to be played, a matchup still in progress), that's their anxiety talking -- respond to the feeling, never confirm or deny the outcome as if you know it. You don't.
- SESSION RECENCY tells you how long it's been since their last visit. Under ~30 minutes: acknowledge they're back fast -- your own words each time, something like "back so soon?" but never that exact phrase twice in a row. Several days or longer: a brief "welcome back" acknowledging the gap is a nice touch, not required. Their first-ever session: don't mention recency at all, there's nothing to reference.
- If the OPTIONAL WIN TRADE block gives you a real trade the patient actually won, use it -- don't let a rough TRADE HISTORY be the only trade story in the session. It pairs especially well right after a bad one: "sure, that one stung, BUT..." A win against the same rival already in play is the sharpest version of this and worth reaching for; a win against someone else is still real and still worth citing.
- VISIT CAP: if that block says they're OVER THE LIMIT, open with one playful "the office is closed" line that uses the exact visit number and minutes it gives you. Write it fresh every time -- the tone is like "Visit number four in 57 minutes. I'm going to go alphabetize the waiver wire and pretend none of this happened." or "Fourth session. The front desk is closed while I stare at the ceiling and wait for the next snap count." -- but never reuse those lines or your own previous one. Aim it at the situation (the repeat visits), not at the patient as a person. Keep it absurd and harmless: no jokes about injury, death or self-harm (yours or anyone's), medical conditions, or sexual health. That line replaces the SESSION RECENCY reaction -- don't do both. Then still answer what they typed, especially an injury or lineup worry, but keep the whole session under 50 words.
- Max 110 words (50 when the VISIT CAP applies). Plain text, no markdown, no bullet points.
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

// Session recency (migration 0156). Keith: "when you go back to the therapy
// session fairly quickly from the last session, 'Back again so soon?'...
// and when it's been a minute give similar feedback." No historical-accuracy
// risk here (unlike the bad-beat/trade tables) -- forward-looking state,
// always correct by construction.
async function loadLastSession(env, fid) {
  if (!env.UPS_MFL_DB || !fid) return null;
  try {
    const { results } = await env.UPS_MFL_DB
      .prepare("SELECT last_session_at_utc, session_count FROM ups_therapy_sessions WHERE franchise_id = ? LIMIT 1")
      .bind(fid)
      .all();
    return results?.[0] || null;
  } catch (e) {
    console.log(`[therapy] loadLastSession failed: ${e?.message || e}`);
    return null;
  }
}

async function recordSession(env, fid) {
  if (!env.UPS_MFL_DB || !fid) return;
  try {
    const now = new Date().toISOString();
    await env.UPS_MFL_DB
      .prepare(
        "INSERT INTO ups_therapy_sessions (franchise_id, last_session_at_utc, session_count) VALUES (?, ?, 1) " +
        "ON CONFLICT(franchise_id) DO UPDATE SET last_session_at_utc = excluded.last_session_at_utc, session_count = ups_therapy_sessions.session_count + 1"
      )
      .bind(fid, now)
      .run();
  } catch (e) {
    console.log(`[therapy] recordSession failed: ${e?.message || e}`);
  }
}

// Visit cap (migration 0157): more than VISIT_LIMIT sessions from one Discord
// user in one channel inside VISIT_WINDOW_MIN gets a closed-office joke and a
// shortened session. Counted per user+channel, not per franchise.
const VISIT_WINDOW_MIN = 90;
const VISIT_LIMIT = 3;
const ORDINALS = ["first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth", "tenth"];

async function loadRecentVisits(env, discordUserId, channelId) {
  if (!env.UPS_MFL_DB || !discordUserId || !channelId) return null;
  try {
    const since = new Date(Date.now() - VISIT_WINDOW_MIN * 60000).toISOString();
    const { results } = await env.UPS_MFL_DB
      .prepare(
        "SELECT COUNT(*) AS n, MIN(visited_at_utc) AS first_at FROM ups_therapy_visits " +
        "WHERE discord_user_id = ? AND channel_id = ? AND visited_at_utc >= ?"
      )
      .bind(discordUserId, channelId, since)
      .all();
    return { prior: Number(results?.[0]?.n) || 0, firstAt: results?.[0]?.first_at || null };
  } catch (e) {
    console.log(`[therapy] loadRecentVisits failed: ${e?.message || e}`);
    return null;
  }
}

async function recordVisit(env, discordUserId, channelId, fid) {
  if (!env.UPS_MFL_DB || !discordUserId || !channelId) return;
  try {
    await env.UPS_MFL_DB
      .prepare("INSERT INTO ups_therapy_visits (discord_user_id, channel_id, franchise_id, visited_at_utc) VALUES (?, ?, ?, ?)")
      .bind(discordUserId, channelId, fid || null, new Date().toISOString())
      .run();
  } catch (e) {
    console.log(`[therapy] recordVisit failed: ${e?.message || e}`);
  }
}

// null = under the cap OR the count couldn't be read. An unreadable count must
// never produce a "fourth visit" line -- that would be an invented number.
export function visitCapFact(visits, nowMs = Date.now()) {
  if (!visits || visits.prior < VISIT_LIMIT) return null;
  const visitNo = visits.prior + 1;
  const firstMs = visits.firstAt ? new Date(visits.firstAt).getTime() : NaN;
  const mins = Number.isFinite(firstMs) ? Math.max(1, Math.round((nowMs - firstMs) / 60000)) : null;
  return { visitNo, ordinal: ORDINALS[visitNo - 1] || `#${visitNo}`, mins };
}

function visitCapBlock(cap) {
  if (!cap) return "(under the limit -- ignore this, don't mention visit counts)";
  const span = cap.mins != null ? `the last ${cap.mins} minute${cap.mins === 1 ? "" : "s"}` : `the last ${VISIT_WINDOW_MIN} minutes`;
  return `OVER THE LIMIT: this is their ${cap.ordinal} session (visit #${cap.visitNo}) in this channel within ${span}. The normal limit is ${VISIT_LIMIT} per ${VISIT_WINDOW_MIN} minutes.`;
}

// Real elapsed time since their last visit, phrased plainly -- the model
// decides the tone ("back so soon?" vs "welcome back"), this just hands it
// the real number so it never has to guess or invent a gap.
function recencyFact(lastSession) {
  if (!lastSession) return "(no prior session on record -- this is their first time on this couch, don't reference recency at all)";
  const last = new Date(lastSession.last_session_at_utc);
  const mins = (Date.now() - last.getTime()) / 60000;
  const count = (Number(lastSession.session_count) || 0) + 1;
  let when;
  if (!(mins >= 0)) when = "recently";
  else if (mins < 1) when = "under a minute ago";
  else if (mins < 60) when = `${Math.round(mins)} minute${Math.round(mins) === 1 ? "" : "s"} ago`;
  else if (mins < 60 * 24) when = `${Math.round(mins / 60)} hour${Math.round(mins / 60) === 1 ? "" : "s"} ago`;
  else when = `${Math.round(mins / (60 * 24))} day${Math.round(mins / (60 * 24)) === 1 ? "" : "s"} ago`;
  return `Their last session was ${when}. This will be session #${count} for them.`;
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

// currentOwnerDisplay (optional): when given, filters to bad beats whose
// STORED owner_name (the real, season-accurate owner -- see migration 0154)
// matches this CURRENT owner display name. Used ONLY for the "mentioned
// rival" path in runTherapyPipeline, where a name the patient typed today
// (e.g. "Hammer") must only surface a bad beat that happened under THAT
// owner's own tenure -- otherwise "a real bad beat from Hammer" could
// surface one that happened under a PREVIOUS owner of that franchise slot,
// which would misleadingly attribute it to Hammer. Omit it (as the
// random-own-bad-beat / random-rival-bad-beat fallback paths do) to draw
// from the franchise's whole history regardless of who owned it when --
// those paths are correctly naming via the row's own owner_name already,
// they just don't filter the SELECTION.
async function loadBadBeat(env, fid, currentOwnerDisplay) {
  if (!env.UPS_MFL_DB || !fid) return null;
  try {
    const { results } = currentOwnerDisplay
      ? await env.UPS_MFL_DB
          .prepare("SELECT * FROM ups_bad_beats WHERE franchise_id = ? AND owner_name = ? ORDER BY RANDOM() LIMIT 1")
          .bind(fid, currentOwnerDisplay)
          .all()
      : await env.UPS_MFL_DB
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
//
// currentOwnerDisplay (optional): same filter as loadBadBeat above, bound
// against other_owner_name (the counterparty's real, season-accurate owner
// -- see migration 0155) instead of owner_name -- this is the mentioned
// rival's side of the trade. Used ONLY for the "mentioned rival" path;
// loadRandomOwnTrade (the no-rival-named fallback) never passes this.
async function loadTradeWith(env, fid, otherFid, currentOwnerDisplay) {
  if (!env.UPS_MFL_DB || !fid || !otherFid) return null;
  try {
    const { results } = currentOwnerDisplay
      ? await env.UPS_MFL_DB
          .prepare(
            "SELECT * FROM ups_trade_outcomes WHERE franchise_id = ? AND other_franchise_id = ? AND other_owner_name = ? ORDER BY RANDOM() LIMIT 1"
          )
          .bind(fid, otherFid, currentOwnerDisplay)
          .all()
      : await env.UPS_MFL_DB
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

// Every trade the patient made, optionally narrowed to one counterparty --
// used to hunt for a genuinely GOOD one (see bestPositiveTrade below).
// Keith: "maybe identify a trade that has worked out for me as a positive
// whether it be with hammer or not but ideally the person im complaining
// about." Unfiltered by owner-era on purpose, same reasoning as
// loadRandomOwnTrade -- the counterparty's own stored owner_name/
// other_owner_name already names whoever was actually involved correctly.
async function loadAllTradesFor(env, fid, otherFid) {
  if (!env.UPS_MFL_DB || !fid) return [];
  try {
    const { results } = otherFid
      ? await env.UPS_MFL_DB
          .prepare("SELECT * FROM ups_trade_outcomes WHERE franchise_id = ? AND other_franchise_id = ?")
          .bind(fid, otherFid)
          .all()
      : await env.UPS_MFL_DB
          .prepare("SELECT * FROM ups_trade_outcomes WHERE franchise_id = ?")
          .bind(fid)
          .all();
    return results || [];
  } catch (e) {
    console.log(`[therapy] loadAllTradesFor failed: ${e?.message || e}`);
    return [];
  }
}

// Scores a trade from the PATIENT's side using only already-verified, real,
// stored numbers -- never a stored "winner" label (this table deliberately
// never encodes one, see its own module docstring). Higher = better for the
// patient. A player they GOT who's still thriving is the strongest signal;
// a player they GAVE AWAY who's still thriving works against them (that's
// the "shit on me" trade's job, not this one's).
function tradePatientScore(row) {
  let got, gave;
  try {
    got = JSON.parse(row.got_players_json || "[]");
    gave = JSON.parse(row.gave_players_json || "[]");
  } catch (_) {
    return -Infinity;
  }
  let score = 0;
  if (got.some((p) => p.latest_season_arc && p.latest_season_arc.notable)) score += 100;
  if (gave.some((p) => p.latest_season_arc && p.latest_season_arc.notable)) score -= 100;
  if (row.got_trade_season_pts != null && row.gave_trade_season_pts != null) {
    score += row.got_trade_season_pts - row.gave_trade_season_pts;
  }
  if (row.got_next_season_pts != null && row.gave_next_season_pts != null) {
    score += (row.got_next_season_pts - row.gave_next_season_pts) * 0.5;
  }
  return score;
}

// The single best-for-the-patient trade in a set, or null if none of them
// are genuinely positive (score > 0) -- never force a bad trade into this
// slot just because it's the "best of a bad bunch".
function bestPositiveTrade(rows) {
  if (!rows.length) return null;
  const top = rows.map((row) => ({ row, score: tradePatientScore(row) })).sort((a, b) => b.score - a.score)[0];
  return top.score > 0 ? top.row : null;
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

// Real ammo about a rival for the closing "twist" -- Keith caught the model
// inventing an ungrounded line ("Rent-free? He's paying you.") when the
// trade block had no real current_contract fact to hang a twist on. His fix:
// "come up with a stat that shits on him... figure out something from his
// dossier." Reuses the roast bot's existing, already-curated
// ups_roast_owner_ammo.roast_angles_json -- fine to reuse HERE (unlike
// discord_receipts_json/positive_receipts_json, which are reserved for their
// own bots) because this is roast material being used on a RIVAL, which is
// exactly what it was curated for; only the PATIENT's own material stays
// off-limits for roasting.
async function loadRivalDossier(env, fid) {
  if (!env.UPS_MFL_DB || !fid) return null;
  try {
    const { results } = await env.UPS_MFL_DB
      .prepare("SELECT roast_angles_json FROM ups_roast_owner_ammo WHERE franchise_id = ? LIMIT 1")
      .bind(fid)
      .all();
    return results?.[0] || null;
  } catch (e) {
    console.log(`[therapy] loadRivalDossier failed: ${e?.message || e}`);
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

  const [row, receipts, owners, lastSession, recentVisits] = await Promise.all([
    loadCareerStats(env, fid),
    loadPositiveReceipts(env, fid),
    loadAllOwners(env),
    loadLastSession(env, fid),
    loadRecentVisits(env, invoker.id, channelId),
  ]);
  // Record THIS session now -- read the prior values above first (for the
  // gap calculation and the visit count), then write so the NEXT session
  // sees this one. A missed write just makes the next count slightly low.
  const recordSessionPromise = Promise.all([
    recordSession(env, fid),
    recordVisit(env, invoker.id, channelId, fid),
  ]);
  const cap = visitCapFact(recentVisits);

  const facts = shuffle(buildPositiveFacts(row));
  const displayName = safeStr(row?.owner_display) || invoker.name;

  const mentionedFid = findMentionedFranchise(ventText, owners, fid);
  let rival = null;
  let trade = null;
  // Over the visit cap the session is short and skips the trade/rival
  // material entirely, so none of the lookups below run.
  if (!cap && mentionedFid) {
    // CURRENT owner display of the mentioned rival's franchise slot -- e.g.
    // "Hammer" typed today resolves to Eric Martel via findMentionedFranchise
    // (correct, unchanged). This value is used ONLY to FILTER the queries
    // below to that owner's own tenure -- it is NOT used to name the result
    // (naming comes from the row's own stored owner_name/other_owner_name,
    // below), since a filtered row's stored name always equals this anyway.
    const currentOwnerDisplay = ownerNameFor(mentionedFid, owners);
    // A named rival gets first crack at BOTH ingredients -- try the sharpest
    // one (a real trade between the two of them) before falling back to a
    // bad beat about them. Both are FILTERED to currentOwnerDisplay's own
    // tenure on that franchise slot -- a real trade/bad beat that happened
    // under a PREVIOUS owner of the slot must not surface here, since that
    // would misleadingly attribute it to the CURRENT owner the patient
    // named. No unfiltered fallback: "nothing under this owner's tenure" is
    // a correct, safe result, not an error to work around.
    const [tradeRow, beat] = await Promise.all([
      loadTradeWith(env, fid, mentionedFid, currentOwnerDisplay),
      loadBadBeat(env, mentionedFid, currentOwnerDisplay),
    ]);
    // Name from the row's own stored, season-accurate column -- falls back
    // to ownerNameFor() only defensively (should be rare post-backfill: a
    // row synced before its owner_name/other_owner_name column existed).
    if (tradeRow) trade = { name: tradeRow.other_owner_name || currentOwnerDisplay, row: tradeRow };
    else if (beat) rival = { name: beat.owner_name || currentOwnerDisplay, beat };
  } else if (!cap) {
    // No rival named -- occasionally surface the patient's OWN trade
    // history (self-deprecating material) or someone else's bad beat, but
    // not both; keep the odds low enough that most sessions carry neither.
    // UNFILTERED by design -- see loadRandomOwnTrade/loadRandomBadBeat: any
    // real historical counterparty is fair game here, correctly labeled via
    // the row's own stored owner_name/other_owner_name.
    const roll = Math.random();
    if (roll < 0.3) {
      const tradeRow = await loadRandomOwnTrade(env, fid);
      if (tradeRow) trade = { name: tradeRow.other_owner_name || ownerNameFor(tradeRow.other_franchise_id, owners), row: tradeRow };
    } else if (roll < 0.5) {
      const beat = await loadRandomBadBeat(env, fid);
      if (beat) rival = { name: beat.owner_name || ownerNameFor(beat.franchise_id, owners), beat };
    }
  }

  // Real ammo for the closing twist against whoever the aside is about --
  // without this the model has nothing to turn the twist on and invents an
  // ungrounded line instead. MUST name the exact same person already named
  // in `trade`/`rival` above (never re-derive via ownerNameFor(), which is
  // the current-owner-only bug this whole fix exists to close) -- a random
  // OWN trade/bad beat can point at a PAST owner of a franchise slot, and
  // the twist has to follow that same person, not today's owner of the slot.
  const twistTarget = cap
    ? null
    : mentionedFid
    ? { fid: mentionedFid, name: ownerNameFor(mentionedFid, owners), isCurrentOwner: true }
    : trade
    ? { fid: trade.row.other_franchise_id, name: trade.name, isCurrentOwner: trade.name === ownerNameFor(trade.row.other_franchise_id, owners) }
    : rival
    ? { fid: rival.beat.franchise_id, name: rival.name, isCurrentOwner: rival.name === ownerNameFor(rival.beat.franchise_id, owners) }
    : null;
  let twist = null;
  if (twistTarget) {
    const [dossier, extraBeat] = await Promise.all([
      // ups_roast_owner_ammo is keyed by CURRENT franchise_id and holds only
      // the CURRENT owner's dossier -- only valid when the twist target IS
      // that current owner, never for a past owner of the same slot.
      twistTarget.isCurrentOwner ? loadRivalDossier(env, twistTarget.fid) : Promise.resolve(null),
      // Filtered to twistTarget's own tenure, same as the mentioned-rival
      // path above -- an unfiltered fetch here would silently reintroduce
      // the exact bug this fix closes.
      rival ? Promise.resolve(null) : loadBadBeat(env, twistTarget.fid, twistTarget.name),
    ]);
    if (dossier || extraBeat) twist = { name: twistTarget.name, dossier, beat: extraBeat || rival?.beat || null };
  }

  // A genuine WIN to pair with a rough TRADE HISTORY -- Keith: "maybe
  // identify a trade that has worked out for me as a positive... ideally
  // the person im complaining about." Only bothers fetching when there's
  // already a named rival or a trade story in play (the two scenarios this
  // is actually meant to pair with), not on every session.
  let winTrade = null;
  if (!cap && (mentionedFid || trade)) {
    const preferredFid = mentionedFid || trade.row.other_franchise_id;
    const preferredName = mentionedFid ? ownerNameFor(mentionedFid, owners) : trade.name;
    let candidates = await loadAllTradesFor(env, fid, preferredFid);
    let best = bestPositiveTrade(candidates);
    let winName = preferredName;
    if (!best) {
      candidates = await loadAllTradesFor(env, fid);
      best = bestPositiveTrade(candidates);
      if (best) winName = best.other_owner_name || ownerNameFor(best.other_franchise_id, owners);
    }
    if (best) winTrade = { row: best, name: winName };
  }

  // recordSessionPromise runs concurrently with the (slower) Anthropic call
  // rather than a true fire-and-forget -- Workers can cancel an unawaited
  // promise once the handler returns, so this still needs a real await
  // somewhere before the pipeline ends.
  const [body] = await Promise.all([
    generateTherapy(env, displayName, facts, receipts.slice(0, 2), ventText, rival, trade, twist, recencyFact(lastSession), winTrade, cap),
    recordSessionPromise,
  ]);

  // Echo the patient's own words into the channel first, same pattern the
  // roast/wire reply bots already use -- Keith: "I would like what i send
  // to the bot to be passed back to the channel." No button on the echo,
  // it's just their own words relayed before the bot's reply follows.
  if (ventText && channelId && botToken) {
    await postToDiscordChannel(botToken, channelId, {
      content: `**${displayName}** says:\n> ${ventText.slice(0, 1900)}`,
      allowed_mentions: { parse: [] },
    });
  }

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

// Roast angles are curated for roasting and carry a `source` tag -- an
// angle with NO source is explicitly marked "do not cite as a stat"
// elsewhere in the codebase (discord_roast_reply.js), so the same rule
// applies here: only sourced angles are real enough to hand the model.
function twistBlock(twist) {
  if (!twist) {
    return "(none available -- if you want a twist, only use a current_contract fact already given above in the trade history, or skip the twist entirely)";
  }
  let angles = [];
  try {
    angles = JSON.parse(twist.dossier?.roast_angles_json || "[]");
  } catch (_) {
    angles = [];
  }
  const angleLines = angles
    .filter((a) => safeStr(a?.source))
    .slice(0, 4)
    .map((a) => `- ${safeStr(a.text)} [source: ${safeStr(a.source)}]`);
  const beatLine = twist.beat
    ? `- A real flukey/bad week: Season ${twist.beat.season} Week ${twist.beat.week}, benched ${twist.beat.benched_name} (${twist.beat.benched_score} pts) for ${twist.beat.started_name} (${twist.beat.started_score} pts) -- ${twist.beat.verdict === "process" ? "a real misplay, fair to needle" : "bad luck, not his fault -- needle the universe, not him"}.`
    : "";
  const all = [beatLine, ...angleLines].filter(Boolean);
  return all.length
    ? `Real ammo about ${twist.name} for a closing twist (pick AT MOST ONE if it fits, phrase it fresh yourself -- these are background material, not a script to quote):\n${all.join("\n")}`
    : "(nothing concrete available -- skip the twist rather than inventing one)";
}

function formatPlayerList(list) {
  if (!list.length) return "nothing";
  return list
    .map((p) => {
      let s = p.pos ? `${p.player_name} (${p.pos})` : p.player_name;
      // Individual, real per-player points (added 2026-09-14, Keith: "you
      // received something named Richie James or akin when the player
      // returned sucks. It's just a slam in the face" -- needed a way to
      // name ONE specific player's own score, not only the side-wide sum
      // given separately in tradeBlock()). trade_season_pts is always real
      // (unconditional, same as the side aggregate); next_season_pts is
      // null when THIS player specifically had already moved on before
      // next_season (same per-player held_by_in_season gate the side
      // aggregate already applies, just one player at a time) -- say so
      // rather than silently omitting it.
      s += ` [scored ${p.trade_season_pts} pts that season`;
      s += p.next_season_pts != null ? `, ${p.next_season_pts} pts the next season` : `, moved on before the next season`;
      s += "]";
      if (p.still_there) {
        s += ` [still on that roster ${p.years_retained} yr${p.years_retained === 1 ? "" : "s"} later`;
        if (p.current_contract) s += `, now under contract for ${p.current_contract}`;
        // latest_season_arc (added 2026-09-14, Keith: "he wasn't a 22K deal
        // back then and since then he's not only the TE3 this yr, he was
        // TE1 all of last yr") -- the most recently COMPLETED season's real
        // performance, gated the same still_there + held_by_in_season way
        // current_contract already is; only present when this player
        // individually passed that gate, and never the exact same season
        // as the next_season_pts fact above (see sync script).
        if (p.latest_season_arc) {
          s += `, and in ${p.latest_season_arc.season} scored ${p.latest_season_arc.pts} pts`;
          if (p.latest_season_arc.notable) s += ` (${p.latest_season_arc.notable})`;
        }
        s += "]";
      }
      return s;
    })
    .join(", ");
}

function tradeBlock(trade) {
  if (!trade) return "(none available -- skip this angle entirely, don't mention any other owner unprompted)";
  const t = trade.row;
  let gave, got, notable, tradeSeasonNotable;
  try {
    gave = JSON.parse(t.gave_players_json || "[]");
    got = JSON.parse(t.got_players_json || "[]");
    notable = JSON.parse(t.notable_json || "[]");
    tradeSeasonNotable = JSON.parse(t.trade_season_notable_json || "[]");
  } catch (_) {
    return "(none available -- skip this angle entirely, don't mention any other owner unprompted)";
  }
  // next_season pts/notable are GATED on the player still being on the
  // relevant roster that exact season (fixed 2026-09-14: a McCaffrey trade
  // used to credit Keith's side with McCaffrey's real 2025 #1-RB season even
  // though McCaffrey had already moved to a THIRD team by then -- Keith's
  // actual 2024 with him was 48.4 points, badly injured). NULL here means
  // "already moved on", not "no data" -- say so explicitly rather than
  // leaving it ambiguous, and lead with trade_season stats instead, which
  // are always real for whoever actually held the player right after the
  // trade.
  const nextSeasonLine =
    t.gave_next_season_pts == null && t.got_next_season_pts == null
      ? `By ${t.next_season}, both sides of this had already moved the relevant player(s) on to yet another roster -- no fair next-season number to cite.`
      : `Still true in ${t.next_season}: what he gave up scored ${t.gave_next_season_pts ?? "(he'd already moved that player on -- no fair number)"} pts, what he got scored ${t.got_next_season_pts ?? "(he'd already moved that player on -- no fair number)"} pts.`;
  return (
    `A real trade with ${trade.name}, Season ${t.season}: the patient GAVE ${formatPlayerList(gave)}` +
    `${t.gave_extra ? " " + t.gave_extra : ""}, and GOT ${formatPlayerList(got)}${t.got_extra ? " " + t.got_extra : ""} in return ` +
    `(each bracket above is that PLAYER's own real points, and their own latest-season arc if still on that roster -- ` +
    `use a specific name and number when one stands out, e.g. naming the weakest player received, not only the side totals below). ` +
    `Side totals, right on the new roster in ${t.season}: what he gave up scored ${t.gave_trade_season_pts ?? "no data"} pts combined, ` +
    `what he got scored ${t.got_trade_season_pts ?? "no data"} pts combined.` +
    (tradeSeasonNotable.length ? ` Proven fact (${t.season}): ${tradeSeasonNotable.join("; ")}.` : "") +
    ` ${nextSeasonLine}` +
    (notable.length ? ` Proven fact (${t.next_season}): ${notable.join("; ")}.` : "")
  );
}

// Same shape as tradeBlock() but for a GENUINE win -- Keith: "maybe identify
// a trade that has worked out for me as a positive... ideally the person im
// complaining about." Built from a trade already screened by
// bestPositiveTrade() to be genuinely positive (score > 0, real per-player
// numbers) -- this function only renders it, never judges it.
function winTradeBlock(winTrade) {
  if (!winTrade) return "(none available -- skip this angle entirely)";
  const t = winTrade.row;
  let gave, got;
  try {
    gave = JSON.parse(t.gave_players_json || "[]");
    got = JSON.parse(t.got_players_json || "[]");
  } catch (_) {
    return "(none available -- skip this angle entirely)";
  }
  return (
    `A real trade with ${winTrade.name}, Season ${t.season}, that actually worked out well for the patient: ` +
    `he gave ${formatPlayerList(gave)}${t.gave_extra ? " " + t.gave_extra : ""}, and got ${formatPlayerList(got)}${t.got_extra ? " " + t.got_extra : ""} in return ` +
    `(each bracket is that player's own real points and latest-season arc if still rostered). ` +
    `Side totals right on the new roster in ${t.season}: gave ${t.gave_trade_season_pts ?? "no data"} pts combined, got ${t.got_trade_season_pts ?? "no data"} pts combined.`
  );
}

async function generateTherapy(env, displayName, facts, receipts, ventText, rival, trade, twist, recency, winTrade, cap) {
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
    `OPTIONAL TWIST AMMO (real material for the closing twist against a rival -- ONLY use a fact from here, or a current_contract dollar figure already given above; never write a rhetorical line implying a real-world consequence, like "he's paying you", without an actual number behind it):\n${twistBlock(twist)}\n\n` +
    `OPTIONAL WIN TRADE (a DIFFERENT real trade the patient actually WON -- genuine pride material, the counterpoint to the TRADE HISTORY above if that one's rough. Use it, don't bury it, especially if it's against the same rival already in play):\n${winTradeBlock(winTrade)}\n\n` +
    `SESSION RECENCY (real, always true):\n${recency}\n\n` +
    `VISIT CAP (real, always true):\n${visitCapBlock(cap)}\n\n` +
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
