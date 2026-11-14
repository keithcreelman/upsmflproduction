// IR players show MFL's expected return date beside the chip (Keith 2026-11-14): site/shared/injury_status.js (backText + roster chip),
// site/shared/player_facts.js (desktop chip), site/m/player_sheet.js (phone chip), Game Day badge.
//   node scripts/safe_tests/run.mjs --only ir_expected_return
import fs from "node:fs";
import vm from "node:vm";
import { t, test, run } from "./fixtures/mini_test.mjs";
const read = (p) => fs.readFileSync(new URL("../" + p, import.meta.url), "utf8");
const load = (file, name) => { const c = vm.createContext({}); c.window = c; vm.runInContext(read(file), c); return c[name]; };
const IS = load("site/shared/injury_status.js", "UPSInjuryStatus");
const F = load("site/shared/player_facts.js", "UPS_PLAYER_FACTS");
const NOW = Date.UTC(2026, 10, 14);

test("MFL's date reads short; free text is kept as written; nothing when MFL has none", () => {
  t.equal(IS.backText("Nov 29, 2026", NOW), "Nov 29");
  t.equal(IS.backText("Jan 3, 2027", NOW), "Jan 3");
  t.equal(IS.backText("November 29, 2026", NOW), "Nov 29");
  t.equal(IS.backText("Week 14", NOW), "Week 14");
  t.equal(IS.backText("", NOW), ""); t.equal(IS.backText(null, NOW), "");
  t.ok(IS.backText("x".repeat(60), NOW).length <= 24);
  t.equal(IS.backText("Nov 13, 2026", NOW), "Nov 13", "yesterday is still shown (whole-day grace)");
  t.equal(IS.backText("Nov 12, 2026", NOW), "", "a date that has passed is hidden, not shown stale");
});
const read1 = (ro) => ({ state: "ok", at: Date.now(), data: { report_feed: { ok: true, current: true, week: 10, teams_mfl: [] }, mfl_feed: { ok: true },
  mapped_mfl_ids: ["1"], players: { 1: { roster: ro } } } });
test("an IR player's chip carries the return; no date, no extra text", () => {
  const withD = IS.resolve(read1({ status: "IR", label: "Injured reserve", chip: "IR", detail: "Knee", exp_return: "Nov 29, 2026" }), "1", "DAL");
  t.equal(withD.chips[0].t, "IR"); t.equal(withD.chips[0].back, "Nov 29");
  t.match(withD.chips[0].title, /expected back Nov 29/); t.ok(withD.lines.some((l) => /expected back Nov 29/.test(l)));
  const none = IS.resolve(read1({ status: "IR", label: "Injured reserve", chip: "IR", detail: null, exp_return: null }), "1", "DAL");
  t.equal(none.chips[0].back, undefined); t.ok(!/expected back/.test(none.chips[0].title));
});
test("desktop chip shows 'back Nov 29' and escapes MFL's text", () => {
  const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const res = IS.resolve(read1({ status: "IR", label: "Injured reserve", chip: "IR", exp_return: "<b>x</b>" }), "1", "DAL");
  const html = F.chipHtml(res, esc, "fo-inj");
  t.match(html, /upf-inj-back/); t.ok(!/<b>x/.test(html), "no raw markup");
  const ok = F.chipHtml(IS.resolve(read1({ status: "IR", label: "Injured reserve", chip: "IR", exp_return: "Nov 29, 2026" }), "1", "DAL"), esc, "fo-inj");
  t.match(ok, /back Nov 29/);
});
test("wired on the phone and Game Day", () => {
  t.match(read("site/m/player_sheet.js"), /function backHtml\(c\)/); t.match(read("site/m/views/lineup.js"), /PS\.backHtml\(res\.chips\[0\]\)/);
  t.match(read("site/gameday/gameday.html"), /gd-inj-back/);
});
await run("ir_expected_return");
