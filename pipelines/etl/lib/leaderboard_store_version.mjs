// The calculation version a stored leaderboard board was built by (#1266).
//
// SHA-256 (first 16 hex) of the code that turns D1 rows into a board: index.js from the
// leaderboard's column lists (COL_SHARED …) through the live SQL and the row post-processing,
// up to the response. Comments and whitespace are ignored, so a comment edit doesn't force a
// rebuild; any change to the SQL or the post-processing does. worker/src/leaderboard_store.js
// carries the value it serves (LB_STORE.query_version) and tests/leaderboard_store.test.mjs
// recomputes it from the source, so the two can't drift.
import crypto from "node:crypto";

export function leaderboardQueryVersion(indexSrc) {
  const start = indexSrc.indexOf("const COL_SHARED = `a.gsis_id,");
  const end = indexSrc.indexOf("const lbResponse = jsonOut(200", start);
  if (start < 0 || end < 0) throw new Error("leaderboard code anchors not found in index.js");
  const code = indexSrc.slice(start, end)
    .replace(/--[^\n]*/g, "")
    .replace(/(^|[^:"'])\/\/[^\n]*/g, "$1")
    .replace(/\s+/g, " ");
  return crypto.createHash("sha256").update(code).digest("hex").slice(0, 16);
}
