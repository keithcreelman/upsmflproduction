// Assembles the static Trade Builder preview (safe sample data, writes blocked) into a folder for any static host.
//   node scripts/build_trade_builder_preview.mjs <outDir>
import fs from "node:fs";
import path from "node:path";
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const out = path.resolve(process.argv[2] || "trade_builder_preview_dist");
fs.mkdirSync(out, { recursive: true });
fs.copyFileSync(path.join(root, "scripts/trade_builder_preview/index.html"), path.join(out, "index.html"));
for (const f of ["trade_rules.js", "trade_builder_core.js", "trade_builder_view.js"]) fs.copyFileSync(path.join(root, "site/shared", f), path.join(out, f));
fs.writeFileSync(path.join(out, "_headers"), "/*\n  X-Robots-Tag: noindex\n  Cache-Control: no-store\n");
console.log("built", out);
