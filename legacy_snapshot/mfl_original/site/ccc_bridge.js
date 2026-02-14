(function () {
  "use strict";

  var MAX_ATTEMPTS = 80;
  var STEP_MS = 250;

  function safeStr(v) {
    return v === null || v === undefined ? "" : String(v).trim();
  }

  function pad4(fid) {
    var digits = safeStr(fid).replace(/\D/g, "");
    return digits ? digits.padStart(4, "0").slice(-4) : "";
  }

  function normalizeAction(action) {
    var a = safeStr(action).toLowerCase();
    if (a === "extend") return "extension";
    if (a === "ext") return "extension";
    if (a === "restructure") return "restructure";
    if (a === "rs") return "restructure";
    return "";
  }

  function parsePayload(raw) {
    raw = raw || {};
    return {
      action: normalizeAction(raw.action || raw.cccAction),
      playerId: safeStr(raw.playerId || raw.pid || raw.player || raw.cccPlayer),
      franchiseId: pad4(raw.franchiseId || raw.fid || raw.franchise || raw.cccFranchise),
      season: safeStr(raw.season || raw.year || raw.cccSeason),
      years: Math.max(1, Math.min(2, parseInt(raw.years || raw.cccYears || "1", 10) || 1))
    };
  }

  function clickIfExists(selector) {
    var node = document.querySelector(selector);
    if (!node) return false;
    node.click();
    return true;
  }

  function chooseModule(action) {
    if (action === "extension") {
      clickIfExists("#moduleExtensionsChip");
      return;
    }
    if (action === "restructure") {
      clickIfExists("#moduleRestructuresChip");
      return;
    }
  }

  function relaxFilters() {
    var team = document.querySelector("#teamSelect");
    if (team && team.value !== "__ALL__") {
      var hasAll = Array.from(team.options || []).some(function (o) {
        return o.value === "__ALL__";
      });
      if (hasAll) {
        team.value = "__ALL__";
        team.dispatchEvent(new Event("change", { bubbles: true }));
      }
    }

    var pos = document.querySelector("#positionSelect");
    if (pos && pos.value !== "__ALL_POS__") {
      var hasAllPos = Array.from(pos.options || []).some(function (o) {
        return o.value === "__ALL_POS__";
      });
      if (hasAllPos) {
        pos.value = "__ALL_POS__";
        pos.dispatchEvent(new Event("change", { bubbles: true }));
      }
    }

    var search = document.querySelector("#searchBox");
    if (search && search.value) {
      search.value = "";
      search.dispatchEvent(new Event("input", { bubbles: true }));
    }
  }

  function findActionButton(payload) {
    if (!payload || !payload.playerId || !payload.action) return null;

    var selector = payload.action === "extension" ? "[data-extension-action='1']" : "[data-restructure='1']";
    var nodes = Array.from(document.querySelectorAll(selector));
    if (!nodes.length) return null;

    var playerId = safeStr(payload.playerId);
    var fid = pad4(payload.franchiseId);

    var exact = nodes.find(function (n) {
      return (
        safeStr(n.getAttribute("data-player-id")) === playerId &&
        (!fid || pad4(n.getAttribute("data-franchise-id")) === fid)
      );
    });
    if (exact) return exact;

    return nodes.find(function (n) {
      return safeStr(n.getAttribute("data-player-id")) === playerId;
    }) || null;
  }

  function postResultToParent(payload, result, source) {
    try {
      if (!window.parent || window.parent === window) return;
      window.parent.postMessage(
        {
          type: "ccc-action-result",
          source: source || "bridge",
          payload: payload,
          result: result || { ok: false }
        },
        "*"
      );
    } catch (err) {}
  }

  function finalizeModalOptions(payload) {
    if (!payload || payload.action !== "extension") return;
    if (payload.years === 2) {
      clickIfExists("#extOption2Btn");
    } else {
      clickIfExists("#extOption1Btn");
    }
  }

  function openAction(payload) {
    payload = parsePayload(payload);
    if (!payload.action || !payload.playerId) {
      return Promise.resolve({ ok: false, reason: "Missing action or player id." });
    }

    chooseModule(payload.action);
    relaxFilters();

    return new Promise(function (resolve) {
      var attempts = 0;

      function tick() {
        attempts += 1;

        if (attempts % 6 === 0) {
          chooseModule(payload.action);
        }

        var btn = findActionButton(payload);
        if (btn) {
          btn.click();
          setTimeout(function () {
            finalizeModalOptions(payload);
            resolve({ ok: true, reason: "Action modal opened." });
          }, 150);
          return;
        }

        if (attempts >= MAX_ATTEMPTS) {
          resolve({ ok: false, reason: "Could not locate action button in Contract Command Center." });
          return;
        }

        setTimeout(tick, STEP_MS);
      }

      setTimeout(tick, 220);
    });
  }

  function payloadFromUrl() {
    var p = new URLSearchParams(window.location.search || "");
    return parsePayload({
      action: p.get("cccAction") || p.get("action"),
      playerId: p.get("cccPlayer") || p.get("playerId") || p.get("pid"),
      franchiseId: p.get("cccFranchise") || p.get("franchiseId") || p.get("fid"),
      season: p.get("cccSeason") || p.get("season"),
      years: p.get("cccYears") || p.get("years")
    });
  }

  function runUrlActionOnce() {
    var payload = payloadFromUrl();
    if (!payload.action || !payload.playerId) return;
    openAction(payload).then(function (result) {
      postResultToParent(payload, result, "query");
    });
  }

  window.addEventListener("message", function (evt) {
    var data = evt && evt.data;
    if (!data || data.type !== "ccc-open-action") return;

    var payload = parsePayload(data.payload || data);
    if (!payload.action || !payload.playerId) {
      postResultToParent(payload, { ok: false, reason: "Invalid message payload." }, "message");
      return;
    }

    openAction(payload).then(function (result) {
      postResultToParent(payload, result, "message");
    });
  });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", runUrlActionOnce);
  } else {
    runUrlActionOnce();
  }
})();
