// Commissioner Desk: the tool inventory and static-scan proofs. Offline and deterministic: it imports the tools and reads source files only.
//   node tests/ai_desk_tool_inventory.test.mjs
//
// Proves: exactly the 14 Phase 1 tool ids exist; every tool is read-only, class P0/P2, has as_of handling, an output allowlist where it calls a
// route, no forbidden route and no table; and, by scanning the SOURCE (comments, strings and regex literals separated from code), that no tool
// reaches env, the database, global fetch, crypto, cookies or any module outside its own allowlist; that no desk file outside the three that own
// the database or the HTTP edge contains SQL or a write verb; and that nothing in worker/src/desk imports feature flags, Hall, Discord or the
// older anthropic_explain module.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test, run, t } from "./fixtures/mini_test.mjs";
import { PHASE1_TOOLS, PHASE1_TOOL_IDS } from "../worker/src/desk/tools/index.js";
import { listTools, getTool, toolSpecsForModel } from "../worker/src/desk/registry.js";
import { FORBIDDEN_ROUTE_PATTERNS, SECRET_KEY_RE } from "../worker/src/desk/contract.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DESK = path.join(REPO, "worker/src/desk");
const EXPECTED_IDS = ["rules.search", "rules.get", "glossary.lookup", "coverage.check", "roster.current", "cap.position", "cap.penalty_quote", "cap.adjustments",
  "extension.price", "calendar.events", "standings.get", "history.finishes", "player.transactions", "data.freshness"];
const EXPECTED_ROUTES = ["/api/cap-penalty/preview", "/api/data-freshness", "/api/hall-of-champions", "/api/historical-finishes", "/api/league-events",
  "/api/player-bundle", "/api/player-transactions", "/api/playoff-bracket", "/api/salary-adjustments/ledger", "/api/standings", "/roster-workbench"];
const WORKER_MODULES_ALLOWED = new Set(["trade_deadline.js", "cap_math.js", "extension_pricing.js"]);

// ── A small JavaScript lexer: separates code from comments, strings and regex literals ──────────────────────────
// Returns { code, plain, strings }. code: comments removed, string and regex CONTENTS blanked. plain: comments removed, strings and regexes intact.
export function lex(src) {
  const strings = [];
  function scan(i, inTemplateExpr) {
    let code = "", plain = "", depth = 0, prevSig = "", prevWord = "";
    const n = src.length;
    const sig = (c) => { if (!/\s/.test(c)) prevSig = c; };
    while (i < n) {
      const ch = src[i], nx = src[i + 1];
      if (inTemplateExpr && ch === "}" && depth === 0) return { code, plain, end: i };
      if (ch === "/" && nx === "/") { while (i < n && src[i] !== "\n") i++; continue; }
      if (ch === "/" && nx === "*") { const e = src.indexOf("*/", i + 2); i = e < 0 ? n : e + 2; code += " "; plain += " "; continue; }
      if (ch === '"' || ch === "'") {
        let j = i + 1, s = "";
        while (j < n && src[j] !== ch) { if (src[j] === "\\") { s += src[j] + (src[j + 1] || ""); j += 2; } else { s += src[j]; j++; } }
        strings.push(s); code += `${ch}${ch}`; plain += src.slice(i, j + 1); i = j + 1; prevSig = '"'; prevWord = ""; continue;
      }
      if (ch === "`") {
        let j = i + 1, s = "";
        plain += "`";
        while (j < n && src[j] !== "`") {
          if (src[j] === "\\") { s += src[j] + (src[j + 1] || ""); plain += src[j] + (src[j + 1] || ""); j += 2; }
          else if (src[j] === "$" && src[j + 1] === "{") {
            strings.push(s); s = "";
            const r = scan(j + 2, true);
            code += ` ${r.code} `; plain += "${" + r.plain + "}"; j = r.end + 1;
          } else { s += src[j]; plain += src[j]; j++; }
        }
        strings.push(s); plain += "`"; code += "``"; i = j + 1; prevSig = '"'; prevWord = ""; continue;
      }
      if (ch === "/") {
        const regexOk = prevSig === "" || "(,=:[!&|?{};+-*%<>~^".includes(prevSig) || ["return", "typeof", "case", "in", "of", "delete", "void"].includes(prevWord);
        if (regexOk) {
          let j = i + 1, inClass = false;
          while (j < n && (src[j] !== "/" || inClass) && src[j] !== "\n") { if (src[j] === "\\") j++; else if (src[j] === "[") inClass = true; else if (src[j] === "]") inClass = false; j++; }
          j++; while (/[a-z]/i.test(src[j] || "")) j++;
          code += "/r/"; plain += src.slice(i, j); i = j; prevSig = "/"; prevWord = ""; continue;
        }
      }
      if (inTemplateExpr) { if (ch === "{") depth++; else if (ch === "}") depth--; }
      code += ch; plain += ch;
      if (/[A-Za-z0-9_$]/.test(ch)) { prevWord = /[A-Za-z0-9_$]/.test(src[i - 1] || "") ? prevWord + ch : ch; prevSig = ch; }
      else { if (!/\s/.test(ch)) prevWord = ""; sig(ch); }
      i++;
    }
    return { code, plain, end: n };
  }
  const r = scan(0, false);
  return { code: r.code, plain: r.plain, strings };
}

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else if (e.name.endsWith(".js")) out.push(p);
  }
  return out.sort();
}
const rel = (p) => path.relative(REPO, p);
const DESK_FILES = walk(DESK).filter((p) => !p.includes(`${path.sep}data${path.sep}rules_data.js`));   // rules_data.js is generated JSON-like data (one 600 KB literal)
// Helper files in tools/ that define no tool: pure modules the tools share (reviewed here by name, so a new one cannot slip in).
const HELPER_NAMES = ["shared_text.js"];
const ALL_TOOLS_DIR_FILES = DESK_FILES.filter((p) => p.includes(`${path.sep}tools${path.sep}`) && path.basename(p) !== "index.js");
const HELPER_FILES = ALL_TOOLS_DIR_FILES.filter((p) => HELPER_NAMES.includes(path.basename(p)));
const TOOL_FILES = ALL_TOOLS_DIR_FILES.filter((p) => !HELPER_NAMES.includes(path.basename(p)));
const SRC = new Map(DESK_FILES.map((p) => [p, lex(fs.readFileSync(p, "utf8"))]));
const importsOf = (plain) => [...plain.matchAll(/(?:^|[;\n])\s*(?:import|export)\s+(?:[^"'`;]*?\sfrom\s*)?["']([^"']+)["']/g)].map((m) => m[1]);
const dynamicImports = (code) => /\bimport\s*\(/.test(code);

// ── The lexer itself ──────────────────────────────────────────────────────────────────────────────────────────
test("LEXER: separates comments, strings, templates and regex literals (so the scans below mean what they say)", () => {
  const r = lex("// env\nconst a = 'cookie'; /* fetch( */ const b = `x ${env.y} z`; const re = /[\"']env/g; const q = a / 2; fetchSelf(1);");
  t.doesNotMatch(r.code, /cookie/);
  t.match(r.code, /\benv\.y\b/, "template expressions are code");
  t.doesNotMatch(r.code, /\bfetch\(/, "a comment is not code");
  t.match(r.code, /fetchSelf\(1\)/);
  t.ok(r.strings.includes("cookie") && r.strings.some((s) => s.includes("x ")));
  t.match(r.code, /a \/ 2/, "division is not a regex");
  for (const [p, s] of SRC) t.ok(s.code.length > 0, `${rel(p)} lexed to nothing`);
});

test("SCAN controls: each scan flags a planted violation (a scan that cannot fail proves nothing)", () => {
  const planted = lex("export default { async run({ routeGet }) { const r = await fetch('https://x.example'); const d = env.UPS_MFL_DB.prepare('SELECT a FROM t'); const c = request.headers.get('cookie'); const k = crypto.subtle; await import('./x.js'); } };");
  const hit = (re) => re.test(planted.code);
  for (const [name, re] of FORBIDDEN_IN_TOOL_CODE) if (["env", "UPS_MFL_DB", "global fetch", "database handle", "dynamic import", "crypto"].includes(name)) t.ok(hit(re), `the ${name} scan missed a planted violation`);
  t.ok(planted.strings.some((s) => SQL_SELECT.test(s)), "the SQL scan missed a planted statement");
  t.ok(!hit(/\bcookie\b/), "string contents are not code (the word cookie sits inside a string here)");
  t.deepEqual(importsOf("import a from './b.js';\nexport { c } from \"../d.js\";\nimport './side.js';"), ["./b.js", "../d.js", "./side.js"]);
});

// ── Inventory ───────────────────────────────────────────────────────────────────────────────────────────────────
test("INVENTORY: exactly the 14 Phase 1 tool ids are registered, once each, in one reviewed list", () => {
  t.deepEqual([...PHASE1_TOOL_IDS], EXPECTED_IDS);
  t.deepEqual(PHASE1_TOOLS.map((x) => x.id), EXPECTED_IDS);
  t.deepEqual(listTools().map((x) => x.id).sort(), [...EXPECTED_IDS].sort());
  t.equal(new Set(listTools().map((x) => x.id)).size, 14);
  t.equal(TOOL_FILES.length, 14, "one file per tool, no stray tool file");
  t.deepEqual(HELPER_FILES.map((p) => path.basename(p)), HELPER_NAMES);
  for (const h of HELPER_FILES) { const src = fs.readFileSync(h, "utf8"); t.ok(!/defineTool/.test(src), `${rel(h)} defines a tool`); t.deepEqual(importsOf(SRC.get(h).plain), [], `${rel(h)} must import nothing`); }
  const idx = SRC.get(path.join(DESK, "tools/index.js"));
  t.deepEqual(importsOf(idx.plain).sort(), TOOL_FILES.map((p) => `./${path.basename(p)}`).sort(), "tools/index.js imports exactly the 14 tool files");
});

test("TOOLS: every tool is read-only, P0 or P2, phase P1, tableless, with as_of handling and an output allowlist where it calls a route", () => {
  for (const tool of PHASE1_TOOLS) {
    t.equal(getTool(tool.id), tool);
    t.equal(tool.readOnly, true, `${tool.id} readOnly`);
    t.equal(tool.phase, "P1");
    t.ok(["P0", "P2"].includes(tool.dataClass), `${tool.id} class ${tool.dataClass}`);
    t.deepEqual([...tool.allowlist.tables], [], `${tool.id} reads no table`);
    t.ok(["current", "season", "any"].includes(tool.asOf.supports), `${tool.id} as_of`);
    t.ok(!("as_of" in tool.inputSchema.properties), "the registry adds as_of; a tool does not declare it");
    t.equal(tool.inputSchema.additionalProperties === undefined || tool.inputSchema.additionalProperties === false, true);
    if (tool.allowlist.routes.length) t.ok(tool.output && Array.isArray(tool.output.allow) && tool.output.allow.length > 0, `${tool.id} calls a route, so it needs an output allowlist`);
    for (const p of tool.output && tool.output.allow ? tool.output.allow : []) t.ok(!SECRET_KEY_RE.test(p.replace(/\[\]/g, "")), `${tool.id} allowlists a secret-looking path: ${p}`);
  }
  const specs = toolSpecsForModel();
  t.equal(specs.length, 14);
  for (const s of specs) { t.ok(s.input_schema.required.includes("as_of"), `${s.name} requires as_of`); t.equal(s.input_schema.additionalProperties, false); }
});

test("ROUTES: the set of backing routes is pinned; none is forbidden; no secret or identity parameter is allowlisted; workbench is always fresh", () => {
  const routes = new Map();
  for (const tool of PHASE1_TOOLS) {
    for (const r of tool.allowlist.routes) {
      t.ok(!FORBIDDEN_ROUTE_PATTERNS.some((re) => re.test(r.path)), `${tool.id} -> ${r.path} matches a forbidden pattern`);
      t.ok(!r.method || r.method === "GET");
      for (const prm of r.params) t.ok(!/EXT_URL|APIKEY|API_KEY|COOKIE|TOKEN|SECRET|PASSWORD|MFL_USER_ID|FRANCHISE_ID|CALLER/i.test(prm), `${tool.id} ${r.path} allowlists ${prm}`);
      if (r.path === "/roster-workbench") { t.ok(r.params.includes("NO_CACHE") && !r.params.includes("EXT_URL"), `${tool.id} must send NO_CACHE and never EXT_URL`); }
      routes.set(r.path, true);
    }
  }
  t.deepEqual([...routes.keys()].sort(), EXPECTED_ROUTES);
});

// ── Static scans: tools ───────────────────────────────────────────────────────────────────────────────────────
const FORBIDDEN_IN_TOOL_CODE = [
  ["env", /\benv\b/], ["UPS_MFL_DB", /\bUPS_MFL_DB\b/], ["TWB_OUTBOX_DB", /\bTWB_OUTBOX_DB\b/], ["global fetch", /(^|[^.\w])fetch\s*\(/], ["globalThis", /\bglobalThis\b/],
  ["process", /\bprocess\b/], ["crypto", /\bcrypto\b/i], ["cookie", /cookie/i], ["database handle", /\.(prepare|batch)\s*\(|\bD1\b|\bdatabase\b|\bsqlite\b/i],
  ["browser storage or network", /\b(localStorage|sessionStorage|XMLHttpRequest|WebSocket|indexedDB|document|window)\b/], ["eval or dynamic code", /\b(eval|require|Function)\s*\(|\bnew\s+Function\b/],
  ["dynamic import", /\bimport\s*\(/], ["secret names", /\b(apikey|api_key|authorization|password|secret)\b/i],
];
test("SCAN tools: no tool references env, the database, global fetch, crypto, cookies, secrets or dynamic code", () => {
  for (const p of [...TOOL_FILES, ...HELPER_FILES]) {
    const { code } = SRC.get(p);
    for (const [name, re] of FORBIDDEN_IN_TOOL_CODE) t.ok(!re.test(code), `${rel(p)} references ${name}`);
  }
});

test("SCAN tools: a tool imports only contract.js, registry.js, sibling tool helpers, and the modules its own allowlist names", () => {
  const byFile = new Map(PHASE1_TOOLS.map((tool) => [tool.id, tool]));
  const fileOf = (id) => TOOL_FILES.find((p) => path.basename(p) === `${id.split(".").join("_")}.js`) || TOOL_FILES.find((p) => path.basename(p).replace(/\.js$/, "").replace(/_/g, ".") === id);
  for (const tool of PHASE1_TOOLS) {
    const file = fileOf(tool.id) || TOOL_FILES.find((p) => fs.readFileSync(p, "utf8").includes(`id: "${tool.id}"`));
    t.ok(file, `a source file for ${tool.id}`);
    const specs = importsOf(SRC.get(file).plain);
    const allowedModules = new Set(tool.allowlist.modules);
    for (const spec of specs) {
      const resolved = path.resolve(path.dirname(file), spec);
      const r = rel(resolved);
      if (spec === "../registry.js" || spec === "../contract.js") continue;
      if (spec.startsWith("./") && (TOOL_FILES.includes(resolved) || HELPER_FILES.includes(resolved))) continue;          // sibling helper
      const ok = [...allowedModules].some((m) => r === m || r.endsWith(`/${m}`));
      t.ok(ok, `${rel(file)} imports ${spec}, which is not in ${tool.id}'s allowlist.modules ${JSON.stringify([...allowedModules])}`);
    }
    // the converse: every module the tool declares is imported, except knowledge.js, which a tool may use only through the injected `knowledge` object
    for (const m of allowedModules) if (m !== "knowledge.js") t.ok(specs.some((s) => path.resolve(path.dirname(file), s).endsWith(`/${m}`)), `${tool.id} declares module ${m} but does not import it`);
  }
  void byFile;
});

test("SCAN tools: sibling imports are only history_finishes.js (shared label and gap helpers) and shared_text.js (the free-text screen), never index.js", () => {
  const users = [];
  for (const p of TOOL_FILES) for (const s of importsOf(SRC.get(p).plain)) if (s.startsWith("./")) users.push(`${path.basename(p)} -> ${s}`);
  t.deepEqual(users.sort(), ["calendar_events.js -> ./shared_text.js","cap_adjustments.js -> ./shared_text.js","cap_penalty_quote.js -> ./shared_text.js","cap_position.js -> ./shared_text.js","data_freshness.js -> ./shared_text.js","extension_price.js -> ./shared_text.js","history_finishes.js -> ./shared_text.js","player_transactions.js -> ./history_finishes.js","player_transactions.js -> ./shared_text.js","roster_current.js -> ./shared_text.js","standings_get.js -> ./history_finishes.js","standings_get.js -> ./shared_text.js"]);
});

test("SCAN tools: EVERY tool whose allowlist has routes imports the shared text screen (shared_text.js), so a new route-backed tool cannot ship unscreened", () => {
  let checked = 0;
  for (const tool of PHASE1_TOOLS) {
    const file = TOOL_FILES.find((p) => fs.readFileSync(p, "utf8").includes(`id: "${tool.id}"`));
    t.ok(file, `a source file for ${tool.id}`);
    const imports = importsOf(SRC.get(file).plain);
    const screened = imports.includes("./shared_text.js");
    if (tool.allowlist.routes.length) { checked += 1; t.ok(screened, `${tool.id} calls a route but does not import ./shared_text.js`); }
    else t.ok(true);
  }
  t.equal(checked, 10, "ten route-backed tools");
  // the screen itself: pure (no imports, no I/O, no defineTool), as checked for every helper above
  const h = SRC.get(HELPER_FILES.find((p) => path.basename(p) === "shared_text.js"));
  t.deepEqual(importsOf(h.plain), []);
  t.ok(!/\b(fetch|env|process|globalThis|Date|Math\.random)\b|\bdefineTool\b|\brequire\b|\bimport\s*\(/.test(h.code), "shared_text.js must stay pure");
});

// ── Static scans: the whole desk ───────────────────────────────────────────────────────────────────────────────
const OWNS_DB_OR_EDGE = new Set(["handler.js", "store.js", "budget.js"]);       // brief: handler, store, budget (index wiring lives in worker/src/index.js)
const SQL_STRONG = /\b(INSERT\s+INTO|DELETE\s+FROM|UPDATE\s+["`\w]+\s+SET|CREATE\s+(TABLE|INDEX|VIEW|TRIGGER)|DROP\s+(TABLE|INDEX|VIEW)|ALTER\s+TABLE|REPLACE\s+INTO|PRAGMA\s+\w)/;
const SQL_SELECT = /\bSELECT\b[\s\S]{0,300}?\bFROM\b/;
test("SCAN desk: outside handler.js, store.js and budget.js there is no SQL string and no write verb anywhere in worker/src/desk", () => {
  let scanned = 0;
  for (const p of DESK_FILES) {
    if (OWNS_DB_OR_EDGE.has(path.basename(p))) continue;
    scanned += 1;
    const { code, strings } = SRC.get(p);
    for (const s of strings) { t.ok(!SQL_STRONG.test(s) && !SQL_SELECT.test(s), `${rel(p)} has a SQL-looking string`); }
    t.ok(!/\.(prepare|batch|put)\s*\(/.test(code), `${rel(p)} calls a database or KV write method`);
    t.ok(!/\bUPS_MFL_DB\b|\bTWB_OUTBOX_DB\b/.test(code), `${rel(p)} names a database binding`);
    if (path.basename(p) !== "anthropic_client.js") {
      for (const s of strings) t.ok(!/^(POST|PUT|PATCH|DELETE)$/i.test(s.trim()), `${rel(p)} names an HTTP write method`);
      t.ok(!/(^|[^.\w])fetch\s*\(/.test(code), `${rel(p)} calls global fetch`);
    }
  }
  t.ok(scanned >= 20, `scanned ${scanned} desk files`);
});

test("SCAN desk: the only HTTP write is anthropic_client.js, to one fixed URL; the only other URL literal is the registry's inert self origin", () => {
  const client = SRC.get(path.join(DESK, "anthropic_client.js"));
  t.ok(client.strings.includes("POST"));
  t.deepEqual([...new Set(client.strings.filter((s) => /^https?:\/\//.test(s)))], ["https://api.anthropic.com/v1/messages"]);
  for (const p of DESK_FILES) {
    const urls = SRC.get(p).strings.filter((s) => /^https?:\/\//.test(s));
    const b = path.basename(p);
    if (b === "anthropic_client.js") continue;
    t.deepEqual(urls, b === "registry.js" ? ["https://self.invalid"] : [], `${rel(p)} URL literals`);
  }
  // the desk key is the only key the client reads
  t.ok(client.code.includes("desiredKeyName") && !/ANTHROPIC_API_KEY\b(?!_DESK)/.test(client.plain.replace(/\/\/.*$/gm, "").replace(/ANTHROPIC_API_KEY_DESK/g, "")));
});

test("SCAN desk: no desk file imports feature flags, Hall, Discord or anthropic_explain; every import stays in the desk or one of three pure Worker modules", () => {
  for (const p of DESK_FILES) {
    const { plain, code } = SRC.get(p);
    t.ok(!dynamicImports(code) || path.basename(p) === "handler.js", `${rel(p)} uses a dynamic import`);
    for (const spec of importsOf(plain)) {
      t.ok(!/feature_flags|hall|discord|anthropic_explain/i.test(spec), `${rel(p)} imports ${spec}`);
      if (!spec.startsWith(".")) { t.ok(false, `${rel(p)} imports a package: ${spec}`); continue; }
      const resolved = path.resolve(path.dirname(p), spec);
      if (resolved.startsWith(DESK + path.sep)) { t.ok(fs.existsSync(resolved), `${rel(p)} imports a missing file ${spec}`); continue; }
      const inWorker = path.dirname(resolved) === path.join(REPO, "worker/src") && WORKER_MODULES_ALLOWED.has(path.basename(resolved));
      const canon = path.basename(p) === "handler.js" && rel(resolved) === "docs/league_context_v1.md";
      t.ok(inWorker || canon, `${rel(p)} imports ${spec} (${rel(resolved)}), outside the desk and not on the allowed list`);
    }
  }
  // handler.js dynamically imports only the generated rules data
  const dyn = [...SRC.get(path.join(DESK, "handler.js")).plain.matchAll(/import\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]);
  t.deepEqual(dyn, ["./data/rules_data.js"]);
});

test("SCAN desk: the registry and every data/validation module never see env or a database", () => {
  for (const b of ["registry.js", "contract.js", "validator.js", "knowledge.js", "loop.js", "router.js", "composer.js", "pipeline.js", "injection.js", "prompts.js", "prices.js"]) {
    const { code } = SRC.get(path.join(DESK, b));
    // registry.js and the pipeline name an envelope `env` locally, so the test looks for the Worker's env: a dep or ctx field, process.env, a binding or a prepare() call
    t.ok(!/\b(deps|ctx|this|globalThis|process)\.env\b|\bUPS_MFL_DB\b|\bTWB_OUTBOX_DB\b|\.prepare\s*\(|\benv\s*\.\s*[A-Z_]{3,}\b/.test(code), `${b} references env or a database`);
  }
  for (const d of ["data/coverage_matrix.js", "data/glossary.js"]) t.ok(!/\benv\b|\bfetch\b/.test(SRC.get(path.join(DESK, d)).code));
});

test("SCAN desk: the three desk tables (call log, question history, budget totals) are the only tables store.js names; it creates none", () => {
  const { strings, code } = SRC.get(path.join(DESK, "store.js"));
  const tables = new Set();
  for (const s of strings) for (const m of s.matchAll(/\b(?:FROM|INTO|UPDATE|JOIN)\s+([a-z_]+)/g)) tables.add(m[1]);
  t.deepEqual([...tables].sort(), ["ai_budget_totals", "ai_call_log", "ai_desk_questions"]);
  t.ok(!strings.some((s) => /CREATE\s+TABLE/i.test(s)));
  t.ok(code.length > 0);
});

await run("ai_desk_tool_inventory");
