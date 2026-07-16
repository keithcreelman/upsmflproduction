# TOS (theeohiostate) Removal Plan

**Created:** 2026-05-20
**Author:** background research agent (sub-session of `claude/exciting-tharp-235716`)
**Status:** PLANNING — implementation not yet started
**Prerequisite reading (read in order):**
1. `docs/mfl_native/theeohiostate_intel.md` (1,393 lines) — what TOS publishes
2. `docs/mfl_native/lessons_from_theeohiostate.md` (884 lines) — code review w/ adopt/skip recs
3. `docs/mfl_native/mfl_customization_official.md` (403 lines) — MFL's own customization docs
4. `docs/mfl_native/mfl_customization_community.md` (1,016 lines) — FantasySharks knowledge incl. `HIDE_CUST=1` rescue
5. `docs/mfl_native/mfl_page_html_inventory.md` (593 lines) — class catalog per MFL page

---

## Executive summary

> **2026-07-16 — Barebones Mode interaction:** the per-user stock-MFL fallback
> (`barebones_mode.md`) gates every TOS tag behind `UPS_BB_GATE` document.write
> blocks and forces `UPS_USE_NATIVE_PLAYER_POPUP=true` for barebones users —
> i.e. they run the Stage-4/5 native popup bridge TODAY. Removal stages that
> touch script tags must preserve the gated-document.write shape.

- **Three TOS dependencies** are loaded today on every MFL page: `header.js?v=1.60` (~585 KB) from HPM #1, `footer.js?v=1.12` (~783 KB) from HPM #20, and `light.css` (264 KB) auto-loaded by MFL as the active skin. Plus `playoffs/standingsColumns.js` and the CDN-hosted `300x50-icons.css` (smaller, less critical). Total TOS surface on every page ≈ **1.6 MB of JS + CSS** plus ~40 unscoped DOM transforms.
- **Hidden coupling is the blocker, not the scripts.** Commit `c9aa53b` proved that wholesale removal breaks the page immediately. Our HPMs declare ~70+ TOS config globals (footer.js consumes them at load); our header has 4 `void 0 ===` shims (`MFL_customTabs_FakeTabs`, `MFL_customTabs`, `MFLGlobalCache`, `reportNflByeWeeks_ar`) that already paper over expected globals; our O=43 CSS has explicit "TOS-mirror" rules (`.alert.alert-info-body`, `.add-drop-player-row`) styling post-transform DOM. Pull TOS in one swing and all of that collapses.
- **The right shape of the retirement is "drain, don't yank":** stand up first-party replacements behind feature flags (TOS still loads), flip our pages to read the replacement, then remove the TOS script tag. There are ~12 distinct features bundled in TOS scripts; most of them we either don't need or already have surgical replacements for. The two we DO need — `MFLBoxWrapper` mini-scoreboard and `<module name="…">` notification probes — are small and isolated.
- **Total estimated effort: 12–20 person-days across 10 stages.** No single stage is large; the cost is the verify+ship cadence across 8 affected page surfaces.
- **Top blocker list:** (a) we cannot enumerate `light.css` rules due to CORS, so visual-regression coverage will be eyeball-only; (b) commish-only features (notifications, popup-addon) need a logged-in commish session to verify; (c) the `tabs/script.js` Owner Activity refresh hook (`#tab202`) needs a per-league tab-ID audit before deletion.

---

## §1 — Dependency inventory

### 1.1 — TOS file: `https://www.mflscripts.com/mfl-apps/global/header.js?v=1.60`

**Loaded from:** `header_custom_v2.html:7105`
**Size:** ~585 KB minified
**Loads when:** synchronously, right after section-6 HPM block (after the offseason shim + 429 guard wrapper installs)

**Config vars our HPM declares for it (verbatim from `header_custom_v2.html:4740-4804`):**

| Var | Our value | TOS feature it gates |
| --- | --- | --- |
| `useREM` | `true` | TOS-wide rem-based responsive math |
| `add_abilities_link` | `true` | Inserts "Commish Abilities" link in menu (consumed by commissioner module) |
| `add_seedings_link` | `true` | Inserts "Playoff Seedings" menu entry |
| `SetHPMability` | `18` | HPM slot where "Commissioner Abilities" content lives |
| `SetHPMseeding` | `11` | HPM slot where "Playoff Seedings" content lives |
| `commishTeam` | `"0004"` | Franchise id used for commish-only UI (player popup commish controls) |
| `detailsOverlay` | `"rgba(0,0,0,.7)"` | Score/franchise popup CSS — overlay color |
| `detailsWrapBG` | `"var(--ups-surface,#111b2e)"` | Score popup background |
| `detailsWrapBorder` | `"var(--ups-border,#27476f)"` | Score popup border |
| `detailsWrapBorWidh` | `"0"` | Score popup border width (NB: TOS typo `Widh` preserved — required) |
| `detailsWrapBoxShdw` | `"0 0 1.563rem #000"` | Score popup shadow |
| `detailsWrapPadding` | `"0.625rem"` | Score popup padding |
| `detailsWrapRadius` | `"0.188rem"` | Score popup radius |
| `load_mobileMenu_script` | `true` | Mobile hamburger clone of `.myfantasyleague_menu` |
| `load_chat_enhanced` | `true` | League chat popup enhancements |
| `load_popup` | `true` | Player news / article / trade popups (`popups/players/script.js`) |
| `load_mini_boxscore` | `true` | Mini scoreboard above content (`#MFLBoxWrapper`) |
| `load_marquee` | `false` | Headlines ticker — disabled, we built our own (`ups-marquee-shell`) |
| `load_lineups_submit_script` | `true` | Lineup submit enhancements |
| `load_lineups_submit_scriptV3` | `true` | V3 lineup submit (Set 'em / leave 'em) |
| `load_tabs_script` | `true` | Custom-tabs script (homepage tab UX + fake-tabs API) |
| `load_tabs_versionTwo` | `true` | Tabs v2 swipe + extras |
| `tickerHomePageOnly` … `tickerLastPlayoffWeek` (~25 vars) | various | All marquee config — IGNORED because `load_marquee=false` |
| `tickerWidth` … `tickerBoxShdw` (~15 vars) | various | All marquee theming — IGNORED |

**Other globals TOS expects (set by HPM, lines 6939-6943):**

```js
var is_offseason            = window.is_offseason;   // computed by UPS shim
var reportNflByeWeeks_ar    = window.reportNflByeWeeks_ar;
var deactivate_all_offseason= false;
```

**Other globals we shim (lines 10-56) BEFORE header.js loads — these are the "we removed custom tabs but TOS still expects these" guards:**

- `window.MFL_customTabs_FakeTabs` → no-op `{onReady, init, mount, destroy}` shim
- `window.MFL_customTabs` → alias of above
- `window.customTabs` → alias
- `window.FakeTabs` → alias
- `window.MFLGlobalCache` → no-op `{onReady, get(returns null), set, remove}` shim
- `window.reportNflByeWeeks_ar` → `[]`
- `window.reportNflByeWeeksArray` → alias

**Features `header.js` provides on our pages (catalog):**

1. **Mobile menu (`load_mobileMenu_script`)** — clones `.myfantasyleague_menu` → `.myfantasyleague_menuMobile`; binds a hamburger toggle at small viewports.
2. **Chat enhancements (`load_chat_enhanced`)** — popup chat window, message badges.
3. **Player popup (`load_popup`)** — clicking any `<a class="position_*">` opens a draggable card with news / projections / scores / franchise links. Also injects the login icon when `ShowMFLlogin=true` (we don't set this; default applies).
4. **Mini boxscore (`load_mini_boxscore`)** — populates `<div id="MFLBoxWrapper">` (declared in `header_custom_v2.html:6851`) with a live cross-league fantasy matchup bar.
5. **Marquee (`load_marquee=false`)** — disabled. Our `<div class="ticker-wrapper">` is not mounted; we have our own `ups-marquee-shell` (lines ~7106+).
6. **Lineup submit script (`load_lineups_submit_script` + `*scriptV3`)** — enhances `/lineup` page (O=07 native lineup submission). Adds drag-drop, weekly nav, "Submit Lineup For Week:" reportnav rewrite.
7. **Tabs script (`load_tabs_script` + v2)** — homepage tab UX, fake-tabs API, 6-hour localStorage cache for tab names via `?PRINTER=1` scrape. We declare four no-op shims (`MFL_customTabs_*`) above so dependents survive when this is removed.
8. **`reportInjuriesAPI()`, `reportRostersAPI()`, etc.** — internal data wrappers (see `lessons §1j` _API_DEPS graph). Used by mini-boxscore + popup-addon.
9. **`updatePageNarrowFlag()` / page-width responsive class on `<body>`** — adds/removes a `narrow` class for CSS responsive hooks.
10. **`updateOnlineStatus()` global** — called by our footer's `#tab202` Owner Activity refresh hook (`docs/mfl_native/theeohiostate_intel.md` §4.2.10).

**DOM transformations `header.js` performs (verbatim from `lessons §7`):**

- `t.querySelectorAll(".reportnavigation, blockquote")` — adds `.alert.alert-info-body` to any element containing the string `"Hint:"`.
- All `<form>` get class `.reportform` added.
- All `<h2>`, `<h3>` get class `.h3-menu` added.
- `.pageheader` and empty `<li>` removed at startup (line 6231 of prettified header).
- `.pagebody` content sometimes wrapped in `<div class="mobile-wrap">` (header line ~6370, on `api_info` rebuild).

**CSS dependencies — `light.css` (the big rock):**

- **Cannot be enumerated directly** — `mflscripts.com` doesn't expose `light.css` content via CORS so we can't fetch + grep its rules from our origin.
- **Known categories** (from `lessons §7` + `mfl_page_html_inventory.md:84` capture):
  - The "skin" base — every TOS theme class (`theme-dk-orange`, `theme-niners`, etc.) lives here as a `--main`/`--accent` CSS-variable definition.
  - `.add-player-container .add-drop-player-row*` — the picker-row treatment (pale green selected wash) that beats our overrides on O=43 (`header_custom_v2.html:10270-10275` comment).
  - `.alert.alert-info-body` post-transform style — TOS's "Hint" callout pill.
  - `.reportnavigation`, `.reportnavigationheader` styling — 11 + 5 references per inventory doc.
  - `.weekly-navbar`, `.weekly-navbar-mobile`, `.weekly-navbar.week_optionsbox.pro_team` — TOS's MFL-transform target classes.
  - `.banner-icon`, `.banner-rightside`, `.bannerlinkicons`, `.svg-iconlink`, `.icon-bar`, `.svg-icon`, `.svg-text`, `.icon-hide` — TOS's icon-bar styles.
  - `.MFLSkinSelection`, `.MFLSkinSelectionbtn`, `#myMFLSkinSelection`, `.ThemeSwith_overlay` — theme switcher styles.
  - `#tabmenu-wrap`, `.myfantasyleague_tabmenu`, `#homepagetabs`, `#tab0`…`#tabN`, `#tabcontent200`+ — tabs script DOM hooks.
  - `.mobile-wrap` — used by MFL stock + TOS. **Cannot delete without testing every page.**
  - `.bannericon`, `.banner-container`, `.banner-container.x-small` — banner swap (we don't use these but rules exist).
  - `300x50-icons.css` (separate file, also CDN-loaded) — franchise icon grid for 300×50 league icons.
  - `mfl-apps/lineups/submit/responsive.css` — submit-lineup mobile transform. **We don't currently link this**; only header.js + light.css + 300x50-icons.css are on our HPMs.

**`light.css` is loaded by MFL itself**, not by us — it's the "skin" setting in For Commissioners → Manage → Skin. To stop loading `light.css` we'd need to change the league skin OR set `USE_SKIN=0` via commish settings (`lessons §6`). Neither happens until late stage.

---

### 1.2 — TOS file: `https://www.mflscripts.com/mfl-apps/global/footer.js?v=1.12`

**Loaded from:** `footer_custom_v2.html:96`
**Size:** ~783 KB minified
**Loads when:** synchronously, right after the HPM #20 config block

**Config vars our HPM declares for it (verbatim from `footer_custom_v2.html:11-85`):**

| Var group | Vars | Purpose |
| --- | --- | --- |
| **Rosters** | `tradeViewPermission=false`, `showTradesDefault=false`, `fid_commish="0007"`, `showNav=false`, `showMFLdefaultBtn=false`, `showAllstatus=false`, `rosCapdisplay="4"`, `leagueTypeNormal=false`, `rosEnableSwipe=true`, `SetLeftColumnWidth="9.375"`, `SetCaptionIconWidth="15.625"`, `RosterEnableMedia=true` | `rosters/script.js` (toggled OFF via `load_rosters_script=false` — we use our fork instead, see line 113) |
| **Trade calculator** | `showCalculator=false`, `showTopCalculator=false`, `calcHeaderName="Salary Delta"`, `hideTilClk=true` | Trade Calculator widget (inside rosters fork) |
| **Live scoring** | `ls_scoreboardName="UPS SCD"`, `ls_commish_id="0007"`, `ls_loader=false`, `largeLeagueSB=false`, `showTeamName=false`, `showTeamIcon=true`, `ls_includeProjections=true`, `ls_includeInjuryStatus=true`, `ls_excludeIR=true`, `ls_excludeTaxi=false`, `ls_popup_abbrev_name_icon=2`, `ls_orig_proj_when_final=true`, `ls_popup_status=true`, `ls_box_abbrev_name_icon=2`, `ls_hide_bye_teams=false`, `ls_show_win_probability=true`, `BreakRows=1`, `is_Allplay=false`, `fixedWidthBox=false`, `setBoxWidth="9.375"` | `scoreboard/replace-mflScoring/h2h.js` (DISABLED: `load_replace_mflScoring_h2h=false`) + `scoreboard/mini-boxscore/script.js` (header) |
| **Footer JS modules** | `load_moduleExpand_script=true`, `load_replace_mflScoring_h2h=false`, `load_standingSettings_script=true`, `load_popupAddon_script=true`, `load_notification_script=true`, `load_rosters_script=false`, `load_draftHistory_script=true`, `load_standingsHistory_script=true`, `load_playoffsHistory_script=true`, `load_tradesHistory_script=true`, `load_topsHistory_script=true`, `load_contractHistory_script=true`, `load_history_script=true`, `load_irReport_script=true`, `load_diceRoll_script=true` | One toggle per footer-bundled sub-module |
| **Popup add-on** | `enableAddonNewPM=true`, `enableAddonNewPost=true`, `enableAddonPoll=true`, `enableAddonTrade=true` | `popups/addon/script.js` — sliding notification rails for unread PM / forum posts / open polls / open trades |
| **Notification slide** | `includeVisitorNotification=true`, `includeTradeNotification=true`, `includeIRNotification=true`, `includeMsgBoardNotification=true`, `mflBoxAllPlayId="0004"`, `checkEverySecond_notificationVisitor=60`, `sameVisitor_notification_interval=300`, `trade_notification_interval=3600`, `notification_duration_seconds=1.5` | `popups/notfications/script.js` (sic: TOS typo) — toast-style alerts |

**Required HTML our HPM emits BEFORE footer.js loads (lines 87-93):**

```html
<div id="message_board_check" style="display:none"><module name="MESSAGE_BOARD_SUMMARY"/></div>
<div id="poll_check"          style="display:none">
  <module name="POLL_SUMMARY"/><module name="POLL"/>
</div>
<div id="trade_check"         style="display:none"><module name="TRADES"/></div>
```

These are MFL HPM-macro probes — MFL server-renders them into the stock module markup; the popup-addon scrapes them for badge counts.

**Features `footer.js` provides on our pages (catalog):**

1. **`load_moduleExpand_script`** — collapse/expand title bar on every `.homepagemodule` with a `title="Expand Report"` / `"Collapse Report"` toggle. State persistable in localStorage (`MFLRememberModuleStates`).
2. **`load_replace_mflScoring_h2h`=false** — DISABLED. Would replace MFL's standard h2h scoreboard.
3. **`load_standingSettings_script`** — checkbox UI overlay for standings table (column toggles + persisted localStorage).
4. **`load_popupAddon_script`** — sliding notification rails (badges for unread PMs, new forum posts, open polls, open trades). Reads the three `#*_check` probe divs above.
5. **`load_notification_script`** — toast notifications for trades / IR / visitors / message board updates.
6. **`load_rosters_script`=false** — DISABLED. We load `site/rosters/mflscripts_rosters_fork.js` (forked copy of TOS's rosters/script.js, hosted at `keithcreelman.github.io/upsmflproduction/rosters/`) per `footer_custom_v2.html:113`.
7. **`load_draftHistory_script` / `_standingsHistory` / `_playoffsHistory` / `_tradesHistory` / `_topsHistory` / `_contractHistory` / `_history`** — All hook into HPM #6 history rendering (which we DO display).
8. **`load_irReport_script`** — IR Report module rendering.
9. **`load_diceRoll_script`** — Dice Roll pre-draft order tool.
10. **The "wave 1" `.reportnavigation` DOM rewrites (~40 transforms, see `lessons §7`).** Runs at startup. Catalog (load-bearing items):
    - `th.divpct` → text "Div %"
    - `th.all_play_wlt` → text "All-Play"
    - `th.h2hpct` → text "%"
    - `div.mobile-wrap .reportnavigation:contains("Hint:")` → wrap in `<div style="text-align:center">`, change class to `.alert.alert-info-table`
    - `td.hint` → `.tdalert.tdalert-info-table`, wrap in `<span>`
    - `body .reportnavigation:contains("Hint:")` → `.alert.alert-info-body` ⚠️ (this is the O=43 rewriting line)
    - `.reportnavigation:contains("Top FAQ:")` → `.alert.alert-info-body`
    - `.reportnavigation:contains("Weekly NFL Injury Status…")` → `hide()`
    - `.mobile-wrap` parents → `.no-borderspacing`
    - `h3` → `.h3-menu`; `.mobile-wrap h3` → removeClass `.h3-menu`
    - 11 distinct `.reportnavigation:contains("…")` → `.weekly-navbar.week_optionsbox` (Show Rosters For Week, Go To Week, Power Rank As Of Week, Franchise Setup, Standings As Of Week, Submit Lineup For Week, Edit Newsletter, Go To Draft Round, Go To Team, Select A Category…)
    - `.weekly-navbar.week_optionsbox .reportnavigationheader` → text "SELECT WEEK: "
    - `.weekly-navbar.week_optionsbox.pro_team .reportnavigationheader` → text "SELECT TEAM: "
    - `#body_options_236 #container-wrap div > form` → `.reportform`
11. **Playoff bracket text replacements** ("Winner of Game #2" → "Worst Remaining Seed", etc., see `theeohiostate_intel §4.2.10`).
12. **Owner Activity refresh hook** — `jQuery("#tab202").click(function(){ $("#tabcontent202").load(window.location.href + " #owner_activity", function(){ updateOnlineStatus(); }); });` — depends on `#tab202` being the Owner Activity tab in our HPM tab layout. **NEEDS AUDIT** before delete.
13. **Add/Drop page rebuild** — `enhanced-add-drop-ui` block (~footer line 17620) — full redo of `/add_drop` page using anti-flicker double-RAF + setTimeout.
14. **`add-drop-player-row` picker rendering** — on O=43 (Manage Auction) and `/add_drop`, replaces the inline picker `<table>` rows with `<div class="add-drop-player-row [oddtablerow|eventablerow] [selected-player]">` blocks. Our O=43 dark theme repaints these (see `header_custom_v2.html:10003-10044`).

**CSS dependencies:** none beyond `light.css` (footer.js does NOT inject its own stylesheet).

---

### 1.3 — TOS file: `https://mflscripts.com/mfl-apps/playoffs/standingsColumns.js`

**Loaded from:** `footer_custom_v2.html:97`
**Size:** unknown (small, < 20 KB based on URL pattern)
**Purpose:** Adds extra columns to the playoffs/standings reporting; consumes `_standingsHistory_script`/`_playoffsHistory_script` toggles. Standalone — not bundled into header/footer.

**Features:**
- Adds tiebreaker / playoff-seed columns to the standings table.
- Hooks into MFL's `/playoff_results` and `/standings` page.

**Our coupling:** Single `<script src>` tag in HPM #20. No vars our HPM sets specifically for this beyond the `load_*History_script` flags.

---

### 1.4 — TOS file: `https://www.mflscripts.com/mfl-apps/global/css/300x50-icons.css`

**Loaded from:** `header_custom_v2.html:7589`
**Size:** ~5–10 KB
**Purpose:** Background-image sprite for the 300×50 franchise-icon grid (used by mini-boxscore + popup franchise links).

**Features:**
- Selectors `#franchiseicon_0001` through `#franchiseicon_0012` plus a `.franchiseicon` base class.
- Image paths point at `mflscripts.com/ImageDirectory/`.

**Our coupling:** We use franchise icons on mini-boxscore (header) + roster fork (footer); both currently rely on this CSS being present. Could replace by inlining the franchise icon sprite ourselves or by self-hosting a copy.

---

### 1.5 — Implicit CDN dependency: `https://www.mflscripts.com/playerImages_80x107/<P>.jpg`

Not a script, but: the player popup card injects `<img src="https://www.mflscripts.com/playerImages_80x107/{playerId}.jpg">` into the popup. Removing the popup script drops this dependency automatically.

---

### 1.6 — Implicit hostile dependency to remove regardless

`nitrografixx.com` — appears nowhere in our codebase today (verified with `grep`) but worth a one-time scan during stage cleanup. Hostile/squatted per `theeohiostate_intel §1`.

---

## §2 — Per-feature retirement strategy

| # | Feature | Currently delivered by | Strategy | Notes | Effort | Risk |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | Mobile menu clone | `header.js` (`load_mobileMenu_script`) | **Adapt** | Build a simple `<details>`-based hamburger in `site/shared/mobile_menu.js`. We already redirect mobile users to `/m/` via the floating "Switch to App View" button in footer (`footer_custom_v2.html:850-887`); the mobile menu primarily matters for users who stay on the desktop MFL page on a phone. Could even be CSS-only with `@media`. | S | LOW |
| 2 | Player popup card | `header.js` (`load_popup`) | **Adapt** | Already started: `site/shared/player_profile_master.js` exists. Extend it to be the single source for player cards across desktop + mobile. Bind to `a[class*="position_"]` clicks. | M | MED — popup is the highest-touch UX on MFL; must support news + scores + franchise + commish links |
| 3 | Mini boxscore (`#MFLBoxWrapper`) | `header.js` (`load_mini_boxscore`) | **Adopt verbatim, then adapt** | First port `mfl-apps/scoreboard/mini-boxscore/script.js` into `site/shared/mini_boxscore.js` standalone. Then incrementally swap it for our own (we already have a custom scoreboard / standings module in `site/standings/`). | M | MED — small-screen real estate; verify cross-league live scoring still works |
| 4 | Marquee headlines ticker | `header.js` (`load_marquee=false`) | **Already done** | We disabled it and ship our own `.ups-marquee-shell`. No further action. | — | — |
| 5 | Lineup submit script (incl. V3) | `header.js` (`load_lineups_submit_script` / `*V3`) | **Defer, then adapt** | Native MFL `/lineup` page works without it for our league. Per `feedback_roster_workbench_is_truth_not_ccc`, our main lineup flow is the Front Office iframe, not MFL native. Audit per-page usage; likely deletable. | S | LOW after audit |
| 6 | Tabs script + v2 + custom tabs API | `header.js` (`load_tabs_script` / `*versionTwo`) | **Delete + keep shims** | We already shim `MFL_customTabs_FakeTabs`/`MFL_customTabs`/`customTabs`/`FakeTabs` as no-ops (header lines 14-35). MFL homepage tabs work without TOS (native MFL renders them server-side). Just verify removal doesn't break Owner Activity (`#tab202`) hook — and re-mount or delete that hook. | S | LOW (shims already cover the API contract) |
| 7 | Theme switcher (`MFLSkinSelection`, `setTheme`) | `header.js` + `light.css` | **Delete** | We don't expose the paint-brush button; UPS has one fixed dark theme. The 32 NFL-team themes + 14 light skins are surface area we don't want. | S | LOW |
| 8 | Module expand/collapse | `footer.js` (`load_moduleExpand_script`) | **Adapt** | Pattern is trivial (~30 lines). Build `site/shared/module_collapse.js` keyed off `.homepagemodule .reporttitle` clicks. localStorage state via `MFLRememberModuleStates`. | S | LOW |
| 9 | Standings settings checkbox UI | `footer.js` (`load_standingSettings_script`) | **Defer** | Our `/standings/` view is its own first-party page. The TOS settings widget targets MFL's native standings page (O=08), which we direct away from. Leave the footer toggle ON for now; remove with the footer.js tag. | S | LOW |
| 10 | Popup add-on (PM / post / poll / trade badges) | `footer.js` (`load_popupAddon_script`) + 3 module-name probe divs | **Adapt** | Genuine commish-and-power-user value. Build `site/shared/notification_addon.js` that polls the existing `#message_board_check` / `#poll_check` / `#trade_check` probes (we keep emitting them) and renders a slim rail. **Defers the polling architecture** — we could also drive this from the worker. | M | MED — needs commish login to verify; rate-limit considerations |
| 11 | Notification slide-down (visitor / trade / IR) | `footer.js` (`load_notification_script`) | **Adapt** | Smaller cousin of #10. Same architecture. Could be combined with #10 into one module. | S | LOW (combine with #10) |
| 12 | Rosters script | `footer.js` (`load_rosters_script=false`) → our fork `mflscripts_rosters_fork.js` | **Already adapted; verify it doesn't lean on `footer.js` runtime** | Our fork is hosted at GH Pages and toggled OFF in TOS's loader. Need to grep it for any reference to TOS-only globals (`MFLCache`, `report*API`, anti-flicker timeFrame, etc.). | S | LOW after audit |
| 13 | History scripts (`_draftHistory`, `_standingsHistory`, `_playoffsHistory`, `_tradesHistory`, `_topsHistory`, `_contractHistory`, `_history`) | `footer.js` | **Defer** | HPM #6 "History" is one of the higher-engagement modules. TOS provides 7 history sub-scripts that collectively render the integrated league-history experience. **Replacement is large** — push to phase 2. Until then leave loaded. | L | HIGH if rushed |
| 14 | IR report | `footer.js` (`load_irReport_script`) | **Adapt** | Render IR violations from our own worker (we already have D1 tables for this). Replacement is ~half-day. | S | LOW |
| 15 | Dice roll pre-draft tool | `footer.js` (`load_diceRoll_script`) | **Delete** | We don't run a dice-roll draft order. Confirm with Keith. | S | LOW |
| 16 | Playoffs/standings columns | `standingsColumns.js` | **Adapt** | Our `/standings/` first-party view should already cover this; the script only matters on MFL's native standings page. Remove with footer.js tag. | S | LOW |
| 17 | `.reportnavigation` → `.alert.alert-info-body` "Hint" rewrite | `footer.js` wave 1 + `header.js` wave 2 | **Adopt selectively (CSS only)** | We already have CSS rules that style BOTH the pre-transform `.reportnavigation` AND post-transform `.alert.alert-info-body` (header_custom_v2.html:9608-9687). Keep our CSS, drop the rewrite — our rules already match the original class so removing the transform makes our pre-transform rules light up correctly. | — | NONE — already covered |
| 18 | All other DOM rewrites (`Show Rosters For Week:` → `.weekly-navbar.week_optionsbox`, etc.) | `footer.js` wave 1 | **Delete** | We control the styling on pages we own (rosters via fork, auction via O=43 overrides, standings via first-party). Native MFL pages we don't actively style will lose their TOS polish — accept. | — | LOW (cosmetic only) |
| 19 | Playoff bracket text rename (`Winner of Game #2` → `Worst Remaining Seed`) | `footer.js` | **Adopt verbatim** | 4 lines of jQuery; mirror in `site/shared/playoff_bracket_polish.js`. | S | LOW |
| 20 | Owner Activity `#tab202` refresh hook | `footer.js` (or our HPM emits it) | **Audit then re-host** | If `#tab202` is still our Owner Activity tab, port the click hook into `site/shared/owner_activity_refresh.js`. If we no longer expose it, delete. | S | LOW |
| 21 | Add/Drop page rebuild (`enhanced-add-drop-ui`) | `footer.js` (deep inside) | **Adopt verbatim** | TOS shipped the new add_drop UI publicly at `mflscripts.com/mfl-apps/add_drop/script.js` + `style.css` (2025-06-15, `intel §4.18`). Could mirror those files into `site/add_drop/`. OR delete entirely if our Front Office workbench is the canonical add-drop entry. | M (port) / S (delete) | MED — heavy UX surface |
| 22 | `add-drop-player-row` picker render on O=43 | `footer.js` | **Adapt** | We have explicit dark-theme overrides for these classes (header lines 10003-10044). Replacement is a first-party O=43 picker render (already partially planned per "Phase B-lite" / "Phase C" comments lines 9917-9930). | M | MED |
| 23 | `is_offseason` global (consumed by TOS) | UPS-side shim (header lines 6907-6943) | **Keep regardless of TOS** | This is OUR code already. After TOS removal, decide whether to delete or repurpose for our own modules. | — | NONE |
| 24 | MFL export 429 backoff guard | UPS-side wrapper (header lines 6945-7102) | **Keep + redirect into new cache layer** | We already intercept MFL `/export` fetches. When we port `MFLCache` (lessons §1), this guard becomes the `set/get` adapter. | — | NONE — improvement |
| 25 | `light.css` global skin | MFL skin setting | **Phase out via commish setting** | The LAST thing to remove. Requires For Commissioners → Manage → Skin change, OR `USE_SKIN=0` via the `csetup` endpoint (lessons §6). Plan a single staged change after every other transform has its own replacement. | M | HIGH — every TOS-styled class falls off at once; we need a full CSS sweep before flipping |
| 26 | `300x50-icons.css` franchise icon sprite | TOS CDN | **Self-host** | Save the file, host it at `keithcreelman.github.io/upsmflproduction/css/300x50-icons.css`, swap the URL. ~10 min. | S | LOW |
| 27 | Font Awesome CDN (`https://mflscripts.com/font-awesome/css/all.min.css`) | TOS CDN (referenced by `intel §4.1`) | **Verify usage and self-host or swap to public CDN** | We may not even use this; grep first. If we do, swap to `cdnjs.cloudflare.com/ajax/libs/font-awesome/...`. | S | LOW |
| 28 | jQuery 3.4.1 (footer dependency) | (loaded by MFL, not TOS) | **Keep — MFL still depends on jQuery 3.7.1** | Per `mfl_page_html_inventory.md:93`. No action needed. | — | NONE |

**Summary of strategy distribution:**

- **Adopt verbatim:** 3 (mini-boxscore initial port, playoff bracket polish, add/drop UI port)
- **Adapt (rewrite our own version):** 9 (mobile menu, player popup, mini-boxscore long-term, module collapse, notification add-on, notification slide, IR report, picker on O=43, owner-activity hook)
- **Delete (no replacement):** 5 (tabs script + shims kept, theme switcher, dice roll, standingsColumns, all "wave 1" rewrites except Hint)
- **Defer (keep current TOS dependency, plan revisit):** 3 (lineup submit, standings settings, 7 history sub-scripts)
- **Already covered (no action needed):** 4 (marquee, Hint→alert CSS already mirrored, rosters fork, is_offseason shim)

---

## §3 — Staged removal sequence

Each stage is a discrete commit / PR. Stages 1–4 don't remove anything from TOS — they stand up replacements behind flags. Stage 5 onward begins flipping pages and ultimately deleting the script tags.

### Stage 1 — Port `MFLCache` foundation
**Goal:** Build `site/shared/mfl_cache.js` mirroring `lessons §1` (memory → IDB → localStorage, BroadcastChannel, TTL/KEY tables, stampede locks, stale-while-revalidate). Wire the existing MFL-export 429 guard (header.js lines 6945-7102) through it.
**Files changing:** `site/shared/mfl_cache.js` (new); `header_custom_v2.html` (replace 429-guard inline block with `<script src="mfl_cache.js">`).
**Test plan:** Open three MFL tabs simultaneously; verify only one network hit per cache key; verify `?HIDE_CUST=1` still gives clean recovery; verify localStorage doesn't grow unbounded (eviction kicks in past quota).
**Rollback:** Revert the HPM #1 edit; the cache layer is additive — TOS keeps functioning.
**Touches TOS:** no removals yet.

### Stage 2 — `site/shared/reveal.js` + `site/shared/responsive_table.css`
**Goal:** Provide the anti-flicker reveal helper + the `td:before` card-stacking helper. Both are pure utilities; no UX flip yet.
**Files changing:** two new files; no HPM edits required (consumers will import when ready).
**Test plan:** Visual regression smoke on roster_workbench (apply helper to fix existing FOUC there as the first consumer).
**Rollback:** Delete the two new files.
**Touches TOS:** no removals yet.

### Stage 3 — Port mini-boxscore standalone
**Goal:** Mirror `mfl-apps/scoreboard/mini-boxscore/script.js` to `site/shared/mini_boxscore.js`, hosted at GH Pages. Load it from a NEW shim in HPM #1, BEFORE TOS header.js, behind `var UPS_USE_NATIVE_MINI_BOXSCORE = false`. While the flag is false TOS still drives `#MFLBoxWrapper`.
**Files changing:** `site/shared/mini_boxscore.js` (new); `header_custom_v2.html` (new flag declaration + script load).
**Test plan:** Flip the flag locally; verify `#MFLBoxWrapper` renders identically; cross-league + injury status display intact.
**Rollback:** Set flag back to false.
**Touches TOS:** no removals yet (TOS still loaded; mini-boxscore is just dual-mountable).

### Stage 4 — `site/shared/player_profile_master.js` becomes the popup
**Goal:** Extend the existing `site/shared/player_profile_master.js` to be a full player popup (news, projections, scores, franchise, commish links). Load it BEFORE header.js. Behind `var UPS_USE_NATIVE_PLAYER_POPUP = false`.
**Files changing:** `site/shared/player_profile_master.js` (extended); `header_custom_v2.html` (new flag + script load).
**Test plan:** Flip flag locally; click 20+ player names across roster, standings, scoreboard, contracts; verify all data displays, popup is draggable, login icon still appears (or we deliberately drop it).
**Rollback:** Set flag back to false.
**Touches TOS:** no removals yet.

### Stage 5 — Cut over to native helpers; turn off TOS bundled toggles
**Goal:** Set `UPS_USE_NATIVE_MINI_BOXSCORE = true` and `UPS_USE_NATIVE_PLAYER_POPUP = true`. **AND** set `load_mini_boxscore = false`, `load_popup = false` in HPM #1. TOS scripts still load but skip those modules.
**Files changing:** `header_custom_v2.html` only (config flips).
**Test plan:** Full matrix from §4 — every page, every persona (commish + non-commish).
**Rollback:** Flip both flags back.
**Touches TOS:** opt-out toggles only (no script-tag removal).

### Stage 6 — Mobile menu + module collapse + playoff bracket polish + owner-activity hook
**Goal:** Port four small features as native UPS scripts. Flip `load_mobileMenu_script = false` and `load_moduleExpand_script = false` in their HPMs.
**Files changing:** `site/shared/mobile_menu.js` (new); `site/shared/module_collapse.js` (new); `site/shared/playoff_bracket_polish.js` (new); `site/shared/owner_activity_refresh.js` (new or rolled into bracket polish); `header_custom_v2.html` + `footer_custom_v2.html` (toggle flips + new `<script src>` lines).
**Test plan:** Mobile-only smoke; expand/collapse a homepage module on Home; verify Owner Activity refreshes on tab click.
**Rollback:** Flip toggles back; delete new scripts.
**Touches TOS:** opt-out toggles only.

### Stage 7 — Notification addon + slide-down
**Goal:** Build `site/shared/notification_addon.js` consuming the same `#message_board_check` / `#poll_check` / `#trade_check` probe divs (we keep emitting them). Flip `load_popupAddon_script = false` and `load_notification_script = false`.
**Files changing:** `site/shared/notification_addon.js` (new); `footer_custom_v2.html` (toggles + script load).
**Test plan:** Commish-login session required. Open a PM, post on forum, open a poll, propose a trade — verify each badge appears and decays.
**Rollback:** Flip toggles back.
**Touches TOS:** opt-out toggles only.

### Stage 8 — Self-host CDN assets; verify rosters fork
**Goal:** (a) Save `300x50-icons.css` to `site/css/300x50-icons.css`, update URL in HPM #1. (b) Grep `site/rosters/mflscripts_rosters_fork.js` for any reference to global state set by TOS's footer.js (`MFLCache`, `report*API`, `timeFrame`, etc.); for each hit, either inline-define the dependency or refactor the fork. (c) Audit and grep for nitrografixx, document none-found.
**Files changing:** `site/css/300x50-icons.css` (new); `site/rosters/mflscripts_rosters_fork.js` (potentially modified); `header_custom_v2.html`.
**Test plan:** Visual smoke on rosters page (O=07 native NOT used for our flow, but the fork still binds to its DOM; verify nothing crashes); franchise icons visible everywhere.
**Rollback:** Swap URL back.
**Touches TOS:** prepares for header.js / footer.js deletion.

### Stage 9 — Audit & delete `load_lineups_submit_script`, `load_chat_enhanced`, `load_tabs_script`, `load_tabs_versionTwo`, `load_diceRoll_script`, `load_irReport_script`, `load_standingSettings_script`, `standingsColumns.js`
**Goal:** Flip every remaining `load_*` toggle to false except the history sub-scripts. Verify no page breaks. For chat / dice-roll / standings-columns / IR, build first-party replacements only where Keith confirms the feature still has users.
**Files changing:** `header_custom_v2.html` + `footer_custom_v2.html` (toggle flips); `site/shared/ir_report.js` (new, optional); delete `standingsColumns.js` `<script src>` from HPM #20.
**Test plan:** Full matrix from §4.
**Rollback:** Flip toggles back, restore standingsColumns line.
**Touches TOS:** opt-out toggles only, plus 1 script-tag deletion (standingsColumns).

### Stage 10 — Remove the `header.js` and `footer.js` `<script src>` tags
**Goal:** Final cut. Delete the two TOS `<script src>` lines from HPM #1 and HPM #20.
**Files changing:** `header_custom_v2.html:7105` (delete); `footer_custom_v2.html:96` (delete).
**Test plan:** Full matrix from §4 + `?HIDE_CUST=1` recovery confirmed working. Take 3-day soak period before declaring done.
**Rollback:** Restore the two lines.
**Touches TOS:** complete script removal. Note: `light.css` is still loaded by MFL as the skin — see Stage 11.

### Stage 11 — Final: phase out `light.css` skin
**Goal:** Pre-stage a `site/css/ups_skin_replacement.css` that mirrors every `light.css` rule we still rely on (covered via Stages 1–10 visual baselines). Then flip the league skin via For Commissioners → Manage → Skin (or `csetup` POST) to no-skin / `USE_SKIN=0`, simultaneously loading the replacement.
**Files changing:** `site/css/ups_skin_replacement.css` (new, large); MFL commish setting (out-of-repo); `header_custom_v2.html` (link the replacement).
**Test plan:** Full matrix + commish-login pages. Take a 7-day soak. This is the highest-risk stage because we cannot enumerate the rules we're replacing.
**Rollback:** Re-flip the skin back to whatever it is now (capture the name before changing).
**Touches TOS:** complete CDN dependency removal except possibly `playerImages_80x107` if our popup still uses those URLs (capture and self-host if needed).

---

## §4 — Test matrix

For each stage, run the matrix below. The "TOS features active" column reflects what we lose if removal is incomplete.

| Page | URL pattern | TOS features active today | Spot-check items each stage |
| --- | --- | --- | --- |
| **Home** (`MESSAGE7` — Front Office) | `/YEAR/home/LID?MODULE=MESSAGE7` | Tabs script (homepage tab nav), module-expand on .homepagemodule, mini-boxscore, marquee (disabled, no-op), popup-addon notification rail, "Hint:" → alert-info-body, h3-menu class, .reportform class | Front Office iframe loads; tab nav works; mini-boxscore visible (or gone after Stage 5); notification rail behaves; no JS console errors |
| **MESSAGE2** (Rules / CCC host) | `/YEAR/home/LID?MODULE=MESSAGE2` | Same as Home + ccc-deep-link normalization (UPS-side) | CCC iframe loads; deep-link `?cccPlayer=…` survives MFL redirect; no MFL chrome leaks |
| **MESSAGE4** (Standings v2) | `/YEAR/home/LID?MODULE=MESSAGE4` | standingSettings, history sub-scripts, "Standings As Of Week:" → .weekly-navbar, mini-boxscore | First-party standings renders; sortable; sticky headers intact |
| **MESSAGE11** (Team Ops) | `/YEAR/home/LID?MODULE=MESSAGE11` | All header.js services + footer.js services | All Team Ops actions work end-to-end |
| **O=05** Trade Offers | `/YEAR/options?L=LID&O=05` | Trade offer page enhancements (footer JS trade-twocolumn-table render); rosters fork DOES NOT mount here (we redirect to MESSAGE6 War Room); .trade-twocolumn-table styling | UPS-side trade enhancements (data-ups-* attrs) intact; redirect to War Room on trade intent still works |
| **O=07** Rosters / Lineup Submit | `/YEAR/options?L=LID&O=07` | Lineup submit script V3 (with `load_lineups_submit_script=true`); body#body_options_07 native page; "Show Rosters For Week:" → .weekly-navbar; rosters fork DOES NOT mount here per `footer_custom_v2.html:109` ("bail on Submit Lineup") | Lineup submit posts cleanly; blind-bid label rename ("Blind Bidding Dollars" → "Salary") works |
| **O=08** Stats / Standings | `/YEAR/options?L=LID&O=08` | h2hpct/divpct/all_play_wlt header text rewrites; .weekly-navbar swap; standingsColumns.js extras | Header text still readable; tiebreaker columns visible (or gone after Stage 9) |
| **O=43** Auction Nominate | `/YEAR/options?L=LID&O=43` | `.add-drop-player-row` picker render (TOS), `.alert.alert-info-body` Hint rewrite, .add-player-container wrapper, picker selected-state green wash | Dark theme overrides intact (`header_custom_v2.html:10003-10044`); picker rows readable; quick-bid buttons inject; locked-msg legend painted; `?v=<sha>` bust working |
| **O=144** Contract Info | `/YEAR/options?L=LID&O=144` | Contract history script; .reportnavigation Hint rewrite | Contract grid renders; era columns visible |
| **/standings** | `/YEAR/standings?L=LID` | "Standings As Of Week:" → .weekly-navbar; standingsColumns extras | First-party standings (if redirected); otherwise MFL native + TOS extras gone after Stage 9 |
| **/lineup** | `/YEAR/lineup?L=LID` | Submit Lineup For Week → .weekly-navbar; lineup submit V3 | Native MFL lineup submit works (we don't replace) |
| **/add_drop** | `/YEAR/add_drop?L=LID` | enhanced-add-drop-ui rebuild (deep in footer.js); anti-flicker reveal | Add/Drop flow intact; flicker minimal |
| **/ajax_ls** | `/YEAR/ajax_ls?L=LID` | Mini-boxscore drives this; replace-mflScoring (disabled) | Live scoreboard refreshes every 15-30s; mini-boxscore syncs |
| **`?HIDE_CUST=1`** recovery | `/YEAR/logout?L=LID&HIDE_CUST=1` then `&HIDE_CUST=0` | (intentionally none) | Page loads with zero custom HPM JS; bookmark works for commish |
| **/m/* mobile site** | `keithcreelman.github.io/upsmflproduction/m/` | None — first-party static site; isolated from desktop | Independent verification; the only coupling is `MFL_USER_ID` cookie forwarding from desktop footer (`footer_custom_v2.html:855-887`) which is read-only |

**Persona matrix:** repeat each cell as (a) anonymous-not-logged-in, (b) franchise owner non-commish, (c) commish (franchise 0004 / 0007). Some features (popup-addon notifications, installer) only fire for the commish; others (popup login icon) only fire for anonymous.

**Critical browser matrix:** Chrome (desktop + iOS Safari emulation), Safari iOS, Safari macOS, Firefox. TOS targets Chrome primarily; once we own the JS we should verify Safari especially.

---

## §5 — Decisions (resolved 2026-05-20)

All open questions resolved with Keith. Numbering preserved for traceability against research-archive copies of this doc.

| # | Topic | Decision | Implementation impact |
| --- | --- | --- | --- |
| 1 / 11 | Stage 11 timing & cadence | **Stretched cadence; tolerate 1–2 days of visual drift.** Stages run at 1–2/week with a 7-day soak before final cuts. | Effort distribution stays at 12–20 person-days; no pixel-perfect baseline required pre-Stage 11. |
| 2 | Dice Roll pre-draft tool | **DELETE in Stage 9, no replacement.** UPS doesn't use it. | §2 #15 confirmed delete. |
| 3 | In-MFL chat enhancements | **DELETE in Stage 9, no replacement.** League chat is dormant. | §2 row for #6 / `load_chat_enhanced` toggle confirmed off + no port. |
| 4 | Lineup submit V3 | **KEEP / PORT.** UPS uses native MFL lineup submission; the V3 drag-drop + reportnav rewrite are load-bearing. | §2 #5 upgraded from "Defer, then adapt" to **Adapt** in Stage 6/7 timeframe. |
| 5 | History sub-scripts (HPM #6) | **PORT in Phase 1 (becomes Stage 9.5).** Value isn't UX polish — it's understanding TOS's data-pull patterns so we can later replace with D1-native reports. | Add Stage 9.5 between Stage 9 and Stage 10; effort estimate +3–5 person-days. |
| 6 | Owner Activity `#tab202` hook | **DELETE with no replacement.** Verified: zero `tab202` / `owner_activity` references in our HPMs (Keith 2026-05-20). | §2 #20 confirmed delete; Stage 6 doesn't need an `owner_activity_refresh.js` after all. |
| 7 | Stage 11 skin flip mechanism | **DEFERRED indefinitely.** Don't flip `light.css` right now; document the `csetup` POST recipe in `docs/mfl_native/lessons_from_theeohiostate.md` §6 for future reference. | Stage 11 becomes "OUT OF SCOPE — recipe captured, execution deferred." Final state after Stage 10 = TOS scripts gone, `light.css` still loaded as MFL skin. |
| 8 | Add/Drop UI ownership | **DEFER port. STUDY TOS's public add_drop code for pull/push patterns only.** UI will be custom enhancements; we won't mirror TOS's look-and-feel. | §2 #21 downgraded from "Adopt verbatim / delete" to **Study-only**. Stage 9 no longer includes an add_drop port. Capture findings in a new `docs/mfl_native/add_drop_study.md`. |
| 9 | Notification add-on audience | **All owners, custom UI.** Not a verbatim TOS port — design fresh popups. | §2 #10 + #11 reclassified as **Build (not Adapt)**. Stage 7 effort estimate +1–2 days to cover UX design. |
| 10 | Self-hosted assets location | **`site/shared/css/`** (new subdir under existing `site/shared/`). | Stage 8 path: `site/shared/css/300x50-icons.css`, `site/shared/css/font-awesome.min.css` (new — see #14), `site/shared/css/ups_skin_replacement.css` (future / deferred per #7). |
| 12 | `fid_commish` mismatch | **Both current values are stale.** Keith's actual commish franchise is **0008**. Normalize ALL new code to 0008. Flag a separate cleanup pass for the existing TOS configs (header `commishTeam="0004"`, footer `fid_commish="0007"` / `ls_commish_id="0007"`) — but that's adjacent work, NOT blocking. | All new modules (popup, notification add-on, mini-boxscore, etc.) use franchise `0008`. Add a §6 cleanup row below. |
| 13 | Popup login icon | **KEEP** (do not suppress for anonymous). | §2 #2 adaptation must preserve the login-icon branch for anonymous visitors. |
| 14 | Font Awesome source | **TOS provides it implicitly; we never link it ourselves.** Confirmed via grep: we use `fa-solid fa-*` classes heavily in [header_custom_v2.html:1662](header_custom_v2.html:1662)+, but there is no `<link>` to any FA CSS in our HPMs. Removing TOS will silently break every icon. **Stage 8 MUST self-host Font Awesome before Stage 10.** | New action: download FA `all.min.css` + webfonts to `site/shared/css/font-awesome/`; add `<link rel="stylesheet">` to HPM #1 in Stage 8. Estimate +0.5 day. |

---

## §6 — Plan deltas (applied 2026-05-20)

The decisions above modify §2 / §3 as follows. Reread §2 and §3 with these in mind:

1. **§2 row #5 (Lineup submit V3)** — strategy changes from "Defer, then adapt" to **Adapt**. Effort still S/M. Add to Stage 6 or 7.
2. **§2 row #15 (Dice Roll)** — **DELETE confirmed.** Remove `load_diceRoll_script` toggle + delete its loader from HPM #20 in Stage 9.
3. **§2 row #6 / chat** — `load_chat_enhanced` confirmed **DELETE.** Add a delete row if not present.
4. **§2 row #10 + #11 (Notification add-on)** — strategy changes from "Adapt" to **Build fresh**. Custom UPS popups for all owners. Don't mirror TOS rail layout.
5. **§2 row #20 (Owner Activity `#tab202`)** — **DELETE confirmed.** No `owner_activity_refresh.js` needed.
6. **§2 row #21 (Add/Drop UI)** — strategy changes from "Adopt verbatim / delete" to **Study-only**. Create `docs/mfl_native/add_drop_study.md` summarizing TOS's pull/push patterns. No code port.
7. **§2 NEW row: Font Awesome self-host** — see #14 in §5. Stage 8 must download + serve from `site/shared/css/font-awesome/`. Insert script-tag in HPM #1.
8. **§3 Stage 8** — expanded scope:
   - (a) Self-host `300x50-icons.css` → `site/shared/css/300x50-icons.css`
   - (b) **NEW: Self-host Font Awesome** → `site/shared/css/font-awesome/`
   - (c) Rosters-fork TOS-global audit (already in plan)
   - (d) nitrografixx scan: **completed 2026-05-20** — confirmed only in research docs, code is clean.
9. **§3 NEW Stage 9.5 — Port history sub-scripts.** Insert between Stage 9 and Stage 10. Goals: port the 7 `_*History*_script` modules to first-party equivalents. Capture data-pull patterns in `docs/mfl_native/history_module_data_patterns.md` for future D1-native replacements.
10. **§3 Stage 11 — DEFERRED.** Capture the `csetup` skin-flip recipe in `docs/mfl_native/lessons_from_theeohiostate.md` §6, then leave `light.css` loaded indefinitely. Plan terminates after Stage 10. (Future revisit: revisit when MFL skin policy changes or a UX redesign forces it.)
11. **Commish ID normalization** — all new modules (popup, mini-boxscore, notification add-on, mobile menu) use franchise **0008**. Separate adjacent cleanup ticket: update header `commishTeam`, footer `fid_commish`, footer `ls_commish_id` to 0008.

---

## §7 — Updated effort estimate

| Stage | Status | Effort (person-days) |
| --- | --- | --- |
| 1. MFLCache foundation | unchanged | 1.5 |
| 2. reveal.js + responsive_table.css | unchanged | 0.5 |
| 3. Mini-boxscore port (behind flag) | unchanged | 1.5 |
| 4. Player popup port (behind flag) | unchanged | 2.0 |
| 5. Cut over mini-boxscore + popup | unchanged | 1.0 |
| 6. Mobile menu + module collapse + playoff polish (NO owner-activity refresh per Q6) | reduced | 1.0 |
| 7. Notification add-on (build fresh per Q9) | +1–2 | 3.0 |
| 8. Self-host CDN assets (+Font Awesome per Q14) | +0.5 | 1.0 |
| 9. Audit & flip remaining toggles (Dice Roll + Chat confirmed delete; Lineup V3 keep) | unchanged | 1.5 |
| 9.5 **NEW** — Port history sub-scripts | added per Q5 | 3.0–5.0 |
| 10. Delete header.js + footer.js script tags | unchanged | 1.0 |
| 11. ~~Skin flip~~ | DEFERRED per Q7 | 0 |
| **Total** | | **17.0–19.0 person-days** |

Within the original 12–20-day envelope. Stage 11 deferral saves the largest single risk; Stage 9.5 (history port) consumes the recovered budget.

---

**END.** This plan is the artifact; nothing has been removed or rewritten in code yet. Decisions register (§5) and deltas (§6) finalized 2026-05-20. **Next step: Stage 1 — port `MFLCache` foundation.**
