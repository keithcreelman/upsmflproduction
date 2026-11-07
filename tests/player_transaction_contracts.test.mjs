// Player modal → Transaction Log (#1338 Phase 1): every event keeps its own contract. An MFL AUCTION_WON is an
// acquisition only when MFL's completed auction results list it; a season's contract record belongs to its
// ownership chain; every other event says "unresolved" instead of inheriting another event's terms; a drop is
// hidden only when the same team re-acquires the player that season.
//   node tests/player_transaction_contracts.test.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { t, test, run } from "./fixtures/mini_test.mjs";
import { auctionResultsIndex, resolveEventContracts, cleanDrops, verifyAuctionWin } from "../worker/src/player_transaction_contracts.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FX = JSON.parse(fs.readFileSync(path.join(ROOT, "tests/fixtures/player_txn_contracts_brissett.json"), "utf8"));
const IDX = fs.readFileSync(path.join(ROOT, "worker/src/index.js"), "utf8");
const fresh = () => JSON.parse(JSON.stringify(FX.events));
const auctions = () => Object.fromEntries(Object.entries(FX.auctionResultsBySeason).map(([y, j]) => [y, auctionResultsIndex(j)]));
const find = (evs, date, kind) => evs.find((e) => e.date === date && e.kind === kind);

test("Jacoby Brissett 2026: the July 17 $12,000 test lot is unresolved; only July 29 carries the $13,000 contract", () => {
  const evs = resolveEventContracts(fresh(), { pid: FX.pid, srcBySeason: FX.srcBySeason, auctionsBySeason: auctions() });
  const jul17 = find(evs, "2026-07-17", "auction"), jul29 = find(evs, "2026-07-29", "auction");
  t.equal(jul17.detail, "$12,000", "the row stays in the log with its own price");
  t.equal(jul17.contract, null, "no contract on the unverified lot");
  t.ok(/not in MFL’s completed auction results/.test(jul17.unresolved), jul17.unresolved);
  t.equal(jul29.verified, true);
  t.equal(jul29.contract.tcv, 13000); t.equal(jul29.contract.aav, 13000);
  const with13k = evs.filter((e) => String(e.season) === "2026" && e.contract && e.contract.tcv === 13000);
  t.equal(with13k.length, 1, "exactly one 2026 event carries the $13,000 contract");
});

test("no historical acquisition inherits another team's or a later contract (every season)", () => {
  const evs = resolveEventContracts(fresh(), { pid: FX.pid, srcBySeason: FX.srcBySeason, auctionsBySeason: auctions() });
  for (const e of evs) {
    if (!e.contract || !["auction", "add", "trade", "tag"].includes(e.kind)) continue;
    const row = FX.srcBySeason[String(e.season)];
    const owner = row && String(row.franchise_id).padStart(4, "0");
    const onPath = e.franchise_id === owner || e.from_franchise_id === owner;
    t.ok(onPath, e.date + " " + e.kind + " keeps a contract only on the record holder's path (" + e.franchise_id + " vs " + owner + ")");
    if ((e.kind === "auction" || e.kind === "add") && /\$/.test(e.detail || "") && Number(row.contract_length) === 1) {
      t.equal(Number(String(e.detail).replace(/\D/g, "")), Number(row.aav), e.date + ": price equals the 1-year contract's salary");
    }
  }
  // 2024: HammerTime holds the record ($1K); the $3,000 auction by Real Deal Creel and Hawks' adds don't inherit it.
  t.equal(find(evs, "2024-07-29", "auction").contract, null);
  t.equal(find(evs, "2024-09-29", "add").contract, null);
  t.equal(find(evs, "2024-11-01", "add").contract, null);
  t.ok(find(evs, "2024-07-29", "auction").contract_unresolved, "and says why");
  // 2023 and 2019: one verified auction each, price = salary → kept.
  t.equal(find(evs, "2023-08-05", "auction").contract.tcv, 5000);
  t.equal(find(evs, "2019-08-27", "auction").contract.tcv, 4000);
});

test("the same team acquiring twice in a season: only the later acquisition carries the season's contract", () => {
  const contract = { season: 2025, franchise_id: "0003", tcv: 5000, aav: 5000, contract_length: 1 };
  const evs = [
    { season: 2025, ts: 10, kind: "add", label: "Free Agent Add", detail: "$1,000", franchise_id: "0003", contract: { ...contract } },
    { season: 2025, ts: 20, kind: "drop", label: "Dropped", franchise_id: "0003" },
    { season: 2025, ts: 30, kind: "auction", label: "Auction Won", mfl_type: "AUCTION_WON", detail: "$5,000", franchise_id: "0003", contract: { ...contract } }
  ];
  const auctions2025 = { ok: true, rows: [{ player: "1", franchise: "0003", bid: 5000, lastBid: 0 }] };
  resolveEventContracts(evs, { pid: "1", srcBySeason: { 2025: { franchise_id: "3", aav: 5000, tcv: 5000, contract_length: 1 } }, auctionsBySeason: { 2025: auctions2025 } });
  t.equal(evs[2].contract.tcv, 5000, "the later auction keeps it");
  t.equal(evs[0].contract, null, "the earlier add does not inherit it");
  t.ok(/earlier move this season/.test(evs[0].contract_unresolved));
});

test("an unreadable auction-results season verifies nothing (fails closed)", () => {
  const evs = resolveEventContracts(fresh(), { pid: FX.pid, srcBySeason: FX.srcBySeason, auctionsBySeason: { ...auctions(), 2026: { ok: false, rows: [] } } });
  t.equal(find(evs, "2026-07-29", "auction").contract, null, "can't verify → no contract");
  t.ok(/couldn’t be read/.test(find(evs, "2026-07-29", "auction").unresolved));
  t.equal(auctionResultsIndex({ error: { $t: "API requires logged in user" } }).ok, false, "an MFL error envelope is not 'no auctions'");
  t.equal(verifyAuctionWin({ season: 2026, detail: "$13,000", franchise_id: "0008", ts: 1785328213 }, "12616", auctions()["2026"]).verified, true);
  // Dak Prescott 2020: MFL posted the win 5.1 days after the last bid (2019–2021 auctions posted up to 5.1 days late).
  const dak2020 = { ok: true, rows: [{ player: "12620", franchise: "0007", bid: 15000, lastBid: 1589624959 }] };
  t.equal(verifyAuctionWin({ season: 2020, detail: "$15,000", franchise_id: "0007", ts: 1590066000 }, "12620", dak2020).verified, true);
  t.equal(verifyAuctionWin({ season: 2020, detail: "$15,000", franchise_id: "0007", ts: 1589624959 + 8 * 86400 }, "12620", dak2020).verified, false, "but not a week+ later");
});

test("a drop is hidden only when the SAME team re-acquires; another team's (verified) acquisition keeps it", () => {
  const base = [
    { season: 2026, ts: 1783770000, kind: "drop", label: "Dropped", franchise_id: "0010" },
    { season: 2026, ts: 1784305186, kind: "auction", label: "Auction Won", detail: "$12,000", franchise_id: "0008", unresolved: "test lot" },
    { season: 2026, ts: 1785328213, kind: "auction", label: "Auction Won", detail: "$13,000", franchise_id: "0008" }
  ];
  t.equal(cleanDrops(base).length, 3, "Brissett 07-11: Blake Bombers' drop stays (Real Deal Creel re-acquired)");
  const churn = [{ season: 2025, ts: 10, kind: "drop", franchise_id: "0003" }, { season: 2025, ts: 20, kind: "auction", franchise_id: "0003" }];
  t.equal(cleanDrops(churn).length, 1, "same team drops and re-acquires: churn hidden");
  const testOnly = [{ season: 2025, ts: 10, kind: "drop", franchise_id: "0003" }, { season: 2025, ts: 20, kind: "auction", franchise_id: "0003", unresolved: "test lot" }];
  t.equal(cleanDrops(testOnly).length, 2, "an unverified lot is not a re-acquisition");
});

test("the route uses these functions (auction results read, contracts resolved, drops cleaned)", () => {
  t.ok(/TYPE=auctionResults&L=/.test(IDX) && /auctionsBySeason\[String\(s\)\] = r\.ok \? auctionResultsIndex/.test(IDX), "auction results per season");
  t.ok(/resolveEventContracts\(events, \{ pid, srcBySeason: contractBySeason, auctionsBySeason \}\)/.test(IDX), "contracts resolved");
  t.ok(/const cleaned = cleanDrops\(events\);/.test(IDX) && !/const acqAfter = /.test(IDX), "the old any-team drop filter is gone");
  t.ok(/mfl_type: "AUCTION_WON"/.test(IDX), "MFL auction wins are tagged");
});

await run("player_transaction_contracts");
