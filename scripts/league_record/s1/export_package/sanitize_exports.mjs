// League Record S1: the local sanitizer for the approved export responses A1 to A4.
// FOR THE COMMISSIONER'S OWN USE, offline, no network, no credential (it never sees one). It reads the raw responses that run_a1_a4.sh saved in a private folder and writes a small sanitized
// extract and a manifest NEXT TO them (never into the repository). Only the sanitized extract and the manifest are ever to be shared; the raw responses stay private.
//
// What it keeps: for a trade, its time, the two franchise ids and the two lists of asset tokens (player ids, future-pick tokens, slot tokens, cap tokens). For a future pick: the holder, the year,
// the round and the original franchise. What it drops, and only counts: free-text comments, expiry times, descriptions, any field it does not recognize, and any record that is not an executed
// trade of the expected shape (a pending offer would be one). It prints counts, hashes and token strings of unknown shape; it never prints a comment, a name or a record.
// It STOPS (exit 2) on anything unexpected: a wrong or missing request record, an HTTP status other than 200, an MFL error body, an unexpected format, a wrong year, a franchise id that does not
// belong to the league's own future-pick list, a pick with no original franchise (no default is ever substituted), an unknown token. Exit 3 means "finished, but records were dropped: read the manifest".
// An empty export is reported as empty and is NEVER evidence that nothing happened.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

export class StopError extends Error { constructor(message) { super(message); this.name = "StopError"; } }
const stop = (m) => { throw new StopError(m); };

// The approved requests (decision of 2026-11-21): the single source of truth for what a response may be. A test compares this table with the runner script and the approved document.
export const APPROVED = Object.freeze([
  { name: "A1_transactions_2025_trade", kind: "transactions", year: 2025, host: "www48.myfantasyleague.com", pathq: "/2025/export?TYPE=transactions&L=74598&TRANS_TYPE=TRADE&JSON=1" },
  { name: "A2_transactions_2026_trade", kind: "transactions", year: 2026, host: "www48.myfantasyleague.com", pathq: "/2026/export?TYPE=transactions&L=74598&TRANS_TYPE=TRADE&JSON=1" },
  { name: "A3_futurepicks_2025", kind: "futurepicks", year: 2025, host: "www48.myfantasyleague.com", pathq: "/2025/export?TYPE=futureDraftPicks&L=74598&JSON=1" },
  { name: "A4_futurepicks_2026", kind: "futurepicks", year: 2026, host: "www48.myfantasyleague.com", pathq: "/2026/export?TYPE=futureDraftPicks&L=74598&JSON=1" },
]);

const FID = /^\d{4}$/;
const TOKEN = /^(\d+|FP_\d{4}_\d{4}_\d+|DP_\d+_\d+|BB_\d+(\.\d+)?)$/;      // player id | future pick | slot pick (zero-indexed) | cap money (decimals allowed)
const TRADE_KEYS = new Set(["franchise", "franchise2", "franchise1_gave_up", "franchise2_gave_up", "comments", "expires", "timestamp", "type"]);   // the shape of every archive trade record
const arr = (x) => (x == null || x === "" ? [] : Array.isArray(x) ? x : [x]);
export const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
const parse = (text, what) => { let j; try { j = JSON.parse(text); } catch { stop(`${what}: the response is not JSON`); } if (!j || typeof j !== "object" || Array.isArray(j)) stop(`${what}: the response is not a JSON object`); if ("error" in j) stop(`${what}: MFL returned an error object`); return j; };
const tokens = (s) => String(s == null ? "" : s).split(",").map((x) => x.trim()).filter(Boolean);

// ── transactions (A1, A2) ─────────────────────────────────────────────────────────────────────────
export function sanitizeTransactions(rawText, { year, name = "transactions" }) {
  const j = parse(rawText, name);
  const known = new Set(["version", "encoding", "transactions"]);
  const extraTop = Object.keys(j).filter((k) => !known.has(k));
  if (extraTop.length) stop(`${name}: unexpected top-level field(s): ${extraTop.join(", ")}`);
  const t = j.transactions;
  if (t != null && t !== "" && (typeof t !== "object" || Array.isArray(t))) stop(`${name}: "transactions" has an unexpected format`);
  const list = t && typeof t === "object" ? arr(t.transaction) : [];
  const lo = Date.UTC(year, 0, 1) / 1000, hi = Date.UTC(year + 1, 11, 31, 23, 59, 59) / 1000;
  const report = { received: list.length, kept: 0, empty_export: list.length === 0, dropped_unrecognized_shape: 0, comments_dropped: 0, expires_dropped: 0, other_types: 0, unknown_tokens: [], franchise_ids: [] };
  const records = [], ids = new Set();
  for (const r of list) {
    if (!r || typeof r !== "object" || Array.isArray(r)) { report.dropped_unrecognized_shape += 1; continue; }
    const keys = Object.keys(r);
    if (r.type !== "TRADE") { report.other_types += 1; continue; }
    // an executed trade has exactly the archive's field set; anything else (a pending offer has other fields) is dropped without being read further
    if (keys.some((k) => !TRADE_KEYS.has(k)) || !["franchise", "franchise2", "timestamp", "franchise1_gave_up", "franchise2_gave_up"].every((k) => k in r)) { report.dropped_unrecognized_shape += 1; continue; }
    if (!/^\d{9,10}$/.test(String(r.timestamp)) || !FID.test(String(r.franchise)) || !FID.test(String(r.franchise2)) || r.franchise === r.franchise2) { report.dropped_unrecognized_shape += 1; continue; }
    const ts = Number(r.timestamp);
    if (ts < lo || ts > hi) stop(`${name}: a trade timestamp lies outside ${year}-${year + 1}: the response does not look like the ${year} league instance`);
    const a = tokens(r.franchise1_gave_up), b = tokens(r.franchise2_gave_up);
    for (const x of [...a, ...b]) if (!TOKEN.test(x)) report.unknown_tokens.push(x);
    if (String(r.comments || "").trim()) report.comments_dropped += 1;
    if (r.expires != null && r.expires !== "") report.expires_dropped += 1;
    ids.add(r.franchise); ids.add(r.franchise2);
    records.push({ ts, franchise: r.franchise, franchise2: r.franchise2, gave_up_by_franchise: a, gave_up_by_franchise2: b });
  }
  if (report.other_types) stop(`${name}: ${report.other_types} record(s) are not TRADE although only trades were requested`);
  if (report.unknown_tokens.length) stop(`${name}: token(s) of an unknown shape: ${[...new Set(report.unknown_tokens)].slice(0, 5).join(", ")}`);
  records.sort((x, y) => x.ts - y.ts || x.franchise.localeCompare(y.franchise) || JSON.stringify(x).localeCompare(JSON.stringify(y)));
  report.kept = records.length; report.franchise_ids = [...ids].sort();
  return { records, report };
}

// ── future picks (A3, A4) ─────────────────────────────────────────────────────────────────────────
export function sanitizeFuturePicks(rawText, { year, name = "futurepicks" }) {
  const j = parse(rawText, name);
  const extraTop = Object.keys(j).filter((k) => !["version", "encoding", "futureDraftPicks"].includes(k));
  if (extraTop.length) stop(`${name}: unexpected top-level field(s): ${extraTop.join(", ")}`);
  const fd = j.futureDraftPicks;
  if (fd == null || fd === "" || typeof fd !== "object" || Array.isArray(fd)) stop(`${name}: no "futureDraftPicks" object`);
  const franchises = arr(fd.franchise);
  const report = { franchises: franchises.length, picks: 0, empty_export: franchises.length === 0, fields_dropped: 0, holder_ids: [] };
  const picks = [], holders = new Set();
  for (const f of franchises) {
    if (!f || typeof f !== "object" || !FID.test(String(f.id))) stop(`${name}: a franchise entry has no valid 4-digit id`);
    holders.add(f.id);
    for (const p of arr(f.futureDraftPick)) {
      if (!p || typeof p !== "object") stop(`${name}: a pick entry has an unexpected format`);
      if (!/^\d{4}$/.test(String(p.year)) || !/^\d{1,2}$/.test(String(p.round))) stop(`${name}: a pick has no valid year and round`);
      if (!FID.test(String(p.originalPickFor))) stop(`${name}: a pick has no valid original franchise (originalPickFor); no default is substituted`);
      for (const k of Object.keys(p)) if (!["year", "round", "originalPickFor"].includes(k)) report.fields_dropped += 1;
      picks.push({ holder: f.id, year: Number(p.year), round: Number(p.round), original: p.originalPickFor });
    }
  }
  picks.sort((a, b) => a.year - b.year || a.round - b.round || a.original.localeCompare(b.original) || a.holder.localeCompare(b.holder));
  report.picks = picks.length; report.holder_ids = [...holders].sort();
  return { picks, report };
}

// ── identity: the trades of an instance must belong to the league whose future picks the same instance lists ──
export function checkIdentity(transactionsReport, futurePicksReport, label) {
  const league = new Set(futurePicksReport.holder_ids);
  if (!league.size) stop(`${label}: the future-pick export lists no franchise, so the source identity cannot be checked`);
  const foreign = transactionsReport.franchise_ids.filter((x) => !league.has(x));
  if (foreign.length) stop(`${label}: trade franchise id(s) ${foreign.join(", ")} are not franchises of the league that the future-pick export lists: the two responses may not come from the same league`);
}

// ── the run record the runner wrote must match the approved request exactly ──
export function readRequestLog(text) {
  const rows = new Map();
  for (const line of String(text).split("\n").filter(Boolean)) { const [name, host, pathq, code, bytes, captured] = line.split("\t"); rows.set(name, { name, host, pathq, code: Number(code), bytes: Number(bytes), captured_utc: captured }); }
  return rows;
}
export function checkRequestRecord(spec, rec, rawBytes) {
  if (!rec) stop(`${spec.name}: no record of this request in requests.log`);
  if (rec.host !== spec.host || rec.pathq !== spec.pathq) stop(`${spec.name}: the recorded request differs from the approved one`);
  if (rec.code !== 200) stop(`${spec.name}: the recorded HTTP status is ${rec.code}, not 200`);
  if (rec.bytes !== rawBytes) stop(`${spec.name}: the file size differs from the recorded size`);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(rec.captured_utc || "")) stop(`${spec.name}: the capture time is missing`);
}

// ── whole run ─────────────────────────────────────────────────────────────────────────────────────
export function sanitizeRun(dir) {
  const rawDir = path.join(dir, "raw");
  const log = readRequestLog(fs.existsSync(path.join(dir, "requests.log")) ? fs.readFileSync(path.join(dir, "requests.log"), "utf8") : "");
  const out = {}, manifest = [];
  let warned = false;
  for (const spec of APPROVED) {
    const f = path.join(rawDir, `${spec.name}.json`);
    if (!fs.existsSync(f)) stop(`${spec.name}: the raw response file is missing`);
    const buf = fs.readFileSync(f);
    checkRequestRecord(spec, log.get(spec.name), buf.length);
    const text = buf.toString("utf8");
    const res = spec.kind === "transactions" ? sanitizeTransactions(text, { year: spec.year, name: spec.name }) : sanitizeFuturePicks(text, { year: spec.year, name: spec.name });
    out[spec.name] = res;
    const rep = res.report;
    if (rep.dropped_unrecognized_shape) warned = true;
    manifest.push({ request: spec.name, host: spec.host, path_and_query: spec.pathq, key: "REDACTED", captured_utc: log.get(spec.name).captured_utc, http_status: 200, raw_bytes: buf.length, raw_sha256: sha256(buf), report: rep });
  }
  // source identity per instance: the trades must belong to the league the same instance's future-pick export lists
  checkIdentity(out.A1_transactions_2025_trade.report, out.A3_futurepicks_2025.report, "2025 instance");
  checkIdentity(out.A2_transactions_2026_trade.report, out.A4_futurepicks_2026.report, "2026 instance");
  const sanitizedDir = path.join(dir, "sanitized");
  fs.mkdirSync(sanitizedDir, { recursive: true, mode: 0o700 });
  const files = [];
  for (const spec of APPROVED) {
    const body = spec.kind === "transactions" ? { request: spec.name, year: spec.year, trades: out[spec.name].records } : { request: spec.name, year: spec.year, future_picks: out[spec.name].picks };
    const text = `${JSON.stringify(body, null, 1)}\n`;
    const fn = path.join(sanitizedDir, `${spec.name}.sanitized.json`);
    fs.writeFileSync(fn, text, { mode: 0o600 });
    files.push({ file: `${spec.name}.sanitized.json`, sha256: sha256(Buffer.from(text)) });
  }
  const notes = [
    "Raw responses are private and were not read by anyone but this script.",
    "A3's capture date is UNKNOWN: the 2025 instance may have been frozen at its rollover or written later; its end state is not a dated observation.",
    "A4 is a CURRENT dated observation (its capture time is in this manifest). It is not proof of historical ownership.",
    "An EMPTY export does not establish that no transaction occurred: an export shows what MFL still holds, and cannot show a change MFL never logged as a trade.",
    "Comments, expiry times, descriptions, unrecognized fields and unrecognized records were dropped and counted, never kept.",
  ];
  const man = { purpose: "sanitized extract of the approved read-only requests A1 to A4 (docs/league_record/S1_MFL_EXPORT_REQUESTS.md)", sanitizer: "scripts/league_record/s1/export_package/sanitize_exports.mjs", requests: manifest, sanitized_files: files, notes, status: warned ? "completed_with_dropped_records" : "completed" };
  fs.writeFileSync(path.join(dir, "manifest.json"), `${JSON.stringify(man, null, 1)}\n`, { mode: 0o600 });
  return { manifest: man, exit: warned ? 3 : 0 };
}

// ── command line ──────────────────────────────────────────────────────────────────────────────────
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const i = process.argv.indexOf("--dir");
  const dir = i > 0 ? process.argv[i + 1] : null;
  if (!dir) { console.error("usage: node sanitize_exports.mjs --dir <the private folder the runner wrote>"); process.exit(1); }
  try {
    const { manifest, exit } = sanitizeRun(path.resolve(dir));
    for (const r of manifest.requests) console.log(`${r.request}: ${r.http_status} ${r.raw_bytes} bytes sha256 ${r.raw_sha256.slice(0, 12)}...  ${JSON.stringify(r.report, (k, v) => (k === "franchise_ids" || k === "holder_ids" || k === "unknown_tokens" ? undefined : v))}`);
    console.log(`Sanitized extract and manifest written in ${path.resolve(dir)} (sanitized/ and manifest.json). Share only those, never raw/. Status: ${manifest.status}`);
    process.exit(exit);
  } catch (e) {
    if (e instanceof StopError) { console.error(`STOP: ${e.message}\nNothing was shared or retried. Report this line only.`); process.exit(2); }
    throw e;
  }
}
