// The staged-backfill workflow never puts the commissioner key in a URL or a log.
//   node tests/players_backfill_workflow.test.mjs
// (Keith 2026-10-11: don't introduce ?APIKEY= in a new workflow.)
import fs from "node:fs";
import { t, test, run } from "./fixtures/mini_test.mjs";

const Y = fs.readFileSync(".github/workflows/players-data-backfill.yml", "utf8");

test("the key travels only in an Authorization header read from stdin; nothing prints it", () => {
  t.doesNotMatch(Y, /APIKEY=/, "no ?APIKEY= anywhere");
  t.doesNotMatch(Y, /set -x|set -o xtrace/, "no shell tracing (it would echo the expanded key)");
  t.doesNotMatch(Y, /echo[^\n]*\$\{?KEY\b/, "never echoes the key");
  t.match(Y, /printf 'Authorization: Bearer %s\\n' "\$KEY" \| curl [^|]*?-H @- /, "header built from the env var and handed to curl on stdin (not argv)");
  t.match(Y, /KEY: \$\{\{ secrets\.COMMISH_API_KEY \}\}/, "the key comes from the repository secret");
  const url = /"(https:\/\/upsmflproduction[^"]+)"/.exec(Y)[1];
  t.doesNotMatch(url, /KEY|key=/i, "the rebuild URL carries no credential: " + url);
});

test("writes are guarded: the refresh's concurrency group, a typed confirmation, production named explicitly", () => {
  t.match(Y, /concurrency:\s*\n\s*group: nflverse-stats-refresh\s*\n\s*cancel-in-progress: false/);
  t.match(Y, /if \[ "\$STEP" != "stage" \] && \[ "\$CONFIRM" != "\$TAG" \]/);
  t.match(Y, /--db ups-mfl-db/);
  t.match(Y, /workflow_dispatch:/); t.doesNotMatch(Y, /schedule:|push:|pull_request:/, "manual only");
});

test("swap / rollback / rebuild first check production serves #1219's worker; rebuild runs only the rebuild", () => {
  const check = /- name: Check production serves the #1219 worker[\s\S]*?(?=\n      - name: )/.exec(Y);
  t.ok(check, "the check step exists");
  t.match(check[0], /if: env\.STEP == 'swap' \|\| env\.STEP == 'rollback' \|\| env\.STEP == 'rebuild'/);
  t.match(check[0], /\/api\/player-status\?season=\$\{SEASON\}/, "probes the route only #1219 has");
  t.doesNotMatch(check[0], /KEY|Authorization/, "the probe carries no credential");
  t.ok(Y.indexOf("Check production serves the #1219 worker") < Y.indexOf("- name: Run ${{ github.event.inputs.step }}"), "the check runs before the data step");
  t.match(Y, /- name: Run \$\{\{ github\.event\.inputs\.step \}\}\n        if: env\.STEP != 'rebuild'/, "rebuild skips the data step");
  t.match(Y, /options: \[stage, swap, rollback, cleanup, rebuild\]/);
  t.match(Y, /if: success\(\) && \(github\.event\.inputs\.step == 'swap' \|\| github\.event\.inputs\.step == 'rollback' \|\| github\.event\.inputs\.step == 'rebuild'\)/);
});

await run("players_backfill_workflow");
