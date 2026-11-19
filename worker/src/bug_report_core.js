// bug_report_core.js -- pure rules for owner bug reports (no I/O, no Date.now, no fetch).
//
// A signed-in owner reports a failed page to the commissioner. This module owns
// the three rules that keep a private report private and cheap:
//
//   1. validateSubmission  -- an ALLOWLIST of fields; unknown fields are refused,
//                             every text field is length-capped and redacted.
//   2. fingerprint / rate  -- duplicate and rate-limit decisions are pure functions
//                             of rows the caller already read.
//   3. MESSAGES            -- the owner-facing wording for every refusal, so a
//                             failed sign-in or a limit is explained, not just coded.
//
// Nothing here knows about D1, MFL or Discord. See docs/BUG_REPORTS.md.

function str(v) { return String(v == null ? "" : v); }

export const LIMITS = Object.freeze({
  BODY_BYTES: 8192,
  SUMMARY_MIN: 3,
  SUMMARY_MAX: 120,
  NOTE_MAX: 1000,
  SCREEN_MAX: 80,
  BUILD_MAX: 40,
  ERR_NAME_MAX: 60,
  ERR_MESSAGE_MAX: 500,
  ENDPOINT_MAX: 160,
  REQUEST_ID_MIN: 8,
  REQUEST_ID_MAX: 64,
  // rate limiting (per franchise)
  DAILY_MAX: 5,            // new reports per rolling 24 hours
  MIN_GAP_SECONDS: 20,     // between two new reports
  WINDOW_HOURS: 24,
  // duplicates: the same problem from the same team inside the window is added to
  // the existing report instead of becoming a second one, up to this many times
  DUP_MAX: 10,
});

// Body fields an owner may send. `mfl_user_id` is consumed for the identity check
// and is never stored, echoed or logged. Anything else is refused by name.
export const ALLOWED_FIELDS = Object.freeze([
  "client_request_id", "mfl_user_id", "league_id", "season",
  "summary", "note", "screen", "build", "client_time", "viewport", "online", "error",
]);
const ALLOWED_ERROR_FIELDS = ["name", "message", "endpoint", "status"];

// ---------------------------------------------------------------------------
// Redaction (server side, authoritative; the phone sheet does a lighter pass so the
// preview shows what will be kept)
// ---------------------------------------------------------------------------

const SECRET_KEYS = "api[_-]?key|apikey|mfl[_-]?user[_-]?id|mfl[_-]?cookie|set-cookie|cookie|access[_-]?token|refresh[_-]?token|id[_-]?token|token|session(?:[_-]?id)?|passwd|password|secret|authorization|bearer|signature";
const RE_SECRET_PAIR = new RegExp("\\b(" + SECRET_KEYS + ")\\b(\\s*[:=]\\s*)(\"[^\"]*\"|'[^']*'|[^\\s&;,\"']+)", "gi");
const RE_BEARER = /\bBearer\s+[A-Za-z0-9._~+\/=-]{6,}/gi;
const RE_WEBHOOK = /https?:\/\/(?:[a-z0-9-]+\.)?discord(?:app)?\.com\/api\/webhooks\/\S+/gi;
const RE_URL = /\bhttps?:\/\/[^\s"'<>)]+/gi;
const RE_EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const RE_LONG_TOKEN = /[A-Za-z0-9+\/_=-]{32,}/g;
// eslint-disable-next-line no-control-regex
// C0/C1 controls, line/paragraph separators, and bidi overrides (text that could be displayed back-to-front to the commissioner)
const RE_CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u2028\u2029\u202A-\u202E\u2066-\u2069]/g;

/** Remove anything that looks like a secret. Returns { text, count }. */
export function redactText(input) {
  let s = str(input).replace(RE_CONTROL, "");
  let count = 0;
  const bump = (re, to) => { s = s.replace(re, (...m) => { count++; return typeof to === "function" ? to(...m) : to; }); };
  bump(RE_WEBHOOK, "[redacted]");
  // URLs: keep scheme + host + path, drop the query string and fragment (they carry ids and tokens).
  s = s.replace(RE_URL, (u) => {
    const cut = u.search(/[?#]/);
    if (cut === -1) return u;
    count++;
    return u.slice(0, cut);
  });
  bump(RE_BEARER, "Bearer [redacted]");
  bump(RE_SECRET_PAIR, (_m, k, sep) => k + sep + "[redacted]");
  bump(RE_EMAIL, "[email]");
  bump(RE_LONG_TOKEN, "[redacted-token]");
  return { text: s, count };
}

/**
 * Reduce a failed-request address to a bare path: no scheme, host, query or fragment,
 * odd characters dropped, token-looking segments replaced. Returns "" when nothing usable.
 */
export function cleanEndpointPath(input) {
  let s = str(input).trim();
  if (!s) return "";
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, ""); // scheme + host
  const cut = s.search(/[?#]/);
  if (cut !== -1) s = s.slice(0, cut);
  if (!s.startsWith("/")) return "";
  s = s.replace(RE_CONTROL, "").replace(/[^A-Za-z0-9/_\-.:%~]/g, "");
  s = s.split("/").map((seg) => (seg.length >= 24 && /[0-9]/.test(seg) && /[A-Za-z]/.test(seg) ? ":id" : seg)).join("/");
  return s.slice(0, LIMITS.ENDPOINT_MAX);
}

function cap(s, n) { return s.length > n ? s.slice(0, n) : s; }
function collapse(s) { return s.replace(/\s+/g, " ").trim(); }

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const fail = (code, message, extra) => ({ ok: false, code, message, ...(extra || {}) });

/**
 * @returns { ok:true, value, redactions } | { ok:false, code, message, fields? }
 * value never contains mfl_user_id (see `token` on the result for the identity step).
 */
export function validateSubmission(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return fail("bad_request", "That report couldn't be read.");
  }
  const unknown = Object.keys(body).filter((k) => ALLOWED_FIELDS.indexOf(k) === -1);
  if (unknown.length) {
    return fail("unknown_field", "That report included fields the app doesn't send.", { fields: unknown.slice(0, 8) });
  }
  let redactions = 0;
  const clean = (v, max) => { const r = redactText(v); redactions += r.count; return cap(collapse(r.text), max); };

  const requestId = str(body.client_request_id).trim();
  if (!/^[A-Za-z0-9_-]+$/.test(requestId) || requestId.length < LIMITS.REQUEST_ID_MIN || requestId.length > LIMITS.REQUEST_ID_MAX) {
    return fail("bad_request", "That report was missing its request id.", { fields: ["client_request_id"] });
  }

  const summary = clean(body.summary, LIMITS.SUMMARY_MAX);
  if (summary.length < LIMITS.SUMMARY_MIN) {
    return fail("summary_required", "Add a few words about what went wrong.", { fields: ["summary"] });
  }
  // The note keeps line breaks; collapse runs of blank space but not newlines.
  let note = "";
  if (body.note != null && str(body.note).trim()) {
    const r = redactText(str(body.note));
    redactions += r.count;
    note = cap(r.text.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim(), LIMITS.NOTE_MAX);
  }
  const screen = clean(body.screen, LIMITS.SCREEN_MAX);
  if (!screen) return fail("bad_request", "That report didn't say which page it came from.", { fields: ["screen"] });
  const build = clean(body.build, LIMITS.BUILD_MAX);

  let clientTime = "";
  if (body.client_time != null && str(body.client_time).trim()) {
    const t = Date.parse(str(body.client_time));
    if (Number.isFinite(t)) clientTime = new Date(t).toISOString();
  }

  let viewport = "";
  if (body.viewport != null) {
    const v = body.viewport;
    const w = v && Number.isFinite(Number(v.w)) ? Math.round(Number(v.w)) : 0;
    const h = v && Number.isFinite(Number(v.h)) ? Math.round(Number(v.h)) : 0;
    if (w >= 1 && w <= 10000 && h >= 1 && h <= 10000) viewport = w + "x" + h;
  }
  const online = body.online === true ? 1 : body.online === false ? 0 : null;

  let err = { name: "", message: "", endpoint: "", status: null };
  if (body.error != null) {
    const e = body.error;
    if (typeof e !== "object" || Array.isArray(e)) return fail("bad_request", "That report's error details couldn't be read.", { fields: ["error"] });
    const eu = Object.keys(e).filter((k) => ALLOWED_ERROR_FIELDS.indexOf(k) === -1);
    if (eu.length) return fail("unknown_field", "That report included fields the app doesn't send.", { fields: eu.slice(0, 8).map((k) => "error." + k) });
    err.name = clean(e.name, LIMITS.ERR_NAME_MAX);
    err.message = clean(e.message, LIMITS.ERR_MESSAGE_MAX);
    const rawEndpoint = str(e.endpoint);
    err.endpoint = cleanEndpointPath(rawEndpoint);
    if (/[?#]/.test(rawEndpoint)) redactions++;
    const st = Math.round(Number(e.status));
    err.status = Number.isFinite(st) && st >= 100 && st <= 599 ? st : null;
  }

  return {
    ok: true,
    redactions,
    token: str(body.mfl_user_id).trim(),
    value: {
      client_request_id: requestId,
      summary, note, screen, build,
      client_time: clientTime, viewport, online,
      err_name: err.name, err_message: err.message, err_endpoint: err.endpoint, err_status: err.status,
    },
  };
}

// ---------------------------------------------------------------------------
// Duplicate fingerprint
// ---------------------------------------------------------------------------

/** Text that identifies "the same problem": lower-cased, digits collapsed, spaces squeezed. */
export function fingerprintText(v) {
  const norm = (s) => str(s).toLowerCase().replace(/[0-9]+/g, "#").replace(/\s+/g, " ").trim();
  const hasError = v.err_name || v.err_message || v.err_endpoint || v.err_status;
  const parts = hasError
    ? [norm(v.screen), norm(v.err_name), norm(v.err_message), norm(v.err_endpoint), str(v.err_status)]
    : [norm(v.screen), norm(v.summary)]; // no error captured: the owner's own words decide
  return parts.join("|");
}

export async function fingerprint(v) {
  const data = new TextEncoder().encode(fingerprintText(v));
  const buf = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
}

// ---------------------------------------------------------------------------
// Rate limit (pure: the caller passes this franchise's newest rows in the window)
// ---------------------------------------------------------------------------

/**
 * @param recent  created_at ISO strings of this franchise's reports inside the window, newest first
 * @param nowMs   current time in ms
 * @returns { allow:true } | { allow:false, code:'too_fast'|'daily_limit', retryAfterSeconds }
 */
export function rateDecision(recent, nowMs) {
  const times = (recent || []).map((t) => Date.parse(t)).filter(Number.isFinite).sort((a, b) => b - a);
  if (times.length) {
    const sinceLast = (nowMs - times[0]) / 1000;
    if (sinceLast < LIMITS.MIN_GAP_SECONDS) {
      return { allow: false, code: "too_fast", retryAfterSeconds: Math.max(1, Math.ceil(LIMITS.MIN_GAP_SECONDS - sinceLast)) };
    }
  }
  if (times.length >= LIMITS.DAILY_MAX) {
    // The oldest report in the window leaves it first; the slot that frees up is the DAILY_MAX-th newest.
    const frees = times[LIMITS.DAILY_MAX - 1] + LIMITS.WINDOW_HOURS * 3600 * 1000;
    return { allow: false, code: "daily_limit", retryAfterSeconds: Math.max(1, Math.ceil((frees - nowMs) / 1000)) };
  }
  return { allow: true };
}

export function windowStartIso(nowMs) {
  return new Date(nowMs - LIMITS.WINDOW_HOURS * 3600 * 1000).toISOString();
}

// ---------------------------------------------------------------------------
// Report codes and owner-facing messages
// ---------------------------------------------------------------------------

const pad3 = (n) => String(Math.max(0, Math.floor(Number(n) || 0))).padStart(3, "0");
/** TEST-001 for a test-environment report. Derived from the row id; nothing extra is stored. */
export function reportCode(row) { return (row.env === "live" ? "APP-" : "TEST-") + pad3(row.id); }

/**
 * Everything an owner can be told when a report can't be filed. `state` is what the
 * phone sheet shows; `draftKept` is always true (the note stays on screen).
 */
export const MESSAGES = Object.freeze({
  unauthenticated:      { http: 401, state: "signin",   title: "Sign in to MFL first", message: "We couldn't find your MFL sign-in, so we can't tell which team this is from. Open UPS from MFL, then tap Report bug again. Nothing was sent, and your note is still here." },
  session_expired:      { http: 401, state: "signin",   title: "Your MFL sign-in expired", message: "MFL no longer accepts your sign-in. Sign in to MFL again, open UPS from there, and tap Send. Nothing was sent, and your note is still here." },
  forbidden:            { http: 403, state: "signin",   title: "That MFL login isn't in this league", message: "You're signed in to MFL, but not as a team in this league. Sign in with your league account and try again. Nothing was sent." },
  identity_unavailable: { http: 503, state: "retry",    title: "Can't check your sign-in right now", message: "MFL didn't answer when we tried to confirm who you are. Try again in a minute. Nothing was sent, and your note is still here." },
  disabled:             { http: 404, state: "off",      title: "Reporting isn't turned on yet", message: "Bug reports aren't open to owners yet. Nothing was sent." },
  too_fast:             { http: 429, state: "limit",    title: "One moment", message: "You just sent a report. Wait a few seconds before sending another." },
  daily_limit:          { http: 429, state: "limit",    title: "Daily limit reached", message: "You've sent the most reports allowed in 24 hours. The commissioner already has them. Try again later." },
  duplicate_limit:      { http: 429, state: "limit",    title: "Already reported", message: "You've already reported this problem several times. The commissioner has it." },
  summary_required:     { http: 400, state: "fix",      title: "Add a few words", message: "Say briefly what went wrong, then tap Send." },
  unknown_field:        { http: 400, state: "error",    title: "This version can't send that report", message: "The app and the server disagree about this report. Update the app and try again. Nothing was sent." },
  too_large:            { http: 413, state: "fix",      title: "Report is too long", message: "Shorten your note and try again." },
  bad_request:          { http: 400, state: "error",    title: "That report couldn't be read", message: "Something in the report was missing or malformed. Nothing was sent." },
  server_error:         { http: 500, state: "retry",    title: "Something went wrong on our side", message: "The report wasn't saved. Try again in a minute." },
});

export function ownerMessage(code) { return MESSAGES[code] || MESSAGES.server_error; }
