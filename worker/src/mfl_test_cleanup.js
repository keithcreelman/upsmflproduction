// Delete the RECORDS of the worker's own supervised-test trades from test league 25625
// (Keith 2026-10-13: "You should have worker do this"). MFL's Setup → Delete Transactions
// (options?L=…&O=67) removes a transaction's RECORD only; it never undoes the move — the
// test has already reversed it. Each worker trade leaves two records, a "Trade Proposal"
// and a "Trade", both carrying the test's comment.
//
// Safety: hard-wired to 25625; only trades the caller names by timestamp; each must be a
// TRADE in MFL's own export whose comment carries a test marker; on the page exactly one
// "Trade" row (same second) and one "Trade Proposal" row (up to 5 s earlier) per trade,
// both with the marker — anything else and NOTHING is deleted. The count must equal what
// the caller expects. Afterwards the page and the export must show exactly those records
// gone and every other record still there. IP addresses on the page are never returned.

import { loadSetupPage } from "./mfl_lockout.js";

export const TEST_LEAGUE_ID = "25625";
export const TEST_TRADE_MARKERS = ["[Test league: staged trade]", "TRADE REVERSED by the commissioner (UPS lineup rule G3)"];
const _s = (v) => String(v == null ? "" : v);
const textOf = (h) => _s(h).replace(/<[^>]*>/g, " ").replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&#39;|&apos;/gi, "'").replace(/&quot;/gi, '"').replace(/\s+/g, " ").trim();
const hasMarker = (t) => TEST_TRADE_MARKERS.some((m) => _s(t).includes(m));

// The page's rows → [{ id, type, franchise, txn, date }]. Columns: [checkbox, #, Franchise,
// Type, Transaction, Date, Remote IP] — the IP column is dropped here.
export function parseDeleteRows(markup) {
  const rows = [];
  for (const m of _s(markup).matchAll(/<tr\b[\s\S]*?<\/tr>/gi)) {
    const tr = m[0];
    const box = /<input\b[^>]*\bname=["']?delete["']?[^>]*>/i.exec(tr);
    if (!box) continue;
    const id = (/\bvalue=["']?(\d+)["']?/i.exec(box[0]) || [])[1];
    if (!id) continue;
    const tds = [...tr.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((x) => textOf(x[1]));
    rows.push({ id, franchise: tds[2] || "", type: tds[3] || "", txn: tds[4] || "", date: tds[5] || "" });
  }
  return rows;
}

// MFL's own date text, e.g. "Tue Oct 13 5:08:44 p.m. ET 2026".
export function mflEtDate(unix) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric",
    hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true, year: "numeric" }).formatToParts(new Date(Number(unix) * 1000)).map((p) => [p.type, p.value]));
  return `${parts.weekday} ${parts.month} ${parts.day} ${parts.hour}:${parts.minute}:${parts.second} ${parts.dayPeriod === "AM" ? "a.m." : "p.m."} ET ${parts.year}`;
}

// → { ok, picks:[{trade, trade_row, proposal_row}] } or { ok:false, error, detail }.
export function selectTestTradeRecords(rows, tradeTimestamps) {
  const picks = [];
  for (const ts of tradeTimestamps) {
    const tradeDate = mflEtDate(ts);
    const proposalDates = [0, 1, 2, 3, 4, 5].map((k) => mflEtDate(Number(ts) - k));
    const tradeRows = rows.filter((r) => r.type === "Trade" && r.date === tradeDate && hasMarker(r.txn));
    const proposalRows = rows.filter((r) => r.type === "Trade Proposal" && proposalDates.includes(r.date) && hasMarker(r.txn));
    if (tradeRows.length !== 1 || proposalRows.length !== 1) {
      return { ok: false, error: "records_not_exactly_matched", detail: { timestamp: Number(ts), et: tradeDate, trade_rows: tradeRows.length, proposal_rows: proposalRows.length } };
    }
    picks.push({ trade: Number(ts), trade_row: tradeRows[0], proposal_row: proposalRows[0] });
  }
  const ids = picks.flatMap((p) => [p.trade_row.id, p.proposal_row.id]);
  if (new Set(ids).size !== ids.length) return { ok: false, error: "records_overlap" };
  return { ok: true, picks };
}

async function tradeExport(f, season, leagueId) {
  try {
    const r = await f(`https://www48.myfantasyleague.com/${encodeURIComponent(_s(season))}/export?TYPE=transactions&L=${encodeURIComponent(leagueId)}&TRANS_TYPE=TRADE&DAYS=365&JSON=1`,
      { headers: { "User-Agent": "upsmflproduction-worker" } });
    const j = await r.json();
    const t = j && j.transactions && j.transactions.transaction;
    return (Array.isArray(t) ? t : t ? [t] : []).filter((x) => _s(x.type).toUpperCase() === "TRADE");
  } catch (_) { return null; }
}

const summarize = (r) => ({ id: r.id, type: r.type, date: r.date });

export async function deleteTestTradeRecords(env, { season, leagueId, tradeTimestamps, expectRecords, fetchImpl }) {
  const f = fetchImpl || fetch;
  if (_s(leagueId) !== TEST_LEAGUE_ID) return { ok: false, error: "test_league_only" };
  const stamps = [...new Set((tradeTimestamps || []).map(Number).filter((n) => Number.isFinite(n) && n > 0))];
  if (!stamps.length) return { ok: false, error: "no_trades_named" };
  if (Number(expectRecords) !== stamps.length * 2) return { ok: false, error: "expected_count_mismatch", detail: { trades: stamps.length, expect_records: Number(expectRecords) } };

  // 1) Each named trade must be a TRADE in MFL's own export, made by a test.
  const before = await tradeExport(f, season, leagueId);
  if (!before) return { ok: false, error: "trade_export_unreadable" };
  for (const ts of stamps) {
    const hit = before.filter((t) => Number(t.timestamp) === ts);
    if (hit.length !== 1 || !hasMarker(hit[0].comments)) return { ok: false, error: "not_a_test_trade", detail: { timestamp: ts, found: hit.length } };
  }

  // 2) The page, as commissioner; pick exactly the records.
  const page = await loadSetupPage(env, { season, leagueId, page: "delete_transactions", fetchImpl: f });
  if (!page.ok) return { ok: false, error: `page_${page.error}` };
  const rows = parseDeleteRows(page.markup);
  const sel = selectTestTradeRecords(rows, stamps);
  if (!sel.ok) return { ok: false, error: sel.error, detail: sel.detail };
  const ids = sel.picks.flatMap((p) => [p.trade_row.id, p.proposal_row.id]);
  if (ids.length !== Number(expectRecords)) return { ok: false, error: "expected_count_mismatch" };
  const action = new URL(page.form.action || page.url, page.url);
  if (!/(^|\.)myfantasyleague\.com$/i.test(action.hostname) || !/\/delete_transactions$/i.test(action.pathname)) return { ok: false, error: "unexpected_form_action" };
  const leagueField = (page.form.fields.find(([k]) => k === "LEAGUE_ID") || [])[1];
  if (_s(leagueField) !== TEST_LEAGUE_ID) return { ok: false, error: "form_not_for_test_league" };

  // 3) Submit only those boxes — exactly what a browser sends when you tick them.
  const body = new URLSearchParams();
  body.append("LEAGUE_ID", TEST_LEAGUE_ID);
  for (const id of ids) body.append("delete", id);
  try {
    await f(action.toString(), { method: "POST", redirect: "manual",
      headers: { Cookie: typeof page.cookie === "function" ? page.cookie(action.toString()) : page.cookie, "User-Agent": "upsmflproduction-worker", "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString() });
  } catch (e) { return { ok: false, error: `submit_failed: ${e && e.message}`, submitted: true }; }

  // 4) Verify: exactly those records gone, every other record still there.
  const result = { trades: stamps, deleted: sel.picks.flatMap((p) => [summarize(p.proposal_row), summarize(p.trade_row)]), records_before: rows.length };
  const again = await loadSetupPage(env, { season, leagueId, page: "delete_transactions", fetchImpl: f });
  if (!again.ok) return { ok: false, error: `verify_${again.error}`, submitted: true, ...result };
  const rowsAfter = parseDeleteRows(again.markup);
  const afterIds = new Set(rowsAfter.map((r) => r.id));
  const stillThere = ids.filter((id) => afterIds.has(id));
  const otherBefore = rows.map((r) => r.id).filter((id) => !ids.includes(id));
  const otherMissing = otherBefore.filter((id) => !afterIds.has(id));
  const after = await tradeExport(f, season, leagueId);
  const exportStill = after ? stamps.filter((ts) => after.some((t) => Number(t.timestamp) === ts)) : null;
  const ok = stillThere.length === 0 && otherMissing.length === 0 && rowsAfter.length === rows.length - ids.length && Array.isArray(exportStill) && exportStill.length === 0
    && after.length === before.length - stamps.length;
  return { ok, ...(ok ? {} : { error: "verify_mismatch" }), submitted: true, ...result, records_after: rowsAfter.length,
    trade_export_before: before.length, trade_export_after: after ? after.length : null,
    ...(ok ? {} : { still_there: stillThere, other_records_missing: otherMissing.length, export_still_lists: exportStill }) };
}
