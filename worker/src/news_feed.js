// SHARED EXTERNAL NEWS FEED — contract "ups.news.v1" (Keith 2026-10-21/22, #1356)
//
// ONE builder for every surface that shows outside NFL/player news: League News
// (the whole feed), the player panel (the feed filtered to one player), the
// legacy /api/player-news shape, and later UPS Wire editor leads. Clients render
// the states this returns and never re-derive them.
//
// SOURCES
//   - Four publisher RSS feeds (PFR, PFT, CBS, Yahoo): headline + publisher +
//     time + link are shown; the RSS summary is read in memory only (who the
//     story is about, its category) and never returned or stored.
//   - MFL Player News: MFL's documented `TYPE=playerProfile&P=<ids>` export,
//     public (no cookie), which returns each player's latest updates (≤ 3, about
//     the last 7 days) as { id, headline, published: "N hours" | "N days" }.
//     The CONTENT is the provider's, named by the article id: RotoWire
//     ("rotowire643298"), Dynasty League Football, FFToday. MFL's developer terms
//     say third-party content such as player news can't be made available, so
//     the headline is LICENSED TEXT: it is used in memory (event, category,
//     dedupe) and never returned or stored. An MFL item carries metadata only —
//     MFL player id, MFL article id, provider, approximate time, category,
//     event — and links to MFL's own article page, where MFL shows the text.
//     MFL items are tied to a player by the MFL id MFL filed them under,
//     never by name.
//   Removed 2026-10-21: ESPN site.api (undocumented; 0 items reach the Worker)
//   and Reddit r/nfl JSON (403; Reddit's Data API needs registration).
//
// WHO AN RSS STORY IS ABOUT. RSS carries no player ids, so a story is resolved
// ONCE, against MFL's whole player list, to a stable MFL id (plus the ESPN and
// RotoWire ids MFL publishes for that player). A name resolves only when it is
// a full name that belongs to exactly one player. When two players share it
// (Justin Jefferson WR MIN / LB CLE) a team or position named in the same story
// must pick one, or the mention is left unresolved and counted. Never a last
// name alone, never "first name anywhere + last name anywhere" (the old rule
// put an article about Russell Wilson under Emmanuel Wilson). Nicknames come
// from Sleeper's full_name, joined to the MFL id by id offline
// (scripts/build_sleeper_cache.py), never by name.
//
// NEVER TURN AN OUTAGE INTO "NO NEWS". Every source reports its own state, the
// feed has one overall state (ok | partial | unavailable), and a player view
// has exactly one of: items | no_recent_items | partial | unavailable |
// unknown_player. "no_recent_items" is only possible when every source answered
// — MFL included, for that very player — and it carries the window it covers.

export const NEWS_CONTRACT = "ups.news.v1";

// Approved RSS sources. `label` is the value legacy /api/player-news callers
// already render in item.source; keep it stable.
export const RSS_SOURCES = [
  { id: "pfr", kind: "rss", publisher: "ProFootballRumors", label: "PFR", url: "https://www.profootballrumors.com/feed" },
  { id: "pft", kind: "rss", publisher: "ProFootballTalk", label: "PFT", url: "https://profootballtalk.nbcsports.com/feed/" },
  { id: "cbs", kind: "rss", publisher: "CBS Sports", label: "CBS", url: "https://www.cbssports.com/rss/headlines/nfl/" },
  { id: "yahoo", kind: "rss", publisher: "Yahoo Sports", label: "Yahoo", url: "https://sports.yahoo.com/nfl/rss.xml" },
];
// MFL Player News (one source, fetched in chunks of player ids).
export const MFL_SOURCE = { id: "mfl", kind: "mfl", publisher: "MFL Player News", label: "MFL" };
export const NEWS_SOURCES = [...RSS_SOURCES, MFL_SOURCE];
export const MFL_CHUNK = 100;
export function mflProfileUrl(year, pids) {
  return `https://api.myfantasyleague.com/${encodeURIComponent(String(year))}/export?TYPE=playerProfile&P=${encodeURIComponent(pids.join(","))}&JSON=1`;
}

// A source whose newest item is older than this is answering but not updating.
export const STALE_SOURCE_SECONDS = 72 * 3600;
// Two copies of one story must be published within this window to merge.
export const DEDUPE_WINDOW_SECONDS = 36 * 3600;
// Two reports of the same specific EVENT (IR move, designation…) merge only
// within this window.
export const EVENT_WINDOW_SECONDS = 24 * 3600;

export function mflNewsUrl(year, leagueId, pid, host) {
  const h = host || "www48.myfantasyleague.com";
  return `https://${h}/${encodeURIComponent(String(year))}/news_articles?L=${encodeURIComponent(String(leagueId))}&P=${encodeURIComponent(String(pid))}`;
}
export function mflArticleUrl(year, leagueId, articleId, host) {
  const h = host || "www48.myfantasyleague.com";
  return `https://${h}/${encodeURIComponent(String(year))}/view_news_article?L=${encodeURIComponent(String(leagueId))}&ID=${encodeURIComponent(String(articleId))}`;
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

// The index is the same for every part, so it is built once (its own
// invocation), cached as JSON, and only parsed by the parts.
export function serializeIndex(index) {
  return {
    k: [...index.byKey].map(([key, set]) => [key, [...set]]),
    p: [...index.players].map(([pid, m]) => [pid, m.name, m.team, m.position]),
  };
}
export function indexFromSerialized(o) {
  const byKey = new Map();
  for (const [key, pids] of (o && o.k) || []) byKey.set(key, new Set(pids));
  const players = new Map();
  for (const [pid, name, team, position] of (o && o.p) || []) players.set(pid, { mfl_id: pid, name, team, position });
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
  let teams = null;   // only needed to pick between same-name players

  const best = new Map(); // pid → match rank (tag 0, headline 1, summary 2)
  let unresolved = 0;
  const RANK = { tag: 0, headline: 1, summary: 2 };
  const consider = (pids, where) => {
    let cands = pids;
    if (cands.length > 1) {
      teams = teams || teamsMentioned(allN);
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

// ── MFL Player News ──────────────────────────────────────────────────────────
// Who wrote it, from MFL's article id. Spelling on MFL's page varies ("Rotowire"
// / "RotoWire"); the name here is fixed so normalizing it never changes an id.
export function mflProvider(articleId) {
  const a = String(articleId || "");
  if (/^rotowire\d+$/i.test(a)) return { id: "rotowire", name: "RotoWire" };
  if (/dynastyleaguefootball/i.test(a)) return { id: "dlf", name: "Dynasty League Football" };
  if (/fftoday/i.test(a)) return { id: "fftoday", name: "FFToday" };
  return { id: "mfl_partner", name: "MFL partner" };
}
// "11 hours" / "1 day" / "6 days" are floor()'d ages at fetch time: a "1 day"
// item is 24–48 h old (MFL's page shows the exact time; the API doesn't).
export function parseMflAge(s, fetchedTs) {
  const m = /^\s*(\d+)\s*(min|minute|hour|day|week)s?\s*$/i.exec(String(s || ""));
  if (!m || !fetchedTs) return null;
  const unit = { min: 60, minute: 60, hour: 3600, day: 86400, week: 604800 }[m[2].toLowerCase()];
  const n = Number(m[1]);
  const newest = fetchedTs - n * unit, oldest = fetchedTs - (n + 1) * unit;
  return { ts: Math.round((newest + oldest) / 2), min_ts: oldest, max_ts: newest, precision: m[2].toLowerCase().replace("minute", "min") };
}
// One chunk's JSON → Map(pid → [{article_id, headline, published}]) and the
// set of pids MFL answered for. A player with no news answers `news: {}`.
export function parseMflProfiles(body) {
  const d = typeof body === "string" ? JSON.parse(body) : body;
  if (!d || d.error) throw new Error("MFL error: " + String((d && d.error && (d.error.$t || d.error)) || "empty body").slice(0, 120));
  const root = d.playerProfiles ? d.playerProfiles.playerProfile : d.playerProfile;
  const list = root == null ? [] : Array.isArray(root) ? root : [root];
  const byPid = new Map();
  for (const p of list) {
    const pid = String((p && p.id) || "");
    if (!pid) continue;
    let arts = (p.news && p.news.article) || [];
    if (!Array.isArray(arts)) arts = [arts];
    byPid.set(pid, arts.filter((a) => a && a.id).map((a) => ({ article_id: String(a.id), headline: String(a.headline || ""), published: String(a.published || "") })));
  }
  return byPid;
}

// ── event (what happened) ────────────────────────────────────────────────────
// A specific event: two reports of it about the same player within
// EVENT_WINDOW_SECONDS are one story even when worded differently. Two
// DIFFERENT specific events (an injury designation and an IR move) are never
// merged, however many words they share.
const EVENT_RULES = [
  ["retirement", /\bretir(e|es|ed|ing|ement)\b|\bcalls? it a career\b/i],
  ["suspension", /\bsuspen(d|ds|ded|sion)\b/i],
  ["ir_return", /\bactivated (off|from) (ir|injured reserve)\b|\bdesignated (him )?(for|to) return\b|\b(comes?|came) off ir\b|\breturn(s|ed)? from ir\b/i],
  ["ir_move", /\b(placed|place|places|lands?|landed|moved|moves|going|goes|headed|heads|puts?)\b[^.;:]{0,60}?\b(on|to) (the )?(ir|injured reserve)\b|\bto injured reserve\b|\bon ir\b/i],
  ["season_ending", /\b(out|done|lost|sidelined) for (the )?(rest of the )?season\b|\bseason[- ]ending\b|\bmiss (the )?rest of (the )?season\b|\bout for the year\b/i],
  ["designation", /\bruled out\b|\b(listed|designated|labeled) (as )?(questionable|doubtful|out)\b|\bquestionable\b|\bdoubtful\b|\bgame-time decision\b|\b(won'?t|will not|not expected to|unlikely to) play\b|\binactive\b|\bout (for )?(week \d+|sunday|monday|thursday|saturday|this week|again)\b|\bnot expected to play\b|\bexpected to play\b|\bwill play\b|\bactive for\b/i],
  ["practice", /\b(limited|full) (participant|practice|work|session)\b|\b(did not|didn'?t|won'?t|will not|doesn'?t) practice\b|\bdnp\b|\bnon-?participant\b|\b(returns?|returned|back) to practice\b|\bsits? out practice\b|\bmiss(es|ed)? practice\b|\bpractic(e|ed|es|ing)\b(?! squad)|\bgets? in '?limited'?\b/i],
  ["starting_role", /\b(to|will|set to|plans? to|expected to|confirmed to|in line to) start\b|\bnamed (the )?starter\b|\bstarting (job|role|nod)\b|\bbenched\b|\bwill start\b|\bto start (week|sunday|monday|thursday)\b/i],
  ["trade", /\btrade[ds]?\b|\btrading\b|\bacquir(e|es|ed|ing)\b|\bdealt\b/i],
  ["signing", /\b(re-)?sign(s|ed|ing)?\b(?! of)/i],
  ["release", /\breleas(e|es|ed|ing)\b|\bwaiv(e|es|ed|ing)\b|\bcut(s)?\b|\bclaimed off waivers\b/i],
];
const SPECIFIC_EVENTS = new Set(EVENT_RULES.map((r) => r[0]));
// Practice reports are daily: Thursday's and Friday's are two updates.
const EVENT_WINDOW = { practice: 12 * 3600 };
export function eventOf(headline, summary) {
  for (const text of [headline, summary]) {
    for (const [ev, re] of EVENT_RULES) if (re.test(String(text || ""))) return ev;
  }
  return "other";
}

// ── dedupe ───────────────────────────────────────────────────────────────────
const STOP = new Set("dynasty a an and are as at be been but by for from has have he his how in into is it its new nfl of on or out over says said say than that the their them they this to up was what when where who will with why after before about amid ahead still just more most not no".split(" "));
function contentTokens(headline, nameTokens) {
  const set = new Set();
  for (let w of normName(headline).split(" ")) {
    if (!w || STOP.has(w) || nameTokens.has(w)) continue;
    if (w.length > 4) w = w.replace(/(ings|ing|ed|es|s)$/, "");
    if (w.length >= 3) set.add(w);
  }
  return set;
}
// Time distance, allowing for MFL's coarse ages: two ranges, gap between them.
function gapSeconds(a, b) {
  const a0 = a._min_ts != null ? a._min_ts : a.published_ts || 0, a1 = a._max_ts != null ? a._max_ts : a.published_ts || 0;
  const b0 = b._min_ts != null ? b._min_ts : b.published_ts || 0, b1 = b._max_ts != null ? b._max_ts : b.published_ts || 0;
  return Math.max(0, b0 - a1, a0 - b1);
}
// Same story =
//   - not two updates from the same MFL provider (each RotoWire update is its own);
//   - shares a primary player;
//   - and EITHER the same specific event within EVENT_WINDOW_SECONDS,
//     OR (no conflicting specific events) within DEDUPE_WINDOW_SECONDS with at
//     least 65% of the shorter headline's content words (names excluded) shared.
// Stories about no player merge only on an identical headline.
export function sameStory(a, b) {
  if (a._provider && a._provider === b._provider) return false;
  const gap = gapSeconds(a, b);
  if (gap > DEDUPE_WINDOW_SECONDS) return false;
  const pa = a._primary || new Set(a.players.filter((p) => p.primary).map((p) => p.mfl_id));
  const shared = b.players.some((p) => p.primary && pa.has(p.mfl_id));
  const ha = a._normHeadline || normName(a.headline), hb = b._normHeadline || normName(b.headline);
  if (!shared) return pa.size === 0 && ha === hb;
  const ea = a.event || "other", eb = b.event || "other";
  if (SPECIFIC_EVENTS.has(ea) && SPECIFIC_EVENTS.has(eb)) {
    if (ea !== eb) return false;                 // materially different updates
    if (gap <= (EVENT_WINDOW[ea] || EVENT_WINDOW_SECONDS)) return true;
  }
  const ta = a._tokens || contentTokens(a.headline, a._nameTokens || new Set());
  const tb = b._tokens || contentTokens(b.headline, b._nameTokens || new Set());
  const small = Math.min(ta.size, tb.size);
  if (small < 2) return ha === hb;
  let inter = 0;
  for (const w of ta) if (tb.has(w)) inter++;
  return inter / small >= 0.65;
}

// Two reports that may never share a story, whatever else matches: two updates
// from the same MFL provider, or two different specific events.
export function conflicts(a, b) {
  if (a._provider && a._provider === b._provider) return true;
  const ea = a.event || "other", eb = b.event || "other";
  return SPECIFIC_EVENTS.has(ea) && SPECIFIC_EVENTS.has(eb) && ea !== eb;
}

// ── the feed ─────────────────────────────────────────────────────────────────
// Two steps, so no single Worker invocation needs more than a few ms of CPU
// (the Free plan allows 10 ms per invocation):
//   normalizeSource(entry) — ONE RSS source or ONE MFL chunk → a "part":
//     its source status + records. JSON-safe and cacheable. An MFL record
//     carries NO licensed text: its headline is reduced in memory to event,
//     category and hashed words (for dedupe) and then dropped.
//   assembleFeed(parts) — merges the parts: one record per article, clusters
//     stories, builds items and states.
// buildFeed() runs both in one call (tests, previews, small builds).

const hashWords = (set) => [...set].map((w) => hash53("w:" + w).slice(-8));

// entry: RSS → { source, ok, http_status, body, fetched_at, error }
//        MFL → { source: MFL_SOURCE, ok, http_status, body, fetched_at, error, pids }
// ctx:   { index (RSS: name resolution), nameOf(pid) (MFL: the player's name), now, year, leagueId }
export function normalizeSource(entry, ctx) {
  const now = Number(ctx.now) || Math.floor(Date.now() / 1000);
  const s = entry.source;
  const st = { id: s.id, publisher: s.publisher, state: "error", http_status: entry.http_status || 0, items: 0, oldest_ts: null, newest_ts: null, fetched_at: entry.fetched_at || null, error: entry.error || "" };
  const records = [];
  let unresolved = 0;
  const nameTokens = (players) => {
    const set = new Set();
    for (const p of players) for (const w of normName(ctx.nameOf(p.mfl_id)).split(" ")) if (w) set.add(w);
    return set;
  };
  const finish = (r, players, headline) => {
    const toks = contentTokens(headline, nameTokens(players));
    r.tok = hashWords(toks);
    r.nh = hash53("h:" + normName(headline));
    records.push(r);
  };
  if (s.kind !== "mfl") {
    if (entry.ok) {
      let parsed = [];
      try { parsed = parseRss(entry.body); } catch (e) { st.error = "parse failed: " + String((e && e.message) || e).slice(0, 120); }
      const dated = parsed.map((p) => p.published_ts).filter((t) => t > 0);
      st.items = parsed.length;
      st.oldest_ts = dated.length ? Math.min(...dated) : null;
      st.newest_ts = dated.length ? Math.max(...dated) : null;
      if (!parsed.length) { st.state = "empty"; st.error = st.error || "feed answered with no items"; }
      else if (st.newest_ts && now - st.newest_ts > STALE_SOURCE_SECONDS) { st.state = "stale"; st.error = "newest item is older than 72 hours"; }
      else st.state = "ok";
      for (const p of parsed) {
        const res = resolveStoryPlayers(p, ctx.index);
        unresolved += res.unresolved;
        finish({
          id: itemId(p.url, s.id, p.headline), licensed: false, headline: p.headline,
          publisher: s.publisher, via: null, source_id: s.id, mfl_article_id: null,
          url: canonicalUrl(p.url) ? String(p.url).trim() : "",
          published_ts: p.published_ts || null, published_precision: p.published_ts ? "exact" : null, min_ts: null, max_ts: null,
          fetched_at: entry.fetched_at || null,
          category: classify(p.headline, p.summary), event: eventOf(p.headline, p.summary),
          players: res.players, provider: null,
        }, res.players, p.headline);
      }
    }
    return { kind: "rss", source_id: s.id, status: st, records, checked: [], requested: [], unresolved };
  }
  // MFL chunk
  const checked = [];
  if (entry.ok) {
    let byPid = null;
    try { byPid = parseMflProfiles(entry.body); } catch (e) { st.error = String((e && e.message) || e).slice(0, 120); }
    if (byPid) {
      st.state = "ok";
      const fetchedTs = entry.fetched_at ? Math.floor(Date.parse(entry.fetched_at) / 1000) : now;
      for (const [pid, arts] of byPid) {
        checked.push(pid);
        for (const a of arts) {
          const age = parseMflAge(a.published, fetchedTs);
          const prov = mflProvider(a.article_id);
          const players = [{ mfl_id: pid, match: "mfl_id", primary: true }];
          // The id comes from MFL's article id ONLY: neither the age ("1 day"
          // → "2 days") nor the provider's spelling can change it.
          finish({
            id: "n_" + hash53("mfl:" + a.article_id.toLowerCase()), licensed: true, headline: null,
            publisher: prov.name, via: "MFL", source_id: MFL_SOURCE.id, mfl_article_id: a.article_id,
            url: ctx.year && ctx.leagueId ? mflArticleUrl(ctx.year, ctx.leagueId, a.article_id) : "",
            published_ts: age ? age.ts : null, published_precision: age ? age.precision : null, min_ts: age ? age.min_ts : null, max_ts: age ? age.max_ts : null,
            fetched_at: entry.fetched_at || null,
            category: classify(a.headline, ""), event: eventOf(a.headline, ""),
            players, provider: "mfl:" + prov.id,
          }, players, a.headline);   // the licensed headline is dropped here
        }
      }
    }
  }
  return { kind: "mfl", source_id: MFL_SOURCE.id, status: st, records, checked, requested: entry.pids || [], unresolved: 0 };
}

// parts: [normalizeSource(...)] ; opts: { players: Map(pid → {name, team, position}), ids: Map(pid → {espn_id, rotowire_id}), now, playersIndexed }
export function assembleFeed(parts, opts) {
  const now = Number(opts.now) || Math.floor(Date.now() / 1000);
  const playerMeta = opts.players || new Map();
  const sources = [];
  for (const p of parts.filter((x) => x.kind === "rss")) sources.push(p.status);
  const mflParts = parts.filter((x) => x.kind === "mfl");
  const mflChecked = new Set();
  if (mflParts.length) {
    const st = { id: MFL_SOURCE.id, publisher: MFL_SOURCE.publisher, state: "error", http_status: 0, items: 0, oldest_ts: null, newest_ts: null, fetched_at: null, error: "", players_checked: 0, players_requested: 0 };
    let okChunks = 0;
    const errors = [];
    for (const p of mflParts) {
      st.players_requested += p.requested.length;
      if (!st.http_status || p.status.state !== "ok") st.http_status = p.status.http_status || st.http_status;
      if (p.status.state !== "ok") { errors.push(p.status.error || `HTTP ${p.status.http_status}`); continue; }
      okChunks += 1;
      st.fetched_at = st.fetched_at && st.fetched_at < (p.status.fetched_at || "") ? st.fetched_at : p.status.fetched_at;
      for (const pid of p.checked) mflChecked.add(pid);
      st.items += p.records.length;
    }
    const dated = mflParts.flatMap((p) => p.records.map((r) => r.published_ts)).filter(Boolean);
    st.oldest_ts = dated.length ? Math.min(...dated) : null;
    st.newest_ts = dated.length ? Math.max(...dated) : null;
    st.players_checked = mflChecked.size;
    st.error = errors.slice(0, 3).join("; ");
    if (okChunks === mflParts.length && mflChecked.size) st.state = "ok";
    else if (okChunks) st.state = "incomplete";
    else st.state = "error";
    if (st.state === "ok" && !st.items && mflChecked.size >= 50) { st.state = "empty"; st.error = "no news for any of " + mflChecked.size + " players"; }
    sources.push(st);
  }
  const okCount = sources.filter((s) => s.state === "ok").length;
  const feedState = okCount === sources.length && okCount > 0 ? "ok" : okCount > 0 ? "partial" : "unavailable";

  // One record per article (RSS: canonical URL; MFL: MFL's article id).
  const byId = new Map();
  let articles = 0, rssArticles = 0, mflArticles = 0, unresolved = 0;
  for (const p of parts) {
    unresolved += p.unresolved || 0;
    for (const r0 of p.records) {
      articles += 1;
      if (p.kind === "mfl") mflArticles += 1; else rssArticles += 1;
      const prev = byId.get(r0.id);
      if (prev) {
        // One MFL article filed under two players (a trade): both keep it.
        for (const q of r0.players) if (!prev.players.some((x) => x.mfl_id === q.mfl_id)) { prev.players.push({ ...q }); if (q.primary) prev._primary.add(q.mfl_id); }
        continue;
      }
      const r = { ...r0, players: r0.players.map((q) => ({ ...q })) };
      r._tokens = new Set(r.tok);
      r._normHeadline = r.nh;
      r._primary = new Set(r.players.filter((q) => q.primary).map((q) => q.mfl_id));
      r._provider = r.provider || null;
      r._min_ts = r.min_ts; r._max_ts = r.max_ts;
      byId.set(r.id, r);
    }
  }

  // Cluster copies of one story. Candidates come from an index by primary
  // player (or by headline for stories about no player).
  const order = new Map(NEWS_SOURCES.map((s, i) => [s.id, i]));
  const recs = [...byId.values()].sort((a, b) => (a.published_ts || Infinity) - (b.published_ts || Infinity) || order.get(a.source_id) - order.get(b.source_id) || (a.id < b.id ? -1 : 1));
  const stories = [];
  const byPlayer = new Map(), byHeadline = new Map();
  for (const r of recs) {
    const cands = new Set();
    if (r._primary.size) { for (const pid of r._primary) for (const s of byPlayer.get(pid) || []) cands.add(s); }
    else for (const s of byHeadline.get(r._normHeadline) || []) cands.add(s);
    let lead = null;
    for (const s of cands) if (s._members.some((m) => sameStory(m, r)) && !s._members.some((m) => conflicts(m, r))) { lead = s; break; }
    if (!lead) { lead = { _members: [] }; stories.push(lead); }
    lead._members.push(r);
    for (const pid of r._primary) { const l = byPlayer.get(pid) || []; if (!l.includes(lead)) l.push(lead); byPlayer.set(pid, l); }
    if (!r._primary.size) { const l = byHeadline.get(r._normHeadline) || []; if (!l.includes(lead)) l.push(lead); byHeadline.set(r._normHeadline, l); }
  }
  const ids = opts.ids || new Map();
  const ref = (m) => ({ id: m.id, publisher: m.publisher, via: m.via, mfl_article_id: m.mfl_article_id || null, url: m.url, published_ts: m.published_ts, published_precision: m.published_precision });
  const items = stories.map((s) => {
    const lead = s._members.find((m) => !m.licensed) || s._members[0];
    const players = [];
    for (const m of [lead, ...s._members.filter((x) => x !== lead)]) for (const p of m.players) if (!players.some((q) => q.mfl_id === p.mfl_id)) players.push({ ...p });
    return { lead, members: s._members, players };
  })
    .sort((a, b) => (b.lead.published_ts || 0) - (a.lead.published_ts || 0) || (a.lead.id < b.lead.id ? -1 : 1))
    .map(({ lead, members, players }) => ({
      id: lead.id,
      story_id: "s_" + lead.id.slice(2),
      headline: lead.licensed ? null : lead.headline,
      headline_policy: lead.licensed ? "read_on_mfl" : "display",
      publisher: lead.publisher,
      via: lead.via,
      source_id: lead.source_id,
      mfl_article_id: lead.mfl_article_id || null,
      url: lead.url,
      published_ts: lead.published_ts,
      published_at: lead.published_ts ? new Date(lead.published_ts * 1000).toISOString() : null,
      published_precision: lead.published_precision,
      fetched_at: lead.fetched_at,
      category: lead.category,
      event: lead.event,
      players: players.map((p) => {
        const meta = playerMeta.get(p.mfl_id) || {};
        const x = ids.get(p.mfl_id) || {};
        return { mfl_id: p.mfl_id, espn_id: x.espn_id || null, rotowire_id: x.rotowire_id || null, name: meta.name || "", team: meta.team || "", position: meta.position || "", match: p.match, primary: p.primary };
      }),
      also_reported_by: members.filter((m) => m !== lead).map(ref),
    }));

  const okRss = sources.filter((s) => s.id !== MFL_SOURCE.id && s.state === "ok" && s.oldest_ts);
  // The window every answering RSS source covers: the LATEST of their oldest items.
  const since = okRss.length ? Math.max(...okRss.map((s) => s.oldest_ts)) : null;
  return {
    contract: NEWS_CONTRACT,
    generated_at: new Date(now * 1000).toISOString(),
    feed_state: feedState,
    coverage: { since_ts: since, hours: since ? Math.round(((now - since) / 3600) * 10) / 10 : null, mfl: "each checked player's latest MFL updates (MFL keeps about 7 days, at most 3)" },
    sources,
    items,
    diagnostics: { articles, rss_articles: rssArticles, mfl_articles: mflArticles, unique_articles: byId.size, stories: items.length, unresolved_name_mentions: unresolved, players_indexed: opts.playersIndexed || playerMeta.size },
    // internal: dropped by publicFeed() before any route responds
    _mfl_checked: [...mflChecked],
  };
}

export function playerMetaMap(mflPlayers) {
  const m = new Map();
  for (const p of mflPlayers || []) {
    const pid = String((p && p.id) || "");
    if (!pid || TEAM_UNIT_POS.has(String(p.position || ""))) continue;
    const raw = String(p.name || "");
    m.set(pid, { name: raw.includes(",") ? raw.split(",").map((x) => x.trim()).reverse().join(" ") : raw.trim(), team: String(p.team || "").toUpperCase(), position: String(p.position || "") });
  }
  return m;
}

// fetched: RSS entries and MFL chunk entries (see normalizeSource).
// opts: { mflPlayers, aliases, ids, now, year, leagueId } (or a prebuilt `index`)
export function buildFeed(fetched, opts) {
  const index = opts.index || buildPlayerIndex(opts.mflPlayers, opts.aliases);
  const ctx = { index, nameOf: (pid) => (index.players.get(pid) || {}).name || "", now: opts.now, year: opts.year, leagueId: opts.leagueId };
  const parts = fetched.map((e) => normalizeSource(e, ctx));
  return assembleFeed(parts, { players: index.players, ids: opts.ids, now: opts.now, playersIndexed: index.players.size });
}

// One player's view of the feed. `limit` keeps the most recent items; primary
// mentions (tag/headline/MFL id) come before summary-only mentions.
// "no_recent_items" needs every RSS source AND MFL to have answered for THIS
// player; otherwise an empty list is "partial" (or "unavailable" when nothing
// answered at all).
export function playerView(feed, pid, opts = {}) {
  const id = String(pid);
  const limit = Number(opts.limit) || 10;
  const known = opts.known === undefined ? true : !!opts.known;
  const mine = feed.items.filter((it) => it.players.some((p) => p.mfl_id === id));
  const primary = mine.filter((it) => it.players.find((p) => p.mfl_id === id).primary);
  const mentions = mine.filter((it) => !it.players.find((p) => p.mfl_id === id).primary);
  const items = [...primary, ...mentions].slice(0, limit);
  const mflChecked = (feed._mfl_checked || []).includes(id);
  const mflSource = feed.sources.find((s) => s.id === MFL_SOURCE.id);
  const unavailable = feed.sources.filter((s) => s.state !== "ok").map((s) => s.publisher);
  if (mflSource && mflSource.state !== "error" && !mflChecked && !unavailable.includes(mflSource.publisher)) unavailable.push(mflSource.publisher);
  let state;
  if (items.length) state = "items";
  else if (feed.feed_state === "unavailable") state = "unavailable";
  else if (!known) state = "unknown_player";
  else if (unavailable.length) state = "partial";
  else state = "no_recent_items";
  return {
    mfl_id: id,
    state,
    mfl_news_url: opts.year && opts.leagueId ? mflNewsUrl(opts.year, opts.leagueId, id, opts.host) : null,
    coverage: feed.coverage,
    mfl_checked: mflChecked,
    unavailable_sources: unavailable,
    item_ids: items.map((it) => it.id),
    items,
  };
}

const EVENT_LABEL = { retirement: "retirement", suspension: "suspension", ir_return: "return from IR", ir_move: "IR move", season_ending: "season-ending", designation: "game status", practice: "practice report", starting_role: "starting role", trade: "trade", signing: "signing", release: "release", other: "update" };
// Legacy /api/player-news headline items for one player (shape callers already
// read). An MFL-led story gets a neutral label, never the provider's text.
export function legacyHeadlineItems(feed, pid) {
  const label = new Map(NEWS_SOURCES.map((s) => [s.id, s.label]));
  return playerView(feed, pid, { limit: 20 }).items.map((it) => ({
    type: "headline",
    source: it.via ? `${it.publisher} via ${it.via}` : (label.get(it.source_id) || it.publisher),
    timestamp: it.published_ts || 0,
    headline: it.headline != null ? it.headline : `${it.publisher} update (${EVENT_LABEL[it.event] || "update"}): read it on MFL`,
    body: "",
    url: it.url,
    // additive (ups.news.v1)
    id: it.id,
    story_id: it.story_id,
    publisher: it.publisher,
    via: it.via,
    headline_policy: it.headline_policy,
    category: it.category,
    event: it.event,
    primary: it.players.find((p) => p.mfl_id === String(pid)).primary,
  }));
}

// What a route may send: the feed minus internal fields.
export function publicFeed(feed) {
  const out = {};
  for (const k of Object.keys(feed)) if (k[0] !== "_") out[k] = feed[k];
  return out;
}
