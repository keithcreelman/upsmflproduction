// Bridges a client's fetch() to the REAL worker HTTP handler + real SQLite D1, so
// client code is exercised against the actual server logic (no mocked responses).
await import("./register_md_loader.mjs");
const { handle3WayHttp } = await import("../../worker/src/trade_3way_http.js");
import { goodDeps } from "./trade_3way_fixture.mjs";

export const SESSIONS = { "tok-A": "0008", "tok-B": "0001", "tok-C": "0012", "tok-O": "0003", "tok-commish": "0000" };

export function makeBridge(env, opts) {
  opts = opts || {};
  const calls = [];
  const deps = {
    detectFranchise: async (tok) => (tok === "tok-net" ? { error: "fetch failed" } : SESSIONS[tok] ? { franchise_id: SESSIONS[tok] } : { error: "HTTP 401" }),
    commishFids: () => ["0000"], ...goodDeps, ...(opts.deps || {}),
  };
  const fetchImpl = async (input, init) => {
    init = init || {};
    const url = new URL(String(input));
    const method = (init.method || "GET").toUpperCase();
    calls.push({ method, path: url.pathname, query: Object.fromEntries(url.searchParams), body: init.body ? JSON.parse(init.body) : null });
    if (opts.offline) throw new TypeError("Failed to fetch");
    if (opts.override) { const o = opts.override(method, url, init); if (o) return o; }
    const request = new Request(url, { method, headers: { "Content-Type": "application/json" }, body: init.body });
    const waits = [];
    const resp = await handle3WayHttp({
      request, url, path: url.pathname, env, ctx: { waitUntil: (p) => waits.push(p) }, corsHeaders: {},
      defaultLeagueId: "74598", defaultSeason: "2026",
      browserMflUserId: url.searchParams.get("MFL_USER_ID") || "", cookieMflUserId: "", sessionByApiKey: false, deps,
    });
    await Promise.all(waits);
    if (!resp) return { ok: false, status: 404, text: async () => "" };
    const text = await resp.text();
    return { ok: resp.status >= 200 && resp.status < 300, status: resp.status, text: async () => text };
  };
  return { fetch: fetchImpl, calls };
}
