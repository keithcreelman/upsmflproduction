// One-off generator: pins the exact SQL text and binds of the CLASSIC season-context loader (fpaLoadSeasonContext) as it is on origin/main, so
// tests/lineup_team_history.test.mjs can prove the beta's identity work left it untouched.
//   git show origin/main:worker/src/fpa_engine.js > /tmp/fpa_engine_main.mjs && node tests/helpers/make_classic_sql_pin.mjs /tmp/fpa_engine_main.mjs
import fs from "fs";
import path from "path";
import { pathToFileURL } from "url";
const E = await import(pathToFileURL(path.resolve(process.argv[2])).href);
const seen = [];
const ctx = await E.fpaLoadSeasonContext(async (sql, ...b) => { seen.push({ sql, binds: b }); return []; }, 2026);
fs.writeFileSync(new URL("../fixtures/fpa_classic_context_sql.json", import.meta.url), JSON.stringify({ note: "fpaLoadSeasonContext on origin/main bc607887's engine: the exact statements it runs", statements: seen, emptyContextKeys: Object.keys(ctx) }, null, 1));
console.log("pinned", seen.length, "statements; context keys", Object.keys(ctx).join(","));
