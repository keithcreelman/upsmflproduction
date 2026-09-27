// Runs the REAL worker (worker/src/index.js `default.fetch`) under Node.
//   - D1 = node:sqlite through the D1-shaped adapter (real 3-way migrations applied)
//   - the ONLY things faked are the network edges: a STATEFUL MFL, Discord, GitHub
//   - any other outbound call throws, so an unexpected dependency can't hide
//
// The MFL stub models the parts of MFL that matter for authorization:
//   * identity by cookie: MFL_USER_ID=<token> is an owner; the commissioner cookie can
//     impersonate via FRANCHISE_ID unless `lockout` is on
//   * MFL's documented tradeResponse rule: `revoke` only by the originator, `accept`/`reject`
//     only by the target, and only while the trade is pending
//   * pendingTrades is scoped to the cookie's franchise (an owner never sees other teams' offers)
import { makeD1, applyMigrations, THREE_WAY_MIGRATIONS } from "./d1_sqlite.mjs";
await import("./register_md_loader.mjs");
const worker = (await import("../../worker/src/index.js")).default;

export const COMMISH_COOKIE = "COMMISH-COOKIE-SECRET";
export const ADMIN_KEY = "admin-key-secret";
export const LEAGUE = "74598";
// MFL's league export carries an `abbrev` per franchise (it is the `Ext:` lineage label); the harness serves the league's real style.
export const ABBREVS = { "0000": "COMM", "0001": "L.A.", "0002": "DBCA", "0003": "GRID", "0004": "PG", "0005": "HammerTime", "0007": "SEX", "0008": "RealDeal", "0012": "Hawk" };
// MFL's `players` export: the position that decides a player's extension schedule. A test overrides st.positions to change or remove one.
export const DEFAULT_POSITIONS = { "14056": "WR", "13100": "WR", "16614": "WR", "16181": "WR", "16650": "WR", "16193": "WR", "15000": "WR", "13593": "QB", "16641": "TE" };
export const NAMES = { "0000": "Commissioner", "0001": "L.A. Looks", "0002": "CBP", "0003": "Gride", "0004": "Pure Greatness", "0005": "HammerTime", "0007": "Sex Manther", "0008": "Real Deal Creel", "0012": "Hawks" };

export function makeWorkerEnv(over) {
  const { __migrations, ...envOver } = over || {};       // __migrations: build the DB as it was before a later migration
  over = envOver;
  const db = makeD1({});
  applyMigrations(db, __migrations || THREE_WAY_MIGRATIONS);
  db.raw.exec("CREATE TABLE IF NOT EXISTS discord_owners (franchise_id TEXT, active_owner TEXT, discord_user_id TEXT)");
  return {
    UPS_MFL_DB: db, TWB_OUTBOX_DB: db,
    COMMISH_API_KEY: ADMIN_KEY, MFL_COOKIE: COMMISH_COOKIE, MFL_APIKEY: "mfl-api-key",
    DISCORD_BOT_TOKEN: "test-token", TRADE_3WAY_ENABLED: "1",
    // the extension-eligibility clock: a mid-August instant, i.e. inside the standard window (before the 2026-09-06 contract deadline)
    TWR_TEST_NOW_MS: String(Date.parse("2026-08-20T16:00:00Z")),
    ...(over || {}),
  };
}

// A service binding that calls this same worker (what Cloudflare's env.SELF does in production). Optional: only tests that
// exercise the 3-way engine's calls back into the worker need it. Records every call.
export function bindSelf(env) {
  const calls = [];
  env.SELF = { fetch: async (u, i) => { calls.push(String(u)); const waits = []; return worker.fetch(new Request(String(u), i), env, { waitUntil: (p) => waits.push(p), passThroughOnException() {} }); } };
  env.__selfCalls = calls;
  return env;
}

export function makeMfl(opts) {
  opts = opts || {};
  const st = {
    lockout: false,
    tokens: { "tok-A": "0008", "tok-B": "0001", "tok-C": "0002", "tok-O": "0003", "tok-commish": "0000", ...(opts.tokens || {}) },
    otherLeague: { "tok-x": { league: "99999", fid: "0001" } },
    pending: [],        // { trade_id, offeringteam, offeredto, will_give_up, will_receive, comments, timestamp }
    done: [],           // { trade_id, response, by }
    imports: [],        // every import the worker made: { type, method, fields, cookie, asCommish }
    exports: [],        // every export: { type, cookie, params }
    discord: [],
    rosters: { "0001": ["14056"], "0002": ["13100"], "0003": ["15000"], "0008": ["16614", "16193"] },
    salaryAdjustments: [],   // rows MFL holds (written by salaryAdj imports)
    futurePicks: { "0001": [{ year: 2027, round: 1 }, { year: 2027, round: 6 }, { year: 2029, round: 1 }], "0002": [{ year: 2027, round: 2 }] },   // current owner → picks (orig = owner unless set)
    draftPicks: [{ round: "1", pick: "4", franchise: "0001", player: "" }, { round: "1", pick: "5", franchise: "0002", player: "" }, { round: "1", pick: "6", franchise: "0001", player: "12345" }],
    nextTradeId: 2001,
    failNext: null,     // { type, status } -> make the next import of `type` fail
    holdAccept: null,   // optional promise gate for concurrency tests
  };
  const franchiseOf = (cookie, params) => {
    const m = /MFL_USER_ID=([^;]+)/.exec(cookie || "");
    const tok = m ? decodeURIComponent(m[1]) : "";
    if (tok === COMMISH_COOKIE || cookie === COMMISH_COOKIE || tok === "tok-commish") {
      const f = params.get("FRANCHISE_ID");
      if (f && f !== "0000" && st.lockout) return { error: "Commissioner can not impersonate another franchise with lockout on.", asCommish: true };
      return { fid: f || "0000", asCommish: true };
    }
    if (st.tokens[tok]) return { fid: st.tokens[tok], asCommish: false };
    return { error: "not logged in" };
  };
  const json = (obj, status) => ({ ok: (status || 200) < 400, status: status || 200, headers: new Headers({ "content-type": "application/json" }), text: async () => JSON.stringify(obj), json: async () => obj, arrayBuffer: async () => new TextEncoder().encode(JSON.stringify(obj)).buffer });

  const handle = async (input, init) => {
    init = init || {};
    const url = new URL(String(input));
    const method = (init.method || "GET").toUpperCase();
    const headers = new Headers(init.headers || {});
    const cookie = headers.get("Cookie") || "";
    const bodyText = typeof init.body === "string" ? init.body : (init.body ? String(init.body) : "");
    const params = new URLSearchParams(method === "POST" && bodyText && !bodyText.startsWith("{") ? bodyText : "");
    for (const [k, v] of url.searchParams) if (!params.has(k)) params.set(k, v);

    if (url.hostname === "discord.com") {
      const b = init.body ? JSON.parse(init.body) : null;
      st.discord.push({ url: url.pathname, method, body: b });
      return json(/users\/@me\/channels/.test(url.pathname) ? { id: "dm-" + (b && b.recipient_id) } : { id: "m" + st.discord.length });
    }
    if (/^(www\d+|api)\.myfantasyleague\.com$/.test(url.hostname)) {
      const type = params.get("TYPE");
      const isImport = /\/import$/.test(url.pathname);
      if (!isImport) {
        st.exports.push({ type, cookie, params: Object.fromEntries(params) });
        if (type === "myleagues") {
          const m = /MFL_USER_ID=([^;]+)/.exec(cookie); const tok = m ? decodeURIComponent(m[1]) : "";
          if (st.otherLeague[tok]) return json({ leagues: { league: [{ league_id: st.otherLeague[tok].league, franchise_id: st.otherLeague[tok].fid, name: "Other" }] } });
          if (opts.myleaguesDown) return json({ error: "down" }, 503);
          if (tok === "tok-commish") return json({ leagues: { league: [{ league_id: LEAGUE, franchise_id: "0000", name: "UPS" }] } });
          if (st.tokens[tok]) return json({ leagues: { league: [{ league_id: LEAGUE, franchise_id: st.tokens[tok], name: "UPS" }] } });
          return json({ error: "Invalid login" }, 401);
        }
        // Only a commissioner credential sees owner e-mails (the worker's own "am I commissioner?" probe relies on it).
        // A test can fail an export outright (st.exportFail[type] = http status) or make it return a malformed body
        // (st.exportBody[type] = the raw JSON to serve) — that is how the cap-authority "unavailable / malformed →
        // fail closed" cases are driven.
        // (st.exportFailByYear["2025"] = { salaries: 503 } fails an export for ONE season only — e.g. last season's contracts, which the AAV repair reads)
        { const yr = (/\/(\d{4})\/export/.exec(url.pathname) || [])[1]; if (yr && st.exportFailByYear && st.exportFailByYear[yr] && st.exportFailByYear[yr][type]) return json({ error: "MFL boom" }, st.exportFailByYear[yr][type]); }
        if (st.exportFail && st.exportFail[type]) return json({ error: "MFL boom" }, st.exportFail[type]);
        if (st.exportBody && Object.prototype.hasOwnProperty.call(st.exportBody, type)) return json(st.exportBody[type]);
        if (type === "league") { const seeEmail = /COMMISH-COOKIE/.test(cookie) || /tok-commish/.test(cookie); return json({ league: { salaryCapAmount: "300000", ...(st.league || {}), franchises: { franchise: Object.entries(NAMES).map(([id, name]) => ({ id, name, abbrev: ABBREVS[id] || name, ...(seeEmail ? { email: `${id}@ups.test` } : {}) })) } } }); }
        if (type === "salaries") return json({ salaries: { leagueUnit: { player: st.salaries || [] } } });
        if (type === "pendingTrades") {
          const who = franchiseOf(cookie, params);
          if (who.error) return json({ error: who.error }, 401);
          const rows = st.pending.filter((t) => t.offeringteam === who.fid || t.offeredto === who.fid);
          return json({ pendingTrades: { pendingTrade: rows } });
        }
        if (type === "rosters") {
          // a roster entry is a player id, or {id, salary, status} when a test needs a taxi/IR/priced player
          // (contractYear / contractStatus / contractInfo are served only when the test sets them; `salary: null` = MFL blank)
          return json({ rosters: { franchise: Object.entries(st.rosters).map(([id, ps]) => ({ id, player: ps.map((p) => (typeof p === "object"
            ? { id: p.id, salary: p.salary === null ? "" : String(p.salary == null ? 5000 : p.salary), status: p.status || "ROSTER", ...(p.contractYear != null ? { contractYear: String(p.contractYear) } : {}), ...(p.contractStatus ? { contractStatus: p.contractStatus } : {}), ...(p.contractInfo ? { contractInfo: p.contractInfo } : {}) }
            : { id: p, salary: "5000", status: "ROSTER" })) })) } });
        }
        if (type === "futureDraftPicks") {
          return json({ futureDraftPicks: { franchise: Object.entries(st.futurePicks).map(([id, ps]) => ({ id, futureDraftPick: ps.map((p) => ({ year: String(p.year), round: String(p.round), originalPickFor: p.orig || id })) })) } });
        }
        if (type === "salaryAdjustments") return json({ salaryAdjustments: { salaryAdjustment: st.salaryAdjustments } });
        if (type === "draftResults") return json({ draftResults: { draftUnit: { draftPick: st.draftPicks } } });
        if (type === "transactions") return json({ transactions: { transaction: st.transactions || [] } });   // (a test sets st.transactions to serve MFL's ledger)
        if (type === "players") {
          const want = (params.get("PLAYERS") || params.get("P") || "").split(",").map((x) => x.trim()).filter(Boolean);
          const pos = st.positions || DEFAULT_POSITIONS;
          return json({ players: { player: Object.entries(pos).filter(([id]) => !want.length || want.includes(id)).map(([id, position]) => ({ id, position, name: `P${id}, Test`, team: "TST" })) } });
        }
        return json({});
      }
      // ── imports (writes) ──
      // MFL's api.* host does not execute imports: it 302-redirects to the league's shard. The
      // worker probes with redirect:"manual" to learn the shard, so that probe MUST NOT write.
      if (url.hostname === "api.myfantasyleague.com" && init.redirect === "manual") {
        const loc = new URL(url); loc.hostname = "www48.myfantasyleague.com";
        return { ok: false, status: 302, headers: new Headers({ location: loc.toString() }), text: async () => "" };
      }
      const who = franchiseOf(cookie, params);
      const rec = { type, method, fields: Object.fromEntries(params), cookie, asCommish: !!who.asCommish, apikey: params.get("APIKEY") || "" };
      st.imports.push(rec);
      if (st.failNext && st.failNext.type === type) { const f = st.failNext; st.failNext = null; return json({ error: f.message || "MFL boom" }, f.status || 500); }
      if (who.error && !params.get("APIKEY")) return json({ error: who.error }, 200);
      if (type === "salaryAdj") {
        // MFL stores the adjustments; the worker then reads them back from the salaryAdjustments export to verify.
        const data = params.get("DATA") || "";
        const before = st.salaryAdjustments.length;
        for (const m of data.matchAll(/<salary_adjustment\s+franchise_id="(\d+)"\s+amount="(-?[\d.]+)"\s+explanation="([^"]*)"/g)) st.salaryAdjustments.push({ franchise_id: m[1], amount: m[2], description: m[3] });
        return json({ salaryAdj: { status: "OK", rows: st.salaryAdjustments.length - before } });
      }
      if (type === "salaries" && st.salaries && !st.salariesImportIgnored) {
        // MFL applies a salaries import to the named players (APPEND=1 leaves the rest alone) — exactly the request shape the
        // worker builds: <salaries><leagueUnit unit="LEAGUE"><player id salary contractYear contractInfo contractStatus/></leagueUnit></salaries>
        const data = params.get("DATA") || "";
        for (const m of data.matchAll(/<player\s+([^>]*?)\s*\/>/g)) {
          const a = Object.fromEntries([...m[1].matchAll(/(\w+)="([^"]*)"/g)].map((x) => [x[1], x[2].replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">")]));
          const row = st.salaries.find((r) => String(r.id) === a.id);
          if (row) Object.assign(row, a); else st.salaries.push(a);
        }
        return json({ ok: true });
      }
      if (type === "tradeProposal") {
        const fid = params.get("APIKEY") ? params.get("FRANCHISE_ID") : who.fid;
        const id = String(st.nextTradeId++);
        st.pending.push({ trade_id: id, offeringteam: fid, offeredto: params.get("OFFEREDTO"), will_give_up: params.get("WILL_GIVE_UP") || "", will_receive: params.get("WILL_RECEIVE") || "", comments: params.get("COMMENTS") || "", timestamp: String(Math.floor(Date.now() / 1000)) });
        return json({ tradeProposal: { trade_id: id, status: "OK" } });
      }
      if (type === "tradeResponse") {
        if (st.holdAccept && params.get("RESPONSE") === "accept") await st.holdAccept;
        const t = st.pending.find((x) => x.trade_id === params.get("TRADE_ID"));
        const fid = params.get("APIKEY") ? params.get("FRANCHISE_ID") : who.fid;
        if (!t) return json({ error: "Trade not found or no longer pending." }, 200);
        const resp = params.get("RESPONSE");
        if (resp === "revoke" && t.offeringteam !== fid) return json({ error: "Only the originator can revoke." }, 200);
        if ((resp === "accept" || resp === "reject") && t.offeredto !== fid) return json({ error: "Only the target can respond." }, 200);
        st.pending = st.pending.filter((x) => x !== t);
        st.done.push({ trade_id: t.trade_id, response: resp, by: fid, cookie, asCommish: !!who.asCommish });
        // a LOST RESPONSE: MFL executed the trade, but the answer never reached the worker (st.loseResponseNext = "timeout" throws, or an HTTP status)
        if (st.loseResponseNext && resp === "accept") { const m = st.loseResponseNext; st.loseResponseNext = null; if (m === "timeout") throw new Error("network reset (response lost)"); return json({ error: "gateway timeout" }, Number(m) || 504); }
        return json({ tradeResponse: { status: "OK", response: resp } });
      }
      return json({ ok: true });
    }
    if (url.hostname === "api.github.com" || url.hostname === "raw.githubusercontent.com" || url.hostname === "cdn.jsdelivr.net") {
      return json({ message: "Not Found" }, 404);
    }
    throw new Error(`UNEXPECTED network call in test: ${method} ${url}`);
  };

  const realFetch = globalThis.fetch;
  return {
    st,
    install() { globalThis.fetch = handle; },
    restore() { globalThis.fetch = realFetch; },
    addPending(t) { const row = { trade_id: String(st.nextTradeId++), timestamp: String(Math.floor(Date.now() / 1000)), will_give_up: "14056,", will_receive: "", comments: "", ...t }; st.pending.push(row); return row.trade_id; },
    writes: (type) => st.imports.filter((i) => !type || i.type === type),
    commishCookieWrites: () => st.imports.filter((i) => i.cookie === COMMISH_COOKIE || /COMMISH-COOKIE/.test(i.cookie)),
  };
}

// Drive the worker exactly as Cloudflare would.
export async function callWorker(env, method, pathAndQuery, opts) {
  opts = opts || {};
  const url = "https://worker.test" + pathAndQuery;
  const headers = { ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}), ...(opts.headers || {}) };
  const waits = [];
  const res = await worker.fetch(new Request(url, { method, headers, body: opts.body !== undefined ? (typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body)) : undefined }),
    env, { waitUntil: (p) => waits.push(p), passThroughOnException() {} });
  await Promise.allSettled(waits);
  const text = await res.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch (_) {}
  return { status: res.status, json, text, headers: res.headers };
}

// A fetch() a browser client can be given: absolute worker URLs go straight to the real handler.
export function workerFetch(env, log) {
  return async (input, init) => {
    init = init || {};
    const url = new URL(String(input));
    const headers = {}; for (const [k, v] of new Headers(init.headers || {})) headers[k] = v;
    const rec = { method: (init.method || "GET").toUpperCase(), path: url.pathname, query: Object.fromEntries(url.searchParams), headers, body: init.body ? (() => { try { return JSON.parse(init.body); } catch (_) { return init.body; } })() : null };
    if (log) log.push(rec);
    const waits = [];
    const res = await worker.fetch(new Request(url, { method: rec.method, headers, body: init.body }), env, { waitUntil: (p) => waits.push(p), passThroughOnException() {} });
    await Promise.allSettled(waits);
    const text = await res.text();
    rec.status = res.status;
    return { ok: res.status >= 200 && res.status < 300, status: res.status, headers: res.headers, text: async () => text, json: async () => JSON.parse(text) };
  };
}

export const quiet = () => {
  const k = { log: console.log, warn: console.warn, error: console.error, info: console.info };
  console.log = () => {}; console.warn = () => {}; console.error = () => {}; console.info = () => {};
  return () => { console.log = k.log; console.warn = k.warn; console.error = k.error; console.info = k.info; };
};
