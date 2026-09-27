// trade_accept_integrity.js — accept-time integrity for two-team trades.
//
// PRINCIPLE: an ACCEPT request is an *action request*, never the source of the trade's contents.
// What is being accepted is defined by the offer MFL is holding (pendingTrades: who, what) plus the
// server's own outbox record of that offer (extension + cap-money detail MFL cannot express), and
// only when that record provably matches what MFL holds. Anything the client sends about the
// contents (`payload`, `offer_extension_requests`, `offer_twb_meta`, `will_give_up/receive`, a
// payload hash) is compared against that authority: identical → ignored (the authority is used);
// different → the accept is refused before anything is written.
//
// Pure functions only. index.js supplies the closures that need MFL / D1 (token building, exports).

function s(v) { return String(v == null ? "" : v).trim(); }
function pad4(v) { const d = s(v).replace(/\D/g, ""); return d ? d.padStart(4, "0").slice(-4) : ""; }
function arr(v) { return Array.isArray(v) ? v : v == null ? [] : [v]; }

// ── tokens ──────────────────────────────────────────────────────────────────────────
// MFL token forms: 14056 (player) · FP_<origFid>_<year>_<round> · DP_<round0>_<slot0> · BB_<dollars>
export function normalizeToken(t) {
  let x = s(t).toUpperCase();
  if (!x) return "";
  const bb = /^BB_(.+)$/.exec(x);
  if (bb) { const n = Number(bb[1].replace(/,/g, "")); return Number.isFinite(n) ? `BB_${n}` : x; }
  if (/^P_\d+$/.test(x)) x = x.slice(2);
  const dp = /^DP_(\d+)_(\d+)$/.exec(x);          // DP_00_03 and DP_0_3 are the same pick
  if (dp) return `DP_${Number(dp[1])}_${Number(dp[2])}`;
  return x;
}
export function tokenSet(list) {
  const src = Array.isArray(list) ? list : s(list).split(/\s*,\s*/);
  return [...new Set(src.map(normalizeToken).filter(Boolean))].sort();
}
const sameSet = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * Per-franchise token sets for a payload, orientation-independent.
 * `lists` = index.js buildTradeProposalAssetLists(payload): {left,right,willGiveUp,willReceive,isValid,...}
 * left gives willGiveUp, right gives willReceive (cap money already folded in as a BB_ token).
 */
export function tokensByFranchise(lists) {
  const out = {};
  const L = pad4(lists && lists.left && lists.left.franchise_id), R = pad4(lists && lists.right && lists.right.franchise_id);
  if (L) out[L] = tokenSet(lists.willGiveUp);
  if (R) out[R] = tokenSet(lists.willReceive);
  return out;
}

/** Does a stored/candidate payload describe exactly the offer MFL holds? */
export function bindPayloadToMfl({ lists, from, to, mflGiveCsv, mflReceiveCsv }) {
  const f = pad4(from), t = pad4(to);
  if (!lists || !lists.isValid) return { ok: false, reason: "payload_assets_invalid" };
  const by = tokensByFranchise(lists);
  const keys = Object.keys(by).sort();
  if (keys.length !== 2 || !keys.includes(f) || !keys.includes(t) || f === t) return { ok: false, reason: "payload_franchises_differ_from_mfl" };
  if (!sameSet(by[f], tokenSet(mflGiveCsv))) return { ok: false, reason: "offering_side_differs_from_mfl" };
  if (!sameSet(by[t], tokenSet(mflReceiveCsv))) return { ok: false, reason: "receiving_side_differs_from_mfl" };
  return { ok: true };
}

// ── extension identity ───────────────────────────────────────────────────────────────
export function extensionKeys(rows) {
  return arr(rows).filter((r) => r && typeof r === "object").map((r) => [
    s(r.player_id).replace(/\D/g, ""), pad4(r.from_franchise_id), pad4(r.to_franchise_id),
    s(r.extension_term).toUpperCase(), Number(r.new_TCV) || 0, Number(r.new_aav_future) || 0, Number(r.new_contract_length) || 0,
  ].join("|")).sort();
}

// ── client claims ───────────────────────────────────────────────────────────────────
/** Everything in the request body that purports to describe the trade's contents. */
export function collectClientClaims(body) {
  const b = body && typeof body === "object" ? body : {};
  const payload = [b.payload, b.offer_payload].find((p) => p && typeof p === "object" && Array.isArray(p.teams) && p.teams.length) || null;
  const extRows = [];
  if (Array.isArray(b.offer_extension_requests)) extRows.push(...b.offer_extension_requests);
  if (payload && Array.isArray(payload.extension_requests)) extRows.push(...payload.extension_requests);
  const meta = b.offer_twb_meta && typeof b.offer_twb_meta === "object" ? b.offer_twb_meta : null;
  if (meta && Array.isArray(meta.ext)) extRows.push(...meta.ext);
  return {
    payload,
    extRows: extRows.filter((r) => r && typeof r === "object"),
    give: s(b.offer_will_give_up || b.will_give_up || b.WILL_GIVE_UP),
    receive: s(b.offer_will_receive || b.will_receive || b.WILL_RECEIVE),
    hash: s(b.payload_hash || b.offer_payload_hash || b.offer_hash),
  };
}

/**
 * Compare claims to the authority. Empty claims are "not claiming" (mobile sends none). A non-empty
 * claim must match the authority on everything that IDENTIFIES the trade: which assets each franchise
 * sends, cap money, direction, extension requests, MFL's own will_give_up/will_receive, and the payload
 * hash. Display fields (an asset's salary / contract text / taxi flag, as the client happens to render
 * them) are NOT compared: the server never uses them — cap money is re-derived from live rosters — so
 * they are ignored rather than made a source of false refusals. Returns what differs (empty = ok).
 */
export function compareClaims({ claims, authLists, authExtRows, from, to, mflGiveCsv, mflReceiveCsv, claimLists, trailerHash }) {
  const diffs = [];
  const f = pad4(from), t = pad4(to);
  const authBy = tokensByFranchise(authLists);
  if (claims.payload) {
    const claimBy = claimLists ? tokensByFranchise(claimLists) : {};
    for (const fid of new Set([...Object.keys(authBy), ...Object.keys(claimBy)])) {
      if (!sameSet(authBy[fid] || [], claimBy[fid] || [])) diffs.push({ field: "assets", franchise_id: fid });
    }
  }
  if (claims.give && !sameSet(tokenSet(claims.give), tokenSet(mflGiveCsv))) diffs.push({ field: "will_give_up", franchise_id: f });
  if (claims.receive && !sameSet(tokenSet(claims.receive), tokenSet(mflReceiveCsv))) diffs.push({ field: "will_receive", franchise_id: t });
  if (claims.extRows.length && !sameSet(extensionKeys(claims.extRows), extensionKeys(authExtRows))) diffs.push({ field: "extension_requests" });
  if (claims.hash && trailerHash && claims.hash !== s(trailerHash)) diffs.push({ field: "payload_hash", note: "stale_or_altered_offer" });
  return diffs;
}

// ── live-state revalidation (all fail-closed at the call site) ───────────────────────────
/** rosters export → {playerOwner: {pid→fid}, salary: {"fid|pid"→dollars}, taxi: {"fid|pid"→bool}, active: {fid→n}} */
export function indexRosters(rostersData) {
  const franchises = arr(rostersData && rostersData.rosters && (rostersData.rosters.franchise || rostersData.rosters.franchises)).filter(Boolean);
  const playerOwner = {}, salary = {}, taxi = {}, active = {};
  for (const fr of franchises) {
    const fid = pad4(fr.id || fr.franchise_id);
    if (!fid) continue;
    active[fid] = 0;
    for (const pl of arr(fr.player || fr.players)) {
      const pid = s(pl && pl.id).replace(/\D/g, "");
      if (!pid) continue;
      const status = s(pl.status).toUpperCase();
      playerOwner[pid] = fid;
      salary[`${fid}|${pid}`] = Number(pl.salary) || 0;
      taxi[`${fid}|${pid}`] = status.includes("TAXI");
      if (!status.includes("TAXI") && !status.includes("INJURED") && status !== "IR") active[fid] += 1;
    }
  }
  return { playerOwner, salary, taxi, active };
}

/** futureDraftPicks export → {"FP_<orig>_<year>_<round>" → currentOwnerFid} */
export function indexFuturePicks(data) {
  const out = {};
  for (const f of arr(data && data.futureDraftPicks && data.futureDraftPicks.franchise)) {
    const fid = pad4(f && f.id);
    for (const p of arr(f && (f.futureDraftPick || f.futureDraftPicks))) {
      const orig = pad4(p.originalPickFor || p.originalOwner || fid);
      out[`FP_${orig}_${s(p.year)}_${s(p.round)}`.toUpperCase()] = fid;
    }
  }
  return out;
}

/** draftResults export → {"DP_<round0>_<slot0>" → {owner, made}} (MFL rounds/slots are 1-based) */
export function indexDraftPicks(data) {
  const out = {};
  const root = data && data.draftResults;
  for (const u of arr(root && root.draftUnit)) {
    for (const dp of arr(u && (u.draftPick || u.pick))) {
      const r = Number(dp.round), p = Number(dp.pick);
      if (!Number.isFinite(r) || !Number.isFinite(p)) continue;
      out[`DP_${r - 1}_${p - 1}`] = { owner: pad4(dp.franchise || dp.currentOwner), made: !!s(dp.player) };
    }
  }
  return out;
}

/** Every player and pick must still be owned by the franchise the trade says is sending it. */
export function ownershipViolations({ byFranchise, rosters, futurePicks, draftPicks }) {
  const bad = [];
  for (const [fid, tokens] of Object.entries(byFranchise)) {
    for (const tok of tokens) {
      if (tok.startsWith("BB_")) continue;
      if (/^\d+$/.test(tok)) {
        const owner = rosters.playerOwner[tok] || "";
        if (owner !== fid) bad.push({ token: tok, kind: "player", sender: fid, actual_owner: owner });
      } else if (tok.startsWith("FP_")) {
        const owner = futurePicks ? (futurePicks[tok] || "") : null;
        if (owner === null) bad.push({ token: tok, kind: "future_pick", sender: fid, actual_owner: "", unverifiable: true });
        else if (owner !== fid) bad.push({ token: tok, kind: "future_pick", sender: fid, actual_owner: owner });
      } else if (tok.startsWith("DP_")) {
        const info = draftPicks ? draftPicks[tok] : null;
        if (!info) bad.push({ token: tok, kind: "draft_pick", sender: fid, actual_owner: "", unverifiable: true });
        else if (info.made || info.owner !== fid) bad.push({ token: tok, kind: "draft_pick", sender: fid, actual_owner: info.owner, already_made: !!info.made });
      } else {
        bad.push({ token: tok, kind: "unknown", sender: fid, actual_owner: "" });
      }
    }
  }
  return bad;
}

/** Canon A6: round-6 picks are not tradeable; future picks reach at most current year + 1. */
export function pickEligibilityViolations({ byFranchise, season }) {
  const bad = [];
  const yr = Number(season);
  for (const [fid, tokens] of Object.entries(byFranchise)) {
    for (const tok of tokens) {
      const fp = /^FP_\d{4}_(\d{4})_(\d+)$/.exec(tok);
      if (fp) {
        if (Number(fp[2]) === 6) bad.push({ token: tok, sender: fid, reason: "round_6_pick_not_tradeable" });
        if (Number.isFinite(yr) && Number(fp[1]) > yr + 1) bad.push({ token: tok, sender: fid, reason: "future_pick_beyond_horizon" });
      }
      const dp = /^DP_(\d+)_\d+$/.exec(tok);
      if (dp && Number(dp[1]) === 5) bad.push({ token: tok, sender: fid, reason: "round_6_pick_not_tradeable" });
    }
  }
  return bad;
}

/** Canon A6/E1: cap money ≤ 50% of the traded-away NON-TAXI salary; each side needs a non-salary asset. */
export function capMoneyViolations({ byFranchise, rosters }) {
  const bad = [];
  for (const [fid, tokens] of Object.entries(byFranchise)) {
    const nonSalary = tokens.filter((t) => !t.startsWith("BB_"));
    const bbDollars = tokens.filter((t) => t.startsWith("BB_")).reduce((a, t) => a + (Number(t.slice(3)) || 0), 0);
    if (bbDollars > 0 && !nonSalary.length) bad.push({ franchise_id: fid, reason: "cap_money_without_non_salary_asset" });
    let nonTaxi = 0;
    for (const pid of tokens.filter((t) => /^\d+$/.test(t))) {
      const key = `${fid}|${pid}`;
      if (!rosters.taxi[key]) nonTaxi += rosters.salary[key] || 0;
    }
    const maxDollars = Math.floor(nonTaxi / 2000) * 1000;
    if (bbDollars > maxDollars) bad.push({ franchise_id: fid, reason: "cap_money_over_50pct", traded_dollars: bbDollars, max_dollars: maxDollars });
  }
  return bad;
}

// Post-trade salary cap (hard) and roster counts (advisory) live in ./trade_cap_authority.js.
