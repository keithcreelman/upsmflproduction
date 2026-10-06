// The traded-salary settlement sweep: trades accepted on MFL's own site get
// their cap money posted — once, quietly, and only when it is really owed.
//   node tests/trade_settlement_sweep.test.mjs
//
// Keith 2026-10-06: "make the worker auto-post settlements for trades accepted
// on MFL". The War Room settles only trades accepted THROUGH it; the 2026-07-22
// L.A. Looks ↔ Gride trade (BB_10000) was accepted on MFL and never settled.
//
// PART A runs the real planner (sliced from worker/src/index.js) over the
// league's REAL 2026 trades and salary adjustments
// (tests/fixtures/salary_adjustments_2026_10_06.json + MFL row 61, Gride's
// half posted 2026-10-06).
// PART B runs the real route through worker.fetch against a stateful fake MFL:
// its import APPENDS rows like the real one, and its feed can be made to lag.
// Discord is faked. Nothing leaves the process.
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { makeD1 } from "./fixtures/d1_sqlite.mjs";
import { t, test, run } from "./fixtures/mini_test.mjs";
await import("./fixtures/register_md_loader.mjs");
const worker = (await import("../worker/src/index.js")).default;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = fs.readFileSync(path.join(ROOT, "worker/src/index.js"), "utf8");
const FX = JSON.parse(fs.readFileSync(path.join(ROOT, "tests/fixtures/salary_adjustments_2026_10_06.json"), "utf8"));

// ── PART A: the real planner ──
function slice(sig) {
  const at = SRC.indexOf(sig); if (at < 0) throw new Error(sig);
  let i = SRC.indexOf(") {", at) + 2, d = 0;   // the BODY's brace (a destructured parameter has its own)
  for (; i < SRC.length; i++) { if (SRC[i] === "{") d++; else if (SRC[i] === "}" && --d === 0) return SRC.slice(at, i + 1); }
  throw new Error("unbalanced " + sig);
}
const P = (() => {
  const c = vm.createContext({});
  const fns = ["function saladjClassify(", "function saladjNormalizeTrades(", "function saladjMatchOneSided(", "function saladjMatchTrade(",
    "function saladjMatchSettlements(", "function settlementFromTradeBB(", "function planTradeSettlements(", "function matchOutboxTradeId("];
  vm.runInContext(fns.map(slice).join("\n") + "\nthis.api = { saladjClassify, saladjNormalizeTrades, settlementFromTradeBB, planTradeSettlements, matchOutboxTradeId };", c);
  return c.api;
})();
const realTrades = P.saladjNormalizeTrades(FX.trades);
const toPosted = (rows) => rows.map((r) => ({ franchise_id: r.franchise_id, amount: Math.round(Number(r.amount)), unix: Number(r.timestamp), description: r.description, cls: P.saladjClassify(r.description) }));
const ADJ58 = FX.salaryAdjustments.salaryAdjustments.salaryAdjustment;
const GRIDE_HALF = { id: "61", franchise_id: "0003", amount: "-10000", timestamp: "1791309783", description: "UPS traded salary settlement (trade_20261116): net -10K" };
const NOW = Date.parse("2026-10-07T18:00:00Z") / 1000;
const SINCE = Date.parse("2026-10-06T00:00:00Z") / 1000;

test("real 2026 data, as it stands today: nothing to auto-post", () => {
  const { plans, skipped } = P.planTradeSettlements({ trades: realTrades, posted: toPosted(ADJ58.concat([GRIDE_HALF])), sinceUnix: SINCE, nowUnix: NOW, graceSec: 1800 });
  t.equal(plans.length, 0);
  const why = Object.fromEntries(skipped.map((s) => [`${s.teams.join("-")}@${s.unix}`, s.reason]));
  t.equal(why["0001-0003@1784746367"], "partially_settled_commish_hold", "L.A. Looks ↔ Gride: Gride's half is posted; L.A. Looks' half is the commissioner's call, never the sweep's");
  t.ok(skipped.filter((s) => s.reason === "already_settled").length >= 4, "the War Room-settled trades are recognised as settled");
});

test("even with no cutoff, the only unsettled 2026 trade is the one the audit found — and it is held", () => {
  const today = P.planTradeSettlements({ trades: realTrades, posted: toPosted(ADJ58.concat([GRIDE_HALF])), sinceUnix: 0, nowUnix: NOW, graceSec: 1800 });
  t.equal(today.plans.length, 0, "history never auto-posts: settled, 3-way, or held");
  const july = P.planTradeSettlements({ trades: realTrades, posted: toPosted(ADJ58), sinceUnix: 0, nowUnix: NOW, graceSec: 1800 });
  t.equal(july.plans.length, 1, "before Gride's half was posted, exactly one trade owed money");
  const p = july.plans[0];
  t.equal(`${p.payer} +${p.amount} / ${p.payee} -${p.amount}`, "0001 +10000 / 0003 -10000", "L.A. Looks pays, Gride is relieved — the War Room's own staged pair");
});

test("the planner's rules", () => {
  const tr = (a, b, unix, aGave, bGave, comments = "") => ({ a, b, unix, a_gave: aGave, b_gave: bGave, comments });
  const base = { posted: [], sinceUnix: 1000, nowUnix: 10000, graceSec: 1800 };
  const plan1 = (t1) => P.planTradeSettlements({ ...base, trades: [t1] });
  t.equal(plan1(tr("0004", "0011", 5000, ["123", "BB_7000"], ["456"])).plans[0].payer, "0004", "the BB_ sender pays");
  t.equal(plan1(tr("0004", "0011", 5000, ["123", "BB_3000"], ["456", "BB_5000"])).plans[0].payer, "0011", "both sides sent money: the net (0011 sent $2K more) is what posts");
  t.equal(plan1(tr("0004", "0011", 5000, ["123", "BB_3000"], ["456", "BB_5000"])).plans[0].amount, 2000);
  t.equal(plan1(tr("0004", "0011", 5000, ["123", "BB_3000"], ["456", "BB_3000"])).skipped[0].reason, "nets_to_zero");
  t.equal(plan1(tr("0004", "0011", 5000, ["123", "BB_2500"], ["456"])).skipped[0].reason, "not_whole_thousands", "UPS trades whole $K — anything else is a human's call");
  t.equal(plan1(tr("0004", "0011", 9000, ["123", "BB_7000"], ["456"])).skipped[0].reason, "in_grace", "30-minute grace: a War Room accept settles itself first");
  t.equal(plan1(tr("0004", "0011", 500, ["123", "BB_7000"], ["456"])).skipped[0].reason, "before_cutoff");
  t.equal(plan1(tr("0004", "0011", 5000, ["BB_7000"], [], "[Commish-processed: 3-way] 3-way abc123 pair-1")).skipped[0].reason, "three_way_engine");
  t.equal(plan1(tr("0004", "0011", 5000, ["123"], ["456"])).skipped.length, 0, "no cap money → not even considered");
});

test("the War Room ref is recovered from the outbox (so a War Room retry sees 'already posted')", () => {
  const trade = { a: "0001", b: "0003", unix: 1, a_gave: ["15287", "17031", "BB_10000"], b_gave: ["13592", "16809", "17474"] };
  const row = (id, ts, aPlayers, bPlayers, aBB) => ({ trade_id: id, created_ts: ts, payload: JSON.stringify({ teams: [
    { franchise_id: "0001", selected_assets: aPlayers.map((p) => ({ type: "PLAYER", player_id: p })), traded_salary_adjustment_dollars: aBB },
    { franchise_id: "0003", selected_assets: bPlayers.map((p) => ({ type: "PLAYER", player_id: p })), traded_salary_adjustment_dollars: 0 }] }) });
  const outbox = [row("1113", "2026-07-21T16:17:29Z", ["15287", "17031"], ["13592", "17474"], 10000),        // Gride's counter — Coker missing
    row("1116", "2026-07-21T22:18:34Z", ["15287", "17031"], ["13592", "16809", "17474"], 10000)];              // the offer that executed
  t.equal(P.matchOutboxTradeId(trade, outbox), "1116");
  t.equal(P.matchOutboxTradeId(trade, [row("1116", "x", ["15287", "17031"], ["13592", "16809", "17474"], 9000)]), "", "different money → not this offer");
  t.equal(P.matchOutboxTradeId(trade, []), "", "a native MFL trade has no War Room ref");
});

// ── PART B: the real route ──
const LEAGUE = "74598";
const NEW_TRADE = { type: "TRADE", franchise: "0004", franchise2: "0011", timestamp: String(Date.parse("2026-10-08T15:00:00Z") / 1000),
  franchise1_gave_up: "15000,BB_7000,", franchise2_gave_up: "16000,", comments: "" };
let MFL;
function resetMfl(over) {
  MFL = { adj: ADJ58.concat([GRIDE_HALF]).map((r) => ({ ...r })), trades: FX.trades.transactions.transaction.concat([NEW_TRADE]),
    imports: [], dms: [], lag: false, adjDown: false, nextId: 100, ...(over || {}) };
}
const json = (o, s) => new Response(JSON.stringify(o), { status: s || 200, headers: { "content-type": "application/json" } });
globalThis.fetch = async (input, init) => {
  const u = new URL(typeof input === "string" ? input : input.url);
  if (u.host === "discord.com") {
    if (u.pathname.endsWith("/users/@me/channels")) return json({ id: "dm-chan" });
    if (/\/channels\/[^/]+\/messages$/.test(u.pathname)) { MFL.dms.push(JSON.parse(init.body).content); return json({ id: "m1" }); }
    return json({}, 404);
  }
  if (u.pathname.endsWith("/import")) {
    if ((init?.method || "GET").toUpperCase() !== "POST") return new Response("ok", { status: 200 });
    const form = new URLSearchParams(String(init.body));
    const data = form.get("DATA") || "";
    MFL.imports.push(data);
    for (const m of data.matchAll(/<salary_adjustment franchise_id="(\d+)" amount="(-?\d+)" explanation="([^"]*)"\/>/g)) {
      if (!MFL.lag) MFL.adj.push({ id: String(MFL.nextId++), franchise_id: m[1], amount: m[2], timestamp: String(Math.floor(Date.now() / 1000)), description: m[3] });
    }
    return new Response('<?xml version="1.0" encoding="utf-8"?><status>OK</status>', { status: 200 });
  }
  const type = u.searchParams.get("TYPE");
  if (type === "salaryAdjustments") return MFL.adjDown ? json({ error: "down" }, 503) : json({ salaryAdjustments: { salaryAdjustment: MFL.adj } });
  if (type === "transactions") return json({ transactions: { transaction: MFL.trades } });
  if (type === "league") return json({ league: { franchises: { franchise: FX.franchises.map((f) => ({ ...f, email: `${f.id}@ups.test` })) } } });
  if (type === "myfranchise") return json({ franchise: { id: "0008" } });
  return json({ error: "no" }, 503);
};
function makeEnv(flag = "1") {
  const db = makeD1({});
  db.raw.exec(`CREATE TABLE twb_trade_outbox (id INTEGER PRIMARY KEY, created_ts TEXT, league_id TEXT, season TEXT, trade_id TEXT, action_type TEXT, status TEXT, payload_json TEXT)`);
  db.raw.prepare("INSERT INTO twb_trade_outbox (created_ts, league_id, season, trade_id, action_type, status, payload_json) VALUES (?,?,?,?,?,?,?)").run(
    "2026-10-08T14:00:00Z", LEAGUE, "2026", "1300", "SUBMIT", "POSTED", JSON.stringify({ teams: [
      { franchise_id: "0004", selected_assets: [{ type: "PLAYER", player_id: "15000" }], traded_salary_adjustment_dollars: 7000 },
      { franchise_id: "0011", selected_assets: [{ type: "PLAYER", player_id: "16000" }], traded_salary_adjustment_dollars: 0 }] }));
  return { UPS_MFL_DB: db, COMMISH_API_KEY: "admin", MFL_COOKIE: "COMMISH", MFL_APIKEY: "k", DISCORD_BOT_TOKEN: "bot",
    COMMISH_DISCORD_USER_ID: "123456789012345678", TRADE_SETTLEMENT_SWEEP_ENABLED: flag, TRADE_SETTLEMENT_SWEEP_SINCE: "2026-10-06T00:00:00Z" };
}
async function sweep(env, body = {}, nowIso = "2026-10-08T16:00:00Z") {
  const realNow = Date.now; Date.now = () => Date.parse(nowIso);
  try {
    const res = await worker.fetch(new Request(`https://w.test/admin/trades/settlement-sweep?L=${LEAGUE}&YEAR=2026&APIKEY=admin`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ season: "2026", league_id: LEAGUE, ...body }) }), env, { waitUntil() {}, passThroughOnException() {} });
    return await res.json();
  } finally { Date.now = realNow; }
}
const claims = (env) => env.UPS_MFL_DB.raw.prepare("SELECT trade_key, status, ref, payer_fid, payee_fid, amount FROM ups_trade_settlement_sweep ORDER BY id").all();

test("dry run: shows exactly the pair it would post, with the War Room's own ref; writes nothing", async () => {
  resetMfl(); const env = makeEnv("0");
  const d = await sweep(env, { dry_run: true });
  t.equal(d.ok, true); t.equal(d.dry_run, true); t.equal(d.flag_enabled, false, "dry run works with the flag off");
  t.equal(d.would_post.length, 1);
  const w = d.would_post[0];
  t.equal(w.ref, "trade_20261300", "ref from the outbox offer — the same one a War Room retry checks for");
  t.equal(JSON.stringify(w.rows), JSON.stringify([
    { franchise_id: "0004", amount: 7000, explanation: "UPS traded salary settlement (trade_20261300): net +7K" },
    { franchise_id: "0011", amount: -7000, explanation: "UPS traded salary settlement (trade_20261300): net -7K" }]));
  t.equal(MFL.imports.length, 0); t.equal(MFL.dms.length, 0);
});

test("flag off: a real run does nothing", async () => {
  resetMfl(); const env = makeEnv("0");
  const d = await sweep(env);
  t.equal(d.skipped, "flag_off"); t.equal(MFL.imports.length, 0);
});

test("live: claims, posts the pair once, verifies it on MFL, DMs the commissioner — and the next run is a no-op", async () => {
  resetMfl(); const env = makeEnv("1");
  const d = await sweep(env);
  t.equal(d.ok, true); t.equal(d.posted, 1, JSON.stringify(d));
  t.equal(MFL.imports.length, 1);
  t.match(MFL.imports[0], /^<salary_adjustments><salary_adjustment franchise_id="0004" amount="7000" explanation="UPS traded salary settlement \(trade_20261300\): net \+7K"\/><salary_adjustment franchise_id="0011" amount="-7000" explanation="UPS traded salary settlement \(trade_20261300\): net -7K"\/><\/salary_adjustments>$/);
  t.equal(JSON.stringify(claims(env).map((c) => [c.status, c.payer_fid, c.payee_fid, c.amount])), JSON.stringify([["posted", "0004", "0011", 7000]]));
  t.equal(MFL.dms.length, 1); t.match(MFL.dms[0], /Traded salary settled automatically.*Pure Greatness \+\$7,000, Cleon Ca\$h −\$7,000/);
  const again = await sweep(env, {}, "2026-10-08T17:00:00Z");
  t.equal(again.posted, 0); t.equal(MFL.imports.length, 1, "MFL now shows the pair → already settled, nothing posted");
  t.equal(MFL.dms.length, 1);
});

test("MFL's feed lags after the post: the D1 claim alone stops a second post", async () => {
  resetMfl({ lag: true }); const env = makeEnv("1");
  const d = await sweep(env);
  t.equal(d.results[0].result, "unverified", "posted but not yet visible → unverified, commissioner told");
  t.match(MFL.dms[0], /UNVERIFIED.*will NOT be retried automatically/);
  const again = await sweep(env, {}, "2026-10-08T17:00:00Z");
  t.equal(again.results[0].result, "already_claimed"); t.equal(MFL.imports.length, 1, "never a second import");
});

test("fail closed: MFL's salary adjustments unreadable → nothing posted", async () => {
  resetMfl({ adjDown: true }); const env = makeEnv("1");
  const d = await sweep(env);
  t.equal(d.ok, false); t.equal(d.error, "mfl_unreadable"); t.equal(MFL.imports.length, 0);
});

test("a trade needing a human is reported once, never posted", async () => {
  resetMfl({ trades: FX.trades.transactions.transaction.concat([{ ...NEW_TRADE, franchise1_gave_up: "15000,BB_2500," }]) }); const env = makeEnv("1");
  const d = await sweep(env);
  t.equal(MFL.imports.length, 0);
  t.equal(d.results[0].result, "needs_review"); t.equal(d.results[0].reason, "not_whole_thousands");
  t.equal(MFL.dms.length, 1); t.match(MFL.dms[0], /NOT auto-settled.*not_whole_thousands/);
  await sweep(env, {}, "2026-10-08T17:00:00Z");
  t.equal(MFL.dms.length, 1, "told once, not every hour");
});

test("wiring: hourly cron gated by the kill switch; route in the admin table; flag defaults", () => {
  t.match(SRC, /if \(!\(await getFeatureFlag\(env, "TRADE_SETTLEMENT_SWEEP_ENABLED"\)\)\) return;\s+const r = await env\.SELF\.fetch\(`https:\/\/self\.invalid\/admin\/trades\/settlement-sweep\?L=/);
  t.match(fs.readFileSync(path.join(ROOT, "worker/src/admin_routes.js"), "utf8"), /"\/admin\/trades\/settlement-sweep": \["POST"\]/);
  const toml = fs.readFileSync(path.join(ROOT, "worker/wrangler.toml"), "utf8");
  t.match(toml, /TRADE_SETTLEMENT_SWEEP_ENABLED = "1"\nTRADE_SETTLEMENT_SWEEP_SINCE = "2026-10-06T00:00:00Z"/);
  t.match(fs.readFileSync(path.join(ROOT, "worker/src/feature_flags.js"), "utf8"), /key: "TRADE_SETTLEMENT_SWEEP_ENABLED".*danger: true/);
});

test("migration 0167 builds the same table the route creates lazily", async () => {
  const { applyMigrations } = await import("./fixtures/d1_sqlite.mjs");
  const viaMigration = makeD1({}); applyMigrations(viaMigration, ["0167_trade_settlement_sweep.sql"]);
  resetMfl(); const env = makeEnv("1"); await sweep(env);           // the route's own CREATE TABLE IF NOT EXISTS
  const cols = (d) => d.raw.prepare("SELECT name, type, \"notnull\" AS nn FROM pragma_table_info('ups_trade_settlement_sweep') ORDER BY cid").all().map((c) => `${c.name}:${c.type}:${c.nn}`).join(",");
  t.equal(cols(viaMigration), cols(env.UPS_MFL_DB));
  applyMigrations(viaMigration, ["0167_trade_settlement_sweep.sql"]);
  t.ok(true, "re-applying is harmless");
});

await run("trade_settlement_sweep");
