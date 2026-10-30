// /api/ros-projections (worker/src/ros_projections.js): one R2 read that fails closed. No file, an unreadable file,
// another season or a file older than 8 days never reaches an owner as numbers. Weekly lines stay in R2.
//   node tests/ros_projections_route.test.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { t, test, run } from "./fixtures/mini_test.mjs";
import { rosAnswer, rosProjections, ROS_KEY, ROS_MAX_AGE_DAYS } from "../worker/src/ros_projections.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const NOW = Date.parse("2026-10-30T12:00:00Z"), DAY = 86400000;
const iso = (ms) => new Date(ms).toISOString();
const file = (o = {}) => ({ version: 1, season: 2026, throughWeek: 7, weeks: [8, 17], nWeeks: 10, asOf: iso(NOW - DAY), label: "UPS Center projection", sources: { offense: "x" }, rule: "r",
  players: { 1: { ppg: 12.34, projWeeks: 9, w: [1, 2] }, 2: { ppg: null, projWeeks: 0, w: [null] }, 3: { ppg: 0, projWeeks: 1, w: [0] } }, ...o });
const bucket = (obj) => ({ keys: [], get(k) { this.keys.push(k); return Promise.resolve(obj); } });

test("a fresh file: each player's number only, nulls left out, a real 0 kept, no weekly lines", () => {
  const r = rosAnswer(file(), 2026, NOW);
  t.equal(r.status, 200); t.equal(r.payload.ok, true);
  t.deepEqual(r.payload.players, { 1: 12.34, 3: 0 });
  t.deepEqual(r.payload.weeks, [8, 17]); t.equal(r.payload.nWeeks, 10); t.equal(r.payload.throughWeek, 7); t.equal(r.payload.label, "UPS Center projection");
  t.ok(!JSON.stringify(r.payload).includes('"w"'), "weekly lines stay in R2");
});

test("the stale limit: 8 days serves, 8 days and a second refuses", () => {
  t.equal(rosAnswer(file({ asOf: iso(NOW - ROS_MAX_AGE_DAYS * DAY) }), 2026, NOW).status, 200);
  const r = rosAnswer(file({ asOf: iso(NOW - ROS_MAX_AGE_DAYS * DAY - 1000) }), 2026, NOW);
  t.equal(r.status, 503); t.equal(r.payload.error, "stale"); t.equal(r.payload.players, undefined);
});

test("every bad file fails closed with no numbers", () => {
  for (const [f, e] of [[null, "unreadable"], [{}, "unreadable"], [file({ version: 2 }), "unreadable"], [file({ players: null }), "unreadable"], [file({ asOf: "soon" }), "unreadable"], [file({ season: 2025 }), "wrong_season"]]) {
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

await run("ros_projections_route");
