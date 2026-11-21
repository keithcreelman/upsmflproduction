// League Record S1 (trade and draft-pick lineage), pilot extraction: the read-only archive reader.
//
// Opens the committed MFL analysis archive (data/db-archives/mfl_database_2026-06-05.db.gz) READ-ONLY in a temp directory and answers SELECTs through a TABLE ALLOWLIST.
// The allowlist is one of the guards for Keith's rule "never derive a draft slot from standings, league finishes or a projected order" (docs/league_record/S1_METHODOLOGY.md):
// no table that holds a ranking, a bracket or a projected order can be queried through this module (the banned list lives in guard.mjs), and tests/league_record_s1_pilot.test.mjs (T9)
// also scans the extraction sources for the banned words. No network, no D1, no write to the archive (the decompressed copy is opened with readOnly: true).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import zlib from "node:zlib";
import { pipeline } from "node:stream/promises";
import { DatabaseSync } from "node:sqlite";
import { BANNED_TABLES, BANNED_COLUMNS } from "./guard.mjs";

export { BANNED_TABLES, BANNED_COLUMNS };

export const ARCHIVE_GZ_PATH = "data/db-archives/mfl_database_2026-06-05.db.gz";
export const ARCHIVE_GZ_SHA256 = "2b344b794422a64ee323c52e02b30ace936e60945a6fbb1ce5784e968eb95c28";

// The only archive tables the pilot may read. Every one is an event log, a draft result or a per-week roster or score record.
export const ALLOWED_TABLES = Object.freeze([
  "transactions_trades", "transactions_base", "transactions_adddrop", "draftresults_mfl", "draftresults_legacy",
  "rosters_weekly", "playerscores_weekly", "player_weeklyscoringresults", "leagueevents", "players", "transactions_auction", "metadata_franchise",
]);

export class ArchiveGuardError extends Error {
  constructor(message) { super(message); this.name = "ArchiveGuardError"; }
}

// Splits SQL into tokens in ONE left-to-right pass, so a string, a comment and a quoted name are each recognized where they start (a "--" inside a string is not a comment, and a name
// inside a string is not a table). An unterminated string or comment is not skipped: its characters are scanned as code, which can only make the guard stricter.
// Kinds: word (a bare name), quoted (a "name", [name] or `name`), string, comment, semi, other.
export function sqlTokens(text) {
  const out = [];
  const re = /'(?:[^']|'')*'|"(?:[^"]|"")*"|\[[^\]]*\]|`[^`]*`|--[^\n]*|\/\*[\s\S]*?\*\/|[A-Za-z_][A-Za-z0-9_]*|;|[^\s]/g;
  for (const m of String(text).matchAll(re)) {
    const v = m[0];
    if (v[0] === "'") out.push({ kind: "string", value: v });
    else if (v[0] === '"') out.push({ kind: "quoted", value: v.slice(1, -1).replace(/""/g, '"') });
    else if (v[0] === "[" || v[0] === "`") out.push({ kind: "quoted", value: v.slice(1, -1) });
    else if (v.startsWith("--") || v.startsWith("/*")) out.push({ kind: "comment", value: v });
    else if (/^[A-Za-z_]/.test(v)) out.push({ kind: "word", value: v });
    else if (v === ";") out.push({ kind: "semi", value: v });
    else out.push({ kind: "other", value: v });
  }
  return out;
}

// Authorizes a query. The check is on EVERY name in the statement, not only the ones after FROM or JOIN, so a comma join, a subquery, an alias list or any other form that names a
// table is covered:
//   - the statement must be one SELECT (no WITH, no second statement, no PRAGMA or ATTACH, no sqlite_ or pragma_ names);
//   - any name that is a banned table, or ANY table or view of the archive that is not on the allowlist, refuses the query (knownTables is the archive's sqlite_master list);
//   - a name right after FROM or JOIN must be on the allowlist even when the archive list is not supplied.
// Returns the allowlisted tables the query names, in order of first appearance.
export function assertQueryAllowed(sql, knownTables = []) {
  const text = String(sql);
  if (!/^\s*select\b/i.test(text)) throw new ArchiveGuardError("only a single SELECT is allowed");
  const toks = sqlTokens(text).filter((x) => x.kind !== "comment");
  const semi = toks.findIndex((x) => x.kind === "semi");
  if (semi >= 0 && semi < toks.length - 1) throw new ArchiveGuardError("only a single SELECT is allowed");
  const known = new Set(knownTables.map((x) => String(x).toLowerCase()));
  const used = [];
  toks.forEach((tk, i) => {
    if (tk.kind !== "word" && tk.kind !== "quoted") return;
    const id = tk.value.toLowerCase();
    if (tk.kind === "word" && (id === "with" || id === "pragma" || id === "attach")) throw new ArchiveGuardError(`${id} is not allowed in an S1 extraction query`);
    if (id.startsWith("sqlite_") || id.startsWith("pragma_")) throw new ArchiveGuardError(`the name ${id} is not allowed in an S1 extraction query`);
    if (BANNED_COLUMNS.includes(id)) throw new ArchiveGuardError(`the column ${id} may not be read by the S1 extraction (it is derived from league results, not from MFL draft data)`);
    if (BANNED_TABLES.includes(id)) throw new ArchiveGuardError(`the table ${id} may not be read by the S1 extraction (it holds rankings or forecasts; draft slots come only from MFL draft results and slot data)`);
    if (ALLOWED_TABLES.includes(id)) { if (!used.includes(id)) used.push(id); }
    else if (known.has(id)) throw new ArchiveGuardError(`the table ${id} is not on the S1 extraction allowlist`);
    const prev = toks[i - 1];
    if (prev && prev.kind === "word" && /^(from|join)$/i.test(prev.value) && !ALLOWED_TABLES.includes(id)) throw new ArchiveGuardError(`the table ${id} is not on the S1 extraction allowlist`);
  });
  return used;
}

async function sha256File(file) {
  const h = crypto.createHash("sha256");
  await pipeline(fs.createReadStream(file), h);
  return h.digest("hex");
}

// root: the repository root. Returns { all(sql, ...params), get(sql, ...params), close(), gzSha256, dbPath }.
export async function openArchive({ root, cacheDir } = {}) {
  const gz = path.join(root, ARCHIVE_GZ_PATH);
  if (!fs.existsSync(gz)) throw new Error(`the archive is missing: ${ARCHIVE_GZ_PATH}`);
  const gzSha256 = await sha256File(gz);
  if (gzSha256 !== ARCHIVE_GZ_SHA256) throw new Error(`the archive checksum differs from the pinned one (${gzSha256})`);
  const dir = cacheDir || path.join(os.tmpdir(), `ups-s1-archive-${gzSha256.slice(0, 12)}`);
  fs.mkdirSync(dir, { recursive: true });
  const dbPath = path.join(dir, "archive.db");
  const marker = path.join(dir, "archive.db.ok");
  if (!fs.existsSync(marker) || !fs.existsSync(dbPath)) {
    const tmp = `${dbPath}.${process.pid}.part`;
    await pipeline(fs.createReadStream(gz), zlib.createGunzip(), fs.createWriteStream(tmp));
    fs.renameSync(tmp, dbPath);
    fs.writeFileSync(marker, gzSha256);
  }
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const prepared = new Map();
  const knownTables = db.prepare("select name from sqlite_master where type in ('table','view')").all().map((r) => r.name);
  const stmt = (sql) => { assertQueryAllowed(sql, knownTables); if (!prepared.has(sql)) prepared.set(sql, db.prepare(sql)); return prepared.get(sql); };
  return {
    all: (sql, ...params) => stmt(sql).all(...params).map((r) => ({ ...r })),
    get: (sql, ...params) => { const r = stmt(sql).get(...params); return r ? { ...r } : null; },
    close: () => db.close(),
    gzSha256, dbPath,
  };
}

// An indexed in-memory copy of the large per-week tables, for the whole-archive extraction (thousands of per-player lookups). Every row is read THROUGH the archive reader (so the table
// guard applies to the copy), and every query on the copy passes the same guard. Read-only in effect: nothing is written to the archive.
const MEMORY_INDEXES = { rosters_weekly: ["player_id", "season"], player_weeklyscoringresults: ["player_id", "season"], playerscores_weekly: ["player_id", "season"], players: ["player_id"] };
export function memoryView(archive, tables = Object.keys(MEMORY_INDEXES).concat(["leagueevents"])) {
  const mem = new DatabaseSync(":memory:");
  for (const t of tables) {
    const rows = archive.all(`select * from ${t}`);
    if (!rows.length) continue;
    const cols = Object.keys(rows[0]);
    // player_id gets TEXT affinity so a numeric id read from the archive still equals the string id the extraction binds
    mem.exec(`create table ${t} (${cols.map((c) => `"${c}"${c === "player_id" ? " TEXT" : ""}`).join(", ")})`);
    const ins = mem.prepare(`insert into ${t} values (${cols.map(() => "?").join(", ")})`);
    mem.exec("begin");
    for (const r of rows) ins.run(...cols.map((c) => (Number.isInteger(r[c]) ? BigInt(r[c]) : r[c])));   // integers bind as INTEGER, not REAL
    mem.exec("commit");
    if (MEMORY_INDEXES[t] && MEMORY_INDEXES[t].every((c) => cols.includes(c))) mem.exec(`create index ${t}_ix on ${t} (${MEMORY_INDEXES[t].map((c) => `"${c}"`).join(", ")})`);
  }
  const known = mem.prepare("select name from sqlite_master where type = 'table'").all().map((r) => r.name);
  const cache = new Map();
  const stmt = (sql) => { assertQueryAllowed(sql, [...known, ...ALLOWED_TABLES]); if (!cache.has(sql)) cache.set(sql, mem.prepare(sql)); return cache.get(sql); };
  return {
    all: (sql, ...params) => stmt(sql).all(...params).map((r) => ({ ...r })),
    get: (sql, ...params) => { const r = stmt(sql).get(...params); return r ? { ...r } : null; },
    close: () => mem.close(), dbPath: archive.dbPath, gzSha256: archive.gzSha256,
  };
}
