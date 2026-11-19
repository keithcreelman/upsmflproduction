// Report bug, test-only integration (#1473): the REAL site/m/app.js and the REAL site/m/report_bug.js on a fake phone
// (node:vm, one global like a browser, fake DOM), a stub worker, and the REAL bug-report handler + in-memory store behind it.
// Nothing leaves the process; any request to a host other than the stub is recorded as `stray` and fails the test.
//   node tests/report_bug_integration.test.mjs
//   node tests/report_bug_integration.test.mjs --record <path-to-pre-change-app.js>     (re-record the no-script golden)
//
// What this proves, in the order a reviewer would ask:
//   1  no script        -> the app is byte-for-byte what it was (golden recorded from the pre-change app.js)
//   2  healthy phone    -> no failure recorded, no chip, on every route (no false alarms)
//   3  every failure    -> every failed request the app makes, on every route, in every failure mode, shows the chip
//                          on the route where it STARTED and sends the right context (including the silent catches)
//   4  navigation race  -> a request started on A that fails after the owner is on B: no chip on B, still reportable
//                          from More with route A and the original error context
//   5  More fallback, render errors, error toasts, the expected-exception ledger
//   6  no leak, no loop, transparent, safe when the sheet misbehaves
//   7  mutation checks  -> cut each mechanism out and the matching check must FAIL
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { t, test, run } from "./fixtures/mini_test.mjs";
import { makePhone, makeWorker, read, settle, ROOT, WORKER_ORIGIN, PAGES_ORIGIN, TOP_ROUTES } from "./fixtures/phone_vm.mjs";

const RB = createRequire(import.meta.url)("../site/m/report_bug.js");
const APP = read("site/m/app.js");
const SCRIPT = read("site/m/report_bug.js");
const SIGNED_IN = { ups_mfl_user_id: "tokA" };
const GOLDEN_PATH = path.join(ROOT, "tests", "fixtures", "report_bug_noscript_golden.json");
const ROUTES = ["#home", "#myteam/lineup", "#myteam/contracts", "#league/rosters", "#players", "#stats", "#market", "#events", "#scores", "#more"];

const boot = async (extra) => makePhone({ script: true, stored: SIGNED_IN, hash: "#home", ...(extra || {}) });
async function lazy(p) {   // the lazy reads a screen asks for (leaderboards, cap penalty, taxi call-ups)
  try { await Promise.all([p.M.data.ensureAdvancedStats(), p.M.data.ensureCapPenaltyPreview(), p.M.data.ensureTaxiCallups()]); } catch (e) { /* a failed read is the point */ }
  await settle();
}
const rowsOf = (p) => p.worker.store._reports;
// Wait for a condition on wall-clock time, not for a fixed number of event-loop turns: the report handler fingerprints the
// report with WebCrypto (SHA-256), which finishes on a thread pool, so a slower machine needs longer than any tick count.
async function waitFor(cond, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (cond()) return true; await new Promise((r) => setTimeout(r, 2)); }
  return !!cond();
}
const sheetDone = (p) => { const h = (p.sheet() && p.sheet().innerHTML) || ""; return /Report sent|Already reported/.test(h) || /class="alert /.test(h); };
const send = async (p, summary) => { p.type("ups-rb-sum", summary || "It broke"); p.press("send"); await waitFor(() => sheetDone(p)); await settle(); };

// ---------------------------------------------------------------- 1. no script: golden
const SCENARIOS = {
  "healthy-home": { opts: { stored: SIGNED_IN, hash: "#home" }, steps: [(p) => p.go("#more"), (p) => p.go("#myteam/lineup")] },
  "signed-out": { opts: { hash: "#home" }, steps: [(p) => p.go("#more")] },
  "rosters-500": { opts: { stored: SIGNED_IN, hash: "#home", rules: [{ path: "/api/mfl-export", type: "rosters", mode: "500" }] }, steps: [(p) => p.go("#more")] },
  "season-500": { opts: { stored: SIGNED_IN, hash: "#home", rules: [{ path: "/api/active-season", mode: "500" }] }, steps: [] },
  "proposals-500": { opts: { stored: SIGNED_IN, hash: "#home", rules: [{ path: "/api/trades/proposals", mode: "500" }] }, steps: [(p) => p.go("#more")] },
  "proposals-401-expected": { opts: { stored: SIGNED_IN, hash: "#home", rules: [{ path: "/api/trades/proposals", mode: "401" }] }, steps: [] },
  "network-all": { opts: { stored: SIGNED_IN, hash: "#home", rules: [{ mode: "network" }] }, steps: [] },
  "pages-json-404": { opts: { stored: SIGNED_IN, hash: "#home", rules: [{ path: "/upsmflproduction/ccc/tag_tracking.json", mode: "404" }] }, steps: [] },
  "render-error": { opts: { stored: SIGNED_IN, hash: "#home", viewThrows: "home" }, steps: [] },
  "err-toast": { opts: { stored: SIGNED_IN, hash: "#home" }, steps: [(p) => p.M.ui.showToast("Pick failed: nope", "err"), (p) => p.M.ui.showToast("Saved", "ok"), (p) => p.M.ui.showToast("Working", "info")] },
};
// The More page prints the app's build number. The build was bumped for this change (the stamp check requires it), so the
// build string is the ONE thing normalized out of a snapshot; everything else must match the pre-change app exactly.
const buildOf = (src) => /var BUILD = "([^"]+)"/.exec(src)[1];
function snap(p, build) {
  const norm = (x) => (build ? String(x).split(build).join("<BUILD>") : String(x));
  return {
    requests: p.calls.map((c) => [c.method, c.host.replace(/^https:\/\//, ""), c.path, c.query]),
    main: norm(p.main()), toasts: p.toasts.map(norm), loadErrors: p.loadErrors().map(norm), seen: p.seen.slice(),
  };
}
async function runScenario(name, makeOpts) {
  const sc = SCENARIOS[name];
  const p = await makePhone({ ...sc.opts, ...(makeOpts || {}) });
  const build = buildOf((makeOpts && makeOpts.appSrc) || APP);
  const out = [snap(p, build)];
  for (const step of sc.steps) { await step(p); await settle(); out.push(snap(p, build)); }
  return { p, snaps: out, build };
}

if (process.argv.includes("--record")) {
  const baseApp = fs.readFileSync(path.resolve(process.argv[process.argv.indexOf("--record") + 1]), "utf8");
  const golden = { recorded_from_sha256: crypto.createHash("sha256").update(baseApp).digest("hex"), scenarios: {} };
  golden.build_normalized_to = "<BUILD>";
  for (const name of Object.keys(SCENARIOS)) golden.scenarios[name] = (await runScenario(name, { appSrc: baseApp })).snaps;
  fs.writeFileSync(GOLDEN_PATH, JSON.stringify(golden, null, 1) + "\n");
  console.log("recorded", Object.keys(SCENARIOS).length, "scenarios from", golden.recorded_from_sha256.slice(0, 12));
  process.exit(0);
}
const GOLDEN = JSON.parse(fs.readFileSync(GOLDEN_PATH, "utf8"));

const REPORT_ROW = /<button class="ups-m-desktop-link" id="ups-m-report-bug"[^>]*>Report a problem<\/button>/;
const sameApart = (a, b, ignoreRow) => JSON.stringify(a.map((s) => ({ ...s, main: ignoreRow ? s.main.replace(REPORT_ROW, "") : s.main }))) === JSON.stringify(b);

test("NO SCRIPT: every scenario is identical to the golden recorded from the pre-change app.js (requests, pages, toasts, load errors)", async () => {
  t.equal(Object.keys(GOLDEN.scenarios).sort().join(), Object.keys(SCENARIOS).sort().join(), "the golden covers every scenario");
  for (const name of Object.keys(SCENARIOS)) {
    const { p, snaps } = await runScenario(name);
    t.equal(JSON.stringify(snaps), JSON.stringify(GOLDEN.scenarios[name]), "identical to the pre-change app: " + name);
    t.equal(typeof p.win.UPSReportBug, "undefined", name + ": no sheet global");
    t.ok(p.win.fetch === p.win.__origFetch, name + ": window.fetch untouched");
    t.equal(p.dom.document.body._kids.filter((k) => k.className === "ups-rb-chip").length, 0, name + ": no chip");
    t.equal(p.stray.length, 0, name + ": no stray network");
  }
  t.match(GOLDEN.recorded_from_sha256, /^[0-9a-f]{64}$/);
});

test("SCRIPT PRESENT: the app still makes the same requests and shows the same pages, toasts and load errors (the observer adds nothing)", async () => {
  for (const name of Object.keys(SCENARIOS)) {
    const { p, snaps } = await runScenario(name, { script: true });
    t.ok(sameApart(snaps, GOLDEN.scenarios[name], true), "same as the pre-change app apart from the More row: " + name);
    t.equal(p.stray.length, 0, name + ": no stray network");
  }
});

// ---------------------------------------------------------------- 2. healthy
test("HEALTHY PHONE: on every route, signed in and signed out, no failure is recorded and no chip is shown", async () => {
  for (const h of ROUTES) {
    const p = await boot({ hash: h }); await lazy(p);
    t.equal(p.R().failures().length, 0, h + ": no failures. " + JSON.stringify(p.R().failures()));
    t.equal(p.chip(), null, h + ": no chip");
    t.equal(p.stray.length, 0);
  }
  const out = await makePhone({ script: true, hash: "#home" });
  t.equal(out.R().failures().length, 0, "signed out: none");
  t.equal(out.chip(), null);
});

// ---------------------------------------------------------------- 3. every failure, every route
const keyOf = (c) => ({ origin: c.host, path: c.path, type: new URLSearchParams(c.query).get("TYPE") || "", method: c.method });
const MODES = [
  { mode: "500", status: 500 }, { mode: "403", status: 403 }, { mode: "network", status: null }, { mode: "abort", status: null },
];
const label = (h) => RB.screenFor(h);

test("EVERY REQUEST, EVERY ROUTE, EVERY FAILURE MODE: the chip shows on the route where it started and the report carries the right context", async () => {
  const table = [];          // route x endpoint x "app shows its own failure UI?" x chip
  let combos = 0, exempt = 0, silent = 0, shown = 0;
  for (const h of ROUTES) {
    const clean = await boot({ hash: h }); await lazy(clean);
    const baseMain = clean.main();
    const keys = new Map();
    for (const c of clean.calls) { const k = keyOf(c); keys.set([k.method, k.origin, k.path, k.type].join(" "), k); }
    t.ok(keys.size >= 15, h + ": the app makes its requests (" + keys.size + " distinct)");
    for (const k of keys.values()) {
      const endpoint = RB.cleanEndpoint(k.path);
      for (const m of MODES) {
        const p = await boot({ hash: h, rules: [{ path: k.path, type: k.type || undefined, method: k.method, mode: m.mode }] }); await lazy(p);
        const who = h + " " + k.method + " " + k.path + (k.type ? "?TYPE=" + k.type : "") + " " + m.mode;
        combos++;
        const mine = p.R().failures().filter((f) => f.endpoint === endpoint);
        if (m.status != null && RB.isExpected(endpoint, m.status)) {   // a ledgered exception: handled by the app as a normal state
          exempt++;
          t.equal(mine.length, 0, who + ": ledgered, so not a failure");
          t.equal(p.chip(), null, who + ": no chip");
          continue;
        }
        t.ok(mine.length >= 1, who + ": recorded");
        const f = mine[0];
        t.equal(f.screen, label(h), who + ": attributed to the route it started on");
        t.equal(f.status, m.status, who + ": status");
        t.ok(p.chip() && p.R().chipFailure().screen === label(h), who + ": chip on " + label(h));
        // open the sheet from the chip and SEND: what the commissioner stores is exactly this failure's context
        p.tapChip("go");
        t.ok(p.sheet(), who + ": sheet opened");
        await send(p, "Matrix " + combos);
        const row = rowsOf(p)[0];
        t.ok(row, who + ": report stored");
        t.equal(row.screen, label(h), who + ": stored screen");
        t.equal(row.err_endpoint, endpoint, who + ": stored endpoint (path only)");
        t.equal(row.err_status, m.status, who + ": stored status");
        t.ok(row.err_message.length > 0 && row.err_name.length > 0, who + ": stored error name/message");
        t.equal(p.stray.length, 0, who + ": no stray network");
        const uiShown = p.main() !== baseMain || p.loadErrors().length > 0 || p.toasts.length > 0;
        if (m.mode === "500") { table.push([h, k.path + (k.type ? "?TYPE=" + k.type : ""), uiShown, true]); if (uiShown) shown++; else silent++; }
      }
    }
  }
  console.log("  matrix: " + combos + " route x request x failure-mode combinations (" + exempt + " ledgered exceptions); " +
    "for an HTTP 500, the app's own page-level UI reacts in " + shown + " of " + table.length + " route x request cases and is SILENT in " + silent + ", and the chip shows in all of them");
  t.ok(combos >= 500, "combos: " + combos);
  t.ok(silent > 0, "some failures are silent today (that is why the observer exists): " + silent);
});

// ---------------------------------------------------------------- 4. the navigation race
test("NAVIGATION RACE: a request that starts on route A and fails after the owner is on route B -> no chip on B; reportable from More with route A and the original error; chip back on A", async () => {
  const p = await boot({ hash: "#myteam/lineup" });
  const hold = p.fail({ path: "/api/taxi-callups", mode: "hold" });
  const pending = p.M.data.ensureTaxiCallups();                       // the real app request, started on Lineup
  await settle();
  t.ok((hold.pending || []).length >= 1, "the request is in flight");
  await p.go("#league/rosters");                                      // the owner moves on to Rosters
  p.release(hold, "500");                                             // ... and only now does it fail
  await pending.catch(() => {}); await settle();
  const f = p.R().failures();
  t.equal(f.length, 1, "recorded once: " + JSON.stringify(f));
  t.equal(f[0].screen, "Lineup", "attributed to the route it STARTED on");
  t.equal(f[0].route, "myteam/lineup");
  t.equal(f[0].endpoint, "/api/taxi-callups");
  t.equal(f[0].status, 500);
  t.equal(p.R().chipFailure(), null, "no chip decision for Rosters");
  t.equal(p.chip(), null, "no chip element on Rosters");
  await p.go("#more");
  t.equal(p.chip(), null, "no chip on More either");
  t.ok(p.main().includes("Report a problem"), "More offers Report a problem");
  p.tapMore();
  t.ok(p.sheet(), "the sheet opens from More");
  const pageText = p.sheet().innerHTML;
  t.match(pageText, /Lineup: \/api\/taxi-callups \(HTTP 500\)/, "the failure is the first choice, named by its route, endpoint and status");
  t.match(pageText, /Something else looks wrong/);
  await send(p, "Taxi squad count missing");
  t.equal(rowsOf(p).length, 1);
  t.equal(rowsOf(p)[0].screen, "Lineup", "the report says Lineup, not More or Rosters");
  t.equal(rowsOf(p)[0].err_endpoint, "/api/taxi-callups", "the ORIGINAL request");
  t.equal(rowsOf(p)[0].err_status, 500);
  t.equal(rowsOf(p)[0].err_name, "HTTP");
  // back on A the chip returns
  p.dom.document.body._kids.filter((k) => k.className === "ups-rb-back").forEach((k) => k.remove());
  await p.go("#myteam/lineup");
  t.ok(p.chip(), "the chip is back on Lineup");
  t.equal(p.R().chipFailure().screen, "Lineup");
  t.equal(p.stray.length, 0);
});

test("NAVIGATION RACE (control): a request that starts AND fails on the same route shows the chip there", async () => {
  const p = await boot({ hash: "#myteam/lineup" });
  const hold = p.fail({ path: "/api/taxi-callups", mode: "hold" });
  const pending = p.M.data.ensureTaxiCallups(); await settle();
  p.release(hold, "503"); await pending.catch(() => {}); await settle();
  t.ok(p.chip(), "chip on Lineup");
  t.equal(p.R().chipFailure().status, 503);
});

// ---------------------------------------------------------------- 5. More, render errors, toasts, ledger
test("MORE -> Report a problem: only with the script; with no recorded failure it says so honestly and reports the page the owner came from", async () => {
  const bare = await makePhone({ stored: SIGNED_IN, hash: "#more" });
  t.ok(!bare.main().includes("Report a problem"), "no row without the script");
  t.equal(bare.dom.registry["ups-m-report-bug"], undefined);
  const p = await boot({ hash: "#myteam/contracts" });
  await p.go("#more");
  t.ok(p.main().includes("Report a problem"), "row with the script");
  p.tapMore();
  t.match(p.sheet().innerHTML, /No error message was captured/);
  t.doesNotMatch(p.sheet().innerHTML, /Which problem\?/, "one choice only: no picker");
  await send(p, "The contract list looks wrong");
  const row = rowsOf(p)[0];
  t.equal(row.screen, "Contracts", "the page the owner was on before More");
  t.equal(row.err_name, ""); t.equal(row.err_message, ""); t.equal(row.err_endpoint, "");
});

test("MORE -> Report a problem: several recent failures are offered newest first, and choosing one changes the report", async () => {
  const p = await boot({ hash: "#home" });
  const a = p.fail({ path: "/api/taxi-callups", mode: "500" });
  await p.go("#myteam/lineup"); await p.M.data.ensureTaxiCallups().catch(() => {}); await settle();
  p.clearFaults(); const b = p.fail({ path: "/api/cap-penalty/preview", mode: "network" });
  await p.go("#league/rosters"); await p.M.data.ensureCapPenaltyPreview().catch(() => {}); await settle();
  await p.go("#more"); p.tapMore();
  const html = p.sheet().innerHTML;
  t.match(html, /Which problem\?/);
  const opts = [...html.matchAll(/<option value="(\d)"[^>]*>([^<]+)</g)].map((m) => m[2]);
  t.equal(opts.length, 3, "two failures and 'something else': " + JSON.stringify(opts));
  t.match(opts[0], /^Rosters: \/api\/cap-penalty\/preview/, "newest first");
  t.match(opts[1], /^Lineup: \/api\/taxi-callups \(HTTP 500\)/);
  t.match(opts[2], /^Something else/);
  p.choose(1);
  await send(p, "Pick the older one");
  t.equal(rowsOf(p)[0].screen, "Lineup");
  t.equal(rowsOf(p)[0].err_endpoint, "/api/taxi-callups");
  t.equal(a.mode, "500"); t.equal(b.mode, "network");
});

test("RENDER BOUNDARY: a view that throws shows the same Render error card and the chip, and the report carries the error", async () => {
  const bare = await makePhone({ stored: SIGNED_IN, hash: "#home", viewThrows: "home" });
  const p = await boot({ hash: "#home", viewThrows: "home" });
  t.equal(p.main(), bare.main(), "the card is unchanged by the script");
  t.match(p.main(), /Render error: view exploded/);
  const f = p.R().failures().find((x) => x.name === "TypeError");
  t.ok(f, "recorded: " + JSON.stringify(p.R().failures()));
  t.equal(f.message, "view exploded"); t.equal(f.screen, "Home");
  t.ok(p.chip());
  p.tapChip("go"); await send(p, "Home blew up");
  t.equal(rowsOf(p)[0].err_name, "TypeError"); t.equal(rowsOf(p)[0].err_message, "view exploded"); t.equal(rowsOf(p)[0].screen, "Home");
});

test("ERROR TOASTS: an error toast is recorded with its text and shows the chip; ok, info and warn toasts are not failures", async () => {
  const p = await boot({ hash: "#myteam/lineup" });
  p.M.ui.showToast("Saved", "ok"); p.M.ui.showToast("Working", "info"); p.M.ui.showToast("Careful", "warn");
  t.equal(p.R().failures().length, 0); t.equal(p.chip(), null);
  p.M.ui.showToast("Pick failed: the pick is not on the clock", "err");
  const f = p.R().failures();
  t.equal(f.length, 1); t.equal(f[0].message, "Pick failed: the pick is not on the clock"); t.equal(f[0].screen, "Lineup");
  t.ok(p.chip());
  t.equal(p.toasts.length, 4, "the toasts still show");
});

test("LEDGER: an expected non-failure is neither recorded nor chipped; the same path with another status IS", async () => {
  const ok = await boot({ hash: "#home", rules: [{ path: "/api/trades/proposals", mode: "401" }] });
  t.equal(ok.R().failures().length, 0, "401 on proposals is the signed-out Trades state"); t.equal(ok.chip(), null);
  const bad = await boot({ hash: "#home", rules: [{ path: "/api/trades/proposals", mode: "500" }] });
  t.equal(bad.R().failures().length, 1); t.ok(bad.chip());
});

test("WHEN THE SCRIPT LOADS: it must come BEFORE app.js, or boot-time failures are missed (the preview page's order is pinned here)", async () => {
  const early = await boot({ hash: "#home", rules: [{ path: "/api/trades/proposals", mode: "500" }] });
  const late = await makePhone({ script: "late", stored: SIGNED_IN, hash: "#home", rules: [{ path: "/api/trades/proposals", mode: "500" }] });
  t.equal(early.R().failures().length, 1, "script first: the boot-time failure is seen");
  t.equal(late.R().failures().length, 0, "script after the boot: it missed it (this is why the order matters)");
});

// ---------------------------------------------------------------- 6. leaks, loops, transparency, safety
const SECRET = "sekretvalue99", LONGTOK = "AbCdEf0123456789AbCdEf0123456789XyZ";

test("NO LEAK: tokens and keys in a failing URL, an error message or a path never reach the sheet, the POST, the stored row or the commissioner view", async () => {
  // (a) the app's own request that carries the sign-in in its address
  const a = await boot({ hash: "#home", rules: [{ path: "/api/me", mode: "500" }] });
  t.ok(a.workerCalls().some((c) => c.path === "/api/me" && /MFL_USER_ID=tokA/.test(c.query)), "the app really sent the sign-in in that address");
  t.ok(a.R().failures().some((f) => f.endpoint === "/api/me"), "and its failure was recorded");
  t.ok(!JSON.stringify(a.R().failures()).includes("tokA"), "without the sign-in");
  // (b) a failing request with a key in its query, a token-like path segment, and an error message that repeats both
  const p = await boot({ hash: "#home" });
  p.fail({ path: "/api/x/" + LONGTOK, mode: "network", message: "NetworkError: https://w.example/api/x/" + LONGTOK + "?APIKEY=" + SECRET + " MFL_USER_ID=tokA token=" + SECRET + " Bearer " + SECRET + "abcdef" });
  await p.win.fetch(WORKER_ORIGIN + "/api/x/" + LONGTOK + "?APIKEY=" + SECRET + "&MFL_USER_ID=tokA").catch(() => {});
  await settle();
  const fs_ = p.R().failures();
  t.equal(fs_.length, 1);
  t.equal(fs_[0].endpoint, "/api/x/:id", "token-like segment replaced, query dropped");
  for (const bad of [SECRET, LONGTOK, "tokA", "APIKEY"]) t.ok(!JSON.stringify(fs_).includes(bad), "not in the recorded failure: " + bad);
  p.tapChip("go");
  t.ok(!p.sheet().innerHTML.includes(SECRET) && !p.sheet().innerHTML.includes(LONGTOK) && !p.sheet().innerHTML.includes("tokA"), "not in the sheet preview");
  await send(p, "Some request failed");
  const post = p.posts.find((x) => x.path === "/api/bug-reports");
  t.ok(post, "the report was sent");
  const body = JSON.parse(post.body);
  t.equal(body.mfl_user_id, "tokA", "the sign-in travels in the body field made for it");
  const rest = JSON.stringify({ ...body, mfl_user_id: undefined });
  for (const bad of [SECRET, LONGTOK, "tokA"]) t.ok(!rest.includes(bad), "not anywhere else in the POST: " + bad);
  t.ok(!post.path.includes("tokA") && !post.query.includes("tokA"), "and not in the address");
  const stored = JSON.stringify(rowsOf(p));
  for (const bad of [SECRET, LONGTOK, "tokA"]) t.ok(!stored.includes(bad), "not in the stored row: " + bad);
  const cv = await p.worker.bugReports(WORKER_ORIGIN + "/api/bug-reports/commish/list?L=74598&YEAR=2026", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mfl_user_id: "tokC" }) });
  const cvText = await cv.text();
  t.equal(cv.status, 200, "the commissioner can read");
  for (const bad of [SECRET, LONGTOK, "tokA"]) t.ok(!cvText.includes(bad), "not in the commissioner view: " + bad);
});

test("THE OBSERVER NEVER READS A BODY OR A HEADER, and returns the very same promise and response the app would have got", async () => {
  const touched = [];
  const guard = (name) => ({ get() { touched.push(name); return () => { throw new Error("touched " + name); }; } });
  const sentinelErr = new TypeError("sentinel");
  const win = { location: { hash: "#home", href: "https://ups.test/m/" }, URL, Date, console, setTimeout, clearTimeout, document: undefined, addEventListener() {} };
  win.window = win;
  const res500 = new Response("x", { status: 500 });
  for (const k of ["json", "text", "clone", "arrayBuffer", "blob", "formData", "body", "headers"]) Object.defineProperty(res500, k, guard(k));
  const initial = (url) => (/boom/.test(url) ? Promise.reject(sentinelErr) : Promise.resolve(res500));
  win.fetch = (u) => initial(String(u));
  (await import("node:vm")).runInNewContext(SCRIPT, win);
  win.UPSReportBug.install({ build: "t", observe: true });
  const p1 = win.fetch("https://w.example/api/a?TYPE=rosters&k=1");
  const got = await p1;
  t.ok(got === res500, "the app receives the very same Response object");
  let caught = null; try { await win.fetch("https://w.example/api/boom"); } catch (e) { caught = e; }
  t.ok(caught === sentinelErr, "and the very same rejection");
  t.deepEqual(touched, [], "no body or header was touched: " + touched.join());
  t.equal(win.UPSReportBug.failures().length, 2, "both were recorded");
  t.equal(win.UPSReportBug.failures()[0].message, "HTTP 500 (rosters)", "with a safe label for TYPE= exports only");
});

test("THE SHEET'S OWN POST IS NEVER RECORDED (no loop), even when the commissioner's endpoint fails", async () => {
  const p = await boot({ hash: "#myteam/lineup" });
  p.M.ui.showToast("Something failed", "err");
  p.fail({ path: "/api/bug-reports", mode: "500" });
  p.tapChip("go"); await send(p, "Report this");
  t.match(p.sheet().innerHTML, /Something went wrong on our side/, "the owner is told it was not saved");
  t.equal(p.R().failures().length, 1, "no new failure for the report's own request");
  t.equal(p.workerCalls().filter((c) => c.path === "/api/bug-reports").length, 1);
});

test("A SHEET THAT MISBEHAVES CANNOT CHANGE THE APP: a throwing recorder, a throwing DOM and a missing sheet all leave pages, toasts and requests as they were", async () => {
  for (const name of ["render-error", "err-toast", "proposals-500", "rosters-500"]) {
    const base = await runScenario(name);
    // a recorder that throws
    const a = await runScenario(name, { script: true });
    const rb = a.p.win.UPSReportBug;
    const b = await (async () => {
      const sc = SCENARIOS[name];
      const p = await makePhone({ ...sc.opts, script: true });
      p.win.UPSReportBug.noteFailure = () => { throw new Error("recorder down"); };
      for (const step of sc.steps) { await step(p); await settle(); }
      return snap(p, buildOf(APP));
    })();
    t.equal(JSON.stringify({ ...b, main: b.main.replace(REPORT_ROW, "") }), JSON.stringify({ ...base.snaps[base.snaps.length - 1], main: base.snaps[base.snaps.length - 1].main }), name + ": a throwing recorder changes nothing");
    // a DOM that cannot take the chip or the sheet's stylesheet
    const sc = SCENARIOS[name];
    const p = await makePhone({ ...sc.opts, script: true });
    const bodyAppend = p.dom.document.body.appendChild, headAppend = p.dom.document.head.appendChild;
    p.dom.document.body.appendChild = (c) => { if (c.className === "ups-rb-chip") throw new Error("no DOM"); return bodyAppend(c); };
    p.dom.document.head.appendChild = () => { throw new Error("no DOM"); };
    for (const step of sc.steps) { await step(p); await settle(); }
    const last = snap(p, buildOf(APP));
    t.equal(JSON.stringify(last.requests), JSON.stringify(base.snaps[base.snaps.length - 1].requests), name + ": a DOM that throws changes no request");
    t.equal(JSON.stringify(last.toasts), JSON.stringify(base.snaps[base.snaps.length - 1].toasts), name + ": ... or toast");
    t.equal(last.main.replace(REPORT_ROW, ""), base.snaps[base.snaps.length - 1].main, name + ": ... or page");
    t.ok(rb && true);
  }
  const p = await makePhone({ stored: SIGNED_IN, hash: "#more" });   // More without the sheet: no row, no crash
  t.ok(!p.main().includes("Report a problem"));
});

// ---------------------------------------------------------------- 7. mutation checks
function mutate(src, from, to) {
  t.equal(src.split(from).length - 1, 1, "mutation target present exactly once: " + from.slice(0, 60));
  return src.split(from).join(to);
}
const CHECKS = {
  observer: async (a, s) => { const p = await makePhone({ appSrc: a, scriptSrc: s, script: true, stored: SIGNED_IN, hash: "#home", rules: [{ path: "/api/trades/proposals", mode: "500" }] }); return p.R().failures().some((f) => f.endpoint === "/api/trades/proposals") && !!p.chip(); },
  renderHook: async (a, s) => { const p = await makePhone({ appSrc: a, scriptSrc: s, script: true, stored: SIGNED_IN, hash: "#home", viewThrows: "home" }); return p.R().failures().some((f) => f.message === "view exploded"); },
  toastHook: async (a, s) => { const p = await makePhone({ appSrc: a, scriptSrc: s, script: true, stored: SIGNED_IN, hash: "#home" }); p.M.ui.showToast("boom", "err"); return p.R().failures().some((f) => f.message === "boom"); },
  moreRow: async (a, s) => { const p = await makePhone({ appSrc: a, scriptSrc: s, script: true, stored: SIGNED_IN, hash: "#more" }); return p.main().includes("Report a problem"); },
  ledger: async (a, s) => { const p = await makePhone({ appSrc: a, scriptSrc: s, script: true, stored: SIGNED_IN, hash: "#home", rules: [{ path: "/api/trades/proposals", mode: "401" }] }); return p.R().failures().length === 0; },
  noScriptSafe: async (a, s) => {   // the pre-change behavior with no script, on the scenario where a hook would run
    try { const p = await makePhone({ appSrc: a, stored: SIGNED_IN, hash: "#home", viewThrows: "home" }); return /Render error: view exploded/.test(p.main()); } catch (e) { return false; }
  },
  startAttribution: async (a, s) => {
    const p = await makePhone({ appSrc: a, scriptSrc: s, script: true, stored: SIGNED_IN, hash: "#myteam/lineup" });
    const hold = p.fail({ path: "/api/taxi-callups", mode: "hold" }); const pend = p.M.data.ensureTaxiCallups(); await settle();
    await p.go("#league/rosters"); p.release(hold, "500"); await pend.catch(() => {}); await settle();
    return p.R().failures()[0] && p.R().failures()[0].screen === "Lineup" && p.chip() === null;
  },
  ownPost: async (a, s) => {
    const p = await makePhone({ appSrc: a, scriptSrc: s, script: true, stored: SIGNED_IN, hash: "#myteam/lineup" });
    p.M.ui.showToast("x", "err"); p.fail({ path: "/api/bug-reports", mode: "500" }); p.tapChip("go"); await send(p, "A real summary");
    const posted = p.workerCalls().some((c) => c.path === "/api/bug-reports");      // the check must actually exercise the POST
    return posted && p.R().failures().length === 1;
  },
};

test("MUTATION CHECKS: cut each mechanism out and the check that protects it must FAIL (so nothing here passes vacuously)", async () => {
  for (const [name, ok] of Object.entries(CHECKS)) t.equal(await ok(APP, SCRIPT), true, "unmutated: " + name + " passes");
  const cases = [
    ["observer", APP, mutate(SCRIPT, "if (observing || typeof root.fetch !== \"function\") return;", "return;")],
    ["renderHook", mutate(APP, "      reportBugNote({ name: (e && e.name) || \"Error\", message: (e && e.message) || String(e) });\n", ""), SCRIPT],
    ["toastHook", mutate(APP, "    if (kind === \"err\") reportBugNote({ name: \"Error\", message: text });\n", ""), SCRIPT],
    ["moreRow", mutate(APP, "(reportBugAvailable() ? ", "(false ? "), SCRIPT],
    ["ledger", APP, mutate(SCRIPT, "if (!(st >= 400) || isExpected(endpoint, st)) return;", "if (!(st >= 400)) return;")],
    ["noScriptSafe", mutate(APP, "try { var R = window.UPSReportBug; if (R && R.noteFailure) R.noteFailure(info); } catch (e) { /* never affects the app */ }", "window.UPSReportBug.noteFailure(info);"), SCRIPT],
    ["startAttribution", APP, mutate(SCRIPT, "try { observe(urlOf(input), start, p); }", "try { observe(urlOf(input), { get route() { return screenNow().route; }, get screen() { return screenNow().screen; } }, p); }")],
    ["ownPost", APP, mutate(SCRIPT, "if (isOwnPost(endpoint)) return;", "")],
  ];
  for (const [name, a, s] of cases) t.equal(await CHECKS[name](a, s), false, "MUTANT FAILS the '" + name + "' check");
  // The golden itself is sensitive: a one-word visible change in app.js, and an extra request, are both caught.
  const sensitive = await runScenario("healthy-home", { appSrc: mutate(APP, ">Refresh data</button>", ">Refresh data!</button>") });
  t.ok(JSON.stringify(sensitive.snaps) !== JSON.stringify(GOLDEN.scenarios["healthy-home"]), "a visible text change is caught by the golden");
  const extra = await runScenario("healthy-home", { appSrc: mutate(APP, "function boot() {\n    registerServiceWorker();", "function boot() {\n    fetch(workerUrl('/api/extra'));\n    registerServiceWorker();") });
  t.ok(JSON.stringify(extra.snaps) !== JSON.stringify(GOLDEN.scenarios["healthy-home"]), "an extra request is caught by the golden");
});

await run("report_bug_integration");
