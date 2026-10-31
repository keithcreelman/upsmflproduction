// Integration check for the assembled trade server (integration drafts, #1385): the two read-only answers the Front Office builder
// depends on come from the REAL worker handler (worker/src/index.js default.fetch), not from recorded preview answers.
//   1. POST /api/trades/compliance-preview carries #1407's verdict (worker/src/trade_preview_verdict.js): status, send_ready:false,
//      checks, reasons, trade_lock.
//   2. GET /trade-workbench carries #1415's meta.counts.extension_history_ok: true only after a successful ups_extension_master read,
//      false when that read throws or comes back unsuccessful.
// Offline: D1 = node:sqlite through the harness adapter, MFL = the harness's stateful stub; any other outbound call throws.
//   node tests/trade_integration_verdict_history.test.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { t, test, run } from "./fixtures/mini_test.mjs";
import { makeWorkerEnv, makeMfl, callWorker, quiet } from "./fixtures/worker_harness.mjs";
import { tradePreviewVerdict } from "../worker/src/trade_preview_verdict.js";

const restoreConsole = quiet();
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const Q = "L=74598&YEAR=2026";
const flat = (id) => ({ id, salary: "5000", contractYear: "1", contractStatus: "Vet-FAA", contractInfo: "CL 1|TCV 5K|AAV 5K|Y1-5K" });
const LOCK = { calendar: { calendar: { event: [{ id: "901", type: "TRADE", start_time: "1795654800" }] } } };

// Cloudflare D1's .all() returns { success: true, results, meta }; the harness adapter returns only { results }. Add the documented
// fields so the route sees a real successful read. `history` picks what the ups_extension_master read does: "ok", "throw" or "unsuccessful".
function fresh({ history = "ok" } = {}) {
  const env = makeWorkerEnv();
  const db = env.UPS_MFL_DB, prepare = db.prepare.bind(db);
  db.prepare = (sql) => {
    const stmt = prepare(sql), bind = stmt.bind.bind(stmt);
    const isHistory = /FROM\s+ups_extension_master\s+WHERE\s+league_id\s*=\s*\?/i.test(sql) && /contract_end_year/.test(sql) && /^\s*SELECT/i.test(sql);
    stmt.bind = (...args) => {
      const b = bind(...args), all = b.all;
      b.all = async () => {
        if (isHistory && history === "throw") throw new Error("D1_ERROR: simulated read failure");
        const res = await all();
        if (isHistory && history === "unsuccessful") return { success: false, results: res.results, meta: {} };
        return { success: true, meta: {}, ...res };
      };
      return b;
    };
    return stmt;
  };
  const mfl = makeMfl();
  mfl.install();
  return { env, mfl };
}

test("compliance-preview: the real handler returns #1407's verdict beside compliance, never send-ready, and writes nothing", async () => {
  const { env, mfl } = fresh();
  mfl.st.rosters["0001"] = [flat("14056")];
  mfl.st.rosters["0002"] = [flat("13100")];
  mfl.st.exportBody = LOCK;
  const body = { league_id: "74598", season: "2026", from_franchise_id: "0001", movements: [{ from: "0001", to: "0002", tokens: ["P_14056"] }, { from: "0002", to: "0001", tokens: ["P_13100"] }] };
  const r = await callWorker(env, "POST", `/api/trades/compliance-preview?${Q}&MFL_USER_ID=tok-B`, { body });
  t.equal(r.status, 200);
  t.equal(r.json.ok, true);
  t.ok(r.json.compliance && typeof r.json.compliance === "object", "the existing compliance answer is still there");
  const v = r.json.verdict;
  t.equal(JSON.stringify(Object.keys(v).sort()), JSON.stringify(["checks", "reasons", "send_ready", "status", "trade_lock"]), "exactly the verdict module's fields");
  t.equal(JSON.stringify(Object.keys(v.checks).sort()), JSON.stringify(["assets", "cap", "forfeited_picks", "loaded_contracts", "trade_lock"]));
  t.equal(v.send_ready, false);
  t.ok(["provisional", "needs_acknowledgment", "blocked", "unavailable"].includes(v.status), "status " + v.status);
  t.ok(Array.isArray(v.reasons));
  t.equal(v.checks.cap, String(r.json.compliance.cap && r.json.compliance.cap.status || "unavailable"), "checks.cap is derived from this response's own compliance");
  t.equal(v.checks.assets, "ok");
  t.equal(v.checks.trade_lock, "ok");
  t.equal(v.trade_lock.state, "upcoming");
  t.equal(v.trade_lock.label, "Wed, Nov 25, 8:00 PM ET");
  // The same module, fed this response's compliance, agrees on every check that depends only on compliance.
  const again = tradePreviewVerdict({ compliance: r.json.compliance, assets: { status: v.checks.assets }, forfeits: { ok: v.checks.forfeited_picks === "ok" }, lock: { state: v.trade_lock.state, label: v.trade_lock.label } });
  t.equal(JSON.stringify(again.checks), JSON.stringify(v.checks));
  t.equal(again.status, v.status);
  t.equal(mfl.st.imports.length, 0, "a preview never writes to MFL");
});

test("compliance-preview: a round-6 pick is blocked by the server verdict (live asset checks run in the handler)", async () => {
  const { env, mfl } = fresh();
  mfl.st.exportBody = LOCK;
  const body = { league_id: "74598", season: "2026", from_franchise_id: "0001", movements: [{ from: "0001", to: "0002", tokens: ["P_14056", "FP_0001_2027_6"] }, { from: "0002", to: "0001", tokens: ["P_13100"] }] };
  const r = await callWorker(env, "POST", `/api/trades/compliance-preview?${Q}&MFL_USER_ID=tok-B`, { body });
  t.equal(r.status, 200);
  t.equal(r.json.verdict.status, "blocked");
  t.equal(r.json.verdict.send_ready, false);
  t.ok(r.json.verdict.reasons.some((x) => x.code === "pick_not_tradeable"));
  t.equal(mfl.st.imports.length, 0);
});

test("compliance-preview: signed out is 401 (the verdict is never served without a proven caller)", async () => {
  const { env } = fresh();
  const body = { league_id: "74598", season: "2026", from_franchise_id: "0001", movements: [{ from: "0001", to: "0002", tokens: ["P_14056"] }] };
  const r = await callWorker(env, "POST", `/api/trades/compliance-preview?${Q}`, { body });
  t.equal(r.status, 401);
  t.equal(r.json && r.json.verdict, undefined);
});

test("/trade-workbench: extension_history_ok is true after a successful read, and an active extension is stamped on the player", async () => {
  const { env, mfl } = fresh({ history: "ok" });
  env.UPS_MFL_DB.raw.exec("INSERT INTO ups_extension_master (league_id, season, franchise_id, player_id, contract_end_year) VALUES ('74598', '2026', '0002', '13100', 2027)");
  mfl.st.rosters["0002"] = [flat("13100")];
  const r = await callWorker(env, "GET", `/trade-workbench?${Q}&MFL_USER_ID=tok-B`);
  t.equal(r.status, 200);
  t.equal(r.json.meta.counts.extension_history_ok, true);
  const team = r.json.teams.find((x) => x.franchise_id === "0002");
  const asset = team.assets.find((a) => a.type === "PLAYER" && String(a.player_id) === "13100");
  t.equal(asset.already_extended_by_this_franchise, true, "the franchise that holds an active extension is marked");
  const other = r.json.teams.find((x) => x.franchise_id === "0001").assets.find((a) => a.type === "PLAYER");
  t.ok(other.already_extended_by_this_franchise !== true, "a player nobody extended is not marked");
});

test("/trade-workbench: a valid EMPTY history is still a successful read (true)", async () => {
  const { env } = fresh({ history: "ok" });
  const r = await callWorker(env, "GET", `/trade-workbench?${Q}&MFL_USER_ID=tok-B`);
  t.equal(r.status, 200);
  t.equal(r.json.meta.counts.extension_history_ok, true);
});

test("/trade-workbench: a failed or unsuccessful history read reports false (the route itself still answers, as before)", async () => {
  for (const history of ["throw", "unsuccessful"]) {
    const { env } = fresh({ history });
    const r = await callWorker(env, "GET", `/trade-workbench?${Q}&MFL_USER_ID=tok-B`);
    t.equal(r.status, 200, history);
    t.equal(r.json.meta.counts.extension_history_ok, false, history);
  }
});

test("the assembled worker imports both modules (source check, so a dropped import cannot pass silently)", () => {
  const src = fs.readFileSync(path.join(ROOT, "worker/src/index.js"), "utf8");
  t.ok(/import \{ tradePreviewVerdict \} from "\.\/trade_preview_verdict\.js";/.test(src));
  t.ok(/import \{ summarizeExtensionMaster, extensionHistoryReadOk \} from "\.\/extension_history\.js";/.test(src));
  t.ok(/extension_history_ok: extensionHistoryOk/.test(src));
});

await run("trade_integration_verdict_history");
restoreConsole();
