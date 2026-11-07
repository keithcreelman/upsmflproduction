// site/shared/mfl_player_news.js — MFL Player News text read in the owner's
// browser on MFL's own pages, attached to ups.news.v1 items by MFL article id (#1356).
//   1. Off MFL (github.io, pages.dev) it makes NO call and returns null.
//   2. On MFL it makes one call to MFL's api host for the given ids.
//   3. Text attaches by MFL article id only (case-insensitive), to MFL-led items
//      and MFL entries in also_reported_by; publisher items are untouched.
//   4. A failed MFL call is reported ({ error }), never an empty "no news".
// Synthetic MFL text only (provider text is licensed; none is committed).
//   node tests/mfl_player_news_client.test.mjs
import { t, test, run } from "./fixtures/mini_test.mjs";
const N = (await import("../site/shared/mfl_player_news.js")).default;

const MFL_JSON = { playerProfiles: { playerProfile: [
  { id: "16211", news: { article: [{ id: "rotowire990701", headline: "SYNTHETIC: Puka update", published: "3 hours" }] } },
  { id: "14783", news: { article: { id: "RotoWire990702", headline: "SYNTHETIC: Hurts update", published: "1 day" } } },
  { id: "13635", news: {} },
] } };
const ITEMS = [
  { id: "n_a", headline: null, headline_policy: "read_on_mfl", mfl_article_id: "rotowire990701", also_reported_by: [] },
  { id: "n_b", headline: "Publisher headline", headline_policy: "display", mfl_article_id: null, also_reported_by: [{ id: "n_c", publisher: "RotoWire", via: "MFL", mfl_article_id: "rotowire990702" }] },
  { id: "n_d", headline: null, headline_policy: "read_on_mfl", mfl_article_id: "rotowire999999", also_reported_by: [] },
];

test("off MFL: no call, null", async () => {
  let calls = 0;
  const f = async () => { calls++; return new Response("{}"); };
  for (const host of ["keithcreelman.github.io", "ups-news-feed-preview.pages.dev", "evil-myfantasyleague.com.example", ""]) {
    t.equal(await N.load(2026, ["16211"], { hostname: host, fetch: f }), null, host || "(none)");
  }
  t.equal(calls, 0, "never asks MFL from a non-MFL page");
});

test("on MFL: one call to MFL's api host, text attached by article id", async () => {
  const urls = [];
  const f = async (u) => { urls.push(u); return new Response(JSON.stringify(MFL_JSON), { status: 200 }); };
  const r = await N.load(2026, ["16211", "14783", "13635"], { hostname: "www48.myfantasyleague.com", fetch: f });
  t.deepEqual(urls, ["https://api.myfantasyleague.com/2026/export?TYPE=playerProfile&P=16211%2C14783%2C13635&JSON=1"]);
  const out = N.attachText(ITEMS, r.byArticle);
  t.deepEqual(out[0].mfl_text, { headline: "SYNTHETIC: Puka update", source: "MFL" }, "MFL-led item gets MFL's text");
  t.equal(out[1].mfl_text, undefined, "a publisher-led item is not touched");
  t.deepEqual(out[1].also_reported_by[0].mfl_text, { headline: "SYNTHETIC: Hurts update", source: "MFL" }, "MFL credit inside a merged story gets its text (case-insensitive id)");
  t.equal(out[2].mfl_text, undefined, "an article MFL no longer lists stays metadata-only, never guessed");
  t.equal(ITEMS[0].mfl_text, undefined, "inputs are not mutated");
  t.equal(r.byArticle.rotowire990701.mfl_id, "16211", "each text keeps the MFL id it was filed under");
});

test("on MFL: a failed call is an error, not 'no news'", async () => {
  const r429 = await N.load(2026, ["16211"], { hostname: "www48.myfantasyleague.com", fetch: async () => new Response("busy", { status: 429 }) });
  t.ok(r429 && r429.error && /429/.test(r429.error));
  const rErr = await N.load(2026, ["16211"], { hostname: "www48.myfantasyleague.com", fetch: async () => new Response(JSON.stringify({ error: { $t: "Invalid request" } })) });
  t.ok(rErr && rErr.error);
  const rNet = await N.load(2026, ["16211"], { hostname: "www48.myfantasyleague.com", fetch: async () => { throw new Error("offline"); } });
  t.ok(rNet && /offline/.test(rNet.error));
});

await run("mfl_player_news_client");
