// UPS 2027 beta, stage R2: the two reads Team › Roster adds (/api/player-status and /api/lineup-matchups) and the weekly lineups.
//   node tests/mobile2027_roster_reads.test.mjs
//
// Offline. What is proven: both routes are plain GETs to the worker with exactly the query names listed; a read is asked for once per
// exact address and reused until it is explicit-reloaded or its freshness limit has passed; a failed read is not kept for long and is
// forgotten on Try again or when Sample mode ends; only the fields the screens use are kept; and MFL's expected-return text is dropped
// before anything else can hold it.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { t, test, run } from "./fixtures/mini_test.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, "..", "apps", "mobile2027", "src");
const require = createRequire(import.meta.url);
const D = require(path.join(SRC, "lib/data.js"));
const FX = JSON.parse(fs.readFileSync(path.join(HERE, "fixtures/mobile2027/public_reads.json"), "utf8"));
const FX2 = JSON.parse(fs.readFileSync(path.join(HERE, "fixtures/mobile2027/r2_reads.json"), "utf8"));
const WORKER = "https://upsmflproduction.keith-creelman.workers.dev";
const CFG = { workerBase: WORKER, leagueId: "74598", season: "2026" };

// a loader whose clock and answers the test controls
function setup() {
  const calls = []; const st = { fail: {}, now: 1_800_000_000_000 };
  const realNow = Date.now; Date.now = () => st.now;
  const fake = async (url, opts) => {
    const u = new URL(url); calls.push({ key: u.pathname + "?" + u.searchParams.toString(), opts });
    const key = u.pathname + (u.searchParams.get("W") ? "#" + u.searchParams.get("W") : "");
    if (st.fail[key] > 0) { st.fail[key]--; return { ok: false, status: 503, text: async () => "down" }; }
    let body = {};
    if (u.pathname === "/api/player-status") body = FX2.player_status;
    else if (u.pathname === "/api/lineup-matchups") body = Object.assign({}, FX2.lineup_matchups_w11, { week: Number(u.searchParams.get("W")) }, st.rawMatchups ? { spread: 3, weather: { BUF: "snow" }, defRatings: { x: 1 } } : {});
    else if (u.searchParams.get("TYPE") === "weeklyResults") body = u.searchParams.get("W") === "10" ? FX2.weekly_results_w10 : FX.weekly_results;
    else if (u.searchParams.get("TYPE") === "league") body = FX.league;
    else if (u.pathname === "/roster-workbench") body = FX.roster_workbench;
    else if (u.pathname === "/api/current-lineup-week") body = FX.current_lineup_week;
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  };
  return { L: D.createLoader(CFG, fake), calls, st, done: () => { Date.now = realNow; } };
}

test("the two routes: exact path, exact query names, the worker only; anything else is refused before the network", () => {
  const { L, done } = setup(); done();
  const u = L.urls;
  t.equal(u.status, WORKER + "/api/player-status?season=2026&L=74598");
  t.equal(u.matchups(11), WORKER + "/api/lineup-matchups?YEAR=2026&W=11");
  [u.status, u.matchups(11), u.matchups(3)].forEach((x) => t.ok(D.check(x, WORKER).ok, "allowed: " + x));
  t.equal(D.RULES.length, 6, "six allowed paths in all");
  const bad = [
    [`${WORKER}/api/player-status?season=2026&L=74598&MFL_USER_ID=x`, "a session id"],
    [`${WORKER}/api/player-status?season=2026&L=74598&refresh=1`, "a query name not on the list"],
    [`${WORKER}/api/player-status?season=2026&L=74598&token=x`, "a token"],
    [`${WORKER}/api/lineup-matchups?YEAR=2026&W=11&L=74598`, "L is not a name this route takes"],
    [`${WORKER}/api/lineup-matchups?YEAR=2026&W=11&last=5`, "a query name not on the list"],
    [`${WORKER}/api/lineup-matchups/extra?YEAR=2026&W=11`, "path not exact"],
    [`${WORKER}/api/player-status/x?season=2026&L=74598`, "path not exact"],
    [`http://upsmflproduction.keith-creelman.workers.dev/api/player-status?season=2026&L=74598`, "not https"],
    [`https://example.com/api/lineup-matchups?YEAR=2026&W=11`, "other host"],
    [`${WORKER}/api/player-weekly-box?season=2026&mfl_id=1`, "a neighboring route that was not approved"],
    [`${WORKER}/api/fantasy-sos?season=2026`, "a neighboring route that was not approved"],
  ];
  bad.forEach(([x, why]) => t.equal(D.check(x, WORKER).ok, false, "refused (" + why + "): " + x));
});

test("every added read is a bare GET, credentials omitted, no body or headers, and is asked for once per exact address", async () => {
  const { L, calls, done } = setup();
  try {
    const a = await L.loadStatus(), b = await L.loadStatus(), c = await L.loadStatus();
    t.equal(a.state, "ok"); t.ok(a === b && b === c, "the same answer, not three reads");
    await L.loadMatchups(11); await L.loadMatchups(11); await L.loadMatchups(10); await L.loadMatchups(10);
    await L.loadWeekly(10); await L.loadWeekly(10);
    t.deepEqual(calls.map((x) => x.key), ["/api/player-status?season=2026&L=74598", "/api/lineup-matchups?YEAR=2026&W=11", "/api/lineup-matchups?YEAR=2026&W=10", "/api/mfl-export?TYPE=weeklyResults&L=74598&YEAR=2026&JSON=1&W=10"]);
    calls.forEach((x) => { t.equal(x.opts.method, "GET"); t.equal(x.opts.credentials, "omit"); t.equal(x.opts.headers, undefined); t.equal(x.opts.body, undefined); });
    t.deepEqual(L.summary(), { requests: 4, ok: 4, failed: 0, refused: 0, nonGet: 0 });
    // two asks at the same moment share one request
    const { L: L2, calls: c2 } = setup(); await Promise.all([L2.loadMatchups(7), L2.loadMatchups(7), L2.loadMatchups(7)]); t.equal(c2.length, 1, "three simultaneous asks, one request");
  } finally { done(); }
});

test("a read is asked again only after its freshness limit or an explicit reload; the core load starts from nothing", async () => {
  const { L, calls, st, done } = setup();
  try {
    await L.loadStatus(); await L.loadMatchups(11); await L.loadWeekly(10);
    st.now += 4 * 60 * 1000; await L.loadStatus(); await L.loadMatchups(11); t.equal(calls.length, 3, "4 minutes later nothing is asked again");
    st.now += 40 * 1000; await L.loadStatus(); t.equal(calls.length, 4, "past 4.5 minutes the injury read is asked again (the resolver stops trusting it at 5)");
    await L.loadMatchups(11); t.equal(calls.length, 4, "(the games read has a 5 minute limit)");
    st.now += 60 * 1000; await L.loadMatchups(11); t.equal(calls.length, 5, "and past 5 minutes the games read is asked again");
    await L.loadWeekly(10); t.equal(calls.length, 5, "a finished week's results are kept for an hour");
    st.now += 61 * 60 * 1000; await L.loadWeekly(10); t.equal(calls.length, 6);
    await L.loadStatus(true); t.equal(calls.length, 7, "force asks again");
    const n = calls.length; await L.loadCore(); t.ok(calls.length > n + 3, "the core load reads everything again");
    const m = calls.length; await L.loadStatus(); t.equal(calls.length, m + 1, "and it dropped what was kept, so the injury read is asked again");
  } finally { done(); }
});

test("a failed read is shown as failed, is not retried for a minute, and is forgotten on Try again or when Sample mode ends", async () => {
  const { L, calls, st, done } = setup();
  try {
    st.fail["/api/player-status"] = 1; st.fail["/api/lineup-matchups#11"] = 1;
    const a = await L.loadStatus(); t.equal(a.state, "error"); t.match(a.error, /HTTP 503/);
    const m = await L.loadMatchups(11); t.equal(m.state, "error");
    await L.loadStatus(); await L.loadMatchups(11); t.equal(calls.length, 2, "asked again inside the minute: served from memory");
    st.now += 61 * 1000; const b = await L.loadStatus(); t.equal(b.state, "ok"); t.equal(calls.length, 3, "after a minute it is asked again and recovers");
    // Try again / Sample mode ends: clearErrors drops failed and in-flight entries so nothing stale is served
    st.fail["/api/lineup-matchups#9"] = 1; await L.loadMatchups(9); const n = calls.length;
    L.clearErrors(); const r = await L.loadMatchups(9); t.equal(r.state, "ok"); t.equal(calls.length, n + 1);
    await L.loadStatus(); t.equal(calls.length, n + 1, "clearErrors left the good read alone");
    // a read whose shape is wrong is an error, not an empty answer
    const bad = D.createLoader(CFG, async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ ok: true, nothing: 1 }) }));
    t.equal((await bad.loadStatus()).state, "error"); t.equal((await bad.loadMatchups(11)).state, "error"); t.equal((await bad.loadWeekly(10)).state, "error");
  } finally { done(); }
});

test("only what the screens use is kept: games and per-game averages from the matchup read; expected-return text from no read", async () => {
  const { L, st, done } = setup();
  try {
    st.rawMatchups = true;
    const mu = await L.loadMatchups(11); t.equal(mu.state, "ok");
    t.deepEqual(Object.keys(mu.data).sort(), ["asOf", "avg", "games", "week"], "no spreads, weather or defense ratings are kept");
    const g = Object.values(mu.data.games)[0]; t.deepEqual(Object.keys(g).sort(), ["isHome", "kickoff", "opp", "status"]);
    t.ok(Object.keys(mu.data.games).length >= 20 && Object.values(mu.data.avg).every((a) => typeof a.avg === "number" && !Number.isNaN(a.avg)));
    const ss = await L.loadStatus(); t.equal(ss.state, "ok");
    t.doesNotMatch(JSON.stringify(ss.data), /exp_return|return_date/);
    t.match(JSON.stringify(FX2.player_status), /exp_return/, "(control: the recording does carry it)");
    const sample = Object.entries(FX2.player_status.players).find(([, v]) => v.mfl || v.roster);
    const kept = ss.data.players[sample[0]]; const src = sample[1].mfl || sample[1].roster, key = sample[1].mfl ? "mfl" : "roster";
    Object.keys(src).filter((k) => k !== "exp_return" && k !== "return_date").forEach((k) => t.equal(JSON.stringify(kept[key][k]), JSON.stringify(src[k]), "kept unchanged: " + k));
    t.deepEqual(Object.keys(ss.data).sort(), Object.keys(FX2.player_status).sort(), "every feed field is still there");
    // the source recording is not modified by the stripping
    t.match(JSON.stringify(FX2.player_status.players[sample[0]]), /exp_return/);
  } finally { done(); }
});

await run("mobile2027_roster_reads");
