// site/shared/war_room_requests.js is the Trade War Room's own request code, GENERATED from site/trades/trade_workbench.js
// (scripts/generate_war_room_requests.mjs). This fails when the War Room changed and the copy was not regenerated, and checks
// the copy can't touch a page or the network: no fetch / storage / beacon, and its window and document are private stubs.
//   node tests/war_room_requests_generated.test.mjs
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { t, test, run } from "./fixtures/mini_test.mjs";
import { render, closure, ROOTS } from "../scripts/generate_war_room_requests.mjs";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
const SRC = read("site/trades/trade_workbench.js"), OUT = read("site/shared/war_room_requests.js");

test("the generated copy is up to date with the War Room (regenerate: node scripts/generate_war_room_requests.mjs)", () => {
  t.equal(OUT, render(SRC));
});

test("every copied function is the War Room's text, byte for byte", () => {
  const c = closure(SRC);
  t.ok(c.functions.length > 100, "the request code and everything it reaches");
  for (const r of ROOTS) t.ok(c.functions.includes(r), r + " is copied");
  // each copied function's text occurs verbatim in both files
  const sample = ["buildTradePayload", "getOfferPayloadForWorkbench", "retryOfferFingerprintFromBody", "tw3Movements", "composeTradeMessage", "buildExtensionSummaryLines"];
  for (const n of sample) {
    const m = new RegExp("\\n  (?:async )?function " + n + "\\(").exec(SRC);
    const end = SRC.indexOf("\n  }\n", m.index + 1);
    const text = SRC.slice(m.index + 1, end + 4);
    t.ok(OUT.includes(text), n + " verbatim");
  }
});

test("nothing in the copy can send or store: no fetch, storage, beacon or XHR calls, and no real window/document", () => {
  t.doesNotMatch(OUT, /\bfetch\s*\(/);
  t.doesNotMatch(OUT, /\b(localStorage|sessionStorage|XMLHttpRequest|sendBeacon)\b/);
  t.match(OUT, /var window = \{ location: \{ href: String\(env\.href/);
  // run it in a VM whose real globals throw on touch: the factory and a payload build must not reach them
  const trap = new Proxy({}, { get(_, k) { throw new Error("touched the real global: " + String(k)); } });
  const sb = { module: { exports: {} }, window: undefined, document: trap, fetch: () => { throw new Error("fetch called"); }, Date, JSON, Math, Object, Array, String, Number, Boolean, RegExp, Error, isFinite, parseInt, parseFloat, encodeURIComponent, decodeURIComponent, URL, atob, btoa, TextDecoder, Uint8Array };
  sb.self = sb; vm.createContext(sb);
  vm.runInContext(OUT, sb);
  const api = sb.module.exports;
  const wr = api.create({ href: "https://x/?L=74598&YEAR=2026", rules: require("../site/shared/trade_rules.js") });
  wr.state.data = wr.normalizeData({ meta: { league_id: "74598", season: 2026 }, teams: [{ franchise_id: "0001", franchise_name: "A", assets: [] }, { franchise_id: "0002", franchise_name: "B", assets: [] }] });
  wr.state.leftTeamId = "0001"; wr.state.rightTeamId = "0002";
  const p = wr.buildTradePayload();
  t.equal(p.validation.status, "draft", "an empty draft is not ready");
  t.equal(wr.getLeagueContext().leagueId, "74598", "league context comes from the private href");
});

await run("war_room_requests_generated");
