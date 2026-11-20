// Commissioner Desk: the tool registry and the ONLY way a tool runs.
//
// Authorization is enforced HERE, in code, on every call. Nothing the model says can widen it:
//   1. the caller must be the proven commissioner (assertCommishCaller: a caller object minted by contract.js, checked on every call);
//   2. the tool must be registered, and its arguments must match its input schema exactly (no extra keys);
//   3. as_of is mandatory; a tool that cannot honor it answers "unsupported_as_of", never today's data;
//   4. a tool receives NO env, NO database handle and NO credentials. Its only capabilities are `routeGet`
//      (GET-only, exact-path allowlist, per-route parameter allowlist, redirects refused, no cookies, size and time limits)
//      and a deep-frozen read-only `knowledge` object. A tool therefore cannot write, and cannot reach a route it did not declare;
//   5. everything a tool returns is cut down to its declared output allowlist, bounded, stripped of secret-looking keys at any
//      depth (data, provenance, freshness, gaps, refusal and error alike), class-checked against the caller's ceiling, and
//      fact ids are namespaced per call.
//
// runTool NEVER throws and never rejects: every failure becomes an envelope with status "forbidden" or "error".

import {
  assertCommishCaller, classAllowed, isAsOf, isFactId, isSecretKey, isUnsafeKey, isPlainRoutePath, freezeDeep,
  GRADES, FACT_UNITS, TOOL_STATUSES, GAP_REASONS, REFUSAL_CODES, FORBIDDEN_ROUTE_PATTERNS, DATA_CLASS_RANK, DeskAuthError,
} from "./contract.js";

export const MAX_OUTPUT_BYTES = 60 * 1024;
export const ROUTE_TIMEOUT_MS = 8000;
export const TOOL_TIMEOUT_MS = 12000;
export const ROUTE_MAX_BYTES = 2 * 1024 * 1024;
export const MAX_ROUTE_CALLS = 6;
export const MAX_FACTS = 200;
export const MAX_GAPS = 20;
const MAX_STRING = 2000;
const MAX_DEPTH = 10;
const MAX_KEYS = 80;
const MAX_ARRAY = 400;
const SELF_ORIGIN = "https://self.invalid";

const REGISTRY = new Map();
const FROZEN_KNOWLEDGE = new WeakSet();

// ── Definition ─────────────────────────────────────────────────────────────────────────────────
// def = {
//   id, version, description, phase: "P1", dataClass: "P0"|"P2", readOnly: true,
//   inputSchema: { type:"object", properties:{ name:{type,enum,pattern,maxLength,minimum,maximum} }, required:[...] },   // as_of is added by the registry
//   asOf: { supports: "current" | "season" | "any", from?: <first season>, check?: (asOf, ctx) => null | {what, source_needed} },
//   allowlist: { routes: [{ path: "/api/standings", params: ["L","YEAR"] }], modules: ["cap_math.js"], tables: [] },
//   output: { allow: ["standings[].franchise_id", ...] },       // REQUIRED, non-empty: dotted paths relative to `data`; "[]" walks arrays
//   run: async ({ args, asOf, caller, now, routeGet, knowledge }) => ({ status, data, facts, coverage, provenance, freshness, refusal, error })
// }
export function defineTool(def) {
  const problems = [];
  if (!def || typeof def !== "object") throw new Error("defineTool: no definition");
  if (typeof def.id !== "string" || !/^[a-z]+(\.[a-z_]+)+$/.test(def.id)) problems.push("id must look like 'cap.position'");
  if (REGISTRY.has(def.id)) problems.push(`duplicate tool id ${def.id}`);
  if (def.readOnly !== true) problems.push("readOnly must be true");
  if (!["P0", "P2"].includes(def.dataClass)) problems.push("dataClass must be P0 or P2 (P1 and P3 are never desk tool classes)");
  if (def.phase !== "P1") problems.push("phase must be P1");
  if (typeof def.version !== "string") problems.push("version required");
  if (typeof def.description !== "string" || def.description.length < 20) problems.push("description required");
  if (typeof def.run !== "function") problems.push("run required");
  if (!def.inputSchema || def.inputSchema.type !== "object" || !def.inputSchema.properties || typeof def.inputSchema.properties !== "object") problems.push("inputSchema required");
  if (def.inputSchema && def.inputSchema.properties && Object.prototype.hasOwnProperty.call(def.inputSchema.properties, "as_of")) problems.push("as_of is added by the registry; do not declare it");
  if (!def.asOf || !["current", "season", "any"].includes(def.asOf.supports)) problems.push("asOf.supports must be current|season|any");
  if (!def.output || !Array.isArray(def.output.allow) || def.output.allow.length === 0 || def.output.allow.some((p) => typeof p !== "string" || !p)) problems.push("output.allow must be a non-empty array of dotted paths (every tool declares exactly what it may return)");
  const al = def.allowlist;
  if (!al || !Array.isArray(al.routes) || !Array.isArray(al.modules) || !Array.isArray(al.tables)) problems.push("allowlist.{routes,modules,tables} arrays required");
  if (al && Array.isArray(al.tables) && al.tables.length) problems.push("desk tools may not read tables directly; use a route or a module");
  for (const r of (al && al.routes) || []) {
    if (!r || typeof r.path !== "string" || !Array.isArray(r.params)) { problems.push(`bad route allowlist entry ${JSON.stringify(r)}`); continue; }
    if (!isPlainRoutePath(r.path)) problems.push(`route ${r.path}: not a plain path (letters, digits, - _ . / only; no .., //, %, query)`);
    if (r.method && r.method !== "GET") problems.push(`route ${r.path}: only GET is allowed`);
    if (FORBIDDEN_ROUTE_PATTERNS.some((re) => re.test(r.path))) problems.push(`route ${r.path} matches a forbidden pattern`);
    if (r.params.some((p) => typeof p !== "string" || !/^[A-Za-z_][A-Za-z0-9_]{0,40}$/.test(p))) problems.push(`route ${r.path}: bad parameter name`);
  }
  if (problems.length) throw new Error(`defineTool(${def && def.id}): ${problems.join("; ")}`);
  // Deep-freeze everything declarative so nothing can widen an allowlist after registration.
  const frozen = freezeDeep({
    ...def,
    inputSchema: JSON.parse(JSON.stringify(def.inputSchema)),
    asOf: { ...def.asOf },
    allowlist: { routes: al.routes.map((r) => ({ path: r.path, params: [...r.params] })), modules: [...al.modules], tables: [] },
    output: { allow: [...def.output.allow] },
  });
  REGISTRY.set(def.id, frozen);
  return frozen;
}

export function listTools() { return [...REGISTRY.values()]; }
export function getTool(id) { return REGISTRY.get(id) || null; }
export function _resetRegistryForTests() { REGISTRY.clear(); }

// Model-facing tool descriptions (what the router/loop sends to the model). No allowlists, no internals.
export function toolSpecsForModel() {
  return listTools().map((t) => ({
    name: t.id.replace(/\./g, "__"),
    description: t.description,
    input_schema: {
      type: "object",
      properties: { ...t.inputSchema.properties, as_of: { type: "string", description: "current, or an ISO date YYYY-MM-DD. Required." } },
      required: [...new Set([...(t.inputSchema.required || []), "as_of"])],
      additionalProperties: false,
    },
  }));
}
export function toolIdFromModelName(name) { return String(name || "").replace(/__/g, "."); }

const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

// ── Argument validation (a deliberately small JSON-schema subset) ──────────────────────────────
export function validateArgs(tool, rawArgs) {
  const schema = tool.inputSchema;
  const args = rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs) ? rawArgs : null;
  if (!args) return { ok: false, error: "arguments must be an object" };
  const props = { ...schema.properties, as_of: { type: "string" } };
  const out = {};
  for (const k of Object.keys(args)) if (!has(props, k)) return { ok: false, error: `unknown argument '${String(k).slice(0, 40)}'` };
  for (const k of [...(schema.required || []), "as_of"]) if (!has(args, k) || args[k] === undefined || args[k] === null || args[k] === "") return { ok: false, error: `missing argument '${k}'` };
  if (!isAsOf(args.as_of)) return { ok: false, error: "as_of must be 'current' or YYYY-MM-DD" };
  for (const [k, spec] of Object.entries(props)) {
    if (!has(args, k) || args[k] === undefined) continue;
    const v = args[k];
    if (k === "as_of") { out[k] = v; continue; }
    if (spec.type === "string") {
      if (typeof v !== "string") return { ok: false, error: `'${k}' must be a string` };
      if (v.length > (spec.maxLength || 200)) return { ok: false, error: `'${k}' too long` };
      if (spec.pattern && !new RegExp(spec.pattern).test(v)) return { ok: false, error: `'${k}' has the wrong format` };
      if (spec.enum && !spec.enum.includes(v)) return { ok: false, error: `'${k}' must be one of ${spec.enum.join("|")}` };
    } else if (spec.type === "integer") {
      if (!Number.isInteger(v)) return { ok: false, error: `'${k}' must be an integer` };
      if (spec.minimum != null && v < spec.minimum) return { ok: false, error: `'${k}' below minimum` };
      if (spec.maximum != null && v > spec.maximum) return { ok: false, error: `'${k}' above maximum` };
    } else if (spec.type === "number") {
      if (typeof v !== "number" || !Number.isFinite(v)) return { ok: false, error: `'${k}' must be a number` };
      if (spec.minimum != null && v < spec.minimum) return { ok: false, error: `'${k}' below minimum` };
      if (spec.maximum != null && v > spec.maximum) return { ok: false, error: `'${k}' above maximum` };
    } else if (spec.type === "boolean") {
      if (typeof v !== "boolean") return { ok: false, error: `'${k}' must be a boolean` };
    } else return { ok: false, error: `schema type for '${k}' is not supported` };
    out[k] = v;
  }
  return { ok: true, args: out };
}

// ── The only network capability a tool has ─────────────────────────────────────────────────────
// deps.fetchSelf(urlString, { redirect: "manual", signal }) -> Response. In production this is env.SELF.fetch (see handler); in tests it is
// the real worker handler with a faked MFL. It is given a bare URL plus those two options and nothing else: no headers, no cookies, no
// method, no body. A redirect answer is an error (a redirect could leave the allowlisted path).
function makeRouteGet(tool, deps, audit) {
  const allowed = new Map(tool.allowlist.routes.map((r) => [r.path, new Set(r.params)]));
  let calls = 0;
  return async function routeGet(path, params) {
    calls += 1;
    if (audit.dead) throw routeError("route_after_timeout", path);
    if (calls > MAX_ROUTE_CALLS) throw routeError("too_many_route_calls", path);
    if (typeof path !== "string" || !allowed.has(path)) throw routeError("route_not_allowlisted", path);
    if (!isPlainRoutePath(path) || FORBIDDEN_ROUTE_PATTERNS.some((re) => re.test(path))) throw routeError("route_forbidden", path);
    const okParams = allowed.get(path);
    const u = new URL(path, SELF_ORIGIN);
    for (const [k, v] of Object.entries(params || {})) {
      if (v === undefined || v === null) continue;
      if (!okParams.has(k)) throw routeError("param_not_allowlisted", `${path}?${k}`);
      const s = String(v);
      if (s.length > 200 || /[\u0000-\u001f]/.test(s)) throw routeError("param_value_rejected", `${path}?${k}`);
      u.searchParams.set(k, s);
    }
    if (u.origin !== SELF_ORIGIN || u.pathname !== path) throw routeError("route_url_rewritten", path);
    if (typeof deps.fetchSelf !== "function") throw routeError("no_fetch_self", path);
    const t0 = deps.nowMs();
    const ctl = typeof AbortController !== "undefined" ? new AbortController() : null;
    const timer = ctl ? setTimeout(() => ctl.abort(), ROUTE_TIMEOUT_MS) : null;
    let res;
    try { res = await deps.fetchSelf(u.toString(), { redirect: "manual", ...(ctl ? { signal: ctl.signal } : {}) }); }
    catch (e) { throw routeError(ctl && ctl.signal.aborted ? "route_timeout" : "route_unreachable", path); }
    finally { if (timer) clearTimeout(timer); }
    if (!res || typeof res.status !== "number") throw routeError("route_bad_response", path);
    if (res.status >= 300 && res.status < 400) throw routeError("route_redirect_refused", path);
    const text = await res.text();
    if (text.length > ROUTE_MAX_BYTES) throw routeError("route_response_too_large", path);
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch (_) { json = null; }
    audit.routes.push({ path, status: res.status, ms: deps.nowMs() - t0 });
    return { status: res.status, ok: res.status >= 200 && res.status < 300, json, text };
  };
}
const ROUTE_ERROR_CODES = new Set(["too_many_route_calls", "route_not_allowlisted", "route_forbidden", "param_not_allowlisted", "param_value_rejected", "route_url_rewritten",
  "no_fetch_self", "route_timeout", "route_unreachable", "route_bad_response", "route_redirect_refused", "route_response_too_large", "route_after_timeout"]);
function routeError(code, detail) { const e = new Error(`${code}: ${String(detail).slice(0, 80)}`); e.deskCode = code; return e; }

// ── Output projection and bounding ─────────────────────────────────────────────────────────────
// Dotted allowlist paths: "standings[].franchise_id", "totals.cap_used". "[]" walks every element of an array.
function compileAllow(paths) {
  const root = Object.create(null);
  for (const p of paths) {
    let node = root;
    for (const seg of p.split(".")) {
      const arr = seg.endsWith("[]"); const key = arr ? seg.slice(0, -2) : seg;
      if (!key || isUnsafeKey(key)) continue;
      node[key] = node[key] || { children: Object.create(null), arr: false };
      if (arr) node[key].arr = true;
      node = node[key].children;
    }
  }
  return root;
}
function project(value, allowNode) {
  if (Array.isArray(value)) return value.map((v) => project(v, allowNode));
  if (!value || typeof value !== "object") return value;
  const out = {};
  for (const [k, sub] of Object.entries(allowNode)) {
    if (!has(value, k)) continue;
    const kids = sub.children;
    out[k] = Object.keys(kids).length ? project(value[k], kids) : value[k];
  }
  return out;
}
// A bounded, safe deep copy: depth, key and array limits (so a circular structure cannot recurse forever), secret-looking keys dropped at
// any depth, prototype keys dropped, BigInt/function/symbol flattened, strings truncated.
function sanitize(value, counter, depth) {
  const d = depth || 0;
  if (value === null || value === undefined) return value === undefined ? null : null;
  const t = typeof value;
  if (t === "string") { if (value.length > MAX_STRING) { counter.truncated += 1; return value.slice(0, MAX_STRING); } return value; }
  if (t === "number") return Number.isFinite(value) ? value : null;
  if (t === "boolean") return value;
  if (t === "bigint") return String(value);
  if (t !== "object") return null;
  if (d >= MAX_DEPTH) { counter.truncated += 1; return null; }
  if (Array.isArray(value)) {
    if (value.length > MAX_ARRAY) counter.truncated += 1;
    return value.slice(0, MAX_ARRAY).map((v) => sanitize(v, counter, d + 1));
  }
  const out = {};
  let n = 0;
  for (const k of Object.keys(value)) {
    if (isUnsafeKey(k)) { counter.n += 1; continue; }
    if (isSecretKey(k)) { counter.n += 1; continue; }
    if (++n > MAX_KEYS) { counter.truncated += 1; break; }
    out[k] = sanitize(value[k], counter, d + 1);
  }
  return out;
}
function byteLength(v) { try { return new TextEncoder().encode(JSON.stringify(v)).length; } catch (_) { return Infinity; } }

// ── Envelope ────────────────────────────────────────────────────────────────────────────────────
export function envelope(partial) {
  return {
    tool: String(partial.tool == null ? "" : partial.tool).slice(0, 64), call_id: partial.call_id || null, status: partial.status, data: partial.data == null ? null : partial.data,
    facts: partial.facts || [], coverage: partial.coverage || { supported: partial.status === "ok", gaps: [] },
    provenance: partial.provenance || {}, data_class: partial.data_class || "P0", freshness: partial.freshness == null ? null : partial.freshness,
    refusal: partial.refusal || null, error: partial.error || null,
  };
}
function fail(toolId, callId, status, code, message) {
  return envelope({ tool: toolId, call_id: callId, status, error: { code: String(code).slice(0, 64), message: String(message || code).slice(0, 200) }, coverage: { supported: false, gaps: [] } });
}

function withTimeout(promise, ms, code) {
  let t;
  const timeout = new Promise((_, rej) => { t = setTimeout(() => rej(Object.assign(new Error(code), { deskCode: code })), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}

function normalizeGaps(gaps) {
  if (!Array.isArray(gaps)) return { error: "gaps must be an array" };
  if (gaps.length > MAX_GAPS) return { error: "too many gaps" };
  const out = [];
  for (const g of gaps) {
    if (!g || typeof g !== "object") return { error: "bad gap" };
    const why = String(g.why || "");
    if (!GAP_REASONS.includes(why)) return { error: `bad gap reason ${why.slice(0, 30)}` };
    out.push({ what: String(g.what == null ? "" : g.what).slice(0, 300), why, source_needed: String(g.source_needed == null ? "" : g.source_needed).slice(0, 300) });
  }
  return { gaps: out };
}

function ensureDeepFrozen(k) {
  if (!k || typeof k !== "object") return {};
  if (!FROZEN_KNOWLEDGE.has(k)) { freezeDeep(k); FROZEN_KNOWLEDGE.add(k); }
  return k;
}

// ── runTool ─────────────────────────────────────────────────────────────────────────────────────
// ctx = { caller, callSeq }       caller from makeCommishCaller. callSeq: 1-based number of this tool call in the question.
// deps = { fetchSelf, now: () => Date, nowMs: () => number, knowledge, audit?: (entry) => void }
export async function runTool(ctx, toolId, rawArgs, deps) {
  let safeId = "", callId = "c1", clock = () => Date.now(), started = 0;
  try {
    callId = `c${Math.min(999, Math.max(1, Math.floor(Number(ctx && ctx.callSeq)) || 1))}`;
    safeId = typeof toolId === "string" ? toolId.slice(0, 64) : "";
    clock = deps && typeof deps.nowMs === "function" ? deps.nowMs : () => Date.now();
    started = clock();
    const entry = { tool: safeId, call_id: callId, routes: [], status: null, ms: 0, dead: false };
    const done = (env) => {
      entry.status = env.status; entry.ms = clock() - started;
      try { deps && deps.audit && deps.audit({ tool: entry.tool, call_id: entry.call_id, routes: entry.routes, status: entry.status, ms: entry.ms }); } catch (_) { /* audit must never break a tool */ }
      return env;
    };
    try {
      return await runToolInner(ctx, toolId, safeId, callId, rawArgs, deps, entry, done);
    } catch (e) {
      return done(fail(safeId, callId, "error", "tool_exception", "the tool failed"));
    }
  } catch (e) {
    return fail(safeId, callId, "error", "tool_exception", "the tool failed");
  }
}

async function runToolInner(ctx, toolId, safeId, callId, rawArgs, deps, auditEntry, done) {
  try { assertCommishCaller(ctx && ctx.caller); }
  catch (e) { return done(fail(safeId, callId, "forbidden", "not_commissioner", e instanceof DeskAuthError ? e.reason : "authorization failed")); }
  if (!deps || typeof deps !== "object") return done(fail(safeId, callId, "error", "no_deps", "tool dependencies missing"));
  if (typeof deps.nowMs !== "function") deps = { ...deps, nowMs: () => Date.now() };

  const tool = typeof toolId === "string" ? REGISTRY.get(toolId) : null;
  if (!tool) return done(fail(safeId, callId, "forbidden", "unknown_tool", `no such tool: ${safeId.slice(0, 60)}`));
  if (!classAllowed(ctx.caller.ceiling, tool.dataClass)) return done(fail(safeId, callId, "forbidden", "data_class_exceeded", `tool class ${tool.dataClass} exceeds the caller ceiling`));

  const v = validateArgs(tool, rawArgs);
  if (!v.ok) return done(fail(safeId, callId, "error", "bad_arguments", v.error));
  const args = v.args;
  const gapEnv = (gap) => done(envelope({ tool: safeId, call_id: callId, status: "unsupported_as_of", data_class: tool.dataClass, coverage: { supported: false, gaps: [{ ...gap, why: "unsupported_as_of" }] } }));

  // as_of: current-only tools refuse any past date; season tools refuse dates before their first covered season or in the future.
  const asOf = args.as_of;
  const now = deps.now ? deps.now() : new Date();
  const supports = tool.asOf.supports;
  const currentSeason = Number(deps.knowledge && deps.knowledge.currentSeason) || now.getUTCFullYear();
  if (supports === "current" && asOf !== "current") {
    return gapEnv({ what: `${safeId} answers for the current state only`, source_needed: "a dated record of this state" });
  }
  if (supports === "season" && asOf !== "current") {
    const season = Number(asOf.slice(0, 4));
    const first = tool.asOf.from || 0;
    if (season < first) return gapEnv({ what: `${safeId} has no data before ${first}`, source_needed: "an archive for that season" });
    if (season > currentSeason) return gapEnv({ what: "that date is in the future", source_needed: "none (future date)" });
  }
  if (typeof tool.asOf.check === "function") {
    let why = null;
    try { why = tool.asOf.check(asOf, { currentSeason }); } catch (_) { return done(fail(safeId, callId, "error", "as_of_check_failed", "the date check failed")); }
    if (why) return gapEnv({ what: String(why.what || `${safeId} cannot answer for ${asOf}`).slice(0, 300), source_needed: String(why.source_needed || "a dated record").slice(0, 300) });
  }

  // Run with capabilities only.
  let raw;
  try {
    raw = await withTimeout(Promise.resolve(tool.run({
      args, asOf, caller: ctx.caller, now,
      routeGet: makeRouteGet(tool, deps, auditEntry), knowledge: ensureDeepFrozen(deps.knowledge),
    })), TOOL_TIMEOUT_MS, "tool_timeout");
  } catch (e) {
    auditEntry.dead = true;   // a tool that timed out may not start another route call
    const code = (e && typeof e.deskCode === "string" && /^[a-z_]{3,48}$/.test(e.deskCode)) ? e.deskCode : "tool_exception";
    // Only the registry's own codes may show a message; a tool that tags some other error (a database error, say) gets the generic text.
    const own = ROUTE_ERROR_CODES.has(code) || code === "tool_timeout";
    return done(fail(safeId, callId, "error", own ? code : "tool_exception", own ? String(e.message || code).slice(0, 160) : "the tool failed"));
  }
  if (!raw || typeof raw !== "object") return done(fail(safeId, callId, "error", "bad_tool_output", "tool returned nothing"));
  if (!TOOL_STATUSES.includes(raw.status) || raw.status === "forbidden") return done(fail(safeId, callId, "error", "bad_tool_status", String(raw.status).slice(0, 30)));

  // Project to the declared allowlist, then bound and strip every part of the result.
  const counter = { n: 0, truncated: 0 };
  let data = raw.data == null ? null : raw.data;
  if (data != null) {
    try { data = project(data, compileAllow(tool.output.allow)); data = sanitize(data, counter, 0); }
    catch (_) { return done(fail(safeId, callId, "error", "bad_tool_output", "the result could not be read safely")); }
  }
  const provenance = sanitize(raw.provenance && typeof raw.provenance === "object" ? raw.provenance : {}, counter, 0);
  let freshness = raw.freshness == null ? null : sanitize(raw.freshness, counter, 0);
  if (freshness !== null && typeof freshness === "object" && byteLength(freshness) > 2048) freshness = null;

  // Facts: validate, bound, namespace.
  if (raw.facts != null && !Array.isArray(raw.facts)) return done(fail(safeId, callId, "error", "bad_fact", "facts must be an array"));
  const rawFacts = raw.facts || [];
  if (rawFacts.length > MAX_FACTS) return done(fail(safeId, callId, "error", "too_many_facts", "too many facts"));
  const facts = [];
  const seen = new Set();
  for (const f of rawFacts) {
    const key = f && f.key;
    const id = `${callId}.${key}`;
    if (typeof key !== "string" || !isFactId(id) || seen.has(id)) return done(fail(safeId, callId, "error", "bad_fact", `invalid fact key ${String(key).slice(0, 40)}`));
    if (!FACT_UNITS.includes(f.unit)) return done(fail(safeId, callId, "error", "bad_fact", `bad unit on ${key}`));
    if (!GRADES.includes(f.grade)) return done(fail(safeId, callId, "error", "bad_fact", `bad grade on ${key}`));
    const val = f.value;
    const okVal = (typeof val === "string" && val.length <= 400) || (typeof val === "number" && Number.isFinite(val)) || typeof val === "boolean";
    if (!okVal) return done(fail(safeId, callId, "error", "bad_fact", `bad value on ${key}`));
    seen.add(id);
    facts.push({ id, label: String(f.label || key).slice(0, 120), value: val, unit: f.unit, as_of: String(f.as_of || asOf).slice(0, 20), source: String(f.source || tool.id).slice(0, 160), grade: f.grade });
  }
  if (raw.status !== "ok" && facts.length) return done(fail(safeId, callId, "error", "facts_on_non_ok", "a refused or empty result may not carry facts"));

  const dataClass = (raw.data_class === undefined || raw.data_class === null || raw.data_class === "") ? tool.dataClass : raw.data_class;
  if (typeof dataClass !== "string" || DATA_CLASS_RANK[dataClass] == null || DATA_CLASS_RANK[dataClass] > DATA_CLASS_RANK[tool.dataClass] || !classAllowed(ctx.caller.ceiling, dataClass)) {
    return done(fail(safeId, callId, "forbidden", "data_class_exceeded", "result class exceeds the tool or caller ceiling"));
  }

  // Coverage, refusal, error: fixed shapes only.
  let coverage;
  if (raw.coverage && typeof raw.coverage === "object") {
    const g = normalizeGaps(raw.coverage.gaps == null ? [] : raw.coverage.gaps);
    if (g.error) return done(fail(safeId, callId, "error", "bad_coverage", g.error));
    coverage = { supported: raw.coverage.supported !== false, gaps: g.gaps };
  } else coverage = { supported: raw.status === "ok", gaps: [] };
  let refusal = null;
  if (raw.status === "refused") {
    const r = raw.refusal;
    if (!r || typeof r !== "object" || !REFUSAL_CODES.includes(r.code)) return done(fail(safeId, callId, "error", "bad_refusal", "a refused result needs a known refusal code"));
    refusal = { code: r.code, reason: String(r.reason == null ? "" : r.reason).slice(0, 300) };
  }
  let error = null;
  if (raw.error != null) {
    const e = raw.error;
    error = { code: String(e && e.code != null ? e.code : "error").replace(/[^A-Za-z0-9_]/g, "").slice(0, 64) || "error", message: String(e && e.message != null ? e.message : "").slice(0, 200) };
  }

  const env = envelope({
    tool: tool.id, call_id: callId, status: raw.status, data, facts, coverage,
    provenance: { ...provenance, tool_version: tool.version, as_of: asOf, routes: auditEntry.routes.map((r) => r.path), redactions: counter.n, truncated: counter.truncated },
    data_class: dataClass, freshness, refusal, error,
  });
  if (byteLength({ data: env.data, provenance: env.provenance, freshness: env.freshness }) > MAX_OUTPUT_BYTES || byteLength(env) > MAX_OUTPUT_BYTES + 32 * 1024) return done(fail(safeId, callId, "error", "output_too_large", "the result was too large to use safely"));
  return done(env);
}
