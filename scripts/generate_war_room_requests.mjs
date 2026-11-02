#!/usr/bin/env node
// Regenerates site/shared/war_room_requests.js: the Trade War Room's OWN request-building code (payload, offer reload,
// note composition, Retry fingerprint, three-team movements, outcome wording), copied verbatim out of
// site/trades/trade_workbench.js, so the Front Office offer lifecycle builds byte-identical requests by construction
// (Keith's ruling 4, 2026-10-28: full War Room lifecycle parity before release; #1338).
//
//   node scripts/generate_war_room_requests.mjs           rewrite site/shared/war_room_requests.js
//   node scripts/generate_war_room_requests.mjs --check   exit 1 if it is out of date (writes nothing)
//
// What is copied: every top-level function of the War Room's IIFE reachable from ROOTS below (transitively, by name),
// plus every top-level `var` statement those functions read, in source order and byte for byte. They run inside a
// factory with their own `state`, `els`, `tw3`, `window` and `document`, so nothing touches the real page.
// tests/war_room_requests_generated.test.mjs fails when the War Room changes and this file was not regenerated, and
// tests/fo_trade_lifecycle_parity.test.mjs boots the REAL War Room to prove the bodies match.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "site/trades/trade_workbench.js");
const OUT = path.join(ROOT, "site/shared/war_room_requests.js");

// The War Room functions the Front Office calls. Everything they reach comes along.
export const ROOTS = [
  "normalizeData", "applyAcquisitionLookupToTradeData", "buildTradePayload", "getTeamById", "getActiveFranchiseId",
  "isCommissionerLockoutOff", "getLockedLeftTeamId", "ensureSelectionMaps", "getTradeSalaryMaxK",
  "buildExtensionSummaryLines", "composeTradeMessage", "tw2sMovementsFromPayload",
  "retryOfferFingerprintFromBody", "retryOfferVerdict",
  "getOfferPayloadForWorkbench", "parseTradeMetaFromComment", "getOfferTradeId", "normalizeOffersForBanner",
  "flattenOfferCollections", "findOfferByLoadKey", "isOfferLivePending", "normalizeOfferStatus",
  "summarizePostAcceptResult", "friendlyOfferError", "summarizeOfferFeedError", "offerFeedErrorIsSignedOut",
  "tw3Movements", "tw3BuildExtensionRequests", "tw3NameOf", "tw3MovementMaxCapK",
  "getLeagueContext", "buildValidationSummary", "safeStr", "safeInt", "pad4",
];
// Declared by the factory itself (the page's own copies are never copied: they hold DOM handles or page state).
const PROVIDED = new Set(["els", "tw3", "tw2s", "T3", "state"]);
const STATE_VAR = "state";

// Strings, template literals, comments and regex literals blanked to spaces, so brace counting and identifier
// scanning only see code. Good enough for this file's formatting (checked by the test: the output must parse).
function codeOnly(line) {
  let out = "", i = 0, q = "";
  while (i < line.length) {
    const c = line[i];
    if (q) { if (c === "\\") { out += "  "; i += 2; continue; } if (c === q) q = ""; out += " "; i++; continue; }
    if (c === "/" && line[i + 1] === "/") { out += " ".repeat(line.length - i); break; }
    if (c === '"' || c === "'" || c === "`") { q = c; out += " "; i++; continue; }
    if (c === "/" && /[(,=:!&|?{};\[]\s*$/.test(out)) {   // a regex literal
      let j = i + 1, cls = false;
      while (j < line.length) { const d = line[j]; if (d === "\\") { j += 2; continue; } if (d === "[") cls = true; else if (d === "]") cls = false; else if (d === "/" && !cls) break; j++; }
      out += " ".repeat(j - i + 1); i = j + 1; continue;
    }
    out += c; i++;
  }
  return out;
}
const depth = (s) => [...s].reduce((d, c) => d + ("{[(".includes(c) ? 1 : ")]}".includes(c) ? -1 : 0), 0);

export function scan(src) {
  const lines = src.split("\n");
  const fns = new Map(), vars = new Map();
  for (let i = 0; i < lines.length; i++) {
    const f = /^ {2}(?:async )?function ([A-Za-z0-9_$]+)\s*\(/.exec(lines[i]);
    if (f) {
      let j = i, d = depth(codeOnly(lines[i]));
      if (d !== 0) { j = i + 1; while (j < lines.length && lines[j] !== "  }") j++; }
      fns.set(f[1], { start: i, end: j, text: lines.slice(i, j + 1).join("\n") });
      i = j; continue;
    }
    const v = /^ {2}var ([A-Za-z0-9_$]+)/.exec(lines[i]);
    if (v) {
      let j = i, d = depth(codeOnly(lines[i]));
      while (d > 0 && j + 1 < lines.length) { j++; d += depth(codeOnly(lines[j])); }
      const text = lines.slice(i, j + 1).join("\n");
      const names = [v[1]].concat([...text.split("\n").map(codeOnly).join("\n").matchAll(/,\s*([A-Za-z_$][\w$]*)\s*=/g)].map((m) => m[1]));
      names.forEach((n) => vars.set(n, { start: i, end: j, text }));
      i = j;
    }
  }
  return { fns, vars };
}

export function closure(src, roots = ROOTS) {
  const { fns, vars } = scan(src);
  const want = new Set(), wantVars = new Set(), stack = [...roots];
  const missing = roots.filter((r) => !fns.has(r));
  if (missing.length) throw new Error("War Room functions not found: " + missing.join(", "));
  const visit = (text) => {
    for (const id of new Set(text.split("\n").map(codeOnly).join("\n").match(/(?<![.\w$])[A-Za-z_$][\w$]*/g) || [])) {
      if (fns.has(id) && !want.has(id)) stack.push(id);
      if (vars.has(id) && !PROVIDED.has(id) && !wantVars.has(id)) { wantVars.add(id); visit(vars.get(id).text); }
    }
  };
  visit(vars.get(STATE_VAR).text);
  while (stack.length) { const n = stack.pop(); if (want.has(n)) continue; want.add(n); visit(fns.get(n).text); }
  const blocks = new Map();
  for (const n of want) blocks.set(fns.get(n).start, fns.get(n).text);
  for (const n of wantVars) blocks.set(vars.get(n).start, vars.get(n).text);
  const stateText = vars.get(STATE_VAR).text;
  return { functions: [...want].sort(), vars: [...wantVars].sort(), body: [...blocks.keys()].sort((a, b) => a - b).map((k) => blocks.get(k)).join("\n\n"), stateText };
}

export function render(src) {
  const c = closure(src);
  const sha = crypto.createHash("sha256").update(c.stateText + "\n" + c.body).digest("hex").slice(0, 16);
  const api = ROOTS.map((n) => `${n}: ${n}`).join(", ");
  return `/* GENERATED by \`node scripts/generate_war_room_requests.mjs\` from site/trades/trade_workbench.js. DO NOT EDIT:
   change the War Room, then regenerate (tests/war_room_requests_generated.test.mjs fails until you do).

   The Trade War Room's own request-building code (${c.functions.length} functions, copied byte for byte), run inside a factory
   with its own state, so the Front Office offer lifecycle (site/shared/trade_offer_lifecycle.js) sends the War Room's
   exact requests: the same payload, the same note text, the same Retry fingerprint. Nothing here sends anything:
   there is no fetch in this file's API (the War Room's own fetch helpers are not reachable from it).

   create({ href, rules, leagueContext }) -> { state, setTw3(v), ...functions }: href = the page address the War Room
   would read L / YEAR from, rules = UPS_TRADE_RULES, leagueContext() = optional { leagueId, season, host }. Source digest ${sha}. */
(function (root) {
  "use strict";
  function create(env) {
    env = env || {};
    // A private stand-in for the page: never the real window or document, so no copied line can touch the page
    // (the War Room's height messages to its MFL parent, script loading and error panels all land on these stubs).
    var window = { location: { href: String(env.href || "https://localhost/") }, UPS_TRADE_RULES: env.rules || null,
      getLeagueContext: typeof env.leagueContext === "function" ? env.leagueContext : undefined,
      setTimeout: function () { return 0; }, parent: null };
    window.parent = window;
    var document = { currentScript: null, querySelector: function () { return null; }, getElementById: function () { return null; },
      createElement: function () { return { setAttribute: function () {} }; }, head: null, documentElement: null, body: null };
    var els = {};
    var tw3 = null;
    var tw2s = null;
    var T3 = null;
${c.stateText}

${c.body}

    return { state: state, setTw3: function (v) { tw3 = v; }, ${api} };
  }
  var api = { create: create, SOURCE_DIGEST: "${sha}", FUNCTIONS: ${JSON.stringify(c.functions)} };
  root.UPS_WAR_ROOM_REQUESTS = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : this);
`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const next = render(fs.readFileSync(SRC, "utf8"));
  const cur = fs.existsSync(OUT) ? fs.readFileSync(OUT, "utf8") : "";
  if (process.argv.includes("--check")) {
    if (cur !== next) { console.error("site/shared/war_room_requests.js is out of date: run node scripts/generate_war_room_requests.mjs"); process.exit(1); }
    console.log("site/shared/war_room_requests.js is up to date");
  } else if (cur !== next) { fs.writeFileSync(OUT, next); console.log("wrote site/shared/war_room_requests.js"); }
  else console.log("site/shared/war_room_requests.js already up to date");
}
