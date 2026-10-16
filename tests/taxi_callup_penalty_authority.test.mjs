// A taxi call-up's cap-free cut follows the SAME "permanently promoted" rule as the taxi tracker (Keith 2026-10-16).
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

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = fs.readFileSync(path.join(ROOT, "worker/src/index.js"), "utf8");
const cut = (start, end) => {
  const i = SRC.indexOf(start); if (i < 0) throw new Error("not found: " + start);
  const j = SRC.indexOf(end, i); if (j < 0) throw new Error("end not found: " + end);
  return SRC.slice(i, j);
};
const RESOLVER = cut("const _taxiPermanentPromotion =", "// TRADE IS DELIBERATELY NOT AN ACQUISITION HERE.");

// A fake D1 that answers the resolver's one query from rows, and a prior-active set (taxiPriorActivePids).
function load({ rows = [], priorActive = new Set(), d1Throws = false, priorThrows = false, noDb = false }) {
  const calls = { prior: [] };
  const db = {
    prepare(sql) {
      return { bind: (...ids) => ({ all: async () => {
        if (d1Throws) throw new Error("D1 unavailable");
        if (!/FROM ups_taxi_callups/.test(sql)) throw new Error("unexpected query " + sql);
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
  const f = new Function("taxiPriorActivePids", RESOLVER + "\nreturn { _taxiPermanentPromotion, _taxiNeverPromotedMap };");
  return { ...f(taxiPriorActivePids), env, calls };
}
const row = (player_id, n, extra) => Array.from({ length: n }, () => ({ player_id, pending: 0, became_permanent: 0, ...(extra || {}) }));
const CTX = { season: "2026", leagueId: "74598" };

test("the rule: permanent at 4+ call-ups, a row marked permanent, or an active/IR roster at the end of a prior season", () => {
  const { _taxiPermanentPromotion: P } = load({});
  t.equal(P(3, 0, false), false); t.equal(P(4, 0, false), true); t.equal(P(1, 1, false), true); t.equal(P(1, 0, true), true);
  t.equal(P(null, null, undefined), false, "nothing known → not permanent by this rule");
});

test("Kyle Williams: 1 call-up but on the active roster at the end of 2025 → NOT a taxi call-up cut (the normal formula applies)", async () => {
  const L = load({ rows: row("17134", 1), priorActive: new Set(["17134", "17046"]) });
  const m = await L._taxiNeverPromotedMap(L.env, ["17134"], CTX);
  t.equal(m["17134"], undefined, "absent = no exemption");
  t.deepEqual(L.calls.prior, [{ leagueId: "74598", season: "2026" }], "the prior-season rosters of THIS season and league");
});

test("a real taxi call-up (2 of 3, never on an active roster at a season's end) keeps the cap-free cut; 4 call-ups or a marked row do not", async () => {
  const L = load({ rows: [...row("17052", 2), ...row("16639", 4), ...row("17000", 1, { became_permanent: 1 }), ...row("15000", 0)], priorActive: new Set(["17134"]) });
  const m = await L._taxiNeverPromotedMap(L.env, ["17052", "16639", "17000", "15000", "99999"], CTX);
  t.deepEqual(m, { "17052": true });
});

test("pending rows (an un-confirmed promote click) are not call-ups", async () => {
  const L = load({ rows: [{ player_id: "17052", pending: 1, became_permanent: 0 }, { player_id: "17052", pending: 2, became_permanent: 0 }], priorActive: new Set(["1"]) });
  t.deepEqual(await L._taxiNeverPromotedMap(L.env, ["17052"], CTX), {});
});

test("FAILS CLOSED: an unreadable call-up table, prior-season rosters or database → 'unresolved' (held), never a guessed $0 or charge", async () => {
  const a = load({ rows: row("17052", 2), d1Throws: true });
  t.deepEqual(await a._taxiNeverPromotedMap(a.env, ["17052", "16000"], CTX), { "17052": "unresolved", "16000": "unresolved" });
  const b = load({ rows: row("17052", 2), priorActive: new Set() });   // taxiPriorActivePids' way of saying "couldn't read MFL"
  t.deepEqual(await b._taxiNeverPromotedMap(b.env, ["17052", "16000"], CTX), { "17052": "unresolved" }, "only the call-up candidates are held");
  const c = load({ rows: row("17052", 2), priorThrows: true });
  t.deepEqual(await c._taxiNeverPromotedMap(c.env, ["17052"], CTX), { "17052": "unresolved" });
  const d = load({ noDb: true });
  t.deepEqual(await d._taxiNeverPromotedMap(d.env, ["17052"], CTX), { "17052": "unresolved" });
  const e = load({ rows: row("16639", 5) });
  t.deepEqual(await e._taxiNeverPromotedMap(e.env, ["16639"], CTX), {}, "no candidates → the prior-season rosters aren't needed");
  t.equal(e.calls.prior.length, 0);
});

test("every caller uses the shared rule: the preview batch, the drop scan that posts real charges, held re-pricing, the tracker and the workbench", () => {
  t.match(SRC, /await _taxiNeverPromotedMap\(env, pvAllPids, \{ season: pvSeason, leagueId: pvLeague \}\)/);
  t.match(SRC, /taxiNeverPromoted: pvTaxiNeverPromoted\[pid\],/, "true | 'unresolved' passed as is (not === true)");
  t.match(SRC, /await _taxiNeverPromotedMap\(env, drops\.map\(\(d\) => d\.pid\), \{ season: targetSeason, leagueId \}\)/);
  t.match(SRC, /taxiNeverPromoted: scanTaxiNeverPromoted\[String\(drop\.pid\)\],/);
  t.match(SRC, /heldTaxiNeverPromoted\[hs\] = await _taxiNeverPromotedMap\(env, heldRows\.filter/);
  t.match(SRC, /taxiNeverPromoted: \(heldTaxiNeverPromoted\[hSeason\] \|\| \{\}\)\[pid\],/);
  t.equal((SRC.match(/permanent_promotion: _taxiPermanentPromotion\(row\?\.used, row\?\.marked, false\),/g) || []).length, 3, "/api/taxi-callups (2) + /roster-workbench (1)");
  t.equal((SRC.match(/permanent_promotion: Number\(row\?\.permanent/g) || []).length, 0, "no second copy of the rule");
  t.equal((SRC.match(/taxiNeverPromoted\[[^\]]+\] === true/g) || []).length, 0, "no caller collapses 'unresolved' to false");
});

await run("taxi_callup_penalty_authority");
