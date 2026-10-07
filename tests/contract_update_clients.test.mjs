// Every client that writes a contract forwards the viewer's MFL session, so the worker
// can prove the caller controls the team (worker gate: tests/contract_update_authz.test.mjs).
//   node tests/contract_update_clients.test.mjs
// Ships BEFORE the worker gate: the contract write itself always uses the worker's
// commissioner cookie, so forwarding the session changes nothing until the gate is live.
import fs from "node:fs";
import vm from "node:vm";
import { t, test, run } from "./fixtures/mini_test.mjs";

test("every client that writes contracts forwards the owner's MFL session", async () => {
  const read = (p) => fs.readFileSync(new URL("../" + p, import.meta.url), "utf8");
  for (const m of ["extend", "mym", "restructure", "myac", "tag"]) {
    const src = read(`site/m/front_office_${m}_submit.js`);
    t.match(src, /function postContractUpdate\(url, payload\) \{\n\s+url = withViewerSession\(url\);/, `mobile ${m} module`);
    t.match(src, /getStoredMflUserId/, `mobile ${m} reads the stored session`);
  }
  t.match(read("site/rosters/v2/front_office.js"), /async function postContractUpdate\(url, payload\) \{\n\s+url = appendViewerSessionQuery\(url\);/, "Front Office v2");
  t.match(read("site/rosters/roster_workbench.js"), /function postContractUpdate\(url, payload\) \{\n\s+url = appendViewerSessionQuery\(url\)\.toString\(\);/, "legacy Roster Workbench");
});

test("mobile: the session is appended to the real request URL (and only once)", async () => {
  const src = fs.readFileSync(new URL("../site/m/front_office_extend_submit.js", import.meta.url), "utf8");
  const calls = [];
  const win = { UPS_MOBILE: { api: { getStoredMflUserId: () => "owner tok/1" } } };
  const ctx = { window: win, URLSearchParams, console, JSON, String, Object, Array, Math, Number, Promise, encodeURIComponent, decodeURIComponent,
    fetch: async (url, init) => { calls.push(String(url)); return { ok: true, status: 200, text: async () => "{}" }; } };
  vm.createContext(ctx); vm.runInContext(src, ctx);
  const ext = win.UPS_FRONT_OFFICE_EXT;
  await ext.submitExtension({ workerBase: "https://w.test", leagueId: "74598", year: "2026", row: {}, option: {} }).catch(() => {});
  t.ok(calls.length >= 1, "a request was made");
  t.equal(calls[0], "https://w.test/commish-contract-update?L=74598&YEAR=2026&MFL_USER_ID=owner%20tok%2F1");
});

await run("contract_update_clients");
