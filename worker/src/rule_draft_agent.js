// rule_draft_agent.js — the AI drafting workbench behind the 📜 Rule Proposals
// tab. Keith brings a raw rule idea; this agent cleans it into the structured
// draft, asks HIM clarifying questions, challenges the idea against the league
// canon (§-cited), and answers research questions by running real read-only
// SQL against the league D1 ("how many QBs are starters during a season?").
//
// This is the FIRST Anthropic tool-use loop in this codebase — everything else
// is single-shot /v1/messages. The loop is implemented against the raw API:
// `tools` in the body, `stop_reason === "tool_use"`, reply with ONE user
// message whose content is tool_result blocks with matching tool_use_ids.
//
// Wedge-proofing is three independent layers (each covers a different death):
//   1. turn_started_at_utc in-flight guard with a 120s staleness expiry — a
//      crashed turn can never lock the session.
//   2. dangling-tool_use self-heal at turn load — a mid-loop death can never
//      corrupt the replay history (the API 400s on tool_use without a
//      following tool_result).
//   3. budget-exhaustion wrap-up call with tool_choice "none" — a tool-happy
//      model can never loop past the turn budget without producing a reply.
import leagueContextMd from "../../docs/league_context_v1.md";

const LEAGUE_CONTEXT_TEXT = String(leagueContextMd || "");

export const DRAFT_MODEL = "claude-opus-4-8"; // clapback precedent (discord_roast_reply.js)
export const DRAFT_FALLBACK_MODEL = "claude-sonnet-5"; // transient-failure fallback
const MAX_TOOL_ITERATIONS = 12; // Anthropic calls per turn, incl. the wrap-up
const TURN_BUDGET_MS = 100_000; // wall clock per turn
const PER_CALL_TIMEOUT_MS = 60_000;
const MAX_TOKENS = 8000;
const SQL_ROW_CAP = 200;
const SQL_RESULT_CHAR_CAP = 8000;
const HISTORY_TOKEN_BUDGET = 30_000; // est. chars/4 for the replay window
const TURN_STALE_MS = 120_000; // in-flight guard expiry

const safeStr = (v) => String(v == null ? "" : v).trim();
const nowIso = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
const newSessionId = () =>
  `rds-${Date.now().toString(36)}-${Math.floor(Math.random() * 0xffff).toString(16).padStart(4, "0")}`;

const EMPTY_DRAFT = {
  title: "", tldr: "", body_md: "", rationale_md: "", supporting_data_md: "",
  pass_yes_count: 7, deadline_utc: "", category: "rules",
};

// ── SQL guard ───────────────────────────────────────────────────────────
// Exported for the sql-test harness. SELECT/WITH first token is NOT enough:
// SQLite allows `WITH x AS (...) DELETE FROM ...`, so write/DDL keywords are
// rejected as whole words ANYWHERE, including inside string literals — that
// last part is a deliberate false-positive (fail closed; the tool description
// tells the model to avoid write-verbs in literals and it rewrites). The
// word boundary means `updated_at` / `created_at_utc` pass untouched: \b
// fails between the keyword and the following 'd'/'_'.
export function guardSql(raw) {
  let q = safeStr(raw).replace(/;+\s*$/, "");
  if (!q) return { error: "empty query" };
  if (q.includes(";")) return { error: "single statement only — no semicolons" };
  if (!/^\s*(select|with)\b/i.test(q)) return { error: "must start with SELECT or WITH" };
  const bad = q.match(/\b(insert|update|delete|drop|alter|create|replace|attach|detach|pragma|vacuum|reindex)\b/i);
  if (bad) return { error: `write/DDL keyword '${bad[1]}' not allowed` };
  if (!/\blimit\s+\d+/i.test(q)) q += ` LIMIT ${SQL_ROW_CAP}`;
  return { ok: true, query: q };
}

export async function runGuardedSql(env, rawQuery) {
  const g = guardSql(rawQuery);
  if (!g.ok) return { ok: false, error: g.error };
  try {
    const { results } = await env.UPS_MFL_DB.prepare(g.query).all();
    let rows = (results || []).slice(0, SQL_ROW_CAP);
    const total = (results || []).length;
    // Cap bytes BEFORE stringify-for-the-wire gets expensive: drop rows until
    // the serialized form fits. CPU is the metered resource on Workers.
    let text = JSON.stringify(rows);
    while (text.length > SQL_RESULT_CHAR_CAP && rows.length > 1) {
      rows = rows.slice(0, Math.max(1, Math.floor(rows.length / 2)));
      text = JSON.stringify(rows);
    }
    const truncated = rows.length < total;
    return {
      ok: true, rows,
      row_count: rows.length,
      note: truncated ? `[truncated: showing ${rows.length} of ${total} rows — aggregate in SQL instead]` : "",
      query_ran: g.query,
    };
  } catch (e) {
    return { ok: false, error: `sqlite: ${safeStr(e?.message || e)}` };
  }
}

// ── Tools ───────────────────────────────────────────────────────────────
// INVARIANT: this array must be byte-identical and same-order on every call
// in a loop, or the prompt cache invalidates (the cache prefix covers
// tools + system + canon).
const TOOLS = [
  {
    name: "list_tables",
    description: "List every table in the league D1 database (SQLite). Call describe_table before querying anything unfamiliar.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "describe_table",
    description: "Column names/types (PRAGMA table_info), total row count, and 3 sample rows for one table.",
    input_schema: {
      type: "object",
      properties: { table: { type: "string", description: "Exact table name from list_tables." } },
      required: ["table"],
    },
  },
  {
    name: "run_sql",
    description:
      "Run ONE read-only SELECT (or WITH...SELECT) against the league database. Single statement, no semicolons. " +
      `Results are capped at ${SQL_ROW_CAP} rows / ${SQL_RESULT_CHAR_CAP} chars — aggregate in SQL rather than paging raw rows. ` +
      "The guard rejects write/DDL keywords (insert, update, delete, drop, alter, create, replace, pragma, attach, vacuum) " +
      "as whole words ANYWHERE, including inside string literals — avoid such words in literals. " +
      "Always show the returned numbers to the commish in your reply.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "The SELECT statement." },
        purpose: { type: "string", description: "Short human-readable phrase shown live to the commish, e.g. 'counting distinct starting QBs per season'." },
      },
      required: ["query", "purpose"],
    },
  },
  {
    name: "update_draft",
    description:
      "Merge fields into the working proposal draft. Call this whenever your understanding firms up — the commish watches the draft " +
      "update live. body_md is the verbatim rule text the league votes on. Constraints: title <= 120 chars (must yield a slug), " +
      "tldr <= 240, pass_yes_count 1-12, deadline_utc ISO-8601 in the future, category defaults to 'rules'.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string" }, tldr: { type: "string" },
        body_md: { type: "string" }, rationale_md: { type: "string" },
        supporting_data_md: { type: "string" },
        pass_yes_count: { type: "integer" },
        deadline_utc: { type: "string" }, category: { type: "string" },
      },
    },
  },
  {
    name: "ask_commish",
    description:
      "Register the clarifying questions you need answered before the draft can be finalized. Also ask them in your reply prose. " +
      "These become the structured Q&A record that grounds the league bot after publish.",
    input_schema: {
      type: "object",
      properties: {
        questions: { type: "array", items: { type: "string" }, description: "1-5 direct questions." },
      },
      required: ["questions"],
    },
  },
];

// Frozen — NOTHING volatile (no dates, ids, draft state) or the cache dies.
const SYSTEM_PROMPT = `You are the drafting partner for the commissioner ("Keith") of the UPS Salary Cap Dynasty League.
He brings a raw rule idea; together you turn it into a publish-ready proposal. You are NOT a yes-man.

AUTHORITATIVE SOURCES
1. The league canon below — everything about how the league currently works.
2. The live league database via your SQL tools — actual historical facts and numbers.
Keith's answers in this conversation are authoritative for intent. Never fabricate rules or data.

YOUR JOB, IN ORDER
1. UNDERSTAND: restate the idea in one sentence. Ask clarifying questions (via ask_commish AND in prose)
   BEFORE polishing — scope, thresholds, timing, who it applies to, effective season.
2. CHALLENGE: scan the canon for conflicts, overlaps, and supersessions. Cite the specific canon
   section heading for every conflict. Hunt loopholes, edge cases (cap math, calendar timing,
   taxi/WW/tag interactions), and perverse incentives. Raise them even when unwelcome.
3. RESEARCH: when data would inform the decision, query it — describe_table before run_sql on
   unfamiliar tables; aggregate in SQL; show the real numbers in your reply and fold the durable
   ones into supporting_data_md. If the data does not exist, say so plainly.
4. DRAFT: maintain the structured draft with update_draft as understanding firms up. body_md is the
   verbatim rule text the league votes on — precise, self-contained, no dangling references.
   rationale_md tells the story; supporting_data_md carries the numbers.

DATABASE ORIENTATION (grains, key tables — discover the rest with list_tables/describe_table)
- src_weekly: one row per (season, week, player_id); status 'starter'|'bench'; score; pos_group;
  roster_franchise_id. THE table for lineup/usage questions ("how many QBs start in a season").
- src_pointssummary: per (season, player_id) aggregates incl. started_games/started_points/started_ppg.
- src_standings, src_trades, src_draft_picks: league history. ups_*: contracts, transactions,
  penalties, auction state. hall_proposals / hall_qa_log: governance history.

STYLE
- Lead with substance; keep replies scannable (Keith reads this in a narrow chat pane).
- Number your questions. Show query results as small markdown tables with the number that matters bolded.
- Never move to "polished" while open questions remain — say what is still blocking.`;

// ── D1 helpers ──────────────────────────────────────────────────────────
async function loadSession(env, sessionId) {
  return await env.UPS_MFL_DB.prepare(
    `SELECT * FROM hall_draft_sessions WHERE session_id = ?`
  ).bind(sessionId).first();
}
async function setSession(env, sessionId, fields) {
  const keys = Object.keys(fields);
  if (!keys.length) return;
  const sets = keys.map((k) => `${k} = ?`).join(", ");
  await env.UPS_MFL_DB.prepare(
    `UPDATE hall_draft_sessions SET ${sets}, updated_at_utc = ? WHERE session_id = ?`
  ).bind(...keys.map((k) => fields[k]), nowIso(), sessionId).run();
}
const setStatusText = (env, sessionId, text) =>
  setSession(env, sessionId, { status_text: safeStr(text).slice(0, 200) }).catch(() => {});

async function appendMessage(env, sessionId, role, content) {
  const row = await env.UPS_MFL_DB.prepare(
    `SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM hall_draft_messages WHERE session_id = ?`
  ).bind(sessionId).first();
  const seq = Number(row?.next || 1);
  await env.UPS_MFL_DB.prepare(
    `INSERT INTO hall_draft_messages (session_id, seq, role, content_json, created_at_utc)
     VALUES (?, ?, ?, ?, ?)`
  ).bind(sessionId, seq, role, JSON.stringify(content), nowIso()).run();
  return seq;
}
async function loadMessages(env, sessionId) {
  const { results } = await env.UPS_MFL_DB.prepare(
    `SELECT seq, role, content_json FROM hall_draft_messages WHERE session_id = ? ORDER BY seq`
  ).bind(sessionId).all();
  return (results || []).map((r) => {
    let content = null;
    try { content = JSON.parse(r.content_json); } catch (_) { content = String(r.content_json || ""); }
    return { seq: r.seq, role: r.role, content };
  });
}

// ── Anthropic call (retry-once, then fallback model) ────────────────────
async function callModel(env, model, body, remainingMs) {
  const apiKey = safeStr(env.ANTHROPIC_API_KEY);
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY missing");
  const timeout = Math.max(5_000, Math.min(PER_CALL_TIMEOUT_MS, remainingMs));
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ ...body, model }),
    signal: AbortSignal.timeout(timeout),
  });
  const text = await res.text();
  if (!res.ok) {
    const transient = [408, 429, 500, 502, 503, 529].includes(res.status);
    const err = new Error(`anthropic ${res.status}: ${text.slice(0, 300)}`);
    err.transient = transient;
    throw err;
  }
  return JSON.parse(text);
}

// ── Tool execution ──────────────────────────────────────────────────────
async function executeTool(env, sessionId, block, state) {
  const name = safeStr(block.name);
  const input = block.input || {};
  try {
    if (name === "list_tables") {
      await setStatusText(env, sessionId, "listing database tables…");
      const { results } = await env.UPS_MFL_DB.prepare(
        `SELECT name FROM sqlite_master WHERE type='table'
           AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf%' AND name NOT LIKE 'd1_%'
         ORDER BY name`
      ).all();
      return JSON.stringify((results || []).map((r) => r.name));
    }
    if (name === "describe_table") {
      const table = safeStr(input.table);
      await setStatusText(env, sessionId, `inspecting table ${table}…`);
      if (!/^[A-Za-z0-9_]+$/.test(table)) return { error: "invalid table name" };
      const exists = await env.UPS_MFL_DB.prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name = ?`
      ).bind(table).first();
      if (!exists) return { error: `no such table: ${table}` };
      const { results: cols } = await env.UPS_MFL_DB.prepare(`PRAGMA table_info("${table}")`).all();
      const cnt = await env.UPS_MFL_DB.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).first();
      const { results: sample } = await env.UPS_MFL_DB.prepare(`SELECT * FROM "${table}" LIMIT 3`).all();
      let text = JSON.stringify({ columns: cols, row_count: Number(cnt?.n || 0), sample });
      if (text.length > SQL_RESULT_CHAR_CAP) {
        text = JSON.stringify({ columns: cols, row_count: Number(cnt?.n || 0), sample: "(sample omitted — rows too wide)" });
      }
      return text;
    }
    if (name === "run_sql") {
      await setStatusText(env, sessionId, `querying: ${safeStr(input.purpose).slice(0, 120) || "the database"}…`);
      const r = await runGuardedSql(env, input.query);
      if (!r.ok) return { error: r.error };
      return JSON.stringify({ rows: r.rows, row_count: r.row_count, note: r.note || undefined });
    }
    if (name === "update_draft") {
      await setStatusText(env, sessionId, "updating the draft…");
      const allowed = ["title", "tldr", "body_md", "rationale_md", "supporting_data_md", "pass_yes_count", "deadline_utc", "category"];
      const merged = { ...state.draft };
      for (const k of allowed) {
        if (input[k] === undefined || input[k] === null) continue;
        merged[k] = k === "pass_yes_count"
          ? Math.min(12, Math.max(1, parseInt(input[k], 10) || 7))
          : String(input[k]);
      }
      if (safeStr(merged.title).length > 120) merged.title = safeStr(merged.title).slice(0, 120);
      if (safeStr(merged.tldr).length > 240) merged.tldr = safeStr(merged.tldr).slice(0, 240);
      state.draft = merged;
      // Persist immediately — the tab's mid-turn poll paints this live.
      await setSession(env, sessionId, { draft_json: JSON.stringify(merged) });
      return JSON.stringify({ ok: true, draft: merged });
    }
    if (name === "ask_commish") {
      const qs = Array.isArray(input.questions) ? input.questions.map((q) => safeStr(q)).filter(Boolean).slice(0, 5) : [];
      state.questions = qs;
      return "ok — ask these in your reply prose as well";
    }
    return { error: `unknown tool: ${name}` };
  } catch (e) {
    return { error: safeStr(e?.message || e) };
  }
}

// ── History window ──────────────────────────────────────────────────────
// Walk backward accumulating ~chars/4 until the budget, then extend the cut
// to the nearest plain 'user' row so a tool_result is never orphaned from
// its tool_use (the API 400s on that). Prior-turn thinking blocks are
// stripped (permitted for past turns; saves tokens). The synthetic first
// message re-anchors truncated context: draft_json carries every decision
// forward regardless of what the window drops.
function buildWindow(rows, draftJson, rawText) {
  let budget = HISTORY_TOKEN_BUDGET * 4; // chars
  let start = rows.length;
  for (let i = rows.length - 1; i >= 0; i--) {
    const len = JSON.stringify(rows[i].content).length;
    if (budget - len < 0 && start < rows.length) break;
    budget -= len;
    start = i;
  }
  while (start > 0 && rows[start].role !== "user") start--;
  const windowRows = rows.slice(start);

  const messages = [{
    role: "user",
    content: [{
      type: "text",
      text:
        "=== CURRENT DRAFT STATE (maintained via update_draft; reflects ALL prior decisions incl. truncated turns) ===\n" +
        safeStr(draftJson || "{}") +
        "\n=== RAW IDEA (the commish's original braindump) ===\n" +
        safeStr(rawText) +
        "\n=== CONVERSATION (recent window) ===",
    }],
  }];
  const lastIdx = windowRows.length - 1;
  for (let i = 0; i < windowRows.length; i++) {
    const r = windowRows[i];
    if (r.role === "user") {
      messages.push({ role: "user", content: typeof r.content === "string" ? r.content : r.content });
    } else if (r.role === "assistant") {
      let content = Array.isArray(r.content) ? r.content : [{ type: "text", text: String(r.content || "") }];
      // Strip thinking from PRIOR turns only — the current turn's blocks are
      // appended live in the loop, never through this path.
      if (i < lastIdx) content = content.filter((b) => b.type !== "thinking" && b.type !== "redacted_thinking");
      if (!content.length) continue;
      messages.push({ role: "assistant", content });
    } else if (r.role === "tool_result") {
      messages.push({ role: "user", content: Array.isArray(r.content) ? r.content : [] });
    }
  }
  return messages;
}

// Second cache breakpoint: ride the last content block of the last message so
// every loop iteration cache-reads everything the previous one wrote.
function markLastBlock(messages) {
  const clone = messages.map((m) => ({ ...m, content: Array.isArray(m.content) ? m.content.map((b) => ({ ...b })) : m.content }));
  const last = clone[clone.length - 1];
  if (last && Array.isArray(last.content) && last.content.length) {
    last.content[last.content.length - 1] = {
      ...last.content[last.content.length - 1],
      cache_control: { type: "ephemeral" },
    };
  }
  return clone;
}

// ── The turn ────────────────────────────────────────────────────────────
export async function runDraftTurn(env, sessionId, userText) {
  const t0 = Date.now();
  const session = await loadSession(env, sessionId);
  if (!session) return { ok: false, status: 404, error: "no such session" };
  if (session.status !== "draft") return { ok: false, status: 409, error: `session is ${session.status}` };
  if (session.turn_started_at_utc) {
    const age = Date.now() - Date.parse(session.turn_started_at_utc);
    if (Number.isFinite(age) && age < TURN_STALE_MS) {
      return { ok: false, status: 409, error: "turn_in_flight" };
    }
    // stale — a crashed turn; proceed (self-heal below repairs history)
  }
  await setSession(env, sessionId, { turn_started_at_utc: nowIso(), status_text: "reading your message…" });

  const state = {
    draft: (() => { try { return { ...EMPTY_DRAFT, ...JSON.parse(session.draft_json || "{}") }; } catch (_) { return { ...EMPTY_DRAFT }; } })(),
    questions: [],
  };
  let servingModel = DRAFT_MODEL;
  let calls = 0;
  let lastAssistantText = "";
  let usageTotals = { in: 0, out: 0, cache_read: 0 };

  try {
    // Self-heal: a prior crash can leave an assistant tool_use with no
    // tool_result — the API rejects that history outright.
    const existing = await loadMessages(env, sessionId);
    const last = existing[existing.length - 1];
    if (last && last.role === "assistant" && Array.isArray(last.content)) {
      const dangling = last.content.filter((b) => b.type === "tool_use");
      if (dangling.length) {
        await appendMessage(env, sessionId, "tool_result", dangling.map((b) => ({
          type: "tool_result", tool_use_id: b.id, is_error: true,
          content: "interrupted — worker restarted before this tool ran",
        })));
      }
    }

    if (safeStr(userText)) await appendMessage(env, sessionId, "user", safeStr(userText));

    // Live message array for THIS turn (window rebuilt once; the loop appends).
    const rows = await loadMessages(env, sessionId);
    const messages = buildWindow(rows, JSON.stringify(state.draft), session.raw_text);

    const baseBody = {
      max_tokens: MAX_TOKENS,
      thinking: { type: "adaptive" }, // Opus 4.8 runs WITHOUT thinking if omitted
      system: [
        { type: "text", text: SYSTEM_PROMPT },
        {
          type: "text",
          text: "=== LEAGUE CANON (league_context_v1.md) ===\n\n" + LEAGUE_CONTEXT_TEXT,
          cache_control: { type: "ephemeral" }, // breakpoint 1: tools+system+canon
        },
      ],
      tools: TOOLS,
    };

    let wrapUp = false;
    while (calls < MAX_TOOL_ITERATIONS) {
      const remaining = TURN_BUDGET_MS - (Date.now() - t0);
      if (remaining < 8_000) wrapUp = true;

      calls += 1;
      await setStatusText(env, sessionId, wrapUp ? "wrapping up…" : `thinking (call ${calls})…`);

      const body = {
        ...baseBody,
        messages: markLastBlock(messages),
        ...(wrapUp ? { tool_choice: { type: "none" }, max_tokens: 1500 } : {}),
      };

      let data;
      try {
        data = await callModel(env, servingModel, body, Math.max(8_000, remaining));
      } catch (e) {
        if (e.transient || e.name === "TimeoutError") {
          // Retry once on the primary; if THAT fails, fall back for the rest
          // of the turn (accepting the one-time cache re-write — caches are
          // model-scoped).
          try {
            data = await callModel(env, servingModel, body, 30_000);
          } catch (e2) {
            if (servingModel === DRAFT_MODEL) {
              servingModel = DRAFT_FALLBACK_MODEL;
              await setStatusText(env, sessionId, "primary model busy — switching to fallback…");
              data = await callModel(env, servingModel, body, 45_000);
            } else throw e2;
          }
        } else throw e;
      }

      const u = data.usage || {};
      usageTotals.in += Number(u.input_tokens || 0);
      usageTotals.out += Number(u.output_tokens || 0);
      usageTotals.cache_read += Number(u.cache_read_input_tokens || 0);
      console.log(`[draft-agent] ${sessionId} call ${calls} model=${servingModel} stop=${data.stop_reason} in=${u.input_tokens || 0} cache_read=${u.cache_read_input_tokens || 0} out=${u.output_tokens || 0}`);

      const content = Array.isArray(data.content) ? data.content : [];
      // Persist assistant content VERBATIM (thinking + tool_use included) —
      // required for exact same-turn replay.
      await appendMessage(env, sessionId, "assistant", content);
      messages.push({ role: "assistant", content });

      const texts = content.filter((b) => b.type === "text").map((b) => String(b.text || "")).join("\n").trim();
      if (texts) lastAssistantText = texts;

      if (data.stop_reason === "tool_use" && !wrapUp) {
        const toolBlocks = content.filter((b) => b.type === "tool_use");
        const results = [];
        for (const b of toolBlocks) {
          const out = await executeTool(env, sessionId, b, state);
          const isErr = out && typeof out === "object" && out.error;
          results.push({
            type: "tool_result", tool_use_id: b.id,
            ...(isErr ? { is_error: true, content: String(out.error) } : { content: typeof out === "string" ? out : JSON.stringify(out) }),
          });
        }
        // ALL results for one assistant turn go in ONE user message.
        await appendMessage(env, sessionId, "tool_result", results);
        messages.push({ role: "user", content: results });
        continue;
      }

      if (data.stop_reason === "max_tokens" && !wrapUp) {
        // Ran out mid-thought — one wrap-up pass to land the reply.
        wrapUp = true;
        messages.push({ role: "user", content: [{ type: "text", text: "You hit the length limit. Wrap up now: summarize findings so far and list your open questions." }] });
        await appendMessage(env, sessionId, "user", "You hit the length limit. Wrap up now: summarize findings so far and list your open questions.");
        continue;
      }

      break; // end_turn (or wrap-up reply, or refusal — surface what we have)
    }

    // Budget exhausted while the model still wanted tools and we never wrapped:
    // the loop cap was hit right after a tool_result — force one final reply.
    if (!lastAssistantText) {
      const body = {
        ...baseBody,
        messages: markLastBlock([...messages, { role: "user", content: [{ type: "text", text: "Wrap up now: summarize findings so far and list your open questions." }] }]),
        tool_choice: { type: "none" },
        max_tokens: 1500,
      };
      try {
        const data = await callModel(env, servingModel, body, 30_000);
        const content = Array.isArray(data.content) ? data.content : [];
        await appendMessage(env, sessionId, "user", "Wrap up now: summarize findings so far and list your open questions.");
        await appendMessage(env, sessionId, "assistant", content);
        lastAssistantText = content.filter((b) => b.type === "text").map((b) => String(b.text || "")).join("\n").trim();
      } catch (e) {
        lastAssistantText = "(the drafting model did not produce a reply this turn — try again)";
      }
    }

    await setSession(env, sessionId, {
      turn_started_at_utc: null,
      status_text: "idle",
      turn_count: Number(session.turn_count || 0) + 1,
      model: servingModel,
      draft_json: JSON.stringify(state.draft),
    });

    return {
      ok: true,
      session_id: sessionId,
      reply: lastAssistantText,
      draft: state.draft,
      questions: state.questions,
      calls,
      ms: Date.now() - t0,
      usage: usageTotals,
      model: servingModel,
    };
  } catch (e) {
    const msg = safeStr(e?.message || e).slice(0, 180);
    await setSession(env, sessionId, { turn_started_at_utc: null, status_text: `error: ${msg}` }).catch(() => {});
    console.log(`[draft-agent] ${sessionId} turn failed: ${msg}`);
    return { ok: false, status: 500, error: msg };
  }
}

// ── Session lifecycle ───────────────────────────────────────────────────
export async function startDraftSession(env, rawText) {
  const raw = safeStr(rawText);
  if (raw.length < 10) return { ok: false, status: 400, error: "give me at least a sentence of the idea" };
  const sessionId = newSessionId();
  const ts = nowIso();
  await env.UPS_MFL_DB.prepare(
    `INSERT INTO hall_draft_sessions
       (session_id, status, raw_text, draft_json, status_text, turn_count, created_at_utc, updated_at_utc)
     VALUES (?, 'draft', ?, ?, 'starting…', 0, ?, ?)`
  ).bind(sessionId, raw, JSON.stringify(EMPTY_DRAFT), ts, ts).run();
  const turn = await runDraftTurn(env, sessionId, raw);
  return { ...turn, session_id: sessionId };
}

// Display-shaped: user/assistant prose + tool activity as "🔍 <purpose>" lines.
export async function getDraftSession(env, sessionId) {
  const session = await loadSession(env, sessionId);
  if (!session) return { ok: false, status: 404, error: "no such session" };
  const rows = await loadMessages(env, sessionId);
  const messages = [];
  for (const r of rows) {
    if (r.role === "user") {
      const text = typeof r.content === "string" ? r.content
        : Array.isArray(r.content) ? r.content.filter((b) => b.type === "text").map((b) => b.text).join("\n") : "";
      if (text) messages.push({ seq: r.seq, role: "user", text });
    } else if (r.role === "assistant" && Array.isArray(r.content)) {
      const text = r.content.filter((b) => b.type === "text").map((b) => String(b.text || "")).join("\n").trim();
      const tools = r.content.filter((b) => b.type === "tool_use").map((b) => {
        if (b.name === "run_sql") return `🔍 ${safeStr(b.input?.purpose) || "querying the database"}`;
        if (b.name === "describe_table") return `🔍 inspecting ${safeStr(b.input?.table)}`;
        if (b.name === "list_tables") return "🔍 listing tables";
        if (b.name === "update_draft") return "✏️ updated the draft";
        if (b.name === "ask_commish") return "❓ logged clarifying questions";
        return `🔧 ${safeStr(b.name)}`;
      });
      if (text || tools.length) messages.push({ seq: r.seq, role: "assistant", text, tools });
    }
    // tool_result rows are internal — not displayed
  }
  let draft = { ...EMPTY_DRAFT };
  try { draft = { ...EMPTY_DRAFT, ...JSON.parse(session.draft_json || "{}") }; } catch (_) { /* keep default */ }
  return {
    ok: true,
    session: {
      session_id: session.session_id, status: session.status, status_text: session.status_text,
      turn_started_at_utc: session.turn_started_at_utc, model: session.model,
      turn_count: session.turn_count, created_at_utc: session.created_at_utc,
      updated_at_utc: session.updated_at_utc, proposal_id: session.proposal_id,
    },
    draft,
    messages,
  };
}

export async function listDraftSessions(env) {
  const { results } = await env.UPS_MFL_DB.prepare(
    `SELECT session_id, status, status_text, draft_json, turn_count, updated_at_utc
       FROM hall_draft_sessions ORDER BY updated_at_utc DESC LIMIT 15`
  ).all();
  return (results || []).map((r) => {
    let title = "";
    try { title = safeStr(JSON.parse(r.draft_json || "{}").title); } catch (_) { /* untitled */ }
    return {
      session_id: r.session_id, status: r.status, status_text: r.status_text,
      title: title || "(untitled)", turn_count: r.turn_count, updated_at_utc: r.updated_at_utc,
    };
  });
}

// ── Publish-time distiller ──────────────────────────────────────────────
// Raw chat is the wrong shape for grounding — fetchQaGrounding injects EVERY
// keith_ruling verbatim into every explain/synthesis prompt, so casual turns
// ("yeah sure, whatever") would pollute the bot's canon. One call extracts
// only the decided points as self-contained rulings. Parse failure writes
// NOTHING (fail-open — the manual ruling UI still exists; publish/voting is
// never blocked by this).
export async function finalizeDraftRulings(env, sessionId, proposalId) {
  const session = await loadSession(env, sessionId);
  if (!session) return { ok: false, error: "no such session" };
  const rows = await loadMessages(env, sessionId);
  const convo = [];
  for (const r of rows) {
    if (r.role === "user" && typeof r.content === "string") convo.push(`COMMISH: ${r.content}`);
    else if (r.role === "assistant" && Array.isArray(r.content)) {
      const text = r.content.filter((b) => b.type === "text").map((b) => String(b.text || "")).join("\n").trim();
      if (text) convo.push(`BOT: ${text}`);
    }
  }
  const body = {
    max_tokens: 2000,
    system: 'Extract the commissioner\'s authoritative clarifications about this rule proposal as standalone rulings. Output strict JSON: [{"question":"…","ruling":"…"}]. Each ruling must be a complete, self-contained statement understandable without the conversation. Only include points the commissioner actually decided — not the bot\'s suggestions, not open questions. Max 10. Output [] if none. No prose, no fences.',
    messages: [{
      role: "user",
      content: [
        { type: "text", text: `=== FINAL DRAFT ===\n${session.draft_json || "{}"}` },
        { type: "text", text: `=== DRAFTING CONVERSATION ===\n${convo.join("\n\n").slice(0, 60_000)}` },
      ],
    }],
  };
  try {
    const data = await callModel(env, DRAFT_MODEL, body, 60_000);
    const out = (data.content || []).filter((b) => b.type === "text").map((b) => String(b.text || "")).join("\n").trim();
    const m = out.match(/\[[\s\S]*\]/);
    const pairs = JSON.parse(m ? m[0] : out);
    if (!Array.isArray(pairs)) throw new Error("not an array");
    const ts = nowIso();
    let written = 0;
    for (const p of pairs.slice(0, 10)) {
      const q = safeStr(p?.question);
      const ruling = safeStr(p?.ruling);
      if (!ruling) continue;
      await env.UPS_MFL_DB.prepare(
        `INSERT INTO hall_qa_log
           (proposal_id, round_id, display_name, kind, question_text, keith_ruling, source, created_at_utc)
         VALUES (?, (SELECT round_id FROM discord_round_items WHERE proposal_id = ? ORDER BY rowid DESC LIMIT 1),
                 'commish', 'keith_ruling', ?, ?, 'tab', ?)`
      ).bind(proposalId, proposalId, q || null, `[from drafting session] ${ruling}`, ts).run();
      written += 1;
    }
    console.log(`[draft-agent] distilled ${written} ruling(s) from ${sessionId} into ${proposalId}`);
    return { ok: true, rulings: written };
  } catch (e) {
    console.log(`[draft-agent] distillation failed for ${sessionId} (non-fatal): ${safeStr(e?.message || e)}`);
    return { ok: false, error: safeStr(e?.message || e) };
  }
}
