// Front Office player news (#1356): site/rosters/v2/fo_news.js over the shared
// feed ups.news.v1, plus the hooks in front_office.js.
//   1. Icon: highlighted ≤ 48 h, quieter older, none without a story ABOUT the
//      player (a summary-only mention never makes an icon). Boundaries ±1 s.
//   2. Popup/tab states: items · items + "may be incomplete" · partial (nothing,
//      a source down) · empty (all answered) · unavailable (with retry) — an
//      outage never reads as "no news".
//   3. MFL items: standalone = event label + "Read on MFL"; inside MFL = the
//      headline MFL served, credited "RotoWire via MFL". Credits exactly as the
//      feed names them; Rotoworld is not a source.
//   4. Links: original story, other outlets, the player's MFL page, the
//      league's "See all MFL Player News" (2026, L=74598, PLAYERS=A).
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

test("icon: fresh ≤ 48 h, older after, none without a story about him (±1 s)", () => {
  const at = (age) => F.badgeLevel(view([item({ published_ts: S - age })]), "16211", { now: NOW });
  t.equal(at(F.FRESH_SECONDS - 1), "fresh");
  t.equal(at(F.FRESH_SECONDS), "fresh", "exactly 48 h is still fresh");
  t.equal(at(F.FRESH_SECONDS + 1), "older");
  t.equal(at(F.WINDOW_SECONDS), "older");
  t.equal(at(F.WINDOW_SECONDS + 1), null, "past the ~7-day window: no icon");
  t.equal(F.badgeLevel(view([]), "16211", { now: NOW }), null);
  const mention = item({ players: [{ mfl_id: "16211", match: "summary", primary: false }] });
  t.equal(F.badgeLevel(view([mention]), "16211", { now: NOW }), null, "a summary-only mention makes no icon");
  t.match(F.badgeHtml("16211", "fresh", "Nacua, Puka"), /class="fo-nw-icon fo-nw-fresh"[^>]*data-fo-news-pid="16211"/);
  t.match(F.badgeHtml("16211", "older", ""), /fo-nw-older/);
  t.equal(F.badgeHtml("16211", null, ""), "");
});

test("states: items · may-be-incomplete · partial · empty · unavailable", () => {
  const m1 = F.listModel(view([item({})]), "16211", OPTS);
  t.deepEqual([m1.state, m1.note, m1.items.length], ["items", "", 1]);
  const m2 = F.listModel(view([item({})], { unavailable_sources: ["CBS Sports"] }), "16211", OPTS);
  t.equal(m2.state, "items"); t.match(m2.note, /didn't answer \(CBS Sports\)\. This list may be incomplete/);
  const m3 = F.listModel(view([], { state: "partial", unavailable_sources: ["MFL Player News"] }), "16211", OPTS);
  t.equal(m3.state, "partial"); t.match(m3.note, /Nothing found for Puka Nacua, but some sources didn't answer \(MFL Player News\)/);
  const m4 = F.listModel(view([]), "16211", OPTS);
  t.equal(m4.state, "empty"); t.equal(m4.note, "No stories about Puka Nacua in the last ~7 days.");
  const m5 = F.listModel(view([], { state: "unavailable" }), "16211", OPTS);
  t.equal(m5.state, "unavailable"); t.doesNotMatch(m5.note, /^No stories/);
  t.match(F.panelHtml(m5), /data-fo-nw-retry/, "unavailable offers a retry");
  const m6 = F.listModel(null, "16211", Object.assign({ failed: true }, OPTS));
  t.equal(m6.state, "unavailable", "a failed read is unavailable, never empty");
  const onlyMention = F.listModel(view([item({ players: [{ mfl_id: "16211", match: "summary", primary: false }] })]), "16211", OPTS);
  t.equal(onlyMention.state, "empty", "a story that only mentions him is not listed as his news");
});

test("chronological, newest first; approximate time; MFL shown honestly", () => {
  const old = item({ id: "n_old", headline: "Older story", published_ts: S - 3 * 86400 });
  const m = F.listModel(view([old, MFL_ITEM, item({ id: "n_new", headline: "Newest story", published_ts: S - 600 })]), "16211", OPTS);
  t.deepEqual(m.items.map((i) => i.text || i.label), ["Newest story", "RotoWire update · Game status", "Older story"]);
  t.deepEqual(m.items.map((i) => i.time), ["10 min ago", "about 1 h ago", "3 d ago"]);
  // MFL "5 days" (5–6 d) is stored as its midpoint, 5.5 d: it must read "about 5 d", MFL's own number.
  const mid = NF.parseMflAge("5 days", S);
  t.equal(F.ago(mid.ts, mid.precision, S), "about 5 d ago");
  const midH = NF.parseMflAge("11 hours", S);
  t.equal(F.ago(midH.ts, midH.precision, S), "about 11 h ago");
  const standalone = m.items[1];
  t.deepEqual([standalone.text, standalone.credit, standalone.linkText], [null, "RotoWire via MFL", "Read on MFL"]);
  const inside = F.listModel(view([Object.assign({}, MFL_ITEM, { mfl_text: { headline: "SYNTHETIC headline from MFL", source: "MFL" } })]), "16211", Object.assign({ insideMfl: true }, OPTS));
  t.deepEqual([inside.items[0].text, inside.items[0].credit], ["SYNTHETIC headline from MFL", "RotoWire via MFL"], "inside MFL: MFL's headline with the provider's credit");
  const notInside = F.listModel(view([Object.assign({}, MFL_ITEM, { mfl_text: { headline: "SYNTHETIC headline from MFL" } })]), "16211", OPTS);
  t.equal(notInside.items[0].text, null, "off MFL the text is never shown, even if present");
  t.ok(!/SYNTHETIC/.test(F.panelHtml(notInside)));
});

test("credits exactly as given; RotoWire is not Rotoworld; no Rotoworld source", () => {
  const rw = F.listModel(view([MFL_ITEM]), "16211", OPTS).items[0];
  t.equal(rw.credit, "RotoWire via MFL");
  const other = F.listModel(view([item({ publisher: "Rotoworld", via: null })]), "16211", OPTS).items[0];
  t.equal(other.credit, "Rotoworld", "a feed-named publisher is shown as named, never merged into RotoWire");
  t.ok(!NF.NEWS_SOURCES.some((s) => /rotoworld/i.test(s.publisher + s.id)), "Rotoworld is not a source in this PR");
});

test("links: story, other outlets, player's MFL page, See all MFL Player News", () => {
  const it = item({ also_reported_by: [{ id: "n_y", publisher: "Yahoo Sports", via: null, url: "https://sports.yahoo.com/a" }, { id: "n_m", publisher: "RotoWire", via: "MFL", mfl_article_id: "rotowire9", url: "https://www48.myfantasyleague.com/2026/view_news_article?L=74598&ID=rotowire9" }] });
  const html = F.panelHtml(F.listModel(view([it]), "16211", OPTS));
  t.match(html, /href="https:\/\/www\.profootballrumors\.com\/x"/);
  t.match(html, /href="https:\/\/sports\.yahoo\.com\/a"[^>]*>Yahoo Sports</);
  t.match(html, />RotoWire via MFL</);
  t.match(html, /href="https:\/\/www48\.myfantasyleague\.com\/2026\/news_articles\?L=74598&amp;P=16211"[^>]*>MFL Player News for Puka Nacua/);
  t.match(html, /href="https:\/\/www48\.myfantasyleague\.com\/2026\/news_articles\?L=74598&amp;PLAYERS=A"[^>]*>See all MFL Player News/);
  t.doesNotMatch(html, /<iframe/i, "no embedded MFL page");
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
