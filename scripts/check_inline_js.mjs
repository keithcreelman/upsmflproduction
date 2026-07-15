#!/usr/bin/env node
// Syntax-check the inline <script> of every HTML page we ship.
//
// Why this exists: a single unescaped apostrophe in a TOOLTIP —
//   '...told the league ahead of time they'd be out of pocket...'
// — is a SyntaxError that kills the ENTIRE IIFE. The Commish Settings page sat
// on "Loading…" forever because renderShell() is the last statement in that IIFE
// and never ran. eslint never saw it (it lints .js, not inline <script>), and
// `node --check` on the .js files passed, so CI was green while the page was
// dead. Prose inside a JS string is a code path; it needs a compiler.
import { readFileSync } from "node:fs";
import { globSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const files = globSync("site/**/*.html");
const dir = mkdtempSync(join(tmpdir(), "inlinejs-"));
let bad = 0, checked = 0;
for (const f of files) {
  const html = readFileSync(f, "utf8");
  const blocks = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
  blocks.forEach((js, i) => {
    if (!js.trim()) return;
    const tmp = join(dir, `${f.replace(/[^a-z0-9]/gi, "_")}_${i}.js`);
    writeFileSync(tmp, js);
    checked++;
    try { execFileSync(process.execPath, ["--check", tmp], { stdio: "pipe" }); }
    catch (e) {
      bad++;
      const msg = String(e.stderr || e.message).split("\n").slice(0, 4).join("\n");
      console.error(`\n✖ ${f}  (inline <script> #${i + 1})\n${msg}`);
    }
  });
}
console.log(`${bad ? "\n" : ""}inline-js: ${checked} block(s) checked across ${files.length} file(s), ${bad} broken`);
process.exit(bad ? 1 : 0);
