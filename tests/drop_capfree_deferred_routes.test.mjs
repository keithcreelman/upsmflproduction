// A drop whose cap-free RETIREMENT check was skipped (the per-run news-lookup budget, 5, was spent) is DEFERRED — visibly,
// in D1 and in every drop route's response — never charged by /admin/drops/post-mfl until the check completes, and re-routed
// on later recorder ticks, oldest first. Once routed it is auto (§D2a settlement), pending (commish review, money held) or
// none (normal charge), and the normal flow continues exactly once (ledger key + posted_to_mfl).
//   node tests/drop_capfree_deferred_routes.test.mjs
//
// The REAL routes against one D1 built from the REAL migrations (0056 → 0125 → 0127 → 0166) and a stateful fake MFL
// (transactions, injuries, players, league, salaryAdjustments that remember what was imported), fake /api/player-news,
// fake Discord and a fake R2 of daily roster snapshots:
//   /admin/drops/scan-and-record → /admin/drops/capfree-notify → /admin/drops/post-mfl (→ /admin/drops/capfree-decide)
//
// Timeline: Mon 2026-06-15, the offseason (before the 2026 FA Auction), so a drop is charged to the 2026 cap right away.
// Six veterans are cut between 9:00 and 9:05 AM ET and the */5 recorder sees all six in ONE tick. The first five are
// ordinary (CL 2 | TCV 20K | Y1-10K, Y2-10K, cut in the final year: 75% × 20K − 10K paid = $5,000 each). The sixth,
// Rex Retiree, announced his retirement — but MFL's injuries export does not say RETIRED yet (it lags ~6 months), so only
// the news lookup can see it, and the budget is gone by the time the recorder reaches him:
//   Rex: CL 3 | TCV 60K | AAV 20K | Y1-10K, Y2-20K, Y3-30K, cut with 2 years left.
//     §D1 penalty (what origin/main charges): 75% × 60K − 10K paid = $35,000.
//     §D2a settlement if the commish approves the cap-free exit: AAV 20K × 1 year served − 10K paid = $10,000 owed.
import fs from "node:fs";
import { makeD1, applyMigrations } from "./fixtures/d1_sqlite.mjs";
import { t, test, run } from "./fixtures/mini_test.mjs";
await import("./fixtures/register_md_loader.mjs");
const worker = (await import("../worker/src/index.js")).default;

const RealDate = Date;
let NOW = RealDate.parse("2026-06-15T13:10:00Z");
globalThis.Date = class extends RealDate {
  constructor(...a) { super(...(a.length ? a : [NOW])); }
  static now() { return NOW; }
};
const ET = (iso) => Math.floor(RealDate.parse(iso) / 1000);
const TICK1 = RealDate.parse("2026-06-15T13:10:00Z");                  // 9:10 AM ET — sees all six cuts at once
const tick = (n) => (NOW = TICK1 + (n - 1) * 5 * 60 * 1000);           // the */5 cron

// ── the league ──
const PEOPLE = {
  "13001": ["Vet, One", "0001"], "13002": ["Vet, Two", "0002"], "13003": ["Vet, Three", "0003"], "13004": ["Vet, Four", "0004"],
  "13005": ["Vet, Five", "0005"], "13000": ["Retiree, Rex", "0006"],
  "13011": ["Late, Alpha", "0007"], "13012": ["Late, Bravo", "0008"], "13013": ["Late, Charlie", "0009"], "13014": ["Late, Delta", "0010"],
  "13015": ["Late, Echo", "0011"],
};
const ORDINARY = { salary: "10000", status: "ROSTER", contractStatus: "Vet-FAA", contractInfo: "CL 2| TCV 20K| AAV 10K| Y1-10K, Y2-10K", contractYear: "1" };
const REX = { salary: "20000", status: "ROSTER", contractStatus: "Vet-FAA", contractInfo: "CL 3| TCV 60K| AAV 20K| Y1-10K, Y2-20K, Y3-30K", contractYear: "2" };
const contractOf = (pid) => (pid === "13000" ? REX : ORDINARY);
// MFL's transaction log for a scenario: one FREE_AGENT drop per player, a minute apart, in this order.
let TXS = [];
const cuts = (pids, startIso) => pids.map((pid, i) => ({ type: "FREE_AGENT", franchise: PEOPLE[pid][1],
  timestamp: String(ET(startIso) + i * 60), transaction: `|${pid},` }));
// R2 roster snapshot (taken 09:05Z = 5:05 AM ET each day): everyone in TXS is still rostered that morning.
const snapshotFor = () => {
  const fr = {};
  for (const x of TXS) { const pid = x.transaction.replace(/\D/g, ""); (fr[x.franchise] = fr[x.franchise] || []).push({ id: pid, ...contractOf(pid) }); }
  return { rosters: { franchise: Object.entries(fr).map(([id, player]) => ({ id, player })) } };
};
const r2 = { async get(key) {
  const m = /^snapshots\/(\d{4}-\d{2}-\d{2})\/rosters\.json$/.exec(key);
  return m ? { async text() { return JSON.stringify(snapshotFor()); }, uploaded: new RealDate(`${m[1]}T09:05:00.000Z`) } : null;
} };

// ── MFL: injuries (never says RETIRED for Rex unless a test flips it), and a salaryAdjustments ledger that remembers imports ──
let INJURIES = [{ id: "99999", status: "Questionable" }];   // a real, non-empty read (an empty one means "unknown")
const MFL_READS = [];                                       // "<year>:<TYPE>" for every export read
let LEDGER = [];                                            // what MFL holds: { franchise_id, amount, explanation, key }
let IMPORTS = 0;
function mflImport(body) {
  IMPORTS += 1;
  const data = new URLSearchParams(body).get("DATA") || "";
  for (const m of data.matchAll(/<salary_adjustment franchise_id="(\d+)" amount="[^"]*" explanation="([^"]*)"\/>/g)) {
    const expl = m[2];
    const key = (expl.match(/\bid:(\S+)$/) || [])[1];
    const dollars = Number((expl.match(/ (-?\d+) id:/) || [])[1]);
    LEDGER.push({ franchise_id: m[1], amount: dollars, explanation: expl, key });
  }
}
const chargedFor = (pid) => LEDGER.filter((r) => String(r.key || "").startsWith(pid + "_"));

// MFL's nflSchedule (as in drop_held_unpriced_routes): 2026 Week 1 Wed Sep 9, then Thu / Sun / Mon — June is the offseason.
function nflSchedule(w) {
  const ko = (d, h, m) => String(Math.floor(RealDate.UTC(2026, 8, d, h, m) / 1000));
  const thu = w === 1 ? ko(10, 0, 20) : ko(18 + 7 * (w - 2), 0, 15), sun = ko(13 + 7 * (w - 1), 17, 0), mon = ko(15 + 7 * (w - 1), 0, 15);
  return { nflSchedule: { week: String(w), matchup: [{ kickoff: thu, team: [{ id: "KCC" }, { id: "BAL" }] }, { kickoff: sun, team: [{ id: "BUF" }, { id: "MIA" }] }, { kickoff: mon, team: [{ id: "NYG" }, { id: "DAL" }] }] } };
}
const liveWeek = () => { let w = 1; for (let k = 1; k <= 18; k++) if (Number(nflSchedule(k).nflSchedule.matchup[0].kickoff) * 1000 <= NOW) w = k; return w; };

// ── /api/player-news (the cap-free routing's slow path) ──
const NEWS_ITEMS = { "13000": [{ source: "ESPN", headline: "Rex Retiree announces his retirement after eight seasons", body: "", url: "https://www.espn.com/nfl/story/rex-retiree-retires" }] };
let NEWS = { up: true, calls: [] };
function playerNews(u) {
  const pids = (u.searchParams.get("pids") || "").split(",").filter(Boolean);
  NEWS.calls.push(pids.join(","));
  if (!NEWS.up) return json({ error: "MFL DETAILS fetch failed: boom" }, 502);
  return json({ items_by_pid: Object.fromEntries(pids.map((p) => [p, NEWS_ITEMS[p] || []])) });
}

// ── Discord ──
const DISCORD = { posts: [] };   // { path, content }
const json = (o, s) => new Response(JSON.stringify(o), { status: s || 200, headers: { "content-type": "application/json" } });
globalThis.fetch = async (input, init) => {
  const u = new URL(typeof input === "string" ? input : input.url);
  if (u.hostname === "discord.com") {
    if (/\/users\/@me\/channels$/.test(u.pathname)) return json({ id: "dm1" });
    if ((init?.method || "GET") === "POST" && /\/messages$/.test(u.pathname)) {
      DISCORD.posts.push({ path: u.pathname, content: String(JSON.parse(init.body || "{}").content || "") });
      return json({ id: "msg" + DISCORD.posts.length });
    }
    return json({ id: "thr" + RealDate.now() });
  }
  if (/myfantasyleague\.com$/.test(u.hostname)) {
    if (/\/import$/.test(u.pathname)) { mflImport(String(init?.body || "")); return new Response("<status>OK</status>", { status: 200 }); }
    const type = u.searchParams.get("TYPE");
    const year = (u.pathname.match(/\/(\d{4})\//) || [])[1];
    if (type) MFL_READS.push(year + ":" + type);
    if (year === "2027") return json({ error: "No league 2027" }, 500);   // MFL creates next year's league at its rollover
    if (type === "transactions") {
      const tt = u.searchParams.get("TRANS_TYPE");
      return json({ transactions: { transaction: TXS.filter((x) => Number(x.timestamp) * 1000 <= NOW && (!tt || x.type === tt)) } });
    }
    if (type === "players") return json({ players: { player: Object.entries(PEOPLE).map(([id, [name]]) => ({ id, name, position: "WR", team: "KCC" })) } });
    // (the commissioner cookie sees owners' e-mail addresses — what post-mfl's admin check looks for)
    if (type === "league") return json({ league: { franchises: { franchise: Array.from({ length: 12 }, (_, i) => String(i + 1).padStart(4, "0")).map((id) => ({ id, name: "Team " + id, email: id + "@ups.test" })) } } });
    if (type === "injuries") return json({ injuries: { injury: INJURIES } });
    if (type === "salaryAdjustments") return json({ salaryAdjustments: { salaryAdjustment: LEDGER.map((r) => ({ franchise_id: r.franchise_id, amount: String(r.amount), description: r.explanation })) } });
    if (type === "nflSchedule") return json(nflSchedule(Number(u.searchParams.get("W"))));
    if (type === "liveScoring") return json({ liveScoring: { week: String(liveWeek()) } });
    return json({ error: "test: no such export " + type }, 503);
  }
  if (u.pathname === "/api/player-news") return playerNews(u);
  return json({ error: "test: no such call " + u.hostname + u.pathname }, 503);
};

// ── a fresh league per scenario ──
function freshLeague(pids, extraEnv) {
  TXS = cuts(pids, "2026-06-15T09:00:00-04:00");
  INJURIES = [{ id: "99999", status: "Questionable" }];
  LEDGER = []; IMPORTS = 0; NEWS = { up: true, calls: [] }; DISCORD.posts = [];
  tick(1);
  const db = makeD1({});
  applyMigrations(db, ["0056_ups_drop_events.sql", "0125_drop_events_cap_season.sql", "0127_drop_events_capfree_review.sql", "0166_drop_events_pricing_audit.sql"]);
  const subCols = "id INTEGER, league_id TEXT, season TEXT, franchise_id TEXT, player_id TEXT, new_contract_status TEXT, new_salary INTEGER, new_contract_year INTEGER, new_contract_info TEXT, submitted_at_utc TEXT, dry_run INTEGER";
  db.raw.exec(`CREATE TABLE ups_extension_submissions (${subCols}); CREATE TABLE ups_mym_submissions (${subCols}); CREATE TABLE ups_restructure_submissions (${subCols}, voided_at_utc TEXT);`);
  db.raw.exec("CREATE TABLE ups_taxi_callups (player_id TEXT, pending INTEGER)");
  const env = { UPS_MFL_DB: db, UPS_MFL_BACKUPS: r2, COMMISH_API_KEY: "admin", MFL_COOKIE: "COMMISH", MFL_APIKEY: "k",
    FA_AUCTION_START_AT: String(ET("2026-07-25T12:00:00-04:00")), DISCORD_BOT_TOKEN: "bot", DISCORD_DROPS_CHANNEL_ID: "888",
    COMMISH_DISCORD_USER_ID: "123456789012345678", ...(extraEnv || {}) };
  const call = async (method, path, body) => {
    const res = await worker.fetch(new Request("https://w.test" + path, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }),
      env, { waitUntil() {}, passThroughOnException() {} });
    const text = await res.text();
    let j = null; try { j = JSON.parse(text); } catch (_) {}
    return { status: res.status, json: j, text };
  };
  const Q = "?L=74598&YEAR=2026&APIKEY=admin";
  const B = { season: "2026", league_id: "74598" };
  return {
    db, env,
    scan: (extra) => call("POST", "/admin/drops/scan-and-record" + Q, { ...B, days: 7, ...(extra || {}) }),
    notify: () => call("POST", "/admin/drops/capfree-notify" + Q, B),
    postMfl: () => call("POST", "/admin/drops/post-mfl" + Q, { ...B, limit: 20 }),
    decide: (pid, decision) => call("POST", "/admin/drops/capfree-decide" + Q, { ...B, player_id: pid, decision }),
    row: (pid) => ({ ...db.raw.prepare("SELECT * FROM ups_drop_events WHERE player_id = ?").get(pid) }),
  };
}
const FIVE = ["13001", "13002", "13003", "13004", "13005"];
const announcements = () => DISCORD.posts.filter((p) => p.path.endsWith("/channels/888/messages"));
const dms = () => DISCORD.posts.filter((p) => p.path.endsWith("/channels/dm1/messages"));

// ═════════ (a) the over-budget drop is a retiree only the news can see ═════════
test("a1. tick 1: six cuts, budget five — Rex (6th) is DEFERRED: marked in D1 and listed in the scan's response", async () => {
  const L = freshLeague([...FIVE, "13000"]);
  const s = await L.scan();
  t.equal(s.status, 200, s.text.slice(0, 300));
  t.equal(s.json.written_count, 6);
  t.deepEqual(NEWS.calls, FIVE, "the five news lookups went to the first five cuts");
  const rex = L.row("13000");
  t.equal(rex.penalty_amount, 35000, "the §D1 penalty: 75% × 60K − 10K paid");
  t.equal(rex.capfree_review_status, "deferred");
  t.equal(rex.capfree_route, "deferred_budget");
  for (const pid of FIVE) {
    t.equal(L.row(pid).capfree_review_status, null, pid + " routed: nothing held");
    t.equal(L.row(pid).capfree_route, "none", pid + " — its check ran and found nothing (no longer indistinguishable from 'never checked')");
  }
  t.equal(s.json.capfree_deferred_count, 1);
  t.deepEqual(s.json.capfree_deferred.map((d) => [d.pid, d.capfree_route]), [["13000", "deferred_budget"]]);
  // the */5 cron says so out loud every tick (the same alert shape as a HELD unpriced drop)
  const src = fs.readFileSync(new URL("../worker/src/index.js", import.meta.url), "utf8");
  t.match(src, /const cfDeferredN = Number\(scanData\?\.capfree_deferred_count\) \|\| 0;\s*if \(cfDeferredN\) \{\s*console\.error\(`\[scheduled \*\/5\] drop-tracker: \$\{cfDeferredN\} drop\(s\) DEFERRED/);
});

async function tickOne() {
  const L = freshLeague([...FIVE, "13000"]);
  await L.scan();
  return L;
}
test("a2. tick 1, post-mfl: the five ordinary cuts are charged $5,000 each; Rex is NOT charged his $35,000 — held, and listed", async () => {
  const L = await tickOne();
  const n = await L.notify();
  t.equal(n.json.pending_total, 0, "a deferred row is not 'pending' — no announcement");
  t.equal(DISCORD.posts.length, 0, "no Discord post and no commish DM for a deferred row");
  const m = await L.postMfl();
  t.equal(m.status, 200, m.text.slice(0, 300));
  t.deepEqual(chargedFor("13000"), [], "Rex charged: " + JSON.stringify(chargedFor("13000")));
  t.equal(L.row("13000").posted_to_mfl, 0);
  t.deepEqual(FIVE.map((pid) => chargedFor(pid).map((r) => r.amount)), FIVE.map(() => [5000]));
  t.deepEqual((m.json.held_capfree_deferred || []).map((h) => [h.player_id, h.amount]), [["13000", 35000]], "post-mfl lists the hold");
  t.match(m.json.message || "", /1 drop\(s\) are DEFERRED/);
});

test("a3. tick 2: Rex is re-routed first (news: retired, MFL: not flagged) → PENDING; announced once with the source; the commish is DM'd once", async () => {
  const L = await tickOne();
  await L.notify(); await L.postMfl();
  tick(2);
  NEWS.calls = [];
  const s = await L.scan();
  t.deepEqual(NEWS.calls, ["13000"], "one news lookup this tick — Rex's");
  t.deepEqual(s.json.capfree_rerouted.map((r) => [r.pid, r.capfree_route, r.capfree_review_status]), [["13000", "pending", "pending"]]);
  t.equal(s.json.capfree_deferred_count, 0);
  const rex = L.row("13000");
  t.equal(rex.capfree_review_status, "pending"); t.equal(rex.capfree_route, "pending");
  t.equal(rex.penalty_amount, 35000, "pending leaves the §D1 amount alone — the commish decides");
  t.match(rex.capfree_evidence_json, /announces his retirement/);
  t.match(rex.notes, /\[capfree-rerouted\]/);
  const n = await L.notify();
  t.equal(announcements().length, 1); t.match(announcements()[0].content, /CAP FREE CUT CONFIRMATION PENDING COMMISH APPROVAL[\s\S]*Rex Retiree[\s\S]*espn\.com/);
  t.equal(dms().length, 1); t.match(dms()[0].content, /Rex Retiree[\s\S]*approve → \$10,000 owed, deny → \$35,000/);
  await L.notify();
  t.equal(announcements().length, 1, "announced once"); t.equal(dms().length, 1, "nudged once (the next is 24h out)");
  const m = await L.postMfl();
  t.deepEqual(chargedFor("13000"), [], "still not charged while pending");
  t.equal(m.json.held_pending_capfree_review, 1);
  t.equal(n.json.pending_total, 1);
});

test("a4. the commish approves → the §D2a $10,000 settlement replaces the $35,000; charged EXACTLY once; nothing re-routes it again", async () => {
  const L = await tickOne();
  await L.postMfl();
  tick(2); await L.scan(); await L.notify();
  const d = await L.decide("13000", "approve");
  t.equal(d.status, 200, d.text.slice(0, 300)); t.equal(d.json.penalty_after, 10000);
  const m = await L.postMfl();
  t.deepEqual(chargedFor("13000").map((r) => r.amount), [10000]);
  t.equal(L.row("13000").posted_to_mfl, 1); t.equal(L.row("13000").posted_amount, 10000);
  tick(3);
  const s = await L.scan();
  t.deepEqual(s.json.capfree_rerouted, [], "an approved row is never re-routed");
  await L.postMfl();
  t.deepEqual(chargedFor("13000").map((r) => r.amount), [10000], "never twice");
  t.equal(m.json.posted, 1);
  t.equal(LEDGER.length, 6, "five ordinary cuts + Rex's settlement, each once");
});

test("a5. …or MFL flags him RETIRED before tick 2 → AUTO via the fast path (no news lookup): $10,000 settlement, charged once", async () => {
  const L = await tickOne();
  await L.postMfl();
  INJURIES = [{ id: "13000", status: "Retired" }, { id: "99999", status: "Questionable" }];
  tick(2); NEWS.calls = [];
  const s = await L.scan();
  t.deepEqual(NEWS.calls, [], "the MFL designation answered — no budget spent");
  t.deepEqual(s.json.capfree_rerouted.map((r) => [r.pid, r.capfree_route, r.capfree_review_status]), [["13000", "auto", "approved"]]);
  const rex = L.row("13000");
  t.equal(rex.penalty_amount, 10000); t.equal(rex.penalty_basis, "retired_capfree_d2a_settlement"); t.equal(rex.capfree_decided_by, "auto:mfl_retired_flag");
  await L.notify();
  t.equal(DISCORD.posts.length, 0, "auto needs no commish");
  await L.postMfl(); await L.postMfl();
  t.deepEqual(chargedFor("13000").map((r) => r.amount), [10000]);
});

// ═════════ (b) a deferred row whose news shows nothing ═════════
test("b. the 6th cut is an ordinary vet: deferred on tick 1, re-routed to NONE on tick 2, then charged $5,000 exactly once", async () => {
  const L = freshLeague([...FIVE, "13011"]);
  await L.scan();
  t.equal(L.row("13011").capfree_review_status, "deferred");
  await L.postMfl();
  t.deepEqual(chargedFor("13011"), [], "not charged while deferred");
  tick(2);
  const s = await L.scan();
  t.deepEqual(s.json.capfree_rerouted.map((r) => [r.pid, r.capfree_route, r.capfree_review_status]), [["13011", "none", null]]);
  t.equal(L.row("13011").capfree_review_status, null); t.equal(L.row("13011").capfree_route, "none");
  t.equal(L.row("13011").penalty_amount, 5000, "the amount is untouched");
  await L.notify();
  t.equal(DISCORD.posts.length, 0, "nothing to ask the commish");
  const m = await L.postMfl();
  t.equal(m.json.posted, 1);
  t.deepEqual(chargedFor("13011").map((r) => r.amount), [5000]);
  tick(3); await L.scan(); await L.postMfl(); await L.postMfl();
  t.deepEqual(chargedFor("13011").map((r) => r.amount), [5000], "exactly once");
  t.equal(L.row("13011").posted_to_mfl, 1);
});

// ═════════ (c) the news endpoint is unreadable during the re-route ═════════
test("c. news unreadable on tick 2: Rex STAYS deferred (reason recorded), is never charged, and is listed; tick 3 recovers → pending", async () => {
  const L = await tickOne();
  await L.postMfl();
  tick(2); NEWS.up = false;
  const s = await L.scan();
  t.equal(s.json.capfree_rerouted.length, 0);
  t.deepEqual(s.json.capfree_deferred.map((d) => [d.pid, d.capfree_route]), [["13000", "deferred_news_unreadable"]]);
  t.match(s.json.capfree_deferred[0].reason, /player-news HTTP 502/);
  t.equal(L.row("13000").capfree_review_status, "deferred"); t.equal(L.row("13000").capfree_route, "deferred_news_unreadable");
  await L.notify();
  t.equal(DISCORD.posts.length, 0, "no false commish DM");
  const m = await L.postMfl();
  t.deepEqual(chargedFor("13000"), [], "never charged on an unreadable check");
  t.deepEqual((m.json.held_capfree_deferred || []).map((h) => h.player_id), ["13000"]);
  tick(3); NEWS.up = true;
  const s3 = await L.scan();
  t.deepEqual(s3.json.capfree_rerouted.map((r) => [r.pid, r.capfree_route]), [["13000", "pending"]]);
  await L.postMfl();
  t.deepEqual(chargedFor("13000"), []);
});

// ═════════ priority: deferred re-routes run BEFORE new drops ═════════
test("d. tick 2 brings five NEW cuts: Rex (oldest, deferred) is re-routed first; the newest new cut is deferred behind him", async () => {
  const L = freshLeague([...FIVE, "13000"]);
  await L.scan();
  TXS = TXS.concat(cuts(["13011", "13012", "13013", "13014", "13015"], "2026-06-15T09:11:00-04:00"));
  tick(4);   // 9:25 AM ET: the five new cuts landed 9:11–9:15
  NEWS.calls = [];
  const s = await L.scan();
  t.equal(s.json.written_count, 5);
  t.deepEqual(NEWS.calls, ["13000", "13011", "13012", "13013", "13014"], "oldest first: the deferred row, then the new cuts in order");
  t.deepEqual(s.json.capfree_rerouted.map((r) => r.pid), ["13000"]);
  t.deepEqual(s.json.capfree_deferred.map((d) => [d.pid, d.capfree_route]), [["13015", "deferred_budget"]]);
  t.equal(L.row("13000").capfree_review_status, "pending");
  t.equal(L.row("13015").capfree_review_status, "deferred");
  tick(5); NEWS.calls = [];
  const s5 = await L.scan();
  t.deepEqual(NEWS.calls, ["13015"]); t.deepEqual(s5.json.capfree_rerouted.map((r) => [r.pid, r.capfree_route]), [["13015", "none"]]);
});

// ═════════ the commish can rule on a deferred row; a dry run never re-routes ═════════
test("e. a commish ruling on a deferred row wins (never re-routed over); a dry-run scan lists deferred rows and makes no news call", async () => {
  const L = await tickOne();
  tick(2); NEWS.calls = [];
  const dry = await L.scan({ dry_run: true });
  t.deepEqual(NEWS.calls, [], "dry run: no lookup");
  t.deepEqual(dry.json.capfree_deferred.map((d) => [d.pid, d.reason]), [["13000", "dry_run_not_rerouted"]]);
  t.equal(L.row("13000").capfree_review_status, "deferred", "dry run wrote nothing");
  const d = await L.decide("13000", "deny");
  t.equal(d.status, 200, d.text.slice(0, 300));
  t.equal(L.row("13000").capfree_review_status, "denied");
  const s = await L.scan();
  t.deepEqual(s.json.capfree_rerouted, []); t.deepEqual(s.json.capfree_deferred, []);
  t.equal(L.row("13000").capfree_review_status, "denied", "not re-routed over the ruling");
  await L.postMfl();
  t.deepEqual(chargedFor("13000").map((r) => r.amount), [35000], "denied → the §D1 penalty, once");
});

// ═════════ a deferred row from LAST season, re-routed after Jan 1 ═════════
test("g. Jan 2 2027 (no 2027 league yet): the 2026 deferred row is still re-routed — before the failing 2027 pull, on 2026's designations", async () => {
  const L = await tickOne();
  INJURIES = [{ id: "13000", status: "Retired" }, { id: "99999", status: "Questionable" }];
  NOW = RealDate.parse("2027-01-02T17:00:00Z");
  const r0 = MFL_READS.length;
  const s = await L.scan({ season: "2027" });
  t.equal(s.status, 502, "the 2027 new-drop pull fails — MFL has not created 2027");
  t.deepEqual(s.json.capfree_rerouted.map((r) => [r.season, r.pid, r.capfree_route]), [["2026", "13000", "auto"]], "reported by the refused run too");
  t.equal(L.row("13000").penalty_amount, 10000, "the §D2a settlement");
  const reads = MFL_READS.slice(r0);
  t.ok(reads.includes("2026:injuries") && !reads.includes("2027:injuries"), reads.join(" "));
});

await run("drop_capfree_deferred_routes");

globalThis.Date = RealDate;
