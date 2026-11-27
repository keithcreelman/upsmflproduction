// #1475 (Keith 2026-11-26): the Pts Agst engine's routes (/api/lineup-matchups, /api/fantasy-sos, Pts Agst + detail) read the
// league the request names, falling back to 74598 only when none is given. Before, all three hard-coded 74598, so the TEST
// deployment (which pins L=25625 and refuses 74598) had no game times, and the 2027 lineup planner could not move anyone.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { t, test, run } from "./fixtures/mini_test.mjs";

const SRC = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "worker", "src", "index.js"), "utf8");

test("the engine routes take the request's league; 74598 only when none is given", () => {
  t.doesNotMatch(SRC, /handle(?:LineupMatchups|FpaRequest)\(request, env, ctx, \{ jsonOut, lid: "74598" \}\)/, "no engine route hard-codes 74598 any more");
  t.equal((SRC.match(/handleLineupMatchups\(request, env, ctx, \{ jsonOut, lid: _fpaLeague\(\) \}\)/g) || []).length, 1);
  t.equal((SRC.match(/handleFpaRequest\(request, env, ctx, \{ jsonOut, lid: _fpaLeague\(\) \}\)/g) || []).length, 2);
  const m = /const _fpaLeague = \(\) => \(([^;]+)\);/.exec(SRC);
  t.ok(m, "the helper is defined once");
  const pick = new Function("L", "return (" + m[1] + ");");
  t.equal(pick(""), "74598", "no league named: the production league, as before");
  t.equal(pick("74598"), "74598"); t.equal(pick("25625"), "25625", "the test league when the request names it");
  t.equal(pick("25625;DROP"), "74598", "anything that is not a league id falls back"); t.equal(pick("../x"), "74598");
  const at = SRC.indexOf("const _fpaLeague"), use = SRC.indexOf("lid: _fpaLeague()");
  t.ok(at > 0 && at < use, "defined before its first use (no temporal dead zone)");
  t.ok(SRC.indexOf('const L = url.searchParams.get("L") || "";') < at, "L is the request's own L parameter, defined earlier in the same handler");
});

await run("fpa_league_from_request");
