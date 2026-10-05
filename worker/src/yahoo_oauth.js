// worker/src/yahoo_oauth.js
// Yahoo Fantasy OAuth 2.0 — the worker-hosted half of the multi-platform
// fantasy ingestion pipeline (D1 migrations 0127-0132).
//
// WHAT THIS IS. Five commish-gated routes that own the entire Yahoo credential
// lifecycle for platform='yahoo':
//   GET  /admin/yahoo/auth/start     mint CSRF state → 302 to Yahoo's consent screen
//   GET  /admin/yahoo/auth/callback  validate state → exchange code → encrypt + store
//   POST /admin/yahoo/token          mint a 1-hour ACCESS token for the CLI/CI
//   GET  /admin/yahoo/status         names + booleans only; never a value
//   POST /admin/yahoo/revoke         mark the local row revoked + tell the human what to do
// Mounted from worker/src/index.js exactly like hall.js: returns a Response when
// the path is ours, null otherwise so the main dispatcher continues.
//
// WHY IT EXISTS — THE GAP IT CLOSES. The Python side
// (pipelines/fantasy/providers/yahoo/oauth.py) can hold a refresh token in the
// macOS Keychain, which is fine on Keith's laptop and useless everywhere else.
// GitHub Actions has no Keychain, and a Cloudflare Worker CANNOT rotate its own
// secrets — there is no runtime `wrangler secret put`. Yahoo may hand back a NEW
// refresh token on ANY refresh and revokes the old one the moment it does, so a
// rotation that is not persisted is an unrecoverable loss of access that only
// surfaces an hour later, in an unattended run, at 3 AM. Something durable and
// writable has to hold that token. There is no KV binding in this project, so
// that something is D1 — which is why fantasy_oauth_tokens stores CIPHERTEXT and
// not a token: the whole database is snapshotted to R2 hourly and is reachable
// from commish-gated diagnostic paths. The encryption key lives ONLY in the
// YAHOO_TOKEN_ENCRYPTION_KEY worker secret, never in D1, never in git.
//
// POST /admin/yahoo/token exists so CI never holds a long-lived credential at
// all: the runner presents the commish API key, gets back an access token that
// dies in an hour, and the refresh token never leaves this worker.
//
// WHAT IS DELIBERATELY *NOT* DONE HERE:
//   · No Yahoo DATA calls. This module authenticates and nothing else; every
//     fantasysports.yahooapis.com read belongs to the pipeline.
//   · No writes to any fantasy_* table other than fantasy_oauth_tokens,
//     fantasy_oauth_states and (best-effort) fantasy_api_errors.
//   · NOTHING is read or written in ups_* / src_* / mfl_* / nfl_*. The UPS
//     league lives on MyFantasyLeague; this is a different league on a different
//     platform that happens to share a database (0127 header).
//   · No programmatic revocation call. Yahoo does not expose one. /revoke marks
//     the local row and returns instructions rather than pretending — claiming
//     to have revoked a token that is still live is worse than saying nothing.
//   · No access token is ever persisted. It lives an hour and is cheap to
//     re-mint; storing it would add exposure for no benefit (0127 header).
//   · No `oob` (paste-the-code) flow. That is the laptop path and it lives in
//     the Python module; a worker route needs a real redirect_uri.
//
// NO FAIL-OPEN, EVERYWHERE (rule_no_fail_open_guards, Keith 2026-08-02
// "NEVER EVER again" — the single root cause behind every contract/cap
// destruction incident in this repo, and it still bit the ERA auto-drop sweep on
// 2026-08-06 through a D1 read that failed open):
//   · A state row we cannot READ is not a state row that is absent. A D1 error
//     during callback validation REFUSES; it never falls through to "no state
//     supplied, probably fine".
//   · A non-JSON body from Yahoo's token endpoint is an error or throttle page,
//     never an empty success. Yahoo answers throttling with HTTP 999 and an HTML
//     body; a client that parses before checking status turns that into an
//     exception and a client that catches broadly turns it into silence.
//   · A missing/short/unparseable encryption key REFUSES with a named error.
//     There is no plaintext fallback. Storing a refresh token in the clear
//     because a secret was unset is the exact shape of a silent catastrophe.
//   · COMMISH_API_KEY unset = every route 503s. Unset never means "open".
//
// NULL vs 0. NULL means "Yahoo did not say" (scope, guid, last_refreshed_at);
// 0 means Yahoo said zero. refresh_failure_count starts at 0 because we counted
// zero failures — that is a real observation, not a placeholder.
//
// REDACTION. Every log line and every error body goes through redactText()
// before it leaves this module, and outbound URLs through redactUrl(). The
// single exception is the success body of POST /admin/yahoo/token, where the
// access token IS the payload — that path is marked and is the only place in
// this file that writes credential material into a response.
//
// ⚠️ THE redirect_uri BYTE-MATCH RULE. Yahoo compares the redirect_uri at the
// token exchange against the one sent at authorize BYTE FOR BYTE and rejects a
// mismatch with a bare 401 — Yahoo's own docs list this and a base64 Basic
// header with a trailing newline as the two classic silent 401s. So the exact
// string used at /auth/start is persisted in fantasy_oauth_states.redirect_uri
// and the exchange echoes THAT, not the env var, which means an operator editing
// YAHOO_REDIRECT_URI mid-flow cannot break an in-flight authorization.
//
// ⚠️ THE APIKEY-ON-THE-CALLBACK WRINKLE, AND WHY A 403 IS SAFE. Every route here
// is gated on ?APIKEY=, including the callback that Yahoo redirects the browser
// to — and Yahoo will not add an APIKEY to that redirect. Two supported ways
// through, both fine:
//   (a) register the redirect URI at Yahoo WITH the key already in it and set
//       YAHOO_REDIRECT_URI to that identical string, or
//   (b) let the 403 happen, then re-open the callback URL from the address bar
//       with `&APIKEY=…` appended.
// (b) works because the gate runs BEFORE any state lookup: a 403 consumes
// nothing, burns nothing, and the state stays valid for the rest of its TTL. The
// state is consumed only after the token row is durably written.
//
// ── SETUP / RUN ──────────────────────────────────────────────────────────────
//   1. Register the app at https://developer.yahoo.com/apps/create/ with API
//      Permissions → Fantasy Sports → Read. (Write access is not available from
//      Yahoo in 2026 no matter what scope you ask for.)
//   2. Secrets (prod), values pasted at the prompt — never on the command line:
//        wrangler secret put YAHOO_CLIENT_ID
//        wrangler secret put YAHOO_CLIENT_SECRET
//        wrangler secret put YAHOO_REDIRECT_URI
//        wrangler secret put YAHOO_TOKEN_ENCRYPTION_KEY   # openssl rand -base64 32
//   3. Apply migrations 0127→0132 first (fantasy_oauth_tokens/_states live in
//      0127) with `wrangler d1 execute ups-mfl-db --remote --file=…`.
//      NEVER `wrangler d1 migrations apply` — tracker ~47 behind, corrupts contracts.
//   4. Flip YAHOO_SYNC_ENABLED to "1" (wrangler.toml default is "0" — dark).
//   5. Authorize, in a browser:
//        https://<worker>/admin/yahoo/auth/start?APIKEY=…
//      then confirm:
//        curl -s 'https://<worker>/admin/yahoo/status?APIKEY=…'
//      and mint a CLI credential:
//        curl -s -X POST 'https://<worker>/admin/yahoo/token?APIKEY=…'
//      (curl, not urllib — urllib gets bot-403'd by this stack.)
//
// ⚠️ AN invalid_grant IS EXPECTED, NOT A BUG. Yahoo's FAQ (the more specific
// page, and the one treated as authoritative over flows_authcode which
// contradicts it) says every refresh token is revoked when the account password
// changes. When that happens /token answers 401 with the remedy: re-run
// /auth/start. The row is marked revoked, never deleted.

import { getFeatureFlag } from "./feature_flags.js";

// ─────────────────────────────────────────────────────────────────────────────
// Constants — verified 2026-08-11 against Yahoo's live documentation.
// ─────────────────────────────────────────────────────────────────────────────
const PLATFORM = "yahoo";
const ROUTE_PREFIX = "/admin/yahoo/";
const AUTHORIZE_URL = "https://api.login.yahoo.com/oauth2/request_auth";
const TOKEN_URL = "https://api.login.yahoo.com/oauth2/get_token";
// Fantasy Sports, READ-ONLY. The scope-identifier page 404s now, so this value
// is community-known rather than documented; for a non-OIDC flow the effective
// grant is whatever API Permissions the app was registered with anyway.
const SCOPE_READ_ONLY = "fspt-r";
const USER_AGENT = "upsmfl-fantasy-ingest/1.0 (+read-only)";

// A consent screen the human is actively looking at. Long enough to log into
// Yahoo and pass MFA, short enough that a state left in a browser tab overnight
// is dead. Replay is separately impossible (single-use), this is depth.
const STATE_TTL_SECONDS = 600;
// Consumed/expired state rows are evidence of who authorized what and when, so
// they are kept for a week before the housekeeping sweep drops them.
const STATE_RETENTION_SECONDS = 7 * 24 * 60 * 60;

const DEFAULT_ACCOUNT_KEY = "primary";
const ACCOUNT_KEY_RE = /^[A-Za-z0-9_-]{1,40}$/;

// fantasy_oauth_tokens.key_version — lets YAHOO_TOKEN_ENCRYPTION_KEY rotate
// later without a migration. Bump when the key changes so a row encrypted under
// the old key is identifiable instead of just "undecryptable".
const KEY_VERSION = 1;
const AES_KEY_BYTES = 32;   // AES-256
const AES_IV_BYTES = 12;    // 96-bit GCM nonce, fresh per WRITE (never reused)

// Yahoo documents 3600s access tokens. Only used when expires_in is malformed.
const ACCESS_TOKEN_DEFAULT_TTL_SEC = 3600;
// Refresh this early so a long backfill request cannot start on a token that
// expires mid-flight. Mirrors EXPIRY_SKEW_SEC in the Python module.
const EXPIRY_SKEW_SEC = 300;
const TOKEN_FETCH_TIMEOUT_MS = 30000;

// Dark launch. Default OFF in wrangler.toml; a D1 ups_settings override wins.
const FLAG_KEY = "YAHOO_SYNC_ENABLED";

// ─────────────────────────────────────────────────────────────────────────────
// Redaction. Build the message, redact it, THEN emit it — redacting after the
// fact is not possible. Mirrors pipelines/fantasy/redact.py so the two halves of
// the pipeline cannot disagree about what counts as a secret.
//
// What must SURVIVE redaction: league keys, team keys, seasons, weeks, HTTP
// status codes, error_code values. Over-redaction is its own failure mode — a
// redactor that turns every message into "[redacted]" means nobody can tell
// which request failed.
// ─────────────────────────────────────────────────────────────────────────────
const REDACTED = "[redacted]";
const SECRET_PARAM_NAMES = [
  "access_token", "assertion", "client_id", "client_secret", "code",
  "id_token", "nonce", "password", "refresh_token", "state",
];
// Also stripped from URLs: this worker's own gate/session parameters.
const SECRET_URL_PARAM_NAMES = SECRET_PARAM_NAMES.concat([
  "APIKEY", "COMMISH_API_KEY", "MFL_USER_ID",
]);
const SECRET_HEADER_NAMES = ["authorization", "cookie", "set-cookie", "proxy-authorization"];
const SECRET_NAME_ALT = SECRET_PARAM_NAMES.join("|");
// Ordered most-specific first, exactly like the Python module.
const RE_BEARER = /\b(bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const RE_SECRET_KV = new RegExp("\\b(" + SECRET_NAME_ALT + ")=([^&\\s\"']+)", "gi");
const RE_SECRET_JSON = new RegExp("\"(" + SECRET_NAME_ALT + ")\"\\s*:\\s*\"[^\"]*\"", "gi");

function safeStr(v) {
  return String(v == null ? "" : v).trim();
}

// Safe on null / non-strings and never throws: the callers are logging paths,
// and a redactor that can throw is a redactor someone wraps in a bare catch and
// bypasses.
function redactText(value) {
  if (value == null) return "";
  let s = String(value);
  try {
    s = s.replace(RE_BEARER, "$1 " + REDACTED);
    s = s.replace(RE_SECRET_KV, (_m, name) => `${name}=${REDACTED}`);
    s = s.replace(RE_SECRET_JSON, (_m, name) => `"${name}": "${REDACTED}"`);
  } catch (_) {
    return REDACTED;
  }
  return s;
}

// Structural, not a regex over the raw string: a token containing '&' or an
// encoded character cannot leak through a greedy match. Host, path and every
// non-secret parameter survive — you still need to know WHICH request failed.
function redactUrl(rawUrl) {
  const s = safeStr(rawUrl);
  if (!s) return "";
  try {
    const u = new URL(s);
    for (const key of SECRET_URL_PARAM_NAMES) {
      if (u.searchParams.has(key)) u.searchParams.set(key, REDACTED);
    }
    return u.toString();
  } catch (_) {
    return redactText(s);
  }
}

function redactHeaders(headers) {
  const out = {};
  for (const k of Object.keys(headers || {})) {
    out[k] = SECRET_HEADER_NAMES.indexOf(String(k).toLowerCase()) === -1 ? headers[k] : REDACTED;
  }
  return out;
}

function logInfo(msg) { console.log(`[yahoo-oauth] ${redactText(msg)}`); }
function logWarn(msg) { console.warn(`[yahoo-oauth] ${redactText(msg)}`); }
function logError(msg) { console.error(`[yahoo-oauth] ${redactText(msg)}`); }

// ─────────────────────────────────────────────────────────────────────────────
// Responses
// ─────────────────────────────────────────────────────────────────────────────

// The whole serialized body passes through the redactor. Belt and braces: if a
// future edit ever drops a provider payload into an error field, the redactor
// catches it on the way out instead of after it is in someone's terminal
// scrollback. Field names are chosen to survive it — `error_code`, not `code`.
function jsonOut(status, payload, corsHeaders) {
  return new Response(redactText(JSON.stringify(payload)), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...corsHeaders },
  });
}

// ⚠️ THE ONE PLACE IN THIS FILE THAT EMITS CREDENTIAL MATERIAL. Used solely by
// the POST /admin/yahoo/token success path, where the access token IS the
// deliverable and running it through redactText would replace the answer with
// "[redacted]". Nothing else may call this, and this body is never logged.
function jsonOutWithCredential(status, payload, corsHeaders) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...corsHeaders },
  });
}

// A named refusal. Every failure in this module carries a stable error_code so
// an operator can grep for it and a caller can branch on it without parsing
// prose. `remedy` is the human next step — a refusal with no way forward just
// moves the problem.
class YahooRefusal extends Error {
  constructor(errorCode, message, status, remedy) {
    super(message);
    this.name = "YahooRefusal";
    this.error_code = errorCode;
    this.status = status || 500;
    this.remedy = remedy || "";
  }
}

function refusalOut(err, corsHeaders) {
  const status = err instanceof YahooRefusal ? err.status : 500;
  const body = {
    ok: false,
    error_code: err instanceof YahooRefusal ? err.error_code : "yahoo_unhandled",
    error: redactText(err && err.message ? err.message : String(err)),
  };
  if (err instanceof YahooRefusal && err.remedy) body.remedy = err.remedy;
  return jsonOut(status, body, corsHeaders);
}

// ─────────────────────────────────────────────────────────────────────────────
// Gates
// ─────────────────────────────────────────────────────────────────────────────

// Commish gate, copied from the existing /admin routes (index.js
// /admin/app-views, /admin/config-health): the key rides in ?APIKEY= — this
// worker's /admin auth is a QUERY parameter, not a header.
//
// FAILS CLOSED. An unset COMMISH_API_KEY 503s every route rather than
// accidentally publishing an OAuth flow to the internet. "The secret is missing"
// has never meant "let everyone in".
function assertCommish(url, env) {
  const expected = safeStr(env && env.COMMISH_API_KEY);
  if (!expected) {
    throw new YahooRefusal(
      "commish_api_key_unset",
      "COMMISH_API_KEY is not set on this worker, so every /admin/yahoo/* route refuses. This is a fail-CLOSED refusal, not an outage.",
      503,
      "wrangler secret put COMMISH_API_KEY, then retry."
    );
  }
  const provided = safeStr(url.searchParams.get("APIKEY"));
  if (!provided || provided !== expected) {
    throw new YahooRefusal(
      "commish_only",
      "Valid ?APIKEY=<COMMISH_API_KEY> required.",
      403,
      "Append &APIKEY=… to this URL. On the OAuth callback a 403 is harmless — the gate runs before the state lookup, so nothing was consumed and the state is still valid until it expires."
    );
  }
}

// Dark-launch kill switch on every WRITE path (start / callback / token /
// revoke). GET /admin/yahoo/status is deliberately NOT gated on it: read-only
// diagnostics have to work while the feature is dark, which is the whole point
// of having them. getFeatureFlag itself fails closed — an unreadable D1
// override map answers false for every flag.
async function assertWritesEnabled(env) {
  const on = await getFeatureFlag(env, FLAG_KEY);
  if (!on) {
    throw new YahooRefusal(
      "yahoo_sync_disabled",
      `${FLAG_KEY} is OFF, so the Yahoo OAuth write paths refuse. Read-only status stays available at GET /admin/yahoo/status.`,
      503,
      `Flip ${FLAG_KEY} on (wrangler.toml default, or the D1 ups_settings 'feature_flags' override, which wins).`
    );
  }
}

function requireDb(env) {
  if (!env || !env.UPS_MFL_DB) {
    throw new YahooRefusal(
      "d1_binding_missing",
      "UPS_MFL_DB binding is missing; refusing rather than pretending there is no stored token.",
      500,
      "Check the [[d1_databases]] binding in wrangler.toml."
    );
  }
  return env.UPS_MFL_DB;
}

function readAccountKey(url) {
  const raw = safeStr(url.searchParams.get("account")) || DEFAULT_ACCOUNT_KEY;
  if (!ACCOUNT_KEY_RE.test(raw)) {
    throw new YahooRefusal(
      "yahoo_bad_account_key",
      "account must match /^[A-Za-z0-9_-]{1,40}$/ — it is an opaque local label (e.g. 'primary'), never an email address.",
      400,
      "Drop the ?account= parameter to use 'primary'."
    );
  }
  return raw;
}

// ─────────────────────────────────────────────────────────────────────────────
// Encoding helpers
// ─────────────────────────────────────────────────────────────────────────────
function bytesToB64(bytes) {
  let bin = "";
  const CHUNK = 0x8000; // apply() has an argument-count ceiling; chunk under it.
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

function bytesToB64Url(bytes) {
  return bytesToB64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Accepts standard or URL-safe base64, padded or not. THROWS on garbage — a
// key we cannot decode is not a key, and it is certainly not "no encryption".
function b64ToBytes(b64) {
  const norm = safeStr(b64).replace(/-/g, "+").replace(/_/g, "/").replace(/\s+/g, "");
  const padded = norm.length % 4 === 0 ? norm : norm + "=".repeat(4 - (norm.length % 4));
  const bin = atob(padded); // throws on invalid characters
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function randomBytes(n) {
  const buf = new Uint8Array(n);
  crypto.getRandomValues(buf);
  return buf;
}

function nowUnix() { return Math.floor(Date.now() / 1000); }
function nowIso() { return new Date().toISOString(); }

// ─────────────────────────────────────────────────────────────────────────────
// AES-256-GCM. The refresh token is the only credential this project stores at
// rest, and it is stored ONLY as ciphertext.
//
// ⚠️ THERE IS NO PLAINTEXT FALLBACK, BY CONSTRUCTION. A missing, unparseable or
// wrong-length key raises a named refusal and the write does not happen. Storing
// a live refresh token in the clear because a secret was unset would be a silent
// credential leak into an hourly R2 snapshot — the worst possible reading of
// "be helpful".
// ─────────────────────────────────────────────────────────────────────────────
function decodeEncryptionKeyBytes(env) {
  const raw = safeStr(env && env.YAHOO_TOKEN_ENCRYPTION_KEY);
  if (!raw) {
    throw new YahooRefusal(
      "yahoo_encryption_key_missing",
      "YAHOO_TOKEN_ENCRYPTION_KEY is not set. Refusing — the refresh token is never stored unencrypted.",
      503,
      "openssl rand -base64 32   →   wrangler secret put YAHOO_TOKEN_ENCRYPTION_KEY"
    );
  }
  let bytes;
  try {
    bytes = b64ToBytes(raw);
  } catch (_) {
    throw new YahooRefusal(
      "yahoo_encryption_key_unparseable",
      "YAHOO_TOKEN_ENCRYPTION_KEY is not valid base64. Refusing.",
      503,
      "Regenerate with `openssl rand -base64 32` and re-put the secret."
    );
  }
  if (bytes.length !== AES_KEY_BYTES) {
    // Length is stated because it is diagnostic and is not the key itself.
    throw new YahooRefusal(
      "yahoo_encryption_key_wrong_length",
      `YAHOO_TOKEN_ENCRYPTION_KEY decoded to ${bytes.length} bytes; AES-256-GCM needs exactly ${AES_KEY_BYTES}. Refusing.`,
      503,
      "openssl rand -base64 32   →   wrangler secret put YAHOO_TOKEN_ENCRYPTION_KEY"
    );
  }
  return bytes;
}

async function importEncryptionKey(env) {
  const bytes = decodeEncryptionKeyBytes(env);
  // extractable=false: once imported the key material cannot be read back out
  // of the CryptoKey, so no later code path can accidentally serialize it.
  return crypto.subtle.importKey("raw", bytes, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

// Returns { ciphertext, iv } — both base64. The IV is FRESH on every write:
// reusing a GCM nonce under the same key is a catastrophic break, not a style
// nit, which is why token_iv is a per-record column and not a constant.
async function encryptSecret(env, plaintext) {
  const key = await importEncryptionKey(env);
  const iv = randomBytes(AES_IV_BYTES);
  const buf = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(String(plaintext))
  );
  return { ciphertext: bytesToB64(new Uint8Array(buf)), iv: bytesToB64(iv) };
}

async function decryptSecret(env, ciphertextB64, ivB64) {
  const key = await importEncryptionKey(env);
  let ivBytes;
  let ctBytes;
  try {
    ivBytes = b64ToBytes(ivB64);
    ctBytes = b64ToBytes(ciphertextB64);
  } catch (_) {
    throw new YahooRefusal(
      "yahoo_stored_token_unparseable",
      "The stored refresh token row is not valid base64. Refusing — this is a corrupt row, not an absent token.",
      500,
      "Re-authorize: GET /admin/yahoo/auth/start?APIKEY=…"
    );
  }
  if (ivBytes.length !== AES_IV_BYTES) {
    throw new YahooRefusal(
      "yahoo_stored_iv_wrong_length",
      `Stored token_iv decoded to ${ivBytes.length} bytes; AES-GCM needs ${AES_IV_BYTES}. Refusing.`,
      500,
      "Re-authorize: GET /admin/yahoo/auth/start?APIKEY=…"
    );
  }
  let plainBuf;
  try {
    plainBuf = await crypto.subtle.decrypt({ name: "AES-GCM", iv: ivBytes }, key, ctBytes);
  } catch (_) {
    // GCM authenticates: a failure here means wrong key or tampered ciphertext.
    // Both are refusals. Neither is "there is no token".
    throw new YahooRefusal(
      "yahoo_refresh_token_undecryptable",
      "Stored refresh token failed AES-GCM authentication — the encryption key does not match the one that wrote this row (rotated key?), or the row was altered. Refusing.",
      500,
      "If YAHOO_TOKEN_ENCRYPTION_KEY was rotated, re-authorize: GET /admin/yahoo/auth/start?APIKEY=…"
    );
  }
  return new TextDecoder().decode(plainBuf);
}

// ─────────────────────────────────────────────────────────────────────────────
// fantasy_api_errors — append-only evidence ledger (0127). Best-effort by
// design: this records WHY a refusal happened, so a failure to record must not
// mask the refusal itself. It is logged, never swallowed silently.
//
// `message` is redacted before insert and truncated: an unbounded provider body
// in a D1 row can blow past the ~100KB single-statement cap and take the whole
// insert down with it.
// ─────────────────────────────────────────────────────────────────────────────
async function recordApiError(env, fields) {
  try {
    if (!env || !env.UPS_MFL_DB) return;
    await env.UPS_MFL_DB.prepare(
      `INSERT INTO fantasy_api_errors
         (run_id, platform, resource, endpoint_path, league_key, season, week,
          http_status, error_kind, attempt, is_retryable, message, occurred_at_utc)
       VALUES (NULL, ?, ?, ?, NULL, NULL, NULL, ?, ?, 1, ?, ?, datetime('now'))`
    ).bind(
      PLATFORM,
      safeStr(fields.resource) || "oauth",
      redactUrl(fields.endpoint_path || TOKEN_URL),
      Number.isFinite(fields.http_status) ? fields.http_status : null,
      safeStr(fields.error_kind) || "unknown",
      fields.is_retryable ? 1 : 0,
      redactText(fields.message).slice(0, 800)
    ).run();
  } catch (e) {
    logWarn(`fantasy_api_errors insert failed (the original refusal still stands): ${e && e.message}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Yahoo token endpoint
// ─────────────────────────────────────────────────────────────────────────────

// HTTP Basic, so the client credentials never appear in a URL, a form dump or a
// retry log. ⚠️ NO TRAILING NEWLINE in the base64 — Yahoo's own troubleshooting
// notes call this out as a classic silent 401. btoa() cannot add one; the risk
// is a newline inside the SECRET itself (a `wrangler secret put` from a file),
// which is why both halves are trimmed by safeStr before they get here.
function basicAuthHeader(clientId, clientSecret) {
  try {
    return "Basic " + btoa(`${clientId}:${clientSecret}`);
  } catch (_) {
    throw new YahooRefusal(
      "yahoo_client_credentials_unencodable",
      "YAHOO_CLIENT_ID / YAHOO_CLIENT_SECRET contain characters outside latin-1 and cannot be base64-encoded for HTTP Basic. Refusing.",
      500,
      "Re-copy both values from https://developer.yahoo.com/apps/ — a stray smart quote or non-ASCII whitespace is the usual cause."
    );
  }
}

function readClientCredentials(env) {
  const clientId = safeStr(env && env.YAHOO_CLIENT_ID);
  const clientSecret = safeStr(env && env.YAHOO_CLIENT_SECRET);
  const missing = [];
  if (!clientId) missing.push("YAHOO_CLIENT_ID");
  if (!clientSecret) missing.push("YAHOO_CLIENT_SECRET");
  if (missing.length) {
    // NO HARDCODED FALLBACK, EVER (RULE-SECRETS-001). An unset credential must
    // fail, not quietly "work" against some default.
    throw new YahooRefusal(
      "yahoo_client_credentials_missing",
      `Missing Yahoo OAuth credentials: ${missing.join(", ")}.`,
      503,
      "wrangler secret put YAHOO_CLIENT_ID / YAHOO_CLIENT_SECRET — register the app at https://developer.yahoo.com/apps/create/ with Fantasy Sports → Read."
    );
  }
  return { clientId, clientSecret };
}

// The redirect_uri is NOT defaulted. Yahoo byte-matches it, so a guessed value
// produces a bare 401 that looks like a credential problem and costs an hour.
function readRedirectUri(env) {
  const uri = safeStr(env && env.YAHOO_REDIRECT_URI);
  if (!uri) {
    throw new YahooRefusal(
      "yahoo_redirect_uri_missing",
      "YAHOO_REDIRECT_URI is not set. Refusing to guess — Yahoo compares this value byte for byte and answers a mismatch with a bare 401.",
      503,
      "wrangler secret put YAHOO_REDIRECT_URI — it must be byte-identical to the Redirect URI registered on the Yahoo app."
    );
  }
  return uri;
}

// POST to Yahoo's token endpoint. Returns the parsed JSON body on success and
// throws a named YahooRefusal on every other outcome.
//
// ⚠️ AN UNPARSEABLE BODY IS NEVER AN EMPTY SUCCESS. Yahoo answers throttling
// with HTTP 999 and an HTML "Request denied" page. Parsing before checking the
// status turns that into an exception; catching broadly turns it into silence.
// Both are refusals here, with the status preserved.
async function postToken(env, form) {
  const { clientId, clientSecret } = readClientCredentials(env);
  const headers = {
    Authorization: basicAuthHeader(clientId, clientSecret),
    "Content-Type": "application/x-www-form-urlencoded",
    Accept: "application/json",
    "User-Agent": USER_AGENT,
  };
  const body = new URLSearchParams(form).toString();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TOKEN_FETCH_TIMEOUT_MS);
  let res;
  let text = "";
  try {
    res = await fetch(TOKEN_URL, { method: "POST", headers, body, signal: controller.signal });
    text = await res.text();
  } catch (e) {
    clearTimeout(timer);
    await recordApiError(env, {
      resource: "oauth.token", endpoint_path: TOKEN_URL, http_status: null,
      error_kind: "transport", is_retryable: true,
      message: `transport failure: ${e && e.message}`,
    });
    throw new YahooRefusal(
      "yahoo_token_endpoint_unreachable",
      `Could not reach Yahoo's token endpoint: ${redactText(e && e.message ? e.message : String(e))}`,
      502,
      "Transient — retry. If it persists, check https://api.login.yahoo.com reachability."
    );
  }
  clearTimeout(timer);

  let data = null;
  let parseFailed = false;
  try {
    data = text ? JSON.parse(text) : null;
  } catch (_) {
    parseFailed = true;
  }

  if (!res.ok) {
    const looksInvalidGrant = /invalid_grant/i.test(text) ||
      (data && String(data.error || "").toLowerCase() === "invalid_grant");
    const kind = looksInvalidGrant || res.status === 400 || res.status === 401 ? "auth"
      : res.status === 999 || res.status === 429 ? "rate_limited"
      : res.status >= 500 ? "server" : "unknown";
    await recordApiError(env, {
      resource: "oauth.token", endpoint_path: TOKEN_URL, http_status: res.status,
      error_kind: kind, is_retryable: kind === "rate_limited" || kind === "server",
      // The redacted request headers are recorded because "did we actually send
      // an Authorization header" is the first question a Yahoo 401 raises, and
      // it is unanswerable after the fact otherwise.
      message: `HTTP ${res.status}: ${text.slice(0, 400)} | sent=${JSON.stringify(redactHeaders(headers))}`,
    });
    if (kind === "auth") {
      throw new YahooRefusal(
        "yahoo_auth_rejected",
        `Yahoo rejected the token request (HTTP ${res.status}). On a refresh this means the refresh token is no longer valid — Yahoo revokes refresh tokens when the account password changes or the user removes the app. Provider said: ${redactText(text).slice(0, 300)}`,
        401,
        "Re-authorize: GET /admin/yahoo/auth/start?APIKEY=… . Also check that YAHOO_REDIRECT_URI still byte-matches the registered value and that the client secret carries no trailing newline — those are Yahoo's two documented silent-401 causes."
      );
    }
    throw new YahooRefusal(
      "yahoo_token_endpoint_error",
      `Yahoo's token endpoint returned HTTP ${res.status}: ${redactText(text).slice(0, 300)}`,
      502,
      kind === "rate_limited" ? "Throttled (Yahoo answers throttling with HTTP 999 and an HTML body). Back off and retry." : "Retry; if it persists this is a Yahoo-side fault."
    );
  }

  if (parseFailed || data == null) {
    await recordApiError(env, {
      resource: "oauth.token", endpoint_path: TOKEN_URL, http_status: res.status,
      error_kind: "unparseable", is_retryable: true,
      message: `non-JSON body, ${text.length} bytes`,
    });
    throw new YahooRefusal(
      "yahoo_token_response_unparseable",
      `Yahoo's token endpoint returned HTTP ${res.status} with a non-JSON body (${text.length} bytes) — that is an error or throttle page, never a token.`,
      502,
      "Retry. A 999-with-HTML body means throttling."
    );
  }
  if (!data.access_token) {
    await recordApiError(env, {
      resource: "oauth.token", endpoint_path: TOKEN_URL, http_status: res.status,
      error_kind: "auth", is_retryable: false,
      message: `2xx with no access_token; keys=${Object.keys(data).sort().join(",")}`,
    });
    throw new YahooRefusal(
      "yahoo_token_response_no_access_token",
      `Yahoo answered HTTP ${res.status} with no access_token; response keys were [${Object.keys(data).sort().join(", ")}].`,
      502,
      "Re-authorize: GET /admin/yahoo/auth/start?APIKEY=…"
    );
  }
  return data;
}

function expiresAtUnixFrom(data) {
  const ttlRaw = Number(data && data.expires_in);
  const ttl = Number.isFinite(ttlRaw) && ttlRaw > 0 ? Math.floor(ttlRaw) : ACCESS_TOKEN_DEFAULT_TTL_SEC;
  return nowUnix() + ttl;
}

// ─────────────────────────────────────────────────────────────────────────────
// Route: GET /admin/yahoo/auth/start
// Mint state → persist it → 302 to Yahoo's consent screen.
//
// The state row is written BEFORE the redirect and a failed write aborts the
// flow. Redirecting on an unpersisted state would produce an authorization the
// callback can never validate — the human would consent, come back, and be
// refused with no way to tell a fault from an attack.
// ─────────────────────────────────────────────────────────────────────────────
async function routeAuthStart(url, env, corsHeaders) {
  await assertWritesEnabled(env);
  const db = requireDb(env);
  const accountKey = readAccountKey(url);
  const { clientId } = readClientCredentials(env);
  const redirectUri = readRedirectUri(env);
  decodeEncryptionKeyBytes(env); // fail here, not after the human has consented

  const state = bytesToB64Url(randomBytes(32)); // 256 bits of CSPRNG
  const expiresAt = nowUnix() + STATE_TTL_SECONDS;

  try {
    await db.prepare(
      `INSERT INTO fantasy_oauth_states
         (state, platform, account_key, nonce, redirect_uri, created_at_utc, expires_at_unix, consumed_at_utc)
       VALUES (?, ?, ?, NULL, ?, datetime('now'), ?, NULL)`
    ).bind(state, PLATFORM, accountKey, redirectUri, expiresAt).run();
  } catch (e) {
    logError(`state insert failed, refusing to redirect: ${e && e.message}`);
    throw new YahooRefusal(
      "yahoo_state_persist_failed",
      "Could not persist the OAuth state row, so the callback could never validate it. Refusing to start the flow.",
      500,
      "Check D1 health, confirm migration 0127 has been applied, then retry."
    );
  }
  // nonce is stored NULL on purpose: this is a non-OIDC flow (scope fspt-r,
  // response_type=code) and no nonce is sent, so NULL truthfully records "no
  // nonce was used" rather than inventing one to fill the column.

  // Housekeeping, genuinely best-effort: pruning old evidence rows is not an
  // input read, so a failure here is logged and ignored. This is NOT a
  // fail-open — nothing downstream trusts the sweep.
  try {
    await db.prepare(
      "DELETE FROM fantasy_oauth_states WHERE platform = ? AND expires_at_unix < ?"
    ).bind(PLATFORM, nowUnix() - STATE_RETENTION_SECONDS).run();
  } catch (e) {
    logWarn(`expired-state sweep failed (harmless): ${e && e.message}`);
  }

  const authorize = new URL(AUTHORIZE_URL);
  authorize.searchParams.set("client_id", clientId);
  authorize.searchParams.set("redirect_uri", redirectUri);
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("state", state);
  authorize.searchParams.set("scope", SCOPE_READ_ONLY);
  authorize.searchParams.set("language", "en-us");
  const authorizeUrl = authorize.toString();

  logInfo(`auth/start account=${accountKey} state_ttl=${STATE_TTL_SECONDS}s -> ${redactUrl(authorizeUrl)}`);

  // ?format=json for the CLI, which wants the URL rather than a redirect it
  // cannot render. The URL carries the state, so it is treated as a credential:
  // never logged unredacted, no-store on the response.
  if (safeStr(url.searchParams.get("format")).toLowerCase() === "json") {
    return jsonOutWithCredential(200, {
      ok: true,
      authorize_url: authorizeUrl,
      expires_at_unix: expiresAt,
      account_key: accountKey,
      scope: SCOPE_READ_ONLY,
      note: "Open this URL in a browser, consent, and let it redirect to /admin/yahoo/auth/callback. If the callback 403s, re-open it with &APIKEY=… appended — a 403 consumes nothing.",
    }, corsHeaders);
  }

  return new Response(null, {
    status: 302,
    headers: { location: authorizeUrl, "cache-control": "no-store", ...corsHeaders },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Route: GET /admin/yahoo/auth/callback
// Validate state → exchange the code → encrypt → upsert → consume the state.
//
// ⚠️ THE STATE CHECK IS THE WHOLE SECURITY OF THIS ROUTE. It must exist, be
// unexpired and be unconsumed. There is no "no state supplied, probably fine"
// branch and a D1 read failure is NOT an absent row.
// ─────────────────────────────────────────────────────────────────────────────
async function routeAuthCallback(url, env, corsHeaders) {
  await assertWritesEnabled(env);
  const db = requireDb(env);

  // Yahoo reports user-side failures (denied consent, bad app config) as an
  // ?error= on the redirect. Surface it verbatim-but-redacted; do not retry.
  const providerError = safeStr(url.searchParams.get("error"));
  if (providerError) {
    const desc = safeStr(url.searchParams.get("error_description"));
    throw new YahooRefusal(
      "yahoo_authorization_denied",
      `Yahoo returned an authorization error: ${redactText(providerError)}${desc ? ` — ${redactText(desc)}` : ""}`,
      400,
      "Re-run GET /admin/yahoo/auth/start?APIKEY=… and approve the consent screen."
    );
  }

  const stateParam = safeStr(url.searchParams.get("state"));
  if (!stateParam) {
    throw new YahooRefusal(
      "yahoo_callback_missing_state",
      "Callback carried no state parameter. REFUSING — an unauthenticated callback is not a trusted one.",
      400,
      "Start over at GET /admin/yahoo/auth/start?APIKEY=…"
    );
  }
  const code = safeStr(url.searchParams.get("code"));
  if (!code) {
    throw new YahooRefusal(
      "yahoo_callback_missing_code",
      "Callback carried no authorization code.",
      400,
      "Start over at GET /admin/yahoo/auth/start?APIKEY=…"
    );
  }

  let stateRow;
  try {
    stateRow = await db.prepare(
      `SELECT state, account_key, redirect_uri, expires_at_unix, consumed_at_utc
         FROM fantasy_oauth_states WHERE state = ? AND platform = ?`
    ).bind(stateParam, PLATFORM).first();
  } catch (e) {
    // NO FAIL-OPEN: a state we cannot read is not a state that is absent, and
    // it is certainly not a state that validated.
    logError(`state lookup failed: ${e && e.message}`);
    throw new YahooRefusal(
      "yahoo_state_lookup_failed",
      "Could not read the OAuth state row from D1. REFUSING — an unreadable state is not a valid one.",
      500,
      "Retry in a moment; if D1 is healthy, start over at /admin/yahoo/auth/start."
    );
  }
  if (!stateRow) {
    throw new YahooRefusal(
      "yahoo_state_unknown",
      "No such OAuth state. REFUSING.",
      403,
      "Start over at GET /admin/yahoo/auth/start?APIKEY=… (states are single-use and expire after 10 minutes)."
    );
  }
  if (stateRow.consumed_at_utc) {
    throw new YahooRefusal(
      "yahoo_state_already_consumed",
      "This OAuth state has already been used. REFUSING (replay).",
      403,
      "Start over at GET /admin/yahoo/auth/start?APIKEY=…"
    );
  }
  if (Number(stateRow.expires_at_unix) <= nowUnix()) {
    throw new YahooRefusal(
      "yahoo_state_expired",
      "This OAuth state has expired. REFUSING.",
      403,
      "Start over at GET /admin/yahoo/auth/start?APIKEY=…"
    );
  }

  const accountKey = safeStr(stateRow.account_key) || DEFAULT_ACCOUNT_KEY;
  // ⚠️ The redirect_uri comes from the STATE ROW, not the env var, so it is
  // byte-identical to the one sent at authorize even if the secret changed in
  // between. Yahoo compares it byte for byte.
  const redirectUri = safeStr(stateRow.redirect_uri);

  const data = await postToken(env, {
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
  });

  const refreshToken = safeStr(data.refresh_token);
  if (!refreshToken) {
    // An authorization_code grant that returns no refresh token leaves nothing
    // durable to store. Writing the row anyway would record a token we do not
    // have; the state stays unconsumed so the operator can retry cleanly.
    throw new YahooRefusal(
      "yahoo_token_response_no_refresh_token",
      "Yahoo returned an access token but no refresh token, so there is nothing durable to store. Refusing to write a half-row.",
      502,
      "Confirm the Yahoo app has Fantasy Sports → Read permission, then re-run /admin/yahoo/auth/start."
    );
  }

  const enc = await encryptSecret(env, refreshToken);

  // scope / guid: NULL when Yahoo did not say. Never defaulted to the requested
  // scope — that would record what we ASKED for as what we GOT.
  const grantedScope = safeStr(data.scope) || null;
  const yahooGuid = safeStr(data.xoauth_yahoo_guid) || null;

  try {
    await db.prepare(
      `INSERT INTO fantasy_oauth_tokens
         (platform, account_key, refresh_token_ciphertext, token_iv, key_version, scope,
          yahoo_guid, obtained_at_utc, last_refreshed_at_utc, last_refresh_status,
          refresh_failure_count, revoked_at_utc)
       VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'), 'ok', 0, NULL)
       ON CONFLICT(platform, account_key) DO UPDATE SET
         refresh_token_ciphertext = excluded.refresh_token_ciphertext,
         token_iv                 = excluded.token_iv,
         key_version              = excluded.key_version,
         scope                    = excluded.scope,
         yahoo_guid               = excluded.yahoo_guid,
         obtained_at_utc          = excluded.obtained_at_utc,
         last_refreshed_at_utc    = excluded.last_refreshed_at_utc,
         last_refresh_status      = 'ok',
         refresh_failure_count    = 0,
         revoked_at_utc           = NULL`
    ).bind(PLATFORM, accountKey, enc.ciphertext, enc.iv, KEY_VERSION, grantedScope, yahooGuid).run();
  } catch (e) {
    logError(`token upsert failed: ${e && e.message}`);
    throw new YahooRefusal(
      "yahoo_token_persist_failed",
      "Obtained a refresh token but could not persist it. REFUSING to report success — the credential is lost and must be re-obtained.",
      500,
      "Check D1 health and that migration 0127 has been applied, then re-run /admin/yahoo/auth/start."
    );
  }
  // Re-consent clears revoked_at_utc above: the human just proved the grant is
  // live again, so a stale revocation flag would lock out a working token.

  // Consume the state only now, after the token is durably written. A failed
  // exchange leaves it alive for the rest of its TTL so the operator can retry
  // the same callback URL; replay is harmless because the authorization code
  // itself is single-use at Yahoo.
  try {
    await db.prepare(
      "UPDATE fantasy_oauth_states SET consumed_at_utc = datetime('now') WHERE state = ? AND platform = ?"
    ).bind(stateParam, PLATFORM).run();
  } catch (e) {
    // The token IS stored; refusing now would be a lie. Log loudly instead — a
    // state left unconsumed can only be replayed with an already-burned code.
    logError(`state consume failed AFTER a successful token write (token is stored; state may be replayable until it expires in <=${STATE_TTL_SECONDS}s): ${e && e.message}`);
  }

  logInfo(`auth/callback OK account=${accountKey} scope=${grantedScope || "(not stated)"} guid_present=${yahooGuid ? "yes" : "no"}`);
  return jsonOut(200, {
    ok: true,
    platform: PLATFORM,
    account_key: accountKey,
    scope_granted: grantedScope,          // NULL = Yahoo did not say
    yahoo_guid_present: !!yahooGuid,
    key_version: KEY_VERSION,
    stored_at_utc: nowIso(),
    note: "Refresh token encrypted (AES-256-GCM) and stored in fantasy_oauth_tokens. It is never returned by any route. Mint a CLI credential with POST /admin/yahoo/token?APIKEY=…",
  }, corsHeaders);
}

// ─────────────────────────────────────────────────────────────────────────────
// Route: POST /admin/yahoo/token
// The CI credential path: present the commish key, receive a 1-hour access
// token. The refresh token never leaves this worker.
//
// ⚠️ PERSIST A ROTATED REFRESH TOKEN BEFORE RETURNING. Yahoo may issue a new
// refresh token on any refresh and revokes the old one when it does. A rotation
// that is not persisted is an unrecoverable loss of access that only surfaces an
// hour later. Persist first, answer second.
// ─────────────────────────────────────────────────────────────────────────────
async function routeToken(url, env, corsHeaders) {
  await assertWritesEnabled(env);
  const db = requireDb(env);
  const accountKey = readAccountKey(url);

  let row;
  try {
    row = await db.prepare(
      `SELECT refresh_token_ciphertext, token_iv, key_version, scope, revoked_at_utc, refresh_failure_count
         FROM fantasy_oauth_tokens WHERE platform = ? AND account_key = ?`
    ).bind(PLATFORM, accountKey).first();
  } catch (e) {
    // NO FAIL-OPEN: unreadable is not absent.
    logError(`token row read failed: ${e && e.message}`);
    throw new YahooRefusal(
      "yahoo_token_row_read_failed",
      "Could not read fantasy_oauth_tokens from D1. REFUSING — this is not the same as 'no token is stored'.",
      500,
      "Retry once D1 is healthy."
    );
  }
  if (!row) {
    throw new YahooRefusal(
      "yahoo_no_token_row",
      `No stored Yahoo credential for account_key='${accountKey}'.`,
      404,
      "Authorize once in a browser: GET /admin/yahoo/auth/start?APIKEY=…"
    );
  }
  if (row.revoked_at_utc) {
    throw new YahooRefusal(
      "yahoo_token_revoked",
      `The stored Yahoo credential for account_key='${accountKey}' is marked revoked (${safeStr(row.revoked_at_utc)}). REFUSING to use it.`,
      403,
      "Re-authorize: GET /admin/yahoo/auth/start?APIKEY=… (re-consent clears the revoked flag)."
    );
  }

  const storedRefresh = await decryptSecret(env, row.refresh_token_ciphertext, row.token_iv);
  if (!storedRefresh) {
    throw new YahooRefusal(
      "yahoo_stored_refresh_token_empty",
      "The stored ciphertext decrypted to an empty string. REFUSING — an empty credential is a corrupt row, not a valid token.",
      500,
      "Re-authorize: GET /admin/yahoo/auth/start?APIKEY=…"
    );
  }

  // redirect_uri on a refresh grant: send the env value when set, omit it when
  // not. There is no column to store the consent-time value on the token row, so
  // this is the only source — and an edited YAHOO_REDIRECT_URI is one of Yahoo's
  // two documented silent-401 causes (see yahoo_auth_rejected's remedy).
  const form = { grant_type: "refresh_token", refresh_token: storedRefresh };
  const envRedirect = safeStr(env && env.YAHOO_REDIRECT_URI);
  if (envRedirect) form.redirect_uri = envRedirect;

  let data;
  try {
    data = await postToken(env, form);
  } catch (e) {
    const isAuth = e instanceof YahooRefusal && e.error_code === "yahoo_auth_rejected";
    try {
      await db.prepare(
        `UPDATE fantasy_oauth_tokens
            SET last_refresh_status   = ?,
                refresh_failure_count = refresh_failure_count + 1,
                revoked_at_utc        = CASE WHEN ? = 1 THEN COALESCE(revoked_at_utc, datetime('now')) ELSE revoked_at_utc END
          WHERE platform = ? AND account_key = ?`
      ).bind(isAuth ? "invalid_grant" : "error", isAuth ? 1 : 0, PLATFORM, accountKey).run();
    } catch (e2) {
      logWarn(`could not record the refresh failure (the refusal still stands): ${e2 && e2.message}`);
    }
    throw e;
  }

  // Persist the (possibly rotated) refresh token BEFORE the access token is
  // handed out. Yahoo usually returns the same string; a rotation we drop is
  // permanent loss, so a returned value always wins.
  const returnedRefresh = safeStr(data.refresh_token);
  const grantedScope = safeStr(data.scope) || null;
  try {
    if (returnedRefresh) {
      const enc = await encryptSecret(env, returnedRefresh); // FRESH IV every write
      await db.prepare(
        `UPDATE fantasy_oauth_tokens
            SET refresh_token_ciphertext = ?, token_iv = ?, key_version = ?,
                scope = COALESCE(?, scope),
                last_refreshed_at_utc = datetime('now'),
                last_refresh_status = 'ok', refresh_failure_count = 0
          WHERE platform = ? AND account_key = ?`
      ).bind(enc.ciphertext, enc.iv, KEY_VERSION, grantedScope, PLATFORM, accountKey).run();
    } else {
      // Yahoo omitted it, so the stored one is still current — record the
      // successful refresh without touching the ciphertext.
      await db.prepare(
        `UPDATE fantasy_oauth_tokens
            SET last_refreshed_at_utc = datetime('now'),
                last_refresh_status = 'ok', refresh_failure_count = 0,
                scope = COALESCE(?, scope)
          WHERE platform = ? AND account_key = ?`
      ).bind(grantedScope, PLATFORM, accountKey).run();
    }
  } catch (e) {
    logError(`refresh-token persist failed: ${e && e.message}`);
    throw new YahooRefusal(
      "yahoo_rotated_token_persist_failed",
      "Yahoo issued a token but it could not be persisted. REFUSING to hand out an access token — if Yahoo rotated the refresh token it has already revoked the stored one, and reporting success here would hide a permanent loss of access.",
      500,
      "Check D1 health, then re-authorize: GET /admin/yahoo/auth/start?APIKEY=…"
    );
  }

  const expiresAt = expiresAtUnixFrom(data);
  logInfo(`token minted account=${accountKey} expires_in=${expiresAt - nowUnix()}s rotated=${returnedRefresh ? "yes" : "no"}`);

  // ⚠️ The one credential-bearing response in this module (see
  // jsonOutWithCredential). The refresh token is NEVER included.
  return jsonOutWithCredential(200, {
    ok: true,
    platform: PLATFORM,
    account_key: accountKey,
    token_type: "bearer",
    access_token: data.access_token,
    expires_in: expiresAt - nowUnix(),
    expires_at_unix: expiresAt,
    // Start refreshing this early so a long request cannot begin on a token
    // that expires mid-flight.
    refresh_after_unix: expiresAt - EXPIRY_SKEW_SEC,
    scope: grantedScope,          // NULL = Yahoo did not say
    refresh_token_rotated: !!returnedRefresh,
  }, corsHeaders);
}

// ─────────────────────────────────────────────────────────────────────────────
// Route: GET /admin/yahoo/status
// NAMES AND BOOLEANS ONLY — never a value. Not gated on YAHOO_SYNC_ENABLED:
// diagnostics that only work when the feature is armed are useless during a
// dark launch, which is exactly when you need them.
// ─────────────────────────────────────────────────────────────────────────────
async function routeStatus(url, env, corsHeaders) {
  const accountKey = readAccountKey(url);

  const present = (k) => safeStr(env && env[k]).length > 0;
  // Length validity is reported WITHOUT reporting the key. "32 bytes: yes/no"
  // is diagnostic; the bytes are not.
  let keyLengthOk = false;
  let keyProblem = null;
  try {
    decodeEncryptionKeyBytes(env);
    keyLengthOk = true;
  } catch (e) {
    keyProblem = e instanceof YahooRefusal ? e.error_code : "yahoo_encryption_key_unknown_fault";
  }

  const writeEnabled = await getFeatureFlag(env, FLAG_KEY);

  const body = {
    ok: true,
    platform: PLATFORM,
    account_key: accountKey,
    write_enabled: writeEnabled,                 // YAHOO_SYNC_ENABLED (D1 override wins)
    write_flag_key: FLAG_KEY,
    env_present: {                                // presence only — never values
      YAHOO_CLIENT_ID: present("YAHOO_CLIENT_ID"),
      YAHOO_CLIENT_SECRET: present("YAHOO_CLIENT_SECRET"),
      YAHOO_REDIRECT_URI: present("YAHOO_REDIRECT_URI"),
      YAHOO_TOKEN_ENCRYPTION_KEY: present("YAHOO_TOKEN_ENCRYPTION_KEY"),
      COMMISH_API_KEY: present("COMMISH_API_KEY"),
    },
    encryption_key_usable: keyLengthOk,
    encryption_key_problem: keyProblem,          // NULL = no problem found
    scope_requested: SCOPE_READ_ONLY,
    authorize_url_host: new URL(AUTHORIZE_URL).host,
    token_url_host: new URL(TOKEN_URL).host,
  };

  if (!env || !env.UPS_MFL_DB) {
    throw new YahooRefusal(
      "d1_binding_missing",
      "UPS_MFL_DB binding is missing, so token status is UNKNOWN. REFUSING to report 'no token stored'.",
      500,
      "Check the [[d1_databases]] binding in wrangler.toml."
    );
  }

  let row;
  let openStates = null;
  try {
    row = await env.UPS_MFL_DB.prepare(
      `SELECT key_version, scope, yahoo_guid, obtained_at_utc, last_refreshed_at_utc,
              last_refresh_status, refresh_failure_count, revoked_at_utc
         FROM fantasy_oauth_tokens WHERE platform = ? AND account_key = ?`
    ).bind(PLATFORM, accountKey).first();
    const st = await env.UPS_MFL_DB.prepare(
      `SELECT COUNT(*) AS n FROM fantasy_oauth_states
        WHERE platform = ? AND account_key = ? AND consumed_at_utc IS NULL AND expires_at_unix > ?`
    ).bind(PLATFORM, accountKey, nowUnix()).first();
    openStates = Number(st && st.n ? st.n : 0);
  } catch (e) {
    // NO FAIL-OPEN: "we could not read the row" must never render as
    // token_row_present:false. That misreport is how an operator concludes a
    // credential is gone and re-authorizes over a perfectly good one.
    logError(`status read failed: ${e && e.message}`);
    throw new YahooRefusal(
      "yahoo_status_read_failed",
      "Could not read fantasy_oauth_tokens / fantasy_oauth_states. REFUSING — this is NOT the same as 'no token is stored'.",
      503,
      "Retry once D1 is healthy. If the tables do not exist, apply migration 0127 with `wrangler d1 execute ups-mfl-db --remote --file=migrations/0127_fantasy_control_and_raw.sql`."
    );
  }

  body.token_row_present = !!row;
  body.open_state_count = openStates;
  if (row) {
    body.token = {
      key_version: Number(row.key_version),
      scope_present: !!safeStr(row.scope),
      yahoo_guid_present: !!safeStr(row.yahoo_guid),
      // Timestamps and status strings are operational facts, not credential
      // material — "is my token stale" is unanswerable without them.
      obtained_at_utc: row.obtained_at_utc || null,
      last_refreshed_at_utc: row.last_refreshed_at_utc || null,
      last_refresh_status: row.last_refresh_status || null,   // NULL = never refreshed
      refresh_failure_count: Number(row.refresh_failure_count || 0),
      revoked: !!row.revoked_at_utc,
      revoked_at_utc: row.revoked_at_utc || null,
    };
  }
  return jsonOut(200, body, corsHeaders);
}

// ─────────────────────────────────────────────────────────────────────────────
// Route: POST /admin/yahoo/revoke
//
// ⚠️ YAHOO HAS NO PROGRAMMATIC REVOCATION ENDPOINT. Revocation is user-initiated
// from Yahoo account settings. This marks the LOCAL row and returns instructions
// rather than calling an API that does not exist — reporting "revoked" while the
// grant is still live at Yahoo would be worse than saying nothing.
//
// The row is marked, never deleted (0127: "a revoked row is kept, not deleted"),
// so the audit trail of who authorized what survives.
// ─────────────────────────────────────────────────────────────────────────────
const REVOCATION_INSTRUCTIONS = [
  "Yahoo provides NO API to revoke an OAuth token — this call marked the LOCAL row only.",
  "The grant is still live at Yahoo until you revoke it yourself:",
  "  1. https://login.yahoo.com/account/security  ->  'Apps connected to your account'",
  "  2. Remove the Fantasy app you registered for this pipeline.",
  "Changing your Yahoo password also revokes every refresh token.",
  "The encrypted row is kept (not deleted) as an audit record; re-authorizing via",
  "/admin/yahoo/auth/start overwrites it and clears the revoked flag.",
].join("\n");

async function routeRevoke(url, env, corsHeaders) {
  await assertWritesEnabled(env);
  const db = requireDb(env);
  const accountKey = readAccountKey(url);

  let result;
  try {
    result = await db.prepare(
      `UPDATE fantasy_oauth_tokens
          SET revoked_at_utc = COALESCE(revoked_at_utc, datetime('now'))
        WHERE platform = ? AND account_key = ?`
    ).bind(PLATFORM, accountKey).run();
  } catch (e) {
    logError(`revoke update failed: ${e && e.message}`);
    throw new YahooRefusal(
      "yahoo_revoke_failed",
      "Could not mark the stored credential revoked. REFUSING to report success.",
      500,
      "Retry once D1 is healthy. Revoke at Yahoo regardless: https://login.yahoo.com/account/security"
    );
  }
  // last_refresh_status is deliberately untouched: its vocabulary is
  // 'ok'|'invalid_grant'|'error' (0127) and inventing a fourth value here would
  // corrupt a closed enum for every reader. revoked_at_utc already says it.

  const changed = Number(result && result.meta && result.meta.changes ? result.meta.changes : 0);
  if (!changed) {
    return jsonOut(404, {
      ok: false,
      error_code: "yahoo_no_token_row",
      error: `No stored Yahoo credential for account_key='${accountKey}' — nothing to mark revoked locally.`,
      instructions: REVOCATION_INSTRUCTIONS,
    }, corsHeaders);
  }

  // Kill any authorization still in flight so a consent screen opened before the
  // revocation cannot land a fresh token afterwards.
  let statesClosed = 0;
  try {
    const r = await db.prepare(
      `UPDATE fantasy_oauth_states SET consumed_at_utc = datetime('now')
        WHERE platform = ? AND account_key = ? AND consumed_at_utc IS NULL`
    ).bind(PLATFORM, accountKey).run();
    statesClosed = Number(r && r.meta && r.meta.changes ? r.meta.changes : 0);
  } catch (e) {
    logWarn(`could not close in-flight states during revoke: ${e && e.message}`);
  }

  logInfo(`revoke account=${accountKey} local_row_marked=1 states_closed=${statesClosed}`);
  return jsonOut(200, {
    ok: true,
    platform: PLATFORM,
    account_key: accountKey,
    local_row_marked_revoked: true,
    in_flight_states_closed: statesClosed,
    yahoo_side_revoked: false,   // we cannot do this, and we do not claim to
    instructions: REVOCATION_INSTRUCTIONS,
  }, corsHeaders);
}

// ─────────────────────────────────────────────────────────────────────────────
// Dispatcher. Returns a Response for anything under /admin/yahoo/, null
// otherwise so index.js's main chain continues (same contract as hall.js).
//
// A matching path with the wrong METHOD gets a 405 rather than null: falling
// through would surface as a confusing 404 from the main dispatcher.
// ─────────────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
// Exported for testing.
//
// These are PURE helpers (no fetch, no D1, no Discord) in the spirit of
// worker/src/lib/waiver_run_post.js. They are exported so tests/ can import and
// exercise the code that SHIPS rather than a re-implementation — the rule
// stated verbatim at tests/lineup_parser_test.js:5-8.
//
// ⚠️ Crypto and redaction are the two things here worth failing loudly, so they
// are the two things a test must be able to reach: an AES-GCM round trip that
// silently degraded, or a redactor that stopped matching, would both look
// exactly like working code from the outside.
export const __testables = {
  redactText, redactUrl, redactHeaders, safeStr,
  bytesToB64, bytesToB64Url, b64ToBytes, randomBytes,
  decodeEncryptionKeyBytes, importEncryptionKey, encryptSecret, decryptSecret,
  basicAuthHeader, readClientCredentials, readRedirectUri, expiresAtUnixFrom,
};

export async function handleYahooRequest(request, env, corsHeaders) {
  let url;
  try {
    url = new URL(request.url);
  } catch (_) {
    return null;
  }
  const path = url.pathname || "/";
  // The bare "/admin/yahoo" (no trailing slash) is claimed too, so an operator
  // who trims the path gets this module's route list instead of a generic 404
  // from the main dispatcher.
  if (!path.startsWith(ROUTE_PREFIX) && path !== "/admin/yahoo") return null;

  const cors = corsHeaders || {};
  const method = String(request.method || "GET").toUpperCase();

  try {
    assertCommish(url, env);

    if (path === "/admin/yahoo/auth/start") {
      if (method !== "GET") throw new YahooRefusal("method_not_allowed", "GET only.", 405, "Open this URL in a browser.");
      return await routeAuthStart(url, env, cors);
    }
    if (path === "/admin/yahoo/auth/callback") {
      if (method !== "GET") throw new YahooRefusal("method_not_allowed", "GET only — Yahoo redirects the browser here.", 405, "");
      return await routeAuthCallback(url, env, cors);
    }
    if (path === "/admin/yahoo/token") {
      if (method !== "POST") throw new YahooRefusal("method_not_allowed", "POST only.", 405, "curl -X POST 'https://<worker>/admin/yahoo/token?APIKEY=…'");
      return await routeToken(url, env, cors);
    }
    if (path === "/admin/yahoo/status") {
      if (method !== "GET") throw new YahooRefusal("method_not_allowed", "GET only.", 405, "");
      return await routeStatus(url, env, cors);
    }
    if (path === "/admin/yahoo/revoke") {
      if (method !== "POST") throw new YahooRefusal("method_not_allowed", "POST only.", 405, "curl -X POST 'https://<worker>/admin/yahoo/revoke?APIKEY=…'");
      return await routeRevoke(url, env, cors);
    }

    // This module owns the whole /admin/yahoo/ prefix, so an unknown subpath is
    // a 404 from here rather than a fall-through.
    return jsonOut(404, {
      ok: false,
      error_code: "yahoo_unknown_route",
      error: `No such Yahoo OAuth route: ${path}`,
      routes: [
        "GET  /admin/yahoo/auth/start",
        "GET  /admin/yahoo/auth/callback",
        "POST /admin/yahoo/token",
        "GET  /admin/yahoo/status",
        "POST /admin/yahoo/revoke",
      ],
    }, cors);
  } catch (e) {
    if (!(e instanceof YahooRefusal)) {
      // Redacted before it is emitted, always — an exception message can carry a
      // provider body, and a provider body can carry a token.
      logError(`unhandled ${method} ${redactUrl(request.url)}: ${e && e.stack ? e.stack : e}`);
    } else {
      logWarn(`${e.error_code} on ${method} ${redactUrl(request.url)}`);
    }
    return refusalOut(e, cors);
  }
}
