// The one violation post is delivered exactly once — through crashes, Discord
// errors and overlapping runs — and never silently lost.
//   node tests/lineup_post_delivery.test.mjs
//
// Keith 2026-10-11: replace the permanent "claimed but unsent" mark with a
// time-limited sending lease; store the message id only after Discord
// confirms; on a lapsed lease, inspect the thread for this violation's post
// before retrying; adopt it if it exists, retry if it doesn't; if delivery
// stays uncertain, hold for review and notify the commissioner.
//
// Discord here is an IN-MEMORY FAKE thread. No request leaves the process; no
// real message, mention or notification is ever sent.
import { makeD1, applyMigrations } from "./fixtures/d1_sqlite.mjs";
import { t, test, run } from "./fixtures/mini_test.mjs";
import * as R from "../worker/src/lineup_rulings.js";

const SEASON = 2026, L = "74598", WEEK = 5, FID = "0002";
const THREAD = "1558450448489259128", PARENT = "1550849538229534760", OWNER = "111111111111111111", BOT = "777777777777777777";
const NOW = 1791850800;   // Mon Oct 12 8:20pm ET, just after the final kickoff
const NOTICE = ["🚨 Lineup Violation — Week 5", "", `CBP ${R.MENTION_TOKEN} — 1st violation of the 2026 season`, "", "Why it occurred", "", "• (evidence)", "", "Penalty assessed: Warning only."].join("\n");

// ── the fake Discord thread ────────────────────────────────────────────────
function fakeDiscord(opts = {}) {
  const st = { messages: [], posts: [], gets: 0, mode: opts.mode || "ok", listFail: !!opts.listFail, nonces: new Map(), other: [] };
  globalThis.fetch = async (url, init) => {
    const u = String(url), method = (init && init.method) || "GET";
    const json = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
    if (u.includes("TYPE=nflSchedule")) return json({ nflSchedule: { matchup: [{ kickoff: "1791850500", team: [{ id: "LAR", isHome: "1" }, { id: "BUF" }] }] } });
    if (!u.startsWith("https://discord.com/api/v10/")) { st.other.push(u); return json(null, 404); }
    if (u.endsWith("/users/@me")) return json({ id: BOT, bot: true });
    if (method === "GET" && u.includes(`/channels/${THREAD}/messages`)) {
      st.gets += 1;
      return st.listFail ? json({ message: "Missing Access" }, 403) : json([...st.messages].reverse());
    }
    if (method === "GET" && u.endsWith(`/channels/${THREAD}`)) return json({ id: THREAD, type: 11, name: "Week 5 Injury Report", parent_id: PARENT, thread_metadata: { archived: false, locked: false } });
    if (method === "POST" && u.endsWith(`/channels/${THREAD}/messages`)) {
      const body = JSON.parse(init.body);
      st.posts.push(body);
      if (body.enforce_nonce && st.nonces.has(body.nonce)) return json(st.nonces.get(body.nonce));   // Discord's own dedupe
      const create = () => { const m = { id: String(800000000000000000n + BigInt(st.messages.length + 1)), content: body.content, author: { id: BOT, bot: true } }; st.messages.push(m); st.nonces.set(body.nonce, m); return m; };
      const mode = typeof st.mode === "function" ? st.mode(st.posts.length) : st.mode;
      if (mode === "ok") return json(create());
      if (mode === "500_nocreate") return json({ message: "Internal Server Error" }, 500);
      if (mode === "500_created") { create(); return json({ message: "Internal Server Error" }, 500); }
      if (mode === "403") return json({ code: 50013, message: "Missing Permissions" }, 403);
      if (mode === "network") throw new Error("network down");
    }
    st.other.push(`${method} ${u}`);
    return json(null, 404);
  };
  return st;
}

function env({ failFinalizeOnce = false } = {}) {
  let armed = failFinalizeOnce;
  const d = makeD1({ beforeRun: (sql) => { if (armed && /SET status='posted'/.test(sql)) { armed = false; throw new Error("worker crashed after Discord accepted"); } } });
  applyMigrations(d, ["0093_ups_bot_heartbeat.sql", "0129_lineup_compliance.sql", "0149_lineup_sat_announce_log.sql", "0171_lineup_rulings.sql"]);
  d.raw.prepare("INSERT INTO ups_lineup_sat_announce_log (season, league_id, week, message_id, posted_unix) VALUES (?, ?, ?, ?, 1)").run(SEASON, L, WEEK, THREAD);
  d.raw.exec("CREATE TABLE discord_owners (franchise_id TEXT, active_owner TEXT, discord_user_id TEXT)");
  d.raw.prepare("INSERT INTO discord_owners VALUES (?, 'Y', ?)").run(FID, OWNER);
  d.raw.prepare("INSERT INTO ups_lineup_violations (season, league_id, fid, week, offense_no, reasons_json) VALUES (?, ?, ?, ?, 1, '[]')").run(SEASON, L, FID, WEEK);
  d.raw.prepare(`INSERT INTO ups_lineup_rulings (season, league_id, fid, week, ruling, offense_no, ruled_by, ruled_at_utc, status, notice_text, sanction_status)
    VALUES (?, ?, ?, ?, 'confirmed', 1, ?, 'x', 'ready', ?, 'none')`).run(SEASON, L, FID, WEEK, R.AUTO_RULER, NOTICE);
  return { UPS_MFL_DB: d, DISCORD_BOT_TOKEN: "test", DISCORD_LINEUP_ANNOUNCE_CHANNEL_ID: PARENT };
}
const row = (e) => e.UPS_MFL_DB.raw.prepare("SELECT * FROM ups_lineup_rulings WHERE fid=? AND week=?").get(FID, WEEK);
const alerts = [];
const alertImpl = async (_e, text) => { alerts.push(text); };
const mentions = async () => new Map([[FID, [OWNER]]]);
const post = (e, now) => R.postLineupNotice(e, { season: SEASON, leagueId: L, fid: FID, week: WEEK, resolveMentions: mentions, alertImpl, nowUnix: now });
const LAPSE = R.SEND_LEASE_SEC + 1;

test("normal delivery: one POST, id stored only from Discord's confirmation, deterministic nonce", async () => {
  const e = env(); const dc = fakeDiscord(); alerts.length = 0;
  const r = await post(e, NOW);
  t.equal(r.ok, true); t.equal(dc.posts.length, 1); t.equal(dc.messages.length, 1);
  t.equal(row(e).notice_message_id, dc.messages[0].id); t.equal(row(e).status, "posted");
  t.equal(dc.posts[0].nonce, "lv2026w05f0002"); t.equal(dc.posts[0].enforce_nonce, true);
  t.deepEqual(dc.posts[0].allowed_mentions, { users: [OWNER] });
  t.equal(dc.other.length, 0, "nothing else contacted");
  t.equal((await post(e, NOW + 3600)).error, "already_posted"); t.equal(dc.posts.length, 1);
});

test("crash BEFORE send: the lease lapses; the next run inspects (nothing there) and sends once", async () => {
  const e = env(); const dc = fakeDiscord();
  // A run took the lease and died before calling Discord.
  e.UPS_MFL_DB.raw.prepare("UPDATE ups_lineup_rulings SET notice_claimed_at_utc=?, notice_thread_id=?, notice_error=? WHERE fid=?")
    .run(new Date((NOW - 30) * 1000).toISOString(), THREAD, JSON.stringify({ attempts: 1 }), FID);
  t.equal((await post(e, NOW)).error, "send_in_progress", "a live lease blocks a second sender");
  t.equal(dc.posts.length, 0);
  const r = await post(e, NOW - 30 + LAPSE);
  t.equal(r.ok, true); t.equal(r.adopted, undefined);
  t.ok(dc.gets >= 1, "inspected the thread before retrying");
  t.equal(dc.posts.length, 1); t.equal(dc.messages.length, 1); t.equal(row(e).notice_message_id, dc.messages[0].id);
});

test("crash AFTER Discord accepted but before D1 stored the id: next run ADOPTS the existing post, no repost", async () => {
  const e = env({ failFinalizeOnce: true }); const dc = fakeDiscord();
  let threw = false;
  try { await post(e, NOW); } catch (_) { threw = true; }
  t.equal(threw, true); t.equal(dc.messages.length, 1, "the post landed");
  t.equal(row(e).notice_message_id, null, "but D1 never recorded it");
  t.equal((await post(e, NOW + 60)).error, "send_in_progress");
  const r = await post(e, NOW + LAPSE);
  t.equal(r.ok, true); t.equal(r.adopted, true); t.equal(r.message_id, dc.messages[0].id);
  t.equal(dc.posts.length, 1, "never posted twice"); t.equal(dc.messages.length, 1);
  t.equal(row(e).status, "posted"); t.equal(JSON.parse(row(e).notice_error).last.outcome, "adopted_existing");
});

test("Discord 5xx without creating it: uncertain → lease lapses → inspect (absent) → resend → exactly one post", async () => {
  const e = env(); const dc = fakeDiscord({ mode: (n) => (n === 1 ? "500_nocreate" : "ok") }); alerts.length = 0;
  const a = await post(e, NOW);
  t.equal(a.error, "delivery_uncertain"); t.equal(row(e).notice_message_id, null);
  const b = await post(e, NOW + LAPSE);
  t.equal(b.ok, true); t.equal(dc.messages.length, 1); t.equal(alerts.length, 0);
});

test("Discord 5xx AFTER creating it: the retry finds it and adopts it — one message", async () => {
  const e = env(); const dc = fakeDiscord({ mode: "500_created" });
  await post(e, NOW);
  const r = await post(e, NOW + LAPSE);
  t.equal(r.adopted, true); t.equal(dc.posts.length, 1); t.equal(dc.messages.length, 1);
});

test("network failure is treated as uncertain, then resolved by inspection", async () => {
  const e = env(); const dc = fakeDiscord({ mode: (n) => (n === 1 ? "network" : "ok") });
  t.equal((await post(e, NOW)).error, "delivery_uncertain");
  t.equal((await post(e, NOW + LAPSE)).ok, true); t.equal(dc.messages.length, 1);
});

test("a definite Discord rejection (403): nothing created, held for Keith, alerted once", async () => {
  const e = env(); const dc = fakeDiscord({ mode: "403" }); alerts.length = 0;
  const r = await post(e, NOW);
  t.equal(r.held, true); t.equal(r.reason, "post_rejected_403");
  t.equal(row(e).status, "held"); t.equal(row(e).notice_message_id, null); t.equal(dc.messages.length, 0);
  t.equal(alerts.length, 1);
});

test("delivery still uncertain after the attempt limit → NEEDS REVIEW + alert; nothing more is sent", async () => {
  const e = env(); const dc = fakeDiscord({ mode: "500_nocreate" }); alerts.length = 0;
  let r = null;
  for (let i = 0; i < R.MAX_SEND_ATTEMPTS; i += 1) r = await post(e, NOW + i * LAPSE);
  t.equal(r.needs_review, true); t.equal(r.reason, "delivery_uncertain");
  t.equal(row(e).status, "held"); t.equal(row(e).hold_reason, "delivery_uncertain");
  t.equal(alerts.filter((x) => /NEEDS REVIEW/.test(x)).length, 1);
  const before = dc.posts.length;
  const auto = await R.runLineupAutoPublish({ ...e, LINEUP_AUTO_PUBLISH_ENABLED: "1" }, { season: SEASON, leagueId: L, week: WEEK, nowUnix: NOW + 10 * LAPSE, resolveMentions: mentions, alertImpl });
  t.deepEqual(auto.results.map((x) => [x.fid, x.status, x.reason]), [[FID, "held", "delivery_uncertain"]], "the automatic run sees the hold");
  t.equal(dc.posts.length, before, "and does not keep sending");
  t.equal(alerts.filter((x) => /NEEDS REVIEW/.test(x)).length, 1, "and does not re-alert");
});

test("the thread can't be inspected on a retry → never sends blind; held for review at the limit", async () => {
  const e = env(); const dc = fakeDiscord({ mode: "500_nocreate" }); alerts.length = 0;
  await post(e, NOW);                         // attempt 1: uncertain
  dc.listFail = true;
  t.equal((await post(e, NOW + LAPSE)).error, "inspection_unavailable");     // attempt 2: no send
  t.equal(dc.posts.length, 1);
  const r = await post(e, NOW + 2 * LAPSE);   // attempt 3: limit
  t.equal(r.needs_review, true); t.equal(dc.posts.length, 1); t.equal(alerts.length, 1);
});

test("overlapping runs: exactly one sender, one message", async () => {
  const e = env(); const dc = fakeDiscord();
  const rs = await Promise.all([post(e, NOW), post(e, NOW), post(e, NOW)]);
  t.equal(rs.filter((x) => x.ok).length, 1);
  t.equal(dc.posts.length, 1); t.equal(dc.messages.length, 1);
  t.ok(rs.filter((x) => !x.ok).every((x) => x.error === "send_in_progress" || x.error === "already_posted"));
});

test("Discord's nonce dedupe is a second line of defence if a send repeats inside its window", async () => {
  const e = env(); const dc = fakeDiscord();
  await post(e, NOW);
  // Even if D1 were reset and the same send replayed, Discord returns the original.
  e.UPS_MFL_DB.raw.prepare("UPDATE ups_lineup_rulings SET status='ready', notice_message_id=NULL, notice_claimed_at_utc=NULL WHERE fid=?").run(FID);
  dc.listFail = true;   // and even if inspection were skipped (first attempt path)
  const r = await post(e, NOW + 10);
  t.equal(r.ok, true); t.equal(dc.messages.length, 1, "still one message"); t.equal(r.message_id, dc.messages[0].id);
});

await run("lineup_post_delivery");
