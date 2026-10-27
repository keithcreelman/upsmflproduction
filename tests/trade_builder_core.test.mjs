// Trade Builder core (read-only): draft -> compliance-preview request, and how the server verdict is shown.
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const C = require("../site/shared/trade_builder_core.js");
const ctx = { leagueId: "74598", season: "2026", viewerFid: "0003" };

function twoTeam() {
  let d = C.emptyDraft(["0003", "0007"]);
  d = C.addItem(d, { from: "0003", to: "0007", token: "P_1234", label: "WR One", salary: 21000 });
  d = C.addItem(d, { from: "0003", to: "0007", token: "P_9", label: "Taxi guy", salary: 5000, taxi: true });
  d = C.addItem(d, { from: "0007", to: "0003", token: "FP_0003_2027_1", label: "2027 1st" });
  return d;
}

test("movements group by pair and carry cap money", () => {
  let d = C.setCapK(twoTeam(), "0003", "0007", 4);
  const ms = C.movements(d);
  assert.deepEqual(ms.find((m) => m.from === "0003").tokens, ["P_1234", "P_9"]);
  assert.equal(ms.find((m) => m.from === "0003").cap_k, 4);
  assert.equal(ms.find((m) => m.from === "0007").cap_k, 0);
  assert.deepEqual(C.parties(d), ["0003", "0007"]);
});

test("request has the shape the compliance-preview route reads", () => {
  const r = C.request(twoTeam(), ctx);
  assert.deepEqual(Object.keys(r).sort(), ["extension_requests", "from_franchise_id", "league_id", "movements", "season"]);
  assert.equal(r.from_franchise_id, "0003");
  assert.ok(r.movements.every((m) => /^\d{4}$/.test(m.from) && /^\d{4}$/.test(m.to) && Array.isArray(m.tokens)));
});

test("cap-money hint is 50% of NON-TAXI player salary, rounded down", () => {
  assert.equal(C.capMoneyHintK(twoTeam(), "0003"), 10); // 21000 only, taxi 5000 excluded
  assert.equal(C.capMoneyHintK(twoTeam(), "0007"), 0);  // picks carry no salary
});

test("gaps: empty, cap money alone, one team, unknown token, three teams", () => {
  assert.equal(C.gaps(C.emptyDraft(["0003", "0007"]))[0].code, "no_assets");
  const moneyOnly = C.setCapK(C.emptyDraft(["0003", "0007"]), "0003", "0007", 3);
  assert.equal(C.gaps(moneyOnly)[0].code, "no_assets");
  assert.equal(C.signature(moneyOnly, ctx) !== "", true);
  assert.deepEqual(C.gaps(twoTeam()), []);
  const bad = C.addItem(C.emptyDraft(["0003", "0007"]), { from: "0003", to: "0007", token: "XX_1" });
  assert.equal(C.gaps(bad)[0].code, "unknown_asset");
});

test("three-team ring is accepted structurally; a fourth team is refused", () => {
  let d = C.emptyDraft(["0003", "0007", "0011"]);
  d = C.addItem(d, { from: "0003", to: "0007", token: "P_1" });
  d = C.addItem(d, { from: "0007", to: "0011", token: "P_2" });
  d = C.addItem(d, { from: "0011", to: "0003", token: "P_3" });
  assert.deepEqual(C.gaps(d), []);
  assert.equal(C.parties(d).length, 3);
  d = C.addItem(d, { from: "0011", to: "0015", token: "P_4" });
  assert.equal(C.gaps(d).some((g) => g.code === "too_many_teams"), true);
});

test("removing a team drops its assets and cap money", () => {
  let d = C.setCapK(twoTeam(), "0003", "0007", 4);
  d = C.withTeams(d, ["0003"]);
  assert.equal(d.items.length, 0);
  assert.deepEqual(d.capK, {});
});

test("signature ignores token order and padding; changes with cap money", () => {
  const a = C.signature(twoTeam(), ctx);
  let d = C.emptyDraft(["0003", "0007"]);
  d = C.addItem(d, { from: "0007", to: "0003", token: "FP_0003_2027_1" });
  d = C.addItem(d, { from: "0003", to: "0007", token: "P_9" });
  d = C.addItem(d, { from: "0003", to: "0007", token: "P_1234" });
  assert.equal(C.signature(d, ctx), a);
  assert.notEqual(C.signature(C.setCapK(d, "0003", "0007", 2), ctx), a);
  assert.equal(C.signature(C.emptyDraft(["0003", "0007"]), ctx), "");
});

test("readiness: never sendable, every server status maps, failures never read as a pass", () => {
  const prov = { ok: true, verdict: { status: "provisional", send_ready: false, checks: {}, reasons: [], trade_lock: { state: "upcoming", label: "Wed, Nov 25, 8:00 PM ET" } } };
  const r = C.readiness([], "done", prov);
  assert.equal(r.state, "provisional");
  assert.equal(r.canSend, false);
  assert.match(r.lock.text, /Nov 25, 8:00 PM ET/);
  // even a verdict that (wrongly) claims send_ready stays unsendable here
  assert.equal(C.readiness([], "done", { ok: true, verdict: { status: "provisional", send_ready: true } }).canSend, false);
  const blocked = C.readiness([], "done", { ok: true, verdict: { status: "blocked", reasons: [{ code: "loaded_contract_limit", message: "x" }, { code: "pick_forfeited" }], trade_lock: { state: "closed", label: "Wed" } } });
  assert.equal(blocked.state, "blocked");
  assert.match(blocked.reasons[0].text, /five loaded contracts/);
  assert.match(blocked.lock.text, /closed/);
  assert.equal(C.readiness([], "done", { ok: true, verdict: { status: "needs_acknowledgment", reasons: [] } }).state, "needs_ack");
  for (const bad of [null, {}, { ok: false }, { ok: true }, { ok: true, verdict: "x" }]) assert.equal(C.readiness([], "done", bad).state, "unavailable");
  assert.equal(C.readiness([], "checking").state, "checking");
  assert.equal(C.readiness([{ code: "no_assets", message: "m" }], "done", prov).state, "draft");
});

test("lock view: unresolved or missing never shows a time", () => {
  for (const l of [null, { state: "unresolved" }, { state: "upcoming" }]) {
    const v = C.lockView(l); assert.equal(v.tone, "warn"); assert.match(v.text, /could not be confirmed/);
  }
  assert.equal(C.lockView({ state: "none" }).tone, "ok");
});
