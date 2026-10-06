// A commissioner ruling CLOSES a cap-free special case — and the published
// report says so in the ruling's own words, never "pending commissioner review".
//   node tests/salary_adjustments_commissioner_ruling.test.mjs
//
// Keith 2026-10-06, on Amari Cooper's 2025 retirement (Gride, a loaded contract
// whose canon §D2a settlement was never assessed): "flag it in the system … I
// don't want to be questioned on it". The ruling lives on the special case
// (pipelines/etl/inputs/salary_adjustments_special_cases.json); the generator
// (build_salary_adjustments_report.py) turns it into status "resolved"; the
// committed 2026 report row and canon §D2a carry the same words.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { t, test, run } from "./fixtures/mini_test.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const SC = JSON.parse(read("pipelines/etl/inputs/salary_adjustments_special_cases.json")).rows;
const REPORT = JSON.parse(read("site/reports/salary_adjustments/salary_adjustments_2026.json"));
const MANIFEST = JSON.parse(read("site/reports/salary_adjustments/salary_adjustments_manifest.json"));
const GEN = read("pipelines/etl/scripts/build_salary_adjustments_report.py");
const CANON = read("docs/league_context_v1.md");
const UI = read("site/reports/salary_adjustments/salary_adjustments.js");

const cooperCase = SC.find((r) => r.player_id === "12175");
const cooperRow = REPORT.rows.find((r) => r.source_id === "adddrop2025_176.1");

test("the special case carries the ruling", () => {
  t.ok(cooperCase, "Cooper's special case");
  t.equal(cooperCase.exemption_type, "retired");
  t.equal(cooperCase.ruled_at, "2026-10-06");
  t.match(cooperCase.commissioner_ruling, /^Closed\. .*no §D2a loaded-contract settlement is assessed/);
  t.match(cooperCase.commissioner_ruling, /§D2a continues to apply to future retirements\.$/, "closes this case only");
});

test("the generator reads it (real loader, real file) and resolves the row", () => {
  const py = `import importlib.util, json, sys
sys.path.insert(0, ${JSON.stringify(path.join(ROOT, "pipelines/etl/scripts"))})
spec = importlib.util.spec_from_file_location("g", ${JSON.stringify(path.join(ROOT, "pipelines/etl/scripts/build_salary_adjustments_report.py"))})
g = importlib.util.module_from_spec(spec); spec.loader.exec_module(g)
rows, _ = g.load_salary_adjustments_special_cases(${JSON.stringify(path.join(ROOT, "pipelines/etl/inputs/salary_adjustments_special_cases.json"))})
print(json.dumps({"rows": rows, "order": g.STATUS_ORDER}))`;
  const out = JSON.parse(execFileSync("python3", ["-c", py], { encoding: "utf8" }));
  const r = out.rows.find((x) => x.player_id === "12175");
  t.equal(r.commissioner_ruling, cooperCase.commissioner_ruling);
  t.equal(r.ruled_at, "2026-10-06");
  t.ok("resolved" in out.order, "resolved is a known status");
  t.match(GEN, /if cap_free_exemption_flag and commissioner_ruling:\n\s+status = "resolved"\n\s+reconciliation_status = "commissioner_ruled"/);
  t.match(GEN, /description_parts\.append\(f"Commissioner ruling \{ruled_at\}: \{commissioner_ruling\}"\)/);
});

test("the published 2026 report row is resolved, in the ruling's words, and still never importable", () => {
  t.equal(cooperRow.status, "resolved");
  t.equal(cooperRow.direction, "resolved");
  t.equal(cooperRow.reconciliation_status, "commissioner_ruled");
  t.equal(cooperRow.reconciliation_note, `Commissioner ruling 2026-10-06: ${cooperCase.commissioner_ruling}`);
  t.ok(cooperRow.description.endsWith(`Commissioner ruling 2026-10-06: ${cooperCase.commissioner_ruling}`));
  t.ok(!/pending commissioner review/i.test(JSON.stringify(cooperRow)), "no 'pending review' text left");
  t.equal(cooperRow.amount, 0); t.equal(cooperRow.import_eligible, false);
  t.equal(REPORT.meta.review_required_count, 0); t.equal(REPORT.meta.resolved_count, 1);
  const m26 = MANIFEST.seasons.find((s) => s.season === 2026);
  t.equal(m26.review_required_count, 0); t.equal(m26.resolved_count, 1);
  t.ok(MANIFEST.meta.status_values.includes("resolved"));
  t.match(UI, /if \(value === "resolved"\) return "Resolved";/, "the report page labels it");
});

test("canon records the Cooper ruling, the legacy holdout credits and the 2020 COVID opt-outs", () => {
  t.match(CANON, /\*\*2020 COVID opt-outs were FULLY relieved — correct as posted \(Keith 2026-10-06\)\.\*\* .*Marqise Lee, Run CMC \(0005\) and Geronimo Allison, #BLM \(0008\).*credited −\$4,500 each/);
  t.match(CANON, /\*\*Commissioner ruling — Amari Cooper, Gride, retired 2025 \(Keith 2026-10-06\): CLOSED\.\*\*/);
  t.match(CANON, /It is \*\*not\*\* a precedent: §D2a applies to every future retirement or Jail Bird exit on a loaded contract\./);
  t.match(CANON, /Legacy holdout credits are correct as posted \(Keith 2026-10-06\)\.\*\* .*Le'Veon Bell, Gride 2018 \(−\$12,000 = 25% × \$48K\) and Chris Jones, Blake Bombers 2023 \(−\$500 = 25% × \$2K\)/);
});

test("the cap-adjustment audit log: well-formed, and the trade rulings are recorded as made", () => {
  const LOG = JSON.parse(read("pipelines/etl/inputs/cap_adjustment_audit_log.json"));
  const ids = LOG.entries.map((e) => e.id);
  t.equal(new Set(ids).size, ids.length, "ids are unique");
  t.ok(LOG.entries.every((e) => e.status in LOG.status_legend), "every status is in the legend");
  t.ok(LOG.entries.every((e) => e.status === "open" ? e.ruling === null : !!(e.ruling && e.ruling.at && e.ruling.text)), "ruled entries carry their ruling; open ones none");
  const trades = LOG.entries.filter((e) => e.category === "traded_salary_not_settled");
  t.equal(trades.map((e) => e.id).join(), "A01,A02,A03,A04,A05,A06");
  t.ok(trades.every((e) => e.should_have_posted.reduce((a, r) => a + r.amount, 0) === 0), "each settlement nets to zero");
  const pre2026 = trades.filter((e) => e.cap_season < 2026);
  t.equal(pre2026.length, 5);
  t.ok(pre2026.every((e) => e.status === "missed_recorded" && e.mfl_action === "none"), "2025 and before: recorded, MFL unchanged");
  t.ok(pre2026.every((e) => /2025 and before was all manual/.test(e.ruling.text)));
  const a01 = LOG.entries.find((e) => e.id === "A01");
  t.equal(a01.status, "partially_posted");
  t.match(a01.mfl_action, /Gride -\$10,000 posted 2026-10-06 \(2026 salaryAdjustment id 61/);
  t.match(a01.mfl_action, /L\.A\. Looks \+\$10,000 PENDING/);
  t.equal(LOG.entries.find((e) => e.id === "R01").status, "closed", "Cooper closed");
  t.equal(LOG.entries.filter((e) => e.status === "open").length, 0, "every audit item is ruled");
  for (const id of ["A11", "A12"]) {
    const e = LOG.entries.find((x) => x.id === id);
    t.equal(e.status, "missed_recorded", id); t.equal(e.mfl_action, "none", id + ": recorded only");
    t.match(e.ruling.text, /^Just record them\./);
  }
  // A12's figures re-add each drop to the team's JULY sum and round once (Keith: "we don't round individual penalties")
  const rhu = (x) => Math.floor((x + 500) / 1000) * 1000;
  for (const d of LOG.entries.find((x) => x.id === "A12").detail.drops) {
    t.equal(d.july_sum_corrected, d.july_sum_posted + d.amount, d.player);
    t.equal(d.rounded_total_corrected, rhu(d.july_sum_corrected), d.player + " rounds once, on the sum");
    t.equal(d.net_change, d.rounded_total_corrected - d.rounded_total_posted, d.player);
  }
  t.ok(LOG.entries.filter((e) => e.cap_season != null && e.cap_season < 2026).every((e) => e.mfl_action === "none"), "nothing pre-2026 touches MFL");
  t.match(CANON, /A missed settlement in a pre-2026 season is recorded, not corrected \(Keith 2026-10-06\)\.\*\* .*cap_adjustment_audit_log\.json/);
});

await run("salary_adjustments_commissioner_ruling");
