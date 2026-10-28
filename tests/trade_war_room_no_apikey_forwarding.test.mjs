// The War Room never forwards an APIKEY from the page (S8): not into worker requests (site/trades/trade_workbench.js
// getBrowserSessionParams) and not into the War Room iframe URL (site/trades/mfl_hpm_embed_loader.js). MFL_USER_ID
// still rides in the query -- the worker reads it only there -- so owners keep working exactly as before.
//   node tests/trade_war_room_no_apikey_forwarding.test.mjs
import fs from "node:fs";
import vm from "node:vm";
import { t, test, run } from "./fixtures/mini_test.mjs";
import { quiet } from "./fixtures/worker_harness.mjs";
import { settle } from "./fixtures/fake_dom.mjs";
import { bootDesktop, pageWorld, readyOffer } from "./fixtures/war_room_page.mjs";

const restore = quiet();
const LOADER_SRC = fs.readFileSync(new URL("../site/trades/mfl_hpm_embed_loader.js", import.meta.url), "utf8");
const PAGE_KEY = "PAGE-APIKEY-SECRET", WIN_KEY = "WINDOW-APIKEY-SECRET";

test("WAR ROOM: with an APIKEY in the page URL and on window, no worker request carries it; MFL_USER_ID still does, and an owner's offer still sends", async () => {
  const w = pageWorld();
  const urls = [];
  const d = await bootDesktop(w, { token: "tok-B", fid: "0001", extraQuery: "&APIKEY=" + PAGE_KEY, win: { APIKEY: WIN_KEY },
    override: async (u) => { urls.push(u); return null; } });
  t.ok(d.api, "War Room booted");
  t.equal(readyOffer(d, "hi"), "ready");
  await d.api.submitOfferToQueue(); await settle(30);
  t.equal(w.mfl.st.pending.length, 1, "the owner's offer reached MFL");
  const workerUrls = urls.filter((u) => new URL(u).hostname === "upsmflproduction.keith-creelman.workers.dev");
  t.ok(workerUrls.some((u) => /\/trade-workbench/.test(u)) && workerUrls.some((u) => /\/trade-offers/.test(u)), "loads, the offers list and the send all went to the worker");
  for (const u of workerUrls) {
    t.doesNotMatch(u, /APIKEY|apikey/, u.split("?")[0]);
    t.ok(!u.includes(PAGE_KEY) && !u.includes(WIN_KEY), u.split("?")[0]);
    t.equal(new URL(u).searchParams.get("MFL_USER_ID"), "tok-B", `${u.split("?")[0]} still carries the owner's session`);
  }
});

function runLoader(pageHref, { winApiKey } = {}) {
  const created = [];
  const el = () => { const e = { style: {}, attrs: {}, children: [], setAttribute(k, v) { e.attrs[k] = v; }, appendChild(c) { e.children.push(c); return c; } }; created.push(e); return e; };
  const mount = el();
  const doc = { cookie: "", currentScript: { src: "https://keithcreelman.github.io/upsmflproduction/trades/mfl_hpm_embed_loader.js" }, getElementById: (id) => (id === "twbMount" ? mount : null), createElement: () => el(), body: el(), documentElement: el() };
  const win = { location: new URL(pageHref), addEventListener() {}, ...(winApiKey ? { APIKEY: winApiKey } : {}) };
  const ctx = { window: win, document: doc, URL, URLSearchParams, encodeURIComponent, decodeURIComponent, isFinite, Number, String, Math };
  vm.createContext(ctx);
  vm.runInContext(LOADER_SRC, ctx, { filename: "site/trades/mfl_hpm_embed_loader.js" });
  return new URL(mount.children[0].src);
}

test("LOADER: the War Room iframe URL never carries the MFL page's APIKEY (query or window), but still carries MFL_USER_ID", () => {
  const src = runLoader(`https://www48.myfantasyleague.com/2026/home/74598?MODULE=MESSAGE14&L=74598&YEAR=2026&MFL_USER_ID=tok-B&APIKEY=${PAGE_KEY}`, { winApiKey: WIN_KEY });
  t.equal(src.searchParams.get("APIKEY"), null);
  t.ok(!src.href.includes(PAGE_KEY) && !src.href.includes(WIN_KEY));
  t.equal(src.searchParams.get("MFL_USER_ID"), "tok-B");
  t.equal(src.searchParams.get("L"), "74598");
});

await run("trade_war_room_no_apikey_forwarding");
