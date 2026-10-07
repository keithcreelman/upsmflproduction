// Seed data + recorders for the 3-way trade tests. The default deal is the SHAPE of
// the real stuck offer found in production on 2026-09-25 (a free-form, non-cycle
// 4-movement 3-way with a pick "via" a fourth team and cap money) — franchise ids,
// player ids and tokens are the real ones; Discord ids are fake.
import { makeD1, applyMigrations, THREE_WAY_MIGRATIONS } from "./d1_sqlite.mjs";

export const FR = { A: "0008", B: "0001", C: "0012", X: "0005", OTHER: "0003" };
export const NAMES = { "0008": "Real Deal Creel", "0001": "L.A. Looks", "0012": "Hawks", "0005": "HammerTime", "0003": "Gride" };
export const PLAYERS = {
  "16614": { name: "Marvin Harrison Jr.", position: "WR", nfl_team: "ARI" },
  "16193": { name: "Kayshon Boutte", position: "WR", nfl_team: "NEP" },
  "16181": { name: "Chase Brown", position: "RB", nfl_team: "CIN" },
  "16650": { name: "Dallas Turner", position: "DL", nfl_team: "MIN" },
};
export const TRADE_ID = "54a0306a-552e-4f79-8d34-98d72eb704a0";
export const DISCORD = { A: "100000000000000001", B: "100000000000000002", C: "100000000000000003" };

export const REAL_LEGS = [
  { from: "0008", to: "0012", asset_tokens: ["P_16614", "P_16193", "FP_0005_2027_1"], cap_k: 0, summary: "Marvin Harrison Jr., Kayshon Boutte, 2027 R1  (via HammerTime)" },
  { from: "0001", to: "0008", asset_tokens: ["P_16181"], cap_k: 16, summary: "Chase Brown" },
  { from: "0001", to: "0012", asset_tokens: ["P_16650"], cap_k: 0, summary: "Dallas Turner" },
  { from: "0012", to: "0001", asset_tokens: ["FP_0012_2027_1"], cap_k: 0, summary: "2027 R1" },
];

export function makeEnv(opts) {
  opts = opts || {};
  const db = makeD1(opts.d1);
  applyMigrations(db, THREE_WAY_MIGRATIONS);
  db.raw.exec("CREATE TABLE IF NOT EXISTS discord_owners (franchise_id TEXT, active_owner TEXT, discord_user_id TEXT)");
  for (const [k, fid] of [["A", FR.A], ["B", FR.B], ["C", FR.C]]) {
    db.raw.prepare("INSERT INTO discord_owners VALUES (?,?,?)").run(fid, "Y", DISCORD[k]);
  }
  // The engine reaches the worker's cap/roster authority through env.SELF (/admin/3way/compliance). By default this
  // models a HEALTHY worker (everyone under the cap) and records the calls; a test passes `opts.compliance` to model
  // any other answer (blocked, unavailable, a bad response) or `opts.self === false` for no service binding at all.
  // The REAL calculation is exercised end to end, through the real worker, in tests/trade_cap_gate.test.mjs.
  const selfCalls = [];
  const healthy = { participants: [], cap: { status: "ok", reason: "", cap_dollars: 300000, rows: [], violations: [], message: "Every team stays under the salary cap." },
    roster: { status: "ok", advisory: true, rows: [], warnings: [], message: "Every team stays within its roster limits." },
    loaded_contracts: { status: "ok", max: 5, rows: [], violations: [], message: "Every team stays at or under the 5 loaded-contract limit." },
    roster_limit: { status: "ok", max: 30, rows: [], violations: [], executable: true, message: "Every team stays at or under the roster maximum." },
    qb_limit: { status: "ok", max: 5, rows: [], violations: [], executable: true, message: "Every team stays at or under 5 active QBs." },
    lineup: { status: "ok", advisory: true, rows: [], warnings: [], message: "Every team can still field a complete legal lineup after this trade." },
    extension_skipped: [] };
  const self = opts.self === false ? undefined : { fetch: async (u, init) => {
    selfCalls.push({ url: String(u), body: init && init.body ? JSON.parse(init.body) : null });
    const c = typeof opts.compliance === "function" ? await opts.compliance(selfCalls[selfCalls.length - 1]) : (opts.compliance || healthy);
    if (c && c.__status) return { ok: false, status: c.__status, json: async () => ({ ok: false }) };
    return { ok: true, status: 200, json: async () => ({ ok: true, compliance: c }) };
  } };
  return { UPS_MFL_DB: db, DISCORD_BOT_TOKEN: "test-token", TRADE_3WAY_ENABLED: "1", COMMISH_API_KEY: "admin-key-secret", ...(self ? { SELF: self } : {}), __selfCalls: selfCalls, ...(opts.env || {}) };
}

export function seedTrade(env, over) {
  const row = {
    id: TRADE_ID, league_id: "74598", season: "2026", status: "collecting",
    initiator_fid: FR.A, team_b_fid: FR.B, team_c_fid: FR.C,
    initiator_name: "Real Deal Creel", team_b_name: "L.A. Looks", team_c_name: "Hawks",
    legs_json: JSON.stringify(REAL_LEGS), team_b_state: "pending", team_c_state: "pending",
    initiator_discord_ids: DISCORD.A, team_b_discord_ids: DISCORD.B, team_c_discord_ids: DISCORD.C,
    failure_reason: null, notes: "", extension_requests_json: "[]",
    created_at_utc: "2026-09-23T20:21:41.139Z", updated_at_utc: "2026-09-23T20:21:41.139Z", executed_at_utc: null,
    mfl_trade_ids: null,
    ...(over || {}),
  };
  const cols = Object.keys(row);
  env.UPS_MFL_DB.raw.prepare(`INSERT INTO ups_3way_trades (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`).run(...cols.map((c) => row[c]));
  return row;
}

export const readRow = (env, id) => env.UPS_MFL_DB.raw.prepare("SELECT * FROM ups_3way_trades WHERE id=?").get(id || TRADE_ID);

// Enrichment deps (what index.js supplies from MFL) — authoritative names/players.
export const goodDeps = {
  franchiseNames: async () => ({ ...NAMES }),
  playersByIds: async ({ ids }) => Object.fromEntries(ids.filter((i) => PLAYERS[i]).map((i) => [i, PLAYERS[i]])),
};

// Viewer objects as trade_3way_http.js produces them from a PROVEN session.
export const viewer = (fid, extra) => ({ fid, sessionFid: fid, isCommish: false, leagueId: "74598", season: "2026", via: "session", ...(extra || {}) });
export const commishViewer = (over) => ({ fid: "0000", sessionFid: "0000", isCommish: true, leagueId: "74598", season: "2026", via: "session", ...(over || {}) });

// Records every Discord REST call the engine makes (dmAll -> openDmChannel + sendDm).
export function installDiscordRecorder() {
  const realFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (u, init) => {
    const url = String(u);
    if (!url.startsWith("https://discord.com/api/")) throw new Error(`unexpected network call in test: ${url}`);
    const body = init && init.body ? JSON.parse(init.body) : null;
    calls.push({ url, method: init && init.method, body });
    const data = /\/users\/@me\/channels$/.test(url) ? { id: `dm-${body.recipient_id}` } : { id: `msg-${calls.length}` };
    return { ok: true, status: 200, text: async () => JSON.stringify(data) };
  };
  return {
    calls,
    messages: () => calls.filter((c) => /\/channels\/dm-[^/]+\/messages$/.test(c.url)),
    to: (userId) => calls.filter((c) => c.url.includes(`/channels/dm-${userId}/messages`)),
    reset: () => { calls.length = 0; },
    restore: () => { globalThis.fetch = realFetch; },
  };
}

// Silence the engine's expected console noise so test output stays readable.
export function quietConsole() {
  const keep = { log: console.log, warn: console.warn, error: console.error };
  console.warn = () => {}; console.error = () => {};
  const origLog = console.log;
  console.log = (...a) => { if (typeof a[0] === "string" && /^\[3way\]|^\[feature-flags\]/.test(a[0])) return; origLog(...a); };
  return () => { console.log = keep.log; console.warn = keep.warn; console.error = keep.error; };
}
