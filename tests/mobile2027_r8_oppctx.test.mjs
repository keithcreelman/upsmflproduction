// UPS 2027 beta: opponent matchup context (apps/mobile2027/src/lib/oppctx.js), R8 revision 10.
//   node tests/mobile2027_r8_oppctx.test.mjs
// Offline and pure. Sections:
//   1  the metric on small hand-made seasons: rank direction (1 = fewest), ties, byes, completed games only
//   2  the pregame cutoff: the matchup week and every later week never move the figure
//   3  attribution: a traded player's points follow his game-day club; an unknown week club is "—", never today's club
//   4  IDP: points allowed by an OFFENSE to DL/LB/DB, a separate metric from any defensive rank
//   5  the recording (2026, Weeks 1-10): no game-day club for the full pool, so every rank is "—" (no fabricated rank)
//   6  registration and purity
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const APP = path.join(HERE, "..", "apps", "mobile2027");
const SRC = path.join(APP, "src", "lib", "oppctx.js");
const O = require(SRC);

let n = 0;
function t(name, fn) { fn(); n++; }

// A tiny league: clubs AAA BBB CCC DDD; each week two games.
function season(over) {
  const base = {
    schedule: {
      1: [{ a: "AAA", b: "BBB", final: true }, { a: "CCC", b: "DDD", final: true }],
      2: [{ a: "AAA", b: "CCC", final: true }, { a: "BBB", b: "DDD", final: true }],
      3: [{ a: "AAA", b: "DDD", final: true }, { a: "BBB", b: "CCC", final: true }],
      4: [{ a: "AAA", b: "BBB", final: false }, { a: "CCC", b: "DDD", final: false }],
    },
    positions: { qa: "QB", qb: "QB", qc: "QB", qd: "QB", da: "DE", db: "DT", dc: "DE", dd: "DE", ka: "PK" },
    clubOf: {},
    scores: {},
    poolComplete: { 1: true, 2: true, 3: true, 4: true },
  };
  // QB of each club on his own club all season.
  for (const [id, club] of [["qa", "AAA"], ["qb", "BBB"], ["qc", "CCC"], ["qd", "DDD"], ["da", "AAA"], ["db", "BBB"], ["dc", "CCC"], ["dd", "DDD"], ["ka", "AAA"]])
    base.clubOf[id] = { 1: club, 2: club, 3: club, 4: club };
  return Object.assign(base, over || {});
}
// Week w: QB points by club, DL points by club.
function scoresOf(qb, dl) {
  const rows = [];
  for (const k in qb) rows.push({ id: "q" + k.toLowerCase()[0], score: String(qb[k]) });
  for (const k in (dl || {})) rows.push({ id: "d" + k.toLowerCase()[0], score: String(dl[k]) });
  return rows;
}
function std() {
  return season({ scores: {
    1: scoresOf({ AAA: 20, BBB: 10, CCC: 30, DDD: 15 }, { AAA: 8, BBB: 4, CCC: 6, DDD: 2 }),
    2: scoresOf({ AAA: 12, BBB: 25, CCC: 18, DDD: 22 }, { AAA: 3, BBB: 9, CCC: 5, DDD: 7 }),
    3: scoresOf({ AAA: 40, BBB: 40, CCC: 40, DDD: 40 }, { AAA: 1, BBB: 1, CCC: 1, DDD: 1 }),
  } });
}
// QB points allowed, weeks 1-2: BBB faced qa 20 + qd 22 = 42 → 21.0; AAA faced qb 10 + qc 18 = 28 → 14.0;
// CCC faced qd 15 (W1 vs DDD) + qa 12 (W2 vs AAA) = 27 → 13.5; DDD faced qc 30 + qb 25 = 55 → 27.5.

// ── 1 the metric ──
t("rank 1 = fewest points allowed; text, ppg, games, sample", () => {
  const I = O.build(std());
  const c = O.rankFor(I, { pos: "QB", oppClub: "CCC", week: 3 });
  assert.equal(c.state, "ok");
  assert.equal(c.text, "Opp vs QB: 1st");
  assert.equal(c.ppg, 13.5); assert.equal(c.games, 2); assert.equal(c.pts, 27);
  assert.equal(c.ofTeams, 4); assert.equal(c.throughWeek, 2); assert.deepEqual(c.weeksUsed, [1, 2]);
  assert.equal(O.rankFor(I, { pos: "QB", oppClub: "AAA", week: 3 }).text, "Opp vs QB: 2nd");
  assert.equal(O.rankFor(I, { pos: "QB", oppClub: "BBB", week: 3 }).text, "Opp vs QB: 3rd");
  const d = O.rankFor(I, { pos: "QB", oppClub: "DDD", week: 3 });
  assert.equal(d.text, "Opp vs QB: 4th"); assert.equal(d.ppg, 27.5);
  assert.match(c.definition, /Weeks 1–2 \(before this game\)/);
  assert.match(c.definition, /Rank 1 = the defense that allowed the fewest/);
  assert.ok(c.details.some((x) => /Week 3 and later are not included/.test(x)));
  assert.ok(c.details.some((x) => /13\.5 points per game/.test(x)));
});
t("ties share a rank: 1 + clubs strictly fewer; the next rank skips", () => {
  const s = season({ scores: { 1: scoresOf({ AAA: 10, BBB: 10, CCC: 5, DDD: 20 }) } });
  const I = O.build(s);
  // allowed: BBB 10 (qa), AAA 10 (qb), DDD 5 (qc), CCC 20 (qd)
  assert.equal(O.rankFor(I, { pos: "QB", oppClub: "DDD", week: 2 }).rank, 1);
  const a = O.rankFor(I, { pos: "QB", oppClub: "AAA", week: 2 }), b = O.rankFor(I, { pos: "QB", oppClub: "BBB", week: 2 });
  assert.equal(a.rank, 2); assert.equal(b.rank, 2); assert.ok(a.tied);
  assert.equal(O.rankFor(I, { pos: "QB", oppClub: "CCC", week: 2 }).rank, 4);
  assert.match(a.details[1], /\(tied\)/);
});
t("bye weeks are not games; a non-final game is never counted", () => {
  const s = std();
  s.schedule[2] = [{ a: "AAA", b: "CCC", final: true }, { a: "BBB", b: "DDD", final: false }];   // BBB-DDD not completed
  const I = O.build(s);
  const b = O.rankFor(I, { pos: "QB", oppClub: "BBB", week: 3 });
  assert.equal(b.games, 1); assert.equal(b.ppg, 20);   // only qa's 20 in Week 1
  const s2 = std();
  s2.schedule[2] = [{ a: "AAA", b: "CCC", final: true }];   // BBB and DDD on bye in Week 2
  delete s2.clubOf.qb[2]; delete s2.clubOf.qd[2];
  s2.scores[2] = s2.scores[2].filter((r) => r.id !== "qb" && r.id !== "qd" && r.id !== "db" && r.id !== "dd");
  const I2 = O.build(s2);
  const d = O.rankFor(I2, { pos: "QB", oppClub: "DDD", week: 3 });
  assert.equal(d.games, 1); assert.equal(d.ppg, 30);
});
t("a completed game with a complete pool and no scorer at the position = 0 allowed (a real zero, not a gap)", () => {
  const s = std();
  s.scores[1] = s.scores[1].filter((r) => r.id !== "qa");   // AAA's QB scored nothing in Week 1 (no row)
  const I = O.build(s);
  const b = O.rankFor(I, { pos: "QB", oppClub: "BBB", week: 2 });
  assert.equal(b.ppg, 0); assert.equal(b.rank, 1);
});
t("no figure without evidence: Week 1, opponent with no game, bye, bad position, incomplete pool", () => {
  const I = O.build(std());
  assert.deepEqual([O.rankFor(I, { pos: "QB", oppClub: "AAA", week: 1 }).why, O.rankFor(I, { pos: "QB", oppClub: "AAA", week: 1 }).text], ["no_prior_games", "—"]);
  assert.equal(O.rankFor(I, { pos: "QB", oppClub: "ZZZ", week: 3 }).why, "opp_no_games");
  assert.equal(O.rankFor(I, { pos: "QB", oppClub: "", week: 3 }).why, "bye");
  assert.equal(O.rankFor(I, { pos: "OL", oppClub: "AAA", week: 3 }).why, "bad_position");
  assert.equal(O.rankFor(I, { pos: "QB", oppClub: "AAA", week: 0 }).why, "no_week");
  const s = std(); s.poolComplete[2] = false;
  const r = O.rankFor(O.build(s), { pos: "QB", oppClub: "AAA", week: 3 });
  assert.equal(r.why, "pool_incomplete"); assert.equal(r.text, "—"); assert.equal(r.rank, undefined);
  // ...but a later incomplete week never blocks an earlier matchup
  assert.equal(O.rankFor(O.build(s), { pos: "QB", oppClub: "AAA", week: 2 }).state, "ok");
});
t("labels: K for PK, P for PN; position grouping matches the Pts Agst engine", () => {
  const s = std(); s.scores[1].push({ id: "ka", score: "9" });
  const k = O.rankFor(O.build(s), { pos: "PK", oppClub: "BBB", week: 2 });
  assert.equal(k.text, "Opp vs K: 4th"); assert.equal(k.ppg, 9);
  const want = { QB: "QB", RB: "RB", FB: "RB", WR: "WR", TE: "TE", PK: "PK", K: "PK", PN: "PN", DE: "DL", DT: "DL", NT: "DL", LB: "LB", OLB: "LB", CB: "DB", S: "DB", FS: "DB", SS: "DB", OL: "" };
  for (const p in want) assert.equal(O.group(p), want[p], p);
  const eng = fs.readFileSync(path.join(HERE, "..", "worker", "src", "fpa_engine.js"), "utf8");
  assert.ok(/export const FPA_GROUPS = \["QB", "RB", "WR", "TE", "DL", "LB", "DB", "PK", "PN"\]/.test(eng), "engine groups unchanged");
  assert.equal(O.ordinal(11), "11th"); assert.equal(O.ordinal(22), "22nd"); assert.equal(O.ordinal(23), "23rd"); assert.equal(O.ordinal(31), "31st");
});

// ── 2 the pregame cutoff ──
t("the matchup week and later weeks never enter the sample (mutation proof)", () => {
  const base = O.rankFor(O.build(std()), { pos: "QB", oppClub: "BBB", week: 3 });
  const s = std();
  s.scores[3] = scoresOf({ AAA: 99, BBB: 0, CCC: 0, DDD: 0 });   // the matchup week itself
  s.scores[4] = scoresOf({ AAA: 77, BBB: 77, CCC: 77, DDD: 77 });
  s.schedule[4] = s.schedule[4].map((g) => Object.assign({}, g, { final: true }));
  s.schedule[5] = [{ a: "AAA", b: "BBB", final: true }];
  s.scores[5] = scoresOf({ AAA: 500 });
  for (const id in s.clubOf) s.clubOf[id][5] = s.clubOf[id][4];
  s.poolComplete[5] = true;
  const after = O.rankFor(O.build(s), { pos: "QB", oppClub: "BBB", week: 3 });
  assert.deepEqual(after, base);
  // a later week with missing clubs or an incomplete pool cannot block it either
  const s2 = std(); s2.scores[3].push({ id: "nobody", score: "5" }); s2.positions.nobody = "QB"; s2.poolComplete[4] = false;
  assert.deepEqual(O.rankFor(O.build(s2), { pos: "QB", oppClub: "BBB", week: 3 }), base);
  // while a change BEFORE the matchup does move it
  const s3 = std(); s3.scores[2] = scoresOf({ AAA: 12, BBB: 25, CCC: 18, DDD: 2 });
  assert.notDeepEqual(O.rankFor(O.build(s3), { pos: "QB", oppClub: "BBB", week: 3 }).ppg, base.ppg);
});
t("each week's rank uses only that week's past (walk forward)", () => {
  const I = O.build(std());
  const w2 = O.rankFor(I, { pos: "QB", oppClub: "BBB", week: 2 }), w4 = O.rankFor(I, { pos: "QB", oppClub: "BBB", week: 4 });
  assert.equal(w2.throughWeek, 1); assert.equal(w2.ppg, 20); assert.equal(w2.games, 1);
  assert.equal(w4.throughWeek, 3); assert.equal(w4.games, 3); assert.equal(w4.ppg, 27.3);   // (20 + 22 + 40) / 3
});

// ── 3 attribution ──
t("a traded player's points go to the club his game-day club faced THAT week", () => {
  const s = std();
  // qx: on AAA in Week 1 (faced BBB), traded to DDD for Week 2 (faced BBB again via BBB-DDD), today on CCC.
  s.positions.qx = "QB"; s.clubOf.qx = { 1: "AAA", 2: "DDD" };
  s.scores[1].push({ id: "qx", score: "6" }); s.scores[2].push({ id: "qx", score: "4" });
  const I = O.build(s);
  const b = O.rankFor(I, { pos: "QB", oppClub: "BBB", week: 3 });
  assert.equal(b.pts, 52);   // 42 + 6 + 4
  const c = O.rankFor(I, { pos: "QB", oppClub: "CCC", week: 3 });
  assert.equal(c.pts, 27);   // CCC (his current club's opponents) gets nothing of his
  // the module never reads a current club: a positions/players "team" field changes nothing
  const s2 = std(); s2.positions.qx = "QB"; s2.clubOf.qx = { 1: "AAA", 2: "DDD" };
  s2.scores[1].push({ id: "qx", score: "6" }); s2.scores[2].push({ id: "qx", score: "4" });
  s2.players = [{ id: "qx", team: "CCC", position: "QB" }];
  assert.deepEqual(O.rankFor(O.build(s2), { pos: "QB", oppClub: "BBB", week: 3 }), b);
});
t("an unknown week club, or a club with no game that week, makes the rank '—' (never today's club)", () => {
  const s = std(); s.positions.qz = "QB"; s.clubOf.qz = { 1: "AAA" };   // Week 2 club unknown
  s.scores[2].push({ id: "qz", score: "11" });
  const r = O.rankFor(O.build(s), { pos: "QB", oppClub: "AAA", week: 3 });
  assert.equal(r.state, "none"); assert.equal(r.why, "club_unknown"); assert.match(r.detail, /Week 2: 1 QB score without a known game-day club/);
  // it blocks only the group it belongs to
  assert.equal(O.rankFor(O.build(s), { pos: "DL", oppClub: "AAA", week: 3 }).state, "ok");
  const s2 = std(); s2.positions.qy = "QB"; s2.clubOf.qy = { 2: "ZZZ" };   // club with no game
  s2.scores[2].push({ id: "qy", score: "3" });
  assert.equal(O.rankFor(O.build(s2), { pos: "QB", oppClub: "AAA", week: 3 }).why, "club_unknown");
});
t("pre-attributed cells (a Worker route) give the same answer as raw scores", () => {
  const raw = O.build(std());
  const cells = {}, sched = std().schedule;
  for (const w of [1, 2, 3]) {
    cells[w] = {};
    for (const d in raw.weeks[w].cells) cells[w][d] = raw.weeks[w].cells[d];
  }
  const viaCells = O.build({ schedule: sched, cells, unverified: {}, poolComplete: std().poolComplete });
  for (const club of ["AAA", "BBB", "CCC", "DDD"]) for (const pos of ["QB", "DL"])
    assert.deepEqual(O.rankFor(viaCells, { pos, oppClub: club, week: 3 }), O.rankFor(raw, { pos, oppClub: club, week: 3 }));
  const flagged = O.build({ schedule: sched, cells, unverified: { 1: { QB: 2 } }, poolComplete: std().poolComplete });
  assert.equal(O.rankFor(flagged, { pos: "QB", oppClub: "AAA", week: 3 }).why, "club_unknown");
});

// ── 4 IDP ──
t("IDP: DL points are credited to the OFFENSE faced; its own metric and wording", () => {
  const I = O.build(std());
  // DL allowed, weeks 1-2: BBB's offense faced da 8 (W1) + dd 7 (W2) = 15 → 7.5; AAA faced db 4 + dc 5 = 9 → 4.5;
  // CCC faced dd 2 + da 3 = 5 → 2.5; DDD faced dc 6 + db 9 = 15 → 7.5.
  const c = O.rankFor(I, { pos: "DE", oppClub: "CCC", week: 3 });
  assert.equal(c.text, "Opp vs DL: 1st"); assert.equal(c.ppg, 2.5); assert.equal(c.idp, true);
  assert.match(c.definition, /opposing defensive linemen against CCC's offense/);
  assert.match(c.definition, /not a defensive rank/);
  assert.match(c.details[0], /CCC's offense allowed 2\.5 points per game to DL/);
  const b = O.rankFor(I, { pos: "DT", oppClub: "BBB", week: 3 }), d = O.rankFor(I, { pos: "DL", oppClub: "DDD", week: 3 });
  assert.equal(b.rank, 3); assert.equal(d.rank, 3); assert.ok(b.tied);
  // the DL rank is not the QB (defensive) rank of the same club
  assert.notEqual(O.rankFor(I, { pos: "QB", oppClub: "CCC", week: 3 }).definition, c.definition);
  const q = O.rankFor(I, { pos: "QB", oppClub: "BBB", week: 3 });
  assert.equal(q.idp, false); assert.match(q.definition, /BBB's defense/);
});

// ── 5 the recording ──
function recorded() {
  const g = {};
  new Function("window", "self", "globalThis", fs.readFileSync(path.join(APP, "src", "recorded_data.js"), "utf8"))(g, g, g);
  return g.UPS2027_RECORDED.routes;
}
t("recording 2026 Wk 1-10: the scorer pool has no game-day club, so no rank is fabricated", () => {
  const R = recorded();
  const body = (k) => { let v = R[k]; if (v && v.body !== undefined) v = v.body; return typeof v === "string" ? JSON.parse(v) : v; };
  const players = body("/api/mfl-export?JSON=1&L=74598&TYPE=players&YEAR=2026").players.player;
  const positions = {}; for (const p of players) positions[p.id] = p.position;
  const full = body("/api/mfl-export?JSON=1&L=74598&TYPE=nflSchedule&W=ALL&YEAR=2026").fullNflSchedule.nflSchedule;
  const schedule = {}, scores = {}, poolComplete = {};
  for (const wk of full) {
    const w = Number(wk.week); if (!(w >= 1 && w <= 10)) continue;
    schedule[w] = [].concat(wk.matchup || []).map((m) => ({ a: m.team[0].id, b: m.team[1].id, final: String(m.gameSecondsRemaining) === "0" }));
    scores[w] = body("/api/mfl-export?JSON=1&L=74598&TYPE=playerScores&W=" + w + "&YEAR=2026").playerScores.playerScore;
    poolComplete[w] = true;   // granted here on purpose: even then, attribution is what is missing
  }
  // The only week-by-week club evidence in the recording: the box-score routes (a subset of players).
  const clubOf = {}; let boxPlayers = 0;
  for (const k of Object.keys(R)) {
    if (k.indexOf("/api/player-weekly-box?") !== 0) continue;
    const b = body(k); if (!b || !b.weeks) continue;
    boxPlayers++;
    for (const x of b.weeks) { const club = (x.box && x.box.team) || (x.snaps && x.snaps.team); if (club) (clubOf[b.mfl_id] = clubOf[b.mfl_id] || {})[x.week] = club; }
  }
  const scorers = new Set(); for (const w in scores) for (const s of scores[w]) scorers.add(s.id);
  assert.ok(scorers.size > 1500, "full MFL pool recorded: " + scorers.size);
  assert.ok(boxPlayers < scorers.size / 5, "box evidence covers a small subset: " + boxPlayers);
  const I = O.build({ schedule, scores, positions, clubOf, poolComplete });
  for (const pos of ["QB", "RB", "WR", "TE", "PK", "DL", "LB", "DB"]) {
    const r = O.rankFor(I, { pos, oppClub: "BUF", week: 11 });
    assert.equal(r.state, "none", pos); assert.equal(r.why, "club_unknown", pos); assert.equal(r.text, "—");
  }
  // Week 1 is "no prior games" whatever the data
  assert.equal(O.rankFor(I, { pos: "QB", oppClub: "BUF", week: 1 }).why, "no_prior_games");
  // every recorded Week 1-10 game is final, and byes are absent (13-16 games a week)
  for (const w in schedule) { assert.ok(schedule[w].every((g) => g.final), "week " + w); assert.ok(schedule[w].length >= 13 && schedule[w].length <= 16); }
});

// ── 6 registration and purity ──
t("registered in the build allowlist and loaded before breakdown.js", () => {
  const build = fs.readFileSync(path.join(APP, "scripts", "build.mjs"), "utf8");
  assert.ok(build.indexOf('"lib/oppctx.js"') > 0);
  const html = fs.readFileSync(path.join(APP, "src", "index.html"), "utf8");
  const a = html.indexOf('<script src="lib/oppctx.js"></script>'), b = html.indexOf('<script src="lib/breakdown.js"></script>');
  assert.ok(a > 0 && b > a);
});
t("pure ES5: no network, storage, DOM or clock", () => {
  const code = fs.readFileSync(SRC, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  for (const bad of [/\bfetch\b/, /XMLHttpRequest/, /localStorage|sessionStorage|indexedDB/, /\bdocument\b/, /\bwindow\b/, /Date\.now|new Date/, /=>/, /\blet\b|\bconst\b/, /`/])
    assert.ok(!bad.test(code), "forbidden: " + bad);
});

// ── 7 wiring into the Fantasy game log (lib/breakdown.js fantasyColumns) ──
t("the Fantasy log keeps Result without a supported matchup source, and swaps in 'Opp vs QB' when one is loaded", () => {
  const BD = require(path.join(APP, "src", "lib", "breakdown.js"));
  const p = { id: "qa", pos: "QB" };
  const heads = (cols) => cols.map((c) => c.head.replace(/<[^>]*>/g, ""));
  // no source (the recording): Result stays, no matchup column, nothing invented
  assert.deepEqual(heads(BD.fantasyColumns({ intel: {} }, p)), ["Pts", "Rank", "Result"]);
  assert.deepEqual(heads(BD.fantasyColumns({ intel: { opp: { state: "error" } } }, p)), ["Pts", "Rank", "Result"]);
  // a supported index: the third column becomes the matchup column with the pregame rank
  const S = { intel: { opp: { state: "ok", index: O.build(std()) } } };
  const cols = BD.fantasyColumns(S, p);
  assert.deepEqual(heads(cols), ["Pts", "Rank", "Opp vs QB"]);
  assert.equal(cols[2].cell({ week: 3, game: { opp: "CCC" } }).replace(/<[^>]*>/g, ""), "1st");
  assert.equal(cols[2].cell({ week: 3, bye: true }).replace(/<[^>]*>/g, ""), "—", "a bye has no matchup");
  assert.equal(cols[2].cell({ week: 1, game: { opp: "AAA" } }).replace(/<[^>]*>/g, ""), "—", "Week 1 has no prior games");
});

console.log("mobile2027_r8_oppctx: " + n + " passed");
