// /commish-contract-update, /offer-mym and /offer-restructure may only write a contract
// for a team the caller is PROVEN to control.
//   node tests/contract_update_authz.test.mjs
//
// Why (2026-10-07): these routes write contracts to MFL with the COMMISSIONER's cookie
// (TYPE=salaries) for whatever franchise_id the body names, and they checked no caller at
// all. Reproduced with the real route and a fake MFL: an anonymous POST rewrote a
// $30K, 2-year contract to $1K, 1-year. The body's commish_override_flag (which bypasses
// tag / MYM / restructure deadlines) was likewise honoured for anyone who sent it.
//
// Real route, stateful fake MFL (tests/fixtures/worker_harness.mjs). Nothing touches the network.
import fs from "node:fs";
import { t, test, run } from "./fixtures/mini_test.mjs";
import { makeWorkerEnv, makeMfl, callWorker, quiet, ADMIN_KEY } from "./fixtures/worker_harness.mjs";

const restoreConsole = quiet();
const ORIG = { id: "15000", salary: "30000", contractYear: "2", contractStatus: "Vet-FAA", contractInfo: "CL 2| TCV 60K| AAV 30K| Y1-30K, Y2-30K| GTD: 45K" };

function fresh(opts) {
  const env = makeWorkerEnv({ YEAR: "2026", LEAGUE_ID: "74598" });
  const mfl = makeMfl(opts);
  mfl.st.rosters = { "0003": [{ id: "15000", salary: 30000, status: "ROSTER", contractYear: 2, contractStatus: ORIG.contractStatus, contractInfo: ORIG.contractInfo }] };
  mfl.st.salaries = [{ ...ORIG }];
  mfl.install();
  return { env, mfl };
}
const rewrite = (env, path, query, extra) => callWorker(env, "POST", `${path}?L=74598&YEAR=2026${query}`, { body: {
  type: "MANUAL_CONTRACT_UPDATE", submission_kind: "manual", L: "74598", YEAR: "2026",
  player_id: "15000", player_name: "Test", franchise_id: "0003", franchise_name: "Gride", position: "WR",
  salary: 1000, contract_year: 1, contract_status: "Vet-FAA", contract_info: "CL 1| TCV 1K| AAV 1K", ...(extra || {}),
} });
const untouched = (mfl) => JSON.stringify(mfl.st.salaries) === JSON.stringify([ORIG]) && mfl.writes("salaries").length === 0;

for (const path of ["/commish-contract-update", "/offer-mym", "/offer-restructure"]) {
  test(`${path}: no session at all → refused, nothing written`, async () => {
    const { env, mfl } = fresh();
    const r = await rewrite(env, path, "");
    t.equal(r.status, 401, r.text.slice(0, 200));
    t.equal(r.json.ok, false); t.ok(r.json.error, "a readable error for the clients");
    t.ok(untouched(mfl), "Gride's contract is untouched");
  });
}

test("a made-up MFL_USER_ID is refused", async () => {
  const { env, mfl } = fresh();
  const r = await rewrite(env, "/commish-contract-update", "&MFL_USER_ID=not-a-real-session");
  t.ok(r.status === 401 || r.status === 403, `got ${r.status}`);
  t.ok(untouched(mfl));
});

test("one owner's real session cannot write ANOTHER team's contract", async () => {
  const { env, mfl } = fresh();
  const r = await rewrite(env, "/commish-contract-update", "&MFL_USER_ID=tok-B");   // L.A. Looks
  t.equal(r.status, 403, r.text.slice(0, 200));
  t.match(r.json.error, /own team/i);
  t.ok(untouched(mfl));
});

test("a dry run is gated too (it can't be used to probe)", async () => {
  const { env, mfl } = fresh();
  const r = await rewrite(env, "/commish-contract-update", "&MFL_USER_ID=tok-B", { dry_run: 1 });
  t.equal(r.status, 403);
  t.ok(untouched(mfl));
});

test("fail closed: MFL can't confirm the session → 503, nothing written", async () => {
  const { env, mfl } = fresh({ myleaguesDown: true });
  const r = await rewrite(env, "/commish-contract-update", "&MFL_USER_ID=tok-O");
  t.equal(r.status, 503, r.text.slice(0, 200));
  t.ok(untouched(mfl));
});

test("the owner's proven session still writes their OWN team's contract", async () => {
  const { env, mfl } = fresh();
  const r = await rewrite(env, "/commish-contract-update", "&MFL_USER_ID=tok-O");   // Gride
  t.equal(r.status, 200, r.text.slice(0, 300));
  t.equal(mfl.writes("salaries").length, 1);
  t.ok(mfl.writes("salaries")[0].asCommish, "the write itself still goes out with the commissioner's cookie (MFL only takes salaries imports from the commissioner)");
  t.equal(mfl.st.salaries[0].salary, "1000");
});

test("the commissioner key (the worker's own self-calls) and a proven commissioner session may act for any team", async () => {
  const a = fresh();
  t.equal((await rewrite(a.env, "/commish-contract-update", `&APIKEY=${ADMIN_KEY}`)).status, 200);
  t.equal(a.mfl.writes("salaries").length, 1);
  const b = fresh();
  t.equal((await rewrite(b.env, "/commish-contract-update", "&MFL_USER_ID=tok-A")).status, 200, "tok-A = 0008, on the commissioner list");
  t.equal(b.mfl.writes("salaries").length, 1);
});

test("an owner can't grant itself the commissioner override; the commissioner still can", async () => {
  const src = fs.readFileSync(new URL("../worker/src/index.js", import.meta.url), "utf8");
  t.match(src, /\(raw === "1" \|\| raw === "true" \|\| raw === "yes"\) && contractCallerIsCommish \? 1 : 0/);
});

await run("contract_update_authz");
restoreConsole();
