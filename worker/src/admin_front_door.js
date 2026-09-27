// admin_front_door.js — exact-match classification of /admin/* requests, done BEFORE any routing.
//
// The rule: a path is a real admin route only if it is, byte for byte, in the generated inventory (worker/src/admin_routes.js) with an
// allowed method. Anything else that LOOKS like it is in the admin namespace — an unknown route, a nested unknown path, a wrong method, a
// different case, a doubled or trailing slash, dot segments, or a URL-encoded separator — is "unknown": the caller gets one uniform 404
// that says nothing about which routes exist. No normalization ever ROUTES a variant to a handler; normalization is used only to decide
// that a variant is "adminish" and must therefore be refused rather than fall through to something generic.
import { ADMIN_ROUTES, ADMIN_DYNAMIC_ROUTES, PUBLIC_ADMIN_NAMESPACE_READS } from "./admin_routes.js";

function decodeAll(p) {
  let cur = String(p == null ? "" : p);
  for (let i = 0; i < 4; i++) {
    let next;
    try { next = decodeURIComponent(cur); } catch (_) { return cur; }   // malformed escapes: judge the string as given
    if (next === cur) break;
    cur = next;
  }
  return cur;
}

/** The path as a hostile client might have meant it: decoded, backslashes and repeated slashes collapsed, dot segments resolved. */
export function looseAdminForm(rawPath) {
  const decoded = decodeAll(rawPath).replace(/\\/g, "/");
  const out = [];
  for (const seg of decoded.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") { out.pop(); continue; }
    out.push(seg);
  }
  return "/" + out.join("/");
}

/**
 * @returns "not_admin" — nothing to do with the admin namespace
 *          "public"    — an exact public read-only list that lives under /admin (owners read it without credentials)
 *          "admin"     — an exact, real admin route with an allowed method (the route enforces its own authority)
 *          "unknown"   — adminish but not an exact route+method: refuse with a uniform 404
 */
export function classifyAdminRequest(rawPath, method) {
  const m = String(method || "GET").toUpperCase();
  const p = String(rawPath == null ? "" : rawPath);
  const exact = Object.prototype.hasOwnProperty.call(ADMIN_ROUTES, p) ? ADMIN_ROUTES[p] : null;
  if (exact) {
    if (!(exact.includes("*") || exact.includes(m))) return "unknown";
    return PUBLIC_ADMIN_NAMESPACE_READS.has(`${m} ${p}`) ? "public" : "admin";
  }
  for (const d of ADMIN_DYNAMIC_ROUTES) if (d.re.test(p)) return d.methods.includes(m) ? "admin" : "unknown";
  return /^\/admin(\/|$)/i.test(looseAdminForm(p)) ? "unknown" : "not_admin";
}
