// Keith 2026-11-18, the release dependency for any real Drop in the 2027 app (#1537): the cap-penalty preview must name the cap season a drop's
// penalty is charged to from the SAME rule the posting path uses, and a test must compare the two. Source checks (the worker is one file) plus the
// rule itself run on its own text: before the FA Auction starts -> the current season; from auction start -> the following season; unresolved -> ok:false.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { t, test, run } from "./fixtures/mini_test.mjs";

const SRC = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "worker", "src", "index.js"), "utf8");
const block = (from, len) => { const i = SRC.indexOf(from); return i < 0 ? "" : SRC.slice(i, i + len); };

test("preview and posting compute the charge season with the same function and the same auction-start source", () => {
  const pv = block('path === "/api/cap-penalty/preview" && request.method === "GET"', 40000).split("} catch (pvErr)")[0];
  t.ok(pv, "the preview route");
  t.match(pv, /const pvAuctionStart = await _faaAuctionStartUnix\(env, pvSeason\);/);
  t.match(pv, /const pvCharge = _dropPenaltyCapSeason\(\{\s*season: Number\(pvSeason\) \|\| 0, dropUnix: Math\.floor\(Date\.parse\(pvDropIso\) \/ 1000\) \|\| 0, auctionStartUnix: pvAuctionStart && pvAuctionStart\.unix,/);
  t.equal((pv.match(/charge: pvChargeOut/g) || []).length, 2, "both answers (one player, all players) carry it");
  // the posting path: the drop tracker's scan
  const scan = SRC.slice(SRC.indexOf("const scanAuctionStart = await _faaAuctionStartUnix(env, targetSeason);"));
  t.ok(SRC.includes("const scanAuctionStart = await _faaAuctionStartUnix(env, targetSeason);"), "the tracker reads the auction start the same way");
  t.ok(SRC.includes("const scanSeasonNum = Number(targetSeason) || 0;"));
  t.match(scan, /const capYear = _dropPenaltyCapSeason\(\{\s*season: scanSeasonNum, dropUnix: drop\.ts, auctionStartUnix: scanAuctionStart\.unix,/, "and posts with the same function");
  t.equal((SRC.match(/const _dropPenaltyCapSeason = /g) || []).length, 1, "one definition of the rule");
});

test("the rule: before the auction -> this season; from auction start -> next season; anything unresolved -> ok:false (never a guess)", () => {
  const start = SRC.indexOf("const _dropPenaltyCapSeason = "), end = SRC.indexOf("\n};", start) + 3;
  const rule = new Function(SRC.slice(start, end) + "\nreturn _dropPenaltyCapSeason;")();
  const A = Date.parse("2026-07-25T16:00:00Z") / 1000;   // an auction start
  const before = rule({ season: 2026, dropUnix: A - 86400, auctionStartUnix: A }), after = rule({ season: 2026, dropUnix: A + 86400 * 120, auctionStartUnix: A });
  t.equal(before.ok, true); t.equal(before.applies_to_season, 2026);
  t.equal(after.ok, true); t.equal(after.applies_to_season, 2027, "an in-season drop (after the auction) is charged to next season");
  t.equal(rule({ season: 2026, dropUnix: A + 1, auctionStartUnix: 0 }).ok, false, "no auction start: refused");
  t.equal(rule({ season: 0, dropUnix: A, auctionStartUnix: A }).ok, false, "no season: refused");
  t.equal(rule({ season: 2026, dropUnix: 0, auctionStartUnix: A }).ok, false, "no drop time: refused");
});

await run("drop_charge_season_preview");
