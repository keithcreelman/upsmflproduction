// feature_flags.js — runtime-overridable kill switches.
//
// The commish flips these from the FO commish-settings panel; the worker reads
// the D1 override (ups_settings key 'feature_flags') with the wrangler.toml env
// var as the default. This lets the commish disable/enable a feature WITHOUT a
// redeploy. Mirrors the existing getDiscordRoutingConfig read-through pattern
// (index.js), but the fallback is the env var, not a hardcoded default.

function safeStr(v) { return String(v == null ? "" : v).trim(); }

// The flags the commish can toggle. `key` is the wrangler.toml env var name.
export const FEATURE_FLAGS = [
  { key: "TRADE_DM_ENABLED",   label: "Trade-offer DMs",      help: "DM owners when they receive a trade offer, plus the reminder cadence." },
  { key: "TRADE_3WAY_ENABLED", label: "3-way trades",         help: "Arm the 3-way feature — the builders, partner DMs, and acceptance." },
  { key: "TRADE_3WAY_EXECUTE", label: "3-way LIVE execution", help: "ON = an accepted 3-way actually moves rosters in MFL (can't be undone). OFF = dry-run (everything runs but no rosters move).", danger: true },
  { key: "AUCTION_INAPP_BID_ENABLED", label: "In-app auction bidding", help: "Master kill for in-app bidding (both app + desktop). ON = the worker submits MFL's auction form on your behalf. OFF = buttons fall back to MFL's auction page. Flip OFF immediately if MFL changes its auction page and bidding breaks mid-auction.", danger: true },
  { key: "AUCTION_ERA_ENABLED", label: "ERA auction live", help: "ON = the Expired-Rookie Auction is running — the ERA tab goes live (board + bidding) on the app + desktop. OFF = the ERA tab shows a read-only eligible pool. Flip ON when ERA opens (Memorial Day weekend)." },
  { key: "AUCTION_FAA_ENABLED", label: "FAA auction live", help: "ON = the Free-Agent Auction is running — the FAA tab goes live (board + bidding) on the app + desktop. OFF = the FAA tab shows a read-only available pool. Flip ON when the FA Auction opens (last weekend of July)." },
  { key: "AUCTION_FAA_PENALTIES_ENABLED", label: "FAA missed-nom FINES (real money)", help: "ON = the 9 AM report APPLIES §F RULE 2 fines for a missed nomination ($3K/$7K/$15K escalating, current season posts to MFL; next season is booked to the ledger and crosses at the rollover). OFF = the report still names misses and shows what WOULD be charged, but no money moves. Keep OFF during pre-auction testing — a shakedown week with 10 teams out of compliance would manufacture $60K of real fines. Arm it when the real auction opens.", danger: true },
  { key: "AUCTION_NIGHTLY_NUDGE_ENABLED", label: "FAA nightly nudge", help: "ON = at 9:30 PM ET each night during the FA Auction, post the nomination scoreboard to the Auction Bidding channel (@-tagging only the owners who still owe) plus a thread with open lots + the positions matrix. No DMs. Only fires when 'FAA auction live' is also ON. OFF = silent. Dry-run any time with POST /admin/auction/run-nightly-nudge?force=1." },
];
const FLAG_KEYS = FEATURE_FLAGS.map((f) => f.key);

async function readOverrides(env) {
  if (!env || !env.UPS_MFL_DB) return {};
  try {
    await env.UPS_MFL_DB.prepare("CREATE TABLE IF NOT EXISTS ups_settings (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)").run();
    const row = await env.UPS_MFL_DB.prepare("SELECT value FROM ups_settings WHERE key='feature_flags'").first();
    const cfg = row && row.value ? JSON.parse(row.value) : {};
    return cfg && typeof cfg === "object" ? cfg : {};
  } catch (_) { return {}; }
}

// One flag, read-through: a D1 override wins; otherwise the env var. "1" => on.
export async function getFeatureFlag(env, name) {
  const overrides = await readOverrides(env);
  if (Object.prototype.hasOwnProperty.call(overrides, name)) return String(overrides[name]) === "1";
  return safeStr(env && env[name]) === "1";
}

// Every flag's effective state + source, for the settings UI.
export async function getAllFeatureFlags(env) {
  const overrides = await readOverrides(env);
  return FEATURE_FLAGS.map((f) => {
    const overridden = Object.prototype.hasOwnProperty.call(overrides, f.key);
    const envOn = safeStr(env && env[f.key]) === "1";
    return {
      key: f.key, label: f.label, help: f.help, danger: !!f.danger,
      value: overridden ? String(overrides[f.key]) === "1" : envOn,
      overridden, env_default: envOn,
    };
  });
}

// Merge + persist a partial { KEY: bool | "1" | "0" } update (only known flags).
export async function setFeatureFlags(env, partial) {
  if (!env || !env.UPS_MFL_DB) return { ok: false, error: "no_db" };
  const overrides = await readOverrides(env);
  for (const k of Object.keys(partial || {})) {
    if (FLAG_KEYS.indexOf(k) === -1) continue;
    const v = partial[k];
    overrides[k] = (v === true || v === "1" || v === 1) ? "1" : "0";
  }
  try {
    await env.UPS_MFL_DB.prepare("CREATE TABLE IF NOT EXISTS ups_settings (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)").run();
    await env.UPS_MFL_DB.prepare(
      "INSERT INTO ups_settings (key, value, updated_at) VALUES ('feature_flags', ?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at"
    ).bind(JSON.stringify(overrides), new Date().toISOString()).run();
    return { ok: true };
  } catch (e) { return { ok: false, error: e?.message || String(e) }; }
}
