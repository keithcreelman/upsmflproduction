// Front Office player news (#1356): site/rosters/v2/fo_news.js over the shared
// feed ups.news.v1, plus the hooks in front_office.js.
//   1. Icon: highlighted ≤ 48 h, quieter older, none without a READABLE story
//      ABOUT the player (mentions and unreadable MFL-only items never make one). ±1 s.
//   2. Popup/tab states: items · items + "may be incomplete" · partial (nothing,
//      a source down) · mfl_only (only MFL updates we can't show here) · empty
//      (all answered) · unavailable (with retry) — an outage never reads as "no news".
//   3. Readable stories only (Keith 2026-10-22): headline, credit, approximate
//      time. Inside MFL = the headline MFL served, credited "RotoWire via MFL";
//      off MFL an MFL-only story is counted, never carded. No generic "update"
//      label. Credits exactly as the feed names them; Rotoworld is not a source.
//   4. Links: the headline links the original; other outlets; ONE MFL link only
//      when MFL updates are hidden; no footer of MFL links.
//   5. No injury designation in the news UI; escaping; no javascript: links.
//   6. front_office.js reads only the shared feed (no /api/player-news) and
//      loads fo_news.js on demand.
//   node tests/fo_news.test.mjs
import fs from "node:fs";
import { t, test, run } from "./fixtures/mini_test.mjs";
import { loadFrontOfficeV2 } from "./fixtures/front_office_v2_harness.mjs";
const F = (await import("../site/rosters/v2/fo_news.js")).default;
const NF = await import("../worker/src/news_feed.js");

const NOW = Date.parse("2026-10-22T13:40:00Z");
const S = NOW / 1000;
const OPTS = { now: NOW, leagueId: "74598", season: "2026", name: "Nacua, Puka" };
const item = (o) => Object.assign({ id: "n_" + Math.random().toString(16).slice(2, 10), story_id: "s_x", headline: "Rams place Puka Nacua on injured reserve", headline_policy: "display",
  publisher: "ProFootballRumors", via: null, source_id: "pfr", mfl_article_id: null, url: "https://www.profootballrumors.com/x", published_ts: S - 3600,
  published_precision: "exact", category: "injury", event: "ir_move", players: [{ mfl_id: "16211", match: "headline", primary: true }], also_reported_by: [] }, o);
const view = (items, o) => Object.assign({ mfl_id: "16211", state: items.length ? "items" : "no_recent_items", mfl_news_url: "https://www48.myfantasyleague.com/2026/news_articles?L=74598&P=16211",
  coverage: { since_ts: S - 12 * 3600, hours: 12 }, mfl_checked: true, unavailable_sources: [], item_ids: items.map((i) => i.id), items }, o);
const MFL_ITEM = item({ headline: null, headline_policy: "read_on_mfl", publisher: "RotoWire", via: "MFL", source_id: "mfl", mfl_article_id: "rotowire990801",
  url: "https://www48.myfantasyleague.com/2026/view_news_article?L=74598&ID=rotowire990801", published_precision: "hour", event: "designation",
  players: [{ mfl_id: "16211", match: "mfl_id", primary: true }] });

const WITH_TEXT = (it, h) => Object.assign({}, it, { mfl_text: { headline: h, source: "MFL" } });

test("icon: readable stories only — fresh ≤ 48 h, older after, none otherwise (±1 s)", () => {
  const at = (age) => F.badgeLevel(view([item({ published_ts: S - age })]), "16211", { now: NOW });
  t.equal(at(F.FRESH_SECONDS - 1), "fresh");
  t.equal(at(F.FRESH_SECONDS), "fresh", "exactly 48 h is still fresh");
  t.equal(at(F.FRESH_SECONDS + 1), "older");
  t.equal(at(F.WINDOW_SECONDS), "older");
  t.equal(at(F.WINDOW_SECONDS + 1), null, "past the ~7-day window: no icon");
  t.equal(F.badgeLevel(view([]), "16211", { now: NOW }), null);
  const mention = item({ players: [{ mfl_id: "16211", match: "summary", primary: false }] });
  t.equal(F.badgeLevel(view([mention]), "16211", { now: NOW }), null, "a summary-only mention makes no icon");
  t.equal(F.badgeLevel(view([MFL_ITEM]), "16211", { now: NOW }), null, "standalone: an MFL-only story isn't readable, so no icon");
  t.equal(F.badgeLevel(view([WITH_TEXT(MFL_ITEM, "SYNTHETIC")]), "16211", { now: NOW, insideMfl: true }), "fresh", "inside MFL with MFL's headline: readable");
  t.equal(F.badgeLevel(view([MFL_ITEM]), "16211", { now: NOW, insideMfl: true }), null, "inside MFL but MFL's headline didn't load: no icon");
  t.match(F.badgeHtml("16211", "fresh", "Nacua, Puka"), /class="fo-nw-icon fo-nw-fresh"[^>]*data-fo-news-pid="16211"/);
  t.equal(F.badgeHtml("16211", null, ""), "");
});

test("states: items · may-be-incomplete · partial · mfl_only · empty · unavailable", () => {
  const m1 = F.listModel(view([item({})]), "16211", OPTS);
  t.deepEqual([m1.state, m1.note, m1.items.length, m1.more], ["items", "", 1, null]);
  const m2 = F.listModel(view([item({})], { unavailable_sources: ["CBS Sports"] }), "16211", OPTS);
  t.equal(m2.state, "items"); t.match(m2.note, /didn't answer \(CBS Sports\)\. This list may be incomplete/);
  const m3 = F.listModel(view([], { state: "partial", unavailable_sources: ["MFL Player News"] }), "16211", OPTS);
  t.equal(m3.state, "partial"); t.match(m3.note, /Nothing found for Puka Nacua, but some sources didn't answer \(MFL Player News\)/);
  const m4 = F.listModel(view([]), "16211", OPTS);
  t.equal(m4.state, "empty"); t.equal(m4.note, "No stories about Puka Nacua in the last ~7 days.");
  const m5 = F.listModel(view([], { state: "unavailable" }), "16211", OPTS);
  t.equal(m5.state, "unavailable"); t.doesNotMatch(m5.note, /^No stories/);
  t.match(F.panelHtml(m5), /data-fo-nw-retry/, "unavailable offers a retry");
  t.equal(F.listModel(null, "16211", Object.assign({ failed: true }, OPTS)).state, "unavailable", "a failed read is unavailable, never empty");
  const m6 = F.listModel(view([MFL_ITEM]), "16211", OPTS);
  t.deepEqual([m6.state, m6.items.length, m6.more.count, m6.more.providers], ["mfl_only", 0, 1, ["RotoWire"]], "standalone: MFL-only news is counted, not carded");
  t.equal(m6.note, "No story we can show here for Puka Nacua in the last ~7 days.");
  const onlyMention = F.listModel(view([item({ players: [{ mfl_id: "16211", match: "summary", primary: false }] })]), "16211", OPTS);
  t.equal(onlyMention.state, "empty", "a story that only mentions him is not listed as his news");
});

test("cards: headline, then credit and approximate time; newest first; never a generic label", () => {
  const old = item({ id: "n_old", headline: "Older story", published_ts: S - 3 * 86400 });
  const m = F.listModel(view([old, MFL_ITEM, item({ id: "n_new", headline: "Newest story", published_ts: S - 600 })]), "16211", OPTS);
  t.deepEqual(m.items.map((i) => i.text), ["Newest story", "Older story"], "the MFL-only story is not a card off MFL");
  t.deepEqual(m.items.map((i) => i.time), ["10 min ago", "3 d ago"]);
  t.deepEqual(m.more && m.more.count, 1);
  const html = F.panelHtml(m);
  const cards = (html.match(/<ul class="fo-nw-list">[\s\S]*<\/ul>/) || [""])[0];
  t.doesNotMatch(cards, /\bupdate\b|Open story|fo-nw-ev|Read on MFL/, "cards: no generic 'update' label, no event chip, no link-only text");
  t.match(html, /<a class="fo-nw-h" href="https:\/\/www\.profootballrumors\.com\/x"[^>]*>Newest story<\/a>/, "the headline is the link to the original");
  t.match(html, /ProFootballRumors<\/span> · 10 min ago/);
  const mid = NF.parseMflAge("5 days", S);
  t.equal(F.ago(mid.ts, mid.precision, S), "about 5 d ago", "MFL '5 days' reads 'about 5 d', MFL's own number");
  const midH = NF.parseMflAge("11 hours", S);
  t.equal(F.ago(midH.ts, midH.precision, S), "about 11 h ago");
});

test("inside MFL: MFL's headline with the provider's credit; never shown off MFL", () => {
  const inside = F.listModel(view([WITH_TEXT(MFL_ITEM, "SYNTHETIC headline from MFL")]), "16211", Object.assign({ insideMfl: true }, OPTS));
  t.deepEqual([inside.state, inside.items[0].text, inside.items[0].credit, inside.items[0].time], ["items", "SYNTHETIC headline from MFL", "RotoWire via MFL", "about 1 h ago"]);
  t.equal(inside.more, null, "nothing hidden: no MFL link");
  const off = F.listModel(view([WITH_TEXT(MFL_ITEM, "SYNTHETIC headline from MFL")]), "16211", OPTS);
  t.ok(!/SYNTHETIC/.test(F.panelHtml(off)), "off MFL the text is never shown, even if present");
});

test("links: the story, other outlets; one MFL link only when MFL updates are hidden", () => {
  const it = item({ also_reported_by: [{ id: "n_y", publisher: "Yahoo Sports", via: null, url: "https://sports.yahoo.com/a" }, { id: "n_m", publisher: "RotoWire", via: "MFL", mfl_article_id: "rotowire9", url: "https://www48.myfantasyleague.com/2026/view_news_article?L=74598&ID=rotowire9" }] });
  const html = F.panelHtml(F.listModel(view([it]), "16211", OPTS));
  t.match(html, /Also: <a href="https:\/\/sports\.yahoo\.com\/a"[^>]*>Yahoo Sports<\/a>, <a [^>]*>RotoWire via MFL<\/a>/);
  t.doesNotMatch(html, /news_articles|See all MFL Player News|MFL Player News for/, "no footer of MFL links");
  const hiddenHtml = F.panelHtml(F.listModel(view([it, MFL_ITEM]), "16211", OPTS));
  t.equal((hiddenHtml.match(/myfantasyleague\.com\/2026\/news_articles/g) || []).length, 1, "exactly one MFL link, for the hidden update");
  t.match(hiddenHtml, /Also on MFL: 1 RotoWire update\. <a [^>]*>Read on MFL ↗<\/a>/);
  const onlyHtml = F.panelHtml(F.listModel(view([MFL_ITEM]), "16211", OPTS));
  t.match(onlyHtml, /MFL has 1 RotoWire update about him\. <a [^>]*>Read on MFL ↗<\/a>/);
  t.doesNotMatch(onlyHtml, /<li/, "no card");
});

test("credits exactly as given; RotoWire is not Rotoworld; no Rotoworld source", () => {
  const rw = F.listModel(view([WITH_TEXT(MFL_ITEM, "SYNTHETIC")]), "16211", Object.assign({ insideMfl: true }, OPTS)).items[0];
  t.equal(rw.credit, "RotoWire via MFL");
  const other = F.listModel(view([item({ publisher: "Rotoworld", via: null })]), "16211", OPTS).items[0];
  t.equal(other.credit, "Rotoworld", "a feed-named publisher is shown as named, never merged into RotoWire");
  t.ok(!NF.NEWS_SOURCES.some((s) => /rotoworld/i.test(s.publisher + s.id)), "Rotoworld is not a source in this PR");
});

test("safety: escaped text, no javascript: links, no injury designation in news", () => {
  const evil = item({ headline: "<img src=x onerror=alert(1)> Puka", url: "javascript:alert(1)" });
  const html = F.panelHtml(F.listModel(view([evil]), "16211", OPTS));
  t.doesNotMatch(html, /<img/); t.doesNotMatch(html, /javascript:/);
  const src = fs.readFileSync(new URL("../site/rosters/v2/fo_news.js", import.meta.url), "utf8");
  t.doesNotMatch(src, /injuryStatus|injury_status|injuries export|nflStatus/, "fo_news.js reads no injury designation");
});

test("front_office.js: shared feed only, fo_news.js on demand, icon via UPS_FO_NEWS", () => {
  const src = fs.readFileSync(new URL("../site/rosters/v2/front_office.js", import.meta.url), "utf8");
  t.doesNotMatch(src, /apiUrl\("\/api\/player-news"\)/, "no more legacy /api/player-news reads");
  t.match(src, /loadScriptOnce\(assetUrl\("fo_news\.js\?v=/);
  t.match(src, /loadScriptOnce\(assetUrl\("\.\.\/\.\.\/shared\/mfl_player_news\.js\?v=/);
  t.doesNotMatch(src, /MFL Injury · /, "the News tab no longer repeats the injury designation");
  const stub = { isLoaded: () => true, rosterBadge: (pid, name) => `[icon ${pid} ${name}]` };
  const { hooks } = loadFrontOfficeV2({ UPS_FO_NEWS: stub }, { hooks: ["newsFlagBadge"] });
  t.equal(hooks.newsFlagBadge("16211"), "[icon 16211 ]", "the roster icon comes from fo_news.js");
  const { hooks: h2 } = loadFrontOfficeV2({}, { hooks: ["newsFlagBadge"] });
  t.equal(h2.newsFlagBadge("16211"), "", "no module loaded yet: no icon (never a guess)");
});

await run("fo_news");
