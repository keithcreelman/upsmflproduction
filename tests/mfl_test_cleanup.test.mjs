// The worker deletes the RECORDS of its own supervised-test trades in test league 25625
// (Keith 2026-10-13). Modeled on the live Delete Transactions page (options?O=67): one form
// POSTing to delete_transactions, hidden LEAGUE_ID, a `delete` checkbox per record, 7 cells
// per row ending in the remote IP. Each worker trade leaves a "Trade Proposal" and a "Trade".
//   node tests/mfl_test_cleanup.test.mjs
//
// Fake MFL only, made-up values (IPs from the 203.0.113.0/24 documentation range).
import { t, test, run } from "./fixtures/mini_test.mjs";
const TC = await import("../worker/src/mfl_test_cleanup.js");

const L = "25625", SEASON = 2026;
const STORED = "aB3dE5fG7hJ9kL1mN3pQ5r%2BT9vW", FLAG = "commishflag-made-up-26chrs";
const AS_COMMISH = `<div>Commissioner ( <a>Logout</a> | <a>Become Owner</a> )</div>`;
const STAGED = "[Test league: staged trade] test: owner-made trade of a pick about to be forfeited";
const REVERSED = "TRADE REVERSED by the commissioner (UPS lineup rule G3): this undoes the Oct 13 trade between L.A. Looks and CBP. It included L.A. Looks's 2027 fourth-round pick, which was forfeited as a lineup-violation penalty (Week 6) and cannot be traded. Every player, pick and cap dollar goes back to its original team.";
// Today's four test trades (timestamps as MFL's export has them) and their two records each.
const TRADES = [
  { ts: 1791913568, comment: STAGED, trade: "14575480", proposal: "14575479", proposalTs: 1791913568 },
  { ts: 1791913795, comment: REVERSED, trade: "14576026", proposal: "14576025", proposalTs: 1791913794 },
  { ts: 1791925724, comment: STAGED, trade: "14602929", proposal: "14602928", proposalTs: 1791925724 },
  { ts: 1791925801, comment: REVERSED, trade: "14603120", proposal: "14603119", proposalTs: 1791925801 },
];
const OLD = { ts: 1789000000, comment: "TEST LAB restore (test league only)", trade: "239400", proposal: "239399", proposalTs: 1789000000 };

function world({ extra = [], dropExtraOnDelete = null } = {}) {
  const records = [];
  let ip = 1;
  const add = (id, type, txn, ts) => records.push({ id, type, txn, ts, ip: `203.0.113.${ip++}` });
  for (const x of [...TRADES, OLD, ...extra]) {
    add(x.trade, "Trade", `gave up Elliott, DeShon PIT S; Year 2027 Round 4 Draft Pick from L.A. Looks gave up Verse, Jared CLE DE Comments: ${x.comment}`, x.ts);
    add(x.proposal, "Trade Proposal", `offers Elliott, DeShon PIT S; Year 2027 Round 4 Draft Pick from L.A. Looks for Verse, Jared CLE DE Expires: Tue Oct 20 Comments: ${x.comment}`, x.proposalTs);
  }
  add("239381", "Trade Revoked", "offers Benson, Trey ARI RB for Robinson, Bijan ATL RB Comments: debug", 1772000000);
  const exportTrades = [...TRADES, OLD, ...extra].map((x) => ({ type: "TRADE", timestamp: String(x.ts), comments: x.comment, franchise: "0001", franchise2: "0002" }));
  const posts = [];
  const page = () => `<html><body>${AS_COMMISH}<h2>Delete Transactions</h2><form action="https://www48.myfantasyleague.com/2026/delete_transactions" method="post">
    <input type="hidden" name="LEAGUE_ID" value="${L}" /><caption>Select the Transactions To Delete</caption><table>
    <tr><th></th><th>#</th><th>Franchise</th><th>Type</th><th>Transaction</th><th>Date</th><th>Remote IP Address</th></tr>
    ${records.map((r, i) => `<tr class="${i % 2 ? "eventablerow" : "oddtablerow"}"><td> <input type="checkbox" name="delete" value="${r.id}" /></td><td>${i + 1}</td><td>L.A. Looks / (C)</td><td>${r.type}</td><td>${r.txn}</td><td>${TC.mflEtDate(r.ts)}</td><td>${r.ip}</td></tr>`).join("\n")}
    </table><input type="submit" value="Delete Transactions"  /></form></body></html>`;
  const res = (status, body = "", hdrs = {}) => { const h = new Headers(); for (const [k, v] of Object.entries(hdrs)) for (const x of [].concat(v)) h.append(k, x); return { status, headers: h, text: async () => body, json: async () => JSON.parse(body) }; };
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(String(url));
    if (u.pathname.endsWith("/logout")) return res(302, "", { location: `/2026/home/${L}`, "set-cookie": `MFL_IS_COMMISH=${FLAG}; Domain=.myfantasyleague.com; Path=/` });
    if (u.pathname.endsWith(`/home/${L}`)) return res(200, `<html><body>${AS_COMMISH}</body></html>`);
    if (u.pathname.endsWith("/export") && u.searchParams.get("TYPE") === "transactions") return res(200, JSON.stringify({ transactions: { transaction: exportTrades } }));
    if (u.pathname.endsWith("/options") && u.searchParams.get("O") === "67") return res(200, page());
    if (u.pathname.endsWith("/delete_transactions") && init.method === "POST") {
      const b = new URLSearchParams(init.body); posts.push({ body: [...b], cookie: init.headers.Cookie });
      const del = new Set(b.getAll("delete"));
      if (dropExtraOnDelete) del.add(dropExtraOnDelete);
      for (let i = records.length - 1; i >= 0; i -= 1) if (del.has(records[i].id)) records.splice(i, 1);
      for (let i = exportTrades.length - 1; i >= 0; i -= 1) {
        const ts = Number(exportTrades[i].timestamp);
        if (!records.some((r) => r.type === "Trade" && r.ts === ts)) exportTrades.splice(i, 1);
      }
      return res(200, "deleted");
    }
    throw new Error("unexpected " + url);
  };
  return { fetchImpl, posts, records, page };
}
const ENV = { MFL_COOKIE: STORED };
const ALL = TRADES.map((x) => x.ts);

test("MFL's date text and the page's rows are read exactly; the IP column is never kept", () => {
  t.equal(TC.mflEtDate(1791925724), "Tue Oct 13 5:08:44 p.m. ET 2026", "matches the live row for trade 1061");
  t.equal(TC.mflEtDate(1791913795), "Tue Oct 13 1:49:55 p.m. ET 2026", "matches the live row for trade 1060");
  const rows = TC.parseDeleteRows(world().page());
  t.equal(rows.length, 11);
  t.deepEqual(rows[0], { id: "14575480", franchise: "L.A. Looks / (C)", type: "Trade", txn: rows[0].txn, date: "Tue Oct 13 1:46:08 p.m. ET 2026" });
  t.equal(JSON.stringify(rows).includes("203.0.113."), false, "no IP address");
});

test("deletes exactly the 8 records of the 4 named test trades, and nothing else", async () => {
  const w = world();
  const r = await TC.deleteTestTradeRecords(ENV, { season: SEASON, leagueId: L, tradeTimestamps: ALL, expectRecords: 8, fetchImpl: w.fetchImpl });
  t.equal(r.ok, true, JSON.stringify(r));
  t.equal(w.posts.length, 1, "one submit");
  const sent = w.posts[0].body;
  t.deepEqual(sent.filter(([k]) => k === "LEAGUE_ID"), [["LEAGUE_ID", L]]);
  t.deepEqual(sent.filter(([k]) => k === "delete").map(([, v]) => v).sort(), TRADES.flatMap((x) => [x.trade, x.proposal]).sort());
  t.equal(w.posts[0].cookie, `MFL_USER_ID=${STORED}; MFL_IS_COMMISH=${FLAG}`, "submitted as commissioner");
  t.deepEqual([r.records_before, r.records_after, r.trade_export_before, r.trade_export_after], [11, 3, 5, 1]);
  t.deepEqual(w.records.map((x) => x.id).sort(), [OLD.trade, OLD.proposal, "239381"].sort(), "the older records are untouched");
  t.equal(JSON.stringify(r).includes("203.0.113.") || JSON.stringify(r).includes(STORED) || JSON.stringify(r).includes(FLAG), false, "no IP or cookie value in the result");
});

test("a named trade that isn't a worker test trade is refused — nothing is deleted", async () => {
  const w = world();
  const r = await TC.deleteTestTradeRecords(ENV, { season: SEASON, leagueId: L, tradeTimestamps: [OLD.ts], expectRecords: 2, fetchImpl: w.fetchImpl });
  t.equal(r.ok, false); t.equal(r.error, "not_a_test_trade"); t.equal(w.posts.length, 0);
});

test("a missing or doubled record on the page is refused — nothing is deleted", async () => {
  const twin = { ts: TRADES[0].ts, comment: STAGED, trade: "999001", proposal: "999002", proposalTs: TRADES[0].ts };   // a second matching pair at the same second
  const w = world({ extra: [twin] });
  const r = await TC.deleteTestTradeRecords(ENV, { season: SEASON, leagueId: L, tradeTimestamps: [TRADES[1].ts, TRADES[0].ts], expectRecords: 4, fetchImpl: w.fetchImpl });
  t.equal(r.ok, false); t.ok(["records_not_exactly_matched", "not_a_test_trade"].includes(r.error), r.error); t.equal(w.posts.length, 0);
  const w2 = world(); w2.records.splice(w2.records.findIndex((x) => x.id === TRADES[2].proposal), 1);
  const r2 = await TC.deleteTestTradeRecords(ENV, { season: SEASON, leagueId: L, tradeTimestamps: [TRADES[2].ts], expectRecords: 2, fetchImpl: w2.fetchImpl });
  t.equal(r2.error, "records_not_exactly_matched"); t.deepEqual([r2.detail.trade_rows, r2.detail.proposal_rows], [1, 0]); t.equal(w2.posts.length, 0);
});

test("refused before touching MFL: another league, or a count that doesn't add up", async () => {
  const w = world();
  t.equal((await TC.deleteTestTradeRecords(ENV, { season: SEASON, leagueId: "74598", tradeTimestamps: ALL, expectRecords: 8, fetchImpl: w.fetchImpl })).error, "test_league_only");
  t.equal((await TC.deleteTestTradeRecords(ENV, { season: SEASON, leagueId: L, tradeTimestamps: ALL, expectRecords: 6, fetchImpl: w.fetchImpl })).error, "expected_count_mismatch");
  t.equal((await TC.deleteTestTradeRecords(ENV, { season: SEASON, leagueId: L, tradeTimestamps: [], expectRecords: 0, fetchImpl: w.fetchImpl })).error, "no_trades_named");
  t.equal(w.posts.length, 0);
});

test("if MFL removes anything else, the check says so", async () => {
  const w = world({ dropExtraOnDelete: "239381" });
  const r = await TC.deleteTestTradeRecords(ENV, { season: SEASON, leagueId: L, tradeTimestamps: ALL, expectRecords: 8, fetchImpl: w.fetchImpl });
  t.equal(r.ok, false); t.equal(r.error, "verify_mismatch"); t.equal(r.other_records_missing, 1);
});

console.error = () => {};
await run("mfl_test_cleanup");
