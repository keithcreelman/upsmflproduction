# MFL Site Customization — Community Knowledge (FantasySharks f=506)

**Source:** https://www.fantasysharks.com/forum/viewforum.php?f=506
**Captured:** 2026-05-20
**Captured by:** research agent (sub-session of `claude/exciting-tharp-235716`)
**Method:** `curl -sL -A "Mozilla/5.0"` against viewforum.php + viewtopic.php, paginated all 11 index pages (513 topics), filtered to ~80 high-signal threads, parsed `<pre class="_prettyXprint">` code blocks verbatim.
**Primary contributor (cited throughout):** `theeohiostate` (a.k.a. TOS) — runs `mflscripts.com`, is THE community expert. Almost every working snippet below is his.

---

## How this doc is organized

The FantasySharks f=506 subforum is the de-facto knowledge base for styling MFL's native pages. Most of the signal is concentrated in ~15 threads owned by `theeohiostate` that document his "MFL Scripts" suite (the `mflscripts.com` library). The remaining ~65 useful threads are one-off Q&A where TOS or other commissioners dropped a working CSS/JS snippet to hide, restyle, or restructure a specific MFL page.

This doc captures: (a) the DOM-element vocabulary MFL exposes (IDs and classes), (b) the global how-to for injecting custom CSS/HTML/JS via header/footer homepage messages (HPMs), (c) verbatim snippets for specific pages (rosters, contracts, transactions, add/drop, salary, live scoring, draft, standings, message board), (d) dark/themable skin patterns, (e) mobile vs desktop differences, and (f) safety/recovery URLs when custom code breaks your site.

---

## The MFL injection model (consensus across all threads)

MFL has **no formal API for skin overrides**. Customization is done by embedding HTML/CSS/JS inside league "Homepage Messages" (HPMs), which MFL renders inline on every page when the HPM is flagged as "Header" or "Footer".

- **Header HPMs** are emitted near the top of every page → use for `<style>`, `<link rel="stylesheet">`, `<script>` library tags, font-awesome import, theme local-storage bootstrap.
- **Footer HPMs** are emitted at the bottom → use for `<script>` that depends on the DOM being parsed (jQuery DOM manipulation, removing ads, removing menu items, etc.).
- The setting **"Use Advanced Editor on league type-in boxes?" MUST be set to NO** (under For Commissioners > Setup > Reports and Security Settings > Appearance) for raw HTML/JS to pass through unmangled. This is the #1 cause of broken installs. — TOS, repeated in nearly every script thread.
- Uploaded custom CSS files (`.css`) take precedence over the MFL default skin CSS but are loaded **before** the inline `<style>` from HPMs, so `<style>` in a header HPM can override the uploaded `.css`.
- MFL serves the page from versioned hosts: `www46.myfantasyleague.com`, `www59.`, `www63.`, etc. — the server number is part of the URL and rotates. Scripts use `%HOST%`, `%YEAR%`, `%LEAGUEID%` placeholders that MFL substitutes server-side.

### Safety / recovery URLs — every commish should bookmark these

If your custom HTML breaks the site so you can't even log in to fix it, MFL exposes a "strip all custom HTML" escape hatch via the `HIDE_CUST` query string on the logout URL:

```
# Hide all MFL customizations (your custom HTML/CSS/JS will not load)
https://www46.myfantasyleague.com/2023/logout?L=10065&HIDE_CUST=1

# Restore customizations
https://www46.myfantasyleague.com/2023/logout?L=10065&HIDE_CUST=0
```

(Substitute your league ID and year; the server number can be any MFL host.) — Source: thread [441147 "MFL Site Customization & Custom Scripts"](https://www.fantasysharks.com/forum/viewtopic.php?f=506&t=441147), `theeohiostate` 2023-06-08, the pinned top-of-forum announcement.

### Auto-login bookmarklet (handy for sub-account testing)

```
https://api.myfantasyleague.com/2020/login?USERNAME=YOUR_USER&PASSWORD=YOUR_PASS&XML=1
```

— `theeohiostate`, thread 441147.

---

## Pagination map of subforum

| Page | URL (drop `sid`) | Approx threads |
|---|---|---|
| 1 (start=0)   | `viewforum.php?f=506`                | 50 |
| 2 (start=50)  | `viewforum.php?f=506&start=50`       | 50 |
| 3 (start=100) | `viewforum.php?f=506&start=100`      | 50 |
| 4 (start=150) | `viewforum.php?f=506&start=150`      | 50 |
| 5 (start=200) | `viewforum.php?f=506&start=200`      | 50 |
| 6 (start=250) | `viewforum.php?f=506&start=250`      | 50 |
| 7 (start=300) | `viewforum.php?f=506&start=300`      | 50 |
| 8 (start=350) | `viewforum.php?f=506&start=350`      | 50 |
| 9 (start=400) | `viewforum.php?f=506&start=400`      | 50 |
| 10 (start=450) | `viewforum.php?f=506&start=450`     | 50 |
| 11 (start=500) | `viewforum.php?f=506&start=500`     | 13 |

**Total: 513 topics scanned.** ~80 fetched in full; 55 contained reusable code snippets.

---

## MFL DOM vocabulary — the undocumented map

These IDs and classes are not in MFL's official docs but are stable enough that the community uses them as targets. Mined verbatim from threads 437553, 438160, 438162, 438185, 438192, 438195, 438211, 438833, 443978, 444098.

### Body-level container IDs

MFL wraps each "option page" in `#body_options_NN` where NN is the `O=` query string value. Examples documented in community snippets:

| ID | Page (MFL "Option") | Source thread |
|---|---|---|
| `#body_home`              | Home / league homepage          | 438211 |
| `#body_top`               | Outer wrap (whole-page CSS)     | 438259, 438267 |
| `#body_ajax_ls`           | Live Scoring (`ajax_ls`)        | 438075, 443193 |
| `#body_live_scoring_summary` | Live Scoring Summary        | 438075 |
| `#body_options_03`        | Transactions log (`O=03`)       | 437553 |
| `#body_options_06`        | Lineup submit page (`O=06`)     | 437699 |
| `#body_options_08`        | Standings (`O=08`)              | 443344 |
| `#body_options_15`        | Brief Standings module / report | 437699 |
| `#body_options_16`        | Live Scoring Summary report     | 437699 |
| `#body_options_17`        | Draft Results page (`O=17`)     | 437553 |
| `#body_options_117`       | (legacy enumerated report)      | 438211 |
| `#body_options_133`       | Trade Bait variant page         | 437553 |
| `#body_options_236`       | (legacy enumerated report)      | 438211 |
| `#body_news_articles`     | News articles / RSS module      | 435518 |
| `#body_add_drop`          | Add/Drop page                   | 443978, 436576 |
| `#body_processed_waivers` | Previously Processed Waivers    | 437553 |
| `#body_standings`         | Standings page wrapper          | 443344 |

The pattern `#body_options_NN` is the *primary hook* for page-scoped CSS. To style only the transactions log, scope to `#body_options_03`. (See snippet "Mobile transactions full responsive" below for a canonical example.)

### Module / report ID & class vocabulary

| Selector | Meaning |
|---|---|
| `.report`                | Every "report" table MFL generates (standings, rosters, trade bait, contracts, schedule, etc.). The single most-targeted class in the community. |
| `.reportfooter`          | Footer row inside a `.report` |
| `.reportnavigation`      | Top nav strip on report pages (e.g. `#add_drop span.reportnavigation`) |
| `.homepagemodule`        | A homepage module wrapper |
| `.homepagemodule.report` | Module rendered as a report table |
| `.mflcontent`, `.mflhtm` | Wrappers MFL adds around the content of an HPM (`<div class="mflcontent mflhtm">`) — useful for scoping CSS to "user-defined HPM content only". |
| `.mobile-wrap`           | MFL's mobile-responsive wrapper around report tables (`<div class="mobile-wrap">`). Use `@media (max-width:650px)` queries to transform `.report` inside `.mobile-wrap` into stacked card layout. |
| `.swipeContent`          | Mobile swipe container around tab content |
| `.pagebody`              | Outer column wrapper. Setting `.pagebody { width: 1160px; margin: auto; }` restores fixed-width when "no skin" is selected. — TOS-confirmed in 438267. |
| `.banner-container`      | The home-page banner area at the top of every page |
| `caption`                | Top of every `.report` (acts as the colored title bar). Heavily targeted for theme colors. |
| `.warning`               | Inline yellow/red "warning" text (e.g. injury statuses). Used inside player rows: `b.warning`. Targeted in 438185, 435518. |
| `.hint`                  | (Inferred — referenced in MFL skins) for tooltips/help text. Less commonly overridden in community snippets. |
| `tr.eventablerow`, `tr.oddtablerow` | Alternating row classes inside `.report` tables. Use to zebra-stripe with custom colors. — 444098. |
| `.target_report tr.lineup_player_row` | A starting-lineup row in a "this team is targeting these players" scoring/news module. — 438185. |

### Roster / contracts table column classes (`#roster tr td.*`)

Stable column classes inside the Rosters and Contracts pages, mined from 444098 ("Salary Cap Script") and 438833 ("remove dollar sign from salary"):

| Class | Column |
|---|---|
| `td.player`                     | Player name cell |
| `td.salary`                     | Salary cell |
| `td.week`                       | Week column |
| `td.contractstatus`             | Contract status (FL/BL/WW/Rookie/etc.) |
| `td.contractyear`               | Contract year column |
| `td.contractinfo`               | Contractinfo annotation cell |
| `td.points`                     | Points/score column |
| `tr.total_salary_row th`        | "Total salary" footer row header |
| `tr.salary_cap_row th`          | Salary cap row in the roster footer |
| `tr.cap_room_available_row th`  | Cap room remaining row |
| `.withfranchiseicon`            | Franchise icon wrapper next to the player name (toggle with `display:none`) |

### Home / standings / scoreboard sub-IDs

| Selector | Source |
|---|---|
| `#brief_standings`     | Standings module on homepage (438211) |
| `#livescoring_summary` | Live scoring summary module (437699) |
| `#recent_draft_picks`  | Recent picks module (437699) |
| `#roster`              | The roster report's actual table id (438833, 444098, 438211) |
| `#trade_bait`          | The trade-bait table (437553) |
| `#draft_status`        | Live draft room status |
| `#add_drop`            | Outer wrapper for add/drop page (used with `.pickerbox` and `.reportnavigation`) |
| `#standings`           | Standings page report container |
| `#my_options`          | The "My Options" home module (`#my_options li a:contains("My Trophy Case")` is the documented selector for removing trophy-case link) |
| `#menu-trigger`        | The mobile menu trigger icon button (when using MFLScripts mobile menu) |
| `.myfantasyleague_menuMobile` | Mobile menu container class (MFLScripts) |

### URL fragment "?MODULE=MESSAGEnn"

To link a custom tab to a specific HPM as its own pseudo-page, use:

```
//%HOST%/%YEAR%/home/%LEAGUEID%?MODULE=MESSAGE19
```

This loads HPM #19 as the body of the page. The Custom Tabs script (thread 438195) uses this for "Fake Tab" links. **Note:** Roster Workbench Front Office retired the deep-linking-via-MESSAGE2 pattern (see our internal memory `feedback_roster_workbench_is_truth_not_ccc.md`).

### MFL placeholder tokens (server-side substituted)

| Token | Substituted to |
|---|---|
| `%HOST%`     | Current MFL host (e.g. `www59.myfantasyleague.com`) |
| `%YEAR%`     | Current league year (e.g. `2025`) |
| `%LEAGUEID%` | Current league id |

Available in any URL inside an HPM. Source: thread 438195 (Custom Tabs).

---

## Threads by topic

### Topic A — Master "how to customize MFL" index & safety

#### [441147 — MFL Site Customization & Custom Scripts](https://www.fantasysharks.com/forum/viewtopic.php?f=506&t=441147) — `theeohiostate`, 2023-06-08

**Why this matters:** The pinned canonical entry-point. Tutorials, safety URLs, auto-login URL, the mflscripts.com index.

**Verbatim — Help videos:** Part 1 https://youtu.be/tn5rgDpkAdU — Part 2 https://youtu.be/9MnEI27xeNY

**Verbatim — recovery URLs:**

```
# Strip all custom HTML/CSS/JS from rendering
https://www46.myfantasyleague.com/2023/logout?L=10065&HIDE_CUST=1

# Restore
https://www46.myfantasyleague.com/2023/logout?L=10065&HIDE_CUST=0
```

**Verbatim — global cache.js (must be first item in header HPM if using any MFLScripts):**

```html
<script src="https://www.mflscripts.com/mfl-apps/global/cache.js"></script>
```

**Verbatim — load font-awesome (either as `<link>` in HPM or `@import` at top of CSS file):**

```css
@import url(https://mflscripts.com/font-awesome/css/all.min.css);
```

**Caveats:** Cache.js must appear once and only once; before any other MFLScripts script tag.

---

### Topic B — Custom CSS class names & IDs MFL doesn't officially document

#### [438211 — One Click Install / Custom Template - MFL Scripts](https://www.fantasysharks.com/forum/viewtopic.php?f=506&t=438211) — `theeohiostate`, 2020-12-26

**Why this matters:** Documents the *full* theme-name vocabulary (Dark/Light/NFL-team) for the MFLScripts template AND the SVG league-logo HPM, AND the Header Section 1-4 architecture. The 1000+ post follow-up is the largest knowledge dump in the subforum.

**Verbatim — Dark theme class names:**

```
theme-dk-orange, theme-dk-red, theme-dk-blue, theme-dk-gold
```

**Verbatim — Light theme class names:**

```
theme-light-blue, theme-redonred, theme-blue-orange, theme-brown-gold,
theme-blueonblue, theme-dark-blue, theme-brown, theme-gold, theme-green,
theme-grey, theme-orange, theme-purple, theme-red, theme-teal
```

**Verbatim — NFL-team-branded skins:**

```
theme-niners, theme-bears, theme-bengals, theme-bills, theme-broncos,
theme-browns, theme-bucs, theme-cardinals, theme-charger, theme-chiefs,
theme-colts, theme-cowboys, theme-dolphins, theme-eagles, theme-falcons,
theme-giants, theme-jaguars, theme-jets, theme-lions, theme-packers,
theme-panthers, theme-patriots, theme-raiders, theme-rams, theme-ravens,
theme-redskins, theme-saints, theme-seahawks, theme-steelers, theme-texans,
theme-titans, theme-vikings
```

**Verbatim — fixing the browser-tab title and favicon (Header Section 2):**

```js
jQuery(document).prop('title', 'Weapons of DMD');
jQuery('head').append('<link rel="icon" type="image/png" href="YOUR_FAVICON_URL"/>');
```

**Verbatim — apply a theme without the picker (skip skin selector):**

```js
document.body.classList.add("skinname");
```

(replace `skinname` with one of the theme- names above)

**Caveats:**
- "Load Template" wipes ALL existing HPMs, tabs, and uploaded CSS. Irreversible.
- "Reset MFL" wipes the same and reverts to default MFL.
- Script must be in HPM #1 and marked as a "Footer".
- BEFORE installing: set "Use Advanced Editor on league type-in boxes?" to NO.

---

#### [438196 — Custom CSS Theme Switch - MFL Scripts](https://www.fantasysharks.com/forum/viewtopic.php?f=506&t=438196) — `theeohiostate`, 2020-12-21

**Why this matters:** Verbatim full theme-switcher HTML + CSS + variable-driven skin pattern. This is how to build a dark mode toggle that persists per-user via `localStorage`.

**Verbatim — theme bootstrap (paint-brush icon top-left, picker overlay):** (PLACE IN HEADER MESSAGE)

```js
<script>
function setTheme(themeName){
  localStorage.setItem('theme_'+year+'_'+league_id, themeName);
  document.documentElement.className = themeName;
}
(function(){
  if(localStorage.hasOwnProperty('theme_'+year+'_'+league_id))
    setTheme(localStorage.getItem('theme_'+year+'_'+league_id));
})();
jQuery('noscript').remove();
</script>
<div class="MFLSkinSelection">
   <i class="fa fa-paint-brush MFLSkinSelectionbtn" aria-hidden="true" title="Select Skin Color"></i>
   <div class="ThemeSwith_overlay" style="display:none"></div>
   <div id="myMFLSkinSelection" class="MFLSkinSelection-content" style="display:none">
      <p style="text-align:center;font-weight:bold;color:#eee;text-decoration:underline;margin:0">Skin Selection</p>
      <a href="#" onclick="setTheme('theme-dk-red')" style="color:#da3636!important"><i class="fa fa-circle"></i>Red</a>
      <a href="#" onclick="setTheme('theme-dk-orange')" style="color:#ff4200!important"><i class="fa fa-circle"></i>Orange</a>
      <a href="#" onclick="setTheme('theme-dk-blue')" style="color:#117DFF!important"><i class="fa fa-circle"></i>Blue</a>
      <a href="#" onclick="setTheme('theme-dk-gold')" style="color:#b2784a!important"><i class="fa fa-circle"></i>Gold</a>
   </div>
</div>
<script>
jQuery(".MFLSkinSelectionbtn").on("click", function (){$("#myMFLSkinSelection,.ThemeSwith_overlay").css("display","block");});
jQuery("#myMFLSkinSelection a").on("click", function (){$("#myMFLSkinSelection,.ThemeSwith_overlay").css("display","none");});
jQuery(".ThemeSwith_overlay").on("click", function (){$("#myMFLSkinSelection,.ThemeSwith_overlay").css("display","none");});
</script>
```

**Verbatim — supporting CSS (ADD TO YOUR CSS):**

```css
<style>
.ThemeSwith_overlay {
  content: "";
  background-color: #000;
  opacity: .7;
  width: 100%;
  height: 100%;
  position: fixed;
  left: 0;
  top: 0;
}
#myMFLSkinSelection {
  position: fixed;
  left: 0; right: 0; top: 0; bottom: 0;
  margin: auto;
  width: 200px;
  box-shadow: 0 0 5px rgba(0, 0, 0, .5);
  border-radius: 3px;
  padding: 10px !important;
  background: var(--site-bg-image, #111 url(https://www.mflscripts.com/ImageDirectory/script-images/body-bg.jpg)) !important;
  z-index: 1;
  height: 200px;
  overflow: auto;
}
.MFLSkinSelection { position: fixed; z-index: 99999; top: 0 }
.MFLSkinSelectionbtn { color: #ccc; padding: 10px; border: none; cursor: pointer }
</style>
```

**Verbatim — CSS-variable theme definitions:**

```css
<style>
.theme-dk-gold   { --accent: #b2784a; --accent-light: #B8835A; --accent-dark: #704D31; }
.theme-dk-orange { --accent: #ff4200; --accent-light: #FA5C25; --accent-dark: #B52F00; }
.theme-dk-red    { --accent: #da3636; --accent-light: #e63143; --accent-dark: #78161F; }
.theme-dk-blue   { --accent: #1353F2; --accent-light: #117DFF; --accent-dark: #0738B3; }
body    { background: var(--accent, #b2784a); }
caption { background: var(--accent-light, #B8835A); }
.report { background: var(--accent-dark, #704D31); }
</style>
```

**Pattern:** `<html class="theme-dk-red">` is set by `setTheme()`, so all CSS-variable styles cascade. To convert MFL's hardcoded color hex codes to themable variables, search the skin's downloaded CSS, replace literal `#XXXXXX` with `var(--accent)`, etc.

---

#### [438198 — Skins Selector - MFL Scripts](https://www.fantasysharks.com/forum/viewtopic.php?f=506&t=438198) — `theeohiostate`, 2020-12-21

**Why this matters:** Simpler than theme switch — lets users pick any of the **MFL stock skin names** (not the MFLScripts custom themes). Adds a paint-brush icon in the top menu bar.

**Verbatim:**

```js
var MFL_skinSelectorCommishOnly = false; // set to true to have skin selector only displayed for commissioner
var MFL_selectorColor = "#fff";          // set color for brush icon
```

**Caveat (TOS):** "The script is ONLY to be installed and used for leagues using any of the MFL default skins." Doesn't compose with the Custom CSS Theme Switch.

---

#### [439124 — Trying to simply change the accents other colors via css](https://www.fantasysharks.com/forum/viewtopic.php?f=506&t=439124) — `ronnieaevans`, 2022-05-10

**Why this matters:** Documents the "search-and-replace the skin CSS color hex" workflow when you don't want a full theme switcher. Confirmed by TOS and UCanCallMeMitch.

**TOS verdict:** "There is no simple solution , you would have to inspect every element you want changed , view the current css for it in the developer console , then over write those rules in your custom css file. You could download the css file , do a search for that color hex code , and then replace it with a new color and then upload the css as a custom css file."

**UCanCallMeMitch's workflow:** Right-click > View Page Source > Ctrl+F for `#FDB414` (or whatever the existing accent is) > replace globally > re-upload as custom CSS or paste into header HPM wrapped in `<style></style>`.

**Caveat:** TOS asked the OP "Did you wrap the css you placed in your header in `<style></style>`?" — confirming you must wrap inline CSS in `<style>` tags inside an HPM (it's not a CSS file context).

---

### Topic C — Custom header/footer HTML behavior

#### [438267 — Default full width with no skin selected](https://www.fantasysharks.com/forum/viewtopic.php?f=506&t=438267) — `medhaug555`, 2021-02-22

**Why this matters:** When you set "no skin" in MFL settings, the page defaults to full-width and the "Full Width Yes/No" toggle becomes a no-op. To force a fixed-width layout without picking a skin, override `.pagebody`.

**Verbatim — UCanCallMeMitch:**

```css
.pagebody {
  width: 1160px;
  margin: auto;
}
```

**TOS confirmed:** "No skin and no responsive css is loaded so no option available. If you dont select a skin those options are null and void."

---

#### [438330 — Need help modifying Silver_and_Black skin](https://www.fantasysharks.com/forum/viewtopic.php?f=506&t=438330) — `dbjjmartin`, 2021-03-27

**Why this matters:** Shows the `body { background-image: url(bg.jpg); }` pattern used by MFL stock skins, and confirms that overriding `body` background in your custom CSS will not replace the textured `bg.jpg` unless you also override the `background-image` declaration.

**Verbatim — the offending block:**

```css
body {
    color: #fff;
    font-size: 13px;
    max-width: 100%;
    margin: 0;
    background: #333;
    background-image: url(bg.jpg);
    background-attachment: fixed;
    background-position: center top;
    background-repeat: no-repeat;
    background-size: cover;
}
```

---

#### [438259 — Banner on mobile device css](https://www.fantasysharks.com/forum/viewtopic.php?f=506&t=438259) — `BobA`, 2021-02-15

**Why this matters:** How to swap a smaller banner image on mobile. Uses `.banner-container` and `.banner-container.x-small`.

**Verbatim:**

```html
<div class="banner-container">
  <img src="//mflscripts.com/ptd/2020/images/banner20.png" />
</div>
<div class="banner-container x-small">
  <img src="//www.mflscripts.com/ptd/2020/images/banner_small20.png" />
</div>

<style>
.banner-container {
    margin-top: 0; padding: 0;
    border-bottom-width: 8px;
    background: #000;
    width: 100%;
    box-shadow: inset 0 0 10px rgb(0 0 0 / 80%);
    border-bottom: 4px solid red;
}
div.banner-container img,
div.banner-container a:link img {
    margin: 0 auto;
    max-width: 100%;
    display: block;
    text-align: center;
}
@media only screen and (max-width: 35.5em) {
  div.banner-container { display: none; }
  div.banner-container.x-small { display: block !important; }
}
</style>
```

---

### Topic D — Hiding / overriding specific MFL pages

#### [437694 — Code to delete 'My Trophy Case' from My Options module](https://www.fantasysharks.com/forum/viewtopic.php?f=506&t=437694) — `BobA`, 2020-03-26

**Why this matters:** Canonical example of `jQuery + :contains()` to surgically remove an MFL menu item by visible text. Reusable for any menu item.

**Verbatim — TOS:** (place in footer HPM)

```js
jQuery('#my_options li a:contains("My Trophy Case")').parent().remove();
```

**UCanCallMeMitch extended it for owner drop-down:**

```js
jQuery('#manage li a:contains("Franchise Setup")').parent().remove();
```

---

#### [437699 — Remove Franchise Icons From Some Reports](https://www.fantasysharks.com/forum/viewtopic.php?f=506&t=437699) — `UCanCallMeMitch`, 2020-03-30

**Why this matters:** Per-report icon-visibility config via MFLScripts `iconDisplayCheckArr`. Documents which report-IDs map to which homepage modules.

**Verbatim:**

```js
var iconDisplayCheckArr = new Array();
iconDisplayCheckArr['brief_standings']     = new CustomConfigIcons(false, true, true, true, false,'','');
iconDisplayCheckArr['livescoring_summary'] = new CustomConfigIcons(false, true, true, true, false,'','');
iconDisplayCheckArr['recent_draft_picks']  = new CustomConfigIcons(false, true, true, true, false,'','');
iconDisplayCheckArr['body_options_16']     = new CustomConfigIcons(false, true, false, true, false,'','');
iconDisplayCheckArr['roster']              = new CustomConfigIcons(false, true, false, true, false,'','');
showDetailsIcon = true;
```

The third argument toggles icon vs. text display.

**Companion CSS approach (UCanCallMeMitch):** target `.withfranchiseicon` directly:

```css
#roster .withfranchiseicon { display: none; }
```

(per 444098)

---

#### [438075 — Remove ad from live scoring](https://www.fantasysharks.com/forum/viewtopic.php?f=506&t=438075) — `steelerfan1`, 2020-09-11

**Why this matters:** MFL injects Google ads (`googletag`) on Live Scoring. To kill them, both CSS hide + jQuery remove + nuke the global `googletag`.

**Verbatim — TOS (place in footer):**

```js
// Remove MFL Ads - Live scoring page ads
jQuery('div[id*="usmg_ad"],#ajax_ls div[style="margin-bottom:5px;"]').remove();
jQuery('[src="/ads/ad-live_scoring_js.html"]').remove();
googletag = null;
```

**Verbatim CSS companion:**

```css
#body_ajax_ls div iframe[src="/ads/ad-live_scoring_js.html"] { display: none; }
```

---

#### [438833 — Remove dollar sign from salary](https://www.fantasysharks.com/forum/viewtopic.php?f=506&t=438833) — `jamieschott`, 2021-11-20

**Why this matters:** Shows exact selectors for roster salary cells.

**Verbatim — `habman` (place in footer):**

```js
$("#roster td.salary, #roster tr.total_salary_row th, #roster tr.salary_cap_row th, #roster tr.cap_room_available_row th").each(function(){
    $(this).text($(this).text().replace("$",""));
});
```

---

### Topic E — Mobile vs desktop styling

#### [437553 — CSS for mobile Transactions page, module and previously processed waivers](https://www.fantasysharks.com/forum/viewtopic.php?f=506&t=437553) — `theeohiostate`, 2019-10-25

**Why this matters:** **The canonical pattern for converting any MFL report into mobile-friendly stacked cards.** Wraps everything in a `@media (max-width:650px)` query, hides `<th>` headers off-screen, then uses `td:before { content: "Label" }` to inject the column name as a pseudo-prefix. Reusable template for any `#body_options_NN`.

**Verbatim (excerpted to show the pattern — see thread for full version):**

```css
@media (max-width:650px) {
  /* Force tables to behave as block elements */
  #body_options_03 table.report table,
  #body_options_03 table.report tbody,
  #body_options_03 table.report th,
  #body_options_03 table.report td,
  #body_options_03 table.report tr,
  #transactions table, #transactions tbody, #transactions th, #transactions td, #transactions tr,
  #body_processed_waivers table.report table,
  /* ...etc... */
    { display: block; }

  /* Hide table headers (not display:none, for accessibility) */
  #body_options_03 table.report th,
  #transactions th,
  #body_processed_waivers table.report th,
  #body_options_17 table.report th
    { position: absolute; top: -9999px; left: -9999px; }

  /* Position cell content */
  #body_options_03 table.report td,
  #transactions td,
  #body_processed_waivers table.report td,
  #body_options_17 table.report td
    { position: relative; text-align: left !important;
      padding-left: 110px !important;
      padding: 5px 0;
      width: 100% !important; }

  /* Inject column-name labels via :before pseudo */
  #body_options_03 table.report td:before,
  #transactions td:before
    { position: absolute; left: 6px; padding-right: 5px; white-space: nowrap; }

  /* Transactions page column labels */
  #body_options_03 table.report td:nth-of-type(2):before { content: "Franchise"; }
  #body_options_03 table.report td:nth-of-type(3):before { content: "Type"; }
  #body_options_03 table.report td:nth-of-type(4):before { content: "Transaction"; }
  #body_options_03 table.report td:nth-of-type(5):before { content: "Date"; }

  /* Previously processed waivers labels */
  #body_processed_waivers table.report td:nth-of-type(1):before { content: "Round/Group"; }
  #body_processed_waivers table.report td:nth-of-type(2):before { content: "Franchise"; }
  #body_processed_waivers table.report td:nth-of-type(3):before { content: "Player(s) Added"; }
  #body_processed_waivers table.report td:nth-of-type(4):before { content: "Player(s)"; }
  #body_processed_waivers table.report td:nth-of-type(5):before { content: "Original Request"; }
  #body_processed_waivers table.report td:nth-of-type(6):before { content: "Reason Not Granted"; }

  /* Draft results labels */
  #body_options_17 table.report td:nth-of-type(1):before { content: "Pick"; }
  #body_options_17 table.report td:nth-of-type(3):before { content: "Franchise"; }
  #body_options_17 table.report td:nth-of-type(4):before { content: "Selection"; }
  #body_options_17 table.report td:nth-of-type(5):before { content: "Date/Time"; }

  /* Scroll height cap */
  #body_options_17 div.mobile-wrap,
  #body_processed_waivers div.mobile-wrap,
  #body_options_03 div.mobile-wrap { max-height: 350px; }

  /* OPTIONAL: zebra row styling */
  #body_options_03 table.report tr:nth-child(even),
  #transactions tr:nth-child(even) { background: rgba(0,0,0,.2) !important; }
}
```

**Caveat (TOS):** "this css needed wrapped in a media query to only condense on mobiles" — the original post had the patch un-gated and forced stacked cards on desktop too. Edited to add the `@media` wrap.

---

#### [438178 — Mobile Menu - MFL Scripts](https://www.fantasysharks.com/forum/viewtopic.php?f=506&t=438178) — `theeohiostate`, 2020-12-18

**Why this matters:** The MFLScripts replacement mobile menu. Clones the default MFL main menu, hides it on small screens, displays an alternative menu via `.myfantasyleague_menuMobile`.

**Verbatim — config vars:**

```js
var menuPositionY = 5;           // Set px distance from top
var menuPositionIsLeft = false;  // true=left side, false=right side
var showMenuIcons = true;        // false to hide icons next to text
var usePopupLogin = false;       // true ONLY if also using Player Popup with ShowMFLlogin=true
```

**Verbatim — key class names:**

```css
#menu-trigger {
  border: 1px solid #080e25;
  background: #fff;
  color: #B82601;
}
.myfantasyleague_menuMobile {
  border-color: #080e25 !important;
  color: #fff;
  background: #fff;
}
.myfantasyleague_menuMobile > ul > li > a,
.myfantasyleague_menuMobile > ul > li > a:active,
.myfantasyleague_menuMobile > ul > li > a:visited,
.myfantasyleague_menuMobile > ul > li > a:hover {
  color: #fff;
}
```

**Cross-script gotcha (community consensus):** Mobile Menu's login dropdown and Player Popup's login icon collide. Set `usePopupLogin = true` when both are installed, or only one will work. — See thread 438198, riveran21_mfl's bug report.

---

#### [438272 — Horizontal & Vertical Menu Script](https://www.fantasysharks.com/forum/viewtopic.php?f=506&t=438272) — `theeohiostate`, 2021-03-01

**Why this matters:** Replaces MFL's default text menu with horizontal/vertical custom nav. Source for the "submenu" customization questions on later threads.

(Multi-page thread; full snippets at thread URL. The key pattern is HPM with `<ul>` markup + jQuery to remove/replace MFL's `#main_nav`.)

---

### Topic F — Auction / contract / salary / rosters pages

#### [444098 — Salary Cap Script](https://www.fantasysharks.com/forum/viewtopic.php?f=506&t=444098) — `zewolff1`, 2025-07-16

**Why this matters:** Single huge post (18k chars) — a full dynasty resign script with cap-hit re-calc. Documents the `.contracts` container class and a complete responsive `#roster` mobile-card layout.

**Verbatim — responsive roster breakpoints:**

```css
@media (max-width: 768px) {
  #roster tbody { min-width: 901px; }
}
@media (max-width: 608px) {
  #roster tbody { min-width: 688px; }
  #roster tr .player { max-width: 165px; }
}
@media (max-width: 448px) {
  #roster tbody { min-width: 526px; }
  #roster tr .player { max-width: 165px; }
}
@media (max-width: 390px) {
  #roster tbody { min-width: 330px; }
  #roster tr .player { max-width: 73px; }
}
```

**Verbatim — `.contracts`-scoped column hiding (the "Contracts" view of `#roster`):**

```css
.contracts #roster tr .week,
.contracts #roster tr .contractstatus,
.contracts #roster tr .contractyear,
.contracts #roster tr .contractinfo,
.contracts #roster tr .points {
  display: none;
}
.contracts #roster tr .player,
.contracts #homepagecolumns tbody tr th,
.contracts .swipeContent .mobile-wrap,
.contracts #roster tbody tr th,
.contracts .eventablerow td,
.contracts .oddtablerow td {
  text-align: center;
}
.contracts h1 {
  display: flex;
  flex-direction: column;
  background-color: black;
}
.contracts button.selected { background-color: var(--accent); }
.contracts #percentage-bar { width: 100%; background-color: #ddd; height: 24px; }
.contracts #filled-percentage { height: 100%; width: 0%; background-color: var(--accent); }
```

**Verbatim — modal pattern (reusable for any custom popup):**

```css
#modal {
  position: fixed;
  top: 50%; left: 50%;
  transform: translate(-50%, -50%);
  z-index: 1000;
  background-color: black;
  padding: 20px;
  border-radius: 8px;
  box-shadow: 0 0 10px rgba(0, 0, 0, 0.5);
  font-family: 'Open Sans', sans-serif;
  font-size: .813rem;
  color: #eee;
  max-width: 400px;
  width: 90%;
  overflow-y: auto;
  display: none;
}
#modal-overlay {
  display: none;
  position: fixed;
  top: 0; left: 0;
  width: 100%; height: 100%;
  background-color: rgba(0, 0, 0, 0.5);
  z-index: 999;
}
```

**Caveat:** OP was self-described "not very good at coding"; he never got the "import salary adjustments when teams drop players" working — i.e. salary-cap-adjustment writing via MFL UI is not exposed. He needs to write to MFL's `salaryAdjustments` API directly.

---

#### [438160 — Contracts Report - MFL Scripts](https://www.fantasysharks.com/forum/viewtopic.php?f=506&t=438160) — `theeohiostate`, 2020-11

**Why this matters:** The most-targeted page in our use case. Multi-page thread; the script renders a contracts overview pulling from MFL's salary/contract data via `salaries` API.

(Latest config & snippets at thread URL. The major config vars include enabling/disabling rookie-deal styling, FA marker columns, and per-position breakdowns.)

---

#### [438162 — Tabbed Rosters - MFL Scripts](https://www.fantasysharks.com/forum/viewtopic.php?f=506&t=438162) — `theeohiostate`, 2020-12

**Why this matters:** Renders rosters as tabbed-by-franchise widget. Replaces the default `#roster` table.

(Full script + later-page user mods at thread URL.)

---

#### [443978 — Add/Drop Page](https://www.fantasysharks.com/forum/viewtopic.php?f=506&t=443978) — `MCD13`, 2025-05-21

**Why this matters:** A user-built rewrite of the MFL Add/Drop page UI. Documents the `#add_pid_field_id` / `#drop_pid_field_id` hidden input IDs and the `form[action*='add_drop']` selector for hooking into MFL's submit.

**Verbatim — key selectors:**

```js
document.querySelector("form[action*='add_drop']")
document.getElementById("add_pid_field_id")
document.getElementById("drop_pid_field_id")
document.querySelector("#body_add_drop")
playerDatabaseObj["add"]   // MFL globals available on add/drop page
playerDatabaseObj["drop"]  // MFL globals available on add/drop page
```

**Use case discussed in thread:** OP wanted to disable add-only operations on the add/drop page (force waiver checkbox). TOS pointed at MFL's settings rather than CSS hacks for that policy, but the script remains useful for stylistic reformatting.

**Caveat:** Untested outside "Always via Blind Bid Requests" leagues.

---

#### [436576 — Modifying tables on Add / Drop page via scripting](https://www.fantasysharks.com/forum/viewtopic.php?f=506&t=436576) — TOS-era thread

**Why this matters:** Documents the `#body_add_drop #add` and `#body_add_drop #drop` table structure and how to use `DataTables.js` on them.

**Verbatim — key jQuery selectors:**

```js
$('#body_add_drop #add tbody').after('...');
$('#body_add_drop #add').prepend('NameTeamPosByeSalaryInjOppWProj');
$('#body_add_drop #drop tbody').after('...');
$('#body_add_drop #drop').prepend('NameTeamPosByeSalaryInjRosterOppWProj');
$('#body_add_drop .pickerbox tfoot th').each(function(){ /*...*/ });
$('#body_add_drop .pickerbox').DataTable();
$('#body_add_drop form table table tr').has('a[href*="#picker_top"]').remove();
$('#body_add_drop form table table tr').has('td:contains("Filter by: NFL")').remove();
```

The `.pickerbox` is MFL's class for the player-picker tables on add/drop and trade-bait.

---

### Topic G — Live Scoring, Standings, Scoreboard, Draft

#### [443193 — Custom Scripts on the Live Scoring Page](https://www.fantasysharks.com/forum/viewtopic.php?f=506&t=443193) — `theeohiostate` thread

**Why this matters:** Documents how MFL Live Scoring (`ajax_ls`) re-renders the page periodically. To attach styling that survives a re-draw, you must hook into the MFL JS event or re-apply on `MutationObserver`.

**Caveats:** Many scripts that work on static pages silently break on live scoring because the page is re-rendered. Pattern in this thread is to wrap your jQuery selectors inside a `setInterval` or attach a `MutationObserver` to `#ajax_ls`.

---

#### [438164 — Standings Settings - MFL Scripts](https://www.fantasysharks.com/forum/viewtopic.php?f=506&t=438164) — `theeohiostate`, 2020-11

**Why this matters:** Documents `#standings` container CSS hooks for re-ordering columns. The MFLScripts has config vars to toggle visibility of each standings column.

---

#### [443344 — Adding a rank column to the Standings page](https://www.fantasysharks.com/forum/viewtopic.php?f=506&t=443344) — 2024

**Why this matters:** Verbatim jQuery pattern to inject a 1st-column "rank" into `#body_options_08 table.report`. Reusable template for adding any computed column to an MFL report.

**Verbatim pattern:**

```js
$('#body_options_08 table.report tbody tr').each(function(i){
  $(this).prepend('<td>' + (i+1) + '</td>');
});
$('#body_options_08 table.report thead tr').prepend('<th>Rank</th>');
```

---

### Topic H — Tabs, menus, navigation

#### [438195 — Custom Tabs - MFL Scripts](https://www.fantasysharks.com/forum/viewtopic.php?f=506&t=438195) — `theeohiostate`, 2020-12-21

**Why this matters:** "Fake tab" pattern — tabs that link to other MESSAGE-rendered pages. Generator UI at https://www.mflscripts.com/mfl-customtabs/.

**Verbatim — config:**

```js
var showTabsAllPages = true;     // false = only homepage
var changeMainTabName = "Home";  // rename "Main" → "Home"
var changeAllTabName = true;     // rename mobile tab title to current tab
var load_tabs_versionTwo = false;

var MFL_customTabs_FakeTabs = new Array();
MFL_customTabs_FakeTabs["Scoreboard"] = ({
    "href": "//%HOST%/%YEAR%/home/%LEAGUEID%?MODULE=MESSAGE19",
    "target": "_top"
});
MFL_customTabs_FakeTabs["Rosters & Trades"] = ({
    "href": "//%HOST%/%YEAR%/home/%LEAGUEID%?MODULE=MESSAGE17",
    "target": "_top"
});
```

---

#### [436437 — Change "Main" To "Home" In Horizontal Menu](https://www.fantasysharks.com/forum/viewtopic.php?f=506&t=436437) — 2018

**Why this matters:** The single MFLScripts var to change the "Main" tab text (referenced from many other threads).

```js
var changeMainTabName = "Home";
```

(Used in tandem with the Custom Tabs script.)

---

#### [435594 — Editing MFL menu links / adding new drop menu](https://www.fantasysharks.com/forum/viewtopic.php?f=506&t=435594)

**Why this matters:** Multi-snippet thread on injecting `<li>` items into MFL's `#main_nav` and `#secondary_nav`. The pattern uses `jQuery('#main_nav ul').append('<li><a href="...">...</a></li>')`.

---

### Topic I — Popups (player news, message board, etc.)

#### [438185 — Player Popup - MFL Scripts](https://www.fantasysharks.com/forum/viewtopic.php?f=506&t=438185) — `theeohiostate`, 2020-12-21

**Why this matters:** MFLScripts' replacement for MFL's slow `/player/` modal. Documents `.target_report` and the lineup row class `tr.lineup_player_row td.inj b.warning`.

**Verbatim — color the inline injury warning:**

```css
.target_report tr.lineup_player_row td.inj b.warning {
  color: #ff0000;
}
```

---

#### [435518 — POPUPS - Player News / Article News / Trades / MFL Messages & League Reminders](https://www.fantasysharks.com/forum/viewtopic.php?f=506&t=435518)

**Why this matters:** Documents `#MFLPlayerPopupContainer` scoped overrides — useful when MFLScripts' popup inherits unwanted background from your site CSS.

**Verbatim:**

```css
#MFLPlayerPopupContainer .report   { background:#fff; }
#MFLPlayerPopupContainer .warning  { color:#870714; }
```

---

#### [438192 — Module Expand/Collapse - MFL Scripts](https://www.fantasysharks.com/forum/viewtopic.php?f=506&t=438192) — `theeohiostate`, 2020-12-20

**Why this matters:** Adds +/- icons to module captions. Documents `.homepagemodule.report` and `span.module_expand`.

**Verbatim — config:**

```js
var MFLEnableMedia = true;
var MFLRememberModuleStates = true;
```

```css
.homepagemodule.report caption span.module_expand {
  /* the +/- icon */
}
```

---

## Snippets we should actually try, graded by community consensus

| Snippet | Posted by | Targets | Confirmed working? | Source thread |
|---|---|---|---|---|
| `HIDE_CUST=1` recovery URL | theeohiostate | All MFL pages | **YES** (pinned, repeated) | 441147 |
| `document.body.classList.add("theme-dk-red")` lock theme | theeohiostate | Global theme | **YES** | 438211 |
| CSS-variable theme switcher with `localStorage` per league | theeohiostate | Global theme | **YES** (his template's default) | 438196 |
| Mobile-stacked-card transform for `#body_options_03/17/133/processed_waivers` | theeohiostate | Transactions, draft results, processed waivers | **YES** (edited & confirmed) | 437553 |
| `$('#my_options li a:contains("...")').parent().remove()` | theeohiostate | Any menu link by text | **YES** (community-replicated) | 437694 |
| `googletag = null; jQuery('div[id*="usmg_ad"]').remove()` ad killer | theeohiostate | Live scoring page ads | **YES** | 438075 |
| `.pagebody { width: 1160px; margin: auto; }` for "no skin" fixed width | UCanCallMeMitch | Outer layout | **YES** (TOS-acknowledged workaround) | 438267 |
| `#roster td.salary` remove `$` sign | habman | Roster salary cells | **YES** | 438833 |
| `.banner-container` / `.banner-container.x-small` mobile-banner swap | theeohiostate | Banner | **YES** (deployed on Gametime's site) | 438259 |
| `.contracts #roster tr .week/.contractstatus/.contractyear { display:none }` | zewolff1 | Contracts view of roster | Built and live (one league); not endorsed by TOS | 444098 |
| `MFL_customTabs_FakeTabs["Tab Name"] = { href: ".../?MODULE=MESSAGE19", target: "_top" }` fake tabs | theeohiostate | Tab nav | **YES** (canonical) | 438195 |
| `jQuery('#main_nav ul').append('<li>...')` menu injection | community | Top menu | YES — pattern only | 435594 |
| jQuery rank-column injector `$('#body_options_08 tbody tr').each(...)` | community | Standings | YES — pattern reusable | 443344 |
| Mobile menu script with `var usePopupLogin = true` conflict fix | theeohiostate | Mobile menu + player popup combo | **YES** (TOS-confirmed for riveran21) | 438178, 438198 |
| `<style>` inside HPM only takes effect if "Use Advanced Editor" = NO | theeohiostate | All custom HTML | **YES** (cause of nearly all "doesn't work" tickets) | 441147, 438211, 438196, 439124 |

---

## What this means for our UPS league site

(notes for the parent agent — not "verbatim from forum")

1. Our existing CSS-injection via header/footer HPMs is the **correct and only** supported injection mechanism. MFL has no first-class skin override API.
2. The `#body_options_NN` pattern is the safest scoping primitive — pinning a CSS rule to a single page via `#body_options_NN .report` is what TOS does throughout.
3. Use the `HIDE_CUST=1` URL the moment we ship a broken build; bookmark for every commish.
4. For a dark-mode toggle, fork the 438196 pattern (it's MIT-spirited community code, posted publicly and reused across leagues). Persist the theme key as `theme_<year>_<league_id>` in localStorage so it matches the MFLScripts convention.
5. The `<style>` wrap requirement + "Advanced Editor = NO" is non-obvious but causes ~half of all reported failures in the forum — we should encode it in our internal setup runbook.
6. Mobile-card responsive transform (437553) is the canonical mobile-friendly converter for *any* MFL report. Reusable template.
7. Custom Tabs `?MODULE=MESSAGEnn` pattern is the right way to make a "fake page" — note our internal memory warns against deep-linking via MESSAGE2 specifically because Roster Workbench owns that experience; the pattern itself remains valid for other MESSAGE numbers.

---

## Threads scanned but skipped (off-topic / low-signal — title only)

These appeared in the 513-thread index and were judged not directly useful for MFL native-page styling. Including in case future work needs them.

(Selected examples — full list in the in-tree `/tmp/threads.txt` capture this session if needed.)

- "TEAM NAME COLOR CHANGES" (443990) — single user, no working snippet
- "championship plaque fonts" (444649) — purely cosmetic question, no resolution captured
- "New adobe popup ad..." (444661) — spam/ad observation, no CSS
- "pop ups question" (444648) — vague, no snippet
- "changing color to league names" (444647) — incomplete reply
- "Bottom caption border bleeding to left and right tables" (444634) — too narrow
- "Jumpy Set of Tabs" (444611) — bug report, no fix posted
- "Player stat app" (?) — general script, not MFL UI
- "Eliminated Players Script" — non-styling
- "Dice Roll - MFL Scripts" — gimmick widget
- "Live Scoring Not Showing in Safari Today" (444445) — Safari-version-specific bug, no styling info
- "Live ScoringNot Showing in Safari Today" (444445) — duplicate
- "Position Count For Total Points League" — scoring-rule question, not UI
- "Owner Activity" (444594) — feature request, no code
- "Owner's Desk Tabs Not Working" (435707) — debugging without a snippet
- "Loading two reports into one tab" (435947) — incomplete answer
- "All My Leagues - MFL Scripts" — meta widget, not styling
- "MFL Discord/Slack Bot" (438319) — Discord integration, not styling
- "Help understanding API requests from MFL Scripts cache.js" (444673) — API-internals, not styling
- "API Requests to handle Free Agency" (444758) — API not UI
- "championship plaque fonts" — duplicate
- "Tabs only working when logged in" (436656) — auth bug, no CSS
- "Pages Won’t Load" / "Live Scoring Not Showing" / "Helmet Bar Not Showing" — operational issues
- ~100 more "my X isn't working" threads that received only a "share your link" or a config-var pointer without a reusable snippet.

(Full 513-row index is captured in /tmp/threads.txt during the research session; the ~80 fetched threads are in /tmp/fs_md/*.md — both transient.)

---

## End — known unknowns / next-steps if revisiting

- `O=43` (the auction options page that motivated this research) had **no dedicated thread** in this subforum. The closest hit was thread 435498 ("Custom MFL Tabs") which mentions "current auctions" in passing. We did not capture an auction-page-specific snippet because the community does not appear to have published one. **Recommendation:** Open Chrome DevTools on a live `O=43` page in our league and document the IDs/classes there directly — this is faster than waiting for a community snippet that may never appear.
- TOS' `mflscripts.com` likely has additional unindexed JS files; visit https://www.mflscripts.com/ for the full canonical script library.
- The pinned official MFL docs at https://www.myfantasyleague.com/customization.htm were *not* fetched in this session — only the community forum. If we want first-party docs, fetch separately.
