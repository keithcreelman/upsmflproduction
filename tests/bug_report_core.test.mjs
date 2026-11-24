// bug_report_core.js -- the pure rules: redaction corpus, endpoint cleaning, fingerprint, rate math, owner wording.
//   node tests/bug_report_core.test.mjs
import { t, test, run } from "./fixtures/mini_test.mjs";
import {
  LIMITS, ALLOWED_FIELDS, MESSAGES, redactText, cleanEndpointPath, validateSubmission,
  fingerprintText, fingerprint, rateDecision, windowStartIso, reportCode, ownerMessage,
} from "../worker/src/bug_report_core.js";

const SEC = (n) => Array.from({ length: n }, (_, i) => "aZ09"[i % 4]).join("");

test("redaction corpus: every secret shape is removed, the useful words are kept", () => {
  const corpus = [
    ["APIKEY=abc123def", "abc123def"], ["api_key: 'quoted secret'", "quoted secret"], ["apikey = zzzTOP", "zzzTOP"],
    ["MFL_USER_ID=sessionvalue9", "sessionvalue9"], ["mfl_user_id: sessionvalue9", "sessionvalue9"],
    ["Cookie: MFL_USER_ID=cv77", "cv77"], ["Set-Cookie: sid=abc", "sid=abc"],
    ["password=hunter2", "hunter2"], ["passwd: hunter2", "hunter2"], ["secret = s3", "s3"],
    ["token: tk_9", "tk_9"], ["access_token=at9", "at9"], ["refresh_token=rt9", "rt9"], ["sessionid=sid55", "sid55"],
    ["Authorization: Bearer abcdef123456", "abcdef123456"], ["Bearer eyJhbGciOiJIUzI1NiJ9", "eyJhbGciOiJIUzI1NiJ9"],
    ["https://discord.com/api/webhooks/123/abcTOKEN", "abcTOKEN"], ["https://discordapp.com/api/webhooks/1/xyz", "xyz"],
    ["ghp_" + SEC(36), SEC(36)], [SEC(40), SEC(40)],
    ["me@example.com", "me@example.com"],
    ["GET https://api.example.com/x?APIKEY=k1&b=2", "k1"], ["see https://a.example/p#access_token=zz", "zz"],
  ];
  for (const [input, secret] of corpus) {
    const r = redactText("before " + input + " after");
    t.ok(!r.text.includes(secret), "removed from: " + input + " -> " + r.text);
    t.ok(r.count >= 1, "counted: " + input);
    t.match(r.text, /^before .* after$/, "surrounding words kept: " + input);
  }
});

test("redaction leaves ordinary text alone", () => {
  for (const s of ["Waiver window won't load", "TypeError: Cannot read properties of undefined (reading 'window')", "HTTP 500 from /api/waivers/window", "Tapped Market then Bids, 3 times", "https://api.example.com/2026/export"]) {
    const r = redactText(s);
    t.equal(r.text, s);
    t.equal(r.count, 0);
  }
});

test("control characters and bidi overrides are removed", () => {
  t.equal(redactText("a\u0000b\u0007c").text, "abc", "NUL and BEL removed");
  t.equal(redactText("line\u2028sep").text, "linesep");
  t.equal(redactText("ok\u202Eevil\u202C").text, "okevil", "right-to-left override removed");
});

test("endpoint cleaning: path only, no host, query, fragment, odd characters or token-looking segments", () => {
  t.equal(cleanEndpointPath("https://worker.example.dev/api/roster?MFL_USER_ID=abc#x"), "/api/roster");
  t.equal(cleanEndpointPath("/api/waivers/window?L=74598&YEAR=2026"), "/api/waivers/window");
  t.equal(cleanEndpointPath("api/no-leading-slash"), "");
  t.equal(cleanEndpointPath("/api/<script>alert(1)</script>"), "/api/scriptalert1/script");
  t.equal(cleanEndpointPath("/api/x/abcdef0123456789abcdef0123456789"), "/api/x/:id");
  t.equal(cleanEndpointPath(""), "");
  t.ok(cleanEndpointPath("/" + "a/".repeat(200)).length <= LIMITS.ENDPOINT_MAX);
});

test("validation: allowlist, required fields, caps, mfl_user_id consumed not stored", () => {
  const base = { client_request_id: "req-00001", summary: "Won't load", screen: "Market", mfl_user_id: "tok" };
  const ok = validateSubmission(base);
  t.equal(ok.ok, true);
  t.equal(ok.token, "tok");
  t.ok(!("mfl_user_id" in ok.value), "token is not part of the stored value");
  t.deepEqual(Object.keys(validateSubmission({ ...base, extra: 1 })), ["ok", "code", "message", "fields"]);
  t.equal(validateSubmission({ ...base, extra: 1 }).code, "unknown_field");
  t.equal(validateSubmission(null).code, "bad_request");
  t.equal(validateSubmission([]).code, "bad_request");
  t.equal(validateSubmission({ ...base, summary: "ab" }).code, "summary_required");
  t.equal(validateSubmission({ ...base, error: "text" }).code, "bad_request");
  t.equal(validateSubmission({ ...base, error: { name: "E", extra: 1 } }).code, "unknown_field");
  t.equal(validateSubmission({ ...base, client_request_id: "has space!!" }).code, "bad_request");
  t.equal(validateSubmission({ ...base, viewport: { w: 99999, h: 5 } }).value.viewport, "", "absurd viewport dropped");
  t.equal(validateSubmission({ ...base, client_time: "not a date" }).value.client_time, "");
  t.equal(validateSubmission({ ...base, error: { status: 99 } }).value.err_status, null);
  t.equal(validateSubmission({ ...base, online: "yes" }).value.online, null);
  t.ok(ALLOWED_FIELDS.includes("mfl_user_id") && !ALLOWED_FIELDS.includes("franchise_id") && !ALLOWED_FIELDS.includes("screenshot"), "no franchise id, no screenshot field");
});

test("fingerprint: same problem collapses digits and case; a different endpoint or screen differs", async () => {
  const a = { screen: "Market › Find players", err_name: "TypeError", err_message: "Row 12 of 40 failed", err_endpoint: "/api/a", err_status: 500, summary: "x" };
  const same = { ...a, screen: "market › find players", err_message: "row 999 of 1 FAILED" };
  const otherEndpoint = { ...a, err_endpoint: "/api/b" };
  const otherScreen = { ...a, screen: "Roster" };
  t.equal(await fingerprint(a), await fingerprint(same));
  t.notEqual(await fingerprint(a), await fingerprint(otherEndpoint));
  t.notEqual(await fingerprint(a), await fingerprint(otherScreen));
  t.equal((await fingerprint(a)).length, 32);
  const noErrA = { screen: "S", summary: "Button does nothing", err_name: "", err_message: "", err_endpoint: "", err_status: null };
  t.notEqual(await fingerprint(noErrA), await fingerprint({ ...noErrA, summary: "Something else broke" }), "with no error the owner's words decide");
  t.match(fingerprintText(noErrA), /button does nothing/);
});

test("rate decision math", () => {
  const T0 = Date.parse("2026-11-19T12:00:00Z");
  const at = (s) => new Date(T0 + s * 1000).toISOString();
  t.deepEqual(rateDecision([], T0), { allow: true });
  t.deepEqual(rateDecision([at(0)], T0 + 5000), { allow: false, code: "too_fast", retryAfterSeconds: 15 });
  t.equal(rateDecision([at(0)], T0 + 20000).allow, true, "exactly 20s is allowed");
  t.equal(rateDecision([at(0)], T0 + 19999).allow, false);
  const five = [at(400), at(300), at(200), at(100), at(0)];
  const d = rateDecision(five, T0 + 500 * 1000);
  t.equal(d.code, "daily_limit");
  t.equal(d.retryAfterSeconds, 86400 - 500, "frees when the OLDEST of the five leaves the window");
  t.equal(rateDecision(five.slice(0, 4), T0 + 500 * 1000).allow, true, "four is under the limit");
  t.equal(windowStartIso(T0), new Date(T0 - 86400000).toISOString());
  t.deepEqual(rateDecision(["junk", null], T0), { allow: true }, "garbage rows are ignored, not trusted");
});

test("report codes are derived, TEST- until a live environment exists", () => {
  t.equal(reportCode({ id: 1, env: "test" }), "TEST-001");
  t.equal(reportCode({ id: 42 }), "TEST-042");
  t.equal(reportCode({ id: 1234, env: "live" }), "APP-1234");
});

test("every refusal has owner-facing words; sign-in problems say nothing was sent and the note is kept", () => {
  for (const [code, m] of Object.entries(MESSAGES)) {
    t.ok(m.title.length >= 8 && m.message.length >= 20 && m.http >= 400 && m.state, code);
    t.equal(ownerMessage(code), m);
  }
  for (const code of ["unauthenticated", "session_expired", "forbidden", "identity_unavailable", "disabled"]) t.match(MESSAGES[code].message, /Nothing was sent/, code);
  for (const code of ["unauthenticated", "session_expired", "identity_unavailable"]) t.match(MESSAGES[code].message, /note is still here/, code);
  t.equal(ownerMessage("nonsense").http, 500, "an unknown code is a server error, never a success");
  const states = new Set(Object.values(MESSAGES).map((m) => m.state));
  for (const s of ["signin", "retry", "off", "limit", "fix", "error"]) t.ok(states.has(s), "state " + s);
});

await run("bug_report_core");
