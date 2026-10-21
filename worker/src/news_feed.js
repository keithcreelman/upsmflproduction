// SHARED EXTERNAL NEWS FEED — contract "ups.news.v1" (Keith 2026-10-21, #1356)
//
// ONE builder for every surface that shows outside NFL/player news: League News
// (the whole feed), the player panel (the feed filtered to one player), the
// legacy /api/player-news shape, and later UPS Wire editor leads. Clients render
// the states this returns and never re-derive them.
//
// WHAT WE MAY SHOW (audit #1356). Only headline + publisher + time + link from
// publisher RSS feeds that are published for syndication. Never article text:
// the RSS summary is read in memory to find which players a story is about and
// to pick its category, then dropped. It is not returned and not stored.
// MFL's player news (RotoWire / FFToday / Dynasty League Football) is NOT here:
// MFL's API terms say third-party news can't be made available, so each player
// gets a link to MFL's own Player News page instead (mflNewsUrl).
//
// Sources removed 2026-10-21: ESPN's site.api (undocumented; 0 items reach the
// Worker) and Reddit r/nfl JSON (403, and Reddit's Data API needs registration).
//
// WHO A STORY IS ABOUT. RSS carries no player ids, so a story is resolved ONCE,
// against MFL's whole player list, to a stable MFL id (plus the ESPN and
// RotoWire ids MFL publishes for that player). A name resolves only when it is
// a full name that belongs to exactly one player. When two players share it
// (Justin Jefferson WR MIN / LB CLE) a team or position named in the same story
// must pick one, or the mention is left unresolved and counted. Never a last
// name alone, never "first name anywhere + last name anywhere" (the old rule
// put an article about Russell Wilson under Emmanuel Wilson). Nicknames come
// from Sleeper's full_name, joined to the MFL id by RotoWire/ESPN id offline
// (scripts/build_sleeper_cache.py), never by name.
//
// NEVER TURN AN OUTAGE INTO "NO NEWS". Every source reports its own state, the
// feed has one overall state (ok | partial | unavailable), and a player view
// has exactly one of: items | no_recent_items | partial | unavailable |
// unknown_player. "no_recent_items" is only possible when every source answered,
// and it carries the window it covers ("since <ts>").

export const NEWS_CONTRACT = "ups.news.v1";

// Approved sources. `label` is the value legacy /api/player-news callers
// already render in item.source; keep it stable.
export const NEWS_SOURCES = [
  { id: "pfr", publisher: "ProFootballRumors", label: "PFR", url: "https://www.profootballrumors.com/feed" },
  { id: "pft", publisher: "ProFootballTalk", label: "PFT", url: "https://profootballtalk.nbcsports.com/feed/" },
  { id: "cbs", publisher: "CBS Sports", label: "CBS", url: "https://www.cbssports.com/rss/headlines/nfl/" },
  { id: "yahoo", publisher: "Yahoo Sports", label: "Yahoo", url: "https://sports.yahoo.com/nfl/rss.xml" },
];

// A source whose newest item is older than this is answering but not updating.
export const STALE_SOURCE_SECONDS = 72 * 3600;
// Two copies of one story must be published within this window to merge.
export const DEDUPE_WINDOW_SECONDS = 36 * 3600;

export function mflNewsUrl(year, leagueId, pid, host) {
  const h = host || "www48.myfantasyleague.com";
  return `https://${h}/${encodeURIComponent(String(year))}/news_articles?L=${encodeURIComponent(String(leagueId))}&P=${encodeURIComponent(String(pid))}`;
}

// ── text helpers ─────────────────────────────────────────────────────────────
const ENTITY = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", ndash: "–", mdash: "—", hellip: "…" };
export function decodeEntities(s) {
  return String(s == null ? "" : s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === "#") {
      const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    const v = ENTITY[e.toLowerCase()];
    return v == null ? m : v;
  });
}
const plainText = (s) => decodeEntities(String(s || "")
  .replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/i, "$1")
  .replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();

// cyrb53 — a small deterministic 53-bit string hash (ids only, not security).
function hash53(str) {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, "0");
}

// The same article fetched twice (a refresh, or http vs https, or a tracking
// query) must get the same id.
export function canonicalUrl(u) {
  const s = String(u || "").trim();
  if (!s) return "";
  try {
    const p = new URL(s);
    if (p.protocol !== "http:" && p.protocol !== "https:") return "";
    const path = p.pathname.replace(/\/+$/, "") || "/";
    return `https://${p.hostname.toLowerCase().replace(/^www\./, "")}${path}`;
  } catch (_) {
    return "";
  }
}
export function itemId(url, publisherId, headline) {
  const c = canonicalUrl(url);
  return "n_" + hash53(c || `${publisherId}|${normName(headline)}`);
}

// ── RSS ──────────────────────────────────────────────────────────────────────
// Reads title, link, pubDate, every <category>, and description. content:encoded
// (the full article) is never read.
export function parseRss(xml) {
  const out = [];
  if (!xml || typeof xml !== "string") return out;
  const chunks = xml.split(/<item[\s>]/i).slice(1);
  for (const chunk of chunks) {
    const end = chunk.search(/<\/item>/i);
    const body = (end >= 0 ? chunk.slice(0, end) : chunk).replace(/<content:encoded[\s\S]*?<\/content:encoded>/gi, "");
    const pick = (tag) => {
      const m = body.match(new RegExp("<" + tag + "(?:\\s[^>]*)?>([\\s\\S]*?)</" + tag + ">", "i"));
      return m ? plainText(m[1]) : "";
    };
    const tags = [];
    const re = /<category(?:\s[^>]*)?>([\s\S]*?)<\/category>/gi;
    let m;
    while ((m = re.exec(body))) { const v = plainText(m[1]); if (v) tags.push(v); }
    const headline = pick("title");
    const url = pick("link") || (/isPermaLink="true"/i.test(body) ? pick("guid") : "");
    const date = pick("pubDate") || pick("dc:date");
    const parsed = date ? Date.parse(date) : NaN;
    if (!headline) continue;
    out.push({ headline, summary: pick("description"), url, published_ts: Number.isFinite(parsed) ? Math.floor(parsed / 1000) : 0, tags });
  }
  return out;
}

// ── names → stable ids ──────────────────────────────────────────────────────
const SUFFIX_RE = /\s(jr|sr|ii|iii|iv|v)$/;
export function normName(s) {
  return String(s || "")
    .normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/['’](s)\b/g, "")        // possessive: Hurts's / Hurts’s
    .replace(/['’.`]/g, "")           // D.J. → dj, Ja'Marr → jamarr
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}
const TEAM_UNIT_POS = new Set(["TMQB", "TMRB", "TMWR", "TMTE", "TMPK", "TMPN", "TMDL", "TMLB", "TMDB", "Def", "Off", "ST", "Coach"]);

// MFL team code → words a story uses for that team.
export const TEAM_WORDS = {
  ARI: ["cardinals", "arizona"], ATL: ["falcons", "atlanta"], BAL: ["ravens", "baltimore"], BUF: ["bills", "buffalo"],
  CAR: ["panthers", "carolina"], CHI: ["bears", "chicago"], CIN: ["bengals", "cincinnati"], CLE: ["browns", "cleveland"],
  DAL: ["cowboys", "dallas"], DEN: ["broncos", "denver"], DET: ["lions", "detroit"], GBP: ["packers", "green bay"],
  HOU: ["texans", "houston"], IND: ["colts", "indianapolis"], JAC: ["jaguars", "jacksonville", "jags"], KCC: ["chiefs", "kansas city"],
  LAC: ["chargers"], LAR: ["rams"], LVR: ["raiders", "las vegas"], MIA: ["dolphins", "miami"],
  MIN: ["vikings", "minnesota"], NEP: ["patriots", "new england", "pats"], NOS: ["saints", "new orleans"], NYG: ["giants"],
  NYJ: ["jets"], PHI: ["eagles", "philadelphia"], PIT: ["steelers", "pittsburgh"], SEA: ["seahawks", "seattle"],
  SFO: ["49ers", "niners", "san francisco"], TBB: ["buccaneers", "bucs", "tampa bay"], TEN: ["titans", "tennessee"], WAS: ["commanders", "washington"],
};
const POS_WORDS = {
  QB: ["qb", "quarterback"], RB: ["rb", "running back"], WR: ["wr", "receiver", "wide receiver", "wideout"], TE: ["te", "tight end"],
  PK: ["kicker"], PN: ["punter"], DE: ["de", "defensive end", "edge", "pass rusher", "lb", "linebacker"], DT: ["dt", "defensive tackle", "nose tackle", "dl"],
  LB: ["lb", "linebacker"], CB: ["cb", "cornerback", "corner"], S: ["safety"],
};
const hasPhrase = (normText, phrase) => (" " + normText + " ").includes(" " + phrase + " ");

// mflPlayers: MFL TYPE=players rows ({id, name "Last, First", team, position}).
// aliases: [{ mfl_id, name }] — Sleeper full_name keyed by MFL id (id-joined offline).
export function buildPlayerIndex(mflPlayers, aliases) {
  const byKey = new Map();
  const players = new Map();
  const add = (key, pid) => {
    if (!key || key.split(" ").length < 2) return;
    const set = byKey.get(key) || new Set();
    set.add(pid);
    byKey.set(key, set);
  };
  for (const p of mflPlayers || []) {
    const pid = String((p && p.id) || "");
    if (!pid || TEAM_UNIT_POS.has(String(p.position || ""))) continue;
    const raw = String(p.name || "");
    const display = raw.includes(",") ? raw.split(",").map((x) => x.trim()).reverse().join(" ") : raw.trim();
    const key = normName(display);
    players.set(pid, { mfl_id: pid, name: display, team: String(p.team || "").toUpperCase(), position: String(p.position || "") });
    add(key, pid);
    add(key.replace(SUFFIX_RE, ""), pid);
  }
  for (const a of aliases || []) {
    const pid = String((a && a.mfl_id) || "");
    if (!players.has(pid)) continue;
    const key = normName(a.name);
    add(key, pid);
    add(key.replace(SUFFIX_RE, ""), pid);
  }
  return { byKey, players };
}

// Every full-name mention in `text`, longest match first at each position.
function scanNames(normText, index) {
  const toks = normText.split(" ").filter(Boolean);
  const found = [];
  for (let i = 0; i < toks.length; i++) {
    const keys = [];
    let k = toks[i];
    for (let j = i + 1; j < Math.min(i + 4, toks.length); j++) { k += " " + toks[j]; keys.push(k); }
    for (let len = keys.length + 1; len >= 2; len--) {
      const key = keys[len - 2];
      const hit = index.byKey.get(key);
      if (hit) { found.push({ key, pids: [...hit] }); i += len - 1; break; }
    }
  }
  return found;
}

const TEAM_WORD_LIST = Object.entries(TEAM_WORDS).flatMap(([code, words]) => words.map((w) => [w, code]));
function teamsMentioned(normText) {
  const out = new Set();
  const padded = " " + normText + " ";
  for (const [w, code] of TEAM_WORD_LIST) if (!out.has(code) && padded.includes(" " + w + " ")) out.add(code);
  return out;
}

// Resolve one story's players. Returns { players: [{mfl_id, match, primary}], unresolved: n }.
export function resolveStoryPlayers(story, index) {
  const headlineN = normName(story.headline);
  const summaryN = normName(story.summary);
  const tagsN = (story.tags || []).map(normName);
  const allN = [headlineN, summaryN, ...tagsN].join(" ");
  const teams = teamsMentioned(allN);
  const best = new Map(); // pid → match rank (tag 0, headline 1, summary 2)
  let unresolved = 0;
  const RANK = { tag: 0, headline: 1, summary: 2 };
  const consider = (pids, where) => {
    let cands = pids;
    if (cands.length > 1) {
      const byTeam = cands.filter((pid) => teams.has(index.players.get(pid).team));
      if (byTeam.length >= 1) cands = byTeam;
    }
    if (cands.length > 1) {
      const byPos = cands.filter((pid) => (POS_WORDS[index.players.get(pid).position] || []).some((w) => hasPhrase(allN, w)));
      if (byPos.length >= 1) cands = byPos;
    }
    if (cands.length !== 1) { unresolved += 1; return; }
    const pid = cands[0];
    if (!best.has(pid) || RANK[where] < RANK[best.get(pid)]) best.set(pid, where);
  };
  // A tag is an editor's label: it counts only when the WHOLE tag is a name.
  for (const t of tagsN) { const hit = index.byKey.get(t); if (hit) consider([...hit], "tag"); }
  for (const f of scanNames(headlineN, index)) consider(f.pids, "headline");
  for (const f of scanNames(summaryN, index)) consider(f.pids, "summary");
  const players = [...best.entries()]
    .sort((a, b) => RANK[a[1]] - RANK[b[1]] || (a[0] < b[0] ? -1 : 1))
    .map(([pid, where]) => ({ mfl_id: pid, match: where, primary: where !== "summary" }));
  return { players, unresolved };
}

// ── category (deterministic keywords; no AI) ───────────────────────────────
const CATEGORY_RULES = [
  ["retirement", /\bretir(e|es|ed|ing|ement)\b|\bhangs? (it|them) up\b|\bcalls? it a career\b/i],
  ["discipline", /\bsuspen(d|ds|ded|sion)\b|\barrest(ed)?\b|\bcharged\b|\bfined?\b|\bdisciplin|\bpunish|\binvestigat/i],
  ["injury", /\binjur(y|ies|ed)\b|\bhamstring|\bankle|\bknee|\bconcussion|\bacl\b|\bmcl\b|\bachilles|\bcalf\b|\bgroin|\bshoulder|\bblood clots?\b|\bsurgery|\bsprain|\bstrain|\bfracture|\btorn\b|\btear\b|\bout for (the )?season\b|\bruled out\b|\bquestionable\b|\bdoubtful\b|\bwon'?t play\b|\bmiss(es|ed|ing)? (week|time|the rest|rest of|multiple|several)|\b(ir|pup)\b|\binjured reserve\b|\bdid not practice\b|\blimited practice\b|\bdnp\b/i],
  ["transaction", /\btrade[ds]?\b|\btrading\b|\bacquir|\bsign(s|ed|ing)?\b|\brelease[ds]?\b|\bwaive[ds]?\b|\bclaim(s|ed)? off waivers\b|\bcut\b|\bpractice squad\b|\belevat|\bactivat|\bplaced on\b|\bdesignated to return\b|\bre-sign/i],
  ["contract", /\bcontract\b|\bextension\b|\bextend(s|ed)?\b|\brestructur|\bholdout\b|\bhold-in\b|\bguarantee|\bfranchise tag\b|\$\d|\bmillion\b/i],
  ["role", /\bstarter\b|\bstarting (job|role|qb|quarterback)\b|\bbench(ed)?\b|\bdepth chart\b|\bsnap (count|share)\b|\brole\b|\btakes? over\b|\bbackup\b|\bqb1\b|\bwill start\b|\bnamed (the )?starter\b/i],
  ["performance", /\byards?\b|\btouchdowns?\b|\btds?\b|\bcatch(es)?\b|\bcarries\b|\brushing\b|\bpassing\b|\breceptions?\b|\bsacks?\b|\binterceptions?\b|\bfantasy points\b|\bweek \d+ (win|loss)\b/i],
];
export const NEWS_CATEGORIES = [...CATEGORY_RULES.map((r) => r[0]), "other"];
export function classify(headline, summary) {
  for (const text of [headline, summary]) {
    for (const [cat, re] of CATEGORY_RULES) if (re.test(String(text || ""))) return cat;
  }
  return "other";
}

// ── dedupe ───────────────────────────────────────────────────────────────────
const STOP = new Set("a an and are as at be been but by for from has have he his how in into is it its new nfl of on or out over says said say than that the their them they this to up was what when where who will with why after before about amid ahead still just more most not no".split(" "));
function contentTokens(headline, nameTokens) {
  const set = new Set();
  for (let w of normName(headline).split(" ")) {
    if (!w || STOP.has(w) || nameTokens.has(w)) continue;
    if (w.length > 4) w = w.replace(/(ings|ing|ed|es|s)$/, "");
    if (w.length >= 3) set.add(w);
  }
  return set;
}
// Same story = shares a primary player, published within DEDUPE_WINDOW_SECONDS,
// and at least 65% of the shorter headline's content words (player names
// excluded) appear in the other. Stories about no player merge only on an
// identical headline.
export function sameStory(a, b) {
  if (Math.abs((a.published_ts || 0) - (b.published_ts || 0)) > DEDUPE_WINDOW_SECONDS) return false;
  const pa = a._primary || new Set(a.players.filter((p) => p.primary).map((p) => p.mfl_id));
  const shared = b.players.some((p) => p.primary && pa.has(p.mfl_id));
  const ha = a._normHeadline || normName(a.headline), hb = b._normHeadline || normName(b.headline);
  if (!shared) return pa.size === 0 && ha === hb;
  const ta = a._tokens || contentTokens(a.headline, a._nameTokens || new Set());
  const tb = b._tokens || contentTokens(b.headline, b._nameTokens || new Set());
  const small = Math.min(ta.size, tb.size);
  if (small < 2) return ha === hb;
  let inter = 0;
  for (const w of ta) if (tb.has(w)) inter++;
  return inter / small >= 0.65;
}

// ── the feed ─────────────────────────────────────────────────────────────────
// fetched: [{ source: <NEWS_SOURCES entry>, ok, http_status, body, fetched_at (ISO), error }]
// opts: { mflPlayers, aliases, ids: Map(pid → {espn_id, rotowire_id}), now (unix s), year, leagueId }
export function buildFeed(fetched, opts) {
  const now = Number(opts.now) || Math.floor(Date.now() / 1000);
  const index = opts.index || buildPlayerIndex(opts.mflPlayers, opts.aliases);
  const sources = [];
  const raw = [];
  let unresolvedMentions = 0;
  for (const f of fetched) {
    const s = f.source;
    const st = { id: s.id, publisher: s.publisher, state: "error", http_status: f.http_status || 0, items: 0, oldest_ts: null, newest_ts: null, fetched_at: f.fetched_at || null, error: f.error || "" };
    if (f.ok) {
      let parsed = [];
      try { parsed = parseRss(f.body); } catch (e) { st.error = "parse failed: " + String((e && e.message) || e).slice(0, 120); }
      const dated = parsed.map((p) => p.published_ts).filter((t) => t > 0);
      st.items = parsed.length;
      st.oldest_ts = dated.length ? Math.min(...dated) : null;
      st.newest_ts = dated.length ? Math.max(...dated) : null;
      if (!parsed.length) { st.state = "empty"; st.error = st.error || "feed answered with no items"; }
      else if (st.newest_ts && now - st.newest_ts > STALE_SOURCE_SECONDS) { st.state = "stale"; st.error = "newest item is older than 72 hours"; }
      else st.state = "ok";
      for (const p of parsed) raw.push({ ...p, source: s, fetched_at: f.fetched_at || null });
    }
    sources.push(st);
  }
  const okCount = sources.filter((s) => s.state === "ok").length;
  const feedState = okCount === sources.length && okCount > 0 ? "ok" : okCount > 0 ? "partial" : "unavailable";

  // One record per article (same canonical URL = same item across feeds and refreshes).
  const byId = new Map();
  for (const r of raw) {
    const id = itemId(r.url, r.source.id, r.headline);
    if (byId.has(id)) continue;
    const res = resolveStoryPlayers(r, index);
    unresolvedMentions += res.unresolved;
    const nameTokens = new Set();
    for (const p of res.players) for (const w of normName(index.players.get(p.mfl_id).name).split(" ")) nameTokens.add(w);
    byId.set(id, {
      id,
      headline: r.headline,
      publisher: r.source.publisher,
      source_id: r.source.id,
      url: canonicalUrl(r.url) ? String(r.url).trim() : "",
      published_ts: r.published_ts || null,
      fetched_at: r.fetched_at,
      category: classify(r.headline, r.summary),
      players: res.players,
      _nameTokens: nameTokens,
      _normHeadline: normName(r.headline),
      _tokens: contentTokens(r.headline, nameTokens),
      _primary: new Set(res.players.filter((p) => p.primary).map((p) => p.mfl_id)),
    });
  }

  // Cluster copies of one story (earliest report leads; ties → source order).
  const order = new Map(NEWS_SOURCES.map((s, i) => [s.id, i]));
  const recs = [...byId.values()].sort((a, b) => (a.published_ts || Infinity) - (b.published_ts || Infinity) || order.get(a.source_id) - order.get(b.source_id) || (a.id < b.id ? -1 : 1));
  const stories = [];
  for (const r of recs) {
    const lead = stories.find((s) => sameStory(s, r));
    if (lead) {
      lead.also_reported_by.push({ id: r.id, publisher: r.publisher, url: r.url, published_ts: r.published_ts });
      for (const p of r.players) if (!lead.players.some((q) => q.mfl_id === p.mfl_id)) lead.players.push({ ...p });
    } else {
      stories.push({ ...r, story_id: "s_" + r.id.slice(2), also_reported_by: [] });
    }
  }

  const ids = opts.ids || new Map();
  const items = stories
    .sort((a, b) => (b.published_ts || 0) - (a.published_ts || 0) || (a.id < b.id ? -1 : 1))
    .map((s) => ({
      id: s.id,
      story_id: s.story_id,
      headline: s.headline,
      publisher: s.publisher,
      source_id: s.source_id,
      url: s.url,
      published_ts: s.published_ts,
      published_at: s.published_ts ? new Date(s.published_ts * 1000).toISOString() : null,
      fetched_at: s.fetched_at,
      category: s.category,
      players: s.players.map((p) => {
        const meta = index.players.get(p.mfl_id) || {};
        const x = ids.get(p.mfl_id) || {};
        return { mfl_id: p.mfl_id, espn_id: x.espn_id || null, rotowire_id: x.rotowire_id || null, name: meta.name || "", team: meta.team || "", position: meta.position || "", match: p.match, primary: p.primary };
      }),
      also_reported_by: s.also_reported_by,
    }));

  const okSources = sources.filter((s) => s.state === "ok" && s.oldest_ts);
  // The window every answering source covers: the LATEST of their oldest items.
  const since = okSources.length ? Math.max(...okSources.map((s) => s.oldest_ts)) : null;
  return {
    contract: NEWS_CONTRACT,
    generated_at: new Date(now * 1000).toISOString(),
    feed_state: feedState,
    coverage: { since_ts: since, hours: since ? Math.round(((now - since) / 3600) * 10) / 10 : null },
    sources,
    items,
    diagnostics: { articles: raw.length, unique_articles: byId.size, stories: items.length, unresolved_name_mentions: unresolvedMentions, players_indexed: index.players.size },
  };
}

// One player's view of the feed. `limit` keeps the most recent items; primary
// mentions (tag/headline) come before summary-only mentions.
export function playerView(feed, pid, opts = {}) {
  const id = String(pid);
  const limit = Number(opts.limit) || 10;
  const known = opts.known === undefined ? true : !!opts.known;
  const mine = feed.items.filter((it) => it.players.some((p) => p.mfl_id === id));
  const primary = mine.filter((it) => it.players.find((p) => p.mfl_id === id).primary);
  const mentions = mine.filter((it) => !it.players.find((p) => p.mfl_id === id).primary);
  const items = [...primary, ...mentions].slice(0, limit);
  let state;
  if (items.length) state = "items";
  else if (feed.feed_state === "unavailable") state = "unavailable";
  else if (!known) state = "unknown_player";
  else if (feed.feed_state === "partial") state = "partial";
  else state = "no_recent_items";
  return {
    mfl_id: id,
    state,
    mfl_news_url: opts.year && opts.leagueId ? mflNewsUrl(opts.year, opts.leagueId, id, opts.host) : null,
    coverage: feed.coverage,
    unavailable_sources: feed.sources.filter((s) => s.state !== "ok").map((s) => s.publisher),
    item_ids: items.map((it) => it.id),
    items,
  };
}

// Legacy /api/player-news headline items for one player (shape callers already read).
export function legacyHeadlineItems(feed, pid) {
  const label = new Map(NEWS_SOURCES.map((s) => [s.id, s.label]));
  return playerView(feed, pid, { limit: 20 }).items.map((it) => ({
    type: "headline",
    source: label.get(it.source_id) || it.publisher,
    timestamp: it.published_ts || 0,
    headline: it.headline,
    body: "",
    url: it.url,
    // additive (ups.news.v1)
    id: it.id,
    story_id: it.story_id,
    publisher: it.publisher,
    category: it.category,
    primary: it.players.find((p) => p.mfl_id === String(pid)).primary,
  }));
}
