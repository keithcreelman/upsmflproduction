// UPS 2027 beta (PR B): ranks, per-game eligibility and the pool and rank bounds.
//   node tests/mobile2027_ranks.test.mjs
// The recorded Week 10 reads (1,634 scorers) are checked against an independent exact-fraction reference (Python) for every player: the per-game
// status, best and worst rank and pool bounds, the season-points rank and the Week 10 weekly rank. Unrounded comparison, ties shared.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { t, test, run } from "./fixtures/mini_test.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const K = require(path.join(HERE, "..", "apps", "mobile2027", "src", "lib", "ranks.js"));
const FX = JSON.parse(fs.readFileSync(path.join(HERE, "fixtures/mobile2027/ranks_wk10.json"), "utf8"));
const ST = { e: "eligible", b: "below", u: "unsettled" };
const rows = FX.rows.map(([id, group, total, n, S, U, st, pg, sr, h]) => ({ id, group, total, n, S, U, st, pg, sr, h }));
const entries = rows.map((r) => ({ id: r.id, group: r.group, total: r.total, n: r.n, status: K.eligibility(r.n, r.S, r.U, r.h).status }));
const eligOf = (r) => K.eligibility(r.n, r.S, r.U, r.h);
const byName = (nm) => rows.find((r) => r.id === FX.names[nm]);
const E = (n, S, U, h) => K.eligibility(n, S, U, h);

test("exact comparison: figures are compared as integers, never rounded; equal figures share a rank and push nobody down", () => {
  t.equal(K.toCents(8.3375), null, "more precision than MFL records is not a score"); t.equal(K.toCents("12.35"), 1235); t.equal(K.toCents(-0.3), -30); t.equal(K.toCents(""), null); t.equal(K.toCents(true), null); t.equal(K.toCents("abc"), null);
  const mk = (id, total, n) => ({ id, group: "QB", total, n, status: "eligible" });
  const pool = [mk("A", 2500, 3), mk("B", 2501, 3), mk("C", 5000, 6), mk("D", 2400, 3)]; // 8.3333, 8.3367, 8.3333, 8.0000: A, B and C all DISPLAY 8.3
  t.equal(K.perGameRank(pool, "B").best, 1, "8.3367 is ahead of 8.3333 even though both show 8.3");
  t.equal(K.perGameRank(pool, "A").best, 2); t.equal(K.perGameRank(pool, "C").best, 2, "equal figures share a rank (2 and 2, not 2 and 3)"); t.equal(K.perGameRank(pool, "D").best, 4, "the tie pushes the next player to 4 only because two players are strictly ahead of nobody else");
  t.equal(K.cmpPPG(mk("x", 1, 3), mk("y", 2, 6)), 0); t.equal(K.cmpPPG(mk("x", -1, 3), mk("y", -2, 3)), 1, "negative figures compare like any numbers");
});

test("eligibility: exactly half passes (odd and even), one below fails, rounding up, and the threshold flipping across the possible count is unsettled", () => {
  t.equal(E(5, 9, 9).status, "eligible"); t.equal(E(5, 10, 10).status, "eligible"); t.equal(E(4, 9, 9).status, "below"); t.equal(E(4, 10, 10).status, "below");
  t.equal(E(4, 9, 9).why, "Needs 5 of 9 team games"); t.equal(E(4, 10, 10).why, "Needs 5 of 10 team games"); t.equal(E(1, 1, 1).status, "eligible"); t.equal(E(1, 2, 2).status, "eligible"); t.equal(E(1, 3, 3).status, "below");
  t.equal(E(4, 5, 10).status, "unsettled", "eligible if 5 games (needs 3), below if 10 (needs 5)"); t.equal(E(4, 5, 10).why, "Team history incomplete");
  t.equal(E(5, 5, 10).status, "eligible", "enough under the largest possible count, so under every smaller one"); t.equal(E(2, 6, 9).status, "below", "short even under the smallest count (needs 3)");
  t.equal(E(9, 0, 9).status, "eligible", "no supported games but 9 of at most 9 possible"); t.equal(E(4, 0, 9).status, "unsettled");
  t.equal(E(11, 10, 10).status, "unsettled"); t.equal(E(11, 10, 10).why, "Team history conflict", "more scores than games he could have played");
  t.equal(E(0, 9, 9).status, "none"); t.equal(E(0, 9, 9).why, "No scores recorded");
  t.equal(E(5, 9, 9, "unavailable").why, "Team history unavailable"); t.equal(E(5, 9, 9, "conflict").why, "Team history conflict"); t.equal(E(5, 9, 9, "missing").why, "Team history incomplete"); t.equal(E(5, 9, 9, "unavailable").status, "unsettled");
  t.equal(E(5, null, 9).status, "unsettled"); t.equal(E(5, 9, 8).status, "unsettled"); t.equal(E(-1, 9, 9).status, "unsettled");
});

test("reference reproduction: every one of the 1,634 recorded scorers matches an independent exact computation (status, best and worst rank, pool bounds, season rank)", () => {
  let elig = 0, exact = 0, range = 0;
  rows.forEach((r) => {
    const e = eligOf(r); t.equal(e.status, ST[r.st], r.id + " status");
    const pg = K.perGameRank(entries, r.id);
    if (r.st === "e") { elig++; t.ok(pg !== null, r.id); t.deepEqual([pg.best, pg.worst, pg.poolLo, pg.poolHi], r.pg, r.id + " per-game rank"); if (pg.exact) exact++; else range++; } else t.equal(pg, null);
    const sr = K.totalRank(entries.map((x) => ({ id: x.id, group: x.group, value: x.total })), r.id, []); t.deepEqual([sr.best, sr.poolLo], r.sr, r.id + " season rank"); t.ok(sr.exact);
  });
  t.equal(elig, 1237); t.ok(exact > 0 && range > 0);
});

test("weekly ranks: Week 10, every player with a recorded score, within his position group, ties shared, no minimum-game rule", () => {
  const scores = {}; FX.week10.forEach(([id, c]) => { scores[id] = c / 100; });
  const groupOf = (id) => (rows.find((r) => r.id === id) || {}).group || "";
  const w = K.weekFrom(scores, groupOf); t.equal(w.unplaced.length, 0); t.equal(w.entries.length, FX.week10.length);
  FX.week10.forEach(([id, c, rank, pool]) => { const r = K.totalRank(w.entries, id, w.unplaced); t.deepEqual([r.best, r.poolLo], [rank, pool], id + " weekly rank"); });
});

test("named examples reproduced: unrounded, shared ranks for ties, supported pool bounds", () => {
  const rt = (nm) => K.rankText(K.perGameRank(entries, FX.names[nm]));
  t.equal(rt("Allen, Josh"), "QB 3 of 35–56"); t.equal(rt("Shaheed, Rashid"), "WR 63–66 of 169–210"); t.equal(rt("Cousins, Kirk"), "QB 9 of 35–56"); t.equal(rt("Purdy, Brock"), "QB 2 of 35–56");
  const fl = K.perGameRank(entries, FX.names["Flowers, Zay"]), wa = K.perGameRank(entries, FX.names["Washington, Parker"]);
  t.equal(fl.best, 14); t.equal(wa.best, 14, "exactly equal figures (17.0556) share rank 14"); t.ok(fl.exact && wa.exact);
  const ed = K.perGameRank(entries, FX.names["Edwards, T.J."]); t.deepEqual([ed.best, ed.worst, ed.poolLo, ed.poolHi], [71, 71, 158, 186], "an equal unsettled LB widens the pool bounds, not the rank");
  const eq = entries.filter((e) => e.group === "LB" && e.status === "unsettled" && K.cmpPPG(e, entries.find((x) => x.id === FX.names["Edwards, T.J."])) === 0); t.equal(eq.length, 1);
  const wi = K.perGameRank(entries, FX.names["Wicks, Dontayvion"]), ro = K.perGameRank(entries, FX.names["Robinson, Wan'Dale"]); t.deepEqual([wi.best, wi.worst], [55, 57]); t.deepEqual([ro.best, ro.worst], [55, 57], "a tie inside a range: both 55–57");
  t.equal(byName("Hurts, Jalen").n + "/" + byName("Hurts, Jalen").S, "5/9"); t.equal(eligOf(byName("Hurts, Jalen")).status, "eligible");
  t.equal(eligOf(byName("Lock, Drew")).why, "Needs 5 of 10 team games");
  t.equal(eligOf(byName("Monangai, Kyle")).why, "Needs 5 of 9 team games");
  t.equal(eligOf(byName("Trice, Bralen")).status, "unsettled"); t.equal(eligOf(byName("Hunter, Travis")).status, "unsettled", "no usable team history: unsettled whatever his score count");
});

test("season-points ranks at the aligned Week 10 cutoff, and negative totals", () => {
  const se = entries.map((x) => ({ id: x.id, group: x.group, value: x.total })), sr = (nm) => K.rankText(K.totalRank(se, FX.names[nm], []));
  t.equal(sr("Allen, Josh"), "QB 4 of 73"); t.equal(sr("Shaheed, Rashid"), "WR 66 of 240"); t.equal(sr("Cousins, Kirk"), "QB 6 of 73"); t.equal(sr("Smith, DeVonta"), "WR 56 of 240"); t.equal(sr("Tyson, Jordyn"), "WR 127 of 240");
  const mu = byName("Mullens, Nick"), jo = byName("Jones, Mac"), fi = byName("Fields, Justin"); t.ok(mu.total < 0 && jo.total < 0 && fi.total < 0);
  const r = (x) => K.totalRank(se, x.id, []).best; t.ok(r(mu) < r(jo) && r(jo) < r(fi), "−0.3 ranks ahead of −0.5, which ranks ahead of −2.1");
});

test("uncertain competitors: above widens the worst case, level and below do not change the rank, only the pool bounds", () => {
  const mk = (id, total, n, status) => ({ id, group: "WR", total, n, status });
  const base = [mk("me", 1000, 5, "eligible"), mk("up", 1200, 5, "eligible"), mk("lvl", 1000, 5, "unsettled"), mk("low", 900, 5, "unsettled"), mk("above", 1300, 5, "unsettled"), mk("none", 9999, 0, "unsettled")];
  const r = K.perGameRank(base, "me"); t.deepEqual([r.best, r.worst, r.poolLo, r.poolHi], [2, 3, 2, 5]); t.equal(r.exact, false);
  t.equal(K.rankText(r), "WR 2–3 of 2–5"); t.match(K.rankDetail(r), /Best 2, worst 3/); t.match(K.rankDetail(r), /The worst case is a bound, not a result/);
  const e = K.perGameRank([mk("me", 1000, 5, "eligible"), mk("lvl", 1000, 5, "unsettled")], "me"); t.deepEqual([e.best, e.worst, e.poolLo, e.poolHi], [1, 1, 1, 2]); t.equal(K.rankText(e), "WR 1 of 1–2"); t.match(K.rankDetail(e), /1 is exact/);
  t.equal(K.perGameRank(base, "low"), null, "an unsettled player gets no rank"); t.equal(K.perGameRank([mk("x", 1, 1, "below")], "x"), null);
  const solo = K.perGameRank([mk("only", 500, 4, "eligible")], "only"); t.equal(K.rankText(solo), "WR 1 of 1");
});

test("season and weekly ranks are exact only while the pool is covered: an unplaced or invalid competitor who could be ahead widens the rank", () => {
  const g = (id) => ({ a: "QB", b: "QB", c: "QB" }[id] || "");
  const s = K.seasonFrom({ 1: { a: 10, b: 20, c: 5, z: 50 }, 2: { a: 10, b: "oops" } }, 2, g);
  t.equal(s.totals.a.total, 2000); t.equal(s.totals.a.n, 2); t.ok(s.invalid.b, "a non-numeric entry marks the player invalid"); t.equal(s.entries.length, 2, "b (invalid) and z (no group) are not placed");
  t.deepEqual(s.unplaced.map((u) => u.id).sort(), ["b", "z"]);
  const ra = K.totalRank(s.entries, "a", s.unplaced); t.deepEqual([ra.best, ra.worst, ra.poolLo, ra.poolHi], [1, 3, 2, 4]); t.equal(K.rankText(ra), "QB 1–3 of 2–4");
  const rc = K.totalRank(s.entries, "c", s.unplaced); t.equal(rc.best, 2);
  t.equal(K.totalRank(K.seasonFrom({ 1: { a: 10, b: 20 } }, 1, g).entries, "a", []).exact, true);
  t.equal(K.seasonFrom({ 1: { a: 10 }, 2: { a: 99 } }, 1, g).totals.a.total, 1000, "weeks after the cutoff are never added");
});

run("mobile2027_ranks");
