// The cap-free cut follows TAXI ELIGIBILITY as of the cut (Keith 2026-10-21, canon T5.2 / §D2), decided by the ONE
// taxi rule (worker/src/taxi_rule.js) from _taxiCutContextMap's inputs: the UPS Rookie Draft window, call-ups and the
// SAME "permanently promoted" rule as the taxi tracker (Keith 2026-10-16).
//   node tests/taxi_callup_penalty_authority.test.mjs
//
// Kyle Williams (0007, UPS pick 2.08 in 2025, on the active roster at the end of 2025) read "no penalty" in the phone's
// conditional-drop list. /api/taxi-callups already called him permanently promoted, but the penalty counted call-up rows
// alone (one 2025 row → "1 of 3") and priced his cut as a taxi cap-free cut; the rulebook says $11,250 − $6,471 = $4,779.
// Every function below is the REAL one from worker/src/index.js, cut out by its text (never re-typed).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { t, test, run } from "./fixtures/mini_test.mjs";
import { taxiEligibility, taxiPermanent, taxiCutVerdict } from "../worker/src/taxi_rule.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = fs.readFileSync(path.join(ROOT, "worker/src/index.js"), "utf8");
const cut = (start, end) => {
  const i = SRC.indexOf(start); if (i < 0) throw new Error("not found: " + start);
  const j = SRC.indexOf(end, i); if (j < 0) throw new Error("end not found: " + end);
  return SRC.slice(i, j);
};
const RESOLVER = cut("const _taxiPermanentPromotion =", "// TRADE IS DELIBERATELY NOT AN ACQUISITION HERE.");

// A fake D1 that answers the resolver's queries from rows, a prior-active set (taxiPriorActivePids), and — for the
// week under way — a fake NFL schedule and MFL players export.
// UPS Rookie Draft picks (MFL draftResults) by season: pid → round.
const DRAFTS = { 2026: {}, 2025: { "17134": 2, "17046": 3, "17052": 2, "17000": 4, "16000": 3, "17075": 2 }, 2024: { "16639": 3 }, 2023: { "15000": 3 } };
function load({ rows = [], priorActive = new Set(), d1Throws = false, priorThrows = false, noDb = false,
                weekKickoff = {}, teamKickoffs = {}, teams = {}, scheduleDown = false, playersDown = false, draftDown = false }) {
  const calls = { prior: [], players: 0 };
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
        const by = {};
        for (const r of rows) {
          if (!ids.includes(r.player_id)) continue;
          const b = by[r.player_id] || (by[r.player_id] = { player_id: r.player_id, used: 0, marked: 0 });
          if (r.pending === 0) { b.used++; b.marked = Math.max(b.marked, r.became_permanent || 0); }
        }
        return { results: Object.values(by) };
      } }) };
    },
  };
  const env = noDb ? {} : { UPS_MFL_DB: db };
  const taxiPriorActivePids = async (e, origin, leagueId, season) => {
    calls.prior.push({ leagueId, season });
    if (priorThrows) throw new Error("MFL down");
    return priorActive;
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
  const f = new Function("taxiPriorActivePids", "nflWeekFirstKickoffUnix", "nflWeekKickoffsByTeam", "fetch", "taxiPermanent",
    RESOLVER + "\nreturn { _taxiPermanentPromotion, _taxiCutContextMap };");
  const api = f(taxiPriorActivePids, nflWeekFirstKickoffUnix, nflWeekKickoffsByTeam, fetch, taxiPermanent);
  // The cut's verdict, as _computeDropPenaltyRaw asks it for a player still on his Rookie-Draft contract.
  const verdicts = async (ids, ctx) => {
    const m = await api._taxiCutContextMap(env, ids, ctx);
    return Object.fromEntries(ids.map((id) => [id, taxiCutVerdict(m[id], "Rookie-Draft", !!(ctx && ctx.isTaxi))]));
  };
  return { ...api, env, calls, verdicts };
}
const row = (player_id, n, extra) => Array.from({ length: n }, () => ({ player_id, pending: 0, became_permanent: 0, ...(extra || {}) }));
const CTX = { season: "2026", leagueId: "74598" };

test("the rule: permanent at 4+ call-ups, a row marked permanent, or an active/IR roster at the end of a prior season", () => {
  const { _taxiPermanentPromotion: P } = load({});
  t.equal(P(3, 0, false), false); t.equal(P(4, 0, false), true); t.equal(P(1, 1, false), true); t.equal(P(1, 0, true), true);
  t.equal(P(null, null, undefined), false, "nothing known → not permanent by this rule");
});

test("Kyle Williams: 1 call-up but on the active roster at the end of 2025 → permanently promoted, no cap-free cut", async () => {
  const L = load({ rows: row("17134", 1), priorActive: new Set(["17134", "17046"]) });
  const m = await L._taxiCutContextMap(L.env, ["17134"], CTX);
  t.equal(m["17134"].permanent, true); t.deepEqual(await L.verdicts(["17134"], CTX), { "17134": false });
  t.deepEqual(L.calls.prior.slice(0, 1), [{ leagueId: "74598", season: "2026" }], "the prior-season rosters of THIS season and league");
});

test("eligible immediately before the cut → cap-free WHEREVER he sits: 2 of 3 call-ups, or none at all; 4 call-ups, a marked row, a pre-window pick or no pick are not", async () => {
  const L = load({ rows: [...row("17052", 2), ...row("16639", 4), ...row("17000", 1, { became_permanent: 1 })], priorActive: new Set(["17134"]) });
  t.deepEqual(await L.verdicts(["17052", "16000", "16639", "17000", "15000", "99999"], CTX),
    { "17052": true, "16000": true, "16639": false, "17000": false, "15000": false, "99999": false });
  const m = await L._taxiCutContextMap(L.env, ["16000"], CTX);
  t.deepEqual([m["16000"].used, m["16000"].upsRound, m["16000"].upsYear], [0, 3, 2025], "16000: never called up, a 2025 Round 3 pick — eligible on the active roster too");
});

test("pending rows (an un-confirmed promote click) are not call-ups", async () => {
  const L = load({ rows: [{ player_id: "17052", pending: 1, became_permanent: 0 }, { player_id: "17052", pending: 2, became_permanent: 0 }], priorActive: new Set(["1"]) });
  const m = await L._taxiCutContextMap(L.env, ["17052"], CTX);
  t.equal(m["17052"].used, 0); t.deepEqual(await L.verdicts(["17052"], CTX), { "17052": true });
});

test("FAILS CLOSED: an unreadable call-up table, prior-season rosters, database or UPS draft → unknown (held), never a guessed $0 or charge", async () => {
  const a = load({ rows: row("17052", 2), d1Throws: true });
  t.deepEqual(await a.verdicts(["17052", "16000"], CTX), { "17052": null, "16000": null });
  const b = load({ rows: row("17052", 2), priorActive: new Set() });   // taxiPriorActivePids' way of saying "couldn't read MFL"
  t.deepEqual(await b.verdicts(["17052", "16000", "99999"], CTX), { "17052": null, "16000": null, "99999": false }, "only window picks depend on it");
  const c = load({ rows: row("17052", 2), priorThrows: true });
  t.deepEqual(await c.verdicts(["17052"], CTX), { "17052": null });
  const d = load({ noDb: true });
  t.deepEqual(await d.verdicts(["17052"], CTX), { "17052": null });
  const g = load({ rows: row("17052", 2), priorActive: new Set(["1"]), draftDown: true });
  t.deepEqual(await g.verdicts(["17052"], { ...CTX, season: "2031" }), { "17052": null }, "a UPS draft in the window unreadable → unknown");
  const e = load({ rows: row("16639", 5) });
  t.deepEqual(await e.verdicts(["16639"], CTX), { "16639": false });
  t.equal(e.calls.prior.length, 0, "no candidates → the prior-season rosters aren't needed");
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
const third = (extra) => load({ rows: [...row("17075", 3, { season: "2026" }), ...row("17052", 2, { season: "2026" })], priorActive: new Set(["1"]),
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
    priorActive: new Set(["1"]), ...SCHED, teams: { "17075": "BUF" } });
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
  const two = load({ rows: row("17052", 2, { season: "2026" }), priorActive: new Set(["1"]), ...SCHED, teams: { "17052": "BUF" } });
  await two.verdicts(["17052"], { ...CTX, atUnix: SUN_AFTER });
  t.equal(two.calls.players, 0, "2 used: nothing to look up");
});

await run("taxi_callup_penalty_authority");
