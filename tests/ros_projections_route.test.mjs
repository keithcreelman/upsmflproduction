// /api/ros-projections (worker/src/ros_projections.js): one R2 read that fails closed. No file, an unreadable file,
// another season or a file older than 8 days never reaches an owner as numbers.
//   node tests/ros_projections_route.test.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { t, test, run } from "./fixtures/mini_test.mjs";
import { rosAnswer, rosProjections, rosCacheControl, ROS_KEY, ROS_MAX_AGE_DAYS, ROS_CACHE_SECONDS } from "../worker/src/ros_projections.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const NOW = Date.parse("2026-10-30T12:00:00Z"), DAY = 86400000;
const iso = (ms) => new Date(ms).toISOString();
const W = (x) => [x, 2, null];
// 28 teams per week, every kickoff far in the future unless a case says otherwise.
const LATER = NOW / 1000 + 30 * 86400;
const week = (kicks = {}) => ({ ...Object.fromEntries(Array.from({ length: 28 }, (_, i) => ["T" + i, LATER])), ...kicks });
const KICKS = { 8: week({ CAR: NOW / 1000 - DAY / 1000, GBP: NOW / 1000 - DAY / 1000 }), 9: week(), 10: week() };
const file = (o = {}) => ({ version: 1, season: 2026, throughWeek: 7, weeks: [8, 10], nWeeks: 3, asOf: iso(NOW - DAY), playedExcluded: { 8: ["CAR", "GBP"] }, kickoffs: KICKS, label: "UPS Center projection", sources: { offense: "x" }, rule: "r", avail: { 2: { k: "none" } },
  players: { 1: { ppg: 12.34, projWeeks: 2, w: W(1), team: "T1" }, 2: { ppg: null, projWeeks: 0, w: [null, null, null], team: "T2" }, 3: { ppg: 0, projWeeks: 1, w: W(0), team: "" } }, ...o });
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
  for (const [f, e] of [[null, "unreadable"], [{}, "unreadable"], [file({ version: 2 }), "unreadable"], [file({ players: null }), "unreadable"], [file({ avail: null }), "unreadable"], [file({ nWeeks: 0 }), "unreadable"], [file({ weeks: null }), "unreadable"], [file({ players: { 1: { ppg: 1, w: [1] } } }), "unreadable"], [file({ players: { 1: { ppg: 1 } } }), "unreadable"], [file({ players: { 1: { ppg: 1, w: [1, 2, 3] } } }), "unreadable"], [file({ kickoffs: undefined }), "unreadable"], [file({ kickoffs: { 8: week(), 9: week() } }), "unreadable"], [file({ kickoffs: { ...KICKS, 9: { A: LATER } } }), "unreadable"], [file({ kickoffs: { ...KICKS, 9: week({ A: "soon" }) } }), "unreadable"], [file({ asOf: "soon" }), "unreadable"], [file({ season: 2025 }), "wrong_season"]]) {
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

// A Wednesday file: Week 8 hasn't started when it's built, and Thursday night (KICK) comes before Sunday's run replaces it.
const KICK = Date.parse("2026-10-29T20:15:00-04:00") / 1000;
const SUNDAY = KICK + 3 * 86400 - 7 * 3600;
const wed = (o = {}) => file({ asOf: iso((KICK - 86400) * 1000), playedExcluded: {},
  kickoffs: { 8: week({ CAR: KICK, GBP: KICK, DAL: SUNDAY, NYG: SUNDAY }), 9: week(), 10: week() },
  players: { 11: { ppg: 12, w: [20, 10, 6], team: "CAR" }, 12: { ppg: 10, w: [10, 10, 10], team: "DAL" }, 13: { ppg: 4, w: [12, null, null], team: "GBP" }, 14: { ppg: 5, w: [null, 5, 10], team: "CAR" }, 15: { ppg: 4, w: [null, 4, 8], team: "FA" } }, ...o });

test("Thursday's game: counted one second before kickoff, gone at the kickoff second, on a Wednesday file", () => {
  const before = rosAnswer(wed(), 2026, (KICK - 1) * 1000).payload;
  t.deepEqual(before.playedExcluded, {}); t.equal(before.players[11], 12); t.deepEqual(before.weekly[11], [20, 10, 6]); t.equal(before.nextKick, KICK);
  const at = rosAnswer(wed(), 2026, KICK * 1000).payload;
  t.deepEqual(at.playedExcluded, { 8: ["CAR", "GBP"] }, "Week 8 now leaves the Front Office's lineups");
  t.deepEqual(at.weekly[11], [null, 10, 6]); t.equal(at.players[11], 8, "(10+6)/2 weeks left");
  t.equal(at.players[12], 10, "his game hasn't been played: untouched"); t.deepEqual(at.weekly[12], [10, 10, 10]);
  t.equal(at.nextKick, SUNDAY);
});

test("a player with nothing left has no number; a listed-out week still leaves his week count", () => {
  const at = rosAnswer(wed(), 2026, KICK * 1000).payload;
  t.equal(at.players[13], undefined, "his only number was Thursday's"); t.equal(at.weekly[13], undefined);
  t.equal(at.players[14], 7.5, "out for Thursday's game: (5+10) over 2 weeks left, not 3");
  t.equal(at.players[15], 4, "no game, no change: a free agent stays as built");
});

test("a Wednesday file read after Thursday's game equals a file built after it", () => {
  const read = rosAnswer(wed(), 2026, KICK * 1000).payload;
  const built = file({ asOf: iso(KICK * 1000), playedExcluded: { 8: ["CAR", "GBP"] }, kickoffs: wed().kickoffs,
    players: { 11: { ppg: 8, w: [null, 10, 6], team: "CAR" }, 12: { ppg: 10, w: [10, 10, 10], team: "DAL" }, 14: { ppg: 7.5, w: [null, 5, 10], team: "CAR" }, 15: { ppg: 4, w: [null, 4, 8], team: "FA" } } });
  const again = rosAnswer(built, 2026, KICK * 1000).payload;
  t.deepEqual(read.players, again.players); t.deepEqual(read.weekly, again.weekly); t.deepEqual(read.playedExcluded, again.playedExcluded); t.equal(read.nextKick, again.nextKick);
});

test("a file left in place after a failed Sunday run: next week's game is suppressed too", () => {
  const f = wed({ kickoffs: { 8: week({ CAR: KICK }), 9: week({ DAL: KICK + 7 * 86400 }), 10: week() } });
  const r = rosAnswer(f, 2026, (KICK + 7 * 86400) * 1000);
  t.equal(r.status, 200); t.deepEqual(r.payload.playedExcluded, { 8: ["CAR"], 9: ["DAL"] });
  t.equal(r.payload.players[12], 10, "Week 9 gone, Week 10 left: his 10 over the two weeks not started");
});

test("games left out at build time keep their teams; a file with no games left has no next kickoff", () => {
  const f = wed({ playedExcluded: { 8: ["CAR", "GBP"] }, players: { 11: { ppg: 8, w: [null, 10, 6], team: "CAR" } } });
  const r = rosAnswer(f, 2026, KICK * 1000).payload;
  t.equal(r.players[11], 8, "already out: not taken out twice"); t.deepEqual(r.playedExcluded[8], ["CAR", "GBP"]);
  const past = { 8: week(), 9: week(), 10: week() };
  for (const k of Object.keys(past)) for (const team of Object.keys(past[k])) past[k][team] = KICK;
  const done = rosAnswer(file({ kickoffs: past, asOf: iso(KICK * 1000), players: { 1: { ppg: 5, w: [1, 2, 3], team: "T1" } } }), 2026, (KICK + 1) * 1000);
  t.equal(done.payload.nextKick, null); t.deepEqual(done.payload.players, {}, "no number survives the last game");
});

test("the cache never outlives the next kickoff, and a refusal is never cached", () => {
  const ms = (KICK - 100) * 1000, a = rosAnswer(wed(), 2026, ms).payload;
  t.equal(rosCacheControl(a, ms), "public, max-age=100");
  t.equal(rosCacheControl(a, (KICK - 1) * 1000), "public, max-age=1");
  t.equal(rosCacheControl({ ok: true, nextKick: KICK }, (KICK - 3600) * 1000), "public, max-age=" + ROS_CACHE_SECONDS);
  t.equal(rosCacheControl({ ok: true, nextKick: null }, KICK * 1000), "public, max-age=" + ROS_CACHE_SECONDS);
  t.equal(rosCacheControl({ ok: false }, KICK * 1000), "no-store");
});

test("index.js: GET only, cached only when ok, no D1 in the module, the workflow keeps latest.json last", () => {
  const src = fs.readFileSync(path.join(ROOT, "worker/src/index.js"), "utf8"), mod = fs.readFileSync(path.join(ROOT, "worker/src/ros_projections.js"), "utf8");
  t.ok(/path === "\/api\/ros-projections" && request\.method === "GET"/.test(src));
  t.ok(/"cache-control": rosCacheControl\(ros\.payload, rosNow\)/.test(src), "the route uses the kickoff-aware cache header");
  t.ok(!/UPS_MFL_DB|\.prepare\(/.test(mod), "no D1");
  const wf = fs.readFileSync(path.join(ROOT, ".github/workflows/build-ros-projections.yml"), "utf8");
  t.ok(wf.indexOf('ups-mfl-backups/$key') < wf.indexOf("ups-mfl-backups/ros/latest.json"), "dated copy first");
  t.ok(!/pull_request/.test(wf), "never runs from a PR");
  t.ok(/--allow-prod-d1/.test(wf), "the D1 opt-in is explicit");
  t.ok(/if: github\.event_name != 'schedule' \|\| vars\.ROS_SCHEDULE_ENABLED == '1'/.test(wf), "merging starts no scheduled writes: the schedule needs the variable");
  t.ok(/promote:[\s\S]*?default: false/.test(wf), "a manual run never touches latest.json unless asked");
});

// The Store step, run for real under bash with a fake npx: no wrangler, no network, no R2. Each case says which put fails.
function store(failOn, event = { EVENT: "schedule" }) {
  const wf = fs.readFileSync(path.join(ROOT, ".github/workflows/build-ros-projections.yml"), "utf8");
  const block = wf.slice(wf.indexOf("- name: Store"));
  const script = block.slice(block.indexOf("run: |") + 6).split("\n").map((l) => l.replace(/^ {10}/, "")).join("\n");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ros-store-"));
  fs.mkdirSync(path.join(dir, "worker")); fs.mkdirSync(path.join(dir, "bin"));
  const log = path.join(dir, "puts.log");
  fs.writeFileSync(path.join(dir, "bin", "npx"), `#!/bin/bash\nn=$(( $(wc -l < "${log}" 2>/dev/null || echo 0) + 1 ))\necho "$n $5" >> "${log}"\nif [ "$n" = "${failOn}" ]; then echo "simulated failure" >&2; exit 1; fi\n`, { mode: 0o755 });
  if (failOn !== "nofile") fs.writeFileSync(path.join(dir, "ros.json"), JSON.stringify({ season: 2026, throughWeek: 7, asOf: "2026-10-28T14:00:00Z" }));
  const r = spawnSync("bash", ["-c", script], { cwd: dir, env: { PATH: path.join(dir, "bin") + ":" + process.env.PATH, ...event }, encoding: "utf8" });
  return { code: r.status, puts: fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").map((l) => l.split(" ")[1]) : [], out: r.stdout };
}

test("Store: a good run writes the dated copy, then latest.json", () => {
  const r = store(0);
  t.equal(r.code, 0);
  t.deepEqual(r.puts, ["ups-mfl-backups/ros/2026/through-wk07-2026-10-28.json", "ups-mfl-backups/ros/latest.json"]);
});

test("Store: a manual run stores the dated copy only; latest.json needs promote", () => {
  for (const event of [{ EVENT: "workflow_dispatch", PROMOTE: "false" }, { EVENT: "workflow_dispatch", PROMOTE: "" }, { EVENT: "workflow_dispatch" }]) {
    const r = store(0, event);
    t.equal(r.code, 0); t.deepEqual(r.puts, ["ups-mfl-backups/ros/2026/through-wk07-2026-10-28.json"]); t.match(r.out, /ros\/latest\.json is unchanged/);
  }
  t.deepEqual(store(0, { EVENT: "workflow_dispatch", PROMOTE: "true" }).puts, ["ups-mfl-backups/ros/2026/through-wk07-2026-10-28.json", "ups-mfl-backups/ros/latest.json"]);
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
