// #1475: the first-test preflight and the production-untouched comparison, offline on fixtures.
// Neither script's network half runs here; only the pure evaluators.
import { t, test, run } from "./fixtures/mini_test.mjs";
import { evaluateProposal, PROPOSAL } from "../scripts/test_env/first_adddrop_preflight.mjs";
import { diffSnapshots, indexMfl, scopeWhere, D1_TABLES } from "../scripts/test_env/prod_untouched_check.mjs";
import { build as buildTestSite, PROD_WORKER, idempotencyShim, IDEMPOTENCY_SHIM } from "../scripts/test_env/build_test_site.mjs";
import vm from "node:vm";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// A recorded-shape fixture of the TEST league as it read on 2026-11-24 (trimmed to the fields used).
function testLeagueData({ faStatus = "unlocked", rosterExtra = 0, dropSalary = "1000", dropStatus = "WW", dropCy = "1" } = {}) {
  const roster = [{ id: "17509", status: "ROSTER", salary: dropSalary, contractYear: dropCy, contractStatus: dropStatus, contractInfo: "CL 1|" }];
  for (let i = 0; i < 26 + rosterExtra; i++) roster.push({ id: String(20000 + i), status: "ROSTER", salary: "6000", contractYear: "2", contractStatus: "Veteran" });
  return {
    league: { league: { id: "25625", name: "TEST UPS", rosterSize: "30", salaryCapAmount: "300000.49", lockout: "No" } },
    rosters: { rosters: { franchise: [{ id: "0003", player: roster }, { id: "0012", player: [] }] } },
    freeAgents: { freeAgents: { leagueUnit: { player: [{ id: "13348", status: faStatus, salary: "1000", contractStatus: "WW" }] } } },
    nflSchedule: { nflSchedule: { matchup: [{ kickoff: String(Date.parse("2026-12-01T01:15:00Z") / 1000), team: [{ id: "CAR" }, { id: "TBB" }] }] } },
    players: { players: { player: [{ id: "13348", name: "Moore, David", position: "WR", team: "CAR" }, { id: "17509", name: "Brazzell II, Chris", position: "WR", team: "CAR" }] } },
  };
}
const SUNDAY_1000_ET = Date.parse("2026-11-29T15:00:00Z");
const status = (r, id) => (r.checks.find((c) => c.id === id) || {}).status;

test("preflight: the proposal passes only inside the window, with MFL unlocked, in roster and cap limits", () => {
  const ok = evaluateProposal(testLeagueData(), PROPOSAL, SUNDAY_1000_ET);
  t.equal(ok.ready, true, JSON.stringify(ok.checks.filter((c) => c.status !== "pass")));
  t.equal(PROPOSAL.league, "25625"); t.equal(PROPOSAL.franchise_id, "0003");
  const today = evaluateProposal(testLeagueData({ faStatus: "locked" }), PROPOSAL, Date.parse("2026-11-24T13:00:00Z"));
  t.equal(today.ready, false); t.equal(status(today, "ups_fcfs_window"), "fail"); t.equal(status(today, "mfl_free_agent_unlocked"), "fail");
  t.equal(status(evaluateProposal(testLeagueData(), PROPOSAL, Date.parse("2026-12-01T01:30:00Z")), "add_kickoff_not_started"), "fail", "after kickoff");
  t.equal(status(evaluateProposal(testLeagueData({ rosterExtra: 4 }), PROPOSAL, SUNDAY_1000_ET), "roster_count_in_range"), "fail", "31 players is over the max");
  t.equal(status(evaluateProposal(testLeagueData({ rosterExtra: -1 }), PROPOSAL, SUNDAY_1000_ET), "roster_count_in_range"), "fail", "26 players is under the minimum");
  t.equal(status(evaluateProposal(testLeagueData({ dropSalary: "5000" }), PROPOSAL, SUNDAY_1000_ET), "drop_is_cap_free_class"), "fail", "a $5K drop is not cap-free");
  t.equal(status(evaluateProposal(testLeagueData({ dropStatus: "Veteran", dropCy: "3" }), PROPOSAL, SUNDAY_1000_ET), "drop_is_cap_free_class"), "fail", "a multi-year veteran is not cap-free");
  const prodData = testLeagueData(); prodData.league.league.id = "74598";
  t.equal(status(evaluateProposal(prodData, PROPOSAL, SUNDAY_1000_ET), "league_is_test"), "fail", "the production league is never accepted");
});

// Production snapshots: before and after one test operation. Every D1 table is present (fingerprint,
// scope, rows); a test overrides one table.
const MARKERS = { window_start_utc: "2026-11-29T14:00:00Z", window_end_utc: "2026-11-29T15:00:00Z", player_ids: ["13348", "17509"], franchise_ids: ["0003"], idempotency_key: "adddrop-2026-11-29-0003", test_league: "25625" };
const at = (iso) => String(Date.parse(iso) / 1000);
const TX0 = { type: "FREE_AGENT", franchise: "0005", timestamp: at("2026-11-27T14:32:00Z"), transaction: "16387,|15733," };
function d1Table(over) {
  return { fp: { n: 3, max: 3, total: 6 }, scope_kind: "markers", scope_where: "player_id IN ('13348','17509') OR franchise_id IN ('0003')",
    scoped_rows: [{ _rowid: 2, league_id: "74598", franchise_id: "0003", player_id: "15000", note: "gride's row" }], new_rows: [], ...(over || {}) };
}
function prodSnap({ takenAt = "2026-11-29T15:05:00Z", tx = [TX0], roster0003 = ["15000:ROSTER:1000:1:Vet-WW:"], runs = [], commits = [], tables = {}, settings = [{ key: "feature_flags", value: "{}" }], d1 = true } = {}) {
  const snap = {
    taken_at: takenAt,
    mfl: {
      transactions: { transactions: { transaction: tx } },
      rosters: { rosters: { franchise: [{ id: "0003", player: roster0003.map((s) => { const [id, st, sal, cy, cs] = s.split(":"); return { id, status: st, salary: sal, contractYear: cy, contractStatus: cs }; }) }, { id: "0005", player: [{ id: "16387", status: "ROSTER", salary: "1000", contractYear: "1", contractStatus: "Vet-WW" }] }] } },
      salaries: { salaries: { leagueUnit: { player: [{ id: "16387", salary: "1000", contractYear: "1" }] } } },
    },
    github: { commits: [{ sha: "a".repeat(40), message: "data(mfl-snapshot): daily pull" }, ...commits], runs: [{ id: 1, name: "pages", event: "push" }, ...runs] },
  };
  if (d1) {
    snap.d1 = { tables: {}, small: { ups_settings: { hash: JSON.stringify(settings), rows: settings }, ups_runtime_flags: { hash: "[]", rows: [] } } };
    for (const name of D1_TABLES) snap.d1.tables[name] = d1Table(tables[name]);
  }
  return snap;
}
const B = (o) => prodSnap({ takenAt: "2026-11-29T13:55:00Z", ...(o || {}) });

test("production check: complete identical evidence is 'untouched'; real owners' activity is listed but not counted against the test", () => {
  const same = diffSnapshots(B(), prodSnap(), MARKERS);
  t.equal(same.verdict, "untouched", JSON.stringify(same.evidence_gaps)); t.equal(same.untouched, true); t.equal(same.complete, true);
  t.ok(same.manual_checks.some((m) => /Discord/.test(m)), "Discord is always a named manual check");
  t.equal(same.d1_coverage.ups_transactions.existing_rows.startsWith("rows in scope compared"), true);
  const owner = diffSnapshots(B(), prodSnap({ tx: [TX0, { type: "FREE_AGENT", franchise: "0010", timestamp: at("2026-11-29T14:20:00Z"), transaction: "15001,|16001," }] }), MARKERS);
  t.equal(owner.verdict, "untouched", "a real owner's add in the window is not the test's doing");
  t.equal(owner.unrelated_production_activity.length, 1);
});

test("production check: no D1 comparison, an unreadable source, partial coverage or no markers is 'incomplete_evidence', never untouched", () => {
  const noD1 = diffSnapshots(B({ d1: false }), prodSnap({ d1: false }), MARKERS);
  t.equal(noD1.verdict, "incomplete_evidence"); t.equal(noD1.untouched, false); t.ok(noD1.evidence_gaps.some((g) => /D1 not compared/.test(g)));
  const halfD1 = diffSnapshots(B(), prodSnap({ d1: false }), MARKERS);
  t.equal(halfD1.untouched, false, "D1 in only one snapshot");
  const err = diffSnapshots(B(), prodSnap({ tables: { salary_change_log: { error: "D1_ERROR: no such table" } } }), MARKERS);
  t.equal(err.verdict, "incomplete_evidence"); t.ok(err.evidence_gaps.some((g) => /salary_change_log/.test(g)));
  const none = diffSnapshots(B({ tables: { league_events: { scope_kind: "none", scoped_rows: undefined } } }), prodSnap({ tables: { league_events: { scope_kind: "none", scoped_rows: undefined } } }), MARKERS);
  t.equal(none.verdict, "incomplete_evidence"); t.ok(none.evidence_gaps.some((g) => /league_events: no scope column/.test(g)));
  const trunc = diffSnapshots(B(), prodSnap({ tables: { ups_transactions: { new_rows_truncated: true } } }), MARKERS);
  t.equal(trunc.untouched, false);
  const gh = prodSnap(); gh.github = { error: "HTTP 403" };
  t.equal(diffSnapshots(B(), gh, MARKERS).verdict, "incomplete_evidence");
  const mfl = prodSnap(); mfl.mfl = { error: "HTTP 503" };
  t.equal(diffSnapshots(B(), mfl, MARKERS).verdict, "incomplete_evidence");
  t.equal(diffSnapshots(B(), prodSnap(), {}).verdict, "incomplete_evidence", "no markers");
});

test("production check: an UPDATE to an existing row is found by content, with no change in counts", () => {
  const upd = diffSnapshots(B(), prodSnap({ tables: { ups_drop_events: { scoped_rows: [{ _rowid: 2, league_id: "74598", franchise_id: "0003", player_id: "15000", note: "edited" }] } } }), MARKERS);
  t.equal(upd.verdict, "review_required", "an in-scope production row changed: not attributable automatically, so reviewed");
  t.ok(upd.review.some((f) => f.area === "d1_ups_drop_events" && /row 2 updated/.test(f.what)));
  const tied = diffSnapshots(B(), prodSnap({ tables: { salary_change_log: { scoped_rows: [{ _rowid: 2, league_id: "74598", franchise_id: "0003", player_id: "15000", note: "adddrop-2026-11-29-0003" }] } } }), MARKERS);
  t.equal(tied.verdict, "associated_activity_found", "the update carries the test's idempotency key");
  const into = diffSnapshots(B(), prodSnap({ tables: { ups_add_events: { scoped_rows: [{ _rowid: 2, league_id: "74598", franchise_id: "0003", player_id: "15000", note: "gride's row" }, { _rowid: 1, league_id: "74598", player_id: "13348" }] } } }), MARKERS);
  t.equal(into.verdict, "associated_activity_found", "an old row changed so it now names a test player");
  t.ok(into.associated.some((f) => /row 1 now in scope/.test(f.what)));
  const small = diffSnapshots(B(), prodSnap({ settings: [{ key: "feature_flags", value: "{\"WAIVERS_INAPP_ENABLED\":\"1\"}" }] }), MARKERS);
  t.equal(small.verdict, "review_required", "global flags changed in the window");
});

test("production check: deletions anywhere in a table are found from its fingerprint; in-scope deletions by row", () => {
  const del = diffSnapshots(B(), prodSnap({ tables: { ups_transactions: { fp: { n: 2, max: 3, total: 4 } } } }), MARKERS);
  t.equal(del.verdict, "review_required"); t.ok(del.review.some((f) => /1 row\(s\) deleted/.test(f.what)));
  const delAndAdd = diffSnapshots(B(), prodSnap({ tables: { ups_transactions: { fp: { n: 3, max: 4, total: 8 }, new_rows: [{ _rowid: 4, league_id: "74598", player_id: "15001" }] } } }), MARKERS);
  t.equal(delAndAdd.verdict, "review_required", "one row added and one deleted keeps the count; the deletion is still found");
  const replaced = diffSnapshots(B(), prodSnap({ tables: { ups_transactions: { fp: { n: 3, max: 3, total: 7 } } } }), MARKERS);
  t.ok(replaced.review.some((f) => /replaced/.test(f.what)), "same count, different rowids");
  const scopedGone = diffSnapshots(B(), prodSnap({ tables: { ups_mym_submissions: { scoped_rows: [], fp: { n: 2, max: 3, total: 4 } } } }), MARKERS);
  t.ok(scopedGone.review.some((f) => /row 2 left scope or was deleted/.test(f.what)));
  const newTied = diffSnapshots(B(), prodSnap({ tables: { ups_transactions: { fp: { n: 4, max: 4, total: 10 }, new_rows: [{ _rowid: 4, league_id: "25625", player_id: "13348" }] } } }), MARKERS);
  t.equal(newTied.verdict, "associated_activity_found", "a new production row naming the test league and player");
});

test("production check: MFL and GitHub content checks; an export window sliding is not a deletion", () => {
  const cases = [
    ["a 74598 transaction naming a test player", { tx: [TX0, { type: "FREE_AGENT", franchise: "0003", timestamp: at("2026-11-29T14:20:00Z"), transaction: "13348,|17509," }] }, "associated_activity_found"],
    ["the 74598 roster of franchise 0003 changed in place", { roster0003: ["15000:ROSTER:2000:1:Vet-WW:"] }, "review_required"],
    ["a repository_dispatch run in the window", { runs: [{ id: 9, name: "log-contract-activity", event: "repository_dispatch" }] }, "review_required"],
    ["a commit with a test label", { commits: [{ sha: "b".repeat(40), message: "Log contract activity [TEST]" }] }, "associated_activity_found"],
  ];
  for (const [label, over, verdict] of cases) t.equal(diffSnapshots(B(), prodSnap(over), MARKERS).verdict, verdict, label);
  const old = { type: "FREE_AGENT", franchise: "0007", timestamp: at("2026-11-22T13:00:00Z"), transaction: "1,|2," };
  const slid = diffSnapshots(B({ takenAt: "2026-11-29T12:00:00Z", tx: [TX0, old] }), prodSnap({ takenAt: "2026-11-29T15:05:00Z" }), MARKERS);
  t.equal(slid.verdict, "untouched", "a transaction that aged out of the 7-day export is not reported as deleted");
  const gone = diffSnapshots(B(), prodSnap({ tx: [] }), MARKERS);
  t.equal(gone.verdict, "review_required", "a transaction inside both exports' range disappearing is flagged");
  t.equal(Object.keys(indexMfl(prodSnap().mfl).tx).length, 1);
});

test("production check: the D1 scope query names only the markers' players, franchises and the test league, safely quoted", () => {
  const w = scopeWhere(["rowid", "league_id", "player_id", "franchise_id", "added_players"], MARKERS);
  t.match(w, /player_id IN \('13348','17509'\)/); t.match(w, /franchise_id IN \('0003'\)/); t.match(w, /league_id = '25625'/); t.match(w, /added_players/);
  t.equal(scopeWhere(["rowid", "event", "date"], MARKERS), null, "no scope column");
  t.doesNotMatch(scopeWhere(["player_id"], { player_ids: ["1'); DROP TABLE x;--"] }) || "", /DROP/, "non-numeric ids are ignored");
});

test("test site build: allowlist only, test worker and 25625 everywhere, connect-src limited to the test worker", () => {
  const TEST = "https://ups-test.keith-creelman.workers.dev";
  t.throws(() => buildTestSite(path.join(os.tmpdir(), "x-never"), PROD_WORKER), /not production/, "refuses the production worker");
  t.throws(() => buildTestSite(path.join(os.tmpdir(), "x-never"), "https://evil.example.com"), /workers\.dev/, "refuses a non-workers.dev address");
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "ups-test-site-"));
  const r = buildTestSite(out, TEST);
  const all = [];
  (function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else all.push(path.relative(out, p).split(path.sep).join("/")); } })(out);
  t.ok(all.every((f) => f === "_headers" || f === "index.html" || f.startsWith("m/") || f.startsWith("shared/")), "only site/m, the shared files the page loads, the root redirect and _headers");
  t.ok(!all.some((f) => /trades\/|reports\/|wire\/|rosters\//.test(f)), "no other site/ folder is published");
  t.equal(all.filter((f) => f.startsWith("shared/")).length, r.shared.length);
  for (const f of all) { const txt = fs.readFileSync(path.join(out, f), "latin1"); t.ok(!txt.includes("upsmflproduction.keith-creelman") && !txt.includes("74598"), `${f}: no production worker, no 74598`); }
  const app = fs.readFileSync(path.join(out, "m", "app.js"), "utf8");
  t.match(app, /WORKER_BASE_DEFAULT = "https:\/\/ups-test\.keith-creelman\.workers\.dev"/); t.match(app, /LEAGUE_ID_DEFAULT = "25625"/);
  const h = fs.readFileSync(path.join(out, "_headers"), "utf8");
  t.match(h, new RegExp(`connect-src 'self' ${TEST.replace(/[.]/g, "\\.")};`), "the page may fetch only itself and the test worker");
  t.match(h, /script-src 'self' 'sha256-[A-Za-z0-9+/=]+'/, "the one inline boot script is allowed by hash");
  t.match(h, /X-Robots-Tag: noindex/);
  const idx = fs.readFileSync(path.join(out, "m", "index.html"), "utf8");
  t.match(idx, /<title>UPS TEST · /);
  t.equal(idx.search(/<script\b/), idx.indexOf(`<script src="${IDEMPOTENCY_SHIM}">`), "the idempotency shim loads before every other script");
  t.ok(all.includes(`m/${IDEMPOTENCY_SHIM}`), "the shim is published");
  t.throws(() => buildTestSite(out, TEST), /not empty/, "refuses a non-empty output folder");
  fs.rmSync(out, { recursive: true, force: true });
});

test("test site build: refuses symlinks and sources outside site/m and the selected shared files", () => {
  const TEST = "https://ups-test.keith-creelman.workers.dev";
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ups-test-site-src-"));
  const priv = path.join(root, "private.json"); fs.writeFileSync(priv, '{"owner_note":"x"}');
  const fakeSite = (name) => {
    const site = path.join(root, name);
    fs.mkdirSync(path.join(site, "m"), { recursive: true }); fs.mkdirSync(path.join(site, "shared"), { recursive: true });
    fs.writeFileSync(path.join(site, "m", "index.html"), '<title>UPS</title><script src="../shared/a.js"></script><script>boot()</script>');
    fs.writeFileSync(path.join(site, "m", "app.js"), "var x=1;");
    fs.writeFileSync(path.join(site, "shared", "a.js"), "var a=1;");
    fs.writeFileSync(path.join(site, "shared", "b.js"), "var b=1;");
    return site;
  };
  const outDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "ups-test-site-out-"));
  const ok = fakeSite("ok");
  const r = buildTestSite(outDir(), TEST, ok);
  t.deepEqual(r.shared, ["a.js"], "a plain fake site builds, with only the referenced shared file");
  const s1 = fakeSite("file_link"); fs.symlinkSync(priv, path.join(s1, "m", "data.json"));
  t.throws(() => buildTestSite(outDir(), TEST, s1), /symlink: site\/m\/data\.json/, "a symlinked file inside site/m is refused");
  const s2 = fakeSite("dir_link"); fs.symlinkSync(root, path.join(s2, "m", "more"));
  t.throws(() => buildTestSite(outDir(), TEST, s2), /symlink: site\/m\/more/, "a symlinked folder inside site/m is refused");
  const s3 = fakeSite("shared_link"); fs.rmSync(path.join(s3, "shared", "a.js")); fs.symlinkSync(priv, path.join(s3, "shared", "a.js"));
  t.throws(() => buildTestSite(outDir(), TEST, s3), /symlink: site\/shared\/a\.js/, "a selected shared file that is a symlink is refused");
  const s4 = fakeSite("m_link"); fs.rmSync(path.join(s4, "m"), { recursive: true }); fs.symlinkSync(path.join(ok, "m"), path.join(s4, "m"));
  t.throws(() => buildTestSite(outDir(), TEST, s4), /symlink: site\/m/, "site/m itself as a symlink is refused");
  fs.rmSync(root, { recursive: true, force: true });
});

test("test site idempotency shim: each write to the test worker gets its own key; reads, other hosts and a caller's key are untouched", async () => {
  const WORKER = "https://ups-test.keith-creelman.workers.dev";
  const seen = [];
  const window = { location: { href: "https://ups-test-25625.pages.dev/m/" }, crypto: globalThis.crypto,
    fetch: async (input, init) => { const h = new Headers((init && init.headers) || (input instanceof Request ? input.headers : undefined)); seen.push({ key: h.get("Idempotency-Key"), ct: h.get("Content-Type") }); return new Response("{}"); } };
  vm.runInNewContext(idempotencyShim(WORKER), { window, Request, Headers, URL, Uint8Array });
  const last = () => seen[seen.length - 1];
  await window.fetch(WORKER + "/api/submit-lineup?L=25625", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  const k1 = last().key; t.match(k1, /^ui-[0-9a-f-]{32,36}$/); t.equal(last().ct, "application/json", "the app's own headers are kept");
  await window.fetch(WORKER + "/api/submit-lineup?L=25625", { method: "post", body: "{}" });
  t.ok(last().key && last().key !== k1, "a second send gets a new key");
  await window.fetch(WORKER + "/api/me?L=25625"); t.equal(last().key, null, "a read gets no key");
  await window.fetch("https://api.myfantasyleague.com/2026/export", { method: "POST" }); t.equal(last().key, null, "another host gets no key");
  await window.fetch(WORKER + "/x", { method: "POST", headers: { "Idempotency-Key": "caller-key-0001" } }); t.equal(last().key, "caller-key-0001", "a caller's key is kept");
  await window.fetch(new Request(WORKER + "/y", { method: "POST", headers: { "Content-Type": "text/plain" }, body: "a" }));
  t.match(last().key, /^ui-/); t.equal(last().ct, "text/plain", "a Request's own headers are kept");
  const before = window.fetch; vm.runInNewContext(idempotencyShim(WORKER), { window, Request, Headers, URL, Uint8Array });
  t.equal(window.fetch, before, "loading the shim twice doesn't wrap twice");
  t.throws(() => idempotencyShim("not a url"), /Invalid URL/);
});

test("test site build --m2: a built 2.0 app is published at /m2/ as built; symlinks, inline scripts, production names and a missing page are refused", () => {
  const TEST = "https://ups-test.keith-creelman.workers.dev";
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ups-m2-built-"));
  const app = (name, extra) => {
    const d = path.join(root, name); fs.mkdirSync(path.join(d, "lib"), { recursive: true });
    fs.writeFileSync(path.join(d, "index.html"), '<!doctype html><title>UPS TEST</title><script src="config.js"></script><script src="lib/a.js"></script>');
    fs.writeFileSync(path.join(d, "config.js"), 'window.C = { workerBase: "' + TEST + '", leagueId: "25625" };');
    fs.writeFileSync(path.join(d, "lib", "a.js"), "var a = 1;");
    fs.writeFileSync(path.join(d, "_headers"), "/*\n  X-Test: 1\n");
    if (extra) extra(d);
    return d;
  };
  const outDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "ups-m2-out-"));
  const o = outDir();
  buildTestSite(o, TEST, undefined, app("ok"));
  t.ok(fs.existsSync(path.join(o, "m2", "index.html")) && fs.existsSync(path.join(o, "m2", "lib", "a.js")), "the app is published under /m2/");
  t.ok(!fs.existsSync(path.join(o, "m2", "_headers")), "its _headers file is left out (the site's own apply)");
  t.equal(fs.readFileSync(path.join(o, "m2", "config.js"), "utf8"), fs.readFileSync(path.join(root, "ok", "config.js"), "utf8"), "copied as built, byte for byte");
  t.throws(() => buildTestSite(outDir(), TEST, undefined, app("inline", (d) => fs.writeFileSync(path.join(d, "x.html"), "<script>go()</script>"))), /inline script/);
  t.throws(() => buildTestSite(outDir(), TEST, undefined, app("link", (d) => { fs.writeFileSync(path.join(root, "secret.json"), "{}"); fs.symlinkSync(path.join(root, "secret.json"), path.join(d, "data.json")); })), /symlink: m2\/data\.json/);
  t.throws(() => buildTestSite(outDir(), TEST, undefined, app("prod", (d) => fs.writeFileSync(path.join(d, "lib", "b.js"), 'var L = "74598";'))), /names league 74598: m2\/lib\/b\.js/);
  t.throws(() => buildTestSite(outDir(), TEST, undefined, app("nopage", (d) => fs.rmSync(path.join(d, "index.html")))), /no page/);
  const lk = path.join(root, "linked"); fs.symlinkSync(path.join(root, "ok"), lk);
  t.throws(() => buildTestSite(outDir(), TEST, undefined, lk), /plain folder/);
  fs.rmSync(root, { recursive: true, force: true });
});

await run("test_env_scripts");
