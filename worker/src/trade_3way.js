// trade_3way.js — UPS 3-way trade engine (free-form routing).
//
// Three teams A (initiator), B, C exchange a set of "movements" — each movement
// is one team sending specific assets to another ({from, to, asset_tokens}).
// This covers a clean ring (A->B->C->A) AND deals where teams "work together"
// (A + C both feed B; B sends back to both; etc.). MFL only does 2-party trades,
// so the engine decomposes the movements two ways:
//
//   • Clean cycle (exactly A->B, B->C, C->A)  -> the proven 2-trade HUB path:
//       Trade 1 (A<->B): A gives X, receives Y   (A temporarily holds the Y pass-through)
//       Trade 2 (A<->C): A gives Y, receives Z
//       Net: A -X +Z · B +X -Y · C +Y -Z  ✓
//   • Anything else -> PAIRWISE: one MFL trade per team-pair (a gives its
//       a->b assets, b gives its b->a assets). Up to three trades; a one-sided
//       pair is a valid lopsided MFL trade (give-for-nothing).
//
// Both partners (B, C) consent via an in-Discord Accept button (A is implicit by
// building it). When both accept, the commish (env.MFL_APIKEY) executes every
// leg server-side — the partners never touch MFL. MFL has NO undo for a
// COMPLETED trade, so execution is ordered + verified between legs + all-or-
// nothing with a CRITICAL commish alert on partial failure.
//
// SAFETY GATES:
//   TRADE_3WAY_ENABLED = "1"  -> feature on (DMs, acceptance). Else dark.
//   TRADE_3WAY_EXECUTE = "1"  -> LIVE MFL writes. Else DRY-RUN (logs + DMs
//                               "would execute" but moves no rosters). Default
//                               off so the whole flow is testable safely.
//   TRADE_DM_TEST_FRANCHISES  -> reused allowlist for the rollout.

import { dmAll, resolveDiscordUserIds } from "./trade_dm.js";

// ───────────────────────────── helpers ─────────────────────────────────────
function safeStr(v) { return String(v == null ? "" : v).trim(); }
function safeInt(v, fb) { const n = parseInt(v, 10); return Number.isFinite(n) ? n : (fb == null ? 0 : fb); }
function padFid(v) { const s = safeStr(v).replace(/\D/g, ""); return s ? s.padStart(4, "0") : ""; }
function digits(v) { return safeStr(v).replace(/\D/g, ""); }
function nowIso() { return new Date().toISOString(); }
function newId() { try { return crypto.randomUUID(); } catch (_) { return "3w-" + digits(nowIso()) + "-" + digits(safeStr(Math.floor((Date.now() % 1e9)))); } }
function jsonResponse(obj) { return new Response(JSON.stringify(obj), { headers: { "Content-Type": "application/json" } }); }
function ephemeral(content) { return jsonResponse({ type: 4, data: { content: safeStr(content).slice(0, 1990), flags: 64 } }); }
function callerId(i) { return safeStr(i?.member?.user?.id || i?.user?.id || ""); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

const GIF_URL = "https://media0.giphy.com/media/v1.Y2lkPWVjZjA1ZTQ3ejVjaG5hOHI4emZqdzhzZzZyM2N6ejZ0dXNpZG4xd3hobWlyb3IyNiZlcD12MV9naWZzX3NlYXJjaCZjdD1n/Ve4lppminZGFyGGqYD/200.webp";

// ───────────────────────────── gates ───────────────────────────────────────
function enabled(env) { return safeStr(env.TRADE_3WAY_ENABLED) === "1"; }
function liveExecute(env) { return safeStr(env.TRADE_3WAY_EXECUTE) === "1"; }
function allowlist(env) { return safeStr(env.TRADE_DM_TEST_FRANCHISES).split(",").map(padFid).filter(Boolean); }
function franchiseAllowed(env, fid) {
  const list = allowlist(env);
  if (!list.length) return true;
  return list.includes(padFid(fid));
}

// ─────────────────────── MFL asset-token translation ───────────────────────
// Mirror of _toMflAsset in index.js (/api/trade/process): builder tokens ->
// MFL import tokens. P_<id>-> bare id; FP_<yr>_<rd>_<orig> -> FP_<orig>_<yr>_<rd>;
// DP_<yr>_<rd>_<slot> -> DP_<rd-1>_<slot-1> (0-indexed); BB_<amt> unchanged.
function toMflAsset(a) {
  a = safeStr(a);
  if (a.startsWith("P_")) return a.slice(2);
  if (a.startsWith("BB_")) return `BB_${a.slice(3)}`;
  if (a.startsWith("DP_")) { const [, , rd, slot] = a.split("_"); return `DP_${String(Number(rd) - 1).padStart(2, "0")}_${String(Number(slot) - 1).padStart(2, "0")}`; }
  if (a.startsWith("FP_")) {
    // Robust to token-order variance — the commish path uses FP_<yr>_<rd>_<orig>
    // while the mobile builder emits FP_<orig>_<yr>_<rd>. Identify the year
    // (20xx), the original franchise id (4-digit, e.g. 0001), and the round
    // (1-2 digit), then emit the canonical MFL token FP_<orig>_<yr>_<rd>.
    const parts = a.slice(3).split("_").filter(Boolean);
    const year = parts.find((p) => /^20\d\d$/.test(p)) || "";
    const rest = parts.filter((p) => p !== year);
    const orig = rest.find((p) => p.length === 4) || rest[0] || "";
    const round = rest.find((p) => p !== orig) || "";
    return `FP_${orig}_${year}_${round}`;
  }
  return a;
}

// ───────────── commish 2-party executor (self-contained) ────────────────────
// Propose + accept a 2-party trade server-side with env.MFL_APIKEY (the commish
// can do both sides). Standalone parallel of /api/trade/process (index.js:11878)
// so it's callable from the ctx.waitUntil execution context (no request-scoped
// closures). Returns { ok, tradeId, step, error }.
async function executeCommishTwoPartyTrade(env, { leagueId, year, fromFid, toFid, give, receive, comments }) {
  const apiKey = safeStr(env.MFL_APIKEY);
  if (!apiKey) return { ok: false, step: "config", error: "MFL_APIKEY missing" };
  const giveMfl = (give || []).map(toMflAsset).filter(Boolean).join(",");
  const receiveMfl = (receive || []).map(toMflAsset).filter(Boolean).join(",");
  if (!giveMfl && !receiveMfl) return { ok: false, step: "validate", error: "empty leg" };

  // Step 1 — propose as fromFid
  const proposeUrl = `https://www48.myfantasyleague.com/${year}/import?TYPE=tradeProposal&L=${leagueId}&APIKEY=${encodeURIComponent(apiKey)}&JSON=1`;
  const proposeForm = new URLSearchParams();
  proposeForm.set("FRANCHISE_ID", padFid(fromFid));
  proposeForm.set("OFFEREDTO", padFid(toFid));
  proposeForm.set("WILL_GIVE_UP", giveMfl);
  proposeForm.set("WILL_RECEIVE", receiveMfl);
  proposeForm.set("COMMENTS", "[Commish-processed: 3-way] " + safeStr(comments));
  let proposeResp = "", proposeStatus = 0;
  try {
    const r = await fetch(proposeUrl, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "upsmflproduction-worker" }, body: proposeForm.toString() });
    proposeStatus = r.status; proposeResp = await r.text();
  } catch (e) { return { ok: false, step: "propose", error: `fetch failed: ${e?.message || e}` }; }
  if (!(proposeStatus >= 200 && proposeStatus < 300 && !/error/i.test(proposeResp))) {
    return { ok: false, step: "propose", error: safeStr(proposeResp).slice(0, 300), mfl_status: proposeStatus };
  }

  // Extract trade_id (from the response, else pendingTrades for fromFid)
  let tradeId = "";
  for (const re of [/TradeID[^\d]*(\d{4,})/i, /trade[_ -]?id[^\d]*(\d{4,})/i, /"id"\s*:\s*"?(\d{4,})"?/i, /\bid\s*=\s*"?(\d{4,})"?/i]) {
    const m = proposeResp.match(re); if (m && m[1]) { tradeId = m[1]; break; }
  }
  if (!tradeId) {
    try {
      const u = `https://www48.myfantasyleague.com/${year}/export?TYPE=pendingTrades&L=${leagueId}&FRANCHISE_ID=${padFid(fromFid)}&APIKEY=${encodeURIComponent(apiKey)}&JSON=1`;
      const r = await fetch(u, { headers: { "User-Agent": "upsmflproduction-worker", Accept: "application/json" } });
      const j = await r.json().catch(() => null);
      const root = (j && (j.pendingTrades || j.pendingtrades)) || {};
      let arr = root.pendingTrade || root.pendingtrade || root.trade || root.trades || [];
      if (!Array.isArray(arr)) arr = arr ? [arr] : [];
      // newest matching offer from->to
      for (const t of arr) {
        const tf = padFid(t?.offeringteam || t?.franchise_id || t?.offering_franchise);
        const tt = padFid(t?.offeredto || t?.to_franchise);
        if ((!tf || tf === padFid(fromFid)) && (!tt || tt === padFid(toFid))) {
          const id = digits(t?.trade_id || t?.id); if (id) { tradeId = id; break; }
        }
      }
    } catch (_) {}
  }
  if (!tradeId) return { ok: false, step: "extract_trade_id", error: "no trade_id from propose or pendingTrades" };

  // Step 2 — accept on behalf of toFid
  const acceptUrl = `https://www48.myfantasyleague.com/${year}/import?TYPE=tradeResponse&L=${leagueId}&APIKEY=${encodeURIComponent(apiKey)}&JSON=1`;
  const acceptForm = new URLSearchParams();
  acceptForm.set("TRADE_ID", tradeId);
  acceptForm.set("RESPONSE", "accept");
  acceptForm.set("FRANCHISE_ID", padFid(toFid));
  acceptForm.set("COMMENTS", "[Commish-processed: 3-way]");
  let acceptResp = "", acceptStatus = 0;
  try {
    const r = await fetch(acceptUrl, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "upsmflproduction-worker" }, body: acceptForm.toString() });
    acceptStatus = r.status; acceptResp = await r.text();
  } catch (e) { return { ok: false, step: "accept", tradeId, error: `fetch failed: ${e?.message || e}` }; }
  if (!(acceptStatus >= 200 && acceptStatus < 300 && !/error/i.test(acceptResp))) {
    return { ok: false, step: "accept", tradeId, error: safeStr(acceptResp).slice(0, 300), mfl_status: acceptStatus };
  }
  return { ok: true, tradeId };
}

// Best-effort: does franchise `fid` currently own all the player ids in `tokens`?
// (Picks are not verified — MFL's rosters export doesn't list future picks the
// same way. Players are the common passthrough; this is a guard, not a gate.)
async function rosterOwnsPlayers(env, leagueId, year, fid, tokens) {
  const wantPids = (tokens || []).map(safeStr).filter((t) => t.startsWith("P_")).map((t) => t.slice(2));
  if (!wantPids.length) return true; // nothing player-shaped to verify
  try {
    const apiKey = safeStr(env.MFL_APIKEY);
    const u = `https://www48.myfantasyleague.com/${year}/export?TYPE=rosters&L=${leagueId}&FRANCHISE=${padFid(fid)}&APIKEY=${encodeURIComponent(apiKey)}&JSON=1`;
    const r = await fetch(u, { headers: { "User-Agent": "upsmflproduction-worker", Accept: "application/json" } });
    const j = await r.json().catch(() => null);
    let franchises = j?.rosters?.franchise || [];
    if (!Array.isArray(franchises)) franchises = franchises ? [franchises] : [];
    const f = franchises.find((x) => padFid(x?.id) === padFid(fid)) || franchises[0];
    let players = f?.player || [];
    if (!Array.isArray(players)) players = players ? [players] : [];
    const have = new Set(players.map((p) => digits(p?.id)));
    return wantPids.every((pid) => have.has(digits(pid)));
  } catch (_) { return false; }
}

// ─────────────────────────── message builders ──────────────────────────────
// What a team gives + gets across the free-form movements, each line naming the
// other team involved (so "MHJ → LA Looks", "Caleb Williams ← Sex Manther").
function movementSummaries(row, teamFid) {
  const movements = parseLegs(row);
  const t = padFid(teamFid);
  const gives = [], gets = [];
  for (const m of movements) {
    const from = padFid(m?.from), to = padFid(m?.to);
    const toks = Array.isArray(m?.asset_tokens) ? m.asset_tokens : [];
    const sum = safeStr(m?.summary) || (toks.length ? `${toks.length} asset(s)` : "");
    if (!sum) continue;
    if (from === t) gives.push(`${sum} → ${teamLabel(row, to)}`);
    if (to === t) gets.push(`${sum} ← ${teamLabel(row, from)}`);
  }
  return { gives, gets };
}
function buildPartnerButtons(id) {
  return [{ type: 1, components: [
    { type: 2, style: 3, label: "✅ Accept", custom_id: `tr3:accept:${id}` },
    { type: 2, style: 4, label: "❌ Decline", custom_id: `tr3:decline:${id}` },
  ] }];
}
function partnerDmPayload(row, teamFid) {
  const A = safeStr(row.initiator_name) || "the commish";
  const me = movementSummaries(row, teamFid);
  const bullet = (arr) => (arr.length ? arr.map((x) => `• ${x}`).join("\n") : "• —");
  const lines = [
    `🔀 **${A} has roped you into a 3-way trade.**`,
    `_If you've never had a 3-way, now's your chance — if you have, welcome back._`,
    ``,
    `**You give:**`,
    bullet(me.gives),
    `**You get:**`,
    bullet(me.gets),
  ];
  const note = safeStr(row.notes);
  if (note) lines.push(``, `💬 _${note.slice(0, 300)}_`);
  lines.push(``, `All three have to be in for it to go through. Tap **Accept** or **Decline** — the other two get pinged either way.`);
  return { content: lines.join("\n").slice(0, 1990), embeds: [{ image: { url: GIF_URL } }], components: buildPartnerButtons(row.id) };
}

// ───────────────────────────── data helpers ────────────────────────────────
function parseLegs(row) { try { const v = JSON.parse(row.legs_json || "[]"); return Array.isArray(v) ? v : []; } catch (_) { return []; } }
// Only movements that actually move something.
function parseMovements(row) { return parseLegs(row).filter((m) => m && Array.isArray(m.asset_tokens) && m.asset_tokens.length); }
function pairKey(x, y) { return [padFid(x), padFid(y)].sort().join("|"); }
// Decompose free-form movements into pairwise 2-party trades. For each team-pair
// {a,b} (a<b by fid), a gives its a->b assets and b gives its b->a assets — a
// single MFL trade (possibly lopsided if only one direction has assets).
function pairwiseTrades(movements) {
  const pairs = {};
  for (const m of movements) {
    const from = padFid(m?.from), to = padFid(m?.to);
    const toks = Array.isArray(m?.asset_tokens) ? m.asset_tokens : [];
    if (!from || !to || from === to || !toks.length) continue;
    const key = pairKey(from, to); const [a, b] = key.split("|");
    if (!pairs[key]) pairs[key] = { a, b, aToB: [], bToA: [] };
    if (from === a) pairs[key].aToB.push(...toks); else pairs[key].bToA.push(...toks);
  }
  return Object.values(pairs);
}
// Detect a clean 3-cycle (exactly A->B, B->C, C->A) so we can use the proven
// 2-trade hub path instead of three lopsided pairwise trades. Returns {X,Y,Z}
// (the A->B, B->C, C->A token arrays) or null.
function asCycle(movements, A, B, C) {
  if (movements.length !== 3) return null;
  const edge = {};
  for (const m of movements) edge[`${padFid(m.from)}>${padFid(m.to)}`] = (m.asset_tokens || []);
  const X = edge[`${A}>${B}`], Y = edge[`${B}>${C}`], Z = edge[`${C}>${A}`];
  if (X && Y && Z && Object.keys(edge).length === 3) return { X, Y, Z };
  return null;
}
async function getRow(env, id) {
  try { return await env.UPS_MFL_DB.prepare(`SELECT * FROM ups_3way_trades WHERE id=?`).bind(safeStr(id)).first(); }
  catch (e) { console.error(`[3way] getRow failed: ${e?.message || e}`); return null; }
}
function teamLabel(row, fid) {
  const f = padFid(fid);
  if (f === padFid(row.initiator_fid)) return safeStr(row.initiator_name) || f;
  if (f === padFid(row.team_b_fid)) return safeStr(row.team_b_name) || f;
  if (f === padFid(row.team_c_fid)) return safeStr(row.team_c_name) || f;
  return f;
}

// ───────────────────────── create a 3-way trade ────────────────────────────
// spec: { leagueId, season, initiator:{fid,name}, teamB:{fid,name}, teamC:{fid,name},
//         legs:[{from,to,asset_tokens[],cap_k,summary}] (ring order A->B, B->C, C->A) }
export async function create3WayTrade(env, ctx, spec) {
  try {
    if (!enabled(env)) return { ok: false, error: "3way_disabled" };
    if (!env.UPS_MFL_DB) return { ok: false, error: "no_db" };
    const leagueId = safeStr(spec?.leagueId), season = safeStr(spec?.season);
    const A = padFid(spec?.initiator?.fid), B = padFid(spec?.teamB?.fid), C = padFid(spec?.teamC?.fid);
    if (!leagueId || !season || !A || !B || !C) return { ok: false, error: "missing_fields" };
    if (A === B || B === C || A === C) return { ok: false, error: "teams_must_be_distinct" };
    // Free-form movements ({from, to, asset_tokens}); `legs` accepted as a
    // back-compat alias. Every from/to must be one of the three teams.
    const movements = Array.isArray(spec?.movements) ? spec.movements : (Array.isArray(spec?.legs) ? spec.legs : []);
    if (!movements.length) return { ok: false, error: "no_movements" };
    const fidSet = new Set([A, B, C]);
    for (const m of movements) {
      const from = padFid(m?.from), to = padFid(m?.to);
      if (!fidSet.has(from) || !fidSet.has(to) || from === to) return { ok: false, error: "bad_movement" };
    }
    if (!movements.some((m) => Array.isArray(m?.asset_tokens) && m.asset_tokens.length)) return { ok: false, error: "no_assets" };
    const notes = safeStr(spec?.notes).slice(0, 500);
    // Allowlist: every participant must be allowed during the test rollout.
    if (![A, B, C].every((f) => franchiseAllowed(env, f))) return { ok: false, error: "not_in_allowlist" };

    const [aIds, bIds, cIds] = await Promise.all([resolveDiscordUserIds(env, A), resolveDiscordUserIds(env, B), resolveDiscordUserIds(env, C)]);
    const id = newId();
    await env.UPS_MFL_DB.prepare(
      `INSERT INTO ups_3way_trades
        (id, league_id, season, status, initiator_fid, team_b_fid, team_c_fid,
         initiator_name, team_b_name, team_c_name, legs_json, notes,
         team_b_state, team_c_state, initiator_discord_ids, team_b_discord_ids, team_c_discord_ids,
         created_at_utc, updated_at_utc)
       VALUES (?, ?, ?, 'collecting', ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'pending', ?, ?, ?, ?, ?)`
    ).bind(id, leagueId, season, A, B, C,
      safeStr(spec?.initiator?.name), safeStr(spec?.teamB?.name), safeStr(spec?.teamC?.name), JSON.stringify(movements), notes,
      aIds.join(","), bIds.join(","), cIds.join(","), nowIso(), nowIso()).run();

    const row = await getRow(env, id);
    // DM both partners (B, C) the intro + GIF + Accept/Decline.
    const dm = async (csv, fid) => { const r = await dmAll(env, csv, partnerDmPayload(row, fid)); console.log(`[3way] invite DM to ${fid}: ${r.sent} account(s) (trade ${id})`); };
    if (ctx?.waitUntil) { ctx.waitUntil(dm(bIds.join(","), B)); ctx.waitUntil(dm(cIds.join(","), C)); }
    else { await dm(bIds.join(","), B); await dm(cIds.join(","), C); }
    console.log(`[3way] created ${id}: teams ${A},${B},${C} · ${movements.length} movement(s)`);
    return { ok: true, id };
  } catch (e) {
    console.error(`[3way] create failed: ${e?.message || e}`);
    return { ok: false, error: e?.message || String(e) };
  }
}

// ─────────────────── accept / decline (in-Discord button) ───────────────────
export async function handle3WayButton(interaction, env, ctx) {
  const customId = safeStr(interaction?.data?.custom_id || "");
  const [pfx, action, id] = customId.split(":");
  if (pfx !== "tr3" || !action || !id) return ephemeral("Unknown button.");
  if (!env.UPS_MFL_DB) return ephemeral("This trade isn't available anymore.");
  const row = await getRow(env, id);
  if (!row) return ephemeral("This 3-way trade no longer exists.");
  if (safeStr(row.status) !== "collecting") return ephemeral(`This 3-way trade is already ${row.status}.`);

  const caller = digits(callerId(interaction));
  const isB = String(row.team_b_discord_ids || "").split(",").map(digits).includes(caller);
  const isC = String(row.team_c_discord_ids || "").split(",").map(digits).includes(caller);
  if (!isB && !isC) return ephemeral("Only the two partners can respond to this trade.");
  const myFid = isB ? padFid(row.team_b_fid) : padFid(row.team_c_fid);
  const myCol = isB ? "team_b_state" : "team_c_state";
  const myState = safeStr(isB ? row.team_b_state : row.team_c_state);

  if (action === "decline") {
    await env.UPS_MFL_DB.prepare(`UPDATE ups_3way_trades SET ${myCol}='declined', status='cancelled', failure_reason='declined_by_${myFid}', updated_at_utc=? WHERE id=?`).bind(nowIso(), id).run();
    const who = teamLabel(row, myFid);
    const alert = { content: `❌ **${who}** declined the 3-way trade — it's off.`.slice(0, 1990) };
    const others = [row.initiator_discord_ids, row.team_b_discord_ids, row.team_c_discord_ids].filter((c, i) => {
      const fids = [padFid(row.initiator_fid), padFid(row.team_b_fid), padFid(row.team_c_fid)];
      return fids[i] !== myFid;
    });
    const fire = async () => { for (const c of others) await dmAll(env, c, alert); };
    if (ctx?.waitUntil) ctx.waitUntil(fire()); else await fire();
    return ephemeral("Declined — I let the other two know. It's off.");
  }

  if (action !== "accept") return ephemeral("Button not recognized.");
  if (myState === "accepted") return ephemeral("You're already in — waiting on the other team.");

  await env.UPS_MFL_DB.prepare(`UPDATE ups_3way_trades SET ${myCol}='accepted', updated_at_utc=? WHERE id=?`).bind(nowIso(), id).run();
  const fresh = await getRow(env, id);
  const bothIn = safeStr(fresh.team_b_state) === "accepted" && safeStr(fresh.team_c_state) === "accepted";

  // Alert the other two participants that this team is in.
  const who = teamLabel(fresh, myFid);
  const waitingFid = isB ? padFid(fresh.team_c_fid) : padFid(fresh.team_b_fid);
  const waitingState = isB ? safeStr(fresh.team_c_state) : safeStr(fresh.team_b_state);
  const msg = bothIn
    ? `✅ **${who}** accepted — all three are in! Processing the trade now.`
    : `✅ **${who}** accepted the 3-way. Still waiting on **${teamLabel(fresh, waitingFid)}**.`;
  const targets = [fresh.initiator_discord_ids];
  if (!isB) targets.push(fresh.team_b_discord_ids);
  if (!isC) targets.push(fresh.team_c_discord_ids);
  const fire = async () => { for (const c of targets) await dmAll(env, c, { content: msg.slice(0, 1990) }); };
  if (ctx?.waitUntil) ctx.waitUntil(fire()); else await fire();

  if (bothIn) {
    await env.UPS_MFL_DB.prepare(`UPDATE ups_3way_trades SET status='executing', updated_at_utc=? WHERE id=?`).bind(nowIso(), id).run();
    if (ctx?.waitUntil) ctx.waitUntil(execute3Way(env, id)); else await execute3Way(env, id);
    return ephemeral("You're in — that's everyone! I'm processing the trade now; you'll get a confirmation shortly.");
  }
  return ephemeral(`You're in. Waiting on ${teamLabel(fresh, waitingFid)} to accept.`);
}

// ───────────────────── execute the chained 2-party trades ───────────────────
// Clean cycle -> 2-trade HUB (A holds the pass-through between legs). Otherwise
// -> PAIRWISE, one MFL trade per team-pair. Ordered, verified between legs, and
// all-or-nothing with a CRITICAL commish alert on partial failure. DRY-RUN
// unless TRADE_3WAY_EXECUTE=1.
export async function execute3Way(env, id) {
  const row = await getRow(env, id);
  if (!row || safeStr(row.status) !== "executing") return { skipped: "not_executing" };
  const leagueId = safeStr(row.league_id), year = safeStr(row.season);
  const A = padFid(row.initiator_fid), B = padFid(row.team_b_fid), C = padFid(row.team_c_fid);
  const movements = parseMovements(row);

  const finish = async (status, fields) => {
    const sets = ["status=?", "updated_at_utc=?"]; const binds = [status, nowIso()];
    for (const [k, v] of Object.entries(fields || {})) { sets.push(`${k}=?`); binds.push(v); }
    binds.push(id);
    await env.UPS_MFL_DB.prepare(`UPDATE ups_3way_trades SET ${sets.join(", ")} WHERE id=?`).bind(...binds).run();
  };
  const dmAllThree = async (content) => {
    for (const c of [row.initiator_discord_ids, row.team_b_discord_ids, row.team_c_discord_ids]) await dmAll(env, c, { content: safeStr(content).slice(0, 1990) });
  };
  // Persist executed trade ids into the legacy two id columns + the CSV column.
  const progressFields = (done) => {
    const f = { mfl_trade_ids: done.join(",") };
    if (done[0]) f.mfl_trade1_id = done[0];
    if (done[1]) f.mfl_trade2_id = done[1];
    return f;
  };

  // Build the ordered execution plan.
  const cyc = asCycle(movements, A, B, C);
  let plan, mode;
  if (cyc) {
    mode = "cycle/hub";
    plan = [
      { fromFid: A, toFid: B, give: cyc.X, receive: cyc.Y, label: "hub-1" },
      { fromFid: A, toFid: C, give: cyc.Y, receive: cyc.Z, label: "hub-2", verifyHold: cyc.Y }, // A must hold the pass-through first
    ];
  } else {
    mode = "pairwise";
    plan = pairwiseTrades(movements).map((p, i) => ({ fromFid: p.a, toFid: p.b, give: p.aToB, receive: p.bToA, label: `pair-${i + 1}` }));
  }
  if (!plan.length) {
    await finish("failed", { failure_reason: "no_executable_legs" });
    await dmAllThree(`⚠️ The 3-way trade had nothing to move — the commish will take a look.`);
    return { ok: false, error: "no_legs" };
  }

  // DRY-RUN: log the plan + tell everyone it's "approved" without moving rosters.
  if (!liveExecute(env)) {
    const planStr = plan.map((p) => `  ${p.label}: ${p.fromFid} gives [${p.give.join(",")}]  <->  ${p.toFid} gives [${p.receive.join(",")}]`).join("\n");
    console.log(`[3way][DRY-RUN] ${id} would execute (${mode}, ${plan.length} trade(s)):\n${planStr}`);
    await finish("completed", { failure_reason: "dry_run", executed_at_utc: nowIso() });
    await dmAllThree(`✅ All three accepted the 3-way trade. _(Dry-run: not yet wired to MFL — the commish will finalize.)_`);
    return { ok: true, dry_run: true, mode, legs: plan.length };
  }

  // LIVE — run each leg in order, all-or-nothing.
  const done = [];
  for (let i = 0; i < plan.length; i++) {
    const leg = plan[i];
    // Hub pass-through: A must actually hold Y before giving it away in leg 2.
    if (leg.verifyHold && leg.verifyHold.length) {
      let owns = false;
      for (let k = 0; k < 4 && !owns; k++) { await sleep(2500); owns = await rosterOwnsPlayers(env, leagueId, year, A, leg.verifyHold); }
      if (!owns) {
        console.error(`[3way] ${id} ${leg.label}: pass-through unverified after ${done.join(",")} — ABORT.`);
        await finish("failed", { ...progressFields(done), failure_reason: `passthrough_unverified_after_${done.join("+") || "leg1"}` });
        await dmAllThree(`⚠️ The first leg of the 3-way went through but the next couldn't verify. **Commish: manual fix needed** (trades ${done.join(", ") || "?"}).`);
        return { ok: false, leg: i + 1, error: "passthrough_unverified", partial: done.length > 0 };
      }
    }
    const r = await executeCommishTwoPartyTrade(env, { leagueId, year, fromFid: leg.fromFid, toFid: leg.toFid, give: leg.give, receive: leg.receive, comments: `3-way ${id} ${leg.label} (${mode})` });
    if (!r.ok) {
      const partial = done.length > 0;
      if (partial) {
        console.error(`[3way] ${id} ${leg.label} FAILED — PARTIAL (already landed: ${done.join(",")}): ${r.step}/${r.error}`);
        await finish("failed", { ...progressFields(done), failure_reason: `PARTIAL_${leg.label}_${r.step}: ${safeStr(r.error).slice(0, 150)} (done=${done.join(",")})` });
        await dmAllThree(`🚨 The 3-way is **partially done** — ${done.length} leg(s) processed, the next failed. **Commish: manual intervention needed** (done: ${done.join(", ")}).`);
      } else {
        console.error(`[3way] ${id} ${leg.label} FAILED (safe — nothing moved): ${r.step}/${r.error}`);
        await finish("failed", { failure_reason: `${leg.label}_${r.step}: ${safeStr(r.error).slice(0, 200)}` });
        await dmAllThree(`⚠️ The 3-way trade couldn't be processed (it failed before anything moved). The commish will take a look.`);
      }
      return { ok: false, leg: i + 1, error: r.error, partial };
    }
    done.push(r.tradeId);
    await finish("executing", progressFields(done)); // checkpoint after each landed leg
  }

  await finish("completed", { ...progressFields(done), executed_at_utc: nowIso() });
  console.log(`[3way] ${id} COMPLETE (${mode}): trades=${done.join(",")}`);
  await dmAllThree(`✅ **3-way trade complete!** Rosters are updated in MFL. (The Roast bot will have the play-by-play.)`);
  return { ok: true, mode, trades: done };
}
