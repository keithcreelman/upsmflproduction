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
  { key: "AUCTION_FAA_FINALIZE_ENABLED", label: "FAA auto-finalize (real MFL contracts)", help: "ON = the */5 auction poller auto-writes the REAL 1-year Vet-FAA contract at the won price to MFL for every newly-won non-ERA lot (§A3 — 1 yr unless the owner converts via MYAC). This runs against PROD, so a stray/test won lot would get a real contract too — arm it only after a dry-run preview. OFF = won lots stay MFL's $1K/0-yr stub; the manual admin route /admin/auction/finalize-faa-contracts (+ dry_run=1 preview) works either way.", danger: true },
  { key: "TRADE_SENTINEL_ENABLED", label: "Trade sentinel (watch + mirror)", help: "Hourly commish-side scan of EVERY pending MFL trade offer — including ones made on MFL\u2019s own site — mirrored into D1, plus a fast re-check within 5 minutes of any executed trade. This switch alone never writes to MFL and never DMs anyone; with it OFF the trade-DM engine falls back to its old reconcile behavior." },
  { key: "TRADE_SENTINEL_ACT_ENABLED", label: "Trade sentinel LIVE actions (MFL writes)", help: "ON = the sentinel actually revokes offers whose assets were traded away (recipient gets one \u2018offer is void\u2019 DM, the DM\u2019s buttons go dead, nudges stop) and will run the day-7 silent re-offer that extends offers to 14 days once that path ships. OFF = dry-run \u2014 every action it WOULD take is recorded in the watch table for review; MFL untouched. Flip OFF instantly if it misbehaves; nothing already revoked can be un-revoked.", danger: true },
  { key: "TRADE_SENTINEL_ADOPT_NATIVE", label: "Sentinel adopts native MFL offers into DMs", help: "ON = trade offers created on MFL\u2019s own site get the same Discord treatment as in-app offers (Day-1 DM + nudge cadence). Offers older than 2 hours at first sight join mid-cadence with NO Day-1 blast, so enabling this never sprays the backlog. OFF = native offers are still watched and protected by the sentinel, just not DM\u2019d. (Not yet wired \u2014 candidates are logged in the watch table.)" },
  { key: "RULE_PROPOSALS_ENABLED", label: "Rule proposals", help: "Master kill for the rule-proposal system: the 📜 Rule Proposals publish flow, the DM vote cards (Approve/Decline/Discuss), and the private Discuss/Surface loop. OFF = the tab refuses to publish and the rp: buttons answer 'disabled'. Votes already cast stay recorded." },
  { key: "RULE_PROPOSALS_LIVE", label: "Rule proposals LIVE (league-wide)", help: "OFF (dark) = every publish DMs ONLY the commish and runs in the test channel — no league member sees anything, no matter what the form says. This is the shakedown mode: publish, vote, discuss, surface, all solo. ON = publishes fan out to every active owner and post in the Rules channel. Flip this when you're comfortable — everything before that moment was rehearsal.", danger: true },
  { key: "RULE_PROPOSALS_DRAFT_ENABLED", label: "Rule proposals — AI drafting workbench", help: "The commish-only drafting chat on the 📜 Rule Proposals tab: clarifying Q&A, canon challenges, and read-only SQL research over the league database, producing the structured draft. OFF = the workbench refuses to start or continue sessions; the manual publish form is untouched. At publish, a drafted session\u2019s Q&A is distilled into authoritative rulings that ground the owner-facing Discuss bot." },
  { key: "RULE_PROPOSALS_AI_ENABLED", label: "Rule proposals — bot synthesis", help: "The Claude call behind 💬 Discuss (classify the member's message + answer from the rulebook and this proposal's prior Q&A/rulings). OFF = Discuss still logs everything and still offers 📢 Surface with the member's own words ('bot synthesis offline') — voting is never blocked by the AI being off or misbehaving." },
  { key: "AUCTION_NIGHTLY_NUDGE_ENABLED", label: "FAA daily reports (9 AM + 9 PM ET)", help: "ON = two league posts a day during the FA Auction, to the Discord Routing → auctionbidding channel. 9:00 AM ET closes YESTERDAY — the only run that judges a day: names misses and shows the §F RULE 2 amounts (and if the bid ledger is stale it posts NOTHING and DMs the commish instead). 9:00 PM ET is the warning for today in progress, @-tagging only the owners who still owe. One post per report per day, even with both schedulers (Cloudflare cron + the launchd stand-in) alive. Only fires when 'FAA auction live' is also ON. OFF = silent. Manual fire: POST /admin/auction/run-nightly-nudge?live=1&APIKEY=…" },
  { key: "DROP_TRACKER_ENABLED", label: "Drop tracker (scan + record)", help: "The */5 cron's FREE_AGENT scan: detect player drops on MFL and record them to D1. OFF = no scanning at all, which also means the Discord-post and MFL-penalty halves below never run. Manual fire: POST /admin/drops/scan-and-record." },
  { key: "DROP_TRACKER_AUTO_POST", label: "Drop tracker → Discord posts", help: "Post each newly-recorded drop announcement to the drops channel (prod vs test target comes from DROP_TRACKER_DISCORD_TARGET). Only runs when the drop tracker itself is ON. OFF = drops are still recorded to D1, just silently." },
  { key: "DROP_TRACKER_POST_MFL", label: "Drop tracker → MFL cap penalties (real writes)", help: "ON = each computed drop penalty is auto-written to MFL as a salaryAdjustment — real cap money on real rosters, deduped against MFL's own salaryAdjustments ledger. OFF = penalties are computed and visible but never posted; use /admin/drops/post-mfl to post manually. Only runs when the drop tracker itself is ON.", danger: true },
  { key: "OTB_LIVE_MODE", label: "OTB announcements → LIVE channel", help: "ON = On-The-Block trade-bait announcements (and their discussion threads) post to the live OTB channel the whole league sees. OFF = they route to the test channel — full rehearsal, no league eyes. Flip OFF instantly if the post format misbehaves." },
  { key: "WAIVERS_INAPP_ENABLED", label: "In-app waiver claims + FCFS adds (real MFL writes)", help: "Master kill for the two waiver WRITE routes (POST /api/waivers/bbid-plan and /api/waivers/fcfs). ON = the worker submits MFL's blindBidWaiverRequest / fcfsWaiver forms on your behalf with YOUR owner cookie — a won claim executes a real add AND a real cut. OFF = both routes answer 503 with a link to MFL's own add/drop page, so nobody is stranded. The READ routes (/api/waivers/state, /api/waivers/pending) stay live either way so the UI can still show the next BBID run and your pending claims. Flip OFF immediately if MFL changes its waiver form mid-run.", danger: true },
  { key: "ADD_TRACKER_ENABLED", label: "Add tracker (scan + record)", help: "The */5 cron's BBID_WAIVER + FREE_AGENT scan: detect player ADDS on MFL and record them to ups_add_events. Mirror image of the drop tracker (which owns the dropped side). OFF = no scanning, which also means the Discord-post and contract-annotate halves below never run. Manual fire: POST /admin/adds/scan-and-record." },
  { key: "ADD_TRACKER_AUTO_POST", label: "Add tracker → Discord posts", help: "Post each newly-recorded add to the same Transactions channel the drop tracker uses. Only runs when the add tracker itself is ON. OFF = adds are still recorded to D1, just silently." },
  { key: "WW_CONTRACT_ANNOTATE_ENABLED", label: "WW contract annotator (cosmetic contractInfo only)", help: "ON = after an add lands, append “TCV {n}K| AAV {n}K” to the player’s contractInfo so the WW line reads like every other contract in the app. PRESENTATION ONLY — it never writes salary (MFL already sets salary = winning bid natively) and the missing TCV/AAV does not affect drop-penalty math. Any contractInfo that is NOT MFL’s bare league default is skipped, never reverted, so an owner’s MYM/extension conversion or a commish hand-edit is safe. Still a real MFL write, so it ships dark.", danger: true },
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
