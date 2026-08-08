/* site/m/front_office_mym_submit.js
 *
 * VERBATIM-LOGIC MIRROR of the MYM (Mid-Year Multi, §C3) pipeline in
 * site/rosters/v2/front_office.js — the contract-logic source of truth.
 *
 * MYM (§C3): an IN-SEASON WW/FCFS/waiver pickup can convert to a FLAT 2- or
 * 3-year contract within 14 days of acquisition, at the SAME base salary —
 * TCV = salary × years, NO escalator, NO loading (distinct from MYAC §C2 and
 * Extension §C4). Sub-type records as Veteran-MYM / WW-MYM / MYM-Rookie (§A3).
 * Max 4 MYMs per team per season — the WORKER enforces the 14-day window AND
 * the 4-per-season cap on submit; this client is best-effort.
 *
 * This module owns the MATH + PAYLOAD only; player_sheet.js owns the mobile
 * sheet/confirm UI (same split as front_office_myac_submit.js). The MFL write
 * goes to the SAME worker route the desktop uses (/offer-mym, type:"MYM",
 * submission_kind:"mym"), owner-initiated and dry_run-capable.
 *
 * DO NOT EDIT logic. If desktop changes, copy the updated function bodies here
 * verbatim. Source-of-truth (v2/front_office.js):
 *   mymSubType (1573-ish) · guaranteeForContract · submitMymContract
 *   eligibility mymEligible (1441-1456)
 */
(function () {
  "use strict";

  function safeStr(v) { return v == null ? "" : String(v).trim(); }
  function safeInt(v, fallback) {
    var n = parseInt(v, 10);
    if (!isFinite(n)) return fallback == null ? 0 : fallback;
    return n;
  }
  function pad4(v) {
    var digits = safeStr(v).replace(/\D/g, "");
    if (!digits) return "";
    return ("0000" + digits).slice(-4);
  }

  // fmtUSD — human dollar string for confirms.
  function fmtUSD(n) {
    var v = Number(n);
    if (!isFinite(v)) return "—";
    if (v === 0) return "$0";
    try { return "$" + Math.round(v).toLocaleString("en-US"); }
    catch (e) { return "$" + String(Math.round(v)); }
  }
  // fmtKbare ≡ desktop fmtK(n).replace(/\$/,"") — "24K", "27.5K", "0" for ≤0.
  function fmtKbare(n) {
    var dollars = Math.round(Number(n) || 0);
    if (dollars <= 0) return "0";
    var k = dollars / 1000;
    var text = Math.round(k * 10) / 10;
    return String(text).replace(/\.0$/, "") + "K";
  }

  // guaranteeForContract — §D1 guarantee (v2/front_office.js): 75% of TCV above
  // $4K, else $1,000 for a 2+ year deal (MYM is always 2 or 3), else $0.
  function guaranteeForContract(tcv, years) {
    var t = safeInt(tcv, 0);
    if (t > 4000) return Math.round(t * 0.75);
    return safeInt(years, 0) >= 2 ? 1000 : 0;
  }

  // mymSubType — the acquisition method survives MYM (§A3). Verbatim mirror of
  // v2/front_office.js mymSubType: a Rookie contract → MYM-Rookie; a WW/FCFS/
  // waiver/free-agent acquisition (not auction) → WW-MYM; else Veteran-MYM.
  // Takes the contractStatus + the acquisition label (both available on the
  // mobile rosterRow / player record).
  function mymSubType(contractStatus, acqLabel) {
    var t = safeStr(contractStatus).toLowerCase();
    var acq = safeStr(acqLabel).toLowerCase();
    if (/rookie/.test(t)) return "MYM-Rookie";
    // The STATUS answers this whenever MFL has stamped one ("Vet-WW",
    // "Vet-WW-BL"). The acquisition label alone did not: it comes from the
    // static player_acquisition_lookup_<year>.json, which is regenerated
    // periodically and does not contain a claim made this week — so a real WW
    // pickup was being recorded as Veteran-MYM.
    if (/\bww\b/.test(t)) return "WW-MYM";
    if (/\b(ww|fcfs|blind|waiver|free agent)\b/.test(acq) && acq.indexOf("auction") === -1) return "WW-MYM";
    return "Veteran-MYM";
  }

  // buildMymContract — flat per-year array (no escalator, no loading).
  // TCV = perYear × totalYears, AAV = perYear, GTD per §D1. contract_info is
  // BYTE-IDENTICAL to the desktop submitMymContract string (spaces after each
  // "|", per-year list joined by ", ").
  function buildMymContract(perYear, totalYears, subType) {
    var py = safeInt(perYear, 0);
    var tcv = py * totalYears;
    var aav = py;
    var gtd = guaranteeForContract(tcv, totalYears);
    var yrs = [];
    for (var i = 0; i < totalYears; i += 1) yrs.push(py);
    var contractInfo = "CL " + totalYears +
      "| TCV " + fmtKbare(tcv) + "| AAV " + fmtKbare(aav) +
      "| " + yrs.map(function (v, i) { return "Y" + (i + 1) + "-" + fmtKbare(v); }).join(", ") +
      "| GTD: " + fmtKbare(gtd);
    return {
      totalYears: totalYears, yrs: yrs, perYear: py, tcv: tcv, aav: aav,
      gtd: gtd, subType: subType, contractInfo: contractInfo
    };
  }

  // Pre-submit validation — §C3 base salary floor + length.
  function validateMym(perYear, totalYears) {
    if (safeInt(perYear, 0) < 1000) return "MYM needs a base salary ≥ $1,000.";
    if (totalYears !== 2 && totalYears !== 3) return "MYM length must be 2 or 3 years (§C3).";
    return "";
  }

  // ── HTTP submit helpers (same pattern as front_office_myac_submit.js) ─────
  function postJson(url, payload) {
    return fetch(url, {
      method: "POST", mode: "cors", credentials: "omit",
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
      var v = payload[k]; if (v == null) return;
      form.append(k, String(v));
    });
    return fetch(url, {
      method: "POST", mode: "cors", credentials: "omit",
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

  // Build the MYM submit payload — matches the desktop submitMymContract body
  // exactly (type:"MYM", submission_kind:"mym", /offer-mym route).
  function buildMymPayload(args) {
    var leagueId = safeStr(args.leagueId);
    var year = safeStr(args.year);
    var c = args.contract || {};
    var rosterRow = args.rosterRow || {};
    return {
      L: leagueId, YEAR: year,
      type: "MYM",
      submission_kind: "mym",
      dry_run: args.dryRun ? 1 : 0,
      source: "ups-mobile-mym-submit",
      leagueId: leagueId, year: year,
      player_id: safeStr(args.pid),
      player_name: safeStr(args.playerName),
      franchise_id: pad4(args.fid),
      franchise_name: safeStr(args.franchiseName),
      position: safeStr(args.position),
      salary: safeInt(c.perYear, 0),
      per_year: safeInt(c.perYear, 0),
      contract_year: safeInt(c.totalYears, 0),
      contract_status: "Veteran",
      contract_info: safeStr(c.contractInfo),
      mym_length: safeInt(c.totalYears, 0),
      mym_option: "mym" + safeInt(c.totalYears, 0),
      sub_type: safeStr(c.subType),
      tcv: safeInt(c.tcv, 0),
      aav: safeInt(c.aav, 0),
      guaranteed: safeInt(c.gtd, 0),
      prior_contract_status: safeStr(rosterRow.contractStatus),
      prior_salary: safeInt(rosterRow.salary, 0),
      prior_contract_year: safeInt(rosterRow.contractYear, 0),
      prior_contract_info: safeStr(rosterRow.contractInfo),
      acquisition_date: safeStr(args.acquisitionDate),
      acquisition_type: safeStr(args.acquisitionType),
      submitted_at_utc: new Date().toISOString(),
      commish_override_flag: args.commishOverride ? 1 : 0
    };
  }

  function submitMym(args) {
    var workerBase = String(args.workerBase || "").replace(/\/+$/, "");
    var url = workerBase + "/offer-mym?L=" +
      encodeURIComponent(args.leagueId) + "&YEAR=" + encodeURIComponent(args.year);
    var payload = buildMymPayload(args);
    return postContractUpdate(url, payload).then(function (resp) {
      if (resp.ok) return { ok: true, status: resp.status, body: resp.body, payload: payload };
      return { ok: false, status: resp.status, body: resp.body,
               error: (resp.body && resp.body.error) || ("HTTP " + resp.status) };
    });
  }

  window.UPS_M_FO_MYM = {
    fmtUSD: fmtUSD,
    guaranteeForContract: guaranteeForContract,
    mymSubType: mymSubType,
    buildMymContract: buildMymContract,
    validateMym: validateMym,
    buildMymPayload: buildMymPayload,
    submitMym: submitMym
  };
})();
