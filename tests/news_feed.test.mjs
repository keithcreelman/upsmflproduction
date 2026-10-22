// Shared external news feed, contract ups.news.v1 (#1356, Keith 2026-10-21).
//   1. The contract: only permitted fields (headline / publisher / time / link /
//      category / canonical player ids / source status / fetch time), never text.
//   2. Stable ids: a story resolves to ONE MFL player or none — initials, Jr./II,
//      possessives, nicknames by id, same-name players disambiguated by team or
//      left unresolved; never a last name alone.
//   3. Dedupe: one id per article across feeds and refreshes; one story across
//      publishers; different stories stay apart.
//   4. Outages: unavailable / partial / empty / stale sources never read as
//      "no recent items".
//   5. The routes: /api/news-feed and the legacy /api/player-news shape over
//      the same feed (recorded RSS + MFL replies; nothing leaves the process).
// Every rule in 2–4 is also checked against a MUTANT copy of news_feed.js with
// that one rule reverted: the check must FAIL there (an assertion, not a crash).
//   node tests/news_feed.test.mjs
import fs from "node:fs";
import { t, test, run } from "./fixtures/mini_test.mjs";
import { makeD1 } from "./fixtures/d1_sqlite.mjs";

const SRC = fs.readFileSync(new URL("../worker/src/news_feed.js", import.meta.url), "utf8");
const M = await import("../worker/src/news_feed.js");
const FX = JSON.parse(fs.readFileSync(new URL("./fixtures/news_feed_2026_10_21.json", import.meta.url), "utf8"));
const NOW = Math.floor(Date.parse(FX.recorded_at) / 1000);
const PLAYERS = FX.mfl_players.map(([id, name, team, position]) => ({ id, name, team, position }));
const IDS = new Map(Object.entries(FX.mfl_ids));

const xmlEsc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;");
function rss(items) {
  return '<?xml version="1.0"?><rss version="2.0"><channel><title>t</title>' + items.map((i) =>
    "<item><title><![CDATA[" + i.title + "]]></title><link>" + xmlEsc(i.link || "") + "</link>" +
    (i.pubDate ? "<pubDate>" + i.pubDate + "</pubDate>" : "") +
    (i.categories || []).map((c) => "<category><![CDATA[" + c + "]]></category>").join("") +
    (i.description ? "<description><![CDATA[" + i.description + "]]></description>" : "") +
    "</item>").join("") + "</channel></rss>";
}
const recorded = (over = {}) => M.RSS_SOURCES.map((s) => {
  const o = over[s.id];
  if (o && o.fail) return { source: s, ok: false, http_status: o.fail, body: "", fetched_at: FX.recorded_at, error: "HTTP " + o.fail };
  const items = o && o.items ? o.items : FX.feeds[s.id];
  return { source: s, ok: true, http_status: 200, body: o && o.body != null ? o.body : rss(items), fetched_at: FX.recorded_at, error: "" };
});
const feedOf = (mod, fetched, extra = {}) => mod.buildFeed(fetched, { mflPlayers: PLAYERS, aliases: FX.sleeper_aliases, ids: IDS, now: NOW, ...extra });
// One synthetic story in an otherwise empty, healthy feed (every source answers).
const date = (h) => new Date((NOW - h * 3600) * 1000).toUTCString();
const one = (mod, item, extra) => feedOf(mod, recorded({ pfr: { items: [item] }, pft: { items: [{ title: "filler", link: "https://f.test/1", pubDate: date(1) }] }, cbs: { items: [{ title: "filler two", link: "https://f.test/2", pubDate: date(1) }] }, yahoo: { items: [{ title: "filler three", link: "https://f.test/3", pubDate: date(1) }] } }), extra);
const pidsOf = (feed, headline) => { const it = feed.items.find((i) => i.headline === headline); return it ? it.players.map((p) => p.mfl_id) : null; };

// A copy of news_feed.js with ONE rule reverted (every anchor must occur exactly once).
async function mutant(pairs) {
  let code = SRC;
  for (const [find, replace] of pairs) {
    const n = code.split(find).length - 1;
    if (n !== 1) throw new Error("mutation anchor found " + n + " times: " + find.slice(0, 80));
    code = code.replace(find, () => replace);
  }
  return import("data:text/javascript;base64," + Buffer.from(code).toString("base64"));
}
async function catches(label, pairs, check) {
  await check(M);
  let err = null;
  try { await check(await mutant(pairs)); } catch (e) { err = e; }
  t.ok(err && err.code === "ERR_ASSERTION", label + ": the reverted rule must fail this check" + (err && err.code !== "ERR_ASSERTION" ? " (it crashed instead: " + err.message + ")" : ""));
}

// ── 1. the contract ──────────────────────────────────────────────────────────
test("contract: recorded 2026-10-21 feeds → ok, every item carries only permitted fields", () => {
  const feed = feedOf(M, recorded());
  t.equal(feed.contract, "ups.news.v1");
  t.equal(feed.feed_state, "ok");
  t.deepEqual(feed.sources.map((s) => [s.id, s.state, s.items]), [["pfr", "ok", 15], ["pft", "ok", 30], ["cbs", "ok", 36], ["yahoo", "ok", 50]]);
  for (const s of feed.sources) t.equal(s.fetched_at, FX.recorded_at, "every source says when it was fetched");
  t.ok(feed.coverage.since_ts > 0 && feed.coverage.hours > 0, "the window every source covers is stated");
  t.equal(feed.diagnostics.articles, 131);
  const KEYS = "also_reported_by,category,event,fetched_at,headline,headline_policy,id,mfl_article_id,players,published_at,published_precision,published_ts,publisher,source_id,story_id,url,via";
  const PKEYS = "espn_id,match,mfl_id,name,position,primary,rotowire_id,team";
  for (const it of feed.items) {
    t.equal(Object.keys(it).sort().join(","), KEYS);
    t.ok(M.NEWS_CATEGORIES.includes(it.category), "category " + it.category);
    t.match(it.url, /^https:\/\//);
    for (const p of it.players) t.equal(Object.keys(p).sort().join(","), PKEYS);
  }
  const hurts = M.playerView(feed, "14783", { year: 2026, leagueId: "74598" });
  t.equal(hurts.state, "items");
  t.equal(hurts.mfl_news_url, "https://www48.myfantasyleague.com/2026/news_articles?L=74598&P=14783");
  const h = hurts.items.find((i) => i.headline === "NFLPA Seeking Investigation Into Eagles’ Handling Of Jalen Hurts");
  t.ok(h, "PFR's own 'Jalen Hurts' tag attaches the story");
  const p = h.players.find((x) => x.mfl_id === "14783");
  t.deepEqual([p.match, p.primary, p.espn_id, p.rotowire_id], ["tag", true, "4040715", "14416"], "MFL / ESPN / RotoWire ids ride along");
});

test("contract: article text never leaves the builder (summary used in memory only)", () => {
  const feed = one(M, { title: "Eagles QB update", link: "https://pfr.test/a", pubDate: date(2), description: "SUMMARY-MARKER-123 Jalen Hurts is expected to miss time." });
  const s = JSON.stringify(feed);
  t.ok(!s.includes("SUMMARY-MARKER-123"), "the RSS summary is not in the output");
  t.ok(!/"(summary|description|body|content)":/.test(s), "no text field at all");
  t.deepEqual(pidsOf(feed, "Eagles QB update"), ["14783"], "…but it still tells us who the story is about");
  t.equal(feed.items.find((i) => i.headline === "Eagles QB update").players[0].primary, false, "a summary-only mention is not primary");
  t.equal(feed.items.find((i) => i.headline === "Eagles QB update").category, "injury", "…and picks the category");
  for (const it of M.legacyHeadlineItems(feed, "14783")) t.equal(it.body, "", "legacy items carry no body");
});

// ── 2. stable ids ────────────────────────────────────────────────────────────
const RESOLVE = [
  ["WR D.J. Moore out again in Week 6", ["13635"]],
  ["Bills' DJ Moore misses practice", ["13635"]],
  ["Marvin Harrison Jr. makes Texans debut", ["16614"]],
  ["Marvin Harrison catches three passes", ["16614"]],
  ["Tre' Harris out this week", ["17072"]],
  ["Chris Brazzell II placed on IR", ["17509"]],
  ["Jalen Hurts's blood clot timeline", ["14783"]],
  ["Hurts out for the season", []],                                   // a last name alone is never enough
  ["Justin Jefferson scores twice in Vikings win", ["14836"]],        // WR MIN
  ["Browns rookie Justin Jefferson leads team in tackles", ["17634"]], // LB CLE, same name
  ["Justin Jefferson news", []],                                      // two players, nothing to choose by
];
test("stable ids: every mention resolves to one MFL id or to none", () => {
  for (const [title, want] of RESOLVE) t.deepEqual(pidsOf(one(M, { title, link: "https://pfr.test/" + encodeURIComponent(title), pubDate: date(3) }), title), want, title);
  const f = one(M, { title: "Justin Jefferson news", link: "https://pfr.test/jj", pubDate: date(3) });
  t.equal(f.diagnostics.unresolved_name_mentions, 1, "an ambiguous name is counted, not guessed");
});
test("stable ids: nicknames come only from the id-joined Sleeper list", () => {
  const item = { title: "Kam Curl intercepts a pass", link: "https://pfr.test/kc", pubDate: date(3) };
  t.deepEqual(pidsOf(one(M, item), item.title), ["15001"], "Kam Curl = MFL 'Curl, Kamren' via RotoWire id");
  t.deepEqual(pidsOf(one(M, item, { aliases: [] }), item.title), [], "without the id-joined alias there is no match");
});
test("stable ids (mutation): reverting each rule is caught", async () => {
  const check = (mod) => { for (const [title, want] of RESOLVE) t.deepEqual(pidsOf(one(mod, { title, link: "https://pfr.test/" + encodeURIComponent(title), pubDate: date(3) }), title), want, title); };
  await catches("ambiguous name → guess", [["    if (cands.length !== 1) { unresolved += 1; return; }", "    if (!cands.length) { unresolved += 1; return; }"]], check);
  await catches("initials kept apart (D.J. ≠ DJ)", [[".replace(/['’.`]/g, \"\")", ".replace(/['’`]/g, \"\")"]], check);
  await catches("no Jr./II-less key", [["    add(key, pid);\n    add(key.replace(SUFFIX_RE, \"\"), pid);\n  }\n  for (const a", "    add(key, pid);\n  }\n  for (const a"]], check);
  await catches("last name alone indexed", [
    ["    if (!key || key.split(\" \").length < 2) return;", "    if (!key) return;"],
    ["    add(key, pid);\n    add(key.replace(SUFFIX_RE, \"\"), pid);\n  }\n  for (const a", "    add(key, pid);\n    add(key.replace(SUFFIX_RE, \"\"), pid);\n    add(key.replace(SUFFIX_RE, \"\").split(\" \").pop(), pid);\n  }\n  for (const a"],
    ["    for (let len = keys.length + 1; len >= 2; len--) {\n      const key = keys[len - 2];", "    for (let len = keys.length + 1; len >= 1; len--) {\n      const key = len === 1 ? toks[i] : keys[len - 2];"],
  ], check);
});

// ── 3. dedupe ────────────────────────────────────────────────────────────────
const HURTS_NFLPA = "NFLPA calls for \"full investigation\" into Jalen Hurts situation";
const HURTS_PUNISH = "Eagles will not be punished for how team handled Jalen Hurts' blood clots situation, NFLPA responds";
const dedupeCheck = (mod) => {
  const feed = feedOf(mod, recorded());
  const nflpa = feed.items.find((i) => i.headline === HURTS_NFLPA);
  t.ok(nflpa && nflpa.also_reported_by.length >= 1, "PFT's and Yahoo's copies of the NFLPA story are ONE item");
  t.ok(!feed.items.some((i) => i !== nflpa && i.headline === HURTS_NFLPA), "…not two");
  const punish = feed.items.find((i) => i.headline === HURTS_PUNISH);
  t.ok(punish && punish.also_reported_by.some((a) => a.publisher === "ProFootballRumors"), "CBS + PFR 'not punished' = one story");
  const a = feed.items.find((i) => /^NFL execs/.test(i.headline)), b = feed.items.find((i) => /^Jalen Hurts blood clot diagnosis timeline/.test(i.headline));
  t.ok(a && b && a.id !== b.id, "two different Hurts stories stay two");
  t.ok(feed.items.find((i) => i.headline === "A.J. Brown limited in practice on Tuesday"), "A.J. Brown practice story kept");
  t.ok(feed.items.find((i) => /^A\.J\. Brown’s recent struggles/.test(i.headline)), "…apart from his 'struggles' story");
  // The same headline three days apart is a new story.
  const late = feedOf(mod, recorded({ pfr: { items: [{ title: "Jalen Hurts ruled out", link: "https://pfr.test/1", pubDate: date(80) }] }, pft: { items: [{ title: "Jalen Hurts ruled out", link: "https://pft.test/2", pubDate: date(2) }] } }));
  t.equal(late.items.filter((i) => i.headline === "Jalen Hurts ruled out").length, 2, "3 days apart = 2 stories");
  // One URL, two spellings, two feeds → one id.
  const twin = feedOf(mod, recorded({ pfr: { items: [{ title: "Jalen Hurts update", link: "http://www.example.test/story/?utm_source=rss", pubDate: date(2) }] }, yahoo: { items: [{ title: "Jalen Hurts update (syndicated)", link: "https://example.test/story", pubDate: date(1) }] } }));
  t.equal(twin.items.filter((i) => /^Jalen Hurts update/.test(i.headline)).length, 1, "same canonical URL = one article");
};
test("dedupe: one story across publishers; different stories stay apart", () => dedupeCheck(M));
test("dedupe: ids are stable across refreshes and feed order", () => {
  const a = feedOf(M, recorded());
  const extra = { title: "Brand new story about Jalen Hurts", link: "https://pfr.test/new", pubDate: date(0.5) };
  const b = feedOf(M, recorded({ pfr: { items: [...FX.feeds.pfr].reverse().concat([extra]) } }));
  const key = (f) => new Map(f.items.map((i) => [i.headline, i.id + "|" + i.story_id]));
  const ka = key(a), kb = key(b);
  for (const [h, v] of ka) t.equal(kb.get(h), v, "same id + story id after a refresh: " + h.slice(0, 40));
  t.equal(M.itemId("http://www.x.test/a/?utm=1#c", "pfr", "x"), M.itemId("https://x.test/a", "yahoo", "y"), "id = canonical URL");
});
test("dedupe (mutation): reverting each rule is caught", async () => {
  await catches("no cross-publisher merge", [["export function sameStory(a, b) {\n", "export function sameStory(a, b) {\n  return false;\n"]], dedupeCheck);
  await catches("query string kept in the id", [["    return `https://${p.hostname.toLowerCase().replace(/^www\\./, \"\")}${path}`;", "    return `https://${p.hostname.toLowerCase().replace(/^www\\./, \"\")}${path}${p.search}`;"]], dedupeCheck);
  await catches("threshold too loose", [["  return inter / small >= 0.65;", "  return inter / small >= 0.2;"]], dedupeCheck);
  await catches("no time window", [["  if (gap > DEDUPE_WINDOW_SECONDS) return false;\n", ""]], dedupeCheck);
});

// ── 4. outages never read as "no news" ──────────────────────────────────────
const statesCheck = (mod) => {
  const down = feedOf(mod, recorded({ pfr: { fail: 503 }, pft: { fail: 403 }, cbs: { fail: 500 }, yahoo: { fail: 429 } }));
  t.equal(down.feed_state, "unavailable");
  t.equal(down.coverage.since_ts, null, "no window is claimed when nothing answered");
  t.equal(mod.playerView(down, "16211").state, "unavailable", "Puka with every source down = unavailable, never 'no recent items'");
  const part = feedOf(mod, recorded({ cbs: { fail: 503 } }));
  t.equal(part.feed_state, "partial");
  t.equal(mod.playerView(part, "14783").state, "items", "Hurts still has items from the sources that answered");
  const puka = mod.playerView(part, "16211");
  t.equal(puka.state, "partial", "no items + a source down = partial");
  t.deepEqual(puka.unavailable_sources, ["CBS Sports"]);
  const ok = feedOf(mod, recorded());
  const pukaOk = mod.playerView(ok, "16211");
  t.equal(pukaOk.state, "no_recent_items", "only when every source answered");
  t.ok(pukaOk.coverage.since_ts > 0, "…and it says which window it covers");
  t.equal(mod.playerView(ok, "99999", { known: false }).state, "unknown_player");
};
test("states: unavailable / partial / no_recent_items / items / unknown_player", () => statesCheck(M));
test("states: an empty, garbled or stale source is not 'ok'", () => {
  const empty = feedOf(M, recorded({ pft: { body: '<?xml version="1.0"?><rss><channel></channel></rss>' } }));
  t.equal(empty.sources.find((s) => s.id === "pft").state, "empty");
  t.equal(empty.feed_state, "partial");
  const garbled = feedOf(M, recorded({ yahoo: { body: "<html>Access denied</html>" } }));
  t.equal(garbled.sources.find((s) => s.id === "yahoo").state, "empty");
  const stale = feedOf(M, recorded({ cbs: { items: [{ title: "Old story", link: "https://cbs.test/old", pubDate: date(100) }] } }));
  t.equal(stale.sources.find((s) => s.id === "cbs").state, "stale");
  t.equal(stale.feed_state, "partial");
});
test("states (mutation): reverting each rule is caught", async () => {
  await catches("any source up = ok", [["  const feedState = okCount === sources.length && okCount > 0 ? \"ok\" : okCount > 0 ? \"partial\" : \"unavailable\";", "  const feedState = okCount > 0 ? \"ok\" : \"unavailable\";"]], statesCheck);
  await catches("outage read as no news", [["  else if (feed.feed_state === \"unavailable\") state = \"unavailable\";\n", ""]], statesCheck);
});

// ── 5. MFL Player News ───────────────────────────────────────────────────────
// Synthetic MFL replies: real MFL player ids, our own wording. (RotoWire's text is
// licensed; none is committed.) Ages use MFL's own format ("N hours" / "N days").
function profilesJson(pids, byPid) {
  return { version: "1.0", playerProfiles: { playerProfile: pids.map((id) => ({ id, name: "x", player: { id }, news: byPid[id] ? { article: byPid[id] } : {} })) } };
}
const mflChunk = (pids, byPid, over = {}) => ({ source: M.MFL_SOURCE, ok: !over.fail, http_status: over.fail || 200, body: over.fail ? "" : JSON.stringify(profilesJson(pids, byPid)), fetched_at: FX.recorded_at, error: over.fail ? "HTTP " + over.fail : "", pids });
const quiet = () => recorded({ pfr: { items: [{ title: "filler one", link: "https://f.test/1", pubDate: date(1) }] }, pft: { items: [{ title: "filler two", link: "https://f.test/2", pubDate: date(1) }] }, cbs: { items: [{ title: "filler three", link: "https://f.test/3", pubDate: date(1) }] }, yahoo: { items: [{ title: "filler four", link: "https://f.test/4", pubDate: date(1) }] } });
const withRss = (items) => recorded({ pfr: { items }, pft: { items: [{ title: "filler two", link: "https://f.test/2", pubDate: date(1) }] }, cbs: { items: [{ title: "filler three", link: "https://f.test/3", pubDate: date(1) }] }, yahoo: { items: [{ title: "filler four", link: "https://f.test/4", pubDate: date(1) }] } });
const OPTS = { year: 2026, leagueId: "74598" };
const MARK = "LICENSED-TEXT-MARKER";

const mflOnlyCheck = (mod) => {
  const f = feedOf(mod, [...quiet(), mflChunk(["16211"], { "16211": [{ id: "rotowire990101", headline: "WR Puka Nacua: " + MARK + " six catches in win", published: "2 days" }] })], OPTS);
  const v = mod.playerView(f, "16211", OPTS);
  t.equal(v.state, "items", "an MFL-only update is kept");
  const it = v.items[0];
  t.deepEqual([it.headline, it.headline_policy, it.publisher, it.via, it.source_id, it.mfl_article_id], [null, "read_on_mfl", "RotoWire", "MFL", "mfl", "rotowire990101"]);
  t.equal(it.url, "https://www48.myfantasyleague.com/2026/view_news_article?L=74598&ID=rotowire990101", "links to MFL's own article page");
  t.deepEqual(it.players.map((p) => [p.mfl_id, p.match, p.primary]), [["16211", "mfl_id", true]]);
  t.equal(it.published_precision, "day");
  t.ok(it.published_ts < NOW - 48 * 3600 && it.published_ts > NOW - 72 * 3600, "'2 days' = 48–72 h before the fetch");
  t.equal(v.mfl_news_url, "https://www48.myfantasyleague.com/2026/news_articles?L=74598&P=16211", "the MFL player link stays");
};
test("MFL: an MFL-only update is kept, metadata only, linked to MFL", () => mflOnlyCheck(M));

const dupCheck = (mod) => {
  const f = feedOf(mod, [...withRss([{ title: "Rams place Puka Nacua on injured reserve", link: "https://pfr.test/puka-ir", pubDate: date(2) }]),
    mflChunk(["16211"], { "16211": [{ id: "rotowire990102", headline: "WR Puka Nacua: Lands on IR with ankle sprain", published: "3 hours" }] })], OPTS);
  const v = mod.playerView(f, "16211", OPTS);
  t.equal(v.items.length, 1, "MFL + PFR report of one IR move = one story");
  t.equal(v.items[0].headline, "Rams place Puka Nacua on injured reserve", "led by the publisher whose headline we may show");
  t.deepEqual(v.items[0].also_reported_by.map((a) => [a.publisher, a.via, a.published_precision]), [["RotoWire", "MFL", "hour"]], "RotoWire keeps its own credit");
  t.equal(v.items[0].event, "ir_move");
};
test("MFL: the same event from MFL and an outside publisher is one story", () => dupCheck(M));

const twoUpdatesCheck = (mod) => {
  const f = feedOf(mod, [...withRss([{ title: "Saquon Barkley ruled out with hamstring injury", link: "https://pfr.test/sb-out", pubDate: date(8) }]),
    mflChunk(["13604"], { "13604": [
      { id: "rotowire990201", headline: "RB Saquon Barkley: Limited at practice Thursday", published: "2 days" },
      { id: "rotowire990202", headline: "RB Saquon Barkley: Limited again at Friday practice", published: "1 day" },
      { id: "rotowire990203", headline: "RB Saquon Barkley: Placed on IR with hamstring injury", published: "6 hours" },
    ] })], OPTS);
  const v = mod.playerView(f, "13604", OPTS);
  const ev = v.items.map((i) => i.event).sort();
  t.deepEqual(ev, ["designation", "ir_move", "practice", "practice"], "practice Thu, practice Fri, ruled out, IR move: four updates, none merged");
};
test("MFL: legitimate updates about one injury stay separate (practice ×2, designation, IR move)", () => twoUpdatesCheck(M));

const idCheck = (mod) => {
  // MFL filed it under 13675 (Tyler Conklin). The text names Ryan Izzo, MFL's
  // ESPN id for 13675 is Izzo's, and a stray alias points "Tyler Conklin" at
  // another player: the MFL id wins regardless.
  const ids = new Map([["13675", { espn_id: "3915486", rotowire_id: "12809" }]]);
  const f = feedOf(mod, [...quiet(), mflChunk(["13675"], { "13675": [{ id: "rotowire990301", headline: "TE Ryan Izzo: mentioned in a Tyler Conklin update", published: "5 hours" }] })],
    { ...OPTS, ids, aliases: [...FX.sleeper_aliases, { mfl_id: "14783", name: "Tyler Conklin" }] });
  const it = f.items.find((i) => i.mfl_article_id === "rotowire990301");
  t.deepEqual(it.players.map((p) => [p.mfl_id, p.match]), [["13675", "mfl_id"]], "only the MFL id MFL filed it under");
  t.equal(it.players[0].espn_id, "3915486", "MFL's own (conflicting) ESPN id is reported as MFL's, not used to re-match");
  t.equal(mod.playerView(f, "14783").items.length, 0, "the alias doesn't pull it to another player");
};
test("MFL: matched by the authoritative MFL id despite a conflicting name / third-party id", () => idCheck(M));

const outageCheck = (mod) => {
  const mflDown = feedOf(mod, [...recorded(), mflChunk(["16211", "14783"], {}, { fail: 429 })], OPTS);
  t.equal(mflDown.feed_state, "partial", "MFL down + publishers up = partial");
  t.equal(mflDown.sources.find((s) => s.id === "mfl").state, "error");
  t.equal(mod.playerView(mflDown, "16211").state, "partial", "Puka with MFL down is partial, never 'no recent items'");
  t.equal(mod.playerView(mflDown, "14783").state, "items", "Hurts still has publisher stories");
  const notAsked = feedOf(mod, [...recorded(), mflChunk(["14783"], {})], OPTS);
  t.equal(mod.playerView(notAsked, "16211").state, "partial", "MFL wasn't asked about Puka: partial");
  t.ok(mod.playerView(notAsked, "16211").unavailable_sources.includes("MFL Player News"));
  const answered = feedOf(mod, [...recorded(), mflChunk(["16211"], {})], OPTS);
  t.equal(mod.playerView(answered, "16211").state, "no_recent_items", "every source answered for Puka: no recent items");
  const half = feedOf(mod, [...recorded(), mflChunk(["16211"], {}), mflChunk(["14783"], {}, { fail: 503 })], OPTS);
  t.equal(half.sources.find((s) => s.id === "mfl").state, "incomplete", "one MFL chunk down = incomplete");
  t.equal(half.feed_state, "partial");
  const allDown = feedOf(mod, [...recorded({ pfr: { fail: 503 }, pft: { fail: 503 }, cbs: { fail: 503 }, yahoo: { fail: 503 } }), mflChunk(["16211"], {}, { fail: 503 })], OPTS);
  t.equal(allDown.feed_state, "unavailable");
  t.equal(mod.playerView(allDown, "16211").state, "unavailable");
};
test("MFL: down while publishers answer = partial; everything down = unavailable", () => outageCheck(M));

const licensedCheck = (mod) => {
  const f = feedOf(mod, [...withRss([{ title: "Rams place Puka Nacua on injured reserve", link: "https://pfr.test/puka-ir", pubDate: date(2) }]),
    mflChunk(["16211", "14783"], { "16211": [{ id: "rotowire990401", headline: "WR Puka Nacua: " + MARK + " lands on IR", published: "3 hours" }], "14783": [{ id: "rotowire990402", headline: "QB Jalen Hurts: " + MARK + " out for the season", published: "1 day" }] })], OPTS);
  for (const [label, out] of [["feed", mod.publicFeed(f)], ["player view", mod.playerView(f, "16211", OPTS)], ["legacy items", [...mod.legacyHeadlineItems(f, "16211"), ...mod.legacyHeadlineItems(f, "14783")]]]) {
    t.ok(!JSON.stringify(out).includes(MARK), "no licensed text in " + label);
  }
  t.ok(!("_mfl_checked" in mod.publicFeed(f)), "internal fields are dropped");
};
test("MFL: licensed text never reaches public output (feed, player view, legacy, preview)", () => licensedCheck(M));

const stableCheck = (mod) => {
  const a = feedOf(mod, [...quiet(), mflChunk(["14783"], { "14783": [{ id: "rotowire990501", headline: "QB Jalen Hurts: update", published: "5 hours" }] })], OPTS);
  const b = feedOf(mod, [...quiet(), mflChunk(["14783"], { "14783": [{ id: "RotoWire990501", headline: "QB Jalen Hurts: update (edited)", published: "1 day" }] })], OPTS);
  const ia = a.items.find((i) => i.source_id === "mfl"), ib = b.items.find((i) => i.source_id === "mfl");
  t.deepEqual([ia.id, ia.story_id], [ib.id, ib.story_id], "same article id → same item + story id, whatever its age or casing");
  t.equal(ia.publisher, "RotoWire"); t.equal(ib.publisher, "RotoWire", "provider spelling is normalized");
};
test("MFL: stable ids when MFL's age or attribution spelling changes", () => stableCheck(M));

test("MFL (mutation): reverting each rule is caught", async () => {
  await catches("licensed headline emitted", [["      headline: lead.licensed ? null : lead.headline,", "      headline: lead.headline,"]], licensedCheck);
  await catches("MFL item matched by name", [["    const players = [{ mfl_id: r.pid, match: \"mfl_id\", primary: true }];", "    const players = resolveStoryPlayers({ headline: r.headline, summary: \"\", tags: [] }, index).players;"]], idCheck);
  await catches("same-provider updates merge", [["  if (a._provider && a._provider === b._provider) return false;\n", ""], ["  if (a._provider && a._provider === b._provider) return true;\n", ""]], twoUpdatesCheck);
  await catches("different events merge", [["    if (ea !== eb) return false;                 // materially different updates\n", ""], ["  return SPECIFIC_EVENTS.has(ea) && SPECIFIC_EVENTS.has(eb) && ea !== eb;", "  return false;"]], twoUpdatesCheck);
  await catches("MFL silence counted for a player MFL wasn't asked about", [["  if (mflSource && mflSource.state !== \"error\" && !mflChecked && !unavailable.includes(mflSource.publisher)) unavailable.push(mflSource.publisher);\n", ""]], outageCheck);
  await catches("MFL outage ignored", [["  const okCount = sources.filter((s) => s.state === \"ok\").length;", "  const okCount = sources.filter((s) => s.state === \"ok\" || s.id === \"mfl\").length;"]], outageCheck);
  await catches("id from the age", [["    const id = \"n_\" + hash53(\"mfl:\" + r.article_id.toLowerCase());", "    const id = \"n_\" + hash53(\"mfl:\" + r.article_id + r.published);"]], stableCheck);
  await catches("MFL item not merged with a publisher", [["    if (gap <= (EVENT_WINDOW[ea] || EVENT_WINDOW_SECONDS)) return true;", "    if (gap < 0) return true;"]], dupCheck);
  await catches("MFL-only update dropped", [["  for (const r of mflRaw) {", "  for (const r of []) {"]], mflOnlyCheck);
});

// ── 6. the routes ────────────────────────────────────────────────────────────
const RealDate = Date;
globalThis.Date = class extends RealDate {
  constructor(...a) { super(...(a.length ? a : [NOW * 1000])); }
  static now() { return NOW * 1000; }
};
await import("./fixtures/register_md_loader.mjs");
const worker = (await import("../worker/src/index.js")).default;
const FETCHED = [];
let FEED_FAIL = new Set();
const MFL_ASKED = [];
const ROUTE_ROSTER = ["14783", "16211", "13635", "15001"];
// Synthetic MFL Player News (our own wording on real ids — no provider text is committed).
const ROUTE_MFL = {
  "14783": [{ id: "rotowire990001", headline: "QB Jalen Hurts: LICENSED-ROUTE-MARKER out for the season", published: "1 day" }],
  "13635": [{ id: "rotowire990002", headline: "WR DJ Moore: LICENSED-ROUTE-MARKER ruled out again", published: "2 days" }],
};
const json = (o, s) => new Response(JSON.stringify(o), { status: s || 200, headers: { "content-type": "application/json" } });
globalThis.fetch = async (input) => {
  const u = new URL(typeof input === "string" ? input : input.url);
  FETCHED.push(u.href);
  const src = M.RSS_SOURCES.find((s) => s.url === u.href);
  if (src) return FEED_FAIL.has(src.id) ? new Response("down", { status: 503 }) : new Response(rss(FX.feeds[src.id]), { status: 200, headers: { "content-type": "application/rss+xml" } });
  if (/myfantasyleague\.com$/.test(u.hostname) && u.searchParams.get("TYPE") === "rosters") return json({ rosters: { franchise: [{ id: "0008", player: ROUTE_ROSTER.map((id) => ({ id })) }] } });
  if (/myfantasyleague\.com$/.test(u.hostname) && u.searchParams.get("TYPE") === "playerProfile") {
    if (FEED_FAIL.has("mfl")) return new Response("busy", { status: 429 });
    MFL_ASKED.push(u.searchParams.get("P"));
    return json(profilesJson(u.searchParams.get("P").split(","), ROUTE_MFL));
  }
  if (/myfantasyleague\.com$/.test(u.hostname) && u.searchParams.get("TYPE") === "players") {
    const want = (u.searchParams.get("PLAYERS") || "").split(",").filter(Boolean);
    const rows = want.length ? PLAYERS.filter((p) => want.includes(p.id)) : PLAYERS;
    if (u.searchParams.get("DETAILS") === "1") return json({ players: { player: rows.map((p) => ({ ...p, ...(IDS.get(p.id) || {}) })) } });
    return json({ players: { player: rows } });
  }
  return json({ error: "test: no such call " + u.href }, 503);
};
function makeDb() {
  const db = makeD1({});
  db.raw.exec(fs.readFileSync(new URL("../worker/migrations/0141_sleeper_player_cache.sql", import.meta.url), "utf8"));
  db.raw.exec(`INSERT INTO sleeper_player_cache (mfl_player_id, sleeper_player_id, full_name, team, injury_status, injury_body_part, depth_chart_position, depth_chart_order, news_updated, matched_by, built_at_utc)
    VALUES ('14783','6904','Jalen Hurts','PHI','IR','Calf','QB',2,1792542046812,'rotowire_id','2026-10-21T12:00:00Z'),
           ('15001','7136','Kam Curl','LAR',NULL,NULL,'SS',1,1792400000000,'rotowire_id','2026-10-21T12:00:00Z')`);
  return db;
}
async function get(env, path) {
  const res = await worker.fetch(new Request("https://w.test" + path), env, { waitUntil() {}, passThroughOnException() {} });
  return { status: res.status, body: JSON.parse(await res.text()) };
}

test("route /api/player-news: legacy shape kept, headlines from the shared feed", async () => {
  FEED_FAIL = new Set(); FETCHED.length = 0;
  const env = { UPS_MFL_DB: makeDb() };
  const { status, body } = await get(env, "/api/player-news?pids=14783,16211&L=74598&YEAR=2026");
  t.equal(status, 200);
  for (const k of ["mfl_players_resolved", "sleeper_matched", "headline_pool", "sources", "espn_articles_pool", "generated_at"]) t.ok(k in body.meta, "legacy meta." + k);
  const hurts = body.items_by_pid["14783"];
  t.ok(hurts.some((i) => i.type === "status" && i.source === "Sleeper" && /IR \(Calf\)/.test(i.headline)), "Sleeper status card kept for legacy callers");
  const heads = hurts.filter((i) => i.type === "headline");
  t.ok(heads.length >= 5, "Hurts headlines: " + heads.length);
  for (const h of heads) {
    t.equal(h.body, "", "no article text");
    t.ok(["PFR", "PFT", "CBS", "Yahoo", "RotoWire via MFL"].includes(h.source), "legacy source label " + h.source);
    for (const k of ["type", "source", "timestamp", "headline", "body", "url"]) t.ok(k in h, "legacy item." + k);
  }
  t.deepEqual(body.items_by_pid["16211"], [], "Puka: nothing in the window, and MFL answered for him with no updates");
  const mfl = hurts.find((i) => i.via === "MFL");
  t.ok(mfl && /^RotoWire update \(season-ending\): read it on MFL$/.test(mfl.headline) && mfl.source === "RotoWire via MFL", "MFL update: neutral label, provider named, never the provider's text");
  t.match(mfl.url, /view_news_article\?L=74598&ID=rotowire990001$/);
  t.ok(!JSON.stringify(body).includes("LICENSED-ROUTE-MARKER"), "licensed text is not in the response");
  t.deepEqual(body.meta.player_state, { 14783: "items", 16211: "no_recent_items" });
  t.equal(body.meta.feed_state, "ok");
  t.equal(body.meta.mfl_news_url_by_pid["16211"], "https://www48.myfantasyleague.com/2026/news_articles?L=74598&P=16211");
  t.equal(body.meta.sleeper.state, "ok");
  t.ok(!FETCHED.some((u) => /espn\.com|reddit\.com/.test(u)), "ESPN and Reddit are no longer fetched");
  const w = env.UPS_MFL_DB.log.filter((x) => /^\s*(INSERT|UPDATE|DELETE|CREATE)/i.test(x.sql));
  t.equal(w.length, 0, "no D1 writes");
});
test("route /api/player-news: every feed down → 503, meta says unavailable, Sleeper card still there", async () => {
  FEED_FAIL = new Set(M.NEWS_SOURCES.map((s) => s.id));
  const { status, body } = await get({ UPS_MFL_DB: makeDb() }, "/api/player-news?pids=14783,16211&L=74598&YEAR=2026");
  t.equal(status, 503, "callers that check r.ok show 'unavailable', not 'no news'");
  t.equal(body.meta.feed_state, "unavailable");
  t.deepEqual(body.meta.player_state, { 14783: "unavailable", 16211: "unavailable" });
  t.ok(body.items_by_pid["14783"].some((i) => i.type === "status"), "the D1 status card is still returned");
  t.ok(body.meta.source_status.every((s) => s.state === "error" && s.http_status === (s.id === "mfl" ? 429 : 503)), "each source says why (MFL: 429 rate limit)");
});
test("route /api/player-news: a Sleeper read failure is reported, not swallowed", async () => {
  FEED_FAIL = new Set();
  const db = makeDb();
  db.raw.exec("DROP TABLE sleeper_player_cache");
  const { status, body } = await get({ UPS_MFL_DB: db }, "/api/player-news?pids=14783&L=74598&YEAR=2026");
  t.equal(status, 200);
  t.equal(body.meta.sleeper.state, "error");
  t.ok(body.items_by_pid["14783"].some((i) => i.type === "headline"), "headlines still served");
});
test("route /api/news-feed: League News + player filter; one D1 read (aliases), no writes", async () => {
  FEED_FAIL = new Set(["cbs"]);
  const env = { UPS_MFL_DB: makeDb() };
  const league = await get(env, "/api/news-feed?L=74598&YEAR=2026&limit=20");
  t.equal(league.status, 200);
  t.equal(league.body.contract, "ups.news.v1");
  t.equal(league.body.feed_state, "partial", "CBS down");
  t.equal(league.body.items.length, 20);
  t.ok(league.body.total_items > 20);
  t.equal(league.body.player_index.state, "ok");
  const inj = await get(env, "/api/news-feed?L=74598&YEAR=2026&category=injury");
  t.ok(inj.body.items.length > 0 && inj.body.items.every((i) => i.category === "injury"), "category filter");
  const pv = await get(env, "/api/news-feed?L=74598&YEAR=2026&pids=14783,16211,13635");
  t.equal(pv.body.players["14783"].state, "items");
  t.equal(pv.body.players["16211"].state, "partial", "no items while CBS is down = partial, not 'no news'");
  t.equal(pv.body.players["13635"].mfl_news_url, "https://www48.myfantasyleague.com/2026/news_articles?L=74598&P=13635");
  const p = pv.body.players["14783"].items[0].players.find((x) => x.mfl_id === "14783");
  t.deepEqual([p.espn_id, p.rotowire_id], ["4040715", "14416"]);
  const reads = env.UPS_MFL_DB.log;
  t.ok(reads.length >= 1 && reads.every((x) => /FROM sleeper_player_cache WHERE matched_by IN/.test(x.sql)), "only the alias read touches D1");
  FEED_FAIL = new Set(M.NEWS_SOURCES.map((s) => s.id));
  const down = await get(env, "/api/news-feed?L=74598&YEAR=2026&pids=16211");
  t.equal(down.status, 503);
  t.equal(down.body.players["16211"].state, "unavailable");
});

await run("news_feed");
