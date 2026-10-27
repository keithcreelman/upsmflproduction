// extension_history.js — what `ups_extension_master` says about who has already used a pre-trade extension on whom.
// Pure (no I/O): the caller reads the rows and says whether the read succeeded. Extracted unchanged from the /trade-workbench route so the
// rule has one home and one test; the route's behavior is identical, plus it now REPORTS whether the read succeeded.
//
// Canon §C4 / Keith 2026-05-24: once a franchise extends a player it cannot offer a pre-trade extension on him again while that extension
// contract is STILL ACTIVE (contract_end_year >= the current season); an expired one resets the right.
export function summarizeExtensionMaster(rows, season, padFid) {
  const pad = typeof padFid === "function" ? padFid : (x) => String(x || "");
  const cur = parseInt(season, 10) || 0;
  const playerSet = new Set();        // players extended by ANYONE this season (prunes preview rows)
  const pairSet = new Set();          // "fid|pid" — this franchise's extension on this player is still active
  for (const row of Array.isArray(rows) ? rows : []) {
    const pid = String(row?.player_id || "").replace(/\D/g, "");
    const fid = pad(row?.franchise_id || "");
    if (!pid) continue;
    if (String(row?.season) === String(season)) playerSet.add(pid);
    const endYear = parseInt(row?.contract_end_year, 10) || 0;
    if (fid && cur > 0 && endYear >= cur) pairSet.add(fid + "|" + pid);
  }
  return { playerSet, pairSet };
}
