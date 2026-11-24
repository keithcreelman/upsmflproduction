// UPS environment guard (#1475): the rules that keep a TEST deployment of this worker
// from touching the production league, its records, its credentials or its channels.
//
// This file is pure policy: no I/O at import time, no globals touched. entry.js applies it.
//
//   UPS_ENV = "production"  -> the worker runs exactly as before (entry.js passes straight through).
//   UPS_ENV = "test"        -> every request and every outbound call is checked against this file.
//   anything else / unset   -> the worker refuses every request and every scheduled run (fail closed).
//
// The production league id is a constant here on purpose: it is the one value a test deployment
// must never be configured, asked or tricked into using.

export const PRODUCTION_LEAGUE_ID = "74598";
export const GUARD_VERSION = "2";

// A league id appearing as a standalone number anywhere in a URL, query or body.
// (Digits on both sides would make it part of a longer number, e.g. a timestamp.)
const PROD_TOKEN_RE = new RegExp(`(^|[^0-9])${PRODUCTION_LEAGUE_ID}([^0-9]|$)`);

// Field names that carry a league id in this worker's routes (query, JSON body, form body)
// and in MFL's own forms. Matched case-insensitively against every key at every depth.
const LEAGUE_KEY_RE = /^(l|league|leagues|league_?id|league_?ids|mfl_?league(_?id)?|target_?league(_?id)?|source_?league(_?id)?|test_?league(_?id)?|prod_?league(_?id)?)$/i;

// Credentials that belong to production. A test deployment that holds any of these is
// misconfigured and refuses to run: no fallback from a test secret to a production one.
// Test deployments hold their own secrets under the names in TEST_SECRET_MAP instead.
export const FORBIDDEN_TEST_SECRETS = [
  "MFL_COOKIE", "MFL_APIKEY", "COMMISH_API_KEY", "TEST_SYNC_API_KEY", "UPS_ADMIN_KEY", "BETA_SESSION_KEY",
  "GITHUB_PAT", "DISCORD_BOT_TOKEN", "DISCORD_BOT", "Discord_bot", "DISCORD_CONTRACT_BOT_TOKEN",
  "DISCORD_PUBLIC_KEY", "ANTHROPIC_API_KEY", "GIPHY_API_KEY", "ROAST_TRACK_API_KEY", "MCM_SALT", "HALL_IP_SALT",
];

// test secret name -> the name the worker code reads. The worker code is unchanged; in a test
// deployment it simply sees the test account's values under the names it already uses.
export const TEST_SECRET_MAP = {
  MFLTEST_COMMISHCOOKIE: "MFL_COOKIE",
  MFLTEST_APIKEY: "MFL_APIKEY",
  TEST_ADMIN_API_KEY: "COMMISH_API_KEY",
};

// Non-string bindings a test deployment may hold. Everything else (R2, KV, queues, Durable
// Objects, analytics, service bindings such as SELF) is refused: the production config binds
// SELF to the production worker and R2 to the production backup bucket.
const ALLOWED_FETCHER_BINDINGS = new Set(["FPA_STORE"]);   // static assets shipped with the worker; read-only

const s = (v) => (v == null ? "" : String(v));

// ---------------------------------------------------------------------------------------------
// Environment resolution
// ---------------------------------------------------------------------------------------------

export function resolveUpsEnv(env) {
  const v = env && typeof env.UPS_ENV === "string" ? env.UPS_ENV : "";
  if (v === "production" || v === "test") return v;   // exact match only: " test", "TEST", "prod" are unknown
  return null;
}

// The validated configuration of a test deployment, or the list of reasons it is not one.
export function testConfig(env) {
  const errors = [];
  if (resolveUpsEnv(env) !== "test") errors.push("UPS_ENV is not \"test\"");
  const league = s(env && env.LEAGUE_ID);
  if (!/^\d{4,6}$/.test(league)) errors.push("LEAGUE_ID missing or not a league id");
  if (league === PRODUCTION_LEAGUE_ID) errors.push("LEAGUE_ID is the production league");
  const writeLeagues = s(env && env.WRITE_LEAGUES).split(",").map((x) => x.trim()).filter(Boolean);
  if (writeLeagues.length !== 1) errors.push("WRITE_LEAGUES must name exactly one test league");
  if (writeLeagues.includes(PRODUCTION_LEAGUE_ID)) errors.push("WRITE_LEAGUES names the production league");
  if (writeLeagues.length === 1 && writeLeagues[0] !== league) errors.push("WRITE_LEAGUES and LEAGUE_ID disagree");
  for (const name of FORBIDDEN_TEST_SECRETS) {
    if (env && env[name] != null && s(env[name]) !== "") errors.push(`production credential name present: ${name}`);
  }
  if (!s(env && env.MFLTEST_COMMISHCOOKIE)) errors.push("MFLTEST_COMMISHCOOKIE (test commissioner session) missing");
  if (!s(env && env.TEST_ADMIN_API_KEY)) errors.push("TEST_ADMIN_API_KEY missing");
  const webhook = s(env && env.TEST_DISCORD_WEBHOOK_URL);
  if (webhook && !/^https:\/\/(discord\.com|discordapp\.com)\/api\/webhooks\/\d+\/[\w-]+$/.test(webhook)) {
    errors.push("TEST_DISCORD_WEBHOOK_URL is not a Discord webhook URL");
  }
  const testChannel = s(env && env.TEST_DISCORD_CHANNEL_ID);
  if (testChannel && !/^\d{15,22}$/.test(testChannel)) errors.push("TEST_DISCORD_CHANNEL_ID is not a channel id");
  return {
    ok: errors.length === 0,
    errors,
    league,
    writeLeagues,
    testWebhookUrl: webhook,
    testChannelId: testChannel,
    season: /^\d{4}$/.test(s(env && env.YEAR)) ? s(env.YEAR) : String(new Date().getUTCFullYear()),
  };
}

// ---------------------------------------------------------------------------------------------
// Bindings
// ---------------------------------------------------------------------------------------------

export function classifyBinding(v) {
  if (v == null) return "unset";
  if (typeof v === "string") return "var";
  if (typeof v !== "object" && typeof v !== "function") return "var";
  const has = (k) => { try { return typeof v[k] === "function"; } catch (_) { return false; } };
  // On the Workers runtime a Fetcher (service binding, static assets) is an RPC stub: ANY property name reads as a
  // function, so duck typing would call it a D1 database (seen on the first deploy, 2026-11-24). Detect stubs first
  // with a member no real binding has; a stub is a fetcher only when the runtime tags it as one, else it is refused.
  if (has("__ups_probe_no_such_member__")) {
    let tag = "";
    try { tag = Object.prototype.toString.call(v); } catch (_) { tag = ""; }
    return tag === "[object Fetcher]" ? "fetcher" : "rpc_stub";
  }
  if (has("prepare") && has("batch") && has("exec")) return "d1";
  if (has("put") && has("get") && has("list") && has("head") && has("createMultipartUpload")) return "r2";
  if (has("get") && has("put") && has("list") && has("getWithMetadata")) return "kv";
  if (has("send") && has("sendBatch")) return "queue";
  if (has("idFromName") || has("idFromString")) return "durable_object";
  if (has("writeDataPoint")) return "analytics";
  if (has("fetch")) return "fetcher";
  return "unknown";
}

export function inspectBindings(env) {
  const out = { ok: true, problems: [], d1: [], bindings: {} };
  for (const name of Object.keys(env || {})) {
    const kind = classifyBinding(env[name]);
    if (kind === "var" || kind === "unset") continue;
    out.bindings[name] = kind;
    if (kind === "d1") { out.d1.push(name); continue; }
    if (kind === "fetcher" && ALLOWED_FETCHER_BINDINGS.has(name)) continue;
    out.ok = false;
    out.problems.push(`${name}: ${kind} binding is not allowed in a test deployment`);
  }
  if (!out.d1.length) { out.ok = false; out.problems.push("no D1 binding (a test deployment needs its own test database)"); }
  return out;
}

// The marker row that proves a D1 binding is the TEST database. It is created only by
// worker/test_env/ups_test_db_setup.sql, run by hand against the test database. No migration
// creates it (a test enforces that), so the production database can never carry it.
export const MARKER_SQL = "SELECT env, league_id FROM ups_env_marker";
export function markerVerdict(rows, league) {
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) return { ok: false, reason: "marker_missing" };
  for (const r of list) {
    if (s(r && r.env) !== "test") return { ok: false, reason: "marker_not_test" };
    if (s(r && r.league_id) !== league) return { ok: false, reason: "marker_league_mismatch" };
  }
  return { ok: true };
}

// The env object the worker code sees in a test deployment: test secrets under the names the
// code already reads, every Discord channel pointed at the test channel, GitHub/Discord/AI tokens
// emptied, and the league pinned.
export function deriveTestEnv(env, cfg) {
  const out = { ...env };
  for (const [testName, codeName] of Object.entries(TEST_SECRET_MAP)) out[codeName] = s(env[testName]);
  for (const name of FORBIDDEN_TEST_SECRETS) if (!(name in TEST_SECRET_MAP) && !Object.values(TEST_SECRET_MAP).includes(name)) out[name] = "";
  for (const k of Object.keys(out)) {
    if (/CHANNEL_ID$/.test(k) && typeof out[k] === "string") out[k] = cfg.testChannelId || "";
  }
  out.LEAGUE_ID = cfg.league;
  out.UPS_LEAGUE_ID = cfg.league;
  out.DROP_TRACKER_DISCORD_TARGET = "test";
  out.ADD_TRACKER_DISCORD_TARGET = "test";
  out.DISCORD_CONTRACT_USE_TEST = "1";
  out.AUCTION_DISCORD_USE_TEST = "1";
  out.TRADE_OFFERS_PUBLIC_WRITES_ENABLED = "0";
  out.BUG_REPORT_PUBLIC_WRITES_ENABLED = "0";
  out.__UPS_ENV_GUARD = "test";
  return out;
}

// ---------------------------------------------------------------------------------------------
// Inbound requests
// ---------------------------------------------------------------------------------------------

export const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
export function isWriteMethod(method) { return !SAFE_METHODS.has(s(method).toUpperCase()); }

function safeDecode(x) { try { return decodeURIComponent(x.replace(/\+/g, " ")); } catch (_) { return x; } }

// Every league value a JSON value carries under a league-ish key, at any depth.
export function leagueClaimsInJson(value, out = [], depth = 0) {
  if (depth > 20 || value == null) return out;
  if (Array.isArray(value)) { for (const v of value) leagueClaimsInJson(v, out, depth + 1); return out; }
  if (typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      if (LEAGUE_KEY_RE.test(k)) {
        if (v != null && typeof v !== "object") out.push(s(v));
        else if (Array.isArray(v)) for (const x of v) if (x != null && typeof x !== "object") out.push(s(x));
      }
      if (v && typeof v === "object") leagueClaimsInJson(v, out, depth + 1);
      else if (typeof v === "string" && /[=&]/.test(v) && /(^|[?&])l(eague(_?id)?)?=/i.test(v)) out.push(...leagueClaimsInForm(v.replace(/^[^?]*\?/, "")));
    }
  }
  return out;
}

export function leagueClaimsInForm(text) {
  const out = [];
  for (const part of s(text).split("&")) {
    const i = part.indexOf("=");
    const k = safeDecode(i < 0 ? part : part.slice(0, i));
    if (LEAGUE_KEY_RE.test(k)) out.push(safeDecode(i < 0 ? "" : part.slice(i + 1)));
  }
  return out;
}

// Split comma lists ("25625,74598") so a list can't smuggle a second league.
function flattenClaims(claims) {
  const out = [];
  for (const c of claims) for (const x of s(c).split(/[,\s|;]+/)) if (x !== "") out.push(x.trim());
  return out;
}

export function leagueClaimsInBody(text, contentType) {
  const t = s(text);
  if (!t.trim()) return [];
  const ct = s(contentType).toLowerCase();
  const trimmed = t.trim();
  if (ct.includes("json") || trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try { return leagueClaimsInJson(JSON.parse(trimmed)); } catch (_) { /* not JSON: fall through to form parsing */ }
  }
  if (ct.includes("multipart/form-data")) {
    const out = [];
    const re = /name="([^"]+)"\r?\n(?:[^\r\n]+\r?\n)*\r?\n([^\r\n]*)/g;
    for (const m of t.matchAll(re)) if (LEAGUE_KEY_RE.test(m[1])) out.push(m[2]);
    return out;
  }
  return leagueClaimsInForm(t);
}

// The decision for one inbound request to a test deployment. Pure: the caller supplies the
// body text it read. Returns the URL the worker should see (league pinned) when allowed.
export function inboundDecision({ url, method, bodyText, contentType }, cfg) {
  const u = new URL(url);
  const rawQuery = s(u.search);
  const decodedQuery = safeDecode(rawQuery);
  const decodedPath = safeDecode(u.pathname);
  const body = s(bodyText);
  if (PROD_TOKEN_RE.test(decodedPath) || PROD_TOKEN_RE.test(decodedQuery) || PROD_TOKEN_RE.test(rawQuery) ||
      PROD_TOKEN_RE.test(body) || PROD_TOKEN_RE.test(safeDecode(body))) {
    return { ok: false, status: 403, error: "production_league_refused", detail: `this is a test deployment; requests naming league ${PRODUCTION_LEAGUE_ID} are refused` };
  }
  const claims = flattenClaims([
    ...[...u.searchParams.entries()].filter(([k]) => LEAGUE_KEY_RE.test(k)).map(([, v]) => v),
    ...leagueClaimsInBody(body, contentType),
  ]);
  const distinct = [...new Set(claims)];
  const foreign = distinct.filter((c) => !cfg.writeLeagues.includes(c));
  if (foreign.length) {
    return { ok: false, status: 403, error: distinct.length > 1 ? "conflicting_league_values" : "league_not_allowlisted",
      detail: `only league ${cfg.league} is served by this test deployment`, claims: distinct };
  }
  // The client's L never chooses the league: it is pinned to the test league whether the client
  // sent it, sent it in another case, or left it out (routes that default to the production id
  // when L is absent now see the test league instead).
  const pinned = new URL(u);
  for (const k of [...pinned.searchParams.keys()]) if (LEAGUE_KEY_RE.test(k) && k !== "L") pinned.searchParams.delete(k);
  pinned.searchParams.set("L", cfg.league);
  return { ok: true, url: pinned.toString(), claims: distinct, write: isWriteMethod(method) };
}

// ---------------------------------------------------------------------------------------------
// Outbound calls (applied to the global fetch in a test deployment)
// ---------------------------------------------------------------------------------------------

const MFL_HOST_RE = /(^|\.)myfantasyleague\.com$/i;
const DISCORD_HOST_RE = /(^|\.)(discord\.com|discordapp\.com|discord\.gg|discordapp\.net)$/i;
const WORKER_HOST_RE = /(^|\.)(workers\.dev|pages\.dev)$/i;
const SECRET_PARAM_RE = /^(apikey|api_key|mfl_user_id|token|key|password|pass|cookie|session|secret)$/i;

export function redactUrl(url) {
  try {
    const u = new URL(url);
    for (const k of [...u.searchParams.keys()]) if (SECRET_PARAM_RE.test(k)) u.searchParams.set(k, "[redacted]");
    if (DISCORD_HOST_RE.test(u.hostname) && /\/webhooks\//.test(u.pathname)) u.pathname = u.pathname.replace(/(\/webhooks\/\d+\/).+$/, "$1[redacted]");
    return u.toString();
  } catch (_) { return "[unparseable url]"; }
}

export function isMflWrite(u, method) {
  return isWriteMethod(method) || /\/import(\/|$)/i.test(u.pathname);
}

// bodyText: the request body as text, or null when it could not be read (a stream, a file).
export function egressDecision({ url, method, bodyText }, cfg) {
  let u;
  try { u = new URL(s(url)); } catch (_) { return { allow: false, reason: "unparseable_url" }; }
  const m = s(method || "GET").toUpperCase();
  const body = bodyText == null ? null : s(bodyText);
  const host = u.hostname.toLowerCase();
  if (PROD_TOKEN_RE.test(safeDecode(u.pathname)) || PROD_TOKEN_RE.test(safeDecode(u.search)) ||
      (body != null && (PROD_TOKEN_RE.test(body) || PROD_TOKEN_RE.test(safeDecode(body))))) {
    return { allow: false, reason: "production_league_named", host };
  }
  if (WORKER_HOST_RE.test(host)) return { allow: false, reason: "worker_or_pages_host_refused", host };
  if (DISCORD_HOST_RE.test(host)) {
    if (cfg.testWebhookUrl && m === "POST" && s(url).split("?")[0] === cfg.testWebhookUrl) return { allow: true, kind: "test_webhook", host };
    return { allow: false, reason: "discord_refused", host };
  }
  if (MFL_HOST_RE.test(host)) {
    const write = isMflWrite(u, m);
    if (write && body == null && isWriteMethod(m)) return { allow: false, reason: "mfl_write_body_not_inspectable", host };
    const claims = flattenClaims([
      ...[...u.searchParams.entries()].filter(([k]) => LEAGUE_KEY_RE.test(k)).map(([, v]) => v),
      ...(body ? leagueClaimsInBody(body, "") : []),
      ...[...safeDecode(u.pathname).matchAll(/\/home\/(\d+)/gi)].map((x) => x[1]),   // MFL page URLs: /2026/home/<league>
    ]);
    const distinct = [...new Set(claims)];
    if (distinct.some((c) => !cfg.writeLeagues.includes(c))) return { allow: false, reason: "mfl_league_not_allowlisted", host, claims: distinct };
    if (write && !distinct.length) return { allow: false, reason: "mfl_write_without_league", host };
    return { allow: true, kind: write ? "mfl_write" : "mfl_read", host, claims: distinct };
  }
  if (isWriteMethod(m)) return { allow: false, reason: "write_to_unlisted_host", host };
  return { allow: true, kind: "read", host };
}

// Body of a fetch() call as text, or null when it can't be read without consuming it.
export async function bodyTextOf(input, init) {
  const b = init && Object.prototype.hasOwnProperty.call(init, "body") ? init.body : undefined;
  if (b === undefined || b === null) {
    if (typeof Request !== "undefined" && input instanceof Request && input.body) {
      try { return await input.clone().text(); } catch (_) { return null; }
    }
    return "";
  }
  if (typeof b === "string") return b;
  if (typeof URLSearchParams !== "undefined" && b instanceof URLSearchParams) return b.toString();
  if (typeof FormData !== "undefined" && b instanceof FormData) {
    const parts = [];
    for (const [k, v] of b.entries()) { if (typeof v !== "string") return null; parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(v)}`); }
    return parts.join("&");
  }
  if (b instanceof ArrayBuffer) return new TextDecoder().decode(b);
  if (ArrayBuffer.isView(b)) return new TextDecoder().decode(b);
  if (typeof Blob !== "undefined" && b instanceof Blob) { try { return await b.text(); } catch (_) { return null; } }
  return null;   // ReadableStream and anything else: not inspectable
}

// ---------------------------------------------------------------------------------------------
// Owner / commissioner credentials
// ---------------------------------------------------------------------------------------------

// MFL_USER_ID values a request carries (cookie header, ?MFL_USER_ID=, JSON body field).
export function viewerCredentials(request, url, bodyText) {
  const out = [];
  const cookie = s(request.headers.get("Cookie"));
  const m = /(?:^|;\s*)MFL_USER_ID=([^;]+)/i.exec(cookie);
  if (m) out.push(m[1].trim());
  const q = s(new URL(url).searchParams.get("MFL_USER_ID")).trim();
  if (q) out.push(q);
  try {
    const j = JSON.parse(s(bodyText));
    for (const k of ["mfl_user_id", "MFL_USER_ID", "mflUserId"]) if (j && typeof j[k] === "string" && j[k].trim()) out.push(j[k].trim());
  } catch (_) { /* not JSON */ }
  return [...new Set(out)];
}

// The leagues an MFL `myleagues` export lists.
export function leaguesFromMyleagues(json) {
  const root = json && (json.leagues || json.myleagues);
  let list = root && root.league;
  if (!list) return null;
  if (!Array.isArray(list)) list = [list];
  return list.map((x) => s(x && (x.league_id || x.id)));
}

export function credentialVerdict(leagues, cfg) {
  if (!Array.isArray(leagues)) return { ok: false, reason: "credential_unverified" };
  if (leagues.includes(PRODUCTION_LEAGUE_ID)) return { ok: false, reason: "credential_is_production_member" };
  if (!leagues.includes(cfg.league)) return { ok: false, reason: "credential_not_in_test_league" };
  return { ok: true };
}

// ---------------------------------------------------------------------------------------------
// Edge cache namespace
// ---------------------------------------------------------------------------------------------

// caches.default is shared by every worker on keith-creelman.workers.dev and this worker's cache
// keys use fixed fake hosts, so a test deployment would read and write production's entries.
// Every key a test deployment uses is moved under its own host prefix.
export function namespacedCacheKey(key, prefix) {
  const raw = typeof Request !== "undefined" && key instanceof Request ? key.url : s(key);
  const u = new URL(raw);
  if (!u.hostname.startsWith(prefix + ".")) u.hostname = `${prefix}.${u.hostname}`;
  if (typeof Request !== "undefined" && key instanceof Request) return new Request(u.toString(), key);
  return u.toString();
}

// ---------------------------------------------------------------------------------------------
// Operation identity (review fix 1): the same write must not reach MFL twice while its outcome
// is unknown, whatever idempotency key it is sent under.
// ---------------------------------------------------------------------------------------------

// Fields that change between two sends of the same intent and so must not change its identity.
const VOLATILE_KEY_RE = /^(_|t|ts|cb|nonce|timestamp|client_ts|clientts|request_id|requestid|cache_bust|cachebust|dry_run_token)$/i;

export function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value === "object") {
    const out = {};
    for (const k of Object.keys(value).sort()) if (!VOLATILE_KEY_RE.test(k)) out[k] = canonicalJson(value[k]);
    return out;
  }
  return value == null ? null : String(value);
}

function sortedPairs(entries) {
  return entries.filter(([k]) => !VOLATILE_KEY_RE.test(k) && !SECRET_PARAM_RE.test(k)).map(([k, v]) => [k, s(v)])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
}

function formEntries(text) {
  return s(text).split("&").filter(Boolean).map((part) => { const i = part.indexOf("="); return [safeDecode(i < 0 ? part : part.slice(0, i)), safeDecode(i < 0 ? "" : part.slice(i + 1))]; });
}

// The identity of an inbound write: method, path, query and body (key order and volatile fields
// ignored) and who sent it (hashes of the forwarded sessions). Two requests with the same identity
// are the same operation, whatever Idempotency-Key they carry.
export function operationIdentity({ method, url, bodyText, credentialHashes }) {
  const u = new URL(url);
  let body;
  const t = s(bodyText).trim();
  try { body = t ? ["json", canonicalJson(JSON.parse(t))] : ["empty"]; } catch (_) { body = ["form", sortedPairs(formEntries(t))]; }
  return JSON.stringify(["op", s(method).toUpperCase(), u.pathname, sortedPairs([...u.searchParams.entries()]), body, [...(credentialHashes || [])].sort()]);
}

// The identity of one MFL write as MFL would see it: path (any MFL host), query and form fields
// merged and sorted, credentials and output-format switches left out.
export function mflWriteIdentity({ url, bodyText }) {
  const u = new URL(url);
  const noJson = ([k]) => !/^json$/i.test(k);
  const query = sortedPairs([...u.searchParams.entries()].filter(noJson));
  const body = sortedPairs(formEntries(bodyText).filter(noJson));
  // A field sent in both the query and the body (TYPE=…&L=… on a POST's URL and form) is one MFL field, so a POST and
  // its GET retry of the same fields share one identity (review round 3). Only that cross-source overlap is removed:
  // each pair appears as many times as the source that repeats it most, so DATA=A twice in one body stays different
  // from DATA=A once (review round 4).
  const count = (list) => list.reduce((m, p) => { const k = JSON.stringify(p); m.set(k, (m.get(k) || 0) + 1); return m; }, new Map());
  const q = count(query), b = count(body);
  const merged = [];
  for (const k of new Set([...q.keys(), ...b.keys()])) for (let i = Math.max(q.get(k) || 0, b.get(k) || 0); i > 0; i--) merged.push(JSON.parse(k));
  return JSON.stringify(["mfl", u.pathname.toLowerCase().replace(/\/+$/, ""), sortedPairs(merged)]);
}

// ---------------------------------------------------------------------------------------------
// Redirects (review fix 4): every hop is decided again; method, body and credentials follow the
// fetch standard, and credentials never leave MFL.
// ---------------------------------------------------------------------------------------------
export const MAX_REDIRECT_HOPS = 5;
export function isMflHost(host) { return MFL_HOST_RE.test(s(host)); }

// -> { url, method, keepBody, headers } for the next hop, or { error } when it can't be followed.
export function redirectHop({ url, method, status, location, headers }) {
  let next;
  try { next = new URL(s(location), url); } catch (_) { return { error: "redirect_location_unparseable" }; }
  if (next.protocol !== "https:") return { error: "redirect_not_https" };
  const from = new URL(url);
  let m = s(method).toUpperCase();
  let keepBody = true;
  if (status === 303 && m !== "HEAD") { m = "GET"; keepBody = false; }
  if ((status === 301 || status === 302) && m === "POST") { m = "GET"; keepBody = false; }
  const h = new Headers(headers || {});
  if (!keepBody) for (const k of ["content-type", "content-length", "content-encoding", "content-language", "content-location"]) h.delete(k);
  if (from.origin !== next.origin) {
    h.delete("authorization");
    // An MFL session may follow MFL's own shard redirects (api -> www48); it never leaves MFL.
    if (!(isMflHost(from.hostname) && isMflHost(next.hostname))) { h.delete("cookie"); h.delete("x-api-key"); }
  }
  return { url: next.toString(), method: m, keepBody, headers: h };
}
