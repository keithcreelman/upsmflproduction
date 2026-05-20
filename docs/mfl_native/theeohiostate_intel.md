# theeohiostate — Complete MFL-Customization Intel (Canon)

**Subject:** FantasySharks user `theeohiostate` (a.k.a. "TOS") — most prolific known MFL custom-HTML / custom-script builder.
**Captured:** 2026-05-20
**Captured by:** background research agent (sub-session of `claude/exciting-tharp-235716`).
**Why this exists:** Keith identified theeohiostate as the canonical pro builder; this doc consolidates all his publicly-posted logic, scripts, file URLs, var settings, and design patterns so UPS native custom-HTML can mirror them without re-discovering.

> **Note on data fidelity.** FantasySharks requires login for the user-search and profile pages, but **all individual thread URLs at `viewtopic.php?f=506&t=NNNNNN` are publicly readable**. All captures below came from those public thread URLs, the `mflscripts.com` script/README files (still public via curl with a standard user-agent), and direct download of the compressed JS files he hosts. The forum's `search.php?author=theeohiostate` would have been the cleanest source — that is the one piece of intel we could not access.

---

## 1. Identity / external presence

| Field | Value |
| --- | --- |
| Forum username | `theeohiostate` |
| Forum rank | Great White Shark (FantasySharks tier) |
| Forum profile ID | `u=133985` (https://www.fantasysharks.com/forum/memberlist.php?mode=viewprofile&u=133985) |
| Forum profile by-username | https://www.fantasysharks.com/forum/memberlist.php?mode=viewprofile&un=theeohiostate |
| Forum join date | Sun Jun 29, 2014 |
| Forum post count (at capture) | 2,535 posts |
| Forum "Sand$" balance | 7,699.15 |
| Public signature | "MFL Scripts Contributor for MyFantasyLeague.com — https://mflscripts.com/" + boilerplate "I am unable to answer questions about your site without a link to site or page your describing. If you dont provide a link I will not answer your post." |
| Primary site | https://mflscripts.com/ (Cloudflare-fronted; placeholder home page; real assets at `/mfl-apps/...`, `/mfl-customtabs/`, `/mfl-svg/`, `/ImageDirectory/`) |
| Earliest captured post in scope | **2017-03-01** — "POPUPS — Player News / Article News / Trades / MFL Messages & League Reminders" (collab with `Habman`) |
| Latest captured post in scope | **2025-09-19** — t=443193 live-scoring page custom-scripts thread |
| Real name / GitHub / Twitter | **Unknown.** No GitHub repo under "theeohiostate" or "mflscripts" was discoverable. The `mflscripts.com` site footer is `© MFLScripts.com 2020.` with no author byline. Forum profile is gated behind login. |
| Collaborators | `Habman` (Mako Shark) — co-author of the original Popups script (2017) and the Custom Tabs Generator |

### Brand-impersonation warning (critical)

The hostname **`nitrografixx.com`** is referenced in the 2018-era thread t=32671 (MFL Mobile) as the original CDN for the Custom Tabs JS:

```
https://www.nitrografixx.com/MFL-CustomTabs/customTabs.js
```

That domain is now hostile: fetching `customTabs.js` today returns a click-trap script that opens a new window and redirects to `https://planet.news`. Treat any historical reference to `nitrografixx.com` as **abandoned/squatted — do not load**. The current canonical CDN is `https://www.mflscripts.com/` only.

---

## 2. Subforums he posts in

| Subforum | URL | Role |
| --- | --- | --- |
| FantasySharks — Coding and Scripting Chat (`f=506`) | https://www.fantasysharks.com/forum/viewforum.php?f=506 | Owns the customization knowledge base; pinned author of the 2023 master thread t=441147 |
| MFL Official Support Forum (`forums.myfantasyleague.com/forums/`) | http://forums.myfantasyleague.com/forums/ | Active on older Custom Tabs / MFL Mobile threads (t=35498, t=32671) |
| FantasySharks — MFL Tank (`f=501`) | https://www.fantasysharks.com/forum/viewforum.php?f=501 | Casual presence (recent activity 2026-04-22 per Google site:search) |

---

## 3. Catalog of his threads (chronological, captured)

All on FantasySharks `f=506` unless noted. **Cap.** = captured below verbatim (Y) or summarized only (S).

| # | Date | Thread / URL | Role | Topic | Cap. |
| --- | --- | --- | --- | --- | --- |
| 1 | 2017-03-01 | [t=435518 — POPUPS: Player News / Article News / Trades / MFL Messages](https://www.fantasysharks.com/forum/viewtopic.php?f=506&t=435518) | OP (w/ Habman) | jQuery popups, font-awesome integration | Y |
| 2 | 2017-03-30 | [t=435594 — Editing MFL menu links / adding new drop menu](https://www.fantasysharks.com/forum/viewtopic.php?f=506&t=435594) | OP | `jQuery('.myfantasyleague_menu …').remove()` patterns | Y |
| 3 | 2018-06-30 | [t=436437 — Modifying tables on Add/Drop page via scripting](https://www.fantasysharks.com/forum/viewtopic.php?f=506&t=436437) | replier (post #13) | Clone-and-rebuild tables to fight FOUC | Y |
| 4 | 2018 (MFL Forum) | [forums.myfantasyleague.com showtopic=35498 — Custom MFL Tabs](http://forums.myfantasyleague.com/forums/index.php?showtopic=35498) | OP/replier | Original Custom Tabs script announcement | S |
| 5 | 2018 (MFL Forum) | [forums.myfantasyleague.com showtopic=32671 — MFL Mobile](http://forums.myfantasyleague.com/forums/index.php?showtopic=32671) | replier | Mobile HTML/JS/CSS in HPM | S |
| 6 | 2019-10-25 | [t=437553 — CSS for mobile Transactions page, module and previously processed waivers](https://www.fantasysharks.com/forum/viewtopic.php?f=506&t=437553) | OP | `@media (max-width:650px)` stack-to-cards transform | Y |
| 7 | 2020-03-26 | [t=437694 — Code to delete 'My Trophy Case' from My Options module](https://www.fantasysharks.com/forum/viewtopic.php?f=506&t=437694) | replier (#3, #6, #7, #10) | `:contains()` parent-remove pattern for menus | Y |
| 8 | 2020-03-30 | [t=437699 — Icon display configuration / franchise icons](https://www.fantasysharks.com/forum/viewtopic.php?f=506&t=437699) | replier (#2, #4, #6, #9) | "two-section" rule for icon control across reports | Y |
| 9 | 2020-09-11 | [t=438075 — Remove ad from live scoring](https://www.fantasysharks.com/forum/viewtopic.php?f=506&t=438075) | replier (#2, #7, #10, #14) | Ad-killer jQuery + CSS, cache busting via `?v=1.0.0` | Y |
| 10 | 2020-12-12 | [t=438160 — Contracts Report - MFL Scripts](https://www.fantasysharks.com/forum/viewtopic.php?f=506&t=438160) | OP | Full contracts report install + vars | Y (vars list) |
| 11 | 2020-12-14 | [t=438162 — Tabbed Rosters - MFL Scripts](https://www.fantasysharks.com/forum/viewtopic.php?f=506&t=438162) | OP | Roster tabs script + trade calculator | Y |
| 12 | 2020-12-14 | [t=438164 — Standings Settings - MFL Scripts](https://www.fantasysharks.com/forum/viewtopic.php?f=506&t=438164) | OP | Standings checkbox UI + CSS | Y |
| 13 | 2020-12-18 | [t=438178 — Mobile Menu - MFL Scripts](https://www.fantasysharks.com/forum/viewtopic.php?f=506&t=438178) | OP | Mobile-menu script + `usePopupLogin` conflict fix | Y |
| 14 | 2020-12-19 | [t=438185 — Player Popup - MFL Scripts](https://www.fantasysharks.com/forum/viewtopic.php?f=506&t=438185) | OP | 25+ vars: player news, scores, franchise, login, search | Y |
| 15 | 2020-12-20 | [t=438192 — Module Expand/Collapse - MFL Scripts](https://www.fantasysharks.com/forum/viewtopic.php?f=506&t=438192) | OP | Collapsible homepage modules + CSS | Y |
| 16 | 2020-12-21 | [t=438195 — Custom Tabs - MFL Scripts](https://www.fantasysharks.com/forum/viewtopic.php?f=506&t=438195) | OP | Fake-tabs script via `MFL_customTabs_FakeTabs[]` | Y |
| 17 | 2020-12-21 | [t=438196 — Custom CSS Theme Switch - MFL Scripts](https://www.fantasysharks.com/forum/viewtopic.php?f=506&t=438196) | OP | Per-league, per-user theme switcher | Y |
| 18 | 2020-12-21 | [t=438198 — Skins Selector - MFL Scripts](https://www.fantasysharks.com/forum/viewtopic.php?f=506&t=438198) | OP | Skin selector for stock-MFL-skin leagues | Y |
| 19 | 2020-12-26 | [t=438211 — One Click Install / Custom Template - MFL Scripts](https://www.fantasysharks.com/forum/viewtopic.php?f=506&t=438211) | OP | 20-HPM canonical template + installer.js | **Y (full)** |
| 20 | 2021-02-15 | [t=438259 — Banner on mobile device css](https://www.fantasysharks.com/forum/viewtopic.php?f=506&t=438259) | OP | `.banner-container` / `.banner-container.x-small` swap | Y |
| 21 | 2021-02-22 | [t=438267 — (responsive css question)](https://www.fantasysharks.com/forum/viewtopic.php?f=506&t=438267) | replier (#2) | "No skin and no responsive css → no option available" | Y |
| 22 | 2021-02-28 | [t=438272 — Horizontal & Vertical Menu Script](https://www.fantasysharks.com/forum/viewtopic.php?f=506&t=438272) | OP | Vertical submenu w/ MFL appearance-export | Y |
| 23 | 2021-03-27 | [t=438330 — Background image CSS](https://www.fantasysharks.com/forum/viewtopic.php?f=506&t=438330) | replier (#2, #4) | Full-path URL requirement post-MFL-update | Y |
| 24 | 2021-11-20 | [t=438833 — Remove dollar sign from salary](https://www.fantasysharks.com/forum/viewtopic.php?f=506&t=438833) | (no TOS posts) | — | n/a |
| 25 | 2022-05-10 | [t=439124 — (CSS color override)](https://www.fantasysharks.com/forum/viewtopic.php?f=506&t=439124) | replier (#2, #5) | "wrap css in `<style></style>`" reminder | Y |
| 26 | 2023-06-08 | [t=441147 — MFL Site Customization & Custom Scripts](https://www.fantasysharks.com/forum/viewtopic.php?f=506&t=441147) | OP (locked, single post, pinned-style master ref) | The "start-here" index doc | **Y (full)** |
| 27 | 2024-09-05 | [t=443193 — Custom Scripts on the Live Scoring Page](https://www.fantasysharks.com/forum/viewtopic.php?f=506&t=443193) | replier | `ls_after_update_scores()` hook pattern | Y |
| 28 | 2024-09-27 | [t=443344 — Add rank column to standings](https://www.fantasysharks.com/forum/viewtopic.php?f=506&t=443344) | replier (#2) | DOMContentLoaded + rank-column injection | Y |
| 29 | 2025-05-28 | [t=443978 — Add/Drop flicker fix + script rewrite](https://www.fantasysharks.com/forum/viewtopic.php?f=506&t=443978) | replier (#6, #8, #10, #11, #13, #15) | `requestAnimationFrame` × 2 + `setTimeout(timeFrame)` reveal pattern; announcement of `mflscripts.com/mfl-apps/add_drop/` | Y |

**Threads we could not access / could not confirm TOS authorship:**
- `t=444098` (Aug 2025 Custom contract script) — confirmed authored by **`zewolff1`**, not TOS (TOS not in thread). Worth a separate intel pass — a second commissioner is now publishing competing logic.
- Anything indexed only via authenticated `search.php?author=theeohiostate` — likely 50–100 more replies on smaller Q&A threads (estimate based on his 2,535-post total).

---

## 4. Full thread captures (verbatim)

### 4.1  [t=441147 — MFL Site Customization & Custom Scripts](https://www.fantasysharks.com/forum/viewtopic.php?f=506&t=441147) (locked master doc, 2023-06-08)

This is the single OP-only locked thread he uses as a "start here" landing page. Captured fields:

**Error-recovery URL (the break-glass that every MFL builder must know):**
```
https://www46.myfantasyleague.com/2023/logout?L=10065&HIDE_CUST=1
```
Toggle `HIDE_CUST=1` to disable all custom HPMs/CSS at MFL render time; `HIDE_CUST=0` to re-enable. Substitute your `wwwNN.` server, year, and `L=` league ID.

**Auto-login bookmark URL:**
```
https://api.myfantasyleague.com/2020/login?USERNAME=ENTERYOURUSERNAMEHERE&PASSWORD=ENTERYOURPASSWORDHERE&XML=1
```

**Required header files (first lines of HPM marked "Header"):**
```html
<script>var forceIndexedDB = false;</script>
<script src="https://www.mflscripts.com/mfl-apps/global/cache.js"></script>
<link href="https://mflscripts.com/font-awesome/css/all.min.css" rel="stylesheet">
```
Alternative for Font Awesome via CSS file (first line):
```css
@import url(https://mflscripts.com/font-awesome/css/all.min.css);
```

**Tutorial videos (the only "official" theeohiostate-narrated content known):**
- Part 1: https://youtu.be/tn5rgDpkAdU
- Part 2: https://youtu.be/9MnEI27xeNY

**MFL companion-league management leagues he runs:**
- MFL Manager: https://www48.myfantasyleague.com/2026/home/19048
- Player Status: https://www48.myfantasyleague.com/2026/home/53411
- Player Injuries: https://www48.myfantasyleague.com/2026/home/73607

(These are dedicated MFL leagues whose only function is to host data — the JS files in `mfl-apps/global/cache.js` query them via the standard MFL JSON export, in addition to the user's actual league.)

**Stock images / SVG:** https://www.mflscripts.com/ImageDirectory/  •  https://www.mflscripts.com/mfl-svg/  •  https://www.mflscripts.com/mfl-customtabs/

---

### 4.2  [t=438211 — One Click Install / Custom Template](https://www.fantasysharks.com/forum/viewtopic.php?f=506&t=438211) (2020-12-26, OP)

**This is the single most important thread.** It documents his 20-HPM canonical template. Posts captured verbatim across #1–#11 (Dec 26 2020 → Jan 4 2021):

#### 4.2.1  Pre-install prerequisite (the rule everyone breaks)

> **BEFORE** installing the script, navigate to **For Commissioners → Setup → Reports and Security Settings → "Use Advanced Editor on league type-in boxes?" → set to NO**, then save.

The Advanced Editor mangles `<style>` and `<script>` tags. This step gates every other piece of his work.

#### 4.2.2  Installer bootstrap (HPM #1, mark as Footer)

```html
<!-------- IMPORTANT !!!! BEFORE YOU INSTALL NAVIGATE TO "FOR COMMISSIONERS" -------->
<!-------- CLICK ON REPORTS AND SECURITY SETTINGS -------->
<!-------- FIND USE ADVANCED EDITOR AND SET TO NO AND SAVE THE PAGE -------->
<!-------- PLACE IN HPM #1 AND MARK AS A FOOTER -------->
<!-------- GO TO YOUR LEAGUES HOMEPAGE AND READ POPUP THAT APPEARS -------->
<!--------------------------- LOAD JQUERY LIBRARY --------------------------->
<script type="text/javascript" src="https://ajax.googleapis.com/ajax/libs/jquery/3.4.1/jquery.min.js"></script>
<!--------------------------- LOAD ONE CLICK SCRIPT --------------------------->
<script type="text/javascript" src="https://www.mflscripts.com/mfl-apps/global/installer.js"></script>
```

Installer modes (popup-driven): **Load Template** (wipes all HPMs/tabs/CSS and re-creates 20-HPM template), **Adjust Settings** (only changes MFL settings — Advanced Editor, etc.), **Reset MFL** (removes all customizations), **Remove this script**.

The installer.js itself (currently ~40KB minified, dated **"INSTALLER SCRIPT LAST UPDATED 8-9-25"**) is a Fetch-API-based driver that POSTs to MFL's commissioner endpoints to mutate HPMs and tab layouts. It uses `credentials:"include"` (relies on the commissioner's logged-in session cookie) and modes via radio buttons (`load_Template`, `load_settings`, `reset_MFL`, `load_Remove`).

#### 4.2.3  HPM #1 (Header) — Section 1: theme cookie

```html
<script>
function setTheme(themeName){localStorage.setItem('theme_'+year+'_'+league_id, themeName);document.documentElement.className = themeName;}
(function(){if(localStorage.hasOwnProperty('theme_'+year+'_'+league_id)) setTheme(localStorage.getItem('theme_'+year+'_'+league_id));})();
jQuery('noscript').remove();
</script>
```

`year` and `league_id` are MFL-injected globals available on every page. The localStorage key is **per-year + per-league**, so a single browser can hold distinct themes across multiple leagues without collision.

#### 4.2.4  HPM #1 — Section 2: viewport + browser tab + favicon

```html
<meta name="viewport" content="width=device-width, initial-scale=1">
<script>jQuery(document).prop('title', 'Weapons of DMD');</script>
<link rel="shortcut icon" href="https://www.mflscripts.com/ImageDirectory/script-images/favicon.ico" type="image/x-icon" />
<script>jQuery('head').append('<link href="https://www.mflscripts.com/ImageDirectory/script-images/favicon.ico" rel="shortcut icon" type="image/x-icon" />');</script>
```

#### 4.2.5  HPM #1 — Section 3: skin selector HTML

```html
<style>
.ThemeSwith_overlay{content:"";background-color:#000;opacity:.7;width:100%;height:100%;position:fixed;left:0;top:0}
#myMFLSkinSelection{position:fixed;left:0;right:0;top:0;bottom:0;margin:auto;width:200px;box-shadow:0 0 1px 1px rgba(0,0,0,0.1);border-radius:3px;padding:10px!important;background:var(--mobile-wrap-bg,#fff);z-index:1;height:300px;overflow:auto}
</style>
<div class="MFLSkinSelection">
<i class="fa fa-paint-brush MFLSkinSelectionbtn" aria-hidden="true" title="Select Skin Color"></i>
<div class="ThemeSwith_overlay" style="display:none"></div>
<div id="myMFLSkinSelection" class="MFLSkinSelection-content" style="display:none">
<p style="text-align:center;font-weight:bold;color:black;text-decoration:underline;margin:0">Skin Selection</p>
<a onclick="setTheme('theme-blueonblue')" style="color:#2073D6;cursor:pointer"><i class="fa fa-circle"></i>Blue-Blue</a>
<a onclick="setTheme('theme-blue-orange')" style="color:#080e25;cursor:pointer"><i class="fa fa-circle"></i>Blue-Orange</a>
<a onclick="setTheme('theme-dark-blue')" style="color:#004e8c;cursor:pointer"><i class="fa fa-circle"></i>Dark Blue</a>
<a onclick="setTheme('theme-light-blue')" style="color:#0076B6;cursor:pointer"><i class="fa fa-circle"></i>Light Blue&Grey</a>
<a onclick="setTheme('theme-brown')" style="color:#61553c;cursor:pointer"><i class="fa fa-circle"></i>Brown</a>
<a onclick="setTheme('theme-brown-gold')" style="color:#100e09;cursor:pointer"><i class="fa fa-circle"></i>Brown-Gold</a>
<a onclick="setTheme('theme-gold')" style="color:#c18210;cursor:pointer"><i class="fa fa-circle"></i>Gold</a>
<a onclick="setTheme('theme-green')" style="color:#00864b;cursor:pointer"><i class="fa fa-circle"></i>Green</a>
<a onclick="setTheme('theme-grey')" style="color:#888"><i class="fa fa-circle"></i>Grey</a>
<a onclick="setTheme('theme-orange')" style="color:#C46210;cursor:pointer"><i class="fa fa-circle"></i>Orange</a>
<a onclick="setTheme('theme-purple')" style="color:#592f93;cursor:pointer"><i class="fa fa-circle"></i>Purple</a>
<a onclick="setTheme('theme-red')" style="color:#D3212D;cursor:pointer"><i class="fa fa-circle"></i>Red</a>
<a onclick="setTheme('theme-redonred')" style="color:#ce1804;cursor:pointer"><i class="fa fa-circle"></i>Red 2 Tone</a>
<a onclick="setTheme('theme-teal')" style="color:#028887;cursor:pointer"><i class="fa fa-circle"></i>Teal</a>
<a onclick="setTheme('theme-niners nfltheme')" style="color:#000;cursor:pointer"><img src="https://www.mflscripts.com/ImageDirectory/script-images/nflTeamsvg_2/SFO.svg" style="width:30px;margin-right:10px;max-height:20px">49ers</a>
<!-- … 31 NFL team rows total: ARI BAL BUF CAR CHI CIN CLE DAL DEN DET GBP HOU IND JAC KCC LAC LAR MIA MIN NEP NOS NYG NYJ OAK PHI PIT SEA SFO TBB TEN WAS … -->
</div></div>
```

If the league doesn't want a switcher and just wants one locked theme:

```html
<script>document.body.classList.add("skinname");</script>
```

Available dark-skin classes: `theme-dk-orange`, `theme-dk-red`, `theme-dk-blue`, `theme-dk-gold`.
Available light-skin classes: `theme-light-blue, theme-redonred, theme-blue-orange, theme-brown-gold, theme-blueonblue, theme-dark-blue, theme-brown, theme-gold, theme-green, theme-grey, theme-orange, theme-purple, theme-red, theme-teal`.
NFL-team class names: `theme-niners, theme-bears, theme-bengals, theme-bills, theme-broncos, theme-browns, theme-bucs, theme-cardinals, theme-charger, theme-chiefs, theme-colts, theme-cowboys, theme-dolphins, theme-eagles, theme-falcons, theme-giants, theme-jaguars, theme-jets, theme-lions, theme-packers, theme-panthers, theme-patriots, theme-raiders, theme-rams, theme-ravens, theme-redskins, theme-saints, theme-seahawks, theme-steelers, theme-texans, theme-titans, theme-vikings`.

#### 4.2.6  HPM #1 — Section 4: SVG league logo + icon menu bar

```html
<div class="banner-icon">
  <a href="//%HOST%/%YEAR%/home/%LEAGUEID%" title="Go to Homepage" style="position:relative;text-decoration:none">
    <div id="logo_svg_inserticon"></div>
    <svg class="bannericon" viewBox="0 0 55.79 47.81">
      <use href="#lightSkin-logo"></use>
      <text style="display:none"></text>
    </svg>
  </a>
</div>
```

To replace the SVG with a custom image:

```html
<div class="banner-icon">
  <a href="//%HOST%/%YEAR%/home/%LEAGUEID%" title="Go to Homepage" style="position:relative;text-decoration:none">
    <div id="logo_svg_inserticon"></div>
    <img class="bannericon" align="middle" src="https://www.mflscripts.com/ImageDirectory/characters/Boxer.png">
  </a>
</div>
```

League-name SVG text (key idiom — uses CSS variables `--main` and `--accent`):

```html
<text text-anchor="middle" x="50%" y="50%" style="font-family:'Roboto Condensed',sans-serif;text-transform:uppercase;font-weight:600">
  <tspan class="league_name_text" style="fill:var(--main,#080e25)">Weapons of</tspan>
  <tspan class="league_name_text"> </tspan>
  <tspan class="league_name_text" style="fill:var(--accent,#B82601)">DMD</tspan>
  <tspan class="league_slogan_text" x="50%" dy="15" style="font-family:'Open Sans',sans-serif;font-style:italic;fill:#444;font-weight:300">Fantasy Football League</tspan>
  <tspan class="establshed-svgtext" x="50%" dy="15" style="font-family:'Roboto Condensed',sans-serif;fill:#777;font-weight:300;font-style:italic">B.O.T.H 2003</tspan>
</text>
```

Icon menu bar (SVG-symbol-based, with `icon-hide` class for desktop-only / mobile-only toggling):

```html
<div class="banner-rightside">
  <div class="bannerlinkicons">
    <div class="icon-bar">
      <!-- STANDINGS SVG -->
      <a class="svg-iconlink icon-hide" href="//%HOST%/%YEAR%/standings?L=%LEAGUEID%">
        <svg class="svg-icon icon-standings-v2" viewBox="0 0 85.3 158.94">
          <use xlink:href="#icon-standings-v2"></use>
        </svg>
        <div class="svg-text">Standings</div>
      </a>
      <!-- LINEUP -->
      <a class="svg-iconlink" href="//%HOST%/%YEAR%/lineup?L=%LEAGUEID%"> <svg class="svg-icon icon-lineup" viewBox="0 0 126.32 122.5"><use xlink:href="#icon-lineup-v2"></use></svg><div class="svg-text">Submit Lineup</div></a>
      <!-- ADD DROP -->
      <a class="svg-iconlink" href="//%HOST%/%YEAR%/add_drop?L=%LEAGUEID%"> <svg class="svg-icon icon-trade" viewBox="0 0 234.61 242.39"><use xlink:href="#icon-trade"></use></svg><div class="svg-text">Add/Drop</div></a>
      <!-- TRADES -->
      <a class="svg-iconlink" href="//%HOST%/%YEAR%/options?L=%LEAGUEID%&O=05"> <svg class="svg-icon icon-trade" viewBox="0 0 170.37 100"><use xlink:href="#icon-trade-v2"></use></svg><div class="svg-text">Trades</div></a>
      <!-- ROSTERS -->
      <a class="svg-iconlink" href="//%HOST%/%YEAR%/options?L=%LEAGUEID%&O=07"> <svg class="svg-icon icon-roster" viewBox="0 0 74.38 67.51"><use xlink:href="#icon-helmet"></use></svg><div class="svg-text">Rosters</div></a>
      <!-- SCOREBOARD -->
      <a class="svg-iconlink" href="//%HOST%/%YEAR%/ajax_ls?L=%LEAGUEID%"> <svg class="svg-icon icon-scoreboard" viewBox="0 0 254.49 236.32"><use xlink:href="#icon-scoreboard-v2"/></svg><div class="svg-text">Scoreboard</div></a>
      <!-- CHAT -->
      <a class="svg-iconlink icon-hide" href="//%HOST%/%YEAR%/home/%LEAGUEID%?MODULE=LEAGUE_CHAT" onclick="openChatWindow(this); return false;" target="_blank"> <svg class="svg-icon icon-chat" viewBox="0 0 119.75 100"><use xlink:href="#icon-chat-v2"></use></svg><div class="svg-text">Chat</div></a>
      <!-- CALENDAR -->
      <a class="svg-iconlink" href="//%HOST%/%YEAR%/options?L=%LEAGUEID%&O=123"> <svg class="svg-icon icon-calendar" viewBox="0 0 156 172.38"><use xlink:href="#icon-calendar"></use></svg><div class="svg-text">Calendar</div></a>
      <!-- HISTORY -->
      <a class="svg-iconlink" href="//%HOST%/%YEAR%/options?L=%LEAGUEID%&O=247&SEQNO=6"> <svg class="svg-icon icon-history" viewBox="0 0 100 87"><use xlink:href="#icon-history"></use></svg><div class="svg-text">History</div></a>
      <!-- RULES (MESSAGE2 = HPM #2) -->
      <a class="svg-iconlink" href="//%HOST%/%YEAR%/home/%LEAGUEID%?MODULE=MESSAGE2"> <svg class="svg-icon icon-rules" viewBox="0 0 135.12 194.78"><use xlink:href="#icon-rules"></use></svg><div class="svg-text">Rules</div></a>
    </div>
  </div>
</div>
```

The `%HOST%`, `%YEAR%`, and `%LEAGUEID%` tokens are MFL HPM macros expanded server-side — using them keeps links portable across years/servers without re-editing HPMs.

#### 4.2.7  HPM #1 — Section 5: master script-load toggles

```javascript
// HEADER JS FILE OPTIONS
var load_mobileMenu_script=true;      //https://www.mflscripts.com/mfl-apps/mobileMenu/script.js
var load_chat_enhanced=true;          //https://www.mflscripts.com/mfl-apps/chat/enhanced.js
var load_popup=true;                  //https://www.mflscripts.com/mfl-apps/popups/players/script.js
var load_mini_boxscore=true;          //https://www.mflscripts.com/mfl-apps/scoreboard/mini-boxscore/script.js
var load_marquee=true;                //https://www.mflscripts.com/mfl-apps/marquee/script.js
var load_lineups_submit_script=true;  //https://www.mflscripts.com/mfl-apps/lineups/submit/script.js
var load_tabs_script=true;            //https://www.mflscripts.com/mfl-apps/tabs/script.js
var load_irReport_script=true;        //https://www.mflscripts.com/mfl-apps/injuredReserve/IRreport/script.js
var load_diceRoll_script=true;        //https://www.mflscripts.com/mfl-apps/diceRoll/script.js
```

#### 4.2.8  HPM #1 — Section 6: marquee + mini-scoreboard mount points + global header.js

```html
<!-- TICKER HTML -->
<div class="ticker-wrapper"></div>
<!-- MINI SCOREBOARD HTML -->
<div id="MFLBoxWrapper"></div>
<script src="https://www.mflscripts.com/mfl-apps/global/header.js"></script>
<link rel="stylesheet" type="text/css" href="https://www.mflscripts.com/mfl-apps/lineups/submit/responsive.css">
<link rel="stylesheet" type="text/css" href="https://www.mflscripts.com/mfl-apps/global/css/300x50-icons.css">
<!-- ADD POPUP MESSAGE ICON TO MENU SO IT LOADS QUICKLY THEN REMOVE IT ONCE SCRIPT ADDS TO MENU -->
<script>jQuery('.myfantasyleague_menu ul,.MFLSkinSelection').css('visibility','visible');</script>
<!-- WRAP ALL CONTENT -->
<div id="container-wrap"><!-- ENTER ALL HPMS AFTER THIS AND CLOSE IN FOOTER -->
```

#### 4.2.9  Full HPM map (the 20-message canonical layout)

| HPM | Name | Purpose | Tied script(s) | Mark as |
| --- | --- | --- | --- | --- |
| 1 | **Header** | All the above sections 1–6 | header.js + many | Header |
| 2 | Custom Rules | Rules content; linked from `?MODULE=MESSAGE2` | — | normal |
| 3 | Quick Links | Tab grouping: Chat, Twitter, Activity, Options, Scratchpad | tabs/script.js | normal |
| 4 | Overview | Franchise overview report | overview/script.js | normal |
| 5 | Reports Tabs | Transactions, NFL Schedule, Power Rank, Weekly Summary, Next/Last week, Overview | tabs/script.js | normal |
| 6 | History | Custom league history; install/update buttons | history/integrated/script.js | normal |
| 7 | Slider | Optional image/module slider | sliders | normal |
| 8 | NFL Schedule | NFL game schedule HTML | nflSchedule helper | normal |
| 9 | Today's Calendar Events | League calendar excerpt | calendar | normal |
| 10 | Lineup IR Alert | Combined Lineup Alert + IR Alert | lineups/alert + irReport | normal |
| 11 | Playoff Seedings | Playoff bracket / seeding script | playoffs | normal |
| 12 | Draft Reports | Tab group: Draft Status, My Draft Picks, Recent Picks, Tracker, My List, Avg time | tabs/script.js | normal |
| 13 | Pools | Tab group: Fantasy Confidence, NFL Survivor, NFL Confidence, Top Survivor | tabs/script.js | normal |
| 14 | Top Players-FA | Tab group by position: MVP, QB, RB, WR, TE, PK, DEF | tabs/script.js | normal |
| 15 | Top Add-Drop | Most-added / most-dropped | tabs/script.js | normal |
| 16 | Dice Roll | Pre-draft order roller | diceRoll/script.js | normal |
| 17 | MFL Live All Leagues | Cross-league live scoring | mflLive | normal |
| 18 | Commissioner Abilities | Custom commish admin links (`var add_abilities_link=true`) | commissioner | normal |
| 19 | IR Report | IR violations report | irReport | normal |
| 20 | **Footer** | Footer js loader + playoff bracket renames + roster/livescoring vars + global footer.js + page footer HTML | footer.js | Footer |

#### 4.2.10  HPM #20 — Footer key blocks

Activity-tab refresh hook (must update `#tabNNN` to match the tab where Owner Activity sits in your league's tab layout):

```javascript
jQuery("#tab202").click(function(){
  $("#tabcontent202").load(window.location.href + " #owner_activity", function() {
    updateOnlineStatus();
  });
});
```

Playoff bracket text renames (cosmetic, but every league with reseeding overrides these):

```javascript
// PLAYOFF BRACKET TEXT CHANGE
jQuery('#playoff1').find('td:contains("Winner of Game #2")').text("Worst Remaining Seed").attr("style","justify-content:center");
jQuery('#playoff1').find('td:contains("Winner of Game #1")').text("Best Remaining Seed").attr("style","justify-content:center");
jQuery('#playoff1').find('td:contains("Winner of Game #3")').text("Winner").attr("style","justify-content:center");
jQuery('#playoff1').find('td:contains("Winner of Game #4")').text("Winner").attr("style","justify-content:center");
```

Rosters-script var block (set `leagueTypeNormal=false` if you have salaries/contracts):

```javascript
// ROSTERS OPTIONS
var tradeViewPermission = true;
var fid_commish         = "0004";
var showNav             = false;
var showMFLdefaultBtn   = true;
var leagueTypeNormal    = true;
var SetLeftColumnWidth  = 150;
var SetCaptionIconWidth = 250;
var RosterEnableMedia   = true;
```

Live-scoring var block (very full):

```javascript
// LIVE SCORING OPTIONS
var ls_scoreboardName = "EMPIRE SCOREBOARD";
var showTeamName = false;
var showTeamIcon = true;
var ls_includeProjections = true;
var ls_includeInjuryStatus = true;
var ls_excludeIR = false;
var ls_excludeTaxi = true;
var ls_popup_abbrev_name_icon = 2;       // -1=disable; 0=abbrev; 1=name; 2=icon
var ls_orig_proj_when_final = true;
var ls_popup_status = true;
var ls_box_abbrev_name_icon = 2;         // 0=abbrev; 1=name; 2=icon; 3=icon+abbrev; 4=icon+name
var ls_hide_bye_teams = false;
var ls_show_win_probability = true;
```

Footer script-load toggles:

```javascript
// FOOTER JS FILE OPTIONS
var load_moduleExpand_script     = true;   //https://www.mflscripts.com/mfl-apps/moduleExpand/script.js
var load_replace_mflScoring_h2h  = true;   //https://www.mflscripts.com/mfl-apps/scoreboard/replace-mflScoring/h2h.js
var load_standingSettings_script = true;   //https://www.mflscripts.com/mfl-apps/standingSettings/script.js
var load_popupAddon_script       = true;   //https://www.mflscripts.com/mfl-apps/popups/addon/script.js
var load_notification_script     = true;   //https://www.mflscripts.com/mfl-apps/popups/notfications/script.js
var load_rosters_script          = true;   //https://www.mflscripts.com/mfl-apps/rosters/script.js
var load_history_script          = true;   //https://www.mflscripts.com/mfl-apps/history/integrated/script.js
var load_draftHistory_script     = true;
var load_irReport_script         = true;
var load_diceRoll_script         = true;
```

Popup-addon + notification var block:

```javascript
// MFL POPUP ADD-ON
var enableAddonNewPM = true;
var enableAddonNewPost = true;
var enableAddonPoll = true;
var enableAddonTrade = true;
// USER NOTIFICAION SLIDE DOWN
var includeVisitorNotification = true;
var includeTradeNotification = true;
var includeIRNotification = true;
var checkEverySecond_notificationVisitor = 60;    // poll frequency
var sameVisitor_notification_interval = 5*60;     // 5 min
var trade_notification_interval = 60*60;          // 60 min
var notification_duration_seconds = 1.5;
</script>

<!-- REQUIRED HTML FOR MFL POPUP ADD-ON (hidden module probes the notification logic listens to) -->
<div id="message_board_check" style="display:none"><module name="MESSAGE_BOARD_SUMMARY"/></div>
<div id="poll_check" style="display:none"><module name="POLL_SUMMARY"/></div>
<div id="poll_check" style="display:none"><module name="POLL"/></div>
<div id="trade_check" style="display:none"><module name="TRADES"/></div>

<!-- GLOBAL FOOTER -->
<script src="https://www.mflscripts.com/mfl-apps/global/footer.js"></script>
</div><!-- close container-wrap from HPM #1 -->
```

The `<module name="…"/>` tokens are MFL HPM macros — MFL server-side-renders them into the standard module markup, then his script reads visibility/badge state via DOM scraping. This is the bridge between MFL's server-rendered modules and his JS world.

#### 4.2.11  Tab-icon CSS override pattern (Font Awesome unicode swap)

The tab icons (Home / My Team / Reports / Players / Latest News / Playoffs / Pools) live at `li#tab0` ... `li#tabN` (note: zero-indexed — `tab0` is the first tab, "Home"). To swap a tab's icon to a different Font Awesome glyph, override in the HPM #1 header:

```css
#tabmenu-wrap li#tab3 a:before,
#tabmenu-wrap #tab_title.tab3:before {
  content: "\f1ea"
}
```

To strip all tab icons:
```css
#tabmenu-wrap li[id*="tab"] a:before{display:none}
```

#### 4.2.12  Roster-column-text (no icons) CSS (light skin)

```css
#roster_column_left td a {
    background: red;
    border-radius: 3px;
    width: 100%;
    display: block;
    padding: 3px 5px;
    background: var(--mobile-wrap-bg, #fff);
    box-shadow: 0 0 1px 1px rgb(0 0 0 / 10%);
    color: var(--main, #080e25);
}
#roster_column_left td {padding-bottom: 5px}
#roster_column_left td a:hover {
    background: var(--gradient-dark, #9c2000);
    background-image: linear-gradient(to bottom, var(--gradient-light, #cb2a01), var(--gradient-dark, #9c2000));
}
@media only screen and (max-width: 58em) {
    #roster_column_left td a {white-space: nowrap;}
    #roster_column_left td {padding-right: 5px}
}
```

(Dark-skin variant uses `var(--accent, #ff4200)` etc.)

#### 4.2.13  Marquee / ticker var block (added 2021-02-04)

```javascript
// TICKER DISPLAY SETTINGS
var tickerHomePageOnly      = false;
var tickerName              = "Headlines";
var responsiveTicker        = true;
var isLeagueIDP             = false;
var tickerSize              = "medium";
var tickerLastPlayoffWeek   = 16;
var tickerSpeedDefault      = 2;
var tickerDelay             = 3;
// CUSTOM MESSAGES
var tickerContent = new Array();
tickerContent.push( ({"header":"League Update" , "message":"The league will rollover to 2021 as soon as MFL makes the option available"}) );
// BOTH STANDARD AND LIVE DISPLAY
var includeFranchiseIcons      = true;
var includeLatestArticles      = 5;
// STANDARD DISPLAY (no NFL kickoff)
var includeTopPlayerStats      = 5;
var includeTopPlayerStatsIDP   = false;
var includeTopPlayerPts        = 5;
var includePowerRank           = false;
var includeAltPowerRank        = false;
var includePointScoredTeam     = false;
var includeAllplayRecord       = true;
var includeLastWeekResults     = true;
var includeNextWeekMatchups    = true;
var includeLastWeekNflResults  = true;
var includeNextWeekNflMatchups = true;
var includeWaiverOrder         = true;
var includeDraft               = true;
var draftShowEntire            = false;
var draftTopPicksOnly          = 0;
var draftShowPicksMade         = 5;
var draftShowPicksPending      = 5;
// LIVE DISPLAY (NFL kickoff happened)
var includeLiveLeaders         = 5;
var includeLiveLeadersIDP      = false;
var includeNflMatchups         = true;
var includeNflMatchupLeaders   = true;
var includeFantasyMatchups     = true;
// TICKER COLORING - DARK SKIN
var tickerWidth     = "calc(1148px - 6px)";
var tickerMargin    = "10px auto 0 auto";
var tickerFont      = "Roboto Condensed";
var tickerBorder    = "#444";
var bigHeadingBG    = "#1c1c1c";
var bigHeadingClr   = "var(--accent, #ff4200)";
var tickerHeadBG    = "#222";
var tickerCogWheel  = "var(--accent, #ff4200)";
var tickerHeadClr   = "#ccc";
var tickerTxtBG     = "#111";
var tickerTxtClr    = "#eee";
var controlsGreen   = "lime";
var controlsRed     = "red";
```

(Light-skin variant flips colors to whites/`var(--accent,#B82601)`.)

#### 4.2.14  His attitude / scope guardrails (post #7, Jan 2 2021)

> "MFL has little interest in the customization we do. We are less then 1% of their users, they are great about working with us on requests but again the user percentage is so small they are not willing to go as far as we'd like… considering the top line of their business isn't reliant on a few fantasy sites geeks making tweaks."

(Establishes that MFL the company is *not* going to extend the customization platform — anything beyond what's exposed today must be built on top of the existing HPM/JSON-export plumbing.)

---

### 4.3  [t=438196 — Custom CSS Theme Switch](https://www.fantasysharks.com/forum/viewtopic.php?f=506&t=438196) (2020-12-21, OP)

**The cleanest theme-switcher snippet — distilled, useful for any league not running the full template.**

Header-message JS+HTML (verbatim):

```html
<script>
function setTheme(themeName){localStorage.setItem('theme_'+year+'_'+league_id, themeName);document.documentElement.className = themeName;}
(function(){if(localStorage.hasOwnProperty('theme_'+year+'_'+league_id)) setTheme(localStorage.getItem('theme_'+year+'_'+league_id));})();
jQuery('noscript').remove();
</script>
<div class="MFLSkinSelection">
   <i class="fa fa-paint-brush MFLSkinSelectionbtn" aria-hidden="true" title="Select Skin Color"></i>
   <div class="ThemeSwith_overlay" style="display:none"></div>
   <div id="myMFLSkinSelection" class="MFLSkinSelection-content" style="display:none">
      <p style="text-align:center;font-weight:bold;color:#eee;text-decoration:underline;margin:0">Skin Selection</p>
      <a href="#" onclick="setTheme('theme-dk-red')"   style="color:#da3636!important"><i class="fa fa-circle"></i>Red</a>
      <a href="#" onclick="setTheme('theme-dk-orange')" style="color:#ff4200!important"><i class="fa fa-circle"></i>Orange</a>
      <a href="#" onclick="setTheme('theme-dk-blue')"  style="color:#117DFF!important"><i class="fa fa-circle"></i>Blue</a>
      <a href="#" onclick="setTheme('theme-dk-gold')"  style="color:#b2784a!important"><i class="fa fa-circle"></i>Gold</a>
   </div>
</div>

<script>
jQuery(".MFLSkinSelectionbtn").on("click", function (){$("#myMFLSkinSelection,.ThemeSwith_overlay").css("display","block");});
jQuery("#myMFLSkinSelection a").on("click", function (){$("#myMFLSkinSelection,.ThemeSwith_overlay").css("display","none");});
jQuery(".ThemeSwith_overlay").on("click", function (){$("#myMFLSkinSelection,.ThemeSwith_overlay").css("display","none");});
</script>
```

CSS-variable theme definitions (verbatim — the pattern is `--accent` + `--accent-light` + `--accent-dark` per theme class):

```css
<style>
.theme-dk-gold   { --accent:#b2784a; --accent-light:#B8835A; --accent-dark:#704D31; }
.theme-dk-orange { --accent:#ff4200; --accent-light:#FA5C25; --accent-dark:#B52F00; }
.theme-dk-red    { --accent:#da3636; --accent-light:#e63143; --accent-dark:#78161F; }
.theme-dk-blue   { --accent:#1353F2; --accent-light:#117DFF; --accent-dark:#0738B3; }

body    { background: var(--accent       ,#b2784a); }   /* always provide fallback */
caption { background: var(--accent-light ,#B8835A); }
.report { background: var(--accent-dark  ,#704D31); }
</style>
```

His CSS-variable answer to "how do I set a default theme?" (post #3, 2021-03-09): "set the css variable in root to whatever colors you want the default to be" — i.e. add a `:root { --accent: #xxx; }` rule before the theme classes.

---

### 4.4  [t=437553 — Mobile transactions / draft results / waivers CSS](https://www.fantasysharks.com/forum/viewtopic.php?f=506&t=437553) (2019-10-25, OP)

**The mobile-stack-to-cards transform.** Wrapped in `@media (max-width:650px)` (he edited the post 2 days later to add the media-query wrapper after `GameTime` flagged that without it the desktop got hit too). Targets:

- `#body_options_03` (Transactions)
- `#transactions` (Transactions inline module)
- `#body_processed_waivers` (Previously-processed waivers)
- `#body_options_17` (Draft Results)

Demo league he linked: `https://www63.myfantasyleague.com/2019/options?L=43570&O=03` (waivers) and `?O=17` (draft).

**Key insight:** the `#body_options_NN` pattern uses the MFL `O=` URL parameter as the page's container id — that's how you scope page-specific CSS without it leaking to other pages. This idiom recurs across all his work.

---

### 4.5  [t=438178 — Mobile Menu](https://www.fantasysharks.com/forum/viewtopic.php?f=506&t=438178) (2020-12-18, OP) — the `usePopupLogin` conflict

The mobile-menu script and the player-popup script both add a login icon. If both are installed, you get a duplicate login UI. His fix (added 2021-09-03):

```javascript
var usePopupLogin = false; // Set to true ONLY if also using Player Popup AND ShowMFLlogin=true
```

CSS-based menu hider (alternative to `jQuery(...).remove()` for menu items that the mobile menu also needs):

```css
.myfantasyleague_menuMobile .mm-help,
.myfantasyleague_menu .mm-help,
.myfantasyleague_menuMobile .mm-myleagues,
.myfantasyleague_menu .mm-myleagues,
.myfantasyleague_menuMobile .mm-thispage,
.myfantasyleague_menu .mm-thispage,
.myfantasyleague_menuMobile .mm-home,
.myfantasyleague_menu .mfl-icon+li
{display:none!important}
```

---

### 4.6  [t=438195 — Custom Tabs / fake-tabs idiom](https://www.fantasysharks.com/forum/viewtopic.php?f=506&t=438195) (2020-12-21, OP)

Canonical install:

```html
<script src="https://www.mflscripts.com/mfl-apps/global/cache.js"></script>
<!-- CUSTOM TAB SCRIPT SETTINGS -->
<script>
  var showTabsAllPages = true;
  var changeMainTabName = "Home";
  var changeAllTabName = true;
  var load_tabs_versionTwo = false;
  var MFL_customTabs_FakeTabs = new Array();
  MFL_customTabs_FakeTabs["Scoreboard"]      = ({ "href": "//%HOST%/%YEAR%/home/%LEAGUEID%?MODULE=MESSAGE19", "target": "_top" });
  MFL_customTabs_FakeTabs["Rosters & Trades"] = ({ "href": "//%HOST%/%YEAR%/home/%LEAGUEID%?MODULE=MESSAGE17", "target": "_top" });
</script>
<script src="https://www.mflscripts.com/mfl-apps/tabs/script.js"></script>
```

Constraints he calls out (post #13, 2021-09-11):

> "100 is reserved and cant be used that is why the page says that, to insure no one uses it"
>
> "you cant use the same report in different tabs, MFL will not permit you to embed more than 1 instance of any report"
>
> "MFL system doesn't permit same modules on page, can't have duplicate ID on a website or causes errors"

So: tab IDs 200+ only, never duplicate a module across tabs.

#### Internal mechanics (from inspecting `mfl-apps/tabs/script.js` 2025 minified version)

- LocalStorage cache key: `mfl_tabs_${league_id}_${year}`, TTL **216e5 ms = 6 hours**.
- On cache-miss: `fetch(\`${baseURLDynamic}/${year}/home/${league_id}?PRINTER=1\`)` then DOM-parse `.myfantasyleague_tabmenu.main_tabmenu ul#homepagetabs li` to read tab names.
- `PRINTER=1` is the load-bearing flag — it strips MFL chrome and returns a printable view with the tab list intact, fastest source of truth for tab metadata.
- Touch-swipe support: `swipeHPM=true` + `swipePosition="content"` adds `touchstart/touchend` listeners that swap tabs based on `distTabX >= 50` threshold.
- Public globals: `tabNumberSwipe`, `lastTabSwipe`, `show_tab(id)`, `show_custom_tab(id)`.

---

### 4.7  [t=438185 — Player Popup](https://www.fantasysharks.com/forum/viewtopic.php?f=506&t=438185) (2020-12-19, OP)

Full var block (verbatim, the longest single config in his catalog):

```html
<script>
//ENABLE PLAYER NEWS POPUP
var MFLPopupEnablePlayerNews = true;
//ENABLE SCORES POPUP
var MFLScoreDetailsPopup = false;  // Set to true to enable a popup for player scores
//ENABLE FRANCHISE POPUP
var MFLFranchisePopup   = true;    // Set to true; MFLScoreDetailsPopup MUST also be true
var includeBiologo      = false;
var includeBiologoAsset = false;
//SCORES AND FRANCHISE POPUP CSS
var detailsOverlay          = "rgba(0,0,0,.5)";
var detailsWrapBG           = "#fff";
var detailsWrapBorder       = "#333";
var detailsWrapBorWidh      = "2px";   // [sic — his typo, preserve as-is or vars don't bind]
var detailsWrapBoxShdw      = "0 0 5px #000";
var detailsWrapPadding      = "10px";
var detailsWrapRadius       = "3px";
//SET COMMISH FRANCHISE ID
var commishTeam = "0002";
// ALL PLAY OR BEST BALL OPTIONS
var removeSchedule  = false;
var removeWatchlist = false;
var removeLineup    = false;
var hideLinks       = false;
//ENABLE ARTICLE POPUP
var MFLPopupEnableArticle = true;
//ENABLE NOTIFICATION - 7 SETTING OPTIONS
var MFLPopupEnableAutoNotification = true;
var MFLPopupEnableTrade = true;
var MFLPopupEnableTradePoll = true;
var MFLPopupEnableReminders = true;
var MFLPopupEnableMessages = true;
var MFLPopupEnableCommishMessage = true;
var MFLPopupCommishMessage = "<p>Enter Custom League Message Here</p>";
//SETTINGS FOR LOGIN AND SEARCH
var ShowMFLlogin = true;
var ShowMFLsearch = true;
var LoginSearchMobileCSS = true;
//OTHER OPTIONS
var MFLPlayerPopupIncludeNFLLogo = true;
var MFLPlayerPopupLinkPopup = true;   // CLICKING PLAYER LINK OPENS POPUP
var MFLPlayerPopupIncludeProjections = true;
</script>
<!-- PLAYER POPUP JS FILE -->
<script src="https://www.mflscripts.com/mfl-apps/popups/players/script.js"></script>
```

Dark-skin overlay CSS variant (post #2):

```javascript
var MFLScoreDetailsPopup = true;
var detailsOverlay   = "rgba(0,0,0,.5)";
var detailsWrapBG    = "var(--site-bg-image,#111)";
var detailsWrapBorder= "#000";
var detailsWrapBorWidh="0px";
var detailsWrapBoxShdw="0 0 5px #000";
var detailsWrapPadding="10px";
var detailsWrapRadius="3px";
```

`var(--site-bg-image,#111)` — note the CSS-variable cross-binding with the theme system.

---

### 4.8  [t=438164 — Standings Settings](https://www.fantasysharks.com/forum/viewtopic.php?f=506&t=438164) (2020-12-14, OP) — minimal install

```html
<script src="https://www.mflscripts.com/mfl-apps/global/cache.js"></script>
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/4.7.0/css/font-awesome.min.css" type="text/css"/>
<!-- STANDINGS SETTINGS JS FILE -->
<script src="https://www.mflscripts.com/mfl-apps/standingSettings/script.js"></script>
<!-- STANDINGS SETTINGS CSS -->
<style>
#standings-settings { box-shadow: 0 0 1px 1px rgba(0,0,0,.1); border-radius:3px; padding:10px!important; background:#fff; }
.standings-settings_overlay { background-color:#000; opacity:.7 }
#standings-settings input+label:before          { color:red }
#standings-settings input:checked+label:before  { color:green }
#standings-settings #fname_checkbox:checked+label:before,
#standings-settings #fname_checkbox+label:before,
#standings-settings #ficon_checkbox:checked+label:before,
#standings-settings #ficon_checkbox+label:before,
#standings-settings #ficonname_checkbox:checked+label:before,
#standings-settings #ficonname_checkbox+label:before { color:red }
</style>
```

---

### 4.9  [t=438162 — Tabbed Rosters](https://www.fantasysharks.com/forum/viewtopic.php?f=506&t=438162) (2020-12-14, OP)

Standalone install (non-template):

```html
<script>
var tradeViewPermission = true;
var fid_commish         = "0004";
var showNav             = false;
var showMFLdefaultBtn   = true;
var showAllstatus       = false;   // true = always display IR/Taxi/Assets on page load
var leagueTypeNormal    = true;    // false if your league uses salaries/contracts
var SetLeftColumnWidth  = 150;
var SetCaptionIconWidth = 250;
var RosterEnableMedia   = true;
</script>
<script src="https://www.mflscripts.com/mfl-apps/rosters/script.js"></script>
```

Mobile: show contracts, hide bye column:

```css
@media only screen and (max-width: 62.5em){
  #roster .contractyear { display: table-cell; }
  #roster .week        { display: none; }
}
```

Trade-review color block (uses CSS vars):

```css
#MFLroster tr.total_salary_row th,
tr.tradedifference td  { color:#fff }
#MFLroster tr.total_salary_row th { background:#600; color:#fff }
#MFLroster tr.salary_cap_row th   { background:#060; color:#fff }
#MFLroster .savingsreview {
  background: var(--site-bg-image-one, #222) !important;
  border-top: 4px solid var(--accent-dark, var(--accent, #777));
}
```

---

### 4.10  [t=438192 — Module Expand/Collapse](https://www.fantasysharks.com/forum/viewtopic.php?f=506&t=438192) (2020-12-20, OP)

Install:

```html
<!-- COLLAPSE ALL HOME PAGE MODULES -->
<script src="https://www.mflscripts.com/mfl-apps/moduleExpand/script.js"></script>
<script>
var MFLEnableMedia = true;
var MFLRememberModuleStates = true;
</script>
```

Force-collapse from footer:

```html
<script>
   setTimeout(function () { doCustomCollapseAll(true); }, 100);
</script>
```

Target a single module by selector (he uses `title="Expand Report"` / `"Collapse Report"`):

```javascript
// Expand Commish Article
var commishArticleExpand = document.querySelector('#commish_article span[title="Expand Report"]');
if (commishArticleExpand) commishArticleExpand.click();

// Collapse Commish Article
var commishArticleCollapse = document.querySelector('#commish_article span[title="Collapse Report"]');
if (commishArticleCollapse) commishArticleCollapse.click();
```

---

### 4.11  [t=438272 — Horizontal & Vertical Menu Script](https://www.fantasysharks.com/forum/viewtopic.php?f=506&t=438272) (2021-02-28, OP)

A standalone (non-template) vertical-menu script. Uses MFL's `export?TYPE=appearance&L=NN&JSON=1` API to read the tab layout dynamically:

```javascript
var url = baseURLDynamic+"/"+year+"/export?TYPE=appearance&L="+league_id+"&JSON=1";
jQuery.ajax({type: 'GET',url: url, async:false}).done(function (appearanceData) {
   try {
      for(var i=0;i<appearanceData.appearance.tab.length;i++)
        MFL_customTabs_DefaultTabs[i] = appearanceData.appearance.tab[i].name;
      // …builds <li id="tab{i}">…</li> dynamically
   } catch(er) {}
});
```

Width adjustments (post #9):

```css
#vsubmenu ul li      { width: 116px; }
#vsubmenu ul li ul li{ width: 106px; }
#withmenus.withleft  { margin-left: 121px; }
```

His attitude on customization scope (post #14, 2021-10-22):

> "you want a custom script written just for your site? Hire a developer Mitch, we do stuff that everyone can use"

(I.e. mflscripts is reusable-only; bespoke = pay-for.)

---

### 4.12  [t=438075 — Live-scoring ad killer](https://www.fantasysharks.com/forum/viewtopic.php?f=506&t=438075) (post #2, 2020-09-11)

```html
<script>
// Remove MFL Ads - Live scoring page ads
jQuery('div[id*="usmg_ad"],#ajax_ls div[style="margin-bottom:5px;"]').remove();
jQuery('[src="/ads/ad-live_scoring_js.html"]').remove();
googletag = null;
</script>
```

CSS fallback:
```css
#body_ajax_ls div iframe[src="/ads/ad-live_scoring_js.html"]{display:none}
```

Cache-busting pattern (post #7): `www.mysite.com/mycss.css?v=1.0.0` — increment the version per release so owners don't need to hard-refresh.

---

### 4.13  [t=438259 — Banner mobile swap](https://www.fantasysharks.com/forum/viewtopic.php?f=506&t=438259) (post #1, 2021-02-15)

Two banner images, swap below 35.5em:

```html
<div class="banner-container">
  <a href="//www59.myfantasyleague.com/2020/home/59644" title="Return to home page">
    <img src="//mflscripts.com/ptd/2020/images/banner20.png">
  </a>
</div>
<div class="banner-container x-small" style="display:none;">
  <a href="//www59.myfantasyleague.com/2020/home/59644" title="Return to home page">
    <img src="//www.mflscripts.com/ptd/2020/images/banner_small20.png">
  </a>
</div>

<style>
.banner-container {
    margin-top: 0; padding: 0; border-bottom-width: 8px;
    background: #000; width: 100%;
    box-shadow: inset 0 0 10px rgb(0 0 0 / 80%);
    border-bottom: 4px solid red;
}
div.banner-container img, div.banner-container a:link img {
    margin: 0 auto; max-width: 100%; display: block; text-align: center;
}
@media only screen and (max-width: 35.5em) {
  div.banner-container        { display: none; }
  div.banner-container.x-small{ display: block!important; }
}
</style>
```

---

### 4.14  [t=437694 — Remove menu link by text](https://www.fantasysharks.com/forum/viewtopic.php?f=506&t=437694) (post #3, 2020-03-27)

The single-most-replicated jQuery snippet in the entire forum:

```html
<script>jQuery('#my_options li a:contains("My Trophy Case")').parent().remove();</script>
```

Variant for mobile-menu (`.mm-` prefix):
```javascript
jQuery('.mm-communications li:contains("Entire")').remove();
```

Best-practice note (post #6): "i put in footer just to make sure page is loaded before removing, but if it works in the header then that is fine also." Translation: header timing is OK for `.myfantasyleague_menu` items rendered server-side, but footer is safer for anything that depends on later JS-rendered DOM.

---

### 4.15  [t=437699 — Franchise icon display config](https://www.fantasysharks.com/forum/viewtopic.php?f=506&t=437699) (2020-03-30, OP) — "two-section" rule

Post #2 cross-link: viewtopic.php?t=33332.
Post #6 key advice: "these 2 sections have to contain the items you want changed" — i.e. the franchise icon display has *two* separate configuration sections (one for desktop, one for mobile) that must both be updated. Forgetting the second is the #1 cause of "it works on desktop but not mobile" tickets.

---

### 4.16  [t=443193 — Custom scripts on Live Scoring page](https://www.fantasysharks.com/forum/viewtopic.php?f=506&t=443193) (replier, 2024-09)

The live-scoring page re-renders every 15-30s. Standard `DOMContentLoaded` won't survive the reflow. His hook:

```javascript
function ls_after_update_scores() {
   // ADD YOUR FUNCTION HERE TO TRIGGER ON LIVE SCORING PAGE
}
```

Drop this **after** the live-scoring JS file loads; the scoreboard script calls this hook every refresh.

---

### 4.17  [t=443344 — Add rank column to standings](https://www.fantasysharks.com/forum/viewtopic.php?f=506&t=443344) (post #2, 2024-09-27)

```javascript
<script>
document.addEventListener("DOMContentLoaded", function () {
    const table1 = document.querySelector("#body_standings #standings .report tbody");
    const table2 = document.querySelector("#body_home #standings tbody");
    // …iterates rows and prepends a numbered <td>…
});
</script>
```

Note: two target selectors — standalone Standings page AND the Standings-embedded-on-home-page module. Same data, two DOM locations, both must be rank-stamped.

---

### 4.18  [t=443978 — Add/Drop flicker fix + script rewrite](https://www.fantasysharks.com/forum/viewtopic.php?f=506&t=443978) (2025-05-28 → 2025-06-15)

His **canonical anti-flicker pattern** for MFL pages that progressively reveal content:

```css
#waiver_request_list + br,
#waiver_request_list + br + table,
#add_drop span.reportnavigation {
    visibility:hidden
}
```

Then JS reveal (post #10):

```javascript
requestAnimationFrame(() => {
    requestAnimationFrame(() => {
        setTimeout(() => {
            const style = document.createElement("style");
            style.textContent = `#add_drop table,#add_drop .mobile-wrap{visibility:visible;}`;
            document.body.appendChild(style);
        }, timeFrame);  // default 300ms
    });
});
```

Double-`requestAnimationFrame` + delayed `setTimeout` is his recipe for "wait until MFL has finished its own DOM thrash" before revealing.

Released as a new app (post #13, 2025-06-15):
- https://mflscripts.com/mfl-apps/add_drop/script.js
- https://mflscripts.com/mfl-apps/add_drop/style.css

Covers: Add/Drop, Drop, Can't Cut List, Can't Add List, Load Rosters, My Watchlist, My Draft List, Make a Draft Pick, Lineup for Contest leagues, Set 'em and Leave 'em, Auction Bids.

---

### 4.19  [t=435518 — POPUPS (with Habman)](https://www.fantasysharks.com/forum/viewtopic.php?f=506&t=435518) (OP 2017-03-01)

Historical context: this is the **first** public custom-popup script for MFL. Co-credit:
> "Habman's MFL Popup — Habman wrote the script, TOS did the styling."

Updated 2017-03-28 to add login + player-search. Updated 2018-09 for Font Awesome. Demo league shown supported "desktop and mobile across all skins without requiring custom CSS" — the genesis of the no-CSS-needed promise that defines all later mflscripts work.

---

### 4.20  [t=435594 — Editing MFL menu links / adding new drop menu](https://www.fantasysharks.com/forum/viewtopic.php?f=506&t=435594) (OP 2017-03-30)

Canonical patterns:

```javascript
// Remove
jQuery('.myfantasyleague_menu ul li:contains("This Page")').remove();

// Replace with a custom dropdown
$('.myfantasyleague_menu ul li:contains("This Page")').replaceWith('<li class="has-sub">…</li>');

// Or position after an existing item
$('.myfantasyleague_menu ul li:contains("This Page")').after('<li>…</li>');
// Or before
$('.myfantasyleague_menu ul li:contains("This Page")').before('<li>…</li>');
```

Critical ordering note (post #8): "apply menu modifications **before** loading the mobile-menu script so new links get cloned properly." The mobile-menu script clones the desktop `.myfantasyleague_menu` into `.myfantasyleague_menuMobile` at init; any post-init mutations land in only one of the two.

Timing pitfall (post #12): "`$(document).ready()` causes timing issues since mobile menu loads during page initialization, preventing proper append operations." → use inline scripts or HPM-Header (server-rendered first), not `$(document).ready` for menu mutations.

---

### 4.21  Smaller / clarifying threads (verbatim quotes)

- **t=438267 (2021-02-22):** "No skin and no responsive css is loaded so no option available. If you dont select a skin those options are null and void." — i.e. you must pick at least one MFL skin for responsive variables to work.
- **t=438330 (2021-03-27):** "thats because you have to use full path of the images now, if your messing with a stock css file, your going to have to go through it and find any and all instances of images and find the full url path and insert them in." — MFL changed image-path resolution; relative paths inside uploaded CSS broke.
- **t=439124 (2022-05-10):** "There is no simple solution, you would have to inspect every element you want changed, view the current css for it in the developer console, then over write those rules in your custom css file." + "Did you wrap the css you placed in your header in `<style></style>`?" — the #2 cause of "doesn't work" tickets after Advanced Editor.
- **t=438833 (Remove dollar sign):** TOS did not post. Habman + jamieschott handled it.

---

## 5. External resources he hosts / links to

| URL | Type | Description | Captured? |
| --- | --- | --- | --- |
| https://www.mflscripts.com/ | Site root | Cloudflare-fronted; placeholder home with Lorem ipsum; real nav links to Images / SVG Nav / Tab Gen | curl'd (15KB, mostly placeholder) |
| https://www.mflscripts.com/mfl-apps/global/cache.js | JS — global cache | 128 KB, minified; uses `localStorage` (per `year+league_id`) + `indexedDB` (optional via `forceIndexedDB`); 12 MFL API TYPE= endpoints cached: `injuries, league, leagueStandings, liveScoring, myleagues, nflSchedule, players, projectedScores, rosters, topStarters, transactions, weeklyResults` | downloaded |
| https://www.mflscripts.com/mfl-apps/global/installer.js | JS — installer | 40 KB; **"INSTALLER SCRIPT LAST UPDATED 8-9-25"**; Fetch-API w/ `credentials:"include"`; 4 modes via radio UI | downloaded |
| https://www.mflscripts.com/mfl-apps/global/header.js | JS — header loader | 585 KB; orchestrates all header-marked scripts based on `var load_*` toggles | downloaded |
| https://www.mflscripts.com/mfl-apps/global/footer.js | JS — footer loader | 783 KB; orchestrates all footer-marked scripts | downloaded |
| https://www.mflscripts.com/mfl-apps/tabs/script.js | JS — custom tabs | 10 KB; `mfl_tabs_${league_id}_${year}` localStorage cache, 6h TTL; uses `?PRINTER=1` for tab-name source-of-truth | downloaded |
| https://www.mflscripts.com/mfl-apps/popups/players/script.js | JS — player popup | 178 KB; full popup engine + login/search | downloaded |
| https://www.mflscripts.com/mfl-apps/mobileMenu/script.js | JS — mobile menu | 18 KB | downloaded |
| https://www.mflscripts.com/mfl-apps/rosters/script.js | JS — tabbed rosters | 56 KB; uses MFL `TYPE=assets` export | downloaded |
| https://www.mflscripts.com/mfl-apps/global/css/300x50-icons.css | CSS — league icon sizing | for 300×50 franchise icons | n/a |
| https://www.mflscripts.com/mfl-apps/lineups/submit/responsive.css | CSS — submit-lineup mobile | required even for non-template users | n/a |
| https://www.mflscripts.com/mfl-customtabs/ | Tool — Custom Tabs Generator | Web UI to generate the `MFL_customTabs_FakeTabs` HTML | downloaded (54KB) |
| https://www.mflscripts.com/mfl-svg/ | Asset — SVG icon library | The 12+ SVG icons in the icon-bar | linked |
| https://www.mflscripts.com/ImageDirectory/ | Asset — Stock images | `script-images/`, `nflTeamsvg_2/`, `characters/` | linked |
| https://mflscripts.com/font-awesome/css/all.min.css | Asset — font-awesome (own-hosted) | post-Cloudflare-cdn outage backup | linked |
| https://cdnjs.cloudflare.com/ajax/libs/font-awesome/4.7.0/css/font-awesome.min.css | Asset — font-awesome 4.7 (CDN) | his preferred fallback / earlier version | linked |
| https://ajax.googleapis.com/ajax/libs/jquery/3.4.1/jquery.min.js | Library — jQuery 3.4.1 | the only jQuery he loads in the One-Click template | linked |
| https://www48.myfantasyleague.com/2026/home/19048 | MFL companion league | "MFL Manager" | linked |
| https://www48.myfantasyleague.com/2026/home/53411 | MFL companion league | "Player Status" | linked |
| https://www48.myfantasyleague.com/2026/home/73607 | MFL companion league | "Player Injuries" | linked |
| https://youtu.be/tn5rgDpkAdU | Video | League-setup-for-customization tutorial (Part 1) | linked |
| https://youtu.be/9MnEI27xeNY | Video | Tutorial Part 2 | linked |
| **nitrografixx.com** | **HOSTILE — ABANDONED** | Old CDN host (pre-2020); domain squatted; current JS is a click-trap redirect to `planet.news` | confirmed malicious |
| GitHub | not found | No publicly-discoverable GitHub repo for theeohiostate or mflscripts | open question |

### mflscripts.com README pages (publicly readable via curl with browser UA):
- https://mflscripts.com/mfl-apps/lineups/submit/1.READ_ME_HELP.html
- https://www.mflscripts.com/mfl-apps/scoreboard/custom-standAlone/1.READ_ME_HELP.html
- https://mflscripts.com/mfl-apps/lineups/1.READ_ME_HELP.html
- https://www.mflscripts.com/mfl-apps/popups/notfications/1.READ_ME_HELP.html
- https://www.mflscripts.com/mfl-apps/popups/addon/1.READ_ME_HELP.html
- https://mflscripts.com/mfl-apps/overview/1.READ_ME_HELP.html
- https://www.mflscripts.com/mfl-apps/popups/anything/1.READ_ME_HELP.html
- https://www.mflscripts.com/mfl-apps/switchThemes/mflSkins/1.READ_ME_HELP.html
- https://www.mflscripts.com/mfl-apps/scoreboard/mini-boxscore/1.READ_ME_HELP.html
- https://www.mflscripts.com/mfl-apps/popups/players/1.READ_ME_HELP.html
- https://www.mflscripts.com/mfl-apps/schedule/1.READ_ME_HELP.html

(There are 40+ scripts in the full directory per the t=441147 index; the above are the ones Google indexed.)

---

## 6. Synthesis: How the pros build for MFL

### 6.1  Hosting / distribution

**One pattern, used everywhere:** he hosts every JS/CSS file at `https://www.mflscripts.com/mfl-apps/<feature>/script.js` (Cloudflare-fronted; HTTPS-only; standard MIME). The MFL HPM ("homepage message") box stores **only a tiny config + `<script src>` loader**:

```html
<script>
  var configVar1 = true;
  var configVar2 = "0004";
</script>
<script src="https://www.mflscripts.com/mfl-apps/feature/script.js"></script>
```

He **never pastes the actual script body into the HPM**. The HPM is purely config + loader. Updates ship instantly to all his users via the central CDN.

**There is NO GitHub** — files are hosted directly on his web server with no public git history. The compressed/minified scripts are accompanied by uncompressed versions in the same directory: "The 'script.js' file has an uncompressed version that can be edited and hosted on your own server." (mflscripts.com player-popup README)

### 6.2  CSS architecture

Three layers, in this order of precedence (later overrides earlier):

1. **Linked stylesheet on his CDN** (e.g. `300x50-icons.css`, `responsive.css` for submit-lineup) — the global look.
2. **Custom CSS uploaded into MFL via Manage CSS** — the league-specific overrides.
3. **`<style>` blocks inside HPM #1 (Header)** — the per-tweak hot-patches.

Conventions:
- **CSS custom properties everywhere.** `--accent`, `--accent-light`, `--accent-dark`, `--main`, `--mobile-wrap-bg`, `--site-bg-image`, `--site-bg-image-one`, `--gradient-light`, `--gradient-dark`. **Always with a fallback value**: `var(--accent, #ff4200)`.
- **Theme classes on `documentElement`** (`document.documentElement.className = themeName`), not on `body`. Drives `:root` variable bindings.
- **Mobile breakpoints in `em`**, not `px`: `max-width: 48em`, `58em`, `62.5em` — survives root-font-size changes.
- **Page scoping via `#body_options_NN`** (the `O=` URL parameter becomes the body wrapper id) and `#body_<pagename>` (e.g. `#body_home`, `#body_ajax_ls`, `#body_standings`, `#body_processed_waivers`, `#body_options_03`, `#body_options_17`). No global page selectors.
- **Mobile-only / desktop-only via `.icon-hide` class** in the icon bar; flipped by media queries.
- **`.mobile-wrap` wrapper class** for tables that need horizontal-scroll on mobile.

### 6.3  JS patterns

- **jQuery 3.4.1**, loaded from `ajax.googleapis.com`. He doesn't use newer versions. Most snippets use jQuery; newer 2024+ scripts (rank column, add/drop rewrite) migrate to vanilla `document.querySelector` + `addEventListener`.
- **`year` and `league_id` are MFL-injected globals** — every script assumes they exist (they're rendered by MFL into the page bootstrap).
- **`baseURLDynamic`** is another MFL-injected global — the current `wwwNN.myfantasyleague.com` hostname.
- **MFL HPM macros** (`%HOST%`, `%YEAR%`, `%LEAGUEID%`) used in static HTML hrefs — MFL expands server-side.
- **No frameworks.** No React, no Vue, no Angular, no build step. Pure browser JS.
- **DOM-ready hooks:** prefers inline (HPM-Header runs as soon as parser hits it) over `$(document).ready()` because of timing issues with the mobile-menu clone. For things that *must* wait for late DOM (live scoring, popups), uses `setTimeout` + `requestAnimationFrame × 2`.
- **No mutation observers.** He prefers explicit hooks — e.g. `ls_after_update_scores()` callback that the live-scoring script calls itself.

### 6.4  Caching pattern (the most underappreciated part)

His `cache.js` is the engine that makes everything fast:

- **localStorage** keys: `mfl_<type>_<league_id>_<year>` style. Tabs script TTL = 6 hours.
- **IndexedDB** as the heavy-storage tier, opt-in via `var forceIndexedDB = false` (he flips it to true for owners hitting MFL's "Too Many Requests" rate-limit because of multiple leagues on one serverID).
- 12 MFL JSON-export TYPEs cached: `injuries, league, leagueStandings, liveScoring, myleagues, nflSchedule, players, projectedScores, rosters, topStarters, transactions, weeklyResults`.
- A `useCache_<feature>` global lets any script opt out (`useCache_irReport = false`).
- A "Manage Cache" link is inserted into the MFL Help menu so owners can "Clear Local Storage" or "Enable IndexedDB" without dev-tools.

This is **the bridge between MFL's rate-limited API and a UX that feels instant**. Anyone building MFL custom-HTML who doesn't replicate something like this will hit the "Too Many Requests" 15-minute IP ban within a few page reloads.

### 6.5  Mobile / responsive strategy

- **Mobile menu script** (`mobileMenu/script.js`) clones the desktop `.myfantasyleague_menu` into a `.myfantasyleague_menuMobile` accessible at the breakpoint.
- **`@media (max-width:650px)`** is his "phone" breakpoint for the report-to-cards transform.
- **`@media only screen and (max-width: 48em)`** is his mobile-menu breakpoint.
- **Banner swap** via duplicate `.banner-container` and `.banner-container.x-small`, swapped at `35.5em`.
- **`icon-hide` class** in the icon bar — desktop and mobile show different icon subsets.
- **CSS-only collapse-to-cards** for transactions/draft results/waivers (t=437553) — he never JS-rewrites tables on mobile, he restyles them with `display: block; position: relative;` etc.

### 6.6  MFL API integration

He pulls **MFL's JSON export** (`/YEAR/export?TYPE=<type>&L=<leagueid>&JSON=1`) — never XML in his current code. Endpoints used:

| TYPE | Purpose |
| --- | --- |
| `appearance` | Read tab layout names (used by horizontal/vertical-menu script) |
| `assets` | Used by rosters script (draft picks, BBID) |
| `injuries` | Player injury status |
| `league` | League settings, divisions, franchises |
| `leagueStandings` | Standings calculations |
| `liveScoring` | Live scoring feed |
| `myleagues` | Cross-league dashboard (MFL Live) |
| `nflSchedule` | NFL game schedule |
| `players` | Master player list |
| `projectedScores` | Projections (proj points) |
| `rosters` | Franchise rosters |
| `topStarters` | Position-leader breakdowns |
| `transactions` | Add/drop/trade log |
| `weeklyResults` | Fantasy matchups + scores |

**Authentication:** he uses `credentials: "include"` (the user's MFL session cookie) for installer.js POSTs. He documents an **auto-login URL bookmark** as the only "API-key-ish" mechanism: `https://api.myfantasyleague.com/2020/login?USERNAME=…&PASSWORD=…&XML=1`. There's **no per-user API key** in his code — everything piggybacks the browser session.

**Rate-limit handling:** explicit. When MFL returns "Too Many Requests" (after refreshing many times), he instructs users to switch to IndexedDB storage to reduce API hits. The cache.js has a 15-minute self-recovery: "wait 15-20 minutes and try again."

### 6.7  The bootstrap-loader pattern (VERBATIM)

The complete minimum-viable HPM that loads his whole world (drop into HPM #1, mark as Header):

```html
<script>var forceIndexedDB = false;</script>
<script src="https://www.mflscripts.com/mfl-apps/global/cache.js"></script>
<link href="https://mflscripts.com/font-awesome/css/all.min.css" rel="stylesheet">

<!-- THEME SWITCHER -->
<script>
function setTheme(themeName){localStorage.setItem('theme_'+year+'_'+league_id, themeName);document.documentElement.className = themeName;}
(function(){if(localStorage.hasOwnProperty('theme_'+year+'_'+league_id)) setTheme(localStorage.getItem('theme_'+year+'_'+league_id));})();
jQuery('noscript').remove();
</script>

<!-- VIEWPORT + TITLE + FAVICON -->
<meta name="viewport" content="width=device-width, initial-scale=1">
<script>jQuery(document).prop('title', 'My League Name');</script>

<!-- WHICH SCRIPTS DO YOU WANT? -->
<script>
var load_mobileMenu_script=true;
var load_chat_enhanced=true;
var load_popup=true;
var load_mini_boxscore=true;
var load_marquee=true;
var load_lineups_submit_script=true;
var load_tabs_script=true;
var load_irReport_script=true;
var load_diceRoll_script=true;
</script>

<!-- LOAD EVERYTHING -->
<script src="https://www.mflscripts.com/mfl-apps/global/header.js"></script>
<link rel="stylesheet" type="text/css" href="https://www.mflscripts.com/mfl-apps/lineups/submit/responsive.css">

<!-- WRAP THE PAGE (close in footer HPM) -->
<div id="container-wrap">
```

…and the matching footer (HPM #20, mark as Footer):

```html
<script>
var load_moduleExpand_script     = true;
var load_replace_mflScoring_h2h  = true;
var load_standingSettings_script = true;
var load_popupAddon_script       = true;
var load_notification_script     = true;
var load_rosters_script          = true;
var load_history_script          = true;
var load_irReport_script         = true;
var load_diceRoll_script         = true;
</script>

<!-- HIDDEN MODULE PROBES (for notification popups) -->
<div id="message_board_check" style="display:none"><module name="MESSAGE_BOARD_SUMMARY"/></div>
<div id="poll_check"          style="display:none"><module name="POLL_SUMMARY"/></div>
<div id="poll_check"          style="display:none"><module name="POLL"/></div>
<div id="trade_check"         style="display:none"><module name="TRADES"/></div>

<script src="https://www.mflscripts.com/mfl-apps/global/footer.js"></script>
</div><!-- close container-wrap from header -->
```

### 6.8  Anti-patterns he calls out

| Anti-pattern | His warning | Source |
| --- | --- | --- |
| Leaving "Use Advanced Editor" = YES | "MUST set this to NO, then save" | t=438211 §pre-install |
| Pasting full script bodies into the HPM | He hosts on CDN only — HPM is config-only | implicit across all threads |
| Mixing HTTPS pages with HTTP-served custom assets | "check every CSS, JS and IMAGE file on your site and be sure they all are using https url and not http" → CORS block | t=438211 troubleshooting |
| `$(document).ready()` for menu mutations | "causes timing issues since mobile menu loads during page initialization" | t=435594 post #12 |
| Forgetting `<style></style>` wrapper around CSS in an HPM | "Did you wrap the css you placed in your header in `<style></style>`?" — #2 most common ticket | t=439124 post #5 |
| Forgetting `@media` wrapper on mobile-only CSS | His own first version of t=437553 had this bug — got called out by GameTime, fixed it 2 days later | t=437553 post #3 |
| Duplicate MFL modules in different tabs | "MFL system doesn't permit same modules on page, can't have duplicate ID" | t=438195 post #15 |
| Reusing tab ID 100 | "100 is reserved … to insure no one uses it" | t=438195 post #13 |
| Hardcoded image paths inside an uploaded MFL CSS file | "you have to use full path of the images now … find any and all instances of images and find the full url path" — MFL changed relative-path resolution | t=438330 |
| Relying on `usmg_ad` not being shown | Live-scoring page injects ads; needs `googletag = null` + jQuery remove + CSS hide | t=438075 |
| Hard-coding "Owner Activity" tab as `tab202` | If you reorder tabs, the refresh hook silently breaks; must update `#tabNNN` in the footer hook | t=438195 post #9 |
| Bespoke per-site scripts in his support threads | "you want a custom script written just for your site? Hire a developer Mitch, we do stuff that everyone can use" | t=438272 post #14 |

### 6.9  Things he reuses (his canonical library)

| Snippet name | One-liner | Source |
| --- | --- | --- |
| `setTheme()` w/ `localStorage` per-league | `localStorage.setItem('theme_'+year+'_'+league_id, themeName); document.documentElement.className = themeName;` | t=438196 |
| `jQuery(':contains(...)').parent().remove()` | Menu-link removal by text | t=437694 |
| `jQuery(...).replaceWith(...)` | Convert menu link into a dropdown | t=435594 |
| `googletag = null; jQuery('[id*="usmg_ad"]').remove()` | Ad killer | t=438075 |
| `MFL_customTabs_FakeTabs[] = ({href, target})` | Add a fake tab pointing at any URL | t=438195, t=438272 |
| `?PRINTER=1` source-of-truth fetch | Read tab metadata without MFL chrome | tabs.js |
| `requestAnimationFrame × 2 + setTimeout` reveal | Anti-flicker for MFL pages | t=443978 |
| `?HIDE_CUST=1` / `?HIDE_CUST=0` | Break-glass recovery | t=441147 |
| `var forceIndexedDB = false` flip-to-true | Workaround for "Too Many Requests" | t=441147 |
| `<module name="MESSAGE_BOARD_SUMMARY"/>` probe div | Hidden MFL module the popup-addon scrapes for badges | t=438211 §HPM-#20 |
| `?v=1.4.7` increment-on-release cache-bust | Stops owners needing hard refresh | t=438211 §HPM-#20 closing |
| `.banner-container` / `.banner-container.x-small` swap | Mobile/desktop banner images | t=438259 |
| `#body_options_NN` page scoping | URL `O=NN` becomes body wrapper id | every CSS thread |
| `var(--accent, #fallback)` everywhere | CSS variables with fallbacks | t=438196 + template |

---

## 7. Snippet library (reusable, deduped — drop-in for any league)

| Name | Purpose | Code | Source |
| --- | --- | --- | --- |
| Theme switcher (localStorage) | Dark/light/custom per league per user | See §4.3 verbatim | t=438196 |
| Lock single theme | If not using the switcher | `<script>document.body.classList.add("theme-dk-red");</script>` | t=438211 §4.2.5 |
| Recovery URL (commish bookmark) | Disable all customizations server-side | `https://wwwNN.myfantasyleague.com/YEAR/logout?L=LEAGUEID&HIDE_CUST=1` | t=441147 |
| Auto-login URL (per-owner bookmark) | One-click login | `https://api.myfantasyleague.com/YEAR/login?USERNAME=...&PASSWORD=...&XML=1` | t=441147 |
| Remove menu link by text | Surgical menu trim | `<script>jQuery('#my_options li a:contains("My Trophy Case")').parent().remove();</script>` | t=437694 |
| Remove mobile-menu item | Same for mobile | `jQuery('.mm-communications li:contains("Entire")').remove();` | t=437694 |
| Hide menu items via CSS | Survives mobile-clone mismatch | `.myfantasyleague_menuMobile .mm-help, .myfantasyleague_menu .mm-help { display:none!important }` | t=438178 |
| Live-scoring ad killer | Remove Google ads / iframes | `googletag = null; jQuery('div[id*="usmg_ad"]').remove();` | t=438075 |
| Custom-tabs fake-tab insertion | Add a tab pointing at any URL | `MFL_customTabs_FakeTabs["Scoreboard"] = ({"href":"//%HOST%/%YEAR%/home/%LEAGUEID%?MODULE=MESSAGE19","target":"_top"});` | t=438195 |
| Mobile transactions stack | `@media (max-width:650px)` on `#body_options_03 #transactions` etc. | See t=437553 source | t=437553 |
| Banner swap | `<div class="banner-container">` + `<div class="banner-container x-small">` + `@media (max-width:35.5em)` | See §4.13 | t=438259 |
| Owner-activity refresh hook | Reload module on tab click | `jQuery("#tab202").click(function(){ $("#tabcontent202").load(window.location.href + " #owner_activity", function(){ updateOnlineStatus(); }); });` | t=438211 §HPM-#20 |
| Playoff bracket text rename | Cosmetic seeding labels | See §4.2.10 (4 lines of `jQuery('#playoff1').find('td:contains(...)').text(...)`) | t=438211 |
| Force-collapse all home modules | One call | `setTimeout(function(){ doCustomCollapseAll(true); }, 100);` | t=438192 |
| Live-scoring after-update hook | Run code after every 15-30s refresh | `function ls_after_update_scores() { /* your code */ }` | t=443193 |
| Anti-flicker reveal | Hide via CSS, reveal via JS-after-DOM-settled | `requestAnimationFrame(()=>{ requestAnimationFrame(()=>{ setTimeout(()=>{ /* reveal */ }, 300); }); });` | t=443978 |
| Rank column injection | Add `<td>N</td>` to every standings row | See §4.17 (DOMContentLoaded + two selectors) | t=443344 |
| Tab-icon Font Awesome swap | Per-tab unicode override | `#tabmenu-wrap li#tab3 a:before, #tabmenu-wrap #tab_title.tab3:before { content: "\f1ea" }` | t=438211 §4.2.11 |
| Strip ALL tab icons | Quick reset | `#tabmenu-wrap li[id*="tab"] a:before { display:none }` | t=438211 |
| Roster-text mobile no-wrap | Keep team-name links on one line | `#roster_column_left td a { white-space: nowrap; }` inside `@media (max-width: 58em)` | t=438211 |
| Score popup CSS-var binding (dark) | Use site bg image | `var detailsWrapBG = "var(--site-bg-image,#111)";` | t=438185 post #2 |
| Force IndexedDB | Workaround "Too Many Requests" | `<script>var forceIndexedDB = true;</script>` (before cache.js) | t=441147 |

---

## 8. Open intel questions (what we still don't know)

1. **Real identity.** No GitHub, no Twitter, no LinkedIn surfaced. `mflscripts.com` WHOIS is not in the captures (Cloudflare proxy obscures it).
2. **Total post count beyond the threads we sampled.** With 2,535 forum posts and the inability to use `search.php?author=`, we've captured maybe 50-100 posts across ~28 threads. Likely 200-400 more replies exist on smaller Q&A threads. **Future intel pass should authenticate to FantasySharks and harvest the search results.**
3. **The full mflscripts.com `/mfl-apps/` directory.** The directory-index endpoint is gated behind a 403 unless you know the exact path. We've enumerated ~20 of the ~40+ scripts; the rest (e.g. `chat/enhanced.js`, `marquee/script.js`, `injuredReserve/IRreport/script.js`, `history/integrated/script.js`, `diceRoll/script.js`, `lineups/submit/script.js`, `lineups/alert/`, `commissioner/`, `playoffs/`, `mflLive/`, `survivor/`, `prizePayouts/`, `allPlay/`, `MondayNight/`, `FantasyTicker/`, `popups/anything/`, `popups/addon/`, `popups/notfications/`, `switchThemes/mflSkins/`, `scoreboard/replace-mflScoring/h2h.js`, `scoreboard/mini-boxscore/`, `scoreboard/custom-standAlone/`, `schedule/`, `add_drop/`) are knowable by URL but we haven't fetched each one's README.
4. **The Custom Tabs Generator UI** (`/mfl-customtabs/`) — we curl'd it (54KB) but haven't inspected its UI logic.
5. **The MFL Manager / Player Status / Player Injuries companion leagues** — these are league IDs `19048`, `53411`, `73607` on `www48.myfantasyleague.com`. Their actual content (which modules they expose, what JSON they serve to cache.js) hasn't been captured. Worth a separate intel pass — these are the "central data plane" his cache.js reads from.
6. **The original `customTabs.js` from nitrografixx (pre-2020).** It was a *predecessor* to the current `tabs/script.js`. The pre-2020 logic is no longer recoverable (domain is hostile).
7. **Whether mflscripts.com is paid / donations.** The site has a "Contact" form but no pricing. The forum signature line is neutral. No Patreon link surfaced.
8. **Habman's footprint.** Co-author on the original popups; ranked Mako Shark on FantasySharks. Worth a parallel intel pass — he's the #2 builder by reference count.
9. **`zewolff1`** (t=444098) — a newer commissioner publishing custom contract/cap scripts as of July 2025. Independent of mflscripts.com. Has his own Google Apps Script for salary imports. Worth flagging as a potential second canonical reference.

---

## 9. Quick-reference: MFL URL/module patterns he relies on

| Pattern | Meaning |
| --- | --- |
| `wwwNN.myfantasyleague.com` | NN is the server number (variable per league); use `baseURLDynamic` global |
| `api.myfantasyleague.com` | Cross-server API host (login, JSON exports) |
| `/YEAR/home/LEAGUEID?MODULE=MESSAGEN` | Render homepage with HPM #N as the visible content |
| `/YEAR/options?L=LEAGUEID&O=NN` | A "module" page; `O=NN` selects the module (3=Transactions, 5=Trades, 7=Rosters, 8=Stats, 17=Draft Results, 18=IR, 22=Results, 26=By-Laws, 37=Starter Pts, 50=Setup, 52=Draft, 79=Playoff, 98=Taxi, 101=Power Rank, 117=Most Added/Dropped, 119=Tiebreakers, 123=Calendar, 133=Trading Block, 247=History) |
| `/YEAR/standings?L=LEAGUEID` | Standings page |
| `/YEAR/lineup?L=LEAGUEID` | Submit lineup |
| `/YEAR/add_drop?L=LEAGUEID` | Add/Drop page |
| `/YEAR/ajax_ls?L=LEAGUEID` | Live scoring |
| `/YEAR/accounting_report?L=LEAGUEID&TYPE=GRID` | Cap accounting grid |
| `/YEAR/export?TYPE=<type>&L=<id>&JSON=1` | JSON export API (12 known TYPEs; see §6.6) |
| `/YEAR/home/LEAGUEID?PRINTER=1` | Print-view; canonical source for tab-name scraping (used by tabs.js) |
| `?HIDE_CUST=1` | Server-side disable of all customizations (recovery flag) |
| `%HOST%` / `%YEAR%` / `%LEAGUEID%` | MFL HPM-macro tokens (expanded server-side) |
| `<module name="…"/>` | MFL HPM-macro to inline-render a standard module |
| `#body_<page>` / `#body_options_NN` | Container ID for page-scoped CSS |
| `li#tab0` / `li#tab1` / … | Homepage tabs (zero-indexed; tab0 = "Home") |
| `#tabcontentNNN` / `#tabNNN` | Custom tab content/tab elements for tabs >= 200 |

---

**END.** This doc is canon — when in doubt about how the most-skilled MFL custom-HTML builder solves a problem, this is the first reference; only fall back to the broader `mfl_customization_community.md` for non-TOS techniques.
