// Mobile Player Stats (#league/stats): each row's "NFL team · UPS franchise" tag, the Rostered / Free agents filter and
// the owner search must follow LIVE MFL rosters — the same boot-loaded export the Players tab, the player sheet, search
// and waiver bidding read — not the leaderboard's mfl_franchise_id. That field is a D1 join (src_contracts, an 08-05
// snapshot, through player_id_crosswalk, which has no 2026 rookies), so on 2026-10-09 it read "FA" for Jeremiyah Love,
// rostered by Cleon Ca$h, and the old owner for every trade, claim and drop since August (167 of 1,010 players).
// A player on NO roster is "FA" only when MFL's rosters are CONFIRMED COMPLETE (every league franchise present, with
// players); an empty or partial response makes him "owner unknown".
// Runs the REAL site/m/views/stats.js against that day's live worker + MFL reads (full rosters; leaderboard trimmed).
//   node tests/mobile_stats_live_ownership.test.mjs
import fs from "node:fs";
import vm from "node:vm";
import { t, test, run } from "./fixtures/mini_test.mjs";

const FX = JSON.parse(fs.readFileSync(new URL("./fixtures/mobile_stats_ownership_2026_10_09.json", import.meta.url), "utf8"));
const STATS_SRC = fs.readFileSync(new URL("../site/m/views/stats.js", import.meta.url), "utf8");
// The ownership rule itself is the app's one rule (app.js rosterOwnership / ownerOfPid, #1208), which the
// list now reads like the player sheet, the Players market and search — sliced out, never re-typed.
const sliceAppFn = (name) => {
  const at = APP_SRC.indexOf("\n  function " + name + "(");
  if (at < 0) throw new Error("app.js: no " + name);
  let i = APP_SRC.indexOf("{", at), depth = 0;
  for (; i < APP_SRC.length; i++) { if (APP_SRC[i] === "{") depth++; else if (APP_SRC[i] === "}" && --depth === 0) return APP_SRC.slice(at, i + 1); }
  throw new Error("unbalanced: " + name);
};
const ownSrc = () => "var state = window.UPS_MOBILE.state;\n" + ["findFranchiseById", "rosterOwnership", "ownerOfPid"].map(sliceAppFn).join("\n") +
  "\nwindow.UPS_MOBILE.data.rosterOwnership = rosterOwnership; window.UPS_MOBILE.data.ownerOfPid = ownerOfPid;";
const APP_SRC = fs.readFileSync(new URL("../site/m/app.js", import.meta.url), "utf8");
// The real mobile util helpers, sliced out of app.js (no hand-written look-alikes to drift).
const utilSrc = ["safeStr", "pad4", "escapeHtml", "asArray"].map((name) => {
  const m = new RegExp(`\\n  function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n  \\}\\n|\\n  function ${name}\\([^)]*\\) \\{[^\\n]*\\}\\n`).exec(APP_SRC);
  if (!m) throw new Error("app.js: no " + name);
  return m[0];
}).join("");

function boot({ rosters = FX.mfl_rosters, players = FX.mfl_players, franchises = FX.mfl_franchises } = {}) {
  const els = {};
  const elById = (id) => (els[id] = els[id] || { id, innerHTML: "", value: "", listeners: {},
    addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); } });
  const mount = { innerHTML: "",
    querySelectorAll(sel) {   // the position chips, parsed from what was actually rendered
      if (sel !== ".ups-m-pos-chip") return [];
      return (mount.__chips = [...mount.innerHTML.matchAll(/data-tab="([A-Z]+)"/g)].map((m) => ({
        getAttribute: () => m[1], addEventListener(type, fn) { this["on" + type] = fn; } })));
    },
    querySelector() { return null; } };
  const views = {};
  const M = {
    state: { rosters, franchises: franchises.map((f) => ({ id: f.id, name: f.name })) },
    data: { playerById: (id) => players.find((p) => String(p.id) === String(id)) || null, getAdvancedStatsLatestYear: () => 2026 },
    api: { workerUrl: (p) => "https://w.test" + p },
    route: { registerView: (name, fn) => (views[name] = fn), renderRoute: () => views.stats(mount) },
  };
  const fetch = async (url) => {
    const u = new URL(url);
    const body = u.pathname === "/api/advanced-stats-leaderboard" && u.searchParams.get("pos") === "skill"
      ? { rows: FX.leaderboard_skill } : { rows: [] };
    return { ok: true, json: async () => body };
  };
  const ctx = { window: { UPS_MOBILE: M }, document: { getElementById: (id) => (id === "ups-m-st-listwrap" ? (els[id] || null) : elById(id)) },
    fetch, console, setTimeout, clearTimeout, Promise, URL };
  vm.createContext(ctx);
  vm.runInContext(utilSrc + "window.UPS_MOBILE.util = { safeStr, pad4, escapeHtml, asArray };", ctx);
  vm.runInContext(ownSrc(), ctx);
  vm.runInContext(STATS_SRC, ctx);
  return { M, mount, els, render: () => views.stats(mount) };
}
const settle = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0)); };
async function openTab(v, tab) {
  v.render(); await settle();
  const chip = v.mount.__chips.find((c) => c.getAttribute() === tab);
  chip.onclick.call(chip); await settle();
}
// "pid → the row's team tag" for every row rendered, e.g. { "17472": "ARI · Cleon Ca$h" }
function tags(html) {
  const out = {};
  for (const m of html.matchAll(/data-pid="(\d+)"[\s\S]*?<span class="tm">([\s\S]*?)<\/span><\/span><\/span>/g)) {
    out[m[1]] = m[2].replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
  }
  return out;
}
test("the leaderboard fixture really carries the stale / unjoined owners this fixes (so the test can fail)", () => {
  const lb = Object.fromEntries(FX.leaderboard_skill.map((r) => [String(r.mfl_pid), r]));
  t.equal(lb["17472"].mfl_franchise_id, null, "Jeremiyah Love: no owner (player_id_crosswalk has no 2026 rookies)");
  t.equal(lb["12626"].mfl_franchise_name, "The Long Haulers", "Derrick Henry: 08-05 owner");
  t.equal(lb["11679"].current_team, "FA", "Odell Beckham: D1 src_players still says NFL FA");
  const live = {}; FX.mfl_rosters.rosters.franchise.forEach((f) => f.player.forEach((p) => (live[p.id] = f.id)));
  t.deepEqual([live["17472"], live["12626"], live["16601"], live["15787"], live["11679"]], ["0011", "0010", "0008", undefined, undefined]);
});

test("RB rows: the UPS owner is LIVE MFL's — Love is Cleon Ca$h's, not FA; Henry is Blake Bombers', not The Long Haulers'", async () => {
  const v = boot();
  await openTab(v, "RB");
  const tg = tags(v.mount.innerHTML);
  t.equal(tg["17472"], "ARI · Cleon Ca$h");
  t.equal(tg["12626"], "BAL · Blake Bombers");
  t.equal(tg["16601"], "PHI · Real Deal Creel", "Shipley: claimed 10-08 (08-05 said Sex Manther)");
  t.equal(tg["16171"], "NOS · Gride", "Kendre Miller (08-05 said Real Deal Creel)");
  t.match(tg["15711"], / · HammerTime/, "control: same owner in both sources");
  t.equal(tg["16387"], "GBP · FA", "a genuine free agent is still FA");
});

test("WR rows: a player DROPPED since August is a free agent; the NFL team is live MFL's (Beckham MIN, not 'FA')", async () => {
  const v = boot();
  await openTab(v, "WR");
  const tg = tags(v.mount.innerHTML);
  t.equal(tg["15787"], "KCC · FA", "Tyquan Thornton: 08-05 said Real Deal Creel");
  t.equal(tg["11679"], "MIN · FA", "Odell Beckham: 08-05 said Hawks, D1 src_players said NFL FA");
  t.equal(tg["17500"], "CLE · Blake Bombers", "Denzel Boston: rookie, no crosswalk row");
});

test("Rostered / Free agents filters and owner search use the same live owner", async () => {
  const v = boot();
  await openTab(v, "RB");
  const wrap = { innerHTML: "", addEventListener() {} };
  v.els["ups-m-st-listwrap"] = wrap;
  const sel = v.els["ups-m-st-scope"];
  const pick = (scope) => { sel.value = scope; sel.listeners.change.forEach((fn) => fn.call(sel)); return Object.keys(tags(wrap.innerHTML)).sort(); };
  t.deepEqual(pick("fa"), ["16387"], "free agents: only the real one");
  t.deepEqual(pick("ros"), ["12626", "15711", "16171", "16601", "17472"].sort(), "rostered: Love included");
  pick("all");
  const search = v.els["ups-m-st-search"];
  const q = (text) => { search.listeners.input.forEach((fn) => fn({ target: { value: text } })); return Object.keys(tags(wrap.innerHTML)).sort(); };
  t.deepEqual(q("cleon"), ["17472"], "owner search finds Love under his live owner");
  t.deepEqual(q("haulers"), [], "…and nobody under Henry's August owner");
  t.deepEqual(q("bombers"), ["12626"]);
});

test("MFL rosters unreadable: ownership is UNKNOWN — never 'FA' — and neither filter pretends to know", async () => {
  const v = boot({ rosters: null });
  await openTab(v, "RB");
  const tg = tags(v.mount.innerHTML);
  t.equal(tg["17472"], "ARI · owner unknown");
  t.equal(tg["16387"], "GBP · owner unknown", "not even a genuine free agent is called FA on a guess");
  t.ok(!/ · FA</.test(v.mount.innerHTML));
  const wrap = { innerHTML: "", addEventListener() {} };
  v.els["ups-m-st-listwrap"] = wrap;
  const sel = v.els["ups-m-st-scope"];
  for (const scope of ["fa", "ros"]) {
    sel.value = scope; sel.listeners.change.forEach((fn) => fn.call(sel));
    t.deepEqual(Object.keys(tags(wrap.innerHTML)), [], scope + ": no rows");
    t.match(wrap.innerHTML, /Couldn.t read MFL.s rosters/);
  }
});

// MFL rosters payloads built from the day's complete export
const rostersWith = (edit) => { const r = JSON.parse(JSON.stringify(FX.mfl_rosters)); edit(r.rosters); return r; };
const scopeRows = (v, wrap, scope) => {
  const sel = v.els["ups-m-st-scope"]; sel.value = scope; sel.listeners.change.forEach((fn) => fn.call(sel));
  return { pids: Object.keys(tags(wrap.innerHTML)), html: wrap.innerHTML };
};
async function rbWith(opts) {
  const v = boot(opts);
  await openTab(v, "RB");
  const tg = tags(v.mount.innerHTML);
  const wrap = { innerHTML: "", addEventListener() {} };
  v.els["ups-m-st-listwrap"] = wrap;
  return { v, tg, fa: scopeRows(v, wrap, "fa"), ros: scopeRows(v, wrap, "ros") };
}
const noFaFilter = (x) => { t.deepEqual(x.fa.pids, [], "Free agents: no rows"); t.match(x.fa.html, /Couldn.t read all of MFL.s rosters/);
  t.deepEqual(x.ros.pids, [], "Rostered: no rows (a partial list would read as the whole league's)"); t.match(x.ros.html, /Couldn.t read all of MFL.s rosters/); };

test("the fixture's rosters are COMPLETE (all 12 franchises, 485 players) — so 'FA' above is a confirmed free agent", () => {
  const fr = FX.mfl_rosters.rosters.franchise;
  t.deepEqual(fr.map((f) => f.id).sort(), FX.mfl_franchises.map((f) => f.id).sort());
  t.ok(fr.every((f) => f.player.length > 0)); t.equal(fr.reduce((n, f) => n + f.player.length, 0), 485);
});

test("EMPTY rosters response (MFL answered, but with no franchises): every row is 'owner unknown', never FA", async () => {
  for (const rosters of [{ rosters: {} }, { rosters: { franchise: [] } }]) {
    const x = await rbWith({ rosters });
    t.equal(x.tg["17472"], "ARI · owner unknown", JSON.stringify(rosters));
    t.equal(x.tg["16387"], "GBP · owner unknown", "not even a real free agent is called FA");
    t.ok(!Object.values(x.tg).some((tag) => / · FA$/.test(tag)));
    noFaFilter(x);
  }
});

test("PARTIAL: Cleon Ca$h's roster missing from the response → Love is 'owner unknown' (not FA); players found keep their owner", async () => {
  const x = await rbWith({ rosters: rostersWith((r) => { r.franchise = r.franchise.filter((f) => f.id !== "0011"); }) });
  t.equal(x.tg["17472"], "ARI · owner unknown");
  t.equal(x.tg["12626"], "BAL · Blake Bombers", "found on a roster = positive evidence, still shown");
  t.equal(x.tg["16387"], "GBP · owner unknown", "a free agent can't be confirmed either while a roster is missing");
  noFaFilter(x);
});

test("PARTIAL: a franchise listed with NO players (and a single-object franchise list) → incomplete, never FA", async () => {
  const emptied = await rbWith({ rosters: rostersWith((r) => { r.franchise.find((f) => f.id === "0011").player = []; }) });
  t.equal(emptied.tg["17472"], "ARI · owner unknown"); noFaFilter(emptied);
  // MFL collapses a one-element list to an object: one franchise is not the whole league
  const single = await rbWith({ rosters: rostersWith((r) => { r.franchise = r.franchise.find((f) => f.id === "0010"); }) });
  t.equal(single.tg["12626"], "BAL · Blake Bombers"); t.equal(single.tg["17472"], "ARI · owner unknown"); noFaFilter(single);
});

test("the league franchise list itself is unavailable → completeness can't be confirmed → no FA", async () => {
  const x = await rbWith({ franchises: [] });
  t.equal(x.tg["16387"], "GBP · owner unknown");
  t.equal(x.tg["17472"], "ARI · Rostered", "still on a roster (name unavailable)");
  noFaFilter(x);
});

test("a roster reload is picked up (the owner map is rebuilt when state.rosters changes, not cached forever)", async () => {
  const v = boot();
  await openTab(v, "RB");
  t.equal(tags(v.mount.innerHTML)["16387"], "GBP · FA");
  const next = JSON.parse(JSON.stringify(FX.mfl_rosters));
  next.rosters.franchise.find((f) => f.id === "0004").player.push({ id: "16387", status: "ROSTER" });
  v.M.state.rosters = next;
  v.render(); await settle();
  t.equal(tags(v.mount.innerHTML)["16387"], "GBP · Pure Greatness");
  // a trade: Love moves from Cleon Ca$h to Blake Bombers on the next reload — no app restart
  const traded = JSON.parse(JSON.stringify(next));
  const cleon = traded.rosters.franchise.find((f) => f.id === "0011"), bombers = traded.rosters.franchise.find((f) => f.id === "0010");
  cleon.player = cleon.player.filter((p) => p.id !== "17472"); bombers.player.push({ id: "17472", status: "ROSTER" });
  v.M.state.rosters = traded;
  v.render(); await settle();
  t.equal(tags(v.mount.innerHTML)["17472"], "ARI · Blake Bombers");
  // a reload that comes back PARTIAL degrades to unknown, and the next complete one restores the confirmed answer
  v.M.state.rosters = { rosters: { franchise: traded.rosters.franchise.filter((f) => f.id !== "0004") } };
  v.render(); await settle();
  t.equal(tags(v.mount.innerHTML)["16387"], "GBP · owner unknown");
  v.M.state.rosters = FX.mfl_rosters;
  v.render(); await settle();
  t.equal(tags(v.mount.innerHTML)["16387"], "GBP · FA");
});

await run("mobile_stats_live_ownership");
