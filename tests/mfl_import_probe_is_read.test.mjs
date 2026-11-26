// Keith 2026-11-26 ("Go fix probe"; #1475/#1537): the worker finds the league's MFL server with a READ, never with the write itself. The old probe
// sent the full import as a GET to api.myfantasyleague.com before sending it again to the league's server (the test guard refused the second as a
// duplicate). This runs the worker's own resolveMflImportTargetUrlForCookie, cut from worker/src/index.js, against a fake fetch.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { t, test, run } from "./fixtures/mini_test.mjs";

const SRC = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "worker", "src", "index.js"), "utf8");
const cut = (name) => { const a = SRC.indexOf("const " + name + " = async "); return SRC.slice(a, SRC.indexOf("\n      };", a) + 9); };
const body = cut("resolveMflImportTargetUrlForCookie"), twin = cut("resolveMflImportTargetUrl");
const safeStr = (v) => (v == null ? "" : String(v).trim());
function resolver(answer) {
  const calls = [];
  const fakeFetch = async (url, opts) => { calls.push({ url, opts }); const a = answer(url); return { status: a.status, headers: { get: (k) => (/location/i.test(k) ? a.location || null : null) } }; };
  const fn = new Function("fetch", "safeStr", "YEAR", body + "\nreturn resolveMflImportTargetUrlForCookie;")(fakeFetch, safeStr, "2026");
  return { fn, calls };
}

test("the probe is a league read; the import goes to the league's server once, with the same query it always carried", async () => {
  const { fn, calls } = resolver((url) => ({ status: 302, location: url.replace("https://api.", "https://www48.") }));
  const target = await fn("MFL_USER_ID=x", "2026", { TYPE: "ir", L: "25625", DEACTIVATE: "14842", FRANCHISE_ID: "0003" });
  t.equal(calls.length, 1, "one probe");
  const p = new URL(calls[0].url);
  t.equal(p.origin + p.pathname, "https://api.myfantasyleague.com/2026/export", "the probe is an EXPORT (a read)");
  t.equal(p.searchParams.get("TYPE"), "league"); t.equal(p.searchParams.get("L"), "25625");
  t.ok(!/DEACTIVATE|DROP|PROMOTE|DEMOTE|ACTIVATE/.test(calls[0].url), "no write field in the probe");
  t.equal(calls[0].opts.method, "GET"); t.equal(calls[0].opts.redirect, "manual");
  const u = new URL(target);
  t.equal(u.origin + u.pathname, "https://www48.myfantasyleague.com/2026/import", "the import goes to the league's server");
  t.deepEqual(Object.fromEntries(u.searchParams), { TYPE: "ir", L: "25625", DEACTIVATE: "14842", FRANCHISE_ID: "0003" }, "with the same query as before");
});

test("no league in the fields, or no redirect: the api.* import address as before, and no write is ever sent by the probe", async () => {
  const a = resolver(() => ({ status: 200 }));
  const t1 = await a.fn("c", "2026", { TYPE: "ir", L: "25625", DEACTIVATE: "1" });
  t.equal(new URL(t1).origin, "https://api.myfantasyleague.com"); t.ok(a.calls.every((c) => c.url.includes("/export?")));
  const b = resolver(() => { throw new Error("must not be called"); });
  const t2 = await b.fn("c", "2026", { TYPE: "salaryAdj", DATA: "x" });
  t.equal(b.calls.length, 0, "no L: no probe at all"); t.match(t2, /^https:\/\/api\.myfantasyleague\.com\/2026\/import\?TYPE=salaryAdj&DATA=x$/);
  const c = resolver(() => { throw new Error("network down"); });
  t.match(await c.fn("c", "2026", { TYPE: "ir", L: "25625" }), /^https:\/\/api\.myfantasyleague\.com\/2026\/import\?/, "a failed probe falls back to api.* (MFL then redirects or refuses; nothing was written by the probe)");
  t.doesNotMatch(body, /fetch\(probeUrl/, "the old write-shaped probe is gone");
});

test("the commissioner-session twin (resolveMflImportTargetUrl) probes with the same read", async () => {
  const calls = [];
  const fakeFetch = async (url) => { calls.push(url); return { status: 302, headers: { get: () => url.replace("https://api.", "https://www48.") } }; };
  const fn = new Function("fetch", "safeStr", "YEAR", "cookieHeader", twin + "\nreturn resolveMflImportTargetUrl;")(fakeFetch, safeStr, "2026", "c");
  const target = await fn("2026", { TYPE: "salaryAdj", L: "25625", DATA: "<x/>" });
  t.equal(calls.length, 1); t.match(calls[0], /^https:\/\/api\.myfantasyleague\.com\/2026\/export\?TYPE=league&L=25625&JSON=1$/);
  t.equal(new URL(target).origin + new URL(target).pathname, "https://www48.myfantasyleague.com/2026/import");
  t.equal(new URL(target).searchParams.get("DATA"), "<x/>");
  t.doesNotMatch(twin, /fetch\(probeUrl/);
});

await run("mfl_import_probe_is_read");
