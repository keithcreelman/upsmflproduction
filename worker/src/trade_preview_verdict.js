// Read-only Trade Builder preview summary. A preview never grants permission to send:
// the write routes recheck live state and MFL remains the final authority.
const statusOf = (value) => String(value && value.status || "unavailable");

export function tradePreviewVerdict({ compliance, assets, forfeits, lock }) {
  const checks = {
    cap: statusOf(compliance && compliance.cap),
    loaded_contracts: statusOf(compliance && compliance.loaded_contracts),
    assets: statusOf(assets),
    forfeited_picks: forfeits && forfeits.ok ? "ok" : forfeits && forfeits.code === "pick_forfeited" ? "blocked" : "unavailable",
    trade_lock: lock && (lock.state === "upcoming" || lock.state === "none") ? "ok" : lock && lock.state === "closed" ? "blocked" : "unavailable",
  };
  const reasons = [];
  if (checks.cap === "blocked") reasons.push({ code: "cap_ack_required", message: compliance.cap.message || "A cap acknowledgment may be needed." });
  else if (checks.cap !== "ok") reasons.push({ code: "cap_unavailable", message: "The salary cap could not be verified." });
  if (checks.loaded_contracts === "blocked" || checks.loaded_contracts === "needs_drops") reasons.push({ code: "loaded_contract_limit", message: compliance.loaded_contracts.message || "The loaded-contract limit would be exceeded." });
  else if (checks.loaded_contracts !== "ok") reasons.push({ code: "loaded_contracts_unavailable", message: "Loaded contracts could not be verified." });
  if (checks.assets !== "ok") reasons.push({ code: assets && assets.code || "assets_unavailable", message: assets && assets.message || "Trade assets could not be verified." });
  if (checks.forfeited_picks !== "ok") reasons.push({ code: forfeits && forfeits.code || "forfeit_check_unavailable", message: forfeits && forfeits.message || "Draft-pick forfeitures could not be checked." });
  if (checks.trade_lock !== "ok") reasons.push({ code: checks.trade_lock === "blocked" ? "trade_closed" : "trade_lock_unavailable", message: checks.trade_lock === "blocked" ? "MFL's trade calendar is closed." : "MFL's trade calendar could not be verified." });
  const skipped = Array.isArray(compliance && compliance.extension_skipped) ? compliance.extension_skipped : [];
  if (skipped.length) reasons.push({ code: "extension_unverified", message: "A pre-trade extension could not be approved from this preview." });
  const blocked = checks.loaded_contracts === "blocked" || checks.loaded_contracts === "needs_drops" || checks.assets === "blocked" || checks.forfeited_picks === "blocked" || checks.trade_lock === "blocked";
  const unavailable = Object.values(checks).includes("unavailable") || skipped.length > 0;
  return {
    status: blocked ? "blocked" : unavailable ? "unavailable" : checks.cap === "blocked" ? "needs_acknowledgment" : "provisional",
    // A preview cannot promise a send: write-time identity, hold and MFL checks still run.
    send_ready: false,
    checks,
    reasons,
    trade_lock: lock ? { state: lock.state, label: lock.label || "", start_unix: lock.start_unix || null, verified_at_utc: lock.verified_at_utc || null } : null,
  };
}
