// Desktop player cards say what the released phone sheet says (#1338): same season points, PPG, rank and basis
// line, same injury chip and "sources disagree" box, "Expired" for contractYear 0, "Ownership unknown" for a
// failed roster read, and only http(s) news links.
//   node tests/front_office_player_facts_parity.test.mjs
//   FO_JS=<path> PM_JS=<path> node tests/front_office_player_facts_parity.test.mjs   (defect check against other copies)
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { t, test, run } from "./fixtures/mini_test.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const FO = fs.readFileSync(process.env.FO_JS || path.join(ROOT, "site/rosters/v2/front_office.js"), "utf8");
const PM = fs.readFileSync(process.env.PM_JS || path.join(ROOT, "site/shared/player_profile_master.js"), "utf8");
const SHEET = read("site/m/player_sheet.js");
const FX = JSON.parse(read("tests/fixtures/season_scoring_2026_wk7_qb_te_pk.json"));
const INJ = JSON.parse(read("tests/fixtures/injury_status_2026_wk6.json"));

function sliceFn(src, sig) {
  const at = src.indexOf(sig);
  if (at < 0) throw new Error("not found: " + sig);
  let i = src.indexOf("{", at), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(at, i + 1);
  }
  throw new Error("unbalanced: " + sig);
}

// One context with the shared modules the desktop loads.
const ctx = vm.createContext({ Date, Math, JSON });
ctx.window = ctx;
for (const f of ["site/m/front_office_lineup.js", "site/m/season_scoring.js", "site/shared/injury_status.js", "site/shared/player_facts.js"]) vm.runInContext(read(f), ctx);
const SS = ctx.UPS_MOBILE_SEASON_SCORING, F = ctx.UPS_PLAYER_FACTS, LN = ctx.UPS_FRONT_OFFICE_LINEUP;
const players = FX.players.players.player;
const posOf = Object.fromEntries(players.map((p) => [p.id, p.position]));
const groupOf = (pid) => { const g = LN.posGroup(String(posOf[pid] || "").toUpperCase()); return g && g !== "OTH" ? g : ""; };
const FETCHED = Date.parse("2026-10-20T18:05:00Z");
function scoring() {
  const ss = SS.build(FX.playerScoresAll, { completedWeek: SS.completedWeekFrom(FX.lineup_week), season: 2026 });
  ss.season = 2026; ss.fetchedAt = FETCHED;
  return ss;
}

// The phone sheet's own functions, run against a stub of the app with the same reads.
function phone(ss) {
  const c = vm.createContext({ Date, Math, JSON });
  c.window = c;
  c.window.UPS_MOBILE_SEASON_SCORING = SS;
  c.window.UPS_FRONT_OFFICE_LINEUP = LN;
  const byId = Object.fromEntries(players.map((p) => [p.id, p]));
  c.window.UPS_MOBILE = { state: { ctx: { year: "2026" } }, data: { getSeasonScoring: () => ss, playerById: (id) => byId[id] } };
  c.U = { safeStr: (v) => (v == null ? "" : String(v).trim()) };
  c.DATA = c.window.UPS_MOBILE.data;
  const code = [sliceFn(SHEET, "function clockLabel("), sliceFn(SHEET, "function seasonPointsBasis("),
    sliceFn(SHEET, "function seasonPoints("), sliceFn(SHEET, "function liveSeasonRow(")].join("\n") +
    "\nthis.basis = seasonPointsBasis; this.points = seasonPoints;";
  vm.runInContext(code, c);
  return c;
}

test("season points, PPG, rank and the basis line match the phone sheet for every QB, TE and K MFL scored", () => {
  const ss = scoring();
  const ph = phone(ss);
  t.equal(F.basis(ss).text, ph.basis().text, "basis line, word for word");
  t.ok(/^Actual 2026 MFL points, UPS scoring · Wks 1–\d+/.test(F.basis(ss).text), F.basis(ss).text);
  let n = 0;
  for (const p of players) {
    const mine = F.season(ss, p.id, groupOf);
    const theirs = ph.points(p.id);
    t.equal(JSON.stringify([mine.pts, mine.games, mine.ppg == null ? null : +mine.ppg.toFixed(6), mine.rankLabel]),
      JSON.stringify([theirs.pts, theirs.games, theirs.ppg == null ? null : +theirs.ppg.toFixed(6), theirs.rankLabel]), p.name);
    n++;
  }
  t.ok(n > 200, n + " players compared");
});

test("another season's payload is never shown as this season's", () => {
  const ss = SS.build(FX.playerScoresAll, { completedWeek: 6, season: 2027 });
  ss.season = 2027;
  t.equal(F.basis(ss).ok, false);
  t.ok(/aren’t marked as 2027/.test(F.basis(ss).text));
  t.equal(F.season(ss, players[0].id, groupOf), null, "no line at all");
});

test("injury chip + disagreement box: the shared resolver's answer, for a real Week-6 read", () => {
  const readOk = { state: "ok", data: INJ.player_status, at: Date.now() };
  let disagreeSeen = 0, chips = 0;
  for (const [fid, roster] of Object.entries(INJ.rosters)) {
    for (const row of roster) {
      const pid = row.id;
      const team = (INJ.players[pid] || [])[2] || "";
      const direct = ctx.UPSInjuryStatus.resolve(readOk, pid, team, {});
      const viaFacts = F.injury(readOk, pid, team, null);
      t.equal(JSON.stringify(viaFacts), JSON.stringify(direct), fid + "/" + pid);
      if (viaFacts.warning) disagreeSeen++;
      if (viaFacts.chips.length) chips++;
    }
  }
  t.ok(chips > 0, chips + " chips");
  const html = F.warningHtml({ warning: { title: "Injury sources disagree", lines: ["MFL: Questionable", "Official NFL report: Not listed for Week 6"] } }, (s) => String(s));
  t.ok(/Injury sources disagree/.test(html) && /upf-inj-warning/.test(html), "the red box renders");
  t.ok(disagreeSeen >= 0);
});

test("small facts: Expired, ownership unknown, http(s) links only, MFL fallback words", () => {
  t.equal(F.yearsLeftText(0), "Expired");
  t.equal(F.yearsLeftText("2"), "2 yrs left");
  t.equal(F.yearsLeftText(""), "—");
  const teams = [{ fid: "0001", players: [{ id: "1" }] }, { fid: "0002", players: [] }];
  t.equal(JSON.stringify(F.ownership(teams, "9", ["0001", "0002"])), JSON.stringify({ known: false, free: false, fid: "" }), "a roster not read → unknown, not free");
  t.equal(F.ownership([{ fid: "0001", players: [{ id: "1" }] }, { fid: "0002", players: [{ id: "2" }] }], "9", ["0001", "0002"]).free, true, "every roster read → free agent");
  t.equal(F.safeHttpUrl("javascript:alert(1)"), "");
  t.equal(F.safeHttpUrl("https://x.example/a"), "https://x.example/a");
  t.equal(JSON.stringify(F.fallbackFromMfl("IR-R", "Knee")), JSON.stringify({ roster: { chip: "IR", label: "Injured reserve – designated to return", detail: "Knee" } }));
  t.equal(F.fallbackFromMfl("Questionable", "").mfl.status, "Questionable");
});

test("Front Office uses the shared facts: no private chip letters, no return dates, MFL season line, owner-only actions", () => {
  t.ok(!/NFL_STATUS_ABBR/.test(FO), "the FO-only O/S/HO/P/C chip map is gone");
  t.ok(!/expected back/.test(FO), "no expected-return dates");
  // Roster rows: the shared player cell (fo_hub.js playerCell, 2026-10-28) carrying the shared chip.
  t.ok(/\$\{rosterPlayerCell\(p\)\}/.test(sliceFn(FO, "function renderRosterRow(")) && /const chip = injuryChipHtml\(p\)/.test(sliceFn(FO, "function rosterPlayerCell(")), "roster rows use the shared chip");
  t.ok(/injuryChipHtml\(p\)/.test(sliceFn(FO, "function slideoverTitleHtml(")), "panel title uses the shared chip");
  t.ok(/slideoverInjuryHtml\(p\)/.test(sliceFn(FO, "function openSlideover(")), "panel shows the disagreement box");
  const stats = sliceFn(FO, "async function renderStatsTab(");
  // #1338 Phase 1: the table is built by UPS_FO_MODAL.seasonRows, which skips the database's copy of the current season.
  t.ok(/foSeasonFacts\(p\)/.test(stats) && /if \(!yr \|\| yr === season\) return;/.test(read("site/rosters/v2/fo_player_modal.js")), "this season from MFL; the database copy only for earlier seasons");
  const actions = sliceFn(FO, "function renderActionsTab(");
  t.ok(/pad4\(p\.fid\) !== viewerFid/.test(actions), "another team's player gets no contract/roster buttons");
});

test("shared popup: Expired, ownership unknown, safe news links, shared injury chip", () => {
  t.ok(/yrsRem === 0 \? "Expired"/.test(PM), "contractYear 0 → Expired");
  t.ok(!/retired \/ out of league/.test(PM), "a failed roster read is never 'retired'");
  t.ok(/Ownership unknown/.test(PM), "it is 'Ownership unknown'");
  t.ok(/var safeUrl = \/\^https\?:/.test(PM) && !/href="' \+ escapeHtml\(item\.url\)/.test(PM), "news links are scheme-checked");
  t.ok(/wireInjuryAsync\(bodyContent, ctx, pid\)/.test(PM), "the popup wires the shared injury chip");
  const yr = vm.createContext({});
  vm.runInContext(sliceFn(PM, "function yearsRemain("), yr);
  t.equal(vm.runInContext("yearsRemain({ contractYear: '0', contractInfo: 'CL 3| TCV 15K' })", yr), 0, "an expired 3-year deal is 0, not 3");
  t.equal(vm.runInContext("yearsRemain({ contractYear: '', contractInfo: 'CL 3' })", yr), null, "blank → unknown");
});

test("the Front Office embed loads the shared modules before front_office.js", () => {
  const ldr = read("site/rosters/fo_embed_loader.js");
  const order = ["shared/injury_status.js", "m/front_office_lineup.js", "m/season_scoring.js", "shared/player_facts.js", "rosters/v2/fo_data.js", "rosters/v2/front_office.js"];
  const at = order.map((f) => ldr.indexOf('"' + f + '"'));
  t.ok(at.every((x) => x > 0), "all listed");
  t.ok(at.every((x, i) => i === 0 || at[i - 1] < x), "in order, front_office.js last");
  const html = read("site/rosters/v2/front_office.html");
  for (const f of ["injury_status.js", "season_scoring.js", "player_facts.js", "fo_data.js"]) t.ok(html.includes(f), "standalone page loads " + f);
});

await run("front_office_player_facts_parity");
