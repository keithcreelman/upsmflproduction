// TEMPORARY -- Sprint 0 proof (#1303/#1304) that a failing test turns the
// "Safe offline tests" check red. Reverted in the very next commit.
import assert from "node:assert/strict";
assert.equal(1 + 1, 3, "deliberate failure: CI must go red on this commit");
