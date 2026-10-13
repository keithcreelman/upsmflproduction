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

function setCookiePairs(headers) {
  const raw = headers && typeof headers.getSetCookie === "function" ? headers.getSetCookie()
    : [headers && typeof headers.get === "function" ? headers.get("set-cookie") : ""].filter(Boolean);
  const out = [];
  for (const line of raw) {
    for (const piece of _s(line).split(/,(?=[^;,]+=)/g)) {
      const first = _s(piece).split(";")[0];
      const i = first.indexOf("=");
      if (i > 0 && first.slice(0, i).trim()) out.push([first.slice(0, i).trim(), first.slice(i + 1).trim()]);
    }
  }
  return out;
}
function mergeCookies(header, pairs) {
  const m = new Map();
  for (const part of _s(header).split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim()) m.set(part.slice(0, i).trim(), part.slice(i + 1).trim());
  }
  for (const [k, v] of pairs) m.set(k, v);
  return [...m.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}

// → { ok, header, set_cookie_names, hops } — names only are safe to report; `header`
// carries session values and must never be returned to a caller or logged.
export async function becomeCommissioner(baseHeader, { season, leagueId, fetchImpl }) {
  const f = fetchImpl || fetch;
  let header = _s(baseHeader);
  if (!header) return { ok: false, error: "no_commissioner_cookie" };
  const names = [];
  let url = `https://www48.myfantasyleague.com/${encodeURIComponent(_s(season))}/logout?L=${encodeURIComponent(_s(leagueId))}&BECOME=0000`;
  let hops = 0;
  try {
    for (; hops < 2 && url; hops += 1) {
      const r = await f(url, { headers: { Cookie: header, "User-Agent": "upsmflproduction-worker" }, redirect: "manual" });
      const pairs = setCookiePairs(r && r.headers);
      for (const [k] of pairs) if (!names.includes(k)) names.push(k);
      header = mergeCookies(header, pairs);
      const loc = r && r.status >= 300 && r.status < 400 && r.headers && typeof r.headers.get === "function" ? _s(r.headers.get("location")) : "";
      const next = loc ? new URL(loc, url) : null;
      url = next && /(^|\.)myfantasyleague\.com$/i.test(next.hostname) ? next.toString() : "";
    }
  } catch (e) { return { ok: false, error: `become_failed: ${e && e.message}` }; }
  return { ok: true, header, set_cookie_names: names, hops };
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
