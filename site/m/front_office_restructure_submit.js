/* site/m/front_office_restructure_submit.js
 *
 * VERBATIM MIRROR of the restructure helpers + submit pipeline in
 * site/rosters/roster_workbench.js. Mobile presents the same Y1/Y2
 * input editor with the same validation (Y1 ≥ 20% of TCV, 1K
 * increments, Y2 derived for 2yr, etc.), and POSTs to the same
 * /offer-restructure worker endpoint with the identical payload.
 *
 * DO NOT EDIT logic. Source-of-truth lines (roster_workbench.js):
 *   safeStr (201) · safeInt (226) · pad4 (315) · formatContractK (361)
 *   parseContractMoneyToken (346)
 *   parseContractYearValues (1604) · contractLengthForPlayer (1618)
 *   contractYearIndexForPlayer (1631) · currentContractYearValue (1638)
 *   contractYearFallbackValue (1662) · contractYearValueMapForPlayer (1680)
 *   parseContractTcvValue (384) · currentAavForContractInfo (483)
 *   parseContractAavValues (369) · parseContractLengthValue (400)
 *   restructureRoundToK (7285)
 *   restructureRemainingContractAmountsForPlayer (7291)
 *   isThousandStep (7315) · actionModalRestructureCalc (7331)
 *   submitRestructureUpdate (10975)
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
  function money(n) {
    var v = Math.round(safeNum(n, 0));
    var sign = v < 0 ? "-" : "";
    var abs = Math.abs(v);
    try { return sign + "$" + abs.toLocaleString("en-US"); }
    catch (e) { return sign + "$" + String(abs); }
  }
  function parseContractMoneyToken(token) {
    var raw = safeStr(token).toUpperCase().replace(/\$/g, "");
    if (!raw) return 0;
    var cleaned = raw.replace(/[^0-9K.\-]/g, "");
    if (!cleaned) return 0;
    var mult = cleaned.indexOf("K") !== -1 ? 1000 : 1;
    cleaned = cleaned.replace(/K/g, "");
    if (!cleaned) return 0;
    var num = Number(cleaned);
    if (!isFinite(num)) return 0;
    var amount = Math.round(num * mult);
    if (mult === 1 && amount > 0 && amount < 1000) amount *= 1000;
    return amount;
  }
  function parseContractYearValues(contractInfo) {
    var info = safeStr(contractInfo);
    var out = Object.create(null);
    if (!info) return out;
    var re = /Y(\d+)\s*-\s*([0-9]+(?:\.[0-9]+)?K?)(?=\s*(?:,|\||Y\d+\s*-|$))/ig;
    var match;
    while ((match = re.exec(info))) {
      var idx = safeInt(match[1], 0);
      var amount = parseContractMoneyToken(match[2]);
      if (idx > 0 && amount > 0) out[idx] = amount;
    }
    return out;
  }
  function parseContractLengthValue(contractInfo) {
    var info = safeStr(contractInfo);
    if (!info) return 0;
    var match = info.match(/(?:^|\|)\s*CL\s*:?\s*(\d+)/i);
    return match && safeStr(match[1]) ? Math.max(0, safeInt(match[1], 0)) : 0;
  }
  function parseContractTcvValue(contractInfo) {
    var info = safeStr(contractInfo);
    if (!info) return 0;
    var match = info.match(/(?:^|\|)\s*TCV\s+([^|]+)/i);
    if (!match || !safeStr(match[1])) return 0;
    return parseContractMoneyToken(match[1]);
  }
  function parseContractAavValues(contractInfo) {
    var info = safeStr(contractInfo);
    if (!info) return [];
    var match = info.match(/(?:^|\|)\s*AAV\s*([^|]+)/i);
    if (!match || !safeStr(match[1])) return [];
    var segment = safeStr(match[1]).replace(/\bY\d+\s*-[^|]*$/i, "");
    return segment.split(/[\/,]/).map(function (token) {
      var moneyMatch = safeStr(token).match(/-?\d+(?:\.\d+)?K?/i);
      return parseContractMoneyToken(moneyMatch ? moneyMatch[0] : "");
    }).filter(function (a) { return a > 0; });
  }
  // Extract the raw AAV token string VERBATIM (e.g. "42K, 52K") so a restructure
  // preserves the extension's dual AAV byte-for-byte instead of re-averaging
  // TCV/CL (the Cook/London bug). Returns "" when no AAV token is present.
  function parseContractAavRawToken(contractInfo) {
    var info = safeStr(contractInfo);
    if (!info) return "";
    var match = info.match(/(?:^|\|)\s*AAV\s+([^|]+)/i);
    if (!match) return "";
    return safeStr(match[1]).replace(/\bY\d+\s*-[^|]*$/i, "").trim();
  }
  function currentAavForContractInfo(contractInfo) {
    var values = parseContractAavValues(contractInfo);
    return values.length ? safeInt(values[0], 0) : 0;
  }
  function contractLengthForPlayer(player) {
    var values = parseContractYearValues(player && player.special);
    var keys = Object.keys(values);
    var explicitLength = parseContractLengthValue(player && player.special);
    var parsedLength = 0;
    if (keys.length) {
      parsedLength = keys.reduce(function (max, key) {
        return Math.max(max, safeInt(key, 0));
      }, 0);
    }
    return Math.max(parsedLength, explicitLength, Math.max(0, safeInt(player && player.years, 0)));
  }
  function contractYearIndexForPlayer(player) {
    var length = contractLengthForPlayer(player);
    var years = Math.max(0, safeInt(player && player.years, 0));
    if (length <= 0 || years <= 0) return 0;
    return Math.max(1, length - years + 1);
  }
  function currentContractYearValue(player) {
    var yearValues = parseContractYearValues(player && player.special);
    var idx = contractYearIndexForPlayer(player);
    if (idx > 0 && yearValues[idx] > 0) return safeInt(yearValues[idx], 0);
    return Math.max(0, safeInt(player && player.salary, 0));
  }
  function contractYearFallbackValue(player, yearIndex) {
    var idx = Math.max(1, safeInt(yearIndex, 1));
    var currentIdx = Math.max(1, contractYearIndexForPlayer(player));
    var length = Math.max(0, contractLengthForPlayer(player));
    var salary = Math.max(0, safeInt(player && player.salary, 0));
    var aavValues = parseContractAavValues(player && player.special);
    var aav = Math.max(0, safeInt(player && player.aav, 0) || currentAavForContractInfo(player && player.special));
    if (idx === currentIdx && salary > 0) return salary;
    if (aavValues[idx - 1] > 0) return safeInt(aavValues[idx - 1], 0);
    if (aavValues.length > 1 && aavValues[aavValues.length - 1] > 0) {
      return safeInt(aavValues[aavValues.length - 1], 0);
    }
    if (aav > 0) return aav;
    var explicitTcv = parseContractTcvValue(player && player.special);
    if (explicitTcv > 0 && length > 0) return Math.round(explicitTcv / Math.max(1, length));
    return salary;
  }
  function contractYearValueMapForPlayer(player) {
    var out = parseContractYearValues(player && player.special);
    var keys = Object.keys(out);
    if (keys.length) return out;
    var length = Math.max(0, contractLengthForPlayer(player));
    for (var i = 1; i <= length; i += 1) {
      var amount = contractYearFallbackValue(player, i);
      if (amount > 0) out[i] = amount;
    }
    return out;
  }

  function restructureRoundToK(value) {
    var n = safeInt(value, 0);
    if (n <= 0) return 0;
    return Math.ceil(n / 1000) * 1000;
  }
  function isThousandStep(value) {
    var n = safeInt(value, 0);
    return n > 0 && n % 1000 === 0;
  }
  // Mirrors restructureRemainingContractAmountsForPlayer (7291). Returns
  // the baseline { tcv, y1, y2, y3 } from the player's CURRENT contract —
  // these are what the user is "reshaping" (TCV preserved).
  function restructureBaselineForPlayer(player, years) {
    var yearsInt = safeInt(years, 2) >= 3 ? 3 : 2;
    var fallback = Math.max(1000, restructureRoundToK(safeInt(player && player.salary, 0) || 1000));
    var currentIdx = Math.max(1, contractYearIndexForPlayer(player));
    var yearValues = contractYearValueMapForPlayer(player);
    var amounts = [];
    for (var i = 0; i < yearsInt; i += 1) {
      var yearIdx = currentIdx + i;
      var amount = safeInt(yearValues[yearIdx], 0);
      if (amount <= 0 && i === 0) amount = currentContractYearValue(player);
      if (amount <= 0) amount = contractYearFallbackValue(player, yearIdx);
      amounts.push(Math.max(1000, restructureRoundToK(amount || fallback)));
    }
    var tcv = amounts.reduce(function (s, a) { return s + Math.max(0, safeInt(a, 0)); }, 0);
    return {
      tcv: Math.max(yearsInt * 1000, tcv),
      y1: Math.max(1000, safeInt(amounts[0], fallback)),
      y2: Math.max(1000, safeInt(amounts[1], fallback)),
      y3: yearsInt === 3 ? Math.max(1000, safeInt(amounts[2], fallback)) : 0
    };
  }

  // Mirrors actionModalRestructureCalc (7331). Validates user-supplied
  // y1 (and y2 for 3yr) against the baseline TCV. Returns
  // { ok, error, years, tcv, y1, y2, y3, aav, gtd, contractInfo }.
  function restructureCalc(inputs) {
    inputs = inputs || {};
    var yearsInt = safeInt(inputs.years, 2) >= 3 ? 3 : 2;
    var tcv = Math.max(0, safeInt(inputs.tcv, 0));
    // PRESERVE the prior AAV token VERBATIM — a restructure re-slots the year
    // salaries + TCV + GTD but must NOT recompute the AAV (the extension's dual
    // AAV stays fixed; TCV/CL re-averaging was the Cook/London bug). The numeric
    // `aav` (display + D1 ledger) is the current-year tier; fall back to the naive
    // average ONLY when the prior contract carries no AAV token.
    var priorInfo = safeStr(inputs.priorContractInfo);
    var priorAavToken = parseContractAavRawToken(priorInfo);
    var priorAavValues = parseContractAavValues(priorInfo);
    var aav = priorAavValues.length
      ? safeInt(priorAavValues[0], 0)
      : (yearsInt > 0 ? Math.round((tcv / yearsInt) * 10) / 10 : 0);
    var y1 = safeInt(inputs.y1, 0);
    var y2Input = safeInt(inputs.y2, 0);
    var extSuffix = safeStr(inputs.extSuffix);
    var errors = [];

    if (!tcv || tcv < yearsInt * 1000) errors.push("Remaining contract value could not be determined.");
    if (!isThousandStep(y1)) errors.push("Year 1 must be in 1,000 increments.");
    var minY1 = Math.ceil((tcv * 0.2) / 1000) * 1000;
    if (y1 < minY1) errors.push("Year 1 must be at least 20% of TCV (" + money(minY1) + ").");

    var y2 = 0;
    var y3 = 0;
    if (yearsInt === 2) {
      var derivedY2 = tcv - y1;
      y2 = Math.max(0, derivedY2);
      if (!isThousandStep(derivedY2) || derivedY2 < 1000) errors.push("Year 2 must be at least 1,000 after applying Year 1.");
    } else {
      y2 = y2Input;
      if (!isThousandStep(y2) || y2 < 1000) errors.push("Year 2 must be at least 1,000 and in 1,000 increments.");
      y3 = tcv - y1 - y2;
      if (!isThousandStep(y3) || y3 < 1000) errors.push("Year 3 must be at least 1,000 after Year 1 + Year 2.");
    }

    if (errors.length) {
      return { ok: false, error: errors[0], years: yearsInt, tcv: tcv, y1: y1, y2: y2, y3: y3, aav: aav };
    }
    var gtd = tcv > 4000 ? Math.round(tcv * 0.75) : Math.max(0, tcv - y1);
    var yearParts = ["Y1-" + formatContractK(y1), "Y2-" + formatContractK(y2)];
    if (yearsInt === 3) yearParts.push("Y3-" + formatContractK(y3));
    // AAV segment = the prior token VERBATIM (dual preserved); fall back to the
    // naive average only when no prior AAV token existed.
    var aavSegment = priorAavToken || formatContractK(aav);
    var infoParts = [
      "CL " + yearsInt,
      "TCV " + formatContractK(tcv),
      "AAV " + aavSegment,
      yearParts.join(", "),
      "GTD: " + formatContractK(gtd)
    ];
    if (extSuffix) infoParts.push(extSuffix);
    infoParts.push("Restructured " + new Date().getFullYear());
    // §C5 / T3.4: the -FL / -BL suffix on a RESTRUCTURE follows which way the money
    // MOVED — new current-year (Y1) salary vs the PRE-restructure current-year
    // salary: LOWERED → -BL (pushed back), RAISED → -FL (pulled forward). 🔒 Keith
    // ruling 2026-07-23 — do NOT use "Y1 vs AAV" (breaks on escalated dual-AAV
    // deals: Hurts 67→47 is -BL even though Y1-47 > AAV-42). Strip any existing
    // suffix; equal = flat = no suffix. Empty base = leave for the payload's
    // prior-status fallback.
    var priorCurrentSalary = safeInt(parseContractYearValues(priorInfo)[1], 0) ||
                             Math.max(0, restructureRoundToK(safeInt(inputs.priorSalary, 0)));
    var baseType = safeStr(inputs.priorContractStatus).replace(/-(FL|BL)$/i, "");
    var loadSuffix = (priorCurrentSalary > 0 && y1 > priorCurrentSalary) ? "-FL"
                   : ((priorCurrentSalary > 0 && y1 < priorCurrentSalary) ? "-BL" : "");
    return {
      ok: true, years: yearsInt, tcv: tcv, y1: y1, y2: y2, y3: y3, aav: aav, gtd: gtd,
      contractInfo: infoParts.join("| "),
      contractStatus: baseType ? (baseType + loadSuffix) : ""
    };
  }

  // ── END verbatim mirror ──────────────────────────────────────────────

  // ── HTTP submit helpers (mirror of postContractUpdate retry pattern) ──
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

  // Build the restructure payload — verbatim from submitRestructureUpdate
  // (10975-11021). type="RESTRUCTURE" (NOT MANUAL_CONTRACT_UPDATE).
  function buildRestructurePayload(args) {
    var leagueId = safeStr(args.leagueId);
    var year = safeStr(args.year);
    var calc = args.calc || {};
    return {
      L: leagueId, YEAR: year,
      leagueId: leagueId, year: year,
      type: "RESTRUCTURE",
      player_id: safeStr(args.pid),
      player_name: safeStr(args.playerName),
      franchise_id: safeStr(args.fid),
      franchise_name: safeStr(args.franchiseName),
      position: safeStr(args.position),
      salary: safeInt(calc.y1, 0),
      contract_year: safeInt(calc.years, 0),
      // -FL/-BL re-derived from the restructure's money-movement direction
      // (calc.contractStatus); fall back to the prior sub-type if unresolved.
      contract_status: safeStr(calc.contractStatus) || safeStr(args.priorContractStatus),
      contract_info: safeStr(calc.contractInfo),
      tcv: safeInt(calc.tcv, 0),
      aav: safeInt(calc.aav, 0),
      guaranteed: safeInt(calc.gtd, 0),
      submitted_at_utc: new Date().toISOString(),
      commish_override_flag: args.commishOverride ? 1 : 0
    };
  }

  function submitRestructure(args) {
    var workerBase = String(args.workerBase || "").replace(/\/+$/, "");
    var url = workerBase + "/offer-restructure?L=" +
      encodeURIComponent(args.leagueId) + "&YEAR=" + encodeURIComponent(args.year);
    var payload = buildRestructurePayload(args);
    return postContractUpdate(url, payload).then(function (resp) {
      if (resp.ok) return { ok: true, status: resp.status, body: resp.body, payload: payload };
      return { ok: false, status: resp.status, body: resp.body,
               error: (resp.body && resp.body.error) || ("HTTP " + resp.status) };
    });
  }

  // Adapt a mobile rosterRow to the desktop "player" shape for the
  // baseline helpers (which read .special, .salary, .years).
  function adaptRosterRow(rosterRow, fid) {
    if (!rosterRow) return null;
    return {
      id: rosterRow.id,
      years: rosterRow.contractYear,
      salary: rosterRow.salary,
      special: rosterRow.contractInfo,
      type: rosterRow.contractStatus,
      fid: fid || rosterRow.fid || rosterRow.franchise_id || ""
    };
  }

  window.UPS_FRONT_OFFICE_RSTR = {
    restructureBaselineForPlayer: restructureBaselineForPlayer,
    restructureCalc: restructureCalc,
    isThousandStep: isThousandStep,
    restructureRoundToK: restructureRoundToK,
    buildRestructurePayload: buildRestructurePayload,
    submitRestructure: submitRestructure,
    adaptRosterRow: adaptRosterRow
  };
})();
