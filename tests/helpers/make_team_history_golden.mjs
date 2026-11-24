// One-off generator, run ONCE on the pre-change route (worker/src/lineup_matchups.js at origin/main 7e91025b) to freeze the response the route
// returned for the fixture before W1. tests/lineup_team_history.test.mjs then proves every pre-existing field is byte for byte unchanged.
//   node tests/helpers/make_team_history_golden.mjs <path to the PRE-CHANGE lineup_matchups.js>
import fs from "fs";
import path from "path";
import { pathToFileURL } from "url";
import { loadFixture, runHandler } from "./team_history_fixture.mjs";
const src = process.argv[2];
if (!src) { console.error("usage: node make_team_history_golden.mjs <pre-change lineup_matchups.js>"); process.exit(2); }
const LM = await import(pathToFileURL(path.resolve(src)).href);
const fx = loadFixture();
const r = await runHandler(LM, fx, {});
if (r.status !== 200) throw new Error("status " + r.status);
const out = new URL("../fixtures/team_history_2026_wk10_golden.json", import.meta.url);
fs.writeFileSync(out, JSON.stringify({ version: r.json.version, queries: r.env.queries.length, calls: r.calls.length, payload: r.json }));
console.log("golden written:", fs.statSync(out).size, "bytes | version", r.json.version, "| statements", r.env.queries.length, "| MFL/other GETs", r.calls.length, "| playerWindow", Object.keys(r.json.playerWindow).length, "| attribution", JSON.stringify(r.json.attribution));
