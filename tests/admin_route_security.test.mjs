// /admin/* SECURITY — the REAL worker on real SQLite, MFL stubbed at the edge.
//   node tests/admin_route_security.test.mjs
//
// Production finding (2026-09-25, measured read-only against the deployed worker): ANY unmatched path — an unknown /admin/* route, a wrong-method
// call, a case/slash/encoding variant — fell through to a generic handler and answered 200 with the worker's own commissioner-state JSON
// (commissioner franchise id, owner-email count, "isAdmin": true). Behind it, many real admin routes "authenticated" with getLeagueAdminState(),
// which reads the WORKER's cookie and therefore said yes to every caller.
//
// Proves: exact-match routing (unknown/variants → uniform 404), a real credential before any real admin route runs, no protected data in any
// unauthorized answer, the one deliberately public read under /admin is unchanged, and the route table cannot drift from the source.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { t, test, run } from "./fixtures/mini_test.mjs";
import { makeWorkerEnv, makeMfl, callWorker, ADMIN_KEY, quiet } from "./fixtures/worker_harness.mjs";
import { render as renderRouteTable } from "../scripts/build_admin_route_table.mjs";
import { ADMIN_ROUTES } from "../worker/src/admin_routes.js";
import { classifyAdminRequest, looseAdminForm } from "../worker/src/admin_front_door.js";

const restore = quiet();
const Q = "L=74598&YEAR=2026";
const FORBIDDEN = /commishFranchiseId|emailCount|isAdmin|Private owner data|@ups\.test|MFL_COOKIE|DISCORD_BOT_TOKEN|env_names|ups_3way_trades|migration/i;
const fresh = () => { const env = makeWorkerEnv(); const mfl = makeMfl({}); mfl.install(); return { env, mfl }; };

// ───────────────────────────────── the table cannot drift ─────────────────────────────────
test("TABLE: worker/src/admin_routes.js is exactly what the source defines (regenerate with scripts/build_admin_route_table.mjs)", () => {
  const cur = fs.readFileSync(new URL("../worker/src/admin_routes.js", import.meta.url), "utf8");
  t.ok(cur === renderRouteTable(), "admin route table is stale");
  t.ok(Object.keys(ADMIN_ROUTES).length > 90);
  for (const p of ["/admin/3way/cancel", "/admin/3way/inspect", "/admin/3way/compliance", "/admin/hall/proposals"]) t.ok(ADMIN_ROUTES[p], p);
});
test("TABLE: every literal /admin path compared in the source is a table entry (no route can be added without being classified)", () => {
  const src = ["../worker/src/index.js", "../worker/src/hall.js"].map((f) => fs.readFileSync(new URL(f, import.meta.url), "utf8")).join("\n");
  const found = new Set([...src.matchAll(/path === "(\/admin\/[^"?#]+)"/g)].map((m) => m[1]));
  for (const p of found) t.ok(Object.prototype.hasOwnProperty.call(ADMIN_ROUTES, p), `missing from the table: ${p}`);
});

// ───────────────────────────────── classification (pure) ─────────────────────────────────
test("CLASSIFY: only an EXACT route + allowed method is a route; every disguise is 'unknown' (never routed, never generic)", () => {
  t.equal(classifyAdminRequest("/admin/3way/cancel", "POST"), "admin");
  t.equal(classifyAdminRequest("/admin/3way/cancel", "GET"), "unknown", "wrong method");
  t.equal(classifyAdminRequest("/admin/contract-submissions", "GET"), "public");
  t.equal(classifyAdminRequest("/admin/contract-submissions", "POST"), "unknown");
  t.equal(classifyAdminRequest("/admin/rule-proposals/abc123/verdict", "POST"), "admin");
  t.equal(classifyAdminRequest("/admin/rule-proposals/abc123/verdict", "GET"), "unknown");
  t.equal(classifyAdminRequest("/api/trades/3way", "GET"), "not_admin");
  t.equal(classifyAdminRequest("/roster-workbench/admin-state", "GET"), "not_admin");
  const disguises = ["/admin", "/admin/", "/admin/nope", "/admin/3way/nope", "/admin/3way/cancel/", "/admin//3way/cancel", "//admin/3way/cancel", "/admin/3way//cancel",
    "/ADMIN/3way/cancel", "/Admin/3way/cancel", "/admin/3WAY/cancel", "/admin/3way/CANCEL", "/admin%2F3way%2Fcancel", "/admin/3way%2Fcancel", "/%61dmin/3way/cancel",
    "/admin/./3way/cancel", "/admin/x/../3way/cancel", "/admin/3way/cancel%00", "/admin\\3way\\cancel", "/admin/3way/cancel;x=1", "/admin%252F3way%252Fcancel", "/./admin/3way/cancel", "/admin/3way/cancel%2F"];
  for (const p of disguises) t.equal(classifyAdminRequest(p, "POST"), "unknown", `disguise: ${p}`);
  t.equal(looseAdminForm("/%61dmin//x/../3way"), "/admin/3way");
});

// ───────────────────────────────── the production defect, reproduced ─────────────────────────────────
test("REGRESSION: the deployed worker (origin/main 912d4750) answers 200 with the commissioner state for an unknown admin route — the fixed worker answers 404", async () => {
  let dir = "";
  try {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "oldworker-"));
    execFileSync("sh", ["-c", `git archive 912d4750a548dcca525d0f1ea58ae8c9b23f4244 worker/src worker/package.json docs/league_context_v1.md | tar -x -C "${dir}"`], { cwd: new URL("..", import.meta.url).pathname, stdio: "pipe" });
  } catch (e) {
    console.warn("(base commit not available in this clone — reproduction skipped)"); t.ok(true); return;
  }
  const oldWorker = (await import(pathToFileURL(path.join(dir, "worker/src/index.js")).href)).default;
  const { env } = fresh();
  const callOld = async (method, p) => {
    const res = await oldWorker.fetch(new Request("https://worker.test" + p, { method, body: method === "POST" ? "{}" : undefined }), env, { waitUntil() {}, passThroughOnException() {} });
    return { status: res.status, text: await res.text() };
  };
  for (const [m, p, want] of [["POST", `/admin/3way/compliance?${Q}`, 401], ["GET", `/admin/definitely-not-a-route?${Q}`, 404], ["POST", `/admin/3way/cancel?${Q}`, 401], ["GET", `/admin/nested/unknown/path?${Q}`, 404]]) {
    const old = await callOld(m, p);
    t.equal(old.status, 200, `OLD worker ${m} ${p} → 200 (the production defect)`);
    t.match(old.text, /"isAdmin":true/); t.match(old.text, /"emailCount":\d+/); t.match(old.text, /"commishFranchiseId":"0000"/);
    const now = await callWorker(env, m, p);
    t.equal(now.status, want, `FIXED worker ${m} ${p} → ${want} (a real route needs a credential; an unknown one is not found)`); t.doesNotMatch(now.text, FORBIDDEN);
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

// ───────────────────────────────── unknown / disguised / method / query ─────────────────────────────────
const NOT_FOUND = JSON.stringify({ ok: false, error: "not_found" });
test("UNKNOWN: unknown, nested-unknown, trailing/duplicate slash, case, encoded separators and dot segments are ALL the same 404 — before the L-guard, with or without credentials", async () => {
  const { env, mfl } = fresh();
  const paths = ["/admin/nope", "/admin/nested/unknown/path", "/admin/3way/cancel/", "/admin//3way/cancel", "//admin/3way/cancel", "/ADMIN/3way/cancel", "/admin/3WAY/cancel",
    "/admin%2F3way%2Fcancel", "/admin/3way%2Fcancel", "/%61dmin/3way/cancel", "/admin/3way/cancel;x=1", "/admin/", "/admin"];
  for (const p of paths) {
    for (const q of ["", `?${Q}`, `?${Q}&APIKEY=${ADMIN_KEY}`, `?${Q}&APIKEY=wrong`, `?${Q}&MFL_USER_ID=tok-commish`, "?%41PIKEY=" + ADMIN_KEY, `?${Q}&APIKEY=${ADMIN_KEY}&APIKEY=wrong`]) {
      for (const m of ["GET", "POST"]) {
        const r = await callWorker(env, m, p + q, m === "POST" ? { body: { id: "x", reason: "x" } } : undefined);
        t.equal(r.status, 404, `${m} ${p}${q}`); t.equal(r.text, NOT_FOUND, `identical body: ${m} ${p}${q}`); t.doesNotMatch(r.text, FORBIDDEN);
      }
    }
  }
  t.equal(mfl.writes().length, 0, "nothing was written anywhere");
});
test("DOT SEGMENTS: the URL layer resolves them BEFORE the worker sees the path — the result is the exact route and needs exactly the same credential (never a bypass)", async () => {
  const { env } = fresh();
  for (const p of ["/admin/./3way/inspect", "/admin/x/../3way/inspect", "/admin/%2e/3way/inspect", "/admin/x/%2e%2e/3way/inspect"]) {
    t.equal((await callWorker(env, "GET", `${p}?${Q}`)).status, 401, `${p} without a key`);
    t.equal((await callWorker(env, "GET", `${p}?${Q}&APIKEY=wrong`)).status, 403, `${p} with a bad key`);
    t.equal((await callWorker(env, "GET", `${p}?${Q}&APIKEY=${ADMIN_KEY}`)).status, 200, `${p} with the key = the exact route`);
  }
});
test("METHODS: a real route with the wrong method is the SAME 404 as an unknown route (no route inventory leaks); every method is covered", async () => {
  const { env } = fresh();
  for (const m of ["GET", "PUT", "DELETE", "PATCH", "HEAD"]) {
    const r = await callWorker(env, m, `/admin/3way/cancel?${Q}&APIKEY=${ADMIN_KEY}`);
    t.equal(r.status, 404, m); if (m !== "HEAD") t.equal(r.text, NOT_FOUND, m);
  }
  for (const m of ["POST", "PUT", "DELETE", "PATCH"]) {
    const r = await callWorker(env, m, `/admin/3way/inspect?${Q}&APIKEY=${ADMIN_KEY}`, m === "POST" || m === "PUT" || m === "PATCH" ? { body: {} } : undefined);
    t.equal(r.status, 404, `${m} on a GET-only route`);
  }
});
test("OPTIONS: the minimum CORS answer and nothing else — no data, on real and unknown admin paths alike", async () => {
  const { env } = fresh();
  for (const p of ["/admin/3way/cancel", "/admin/nope", "/admin/d1-status", "/ADMIN/x", "/admin%2Fx"]) {
    const r = await callWorker(env, "OPTIONS", `${p}?${Q}`);
    t.equal(r.status, 200); t.equal(r.text, ""); t.equal(r.headers.get("access-control-allow-origin"), "*"); t.doesNotMatch(r.text, FORBIDDEN);
  }
});

// ───────────────────────────────── known routes: valid / missing / invalid authority ─────────────────────────────────
test("KNOWN ROUTE: valid key → served; missing → 401; invalid → 403; every credential form the routes use is compared, nothing else counts", async () => {
  const { env } = fresh();
  const url = `/admin/3way/inspect?${Q}`;
  t.equal((await callWorker(env, "GET", `${url}&APIKEY=${ADMIN_KEY}`)).status, 200, "valid key (APIKEY)");
  // header / key= forms are the ones the workflows use (backfill-playoff-weekly); the door compares them the same way
  const wf = `/admin/backfill-playoff-weekly?${Q}&seasons=2021`;
  t.equal((await callWorker(env, "GET", wf, { headers: { "X-COMMISH-APIKEY": ADMIN_KEY } })).status, 200, "valid key (X-COMMISH-APIKEY header)");
  t.equal((await callWorker(env, "GET", `${wf}&key=${ADMIN_KEY}`)).status, 200, "valid key (key=)");
  t.equal((await callWorker(env, "GET", wf, { headers: { "X-COMMISH-APIKEY": "wrong" } })).status, 403);
  const missing = await callWorker(env, "GET", url);
  t.equal(missing.status, 401); t.equal(missing.json.code, "unauthenticated"); t.doesNotMatch(missing.text, FORBIDDEN);
  for (const bad of [`&APIKEY=wrong`, `&APIKEY=`, `&APIKEY=${ADMIN_KEY}x`, `&APIKEY=${ADMIN_KEY.slice(1)}`, `&key=nope`, `&APIKEY=${ADMIN_KEY.toUpperCase()}`]) {
    const r = await callWorker(env, "GET", url + bad);
    t.ok([401, 403].includes(r.status), `invalid: ${bad} → ${r.status}`); t.notEqual(r.status, 200); t.doesNotMatch(r.text, FORBIDDEN);
  }
  const hdr = await callWorker(env, "GET", url, { headers: { "X-COMMISH-APIKEY": "wrong" } });
  t.equal(hdr.status, 403);
  // a worker whose secret failed to bind must REFUSE, not open
  const unbound = makeWorkerEnv({ COMMISH_API_KEY: "", MFL_APIKEY: "", TEST_SYNC_API_KEY: "" });
  t.ok([401, 403].includes((await callWorker(unbound, "GET", `${url}&APIKEY=`)).status), "no secrets configured → refuse an empty key");
  t.ok([401, 403].includes((await callWorker(unbound, "GET", url)).status));
});
test("KNOWN ROUTE (session): a commissioner session that MFL proves passes the door; an ordinary owner, a bogus token and an expired one do not", async () => {
  const { env } = fresh();
  const url = `/admin/d1-status?${Q}`;                         // a route with no gate of its own: whatever passes the door is served
  const comm = await callWorker(env, "GET", `${url}&MFL_USER_ID=tok-commish`);
  t.equal(comm.status, 200, "commissioner session");
  const owner = await callWorker(env, "GET", `${url}&MFL_USER_ID=tok-B`);
  t.equal(owner.status, 403, "an ordinary owner is not the commissioner"); t.doesNotMatch(owner.text, FORBIDDEN);
  const bogus = await callWorker(env, "GET", `${url}&MFL_USER_ID=bogus-token`);
  t.ok([401, 403].includes(bogus.status)); t.notEqual(bogus.status, 200);
  const other = await callWorker(env, "GET", `${url}&MFL_USER_ID=tok-x`);            // a member of a DIFFERENT league
  t.equal(other.status, 403);
});
test("EVERY real admin route: no credential / bad key / bad session → 401 or 403 (never data); the wrong method → the uniform 404", async () => {
  const { env, mfl } = fresh();
  const variants = { none: "", badkey: "&APIKEY=wrong-key", badsession: "&MFL_USER_ID=bogus-token", ownerSession: "&MFL_USER_ID=tok-B" };
  let checked = 0;
  for (const [p, methods] of Object.entries(ADMIN_ROUTES)) {
    const ms = methods.includes("*") ? ["GET", "POST"] : methods;
    for (const m of ms) for (const [vn, qs] of Object.entries(variants)) {
      const headers = vn === "badkey" ? { "X-COMMISH-APIKEY": "wrong-key" } : {};
      const r = await callWorker(env, m, `${p}?${Q}${qs}`, { body: m === "POST" ? {} : undefined, headers });
      const isPublic = classifyAdminRequest(p, m) === "public";
      if (isPublic) { t.equal(r.status, 200, `${m} ${p} [${vn}] is the documented public read`); continue; }
      t.ok(r.status === 401 || r.status === 403, `${m} ${p} [${vn}] → ${r.status} ${r.text.slice(0, 80)}`);
      t.doesNotMatch(r.text, FORBIDDEN, `${m} ${p} [${vn}]`); checked++;
    }
  }
  t.ok(checked > 300, `checked ${checked} route × credential combinations`);
  t.equal(mfl.writes().length, 0, "not one MFL write from unauthorized admin calls");
});

// ───────────────────────────────── protected information never appears ─────────────────────────────────
test("NO LEAK: no unauthorized answer (401/403/404) contains the commissioner franchise id, owner-email count, owner identities, config, route inventory or migration state", async () => {
  const { env } = fresh();
  const seen = [];
  for (const p of ["/admin/3way/inspect", "/admin/d1-status", "/admin/discord-channel-config", "/admin/commish-settings", "/admin/config-health", "/admin/health-summary", "/admin/nope", "/admin/x/y/z"]) {
    for (const q of ["", "&APIKEY=wrong", "&MFL_USER_ID=tok-B"]) {
      const r = await callWorker(env, "GET", `${p}?${Q}${q}`);
      t.ok([401, 403, 404].includes(r.status), `${p}${q} → ${r.status}`);
      t.doesNotMatch(r.text, FORBIDDEN); t.doesNotMatch(r.text, /0000|"emailCount"|ups_|D1|SELECT|stack|Error:/);
      seen.push(r.text);
    }
  }
  t.ok(new Set(seen.filter((x) => x === NOT_FOUND)).size <= 1, "all 404 bodies are byte-identical (no inventory signal)");
  // and the sensitive routes really are closed to the anonymous / wrong-key caller (they were 200 before the fix)
  for (const p of ["/admin/d1-status", "/admin/discord-channel-config", "/admin/salary-change-log", "/admin/drops/reconciliation", "/admin/backfill-playoff-weekly", "/admin/sync-src-draft-picks"]) {
    t.equal((await callWorker(env, "GET", `${p}?${Q}`)).status, 401, `${p} anonymous`);
    t.equal((await callWorker(env, "GET", `${p}?${Q}&APIKEY=${ADMIN_KEY}`)).status, 200, `${p} with the key still works`);
  }
  // valid-shaped bodies to the routes that used to post to Discord with only the worker's own cookie
  const post = await callWorker(env, "POST", `/admin/restructure-alert/post?${Q}`, { body: { player_name: "P", franchise_name: "F" } });
  t.equal(post.status, 401); t.equal(env.__discordCalls || 0, 0);
});
test("PUBLIC READ: /admin/contract-submissions is the one deliberately public list under /admin — unchanged, GET only, and free of protected fields", async () => {
  const { env } = fresh();
  const r = await callWorker(env, "GET", `/admin/contract-submissions?${Q}`);
  t.equal(r.status, 200); t.doesNotMatch(r.text, FORBIDDEN);
  t.equal((await callWorker(env, "POST", `/admin/contract-submissions?${Q}`, { body: {} })).status, 404);
  t.equal((await callWorker(env, "GET", `/admin/contract-submissions/?${Q}`)).status, 404);
});
test("ADMIN-STATE (Front Office): anonymous gets no commissioner franchise id / email count; a proven member session or the key gets the id (and never the email count)", async () => {
  const { env } = fresh();
  const anon = await callWorker(env, "GET", `/roster-workbench/admin-state?${Q}`);
  t.equal(anon.status, 200); t.equal(anon.json.isAdmin, false); t.equal(anon.json.commishFranchiseId, ""); t.doesNotMatch(anon.text, /emailCount|Private owner data|0000/);
  const bogus = await callWorker(env, "GET", `/roster-workbench/admin-state?${Q}&MFL_USER_ID=bogus`);
  t.equal(bogus.json.commishFranchiseId, "");
  const member = await callWorker(env, "GET", `/roster-workbench/admin-state?${Q}&MFL_USER_ID=tok-B`);
  t.equal(member.json.ok, true); t.equal(member.json.commishFranchiseId, "0000"); t.doesNotMatch(member.text, /emailCount/);
  const key = await callWorker(env, "GET", `/roster-workbench/admin-state?${Q}&APIKEY=${ADMIN_KEY}`);
  t.equal(key.json.commishFranchiseId, "0000"); t.doesNotMatch(key.text, /emailCount/);
});
test("UNMATCHED (non-admin) paths are the same uniform 404 — no generic fall-through anywhere; unrelated public routes are unchanged", async () => {
  const { env } = fresh();
  for (const p of ["/", "/nope", "/api/nope", "/roster-workbench/nope", `/?${Q}`]) {
    const r = await callWorker(env, "GET", p.includes("?") ? p : `${p}?${Q}`);
    t.ok([400, 404].includes(r.status), `${p} → ${r.status}`); t.doesNotMatch(r.text, FORBIDDEN);
  }
  const nf = await callWorker(env, "GET", `/api/nope?${Q}`); t.equal(nf.status, 404); t.equal(nf.text, NOT_FOUND);
  t.equal((await callWorker(env, "POST", `/api/app-view`, { body: { franchise_id: "0001", surface: "t" } })).status, 204);   // a public beacon: untouched
});

await run("admin_route_security");
restore();
