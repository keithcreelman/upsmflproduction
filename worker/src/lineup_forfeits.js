// §G3 forfeited draft picks: keep a pick that a lineup-violation penalty has
// claimed from being traded away, and keep the obligation alive until it is
// actually secured (Keith 2026-10-11).
//
//   RESERVED     the exact pick is known and held for the penalty
//   OBLIGATION   the applicable pick's league year does not exist in MFL yet
//                (canon A6: picks more than a year out are not listed or
//                tradeable). Resolved and reserved once MFL lists that year.
//   NEEDS_SELECTION  that year holds several qualifying picks; the
//                commissioner chooses which one (never chosen silently)
//   TRADED_AWAY  a native MFL trade moved the reserved pick after all — the
//                app cannot block MFL's own site, so this is detected after the
//                fact and both the commissioner and the owner are told
//   SECURED      the pick is no longer on any franchise in MFL (the
//                commissioner removed it) — the only state in which the pick
//                half of a penalty may be marked APPLIED
//   RELEASED     the ruling was excused before it posted
//
// The War Room refuses any trade carrying a pick in a live state (reserved,
// obligation, needs_selection, traded_away) at Send, Accept, Recheck and
// Execute. Trades with no future pick never touch D1. If the reservation store
// cannot be read, a trade WITH a future pick is refused (fail closed).

import { readPickInventory, alertOnce, logForfeitEvent, ownPickFirst } from "./lineup_rulings.js";

const _s = (v) => String(v == null ? "" : v).trim();
const _fid = (v) => { const d = _s(v).replace(/\D/g, ""); return d ? d.padStart(4, "0") : ""; };
const _nowIso = () => new Date().toISOString();

export const LIVE_STATES = ["reserved", "obligation", "needs_selection", "traded_away"];
export const FORFEIT_MESSAGE = "A draft pick in this trade was forfeited as a lineup-violation penalty, so it can't be traded. Remove it and send the offer again.";

const ROUND_WORD = { 1: "first", 2: "second", 3: "third", 4: "fourth", 5: "fifth", 6: "sixth" };
const pickWords = (year, round) => `${year} ${ROUND_WORD[Number(round)] || `round-${round}`}-round pick`;

// Every future-pick token spelling the War Room uses → FP_<orig4>_<year>_<round>.
// The year is the 20xx part, the original owner the other 4-digit part, the
// round the 1-2 digit part — in any order (FP_<yr>_<rd>_<orig> and
// FP_<orig>_<yr>_<rd> both occur). Anything else returns null.
export function canonFpToken(tok) {
  const s = _s(tok).toUpperCase();
  if (!s.startsWith("FP_")) return null;
  const parts = s.slice(3).split("_").filter(Boolean);
  if (parts.length !== 3) return null;
  const year = parts.find((p) => /^20\d\d$/.test(p));
  if (!year) return null;
  const rest = parts.filter((p, i) => i !== parts.indexOf(year));
  const orig = rest.find((p) => /^\d{4}$/.test(p));
  const round = rest.find((p) => p !== orig && /^\d{1,2}$/.test(p));
  if (!orig || !round) return null;
  return `FP_${orig}_${year}_${Number(round)}`;
}

const tokenFor = (r) => `FP_${_fid(r.original_owner)}_${Number(r.pick_year)}_${Number(r.pick_round)}`;

// The live forfeited-pick tokens for a league. { ok:false } when unreadable.
export async function forfeitedPickTokens(env, leagueId) {
  const db = env && env.UPS_MFL_DB;
  if (!db) return { ok: false };
  try {
    const { results } = await db.prepare(
      `SELECT * FROM ups_lineup_pick_reservations WHERE league_id=? AND released_at_utc IS NULL AND state IN (${LIVE_STATES.map(() => "?").join(",")})`
    ).bind(String(leagueId), ...LIVE_STATES).all();
    const set = new Map();
    for (const r of (results || [])) {
      set.set(tokenFor(r), r);
      if (r.state === "needs_selection" && r.options_json) {
        try { for (const o of JSON.parse(r.options_json)) set.set(tokenFor({ ...o, pick_year: o.year, pick_round: o.round }), r); } catch (_) { /* the stored pick still blocks */ }
      }
    }
    return { ok: true, set };
  } catch (e) {
    // The reservations table is created by migration 0171, before any
    // reservation can exist; if it is absent there is nothing to forfeit.
    // Anything else — including a missing column (0171 without 0172) —
    // fails closed.
    if (/no such table: ups_lineup_pick_reservations/i.test(String(e && e.message))) return { ok: true, set: new Map(), table_absent: true };
    return { ok: false };
  }
}

// War Room DISPLAY: flag each future pick a lineup penalty has taken out of
// trading, so every offer builder shows it greyed out with a short label
// instead of letting an owner build an offer the server will refuse (Keith
// 2026-10-12). Display only — checkForfeitedPicks at Send/Accept/Execute
// stays the authority and fails closed. Mutates `picks` in place: sets
// { forfeited, forfeit_state, forfeit_label } on a match and clears stale
// marks otherwise. Unreadable → nothing marked, { ok:false }.
export const FORFEIT_LABELS = { forfeited: "Forfeited — lineup penalty", on_hold: "On hold — lineup penalty" };
export async function markForfeitedPicks(env, leagueId, picks, tokenOf) {
  const list = (picks || []).filter((p) => p && typeof p === "object");
  for (const p of list) { delete p.forfeited; delete p.forfeit_state; delete p.forfeit_label; }
  const fps = list.map((p) => ({ p, canon: canonFpToken(tokenOf(p)) })).filter((x) => x.canon);
  if (!fps.length) return { ok: true, marked: 0 };
  const live = await forfeitedPickTokens(env, leagueId);
  if (!live.ok) return { ok: false, marked: 0 };
  let marked = 0;
  for (const { p, canon } of fps) {
    const r = live.set.get(canon);
    if (!r) continue;
    // needs_selection: every candidate is held until Keith chooses one.
    const st = r.state === "needs_selection" ? "on_hold" : "forfeited";
    p.forfeited = true; p.forfeit_state = st; p.forfeit_label = FORFEIT_LABELS[st];
    marked += 1;
  }
  return { ok: true, marked };
}

const flatten = (tokens) => (Array.isArray(tokens) ? tokens.map((t) => ({ token: t, sender: null }))
  : Object.entries(tokens || {}).flatMap(([fid, ts]) => (ts || []).map((t) => ({ token: t, sender: _fid(fid) }))));

// THE guard every War Room phase calls. `tokens` = [token] or {fid: [token]}.
//   { ok:true }                                           nothing forfeited
//   { ok:false, http:409, code:"pick_forfeited", ... }    refuse
//   { ok:false, http:503, code:"forfeit_check_unavailable" }  refuse (fail closed)
export async function checkForfeitedPicks(env, leagueId, tokens) {
  const all = flatten(tokens);
  const fps = all.map((x) => ({ ...x, canon: canonFpToken(x.token) })).filter((x) => x.canon);
  const unparsed = all.filter((x) => _s(x.token).toUpperCase().startsWith("FP_") && !canonFpToken(x.token));
  if (!fps.length && !unparsed.length) return { ok: true, checked: 0 };
  if (unparsed.length) return { ok: false, http: 409, code: "pick_token_unreadable", message: "A draft pick in this trade couldn't be identified, so the trade wasn't sent. Rebuild the offer and try again.", tokens: unparsed.map((x) => x.token) };
  const live = await forfeitedPickTokens(env, leagueId);
  if (!live.ok) return { ok: false, http: 503, code: "forfeit_check_unavailable", message: "Couldn't confirm the draft picks in this trade are tradeable right now. Try again in a moment." };
  const bad = fps.filter((x) => live.set.has(x.canon)).map((x) => {
    const r = live.set.get(x.canon);
    return { token: x.token, canonical: x.canon, sender: x.sender, forfeited_by: _fid(r.holder_fid), season: Number(r.season), week: Number(r.week), state: r.state };
  });
  if (bad.length) return { ok: false, http: 409, code: "pick_forfeited", message: FORFEIT_MESSAGE, violations: bad };
  return { ok: true, checked: fps.length };
}

// ── after the fact: obligations, selections, native trades ─────────────────

async function _dm(env, ids, text) {
  if (!ids || !ids.length) return 0;
  const { dmAll } = await import("./trade_dm.js");
  return ((await dmAll(env, ids, { content: text })) || {}).sent || 0;
}
async function _defaultOwnerDm(env, fid, text) {
  const { resolveDiscordUserIds } = await import("./trade_dm.js");
  return _dm(env, await resolveDiscordUserIds(env, fid), text);
}

async function _setState(db, r, fields) {
  const sets = Object.keys(fields).map((k) => `${k}=?`).join(", ");
  return db.prepare(
    `UPDATE ups_lineup_pick_reservations SET ${sets}, state_changed_at_utc=? WHERE season=? AND league_id=? AND holder_fid=? AND week=? AND released_at_utc IS NULL AND state=?`
  ).bind(...Object.values(fields), _nowIso(), Number(r.season), String(r.league_id), _fid(r.holder_fid), Number(r.week), r.state).run();
}

// Hourly. Resolves obligations whose year MFL now lists, flags native trades
// of reserved picks, and recognizes a pick the commissioner has removed.
// Each alert is sent once (ups_lineup_alerts).
export async function reconcileForfeitedPicks(env, { season, leagueId, alertImpl, ownerDmImpl, reverseImpl }) {
  const db = env && env.UPS_MFL_DB;
  if (!db) return { ok: false, error: "no_db" };
  const { results } = await db.prepare(
    `SELECT * FROM ups_lineup_pick_reservations WHERE league_id=? AND released_at_utc IS NULL AND state IN ('reserved','obligation')`
  ).bind(String(leagueId)).all();
  const rows = results || [];
  if (!rows.length) return { ok: true, checked: 0 };
  const inv = await readPickInventory(season, leagueId);
  if (!inv) return { ok: false, error: "pick_inventory_unreadable" };
  const ownerOf = new Map();
  for (const [holder, picks] of Object.entries(inv.byHolder)) for (const p of picks) ownerOf.set(`FP_${_fid(p.original_owner)}_${p.year}_${p.round}`, holder);
  const out = [];
  const say = (r, reason, text, ownerText) => Promise.all([
    alertOnce(env, { season: r.season, leagueId, week: r.week, fid: r.holder_fid, reason, text, alertImpl }),
    ownerText ? alertOnce(env, { season: r.season, leagueId, week: r.week, fid: r.holder_fid, reason: `${reason}:owner`, text: ownerText,
      alertImpl: async (e, t) => (ownerDmImpl || _defaultOwnerDm)(e, _fid(r.holder_fid), t) }) : null,
  ]);
  for (const r of rows) {
    const holder = _fid(r.holder_fid), year = Number(r.pick_year), round = Number(r.pick_round);
    const log = (event, pick, currentOwner, detail) => logForfeitEvent(db, { season: r.season, leagueId, holder, week: r.week, event, pick, currentOwner, detail });
    if (r.state === "obligation") {
      if (!inv.years.includes(year)) { out.push({ holder, state: "obligation", year, waiting: true }); continue; }
      const qualifying = (inv.byHolder[holder] || []).filter((p) => p.year === year && p.round === round);
      // One pick, or several with its own among them (own pick first —
      // Keith 2026-10-12): reserved without asking.
      const chosen = qualifying.length === 1 ? qualifying[0] : ownPickFirst(qualifying, holder);
      if (chosen) {
        await _setState(db, r, { state: "reserved", original_owner: _fid(chosen.original_owner), ownership_basis: "mfl_future_picks" });
        await log("obligation_resolved", { year, round, original_owner: chosen.original_owner }, null, qualifying.length > 1 ? { rule: "own_pick_first", options: qualifying } : undefined);
        out.push({ holder, state: "reserved", year, round, original_owner: _fid(chosen.original_owner) });
      } else if (qualifying.length > 1) {
        await _setState(db, r, { state: "needs_selection", options_json: JSON.stringify(qualifying) });
        await log("needs_selection", { year, round, original_owner: holder }, null, { options: qualifying });
        await say(r, "forfeit_pick_selection", `⚠️ Forfeited-pick choice needed — Team ${holder} owns ${qualifying.length} ${pickWords(year, round)}s for its Week ${r.week} lineup penalty. Choose which one (POST /admin/lineup/forfeit-select).`);
        out.push({ holder, state: "needs_selection", year, round, options: qualifying.length });
      } else {
        // The pick the obligation expected (the team's own, that year) is on
        // ANOTHER franchise: it was traded on MFL before it could be reserved.
        // Keep the auditable record and tell both sides (Keith 2026-10-11).
        const expected = `FP_${holder}_${year}_${round}`;
        const elsewhere = ownerOf.get(expected);
        if (elsewhere && elsewhere !== holder) {
          await log("traded_before_reserve", { year, round, original_owner: holder }, elsewhere);
          await say(r, `forfeit_traded_before_reserve_${year}`,
            `🚨 Team ${holder}'s ${pickWords(year, round)} — owed for its Week ${r.week} lineup penalty — was traded on MFL to Team ${elsewhere} before it could be reserved. The forfeiture moves to the next owned ${ROUND_WORD[round] || round}-round pick; recorded for your review.`,
            `⚠️ Your ${pickWords(year, round)} was owed as a lineup-violation penalty (Week ${r.week}) and was traded on MFL before it could be reserved. The forfeiture still stands and moves to your next owned pick in that round; the commissioner has been told.`);
        }
        // No pick in that round that year: the rule moves to the next year.
        // Kept as an obligation; Keith is told.
        await _setState(db, r, { pick_year: year + 1, original_owner: holder });
        await log("rolled_forward", { year: year + 1, round, original_owner: holder }, null, { from_year: year });
        await say(r, `forfeit_obligation_rolled_${year}`, `ℹ️ Team ${holder} owns no ${pickWords(year, round)}; its Week ${r.week} forfeiture now applies to its ${pickWords(year + 1, round)} (kept as an obligation until MFL lists it).`);
        out.push({ holder, state: "obligation", year: year + 1, rolled: true });
      }
      continue;
    }
    // reserved
    const tok = tokenFor(r);
    if (!inv.years.includes(year)) {
      // The year has left the future-pick list (it is now the current draft)
      // and the pick was never secured.
      await log("unsecured_at_draft", { year, round, original_owner: r.original_owner });
      await say(r, "forfeit_pick_unsecured_at_draft", `⚠️ Team ${holder}'s forfeited ${pickWords(year, round)} reached its draft year without being removed on MFL. Remove it before the draft.`);
      out.push({ holder, state: "reserved", year, unsecured_at_draft: true });
      continue;
    }
    const owner = ownerOf.get(tok);
    if (owner === holder) { out.push({ holder, state: "reserved", ok: true }); continue; }
    if (owner) {
      await _setState(db, r, { state: "traded_away" });
      await log("traded_away", { year, round, original_owner: r.original_owner }, owner);
      await say(r, "forfeited_pick_traded",
        `🚨 A forfeited pick was traded on MFL — Team ${holder}'s ${pickWords(year, round)} (lineup penalty, Week ${r.week}) now belongs to Team ${owner}. The app cannot block MFL's own site. The forfeiture is NOT applied; decide how to recover it.`,
        `⚠️ Your ${pickWords(year, round)} was forfeited as a lineup-violation penalty (Week ${r.week}) and has just been traded on MFL to Team ${owner}. The forfeiture still stands; the commissioner will follow up.`);
      // Keith 2026-10-12: reverse that trade (the worker switches MFL lockout off and
      // back on). LINEUP_FORFEIT_REVERSAL_ENABLED gates it inside; off = nothing moves.
      let reversal = null;
      try {
        const run = reverseImpl || (async (a) => (await import("./lineup_forfeit_reversal.js")).reverseForfeitedPickTrade(env, a));
        reversal = await run({ season: r.season, leagueId, owner, mode: "run",
          reservation: { holder_fid: r.holder_fid, week: r.week, pick_year: r.pick_year, pick_round: r.pick_round, original_owner: r.original_owner, reserved_at_utc: r.reserved_at_utc } });
      } catch (e) { reversal = { ok: false, held: true, reason: `error: ${e && e.message}` }; }
      out.push({ holder, state: "traded_away", owner, reversal: reversal && { ok: !!reversal.ok, reason: reversal.reason || null } });
      continue;
    }
    await _setState(db, r, { state: "secured" });
    await log("secured", { year, round, original_owner: r.original_owner });
    out.push({ holder, state: "secured" });
  }
  return { ok: true, checked: rows.length, results: out };
}

// The commissioner picks which of several qualifying picks is forfeited —
// from the obligation flow here, or re-checked against MFL before reserving.
export async function selectForfeitedPick(env, { season, leagueId, fid, week, pickChoice }) {
  const db = env && env.UPS_MFL_DB;
  if (!db) return { ok: false, error: "no_db" };
  const r = await db.prepare(`SELECT * FROM ups_lineup_pick_reservations WHERE season=? AND league_id=? AND holder_fid=? AND week=? AND released_at_utc IS NULL`)
    .bind(Number(season), String(leagueId), _fid(fid), Number(week)).first();
  if (!r) return { ok: false, error: "no_reservation" };
  if (r.state !== "needs_selection") return { ok: false, error: `state_${r.state}` };
  let options = [];
  try { options = JSON.parse(r.options_json || "[]"); } catch (_) { options = []; }
  const pick = options.find((o) => `${o.year}-${o.round}-${_fid(o.original_owner)}` === _s(pickChoice));
  if (!pick) return { ok: false, error: "not_an_option", options: options.map((o) => `${o.year}-${o.round}-${_fid(o.original_owner)}`) };
  const inv = await readPickInventory(season, leagueId);
  if (!inv) return { ok: false, error: "pick_inventory_unreadable" };
  const stillOwned = (inv.byHolder[_fid(fid)] || []).some((p) => p.year === pick.year && p.round === pick.round && _fid(p.original_owner) === _fid(pick.original_owner));
  if (!stillOwned) return { ok: false, error: "choice_no_longer_owned" };
  try {
    await _setState(db, r, { state: "reserved", pick_year: pick.year, pick_round: pick.round, original_owner: _fid(pick.original_owner), ownership_basis: "mfl_future_picks", options_json: null });
  } catch (e) {
    return { ok: false, error: "pick_already_reserved", detail: _s(e && e.message) };
  }
  await logForfeitEvent(db, { season, leagueId, holder: fid, week, event: "selected", pick });
  return { ok: true, state: "reserved", pick };
}

// The three stages Keith distinguishes (2026-10-11) for one ruling's penalty:
//   assessed  the league ruling is recorded (an obligation, a pending choice,
//             or a pick traded away all stay here)
//   reserved  the exact pick is held (or already removed on MFL) — not yet
//             applied until the cap half is verified too
//   applied   the exact pick/cap action is verified on MFL
export function penaltyStage({ sanctionStatus, pickState }) {
  if (sanctionStatus === "applied") return "applied";
  if (!sanctionStatus || sanctionStatus === "none") return "none";
  if (pickState === "reserved" || pickState === "secured") return "reserved";
  return "assessed";
}

// Staged 2-way / 3-way movements [{from, to, asset_tokens}] → {sender: [tokens]}.
export function movementsToTokens(movements) {
  const out = {};
  for (const m of (Array.isArray(movements) ? movements : [])) {
    const fid = _fid(m && m.from);
    for (const t of (m && Array.isArray(m.asset_tokens) ? m.asset_tokens : [])) (out[fid] = out[fid] || []).push(t);
  }
  return out;
}
