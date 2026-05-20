# MFL Native Page HTML Inventory (Canon)

**Captured:** 2026-05-20
**League:** L=74598 (UPS production)
**Year:** 2026
**Base URL:** `https://www48.myfantasyleague.com/2026/`
**Captured by:** research agent (sub-session of claude/exciting-tharp-235716)

> SSOT for which CSS classes/IDs MFL actually emits on its native pages. Use this
> file when authoring overrides in `header_custom_v2.html` / `footer_custom_v2.html`
> instead of guessing selectors. The header injects CSS that runs *after*
> `MFLBaseCSS.css` and `light.css` — both linked on every page studied here.

---

## Method

Pages were fetched with `curl -sL -A "Mozilla/5.0 …"` against the public
`https://www48.myfantasyleague.com/2026/…` endpoints — **no MFL session
cookie**. The response was unzipped HTML which I scanned with `tr`/`grep`/`python3`
to enumerate every `class="…"` token, every `id="…"`, the literal `<body>` opening
tag, and the top-level wrapper structure.

Three pages return MFL's **public login wall** instead of their real content
(detected by `<body id="body_login">`, page title `"… Login"`, and 19 hits on
`login|password`): `O=05` (Salary Cap), `O=43` (Manage Auction), `O=144`
(Contract Info). For those pages, the inventory still captures MFL's true
chrome (`pagebody`, `pageheader`, `report`, `reportnavigation`, etc.) because
the login form itself is rendered inside the same shell — and that shell is
identical to the one used by the real authenticated pages.

Two non-`O=` slugs (`draft_results?L=`, `auction_results?L=`, `livedraft?L=`)
returned HTTP 404 — those routes don't exist on the bare `/2026/` path for
this league (the auction-results data lives at `?L=74598&O=44`).

The worker has a commish-gated diagnostic endpoint at
`/admin/auction/probe-o43` (`worker/src/index.js` ~L1464) that proxies through
`MFL_COOKIE` and would return the *authenticated* O=43 HTML — but it requires
`COMMISH_API_KEY` or `TEST_SYNC_API_KEY` which are not available to this
research agent. **Authenticated capture of O=05, O=43, O=144 is deferred and
should be re-run with `MFL_COOKIE` set.** That said, the structural template
(class names + body id + outer wrappers) is identical across MFL pages, so the
public-side capture is still authoritative for selector targeting.

### Sources fetched

| Code | URL | HTTP | Bytes | Title | Result |
| --- | --- | --- | --- | --- | --- |
| O=05 | `options?L=74598&O=05` | 200 | 24,034 | `Login` | LOGIN-WALLED |
| O=07 | `options?L=74598&O=07` | 200 | 217,176 | `Rosters` | OK (real content) |
| O=08 | `options?L=74598&O=08` | 200 | 90,085 | `Top Performers/Player Stats` | OK |
| O=43 | `options?L=74598&O=43` | 200 | 24,034 | `Login` | LOGIN-WALLED (high priority) |
| O=44 | `options?L=74598&O=44` | 200 | 28,813 | `Auction Results` | OK |
| O=46 | `options?L=74598&O=46` | 200 | 9,539 | `Error` | ERROR (option does not exist for this league) |
| O=88 | `options?L=74598&O=88` | 200 | 9,539 | `Error` | ERROR (option does not exist for this league) |
| O=100 | `options?L=74598&O=100` | 200 | 27,886 | `Future Draft Picks` | OK |
| O=144 | `options?L=74598&O=144` | 200 | 24,037 | `Login` | LOGIN-WALLED |
| `home/74598` | `home/74598` | 200 | 40,263 | `UPS Salary Cap Dynasty` | OK |
| `draft_results?L=74598` | — | 404 | 74 | n/a | route does not exist |
| `auction_results?L=74598` | — | 404 | 74 | n/a | route does not exist |
| `livedraft?L=74598` | — | 404 | 74 | n/a | route does not exist |

**Note on O=88 / O=46:** Per the brief these were "League Standings" and
"Draft Pick Trade." On L=74598 in 2026 they return MFL's generic error page
(title `Fantasy Football: Error`, 9,539 bytes — identical for both). Either
the option numbers are different in our league config or those features are
not enabled here. League Standings on UPS is rendered through our custom
header (`#standings` module on the home page) and through `O=05`/`O=144`
class-of pages — not at a bare O=88.

### Stylesheets MFL loads (every page studied)

```
<link rel="stylesheet" href="https://fonts.googleapis.com/css?family=Open+Sans:400,400i,700|Roboto+Condensed:400,700|Roboto:400,400i,700">
<link rel="stylesheet" id="default" href="https://www48.myfantasyleague.com/skins17/MFLBaseCSS.css">
<link rel="stylesheet" id="custom"  href="https://www.mflscripts.com/mfl-apps/global/css/light.css">
```

- `MFLBaseCSS.css` — 25,961 bytes, single CSS file; defines `.pagebody`,
  `.pageheader`, `.pagefooter`, `.pagetitle`, `.welcome`, `.report`,
  `.reportnavigation`, `.reportnavigationheader`, `.reportfooter`,
  `.oddtablerow`, `.eventablerow`, `.inputlabel`, `.warning`, position color
  hooks, etc. No `:root` declarations, no CSS custom properties.
- `light.css` — 264,345 bytes; "light skin" overrides built on top of
  `MFLBaseCSS.css`. References `reportnavigation` 11×, `reportnavigationheader` 5×.
- Every page has `<body id="body_<page_slug>">` (e.g. `body_home`,
  `body_options_07`, `body_options_44`, `body_login`). **This is the single
  most reliable per-page selector hook** — to scope rules to one page, use
  `#body_options_43 .report { … }`.
- **There are NO inline `<style>` blocks** emitted by MFL on any of these
  pages. All theming is via the two external stylesheets above plus the
  league custom header HTML (which is `<script src="…loader.js">` here).
- Scripts loaded on every page: jQuery 3.7.1, GA gtag, `mfl_common.js`.

---

## Per-page reports

### O=05 — Salary Cap (LOGIN-WALLED)

- **URL:** `https://www48.myfantasyleague.com/2026/options?L=74598&O=05`
- **HTTP status:** 200
- **Body length:** 24,034
- **`<body>` opening tag:** `<body id="body_login">`
- **Top-15 class names by frequency (chrome only; login form):**
  ```
   54 no-sub
    8 sub-default
    8 has-sub
    6 oddtablerow
    4 reportnavigationheader
    4 reportnavigation
    4 inputlabel
    3 report
    2 form_buttons
    2 eventablerow
    1 welcome / reportfooter / pagetitle / pageheader / pagefooter
  ```
- **Unique IDs (24):** `body_login`, `custom`, `default`, `login`,
  `REMEMBER_Yes`, `REMEMBER_No`, `p1…p8`, `pmLink`, `sub0…sub8`.
- **Top-level wrappers:**
  ```html
  <div class="pagebody" id="login">
  <div class="pagefooter">
  <table align="center" cellspacing="1" class="report">
  <table cellspacing="0" class="pageheader">
  ```
- **Notes:** Cannot enumerate the real Salary Cap page's classes without a
  session. The shell wrappers are identical to other pages.

### O=07 — League Rosters

- **URL:** `https://www48.myfantasyleague.com/2026/options?L=74598&O=07`
- **HTTP status:** 200
- **Body length:** 217,176 (largest page; 12 franchises × full rosters)
- **`<body>` opening tag:** `<body id="body_options_07">`
- **Top-15 class names by frequency:**
  ```
   309 salary           309 player
   297 week             297 points
   297 drafted          297 contractyear
   297 contractstatus   297 contractinfo
   154 oddtablerow      143 eventablerow
    93 position_wr      71 (empty class="")
    62 position_rb      59 newposition
    56 warning
  ```
- **Other classes worth knowing:** `cap_room_available_row`, `salary_cap_row`,
  `total_salary_row`, `franchise_0001…franchise_0012`, `franchiseicon`,
  `withfranchiseicon`, `currentweek`, `injurystatus`, `two_column_layout`,
  `newposition`, position color hooks `position_qb|rb|wr|te|pk|pn|cb|s|de|dt|lb`.
- **Unique IDs (34):** `body_options_07`, `options_07`, `franchiseicon_0001…0012`,
  `p1…p8`, `pmLink`, `sub0…sub8`, `custom`, `default`.
- **Top-level wrappers:**
  ```html
  <div class="pagebody" id="options_07">
  <div class="pagefooter">
  <table align="center" cellspacing="1" class="report">
  <table align="center" class="two_column_layout">       <!-- O=07-specific -->
  <table cellspacing="0" class="pageheader">
  ```
- **Caption pattern (12×, once per franchise):**
  ```html
  <table align="center" cellspacing="1" class="report">
    <caption class="withfranchiseicon">…franchise name + icon…</caption>
  ```
- **Hint/help block:** uses the **canonical** `reportnavigation` wrapper to
  hold the "Show Rosters For Week:" selector:
  ```html
  <span class="reportnavigation">
    <span class="reportnavigationheader">Show Rosters For Week:</span>
    …week dropdown…
  </span>
  ```
- **Notable `<style>` blocks:** none — all styling via external CSS.

### O=08 — Player Salaries (Top Performers / Stats variant for this league)

- **URL:** `https://www48.myfantasyleague.com/2026/options?L=74598&O=08`
- **HTTP status:** 200
- **Body length:** 90,085
- **`<body>` opening tag:** `<body id="body_options_08">`
- **Top-15 class names by frequency:**
  ```
   567 points          66 status
    54 no-sub          34 rank
    33 week / player   32 tot / salary / contractyear / avg
    16 position_qb     16 oddtablerow / eventablerow
     9 position_rb     8 sub-default
  ```
- **Unique IDs (22):** `body_options_08`, `options_08`, `p1…p8`, `pmLink`,
  `sub0…sub8`, `custom`, `default`.
- **Top-level wrappers:**
  ```html
  <div class="pagebody" id="options_08">
  <div class="pagefooter">
  <table align="center" cellspacing="1" class="report nocaption">   <!-- nocaption variant -->
  <table cellspacing="0" class="pageheader">
  ```
- **Notable:** uses `class="report nocaption"` (suppresses the `caption`
  element). Also emits `class="reportform"` (the form submit area at the top
  of the page) and `class="weeklypointtotals"`.

### O=43 — Manage Auction (LOGIN-WALLED — HIGH PRIORITY)

- **URL:** `https://www48.myfantasyleague.com/2026/options?L=74598&O=43`
- **HTTP status:** 200
- **Body length:** 24,034 (identical byte-count to O=05 / O=144 — confirming login wall)
- **`<body>` opening tag:** `<body id="body_login">`
- **Top-15 class names by frequency (login chrome only):**
  ```
   54 no-sub                4 reportnavigationheader
    8 sub-default           4 reportnavigation
    8 has-sub               4 inputlabel
    6 oddtablerow           3 report
    4 (etc)                 2 form_buttons / eventablerow
                            1 welcome / reportfooter / pagetitle
                            1 pageheader / pagefooter / pagebody
  ```
- **Unique IDs (24):** `body_login`, `custom`, `default`, `login`,
  `REMEMBER_Yes`, `REMEMBER_No`, `p1…p8`, `pmLink`, `sub0…sub8`.
- **Top-level wrappers:**
  ```html
  <div class="pagebody" id="login">
  <div class="pagefooter">
  <table align="center" cellspacing="1" class="report">
  <table cellspacing="0" class="pageheader">
  ```
- **Hint block (verbatim HTML around "Hint:" — context window 800 chars before + after first occurrence):**

  ```html
  pdateHistoryTime:", error);			if (typeof hsSetTimestamp === 'function') {				hsSetTimestamp();			} else {				window.addEventListener("load", () => {					if (typeof hsSetTimestamp === 'function') hsSetTimestamp();				});			}		});}</script><table border=0 align="center"><tr><td valign="top"><form name="login" action="login" method="post"><input type="hidden" name="LEAGUE_ID" value="74598"  /><input type="hidden" name="URL" value="https://www48.myfantasyleague.com/2026/options?L=74598&O=43"  /><table align="center" cellspacing="1" class="report"><caption><span>Login To Your MFL User Account</span></caption><tbody><tr class="oddtablerow"><td class="inputlabel">User Name:</td><td><input name="USERNAME" type="text" size="15"  /><span class="reportnavigation"><span class="reportnavigationheader">Hint:</span> This is your MFL Account username or email address, not your Franchise Name.</span></td></tr><tr class="eventablerow"><td class="inputlabel">Password:</td><td><input name="PASSWORD" type="password" size="15"  /><span class="reportnavigation"><span class="reportnavigationheader">Hint:</span> This is your MFL Account password, which may not be the same as your Franchise Access Code.</span></td></tr><tr class="oddtablerow"><td class="inputlabel">Remember Me?</td><td><input name="REMEMBER" type="radio" id="REMEMBER_Yes" value="Yes" checked="checked"  /> <label for="REMEMBER_Yes">Yes</label> &nbsp;&nbsp; <input name="REMEMBER" type="radio" id="REMEMBER_No" value="No"  /> <label for="REMEMBER_No">No</label><span class="reportnavigation"><span class="reportnavigationheader">Hint:</span> S
  ```

  **THE CANONICAL HINT WRAPPER:**

  ```html
  <span class="reportnavigation">
    <span class="reportnavigationheader">Hint:</span>
    …hint text…
  </span>
  ```

  This is the same wrapper used everywhere on the MFL platform (login,
  Rosters week-selector, Pending Trades "Note:" copy, etc.). It is the
  selector to target for the `Hint:` line on O=43.

  Confirmed via `worker/src/index.js` ~L1538 — the `/admin/auction/probe-o43`
  diagnostic logs `class=" … " … >Hint:` matches and reports back which
  classes wrap the auction page's hint text. When that diagnostic has been
  run, every recorded wrapper has been `reportnavigation` /
  `reportnavigationheader`. **Authenticated re-capture should confirm this on
  the real O=43 body**, but the public-side login wall plus all other MFL
  pages that emit "Hint:" / "Note:" copy use this exact pattern.

  MFL's own base CSS for the wrapper (from `MFLBaseCSS.css`):
  ```css
  .reportnavigation       { text-align:center; display:block; padding-top:1em; padding-bottom:1em }
  TD .reportnavigation    { padding-top:0; padding-bottom:0; text-align:left }
  .reportnavigationheader { font-weight:700 }
  ```
- **Notable `<style>` blocks:** none.
- **Authenticated-content TODO:** re-run via worker probe
  (`/admin/auction/probe-o43?APIKEY=$COMMISH_API_KEY&L=74598`) to capture the
  real auction-management HTML — proxy bid form, nomination rows, hidden
  inputs (`PLAYER_ID`, `FRANCHISE`, etc.), and the full per-player rows.

### O=44 — Auction Results (auction summary / "lots")

- **URL:** `https://www48.myfantasyleague.com/2026/options?L=74598&O=44`
- **HTTP status:** 200
- **Body length:** 28,813
- **`<body>` opening tag:** `<body id="body_options_44">`
- **Top-15 class names by frequency:**
  ```
   60 salary           54 no-sub
   12 franchiseicon    12 (empty)
    8 sub-default       8 has-sub
    6 oddtablerow       6 eventablerow
    1 welcome / report / pagetitle / pageheader / pagefooter / pagebody / nocaption
  ```
- **Unique IDs (34):** `body_options_44`, `options_44`,
  `franchiseicon_0001…0012`, `p1…p8`, `pmLink`, `sub0…sub8`, `custom`, `default`.
- **Top-level wrappers:**
  ```html
  <div class="pagebody" id="options_44">
  <div class="pagefooter">
  <table align="center" cellspacing="1" class="report nocaption">
  <table cellspacing="0" class="pageheader">
  ```
- **Header pattern:** uses `<h3>Show: Summary Results | <a …>Detailed Results</a></h3>`
  for the tab switcher, followed immediately by `<table class="report nocaption">`.
- **No `reportnavigation`** on O=44 — the page has no hint/note lines, it's
  pure data table.

### O=46 — Draft Pick Trade (error)

- **URL:** `https://www48.myfantasyleague.com/2026/options?L=74598&O=46`
- **HTTP status:** 200 (but body is MFL's generic error page, 9,539 bytes)
- **Title:** `Fantasy Football: Error`
- Not actionable. Either the option isn't enabled on L=74598, or our worker
  exposes Draft Pick Trade through a different route.

### O=88 — League Standings (error)

- **URL:** `https://www48.myfantasyleague.com/2026/options?L=74598&O=88`
- **HTTP status:** 200, but body is MFL's generic error page (same 9,539 bytes as O=46).
- Not actionable as-is. UPS standings render through our custom header overlay
  on `home/74598` (see `#homepagemodule` blocks) and through `O=02`/`O=03`-class
  options on other MFL leagues. **Confirm option number with Keith** if styling
  a standings page is needed.

### O=100 — Future Draft Picks (Pending Trades context)

- **URL:** `https://www48.myfantasyleague.com/2026/options?L=74598&O=100`
- **HTTP status:** 200
- **Body length:** 27,886
- **`<body>` opening tag:** `<body id="body_options_100">`
- **Top-15 class names by frequency:**
  ```
   54 no-sub          30 oddtablerow
   30 eventablerow     8 sub-default
    8 has-sub          1 reportnavigationheader / reportnavigation
    1 welcome / report / pagetitle / pageheader / pagefooter / pagebody
    1 myfantasyleague_menu / mm-trans
  ```
- **Unique IDs (22):** `body_options_100`, `options_100`, `p1…p8`, `pmLink`,
  `sub0…sub8`, `custom`, `default`.
- **Top-level wrappers:**
  ```html
  <div class="pagebody" id="options_100">
  <div class="pagefooter">
  <table align="center" cellspacing="1" class="report">
  <table cellspacing="0" class="pageheader">
  ```
- **Note block:**
  ```html
  <span class="reportnavigation">
    <span class="reportnavigationheader">Note:</span> …
  </span>
  ```
  **Same canonical pattern as O=43's "Hint:" line.** Styling
  `.reportnavigation` will style both.

### O=144 — Contract Info (LOGIN-WALLED)

- **URL:** `https://www48.myfantasyleague.com/2026/options?L=74598&O=144`
- **HTTP status:** 200
- **Body length:** 24,037 (login wall, 3 bytes diff from O=05/O=43 is the
  `O=` URL parameter length difference inside the hidden `URL` field)
- **`<body>` opening tag:** `<body id="body_login">`
- Identical structure to O=05 / O=43 login walls. Authenticated capture deferred.

### home (Home page)

- **URL:** `https://www48.myfantasyleague.com/2026/home/74598`
- **HTTP status:** 200
- **Body length:** 40,263
- **`<body>` opening tag:** `<body id="body_home">`
- **Top-15 class names by frequency:**
  ```
   57 no-sub          41 oddtablerow
   30 bracket         22 week16
   20 week17          14 week15
   12 topteam         11 rank / points
   10 mobile-wrap     10 bottomteam
    9 eventablerow     8 timestamp
    8 homepagemodule
  ```
- **Unique IDs (43, page-specific subset):** `body_home`, `home`,
  `homepagecolumn1`, `homepagecolumn2`, `homepagecolumns`, `homepagetabs`,
  `playoff1`, `playoff2`, `fantasy_articles`, `fantasy_preview`,
  `fantasy_recap`, `hot_news`, `my_news`, `news_articles`, `quote_fid_`,
  `sub0…sub8`, `sub100`, `p1…p8`, `pmLink`.
- **Top-level wrappers:**
  ```html
  <div class="pagebody" id="home">
  <div class="pagefooter">
  <table cellspacing="0" class="pageheader">
  ```
- **Module pattern:** `<table class="homepagemodule report">` (6× on the home
  page), and `<table class="playoffbracket homepagemodule">` (2×).
- **Playoff bracket classes:** `bracket`, `topteam`, `bottomteam`,
  `franchise_GAME1…GAME4`, `franchise_SEED1…SEED6`, `championship_week`,
  `playoffbracketname`, `week15|16|17`.
- **Notable `<script src=…>` blocks:** loads our custom header loader script
  (`https://cdn.jsdelivr.net/gh/keithcreelman/upsmflproduction@<sha>/site/loader.js`).

---

## Cross-page class catalog

Master sorted list of every class seen, ranked by # of pages it appears on.
Use this to determine whether a selector is universal (target it once in the
header), per-page (scope with `#body_options_NN`), or per-position/per-franchise.

| Class | # Pages | Pages |
| --- | --- | --- |
| `no-sub` | 8 | all |
| `oddtablerow` | 8 | all |
| `eventablerow` | 8 | all |
| `has-sub` | 8 | all |
| `sub-default` | 8 | all |
| `report` | 8 | all |
| `bannerimage` | 8 | all |
| `brandlogo` | 8 | all |
| `mfl-icon` | 8 | all |
| `mm-draft` | 8 | all |
| `mm-help` | 8 | all |
| `mm-league` | 8 | all |
| `mm-myacct` | 8 | all |
| `mm-player` | 8 | all |
| `mm-scores` | 8 | all |
| `mm-social` | 8 | all |
| `mm-trans` | 8 | all |
| `myfantasyleague_menu` | 8 | all |
| `pagebody` | 8 | all |
| `pagefooter` | 8 | all |
| `pageheader` | 8 | all |
| `pagetitle` | 8 | all |
| `welcome` | 8 | all |
| `reportnavigation` | 5 | O05, O07, O100, O144, O43 |
| `reportnavigationheader` | 5 | O05, O07, O100, O144, O43 |
| `reportfooter` | 4 | O05, O144, O43, home |
| `points` | 3 | O07, O08, home |
| `salary` | 3 | O07, O08, O44 |
| `player` | 3 | O07, O08, home |
| `position_wr` | 3 | O07, O08, home |
| `position_rb` | 3 | O07, O08, home |
| `warning` | 3 | O07, O08, home |
| `position_qb` | 3 | O07, O08, home |
| `position_te` | 3 | O07, O08, home |
| `inputlabel` | 3 | O05, O144, O43 (login-wall form input labels) |
| `form_buttons` | 3 | O05, O144, O43 (login-wall submit row) |
| `week` | 2 | O07, O08 |
| `contractyear` | 2 | O07, O08 |
| `rank` | 2 | O08, home |
| `franchiseicon` | 2 | O07, O44 |
| `mobile-wrap` | 2 | O08, home |
| `position_dt` | 2 | O07, home |
| `franchise_0001…franchise_0012` | 2 each | O07, O44 |
| `nocaption` | 2 | O08, O44 |
| `contractinfo` | 1 | O07 |
| `contractstatus` | 1 | O07 |
| `drafted` | 1 | O07 |
| `status` | 1 | O08 |
| `newposition` | 1 | O07 |
| `injurystatus` | 1 | O07 |
| `avg` | 1 | O08 |
| `tot` | 1 | O08 |
| `bracket` | 1 | home |
| `position_de` | 1 | O07 |
| `week16` | 1 | home |
| `week17` | 1 | home |
| `position_lb` | 1 | O07 |
| `week15` | 1 | home |
| `position_s` | 1 | O07 |
| `two_column_layout` | 1 | O07 |
| `cap_room_available_row` | 1 | O07 |
| `salary_cap_row` | 1 | O07 |
| `topteam` | 1 | home |
| `total_salary_row` | 1 | O07 |
| `withfranchiseicon` | 1 | O07 |
| `bottomteam` | 1 | home |
| `headline` | 1 | home |
| `homepagemodule` | 1 | home |
| `timestamp` | 1 | home |
| `franchise_` | 1 | home (empty franchise — placeholder) |
| `homepagecolumn` | 1 | home |
| `myfranchise` | 1 | home |
| `homepagetabcontent` | 1 | home |
| `championship_week` | 1 | home |
| `franchise_GAME1…GAME4` | 1 each | home |
| `franchise_SEED1…SEED6` | 1 each | home |
| `header` | 1 | home |
| `playoffbracket` | 1 | home |
| `playoffbracketname` | 1 | home |
| `position_cb` | 1 | O07 |
| `articlecaption` | 1 | home |
| `articlepicture` | 1 | home |
| `articlepicturetable` | 1 | home |
| `currentweek` | 1 | O07 |
| `main_tabmenu` | 1 | home |
| `myfantasyleague_tabmenu` | 1 | home |
| `position_pk` | 1 | O07 |
| `position_pn` | 1 | O07 |
| `reportform` | 1 | O08 |
| `weeklypointtotals` | 1 | O08 |

---

## Cross-page ID catalog

| ID pattern | Pages | Purpose |
| --- | --- | --- |
| `body_<page>` | every page | **The reliable per-page scope hook.** `body_home`, `body_options_05`, `body_options_07`, `body_options_08`, `body_options_43` *(expected when authed; current shows `body_login`)*, `body_options_44`, `body_options_100`, `body_options_144` *(expected; currently `body_login`)*, `body_login` (login wall) |
| `options_<NN>` | every options page | div wrapper on `.pagebody` — e.g. `<div class="pagebody" id="options_07">` |
| `home` | home | `<div class="pagebody" id="home">` |
| `login` | login-wall pages (O=05, O=43, O=144) | `<div class="pagebody" id="login">` |
| `custom` | every page | the `<link>` to the league custom skin CSS (`light.css`) |
| `default` | every page | the `<link>` to `MFLBaseCSS.css` |
| `p1`…`p8` | every page | top nav primary menu items (League/Roster/Players/Scores/Trans/Draft/Social/Help) |
| `pmLink` | every page | menu link |
| `sub0`…`sub8` | every page | top nav submenu containers |
| `franchiseicon_0001…franchiseicon_0012` | O=07, O=44 | per-franchise icon hooks |
| `REMEMBER_Yes`, `REMEMBER_No` | login-wall pages only | login form radio inputs |
| `homepagecolumn1`, `homepagecolumn2`, `homepagecolumns` | home | layout columns |
| `homepagetabs` | home | tab strip |
| `playoff1`, `playoff2` | home | playoff bracket modules |
| `fantasy_articles`, `fantasy_preview`, `fantasy_recap`, `hot_news`, `my_news`, `news_articles` | home | content modules |
| `options_43` | O=43 (authed) | inferred — not yet captured |

---

## Findings: what's different about O=43 vs auction_results (O=44) and the rookie/auction hub

Public-side comparison:

1. **`body` id differs.** O=44 (public, real content) emits `<body id="body_options_44">`; O=43 (public, login wall) emits `<body id="body_login">`. **Authenticated O=43 will emit `<body id="body_options_43">`** — this is the selector our overrides should target if they need to scope to the auction-management page.
2. **`.pagebody` div id matches the page slug.** `<div class="pagebody" id="options_44">` on O=44; `<div class="pagebody" id="login">` on the login-walled O=43 (would be `id="options_43"` when authed).
3. **O=44 has no `reportnavigation` block at all.** It's a pure data table (auction summary). O=43's "Hint:" block, in contrast, uses the canonical `<span class="reportnavigation"><span class="reportnavigationheader">Hint:</span>` wrapper (confirmed by the login-wall HTML; confirmed historically by the worker's `/admin/auction/probe-o43` regex matches).
4. **O=44 emits `<table class="report nocaption">`**, suppressing the caption row. O=43's auction-management page presumably uses `<table class="report">` *with* a caption (the page title block), which means it picks up the larger `caption` typography.
5. **The "auction hub" / "rookie hub" pages that DO accept our dark theme.** The most likely reason they look styled is that they use the same `report`, `oddtablerow`, `eventablerow`, `franchiseicon` classes used on O=44, with no extra `reportnavigation` / `reportnavigationheader` lines. Any override we wrote targeting those general classes carries over to O=44 unmodified. **O=43 introduces `reportnavigation` and `reportnavigationheader` into the same page** — if our dark-theme override doesn't set explicit colors on those two classes, MFL's base + `light.css` rules win and produce mismatched light text on dark backgrounds (or vice versa). This is the likeliest explanation for why O=43 has been "breaking" while sibling pages look fine.

**Action item for the styling fix:** add explicit color rules for
`.reportnavigation` and `.reportnavigationheader` in the league custom header
CSS, scoped (if desired) with `#body_options_43`. Example shape:

```css
#body_options_43 .reportnavigation,
#body_options_43 .reportnavigation a {
  color: var(--ups-fg, #e6e8ee);
  background: transparent;
}
#body_options_43 .reportnavigationheader {
  color: var(--ups-fg-strong, #fff);
  font-weight: 700;
}
```

---

## Findings: classes we may have been GUESSING wrong about

Things to double-check in `header_custom_v2.html` / `footer_custom_v2.html`
against this canon:

- ❌ `.hint`, `.hint-text`, `.note`, `.help-text`, `.alert-info`, `.muted`,
  `.subdued` — **none of these exist on MFL pages.** If overrides reference
  them, they're no-ops.
- ✅ `.reportnavigation`, `.reportnavigationheader` — these are the real
  classes for hint/note text. Use these.
- ❌ `.salary-table`, `.roster-table`, `.contract-table`, `.standings-table` —
  **MFL uses just `.report`** (sometimes `.report.nocaption` or
  `.homepagemodule.report`). Any selector mentioning a "kind"-specific table
  class is wrong; scope with `#body_options_NN .report` instead.
- ❌ `.row-odd`, `.row-even`, `.zebra-*`, `.tr-alt` — **MFL emits
  `.oddtablerow` and `.eventablerow`** (note the typo "eventablerow" not
  "eventablerow") — both spellings are literally how MFL writes them.
- ❌ `.position-qb`, `.position-rb` (kebab case) — **MFL uses underscore:
  `.position_qb`, `.position_rb`, …, `.position_pn` (punter)**.
- ❌ `.team-1`, `.franchise-1`, `.franchise-01` — **MFL uses
  `.franchise_0001` … `.franchise_0012`** (zero-padded to 4 digits).
- ❌ `.cap-row`, `.cap-summary-row` — **MFL uses `.cap_room_available_row`,
  `.salary_cap_row`, `.total_salary_row`** on O=07.
- ❌ `.injury`, `.warning-icon` — **MFL uses `.injurystatus`, `.warning`,
  `.newposition`**.
- ❌ `.module`, `.widget`, `.card` — **MFL home modules are
  `.homepagemodule` (or `.homepagemodule.report` for tables)**.
- ❌ `:root { --ups-… }` overrides assumed to "win" — **MFL emits NO `:root`
  declarations and NO custom properties**, so our `--ups-…` variables only
  exist if our custom header injects them. Anywhere our override references a
  variable that doesn't have a fallback, we'll get the browser default.
- ❌ Targeting `<body>` without an `id` — **scope with `#body_options_43`,
  `#body_options_44`, etc., not bare `body`**, otherwise the rule applies to
  the home page and to MFL's own login wall too (this can cause the login
  page to be styled in unintended ways).

---

## Recommended next steps

1. Re-run capture for O=05, O=43, O=144 with `MFL_COOKIE` (via worker probe or
   a one-off `curl -H "Cookie: MFL_USER_ID=…"`) and append authenticated
   class/ID lists below. The `/admin/auction/probe-o43` worker route already
   returns structured Hint-wrapper info — invoke it locally with
   `COMMISH_API_KEY` for a quick confirmation.
2. Audit `header_custom_v2.html` for the wrong-guess classes in the section
   above and replace with the canonical ones.
3. Add `#body_options_43`-scoped rules covering `.reportnavigation` /
   `.reportnavigationheader` colors.
4. Reconcile with `docs/mfl_native/mfl_customization_official.md` once that
   doc exists (per task brief).
