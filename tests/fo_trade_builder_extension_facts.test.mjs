// Front Office trade builder: the read-only extension-facts connection (adapter, network path faked).
// An extension badge and choices appear only when (1) /trade-workbench says extension_history_ok === true, (2) this franchise has not already
// extended the player, and (3) the worker's own eligibility check (the compliance preview) accepted a probe for him. Rico Dowdle (Blake already
// extended him) and a valid first extension are covered, plus unreadable history, a refused probe (window), and "no writes".
//   node tests/fo_trade_builder_extension_facts.test.mjs
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { t, test, run } from "./fixtures/mini_test.mjs";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");

const FIRST = { id: "16614", name: "First, Valid", position: "WR", salary: 14000, years: 1, type: "Rookie-Draft", special: "CL 1| TCV 14K| AAV 14K| Y1-14K", isTaxi: false, isIr: false };
const RICO = { id: "14823", name: "Dowdle, Rico", position: "RB", salary: 11000, years: 1, type: "Vet-Ext1", special: "CL 2| TCV 12K| AAV 11K| Y1-1K, Y2-11K| GTD: 9K| Ext: Blake", isTaxi: false, isIr: false };
const TEAMS = [{ fid: "0008", name: "Me", players: [FIRST] }, { fid: "0010", name: "Blake", players: [RICO] }];
const wb = (ok) => ({ meta: { counts: { extension_history_ok: ok } }, teams: [
  { franchise_id: "0008", assets: [{ type: "PLAYER", player_id: "16614" }] },
  { franchise_id: "0010", assets: [{ type: "PLAYER", player_id: "14823", already_extended_by_this_franchise: true }] }] });

function harness({ workbench, probe }) {
  const calls = [];
  const listeners = {};
  const ctx = vm.createContext({ console, setTimeout, clearTimeout, Promise, JSON, Math, Object, Array, String, Number, parseInt, isFinite, encodeURIComponent });
  ctx.window = ctx; ctx.self = ctx;
  ctx.document = { addEventListener: (k, f) => { (listeners[k] = listeners[k] || []).push(f); }, getElementById: () => null, createElement: () => ({}) };
  ctx.fetch = (url, init) => {
    const method = (init && init.method) || "GET"; calls.push({ method, url: String(url), body: init && init.body ? JSON.parse(init.body) : null });
    const body = /\/trade-workbench/.test(url) ? workbench : probe(JSON.parse((init && init.body) || "null"));
    return Promise.resolve({ ok: body != null, json: () => Promise.resolve(body) });
  };
  ctx.UPS_FO = { teams: () => TEAMS, viewerFid: () => "0008", warRoomUrl: () => "" };
  ctx.UPS_FO_DATA = { config: () => ({ apiBase: "https://w.test", leagueId: "74598", season: "2026", sessionQuery: (u) => u }), get: () => null };
  ctx.UPS_FO_HUB = { asArray: (x) => (Array.isArray(x) ? x : x ? [x] : []), pad4: (x) => String(x).padStart(4, "0"), teamName: (x) => x, playerButton: (a, b, c) => c };
  for (const f of ["site/shared/trade_rules.js", "site/shared/pretrade_extension.js", "site/shared/trade_builder_core.js", "site/rosters/v2/fo_trade_builder.js"]) vm.runInContext(read(f), ctx, { filename: f });
  (listeners["fo:ready"] || []).forEach((f) => f());
  return { ctx, calls, opts: (item) => JSON.parse(JSON.stringify(ctx.UPS_FO_TRADE_BUILDER._extensionOptions(item))) };
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
// The view re-renders when the history arrives and again when a probe answers (handle.factsChanged); the fake page does the same by asking again.
const settle = async (h, it) => { h.opts(it); await wait(80); h.opts(it); await wait(700); h.opts(it); };
const keys = (o) => o.map((x) => x.option_key);
const item = (from, to, p) => ({ from, to, token: "P_" + p.id, label: p.name });
const ok = (skipped) => (body) => ({ ok: true, compliance: { extension_skipped: skipped(body), cap: { status: "ok" } } });

test("a valid first extension: history readable, not extended, probe accepted -> options appear (and only then)", async () => {
  const h = harness({ workbench: wb(true), probe: ok(() => []) });
  const it = item("0008", "0010", FIRST);
  t.equal(h.opts(it).length, 0, "nothing before the facts arrive");
  await settle(h, it);
  t.equal(JSON.stringify(keys(h.opts(it))), JSON.stringify(["1YR|NONE", "2YR|NONE"]), "options once history and the probe are in");
  const post = h.calls.filter((c) => c.method === "POST");
  t.equal(post.length, 1, "exactly one probe");
  t.ok(/\/api\/trades\/compliance-preview/.test(post[0].url), "to the read-only compliance preview");
  t.equal(post[0].body.from_franchise_id, "0008"); t.equal(post[0].body.extension_requests.length, 1); t.equal(post[0].body.extension_requests[0].player_id, "16614");
  t.equal(JSON.stringify(post[0].body.movements), JSON.stringify([{ from: "0008", to: "0010", tokens: ["P_16614"] }]), "one movement for the player");
  t.ok(h.calls.filter((c) => c.method === "GET").every((c) => /\/trade-workbench/.test(c.url)), "the only read is /trade-workbench");
});
test("Rico Dowdle: Blake already extended him -> never options, even though the probe is accepted", async () => {
  const h = harness({ workbench: wb(true), probe: ok(() => []) });
  const it = item("0010", "0008", RICO);
  await settle(h, it);
  t.equal(h.calls.filter((c) => c.method === "POST").length, 1, "the server WAS asked (so the empty result is the already-extended fact, not a skipped probe)");
  t.equal(h.opts(it).length, 0, "no 1YR or 2YR");
});
test("extension_history_ok false or missing: no options and no probe is even sent", async () => {
  for (const w of [wb(false), { teams: wb(true).teams }, null]) {
    const h = harness({ workbench: w, probe: ok(() => []) });
    const it = item("0008", "0010", FIRST);
    await settle(h, it);
    t.equal(h.opts(it).length, 0, "no options");
    t.equal(h.calls.filter((c) => c.method === "POST").length, 0, "no probe");
  }
});
test("the worker refuses the probe (acquisition window / deadline / tag...): no options", async () => {
  for (const reason of ["outside_window", "deadline_passed", "authority_unavailable:history"]) {
    const h = harness({ workbench: wb(true), probe: ok((b) => [{ player_id: b.extension_requests[0].player_id, reason }]) });
    const it = item("0008", "0010", FIRST);
    await settle(h, it);
    t.equal(h.calls.filter((c) => c.method === "POST").length, 1, "asked: " + reason);
    t.equal(h.opts(it).length, 0, reason);
  }
});
test("an unreadable or failed probe answer is not a confirmation", async () => {
  for (const probe of [() => null, () => ({ ok: false }), () => ({ compliance: { extension_skipped: [], cap: { status: "ok" } } }), () => ({ ok: "true", compliance: { extension_skipped: [] } }), () => ({ ok: true, compliance: { extension_skipped: [], cap: { reason: "extension_salaries_unavailable" } } })]) {
    const h = harness({ workbench: wb(true), probe });
    const it = item("0008", "0010", FIRST);
    await settle(h, it);
    t.equal(h.opts(it).length, 0);
  }
});
test("a player the viewer is not a party to is not probed (the preview would refuse the caller)", async () => {
  const h = harness({ workbench: wb(true), probe: ok(() => []) });
  const it = item("0010", "0011", RICO);
  await settle(h, it);
  t.equal(h.calls.filter((c) => c.method === "POST").length, 0);
});
test("no write route is ever called: the only POST is the compliance preview", async () => {
  const h = harness({ workbench: wb(true), probe: ok(() => []) });
  await settle(h, item("0008", "0010", FIRST)); await settle(h, item("0010", "0008", RICO));
  t.ok(h.calls.every((c) => c.method === "GET" || /\/api\/trades\/compliance-preview/.test(c.url)), JSON.stringify(h.calls.map((c) => c.method + " " + c.url)));
});
await run("fo_trade_builder_extension_facts");
