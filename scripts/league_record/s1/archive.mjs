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
import { BANNED_TABLES } from "./guard.mjs";

export { BANNED_TABLES };

export const ARCHIVE_GZ_PATH = "data/db-archives/mfl_database_2026-06-05.db.gz";
export const ARCHIVE_GZ_SHA256 = "2b344b794422a64ee323c52e02b30ace936e60945a6fbb1ce5784e968eb95c28";

// The only archive tables the pilot may read. Every one is an event log, a draft result or a per-week roster or score record.
export const ALLOWED_TABLES = Object.freeze([
  "transactions_trades", "transactions_base", "transactions_adddrop", "draftresults_mfl", "draftresults_legacy",
  "rosters_weekly", "playerscores_weekly", "player_weeklyscoringresults", "leagueevents", "players", "transactions_auction",
]);

export class ArchiveGuardError extends Error {
  constructor(message) { super(message); this.name = "ArchiveGuardError"; }
}

// Authorizes a query. The check is on EVERY identifier in the statement, not only the ones after FROM or JOIN, so a comma join, a subquery, an alias list or any other form
// that names a table is covered:
//   - comments and string literals are removed first; quoted identifiers ("x", [x], `x`) are unquoted;
//   - the statement must be one SELECT (no WITH, no second statement, no PRAGMA or sqlite_ names, no table-valued pragma functions);
//   - any identifier that names a banned table, or ANY table or view of the archive that is not on the allowlist, refuses the query (knownTables is the archive's sqlite_master list);
//   - an identifier after FROM or JOIN must be on the allowlist even when the archive list is not supplied.
// Returns the allowlisted tables the query names, in order of first appearance.
export function assertQueryAllowed(sql, knownTables = []) {
  const text = String(sql);
  if (!/^\s*select\b/i.test(text)) throw new ArchiveGuardError("only a single SELECT is allowed");
  const bare = text.replace(/--[^\n]*/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ").replace(/'(?:[^']|'')*'/g, " ' ' ");
  if (/;\s*\S/.test(bare)) throw new ArchiveGuardError("only a single SELECT is allowed");
  const idents = [];
  for (const m of bare.matchAll(/"((?:[^"]|"")*)"|\[([^\]]*)\]|`([^`]*)`|([A-Za-z_][A-Za-z0-9_]*)/g)) idents.push((m[1] ?? m[2] ?? m[3] ?? m[4]).toLowerCase());
  const known = new Set(knownTables.map((x) => String(x).toLowerCase()));
  const used = [];
  for (const id of idents) {
    if (id === "with" || id === "pragma" || id === "attach") throw new ArchiveGuardError(`${id} is not allowed in an S1 extraction query`);
    if (id.startsWith("sqlite_") || id.startsWith("pragma_")) throw new ArchiveGuardError(`the name ${id} is not allowed in an S1 extraction query`);
    if (BANNED_TABLES.includes(id)) throw new ArchiveGuardError(`the table ${id} may not be read by the S1 extraction (it holds rankings or forecasts; draft slots come only from MFL draft results and slot data)`);
    if (ALLOWED_TABLES.includes(id)) { if (!used.includes(id)) used.push(id); continue; }
    if (known.has(id)) throw new ArchiveGuardError(`the table ${id} is not on the S1 extraction allowlist`);
  }
  for (const m of bare.toLowerCase().matchAll(/\b(?:from|join)\s+(?:"([^"]+)"|\[([^\]]+)\]|`([^`]+)`|([a-z_][a-z0-9_]*))/g)) {
    const u = m[1] ?? m[2] ?? m[3] ?? m[4];
    if (!ALLOWED_TABLES.includes(u)) throw new ArchiveGuardError(`the table ${u} is not on the S1 extraction allowlist`);
  }
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
