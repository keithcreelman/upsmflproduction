#!/usr/bin/env node
/**
 * Regression test for the playerRosterStatus parser behind GET /api/lineup.
 *
 * Extracts _lineupParseRosterStatuses + _lineupAnswerFromStatuses VERBATIM out
 * of worker/src/index.js (rather than re-implementing them, which would test a
 * copy instead of the code that ships) and runs them against the real captured
 * payload in tests/fixtures/ plus the shape variations MFL is documented to
 * produce.
 *
 * The invariant that matters most, and the reason this file exists:
 *   a read we could not understand must NEVER come back as "no lineup".
 * The editor offers Optimal on "no lineup". Collapsing an unreadable answer
 * into an empty one is how an owner's deliberate start gets painted over and
 * submitted away.
 *
 * Run: node tests/lineup_parser_test.js
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const SRC = fs.readFileSync(path.join(ROOT, "worker/src/index.js"), "utf8");

function extract(startMarker) {
  const i = SRC.indexOf(startMarker);
  if (i === -1) throw new Error("could not find " + startMarker + " — did it get renamed?");
  // Walk braces from the first { after the marker to its match.
  const open = SRC.indexOf("{", i);
  let depth = 0;
  for (let k = open; k < SRC.length; k += 1) {
    if (SRC[k] === "{") depth += 1;
    else if (SRC[k] === "}") {
      depth -= 1;
      if (depth === 0) return SRC.slice(i, k + 1);
    }
  }
  throw new Error("unbalanced braces extracting " + startMarker);
}

// Minimal stand-ins for the worker helpers the two functions call.
const safeStr = (v) => (v == null ? "" : String(v));
const _rdhPadFid = (v) => {
  const s = safeStr(v).replace(/\D/g, "");
  return s ? s.padStart(4, "0") : "";
};

const body =
  extract("const _lineupParseRosterStatuses") + ";\n" +
  extract("const _lineupAnswerFromStatuses") + ";\n" +
  "return { _lineupParseRosterStatuses, _lineupAnswerFromStatuses };";
// eslint-disable-next-line no-new-func
const { _lineupParseRosterStatuses, _lineupAnswerFromStatuses } =
  new Function("safeStr", "_rdhPadFid", body)(safeStr, _rdhPadFid);

const FIX = JSON.parse(
  fs.readFileSync(path.join(__dirname, "fixtures/mfl_player_roster_status_L74598_0008.json"), "utf8")
);

let ok = true;
function check(name, cond, detail) {
  console.log((cond ? "PASS" : "FAIL") + " — " + name + (detail ? "  (" + detail + ")" : ""));
  if (!cond) ok = false;
}
const answer = (payload, fid) => _lineupAnswerFromStatuses(_lineupParseRosterStatuses(payload, fid));

// ── the real captured payload ────────────────────────────────────────────────
{
  const a = answer(FIX, "0008");
  check("real payload: known:true", a.known === true);
  check("real payload: starters are exactly the S ids",
    a.starters.join(",") === "16614,15789,13674,17115,15253",
    a.starters.join(","));
  check("real payload: NS is never a starter", !a.starters.includes("17043"));
  check("real payload: TS is never a starter", !a.starters.includes("17514"));
}

// ── key order varies (both levels) — the live payload really does this ───────
{
  const flipped = { playerRosterStatuses: { playerStatus: [
    { roster_franchise: { franchise_id: "0008", status: "S" }, id: "111" },
    { id: "222", roster_franchise: { status: "NS", franchise_id: "0008" } },
  ] } };
  const a = answer(flipped, "0008");
  check("key order flipped: still resolves", a.known === true && a.starters.join(",") === "111", a.starters.join(","));
}

// ── roster_franchise as an ARRAY (docs: multiple copies of a player) ─────────
{
  const arr = { playerRosterStatuses: { playerStatus: [
    { id: "333", roster_franchise: [{ franchise_id: "0008", status: "S" }] },
  ] } };
  const a = answer(arr, "0008");
  check("roster_franchise as array: resolves", a.known === true && a.starters.join(",") === "333");
}

// ── another franchise's starter must never leak in ──────────────────────────
{
  const mixed = { playerRosterStatuses: { playerStatus: [
    { id: "444", roster_franchise: { franchise_id: "0005", status: "S" } },
    { id: "555", roster_franchise: { franchise_id: "0008", status: "S" } },
  ] } };
  const a = answer(mixed, "0008");
  check("other franchise ignored", a.starters.join(",") === "555", a.starters.join(","));
  const only = answer({ playerRosterStatuses: { playerStatus: [
    { id: "444", roster_franchise: { franchise_id: "0005", status: "S" } },
  ] } }, "0008");
  check("ONLY other franchise -> unknown, not no_record", only.known === false && only.state !== "no_record", only.state);
}

// ── all R = MFL saying no lineup is submitted ────────────────────────────────
{
  const allR = { playerRosterStatuses: { playerStatus: [
    { id: "666", roster_franchise: { franchise_id: "0008", status: "R" } },
    { id: "777", roster_franchise: { franchise_id: "0008", status: "R" } },
  ] } };
  const a = answer(allR, "0008");
  check("all R -> no_record", a.state === "no_record" && a.known === false, a.state);
}

// ── THE INVARIANT: an unreadable answer is never an empty one ───────────────
[
  ["null payload", null],
  ["empty object", {}],
  ["no playerRosterStatuses block", { version: "1.0" }],
  ["block present but not an object", { playerRosterStatuses: "nope" }],
  ["playerStatus empty", { playerRosterStatuses: { playerStatus: [] } }],
  ["entries are junk", { playerRosterStatuses: { playerStatus: [1, "x", null] } }],
  ["unknown status X", { playerRosterStatuses: { playerStatus: [
    { id: "888", roster_franchise: { franchise_id: "0008", status: "X" } },
  ] } }],
].forEach(([name, payload]) => {
  const a = answer(payload, "0008");
  check("unreadable never no_record: " + name,
    a.known === false && a.state !== "no_record", "state=" + a.state);
});

// ── an unknown status alone is not a starter, and must not crash ────────────
{
  const a = answer({ playerRosterStatuses: { playerStatus: [
    { id: "999", roster_franchise: { franchise_id: "0008", status: "X" } },
    { id: "1000", roster_franchise: { franchise_id: "0008", status: "S" } },
  ] } }, "0008");
  check("unknown status not counted as a starter", a.starters.join(",") === "1000", a.starters.join(","));
}

console.log("");
console.log(ok ? "ALL CHECKS PASSED" : "SOME CHECKS FAILED");
process.exit(ok ? 0 : 1);
