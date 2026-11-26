// UPS 2027 R13 F6 (Keith, 2026-11-26, "A"): in the Test target the projections are MFL's own weekly projections for the league (TYPE=projectedScores),
// read through the worker's MFL route, in the shape the app already draws. The Preview build keeps its stored projections read.
//   node tests/mobile2027_r13_projections.test.mjs
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { t, test, run } from "./fixtures/mini_test.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const D = require(path.join(HERE, "..", "apps", "mobile2027", "src", "lib", "data.js"));
const BASE = "https://ups-test.keith-creelman.workers.dev";
function loader(projections, answer) {
  const calls = [];
  const f = (url, opts) => { calls.push({ url, opts }); const a = answer(url); return Promise.resolve({ ok: a.status < 400, status: a.status, json: () => Promise.resolve(a.body), text: () => Promise.resolve(JSON.stringify(a.body)), headers: { get: () => "application/json" } }); };
  return { L: D.createLoader({ workerBase: BASE, leagueId: "25625", season: "2026", projections }, f), calls };
}
const mfl = (week, rows) => ({ status: 200, body: { projectedScores: { week: String(week), playerScore: rows } } });

test("F6: one MFL projectedScores read for the week; each asked player gets MFL's number, as of the read; a missing or unreadable score is no projection", async () => {
  const { L, calls } = loader("mfl", () => mfl(12, [{ id: "16148", score: "18.4" }, { id: "15700", score: "" }, { id: "14000", score: "1e3" }, { id: "13000", score: "9.25" }, { id: "99999", score: "30.0" }]));
  const r = await L.projections(2026, 12, ["16148", "15700", "14000", "13000", "12000"]);
  t.equal(r.state, "ok", JSON.stringify(r)); t.equal(r.data.provider, "MFL"); t.equal(r.data.week, 12);
  t.equal(r.data.projections["16148"].projected_score, 18.4); t.match(r.data.projections["16148"].captured_at, /^\d{4}-\d\d-\d\dT/);
  t.equal(r.data.projections["13000"].projected_score, 9.25);
  t.equal(r.data.projections["15700"], null, "blank score: no projection"); t.equal(r.data.projections["14000"], null, "1e3 is not a plain decimal: no projection");
  t.equal(r.data.projections["12000"], null, "not in MFL's list: no projection"); t.ok(!("99999" in r.data.projections), "only the players asked about");
  t.equal(calls.length, 1); const u = new URL(calls[0].url);
  t.equal(u.origin + u.pathname, BASE + "/api/mfl-export"); t.equal(u.searchParams.get("TYPE"), "projectedScores"); t.equal(u.searchParams.get("L"), "25625"); t.equal(u.searchParams.get("W"), "12");
  t.equal(calls[0].opts.method, "GET"); t.equal(calls[0].opts.credentials, "omit");
  await L.projections(2026, 12, ["16148"]); t.equal(calls.length, 1, "kept for its freshness window: asked once for any team on the page");
});

test("F6: an answer for another week is an error, not a projection; the Preview build still asks the stored projections route", async () => {
  const a = loader("mfl", () => mfl(11, [{ id: "16148", score: "18.4" }]));
  t.equal((await a.L.projections(2026, 12, ["16148"])).state, "error");
  const b = loader(undefined, () => ({ status: 404, body: {} }));
  await b.L.projections(2026, 12, ["16148"]);
  t.ok(b.calls.length >= 1 && b.calls.every((c) => c.url.includes("/api/player-projections")), "Preview/default: /api/player-projections, never MFL's projectedScores");
});

await run("mobile2027_r13_projections");
