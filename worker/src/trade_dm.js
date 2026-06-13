// trade_dm.js — UPS league trade-offer Discord DM + multi-day reminder engine.
//
// When an owner RECEIVES a trade offer (created through our app — mobile builder
// OR desktop War Room, both POST to the same worker handler), we DM the
// recipient the offer + buttons, then nag them on a fixed cadence until they
// answer. Detection is EVENT-DRIVEN (enqueueTradeOfferDm is called from the
// offer-creation hook) because the worker can't poll an owner's pendingTrades
// without their live MFL_USER_ID, which we never store. The reminder cron
// (processTradeOfferReminders) operates ONLY on the trade_offer_dm table and
// reconciles against the stored offers doc to stop the moment an owner acts.
//
// Action buttons are DEEP-LINKS (the owner accepts/declines/counters in their
// own app/War Room session — no commish override). The ONE in-Discord button is
// "🤔 Think about it" (handleTradeThinkButton): it writes no MFL data, only
// flips the reminder track + alerts the offerer.
//
// Anti-spam (we've been burned before — see the 2026-06-01 roast-bot incident):
// trade_id PRIMARY KEY (≤1 first-DM ever), per-boundary last_dm gating, quiet
// hours, feature flag + allowlist checked every tick (kill switch), terminal
// states, reconciliation, and hard caps. See docs / migration 0076.

import { openDmChannel, sendDm } from "./discord_round.js";
import { tradeReminderDecision } from "./trade_dm_cadence.js";

// ───────────────────────── tiny self-contained helpers ─────────────────────
// index.js's safeStr/safeInt/padFranchiseId are request-scoped closures; this
// module re-implements the few it needs so it has no host dependency.
function safeStr(v) { return String(v == null ? "" : v).trim(); }
function safeInt(v, fb) { const n = parseInt(v, 10); return Number.isFinite(n) ? n : (fb == null ? 0 : fb); }
function padFid(v) { const s = safeStr(v).replace(/\D/g, ""); return s ? s.padStart(4, "0") : ""; }
function digits(v) { return safeStr(v).replace(/\D/g, ""); }
function nowIso() { return new Date().toISOString(); }
function jsonResponse(obj) { return new Response(JSON.stringify(obj), { headers: { "Content-Type": "application/json" } }); }
function ephemeral(content) { return jsonResponse({ type: 4, data: { content: safeStr(content).slice(0, 1990), flags: 64 } }); }
function callerId(i) { return safeStr(i?.member?.user?.id || i?.user?.id || ""); }

// ───────────────────────────── config / gates ──────────────────────────────
function tradeDmEnabled(env) { return safeStr(env.TRADE_DM_ENABLED) === "1"; }
function tradeDmAllowlist(env) {
  return safeStr(env.TRADE_DM_TEST_FRANCHISES).split(",").map((s) => padFid(s)).filter(Boolean);
}
// A DM (to recipient OR offerer-alert) is allowed only if the flag is on AND
// (the allowlist is empty = go-live, OR the target franchise is allowlisted).
function tradeDmTargetAllowed(env, franchiseId) {
  if (!tradeDmEnabled(env)) return false;
  const list = tradeDmAllowlist(env);
  if (!list.length) return true;
  return list.includes(padFid(franchiseId));
}
function appBase(env) {
  return safeStr(env.TRADE_DM_APP_BASE) || "https://keithcreelman.github.io/upsmflproduction/m/";
}

// ─────────────────────── discord_owners resolver ───────────────────────────
// ALL active Discord accounts linked to a franchise (a franchise can have more
// than one — e.g. a personal + a commish account — and every one should get the
// message so nothing is missed). Returns a de-duped array of user ids.
export async function resolveDiscordUserIds(env, franchiseId) {
  const fid = padFid(franchiseId);
  if (!fid || !env.UPS_MFL_DB) return [];
  try {
    const res = await env.UPS_MFL_DB.prepare(
      `SELECT discord_user_id FROM discord_owners
       WHERE franchise_id = ? AND active_owner = 'Y'
         AND discord_user_id IS NOT NULL AND discord_user_id != ''`
    ).bind(fid).all();
    const ids = [];
    for (const r of (res?.results || [])) {
      const id = digits(r?.discord_user_id);
      if (id && ids.indexOf(id) === -1) ids.push(id);
    }
    return ids;
  } catch (e) {
    console.error(`[trade-dm] discord_owners lookup failed for ${fid}: ${e?.message || e}`);
    return [];
  }
}

// Fan a DM out to EVERY account in `target` (an array of ids OR a CSV string).
// Returns {sent: count delivered, undeliverable: any 403/50007, firstMsgId}.
export async function dmAll(env, target, payload) {
  const ids = (Array.isArray(target) ? target : String(target || "").split(","))
    .map(digits).filter(Boolean);
  let sent = 0, undeliverable = false, firstMsgId = "";
  for (const uid of ids) {
    const chan = await openDmChannel(env, uid);
    if (!chan) continue;
    const dm = await sendDm(env, chan, payload);
    if (dm.ok) { sent += 1; if (!firstMsgId) firstMsgId = safeStr(dm?.data?.id); }
    else if (dm.status === 403 || digits(dm?.data?.code) === "50007") undeliverable = true;
  }
  return { sent, undeliverable, firstMsgId };
}

// ─────────────────────────── quiet hours (ET) ──────────────────────────────
// 22:00–06:00 ET, DST-aware. Load-bearing here: the hourly cron DOES run
// overnight (unlike the Hall nudge cron), so this guard prevents 3 AM DMs.
function inQuietHoursEt() {
  try {
    const etHour = parseInt(
      new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", hour12: false }).format(new Date()),
      10
    );
    return Number.isFinite(etHour) && (etHour < 6 || etHour >= 22);
  } catch (_) {
    return false;
  }
}

// ────────────────────── asset / summary humanization ───────────────────────
// Build readable asset lists from the stored payload (carries display names),
// from the RECIPIENT's perspective. payload.teams[0]=left=offerer (gives to
// recipient → recipient "gets"); teams[1]=right=recipient (gives to offerer).
function teamFranchiseName(payload, fid) {
  const teams = Array.isArray(payload?.teams) ? payload.teams : [];
  const t = teams.find((x) => padFid(x?.franchise_id) === padFid(fid));
  return safeStr(t?.franchise_name);
}
function teamAssetNames(team) {
  if (!team || typeof team !== "object") return [];
  const out = [];
  const assets = Array.isArray(team.selected_assets) ? team.selected_assets : [];
  for (const a of assets) {
    if (!a || typeof a !== "object") continue;
    const name = safeStr(a.player_name) || safeStr(a.description) || safeStr(a.asset_id);
    if (name) out.push(name);
  }
  const capK = safeInt(team.traded_salary_adjustment_k, 0);
  if (capK > 0) out.push(`$${capK}K cap`);
  return out;
}
function extensionLines(payload, franchiseName) {
  const reqs = Array.isArray(payload?.extension_requests) ? payload.extension_requests : [];
  return reqs.map((e) => {
    const player = safeStr(e?.player_name) || safeStr(e?.player_id);
    const term = safeStr(e?.extension_term) === "2YR" ? "+2 yr" : "+1 yr";
    const aav = safeInt(e?.new_aav_future, 0);
    const by = franchiseName(padFid(e?.from_franchise_id));
    return `${player} ${term}${aav > 0 ? ` @ $${Math.round(aav / 1000)}K` : ""}${by ? ` (by ${by})` : ""}`;
  });
}
// One-line recap (recipient POV) stored on the row so reminders are self-contained.
function recipientSummaryText(payload) {
  const teams = Array.isArray(payload?.teams) ? payload.teams : [];
  const left = teams.find((t) => safeStr(t?.role) === "left") || teams[0];
  const right = teams.find((t) => safeStr(t?.role) === "right") || teams[1];
  const youGet = teamAssetNames(left);   // offerer gives → recipient gets
  const youGive = teamAssetNames(right);  // recipient gives → offerer gets
  const g = youGive.length ? youGive.join(", ") : "—";
  const r = youGet.length ? youGet.join(", ") : "—";
  return `You give ${g}; you get ${r}.`;
}

// ─────────────────────────── deep-links + buttons ──────────────────────────
function mobileDeepLink(env, tradeId, intent) {
  // Query BEFORE the hash so the app's detectContext (URLSearchParams) reads it;
  // the hash routes to the trade view. The owner's app uses its OWN stored
  // session — no token in the link.
  return `${appBase(env)}?focus_trade=${encodeURIComponent(digits(tradeId))}&intent=${encodeURIComponent(intent)}#league/trade`;
}
function warRoomDeepLink(season, leagueId, toFid) {
  const yr = encodeURIComponent(safeStr(season));
  const lid = encodeURIComponent(safeStr(leagueId));
  return `https://www48.myfantasyleague.com/${yr}/home/${lid}?MODULE=MESSAGE6%3DN#twb_left_team=${encodeURIComponent(padFid(toFid))}&twb_side=left`;
}
// Two action rows spanning both surfaces (mobile deep-links + desktop War Room +
// the in-Discord Think button). includeThink=false for terminal messages.
function buildButtons(env, row, opts = {}) {
  const includeThink = opts.includeThink !== false;
  const tid = digits(row.trade_id);
  const rowMobile = {
    type: 1,
    components: [
      { type: 2, style: 5, label: "✅ Accept", url: mobileDeepLink(env, tid, "view") },
      { type: 2, style: 5, label: "❌ Decline", url: mobileDeepLink(env, tid, "decline") },
      { type: 2, style: 5, label: "↩️ Counter", url: mobileDeepLink(env, tid, "counter") },
    ],
  };
  const rowDesktop = {
    type: 1,
    components: [
      { type: 2, style: 5, label: "🖥️ Open in War Room", url: warRoomDeepLink(row.season, row.league_id, row.to_franchise_id) },
    ],
  };
  if (includeThink) {
    rowDesktop.components.push({ type: 2, style: 1, label: "🤔 Think about it", custom_id: `tr:think:${tid}` });
  }
  return [rowMobile, rowDesktop];
}

// ──────────────────────────── message copy ─────────────────────────────────
// "⏳ Expires Sat Jun 20 (in 3 days)." — created_at + TRADE_DM_EXPIRY_DAYS,
// formatted in ET. Empty once expired (the reminder engine has already stopped).
function expiryAdvisory(row, env) {
  const createdMs = Date.parse(row?.created_at_utc);
  if (!Number.isFinite(createdMs)) return "";
  const days = safeInt(env?.TRADE_DM_EXPIRY_DAYS, 7);
  const expiryMs = createdMs + days * 86400000;
  const remMs = expiryMs - Date.now();
  if (remMs <= 0) return "";
  const dateStr = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric",
  }).format(new Date(expiryMs));
  const remDays = Math.floor(remMs / 86400000);
  const remH = Math.round(remMs / 3600000);
  const rel = remDays >= 1 ? `in ${remDays} day${remDays === 1 ? "" : "s"}` : (remH > 0 ? `in ~${remH}h` : "very soon");
  return `⏳ Expires **${dateStr}** (${rel}).`;
}
function day1Content(row, payload, franchiseName, env) {
  const from = safeStr(row.from_franchise_name) || "another owner";
  const teams = Array.isArray(payload?.teams) ? payload.teams : [];
  const left = teams.find((t) => safeStr(t?.role) === "left") || teams[0];
  const right = teams.find((t) => safeStr(t?.role) === "right") || teams[1];
  const youGet = teamAssetNames(left);
  const youGive = teamAssetNames(right);
  const note = safeStr(payload?.comment || payload?.message || "");
  const exts = extensionLines(payload, franchiseName);
  const exp = expiryAdvisory(row, env);
  const lines = [];
  lines.push(`📨 **Trade offer from ${from}**`);
  lines.push("");
  lines.push(`**You'd give:** ${youGive.length ? youGive.join(", ") : "—"}`);
  lines.push(`**You'd get:** ${youGet.length ? youGet.join(", ") : "—"}`);
  if (exts.length) lines.push(`📋 **Pre-trade extension** (applies if you accept): ${exts.join("; ")}`);
  if (note) lines.push(`💬 _${note}_`);
  if (exp) lines.push(exp);
  lines.push("");
  lines.push("Tap **Accept**, **Decline**, or **Counter** to handle it in your app, or **Open in War Room** on desktop. Not sure yet? Hit **🤔 Think about it** and I'll check back on day 4.");
  return lines.join("\n").slice(0, 1990);
}
function reminderContent(key, row, env) {
  const from = safeStr(row.from_franchise_name) || "another owner";
  const recap = safeStr(row.summary_text);
  const recapLine = recap ? `\n_${recap}_` : "";
  const exp = expiryAdvisory(row, env);
  const expLine = exp ? `\n${exp}` : "";
  switch (key) {
    case "nudge":
      return `Quick nudge — ${from}'s trade offer is still in your inbox. Accept, decline, or counter when you get a sec.${recapLine}${expLine}`;
    case "last_call":
      return `Last call on ${from}'s offer before it expires — a quick yes or no keeps things moving.${recapLine}${expLine}`;
    case "think_reminder":
      return `You wanted to sit on ${from}'s offer — here's your nudge. Whenever you've decided, just open it up.${recapLine}${expLine}`;
    default:
      return `${from}'s trade offer is still pending.${recapLine}${expLine}`;
  }
}

// ─────────────────────── enqueue + send the Day-1 DM ────────────────────────
// Called via ctx.waitUntil from the offer-creation hooks. `offer` carries the
// resolved trade id, both franchises, and the storedOffer (with .payload).
export async function enqueueTradeOfferDm(env, offer) {
  try {
    const tradeId = digits(offer?.tradeId);
    const leagueId = safeStr(offer?.leagueId);
    const season = safeStr(offer?.season);
    const fromFid = padFid(offer?.fromFranchiseId);
    const toFid = padFid(offer?.toFranchiseId);
    if (!tradeId || !leagueId || !toFid) return { skipped: "missing_fields" };
    if (!env.UPS_MFL_DB) return { skipped: "no_db" };
    if (!tradeDmTargetAllowed(env, toFid)) return { skipped: tradeDmEnabled(env) ? "not_in_allowlist" : "flag_off" };

    const recipientUids = await resolveDiscordUserIds(env, toFid);
    const offererUids = await resolveDiscordUserIds(env, fromFid);
    const stored = offer?.storedOffer && typeof offer.storedOffer === "object" ? offer.storedOffer : {};
    const payload = stored.payload && typeof stored.payload === "object" ? stored.payload : null;
    // Prefer the payload's team names (the builder sets real names there) so
    // counter offers — which pass empty franchise names — still read nicely.
    const fromName = teamFranchiseName(payload, fromFid) || safeStr(offer?.fromFranchiseName) || safeStr(stored.from_franchise_name) || fromFid;
    const toName = teamFranchiseName(payload, toFid) || safeStr(offer?.toFranchiseName) || safeStr(stored.to_franchise_name) || toFid;
    const franchiseName = (fid) => {
      const f = padFid(fid);
      if (f === fromFid) return fromName;
      if (f === toFid) return toName;
      return f;
    };
    const summaryText = payload ? recipientSummaryText(payload) : "";

    // PK dedupe: a duplicate hook (retry / rollout skew) is a no-op.
    const ins = await env.UPS_MFL_DB.prepare(
      `INSERT INTO trade_offer_dm
         (trade_id, league_id, season, from_franchise_id, to_franchise_id,
          from_franchise_name, to_franchise_name, summary_text,
          recipient_discord_user_id, offerer_discord_user_id,
          created_at_utc, dm_count, track, think_stage, offerer_alerted, state, updated_at_utc)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'main', 0, 0, 'active', ?)
       ON CONFLICT(trade_id) DO NOTHING`
    ).bind(tradeId, leagueId, season, fromFid, toFid, fromName, toName, summaryText, recipientUids.join(","), offererUids.join(","), nowIso(), nowIso()).run();
    if (!ins.meta || ins.meta.changes === 0) return { skipped: "dup" };

    if (!recipientUids.length) {
      await env.UPS_MFL_DB.prepare(
        `UPDATE trade_offer_dm SET state='ended', resolved_reason='no_discord_owner', updated_at_utc=? WHERE trade_id=?`
      ).bind(nowIso(), tradeId).run();
      console.log(`[trade-dm] no discord_owner for recipient ${toFid} (trade ${tradeId}) — row ended`);
      return { skipped: "no_discord_owner" };
    }

    const row = { trade_id: tradeId, league_id: leagueId, season, to_franchise_id: toFid, from_franchise_name: fromName, summary_text: summaryText, created_at_utc: nowIso() };
    const content = payload ? day1Content(row, payload, franchiseName, env) : `📨 **Trade offer from ${fromName}** — open it in your app to see the details and respond.`;
    // Fan the Day-1 DM out to EVERY account linked to the recipient franchise.
    const r1 = await dmAll(env, recipientUids, { content, components: buildButtons(env, row) });
    if (!r1.sent) {
      // 403 / 50007 on all accounts = blocked → terminal, never retry.
      await env.UPS_MFL_DB.prepare(
        `UPDATE trade_offer_dm SET state=?, resolved_reason=?, updated_at_utc=? WHERE trade_id=?`
      ).bind(r1.undeliverable ? "ended" : "active", r1.undeliverable ? "dm_undeliverable" : null, nowIso(), tradeId).run();
      console.log(`[trade-dm] day-1 DM not delivered (undeliverable=${r1.undeliverable}) trade=${tradeId}`);
      return { skipped: r1.undeliverable ? "dm_undeliverable" : "dm_failed" };
    }
    await env.UPS_MFL_DB.prepare(
      `UPDATE trade_offer_dm SET last_dm_utc=?, dm_count=1, bot_message_id=?, updated_at_utc=? WHERE trade_id=?`
    ).bind(nowIso(), r1.firstMsgId, nowIso(), tradeId).run();
    console.log(`[trade-dm] day-1 DM sent to ${r1.sent} account(s): trade=${tradeId} to=${toFid}(${toName})`);
    return { sent: true, accounts: r1.sent, trade_id: tradeId };
  } catch (e) {
    console.error(`[trade-dm] enqueue failed: ${e?.message || e}`);
    return { error: e?.message || String(e) };
  }
}

// ──────────────── reconcile: which offers are still PENDING ─────────────────
// readTradeOffersDoc is request-scoped in index.js; reach it via the admin
// endpoint over the SELF service binding (same pattern as the drop-tracker).
async function fetchPendingTradeIds(env, leagueId, season) {
  if (!env.SELF) return null;
  const apiKey = safeStr(env.COMMISH_API_KEY);
  if (!apiKey) return null;
  try {
    const url = `https://self.invalid/admin/trade-offers/pending-ids?L=${encodeURIComponent(leagueId)}&YEAR=${encodeURIComponent(season)}&APIKEY=${encodeURIComponent(apiKey)}`;
    const res = await env.SELF.fetch(url, { method: "GET" });
    const data = await res.json().catch(() => null);
    if (!data || data.ok !== true || !Array.isArray(data.pending_trade_ids)) return null;
    return new Set(data.pending_trade_ids.map((x) => digits(x)).filter(Boolean));
  } catch (e) {
    console.error(`[trade-dm] pending-ids fetch failed (${leagueId}/${season}): ${e?.message || e}`);
    return null;
  }
}

// ───────────────────────── hourly reminder sweep ───────────────────────────
export async function processTradeOfferReminders(env) {
  if (!env.UPS_MFL_DB) return { skipped: "no_db" };
  if (!tradeDmEnabled(env)) return { skipped: "flag_off" };
  if (inQuietHoursEt()) return { skipped: "quiet_hours" };
  const nowMs = Date.now();
  let sent = 0, resolved = 0, active = 0;

  // 1) Reconcile: resolve rows whose offer is no longer PENDING in the doc.
  try {
    const groups = await env.UPS_MFL_DB.prepare(
      `SELECT DISTINCT league_id, season FROM trade_offer_dm WHERE state='active'`
    ).all();
    for (const g of (groups?.results || [])) {
      const pending = await fetchPendingTradeIds(env, safeStr(g.league_id), safeStr(g.season));
      if (!pending) continue; // doc unavailable this tick — don't false-resolve
      const rows = await env.UPS_MFL_DB.prepare(
        `SELECT trade_id FROM trade_offer_dm WHERE state='active' AND league_id=? AND season=?`
      ).bind(safeStr(g.league_id), safeStr(g.season)).all();
      for (const r of (rows?.results || [])) {
        if (!pending.has(digits(r.trade_id))) {
          await env.UPS_MFL_DB.prepare(
            `UPDATE trade_offer_dm SET state='resolved', resolved_reason='not_pending', updated_at_utc=? WHERE trade_id=?`
          ).bind(nowIso(), safeStr(r.trade_id)).run();
          resolved++;
        }
      }
    }
  } catch (e) {
    console.error(`[trade-dm] reconcile failed: ${e?.message || e}`);
  }

  // 2) Send due reminders.
  let rows;
  try {
    rows = await env.UPS_MFL_DB.prepare(
      `SELECT * FROM trade_offer_dm WHERE state='active' ORDER BY last_dm_utc ASC`
    ).all();
  } catch (e) {
    console.error(`[trade-dm] active select failed: ${e?.message || e}`);
    return { sent, resolved, error: e?.message || String(e) };
  }
  for (const row of (rows?.results || [])) {
    active++;
    // Kill switch / allowlist re-check each tick.
    if (!tradeDmTargetAllowed(env, row.to_franchise_id)) continue;
    const decision = tradeReminderDecision(row, nowMs, env);
    if (!decision.due && !decision.terminal) continue;

    // Send a message if one is attached (terminal can carry a final message).
    if (decision.message) {
      const includeThink = !decision.terminal && safeStr(row.track) !== "thinking";
      const rr = await dmAll(env, row.recipient_discord_user_id, {
        content: reminderContent(decision.message, row, env),
        components: buildButtons(env, row, { includeThink }),
      });
      if (!rr.sent) {
        if (rr.undeliverable) {
          await env.UPS_MFL_DB.prepare(
            `UPDATE trade_offer_dm SET state='ended', resolved_reason='dm_undeliverable', updated_at_utc=? WHERE trade_id=?`
          ).bind(nowIso(), safeStr(row.trade_id)).run();
        }
        continue;
      }
      sent++;
      // Thinking track fires exactly one reminder (day 4), so stage caps at 1.
      const nextStage = decision.advanceThinkStage ? 1 : safeInt(row.think_stage, 0);
      await env.UPS_MFL_DB.prepare(
        `UPDATE trade_offer_dm SET last_dm_utc=?, dm_count=dm_count+1, think_stage=?, updated_at_utc=? WHERE trade_id=?`
      ).bind(nowIso(), nextStage, nowIso(), safeStr(row.trade_id)).run();
    }

    // Terminal → resolve (after sending any final message).
    if (decision.terminal) {
      await env.UPS_MFL_DB.prepare(
        `UPDATE trade_offer_dm SET state='resolved', resolved_reason=?, updated_at_utc=? WHERE trade_id=?`
      ).bind(safeStr(decision.reason) || "terminal", nowIso(), safeStr(row.trade_id)).run();
      resolved++;
    }
  }
  return { sent, resolved, active };
}

// ───────────────────── "🤔 Think about it" button ──────────────────────────
// custom_id = "tr:think:<tradeId>". Writes NO MFL data: flips the track to
// 'thinking' (suspends the main cadence → next reminder in +5 days) and alerts
// the offerer. Idempotent.
export async function handleTradeThinkButton(interaction, env, ctx) {
  const customId = safeStr(interaction?.data?.custom_id || "");
  const parts = customId.split(":");
  if (parts[0] !== "tr" || parts[1] !== "think") return ephemeral("Unknown button.");
  const tradeId = digits(parts[2]);
  if (!tradeId || !env.UPS_MFL_DB) return ephemeral("This offer isn't available anymore.");

  let row;
  try {
    row = await env.UPS_MFL_DB.prepare(`SELECT * FROM trade_offer_dm WHERE trade_id=?`).bind(tradeId).first();
  } catch (e) {
    console.error(`[trade-dm] think lookup failed: ${e?.message || e}`);
    return ephemeral("Something went wrong — try again from your app.");
  }
  if (!row || safeStr(row.state) !== "active") return ephemeral("This offer isn't active anymore.");

  const caller = digits(callerId(interaction));
  const recipientIds = String(row.recipient_discord_user_id || "").split(",").map(digits).filter(Boolean);
  if (caller && recipientIds.length && recipientIds.indexOf(caller) === -1) {
    return ephemeral("Only the owner this offer was sent to can do that.");
  }
  if (safeStr(row.track) === "thinking") {
    return ephemeral("Already flagged as thinking — I'll keep the other owner posted and check back in a bit.");
  }

  try {
    await env.UPS_MFL_DB.prepare(
      `UPDATE trade_offer_dm SET track='thinking', think_pressed_utc=?, think_stage=0, updated_at_utc=? WHERE trade_id=?`
    ).bind(nowIso(), nowIso(), tradeId).run();
  } catch (e) {
    console.error(`[trade-dm] think update failed: ${e?.message || e}`);
    return ephemeral("Something went wrong — try again from your app.");
  }

  // Alert the offerer (fire-and-forget so we stay within Discord's 3s budget).
  const offererCsv = safeStr(row.offerer_discord_user_id);
  const recipName = safeStr(row.to_franchise_name) || "The other owner";
  if (offererCsv && !safeInt(row.offerer_alerted, 0)) {
    const alert = (async () => {
      try {
        const ar = await dmAll(env, offererCsv, {
          content: `🤔 **${recipName}** is thinking about your offer — no yes or no yet, but it's on their radar. I'll keep you posted.`.slice(0, 1990),
        });
        if (ar.sent) {
          await env.UPS_MFL_DB.prepare(
            `UPDATE trade_offer_dm SET offerer_alerted=1, updated_at_utc=? WHERE trade_id=?`
          ).bind(nowIso(), tradeId).run();
        }
      } catch (e) {
        console.error(`[trade-dm] offerer alert failed: ${e?.message || e}`);
      }
    })();
    if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(alert); else await alert;
  }

  const fromName = safeStr(row.from_franchise_name) || "them";
  return ephemeral(`Got it — I told ${fromName} you're mulling it over. I'll check back in a few days instead of nagging you daily.`);
}

// ───────────── offerer alert on decline (called from the action route) ──────
// When the recipient DECLINES, DM the OFFERER (the sending owner) that their
// offer was turned down, plus the decliner's optional note. Only fires for
// offers the DM system tracked (a trade_offer_dm row exists = it was
// allowlisted). Accept is announced league-wide by the Trade Roast bot;
// counter sends the original offerer a fresh offer DM; "think" is handled by
// the button. Fans out to all of the offerer's linked accounts.
export async function notifyOffererOfDecline(env, tradeId, message) {
  try {
    if (!tradeDmEnabled(env)) return { skipped: "flag_off" };
    const tid = digits(tradeId);
    if (!tid || !env.UPS_MFL_DB) return { skipped: "no_id" };
    const row = await env.UPS_MFL_DB.prepare(`SELECT * FROM trade_offer_dm WHERE trade_id=?`).bind(tid).first();
    if (!row) return { skipped: "no_row" };
    const offererCsv = safeStr(row.offerer_discord_user_id);
    if (!offererCsv) return { skipped: "no_offerer_discord" };
    const recipName = safeStr(row.to_franchise_name) || "The other owner";
    const note = safeStr(message);
    const content = `❌ **${recipName}** declined your trade offer.${note ? `\n💬 _${note}_` : ""}`.slice(0, 1990);
    const r = await dmAll(env, offererCsv, { content });
    console.log(`[trade-dm] decline alert sent to ${r.sent} account(s): trade=${tid}`);
    return { sent: r.sent };
  } catch (e) {
    console.error(`[trade-dm] notifyOffererOfDecline failed: ${e?.message || e}`);
    return { error: e?.message || String(e) };
  }
}
