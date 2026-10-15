// Rookie-draft pick route (POST /api/pick): who may submit a pick, and how many times it can reach MFL and Discord.
// The REAL worker under Node, real SQLite as D1, and a recording network edge (MFL + Discord); nothing leaves the process.
//   node tests/draft_pick_route_authz.test.mjs
//
// Protections proven here:
//   * a pick (or a rehearsal, or a muted pick) needs a proven caller: the signed-in owner of the team, or the commissioner;
//     the check runs before ANY MFL or Discord call
//   * the route acts on the configured league only
//   * rehearsing (dry_run) and muting the announcement (silence_discord) are commissioner-only
//   * each pick slot reaches MFL and Discord at most once (a claim is recorded first); if the claim can't be recorded,
//     nothing is sent (fail closed)
//   * a preview (simulate) stays open to signed-out viewers and never writes or posts
import fs from "node:fs";
import vm from "node:vm";
import { DatabaseSync } from "node:sqlite";
import { t, test, run } from "./fixtures/mini_test.mjs";
import { makeWorkerEnv, makeMfl, callWorker, quiet, ADMIN_KEY } from "./fixtures/worker_harness.mjs";
import { PICK_CLAIM_DDL, pickClaimKey, discordPostNotSent } from "../worker/src/draft_pick_claim.js";

const restoreConsole = quiet();

const TEST_CH = "111", LIVE_PARENT = "222", LIVE_CH = "333";

// The harness MFL + Discord, with every outbound call recorded and MFL's live_draft endpoint modelled:
// edge.answer() decides its reply ({ status, body } or { throw }), edge.gate (a promise) holds it open.
function fresh(over) {
  over = over || {};
  const env = makeWorkerEnv({ DISCORD_DRAFT_TEST_CHANNEL_ID: TEST_CH, DISCORD_PICKS_THREAD_PARENT_CHANNEL_ID: LIVE_PARENT, DISCORD_DRAFT_CHANNEL_ID: LIVE_CH, ...(over.env || {}) });
  const mfl = makeMfl(over.mfl);
  mfl.install();
  const inner = globalThis.fetch;
  const calls = [];
  const edge = { liveDraft: [], answer: null, gate: null };
  globalThis.fetch = async (input, init) => {
    const u = new URL(String((input && input.url) || input));
    calls.push({ host: u.hostname, path: u.pathname, method: ((init && init.method) || "GET").toUpperCase() });
    if (/myfantasyleague\.com$/.test(u.hostname) && /\/live_draft$/.test(u.pathname)) {
      edge.liveDraft.push(Object.fromEntries(u.searchParams));
      if (edge.gate) await edge.gate;
      const a = edge.answer ? edge.answer() : { status: 200, body: { status: "OK" } };
      if (a.throw) throw new Error(a.throw);
      return new Response(JSON.stringify(a.body), { status: a.status, headers: { "content-type": "application/json" } });
    }
    return inner(input, init);
  };
  const discordCalls = () => calls.filter((c) => c.host === "discord.com");
  const mflCalls = () => calls.filter((c) => /myfantasyleague\.com$/.test(c.host));
  const posts = () => mfl.st.discord.filter((d) => d.method === "POST" && /\/messages$/.test(d.url));
  const claims = () => { try { return env.UPS_MFL_DB.raw.prepare("SELECT * FROM ups_draft_pick_claims ORDER BY claim_key").all(); } catch (_) { return []; } };
  return { env, mfl, edge, calls, discordCalls, mflCalls, posts, claims };
}

const Q = "L=74598&YEAR=2026";
const pick = (extra) => ({ franchise_id: "0001", player_id: "16650", simulate: false, ...(extra || {}) });   // 0001 is on the clock at 1.04
const send = (w, query, body) => callWorker(w.env, "POST", `/api/pick?${query}`, { body });
const nothingSent = (w, label) => {
  t.equal(w.edge.liveDraft.length, 0, `${label}: no MFL pick request`);
  t.equal(w.discordCalls().length, 0, `${label}: no Discord call`);
};

// ════════════════════════════ caller required ════════════════════════════
test("signed out: a pick is refused (401) before any MFL or Discord call", async () => {
  const w = fresh();
  const r = await send(w, Q, pick());
  t.equal(r.status, 401); t.equal(r.json.code, "unauthenticated");
  nothingSent(w, "signed out");
  t.equal(w.mflCalls().length, 0, "not even an MFL read");
  t.equal(w.claims().length, 0);
});

test("signed out: a rehearsal, a muted pick, or a preview carrying either switch is refused (401); nothing reaches MFL or Discord", async () => {
  const w = fresh();
  for (const extra of [{ dry_run: true }, { silence_discord: true }, { dryrun: true }, { silenceDiscord: true },
    { simulate: true, dry_run: true }, { simulate: true, silence_discord: true }]) {
    const r = await send(w, Q, pick(extra));
    t.equal(r.status, 401, JSON.stringify(extra));
  }
  nothingSent(w, "switches while signed out");
  t.equal(w.mflCalls().length, 0);
});

test("signed out: a preview (simulate) still answers, and never writes to MFL or posts", async () => {
  const w = fresh();
  const r = await send(w, Q, pick({ simulate: true }));
  t.equal(r.status, 200); t.equal(r.json.simulated, true);
  t.equal(r.json.slot, "R1.04");
  const noFlag = await send(w, Q, { franchise_id: "0001", player_id: "16650" });   // simulate defaults to a preview
  t.equal(noFlag.status, 200); t.equal(noFlag.json.simulated, true);
  nothingSent(w, "preview");
  t.equal(w.claims().length, 0);
});

test("an MFL session that can't be verified fails closed (401 / 503) with nothing sent", async () => {
  const bad = fresh();
  const r1 = await send(bad, `${Q}&MFL_USER_ID=tok-bogus`, pick());
  t.equal(r1.status, 401);
  nothingSent(bad, "unknown session");
  const down = fresh({ mfl: { myleaguesDown: true } });
  const r2 = await send(down, `${Q}&MFL_USER_ID=tok-B`, pick());
  t.equal(r2.status, 503); t.equal(r2.json.code, "identity_unavailable");
  nothingSent(down, "identity outage");
});

// ════════════════════════════ league ════════════════════════════
test("another league is refused (403) before any MFL or Discord call, signed in or not", async () => {
  const w = fresh();
  const cases = [
    [`L=99999&YEAR=2026&MFL_USER_ID=tok-x`, pick()],                  // a real session in that other league
    [`L=99999&YEAR=2026`, pick({ simulate: true })],                   // even a preview
    [`L=99999&YEAR=2026&APIKEY=${ADMIN_KEY}`, pick()],                 // even the admin key
    [`${Q}&MFL_USER_ID=tok-B`, pick({ league_id: "99999" })],          // the body naming another league
  ];
  for (const [q, b] of cases) {
    const r = await send(w, q, b);
    t.equal(r.status, 403, q); t.equal(r.json.code, "wrong_league", q);
  }
  t.equal(w.mflCalls().length, 0, "no MFL call of any kind");
  nothingSent(w, "other league");
});

test("a session that belongs to a different league can't pick in this one (403)", async () => {
  const w = fresh();
  const r = await send(w, `${Q}&MFL_USER_ID=tok-x`, pick());
  t.equal(r.status, 403);
  nothingSent(w, "foreign session");
  t.equal(w.claims().length, 0);
});

// ════════════════════════════ whose pick ════════════════════════════
test("a signed-in owner of a different team is refused (403); nothing written or posted", async () => {
  const w = fresh();
  for (const extra of [{}, { dry_run: true }, { silence_discord: true }]) {
    const r = await send(w, `${Q}&MFL_USER_ID=tok-C`, pick(extra));    // tok-C is 0002; the pick is 0001's
    t.equal(r.status, 403, JSON.stringify(extra));
  }
  nothingSent(w, "other owner");
  t.equal(w.claims().length, 0);
});

test("the signed-in owner of the team on the clock submits: MFL gets one pick for that slot and Discord one announcement", async () => {
  const w = fresh();
  const r = await send(w, `${Q}&MFL_USER_ID=tok-B`, pick());
  t.equal(r.status, 200, r.text.slice(0, 300)); t.equal(r.json.ok, true); t.equal(r.json.discord_posted, true);
  t.equal(w.edge.liveDraft.length, 1);
  const ld = w.edge.liveDraft[0];
  t.equal(ld.L, "74598"); t.equal(ld.FRANCHISE_PICK, "0001"); t.equal(ld.ROUND, "1"); t.equal(ld.PICK, "4"); t.equal(ld.PLAYER_PICK, "16650");
  t.equal(w.posts().length, 1, "exactly one announcement");
  t.ok(!w.posts()[0].url.includes(`/channels/${TEST_CH}/`), "into the live picks thread, not the test channel");
  const rows = w.claims();
  t.equal(rows.length, 1); t.equal(rows[0].claim_key, "live:R1.04"); t.equal(rows[0].state, "done"); t.equal(rows[0].actor, "owner:0001");
});

test("the commissioner (session or admin key) can submit for the team on the clock", async () => {
  for (const [q, actor] of [[`${Q}&MFL_USER_ID=tok-commish`, "commish:0000"], [`${Q}&MFL_USER_ID=tok-A`, "commish:0008"], [`${Q}&APIKEY=${ADMIN_KEY}`, "admin"]]) {
    const w = fresh();
    const r = await send(w, q, pick());
    t.equal(r.status, 200, `${actor}: ${r.text.slice(0, 200)}`);
    t.equal(w.edge.liveDraft.length, 1); t.equal(w.edge.liveDraft[0].FRANCHISE_PICK, "0001");
    t.equal(w.posts().length, 1);
    t.equal(w.claims()[0].actor, actor);
  }
});

// ════════════════════════════ commissioner switches ════════════════════════════
test("an owner can't rehearse or mute a pick (403, nothing sent); the commissioner can", async () => {
  const w = fresh();
  for (const extra of [{ dry_run: true }, { silence_discord: true }, { dry_run: true, silence_discord: true }]) {
    const r = await send(w, `${Q}&MFL_USER_ID=tok-B`, pick(extra));
    t.equal(r.status, 403, JSON.stringify(extra)); t.match(r.json.error, /commissioner/);
  }
  nothingSent(w, "owner switches");
  t.equal(w.claims().length, 0);

  const rehearse = await send(w, `${Q}&MFL_USER_ID=tok-commish`, pick({ dry_run: true }));
  t.equal(rehearse.status, 200); t.equal(rehearse.json.dry_run, true);
  t.equal(w.edge.liveDraft.length, 0, "a rehearsal never reaches MFL");
  t.equal(w.posts().length, 1); t.ok(w.posts()[0].url.includes(`/channels/${TEST_CH}/`), "the rehearsal posts to the test channel");

  const muted = await send(w, `${Q}&MFL_USER_ID=tok-commish`, pick({ silence_discord: true }));
  t.equal(muted.status, 200); t.equal(muted.json.discord_silenced, true);
  t.equal(w.edge.liveDraft.length, 1);
  t.equal(w.posts().length, 1, "the muted pick added no announcement");
});

// ════════════════════════════ once per slot ════════════════════════════
test("the same pick sent twice reaches MFL once and is announced once", async () => {
  const w = fresh();   // (MFL's draft results stay unchanged between the two, as a short edge cache would serve them)
  const a = await send(w, `${Q}&MFL_USER_ID=tok-B`, pick());
  const b = await send(w, `${Q}&MFL_USER_ID=tok-B`, pick());
  const c = await send(w, `${Q}&MFL_USER_ID=tok-commish`, pick({ player_id: "16193" }));   // the commissioner, a different player, same slot
  t.equal(a.status, 200);
  t.equal(b.status, 409); t.equal(b.json.code, "pick_already_submitted");
  t.equal(c.status, 409);
  t.equal(w.edge.liveDraft.length, 1);
  t.equal(w.posts().length, 1);
});

test("two simultaneous submissions of one slot: one reaches MFL, one announcement", async () => {
  const w = fresh();
  let open; w.edge.gate = new Promise((r) => { open = r; });
  const first = send(w, `${Q}&MFL_USER_ID=tok-B`, pick());
  for (let i = 0; i < 50 && !w.edge.liveDraft.length; i++) await new Promise((r) => setTimeout(r, 0));
  t.equal(w.edge.liveDraft.length, 1, "the first request is inside MFL");
  // (raced against a timer so a route that lets the second request through to MFL fails here instead of hanging)
  const secondP = send(w, `${Q}&MFL_USER_ID=tok-commish`, pick());
  const second = await Promise.race([secondP, new Promise((r) => setTimeout(() => r({ status: "still waiting on MFL" }), 2000))]);
  open();
  await secondP;
  t.equal(second.status, 409, "refused while the first is in flight");
  t.equal((await first).status, 200);
  t.equal(w.edge.liveDraft.length, 1);
  t.equal(w.posts().length, 1);
});

test("a rehearsal of one slot posts to the test channel once", async () => {
  const w = fresh();
  const a = await send(w, `${Q}&MFL_USER_ID=tok-commish`, pick({ dry_run: true }));
  const b = await send(w, `${Q}&MFL_USER_ID=tok-commish`, pick({ dry_run: true }));
  t.equal(a.status, 200); t.equal(b.status, 409);
  t.equal(w.posts().length, 1);
  t.equal(w.edge.liveDraft.length, 0);
  // and a rehearsal never blocks the real pick for that slot
  const live = await send(w, `${Q}&MFL_USER_ID=tok-B`, pick());
  t.equal(live.status, 200); t.equal(w.edge.liveDraft.length, 1); t.equal(w.posts().length, 2);
});

test("claim store unavailable: 503, nothing sent to MFL or Discord", async () => {
  const w = fresh();
  w.env.UPS_MFL_DB.opts.beforeRun = (sql) => { if (/ups_draft_pick_claims/.test(sql)) throw new Error("D1_ERROR: simulated outage"); };
  const r = await send(w, `${Q}&MFL_USER_ID=tok-B`, pick());
  t.equal(r.status, 503); t.equal(r.json.code, "pick_claim_unavailable");
  const d = await send(w, `${Q}&MFL_USER_ID=tok-commish`, pick({ dry_run: true }));
  t.equal(d.status, 503);
  nothingSent(w, "claim outage");

  const noDb = fresh({ env: { UPS_MFL_DB: undefined, TWB_OUTBOX_DB: undefined } });
  const r2 = await send(noDb, `${Q}&MFL_USER_ID=tok-B`, pick());
  t.equal(r2.status, 503); t.equal(r2.json.code, "pick_claim_unavailable");
  nothingSent(noDb, "no D1 binding");
});

test("MFL refuses the pick: nothing drafted, the slot is released, and a corrected retry is announced once", async () => {
  const w = fresh();
  w.edge.answer = () => ({ status: 200, body: { error: { $t: "Player is not available." } } });
  const a = await send(w, `${Q}&MFL_USER_ID=tok-B`, pick());
  t.equal(a.status, 502); t.equal(w.posts().length, 0);
  t.equal(w.claims()[0].state, "released");
  w.edge.answer = null;
  const b = await send(w, `${Q}&MFL_USER_ID=tok-B`, pick({ player_id: "16193" }));
  t.equal(b.status, 200);
  t.equal(w.edge.liveDraft.length, 2); t.equal(w.edge.liveDraft[1].PLAYER_PICK, "16193");
  t.equal(w.posts().length, 1);
  t.equal(w.claims()[0].state, "done"); t.equal(w.claims()[0].player_id, "16193");
});

test("no clear answer from MFL holds the slot: never resent from here and never announced", async () => {
  for (const answer of [() => ({ throw: "connection reset" }), () => ({ status: 503, body: { message: "unavailable" } })]) {
    const w = fresh();
    w.edge.answer = answer;
    const a = await send(w, `${Q}&MFL_USER_ID=tok-B`, pick());
    t.equal(a.status, 502);
    t.equal(w.claims()[0].state, "mfl_unknown");
    w.edge.answer = null;
    const b = await send(w, `${Q}&MFL_USER_ID=tok-commish`, pick());
    t.equal(b.status, 409);
    t.equal(w.edge.liveDraft.length, 1);
    t.equal(w.posts().length, 0);
  }
});

test("an announcement Discord rejects is recorded and the pick is never resent", async () => {
  const w = fresh();
  const inner = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const u = new URL(String((input && input.url) || input));
    if (u.hostname === "discord.com" && /\/messages$/.test(u.pathname)) return new Response("{}", { status: 500 });
    return inner(input, init);
  };
  const a = await send(w, `${Q}&MFL_USER_ID=tok-B`, pick());
  t.equal(a.status, 200); t.equal(a.json.discord_posted, false);
  t.equal(w.claims()[0].state, "announce_failed");
  const b = await send(w, `${Q}&MFL_USER_ID=tok-B`, pick());
  t.equal(b.status, 409);
  t.equal(w.edge.liveDraft.length, 1);
});

// ════════════════════════════ claim store pieces ════════════════════════════
test("claim keys are one per slot per mode; only a post that provably didn't go out counts as not sent", () => {
  t.equal(pickClaimKey("live", 1, 4), "live:R1.04");
  t.equal(pickClaimKey("dry_run", "3", "12"), "dry_run:R3.12");
  t.throws(() => pickClaimKey("other", 1, 1));
  t.throws(() => pickClaimKey("live", null, 1));
  t.equal(discordPostNotSent({ ok: false, status: 400 }), true);
  t.equal(discordPostNotSent({ ok: false, error: "missing_discord_config" }), true);
  t.equal(discordPostNotSent({ ok: false, error: "network reset" }), false);
  t.equal(discordPostNotSent({ ok: true, status: 200 }), false);
});

test("migration 0173 creates exactly the table the worker creates on demand", () => {
  const cols = (sql) => { const db = new DatabaseSync(":memory:"); db.exec(sql); return db.prepare("SELECT name, type, \"notnull\", pk FROM pragma_table_info('ups_draft_pick_claims')").all().map((r) => ({ ...r })); };
  const mig = fs.readFileSync(new URL("../worker/migrations/0173_ups_draft_pick_claims.sql", import.meta.url), "utf8");
  t.deepEqual(cols(mig), cols(PICK_CLAIM_DDL));
});

// ════════════════════════════ the hub sends the session ════════════════════════════
const HUB = fs.readFileSync(new URL("../site/rookies/rookie_draft_hub.js", import.meta.url), "utf8");
test("HUB: the pick request carries the viewer's MFL session (a typed cookie, else the forwarded one)", async () => {
  const lines = HUB.split("\n").filter((l) => l.includes('"/api/pick"'));
  t.equal(lines.length, 2, `found ${lines.length} /api/pick lines`);
  t.ok(lines.some((l) => /MFL_USER_ID=" \+ encodeURIComponent\(userId\)/.test(l)), "a typed cookie is sent as MFL_USER_ID");
  t.ok(lines.some((l) => /withHubSession\(apiUrl\("\/api\/pick"\)/.test(l)), "otherwise the forwarded session is attached");
  t.doesNotMatch(HUB, /use league API key/);
  // and the worker accepts exactly that request
  const helperSrc = /function withHubSession\(url\) \{[\s\S]*?\n  \}/.exec(HUB)[0];
  const sb = { window: { UPS_DRAFT_HUB_MFL_USER_ID: "tok-B" }, encodeURIComponent }; vm.createContext(sb); vm.runInContext(helperSrc + "; this.f = withHubSession;", sb);
  const u = new URL(sb.f("https://w/api/pick?L=74598"));
  const w = fresh();
  const r = await send(w, u.search.slice(1) + "&YEAR=2026", pick());
  t.equal(r.status, 200); t.equal(w.posts().length, 1);
});

await run("draft_pick_route_authz");
restoreConsole();
