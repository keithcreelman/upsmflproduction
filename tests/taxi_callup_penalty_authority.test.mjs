// The cap-free cut follows TAXI ELIGIBILITY as of the cut (Keith 2026-10-21, canon T5.2 / §D2), decided by the ONE
// taxi rule (worker/src/taxi_rule.js) from _taxiCutContextMap's inputs: the UPS Rookie Draft window, call-ups recorded
// from 2026 (the tracked rule), and the 2025 legacy rule (on an active roster or IR in any 2025 week — Keith
// 2026-09-17 / 2026-10-21). The same "permanently promoted" rule as the taxi tracker.
//   node tests/taxi_callup_penalty_authority.test.mjs
//
// Kyle Williams (0007, UPS pick 2.08 in 2025, on the active roster at the end of 2025) read "no penalty" in the phone's
// conditional-drop list. /api/taxi-callups already called him permanently promoted, but the penalty counted call-up rows
// alone (one 2025 row → "1 of 3") and priced his cut as a taxi cap-free cut; the rulebook says $11,250 − $6,471 = $4,779.
// Every function below is the REAL one from worker/src/index.js, cut out by its text (never re-typed): the resolver,
// and taxiLegacy2025Pids (the 2025 record from MFL's weekly rosters).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { t, test, run } from "./fixtures/mini_test.mjs";
import { taxiEligibility, taxiPermanent, taxiCutVerdict, TAXI_LEGACY_SEASON, TAXI_TRACKED_FROM_SEASON } from "../worker/src/taxi_rule.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = fs.readFileSync(path.join(ROOT, "worker/src/index.js"), "utf8");
const cut = (start, end) => {
  const i = SRC.indexOf(start); if (i < 0) throw new Error("not found: " + start);
  const j = SRC.indexOf(end, i); if (j < 0) throw new Error("end not found: " + end);
  return SRC.slice(i, j);
};
const RESOLVER = cut("const _taxiPermanentPromotion =", "// TRADE IS DELIBERATELY NOT AN ACQUISITION HERE.");
const LEGACY_HELPERS = cut("const _taxiLegacyFor =", "// ── Taxi call-up WEEKS, counted from MFL");
const LEGACY_READER = cut("const TAXI_LEGACY_2025_CACHE_KEY =", "// The 2025 legacy answer for one player");

// A fake D1 that answers the resolver's queries from rows (only rows recorded from 2026 count, as the SQL says), a
// 2025 legacy set (taxiLegacy2025Pids: a Set, or null = MFL's 2025 rosters unreadable), and — for the week under way —
// a fake NFL schedule and MFL players export.
// UPS Rookie Draft picks (MFL draftResults) by season: pid → round.
const DRAFTS = { 2026: {}, 2025: { "17134": 2, "17046": 3, "17052": 2, "17000": 4, "16000": 3, "17075": 2 }, 2024: { "16639": 3 }, 2023: { "15000": 3 } };
function load({ rows = [], legacy = new Set(), d1Throws = false, legacyThrows = false, noDb = false,
                weekKickoff = {}, teamKickoffs = {}, teams = {}, scheduleDown = false, playersDown = false, draftDown = false }) {
  WEEK_OF.clear();
  const calls = { legacy: [], players: 0 };
  const db = {
    prepare(sql) {
      return { bind: (...args) => ({ all: async () => {
        if (d1Throws) throw new Error("D1 unavailable");
        if (!/FROM ups_taxi_callups/.test(sql)) throw new Error("unexpected query " + sql);
        if (/nfl_week = \?/.test(sql)) {   // the week-under-way check: confirmed rows for this season-week
          const [season, week, ...ids] = args;
          return { results: rows.filter((r) => r.pending === 0 && String(r.season) === String(season) && Number(r.nfl_week) === Number(week) && ids.includes(r.player_id)).map((r) => ({ player_id: r.player_id })) };
        }
        const ids = args;
        const weeks = /COUNT\(DISTINCT CASE WHEN pending = 0 AND CAST\(season AS INTEGER\) >= 2026 AND nfl_week IS NOT NULL THEN season \|\| '-' \|\| nfl_week END\) AS used/.test(sql);
        if (!weeks) throw new Error("the call-up count must count DISTINCT qualifying weeks recorded from 2026: " + sql);
        const by = {};
        for (const r of rows) {
          if (!ids.includes(r.player_id)) continue;
          const b = by[r.player_id] || (by[r.player_id] = { player_id: r.player_id, wk: new Set(), marked: 0 });
          if (r.pending === 0 && Number(r.season) >= 2026 && r.nfl_week != null) { b.wk.add(r.season + "-" + r.nfl_week); b.marked = Math.max(b.marked, r.became_permanent || 0); }
        }
        return { results: Object.values(by).map((b) => ({ player_id: b.player_id, used: b.wk.size, marked: b.marked })) };
      } }) };
    },
  };
  const env = noDb ? {} : { UPS_MFL_DB: db };
  const taxiLegacy2025Pids = async (e, leagueId) => {
    calls.legacy.push({ leagueId });
    if (legacyThrows) throw new Error("MFL down");
    return legacy;
  };
  const nflWeekFirstKickoffUnix = async (season, w) => (scheduleDown ? 0 : (weekKickoff[w] || 0));
  const nflWeekKickoffsByTeam = async (season, w) => (scheduleDown ? {} : (teamKickoffs[w] || {}));
  const fetch = async (url) => {
    const u = new URL(url);
    if (u.searchParams.get("TYPE") === "draftResults") {
      if (draftDown) return new Response("down", { status: 503 });
      const season = u.pathname.split("/")[1];
      const picks = Object.entries(DRAFTS[season] || {}).map(([player, round]) => ({ player, round: String(round) }));
      return new Response(JSON.stringify({ draftResults: { draftUnit: { draftPick: picks } } }), { status: 200 });
    }
    calls.players += 1;
    if (playersDown) return new Response("down", { status: 503 });
    const ids = new URL(url).searchParams.get("PLAYERS").split(",");
    return new Response(JSON.stringify({ players: { player: ids.filter((id) => id in teams).map((id) => ({ id, team: teams[id] })) } }), { status: 200 });
  };
  const f = new Function("taxiLegacy2025Pids", "nflWeekFirstKickoffUnix", "nflWeekKickoffsByTeam", "fetch", "taxiPermanent",
    "TAXI_LEGACY_SEASON", "TAXI_TRACKED_FROM_SEASON",
    LEGACY_HELPERS + RESOLVER + "\nreturn { _taxiPermanentPromotion, _taxiCutContextMap, _taxiLegacyFor };");
  const api = f(taxiLegacy2025Pids, nflWeekFirstKickoffUnix, nflWeekKickoffsByTeam, fetch, taxiPermanent, TAXI_LEGACY_SEASON, TAXI_TRACKED_FROM_SEASON);
  // The cut's verdict, as _computeDropPenaltyRaw asks it for a player still on his Rookie-Draft contract.
  const verdicts = async (ids, ctx) => {
    const m = await api._taxiCutContextMap(env, ids, ctx);
    return Object.fromEntries(ids.map((id) => [id, taxiCutVerdict(m[id], "Rookie-Draft", !!(ctx && ctx.isTaxi))]));
  };
  return { ...api, env, calls, verdicts };
}
// Each row is one recorded scoring week; a player's weeks are numbered 1, 2, 3… across the calls building one load().
const WEEK_OF = new Map();
const row = (player_id, n, extra) => Array.from({ length: n }, () => {
  const w = (WEEK_OF.get(player_id) || 0) + 1; WEEK_OF.set(player_id, w);
  return { player_id, pending: 0, became_permanent: 0, season: "2026", nfl_week: w, ...(extra || {}) };
});
const CTX = { season: "2026", leagueId: "74598" };

test("the rule: permanent at 4+ tracked call-ups, a row marked permanent, or the 2025 legacy rule — never for ending a season active", () => {
  const { _taxiPermanentPromotion: P } = load({});
  t.equal(P(3, 0, false), false); t.equal(P(4, 0, false), true); t.equal(P(1, 1, false), true); t.equal(P(1, 0, true), true);
  t.equal(P(null, null, undefined), false, "nothing known → not permanent by this rule");
  t.ok(!/taxiPriorActivePids|ended a prior season/.test(SRC.replace(/this replaces taxiPriorActivePids,/, "")), "the continuing 'ended a prior season active or on IR' rule is gone");
});

test("Kyle Williams: active in 2025 (one 2025 call-up row) → the 2025 legacy promotion, no cap-free cut", async () => {
  const L = load({ rows: row("17134", 1, { season: "2025" }), legacy: new Set(["17134", "17046"]) });
  const m = await L._taxiCutContextMap(L.env, ["17134"], CTX);
  t.deepEqual([m["17134"].legacy2025, m["17134"].permanent, m["17134"].used], [true, false, 0], "legacy, not a tracked call-up count");
  t.deepEqual(await L.verdicts(["17134"], CTX), { "17134": false });
  t.deepEqual(L.calls.legacy[0], { leagueId: "74598" }, "the 2025 record of THIS league");
  const r = taxiEligibility({ ...m["17134"], contractStatus: "Rookie-Draft" });
  t.equal(r.text, "Not eligible · active during 2025 (legacy promotion)");
});

test("eligible immediately before the cut → cap-free WHEREVER he sits: 2 of 3 call-ups, or none at all; 4 call-ups, a marked row, a pre-window pick or no pick are not", async () => {
  const L = load({ rows: [...row("17052", 2), ...row("16639", 4), ...row("17000", 1, { became_permanent: 1 })], legacy: new Set(["17134"]) });
  t.deepEqual(await L.verdicts(["17052", "16000", "16639", "17000", "15000", "99999"], CTX),
    { "17052": true, "16000": true, "16639": false, "17000": false, "15000": false, "99999": false });
  const m = await L._taxiCutContextMap(L.env, ["16000"], CTX);
  t.deepEqual([m["16000"].used, m["16000"].upsRound, m["16000"].upsYear], [0, 3, 2025], "16000: never called up, a 2025 Round 3 pick — eligible on the active roster too");
});

test("cap-free cuts while still eligible: from TAXI, the ACTIVE roster, IR, and during a TEMPORARY call-up", async () => {
  const L = load({ rows: [...row("17052", 2)], legacy: new Set(["17134"]) });
  const m = await L._taxiCutContextMap(L.env, ["17052", "16000"], CTX);
  t.equal(taxiCutVerdict(m["16000"], "Rookie-Draft", true), true, "from the taxi squad");
  t.equal(taxiCutVerdict(m["16000"], "Rookie-Draft", false), true, "from the active roster (no call-up used)");
  t.equal(taxiCutVerdict(m["17052"], "Rookie-Draft", false), true, "during a temporary call-up (2 used)");
  t.equal(taxiEligibility({ ...m["17052"], contractStatus: "Rookie-Draft", isIr: true }).eligible, true, "from IR: still eligible, so cap-free");
  t.equal(taxiCutVerdict(m["17052"], "Rookie-Draft", false /* IR is not the taxi squad */), true, "from IR");
});

test("2024–2025 backfill rows are not tracked call-ups: only call-ups recorded from 2026 count", async () => {
  const L = load({ rows: [...row("16639", 4, { season: "2024" }), ...row("17052", 1, { season: "2025" }), ...row("17052", 1)], legacy: new Set(["1"]) });
  const m = await L._taxiCutContextMap(L.env, ["16639", "17052"], CTX);
  t.deepEqual([m["16639"].used, m["16639"].permanent], [0, false], "four 2024 rows: no tracked call-up");
  t.equal(m["17052"].used, 1, "one 2025 row + one 2026 row: one tracked call-up");
});

test("ending 2026 on the active roster after one or two call-ups → still eligible the next season", async () => {
  for (const n of [1, 2]) {
    const L = load({ rows: row("17052", n), legacy: new Set(["17134"]) });
    const m = await L._taxiCutContextMap(L.env, ["17052"], { ...CTX, season: "2027" });
    const r = taxiEligibility({ ...m["17052"], contractStatus: "Rookie-Draft", isTaxi: false });
    t.equal(r.eligible, true, n + " call-up(s), on the active roster at the end of 2026 → eligible in 2027");
    t.equal(r.can_demote, true, "and he may be returned to taxi");
    t.equal(r.callups_left, 3 - n);
    t.deepEqual(await L.verdicts(["17052"], { ...CTX, season: "2027" }), { "17052": true }, "a 2027 cut is cap-free");
  }
});

test("a trade keeps the COMPLETE call-up count: rows are read by player across franchises", async () => {
  const L = load({ rows: [...row("17052", 1, { franchise_id: "0003" }), ...row("17052", 2, { franchise_id: "0007" })], legacy: new Set(["1"]) });
  const m = await L._taxiCutContextMap(L.env, ["17052"], CTX);
  t.equal(m["17052"].used, 3, "1 with the first team + 2 with the second");
  const r = taxiEligibility({ ...m["17052"], contractStatus: "Rookie-Draft" });
  t.deepEqual([r.eligible, r.can_demote, r.callups_left, r.next_callup_permanent], [true, true, 0, true], "demotion after the third is allowed; the next promotion is permanent");
  const L4 = load({ rows: [...row("17052", 2, { franchise_id: "0003" }), ...row("17052", 2, { franchise_id: "0007" })], legacy: new Set(["1"]) });
  t.deepEqual(await L4.verdicts(["17052"], CTX), { "17052": false }, "a 4th with the new team: permanent");
  t.ok(!/franchise_id = \?/.test(RESOLVER.slice(RESOLVER.indexOf("const _taxiCutContextMap"))), "the count is never scoped to one franchise");
});

test("several rows for ONE scoring week use one call-up; a row with no recorded week is no call-up", async () => {
  const L = load({ rows: [...row("17052", 1, { nfl_week: 5 }), ...row("17052", 1, { nfl_week: 5, franchise_id: "0003" }), ...row("17052", 1, { nfl_week: null })], legacy: new Set(["1"]) });
  const m = await L._taxiCutContextMap(L.env, ["17052"], CTX);
  t.equal(m["17052"].used, 1);
});

test("pending rows (an un-confirmed promote click) are not call-ups", async () => {
  const L = load({ rows: [{ player_id: "17052", pending: 1, became_permanent: 0, season: "2026" }, { player_id: "17052", pending: 2, became_permanent: 0, season: "2026" }], legacy: new Set(["1"]) });
  const m = await L._taxiCutContextMap(L.env, ["17052"], CTX);
  t.equal(m["17052"].used, 0); t.deepEqual(await L.verdicts(["17052"], CTX), { "17052": true });
});

test("FAILS CLOSED: an unreadable call-up table, 2025 record, database or UPS draft → unknown (held), never a guessed $0 or charge", async () => {
  const a = load({ rows: row("17052", 2), d1Throws: true });
  t.deepEqual(await a.verdicts(["17052", "16000"], CTX), { "17052": null, "16000": null });
  const b = load({ rows: row("17052", 2), legacy: null });   // taxiLegacy2025Pids: MFL's 2025 rosters unreadable
  t.deepEqual(await b.verdicts(["17052", "16000", "16639", "99999"], CTX), { "17052": null, "16000": null, "16639": null, "99999": false }, "only 2023–2025 window picks depend on it");
  const c = load({ rows: row("17052", 2), legacyThrows: true });
  t.deepEqual(await c.verdicts(["17052"], CTX), { "17052": null });
  const d = load({ noDb: true });
  t.deepEqual(await d.verdicts(["17052"], CTX), { "17052": null });
  const g = load({ rows: row("17052", 2), legacy: new Set(["1"]), draftDown: true });
  t.deepEqual(await g.verdicts(["17052"], { ...CTX, season: "2031" }), { "17052": null }, "a UPS draft in the window unreadable → unknown");
  const e = load({ rows: row("16639", 5) });
  t.deepEqual(await e.verdicts(["16639"], CTX), { "16639": false });
  const h = load({ rows: [], legacy: null });
  DRAFTS[2026]["18000"] = 2;
  t.deepEqual(await h.verdicts(["18000"], CTX), { "18000": true }, "a 2026 pick wasn't in the league in 2025: the 2025 record can't decide him");
  t.equal(h.calls.legacy.length, 0, "…so it isn't even read");
  delete DRAFTS[2026]["18000"];
});

test("every caller scopes the 2025 answer the same way: only 2023–2025 picks, only from 2026; unreadable → unknown for them alone", () => {
  const { _taxiLegacyFor: F } = load({});
  const S = new Set(["17001"]);
  t.equal(F(S, "17001", 2026, 2025), true); t.equal(F(S, "17002", 2026, 2025), false);
  t.equal(F(null, "17002", 2026, 2025), null, "a 2025 pick, record unreadable: unknown");
  t.equal(F(null, "18000", 2026, 2026), false, "a 2026 pick: the 2025 record can't decide him");
  t.equal(F(null, "15000", 2026, 2022), false, "a 2022 pick: outside it too");
  t.equal(F(null, "17002", 2025, 2025), false, "before 2026 the legacy rule isn't applied");
  t.equal(F(null, "17002", 2026, null), null, "draft year unknown: unknown");
});

// ── taxiLegacy2025Pids: the REAL reader, against fake MFL exports ──
function legacyReader({ weeks, drafts, down = {}, cached = null }) {
  const fetched = [], writes = [];
  const fetch = async (url) => {
    const u = new URL(url); fetched.push(u.searchParams.get("TYPE") + (u.searchParams.get("W") ? ":" + u.searchParams.get("W") : ":" + u.pathname.split("/")[1]));
    const type = u.searchParams.get("TYPE");
    if (type === "draftResults") {
      const y = u.pathname.split("/")[1];
      if (down["draft" + y]) return new Response("down", { status: 503 });
      return new Response(JSON.stringify({ draftResults: { draftUnit: { draftPick: Object.entries(drafts[y] || {}).map(([player, round]) => ({ player, round: String(round) })) } } }));
    }
    const w = Number(u.searchParams.get("W"));
    if (down["w" + w] || u.pathname.split("/")[1] !== "2025") return new Response("down", { status: 503 });
    const fr = {};
    for (const [pid, byWeek] of Object.entries(weeks)) {
      const st = byWeek[w] || byWeek.all; if (!st) continue;
      (fr["0001"] = fr["0001"] || []).push({ id: pid, status: st });
    }
    return new Response(JSON.stringify({ rosters: { franchise: Object.entries(fr).map(([id, player]) => ({ id, player })) } }));
  };
  const db = { prepare: (sql) => ({ bind: (...a) => ({
    first: async () => (/SELECT value FROM ups_settings/.test(sql) ? (cached ? { value: JSON.stringify(cached) } : null) : null),
    run: async () => { writes.push(a); return {}; } }) }) };
  const f = new Function("fetch", "TAXI_LEGACY_SEASON", LEGACY_READER + "\nreturn taxiLegacy2025Pids;");
  return { read: () => f(fetch, TAXI_LEGACY_SEASON)({ UPS_MFL_DB: db }, "74598"), fetched, writes };
}
const LEGACY_DRAFTS = { 2023: { "15001": 4 }, 2024: { "16001": 2, "16002": 3 }, 2025: { "17001": 2, "17002": 5, "17003": 1, "17004": 3 } };

test("active during 2025 but finished 2025 back on taxi → in the legacy set: permanently ineligible", async () => {
  const weeks = {
    "17001": { all: "TAXI_SQUAD", 5: "ROSTER" },              // one active week (5), then back on taxi through Week 17
    "17002": { all: "TAXI_SQUAD", 9: "INJURED_RESERVE" },     // IR counts
    "17004": { all: "TAXI_SQUAD" },                           // taxi all season
    "16001": { all: "ROSTER" },                               // active all season
    "17003": { all: "ROSTER" },                               // Round 1: never a taxi player
    "15001": { all: "TAXI_SQUAD", 17: "ROSTER" },             // 2023 pick, active Week 17
    "19999": { all: "ROSTER" },                               // a veteran
  };
  const R = legacyReader({ weeks, drafts: LEGACY_DRAFTS });
  const set = await R.read();
  t.deepEqual([...set].sort(), ["15001", "16001", "17001", "17002"]);
  t.equal(weeks["17001"][17], undefined, "17001 ended 2025 on taxi — still in");
  const r = taxiEligibility({ upsRound: 2, upsYear: 2025, season: 2026, contractStatus: "Rookie-Draft", isTaxi: true, used: 0, permanent: false, legacy2025: set.has("17001") });
  t.deepEqual([r.eligible, r.reason, r.text], [false, "legacy_2025", "Not eligible · active during 2025 (legacy promotion)"]);
  t.equal(taxiCutVerdict({ season: 2026, upsRound: 2, upsYear: 2025, draftKnown: true, used: 0, pending: 0, permanent: false, legacy2025: true }, "Rookie-Draft", true), false, "no cap-free cut, even from taxi");
  t.equal(R.fetched.filter((x) => /^rosters:/.test(x)).length, 17, "every UPS week of 2025 (1–17) is read");
  t.equal(R.writes.length, 1, "the frozen answer is stored once");
});

test("the 2025 reader FAILS CLOSED and reads its stored answer first", async () => {
  t.equal(await legacyReader({ weeks: { "17001": { all: "ROSTER" } }, drafts: LEGACY_DRAFTS, down: { w12: true } }).read(), null, "one unreadable week → null, not a partial set");
  t.equal(await legacyReader({ weeks: { "17001": { all: "ROSTER" } }, drafts: LEGACY_DRAFTS, down: { draft2024: true } }).read(), null, "an unreadable draft → null");
  const cached = legacyReader({ weeks: {}, drafts: LEGACY_DRAFTS, cached: ["17001"] });
  t.deepEqual([...(await cached.read())], ["17001"]); t.equal(cached.fetched.length, 0, "stored answer: no MFL reads");
  const emptyCache = legacyReader({ weeks: { "17001": { all: "ROSTER" } }, drafts: LEGACY_DRAFTS, cached: [] });
  t.deepEqual([...(await emptyCache.read())], ["17001"], "an empty stored answer is never trusted");
  const none = legacyReader({ weeks: { "17004": { all: "TAXI_SQUAD" } }, drafts: LEGACY_DRAFTS });
  t.equal(await none.read(), null, "nobody found means the exports said nothing usable: unknown");
  t.equal(none.writes.length, 0, "and nothing is stored");
});

test("every caller uses the shared rule, each at its own instant: the preview batch, the drop scan that posts real charges, held re-pricing, the recompute, the waiver-run card", () => {
  t.match(SRC, /await _taxiCutContextMap\(env, pvAllPids, \{ season: pvSeason, leagueId: pvLeague, atUnix: pvDropTs \}\)/);
  t.match(SRC, /taxiCut: pvTaxiCut\[pid\],/);
  t.match(SRC, /await _taxiCutContextMap\(env, \[pid\], \{ season: targetSeason, leagueId, atUnix: ts \}\)/);
  t.match(SRC, /taxiCut: await scanTaxiAt\(drop\.pid, drop\.ts\),/);
  t.match(SRC, /taxiCut: \(await _taxiCutContextMap\(env, \[pid\], \{ season: hSeason, leagueId, atUnix: dropUnix \}\)\)\[pid\],/);
  t.match(SRC, /taxiCut: \(await _taxiCutContextMap\(env, \[safeStr\(r\.player_id\)\], \{ season: rs, leagueId, atUnix: Number\(r\.dropped_at_unix\) \|\| 0 \}\)\)\[safeStr\(r\.player_id\)\],/);
  t.match(SRC, /_taxiCutContextMap\(env, \[\.\.\.apDropPids\], \{ season: apSeason, leagueId: apLeagueId, atUnix: ts \}\)/, "the waiver-run card");
  t.ok(!/_taxiNeverPromotedMap|taxiNeverPromoted/.test(SRC), "the slot-based exemption is gone");
  const price = SRC.slice(SRC.indexOf("const _computeDropPenaltyRaw ="), SRC.indexOf("// 1.4 UNSTAMPED CONTRACT"));
  t.ok(/const eligible = taxiCutVerdict\(taxiCut, contractStatus, isTaxi\);/.test(price) && /if \(eligible === true\)/.test(price), "the pricing asks the ONE taxi rule");
  t.ok(!/if \(isTaxi\) \{\s*return/.test(price), "no exemption for the taxi slot alone");
});


// ── The week under way (Keith 2026-10-16: "a call-up week counts from lineup lock" — his own game's kickoff) ──
// 2026 schedule: Week 6 opens Thu Oct 15 8:15 PM ET (KCC), BUF plays Sun Oct 18 1:00 PM ET, NYG Mon Oct 19 8:15 PM ET.
const UTC = (iso) => Math.floor(Date.parse(iso) / 1000);
const SCHED = { weekKickoff: {}, teamKickoffs: {} };
for (let w = 1; w <= 18; w += 1) {
  const thu = w === 1 ? UTC("2026-09-10T00:20:00Z") : UTC("2026-09-18T00:15:00Z") + 7 * 86400 * (w - 2);
  SCHED.weekKickoff[w] = thu;
  SCHED.teamKickoffs[w] = { KCC: thu, BUF: UTC("2026-09-13T17:00:00Z") + 7 * 86400 * (w - 1), NYG: UTC("2026-09-15T00:15:00Z") + 7 * 86400 * (w - 1) };
}
const SUN_BEFORE = UTC("2026-10-18T16:00:00Z"), SUN_AFTER = UTC("2026-10-18T18:00:00Z");   // around BUF's 1 PM ET Week 6 kickoff
const third = (extra) => load({ rows: [...row("17075", 3, { season: "2026" }), ...row("17052", 2, { season: "2026" })], legacy: new Set(["1"]),
  ...SCHED, teams: { "17075": "BUF", "17052": "BUF" }, ...(extra || {}) });

test("3 used + his own game has kicked off in the week under way → the 4th activation: permanent, the normal formula", async () => {
  const L = third();
  t.deepEqual(await L.verdicts(["17075", "17052"], { ...CTX, atUnix: SUN_AFTER }), { "17075": false, "17052": true }, "17052 (2 used) is still a call-up");
});
test("the same cut BEFORE his game kicks off (other Week 6 games already played) → still a call-up, cap-free", async () => {
  const L = third();
  t.deepEqual(await L.verdicts(["17075"], { ...CTX, atUnix: SUN_BEFORE }), { "17075": true });
});
test("this season-week already one of his confirmed rows → not counted twice", async () => {
  const L = load({ rows: [...row("17075", 2, { season: "2026" }), { player_id: "17075", pending: 0, became_permanent: 0, season: "2026", nfl_week: 6 }],
    legacy: new Set(["1"]), ...SCHED, teams: { "17075": "BUF" } });
  t.deepEqual(await L.verdicts(["17075"], { ...CTX, atUnix: SUN_AFTER }), { "17075": true }, "3 used INCLUDING Week 6: the 4th is next week");
});
test("FAILS CLOSED: schedule or his NFL team unreadable → held ('unresolved'); a 1–2-used player's answer doesn't depend on it, so it stands", async () => {
  const a = third({ scheduleDown: true });
  t.deepEqual(await a.verdicts(["17075", "17052"], { ...CTX, atUnix: SUN_AFTER }), { "17075": null, "17052": true });
  const b = third({ playersDown: true });
  t.deepEqual(await b.verdicts(["17075"], { ...CTX, atUnix: SUN_AFTER }), { "17075": null });
  const c = third({ teams: {} });
  t.deepEqual(await c.verdicts(["17075"], { ...CTX, atUnix: SUN_AFTER }), { "17075": null }, "not in MFL's answer: unknown, not 'no game'");
});
test("no game this week (bye, NFL free agent) → never a call-up week (Keith 2026-10-16); no pricing instant → the confirmed rows alone; MFL's players read only for a 3rd call-up", async () => {
  const bye = third({ teams: { "17075": "SEA" } });
  t.deepEqual(await bye.verdicts(["17075"], { ...CTX, atUnix: SUN_AFTER }), { "17075": true });
  const fa = third({ teams: { "17075": "FA" } });
  t.deepEqual(await fa.verdicts(["17075"], { ...CTX, atUnix: SUN_AFTER }), { "17075": true });
  const noAt = third();
  t.deepEqual(await noAt.verdicts(["17075"], CTX), { "17075": true });
  t.equal(noAt.calls.players, 0);
  const two = load({ rows: row("17052", 2, { season: "2026" }), legacy: new Set(["1"]), ...SCHED, teams: { "17052": "BUF" } });
  await two.verdicts(["17052"], { ...CTX, atUnix: SUN_AFTER });
  t.equal(two.calls.players, 0, "2 used: nothing to look up");
});

await run("taxi_callup_penalty_authority");
