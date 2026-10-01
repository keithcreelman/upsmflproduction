// The FULL two-flag truth table for TRADE_2WAY_CUTOVER_ENABLED × TRADE_2WAY_STAGING_ENABLED
// (Keith's ruling, 2026-09-29: "document and test the full two-flag truth table. If cutover is
// on while staging is off, show exactly whether creation refuses or falls back to native MFL;
// it must never silently reopen the bypass."). Four cells, each asserting BOTH creation paths'
// real, observable behavior against the real worker + real D1 + a stateful fake MFL:
//
//   cutover | staging | legacy create (/trade-offers)      | staged create (/api/trades/2way)
//   --------|---------|-------------------------------------|----------------------------------
//   off     | off     | succeeds -- real native MFL trade  | refused (2way_staging_disabled)
//   off     | on      | succeeds -- real native MFL trade  | succeeds -- staged in D1
//   on      | off     | refused (staging_required)         | succeeds -- staged in D1 (SAFETY
//           |         |                                     | INTERLOCK: cutover alone is
//           |         |                                     | sufficient, so a refused legacy
//           |         |                                     | attempt always has somewhere
//           |         |                                     | real to land)
//   on      | on      | refused (staging_required)         | succeeds -- staged in D1
//
// The property under test in EVERY cell where legacy is refused: staged creation is ALWAYS
// reachable in that same cell -- there is no flag combination where an owner is refused by
// BOTH paths (a total outage) or where the legacy path silently still succeeds despite cutover
// being on (the bypass reopening). The "off/on" cell is the pre-cutover testing window
// (staging available as an explicit alternative, direct-MFL still the default) -- this is NOT
// itself the bypass Keith flagged; the bypass was the NORMAL SEND BUTTON staying direct-only
// once cutover should have been on, which cutover (the "on" rows) exists specifically to close.
//   node tests/trade_2way_flag_truth_table.test.mjs
import { t, test, run } from "./fixtures/mini_test.mjs";
import { makeWorkerEnv, makeMfl, callWorker, quiet } from "./fixtures/worker_harness.mjs";
import { THREE_WAY_MIGRATIONS } from "./fixtures/d1_sqlite.mjs";

const restoreConsole = quiet();
const Q = "L=74598&YEAR=2026";
const MIGRATIONS = [...THREE_WAY_MIGRATIONS, "0162_ups_trade_cap_acknowledgments.sql", "0163_ups_trade_conditional_drops.sql", "0164_ups_2way_trades.sql"];

function fresh(flags) {
  const env = makeWorkerEnv({ __migrations: MIGRATIONS, ...flags });
  const mfl = makeMfl();
  mfl.install();
  mfl.st.rosters["0001"] = [{ id: "14056", salary: "5000", contractYear: "1", contractStatus: "Vet-FAA", contractInfo: "CL 1|TCV 5K|AAV 5K|Y1-5K" }];
  mfl.st.rosters["0002"] = [{ id: "13100", salary: "5000", contractYear: "1", contractStatus: "Vet-FAA", contractInfo: "CL 1|TCV 5K|AAV 5K|Y1-5K" }];
  return { env, mfl };
}
const asset = (pid, salary) => ({ asset_id: `player:${pid}`, type: "PLAYER", player_id: String(pid), player_name: `P${pid}`, salary, taxi: false });
const legacyBody = (pidFrom, pidTo) => ({
  league_id: "74598", season: "2026", from_franchise_id: "0001", to_franchise_id: "0002",
  from_franchise_name: "x", to_franchise_name: "y", message: "",
  payload: {
    schema_version: 1, source: "test", league_id: "74598", season: "2026",
    teams: [
      { role: "left", franchise_id: "0001", selected_assets: [asset(pidFrom, 5000)], traded_salary_adjustment_dollars: 0, traded_salary_adjustment_k: 0, selected_non_taxi_salary_dollars: 5000 },
      { role: "right", franchise_id: "0002", selected_assets: [asset(pidTo, 5000)], traded_salary_adjustment_dollars: 0, traded_salary_adjustment_k: 0, selected_non_taxi_salary_dollars: 5000 },
    ],
    extension_requests: [], ui: { left_team_id: "0001", right_team_id: "0002" }, validation: { status: "ready" },
  },
});
const legacyCreate = (env, pidFrom, pidTo) => callWorker(env, "POST", `/trade-offers?${Q}&MFL_USER_ID=tok-B`, { body: legacyBody(pidFrom, pidTo) });
const stagedCreate = (env, pidFrom) => callWorker(env, "POST", `/api/trades/2way?${Q}&MFL_USER_ID=tok-B`, {
  body: { from: { fid: "0001", name: "x" }, to: { fid: "0002", name: "y" }, movements: [{ from: "0001", to: "0002", asset_tokens: [String(pidFrom)] }] },
});

test("CELL cutover=OFF, staging=OFF (today's real production default): legacy succeeds (real MFL trade); staged refuses cleanly", async () => {
  const { env, mfl } = fresh({}); // both unset -> both read as off
  const legacy = await legacyCreate(env, 14056, 13100);
  t.equal(legacy.status, 201, JSON.stringify(legacy.json));
  t.ok(mfl.st.imports.some((i) => i.type === "tradeProposal"));

  const staged = await stagedCreate(env, 14056);
  t.equal(staged.status, 400);
  t.equal(staged.json.code, "2way_staging_disabled");
});

test("CELL cutover=OFF, staging=ON (the pre-cutover testing window, NOT the bypass itself): BOTH paths succeed independently -- legacy still goes real-MFL by default; staged is available as an explicit alternative", async () => {
  const { env, mfl } = fresh({ TRADE_2WAY_STAGING_ENABLED: "1" });
  const legacy = await legacyCreate(env, 14056, 13100);
  t.equal(legacy.status, 201);
  t.ok(mfl.st.imports.some((i) => i.type === "tradeProposal"), "legacy is UNCHANGED by staging being merely available -- it still proposes for real");

  const staged = await stagedCreate(env, 14056);
  t.equal(staged.status, 201, JSON.stringify(staged.json));
  t.ok(staged.json.staged);
});

test("CELL cutover=ON, staging=OFF (the safety-interlock cell): legacy is refused, and staged creation SUCCEEDS anyway -- the refused attempt always has somewhere real to land, never a total outage and never a silent fall-through back to native MFL", async () => {
  const { env, mfl } = fresh({ TRADE_2WAY_CUTOVER_ENABLED: "1" }); // TRADE_2WAY_STAGING_ENABLED deliberately unset
  const legacy = await legacyCreate(env, 14056, 13100);
  t.equal(legacy.status, 409);
  t.equal(legacy.json.code, "staging_required");
  t.equal(mfl.st.imports.length, 0, "the refused legacy attempt made zero MFL writes -- it never silently fell through to a real proposal");

  const staged = await stagedCreate(env, 14056);
  t.equal(staged.status, 201, JSON.stringify(staged.json));
  t.ok(staged.json.staged);
  t.equal(mfl.st.imports.length, 0, "the staged creation that follows is ALSO zero MFL writes -- staging never touches MFL at creation");
});

test("CELL cutover=ON, staging=ON (full cutover, the target end state): legacy refused, staged succeeds -- identical creation behavior to the interlock cell above, confirming the two flags together are no different from cutover alone", async () => {
  const { env, mfl } = fresh({ TRADE_2WAY_CUTOVER_ENABLED: "1", TRADE_2WAY_STAGING_ENABLED: "1" });
  const legacy = await legacyCreate(env, 14056, 13100);
  t.equal(legacy.status, 409);
  t.equal(legacy.json.code, "staging_required");

  const staged = await stagedCreate(env, 14056);
  t.equal(staged.status, 201);
  t.ok(staged.json.staged);
  t.equal(mfl.st.imports.length, 0);
});

test("ACROSS ALL FOUR CELLS: whenever the legacy path is refused, staged creation is reachable in that SAME env -- no flag combination ever refuses both (a silent total outage) or lets legacy quietly still succeed (the bypass reopening)", async () => {
  const grids = [
    { cutover: "0", staging: "0" }, { cutover: "0", staging: "1" },
    { cutover: "1", staging: "0" }, { cutover: "1", staging: "1" },
  ];
  for (const g of grids) {
    const { env } = fresh({ TRADE_2WAY_CUTOVER_ENABLED: g.cutover, TRADE_2WAY_STAGING_ENABLED: g.staging });
    const legacy = await legacyCreate(env, 14056, 13100);
    const legacyRefused = legacy.status === 409 && legacy.json.code === "staging_required";
    t.equal(legacyRefused, g.cutover === "1", `legacy refusal must track cutover ONLY (cutover=${g.cutover}, staging=${g.staging})`);
    if (legacyRefused) {
      const staged = await stagedCreate(env, 14056);
      t.equal(staged.status, 201, `staged creation must succeed whenever legacy is refused (cutover=${g.cutover}, staging=${g.staging}): ${JSON.stringify(staged.json)}`);
    }
  }
});

await run("trade_2way_flag_truth_table");
restoreConsole();
