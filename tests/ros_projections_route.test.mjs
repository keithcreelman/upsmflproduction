// /api/ros-projections (worker/src/ros_projections.js): one R2 read that fails closed. No file, an unreadable file,
// another season or a file older than 8 days never reaches an owner as numbers.
//   node tests/ros_projections_route.test.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { t, test, run } from "./fixtures/mini_test.mjs";
import { rosAnswer, rosProjections, ROS_KEY, ROS_MAX_AGE_DAYS } from "../worker/src/ros_projections.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const NOW = Date.parse("2026-10-30T12:00:00Z"), DAY = 86400000;
const iso = (ms) => new Date(ms).toISOString();
const W = (x) => [x, 2, null];
const file = (o = {}) => ({ version: 1, season: 2026, throughWeek: 7, weeks: [8, 10], nWeeks: 3, asOf: iso(NOW - DAY), playedExcluded: { 8: ["CAR", "GBP"] }, label: "UPS Center projection", sources: { offense: "x" }, rule: "r", avail: { 2: { k: "none" } },
  players: { 1: { ppg: 12.34, projWeeks: 2, w: W(1) }, 2: { ppg: null, projWeeks: 0, w: [null, null, null] }, 3: { ppg: 0, projWeeks: 1, w: W(0) } }, ...o });
const bucket = (obj) => ({ keys: [], get(k) { this.keys.push(k); return Promise.resolve(obj); } });

test("a fresh file: each player's number, weekly line and availability; nulls left out, a real 0 kept", () => {
  const r = rosAnswer(file(), 2026, NOW);
  t.equal(r.status, 200); t.equal(r.payload.ok, true);
  t.deepEqual(r.payload.players, { 1: 12.34, 3: 0 });
  t.deepEqual(r.payload.weekly, { 1: W(1), 3: W(0) }, "a player with no number has no weekly line");
  t.deepEqual(r.payload.avail, { 2: { k: "none" } }, "why a player's weeks are missing");
  t.deepEqual(r.payload.weeks, [8, 10]); t.equal(r.payload.nWeeks, 3); t.equal(r.payload.throughWeek, 7); t.deepEqual(r.payload.playedExcluded, { 8: ["CAR", "GBP"] }); t.equal(r.payload.label, "UPS Center projection");
  t.equal(r.payload.players[1], 12.34);
});

test("the stale limit: 8 days serves, 8 days and a second refuses", () => {
  t.equal(rosAnswer(file({ asOf: iso(NOW - ROS_MAX_AGE_DAYS * DAY) }), 2026, NOW).status, 200);
  const r = rosAnswer(file({ asOf: iso(NOW - ROS_MAX_AGE_DAYS * DAY - 1000) }), 2026, NOW);
  t.equal(r.status, 503); t.equal(r.payload.error, "stale"); t.equal(r.payload.players, undefined);
});

test("every bad file fails closed with no numbers", () => {
  for (const [f, e] of [[null, "unreadable"], [{}, "unreadable"], [file({ version: 2 }), "unreadable"], [file({ players: null }), "unreadable"], [file({ avail: null }), "unreadable"], [file({ nWeeks: 0 }), "unreadable"], [file({ weeks: null }), "unreadable"], [file({ players: { 1: { ppg: 1, w: [1] } } }), "unreadable"], [file({ players: { 1: { ppg: 1 } } }), "unreadable"], [file({ asOf: "soon" }), "unreadable"], [file({ season: 2025 }), "wrong_season"]]) {
    const r = rosAnswer(f, 2026, NOW);
    t.equal(r.payload.ok, false); t.equal(r.payload.error, e); t.equal(r.payload.players, undefined);
  }
});

test("the route: reads ros/latest.json once; a missing file, bucket or bad season says so", async () => {
  const b = bucket({ json: () => Promise.resolve(file()) });
  const ok = await rosProjections(b, "2026", NOW);
  t.equal(ok.status, 200); t.deepEqual(b.keys, [ROS_KEY]); t.equal(ROS_KEY, "ros/latest.json");
  t.equal((await rosProjections(bucket(null), "2026", NOW)).payload.error, "not_built");
  t.equal((await rosProjections(null, "2026", NOW)).payload.error, "storage_missing");
  t.equal((await rosProjections(bucket({ json: () => Promise.reject(new Error("x")) }), "2026", NOW)).payload.error, "unreadable");
  for (const s of [null, "", "abc", "26"]) t.equal((await rosProjections(bucket(null), s, NOW)).payload.error, "bad_season");
});

test("index.js: GET only, cached only when ok, no D1 in the module, the workflow keeps latest.json last", () => {
  const src = fs.readFileSync(path.join(ROOT, "worker/src/index.js"), "utf8"), mod = fs.readFileSync(path.join(ROOT, "worker/src/ros_projections.js"), "utf8");
  t.ok(/path === "\/api\/ros-projections" && request\.method === "GET"/.test(src));
  t.ok(/ros\.payload\.ok \? "public, max-age=1800" : "no-store"/.test(src), "a refusal is never cached");
  t.ok(!/UPS_MFL_DB|\.prepare\(/.test(mod), "no D1");
  const wf = fs.readFileSync(path.join(ROOT, ".github/workflows/build-ros-projections.yml"), "utf8");
  t.ok(wf.indexOf('ups-mfl-backups/$key') < wf.indexOf("ups-mfl-backups/ros/latest.json"), "dated copy first");
  t.ok(!/pull_request/.test(wf), "never runs from a PR");
  t.ok(/--allow-prod-d1/.test(wf), "the D1 opt-in is explicit");
});

// The Store step, run for real under bash with a fake npx: no wrangler, no network, no R2. Each case says which put fails.
function store(failOn) {
  const wf = fs.readFileSync(path.join(ROOT, ".github/workflows/build-ros-projections.yml"), "utf8");
  const block = wf.slice(wf.indexOf("- name: Store"));
  const script = block.slice(block.indexOf("run: |") + 6).split("\n").map((l) => l.replace(/^ {10}/, "")).join("\n");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ros-store-"));
  fs.mkdirSync(path.join(dir, "worker")); fs.mkdirSync(path.join(dir, "bin"));
  const log = path.join(dir, "puts.log");
  fs.writeFileSync(path.join(dir, "bin", "npx"), `#!/bin/bash\nn=$(( $(wc -l < "${log}" 2>/dev/null || echo 0) + 1 ))\necho "$n $5" >> "${log}"\nif [ "$n" = "${failOn}" ]; then echo "simulated failure" >&2; exit 1; fi\n`, { mode: 0o755 });
  if (failOn !== "nofile") fs.writeFileSync(path.join(dir, "ros.json"), JSON.stringify({ season: 2026, throughWeek: 7, asOf: "2026-10-28T14:00:00Z" }));
  const r = spawnSync("bash", ["-c", script], { cwd: dir, env: { PATH: path.join(dir, "bin") + ":" + process.env.PATH }, encoding: "utf8" });
  return { code: r.status, puts: fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").map((l) => l.split(" ")[1]) : [], out: r.stdout };
}

test("Store: a good run writes the dated copy, then latest.json", () => {
  const r = store(0);
  t.equal(r.code, 0);
  t.deepEqual(r.puts, ["ups-mfl-backups/ros/2026/through-wk07-2026-10-28.json", "ups-mfl-backups/ros/latest.json"]);
});

test("Store: a failed dated write stops the run red and latest.json is never touched", () => {
  const r = store(1);
  t.notEqual(r.code, 0); t.deepEqual(r.puts, ["ups-mfl-backups/ros/2026/through-wk07-2026-10-28.json"]);
});

test("Store: a failed latest.json write leaves the run red; the old latest.json stays in place", () => {
  const r = store(2);
  t.notEqual(r.code, 0); t.equal(r.puts.length, 2); t.equal(r.puts[1], "ups-mfl-backups/ros/latest.json");
});

test("Store: nothing built means nothing stored, and the run stays green", () => {
  const r = store("nofile");
  t.equal(r.code, 0); t.deepEqual(r.puts, []); t.match(r.out, /Nothing built; nothing stored\./);
});

await run("ros_projections_route");
