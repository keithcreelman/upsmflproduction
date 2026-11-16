// PUBLIC DATA FILES: account identifiers and free-text fields are not committed, and the two writers can be paused.
//   node tests/public_data_hygiene.test.mjs
//
// The worker commits two data files on use: the trade-offers file and the bug-reports file. This runs the REAL worker with the
// GitHub, MFL and Discord edges stubbed, captures exactly what it would commit, and requires:
//   * an account identifier never appears in a committed bug report, in ANY field (the id fields, `submitted_by_label`, the
//     captured page context);
//   * screenshots are committed as metadata only (the Discord thread still gets the images);
//   * an offer's free-text fields are emptied in the row the worker commits, while the in-memory row (the day-one trade
//     message) keeps them, and rows it did not touch are written exactly as they were (no incidental change to existing data);
//   * each writer is paused unless its flag is EXACTLY the string "1" (padded values stay paused), and while paused makes zero
//     writes, in every code path, while MFL, the outbox, accept/decline, extensions and Discord keep working;
//   * the bug-report list route answers only a commissioner;
//   * the widget's outgoing request carries no account identifier (only the commissioner's Discord test, an /admin route that
//     the worker authenticates with it, still sends it, in the URL).
// Every value here is synthetic. Nothing is sent anywhere.
import fs from "node:fs";
import vm from "node:vm";
import { t, test, run } from "./fixtures/mini_test.mjs";
import { makeWorkerEnv, makeMfl, callWorker, quiet, bindSelf, ADMIN_KEY } from "./fixtures/worker_harness.mjs";
import { applyMigrations } from "./fixtures/d1_sqlite.mjs";

import { blankOfferText, scrubBugLabel, withoutAccountIds, storableBugRow } from "../worker/src/public_data_hygiene.js";

const { processTradeOfferReminders } = await import("../worker/src/trade_dm.js");   // after the harness has registered the .md loader
const restore = quiet();
const ID_A = "SYNTHETIC-ID-A-0123456789=";   // never a real value
const ID_B = "SYNTHETIC-ID-B-ABCDEFGHIJKLMN==";
const Q = "L=74598&YEAR=2026";
const b64 = (o) => Buffer.from(JSON.stringify(o), "utf8").toString("base64");
const unb64 = (s) => Buffer.from(String(s), "base64").toString("utf8");

// A GitHub whose contents API serves `seed[path]` and records every PUT (path → committed text) and every non-GET call at all.
// With opts.discord, Discord is stood in for too: it records the messages (and how many files rode with each) and can be made to fail.
function withGithub(seed, opts) {
  opts = opts || {};
  const puts = [], writes = [], discord = [];
  const mflFetch = globalThis.fetch;
  const json = (o, status) => new Response(JSON.stringify(o), { status: status || 200, headers: { "content-type": "application/json" } });
  globalThis.fetch = async (input, init) => {
    const u = new URL(typeof input === "string" ? input : input.url);
    const method = String((init && init.method) || "GET").toUpperCase();
    if (u.hostname === "api.github.com") {
      if (method !== "GET") writes.push({ method, path: u.pathname });
      if (/\/contents\//.test(u.pathname)) {
        const path = decodeURIComponent(u.pathname.replace(/^.*\/contents\//, ""));
        if (method === "PUT") {
          const body = JSON.parse(init.body);
          puts.push({ path, text: unb64(body.content) });
          if (seed) seed[path] = JSON.parse(unb64(body.content));   // the next read sees what was committed
          return json({ content: { sha: "sha-new" }, commit: { sha: "commit-1" } });
        }
        if (seed && seed[path]) return json({ sha: "sha-old", encoding: "base64", content: b64(seed[path]) });
        return json({ message: "Not Found" }, 404);
      }
    }
    if (opts.discord && u.hostname === "discord.com") {
      const body = init && init.body;
      let files = 0, content = "";
      if (body && typeof body.getAll === "function") {
        files = [...body.keys()].filter((k) => /^files\[/.test(k)).length;
        try { content = JSON.parse(body.get("payload_json")).content || ""; } catch (_) { /* none */ }
      } else if (typeof body === "string") {
        try { content = JSON.parse(body).content || ""; } catch (_) { /* none */ }
      }
      discord.push({ path: u.pathname, files, content });
      if (opts.discord.fail) return new Response("synthetic discord failure", { status: 500 });
      if (/\/threads$/.test(u.pathname)) return json({ id: "thread-1" });
      return json({ id: "msg-1", attachments: Array.from({ length: files }, () => ({})) });
    }
    return mflFetch(input, init);
  };
  return { puts, writes, discord, done() { globalThis.fetch = mflFetch; } };
}
const DISCORD_ENV = { DISCORD_BUG_CHANNEL_ID: "123456789012345678" };

// ───────────── pure helpers ─────────────
test("LABEL: an MFL-token segment is removed; the team name and Commish Enhancement stay; a team literally named MFL… stays", () => {
  t.equal(scrubBugLabel(`Team A | MFL ${ID_A} | Commish Enhancement`, []), "Team A | Commish Enhancement");
  t.equal(scrubBugLabel(`MFL ${ID_A}`, []), "");
  t.equal(scrubBugLabel("MFL Champions | Commish Enhancement", []), "MFL Champions | Commish Enhancement");
  t.equal(scrubBugLabel(`Team A | ${ID_A}`, [ID_A]), "Team A", "a known value is removed wherever it sits");
});

test("ROW: every identifier field is emptied and the captured page context is scrubbed (keys, URL parameters, known values)", () => {
  const row = withoutAccountIds({
    mfl_user_id: ID_A, submitted_by_mfl_user_id: ID_A, submitted_by_label: `Team A | MFL ${ID_A}`,
    details: `broken ${ID_B} here`, steps_to_reproduce: "", expected_vs_actual: "",
    context: {
      mfl_user_id: ID_A, submitted_by_mfl_user_id: ID_A, franchise_id: "0003",
      page_url: `https://example.test/p?L=74598&MFL_USER_ID=${encodeURIComponent(ID_A)}&YEAR=2026`,
      referrer: `https://example.test/r?MFL_USER_ID=${ID_A}`, nested: { list: [`x ${ID_B}`] },
    },
  }, [ID_B]);
  const text = JSON.stringify(row);
  t.ok(!text.includes("SYNTHETIC-"), "no synthetic identifier text survives anywhere in the row");
  t.equal(row.mfl_user_id, ""); t.equal(row.submitted_by_mfl_user_id, ""); t.equal(row.submitted_by_label, "Team A");
  t.equal(row.context.franchise_id, "0003", "other context is kept");
  t.ok(/L=74598/.test(row.context.page_url) && /YEAR=2026/.test(row.context.page_url), "the URL keeps its other parameters");
});

test("SCREENSHOTS: the stored row keeps names and sizes only; the input still has the image for Discord", () => {
  const full = { attachments: [{ name: "a.png", type: "image/png", size_bytes: 12, data_url: "data:image/png;base64,AAAA" }] };
  const stored = storableBugRow(full);
  t.ok(!JSON.stringify(stored).includes("data:image"), "no image data in the stored row");
  t.equal(stored.attachments[0].name, "a.png"); t.equal(stored.attachments[0].image_stored, false);
  t.ok(full.attachments[0].data_url.startsWith("data:image"), "the caller's row is not modified");
});

test("OFFER TEXT: the five typed fields are blanked at the top and inside payload; extension requests and ids stay; the input is not changed", () => {
  const row = { id: "TWB-1", message: "SYNTHETIC-NOTE", comment: "SYNTHETIC-NOTE", comments: "SYNTHETIC-NOTE", raw_comment: "SYNTHETIC-NOTE", action_message: "SYNTHETIC-NOTE", will_give_up: "14056,",
    payload: { comment: "SYNTHETIC-NOTE", message: "SYNTHETIC-NOTE", extension_requests: [{ player_id: "14056", years: 2 }], teams: [{ franchise_id: "0001", comments: "SYNTHETIC-NOTE" }] } };
  const out = blankOfferText(row);
  t.ok(!JSON.stringify(out).includes("SYNTHETIC-NOTE"), "no typed text survives");
  t.equal(out.id, "TWB-1"); t.equal(out.will_give_up, "14056,");
  t.deepEqual(out.payload.extension_requests, [{ player_id: "14056", years: 2 }]);
  t.equal(row.message, "SYNTHETIC-NOTE", "the original row still has its text (the day-one DM uses it)");
});

// ───────────── through the real worker ─────────────
const bugBody = () => ({
  details: "The roster page shows the wrong salary.", module: "roster", issue_type: "bug", franchise_id: "0003", franchise_name: "Test Team",
  mfl_user_id: ID_A, submitted_by_mfl_user_id: ID_A, submitted_by_label: `Test Team | MFL ${ID_A}`,
  context: { mfl_user_id: ID_A, submitted_by_mfl_user_id: ID_A, page_url: `https://example.test/p?MFL_USER_ID=${ID_A}&L=74598`, franchise_id: "0003" },
  attachments: [{ name: "shot.png", type: "image/png", size_bytes: 4, data_url: "data:image/png;base64,AAAA" }],
});

test("WORKER bug report: the committed file has no account identifier in any field, screenshots are metadata only", async () => {
  const env = makeWorkerEnv({ BUG_REPORT_PUBLIC_WRITES_ENABLED: "1" }); env.GITHUB_PAT = "test-pat"; const mfl = makeMfl(); mfl.install();
  const gh = withGithub({});
  try {
    // the value arrives three ways at once: the URL (as the widget sends it), the body, and the label the old code built
    const r = await callWorker(env, "POST", `/bug-report?${Q}&MFL_USER_ID=${encodeURIComponent(ID_A)}`, { body: bugBody() });
    t.equal(r.status, 201, r.text.slice(0, 200));
    const put = gh.puts.filter((p) => /bug_reports_74598_2026\.json$/.test(p.path));
    t.ok(put.length >= 1, "the report was committed");
    for (const p of put) {
      t.ok(!p.text.includes("SYNTHETIC-"), "no account identifier in the committed file");
      t.ok(!/MFL_USER_ID\s*=/i.test(p.text), "no MFL_USER_ID= parameter in the committed file");
      const doc = JSON.parse(p.text); const row = doc.reports[0];
      t.equal(row.mfl_user_id, ""); t.equal(row.submitted_by_mfl_user_id, "");
      t.doesNotMatch(row.submitted_by_label, /\bMFL\b/i, "submitted_by_label carries no MFL segment");
      t.equal(row.submitted_by_label, "Test Team");
      t.equal(row.attachments.length, 1); t.ok(!("data_url" in row.attachments[0]), "no image data committed"); t.equal(row.attachments[0].name, "shot.png");
      t.equal(row.details, "The roster page shows the wrong salary.", "typed text is unchanged");
    }
  } finally { gh.done(); mfl.restore(); }
});

test("WORKER bug report: with no label sent, the worker builds one from the team name, never from the identifier", async () => {
  const env = makeWorkerEnv({ BUG_REPORT_PUBLIC_WRITES_ENABLED: "1" }); env.GITHUB_PAT = "test-pat"; const mfl = makeMfl(); mfl.install();
  const gh = withGithub({});
  try {
    const body = bugBody(); delete body.submitted_by_label; body.franchise_name = ""; body.franchise_id = "0004"; body.request_kind = "commish-enhancement";
    const r = await callWorker(env, "POST", `/bug-report?${Q}&MFL_USER_ID=${encodeURIComponent(ID_B)}`, { body });
    t.equal(r.status, 201, r.text.slice(0, 200));
    const p = gh.puts.filter((x) => /bug_reports_/.test(x.path)).pop();
    t.ok(!p.text.includes("SYNTHETIC-"), "no account identifier");
    t.equal(JSON.parse(p.text).reports[0].submitted_by_label, "0004 | Commish Enhancement");
  } finally { gh.done(); mfl.restore(); }
});

test("SOURCE GUARD: the label is never built from the account identifier again", () => {
  const src = fs.readFileSync(new URL("../worker/src/index.js", import.meta.url), "utf8");
  t.ok(!/`MFL \$\{mflUserId\}`/.test(src), "no `MFL ${mflUserId}` label segment");
  t.ok(!/mfl_user_id:\s*mflUserId/.test(src) && !/submitted_by_mfl_user_id:\s*mflUserId/.test(src), "the id is never copied into a report row");
});

test("WORKER bug-report list: anonymous 401; an owner 403; a bad login token 401; a worker key or a commissioner login 200", async () => {
  const env = makeWorkerEnv({ BUG_REPORT_PUBLIC_WRITES_ENABLED: "1" }); env.GITHUB_PAT = "test-pat"; const mfl = makeMfl(); mfl.install();
  const gh = withGithub({});
  try {
    const get = (extra) => callWorker(env, "GET", `/bug-reports?${Q}${extra || ""}`);
    t.equal((await get()).status, 401);
    t.equal((await get("&MFL_USER_ID=tok-B")).status, 403, "a franchise owner is not a commissioner");
    t.equal((await get("&MFL_USER_ID=not-a-login")).status, 401);
    t.equal((await get("&APIKEY=wrong-key")).status, 403);
    const ok1 = await get(`&APIKEY=${ADMIN_KEY}`); t.equal(ok1.status, 200, ok1.text.slice(0, 120));
    const ok2 = await get("&MFL_USER_ID=tok-commish"); t.equal(ok2.status, 200, ok2.text.slice(0, 120));
    t.ok(!/Authentication|Not permitted/.test(ok1.text));
  } finally { gh.done(); mfl.restore(); }
});

const P2 = (id) => ({ asset_id: `P_${id}`, type: "PLAYER", player_id: String(id), player_name: `P${id}`, salary: 1, taxi: false, contract_info: "" });
const offerPayload = (from, to, give, recv, comment) => ({
  schema_version: 1, source: "test", league_id: "74598", season: "2026", comment,
  teams: [{ role: "left", franchise_id: from, selected_assets: give.map(P2), traded_salary_adjustment_k: 0 },
    { role: "right", franchise_id: to, selected_assets: recv.map(P2), traded_salary_adjustment_k: 0 }],
  extension_requests: [], ui: { left_team_id: from, right_team_id: to }, validation: { status: "ready" },
});

test("WORKER offer: the committed row has no typed note; rows it did not touch are written exactly as before", async () => {
  const env = makeWorkerEnv({ BUG_REPORT_PUBLIC_WRITES_ENABLED: "1", TRADE_OFFERS_PUBLIC_WRITES_ENABLED: "1" }); env.GITHUB_PAT = "test-pat"; const mfl = makeMfl(); mfl.install();
  const old = { id: "TWB-old", league_id: "74598", season: 2026, status: "ACCEPTED", from_franchise_id: "0003", to_franchise_id: "0004", message: "SYNTHETIC-OLD-NOTE", comment: "SYNTHETIC-OLD-NOTE", payload: { comment: "SYNTHETIC-OLD-NOTE" } };
  const seedDoc = { meta: { schema_version: 1, league_id: "74598", season: 2026, row_count: 1 }, offers: [old] };
  const gh = withGithub({ "site/trades/trade_offers_74598_2026.json": seedDoc });
  try {
    const r = await callWorker(env, "POST", `/api/trades/proposals?${Q}&MFL_USER_ID=tok-B`, { body: { league_id: "74598", season: "2026", from_franchise_id: "0001", to_franchise_id: "0002",
      message: "SYNTHETIC-NOTE-NEW", comment: "SYNTHETIC-NOTE-NEW", payload: offerPayload("0001", "0002", [14056], [13100], "SYNTHETIC-NOTE-NEW") } });
    t.ok(r.status < 300, `${r.status} ${r.text.slice(0, 200)}`);
    const p = gh.puts.filter((x) => /trade_offers_74598_2026\.json$/.test(x.path)).pop();
    t.ok(p, "the offer was committed");
    t.ok(!p.text.includes("SYNTHETIC-NOTE-NEW"), "the new offer's typed note is not in the committed file");
    t.ok(p.text.includes("SYNTHETIC-OLD-NOTE"), "an existing row is written exactly as it was (no incidental clean-up)");
    const doc = JSON.parse(p.text);
    const fresh = doc.offers.find((o) => o.id !== "TWB-old");
    t.ok(fresh, "the new offer row is present"); t.equal(fresh.from_franchise_id, "0001"); t.equal(fresh.to_franchise_id, "0002");
    t.equal(fresh.message, ""); t.equal(fresh.comment, ""); t.equal(fresh.payload.comment, "");
    t.ok(Array.isArray(fresh.payload.teams) && fresh.payload.teams.length === 2, "the rest of the payload is kept");
  } finally { gh.done(); mfl.restore(); }
});

// ───────────── the widget's outgoing request ─────────────
// The REAL widget functions, sliced out of site/ups_options_widget.js and run with a fake page: nothing leaves this process.
const WIDGET = fs.readFileSync(new URL("../site/ups_options_widget.js", import.meta.url), "utf8");
function slice(name) {
  const m = new RegExp(`\n  (async )?function ${name}\\(`).exec(WIDGET);
  if (!m) throw new Error(`widget function ${name} not found`);
  const start = m.index + 1, end = WIDGET.indexOf("\n  }\n", start);
  return WIDGET.slice(start, end + 4);
}
function widget({ admin, reply }) {
  const sent = [], statuses = [];
  let resets = 0;
  const els = { "#uowBugModule": { value: "roster" }, "#uowBugType": { value: "bug" }, "#uowBugDetails": { value: "The salary looks wrong.", focus() {} }, "#uowBugCommishEnhancement": { checked: false }, "#uowBugForm": { reset() { resets += 1; } } };
  const state = { bugBusy: false, bugAttachmentsBusy: false, bugViewerIsAdmin: !!admin, theme: "light", bugSourceApp: "",
    bugAttachments: [{ name: "shot.png", type: "image/png", original_type: "image/png", size_bytes: 4, data_url: "data:image/png;base64,AAAA" }] };
  const env = {
    window: { location: { href: `https://league.example.test/2026/home/74598?L=74598&YEAR=2026&FRANCHISE_ID=0003&MFL_USER_ID=${encodeURIComponent(ID_A)}&APIKEY=SYNTHETIC-KEY-W&token=SYNTHETIC-KEY-T#a=1`,
      search: `?L=74598&YEAR=2026&FRANCHISE_ID=0003&MFL_USER_ID=${encodeURIComponent(ID_A)}&APIKEY=SYNTHETIC-KEY-W&token=SYNTHETIC-KEY-T`, host: "league.example.test" }, innerWidth: 390, innerHeight: 800, screen: { width: 390, height: 844 } },
    document: { cookie: `MFL_USER_ID=${encodeURIComponent(ID_B)}`, referrer: `https://league.example.test/r?MFL_USER_ID=${ID_A}&x=1`, body: { getAttribute: () => "" } },
    navigator: { userAgent: "test", platform: "test", language: "en" },
    $: (sel) => els[sel] || null, state,
    safeStr: (v) => String(v == null ? "" : v).trim(), safeInt: (v) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : 0; },
    parseSeasonYear: () => 2026, parseFranchiseId: () => "0003", parseLeagueId: () => "74598", getFranchiseNameById: () => "Test Team",
    getHashParams: () => new URLSearchParams(""), parseWorkerBaseUrl: () => "https://worker.example.test",
    setBugStatus: (msg, tone) => statuses.push({ msg, tone }), setBugSubmitBusy() {}, populateBugTypeOptions() {}, resetBugAttachments() {},
    syncBugEnhancementUi() {}, renderBugContextNote() {},
    fetch: async (url, init) => {
      sent.push({ url: String(url), init });
      const r = reply || { status: 200, json: { ok: true, bug_id: "B-1", notify: { ok: true, attachments_expected: 1, attachments_sent: 1 } } };
      return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.json };
    },
  };
  const names = ["parseMflUserId", "readCookie", "bugAuthToken", "withoutIdParams", "buildBugContext", "parseBugNotifyReason", "buildBugRequestPayload", "performBugReportSubmit"];
  const code = names.map(slice).join("\n") + "\nreturn { performBugReportSubmit, buildBugRequestPayload, buildBugContext };";
  const keys = Object.keys(env);
  const fns = new Function(...keys, code)(...keys.map((k) => env[k]));
  return { fns, sent, statuses, resets: () => resets };
}

test("WIDGET: a normal report's request has no account identifier in the URL, the body, the label or the page context", async () => {
  const { fns, sent } = widget({ admin: false });
  await fns.performBugReportSubmit("submit");
  t.equal(sent.length, 1);
  const { url, init } = sent[0];
  t.match(url, /\/bug-report\?L=74598&YEAR=2026$/, "the report route is called with the league and season only");
  t.ok(!/MFL_USER_ID/i.test(url) && !url.includes("SYNTHETIC-"), "no identifier parameter in the URL");
  t.ok(!/SYNTHETIC-/.test(init.body), "no identifier anywhere in the body");
  const body = JSON.parse(init.body);
  t.ok(!("mfl_user_id" in body), "no mfl_user_id in the body");
  t.ok(!("mfl_user_id" in body.context) && !("submitted_by_mfl_user_id" in body.context), "no identifier field in the page context");
  t.equal(body.submitted_by_label, "Test Team");
  t.ok(!/MFL_USER_ID/i.test(body.context.page_url) && /L=74598/.test(body.context.page_url), "page_url keeps its other parameters");
  t.ok(!/MFL_USER_ID/i.test(body.context.referrer), "the referrer is scrubbed too");
  t.equal(body.attachments.length, 1); t.ok(body.attachments[0].data_url.startsWith("data:image/"), "the screenshot still goes to the worker, for Discord");
});

test("WIDGET: only the commissioner's Discord test sends the login token, in the URL, because that /admin route is authenticated by it", async () => {
  const { fns, sent } = widget({ admin: true });
  await fns.performBugReportSubmit("test");
  const { url, init } = sent[0];
  t.match(url, /\/admin\/bug-report\/test-discord\?/);
  t.ok(url.includes("MFL_USER_ID=" + encodeURIComponent(ID_A)), "the login token is in the URL of the authenticated test route");
  t.ok(!/SYNTHETIC-/.test(init.body), "and still not in the body");
});

test("WORKER: the report route needs no login (the widget no longer sends one); the Discord test needs a commissioner login", async () => {
  const env = makeWorkerEnv({ BUG_REPORT_PUBLIC_WRITES_ENABLED: "1" }); env.GITHUB_PAT = "test-pat"; const mfl = makeMfl(); mfl.install();
  const gh = withGithub({});
  try {
    const noLogin = bugBody(); delete noLogin.mfl_user_id; delete noLogin.submitted_by_mfl_user_id; noLogin.context = { franchise_id: "0003" };
    const open = await callWorker(env, "POST", `/bug-report?${Q}`, { body: noLogin });
    t.equal(open.status, 201, "open intake: no login needed");
    const anon = await callWorker(env, "POST", `/admin/bug-report/test-discord?${Q}`, { body: noLogin });
    t.equal(anon.status, 401, "the Discord test refuses a caller with no login");
    const owner = await callWorker(env, "POST", `/admin/bug-report/test-discord?${Q}&MFL_USER_ID=tok-B`, { body: noLogin });
    t.equal(owner.status, 403, "and an owner login");
    const commish = await callWorker(env, "POST", `/admin/bug-report/test-discord?${Q}&MFL_USER_ID=tok-commish`, { body: noLogin });
    t.equal(commish.json && commish.json.test_only, true, "a commissioner login reaches the test route");
  } finally { gh.done(); mfl.restore(); }
});

// ───────────── screenshots stay in Discord only ─────────────
test("SCREENSHOTS: both routes hand the images to the Discord builder and neither commits them", async () => {
  const env = makeWorkerEnv({ BUG_REPORT_PUBLIC_WRITES_ENABLED: "1" }); env.GITHUB_PAT = "test-pat"; const mfl = makeMfl(); mfl.install();
  const gh = withGithub({});
  try {
    const body = bugBody(); body.attachments = [{ name: "shot.png", type: "image/png", size_bytes: 4, data_url: "data:image/png;base64,iVBORw0KGgo=" }];
    const real = await callWorker(env, "POST", `/bug-report?${Q}`, { body });
    t.equal(real.status, 201, real.text.slice(0, 160));
    t.equal(real.json.notify.attachments_expected, 1); t.equal(real.json.notify.attachments_decoded, 1, "the real route still decodes the image for Discord");
    const committed = gh.puts.filter((p) => /bug_reports_/.test(p.path));
    t.ok(committed.length >= 1 && committed.every((p) => !p.text.includes("data:image") && !p.text.includes("iVBORw0KGgo")), "no image bytes in anything committed");
    const before = gh.puts.length;
    const test = await callWorker(env, "POST", `/admin/bug-report/test-discord?${Q}&APIKEY=${ADMIN_KEY}`, { body });
    t.equal(test.json.notify.attachments_decoded, 1, "the Discord test route decodes the image too");
    t.equal(gh.puts.length, before, "the test route commits nothing at all");
  } finally { gh.done(); mfl.restore(); }
});

// ───────────── TEMPORARY PAUSE on public bug-report writes ─────────────
// A synthetic LEGACY report already in the file, a screenshot, and a stubbed Discord.
const PNG = "data:image/png;base64,iVBORw0KGgo=";
const legacyDoc = () => ({ meta: { schema_version: 1, league_id: "74598", season: 2026 }, reports: [{
  bug_id: "BUG-LEGACY", created_at_utc: "2026-03-10T00:00:00Z", league_id: "74598", season: "2026", mfl_user_id: ID_B, submitted_by_mfl_user_id: ID_B,
  submitted_by_label: `Legacy Team | MFL ${ID_B}`, details: "legacy report", module: "roster", issue_type: "bug", status: "OPEN", attachments: [], context: {} }] });
const FILE = "site/reports/bug_reports_74598_2026.json";
const pausedWorld = (flag, discordOpts) => {
  const over = { ...DISCORD_ENV }; if (flag !== undefined) over.BUG_REPORT_PUBLIC_WRITES_ENABLED = flag;
  const env = makeWorkerEnv(over); env.GITHUB_PAT = "test-pat"; const mfl = makeMfl(); mfl.install();
  const seed = { [FILE]: legacyDoc() };
  const gh = withGithub(seed, { discord: discordOpts || {} });
  return { env, mfl, gh, seed };
};
const withShot = () => { const b = bugBody(); b.attachments = [{ name: "shot.png", type: "image/png", size_bytes: 8, data_url: PNG }]; return b; };

test("PAUSED (flag unset): a report reaches Discord with its screenshot, and NOTHING is written to GitHub", async () => {
  const { env, mfl, gh, seed } = pausedWorld(undefined);
  try {
    const r = await callWorker(env, "POST", `/bug-report?${Q}`, { body: withShot() });
    t.equal(r.status, 201, r.text.slice(0, 200)); t.equal(r.json.ok, true);
    t.match(r.json.bug_id, /^BUG-2026-/, "the id is time-based: it needs no stored file");
    t.deepEqual(r.json.stored, { paused: true, reason: "bug_report_public_writes_paused" });
    t.equal(r.json.notify.ok, true); t.equal(r.json.notify.attachments_sent, 1, "Discord reports the screenshot as delivered");
    const msg = gh.discord.find((d) => /\/messages$/.test(d.path));
    t.ok(msg && msg.files === 1, "the screenshot's bytes went to Discord as a file");
    t.equal(gh.puts.length, 0, "zero public report-file PUTs"); t.equal(gh.writes.length, 0, "zero GitHub writes of any kind");
    t.deepEqual(seed[FILE], legacyDoc(), "the legacy file is exactly as it was");
  } finally { gh.done(); mfl.restore(); }
});

test("PAUSED: if Discord fails the report is NOT saved anywhere, so the answer is a failure (HTTP 502, ok:false) and nothing is written", async () => {
  const { env, mfl, gh } = pausedWorld(undefined, { fail: true });
  try {
    const r = await callWorker(env, "POST", `/bug-report?${Q}`, { body: withShot() });
    t.equal(r.status, 502, r.text.slice(0, 200)); t.equal(r.json.ok, false);
    t.equal(r.json.error, "report_not_delivered_public_storage_paused"); t.equal(r.json.notify.ok, false);
    t.equal(gh.puts.length, 0); t.equal(gh.writes.length, 0);
  } finally { gh.done(); mfl.restore(); }
});

test("PAUSED: follow-up writes are covered too: status and triage refuse with 503 and change nothing; so does a direct call of the writer", async () => {
  const { env, mfl, gh } = pausedWorld("0");
  try {
    const st = await callWorker(env, "POST", `/admin/bug-report/status?${Q}&APIKEY=${ADMIN_KEY}`, { body: { bug_id: "BUG-LEGACY", status: "CLOSED_RESOLVED" } });
    t.equal(st.status, 503); t.equal(st.json.error, "bug_report_public_writes_paused");
    const tr = await callWorker(env, "POST", `/admin/bug-report/triage-note?${Q}&APIKEY=${ADMIN_KEY}`, { body: { bug_id: "BUG-LEGACY", triage_summary: "synthetic note" } });
    t.equal(tr.status, 503); t.equal(tr.json.error, "bug_report_public_writes_paused");
    t.equal(gh.puts.length, 0); t.equal(gh.writes.length, 0, "no GitHub write of any kind");
    const src = fs.readFileSync(new URL("../worker/src/index.js", import.meta.url), "utf8");
    const at = src.indexOf("const writeBugReportsDoc = async");
    t.match(src.slice(at, at + 400), /if \(!bugReportPublicWritesEnabled\(\)\) \{\s*return \{ ok: false, paused: true/, "the writer itself checks the pause before anything else, so no caller can bypass it");
    t.equal([...src.matchAll(/await writeBugReportsDoc\(/g)].length, 4, "exactly the four known callers (first write, thread-metadata follow-up, status, triage)");
  } finally { gh.done(); mfl.restore(); }
});

test("PAUSE IS FAIL-CLOSED: only the exact string 1 enables publishing; unset, 0, empty, true, yes, on, 2, padded \" 1 \", \"1\\n\", \"01\", a full-width 1, the number 1 and true all stay paused", async () => {
  for (const flag of [undefined, "0", "", "true", "yes", "on", "2", " ", " 1 ", "1 ", " 1", "\t1", "1\n", "01", "1.0", "\uFF11", 1, true]) {
    const { env, mfl, gh } = pausedWorld(flag);
    try {
      const r = await callWorker(env, "POST", `/bug-report?${Q}`, { body: withShot() });
      t.equal(r.status, 201, `flag ${JSON.stringify(flag)}: ${r.text.slice(0, 120)}`);
      t.equal(gh.puts.length, 0, `flag ${JSON.stringify(flag)} stays paused`);
    } finally { gh.done(); mfl.restore(); }
  }
  const { env, mfl, gh } = pausedWorld("1");
  try {
    const r = await callWorker(env, "POST", `/bug-report?${Q}`, { body: withShot() });
    t.equal(r.status, 201, r.text.slice(0, 160));
    t.equal(gh.puts.length, 2, "enabled: the first write AND the thread-metadata follow-up both publish (so the pause above really did stop both)");
    t.ok(gh.puts.every((p) => !p.text.includes("data:image") && !p.text.includes("iVBORw0KGgo")), "enabled, still no image bytes in either commit");
    const st = await callWorker(env, "POST", `/admin/bug-report/status?${Q}&APIKEY=${ADMIN_KEY}`, { body: { bug_id: "BUG-LEGACY", status: "CLOSED_RESOLVED" } });
    t.equal(st.status, 200, st.text.slice(0, 200)); t.equal(gh.puts.length, 3, "enabled: the status follow-up writes");
  } finally { gh.done(); mfl.restore(); }
});

test("FLAGS ARE COMPARED DIRECTLY TO \"1\": no trimming, case folding or number parsing, and both Wrangler defaults are the string \"0\"", () => {
  const src = fs.readFileSync(new URL("../worker/src/index.js", import.meta.url), "utf8");
  t.ok(src.includes('const bugReportPublicWritesEnabled = () => env.BUG_REPORT_PUBLIC_WRITES_ENABLED === "1";'), "bug-report flag: direct comparison");
  t.ok(src.includes('const tradeOffersPublicWritesEnabled = () => env.TRADE_OFFERS_PUBLIC_WRITES_ENABLED === "1";'), "offers flag: direct comparison");
  for (const flag of ["BUG_REPORT_PUBLIC_WRITES_ENABLED", "TRADE_OFFERS_PUBLIC_WRITES_ENABLED"]) {
    const uses = src.split("\n").filter((l) => l.includes(flag) && !l.trim().startsWith("//"));
    t.equal(uses.length, 1, `${flag} is read in exactly one place`);
    t.doesNotMatch(uses[0], /trim|safeStr|toLowerCase|Number\(|parseInt|\|\|/, `${flag} is never normalized`);
  }
  const toml = fs.readFileSync(new URL("../worker/wrangler.toml", import.meta.url), "utf8");
  const varsAt = toml.indexOf("\n[vars]"); const nextTable = toml.indexOf("\n[", varsAt + 2);
  const vars = toml.slice(varsAt, nextTable < 0 ? undefined : nextTable);
  for (const flag of ["BUG_REPORT_PUBLIC_WRITES_ENABLED", "TRADE_OFFERS_PUBLIC_WRITES_ENABLED"]) {
    t.equal([...toml.matchAll(new RegExp(`^${flag}\\s*=`, "gm"))].length, 1, `${flag} is set exactly once in wrangler.toml`);
    t.match(vars, new RegExp(`^${flag} = "0"$`, "m"), `${flag} defaults to "0" in [vars]`);
  }
});

test("PAUSED + the widget: it shows the actual Discord outcome (sent / failed) from the worker's real answers", async () => {
  const okWorld = pausedWorld(undefined); let okReply;
  try { const r = await callWorker(okWorld.env, "POST", `/bug-report?${Q}`, { body: withShot() }); okReply = { status: r.status, json: r.json }; } finally { okWorld.gh.done(); okWorld.mfl.restore(); }
  const badWorld = pausedWorld(undefined, { fail: true }); let badReply;
  try { const r = await callWorker(badWorld.env, "POST", `/bug-report?${Q}`, { body: withShot() }); badReply = { status: r.status, json: r.json }; } finally { badWorld.gh.done(); badWorld.mfl.restore(); }

  const good = widget({ admin: false, reply: okReply }); await good.fns.performBugReportSubmit("submit");
  const g = good.statuses[good.statuses.length - 1];
  t.match(g.msg, /^Submitted \(BUG-2026-[A-Z0-9]+\)\. Discord sent \| Screenshots 1\/1\.$/); t.equal(g.tone, "ok");
  t.equal(good.resets(), 1, "success clears the form");

  const bad = widget({ admin: false, reply: badReply }); await bad.fns.performBugReportSubmit("submit");
  const b = bad.statuses[bad.statuses.length - 1];
  t.match(b.msg, /^Discord failed: /); t.equal(b.tone, "error"); t.doesNotMatch(b.msg, /Submitted/);
  t.equal(bad.resets(), 0, "a failure keeps the form so the owner can try again");
});

test("PAUSE: what the pause changes for ids, sequence and retries (nothing depends on the public file except the stored sequence number)", () => {
  const src = fs.readFileSync(new URL("../worker/src/index.js", import.meta.url), "utf8");
  const at = src.indexOf("const bugId = `BUG-${safeStr(season)}-${Date.now()");
  t.ok(at > 0, "the report id is built from the season and the clock, before any file is read");
  const name = src.slice(src.indexOf("const buildBugThreadName"), src.indexOf("const decodeDataUrlAttachment"));
  t.ok(!/issue_sequence/.test(name), "the Discord thread name has no sequence number");
  const post = src.slice(src.indexOf('if (path === "/bug-report" && request.method === "POST")'), src.indexOf('if (path === "/bug-reports" && request.method === "GET")'));
  t.ok(!/attempts|retry/i.test(post), "the report route has no retry loop that waits on the file");
});

// ───────────── what the scrubber does and does not do ─────────────
test("SCRUBBER LIMITS (documented, not guarantees): unknown secrets in free text, file names, other fields and unlisted URL parameters pass through", () => {
  const row = withoutAccountIds({
    details: "I pasted SYNTHETIC-UNKNOWN-TOKEN-1 by accident", steps_to_reproduce: "", expected_vs_actual: "",
    franchise_name: "Team SYNTHETIC-UNKNOWN-TOKEN-2", submitted_by_label: "Team | note SYNTHETIC-UNKNOWN-TOKEN-3",
    context: { custom_field: "SYNTHETIC-UNKNOWN-TOKEN-4", page_url: "https://e.test/p?L=1&odd_name=SYNTHETIC-UNKNOWN-TOKEN-5" },
    attachments: [{ name: "SYNTHETIC-UNKNOWN-TOKEN-6.png", type: "image/png", size_bytes: 4, data_url: PNG }],
  }, [ID_A]);
  const stored = JSON.stringify(storableBugRow(row));
  for (let i = 1; i <= 6; i++) t.ok(stored.includes(`SYNTHETIC-UNKNOWN-TOKEN-${i}`), `unknown value ${i} is NOT removed`);
});

test("SCRUBBER: URL parameters by NAME (login token, worker key, token, password) are removed from the page context, query and hash", () => {
  const url = `https://e.test/p?L=74598&APIKEY=SYNTHETIC-KEY-1&apiKey=SYNTHETIC-KEY-2&token=SYNTHETIC-KEY-3&MFLUSERID=SYNTHETIC-KEY-4&YEAR=2026#view=a&access_token=SYNTHETIC-KEY-5`;
  const row = withoutAccountIds({ context: { page_url: url, referrer: url } }, []);
  const text = JSON.stringify(row);
  t.ok(!text.includes("SYNTHETIC-KEY"), "no key-named parameter survives");
  t.ok(/L=74598/.test(row.context.page_url) && /YEAR=2026/.test(row.context.page_url) && /view=a/.test(row.context.page_url), "ordinary parameters stay");
});

// ───────────── day-one message and the counter path ─────────────
function dmWorld() {
  const env = makeWorkerEnv({ TRADE_DM_ENABLED: "1", TRADE_OFFERS_PUBLIC_WRITES_ENABLED: "1" }); env.GITHUB_PAT = "test-pat";
  applyMigrations(env.UPS_MFL_DB, ["0076_trade_offer_dm.sql"]);
  env.UPS_MFL_DB.raw.exec("INSERT INTO discord_owners (franchise_id, active_owner, discord_user_id) VALUES ('0002','Y','2000000000000000001'),('0001','Y','1000000000000000001')");
  const mfl = makeMfl(); mfl.install();
  const gh = withGithub({});
  return { env, mfl, gh };
}
const dmTexts = (mfl, uid) => mfl.st.discord.filter((d) => new RegExp(`/channels/dm-${uid}/messages$`).test(d.url)).map((d) => (d.body && d.body.content) || "");

test("DAY-ONE MESSAGE: the recipient's message keeps the owner's note while the committed offers row blanks it", async () => {
  const { env, mfl, gh } = dmWorld();
  try {
    const r = await callWorker(env, "POST", `/api/trades/proposals?${Q}&MFL_USER_ID=tok-B`, { body: { league_id: "74598", season: "2026", from_franchise_id: "0001", to_franchise_id: "0002",
      message: "SYNTHETIC-NOTE-DAY1", comment: "SYNTHETIC-NOTE-DAY1", payload: offerPayload("0001", "0002", [14056], [13100], "SYNTHETIC-NOTE-DAY1") } });
    t.ok(r.status < 300, `${r.status} ${r.text.slice(0, 200)}`);
    const dms = dmTexts(mfl, "2000000000000000001");
    t.ok(dms.length >= 1, "the recipient got the day-one message");
    t.ok(dms.some((c) => c.includes("SYNTHETIC-NOTE-DAY1")), "and it includes the owner's note");
    const committed = gh.puts.filter((p) => /trade_offers_74598_2026\.json$/.test(p.path)).pop();
    t.ok(committed && !committed.text.includes("SYNTHETIC-NOTE-DAY1"), "while the public file does not");
  } finally { gh.done(); mfl.restore(); }
});

test("COUNTER: the countered-back message keeps the note; the committed row for the new offer is blank; the original row is not rewritten with text", async () => {
  const { env, mfl, gh } = dmWorld();
  try {
    const first = await callWorker(env, "POST", `/api/trades/proposals?${Q}&MFL_USER_ID=tok-B`, { body: { league_id: "74598", season: "2026", from_franchise_id: "0001", to_franchise_id: "0002",
      message: "SYNTHETIC-NOTE-FIRST", payload: offerPayload("0001", "0002", [14056], [13100], "SYNTHETIC-NOTE-FIRST") } });
    t.ok(first.status < 300, first.text.slice(0, 200));
    const tid = mfl.st.pending[mfl.st.pending.length - 1].trade_id;
    const c = await callWorker(env, "POST", `/api/trades/proposals/action?${Q}&MFL_USER_ID=tok-C`, { body: { action: "COUNTER", trade_id: tid, league_id: "74598", season: "2026", franchise_id: "0002", acting_franchise_id: "0002",
      counter_offer: { from_franchise_id: "0002", to_franchise_id: "0001", message: "SYNTHETIC-NOTE-COUNTER", payload: offerPayload("0002", "0001", [13100], [14056], "SYNTHETIC-NOTE-COUNTER") } } });
    t.equal(c.status, 200, c.text.slice(0, 240));
    const dms = dmTexts(mfl, "1000000000000000001");
    t.ok(dms.some((x) => x.includes("SYNTHETIC-NOTE-COUNTER")), "the original offerer's message keeps the counter's note");
    for (const p of gh.puts.filter((x) => /trade_offers_74598_2026\.json$/.test(x.path))) {
      t.ok(!p.text.includes("SYNTHETIC-NOTE-"), "no commit of the offers file contains a typed note");
    }
  } finally { gh.done(); mfl.restore(); }
});

// ───────────── TEMPORARY PAUSE on public offers publishing ─────────────
const OFFERS_FILE = "site/trades/trade_offers_74598_2026.json";
const OLD_NOTE = "SYNTHETIC-OLD-NOTE";
const oldOffersDoc = () => ({ meta: { schema_version: 1, league_id: "74598", season: 2026, row_count: 1 }, offers: [{
  id: "TWB-old-row", league_id: "74598", season: 2026, status: "ACCEPTED", from_franchise_id: "0003", to_franchise_id: "0004",
  message: OLD_NOTE, comment: OLD_NOTE, comments: OLD_NOTE, raw_comment: OLD_NOTE, payload: { comment: OLD_NOTE } }] });
const LIVE_14056 = () => [{ id: "14056", salary: "5000", contractYear: "1", contractStatus: "Vet-FAA", contractInfo: "CL 1|TCV 5K|AAV 5K|Y1-5K" }];
const EXT2 = () => [{ player_id: "14056", player_name: "P14056", from_franchise_id: "0001", to_franchise_id: "0002", extension_term: "2YR", option_key: "2YR|NONE", loaded_indicator: "NONE",
  new_contract_status: "EXT2", new_TCV: 55000, new_aav_future: 25000, new_contract_length: 3, preview_contract_info_string: "CL 3| TCV 55K| AAV 5K, 25K| Y1-5K, Y2-25K, Y3-25K" }];
const CANON_INFO = "CL 3|TCV 55K|AAV 5K, 25K|Y1-5K, Y2-25K, Y3-25K|Ext: L.A.|GTD: 41.3K";
const EXPECTED_XML = `<salaries><leagueUnit unit="LEAGUE"><player id="14056" salary="5000" contractYear="3" contractInfo="${CANON_INFO}" contractStatus="Vet-Ext2" /></leagueUnit></salaries>`;
const RECIPIENT_DM = "2000000000000000001", OFFERER_DM = "1000000000000000001";

function offersWorld(flag) {
  const over = { TRADE_DM_ENABLED: "1" }; if (flag !== undefined) over.TRADE_OFFERS_PUBLIC_WRITES_ENABLED = flag;
  const env = makeWorkerEnv(over); env.GITHUB_PAT = "test-pat";
  applyMigrations(env.UPS_MFL_DB, ["0076_trade_offer_dm.sql", "0102_trade_sentinel.sql"]);
  env.UPS_MFL_DB.raw.exec(`INSERT INTO discord_owners (franchise_id, active_owner, discord_user_id) VALUES ('0002','Y','${RECIPIENT_DM}'),('0001','Y','${OFFERER_DM}')`);
  const mfl = makeMfl(); mfl.install();
  mfl.st.salaries = LIVE_14056();
  mfl.st.rosters["0002"] = [{ id: "13100", salary: 5000, contractStatus: "Vet-FAA", contractYear: "1", contractInfo: "CL 1|TCV 5K|AAV 5K|Y1-5K" }];
  const seed = { [OFFERS_FILE]: oldOffersDoc() };
  const gh = withGithub(seed);
  return { env, mfl, gh, seed };
}
async function proposeOffer(w, note, ext) {
  const payload = offerPayload("0001", "0002", [14056], [13100], note); payload.extension_requests = ext || [];
  const r = await callWorker(w.env, "POST", `/api/trades/proposals?${Q}&MFL_USER_ID=tok-B`, { body: { league_id: "74598", season: "2026", from_franchise_id: "0001", to_franchise_id: "0002", message: note, comment: note, payload } });
  t.ok(r.status < 300, `propose ${r.status} ${r.text.slice(0, 160)}`);
  return { r, tradeId: w.mfl.st.pending[w.mfl.st.pending.length - 1].trade_id };
}
const act2 = (w, body, tok) => callWorker(w.env, "POST", `/api/trades/proposals/action?${Q}&MFL_USER_ID=${tok || "tok-C"}`, { body });
const outboxRows = (env) => env.UPS_MFL_DB.raw.prepare("SELECT action_type, payload_xml_extensions FROM twb_trade_outbox ORDER BY rowid").all();

test("OFFERS PAUSED: a proposal still reaches MFL and the outbox, the recipient's message keeps the note and the extension, and NOTHING public is written", async () => {
  const w = offersWorld(undefined);
  try {
    const { r, tradeId } = await proposeOffer(w, "SYNTHETIC-NOTE-PAUSED", EXT2());
    t.equal(w.mfl.writes("tradeProposal").length, 1, "MFL received the proposal"); t.ok(w.mfl.st.pending.some((p) => p.trade_id === tradeId));
    t.equal(r.json.storage_sync.paused, true, "the response says publishing is paused");
    const sub = outboxRows(w.env).find((x) => x.action_type === "SUBMIT");
    t.ok(sub && sub.payload_xml_extensions === EXPECTED_XML, "the outbox row holds the offer and its extension contract");
    const dm = dmTexts(w.mfl, RECIPIENT_DM);
    t.ok(dm.some((c) => c.includes("SYNTHETIC-NOTE-PAUSED")), "the day-one message includes the owner's note");
    t.ok(dm.some((c) => /Pre-trade extension/.test(c)), "and the pre-trade extension");
    t.equal(w.gh.puts.length, 0, "zero public offers-file PUTs"); t.equal(w.gh.writes.length, 0, "zero GitHub writes of any kind");
    t.deepEqual(w.seed[OFFERS_FILE], oldOffersDoc(), "the seeded file, old note included, is exactly as it was");
  } finally { w.gh.done(); w.mfl.restore(); }
});

test("OFFERS PAUSED: a counter reaches MFL (original rejected, new offer sent), its message keeps the note, nothing public is written", async () => {
  const w = offersWorld(undefined);
  try {
    const { tradeId } = await proposeOffer(w, "SYNTHETIC-NOTE-FIRST", []);
    const c = await act2(w, { action: "COUNTER", trade_id: tradeId, league_id: "74598", season: "2026", franchise_id: "0002", acting_franchise_id: "0002",
      counter_offer: { from_franchise_id: "0002", to_franchise_id: "0001", message: "SYNTHETIC-NOTE-COUNTER", payload: offerPayload("0002", "0001", [13100], [14056], "SYNTHETIC-NOTE-COUNTER") } });
    t.equal(c.status, 200, c.text.slice(0, 240));
    t.ok(w.mfl.st.done.some((d) => d.trade_id === tradeId), "MFL recorded a response to the original offer");
    t.ok(w.mfl.st.pending.some((p) => p.offeringteam === "0002" && p.offeredto === "0001"), "MFL holds the new counter offer");
    t.ok(dmTexts(w.mfl, OFFERER_DM).some((x) => x.includes("SYNTHETIC-NOTE-COUNTER")), "the original offerer's message includes the counter's note");
    t.equal(w.gh.puts.length, 0); t.equal(w.gh.writes.filter((x) => /trade_offers/.test(x.path)).length, 0);
    t.deepEqual(w.seed[OFFERS_FILE], oldOffersDoc());
  } finally { w.gh.done(); w.mfl.restore(); }
});

test("OFFERS PAUSED: accept applies the stored extension exactly as before (from the outbox); decline answers MFL; neither writes the public file", async () => {
  const w = offersWorld(undefined);
  try {
    const { tradeId } = await proposeOffer(w, "SYNTHETIC-NOTE-ACCEPT", EXT2());
    const a = await act2(w, { action: "ACCEPT", trade_id: tradeId, league_id: "74598", franchise_id: "0002", year: "2026", message: "" });
    t.equal(a.status, 200, a.text.slice(0, 300)); t.equal(a.json.ok, true); t.equal(a.json.extensions.ok, true);
    t.ok(w.mfl.st.done.some((d) => d.trade_id === tradeId && d.response === "accept"), "MFL accepted the trade");
    t.equal(w.mfl.writes("salaries")[0].fields.DATA, EXPECTED_XML, "the extension contract imported is byte-for-byte the stored one");
    t.equal(w.gh.puts.length, 0, "accept wrote no public file");
  } finally { w.gh.done(); w.mfl.restore(); }
  const d = offersWorld(undefined);
  try {
    const { tradeId } = await proposeOffer(d, "SYNTHETIC-NOTE-DECLINE", EXT2());
    const x = await act2(d, { action: "REJECT", trade_id: tradeId, league_id: "74598", franchise_id: "0002", year: "2026", message: "no thanks" });
    t.equal(x.status, 200, x.text.slice(0, 240));
    t.ok(d.mfl.st.done.some((e) => e.trade_id === tradeId && e.response === "reject"), "MFL recorded the decline");
    t.equal(d.mfl.writes("salaries").length, 0, "a decline applies no extension");
    t.equal(d.gh.puts.length, 0, "decline wrote no public file");
  } finally { d.gh.done(); d.mfl.restore(); }
});

test("OFFERS PAUSED: what the recipient's inbox shows for an offer made during the pause, against the same offer when publishing is on", async () => {
  const get = (w) => callWorker(w.env, "GET", `/api/trades/proposals?${Q}&FRANCHISE_ID=0002&include_payload=1&MFL_USER_ID=tok-C`);
  const paused = offersWorld(undefined); let p;
  try { await proposeOffer(paused, "SYNTHETIC-NOTE-INBOX", EXT2()); const r = await get(paused); t.equal(r.status, 200, r.text.slice(0, 200)); p = r.json.incoming[0]; } finally { paused.gh.done(); paused.mfl.restore(); }
  const live = offersWorld("1"); let l;
  try { await proposeOffer(live, "SYNTHETIC-NOTE-INBOX", EXT2()); const r = await get(live); t.equal(r.status, 200, r.text.slice(0, 200)); l = r.json.incoming[0]; } finally { live.gh.done(); live.mfl.restore(); }
  t.ok(p && l, "the offer is in the recipient's inbox either way (the list comes from MFL)");
  t.equal(p.from_franchise_id, "0001"); t.equal(p.to_franchise_id, "0002"); t.equal(p.will_give_up, l.will_give_up); t.equal(p.will_receive, l.will_receive);
  t.equal(p.message, l.message, "the note shown is the same (it comes from MFL's own record)");
  t.ok(p.message.includes("SYNTHETIC-NOTE-INBOX"));
  t.ok(l.payload && l.payload.extension_requests.length === 1, "published: the card can list the pre-trade extension");
  t.equal(p.payload, undefined, "paused: no stored payload, so the card lists NO extension");
  t.equal(p.summary, null); t.ok(l.summary && typeof l.summary === "object", "paused: no stored summary");
  t.equal(p.source, "mfl_pendingTrades");
});

test("OFFERS PAUSED: reminders follow the mirror; only if the mirror is stale does the file decide, and then a paused offer is wrongly treated as gone", async () => {
  const RealDate = Date, FIXED = RealDate.parse("2026-11-17T15:00:00Z");   // 10:00 ET: outside quiet hours
  class FixedDate extends RealDate { constructor(...a) { if (a.length === 0) super(FIXED); else super(...a); } static now() { return FIXED; } }
  const run1 = async (withMirror) => {
    const w = offersWorld(undefined); bindSelf(w.env);
    try {
      const { tradeId } = await proposeOffer(w, "SYNTHETIC-NOTE-REMIND", []);
      const row = () => w.env.UPS_MFL_DB.raw.prepare("SELECT state, resolved_reason FROM trade_offer_dm WHERE trade_id = ?").get(tradeId);
      t.equal(row().state, "active", "a reminder row exists for the paused offer");
      if (withMirror) w.env.UPS_MFL_DB.raw.exec(`INSERT INTO ups_trade_offer_watch (trade_id, league_id, season, from_franchise_id, to_franchise_id, first_seen_utc, last_seen_utc, origin, lifecycle, anchor_utc)
        VALUES ('${tradeId}','74598','2026','0001','0002',datetime('now'),datetime('now'),'inapp','pending',datetime('now'))`);
      globalThis.Date = FixedDate;
      try { await processTradeOfferReminders(w.env); } finally { globalThis.Date = RealDate; }
      return row();
    } finally { w.gh.done(); w.mfl.restore(); }
  };
  const fresh = await run1(true);  t.equal(fresh.state, "active", "mirror fresh: the reminder row stays active");
  const stale = await run1(false); t.equal(stale.state, "resolved"); t.equal(stale.resolved_reason, "not_pending", "mirror stale: the file is the fallback, the paused offer is absent from it, so reminders end early");
});

test("OFFERS RESUMED: publishing resumes for new offers only; an offer made during the pause never gets a row; the old note is untouched by this change", async () => {
  const w = offersWorld("0");
  try {
    const first = await proposeOffer(w, "SYNTHETIC-NOTE-DURING", []);
    t.equal(w.gh.puts.length, 0);
    w.env.TRADE_OFFERS_PUBLIC_WRITES_ENABLED = "1";
    const payload2 = offerPayload("0003", "0008", [15000], [16614], "SYNTHETIC-NOTE-AFTER");
    const r2 = await callWorker(w.env, "POST", `/api/trades/proposals?${Q}&MFL_USER_ID=tok-O`, { body: { league_id: "74598", season: "2026", from_franchise_id: "0003", to_franchise_id: "0008", message: "SYNTHETIC-NOTE-AFTER", payload: payload2 } });
    t.ok(r2.status < 300, `${r2.status} ${r2.text.slice(0, 200)}`);
    t.equal(w.gh.puts.length, 1, "after resuming, the next offer publishes");
    const doc = JSON.parse(w.gh.puts[0].text);
    t.ok(!w.gh.puts[0].text.includes("SYNTHETIC-NOTE-"), "its note is blank in the commit");
    t.ok(w.gh.puts[0].text.includes(OLD_NOTE), "the old note is re-committed as it was (this change does not edit existing rows)");
    t.ok(!doc.offers.some((o) => String(o.mfl_trade_id || o.trade_id) === String(first.tradeId)), "the offer made during the pause has no row");
    t.equal(doc.offers.filter((o) => o.id !== "TWB-old-row").length, 1);
  } finally { w.gh.done(); w.mfl.restore(); }
});

test("OFFERS PAUSE IS FAIL-CLOSED: only the exact string 1 publishes; unset, 0, empty, true, yes, on, 2, padded \" 1 \", \"1\\n\", \"01\", a full-width 1, the number 1 and true all stay paused", async () => {
  for (const flag of [undefined, "0", "", "true", "yes", "on", "2", " ", " 1 ", "1 ", " 1", "\t1", "1\n", "01", "1.0", "\uFF11", 1, true]) {
    const w = offersWorld(flag);
    try { await proposeOffer(w, "SYNTHETIC-NOTE-FLAG", []); t.equal(w.gh.puts.length, 0, `flag ${JSON.stringify(flag)} stays paused`); } finally { w.gh.done(); w.mfl.restore(); }
  }
  const w = offersWorld("1");
  try { await proposeOffer(w, "SYNTHETIC-NOTE-FLAG", []); t.equal(w.gh.puts.length, 1, "exactly 1 publishes"); t.ok(!w.gh.puts[0].text.includes("SYNTHETIC-NOTE-FLAG")); } finally { w.gh.done(); w.mfl.restore(); }
  const src = fs.readFileSync(new URL("../worker/src/index.js", import.meta.url), "utf8");
  const at = src.indexOf("const writeTradeOffersDoc = async");
  t.match(src.slice(at, at + 420), /if \(!tradeOffersPublicWritesEnabled\(\)\) \{\s*return \{ ok: false, paused: true/, "the writer checks the pause before anything else");
  const sync = src.slice(src.indexOf("const syncDirectMflOfferToStorage = async"), src.indexOf("const buildTradeAdjustmentRef"));
  t.ok(sync.indexOf("tradeOffersPublicWritesEnabled()") < sync.indexOf("readTradeOffersDoc("), "the sync takes the paused branch before it reads the public file");
  t.ok(sync.indexOf("tradeOffersPublicWritesEnabled()") < sync.indexOf("githubPat"), "and before it needs the GitHub secret");
});

test("ACCEPT / LEGACY: the accept path writes no offers file; the only other writer sits after an unconditional return (source evidence)", () => {
  const src = fs.readFileSync(new URL("../worker/src/index.js", import.meta.url), "utf8");
  const callers = [...src.matchAll(/await (syncDirectMflOfferToStorage|writeTradeOffersDoc)\(/g)].map((m) => m[1]);
  t.deepEqual(callers, ["writeTradeOffersDoc", "syncDirectMflOfferToStorage", "syncDirectMflOfferToStorage", "writeTradeOffersDoc"], "exactly four call sites: the sync's own write, propose, counter, and the legacy tail");
  const start = src.indexOf('if ((path === "/trade-offers/action" || path === "/api/trades/proposals/action")');
  const block = src.slice(start, src.indexOf("if (directMfl) {", start));
  t.match(block, /const directMfl = true;/, "directMfl is a constant true");
  const legacyAt = src.indexOf("if (!offerId) return jsonOut(400, { ok: false, error: \"offer_id is required\" });", start);
  const directBlock = src.slice(src.indexOf("if (directMfl) {", start), legacyAt);
  t.ok(/\n          return jsonOut\(200, \{\n            ok: true,\n            mode: "direct_mfl",/.test(directBlock), "the direct block ends in an unconditional return, so the legacy tail (the second writer) cannot run");
});

await run("public data hygiene");
restore();
