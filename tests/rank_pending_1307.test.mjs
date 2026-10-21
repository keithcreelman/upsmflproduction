// Season ranks pending the clean recount are held back from /api/player-bundle (#1307).
//   node tests/rank_pending_1307.test.mjs
//
// Batch 1A restores 2025's missing playoff-week scores. For 1,059 more 2025
// player-seasons the weekly total then equals src_pointssummary's own basis,
// and every live player screen (desktop profile, FO v2, Roster Workbench,
// Rookie Hub, Team Operations, mobile sheet) prints pos_rank / pos_ppg_rank
// without a check. The 253 Pts and 429 PPG ranks that differ from a clean
// recount must not look verified, so the bundle returns them as null with a
// reason; every other row, field and season is untouched.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const m = await import(pathToFileURL(path.join(ROOT, "worker/src/rank_pending.js")).href);

assert.deepEqual(m.rankPendingCounts(), { 2025: { pos_rank: 253, pos_ppg_rank: 429 } });

// Listed (Laquon Treadwell 2025: stored WR 198 / 215, clean recount 195 / 214): both held.
const held = m.applyRankPending("12645", { season: 2025, pos_rank: 198, pos_ppg_rank: 215, season_points: 41.2, games_played: 9 });
assert.equal(held.pos_rank, null);
assert.equal(held.pos_ppg_rank, null);
assert.deepEqual(held.rank_pending, { fields: ["pos_rank", "pos_ppg_rank"], reason: m.RANK_PENDING_REASON });
assert.equal(held.season_points, 41.2);  // scores are never touched
assert.equal(held.games_played, 9);

// Not listed (Dak Prescott 2025: stored QB 4 / 5 equals the clean recount): unchanged, same object.
const dak = { season: 2025, pos_rank: 4, pos_ppg_rank: 5 };
assert.equal(m.applyRankPending("12620", dak), dak);
// Another season is never touched, even for a listed id.
const other = { season: 2024, pos_rank: 198, pos_ppg_rank: 215 };
assert.equal(m.applyRankPending("12645", other), other);
// A rank that is already null is not reported as held.
assert.equal(m.applyRankPending("12645", { season: 2025, pos_rank: null, pos_ppg_rank: null }).rank_pending, undefined);
// Numeric ids and string seasons behave the same.
assert.equal(m.applyRankPending(12645, { season: "2025", pos_rank: 198, pos_ppg_rank: 215 }).pos_rank, null);

// The bundle applies it on its D1 path, the only path that carries ranks.
const idx = fs.readFileSync(path.join(ROOT, "worker/src/index.js"), "utf8");
assert.ok(idx.includes('import { applyRankPending } from "./rank_pending.js";'));
assert.ok(idx.includes("bundle.career_summary = career.map((row) => applyRankPending(pid, row));"));

// Every live renderer turns a null rank into "—" (mobile: its existing 0), never a number.
for (const [file, needle] of [
  ["site/shared/player_profile_master.js", 'var fmtRank = function (r) { return (r == null || r <= 0) ? "—" : "#" + r; };'],
  ["site/rosters/v2/front_office.js", 'function foStatRank(r) { return (r == null || r <= 0) ? "—" : "#" + r; }'],
  ["site/rosters/roster_workbench.js", 'function fmtRank(r) { return (r == null || r <= 0) ? "—" : "#" + r; }'],
  ["site/rookies/rookie_draft_hub.js", 'const fmtRank = (r) => (r == null || r <= 0) ? "—" : `#${r}`;'],
  ["site/team_operations/team_operations.js", "(s.pos_rank != null ? '#' + escapeHtml(safeStr(s.pos_rank)) : '—')"],
  ["site/m/player_sheet.js", "ppgRank = Number(c.pos_ppg_rank || 0);"],
]) {
  assert.ok(fs.readFileSync(path.join(ROOT, file), "utf8").includes(needle), `${file}: null-rank rendering changed`);
}

console.log("rank_pending_1307: all checks passed");
