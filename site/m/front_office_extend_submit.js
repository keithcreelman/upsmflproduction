/* site/m/front_office_extend_submit.js
 *
 * VERBATIM MIRROR of the extension option transform + submit pipeline
 * in site/rosters/roster_workbench.js. Mobile fetches the same
 * extension_previews_<year>.json that Front Office consumes, applies
 * the same case-A/case-B reshape (so 1-yr-remaining and expired-rookie
 * cases come out identical), then POSTs the same payload to
 * /commish-contract-update.
 *
 * DO NOT EDIT logic. Source-of-truth lines (roster_workbench.js):
 *   safeStr (201) · safeInt (226) · pad4 (315) · formatContractK (361)
 *   normalizeExtensionTermValue (1010)
 *   normalizeExtensionLoadedIndicator (1017)
 *   extensionOptionKey (1025)
 *   extensionActionLabel (1042) · extensionOptionSummary (1049)
 *   extensionSalaryToSendFromPreview (1076)
 *   normalizeExtensionPreviewRow (1085) · normalizeExtensionPreviewRows (1149)
 *   parseContractYearValues (1604)
 *   playerExtensionOptions (1369)  — case-A / case-B reshape
 *   submitExtensionUpdate (10839)
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
  function asArray(v) {
    if (Array.isArray(v)) return v;
    if (v == null || v === "") return [];
    return [v];
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
    try {
      return sign + "$" + abs.toLocaleString("en-US");
    } catch (e) {
      return sign + "$" + String(abs);
    }
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
  function normalizeExtensionTermValue(term) {
    var raw = safeStr(term).toUpperCase();
    if (raw === "2" || raw.indexOf("2YR") === 0) return 2;
    if (raw === "1" || raw.indexOf("1YR") === 0) return 1;
    return 0;
  }
  function normalizeExtensionLoadedIndicator(indicator) {
    var raw = safeStr(indicator).toUpperCase();
    if (!raw || raw === "NONE") return "NONE";
    if (raw === "FL") return "FL";
    if (raw === "BL") return "BL";
    return raw;
  }
  function extensionOptionKey(row) {
    var explicit = safeStr(row && (row.optionKey || row.option_key));
    if (explicit) return explicit;
    var years = safeInt(row && row.yearsToAdd, 0);
    if (years !== 1 && years !== 2) {
      years = normalizeExtensionTermValue(row && (row.extension_term || row.extensionTerm || row.term));
    }
    var loaded = normalizeExtensionLoadedIndicator(row && (row.loadedIndicator || row.loaded_indicator));
    var status = safeStr(
      row && (row.contractStatus || row.new_contract_status || row.contract_status)
    ).toUpperCase();
    var info = safeStr(
      row && (row.contractInfo || row.preview_contract_info_string || row.contract_info)
    );
    return [String(years || 0), loaded || "NONE", status, info].join("|");
  }
  function extensionActionLabel(option) {
    if (!option) return "Extend";
    var label = "Extend " + (safeInt(option.yearsToAdd, 0) === 2 ? "2Y" : "1Y");
    if (safeStr(option.loadedIndicator) !== "NONE") label += " " + safeStr(option.loadedIndicator);
    return label;
  }
  function extensionOptionSummary(option) {
    var parts = [];
    var contractLength = safeInt(option && option.contractLength, 0);
    var yearsToAdd = safeInt(option && option.yearsToAdd, 0);
    if (contractLength > 0) parts.push(String(contractLength) + " years");
    if (safeInt(option && option.futureAav, 0) > 0) {
      var aavLabel = (contractLength > yearsToAdd && yearsToAdd > 0) ? "Future AAV " : "AAV ";
      parts.push(aavLabel + money(option.futureAav));
    }
    if (safeInt(option && option.tcv, 0) > 0) parts.push("TCV " + money(option.tcv));
    if (safeStr(option && option.loadedIndicator) === "FL") parts.push("Front-loaded");
    if (safeStr(option && option.loadedIndicator) === "BL") parts.push("Back-loaded");
    return parts.join(" | ");
  }
  function extensionSalaryToSendFromPreview(contractInfo, contractLength, fallbackFutureAav, fallbackCurrentAav) {
    var idx = Math.max(0, safeInt(contractLength, 0));
    var yearValues = parseContractYearValues(contractInfo);
    if (idx > 0 && yearValues[idx] > 0) return safeInt(yearValues[idx], 0);
    var future = safeInt(fallbackFutureAav, 0);
    if (future > 0) return future;
    return Math.max(0, safeInt(fallbackCurrentAav, 0));
  }
  function normalizeExtensionPreviewRow(row) {
    var yearsToAdd = safeInt(row && row.yearsToAdd, 0);
    if (yearsToAdd !== 1 && yearsToAdd !== 2) {
      yearsToAdd = normalizeExtensionTermValue(row && (row.extension_term || row.extensionTerm || row.term));
    }
    var contractLength = safeInt(
      row && (
        row.contractLength != null
          ? row.contractLength
          : (row.new_contract_length != null
              ? row.new_contract_length
              : (row.contract_year != null ? row.contract_year : row.contractYear))
      ),
      0
    );
    var contractInfo = safeStr(
      row && (row.contractInfo || row.preview_contract_info_string || row.contract_info)
    );
    var contractStatus = safeStr(
      row && (row.contractStatus || row.new_contract_status || row.contract_status)
    ).toUpperCase();
    var currentAav = safeInt(
      row && (
        row.currentAav != null
          ? row.currentAav
          : (row.new_aav_current != null ? row.new_aav_current : (row.newAavCurrent != null ? row.newAavCurrent : row.current_salary))
      ),
      0
    );
    var futureAav = safeInt(
      row && (
        row.futureAav != null
          ? row.futureAav
          : (row.new_aav_future != null ? row.new_aav_future : (row.newAavFuture != null ? row.newAavFuture : row.salary))
      ),
      0
    );
    var tcv = safeInt(
      row && (row.tcv != null ? row.tcv : (row.new_TCV != null ? row.new_TCV : row.newTcv)),
      0
    );
    var loadedIndicator = normalizeExtensionLoadedIndicator(
      row && (row.loadedIndicator || row.loaded_indicator)
    );
    var salaryToSend = extensionSalaryToSendFromPreview(contractInfo, contractLength, futureAav, currentAav);

    if (!yearsToAdd || contractLength <= 0 || !contractInfo || !contractStatus || salaryToSend <= 0) {
      return null;
    }

    return {
      optionKey: extensionOptionKey(row),
      yearsToAdd: yearsToAdd,
      loadedIndicator: loadedIndicator,
      contractLength: contractLength,
      contractStatus: contractStatus,
      contractInfo: contractInfo,
      currentAav: currentAav,
      futureAav: futureAav,
      tcv: tcv,
      salaryToSend: salaryToSend
    };
  }
  function normalizeExtensionPreviewRows(rows) {
    var out = [];
    var seen = Object.create(null);
    var list = asArray(rows);
    for (var i = 0; i < list.length; i += 1) {
      var option = normalizeExtensionPreviewRow(list[i]);
      if (!option) continue;
      if (seen[option.optionKey]) continue;
      seen[option.optionKey] = true;
      out.push(option);
    }
    return out;
  }

  // playerExtensionOptions case-A/case-B reshape (1369). The previews JSON
  // is computed against a roster snapshot; this re-aligns options to the
  // player's LIVE cy and salary so Y1/Y2/TCV are right.
  function applyExtensionOptionReshape(options, rosterRow) {
    if (!Array.isArray(options) || !options.length) return options || [];
    var yearsRemaining = safeInt(rosterRow && rosterRow.contractYear, 0);
    var currentSalary = safeInt(rosterRow && rosterRow.salary, 0);

    function cleanExtSegment(info) {
      return info.replace(/(Ext:\s*)([^|]*)/i, function (_m, pfx, body) {
        var cleaned = String(body).replace(/[^\x20-\x7E]/g, "");
        cleaned = cleaned.replace(/\s{2,}/g, " ").replace(/^[,\s]+|[,\s]+$/g, "");
        return pfx + cleaned;
      });
    }

    return options.map(function (opt) {
      if (!opt) return opt;
      var yearsToAdd = safeInt(opt.yearsToAdd, 0);
      if (yearsToAdd !== 1 && yearsToAdd !== 2) return opt;
      var futureAav = safeInt(opt.futureAav, 0);
      if (!futureAav) return opt;
      var originalInfo = safeStr(opt.contractInfo);

      // CASE A — cy === 1 with current salary. Y1 = current salary,
      // Y2+ = futureAav. Length = 1 + yearsToAdd.
      if (yearsRemaining === 1 && currentSalary > 0) {
        var fixedTcvA = currentSalary + futureAav * yearsToAdd;
        var yearTokensA = ["Y1-" + formatContractK(currentSalary)];
        for (var y = 0; y < yearsToAdd; y += 1) {
          yearTokensA.push("Y" + (y + 2) + "-" + formatContractK(futureAav));
        }
        var rebuiltA = originalInfo
          .replace(/CL\s+\d+/i, "CL " + (1 + yearsToAdd))
          .replace(/TCV\s+[\d.]+K?/i, "TCV " + formatContractK(fixedTcvA))
          .replace(/Y1-[\d.]+K?/ig, yearTokensA[0])
          .replace(/Y2-[\d.]+K?/ig, yearTokensA[1] || "Y2-0K")
          .replace(/Y3-[\d.]+K?/ig, yearTokensA[2] || "Y3-0K");
        var gtdA = fixedTcvA > 4000 ? Math.round(fixedTcvA * 0.75) : Math.max(0, fixedTcvA - currentSalary);
        rebuiltA = rebuiltA.replace(/GTD:\s*[\d.]+K?/i, "GTD: " + formatContractK(gtdA));
        return Object.assign({}, opt, {
          contractLength: 1 + yearsToAdd,
          tcv: fixedTcvA,
          contractInfo: cleanExtSegment(rebuiltA),
          salaryToSend: currentSalary
        });
      }

      // CASE B — expired rookie (cy <= 0). Fresh contract, all years at
      // futureAav, length = yearsToAdd.
      if (yearsRemaining <= 0) {
        var fixedTcvB = futureAav * yearsToAdd;
        var yearTokensB = [];
        for (var i = 1; i <= yearsToAdd; i += 1) {
          yearTokensB.push("Y" + i + "-" + formatContractK(futureAav));
        }
        var parts = originalInfo.split("|");
        var yearJoined = yearTokensB.join(", ");
        var gtdB = fixedTcvB > 4000 ? Math.round(fixedTcvB * 0.75) : 0;
        var rebuiltParts = parts.map(function (p) {
          var seg = p.replace(/^\s+|\s+$/g, "");
          if (/^CL\s+/i.test(seg)) return "CL " + yearsToAdd;
          if (/^TCV\s+/i.test(seg)) return "TCV " + formatContractK(fixedTcvB);
          if (/^AAV\s+/i.test(seg)) return "AAV " + formatContractK(futureAav);
          if (/^Y\d+-/i.test(seg)) return yearJoined;
          if (/^GTD:/i.test(seg)) return "GTD: " + formatContractK(gtdB);
          return seg;
        });
        var rebuiltB = cleanExtSegment(rebuiltParts.join("|"));
        return Object.assign({}, opt, {
          contractLength: yearsToAdd,
          tcv: fixedTcvB,
          currentAav: futureAav,
          contractInfo: rebuiltB,
          salaryToSend: futureAav
        });
      }

      return Object.assign({}, opt, { contractInfo: cleanExtSegment(originalInfo) });
    });
  }

  // ── END verbatim mirror ──────────────────────────────────────────────

  // ── HTTP submit helpers (same pattern as Tag) ──────────────────────────
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

  // Build the extension submit payload — exactly matches the desktop
  // submitExtensionUpdate body (10853-10881). contract_year is the
  // FULL extension length (per fix #184), not -1.
  function buildExtensionPayload(args) {
    var leagueId = safeStr(args.leagueId);
    var year = safeStr(args.year);
    var option = args.option || {};
    var rosterRow = args.rosterRow || {};
    return {
      L: leagueId, YEAR: year,
      type: "MANUAL_CONTRACT_UPDATE",
      submission_kind: "extension",
      dry_run: args.dryRun ? 1 : 0,
      source: "ups-mobile-extension-submit",
      leagueId: leagueId, year: year,
      player_id: safeStr(args.pid),
      player_name: safeStr(args.playerName),
      franchise_id: pad4(args.fid),
      franchise_name: safeStr(args.franchiseName),
      position: safeStr(args.position),
      salary: safeInt(option.salaryToSend, 0),
      contract_year: Math.max(0, safeInt(option.contractLength, 0)),
      contract_status: safeStr(option.contractStatus),
      contract_info: safeStr(option.contractInfo),
      prior_contract_status: safeStr(rosterRow.contractStatus),
      prior_salary: safeInt(rosterRow.salary, 0),
      prior_contract_year: safeInt(rosterRow.contractYear, 0),
      prior_contract_info: safeStr(rosterRow.contractInfo),
      submitted_at_utc: new Date().toISOString(),
      commish_override_flag: args.commishOverride ? 1 : 0
    };
  }

  function submitExtension(args) {
    var workerBase = String(args.workerBase || "").replace(/\/+$/, "");
    var url = workerBase + "/commish-contract-update?L=" +
      encodeURIComponent(args.leagueId) + "&YEAR=" + encodeURIComponent(args.year);
    var payload = buildExtensionPayload(args);
    return postContractUpdate(url, payload).then(function (resp) {
      if (resp.ok) return { ok: true, status: resp.status, body: resp.body, payload: payload };
      return { ok: false, status: resp.status, body: resp.body,
               error: (resp.body && resp.body.error) || ("HTTP " + resp.status) };
    });
  }

  // Load + filter extension previews for a single player. Returns the
  // final reshaped options array (after case-A/case-B transform) — ready
  // to render in the picker.
  function loadOptionsForPlayer(args) {
    var year = safeStr(args.year);
    var pid = safeStr(args.pid);
    var fid = pad4(args.fid);
    var rosterRow = args.rosterRow || null;
    var url = "https://keithcreelman.github.io/upsmflproduction/trades/extension_previews_" + encodeURIComponent(year) + ".json";
    return fetch(url, { mode: "cors", credentials: "omit", cache: "no-store" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        if (!data) return [];
        var rows = Array.isArray(data) ? data : (Array.isArray(data.rows) ? data.rows : []);
        var filtered = rows.filter(function (row) {
          if (!row) return false;
          if (safeStr(row.player_id) !== pid) return false;
          if (fid && pad4(row.franchise_id) !== fid) return false;
          return true;
        });
        var normalized = normalizeExtensionPreviewRows(filtered);
        return applyExtensionOptionReshape(normalized, rosterRow);
      })
      .catch(function () { return []; });
  }

  window.UPS_FRONT_OFFICE_EXT = {
    normalizeExtensionPreviewRow: normalizeExtensionPreviewRow,
    normalizeExtensionPreviewRows: normalizeExtensionPreviewRows,
    applyExtensionOptionReshape: applyExtensionOptionReshape,
    extensionActionLabel: extensionActionLabel,
    extensionOptionSummary: extensionOptionSummary,
    loadOptionsForPlayer: loadOptionsForPlayer,
    buildExtensionPayload: buildExtensionPayload,
    submitExtension: submitExtension
  };
})();
