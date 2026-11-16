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

// A GitHub that serves `seed[path]` (a JSON object) and records every PUT; a PUT updates the seed so the next read sees it.
function withGithub(seed) {
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
        if (method === "PUT") { const text = unb64(JSON.parse(init.body).content); puts.push({ path, text }); if (seed) seed[path] = JSON.parse(text); return json({ content: { sha: "sha-new" }, commit: { sha: "commit-1" } }); }
        if (seed && seed[path]) return json({ sha: "sha-old", content: b64(seed[path]), encoding: "base64" });
        return json({ message: "Not Found" }, 404);
      }
    }
    return mflFetch(input, init);
  };
  return { puts, writes, done() { globalThis.fetch = mflFetch; } };
}

const P2 = (id) => ({ asset_id: `P_${id}`, type: "PLAYER", player_id: String(id), player_name: `P${id}`, salary: 1, taxi: false, contract_info: "" });
const DECOY = "SYNTHETIC-UNLISTED-TEXT";
const EXT = () => [{ player_id: "14056", player_name: "P14056", from_franchise_id: "0001", to_franchise_id: "0002", extension_term: "2YR", option_key: "2YR|NONE", loaded_indicator: "NONE",
  new_contract_status: "EXT2", new_TCV: 55000, new_aav_future: 25000, new_contract_length: 3, preview_contract_info_string: "CL 3| TCV 55K| AAV 5K, 25K| Y1-5K, Y2-25K, Y3-25K",
  owner_reason: DECOY, nested: { text: DECOY } }];
const payload = (note, ext) => ({
  schema_version: 1, source: "test", league_id: "74598", season: "2026", comment: note, notes: note, filters: { search: DECOY, showTaxi: true },
  unexpected_top_level: { text: DECOY }, salary_reconciliation: { left: { franchise_name: DECOY } },
  teams: [{ role: "left", franchise_id: "0001", franchise_name: DECOY, memo: DECOY, selected_assets: [{ ...P2(14056), owner_memo: DECOY }], traded_salary_adjustment_k: 0 },
    { role: "right", franchise_id: "0002", selected_assets: [P2(13100)], traded_salary_adjustment_k: 0 }],
  extension_requests: ext || [], ui: { left_team_id: "0001", right_team_id: "0002", hint: DECOY }, validation: { status: "ready", issues: [DECOY] },
});

// `withD1`: false = the outbox binding is missing (the fallback case). `flag`: the offers-publishing flag, as given.
async function propose({ withD1, flag, existing, ext }) {
  const over = {}; if (flag !== undefined) over.TRADE_OFFERS_PUBLIC_WRITES_ENABLED = flag;
  const env = makeWorkerEnv(over); env.GITHUB_PAT = "test-pat";
  if (!withD1) { delete env.TWB_OUTBOX_DB; delete env.TWB_DB; delete env.DB; }
  const mfl = makeMfl(); mfl.install(); const seed = existing ? { [OUTBOX_FILE]: existing } : {}; const gh = withGithub(seed);
  try {
    const r = await callWorker(env, "POST", `/api/trades/proposals?${Q}&MFL_USER_ID=tok-B`, { body: { league_id: "74598", season: "2026", from_franchise_id: "0001", to_franchise_id: "0002", message: "SYNTHETIC-NOTE", payload: payload("SYNTHETIC-NOTE", ext) } });
    const rows = withD1 ? env.UPS_MFL_DB.raw.prepare("SELECT COUNT(*) AS n FROM twb_trade_outbox").get().n : null;
    return { r, mfl, gh, seed, env, outboxPuts: gh.puts.filter((p) => p.path === OUTBOX_FILE), rows };
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
    t.ok(!p.text.includes(DECOY), "neither is the UI search text or any unlisted nested text field (filters.search, memo, owner_memo, ui.hint, validation.issues)");
    t.ok(!/"filters"|"unexpected_top_level"|"salary_reconciliation"|"franchise_name"/.test(p.text), "those keys are not in the file at all");
    const doc = JSON.parse(p.text); t.ok(doc.rows.length >= 1, "a row was written");
    for (const row of doc.rows) {
      for (const k of Object.keys(row)) t.ok(OUTBOX_FILE_FIELDS.includes(k) || k === "payload_json" || k === "mfl_post_response_snip" || k === "mfl_verify_response_snip", `field ${k} is allowlisted`);
      t.equal(row.mfl_post_response_snip, "", "MFL response excerpt emptied"); t.equal(row.mfl_verify_response_snip, "", "MFL verify excerpt emptied");
      t.ok(row.payload_json && !("comment" in row.payload_json) && !("notes" in row.payload_json), "the note keys are absent, not just emptied");
      // what the fallback's readers need is still there
      t.ok(row.payload_json.teams.length === 2 && row.payload_json.teams[0].selected_assets.length === 1, "payload structure kept");
      t.equal(row.payload_json.teams[0].selected_assets[0].player_id, "14056"); t.equal(row.payload_json.ui.left_team_id, "0001"); t.equal(row.payload_json.validation.status, "ready");
      t.ok(row.trade_id !== undefined && row.payload_hash && row.status && row.action_type, "lookup keys kept");
    }
  }
});

test("MISSING D1 + flag exactly 1: rows already in the file are cleaned on the next write, and the MFL post still carries the note", async () => {
  const old = { meta: { league_id: "74598", season: 2026 }, rows: [{ id: "1", trade_id: "111", payload_hash: "h1", status: "PENDING", action_type: "SUBMIT", extra_field: NOTE_OLD,
    payload_json: { comment: NOTE_OLD, notes: NOTE_OLD, message: NOTE_OLD, filters: { search: NOTE_OLD }, brand_new_field: NOTE_OLD, teams: [{ role: "left", memo: NOTE_OLD, selected_assets: [] }], extension_requests: [{ player_id: "1", owner_reason: NOTE_OLD }] }, mfl_post_response_snip: NOTE_OLD, mfl_verify_response_snip: NOTE_OLD }] };
  const x = await propose({ withD1: false, flag: "1", existing: old });
  t.ok(x.outboxPuts.length >= 1);
  for (const p of x.outboxPuts) t.ok(!p.text.includes(NOTE_OLD) && !p.text.includes(NOTE), "no note text of either row in the committed file");
  const last = JSON.parse(x.outboxPuts[x.outboxPuts.length - 1].text);
  t.ok(last.rows.some((r) => r.id === "1" && r.trade_id === "111" && r.payload_hash === "h1"), "the old row's lookup keys survive");
  t.ok(!last.rows.some((r) => "extra_field" in r), "unknown fields are dropped");
  const sent = x.mfl.writes("tradeProposal"); t.equal(sent.length, 1, "the offer itself still reached MFL");
  t.ok(allText(sent[0].fields).includes(NOTE), "and it carries the owner's note (MFL is where the note lives)");
});

test("outboxFileRow: pure, allowlisted at every level, never mutates, scalars only", () => {
  const src = { id: "9", status: "PENDING", secret_extra: NOTE, comment_trailer: "UPS_OUTBOX_ID:9", mfl_post_response_snip: NOTE,
    payload_json: { schema_version: 1, comment: NOTE, filters: { search: NOTE }, other: { deep: NOTE },
      teams: [{ role: "left", franchise_id: "0001", traded_salary_adjustment_k: 5, memo: NOTE, selected_assets: [{ player_id: "1", salary: 100, taxi: false, owner_memo: NOTE, type: { text: NOTE } }] }],
      extension_requests: [{ player_id: "1", new_TCV: 5, new_contract_length: 2, reason: NOTE, nested: [NOTE] }], ui: { left_team_id: "0001", hint: NOTE }, validation: { status: "ready", issues: [NOTE] } } };
  const before = JSON.stringify(src), out = outboxFileRow(src);
  t.equal(JSON.stringify(src), before, "input untouched");
  t.ok(!JSON.stringify(out).includes(NOTE), "no note anywhere");
  const pj = out.payload_json;
  t.equal(pj.teams[0].selected_assets[0].player_id, "1"); t.equal(pj.teams[0].selected_assets[0].salary, 100); t.equal(pj.teams[0].selected_assets[0].taxi, false);
  t.ok(!("type" in pj.teams[0].selected_assets[0]), "an object where a scalar belongs is dropped, not copied");
  t.equal(pj.teams[0].traded_salary_adjustment_k, 5); t.equal(pj.extension_requests[0].new_TCV, 5); t.equal(pj.ui.left_team_id, "0001"); t.equal(pj.validation.status, "ready");
  t.equal(out.comment_trailer, "UPS_OUTBOX_ID:9"); t.ok(!("secret_extra" in out));
  t.equal(outboxFileRow(null).payload_json, null); t.equal(outboxFileRow({ payload_json: "text" }).payload_json, null);
  t.equal(outboxFileRow({ payload_json: { teams: [{ selected_assets: [{ player_name: "x".repeat(5000) }] }] } }).payload_json.teams[0].selected_assets[0].player_name.length, 240, "long strings are capped");
});

const EXPECTED_XML = `<salaries><leagueUnit unit="LEAGUE"><player id="14056" salary="5000" contractYear="3" contractInfo="CL 3|TCV 55K|AAV 5K, 25K|Y1-5K, Y2-25K, Y3-25K|Ext: L.A.|GTD: 41.3K" contractStatus="Vet-Ext2" /></leagueUnit></salaries>`;
test("EXTENSION END TO END (D1 missing, flag exactly 1): propose with an extension, then accept using ONLY the saved backup row; the extension still applies", async () => {
  const env = makeWorkerEnv({ TRADE_OFFERS_PUBLIC_WRITES_ENABLED: "1" }); env.GITHUB_PAT = "test-pat";
  delete env.TWB_OUTBOX_DB; delete env.TWB_DB; delete env.DB;
  const mfl = makeMfl(); mfl.install();
  mfl.st.salaries = [{ id: "14056", salary: "5000", contractYear: "1", contractStatus: "Vet-FAA", contractInfo: "CL 1|TCV 5K|AAV 5K|Y1-5K" }];
  mfl.st.rosters["0002"] = [{ id: "13100", salary: 5000, contractStatus: "Vet-FAA", contractYear: "1", contractInfo: "CL 1|TCV 5K|AAV 5K|Y1-5K" }];
  const seed = {}; const gh = withGithub(seed);
  try {
    const p = await callWorker(env, "POST", `/api/trades/proposals?${Q}&MFL_USER_ID=tok-B`, { body: { league_id: "74598", season: "2026", from_franchise_id: "0001", to_franchise_id: "0002", message: NOTE, payload: payload(NOTE, EXT()) } });
    t.ok(p.status < 300, `${p.status} ${p.text.slice(0, 200)}`);
    const tradeId = mfl.st.pending[mfl.st.pending.length - 1].trade_id;
    const saved = seed[OUTBOX_FILE]; t.ok(saved && saved.rows.length >= 1, "the backup file was written");
    const text = JSON.stringify(saved); t.ok(!text.includes(NOTE) && !text.includes(DECOY), "the saved backup row holds no note and no unlisted text");
    const row = saved.rows.find((r) => r.action_type === "SUBMIT"); t.ok(row && row.payload_json.extension_requests.length === 1, "the extension request is in the saved row");
    // Accept: the only copy of the offer the worker can read is the sanitized backup file (no D1 outbox exists).
    mfl.st.salaries = [{ id: "14056", salary: "5000", contractYear: "1", contractStatus: "Vet-FAA", contractInfo: "CL 1|TCV 5K|AAV 5K|Y1-5K" }];
    const a = await callWorker(env, "POST", `/api/trades/proposals/action?${Q}&MFL_USER_ID=tok-C`, { body: { action: "ACCEPT", trade_id: tradeId, league_id: "74598", franchise_id: "0002", year: "2026", message: "" } });
    t.equal(a.status, 200, a.text.slice(0, 300)); t.equal(a.json.ok, true); t.equal(a.json.extensions && a.json.extensions.ok, true, "the extension step reports success");
    t.ok(mfl.st.done.some((d) => d.trade_id === tradeId && d.response === "accept"), "MFL accepted the trade");
    t.equal(mfl.writes("salaries")[0].fields.DATA, EXPECTED_XML, "the extension contract imported is the one the offer carried");
    // Scope of this test: the OUTBOX backup file. (The separate offers file is governed by its own flag; see the PR description.)
    const outboxCommits = gh.puts.filter((x) => x.path === OUTBOX_FILE); t.ok(outboxCommits.length >= 2, "the backup file was committed at submit and at accept");
    for (const x of outboxCommits) t.ok(!x.text.includes(NOTE) && !x.text.includes(DECOY), "no backup-file commit during the whole flow contains text");
  } finally { gh.done(); mfl.restore(); }
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
