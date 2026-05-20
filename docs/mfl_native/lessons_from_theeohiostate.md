# Lessons from theeohiostate — Adoption Review (Canon)

**Subject:** systematic review of TOS's MFL JS bundles to extract techniques worth adopting into UPS codebase
**Captured:** 2026-05-20
**Captured by:** background research agent (sub-session of `claude/exciting-tharp-235716`)
**Companion doc:** `docs/mfl_native/theeohiostate_intel.md` (high-level intel; this doc is the deeper code review)
**Source files reviewed:**

| File | Source URL | Size (raw) | Pretty lines |
| --- | --- | --- | --- |
| `cache.js` | https://www.mflscripts.com/mfl-apps/global/cache.js | 128,156 B | 6,128 |
| `installer.js` | https://www.mflscripts.com/mfl-apps/global/installer.js | 39,459 B | 758 |
| `header.js` | https://www.mflscripts.com/mfl-apps/global/header.js?v=1.60 | 584,749 B | 20,073 |
| `footer.js` | https://www.mflscripts.com/mfl-apps/global/footer.js?v=1.12 | 782,795 B | 23,514 |

Fetched 2026-05-20 with a browser UA; Mod-Security blocks default `curl/*` UAs (Error 406). The 4 files above are the only TOS scripts hosted at the canonical `/mfl-apps/global/` paths today; smaller historical scripts (`tabs.js`, `players_popup.js`, `mobileMenu.js`, `rosters.js`, etc.) all 404 — they have been **bundled into `header.js` + `footer.js`** behind the master-toggle pattern (`var load_mobileMenu_script=true;` etc.). Prettified versions live at `/tmp/tos/*.pretty.js` for this session only.

---

## Executive summary

- **Adopt `cache.js` patterns immediately.** TOS's `MFLCache` is a production-grade three-tier cache (in-memory `Map` → IndexedDB `MFLScripts/cache` store → localStorage `mfl_c_*` fallback) with `BroadcastChannel` cross-tab sync, `navigator.locks`-based stampede prevention, stale-while-revalidate, time-bucketed cache keys, and TTL classes (`LIVE 20s / FIVE_MIN 300s / SIX_HOUR 21600s / DAILY 86400s / WEEKLY 604800s / NEVER 30d`). **Our codebase has none of this.** Every roster_workbench / m/ view re-fetches MFL on every reload. This is the single highest-value item in this review.
- **The anti-flicker double-RAF + setTimeout reveal pattern is real and pervasive** (24+ sites in header/footer). It works. We have rendering flicker on a couple of pages; we should standardize on this pattern.
- **The installer pattern is impressive but skip it.** TOS POSTs raw form-encoded URLs to MFL `csetup`, `message`, `owner_abilities_setup` endpoints under the commissioner's cookie session. We've consciously moved off MFL HPMs to first-party hosting; replicating a commissioner-cookie-driven installer would re-couple us to the brittle thing we're walking away from.
- **The DOM transforms (`.reportnavigation` → `.alert alert-info-body` and ~40 sibling class swaps) are the exact root cause of the O=43 styling break.** They run inside both `header.js` and `footer.js` against `.reportnavigation`, `td.hint`, `.weekly-navbar`, etc., and there are **dozens of them** — far broader than the one we hit. Removing these scripts from our HPMs is the right call; the catalog below documents what we lose so we can selectively re-mirror anything we want without inheriting the breakage.
- **Cross-tab cache invalidation via `BroadcastChannel("MFLCache_BC")` is a free win we should clone** the moment we have any client-side cache. Cost: ~30 lines.

---

## Technique-by-technique

### 1. Caching layer (`cache.js`)

The most important file in this entire review. ~6,000 lines of prettified code. The public surface is `window.MFLCache` (constructed in an IIFE at line 275).

#### 1a. Three-tier read path: memory → IndexedDB → localStorage

```js
function getSync(e) {
  return _.has(e) ? _.get(e) : null;         // in-memory Map
}
async function get(r) {
  const t = getSync(r);
  if (t) return t;
  const o = await (async function _idbGet(r) { /* IndexedDB read */ })(r);
  if (o) return (_.set(r, o), o);             // promote IDB → memory
  const n = _lsGet(r);                        // localStorage fallback
  return n ? (_.set(r, n), n) : null;
}
```

#### 1b. Entry shape with explicit TTL stamping

```js
function isExpiredEntry(e) {
  return !(e && e.storedAt && e.ttlMs) || now() - e.storedAt > e.ttlMs;
}
function makeEntry(e, r) {
  return { data: e, storedAt: now(), ttlMs: 1e3 * (r || 300) };  // default 5min
}
```

Every entry carries `{cacheKey, data, storedAt, ttlMs}`. **Default TTL is 300s when callers omit a TTL.**

#### 1c. Canonical TTL table

```js
TTL: {
  LIVE:        20,        // 20 seconds (in-game live scoring)
  FIVE_MIN:    300,
  FIFTEEN_MIN: 900,
  SIX_HOUR:    21600,
  DAILY:       86400,
  WEEKLY:      604800,
  NEVER:       2592e3,    // 30 days (still GC'd by 14-day purge)
}
```

#### 1d. Canonical cache-key schema (`MFLCache.KEY`)

```js
KEY: {
  playerDB:      (year)        => `global_${year}_playerDB`,
  playerDBTs:    (year)        => `global_${year}_playerDB_updatedAt`,
  injuries:      (year)        => `global_${year}_injuries`,
  newsBreaker:   ()            => "global_newsBreaker",
  topStarters:   (year, week)  => `global_${year}_topStarters_w${week}`,
  nflSchedule:   (year, week)  => `global_${year}_nflSchedule_${week}`,
  myLeagues:     (year)        => `global_${year}_myLeagues`,
  weather:       ()            => "global_weather",
  rosters:       (year, lid)   => `lid_${year}_${lid}_rosters`,
  transactions:  (year, lid)   => `lid_${year}_${lid}_transactions`,
  league:        (year, lid)   => `lid_${year}_${lid}_league`,
  standings:     (year, lid)   => `lid_${year}_${lid}_standings`,
  weeklyResults: (year, lid, w)=> `lid_${year}_${lid}_weeklyResults_w${w}`,
  projScores:    (year, lid, w)=> `lid_${year}_${lid}_projScores_w${w}`,
  customPlayer:  (year, lid)   => `lid_${year}_${lid}_customPlayer`,
}
```

Two prefixes: `global_*` for cross-league shared data (player DB, news, weather), `lid_*` for per-league data. **The presence of both year and league_id in every key means a single browser running multiple MFL leagues across multiple years never collides.**

#### 1e. Time-bucketing for natural cache invalidation

```js
bucketFiveMin: function(e) { return Math.floor((e||Date.now())/FIVE_MIN_MS) * FIVE_MIN_MS; },
bucketSixHour: function(e) { const r=e||Math.floor(Date.now()/1e3); return 21600*Math.floor(r/21600); },
bucketDaily:   function(e) { const r=e||Math.floor(Date.now()/1e3); return 86400*Math.floor((r+54e3)/86400); },
```

These return wall-clock-aligned bucket timestamps. Callers append them to cache keys (e.g. `..._w${week}_b${bucketFiveMin()}`) so the key naturally rotates every 5 min / 6 hr / 24 hr without needing per-entry TTL math. **Clever and zero-cost.**

#### 1f. Stampede prevention via `navigator.locks` (with CAS fallback)

```js
async function _acquireLock(r, t) {
  const a = "MFLLock_" + r;
  if (navigator.locks && navigator.locks.request)
    return new Promise((e) => {
      navigator.locks.request(a, { ifAvailable: !0 }, (r) => {
        if (r) return (M.add(a), e(!0), new Promise((e)=>{L.set(a,e);}));
        e(!1);
      });
    });
  return _casAcquire(a, t);   // localStorage compare-and-swap fallback
}
```

The CAS fallback uses a `{tab, exp, token}` JSON in localStorage with cryptographic tokens (`crypto.randomUUID()`), expiry timestamps, and tab IDs so multiple tabs of the same browser don't fight each other.

#### 1g. Cross-tab broadcast (BroadcastChannel)

```js
const p = "MFLCache_BC";
function ensureBC() {
  if (g) return g;
  if (!("BroadcastChannel" in e)) return null;
  try { ((g = new BroadcastChannel(p)), g.addEventListener("message", _onBCMessage)); }
  catch (e) { g = null; }
  return g;
}
function _broadcast(e, r) {
  const t = ensureBC();
  if (t) try { t.postMessage({ type: "MFLCache", cacheKey: e, entry: r }); } catch(e) {}
}
```

When `set()` writes a fresh entry, the channel broadcasts to other open MFL tabs which **promote it into their in-memory `Map` without re-fetching**. Followers waiting on a `getOrFetch()` lock are unblocked via the BC message.

#### 1h. Stale-while-revalidate (`serveStaleAndRefresh`)

```js
function serveStaleAndRefresh(e, r, t, a) {
  const o = MFLCache.getSync(e);
  if (o && o.data) {
    try { a(o.data, "cache"); } catch (e) {}
    return (
      MFLCache.isExpiredEntry(o) &&
        setTimeout(async () => {
          try { const a = await r(); a && (await MFLCache.set(e, a, t, { silent: !0 })); }
          catch (e) {}
        }, 0),
      Promise.resolve(!0)
    );
  }
  // ... idb fallback identical pattern
}
```

Renders stale data *immediately* (synchronously, from the in-memory Map), kicks off a background refresh, and broadcasts the refresh result silently. **This is the trick that makes the page feel instant on reload.**

#### 1i. Eviction + quota recovery + IDB legacy migration

```js
function evictOldCacheEntries() {
  // ... walks all localStorage, drops cache_*, playerDB_*, expired mfl_c_*, expired lock_*
}
function safeLocalStorageSet(e, r) {
  try { return (localStorage.setItem(e, r), !0); }
  catch (t) {
    if (t instanceof DOMException && (22===t.code || 1014===t.code ||
        "QuotaExceededError"===t.name || "NS_ERROR_DOM_QUOTA_REACHED"===t.name)) {
      console.warn("[MFLCache] localStorage quota exceeded writing key:", e, "— attempting eviction");
      (evictOldCacheEntries() /* then retry */);
    }
  }
}
```

There's also a 14-day TTL purge that runs on IDB open via `requestIdleCallback` (line 419):

```js
function _scheduleCleanup(r) {
  const run = () => _purgeOldEntries(r).catch(() => {});
  "requestIdleCallback" in e
    ? requestIdleCallback(run, { timeout: 1e4 })
    : setTimeout(run, 8e3);
}
```

#### 1j. Dependency graph drives what gets cached

```js
const _API_DEPS = {
  loadMyLeaguesJSON:        ["mflLive"],
  reportInjuriesAPI:        ["irReport","contract","moduleScoreboard","replaceMFLScoring",
                             "mflLive","MondayNight","overview","miniBoxscore"],
  reportTransactionsAPI:    ["irReport","contract"],
  reportRostersAPI:         ["irReport","contract"],
  reportProjectedScoresAPI: ["moduleScoreboard","replaceMFLScoring","mflLive","MondayNight",
                             "Marquee","overview","miniBoxscore"],
  // ... etc
};
function needsAPI(e) {
  const r = _API_DEPS[e];
  return !r || r.some((e) => {
    const r = window["useCache_" + e];
    return void 0 === r || !0 === r;
  });
}
```

Each consumer (IR report, contract, mini-boxscore, etc.) sets a `useCache_<feature>` window var. Before any API fetch, `needsAPI(apiName)` walks the deps list: if every consumer has explicitly opted out, the fetch is skipped entirely. **This is why TOS's leagues can run all 20 HPMs with under 10 actual MFL API hits per page-load.**

**Why it matters:** without this layer, MFL's per-IP rate limit (~10 requests in quick succession) hits anyone reloading a heavy page twice. UPS rosters/workbench already burns 5+ requests per page (rosters, salaries, transactions, players, league); a commish flipping between pages will trip the limit within seconds.

**Do we have it?** **No.** `site/rosters/roster_workbench.js` fetches MFL on every render. Our worker (`workers/`) caches D1 data but not MFL responses. No client-side cache.

**Adoption recommendation:** **Adopt — adapted.** Port the public surface (`MFLCache.{get, getSync, set, getOrFetch, KEY, TTL}`) plus the IDB/LS storage and BroadcastChannel into `site/shared/mfl_cache.js`. Drop the `_API_DEPS` graph initially (we use much less than TOS's 20-HPM bundle); add per-call TTLs. Use `?v=<sha>` cache-bust so cache lives until we ship.

**Effort:** **Medium** (1-2 days, mostly typing — the design is fully worked out).

---

### 2. Theme switcher

```js
function setTheme(e) {
  (localStorage.setItem(`theme_${year}_${league_id}`, e),
    (document.documentElement.className = e));
}
(document.querySelectorAll(".pageheader, .myfantasyleague_menu li a:empty, div.myfantasyleague_menu ul li:empty")
  .forEach((e) => e.remove()),
  (() => {
    const e = localStorage.getItem(`theme_${year}_${league_id}`);
    e && setTheme(e);
  })(),
  document.getElementById("logo_svg_inserticon")?.classList.add("nfl-icon-onload"));
```

- localStorage key format: `` `theme_${year}_${league_id}` `` (per-year + per-league)
- Theme applied by setting a **class on `<html>`** (`document.documentElement.className`) — single root class, full reset on toggle
- All themes are pure CSS classes (`theme-dk-blue`, `theme-niners`, etc.) keyed on CSS custom properties (`--main`, `--accent`, `--gradient-light`, `--gradient-dark`, `--mobile-wrap-bg`)
- Reads localStorage at startup; if absent, falls through to the league's default

**Why it matters:** zero-flash theme persistence, no JS framework needed, multi-league isolation.

**Do we have it?** **Partial.** We support a `prefers-color-scheme` based dark mode via CSS; no per-league override and no UI to toggle.

**Adoption recommendation:** **Adapt.** The pattern is sound — copy the localStorage-keyed-by-league + className-on-html idiom into `site/shared/theme.js`. Skip the 31 NFL team themes; ship 2-3 (light, dark, "ups").

**Effort:** **Small** (half-day).

---

### 3. Anti-flicker reveal pattern (double-RAF + setTimeout)

Pervasive — 24+ instances across `footer.pretty.js`. The canonical form, from the rewritten Add/Drop page:

```js
requestAnimationFrame(() => {
  requestAnimationFrame(() => {
    setTimeout(() => {
      document.body.appendChild(O);
    }, timeFrame);
  });
}),
```

with `var timeFrame = 300;` as the default (line 17623 of footer). The two nested RAFs guarantee:

1. First RAF runs after the next paint commit but **before** layout for the next frame
2. Second RAF runs after **that** frame's layout — by now all synchronous DOM mutations are flushed and laid out
3. `setTimeout(_, 300)` gives styled-component CSS (Font Awesome, custom theme) time to download/apply before the user sees the swap

Pre-reveal, the target node is held off-DOM (e.g. `O` is a built-up DocumentFragment); the page renders a "fake" placeholder skeleton until the swap. A simpler variant (no setTimeout) appears in `header.pretty.js:9194` for in-frame DOM swaps.

The "wait until a global is defined" variant used to chain script-loaders:

```js
await new Promise((e) => {
  const t = setTimeout(e, 5e3);
  if ("function" == typeof requestAnimationFrame)
    requestAnimationFrame(function rafCheck() {
      if ("undefined" != typeof Player) return (clearTimeout(t), void e());
      requestAnimationFrame(rafCheck);
    });
  // ...setInterval fallback
});
```

**Why it matters:** MFL's stylesheet is loaded async after HPM JS; without this, every Bootstrap-ified table flashes unstyled HTML (FOUC) before swap. The pattern is what makes TOS's pages look professionally polished.

**Do we have it?** **No.** Our `site/rosters/roster_workbench.js` and `site/m/views/*.js` render directly; FOUC is visible on first paint of trade workbench in particular.

**Adoption recommendation:** **Adopt verbatim** as a shared helper:

```js
// site/shared/reveal.js
export function revealOnNextLayout(applyFn, settleMs = 300) {
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      setTimeout(applyFn, settleMs);
    });
  });
}
```

**Effort:** **Small** (the helper is 8 lines; identifying which mounts to wrap is the work — maybe 1 day to apply across our 5-6 heavy pages).

---

### 4. Mobile responsive transforms (stack-to-cards via `td:before`)

The canonical idiom, baked verbatim into `footer.pretty.js` at line 13676 (draft history table). Compressed example:

```css
@media (max-width:40.625em) {
  #draftHistortable, #draftHistortable tbody,
  #draftHistortable th, #draftHistortable td,
  #draftHistortable tr { display: block; }
  #draftHistortable th { position:absolute; top:-9999rem; left:-9999rem; }
  #draftHistortable td { position:relative; text-align:left!important; min-height:2.125rem; }
  #draftHistortable td:before { width:6.25rem; text-align:right; display:inline-block; margin-right:0.625rem; }
  #draftHistortable td:nth-of-type(1):before { content:"Pick\00a0:\00a0" }
  #draftHistortable td.franchisename:before { content:"Franchise\00a0:\00a0" }
  #draftHistortable td.player:before        { content:"Selection\00a0:\00a0" }
  #draftHistortable td.timestamp:before     { content:"Date/Time : " }
  #draftHistortable td:last-of-type:before  { content:"Comments\00a0:\00a0" }
}
```

Key idioms:
- Breakpoint is `40.625em` (650px @ 16px base) — fixed across his entire codebase
- `display:block` on every table cell stacks them vertically
- `th` moved to `top:-9999rem` instead of `display:none` (preserves screen-reader accessibility)
- Labels added via `:before { content }` keyed on **column class names** (`.franchisename`, `.player`, etc.) — these are existing MFL CSS hooks he reuses
- `\00a0` (non-breaking space) hard-coded after every label so the colon doesn't wrap

**Why it matters:** zero-JS responsive transform — just CSS that reads MFL's own column classes. Works regardless of how MFL renders the table.

**Do we have it?** **Partial.** Our mobile site is a complete view (`site/m/`), so we don't need MFL-table card-stacking. But for HPM-embedded reports (rookies, auction history, contracts) we render real tables and **do not** ship a mobile transform.

**Adoption recommendation:** **Adopt as a CSS pattern** in `site/shared/responsive_table.css`. Provide a SCSS-style mixin keyed on a `data-card-label` attribute we set on `<td>`s so it works for tables we generate.

**Effort:** **Small** (half-day for the helper + per-table CSS).

---

### 5. Cache-bust strategy (`?v=N.N.N`)

TOS uses inconsistent versioning:
- `header.js?v=1.60`
- `footer.js?v=1.12`
- `cache.js` (no version — always-latest!)

The `?v=N` is **hand-cranked, never automated**, with no semver discipline. The `cache.js` having no `?v=` means it's served with whatever CDN cache headers Cloudflare provides — typically a few hours.

Cache-bust *inside* the bundles: `?PRINTER=1` appended to MFL page URLs forces MFL to skip the chrome (no banner, no footer) — this is how he fetches tab labels:

```js
fetch(`${baseURLDynamic}/${year}/home/${league_id}?PRINTER=1`)
  .then((e) => e.text())
  .then((e) => extractTabNames(e));
```

**Why it matters:** when `cache.js` ships a logic change, every league using the master HPM template gets it instantly (no rebuild). But when `header.js?v=1.60` ships, leagues that hard-coded `?v=1.59` in their HPM stay broken-by-omission.

**Do we have it?** **Yes — and we're better at it.** We use `?v=<git_sha>` (e.g. `?v=2026.05.18.v0.1.0`) computed at build time. Files: `site/auction/auction_hub.html`, `site/rosters/mfl_hpm_embed_loader.js`, `site/rookies/mfl_hpm_embed_loader.js`.

**Adoption recommendation:** **Skip.** We're ahead of him here. The `?PRINTER=1` trick is worth knowing as a way to read MFL pages without their chrome (and ~3x faster) — useful for any future scraper.

**Effort:** **N/A.**

---

### 6. Installer pattern (one-click HPM rewrite)

`installer.js` is a 758-line state machine that runs only when `franchise_id === "0000"` (commissioner-only — line 74):

```js
!(function init() {
  if ("undefined" == typeof franchise_id || "0000" !== franchise_id) return;
  // ... renders settings popup modal
})();
```

It POSTs raw form-encoded URLs to MFL's commissioner endpoints with `credentials: "include"` (rides the commish's session cookie):

```js
function post(e, t = null, n = {}) {
  return fetch(e, {
    method: "POST",
    credentials: "include",
    cache: "no-cache",
    headers: t ? { "Content-Type": "application/x-www-form-urlencoded", ...n } : n,
    body: t,
  });
}
```

The four modes are:

| Mode | What it does |
| --- | --- |
| **Load Template** | POSTs to `/csetup?form_name=repsec` (security settings), `?form_name=images` (skin CSS), `?form_name=skin` (USE_SKIN=0); then writes 20 HPMs by fetching text templates from `https://www.mflscripts.com/mfl-apps/global/hpmContents/${skinColor}/No.NN-Name.txt` and POSTing each to `/message?LEAGUE_ID=${league_id}&NAME=messageNN[&IN_HEADER=Yes\|&IN_FOOTER=Yes]`; finally POSTs to `/csetup?C=HMPGMOD&...HOME_MODULES_0=...` to set the tab/module layout. |
| **Adjust Settings** | Just the `repsec` POST. |
| **Reset MFL** | Wipes all HPMs by POSTing empty `MSG` to `/message?...&NAME=messageNN` for N=1..20. |
| **Remove this script** | Drops the installer HPM only. |

The HPM template text files have placeholder strings (`Weapons of DMD`, `B.O.T.H 2003`, `The Empire`) which the installer string-replaces with the league's input values **before** posting.

There's no idempotency check — running "Load Template" twice double-writes everything. No rollback (it's a destructive operation that warns "DELETE ALL YOUR CURRENT HOMEPAGE MESSAGES"). No CSRF (MFL has no CSRF tokens on these endpoints — the session cookie is the only auth).

**Why it matters:** turns a 30-minute manual install into a 30-second one. The replicable insight is **MFL's commish endpoints accept form-encoded POSTs with just the session cookie**.

**Do we have it?** **No** — and we don't want it. Our move is *away* from MFL-hosted HPMs (rosters, rookies, auction, trade, standings are all becoming first-party static-hosted at `keithcreelman.github.io/upsmflproduction/`). The HPMs are thin loader stubs that fetch our hosted JS.

**Adoption recommendation:** **Skip the installer pattern; capture the endpoints in our intel doc.** Worth knowing: if we ever need to bulk-rewrite our HPMs, the `csetup` + `message` POST recipe is documented above. Add a one-line note to `docs/mfl_native/mfl_page_html_inventory.md`.

**Effort:** **N/A** (documentation only — 30 min).

---

### 7. DOM transformations on MFL native pages (the breakage catalog)

This is the section that directly explains why our O=43 styling broke. The transforms run in two waves:

**Wave 1 (footer.js lines 140-220):** global jQuery rewrites of MFL's stock `.reportnavigation` markup. ~40 transforms; the full list:

```js
jQuery("th.divpct").text("Div %");
jQuery("th.all_play_wlt").text("All-Play");
jQuery("th.h2hpct").text("%");

jQuery('div.mobile-wrap .reportnavigation:contains("Hint:")')
  .removeClass().addClass("alert alert-info-table")
  .wrap('<div style="text-align:center"></div>');
jQuery("td.hint").removeClass().addClass("tdalert tdalert-info-table").wrapInner("<span></span>");
jQuery('body .reportnavigation:contains("Hint:")').removeClass().addClass("alert alert-info-body");
jQuery('.reportnavigation:contains("Top FAQ:")').removeClass().addClass("alert alert-info-body");
jQuery('.reportnavigation:contains("Weekly NFL Injury Status is in this color.")').hide();

jQuery(".mobile-wrap").parents("table").addClass("no-borderspacing");
jQuery("h3").addClass("h3-menu");
jQuery(".mobile-wrap h3").removeClass("h3-menu");

jQuery('.reportnavigation:contains("Show Rosters For Week:")').removeClass().addClass("weekly-navbar week_optionsbox");
jQuery('.reportnavigation:contains("Go To  Week:")').removeClass().addClass("weekly-navbar week_optionsbox");
jQuery('#body_pro_schedule .reportnavigation:contains("Go To Team")').removeClass().addClass("weekly-navbar week_optionsbox pro_team");
jQuery('.reportnavigation:contains("Power Rank As Of Week:")').removeClass().addClass("weekly-navbar week_optionsbox");
jQuery('.reportnavigation:contains("Franchise Setup:")').removeClass().addClass("weekly-navbar fran_options");
jQuery('.reportnavigation:contains("Standings As Of Week:")').removeClass().addClass("weekly-navbar week_optionsbox");
jQuery('.reportnavigation:contains("Go To Week:")').removeClass().addClass("weekly-navbar week_optionsbox");
jQuery('.reportnavigation:contains("Submit Lineup For Week:")').removeClass().addClass("weekly-navbar week_optionsbox");
jQuery('.reportnavigation:contains("Edit Newsletter for Week:")').removeClass().addClass("weekly-navbar week_optionsbox");
jQuery('.reportnavigation:contains("Go To Draft Round:")').removeClass().addClass("weekly-navbar week_optionsbox");
jQuery('.reportnavigation:contains("Go To Team:")').removeClass().addClass("weekly-navbar1");
jQuery('.reportnavigation:contains("Select A Category:")').removeClass().addClass("weekly-navbar week_optionsbox")
  .wrap('<div style="text-align:center"></div>');

jQuery(".weekly-navbar.week_optionsbox .reportnavigationheader").text("SELECT WEEK: ");
jQuery(".weekly-navbar.week_optionsbox.pro_team .reportnavigationheader").text("SELECT TEAM: ");
jQuery("#body_site_news .weekly-navbar.week_optionsbox .reportnavigationheader").text("SELECT : ");
jQuery("#body_options_236 #container-wrap div > form").addClass("reportform");
```

**Wave 2 (header.js lines 6355-6390):** dynamic transform on any AJAX-loaded module:

```js
t.querySelectorAll(".reportnavigation, blockquote").forEach((e) => {
  e.textContent.includes("Hint:") &&
    (e.className = "alert alert-info-body");
});
```

**Other transforms catalogued:**

- `form` → `.reportform` class added (line 6358)
- `h2, h3` → `.h3-menu` class added (line 6360)
- Wave 2 fires inside the `api_info` page rebuild (header line ~6370) — wraps `.pagebody` content in a new `<div class="mobile-wrap">` and reveals after 700ms
- `.pageheader` and empty `<li>` removed at startup (line 6231)
- Owner Activity tab refresh: `jQuery("#tab202").click(...).load(window.location.href + " #owner_activity", ...)` (footer)
- Playoff bracket text replacements ("Winner of Game #2" → "Worst Remaining Seed", etc.)

**Pages affected** (anywhere `.reportnavigation`, `td.hint`, or table headers `.divpct/.all_play_wlt/.h2hpct` appear, which is essentially every MFL report page):

| MFL Path | Transform |
| --- | --- |
| `/options?O=07` Rosters | `.reportnavigation` "Show Rosters For Week:" → `.weekly-navbar.week_optionsbox` |
| `/options?O=43` Contract Reports | (`Hint:` reportnav → `.alert.alert-info-body` — **this is our breakage**) |
| `/options?O=05` Trades | `td.hint` → `.tdalert.tdalert-info-table` |
| `/pro_schedule` | `Go To Team` reportnav → `.weekly-navbar.week_optionsbox.pro_team` |
| `/standings` | `Standings As Of Week:` reportnav → `.weekly-navbar.week_optionsbox` |
| `/lineup` | `Submit Lineup For Week:` reportnav → `.weekly-navbar.week_optionsbox` |
| `/add_drop` | full re-render via `enhanced-add-drop-ui` (footer ~line 17620) |
| `/site_news` | header text replaced to "SELECT : " |
| `/options?O=170` (Power Rank) | reportnav class swap |
| API info page (`/api_info`) | container hidden 700ms then revealed with `mobile-wrap` div wrap |
| All H2 / H3 globally | `.h3-menu` class added |

**Why it matters:** Any CSS we wrote that selects `.reportnavigation` on these pages was being silently nuked. Conversely: if we want to mirror his polished look on the pages where we still send users to MFL, we know exactly what classes to target.

**Do we have it?** **No** — and we don't want the bulk version. We have surgical per-page transforms in `site/rosters/mflscripts_rosters_fork.js`.

**Adoption recommendation:** **Adopt selectively.** Two specific transforms worth re-mirroring in our own scripts:
1. The `Hint:` → `.alert.alert-info-body` swap (the one that broke us): nice UX, restore it but under our own CSS that we control.
2. The "Submit Lineup For Week:" → `.weekly-navbar` swap if we ever want to keep MFL's lineup page styled.

Skip everything else. Document the full list in `docs/mfl_native/mfl_page_html_inventory.md` so we know what we're not doing.

**Effort:** **Small** (1 day to write our own surgical replacements; document the rest).

---

### 8. MFL JSON-export wrapping

TOS does **not** have a single `fetchMfl(type, opts)` function — instead, each report has its own `report<Name>API()` wrapper that:

1. Calls `needsAPI(name)` against the deps graph (skip if no consumer needs it)
2. Computes the 5-minute bucket
3. Calls `MFLCache.getOrFetch(key, fetcher, ttl, {lockTtlMs, waitMs, applyFn})` where `fetcher` is a closure that does the actual MFL URL fetch
4. The applyFn is the legacy callback that pushes the result into a global `report<Name>_ar` variable

Example, `reportRostersAPI` (header line 1984):

```js
async function reportRostersAPI(e) {
  if (!needsAPI("reportRostersAPI")) return;
  const t = resolveFiveMinBucket(e),
    a = MFLCache.KEY.rosters(year, league_id);
  return (await getIfPastSeason(a, (e) => {
    ((reportRoster_ar = e),
      e?.rosters?.franchise && reportRosterResponse(reportRoster_ar));
  }))
    ? void 0
    : MFLCache.getOrFetch(a, () => (
        logApi("API FETCH rosters", { league_id: league_id, bucket: t, tab: window.MFL_TAB_ID }),
        // ... actual fetch + json parse
      ), MFLCache.TTL.FIVE_MIN, {
        lockTtlMs: 6e4, waitMs: 6e4,
        applyFn: (e) => { reportRoster_ar = e; reportRosterResponse(e); }
      });
}
```

The actual URL construction:
```js
`https://www${t}.myfantasyleague.com/${e}/export?TYPE=playerScores&L=${a}&APIKEY=&W=YTD&JSON=1`
```
(`APIKEY=` is empty — same-origin cookie auth is enough.)

`getIfPastSeason(key, applyFn)` short-circuits for prior-year leagues: if the cache has *any* entry (no TTL check), use it. Past-season data never changes.

```js
const CurrentMFLYear = 2026, MFLPastSeason = 2026 !== year;
function getIfPastSeason(e, r) {
  if (!MFLPastSeason) return Promise.resolve(!1);
  const t = MFLCache.getSync(e);
  if (t && t.data) { /* apply, return true */ }
  return MFLCache.get(e).then((e) => { /* same for IDB */ });
}
```

**Why it matters:** "past season → never re-fetch" is a free win for any historical query — we have a lot of pre-2025 data and we're constantly re-fetching it.

**Do we have it?** **Partial.** Our worker has `mfl_database.db` and D1 tables for historical data, but client-side we still hit MFL for past-year rosters via `reportRostersAPI` in `roster_workbench.js`.

**Adoption recommendation:** **Adapt.** Build `site/shared/mfl_api.js` exporting `mflApi.rosters(year, lid)`, `mflApi.transactions(year, lid)`, etc. Each function = `needsAPI` check + bucket + `MFLCache.getOrFetch(KEY, fetcher, TTL)`. Add the `getIfPastSeason` short-circuit for any year != currentYear.

**Effort:** **Medium** (1-2 days; needs the cache layer first).

---

### 9. Modular config pattern (`var FEATURE = true;`)

The HPM-side config is dirt-simple:

```html
<!-- in HPM #1 (Header) -->
<script>
var load_mobileMenu_script    = true;
var load_chat_enhanced        = true;
var load_popup                = true;
var load_mini_boxscore        = true;
var load_marquee              = true;
var load_lineups_submit_script= true;
var load_tabs_script          = true;
var load_irReport_script      = true;
var load_diceRoll_script      = true;
</script>
<script src="https://www.mflscripts.com/mfl-apps/global/header.js"></script>
```

Inside `cache.js`/`header.js`, each toggle is read with a `void 0 ===` guard so it defaults safely:

```js
if (void 0 === load_mobileMenu_script) var load_mobileMenu_script = !0;
if (void 0 === load_chat_enhanced)     var load_chat_enhanced     = !0;
if (void 0 === load_popup)             var load_popup             = !0;
// ... etc
```

This is just **untyped script globals** — no namespace, no JSON config object, no `<meta>` config. The advantage: changing a feature toggle in an HPM doesn't require any rebuild of the bundle.

**Why it matters:** for HPM-embedded scripts (where editing the JS bundle round-trips through a CDN deploy), per-league config-via-globals is faster than every alternative.

**Do we have it?** **Partial.** Our loader (`site/rosters/mfl_hpm_embed_loader.js`) lets HPMs set `window.UPS_*` globals before script load. We use this for league_id, franchise_id, host detection.

**Adoption recommendation:** **Already on the right path** — formalize it. Document the canonical `window.UPS_*` namespace and per-script feature toggles in `docs/mfl_native/mfl_page_html_inventory.md` so future builders know the pattern.

**Effort:** **Small** (documentation only).

---

### 10. localStorage / IndexedDB usage patterns

Already covered in §1, but the key keys-to-know:

| Storage | Key prefix | Purpose | TTL |
| --- | --- | --- | --- |
| memory `Map` | (cache keys, see §1d) | Hot tier | 200 entries, LRU evicted to 150 |
| IndexedDB `MFLScripts/cache` | `cacheKey` (the cache key as keyPath) | Warm tier | 14-day GC purge |
| IndexedDB `MFLScripts/meta` | meta key/value | Misc metadata | — |
| localStorage | `mfl_c_<cache key>` | Cold fallback when IDB unavailable | TTL on entry |
| localStorage | `MFLLock_<cache key>` | Cross-tab fetch lock (CAS fallback) | `lockTtlMs` (default 20s) |
| localStorage | `theme_<year>_<league_id>` | Theme persistence | forever (manual reset only) |
| localStorage | `cache_*`, `playerDB_*` | Legacy keys (purged on cold start) | — |
| localStorage | `_idb_legacy_mflscripts_purged_v1` | One-shot migration flag | forever |

The legacy migration runs once on first load (line 220):

```js
function migrateLegacyIDB(e) {
  if (!localStorage.getItem(e)) {
    try {
      const r = indexedDB.deleteDatabase("mflscripts");
      ((r.onsuccess = () => {
        localStorage.setItem(e, "1");
        window.MFL_DEBUG_API && console.log("[MFLCache] legacy IDB 'mflscripts' removed");
      }), /* ... */);
    } catch (r) { localStorage.setItem(e, "1"); }
  }
}
```

**Why it matters:** documents an actual production migration. If we ship a `MFLCache` and later rename keys, this is the template.

**Do we have it?** **No** — only ad-hoc `localStorage.setItem("ups_mfl_user_id", ...)` in `site/m/app.js`.

**Adoption recommendation:** **Adopt with the cache layer.**

**Effort:** Included in §1 estimate.

---

### 11. Cross-tab coordination (BroadcastChannel)

See §1g. The channel name is constant: `"MFLCache_BC"`. Message shape:

```js
{ type: "MFLCache", cacheKey: "<key>", entry: { data, storedAt, ttlMs } }
```

Followers waiting on a `getOrFetch()` lock listen on the channel; when the leader's `set()` broadcasts, the follower resolves immediately with the broadcasted entry — no second fetch:

```js
function _onBCMessage(r) {
  const t = r.data;
  if (!t || "MFLCache" !== t.type) return;
  const { cacheKey: a, entry: o } = t;
  if (!a || !o) return;
  _.set(a, o);                       // promote into local in-memory Map
  const n = w.get(a);                // wake any waiting followers
  n && n.size && n.forEach((e) => {
    try { e(o); } catch (e) {}
  });
  try {
    e.dispatchEvent(new CustomEvent("MFLCacheBroadcast", {
      detail: { cacheKey: a, data: o.data },
    }));
  } catch (e) {}
}
```

He also dispatches a `CustomEvent("MFLCacheBroadcast")` on `window` so app-level code can subscribe to fresh-data notifications without depending on the cache module directly.

**Why it matters:** open three MFL tabs simultaneously; the first one to refresh rosters serves all three. Cuts MFL API load 3x for commish/power-user workflows.

**Do we have it?** **No.** Zero hits for `BroadcastChannel` or `navigator.locks` in our codebase.

**Adoption recommendation:** **Adopt with cache layer.** Free with the §1 port.

**Effort:** Included in §1 estimate.

---

### 12. Service worker / PWA

**None.** Zero hits on `serviceWorker`, `navigator.serviceWorker`, or manifest references in any of the 4 bundles. TOS does not use a service worker — IndexedDB + BroadcastChannel is enough for his needs.

**Adoption recommendation:** **Skip.** Service worker would help for fully offline mobile use, but the cookie-coupled MFL endpoints make true offline impractical anyway.

---

### 13. URL query patterns

#### `?HIDE_CUST=1`

Toggles all HPM custom HTML/CSS off at render. From the master doc:
```
https://www46.myfantasyleague.com/2023/logout?L=10065&HIDE_CUST=1
```
This is the break-glass URL. No JS code references it — it's exclusively a human-typed bookmark.

#### `?PRINTER=1`

Used extensively to scrape MFL pages without their chrome. Example (header.js line 6602):

```js
fetch(`${baseURLDynamic}/${year}/home/${league_id}?PRINTER=1`)
  .then((e) => e.text())
  .then((e) => {
    const t = extractTabNames(e);
    return (setTabsCache(t), t);
  });
```

Also chained with custom rewriters that strip `&PRINTER=1` back out of click-through URLs:
```js
return t.replace("&PRINTER=1", "");
```

#### `?v=N.N.N`

Manual cache-bust, see §5. No automation.

**Do we have it?** Partial — we use `?v=<sha>` for our own assets. We don't use `?PRINTER=1` anywhere in our scrapers.

**Adoption recommendation:** **Adopt `?PRINTER=1`** for any MFL page-scraping we do (e.g. when we need to extract tab labels, league name, owner list from the rendered HTML). Saves bandwidth and avoids the banner JS interfering with our parsers.

**Effort:** **Small** (5 min — just append `&PRINTER=1` to a few existing fetches).

---

### 14. Security / authentication patterns

#### Same-origin session cookie (the only real auth)

All MFL writes (`installer.js`) use `credentials: "include"` and depend on the user already having a logged-in session cookie:

```js
function post(e, t = null, n = {}) {
  return fetch(e, {
    method: "POST",
    credentials: "include",
    cache: "no-cache",
    // ...
  });
}
```

#### API key (mostly empty)

For *read* APIs, `APIKEY=` is appended as an empty value:

```js
`https://www${t}.myfantasyleague.com/${e}/export?TYPE=playerScores&L=${a}&APIKEY=&W=YTD&JSON=1`
```

For *write* APIs (lineup submit, add/drop), `apiKey` is hidden in a form (footer line 8108):

```js
'<input type="hidden" name="apikey" value="' + apiKey + '" />'
```

Where `apiKey` is an HPM-injected MFL global available on the page. **No CSRF tokens, no signed requests** — MFL has none. This is a known platform limitation, not a TOS oversight.

#### Franchise ID gating

The installer self-gates on `franchise_id === "0000"` (commish):

```js
if ("undefined" == typeof franchise_id || "0000" !== franchise_id) return;
```

`franchise_id` is an MFL HPM-injected page global. **Anyone can change their browser's `franchise_id` global before the installer runs** — this is client-side gating only, but MFL's server-side will reject the commish endpoints from non-commish sessions, so it doesn't matter.

**Why it matters:** confirms our security model. The MFL session cookie is the only thing that matters; client-side franchise_id checks are UX-not-security.

**Do we have it?** **Yes (modeled correctly).** Our worker enforces commish via session header check (not client-side `franchise_id`).

**Adoption recommendation:** **Skip.** We already do this better than TOS.

---

### 15. Performance instrumentation

Lightweight `performance.now()` for hot loops, but no production telemetry shipped. Example, the page-width responsive flag (header line 9132):

```js
function scheduleUpdatePageNarrowFlag() {
  const e = performance.now();
  if (t) return;
  t = !0;
  setTimeout(() => {
    ((a = performance.now()),
      (function updatePageNarrowFlagNow() { /* ... */ })());
  }, /* ... */);
}
```

There's a debug logger gated on `window.MFL_DEBUG_API`:

```js
function logApi(e, r) {
  window.MFL_DEBUG_API &&
    (console.groupCollapsed(`%c[MFL API] ${e}`, "color:#0aa;font-weight:bold"),
     console.log(r),
     console.trace(),
     console.groupEnd());
}
```

Set `window.MFL_DEBUG_API = true` in the console to see every cache hit/miss/API fetch with stack traces.

**No** `console.time`, **no** Sentry, **no** `navigator.sendBeacon`, **no** custom analytics. TOS ships zero telemetry beyond an opt-in debug log.

**Why it matters:** confirms what's reasonable for a small-league custom-script — opt-in debug, no telemetry.

**Do we have it?** **Yes.** We use `console` logging guarded by `?debug=1` query string in several files.

**Adoption recommendation:** **Skip.** Our pattern is equivalent or better.

---

## Anti-patterns to AVOID

1. **Globally rewriting MFL's stock classes (`.reportnavigation` → `.alert.alert-info-body`).** This is the literal thing that broke our O=43 styling. The transform is unscoped — it runs on every MFL page where `.reportnavigation` exists. Any CSS we wrote against `.reportnavigation` was silently nuked. **Lesson:** scope transforms by `#body_options_NN` page ID; never run a bare `jQuery('.reportnavigation').removeClass().addClass(...)`.
2. **`jQuery(...):contains("English string")` selectors everywhere.** These break the moment MFL localizes or rewords a string (e.g. "Hint:" → "Tip:"). 40+ instances in footer.js — every one is a fragility point. **Lesson:** select on stable DOM markers (class names, IDs, `data-*` attrs) not on rendered English.
3. **Hand-cranked `?v=N` cache-bust.** TOS never bumps the version when shipping bug fixes (`cache.js` has no `?v=` at all). Some users see new code, some don't. **Lesson:** we already do `?v=<sha>` build-time bust — keep doing that, never regress to hand-edits.
4. **No CSRF, write APIs via raw form-encoded POSTs.** Forced on TOS by MFL's platform limits. But **we should never proxy these from our own worker** — if an attacker can trigger our worker to POST to MFL with the user's session cookie, we just CSRF'd them on MFL's behalf. **Lesson:** any client-side write to MFL must originate from the user's own browser, never our worker.
5. **20-HPM canonical template.** TOS's "every league should have these 20 HPMs in this exact order" approach assumes the league is starting from scratch and willing to nuke everything. UPS has 14 years of history baked into specific HPM slots; copy his pattern would obliterate it. **Lesson:** any HPM rewrite must be additive, never destructive.
6. **Loading 1.3 MB of minified JS on every page (header.js + footer.js + cache.js = 1.5 MB).** Even with `?v=<n>` caching this is heavy. Our HPM loader stub is ~4 KB; the per-page bundles (rosters, rookies, auction) are ~50-200 KB each and only load on the relevant page. **Lesson:** don't consolidate every script into one bundle.

---

## Prioritized adoption queue

| Rank | Technique | Effort | Value | Reason |
| --- | --- | --- | --- | --- |
| 1 | `MFLCache` layer (memory → IDB → LS, TTL, evict, broadcast) — §1 | Medium | **Very High** | Eliminates rate-limit risk; makes pages reload-instant. Single biggest improvement available. |
| 2 | Anti-flicker double-RAF + setTimeout reveal helper — §3 | Small | **High** | Half-day work; visibly polishes Trade Workbench and Roster Workbench. |
| 3 | `mflApi.<resource>(year, lid)` wrappers over `MFLCache.getOrFetch` — §8 | Medium | **High** | Forces single chokepoint for every MFL fetch. Drops debug logs onto every call. |
| 4 | `getIfPastSeason` short-circuit (past-year data never re-fetched) — §8 | Small | **High** | Cuts MFL load by ~50% for any page that browses pre-2025 leagues. |
| 5 | `BroadcastChannel("MFLCache_BC")` cross-tab cache sync — §11 | Small | **Medium** | Free with §1 port. Helps commish workflows. |
| 6 | `?PRINTER=1` for scraping MFL pages — §13 | Small | **Medium** | Apply to any future MFL HTML-scrape; faster, no chrome interference. |
| 7 | Theme switcher (`theme_${year}_${league_id}` localStorage) — §2 | Small | **Medium** | Per-league theme override for users with strong preferences. |
| 8 | Responsive table card-stacking via `td:before { content: "Label" }` — §4 | Small | **Medium** | For HPM-embedded reports we serve. |
| 9 | Selectively re-mirror `Hint:` → `.alert-info-body` polish — §7 | Small | **Low** | Cosmetic; restores TOS-era polish on pages we now own. |
| 10 | Document MFL commish endpoints (`/csetup`, `/message`, `/owner_abilities_setup`) — §6 | Small | **Low** | Just-in-case intel; capture in `mfl_page_html_inventory.md`. |

**Skip:** installer.js wholesale (§6); service worker (§12); performance telemetry (§15); global `.reportnavigation` rewrites (§7 anti-pattern); the 20-HPM canonical template.

---

## Open intel

- **The 9 historical script files** (`tabs.js`, `players_popup.js`, `mobileMenu.js`, `rosters.js`, etc.) **are not separately fetchable** from `mflscripts.com` today — all return 404 at `/mfl-apps/global/<name>.js`. They have been bundled into `header.js` + `footer.js` behind the master-toggle `var load_<feature>_script = true;` pattern. Their content is fully captured in the prettified `header.js` / `footer.js` reviewed above.
- **`installer.js` HPM template text files** at `https://www.mflscripts.com/mfl-apps/global/hpmContents/{light,dark}/No.NN-Name.txt` were not fetched in this pass. If we ever want to fully reverse-engineer his 20-HPM template, those .txt files are the source of truth. Skip unless we change our mind about adopting his installer pattern.
- **Custom Tabs Generator UI** (`mfl-customtabs/`) — not in scope for this review (UI rather than runtime), captured in the prior intel doc.
- **The `MFL_TAB_ID` global** is referenced in lock acquisition (`MFL_TAB_ID || "tab"`) but I didn't trace where it's set. Likely a per-tab UUID set on first script load. Worth a 10-minute scan if we adopt the lock layer.
- **The `_API_DEPS` graph entries `useCache_*` window vars** — we'd need to decide which subset (irReport, contract, moduleScoreboard, etc.) we expose to per-page config. For our initial port, just inline the deps as always-true; revisit if we add module-level opt-outs.
- **TOS's per-HPM .txt templates contain inline `<script>` blocks** with hardcoded league branding (Weapons of DMD, B.O.T.H 2003). Installer string-replaces these before posting. We'd want to do this differently — config-driven SVG, not text substitution — if we ever ship anything similar.
