// Migration 0166: every change to how a drop is PRICED is audited at the
// database, whoever makes it — and nothing the worker relies on changes.
//   node tests/drop_events_pricing_audit.test.mjs
//
// Real SQLite (node:sqlite), real migrations 0056 → 0125 → 0127 → 0166.
// Data: Colbie Young's actual drop row (ups_drop_events id 96) and the
// correction applied 2026-10-06.
import { makeD1, applyMigrations } from "./fixtures/d1_sqlite.mjs";
import { t, test, run } from "./fixtures/mini_test.mjs";

function db() {
  const d = makeD1({});
  applyMigrations(d, ["0056_ups_drop_events.sql", "0125_drop_events_cap_season.sql", "0127_drop_events_capfree_review.sql", "0166_drop_events_pricing_audit.sql"]);
  d.raw.prepare(`INSERT INTO ups_drop_events (id, season, league_id, player_id, player_name, franchise_id, dropped_at_unix, dropped_at_iso,
      pre_drop_contract_status, pre_drop_salary, pre_drop_contract_year, pre_drop_contract_length, pre_drop_contract_info, pre_drop_tcv,
      pre_drop_years_remaining, earned_to_date, guaranteed_amount, penalty_amount, penalty_basis, penalty_exempt, penalty_exempt_reason,
      ledger_key, source, detected_at_utc, snapshot_source)
    VALUES (96, '2026', '74598', '17542', 'Colbie Young', '0003', 1788781910, '2026-09-07T11:51:50.000Z',
      'Rookie-FAA', 1000, 1, 1, 'CL 1| TCV 1K| AAV 1K', 3000, 3, 0, NULL, 1000, 'tcv_under_5k_flat', 1, '1-year original contract under $5K (§D2).',
      '17542_1788781910', 'transactions_poll', '2026-09-08T00:00:37.065Z', '2026-09-06')`).run();
  return d;
}
const audits = (d) => d.raw.prepare("SELECT * FROM ups_contract_gate_audit WHERE field = 'ups_drop_events_pricing_change' ORDER BY id").all();

test("a pricing change — here the 2026-10-06 correction itself — is recorded with full before/after", async () => {
  const d = db();
  const r = await d.prepare(`UPDATE ups_drop_events SET pre_drop_contract_year = 3, pre_drop_contract_length = 3,
      pre_drop_contract_info = 'CL 3|TCV 3K|AAV 1K|Y1-1K, Y2-1K, Y3-1K|GTD: 1K', earned_to_date = NULL, guaranteed_amount = 1000,
      penalty_basis = 'full_year_1k_contract', penalty_exempt = 0, penalty_exempt_reason = '', snapshot_source = 'ups_extension_submissions:727'
    WHERE id = 96`).run();
  t.equal(r.meta.changes, 1, "D1 still reports ONE changed row (trigger writes are not counted)");
  const a = audits(d);
  t.equal(a.length, 1);
  t.equal(a[0].actor, "d1_trigger"); t.equal(a[0].season, "2026");
  t.equal(a[0].note, "drop_event_id=96 player=17542 franchise=0003");
  const before = JSON.parse(a[0].before_val), after = JSON.parse(a[0].after_val);
  t.equal(before.pre_drop_contract_info, "CL 1| TCV 1K| AAV 1K"); t.equal(after.pre_drop_contract_info, "CL 3|TCV 3K|AAV 1K|Y1-1K, Y2-1K, Y3-1K|GTD: 1K");
  t.equal(before.penalty_exempt, 1); t.equal(after.penalty_exempt, 0);
  t.equal(before.earned_to_date, 0); t.equal(after.earned_to_date, null, "NULL survives as null, not 0");
  t.equal(after.snapshot_source, "ups_extension_submissions:727");
});

test("bookkeeping updates (Discord, MFL posting, cap season) are not logged", async () => {
  const d = db();
  await d.prepare("UPDATE ups_drop_events SET discord_posted = 1, discord_message_id = '1546671641340420108' WHERE id = 96").run();
  await d.prepare("UPDATE ups_drop_events SET posted_to_mfl = 1, posted_amount = penalty_amount, posted_at_utc = 'x' WHERE id = 96").run();
  await d.prepare("UPDATE ups_drop_events SET applies_to_season = 2027, cap_season_source = 'auction_calendar.faa_open_at' WHERE id = 96").run();
  t.equal(audits(d).length, 0);
});

test("a no-op write of the same pricing values is not logged", async () => {
  const d = db();
  await d.prepare("UPDATE ups_drop_events SET penalty_amount = 1000, penalty_basis = 'tcv_under_5k_flat' WHERE id = 96").run();
  t.equal(audits(d).length, 0);
});

test("the worker's `INSERT … WHERE changes() = 1` audit idiom still sees the UPDATE, not the trigger", async () => {
  const d = db();
  d.raw.exec("UPDATE ups_drop_events SET penalty_amount = 0 WHERE id = 96");
  d.raw.exec("INSERT INTO ups_contract_gate_audit (at_utc, season, field, actor) SELECT 'now', '2026', 'route_audit', 'route' WHERE changes() = 1");
  const rows = d.raw.prepare("SELECT field FROM ups_contract_gate_audit ORDER BY id").all().map((r) => r.field);
  t.equal(JSON.stringify(rows), JSON.stringify(["ups_drop_events_pricing_change", "route_audit"]), "both the trigger's row and the route's own row");
  d.raw.exec("UPDATE ups_drop_events SET penalty_amount = 0 WHERE id = 999");   // touches nothing
  d.raw.exec("INSERT INTO ups_contract_gate_audit (at_utc, season, field, actor) SELECT 'now', '2026', 'route_audit_2', 'route' WHERE changes() = 1");
  t.ok(!d.raw.prepare("SELECT 1 FROM ups_contract_gate_audit WHERE field = 'route_audit_2'").get(), "a no-match UPDATE still reads changes() = 0");
});

test("re-applying the migration is harmless", () => {
  const d = db();
  applyMigrations(d, ["0166_drop_events_pricing_audit.sql"]);
  const n = d.raw.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type = 'trigger' AND name = 'trg_ups_drop_events_pricing_audit'").get().n;
  t.equal(n, 1);
});

await run("drop_events_pricing_audit");
