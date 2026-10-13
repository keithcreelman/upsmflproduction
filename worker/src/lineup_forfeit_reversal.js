// Reverse a trade made on MFL's own site that moved a forfeited pick (Keith
// 2026-10-12, option B + "Option 2"): the worker turns MFL's commissioner lockout
// off, reverses the WHOLE trade, turns lockout back on, and replies in the trade's
// thread in #transactions tagging the owners involved.
//
//   preview  — read-only: finds the trade, checks every asset, shows the plan and the
//              reply text (plain, no mention). Writes nothing anywhere.
//   run      — the real thing, behind LINEUP_FORFEIT_REVERSAL_ENABLED (off by default).
//
// Holds (does nothing, DMs Keith) unless EVERYTHING is certain:
//   - exactly one MFL trade moved that pick from the forfeiting team to its holder;
//   - every asset in that trade is still where the trade left it (never a partial reversal);
//   - the lockout page parses, and flipping it changes nothing else (mfl_lockout.js).
// One reversal per trade (D1 ledger + lease). Lockout is always switched back on.

import { canonFpToken } from "./lineup_forfeits.js";
import { setLockout, inspectAbilities } from "./mfl_lockout.js";

const _s = (v) => String(v == null ? "" : v).trim();
const _fid = (v) => { const d = _s(v).replace(/\D/g, ""); return d ? d.padStart(4, "0") : ""; };
const _nowIso = () => new Date().toISOString();
const _arr = (x) => (Array.isArray(x) ? x : x ? [x] : []);
const ROUND_WORD = { 1: "first", 2: "second", 3: "third", 4: "fourth", 5: "fifth", 6: "sixth" };
export const LEASE_SEC = 15 * 60;
export const TEST_LEAGUE_ID = "25625";
export const TRANSACTIONS_CHANNEL_DEFAULT = "1059111651846131833";

const LEDGER_DDL = `CREATE TABLE IF NOT EXISTS ups_lineup_forfeit_reversals (
  reversal_key TEXT PRIMARY KEY, league_id TEXT NOT NULL, season INTEGER NOT NULL,
  holder_fid TEXT NOT NULL, owner_fid TEXT NOT NULL, week INTEGER, pick TEXT NOT NULL,
  trade_unix INTEGER NOT NULL, state TEXT NOT NULL, lease_until_unix INTEGER,
  plan_json TEXT, discord_thread_id TEXT, discord_message_id TEXT, mfl_trade_id TEXT,
  lockout_turned_off INTEGER NOT NULL DEFAULT 0, lockout_restored INTEGER NOT NULL DEFAULT 0,
  error TEXT, created_at_utc TEXT NOT NULL, updated_at_utc TEXT NOT NULL)`;

const MFL = "https://www48.myfantasyleague.com";
// MFL API keys are per league: the test league (25625) reads with the commissioner's
// cookie; the real league with its APIKEY.
async function mflJson(env, fetchImpl, season, query) {
  const isTest = new URLSearchParams(query).get("L") === TEST_LEAGUE_ID;
  const key = _s(env && env.MFL_APIKEY);
  const ck = _s(env && (env.MFLTEST_COMMISHCOOKIE || env.MFL_COOKIE));
  const url = `${MFL}/${encodeURIComponent(season)}/export?${query}&JSON=1${!isTest && key ? `&APIKEY=${encodeURIComponent(key)}` : ""}`;
  const headers = { "User-Agent": "upsmflproduction-worker", Accept: "application/json" };
  if (isTest && ck) headers.Cookie = ck.includes("=") ? ck : `MFL_USER_ID=${ck}`;
  try {
    const r = await (fetchImpl || fetch)(url, { headers });
    if (!r.ok) return null;
    return await r.json();
  } catch (_) { return null; }
}

// ── 1. the trade ────────────────────────────────────────────────────────────
// MFL TRADE rows: franchise / franchise1_gave_up / franchise2 / franchise2_gave_up /
// timestamp. Tokens: bare player ids, FP_, DP_, BB_.
export function normalizeTrades(tx) {
  return _arr(tx && tx.transactions && tx.transactions.transaction)
    .filter((t) => t && _s(t.type).toUpperCase() === "TRADE")
    .map((t) => ({
      a: _fid(t.franchise), b: _fid(t.franchise2), unix: Number(t.timestamp) || 0,
      a_gave: _s(t.franchise1_gave_up).split(",").map(_s).filter(Boolean),
      b_gave: _s(t.franchise2_gave_up).split(",").map(_s).filter(Boolean),
    }));
}

// The ONE trade that moved `canonical` from `holder` straight to `owner`, at or after
// `sinceUnix`. { trade } or { error }.
export function findTradeForPick(trades, { canonical, holder, owner, sinceUnix }) {
  const moved = (trades || []).filter((t) => t.unix >= (Number(sinceUnix) || 0) &&
    [...t.a_gave, ...t.b_gave].some((tok) => canonFpToken(tok) === canonical));
  if (!moved.length) return { error: "trade_not_found" };
  if (moved.length > 1) return { error: "pick_traded_more_than_once", count: moved.length };
  const t = moved[0];
  // Orient: `from` = the forfeiting team (gave the pick), `to` = the team now holding it.
  const aGave = t.a_gave.some((tok) => canonFpToken(tok) === canonical);
  const from = aGave ? t.a : t.b, to = aGave ? t.b : t.a;
  if (from !== _fid(holder) || to !== _fid(owner)) return { error: "trade_parties_mismatch", from, to };
  return { trade: { unix: t.unix, from, to, from_gave: aGave ? t.a_gave : t.b_gave, to_gave: aGave ? t.b_gave : t.a_gave } };
}

// ── 2. where every asset is now ──────────────────────────────────────────────
export async function readAssetLocations(env, { season, leagueId, fetchImpl }) {
  const [ros, fdp, dr] = await Promise.all([
    mflJson(env, fetchImpl, season, `TYPE=rosters&L=${encodeURIComponent(leagueId)}`),
    mflJson(env, fetchImpl, season, `TYPE=futureDraftPicks&L=${encodeURIComponent(leagueId)}`),
    mflJson(env, fetchImpl, season, `TYPE=draftResults&L=${encodeURIComponent(leagueId)}`),
  ]);
  if (!ros || !fdp) return null;
  const players = new Map(), fp = new Map(), dp = new Map();
  for (const f of _arr(ros.rosters && ros.rosters.franchise)) for (const p of _arr(f.player)) players.set(_s(p.id), _fid(f.id));
  for (const f of _arr(fdp.futureDraftPicks && fdp.futureDraftPicks.franchise)) {
    for (const p of _arr(f.futureDraftPick)) {
      const c = canonFpToken(`FP_${_fid(p.originalPickFor || f.id)}_${_s(p.year)}_${_s(p.round)}`);
      if (c) fp.set(c, _fid(f.id));
    }
  }
  for (const u of _arr(dr && dr.draftResults && dr.draftResults.draftUnit)) {
    for (const p of _arr(u.draftPick)) {
      if (_s(p.player)) continue; // already used
      const rd = Number(p.round), pk = Number(p.pick);
      if (rd && pk) dp.set(`DP_${String(rd - 1).padStart(2, "0")}_${String(pk - 1).padStart(2, "0")}`, _fid(p.franchise));
    }
  }
  return { players, fp, dp };
}

function whereIs(loc, tok) {
  const t = _s(tok).toUpperCase();
  if (/^\d+$/.test(t)) return loc.players.get(t) || null;
  if (t.startsWith("FP_")) return loc.fp.get(canonFpToken(t)) || null;
  if (t.startsWith("DP_")) return loc.dp.get(t) || null;
  if (t.startsWith("BB_")) return "cap_money"; // MFL checks the balance when the reversal runs
  return null;
}

// Every asset the forfeiting team gave must be on the holder; every asset the holder
// gave must be on the forfeiting team. { ok } or { ok:false, moved:[...] }.
export function cleanCheck(trade, loc, want = "trade_state") {
  const fromSide = want === "trade_state" ? trade.to : trade.from;
  const toSide = want === "trade_state" ? trade.from : trade.to;
  const moved = [];
  for (const tok of trade.from_gave) { const w = whereIs(loc, tok); if (w !== "cap_money" && w !== fromSide) moved.push({ asset: tok, expected: fromSide, now: w }); }
  for (const tok of trade.to_gave) { const w = whereIs(loc, tok); if (w !== "cap_money" && w !== toSide) moved.push({ asset: tok, expected: toSide, now: w }); }
  return moved.length ? { ok: false, moved } : { ok: true };
}

// ── 3. Discord: the trade's thread in #transactions ─────────────────────────
const snowflakeUnix = (id) => { try { return Number((BigInt(_s(id)) >> 22n) + 1420070400000n) / 1000; } catch (_) { return 0; } };
async function discordApi(env, method, path, body) {
  const token = _s(env && (env.DISCORD_BOT_TOKEN || env.DISCORD_BOT));
  if (!token) return { ok: false, status: 0, data: null };
  try {
    const r = await fetch(`https://discord.com/api/v10${path}`, {
      method, headers: { Authorization: `Bot ${token}`, "Content-Type": "application/json", "User-Agent": "upsmflproduction-worker" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { ok: r.ok, status: r.status, data: await r.json().catch(() => null) };
  } catch (_) { return { ok: false, status: 0, data: null }; }
}

// Exactly one thread under the transactions channel, opened within 6 hours after the
// trade (or 10 minutes before), whose name or opening message names both teams.
// Read-only. { thread_id } or { error }.
export async function findTradeThread(env, { channelId, tradeUnix, names, discord }) {
  const call = discord || ((m, p, b) => discordApi(env, m, p, b));
  const guild = _s(env && env.DISCORD_GUILD_ID);
  const active = guild ? await call("GET", `/guilds/${guild}/threads/active`) : { ok: false };
  const archived = await call("GET", `/channels/${channelId}/threads/archived/public?limit=50`);
  if (!active.ok && !archived.ok) return { error: "threads_unreadable" };
  const all = [..._arr(active.data && active.data.threads), ..._arr(archived.data && archived.data.threads)]
    .filter((t) => _s(t.parent_id) === _s(channelId));
  const inWindow = all.filter((t) => { const u = snowflakeUnix(t.id); return u >= tradeUnix - 600 && u <= tradeUnix + 6 * 3600; });
  const lc = (x) => _s(x).toLowerCase();
  const matches = [];
  for (const t of inWindow) {
    let text = lc(t.name);
    if (!names.every((n) => text.includes(lc(n)))) {
      const starter = await call("GET", `/channels/${channelId}/messages/${t.id}`);
      text += " " + lc(starter.ok && starter.data && starter.data.content);
      for (const e of _arr(starter.ok && starter.data && starter.data.embeds)) text += " " + lc(e.title) + " " + lc(e.description);
    }
    if (names.every((n) => text.includes(lc(n)))) matches.push(t);
  }
  if (matches.length !== 1) return { error: matches.length ? "several_threads_match" : "thread_not_found", candidates: matches.length };
  return { thread_id: _s(matches[0].id) };
}

const pickPhrase = (pick) => `${pick.year} ${ROUND_WORD[Number(pick.round)] || `round-${pick.round}`}-round pick`;
export function replyText({ holderName, pick, week, mentionIds }) {
  const tags = (mentionIds || []).map((id) => `<@${id}>`).join(" ");
  return `${tags ? tags + " " : ""}This trade will be reversed. It included ${holderName}'s ${pickPhrase(pick)}, which was forfeited as a lineup-violation penalty (Week ${week}). Every player, pick and cap dollar goes back to its original team.`;
}

// ── 4. the run ───────────────────────────────────────────────────────────────
async function ledger(db) { await db.prepare(LEDGER_DDL).run(); }
async function setRow(db, key, fields) {
  const sets = Object.keys(fields).map((k) => `${k}=?`).join(", ");
  await db.prepare(`UPDATE ups_lineup_forfeit_reversals SET ${sets}, updated_at_utc=? WHERE reversal_key=?`).bind(...Object.values(fields), _nowIso(), key).run();
}

async function defaultAlert(env, text) {
  const ids = _s(env && env.COMMISH_DISCORD_USER_ID).split(/[,\s]+/).filter((x) => /^\d{15,22}$/.test(x));
  if (!ids.length) return;
  const { dmAll } = await import("./trade_dm.js");
  await dmAll(env, ids, { content: text });
}
async function defaultMentions(env, fids) {
  const { resolveDiscordUserIds } = await import("./trade_dm.js");
  const out = [];
  for (const f of fids) for (const id of await resolveDiscordUserIds(env, f)) if (!out.includes(id)) out.push(id);
  return out;
}
async function defaultExec(env, args) {
  const { executeCommishTwoPartyTrade } = await import("./trade_3way.js");
  return executeCommishTwoPartyTrade(env, args);
}
async function defaultFlag(env) {
  const { getFeatureFlag } = await import("./feature_flags.js");
  return !!(await getFeatureFlag(env, "LINEUP_FORFEIT_REVERSAL_ENABLED"));
}

// reservation: { holder_fid, week, pick_year, pick_round, original_owner, reserved_at_utc? }
// owner: the franchise now holding the pick. mode: "preview" | "run".
export async function reverseForfeitedPickTrade(env, opts) {
  // expectDigest (test league): the Abilities Setup fingerprint the page must still match
  // before lockout is switched off; the switch back on must then match the page as left.
  const { season, leagueId, reservation, owner, mode = "preview", nowUnix, expectDigest, deps = {} } = opts || {};
  const db = env && env.UPS_MFL_DB;
  const isTest = _s(leagueId) === TEST_LEAGUE_ID;
  const fetchImpl = deps.fetchImpl;
  const alert = deps.alertImpl || ((t) => defaultAlert(env, t));
  const say = async (t) => { if (!isTest && mode === "run") { try { await alert(t); } catch (_) { /* best effort */ } } return t; };
  const now = Number(nowUnix) || Math.floor(Date.now() / 1000);
  const holder = _fid(reservation && reservation.holder_fid);
  const pick = { year: Number(reservation && reservation.pick_year), round: Number(reservation && reservation.pick_round), original_owner: _fid(reservation && (reservation.original_owner || reservation.holder_fid)) };
  const canonical = canonFpToken(`FP_${pick.original_owner}_${pick.year}_${pick.round}`);
  const week = Number(reservation && reservation.week) || 0;
  if (!holder || !_fid(owner) || !canonical) return { ok: false, held: true, reason: "bad_input" };
  if (mode === "run" && !(await (deps.flagImpl || defaultFlag)(env))) return { ok: false, held: true, reason: "reversal_disabled" };

  // Names (for the thread match and the text).
  const lg = await mflJson(env, fetchImpl, season, `TYPE=league&L=${encodeURIComponent(leagueId)}`);
  const names = {};
  for (const f of _arr(lg && lg.league && lg.league.franchises && lg.league.franchises.franchise)) names[_fid(f.id)] = _s(f.name) || `Team ${_fid(f.id)}`;
  const holderName = names[holder] || `Team ${holder}`, ownerName = names[_fid(owner)] || `Team ${_fid(owner)}`;

  const sinceUnix = reservation && reservation.reserved_at_utc ? Math.floor(Date.parse(reservation.reserved_at_utc) / 1000) || 0 : 0;
  const tx = await mflJson(env, fetchImpl, season, `TYPE=transactions&L=${encodeURIComponent(leagueId)}&TRANS_TYPE=TRADE&DAYS=365`);
  if (!tx) return { ok: false, held: true, reason: "transactions_unreadable", told: await say(`⛔ Forfeited-pick trade NOT reversed — ${holderName}'s ${pickPhrase(pick)}: MFL's trade list couldn't be read. Nothing was changed.`) };
  const found = findTradeForPick(normalizeTrades(tx), { canonical, holder, owner: _fid(owner), sinceUnix });
  if (found.error) return { ok: false, held: true, reason: found.error, told: await say(`⛔ Forfeited-pick trade NOT reversed — ${holderName}'s ${pickPhrase(pick)} is now with ${ownerName}, but ${found.error.replace(/_/g, " ")}. Nothing was changed; this needs you.`) };
  const trade = found.trade;
  const key = `${_s(leagueId)}|${Number(season)}|${trade.unix}|${trade.from}|${trade.to}`;
  if (mode === "run") {
    // Already handled (or in hand)? Decide from the ledger BEFORE looking at MFL again —
    // after a reversal the assets are back, which must not read as "assets moved".
    if (!db) return { ok: false, held: true, reason: "no_db" };
    await ledger(db);
    const prior = await db.prepare(`SELECT * FROM ups_lineup_forfeit_reversals WHERE reversal_key=?`).bind(key).first();
    if (prior && prior.state === "executing" && Number(prior.lease_until_unix) < now) {
      // A run died mid-way. Never re-run blind: make sure lockout is back on, hold, tell Keith.
      let relock = null;
      if (Number(prior.lockout_turned_off) === 1 && Number(prior.lockout_restored) !== 1) {
        relock = await (deps.lockout ? deps.lockout.set(true) : setLockout(env, { season, leagueId, on: true, fetchImpl: deps.pageFetch }));
        if (relock.ok) await setRow(db, key, { lockout_restored: 1 });
      }
      await setRow(db, key, { state: "held", error: "interrupted" });
      return { ok: false, held: true, reason: "interrupted", relock, told: await say(`⚠️ A forfeited-pick reversal (${holderName}/${ownerName}) was interrupted. It was NOT retried.${relock && !relock.ok ? " 🚨 MFL lockout may still be OFF — turn it on in Setup → Abilities Setup." : ""} Check MFL and the trade.`) };
    }
    if (prior && prior.state !== "planned") return { ok: true, skipped: true, reason: `already_${prior.state}` };
  }
  const loc = await readAssetLocations(env, { season, leagueId, fetchImpl });
  if (!loc) return { ok: false, held: true, reason: "rosters_unreadable", trade, told: await say(`⛔ Forfeited-pick trade NOT reversed — MFL's rosters or picks couldn't be read. Nothing was changed.`) };
  const clean = cleanCheck(trade, loc);
  const plan = {
    trade_unix: trade.unix, forfeiting_team: { fid: trade.from, name: holderName }, holder_now: { fid: trade.to, name: ownerName },
    return_to_forfeiting_team: trade.from_gave, return_to_holder: trade.to_gave, pick: canonical,
  };
  if (!clean.ok) return { ok: false, held: true, reason: "assets_moved", plan, moved: clean.moved,
    told: await say(`⛔ Forfeited-pick trade NOT reversed — some assets from the ${holderName}/${ownerName} trade have moved since (${clean.moved.map((m) => m.asset).join(", ")}). A partial reversal isn't allowed. Nothing was changed; this needs you.`) };

  const channelId = _s(env && (env.DISCORD_TRANSACTIONS_CHANNEL_ID || env.DISCORD_DROPS_CHANNEL_ID)) || TRANSACTIONS_CHANNEL_DEFAULT;
  if (mode !== "run") {
    // Preview: read-only thread lookup (skipped for the test league), plain text, no mentions.
    const thread = isTest ? { skipped: "test_league" } : await findTradeThread(env, { channelId, tradeUnix: trade.unix, names: [holderName, ownerName], discord: deps.discord });
    const lock = deps.lockout ? await deps.lockout.inspect() : await inspectAbilities(env, { season, leagueId, fetchImpl: deps.pageFetch });
    return { ok: true, mode: "preview", plan, thread, lockout_now: lock.ok ? lock.lockout : `unreadable (${lock.error})`,
      reply_preview: replyText({ holderName, pick, week, mentionIds: [] }), writes: 0 };
  }

  // ── run: claim the ledger row (one reversal per trade) ──
  await db.prepare(`INSERT OR IGNORE INTO ups_lineup_forfeit_reversals (reversal_key, league_id, season, holder_fid, owner_fid, week, pick, trade_unix, state, plan_json, created_at_utc, updated_at_utc)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'planned', ?, ?, ?)`).bind(key, _s(leagueId), Number(season), trade.from, trade.to, week, canonical, trade.unix, JSON.stringify(plan), _nowIso(), _nowIso()).run();
  const claim = await db.prepare(`UPDATE ups_lineup_forfeit_reversals SET state='executing', lease_until_unix=?, updated_at_utc=? WHERE reversal_key=? AND state='planned'`)
    .bind(now + LEASE_SEC, _nowIso(), key).run();
  if (Number(claim && claim.meta && claim.meta.changes) !== 1) {
    const row = await db.prepare(`SELECT state FROM ups_lineup_forfeit_reversals WHERE reversal_key=?`).bind(key).first();
    return { ok: true, skipped: true, reason: row ? `already_${row.state}` : "claim_lost" };
  }

  const result = { ok: false, key, plan };
  // a) the reply in the trade's thread (never for the test league).
  if (!isTest) {
    const thread = await findTradeThread(env, { channelId, tradeUnix: trade.unix, names: [holderName, ownerName], discord: deps.discord });
    const mentionIds = await (deps.resolveMentions || ((fids) => defaultMentions(env, fids)))([trade.from, trade.to]);
    const text = replyText({ holderName, pick, week, mentionIds });
    if (thread.thread_id) {
      const call = deps.discord || ((m, p, b) => discordApi(env, m, p, b));
      const posted = await call("POST", `/channels/${thread.thread_id}/messages`, {
        content: text, allowed_mentions: { users: mentionIds, parse: [] },
        nonce: `rv${String(trade.unix).slice(-10)}${trade.from}`.slice(0, 25), enforce_nonce: true,
      });
      await setRow(db, key, { discord_thread_id: thread.thread_id, discord_message_id: posted.ok && posted.data ? _s(posted.data.id) : null });
      result.reply = { thread_id: thread.thread_id, posted: !!posted.ok };
    } else {
      result.reply = { error: thread.error };
      await say(`ℹ️ Couldn't find the #transactions thread for the ${holderName}/${ownerName} trade (${thread.error}). Reversing anyway; post this yourself: ${replyText({ holderName, pick, week, mentionIds: [] })}`);
    }
  }
  // b) lockout off (only if it was on), c) reverse, d) lockout back on — always.
  const lock = deps.lockout || { set: (on, digest) => setLockout(env, { season, leagueId, on, fetchImpl: deps.pageFetch, expectDigest: digest }) };
  let turnedOff = false, offDigest;
  try {
    const off = await lock.set(false, expectDigest || undefined);
    offDigest = off && off.digest_after;
    result.lockout_off = off;
    if (!off.ok) {
      await setRow(db, key, { state: "held", error: `lockout_off_${off.error}` });
      result.reason = "lockout_off_failed";
      result.told = await say(`⛔ Forfeited-pick trade NOT reversed — the worker couldn't switch MFL lockout off (${off.error}${off.restored === false ? "; the page may not be back as it was — check Abilities Setup" : ""}). Nothing was traded.`);
      return result;
    }
    turnedOff = !!off.changed;
    if (turnedOff) await setRow(db, key, { lockout_turned_off: 1 });
    const ex = await (deps.execTrade || ((a) => defaultExec(env, a)))({
      leagueId: _s(leagueId), year: Number(season), fromFid: trade.to, toFid: trade.from,
      give: trade.from_gave, receive: trade.to_gave, mflTokens: true,
      returnForfeited: { canonical, toFid: trade.from },
      commentTag: "[Commish: trade reversed — forfeited pick]", comments: `Lineup penalty, Week ${week}`, cookieAuth: isTest,
    });
    result.exec = ex;
    if (ex && ex.tradeId) await setRow(db, key, { mfl_trade_id: _s(ex.tradeId) });
  } finally {
    if (turnedOff) {
      const on = await lock.set(true, expectDigest ? offDigest : undefined);
      result.lockout_on = on;
      if (on.ok) await setRow(db, key, { lockout_restored: 1 });
      else await say(`🚨 MFL lockout is still OFF after a forfeited-pick reversal — the worker couldn't switch it back on (${on.error}). Turn it on now: Setup → Abilities Setup.`);
    }
  }
  if (!result.exec || !result.exec.ok) {
    await setRow(db, key, { state: "failed", error: _s(result.exec && (result.exec.step + ": " + result.exec.error)).slice(0, 300) });
    result.reason = "reversal_failed";
    result.told = await say(`⛔ The ${holderName}/${ownerName} trade was NOT reversed: MFL refused (${_s(result.exec && result.exec.error).slice(0, 160)}). Lockout is ${result.lockout_on && result.lockout_on.ok ? "back on" : "as it was"}. This needs you.`);
    return result;
  }
  // e) verify on MFL: everything back where it was before the trade.
  const after = await readAssetLocations(env, { season, leagueId, fetchImpl });
  const back = after ? cleanCheck(trade, after, "pre_trade") : { ok: false, moved: [] };
  if (!back.ok) {
    await setRow(db, key, { state: "failed", error: "not_all_assets_back" });
    result.reason = "verify_failed";
    result.told = await say(`⚠️ The ${holderName}/${ownerName} reversal ran on MFL, but not every asset shows back yet. Check the trade on MFL.`);
    return result;
  }
  await setRow(db, key, { state: "reversed", error: null });
  if (db) {
    try {
      await db.prepare(`UPDATE ups_lineup_pick_reservations SET state='reserved', state_changed_at_utc=? WHERE league_id=? AND holder_fid=? AND pick_year=? AND pick_round=? AND state='traded_away' AND released_at_utc IS NULL`)
        .bind(_nowIso(), _s(leagueId), trade.from, pick.year, pick.round).run();
      const { logForfeitEvent } = await import("./lineup_rulings.js");
      await logForfeitEvent(db, { season, leagueId, holder: trade.from, week, event: "trade_reversed", pick, currentOwner: trade.from, detail: { key, plan, mfl_trade_id: result.exec.tradeId || null } });
    } catch (_) { /* audit is best effort; the ledger row is authoritative */ }
  }
  result.ok = true;
  result.told = await say(`✅ Reversed the ${holderName}/${ownerName} trade — ${holderName}'s ${pickPhrase(pick)} was forfeited. Every asset is back${turnedOff ? "; MFL lockout is back on" : ""}.`);
  return result;
}
