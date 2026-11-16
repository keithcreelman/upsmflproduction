// The trade-outbox FILE fallback sits behind the same fail-closed pause as the trade-offers file.
//   node tests/outbox_fallback_pause.test.mjs
//
// Outbox rows live in D1 (TWB_OUTBOX_DB). Only when that binding is missing does the worker fall back to committing the rows to
// site/trades/trade_outbox_<league>_<season>.json. That fallback is dormant in production (the binding exists), but it must not
// be able to publish while TRADE_OFFERS_PUBLIC_WRITES_ENABLED is anything other than the exact string "1".
// Real worker, MFL and GitHub stubbed, synthetic values only. Nothing is sent anywhere.
import fs from "node:fs";
import { t, test, run } from "./fixtures/mini_test.mjs";
import { outboxFileRow, OUTBOX_FILE_FIELDS } from "../worker/src/public_data_hygiene.js";
import { makeWorkerEnv, makeMfl, callWorker, quiet } from "./fixtures/worker_harness.mjs";

const restore = quiet();
const Q = "L=74598&YEAR=2026";
const OUTBOX_FILE = "site/trades/trade_outbox_74598_2026.json";
const b64 = (o) => Buffer.from(JSON.stringify(o), "utf8").toString("base64");
const unb64 = (s) => Buffer.from(String(s), "base64").toString("utf8");

function withGithub(existing) {
  const puts = [], writes = [];
  const mflFetch = globalThis.fetch;
  const json = (o, status) => new Response(JSON.stringify(o), { status: status || 200, headers: { "content-type": "application/json" } });
  globalThis.fetch = async (input, init) => {
    const u = new URL(typeof input === "string" ? input : input.url);
    const method = String((init && init.method) || "GET").toUpperCase();
    if (u.hostname === "api.github.com") {
      if (method !== "GET") writes.push({ method, path: u.pathname });
      if (/\/contents\//.test(u.pathname)) {
        const path = decodeURIComponent(u.pathname.replace(/^.*\/contents\//, ""));
        if (method === "PUT") { puts.push({ path, text: unb64(JSON.parse(init.body).content) }); return json({ content: { sha: "sha-new" }, commit: { sha: "commit-1" } }); }
        if (existing && path === OUTBOX_FILE) return json({ sha: "sha-old", content: b64(existing), encoding: "base64" });
        return json({ message: "Not Found" }, 404);
      }
    }
    return mflFetch(input, init);
  };
  return { puts, writes, done() { globalThis.fetch = mflFetch; } };
}

const P2 = (id) => ({ asset_id: `P_${id}`, type: "PLAYER", player_id: String(id), player_name: `P${id}`, salary: 1, taxi: false, contract_info: "" });
const payload = (note) => ({
  schema_version: 1, source: "test", league_id: "74598", season: "2026", comment: note,
  teams: [{ role: "left", franchise_id: "0001", selected_assets: [P2(14056)], traded_salary_adjustment_k: 0 },
    { role: "right", franchise_id: "0002", selected_assets: [P2(13100)], traded_salary_adjustment_k: 0 }],
  extension_requests: [], ui: { left_team_id: "0001", right_team_id: "0002" }, validation: { status: "ready" },
});

// `withD1`: false = the outbox binding is missing (the fallback case). `flag`: the offers-publishing flag, as given.
async function propose({ withD1, flag, existing }) {
  const over = {}; if (flag !== undefined) over.TRADE_OFFERS_PUBLIC_WRITES_ENABLED = flag;
  const env = makeWorkerEnv(over); env.GITHUB_PAT = "test-pat";
  if (!withD1) { delete env.TWB_OUTBOX_DB; delete env.TWB_DB; delete env.DB; }
  const mfl = makeMfl(); mfl.install(); const gh = withGithub(existing);
  try {
    const r = await callWorker(env, "POST", `/api/trades/proposals?${Q}&MFL_USER_ID=tok-B`, { body: { league_id: "74598", season: "2026", from_franchise_id: "0001", to_franchise_id: "0002", message: "SYNTHETIC-NOTE", payload: payload("SYNTHETIC-NOTE") } });
    const rows = withD1 ? env.UPS_MFL_DB.raw.prepare("SELECT COUNT(*) AS n FROM twb_trade_outbox").get().n : null;
    return { r, mfl, gh, outboxPuts: gh.puts.filter((p) => p.path === OUTBOX_FILE), rows };
  } finally { gh.done(); mfl.restore(); }
}

test("MISSING D1 + PAUSE ON (flag unset): the outbox fallback cannot publish; the offer still reaches MFL", async () => {
  const x = await propose({ withD1: false, flag: undefined });
  t.ok(x.r.status < 300, `${x.r.status} ${x.r.text.slice(0, 160)}`);
  t.equal(x.mfl.writes("tradeProposal").length, 1, "the proposal reached MFL");
  t.equal(x.outboxPuts.length, 0, "zero outbox-file PUTs");
  t.equal(x.gh.puts.length, 0, "zero public file PUTs of any kind"); t.equal(x.gh.writes.length, 0, "zero GitHub writes of any kind");
});

test("MISSING D1: every value other than the exact string 1 stays paused (padded, look-alike, number, boolean)", async () => {
  for (const flag of ["0", "", "true", "yes", "on", "2", " 1 ", "1 ", " 1", "1\n", "01", "１", 1, true]) {
    const x = await propose({ withD1: false, flag });
    t.equal(x.outboxPuts.length, 0, `flag ${JSON.stringify(flag)} stays paused`);
  }
});

test("MISSING D1 + flag exactly 1: the fallback is reachable (so the tests above exercise the real path)", async () => {
  const x = await propose({ withD1: false, flag: "1" });
  t.ok(x.r.status < 300, `${x.r.status} ${x.r.text.slice(0, 160)}`);
  t.ok(x.outboxPuts.length >= 1, "the outbox file is committed only when publishing is explicitly enabled");
});

const NOTE = "SYNTHETIC-NOTE";
const NOTE_OLD = "SYNTHETIC-OLD-NOTE";
const allText = (x) => JSON.stringify(x);

test("MISSING D1 + flag exactly 1: the public outbox row carries none of the owner's note and only the fields the fallback needs", async () => {
  const x = await propose({ withD1: false, flag: "1" });
  const puts = x.outboxPuts; t.ok(puts.length >= 1, "published");
  for (const p of puts) {
    t.ok(!p.text.includes(NOTE), "the note text is not in the committed file");
    const doc = JSON.parse(p.text); t.ok(doc.rows.length >= 1, "a row was written");
    for (const row of doc.rows) {
      for (const k of Object.keys(row)) t.ok(OUTBOX_FILE_FIELDS.includes(k) || k === "payload_json" || k === "mfl_post_response_snip" || k === "mfl_verify_response_snip", `field ${k} is allowlisted`);
      t.equal(row.mfl_post_response_snip, "", "MFL response excerpt emptied"); t.equal(row.mfl_verify_response_snip, "", "MFL verify excerpt emptied");
      t.equal(row.payload_json.comment, "", "payload note emptied");
      // what the fallback's readers need is still there
      t.ok(row.payload_json.teams.length === 2 && row.payload_json.teams[0].selected_assets.length === 1, "payload structure kept");
      t.ok(row.trade_id !== undefined && row.payload_hash && row.status && row.action_type, "lookup keys kept");
    }
  }
});

test("MISSING D1 + flag exactly 1: rows already in the file are cleaned on the next write, and the MFL post still carries the note", async () => {
  const old = { meta: { league_id: "74598", season: 2026 }, rows: [{ id: "1", trade_id: "111", payload_hash: "h1", status: "PENDING", action_type: "SUBMIT", extra_field: NOTE_OLD,
    payload_json: { comment: NOTE_OLD, notes: NOTE_OLD, message: NOTE_OLD, teams: [{ role: "left", selected_assets: [] }], extension_requests: [] }, mfl_post_response_snip: NOTE_OLD, mfl_verify_response_snip: NOTE_OLD }] };
  const x = await propose({ withD1: false, flag: "1", existing: old });
  t.ok(x.outboxPuts.length >= 1);
  for (const p of x.outboxPuts) t.ok(!p.text.includes(NOTE_OLD) && !p.text.includes(NOTE), "no note text of either row in the committed file");
  const last = JSON.parse(x.outboxPuts[x.outboxPuts.length - 1].text);
  t.ok(last.rows.some((r) => r.id === "1" && r.trade_id === "111" && r.payload_hash === "h1"), "the old row's lookup keys survive");
  t.ok(!last.rows.some((r) => "extra_field" in r), "unknown fields are dropped");
  const sent = x.mfl.writes("tradeProposal"); t.equal(sent.length, 1, "the offer itself still reached MFL");
  t.ok(allText(sent[0].fields).includes(NOTE), "and it carries the owner's note (MFL is where the note lives)");
});

test("outboxFileRow: pure, allowlisted, never mutates, nested notes emptied at any depth", () => {
  const src = { id: "9", status: "PENDING", secret_extra: NOTE, payload_json: { comment: NOTE, deep: [{ comments: NOTE, notes: NOTE, keep: "k" }], teams: [] }, mfl_post_response_snip: NOTE, comment_trailer: "UPS_OUTBOX_ID:9" };
  const before = JSON.stringify(src), out = outboxFileRow(src);
  t.equal(JSON.stringify(src), before, "input untouched");
  t.ok(!JSON.stringify(out).includes(NOTE), "no note anywhere");
  t.equal(out.payload_json.deep[0].keep, "k"); t.equal(out.comment_trailer, "UPS_OUTBOX_ID:9"); t.ok(!("secret_extra" in out));
  t.equal(outboxFileRow(null).payload_json, null);
});

test("D1 BOUND (production's case) + pause on: the outbox row is stored in D1 and nothing is published", async () => {
  const x = await propose({ withD1: true, flag: undefined });
  t.ok(x.r.status < 300, `${x.r.status} ${x.r.text.slice(0, 160)}`);
  t.ok(x.rows >= 1, "the D1 outbox row exists"); t.equal(x.gh.puts.length, 0, "no public write");
});

test("SOURCE GUARD: the outbox file writer checks the pause before anything else, and has only the two known callers", () => {
  const src = fs.readFileSync(new URL("../worker/src/index.js", import.meta.url), "utf8");
  const at = src.indexOf("const writeTradeOutboxDoc = async");
  t.match(src.slice(at, at + 330), /if \(!tradeOffersPublicWritesEnabled\(\)\) \{\s*return \{ ok: false, paused: true/);
  t.equal([...src.matchAll(/await writeTradeOutboxDoc\(/g)].length, 2, "insert and update inside writeOutboxRow, nothing else");
  t.ok(src.indexOf("const tradeOffersPublicWritesEnabled") < at, "the flag helper is defined before the writer");
});

await run("outbox fallback pause");
restore();
