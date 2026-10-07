// A trade is never "completed" while its promised taxi move is unconfirmed.
//   node tests/trade_taxi_step_honest.test.mjs
//
// 2026-10-06, MFL trade #1249 (Gride ↔ Blake Bombers), accepted in the War Room by Blake Bombers:
//   * MFL put Matthew Golden — on Blake Bombers' taxi squad — on Gride's ACTIVE roster (MFL never carries taxi
//     status through a trade), leaving Gride at 32 active, maximum 30.
//   * The after-trade taxi step asked MFL, as the commissioner acting for Gride, to demote him. Lockout (on all
//     season) refuses that; the step then re-sent WITHOUT FRANCHISE_ID, MFL said OK and moved nobody, and roster
//     verification failed. The step was "best-effort", so the trade was recorded `completed` and nobody was told.
//   * The accept preview had counted Golden as taxi ($0, not active), so it showed Gride at 31 and understated
//     Gride's cap by his $5,000.
// The same shape here: the OFFERING team (0001) receives a player from the accepting team's (0002) taxi squad.
// Real worker routes, real SQLite, MFL + Discord faked at the network edge. No real roster write anywhere.
import { t, test, run } from "./fixtures/mini_test.mjs";
import { makeWorkerEnv, makeMfl, callWorker, quiet, ADMIN_KEY } from "./fixtures/worker_harness.mjs";

const restore = quiet();
const Q = "L=74598&YEAR=2026";
const COMMISH = "621530026831118346";
const OWNER_0001 = "111111111111111111";
const CONTRACT = { contractYear: "2", contractStatus: "Rookie-Draft", contractInfo: "CL 3|TCV 15K|AAV 5K|Y1-5K, Y2-5K, Y3-5K" };
const asset = (pid, taxi) => ({ asset_id: `P_${pid}`, type: "PLAYER", player_id: String(pid), player_name: `P${pid}`, salary: 5000, taxi: !!taxi, contract_info: CONTRACT.contractInfo });
const payload = () => ({
  schema_version: 1, source: "test", league_id: "74598", season: "2026",
  teams: [{ role: "left", franchise_id: "0001", selected_assets: [asset(14056, false)], traded_salary_adjustment_k: 0, traded_salary_adjustment_dollars: 0 },
    { role: "right", franchise_id: "0002", selected_assets: [asset(13100, true)], traded_salary_adjustment_k: 0, traded_salary_adjustment_dollars: 0 }],
  extension_requests: [], ui: { left_team_id: "0001", right_team_id: "0002" }, validation: { status: "ready" },
});

// mode: "lockout" (MFL's real answer all season) | "ok_no_move" (MFL says OK, nothing moves) | "moves" (it lands)
function fresh(mode) {
  const env = makeWorkerEnv({ COMMISH_DISCORD_USER_ID: COMMISH });
  env.UPS_MFL_DB.raw.prepare("INSERT INTO discord_owners (franchise_id, active_owner, discord_user_id) VALUES ('0001','Y',?)").run(OWNER_0001);
  const mfl = makeMfl();
  mfl.st.league = { rosterSize: "30" };
  mfl.st.rosters = { "0001": [{ id: "14056", salary: 5000, status: "ROSTER", ...CONTRACT }], "0002": [{ id: "13100", salary: 5000, status: "TAXI_SQUAD", ...CONTRACT }] };
  mfl.st.salaries = [{ id: "14056", salary: "5000", ...CONTRACT }, { id: "13100", salary: "5000", ...CONTRACT }];
  mfl.install();
  const taxiImports = [];
  const inner = globalThis.fetch;
  globalThis.fetch = async (u, i) => {
    const url = new URL(String(u));
    const body = new URLSearchParams(i && typeof i.body === "string" && !i.body.startsWith("{") ? i.body : "");
    for (const [k, v] of url.searchParams) if (!body.has(k)) body.set(k, v);
    const isImport = /\/import$/.test(url.pathname) && !(url.hostname === "api.myfantasyleague.com" && i && i.redirect === "manual");
    if (isImport && body.get("TYPE") === "taxi_squad") {
      taxiImports.push(Object.fromEntries(body));
      if (mode === "lockout") return new Response('<?xml version="1.0" encoding="utf-8"?>\n<error>Can not impersonate another fracnhise when LOCKOUT is on.</error>', { status: 200 });
      if (mode === "moves") {
        const fid = body.get("FRANCHISE_ID");
        for (const pid of String(body.get("DEMOTE") || "").split(",").filter(Boolean)) {
          const p = (mfl.st.rosters[fid] || []).find((x) => typeof x === "object" && x.id === pid);
          if (p) p.status = "TAXI_SQUAD";
        }
      }
      return new Response('<?xml version="1.0" encoding="utf-8"?>\n<status>OK</status>', { status: 200 });
    }
    const res = await inner(u, i);
    // MFL executes the trade: every player lands on the receiver's ACTIVE roster.
    if (isImport && body.get("TYPE") === "tradeResponse" && /accept/i.test(body.get("RESPONSE") || "") && mfl.st.done.length) {
      const a = mfl.st.rosters["0001"].find((x) => x.id === "14056"), b = mfl.st.rosters["0002"].find((x) => x.id === "13100");
      if (a && b) {
        mfl.st.rosters["0001"] = [{ ...b, status: "ROSTER" }];
        mfl.st.rosters["0002"] = [{ ...a, status: "ROSTER" }];
      }
    }
    return res;
  };
  return { env, mfl, taxiImports };
}
async function sendAndAccept(env, mfl) {
  const s = await callWorker(env, "POST", `/api/trades/proposals?${Q}&MFL_USER_ID=tok-B`, { body: { league_id: "74598", season: "2026", from_franchise_id: "0001", to_franchise_id: "0002", message: "", payload: payload() } });
  t.ok(s.status < 300, `offer sent ${s.status} ${s.text.slice(0, 160)}`);
  const id = mfl.st.pending[mfl.st.pending.length - 1].trade_id;
  const r = await callWorker(env, "POST", `/api/trades/proposals/action?${Q}&MFL_USER_ID=tok-C`, { body: { action: "ACCEPT", trade_id: id, league_id: "74598", franchise_id: "0002", year: "2026", message: "" } });
  return { id, r };
}
const led = (env, id) => env.UPS_MFL_DB.raw.prepare("SELECT * FROM ups_trade_executions WHERE exec_key=?").get(String(id));
const alerts = (mfl) => mfl.st.discord.filter((d) => /\/messages$/.test(d.url) && d.body && /🚕/.test(String(d.body.content || "")));
const retry = (env, id) => callWorker(env, "POST", `/admin/trade/postprocess-retry?${Q}&APIKEY=${ADMIN_KEY}`, { body: { id } });

test("lockout ON (the real state): the taxi move is refused → executed_needs_review, never `completed`, and it says what it costs", async () => {
  const { env, mfl, taxiImports } = fresh("lockout");
  const { id, r } = await sendAndAccept(env, mfl);
  t.equal(r.status, 200, r.text.slice(0, 300));
  t.equal(r.json.executed, true, "the trade DID execute — that is never reported as a failure");
  t.equal(r.json.needs_review, true); t.equal(r.json.failed_step, "taxi"); t.equal(r.json.execution_state, "executed_needs_review");
  t.match(r.json.message, /P13100|player 13100|Test P13100|13100/);
  t.match(r.json.message, /ACTIVE roster, not the taxi squad/);
  t.match(r.json.message, /lockout/);
  t.match(r.json.message, /counts as an active player \(L\.A\. Looks: 1 active, maximum 30\)/);
  t.match(r.json.message, /\$5,000 of salary counts against L\.A\. Looks's cap/);
  const row = led(env, id);
  t.equal(row.state, "executed_needs_review"); t.equal(row.failed_step, "taxi");
  t.equal(JSON.parse(row.steps_json).taxi.ok, false);
  t.ok(taxiImports.length >= 1, "the move was attempted");
  t.ok(taxiImports.every((x) => x.FRANCHISE_ID === "0001"), "every attempt named the receiving team — no retry without FRANCHISE_ID");
});

test("failure notification: the commissioner AND the receiving team's owner get ONE DM; a retry or repeat accept never re-sends", async () => {
  const { env, mfl } = fresh("lockout");
  const { id } = await sendAndAccept(env, mfl);
  const first = alerts(mfl);
  t.equal(first.length, 2, JSON.stringify(mfl.st.discord.map((d) => d.url)));
  const recipients = mfl.st.discord.filter((d) => /users\/@me\/channels/.test(d.url) && d.body).map((d) => d.body.recipient_id);
  t.ok(recipients.includes(COMMISH) && recipients.includes(OWNER_0001), recipients.join(","));
  t.match(first[0].body.content, new RegExp(`Trade #${id}`));
  const again = await retry(env, id);
  t.ok(again.status === 200 || again.status === 409, again.text.slice(0, 200));
  t.equal(led(env, id).state, "executed_needs_review", "still unconfirmed → still needs review");
  t.equal(alerts(mfl).length, 2, "no second alert");
  t.ok(JSON.parse(led(env, id).steps_json).taxi.notified_at);
});

test("MFL answers OK but moves nobody → NOT confirmed → executed_needs_review (the roster export decides, never MFL's OK)", async () => {
  const { env, mfl } = fresh("ok_no_move");
  const { id, r } = await sendAndAccept(env, mfl);
  t.equal(r.json.needs_review, true); t.equal(r.json.failed_step, "taxi");
  t.match(r.json.message, /MFL didn't confirm the move/);
  t.equal(led(env, id).state, "executed_needs_review");
  t.equal(alerts(mfl).length, 2);
});

test("when the move really lands, the trade completes and nobody is alerted", async () => {
  const { env, mfl } = fresh("moves");
  const { id, r } = await sendAndAccept(env, mfl);
  t.equal(r.json.needs_review, false, r.text.slice(0, 300)); t.equal(r.json.execution_state, "completed");
  t.equal(led(env, id).state, "completed");
  t.equal(alerts(mfl).length, 0);
});

test("the owner moves him himself → a retry confirms it FROM MFL without sending anything → completed", async () => {
  const { env, mfl, taxiImports } = fresh("lockout");
  const { id } = await sendAndAccept(env, mfl);
  const sent = taxiImports.length;
  mfl.st.rosters["0001"].find((x) => x.id === "13100").status = "TAXI_SQUAD";      // Gride's 10-07 fix, by the owner
  const r = await retry(env, id);
  t.equal(r.status, 200, r.text.slice(0, 200)); t.equal(r.json.state, "completed");
  t.equal(taxiImports.length, sent, "nothing re-sent: he was already on the taxi squad");
  t.equal(led(env, id).state, "completed");
});

test("the accept-time numbers count him as ACTIVE and at full salary — never assumed onto taxi", async () => {
  const { env, mfl } = fresh("lockout");
  const { r } = await sendAndAccept(env, mfl);
  const c = r.json.compliance;
  t.ok(c && c.cap && c.roster, JSON.stringify(c).slice(0, 200));
  const capRow = c.cap.rows.find((x) => x.franchise_id === "0001");
  t.equal(capRow.used_after, 5000, "his $5,000 is on the receiver's cap (the old code said $0)");
  const roRow = c.roster.rows.find((x) => x.franchise_id === "0001");
  t.equal(roRow.active_after, 1, "one out, one in: he is an active arrival");
  t.equal(JSON.stringify(roRow.taxi_arrivals), JSON.stringify(["13100"]));
});

await run("trade_taxi_step_honest");
restore();
