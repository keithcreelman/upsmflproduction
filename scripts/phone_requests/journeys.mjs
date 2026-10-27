// Phone-app request journeys, offline (phone boot requests, 2026-10-20). Runs the real site/m app in Chromium, serves
// site/ from disk at a fake origin and answers every worker GET from fixtures (fixture_worker.mjs, built from
// tests/fixtures): nothing here reaches production, MFL or D1, and every other host is aborted. Writes a log of every
// worker call, tagged with the journey and step that made it; journey_table.py turns two logs into the before/after table.
//   git archive <base> site | tar -x -C /tmp/before          # the "before" site
//   node scripts/phone_requests/journeys.mjs before /tmp/before/site . /tmp/out
//   node scripts/phone_requests/journeys.mjs after site . /tmp/out
//   python3 scripts/phone_requests/journey_table.py /tmp/out
// Needs Playwright with Chromium (not a repo dependency): PLAYWRIGHT=/path/to/node_modules/playwright if it isn't
// resolvable from here. A dev tool, not part of the safe suite (it drives a browser).
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { makeFixtureWorker } from "./fixture_worker.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT || "playwright");

const [label, siteArg, repoArg, outDir] = process.argv.slice(2);
const siteRoot = path.resolve(siteArg), repoRoot = path.resolve(repoArg);
const ORIGIN = "https://ups.test";
const APP = ORIGIN + "/upsmflproduction/m/index.html";
const WORKER_HOST = "upsmflproduction.keith-creelman.workers.dev";
const TYPES = { ".html": "text/html", ".js": "application/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml", ".webmanifest": "application/manifest+json" };
fs.mkdirSync(outDir, { recursive: true });

const log = [];          // { journey, step, kind, method, route, query, status }
let journey = "setup", step = "";
const shots = [];

async function newSession(failures) {
  const worker = makeFixtureWorker(repoRoot, { failures });
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 375, height: 812 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, serviceWorkers: "block" });
  const page = await context.newPage();
  let inflight = 0, lastChange = Date.now();
  page.on("dialog", (d) => d.accept());
  page.on("pageerror", (e) => log.push({ journey, step, kind: "pageerror", route: String(e && e.message || e).slice(0, 200) }));
  await context.route("**/*", async (route) => {
    const req = route.request(), u = new URL(req.url());
    inflight++; lastChange = Date.now();
    try {
      if (u.origin === ORIGIN) {
        const rel = decodeURIComponent(u.pathname.replace(/^\/upsmflproduction\//, ""));
        const file = path.join(siteRoot, rel);
        if (!file.startsWith(siteRoot) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
          if (/\.json$/.test(rel)) log.push({ journey, step, kind: "pages", method: req.method(), route: "/" + rel, status: 404 });
          return await route.fulfill({ status: 404, body: "not found" });
        }
        if (/\.json$/.test(rel)) log.push({ journey, step, kind: "pages", method: req.method(), route: "/" + rel, status: 200 });
        return await route.fulfill({ status: 200, contentType: TYPES[path.extname(file)] || "application/octet-stream", body: fs.readFileSync(file) });
      }
      if (u.hostname === WORKER_HOST) {
        const a = worker.answer(req.method(), u);
        const q = new URLSearchParams(u.search); if (q.has("MFL_USER_ID")) q.set("MFL_USER_ID", "<owner>"); q.delete("_");
        log.push({ journey, step, kind: "worker", method: req.method(), route: u.pathname, query: q.toString(), status: a.status });
        return await route.fulfill(a);
      }
      log.push({ journey, step, kind: "external", method: req.method(), route: u.hostname + u.pathname, status: 0 });
      return await route.abort();
    } finally { inflight--; lastChange = Date.now(); }
  });
  async function idle(quiet = 900, max = 20000) {
    const t0 = Date.now();
    while (Date.now() - t0 < max) {
      await page.waitForTimeout(150);
      if (inflight === 0 && Date.now() - lastChange >= quiet) return;
    }
  }
  return { browser, context, page, idle, worker };
}
function begin(j, s) { journey = j; step = s || ""; log.push({ journey, step, kind: "mark", route: "" }); }
async function shot(page, name) {
  const f = path.join(outDir, label + "_" + name + ".png");
  await page.screenshot({ path: f, fullPage: false });
  shots.push(f);
}
async function hash(page, idle, h) { await page.evaluate((x) => { window.location.hash = x; }, h); await idle(); }

// ── J1 signed-out cold boot ──
{
  const s = await newSession();
  begin("J1", "cold boot, nobody signed in");
  await s.page.goto(APP); await s.idle();
  await shot(s.page, "J1_signed_out");
  await s.browser.close();
}

// ── J2–J8 + sheet + J9: one owner's session ──
{
  const s = await newSession();
  begin("setup", "first sign-in (Switch to App View bounce)");
  await s.page.goto(APP + "?MFL_USER_ID=tokA"); await s.idle();
  begin("J2", "cold boot to Home (returning owner)");
  await s.page.goto(APP); await s.idle();
  await shot(s.page, "J2_home");
  begin("J4", "open Standings");
  await hash(s.page, s.idle, "#league/standings");
  begin("J3", "back to Home");
  await hash(s.page, s.idle, "#home");
  begin("J5", "open Stats → Players");
  await hash(s.page, s.idle, "#league/stats");
  await shot(s.page, "J5_stats_players");
  begin("J6", "RB tab");
  await s.page.click('[data-tab="RB"]'); await s.idle();
  begin("J6", "Roster filter → Free agents");
  await s.page.selectOption("#ups-m-st-scope", "fa"); await s.idle();
  begin("J6", "back to QB tab");
  await s.page.click('[data-tab="QB"]'); await s.idle();
  begin("J7", "leave Stats (Home)");
  await hash(s.page, s.idle, "#home");
  begin("J7", "return to Stats");
  await hash(s.page, s.idle, "#league/stats");
  begin("J8", "background, then resume");
  await s.page.evaluate(() => {
    const set = (v) => { Object.defineProperty(document, "visibilityState", { configurable: true, get: () => v }); document.dispatchEvent(new Event("visibilitychange")); };
    set("hidden"); set("visible");
    delete document.visibilityState;   // back to the browser's own value (a later navigation must hide the page for real)
  });
  await s.idle();
  begin("JS", "open My Team");
  await hash(s.page, s.idle, "#myteam");
  begin("JS", "open a player sheet (Actions tab)");
  await s.page.locator(".ups-m-player-row").first().click(); await s.idle();
  begin("JS", "sheet Stats tab");
  await s.page.click('.ups-m-sheet-tab[data-tab="stats"]'); await s.idle();
  await shot(s.page, "JS_sheet_stats");
  begin("JS", "close, open another player's sheet, Stats tab");
  await s.page.evaluate(() => window.UPS_MOBILE.sheet.close()); await s.idle(400);
  await s.page.locator(".ups-m-player-row").nth(1).click(); await s.idle();
  await s.page.click('.ups-m-sheet-tab[data-tab="stats"]'); await s.idle();
  await s.page.evaluate(() => window.UPS_MOBILE.sheet.close()); await s.idle(400);
  begin("JR", "pull-to-refresh equivalent (Refresh data on More)");
  await hash(s.page, s.idle, "#more");
  await s.page.click("#ups-m-refresh-data"); await s.idle();
  begin("J9", "sign out");
  await s.page.click("#ups-m-sign-out"); await s.idle();
  await hash(s.page, s.idle, "#home");
  await shot(s.page, "J9_after_sign_out");
  begin("J9", "another owner signs in (bounce) — cold boot");
  await s.page.goto(APP + "?MFL_USER_ID=tokB"); await s.idle();
  const title = await s.page.textContent("#ups-m-header-title").catch(() => "");
  log.push({ journey: "J9", step: "check", kind: "note", route: "header after owner B signs in: " + title });
  await shot(s.page, "J9_owner_b_home");
  await s.browser.close();
}

// ── J10 failed read, then a controlled retry ──
{
  const s = await newSession();
  begin("setup", "first sign-in");
  await s.page.goto(APP + "?MFL_USER_ID=tokA"); await s.idle();
  // From here the next 2 leaderboard reads and the next penalty-batch read answer HTTP 500, once each.
  s.worker.failures["/api/advanced-stats-leaderboard"] = 2;
  s.worker.failures["/api/cap-penalty/preview"] = 1;
  begin("J10", "cold boot to Home (next 2 leaderboard reads + next penalty batch fail once)");
  await s.page.goto(APP); await s.idle();
  begin("J10", "open a player sheet + Stats tab");
  await hash(s.page, s.idle, "#myteam");
  await s.page.locator(".ups-m-player-row").first().click(); await s.idle();
  await s.page.click('.ups-m-sheet-tab[data-tab="stats"]'); await s.idle();
  begin("J10", "reopen the sheet + Stats tab at once (inside 30 s)");
  await s.page.evaluate(() => window.UPS_MOBILE.sheet.close()); await s.idle(300);
  await s.page.locator(".ups-m-player-row").first().click(); await s.idle();
  await s.page.click('.ups-m-sheet-tab[data-tab="stats"]'); await s.idle();
  await s.page.evaluate(() => window.UPS_MOBILE.sheet.close());
  await s.page.waitForTimeout(31000);
  begin("J10", "reopen after 30 s (controlled retry)");
  await s.page.locator(".ups-m-player-row").first().click(); await s.idle();
  await s.page.click('.ups-m-sheet-tab[data-tab="stats"]'); await s.idle();
  await shot(s.page, "J10_after_retry");
  await s.page.evaluate(() => window.UPS_MOBILE.sheet.close()); await s.idle(300);
  begin("J10", "Refresh data (More) — the only retry before this change");
  await hash(s.page, s.idle, "#more");
  await s.page.click("#ups-m-refresh-data"); await s.idle();
  await s.browser.close();
}

fs.writeFileSync(path.join(outDir, label + "_requests.json"), JSON.stringify({ label, siteRoot, log, shots }, null, 1));
console.log(label, "requests logged:", log.filter((x) => x.kind === "worker").length, "→", path.join(outDir, label + "_requests.json"));
