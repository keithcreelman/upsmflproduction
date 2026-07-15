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
  { key: "AUCTION_FAA_PENALTIES_ENABLED", label: "FAA missed-nom FINES (real money)", help: "ON = the 9 AM close books §F RULE 2 fines LIVE to the ledger ($3K/$7K/$15K escalating; every fine hits this season AND next — the next-season half stays ledger-only until the rollover). The current-season half auto-posts to MFL as a salaryAdjustment right after the 9 AM close (verified against MFL's export before being marked posted; retry/dry-run via POST /admin/auction/post-rule2-fines). OFF (test mode) = misses are still named in the report and recorded, but PRE-VOIDED — they never count toward the offense ladder and no money is owed. Keep OFF until the real auction opens; excuse/restore any day from the ⚖️ Missed Nominations tab.", danger: true },
  { key: "RULE_PROPOSALS_ENABLED", label: "Rule proposals", help: "Master kill for the rule-proposal system: the 📜 Rule Proposals publish flow, the DM vote cards (Approve/Decline/Discuss), and the private Discuss/Surface loop. OFF = the tab refuses to publish and the rp: buttons answer 'disabled'. Votes already cast stay recorded." },
  { key: "RULE_PROPOSALS_LIVE", label: "Rule proposals LIVE (league-wide)", help: "OFF (dark) = every publish DMs ONLY the commish and runs in the test channel — no league member sees anything, no matter what the form says. This is the shakedown mode: publish, vote, discuss, surface, all solo. ON = publishes fan out to every active owner and post in the Rules channel. Flip this when you're comfortable — everything before that moment was rehearsal.", danger: true },
  { key: "RULE_PROPOSALS_DRAFT_ENABLED", label: "Rule proposals — AI drafting workbench", help: "The commish-only drafting chat on the 📜 Rule Proposals tab: clarifying Q&A, canon challenges, and read-only SQL research over the league database, producing the structured draft. OFF = the workbench refuses to start or continue sessions; the manual publish form is untouched. At publish, a drafted session\u2019s Q&A is distilled into authoritative rulings that ground the owner-facing Discuss bot." },
  { key: "RULE_PROPOSALS_AI_ENABLED", label: "Rule proposals — bot synthesis", help: "The Claude call behind 💬 Discuss (classify the member's message + answer from the rulebook and this proposal's prior Q&A/rulings). OFF = Discuss still logs everything and still offers 📢 Surface with the member's own words ('bot synthesis offline') — voting is never blocked by the AI being off or misbehaving." },
  { key: "AUCTION_NIGHTLY_NUDGE_ENABLED", label: "FAA daily reports (9 AM + 9 PM ET)", help: "ON = two league posts a day during the FA Auction, to the Discord Routing → auctionbidding channel. 9:00 AM ET closes YESTERDAY — the only run that judges a day: names misses and shows the §F RULE 2 amounts (and if the bid ledger is stale it posts NOTHING and DMs the commish instead). 9:00 PM ET is the warning for today in progress, @-tagging only the owners who still owe. One post per report per day, even with both schedulers (Cloudflare cron + the launchd stand-in) alive. Only fires when 'FAA auction live' is also ON. OFF = silent. Manual fire: POST /admin/auction/run-nightly-nudge?live=1&APIKEY=…" },
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
