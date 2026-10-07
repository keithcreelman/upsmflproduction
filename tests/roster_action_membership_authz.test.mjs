// /roster-workbench/action load_player / unload_player may only change a roster the
// caller is PROVEN to control.
//   node tests/roster_action_membership_authz.test.mjs
//
// Why (2026-10-07): those two actions do not go through an owner-scoped MFL import.
// They post MFL's COMMISSIONER Load Rosters form (csetup C=LOADROST, after a
// logout?BECOME=0000) for whatever franchise_id the body names — the same mechanism
// that unloaded Levis/Bigsby/Charbonnet on 2026-08-06. The route's only gate was
// "some MFL_USER_ID value is present", and nothing checked whose login it was or
// that it owned that franchise. So an arbitrary string, or one owner's real session,
// could add or remove players on ANOTHER team with commissioner authority.
//
// Real route, stateful fake MFL (tests/fixtures/worker_harness.mjs), plus a fake of
// MFL's Load Rosters page. Nothing touches the network.
import { t, test, run } from "./fixtures/mini_test.mjs";
import { makeWorkerEnv, makeMfl, callWorker, quiet, ADMIN_KEY } from "./fixtures/worker_harness.mjs";

const restoreConsole = quiet();

function fresh(opts) {
  const env = makeWorkerEnv({ YEAR: "2026", LEAGUE_ID: "74598" });
  const mfl = makeMfl(opts);
  // Gride (0003) holds 15000 and 15001; L.A. Looks (0001) holds 14056.
  mfl.st.rosters = { "0001": ["14056"], "0003": ["15000", "15001"], "0008": ["16614"] };
  mfl.install();
  // MFL's commissioner Load Rosters page + its POST, and the BECOME=0000 hop before it.
  const inner = globalThis.fetch;
  const loadRost = { pageReads: [], posts: [], becomes: 0 };
  globalThis.fetch = async (input, init) => {
    const u = new URL(String(input));
    if (/\/logout$/.test(u.pathname) && u.searchParams.get("BECOME") === "0000") {
      loadRost.becomes += 1;
      return new Response("", { status: 200 });
    }
    if (/\/csetup$/.test(u.pathname) && u.searchParams.get("C") === "LOADROST") {
      const fid = u.searchParams.get("FRANCHISE");
      loadRost.pageReads.push(fid);
      const ids = mfl.st.rosters[fid] || [];
      const html = `<form action="/2026/csetup?LEAGUE_ID=74598&FRANCHISE=${fid}&C=LOADROST" method="post">
        <input type="hidden" name="LEAGUE_ID" value="74598"><input type="hidden" name="FRANCHISE" value="${fid}">
        <textarea name="PLAYER_NAMES"></textarea>
        <select name="ROSTER" multiple>${ids.map((id) => `<option value="${id}" selected>${id}</option>`).join("")}</select></form>`;
      if ((init && init.method || "GET").toUpperCase() === "POST") {
        const p = new URLSearchParams(String(init.body || ""));
        loadRost.posts.push({ fid, roster: p.getAll("ROSTER") });
        mfl.st.rosters[fid] = p.getAll("ROSTER");
        return new Response("<html>Rosters loaded</html>", { status: 200 });
      }
      return new Response(html, { status: 200 });
    }
    return inner(input, init);
  };
  return { env, mfl, loadRost };
}

const act = (env, query, body) => callWorker(env, "POST", `/roster-workbench/action?L=74598&YEAR=2026${query}`,
  { body: { league_id: "74598", season: "2026", ...body } });
const unloadGride = (env, query) => act(env, query, { action: "unload_player", franchise_id: "0003", player_id: "15000" });

test("a made-up MFL_USER_ID cannot unload another team's player", async () => {
  const { env, mfl, loadRost } = fresh();
  const r = await unloadGride(env, "&MFL_USER_ID=not-a-real-session");
  t.ok(r.status === 401 || r.status === 403, `refused, got ${r.status}: ${r.text.slice(0, 200)}`);
  t.equal(loadRost.posts.length, 0, "no Load Rosters write");
  t.equal(loadRost.becomes, 0, "never even assumes the commissioner identity");
  t.equal(JSON.stringify(mfl.st.rosters["0003"]), JSON.stringify(["15000", "15001"]), "Gride's roster is untouched");
});

test("one owner's real session cannot unload ANOTHER team's player", async () => {
  const { env, mfl, loadRost } = fresh();
  const r = await unloadGride(env, "&MFL_USER_ID=tok-B");            // tok-B is L.A. Looks (0001)
  t.equal(r.status, 403, r.text.slice(0, 200));
  t.match(r.json && (r.json.error || r.json.message) || "", /own team/i);
  t.equal(loadRost.posts.length, 0);
  t.equal(JSON.stringify(mfl.st.rosters["0003"]), JSON.stringify(["15000", "15001"]));
});

test("nor load a player onto another team", async () => {
  const { env, loadRost } = fresh();
  const r = await act(env, "&MFL_USER_ID=tok-B", { action: "load_player", franchise_id: "0003", player_id: "17000" });
  t.equal(r.status, 403, r.text.slice(0, 200));
  t.equal(loadRost.posts.length, 0);
});

test("an owner's proven session still works on their OWN team (the tag / untag flows)", async () => {
  const { env, mfl, loadRost } = fresh();
  const r = await unloadGride(env, "&MFL_USER_ID=tok-O");            // tok-O is Gride (0003)
  t.equal(r.status, 200, r.text.slice(0, 300));
  t.equal(loadRost.posts.length, 1);
  t.equal(loadRost.posts[0].fid, "0003");
  t.equal(JSON.stringify(mfl.st.rosters["0003"]), JSON.stringify(["15001"]));
});

test("the commissioner key and a proven commissioner session may act on any team", async () => {
  const a = fresh();
  t.equal((await unloadGride(a.env, `&APIKEY=${ADMIN_KEY}`)).status, 200, "admin key (ERA sweep, commish tools)");
  t.equal(a.loadRost.posts.length, 1);
  const b = fresh();
  t.equal((await unloadGride(b.env, "&MFL_USER_ID=tok-A")).status, 200, "tok-A is 0008, on the commissioner list");
  t.equal(b.loadRost.posts.length, 1);
});

test("fail closed: if MFL can't confirm who the caller is, nothing is written", async () => {
  const { env, loadRost } = fresh({ myleaguesDown: true });
  const r = await unloadGride(env, "&MFL_USER_ID=tok-O");
  t.equal(r.status, 503, r.text.slice(0, 200));
  t.equal(loadRost.posts.length, 0);
  t.equal(loadRost.becomes, 0);
});

test("a session from another league is refused", async () => {
  const { env, loadRost } = fresh();
  const r = await unloadGride(env, "&MFL_USER_ID=tok-x");
  t.equal(r.status, 403, r.text.slice(0, 200));
  t.equal(loadRost.posts.length, 0);
});

test("identity is checked before the dry-run short-circuit, so a dry run can't be used to probe", async () => {
  const { env } = fresh();
  const r = await act(env, "&MFL_USER_ID=tok-B", { action: "unload_player", franchise_id: "0003", player_id: "15000", dry_run: 1 });
  t.equal(r.status, 403);
});

test("owner-scoped imports (drop, taxi, IR) are unchanged: MFL scopes them to the session's own team", async () => {
  const { env, mfl } = fresh();
  const r = await act(env, "&MFL_USER_ID=tok-O", { action: "drop_player", franchise_id: "0003", player_id: "15000" });
  t.ok(r.status !== 401 && r.status !== 403, `not refused by the new gate (${r.status})`);
  t.ok(mfl.writes("taxi_squad").some((w) => /tok-O/.test(w.cookie)), "posted with the owner's own session");
});

await run("roster_action_membership_authz");
restoreConsole();
