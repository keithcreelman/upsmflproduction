// A self-contained harness for the FCFS tests: the REAL worker (worker/src/index.js `default.fetch`) under Node.
//   - D1 = node:sqlite behind a D1-shaped adapter (real SQLite semantics)
//   - the ONLY things faked are the network edges: a small stateful MFL, Discord, GitHub — any other outbound call throws
// It depends on nothing but the worker, so it runs on a plain `origin/main` checkout.
import { DatabaseSync } from "node:sqlite";
await import("./register_md_loader.mjs");
const worker = (await import("../../worker/src/index.js")).default;

export const ADMIN_KEY = "admin-key-secret";
export const COMMISH_COOKIE = "COMMISH-COOKIE-SECRET";
export const LEAGUE = "74598";

export function makeD1() {
  const db = new DatabaseSync(":memory:");
  const log = [];
  let tail = Promise.resolve();
  const wrap = (sql, args) => ({
    first: async () => { log.push({ sql, args }); return db.prepare(sql).get(...args) || null; },
    all: async () => { log.push({ sql, args }); return { results: db.prepare(sql).all(...args) }; },
    run: async () => { log.push({ sql, args }); const r = db.prepare(sql).run(...args); return { success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } }; },
  });
  return {
    raw: db, log,
    async exec(sql) { db.exec(sql); },
    prepare(sql) { return { bind: (...args) => wrap(sql, args), ...wrap(sql, []) }; },
    // (a real D1 batch is one atomic, SERIALIZED transaction: two concurrent callers interleave at their READS and meet the write guards — never a transaction collision)
    batch(stmts) {
      const run = tail.then(async () => { const out = []; db.exec("BEGIN"); try { for (const st of stmts) out.push(await st.run()); db.exec("COMMIT"); } catch (e) { db.exec("ROLLBACK"); throw e; } return out; });
      tail = run.catch(() => {});
      return run;
    },
  };
}

export function makeWorkerEnv(over) {
  const db = makeD1();
  return {
    UPS_MFL_DB: db, COMMISH_API_KEY: ADMIN_KEY, MFL_COOKIE: COMMISH_COOKIE, MFL_APIKEY: "mfl-api-key", DISCORD_BOT_TOKEN: "test-token",
    ...(over || {}),
  };
}

/** A minimal stateful MFL: salaries / rosters / transactions / players exports; a salaries import that applies (or is ignored / fails on demand). */
export function makeMfl() {
  const st = {
    salaries: [],            // [{ id, salary, contractStatus, contractYear, contractInfo }]
    rosters: {},             // { fid: [ { id, salary|null, status? } ] }
    transactions: [],        // [{ type, franchise, timestamp, transaction }]
    positions: {},           // { pid: "WR" }
    drafts: {},              // { pid: draftYear } for the rookie test
    imports: [], exports: [], discord: [],
    failNext: null,          // { type, status } → the next import of `type` fails
    salariesImportIgnored: false,   // MFL answers OK and applies nothing (accepted, never landed)
    exportFail: null,        // { type: httpStatus }
    discordFail: false,      // every Discord call answers HTTP 500 (a commissioner DM that never lands)
  };
  const json = (obj, status) => ({ ok: (status || 200) < 400, status: status || 200, headers: new Headers({ "content-type": "application/json" }), text: async () => JSON.stringify(obj), json: async () => obj });
  const xmlOk = () => ({ ok: true, status: 200, headers: new Headers({ "content-type": "text/xml" }), text: async () => "<status>OK</status>", json: async () => ({}) });
  const handle = async (input, init) => {
    init = init || {};
    const url = new URL(String(input));
    const method = (init.method || "GET").toUpperCase();
    const bodyText = typeof init.body === "string" ? init.body : (init.body ? String(init.body) : "");
    const params = new URLSearchParams(method === "POST" && bodyText && !bodyText.startsWith("{") ? bodyText : "");
    for (const [k, v] of url.searchParams) if (!params.has(k)) params.set(k, v);
    if (url.hostname === "discord.com") {
      const b = init.body ? JSON.parse(init.body) : null;
      st.discord.push({ url: url.pathname, method, body: b });
      if (st.discordFail) return json({ message: "Discord boom" }, 500);
      return json(/users\/@me\/channels/.test(url.pathname) ? { id: "dm-" + (b && b.recipient_id) } : { id: "m" + st.discord.length });
    }
    if (/^(www\d+|api)\.myfantasyleague\.com$/.test(url.hostname)) {
      const type = params.get("TYPE");
      if (!/\/import$/.test(url.pathname)) {
        st.exports.push({ type, params: Object.fromEntries(params) });
        if (st.exportFail && st.exportFail[type]) return json({ error: "MFL boom" }, st.exportFail[type]);
        if (type === "salaries") return json({ salaries: { leagueUnit: { player: st.salaries } } });
        if (type === "rosters") return json({ rosters: { franchise: Object.entries(st.rosters).map(([id, ps]) => ({ id, player: ps.map((p) => ({ id: p.id, salary: p.salary === null ? "" : String(p.salary == null ? 5000 : p.salary), status: p.status || "ROSTER" })) })) } });
        if (type === "transactions") { const tt = params.get("TRANS_TYPE"); return json({ transactions: { transaction: st.transactions.filter((x) => !tt || !x.type || x.type === tt) } }); }
        if (type === "players") {
          const want = (params.get("PLAYERS") || params.get("P") || "").split(",").map((x) => x.trim()).filter(Boolean);
          const ids = [...new Set([...Object.keys(st.positions), ...Object.keys(st.drafts)])].filter((id) => !want.length || want.includes(id));
          return json({ players: { player: ids.map((id) => ({ id, position: st.positions[id] || "WR", name: `P${id}, Test`, team: "TST", ...(st.drafts[id] ? { draft_year: String(st.drafts[id]) } : {}) })) } });
        }
        return json({});
      }
      st.imports.push({ type, method, fields: Object.fromEntries(params) });
      if (st.failNext && st.failNext.type === type) { const f = st.failNext; st.failNext = null; return json({ error: "MFL boom" }, f.status || 500); }
      if (type === "salaries") {
        if (st.salariesImportIgnored) return xmlOk();
        const data = params.get("DATA") || "";
        for (const m of data.matchAll(/<player\s+([^>]*?)\s*\/>/g)) {
          const a = Object.fromEntries([...m[1].matchAll(/(\w+)="([^"]*)"/g)].map((x) => [x[1], x[2].replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">")]));
          const row = st.salaries.find((r) => String(r.id) === a.id);
          if (row) Object.assign(row, a); else st.salaries.push(a);
        }
        return xmlOk();
      }
      return json({ ok: true });
    }
    if (url.hostname === "api.github.com" || url.hostname === "raw.githubusercontent.com" || url.hostname === "cdn.jsdelivr.net") return json({ message: "Not Found" }, 404);
    throw new Error(`UNEXPECTED network call in test: ${method} ${url}`);
  };
  const realFetch = globalThis.fetch;
  return { st, install() { globalThis.fetch = handle; }, restore() { globalThis.fetch = realFetch; }, writes: (type) => st.imports.filter((i) => !type || i.type === type) };
}

/** Drive the worker exactly as Cloudflare would. */
export async function callWorker(env, method, pathAndQuery, opts) {
  opts = opts || {};
  const headers = { ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}), ...(opts.headers || {}) };
  const waits = [];
  const res = await worker.fetch(new Request("https://worker.test" + pathAndQuery, { method, headers, body: opts.body !== undefined ? (typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body)) : undefined }),
    env, { waitUntil: (p) => waits.push(p), passThroughOnException() {} });
  await Promise.allSettled(waits);
  const text = await res.text();
  let j = null; try { j = text ? JSON.parse(text) : null; } catch (_) { /* not JSON */ }
  return { status: res.status, json: j, text, headers: res.headers };
}

/** Fire one Cloudflare cron tick exactly as the platform does (with a service binding that calls this same worker, like env.SELF). */
export async function runCron(env, cron) {
  const waits = [];
  const ctx = { waitUntil: (p) => waits.push(p), passThroughOnException() {} };
  env.SELF = { fetch: async (u, i) => { const w = []; const res = await worker.fetch(new Request(String(u), i), env, { waitUntil: (p) => w.push(p), passThroughOnException() {} }); await Promise.allSettled(w); return res; } };
  await worker.scheduled({ cron, scheduledTime: Date.now() }, env, ctx);
  await Promise.allSettled(waits);
}

export const quiet = () => {
  const k = { log: console.log, warn: console.warn, error: console.error, info: console.info };
  console.log = () => {}; console.warn = () => {}; console.error = () => {}; console.info = () => {};
  return () => { console.log = k.log; console.warn = k.warn; console.error = k.error; console.info = k.info; };
};
