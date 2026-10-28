// Front Office → Draft picks and Activity (#1338): who holds each pick (MFL futureDraftPicks), and MFL's transaction
// log read the right way round (IR deactivated = placed ON IR; taxi promoted = called up; waiver add|bid|drop), merged
// with the UPS contract log (Keith 2026-10-28): team and type filters, Eastern day + time, source labels, no test rows.
//   node tests/front_office_picks_activity.test.mjs
//   FO_ACTIVITY_JS=<path> node tests/front_office_picks_activity.test.mjs   (defect check against another copy)
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { t, test, run } from "./fixtures/mini_test.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = fs.readFileSync(process.env.FO_ACTIVITY_JS || path.join(ROOT, "site/rosters/v2/fo_activity.js"), "utf8");
const FX = JSON.parse(fs.readFileSync(path.join(ROOT, "tests/fixtures/fo_picks_activity_2026.json"), "utf8"));
const ctx = vm.createContext({ document: { addEventListener() {} } });
ctx.window = ctx;
const names = { "15484": "Smith, A", "14842": "Jones, B", "16601": "Shipley, Will", "17586": "Taxi, Rookie", "17044": "One, Player", "17075": "Two, Player" };
ctx.UPS_FO_HUB = {
  pad4: (v) => { const d = String(v || "").replace(/\D/g, ""); return d ? ("0000" + d).slice(-4) : ""; },
  asArray: (x) => (x == null ? [] : Array.isArray(x) ? x : [x]), esc: (s) => String(s), teamName: (f) => "T" + f,
  displayName: (n) => { const i = String(n).indexOf(","); return i > 0 ? n.slice(i + 1).trim() + " " + n.slice(0, i) : n; },
  playerIndex: () => Object.fromEntries(Object.entries(names).map(([k, v]) => [k, { name: v, pos: "WR", team: "X" }])),
  registerView() {}, dayLabel: () => "d",
};
vm.runInContext(SRC, ctx);
const A = ctx.UPS_FO_ACTIVITY;
vm.runInContext("UPS_FO_HUB_ref = window.UPS_FO_HUB", ctx);

test("pick holders: whose pick (original team) → who holds it now, exactly as MFL lists it", () => {
  const h = A.holders(FX.futureDraftPicks);
  t.equal(h["2027"]["0008"]["1"], "0006", "Real Deal Creel's 2027 R1 is held by The Long Haulers");
  t.equal(h["2027"]["0005"]["1"], "0008", "HammerTime's 2027 R1 is held by Real Deal Creel");
  t.equal(JSON.stringify(A.roundsOf(h["2027"])), JSON.stringify(["1", "2", "3", "4", "5"]),
    "the grid's columns are the rounds MFL lists: no empty Round 6 column (MFL keeps no untradeable R6 picks)");
  t.equal(h["2027"]["0008"]["2"], "0008", "R2 still Real Deal Creel's own");
  let n = 0; for (const o of Object.values(h["2027"])) n += Object.keys(o).length;
  t.ok(n >= 55, n + " picks placed");
});

// The view's pure helpers need H; give them the stub directly.
const src2 = SRC.replace(/var H, FO, DATA;/, "var H = window.UPS_FO_HUB, FO, DATA;");
const c2 = vm.createContext({ document: { addEventListener() {} } }); c2.window = c2; c2.UPS_FO_HUB = ctx.UPS_FO_HUB;
vm.runInContext(src2, c2);
const AC = c2.UPS_FO_ACTIVITY;
const pidx = ctx.UPS_FO_HUB.playerIndex();
const nm = (id) => (pidx[id] ? ctx.UPS_FO_HUB.displayName(pidx[id].name) : /^FP_/.test(id) ? id.replace(/^FP_(\d{4})_(\d{4})_(\d)$/, (_, f, y, r) => y + " R" + r + " (T" + f + ")") : id);
const tn = (f) => "T" + f;
const ACT_FX = JSON.parse(fs.readFileSync(path.join(ROOT, "site/rosters/contract_submissions/contract_activity_2026.json"), "utf8"));
const TEST_FX = JSON.parse(fs.readFileSync(path.join(ROOT, "site/rosters/contract_submissions/contract_log_test_2026.json"), "utf8"));
const PHANTOM_FX = JSON.parse(fs.readFileSync(path.join(ROOT, "site/rosters/contract_submissions/contract_log_phantom_2026.json"), "utf8"));
const FIX_FX = JSON.parse(fs.readFileSync(path.join(ROOT, "site/rosters/contract_submissions/contract_activity_corrections_2026.json"), "utf8"));

test("transactions read the right way round", () => {
  const lines = AC.mflRows(FX.transactions, nm, tn).map((l) => l.html);
  const ir = lines.find((l) => /14842|Jones/.test(l));
  t.ok(ir && /placed B Jones on IR/.test(ir), "deactivated = placed on IR: " + ir);
  const act = lines.find((l) => /A Smith/.test(l));
  t.ok(act && /activated A Smith from IR/.test(act), "activated = back from IR: " + act);
  const taxi = lines.find((l) => /Rookie Taxi/.test(l));
  t.ok(taxi && /promoted Rookie Taxi from the taxi squad/.test(taxi), taxi);
  const trade = lines.find((l) => /Trade/.test(l));
  t.ok(trade && /T0003 gave .*2027 R1/.test(trade) && /T0010 gave Player One, Player Two/.test(trade), trade);
  const bb = lines.find((l) => /on waivers/.test(l));
  t.ok(bb && /\(\$1,000\) on waivers; dropped/.test(bb), "waiver add with bid and drop: " + bb);
});

test("Eastern day and time on every row: 'Tue Oct 27, 9:14 PM ET' from the row's own timestamp", () => {
  t.equal(AC.fmtEt(Date.parse("2026-10-28T01:14:00Z")), "Tue Oct 27, 9:14 PM ET", "EDT: 01:14 UTC is 9:14 PM the evening before");
  t.equal(AC.fmtEt(Date.parse("2026-01-06T14:05:00Z")), "Tue Jan 6, 9:05 AM ET", "EST in winter (UTC-5)");
  t.equal(AC.fmtEt(Date.parse("2026-10-27T16:00:00Z")), "Tue Oct 27, 12:00 PM ET", "noon");
  t.equal(AC.fmtEt(0), "", "no time, no invented time");
  const rows = AC.mergeRows(AC.mflRows(FX.transactions, nm, tn), AC.contractRows(ACT_FX, TEST_FX, nm, tn, PHANTOM_FX));
  t.ok(rows.length > 50 && rows.every((r) => / \d{1,2}, \d{1,2}:\d\d (AM|PM) ET$/.test(AC.fmtEt(r.ts))), rows.length + " rows, every one dated");
  for (let i = 1; i < rows.length; i += 1) if (rows[i].ts > rows[i - 1].ts) { t.ok(false, "newest first at row " + i); break; }
});

test("team filter: one team keeps its own rows and both sides of its trades; All teams keeps everything", () => {
  const rows = AC.mflRows(FX.transactions, nm, tn);
  const all = AC.filterRows(rows, "", "");
  t.equal(all.length, rows.length, "All teams");
  const t10 = AC.filterRows(rows, "0010", "");
  t.ok(t10.length > 0 && t10.length < rows.length && t10.every((r) => r.fids.includes("0010")), "one team narrows");
  t.ok(t10.some((r) => r.kinds.includes("trade")) && AC.filterRows(rows, "0003", "trade").length === 1, "a trade shows for BOTH teams in it");
});

test("type filter: choices come from the data, grouped by source, plain labels; picking one narrows the rows", () => {
  const mfl = AC.mflRows(FX.transactions, nm, tn), ups = AC.contractRows(ACT_FX, TEST_FX, nm, tn);
  const rows = AC.mergeRows(mfl, ups);
  const groups = AC.typeOptions(rows, rows);
  t.equal(JSON.stringify(groups.map((g) => g.label)), JSON.stringify(["MFL transaction", "Contract log (UPS)"]));
  const keys = groups.flatMap((g) => g.options.map((o) => o.key));
  t.ok(keys.includes("src:mfl") && keys.includes("src:ups") && keys.includes("trade") && keys.includes("ir") && keys.includes("taxi") && keys.includes("drop"), keys.join(","));
  t.ok(keys.includes("c:Extension") && keys.includes("c:Multi-Year Contract") && keys.includes("c:Tag"), "contract-log types from the log itself");
  const labels = groups.flatMap((g) => g.options.map((o) => o.label));
  t.ok(labels.includes("Extensions") && labels.includes("Multi-year contracts (MYAC)") && labels.includes("Trades") && labels.includes("IR moves"), labels.join(" | "));
  const noAuction = AC.typeOptions(mfl.filter((r) => !r.kinds.includes("auction")), null);
  t.ok(!noAuction[0].options.some((o) => o.key === "auction") && noAuction.length === 1, "a type absent from the data is not offered; no contract group without contract rows");
  const ir = AC.filterRows(rows, "", "ir");
  t.ok(ir.length > 0 && ir.length < rows.length && ir.every((r) => r.kinds.includes("ir")), "IR narrows");
  const onlyUps = AC.filterRows(rows, "", "src:ups");
  t.ok(onlyUps.length === ups.length && onlyUps.every((r) => r.src.includes("ups")), "All contract log = every contract-log row");
  const ext = groups[1].options.find((o) => o.key === "c:Extension");
  t.equal(ext.n, AC.filterRows(rows, "", "c:Extension").length, "the count beside a choice is the rows it shows");
});

test("contract log: source label, no test events (log flag and the Contract log's test-franchise cutoff)", () => {
  const ups = AC.contractRows(ACT_FX, TEST_FX, nm, tn);
  const real = ACT_FX.activities.filter((a) => Number(a.test_flag) !== 1 && !(a.franchise_id === "0008" && a.submitted_at_utc < "2026-06-06T00:00:00Z"));
  t.equal(ups.reduce((n, r) => n + r.repeats, 0), real.length, real.length + " non-test contract-log submissions, every one counted (" + ups.length + " rows after repeats)");
  t.ok(ups.every((r) => r.src.length === 1 && r.src[0] === "ups"), "every contract-log row says where it came from");
  t.ok(!ups.some((r) => r.fids[0] === "0008" && r.ts < Date.parse("2026-06-06T00:00:00Z")), "Real Deal Creel's pre-June test events stay hidden");
  const coker = ups.find((r) => /Jalen Coker/.test(r.html));
  t.ok(coker && /<b>T0001<\/b> Extension: Jalen Coker/.test(coker.html) && /CL 2\|TCV 12K/.test(coker.html), coker && coker.html);
  t.ok(!ups.some((r) => /discord|1059113303059730494/i.test(r.html)), "no Discord ids or notes in a row");
  const fresh = { activities: [{ franchise_id: "0002", player_id: "1", player_name: "Doe, Jane", activity_type: "Brand New", submitted_at_utc: "2026-09-01T12:00:00Z", test_flag: 0 }] };
  const r = AC.contractRows(fresh, { test_franchises: [] }, nm, tn)[0];
  t.ok(r.kinds[0] === "c:Brand New" && /Brand New: Jane Doe/.test(r.html), "a type the log adds later shows under its own name");
});

test("phantom rows (contract_log_phantom_2026.json) never show; a later real contract for the same player still does", () => {
  const without = AC.contractRows(ACT_FX, TEST_FX, nm, tn), withP = AC.contractRows(ACT_FX, TEST_FX, nm, tn, PHANTOM_FX);
  t.equal(PHANTOM_FX.rows.length, 5, "the declared list: Burrow, Allen, Moehrig, Landry, Mahomes");
  const hits = (rows, fid, pid, day) => rows.filter((r) => r.fids[0] === fid && r.pids[0] === pid && new Date(r.ts).toISOString().slice(0, 10) === day).length;
  for (const p of PHANTOM_FX.rows) {
    t.ok(hits(without, p.franchise_id, p.player_id, p.submitted_on) >= 1, p.player_name + " is in the log");
    t.equal(hits(withP, p.franchise_id, p.player_id, p.submitted_on), 0, p.player_name + " (" + p.claimed + ") is hidden");
  }
  t.ok(!withP.some((r) => r.fids[0] === "0012" && /Mahomes/.test(r.html)), "the Hawks' Mahomes tag (both submissions) is gone");
  t.ok(withP.some((r) => r.fids[0] === "0001" && r.pids[0] === "15365" && /Multi-year contract \(MYAC\)/.test(r.html)), "Moehrig's real September MYAC still shows");
  t.equal(without.length - withP.length, 5, "exactly the phantom rows are removed (Mahomes' two submissions were already one row)");
});

test("exact repeats show once (same team, player, type, terms, within 30 minutes); different terms never collapse", () => {
  const ups = AC.contractRows(ACT_FX, TEST_FX, nm, tn, PHANTOM_FX);
  const cmc = ups.filter((r) => r.fids[0] === "0007" && r.pids[0] === "13130" && r.kinds[0] === "c:Tag");
  t.ok(cmc.length === 1 && cmc[0].repeats === 4 && /Logged 4 times with the same terms; shown once\./.test(cmc[0].html), "McCaffrey's tag: 4 submissions in 15 minutes = one row (" + cmc.length + ")");
  t.equal(cmc[0].ts, Date.parse("2026-05-19T18:33:53.563Z"), "the row keeps the first submission's time");
  // Chris Rodriguez (Real Deal Creel's June test window, read here without the cutoff): MYAC 1 yr 13:49, 2 yr 13:54, 2 yr 20:54, 1 yr 20:54.
  const cr = AC.contractRows(ACT_FX, { test_franchises: [] }, nm, tn, PHANTOM_FX).filter((r) => r.fids[0] === "0008" && r.pids[0] === "16174" && r.kinds[0] === "c:Multi-Year Contract");
  t.equal(cr.length, 4, "1 yr / 2 yr / 2 yr (7 hours later) / 1 yr: terms change in between or the window has passed, so all four stay");
  const nac = ups.filter((r) => r.pids[0] === "16211" && r.kinds[0] === "c:Restructure");
  t.equal(nac.length, 2, "Puka Nacua: two restructures with different year splits stay two rows");
  const base = { franchise_id: "0002", player_id: "9", player_name: "Doe, Jane", activity_type: "Extension", contract_status: "Vet-Ext2", salary: 10000, contract_year: 3, tcv: 60000, aav: 20000, guaranteed: 45000, contract_info: "CL 3| TCV 60K| AAV 20K| Y1-10K, Y2-20K, Y3-30K", test_flag: 0 };
  const at = (min, extra) => Object.assign({}, base, { submitted_at_utc: new Date(Date.parse("2026-09-01T12:00:00Z") + min * 60000).toISOString() }, extra || {});
  const run = (list) => AC.contractRows({ activities: list }, { test_franchises: [] }, nm, tn, { rows: [] });
  t.equal(run([at(0), at(10), at(29)]).length, 1, "three identical within 30 minutes of the first = 1 row");
  t.equal(run([at(0), at(31)]).length, 2, "31 minutes later = a new submission");
  t.equal(run([at(0), at(5, { contract_info: "CL 3| TCV 60K| AAV 20K| Y1-10K, Y2-30K, Y3-20K" })]).length, 2, "same totals, different year split = different terms");
  t.equal(run([at(0), at(5, { salary: 11000 })]).length, 2, "different salary = different terms");
  t.equal(run([at(0), at(5, { franchise_id: "0003" })]).length, 2, "another team = another row");
  t.equal(run([at(0), at(5, { activity_type: "Restructure" })]).length, 2, "another action = another row");
  t.equal(AC.termsKey({ activity_type: "Tag", contract_status: "TAG", salary: 62000, contract_year: 1, tcv: 62000, aav: 62000, guaranteed: 62000, contract_info: "CL 1| TCV 62K| GTD 62K| Tag" }),
    AC.termsKey({ activity_type: "Tag", contract_status: "TAG", salary: 62000, contract_year: 1, tcv: 62000, aav: 62000, guaranteed: 62000, contract_info: "CL 1|TCV 62K|Y1-62K|GTD: 62K|TAG (Off) T1" }), "a one-year contract's unwritten split is its one year");
});

test("reviewed label corrections: Jaxon Smith-Njigba's real 07-27 change reads 'Contract change (logged as FA Contract)'", () => {
  // The log row has no player_name: the page names him from MFL's players export (stubbed here).
  const nmJ = (id) => (id === "16185" ? "Jaxon Smith-Njigba" : nm(id));
  const plain = AC.contractRows(ACT_FX, TEST_FX, nmJ, tn, PHANTOM_FX), fixed = AC.contractRows(ACT_FX, TEST_FX, nmJ, tn, PHANTOM_FX, FIX_FX);
  const isJsn = (r) => r.fids[0] === "0009" && r.pids[0] === "16185";
  t.ok(plain.filter(isJsn).length === 1 && /FA contract: Jaxon Smith-Njigba/.test(plain.find(isJsn).html), "without the list: the log's own label");
  const r = fixed.filter(isJsn);
  t.ok(r.length === 1 && /<b>T0009<\/b> Contract change \(logged as FA Contract\): Jaxon Smith-Njigba/.test(r[0].html), r[0] && r[0].html);
  t.equal(r[0].kinds.join(), "c:Contract Change", "filed under Contract changes in the type filter");
  t.ok(/Y1-14K, Y2-1K, Y3-55K/.test(r[0].html) && r[0].ts === Date.parse("2026-07-28T02:51:06.321Z"), "terms and time unchanged");
  t.equal(fixed.length, plain.length, "a correction relabels; it never hides or adds a row");
  t.equal(fixed.filter((x) => x.kinds[0] === "c:FA Contract").length, 0, "no FA contract row is left in 2026, so the filter stops offering FA contracts");
  const labels = AC.typeOptions(fixed, fixed).flatMap((g) => g.options.map((o) => o.label));
  t.ok(labels.includes("Contract changes") && !labels.includes("FA contracts"), labels.join(" | "));
  // Only an exact id + team + player match is corrected.
  const one = (over) => AC.contractRows({ activities: [Object.assign({ activity_id: "abc", franchise_id: "0002", player_id: "9", player_name: "Doe, Jane", activity_type: "FA Contract", submitted_at_utc: "2026-09-01T12:00:00Z", test_flag: 0 }, over || {})] },
    { test_franchises: [] }, nm, tn, { rows: [] }, { rows: [{ activity_id: "abc", franchise_id: "0002", player_id: "9", activity_type: "Contract Change", label: "Contract change (logged as FA Contract)" }] })[0];
  t.ok(/Contract change \(logged as FA Contract\)/.test(one().html), "exact match: corrected");
  t.ok(/FA contract: Jane Doe/.test(one({ franchise_id: "0003" }).html) && /FA contract: Jane Doe/.test(one({ player_id: "10" }).html) && /FA contract: Jane Doe/.test(one({ activity_id: "abd" }).html), "any mismatch: left as logged");
  t.ok(FIX_FX.rows.every((x) => x.evidence && x.ruling && x.logged_as && x.activity_type && x.label), "every correction carries its evidence and ruling");
});

test("no 'not confirmed in MFL' label: MFL's transaction log does not record contract changes, so absence there proves nothing", () => {
  t.ok(!/not confirmed in MFL/i.test(SRC), "the label is never claimed");
  t.ok(/SRC_LABEL = \{ mfl: "MFL transaction", ups: "Contract log \(UPS\)" \}/.test(SRC), "the plain source labels");
});

test("one event in both logs shows once, with both source labels; different events never merge", () => {
  const ts = 1790000000;
  const mfl = AC.mflRows({ transactions: { transaction: [
    { type: "FREE_AGENT", franchise: "0004", timestamp: String(ts), transaction: "16601,|" },
    { type: "FREE_AGENT", franchise: "0005", timestamp: String(ts), transaction: "17044,|" },
  ] } }, nm, tn);
  const act = { activities: [
    { franchise_id: "0004", player_id: "16601", player_name: "Shipley, Will", activity_type: "FA Contract", submitted_at_utc: new Date(ts * 1000 + 30000).toISOString(), contract_info: "CL 1| TCV 1K", test_flag: 0 },
    { franchise_id: "0005", player_id: "17044", activity_type: "Extension", submitted_at_utc: new Date(ts * 1000 + 3 * 3600000).toISOString(), test_flag: 0 },
    { franchise_id: "0006", player_id: "16601", activity_type: "Tag", submitted_at_utc: new Date(ts * 1000).toISOString(), test_flag: 0 },
  ] };
  const rows = AC.mergeRows(mfl, AC.contractRows(act, { test_franchises: [] }, nm, tn));
  t.equal(rows.length, 4, "the matching pair is one row; the 3-hour-later extension and the other team's tag stay separate");
  // Tyquan Thornton, 2026-10-15: placed on IR, then an MYM 2 minutes later. Two real events: never merged.
  const ir = AC.mflRows({ transactions: { transaction: [{ type: "IR", franchise: "0009", timestamp: String(ts), deactivated: "16601,", activated: "" }] } }, nm, tn);
  const mym = AC.contractRows({ activities: [{ franchise_id: "0009", player_id: "16601", activity_type: "MYM", submitted_at_utc: new Date(ts * 1000 + 110000).toISOString(), test_flag: 0 }] }, { test_franchises: [] }, nm, tn);
  t.equal(AC.mergeRows(ir, mym).length, 2, "an IR move and an MYM minutes apart are two rows");
  const real = AC.mergeRows(AC.mflRows(FX.transactions, nm, tn), AC.contractRows(ACT_FX, TEST_FX, nm, tn, PHANTOM_FX));
  t.equal(real.filter((r) => r.src.length === 2).length, 0, "the fixture moves + the 2026 contract log: no event in both logs");
  const both = rows.find((r) => r.src.length === 2);
  t.ok(both && both.src.join() === "mfl,ups" && /added Will Shipley/.test(both.html) && /Contract log: .*FA contract: Will Shipley/.test(both.html), both && both.html);
  t.ok(both.kinds.includes("add") && both.kinds.includes("c:FA Contract"), "the merged row answers both type choices");
  t.equal(mfl[0].src.join(), "mfl", "merging never changes its inputs");
});

test("owner trade comments never render (privacy)", () => {
  const tx = { transactions: { transaction: [{ type: "TRADE", franchise: "0003", franchise2: "0010", timestamp: "1791320240", comments: "SECRET owner note", franchise1_gave_up: "15484,", franchise2_gave_up: "14842," }] } };
  const html = AC.mflRows(tx, nm, tn).map((r) => r.html).join("");
  t.ok(/T0003 gave A Smith; T0010 gave B Jones/.test(html) && !/SECRET/.test(html), html);
  t.ok(!/\.comments\b|\["comments"\]/.test(SRC), "the view never reads a comments field");
});

test("Activity: the season only, team default = the viewer, the contract log is a static file (0 D1 rows)", () => {
  t.ok(/if \(moves\.team == null\) moves\.team = me;/.test(SRC), "first visit: my team");
  t.ok(/opt\("", "All teams", !moves\.team\)/.test(SRC), "All teams available");
  t.ok(/<select data-mv-year>' \+ opt\(season, season, true\) \+ "<\/select>/.test(SRC) && /Earlier seasons appear here after their transaction and contract records are checked\./.test(SRC), "one season, with the note");
  const DATA_SRC = fs.readFileSync(path.join(ROOT, "site/rosters/v2/fo_data.js"), "utf8");
  t.ok(/contractLog: function \(\)/.test(DATA_SRC) && /staticUrl\("contract_activity_"\)/.test(DATA_SRC) && /staticUrl\("contract_log_test_"\)/.test(DATA_SRC), "the static snapshot + the test list");
  t.ok(/test list unreadable/.test(DATA_SRC), "no test list = a failed read, never 'no test events'");
  t.ok(/staticUrl\("contract_log_phantom_"\)/.test(DATA_SRC) && /phantom list unreadable/.test(DATA_SRC), "the phantom list is in the same read; no phantom list = a failed read");
  t.ok(/contractRows\(cl\.data\.activity, cl\.data\.test, nm, tn, cl\.data\.phantom, cl\.data\.fixes\)/.test(SRC) && /test, phantom or correction lists couldn’t be read, so no contract-log rows are listed/.test(SRC), "the view applies them and says so when it can't");
  t.ok(/staticUrl\("contract_activity_corrections_"\)/.test(DATA_SRC) && /correction list unreadable/.test(DATA_SRC), "the correction list is in the same read; unreadable = a failed read");
});

test("Activity only reads; claims are checked against the waiver resolver and edited in the app", () => {
  t.ok(!/fetch\(|method:\s*"POST"/.test(SRC));
  t.ok(/MFL will refuse this claim at the next run/.test(SRC) && /BLOCKING\[st\.code\]/.test(SRC));
  t.ok(/Claims are edited in the phone app/.test(SRC));
  t.ok(/known !== true/.test(SRC), "an unknown read is never 'no claims'");
});

await run("front_office_picks_activity");
