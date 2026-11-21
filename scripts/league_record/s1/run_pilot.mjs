#!/usr/bin/env node
// League Record S1 pilot: build the A.J. Brown / HammerTime evidence bundle and report from the committed archive and snapshots. Read-only, offline, deterministic.
//
//   node scripts/league_record/s1/run_pilot.mjs                 write docs/league_record/pilot/{aj_brown_bundle.json,aj_brown_report.md,acceptance.json}
//   node scripts/league_record/s1/run_pilot.mjs --check         build and compare with the committed files; exit 1 if anything differs (CI-friendly)
//   node scripts/league_record/s1/run_pilot.mjs --out <dir>     write somewhere else
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildPilotBundle, stableStringify } from "./pilot.mjs";
import { renderReport } from "./report.mjs";
import { runAcceptance } from "./acceptance.mjs";
import { openArchive } from "./archive.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..", "..");
const args = process.argv.slice(2);
const check = args.includes("--check");
const outDir = args.includes("--out") ? path.resolve(args[args.indexOf("--out") + 1]) : path.join(root, "docs", "league_record", "pilot");

const bundle = await buildPilotBundle({ root });
const archive = await openArchive({ root });
const committedPath = path.join(outDir, "aj_brown_bundle.json");
const committed = fs.existsSync(committedPath) ? JSON.parse(fs.readFileSync(committedPath, "utf8")) : null;
const acceptance = await runAcceptance({ bundle, root, archive, rebuild: () => buildPilotBundle({ root }), committedBundle: check ? committed : null });
archive.close();
const files = { "aj_brown_bundle.json": `${stableStringify(bundle)}\n`, "aj_brown_report.md": renderReport(bundle, acceptance), "acceptance.json": `${stableStringify(acceptance)}\n` };

const failed = acceptance.filter((a) => a.pass === false);
if (check) {
  let bad = 0;
  for (const [name, text] of Object.entries(files)) {
    const p = path.join(outDir, name);
    if (!fs.existsSync(p) || fs.readFileSync(p, "utf8") !== text) { console.error(`DIFFERS: ${path.relative(root, p)}`); bad += 1; }
  }
  console.log(bad ? `${bad} committed file(s) differ from a fresh build` : "the committed bundle, report and acceptance results equal a fresh build");
  process.exit(bad || failed.length ? 1 : 0);
}
fs.mkdirSync(outDir, { recursive: true });
for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(outDir, name), text);
for (const a of acceptance) console.log(`${a.id} ${a.pass === true ? "PASS" : a.pass === false ? "FAIL" : "external"}  ${a.title}${a.detail ? `  [${a.detail}]` : ""}`);
console.log(`wrote ${Object.keys(files).length} files to ${path.relative(root, outDir) || "."}`);
process.exit(failed.length ? 1 : 0);
