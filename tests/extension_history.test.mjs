// Extension history (worker/src/extension_history.js) — who has already used a pre-trade extension on whom, and the new
// `extension_history_ok` signal on /trade-workbench (Trade Builder dependency: a client must tell "nobody extended him" from "history unavailable").
//   node tests/extension_history.test.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { t, test, run } from "./fixtures/mini_test.mjs";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { summarizeExtensionMaster } = await import("../worker/src/extension_history.js");
const pad = (f) => { const d = String(f || "").replace(/\D/g, ""); return d ? d.padStart(4, "0").slice(-4) : ""; };
const safeInt = (v, d) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : (d == null ? 0 : d); };

// The ORIGINAL inline loop from the /trade-workbench route (before extraction), kept here as the reference the extraction must equal.
function original(rows, season) {
  const player = new Set(), pair = new Set(), cur = safeInt(season, 0);
  for (const row of rows) {
    const pid = String(row?.player_id || "").replace(/\D/g, "");
    const fid = pad(row?.franchise_id || "");
    if (!pid) continue;
    if (String(row?.season) === String(season)) player.add(pid);
    const endYear = safeInt(row?.contract_end_year, 0);
    if (fid && cur > 0 && endYear >= cur) pair.add(fid + "|" + pid);
  }
  return { player, pair };
}
const ROWS = [
  { season: 2026, franchise_id: "10", player_id: "14823", contract_end_year: 2027 },     // Blake's active extension on Rico
  { season: 2025, franchise_id: "0003", player_id: "1111", contract_end_year: 2026 },    // still active this season
  { season: 2023, franchise_id: "0003", player_id: "2222", contract_end_year: 2025 },    // expired: the right resets
  { season: "2026", franchise_id: "0004", player_id: "P_3333", contract_end_year: "2028" }, // id with junk, string numbers
  { season: 2026, franchise_id: "0005", player_id: "", contract_end_year: 2027 },        // no player: ignored
  { season: 2026, franchise_id: "", player_id: "4444", contract_end_year: 2027 },         // no franchise: player set only
  null, undefined, {},
];
test("the extraction is identical to the original inline loop (sets, for several seasons)", () => {
  for (const season of [2026, "2026", 2025, 2027, 0, "x"]) {
    const a = summarizeExtensionMaster(ROWS, season, pad), b = original(ROWS, season);
    t.equal(JSON.stringify([...a.playerSet].sort()), JSON.stringify([...b.player].sort()), "player set, season " + season);
    t.equal(JSON.stringify([...a.pairSet].sort()), JSON.stringify([...b.pair].sort()), "pair set, season " + season);
  }
});
test("Rico Dowdle: Blake's extension is still active this season, so (0010|14823) is in the pair set; an expired one is not", () => {
  const { pairSet, playerSet } = summarizeExtensionMaster(ROWS, 2026, pad);
  t.ok(pairSet.has("0010|14823"), "Blake already extended Rico");
  t.ok(!pairSet.has("0003|2222"), "an expired extension resets the right");
  t.ok(pairSet.has("0003|1111"), "still active in the current season");
  t.ok(playerSet.has("14823") && !playerSet.has("1111"), "player set = extended THIS season by anyone");
});
test("junk input never throws and never invents a fact", () => {
  for (const rows of [null, undefined, "x", 5, {}]) { const r = summarizeExtensionMaster(rows, 2026, pad); t.equal(r.pairSet.size + r.playerSet.size, 0); }
  t.equal(summarizeExtensionMaster(ROWS, 2026).pairSet.size >= 0, true, "works without a pad function");
});
test("the route reports whether the history read succeeded: true only after a successful read, never in the failure path", () => {
  const src = fs.readFileSync(path.join(ROOT, "worker/src/index.js"), "utf8");
  t.ok(/import \{ summarizeExtensionMaster \} from "\.\/extension_history\.js";/.test(src), "the route uses the extracted function");
  const at = src.indexOf("let extensionHistoryOk = false;");
  t.ok(at > 0, "starts false");
  const tryAt = src.indexOf("try {", at), setAt = src.indexOf("extensionHistoryOk = true;", at), catchAt = src.indexOf("} catch (e) {", tryAt);
  t.ok(tryAt > at && setAt > tryAt && setAt < catchAt, "set true inside the try, after the read and the summary");
  const catchBody = src.slice(catchAt, src.indexOf("}", catchAt + 20) + 1);
  t.ok(!/extensionHistoryOk\s*=/.test(catchBody), "the failure path leaves it false");
  t.ok(/extension_history_ok: extensionHistoryOk,/.test(src), "and it is reported in meta.counts");
});
await run("extension_history");
