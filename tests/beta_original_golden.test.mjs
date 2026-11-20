// Mobile beta, Stage 1 (#1475): the original app is unchanged. Replays 27 original-app requests against this branch's worker and compares each
// answer (status, body, and which MFL calls it made) with the answers RECORDED from origin/main (7d24bc5b) before any beta code.
//   node tests/beta_original_golden.test.mjs
//
// If a change to the worker moves one of these answers, this fails: either the change touched the original app (not allowed in the beta work),
// or the recording needs a reviewed refresh (scripts: see docs/BETA_SESSIONS.md).
import fs from "node:fs";
import { t, test, run } from "./fixtures/mini_test.mjs";
import { makeWorkerEnv, makeMfl, callWorker, quiet } from "./fixtures/worker_harness.mjs";
import { ORIGINAL_REQUESTS, STABLE } from "./fixtures/beta_original_requests.mjs";

const golden = JSON.parse(fs.readFileSync(new URL("./fixtures/beta_original_golden.json", import.meta.url), "utf8"));
const restore = quiet();

test("GOLDEN: the recording covers every request in the list, in order", () => {
  t.equal(golden.requests.length, ORIGINAL_REQUESTS.length);
  ORIGINAL_REQUESTS.forEach(([name, method, path], i) => { t.equal(golden.requests[i].name, name); t.equal(golden.requests[i].method, method); t.equal(golden.requests[i].path, path); });
  t.ok(golden.recorded_from.includes("origin/main"));
});

for (const [i, [name, method, path, opts]] of ORIGINAL_REQUESTS.entries()) {
  test(`ORIGINAL APP UNCHANGED: ${name}`, async () => {
    const want = golden.requests[i];
    const env = makeWorkerEnv(); const mfl = makeMfl({}); mfl.install();
    const r = await callWorker(env, method, path, opts || {});
    mfl.restore();
    t.equal(r.status, want.status, `${method} ${path}: status`);
    t.equal(STABLE(r.text), want.body, `${method} ${path}: body`);
    t.deepEqual(mfl.st.exports.map((e) => e.type), want.mfl_exports, "the same MFL reads, in the same order");
    t.equal(mfl.st.imports.length, want.mfl_imports, "the same number of MFL writes");
    t.ok(!/ups_beta_/.test(JSON.stringify(env.UPS_MFL_DB.log.map((l) => l.sql))), "the original app never touches a beta table");
    t.ok(!env.UPS_MFL_DB.log.some((l) => /feature_flags/.test(l.sql) && !/\/api\/(waivers|hall)/.test(path) && !/\/admin\//.test(path) && !/auction/.test(path)), "no beta flag read on an original-app request");
  });
}

test("GOLDEN: the preflight answer is unchanged except that it now also allows the two beta request headers", async () => {
  const env = makeWorkerEnv();
  const r = await callWorker(env, "OPTIONS", "/api/me?L=74598", { headers: { Origin: "https://keithcreelman.github.io" } });
  t.equal(r.status, 200);
  t.equal(r.headers.get("access-control-allow-origin"), "*");
  t.equal(r.headers.get("access-control-allow-methods"), "GET,POST,OPTIONS");
  t.equal(r.headers.get("access-control-allow-headers"), "Content-Type, Authorization, X-UPS-Client");
});

await run("beta_original_golden");
restore();
