// handle3WayButton's own per-franchise drop-first HOLD (§8.6, Keith's ruling 2026-09-30):
// "Refuse to RECORD this team's own consent while THEY (specifically -- not the other two)
// have an unresolved 2-way drop-first sequence." Built and reviewed by inspection in the same
// pass that closed the legacy-2way + 3-way-create/execute hold gaps (worker/src/trade_3way.js,
// mirrors accept2WayTrade's exact placement) -- but its own Discord-interaction fixture
// ecosystem (tests/fixtures/trade_3way_fixture.mjs) is genuinely separate from
// tests/trade_2way_drop_first_execute.test.mjs's harness, and was never independently exercised.
// This is that test, following the exact "real worker + real D1 + Discord press()" pattern
// extension_eligibility.test.mjs's own "WORKER (3-way)" section already established.
//   node tests/trade_3way_button_hold.test.mjs
import { t, test, run } from "./fixtures/mini_test.mjs";
import { makeWorkerEnv, makeMfl, bindSelf, quiet } from "./fixtures/worker_harness.mjs";
import { THREE_WAY_MIGRATIONS } from "./fixtures/d1_sqlite.mjs";
import * as F from "./fixtures/trade_3way_fixture.mjs";
await import("./fixtures/register_md_loader.mjs");
const { handle3WayButton } = await import("../worker/src/trade_3way.js");

const restore = quiet();
// franchiseHasUnresolvedDropSequence's own query JOINs ups_trade_executions against
// ups_2way_trades (the drop-first orchestrator only ever runs against a STAGED 2-way trade) --
// that table is not part of THREE_WAY_MIGRATIONS, and its absence is deliberately read as a
// provable "no unresolved sequence" (trade_execution.js's own no-such-table branch), so it must
// be applied here for the "found" cases below to actually exercise the real JOIN, not the
// table-missing fallback.
const MIGRATIONS = [...THREE_WAY_MIGRATIONS, "0164_ups_2way_trades.sql"];

function world() {
  const env = makeWorkerEnv({ __migrations: MIGRATIONS, TRADE_3WAY_EXECUTE: "0" });
  const mfl = makeMfl({ tokens: { "tok-H": "0012" } });
  mfl.install();
  bindSelf(env);
  for (const [fid, d] of [["0008", F.DISCORD.A], ["0001", F.DISCORD.B], ["0012", F.DISCORD.C]]) {
    env.UPS_MFL_DB.raw.prepare("INSERT INTO discord_owners VALUES (?,?,?)").run(fid, "Y", d);
  }
  F.seedTrade(env);
  mfl.st.rosters = {
    "0008": [{ id: "16614", salary: 5000 }, { id: "16193", salary: 5000 }],
    "0001": [{ id: "16181", salary: 5000 }, { id: "16650", salary: 5000 }],
    "0012": [{ id: "16650", salary: 5000 }],
  };
  return { env, mfl };
}
const press = (u) => ({ data: { custom_id: `tr3:accept:${F.TRADE_ID}` }, member: { user: { id: u } } });
const say = async (r) => (await r.json()).data.content;

// Mirrors seedCrashedAttempt from tests/trade_2way_drop_first_execute.test.mjs -- the exact shape
// franchiseHasUnresolvedDropSequence itself queries. Its own SQL JOINs ups_trade_executions
// against ups_2way_trades (from_fid/to_fid) -- it does NOT read the ledger's own `participants`
// column -- so a realistic stuck row needs a companion ups_2way_trades row naming this franchise
// as one of its two sides, exactly as the real drop-first orchestrator always has one.
function seedStuckDropFirst(env, fid, state) {
  const id = `stuck-${fid}`;
  const now = new Date().toISOString();
  env.UPS_MFL_DB.raw.prepare(
    `INSERT INTO ups_2way_trades (id, league_id, season, status, from_fid, to_fid, movements_json, to_state, created_at_utc, updated_at_utc)
     VALUES (?, '74598', '2026', 'collecting', ?, '0099', '[]', 'pending', ?, ?)`
  ).run(id, fid, now, now);
  env.UPS_MFL_DB.raw.prepare(
    `INSERT INTO ups_trade_executions (league_id, season, exec_key, kind, state, participants, created_at_utc, updated_at_utc)
     VALUES ('74598', '2026', ?, 'two_way_staged_drop_first', ?, ?, ?, ?)`
  ).run(id, state, fid, now, now);
}

test("CONTROL: with no unresolved drop-first sequence anywhere, an ordinary accept is recorded exactly as before", async () => {
  const { env } = world();
  const msg = await say(await handle3WayButton(press(F.DISCORD.B), env, { waitUntil() {} }));
  t.match(msg, /You're in/);
  t.equal(F.readRow(env).team_b_state, "accepted");
});

test("HELD: the RESPONDING team's own unresolved drop-first sequence (partial_executed) refuses the accept -- not recorded, nothing changes", async () => {
  const { env } = world();
  seedStuckDropFirst(env, "0001", "partial_executed"); // team B (0001) is the one pressing the button
  const msg = await say(await handle3WayButton(press(F.DISCORD.B), env, { waitUntil() {} }));
  t.match(msg, /another deal still being untangled by the commissioner/);
  t.equal(F.readRow(env).team_b_state, "pending", "the accept must NOT have been recorded");
  t.equal(F.readRow(env).status, "collecting");
});

test("HELD: the RESPONDING team's own unresolved drop-first sequence (executed_needs_review) ALSO refuses the accept", async () => {
  const { env } = world();
  seedStuckDropFirst(env, "0001", "executed_needs_review");
  const msg = await say(await handle3WayButton(press(F.DISCORD.B), env, { waitUntil() {} }));
  t.match(msg, /another deal still being untangled by the commissioner/);
  t.equal(F.readRow(env).team_b_state, "pending");
});

// Keith's correction (2026-09-30, second pass): "Check every participant before 3-way acceptance
// and execution. Your test says a different participant's unresolved drop sequence does not
// block acceptance. If that participant is part of the proposed trade, it must block; an
// unrelated franchise should not. Test both cases." The ORIGINAL version of this test asserted
// the WRONG thing (that team A's own stuck sequence never blocks team B's accept) -- the button's
// hold check now covers all three of THIS trade's own participants, mirroring create3WayTrade's
// and execute3Way's own identical [A, B, C] loop exactly.
test("HELD: a DIFFERENT PARTICIPANT of THIS SAME trade (the initiator, team A) having an unresolved sequence ALSO blocks team B's own accept -- not just team B's own state", async () => {
  const { env } = world();
  seedStuckDropFirst(env, "0008", "executed_needs_review"); // the INITIATOR (team A) -- one of this trade's own three teams
  const msg = await say(await handle3WayButton(press(F.DISCORD.B), env, { waitUntil() {} }));
  t.match(msg, /another deal still being untangled by the commissioner/, "team A is part of THIS trade -- its own unresolved sequence must block team B's accept too");
  t.equal(F.readRow(env).team_b_state, "pending", "must NOT have been recorded");
});

test("HELD: the THIRD participant (team C, not yet responding) having an unresolved sequence ALSO blocks team B's own accept", async () => {
  const { env } = world();
  seedStuckDropFirst(env, "0012", "partial_executed"); // team C -- the OTHER partner, not the one pressing the button
  const msg = await say(await handle3WayButton(press(F.DISCORD.B), env, { waitUntil() {} }));
  t.match(msg, /another deal still being untangled by the commissioner/);
  t.equal(F.readRow(env).team_b_state, "pending");
});

test("NOT HELD: a genuinely UNRELATED franchise (not one of this trade's own three teams) having an unresolved sequence does NOT block team B's own accept", async () => {
  const { env } = world();
  seedStuckDropFirst(env, F.FR.OTHER, "executed_needs_review"); // 0003 -- not the initiator, not team B, not team C
  const msg = await say(await handle3WayButton(press(F.DISCORD.B), env, { waitUntil() {} }));
  t.match(msg, /You're in/, "an unrelated franchise's own trouble must never block a trade it isn't part of");
  t.equal(F.readRow(env).team_b_state, "accepted");
});

test("RESOLVED: once the responding team's sequence reaches a terminal state (completed), the hold clears and a later accept attempt goes through normally", async () => {
  const { env } = world();
  seedStuckDropFirst(env, "0001", "completed");
  const msg = await say(await handle3WayButton(press(F.DISCORD.B), env, { waitUntil() {} }));
  t.match(msg, /You're in/);
  t.equal(F.readRow(env).team_b_state, "accepted");
});

await run("trade_3way_button_hold");
restore();
