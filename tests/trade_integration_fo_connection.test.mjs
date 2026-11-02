// Integration check for the assembled Front Office + trade server branch (#1385 / #1338): the Front Office builder's read-only
// connection (#1416: fo_trade_builder.js + trade_builder_core.js) consumes the REAL worker's answers, not recorded preview answers.
//   - the builder's own fetch() is wired to the real worker handler (worker/src/index.js default.fetch) through the harness;
//   - /trade-workbench meta.counts.extension_history_ok (#1415) gates the extension badge/choices;
//   - the compliance preview's extension result and #1407's verdict (trade_preview_verdict.js) are read by probeResult / readiness.
// Offline: D1 = node:sqlite through the harness adapter, MFL = the harness's stateful stub; any other outbound call throws.
//   node tests/trade_integration_fo_connection.test.mjs
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { t, test, run } from "./fixtures/mini_test.mjs";
import { makeWorkerEnv, makeMfl, callWorker, workerFetch, quiet } from "./fixtures/worker_harness.mjs";

const restoreConsole = quiet();
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
const Q = "L=74598&YEAR=2026";
const LOCK = { calendar: { calendar: { event: [{ id: "901", type: "TRADE", start_time: "1795654800" }] } } };

// The viewer is 0001 (harness token tok-B, an ordinary owner); the partner is 0002 (tok-C).
// 14056: 0001's final-year rookie contract (a first-extension candidate). 13100: 0002 already holds an active extension on him.
const MFL_ROSTERS = {
  "0001": [{ id: "14056", salary: "14000", contractYear: "1", contractStatus: "Rookie-Draft", contractInfo: "CL 1|TCV 14K|AAV 14K|Y1-14K" }],
  "0002": [{ id: "13100", salary: "11000", contractYear: "1", contractStatus: "Vet-Ext1", contractInfo: "CL 2|TCV 12K|AAV 11K|Y1-1K|Y2-11K" }],
};
const FIRST = { id: "14056", name: "First, Valid", position: "WR", salary: 14000, years: 1, type: "Rookie-Draft", special: "CL 1| TCV 14K| AAV 14K| Y1-14K", isTaxi: false, isIr: false };
const EXTENDED = { id: "13100", name: "Already, Extended", position: "WR", salary: 11000, years: 1, type: "Vet-Ext1", special: "CL 2| TCV 12K| AAV 11K| Y1-1K, Y2-11K", isTaxi: false, isIr: false };
const TEAMS = [{ fid: "0001", name: "Me", players: [FIRST] }, { fid: "0002", name: "Partner", players: [EXTENDED] }];

// Cloudflare D1's .all() returns { success: true, results, meta }; the harness adapter returns only { results }. Add the documented fields;
// `history` = "ok" | "throw" picks what the ups_extension_master read does.
function worker({ history = "ok" } = {}) {
  const env = makeWorkerEnv();
  const db = env.UPS_MFL_DB, prepare = db.prepare.bind(db);
  db.prepare = (sql) => {
    const stmt = prepare(sql), bind = stmt.bind.bind(stmt);
    const isHistory = /^\s*SELECT/i.test(sql) && /FROM\s+ups_extension_master\s+WHERE\s+league_id\s*=\s*\?/i.test(sql) && /contract_end_year/.test(sql);
    stmt.bind = (...args) => {
      const b = bind(...args), all = b.all;
      b.all = async () => { if (isHistory && history === "throw") throw new Error("D1_ERROR: simulated read failure"); return { success: true, meta: {}, ...(await all()) }; };
      return b;
    };
    return stmt;
  };
  env.UPS_MFL_DB.raw.exec("INSERT INTO ups_extension_master (league_id, season, franchise_id, player_id, contract_end_year) VALUES ('74598', '2026', '0002', '13100', 2027)");
  const mfl = makeMfl();
  Object.assign(mfl.st.rosters, MFL_ROSTERS);
  mfl.st.salaries = [...MFL_ROSTERS["0001"], ...MFL_ROSTERS["0002"]];   // MFL's salaries export: the live contracts the extension check prices
  mfl.st.exportBody = LOCK;
  mfl.install();
  return { env, mfl };
}

// The Front Office builder adapter in a VM, its fetch() going to the real worker. Every exchange (request + parsed answer) is kept.
function frontOffice(env) {
  const exchanges = [];
  const toWorker = workerFetch(env);
  const listeners = {};
  const ctx = vm.createContext({ console, setTimeout, clearTimeout, Promise, JSON, Math, Object, Array, String, Number, parseInt, isFinite, encodeURIComponent });
  ctx.window = ctx; ctx.self = ctx;
  ctx.document = { addEventListener: (k, f) => { (listeners[k] = listeners[k] || []).push(f); }, getElementById: () => null, createElement: () => ({}) };
  ctx.fetch = async (url, init) => {
    const res = await toWorker(url, init);
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch (_) {}
    exchanges.push({ method: (init && init.method) || "GET", url: String(url), body: init && init.body ? JSON.parse(init.body) : null, status: res.status, json });
    return { ok: res.ok, status: res.status, json: async () => JSON.parse(text), text: async () => text };
  };
  ctx.UPS_FO = { teams: () => TEAMS, viewerFid: () => "0001", warRoomUrl: () => "" };
  // The page's session query: the signed-in owner's MFL_USER_ID rides on every worker request (credentials stay "omit").
  ctx.UPS_FO_DATA = { config: () => ({ apiBase: "https://worker.test", leagueId: "74598", season: "2026", sessionQuery: (u) => u + (u.indexOf("?") === -1 ? "?" : "&") + "MFL_USER_ID=tok-B" }), get: () => null };
  ctx.UPS_FO_HUB = { asArray: (x) => (Array.isArray(x) ? x : x ? [x] : []), pad4: (x) => String(x).padStart(4, "0"), teamName: (x) => x, playerButton: (a, b, c) => c };
  for (const f of ["site/shared/trade_rules.js", "site/shared/pretrade_extension.js", "site/shared/trade_builder_core.js", "site/rosters/v2/fo_trade_builder.js"]) vm.runInContext(read(f), ctx, { filename: f });
  (listeners["fo:ready"] || []).forEach((f) => f());
  const opts = (item) => JSON.parse(JSON.stringify(ctx.UPS_FO_TRADE_BUILDER._extensionOptions(item)));
  return { ctx, exchanges, opts, C: ctx.UPS_TRADE_BUILDER_CORE };
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
// The view asks again when the history arrives and when a probe answers (handle.factsChanged); this does the same.
async function settle(fo, it) { fo.opts(it); for (let i = 0; i < 30; i++) { await wait(50); fo.opts(it); if (fo.exchanges.length >= 2) break; } await wait(400); return fo.opts(it); }
const item = (from, to, p) => ({ from, to, token: "P_" + p.id, label: p.name });

test("history read OK: the builder reads the worker's real /trade-workbench and its real probe answer, and shows options exactly when they say so", async () => {
  const { env, mfl } = worker({ history: "ok" });
  const fo = frontOffice(env);
  const it = item("0001", "0002", FIRST);
  const shown = await settle(fo, it);
  const wb = fo.exchanges.find((x) => /\/trade-workbench/.test(x.url));
  t.ok(wb, "the builder fetched /trade-workbench from the worker");
  t.equal(wb.status, 200);
  t.equal(wb.json.meta.counts.extension_history_ok, true, "the worker's own flag");
  const hist = fo.C.historyFacts(wb.json, "0001", "14056");
  t.equal(JSON.stringify(hist), JSON.stringify({ history_ok: true, already_extended_by_this_franchise: false }), "the worker's answer read by historyFacts");
  const probes = fo.exchanges.filter((x) => x.method === "POST");
  t.equal(probes.length, 1, "one probe");
  t.ok(/\/api\/trades\/compliance-preview\?/.test(probes[0].url) && /MFL_USER_ID=tok-B/.test(probes[0].url), "the probe went to the worker's compliance preview, signed in");
  t.equal(probes[0].status, 200, "the worker accepted the caller (party to the movement)");
  t.equal(probes[0].json.ok, true);
  t.ok(Array.isArray(probes[0].json.compliance.extension_skipped), "the worker evaluated the extension request");
  t.ok(probes[0].json.verdict && probes[0].json.verdict.send_ready === false, "#1407's verdict rides on the same real answer");
  const pr = fo.C.probeResult(probes[0].json, "14056");
  const expected = pr.confirmed ? fo.C.extensionFacts(hist, pr) : null;
  t.equal(shown.length > 0, !!expected, "options shown iff the worker's answers confirm (probe: " + JSON.stringify(pr) + ")");
  if (pr.confirmed) t.ok(shown.every((o) => /^(1YR|2YR)\|/.test(o.option_key)), JSON.stringify(shown.map((o) => o.option_key)));
  t.equal(mfl.st.imports.length, 0, "no MFL write");
});

// The gap this integration found (2026-10-28) is FIXED: the compliance-preview route used to pass offerCreatedAtUtc: null, so the
// "restructured since the offer" fact was null and every probe came back authority_unavailable:restructure_history. An unsent draft
// is now judged AS OF NOW (worker/src/index.js compliance-preview), so a valid first extension is confirmed by the real handler.
test("FIXED GAP: the real preview confirms a valid first extension (restructure history read as of now), and the builder shows its options", async () => {
  const { env, mfl } = worker({ history: "ok" });
  const fo = frontOffice(env);
  const it = item("0001", "0002", FIRST);
  const shown = await settle(fo, it);
  const probe = fo.exchanges.find((x) => x.method === "POST");
  t.equal(JSON.stringify(probe.json.compliance.extension_skipped), "[]", "no refusal: the restructure history was read");
  t.ok(!probe.json.verdict.reasons.some((r) => r.code === "extension_unverified"), "the verdict no longer flags the extension as unverified");
  t.equal(JSON.stringify(fo.C.probeResult(probe.json, "14056")), JSON.stringify({ confirmed: true, reason: "" }));
  t.ok(shown.length > 0, "the 1- and 2-year choices appear");
  t.ok(shown.every((o) => /^(1YR|2YR)\|/.test(o.option_key)), JSON.stringify(shown.map((o) => o.option_key)));
  t.equal(probe.json.verdict.send_ready, false, "a preview never promises a send");
  t.equal(mfl.st.imports.length, 0, "no MFL write");
});

test("still fail closed: an UNREADABLE restructure history refuses the probe (authority_unavailable:restructure_history), and nothing is shown", async () => {
  const { env, mfl } = worker({ history: "ok" });
  env.UPS_MFL_DB.raw.exec("DROP TABLE ups_restructure_submissions");
  const fo = frontOffice(env);
  const it = item("0001", "0002", FIRST);
  const shown = await settle(fo, it);
  const probe = fo.exchanges.find((x) => x.method === "POST");
  t.equal(JSON.stringify(probe.json.compliance.extension_skipped), JSON.stringify([{ player_id: "14056", reason: "authority_unavailable:restructure_history" }]));
  t.equal(probe.json.verdict.status, "unavailable");
  t.equal(shown.length, 0, "fails closed: no options");
  t.equal(mfl.st.imports.length, 0);
});

test("an active extension in ups_extension_master: the worker marks him, and the builder never offers options", async () => {
  const { env, mfl } = worker({ history: "ok" });
  const fo = frontOffice(env);
  const it = item("0002", "0001", EXTENDED);
  const shown = await settle(fo, it);
  const wb = fo.exchanges.find((x) => /\/trade-workbench/.test(x.url));
  t.equal(JSON.stringify(fo.C.historyFacts(wb.json, "0002", "13100")), JSON.stringify({ history_ok: true, already_extended_by_this_franchise: true }));
  t.equal(shown.length, 0, "no 1YR or 2YR");
  t.equal(mfl.st.imports.length, 0);
});

test("history read FAILS in the worker: extension_history_ok is false, and the builder shows nothing and sends no probe", async () => {
  const { env, mfl } = worker({ history: "throw" });
  const fo = frontOffice(env);
  const it = item("0001", "0002", FIRST);
  const shown = await settle(fo, it);
  const wb = fo.exchanges.find((x) => /\/trade-workbench/.test(x.url));
  t.equal(wb.status, 200, "the route still answers");
  t.equal(wb.json.meta.counts.extension_history_ok, false);
  t.equal(fo.C.historyFacts(wb.json, "0001", "14056"), null);
  t.equal(shown.length, 0);
  t.equal(fo.exchanges.filter((x) => x.method === "POST").length, 0, "no probe");
  t.equal(mfl.st.imports.length, 0);
});

test("the builder's own request (core.request) to the real compliance preview: readiness maps the worker's real verdict, and nothing is ever sendable", async () => {
  const { env, mfl } = worker({ history: "ok" });
  const fo = frontOffice(env);
  const C = fo.C;
  let d = C.emptyDraft(["0001", "0002"]);
  d = C.addItem(d, { from: "0001", to: "0002", token: "P_14056", label: "First", salary: 14000 });
  d = C.addItem(d, { from: "0002", to: "0001", token: "P_13100", label: "Extended", salary: 11000 });
  const body = C.request(d, { leagueId: "74598", season: "2026", viewerFid: "0001" }, []);
  const r = await callWorker(env, "POST", `/api/trades/compliance-preview?${Q}&MFL_USER_ID=tok-B`, { body });
  t.equal(r.status, 200, "the worker reads the builder's request shape");
  const v = r.json.verdict;
  t.equal(JSON.stringify(Object.keys(v).sort()), JSON.stringify(["checks", "reasons", "send_ready", "status", "trade_lock"]));
  const ready = C.readiness(C.gaps(d), "done", r.json);
  const want = { blocked: "blocked", needs_acknowledgment: "needs_ack", provisional: "provisional" }[v.status] || "unavailable";
  t.equal(ready.state, want, "readiness follows the server status " + v.status);
  t.equal(ready.canSend, false);
  t.equal(ready.lock.text, "Trades close Wed, Nov 25, 8:00 PM ET.", "the live lock label from the worker, not a sample");
  // A blocked server answer (a round-6 pick) reads as blocked in the builder, with the server's own reason.
  const d6 = C.addItem(d, { from: "0001", to: "0002", token: "FP_0001_2027_6", label: "2027 6th" });
  const r6 = await callWorker(env, "POST", `/api/trades/compliance-preview?${Q}&MFL_USER_ID=tok-B`, { body: C.request(d6, { leagueId: "74598", season: "2026", viewerFid: "0001" }, []) });
  const b6 = C.readiness(C.gaps(d6), "done", r6.json);
  t.equal(r6.json.verdict.status, "blocked");
  t.equal(b6.state, "blocked");
  t.ok(b6.reasons.some((x) => x.code === "pick_not_tradeable"));
  t.equal(mfl.st.imports.length, 0);
});

await run("trade_integration_fo_connection");
restoreConsole();
