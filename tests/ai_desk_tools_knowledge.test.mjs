// Commissioner Desk: tests for tools 1-4 and 14 (rules.search, rules.get, glossary.lookup, coverage.check, data.freshness)
// and for the pure knowledge builder they run on. Offline and deterministic. Reads only files inside the repo.
//   node tests/ai_desk_tools_knowledge.test.mjs
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { test, run, t } from "./fixtures/mini_test.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const D = (p) => import(path.join(ROOT, "worker/src/desk", p));

const { makeCommishCaller, GAP_REASONS, TOOL_STATUSES } = await D("contract.js");
const { runTool, getTool, MAX_OUTPUT_BYTES } = await D("registry.js");
const know = await D("knowledge.js");
const { buildKnowledge, searchRules, getRule, lookupGlossary, resolveCoverage, htmlToText, sha256Hex, MAX_SEARCH_HITS, MAX_SNIPPET_CHARS, RULE_PART_CHARS } = know;
const GLOSS = await D("data/glossary.js");
const MATRIX = await D("data/coverage_matrix.js");
const rulesSearch = (await D("tools/rules_search.js")).default;
const rulesGet = (await D("tools/rules_get.js")).default;
const glossaryLookup = (await D("tools/glossary_lookup.js")).default;
const coverageCheck = (await D("tools/coverage_check.js")).default;
const dataFreshnessMod = await D("tools/data_freshness.js");
const dataFreshness = dataFreshnessMod.default;

const rulesJson = JSON.parse(read("site/m/data/rules.json"));
const canonText = read("docs/league_context_v1.md");
const NOW = new Date("2026-11-19T12:00:00Z");
const CANON_SHA = rulesJson.canon_sha;
const K = buildKnowledge({ rulesJson, canonText, leagueId: "74598", currentSeason: 2026, canonShaBundled: CANON_SHA });
const caller = makeCommishCaller("0001");

async function call(id, args, o = {}) {
  const fetched = [];
  const deps = {
    fetchSelf: o.fetchSelf ? async (...a) => { fetched.push(a); return o.fetchSelf(...a); } : async (...a) => { fetched.push(a); throw new Error("no network in this test"); },
    now: () => o.now || NOW, nowMs: () => (o.now || NOW).getTime(), knowledge: o.knowledge || K,
  };
  const env = await runTool({ caller, callSeq: o.seq || 1 }, id, args, deps);
  env._fetched = fetched;
  return env;
}
const anchors = (env) => env.data.hits.map((h) => h.anchor);
const fakeResponse = (status, body) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status });

// ── knowledge.js ────────────────────────────────────────────────────────────────────────────────────────
test("buildKnowledge: real rules.json -> frozen, indexed, meta matches the file", () => {
  t.equal(K.rulesMeta.canon_sha, CANON_SHA);
  t.equal(K.rulesMeta.section_count, rulesJson.sections.length);
  t.equal(K.rulesMeta.canon_date, rulesJson.canon_date);
  t.equal(K.leagueId, "74598");
  t.equal(K.currentSeason, 2026);
  t.ok(K.rules.order.length > 100 && K.rules.order.length < rulesJson.counts.rules, "indexed fewer rules than canon has (internal ones are left out)");
  t.equal(K.rulesMeta.rule_count + K.rulesMeta.excluded_internal + K.rulesMeta.excluded_owner_names, rulesJson.counts.rules, "every canon rule is indexed or accounted for");
  t.ok(Object.isFrozen(K) && Object.isFrozen(K.rules) && Object.isFrozen(K.rules.index.postings) && Object.isFrozen(K.rules.byAnchor["s1-d1"]) && Object.isFrozen(K.glossary.entries[0]));
  t.throws(() => { K.rules.byAnchor["s1-d1"].text = "tampered"; }, TypeError);
  t.throws(() => { K.rules.order.push("x"); }, TypeError);
  t.throws(() => { K.rulesMeta.canon_sha = "x"; }, TypeError);
  const e = K.rules.byAnchor["s1-c4"];
  t.equal(e.canon_sha, CANON_SHA);
  t.ok(Array.isArray(e.path) && e.path.length >= 2 && e.path.every((p) => typeof p === "string"));
  t.equal(e.ref, "1.C4");
});

test("buildKnowledge: canon text digest check, and pure sha256 matches node:crypto", () => {
  t.equal(K.rulesMeta.canon_text_digest_ok, true, "rules.json was built from the canon text in this repo");
  t.equal(sha256Hex(canonText).slice(0, 12), rulesJson.canon_digest);
  for (const s of ["", "abc", "x".repeat(55), "x".repeat(56), "x".repeat(64), "x".repeat(1000), "café — “quoted” \u{1F600}", canonText]) {
    t.equal(sha256Hex(s), crypto.createHash("sha256").update(s).digest("hex"));
  }
  const k2 = buildKnowledge({ rulesJson, canonText: canonText + "\nedited", leagueId: "74598", currentSeason: 2026 });
  t.equal(k2.rulesMeta.canon_text_digest_ok, false, "a different canon text is detected");
  const k3 = buildKnowledge({ rulesJson, leagueId: "74598", currentSeason: 2026 });
  t.equal(k3.rulesMeta.canon_text_digest_ok, null, "no canon text supplied -> unknown, not true");
});

test("buildKnowledge: handler-facing meta (canon_sha7, stale, anchors) and a bundled digest passed instead of the canon text", () => {
  t.equal(K.rulesMeta.canon_sha7, CANON_SHA.slice(0, 7));
  t.equal(K.rulesMeta.stale, false);
  t.deepEqual([...K.rules.anchors], [...K.rules.order], "the validator's list of citable anchors is the public rule list");
  t.ok(K.rules.anchors.includes("s1-c4") && !K.rules.anchors.includes("s1-a3-1") && !K.rules.anchors.some((a) => a.startsWith("sa-divisional-co-tena")));
  const good = buildKnowledge({ rulesJson, canonDigestBundled: rulesJson.canon_digest, leagueId: "74598", currentSeason: 2026 });
  t.equal(good.rulesMeta.canon_text_digest_ok, true);
  t.equal(good.rulesMeta.stale, false);
  const bad = buildKnowledge({ rulesJson, canonDigestBundled: "000000000000", leagueId: "74598", currentSeason: 2026 });
  t.equal(bad.rulesMeta.canon_text_digest_ok, false);
  t.equal(bad.rulesMeta.stale, true);
  const shaBad = buildKnowledge({ rulesJson, canonShaBundled: "0".repeat(40), leagueId: "74598", currentSeason: 2026 });
  t.equal(shaBad.rulesMeta.stale, true);
  t.equal(shaBad.canonShaBundled, "0".repeat(40));
  const none = buildKnowledge({ rulesJson, leagueId: "74598", currentSeason: 2026 });
  t.equal(none.rulesMeta.stale, false, "nothing to compare with is unverified, not stale");
  t.equal(none.canonShaBundled, null);
});

test("buildKnowledge: refuses a bad rules payload or season (fails loudly, no half-built index)", () => {
  t.throws(() => buildKnowledge({ rulesJson: null, currentSeason: 2026 }), /rulesJson/);
  t.throws(() => buildKnowledge({ rulesJson: { sections: [] }, currentSeason: 2026 }), /canon_sha/);
  t.throws(() => buildKnowledge({ rulesJson: { canon_sha: "abc" }, currentSeason: 2026 }), /sections/);
  t.throws(() => buildKnowledge({ rulesJson, currentSeason: "soon" }), /currentSeason/);
  t.throws(() => buildKnowledge({ rulesJson, currentSeason: 1999 }), /currentSeason/);
  t.throws(() => buildKnowledge(), /rulesJson/);
});

test("buildKnowledge: the caller's input objects are not frozen or kept", () => {
  const rj = JSON.parse(JSON.stringify(rulesJson));
  const cal = { events: [{ name: "x" }] };
  const k = buildKnowledge({ rulesJson: rj, leagueId: 74598, currentSeason: 2026, calendar: cal });
  t.ok(!Object.isFrozen(rj) && !Object.isFrozen(cal));
  t.ok(Object.isFrozen(k.calendar) && k.calendar !== cal);
  t.equal(k.leagueId, "74598");
});

const MINI = {
  canon_sha: "abc1234", canon_date: "2026-01-02T03:04:05-05:00", canon_digest: "000000000000", version: "vT", last_changed: "2026-01-01",
  sections: [
    { id: "s1", num: "1", title: "Player Lifecycle", internal: false, groups: [
      { id: "s1-a", key: "A", title: "ENTRY", rules: [
        { anchor: "s1-a1", id: "A1", title: "Alpha Rule", internal: false, tags: ["auction"], statuses: [], updated: null,
          blocks: [
            { kind: "p", html: "<p>The <b>alpha</b> rule &amp; its cost: R&lt;5 &gt; 3.</p>" },
            { kind: "list", has_int: true, html: "<ul><li>Public item one.</li><li class=\"ups-m-rb-int\">SECRET internal item <b>nested</b><ul><li>deeper secret</li></ul></li><li>Public item two.</li></ul>" },
            { kind: "p", internal: true, html: "<p>WHOLE BLOCK INTERNAL zebra</p>" },
            { kind: "table", html: "<table><thead><tr><th>Year</th><th>Cost</th></tr></thead><tbody><tr><td>2026</td><td>$5K</td></tr></tbody></table>" },
          ],
          children: [
            { anchor: "s1-a1-1", id: "A1.1", title: "Child rule", internal: false, tags: [], statuses: [], blocks: [{ kind: "p", html: "<p>Child text mentions quokka.</p>" }] },
            { anchor: "s1-a1-2", id: null, title: "Hidden child", internal: true, tags: [], statuses: [], blocks: [{ kind: "p", html: "<p>internal child quokka</p>" }] },
          ] },
        { anchor: "s1-a2", id: "A2", title: "Internal rule", internal: true, tags: [], statuses: [], blocks: [{ kind: "p", html: "<p>internal zebra</p>" }],
          children: [{ anchor: "s1-a2-1", id: null, title: "Child of internal", internal: false, tags: [], statuses: [], blocks: [{ kind: "p", html: "<p>orphan zebra</p>" }] }] },
        { anchor: "s1-a3", id: "A3", title: "Long rule", internal: false, tags: [], statuses: [], blocks: [
          { kind: "p", html: "<p>" + "word ".repeat(1500) + "</p>" },
          { kind: "p", html: "<p>" + "A".repeat(7000) + "</p>" },
          { kind: "p", html: "<p>TAILMARK</p>" },
        ] },
      ] },
    ] },
    { id: "sa-divisional-co-tena", num: "A", title: "Divisional Co-tenancy History", internal: false, groups: [
      { id: "x", key: null, title: "Owners", rules: [{ anchor: "sa-divisional-co-tena-bob", id: null, title: "Owner Name", internal: false, tags: [], statuses: [], blocks: [{ kind: "p", html: "<p>Bob Example shared a division.</p>" }] }] },
    ] },
    { id: "sa-open", num: "A", title: "Open Items", internal: true, groups: [
      { id: "y", key: null, title: "Items", rules: [{ anchor: "sa-open-1", id: null, title: "Open item", internal: false, tags: [], statuses: [], blocks: [{ kind: "p", html: "<p>internal section zebra</p>" }] }] },
    ] },
  ],
};
const KM = buildKnowledge({ rulesJson: MINI, leagueId: "1", currentSeason: 2026 });

test("rules index: internal rules, internal list items, owner-name appendix and orphaned children never reach the index", () => {
  t.deepEqual(KM.rules.order, ["s1-a1", "s1-a1-1", "s1-a3"]);
  const all = KM.rules.order.map((a) => KM.rules.byAnchor[a].text).join("\n");
  t.doesNotMatch(all, /SECRET|deeper secret|zebra|Bob Example|internal child|orphan/);
  t.match(KM.rules.byAnchor["s1-a1"].text, /Public item one\./);
  t.match(KM.rules.byAnchor["s1-a1"].text, /Public item two\./);
  t.equal(KM.rulesMeta.excluded_owner_names, 1);
  t.ok(KM.rulesMeta.excluded_internal >= 3);
  t.equal(searchRules(KM, "zebra").hits.length, 0, "internal text cannot be found by search");
  t.equal(searchRules(KM, "Bob Example").hits.length, 0);
  t.equal(getRule(KM, "s1-a2").found, false);
  t.equal(getRule(KM, "sa-divisional-co-tena-bob").found, false);
  t.deepEqual(KM.rules.byAnchor["s1-a1"].children, ["s1-a1-1"], "an internal child is not listed");
  t.deepEqual(KM.rules.byAnchor["s1-a1-1"].path.slice(-2), ["Alpha Rule", "Child rule"]);
});

test("htmlToText: entities decoded, table cells delimited, internal items removed with their nested content", () => {
  const e = KM.rules.byAnchor["s1-a1"].text;
  t.match(e, /alpha rule & its cost: R<5 > 3\./);
  t.match(e, /Year \| Cost/);
  t.match(e, /2026 \| \$5K/);
  t.equal(htmlToText("<p>a</p><p>b</p>").text, "a\nb");
  t.equal(htmlToText("x &#65;&#x42; &nbsp;y &bogus; z").text, "x AB y &bogus; z");
  t.equal(htmlToText("<div class=\"ups-m-rb-int\">gone<div>nested gone</div></div>kept").text, "kept");
  t.equal(htmlToText("<p>one</p><li class=\"ups-m-rb-int\">gone").text, "one", "an unclosed internal element swallows the rest, never leaks it");
  t.equal(htmlToText(null).text, "");
});

test("searchRules: deterministic, bounded, and ranks by relevance", () => {
  const a = searchRules(K, "cap penalty formula", { limit: 8 });
  const b = searchRules(K, "cap penalty formula", { limit: 8 });
  t.deepEqual(a, b);
  t.ok(a.hits.length <= MAX_SEARCH_HITS);
  t.equal(searchRules(K, "cap penalty", { limit: 500 }).hits.length, MAX_SEARCH_HITS, "limit is clamped to the maximum");
  t.equal(searchRules(K, "cap penalty", { limit: 1 }).hits.length, 1);
  t.equal(searchRules(K, "cap penalty", { limit: 0 }).hits.length, 5, "0 falls back to the default");
  for (const h of searchRules(K, "taxi squad", { limit: 8 }).hits) {
    t.ok(h.snippet.length > 0 && h.snippet.length < 400, `snippet under 400 chars (${h.snippet.length})`);
    t.ok(h.snippet.length <= MAX_SNIPPET_CHARS);
    t.equal(h.canon_sha, CANON_SHA);
    t.ok(Array.isArray(h.path) && h.path.length >= 2);
  }
  for (let i = 1; i < a.hits.length; i++) t.ok(a.hits[i - 1].score >= a.hits[i].score);
  t.equal(searchRules(K, "").hits.length, 0);
  t.equal(searchRules(K, "   ").hits.length, 0);
  t.equal(searchRules(K, "zzqxvwk").hits.length, 0);
  t.equal(searchRules(K, "the of and").hits.length, 0, "stopwords alone match nothing");
  t.equal(searchRules(K, "__proto__ constructor toString hasOwnProperty").hits.length, 0, "object-prototype names are plain words, not index keys");
  t.equal(searchRules(K, "x".repeat(5000)).hits.length, 0, "a very long query is cut to 200 chars and does not blow up");
});

// ── rules.search tool ───────────────────────────────────────────────────────────────────────────────────
const KNOWN_QUERIES = [
  ["cap penalty formula for cutting a player", "s1-d1", 1],
  ["extension Ext1 Ext2", "s1-c4", 1],
  ["taxi squad call-up weeks", "s1-b2", 3],
  ["MYM mid-year multi", "s1-c3", 2],
  ["tag offense defense", "s1-c8", 2],
  ["restructure limit per season", "s1-c5", 3],
  ["cap floor", "s6-a2", 1],
  ["Amari Cooper", "s1-d2", 1],
  ["rookie option", "s1-c6", 2],
  ["how many loaded contracts can a roster hold", "s1-c2", 1],
  ["IR injured reserve", "s1-b3", 2],
  ["dispersal draft new owner", "s1-a7", 1],
  ["blind bid waivers", "s1-a4", 3],
  ["first come first serve FCFS", "s1-a5", 2],
  ["annual roll-forward March", "s1-c7", 1],
  ["contract deadline", "s3-september-2026-contract-deadline-nfl-week-1", 1],
  ["s1-c4", "s1-c4", 1],
];
for (const [q, anchor, within] of KNOWN_QUERIES) {
  test(`rules.search "${q}" finds ${anchor} in the top ${within}`, async () => {
    const env = await call("rules.search", { query: q, limit: 8, as_of: "current" });
    t.equal(env.status, "ok");
    t.ok(anchors(env).slice(0, within).includes(anchor), `expected ${anchor} in top ${within}, got ${anchors(env).slice(0, 4).join(", ")}`);
  });
}

test("rules.search: ok envelope carries canon_sha as a fact, hits are bounded and carry anchor, path, snippet and canon_sha", async () => {
  const env = await call("rules.search", { query: "taxi squad", as_of: "current" }, { seq: 4 });
  t.equal(env.status, "ok");
  t.equal(env.data.canon_sha, CANON_SHA);
  t.ok(env.data.hits.length >= 1 && env.data.hits.length <= 5);
  for (const h of env.data.hits) {
    t.deepEqual(Object.keys(h).sort(), ["anchor", "canon_sha", "id", "path", "ref", "score", "snippet", "title"].sort());
    t.ok(h.snippet.length < 400);
  }
  const sha = env.facts.find((f) => f.id === "c4.canon_sha");
  t.ok(sha && sha.value === CANON_SHA && sha.grade === "B" && sha.unit === "text");
  t.ok(env.facts.some((f) => f.id === "c4.canon_date" && f.value === "2026-10-23" && f.unit === "date"));
  t.equal(env.coverage.supported, true);
  t.equal(env.data_class, "P0");
  t.ok(JSON.stringify(env.data).length < MAX_OUTPUT_BYTES);
  t.deepEqual(env._fetched, [], "rules.search never calls a route");
});

test("rules.search: a past as_of is unsupported_as_of, the current text is labeled as current only, and no facts leak", async () => {
  const env = await call("rules.search", { query: "cap penalty formula", as_of: "2019-06-01" });
  t.equal(env.status, "unsupported_as_of");
  t.equal(env.data.current_text_only, true);
  t.match(env.data.as_of_label, /CURRENT canon text/);
  t.match(env.data.as_of_label, /2019-06-01/);
  t.ok(env.data.hits.length > 0, "the current text is still returned, labeled");
  t.deepEqual(env.facts, []);
  t.equal(env.coverage.supported, false);
  t.equal(env.coverage.gaps[0].why, "unsupported_as_of");
  t.match(env.coverage.gaps[0].source_needed, /S4/);
  const today = await call("rules.search", { query: "cap penalty formula", as_of: "2026-11-19" });
  t.equal(today.status, "ok", "today's date is current");
  const future = await call("rules.search", { query: "cap penalty formula", as_of: "2027-03-01" });
  t.equal(future.status, "unsupported_as_of", "a future date is not today's canon either");
});

test("rules.search: no match -> no_record with a gap; bad arguments are refused by the registry", async () => {
  const none = await call("rules.search", { query: "zzqxvwk", as_of: "current" });
  t.equal(none.status, "no_record");
  t.equal(none.coverage.gaps[0].why, "NO_RECORD");
  t.deepEqual(none.facts, []);
  for (const bad of [{ query: "x", limit: 9 }, { query: "x", limit: 0 }, { query: "x", limit: "3" }, { query: "" }, { query: "x".repeat(201) }, { query: 5 }, { query: "x", extra: 1 }, {}]) {
    const env = await call("rules.search", { as_of: "current", ...bad });
    t.equal(env.status, "error", JSON.stringify(bad));
    t.equal(env.error.code, "bad_arguments");
  }
});

test("rules.search: no knowledge -> an error envelope, not a crash", async () => {
  const env = await call("rules.search", { query: "taxi", as_of: "current" }, { knowledge: {} });
  t.equal(env.status, "error");
  t.equal(env.error.code, "knowledge_missing");
});

// ── rules.get tool ──────────────────────────────────────────────────────────────────────────────────────
test("rules.get: a known anchor returns text, path, canon_sha, children; text under 6000 chars", async () => {
  const env = await call("rules.get", { anchor: "s1-d1", as_of: "current" }, { seq: 2 });
  t.equal(env.status, "ok");
  t.equal(env.data.anchor, "s1-d1");
  t.match(env.data.text, /\(TCV × 75%\)/);
  t.equal(env.data.canon_sha, CANON_SHA);
  t.ok(env.data.path.length >= 2);
  t.ok(env.data.text.length > 100 && env.data.text.length < 6000);
  t.ok(env.facts.some((f) => f.id === "c2.rule_anchor" && f.value === "s1-d1" && f.unit === "id"));
  const parent = await call("rules.get", { anchor: "s1-c5", as_of: "current" });
  t.deepEqual(parent.data.children.slice(0, 2), ["s1-c5-1", "s1-c5-2"]);
  const child = await call("rules.get", { anchor: "s1-c5-1", as_of: "current" });
  t.equal(child.data.parent_anchor, "s1-c5");
  const upper = await call("rules.get", { anchor: "S1-D1", as_of: "current" });
  t.equal(upper.status, "ok", "anchors match case-insensitively");
});

test("rules.get: long rules come in parts, each under 6000 chars, nothing lost or repeated", () => {
  const first = getRule(KM, "s1-a3", 1);
  t.ok(first.parts_total >= 3, `the long fixture rule needs several parts (got ${first.parts_total})`);
  const texts = [];
  for (let p = 1; p <= first.parts_total; p++) {
    const g = getRule(KM, "s1-a3", p);
    t.ok(g.text.length <= RULE_PART_CHARS && g.text.length < 6000);
    t.equal(g.part, p);
    texts.push(g.text);
  }
  const rebuilt = texts.join("\n").replace(/\s+/g, "");
  t.equal(rebuilt, KM.rules.byAnchor["s1-a3"].text.replace(/\s+/g, ""), "the parts cover the whole rule");
  t.match(texts[texts.length - 1], /TAILMARK/);
  t.equal(getRule(KM, "s1-a3", 99).part, first.parts_total, "a part past the end clamps to the last");
  t.equal(getRule(KM, "s1-a3", -4).part, 1);
  t.equal(getRule(KM, "s1-a3", "junk").part, 1);
  const real = getRule(K, "s7-g3", 1);
  t.ok(real.parts_total >= 2 && real.text.length < 6000, "a real long rule pages too");
});

test("rules.get: every part of every real rule survives the registry unchanged (it cuts any string over 2000 characters silently)", async () => {
  let parts = 0;
  for (const a of K.rules.order) {
    const first = getRule(K, a, 1);
    for (let p = 1; p <= first.parts_total; p++) {
      const env = await call("rules.get", { anchor: a, part: p, as_of: "current" });
      t.equal(env.status, "ok", `${a} part ${p}`);
      t.equal(env.data.text, getRule(K, a, p).text, `${a} part ${p} was cut by the registry`);
      parts++;
    }
  }
  t.ok(parts >= K.rules.order.length);
  t.ok(RULE_PART_CHARS <= 2000);
});

test("rules.get tool: long rule reports the unread remainder as a gap", async () => {
  const k = await call("rules.get", { anchor: "s1-a3", as_of: "current" }, { knowledge: KM });
  t.equal(k.status, "ok");
  t.ok(k.data.parts_total >= 3 && k.data.part === 1);
  t.equal(k.coverage.gaps[0].why, "partial_coverage");
  const last = await call("rules.get", { anchor: "s1-a3", part: k.data.parts_total, as_of: "current" }, { knowledge: KM });
  t.deepEqual(last.coverage.gaps, []);
});

test("rules.get: unknown anchor -> no_record with suggestions; internal and owner-name anchors look the same as unknown", async () => {
  const unk = await call("rules.get", { anchor: "s9-nope", as_of: "current" });
  t.equal(unk.status, "no_record");
  t.equal(unk.coverage.gaps[0].why, "NO_RECORD");
  t.deepEqual(unk.facts, []);
  const byId = await call("rules.get", { anchor: "C4", as_of: "current" });
  t.equal(byId.status, "no_record", "a rule id is ambiguous, so it is not resolved silently");
  t.ok(byId.data.suggestions.includes("s1-c4"));
  const internal = await call("rules.get", { anchor: "s1-a3-1", as_of: "current" });
  t.equal(internal.status, "no_record", "an internal canon block is not served");
  t.ok(rulesJson.sections.some((s) => s.groups.some((g) => g.rules.some((r) => r.anchor === "s1-a3-1" && r.internal))), "fixture check: s1-a3-1 really is internal in rules.json");
  const owners = await call("rules.get", { anchor: "sa-divisional-co-tena-keith-creelman", as_of: "current" });
  t.equal(owners.status, "no_record");
  for (const bad of ["../../etc/passwd", "s1 d1", "s1-d1?x=1", "", "a".repeat(161), "-s1", "s1-d1\n"]) {
    const env = await call("rules.get", { anchor: bad, as_of: "current" });
    t.equal(env.status, "error", JSON.stringify(bad));
  }
});

test("rules.get: a past as_of is unsupported_as_of and the text is labeled current", async () => {
  const env = await call("rules.get", { anchor: "s1-d1", as_of: "2020-09-01" });
  t.equal(env.status, "unsupported_as_of");
  t.equal(env.data.current_text_only, true);
  t.match(env.data.as_of_label, /not the rule in force on 2020-09-01/);
  t.match(env.data.text, /TCV/);
  t.deepEqual(env.facts, []);
  const unk = await call("rules.get", { anchor: "s9-nope", as_of: "2020-09-01" });
  t.equal(unk.status, "no_record", "an unknown anchor stays no_record whatever the date");
});

// ── glossary ────────────────────────────────────────────────────────────────────────────────────────────
const { CODE_RECOGNIZED_STATUS_TOKENS, INTENTIONALLY_UNDEFINED_TOKENS, GLOSSARY_ENTRIES, normalizeGlossaryKey, compactGlossaryKey } = GLOSS;
const publicAnchors = new Set(K.rules.order);

test("glossary: every entry cites a real canon anchor or a real repo file, and canon-silent entries say so", () => {
  const ids = new Set();
  for (const e of GLOSSARY_ENTRIES) {
    t.ok(!ids.has(e.id), `duplicate id ${e.id}`); ids.add(e.id);
    t.ok(["status_token", "term"].includes(e.kind));
    t.ok(e.definition.length > 30 && e.definition.length <= 420, `${e.id} definition length ${e.definition.length}`);
    t.ok(Array.isArray(e.sources) && e.sources.length >= 1, `${e.id} cites nothing`);
    for (const s of e.sources) {
      if (s.type === "canon") t.ok(publicAnchors.has(s.anchor), `${e.id}: canon anchor ${s.anchor} is not in the public rules index`);
      else if (s.type === "code" || s.type === "doc") t.ok(fs.existsSync(path.join(ROOT, s.file)), `${e.id}: ${s.file} does not exist`);
      else t.ok(false, `${e.id}: bad source type ${s.type}`);
    }
    if (e.canon_silent) t.ok(e.sources.some((s) => s.type !== "canon"), `${e.id}: a canon-silent entry must cite the code or document it describes`);
    else t.ok(e.sources.some((s) => s.type === "canon"), `${e.id}: a defined entry must cite canon`);
    for (const n of e.numbers || []) {
      t.ok(publicAnchors.has(n.anchor), `${e.id}: number ${n.key} cites ${n.anchor}`);
      t.ok(["usd", "count", "pct"].includes(n.unit) && Number.isFinite(n.value) && /^[a-z][a-z0-9_]{0,63}$/.test(n.key));
    }
  }
  t.ok(GLOSSARY_ENTRIES.length >= 40);
});

test("glossary: no two entries share a lookup key (a collision would silently hide one)", () => {
  const owner = new Map();
  for (const e of GLOSSARY_ENTRIES) {
    for (const label of [e.term, ...e.aliases]) {
      for (const k of [normalizeGlossaryKey(label), compactGlossaryKey(label)]) {
        if (!k) continue;
        if (owner.has(k) && owner.get(k) !== e.id) t.ok(false, `key "${k}" is used by ${owner.get(k)} and ${e.id}`);
        owner.set(k, e.id);
      }
    }
  }
  t.ok(owner.size > 100);
});

function statusTokensInClassifierSource() {
  const src = read("worker/src/contract_classification.js");
  const out = new Set(["fl", "bl"]);   // LOADED_SUFFIX_RE / LOADED_BARE_RE
  const fam = /const KNOWN_STATUS_FAMILY_RE = new RegExp\(\s*"\^\(" \+\s*\[([\s\S]*?)\]\.join\("\|"\)/.exec(src);
  t.ok(fam, "could not find KNOWN_STATUS_FAMILY_RE in contract_classification.js (the drift test needs updating)");
  for (const m of fam[1].matchAll(/"([^"]+)"/g)) {
    const raw = m[1].replace(/\\\\d\*/g, "<N>").replace(/\[\/\|\]/g, "/");
    if (raw.includes("<N>")) { const b = raw.replace("<N>", ""); out.add(b); out.add(b + "1"); out.add(b + "2"); }
    else out.add(raw.toLowerCase());
  }
  const mym = /const MYM_FAMILY_RE = \/\^\(([^)]*)\)\$\/i/.exec(src);
  t.ok(mym, "could not find MYM_FAMILY_RE");
  for (const x of mym[1].split("|")) out.add(x.toLowerCase());
  const ext = /const PLAIN_EXT_RE = \/\^\(([^)]*)\)-ext\[12\]\$\/i/.exec(src);
  t.ok(ext, "could not find PLAIN_EXT_RE");
  for (const p of ext[1].split("|")) { out.add(`${p}-ext1`); out.add(`${p}-ext2`); }
  return out;
}

test("glossary drift: the status tokens the classifier recognizes equal the desk's list, and each has an entry or a stated reason", () => {
  const fromCode = statusTokensInClassifierSource();
  const listed = new Set(CODE_RECOGNIZED_STATUS_TOKENS);
  const missingFromList = [...fromCode].filter((x) => !listed.has(x));
  const staleInList = [...listed].filter((x) => !fromCode.has(x));
  t.deepEqual(missingFromList, [], `contract_classification.js recognizes tokens the desk list does not know: ${missingFromList.join(", ")}`);
  t.deepEqual(staleInList, [], `the desk list has tokens the classifier no longer recognizes: ${staleInList.join(", ")}`);
  const taxi = read("worker/src/taxi_rule.js");
  t.match(taxi, /\^rookie\(-draft\)\?\$/, "taxi_rule.js still recognizes rookie and rookie-draft");
  for (const tok of CODE_RECOGNIZED_STATUS_TOKENS) {
    const r = lookupGlossary(K, tok);
    const defined = r.kind === "exact";
    const excused = Object.prototype.hasOwnProperty.call(INTENTIONALLY_UNDEFINED_TOKENS, tok);
    t.ok(defined !== excused, `${tok}: needs exactly one of a glossary entry or an INTENTIONALLY_UNDEFINED_TOKENS reason (defined=${defined}, excused=${excused})`);
    if (excused) t.ok(INTENTIONALLY_UNDEFINED_TOKENS[tok].length > 20);
  }
  for (const k of Object.keys(INTENTIONALLY_UNDEFINED_TOKENS)) t.ok(listed.has(k), `${k} is excused but not a recognized token`);
});

test("glossary.lookup: exact token, canon anchor cited, grade-B number facts", async () => {
  const era = await call("glossary.lookup", { term: "Vet-ERA", as_of: "current" });
  t.equal(era.status, "ok");
  t.equal(era.data.entries.length, 1);
  t.equal(era.data.entries[0].id, "st_vet_era");
  t.ok(era.data.entries[0].sources.some((s) => s.type === "canon" && s.anchor === "s1-a3"));
  t.equal(era.data.recognized_by_code, true);
  t.equal(era.data.entries[0].canon_silent, false);
  const loaded = await call("glossary.lookup", { term: "front-loaded", as_of: "current" }, { seq: 3 });
  t.equal(loaded.data.entries[0].id, "t_loaded");
  const cap = loaded.facts.find((f) => f.id === "c3.loaded_cap");
  t.ok(cap && cap.value === 5 && cap.unit === "count" && cap.grade === "B" && /s1-c2/.test(cap.source));
  const floor = await call("glossary.lookup", { term: "cap floor", as_of: "current" });
  t.equal(floor.facts.find((f) => /cap_floor$/.test(f.id)).value, 260000);
  t.equal((await call("glossary.lookup", { term: "  MYM ", as_of: "current" })).data.entries[0].id, "t_mym");
  t.equal((await call("glossary.lookup", { term: "vet era", as_of: "current" })).data.entries[0].id, "st_vet_era", "spacing variants resolve");
  t.equal((await call("glossary.lookup", { term: "VET_ERA", as_of: "current" })).data.entries[0].id, "st_vet_era", "underscore variants resolve");
});

test("glossary.lookup: an FL or BL suffix is explained as base plus suffix", async () => {
  for (const [term, base] of [["Vet-Ext1-BL", "st_ext1"], ["Vet-FAA-BL", "st_vet_faa"], ["Vet-Ext2-FL", "st_ext2"]]) {
    const env = await call("glossary.lookup", { term, as_of: "current" });
    t.equal(env.status, "ok", term);
    t.equal(env.data.match_kind, "composed");
    t.deepEqual(env.data.entries.map((e) => e.id), [base, "st_fl_bl"], term);
    t.equal(env.data.recognized_by_code, true);
  }
  const bare = await call("glossary.lookup", { term: "FL", as_of: "current" });
  t.equal(bare.data.entries[0].id, "st_fl_bl");
});

test("glossary.lookup: where canon is silent the entry says so, with a NO_RECORD gap; nothing is invented", async () => {
  const silent = await call("glossary.lookup", { term: "Rookie-FAA", as_of: "current" });
  t.equal(silent.status, "ok");
  t.equal(silent.data.entries[0].canon_silent, true);
  t.match(silent.data.entries[0].definition, /Canon does not define/);
  t.match(silent.data.note, /Canon does not define/);
  t.equal(silent.coverage.gaps[0].why, "NO_RECORD");
  const rv = await call("glossary.lookup", { term: "Rookie/Veteran", as_of: "current" });
  t.equal(rv.status, "no_record", "an excused token has no entry, so the desk does not explain it");
  const bogus = await call("glossary.lookup", { term: "Vet-Gibberish-MYM", as_of: "current" });
  t.equal(bogus.status, "no_record");
  t.equal(bogus.data.status_like, true);
  t.equal(bogus.data.recognized_by_code, false);
  t.match(bogus.data.note, /not one the code recognizes/);
  t.deepEqual(bogus.facts, []);
  const none = await call("glossary.lookup", { term: "flibbertigibbet", as_of: "current" });
  t.equal(none.status, "no_record");
  t.deepEqual(none.data.did_you_mean, []);
  const cand = await call("glossary.lookup", { term: "waiver rules", as_of: "current" });
  t.equal(cand.status, "no_record");
  t.ok(cand.data.did_you_mean.length >= 1 && cand.data.did_you_mean.length <= 3);
});

test("glossary.lookup: GF carries the canon conflict caveat; current-only; bad input refused", async () => {
  const gf = await call("glossary.lookup", { term: "GF", as_of: "current" });
  t.equal(gf.data.entries[0].id, "t_gf");
  t.match(gf.data.entries[0].caveat, /conflicts with canon/);
  const past = await call("glossary.lookup", { term: "MYM", as_of: "2025-09-01" });
  t.equal(past.status, "unsupported_as_of");
  t.deepEqual(past.facts, []);
  t.equal((await call("glossary.lookup", { term: "x".repeat(81), as_of: "current" })).status, "error");
  t.equal((await call("glossary.lookup", { as_of: "current" })).status, "error");
  const dup = await call("glossary.lookup", { term: "FCFS", as_of: "current" });
  t.equal(dup.facts.filter((f) => f.id.endsWith("fcfs_salary")).length, 1);
});

// ── coverage.check ──────────────────────────────────────────────────────────────────────────────────────
const SEASONS = [2009, 2010, 2011, 2012, 2015, 2016, 2017, 2019, 2020, 2024, 2025, 2026, 2027, 2040];
const LEVELS = ["full", "partial", "none"];

test("coverage.check answers every domain x several seasons with a valid, consistent cell", async () => {
  let n = 0;
  for (const dom of MATRIX.COVERAGE_DOMAIN_IDS) {
    for (const season of SEASONS) {
      const env = await call("coverage.check", { domain: dom, season, as_of: "current" });
      n++;
      t.equal(env.status, "ok", `${dom} ${season}`);
      t.ok(LEVELS.includes(env.data.level), `${dom} ${season} level`);
      t.ok(MATRIX.COVERAGE_PHASES.includes(env.data.phase_needed));
      t.equal(env.data.season, season);
      if (env.data.level === "full") { t.equal(env.data.reason, null); t.deepEqual(env.coverage.gaps, []); t.equal(env.coverage.supported, true); }
      else {
        t.ok(GAP_REASONS.includes(env.data.reason), `${dom} ${season} reason ${env.data.reason}`);
        t.equal(env.coverage.supported, false);
        t.equal(env.coverage.gaps.length, 1);
        t.equal(env.coverage.gaps[0].why, env.data.reason);
        t.ok(env.coverage.gaps[0].source_needed.length > 5);
      }
      t.equal(env.facts.find((f) => f.id === "c1.coverage_level").value, env.data.level);
      t.equal(env.facts.find((f) => f.id === "c1.season_checked").value, season);
      t.ok(env.data.note.length > 10 && env.data.note.length <= 400);
    }
  }
  t.equal(n, MATRIX.COVERAGE_DOMAIN_IDS.length * SEASONS.length);
  t.ok(MATRIX.COVERAGE_DOMAIN_IDS.length >= 19);
});

test("coverage.check never says full for pick lineage, owner history, rules by date, or contract history", async () => {
  for (const dom of ["pick_lineage", "owner_history", "rules_by_date", "rules_at_date", "contract_timeline", "grandfather_tags", "draft_order", "forum_history", "owner_private_data"]) {
    for (let season = 1995; season <= 2045; season++) {
      const c = resolveCoverage(K, dom, season, "current");
      t.notEqual(c.level, "full", `${dom} ${season} must not be full`);
    }
    for (const asOf of ["current", "2019-03-01", "2026-06-01"]) {
      const env = await call("coverage.check", { domain: dom, as_of: asOf });
      t.notEqual(env.data.level, "full", `${dom} as_of ${asOf}`);
    }
  }
  for (let season = 2010; season < 2026; season++) t.equal(resolveCoverage(K, "contract_timeline", season).level, "none", `contract_timeline ${season} before 2026 is none`);
  t.equal(resolveCoverage(K, "contract_timeline", 2026).level, "partial");
  t.equal(resolveCoverage(K, "pick_lineage", 2024).phase_needed, "S1");
  t.equal(resolveCoverage(K, "pick_lineage", 2024).lr_id, "LR-01");
  t.equal(resolveCoverage(K, "owner_history", 2024).phase_needed, "S3");
  t.equal(resolveCoverage(K, "rules_by_date", 2024).phase_needed, "S4");
  t.equal(resolveCoverage(K, "contract_timeline", 2019).phase_needed, "S2");
  t.equal(resolveCoverage(K, "grandfather_tags", 2019).lr_id, "LR-03");
});

test("coverage.check: the seasonal facts from the brief (cap adjustments, finishes, transactions, calendar, standings)", () => {
  const lv = (d, s) => resolveCoverage(K, d, s).level;
  t.equal(lv("cap_adjustments", 2026), "full");
  for (let s = 2017; s <= 2025; s++) t.equal(lv("cap_adjustments", s), "partial", `cap_adjustments ${s}`);
  for (let s = 2010; s <= 2016; s++) t.equal(lv("cap_adjustments", s), "none", `cap_adjustments ${s}`);
  t.equal(lv("finishes", 2010), "partial");
  t.match(resolveCoverage(K, "finishes", 2010).note, /no Toilet Bowl title/);
  t.equal(lv("finishes", 2015), "partial");
  t.match(resolveCoverage(K, "finishes", 2015).note, /defective/);
  for (const s of [2011, 2012, 2014, 2016, 2025]) t.equal(lv("finishes", s), "full");
  t.match(resolveCoverage(K, "finishes", 2012).note, /Toilet Bowl champion/);
  t.equal(resolveCoverage(K, "finishes", 2012).lr_id, "LR-04");
  for (let s = 2010; s <= 2026; s++) t.equal(lv("player_transactions", s), "partial", `player_transactions ${s} is never full`);
  t.deepEqual(resolveCoverage(K, "player_transactions", 2014).gap_ids, ["GAP-09", "GAP-15"]);
  t.deepEqual(resolveCoverage(K, "player_transactions", 2022).gap_ids, ["GAP-15"]);
  t.equal(lv("calendar", 2010), "none");
  t.equal(lv("calendar", 2015), "full");
  t.equal(resolveCoverage(K, "calendar", 2026).reason, "conflict_in_canon");
  t.equal(resolveCoverage(K, "calendar", 2026).lr_id, "LR-15");
  t.equal(lv("standings", 2010), "partial");
  t.deepEqual(resolveCoverage(K, "standings", 2010).gap_ids, ["GAP-03", "GAP-17"]);
  t.equal(lv("standings", 2018), "full");
  t.equal(lv("cap_penalty_history", 2012), "none");
  t.equal(lv("cap_penalty_history", 2022), "partial");
});

test("coverage.check: current-only domains answer for the current state and are a gap for any other season or date", async () => {
  const cur = await call("coverage.check", { domain: "cap_current", as_of: "current" });
  t.equal(cur.data.level, "full");
  t.equal(cur.data.season, 2026);
  t.equal(cur.data.season_source, "current season");
  const pastSeason = await call("coverage.check", { domain: "cap_current", season: 2025, as_of: "current" });
  t.equal(pastSeason.data.level, "none");
  t.equal(pastSeason.data.reason, "unsupported_as_of");
  const pastDate = await call("coverage.check", { domain: "roster_current", as_of: "2025-10-01" });
  t.equal(pastDate.data.level, "none");
  t.equal(pastDate.data.season, 2025);
  t.equal(pastDate.data.season_source, "year of as_of");
  const sameSeasonPastDate = await call("coverage.check", { domain: "rules_current", season: 2026, as_of: "2026-03-01" });
  t.equal(sameSeasonPastDate.data.level, "none", "a past date in the current season is still a past date");
  for (const d of ["rules_current", "roster_current", "cap_current", "cap_penalty_current", "extension_price_current"]) {
    t.equal(resolveCoverage(K, d, 2026, "current").level, "full", d);
    t.equal(resolveCoverage(K, d, 2024, "current").level, "none", d);
    t.equal(resolveCoverage(K, d, 2024, "current").reason, "unsupported_as_of", d);
  }
  const over = await call("coverage.check", { domain: "standings", season: 2020, as_of: "2024-05-05" });
  t.equal(over.data.season, 2020);
  t.match(over.data.season_source, /overrides/);
});

test("coverage.check: seasons outside the league's life and a matrix that has not been regenerated", () => {
  t.equal(resolveCoverage(K, "standings", 2009).reason, "NO_RECORD");
  t.equal(resolveCoverage(K, "standings", 2009).level, "none");
  t.equal(resolveCoverage(K, "standings", 2027).reason, "unsupported_as_of", "a future season");
  const k27 = buildKnowledge({ rulesJson, leagueId: "74598", currentSeason: 2027 });
  const stale = resolveCoverage(k27, "standings", 2027);
  t.equal(stale.level, "none");
  t.equal(stale.reason, "stale", "the matrix was written for seasons up to its last one and cannot vouch for a later season");
  t.equal(resolveCoverage(K, "no_such_domain", 2024), null);
});

test("coverage.check: 'all' lists every domain for the season, bounded; bad domains and seasons are refused", async () => {
  const env = await call("coverage.check", { domain: "all", season: 2019, as_of: "current" });
  t.equal(env.status, "ok");
  t.equal(env.data.domains.length, MATRIX.COVERAGE_DOMAIN_IDS.length);
  t.deepEqual(env.data.domains.map((d) => d.domain), [...MATRIX.COVERAGE_DOMAIN_IDS]);
  t.deepEqual(env.facts, []);
  t.ok(JSON.stringify(env.data).length < 6000);
  for (const bad of [{ domain: "bogus" }, { domain: "pick_lineage", season: "2020" }, { domain: "pick_lineage", season: 2020.5 }, { domain: "pick_lineage", season: 3000 }, { domain: "__proto__" }, {}]) {
    const e = await call("coverage.check", { as_of: "current", ...bad });
    t.equal(e.status, "error", JSON.stringify(bad));
  }
});

test("coverage matrix: every cell is valid and its backlog ids exist in the League Record backlog and catalog", () => {
  const backlog = read("docs/ai_desk/LEAGUE_RECORD_BACKLOG.md");
  const catalog = read("docs/ai_desk/TOOL_CATALOG.md");
  const lrIds = new Set([...backlog.matchAll(/LR-\d\d/g)].map((m) => m[0]));
  const gapIds = new Set();
  for (const m of catalog.matchAll(/GAP-(\d\d)((?:\/\d\d)*)/g)) { gapIds.add(`GAP-${m[1]}`); for (const x of m[2].split("/").filter(Boolean)) gapIds.add(`GAP-${x}`); }
  for (const d of MATRIX.COVERAGE_MATRIX) {
    const cells = d.kind === "current_only" ? [d.current, d.past] : d.spans;
    for (const c of cells) {
      t.ok(LEVELS.includes(c.level));
      t.ok(c.reason === null ? c.level === "full" : GAP_REASONS.includes(c.reason), `${d.id}: reason`);
      t.ok(c.lr_id === null || lrIds.has(c.lr_id), `${d.id}: ${c.lr_id} is not in the backlog`);
      for (const g of c.gap_ids) t.ok(gapIds.has(g), `${d.id}: ${g} is not in the tool catalog`);
      t.ok(c.note.length > 10 && c.note.length <= 400);
    }
    t.ok(Object.isFrozen(d));
  }
  for (const needed of ["rules_current", "rules_at_date", "roster_current", "cap_current", "cap_penalty_current", "cap_penalty_history", "cap_adjustments", "extension_price_current", "calendar", "standings", "finishes", "player_transactions", "pick_lineage", "draft_order", "contract_timeline", "grandfather_tags", "owner_history", "rules_by_date", "forum_history"]) {
    t.ok(MATRIX.COVERAGE_DOMAIN_IDS.includes(needed), `missing domain ${needed}`);
  }
});

// ── data.freshness ──────────────────────────────────────────────────────────────────────────────────────
const hoursAgo = (h) => new Date(NOW.getTime() - h * 3600000).toISOString().replace(/\.\d{3}Z$/, "Z");
function freshRoute(rows, extra = {}) {
  return async () => fakeResponse(200, { ok: true, etl: rows, weeklyCoverage: { season: 2026, week: 10 }, liveSources: ["fantasycalc"], generated_at: NOW.toISOString(), ...extra });
}
const HEALTHY = [
  { source: "nflverse_snaps", last_run_utc: hoursAgo(30), status: "ok", detail: "token=sk-secret-DO-NOT-LEAK" },
  { source: "discord_reconciliation", last_run_utc: hoursAgo(5), status: "ok", detail: "channels=3" },
  { source: "nflverse_weekly", last_run_utc: hoursAgo(60), status: "not_published", detail: "" },
];

test("data.freshness: healthy sources and a matching rules index -> fresh; calls only /api/data-freshness with the league id", async () => {
  const env = await call("data.freshness", { as_of: "current" }, { fetchSelf: freshRoute(HEALTHY), seq: 5 });
  t.equal(env.status, "ok");
  t.equal(env.data.overall, "fresh");
  t.equal(env.data.etl.available, true);
  t.equal(env.data.etl.source_count, 3);
  t.equal(env.data.etl.stale_count, 0);
  t.equal(env.data.rules_index.status, "current");
  t.deepEqual(env.coverage.gaps, []);
  t.equal(env.coverage.supported, true);
  t.equal(env._fetched.length, 1);
  t.equal(env._fetched[0][0], "https://self.invalid/api/data-freshness?L=74598");
  t.deepEqual(env.data.etl.weekly_coverage, { season: 2026, week: 10 });
  t.deepEqual(env.data.etl.sources.map((s) => s.source), ["discord_reconciliation", "nflverse_snaps", "nflverse_weekly"], "sorted by source");
  const snaps = env.data.etl.sources.find((s) => s.source === "nflverse_snaps");
  t.equal(snaps.age_hours, 30);
  t.equal(snaps.limit_hours, dataFreshnessMod.ETL_DEFAULT_MAX_AGE_HOURS);
  t.equal(snaps.stale, false);
  t.equal(env.data.etl.sources.find((s) => s.source === "nflverse_weekly").stale, false, "not_published is informational, not stale");
  t.equal(env.facts.find((f) => f.id === "c5.overall_freshness").value, "fresh");
  t.equal(env.facts.find((f) => f.id === "c5.sources_stale").value, 0);
  t.equal(env.facts.find((f) => f.id === "c5.oldest_source_hours").value, 60);
  t.match(env.data.limit_basis, /not published/);
  t.doesNotMatch(JSON.stringify(env), /sk-secret|DO-NOT-LEAK/, "the route's free-text detail field is never passed on");
});

test("data.freshness: a source past its limit, a failed run, and a missing time are each stale with a gap", async () => {
  const rows = [
    { source: "old_one", last_run_utc: hoursAgo(193), status: "ok" },
    { source: "edge_ok", last_run_utc: hoursAgo(191), status: "ok" },
    { source: "failed_run", last_run_utc: hoursAgo(2), status: "error" },
    { source: "no_time", last_run_utc: null, status: "ok" },
    { source: "garbage_time", last_run_utc: "yesterday-ish", status: "ok" },
    { source: "future_time", last_run_utc: hoursAgo(-5), status: "ok" },
  ];
  const env = await call("data.freshness", { as_of: "current" }, { fetchSelf: freshRoute(rows) });
  t.equal(env.data.overall, "stale");
  const by = Object.fromEntries(env.data.etl.sources.map((s) => [s.source, s]));
  t.equal(by.old_one.stale, true); t.match(by.old_one.reason, /older than/);
  t.equal(by.edge_ok.stale, false);
  t.equal(by.failed_run.stale, true); t.match(by.failed_run.reason, /failed/);
  t.equal(by.no_time.stale, true); t.equal(by.no_time.age_hours, null);
  t.equal(by.garbage_time.stale, true);
  t.equal(by.future_time.stale, false); t.equal(by.future_time.age_hours, 0, "clock skew clamps to zero");
  t.equal(env.data.etl.stale_count, 4);
  t.equal(env.coverage.supported, false);
  t.equal(env.coverage.gaps.filter((g) => g.why === "stale").length, 4);
  t.equal(env.facts.find((f) => f.id === "c1.sources_stale").value, 4);
});

test("data.freshness: many stale sources stay inside the registry's gap limit (named gaps plus one summary)", async () => {
  const rows = Array.from({ length: 40 }, (_, i) => ({ source: `old_${String(i).padStart(2, "0")}`, last_run_utc: hoursAgo(500), status: "ok" }));
  const env = await call("data.freshness", { as_of: "current" }, { fetchSelf: freshRoute(rows) });
  t.equal(env.status, "ok");
  t.equal(env.data.etl.stale_count, 40);
  t.ok(env.coverage.gaps.length <= 20 && env.coverage.gaps.length >= 2);
  t.ok(env.coverage.gaps.some((g) => /more data sources/.test(g.what)));
});

test("data.freshness: a stale rules index (canon_sha differs from the bundled canon) is reported stale", async () => {
  const kStale = buildKnowledge({ rulesJson, canonText, leagueId: "74598", currentSeason: 2026, canonShaBundled: "deadbeef00000000000000000000000000000000" });
  const env = await call("data.freshness", { as_of: "current" }, { fetchSelf: freshRoute(HEALTHY), knowledge: kStale });
  t.equal(env.data.rules_index.status, "stale");
  t.match(env.data.rules_index.reason, /194f8df4/);
  t.match(env.data.rules_index.reason, /deadbeef/);
  t.equal(env.data.rules_index.canon_sha, CANON_SHA);
  t.equal(env.data.rules_index.bundled_sha, "deadbeef00000000000000000000000000000000");
  t.equal(env.data.overall, "stale", "healthy ETL does not hide a stale rules index");
  t.ok(env.coverage.gaps.some((g) => g.why === "stale" && /rulebook index/.test(g.what)));
  t.equal(env.facts.find((f) => f.id === "c1.rules_index_status").value, "stale");
  t.equal(env.facts.find((f) => f.id === "c1.overall_freshness").value, "stale");
  t.equal(env.facts.find((f) => f.id === "c1.rules_canon_sha").value, CANON_SHA);
});

test("data.freshness: the index checked against a different canon text is stale; with nothing to compare with it is unverified, not fresh", async () => {
  const kText = buildKnowledge({ rulesJson, canonText: canonText + "\n<!-- drift -->", leagueId: "74598", currentSeason: 2026 });
  const a = await call("data.freshness", { as_of: "current" }, { fetchSelf: freshRoute(HEALTHY), knowledge: kText });
  t.equal(a.data.rules_index.status, "stale");
  t.equal(a.data.rules_index.canon_text_digest_ok, false);
  const kNone = buildKnowledge({ rulesJson, leagueId: "74598", currentSeason: 2026 });
  const b = await call("data.freshness", { as_of: "current" }, { fetchSelf: freshRoute(HEALTHY), knowledge: kNone });
  t.equal(b.data.rules_index.status, "unverified");
  t.equal(b.data.overall, "partial");
  t.deepEqual(b.coverage.gaps, [], "unverified is not a stale gap");
  const kOk = buildKnowledge({ rulesJson, canonText, leagueId: "74598", currentSeason: 2026 });
  const c = await call("data.freshness", { as_of: "current" }, { fetchSelf: freshRoute(HEALTHY), knowledge: kOk });
  t.equal(c.data.rules_index.status, "current");
  t.equal(c.data.overall, "fresh");
});

test("data.freshness: the route failing never crashes and is reported as unknown freshness (stale)", async () => {
  const cases = [
    ["503", async () => fakeResponse(503, { ok: false, reason: "D1 not bound" })],
    ["ok:false body", async () => fakeResponse(200, { ok: false })],
    ["not json", async () => fakeResponse(200, "<html>nope</html>")],
    ["etl not a list", async () => fakeResponse(200, { ok: true, etl: "x" })],
    ["network error", async () => { throw new Error("boom"); }],
  ];
  for (const [name, fetchSelf] of cases) {
    const env = await call("data.freshness", { as_of: "current" }, { fetchSelf });
    t.equal(env.status, "ok", name);
    t.equal(env.data.etl.available, false, name);
    t.equal(env.data.overall, "stale", name);
    t.ok(env.data.etl.route_error, name);
    t.ok(env.coverage.gaps.some((g) => /ETL freshness/.test(g.what)), name);
    t.equal(env.data.rules_index.status, "current", `${name}: the rules index is still reported`);
    t.ok(!env.facts.some((f) => /sources_/.test(f.id)), `${name}: no source-count facts when the route did not answer`);
  }
  const net = await call("data.freshness", { as_of: "current" }, { fetchSelf: async () => { throw new Error("boom"); } });
  t.equal(net.data.etl.route_error, "route_unreachable");
});

test("data.freshness: current only (a past as_of does not touch the route), no args, bounded", async () => {
  const past = await call("data.freshness", { as_of: "2026-09-01" }, { fetchSelf: freshRoute(HEALTHY) });
  t.equal(past.status, "unsupported_as_of");
  t.deepEqual(past._fetched, []);
  t.deepEqual(past.facts, []);
  const extra = await call("data.freshness", { as_of: "current", L: "74598" }, { fetchSelf: freshRoute(HEALTHY) });
  t.equal(extra.status, "error", "the model cannot pass a league id");
  const many = Array.from({ length: 200 }, (_, i) => ({ source: `src_${String(i).padStart(3, "0")}`, last_run_utc: hoursAgo(1), status: "ok" }));
  const big = await call("data.freshness", { as_of: "current" }, { fetchSelf: freshRoute(many) });
  t.equal(big.data.etl.sources.length, dataFreshnessMod.MAX_SOURCES_REPORTED);
  t.ok(JSON.stringify(big.data).length < MAX_OUTPUT_BYTES);
});

test("object-prototype names used as data (constructor, __proto__, toString) are plain words everywhere, never inherited members", async () => {
  t.equal(htmlToText("a &constructor; b &__proto__; c &toString;").text, "a &constructor; b &__proto__; c &toString;");
  for (const w of ["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf"]) {
    t.equal(lookupGlossary(K, w).kind === "exact", false, `glossary ${w}`);
    t.equal(getRule(K, w).found, false, `rules.get ${w}`);
    t.equal(resolveCoverage(K, w, 2024), null, `coverage ${w}`);
    const env = await call("rules.get", { anchor: w, as_of: "current" });
    t.ok(env.status === "no_record" || env.status === "error", `rules.get tool ${w}: ${env.status}`);
    const g = await call("glossary.lookup", { term: w, as_of: "current" });
    t.equal(g.status, "no_record", `glossary tool ${w}`);
  }
  const rows = [
    { source: "constructor", last_run_utc: hoursAgo(300), status: "ok" },
    { source: "toString", last_run_utc: hoursAgo(1), status: "ok" },
    { source: "__proto__", last_run_utc: hoursAgo(300), status: "ok" },
  ];
  const env = await call("data.freshness", { as_of: "current" }, { fetchSelf: freshRoute(rows) });
  for (const s of env.data.etl.sources) t.equal(s.limit_hours, dataFreshnessMod.ETL_DEFAULT_MAX_AGE_HOURS, `${s.source} gets the default limit, not an inherited member`);
  t.equal(env.data.etl.sources.find((s) => s.source === "constructor").stale, true, "an old source named like an Object member is still stale");
  t.equal(env.data.etl.sources.find((s) => s.source === "toString").stale, false);
});

// ── all five tools: definition invariants ───────────────────────────────────────────────────────────────
test("all five tools are registered read-only P0 Phase 1 tools with no tables and an explicit output allowlist", () => {
  const tools = [rulesSearch, rulesGet, glossaryLookup, coverageCheck, dataFreshness];
  t.deepEqual(tools.map((x) => x.id), ["rules.search", "rules.get", "glossary.lookup", "coverage.check", "data.freshness"]);
  for (const tool of tools) {
    t.equal(getTool(tool.id), tool);
    t.equal(tool.phase, "P1"); t.equal(tool.readOnly, true); t.equal(tool.dataClass, "P0");
    t.deepEqual(tool.allowlist.tables, []);
    t.ok(Array.isArray(tool.output.allow) && tool.output.allow.length > 3, `${tool.id} must list its output fields`);
    t.ok(tool.description.length > 120 && /cannot|not|only/i.test(tool.description), `${tool.id} description says what it cannot do`);
    t.ok(Object.isFrozen(tool));
    t.ok(!("as_of" in tool.inputSchema.properties));
  }
  t.deepEqual(rulesSearch.allowlist.routes, []);
  t.deepEqual(dataFreshness.allowlist.routes, [{ path: "/api/data-freshness", params: ["L"] }]);
  t.equal(rulesSearch.asOf.supports, "any");
  t.equal(glossaryLookup.asOf.supports, "current");
  t.equal(dataFreshness.asOf.supports, "current");
  t.ok(TOOL_STATUSES.includes("unsupported_as_of"));
});

test("every tool result stays inside the registry's output limit and is JSON-safe", async () => {
  const envs = [
    await call("rules.search", { query: "penalty", limit: 8, as_of: "current" }),
    await call("rules.get", { anchor: "s7-g3", as_of: "current" }),
    await call("glossary.lookup", { term: "Vet-Ext2-BL", as_of: "current" }),
    await call("coverage.check", { domain: "all", as_of: "current" }),
    await call("data.freshness", { as_of: "current" }, { fetchSelf: freshRoute(HEALTHY) }),
  ];
  for (const env of envs) {
    t.equal(env.status, "ok");
    t.ok(JSON.stringify(env.data).length < MAX_OUTPUT_BYTES);
    t.deepEqual(JSON.parse(JSON.stringify(env)), JSON.parse(JSON.stringify(env)));
    t.equal(env.error, null);
  }
});

await run("ai_desk_tools_knowledge");
