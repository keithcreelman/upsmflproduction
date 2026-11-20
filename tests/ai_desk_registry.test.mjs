// Commissioner Desk: ADVERSARIAL tests of worker/src/desk/registry.js, the authorization boundary.
// Offline and deterministic. Run:  node tests/ai_desk_registry.test.mjs
//
// Every weakness found in the first round of attacks is now a hard assertion that the hole is CLOSED (the helper `closed()` below
// also records a regression in FINDINGS, and the last test asserts FINDINGS is empty). Two lists stay outside that rule:
//   * RESIDUAL: things found in the hardened code that the integrator has not been asked to fix. They are probed and printed, never failed.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mock } from "node:test";
import { test, run, t } from "./fixtures/mini_test.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const D = (p) => import(path.join(ROOT, "worker/src/desk", p));
const C = await D("contract.js");
const R = await D("registry.js");
const { makeCommishCaller, assertCommishCaller, FORBIDDEN_ROUTE_PATTERNS, SECRET_KEY_RE, isSecretKey, isUnsafeKey, isPlainRoutePath, COMMISH_CEILING } = C;
const { defineTool, runTool, getTool, listTools, toolSpecsForModel, toolIdFromModelName, validateArgs, MAX_OUTPUT_BYTES, ROUTE_TIMEOUT_MS, TOOL_TIMEOUT_MS, MAX_FACTS, MAX_GAPS, MAX_ROUTE_CALLS, _resetRegistryForTests } = R;
_resetRegistryForTests();

const NOW = new Date("2026-11-19T12:00:00Z");
const caller = makeCommishCaller("0001");
const FINDINGS = [];     // regressions: a hole that was closed and is open again
const RESIDUAL = [];     // known leftovers in the hardened code (printed, not failed)
// closed(id, stillOpen, detail): asserts the hole is closed.
function closed(id, stillOpen, detail) { if (stillOpen) FINDINGS.push({ id, detail }); t.ok(!stillOpen, `${id} must stay closed: ${detail}`); }
function residual(id, present, where, detail) { if (present) RESIDUAL.push({ id, where, detail }); }

// ── helpers ──────────────────────────────────────────────────────────────────────────────────────────────
let seq = 0;
function nextId() { let n = ++seq, s = ""; do { s = String.fromCharCode(97 + (n % 26)) + s; n = Math.floor(n / 26); } while (n > 0); return `tt.${s}${s}`; }
function baseDef(over = {}) {
  return {
    id: nextId(), version: "1.0.0", description: "A test tool used only by the adversarial registry tests.", phase: "P1", dataClass: "P0", readOnly: true,
    inputSchema: { type: "object", properties: {}, required: [] }, asOf: { supports: "any" },
    allowlist: { routes: [], modules: [], tables: [] }, output: { allow: ["ok"] },
    run: async () => ({ status: "ok", data: { ok: true } }), ...over,
  };
}
// mk: a tool whose run() counts how many times it ran and records exactly what it was given.
function mk(over = {}) {
  const spy = { ran: 0, last: null };
  const userRun = over.run;
  const def = defineTool(baseDef({
    ...over,
    run: async (input) => { spy.ran += 1; spy.last = input; return userRun ? userRun(input) : { status: "ok", data: { ok: true } }; },
  }));
  return { def, id: def.id, spy };
}
function mkDeps(o = {}) {
  const d = { fetched: [], audits: [], now: () => NOW, nowMs: () => Date.now(), knowledge: o.knowledge === undefined ? { currentSeason: 2026, leagueId: "74598" } : o.knowledge };
  const body = o.body === undefined ? { ok: true } : o.body;
  d.fetchSelf = async (...a) => {
    d.fetched.push(a);
    if (o.fetchSelf) return o.fetchSelf(...a);
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status: o.status || 200 });
  };
  d.audit = o.audit || ((e) => d.audits.push(e));
  return d;
}
async function go(id, args, o = {}) {
  const deps = o.deps || mkDeps(o);
  const env = await runTool({ caller: "caller" in o ? o.caller : caller, callSeq: o.seq }, id, args === undefined ? { as_of: "current" } : args, deps);
  return Object.assign(env, { _deps: deps });
}
const rejects = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

// ═══ 1. WHO IS CALLING ═══════════════════════════════════════════════════════════════════════════════════
test("a caller built by makeCommishCaller passes; it is frozen, fixed-shape, and its input cannot change class, scope or ceiling", async () => {
  const tool = mk();
  const env = await go(tool.id, { as_of: "current" });
  t.equal(env.status, "ok");
  t.equal(tool.spy.ran, 1);
  for (const who of ["0001", "8", 12, undefined, null, "session", "apikey", "<script>alert(1)</script>", "x".repeat(500), { toString() { return "0042"; } }, "1; DROP TABLE", "0008\n"]) {
    const c = makeCommishCaller(who);
    t.ok(Object.isFrozen(c), `frozen for ${String(who).slice(0, 20)}`);
    t.equal(c.class, "commish"); t.equal(c.proven, true); t.equal(c.scope, "desk"); t.equal(c.ceiling, COMMISH_CEILING);
    t.ok(typeof c.franchiseId === "string" && c.franchiseId.length <= 12, `franchiseId bounded: ${c.franchiseId}`);
    t.doesNotMatch(c.franchiseId, /[<>;\s]/);
    t.equal(assertCommishCaller(c), c);
    t.throws(() => { c.class = "owner"; }, TypeError);
    t.throws(() => { c.ceiling = "P3"; }, TypeError);
    t.throws(() => { c.extra = 1; }, TypeError);
    t.deepEqual((await go(tool.id, { as_of: "current" }, { caller: c })).status, "ok");
  }
});

test("a plain object forged as a commissioner is refused (not frozen), and the tool never runs", async () => {
  const tool = mk();
  const forged = { class: "commish", proven: true, scope: "desk", franchiseId: "0001", ceiling: "P2" };
  const env = await go(tool.id, { as_of: "current" }, { caller: forged });
  t.equal(env.status, "forbidden");
  t.equal(env.error.code, "not_commissioner");
  t.match(env.error.message, /not built by makeCommishCaller/);
  t.equal(tool.spy.ran, 0);
  t.equal(env._deps.fetched.length, 0);
  t.equal(env.data, null);
  t.deepEqual(env.facts, []);
  t.equal(env.coverage.supported, false);
});

test("forged or tampered callers of every shape are refused, frozen or not, and the tool never runs", async () => {
  const tool = mk();
  const fz = Object.freeze;
  const good = { class: "commish", proven: true, scope: "desk", franchiseId: "0001", ceiling: "P2" };
  const bad = [
    ["spread copy of a real caller", { ...caller }],
    ["Object.create(real caller)", Object.create(caller)],
    ["wrong class (owner), frozen", fz({ ...good, class: "owner" })],
    ["wrong class (admin), frozen", fz({ ...good, class: "admin" })],
    ["proven as the string 'true', frozen", fz({ ...good, proven: "true" })],
    ["proven 1, frozen", fz({ ...good, proven: 1 })],
    ["proven missing, frozen", fz({ class: "commish", scope: "desk", ceiling: "P2" })],
    ["proven false, frozen", fz({ ...good, proven: false })],
    ["wrong scope, frozen", fz({ ...good, scope: "site" })],
    ["scope missing, frozen", fz({ class: "commish", proven: true, ceiling: "P2" })],
    ["ceiling P1, frozen", fz({ ...good, ceiling: "P1" })],
    ["ceiling P3, frozen", fz({ ...good, ceiling: "P3" })],
    ["ceiling missing, frozen", fz({ class: "commish", proven: true, scope: "desk" })],
    ["owner caller", fz({ class: "owner", proven: true, scope: "desk", franchiseId: "0001", ceiling: "P1" })],
    ["anonymous caller", fz({ class: "anonymous", proven: false, scope: "public", ceiling: "P0" })],
    ["empty object", {}],
    ["frozen empty object", fz({})],
    ["null", null], ["undefined", undefined], ["string 'commish'", "commish"], ["number", 1], ["true", true],
    ["array", [good]], ["function", () => good],
    ["Map", new Map(Object.entries(good))],
    ["JSON round-trip of a real caller", JSON.parse(JSON.stringify(caller))],
  ];
  for (const [name, c] of bad) {
    const env = await go(tool.id, { as_of: "current" }, { caller: c });
    t.equal(env.status, "forbidden", name);
    t.equal(env.error.code, "not_commissioner", name);
  }
  t.equal(tool.spy.ran, 0, "no refused caller ever reached run()");
  // a missing context, a missing caller key, and a hostile ctx object
  for (const ctx of [undefined, null, {}, { caller: undefined }, { callerr: caller }, "ctx", 5]) {
    const env = await runTool(ctx, tool.id, { as_of: "current" }, mkDeps());
    t.equal(env.status, "forbidden", String(JSON.stringify(ctx)));
  }
  t.equal(tool.spy.ran, 0);
});

test("authorization runs before everything: a bad caller learns nothing about which tools exist or what arguments are valid", async () => {
  const tool = mk({ inputSchema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] } });
  const forged = { class: "commish", proven: true, scope: "desk", ceiling: "P2" };
  const a = await go(tool.id, { as_of: "current" }, { caller: forged });             // would be bad_arguments for a real caller
  const b = await go("no.such_tool", { as_of: "current" }, { caller: forged });      // would be unknown_tool
  const c = await go("rules.search", "garbage", { caller: forged });
  for (const env of [a, b, c]) { t.equal(env.status, "forbidden"); t.equal(env.error.code, "not_commissioner"); }
  t.equal(a.error.message, b.error.message);
  t.equal(tool.spy.ran, 0);
});

test("a frozen look-alike literal, a clone, a proxy and Object.create(caller) are all refused: only an object minted by makeCommishCaller is a caller", async () => {
  const tool = mk();
  const lit = { class: "commish", proven: true, scope: "desk", franchiseId: "0001", ceiling: "P2" };
  const mint = makeCommishCaller("0001");
  const impostors = [
    ["frozen literal", Object.freeze({ ...lit })],
    ["deep-frozen literal", C.freezeDeep({ ...lit })],
    ["frozen spread of a real caller", Object.freeze({ ...mint })],
    ["frozen Object.assign copy", Object.freeze(Object.assign({}, mint))],
    ["frozen Object.create(caller)", Object.freeze(Object.create(mint))],
    ["Object.create(caller)", Object.create(mint)],
    ["structuredClone of a real caller", structuredClone(mint)],
    ["JSON round trip", Object.freeze(JSON.parse(JSON.stringify(mint)))],
    ["Proxy around a real caller", new Proxy(mint, {})],
    ["frozen null-prototype copy", Object.freeze(Object.assign(Object.create(null), mint))],
    ["class instance", Object.freeze(new (class Caller { constructor() { Object.assign(this, lit); } })())],
  ];
  for (const [name, c] of impostors) {
    const env = await go(tool.id, { as_of: "current" }, { caller: c });
    closed(`F1-${name}`, env.status !== "forbidden", `${name} was accepted as the commissioner`);
    t.equal(env.error && env.error.code, "not_commissioner", name);
    t.throws(() => assertCommishCaller(c), C.DeskAuthError, name);
  }
  t.equal(tool.spy.ran, 0);
  t.equal((await go(tool.id, { as_of: "current" }, { caller: mint })).status, "ok", "the real one still passes");
  t.equal(assertCommishCaller(mint), mint);
  t.equal(tool.spy.ran, 1);
  const a = makeCommishCaller("0001"), b = makeCommishCaller("0001");
  t.ok(a !== b && assertCommishCaller(a) === a && assertCommishCaller(b) === b, "every minted caller is its own branded object");
});

// ═══ 2. WHICH TOOL ═══════════════════════════════════════════════════════════════════════════════════════
test("unknown tools are forbidden, never run, and the echoed name is bounded", async () => {
  const known = mk();
  let tooLongEchoed = false;
  for (const name of ["no.such_tool", "", " ", null, undefined, 5, {}, [], "__proto__", "constructor", "toString", "hasOwnProperty", known.id.toUpperCase(), ` ${known.id}`, `${known.id} `, `${known.id}\n`, `${known.id}.`, "x".repeat(10000), "rules.search\u0000", `${known.id}__extra`]) {
    const env = await go(name, { as_of: "current" });
    t.equal(env.status, "forbidden", String(name).slice(0, 30));
    t.equal(env.error.code, "unknown_tool");
    t.ok(env.error.message.length <= 200, "the error message is bounded");
    t.ok(env.tool.length <= 64, "the echoed tool name is capped");
    if (typeof name === "string" && name.length > 5000) { tooLongEchoed = JSON.stringify(env).length > 1500; t.ok(env._deps.audits[0].tool.length <= 64, "and so is the audit entry"); }
  }
  closed("F20-tool-name-echoed-whole", tooLongEchoed, "a 10000-character tool name came back whole");
  t.equal(known.spy.ran, 0);
  t.equal((await go(known.id, { as_of: "current" })).status, "ok");
});

// ═══ 3. ARGUMENTS ════════════════════════════════════════════════════════════════════════════════════════
const SCHEMA = {
  type: "object",
  properties: {
    s: { type: "string", maxLength: 10, pattern: "^[a-z]+$" },
    e: { type: "string", enum: ["alpha", "beta"] },
    n: { type: "integer", minimum: 1, maximum: 5 },
    f: { type: "number", minimum: 0, maximum: 1 },
    b: { type: "boolean" },
    d: { type: "string" },
    o: { type: "object" },
  },
  required: ["s"],
};

test("arguments: extra, missing, wrongly typed and out-of-range values are all refused before the tool runs", async () => {
  const tool = mk({ inputSchema: SCHEMA });
  const refused = [
    ["extra key", { s: "ok", zzz: 1 }],
    ["extra key with a prototype-ish name that is not a schema property", { s: "ok", admin: true }],
    ["missing required", {}],
    ["required null", { s: null }],
    ["required empty string", { s: "" }],
    ["string given a number", { s: 5 }],
    ["string given an array", { s: ["ok"] }],
    ["string given an object", { s: { a: 1 } }],
    ["string too long", { s: "a".repeat(11) }],
    ["pattern violated", { s: "UPPER" }],
    ["pattern violated by newline tail", { s: "abc\n" }],
    ["enum violated", { s: "ok", e: "gamma" }],
    ["enum case", { s: "ok", e: "Alpha" }],
    ["integer given a string", { s: "ok", n: "3" }],
    ["integer given a float", { s: "ok", n: 2.5 }],
    ["integer below minimum", { s: "ok", n: 0 }],
    ["integer above maximum", { s: "ok", n: 6 }],
    ["integer NaN", { s: "ok", n: NaN }],
    ["integer Infinity", { s: "ok", n: Infinity }],
    ["integer boolean", { s: "ok", n: true }],
    ["number NaN", { s: "ok", f: NaN }],
    ["number Infinity", { s: "ok", f: Infinity }],
    ["number string", { s: "ok", f: "0.5" }],
    ["number above maximum", { s: "ok", f: 1.0001 }],
    ["boolean given a string", { s: "ok", b: "true" }],
    ["boolean given 1", { s: "ok", b: 1 }],
    ["default string cap (200) exceeded", { s: "ok", d: "x".repeat(201) }],
    ["unsupported schema type (object)", { s: "ok", o: { a: 1 } }],
  ];
  for (const [name, args] of refused) {
    const env = await go(tool.id, { as_of: "current", ...args });
    t.equal(env.status, "error", name);
    t.equal(env.error.code, "bad_arguments", name);
    t.equal(env.data, null);
  }
  t.equal(tool.spy.ran, 0, "none of the bad calls reached run()");
  const good = await go(tool.id, { as_of: "current", s: "ok", e: "beta", n: 5, f: 0, b: false, d: "x".repeat(200) });
  t.equal(good.status, "ok");
  t.equal(tool.spy.ran, 1);
  t.deepEqual(Object.keys(tool.spy.last.args).sort(), ["as_of", "b", "d", "e", "f", "n", "s"]);
  t.equal(tool.spy.last.args.n, 5);
  t.equal(tool.spy.last.args.f, 0);
  t.equal(tool.spy.last.args.b, false);
});

test("arguments: a non-object argument bag is refused", async () => {
  const tool = mk({ inputSchema: SCHEMA });
  for (const bag of [null, "s=ok", 5, true, [], [{ s: "ok", as_of: "current" }], () => ({})]) {
    const env = await runTool({ caller }, tool.id, bag, mkDeps());
    t.equal(env.status, "error", JSON.stringify(bag));
    t.equal(env.error.code, "bad_arguments");
  }
  t.equal((await runTool({ caller }, tool.id, undefined, mkDeps())).error.code, "bad_arguments");
  t.equal(tool.spy.ran, 0);
});

test("as_of is mandatory and strict: only 'current' or a real ISO calendar date", async () => {
  const tool = mk();
  const bad = [undefined, null, "", " ", "Current", "CURRENT", " current", "current ", "now", "today", "latest", "2026", "2026-1-1", "2026-11-1", "26-11-19", "2026/11/19",
    "2026-13-01", "2026-00-10", "2026-02-30", "2026-04-31", "2025-02-29", "2026-11-19T00:00:00Z", "2026-11-19 ", "2026-11-19\n", "٢٠٢٦-11-19", "2026-11-19; DROP", "9999-99-99", 20261119, true, ["current"], { v: "current" }];
  for (const asOf of bad) {
    const args = asOf === undefined ? {} : { as_of: asOf };
    const env = await go(tool.id, args);
    t.equal(env.status, "error", JSON.stringify(asOf));
    t.equal(env.error.code, "bad_arguments", JSON.stringify(asOf));
  }
  t.equal(tool.spy.ran, 0);
  for (const asOf of ["current", "2026-11-19", "2024-02-29", "2000-01-01", "0001-01-01"]) t.equal((await go(tool.id, { as_of: asOf })).status, "ok", asOf);
  t.equal(tool.spy.ran, 5);
});

test("arguments: names that exist on every object (constructor, toString, __proto__) are refused as unknown, never reach the tool, never pollute", async () => {
  const tool = mk({ inputSchema: SCHEMA });
  const parsed = JSON.parse('{"as_of":"current","s":"ok","__proto__":{"isAdmin":true},"constructor":{"x":1}}');
  const env = await go(tool.id, parsed);
  closed("F2-inherited-names-bypass-unknown-arg-check", env.status === "ok", "a bag carrying __proto__/constructor was accepted");
  t.equal(env.status, "error");
  t.equal(env.error.code, "bad_arguments");
  t.equal(tool.spy.ran, 0);
  t.equal({}.isAdmin, undefined, "no global prototype pollution");
  t.equal(Object.prototype.isAdmin, undefined);
  for (const k of ["toString", "valueOf", "hasOwnProperty", "constructor", "__proto__", "isPrototypeOf", "__defineGetter__", "prototype"]) {
    const bag = JSON.parse(`{"as_of":"current","s":"ok","${k}":"x"}`);
    const e2 = await go(tool.id, bag);
    t.equal(e2.error && e2.error.code, "bad_arguments", `${k} is an unknown argument`);
    t.ok(e2.error.message.length < 100);
  }
  t.equal(tool.spy.ran, 0);
  t.equal((await go(tool.id, { as_of: "current", s: "ok" })).status, "ok");
  t.deepEqual(Object.keys(tool.spy.last.args).sort(), ["as_of", "s"]);
});

test("arguments: the tool receives a copy, not the model's object", async () => {
  const tool = mk({ inputSchema: SCHEMA });
  const bag = { as_of: "current", s: "ok" };
  await go(tool.id, bag);
  t.ok(tool.spy.last.args !== bag);
  bag.s = "changed";
  t.equal(tool.spy.last.args.s, "ok");
  t.deepEqual(validateArgs(tool.def, { as_of: "current", s: "ok" }), { ok: true, args: { s: "ok", as_of: "current" } });
});

test("string arguments may carry control characters, but they can never reach a URL", async () => {
  const tool = mk({
    inputSchema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
    allowlist: { routes: [{ path: "/api/probe", params: ["q"] }], modules: [], tables: [] },
    run: async ({ args, routeGet }) => { const r = await routeGet("/api/probe", { q: args.q }); return { status: "ok", data: { ok: r.ok } }; },
  });
  const okEnv = await go(tool.id, { as_of: "current", q: "hello" });
  t.equal(okEnv.status, "ok");
  for (const q of ["a\nb", "a\r\nX-Injected: 1", "a\u0000b", "tab\there", "\u001f"]) {
    const env = await go(tool.id, { as_of: "current", q });
    t.equal(env.status, "error", JSON.stringify(q));
    t.equal(env.error.code, "param_value_rejected");
    t.equal(env._deps.fetched.length, 0);
  }
});

// ═══ 4. AS_OF ════════════════════════════════════════════════════════════════════════════════════════════
test("a current-only tool refuses every past or future date as unsupported_as_of WITHOUT running", async () => {
  const tool = mk({ asOf: { supports: "current" } });
  for (const asOf of ["2026-11-18", "2026-11-19", "2025-01-01", "2010-06-01", "2099-01-01", "0001-01-01"]) {
    const env = await go(tool.id, { as_of: asOf });
    t.equal(env.status, "unsupported_as_of", asOf);
    t.equal(env.coverage.supported, false);
    t.equal(env.coverage.gaps[0].why, "unsupported_as_of");
    t.ok(env.coverage.gaps[0].source_needed.length > 3);
    t.deepEqual(env.facts, []);
    t.equal(env.data, null);
    t.equal(env.data_class, "P0");
  }
  t.equal(tool.spy.ran, 0);
  t.equal((await go(tool.id, { as_of: "current" })).status, "ok");
  t.equal(tool.spy.ran, 1);
  t.equal(tool.spy.last.asOf, "current");
});

test("a season tool refuses a date before its first season or in a future season, and passes the rest", async () => {
  const tool = mk({ asOf: { supports: "season", from: 2020 } });
  for (const asOf of ["2019-12-31", "2012-01-01", "0001-01-01", "2027-01-01", "2099-12-31"]) {
    const env = await go(tool.id, { as_of: asOf });
    t.equal(env.status, "unsupported_as_of", asOf);
    t.equal(env.coverage.gaps[0].why, "unsupported_as_of");
  }
  t.equal(tool.spy.ran, 0);
  for (const asOf of ["2020-01-01", "2024-06-15", "2026-12-31", "current"]) t.equal((await go(tool.id, { as_of: asOf })).status, "ok", asOf);
  t.equal(tool.spy.ran, 4);
  for (const knowledge of [{}, null, undefined, { currentSeason: "soon" }, { currentSeason: 0 }, { currentSeason: NaN }]) {
    const e = await go(tool.id, { as_of: "2099-12-31" }, { knowledge });
    closed("F3-future-date-passes-without-currentSeason", e.status === "ok", `a future date ran with knowledge ${JSON.stringify(knowledge)}`);
    t.equal(e.status, "unsupported_as_of");
  }
  t.equal((await go(tool.id, { as_of: "2026-12-31" }, { knowledge: {} })).status, "ok", "without a season the injected clock's year (2026) is the bound");
  t.equal((await go(tool.id, { as_of: "2027-01-01" }, { knowledge: {} })).status, "unsupported_as_of");
});

test("an 'any' tool runs for every valid date and is handed the date it was asked for", async () => {
  const tool = mk({ asOf: { supports: "any" } });
  for (const asOf of ["current", "1999-01-01", "2026-11-19", "2099-01-01"]) {
    const env = await go(tool.id, { as_of: asOf });
    t.equal(env.status, "ok");
    t.equal(tool.spy.last.asOf, asOf);
    t.equal(env.provenance.as_of, asOf);
  }
});

test("asOf.check can veto a date; it sees the date and the current season; a check that throws is a finding", async () => {
  let seen = null;
  const tool = mk({ asOf: { supports: "any", check: (asOf, ctx) => { seen = [asOf, ctx]; return asOf === "2020-01-01" ? { what: "no data that day", source_needed: "an archive" } : null; } } });
  const veto = await go(tool.id, { as_of: "2020-01-01" });
  t.equal(veto.status, "unsupported_as_of");
  t.equal(veto.coverage.gaps[0].what, "no data that day");
  t.deepEqual(seen, ["2020-01-01", { currentSeason: 2026 }]);
  t.equal(tool.spy.ran, 0);
  t.equal((await go(tool.id, { as_of: "2021-01-01" })).status, "ok");
  const boom = mk({ asOf: { supports: "any", check: () => { throw new Error("check blew up: password=hunter2"); } } });
  let envBoom = null;
  const err = await rejects(async () => { envBoom = await go(boom.id, { as_of: "current" }); });
  closed("F4-registry-rejects-instead-of-envelope", err !== null, "a throwing asOf.check made runTool reject");
  t.equal(envBoom.status, "error");
  t.equal(envBoom.error.code, "as_of_check_failed");
  t.doesNotMatch(JSON.stringify(envBoom), /hunter2|blew up/);
  t.equal(boom.spy.ran, 0, "a date check that fails closes the call");
});

// ═══ 5. WHAT A TOOL IS GIVEN ═════════════════════════════════════════════════════════════════════════════
test("run() receives exactly {args, asOf, caller, now, routeGet, knowledge}: no env, no db, no fetch, no deps", async () => {
  const knowledge = Object.freeze({ currentSeason: 2026, leagueId: "74598", marker: "k" });
  const tool = mk({
    inputSchema: { type: "object", properties: { q: { type: "string" } }, required: [] },
    run: async (input) => ({ status: "ok", data: { ok: true } }),
  });
  const deps = mkDeps({ knowledge });
  deps.env = { SECRET: "x" }; deps.db = {}; deps.ctx = {};    // things a careless handler might leave on deps
  await go(tool.id, { as_of: "current", q: "hi" }, { deps });
  const given = tool.spy.last;
  t.deepEqual(Object.keys(given).sort(), ["args", "asOf", "caller", "knowledge", "now", "routeGet"]);
  t.equal(given.caller, caller);
  t.equal(given.knowledge, knowledge);
  t.ok(given.now instanceof Date && given.now.getTime() === NOW.getTime());
  t.equal(typeof given.routeGet, "function");
  t.deepEqual(Object.keys(given.routeGet), []);
  t.equal(given.asOf, "current");
  for (const forbidden of ["env", "db", "DB", "fetch", "fetchSelf", "SELF", "deps", "ctx", "audit", "request", "cookies", "headers", "UPS_MFL_DB"]) t.ok(!(forbidden in given), `no ${forbidden}`);
  t.ok(!JSON.stringify(Object.keys(given.args)).includes("SECRET"));
  t.ok(Object.isFrozen(given.caller));
  const noKnowledge = await go(tool.id, { as_of: "current" }, { knowledge: undefined, deps: { fetchSelf: async () => new Response("{}"), now: () => NOW, nowMs: () => 0 } });
  t.equal(noKnowledge.status, "ok");
  t.deepEqual(tool.spy.last.knowledge, {}, "a missing knowledge object becomes an empty one, never undefined or something else");
});

test("a tool cannot change the caller; and a failed attempt is an error envelope, not a changed caller", async () => {
  const tool = mk({ run: async ({ caller: c }) => { c.ceiling = "P3"; return { status: "ok", data: { ok: true } }; } });
  const env = await go(tool.id, { as_of: "current" });
  t.equal(env.status, "error");
  t.equal(env.error.code, "tool_exception");
  t.equal(caller.ceiling, "P2");
  t.equal(assertCommishCaller(caller), caller);
});

test("knowledge is deep-frozen by the registry, whatever the handler passed: a tool cannot alter what later tools and questions see", async () => {
  const plain = { currentSeason: 2026, poison: "clean", rules: { a: [1, 2], nested: { deep: { x: 1 } } } };
  const tool = mk({ run: async ({ knowledge }) => { knowledge.poison = "tampered"; return { status: "ok", data: { ok: true } }; } });
  const a = await go(tool.id, { as_of: "current" }, { knowledge: plain });
  closed("F5-knowledge-not-frozen-by-registry", plain.poison === "tampered", "a tool changed the shared knowledge object");
  t.equal(a.status, "error");
  t.equal(a.error.code, "tool_exception");
  t.equal(plain.poison, "clean");
  t.ok(Object.isFrozen(plain) && Object.isFrozen(plain.rules) && Object.isFrozen(plain.rules.a) && Object.isFrozen(plain.rules.nested.deep), "frozen at every depth");
  for (const mut of [(k) => k.rules.a.push(3), (k) => { k.rules.nested.deep.x = 2; }, (k) => { delete k.currentSeason; }, (k) => { k.added = 1; }, (k) => Object.defineProperty(k, "z", { value: 1 })]) {
    const t2 = mk({ run: async ({ knowledge }) => { mut(knowledge); return { status: "ok", data: { ok: true } }; } });
    t.equal((await go(t2.id, { as_of: "current" }, { knowledge: plain })).error.code, "tool_exception");
  }
  t.deepEqual(plain.rules.a, [1, 2]);
  const t3 = mk();
  t.equal((await go(t3.id, { as_of: "current" }, { knowledge: plain })).status, "ok", "the frozen object is reusable");
  t.equal(t3.spy.last.knowledge, plain);
  const cyc = { currentSeason: 2026 }; cyc.self = cyc;
  t.equal((await go(t3.id, { as_of: "current" }, { knowledge: cyc })).status, "ok", "a cyclic knowledge object freezes without hanging");
  t.ok(Object.isFrozen(cyc));
});

test("fetchSelf gets a bare https://self.invalid URL, no credentials, and nothing that carries headers, cookies or a method", async () => {
  const tool = mk({
    inputSchema: { type: "object", properties: { y: { type: "integer" }, l: { type: "string" } }, required: [] },
    allowlist: { routes: [{ path: "/api/standings", params: ["L", "YEAR"] }], modules: [], tables: [] },
    run: async ({ routeGet }) => { const r = await routeGet("/api/standings", { L: "74598", YEAR: 2025, DROPPED: undefined }); return { status: "ok", data: { ok: r.ok } }; },
  });
  const env = await go(tool.id, { as_of: "current" });
  t.equal(env.status, "ok");
  const calls = env._deps.fetched;
  t.equal(calls.length, 1);
  const [url, opts] = calls[0];
  t.equal(typeof url, "string");
  const u = new URL(url);
  t.equal(u.origin, "https://self.invalid");
  t.equal(u.pathname, "/api/standings");
  t.equal(u.username, ""); t.equal(u.password, ""); t.equal(u.hash, "");
  t.deepEqual([...u.searchParams.entries()].sort(), [["L", "74598"], ["YEAR", "2025"]]);
  t.equal(url, "https://self.invalid/api/standings?L=74598&YEAR=2025");
  closed("F7-redirects-not-disabled", !(opts && opts.redirect === "manual"), "fetchSelf was not told redirect:'manual'");
  t.equal(calls[0].length, 2, "fetchSelf(url, options): the options are exactly redirect and signal");
  t.deepEqual(Object.keys(opts).sort(), ["redirect", "signal"]);
  t.equal(opts.redirect, "manual");
  t.ok(opts.signal && typeof opts.signal.aborted === "boolean");
  for (const k of ["headers", "method", "body", "credentials", "cookie", "mode", "cf", "referrer", "integrity", "keepalive"]) t.ok(!(k in opts), `no ${k}`);
  t.equal(env.provenance.routes.length, 1);
  t.equal(env.provenance.routes[0], "/api/standings");
});

// ═══ 6. THE ROUTE ALLOWLIST ══════════════════════════════════════════════════════════════════════════════
function probeTool(allowedRoutes = [{ path: "/api/ok", params: ["L", "YEAR"] }]) {
  const probe = { path: undefined, params: undefined, result: undefined };
  const tool = mk({
    allowlist: { routes: allowedRoutes, modules: [], tables: [] },
    run: async ({ routeGet }) => { probe.result = await routeGet(probe.path, probe.params); return { status: "ok", data: { ok: true } }; },
  });
  return { tool, probe };
}

test("routeGet only reaches the exact allowlisted paths: rewrites, encodings, query strings, case and absolute URLs are all refused", async () => {
  const { tool, probe } = probeTool();
  const refusedPaths = [
    "/api/ok/", "/api/ok//", "//api/ok", "/api//ok", "/api/ok/.", "/api/ok/..", "/api/ok/../admin/x", "/api/./ok", "/api/ok/../ok", "/api/other/../ok",
    "/api/ok?x=1", "/api/ok?", "/api/ok#frag", "/api/ok;x=1", "/api/ok%00", "/api/ok%2f", "/api/%6fk", "/api/%4fk", "/api/ok%20", "/api/ok ", " /api/ok", "/api/ok\n", "/api/ok\t", "∕api∕ok",
    "/API/OK", "/Api/Ok", "api/ok", "ok", "", "/", "/admin/x", "/admin", "/admin/", "/refresh/after-trade", "/trade-offers", "/api/mfl-export", "/api/draft-state",
    "https://self.invalid/api/ok", "http://self.invalid/api/ok", "https://evil.example/api/ok", "//evil.example/api/ok", "\\\\evil.example\\api\\ok", "/\\evil.example", "javascript:alert(1)", "data:text/plain,x", "file:///etc/passwd",
    "/api/ok\\x", "/api\\ok",
  ];
  for (const p of refusedPaths) {
    probe.path = p; probe.params = {};
    const env = await go(tool.id, { as_of: "current" });
    t.equal(env.status, "error", JSON.stringify(p));
    t.equal(env.error.code, "route_not_allowlisted", JSON.stringify(p));
  }
  t.equal(refusedPaths.length > 40, true);
  for (const p of [null, undefined, 5, true, {}, [], ["/api/ok"], { toString: () => "/api/ok" }, Symbol.iterator]) {
    probe.path = p; probe.params = {};
    const env = await go(tool.id, { as_of: "current" });
    t.equal(env.status, "error", `non-string path ${String(typeof p)}`);
    t.ok(["route_not_allowlisted", "tool_exception"].includes(env.error.code), `non-string path code ${env.error.code}`);
    t.equal(env._deps.fetched.length, 0);
  }
  probe.path = "/api/ok"; probe.params = {};
  const good = await go(tool.id, { as_of: "current" });
  t.equal(good.status, "ok");
  t.equal(good._deps.fetched.length, 1);
  t.equal(good._deps.fetched[0][0], "https://self.invalid/api/ok");
});

test("a refused route never calls fetchSelf (checked per call)", async () => {
  const { tool, probe } = probeTool();
  for (const p of ["/api/ok/../admin/x", "/admin/x", "//evil.example/x", "/api/ok?x=1", "/api/other"]) {
    probe.path = p; probe.params = {};
    const env = await go(tool.id, { as_of: "current" });
    t.equal(env._deps.fetched.length, 0, p);
  }
});

test("routeGet refuses parameters that were not declared, hostile values, and cannot be tricked into adding or overriding a parameter", async () => {
  const { tool, probe } = probeTool([{ path: "/api/ok", params: ["L", "YEAR"] }]);
  for (const key of ["l", "year", "ADMIN", "L2", "L ", " L", "L&X", "L=1", "__proto__", "constructor", "toString", "hasOwnProperty", "", "X", "L%00", "L\n"]) {
    probe.path = "/api/ok"; probe.params = { [key]: "1" };
    const env = await go(tool.id, { as_of: "current" });
    t.equal(env.status, "error", JSON.stringify(key));
    t.equal(env.error.code, "param_not_allowlisted", JSON.stringify(key));
    t.equal(env._deps.fetched.length, 0);
  }
  for (const v of ["a\nb", "a\rb", "a\u0000b", "\u001f", "x".repeat(201)]) {
    probe.params = { L: v };
    const env = await go(tool.id, { as_of: "current" });
    t.equal(env.error && env.error.code, "param_value_rejected", JSON.stringify(v.slice(0, 20)));
    t.equal(env._deps.fetched.length, 0);
  }
  // Values that look like injection are encoded into ONE parameter, never split into several.
  for (const v of ["74598&L=1", "74598&ADMIN=1", "a=b", "x#y", "../../admin", "%26L%3D1", "a b", "é", " ", "x".repeat(200)]) {
    probe.params = { L: v, YEAR: 2025 };
    const env = await go(tool.id, { as_of: "current" });
    t.equal(env.status, "ok", JSON.stringify(v.slice(0, 20)));
    const u = new URL(env._deps.fetched[0][0]);
    t.equal(u.pathname, "/api/ok");
    t.equal(u.hash, "");
    t.deepEqual([...u.searchParams.keys()].sort(), ["L", "YEAR"], "no extra parameter appeared");
    t.equal(u.searchParams.get("L"), v, "the value arrives intact as one value");
  }
  probe.params = { L: null, YEAR: undefined };
  const skipped = await go(tool.id, { as_of: "current" });
  t.equal(skipped._deps.fetched[0][0], "https://self.invalid/api/ok");
  probe.params = undefined;
  t.equal((await go(tool.id, { as_of: "current" })).status, "ok");
  for (const bad of ["L=1", 5, ["L"]]) {
    probe.params = bad;
    const env = await go(tool.id, { as_of: "current" });
    t.equal(env.status === "ok" ? env._deps.fetched[0][0] : "refused", env.status === "ok" ? "https://self.invalid/api/ok" : "refused", `non-object params ${JSON.stringify(bad)} add nothing`);
  }
});

test("a tool cannot use another tool's routes, and an unlisted route stays unlisted whatever the request is", async () => {
  const a = probeTool([{ path: "/api/aaa", params: [] }]);
  const b = probeTool([{ path: "/api/bbb", params: [] }]);
  a.probe.path = "/api/bbb"; b.probe.path = "/api/aaa";
  for (const x of [a, b]) { const env = await go(x.tool.id, { as_of: "current" }); t.equal(env.error.code, "route_not_allowlisted"); t.equal(env._deps.fetched.length, 0); }
  a.probe.path = "/api/aaa"; b.probe.path = "/api/bbb";
  t.equal((await go(a.tool.id, { as_of: "current" })).status, "ok");
  t.equal((await go(b.tool.id, { as_of: "current" })).status, "ok");
});

test("defineTool refuses any allowlist path that is not plain: '..', '//', query, fragment, backslash, whitespace, % escapes, dots, case tricks", async () => {
  const notPlain = ["/api/ok/../admin/x", "//evil.example/x", "/api/ok?x=1", "/api/ok#f", "/api\\ok", "/api/ok\n", "/api/ok ", " /api/ok", "/api/a/../b", "/%61dmin/x", "/api/%2e%2e/x", "/api/ok%2f", "/api/ok;x=1", "/api//ok", "/api/ok//", "/api/ok\u0000", "/api/\u202eok", "/api/\u0430pi", "/api/ok\t", "http://self.invalid/api/ok", "/" + "a".repeat(130), "/api/o k", "/api/ok*", "/api/ok'", "/api/ok\"", "/api/ok<", "/api/ok,", "/api/ok=", "/api/ok&", "/api/ok@", "/api/ok:", "/api/ok~", "/api/ok|", "/api/ok$", "/api/ok(", "/api/ok+", "/api/ok!", "/api/ok^", "/api/ok`", "/api/ok{"];
  const before = listTools().length;
  for (const path_ of notPlain) {
    t.equal(isPlainRoutePath(path_), false, JSON.stringify(path_));
    let err = null;
    try { mk({ allowlist: { routes: [{ path: path_, params: [] }], modules: [], tables: [] } }); } catch (e) { err = e; }
    closed(`F8-defineTool-accepts-${path_.replace(/\W/g, "_")}`, err === null, `defineTool accepted ${JSON.stringify(path_)}`);
    t.match(String(err && err.message), /not a plain path/, JSON.stringify(path_));
  }
  t.equal(listTools().length, before, "nothing registered");
  for (const ok of ["/api/standings", "/roster-workbench", "/api/cap-penalty/preview", "/api/salary-adjustments/ledger", "/a", "/api/v1.2/x_y-z", "/API/Mixed-Case"]) t.equal(isPlainRoutePath(ok), true, ok);
  for (const bad of [null, undefined, 5, {}, [], "api/ok", "", "/api/ok\u00e9"]) t.equal(isPlainRoutePath(bad), false, String(bad));
  const badParams = [["L&X"], ["a b"], [""], ["1abc"], [5], ["a".repeat(42)], ["L=1"], ["L\n"], [null]];
  for (const params of badParams) t.throws(() => mk({ allowlist: { routes: [{ path: "/api/ok", params }], modules: [], tables: [] } }), /bad parameter name/, JSON.stringify(params));
  // dot segments are plain characters, so definition accepts them; the run-time URL check keeps them dead
  for (const dotted of ["/api/./ok", "/api/ok/.", "/api/ok/./x"]) {
    let tool = null;
    try { tool = mk({ allowlist: { routes: [{ path: dotted, params: [] }], modules: [], tables: [] }, run: async ({ routeGet }) => { await routeGet(dotted, {}); return { status: "ok", data: { ok: true } }; } }); } catch (_) { /* refused at definition: fine */ }
    if (!tool) continue;
    residual("R5-dot-segments-accepted-at-definition", true, "contract.js isPlainRoutePath (line 152)", `defineTool accepts ${dotted} because '.' and '/' are allowed characters and only '..' and '//' are tested; at run time new URL() collapses the dot segment, route_url_rewritten fires, and fetchSelf is never called, so the entry is dead, not dangerous. Reject any '.' path segment at definition for symmetry.`);
    const env = await go(tool.id, { as_of: "current" });
    t.equal(env.status, "error", dotted);
    t.equal(env.error.code, "route_url_rewritten", dotted);
    t.equal(env._deps.fetched.length, 0, `fetchSelf not called for ${dotted}`);
  }
});

test("more than six route calls in one tool run: the seventh is refused, even if the earlier ones were refused; counters are per run", async () => {
  const tool = mk({
    allowlist: { routes: [{ path: "/api/ok", params: [] }], modules: [], tables: [] },
    run: async ({ routeGet }) => {
      const out = [];
      for (let i = 0; i < 9; i++) { try { await routeGet("/api/ok", {}); out.push("ok"); } catch (e) { out.push(e.deskCode); } }
      return { status: "ok", data: { ok: true, out } };
    },
  });
  const env = await go(tool.id, { as_of: "current" });
  t.equal(env._deps.fetched.length, 6, "exactly six requests were sent");
  const second = await go(tool.id, { as_of: "current" });
  t.equal(second._deps.fetched.length, 6, "a new run gets a new budget");
  const mixed = mk({
    allowlist: { routes: [{ path: "/api/ok", params: [] }], modules: [], tables: [] },
    run: async ({ routeGet }) => {
      const out = [];
      for (const p of ["/nope", "/nope", "/nope", "/api/ok", "/api/ok", "/api/ok", "/api/ok", "/api/ok"]) { try { await routeGet(p, {}); out.push("ok"); } catch (e) { out.push(e.deskCode); } }
      return { status: "ok", data: { ok: true } };
    },
  });
  const m = await go(mixed.id, { as_of: "current" });
  t.equal(m._deps.fetched.length, 3, "refused calls count against the budget of six");
  const par = mk({
    allowlist: { routes: [{ path: "/api/ok", params: [] }], modules: [], tables: [] },
    run: async ({ routeGet }) => {
      const settled = await Promise.allSettled(Array.from({ length: 10 }, () => routeGet("/api/ok", {})));
      return { status: "ok", data: { ok: true, rejected: settled.filter((s) => s.status === "rejected").length } };
    },
  });
  const p = await go(par.id, { as_of: "current" });
  t.equal(p._deps.fetched.length, 6, "parallel calls cannot exceed the budget either");
  const err = mk({ allowlist: { routes: [{ path: "/api/ok", params: [] }], modules: [], tables: [] }, run: async ({ routeGet }) => { for (let i = 0; i < 7; i++) await routeGet("/api/ok", {}); return { status: "ok", data: { ok: true } }; } });
  const e7 = await go(err.id, { as_of: "current" });
  t.equal(e7.status, "error");
  t.equal(e7.error.code, "too_many_route_calls");
});

test("route responses: oversized bodies are refused, non-JSON is returned as text only, status and ok are reported honestly", async () => {
  const seen = {};
  const tool = mk({
    allowlist: { routes: [{ path: "/api/ok", params: [] }], modules: [], tables: [] },
    run: async ({ routeGet }) => { const r = await routeGet("/api/ok", {}); seen.r = r; return { status: "ok", data: { ok: true } }; },
  });
  const big = await go(tool.id, { as_of: "current" }, { body: "x".repeat(2 * 1024 * 1024 + 1) });
  t.equal(big.error.code, "route_response_too_large");
  const html = await go(tool.id, { as_of: "current" }, { body: "<html>nope</html>" });
  t.equal(html.status, "ok");
  t.equal(seen.r.json, null);
  t.equal(seen.r.text, "<html>nope</html>");
  const five = await go(tool.id, { as_of: "current" }, { status: 503, body: { ok: false } });
  t.equal(seen.r.ok, false); t.equal(seen.r.status, 503);
  for (const status of [301, 302, 303, 307, 308]) {
    seen.r = undefined;
    const redirect = await go(tool.id, { as_of: "current" }, { fetchSelf: async () => new Response("", { status, headers: { Location: "/admin/x" } }) });
    t.equal(redirect.status, "error", `${status}`);
    t.equal(redirect.error.code, "route_redirect_refused", `${status}`);
    t.equal(seen.r, undefined, `a ${status} never reaches the tool as a response`);
    t.equal(redirect._deps.fetched.length, 1, "exactly one request: the redirect target is never requested");
    t.equal(redirect._deps.fetched[0][1].redirect, "manual");
    t.doesNotMatch(JSON.stringify(redirect), /\/admin\/x/, "the Location target is not echoed");
  }
  for (const status of [204, 400, 404, 500]) { const e = await go(tool.id, { as_of: "current" }, { fetchSelf: async () => new Response(status === 204 ? null : "", { status }) }); t.equal(e.status, "ok"); t.equal(seen.r.status, status); t.equal(seen.r.ok, status < 300); }
  const badRes = await go(tool.id, { as_of: "current" }, { fetchSelf: async () => ({ text: async () => "{}" }) });
  t.equal(badRes.error.code, "route_bad_response");
  const redirectLike = undefined; void redirectLike;
  const dead = await go(tool.id, { as_of: "current" }, { fetchSelf: async () => { throw new Error("socket closed: secret-host.internal"); } });
  t.equal(dead.error.code, "route_unreachable");
  t.doesNotMatch(JSON.stringify(dead), /secret-host/, "a network error's text is not passed on");
  const nofetch = await go(tool.id, { as_of: "current" }, { deps: { now: () => NOW, nowMs: () => 0, knowledge: {} } });
  t.equal(nofetch.error.code, "no_fetch_self");
  void five;
});

test("the route timeout aborts a hung request (fake timers) and reports route_timeout", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    let signal = null;
    const tool = mk({
      allowlist: { routes: [{ path: "/api/ok", params: [] }], modules: [], tables: [] },
      run: async ({ routeGet }) => { await routeGet("/api/ok", {}); return { status: "ok", data: { ok: true } }; },
    });
    const deps = mkDeps({ fetchSelf: (url, opts) => new Promise((_, reject) => { signal = opts && opts.signal; opts.signal.addEventListener("abort", () => reject(new Error("aborted"))); }) });
    const p = runTool({ caller }, tool.id, { as_of: "current" }, deps);
    await flush();
    t.ok(signal && signal.aborted === false);
    mock.timers.tick(ROUTE_TIMEOUT_MS - 1);
    await flush();
    t.equal(signal.aborted, false, "not aborted one tick early");
    mock.timers.tick(1);
    const env = await p;
    t.equal(signal.aborted, true);
    t.equal(env.status, "error");
    t.equal(env.error.code, "route_timeout");
    t.equal(ROUTE_TIMEOUT_MS, 8000);
  } finally { mock.timers.reset(); }
});

// ═══ 7. DEFINING TOOLS ═══════════════════════════════════════════════════════════════════════════════════
test("defineTool refuses unsafe or malformed definitions and registers nothing when it refuses", () => {
  const before = listTools().length;
  const cases = [
    ["class P1", { dataClass: "P1" }, /P0 or P2/],
    ["class P3", { dataClass: "P3" }, /P0 or P2/],
    ["class P9", { dataClass: "P9" }, /P0 or P2/],
    ["class missing", { dataClass: undefined }, /P0 or P2/],
    ["class lowercase", { dataClass: "p0" }, /P0 or P2/],
    ["phase P2", { phase: "P2" }, /phase/],
    ["phase P3", { phase: "P3" }, /phase/],
    ["phase missing", { phase: undefined }, /phase/],
    ["readOnly false", { readOnly: false }, /readOnly/],
    ["readOnly missing", { readOnly: undefined }, /readOnly/],
    ["readOnly the string 'true'", { readOnly: "true" }, /readOnly/],
    ["tables with a table", { allowlist: { routes: [], modules: [], tables: ["salary_adjustments"] } }, /tables/],
    ["tables with an empty-string table", { allowlist: { routes: [], modules: [], tables: [""] } }, /tables/],
    ["allowlist missing", { allowlist: undefined }, /allowlist/],
    ["routes not an array", { allowlist: { routes: "/api/x", modules: [], tables: [] } }, /allowlist/],
    ["modules missing", { allowlist: { routes: [], tables: [] } }, /allowlist/],
    ["tables missing", { allowlist: { routes: [], modules: [] } }, /allowlist/],
    ["POST route", { allowlist: { routes: [{ path: "/api/x", params: [], method: "POST" }], modules: [], tables: [] } }, /only GET/],
    ["DELETE route", { allowlist: { routes: [{ path: "/api/x", params: [], method: "DELETE" }], modules: [], tables: [] } }, /only GET/],
    ["lowercase get route", { allowlist: { routes: [{ path: "/api/x", params: [], method: "get" }], modules: [], tables: [] } }, /only GET/],
    ["route without leading slash", { allowlist: { routes: [{ path: "api/x", params: [] }], modules: [], tables: [] } }, /not a plain path/],
    ["route without params list", { allowlist: { routes: [{ path: "/api/x" }], modules: [], tables: [] } }, /bad route/],
    ["route is a string", { allowlist: { routes: ["/api/x"], modules: [], tables: [] } }, /bad route/],
    ["route null", { allowlist: { routes: [null], modules: [], tables: [] } }, /bad route/],
    ["id with uppercase", { id: "Cap.position" }, /id must/],
    ["id with a digit", { id: "cap.pos1tion" }, /id must/],
    ["id without a dot", { id: "cap" }, /id must/],
    ["id with a space", { id: "cap.pos ition" }, /id must/],
    ["id ending in a dot", { id: "cap." }, /id must/],
    ["id with a slash", { id: "cap/position.x" }, /id must/],
    ["id missing", { id: undefined }, /id must/],
    ["version missing", { version: undefined }, /version/],
    ["description too short", { description: "short" }, /description/],
    ["description missing", { description: undefined }, /description/],
    ["run missing", { run: undefined }, /run required/],
    ["run not a function", { run: "return 1" }, /run required/],
    ["inputSchema missing", { inputSchema: undefined }, /inputSchema/],
    ["inputSchema not an object type", { inputSchema: { type: "array", properties: {} } }, /inputSchema/],
    ["inputSchema declares as_of", { inputSchema: { type: "object", properties: { as_of: { type: "string" } } } }, /as_of/],
    ["asOf missing", { asOf: undefined }, /asOf/],
    ["asOf.supports invalid", { asOf: { supports: "always" } }, /asOf/],
    ["asOf.supports 'past'", { asOf: { supports: "past" } }, /asOf/],
    ["output missing", { output: undefined }, /output\.allow/],
    ["output.allow null", { output: { allow: null } }, /output\.allow/],
    ["output.allow empty", { output: { allow: [] } }, /output\.allow/],
    ["output.allow a string", { output: { allow: "ok" } }, /output\.allow/],
    ["output.allow with an empty path", { output: { allow: ["ok", ""] } }, /output\.allow/],
    ["output.allow with a non-string", { output: { allow: ["ok", 5] } }, /output\.allow/],
    ["output without allow", { output: {} }, /output\.allow/],
    ["output is a string", { output: "everything" }, /output\.allow/],
    ["route with a query in the path", { allowlist: { routes: [{ path: "/api/x?y=1", params: [] }], modules: [], tables: [] } }, /not a plain path/],
    ["route with % in the path", { allowlist: { routes: [{ path: "/api/%61dmin", params: [] }], modules: [], tables: [] } }, /not a plain path/],
  ];
  for (const [name, over, re] of cases) {
    const def = baseDef(over);
    if (over.id === undefined && "id" in over) delete def.id;
    for (const k of Object.keys(over)) if (over[k] === undefined) delete def[k];
    let err = null;
    try { defineTool(def); } catch (e) { err = e; }
    t.ok(err, `${name} must be refused`);
    t.match(String(err && err.message), re, name);
    if (def.id) t.equal(getTool(def.id), null, `${name}: nothing registered`);
  }
  for (const nothing of [undefined, null, 5, "tool", []]) t.throws(() => defineTool(nothing));
  t.equal(listTools().length, before, "the registry is unchanged by refused definitions");
});

test("defineTool refuses every forbidden route pattern, in any case, and a write-looking route in any position", () => {
  const forbidden = [
    "/admin", "/admin/", "/admin/snapshot-mfl-now", "/ADMIN/x", "/Admin/x", "/refresh/after-trade", "/refresh/x", "/REFRESH/x", "/reconcile/extensions", "/trade-offers", "/trade-offers/x", "/Trade-Offers",
    "/api/mfl-export", "/api/mfl-export/x", "/API/MFL-EXPORT", "/api/draft-state", "/api/draft-state/x", "/discord/post", "/commish-settings", "/commish", "/commish/anything",
    "/api/foo/write", "/api/foo/post", "/api/foo/import", "/api/foo/backfill", "/api/foo/sync", "/api/foo/commit", "/api/foo/execute", "/api/foo/apply", "/api/foo/cancel", "/api/foo/accept", "/api/foo/decline", "/api/foo/revoke",
    "/api/foo/write/now", "/api/foo/sync-now", "/api/foo/import-all", "/api/foo/WRITE", "/api/trade/accept", "/api/x/cancel-trade",
  ];
  for (const p of forbidden) {
    const err = (() => { try { defineTool(baseDef({ allowlist: { routes: [{ path: p, params: [] }], modules: [], tables: [] } })); return null; } catch (e) { return e; } })();
    t.ok(err, `${p} must be refused`);
    t.match(String(err && err.message), /forbidden pattern/, p);
  }
  for (const p of ["/api/standings", "/api/historical-finishes", "/roster-workbench", "/api/data-freshness"]) {
    const tool = defineTool(baseDef({ allowlist: { routes: [{ path: p, params: ["L"] }], modules: [], tables: [] } }));
    t.equal(getTool(tool.id), tool);
  }
  for (const re of FORBIDDEN_ROUTE_PATTERNS) t.ok(re.flags.includes("i"), `${re} is case-insensitive`);
});

test("duplicate tool ids are refused and the first definition is the one that stays", async () => {
  const first = mk();
  const dupe = baseDef({ id: first.id, run: async () => ({ status: "ok", data: { ok: "second" } }) });
  t.throws(() => defineTool(dupe), /duplicate tool id/);
  t.equal(getTool(first.id), first.def);
  const env = await go(first.id, { as_of: "current" });
  t.equal(env.data.ok, true);
  t.throws(() => defineTool(baseDef({ id: first.id, readOnly: false })), /duplicate tool id/);
});

test("a registered definition is deep-frozen: no list, schema or allowlist can be widened afterwards, and the caller's own arrays are copied", async () => {
  const routes = [{ path: "/api/ok", params: ["L"] }];
  const allow = ["ok"];
  const schema = { type: "object", properties: { q: { type: "string" } }, required: [] };
  const probe = { path: "/api/ok" };
  const tool = mk({ allowlist: { routes, modules: ["m.js"], tables: [] }, output: { allow }, inputSchema: schema, run: async ({ routeGet }) => { await routeGet(probe.path, {}); return { status: "ok", data: { ok: true } }; } });
  const d = tool.def;
  t.ok(Object.isFrozen(d));
  for (const [name, fn] of [
    ["readOnly", () => { d.readOnly = false; }], ["dataClass", () => { d.dataClass = "P2"; }], ["run", () => { d.run = () => ({}); }],
    ["tables", () => { d.allowlist.tables = ["x"]; }], ["routes push", () => { d.allowlist.routes.push({ path: "/api/widened", params: [] }); }],
    ["route path", () => { d.allowlist.routes[0].path = "/api/other"; }], ["route params push", () => { d.allowlist.routes[0].params.push("X"); }],
    ["modules push", () => { d.allowlist.modules.push("x"); }], ["tables push", () => { d.allowlist.tables.push("x"); }],
    ["schema property", () => { d.inputSchema.properties.extra = { type: "string" }; }], ["schema required", () => { d.inputSchema.required.push("q"); }],
    ["schema spec", () => { d.inputSchema.properties.q.maxLength = 99999; }], ["asOf", () => { d.asOf.supports = "current"; }],
    ["output.allow push", () => { d.output.allow.push("owner_notes"); }], ["output.allow replace", () => { d.output.allow[0] = "everything"; }], ["output", () => { d.output = { allow: ["x"] }; }],
  ]) {
    t.throws(fn, TypeError, `${name} must be refused`);
    closed("F10-definition-only-shallow-frozen", false, name);
  }
  const inner = [d.allowlist, d.allowlist.routes, d.allowlist.routes[0], d.allowlist.routes[0].params, d.allowlist.modules, d.allowlist.tables, d.inputSchema, d.inputSchema.properties, d.inputSchema.properties.q, d.inputSchema.required, d.asOf, d.output, d.output.allow];
  closed("F10-definition-only-shallow-frozen", inner.some((x) => !Object.isFrozen(x)), "a part of the definition is still mutable");
  // the arrays the author passed in are not shared with the registered tool
  t.ok(d.allowlist.routes !== routes && d.output.allow !== allow && d.inputSchema !== schema);
  routes.push({ path: "/api/widened", params: [] });
  routes.push({ path: "/admin/backfill", params: [] });
  allow.push("secret_field");
  schema.properties.extra = { type: "string" };
  probe.path = "/api/widened";
  const widened = await go(tool.id, { as_of: "current" });
  closed("F10b-widened-allowlist-takes-effect", widened._deps.fetched.length === 1, "a route pushed into the author's array after registration became callable");
  t.equal(widened.error.code, "route_not_allowlisted");
  probe.path = "/admin/backfill";
  const admin = await go(tool.id, { as_of: "current" });
  t.equal(admin.error.code, "route_not_allowlisted");
  t.equal(admin._deps.fetched.length, 0);
  t.deepEqual(d.output.allow, ["ok"]);
  t.equal((await go(tool.id, { as_of: "current", extra: "x" })).error.code, "bad_arguments", "an argument added to the author's schema afterwards is still unknown");
  probe.path = "/api/ok";
  t.equal((await go(tool.id, { as_of: "current" })).status, "ok");
});

// ═══ 8. WHAT COMES BACK ══════════════════════════════════════════════════════════════════════════════════
test("the output allowlist drops every unlisted field, at every depth, through arrays (paths are relative to data)", async () => {
  const tool = mk({
    output: { allow: ["standings[].franchise_id", "standings[].record.w", "totals.cap_used", "label", "list"] },
    run: async () => ({
      status: "ok",
      data: {
        label: "x", hidden_top: "NO", list: ["a", "b"],
        standings: [
          { franchise_id: "0001", owner_name: "NO", record: { w: 5, l: 6, hidden: "NO" }, extra: [1, 2] },
          { franchise_id: "0002", record: { w: 7 } },
          { franchise_id: "0003", record: { l: 9 } },
          "stray string", null, 42,
        ],
        totals: { cap_used: 10, cap_hidden: 99 }, other: { deep: { deeper: "NO" } },
      },
    }),
  });
  const env = await go(tool.id, { as_of: "current" });
  t.equal(env.status, "ok");
  t.deepEqual(env.data, {
    label: "x", list: ["a", "b"],
    standings: [{ franchise_id: "0001", record: { w: 5 } }, { franchise_id: "0002", record: { w: 7 } }, { franchise_id: "0003", record: {} }, "stray string", null, 42],
    totals: { cap_used: 10 },
  });
  t.doesNotMatch(JSON.stringify(env), /"NO"|owner_name|hidden|cap_hidden|deeper/);
});

test("an allowlist written with a 'data.' prefix keeps nothing (fails closed); an allowlist naming only unsafe keys keeps nothing", async () => {
  const prefixed = mk({ output: { allow: ["data.label"] }, run: async () => ({ status: "ok", data: { label: "x" } }) });
  t.deepEqual((await go(prefixed.id, { as_of: "current" })).data, {});
  const unsafe = mk({ output: { allow: ["__proto__", "constructor", "prototype", "__proto__.role", "a.__proto__"] }, run: async () => ({ status: "ok", data: JSON.parse('{"constructor":{"x":1},"prototype":1,"__proto__":{"role":"admin"},"a":{"__proto__":{"role":"admin"},"b":1}}') }) });
  const ue = await go(unsafe.id, { as_of: "current" });
  t.equal(ue.status, "ok");
  t.equal(Object.getPrototypeOf(ue.data), Object.prototype);
  t.equal(ue.data.role, undefined);
  t.doesNotMatch(JSON.stringify(ue.data), /admin|constructor|prototype/);
});

test("an allowed key without sub-keys passes its whole subtree (so allowlist leaves, not branches)", async () => {
  const tool = mk({ output: { allow: ["branch"] }, run: async () => ({ status: "ok", data: { branch: { a: 1, b: { c: 2 } }, other: 1 } }) });
  const env = await go(tool.id, { as_of: "current" });
  t.deepEqual(env.data, { branch: { a: 1, b: { c: 2 } } });
});

test("secret-looking keys are stripped at any depth, in arrays, even when the tool's own allowlist lets them through", async () => {
  const keys = ["email", "e_mail", "cookie", "apikey", "api_key", "token", "password", "passwd", "secret", "authorization", "mfl_user_id", "phone", "EMAIL", "Cookie", "API_KEY", "access_token", "token_value", "x_secret_y", "owner_email", "auth_cookie", "apiKey", "session_id", "bearer", "credential"];
  const leaf = {}; for (const k of keys) leaf[k] = "LEAK";
  const nested = { keep: "ok", ...leaf, deeper: { keep2: "ok", ...leaf, arr: [{ keep3: "ok", ...leaf }, [{ ...leaf, keep4: "ok" }]] } };
  const tool = mk({ output: { allow: ["keep", "deeper.keep2", "deeper.arr", ...keys, ...keys.map((k) => `deeper.${k}`)] }, run: async () => ({ status: "ok", data: nested }) });
  const env = await go(tool.id, { as_of: "current" });
  t.equal(env.status, "ok");
  t.doesNotMatch(JSON.stringify(env.data), /LEAK/);
  t.equal(env.data.keep, "ok");
  t.equal(env.data.deeper.keep2, "ok");
  t.equal(env.data.deeper.arr[0].keep3, "ok");
  t.equal(env.data.deeper.arr[1][0].keep4, "ok");
  t.equal(env.provenance.redactions, keys.length * 4, "every stripped key is counted");
  for (const k of keys) t.ok(isSecretKey(k), `${k} is a secret key`);
});

test("secret key matching sees through every realistic spelling: camelCase, plurals, hyphens, spaces, accents, digits, case", async () => {
  const candidates = ["userEmail", "emailAddress", "accessToken", "authToken", "csrfToken", "sessionCookie", "setCookie", "api-key", "x-api-key", "emails", "cookies", "tokens", "passwords", "secrets", "apiKeys", "mflUserId", "mfl-user-id", "MFL_USER_ID", "phoneNumber", "e-mail", "E-Mail", "Authorization", "e mail", "api key", "pass_word", "user.email", "email1", "1email", "x_e_m_a_i_l", "TOKEN", "refreshToken", "bearerToken", "sessionId", "credentials", "client_secret", "private_apiKey", "owner_phone", "e\u0301mail", "email\u200b"];
  const survivors = [];
  for (const k of candidates) {
    const tool = mk({ output: { allow: [k] }, run: async () => ({ status: "ok", data: { [k]: "LEAK", other: "x" } }) });
    const env = await go(tool.id, { as_of: "current" });
    if (env.data && k in env.data) survivors.push(k);
    t.ok(isSecretKey(k), `${JSON.stringify(k)} is recognized`);
  }
  closed("F11-secret-key-regex-misses-spellings", survivors.length > 0, `these spellings were not stripped: ${survivors.join(", ")}`);
  t.ok(candidates.length > 35);
  for (const harmless of ["franchise_id", "salary", "cap_room", "label", "season", "owner_name", "status", "player_id", "contract_status", "rank"]) t.equal(isSecretKey(harmless), false, `${harmless} is not a secret key`);
  t.equal(SECRET_KEY_RE.test("email"), true);
});

test("every part of the result is projected, bounded and stripped, not just data: provenance, freshness, coverage gaps, refusal, error", async () => {
  const tool = mk({
    run: async () => ({
      status: "ok", data: { ok: true }, facts: [],
      provenance: { email: "provenance@leak.example", userToken: "T", nested: { api_key: "K", fine: 1 }, route: "/api/x" },
      freshness: { cookie: "freshness-leak", checked_at: "2026-11-19" },
      coverage: { supported: false, gaps: [{ what: "x", why: "NO_RECORD", source_needed: "y", token: "gap-leak", extra: { password: "p" } }] },
      error: { code: "weird code!", message: "m", stack: "STACK at /srv/x.js:1", token: "error-leak" },
    }),
  });
  const env = await go(tool.id, { as_of: "current" });
  const text = JSON.stringify(env);
  closed("F12-side-channels-unfiltered", /provenance@leak|freshness-leak|gap-leak|error-leak|STACK|"K"|"T"|"p"/.test(text), "a secret or a stack reached the envelope through provenance, freshness, a gap or error");
  t.equal(env.provenance.nested.fine, 1);
  t.equal(env.provenance.route, "/api/x");
  t.equal(env.freshness.checked_at, "2026-11-19");
  t.deepEqual(env.coverage.gaps, [{ what: "x", why: "NO_RECORD", source_needed: "y" }], "a gap is normalized to its three fields");
  t.deepEqual(Object.keys(env.error).sort(), ["code", "message"]);
  t.equal(env.error.code, "weirdcode", "an error code is reduced to letters, digits and underscore");
  t.ok(env.provenance.redactions >= 4);
  // refusal: fixed shape
  const refused = mk({ run: async () => ({ status: "refused", refusal: { code: "stale_data", reason: "r".repeat(1000), token: "refusal-leak", stack: "S" } }) });
  const re = await go(refused.id, { as_of: "current" });
  t.deepEqual(Object.keys(re.refusal).sort(), ["code", "reason"]);
  t.equal(re.refusal.reason.length, 300);
  t.doesNotMatch(JSON.stringify(re), /refusal-leak/);
});

test("whole-result bounds: huge provenance, freshness, gap lists, deep or wide structures cannot flood the envelope", async () => {
  const mkRun = (extra) => mk({ run: async () => ({ status: "ok", data: { ok: true }, ...extra() }) });
  const blob = mkRun(() => ({ provenance: { blob: "x".repeat(300000) } }));
  const be = await go(blob.id, { as_of: "current" });
  t.equal(be.status, "ok");
  t.equal(be.provenance.blob.length, 2000, "a long string is cut");
  const wide = mkRun(() => ({ provenance: Object.fromEntries(Array.from({ length: 500 }, (_, i) => [`k${i}`, "v".repeat(1500)])) }));
  const we = await go(wide.id, { as_of: "current" });
  closed("F13-envelope-size-unbounded", we.status === "ok" && JSON.stringify(we).length > MAX_OUTPUT_BYTES, "a wide provenance went through whole");
  t.equal(we.error && we.error.code, "output_too_large", "500 keys of 1500 characters: capped at 80 keys, and the result still counts against the byte limit");
  const manyGaps = mkRun(() => ({ coverage: { supported: true, gaps: Array.from({ length: MAX_GAPS + 1 }, (_, i) => ({ what: `g${i}`, why: "NO_RECORD", source_needed: "y" })) } }));
  t.equal((await go(manyGaps.id, { as_of: "current" })).error.code, "bad_coverage");
  const okGaps = mkRun(() => ({ coverage: { supported: false, gaps: Array.from({ length: MAX_GAPS }, (_, i) => ({ what: "w".repeat(1000), why: "stale", source_needed: "s".repeat(1000) })) } }));
  const og = await go(okGaps.id, { as_of: "current" });
  t.equal(og.coverage.gaps.length, MAX_GAPS);
  t.ok(og.coverage.gaps.every((g) => g.what.length === 300 && g.source_needed.length === 300));
  for (const bad of [{ why: "made_up" }, { why: "" }, { why: undefined }, { why: 5 }, "gap", null, 7, []]) {
    const g = mkRun(() => ({ coverage: { supported: false, gaps: [typeof bad === "object" && bad !== null && !Array.isArray(bad) ? { what: "x", source_needed: "y", ...bad } : bad] } }));
    t.equal((await go(g.id, { as_of: "current" })).error.code, "bad_coverage", JSON.stringify(bad));
  }
  t.equal((await go(mkRun(() => ({ coverage: { supported: false, gaps: "none" } })).id, { as_of: "current" })).error.code, "bad_coverage");
  const bigFresh = mkRun(() => ({ freshness: { note: "f".repeat(1999), more: "f".repeat(1999) } }));
  t.equal((await go(bigFresh.id, { as_of: "current" })).freshness, null, "an oversized freshness block is dropped, not passed");
  const deep = mkRun(() => { let o = { leaf: 1 }; for (let i = 0; i < 50; i++) o = { a: o }; return { provenance: o }; });
  const de = await go(deep.id, { as_of: "current" });
  t.equal(de.status, "ok");
  t.ok(JSON.stringify(de.provenance).length < 400, "depth is limited");
  t.ok(de.provenance.truncated > 0, "and the cut is counted");
  const arr = mk({ output: { allow: ["rows"] }, run: async () => ({ status: "ok", data: { rows: Array.from({ length: 5000 }, (_, i) => i) } }) });
  const ae = await go(arr.id, { as_of: "current" });
  t.equal(ae.data.rows.length, 400);
  t.ok(ae.provenance.truncated > 0);
  const keys = mk({ output: { allow: ["obj"] }, run: async () => ({ status: "ok", data: { obj: Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`k${i}`, i])) } }) });
  t.equal(Object.keys((await go(keys.id, { as_of: "current" })).data.obj).length, 80);
});

test("sanitizing flattens values safely: BigInt to string, NaN/Infinity/function/symbol/undefined to null, long strings cut", async () => {
  const tool = mk({ output: { allow: ["n", "nan", "inf", "fn", "sym", "und", "nul", "s", "b", "neg0", "date", "nested"] }, run: async () => ({ status: "ok", data: { n: 10n, nan: NaN, inf: Infinity, fn: () => 1, sym: Symbol("x"), und: undefined, nul: null, s: "é".repeat(3000), b: true, neg0: -0, date: new Date("2026-01-01"), nested: [undefined, NaN, 10n] } }) });
  const e = await go(tool.id, { as_of: "current" });
  t.equal(e.status, "ok");
  t.deepEqual(e.data.nested, [null, null, "10"]);
  t.equal(e.data.n, "10"); t.equal(e.data.nan, null); t.equal(e.data.inf, null); t.equal(e.data.fn, null); t.equal(e.data.sym, null); t.equal(e.data.und, null); t.equal(e.data.nul, null);
  t.equal(e.data.s.length, 2000); t.equal(e.data.b, true);
  t.deepEqual(e.data.date, {}, "a Date has no own keys and is flattened to an empty object");
});

test("the output size limit counts UTF-8 bytes over data, provenance and freshness together", async () => {
  const items = (n, ch) => mk({ output: { allow: ["rows"] }, run: async () => ({ status: "ok", data: { rows: Array.from({ length: n }, () => ch.repeat(2000)) } }) });
  let firstFail = null;
  for (let n = 1; n <= 40; n++) { const e = await go(items(n, "x").id, { as_of: "current" }); if (e.status === "error") { firstFail = n; t.equal(e.error.code, "output_too_large"); t.equal(e.data, null); break; } }
  t.ok(firstFail !== null && firstFail > 20 && firstFail < 35, `limit reached at ${firstFail} items of 2000 bytes`);
  t.ok(firstFail * 2000 > MAX_OUTPUT_BYTES && (firstFail - 1) * 2000 < MAX_OUTPUT_BYTES, "the boundary sits at the byte limit");
  t.equal((await go(items(firstFail - 1, "x").id, { as_of: "current" })).status, "ok");
  // four-byte characters: 2000 UTF-16 units = 4000 bytes
  t.equal((await go(items(10, "\u{1F600}").id, { as_of: "current" })).status, "ok", "10 x 4000 bytes is under the limit");
  const emoji = await go(items(16, "\u{1F600}").id, { as_of: "current" });
  closed("F14-size-measured-in-utf16-units", emoji.status === "ok", "16 x 4000 UTF-8 bytes (32000 UTF-16 units) was accepted although it is over the byte limit");
  t.equal(emoji.error.code, "output_too_large");
  t.equal(MAX_OUTPUT_BYTES, 60 * 1024);
  const wide = mk({ output: { allow: ["rows[].n"] }, run: async () => ({ status: "ok", data: { rows: Array.from({ length: 20000 }, (_, i) => ({ n: i })) } }) });
  t.equal((await go(wide.id, { as_of: "current" })).status, "ok", "an oversized list is cut to 400 rows, which fits");
});

test("data class: a P0 tool cannot return P2, nothing can return P3 or an invented class, and the envelope is empty when refused", async () => {
  for (const cls of ["P1", "P2", "P3", "P4", "p0", "", "constructor", "__proto__", "toString", "hasOwnProperty", 0, 1, null, {}, "P0\n"]) {
    const tool = mk({ dataClass: "P0", run: async () => ({ status: "ok", data: { ok: true }, data_class: cls }) });
    const env = await go(tool.id, { as_of: "current" });
    if (cls === "" || cls === null) { t.equal(env.status, "ok", `${JSON.stringify(cls)} means "not stated" and falls back to the tool's own class`); t.equal(env.data_class, "P0"); continue; }
    t.equal(env.status, "forbidden", JSON.stringify(cls));
    t.equal(env.error.code, "data_class_exceeded", JSON.stringify(cls));
    t.equal(env.data, null);
    t.deepEqual(env.facts, []);
  }
  const p2 = mk({ dataClass: "P2", run: async () => ({ status: "ok", data: { ok: true } }) });
  const e2 = await go(p2.id, { as_of: "current" });
  t.equal(e2.status, "ok"); t.equal(e2.data_class, "P2");
  const p2low = mk({ dataClass: "P2", run: async () => ({ status: "ok", data: { ok: true }, data_class: "P0" }) });
  t.equal((await go(p2low.id, { as_of: "current" })).data_class, "P0", "a result may be marked lower than the tool");
  for (const cls of ["P3", "P9"]) {
    const up = mk({ dataClass: "P2", run: async () => ({ status: "ok", data: { ok: true }, data_class: cls }) });
    t.equal((await go(up.id, { as_of: "current" })).error.code, "data_class_exceeded", cls);
  }
});

test("a caller whose ceiling is too low cannot run a P2 tool (class gate at the registry)", async () => {
  const p2 = mk({ dataClass: "P2" });
  const lowFrozenForgery = Object.freeze({ class: "commish", proven: true, scope: "desk", franchiseId: "0001", ceiling: "P0" });
  const env = await go(p2.id, { as_of: "current" }, { caller: lowFrozenForgery });
  t.equal(env.status, "forbidden");
  t.equal(p2.spy.ran, 0);
  t.equal(C.classAllowed("P2", "P3"), false);
  t.equal(C.classAllowed("P3", "P3"), false, "no ceiling can ever hold P3");
  t.equal(C.classAllowed("P1", "P2"), false);
  t.equal(C.classAllowed("P2", "P2"), true);
  t.equal(C.classAllowed("P2", "constructor"), false);
  t.equal(C.classAllowed("__proto__", "P0"), false);
});

test("statuses: only the five a tool may return pass; 'forbidden' and anything else is a bad_tool_status error", async () => {
  for (const st of ["ok", "refused", "unsupported_as_of", "no_record", "error"]) {
    const tool = mk({ run: async () => ({ status: st, data: { ok: true }, ...(st === "refused" ? { refusal: { code: "stale_data", reason: "x" } } : {}) }) });
    t.equal((await go(tool.id, { as_of: "current" })).status, st);
  }
  for (const st of ["forbidden", "OK", "ok ", "success", "", undefined, null, 1, true, {}, "__proto__"]) {
    const tool = mk({ run: async () => ({ status: st, data: { ok: true } }) });
    const env = await go(tool.id, { as_of: "current" });
    t.equal(env.status, "error", String(st));
    t.equal(env.error.code, "bad_tool_status");
    t.equal(env.data, null);
  }
  for (const out of [undefined, null, "ok", 5, true]) {
    const tool = mk({ run: async () => out });
    const env = await go(tool.id, { as_of: "current" });
    t.equal(env.status, "error", String(out));
    t.equal(env.error.code, "bad_tool_output");
  }
  const arr = mk({ run: async () => [] });
  t.equal((await go(arr.id, { as_of: "current" })).error.code, "bad_tool_status");
  for (const [name, raw] of [["no refusal", { status: "refused", data: null }], ["unknown code", { status: "refused", refusal: { code: "totally_made_up", reason: "x" } }], ["refusal a string", { status: "refused", refusal: "stale_data" }], ["code inherited name", { status: "refused", refusal: { code: "constructor" } }], ["code uppercase", { status: "refused", refusal: { code: "STALE_DATA" } }]]) {
    const e = await go(mk({ run: async () => raw }).id, { as_of: "current" });
    closed("F15-refusal-shape-unchecked", e.status === "refused", `${name}: a refused result without a known refusal code was passed`);
    t.equal(e.error.code, "bad_refusal", name);
  }
  for (const code of C.REFUSAL_CODES) { const e = await go(mk({ run: async () => ({ status: "refused", refusal: { code, reason: "why" } }) }).id, { as_of: "current" }); t.equal(e.refusal.code, code); t.deepEqual(e.facts, []); }
  const notRefused = await go(mk({ run: async () => ({ status: "no_record", refusal: { code: "stale_data", reason: "x" } }) }).id, { as_of: "current" });
  t.equal(notRefused.refusal, null, "a refusal on a non-refused result is ignored");
});

// ── facts ───────────────────────────────────────────────────────────────────────────────────────────────
const fact = (over = {}) => ({ key: "cap", label: "Cap", value: 5000, unit: "usd", grade: "A", ...over });

test("facts are accepted only on an ok result: every other status with a fact becomes an error and the facts are dropped", async () => {
  for (const st of ["refused", "unsupported_as_of", "no_record", "error"]) {
    const tool = mk({ run: async () => ({ status: st, facts: [fact()], data: null, refusal: { code: "stale_data", reason: "x" } }) });
    const env = await go(tool.id, { as_of: "current" });
    t.equal(env.status, "error", st);
    t.equal(env.error.code, "facts_on_non_ok", st);
    t.deepEqual(env.facts, [], st);
  }
  const empty = mk({ run: async () => ({ status: "no_record", facts: [], data: null }) });
  t.equal((await go(empty.id, { as_of: "current" })).status, "no_record");
  const ok = mk({ run: async () => ({ status: "ok", facts: [fact()], data: { ok: true } }) });
  t.equal((await go(ok.id, { as_of: "current" })).facts.length, 1);
});

test("fact validation: bad keys, units, grades and values are refused; the whole result becomes an error", async () => {
  const bad = [
    ["unit unknown", fact({ unit: "dollars" })], ["unit uppercase", fact({ unit: "USD" })], ["unit missing", fact({ unit: undefined })], ["unit hours", fact({ unit: "hours" })],
    ["grade lowercase", fact({ grade: "a" })], ["grade E", fact({ grade: "E" })], ["grade 'NO RECORD'", fact({ grade: "NO RECORD" })], ["grade missing", fact({ grade: undefined })], ["grade empty", fact({ grade: "" })],
    ["key uppercase", fact({ key: "Cap" })], ["key leading digit", fact({ key: "1cap" })], ["key with space", fact({ key: "cap used" })], ["key with a dot (pre-namespaced)", fact({ key: "c1.cap" })],
    ["key with a dash", fact({ key: "cap-used" })], ["key empty", fact({ key: "" })], ["key null", fact({ key: null })], ["key number", fact({ key: 5 })], ["key missing", fact({ key: undefined })],
    ["key leading underscore", fact({ key: "_cap" })], ["key 65 chars", fact({ key: `a${"b".repeat(64)}` })], ["key with a newline", fact({ key: "cap\n" })], ["key unicode", fact({ key: "cаp" })],
    ["value undefined", fact({ value: undefined })], ["value object", fact({ value: { a: 1 } })], ["value array", fact({ value: [1] })],
    ["value null", fact({ value: null })], ["value NaN", fact({ value: NaN })], ["value Infinity", fact({ value: Infinity })], ["value -Infinity", fact({ value: -Infinity })],
    ["value BigInt", fact({ value: 10n })], ["value function", fact({ value: () => 1 })], ["value symbol", fact({ value: Symbol("x") })],
    ["value string over 400 chars", fact({ unit: "text", value: "x".repeat(401) })], ["value huge string", fact({ unit: "text", value: "x".repeat(500000) })],
    ["fact is null", null], ["fact is a string", "cap"], ["fact is a number", 5],
  ];
  for (const [name, f] of bad) {
    const tool = mk({ run: async () => ({ status: "ok", facts: [f], data: { ok: true } }) });
    const env = await go(tool.id, { as_of: "current" });
    t.equal(env.status, "error", name);
    t.equal(env.error.code, "bad_fact", name);
    t.deepEqual(env.facts, [], name);
  }
  const dup = mk({ run: async () => ({ status: "ok", facts: [fact(), fact({ value: 6 })], data: { ok: true } }) });
  t.equal((await go(dup.id, { as_of: "current" })).error.code, "bad_fact");
  const good = mk({ run: async () => ({ status: "ok", facts: [fact({ key: "a_1" }), fact({ key: `a${"b".repeat(63)}` }), fact({ key: "t", unit: "text", value: "x".repeat(400) }), fact({ key: "b", unit: "text", value: true }), fact({ key: "z", value: 0 }), fact({ key: "neg", value: -1234.5 })], data: { ok: true } }) });
  t.equal((await go(good.id, { as_of: "current" })).facts.length, 6);
});

test("fact ids are namespaced cN.key by the registry; a tool cannot choose or spoof its namespace", async () => {
  const tool = mk({ run: async () => ({ status: "ok", facts: [fact({ key: "cap_used", label: "L".repeat(500), source: "S".repeat(500), as_of: "2025-01-01" }), fact({ key: "cap_room", unit: "text", value: "x", grade: "NO_RECORD" })], data: { ok: true } }) });
  const env = await go(tool.id, { as_of: "current" }, { seq: 7 });
  t.equal(env.call_id, "c7");
  t.deepEqual(env.facts.map((f) => f.id), ["c7.cap_used", "c7.cap_room"]);
  t.ok(env.facts.every((f) => C.isFactId(f.id)));
  t.equal(env.facts[0].label.length, 120); t.equal(env.facts[0].source.length, 160);
  t.equal(env.facts[0].as_of, "2025-01-01");
  t.equal(env.facts[1].as_of, "current", "the request's as_of fills a missing one");
  t.equal(env.facts[1].source, tool.id);
  t.deepEqual(Object.keys(env.facts[0]).sort(), ["as_of", "grade", "id", "label", "source", "unit", "value"]);
  for (const spoof of ["c1.cap_used", "c9.cap_used", "cap_used.x"]) {
    const sp = mk({ run: async () => ({ status: "ok", facts: [fact({ key: spoof })], data: { ok: true } }) });
    t.equal((await go(sp.id, { as_of: "current" })).error.code, "bad_fact", spoof);
  }
  // concurrency: two simultaneous runs of one tool keep separate namespaces
  const [a, b] = await Promise.all([go(tool.id, { as_of: "current" }, { seq: 3 }), go(tool.id, { as_of: "current" }, { seq: 4 })]);
  t.equal(a.facts[0].id, "c3.cap_used"); t.equal(b.facts[0].id, "c4.cap_used");
  // a nonsense sequence number is clamped to 1..999, so a fact id is never malformed
  for (const [s, want] of [[1000, "c999"], [99999, "c999"], [0, "c1"], [-3, "c1"], [1.5, "c1"], ["x", "c1"], [NaN, "c1"], [null, "c1"], [undefined, "c1"], ["12", "c12"], [{}, "c1"], [Infinity, "c999"]]) {
    const e = await go(tool.id, { as_of: "current" }, { seq: s });
    t.equal(e.status, "ok", `seq ${String(s)}`);
    t.equal(e.call_id, want, `seq ${String(s)}`);
    t.ok(e.facts.every((f) => C.isFactId(f.id) && f.id.startsWith(`${want}.`)), `seq ${String(s)}`);
  }
});

test("fact bounds: MAX_FACTS, finite numbers only, strings up to 400 characters, no objects", async () => {
  t.equal(MAX_FACTS, 200);
  const many = (n) => mk({ run: async () => ({ status: "ok", facts: Array.from({ length: n }, (_, i) => fact({ key: `k${i}` })), data: { ok: true } }) });
  const atMax = await go(many(MAX_FACTS).id, { as_of: "current" });
  t.equal(atMax.status, "ok");
  t.equal(atMax.facts.length, MAX_FACTS);
  const over = await go(many(MAX_FACTS + 1).id, { as_of: "current" });
  closed("F16-fact-values-unbounded", over.status === "ok", "more than MAX_FACTS facts were accepted");
  t.equal(over.error.code, "too_many_facts");
  t.deepEqual(over.facts, []);
  const flood = await go(many(3000).id, { as_of: "current" });
  t.equal(flood.error.code, "too_many_facts");
  for (const value of [null, NaN, Infinity, -Infinity, "x".repeat(401), 10n, {}, [], undefined]) {
    const e = await go(mk({ run: async () => ({ status: "ok", facts: [fact({ unit: value === "x".repeat(401) ? "text" : "usd", value })], data: { ok: true } }) }).id, { as_of: "current" });
    closed("F16-fact-values-unbounded", e.status === "ok", `fact value ${String(value).slice(0, 12)} was accepted`);
    t.equal(e.error.code, "bad_fact");
  }
  const full = await go(mk({ run: async () => ({ status: "ok", facts: Array.from({ length: MAX_FACTS }, (_, i) => fact({ key: `k${i}`, unit: "text", value: "v".repeat(40), label: "l".repeat(60), source: "s".repeat(60) })), data: { ok: true } }) }).id, { as_of: "current" });
  t.equal(full.status, "ok");
  t.ok(JSON.stringify(full.facts).length < 200 * 800, "facts are bounded even at their maximum");
  residual("R4-facts-and-coverage-not-in-byte-limit", JSON.stringify(full).length > MAX_OUTPUT_BYTES, "registry.js line 405 (byteLength counts data, provenance and freshness only)",
    `Facts (200 x up to ~700 bytes), coverage gaps (20 x ~600) and the error object are bounded individually but not counted in MAX_OUTPUT_BYTES, so a result can reach ${JSON.stringify(full).length} bytes. Bounded, so low risk; count the whole envelope if a hard 60 KB ceiling matters.`);
});

// ═══ 9. FAILURE ═══════════════════════════════════════════════════════════════════════════════════════════
test("a tool that throws returns an error envelope with no stack, no message text, no file paths", async () => {
  const throwers = [
    () => { throw new Error("db password=hunter2 at /srv/app/secret.js:12:3"); },
    async () => { throw new TypeError("Cannot read properties of undefined (reading 'x') at Object.<anonymous> (/Users/x/y.js:1:1)"); },
    async () => { await Promise.resolve(); throw "plain string secret-token-123"; },
    async () => { throw { message: "obj secret", stack: "STACKTRACE at line" }; },
    async () => { throw null; },
    async () => { throw undefined; },
    () => Promise.reject(new Error("rejected hunter2")),
    async () => { const e = new Error("with cause hunter2"); e.cause = new Error("inner hunter2"); throw e; },
  ];
  for (const fn of throwers) {
    const tool = mk({ run: fn });
    const env = await go(tool.id, { as_of: "current" });
    t.equal(env.status, "error");
    t.equal(env.error.code, "tool_exception");
    t.equal(env.error.message, "the tool failed");
    const text = JSON.stringify(env);
    t.doesNotMatch(text, /hunter2|secret|stack|STACKTRACE|\bat \w|\.js:\d|\/srv\/|\/Users\//i);
    t.equal(env.data, null);
    t.deepEqual(env.facts, []);
  }
});

test("a tool that hangs is cut off at TOOL_TIMEOUT_MS (fake timers); a zombie tool may still issue route calls afterward (residual)", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    let release;
    const gate = new Promise((r) => { release = r; });
    const tool = mk({
      allowlist: { routes: [{ path: "/api/ok", params: [] }], modules: [], tables: [] },
      run: async ({ routeGet }) => { await gate; await routeGet("/api/ok", {}); return { status: "ok", data: { ok: true } }; },
    });
    const deps = mkDeps();
    const p = runTool({ caller }, tool.id, { as_of: "current" }, deps);
    await flush();
    mock.timers.tick(TOOL_TIMEOUT_MS - 1);
    await flush();
    let settled = false; p.then(() => { settled = true; });
    await flush();
    t.equal(settled, false, "still running one tick before the limit");
    mock.timers.tick(1);
    const env = await p;
    t.equal(env.status, "error");
    t.equal(env.error.code, "tool_timeout");
    t.equal(TOOL_TIMEOUT_MS, 12000);
    t.equal(deps.fetched.length, 0);
    release();
    await flush();
    residual("R3-timed-out-tool-keeps-running", deps.fetched.length > 0, "registry.js lines 250-254 and 334-337 (withTimeout races the promise but cannot cancel it)",
      "After tool_timeout the tool's coroutine is still alive and keeps its routeGet (up to the six-call budget). It can issue more GET requests after the question already got its error envelope. Read-only, bounded, so low risk; fix by flipping a `cancelled` flag that routeGet checks.");
    t.equal(env.data, null);
  } finally { mock.timers.reset(); }
});

test("an audit callback that throws never breaks a call; audit entries record tool, call id, routes, status and time", async () => {
  const tool = mk({ allowlist: { routes: [{ path: "/api/ok", params: [] }], modules: [], tables: [] }, run: async ({ routeGet }) => { await routeGet("/api/ok", {}); return { status: "ok", data: { ok: true } }; } });
  const boom = await go(tool.id, { as_of: "current" }, { audit: () => { throw new Error("audit sink down"); } });
  t.equal(boom.status, "ok");
  const env = await go(tool.id, { as_of: "current" }, { seq: 9 });
  const e = env._deps.audits[0];
  t.equal(e.tool, tool.id); t.equal(e.call_id, "c9"); t.equal(e.status, "ok");
  t.equal(e.routes.length, 1); t.equal(e.routes[0].path, "/api/ok"); t.equal(e.routes[0].status, 200);
  t.equal(typeof e.ms, "number");
  const forb = await go(tool.id, { as_of: "current" }, { caller: {} });
  t.equal(forb._deps.audits[0].status, "forbidden", "refused calls are audited too");
  const unk = await go("no.such_tool", { as_of: "current" });
  t.equal(unk._deps.audits[0].status, "forbidden");
});

test("runTool NEVER rejects: circular, BigInt, deep, throwing-getter and non-iterable results all become envelopes", async () => {
  const circular = {}; circular.self = circular; circular.arr = [circular];
  const cyc2 = []; cyc2.push(cyc2);
  let deepArr = []; for (let i = 0; i < 40000; i++) deepArr = [deepArr];
  let deepObj = { leaf: 1 }; for (let i = 0; i < 40000; i++) deepObj = { a: deepObj };
  const getter = {}; Object.defineProperty(getter, "boom", { enumerable: true, get() { throw new Error("getter hunter2"); } });
  const proxyData = new Proxy({}, { ownKeys() { throw new Error("proxy hunter2"); }, has() { throw new Error("proxy hunter2"); }, getOwnPropertyDescriptor() { throw new Error("proxy hunter2"); } });
  const cases = {
    "circular data": [{ output: { allow: ["self", "arr"] }, run: async () => ({ status: "ok", data: circular }) }, "ok"],
    "circular array": [{ output: { allow: ["a"] }, run: async () => ({ status: "ok", data: { a: cyc2 } }) }, "ok"],
    "BigInt in data": [{ output: { allow: ["n"] }, run: async () => ({ status: "ok", data: { n: 10n } }) }, "ok"],
    "very deep object": [{ output: { allow: ["a"] }, run: async () => ({ status: "ok", data: deepObj }) }, "ok"],
    "very deep array under a path": [{ output: { allow: ["a[].b"] }, run: async () => ({ status: "ok", data: { a: deepArr } }) }, "any"],
    "data that is a deeply nested array": [{ output: { allow: ["x"] }, run: async () => ({ status: "ok", data: deepArr }) }, "any"],
    "throwing getter": [{ output: { allow: ["boom"] }, run: async () => ({ status: "ok", data: getter }) }, "error"],
    "throwing proxy": [{ output: { allow: ["boom"] }, run: async () => ({ status: "ok", data: proxyData }) }, "error"],
    "facts not iterable (object)": [{ run: async () => ({ status: "ok", data: { ok: true }, facts: { a: 1 } }) }, "error"],
    "facts a string": [{ run: async () => ({ status: "ok", data: { ok: true }, facts: "abc" }) }, "error"],
    "facts a number": [{ run: async () => ({ status: "ok", data: { ok: true }, facts: 5 }) }, "error"],
    "fact label with a throwing toString": [{ run: async () => ({ status: "ok", data: { ok: true }, facts: [{ key: "a", label: { toString() { throw new Error("hunter2"); } }, value: 1, unit: "count", grade: "A" }] }) }, "error"],
    "fact is a Proxy that throws": [{ run: async () => ({ status: "ok", data: { ok: true }, facts: [new Proxy({}, { get() { throw new Error("hunter2"); } })] }) }, "error"],
    "provenance circular": [{ run: async () => ({ status: "ok", data: { ok: true }, provenance: circular }) }, "ok"],
    "freshness circular": [{ run: async () => ({ status: "ok", data: { ok: true }, freshness: circular }) }, "ok"],
    "coverage getter throws": [{ run: async () => ({ status: "ok", data: { ok: true }, coverage: { get gaps() { throw new Error("hunter2"); } } }) }, "error"],
    "error object circular": [{ run: async () => ({ status: "error", error: circular }) }, "error"],
    "refusal getter throws": [{ run: async () => ({ status: "refused", refusal: { get code() { throw new Error("hunter2"); } } }) }, "error"],
    "result object with a throwing status getter": [{ run: async () => ({ get status() { throw new Error("hunter2"); } }) }, "error"],
    "run returns a throwing Proxy": [{ run: async () => new Proxy({}, { get() { throw new Error("hunter2"); } }) }, "error"],
    "run throws synchronously": [{ run: () => { throw new Error("hunter2"); } }, "error"],
    "run rejects with a BigInt": [{ run: async () => { throw 10n; } }, "error"],
    "run rejects with an Error whose message getter throws": [{ run: async () => { const e = new Error("x"); Object.defineProperty(e, "message", { get() { throw new Error("hunter2"); } }); throw e; } }, "error"],
    "asOf.check throws": [{ asOf: { supports: "any", check: () => { throw new Error("hunter2"); } } }, "error"],
    "asOf.check returns a hostile why": [{ asOf: { supports: "any", check: () => ({ get what() { throw new Error("hunter2"); } }) } }, "error"],
  };
  const results = {};
  for (const [name, [def, want]] of Object.entries(cases)) {
    const tool = mk(def);
    let env = null;
    const err = await rejects(async () => { env = await go(tool.id, { as_of: "current" }); });
    closed("F4b-registry-rejects-on-hostile-tool-output", err !== null, `${name}: runTool rejected (${err && err.message})`);
    t.ok(env && typeof env.status === "string", name);
    if (want === "ok") t.equal(env.status, want, name);
    else if (want === "error") t.equal(env.status, "error", name);
    results[name] = env;
    t.doesNotMatch(JSON.stringify(env), /hunter2/, `${name}: nothing from the failure leaks`);
    t.ok(env._deps.audits.length === 1 && env._deps.audits[0].status === env.status, `${name}: the call was audited exactly once`);
  }
  t.ok(results["very deep object"].provenance.truncated > 0 && results["circular data"].provenance.truncated > 0, "cuts are counted");
  t.equal(results["BigInt in data"].data.n, "10");
  t.equal(results["facts a string"].error.code, "bad_fact");
  t.equal(results["asOf.check throws"].error.code, "as_of_check_failed");
  t.equal(results["coverage getter throws"].error.code, "tool_exception");
  // inputs that are not even objects
  for (const deps of [undefined, null, 5, "deps"]) {
    const env = await runTool({ caller }, "anything.at_all", { as_of: "current" }, deps);
    t.ok(env && typeof env.status === "string", `deps ${String(deps)}`);
  }
  const noNowMs = await runTool({ caller }, mk().id, { as_of: "current" }, { fetchSelf: async () => new Response("{}"), now: () => NOW, knowledge: { currentSeason: 2026 } });
  t.equal(noNowMs.status, "ok", "a missing nowMs falls back to Date.now");
  const throwingNow = await runTool({ caller }, mk().id, { as_of: "current" }, { now: () => { throw new Error("hunter2"); }, nowMs: () => 0, knowledge: {} });
  t.equal(throwingNow.status, "error");
  const hostileCtx = await runTool({ get caller() { throw new Error("hunter2"); } }, mk().id, { as_of: "current" }, mkDeps());
  t.ok(["error", "forbidden"].includes(hostileCtx.status), "a hostile ctx object is an envelope, not a rejection");
  t.notEqual(hostileCtx.status, "ok");
  const other = mk({ run: async () => ({ status: "ok", data: { ok: true }, coverage: "yes" }) });
  const cb = await go(other.id, { as_of: "current" });
  t.equal(cb.coverage.supported, true);
  t.deepEqual(cb.coverage.gaps, []);
});

test("a tool that throws an Error carrying a deskCode has its message forwarded (residual); an ordinary throw never does", async () => {
  const coded = mk({ run: async () => { throw Object.assign(new Error("db password=hunter2"), { deskCode: "some_code" }); } });
  const ce = await go(coded.id, { as_of: "current" });
  residual("R6-deskCode-message-forwarded", /hunter2/.test(JSON.stringify(ce)), "registry.js lines 339-340",
    "Any Error with a string deskCode of 3 to 48 lowercase letters/underscores has its own message (160 chars) put into the error envelope. Only route errors are meant to carry a deskCode, but a tool that sets one on a database or parsing error would show that error text to the model. Forward the message only for the registry's own route/timeout codes.");
  const plain = mk({ run: async () => { throw new Error("db password=hunter2"); } });
  t.doesNotMatch(JSON.stringify(await go(plain.id, { as_of: "current" })), /hunter2/);
  const badCode = mk({ run: async () => { throw Object.assign(new Error("db password=hunter2"), { deskCode: "Has Space!" }); } });
  const be = await go(badCode.id, { as_of: "current" });
  t.equal(be.error.code, "tool_exception");
  t.doesNotMatch(JSON.stringify(be), /hunter2/);
});

test("__proto__, constructor and prototype keys from parsed JSON never re-parent or pollute the output, at any depth", async () => {
  const parsed = JSON.parse('{"ok":1,"__proto__":{"email":"inherited@leak.example","role":"admin"},"branch":{"__proto__":{"role":"admin"},"constructor":{"x":1},"prototype":{"y":1},"keep":2,"list":[{"__proto__":{"role":"admin"},"v":1}]}}');
  const tool = mk({ output: { allow: ["ok", "branch"] }, run: async () => ({ status: "ok", data: parsed, provenance: parsed.branch, freshness: parsed.branch }) });
  const env = await go(tool.id, { as_of: "current" });
  for (const part of [env.data, env.data.branch, env.data.branch.list[0], env.provenance, env.freshness]) {
    closed("F18-proto-key-reparents-output", Object.getPrototypeOf(part) !== Object.prototype || part.role === "admin", "an output object was re-parented by a __proto__ key");
    t.equal(part.role, undefined);
    t.equal(part.email, undefined);
  }
  t.deepEqual(env.data.branch, { keep: 2, list: [{ v: 1 }] });
  t.equal({}.role, undefined);
  t.ok(isUnsafeKey("__proto__") && isUnsafeKey("constructor") && isUnsafeKey("prototype") && !isUnsafeKey("proto"));
});

test("every tool must declare its output: nothing the tool builds reaches the model unless its path is allowlisted", async () => {
  for (const output of [undefined, null, {}, { allow: null }, { allow: [] }, { allow: [""] }, { allow: "everything" }]) {
    const def = baseDef({ output });
    if (output === undefined) delete def.output;
    let err = null;
    try { defineTool(def); } catch (e) { err = e; }
    closed("F19-output-allowlist-optional", err === null, `defineTool accepted output ${JSON.stringify(output)}`);
    t.match(String(err && err.message), /output\.allow/);
  }
  const tool = mk({ output: { allow: ["shown"] }, run: async () => ({ status: "ok", data: { shown: 1, owner_notes: "private", nested: { a: 1 } } }) });
  const env = await go(tool.id, { as_of: "current" });
  t.deepEqual(env.data, { shown: 1 });
  t.equal(JSON.stringify(env.data).includes("private"), false);
});

// ═══ 10. WHAT THE MODEL SEES ═════════════════════════════════════════════════════════════════════════════
test("model-facing specs carry the description and schema only: no routes, no allowlists, no tables, no internals; as_of is required", () => {
  const tool = mk({
    id: nextId(), description: "Secret-free description of what this tool can and cannot answer.",
    inputSchema: { type: "object", properties: { q: { type: "string", maxLength: 20 } }, required: ["q"] },
    allowlist: { routes: [{ path: "/api/very-internal-route", params: ["L", "SECRET_PARAM"] }], modules: ["cap_math.js"], tables: [] },
    output: { allow: ["private_field_name"] },
  });
  const specs = toolSpecsForModel();
  const mine = specs.find((s) => s.name === tool.id.replace(/\./g, "__"));
  t.ok(mine);
  t.deepEqual(Object.keys(mine).sort(), ["description", "input_schema", "name"]);
  t.equal(mine.input_schema.additionalProperties, false);
  t.deepEqual(mine.input_schema.required.sort(), ["as_of", "q"]);
  t.equal(mine.input_schema.properties.as_of.type, "string");
  const text = JSON.stringify(specs);
  t.doesNotMatch(text, /very-internal-route|SECRET_PARAM|cap_math|private_field_name|allowlist|"tables"|"routes"|"modules"|dataClass|readOnly/);
  t.equal(toolIdFromModelName(mine.name), tool.id);
  t.equal(toolIdFromModelName("cap__penalty_quote"), "cap.penalty_quote");
  t.equal(toolIdFromModelName(null), "");
  t.equal(toolIdFromModelName(undefined), "");
});

test("a tool name the model invents is never resolved to a different, real tool", async () => {
  const real = mk();
  for (const name of [real.id.replace(".", "__"), real.id.replace(".", "___"), `${real.id}__x`, real.id.toUpperCase().replace(".", "__"), `${real.id.replace(".", "__")} `, real.id.replace(".", "/"), `../${real.id}`]) {
    const id = toolIdFromModelName(name);
    const env = await go(id, { as_of: "current" });
    t.ok(id === real.id ? env.status === "ok" : env.status === "forbidden", `${name} -> ${id}`);
  }
});

// ═══ 11. INDEPENDENCE ════════════════════════════════════════════════════════════════════════════════════
test("one failing tool does not affect the next: no shared state between runs", async () => {
  const bad = mk({ run: async () => { throw new Error("x"); } });
  const good = mk({ allowlist: { routes: [{ path: "/api/ok", params: [] }], modules: [], tables: [] }, run: async ({ routeGet }) => { await routeGet("/api/ok", {}); return { status: "ok", data: { ok: true } }; } });
  for (let i = 0; i < 3; i++) {
    t.equal((await go(bad.id, { as_of: "current" })).status, "error");
    const env = await go(good.id, { as_of: "current" });
    t.equal(env.status, "ok");
    t.equal(env._deps.fetched.length, 1);
  }
});

test("redirect handling, end to end: a 3xx is refused whatever it points at, and the request never follows it", async () => {
  const tool = mk({ allowlist: { routes: [{ path: "/api/ok", params: [] }], modules: [], tables: [] }, run: async ({ routeGet }) => { const r = await routeGet("/api/ok", {}); return { status: "ok", data: { ok: r.ok } }; } });
  const urls = [];
  const deps = mkDeps({ fetchSelf: async (u, o) => { urls.push([u, o.redirect]); return new Response(null, { status: 302, headers: { location: "https://evil.example/" } }); } });
  const env = await runTool({ caller }, tool.id, { as_of: "current" }, deps);
  t.equal(env.error.code, "route_redirect_refused");
  t.deepEqual(urls, [["https://self.invalid/api/ok", "manual"]]);
  t.equal(env.provenance.routes && env.provenance.routes.length, undefined, "an error envelope carries no provenance routes");
});

test("residual items found in the hardened code (probed and printed, never failed)", async () => {
  // R1: data_class is not required to be a string
  const arrCls = mk({ dataClass: "P2", run: async () => ({ status: "ok", data: { ok: true }, data_class: ["P1"] }) });
  const ae = await go(arrCls.id, { as_of: "current" });
  residual("R1-data_class-not-type-checked", ae.status === "ok" && typeof ae.data_class !== "string", "registry.js lines 376-379",
    "raw.data_class is looked up with DATA_CLASS_RANK[raw.data_class] without checking typeof string. An array such as ['P1'] (or an object whose toString returns 'P1') indexes the table as 'P1', passes the ceiling checks, and is copied into envelope.data_class as a non-string. It can never be raised above the tool's own class, so it is not a privilege escalation, but a later strict-equality check such as data_class === 'P0' would misjudge it. Require typeof string.");
  // R2: prologue outside the try
  const nullProto = Object.create(null);
  const err = await rejects(() => runTool({ caller }, nullProto, { as_of: "current" }, mkDeps()));
  const err2 = await rejects(() => runTool({ caller }, { toString() { throw new Error("x"); } }, { as_of: "current" }, mkDeps()));
  const err3 = await rejects(() => runTool({ caller, callSeq: Symbol("s") }, "a.b", { as_of: "current" }, mkDeps()));
  residual("R2-runTool-prologue-outside-try", err !== null || err2 !== null || err3 !== null, "registry.js lines 279-283",
    `The first lines of runTool (callId from Number(ctx.callSeq), safeId from String(toolId), clock()) sit outside the try. A tool id that is a null-prototype object or has a throwing toString, or a Symbol callSeq, makes runTool reject (observed: ${[err, err2, err3].filter(Boolean).map((e) => e.constructor.name).join(", ") || "none"}). The model supplies a string tool name, so this is not reachable from it; move the prologue inside the try for the 'never rejects' promise to be unconditional.`);
  // R7: silent string truncation
  const longStr = mk({ output: { allow: ["text"] }, run: async () => ({ status: "ok", data: { text: "t".repeat(5000) } }) });
  const le = await go(longStr.id, { as_of: "current" });
  residual("R7-silent-string-truncation", le.data.text.length === 2000 && le.provenance.truncated === 0, "registry.js line 215 (sanitize cuts strings at 2000 characters and does not count it in provenance.truncated)",
    "A string over 2000 characters is cut with no marker and no count. The rules.get tool cuts its pages at 1900 characters to stay under it, and a future tool that returns longer text would lose its tail without anyone seeing. Increment counter.truncated (or add an ellipsis) when a string is cut.");
  t.ok(true);
});

test("FINDINGS is empty: every hole recorded in the first round of attacks is closed", () => {
  t.deepEqual(FINDINGS, [], `holes reopened: ${FINDINGS.map((f) => f.id).join(", ")}`);
  const lines = RESIDUAL.filter((r, i, a) => a.findIndex((x) => x.id === r.id) === i).map((r) => `  RESIDUAL ${r.id}\n     where:   ${r.where}\n     detail:  ${r.detail}`);
  console.log(`\n${lines.length} residual item(s) in the hardened registry/contract (printed, not failed):\n${lines.join("\n")}\n`);
});


await run("ai_desk_registry");
