/* site/m/front_office_myac_submit.js
 *
 * VERBATIM-LOGIC MIRROR of the MYAC (Multi-Year Auction Contract, §C2)
 * pipeline in site/rosters/v2/front_office.js — the current contract-logic
 * source of truth (MYAC lives ONLY in v2/front_office.js, not the older
 * roster_workbench.js the other mobile mirrors came from).
 *
 * MYAC (§C2): a 1-year DEFAULT from a fresh acquisition (Vet-ERA win or a
 * THIS-season FA-auction Veteran) can be set to a 2- or 3-year contract at
 * the SAME salary — TCV = bid × years, with NO escalator (that's §C4
 * Extensions). It may be loaded (FL/BL): free-key Y1 in whole $1,000s, last
 * year auto-computes, Y1 ≥ 20% TCV, hard cap of 5 loaded contracts per roster.
 * Records as Vet-ERA / Vet-FAA (the acquisition method survives MYAC, §A3).
 *
 * This module owns the MATH + PAYLOAD only; player_sheet.js owns the mobile
 * sheet/confirm UI (same split as front_office_extend_submit.js). All MFL
 * writes go to the SAME worker route the desktop uses
 * (/commish-contract-update, MANUAL_CONTRACT_UPDATE, submission_kind:"myac"),
 * owner-initiated and dry_run-capable.
 *
 * DO NOT EDIT logic. If desktop changes, copy the updated function bodies
 * here verbatim. Source-of-truth lines (v2/front_office.js):
 *   fmtK (180) · fmtUSD (171)
 *   isLoadedRow (1996) · LOADED_MAX (1995)
 *   myacStatusBase (3115) · submitMyacContract (3121)
 *   openMyacForm (3155) · loadedContractCountForTeam (3164)
 *   openMyacLoadedForm (3172)
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

  // ── BEGIN verbatim mirror from v2/front_office.js ─────────────────────

  // fmtUSD (171) — human dollar string for confirms + validation messages.
  function fmtUSD(n) {
    var v = Number(n);
    if (!isFinite(v)) return "—";
    if (v === 0) return "$0";
    try { return "$" + Math.round(v).toLocaleString("en-US"); }
    catch (e) { return "$" + String(Math.round(v)); }
  }
  // fmtK (180) WITH the desktop "$"-strip applied — i.e. fmtK(n).replace(/\$/,"").
  // CRITICAL: a value ≤ 0 yields "0" (NOT "0K") because desktop fmtK returns
  // "$0" for ≤0 then strips the "$". The MYAC contractInfo GTD token is "0"
  // for any TCV ≤ $4K — getting this byte-exact keeps contract_info identical
  // to desktop so downstream parsers (and audits) agree.
  function fmtKbare(n) {
    var dollars = Math.round(Number(n) || 0);
    if (dollars <= 0) return "0";
    var k = dollars / 1000;
    var text = Math.round(k * 10) / 10;
    return String(text).replace(/\.0$/, "") + "K";
  }

  var LOADED_MAX = 5;   // §C2 loaded-contract roster cap (v2/front_office.js:1995)

  // isLoadedRow (1996) — a loaded contract is an EXPLICIT front/back-loaded
  // deal: the -FL / -BL suffix on the canonical contractStatus. Accepts a
  // mobile rosterRow (contractStatus) or a desktop-style player (type).
  function isLoadedRow(row) {
    var t = safeStr(row && (row.contractStatus != null ? row.contractStatus : row.type)).toUpperCase();
    return t.indexOf("-FL") >= 0 || t.indexOf("-BL") >= 0 || t === "FL" || t === "BL";
  }

  // myacStatusBase (3115) — the acquisition method survives MYAC (§A3): a
  // "-era" contractStatus records as Vet-ERA, everything else as Vet-FAA.
  //
  // WW: a PRE-SEASON WAIVER pickup is MYAC-eligible too (canon ~379 — the same
  // ladder the Discord waiver post prints), and desktop's version predates that
  // path being reachable, so its "everything else" would have relabelled a
  // Vet-WW / Rookie-WW claim as an FA-auction win the moment mobile started
  // offering the button. The acquisition method has to survive here as much as
  // it does for ERA, so WW is carried through explicitly (suffix preserved for
  // Rookie-WW, which is a rookie contract, not a veteran one).
  //
  // FAA needs the SAME rookie carve-out (Keith 2026-08-03, re: Zavion Thomas —
  // "shows as Vet where he should show as rookie" — the worker's
  // finalizeFaaContracts already writes "Rookie-FAA" at auction close for
  // exactly this reason, worker/src/index.js ~2506). Without it, a rookie won
  // at the FA Auction loses their rookie designation — and its downstream
  // ERA-eligibility-on-expiry — the moment they submit a MYAC. ERA itself
  // carries no rookie carve-out: winning the ERA already means the player's
  // original rookie deal expired, so "Vet-ERA" is correct regardless of NFL
  // rookie year.
  function myacStatusBase(row) {
    var t = safeStr(row && (row.contractStatus != null ? row.contractStatus : row.type)).toLowerCase();
    if (t.indexOf("-era") !== -1) return "Vet-ERA";
    var isRookie = /rookie/.test(t);
    if (/\bww\b/.test(t)) return isRookie ? "Rookie-WW" : "Vet-WW";
    return isRookie ? "Rookie-FAA" : "Vet-FAA";
  }

  // Loaded-contract count for the viewer's roster — mirror of
  // loadedContractCountForTeam (3164): non-taxi rows whose contractStatus is
  // FL/BL. Mobile rosterRows carry `status` ("TAXI"/"IR"/…), so taxi is
  // detected from that (desktop used q.isTaxi).
  function loadedContractCount(rosterRows) {
    if (!Array.isArray(rosterRows)) return 0;
    return rosterRows.filter(function (q) {
      var isTaxi = /taxi/i.test(safeStr(q && q.status));
      return !isTaxi && isLoadedRow(q);
    }).length;
  }

  // Derive the full contract from a per-year salary array — the pre-confirm
  // half of submitMyacContract (3122-3130). TCV = Σ years, AAV = round(TCV/N),
  // FL/BL suffix auto-derived from the shape, GTD per guaranteeForMyacContract
  // below, and the canonical contract_info string (byte-identical to desktop).
  //
  // GTD mirror of desktop guaranteeForContract (v2/front_office.js:477-481).
  // This file previously hardcoded `tcv > 4000 ? 0.75*tcv : 0`, which DROPPED
  // desktop's sub-$5K 2/3-year $1,000 floor (canon §D1) — so the same player
  // and the same button wrote "GTD: 0" on mobile and "GTD: 1K" on desktop.
  // Concretely wrong for cheap auction wins: Zaire Franklin ($1K -> TCV 2K on
  // a 2-yr) and Blake Cashman ($2K -> TCV 4K on a 2-yr) both land in the gap.
  function guaranteeForMyacContract(tcv, yearsRemaining) {
    var t = safeInt(tcv, 0);
    if (t > 4000) return Math.round(t * 0.75);
    return safeInt(yearsRemaining, 0) >= 2 ? 1000 : 0;
  }

  function buildMyacContract(totalYears, yrs, statusBase) {
    var tcv = yrs.reduce(function (a, b) { return a + b; }, 0);
    var aav = Math.round(tcv / totalYears);
    var loaded = yrs.some(function (v) { return v !== yrs[0]; });
    var status = statusBase + (loaded ? (yrs[0] > aav ? "-FL" : "-BL") : "");
    var gtd = guaranteeForMyacContract(tcv, totalYears);
    var contractInfo = "CL " + totalYears +
      "|TCV " + fmtKbare(tcv) +
      "|AAV " + fmtKbare(aav) +
      "|" + yrs.map(function (v, i) { return "Y" + (i + 1) + "-" + fmtKbare(v); }).join(", ") +
      "|GTD: " + fmtKbare(gtd);
    return {
      totalYears: totalYears, yrs: yrs, tcv: tcv, aav: aav,
      loaded: loaded, status: status, gtd: gtd, contractInfo: contractInfo
    };
  }

  // Flat MYAC year array — openMyacForm (3155): keep the auction salary flat
  // across `totalYears` (TCV = bid × N). Returns { error } if the base salary
  // is below the $1,000 floor.
  function flatMyacYears(rosterRow, totalYears) {
    var bid = safeInt(rosterRow && rosterRow.salary, 0);
    if (bid < 1000) return { error: "MYAC needs a base salary ≥ $1,000." };
    var yrs = [];
    for (var i = 0; i < totalYears; i += 1) yrs.push(bid);
    return { yrs: yrs, bid: bid };
  }

  // Loaded-form constants — openMyacLoadedForm (3172-3178). Flat baseline:
  // TCV = bid × years (NO escalator, §C2), AAV = bid, Y1 floor = 20% TCV
  // rounded up to whole $1,000s.
  function loadedMyacConstraints(rosterRow, totalYears) {
    var bid = safeInt(rosterRow && rosterRow.salary, 0);
    var tcv = bid * totalYears;
    var aav = bid;
    var minY1 = Math.ceil(tcv * 0.2 / 1000) * 1000;
    return { bid: bid, tcv: tcv, aav: aav, minY1: minY1, totalYears: totalYears };
  }

  // Loaded year array from the owner's free-key inputs — readYrs (3202-3207).
  // 2-yr: Y1 free → Y2 auto. 3-yr: Y1 & Y2 free → Y3 auto. The last year
  // always back-fills to TCV so the total is preserved.
  function loadedMyacYears(constraints, y1, y2) {
    var tcv = constraints.tcv;
    if (constraints.totalYears === 3) return [y1, y2, tcv - y1 - y2];
    return [y1, tcv - y1];
  }

  // validateYrs (3208-3213) — whole $1,000s, Y1 ≥ 20% TCV floor, no $0 year.
  function validateLoadedYears(yrs, minY1) {
    if (yrs.some(function (v) { return v % 1000 !== 0; })) return "All years must be whole $1,000 increments.";
    if (yrs[0] < minY1) return "Year 1 must be ≥ " + fmtUSD(minY1) + " (20% of TCV).";
    if (yrs.some(function (v) { return v < 1000; })) return "No year can be below $1,000 — there are no $0 years.";
    return "";
  }

  // ── END verbatim mirror ──────────────────────────────────────────────

  // ── HTTP submit helpers (same pattern as front_office_extend_submit.js) ─
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

  // Build the MYAC submit payload — exactly matches the desktop
  // submitMyacContract body (3136-3144): MANUAL_CONTRACT_UPDATE +
  // submission_kind:"myac". salary is Y1, contract_year is the FULL length.
  // `contract` is the object returned by buildMyacContract.
  function buildMyacPayload(args) {
    var leagueId = safeStr(args.leagueId);
    var year = safeStr(args.year);
    var c = args.contract || {};
    var rosterRow = args.rosterRow || {};
    var yrs = c.yrs || [];
    return {
      L: leagueId, YEAR: year,
      type: "MANUAL_CONTRACT_UPDATE",
      submission_kind: "myac",
      dry_run: args.dryRun ? 1 : 0,
      source: "ups-mobile-myac-submit",
      leagueId: leagueId, year: year,
      player_id: safeStr(args.pid),
      player_name: safeStr(args.playerName),
      franchise_id: pad4(args.fid),
      franchise_name: safeStr(args.franchiseName),
      position: safeStr(args.position),
      salary: safeInt(yrs[0], 0),
      contract_year: safeInt(c.totalYears, 0),
      contract_status: safeStr(c.status),
      contract_info: safeStr(c.contractInfo),
      prior_contract_status: safeStr(rosterRow.contractStatus),
      prior_salary: safeInt(rosterRow.salary, 0),
      prior_contract_year: safeInt(rosterRow.contractYear, 0),
      prior_contract_info: safeStr(rosterRow.contractInfo),
      submitted_at_utc: new Date().toISOString(),
      commish_override_flag: args.commishOverride ? 1 : 0
    };
  }

  function submitMyac(args) {
    var workerBase = String(args.workerBase || "").replace(/\/+$/, "");
    var url = workerBase + "/commish-contract-update?L=" +
      encodeURIComponent(args.leagueId) + "&YEAR=" + encodeURIComponent(args.year);
    var payload = buildMyacPayload(args);
    return postContractUpdate(url, payload).then(function (resp) {
      if (resp.ok) return { ok: true, status: resp.status, body: resp.body, payload: payload };
      return { ok: false, status: resp.status, body: resp.body,
               error: (resp.body && resp.body.error) || ("HTTP " + resp.status) };
    });
  }

  window.UPS_M_FO_MYAC = {
    LOADED_MAX: LOADED_MAX,
    fmtUSD: fmtUSD,
    isLoadedRow: isLoadedRow,
    myacStatusBase: myacStatusBase,
    loadedContractCount: loadedContractCount,
    buildMyacContract: buildMyacContract,
    flatMyacYears: flatMyacYears,
    loadedMyacConstraints: loadedMyacConstraints,
    loadedMyacYears: loadedMyacYears,
    validateLoadedYears: validateLoadedYears,
    buildMyacPayload: buildMyacPayload,
    submitMyac: submitMyac
  };
})();
