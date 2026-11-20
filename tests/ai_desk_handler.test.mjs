// Commissioner Desk routes, end to end through the REAL worker (index.js) on real SQLite, MFL stubbed at the edge.
//   node tests/ai_desk_handler.test.mjs
//
// Proves: no desk route answers without a commissioner credential; the desk is OFF by default and answers 403 (except /status);
// with it ON and the live-model switch OFF (the Phase 1 default) a question produces a code-built "paused" card, makes NO outbound
// model call, writes only the two desk tables, and leaves every league table untouched; a missing migration fails closed; input limits;
// the history/report round trip; and the route table lists exactly the five desk routes.
import { t, test, run } from "./fixtures/mini_test.mjs";
import { makeWorkerEnv, makeMfl, bindSelf, callWorker, ADMIN_KEY, quiet } from "./fixtures/worker_harness.mjs";
import { applyMigrations } from "./fixtures/d1_sqlite.mjs";
import { ADMIN_ROUTES } from "../worker/src/admin_routes.js";

const restore = quiet();
const Q = `L=74598&YEAR=2026&APIKEY=${ADMIN_KEY}`;
const NOKEY = "L=74598&YEAR=2026";
const DESK_MIGRATIONS = ["0180_ai_call_log.sql", "0181_ai_desk_questions.sql"];
const ROUTES = [["GET", "status"], ["POST", "ask"], ["GET", "history"], ["GET", "question"], ["POST", "report"]];

function fresh({ desk = true, migrations = true, over = {} } = {}) {
  const env = makeWorkerEnv({ DESK_ENABLED: desk ? "1" : "0", ...over });
  if (migrations) applyMigrations(env.UPS_MFL_DB, DESK_MIGRATIONS);
  bindSelf(env);
  const mfl = makeMfl({}); mfl.install();
  return { env, mfl };
}
// ups_settings is created by the pre-existing feature-flag read (CREATE TABLE IF NOT EXISTS in feature_flags.js); it is not the desk's.
const tables = (env) => env.UPS_MFL_DB.raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name <> 'ups_settings' ORDER BY name").all().map((r) => r.name);
function digest(env, skip) {
  const out = {};
  for (const n of tables(env)) { if (skip.includes(n)) continue; out[n] = JSON.stringify(env.UPS_MFL_DB.raw.prepare(`SELECT * FROM "${n}"`).all()); }
  return JSON.stringify(out);
}
const ask = (env, body, key = Q) => callWorker(env, "POST", `/admin/commish-desk/ask?${key}`, { body });

test("ROUTES: the route table lists exactly the five desk routes with the right methods", () => {
  const desk = Object.entries(ADMIN_ROUTES).filter(([p]) => p.startsWith("/admin/commish-desk/")).map(([p, m]) => `${m.join()} ${p}`).sort();
  t.deepEqual(desk, ["GET /admin/commish-desk/history", "GET /admin/commish-desk/question", "GET /admin/commish-desk/status", "POST /admin/commish-desk/ask", "POST /admin/commish-desk/report"]);
});

test("AUTH: no desk route answers without a commissioner credential (any method, desk on)", async () => {
  const { env, mfl } = fresh();
  for (const [method, name] of ROUTES) {
    const r = await callWorker(env, method, `/admin/commish-desk/${name}?${NOKEY}`, method === "POST" ? { body: { question: "x" } } : {});
    t.ok([401, 403].includes(r.status), `${method} ${name} unauthenticated -> ${r.status}`);
    t.ok(!/card|items|enabled/.test(r.text), `${name} leaked a body`);
  }
  t.equal(mfl.writes().length, 0);
});

test("AUTH: an owner session (not the commissioner) is refused; wrong methods and unknown desk paths are a uniform 404", async () => {
  const { env } = fresh();
  const owner = await callWorker(env, "GET", `/admin/commish-desk/status?${NOKEY}&MFL_USER_ID=tok-B`);
  t.ok([401, 403].includes(owner.status), `owner session -> ${owner.status}`);
  for (const [method, path] of [["GET", "ask"], ["POST", "status"], ["GET", "report"], ["POST", "history"], ["GET", "nope"], ["POST", "ask/"], ["GET", "../status"]]) {
    const r = await callWorker(env, method, `/admin/commish-desk/${path}?${Q}`);
    t.equal(r.status, 404, `${method} ${path}`);
  }
});

test("OFF BY DEFAULT: /status answers enabled:false; every other route is 403 desk_disabled; nothing is written", async () => {
  const { env } = fresh({ desk: false });
  const before = digest(env, []);
  const s = await callWorker(env, "GET", `/admin/commish-desk/status?${Q}`);
  t.equal(s.status, 200); t.equal(s.json.enabled, false); t.equal(s.json.live_model_enabled, false);
  for (const [method, name] of ROUTES.filter(([, n]) => n !== "status")) {
    const r = await callWorker(env, method, `/admin/commish-desk/${name}?${Q}`, method === "POST" ? { body: { question: "What is the cap?" } } : {});
    t.equal(r.status, 403, name); t.equal(r.json.error, "desk_disabled");
  }
  t.equal(digest(env, []), before, "an off desk wrote something");
});

test("PHASE 1 DEFAULT: desk ON, live model OFF: a question gets a code-built paused card, no model call, only desk tables written", async () => {
  const { env, mfl } = fresh();
  const leagueBefore = digest(env, ["ups_settings", "ai_call_log", "ai_desk_questions"]);
  const r = await ask(env, { question: "What is the penalty if 0008 cuts a player today?", as_of: "current" });
  t.equal(r.status, 200, r.text.slice(0, 200));
  t.equal(r.json.ok, true);
  t.ok(r.json.card && ["budget_exceeded", "tool_failure"].includes(r.json.card.state), `state ${r.json.card && r.json.card.state}`);
  t.equal(r.json.card.state, "budget_exceeded");
  t.ok(!/\d/.test(String(r.json.card.lead_md || "")), "a code-built card must not carry typed numbers");
  const log = env.UPS_MFL_DB.raw.prepare("SELECT mode, error_code, cost_usd FROM ai_call_log").all();
  t.ok(log.length >= 1 && log.every((x) => x.mode === "blocked" && Number(x.cost_usd || 0) === 0), "only blocked, zero-cost ledger rows");
  t.equal(env.UPS_MFL_DB.raw.prepare("SELECT COUNT(*) n FROM ai_desk_questions").get().n, 1);
  t.equal(digest(env, ["ups_settings", "ai_call_log", "ai_desk_questions"]), leagueBefore, "a league table changed");
  t.equal(mfl.writes().length, 0, "the desk wrote to MFL");
});

test("PHASE 1 DEFAULT: even with the live switch ON, no desk key and zero caps still block every call", async () => {
  const { env } = fresh({ over: { DESK_LIVE_MODEL_ENABLED: "1" } });
  const r = await ask(env, { question: "Who won the Toilet Bowl in 2024?" });
  t.equal(r.status, 200);
  t.ok(["budget_exceeded", "tool_failure"].includes(r.json.card.state));
  const live = env.UPS_MFL_DB.raw.prepare("SELECT COUNT(*) n FROM ai_call_log WHERE mode='live'").get().n;
  t.equal(live, 0, "a live ledger row exists: a model call was attempted");
});

test("FAIL CLOSED: desk ON but the migrations are not applied: 503 not_ready, nothing created", async () => {
  const { env } = fresh({ migrations: false });
  const before = tables(env);
  const r = await ask(env, { question: "What is the cap?" });
  t.equal(r.status, 503);
  t.ok(/not_ready|ledger_unreadable/.test(r.json.error));
  t.deepEqual(tables(env).filter((n) => /^ai_/.test(n)), [], "the desk must not create its own tables");
  t.deepEqual(tables(env), before);
});

test("INPUT: empty, over-long, control-character, bad as_of and oversized bodies are refused before any work", async () => {
  const { env } = fresh();
  t.equal((await ask(env, { question: "   " })).status, 400);
  t.equal((await ask(env, { question: "x".repeat(601) })).status, 400);
  t.equal((await ask(env, { question: "ok?", as_of: "yesterday" })).status, 400);
  t.equal((await ask(env, { question: "ok?", as_of: "2026-13-45" })).status, 400);
  const big = await callWorker(env, "POST", `/admin/commish-desk/ask?${Q}`, { body: "x".repeat(20000) });
  t.equal(big.status, 400);
  t.equal(env.UPS_MFL_DB.raw.prepare("SELECT COUNT(*) n FROM ai_desk_questions").get().n, 0);
  t.equal(env.UPS_MFL_DB.raw.prepare("SELECT COUNT(*) n FROM ai_call_log").get().n, 0);
});

test("HISTORY: a saved question lists, reopens with its card, and a problem report attaches to it", async () => {
  const { env } = fresh();
  const a = await ask(env, { question: "What is the cap?" });
  const id = a.json.request_id;
  t.match(id, /^[a-f0-9]{24}$/);
  const h = await callWorker(env, "GET", `/admin/commish-desk/history?${Q}`);
  t.equal(h.status, 200); t.equal(h.json.items.length, 1); t.equal(h.json.items[0].id, id);
  t.ok(!("card_json" in h.json.items[0]) && !("card" in h.json.items[0]), "history lists no card bodies");
  const q = await callWorker(env, "GET", `/admin/commish-desk/question?${Q}&id=${id}`);
  t.equal(q.status, 200); t.equal(q.json.item.card.state, a.json.card.state);
  t.equal((await callWorker(env, "GET", `/admin/commish-desk/question?${Q}&id=zzzzzzzzzzzz`)).status, 404);
  t.equal((await callWorker(env, "GET", `/admin/commish-desk/question?${Q}&id=../x`)).status, 400);
  const rep = await callWorker(env, "POST", `/admin/commish-desk/report?${Q}`, { body: { id, note: "Number looks wrong." } });
  t.equal(rep.status, 200);
  t.equal(env.UPS_MFL_DB.raw.prepare("SELECT report_note FROM ai_desk_questions WHERE id=?").get(id).report_note, "Number looks wrong.");
  t.equal((await callWorker(env, "POST", `/admin/commish-desk/report?${Q}`, { body: { id, note: "" } })).status, 400);
  t.equal((await callWorker(env, "POST", `/admin/commish-desk/report?${Q}`, { body: { id: "aaaaaaaaaaaa", note: "x" } })).status, 404);
});

test("STATUS: reports tools, zero caps and the live blockers; never a secret or key name value", async () => {
  const { env } = fresh();
  const s = await callWorker(env, "GET", `/admin/commish-desk/status?${Q}`);
  t.equal(s.json.enabled, true); t.equal(s.json.live_model_enabled, false);
  t.equal(s.json.tools.length, 14);
  t.deepEqual(s.json.budget, { per_question_usd: 0, per_run_usd: 0, monthly_usd: 0, total_usd: 0 });
  t.ok(s.json.live_blockers.includes("live_calls_disabled") && s.json.live_blockers.includes("no_key"));
  t.doesNotMatch(s.text, /admin-key-secret|COMMISH-COOKIE|sk-ant/);
});

test("SOURCE: the index.js desk block touches no league table or write route", async () => {
  const fs = await import("node:fs");
  const src = fs.readFileSync(new URL("../worker/src/index.js", import.meta.url), "utf8");
  const start = src.indexOf("// ---- Commissioner Desk (AI");
  const block = src.slice(start, src.indexOf("// GET/POST /admin/commish-settings", start));
  t.ok(block.length > 200 && block.length < 3000, `block size ${block.length}`);
  t.doesNotMatch(block, /UPS_MFL_DB|\.prepare\(|mflImport|salaryAdjust|sendDiscord|postDiscord/);
});

await run("ai_desk_handler");
restore();
