// A forfeited pick traded on MFL's own site: the worker reverses the WHOLE trade,
// switching MFL commissioner lockout off for it and back on after, and replies in
// the trade's #transactions thread tagging both owners (Keith 2026-10-12).
//   node tests/lineup_forfeit_reversal.test.mjs
//
// Everything here runs against a fake MFL (exports, the Abilities Setup page, the
// trade imports) and a fake Discord. No real trade, pick, setting or message.
import { t, test, run } from "./fixtures/mini_test.mjs";
import { makeD1, applyMigrations } from "./fixtures/d1_sqlite.mjs";
await import("./fixtures/register_md_loader.mjs");
const LK = await import("../worker/src/mfl_lockout.js");
const RV = await import("../worker/src/lineup_forfeit_reversal.js");
const F = await import("../worker/src/lineup_forfeits.js");
const { executeCommishTwoPartyTrade } = await import("../worker/src/trade_3way.js");

const SEASON = 2026, L = "74598";
const LINEUP = ["0129_lineup_compliance.sql", "0149_lineup_sat_announce_log.sql", "0171_lineup_rulings.sql", "0172_lineup_pick_reservation_state.sql"];
const db = () => { const d = makeD1({}); applyMigrations(d, LINEUP); return d; };
const quiet = console.error; console.error = () => {};

// ═════════════════════ the Abilities Setup page (fake) ═════════════════════
// Modeled on Keith's screenshot: a grid of per-franchise ability checkboxes, then
// "Commissioner Abilities — Commissioner Lockout: (o) No … (o) Yes …", then Save.
function abilitiesHtml(state) {
  const box = (name) => `<td><input type="checkbox" name="${name}" value="1"${state.boxes[name] ? " checked" : ""}></td>`;
  const rows = ["0001", "0002"].map((f) => `<tr><td>Team ${f}</td>${box(`ABIL_${f}_TRADE`)}${box(`ABIL_${f}_HOME`)}</tr>`).join("");
  const radio = (v, text) => `<input type="radio" name="COMMISH_LOCKOUT" value="${v}"${state.lockout === v ? " checked" : ""}> ${text}<br>`;
  return `<html><body><form method="POST" action="/2026/options">
    <input type="hidden" name="L" value="${state.league}"><input type="hidden" name="O" value="93">
    <table>${rows}</table>
    <table><tr><th>Commissioner Abilities</th></tr><tr><td>Commissioner Lockout:</td><td>
      ${radio("N", "No, the commissioner will have the ability to view pending owner-initiated transactions.")}
      ${radio("Y", "Yes, the commissioner will not have the ability to view pending owner-initiated transactions.")}
    </td></tr></table>
    <input type="submit" name="SAVE" value="SAVE ABILITIES"></form></body></html>`;
}
function fakeAbilitiesSite(state, { clobber = false } = {}) {
  const posts = [];
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(String(url));
    if ((init.method || "GET") === "POST") {
      const body = new URLSearchParams(init.body);
      posts.push([...body]);
      state.lockout = body.get("COMMISH_LOCKOUT") || state.lockout;
      for (const k of Object.keys(state.boxes)) state.boxes[k] = body.getAll(k).includes("1");
      if (clobber && posts.length === 1) state.boxes.ABIL_0002_HOME = !state.boxes.ABIL_0002_HOME; // MFL changed something else
      return { ok: true, status: 200, text: async () => "saved" };
    }
    if (u.pathname.endsWith("/options") && u.searchParams.get("O") === "93") return { ok: true, status: 200, text: async () => abilitiesHtml(state) };
    throw new Error("unexpected " + url);
  };
  return { fetchImpl, posts };
}
const ENV = { MFL_COOKIE: "commish-cookie", MFL_APIKEY: "k" };

test("lockout page: finds exactly the Commissioner Lockout pair and the full form", () => {
  const p = LK.parseAbilitiesPage(abilitiesHtml({ league: L, lockout: "Y", boxes: { ABIL_0001_TRADE: true, ABIL_0001_HOME: false, ABIL_0002_TRADE: true, ABIL_0002_HOME: false } }));
  t.equal(p.ok, true);
  t.deepEqual(p.lockout, { name: "COMMISH_LOCKOUT", yesValue: "Y", noValue: "N", current: "Yes" });
  t.deepEqual(p.form.fields, [["L", L], ["O", "93"], ["ABIL_0001_TRADE", "1"], ["ABIL_0002_TRADE", "1"], ["COMMISH_LOCKOUT", "Y"], ["SAVE", "SAVE ABILITIES"]]);
  t.equal(LK.parseAbilitiesPage("<form><input type=radio name=X value=1> Yes</form>").ok, false, "no 'Commissioner Lockout' label → refuse");
  t.equal(LK.parseAbilitiesPage(`<form>Commissioner Lockout: <input type="radio" name="A" value="1"> Maybe <input type="radio" name="A" value="2" checked> Perhaps</form>`).error, "lockout_labels_unrecognised");
});

test("setLockout: flips ONLY the radio, re-sends every other field as loaded, verifies, and is a no-op when already set", async () => {
  const state = { league: L, lockout: "Y", boxes: { ABIL_0001_TRADE: true, ABIL_0001_HOME: false, ABIL_0002_TRADE: true, ABIL_0002_HOME: false } };
  const site = fakeAbilitiesSite(state);
  const off = await LK.setLockout(ENV, { season: SEASON, leagueId: L, on: false, fetchImpl: site.fetchImpl });
  t.deepEqual(off, { ok: true, changed: true, from: "Yes", to: "No" });
  t.deepEqual(site.posts[0], [["L", L], ["O", "93"], ["ABIL_0001_TRADE", "1"], ["ABIL_0002_TRADE", "1"], ["COMMISH_LOCKOUT", "N"], ["SAVE", "SAVE ABILITIES"]]);
  t.deepEqual(state.boxes, { ABIL_0001_TRADE: true, ABIL_0001_HOME: false, ABIL_0002_TRADE: true, ABIL_0002_HOME: false }, "every franchise ability unchanged");
  const again = await LK.setLockout(ENV, { season: SEASON, leagueId: L, on: false, fetchImpl: site.fetchImpl });
  t.equal(again.changed, false); t.equal(site.posts.length, 1, "already off → nothing submitted");
  const on = await LK.setLockout(ENV, { season: SEASON, leagueId: L, on: true, fetchImpl: site.fetchImpl });
  t.equal(on.ok, true); t.equal(state.lockout, "Y");
});

test("setLockout: if anything besides lockout changes, it puts the original form back and reports failure", async () => {
  const state = { league: L, lockout: "Y", boxes: { ABIL_0001_TRADE: true, ABIL_0001_HOME: false, ABIL_0002_TRADE: true, ABIL_0002_HOME: false } };
  const site = fakeAbilitiesSite(state, { clobber: true });
  const r = await LK.setLockout(ENV, { season: SEASON, leagueId: L, on: false, fetchImpl: site.fetchImpl });
  t.equal(r.ok, false); t.equal(r.error, "other_settings_changed"); t.equal(r.restored, true);
  t.equal(state.lockout, "Y", "lockout back as it was"); t.equal(state.boxes.ABIL_0002_HOME, false, "the clobbered ability restored");
  t.equal((await LK.setLockout({}, { season: SEASON, leagueId: L, on: false, fetchImpl: site.fetchImpl })).error, "no_commissioner_cookie");
});

// ═════════════════════════ the reversal (fake MFL + Discord) ═════════════════════════
// Week 6: Team 0004 forfeited its own 2027 4th. Then on MFL's own site 0004 traded
// that pick + player 111 to 0009 for player 222 and $3K cap money.
const TRADE_UNIX = 1792000000;
const RES = { holder_fid: "0004", week: 6, pick_year: 2027, pick_round: 4, original_owner: "0004", reserved_at_utc: "2026-10-12T00:00:00Z" };
function world(over = {}) {
  const w = {
    names: { "0004": "Pure Greatness", "0009": "Bear Down", "0002": "CBP" },
    rosters: { "0004": ["222", "333"], "0009": ["111", "444"] },
    picks: { "0009": [["0004", 2027, 4]], "0004": [["0004", 2027, 1]] },
    trades: [{ type: "TRADE", franchise: "0004", franchise1_gave_up: "FP_0004_2027_4,111,", franchise2: "0009", franchise2_gave_up: "222,BB_3000,", timestamp: String(TRADE_UNIX) }],
    txOk: true, ...over,
  };
  w.fetchImpl = async (url) => {
    const u = new URL(String(url)); const T = u.searchParams.get("TYPE");
    const json = (o) => ({ ok: true, status: 200, json: async () => o });
    if (T === "league") return json({ league: { franchises: { franchise: Object.entries(w.names).map(([id, name]) => ({ id, name })) } } });
    if (T === "transactions") return w.txOk ? json({ transactions: { transaction: w.trades } }) : { ok: false, status: 500, json: async () => null };
    if (T === "rosters") return json({ rosters: { franchise: Object.entries(w.rosters).map(([id, ps]) => ({ id, player: ps.map((p) => ({ id: p })) })) } });
    if (T === "futureDraftPicks") return json({ futureDraftPicks: { franchise: Object.entries(w.picks).map(([id, ps]) => ({ id, futureDraftPick: ps.map(([o, y, r]) => ({ originalPickFor: o, year: String(y), round: String(r) })) })) } });
    if (T === "draftResults") return json({ draftResults: { draftUnit: { draftPick: [] } } });
    throw new Error("unexpected " + url);
  };
  return w;
}
const THREAD_ID = String((BigInt(TRADE_UNIX * 1000 + 60000) - 1420070400000n) << 22n);
function fakeDiscord({ threads = [{ id: THREAD_ID, parent_id: RV.TRANSACTIONS_CHANNEL_DEFAULT, name: "Trade: Pure Greatness ↔ Bear Down" }] } = {}) {
  const calls = [];
  const discord = async (method, path, body) => {
    calls.push({ method, path, body });
    if (method === "GET" && path.includes("/threads/active")) return { ok: true, data: { threads } };
    if (method === "GET" && path.includes("/threads/archived")) return { ok: true, data: { threads: [] } };
    if (method === "GET") return { ok: true, data: { content: "" } };
    return { ok: true, data: { id: "999" } };
  };
  return { discord, calls, posts: () => calls.filter((c) => c.method === "POST") };
}
function harness({ w = world(), d = fakeDiscord(), execOk = true, lockOff = { ok: true, changed: true }, lockOn = { ok: true, changed: true }, flag = true } = {}) {
  const log = [];
  const told = [];
  const deps = {
    fetchImpl: w.fetchImpl, discord: d.discord, flagImpl: async () => flag,
    alertImpl: async (txt) => told.push(txt),
    resolveMentions: async (fids) => fids.map((f) => `u${f}`),
    lockout: { set: async (on) => { log.push(on ? "lockout_on" : "lockout_off"); return on ? lockOn : lockOff; }, inspect: async () => ({ ok: true, lockout: "Yes" }) },
    execTrade: async (args) => {
      log.push("exec"); deps.lastExec = args;
      if (!execOk) return { ok: false, step: "accept", error: "MFL said no" };
      // the trade goes back on MFL
      w.rosters = { "0004": ["111", "333"], "0009": ["222", "444"] };
      w.picks = { "0004": [["0004", 2027, 1], ["0004", 2027, 4]], "0009": [] };
      return { ok: true, tradeId: "55555" };
    },
  };
  return { deps, log, told, w, d };
}
function reserve(d, state = "traded_away") {
  d.raw.prepare(`INSERT INTO ups_lineup_pick_reservations (season, league_id, holder_fid, week, pick_year, pick_round, original_owner, ownership_basis, reserved_at_utc, state) VALUES (?, ?, '0004', 6, 2027, 4, '0004', 'mfl_future_picks', '2026-10-12T00:00:00Z', ?)`).run(SEASON, L, state);
}
const call = (env, h, mode = "run", over = {}) => RV.reverseForfeitedPickTrade(env, { season: SEASON, leagueId: L, reservation: RES, owner: "0009", mode, nowUnix: TRADE_UNIX + 7200, deps: h.deps, ...over });

test("finds the one trade that moved the pick, oriented forfeiting team → holder", () => {
  const trades = RV.normalizeTrades({ transactions: { transaction: world().trades } });
  const f = RV.findTradeForPick(trades, { canonical: "FP_0004_2027_4", holder: "0004", owner: "0009", sinceUnix: 0 });
  t.deepEqual(f.trade, { unix: TRADE_UNIX, from: "0004", to: "0009", from_gave: ["FP_0004_2027_4", "111"], to_gave: ["222", "BB_3000"] });
  t.equal(RV.findTradeForPick(trades, { canonical: "FP_0004_2027_4", holder: "0004", owner: "0009", sinceUnix: TRADE_UNIX + 1 }).error, "trade_not_found", "a trade before the reservation isn't this case");
  t.equal(RV.findTradeForPick([...trades, { ...trades[0], unix: TRADE_UNIX + 5 }], { canonical: "FP_0004_2027_4", holder: "0004", owner: "0009" }).error, "pick_traded_more_than_once");
  t.equal(RV.findTradeForPick(trades, { canonical: "FP_0004_2027_4", holder: "0004", owner: "0002" }).error, "trade_parties_mismatch");
});

test("preview writes nothing: plan, thread, lockout state, reply text with NO mention", async () => {
  const d = db(); reserve(d); const h = harness();
  const r = await call({ UPS_MFL_DB: d, DISCORD_GUILD_ID: "g" }, h, "preview");
  t.equal(r.ok, true); t.equal(r.writes, 0);
  t.deepEqual(r.plan.return_to_forfeiting_team, ["FP_0004_2027_4", "111"]);
  t.equal(r.thread.thread_id, THREAD_ID);
  t.equal(r.reply_preview, "This trade will be reversed. It included Pure Greatness's 2027 fourth-round pick, which was forfeited as a lineup-violation penalty (Week 6). Every player, pick and cap dollar goes back to its original team.");
  t.equal(h.d.posts().length, 0); t.deepEqual(h.log, []); t.equal(h.told.length, 0);
});

test("run: replies once in the thread tagging both owners → lockout off → reverse → lockout on → verified → reservation back to reserved", async () => {
  const d = db(); reserve(d); const h = harness();
  const env = { UPS_MFL_DB: d, DISCORD_GUILD_ID: "g" };
  const r = await call(env, h);
  t.equal(r.ok, true);
  t.deepEqual(h.log, ["lockout_off", "exec", "lockout_on"]);
  const post = h.d.posts();
  t.equal(post.length, 1);
  t.equal(post[0].path, `/channels/${THREAD_ID}/messages`);
  t.match(post[0].body.content, /^<@u0004> <@u0009> This trade will be reversed\./);
  t.deepEqual(post[0].body.allowed_mentions, { users: ["u0004", "u0009"], parse: [] });
  t.deepEqual({ from: h.deps.lastExec.fromFid, to: h.deps.lastExec.toFid, give: h.deps.lastExec.give, receive: h.deps.lastExec.receive, raw: h.deps.lastExec.mflTokens },
    { from: "0009", to: "0004", give: ["FP_0004_2027_4", "111"], receive: ["222", "BB_3000"], raw: true });
  t.deepEqual(h.deps.lastExec.returnForfeited, { canonical: "FP_0004_2027_4", toFid: "0004" });
  const row = d.raw.prepare("SELECT * FROM ups_lineup_forfeit_reversals").get();
  t.equal(row.state, "reversed"); t.equal(row.lockout_turned_off, 1); t.equal(row.lockout_restored, 1); t.equal(row.mfl_trade_id, "55555"); t.equal(row.discord_message_id, "999");
  t.equal(d.raw.prepare("SELECT state FROM ups_lineup_pick_reservations").get().state, "reserved", "the pick is with its team again, still forfeited");
  t.equal(d.raw.prepare("SELECT event FROM ups_lineup_forfeit_events").get().event, "trade_reversed");
  t.match(h.told.at(-1), /^✅ Reversed the Pure Greatness\/Bear Down trade/);
  // A second run (or an overlapping one) does nothing.
  const again = await call(env, harness({ w: h.w }));
  t.equal(again.skipped, true); t.equal(again.reason, "already_reversed");
});

test("never a partial reversal: an asset that moved since → held, no post, no lockout, no trade", async () => {
  const d = db(); reserve(d);
  const w = world(); w.rosters["0009"] = ["444"]; w.rosters["0007"] = ["111"]; // 0009 already traded player 111 on
  const h = harness({ w });
  const r = await call({ UPS_MFL_DB: d }, h);
  t.equal(r.held, true); t.equal(r.reason, "assets_moved"); t.deepEqual(r.moved.map((m) => m.asset), ["111"]);
  t.deepEqual(h.log, []); t.equal(h.d.posts().length, 0);
  t.match(h.told[0], /A partial reversal isn't allowed\. Nothing was changed/);
});

test("MFL refuses the reversal → lockout still switched back on, ledger 'failed', commissioner told", async () => {
  const d = db(); reserve(d); const h = harness({ execOk: false });
  const r = await call({ UPS_MFL_DB: d }, h);
  t.equal(r.ok, false); t.equal(r.reason, "reversal_failed");
  t.deepEqual(h.log, ["lockout_off", "exec", "lockout_on"], "lockout restored even though the trade failed");
  t.equal(d.raw.prepare("SELECT state FROM ups_lineup_forfeit_reversals").get().state, "failed");
  t.match(h.told.at(-1), /was NOT reversed: MFL refused/);
});

test("lockout can't be switched back on → urgent DM", async () => {
  const d = db(); reserve(d); const h = harness({ lockOn: { ok: false, error: "reload_failed" } });
  await call({ UPS_MFL_DB: d }, h);
  t.ok(h.told.some((x) => /🚨 MFL lockout is still OFF/.test(x)));
});

test("lockout can't be switched off → held, nothing traded", async () => {
  const d = db(); reserve(d); const h = harness({ lockOff: { ok: false, error: "other_settings_changed", restored: true } });
  const r = await call({ UPS_MFL_DB: d }, h);
  t.equal(r.reason, "lockout_off_failed"); t.deepEqual(h.log, ["lockout_off"]);
  t.equal(d.raw.prepare("SELECT state FROM ups_lineup_forfeit_reversals").get().state, "held");
});

test("a run that died mid-way is never re-run blind: lockout switched back on, held, commissioner told", async () => {
  const d = db(); reserve(d); const h = harness();
  const env = { UPS_MFL_DB: d };
  d.raw.exec(`CREATE TABLE IF NOT EXISTS ups_lineup_forfeit_reversals (reversal_key TEXT PRIMARY KEY, league_id TEXT NOT NULL, season INTEGER NOT NULL, holder_fid TEXT NOT NULL, owner_fid TEXT NOT NULL, week INTEGER, pick TEXT NOT NULL, trade_unix INTEGER NOT NULL, state TEXT NOT NULL, lease_until_unix INTEGER, plan_json TEXT, discord_thread_id TEXT, discord_message_id TEXT, mfl_trade_id TEXT, lockout_turned_off INTEGER NOT NULL DEFAULT 0, lockout_restored INTEGER NOT NULL DEFAULT 0, error TEXT, created_at_utc TEXT NOT NULL, updated_at_utc TEXT NOT NULL)`);
  d.raw.prepare(`INSERT INTO ups_lineup_forfeit_reversals (reversal_key, league_id, season, holder_fid, owner_fid, week, pick, trade_unix, state, lease_until_unix, lockout_turned_off, lockout_restored, created_at_utc, updated_at_utc) VALUES (?, ?, ?, '0004', '0009', 6, 'FP_0004_2027_4', ?, 'executing', ?, 1, 0, 'x', 'x')`)
    .run(`${L}|${SEASON}|${TRADE_UNIX}|0004|0009`, L, SEASON, TRADE_UNIX, TRADE_UNIX);
  const r = await call(env, h);
  t.equal(r.reason, "interrupted"); t.deepEqual(h.log, ["lockout_on"], "relock only — no trade");
  t.match(h.told[0], /was interrupted\. It was NOT retried/);
});

test("switch off → nothing read, nothing written; the test league never posts or DMs", async () => {
  const d = db(); reserve(d);
  const off = harness({ flag: false });
  t.equal((await call({ UPS_MFL_DB: d }, off)).reason, "reversal_disabled"); t.deepEqual(off.log, []);
  const tl = harness({ flag: false });
  const r = await call({ UPS_MFL_DB: d }, tl, "run", { leagueId: RV.TEST_LEAGUE_ID });
  t.equal(r.ok, true, "the test league runs without the switch");
  t.deepEqual(tl.log, ["lockout_off", "exec", "lockout_on"]);
  t.equal(tl.d.calls.length, 0, "no Discord call at all"); t.equal(tl.told.length, 0, "no DM");
});

test("the backstop lets ONLY that pick go back to the team that forfeited it", async () => {
  const d = db(); reserve(d);
  const env = { UPS_MFL_DB: d, MFL_APIKEY: "k" };
  const sent = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => { sent.push(String(url)); return { ok: true, status: 200, text: async () => (String(url).includes("tradeProposal") ? '{"TradeID":"77777"}' : "OK") }; };
  try {
    const back = await executeCommishTwoPartyTrade(env, { leagueId: L, year: SEASON, fromFid: "0009", toFid: "0004", give: ["FP_0004_2027_4", "111"], receive: ["222"], mflTokens: true, returnForfeited: { canonical: "FP_0004_2027_4", toFid: "0004" }, commentTag: "[x]" });
    t.equal(back.ok, true); t.equal(sent.length, 2, "propose + accept");
    sent.length = 0;
    const elsewhere = await executeCommishTwoPartyTrade(env, { leagueId: L, year: SEASON, fromFid: "0009", toFid: "0002", give: ["FP_0004_2027_4"], receive: ["555"], mflTokens: true, returnForfeited: { canonical: "FP_0004_2027_4", toFid: "0004" } });
    t.equal(elsewhere.step, "pick_forfeited"); t.equal(sent.length, 0, "to anyone else: refused before MFL");
    const noExempt = await executeCommishTwoPartyTrade(env, { leagueId: L, year: SEASON, fromFid: "0009", toFid: "0004", give: ["FP_0004_2027_4"], receive: ["222"], mflTokens: true });
    t.equal(noExempt.step, "pick_forfeited", "without the reversal's exemption: refused");
  } finally { globalThis.fetch = realFetch; }
});

test("the hourly forfeit check hands a native trade of a reserved pick to the reversal", async () => {
  const d = db(); reserve(d, "reserved");
  const w = world();
  const realFetch = globalThis.fetch;
  globalThis.fetch = w.fetchImpl;
  const seen = [];
  try {
    const out = await F.reconcileForfeitedPicks({ UPS_MFL_DB: d }, { season: SEASON, leagueId: L, alertImpl: async () => {}, ownerDmImpl: async () => {},
      reverseImpl: async (a) => { seen.push(a); return { ok: false, held: true, reason: "reversal_disabled" }; } });
    t.equal(out.results[0].state, "traded_away");
    t.deepEqual(out.results[0].reversal, { ok: false, reason: "reversal_disabled" });
    t.equal(seen[0].owner, "0009"); t.equal(seen[0].mode, "run");
    t.deepEqual({ h: seen[0].reservation.holder_fid, y: seen[0].reservation.pick_year, r: seen[0].reservation.pick_round }, { h: "0004", y: 2027, r: 4 });
  } finally { globalThis.fetch = realFetch; }
});

await run("lineup_forfeit_reversal");
console.error = quiet;
