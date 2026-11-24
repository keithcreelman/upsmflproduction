// The daily MFL snapshot keeps MFL's player list (#1503, Keith 2026-11-24): one read-only request a day, so every player's position is dated.
// Offline: reads the workflow file only; nothing is fetched.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { t, test, run } from "./fixtures/mini_test.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WF = fs.readFileSync(path.join(HERE, "..", ".github/workflows/mfl-daily-snapshot.yml"), "utf8");

test("players is one more type in the same read-only loop, from MFL's read API with the league id, pretty-printed like the rest", () => {
  const loop = WF.match(/for t in ([^;]+); do/);
  t.ok(loop, "the fetch loop is found");
  const types = loop[1].trim().split(/\s+/);
  t.deepEqual(types, ["salaries", "transactions", "rosters", "injuries", "league", "freeAgents", "draftResults", "weeklyResults", "schedule", "leagueStandings", "players"], "exactly one type added");
  t.match(WF, /salaries\|draftResults\|weeklyResults\|schedule\|leagueStandings\|players\)\n\s+BASE="https:\/\/api\.myfantasyleague\.com"/, "players goes to the read API host and keeps L=");
  t.equal((WF.match(/curl -fsSL/g) || []).length, 1, "still one curl, a GET with no credentials");
  t.doesNotMatch(WF, /APIKEY|MFL_USER_ID|Cookie|--cookie|-b /i, "no session or key is sent");
});

test("an empty player list fails the job before anything is committed, and every file's SHA-256 is recorded", () => {
  const guard = WF.indexOf("players (#1503): refuse an answer with no players"), commit = WF.indexOf("name: Commit");
  t.ok(guard > 0 && guard < commit, "the guard runs in the fetch step, before the commit step");
  t.match(WF, /sys\.exit\(0 if n >= 1000 else 1\)/, "fewer than 1,000 players is treated as a bad answer");
  t.match(WF, /_snapshot_sha256\.json/, "the per-file hashes are written next to the files");
  t.match(WF, /git add data\/mfl-snapshots/, "committed with the snapshot, as before");
});

await run();
