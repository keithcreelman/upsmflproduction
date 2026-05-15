/* site/m/front_office_tag_submit.js
 *
 * VERBATIM MIRROR of the tag/untag submit pipeline in
 * site/rosters/roster_workbench.js. Same salary computation, same
 * contract_info builder, same 2-step submission flow that Front Office
 * uses today. Mobile callers only build the payload + fire the POST;
 * the rules + math come from this file.
 *
 * DO NOT EDIT logic. If desktop changes, copy updated function bodies
 * here verbatim. Source-of-truth lines (roster_workbench.js):
 *   safeStr (201) · safeInt (226) · pad4 (315) · formatContractK (361)
 *   effectiveTagSalaryForRow (2776) · effectiveTagFormulaForRow (2789)
 *   buildTagContractInfo (2834) · buildTagContractPayload (11075)
 *   buildUntagContractPayload (11106) · submitTagPlanSelection (11216)
 *   postContractUpdate (10697) · resolveWorkerActionEndpoint (3690)
 *   resolveWorkerContractUpdateEndpoint (3703)
 */
(function () {
  "use strict";

  // ── BEGIN verbatim mirror from roster_workbench.js ───────────────────

  function safeStr(v) {
    return v == null ? "" : String(v).trim();
  }
  function safeInt(v, fallback) {
    var n = parseInt(v, 10);
    if (!isFinite(n)) return fallback == null ? 0 : fallback;
    return n;
  }
  function safeNum(v, fallback) {
    var n = Number(v);
    if (!isFinite(n)) return fallback == null ? 0 : fallback;
    return n;
  }
  function pad4(v) {
    var digits = safeStr(v).replace(/\D/g, "");
    if (!digits) return "";
    return ("0000" + digits).slice(-4);
  }
  function formatContractK(amount) {
    var dollars = Math.round(safeNum(amount, 0));
    if (dollars <= 0) return "0K";
    var k = dollars / 1000;
    var text = Math.round(k * 10) / 10;
    return String(text).replace(/\.0$/, "") + "K";
  }
  function normalizeTagSideValue(side) {
    var raw = safeStr(side).toUpperCase();
    if (raw === "OFFENSE" || raw === "OFF") return "OFFENSE";
    if (raw === "DEFENSE" || raw === "DEF" || raw === "IDP" || raw === "IDP_K") return "DEFENSE";
    return "";
  }
  function getTagSideFromPos(pos) {
    var key = safeStr(pos).toUpperCase();
    if (!key) return "";
    var OFFENSE = { QB: 1, RB: 1, WR: 1, TE: 1 };
    return OFFENSE[key] ? "OFFENSE" : "DEFENSE";
  }

  function effectiveTagSalaryForRow(row) {
    var ref = row || {};
    var baseBid = safeInt(ref.tag_salary, 0);
    var floorBase = Math.max(
      safeInt(ref.prior_aav_week1, 0),
      safeInt(ref.prior_salary_week1, 0),
      safeInt(ref.aav, 0),
      safeInt(ref.salary, 0)
    );
    var bumpFloor = floorBase > 0 ? Math.ceil((floorBase * 1.1) / 1000) * 1000 : 0;
    return Math.max(baseBid, bumpFloor);
  }
  function effectiveTagFormulaForRow(row) {
    var formula = safeStr(row && row.tag_formula);
    var baseBid = safeInt(row && row.tag_salary, 0);
    var effectiveBid = effectiveTagSalaryForRow(row);
    if (effectiveBid > baseBid && formula.toLowerCase().indexOf("10%") === -1) {
      formula += (formula ? " | " : "") + "10% salary floor (rounded up)";
    }
    return formula;
  }
  function buildTagContractInfo(row, salary) {
    var amount = Math.max(0, safeInt(salary, 0));
    var guaranteed = Math.round(amount * 0.75);
    var tier = safeInt(row && row.tag_tier, 0);
    var formula = safeStr(effectiveTagFormulaForRow(row));
    var parts = [
      "CL 1",
      "TCV " + formatContractK(amount),
      "AAV " + formatContractK(amount),
      "GTD " + formatContractK(guaranteed)
    ];
    parts.push("Tag");
    if (tier > 0) parts.push("Tier " + String(tier));
    if (formula) parts.push("Formula: " + formula);
    return parts.join("| ");
  }

  // Payload builder. Caller passes ctx (leagueId, year) + the tag-plan
  // row from tag_tracking.json. commish_override_flag is 0 for owner-side
  // submissions (mobile is always owner mode).
  function buildTagContractPayload(args) {
    var row = args.row || {};
    var leagueId = safeStr(args.leagueId);
    var year = safeStr(args.year);
    var salary = effectiveTagSalaryForRow(row);
    return {
      L: leagueId,
      YEAR: year,
      type: "MANUAL_CONTRACT_UPDATE",
      submission_kind: "tag",
      dry_run: args.dryRun ? 1 : 0,
      leagueId: leagueId,
      year: year,
      player_id: safeStr(row.player_id),
      player_name: safeStr(row.player_name),
      franchise_id: pad4(row.franchise_id),
      franchise_name: safeStr(row.franchise_name),
      position: safeStr(row.position),
      side: normalizeTagSideValue(row.tag_side || row.side) || "",
      tag_side: normalizeTagSideValue(row.tag_side || row.side) || "",
      salary: salary,
      contract_year: 1,
      contract_status: "TAG",
      contract_info: buildTagContractInfo(row, salary),
      submitted_at_utc: new Date().toISOString(),
      commish_override_flag: args.commishOverride ? 1 : 0
    };
  }

  function buildUntagContractPayload(args) {
    var row = args.row || {};   // tag_tracking row (carries prior contract)
    var leagueId = safeStr(args.leagueId);
    var year = safeStr(args.year);
    var fid = pad4(args.fid);
    var pid = safeStr(args.pid);
    var salary = Math.max(0, safeInt(row.salary, 0));
    var contractYear = Math.max(1, safeInt(row.contract_year, 0));
    var contractStatus = safeStr(row.contract_status || "WW");
    var contractInfo = safeStr(row.contract_info || "CL 1|");
    if (!contractStatus || !contractInfo) return null;

    return {
      L: leagueId,
      YEAR: year,
      type: "MANUAL_CONTRACT_UPDATE",
      submission_kind: "untag",
      dry_run: args.dryRun ? 1 : 0,
      prior_tag_side: getTagSideFromPos(safeStr(args.position) || row.position) || "",
      leagueId: leagueId,
      year: year,
      player_id: pid,
      player_name: safeStr(args.playerName || row.player_name),
      franchise_id: fid,
      franchise_name: safeStr(args.franchiseName || row.franchise_name),
      position: safeStr(args.position || row.position),
      salary: salary,
      contract_year: contractYear,
      contract_status: contractStatus,
      contract_info: contractInfo,
      submitted_at_utc: new Date().toISOString(),
      commish_override_flag: args.commishOverride ? 1 : 0
    };
  }

  // ── END verbatim mirror ──────────────────────────────────────────────

  // ── HTTP submit helpers ──────────────────────────────────────────────
  // Mirrors the desktop pattern (postContractUpdate at 10697): try JSON
  // POST first; if the response is 4xx/5xx fall back to form-urlencoded.
  // Worker accepts both.

  function postJson(url, payload) {
    return fetch(url, {
      method: "POST",
      mode: "cors",
      credentials: "omit",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload || {})
    }).then(function (r) {
      return r.text().then(function (txt) {
        var parsed = null;
        try { parsed = txt ? JSON.parse(txt) : null; } catch (e) {}
        return { status: r.status, ok: r.ok, body: parsed, raw: txt };
      });
    });
  }
  function postForm(url, payload) {
    var form = new URLSearchParams();
    Object.keys(payload || {}).forEach(function (k) {
      var v = payload[k];
      if (v == null) return;
      form.append(k, String(v));
    });
    return fetch(url, {
      method: "POST",
      mode: "cors",
      credentials: "omit",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString()
    }).then(function (r) {
      return r.text().then(function (txt) {
        var parsed = null;
        try { parsed = txt ? JSON.parse(txt) : null; } catch (e) {}
        return { status: r.status, ok: r.ok, body: parsed, raw: txt };
      });
    });
  }
  function postContractUpdate(url, payload) {
    return postJson(url, payload).then(function (resp) {
      if (resp.ok) return resp;
      return postForm(url, payload);
    });
  }

  // Full tag submit — mirrors submitTagPlanSelection (11216). 2-step:
  // 1) POST /roster-workbench/action with action=load_player (so MFL
  //    "loads" the player into the franchise's active roster context).
  // 2) POST /commish-contract-update with the tag contract payload.
  //
  // On step-2 failure, the desktop rolls back step 1 via action=unload_player.
  // Mobile does the same.
  function submitTag(args) {
    var workerBase = String(args.workerBase || "").replace(/\/+$/, "");
    var actionUrl = workerBase + "/roster-workbench/action";
    var contractUrl = workerBase + "/commish-contract-update?L=" +
      encodeURIComponent(args.leagueId) + "&YEAR=" + encodeURIComponent(args.year);
    var payload = buildTagContractPayload(args);
    var loaded = false;

    return postJson(actionUrl, {
      action: "load_player",
      league_id: args.leagueId,
      season: args.year,
      franchise_id: pad4(args.row.franchise_id),
      player_id: safeStr(args.row.player_id)
    }).then(function (resp) {
      if (resp.ok) loaded = true;
      // load_player may report skipped/idempotent — proceed regardless
      return postContractUpdate(contractUrl, payload);
    }).then(function (resp) {
      if (resp.ok) return { ok: true, status: resp.status, body: resp.body, payload: payload };
      // Roll back the load if step 2 failed.
      var rollback = loaded
        ? postJson(actionUrl, {
            action: "unload_player",
            league_id: args.leagueId,
            season: args.year,
            franchise_id: pad4(args.row.franchise_id),
            player_id: safeStr(args.row.player_id)
          }).catch(function () { return null; })
        : Promise.resolve(null);
      return rollback.then(function () {
        return { ok: false, status: resp.status, body: resp.body, error: (resp.body && resp.body.error) || ("HTTP " + resp.status) };
      });
    });
  }

  function submitUntag(args) {
    var workerBase = String(args.workerBase || "").replace(/\/+$/, "");
    var contractUrl = workerBase + "/commish-contract-update?L=" +
      encodeURIComponent(args.leagueId) + "&YEAR=" + encodeURIComponent(args.year);
    var payload = buildUntagContractPayload(args);
    if (!payload) return Promise.resolve({ ok: false, error: "Missing prior contract data — cannot untag." });
    return postContractUpdate(contractUrl, payload).then(function (resp) {
      if (resp.ok) return { ok: true, status: resp.status, body: resp.body, payload: payload };
      return { ok: false, status: resp.status, body: resp.body, error: (resp.body && resp.body.error) || ("HTTP " + resp.status) };
    });
  }

  window.UPS_FRONT_OFFICE_TAG = {
    effectiveTagSalaryForRow: effectiveTagSalaryForRow,
    effectiveTagFormulaForRow: effectiveTagFormulaForRow,
    buildTagContractInfo: buildTagContractInfo,
    buildTagContractPayload: buildTagContractPayload,
    buildUntagContractPayload: buildUntagContractPayload,
    submitTag: submitTag,
    submitUntag: submitUntag
  };
})();
