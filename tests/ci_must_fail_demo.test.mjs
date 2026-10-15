// TEMPORARY -- round-1 proof (#1304) that a failing test still turns the
// "Safe offline tests" check red after the Codex corrections. Reverted next.
import assert from "node:assert/strict";
assert.equal(1 + 1, 3, "deliberate failure: CI must go red on this commit");
