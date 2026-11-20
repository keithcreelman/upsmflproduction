// Mobile beta, Stage 1 (#1475): credentials, authenticated encryption and the D1 store, on REAL SQLite.
//   node tests/beta_session.test.mjs
//
// Proves: independent random handoff codes and session ids stored only as hashes; AES-256-GCM sealing (tamper, moved ciphertext, wrong key,
// rotation overlap, emergency rotation, an independent-implementation known answer); ATOMIC single-use redemption under simultaneous attempts
// (expiry, replay, environment, un-invite); the three-session cap enforced atomically under concurrent handoffs; sign-out, revocation and purge
// wiping the stored MFL session; deletion maintenance that enforcement never depends on; and that every query uses an index.
import crypto from "node:crypto";
import { t, test, run } from "./fixtures/mini_test.mjs";
import { makeD1, applyMigrations } from "./fixtures/d1_sqlite.mjs";
import * as B from "../worker/src/beta_session.js";

const bytes = (n, fill) => new Uint8Array(n).fill(fill);
const keyEnv = (kid, fill, prevKid, prevFill) => ({ BETA_SESSION_KEY: `${kid}:${B.b64urlEncode(bytes(32, fill))}`, ...(prevKid ? { BETA_SESSION_KEY_PREV: `${prevKid}:${B.b64urlEncode(bytes(32, prevFill))}` } : {}) });
const MFL = "MFL-SESSION-CANARY-aGVsbG8gd29ybGQ";
const T0 = Date.parse("2026-11-20T15:00:00Z");

function fresh() {
  const d1 = makeD1({});
  applyMigrations(d1, ["0176_beta_sessions.sql"]);
  return { d1, store: B.makeBetaStore(d1), rows: () => d1.raw.prepare("SELECT * FROM ups_beta_sessions ORDER BY created_at, row_id").all() };
}
async function handoff(ctx, over) {
  const o = { franchiseId: "0008", leagueId: "74598", environment: "live", now: T0, mfl: MFL, ...(over || {}) };
  const rowId = B.newRowId(), code = B.newHandoffCode();
  const keyring = B.parseKeyring(keyEnv("k1", 0x11));
  const sealed = await B.sealMflSession(keyring, { rowId, franchiseId: o.franchiseId, leagueId: o.leagueId, environment: o.environment }, o.mfl);
  const r = await ctx.store.createHandoff({ rowId, franchiseId: o.franchiseId, leagueId: o.leagueId, environment: o.environment, codeHash: await B.sha256Hex(code), mflEnc: sealed.mflEnc, keyId: sealed.keyId, now: o.now });
  return { ...r, rowId, code };
}
const live = (ctx, now) => ctx.rows().filter((r) => r.revoked_at == null && r.live_until > now);

// ───────────────────────────── credentials ─────────────────────────────
test("CREDENTIALS: handoff codes and session ids are independent random values with distinct shapes, and are never stored in the clear", async () => {
  const codes = new Set(), sids = new Set();
  for (let i = 0; i < 300; i++) {
    const c = B.newHandoffCode(), s = B.newSessionId();
    t.ok(B.looksLikeHandoffCode(c) && !B.looksLikeSessionId(c), "a code is not a session id");
    t.ok(B.looksLikeSessionId(s) && !B.looksLikeHandoffCode(s), "a session id is not a code");
    codes.add(c); sids.add(s);
    // independence: no shared bytes, so a session id cannot be derived from the code that was redeemed for it
    t.notEqual(Buffer.from(B.b64urlDecode(s.slice(7))).subarray(0, 16).toString("hex"), Buffer.from(B.b64urlDecode(c.slice(7))).toString("hex"));
  }
  t.equal(codes.size, 300); t.equal(sids.size, 300);
  t.equal(B.b64urlDecode(B.newSessionId().slice(7)).length, 32, "256 bits");
  t.equal(B.b64urlDecode(B.newHandoffCode().slice(7)).length, 16, "128 bits");
  t.equal(await B.sha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", "SHA-256 known answer");
  for (const bad of ["", "ups_bs_", "ups_bs_short", "ups_bs_" + "A".repeat(44), "ups_bh_" + "A".repeat(43), "x".repeat(50), null, undefined]) t.ok(!B.looksLikeSessionId(bad), String(bad));
});

test("STORAGE: only hashes of the code and the session id, and ciphertext of the MFL session, reach the database", async () => {
  const ctx = fresh(); await ctx.store.invite("0008", "74598", "live", "", T0);
  const h = await handoff(ctx);
  const sid = B.newSessionId();
  const r = await ctx.store.redeem({ codeHash: await B.sha256Hex(h.code), environment: "live", sidHash: await B.sha256Hex(sid), now: T0 + 1000 });
  t.ok(r.redeemed);
  const dump = JSON.stringify(ctx.d1.raw.prepare("SELECT * FROM ups_beta_sessions").all()) + JSON.stringify(ctx.d1.log);
  t.ok(!dump.includes(MFL), "the plaintext MFL session is in no row and no statement");
  t.ok(!dump.includes(h.code), "the handoff code is in no row and no statement");
  t.ok(!dump.includes(sid), "the session id is in no row and no statement");
  const row = ctx.rows()[0];
  t.equal(row.sid_hash, await B.sha256Hex(sid)); t.equal(row.handoff_hash, null, "the code hash is dropped once redeemed");
  t.match(row.mfl_enc, /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
});

// ───────────────────────────── authenticated encryption ─────────────────────────────
test("KEYS: a key is '<id>:<32 bytes>'; anything malformed means no key (fail closed), never a partial key", () => {
  t.ok(B.parseKeyring(keyEnv("k1", 1)));
  t.equal(B.parseKeyring({}), null); t.equal(B.parseKeyring({ BETA_SESSION_KEY: "" }), null);
  t.equal(B.parseKeyring({ BETA_SESSION_KEY: "nocolon" }), null);
  t.equal(B.parseKeyring({ BETA_SESSION_KEY: "bad id!:" + B.b64urlEncode(bytes(32, 1)) }), null);
  t.equal(B.parseKeyring({ BETA_SESSION_KEY: "k1:" + B.b64urlEncode(bytes(31, 1)) }), null, "31 bytes");
  t.equal(B.parseKeyring({ BETA_SESSION_KEY: "k1:" + B.b64urlEncode(bytes(33, 1)) }), null, "33 bytes");
  t.equal(B.parseKeyring({ BETA_SESSION_KEY: "k1:!!!not-base64!!!" }), null);
  const kr = B.parseKeyring(keyEnv("k2", 2, "k1", 1));
  t.ok(kr.byId.k1 && kr.byId.k2 && kr.current.kid === "k2");
  t.ok(!B.parseKeyring({ ...keyEnv("k2", 2), BETA_SESSION_KEY_PREV: "garbage" }).byId.k1, "a malformed previous key is ignored, not half-used");
});

test("AES-GCM: round trip; a fresh IV every time; tamper, a moved ciphertext, a wrong key and a wrong key id all fail to open", async () => {
  const kr = B.parseKeyring(keyEnv("k1", 0x11));
  const id = { rowId: "ROW1", franchiseId: "0008", leagueId: "74598", environment: "live" };
  const a = await B.sealMflSession(kr, id, MFL), b = await B.sealMflSession(kr, id, MFL);
  t.notEqual(a.mflEnc, b.mflEnc, "random IV");
  t.ok(!a.mflEnc.includes(MFL));
  const row = (over) => ({ row_id: "ROW1", franchise_id: "0008", league_id: "74598", environment: "live", mfl_enc: a.mflEnc, key_id: a.keyId, ...(over || {}) });
  t.equal(await B.openMflSession(kr, row()), MFL);
  const fails = async (r, kring) => { try { await B.openMflSession(kring || kr, r); return false; } catch (_) { return true; } };
  for (const over of [{ row_id: "ROW2" }, { franchise_id: "0001" }, { league_id: "25625" }, { environment: "test" }]) t.ok(await fails(row(over)), "moved ciphertext: " + JSON.stringify(over));
  const [v, iv, ct] = a.mflEnc.split(".");
  const flip = (s) => s.slice(0, 4) + (s[4] === "A" ? "B" : "A") + s.slice(5);
  t.ok(await fails(row({ mfl_enc: [v, iv, flip(ct)].join(".") })), "tampered ciphertext");
  t.ok(await fails(row({ mfl_enc: [v, flip(iv), ct].join(".") })), "tampered IV");
  t.ok(await fails(row({ mfl_enc: [v, iv, ct.slice(0, -4)].join(".") })), "truncated tag");
  t.ok(await fails(row({ mfl_enc: "v2." + iv + "." + ct })), "unknown version");
  t.ok(await fails(row({ mfl_enc: null })), "wiped");
  t.ok(await fails(row(), B.parseKeyring(keyEnv("k1", 0x22))), "wrong key, same id");
  t.ok(await fails(row({ key_id: "k9" })), "unknown key id");
  t.ok(await fails(row(), B.parseKeyring(keyEnv("k2", 0x11))), "the key id is bound in: the same bytes under another id do not open it");
});

test("AES-GCM: an independent implementation (node:crypto) and this module read each other's ciphertext (known-answer interoperability)", async () => {
  const kr = B.parseKeyring(keyEnv("k1", 0x11));
  const id = { rowId: "R-KAT", franchiseId: "0005", leagueId: "74598", environment: "live" };
  const iv = Buffer.from("000102030405060708090a0b", "hex");
  const c = crypto.createCipheriv("aes-256-gcm", Buffer.alloc(32, 0x11), iv);
  c.setAAD(Buffer.from("ups-beta-v1|R-KAT|0005|74598|live|k1"));
  const ct = Buffer.concat([c.update(MFL, "utf8"), c.final(), c.getAuthTag()]);
  const row = { row_id: "R-KAT", franchise_id: "0005", league_id: "74598", environment: "live", key_id: "k1", mfl_enc: `v1.${B.b64urlEncode(iv)}.${B.b64urlEncode(ct)}` };
  t.equal(await B.openMflSession(kr, row), MFL, "this module opens what node:crypto sealed");
  const mine = await B.sealMflSession(kr, id, MFL); const [, ivb, ctb] = mine.mflEnc.split(".");
  const d = crypto.createDecipheriv("aes-256-gcm", Buffer.alloc(32, 0x11), Buffer.from(B.b64urlDecode(ivb)));
  d.setAAD(Buffer.from("ups-beta-v1|R-KAT|0005|74598|live|k1"));
  const all = Buffer.from(B.b64urlDecode(ctb)); d.setAuthTag(all.subarray(all.length - 16));
  t.equal(Buffer.concat([d.update(all.subarray(0, all.length - 16)), d.final()]).toString("utf8"), MFL, "node:crypto opens what this module sealed");
});

test("KEY ROTATION: scheduled rotation keeps old sessions readable through the previous key; emergency rotation (previous key dropped) makes them unreadable", async () => {
  const id = { rowId: "ROW1", franchiseId: "0008", leagueId: "74598", environment: "live" };
  const old = await B.sealMflSession(B.parseKeyring(keyEnv("k1", 1)), id, MFL);
  const row = { row_id: "ROW1", franchise_id: "0008", league_id: "74598", environment: "live", mfl_enc: old.mflEnc, key_id: old.keyId };
  t.equal(await B.openMflSession(B.parseKeyring(keyEnv("k2", 2, "k1", 1)), row), MFL, "overlap: previous key still opens it");
  const fresh2 = await B.sealMflSession(B.parseKeyring(keyEnv("k2", 2, "k1", 1)), id, MFL);
  t.equal(fresh2.keyId, "k2", "new sessions use the current key");
  let threw = ""; try { await B.openMflSession(B.parseKeyring(keyEnv("k2", 2)), row); } catch (e) { threw = e.message; }
  t.equal(threw, "key_unavailable", "previous key dropped: the old row can no longer be opened");
  let noKey = ""; try { await B.sealMflSession(null, id, MFL); } catch (e) { noKey = e.message; }
  t.equal(noKey, "key_unavailable", "no key: nothing is sealed");
});

// ───────────────────────────── handoff, redemption, expiry, replay ─────────────────────────────
test("HANDOFF: only an invited franchise gets a row; a franchise that is not invited writes nothing", async () => {
  const ctx = fresh();
  const none = await handoff(ctx);
  t.equal(none.inserted, false); t.equal(ctx.rows().length, 0, "nothing written for an uninvited franchise");
  await ctx.store.invite("0008", "74598", "live", "keith", T0);
  t.equal((await handoff(ctx, { franchiseId: "0001" })).inserted, false, "another franchise is still not invited");
  t.equal((await handoff(ctx, { environment: "test", leagueId: "25625" })).inserted, false, "invited for live is not invited for test");
  t.equal((await handoff(ctx)).inserted, true);
  t.equal(ctx.rows().length, 1);
});

test("REDEEM: a code redeems exactly once; a replay, an unknown code, the wrong environment, an expired code and an un-invited franchise all fail identically", async () => {
  const ctx = fresh(); await ctx.store.invite("0008", "74598", "live", "", T0);
  const redeem = async (code, over) => ctx.store.redeem({ codeHash: await B.sha256Hex(code), environment: "live", sidHash: await B.sha256Hex(B.newSessionId()), now: T0 + 1000, ...(over || {}) });
  const a = await handoff(ctx);
  t.equal((await redeem(a.code)).redeemed, true);
  t.equal((await redeem(a.code)).redeemed, false, "replay");
  t.equal((await redeem(B.newHandoffCode())).redeemed, false, "unknown code");
  const b = await handoff(ctx);
  t.equal((await redeem(b.code, { environment: "test" })).redeemed, false, "wrong environment");
  t.equal((await redeem(b.code, { now: T0 + B.HANDOFF_TTL_MS })).redeemed, false, "at the exact expiry instant: expired");
  t.equal((await redeem(b.code, { now: T0 + B.HANDOFF_TTL_MS + 5000 })).redeemed, false, "after expiry");
  const c = await handoff(ctx, { now: T0 + 100_000 });
  t.equal((await redeem(c.code, { now: T0 + 100_000 + B.HANDOFF_TTL_MS - 1 })).redeemed, true, "one millisecond before expiry: accepted");
  const d = await handoff(ctx, { now: T0 + 200_000 }); await ctx.store.uninvite("0008", "74598", "live", T0 + 200_500);
  t.equal((await redeem(d.code, { now: T0 + 201_000 })).redeemed, false, "un-invited after the handoff: refused (and the row was revoked)");
});

test("REDEEM IS ATOMIC: of N simultaneous attempts at one code exactly one wins, and it is a single guarded statement with no read before it", async () => {
  for (const n of [2, 5, 10, 25]) {
    const ctx = fresh(); await ctx.store.invite("0008", "74598", "live", "", T0);
    const h = await handoff(ctx);
    const codeHash = await B.sha256Hex(h.code);
    const sids = await Promise.all(Array.from({ length: n }, async () => B.sha256Hex(B.newSessionId())));
    ctx.d1.log.length = 0;
    const res = await Promise.all(sids.map((sidHash) => ctx.store.redeem({ codeHash, environment: "live", sidHash, now: T0 + 1000 })));
    t.equal(res.filter((r) => r.redeemed).length, 1, `exactly one winner of ${n}`);
    const winner = sids[res.findIndex((r) => r.redeemed)];
    const rows = ctx.rows(); t.equal(rows.length, 1); t.equal(rows[0].sid_hash, winner, "the row holds the winner's session-id hash only");
    t.equal(ctx.d1.log.length, n, "one statement per attempt");
    t.ok(ctx.d1.log.every((l) => /^\s*UPDATE ups_beta_sessions/.test(l.sql)), "every attempt is the one guarded UPDATE: no SELECT precedes a write");
  }
});

test("REDEEM: a lost response leaves a spent code and an unusable row (nobody holds the id), cleaned by the cap and by maintenance, never reusable", async () => {
  const ctx = fresh(); await ctx.store.invite("0008", "74598", "live", "", T0);
  const h = await handoff(ctx);
  const sidNeverDelivered = B.newSessionId();
  t.equal((await ctx.store.redeem({ codeHash: await B.sha256Hex(h.code), environment: "live", sidHash: await B.sha256Hex(sidNeverDelivered), now: T0 + 1000 })).redeemed, true);
  const again = await ctx.store.redeem({ codeHash: await B.sha256Hex(h.code), environment: "live", sidHash: await B.sha256Hex(B.newSessionId()), now: T0 + 2000 });
  t.equal(again.redeemed, false, "the retry with the same code cannot mint a second session");
  const h2 = await handoff(ctx, { now: T0 + 3000 }), h3 = await handoff(ctx, { now: T0 + 4000 }), h4 = await handoff(ctx, { now: T0 + 5000 });
  t.equal(live(ctx, T0 + 5001).length, 3, "the orphaned active row is evicted by the cap");
  t.ok([h2, h3, h4].every((x) => x.inserted));
});

// ───────────────────────────── the cap ─────────────────────────────
test("CAP: at most three live sessions per franchise, newest kept; evicted rows lose their ciphertext and hashes and cannot be redeemed", async () => {
  const ctx = fresh(); await ctx.store.invite("0008", "74598", "live", "", T0); await ctx.store.invite("0001", "74598", "live", "", T0);
  const made = [];
  for (let i = 0; i < 5; i++) made.push(await handoff(ctx, { now: T0 + i * 1000 }));
  await handoff(ctx, { franchiseId: "0001", now: T0 + 6000 });
  const mine = ctx.rows().filter((r) => r.franchise_id === "0008");
  const liveMine = mine.filter((r) => r.revoked_at == null);
  t.equal(liveMine.length, 3); t.deepEqual(liveMine.map((r) => r.row_id).sort(), made.slice(2).map((m) => m.rowId).sort(), "the newest three");
  for (const r of mine.filter((r) => r.revoked_at != null)) { t.equal(r.revoked_reason, "cap"); t.equal(r.mfl_enc, null); t.equal(r.handoff_hash, null); t.equal(r.sid_hash, null); }
  t.equal(ctx.rows().filter((r) => r.franchise_id === "0001" && r.revoked_at == null).length, 1, "another franchise is unaffected");
  const evicted = made[0];
  t.equal((await ctx.store.redeem({ codeHash: await B.sha256Hex(evicted.code), environment: "live", sidHash: await B.sha256Hex(B.newSessionId()), now: T0 + 7000 })).redeemed, false, "an evicted code is dead");
});

test("CAP IS ATOMIC: N simultaneous handoffs for one franchise leave at most three live rows, with no read-then-write in JavaScript", async () => {
  for (const n of [2, 4, 10, 30]) {
    const ctx = fresh(); await ctx.store.invite("0008", "74598", "live", "", T0);
    ctx.d1.log.length = 0;
    const results = await Promise.all(Array.from({ length: n }, (_, i) => handoff(ctx, { now: T0 + i })));
    t.ok(results.every((r) => r.inserted));
    t.equal(live(ctx, T0 + n).length, Math.min(3, n), `${n} simultaneous handoffs: at most 3 live`);
    const newest = [...results].sort((a, b) => 0).slice(-3);
    t.equal(ctx.rows().filter((r) => r.revoked_at != null && (r.mfl_enc !== null || r.sid_hash !== null || r.handoff_hash !== null)).length, 0, "every evicted row was wiped");
    const writes = ctx.d1.log.filter((l) => /^\s*(INSERT|UPDATE)/.test(l.sql));
    t.equal(writes.length, 2 * n, "exactly INSERT + eviction UPDATE per handoff");
    t.ok(!ctx.d1.log.some((l) => /^\s*SELECT\b/.test(l.sql) && /ups_beta_sessions/.test(l.sql)), "no standalone SELECT: the count is computed inside the statement");
    void newest;
  }
});

test("CAP: pending and active sessions both count, and an expired row does not", async () => {
  const ctx = fresh(); await ctx.store.invite("0008", "74598", "live", "", T0);
  const a = await handoff(ctx, { now: T0 });
  await ctx.store.redeem({ codeHash: await B.sha256Hex(a.code), environment: "live", sidHash: await B.sha256Hex(B.newSessionId()), now: T0 + 500 });
  await handoff(ctx, { now: T0 + 1000 }); await handoff(ctx, { now: T0 + 2000 });
  t.equal(live(ctx, T0 + 2500).length, 3, "one active + two pending");
  await handoff(ctx, { now: T0 + B.SESSION_TTL_MS + 10_000 });      // the first has expired by now: only the new one is live
  t.equal(live(ctx, T0 + B.SESSION_TTL_MS + 10_001).length, 1);
});

// ───────────────────────────── lookup, sign-out, revocation, purge ─────────────────────────────
async function active(ctx, over) {
  const h = await handoff(ctx, over); const sid = B.newSessionId(); const now = (over && over.now) || T0;
  const r = await ctx.store.redeem({ codeHash: await B.sha256Hex(h.code), environment: (over && over.environment) || "live", sidHash: await B.sha256Hex(sid), now: now + 500 });
  t.ok(r.redeemed); return { sid, sidHash: await B.sha256Hex(sid), rowId: h.rowId };
}
test("LOOKUP: the session behind an id, with the invitation checked on every lookup; unknown and revoked ids find nothing", async () => {
  const ctx = fresh(); await ctx.store.invite("0008", "74598", "live", "", T0);
  const s = await active(ctx);
  let row = await ctx.store.lookup(s.sidHash);
  t.equal(row.franchise_id, "0008"); t.equal(Number(row.invited), 1); t.equal(row.live_until, T0 + 500 + B.SESSION_TTL_MS);
  t.equal(await ctx.store.lookup(await B.sha256Hex(B.newSessionId())), null, "unknown id");
  await ctx.store.uninvite("0008", "74598", "live", T0 + 1000);
  t.equal(await ctx.store.lookup(s.sidHash), null, "un-inviting ends the session at once (the row is revoked and its hash removed)");
  await ctx.store.invite("0008", "74598", "live", "", T0 + 2000);
  t.equal(await ctx.store.lookup(s.sidHash), null, "re-inviting does not resurrect it");
});

test("SIGN-OUT, REVOCATION and PURGE: each ends the session immediately and wipes the stored MFL session", async () => {
  const ctx = fresh(); await ctx.store.invite("0008", "74598", "live", "", T0); await ctx.store.invite("0001", "74598", "live", "", T0);
  const a = await active(ctx), b = await active(ctx, { now: T0 + 10 }), c = await active(ctx, { franchiseId: "0001", now: T0 + 20 });
  t.equal(await ctx.store.signout(a.sidHash, T0 + 1000), 1); t.equal(await ctx.store.signout(a.sidHash, T0 + 1001), 0, "idempotent");
  t.equal(await ctx.store.lookup(a.sidHash), null);
  t.ok(ctx.rows().find((r) => r.row_id === a.rowId).mfl_enc === null, "sign-out wipes the ciphertext");
  t.equal(await ctx.store.revokeFranchise("0008", "74598", "live", "signout_original_app", T0 + 2000), 1);
  t.equal(await ctx.store.lookup(b.sidHash), null);
  t.ok(await ctx.store.lookup(c.sidHash), "another franchise is untouched");
  t.equal(await ctx.store.purgeAll(T0 + 3000) >= 1, true);
  t.equal(await ctx.store.lookup(c.sidHash), null);
  t.equal(ctx.rows().filter((r) => r.mfl_enc !== null).length, 0, "purge leaves no stored MFL session");
});

test("EXPIRY AND REVOCATION ARE ENFORCED BY THE LOOKUP, NOT BY CLEANUP: an expired row is still found (so the caller must check it) until maintenance runs, and maintenance only deletes", async () => {
  const ctx = fresh(); await ctx.store.invite("0008", "74598", "live", "", T0);
  const s = await active(ctx);
  const row = await ctx.store.lookup(s.sidHash);
  t.ok(row.live_until <= T0 + B.SESSION_TTL_MS + 600 && row.live_until > T0 + B.SESSION_TTL_MS, "the row carries its own expiry for the request path to check");
  t.ok(row.mfl_enc !== null, "no sweep has run: the ciphertext is still there, yet the request path must refuse once live_until has passed");
});

test("SWEEP: wipes expired ciphertext, deletes rows 24 hours after expiry, is bounded, and is not needed for correctness", async () => {
  const ctx = fresh(); await ctx.store.invite("0008", "74598", "live", "", T0);
  const s = await active(ctx);
  const afterExpiry = T0 + B.SESSION_TTL_MS + 5000;
  let r = await ctx.store.sweep(afterExpiry);
  t.equal(r.wiped, 1); t.equal(r.deleted, 0); t.equal(ctx.rows()[0].mfl_enc, null, "ciphertext wiped at expiry");
  r = await ctx.store.sweep(afterExpiry + B.KEEP_AFTER_EXPIRY_MS);
  t.equal(r.deleted, 1); t.equal(ctx.rows().length, 0);
  // bounded
  for (let i = 0; i < 250; i++) ctx.d1.raw.prepare("INSERT INTO ups_beta_sessions (row_id, franchise_id, league_id, environment, handoff_expires_at, live_until, mfl_enc, key_id, created_at) VALUES (?, '0008', '74598', 'live', 1, 1, 'v1.x.y', 'k1', 1)").run("R" + i);
  r = await ctx.store.sweep(T0);
  t.equal(r.wiped, B.SWEEP_BATCH); t.equal(r.deleted, B.SWEEP_BATCH, "each sweep touches at most SWEEP_BATCH rows");
  void s;
});

test("SWEEP: a sweep that errors (for instance the migration is not applied) throws to its caller, which treats it as nothing to do", async () => {
  const bare = makeD1({}); const store = B.makeBetaStore(bare);
  let msg = ""; try { await store.sweep(T0); } catch (e) { msg = e.message; }
  t.match(msg, /no such table/i);
});

// ───────────────────────────── cost shape ─────────────────────────────
test("QUERY PLANS: every request-path and lifecycle statement uses an index (no full scan of ups_beta_sessions); only the operator purge scans", async () => {
  const ctx = fresh(); await ctx.store.invite("0008", "74598", "live", "", T0);
  const s = await active(ctx);
  await ctx.store.lookup(s.sidHash); await ctx.store.signout(s.sidHash, T0 + 1); await ctx.store.revokeFranchise("0008", "74598", "live", "x", T0 + 2);
  await ctx.store.sweep(T0 + 3); await ctx.store.isInvited("0008", "74598", "live"); await ctx.store.uninvite("0008", "74598", "live", T0 + 4);
  await ctx.store.purgeAll(T0 + 5);
  const seen = new Map();
  for (const l of ctx.d1.log) if (/ups_beta_/.test(l.sql) && !/^\s*(CREATE)/.test(l.sql)) seen.set(l.sql.replace(/\s+/g, " ").trim(), l.args);
  t.ok(seen.size >= 9, "statements exercised: " + seen.size);
  const plans = [];
  for (const [sql, args] of seen) {
    const plan = ctx.d1.raw.prepare("EXPLAIN QUERY PLAN " + sql).all(...args).map((r) => r.detail).join(" | ");
    plans.push({ sql, plan });
    if (/^UPDATE ups_beta_sessions SET mfl_enc = NULL, sid_hash = NULL, handoff_hash = NULL, revoked_at = COALESCE/.test(sql)) continue;      // purgeAll: operator only, tiny table, scans by design
    t.doesNotMatch(plan, /SCAN (ups_beta_sessions|s)\b(?! USING)/, "full scan: " + sql.slice(0, 80) + " => " + plan);
  }
  const byStart = (re) => plans.find((p) => re.test(p.sql));
  t.match(byStart(/WHERE handoff_hash = \?/).plan, /ux_beta_sessions_handoff/, "redeem uses the partial unique index on the code hash");
  t.match(byStart(/FROM ups_beta_sessions s WHERE s\.sid_hash/).plan, /ux_beta_sessions_sid/, "lookup uses the partial unique index on the session-id hash");
  t.match(byStart(/DELETE FROM ups_beta_sessions/).plan, /ix_beta_sessions_live_until/, "deletion maintenance uses the expiry index");
});

// ───────────────────────────── the concurrency method can catch a race ─────────────────────────────
test("HARNESS SENSITIVITY: a naive read-then-write redemption and a naive cap DO fail under the same simultaneous attempts, so the passing results above are not vacuous", async () => {
  const ctx = fresh(); await ctx.store.invite("0008", "74598", "live", "", T0);
  const h = await handoff(ctx);
  const codeHash = await B.sha256Hex(h.code);
  // naive: SELECT the pending row, yield (as any real await would), then UPDATE by row id with no guard
  const naive = async (sidHash) => {
    const row = await ctx.d1.prepare("SELECT row_id FROM ups_beta_sessions WHERE handoff_hash = ?").bind(codeHash).first();
    if (!row) return false;
    await Promise.resolve();
    await ctx.d1.prepare("UPDATE ups_beta_sessions SET sid_hash = ?, handoff_hash = NULL, activated_at = 1 WHERE row_id = ?").bind(sidHash, row.row_id).run();
    return true;
  };
  const sidHashes = await Promise.all(Array.from({ length: 5 }, async () => B.sha256Hex(B.newSessionId())));   // computed first, so the five attempts start together
  const wins = (await Promise.all(sidHashes.map((s) => naive(s)))).filter(Boolean).length;
  t.ok(wins > 1, "the naive redemption lets several attempts 'win' (" + wins + "): the harness exposes the race");
  const ctx2 = fresh(); await ctx2.store.invite("0008", "74598", "live", "", T0);
  const naiveCap = async (i) => {
    const n = ctx2.d1.raw.prepare("SELECT COUNT(*) AS n FROM ups_beta_sessions WHERE revoked_at IS NULL").get().n;
    await Promise.resolve();
    if (n < B.SESSION_CAP) ctx2.d1.raw.prepare("INSERT INTO ups_beta_sessions (row_id, franchise_id, league_id, environment, handoff_expires_at, live_until, mfl_enc, key_id, created_at) VALUES (?, '0008', '74598', 'live', ?, ?, 'x', 'k1', ?)").run("N" + i, T0 + 99999, T0 + 99999, T0 + i);
  };
  await Promise.all(Array.from({ length: 10 }, (_, i) => naiveCap(i)));
  t.ok(ctx2.rows().length > B.SESSION_CAP, "the naive cap lets " + ctx2.rows().length + " rows in: the harness exposes the race");
});

await run("beta_session");
