// bug_reports.js -- owner bug reports, private storage, behind BUG_REPORT_ENABLED (default off).
//
//   POST /api/bug-reports               a signed-in owner files a report
//   POST /api/bug-reports/mine          a signed-in owner lists THEIR OWN reports
//   POST /api/bug-reports/commish/list        commissioner only: every report
//   POST /api/bug-reports/commish/get         commissioner only: one report with its events
//
// Why POST for the reads: the owner's MFL sign-in travels in the JSON body, never in the
// address (addresses end up in logs, history and referrers).
//
// Why the commissioner routes are NOT under /admin/: the /admin front door (admin_authority.js)
// takes a commissioner session only as ?MFL_USER_ID= in the address, and would add a second MFL
// read on top of ours. These routes authenticate once, here, with the same primitives
// (resolveTradeCaller + isAdminCaller): an Authorization: Bearer key, or a proven commissioner
// session in the body. A key in the address (?APIKEY= and look-alikes) is REFUSED, never read:
// addresses end up in logs, history, referrers and shared screenshots.
//
// What this module does NOT do: post to Discord, send a DM, call GitHub or Anthropic, run an
// agent, or write any repo or public file. Its outbound calls are exactly two: the MFL
// identity check (injected as deps.detectFranchise) and the private D1 database.
//
// The rules (fields, redaction, rate limit, duplicates) live in bug_report_core.js.

import { resolveTradeCaller, isAdminCaller, callerFailureBody } from "./trade_authz.js";
import {
  LIMITS, validateSubmission, fingerprint, rateDecision, windowStartIso, reportCode, ownerMessage,
} from "./bug_report_core.js";

export const IDENTITY_TIMEOUT_MS = 5000;
const ROUTES = new Set([
  "/api/bug-reports", "/api/bug-reports/mine", "/api/bug-reports/commish/list", "/api/bug-reports/commish/get",
]);

function safeStr(v) { return String(v == null ? "" : v).trim(); }

// The flag is a wrangler var and nothing else. It is deliberately NOT in feature_flags.js, so there is no
// override map to read: deciding "off" costs no database call at all (a public endpoint must not spend D1
// operations while it is disabled).
export function bugReportsEnabled(env) { return safeStr(env && env.BUG_REPORT_ENABLED) === "1"; }

// Address parameters that look like a credential. The commissioner routes refuse any of them outright.
const KEY_PARAM_NAMES = new Set(["apikey", "api_key", "api-key", "key", "commish_api_key", "x-commish-apikey", "x-mfl-apikey", "authorization", "bearer", "token", "access_token"]);
export function keyInAddress(url) {
  for (const name of url.searchParams.keys()) if (KEY_PARAM_NAMES.has(String(name).toLowerCase())) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Stores. Same contract, two implementations: D1 (production) and memory (tests, preview).
// ---------------------------------------------------------------------------

const REPORT_COLS = [
  "env", "league_id", "season", "franchise_id", "status", "summary", "note", "screen", "build",
  "viewport", "online", "client_time", "err_name", "err_message", "err_endpoint", "err_status",
  "fingerprint", "client_request_id", "dup_count", "redactions", "created_at", "updated_at",
];

export function makeD1Store(db) {
  const first = async (sql, ...args) => (await db.prepare(sql).bind(...args).first()) || null;
  const all = async (sql, ...args) => ((await db.prepare(sql).bind(...args).all()) || {}).results || [];
  return {
    findByRequestId: (fid, rid) => first(
      "SELECT * FROM ups_bug_reports WHERE franchise_id=? AND client_request_id=? LIMIT 1", fid, rid),
    findOpenByFingerprint: (fid, fp, sinceIso) => first(
      // INDEXED BY: without it SQLite prefers the (status, created_at) index and reads every open report in the window.
      "SELECT * FROM ups_bug_reports INDEXED BY idx_ups_bug_reports_team_fp WHERE franchise_id=? AND fingerprint=? AND created_at>=? AND status='open' ORDER BY created_at DESC LIMIT 1",
      fid, fp, sinceIso),
    recentByFranchise: async (fid, sinceIso, limit) => (await all(
      "SELECT created_at FROM ups_bug_reports WHERE franchise_id=? AND created_at>=? ORDER BY created_at DESC LIMIT ?",
      fid, sinceIso, limit)).map((r) => r.created_at),
    // The rate-limit check and the insert are ONE statement, so simultaneous submissions cannot all pass on the
    // same earlier read: SQLite runs a single statement under the write lock, and D1 runs a batch as one
    // transaction. The row is inserted only if (a) the team has no report newer than the gap cutoff and
    // (b) fewer than `dailyMax` reports exist since the window start. Both subqueries use idx_ups_bug_reports_team_time.
    // The event row is added only for a report that has no event yet, so a refused attempt writes nothing.
    // Returns { inserted: false } when refused, else { inserted: true, report }. A duplicate (franchise_id,
    // client_request_id) still throws UNIQUE, which the caller answers as a replay.
    async reserveReport(row, event, lim) {
      const ph = REPORT_COLS.map(() => "?").join(",");
      const results = await db.batch([
        db.prepare(`INSERT INTO ups_bug_reports (${REPORT_COLS.join(",")}) SELECT ${ph} WHERE NOT EXISTS (SELECT 1 FROM ups_bug_reports WHERE franchise_id=? AND created_at>?) AND (SELECT COUNT(*) FROM (SELECT 1 FROM ups_bug_reports WHERE franchise_id=? AND created_at>=? LIMIT ?)) < ?`)
          .bind(...REPORT_COLS.map((c) => row[c] == null ? null : row[c]), row.franchise_id, lim.gapCutoffIso, row.franchise_id, lim.windowStartIso, lim.dailyMax, lim.dailyMax),
        db.prepare("INSERT INTO ups_bug_report_events (report_id, at, actor, kind, detail) SELECT r.id, ?, ?, ?, ? FROM ups_bug_reports r WHERE r.franchise_id=? AND r.client_request_id=? AND NOT EXISTS (SELECT 1 FROM ups_bug_report_events e WHERE e.report_id=r.id)")
          .bind(event.at, event.actor, event.kind, event.detail || "", row.franchise_id, row.client_request_id),
      ]);
      const changes = Number(results && results[0] && results[0].meta && results[0].meta.changes);
      if (!(changes > 0)) return { inserted: false };
      return { inserted: true, report: await first("SELECT * FROM ups_bug_reports WHERE franchise_id=? AND client_request_id=? LIMIT 1", row.franchise_id, row.client_request_id) };
    },
    // Record a duplicate against an open report, ATOMICALLY up to `max` (MAT-4). The cap check and the event insert are
    // one statement: the event row is inserted only if fewer than `max` duplicate events exist for the report, so
    // simultaneous duplicates cannot all pass a stale read of dup_count. The counter is then derived from the events
    // (never incremented blindly), and only written when it changed, so a refused duplicate writes nothing.
    // Returns { ok: false } when the cap is reached, else { ok: true, report }.
    async bumpDuplicate(id, event, max) {
      const results = await db.batch([
        db.prepare("INSERT INTO ups_bug_report_events (report_id, at, actor, kind, detail) SELECT ?, ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM ups_bug_report_events WHERE report_id=? AND kind=?) < ?")
          .bind(id, event.at, event.actor, event.kind, event.detail || "", id, event.kind, max),
        db.prepare("UPDATE ups_bug_reports SET dup_count=(SELECT COUNT(*) FROM ups_bug_report_events WHERE report_id=? AND kind=?), updated_at=? WHERE id=? AND dup_count<>(SELECT COUNT(*) FROM ups_bug_report_events WHERE report_id=? AND kind=?)")
          .bind(id, event.kind, event.at, id, id, event.kind),
      ]);
      const inserted = Number(results && results[0] && results[0].meta && results[0].meta.changes);
      if (!(inserted > 0)) return { ok: false };
      return { ok: true, report: await first("SELECT * FROM ups_bug_reports WHERE id=?", id) };
    },
    listMine: (fid, limit) => all(
      "SELECT id, env, status, summary, created_at, updated_at, dup_count FROM ups_bug_reports WHERE franchise_id=? ORDER BY created_at DESC LIMIT ?", fid, limit),
    listAll: (status, limit) => status
      ? all("SELECT * FROM ups_bug_reports WHERE status=? ORDER BY created_at DESC LIMIT ?", status, limit)
      : all("SELECT * FROM ups_bug_reports ORDER BY id DESC LIMIT ?", limit),
    getById: (id) => first("SELECT * FROM ups_bug_reports WHERE id=?", id),
    eventsFor: (id) => all("SELECT id, at, actor, kind, detail FROM ups_bug_report_events WHERE report_id=? ORDER BY id LIMIT 50", id),
  };
}

export function makeMemoryStore() {
  const reports = []; const events = []; let nextId = 1; let nextEvt = 1;
  const clone = (r) => (r ? { ...r } : null);
  const byNewest = (a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : b.id - a.id);
  return {
    _reports: reports, _events: events,
    async findByRequestId(fid, rid) { return clone(reports.find((r) => r.franchise_id === fid && r.client_request_id === rid)); },
    async findOpenByFingerprint(fid, fp, sinceIso) {
      return clone(reports.filter((r) => r.franchise_id === fid && r.fingerprint === fp && r.created_at >= sinceIso && r.status === "open").sort(byNewest)[0]);
    },
    async recentByFranchise(fid, sinceIso, limit) {
      return reports.filter((r) => r.franchise_id === fid && r.created_at >= sinceIso).sort(byNewest).slice(0, limit).map((r) => r.created_at);
    },
    // Same contract as the D1 store. No await between the check and the push, so it is atomic in JS too.
    async reserveReport(row, event, lim) {
      if (reports.some((r) => r.franchise_id === row.franchise_id && r.client_request_id === row.client_request_id)) {
        throw new Error("UNIQUE constraint failed: ups_bug_reports.franchise_id, ups_bug_reports.client_request_id");
      }
      const mine = reports.filter((r) => r.franchise_id === row.franchise_id);
      if (mine.some((r) => r.created_at > lim.gapCutoffIso)) return { inserted: false };
      if (mine.filter((r) => r.created_at >= lim.windowStartIso).length >= lim.dailyMax) return { inserted: false };
      const rec = { id: nextId++, ...row }; reports.push(rec);
      events.push({ id: nextEvt++, report_id: rec.id, at: event.at, actor: event.actor, kind: event.kind, detail: event.detail || "" });
      return { inserted: true, report: clone(rec) };
    },
    // Same contract as the D1 store; no await between the check and the writes, so it is atomic in JS.
    async bumpDuplicate(id, event, max) {
      const rec = reports.find((r) => r.id === id);
      if (events.filter((e) => e.report_id === id && e.kind === event.kind).length >= max) return { ok: false };
      events.push({ id: nextEvt++, report_id: id, at: event.at, actor: event.actor, kind: event.kind, detail: event.detail || "" });
      rec.dup_count = events.filter((e) => e.report_id === id && e.kind === event.kind).length; rec.updated_at = event.at;
      return { ok: true, report: clone(rec) };
    },
    async listMine(fid, limit) {
      return reports.filter((r) => r.franchise_id === fid).sort(byNewest).slice(0, limit)
        .map(({ id, env, status, summary, created_at, updated_at, dup_count }) => ({ id, env, status, summary, created_at, updated_at, dup_count }));
    },
    async listAll(status, limit) {
      const rows = status ? reports.filter((r) => r.status === status).sort(byNewest) : reports.slice().sort((a, b) => b.id - a.id);
      return rows.slice(0, limit).map(clone);
    },
    async getById(id) { return clone(reports.find((r) => r.id === id)); },
    async eventsFor(id) { return events.filter((e) => e.report_id === id).slice(0, 50).map(clone); },
  };
}

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

function respond(ctx, status, payload, extra) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      // Private data: never let an edge or a browser keep it.
      "cache-control": "no-store, private",
      ...(ctx.corsHeaders || {}),
      ...(extra || {}),
    },
  });
}

function refuse(ctx, code, extra) {
  const m = ownerMessage(code);
  const body = { ok: false, code, state: m.state, title: m.title, message: m.message, ...(extra || {}) };
  const headers = extra && extra.retry_after_seconds ? { "retry-after": String(extra.retry_after_seconds) } : undefined;
  return respond(ctx, m.http, body, headers);
}

async function readJsonBody(ctx) {
  const declared = Number(ctx.request.headers.get("content-length") || 0);
  if (declared > LIMITS.BODY_BYTES) return { error: "too_large" };
  let text = "";
  try { text = await ctx.request.text(); } catch (_) { return { error: "bad_request" }; }
  if (new TextEncoder().encode(text).length > LIMITS.BODY_BYTES) return { error: "too_large" };
  try { return { body: JSON.parse(text || "{}") }; } catch (_) { return { error: "bad_request" }; }
}

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error("identity check timed out")), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// The ONE identity read. resolveTradeCaller proves the MFL session through
// deps.detectFranchise (MFL TYPE=myleagues). It is bounded here so a slow MFL cannot hold the request.
async function identify(ctx, body, token, { allowAdminKey }) {
  let url = ctx.url;
  if (allowAdminKey) {
    // The commissioner key is taken from the Authorization header ONLY. resolveTradeCaller reads it from
    // an APIKEY parameter, so hand it a private copy of the address carrying the header's value. The
    // caller's own address never carries a key here: handleBugReportRequest refuses one before this point.
    const m = /^bearer\s+(.+)$/i.exec(safeStr(ctx.request.headers.get("authorization")));
    if (m) { url = new URL(url.href); url.searchParams.set("APIKEY", m[1].trim()); }
  }
  return resolveTradeCaller({
    url, body: body && typeof body === "object" ? body : null, env: ctx.env,
    deps: {
      detectFranchise: (t, league) => withTimeout(Promise.resolve(ctx.deps.detectFranchise(t, league)), ctx.identityTimeoutMs || IDENTITY_TIMEOUT_MS),
      commishFids: ctx.deps.commishFids,
    },
    defaultLeagueId: ctx.defaultLeagueId, defaultSeason: ctx.defaultSeason,
    declaredFid: "",             // an owner can only ever act as themselves here
    queryToken: token, cookieToken: "", allowCookieToken: false, allowAdminKey,
  });
}

const ownerView = (r) => ({ code: reportCode(r), status: r.status, summary: r.summary, created_at: r.created_at, updated_at: r.updated_at, times_reported: 1 + (r.dup_count || 0) });
const adminView = (r) => ({
  code: reportCode(r), id: r.id, env: r.env, status: r.status, franchise_id: r.franchise_id, league_id: r.league_id, season: r.season,
  summary: r.summary, note: r.note, screen: r.screen, build: r.build, viewport: r.viewport, online: r.online == null ? null : !!r.online,
  client_time: r.client_time,
  error: { name: r.err_name, message: r.err_message, endpoint: r.err_endpoint, status: r.err_status },
  dup_count: r.dup_count, redactions: r.redactions, created_at: r.created_at, updated_at: r.updated_at,
});

// ---------------------------------------------------------------------------
// Entry point. Returns null for any path that is not ours, so the caller continues.
// ---------------------------------------------------------------------------

/**
 * @param ctx.request, ctx.url, ctx.path, ctx.env, ctx.corsHeaders
 * @param ctx.deps  { detectFranchise(token, leagueId), commishFids(), isEnabled() -> Promise<boolean>, store() -> store }
 * @param ctx.now   () => ms (tests)
 */
export async function handleBugReportRequest(ctx) {
  if (!ROUTES.has(ctx.path)) return null;
  if (ctx.request.method !== "POST") return respond(ctx, 405, { ok: false, code: "method_not_allowed", message: "Use POST." }, { allow: "POST, OPTIONS" });
  const now = ctx.now || (() => Date.now());

  // Flag first: when off, nothing else runs (no identity check, no database read).
  let enabled = false;
  try { enabled = !!(await ctx.deps.isEnabled()); } catch (_) { enabled = false; } // unknown = off
  if (!enabled) return refuse(ctx, "disabled");

  // A commissioner key in the address is refused before anything is read, whatever else the request carries.
  // The response never repeats the value.
  if (ctx.path.startsWith("/api/bug-reports/commish/") && keyInAddress(ctx.url)) return refuse(ctx, "key_in_address");

  try {
    const parsed = await readJsonBody(ctx);
    if (parsed.error) return refuse(ctx, parsed.error);
    const body = parsed.body;
    const store = ctx.deps.store();

    // ------------------------------------------------------------- submit
    if (ctx.path === "/api/bug-reports") {
      const v = validateSubmission(body);                      // cheap checks before any outbound call
      if (!v.ok) return refuse(ctx, v.code, v.fields ? { fields: v.fields } : undefined);
      const who = await identify(ctx, body, v.token, { allowAdminKey: false });
      if (!who.ok) return refuse(ctx, who.code === "bad_request" ? "bad_request" : who.code);
      if (who.caller.kind !== "owner") return refuse(ctx, "forbidden");
      const fid = who.caller.sessionFid;
      const nowMs = now(); const nowIso = new Date(nowMs).toISOString();
      const val = v.value;

      // 1. Same request id from the same team = a retry (double tap, flaky network): replay, never a second row.
      const replay = await store.findByRequestId(fid, val.client_request_id);
      if (replay) return respond(ctx, 200, { ok: true, replay: true, duplicate: false, report: ownerView(replay) });

      // 2. Same problem from the same team inside 24 hours: add to the open report, don't make another.
      const fp = await fingerprint(val);
      // Used for a duplicate found before the write AND for one found after losing the write race (MAT-3).
      const answerDuplicate = async (dup) => {
        // A double tap that landed after the original's insert matches its own report: that is a replay, not a duplicate.
        if (dup.client_request_id === val.client_request_id) return respond(ctx, 200, { ok: true, replay: true, duplicate: false, report: ownerView(dup) });
        if ((dup.dup_count || 0) >= LIMITS.DUP_MAX) return refuse(ctx, "duplicate_limit", { report: ownerView(dup) });
        // The check above is only an early exit on a possibly stale read; the cap itself is enforced atomically inside bumpDuplicate (MAT-4).
        const bump = await store.bumpDuplicate(dup.id, { at: nowIso, actor: "owner:" + fid, kind: "duplicate", detail: val.note }, LIMITS.DUP_MAX);
        if (!bump.ok) return refuse(ctx, "duplicate_limit", { report: ownerView((await store.getById(dup.id)) || dup) });
        const bumped = bump.report;
        return respond(ctx, 200, {
          ok: true, replay: false, duplicate: true, report: ownerView(bumped),
          message: "You already reported this (" + reportCode(bumped) + "). We added your note to it instead of opening a second report.",
          redactions: v.redactions,
        });
      };
      const dup = await store.findOpenByFingerprint(fid, fp, windowStartIso(nowMs));
      if (dup) return answerDuplicate(dup);

      // 3. Rate limit + store, ONE atomic reservation (only reports that would be NEW count). The gap and the
      //    daily cap are checked inside the same statement that inserts, so simultaneous submissions from one team
      //    cannot all pass on the same earlier read.
      const row = {
        env: "test", league_id: who.caller.leagueId, season: who.caller.season, franchise_id: fid, status: "open",
        summary: val.summary, note: val.note, screen: val.screen, build: val.build,
        viewport: val.viewport, online: val.online, client_time: val.client_time,
        err_name: val.err_name, err_message: val.err_message, err_endpoint: val.err_endpoint, err_status: val.err_status,
        fingerprint: fp, client_request_id: val.client_request_id, dup_count: 0, redactions: v.redactions,
        created_at: nowIso, updated_at: nowIso,
      };
      const lim = {
        windowStartIso: windowStartIso(nowMs),
        gapCutoffIso: new Date(nowMs - LIMITS.MIN_GAP_SECONDS * 1000).toISOString(),
        dailyMax: LIMITS.DAILY_MAX,
      };
      let res;
      try {
        res = await store.reserveReport(row, { at: nowIso, actor: "owner:" + fid, kind: "submitted", detail: "" }, lim);
      } catch (e) {
        // Two identical requests raced: the unique index let one through. Answer the loser as a replay.
        if (/UNIQUE/i.test(String(e && e.message))) {
          const again = await store.findByRequestId(fid, val.client_request_id);
          if (again) return respond(ctx, 200, { ok: true, replay: true, duplicate: false, report: ownerView(again) });
        }
        throw e;
      }
      if (!res.inserted) {
        // Refused by the reservation. A same-id request that raced and won is still a replay, not a limit.
        const again = await store.findByRequestId(fid, val.client_request_id);
        if (again) return respond(ctx, 200, { ok: true, replay: true, duplicate: false, report: ownerView(again) });
        // MAT-3: two simultaneous reports of the SAME problem (different request ids) both passed the duplicate
        // lookup before either was saved. The winner was stored; this one lost the reservation, but it is a duplicate
        // of the winner's now-open report, so record it there (its note is kept) instead of telling the owner to wait.
        const raced = await store.findOpenByFingerprint(fid, fp, lim.windowStartIso);
        if (raced) return answerDuplicate(raced);
        // Only now read the recent reports, to tell the owner which limit and how long to wait.
        const recent = await store.recentByFranchise(fid, lim.windowStartIso, LIMITS.DAILY_MAX);
        const rate = rateDecision(recent, nowMs);
        if (rate.allow) return refuse(ctx, "too_fast", { retry_after_seconds: LIMITS.MIN_GAP_SECONDS });   // the window moved between the two reads
        return refuse(ctx, rate.code, { retry_after_seconds: rate.retryAfterSeconds });
      }
      const saved = res.report;
      return respond(ctx, 201, { ok: true, replay: false, duplicate: false, report: ownerView(saved), redactions: v.redactions });
    }

    // ------------------------------------------------------------- owner's own list
    if (ctx.path === "/api/bug-reports/mine") {
      const who = await identify(ctx, body, safeStr(body && body.mfl_user_id), { allowAdminKey: false });
      if (!who.ok) return refuse(ctx, who.code);
      if (who.caller.kind !== "owner") return refuse(ctx, "forbidden");
      const rows = await store.listMine(who.caller.sessionFid, 20);   // WHERE franchise_id = the PROVEN team
      return respond(ctx, 200, { ok: true, reports: rows.map(ownerView) });
    }

    // ------------------------------------------------------------- commissioner
    const who = await identify(ctx, body, safeStr(body && body.mfl_user_id), { allowAdminKey: true });
    if (!who.ok) return respond(ctx, who.http, callerFailureBody(who));
    if (!isAdminCaller(who.caller)) return respond(ctx, 403, { ok: false, code: "forbidden", message: "That needs the commissioner." });

    if (ctx.path === "/api/bug-reports/commish/list") {
      const status = safeStr(body && body.status).toLowerCase();
      const limit = Math.min(100, Math.max(1, Math.round(Number(body && body.limit)) || 50));
      const rows = await store.listAll(status || "", limit);
      return respond(ctx, 200, { ok: true, reports: rows.map(adminView) });
    }
    // /api/bug-reports/commish/get
    const id = Math.round(Number(body && body.id));
    if (!Number.isFinite(id) || id < 1) return refuse(ctx, "bad_request");
    const row = await store.getById(id);
    if (!row) return respond(ctx, 404, { ok: false, code: "not_found", message: "No such report." });
    return respond(ctx, 200, { ok: true, report: adminView(row), events: await store.eventsFor(id) });
  } catch (e) {
    console.error("[bug-reports] " + String((e && e.message) || e).slice(0, 200));  // never the body
    return refuse(ctx, "server_error");
  }
}
