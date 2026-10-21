// Player modal Phase 1 (#1338): bio facts, write confirmations, Stats and Game Log.
// Pure modules run in a vm on recorded data (tests/fixtures/player_modal_phase1_dak_brissett.json, 2026-10-20);
// the Front Office source is checked for the wiring. No network, no D1.
//   node tests/player_modal_phase1.test.mjs
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { t, test, run } from "./fixtures/mini_test.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
const FX = JSON.parse(read("tests/fixtures/player_modal_phase1_dak_brissett.json"));
const FO = read("site/rosters/v2/front_office.js");
const CSS = read("site/rosters/v2/front_office.css");

const ctx = { console }; ctx.window = ctx; vm.createContext(ctx);
const plain = (x) => JSON.parse(JSON.stringify(x));   // vm-realm arrays → this realm, for deepEqual
for (const f of ["site/m/season_scoring.js", "site/shared/player_facts.js", "site/shared/taxi_rule.js", "site/rosters/v2/fo_player_modal.js"]) vm.runInContext(read(f), ctx, { filename: f });
const SS = ctx.UPS_MOBILE_SEASON_SCORING, F = ctx.UPS_PLAYER_FACTS, M = ctx.UPS_FO_MODAL;

const HISTORY = {};   // front_office.js loadRookieDraftHistory: latest draft per player
for (const r of JSON.parse(read("site/rookies/rookie_draft_history.json")).picks) {
  const pid = String(r.player_id || "").replace(/\D/g, "");
  if (pid && (!HISTORY[pid] || r.season > HISTORY[pid].season)) HISTORY[pid] = { season: r.season, round: r.round, pick: r.slot };
}
const bio = (pid, rec, season = 2026, ok = true) => {
  const d = M.upsDraftRecord(HISTORY[pid], { round: rec.upsDraftRound, year: rec.upsDraftYear }, ok);
  return { draft: M.upsDraftText(d), taxi: M.taxiStatus(rec, d, season) };
};

// ── Bio ──────────────────────────────────────────────────────────────
test("Dak Prescott: UPS Draft 2016 Rd 5 and a truthful taxi reason (window ended), never 'not a UPS Rookie Draft pick'", () => {
  const b = bio("12620", FX.rosterRecord["12620"]);
  t.equal(b.draft, "2016 · Rd 5, Pick 6");
  t.equal(b.taxi.text, "Not eligible · taxi window ended (2016 draft)");
  t.ok(!/not a UPS Rookie Draft pick/.test(b.taxi.text + b.taxi.note));
  // A permanently promoted pick whose window also ended keeps both reasons, distinct.
  const both = bio("12620", { ...FX.rosterRecord["12620"], taxiPermanentPromotion: true });
  t.equal(both.taxi.text, "Not eligible · taxi window ended (2016 draft)");
  t.equal(both.taxi.note, "Also: permanently promoted.");
});

test("a permanent promotion wins over the worker's eligible flag (40 players on 2026-10-20 have both set)", () => {
  // e.g. a 2025 Round 3 pick in the window: the worker flag ignores promotion; main showed "permanently promoted".
  const rec = M.upsDraftRecord({ season: 2025, round: 3, pick: 4 }, { round: 3, year: 2025 }, true);
  const t1 = M.taxiStatus({ taxiEligible: true, taxiPermanentPromotion: true, type: "Rookie-Draft" }, rec, 2026);
  t.equal(t1.text, "Not eligible · permanently promoted");
  t.equal(t1.eligible, false);
  // The worker's own verdict disagreeing with the draft history is a real conflict → Unknown.
  const r1 = M.upsDraftRecord({ season: 2020, round: 3, pick: 1 }, { round: 0 }, true);
  t.equal(M.taxiStatus({ type: "Rookie-Draft", taxiStatus: { eligible: true, reason: "eligible", text: "Eligible · 3 of 3 call-ups left" } }, r1, 2026).text, "Unknown");
  // ...but the worker's "no pick in its 3-draft index" never contradicts an older pick in the full history.
  t.equal(M.taxiStatus({ type: "Rookie-Draft", taxiStatus: { eligible: false, reason: "no_recent_pick" } }, r1, 2026).text, "Not eligible · taxi window ended (2020 draft)");
});

test("taxi boundaries in the panel: 0–3 activations temporary (demotable), the 4th permanent; release ends it; a trade keeps it", () => {
  const rec = M.upsDraftRecord({ season: 2025, round: 3, pick: 4 }, { round: 3, year: 2025 }, true);
  for (const used of [0, 1, 2, 3]) {
    const r = M.taxiStatus({ type: "Rookie-Draft", taxiCallupsUsed: used, taxiPermanentPromotion: false }, rec, 2026);
    t.equal(r.eligible, true); t.equal(r.can_demote, true, used + " used: demote allowed"); t.equal(r.text, (3 - used) + " of 3 call-ups left · on the active roster");
  }
  t.equal(M.taxiStatus({ type: "Rookie-Draft", taxiCallupsUsed: 4, taxiPermanentPromotion: true }, rec, 2026).text, "Not eligible · permanently promoted");
  t.equal(M.taxiStatus({ type: "Rookie-Draft", taxiCallupsUsed: 1, taxiCallupsPending: 1 }, rec, 2026).can_demote, true, "a pending call-up never blocks a demote");
  t.ok(/released since the draft/.test(M.taxiStatus({ type: "Vet-FAA" }, rec, 2026).text), "cut and re-acquired: not eligible");
  t.equal(M.taxiStatus({ type: "Rookie-Draft" }, rec, 2026).eligible, true, "traded: the Rookie-Draft contract carries over");
  t.equal(M.taxiStatus({ type: "Rookie-Draft", isTaxi: true }, rec, 2026).can_demote, false, "already on taxi");
  t.equal(M.taxiStatus({ type: "Rookie-Draft" }, M.upsDraftRecord({ season: 2023, round: 3, pick: 4 }, { round: 0 }, true), 2026).text, "Not eligible · taxi window ended (2023 draft)");
  // Move to Taxi follows the worker's verdict; the rule loads before the panel module, on the page and in the MFL embed.
  t.ok(/p\.taxiStatus \? p\.taxiStatus\.can_demote === true :/.test(chunks(FO).find((c) => c.name === "renderActionsTab").body));
  const html = read("site/rosters/v2/front_office.html"), loader = read("site/rosters/fo_embed_loader.js");
  t.ok(html.indexOf("shared/taxi_rule.js") > 0 && html.indexOf("shared/taxi_rule.js") < html.indexOf("fo_player_modal.js"));
  t.ok(loader.indexOf('"shared/taxi_rule.js"') > 0 && loader.indexOf('"shared/taxi_rule.js"') < loader.indexOf('"rosters/v2/fo_player_modal.js"'));
});

test("Jacoby Brissett: not a UPS pick, and the taxi line says exactly that", () => {
  const b = bio("12616", FX.rosterRecord["12616"]);
  t.equal(b.draft, "Not a UPS Rookie Draft pick");
  t.equal(b.taxi.text, "Not eligible · not a UPS Rookie Draft pick");
});

test("the UPS Draft line and the taxi reason can't contradict (every UPS pick 2012–2026, every flag combination)", () => {
  let n = 0;
  const pids = Object.keys(HISTORY).concat(["99999901"]);   // + one player who was never drafted
  for (const pid of pids) for (const elig of [false, true]) for (const perm of [false, true]) for (const workerHasPick of [false, true]) for (const type of ["Rookie-Draft", "Vet-FAA"]) {
    const h = HISTORY[pid];
    const rec = { taxiEligible: elig, taxiPermanentPromotion: perm, type, isTaxi: false, isIr: false,
      upsDraftRound: workerHasPick && h ? h.round : null, upsDraftYear: workerHasPick && h ? h.season : null };
    const b = bio(pid, rec);
    n++;
    if (b.draft === "Not a UPS Rookie Draft pick") t.ok(b.taxi.text === "Unknown" || /not a UPS Rookie Draft pick/.test(b.taxi.text), pid + " " + b.taxi.text);
    else {
      t.ok(!/not a UPS Rookie Draft pick/.test(b.taxi.text + " " + (b.taxi.note || "")), pid + ": shows a pick but taxi says no pick");
      if (b.taxi.eligible === true) t.ok(h.round >= 2 && 2026 - h.season < 3 && !perm, pid + " eligible only inside the window, Round 2+");
      if (h.round === 1) t.ok(b.taxi.eligible !== true, pid + " Round 1 is never eligible");
    }
  }
  t.ok(n > 8000, n + " combinations");
  // The history file didn't load: both lines Unknown, never a guess.
  const off = bio("12620", FX.rosterRecord["12620"], 2026, false);
  t.equal(off.draft, "Unknown"); t.equal(off.taxi.text, "Unknown");
  // Worker and history disagree: Unknown with the reason.
  const clash = M.taxiStatus({ taxiEligible: false }, M.upsDraftRecord(HISTORY["12620"], { round: 3, year: 2016 }, true), 2026);
  t.equal(clash.text, "Unknown"); t.ok(/says 2016 Rd 5; the roster record says 2016 Rd 3/.test(clash.note));
  // Both lines read ONE record in the Front Office.
  t.ok(/function bioUpsDraft\(p\)[\s\S]{0,200}foUpsDraftRecord\(p\)/.test(FO) && /function bioTaxiEligibility\(p\)[\s\S]{0,200}foUpsDraftRecord\(p\)/.test(FO));
});

test("missing NFL fields never become false facts", () => {
  const dak = FX.mflDetails["12620"];
  t.equal(M.nflDraftText(dak, "ok"), "2016 · Rd 4, Pick 37", "MFL's draft_team 'FA' for a drafted player is omitted");
  t.equal(M.nflDraftText(FX.mflDetails["12616"], "ok"), "2016 · Rd 3, Pick 28 · NEP");
  for (const d of [{}, { draft_year: "2019" }, { draft_round: "", draft_team: "FA" }, { draft_round: "0" }]) t.equal(M.nflDraftText(d, "ok"), "Unknown", JSON.stringify(d));
  t.equal(M.nflDraftText(dak, "error"), "Unknown"); t.equal(M.nflDraftText(null, "loading"), "Loading…");
  t.equal(M.heightText("", "ok"), "Unknown"); t.equal(M.weightText(undefined, "ok"), "Unknown");
  t.equal(M.bornText("", "ok"), "Unknown"); t.equal(M.plainText("", "ok"), "Unknown");
  t.equal(M.heightText(dak.height, "ok"), "6'2\""); t.equal(M.weightText(dak.weight, "ok"), "238 lbs");
  t.ok(/^Jul 29, 1993 \(age 33\)$/.test(M.bornText(dak.birthdate, "ok", Date.UTC(2026, 9, 20))));
  const all = read("site/rosters/v2/fo_player_modal.js") + FO;
  t.ok(!/(return|=|:|\?)\s*["'`]Undrafted/.test(all), "no Undrafted fallback");
  t.ok(!/UDFA · /.test(read("site/shared/player_profile_master.js")), "the shared popup no longer infers 'UDFA · team'");
});

// ── Actions: every write is confirmed ────────────────────────────────
// Chunks = the Front Office's top-level functions (2-space indent inside the IIFE).
function chunks(src) {
  const re = /\n  (?:async )?function ([A-Za-z0-9_$]+)\(/g, out = [];
  let m, last = null;
  while ((m = re.exec(src))) { if (last) out.push({ name: last.name, body: src.slice(last.at, m.index) }); last = { name: m[1], at: m.index }; }
  if (last) out.push({ name: last.name, body: src.slice(last.at) });
  return out;
}
test("no mutating action can bypass the confirmation", () => {
  t.ok(!/window\.confirm\(/.test(FO), "no bare window.confirm left");
  const writers = chunks(FO).filter((c) => !/^(postContractUpdate|postRosterAction)$/.test(c.name) && /\b(postContractUpdate|postRosterAction)\(/.test(c.body));
  t.deepEqual(writers.map((c) => c.name).sort(), ["submitExtension", "submitExtensionLoaded", "submitMyacContract", "submitMymContract",
    "submitRestructure", "submitRookieOption", "submitRosterMove", "submitTag", "submitUntag"].sort(), "every function that writes is known");
  for (const c of writers) {
    const gate = c.body.indexOf("await foConfirmWrite(");
    const write = c.body.search(/\b(postContractUpdate|postRosterAction)\(/);
    t.ok(gate > 0 && gate < write, c.name + ": confirmation before the first write");
    t.ok(/if \(!\(await foConfirmWrite\([\s\S]*?\)\)\) return;/.test(c.body), c.name + ": a declined confirmation returns");
    t.ok(/finally \{ foWriteDone\(\); \}/.test(c.body), c.name + ": releases the in-flight guard");
  }
  for (const f of ["fo_hub.js", "fo_overview.js", "fo_roster.js", "fo_market.js", "fo_trades.js", "fo_activity.js", "fo_data.js", "fo_cap_ledger.js", "fo_player_modal.js"]) {
    t.ok(!/method:\s*["']POST|postContractUpdate|postRosterAction|sendBeacon/.test(read("site/rosters/v2/" + f)), f + " sends nothing");
  }
  // The dialog refuses an incomplete spec and a second write while one is in flight.
  const conf = chunks(FO).find((c) => c.name === "foConfirmWrite").body;
  t.ok(/!spec \|\| !spec\.action \|\| !spec\.roster \|\| !spec\.cap \|\| !spec\.reversible/.test(conf) && /STATE\.writeBusy/.test(conf));
  t.ok(/data-confirm="no">Cancel<\/button>/.test(conf) && /btns\[0\]\.focus\(\)/.test(conf), "Cancel first and focused");
  t.ok(/e\.key === "Escape"[^\n]*done\(false\)/.test(conf) && /!e\.defaultPrevented && !\$\("#fo-slideover"\)\.hidden/.test(FO), "Escape cancels the dialog, not the panel");
});

test("each write kind's confirmation names player, action, roster, salary/cap and undo", () => {
  const facts = { name: "Dak Prescott", team: "Real Deal Creel", salary: 63000, capHit: 63000, activeN: 29, activeMax: 30, taxiN: 4, season: 2026,
    penalty: { amount: 21000, nextSeason: true }, ir: { state: "unknown", why: "MFL's injury report hasn't finished loading." },
    callups: { used: 3, max: 3 }, contract: { status: "Vet-ERA", years: [63000, 63000], tcv: 126000, gtd: 42000, priorStatus: "WW" } };
  for (const k of M.WRITE_KINDS) {
    const s = M.writeSpec(k, facts);
    for (const f of ["title", "player", "action", "roster", "cap", "reversible", "confirmLabel"]) t.ok(s && String(s[f] || "").length > 2, k + "." + f);
    t.ok(/Dak Prescott/.test(s.action), k + " names the player in the action");
  }
  t.equal(M.writeSpec("not_a_write", facts), null, "an unknown kind has no spec, so it can't be confirmed");
  const drop = M.writeSpec("drop_player", facts);
  t.equal(drop.roster, "Leaves the roster: active 29 → 28 (limit 30).");
  t.equal(drop.cap, "This season’s $63,000 cap hit comes off. Drop penalty $21,000, charged to next season’s cap.");
  t.ok(/^No\./.test(drop.reversible) && drop.danger);
  t.ok(/couldn’t be priced/.test(M.writeSpec("drop_player", { ...facts, penalty: { amount: NaN } }).cap), "an unpriced penalty says so, never $0");
  t.ok(/call-up 4: the promotion becomes permanent/.test(M.writeSpec("promote_taxi", facts).reversible), "the 4th call-up is flagged permanent");
  t.ok(/50% IR relief/.test(M.writeSpec("deactivate_ir", facts).cap) && /isn’t verified here/.test(M.writeSpec("deactivate_ir", facts).details.join(" ")));
  t.ok(/Dry run requested/.test(M.writeSpec("myac", { ...facts, dry: true }).details.join(" ")));
  // The roster-move actions the Actions tab sends are kinds with a spec.
  for (const a of FO.matchAll(/submitRosterMove\("([a-z_]+)"/g)) t.ok(M.WRITE_KINDS.includes(a[1]), a[1]);
  for (const a of FO.matchAll(/foWriteSpec\("([a-z_]+)"/g)) t.ok(M.WRITE_KINDS.includes(a[1]), a[1]);
});

test("Actions: short rows, rules in a disclosure, disabled reasons behind a 'Why' toggle", () => {
  const tab = chunks(FO).find((c) => c.name === "renderActionsTab").body;
  t.ok(!/Drop fires §D1 cap penalty|owner-confirmed|irHelpNote/.test(tab), "the old help paragraphs are gone");
  t.ok(/foWhyHtml\("Why is Place on IR off\?"/.test(tab));
  t.ok(/<details class="fo-act-more"><summary>Rules<\/summary>/.test(chunks(FO).find((c) => c.name === "actionRow").body));
});

// ── Stats and Game Log ───────────────────────────────────────────────
const ss = SS.build(FX.playerScores, { completedWeek: SS.completedWeekFrom(FX.currentLineupWeek), season: FX.season });
ss.season = FX.season;
const QB = new Set(FX.qbIds), groupOf = (pid) => (QB.has(pid) ? "QB" : "");
const stats = (pid) => {
  const line = F.season(ss, pid, groupOf, { last: 4 });
  const cur = { ...line, ptsRank: M.pointsRank(ss, pid, groupOf) };
  const rows = M.seasonRows(FX.bundles[pid].career_summary, cur, 2026, FX.bundles[pid].weekly_by_season);
  return { line, cur, rows, sum: M.careerSummary(rows) };
};
const log = (pid, season, team) => M.gameLog({ season, current: season === "2026", ss, pid, groupOf,
  dbWeeks: FX.bundles[pid].weekly_by_season[season] || [], byeWeek: season === "2026" ? FX.byes[team] : 0 });

test("2026 is one set of numbers: headline = season-table row = Game Log summary = the released phone sheet", () => {
  const want = { "12620": { pts: "141.4", ppg: "23.6", rank: "#14 QB", ptsRank: 10, l4: "20.1", l4rank: 17 },
                 "12616": { pts: "116.1", ppg: "19.4", rank: "#21 QB", ptsRank: 16, l4: "21.5", l4rank: 16 } };   // 116.1 ÷ 6 = 19.35 → 19.4 (half-up)
  for (const pid of Object.keys(want)) {
    const { line, cur, rows } = stats(pid), w = want[pid], r = rows[0], g = log(pid, "2026", pid === "12620" ? "DAL" : "ARI");
    t.equal(M.fmt1(line.pts), w.pts); t.equal(M.fmt1(line.ppg), w.ppg); t.equal(line.rankLabel, w.rank);
    t.equal(cur.ptsRank.rank, w.ptsRank); t.equal(cur.ptsRank.of, 62);
    t.equal(M.fmt1(line.last.ppg), w.l4); t.equal(line.last.rank, w.l4rank); t.equal(line.last.weeks, "Wks 3–6");
    t.ok(r.current && r.season === 2026, "the table starts with 2026");
    t.equal(M.fmt1(r.pts), w.pts); t.equal(r.games, line.games); t.equal(M.fmt1(r.ppg), w.ppg); t.equal(r.ppgRank, line.rank); t.equal(r.ptsRank, w.ptsRank);
    t.equal(M.fmt1(g.pts), w.pts); t.equal(g.games, line.games); t.equal(M.fmt1(g.ppg), w.ppg);
    t.equal(rows.filter((x) => x.season === 2026).length, 1, "the database's 2026 copy is not a second row");
  }
});

test("'Highest-scoring season' = most total points among completed seasons; no Best Season, no APW", () => {
  const dak = stats("12620").sum, jb = stats("12616").sum;
  t.deepEqual([dak.best.season, dak.best.pts], [2025, 409.3]);
  t.deepEqual([jb.best.season, jb.best.pts], [2025, 259.9]);
  t.deepEqual([dak.games, dak.pts, M.fmt1(dak.ppg)], [125, 2878.7, "23.0"], "career = every row of the table, 2026 included");
  const rowsWithPartial = M.seasonRows([{ season: 2025, games_played: 1, season_points: 5 }], { pts: 999, games: 6, ppg: 166.5, rank: 1, group: "QB" }, 2026,
    { 2025: [15, 16, 17].map((week) => ({ week })) });
  t.equal(M.careerSummary(rowsWithPartial).best.season, 2025, "an in-progress season is never the highest-scoring season");
  t.ok(/"Highest-scoring season"/.test(FO) && !/Best Season/.test(FO));
  t.ok(!/APW|win_chunks|leverage_coefs|Elite%/.test(chunks(FO).filter((c) => /^foStat|^renderStatsTab/.test(c.name)).map((c) => c.body).join("")), "no APW / Elite% in Stats");
});

test("earlier-season ranks show only when they describe the row's own total", () => {
  const dak = stats("12620").rows, by = (y) => dak.find((r) => r.season === y);
  t.deepEqual([by(2025).ptsRank, by(2025).ppgRank], [4, 5], "409.3 over 16 = the rank table's total");
  t.deepEqual([by(2019).ptsRank, by(2019).ppgRank], [null, null], "2019: rank counts 361.1 over 15 (playoffs), row shows 308.2 over 12");
  t.ok(/361\.1 pts over 15 MFL wks, not the 308\.2 over 12/.test(by(2019).notes.join(" ")));
  t.deepEqual([by(2024).ptsRank, by(2024).ppgRank], [null, null], "2024: rank table's 245.7 over 14 ≠ 151.2 over 8");
  t.deepEqual([by(2020).ptsRank, by(2020).ppgRank], [29, null], "2020: 5 of 16 weeks is too few for a PPG rank");
  t.ok(/needs half the season’s weeks \(8 of 16\)/.test(by(2020).notes.join(" ")));
  for (const r of dak) for (const n of r.notes) t.ok(!/\bunranked\b/i.test(n), "a note never calls — 'unranked': " + n);
  const noBasis = M.seasonRows([{ season: 2023, games_played: 16, season_points: 404.7, pos_rank: 3, pos_ppg_rank: 5 }], null, 2026)[0];
  t.equal(noBasis.ptsRank, null, "a bundle without the basis columns shows no rank (fails closed)");
});

test("one Game Log schema for every season; no z-score or tiers; gaps are labelled, not blank", () => {
  const cur = log("12620", "2026", "DAL"), y25 = log("12620", "2025"), y19 = log("12620", "2019");
  const keys = (g) => JSON.stringify(Object.keys(g.rows[0]).sort());
  t.equal(keys(cur), keys(y25)); t.equal(keys(cur), keys(y19));
  t.deepEqual(plain(cur.rows.map((r) => r.week)), [6, 5, 4, 3, 2, 1], "newest week first");
  t.deepEqual(plain(cur.rows.map((r) => r.posRank)), [16, 17, 11, 18, 2, 18], "2026 weekly ranks from MFL = the database's pos_rank");
  t.deepEqual(plain(cur.rows.map((r) => r.posRank)), [6, 5, 4, 3, 2, 1].map((w) => FX.bundles["12620"].weekly_by_season["2026"].find((x) => x.week === w).pos_rank));
  t.ok(y25.rows.filter((r) => r.playoff).every((r) => r.week >= 15), "2025 playoffs = Wks 15–17");
  t.deepEqual([y25.games, y25.pts], [16, 409.3], "2025 Game Log = the 2025 season row");
  // 2019: the database never stored UPS owners — say so, never 'Free agent'; playoff weeks weren't loaded.
  t.ok(y19.rows.filter((r) => r.pts != null).every((r) => r.status === "not recorded"));
  t.deepEqual(plain(y19.rows.filter((r) => r.playoff).map((r) => r.label)), ["not loaded", "not loaded", "not loaded"]);
  t.ok(y19.coverage.some((c) => /2012–2019/.test(c)) && y19.coverage.some((c) => /Playoff weeks 14–16/.test(c)));
  t.ok(log("12616", "2024").coverage.some((c) => /Free agents’ playoff weeks/.test(c)));
  // MFL's scoring unreadable: the current season fails visibly.
  const bad = M.gameLog({ season: "2026", current: true, ss: SS.build({ error: "x" }), pid: "12620", groupOf });
  t.ok(bad.failed && bad.rows.length === 0 && /couldn’t be read/.test(bad.coverage[0]));
  // The Front Office renders every season through ONE function, without z / tiers.
  const gl = chunks(FO).filter((c) => /GameLog/.test(c.name)).map((c) => c.name);
  t.deepEqual(gl.sort(), ["foGameLogHtml", "renderGameLogTab"]);
  t.ok(!/z_score|week_tier|foGlTierClass|Elite|Neutral|Dud|"Tier"/.test(chunks(FO).filter((c) => /GameLog/.test(c.name)).map((c) => c.body).join("")));
  t.ok(!/\.fo-tier/.test(CSS), "tier badge styles removed");
});

test("historical partial data: totals stay visible, labelled Partial, never ranked or compared", () => {
  const dak = stats("12620"), by = (y) => dak.rows.find((r) => r.season === y);
  for (const y of [2016, 2017, 2018, 2019]) {
    t.ok(by(y).partial, y + " (playoff weeks not loaded, MFL's summary counts more) is Partial");
    t.ok(by(y).pts > 0 && by(y).ppg > 0, y + " keeps its known Points and PPG");
    t.equal(by(y).ptsRank, null); t.equal(by(y).ppgRank, null);
  }
  t.equal(by(2020).partial, false, "2020: MFL's own summary equals the row (152.2 over 5), so nothing is missing");
  t.equal(by(2025).partial, false, "2025: every playoff week has a row");
  t.equal(by(2024).partial, true, "2024: no row for playoff Wks 15–17 and no confirming summary");
  t.ok(/Partial: the league database has no row for playoff Wks 15–17/.test(by(2024).notes.join(" ")));
  t.equal(dak.sum.partialSeasons, 5);
  t.equal(dak.sum.best.season, 2025, "the highest-scoring season is chosen from complete seasons only");
  // A partial season never wins the comparison even with more points.
  const rows = M.seasonRows([{ season: 2019, games_played: 12, season_points: 999, rank_basis_points: 1100, rank_basis_games: 15 },
    { season: 2023, games_played: 16, season_points: 404.7, rank_basis_points: 404.7, rank_basis_games: 16 }], null, 2026, { 2023: [15, 16, 17].map((week) => ({ week })) });
  t.equal(M.careerSummary(rows).best.season, 2023);
  // The Game Log agrees: a confirmed-complete season's missing playoff weeks had no MFL score; a partial one says so.
  const g20 = M.gameLog({ season: "2020", current: false, dbWeeks: FX.bundles["12620"].weekly_by_season["2020"] || [], complete: true });
  t.ok(g20.rows.filter((r) => r.playoff && r.pts == null).every((r) => r.label === "no MFL score") && !g20.coverage.some((c) => /Playoff weeks/.test(c)));
  const g19 = M.gameLog({ season: "2019", current: false, dbWeeks: FX.bundles["12620"].weekly_by_season["2019"] || [], complete: false });
  t.ok(g19.partial && g19.coverage.some((c) => /Lineup records/.test(c)) && g19.coverage.some((c) => /not loaded/.test(c)));
  t.ok(g19.rows.every((r) => r.status === "not recorded"), "2019: no started/benched/free-agent status is inferred");
  // The Stats tab: Partial and † are short tappable controls; the explanation sits in a closed disclosure.
  const html = chunks(FO).find((c) => c.name === "foStatsHtml").body;
  t.ok(/foNoteBtn\("Partial", key, "fo-partial"\)/.test(html) && /"—" \+ dag/.test(html) && /<details class="fo-stat-why" id="fo-stat-notes">/.test(html));
  t.ok(!/rankLabel|unranked/.test(html), "the Stats tab never prints 'unranked'");
});

test("one rounding rule everywhere: decimal half-up through the shared formatter", () => {
  t.equal(SS.fmt1(116.1 / 6), "19.4"); t.equal(SS.fmt1(19.35), "19.4"); t.equal(SS.fmt1(246.9 / 11), "22.4");
  t.equal(SS.fmt1(-2.25), "-2.3"); t.equal(SS.fmt1(-0.04), "0.0"); t.equal(SS.fmt1(2878.7), "2878.7"); t.equal(SS.fmt1(null), "0.0");
  t.equal(SS.round1(116.10000000000001), 116.1);
  t.equal(F.fmt1(116.1 / 6), "19.4", "player_facts uses it"); t.equal(M.fmt1(116.1 / 6), "19.4", "the panel uses it");
  t.equal(M.comma1(2878.65), "2,878.7");
  t.ok(/function fmt1\(v\) \{ var SS = root\.UPS_MOBILE_SEASON_SCORING; return SS && SS\.fmt1 \? SS\.fmt1\(v\)/.test(read("site/shared/player_facts.js")));
  t.ok(!/Math\.round\(\(Number\(v\) \|\| 0\) \* 10\) \/ 10/.test(read("site/rosters/v2/fo_player_modal.js") + read("site/shared/player_facts.js")), "no private Math.round formatter left");
});

test("Roster and Market open the same panel (one openSlideover)", () => {
  t.ok(/openPlayer: function \(pid, fid, subtab\) \{ openSlideover\(String\(pid\), pad4\(fid\), subtab\); \}/.test(FO));
  t.ok(/f\.openPlayer\(pid, fid,/.test(read("site/rosters/v2/fo_hub.js")));
  t.equal((FO.match(/\n  function openSlideover\(/g) || []).length, 1);
  t.ok(read("site/rosters/v2/front_office.html").indexOf("fo_player_modal.js") < read("site/rosters/v2/front_office.html").indexOf("front_office.js?v"), "the modal module loads before front_office.js");
  const loader = read("site/rosters/fo_embed_loader.js");
  t.ok(loader.indexOf('"rosters/v2/fo_player_modal.js"') > 0 && loader.indexOf('"rosters/v2/fo_player_modal.js"') < loader.indexOf('"rosters/v2/front_office.js"'), "and in the MFL embed");
});

await run("player_modal_phase1");
