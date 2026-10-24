/* MFL Player News text, read in the OWNER'S browser on MFL's own pages (#1356).
 *
 * The shared feed (/api/news-feed, contract ups.news.v1) carries MFL Player News
 * as metadata only: provider, event, time, MFL article id, links. The provider's
 * words (RotoWire / Dynasty League Football / FFToday) are licensed to MFL, not
 * to us, so our Worker never returns or stores them.
 *
 * Inside MFL — the Front Office embed and the HPM modules run in the league's
 * own page on *.myfantasyleague.com — the owner's browser can ask MFL directly:
 * MFL's API answers browser calls from its own pages (it echoes the MFL origin
 * in Access-Control-Allow-Origin; MFL's developer page forbids API calls by
 * JavaScript only from pages OUTSIDE myfantasyleague.com). The text then goes
 * MFL → owner, on MFL's site, and never through UPS servers.
 *
 * Anywhere else (the phone app and standalone pages on github.io) MFL refuses
 * the call; `load` returns null and the screen keeps the metadata + "read on
 * MFL" links. Nothing here is cached or stored.
 *
 * Not wired into any screen yet (Keith authorizes those integrations
 * separately). Test: tests/mfl_player_news_client.test.mjs
 */
(function (root) {
  "use strict";

  function isMflOrigin(hostname) {
    return /(^|\.)myfantasyleague\.com$/i.test(String(hostname || ""));
  }

  function profileUrl(year, pids) {
    return "https://api.myfantasyleague.com/" + encodeURIComponent(String(year)) +
      "/export?TYPE=playerProfile&P=" + encodeURIComponent(pids.join(",")) + "&JSON=1";
  }

  // MFL JSON → { "<article id, lower-case>": { headline, mfl_id, published } }
  function parseProfiles(json) {
    var out = {};
    var root0 = json && (json.playerProfiles ? json.playerProfiles.playerProfile : json.playerProfile);
    var list = root0 == null ? [] : (Array.isArray(root0) ? root0 : [root0]);
    for (var i = 0; i < list.length; i++) {
      var p = list[i] || {};
      var arts = (p.news && p.news.article) || [];
      if (!Array.isArray(arts)) arts = [arts];
      for (var j = 0; j < arts.length; j++) {
        var a = arts[j];
        if (!a || !a.id) continue;
        out[String(a.id).toLowerCase()] = { headline: String(a.headline || ""), mfl_id: String(p.id || ""), published: String(a.published || "") };
      }
    }
    return out;
  }

  // Returns COPIES of the ups.news.v1 items with `mfl_text` on every MFL-led
  // item (and MFL entries in also_reported_by) whose article MFL just served.
  // Matching is by MFL article id only. A headline MFL no longer lists stays
  // without text (metadata + link), never guessed.
  function attachText(items, byArticle) {
    return (items || []).map(function (it) {
      var copy = Object.assign({}, it);
      var hit = it.mfl_article_id ? byArticle[String(it.mfl_article_id).toLowerCase()] : null;
      if (hit && it.headline_policy === "read_on_mfl") copy.mfl_text = { headline: hit.headline, source: "MFL" };
      copy.also_reported_by = (it.also_reported_by || []).map(function (a) {
        var h = a.mfl_article_id ? byArticle[String(a.mfl_article_id).toLowerCase()] : null;
        return h ? Object.assign({}, a, { mfl_text: { headline: h.headline, source: "MFL" } }) : a;
      });
      return copy;
    });
  }

  // On an MFL page: one browser call to MFL for these players (≤ 100 ids).
  // Off MFL: null (caller keeps metadata only). A failed call: { error }.
  function load(year, pids, opts) {
    opts = opts || {};
    var host = opts.hostname != null ? opts.hostname : (root.location && root.location.hostname);
    if (!isMflOrigin(host)) return Promise.resolve(null);
    var ids = (pids || []).map(String).filter(Boolean).slice(0, 100);
    if (!ids.length) return Promise.resolve({ byArticle: {} });
    var f = opts.fetch || root.fetch;
    return f(profileUrl(year, ids), { credentials: "omit", cache: "no-store" })
      .then(function (r) { if (!r.ok) throw new Error("MFL HTTP " + r.status); return r.json(); })
      .then(function (j) { if (j && j.error) throw new Error("MFL error"); return { byArticle: parseProfiles(j) }; })
      .catch(function (e) { return { error: String((e && e.message) || e) }; });
  }

  var api = { isMflOrigin: isMflOrigin, profileUrl: profileUrl, parseProfiles: parseProfiles, attachText: attachText, load: load };
  root.UPS_MFL_NEWS = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
