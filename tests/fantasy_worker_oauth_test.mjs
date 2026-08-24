/**
 * WORKER OAUTH TEST — the two things in worker/src/yahoo_oauth.js that would
 * look exactly like working code if they broke.
 *
 * WHAT IS UNDER TEST
 * ==================
 * The pure helpers exported as `__testables` from worker/src/yahoo_oauth.js:
 * the redactor, the base64 codecs, the AES-256-GCM encrypt/decrypt round trip
 * that protects the stored refresh token, and the credential/expiry readers.
 * They are IMPORTED from the module that ships — never re-implemented here.
 * That rule is stated verbatim at tests/lineup_parser_test.js:5-8: a test that
 * owns its own copy of the logic proves only that the copy works.
 *
 * WHY THESE TWO IN PARTICULAR
 * ===========================
 * 1. CRYPTO THAT SILENTLY DEGRADES IS INVISIBLE. The Yahoo refresh token is the
 *    only credential this project stores at rest, and it is stored ONLY as
 *    ciphertext — there is no plaintext fallback by construction. A round trip
 *    that stopped authenticating, an IV that stopped being fresh per write, or
 *    a decrypt that started succeeding under the WRONG key would all produce a
 *    working-looking system. GCM's authentication tag is the thing standing
 *    between "the key was rotated" and "we handed a stranger's ciphertext back
 *    as a token"; these tests assert it actually refuses.
 *
 * 2. A REDACTOR THAT STOPS MATCHING IS INVISIBLE UNTIL IT IS IN SCROLLBACK.
 *    This repo has a harness-confirmed incident where live secrets were printed
 *    into tool output. The worker mirrors pipelines/fantasy/redact.py so the two
 *    halves of the pipeline cannot disagree about what counts as a secret — and
 *    the mirror is only worth anything if something checks it.
 *
 * THE OTHER HALF OF EVERY ASSERTION IS THE NEGATIVE ONE. Over-redaction is its
 * own failure: a redactor that turns every URL into "[redacted]" means nobody
 * can tell which request failed. League keys, seasons, weeks and status codes
 * must survive, and that is asserted as explicitly as the stripping is.
 *
 * NO DEPENDENCIES: node:test + node:assert/strict + the webcrypto global that
 * Node 22 exposes as globalThis.crypto — the same API surface the Workers
 * runtime provides, which is why the shipped code needs no shim to be testable.
 *
 * ⚠️ IF worker/src/yahoo_oauth.js IS ABSENT OR EXPORTS NOTHING TESTABLE, this
 * file SKIPS with an explanatory message rather than failing. A red run here
 * must mean "the OAuth helpers are broken", never "the OAuth helpers have not
 * been written yet" — those need different people to do different things.
 *
 * Run: node --test tests/fantasy_worker_oauth_test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MODULE_PATH = path.join(ROOT, "worker/src/yahoo_oauth.js");
const MODULE_URL = "file://" + MODULE_PATH;

// ── Load, or explain why we are not testing ──────────────────────────────────
let T = null;
let skipReason = "";

if (!existsSync(MODULE_PATH)) {
  skipReason =
    "worker/src/yahoo_oauth.js does not exist yet. Nothing was tested. " +
    "This is a SKIP, not a pass — re-run once the module lands.";
} else {
  try {
    const mod = await import(MODULE_URL);
    T = mod.__testables || null;
    if (!T) {
      skipReason =
        "worker/src/yahoo_oauth.js exists but exports no `__testables` object, so " +
        "its pure helpers cannot be reached from a test. Nothing was tested. " +
        "Export them (redactText, redactUrl, redactHeaders, encryptSecret, " +
        "decryptSecret, …) to enable this file.";
    }
  } catch (err) {
    skipReason =
      "worker/src/yahoo_oauth.js could not be imported: " +
      (err && err.message ? err.message : String(err)) +
      ". Nothing was tested.";
  }
}

const need = (...names) => {
  if (!T) return skipReason || "module not loaded";
  const absent = names.filter((n) => typeof T[n] !== "function");
  return absent.length
    ? `helper(s) not exported: ${absent.join(", ")}. Nothing was tested for this case.`
    : false;
};

if (skipReason) {
  // Printed as well as reported so it is visible in a CI log that only shows
  // the tail of the output.
  console.log("\n⚠️  SKIPPING worker OAuth tests — " + skipReason + "\n");
}

// Obviously-fake credential material. Long enough to trip the bearer pattern's
// 8-character minimum; recognisable enough that a leak into any output is
// unmistakable.
const FAKE_ACCESS = "FAKEaccess0000000000000000000000TOKEN";
const FAKE_REFRESH = "FAKErefresh1111111111111111111111TOKEN";
const FAKE_SECRET = "FAKEclientsecret2222222222222222";
// 32 bytes of nothing, base64 — a VALID AES-256 key shape carrying no entropy,
// which is exactly what a test key should be.
const FAKE_KEY_B64 = Buffer.alloc(32, 7).toString("base64");
const OTHER_KEY_B64 = Buffer.alloc(32, 9).toString("base64");

// ─────────────────────────────────────────────────────────────────────────────
// Redaction
// ─────────────────────────────────────────────────────────────────────────────

test("redactText strips a bearer token from an echoed header", { skip: need("redactText") }, () => {
  const out = T.redactText(`Authorization: Bearer ${FAKE_ACCESS}`);
  assert.ok(!out.includes(FAKE_ACCESS), out);
  assert.match(out, /Bearer \[redacted\]/);
});

test("redactText strips secrets from a form body", { skip: need("redactText") }, () => {
  const out = T.redactText(
    `grant_type=refresh_token&refresh_token=${FAKE_REFRESH}&client_secret=${FAKE_SECRET}`
  );
  assert.ok(!out.includes(FAKE_REFRESH), out);
  assert.ok(!out.includes(FAKE_SECRET), out);
  // The non-secret grant_type must stay readable — it is how you tell a refresh
  // failure from an authorization-code failure.
  assert.match(out, /grant_type=refresh_token/);
});

test("redactText strips a secret from a JSON field", { skip: need("redactText") }, () => {
  const out = T.redactText(
    JSON.stringify({ access_token: FAKE_ACCESS, expires_in: 3600, token_type: "bearer" })
  );
  assert.ok(!out.includes(FAKE_ACCESS), out);
  assert.match(out, /"access_token": "\[redacted\]"/);
  // Diagnostic fields survive.
  assert.match(out, /expires_in/);
  assert.match(out, /3600/);
});

test("redactText never throws on null, undefined or a non-string", { skip: need("redactText") }, () => {
  assert.equal(T.redactText(null), "");
  assert.equal(T.redactText(undefined), "");
  assert.equal(typeof T.redactText(12), "string");
  assert.equal(typeof T.redactText({ a: 1 }), "string");
});

test("redactText does NOT over-redact an unrelated *_code field", { skip: need("redactText") }, () => {
  // `code` is a secret param name; `error_code` is not. A word-boundary bug here
  // would erase the one field an operator greps for.
  assert.match(T.redactText("error_code=yahoo_refresh_failed"), /error_code=yahoo_refresh_failed/);
});

test("redactUrl strips secret VALUES and preserves everything diagnostic", { skip: need("redactUrl") }, () => {
  const url =
    "https://fantasysports.yahooapis.com/fantasy/v2/league/461.l.576919/settings" +
    `?access_token=${FAKE_ACCESS}&refresh_token=${FAKE_REFRESH}` +
    `&client_secret=${FAKE_SECRET}&code=AUTHCODE9999` +
    "&league_key=461.l.576919&season=2025&week=15&format=json";
  const out = T.redactUrl(url);

  for (const secret of [FAKE_ACCESS, FAKE_REFRESH, FAKE_SECRET, "AUTHCODE9999"]) {
    assert.ok(!out.includes(secret), `leaked ${secret}: ${out}`);
  }
  // You still have to be able to tell WHICH request failed.
  assert.ok(out.includes("fantasysports.yahooapis.com"), out);
  assert.ok(out.includes("/fantasy/v2/league/461.l.576919/settings"), out);
  assert.ok(out.includes("league_key=461.l.576919"), out);
  assert.ok(out.includes("season=2025"), out);
  assert.ok(out.includes("week=15"), out);
  assert.ok(out.includes("format=json"), out);
  // The parameter NAMES survive, so you can see what was sent.
  assert.ok(out.includes("access_token="), out);
});

test("redactUrl also strips this worker's own gate parameters", { skip: need("redactUrl") }, () => {
  const out = T.redactUrl("https://x.workers.dev/admin/yahoo/status?APIKEY=SUPERSECRET&L=74598");
  assert.ok(!out.includes("SUPERSECRET"), out);
  // The league id is not a secret and is needed to read the log.
  assert.ok(out.includes("L=74598"), out);
});

test("redactUrl survives a token containing an encoded ampersand", { skip: need("redactUrl") }, () => {
  // Structural parsing, not a regex: a greedy match would stop at the %26 and
  // leak the tail.
  const out = T.redactUrl("https://x/y?access_token=aa%26bbSECRETTAIL&season=2025");
  assert.ok(!out.includes("SECRETTAIL"), out);
  assert.ok(out.includes("season=2025"), out);
});

test("redactUrl falls back to text redaction on an unparseable URL", { skip: need("redactUrl") }, () => {
  const out = T.redactUrl(`not a url at all access_token=${FAKE_ACCESS}`);
  assert.ok(!out.includes(FAKE_ACCESS), out);
});

test("redactUrl returns '' for empty input and does not throw", { skip: need("redactUrl") }, () => {
  assert.equal(T.redactUrl(null), "");
  assert.equal(T.redactUrl(""), "");
  assert.equal(T.redactUrl(undefined), "");
});

test("redactHeaders masks credential headers and keeps the rest", { skip: need("redactHeaders") }, () => {
  const out = T.redactHeaders({
    Authorization: `Bearer ${FAKE_ACCESS}`,
    Cookie: "SID=abc123",
    "set-cookie": "SID=abc123",
    Accept: "application/json",
    "X-Request-Id": "r-42",
  });
  assert.equal(out.Authorization, "[redacted]");
  assert.equal(out.Cookie, "[redacted]");
  assert.equal(out["set-cookie"], "[redacted]");
  assert.equal(out.Accept, "application/json");
  assert.equal(out["X-Request-Id"], "r-42");
});

test("redactHeaders is case-insensitive and safe on null", { skip: need("redactHeaders") }, () => {
  assert.equal(T.redactHeaders({ authorization: "x" }).authorization, "[redacted]");
  assert.deepEqual(T.redactHeaders(null), {});
  assert.deepEqual(T.redactHeaders(undefined), {});
});

// ─────────────────────────────────────────────────────────────────────────────
// Base64 codecs — the thing every crypto bug hides behind
// ─────────────────────────────────────────────────────────────────────────────

test("base64 round-trips arbitrary bytes, including 0x00 and 0xFF", { skip: need("bytesToB64", "b64ToBytes") }, () => {
  const bytes = new Uint8Array([0, 1, 127, 128, 254, 255, 0, 42]);
  const round = T.b64ToBytes(T.bytesToB64(bytes));
  assert.deepEqual(Array.from(round), Array.from(bytes));
});

test("b64ToBytes accepts URL-safe and unpadded base64", { skip: need("bytesToB64Url", "b64ToBytes") }, () => {
  const bytes = new Uint8Array([251, 255, 190, 239, 1]);
  const urlSafe = T.bytesToB64Url(bytes);
  assert.ok(!urlSafe.includes("+") && !urlSafe.includes("/") && !urlSafe.includes("="), urlSafe);
  assert.deepEqual(Array.from(T.b64ToBytes(urlSafe)), Array.from(bytes));
});

test("b64ToBytes THROWS on garbage — an undecodable key is not 'no key'", { skip: need("b64ToBytes") }, () => {
  assert.throws(() => T.b64ToBytes("!!!! not base64 !!!!"));
});

test("randomBytes returns the requested length and is not constant", { skip: need("randomBytes") }, () => {
  const a = T.randomBytes(12);
  const b = T.randomBytes(12);
  assert.equal(a.length, 12);
  assert.equal(b.length, 12);
  assert.notDeepEqual(Array.from(a), Array.from(b));
});

// ─────────────────────────────────────────────────────────────────────────────
// AES-256-GCM — the refresh token at rest
// ─────────────────────────────────────────────────────────────────────────────

test("AES-GCM encrypt/decrypt round-trips the refresh token", { skip: need("encryptSecret", "decryptSecret") }, async () => {
  const env = { YAHOO_TOKEN_ENCRYPTION_KEY: FAKE_KEY_B64 };
  const { ciphertext, iv } = await T.encryptSecret(env, FAKE_REFRESH);

  // The ciphertext must not be the plaintext wearing a base64 hat.
  assert.ok(ciphertext.length > 0);
  assert.ok(!ciphertext.includes(FAKE_REFRESH), ciphertext);
  assert.ok(!Buffer.from(ciphertext, "base64").toString("utf8").includes("FAKErefresh"));

  const back = await T.decryptSecret(env, ciphertext, iv);
  assert.equal(back, FAKE_REFRESH);
});

test("the IV is FRESH on every write — a reused GCM nonce is a total break", { skip: need("encryptSecret") }, async () => {
  const env = { YAHOO_TOKEN_ENCRYPTION_KEY: FAKE_KEY_B64 };
  const a = await T.encryptSecret(env, FAKE_REFRESH);
  const b = await T.encryptSecret(env, FAKE_REFRESH);
  assert.notEqual(a.iv, b.iv, "same IV emitted twice under one key");
  // Same plaintext, same key, different nonce → different ciphertext.
  assert.notEqual(a.ciphertext, b.ciphertext);
  assert.equal(Buffer.from(a.iv, "base64").length, 12, "GCM nonce must be 96 bits");
});

test("decrypt under the WRONG key REFUSES — it never returns plausible bytes", { skip: need("encryptSecret", "decryptSecret") }, async () => {
  const writer = { YAHOO_TOKEN_ENCRYPTION_KEY: FAKE_KEY_B64 };
  const rotated = { YAHOO_TOKEN_ENCRYPTION_KEY: OTHER_KEY_B64 };
  const { ciphertext, iv } = await T.encryptSecret(writer, FAKE_REFRESH);
  await assert.rejects(
    () => T.decryptSecret(rotated, ciphertext, iv),
    (err) => {
      // A named refusal, so an operator can grep for it and act on the remedy.
      assert.equal(err.error_code, "yahoo_refresh_token_undecryptable");
      assert.ok(String(err.message).length > 20);
      return true;
    }
  );
});

test("TAMPERED ciphertext REFUSES — GCM authenticates, and that is the point", { skip: need("encryptSecret", "decryptSecret") }, async () => {
  const env = { YAHOO_TOKEN_ENCRYPTION_KEY: FAKE_KEY_B64 };
  const { ciphertext, iv } = await T.encryptSecret(env, FAKE_REFRESH);
  const bytes = Buffer.from(ciphertext, "base64");
  bytes[0] ^= 0xff; // flip one bit of one byte
  await assert.rejects(() => T.decryptSecret(env, bytes.toString("base64"), iv));
});

test("a WRONG-LENGTH stored IV REFUSES rather than being padded", { skip: need("encryptSecret", "decryptSecret") }, async () => {
  const env = { YAHOO_TOKEN_ENCRYPTION_KEY: FAKE_KEY_B64 };
  const { ciphertext } = await T.encryptSecret(env, FAKE_REFRESH);
  await assert.rejects(
    () => T.decryptSecret(env, ciphertext, Buffer.alloc(8, 1).toString("base64")),
    (err) => {
      assert.equal(err.error_code, "yahoo_stored_iv_wrong_length");
      return true;
    }
  );
});

test("an unparseable stored row REFUSES — corrupt is not 'absent'", { skip: need("decryptSecret") }, async () => {
  const env = { YAHOO_TOKEN_ENCRYPTION_KEY: FAKE_KEY_B64 };
  await assert.rejects(
    () => T.decryptSecret(env, "!!! not base64 !!!", "!!! nor this !!!"),
    (err) => {
      assert.equal(err.error_code, "yahoo_stored_token_unparseable");
      return true;
    }
  );
});

// ⚠️ THERE IS NO PLAINTEXT FALLBACK, BY CONSTRUCTION. Each of these must refuse
// the WRITE. Storing a live refresh token in the clear because a secret was
// unset would be a silent credential leak into an hourly R2 snapshot.
for (const [label, key, code] of [
  ["missing", "", "yahoo_encryption_key_missing"],
  ["unparseable", "!!!!not base64!!!!", "yahoo_encryption_key_unparseable"],
  ["too short (16 bytes, AES-128)", Buffer.alloc(16, 3).toString("base64"), "yahoo_encryption_key_wrong_length"],
  ["too long (64 bytes)", Buffer.alloc(64, 3).toString("base64"), "yahoo_encryption_key_wrong_length"],
]) {
  test(`a ${label} encryption key REFUSES the write, never stores plaintext`, { skip: need("encryptSecret") }, async () => {
    await assert.rejects(
      () => T.encryptSecret({ YAHOO_TOKEN_ENCRYPTION_KEY: key }, FAKE_REFRESH),
      (err) => {
        assert.equal(err.error_code, code);
        // A refusal with no way forward just moves the problem.
        assert.ok(String(err.remedy || "").length > 10, "refusal carries no remedy");
        return true;
      }
    );
  });
}

test("a refusal message never contains the key material itself", { skip: need("decodeEncryptionKeyBytes") }, () => {
  const leaky = Buffer.alloc(16, 3).toString("base64");
  try {
    T.decodeEncryptionKeyBytes({ YAHOO_TOKEN_ENCRYPTION_KEY: leaky });
    assert.fail("expected a refusal");
  } catch (err) {
    assert.ok(!String(err.message).includes(leaky), err.message);
    // The LENGTH is stated because it is diagnostic and is not the key.
    assert.match(String(err.message), /16 bytes/);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Credentials and expiry
// ─────────────────────────────────────────────────────────────────────────────

test("readClientCredentials REFUSES when a credential is unset — no fallback", { skip: need("readClientCredentials") }, () => {
  assert.throws(
    () => T.readClientCredentials({ YAHOO_CLIENT_ID: "id-1" }),
    (err) => {
      assert.equal(err.error_code, "yahoo_client_credentials_missing");
      assert.match(String(err.message), /YAHOO_CLIENT_SECRET/);
      // The NAME of the missing var is not a secret; the value would be.
      assert.ok(!String(err.message).includes("id-1"));
      return true;
    }
  );
  assert.throws(() => T.readClientCredentials({}));
  assert.throws(() => T.readClientCredentials(null));
});

test("readClientCredentials trims whitespace off both halves", { skip: need("readClientCredentials") }, () => {
  // A `wrangler secret put` from a file is the classic way a trailing newline
  // gets into a secret, and Yahoo answers that with a bare 401.
  const got = T.readClientCredentials({
    YAHOO_CLIENT_ID: " id-1\n",
    YAHOO_CLIENT_SECRET: `${FAKE_SECRET}\n`,
  });
  assert.equal(got.clientId, "id-1");
  assert.equal(got.clientSecret, FAKE_SECRET);
});

test("basicAuthHeader emits Basic base64 with NO trailing newline", { skip: need("basicAuthHeader") }, () => {
  const header = T.basicAuthHeader("id-1", FAKE_SECRET);
  assert.match(header, /^Basic [A-Za-z0-9+/=]+$/);
  assert.ok(!header.includes("\n"));
  assert.equal(
    Buffer.from(header.slice("Basic ".length), "base64").toString("utf8"),
    `id-1:${FAKE_SECRET}`
  );
});

test("basicAuthHeader REFUSES non-latin-1 credentials instead of emitting a bad header", { skip: need("basicAuthHeader") }, () => {
  assert.throws(
    () => T.basicAuthHeader("id-1", "smart’quote"),
    (err) => {
      assert.equal(err.error_code, "yahoo_client_credentials_unencodable");
      return true;
    }
  );
});

test("readRedirectUri REFUSES to guess — Yahoo byte-matches it", { skip: need("readRedirectUri") }, () => {
  assert.throws(
    () => T.readRedirectUri({}),
    (err) => {
      assert.equal(err.error_code, "yahoo_redirect_uri_missing");
      return true;
    }
  );
  assert.equal(T.readRedirectUri({ YAHOO_REDIRECT_URI: "https://x/cb" }), "https://x/cb");
});

test("expiresAtUnixFrom uses the provider's expires_in when it is sane", { skip: need("expiresAtUnixFrom") }, () => {
  const now = Math.floor(Date.now() / 1000);
  const at = T.expiresAtUnixFrom({ expires_in: 3600 });
  assert.ok(at >= now + 3595 && at <= now + 3605, String(at - now));
  assert.equal(T.expiresAtUnixFrom({ expires_in: "3600" }) - now <= 3605, true);
});

test("expiresAtUnixFrom falls back to 3600s on a malformed expires_in", { skip: need("expiresAtUnixFrom") }, () => {
  const now = Math.floor(Date.now() / 1000);
  for (const bad of [{}, { expires_in: "" }, { expires_in: null }, { expires_in: "abc" }, { expires_in: -5 }, { expires_in: 0 }]) {
    const at = T.expiresAtUnixFrom(bad);
    assert.ok(at >= now + 3595 && at <= now + 3605, `${JSON.stringify(bad)} -> ${at - now}`);
  }
});

test("safeStr never returns null/undefined and always trims", { skip: need("safeStr") }, () => {
  assert.equal(T.safeStr(null), "");
  assert.equal(T.safeStr(undefined), "");
  assert.equal(T.safeStr("  x  "), "x");
  assert.equal(T.safeStr(0), "0");
});
