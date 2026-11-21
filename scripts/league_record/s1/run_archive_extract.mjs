#!/usr/bin/env node
// League Record S1, Step 1b: build the 2010-2025 archive extraction and its report. Read-only, offline, deterministic.
//
//   node scripts/league_record/s1/run_archive_extract.mjs            write docs/league_record/archive/{extraction.json,archive_report.md}
//   node scripts/league_record/s1/run_archive_extract.mjs --check    build and compare with the committed files; exit 1 if anything differs
//   node scripts/league_record/s1/run_archive_extract.mjs --out <dir>
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openArchive } from "./archive.mjs";
import { buildArchiveExtraction } from "./archive_extract.mjs";
import { renderArchiveReport } from "./archive_report.mjs";
import { stableStringify } from "./pilot.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..", "..");
const args = process.argv.slice(2);
const check = args.includes("--check");
const outDir = args.includes("--out") ? path.resolve(args[args.indexOf("--out") + 1]) : path.join(root, "docs", "league_record", "archive");

const archive = await openArchive({ root });
const extraction = buildArchiveExtraction({ archive, root });
archive.close();
const files = { "extraction.json": `${stableStringify(extraction)}\n`, "archive_report.md": renderArchiveReport(extraction) };

if (check) {
  let bad = 0;
  for (const [name, text] of Object.entries(files)) {
    const p = path.join(outDir, name);
    if (!fs.existsSync(p) || fs.readFileSync(p, "utf8") !== text) { console.error(`DIFFERS: ${path.relative(root, p)}`); bad += 1; }
  }
  console.log(bad ? `${bad} committed file(s) differ from a fresh build` : "the committed extraction and report equal a fresh build");
  process.exit(bad ? 1 : 0);
}
fs.mkdirSync(outDir, { recursive: true });
for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(outDir, name), text);
console.log(`wrote ${Object.keys(files).length} files to ${path.relative(root, outDir) || "."}`);
