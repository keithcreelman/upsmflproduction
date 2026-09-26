// Game Day player designation ("Out") — regression tests.
//   node tests/gameday_player_status.test.mjs
//
// THE DEFECT (2026-09-26, Week 3): a player rendered "Out" on Game Day although
// MFL's injuries export for the current week had NO designation for him.
//   • MFL's export (authoritative) and the worker proxy were correct: Week 3 carried no entry.
//   • The first incorrect layer was the client: site/shared/injury_overrides.js held a manual
//     patch entered for WEEK 1, and withInjuryOverride() applied any entry to EVERY week
//     forever ("this always wins over MFL's own export"). The mobile app additionally kept the
//     boot-time injuries feed for the whole session, with no week on it.
// The fix makes a designation a fact about ONE season+week: overrides must name it and apply to
// exactly it, the injury feed is stored bucketed by season+the week MFL wrote it for and read by
// (season, week, player), an older payload can never replace a newer one, and a status is
// normalized in one place so a missing description or stray punctuation can never render ":Out".
//
// Production code names no player. The fixtures below do, because they reproduce the incident.
import fs from "fs";
import vm from "vm";
import assert from "assert";

const read = (p) => fs.readFileSync(p, "utf8");
const SRC = read("site/shared/live_scoring.js");
const sandbox = {};
new Function("window", SRC)(sandbox);
const LS = sandbox.UPSLive;
assert.ok(LS && typeof LS.createInjuryStore === "function", "UPSLive with the injury store must be defined");

let fails = 0, passes = 0;
const checks = [];
const check = (n, fn) => { checks.push([n, fn]); };

// ── fixtures (real shapes; the ids/rows are what production served) ──────────────────────────
const PID = "14056";                       // the incident player — FIXTURE ONLY, never referenced by production code
// MFL export?TYPE=injuries for WEEK 3 as served live on 2026-09-26 (timestamp 1790424063): no entry for PID.
const WEEK3_NO_ENTRY = { injuries: { timestamp: "1790424063", week: "3", injury: [
  { status: "RETIRED", exp_return: "Feb 15, 2027", id: "10514", details: "Personal" },
  { status: "Questionable", exp_return: "Sep 13, 2026", id: "11317", details: "Hamstring" },
  { status: "IR-PUP", id: "11348", details: "Undisclosed" },
  { status: "Doubtful", id: "15555", details: "Ankle" }
] } };
// The same feed one week earlier, when he genuinely WAS designated (worker's own D1 history:
// ups_injury_status week 2 OUT / Concussion first seen 1789765538).
const WEEK2_OUT = { injuries: { timestamp: "1789765538", week: "2", injury: [
  { status: "Out", id: PID, details: "Concussion" },
  { status: "Questionable", id: "11317", details: "Hamstring" }
] } };
const WEEK3_OUT = { injuries: { timestamp: "1790500000", week: "3", injury: [{ status: "Out", id: PID, details: "Concussion" }] } };
// What shipped: an UNSCOPED entry (no season/week) — applied to every week for ever.
const LEGACY_OVERRIDES = { [PID]: { status: "OUT", note: "ruled out for the remainder of Week 1", source: "https://example.test/report", added: "2026-09-13" } };
// The pre-fix behaviour, verbatim, so the test shows what the fixture used to produce.
function legacyWithInjuryOverride(overrides, pid, mflStatus) { const o = overrides && overrides[String(pid)]; return (o && o.status) ? String(o.status) : (mflStatus || ""); }

const ctxWk = (season, week) => ({ season, week });
const storeWith = (...payloads) => { const s = LS.createInjuryStore(); payloads.forEach((p) => s.put(p, { season: 2026 })); return s; };

// ── 1. the reproduced incident ─────────────────────────────────────────────────────────────
check("REPRODUCED: the shipped unscoped override + a Week 3 feed with no entry used to render OUT; it now renders nothing", () => {
  const mflWeek3 = LS.parseInjuries(WEEK3_NO_ENTRY)[PID] || "";
  assert.strictEqual(mflWeek3, "", "MFL's authoritative Week 3 feed has no designation for him");
  assert.strictEqual(legacyWithInjuryOverride(LEGACY_OVERRIDES, PID, mflWeek3), "OUT", "BEFORE the fix: the stale Week 1 entry won");
  const store = storeWith(WEEK3_NO_ENTRY);
  const shown = LS.injuryStatusFor({ store, overrides: LEGACY_OVERRIDES, season: 2026, week: 3 }, PID);
  assert.strictEqual(shown, "", "AFTER the fix: the unscoped entry is inert and MFL's (empty) answer stands");
  assert.strictEqual(LS.injuryLabelFor({ store, overrides: LEGACY_OVERRIDES, season: 2026, week: 3 }, PID), "");
  assert.strictEqual(LS.injuryShort(shown), "", "and no badge text is produced at all");
});

// ── 2. prior week vs current week ───────────────────────────────────────────────────────────
check("a prior-week OUT cannot leak into the current week (feed bucketed by season+week)", () => {
  const store = storeWith(WEEK2_OUT, WEEK3_NO_ENTRY);
  assert.strictEqual(store.status(2026, 2, PID), "OUT", "Week 2 keeps its own designation");
  assert.strictEqual(store.status(2026, 3, PID), "", "Week 3 is a different bucket: nothing to find");
  // even if ONLY the old week's feed was ever loaded, asking for Week 3 finds nothing
  const onlyOld = storeWith(WEEK2_OUT);
  assert.strictEqual(onlyOld.status(2026, 3, PID), "");
  assert.strictEqual(onlyOld.known(2026, 3), false, "unknown is not the same as 'nobody is hurt'");
  assert.strictEqual(onlyOld.known(2026, 2), true);
});
check("a scoped override applies ONLY to its own season+week — an earlier week's entry is inert now", () => {
  const wk1 = { [PID]: { status: "OUT", season: 2026, week: 1, source: "s", added: "2026-09-13" } };
  const store = storeWith(WEEK3_NO_ENTRY);
  assert.strictEqual(LS.injuryStatusFor({ store, overrides: wk1, season: 2026, week: 3 }, PID), "");
  assert.strictEqual(LS.injuryStatusFor({ store, overrides: wk1, season: 2026, week: 1 }, PID), "OUT", "…but it still applies in the week it was made for");
  assert.strictEqual(LS.injuryStatusFor({ store, overrides: wk1, season: 2025, week: 1 }, PID), "", "and never in another season");
  assert.strictEqual(LS.overrideApplies(wk1[PID], ctxWk(2026, 2)), false);
});
check("the current week's own MFL designation replaces anything from a prior week", () => {
  const feedQ = { injuries: { timestamp: "1790424063", week: "3", injury: [{ status: "Questionable", id: PID, details: "Concussion" }] } };
  const store = storeWith(WEEK2_OUT, feedQ);
  assert.strictEqual(LS.injuryStatusFor({ store, overrides: LEGACY_OVERRIDES, season: 2026, week: 3 }, PID), "QUESTIONABLE");
  assert.strictEqual(LS.injuryStatusFor({ store, overrides: {}, season: 2026, week: 2 }, PID), "OUT");
});
check("a current-week OUT remains OUT — from MFL's own export, and from an override scoped to this exact week", () => {
  const store = storeWith(WEEK3_OUT);
  assert.strictEqual(LS.injuryStatusFor({ store, overrides: {}, season: 2026, week: 3 }, PID), "OUT");
  assert.strictEqual(LS.injuryLabelFor({ store, overrides: {}, season: 2026, week: 3 }, PID), "OUT: Concussion");
  const scoped = { [PID]: { status: "OUT", season: 2026, week: 3, source: "s", added: "2026-09-26" } };
  assert.strictEqual(LS.injuryStatusFor({ store: storeWith(WEEK3_NO_ENTRY), overrides: scoped, season: 2026, week: 3 }, PID), "OUT", "an in-week manual patch still wins when MFL is behind");
});
check("a caller that cannot say what week it is showing gets NO override and no store answer (fails to unavailable, not to OUT)", () => {
  const store = storeWith(WEEK3_OUT);
  const scoped = { [PID]: { status: "OUT", season: 2026, week: 3 } };
  assert.strictEqual(LS.injuryStatusFor({ store, overrides: scoped, season: 2026, week: 0 }, PID), "");
  assert.strictEqual(LS.injuryStatusFor({ store, overrides: scoped, season: 2026, week: "" }, PID), "");
  assert.strictEqual(LS.injuryStatusFor({ store, overrides: scoped, season: 2026 }, PID), "");
  assert.strictEqual(LS.withInjuryOverride(LEGACY_OVERRIDES, PID, "", undefined), "", "the old 3-argument call gets no legacy override");
  assert.strictEqual(LS.withInjuryOverride(LEGACY_OVERRIDES, PID, "Questionable"), "QUESTIONABLE", "…and MFL's own value stands, normalized");
});

// ── 3. missing / unknown never becomes OUT ──────────────────────────────────────────────────
check("a missing, blank or unknown status is unavailable — never OUT", () => {
  [undefined, null, "", "   ", ":", " : ", "—", "--", "…"].forEach((v) => {
    const shown = v === "…" ? LS.injuryToken(v) : LS.injuryToken(v);
    if (v === "…") return;                       // a non-punctuation glyph is just an unknown token, checked below
    assert.strictEqual(shown, "", JSON.stringify(v));
    assert.strictEqual(LS.injuryShort(v), "", JSON.stringify(v));
    assert.strictEqual(LS.injuryFactor(v), 1, JSON.stringify(v) + " must not zero a player out");
  });
  const noStatus = { injuries: { week: "3", timestamp: "5", injury: [{ id: "1" }, { id: "2", status: "" }, { id: "3", status: " : " }, { id: "4", status: null }] } };
  assert.deepStrictEqual(LS.parseInjuries(noStatus), {}, "rows with no status are no designation at all");
  assert.strictEqual(storeWith(noStatus).status(2026, 3, "1"), "");
  // an UNKNOWN word is kept as itself (informational), and does not zero a player out or draw an OUT badge
  assert.strictEqual(LS.injuryToken("Probable"), "PROBABLE");
  assert.strictEqual(LS.injuryFactor("Probable"), 1);
  assert.notStrictEqual(LS.injuryShort("Probable"), "OUT");
});
check("an override entry with no status is inert", () => {
  const o = { [PID]: { status: "", season: 2026, week: 3 } };
  assert.strictEqual(LS.injuryStatusFor({ store: storeWith(WEEK3_NO_ENTRY), overrides: o, season: 2026, week: 3 }, PID), "");
});

// ── 4. formatting: no leading colon, one separator ──────────────────────────────────────────
check("a status with no description never gets a leading (or trailing) colon", () => {
  ["", null, undefined, "   ", ":", " : ", "—"].forEach((d) => assert.strictEqual(LS.injuryLabel("Out", d), "OUT", JSON.stringify(d)));
  assert.strictEqual(LS.injuryLabel(":Out", ""), "OUT", "a status that arrives with a stray leading colon is cleaned at the boundary");
  assert.strictEqual(LS.injuryLabel(" - out ", null), "OUT");
  assert.strictEqual(LS.injuryLabel("", "Concussion"), "", "a description alone is not a designation, and never renders ':Concussion'");
  assert.strictEqual(LS.injuryLabel(null, null), "");
  ["OUT", "OUT: Concussion", "IR-PUP: Undisclosed"].forEach((l) => assert.ok(!/^[\s:;,.\-–—]/.test(l) && !/[:\s]$/.test(l), l));
});
check("a description plus a status renders punctuation EXACTLY once", () => {
  assert.strictEqual(LS.injuryLabel("Out", "Concussion"), "OUT: Concussion");
  assert.strictEqual(LS.injuryLabel("OUT:", "Concussion"), "OUT: Concussion", "a status that already ends with the separator");
  assert.strictEqual(LS.injuryLabel("Out", ": Concussion"), "OUT: Concussion", "a description that already starts with it");
  assert.strictEqual(LS.injuryLabel("Out", "Concussion:"), "OUT: Concussion");
  assert.strictEqual(LS.injuryLabel(":Out:", ":Concussion:"), "OUT: Concussion");
  assert.strictEqual(LS.injuryLabel("Out", "  left   knee\n sprain "), "OUT: left knee sprain", "whitespace collapses");
  ["Out|Concussion", "IR-PUP|Undisclosed", "Questionable|Hamstring"].forEach((pair) => {
    const [st, d] = pair.split("|"); const l = LS.injuryLabel(st, d);
    assert.strictEqual((l.match(/:/g) || []).length, 1, l);
    assert.ok(!/::|: :| {2}/.test(l), l);
  });
  assert.strictEqual(LS.injuryToken("ir-pup"), "IR-PUP", "an interior hyphen is part of the status");
});
check("the feed's own description travels with the status, and only with the status it belongs to", () => {
  const store = storeWith(WEEK2_OUT);
  assert.strictEqual(store.label(2026, 2, PID), "OUT: Concussion");
  const scoped = { [PID]: { status: "DOUBTFUL", season: 2026, week: 2, source: "s" } };
  assert.strictEqual(LS.injuryLabelFor({ store, overrides: scoped, season: 2026, week: 2 }, PID), "DOUBTFUL", "an override that changes the status does not borrow MFL's description of a different one");
});

// ── 5. the cache ─────────────────────────────────────────────────────────────────────────────
check("a stale (older) payload can never override a newer authoritative response for the same season+week", () => {
  const newer = { injuries: { timestamp: "2000", week: "3", injury: [{ status: "Out", id: PID, details: "Concussion" }] } };
  const older = { injuries: { timestamp: "1000", week: "3", injury: [{ status: "Questionable", id: PID, details: "Concussion" }] } };
  const s = LS.createInjuryStore();
  assert.strictEqual(s.put(newer, { season: 2026 }).accepted, true);
  const r = s.put(older, { season: 2026 });
  assert.deepStrictEqual({ a: r.accepted, why: r.reason }, { a: false, why: "stale" });
  assert.strictEqual(s.status(2026, 3, PID), "OUT", "the newer response stands");
  // arrival in the OTHER order lands on the same answer
  const s2 = LS.createInjuryStore(); s2.put(older, { season: 2026 }); s2.put(newer, { season: 2026 });
  assert.strictEqual(s2.status(2026, 3, PID), "OUT");
  // an identical re-put (the same timestamp) is idempotent; a newer one replaces WHOLESALE (a cleared designation disappears)
  assert.strictEqual(s2.put(newer, { season: 2026 }).accepted, true);
  const cleared = { injuries: { timestamp: "3000", week: "3", injury: [] } };
  assert.strictEqual(s2.put(cleared, { season: 2026 }).accepted, true);
  assert.strictEqual(s2.status(2026, 3, PID), "", "a designation MFL later removes is removed, not preserved");
});
check("cache isolation: season, week and player are each part of the key", () => {
  const s = storeWith(WEEK3_OUT);
  assert.strictEqual(s.status(2026, 3, PID), "OUT");
  assert.strictEqual(s.status(2025, 3, PID), "", "another season");
  assert.strictEqual(s.status(2026, 2, PID), "", "another week");
  assert.strictEqual(s.status(2026, 4, PID), "", "the next week");
  assert.strictEqual(s.status(2026, 3, "99999"), "", "another player");
  assert.strictEqual(s.known(2025, 3), false);
  // two seasons/weeks in one store stay separate
  s.put({ injuries: { timestamp: "5", week: "3", injury: [{ status: "Doubtful", id: PID }] } }, { season: 2025 });
  assert.strictEqual(s.status(2025, 3, PID), "DOUBTFUL"); assert.strictEqual(s.status(2026, 3, PID), "OUT");
});
check("a payload that cannot be attributed to a season and week is refused, not guessed", () => {
  const s = LS.createInjuryStore();
  assert.strictEqual(s.put({ injuries: { injury: [{ status: "Out", id: PID }] } }, { season: 2026 }).reason, "week_unknown");
  assert.strictEqual(s.put({ injuries: { week: "3", injury: [{ status: "Out", id: PID }] } }, {}).reason, "season_unknown");
  assert.strictEqual(s.put(null, { season: 2026 }).reason, "unreadable");
  assert.strictEqual(s.put({ error: { $t: "Invalid request" } }, { season: 2026 }).reason, "unreadable");
  assert.strictEqual(s.status(2026, 3, PID), "", "nothing was stored");
});
check("numeric and string player ids are the same player, in the feed and in the query", () => {
  const numeric = { injuries: { timestamp: "9", week: "3", injury: [{ status: "Out", id: 14056, details: "Concussion" }, { status: "Questionable", id: "11317" }] } };
  const s = storeWith(numeric);
  [14056, "14056"].forEach((p) => assert.strictEqual(s.status(2026, 3, p), "OUT", String(p)));
  [11317, "11317"].forEach((p) => assert.strictEqual(s.status(2026, "3", p), "QUESTIONABLE", String(p)));
  [3, "3", " 3 "].forEach((w) => assert.strictEqual(s.status("2026", w, 14056), "OUT", "week " + JSON.stringify(w)));
  assert.strictEqual(LS.injuryStatusFor({ store: s, overrides: { 14056: { status: "OUT", season: "2026", week: "3" } }, season: 2026, week: 3 }, "14056"), "OUT");
});

// ── 6. desktop and mobile share one model, and render identical output ──────────────────────
function extractFn(src, name) {
  const i = src.indexOf("function " + name + "(");
  assert.ok(i >= 0, "function " + name + " not found");
  let depth = 0, started = false;
  for (let k = src.indexOf("{", i); k < src.length; k++) {
    if (src[k] === "{") { depth++; started = true; } else if (src[k] === "}") { depth--; if (started && depth === 0) return src.slice(i, k + 1); }
  }
  throw new Error("unterminated function " + name);
}
const GAMEDAY = read("site/gameday/gameday.html");
const SCORES = read("site/m/views/scores.js");
const APP = read("site/m/app.js");
function desktopSandbox(store, overrides, season, week) {
  const ctx = { LS, esc: (v) => String(v == null ? "" : v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"),
    window: { UPS_INJURY_OVERRIDES: overrides }, injStore: () => store, sbYear: () => String(season), sbWeek: () => String(week),
    CTX: { year: String(season) }, STATE: { lineupWeek: week }, out: null };
  vm.createContext(ctx);
  vm.runInContext(["injStatusFor", "lineupInjOpts", "injBadgeInfo", "injBadgeHtml"].map((n) => extractFn(GAMEDAY, n)).join("\n"), ctx);
  return ctx;
}
function mobileSandbox(store, overrides, season, week) {
  const ctx = { LS, window: { UPS_INJURY_OVERRIDES: overrides }, M: { state: { injuryStore: store } }, sbYear: () => String(season), sbWeek: () => String(week), out: null };
  vm.createContext(ctx);
  vm.runInContext(extractFn(SCORES, "injStatusFor"), ctx);
  return ctx;
}
check("desktop and mobile resolve the SAME normalized status for every player, week, and override shape", () => {
  const store = storeWith(WEEK2_OUT, WEEK3_NO_ENTRY, { injuries: { timestamp: "1790500001", week: "4", injury: [{ status: " :Out ", id: PID, details: "Concussion" }] } });
  const pids = [PID, 14056, "11317", 10514, "11348", "15555", "nobody"];
  const overrideSets = [{}, LEGACY_OVERRIDES, { [PID]: { status: "Doubtful", season: 2026, week: 3 } }, { [PID]: { status: "OUT", season: 2026, week: 2 } }];
  let compared = 0;
  [2, 3, 4, 5].forEach((week) => overrideSets.forEach((ov) => {
    const d = desktopSandbox(store, ov, 2026, week), m = mobileSandbox(store, ov, 2026, week);
    pids.forEach((p) => {
      vm.runInContext("out = injStatusFor(" + JSON.stringify(p) + ")", d); vm.runInContext("out = injStatusFor(" + JSON.stringify(p) + ")", m);
      assert.strictEqual(d.out, m.out, "week " + week + " pid " + p + " overrides " + JSON.stringify(ov));
      compared += 1;
    });
  }));
  assert.ok(compared >= 100);
  // the incident, on both surfaces, in Week 3 with the shipped (unscoped) list
  const d3 = desktopSandbox(store, LEGACY_OVERRIDES, 2026, 3), m3 = mobileSandbox(store, LEGACY_OVERRIDES, 2026, 3);
  vm.runInContext("out = injStatusFor('" + PID + "')", d3); vm.runInContext("out = injStatusFor('" + PID + "')", m3);
  assert.deepStrictEqual([d3.out, m3.out], ["", ""]);
  // …and a stray leading colon from the feed is normalized identically (Week 4 above carried " :Out ")
  const d4 = desktopSandbox(store, {}, 2026, 4), m4 = mobileSandbox(store, {}, 2026, 4);
  vm.runInContext("out = injStatusFor('" + PID + "')", d4); vm.runInContext("out = injStatusFor('" + PID + "')", m4);
  assert.deepStrictEqual([d4.out, m4.out], ["OUT", "OUT"]);
});
check("mobile's boot feed parser is the shared parser: same map as desktop, same normalization, payload kept for the season+week store", async () => {
  const messy = { injuries: { timestamp: "7", week: "3", injury: [{ status: "Out", id: "1" }, { status: ":Questionable", id: 2 }, { status: "  ir-pup ", id: "3" }, { id: "4" }, { status: "", id: "5" }] } };
  const ctx = { window: { UPSLive: LS }, fetchJson: () => Promise.resolve(messy), mflExportUrl: () => "u", asArray: (v) => (Array.isArray(v) ? v : v ? [v] : []), safeStr: (v) => (v == null ? "" : String(v).trim()), out: null };
  vm.createContext(ctx);
  vm.runInContext(extractFn(APP, "fetchInjuries") + "\nout = fetchInjuries();", ctx);
  const res = await ctx.out;
  assert.deepStrictEqual(res.byPid, LS.parseInjuries(messy));
  assert.deepStrictEqual(res.byPid, { 1: "OUT", 2: "QUESTIONABLE", 3: "IR-PUP" });
  assert.strictEqual(res.ok, true); assert.strictEqual(res.rows, 5); assert.strictEqual(res.payload, messy);
  // an unreadable feed is UNKNOWN, not "nobody is hurt"
  const bad = { window: { UPSLive: LS }, fetchJson: () => Promise.resolve(null), mflExportUrl: () => "u", asArray: (v) => v, safeStr: String, out: null };
  vm.createContext(bad); vm.runInContext(extractFn(APP, "fetchInjuries") + "\nout = fetchInjuries();", bad);
  assert.strictEqual(JSON.stringify(await bad.out), JSON.stringify({ byPid: {}, ok: false, rows: 0 }));   // (JSON: the object is built inside the vm realm)
});
check("both surfaces read the season+week store (source-level), and neither keeps a private status parser or a status cache", () => {
  assert.match(GAMEDAY, /LS\.injuryStatusFor\(\{ store: injStore\(\)/); assert.match(SCORES, /LS\.injuryStatusFor\(\{ store: M\.state\.injuryStore/);
  assert.match(GAMEDAY, /injStore\(\)\.put\(r\[5\], \{ season: CTX\.year \}\)/); assert.match(GAMEDAY, /injStore\(\)\.put\(r\[3\], \{ season: sbYear\(\) \}\)/);
  assert.match(SCORES, /M\.state\.injuryStore\.put\(r\[7\], \{ season: sbYear\(\) \}\)/);
  assert.doesNotMatch(stripComments(GAMEDAY), /STATE\.injuries\b|STATE\.sb\.injuries/, "no page-global, week-less injury map is left on desktop");
  assert.doesNotMatch(SCORES, /injuriesByPid/, "the scoreboard no longer reads the boot-time, week-less map");
  assert.match(SCORES, /fetchJson\(sbExportUrl\("injuries"\)\)/, "the mobile scoreboard refreshes the feed itself, so a long-open app picks up the new week");
});
check("the badge markup: no leading or duplicate punctuation, the description rides in the tooltip, blank status = no badge", () => {
  const store = storeWith(WEEK3_OUT);
  const d = desktopSandbox(store, {}, 2026, 3);
  const html = (row) => { d.row = row; vm.runInContext("out = injBadgeHtml(row)", d); return d.out; };
  const withDetail = html({ injStatus: LS.injuryStatusFor(vm.runInContext("lineupInjOpts()", d), PID), injLabel: LS.injuryLabelFor(vm.runInContext("lineupInjOpts()", d), PID) });
  assert.match(withDetail, /<span class="gd-inj-badge tier-out" title="OUT: Concussion">OUT<\/span>/);
  assert.doesNotMatch(withDetail, />\s*[:;,.\-–—]/, "no punctuation before the badge text");
  const stray = html({ injStatus: ":Out", injLabel: "" });
  assert.match(stray, />OUT<\/span>/); assert.doesNotMatch(stray, /:OUT|:Out/i);
  assert.strictEqual(html({ injStatus: "", injLabel: "" }), "", "no designation renders nothing — never a bare OUT");
  assert.strictEqual(html({ injStatus: "Probable" }), "", "a non-risk word draws no badge");
  const html2 = html({ injStatus: "Questionable", injLabel: "QUESTIONABLE: Hamstring" });
  assert.match(html2, /tier-q" title="QUESTIONABLE: Hamstring">QUESTIONABLE</);
});

// ── 7. nothing is hardcoded; the override list can't regress ────────────────────────────────
function stripComments(src) {
  return src.replace(/<!--[\s\S]*?-->/g, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'\\\w])\/\/.*$/gm, "$1");
}
check("no player name or id is hardcoded in production code (comments excluded)", () => {
  const files = { "site/shared/live_scoring.js": SRC, "site/shared/injury_overrides.js": read("site/shared/injury_overrides.js"), "site/gameday/gameday.html": GAMEDAY, "site/m/views/scores.js": SCORES,
    "site/m/app.js#fetchInjuries": extractFn(APP, "fetchInjuries") };
  Object.keys(files).forEach((f) => {
    const code = stripComments(files[f]);
    assert.doesNotMatch(code, /kyler|murray|14056|arizona|\bARI\b/i, f + " must not name the incident player, his id or his team");
  });
  // and the fix branches on no week number or season literal either
  assert.doesNotMatch(stripComments(SRC.slice(SRC.indexOf("function injuryToken"), SRC.indexOf("/* ---- which payload are we reading?"))), /week\s*===?\s*\d|season\s*===?\s*20\d\d|20\d\d/, "no calendar literal in the injury logic");
});
check("every shipped override entry names its season and week (an unscoped entry fails the build)", () => {
  const box = {}; new Function("window", read("site/shared/injury_overrides.js"))(box);
  const list = box.UPS_INJURY_OVERRIDES;
  assert.ok(list && typeof list === "object");
  Object.keys(list).forEach((pid) => {
    const e = list[pid];
    assert.ok(/^\d+$/.test(pid), "player id key: " + pid);
    assert.ok(LS.injuryToken(e.status), pid + " needs a status");
    assert.ok(parseInt(e.season, 10) > 2000, pid + " needs a numeric season");
    assert.ok(parseInt(e.week, 10) >= 1 && parseInt(e.week, 10) <= 22, pid + " needs a numeric week");
    assert.ok(/^https?:\/\//.test(String(e.source || "")), pid + " needs a real source URL");
    assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(String(e.added || "")), pid + " needs the date it was added");
  });
  // the validator itself rejects the legacy shape
  assert.strictEqual(LS.overrideApplies(LEGACY_OVERRIDES[PID], ctxWk(2026, 1)), false);
});
check("the mobile release is stamped consistently and cache-busts every changed script", () => {
  const build = JSON.parse(read("site/m/version.json")).build, idx = read("site/m/index.html");
  assert.match(build, /^\d{4}\.\d{2}\.\d{2}\.\d+$/);
  assert.strictEqual(APP.match(/var BUILD = "([^"]+)";/)[1], build);
  ["shared/live_scoring.js", "shared/injury_overrides.js", "app.js", "views/scores.js"].forEach((f) => {
    assert.ok(idx.indexOf(f.replace(/^shared\//, "../shared/").replace(/^(app\.js|views\/)/, "./$1") + "?v=" + build) >= 0, f + " must carry ?v=" + build);
  });
});

(async () => {
  for (const [name, fn] of checks) {
    try { await fn(); passes++; console.log("  ok   " + name); }
    catch (e) { fails++; console.log("  FAIL " + name + "\n         " + (e && e.message || e)); }
  }
  console.log(fails ? `\ngameday_player_status: ${fails} FAILED of ${checks.length}` : `\ngameday_player_status: ${passes}/${checks.length} tests passed`);
  process.exit(fails ? 1 : 0);
})();
