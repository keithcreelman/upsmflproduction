// beta_session.js — server-side sessions for the optional mobile beta (issue #1475, Stage 1).
//
// The phone holds ONE thing: a random 256-bit session id. The owner's MFL session never leaves the original app by URL; the worker proves it
// once (MFL's own league lookup), keeps it ENCRYPTED (AES-256-GCM, authenticated) in D1, and decrypts it in memory for a single request.
//
// Credentials in this file, and what is stored:
//   handoff code   random 128 bits, single use, 60 seconds. Only its SHA-256 is stored.
//   session id     random 256 bits, generated independently of the code (no derivation). Only its SHA-256 is stored.
//   MFL session    AES-256-GCM ciphertext (random 96-bit IV; the row's identity and key id are bound in as additional authenticated data,
//                  so a ciphertext copied to another row or key id fails to open). The key lives only in a Worker secret.
//
// Enforcement is ALWAYS in the request path (expires_at / revoked_at / the invitation are checked in the lookup). Cleanup is deletion
// maintenance only: nothing depends on it running.
//
// Pure functions + a D1 store; no network. Tested on real SQLite through the repo's D1-shaped adapter (tests/beta_session.test.mjs).

export const SESSION_TTL_MS = 8 * 60 * 60 * 1000;      // absolute; no refresh in version 1
export const HANDOFF_TTL_MS = 60 * 1000;
export const SESSION_CAP = 3;                           // live (pending or active) sessions per franchise, league and environment
export const KEEP_AFTER_EXPIRY_MS = 24 * 60 * 60 * 1000;
export const SWEEP_BATCH = 200;
export const SID_PREFIX = "ups_bs_";
export const CODE_PREFIX = "ups_bh_";

const B64 = /^[A-Za-z0-9_-]+$/;
const SID_RE = /^ups_bs_[A-Za-z0-9_-]{43}$/;            // 32 random bytes, base64url, no padding
const CODE_RE = /^ups_bh_[A-Za-z0-9_-]{22}$/;           // 16 random bytes
const KID_RE = /^[A-Za-z0-9_-]{1,16}$/;
const enc = new TextEncoder();

function safeStr(v) { return String(v == null ? "" : v).trim(); }
export const padFid = (v) => { const s = safeStr(v).replace(/\D/g, ""); return s ? s.padStart(4, "0").slice(-4) : ""; };

// ───────────────────────────── encodings and randomness ─────────────────────────────
export function b64urlEncode(bytes) {
  let s = ""; for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export function b64urlDecode(str) {
  const s = String(str);
  if (!B64.test(s)) throw new Error("bad_base64url");
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
const randomBytes = (n) => { const b = new Uint8Array(n); crypto.getRandomValues(b); return b; };

/** Independent random credentials: the code and the session id come from separate draws and share nothing. */
export const newHandoffCode = () => CODE_PREFIX + b64urlEncode(randomBytes(16));
export const newSessionId = () => SID_PREFIX + b64urlEncode(randomBytes(32));
export const newRowId = () => b64urlEncode(randomBytes(16));      // not a credential: it names the row and is bound into the ciphertext
export const looksLikeSessionId = (s) => SID_RE.test(String(s || ""));
export const looksLikeHandoffCode = (s) => CODE_RE.test(String(s || ""));

export async function sha256Hex(str) {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(String(str))));
  let h = ""; for (let i = 0; i < d.length; i++) h += d[i].toString(16).padStart(2, "0");
  return h;
}

// ───────────────────────────── keys ─────────────────────────────
// BETA_SESSION_KEY = "<key id>:<base64url of 32 random bytes>" (a Worker secret). BETA_SESSION_KEY_PREV is the same format, kept only
// while rotating. Anything malformed means "no key": the caller refuses (fail closed); a partly valid key is never used.
function parseKey(raw) {
  const s = safeStr(raw); const i = s.indexOf(":");
  if (i < 1) return null;
  const kid = s.slice(0, i), b64 = s.slice(i + 1);
  if (!KID_RE.test(kid)) return null;
  let bytes; try { bytes = b64urlDecode(b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")); } catch (_) { return null; }
  if (bytes.length !== 32) return null;
  return { kid, bytes };
}
export function parseKeyring(env) {
  const current = parseKey(env && env.BETA_SESSION_KEY);
  if (!current) return null;
  const prev = env && env.BETA_SESSION_KEY_PREV ? parseKey(env.BETA_SESSION_KEY_PREV) : null;
  const byId = { [current.kid]: current };
  if (prev && prev.kid !== current.kid) byId[prev.kid] = prev;
  return { current, byId };
}
const importKey = (k) => crypto.subtle.importKey("raw", k.bytes, "AES-GCM", false, ["encrypt", "decrypt"]);
const aad = (id) => enc.encode(`ups-beta-v1|${id.rowId}|${id.franchiseId}|${id.leagueId}|${id.environment}|${id.keyId}`);

/** Seal an MFL session for storage. Returns { mflEnc, keyId }. mflEnc = "v1.<iv>.<ciphertext>" (both base64url). */
export async function sealMflSession(keyring, identity, plaintext) {
  if (!keyring || !keyring.current) throw new Error("key_unavailable");
  const k = keyring.current;
  const iv = randomBytes(12);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad({ ...identity, keyId: k.kid }) }, await importKey(k), enc.encode(String(plaintext))));
  return { mflEnc: `v1.${b64urlEncode(iv)}.${b64urlEncode(ct)}`, keyId: k.kid };
}
/** Open a stored MFL session. Throws on a missing key, a tampered or moved ciphertext, or a wrong key; never returns partial data. */
export async function openMflSession(keyring, row) {
  const k = keyring && keyring.byId && keyring.byId[row.key_id];
  if (!k) throw new Error("key_unavailable");
  const parts = String(row.mfl_enc || "").split(".");
  if (parts.length !== 3 || parts[0] !== "v1") throw new Error("bad_ciphertext");
  const iv = b64urlDecode(parts[1]);
  if (iv.length !== 12) throw new Error("bad_ciphertext");
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData: aad({ rowId: row.row_id, franchiseId: row.franchise_id, leagueId: row.league_id, environment: row.environment, keyId: row.key_id }) }, await importKey(k), b64urlDecode(parts[2]));
  return new TextDecoder().decode(pt);
}

// ───────────────────────────── environment ─────────────────────────────
/** The environment is derived from the league by the worker's own configuration; a client never names it as proof. */
export function environmentForLeague(env, leagueId) {
  const lg = safeStr(leagueId);
  if (!lg) return null;
  if (lg === safeStr((env && env.BETA_LIVE_LEAGUE_ID) || "74598")) return "live";
  if (lg === safeStr((env && env.BETA_TEST_LEAGUE_ID) || "25625")) return "test";
  return null;
}

// ───────────────────────────── the D1 store ─────────────────────────────
// Every statement that must be atomic is ONE statement or one D1 batch (a single transaction). Nothing reads in JavaScript and then writes.
const INVITE_EXISTS = "EXISTS (SELECT 1 FROM ups_beta_invites i WHERE i.franchise_id = s.franchise_id AND i.league_id = s.league_id AND i.environment = s.environment AND i.revoked_at IS NULL)";

export function makeBetaStore(db) {
  const run = (sql, ...args) => db.prepare(sql).bind(...args).run();
  const changes = (r) => Number(r && r.meta && r.meta.changes) || 0;

  return {
    /** Create a pending session row and enforce the cap, in ONE transaction. { inserted:false } = franchise not invited (nothing written). */
    async createHandoff(r) {
      const insert = db.prepare(
        `INSERT INTO ups_beta_sessions (row_id, franchise_id, league_id, environment, handoff_hash, handoff_expires_at, live_until, mfl_enc, key_id, created_at)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
         WHERE EXISTS (SELECT 1 FROM ups_beta_invites i WHERE i.franchise_id = ? AND i.league_id = ? AND i.environment = ? AND i.revoked_at IS NULL)`
      ).bind(r.rowId, r.franchiseId, r.leagueId, r.environment, r.codeHash, r.now + HANDOFF_TTL_MS, r.now + HANDOFF_TTL_MS, r.mflEnc, r.keyId, r.now, r.franchiseId, r.leagueId, r.environment);
      // Keep only the newest SESSION_CAP live rows for this franchise. Computed INSIDE the statement, so two concurrent handoffs cannot both
      // see "2 live" and both insert a third: the transactions are serialized and each ends with at most SESSION_CAP live rows.
      const evict = db.prepare(
        `UPDATE ups_beta_sessions SET revoked_at = ?, revoked_reason = 'cap', mfl_enc = NULL, handoff_hash = NULL, sid_hash = NULL
         WHERE franchise_id = ? AND league_id = ? AND environment = ? AND revoked_at IS NULL AND live_until > ?
           AND row_id NOT IN (SELECT row_id FROM ups_beta_sessions WHERE franchise_id = ? AND league_id = ? AND environment = ? AND revoked_at IS NULL AND live_until > ?
                              ORDER BY created_at DESC, row_id DESC LIMIT ${SESSION_CAP})`
      ).bind(r.now, r.franchiseId, r.leagueId, r.environment, r.now, r.franchiseId, r.leagueId, r.environment, r.now);
      const out = await db.batch([insert, evict]);
      return { inserted: changes(out[0]) === 1 };
    },

    /** Redeem a handoff code: ONE guarded UPDATE. Exactly one of any number of simultaneous attempts changes a row. */
    async redeem(r) {
      const res = await run(
        `UPDATE ups_beta_sessions SET sid_hash = ?, handoff_hash = NULL, activated_at = ?, expires_at = ?, live_until = ?
         WHERE handoff_hash = ? AND activated_at IS NULL AND revoked_at IS NULL AND handoff_expires_at > ? AND environment = ?
           AND EXISTS (SELECT 1 FROM ups_beta_invites i WHERE i.franchise_id = ups_beta_sessions.franchise_id AND i.league_id = ups_beta_sessions.league_id AND i.environment = ups_beta_sessions.environment AND i.revoked_at IS NULL)`,
        r.sidHash, r.now, r.now + SESSION_TTL_MS, r.now + SESSION_TTL_MS, r.codeHash, r.now, r.environment);
      return { redeemed: changes(res) === 1, expiresAt: r.now + SESSION_TTL_MS };
    },

    /** The session behind a session-id hash, with whether its franchise is still invited. One indexed lookup plus one invitation lookup. */
    async lookup(sidHash) {
      return db.prepare(
        `SELECT s.row_id, s.franchise_id, s.league_id, s.environment, s.mfl_enc, s.key_id, s.live_until, s.revoked_at, ${INVITE_EXISTS} AS invited
         FROM ups_beta_sessions s WHERE s.sid_hash = ?`
      ).bind(sidHash).first();
    },

    /** End one session and wipe its encrypted MFL session at once. */
    async signout(sidHash, now) {
      return changes(await run(`UPDATE ups_beta_sessions SET revoked_at = ?, revoked_reason = 'signout', mfl_enc = NULL, sid_hash = NULL, handoff_hash = NULL WHERE sid_hash = ? AND revoked_at IS NULL`, now, sidHash));
    },
    /** End every live session of a franchise (sign out of the original app, or an operator action). */
    async revokeFranchise(franchiseId, leagueId, environment, reason, now) {
      return changes(await run(`UPDATE ups_beta_sessions SET revoked_at = ?, revoked_reason = ?, mfl_enc = NULL, sid_hash = NULL, handoff_hash = NULL WHERE franchise_id = ? AND league_id = ? AND environment = ? AND revoked_at IS NULL`, now, reason, franchiseId, leagueId, environment));
    },
    /** Wipe every stored MFL session and end every live session (operator purge). */
    async purgeAll(now) {
      return changes(await run(`UPDATE ups_beta_sessions SET mfl_enc = NULL, sid_hash = NULL, handoff_hash = NULL, revoked_at = COALESCE(revoked_at, ?), revoked_reason = COALESCE(revoked_reason, 'purge') WHERE mfl_enc IS NOT NULL OR revoked_at IS NULL`, now));
    },

    /** Invitations. Un-inviting also ends that franchise's live sessions, in one transaction. */
    async invite(franchiseId, leagueId, environment, note, now) {
      await run(`INSERT INTO ups_beta_invites (franchise_id, league_id, environment, invited_at, revoked_at, note) VALUES (?, ?, ?, ?, NULL, ?)
                 ON CONFLICT(franchise_id, league_id, environment) DO UPDATE SET revoked_at = NULL, invited_at = excluded.invited_at, note = excluded.note`, franchiseId, leagueId, environment, now, note || null);
    },
    async uninvite(franchiseId, leagueId, environment, now) {
      const out = await db.batch([
        db.prepare(`UPDATE ups_beta_invites SET revoked_at = ? WHERE franchise_id = ? AND league_id = ? AND environment = ? AND revoked_at IS NULL`).bind(now, franchiseId, leagueId, environment),
        db.prepare(`UPDATE ups_beta_sessions SET revoked_at = ?, revoked_reason = 'uninvited', mfl_enc = NULL, sid_hash = NULL, handoff_hash = NULL WHERE franchise_id = ? AND league_id = ? AND environment = ? AND revoked_at IS NULL`).bind(now, franchiseId, leagueId, environment),
      ]);
      return { invitesChanged: changes(out[0]), sessionsRevoked: changes(out[1]) };
    },
    async isInvited(franchiseId, leagueId, environment) {
      const row = await db.prepare(`SELECT 1 AS ok FROM ups_beta_invites WHERE franchise_id = ? AND league_id = ? AND environment = ? AND revoked_at IS NULL`).bind(franchiseId, leagueId, environment).first();
      return !!row;
    },

    /** Deletion maintenance (hourly, and on each handoff). Never needed for enforcement: the request path already refuses expired and revoked rows. */
    async sweep(now) {
      const wipe = await run(`UPDATE ups_beta_sessions SET mfl_enc = NULL WHERE row_id IN (SELECT row_id FROM ups_beta_sessions WHERE live_until <= ? AND mfl_enc IS NOT NULL LIMIT ${SWEEP_BATCH})`, now);
      const del = await run(`DELETE FROM ups_beta_sessions WHERE row_id IN (SELECT row_id FROM ups_beta_sessions WHERE live_until <= ? LIMIT ${SWEEP_BATCH})`, now - KEEP_AFTER_EXPIRY_MS);
      return { wiped: changes(wipe), deleted: changes(del) };
    },
  };
}
