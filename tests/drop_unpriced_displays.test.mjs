// An UNPRICED drop penalty is never shown as $0 and never sorts as the cheapest drop — on mobile, on the desktop Front Office,
// on the legacy desktop Roster Workbench, and in the shared cap_math helper (Keith 2026-10-09, #1202 review finding 1).
//   node tests/drop_unpriced_displays.test.mjs
//
// The worker's /api/cap-penalty/preview sends penalty: null when it cannot price a drop (an MFL read failed — the
// acquisition week or the completed-week count — or the contract is unstamped). Before this fix mobile's drop helper and the
// Roster Workbench coerced that null to $0: the player sheet said "(no penalty)", the drop picker listed the player as the
// cheapest drop, and cap room after the drop was computed as if it cost nothing; cap_math quietly substituted its own estimate.
// Every function below is the REAL one from the shipped file (loaded whole, or cut out by its signature — never re-typed).
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { t, test, run } from "./fixtures/mini_test.mjs";
import { loadFrontOfficeV2 } from "./fixtures/front_office_v2_harness.mjs";
import { loadRosterWorkbench } from "./fixtures/roster_workbench_harness.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
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

// /api/cap-penalty/preview rows, as the worker sends them
const REVIEW = "The acquisition week could not be resolved (MFL's transactions were unreadable) … HELD — NOT a $0.";
const ROWS = {
  "16601": { penalty: null, guaranteed: null, earned: null, tcv: 11000, basis: "week_authority_unresolved", needs_review: true, exempt: false, earned_rule: null, review_reason: REVIEW, eligible_weeks: null },
  "15000": { penalty: null, guaranteed: null, earned: null, tcv: 8000, basis: "contract_unstamped_needs_review", needs_review: true, exempt: false, earned_rule: null, review_reason: "Contract not stamped." },
  "17752": { penalty: 4500, guaranteed: 4500, earned: 0, tcv: 6000, basis: "guarantee_minus_earned", exempt: false, earned_rule: null, eligible_weeks: 13 },
  "17207": { penalty: 0, guaranteed: 0, earned: null, tcv: 1000, basis: "ww_under_5k_exempt", exempt: true, earned_rule: "full_year_sub_5k", exempt_reason: "WW pickup salary ≤ $4K, final year (§D2)." },
};
const ROSTER = [   // mobile roster rows (0008)
  { id: "16601", salary: 11000, contractYear: "1", contractInfo: "CL 1| TCV 11K| AAV 11K", contractStatus: "Vet-WW", status: "ROSTER" },
  { id: "17752", salary: 6000, contractYear: "1", contractInfo: "CL 1| TCV 6K| AAV 6K", contractStatus: "Vet-WW", status: "ROSTER" },
  { id: "15000", salary: 8000, contractYear: "1", contractInfo: "CL 1| TCV 8K| AAV 8K", contractStatus: "Vet-WW", status: "ROSTER" },
  { id: "17207", salary: 1000, contractYear: "1", contractInfo: "CL 1| TCV 1K| AAV 1K", contractStatus: "Vet-WW", status: "ROSTER" },
];
const NOT_ZERO = /\$0\b|no penalty|No dead-cap penalty/;

// ── mobile: the real front_office_penalty.js + the real view functions ──
function mobile() {
  const APP = read("site/m/app.js");
  const ctx = vm.createContext({ console, setTimeout, clearTimeout, fetch: () => Promise.reject(new Error("no network")) });
  ctx.window = ctx; ctx.self = ctx;
  ctx.addEventListener = () => {}; ctx.dispatchEvent = () => {};
  vm.runInContext(["function safeStr(", "function safeInt(", "function escapeHtml(", "function fmtUsd(", "function fmtUsdPrecise("]
    .map((sig) => sliceFn(APP, sig)).join("\n") + "\nthis.U = { safeStr, safeInt, escapeHtml, fmtUsd, fmtUsdPrecise };", ctx);
  ctx.UPS_MOBILE = { state: { capPenaltyByPid: ROWS, viewerFranchiseId: "0008", ctx: { year: "2026" } } };
  vm.runInContext(read("site/m/front_office_penalty.js"), ctx);
  const confirms = [];
  ctx.confirm = (msg) => { confirms.push(msg); return false; };    // the owner cancels — nothing is written
  ctx.M = ctx.UPS_MOBILE; ctx.DATA = {
    getRosterFor: () => ROSTER, playerById: (id) => ({ id, position: "WR", team: "KCC" }),
    dropPenaltyFor: (r, season) => ctx.UPS_FRONT_OFFICE.dropPenaltyFor(r, season),
    computeCap: () => ({ capAmount: 300000, capTotal: 290000, capRoom: 10000 }),
  };
  ctx.nameFor = (p) => "Player " + p.id;
  const P = read("site/m/views/players.js"), S = read("site/m/player_sheet.js");
  vm.runInContext(["function dropCandidateRows(", "function dropCandidateOrder(", "function dropRowPenaltyHtml(", "function dropPenalty(",
    "function dropPenaltyShortText(", "function fcfsDropPenaltySuffix("].map((sig) => sliceFn(P, sig)).join("\n"), ctx);
  vm.runInContext(["function penaltyLabelHtml(", "function dropConfirmPenaltyLine(", "function capPreviewLine(", "function handleDrop("]
    .map((sig) => sliceFn(S, sig)).join("\n"), ctx);
  return { ctx, confirms, run: (code) => vm.runInContext(code, ctx) };
}

test("MOBILE: the drop helper returns an explicit UNPRICED result (amount null), not $0; priced and cap-free rows are unchanged", () => {
  const m = mobile();
  const u = m.run('UPS_FRONT_OFFICE.dropPenaltyFor(' + JSON.stringify(ROSTER[0]) + ', "2026")');
  t.equal(u.unpriced, true); t.equal(u.amount, null, "NOT 0"); t.equal(u.authoritative, true); t.equal(u.note, REVIEW);
  t.equal(m.run('UPS_FRONT_OFFICE.dropPenaltyFor(' + JSON.stringify(ROSTER[2]) + ', "2026")').unpriced, true, "an unstamped contract too");
  const p = m.run('UPS_FRONT_OFFICE.dropPenaltyFor(' + JSON.stringify(ROSTER[1]) + ', "2026")');
  t.equal(p.amount, 4500); t.ok(!p.unpriced);
  t.equal(m.run('UPS_FRONT_OFFICE.dropPenaltyFor(' + JSON.stringify(ROSTER[3]) + ', "2026")').amount, 0, "a real cap-free cut is still $0");
});

test("MOBILE drop picker: cheapest first, an UNPRICED drop LAST; its row says 'penalty under review' and cap room after is unknown", () => {
  const m = mobile();
  const rows = m.run("dropCandidateRows()");
  t.deepEqual(rows.map((r) => r.id).slice(0, 2), ["17207", "17752"], "$0 cap-free, then $4,500");
  t.deepEqual(rows.slice(2).map((r) => r.id).sort(), ["15000", "16601"], "the two unpriced drops are last — never 'cheapest'");
  t.ok(rows.slice(2).every((r) => r.unpriced && r.penaltyAmt === null));
  const html = (id) => m.run("dropRowPenaltyHtml(" + JSON.stringify(rows.find((r) => r.id === id)) + ", DATA.computeCap())");
  t.match(html("16601"), /penalty under review/); t.match(html("16601"), /Cap room after: unknown/); t.doesNotMatch(html("16601"), NOT_ZERO);
  t.match(html("17752"), /\$4\.5K penalty/); t.match(html("17752"), /Cap room after: \$11\.5K/, "$10,000 + $6,000 − $4,500 (mobile's compact money)");
  t.match(html("17207"), /no penalty/);
});

test("MOBILE bid sheet + FCFS confirm: an unpriced drop is 'under review', never '$0 penalty' / 'no cap penalty'", () => {
  const m = mobile();
  t.equal(m.run('dropPenalty("16601")'), null, "null = unpriced (never 0)"); t.equal(m.run('dropPenalty("17752")'), 4500);
  t.equal(m.run('dropPenaltyShortText("16601")'), "penalty under review"); t.equal(m.run('dropPenaltyShortText("17752")'), "$4.5K penalty");
  t.match(m.run("fcfsDropPenaltySuffix(dropPenalty('16601'))"), /under review .*not \$0/);
  t.match(m.run("fcfsDropPenaltySuffix(dropPenalty('17207'))"), /no cap penalty/);
  t.match(read("site/m/views/players.js"), /if \(cap && cap\.capAmount && dropPen === null\) \{\s*advisory = '<div class="ups-m-bid-advisory warn">Cap room after that drop: <strong>unknown<\/strong>/,
    "the bid advisory never computes cap room for an unpriced drop");
});

test("MOBILE player sheet: '(penalty under review)', and the drop confirmation says NOT $0 with no cap-room math", () => {
  const m = mobile();
  t.equal(m.run('penaltyLabelHtml(UPS_FRONT_OFFICE.dropPenaltyFor(' + JSON.stringify(ROSTER[0]) + ', "2026"))'), ' <span class="pn">(penalty under review)</span>');
  t.match(m.run('penaltyLabelHtml(UPS_FRONT_OFFICE.dropPenaltyFor(' + JSON.stringify(ROSTER[1]) + ', "2026"))'), /\$4\.5K penalty/);
  m.run('handleDrop("16601", "Will Shipley", ' + JSON.stringify(ROSTER[0]) + ', null)');
  const msg = m.confirms[0];
  t.match(msg, /Cap penalty: under review — not yet priced\. It is NOT \$0\./); t.match(msg, /Cap room after the drop: unknown until the penalty is priced/);
  t.doesNotMatch(msg, /No dead-cap penalty|Estimated cap penalty: \$0|Room left/);
  m.run('handleDrop("17752", "Dohnte Meyers", ' + JSON.stringify(ROSTER[1]) + ', null)');
  t.match(m.confirms[1], /Estimated cap penalty: \$4\.5K/); t.match(m.confirms[1], /Room left: \$12K/, "a priced drop still previews its cap room");
});

test("SHARED cap_math (profile modal, Team Operations): an unpriced worker row is '—' (null), never a locally guessed number", async () => {
  const ctx = vm.createContext({ console, setTimeout, Event: function (n) { this.type = n; } });
  ctx.window = ctx; ctx.dispatchEvent = () => {};
  ctx.fetch = () => Promise.resolve({ json: () => Promise.resolve({ ok: true, players: ROWS }) });
  vm.runInContext(read("site/shared/cap_math.js"), ctx);
  const sal = (id, k) => ({ id, salary: String(k * 1000), contractStatus: "Vet-WW", contractYear: "1", contractInfo: `CL 1| TCV ${k}K| AAV ${k}K` });
  vm.runInContext("UPS_CAP_MATH.dropPenalty(" + JSON.stringify(sal("16601", 11)) + ", { season: 2026 })", ctx);   // kicks off the batch load
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
  t.equal(vm.runInContext("UPS_CAP_MATH.dropPenalty(" + JSON.stringify(sal("16601", 11)) + ", { season: 2026 })", ctx), null, "unpriced → null ('—'), not the local fallback");
  t.equal(vm.runInContext("UPS_CAP_MATH.dropPenalty(" + JSON.stringify(sal("17752", 6)) + ", { season: 2026 })", ctx), 4500);
  t.equal(vm.runInContext("UPS_CAP_MATH.dropPenalty(" + JSON.stringify(sal("17207", 1)) + ", { season: 2026 })", ctx), 0);
});

// ── desktop Front Office v2 ──
test("DESKTOP Front Office: an unpriced row is 'unavailable' (NaN, never $0) and sorts LAST by Drop Penalty in both directions", () => {
  const { hooks } = loadFrontOfficeV2(undefined, { hooks: ["dropPenaltyEstimate", "applySort"] });
  hooks.STATE.capPenaltyFeed = "ok"; hooks.STATE.capPenaltyByPid = ROWS;
  const fo = (id, k) => ({ id, name: "P" + id, salary: k * 1000, years: 1, type: "Vet-WW", special: `CL 1| TCV ${k}K| AAV ${k}K` });
  const players = [fo("16601", 11), fo("17752", 6), fo("15000", 8), fo("17207", 1)];
  const d = hooks.dropPenaltyEstimate(players[0]);
  t.equal(d.earnedState, "unavailable"); t.ok(Number.isNaN(d.amount), "not a number — the cell shows the unavailable mark");
  for (const dir of [1, -1]) {   // the Front Office keeps the direction as 1 / -1
    hooks.STATE.sort = { key: "drop_pen", dir };
    const order = hooks.applySort(players).map((p) => p.id);
    t.deepEqual(order.slice(2).sort(), ["15000", "16601"], (dir > 0 ? "asc" : "desc") + ": unpriced last");
    t.deepEqual(order.slice(0, 2), dir > 0 ? ["17207", "17752"] : ["17752", "17207"]);
  }
  t.match(read("site/rosters/v2/front_office.js"), /: drop\.earnedState === "pending" \? loadingCell\s*: unavailableCell;/, "the Drop Pen cell renders unavailable, not an amount");
});

// ── legacy desktop Roster Workbench ──
test("DESKTOP Roster Workbench: unpriced → 'under review' in the table cell, modal, chip and drop confirmation; sorts LAST both ways", () => {
  const { hooks } = loadRosterWorkbench(undefined, {
    hooks: ["dropPenaltyEstimate", "capPenaltyAmountForPlayer", "capPenaltyCellText", "capPenaltyMetricText", "dropConfirmPenaltyText",
            "playerAttentionProfile", "sortPlayersForRoster"],
    raw: "__setCapCache: function (c) { __capPenaltyCache = c; }, __state: state",
  });
  hooks.__setCapCache(ROWS);
  const rw = (id, k) => ({ id, fid: "0008", name: "P" + id, salary: k * 1000, years: 1, type: "Vet-WW", special: `CL 1| TCV ${k}K| AAV ${k}K`, positionGroup: "WR" });
  const u = rw("16601", 11);
  const est = hooks.dropPenaltyEstimate(u);
  t.equal(est.unpriced, true); t.ok(Number.isNaN(est.amount));
  t.ok(Number.isNaN(hooks.capPenaltyAmountForPlayer(u)), "the column's amount is NaN, not 0");
  t.equal(hooks.capPenaltyCellText(hooks.capPenaltyAmountForPlayer(u)), "under review");
  t.equal(hooks.capPenaltyCellText(hooks.capPenaltyAmountForPlayer(rw("17752", 6))), "4.5K");
  t.equal(hooks.capPenaltyMetricText(est), "Under review");
  t.match(hooks.dropConfirmPenaltyText(est), /Cap penalty: under review — not yet priced\. It is NOT \$0\./);
  t.doesNotMatch(hooks.dropConfirmPenaltyText(est), /Estimated cap penalty/, "no amount is quoted for an unpriced drop");
  t.match(hooks.dropConfirmPenaltyText(hooks.dropPenaltyEstimate(rw("17752", 6))), /Estimated cap penalty: \$4,500/);
  const prof = hooks.playerAttentionProfile(u);
  t.ok(prof.items.some((i) => i.key === "penalty_unpriced" && i.label === "Penalty under review"));
  t.equal(prof.highPenalty, false);
  const players = [rw("16601", 11), rw("17752", 6), rw("15000", 8), rw("17207", 1)];
  for (const dir of ["asc", "desc"]) {
    hooks.__state.sorts.roster = { key: "penalty", dir };
    const order = hooks.sortPlayersForRoster(players).map((p) => p.id);
    t.deepEqual(order.slice(2).sort(), ["15000", "16601"], dir + ": unpriced last");
    t.deepEqual(order.slice(0, 2), dir === "asc" ? ["17207", "17752"] : ["17752", "17207"]);
  }
  const src = read("site/rosters/roster_workbench.js");
  t.match(src, /: \(Number\.isFinite\(capPenalty\) \? escapeHtml\(capPenaltyCellText\(capPenalty\)\)\s*: '<span class="rwb-pending-cell" title="The worker could not price this drop yet — it is not \$0\.">under review<\/span>'\)\)/,
    "the table cell");
  t.match(src, /escapeHtml\(Number\.isFinite\(proj\[1\]\) \? money\(proj\[1\]\) : "Under review"\)/, "the cap-plan drop preview's penalty slot");
});

await run("drop_unpriced_displays");
