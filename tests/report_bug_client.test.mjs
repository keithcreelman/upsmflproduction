// site/m/report_bug.js -- the phone sheet's pure logic, and its agreement with the worker.
//   node tests/report_bug_client.test.mjs
// The sheet's DOM is checked in a real browser (the phone preview); this file pins what the
// sheet SENDS, what it SHOWS before sending, and that it never drifts from the server's rules.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { t, test, run } from "./fixtures/mini_test.mjs";
import { ALLOWED_FIELDS, MESSAGES, cleanEndpointPath, validateSubmission, redactText } from "../worker/src/bug_report_core.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = fs.readFileSync(path.join(ROOT, "site", "m", "report_bug.js"), "utf8");
// Code only: the header comment is allowed to name the things the file promises not to do.
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const RB = createRequire(import.meta.url)("../site/m/report_bug.js");

const ctx = (over) => ({
  requestId: "r-test-0001", screen: "Market › Find players", build: "2026.11.19.1", now: "2026-11-19T15:00:00.000Z",
  viewport: { w: 375, h: 812 }, online: true,
  error: { name: "TypeError", message: "Cannot read properties of undefined (reading 'window')", endpoint: "https://worker.example.dev/api/waivers/window?MFL_USER_ID=abc", status: 500 },
  ...(over || {}),
});

test("what the sheet sends is exactly the server's allowlist, and the server accepts it", () => {
  const body = { ...RB.buildPayload(ctx(), { summary: "Waiver window won't load", note: "Tapped Bids." }), mfl_user_id: "tok" };
  for (const k of Object.keys(body)) t.ok(ALLOWED_FIELDS.includes(k), "allowed: " + k);
  for (const k of Object.keys(body.error)) t.ok(["name", "message", "endpoint", "status"].includes(k), "allowed error field: " + k);
  const v = validateSubmission(body);
  t.equal(v.ok, true, JSON.stringify(v));
  t.equal(v.value.err_endpoint, "/api/waivers/window");
  t.ok(!("franchise_id" in body) && !("screenshot" in body) && !("cookie" in body));
});

test("no error captured: no error object is sent, and the preview says so", () => {
  const c = ctx({ error: null });
  const p = RB.buildPayload(c, { summary: "Button does nothing", note: "" });
  t.ok(!("error" in p));
  t.ok(!("note" in p), "an empty note is not sent");
  const rows = Object.fromEntries(RB.previewRows(c, { summary: "x", note: "" }));
  t.equal(rows["Error message"], "No error message was captured");
  t.ok(!("Failed request" in rows));
});

test("the preview shows every fact that is sent", () => {
  const c = ctx();
  const rows = Object.fromEntries(RB.previewRows(c, { summary: "x", note: "" }));
  t.deepEqual(Object.keys(rows), ["Page", "When", "App version", "Screen size", "Connection", "Error message", "Failed request", "Your team"]);
  t.equal(rows["Page"], "Market › Find players");
  t.equal(rows["App version"], "2026.11.19.1");
  t.equal(rows["Screen size"], "375 × 812");
  t.equal(rows["Connection"], "Online");
  t.match(rows["Error message"], /TypeError: Cannot read properties/);
  t.equal(rows["Failed request"], "/api/waivers/window (HTTP 500)", "path only, with the status");
  t.equal(RB.previewRows(ctx({ online: false }), {}).find((r) => r[0] === "Connection")[1], "Offline");
  const p = RB.buildPayload(c, { summary: "x", note: "n" });
  t.equal(p.screen, rows["Page"]);
  t.equal(p.build, rows["App version"]);
});

test("the sheet's address cleaning and scrubbing agree with the server on a shared corpus", () => {
  for (const e of ["https://w.dev/api/roster?MFL_USER_ID=abc#x", "/api/waivers/window?L=1", "api/x", "/api/x/abcdef0123456789abcdef0123456789", "", "/api/<b>/z", "https://h/p"]) {
    t.equal(RB.cleanEndpoint(e), cleanEndpointPath(e), "same path for: " + e);
  }
  const secrets = ["APIKEY=k-9fz", "MFL_USER_ID: sess77", "password=hunter2", "Authorization: Bearer abcdef123456", "token=tk9", "https://a.example/p?access_token=zz"];
  for (const s of secrets) {
    const client = RB.scrubText("see " + s + " ok");
    const server = redactText("see " + s + " ok").text;
    for (const bad of ["k-9fz", "sess77", "hunter2", "abcdef123456", "tk9", "zz"]) {
      t.ok(!client.includes(bad), "client removes " + bad + " from " + s);
      t.ok(!server.includes(bad), "server removes " + bad + " from " + s);
    }
  }
});

test("every server refusal maps to a sheet state; success and duplicate are distinct", () => {
  for (const [code, m] of Object.entries(MESSAGES)) {
    const v = RB.viewForResponse(m.http, { ok: false, code, state: m.state, title: m.title, message: m.message, retry_after_seconds: 7 });
    t.equal(v.kind, "blocked", code);
    t.equal(v.state, m.state, code);
    t.equal(v.title, m.title);
    t.equal(v.message, m.message);
  }
  t.equal(RB.viewForResponse(201, { ok: true, replay: false, duplicate: false, report: { code: "TEST-001" }, redactions: 3 }).kind, "sent");
  t.equal(RB.viewForResponse(200, { ok: true, replay: true, duplicate: false, report: { code: "TEST-001" } }).replay, true);
  const dup = RB.viewForResponse(200, { ok: true, duplicate: true, report: { code: "TEST-001" }, message: "You already reported this (TEST-001)." });
  t.equal(dup.kind, "duplicate");
  t.match(dup.message, /TEST-001/);
  for (const garbage of [null, "html error page", { oops: 1 }]) {
    const v = RB.viewForResponse(502, garbage);
    t.equal(v.kind, "blocked");
    t.equal(v.state, "retry", "an unreadable answer is a retryable error, never a success");
  }
});

test("the phone's own no-sign-in and no-network messages equal the server's wording", () => {
  const m = MESSAGES.unauthenticated;
  t.equal(RB.LOCAL_MESSAGES.unauthenticated.title, m.title);
  t.equal(RB.LOCAL_MESSAGES.unauthenticated.message, m.message);
  t.equal(RB.LOCAL_MESSAGES.unauthenticated.state, m.state);
  t.match(RB.LOCAL_MESSAGES.network.message, /Nothing was sent/);
  t.match(RB.LOCAL_MESSAGES.network.message, /note is still here/);
});

test("wait times read like a person said them", () => {
  t.equal(RB.humanWait(1), "1 second");
  t.equal(RB.humanWait(15), "15 seconds");
  t.equal(RB.humanWait(300), "5 minutes");
  t.equal(RB.humanWait(86290), "about 24 hours");
  t.equal(RB.humanWait(7200), "about 2 hours");
});

test("copy-to-commissioner text has the facts and never the sign-in", () => {
  const p = { ...RB.buildPayload(ctx(), { summary: "Won't load", note: "Tapped Bids" }), mfl_user_id: "SUPER-SECRET-TOKEN" };
  const text = RB.copyText(p);
  t.match(text, /Problem: Won't load/);
  t.match(text, /Request: \/api\/waivers\/window \(HTTP 500\)/);
  t.match(text, /Notes: Tapped Bids/);
  t.doesNotMatch(text, /SUPER-SECRET-TOKEN|mfl_user_id/);
});

test("privacy by construction: no browser storage, no sign-in in an address, no logging", () => {
  t.doesNotMatch(CODE, /localStorage|sessionStorage|indexedDB|document\.cookie/, "nothing is persisted on the phone");
  t.doesNotMatch(CODE, /MFL_USER_ID\s*=/, "the sign-in is never put in an address");
  t.doesNotMatch(CODE, /console\.(log|warn|error|info)/, "nothing is logged");
  t.match(CODE, /credentials: "omit"/, "no cookies are sent");
  t.match(CODE, /body\.mfl_user_id = userId/, "the sign-in travels in the body");
  t.doesNotMatch(CODE, /html2canvas|toDataURL|getDisplayMedia|captureStream|\.screenshot\(|dom-to-image/i, "no screenshot capture code in this slice");
});

test("the error memory keeps only recent, cleaned errors", () => {
  RB.install({ build: "t" });
  RB.noteFailure({ message: "boom at https://x.dev/api/a?APIKEY=zzz9", endpoint: "https://x.dev/api/a?APIKEY=zzz9", status: 500 });
  const e = RB.lastError();
  t.equal(e.endpoint, "/api/a");
  t.ok(!JSON.stringify(e).includes("zzz9"));
  t.equal(e.status, 500);
});

await run("report_bug_client");
