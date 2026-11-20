// Commissioner Desk: the tool registry and the ONLY way a tool runs.
//
// Authorization is enforced HERE, in code, on every call. Nothing the model says can widen it:
//   1. the caller must be the proven commissioner (assertCommishCaller), checked on every call;
//   2. the tool must be registered, and its arguments must match its input schema exactly (no extra keys);
//   3. as_of is mandatory; a tool that cannot honor it answers "unsupported_as_of", never today's data;
//   4. a tool receives NO env, NO database handle and NO credentials. Its only capabilities are `routeGet`
//      (GET-only, exact-path allowlist, per-route parameter allowlist, no cookies, size and time limits) and the
//      read-only knowledge objects the handler injects. A tool therefore cannot write, and cannot reach a route
//      it did not declare;
//   5. its output is cut down to the tool's own output allowlist, secret-looking keys are stripped, the data class
//      is checked against the caller's ceiling, and fact ids are namespaced per call.
//
// The registry never throws to its caller for a bad tool call: it returns an envelope with status "forbidden" or "error".

import {
  assertCommishCaller, classAllowed, isAsOf, isFactId, GRADES, FACT_UNITS, TOOL_STATUSES,
  FORBIDDEN_ROUTE_PATTERNS, SECRET_KEY_RE, DATA_CLASS_RANK, DeskAuthError,
} from "./contract.js";

export const MAX_OUTPUT_BYTES = 60 * 1024;
export const ROUTE_TIMEOUT_MS = 8000;
export const TOOL_TIMEOUT_MS = 12000;
export const ROUTE_MAX_BYTES = 2 * 1024 * 1024;
const SELF_ORIGIN = "https://self.invalid";

const REGISTRY = new Map();

// ── Definition ─────────────────────────────────────────────────────────────────────────────────
// def = {
//   id, version, description, phase: "P1", dataClass: "P0"|"P2", readOnly: true,
//   inputSchema: { type:"object", properties:{ name:{type,enum,pattern,maxLength,minimum,maximum} }, required:[...] },   // as_of is added automatically
//   asOf: { supports: "current" | "season" | "any", from?: <first season>, check?: (asOf, ctx) => null | {why, source_needed} },
//   allowlist: { routes: [{ path: "/api/standings", params: ["L","YEAR"] }], modules: ["cap_math.js"], tables: [] },
//   output: { allow: ["data.standings[].franchise_id", ...] | null },         // dotted paths; "[]" walks arrays; null = tool builds data itself (static tools)
//   freshness?: { maxAgeHours },
//   run: async ({ args, caller, now, routeGet, knowledge, asOf }) => ({ status, data, facts, coverage, provenance, freshness, error })
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
  if (!def.inputSchema || def.inputSchema.type !== "object" || typeof def.inputSchema.properties !== "object") problems.push("inputSchema required");
  if (def.inputSchema && def.inputSchema.properties && def.inputSchema.properties.as_of) problems.push("as_of is added by the registry; do not declare it");
  if (!def.asOf || !["current", "season", "any"].includes(def.asOf.supports)) problems.push("asOf.supports must be current|season|any");
  const al = def.allowlist;
  if (!al || !Array.isArray(al.routes) || !Array.isArray(al.modules) || !Array.isArray(al.tables)) problems.push("allowlist.{routes,modules,tables} arrays required");
  if (al && Array.isArray(al.tables) && al.tables.length) problems.push("desk tools may not read tables directly; use a route or a module");
  for (const r of (al && al.routes) || []) {
    if (!r || typeof r.path !== "string" || !r.path.startsWith("/") || !Array.isArray(r.params)) { problems.push(`bad route allowlist entry ${JSON.stringify(r)}`); continue; }
    if (r.method && r.method !== "GET") problems.push(`route ${r.path}: only GET is allowed`);
    if (FORBIDDEN_ROUTE_PATTERNS.some((re) => re.test(r.path))) problems.push(`route ${r.path} matches a forbidden pattern`);
  }
  if (problems.length) throw new Error(`defineTool(${def && def.id}): ${problems.join("; ")}`);
  const frozen = Object.freeze({ ...def, inputSchema: Object.freeze({ ...def.inputSchema }), allowlist: Object.freeze({ ...al }) });
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

// ── Argument validation (a deliberately small JSON-schema subset) ──────────────────────────────
export function validateArgs(tool, rawArgs) {
  const schema = tool.inputSchema;
  const args = rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs) ? rawArgs : null;
  if (!args) return { ok: false, error: "arguments must be an object" };
  const props = { ...schema.properties, as_of: { type: "string" } };
  const out = {};
  for (const k of Object.keys(args)) if (!(k in props)) return { ok: false, error: `unknown argument '${k}'` };
  for (const k of [...(schema.required || []), "as_of"]) if (args[k] === undefined || args[k] === null || args[k] === "") return { ok: false, error: `missing argument '${k}'` };
  if (!isAsOf(args.as_of)) return { ok: false, error: "as_of must be 'current' or YYYY-MM-DD" };
  for (const [k, spec] of Object.entries(props)) {
    if (args[k] === undefined) continue;
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
// deps.fetchSelf(urlString) -> Response. In production this is env.SELF.fetch (see handler); in tests it is the real worker handler
// with a faked MFL. It is given a bare URL and nothing else: no headers, no cookies, no method, no body.
function makeRouteGet(tool, deps, audit) {
  const allowed = new Map(tool.allowlist.routes.map((r) => [r.path, new Set(r.params)]));
  let calls = 0;
  return async function routeGet(path, params) {
    calls += 1;
    if (calls > 6) throw routeError("too_many_route_calls", path);
    if (typeof path !== "string" || !allowed.has(path)) throw routeError("route_not_allowlisted", path);
    if (FORBIDDEN_ROUTE_PATTERNS.some((re) => re.test(path))) throw routeError("route_forbidden", path);
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
    try { res = await deps.fetchSelf(u.toString(), ctl ? { signal: ctl.signal } : undefined); }
    catch (e) { throw routeError(ctl && ctl.signal.aborted ? "route_timeout" : "route_unreachable", path); }
    finally { if (timer) clearTimeout(timer); }
    const text = await res.text();
    if (text.length > ROUTE_MAX_BYTES) throw routeError("route_response_too_large", path);
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch (_) { json = null; }
    audit.routes.push({ path, status: res.status, ms: deps.nowMs() - t0 });
    return { status: res.status, ok: res.status >= 200 && res.status < 300, json, text };
  };
}
function routeError(code, detail) { const e = new Error(`${code}: ${detail}`); e.deskCode = code; return e; }

// ── Output projection ──────────────────────────────────────────────────────────────────────────
// Dotted allowlist paths: "standings[].franchise_id", "totals.cap_used". "[]" walks every element of an array.
function compileAllow(paths) {
  const root = {};
  for (const p of paths) {
    let node = root;
    for (const seg of p.split(".")) {
      const arr = seg.endsWith("[]"); const key = arr ? seg.slice(0, -2) : seg;
      node[key] = node[key] || { children: {}, arr: false };
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
    if (!(k in value)) continue;
    const kids = sub.children;
    out[k] = Object.keys(kids).length ? project(value[k], kids) : value[k];
  }
  return out;
}
function stripSecrets(value, counter) {
  if (Array.isArray(value)) return value.map((v) => stripSecrets(v, counter));
  if (!value || typeof value !== "object") return value;
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (SECRET_KEY_RE.test(k)) { counter.n += 1; continue; }
    out[k] = stripSecrets(v, counter);
  }
  return out;
}

// ── Envelope ────────────────────────────────────────────────────────────────────────────────────
export function envelope(partial) {
  return {
    tool: partial.tool, call_id: partial.call_id || null, status: partial.status, data: partial.data == null ? null : partial.data,
    facts: partial.facts || [], coverage: partial.coverage || { supported: partial.status === "ok", gaps: [] },
    provenance: partial.provenance || {}, data_class: partial.data_class || "P0", freshness: partial.freshness || null,
    refusal: partial.refusal || null, error: partial.error || null,
  };
}
function fail(toolId, callId, status, code, message) {
  return envelope({ tool: toolId, call_id: callId, status, error: { code, message: String(message || code).slice(0, 200) }, coverage: { supported: false, gaps: [] } });
}

function withTimeout(promise, ms, code) {
  let t;
  const timeout = new Promise((_, rej) => { t = setTimeout(() => rej(Object.assign(new Error(code), { deskCode: code })), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}

// ── runTool ─────────────────────────────────────────────────────────────────────────────────────
// ctx = { caller, callSeq }       caller from makeCommishCaller (frozen). callSeq: 1-based number of this tool call in the question.
// deps = { fetchSelf, now: () => Date, nowMs: () => number, knowledge, audit?: (entry) => void }
export async function runTool(ctx, toolId, rawArgs, deps) {
  const callId = `c${Number(ctx && ctx.callSeq) || 1}`;
  const started = deps && deps.nowMs ? deps.nowMs() : Date.now();
  const auditEntry = { tool: toolId, call_id: callId, routes: [], status: null, ms: 0 };
  const done = (env) => {
    auditEntry.status = env.status; auditEntry.ms = (deps && deps.nowMs ? deps.nowMs() : Date.now()) - started;
    try { deps && deps.audit && deps.audit(auditEntry); } catch (_) { /* audit must never break a tool */ }
    return env;
  };
  try { assertCommishCaller(ctx && ctx.caller); }
  catch (e) { return done(fail(toolId, callId, "forbidden", "not_commissioner", e instanceof DeskAuthError ? e.reason : "authorization failed")); }

  const tool = REGISTRY.get(toolId);
  if (!tool) return done(fail(toolId, callId, "forbidden", "unknown_tool", `no such tool: ${String(toolId).slice(0, 60)}`));
  if (!classAllowed(ctx.caller.ceiling, tool.dataClass)) return done(fail(toolId, callId, "forbidden", "data_class_exceeded", `tool class ${tool.dataClass} exceeds the caller ceiling`));

  const v = validateArgs(tool, rawArgs);
  if (!v.ok) return done(fail(toolId, callId, "error", "bad_arguments", v.error));
  const args = v.args;

  // as_of: current-only tools refuse any past date; season tools refuse dates before their first covered season.
  const asOf = args.as_of;
  const supports = tool.asOf.supports;
  const currentSeason = deps.knowledge && deps.knowledge.currentSeason;
  if (supports === "current" && asOf !== "current") {
    return done(envelope({ tool: toolId, call_id: callId, status: "unsupported_as_of", data_class: tool.dataClass,
      coverage: { supported: false, gaps: [{ what: `${toolId} answers for the current state only`, why: "unsupported_as_of", source_needed: "a dated record of this state" }] } }));
  }
  if (supports === "season" && asOf !== "current") {
    const season = Number(asOf.slice(0, 4));
    const first = tool.asOf.from || 0;
    if (season < first) {
      return done(envelope({ tool: toolId, call_id: callId, status: "unsupported_as_of", data_class: tool.dataClass,
        coverage: { supported: false, gaps: [{ what: `${toolId} has no data before ${first}`, why: "unsupported_as_of", source_needed: "an archive for that season" }] } }));
    }
    if (currentSeason && season > Number(currentSeason)) {
      return done(envelope({ tool: toolId, call_id: callId, status: "unsupported_as_of", data_class: tool.dataClass,
        coverage: { supported: false, gaps: [{ what: "that date is in the future", why: "unsupported_as_of", source_needed: "none (future date)" }] } }));
    }
  }
  if (typeof tool.asOf.check === "function") {
    const why = tool.asOf.check(asOf, { currentSeason });
    if (why) return done(envelope({ tool: toolId, call_id: callId, status: "unsupported_as_of", data_class: tool.dataClass,
      coverage: { supported: false, gaps: [{ what: why.what || `${toolId} cannot answer for ${asOf}`, why: "unsupported_as_of", source_needed: why.source_needed || "a dated record" }] } }));
  }

  // Run with capabilities only.
  let raw;
  try {
    raw = await withTimeout(Promise.resolve(tool.run({
      args, asOf, caller: ctx.caller, now: deps.now ? deps.now() : new Date(),
      routeGet: makeRouteGet(tool, deps, auditEntry), knowledge: deps.knowledge || {},
    })), TOOL_TIMEOUT_MS, "tool_timeout");
  } catch (e) {
    const code = (e && e.deskCode) || "tool_exception";
    return done(fail(toolId, callId, "error", code, code === "tool_exception" ? "the tool failed" : (e.message || code)));
  }
  if (!raw || typeof raw !== "object") return done(fail(toolId, callId, "error", "bad_tool_output", "tool returned nothing"));
  if (!TOOL_STATUSES.includes(raw.status) || raw.status === "forbidden") return done(fail(toolId, callId, "error", "bad_tool_status", String(raw.status)));

  // Project, strip, size-check.
  let data = raw.data == null ? null : raw.data;
  const strip = { n: 0 };
  if (data != null) {
    if (tool.output && Array.isArray(tool.output.allow)) data = project(data, compileAllow(tool.output.allow));
    data = stripSecrets(data, strip);
    if (JSON.stringify(data).length > MAX_OUTPUT_BYTES) return done(fail(toolId, callId, "error", "output_too_large", "the result was too large to use safely"));
  }

  // Facts: validate, namespace.
  const facts = [];
  const seen = new Set();
  for (const f of raw.facts || []) {
    const key = f && f.key;
    const id = `${callId}.${key}`;
    if (typeof key !== "string" || !isFactId(id) || seen.has(id)) return done(fail(toolId, callId, "error", "bad_fact", `invalid fact key ${String(key).slice(0, 40)}`));
    if (!FACT_UNITS.includes(f.unit)) return done(fail(toolId, callId, "error", "bad_fact", `bad unit on ${key}`));
    if (!GRADES.includes(f.grade)) return done(fail(toolId, callId, "error", "bad_fact", `bad grade on ${key}`));
    if (f.value === undefined || (typeof f.value === "object" && f.value !== null)) return done(fail(toolId, callId, "error", "bad_fact", `bad value on ${key}`));
    seen.add(id);
    facts.push({ id, label: String(f.label || key).slice(0, 120), value: f.value, unit: f.unit, as_of: f.as_of || asOf, source: String(f.source || tool.id).slice(0, 160), grade: f.grade });
  }
  if (raw.status !== "ok" && facts.length) return done(fail(toolId, callId, "error", "facts_on_non_ok", "a refused or empty result may not carry facts"));

  const dataClass = raw.data_class || tool.dataClass;
  if (DATA_CLASS_RANK[dataClass] == null || DATA_CLASS_RANK[dataClass] > DATA_CLASS_RANK[tool.dataClass] || !classAllowed(ctx.caller.ceiling, dataClass)) {
    return done(fail(toolId, callId, "forbidden", "data_class_exceeded", "result class exceeds the tool or caller ceiling"));
  }

  const coverage = raw.coverage && typeof raw.coverage === "object" ? { supported: raw.coverage.supported !== false, gaps: Array.isArray(raw.coverage.gaps) ? raw.coverage.gaps : [] } : { supported: raw.status === "ok", gaps: [] };
  return done(envelope({
    tool: toolId, call_id: callId, status: raw.status, data, facts, coverage,
    provenance: { ...(raw.provenance || {}), tool_version: tool.version, as_of: asOf, routes: auditEntry.routes.map((r) => r.path), redactions: strip.n },
    data_class: dataClass, freshness: raw.freshness || null, refusal: raw.refusal || null, error: raw.error || null,
  }));
}
