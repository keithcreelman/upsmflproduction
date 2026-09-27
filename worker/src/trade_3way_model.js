// trade_3way_model.js — pure (no I/O) model for UPS 3-way trades.
//
// One place defines: the state machine, the asset-token grammar, the CANONICAL
// trade object every surface (mobile, desktop, Discord follow-ups) consumes, and
// the server-side permission decisions. trade_3way.js (engine, D1) and
// trade_3way_http.js (routes) import this; the tests import it directly.
//
// The canonical object is built from the D1 row ONLY (plus optional resolved
// names). Nothing here reads a request, a cookie, or the network.

export const STATUSES = ["collecting", "executing", "completed", "failed", "cancelled"];
export const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);

// The persisted state machine (ups_3way_trades.status). `cancel` is who the
// SERVER lets cancel from that state — the UI mirrors this, never invents it.
//
// EXECUTION is modelled separately and STRUCTURALLY in the execution ledger (worker/src/trade_execution.js, table ups_trade_executions):
//   blocked_cap  — both partners accepted, the salary-cap gate refused BEFORE any MFL write. The row stays `collecting` (never `failed`),
//                  both approvals are preserved, the cap is recomputed on every re-check, and it runs the moment the cap is legitimately fine.
//   executing → mfl_executed → postprocessing → completed | executed_needs_review   (MFL executed: permanent; never back to a pending state)
// The persisted `status` column (constrained to the five values below) only says collecting / executing / completed / failed / cancelled;
// the ledger says what MFL has actually done.
export const STATE_MACHINE = {
  collecting: {
    terminal: false, next: ["executing", "cancelled"],
    cancel: "initiator_only",   // a commissioner may cancel only by ACTING AS the initiator; see decideCancel
    meaning: "Waiting on the two partners to Accept in their Discord DM (or, once both did, on the salary cap — see blocked_cap in the ledger).",
  },
  executing: {
    terminal: false, next: ["completed", "failed"],
    cancel: "nobody",
    meaning: "Both partners accepted; the commissioner bot is running the MFL legs.",
  },
  completed: {
    terminal: true, next: [], cancel: "nobody",
    meaning: "Every MFL leg landed (or, in dry-run mode, the deal was recorded without moving rosters).",
  },
  failed: {
    terminal: true, next: ["executing"], // only via the commish /admin/3way/retry route
    cancel: "nobody",
    meaning: "Execution failed; needs the commissioner. Never auto-retried once a leg landed.",
  },
  cancelled: {
    terminal: true, next: [], cancel: "nobody",
    meaning: "Called off by the initiator or the commissioner, or declined by a partner.",
  },
};

function safeStr(v) { return String(v == null ? "" : v).trim(); }
function safeInt(v, fb) { const n = parseInt(v, 10); return Number.isFinite(n) ? n : (fb == null ? 0 : fb); }
export function padFid(v) { const s = safeStr(v).replace(/\D/g, ""); return s ? s.padStart(4, "0").slice(-4) : ""; }
function isFid(v) { return /^\d{4}$/.test(safeStr(v)); }

// ───────────────────────── asset tokens ─────────────────────────
// Builder tokens (mobile + desktop emit these; trade_3way.js toMflAsset()
// translates them to MFL form at execution):
//   P_<playerId>                       player
//   FP_<origFid>_<year>_<round>        future pick (FP_<year>_<round>_<orig> also accepted)
//   DP_<year>_<round>_<slot>           current-year draft pick
//   BB_<dollars>                       cap money (BlindBid$) — normally injected at execution
export function parseAssetToken(token) {
  const t = safeStr(token);
  let m;
  if ((m = /^P_(\d+)$/.exec(t))) return { token: t, kind: "player", player_id: m[1] };
  if (t.startsWith("FP_")) {
    const parts = t.slice(3).split("_").filter(Boolean);
    const year = parts.find((p) => /^20\d\d$/.test(p)) || "";
    const rest = parts.filter((p) => p !== year);
    const orig = rest.find((p) => p.length === 4) || rest[0] || "";
    const round = rest.find((p) => p !== orig) || "";
    if (year && /^\d{1,2}$/.test(round) && isFid(orig)) {
      return { token: t, kind: "pick", pick: { year: Number(year), round: Number(round), slot: null, original_fid: padFid(orig) } };
    }
    return { token: t, kind: "unknown" };
  }
  if ((m = /^DP_(20\d\d)_(\d{1,2})_(\d{1,2})$/.exec(t))) {
    return { token: t, kind: "pick", pick: { year: Number(m[1]), round: Number(m[2]), slot: Number(m[3]), original_fid: "" } };
  }
  if ((m = /^BB_(\d+)$/.exec(t))) return { token: t, kind: "cap", cap_k: Math.round(Number(m[1]) / 1000) };
  return { token, kind: "unknown" };
}

function ordinal(n) {
  const v = n % 100;
  return `${n}${(v >= 11 && v <= 13) ? "th" : ({ 1: "st", 2: "nd", 3: "rd" }[n % 10] || "th")}`;
}

// ───────────────────── rows -> canonical trade ─────────────────────
function parseJsonArray(text) {
  try { const v = JSON.parse(text || "[]"); return { ok: Array.isArray(v), value: Array.isArray(v) ? v : [] }; }
  catch (_) { return { ok: false, value: [] }; }
}

// Decode why a cancelled/failed row is what it is, WITHOUT leaking internals.
export function decodeReason(row) {
  const status = safeStr(row.status);
  const fr = safeStr(row.failure_reason);
  if (status === "cancelled") {
    let m;
    if ((m = /^declined_by_(\d{4})$/.exec(fr))) return { code: "declined", by_fid: m[1], by_role: "partner" };
    if ((m = /^cancelled_by_initiator(?::via_(\w+))?$/.exec(fr))) return { code: "cancelled", by_fid: padFid(row.initiator_fid), by_role: "initiator", via: m[1] || "" };
    // Commissioner ADMINISTRATIVE cancel (distinct basis; see decideAdminCancel). The legacy
    // `cancelled_by_commish:<fid>` rows written by pre-2026-09-25 code decode the same way (no reason on file).
    if (fr === "cancelled_by_commissioner") {
      return { code: "cancelled_by_commissioner", by_fid: "", by_role: "commissioner", reason: safeStr(row.cancel_reason), at_utc: safeStr(row.cancelled_at_utc) };
    }
    if (/^cancelled_by_commish:\d{4}$/.test(fr)) return { code: "cancelled_by_commissioner", by_fid: "", by_role: "commissioner", reason: "", at_utc: "" };
    return { code: "cancelled", by_fid: "", by_role: "unknown" };
  }
  if (status === "failed") return { code: "failed", by_fid: "", by_role: "system" };
  if (status === "completed" && fr === "dry_run") return { code: "dry_run", by_fid: "", by_role: "system" };
  return null;
}

/**
 * Build the canonical trade object.
 * @param row     ups_3way_trades row
 * @param opts    { names?: {fid:name}, players?: {id:{name,position,nfl_team}}, viewer?: viewer }
 *   viewer = { fid, isCommish, sessionFid } as produced by the HTTP layer; when
 *   absent, permissions are all false (never assume rights).
 */
export function buildCanonical3Way(row, opts) {
  opts = opts || {};
  const names = opts.names || null;
  const players = opts.players || null;
  const viewer = opts.viewer || null;
  const issues = [];

  const status = safeStr(row.status);
  if (!STATUSES.includes(status)) issues.push(`unknown_status:${status || "(empty)"}`);

  const slots = [
    { slot: "initiator", fid: padFid(row.initiator_fid), stored: safeStr(row.initiator_name), state: "initiator" },
    { slot: "team_b", fid: padFid(row.team_b_fid), stored: safeStr(row.team_b_name), state: safeStr(row.team_b_state) || "pending" },
    { slot: "team_c", fid: padFid(row.team_c_fid), stored: safeStr(row.team_c_name), state: safeStr(row.team_c_state) || "pending" },
  ];
  const fidSeen = new Set();
  const participants = slots.map((s) => {
    if (!isFid(s.fid)) issues.push(`invalid_participant:${s.slot}`);
    else if (fidSeen.has(s.fid)) issues.push(`duplicate_participant:${s.fid}`);
    else fidSeen.add(s.fid);
    const mflName = names && isFid(s.fid) ? safeStr(names[s.fid]) : "";
    const name = mflName || s.stored;
    const name_source = mflName ? "mfl" : (s.stored ? "stored" : "missing");
    if (!name) issues.push(`unresolved_participant:${s.slot}`);
    return { slot: s.slot, fid: s.fid, name: name || (s.fid ? `Team ${s.fid}` : ""), name_source, resolved: !!name, state: s.state };
  });
  // Participants first; any other franchise (e.g. the ORIGINAL owner of a traded
  // pick, who is not in the deal) comes from the league-wide name map.
  const nameOf = (fid) => {
    const p = participants.find((x) => x.fid === fid);
    if (p) return p.name;
    const n = names && isFid(fid) ? safeStr(names[fid]) : "";
    return n || (fid ? `Team ${fid}` : "");
  };
  const inDeal = new Set(participants.map((p) => p.fid).filter(isFid));

  // movements ---------------------------------------------------------------
  const parsedLegs = parseJsonArray(row.legs_json);
  if (!parsedLegs.ok) issues.push("legs_unparseable");
  const movements = [];
  parsedLegs.value.forEach((m, idx) => {
    if (!m || typeof m !== "object") { issues.push(`bad_movement:${idx}`); return; }
    const from = padFid(m.from), to = padFid(m.to);
    const tokens = Array.isArray(m.asset_tokens) ? m.asset_tokens.map(safeStr).filter(Boolean) : [];
    const capK = Math.max(0, safeInt(m.cap_k, 0));
    if (!tokens.length && !capK) return; // an empty movement moves nothing
    if (!inDeal.has(from) || !inDeal.has(to) || from === to) { issues.push(`bad_movement:${idx}`); return; }
    const assets = tokens.map((tok) => {
      const a = parseAssetToken(tok);
      if (a.kind === "player") {
        const p = players && players[a.player_id];
        const label = p && safeStr(p.name) ? safeStr(p.name) : `Player #${a.player_id}`;
        if (!p || !safeStr(p.name)) issues.push(`unresolved_player:${a.player_id}`);
        return { ...a, label, position: safeStr(p && p.position), nfl_team: safeStr(p && p.nfl_team), resolved: !!(p && safeStr(p.name)) };
      }
      if (a.kind === "pick") {
        const orig = a.pick.original_fid;
        const via = orig && orig !== from ? ` (via ${nameOf(orig)})` : "";
        const label = a.pick.slot
          ? `${a.pick.year} R${a.pick.round}.${String(a.pick.slot).padStart(2, "0")}`
          : `${a.pick.year} ${ordinal(a.pick.round)}-round pick${via}`;
        return { ...a, label, resolved: true };
      }
      if (a.kind === "cap") return { ...a, label: `$${a.cap_k}K cap money`, resolved: true };
      issues.push(`unknown_asset:${safeStr(tok).slice(0, 40)}`);
      return { ...a, label: "Unavailable asset", resolved: false, unavailable: true };
    });
    if (capK > 0 && !assets.some((a) => a.kind === "cap")) {
      assets.push({ token: `BB_${capK * 1000}`, kind: "cap", cap_k: capK, label: `$${capK}K cap money`, resolved: true });
    }
    movements.push({
      index: movements.length, from: { fid: from, name: nameOf(from) }, to: { fid: to, name: nameOf(to) },
      summary: safeStr(m.summary), cap_k: capK, assets,
    });
  });
  if (parsedLegs.ok && !movements.length) issues.push("no_movements");

  // per-franchise sides (identical on every surface) -----------------------
  const sides = participants.map((p) => {
    const sends = movements.filter((m) => m.from.fid === p.fid).map((m) => ({ to: m.to, assets: m.assets }));
    const receives = movements.filter((m) => m.to.fid === p.fid).map((m) => ({ from: m.from, assets: m.assets }));
    const capOut = movements.filter((m) => m.from.fid === p.fid).reduce((s, m) => s + m.cap_k, 0);
    const capIn = movements.filter((m) => m.to.fid === p.fid).reduce((s, m) => s + m.cap_k, 0);
    return { fid: p.fid, name: p.name, sends, receives, cap_out_k: capOut, cap_in_k: capIn };
  });

  // extensions --------------------------------------------------------------
  const parsedExt = parseJsonArray(row.extension_requests_json);
  if (!parsedExt.ok && safeStr(row.extension_requests_json)) issues.push("extensions_unparseable");
  const extensions = parsedExt.value.filter((e) => e && typeof e === "object").map((e) => ({
    player_id: safeStr(e.player_id), player_name: safeStr(e.player_name),
    from_fid: padFid(e.from_franchise_id), to_fid: padFid(e.to_franchise_id),
    term: safeStr(e.extension_term), new_aav_future: e.new_aav_future != null ? safeInt(e.new_aav_future, 0) : null,
    contract_info: safeStr(e.preview_contract_info_string),
  }));

  // state view + reason -----------------------------------------------------
  const reason = decodeReason(row);
  const waitingOn = [];
  if (status === "collecting") {
    if (safeStr(row.team_b_state) !== "accepted") waitingOn.push(participants[1].fid);
    if (safeStr(row.team_c_state) !== "accepted") waitingOn.push(participants[2].fid);
  }
  const terminal = TERMINAL_STATUSES.has(status);
  const ex = opts.execution && typeof opts.execution === "object" ? opts.execution : null;
  const bothAccepted = safeStr(row.team_b_state) === "accepted" && safeStr(row.team_c_state) === "accepted";
  const blockedCap = status === "collecting" && bothAccepted && !!ex && ex.state === "blocked_cap";
  const needsReview = !!ex && ex.state === "executed_needs_review";
  let code = status, label = status, message = "";
  if (blockedCap) {
    code = "blocked_cap"; label = "Waiting on the salary cap";
    message = `${safeStr(ex.block && ex.block.message) || "The salary cap can't be confirmed for this trade right now."} Everyone has already accepted; it will go through as soon as the cap allows (re-check to try again).`;
  } else if (status === "collecting") {
    label = waitingOn.length ? `Waiting on ${waitingOn.map(nameOf).join(" & ")}` : "Both accepted";
    message = "Both partners have to Accept in their Discord DM before anything moves.";
  } else if (status === "executing") { label = "Processing"; message = "All three teams accepted. The trade is being processed in MFL."; }
  else if (status === "completed" && needsReview) {
    code = "executed_needs_review"; label = "Executed — needs commissioner review";
    message = "The trade WAS executed in MFL. Its contract/extension processing did not finish and needs commissioner review (nothing is needed from you).";
  } else if (status === "completed") {
    label = reason && reason.code === "dry_run" ? "Recorded (not executed)" : "Completed";
    message = reason && reason.code === "dry_run"
      ? "All three teams accepted, but the league is in dry-run mode: no MFL rosters were changed."
      : "Every leg of the trade landed in MFL.";
  } else if (status === "failed" && needsReview) {
    label = "Partly executed — needs the commissioner";
    message = "Some legs of this trade WERE executed in MFL and the rest could not be. It will not be retried automatically; the commissioner has been alerted.";
  } else if (status === "failed") { label = "Failed"; message = "The trade could not be completed. Nothing was executed. The commissioner has been alerted."; }
  else if (status === "cancelled") {
    if (reason && reason.code === "declined") { label = `Declined by ${nameOf(reason.by_fid)}`; message = "A partner declined, so the trade is off."; }
    else if (reason && reason.code === "cancelled_by_commissioner") {
      label = "Called off by the commissioner";
      message = reason.reason ? `The commissioner called off this trade. Reason: ${reason.reason}` : "The commissioner called off this trade.";
    }
    else { label = "Called off"; message = "The team that started this trade called it off."; }
  }
  if (issues.length) { code = terminal ? code : "incomplete"; }

  // permissions (server-authoritative) --------------------------------------
  const permissions = { ...permissionsFor(row, viewer), can_recheck: false };
  // a trade waiting only on the salary cap can be re-checked by anyone in it (or the commissioner); the server re-verifies everything on the call
  if (blockedCap && permissions.can_view) permissions.can_recheck = true;
  const cancelled = status === "cancelled" && reason
    ? { by_fid: reason.by_fid, by_role: reason.by_role, code: reason.code, ...(reason.via ? { acted_via: reason.via } : {}),
        ...(reason.code === "cancelled_by_commissioner" ? { basis: "cancelled_by_commissioner", reason: reason.reason || "", at_utc: reason.at_utc || "" } : {}) }
    : null;

  const trade = {
    id: safeStr(row.id), league_id: safeStr(row.league_id), season: safeStr(row.season),
    status, terminal,
    state_view: { code, label, message, terminal, waiting_on: waitingOn },
    participants, movements, sides, extensions,
    notes: safeStr(row.notes),
    timestamps: {
      created_at_utc: safeStr(row.created_at_utc), updated_at_utc: safeStr(row.updated_at_utc),
      executed_at_utc: safeStr(row.executed_at_utc),
    },
    version: safeStr(row.updated_at_utc) || safeStr(row.created_at_utc),
    mfl_trade_ids: safeStr(row.mfl_trade_ids).split(",").map((s) => s.trim()).filter(Boolean),
    cancelled,
    executed: (status === "completed" && !(reason && reason.code === "dry_run")) || (!!ex && ["mfl_executed", "postprocessing", "completed", "executed_needs_review"].includes(ex.state)),
    execution: ex ? {
      state: ex.state, mfl_executed: !!ex.mfl_executed, needs_review: needsReview, blocked: blockedCap,
      ...(blockedCap ? { block: { kind: safeStr(ex.block && ex.block.kind), message: safeStr(ex.block && ex.block.message), violations: Array.isArray(ex.block && ex.block.violations) ? ex.block.violations : [], checked_at_utc: safeStr(ex.block && ex.block.checked_at_utc) } } : {}),
      ...(viewer && viewer.isCommish && needsReview ? { failed_step: safeStr(ex.failed_step), failure_detail: safeStr(ex.failure_detail) } : {}),
    } : null,
    permissions,
    integrity: { ok: issues.length === 0, issues },
    viewer: viewer ? { fid: padFid(viewer.fid), role: viewerRole(row, viewer) } : null,
  };
  // Raw failure text is diagnostic for the commissioner only.
  if (viewer && viewer.isCommish && safeStr(row.failure_reason)) trade.failure_detail = safeStr(row.failure_reason);
  return trade;
}

// ───────────────────────── authorization ─────────────────────────
// viewer = { fid: effective acting franchise, isCommish: bool (PROVEN session), sessionFid }
export function viewerRole(row, viewer) {
  if (!viewer) return "none";
  const fid = padFid(viewer.fid);
  if (fid && fid === padFid(row.initiator_fid)) return "initiator";
  if (fid && (fid === padFid(row.team_b_fid) || fid === padFid(row.team_c_fid))) return "partner";
  return viewer.isCommish ? "commish" : "none";
}

export function canView(row, viewer) { return viewerRole(row, viewer) !== "none"; }

/**
 * Decide a cancel. Order matters and is part of the contract.
 *
 * RULING (Keith, 2026-09-25): OWNER cancellation is limited to the initiator, acting through THEIR OWN
 * proven session. A commissioner may cancel a `collecting` 3-way only through the separate
 * ADMINISTRATIVE action (decideAdminCancel: explicit COMMISH_API_KEY + a reason) — never by acting as
 * the initiator, never by session, never by impersonation. So here:
 *
 *   1. not a participant, not commissioner  -> 403 forbidden   (never reveals status)
 *   2. participant but not initiator         -> 403 only_initiator_can_cancel
 *   3. commissioner (own session or acting as anyone, or the admin key) but not the initiator's OWN
 *      session                               -> 403 commissioner_use_admin_action
 *   4. already cancelled                     -> 200 idempotent (already_cancelled)
 *   5. any other non-collecting state        -> 409 cannot_cancel_<status>
 *   6. collecting                            -> ok
 */
export function decideCancel(row, viewer) {
  const role = viewerRole(row, viewer);
  if (role === "none") return { ok: false, http: 403, code: "forbidden", message: "You aren't part of this trade." };
  if (role === "partner") {
    return { ok: false, http: 403, code: "only_initiator_can_cancel",
      message: "Only the team that started this 3-way can call it off. You can decline it from your Discord DM." };
  }
  const useAdmin = { ok: false, http: 403, code: "commissioner_use_admin_action",
    message: "A commissioner calls off a 3-way with the administrative cancel (it needs the commissioner API key and a reason). Acting as the team that started it doesn't count." };
  if (role === "commish") return useAdmin;
  // role === "initiator": only the initiator's OWN session counts. A commissioner acting as the initiator
  // (sessionFid differs) or the admin key (no session franchise) is an impersonation, not an owner cancel.
  if (viewer.via === "apikey" || padFid(viewer.sessionFid) !== padFid(row.initiator_fid)) return useAdmin;
  const status = safeStr(row.status);
  if (status === "cancelled") return { ok: true, idempotent: true, code: "already_cancelled", role };
  // Canon (A6): once all three have accepted, nobody can cancel it. A trade waiting only on the salary cap (both partners in) is in exactly
  // that position: it is not "collecting" approvals any more. (The commissioner's administrative cancel is the one exit — see decideAdminCancel.)
  if (status === "collecting" && safeStr(row.team_b_state) === "accepted" && safeStr(row.team_c_state) === "accepted") {
    return { ok: false, http: 409, code: "cannot_cancel_all_accepted", message: "All three teams have accepted, so this can no longer be called off. It is waiting only on the salary cap; ask the commissioner if it needs to be stopped." };
  }
  if (status === "collecting") return { ok: true, role };
  const why = {
    executing: "All three teams accepted and the trade is being processed, so it can no longer be called off.",
    completed: "This trade already went through.",
    failed: "This trade failed during processing and needs the commissioner.",
  }[status] || "This trade can't be called off in its current state.";
  return { ok: false, http: 409, code: `cannot_cancel_${status || "unknown"}`, message: why };
}

export const ADMIN_CANCEL_BASIS = "cancelled_by_commissioner";
export const ADMIN_CANCEL_REASON_MAX = 500;

/** A commissioner's reason: trimmed, control characters removed, 1..500 chars. Returns "" when unusable. */
export function cleanAdminReason(v) {
  return safeStr(v).replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, ADMIN_CANCEL_REASON_MAX);
}

/**
 * Decide a commissioner ADMINISTRATIVE cancel (RULING, Keith 2026-09-25). Authority (the explicit
 * COMMISH_API_KEY) is proven by the caller; this decides only what the STATE allows:
 *   - a non-empty reason is required                          -> 400 reason_required
 *   - `collecting`                                            -> ok
 *   - already cancelled BY THE COMMISSIONER                   -> 200 idempotent (already_cancelled)
 *   - anything else (executing, completed, failed, expired,
 *     or cancelled by the initiator / a decline)              -> 409 cannot_cancel_<status>
 * It never touches MFL and never executes a trade.
 */
export function decideAdminCancel(row, reason) {
  const clean = cleanAdminReason(reason);
  if (!clean) return { ok: false, http: 400, code: "reason_required", message: "Give a reason for calling off this trade." };
  const status = safeStr(row.status);
  const fr = safeStr(row.failure_reason);
  if (status === "cancelled" && (fr === ADMIN_CANCEL_BASIS || /^cancelled_by_commish:\d{4}$/.test(fr))) return { ok: true, idempotent: true, code: "already_cancelled", reason: clean };
  if (status === "collecting") return { ok: true, reason: clean };
  const why = {
    cancelled: "This trade was already called off (by the initiator or a decline).",
    executing: "All three teams accepted and the trade is being processed, so it can no longer be called off.",
    completed: "This trade already went through.",
    failed: "This trade failed during processing. Use the retry / manual reconciliation tools, not cancel.",
  }[status] || "This trade can't be called off in its current state.";
  return { ok: false, http: 409, code: `cannot_cancel_${status || "unknown"}`, message: why };
}

export function permissionsFor(row, viewer) {
  if (!viewer) return { can_view: false, can_cancel: false, cancel_block_code: "unauthenticated", cancel_block_reason: "Sign in to see this trade." };
  const can_view = canView(row, viewer);
  if (!can_view) return { can_view: false, can_cancel: false, cancel_block_code: "forbidden", cancel_block_reason: "You aren't part of this trade." };
  const d = decideCancel(row, viewer);
  // An already-cancelled trade is "cancel-idempotent" but is not offered as an action.
  const can_cancel = d.ok && !d.idempotent;
  return { can_view: true, can_cancel, cancel_block_code: can_cancel ? "" : (d.code || ""), cancel_block_reason: can_cancel ? "" : (d.message || (d.idempotent ? "Already called off." : "")) };
}
