/* UPS 3-way trade view — ONE implementation shared by the mobile app (site/m) and
 * the desktop Trade War Room (site/trades).
 *
 * Both surfaces fetch the SAME canonical trade from the worker
 *   GET  /api/trades/3way?id=<uuid>         -> { ok, trade }
 *   GET  /api/trades/3way?franchise_id=...  -> { ok, trades }
 *   POST /api/trades/3way/cancel  { id }    -> { ok, code, already, trade }
 * (worker/src/trade_3way_model.js#buildCanonical3Way) and render it with the
 * functions below, so the two can no longer drift.
 *
 * Rules this module enforces (tests/trade_3way_clients.test.mjs):
 *   - a FAILED request is never rendered as "no trades" and never flips the UI to
 *     "cancelled": only a server-confirmed canonical trade changes local state;
 *   - a stale copy never overwrites a newer one (preferNewer, by `version`);
 *   - every string reaches the DOM through esc().
 *
 * Works as a browser global (window.UPS_TRADE_3WAY) and under Node (module.exports).
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.UPS_TRADE_3WAY = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var api = {};

  function str(v) { return v == null ? "" : String(v); }
  function esc(v) {
    return str(v).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  api.esc = esc;

  // ───────────────────────── response interpretation ─────────────────────────
  // `res` is { status, ok, body } from a completed fetch, or { networkError: true }
  // when the request itself failed. Nothing here returns "empty success" for a failure.
  var GENERIC = {
    network: "Can't reach the server. Check your connection and try again.",
    unauthenticated: "Sign in to MFL to see and manage 3-way trades.",
    session_expired: "Your MFL sign-in expired. Re-open this from MFL and try again.",
    forbidden: "You aren't part of this trade.",
    not_found: "This 3-way trade doesn't exist (it may have been removed).",
    unavailable: "Trades are temporarily unavailable. Try again in a moment.",
    error: "Something went wrong. Try again.",
  };
  // Server text is shown ONLY when it came from the 3-way HTTP layer (it always sets a
  // `code`) and isn't a 5xx: those messages are written for owners. Anything else — a
  // generic 500, a proxy/CDN error page, the global guard — gets our own wording, so
  // internal error text can never reach a screen.
  function serverMessage(res, fallback) {
    var b = res && res.body;
    var m = b && (b.error || b.message);
    var ownerSafe = b && typeof b.code === "string" && b.code && res.status < 500;
    return ownerSafe && m && typeof m === "string" ? m : fallback;
  }
  function failureKind(res) {
    if (!res || res.networkError) return "network";
    var s = res.status, c = res.body && res.body.code;
    if (s === 401 || c === "unauthenticated" || c === "session_expired") return "unauthenticated";
    if (s === 403) return "forbidden";
    if (s === 404) return "not_found";
    if (s === 409) return "conflict";
    if (s === 503 || s >= 500) return "unavailable";
    return "error";
  }
  api.failureKind = failureKind;

  function failure(res) {
    var kind = failureKind(res);
    var code = res && res.body && res.body.code;
    var base = kind === "unauthenticated" && code === "session_expired" ? GENERIC.session_expired : GENERIC[kind === "conflict" ? "error" : kind];
    return { kind: kind, message: serverMessage(res, base), retryable: kind === "network" || kind === "unavailable" };
  }

  api.interpretLoad = function (res) {
    if (res && !res.networkError && res.ok && res.body && res.body.ok !== false && res.body.trade && res.body.trade.id) {
      return { kind: "ok", trade: res.body.trade };
    }
    // A 200 with no trade is a contract violation, not "nothing there".
    if (res && res.ok && !(res.body && res.body.trade)) return { kind: "error", message: GENERIC.error, retryable: true };
    return failure(res);
  };

  api.interpretList = function (res) {
    if (res && !res.networkError && res.ok && res.body && res.body.ok !== false && Array.isArray(res.body.trades)) {
      return { kind: "ok", trades: res.body.trades };
    }
    if (res && res.ok && res.body && Array.isArray(res.body.three_way)) return { kind: "ok", trades: res.body.three_way };
    return failure(res); // NEVER an empty list on failure
  };

  // `applied` is true ONLY when the server confirmed the trade is cancelled. Callers
  // must change local state from `trade`, never optimistically.
  api.interpretCancel = function (res) {
    if (res && !res.networkError && res.ok && res.body && res.body.ok === true) {
      var tr = res.body.trade;
      if (tr && tr.status === "cancelled") {
        return { kind: res.body.already ? "already" : "cancelled", applied: true, trade: tr,
          message: res.body.already ? "This trade was already called off." : "3-way called off." };
      }
      // Success without a confirming canonical trade: don't assume — make the caller re-fetch.
      return { kind: "unconfirmed", applied: false, trade: null, message: "Couldn't confirm the cancellation. Refreshing…" };
    }
    var f = failure(res);
    var b = res && res.body;
    return { kind: f.kind, applied: false, trade: (b && b.trade) || null, code: b && b.code, message: f.message, retryable: f.retryable };
  };

  // A stale copy must never replace a newer one (versions are ISO timestamps).
  api.preferNewer = function (current, incoming) {
    if (!incoming || !incoming.id) return current || null;
    if (!current || current.id !== incoming.id) return incoming;
    return str(incoming.version) >= str(current.version) ? incoming : current;
  };

  // ───────────────────────────── presentation helpers ─────────────────────────────
  api.tone = function (trade) {
    var code = trade && trade.state_view && trade.state_view.code;
    return ({ collecting: "wait", executing: "busy", completed: "ok", failed: "bad", cancelled: "off", incomplete: "warn", blocked_cap: "warn", executed_needs_review: "warn" })[code] || "off";
  };

  function assetLine(a) {
    var meta = [a.position, a.nfl_team].filter(Boolean).join(" · ");
    var cls = "t3w-asset" + (a.unavailable ? " t3w-asset-missing" : "") + (a.kind === "cap" ? " t3w-asset-cap" : "");
    return '<span class="' + cls + '">' + esc(a.label) + (meta ? ' <small>' + esc(meta) + '</small>' : "") + '</span>';
  }
  api.assetLine = assetLine;

  function fmtWhen(iso) {
    if (!iso) return "";
    var d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    try { return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }); }
    catch (e) { return d.toISOString().slice(0, 16).replace("T", " "); }
  }

  var STATE_TAG = { initiator: "Started it", accepted: "Accepted", pending: "Waiting", declined: "Declined" };

  function sideHtml(side, participant, terminal) {
    var tag = participant ? (STATE_TAG[participant.state] || participant.state) : "";
    // On a closed trade "Waiting" would be a lie: they simply never answered.
    if (participant && terminal && participant.state === "pending") tag = "No response";
    function col(title, rows, dirWord) {
      if (!rows.length) return '<div class="t3w-col"><h5>' + esc(title) + '</h5><p class="t3w-none">Nothing</p></div>';
      return '<div class="t3w-col"><h5>' + esc(title) + '</h5><ul>' + rows.map(function (r) {
        var other = (r.to || r.from) || {};
        return '<li><span class="t3w-dir">' + esc(dirWord) + ' ' + esc(other.name) + '</span>' +
          r.assets.map(assetLine).join("") + '</li>';
      }).join("") + '</ul></div>';
    }
    return '<article class="t3w-side" data-t3w-fid="' + esc(side.fid) + '">' +
      '<h4 class="t3w-team">' + esc(side.name) + (tag ? ' <span class="t3w-tag t3w-tag-' + esc(participant.state) + '">' + esc(tag) + '</span>' : "") + '</h4>' +
      col("Sends", side.sends, "to") + col("Receives", side.receives, "from") +
    '</article>';
  }

  api.renderDetail = function (trade, opts) {
    opts = opts || {};
    var cs = opts.cancel || {};            // { busy, confirming, error, success }
    var sv = trade.state_view || {};
    var perms = trade.permissions || {};
    var role = trade.viewer && trade.viewer.role;
    var roleText = role === "initiator" ? "You started this" : role === "partner" ? "You're a partner" : role === "commish" ? "Commissioner view" : "";
    var h = '<section class="t3w" data-t3w-id="' + esc(trade.id) + '" data-t3w-version="' + esc(trade.version) + '" data-t3w-state="' + esc(sv.code) + '">';
    h += '<header class="t3w-head"><span class="t3w-pill t3w-tone-' + api.tone(trade) + '">' + esc(sv.label) + '</span>' +
      (roleText ? '<span class="t3w-role">' + esc(roleText) + '</span>' : "") + '</header>';
    if (sv.message) h += '<p class="t3w-msg">' + esc(sv.message) + '</p>';
    if (trade.integrity && !trade.integrity.ok) {
      h += '<div class="t3w-warn" role="alert"><b>Some of this trade\'s data is incomplete or unavailable.</b> ' +
        'What is shown is what could be read; nothing has been hidden. Contact the commissioner if it looks wrong.</div>';
    }
    h += '<div class="t3w-sides">' + (trade.sides || []).map(function (s, i) { return sideHtml(s, (trade.participants || [])[i], !!trade.terminal); }).join("") + '</div>';
    var ex = trade.execution || null;
    // Both partners accepted but the salary cap is holding the trade: say who and by how much, keep the accepts visible, offer a re-check.
    if (ex && ex.blocked) h += api.renderBlock(ex, trade.permissions || {}, opts.recheck || {}, { viewerFid: trade.viewer && trade.viewer.fid, ackBusy: opts.ackBusy, ackMessage: opts.ackMessage, ackOk: opts.ackOk });
    if (trade.compliance && !trade.terminal && !(ex && ex.blocked)) h += api.renderCompliance(trade.compliance, {});
    if ((trade.extensions || []).length) {
      h += '<div class="t3w-ext"><h5>Pre-trade extensions</h5><ul>' + trade.extensions.map(function (e) {
        var term = e.term === "2YR" ? "+2 yr" : "+1 yr";
        return '<li>' + esc(e.player_name || ("Player " + e.player_id)) + ' <small>' + esc(term) + (e.new_aav_future ? " · $" + Math.round(e.new_aav_future / 1000) + "K AAV" : "") + '</small></li>';
      }).join("") + '</ul></div>';
    }
    if (trade.notes) h += '<div class="t3w-note"><b>Note:</b> ' + esc(trade.notes) + '</div>';
    var ts = trade.timestamps || {};
    h += '<footer class="t3w-meta">Started ' + esc(fmtWhen(ts.created_at_utc)) +
      (ts.updated_at_utc && ts.updated_at_utc !== ts.created_at_utc ? ' · updated ' + esc(fmtWhen(ts.updated_at_utc)) : "") +
      ((trade.mfl_trade_ids || []).length ? ' · MFL trade ' + esc(trade.mfl_trade_ids.join(", ")) : "") + '</footer>';

    // actions: shown ONLY when the server said this viewer may cancel
    if (perms.can_cancel) {
      if (cs.confirming) {
        h += '<div class="t3w-confirm" role="alertdialog" aria-label="Confirm cancelling this 3-way trade">' +
          '<p><b>Call off this 3-way trade?</b> The other two teams will be told it\'s off. This can\'t be undone.</p>' +
          '<div class="t3w-btns"><button type="button" class="t3w-btn" data-t3w-act="keep"' + (cs.busy ? " disabled" : "") + '>Keep it</button>' +
          '<button type="button" class="t3w-btn t3w-btn-danger" data-t3w-act="confirm-cancel"' + (cs.busy ? " disabled" : "") + '>' +
          (cs.busy ? "Cancelling…" : "Yes, call it off") + '</button></div></div>';
      } else {
        h += '<div class="t3w-btns"><button type="button" class="t3w-btn t3w-btn-danger" data-t3w-act="cancel"' + (cs.busy ? " disabled" : "") + '>Cancel 3-way</button></div>';
      }
    } else if (!trade.terminal && perms.cancel_block_reason) {
      h += '<p class="t3w-why">' + esc(perms.cancel_block_reason) + '</p>';
    }
    if (cs.success) h += '<div class="t3w-status t3w-status-ok" role="status" aria-live="polite">' + esc(cs.success) + '</div>';
    if (cs.error) h += '<div class="t3w-status t3w-status-bad" role="alert">' + esc(cs.error) + '</div>';
    h += '</section>';
    return h;
  };

  // ───────────── salary cap (hard) + roster counts (advisory): shown BEFORE anyone accepts ─────────────
  // `c` is the server's compliance object ({cap, roster}) — the SAME calculation the accept enforces
  // (worker/src/trade_cap_authority.js). Nothing here computes a cap number; it only presents the server's.
  //   cap.status    "ok" | "blocked" | "unavailable"   → blocked/unavailable can NOT be accepted
  //   roster.status "ok" | "warn"    | "unavailable"   → advisory only; never blocks, never a legal certification
  function money(n) { return "$" + Math.round(Number(n) || 0).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ","); }
  api.money = money;

  // ── salary-cap overage ACKNOWLEDGMENT (Keith's ruling, 2026-09-28, separate from the hard
  // roster/cap block above): a proven overage no longer itself blocks the trade -- it just needs
  // the AFFECTED franchise's own owner to say "yes, I see it" before an accept/execution can go
  // through. `capAck` is the server's per-franchise picture ({satisfied, per_franchise:[{
  // franchise_id, franchise_name, amount_over, status:"acknowledged"|"missing"|"stale", signature?}]});
  // nothing here decides who is over or by how much -- that's still the cap section above.
  function ackRow(f, viewerFid, opts) {
    var mine = !!viewerFid && f.franchise_id === viewerFid;
    var badge = f.status === "acknowledged" ? '<span class="t3w-ack-badge t3w-ack-badge-ok">Acknowledged</span>'
      : mine ? '<span class="t3w-ack-badge t3w-ack-badge-you">Needs your OK</span>'
      : '<span class="t3w-ack-badge t3w-ack-badge-wait">Waiting on ' + esc(f.franchise_name || f.franchise_id) + '</span>';
    var h = '<li class="t3w-ack-row"><span class="t3w-cr-name">' + esc(f.franchise_name || f.franchise_id) + '</span>' +
      '<span class="t3w-cr-num">' + esc(money(f.amount_over)) + ' over</span>' + badge;
    if (mine && f.status !== "acknowledged") {
      h += '<button type="button" class="t3w-btn t3w-btn-primary t3w-ack-btn" data-t3w-act="ack-cap" data-t3w-ack-fid="' + esc(f.franchise_id) +
        '" data-t3w-ack-sig="' + esc(f.signature || "") + '"' + (opts.ackBusy ? " disabled" : "") + '>' +
        (opts.ackBusy ? "Acknowledging\u2026" : "Acknowledge " + money(f.amount_over) + " over the cap") + '</button>';
    }
    return h + '</li>';
  }
  api.renderCapAck = function (capAck, viewerFid, opts) {
    opts = opts || {};
    if (!capAck || !Array.isArray(capAck.per_franchise) || !capAck.per_franchise.length) return "";
    var rows = capAck.per_franchise.map(function (f) { return ackRow(f, viewerFid, opts); }).join("");
    var h = '<div class="t3w-ack" role="status"><b>' + (capAck.satisfied ? "Acknowledged" : "Needs acknowledgment before this can go through") + '</b>' +
      '<ul class="t3w-crows t3w-ack-list" aria-label="Salary cap overage acknowledgment">' + rows + '</ul>';
    if (opts.ackMessage) h += '<p class="t3w-status t3w-status-' + (opts.ackOk ? "ok" : "bad") + '" role="status" aria-live="polite">' + esc(opts.ackMessage) + '</p>';
    return h + '</div>';
  };

  // ── loaded-contract CONDITIONAL DROPS (Keith's ruling, 2026-09-29, the fix for the Hammer
  // Times gap: building/reviewing an offer as the sender showed NO warning at all). A franchise
  // projected over the 5-loaded-contract limit may still trade once its OWN owner has selected
  // enough of ITS OWN loaded-contract players to drop. `dropReqs` is `loaded_contracts.drop_
  // requirements` from the server's compliance object -- ALWAYS present for every over-limit
  // franchise, whether or not anyone has picked anything yet, so "who still owes a pick" is
  // always visible to every viewer, not just the affected owner.
  //   opts.viewerFid      whose own picker (if any) is interactive
  //   opts.playerNames    { player_id -> {name, position} } -- the CALLER's own roster/player
  //                       data; this module has none of its own and never re-derives loaded-
  //                       contract classification client-side (that reasoning -- a schedule-based
  //                       BL can look flat by suffix alone -- is exactly the Hammer Times gap).
  //   opts.selections     { franchise_id -> Set/array of currently-checked-but-not-yet-submitted
  //                       player ids } -- lets a picker keep the owner's in-progress checks across
  //                       re-renders (e.g. while other UI state updates) without losing them.
  //   opts.dropBusy / opts.dropMessage / opts.dropOk   the same busy/status pattern as cap-ack.
  //   opts.interactive     false -> render the summary + already-selected list only, no checkboxes
  //                       or confirm button (the offer-DETAIL view: everyone sees the requirement
  //                       and what's picked, but only the picker context is where a pick is made).
  function dropCandidateLabel(pid, playerNames) {
    var nm = playerNames && playerNames[pid];
    if (!nm) return "Player " + pid;
    return str(nm.name || ("Player " + pid)) + (nm.position ? " · " + str(nm.position) : "");
  }
  function dropRow(f, viewerFid, opts) {
    var mine = !!viewerFid && f.franchise_id === viewerFid;
    var badge = f.satisfied ? '<span class="t3w-ack-badge t3w-ack-badge-ok">Selected</span>'
      : mine ? '<span class="t3w-ack-badge t3w-ack-badge-you">Needs your pick</span>'
      : '<span class="t3w-ack-badge t3w-ack-badge-wait">Waiting on ' + esc(f.franchise_name || f.franchise_id) + '</span>';
    var validSelected = (f.selected || []).filter(function (x) { return x.valid; }).map(function (x) { return x.player_id; });
    var h = '<li class="t3w-ack-row t3w-drop-row"><span class="t3w-cr-name">' + esc(f.franchise_name || f.franchise_id) + '</span>' +
      '<span class="t3w-cr-num">' + esc(f.loaded_before) + ' → ' + esc(f.projected) + '</span>' +
      '<span class="t3w-cr-flag">' + esc(f.required_drops) + ' drop' + (f.required_drops === 1 ? "" : "s") + ' required</span>' + badge;
    if (validSelected.length) {
      h += '<p class="t3w-small">Selected: ' + validSelected.map(function (pid) { return esc(dropCandidateLabel(pid, opts.playerNames)); }).join(", ") + '</p>';
    }
    if (mine && opts.interactive !== false) {
      var cands = f.candidates || [];
      var checkedSet = (opts.selections && opts.selections[f.franchise_id]) || null;
      if (cands.length) {
        var boxes = cands.map(function (pid) {
          var checked = checkedSet ? (checkedSet.indexOf ? checkedSet.indexOf(pid) !== -1 : !!checkedSet[pid]) : validSelected.indexOf(pid) !== -1;
          return '<label class="t3w-drop-cand"><input type="checkbox" data-t3w-drop-fid="' + esc(f.franchise_id) + '" data-t3w-drop-pid="' + esc(pid) + '"' +
            (checked ? " checked" : "") + (opts.dropBusy ? " disabled" : "") + '/> ' + esc(dropCandidateLabel(pid, opts.playerNames)) + '</label>';
        }).join("");
        h += '<div class="t3w-drop-picker" data-t3w-drop-fid="' + esc(f.franchise_id) + '">' + boxes + '</div>' +
          // Keith's ruling (2026-09-29): "show that limitation in the owner-facing consent
          // copy." Updated same day for Keith's SEQUENCE ruling: required drops are confirmed
          // BEFORE the trade is attempted, always (docs/LOADED_CONTRACT_DROP_EXECUTION_DESIGN.md
          // §2.2/§2.4.3b) -- never the reverse. That removes the "if the trade happens first"
          // branch this copy used to show (drop-first is no longer one of two live
          // possibilities), but does NOT remove the real risk on the other side: if this drop
          // is confirmed and the trade THEN fails, restoration is a manual, non-atomic, never-
          // guaranteed workaround (§2.4.3b's own "what can and cannot be restored" section),
          // not a promise this copy may overstate. Shown here, before the confirm click,
          // because the risk is real under the CURRENTLY DECIDED manual-review model (§2.4) --
          // it does not wait on execution code being built.
          '<p class="t3w-small">⚠️ If this trade needs your drop, the drop is confirmed FIRST, before the trade is ever attempted — so your roster never ends up over the 5-loaded-contract limit because of this deal. But if this drop is confirmed and the trade then fails for any reason, restoration is not guaranteed: the commissioner can attempt to get the player back only if nobody else has claimed them as a free agent in the meantime, and even then it is a manual, multi-step process, not automatic. Confirming this selection does not mean the drop has happened yet.</p>' +
          '<button type="button" class="t3w-btn t3w-btn-primary t3w-drop-confirm" data-t3w-act="select-drops" data-t3w-drop-fid="' + esc(f.franchise_id) + '"' +
          (opts.dropBusy ? " disabled" : "") + '>' + (opts.dropBusy ? "Saving…" : "Confirm drop selection") + '</button>';
      } else {
        h += '<p class="t3w-small">No eligible loaded-contract player was found on your roster to select — contact the commissioner.</p>';
      }
    }
    return h + '</li>';
  }
  api.renderLoadedContractDrops = function (dropReqs, viewerFid, opts) {
    opts = opts || {};
    if (!Array.isArray(dropReqs) || !dropReqs.length) return "";
    var rows = dropReqs.map(function (f) { return dropRow(f, viewerFid, opts); }).join("");
    var allSatisfied = dropReqs.every(function (f) { return f.satisfied; });
    var h = '<div class="t3w-ack t3w-drops" role="status"><b>' + (allSatisfied ? "Conditional drops selected" : "Conditional drops needed before this can go through") + '</b>' +
      '<ul class="t3w-crows t3w-ack-list" aria-label="Conditional loaded-contract drops">' + rows + '</ul>';
    if (opts.dropMessage) h += '<p class="t3w-status t3w-status-' + (opts.dropOk ? "ok" : "bad") + '" role="status" aria-live="polite">' + esc(opts.dropMessage) + '</p>';
    return h + '</div>';
  };

  api.renderCompliance = function (c, opts) {
    opts = opts || {};
    if (!c || !c.cap || !c.roster) {
      return '<section class="t3w-comp" data-t3w-cap="unavailable" data-t3w-roster="unavailable"><div class="t3w-cap t3w-cap-unavailable" role="alert"><b>Salary cap</b>' +
        '<p>We couldn\'t verify the salary cap for this trade right now.' + (opts.gate ? ' It can\'t be accepted until we can.' : '') + '</p></div></section>';
    }
    var cap = c.cap, ro = c.roster;
    var acked = cap.status === "blocked" && opts.capAck && opts.capAck.satisfied;
    var capTitle = cap.status === "blocked" ? (acked ? "Over the salary cap \u2014 acknowledged" : "Over the salary cap \u2014 needs acknowledgment")
      : cap.status === "ok" ? "Salary cap \u2014 every team stays under" : "Salary cap \u2014 couldn\'t be verified";
    var capMsg = cap.status === "unavailable"
      ? "We couldn\'t verify the salary cap for this trade right now." + (opts.gate ? " It can\'t be accepted until we can \u2014 try again in a moment." : "")
      : cap.status === "blocked" ? str(cap.message) : "";
    var capRows = (cap.rows || []).map(function (r) {
      return '<li class="' + (r.over_by > 0 ? "t3w-over" : "") + '"><span class="t3w-cr-name">' + esc(r.franchise_name || r.franchise_id) + '</span>' +
        '<span class="t3w-cr-num">' + esc(money(r.used_after)) + ' of ' + esc(money(r.cap_dollars)) + '</span>' +
        (r.over_by > 0 ? '<span class="t3w-cr-flag">over by ' + esc(money(r.over_by)) + '</span>' : '<span class="t3w-cr-room">' + esc(money(r.room_after)) + ' room</span>') + '</li>';
    }).join("");
    var h = '<section class="t3w-comp" data-t3w-cap="' + esc(cap.status) + '" data-t3w-roster="' + esc(ro.status) + '">';
    h += '<div class="t3w-cap t3w-cap-' + esc(acked ? "ok" : cap.status) + '" role="' + (cap.status === "ok" || acked ? "status" : "alert") + '"><b>' + capTitle + '</b>' +
      (capMsg ? '<p>' + esc(capMsg) + '</p>' : '') + (capRows ? '<ul class="t3w-crows" aria-label="Salary cap after the trade">' + capRows + '</ul>' : '') +
      (cap.status === "blocked" && opts.capAck ? api.renderCapAck(opts.capAck, opts.viewerFid, opts) : '') + '</div>';
    var roTitle = ro.status === "warn" ? "Roster counts \u2014 heads-up" : ro.status === "ok" ? "Roster counts \u2014 within limits" : "Roster counts \u2014 couldn\'t be checked";
    var roRows = (ro.rows || []).map(function (r) {
      var lim = r.max ? r.min + "\u2013" + r.max : "min " + r.min;
      return '<li class="' + (r.status === "within" ? "" : "t3w-flag") + '"><span class="t3w-cr-name">' + esc(r.franchise_name || r.franchise_id) + '</span>' +
        '<span class="t3w-cr-num">' + esc(r.active_before) + ' \u2192 ' + esc(r.active_after) + ' active</span><span class="t3w-cr-room">limit ' + esc(lim) + '</span></li>';
    }).join("");
    h += '<div class="t3w-rost t3w-rost-' + esc(ro.status) + '" role="status"><b>' + roTitle + '</b>' +
      (ro.status !== "ok" ? '<p>' + esc(ro.message) + '</p>' : '') +
      (ro.status !== "unavailable" && roRows ? '<ul class="t3w-crows" aria-label="Active roster counts after the trade">' + roRows + '</ul>' : '') +
      (ro.status === "warn" ? '<p class="t3w-small">Advisory only \u2014 this doesn\'t block the trade and isn\'t a ruling on whether it\'s allowed. MFL decides when the trade is processed.</p>' : '') + '</div>';
    // ── loaded-contract limit (HARD, canon §2.G/§6.G: max 5) — same severity tier as the
    // salary cap, so it reuses the identical .t3w-cap classes rather than inventing a new
    // visual language. Optional on `c` so an older cached compliance object (cap+roster
    // only) still renders correctly without this section.
    var lc = c.loaded_contracts;
    if (lc) {
      // "needs_drops" reads as an ALERT tier, not a calm status, whenever it isn\'t yet
      // executable (today, always -- Keith\'s ruling, 2026-09-29: a valid selection is not an
      // executed drop) -- a satisfied requirement that still can\'t go through must never look
      // like a green light.
      var lcHeld = lc.status === "needs_drops" && lc.executable !== true;
      var lcTitle = lc.status === "blocked" ? "Can\'t be accepted \u2014 too many loaded contracts"
        : lcHeld ? "Held \u2014 conditional-drop execution isn\'t available yet"
        : lc.status === "needs_drops" ? "Loaded contracts \u2014 conditional on a drop"
        : lc.status === "ok" ? "Loaded contracts \u2014 every team stays at or under 5" : "Loaded contracts \u2014 couldn\'t be verified";
      var lcMsg = lc.status === "unavailable"
        ? "We couldn\'t verify the loaded-contract count for this trade right now." + (opts.gate ? " It can\'t be accepted until we can \u2014 try again in a moment." : "")
        : lc.status === "blocked" || lcHeld ? str(lc.message) : "";
      var lcRows = (lc.rows || []).map(function (r) {
        var over = r.loaded_after > (lc.max || 5);
        return '<li class="' + (over ? "t3w-over" : "") + '"><span class="t3w-cr-name">' + esc(r.franchise_name || r.franchise_id) + '</span>' +
          '<span class="t3w-cr-num">' + esc(r.loaded_before) + ' \u2192 ' + esc(r.loaded_after) + '</span>' +
          (over ? '<span class="t3w-cr-flag">max ' + esc(lc.max || 5) + '</span>' : '<span class="t3w-cr-room">of ' + esc(lc.max || 5) + ' max</span>') + '</li>';
      }).join("");
      h = h.replace('data-t3w-roster="' + esc(ro.status) + '">', 'data-t3w-roster="' + esc(ro.status) + '" data-t3w-loaded-contracts="' + esc(lc.status) + '">');
      h += '<div class="t3w-cap t3w-cap-' + esc(lcHeld ? "blocked" : lc.status === "needs_drops" ? "warn" : lc.status) + '" role="' + (lcHeld ? "alert" : (lc.status === "ok" || lc.status === "needs_drops") ? "status" : "alert") + '"><b>' + lcTitle + '</b>' +
        (lcMsg ? '<p>' + esc(lcMsg) + '</p>' : '') + (lcRows ? '<ul class="t3w-crows" aria-label="Loaded contracts after the trade">' + lcRows + '</ul>' : '') +
        // "Every party must see the drop requirement and selected players when viewing the
        // offer" (Keith's ruling, 2026-09-29). Interactivity is NOT forced off here -- it
        // follows the SAME rule cap-ack already uses one section up (api.renderCapAck): a
        // picker only ever renders for a franchise matching `opts.viewerFid`, so renderDetail's
        // own call (which passes no viewerFid at all) stays read-only naturally, while
        // renderAcceptReview's call (which DOES pass the viewer's own fid) lets the affected
        // owner pick their own drops right there in the accept-review dialog, exactly like it
        // already lets them acknowledge a cap overage there.
        ((lc.drop_requirements || []).length ? api.renderLoadedContractDrops(lc.drop_requirements, opts.viewerFid, opts) : '') +
        '</div>';
    }
    // ── lineup feasibility (ADVISORY, never blocks) — reuses the .t3w-rost visual tier,
    // exactly the same "never a block" contract the active-roster-count row already has.
    var lu = c.lineup;
    if (lu) {
      // "Structural" is load-bearing in every state's title, not just the warning --
      // this is a positions-only check (does the roster have enough players at each
      // slot), never a certification that a legal lineup can be SUBMITTED this week.
      var luTitle = lu.status === "warn" ? "Structural lineup feasibility \u2014 heads-up" : lu.status === "ok" ? "Structural lineup feasibility \u2014 every team can field one" : "Structural lineup feasibility \u2014 couldn\'t be checked";
      var luRows = (lu.rows || []).map(function (r) {
        var label = r.status === "unavailable" ? "unavailable" : (r.missing || []).map(function (m) { return m.count + " " + m.slot + (m.count > 1 ? "s" : ""); }).join(", ") || "complete";
        return '<li class="' + (r.status === "warn" ? "t3w-flag" : "") + '"><span class="t3w-cr-name">' + esc(r.franchise_name || r.franchise_id) + '</span>' +
          '<span class="t3w-cr-num">' + esc(r.status === "unavailable" ? "\u2014" : (r.filled + " of " + r.total)) + '</span>' +
          '<span class="' + (r.status === "warn" ? "t3w-cr-flag" : "t3w-cr-room") + '">' + esc(label) + '</span></li>';
      }).join("");
      h = h.replace('<section class="t3w-comp" data-t3w-cap="' + esc(cap.status) + '"', '<section class="t3w-comp" data-t3w-lineup="' + esc(lu.status) + '" data-t3w-cap="' + esc(cap.status) + '"');
      // The current-week-limitation caveat is shown for EVERY reached status (ok and
      // warn alike, not just warn) -- an "ok" verdict must never read as "certified
      // startable this week" either; it only means positions are covered.
      var luCaveat = '<p class="t3w-small">Advisory only \u2014 this doesn\'t block the trade. Positions only: this does NOT account for this week\'s byes, injuries, Out/Doubtful designations, or kickoff locks \u2014 that is a separate, later check. ' + (lu.status === "warn" ? 'The roster must be corrected under the league\'s lineup-compliance rules.' : 'A complete structural lineup here does not by itself mean every player is eligible to start THIS week.') + '</p>';
      h += '<div class="t3w-rost t3w-rost-' + esc(lu.status) + '" role="status"><b>' + luTitle + '</b>' +
        (lu.status !== "ok" ? '<p>' + esc(lu.message) + '</p>' : '') +
        (lu.status !== "unavailable" && luRows ? '<ul class="t3w-crows" aria-label="Structural lineup feasibility after the trade">' + luRows + '</ul>' : '') +
        (lu.status !== "unavailable" ? luCaveat : '') + '</div>';
    }
    return h + '</section>';
  };

  // The server's answer to a read-only accept review (action PREVIEW).
  //   kind "ok"       → compliance present; canAccept only when the cap verdict is "ok" OR its
  //                     overage has been fully acknowledged (capAck.satisfied -- Keith's ruling,
  //                     2026-09-28: a proven overage no longer itself blocks), AND separately the
  //                     loaded-contract verdict is "ok" -- an INDEPENDENT hard block that
  //                     acknowledgment never satisfies (loaded_contracts is optional on the
  //                     compliance object for backward compat with an older cached response, in
  //                     which case it simply doesn't add its own restriction).
  //   kind "refused"  → the trade itself can't be accepted (moved / no longer pending / …); message is owner-safe
  //   kind "unavailable"/"network"/… → couldn't load; retryable
  api.interpretPreview = function (res) {
    var b = res && res.body;
    if (res && !res.networkError && res.ok && b && b.ok !== false && b.compliance && b.compliance.cap) {
      var cap = b.compliance.cap.status;
      var capAck = b.cap_ack || null;
      var capOk = cap === "ok" || (cap === "blocked" && !!capAck && capAck.satisfied);
      // Keith's ruling, 2026-09-29 (reviewing the first PR, which had this exact bug): a
      // "needs_drops" verdict -- someone is over the loaded-contract limit, but every over-limit
      // franchise already has a valid, SELECTED drop -- is NOT the same thing as that drop having
      // EXECUTED, and no code anywhere calls MFL to actually drop a player yet (see
      // docs/LOADED_CONTRACT_DROP_EXECUTION_DESIGN.md). Read the server's own `executable` flag
      // (worker/src/trade_cap_authority.js's loadedContractsPermitsWrite()) rather than deciding
      // this client-side from `status` -- exactly duplicating that decision here, out of step
      // with the server, is what let a satisfied-but-unexecuted selection through the first time.
      var lcOk = !b.compliance.loaded_contracts || b.compliance.loaded_contracts.executable === true;
      return { kind: "ok", compliance: b.compliance, capAck: capAck, canAccept: capOk && lcOk,
        message: cap === "blocked" ? b.compliance.cap.message : cap === "unavailable" ? "We couldn\'t verify the salary cap for this trade right now." : "" };
    }
    if (res && !res.networkError && b && b.code === "cap_check_unavailable") {
      return { kind: "ok", compliance: b.compliance || null, canAccept: false, message: "We couldn\'t verify the salary cap for this trade right now.", retryable: true };
    }
    var f = failure(res);
    if (f.kind === "conflict" || f.kind === "forbidden") return { kind: "refused", canAccept: false, message: f.message, retryable: false };
    return { kind: f.kind, canAccept: false, message: f.message, retryable: f.retryable };
  };

  // The confirmation shown before a two-team accept. `review` = interpretPreview() result (or null while loading).
  api.renderAcceptReview = function (review, opts) {
    opts = opts || {};
    if (!review) return '<div class="t3w-review"><p class="t3w-small" role="status">Checking the trade against the salary cap\u2026</p></div>';
    var h = '<div class="t3w-review" data-t3w-can-accept="' + (review.canAccept ? "1" : "0") + '">';
    if (review.kind === "ok") h += api.renderCompliance(review.compliance, { gate: true, capAck: review.capAck, viewerFid: opts.viewerFid, ackBusy: opts.ackBusy, ackMessage: opts.ackMessage, ackOk: opts.ackOk });
    else h += '<div class="t3w-cap t3w-cap-unavailable" role="alert"><b>Can\'t review this trade</b><p>' + esc(review.message) + '</p></div>';
    h += '<div class="t3w-btns">';
    h += '<button type="button" class="t3w-btn" data-t3w-act="accept-close">' + (review.canAccept ? "Not now" : "Close") + '</button>';
    if (review.retryable) h += '<button type="button" class="t3w-btn" data-t3w-act="accept-retry">Try again</button>';
    if (review.canAccept) h += '<button type="button" class="t3w-btn t3w-btn-primary" data-t3w-act="accept-confirm"' + (opts.busy ? " disabled" : "") + '>' + (opts.busy ? "Accepting\u2026" : "Accept trade") + '</button>';
    return h + '</div></div>';
  };

  // ───────────── a trade waiting only on the salary cap (recoverable; every accept is kept) ─────────────
  api.renderBlock = function (ex, perms, rc, opts) {
    opts = opts || {};
    var b = ex.block || {};
    var isAck = b.kind === "cap_ack_required";
    var isDrops = b.kind === "loaded_contract_drops_required";
    var rows = (b.violations || []).map(function (v) {
      return '<li class="t3w-over"><span class="t3w-cr-name">' + esc(v.franchise_name || v.franchise_id) + '</span><span class="t3w-cr-flag">over by ' + esc(money(v.amount_over)) + '</span></li>';
    }).join("");
    var title = isAck ? "Waiting on an acknowledgment" : isDrops ? "Waiting on conditional drops" : "Waiting on the salary cap";
    var h = '<section class="t3w-comp" data-t3w-cap="blocked" data-t3w-block="1"><div class="t3w-cap t3w-cap-blocked" role="alert"><b>' + esc(title) + '</b>' +
      '<p>' + esc(b.message || "The salary cap can\'t be confirmed for this trade right now.") + '</p>' +
      (rows && !b.cap_ack && !isDrops ? '<ul class="t3w-crows" aria-label="Teams over the salary cap">' + rows + '</ul>' : '') +
      (b.cap_ack ? api.renderCapAck(b.cap_ack, opts.viewerFid, opts) : '') +
      // "Each affected franchise owner must select and confirm their own loaded-contract
      // players to drop ... Apply this to each affected franchise in a three-way trade" (Keith's
      // ruling, 2026-09-29). `b.drop_requirements` was folded onto this block fresh by
      // get3WayTrade/enterBlockedCap (worker/src/trade_3way.js) so it reflects the CURRENT
      // selection state, not a stale snapshot from whenever the block was first recorded.
      (isDrops && (b.drop_requirements || []).length ? api.renderLoadedContractDrops(b.drop_requirements, opts.viewerFid, Object.assign({}, opts, {
        interactive: true, dropBusy: opts.dropBusy, dropMessage: opts.dropMessage, dropOk: opts.dropOk,
      })) : '') +
      '<p class="t3w-small">Everyone has already accepted and those accepts are saved. Nothing has moved.' +
      (isAck ? ' Once every affected team has acknowledged, use \u201cRe-check\u201d to run it.'
        : isDrops ? ' Once every affected team has selected and confirmed its own drops, use \u201cRe-check\u201d to run it.'
        : ' The cap is worked out again from scratch each time you re-check, and the trade goes through as soon as it allows.') + '</p></div>';
    if (perms.can_recheck) {
      h += '<div class="t3w-btns"><button type="button" class="t3w-btn t3w-btn-primary" data-t3w-act="recheck"' + (rc.busy ? " disabled" : "") + '>' + (rc.busy ? "Checking\u2026" : "Re-check now") + '</button></div>';
    }
    if (rc.message) h += '<div class="t3w-status t3w-status-' + (rc.ok ? "ok" : "bad") + '" role="status" aria-live="polite">' + esc(rc.message) + '</div>';
    return h + '</section>';
  };
  api.interpretAckCap = function (res) {
    var b = res && res.body;
    if (res && !res.networkError && res.ok && b && b.ok === true) {
      return { kind: b.code === "nothing_to_acknowledge" ? "nothing" : "acknowledged", ok: true, message: b.message || "Acknowledged.", capAck: b.cap_ack || null, compliance: b.compliance || null };
    }
    var f = failure(res);
    var code = b && b.code;
    var msg = (b && typeof code === "string" && res.status < 500 && (b.message || b.error)) ? (b.message || b.error) : f.message;
    return { kind: f.kind, ok: false, code: code, message: msg, retryable: f.retryable };
  };
  // The server's answer to POST /select-drops (2-way SELECT_DROPS action, or 3-way
  // /api/trades/3way/select-drops) -- the CALLER's own franchise's conditional-drop selection.
  // Never writes to MFL, drops no player, and (like ack-cap) never itself re-checks -- follow a
  // "selected" (satisfied) result with Re-check once every affected franchise has picked.
  api.interpretSelectDrops = function (res) {
    var b = res && res.body;
    if (res && !res.networkError && res.ok && b && b.ok === true) {
      return { kind: b.code === "nothing_required" ? "nothing" : b.code === "selected" ? "selected" : "insufficient",
        ok: true, message: b.message || (b.code === "selected" ? "Selection saved." : "Selection saved, but more drops are still needed."),
        dropRequirement: b.drop_requirement || null, compliance: b.compliance || null };
    }
    var f = failure(res);
    var code = b && b.code;
    var msg = (b && typeof code === "string" && res.status < 500 && (b.message || b.error)) ? (b.message || b.error) : f.message;
    return { kind: f.kind, ok: false, code: code, message: msg, retryable: f.retryable };
  };
  api.interpretRecheck = function (res) {
    var b = res && res.body;
    if (res && !res.networkError && res.ok && b && b.ok === true) return { kind: "rechecking", ok: true, message: b.message || "The salary cap is fine now \u2014 the trade is being processed." };
    var f = failure(res);
    var code = b && b.code;
    var msg = (b && typeof code === "string" && res.status < 500 && (b.message || b.error)) ? (b.message || b.error) : f.message;
    return { kind: code === "cap_exceeded" || code === "cap_check_unavailable" ? "still_blocked" : f.kind, ok: false, code: code, message: msg, retryable: f.retryable };
  };

  // What an ACCEPT of a two-team trade actually did — never a bare "Done". Three DIFFERENT truths:
  //   executed            → MFL processed it (and everything after it finished)
  //   executed_needs_review → MFL processed it, but the contract/extension step did not finish (commissioner will fix; nothing to redo)
  //   not executed / unconfirmed → the accept was refused, or we couldn't confirm what MFL did (and it was NOT sent again)
  api.interpretAction = function (action, res) {
    var b = res && res.body;
    if (res && !res.networkError && res.ok && b && b.ok !== false) {
      if (b.needs_review || b.execution_state === "executed_needs_review") {
        return { kind: "executed_needs_review", executed: true, tone: "warn", title: "Trade executed \u2014 needs commissioner review",
          message: b.message || "Your trade WAS executed in MFL. Its contract/extension processing did not finish and needs commissioner review (no action needed from you)." };
      }
      if (b.already && b.executed) return { kind: "already", executed: true, tone: "ok", title: "Already accepted", message: "This trade was already executed in MFL." };
      return { kind: "done", executed: action === "accept" || action === "ACCEPT" ? true : undefined, tone: "ok", title: "Done", message: "Done \u2713" };
    }
    var code = b && b.code;
    if (code === "execution_unconfirmed" || code === "execution_in_progress") {
      return { kind: "unconfirmed", executed: null, tone: "warn", title: "Trade not confirmed",
        message: (b && (b.message || b.error)) || "We couldn\'t confirm whether MFL processed that accept, and it has NOT been sent again. Ask the commissioner to check it." };
    }
    if (code === "already_executed") return { kind: "already", executed: true, tone: "ok", title: "Already accepted", message: "This trade has already been accepted." };
    var f = failure(res);
    var m = b && (b.error || b.message);
    return { kind: f.kind, executed: false, tone: "bad", title: "Not accepted", message: typeof m === "string" && m && res && res.status < 500 ? m : (f.kind === "network" ? f.message : (typeof m === "string" && m ? m : f.message)), retryable: f.retryable };
  };

  // A compact card for outbox lists. Same canonical trade, same tones.
  api.renderCard = function (trade) {
    var sv = trade.state_view || {};
    var lines = (trade.movements || []).map(function (m) {
      return '<div class="t3w-mov"><span class="t3w-route">' + esc(m.from.name) + ' → ' + esc(m.to.name) + '</span>' +
        '<span class="t3w-what">' + m.assets.map(function (a) { return esc(a.label); }).join(", ") + '</span></div>';
    }).join("");
    var role = trade.viewer && trade.viewer.role;
    return '<div class="t3w-card" data-t3w-id="' + esc(trade.id) + '">' +
      '<div class="t3w-head"><span class="t3w-pill t3w-tone-' + api.tone(trade) + '">' + esc(sv.label) + '</span>' +
      '<span class="t3w-role">' + esc(role === "initiator" ? "You started this" : role === "partner" ? "You're a partner" : "") + '</span></div>' +
      '<div class="t3w-movs">' + lines + '</div>' +
      '<div class="t3w-btns"><button type="button" class="t3w-btn" data-t3w-act="open" data-t3w-id="' + esc(trade.id) + '">Details</button>' +
      (trade.permissions && trade.permissions.can_cancel ? '<button type="button" class="t3w-btn t3w-btn-danger" data-t3w-act="open-cancel" data-t3w-id="' + esc(trade.id) + '">Cancel</button>' : "") +
      '</div></div>';
  };

  // A load failure the user can act on — never a blank area or an endless spinner.
  api.renderProblem = function (problem, opts) {
    opts = opts || {};
    var retry = problem.retryable ? '<div class="t3w-btns"><button type="button" class="t3w-btn" data-t3w-act="retry">Try again</button></div>' : "";
    return '<div class="t3w-problem t3w-problem-' + esc(problem.kind) + '" role="alert"><b>' + esc(opts.title || "Couldn't load this 3-way trade") + '</b>' +
      '<p>' + esc(problem.message) + '</p>' + retry + '</div>';
  };

  // Event delegation shared by both surfaces. The container element is REUSED across
  // renders/routes, so the listener is attached once but always dispatches to the
  // most recently supplied handlers:
  //   { open(id), 'open-cancel'(id), cancel(), keep(), 'confirm-cancel'(), retry() }
  api.bind = function (rootEl, handlers) {
    if (!rootEl) return;
    rootEl.__t3wHandlers = handlers || {};
    if (rootEl.__t3wBound) return;
    rootEl.__t3wBound = true;
    rootEl.addEventListener("click", function (ev) {
      var el = ev.target && ev.target.closest ? ev.target.closest("[data-t3w-act]") : null;
      if (!el || !rootEl.contains(el) || el.disabled) return;
      var fn = rootEl.__t3wHandlers[el.getAttribute("data-t3w-act")];
      if (typeof fn === "function") { ev.preventDefault(); fn(el.getAttribute("data-t3w-id") || "", el); }
    });
  };

  // After the confirmation appears, bring it fully into view (a fixed bottom nav can
  // cover it) and put focus on the SAFE choice ("Keep it").
  api.revealConfirm = function (rootEl) {
    try {
      var c = rootEl && rootEl.querySelector(".t3w-confirm");
      if (c && c.scrollIntoView) c.scrollIntoView({ block: "center" });
      var k = rootEl && rootEl.querySelector('[data-t3w-act="keep"]');
      if (k && k.focus) k.focus({ preventScroll: true });
    } catch (e) { /* best effort */ }
  };

  // ───────────────────────────── styles (self-contained) ─────────────────────────────
  // Themed through var() with fallbacks for BOTH the mobile app (--bg-elev, --fg …)
  // and the desktop War Room (--twb-surface, --twb-text …), so neither needs its own copy.
  var CSS =
    '.t3w,.t3w-card,.t3w-problem,.t3w-review{--c-bg:var(--t3w-bg,var(--bg-elev,var(--twb-surface,#141a26)));--c-fg:var(--t3w-fg,var(--fg,var(--twb-text,#e8edf5)));' +
    '--c-mut:var(--t3w-mut,var(--fg-muted,var(--twb-text-soft,#8a97ad)));--c-line:var(--t3w-line,var(--line,var(--twb-border,#2a3446)));' +
    '--c-ok:var(--ok,var(--twb-good,#56d79a));--c-warn:var(--warn,var(--twb-warn,#f4c369));--c-bad:var(--danger,var(--twb-bad,#ff6b6b));--c-acc:var(--accent,var(--twb-link,#5b8dff));' +
    'color:var(--c-fg);box-sizing:border-box;min-width:0;max-width:100%;overflow-wrap:anywhere}' +
    '.t3w *,.t3w-card *,.t3w-problem *{box-sizing:border-box}' +
    '.t3w,.t3w-card,.t3w-problem{background:var(--c-bg);border:1px solid var(--c-line);border-radius:12px;padding:12px;margin:0 0 12px}' +
    '.t3w-head{display:flex;flex-wrap:wrap;gap:8px;align-items:center;justify-content:space-between;margin:0 0 8px}' +
    '.t3w-pill{display:inline-block;max-width:100%;padding:4px 12px;border-radius:16px;font-weight:700;font-size:13px;line-height:1.3;border:1px solid currentColor}' +
    '.t3w-tone-wait{color:var(--c-warn)}.t3w-tone-busy{color:var(--c-acc)}.t3w-tone-ok{color:var(--c-ok)}.t3w-tone-bad{color:var(--c-bad)}.t3w-tone-off{color:var(--c-mut)}.t3w-tone-warn{color:var(--c-warn)}' +
    '.t3w-role{font-size:12px;color:var(--c-mut)}' +
    '.t3w-msg{margin:0 0 10px;color:var(--c-mut);font-size:13px}' +
    '.t3w-warn{border:1px solid var(--c-warn);border-radius:8px;padding:8px 10px;margin:0 0 10px;font-size:13px;color:var(--c-warn)}' +
    '.t3w-sides{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,220px),1fr));gap:10px;margin:0 0 10px}' +
    '.t3w-side{border:1px solid var(--c-line);border-radius:10px;padding:10px;min-width:0}' +
    '.t3w-team{margin:0 0 8px;font-size:15px;line-height:1.25}' +
    '.t3w-tag{font-size:11px;font-weight:600;padding:1px 7px;border-radius:999px;border:1px solid var(--c-line);color:var(--c-mut);white-space:nowrap}' +
    '.t3w-tag-accepted{color:var(--c-ok);border-color:var(--c-ok)}.t3w-tag-declined{color:var(--c-bad);border-color:var(--c-bad)}.t3w-tag-initiator{color:var(--c-acc);border-color:var(--c-acc)}' +
    '.t3w-col{margin:0 0 8px}.t3w-col h5{margin:0 0 4px;font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--c-mut)}' +
    '.t3w-col ul{list-style:none;margin:0;padding:0}.t3w-col li{margin:0 0 6px}' +
    '.t3w-dir{display:block;font-size:12px;color:var(--c-mut)}.t3w-asset{display:block;font-size:14px}.t3w-asset small{color:var(--c-mut)}' +
    '.t3w-asset-cap{color:var(--c-ok)}.t3w-asset-missing{color:var(--c-warn);font-style:italic}.t3w-none{margin:0;font-size:13px;color:var(--c-mut)}' +
    '.t3w-ext,.t3w-note{margin:0 0 10px;font-size:13px}.t3w-ext h5{margin:0 0 4px;font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--c-mut)}.t3w-ext ul{margin:0;padding-left:18px}' +
    '.t3w-meta{font-size:12px;color:var(--c-mut);margin:0 0 10px}.t3w-why{font-size:13px;color:var(--c-mut);margin:0 0 8px}' +
    '.t3w-btns{display:flex;flex-wrap:wrap;gap:8px}' +
    '.t3w-btn{min-height:44px;min-width:44px;padding:8px 14px;border-radius:10px;border:1px solid var(--c-line);background:transparent;color:var(--c-fg);font:inherit;font-weight:600;cursor:pointer}' +
    '.t3w-btn:hover:not([disabled]){border-color:var(--c-acc)}.t3w-btn:focus-visible{outline:2px solid var(--c-acc);outline-offset:2px}.t3w-btn[disabled]{opacity:.55;cursor:default}' +
    '.t3w-btn-danger{color:var(--c-bad);border-color:var(--c-bad)}' +
    '.t3w-confirm{border:1px solid var(--c-bad);border-radius:10px;padding:10px;margin:0 0 8px}.t3w-confirm p{margin:0 0 10px;font-size:14px}' +
    '.t3w-status{margin:8px 0 0;padding:8px 10px;border-radius:8px;font-size:13px;border:1px solid var(--c-line)}.t3w-status-ok{color:var(--c-ok);border-color:var(--c-ok)}.t3w-status-bad{color:var(--c-bad);border-color:var(--c-bad)}' +
    '.t3w-mov{display:flex;flex-direction:column;gap:2px;margin:0 0 6px;font-size:13px}.t3w-route{font-weight:600}.t3w-what{color:var(--c-mut)}' +
    '.t3w-problem{border-color:var(--c-warn)}.t3w-problem p{margin:6px 0 10px;font-size:14px}' +
    '.t3w-comp{display:grid;gap:8px;margin:0 0 10px}.t3w-cap,.t3w-rost{border:1px solid var(--c-line);border-radius:10px;padding:9px 11px;font-size:13px;min-width:0}' +
    '.t3w-cap p,.t3w-rost p{margin:4px 0 0;line-height:1.4}.t3w-small{font-size:12px;color:var(--c-mut)}' +
    '.t3w-cap-ok{border-color:var(--c-ok)}.t3w-cap-blocked{border-color:var(--c-bad);color:var(--c-fg)}.t3w-cap-blocked>b{color:var(--c-bad)}.t3w-cap-unavailable{border-color:var(--c-warn)}.t3w-cap-unavailable>b{color:var(--c-warn)}' +
    '.t3w-rost-warn{border-color:var(--c-warn)}.t3w-rost-warn>b{color:var(--c-warn)}.t3w-rost-unavailable{border-color:var(--c-line);color:var(--c-mut)}' +
    '.t3w-crows{list-style:none;margin:6px 0 0;padding:0;display:grid;gap:4px}.t3w-crows li{display:flex;flex-wrap:wrap;gap:2px 10px;align-items:baseline;justify-content:space-between}' +
    '.t3w-cr-name{font-weight:600}.t3w-cr-num{font-variant-numeric:tabular-nums}.t3w-cr-room{color:var(--c-mut);font-size:12px}.t3w-cr-flag{color:var(--c-bad);font-weight:700;font-size:12px}' +
    '.t3w-over .t3w-cr-num{color:var(--c-bad)}.t3w-flag .t3w-cr-num{color:var(--c-warn)}' +
    '.t3w-review{display:grid;gap:10px}.t3w-btn-primary{background:#2f6fe4;border-color:#2f6fe4;color:#fff}.t3w-btn-primary:hover:not([disabled]){background:#4380f0;border-color:#4380f0}' +
    '.t3w-ack{margin-top:8px;padding-top:8px;border-top:1px dashed var(--c-line)}.t3w-ack>b{font-size:13px}' +
    '.t3w-ack-list{margin-top:6px}.t3w-ack-row{display:flex;flex-wrap:wrap;gap:4px 10px;align-items:center}' +
    '.t3w-ack-badge{font-size:11px;font-weight:700;padding:1px 8px;border-radius:999px;border:1px solid currentColor;white-space:nowrap}' +
    '.t3w-ack-badge-ok{color:var(--c-ok)}.t3w-ack-badge-you{color:var(--c-warn)}.t3w-ack-badge-wait{color:var(--c-mut)}' +
    '.t3w-ack-btn{min-height:36px;padding:6px 12px;font-size:13px;flex-basis:100%}';
  api.CSS = CSS;
  api.ensureStyles = function (doc) {
    doc = doc || (typeof document !== "undefined" ? document : null);
    if (!doc || doc.getElementById("t3wStyles")) return;
    var s = doc.createElement("style");
    s.id = "t3wStyles";
    s.textContent = CSS;
    (doc.head || doc.documentElement).appendChild(s);
  };

  return api;
});
