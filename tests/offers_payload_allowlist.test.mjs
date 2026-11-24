// The stored offer's `payload` in the public trade-offers file is rebuilt from an allowlist.
//   node tests/offers_payload_allowlist.test.mjs
//
// With offers publishing ENABLED in the test only (production stays "0"): search text, notes and an unexpected nested text field
// stay out of the committed file at every level; the fields the inbox card and workbench need are still there; the private
// Discord messages still carry the owner's note and the pre-trade extension (they read the in-memory row, never the file); accept
// still applies the extension. Real worker; MFL, GitHub and Discord stubbed; synthetic values only. Nothing is sent anywhere.
import { t, test, run } from "./fixtures/mini_test.mjs";
import { makeWorkerEnv, makeMfl, callWorker, quiet } from "./fixtures/worker_harness.mjs";
import { applyMigrations } from "./fixtures/d1_sqlite.mjs";
import { offerPayloadForFile, blankOfferText } from "../worker/src/public_data_hygiene.js";

const restore = quiet();
const Q = "L=74598&YEAR=2026";
const FILE = "site/trades/trade_offers_74598_2026.json";
const NOTE = "SYNTHETIC-NOTE", DECOY = "SYNTHETIC-UNLISTED-TEXT", SEARCH = "SYNTHETIC-SEARCH-TEXT";
const RECIPIENT_DM = "2000000000000000001", OFFERER_DM = "1000000000000000001";
const b64 = (o) => Buffer.from(JSON.stringify(o), "utf8").toString("base64");
const unb64 = (s) => Buffer.from(String(s), "base64").toString("utf8");

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
        if (method === "PUT") { const text = unb64(JSON.parse(init.body).content); puts.push({ path, text }); seed[path] = JSON.parse(text); return json({ content: { sha: "sha-new" }, commit: { sha: "commit-1" } }); }
        if (seed[path]) return json({ sha: "sha-old", encoding: "base64", content: b64(seed[path]) });
        return json({ message: "Not Found" }, 404);
      }
    }
    return mflFetch(input, init);
  };
  return { puts, writes, done() { globalThis.fetch = mflFetch; } };
}

const P2 = (id) => ({ asset_id: `P_${id}`, type: "PLAYER", player_id: String(id), player_name: `P${id}`, salary: 1, taxi: false, contract_info: "", owner_memo: DECOY });
const EXT = () => [{ player_id: "14056", player_name: "P14056", from_franchise_id: "0001", to_franchise_id: "0002", extension_term: "2YR", option_key: "2YR|NONE", loaded_indicator: "NONE",
  new_contract_status: "EXT2", new_TCV: 55000, new_aav_future: 25000, new_contract_length: 3, preview_contract_info_string: "CL 3| TCV 55K| AAV 5K, 25K| Y1-5K, Y2-25K, Y3-25K", owner_reason: DECOY }];
const payload = (from, to, give, recv, note, ext) => ({
  schema_version: 1, source: "test", league_id: "74598", season: "2026", comment: note, notes: note, message: note, generated_at: "2026-11-16T00:00:00Z",
  filters: { search: SEARCH, showTaxi: true }, unexpected_top_level: { text: DECOY }, assets: { left: { players: [DECOY], traded_salary_k: 0 }, right: { players: [], traded_salary_k: 0 } },
  teams: [{ role: "left", franchise_id: from, franchise_name: "Team A", memo: DECOY, selected_assets: give.map(P2), traded_salary_adjustment_k: 0 },
    { role: "right", franchise_id: to, franchise_name: "Team B", selected_assets: recv.map(P2), traded_salary_adjustment_k: 0 }],
  salary_reconciliation: { has_over_cap: false, left: { franchise_id: from, franchise_name: "Team A", salary_cap_dollars: 100, note_to_self: DECOY }, right: { franchise_id: to } },
  multi_year_salary_impact: { current_season: 2026, left_franchise_name: "Team A", rows: [{ season: 2026, left_after_dollars: 5, extra: DECOY }] },
  extension_requests: ext || [], ui: { left_team_id: from, right_team_id: to, hint: DECOY }, validation: { status: "ready", issues: [DECOY] },
});

function world(flag) {
  const over = { TRADE_DM_ENABLED: "1" }; if (flag !== undefined) over.TRADE_OFFERS_PUBLIC_WRITES_ENABLED = flag;
  const env = makeWorkerEnv(over); env.GITHUB_PAT = "test-pat";
  applyMigrations(env.UPS_MFL_DB, ["0076_trade_offer_dm.sql", "0102_trade_sentinel.sql"]);
  env.UPS_MFL_DB.raw.exec(`INSERT INTO discord_owners (franchise_id, active_owner, discord_user_id) VALUES ('0002','Y','${RECIPIENT_DM}'),('0001','Y','${OFFERER_DM}')`);
  const mfl = makeMfl(); mfl.install();
  mfl.st.salaries = [{ id: "14056", salary: "5000", contractYear: "1", contractStatus: "Vet-FAA", contractInfo: "CL 1|TCV 5K|AAV 5K|Y1-5K" }];
  mfl.st.rosters["0002"] = [{ id: "13100", salary: 5000, contractStatus: "Vet-FAA", contractYear: "1", contractInfo: "CL 1|TCV 5K|AAV 5K|Y1-5K" }];
  const seed = {}; const gh = withGithub(seed);
  return { env, mfl, gh, seed };
}
const dmTexts = (mfl, uid) => mfl.st.discord.filter((d) => new RegExp(`/channels/dm-${uid}/messages$`).test(d.url)).map((d) => (d.body && d.body.content) || "");
const propose = (w, ext) => callWorker(w.env, "POST", `/api/trades/proposals?${Q}&MFL_USER_ID=tok-B`, { body: { league_id: "74598", season: "2026", from_franchise_id: "0001", to_franchise_id: "0002", message: NOTE, comment: NOTE, payload: payload("0001", "0002", [14056], [13100], NOTE, ext) } });

test("COMMITTED OFFERS FILE (publishing on in the test): no note, no search text, no unlisted nested text; the keys themselves are absent", async () => {
  const w = world("1");
  try {
    const r = await propose(w, EXT()); t.ok(r.status < 300, `${r.status} ${r.text.slice(0, 200)}`);
    const puts = w.gh.puts.filter((p) => p.path === FILE); t.ok(puts.length >= 1, "the offers file was committed");
    for (const p of puts) {
      for (const s of [NOTE, DECOY, SEARCH]) t.ok(!p.text.includes(s), `committed file does not contain ${s}`);
      t.ok(!/"filters"|"unexpected_top_level"|"note_to_self"|"owner_memo"|"owner_reason"|"hint"|"issues"/.test(p.text), "those keys are not in the file");
    }
    const row = JSON.parse(puts[puts.length - 1].text).offers.find((o) => o.from_franchise_id === "0001");
    t.equal(row.message, ""); t.equal(row.comment, "");
  } finally { w.gh.done(); w.mfl.restore(); }
});

test("WHAT THE APP NEEDS IS STILL THERE: teams and assets, extension requests, team names, salary tables, ids, status; the inbox card lists the extension", async () => {
  const w = world("1");
  try {
    await propose(w, EXT());
    const row = JSON.parse(w.gh.puts.filter((p) => p.path === FILE).pop().text).offers.find((o) => o.from_franchise_id === "0001"); const pj = row.payload;
    t.equal(pj.teams.length, 2); t.equal(pj.teams[0].franchise_id, "0001"); t.equal(pj.teams[0].franchise_name, "Team A"); t.equal(pj.teams[0].selected_assets[0].player_id, "14056");
    t.equal(pj.teams[0].selected_assets[0].player_name, "P14056"); t.equal(pj.teams[0].selected_assets[0].asset_id, "P_14056");
    t.equal(pj.extension_requests.length, 1); t.equal(pj.extension_requests[0].player_id, "14056"); t.equal(pj.extension_requests[0].new_TCV, 55000); t.equal(pj.extension_requests[0].new_contract_length, 3);
    t.equal(pj.ui.left_team_id, "0001"); t.equal(pj.validation.status, "ready"); t.equal(pj.salary_reconciliation.left.salary_cap_dollars, 100); t.equal(pj.multi_year_salary_impact.rows[0].left_after_dollars, 5);
    t.ok(row.summary && row.summary.extension_request_count === 1, "the summary (built from the full payload) is intact"); t.equal(row.will_give_up.includes("14056"), true);
    const inbox = await callWorker(w.env, "GET", `/api/trades/proposals?${Q}&FRANCHISE_ID=0002&include_payload=1&MFL_USER_ID=tok-C`);
    t.equal(inbox.status, 200, inbox.text.slice(0, 200)); const card = inbox.json.incoming[0];
    t.ok(card && card.payload && card.payload.extension_requests.length === 1, "the inbox card can still list the pre-trade extension");
  } finally { w.gh.done(); w.mfl.restore(); }
});

test("PRIVATE DISCORD MESSAGES: the day-one message and a counter's message still carry the owner's note and the extension (they read the in-memory row)", async () => {
  const w = world("1");
  try {
    const r = await propose(w, EXT()); t.ok(r.status < 300);
    const tradeId = w.mfl.st.pending[w.mfl.st.pending.length - 1].trade_id;
    const dm = dmTexts(w.mfl, RECIPIENT_DM);
    t.ok(dm.some((c) => c.includes(NOTE)), "recipient's day-one message includes the note"); t.ok(dm.some((c) => /Pre-trade extension/.test(c)), "and the pre-trade extension");
    const c = await callWorker(w.env, "POST", `/api/trades/proposals/action?${Q}&MFL_USER_ID=tok-C`, { body: { action: "COUNTER", trade_id: tradeId, league_id: "74598", season: "2026", franchise_id: "0002", acting_franchise_id: "0002",
      counter_offer: { from_franchise_id: "0002", to_franchise_id: "0001", message: "SYNTHETIC-NOTE-COUNTER", payload: payload("0002", "0001", [13100], [14056], "SYNTHETIC-NOTE-COUNTER") } } });
    t.equal(c.status, 200, c.text.slice(0, 240));
    t.ok(dmTexts(w.mfl, OFFERER_DM).some((x) => x.includes("SYNTHETIC-NOTE-COUNTER")), "the original offerer's message includes the counter's note");
    for (const p of w.gh.puts.filter((x) => x.path === FILE)) for (const s of [NOTE, "SYNTHETIC-NOTE-COUNTER", DECOY, SEARCH]) t.ok(!p.text.includes(s), `no offers-file commit contains ${s}`);
  } finally { w.gh.done(); w.mfl.restore(); }
});

test("ACCEPT still applies the extension; and with publishing OFF (production's setting) nothing is written at all", async () => {
  const w = world("1");
  try {
    await propose(w, EXT()); const tradeId = w.mfl.st.pending[w.mfl.st.pending.length - 1].trade_id;
    const a = await callWorker(w.env, "POST", `/api/trades/proposals/action?${Q}&MFL_USER_ID=tok-C`, { body: { action: "ACCEPT", trade_id: tradeId, league_id: "74598", franchise_id: "0002", year: "2026", message: "" } });
    t.equal(a.status, 200, a.text.slice(0, 300)); t.equal(a.json.extensions && a.json.extensions.ok, true, "extension applied");
    t.equal(w.mfl.writes("salaries").length, 1, "the extension contract was imported");
  } finally { w.gh.done(); w.mfl.restore(); }
  const off = world(undefined);
  try { const r = await propose(off, EXT()); t.ok(r.status < 300); t.equal(off.gh.puts.length, 0); t.equal(off.gh.writes.length, 0, "default (flag unset) writes nothing"); } finally { off.gh.done(); off.mfl.restore(); }
});

test("offerPayloadForFile / blankOfferText: pure, scalars only, capped, null-safe, input untouched", () => {
  const src = { id: "X", message: NOTE, payload: payload("0001", "0002", [1], [2], NOTE, EXT()) };
  const before = JSON.stringify(src), out = blankOfferText(src);
  t.equal(JSON.stringify(src), before, "input untouched"); t.ok(!JSON.stringify(out).includes(NOTE) && !JSON.stringify(out).includes(DECOY) && !JSON.stringify(out).includes(SEARCH));
  t.equal(offerPayloadForFile(null), null); t.equal(offerPayloadForFile("text"), null); t.equal(offerPayloadForFile([1]), null);
  t.equal(blankOfferText({ id: "Y", payload: "oops" }).payload, "oops", "a non-object payload is left to the caller's existing handling");
  t.equal(offerPayloadForFile({ teams: [{ franchise_name: "x".repeat(900) }] }).teams[0].franchise_name.length, 240);
  t.ok(!("type" in offerPayloadForFile({ teams: [{ selected_assets: [{ type: { text: NOTE } }] }] }).teams[0].selected_assets[0]), "an object where a scalar belongs is dropped");
});

await run("offers payload allowlist");
restore();
