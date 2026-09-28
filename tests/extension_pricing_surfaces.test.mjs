// ONE PRICE ACROSS EVERY SURFACE — the builder, the preview feed, stored-offer creation, the accept, the MFL import and the commissioner's review
// all produce the same terms; a stored offer whose terms differ from the canonical price never executes; nothing reaches MFL on any mismatch.
// The REAL worker on real SQLite (MFL stubbed at the network edge) + the browser's real pricing modules.
//   node tests/extension_pricing_surfaces.test.mjs
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { t, test, run } from "./fixtures/mini_test.mjs";
import { makeWorkerEnv, makeMfl, callWorker, bindSelf, quiet, ADMIN_KEY } from "./fixtures/worker_harness.mjs";
import * as F from "./fixtures/trade_3way_fixture.mjs";
await import("./fixtures/register_md_loader.mjs");
const PX = await import("../worker/src/extension_pricing.js");
const { priceExtension, checkExtensionRequest, storedTerms, canonicalizePreviewRows, parseContractInfo } = PX;
const { handle3WayButton } = await import("../worker/src/trade_3way.js");

const restore = quiet();
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const Q = "L=74598&YEAR=2026";
const clone = (o) => JSON.parse(JSON.stringify(o));

// ── the browser's pricing module, loaded as a browser would ──────────────────────────────────────────────────────────────────────────
const ctx = { window: {} }; vm.createContext(ctx); vm.runInContext(fs.readFileSync(path.join(ROOT, "site/shared/pretrade_extension.js"), "utf8"), ctx);
const CLIENT = ctx.window.UPS_PRETRADE_EXT;
const asset = (o) => ({ type: "PLAYER", asset_id: `P_${o.player_id}`, player_name: `P${o.player_id}`, contract_type: "Veteran", taxi: false, contract_length: undefined, ...o });

// what a set of terms MEANS economically, from whichever surface carries them
const econ = (terms) => ({ term: terms.term, length: terms.contract_length, tcv: terms.tcv, aav_current: terms.aav_current, aav_future: terms.aav_future, year1: terms.salary_year1, by_year: terms.salary_by_year });
const fromStored = (req) => { const s = storedTerms(req); return { term: s.term, length: s.contract_length, tcv: s.tcv, aav_current: s.aav_current, aav_future: s.aav_future, year1: s.salary_year1, by_year: s.salary_by_year }; };
const fromImported = (row) => { const i = parseContractInfo(row.contractInfo); return { term: /Ext2/i.test(row.contractStatus) ? "2YR" : "1YR", length: i.cl, tcv: i.tcv, aav_current: i.aav_tiers[0], aav_future: i.aav_tiers[i.aav_tiers.length - 1], year1: Number(row.salary), by_year: i.years }; };
const num = (o) => JSON.parse(JSON.stringify(o, (k, v) => (typeof v === "string" && /^\d+$/.test(v) ? Number(v) : v)));

// ══════════════════════════ builder ≡ canonical price, across the contract shapes the league has ══════════════════════════
const MATRIX = [
  ["WR flat, Schedule 1",                   { position: "WR", salary: 5000, years: 1, contract_info: "CL 1|TCV 5K|AAV 5K|Y1-5K" }],
  ["TE rookie (Bowers)",                    { position: "TE", salary: 9000, years: 1, contract_info: "CL 3| TCV 27K| AAV 9K| Y1-9K, Y2-9K, Y3-9K| GTD: 20.3K" }],
  ["QB front-loaded (Tua), AAV ≠ salary",   { position: "QB", salary: 15000, years: 1, contract_info: "CL 3| TCV 116K| AAV 49K| Y1-86 Y2-15 Y3-15| GTD: 87K| Ext: C-Town" }],
  ["QB back-loaded (Hurts), salary > AAV",  { position: "QB", salary: 67000, years: 1, contract_info: "CL 2|TCV 119K|AAV 42K, 52K|Y1-67K, Y2-52K" }],
  ["WR dual AAV (London)",                  { position: "WR", salary: 33000, years: 1, contract_info: "CL 2| TCV 95K| AAV 33K, 43K| Y1-33K, Y2-62K" }],
  ["LB, Schedule 2",                        { position: "LB", salary: 12000, years: 1, contract_info: "CL 1|TCV 12K|AAV 12K|Y1-12K" }],
  ["DB, Schedule 2",                        { position: "CB", salary: 3000, years: 1, contract_info: "CL 1|TCV 3K|AAV 3K|Y1-3K" }],
  ["PK, Schedule 2, $1K",                   { position: "PK", salary: 1000, years: 1, contract_info: "CL 1|TCV 1K|AAV 1K|Y1-1K" }],
  ["rounding boundary: AAV 9.5K",           { position: "RB", salary: 8000, years: 1, contract_info: "CL 1|TCV 8K|AAV 9.5K|Y1-8K" }],
  ["no AAV token: TCV ÷ CL",                { position: "WR", salary: 20000, years: 1, contract_info: "CL 2|TCV 30K|Y1-10K, Y2-20K" }],
];
test("BUILDER ≡ WORKER: for every contract shape, the browser's options are the worker's canonical price (both terms), and each passes the worker's stored-vs-canonical check", () => {
  for (const [name, a] of MATRIX) {
    const live = { position: a.position, yearsRemaining: 1, salary: a.salary, contractInfo: a.contract_info };
    const opts = CLIENT.buildSyntheticExtensionOptions(asset({ player_id: "1", ...a }));
    t.equal(opts.length, 2, `${name}: two options`);
    for (const o of opts) {
      const canon = priceExtension({ ...live, term: o.extension_term });
      t.ok(canon.ok, `${name} ${o.extension_term}: priced`);
      t.deepEqual(num(fromStored(o)), num(econ(canon.terms)), `${name} ${o.extension_term}: the builder's terms == the canonical price`);
      const chk = checkExtensionRequest({ player_id: "1", ...o }, live);
      t.equal(chk.ok, true, `${name} ${o.extension_term}: ${JSON.stringify(chk.diffs || chk.reason)}`);
    }
  }
});
test("BUILDER OFFERS NOTHING THE WORKER WOULD REFUSE: expired rookies, more than one year left, unknown position, no AAV authority, a blank salary", () => {
  const base = { player_id: "1", position: "WR", salary: 5000, years: 1, contract_info: "CL 1|TCV 5K|AAV 5K|Y1-5K" };
  t.equal(CLIENT.buildSyntheticExtensionOptions(asset(base)).length, 2, "control");
  t.equal(CLIENT.buildSyntheticExtensionOptions(asset({ ...base, years: 0, contract_type: "Rookie-Draft" })).length, 0, "expired rookie (its base salary needs the draft-slot schedule)");
  t.equal(CLIENT.buildSyntheticExtensionOptions(asset({ ...base, years: 2 })).length, 0);
  t.equal(CLIENT.buildSyntheticExtensionOptions(asset({ ...base, position: "TM" })).length, 0);
  t.equal(CLIENT.buildSyntheticExtensionOptions(asset({ ...base, contract_info: "" })).length, 0);
  t.equal(CLIENT.buildSyntheticExtensionOptions(asset({ ...base, salary: 0 })).length, 0);
});
test("DESKTOP COPY: the Trade War Room's own synthesizer and raise table are BYTE-IDENTICAL to the shared module (drift guard)", () => {
  const shared = fs.readFileSync(path.join(ROOT, "site/shared/pretrade_extension.js"), "utf8");
  const desk = fs.readFileSync(path.join(ROOT, "site/trades/trade_workbench.js"), "utf8");
  const norm = (s) => s.replace(/\s+/g, " ").trim();
  // one whole function (brace-matched, so ordering / neighbours never matter)
  const fn = (src, name) => { const a = src.indexOf(`function ${name}(`); t.ok(a > 0, `${name} present`); let i = src.indexOf("{", a), depth = 0; for (; i < src.length; i++) { if (src[i] === "{") depth++; else if (src[i] === "}" && --depth === 0) break; } return norm(src.slice(a, i + 1)); };
  const block = (src, start) => { const a = src.indexOf(start); t.ok(a > 0, `${start} present`); return norm(src.slice(a, src.indexOf("};", a) + 2)); };
  t.equal(fn(desk, "buildSyntheticExtensionOptions"), fn(shared, "buildSyntheticExtensionOptions"), "buildSyntheticExtensionOptions");
  t.equal(fn(desk, "tradeExtensionRaiseForAsset"), fn(shared, "tradeExtensionRaiseForAsset"), "tradeExtensionRaiseForAsset");
  t.equal(fn(desk, "tradePositionGroupKey"), fn(shared, "tradePositionGroupKey"), "tradePositionGroupKey");
  t.equal(block(desk, "var PRETRADE_EXTENSION_RAISES = {"), block(shared, "var PRETRADE_EXTENSION_RAISES = {"), "the raise table");
  t.doesNotMatch(desk, /function reanchorPreviewExtOption/, "no client-side repricing of a preview row");
});

// ══════════════════════════ the worker: creation, accept, import, review — one contract ══════════════════════════
const player = (pid, salary = 5000) => ({ asset_id: `P_${pid}`, type: "PLAYER", player_id: String(pid), player_name: `P${pid}`, salary, taxi: false, contract_info: "" });
// a LOADED final-year contract (salary $4K, AAV token $6K) held by 0001, a WR (Schedule 1)
const LIVE = () => [{ id: "14056", salary: "4000", contractYear: "1", contractStatus: "Vet-FAA", contractInfo: "CL 2|TCV 12K|AAV 6K|Y1-4K, Y2-8K" }];
const A56 = () => asset({ player_id: "14056", position: "WR", salary: 4000, years: 1, contract_info: "CL 2|TCV 12K|AAV 6K|Y1-4K, Y2-8K", contract_type: "Veteran" });
const optionOf = (a, term) => { const o = CLIENT.buildSyntheticExtensionOptions(a).find((x) => x.extension_term === term); return { player_id: a.player_id, player_name: a.player_name, from_franchise_id: "0001", to_franchise_id: "0002", ...o }; };
const payloadOf = (ext) => ({
  schema_version: 1, source: "test", league_id: "74598", season: "2026",
  teams: [{ role: "left", franchise_id: "0001", selected_assets: [player(14056, 4000)], traded_salary_adjustment_k: 0 }, { role: "right", franchise_id: "0002", selected_assets: [player(13100)], traded_salary_adjustment_k: 0 }],
  extension_requests: ext || [], ui: { left_team_id: "0001", right_team_id: "0002" }, validation: { status: "ready" },
});
function fresh(over) { const env = makeWorkerEnv(over); const mfl = makeMfl({ tokens: { "tok-H": "0012" } }); mfl.install(); mfl.st.salaries = LIVE(); mfl.st.rosters["0002"] = [{ id: "13100", salary: 5000, contractStatus: "Vet-FAA", contractYear: "1", contractInfo: "CL 1|TCV 5K|AAV 5K|Y1-5K" }]; return { env, mfl }; }
const send = (env, payload) => callWorker(env, "POST", `/api/trades/proposals?${Q}&MFL_USER_ID=tok-B`, { body: { league_id: "74598", season: "2026", from_franchise_id: "0001", to_franchise_id: "0002", message: "", payload } });
async function sendOk(env, mfl, ext) { const r = await send(env, payloadOf(ext)); t.ok(r.status < 300, `offer sent: ${r.status} ${r.text.slice(0, 250)}`); mfl.__offer = { ...mfl.st.pending[mfl.st.pending.length - 1] }; return mfl.st.pending[mfl.st.pending.length - 1].trade_id; }
const accept = (env, id) => callWorker(env, "POST", `/api/trades/proposals/action?${Q}&MFL_USER_ID=tok-C`, { body: { action: "ACCEPT", trade_id: id, league_id: "74598", franchise_id: "0002", year: "2026", message: "" } });
const review = (env, id) => callWorker(env, "GET", `/admin/trade/extension-review?${Q}&trade=${id}&APIKEY=${ADMIN_KEY}`);
const acceptCount = (mfl) => mfl.st.done.filter((d) => d.response === "accept").length;
const outboxRows = (env) => { try { return env.UPS_MFL_DB.raw.prepare("SELECT id, trade_id, payload_hash, payload_json, payload_xml_extensions FROM twb_trade_outbox ORDER BY id").all(); } catch (_) { return []; } };
const noMflWrites = (mfl, label) => { t.equal(mfl.writes().filter((w) => w.type !== "tradeProposal").length, 0, `${label}: ZERO writes to MFL (no trade response, no contract or adjustment import)`); t.equal(mfl.st.done.length, 0, `${label}: MFL never accepted`); };

test("ONE CONTRACT, EVERY SURFACE: builder, preview feed, stored offer, review, accept validation and the MFL import all carry the same terms", async () => {
  const a = A56(); const builder = optionOf(a, "2YR");
  // canonical, from the worker's own function
  const canon = priceExtension({ position: "WR", yearsRemaining: 1, salary: 4000, contractInfo: a.contract_info, term: "2YR" }); t.ok(canon.ok);
  const want = num(econ(canon.terms));
  t.deepEqual(want, { term: "2YR", length: 3, tcv: 56000, aav_current: 6000, aav_future: 26000, year1: 4000, by_year: { 1: 4000, 2: 26000, 3: 26000 } }, "hand-checked: WR, +$20K on the AAV token $6K, Y1 stays $4K");
  // (1) builder
  t.deepEqual(num(fromStored(builder)), want, "builder");
  // (2) preview feed
  const feed = canonicalizePreviewRows({ rows: [{ player_id: "14056", franchise_id: "0001", extension_term: "2YR", loaded_indicator: "NONE" }], assetsByFranchise: { "0001": [{ ...a, salary_blank: false }] }, abbrevByFid: { "0001": "L.A." }, prior: {} });
  t.deepEqual(num(fromStored(feed.rows[0])), want, "preview feed");
  // (3) stored-offer creation + (4) the stored offer
  const { env, mfl } = fresh(); const id = await sendOk(env, mfl, [builder]);
  const stored = JSON.parse(outboxRows(env)[0].payload_json).extension_requests[0]; t.deepEqual(num(fromStored(stored)), want, "stored offer");
  // (5) commissioner review (read-only): the canonical price, the comparison and the exact row that would be imported
  const rv = await review(env, id); t.equal(rv.status, 200, rv.text.slice(0, 200));
  const ext = rv.json.extensions[0]; t.equal(rv.json.pricing_version, PX.PRICING_VERSION);
  t.deepEqual(num(econ(ext.canonical)), want, "review: canonical"); t.deepEqual(num(ext.stored && { term: ext.stored.term, length: ext.stored.contract_length, tcv: ext.stored.tcv, aav_current: ext.stored.aav_current, aav_future: ext.stored.aav_future, year1: ext.stored.salary_year1, by_year: ext.stored.salary_by_year }), want, "review: stored");
  t.equal(ext.pricing.ok, true); t.deepEqual(ext.pricing.diffs || [], []);
  noMflWrites(mfl, "the review"); t.equal(mfl.writes("tradeProposal").length, 1, "(the review sent nothing — only the offer's own proposal is there)");
  // (6) accept validation + (7) the MFL import
  const r = await accept(env, id); t.equal(r.status, 200, r.text.slice(0, 300));
  t.equal(acceptCount(mfl), 1);
  const imported = mfl.st.salaries[0]; t.deepEqual(num(fromImported(imported)), want, "MFL import");
  t.equal(imported.contractYear, "3", "contractYear = years remaining = the new length"); t.equal(imported.contractStatus, "Vet-Ext2");
  t.deepEqual({ salary: imported.salary, contractYear: imported.contractYear, contractStatus: imported.contractStatus, contractInfo: imported.contractInfo }, { salary: ext.mfl_import_row.salary, contractYear: ext.mfl_import_row.contractYear, contractStatus: ext.mfl_import_row.contractStatus, contractInfo: ext.mfl_import_row.contractInfo }, "the row the review promised is the row MFL received, byte for byte");
  t.equal(imported.contractInfo, "CL 3|TCV 56K|AAV 6K, 26K|Y1-4K, Y2-26K, Y3-26K|Ext: L.A.|GTD: 42K");
});

test("STORED DIFFERS AT CREATION: year-one, escalator, AAV, TCV, term and length — each is refused before anything is stored or sent (the answer carries the canonical price)", async () => {
  const good = () => optionOf(A56(), "2YR");
  const muts = {
    "year-one salary":  (x) => { x.preview_contract_info_string = "CL 3| TCV 58K| AAV 6K, 26K| Y1-6K, Y2-26K, Y3-26K"; x.new_TCV = 58000; },
    "escalator (+$10K instead of +$20K)": (x) => { x.new_aav_future = 16000; x.new_TCV = 36000; x.preview_contract_info_string = "CL 3| TCV 36K| AAV 6K, 16K| Y1-4K, Y2-16K, Y3-16K"; },
    "AAV (the old builder's 4K salary as the base)": (x) => { x.new_aav_future = 24000; x.new_TCV = 52000; x.preview_contract_info_string = "CL 3| TCV 52K| AAV 4K, 24K| Y1-4K, Y2-24K, Y3-24K"; },
    "TCV": (x) => { x.new_TCV = 60000; },
    "term":  (x) => { x.extension_term = "1YR"; x.option_key = "1YR|NONE"; },
    "length": (x) => { x.new_contract_length = 4; },
  };
  for (const [name, mut] of Object.entries(muts)) {
    const { env, mfl } = fresh(); const x = good(); mut(x);
    const r = await send(env, payloadOf([x]));
    t.equal(r.status, 409, `${name}: ${r.text.slice(0, 160)}`); t.equal(r.json.code, "extension_terms_stale", name);
    t.ok(r.json.skipped[0].diffs.length, `${name}: the sender is told every difference`); if (name !== "term") t.ok(r.json.skipped[0].canonical, `${name}: and the canonical price`);
    t.equal(mfl.st.pending.length, 0, `${name}: nothing sent to MFL`); t.equal(outboxRows(env).length, 0, `${name}: nothing stored`); noMflWrites(mfl, name);
  }
});

test("STALE OFFER CANNOT EXECUTE — and a REGENERATED offer can: the contract moves on, the accept is refused with the diffs, MFL is untouched, the stored offer is never rewritten; a new offer at the new price executes once", async () => {
  const { env, mfl } = fresh(); const id = await sendOk(env, mfl, [optionOf(A56(), "2YR")]);
  const before = clone(outboxRows(env));
  mfl.st.salaries = [{ id: "14056", salary: "7000", contractYear: "1", contractStatus: "Vet-FAA", contractInfo: "CL 1|TCV 7K|AAV 7K|Y1-7K" }];      // a salary change after the offer was made
  const r = await accept(env, id);
  t.equal(r.status, 409); t.equal(r.json.code, "extension_terms_stale"); t.match(r.json.message, /no longer matches the player's current contract/);
  t.ok(r.json.skipped[0].diffs.some((d) => d.field === "salary_year1"), "the difference is named"); t.equal(r.json.skipped[0].canonical.salary_year1, 7000, "and so is the canonical price");
  noMflWrites(mfl, "stale accept"); t.equal(mfl.st.pending.length, 1, "the offer is still pending in MFL, untouched");
  t.equal(JSON.stringify(outboxRows(env)), JSON.stringify(before), "the stored offer is NOT rewritten in place (payload, hash and XML unchanged)");
  const rv = await review(env, id); t.equal(rv.json.extensions[0].verdict, "terms_stale"); t.equal(rv.json.all_will_proceed, false);
  // the versioned workflow: the sender regenerates from the CURRENT contract → a NEW offer (new MFL trade id, new outbox row / payload hash)
  const regen = optionOf(asset({ player_id: "14056", position: "WR", salary: 7000, years: 1, contract_info: "CL 1|TCV 7K|AAV 7K|Y1-7K" }), "2YR");
  const id2 = await sendOk(env, mfl, [regen]); t.notEqual(id2, id);
  t.equal(outboxRows(env).length, 2, "the old row is kept as history; the new offer is a new row");
  const stillStale = await accept(env, id); t.equal(stillStale.status, 409); t.equal(stillStale.json.code, "extension_terms_stale", "the old offer stays refused");
  t.equal(acceptCount(mfl), 0);
  const ok = await accept(env, id2); t.equal(ok.status, 200, ok.text.slice(0, 300)); t.equal(acceptCount(mfl), 1, "exactly one accept, of the regenerated offer");
  t.equal(mfl.st.salaries[0].contractInfo, "CL 3|TCV 61K|AAV 7K, 27K|Y1-7K, Y2-27K, Y3-27K|Ext: L.A.|GTD: 45.8K");
});

test("MISSING PRICING AUTHORITY fails closed before MFL — at creation AND at the accept: position unreadable, last season's contracts unreadable, salaries unreadable", async () => {
  const cases = {
    "the position authority (MFL players export) is down": (m) => { m.st.exportFail = { players: 503 }; },
    "the player's position is not one a schedule covers": (m) => { m.st.positions = { "14056": "TM" }; },
    "last season's contracts (the AAV repair) are unreadable": (m) => { m.st.exportFailByYear = { "2025": { salaries: 503 } }; },
    "the contracts export is down": (m) => { m.st.exportFail = { salaries: 503 }; },
  };
  for (const [name, breakIt] of Object.entries(cases)) {
    { const { env, mfl } = fresh(); breakIt(mfl);                                    // creation
      const r = await send(env, payloadOf([optionOf(A56(), "2YR")]));
      t.equal(r.status, name === "the player's position is not one a schedule covers" ? 503 : 503, `${name} (create): ${r.text.slice(0, 160)}`); t.equal(r.json.code, "extension_check_unavailable");
      t.equal(outboxRows(env).length, 0); noMflWrites(mfl, `${name} (create)`); }
    { const { env, mfl } = fresh(); const id = await sendOk(env, mfl, [optionOf(A56(), "2YR")]); breakIt(mfl);   // accept
      const r = await accept(env, id);
      t.equal(r.status, 503, `${name} (accept): ${r.text.slice(0, 160)}`); t.equal(r.json.code, "extension_check_unavailable"); noMflWrites(mfl, `${name} (accept)`); }
  }
});

test("IMPORT GUARD: if the contract moves between the accept's check and the import, NOTHING is imported — the trade stays EXECUTED-needs-review with the exact reason, and MFL's contract is untouched", async () => {
  const { env, mfl } = fresh(); const id = await sendOk(env, mfl, [optionOf(A56(), "2YR")]);
  const inner = globalThis.fetch;
  globalThis.fetch = async (u, i) => { const k = String(u) + " " + String((i && i.body) || ""); const res = await inner(u, i);
    if (/TYPE=tradeResponse/.test(k) && /RESPONSE=accept/i.test(k)) mfl.st.salaries = [{ id: "14056", salary: "9000", contractYear: "1", contractStatus: "Vet-FAA", contractInfo: "CL 1|TCV 9K|AAV 9K|Y1-9K" }];   // the contract changes right after MFL accepts
    return res; };
  const r = await accept(env, id);
  t.equal(r.status, 200, r.text.slice(0, 300)); t.equal(r.json.executed, true); t.equal(r.json.needs_review, true); t.equal(r.json.failed_step, "extensions");
  t.equal(acceptCount(mfl), 1, "the trade executed (irreversible)"); t.equal(mfl.writes("salaries").length, 0, "no contract import was attempted with a non-canonical price");
  t.equal(mfl.st.salaries[0].contractInfo, "CL 1|TCV 9K|AAV 9K|Y1-9K", "MFL's contract is exactly as it was");
  const row = env.UPS_MFL_DB.raw.prepare("SELECT * FROM ups_trade_executions WHERE exec_key=?").get(String(id));
  t.equal(row.state, "executed_needs_review"); t.match(row.failure_detail, /extension_terms_stale/);
  // the commissioner puts the contract back, and the post-processing-only retry imports the CANONICAL price (never the trade again)
  mfl.st.salaries = LIVE();
  const retry = await callWorker(env, "POST", `/admin/trade/postprocess-retry?${Q}&APIKEY=${ADMIN_KEY}`, { body: { id } });
  t.equal(retry.status, 200, retry.text.slice(0, 200)); t.equal(retry.json.code, "completed"); t.equal(acceptCount(mfl), 1);
  t.equal(mfl.st.salaries[0].contractInfo, "CL 3|TCV 56K|AAV 6K, 26K|Y1-4K, Y2-26K, Y3-26K|Ext: L.A.|GTD: 42K");
});

test("REPLAY uses the canonical price too: the admin replay re-prices from the current contract and refuses a stale stored offer", async () => {
  const { env, mfl } = fresh(); const id = await sendOk(env, mfl, [optionOf(A56(), "2YR")]);
  mfl.st.salaries = [{ id: "14056", salary: "7000", contractYear: "1", contractStatus: "Vet-FAA", contractInfo: "CL 1|TCV 7K|AAV 7K|Y1-7K" }];
  const r = await callWorker(env, "POST", `/api/trades/outbox/replay?${Q}&APIKEY=${ADMIN_KEY}`, { body: { league_id: "74598", season: "2026", trade_id: id } });
  t.equal(r.status, 409, r.text.slice(0, 200)); t.equal(r.json.code, "extension_terms_stale"); t.equal(mfl.writes("salaries").length, 0);
});

test("REVIEW OUTPUT: the commissioner sees stored vs canonical, every diff and the verdict for each extension; it needs the key and never changes anything", async () => {
  const { env, mfl } = fresh(); const id = await sendOk(env, mfl, [optionOf(A56(), "2YR")]);
  const noKey = await callWorker(env, "GET", `/admin/trade/extension-review?${Q}&trade=${id}`); t.ok([401, 403].includes(noKey.status));
  const bad = await callWorker(env, "GET", `/admin/trade/extension-review?${Q}&trade=${id}&APIKEY=wrong`); t.ok([401, 403].includes(bad.status));
  const missing = await callWorker(env, "GET", `/admin/trade/extension-review?${Q}&trade=999999&APIKEY=${ADMIN_KEY}`); t.equal(missing.status, 404);
  mfl.st.salaries = [{ id: "14056", salary: "7000", contractYear: "1", contractStatus: "Tag", contractInfo: "CL 1|TCV 7K|AAV 7K|Y1-7K" }];
  const rv = await review(env, id); t.equal(rv.status, 200);
  const e = rv.json.extensions[0];
  t.equal(e.verdict, "terms_stale"); t.ok(e.pricing.diffs.length > 0); t.equal(e.live.salary, "7000"); t.ok(e.canonical, "the canonical price is shown even when the stored one is stale");
  t.ok(e.eligibility && e.eligibility.ok === false, "eligibility is judged too — a tagged player cannot be extended"); t.equal(e.eligibility.reason, "tagged");
  noMflWrites(mfl, "the review"); t.equal(mfl.st.pending.length, 1);
});

test("THREE-WAY: a 3-way is priced at creation too (a stale/non-canonical extension is never stored), and the same canonical terms pass the Discord accept", async () => {
  const env = makeWorkerEnv({ TRADE_3WAY_EXECUTE: "0" }); const mfl = makeMfl({ tokens: { "tok-H": "0012" } }); mfl.install(); bindSelf(env);
  for (const [fid, d] of [["0008", F.DISCORD.A], ["0001", F.DISCORD.B], ["0012", F.DISCORD.C]]) env.UPS_MFL_DB.raw.prepare("INSERT INTO discord_owners VALUES (?,?,?)").run(fid, "Y", d);
  mfl.st.rosters = { "0008": [{ id: "16614", salary: 5000 }], "0001": [{ id: "16181", salary: 5000, contractStatus: "Vet-FAA", contractYear: "1", contractInfo: "CL 1|TCV 5K|AAV 5K|Y1-5K" }], "0012": [{ id: "16650", salary: 5000, contractStatus: "Vet-FAA", contractYear: "1", contractInfo: "CL 1|TCV 5K|AAV 5K|Y1-5K" }] };
  mfl.st.salaries = [{ id: "16614", salary: "5000", contractYear: "1", contractStatus: "Vet-FAA", contractInfo: "CL 1|TCV 5K|AAV 5K|Y1-5K" }];
  const a = asset({ player_id: "16614", position: "WR", salary: 5000, years: 1, contract_info: "CL 1|TCV 5K|AAV 5K|Y1-5K" });
  const opt = (term) => ({ ...CLIENT.buildSyntheticExtensionOptions(a).find((x) => x.extension_term === term), player_id: "16614", player_name: "P16614", from_franchise_id: "0008", to_franchise_id: "0001" });
  const body = (ext) => ({ league_id: "74598", season: "2026", initiator: { fid: "0008", name: "x" }, team_b: { fid: "0001", name: "L.A. Looks" }, team_c: { fid: "0012", name: "Hawks" },
    movements: [{ from: "0008", to: "0001", asset_tokens: ["P_16614"], cap_k: 0, summary: "a" }, { from: "0001", to: "0012", asset_tokens: ["P_16181"], cap_k: 0, summary: "b" }, { from: "0012", to: "0008", asset_tokens: ["P_16650"], cap_k: 0, summary: "c" }], extension_requests: ext });
  const count = () => env.UPS_MFL_DB.raw.prepare("SELECT COUNT(*) AS n FROM ups_3way_trades").get().n;
  const stale = opt("2YR"); stale.new_aav_future = 20000; stale.new_TCV = 45000; stale.preview_contract_info_string = "CL 3| TCV 45K| AAV 5K, 20K| Y1-5K, Y2-20K, Y3-20K";
  const n0 = count();
  const bad = await callWorker(env, "POST", `/api/trades/3way?MFL_USER_ID=tok-A`, { body: body([stale]) });
  t.equal(bad.status, 409, bad.text.slice(0, 200)); t.equal(bad.json.code, "extension_terms_stale"); t.equal(count(), n0, "nothing stored"); noMflWrites(mfl, "3-way create");
  const good = await callWorker(env, "POST", `/api/trades/3way?MFL_USER_ID=tok-A`, { body: body([opt("2YR")]) });
  t.equal(good.status, 201, good.text.slice(0, 300)); t.equal(count(), n0 + 1);
  const id = good.json.id;
  const rv = await callWorker(env, "GET", `/admin/trade/extension-review?${Q}&trade=${id}&APIKEY=${ADMIN_KEY}`); t.equal(rv.status, 200, rv.text.slice(0, 200)); t.equal(rv.json.kind, "three_way"); t.equal(rv.json.extensions[0].pricing.ok, true);
  const press = (u) => ({ data: { custom_id: `tr3:accept:${id}` }, member: { user: { id: u } } });
  const say = async (r) => (await r.json()).data.content;
  t.match(await say(await handle3WayButton(press(F.DISCORD.B), env, { waitUntil() {} })), /You're in/, "the canonical extension passes the Discord accept");
  mfl.st.salaries = [{ id: "16614", salary: "6000", contractYear: "1", contractStatus: "Vet-FAA", contractInfo: "CL 1|TCV 6K|AAV 6K|Y1-6K" }];
  t.match(await say(await handle3WayButton(press(F.DISCORD.C), env, { waitUntil() {} })), /no longer matches the player's current contract/, "a moved contract refuses the next accept");
});

await run("extension_pricing_surfaces");
restore();
