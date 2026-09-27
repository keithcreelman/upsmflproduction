// 3-way trade engine: canonical LOAD + server-authoritative CANCEL, against real
// SQLite (real migrations 0077-0079). Run:  node tests/trade_3way_engine.test.mjs
//
// Regression for 2026-09-25: a 3-way offer showed in the mobile Trade War Room but
// could neither be loaded nor cancelled.
import { t, test, run } from "./fixtures/mini_test.mjs";
import { makeEnv, seedTrade, readRow, goodDeps, viewer, commishViewer, installDiscordRecorder, quietConsole,
  FR, NAMES, TRADE_ID, DISCORD, REAL_LEGS } from "./fixtures/trade_3way_fixture.mjs";
await import("./fixtures/register_md_loader.mjs");
const { get3WayTrade, list3WayForFranchise, cancel3WayTrade, handle3WayButton } = await import("../worker/src/trade_3way.js");
import { buildCanonical3Way, parseAssetToken, decideCancel, STATE_MACHINE } from "../worker/src/trade_3way_model.js";

const restoreConsole = quietConsole();
const discord = installDiscordRecorder();
const fresh = (over, envOpts) => { const env = makeEnv(envOpts); seedTrade(env, over); discord.reset(); return env; };
const ctxWait = () => { const p = []; return { waitUntil: (x) => p.push(x), flush: () => Promise.all(p) }; };

// ═══════════════════════════ LOAD ═══════════════════════════
test("valid 3-way loads for the initiator with the canonical shape", async () => {
  const env = fresh();
  const r = await get3WayTrade(env, TRADE_ID, viewer(FR.A), goodDeps);
  t.ok(r.ok);
  const tr = r.trade;
  t.equal(tr.id, TRADE_ID);
  t.equal(tr.status, "collecting");
  t.equal(tr.terminal, false);
  t.equal(tr.participants.length, 3);
  t.equal(tr.movements.length, 4);
  t.equal(tr.integrity.ok, true);
  t.deepEqual(tr.integrity.issues, []);
  t.equal(tr.viewer.role, "initiator");
  t.equal(tr.permissions.can_cancel, true);
  t.equal(tr.version, "2026-09-23T20:21:41.139Z");
});

test("participant order is stable and identical for every viewer", async () => {
  const env = fresh();
  const order = async (v) => (await get3WayTrade(env, TRADE_ID, v, goodDeps)).trade.participants.map((p) => `${p.slot}:${p.fid}`);
  const a = await order(viewer(FR.A)), b = await order(viewer(FR.B)), c = await order(viewer(FR.C)), m = await order(commishViewer());
  t.deepEqual(a, ["initiator:0008", "team_b:0001", "team_c:0012"]);
  t.deepEqual(b, a); t.deepEqual(c, a); t.deepEqual(m, a);
});

test("every asset stays attached to the correct sending and receiving franchise", async () => {
  const env = fresh();
  const tr = (await get3WayTrade(env, TRADE_ID, viewer(FR.A), goodDeps)).trade;
  const side = (fid) => tr.sides.find((s) => s.fid === fid);
  const sends = (fid) => side(fid).sends.map((x) => `${x.to.fid}<-${x.assets.map((a) => a.token).join("+")}`);
  const recvs = (fid) => side(fid).receives.map((x) => `${x.from.fid}->${x.assets.map((a) => a.token).join("+")}`);
  t.deepEqual(sends("0008"), ["0012<-P_16614+P_16193+FP_0005_2027_1"]);
  t.deepEqual(recvs("0008"), ["0001->P_16181+BB_16000"]);
  t.deepEqual(sends("0001"), ["0008<-P_16181+BB_16000", "0012<-P_16650"]);
  t.deepEqual(recvs("0001"), ["0012->FP_0012_2027_1"]);
  t.deepEqual(sends("0012"), ["0001<-FP_0012_2027_1"]);
  t.deepEqual(recvs("0012"), ["0008->P_16614+P_16193+FP_0005_2027_1", "0001->P_16650"]);
});

test("no asset is dropped, duplicated or reassigned between the stored legs and the canonical sides", async () => {
  const env = fresh();
  const tr = (await get3WayTrade(env, TRADE_ID, viewer(FR.A), goodDeps)).trade;
  const stored = REAL_LEGS.flatMap((m) => m.asset_tokens);
  const inMovements = tr.movements.flatMap((m) => m.assets.filter((a) => a.kind !== "cap").map((a) => a.token));
  t.deepEqual(inMovements.sort(), [...stored].sort());
  const fromSends = tr.sides.flatMap((s) => s.sends.flatMap((x) => x.assets.filter((a) => a.kind !== "cap").map((a) => a.token)));
  const fromRecvs = tr.sides.flatMap((s) => s.receives.flatMap((x) => x.assets.filter((a) => a.kind !== "cap").map((a) => a.token)));
  t.deepEqual(fromSends.sort(), [...stored].sort());
  t.deepEqual(fromRecvs.sort(), [...stored].sort());
  t.equal(new Set(fromSends).size, fromSends.length);
});

test("player, pick and cap-money (BBID) assets are all preserved with resolved labels", async () => {
  const env = fresh();
  const tr = (await get3WayTrade(env, TRADE_ID, viewer(FR.A), goodDeps)).trade;
  const all = tr.movements.flatMap((m) => m.assets);
  const byToken = Object.fromEntries(all.map((a) => [a.token, a]));
  t.equal(byToken["P_16614"].label, "Marvin Harrison Jr.");
  t.equal(byToken["P_16614"].position, "WR");
  t.equal(byToken["FP_0005_2027_1"].label, "2027 1st-round pick (via HammerTime)");
  t.equal(byToken["FP_0012_2027_1"].label, "2027 1st-round pick");
  t.equal(byToken["BB_16000"].kind, "cap");
  t.equal(byToken["BB_16000"].cap_k, 16);
  t.equal(tr.sides.find((s) => s.fid === "0001").cap_out_k, 16);
  t.equal(tr.sides.find((s) => s.fid === "0008").cap_in_k, 16);
  t.ok(all.every((a) => a.resolved));
});

test("franchise names come from the authoritative MFL map, not the stored snapshot", async () => {
  const env = fresh({ initiator_name: "Stale Old Name" });
  const tr = (await get3WayTrade(env, TRADE_ID, viewer(FR.A), goodDeps)).trade;
  t.equal(tr.participants[0].name, "Real Deal Creel");
  t.equal(tr.participants[0].name_source, "mfl");
  const noMfl = (await get3WayTrade(env, TRADE_ID, viewer(FR.A), { franchiseNames: async () => { throw new Error("mfl down"); }, playersByIds: goodDeps.playersByIds })).trade;
  t.equal(noMfl.participants[0].name, "Stale Old Name");
  t.equal(noMfl.participants[0].name_source, "stored");
  t.equal(noMfl.integrity.ok, true);
});

test("terminal trades still load (history is preserved) but are view-only", async () => {
  for (const [status, reason] of [["cancelled", "cancelled_by_initiator"], ["completed", null], ["failed", "leg_x"], ["cancelled", "declined_by_0001"]]) {
    const env = fresh({ status, failure_reason: reason });
    const r = await get3WayTrade(env, TRADE_ID, viewer(FR.A), goodDeps);
    t.ok(r.ok);
    t.equal(r.trade.terminal, true);
    t.equal(r.trade.permissions.can_cancel, false);
  }
});

test("partner declines are decoded to a clear state without leaking internals", async () => {
  const env = fresh({ status: "cancelled", failure_reason: "declined_by_0001", team_b_state: "declined" });
  const tr = (await get3WayTrade(env, TRADE_ID, viewer(FR.C), goodDeps)).trade;
  t.equal(tr.state_view.label, "Declined by L.A. Looks");
  t.deepEqual(tr.cancelled, { by_fid: "0001", by_role: "partner", code: "declined" });
  t.equal(tr.failure_detail, undefined);
  const failed = fresh({ status: "failed", failure_reason: "PARTIAL_hub-2_accept: {\"secret\":\"x\"}" });
  const f = (await get3WayTrade(failed, TRADE_ID, viewer(FR.A), goodDeps)).trade;
  t.equal(f.failure_detail, undefined);
  t.doesNotMatch(JSON.stringify(f), /secret|PARTIAL/);
  const asCommish = (await get3WayTrade(failed, TRADE_ID, commishViewer(), goodDeps)).trade;
  t.match(asCommish.failure_detail, /PARTIAL_hub-2/);
});

test("a missing trade is a real 404 not_found", async () => {
  const env = fresh();
  const r = await get3WayTrade(env, "00000000-0000-0000-0000-000000000000", viewer(FR.A), goodDeps);
  t.equal(r.ok, false); t.equal(r.http, 404); t.equal(r.code, "not_found");
});

test("an invalid id is a 400 bad_request (never reaches SQL)", async () => {
  const env = fresh();
  for (const bad of ["", "x", "'; DROP TABLE ups_3way_trades;--", "a".repeat(200)]) {
    const r = await get3WayTrade(env, bad, viewer(FR.A), goodDeps);
    t.equal(r.http, 400);
  }
  t.equal(env.UPS_MFL_DB.raw.prepare("SELECT COUNT(*) AS n FROM ups_3way_trades").get().n, 1);
});

test("a row from another league is indistinguishable from a missing one", async () => {
  const env = fresh({ league_id: "99999" });
  const r = await get3WayTrade(env, TRADE_ID, viewer(FR.A), goodDeps);
  t.equal(r.http, 404);
});

test("a non-participant cannot load; a database failure is 503 not 404", async () => {
  const env = fresh();
  const r = await get3WayTrade(env, TRADE_ID, viewer(FR.OTHER), goodDeps);
  t.equal(r.http, 403); t.equal(r.code, "forbidden");
  const broken = fresh(null, { d1: { beforeRun: () => { throw new Error("D1_ERROR: boom internal detail"); } } });
  const r2 = await get3WayTrade(broken, TRADE_ID, viewer(FR.A), goodDeps);
  t.equal(r2.http, 503); t.equal(r2.code, "unavailable");
  t.doesNotMatch(JSON.stringify(r2), /boom|internal detail|D1_ERROR/);
});

test("malformed participant data fails closed: loads as incomplete, never as missing", async () => {
  const env = fresh({ initiator_fid: "" });
  const asCommish = await get3WayTrade(env, TRADE_ID, commishViewer(), goodDeps);
  t.ok(asCommish.ok);
  t.equal(asCommish.trade.integrity.ok, false);
  t.ok(asCommish.trade.integrity.issues.some((i) => i.startsWith("invalid_participant")));
  t.equal(asCommish.trade.state_view.code, "incomplete");
  const asOwner = await get3WayTrade(env, TRADE_ID, viewer(FR.A), goodDeps);
  t.equal(asOwner.http, 403);
  const dup = fresh({ team_c_fid: FR.B });
  const d = (await get3WayTrade(dup, TRADE_ID, commishViewer(), goodDeps)).trade;
  t.ok(d.integrity.issues.some((i) => i.startsWith("duplicate_participant")));
});

test("malformed legs are surfaced as an integrity problem and the trade stays cancellable", async () => {
  const env = fresh({ legs_json: "{not json" });
  const tr = (await get3WayTrade(env, TRADE_ID, viewer(FR.A), goodDeps)).trade;
  t.ok(tr.integrity.issues.includes("legs_unparseable"));
  t.equal(tr.movements.length, 0);
  t.equal(tr.state_view.code, "incomplete");
  t.equal(tr.permissions.can_cancel, true);
  const c = await cancel3WayTrade(env, ctxWait(), TRADE_ID, viewer(FR.A), goodDeps);
  t.ok(c.ok);
  t.equal(readRow(env).status, "cancelled");
});

test("missing or unrecognised asset data renders an explicit 'Unavailable asset', never a silent drop", async () => {
  const legs = JSON.stringify([{ from: "0008", to: "0012", asset_tokens: ["P_16614", "ZZ_999", "P_00000"], cap_k: 0, summary: "x" }, { from: "0012", to: "0001", asset_tokens: ["FP_0012_2027_1"], cap_k: 0, summary: "y" }]);
  const env = fresh({ legs_json: legs });
  const tr = (await get3WayTrade(env, TRADE_ID, viewer(FR.A), goodDeps)).trade;
  const assets = tr.movements[0].assets;
  t.equal(assets.length, 3);
  t.equal(assets[1].unavailable, true);
  t.equal(assets[1].label, "Unavailable asset");
  t.equal(assets[2].label, "Player #00000");
  t.equal(assets[2].resolved, false);
  t.ok(tr.integrity.issues.some((i) => i.startsWith("unknown_asset:ZZ_999")));
  t.ok(tr.integrity.issues.includes("unresolved_player:00000"));
  t.equal(tr.integrity.ok, false);
});

test("a movement between teams that are not in the deal is flagged, not rendered", async () => {
  const legs = JSON.stringify([{ from: "0008", to: "0003", asset_tokens: ["P_16614"], cap_k: 0, summary: "x" }, { from: "0008", to: "0012", asset_tokens: ["P_16193"], cap_k: 0, summary: "y" }]);
  const env = fresh({ legs_json: legs });
  const tr = (await get3WayTrade(env, TRADE_ID, viewer(FR.A), goodDeps)).trade;
  t.equal(tr.movements.length, 1);
  t.ok(tr.integrity.issues.includes("bad_movement:0"));
});

test("player-name lookup failure degrades to ids with a flagged integrity issue but still loads", async () => {
  const env = fresh();
  const tr = (await get3WayTrade(env, TRADE_ID, viewer(FR.A), { franchiseNames: goodDeps.franchiseNames, playersByIds: async () => { throw new Error("mfl players down"); } })).trade;
  t.equal(tr.movements[0].assets[0].label, "Player #16614");
  t.equal(tr.integrity.ok, false);
  t.equal(tr.permissions.can_cancel, true);
});

test("version advances with every server-side change so a stale copy can be recognised", async () => {
  const env = fresh();
  const before = (await get3WayTrade(env, TRADE_ID, viewer(FR.A), goodDeps)).trade;
  await cancel3WayTrade(env, ctxWait(), TRADE_ID, viewer(FR.A), goodDeps);
  const after = (await get3WayTrade(env, TRADE_ID, viewer(FR.A), goodDeps)).trade;
  t.notEqual(after.version, before.version);
  t.ok(after.version > before.version);
  t.equal(after.status, "cancelled");
});

test("the outbox lists active trades as canonical objects; history only when asked", async () => {
  const env = fresh();
  seedTrade(env, { id: "old-cancelled-trade-1", status: "cancelled", failure_reason: "cancelled_by_initiator", created_at_utc: "2026-08-01T00:00:00.000Z" });
  const active = await list3WayForFranchise(env, "74598", FR.B, { viewer: viewer(FR.B), deps: goodDeps });
  t.ok(active.ok);
  t.equal(active.trades.length, 1);
  t.equal(active.trades[0].id, TRADE_ID);
  t.equal(active.trades[0].viewer.role, "partner");
  t.equal(active.trades[0].permissions.can_cancel, false);
  const all = await list3WayForFranchise(env, "74598", FR.B, { viewer: viewer(FR.B), deps: goodDeps, includeTerminal: true });
  t.equal(all.trades.length, 2);
  const none = await list3WayForFranchise(env, "74598", FR.OTHER, { viewer: viewer(FR.OTHER), deps: goodDeps });
  t.equal(none.trades.length, 0);
  const otherLeague = await list3WayForFranchise(env, "11111", FR.A, { viewer: viewer(FR.A), deps: goodDeps });
  t.equal(otherLeague.trades.length, 0);
});

// ═══════════════════════════ CANCEL ═══════════════════════════
test("the initiator cancels an open trade: DB updated exactly once, canonical new state returned", async () => {
  const env = fresh();
  const ctx = ctxWait();
  const r = await cancel3WayTrade(env, ctx, TRADE_ID, viewer(FR.A), goodDeps);
  await ctx.flush();
  t.ok(r.ok); t.equal(r.http, 200); t.equal(r.code, "cancelled");
  t.equal(r.trade.status, "cancelled");
  t.equal(r.trade.terminal, true);
  t.equal(r.trade.permissions.can_cancel, false);
  t.equal(r.trade.state_view.label, "Called off");
  t.deepEqual(r.trade.cancelled, { by_fid: "0008", by_role: "initiator", code: "cancelled" });
  const row = readRow(env);
  t.equal(row.status, "cancelled");
  t.equal(row.failure_reason, "cancelled_by_initiator");
  const updates = env.UPS_MFL_DB.log.filter((l) => /^\s*UPDATE ups_3way_trades/i.test(l.sql));
  t.equal(updates.length, 1);
  t.match(updates[0].sql, /AND status='collecting'/);
});

test("both partners are notified exactly once; the initiator is not messaged", async () => {
  const env = fresh();
  const ctx = ctxWait();
  await cancel3WayTrade(env, ctx, TRADE_ID, viewer(FR.A), goodDeps);
  await ctx.flush();
  t.equal(discord.messages().length, 2);
  t.equal(discord.to(DISCORD.B).length, 1);
  t.equal(discord.to(DISCORD.C).length, 1);
  t.equal(discord.to(DISCORD.A).length, 0);
  t.match(discord.to(DISCORD.B)[0].body.content, /Real Deal Creel.*called off/);
});

test("repeating a cancel is safely idempotent: 200, no second write, no second notification", async () => {
  const env = fresh();
  const ctx = ctxWait();
  await cancel3WayTrade(env, ctx, TRADE_ID, viewer(FR.A), goodDeps);
  await ctx.flush();
  const stamp = readRow(env).updated_at_utc;
  discord.reset();
  const before = env.UPS_MFL_DB.log.filter((l) => /^\s*UPDATE/i.test(l.sql)).length;
  const again = await cancel3WayTrade(env, ctx, TRADE_ID, viewer(FR.A), goodDeps);
  await ctx.flush();
  t.ok(again.ok); t.equal(again.already, true); t.equal(again.code, "already_cancelled");
  t.equal(again.trade.status, "cancelled");
  t.equal(readRow(env).updated_at_utc, stamp);
  t.equal(env.UPS_MFL_DB.log.filter((l) => /^\s*UPDATE/i.test(l.sql)).length, before);
  t.equal(discord.messages().length, 0);
});

test("a partner cannot cancel (they decline in Discord instead); the row is untouched", async () => {
  const env = fresh();
  for (const fid of [FR.B, FR.C]) {
    const r = await cancel3WayTrade(env, ctxWait(), TRADE_ID, viewer(fid), goodDeps);
    t.equal(r.ok, false); t.equal(r.http, 403); t.equal(r.code, "only_initiator_can_cancel");
    t.match(r.message, /decline it from your Discord DM/);
  }
  t.equal(readRow(env).status, "collecting");
  t.equal(discord.messages().length, 0);
});

test("a franchise that is not in the deal is rejected and learns nothing about its state", async () => {
  const env = fresh({ status: "executing" });
  const r = await cancel3WayTrade(env, ctxWait(), TRADE_ID, viewer(FR.OTHER), goodDeps);
  t.equal(r.http, 403); t.equal(r.code, "forbidden");
  t.equal(r.trade, undefined);
  t.equal(readRow(env).status, "executing");
});

test("OWNER cancel: a commissioner (not in the deal) is pointed to the administrative action; nothing changes", async () => {
  const env = fresh();
  const ctx = ctxWait();
  const r = await cancel3WayTrade(env, ctx, TRADE_ID, commishViewer({ sessionFid: "0000", fid: "0000" }), goodDeps);
  await ctx.flush();
  t.equal(r.ok, false); t.equal(r.http, 403); t.equal(r.code, "commissioner_use_admin_action");
  t.equal(readRow(env).status, "collecting");
  t.equal(readRow(env).failure_reason, null);
  t.equal(discord.messages().length, 0);
});

test("OWNER cancel: a commissioner ACTING AS the initiator is refused (impersonation is not an owner cancel); the admin key likewise", async () => {
  const env = fresh();
  for (const v of [commishViewer({ sessionFid: "0000", fid: FR.A }), commishViewer({ sessionFid: "", fid: FR.A, via: "apikey" })]) {
    const ctx = ctxWait();
    const r = await cancel3WayTrade(env, ctx, TRADE_ID, v, goodDeps);
    await ctx.flush();
    t.equal(r.ok, false); t.equal(r.code, "commissioner_use_admin_action");
  }
  t.equal(readRow(env).status, "collecting"); t.equal(discord.messages().length, 0);
  // ...but a commissioner who IS the initiator's franchise cancels through their OWN session, like any owner
  const ctxOwn = ctxWait();
  const own = await cancel3WayTrade(env, ctxOwn, TRADE_ID, commishViewer({ sessionFid: FR.A, fid: FR.A }), goodDeps);
  await ctxOwn.flush();
  t.ok(own.ok); t.equal(readRow(env).failure_reason, "cancelled_by_initiator");
});

test("SCOPE: a trade from another season or another league is indistinguishable from a missing one, for everyone including the commissioner", async () => {
  const env = fresh();
  for (const who of [viewer(FR.A), commishViewer({ fid: FR.A })]) {
    for (const over of [{ season: "2025" }, { leagueId: "99999" }]) {
      const g = await get3WayTrade(env, TRADE_ID, { ...who, ...over }, goodDeps);
      t.equal(g.ok, false); t.equal(g.http, 404); t.equal(g.code, "not_found");
      const c = await cancel3WayTrade(env, ctxWait(), TRADE_ID, { ...who, ...over }, goodDeps);
      t.equal(c.ok, false); t.equal(c.http, 404); t.equal(c.trade, undefined);
    }
  }
  t.equal(readRow(env).status, "collecting");
  t.equal(discord.messages().length, 0);
});

test("accepted / rejected / expired-style terminal and in-flight trades cannot be cancelled", async () => {
  for (const [status, code] of [["executing", "cannot_cancel_executing"], ["completed", "cannot_cancel_completed"], ["failed", "cannot_cancel_failed"]]) {
    const env = fresh({ status });
    const r = await cancel3WayTrade(env, ctxWait(), TRADE_ID, viewer(FR.A), goodDeps);
    t.equal(r.ok, false); t.equal(r.http, 409); t.equal(r.code, code);
    t.equal(r.trade.status, status);
    t.equal(readRow(env).status, status);
  }
  t.equal(discord.messages().length, 0);
});

test("a trade a partner already rejected (declined) is a safe no-op, keeping the decline reason", async () => {
  const env = fresh({ status: "cancelled", failure_reason: "declined_by_0001", team_b_state: "declined" });
  const r = await cancel3WayTrade(env, ctxWait(), TRADE_ID, viewer(FR.A), goodDeps);
  t.ok(r.ok); t.equal(r.already, true);
  t.equal(readRow(env).failure_reason, "declined_by_0001");
  t.equal(discord.messages().length, 0);
});

test("a missing trade or a bad id cancels nothing", async () => {
  const env = fresh();
  t.equal((await cancel3WayTrade(env, ctxWait(), "00000000-0000-0000-0000-000000000000", viewer(FR.A), goodDeps)).http, 404);
  t.equal((await cancel3WayTrade(env, ctxWait(), "", viewer(FR.A), goodDeps)).http, 400);
  t.equal(readRow(env).status, "collecting");
});

test("a failed write never reports success and leaves the trade collecting", async () => {
  const env = fresh(null, { d1: { failWrites: true } });
  const r = await cancel3WayTrade(env, ctxWait(), TRADE_ID, viewer(FR.A), goodDeps);
  t.equal(r.ok, false); t.equal(r.http, 503);
  t.doesNotMatch(JSON.stringify(r), /simulated write failure|D1_ERROR/);
  t.equal(readRow(env).status, "collecting");
  t.equal(discord.messages().length, 0);
});

test("RACE: a trade that goes executing between the read and the write is not cancelled", async () => {
  let armed = true;
  const env = fresh(null, { d1: { beforeRun: (sql, args, db) => {
    if (armed && /^\s*UPDATE ups_3way_trades SET status='cancelled'/i.test(sql)) { armed = false; db.exec("UPDATE ups_3way_trades SET status='executing'"); }
  } } });
  const ctx = ctxWait();
  const r = await cancel3WayTrade(env, ctx, TRADE_ID, viewer(FR.A), goodDeps);
  await ctx.flush();
  t.equal(r.ok, false); t.equal(r.http, 409); t.equal(r.code, "cannot_cancel_executing");
  t.equal(readRow(env).status, "executing");
  t.equal(discord.messages().length, 0);
});

test("RACE: two simultaneous cancels change the row once and notify once", async () => {
  const env = fresh();
  const ctx = ctxWait();
  const [r1, r2] = await Promise.all([
    cancel3WayTrade(env, ctx, TRADE_ID, viewer(FR.A), goodDeps),
    cancel3WayTrade(env, ctx, TRADE_ID, viewer(FR.A), goodDeps),
  ]);
  await ctx.flush();
  t.ok(r1.ok && r2.ok);
  t.equal([r1, r2].filter((r) => r.already).length, 1);
  t.equal(discord.messages().length, 2);
});

// ───────── Discord button path must respect a cancelled trade ─────────
const press = (action, userId) => ({ data: { custom_id: `tr3:${action}:${TRADE_ID}` }, member: { user: { id: userId } } });
const say = async (resp) => (await resp.json()).data.content;

test("a Discord Accept after the initiator cancelled cannot resurrect the trade", async () => {
  const env = fresh();
  const ctx = ctxWait();
  await cancel3WayTrade(env, ctx, TRADE_ID, viewer(FR.A), goodDeps);
  await ctx.flush();
  discord.reset();
  const msg = await say(await handle3WayButton(press("accept", DISCORD.B), env, ctx));
  t.match(msg, /already cancelled/);
  t.equal(readRow(env).status, "cancelled");
  t.equal(readRow(env).team_b_state, "pending");
});

test("RACE: the initiator cancelling between a partner's read and write cannot be overwritten by Accept", async () => {
  let armed = true;
  const env = fresh({ team_c_state: "accepted" }, { d1: { beforeRun: (sql, args, db) => {
    if (armed && /^\s*UPDATE ups_3way_trades SET team_b_state='accepted'/i.test(sql)) { armed = false; db.exec("UPDATE ups_3way_trades SET status='cancelled', failure_reason='cancelled_by_initiator'"); }
  } } });
  const ctx = ctxWait();
  const msg = await say(await handle3WayButton(press("accept", DISCORD.B), env, ctx));
  await ctx.flush();
  t.match(msg, /already cancelled/);
  t.equal(readRow(env).status, "cancelled");
  t.equal(readRow(env).team_b_state, "pending");
});

test("RACE: both partners accepting at once starts execution exactly once", async () => {
  const env = fresh({ team_b_state: "accepted" });
  const ctx = ctxWait();
  const [m1, m2] = await Promise.all([
    handle3WayButton(press("accept", DISCORD.C), env, ctx).then(say),
    handle3WayButton(press("accept", DISCORD.C), env, ctx).then(say),
  ]);
  await ctx.flush();
  t.equal([m1, m2].filter((m) => /processing the trade now/.test(m)).length, 1);
  const row = readRow(env);
  t.equal(row.status, "completed");
  t.equal(row.failure_reason, "dry_run");
  const completions = discord.messages().filter((c) => /All three accepted/.test(c.body.content));
  t.equal(completions.length, 3);
});

test("a partner's Decline cannot overwrite a trade that already moved on", async () => {
  const env = fresh({ status: "executing" });
  const msg = await say(await handle3WayButton(press("decline", DISCORD.B), env, ctxWait()));
  t.match(msg, /already executing/);
  t.equal(readRow(env).status, "executing");
  t.equal(readRow(env).team_b_state, "pending");
});

test("a partner's Decline still cancels an open trade and records who declined", async () => {
  const env = fresh();
  const ctx = ctxWait();
  const msg = await say(await handle3WayButton(press("decline", DISCORD.B), env, ctx));
  await ctx.flush();
  t.match(msg, /Declined/);
  const row = readRow(env);
  t.equal(row.status, "cancelled");
  t.equal(row.failure_reason, "declined_by_0001");
  t.equal(row.team_b_state, "declined");
});

// ═══════════════════════ pure model / state machine ═══════════════════════
test("asset-token grammar covers every builder token and rejects junk", () => {
  t.deepEqual(parseAssetToken("P_16614"), { token: "P_16614", kind: "player", player_id: "16614" });
  t.equal(parseAssetToken("FP_0005_2027_1").pick.original_fid, "0005");
  t.equal(parseAssetToken("FP_2027_1_0005").pick.original_fid, "0005");
  t.equal(parseAssetToken("FP_0005_2027_1").pick.round, 1);
  t.equal(parseAssetToken("DP_2026_1_4").pick.slot, 4);
  t.equal(parseAssetToken("BB_16000").cap_k, 16);
  for (const junk of ["", "P_", "P_abc", "FP_", "FP_2027", "DP_2026_1", "XX_1", "16614"]) t.equal(parseAssetToken(junk).kind, "unknown");
});

test("the state machine is total: every persisted status has a definition and only 'collecting' is cancellable", () => {
  t.deepEqual(Object.keys(STATE_MACHINE).sort(), ["cancelled", "collecting", "completed", "executing", "failed"]);
  for (const [status, def] of Object.entries(STATE_MACHINE)) {
    const d = decideCancel({ status, initiator_fid: "0008", team_b_fid: "0001", team_c_fid: "0012" }, viewer("0008"));
    t.equal(d.ok && !d.idempotent, status === "collecting");
    t.equal(def.terminal, ["completed", "failed", "cancelled"].includes(status));
  }
});

test("without a viewer the canonical object grants no rights", () => {
  const tr = buildCanonical3Way({ id: "abcdefgh", status: "collecting", initiator_fid: "0008", team_b_fid: "0001", team_c_fid: "0012", legs_json: "[]" });
  t.equal(tr.permissions.can_view, false);
  t.equal(tr.permissions.can_cancel, false);
  t.equal(tr.viewer, null);
});

await run("trade_3way_engine");
restoreConsole();
discord.restore();
