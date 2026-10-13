// The MFL session Cookie header, built from a stored secret (MFL_COOKIE /
// MFLTEST_COMMISHCOOKIE). Keith 2026-10-13.
//
// The secret may hold either the bare MFL_USER_ID value (what a browser's cookie
// list shows) or the full "MFL_USER_ID=<value>" fragment. MFL_USER_ID values are
// base64-like and can themselves contain "=", so "contains =" does NOT mean the
// secret is already a header — the old test sent such a bare value with no cookie
// name at all, and MFL treated the worker as signed out. Only a leading cookie
// name marks a fragment. The value is sent exactly as stored, never re-encoded:
// that is what a signed-in browser sends.

const _s = (v) => String(v == null ? "" : v);

export function mflCookieHeader(raw) {
  const s = _s(raw).trim().replace(/^cookie\s*:\s*/i, "");
  if (!s) return "";
  if (/^MFL_USER_ID\s*=/i.test(s) || /;\s*MFL_USER_ID\s*=/i.test(s)) return s;
  return `MFL_USER_ID=${s}`;
}

// The secret's SHAPE, for diagnosis — never its value. `sha256_12` is the first
// 12 hex digits of SHA-256 over the MFL_USER_ID value as sent (not reversible).
export async function mflCookieShape(raw) {
  const s = _s(raw).trim();
  if (!s) return { present: false };
  const header = mflCookieHeader(s);
  const m = /(?:^|;\s*)MFL_USER_ID\s*=\s*([^;]*)/i.exec(header);
  const value = m ? m[1] : "";
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return {
    present: true,
    stored_as: /^(?:cookie\s*:\s*)?MFL_USER_ID\s*=/i.test(s) ? "fragment" : (/;\s*MFL_USER_ID\s*=/i.test(s) ? "multi_cookie_fragment" : "bare_value"),
    stored_length: s.length,
    value_length: value.length,
    value_contains_equals: value.includes("="),
    value_has_percent_escape: /%[0-9A-Fa-f]{2}/.test(value),
    value_has_whitespace_or_quote: /[\s"']/.test(value),
    old_rule_would_send_cookie_name: !s.includes("=") || /^MFL_USER_ID\s*=/i.test(s) || /;\s*MFL_USER_ID\s*=/i.test(s),
    sha256_12: [...digest].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 12),
  };
}

// ── commissioner identity ────────────────────────────────────────────────────
// An MFL session is ACCOUNT-wide and starts in OWNER mode: Keith's account is
// "Real Deal Creel ( Logout | Become Commissioner )". Commissioner setup pages
// (csetup, options O=93) serve the league skin / "Commissioner Access Required."
// to an owner-mode session. MFL elevates with GET logout?L=<league>&BECOME=0000,
// which answers with Set-Cookie for the commissioner session (seen in the read-only
// waiver-settings workflow, 2026-08-21 vs 08-22, and the worker's
// establishCommishCookieHeader). The stored secret is never rewritten: the elevated
// header lives only for the call that asked for it.

// ── a browser-faithful cookie jar (RFC 6265) for the switch ──────────────────
// Keith 2026-10-13: MFL's switch reply set MFL_USER_ID to an EMPTY value; merging by
// name alone wiped the session. A browser keys a cookie by name + domain + host-only
// flag + path, applies an empty or expired Set-Cookie only to that exact scope, and
// sends every matching copy (longer path first, then oldest first). Chrome holds the
// session as MFL_USER_ID; Domain=.myfantasyleague.com; Path=/ — the stored secret is
// seeded in that scope.

export const SESSION_SCOPE = Object.freeze({ domain: "myfantasyleague.com", hostOnly: false, path: "/" });

function parseSetCookie(line) {
  const parts = _s(line).split(";");
  const first = parts.shift() || "";
  const i = first.indexOf("=");
  if (i <= 0 || !first.slice(0, i).trim()) return null;
  const attrs = {};
  for (const p of parts) {
    const j = p.indexOf("=");
    const k = (j < 0 ? p : p.slice(0, j)).trim().toLowerCase();
    if (k) attrs[k] = j < 0 ? "" : p.slice(j + 1).trim();   // last one wins, as in RFC 6265 §5.3
  }
  return { name: first.slice(0, i).trim(), value: first.slice(i + 1).trim(), attrs };
}
function setCookieLines(headers) {
  if (headers && typeof headers.getSetCookie === "function") return headers.getSetCookie();
  const joined = headers && typeof headers.get === "function" ? _s(headers.get("set-cookie")) : "";
  return joined ? joined.split(/,(?=[^;,]+=)/g) : [];
}
const defaultPath = (p) => (!_s(p).startsWith("/") || _s(p).lastIndexOf("/") === 0 ? "/" : _s(p).slice(0, _s(p).lastIndexOf("/")));
const pathMatch = (req, cp) => req === cp || (req.startsWith(cp) && (cp.endsWith("/") || req.charAt(cp.length) === "/"));
const domainMatch = (host, c) => (c.hostOnly ? host === c.domain : host === c.domain || host.endsWith(`.${c.domain}`));

export function createCookieJar({ now = () => Date.now() } = {}) {
  const store = [];
  let seq = 0;
  const same = (c, n, scope) => c.name === n && c.domain === scope.domain && c.hostOnly === !!scope.hostOnly && c.path === scope.path;
  return {
    seed(name, value, scope = SESSION_SCOPE) {
      store.push({ name, value: _s(value), domain: _s(scope.domain).replace(/^\./, "").toLowerCase(), hostOnly: !!scope.hostOnly, path: scope.path || "/", expiresAt: null, created: seq++ });
    },
    // Apply one Set-Cookie line received from `requestUrl`. Returns what happened, with
    // the scope and attributes — never the value.
    apply(line, requestUrl) {
      const sc = parseSetCookie(line);
      if (!sc) return { action: "ignored_malformed" };
      const host = new URL(requestUrl).hostname.toLowerCase();
      const hasDomain = typeof sc.attrs.domain === "string" && sc.attrs.domain.replace(/^\./, "") !== "";
      const domain = hasDomain ? sc.attrs.domain.replace(/^\./, "").toLowerCase() : host;
      const report = { name: sc.name, domain_attr: hasDomain ? sc.attrs.domain : null, host_only: !hasDomain, scope_domain: domain,
        path_attr: sc.attrs.path ?? null, expires_attr: sc.attrs.expires ?? null, max_age_attr: sc.attrs["max-age"] ?? null, value_length: sc.value.length };
      if (hasDomain && !(host === domain || host.endsWith(`.${domain}`))) return { ...report, action: "rejected_domain_mismatch" };
      const path = typeof sc.attrs.path === "string" && sc.attrs.path.startsWith("/") ? sc.attrs.path : defaultPath(new URL(requestUrl).pathname);
      let expiresAt = null;
      if (typeof sc.attrs["max-age"] === "string" && /^-?\d+$/.test(sc.attrs["max-age"])) {
        const n = Number(sc.attrs["max-age"]);
        expiresAt = n <= 0 ? -Infinity : now() + n * 1000;
      } else if (typeof sc.attrs.expires === "string") {
        const t = Date.parse(sc.attrs.expires);
        if (!Number.isNaN(t)) expiresAt = t;
      }
      const scope = { domain, hostOnly: !hasDomain, path };
      const idx = store.findIndex((c) => same(c, sc.name, scope));
      report.scope_path = path;
      if (expiresAt !== null && expiresAt <= now()) {
        if (idx >= 0) { store.splice(idx, 1); return { ...report, action: "deleted" }; }
        return { ...report, action: "expired_no_matching_cookie" };
      }
      const cookie = { name: sc.name, value: sc.value, domain, hostOnly: !hasDomain, path, expiresAt };
      if (idx >= 0) { store[idx] = { ...cookie, created: store[idx].created }; return { ...report, action: "replaced" }; }
      store.push({ ...cookie, created: seq++ });
      return { ...report, action: "added" };
    },
    // The Cookie header a browser would send to `url`.
    header(url) {
      const u = new URL(url);
      const host = u.hostname.toLowerCase();
      return store
        .filter((c) => (c.expiresAt === null || c.expiresAt > now()) && domainMatch(host, c) && pathMatch(u.pathname || "/", c.path))
        .sort((a, b) => b.path.length - a.path.length || a.created - b.created)
        .map((c) => `${c.name}=${c.value}`).join("; ");
    },
    find(name, scope) { const c = store.find((x) => same(x, name, scope)); return c ? { value: c.value } : null; },
  };
}

const sha12 = async (v) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(_s(v))))]
  .map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 12);

// → { ok, cookieFor(url), set_cookies:[sanitized], set_cookie_names, user_id_changed,
//     session_cookie, identity_after_switch, hops }. `cookieFor` carries session values:
// use it for the request, never return or log what it gives.
// Fails closed (switch_deleted_session) if the switch deletes or empties the very
// cookie that signed in the stored session.
export async function becomeCommissioner(baseHeader, { season, leagueId, fetchImpl, sessionScope = SESSION_SCOPE, now } = {}) {
  const f = fetchImpl || fetch;
  const base = _s(baseHeader);
  if (!base) return { ok: false, error: "no_commissioner_cookie" };
  const jar = createCookieJar(now ? { now } : {});
  let stored = null;
  for (const part of base.split(";")) {
    const i = part.indexOf("=");
    if (i <= 0 || !part.slice(0, i).trim()) continue;
    const name = part.slice(0, i).trim(), value = part.slice(i + 1).trim();
    jar.seed(name, value, sessionScope);
    if (name === "MFL_USER_ID") stored = value;
  }
  if (!stored) return { ok: false, error: "no_session_cookie" };
  const events = [];
  let identityAfter = null;
  let url = `https://www48.myfantasyleague.com/${encodeURIComponent(_s(season))}/logout?L=${encodeURIComponent(_s(leagueId))}&BECOME=0000`;
  let hops = 0;
  try {
    for (; hops < 2 && url; hops += 1) {
      const r = await f(url, { headers: { Cookie: jar.header(url), "User-Agent": "upsmflproduction-worker" }, redirect: "manual" });
      for (const line of setCookieLines(r && r.headers)) {
        const ev = jar.apply(line, url);
        const sc = parseSetCookie(line);
        events.push({ hop: hops + 1, ...ev, sha256_12: sc ? await sha12(sc.value) : null });
      }
      if (r && r.status === 200 && typeof r.text === "function") identityAfter = sessionIdentity(await r.text());
      const loc = r && r.status >= 300 && r.status < 400 && r.headers && typeof r.headers.get === "function" ? _s(r.headers.get("location")) : "";
      const next = loc ? new URL(loc, url) : null;
      url = next && /(^|\.)myfantasyleague\.com$/i.test(next.hostname) ? next.toString() : "";
    }
  } catch (e) { return { ok: false, error: `become_failed: ${e && e.message}`, set_cookies: events }; }
  const scope = { domain: sessionScope.domain, host_only: !!sessionScope.hostOnly, path: sessionScope.path };
  const kept = jar.find("MFL_USER_ID", sessionScope);
  const sanitized = { set_cookie_names: [...new Set(events.map((e) => e.name).filter(Boolean))], set_cookies: events, identity_after_switch: identityAfter, hops };
  if (!kept || kept.value === "") {
    return { ok: false, error: "switch_deleted_session", session_cookie: { ...scope, survived: false }, ...sanitized };
  }
  return { ok: true, cookieFor: (u) => jar.header(u), user_id_changed: kept.value !== stored, session_cookie: { ...scope, survived: true }, ...sanitized };
}

// Who MFL says this page was served to, from its header line — no values.
export function sessionIdentity(html) {
  const t = _s(html).replace(/<script\b[\s\S]*?<\/script\s*>/gi, "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");
  if (/Become\s+Owner/i.test(t)) return "commissioner";
  if (/Become\s+Commissioner/i.test(t)) return "owner";
  if (/\bLog\s*out\b/i.test(t)) return "signed_in_unknown_role";
  if (/\bLog\s*in\b/i.test(t)) return "signed_out";
  return "unknown";
}
