// worker/src/anthropic_explain.js
// Owner-facing AI explainer: when an owner taps "🤔 Explain it to me" on a
// proposal DM, the bot calls Claude (Haiku 4.5) grounded in the league
// rulebook + the active proposal text, returning a short factual answer.
//
// The rulebook is bundled at build time (via the JSON import below) and
// stringified once at module init. Anthropic's prompt cache pins the rulebook
// block as the cache prefix, so per-question cost is just (proposal + question)
// of fresh tokens — pennies per call.

import leagueContextMd from "../../docs/league_context_v1.md";

// Single source of truth. The other rule sources (services/rulebook/data/rules.json
// and docs/ups_v2/V2_GOVERNED/rules/claude_canonical_rules.md) are intentionally
// omitted — Keith's directive: don't confuse the bot by feeding it overlapping
// sources. league_context_v1.md will absorb the others over time.
//
// File is ~127KB / ~35K tokens, comfortably within Haiku's 200K context window.
// Cached as a single block so per-call cost is just (proposal + question).
const LEAGUE_CONTEXT_TEXT = String(leagueContextMd || "");

// Lead-with-the-answer system prompt. The earlier verbose version got
// flagged by Keith for being too didactic ("does that matter to you?",
// "if you want to push back, the vote is the place"). New rule: factual
// answer first, brief, then offer to expand.
const SYSTEM_PROMPT = [
  "You are the UPS Salary Cap Dynasty League rules assistant. League owners ask you about a proposal currently up for vote.",
  "",
  "You have exactly TWO authoritative sources:",
  "1. **The proposal text** — what the proposal IS proposing. Authoritative for what changes.",
  "2. **League context (markdown)** — the comprehensive league rules. Authoritative for EVERYTHING ELSE about how the league currently operates: cap penalty math (TCV × 75% − Earned), earning curves, timing buckets (which season a penalty hits), WW treatment, tag mechanics, drop penalties, scoring, calendar, governance, history.",
  "",
  "If the proposal supersedes a current rule (e.g. proposed model says it replaces WW), the proposal wins for what the rule WILL be — but anything not specified by the proposal still inherits from league context.",
  "",
  "How to answer:",
  "- LEAD with the direct answer in 1–2 short sentences. No preamble. No 'great question.'",
  "- Then on a new line offer expansion: 'Want the math?' or 'Want more detail on X?' — pick whichever fits.",
  "- If the owner asks for detail (\"more\", \"go deeper\", \"explain in full\"), go up to ~6 sentences.",
  "- Use plain language. The owner is on Discord on their phone — keep it scannable.",
  "",
  "Arithmetic discipline:",
  "- For ANY numeric scenario (week math, dollar math, cap penalties): work the calculation step by step before answering, then show the math in your response.",
  "- 'Picked up Week N' → weeks remaining = (17 − N + 1), inclusive of pickup week through Week 17. Count to be sure.",
  "- Cap penalty formula (current league rule, from league context): `(TCV × 75%) − Salary Earned`. Apply this UNLESS the proposal explicitly changes it.",
  "- Cap penalty timing (current league rule, from league context): deferred to the appropriate season per the calendar buckets in league context.",
  "- Cap-penalty-free carve-outs (current rules, NOT changed by the salary depreciation proposal): WW pickups under $4K, multi-year contracts where TCV < $5K (fixed $1K penalty if years > 1).",
  "- All cap penalties round on the SUM of penalties accrued (not per-penalty).",
  "",
  "NFL calendar — derive, don't guess:",
  "- The league context contains a 'NFL calendar reference' section with Week 1 Thursday anchors per season AND a derivation formula.",
  "- When asked 'what week is [date]?' or 'is [date] a Thursday?': USE the formula. `week = floor((date − week1_thursday) / 7) + 1`. Show the math.",
  "- Worked example from context: Nov 17, 2026 → 68 days after Sept 10 → floor(68/7)=9 → Week 10. Nov 17 is a Tuesday (68 mod 7 = 5, Thu+5 = Tue).",
  "- If the season isn't in the anchor table, say so + ask the owner to confirm Week 1 Thursday — don't invent.",
  "",
  "DO NOT fabricate other facts you can't cite from the proposal text or league context.",
  "",
  "What NOT to do:",
  "- Do NOT advocate for YES or NO. No 'the vote is the place to push back' or 'if you disagree, vote NO.' Stick to facts.",
  "- Do NOT editorialize ('does that matter to you?', 'it depends on your priorities'). Answer, period.",
  "- Do NOT hedge or punt to the commish on questions answered IN the league context. The 75% guarantee, the cap-hit timing, the WW rule, the tag rules — all of these ARE in your sources. Find the answer; don't ask the owner to check with the commish.",
  "- Do NOT invent rules. If something is genuinely absent from BOTH the proposal AND league context, say so plainly: 'this isn't covered — that's something the commish would need to rule on.'",
  "- Do NOT ask the owner what they think. They asked YOU.",
  "",
  "If the question is genuinely unclear, ask ONE specific clarifying question — don't guess.",
].join("\n");

const ANTHROPIC_MODEL = "claude-haiku-4-5-20251001";
const MAX_TOKENS = 500;

// Impact-analysis system prompt — different from the explainer. Used after
// an item is locked (grace window expired) to generate the discussion thread
// that posts to the rules channel.
const IMPACT_PROMPT = [
  "You are the UPS Salary Cap Dynasty League rules assistant. A vote just locked on a proposal. Generate a Discord thread post (markdown) that the league reads to understand what the outcome means.",
  "",
  "The post must contain ONLY these sections, in order, each with a bold header. NO other sections. NO 'Discussion prompt'. NO open questions back to the league.",
  "1. **What this rule does** — 1-2 sentences. Plain English.",
  "2. **What changed** — bullet list. For each existing rule that the new rule replaces/modifies, cite the OLD rule (specific values, formulas, dates from league context) and state precisely what's being replaced. If the rule was REJECTED, list what stays unchanged with the same specificity.",
  "3. **What stays the same** — bullet list. Related rules in the same area that were NOT affected. Be specific.",
  "",
  "Rules of writing:",
  "- Be specific. Reference exact dollar amounts, percentages, dates, formulas from the league context. Don't paraphrase vaguely.",
  "- Don't editorialize. Don't say 'great change!' or 'this is controversial.'",
  "- DO NOT invent rule details. Specifically: don't fabricate cadences (e.g. 'reset every 3-year cycle'), snapshot date ranges (e.g. 'current 2023–2025 snapshot only'), penalty formulas, or any quantitative claim that isn't explicitly written in the proposal text or league context. If you're unsure whether a numerical claim is grounded, omit it.",
  "- DO NOT add a 'Discussion prompt' or 'Open question' section. The thread itself is the discussion forum — owners drive the conversation.",
  "- If you don't know what an existing related rule says, say so plainly: 'the rulebook doesn't cover X' — don't invent.",
  "- Total length: ~200-350 words. Discord thread, mobile readers.",
  "- Use markdown bullets and bold for scanability.",
].join("\n");

export async function callExplain(env, { proposalTitle, proposalBody, question }) {
  const apiKey = String(env.ANTHROPIC_API_KEY || "").trim();
  if (!apiKey) {
    return {
      ok: false,
      answer: "🤖 The explain feature isn't configured yet — let the commish know.",
      error: "missing_anthropic_api_key",
    };
  }
  const trimmedQ = String(question || "").trim().slice(0, 1500);
  if (!trimmedQ) {
    return { ok: false, answer: "Need a question to answer — type something specific.", error: "empty_question" };
  }

  // Prompt-cache both the JSON rulebook and the canonical rules MD. Each is
  // its own cache block (Anthropic allows up to 4 cache markers). Proposal +
  // question are fresh tokens on every call.
  const messages = [
    {
      role: "user",
      content: [
        { type: "text", text: "=== League context (the comprehensive league rules — your single source of truth for current league mechanics) ===" },
        {
          type: "text",
          text: LEAGUE_CONTEXT_TEXT,
          cache_control: { type: "ephemeral" },
        },
        {
          type: "text",
          text: `=== Proposal currently up for vote (this is what's being CHANGED) ===\n\nTitle: ${String(proposalTitle || "")}\n\n${String(proposalBody || "")}`,
        },
        {
          type: "text",
          text: `=== Owner question ===\n\n${trimmedQ}\n\nAnswer per the system instructions. The league context above contains the answer to most factual rule questions — find it before hedging or punting to the commish.`,
        },
      ],
    },
  ];

  let res;
  try {
    res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: MAX_TOKENS,
        system: SYSTEM_PROMPT,
        messages,
      }),
    });
  } catch (e) {
    console.log(`[explain] fetch error: ${e?.message || e}`);
    return { ok: false, answer: "🤖 Couldn't reach the explainer service. Try again in a sec.", error: `fetch: ${e?.message || e}` };
  }

  const text = await res.text();
  if (!res.ok) {
    console.log(`[explain] HTTP ${res.status}: ${text.slice(0, 600)}`);
    return {
      ok: false,
      answer: `🤖 Explain service returned an error (HTTP ${res.status}). The commish will look at this.`,
      error: text.slice(0, 600),
    };
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch (_) {
    return { ok: false, answer: "🤖 Got a malformed response from the explain service.", error: "non_json" };
  }

  const answer = (data?.content || [])
    .filter((b) => b?.type === "text")
    .map((b) => String(b.text || ""))
    .join("\n")
    .trim();

  if (!answer) {
    return { ok: false, answer: "🤖 No answer generated. Try rephrasing the question.", error: "empty_answer" };
  }

  // Log token usage for cost visibility (cache hits are ~10% the cost of fresh).
  const u = data.usage || {};
  console.log(
    `[explain] OK · model=${ANTHROPIC_MODEL} · tokens in=${u.input_tokens || 0} ` +
      `(cache_read=${u.cache_read_input_tokens || 0}, cache_create=${u.cache_creation_input_tokens || 0}) ` +
      `out=${u.output_tokens || 0}`
  );

  return { ok: true, answer: answer.slice(0, 1900), usage: u };
}

// Generate a discussion-thread post analyzing the impact of a just-locked
// rule. Same grounding (league_context) as the explainer — different system
// prompt focused on rule-replacement specificity.
export async function callImpactAnalysis(env, { proposalTitle, proposalBody, finalOutcome, finalYes, finalNo, finalAbstain }) {
  const apiKey = String(env.ANTHROPIC_API_KEY || "").trim();
  if (!apiKey) {
    return { ok: false, text: "(impact analysis unavailable — ANTHROPIC_API_KEY not configured)" };
  }
  const verdict = finalOutcome === "passed" ? "PASSED" : finalOutcome === "rejected" ? "REJECTED" : "CLOSED";
  const tally = `${finalYes || 0} yes / ${finalNo || 0} no / ${finalAbstain || 0} abstain`;

  const messages = [
    {
      role: "user",
      content: [
        { type: "text", text: "=== League context (single source of truth for current league mechanics) ===" },
        { type: "text", text: LEAGUE_CONTEXT_TEXT, cache_control: { type: "ephemeral" } },
        {
          type: "text",
          text: `=== Proposal that just ${verdict} (final tally ${tally}) ===\n\nTitle: ${String(proposalTitle || "")}\n\n${String(proposalBody || "")}`,
        },
        {
          type: "text",
          text: `=== Task ===\n\nGenerate the discussion thread post per the system instructions. The proposal ${verdict} with a tally of ${tally}.`,
        },
      ],
    },
  ];

  // Retry once on 429 / 5xx with a short backoff. Anthropic occasionally
  // throttles when several calls land back-to-back during testing — a
  // single retry resolves most transient cases.
  let res;
  let lastText = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: ANTHROPIC_MODEL,
          max_tokens: 800,
          system: IMPACT_PROMPT,
          messages,
        }),
      });
    } catch (e) {
      console.log(`[impact] fetch error attempt ${attempt + 1}: ${e?.message || e}`);
      if (attempt === 0) { await new Promise((r) => setTimeout(r, 1500)); continue; }
      return { ok: false, transient: true, text: "(impact analysis fetch failed — see worker logs)" };
    }
    if (res.ok) break;
    lastText = await res.text();
    const transient = res.status === 429 || res.status >= 500;
    console.log(`[impact] HTTP ${res.status} attempt ${attempt + 1}: ${lastText.slice(0, 400)}`);
    if (!transient || attempt === 1) {
      return { ok: false, transient, text: `(impact analysis service error HTTP ${res.status})` };
    }
    // Sleep ~2s before retry. Anthropic 429s usually clear within a second.
    await new Promise((r) => setTimeout(r, 2000));
  }

  const text = await res.text();
  if (!res.ok) {
    console.log(`[impact] final non-OK HTTP ${res.status}: ${text.slice(0, 400)}`);
    return { ok: false, transient: res.status === 429 || res.status >= 500, text: `(impact analysis service error HTTP ${res.status})` };
  }
  let data;
  try { data = JSON.parse(text); } catch (_) { return { ok: false, text: "(non-json from anthropic)" }; }
  const out = (data?.content || []).filter((b) => b?.type === "text").map((b) => String(b.text || "")).join("\n").trim();
  if (!out) return { ok: false, text: "(empty impact analysis)" };
  const u = data.usage || {};
  console.log(`[impact] OK · in=${u.input_tokens || 0} (cache_read=${u.cache_read_input_tokens || 0}) out=${u.output_tokens || 0}`);
  return { ok: true, text: out.slice(0, 3800) };
}
