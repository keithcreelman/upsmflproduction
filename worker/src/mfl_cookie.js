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
