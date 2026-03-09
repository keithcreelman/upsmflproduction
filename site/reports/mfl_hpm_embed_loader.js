(function () {
  "use strict";

  function safeStr(value) {
    return String(value == null ? "" : value).trim();
  }

  function getDesiredReleaseRef() {
    return safeStr(window.UPS_REPORTS_RELEASE_SHA || window.UPS_RELEASE_SHA || "") || "";
  }

  function getScriptBaseUrl() {
    try {
      var script = document.currentScript;
      if (!script || !script.src) return "";
      var url = new URL(script.src, window.location.href);
      var parts = String(url.pathname || "").split("/");
      parts.pop();
      url.pathname = parts.join("/") + "/";
      url.search = "";
      url.hash = "";
      return url.toString();
    } catch (e) {}
    return "";
  }

  function getRefFromScriptSrc() {
    try {
      var script = document.currentScript;
      if (!script || !script.src) return "";
      var url = new URL(script.src, window.location.href);
      if (!/cdn\.jsdelivr\.net$/i.test(String(url.hostname || ""))) return "";
      var parts = String(url.pathname || "").split("/").filter(Boolean);
      if (parts.length < 4 || parts[0] !== "gh") return "";
      var repoRef = parts[2];
      var at = repoRef.lastIndexOf("@");
      if (at <= 0 || at >= repoRef.length - 1) return "";
      return safeStr(repoRef.slice(at + 1));
    } catch (e) {}
    return "";
  }

  function buildRawReportsUrlFromRef(ref) {
    var release = encodeURIComponent(safeStr(ref) || "main");
    return (
      "https://rawcdn.githack.com/keithcreelman/upsmflproduction/" +
      release +
      "/site/reports/index.html"
    );
  }

  function jsDelivrScriptToRawGithackHtml(scriptSrc) {
    try {
      var url = new URL(scriptSrc, window.location.href);
      if (!/cdn\.jsdelivr\.net$/i.test(String(url.hostname || ""))) return "";
      var parts = String(url.pathname || "").split("/").filter(Boolean);
      if (parts.length < 5 || parts[0] !== "gh") return "";
      var owner = parts[1];
      var repoRef = parts[2];
      var at = repoRef.lastIndexOf("@");
      if (at <= 0 || at >= repoRef.length - 1) return "";
      var repo = repoRef.slice(0, at);
      var ref = repoRef.slice(at + 1);
      return (
        "https://rawcdn.githack.com/" +
        encodeURIComponent(owner) +
        "/" +
        encodeURIComponent(repo) +
        "/" +
        encodeURIComponent(ref) +
        "/site/reports/index.html"
      );
    } catch (e) {}
    return "";
  }

  function resolveIframeUrl() {
    var releaseRef = getDesiredReleaseRef() || getRefFromScriptSrc() || "main";
    if (getDesiredReleaseRef()) return buildRawReportsUrlFromRef(releaseRef);

    var explicit = safeStr(window.UPS_REPORTS_IFRAME_URL || "");
    if (explicit) return explicit;

    try {
      var script = document.currentScript;
      if (script && script.src) {
        var fromJsDelivr = jsDelivrScriptToRawGithackHtml(script.src);
        if (fromJsDelivr) return fromJsDelivr;
      }
    } catch (e) {}

    var base = getScriptBaseUrl();
    if (base) return base + "index.html";
    return buildRawReportsUrlFromRef(releaseRef);
  }

  function ensureMount() {
    var script = document.currentScript;
    var targetId = script ? safeStr(script.getAttribute("data-reports-target-id")) : "";
    var mountId = targetId || "upsReportsMount";
    var mount = document.getElementById(mountId);
    if (mount) return mount;

    mount = document.createElement("div");
    mount.id = mountId;
    if (script && script.parentNode) {
      script.parentNode.insertBefore(mount, script);
    } else {
      (document.body || document.documentElement).appendChild(mount);
    }
    return mount;
  }

  var mount = ensureMount();
  if (!mount) return;

  var iframeUrl = resolveIframeUrl() + (window.location.hash || "");
  var iframe = document.createElement("iframe");
  iframe.className = "ups-reports-frame";
  iframe.title = "UPS Reports";
  iframe.style.width = "100%";
  iframe.style.minHeight = "1600px";
  iframe.style.border = "0";
  iframe.style.background = "transparent";
  iframe.setAttribute("loading", "lazy");
  iframe.setAttribute("referrerpolicy", "no-referrer");
  iframe.src = iframeUrl;

  mount.innerHTML = "";
  mount.appendChild(iframe);
})();
