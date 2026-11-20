// Shared setup for the mobile-beta tests (#1475, Stage 1): the REAL worker on real SQLite, MFL stubbed at the edge (tests/fixtures/worker_harness.mjs).
// Nothing here touches a network, a real credential or production.
import { makeWorkerEnv, makeMfl, callWorker, ADMIN_KEY, LEAGUE } from "./worker_harness.mjs";
import { THREE_WAY_MIGRATIONS } from "./d1_sqlite.mjs";
import { b64urlEncode } from "../../worker/src/beta_session.js";

export { makeMfl, callWorker, ADMIN_KEY, LEAGUE };
export const TEST_KEY = `k1:${b64urlEncode(new Uint8Array(32).fill(0x42))}`;
export const MARKER = { "X-UPS-Client": "beta/test-1" };
export const ALL_FLAGS = ["BETA_ENABLED", "BETA_FLOW_LINEUP", "BETA_FLOW_ROSTER", "BETA_FLOW_TRADES", "BETA_FLOW_WAIVERS", "BETA_FLOW_AUCTION", "BETA_FLOW_CONTRACTS"];

export function makeBetaEnv(over) {
  const env = makeWorkerEnv({ __migrations: [...THREE_WAY_MIGRATIONS, "0176_beta_sessions.sql"], BETA_SESSION_KEY: TEST_KEY, ...(over || {}) });
  env.UPS_MFL_DB.raw.exec("CREATE TABLE IF NOT EXISTS ups_settings (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)");
  return env;
}
/** Set the D1 feature-flag overrides: setFlags(env, { BETA_ENABLED: true, BETA_FLOW_LINEUP: false }). Unlisted flags keep their last value. */
export function setFlags(env, flags) {
  const row = env.UPS_MFL_DB.raw.prepare("SELECT value FROM ups_settings WHERE key = 'feature_flags'").get();
  const cur = row && row.value ? JSON.parse(row.value) : {};
  for (const [k, v] of Object.entries(flags)) cur[k] = v ? "1" : "0";
  env.UPS_MFL_DB.raw.prepare("INSERT INTO ups_settings (key, value) VALUES ('feature_flags', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(cur));
}
export const allOn = (env) => setFlags(env, Object.fromEntries(ALL_FLAGS.map((f) => [f, true])));

/** Invite a franchise through the real admin route (admin key), then hand off from the "original app" and redeem as the beta page would. */
export async function signIn(env, opts) {
  const o = { token: "tok-A", fid: "0008", league: LEAGUE, environment: "live", invite: true, ...(opts || {}) };
  if (o.invite) {
    const inv = await callWorker(env, "POST", `/admin/beta/invites?L=${o.league}&APIKEY=${ADMIN_KEY}`, { body: { franchise_id: o.fid, league_id: o.league, action: "invite" } });
    if (inv.status !== 200) throw new Error("invite failed: " + inv.status + " " + inv.text);
  }
  const h = await callWorker(env, "POST", `/api/beta/handoff?L=${o.league}&YEAR=2026`, { body: { mfl_user_id: o.token } });
  if (h.status !== 200) return { handoff: h };
  const s = await callWorker(env, "POST", `/api/beta/session?L=${o.league}`, { headers: MARKER, body: { code: h.json.code, environment: o.environment } });
  return { handoff: h, session: s, code: h.json.code, sid: s.json && s.json.session_id };
}
export const bearer = (sid, extra) => ({ ...MARKER, Authorization: `Bearer ${sid}`, ...(extra || {}) });

/** Capture every console line while fn runs (the worker must never log a credential). */
export async function captureConsole(fn) {
  const lines = []; const k = { log: console.log, warn: console.warn, error: console.error, info: console.info };
  const grab = (...a) => lines.push(a.map((x) => (typeof x === "string" ? x : (() => { try { return JSON.stringify(x); } catch (_) { return String(x); } })())).join(" "));
  console.log = grab; console.warn = grab; console.error = grab; console.info = grab;
  try { return { result: await fn(), lines }; } finally { console.log = k.log; console.warn = k.warn; console.error = k.error; console.info = k.info; }
}
