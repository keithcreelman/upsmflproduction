// Commissioner Desk: the HTTP layer. index.js calls handleDeskRoute() only AFTER the existing admin front door
// (exact-match route table + adminAuthority) AND the strict commissioner proof (commishSessionProven) have passed, and only for
// paths under /admin/commish-desk/. This file then:
//   1. builds the one frozen caller object (makeCommishCaller) from that proof;
//   2. checks the DESK_ENABLED switch (read through the feature-flag layer; unreadable flags mean OFF);
//   3. runs the pipeline, whose every tool call is authorized again in code (registry.runTool);
//   4. writes the question and the model-call ledger ONLY through store.js into the two desk tables.
// Nothing in here writes league data, posts to Discord, or calls MFL directly.

import { makeCommishCaller, DeskAuthError } from "./contract.js";
import { createStore, StoreError } from "./store.js";
import { guardedCall, getLimits, liveCallsAllowed } from "./budget.js";
import { createLiveClientFromEnv } from "./anthropic_client.js";
import { answerQuestion, DeskInputError } from "./pipeline.js";
import { buildKnowledge } from "./knowledge.js";
import { listTools } from "./registry.js";
import { isAsOf } from "./contract.js";
import leagueContextMd from "../../../docs/league_context_v1.md";   // the same bundled canon text anthropic_explain.js uses
import "./tools/index.js";   // registers the 14 Phase 1 tools (a side-effect import, in one reviewed place)

const MAX_BODY_BYTES = 8 * 1024;
const JSON_HEADERS = { "content-type": "application/json", "cache-control": "no-store" };

function out(status, body, extraHeaders) {
  return new Response(JSON.stringify(body), { status, headers: { ...JSON_HEADERS, ...(extraHeaders || {}) } });
}

async function readJson(request) {
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) return { error: "body_too_large" };
  try { const v = text ? JSON.parse(text) : {}; return v && typeof v === "object" && !Array.isArray(v) ? { value: v } : { error: "bad_json" }; }
  catch (_) { return { error: "bad_json" }; }
}

// Knowledge is rebuilt per isolate and cached: rules index (bundled), glossary, coverage matrix, the bundled canon digest.
// The digest of the canon text this Worker carries is ALWAYS computed before anything is cached (a /status call must never seed the cache with an
// unverified index). If it cannot be computed, the sentinel "unavailable" never equals the index's digest, so the rules tools fail closed (stale).
let knowledgeCache = null;
let canonDigestCache = null;
async function bundledCanonDigest(canonText) {
  if (canonDigestCache === null) {
    try { canonDigestCache = canonText ? (await sha256Hex(canonText)).slice(0, 12) : "unavailable"; } catch (_) { return "unavailable"; }
  }
  return canonDigestCache;
}
export async function loadKnowledge({ leagueId, season, canonText, rulesData }) {
  if (knowledgeCache && knowledgeCache.leagueId === String(leagueId) && knowledgeCache.currentSeason === Number(season)) return knowledgeCache;
  const data = rulesData || (await import("./data/rules_data.js")).default;
  const canonDigest = await bundledCanonDigest(canonText);
  knowledgeCache = buildKnowledge({ rulesJson: data, canonText: null, leagueId: String(leagueId), currentSeason: Number(season), calendar: {}, canonDigestBundled: canonDigest });
  return knowledgeCache;
}
export function _resetKnowledgeCacheForTests() { knowledgeCache = null; canonDigestCache = null; }

export async function sha256Hex(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(text)));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ctx: { request, url, env, path, proof:{ok,reason}, leagueId, season, canonText, deskEnabled:boolean, fetchSelf, now?:()=>Date, deps? }
export async function handleDeskRoute(ctx) {
  const { request, env, path, proof } = ctx;
  ctx = { ...ctx, canonText: String(leagueContextMd || "") };
  if (!proof || proof.ok !== true) return out(403, { ok: false, error: "commish_only" });
  const caller = makeCommishCaller(String(proof.reason || "").includes("apikey") ? "apikey" : "session");
  const method = request.method;
  const route = path.replace(/^\/admin\/commish-desk/, "") || "/";

  // The status route answers even when the desk is off so the page can decide whether to show its tab.
  if (route === "/status" && method === "GET") {
    const limits = getLimits(env);
    const live = liveCallsAllowed(env, ctx.deskEnabled === true);
    let rules = null;
    try { const k = await loadKnowledge(ctx); rules = { canon_sha7: k.rulesMeta && k.rulesMeta.canon_sha7, stale: !!(k.rulesMeta && k.rulesMeta.stale) }; } catch (_) { rules = { error: "knowledge_unavailable" }; }
    return out(200, {
      ok: true, enabled: !!ctx.deskEnabled, phase: "P1",
      live_model_enabled: !!live.allowed, live_blockers: live.reasons,
      budget: { per_question_usd: limits.perQuestionUsd, per_run_usd: limits.perRunUsd, monthly_usd: limits.monthlyUsd, total_usd: limits.totalUsd },
      tools: listTools().map((t) => t.id), rules,
    });
  }

  if (!ctx.deskEnabled) return out(403, { ok: false, error: "desk_disabled", message: "The Commissioner Desk is switched off (Kill Switches)." });
  if (!env.UPS_MFL_DB) return out(503, { ok: false, error: "not_ready", message: "Database binding missing." });
  const store = createStore(env.UPS_MFL_DB);

  try {
    if (route === "/history" && method === "GET") {
      const items = await store.listQuestions(caller, { limit: 50 });
      return out(200, { ok: true, items });
    }
    if (route === "/question" && method === "GET") {
      const id = String(new URL(request.url).searchParams.get("id") || "");
      if (!/^[A-Za-z0-9_-]{8,64}$/.test(id)) return out(400, { ok: false, error: "bad_id" });
      const item = await store.getQuestion(caller, id);
      if (!item) return out(404, { ok: false, error: "not_found" });
      return out(200, { ok: true, item });
    }
    if (route === "/report" && method === "POST") {
      const b = await readJson(request);
      if (b.error) return out(400, { ok: false, error: b.error });
      const id = String(b.value.id || ""), note = String(b.value.note || "").slice(0, 2000);
      if (!/^[A-Za-z0-9_-]{8,64}$/.test(id) || !note.trim()) return out(400, { ok: false, error: "bad_report" });
      const r = await store.reportProblem(caller, id, note);
      return r.ok ? out(200, { ok: true }) : out(r.reason === "not_found" ? 404 : 400, { ok: false, error: r.reason });
    }
    if (route === "/ask" && method === "POST") {
      const b = await readJson(request);
      if (b.error) return out(400, { ok: false, error: b.error });
      const question = String(b.value.question || "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").trim();
      const asOf = b.value.as_of == null || b.value.as_of === "" ? "current" : String(b.value.as_of);
      if (!question) return out(400, { ok: false, error: "empty_question" });
      if (question.length > 600) return out(400, { ok: false, error: "question_too_long" });
      if (!isAsOf(asOf)) return out(400, { ok: false, error: "bad_as_of" });

      const knowledge = await loadKnowledge(ctx);
      const requestId = crypto.randomUUID().replace(/-/g, "").slice(0, 24);
      const now = ctx.now || (() => new Date());
      const nowMs = () => Date.now();
      const liveClient = createLiveClientFromEnv(env, (u, i) => fetch(u, i));
      const client = liveClient || { mode: "live", complete: async () => { throw new Error("no_client"); } };
      const callModel = (req) => guardedCall({
        env, db: env.UPS_MFL_DB, caller, client, deskEnabled: !!ctx.deskEnabled,
        meta: { feature: "commish_desk", runId: requestId, questionId: requestId,   // one question is one run, so the per-run cap bounds the question's calls together
         step: req.step, promptHash: req.promptHash || null, canonSha: knowledge.rulesMeta && knowledge.rulesMeta.canon_sha7, toolIds: req.toolIds || [] },
        request: { model: req.model, system: req.system, messages: req.messages, tools: req.tools, tool_choice: req.tool_choice, max_tokens: req.max_tokens },
      });
      const t0 = nowMs();
      const result = await answerQuestion({ caller, question, asOf, requestId, deps: { callModel, fetchSelf: ctx.fetchSelf, now, nowMs, knowledge, audit: ctx.audit, ...(ctx.deps || {}) } });
      const card = result.card;
      await store.saveQuestion(caller, { id: requestId, question, asOf, state: card.state, card, costUsd: (card.footer && card.footer.cost_usd) || 0, durationMs: nowMs() - t0, toolCalls: (card.footer && card.footer.tools && card.footer.tools.length) || 0, canonSha: knowledge.rulesMeta && knowledge.rulesMeta.canon_sha7 });
      try { await store.purgeOlderThan(caller, 90); } catch (_) { /* retention is best effort and bounded */ }
      return out(200, { ok: true, request_id: requestId, card });
    }
    return out(404, { ok: false, error: "not_found" });
  } catch (e) {
    if (e instanceof DeskInputError) return out(e.status || 400, { ok: false, error: e.code || "bad_input" });
    if (e instanceof DeskAuthError) return out(403, { ok: false, error: "commish_only" });
    if (e instanceof StoreError) return out(503, { ok: false, error: e.code || "not_ready", message: "The desk's private tables are not ready (migrations 0180 and 0181 not applied)." });
    console.error("[desk] handler error:", e && e.message ? e.message : String(e));
    return out(500, { ok: false, error: "desk_error" });
  }
}
