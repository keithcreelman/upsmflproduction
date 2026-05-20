# MFL Official Customization Documentation (Canon)

**Source:** Captured 2026-05-20 from MFL Support → Appearance & Customization → Advanced Customization, plus the public `MFLBaseCSS.css` stylesheet and the rendered HTML of `home/74598` and `options?L=74598&O=43`.
**Captured by:** research agent (sub-session of `claude/exciting-tharp-235716`)
**Important up-front finding:** MFL's documentation deliberately does NOT enumerate CSS classes. They explicitly tell users to "View Source" or use the Firefox Web Developer Extension's "Information > Display ID And Class Details" feature to discover classes/IDs on the fly. The class inventory below was therefore extracted directly from MFL's public stylesheet (`https://www48.myfantasyleague.com/skins17/MFLBaseCSS.css`) and from live HTML — that file IS the source of truth for what MFL ships.

---

## FAQs visited

All 13 FAQs in CATEGORY=Appearance & Customization, SUBCATEGORY=Advanced Customization were visited and captured verbatim. Plus 8 relevant FAQs from sibling subcategories (Site Appearance, Images & Logos).

### Advanced Customization (13)

| # | FAQ | Title | URL |
|---|-----|-------|-----|
| 1 | 1137 | Why are my API calls sometimes not returning any data? | `support?L=74598&FAQ=1137` |
| 2 | 570  | I saw a really cool feature on someone else's site - how did they do that? | `support?L=74598&FAQ=570` |
| 3 | 957  | When I try to save HTML to my league pages, I get an error "Error - Message Cannot Contain These Tags..." | `support?L=74598&FAQ=957` |
| 4 | 1059 | How do I remove the header image from a skin? | `support?L=74598&FAQ=1059` |
| 5 | 558  | I've got some custom code entered into my site, and it's not working - can you help me fix it? | `support?L=74598&FAQ=558` |
| 6 | 825  | What "special" variables can I use in my custom code to make it generic across all leagues? | `support?L=74598&FAQ=825` |
| 7 | 952  | My league home page takes a long time to download - what's wrong? | `support?L=74598&FAQ=952` |
| 8 | 1014 | I want a high-end design but I don't have the skills - what can I do? | `support?L=74598&FAQ=1014` |
| 9 | 900  | What kinds of programs have third parties written using your Developer's Program? | `support?L=74598&FAQ=900` |
| 10 | 595 | How do I take my league home page customization to the next level? (the main Advanced Customization Guide) | `support?L=74598&FAQ=595` |
| 11 | 1135 | How can I obtain the scores and status of in-progress NFL games? | `support?L=74598&FAQ=1135` |
| 12 | 935  | Can I write a live draft client to interface with MyFantasyLeague.com's native live draft? | `support?L=74598&FAQ=935` |
| 13 | 691  | How do I use the RSS Feed page? | `support?L=74598&FAQ=691` |

### Adjacent appearance FAQs visited

| # | FAQ | Title | Subcategory |
|---|-----|-------|-------------|
| 14 | 730 | How do I use the Images & Other URLs Setup page? | Images & Logos |
| 15 | 547 | Why do my league pages take so long to load? | Site Appearance |
| 16 | 338 | How do I Change my League Skin? | Site Appearance |
| 17 | 1027 | My league home page is cut off on the right hand side - how can I fix this? | Site Appearance |
| 18 | 672 | How do I use the Message #: 1-20 page? (home page messages) | Site Appearance |
| 19 | 617 | How do I use my league home page? | Site Appearance |
| 20 | 670 | How do I use the Select A Skin page? | Site Appearance |
| 21 | 763 | How do I use the Home Page Modules & Tabs Setup page? | Site Appearance |

---

## Where custom HTML and CSS are injected

MFL's documented insertion points (verbatim from FAQ=595 and FAQ=672, FAQ=730):

### Custom CSS

> "Finally, once you've written your custom CSS, you can go to the For Commissioners > Setup > Appearance Setup > [Images & Other URLs](csetup?C=IMAGES) page and upload your custom CSS to our site (or, simply enter the URL for the CSS file on your own server)." — FAQ=595

> "League Cascading Style Sheet (CSS) - Use this advanced-programming option to define a URL pointing to your custom-defined CSS file. Your URL must start with the 'https://' notation. Also see CSS Feature Announcement
>
> Upload League Cascading Style Sheet (CSS) - If you want to use a custom CSS file that's less than 300 kb in size, you can use this option to upload a copy of it to our system. If you use this option, you need not use the 'League Cascading Style Sheet (CSS)' option above. Like the above setting, however, you must manually create your CSS codes." — FAQ=730

**File-size limit for uploaded CSS: 300 kB.** **URL must be HTTPS.**

### Custom HTML

Custom HTML lives in numbered "Home Page Messages" (1–20). From FAQ=672:

> "This screen allows the commissioner to define information to appear on the home page. Using the 'Message Number' links at the top of the page, the commissioner can define any/all of the home page messages. ... These messages can be placed at different locations on the home page using the Setup > Home Page Modules & Tabs Setup option.
>
> NOTE: XHTML tags are supported, but you cannot enter any XHTML before the `<body>` tag as well as after the `</body>` tag. This is a common problem when using a third-party program such as MS Word to generate your XHTML message. XHTML is also not supported in the Message Label of the Home Page Messages.
>
> Message Should Appear - Check either box to have the currently defined message appear in the header (top) or footer (bottom) of all league pages.
>
> NOTE: Each individual message is limited to 256kb in size."

**So custom HTML/JS lives in one of 20 home-page-message slots, each ≤256 kB, and the "appear in header/footer" checkbox is what makes it global across all league pages.** Inside the message body, the disallowed tags are `<html>`, `<body>`, and `<textarea>` (FAQ=957).

### Banned tags

From FAQ=957:

> "those tags include:
> - the start and end 'html' tag.
> - the start and end 'body' tag.
> - the start and end 'textarea' tag."

---

## Documented CSS classes

MFL does NOT publish a class reference. They explicitly direct you to inspect the rendered HTML. The table below is **the extracted truth** from `https://www48.myfantasyleague.com/skins17/MFLBaseCSS.css` (loaded by every league page via `<link href="...MFLBaseCSS.css">`) and from live HTML on `home/74598` and `options?L=74598&O=43`.

### Layout / page-frame classes (high-value targets for theme overlays)

| Class | Definition from MFL base CSS | Where it appears | Notes |
| --- | --- | --- | --- |
| `body` | `font-family:'Open Sans',sans-serif; font-size:13px; color:#263e68; background-color:#fff` | Every page | Default text color is navy `#263e68` on white; THIS is what dark-theme overlays must override. |
| `.pageheader` | `width:100%` | Top wrapper, every page | Holds brandlogo + welcome. `pageheader::before` is the documented hook to suppress skin header images (FAQ=1059). |
| `.brandlogo` | `width:15%; vertical-align:top` | Top-left logo cell | |
| `.pagetitle` | `width:70%` | Center cell of header | |
| `.welcome` | `vertical-align:top; text-align:right; width:15%` | Top-right "welcome, FRANCHISE" cell | Renders in Roboto Condensed via global font rule. |
| `.bannerimage` | (not in base CSS — set via per-skin) | Above `.brandlogo` when a Banner Image URL is configured (FAQ=730) | |
| `.pagebody` | (not in base CSS — structural only) | Main content wrapper between header and footer | |
| `.pagefooter` | `font-size:95%; clear:both` | Bottom wrapper | |
| `.myfantasyleague_menu` | `width:100%; text-align:center; background:#263e68; border-bottom:4px solid #cd2122; z-index:99999` | Top horizontal nav bar | Navy background, red bottom rule — the source of MFL's brand palette. |
| `.myfantasyleague_tabmenu` (with `.main_tabmenu`) | `width:100%; background:#263e68; z-index:99998; margin-bottom:15px` | Home-page tab strip | |
| `.has-sub`, `.no-sub`, `.sub-default` | nav-li modifiers | Menu items in `.myfantasyleague_menu` | `mm-draft`, `mm-help`, `mm-league`, `mm-myacct`, `mm-player`, `mm-scores`, `mm-social`, `mm-trans` — top-level menu category modifiers. |
| `.mfl-icon` | (icon-font helper) | Inline icon spans throughout nav | |
| `.mobile-wrap` | mobile responsive wrapper | When viewport narrow | |

### Report / table classes (used on EVERY data page incl. O=43)

| Class | Definition | Notes |
| --- | --- | --- |
| `.report` (and `.playoffbracket`) | `margin-bottom:1em` | The base class on virtually every `<table>` MFL renders. Combined with `.homepagemodule` on home page modules. |
| `.reportfooter` | `td { text-align:center }` | Bottom row of `.report` tables (totals/links). |
| `.reportform` | (form-styling helper) | Forms inside reports. |
| `.reportnavigation` | `text-align:center; display:block; padding-top:1em; padding-bottom:1em` | **THIS is the class wrapping the "Hint:" instructional block on O=43 and many login/setup pages.** Not `.hint`. |
| `.reportnavigationheader` | `font-weight:700` | Inline `<span>` inside `.reportnavigation`, e.g. the bold `Hint:` label. |
| `.oddtablerow` | `background-color:#eee` | Odd-row striping in `.report` tables. |
| `.eventablerow` | `background-color:#ddd` | Even-row striping in `.report` tables. |
| `caption` | `font-size:120%; font-weight:700` | `<caption>` element above tables — title row, dark text. |
| `th` | `color:#FFF; font-style:italic; font-weight:700; background-color:#263e68` | All table headers — white text on navy. |
| `.headline` | (used on news/article modules) | Title rows in news modules. |
| `.articlecaption`, `.articlepicture`, `.articlepicturetable` | Article-module styling | News/articles modules. |
| `.homepagemodule` | per-module styling (caption `cursor:move`, etc.) | Class applied to draggable home-page modules. Module-row caption: `padding-top:5px; padding-bottom:5px; color:#FFF; background-color:#cd2122` (MFL red). |
| `.homepagemessage` | `border:1px solid #cd2122; padding:0; width:60%; margin:10px auto` | Wraps each numbered Home Page Message when rendered on the home page. |
| `.homepagecolumn` | `vertical-align:top; padding-right:5px` | Column wrappers around module stacks. |
| `.homepagetabcontent` | (tab-pane wrapper) | Content area below the tab strip. |

### Form-field classes

| Class | Definition | Notes |
| --- | --- | --- |
| `.inputlabel` | `text-align:right` | `<td>` containing a form field label. |
| `.inputfield` | `text-align:center` | `<td>` containing the input itself. |
| `.form_buttons` | `margin-left:auto; margin-right:auto; text-align:center` | Submit button row. |
| `.requiredfield` | (not in base CSS, set per skin) | Asterisk/red wrapper around required inputs. |

### Status / state classes

| Class | Definition | Notes |
| --- | --- | --- |
| `.warning` | `color:#cd2122` (MFL red) | Inline warnings. |
| `.error` | (per-skin) | Validation errors. |
| `.highlight` | (per-skin) | Highlight rows. |
| `.hint` | `div.hint{color:blue}` and `td.hint{color:blue}` | Distinct from `.reportnavigation`. The "Hint:" *text* on O=43 lives inside `.reportnavigation`, NOT `.hint`. |
| `.currenttab` | (per-skin) | Active tab in tabbed modules. |
| `.currentweek` | (per-skin) | Highlight in week selectors. |
| `.today` | (per-skin) | Today's date in calendar module. |
| `.gameunderway`, `.haspossession` | live-scoring indicators | Used in `livescoringsummary` module. |
| `.updatedstats` | stat-row freshness indicator | |
| `.franchise_online`, `.franchise_offline`, `.franchise_eliminated` | Franchise status | Used in standings/h2h modules. |
| `.shouldstart`, `.shouldbench` | Optimizer hints | Roster pages. |
| `.highscore`, `.lowscore`, `.moohighlight` | Score-row highlights | Scoring reports. |
| `.redzone` | Red-zone indicator | Live scoring. |

### Standings / data-cell classes (column-level)

Used as `<td class="...">` on standings/scoring reports:

`.points` `.week` `.salary` `.contractyear` `.drafted` `.year` `.rank` `.pf` `.pa` `.pb` `.pp` `.op` `.dp` `.vp` `.pwr` `.altpwr` `.gb` `.strk` `.eff` `.divw` `.divl` `.divt` `.divpct` `.divwlt` `.divpf` `.confw` `.confl` `.conft` `.confpct` `.confwlt` `.confpf` `.h2hw` `.h2hl` `.h2ht` `.h2hpct` `.h2hwlt` `.nondivw` `.nondivl` `.nondivt` `.nondivpct` `.nondivwlt` `.nonconfw` `.nonconfl` `.nonconft` `.nonconfpct` `.nonconfwlt` `.all_play_wlt` `.all_play_pct` `.minpf` `.maxpf` `.avgpf` `.minpa` `.maxpa` `.avgpa` `.bbidbalance` `.bbidspent` `.tiebreaker`

(All have `text-align:right` declared collectively in the base CSS.)

### Position / player classes

`.position_qb` `.position_rb` `.position_wr` `.position_te` `.position_dt` `.player` `.franchise` `.franchisename` `.franchiseicon` `.franchiselogo` `.leaguelogo` `.standingslogo` `.myfranchise`

### Draft / auction classes

`.draft_picks_container` `.draft_picks_header` `.picks` `.pick` `.selection` `.newposition` `.confl` (also column class — context-dependent) `.salary` `.credit` `.debit` `.acct` `.bbidbalance` `.bbidspent`

### Playoff bracket classes

`.playoffbracket` `.playoffbracketname` `.bracket` `.topteam` `.bottomteam` `.championship_week` `.week15`/`.week16`/`.week17` (parameterized) `.franchise_SEED1`–`SEED6` `.franchise_GAME1`–`GAME4`

### Modal / popup classes (player popup)

`.mflModal` `.mflModal-body` `.mflModal-content` `.MFLPlayerPopupTab` `.MFLPlayerPopupTabContent` `.MFLPlayerPopupLoader` `.MFLPlayerPopupJersey` `.MFLPlayerPopupNFLTeamLogo` `.MFLPlayerPopupArticleContainer` `.MFLPlayerPopupMoreNews` `.MFLPlayerPopupNotificationContainer` `.MFLPopTabWrap` `.pop-photo` `.popreport` `.popreportfooter` `.playerPopupIcon`

### Tooltip classes (`.tool-*`)

`.tool-tip` `.tool-title` `.tool-text`

### Calendar / misc

`.calendarday` `.timestamp` `.livescoringsummary` `.rulestable` `.reallysmall` `.tabs_scroll` `.mobile-view-draft` `.module_expand` `.player-search` `.verticalmenu` `.header_links` `.bannerimage` `.contractyear` `.ww` `.rows-4` `.rows-6` `.withleft`

---

## Documented IDs

### Page-level body IDs (parameterized by route)

MFL applies `id="body_<route>"` to the `<body>` element. Known examples in base CSS:

| ID | Page |
| --- | --- |
| `#body_home` | Home page |
| `#body_login` | Login page |
| `#body_options_254` | `options?O=254` (free-agent listings) |
| `#body_options_26` | `options?O=26` (a specific options page) |
| `#body_options_238` | `options?O=238` |
| `#body_ajax_la` | Live auction page (AJAX) |
| `#body_ajax_ld` | Live draft page (AJAX) |
| `#body_pro_schedule` | Pro schedule page |

This `body_<route>` pattern is the cleanest way to scope custom CSS to a specific MFL page WITHOUT affecting others.

### Home-page structural IDs

`#home` `#homepagecolumns` `#homepagecolumn1` `#homepagecolumn2` `#homepagetabs` `#myfantasyleague_tabs` `#tab0`/`#tab1`/... `#tabcontent0`/`#tabcontent1`/... `#sub0`–`#sub8`, `#sub100` `#tab_title`

### Module IDs (home-page modules render with these IDs)

`#standings` `#brief_standings` `#league_chat` `#weekly_summary` `#owner_activity` `#monthly_calendar` `#draft_status` `#draft_status_table` `#draft_countdown_timer` `#draft_picks_container` `#waiver_request_list` `#hot_news` `#my_news` `#news_articles` `#fantasy_articles` `#fantasy_preview` `#fantasy_recap` `#playoff1` `#playoff2` `#login` `#welcome` (also used as class context) `#custom` `#default` `#support`

### Player-popup IDs

`#MFLPlayerPopupContainer` `#MFLPlayerPopupHeader` `#MFLPlayerPopupClose` `#MFLPlayerPopupOverlay` `#MFLPlayerPopupLinks` `#MFLPlayerPopupBio` `#MFLPlayerPopupBioTab` `#MFLPlayerPopupNews` `#MFLPlayerPopupStats` `#MFLPlayerPopupStatsHistory` `#MFLPlayerPopupTrades` `#MFLPlayerPopupReminders` `#MFLPlayerPopupCommishMessage` `#MFLPlayerPopupMessages` `#MFLPlayerPopupArticleLoaded` `#MFLPlayerPopupLoaded` `#MFLPlayerPopupLoading`

### Menu / sub-menu IDs

`#hsubmenu` (horizontal sub-menu) `#vsubmenu` (vertical sub-menu) `#withmenus` `#pmLink` (private-message link, hover-styled)

### Form-page IDs (draft/picker)

`#picker` `#pickertop` `#source_list` `#destination_list` `#add` `#drop` `#ffa` `#modal_body_player`

### Misc

`#map_canvas` (Google Maps) `#cd2122` (sic — actually used as a color literal in CSS, listed in ID regex as a false positive)

---

## Page skins / color schemes available

The Select-A-Skin setup page (`csetup?C=SKIN`) requires login, so we could not enumerate skin names directly. What MFL DOES document:

> "Use this screen do specify an entire look and feel for your league's pages - including colors & images. Preview - Click on any of the default skins or the 'preview' text immediately below it to create a new window showing your league with the chosen skin. ... Current Skins - A table of currently available packaged skins to choose from." — FAQ=670

> "Through the use of Cascading Style Sheets (CSS), your league can take on it's own customized look and feel. Either define your own CSS and upload using the Images & Other URLs Setup screen, or select from one of our predefined skins with the Select A Skin screen." — FAQ=617

> "If the commissioner has given owners the ability to customize their league pages in the Setup > Abilities Setup then an owner can go to the My Franchise > Franchise Setup and click on the 'Skins' link to choose their own league skin for when they are logged into the league." — FAQ=338

**Note:** the public stylesheet path `skins17/MFLBaseCSS.css` suggests skins live under per-version folders (`skins17/...`). The current league appears to use the `MFLBaseCSS.css` baseline + a skin overlay. Individual skin names are not enumerated in any public FAQ.

---

## Documented JS hooks / window globals

MFL documents NO JavaScript hooks or `window.*` globals for customization purposes. The Developer's Program (`api_info`) is purely a data API (XML/JSON), not a client-side hook system.

What MFL DOES say about JS:

> "MyFantasyLeague.com allows you to enter custom XHTML, JavaScript and CSS into your league pages to give you literally unlimited appearance options, we do not provide support for these web languages, so you'll need to learn about them on your own, or find someone who can help." — FAQ=570

> "if you are making your requests via javascript from inside a league web page, then registering the client doesn't apply. In those cases your client is your browser. We will treat those requests as somewhere in-between un-registered and registered clients." — FAQ=1137

Custom JS is allowed inside home-page messages (same banned tags as HTML: no `<html>`, `<body>`, `<textarea>`). All API rate-limit rules in FAQ=1137 apply to JS that calls back to MFL's API.

### Live-draft client integration (FAQ=935)

The only documented "JS-like" interface is the live-draft polling interface, which is XML-over-HTTP (not a JS hook):

- `http://<host>.myfantasyleague.com/fflnetdynamic2026/74598_LEAGUE_draft_results.xml` — current draft state (poll ~every 5s)
- `http://<host>.myfantasyleague.com/fflnetdynamic2026/74598_LEAGUE_draft_status.xml` — status messages
- `http://<host>.myfantasyleague.com/fflnetdynamic2026/74598_chat.xml` — live-draft chat
- `http://www48.myfantasyleague.com/2026/live_draft?L=74598&CMD=DRAFT&PLAYER_PICK=<player_id>&ROUND=<r>&PICK=<p>&JSON=1` — make a pick
- `CMD=` values: `DRAFT`, `PAUSE`, `RESUME`, `UNDO`, `SKIP` (commissioner-only)

---

## "Special" template variables (FAQ=825) — available inside home-page messages

These tokens are auto-substituted by MFL when a home-page message is rendered. Useful for writing portable HTML/JS:

| Token | Substituted value | Example |
| --- | --- | --- |
| `%HOST%` | Current league host | `football5.myfantasyleague.com` |
| `%YEAR%` | Current year | `2026` |
| `%LASTYEAR%` | Last year | `2025` |
| `%NEXTYEAR%` | Next year | `2027` |
| `%LEAGUEID%` | Current 5-digit league ID | `12345` |
| `%LEAGUENAME%` | Current league name | `Dynasty Experts` |
| `%STATICHOST%` | "Static" league web server | `www5.myfantasyleague.com` |
| `%FRANCHISEID%` | Current viewer's franchise ID | `0001` |
| `%FRANCHISENAME%` | Current viewer's franchise name | `Marauders` |

> "instead of hard-coding a link to `http://football5.myfantasyleague.com/2026/options?L=12345&O=07` for your rosters report, you make that link generic like this: `http://%HOST%/%YEAR%/options?L=%LEAGUEID%&O=07`" — FAQ=825

---

## Caveats / pages that resist custom CSS

1. **Banned tags** (FAQ=957) — `<html>`, `<body>`, `<textarea>` (start AND end) cannot appear in custom HTML. Attempting to save them produces `"Error - Message Cannot Contain These Tags..."`.
2. **CSS upload limit** — 300 kB max (FAQ=730).
3. **HTML message limit** — 256 kB per Home Page Message (FAQ=672).
4. **Printer-friendly bypass** — appending `&PRINTER=1` to any setup URL renders without custom HTML/CSS. Useful if your own customizations break the page (FAQ=558).
5. **Skin header images** — to remove them, use `.pageheader::before { background-image: none; }` (FAQ=1059 — this is the ONLY concrete selector MFL documents in any FAQ).
6. **CSS support is unsupported** — MFL explicitly says they cannot help debug your CSS:
   > "Note that although we offer the ability to customize league pages, we are unable to assist in the support of modifying your league appearance pages." — FAQ=1059
   > "we cannot provide HTML and/or CSS support for custom code that's been written by our customers (or third parties)" — FAQ=558
7. **Third-party content slows pages** (FAQ=547, FAQ=952) — content loaded from non-MFL hosts (tickers, flags, sound clips) can stall the entire page load.
8. **HTTPS required** for all uploaded URLs (logos, CSS, banner, etc.) — FAQ=730.
9. **No documented hooks for native modal/popup theming** — the `MFLPlayerPopup*` IDs exist but their interaction with custom CSS is not documented. They render into a position:absolute overlay (`#MFLPlayerPopupContainer`) and use white backgrounds by default.

---

## Verbatim quotes worth keeping

> "We pride ourselves on having what we think is not only the most customizable on-line fantasy football league management service on the web, but also the most 'open', too. What that 'open-ness' means to you, if you're someone with some computer programming and/or web design skills, is that you can extend and customize your MyFantasyLeague.com league a great deal." — FAQ=595

> "Advanced customization options include:
> 1. Writing custom CSS to completely control all aspects of your league appearance.
> 2. Getting access to 'raw' MyFantasyLeague.com league data in industry-standard XML format.
> 3. Using Your Own Domain For MyFantasyLeague.com Leagues and Content and Embedding league home page modules in other web pages." — FAQ=595

> "Once you've learned CSS, next you'll have to learn a bit about the classes and IDs we use on the site. You can do that by setting up a free trial league on our site, and then doing a 'View Source' to see our current CSS files, including the CSS files used for each of our skins, to get a better idea of how to write CSS for your MyFantasyLeague.com league pages." — FAQ=595

> "Alternatively, here is another approach that might be easier, allowing you to see exactly what classes and IDs we use on your league pages:
> 1. Download and install the Firefox web browser.
> 2. Download and install the Web Developer Extension for Firefox.
> 3. Go to the league page you're looking to customize.
> 4. From the custom toolbar that gets installed, choose the 'Information > Display ID And Class Details' option, and you can see exactly what IDs and classes are used on any/all pages on the site.
> 5. Where this gets really cool is that you can edit the CSS right on the page, allowing you to immediately see the effects of your CSS changes right away." — FAQ=595

> "All home page modules are 'embeddable' - meaning, you can place 'live' MyFantasyLeague.com content inside web pages on another web site, your 'My Google' customized home page, or inside arbitrary HTML on your MyFantasyLeague.com-hosted pages. Check out the 'Reports > League > Embed League Data' page available from all league pages to see how this option works." — FAQ=595

> "Adding a ton of customization to your league home page can cause your league pages to take a really long time to download to your computer. ... Adding customization to your league home page that's hosted on a third-party site may cause your home page to not download at all if that third party site is having problems." — FAQ=952

> "As a rule of thumb, inserting HTML (or CSS, or JavaScript) in your league pages should only be done by customers who truly understand all parts of the code they are adding to the site. If you paste code into your site that you do not understand, there's an excellent chance that it will cause you problems down the road." — FAQ=957

---

## Cross-references to flag — classes we've been guessing

These are the practical takeaways for the UPS dark-theme project:

1. **The "Hint:" element on auction options (O=43) is `.reportnavigation` + `.reportnavigationheader`, NOT `.hint`.** Confirmed by inspection of `options?L=74598&O=43`:
   ```html
   <span class="reportnavigation">
     <span class="reportnavigationheader">Hint:</span>
     This is your MFL Account username or email address...
   </span>
   ```
   `.hint` IS a real MFL class but it's used in a different context (the base CSS only declares `div.hint{color:blue}` and `td.hint{color:blue}`). If our dark theme was targeting `.hint` to fix this element, that explains why it didn't work.

2. **The MFL color palette is two colors, declared all over the base CSS:**
   - Navy `#263e68` — body text, `<th>` background, `.myfantasyleague_menu` background, the brand "primary".
   - Red `#cd2122` — all link colors, `.warning`, `.homepagemodule caption`, the `border-bottom` of the nav. The brand "accent".
   - Any dark theme should override BOTH (`body { color: ... }` and `th { background-color: ... }` and `.myfantasyleague_menu { background: ... }`).

3. **For page-scoped CSS, prefer `body[id="body_options_43"]` (or `#body_options_43`) over guessing wrappers.** MFL stamps a `body_<route>` ID on every page (we confirmed `#body_home`, `#body_login`, `#body_options_254`, etc. in the base CSS). For O=43 the ID would be `#body_options_43` — that scope avoids accidentally hitting the live-draft (`#body_ajax_ld`) or auction (`#body_ajax_la`) routes.

4. **`.report` is THE table class.** Virtually every data block (rosters, free-agent lists, login form, setup forms) is a `<table class="report">`. Dark theme must override `.report td`, `.report th`, `.oddtablerow`, `.eventablerow`, and `caption`. The `oddtablerow` (`#eee`) and `eventablerow` (`#ddd`) backgrounds are near-white and become unreadable under any dark text override that doesn't also flip them.

5. **`caption` is NOT a class — it's the `<caption>` element itself.** MFL puts the table title in `<caption>` (e.g. "Login Required", "Auction Options"). Default styling is dark text on white (inherits body color). Dark theme must include `caption { color: ... }` or it will be black-on-dark unreadable.

6. **`<th>` is always white-on-navy** (`color:#FFF; background-color:#263e68`). If the dark theme darkens the page background, `<th>` is already light-on-dark so it works — BUT if the overlay sets a background on `.report` (e.g. dark gray), the `<th>` will still be navy and may clash.

7. **`.reportnavigation` text color is inherited.** The CSS does not set a color on `.reportnavigation` itself — it inherits from `body { color:#263e68 }`. So on the auction options page, the "This is your MFL Account username..." instructional text inherits navy. A dark theme that flips `body { color:#fff }` will fix this whole class of elements automatically. If our overlay was only targeting `.hint` or `td` but not `.reportnavigation` + inherited `body color`, that's the bug.

8. **`.homepagemessage` (where commissioner-injected HTML lands) has a red border by default** (`border:1px solid #cd2122`). If we inject styled HTML and want it borderless, override `.homepagemessage { border:none; }`.

9. **Home page modules use red caption backgrounds** (`.homepagecolumn .homepagemodule caption { color:#FFF; background-color:#cd2122 }`). Already light-on-red; safe.

10. **Menu IDs to know**: `#hsubmenu` (horizontal sub-menu under nav), `#vsubmenu` (vertical sub-menu), `#homepagetabs` (the tab strip on the home page only). Each has its own styling and may need separate dark-theme treatment.

---

## Quick-reference cheat sheet for the dark-theme overlay

```css
/* Page-scope the overrides to avoid bleeding into live draft/auction AJAX routes */
body[id^="body_"] {
  color: #e5e7eb;
  background-color: #0f172a;
}

/* All tables */
.report, .playoffbracket { background: transparent; }
.report td, .report th, .report caption { color: #e5e7eb; }
.oddtablerow { background-color: #1e293b; }
.eventablerow { background-color: #273449; }
caption { color: #f1f5f9; }
th { background-color: #1f2937; color: #f1f5f9; }

/* The "Hint:" / instructional block on O=43 (login, setup pages, etc.) */
.reportnavigation { color: #cbd5e1; }
.reportnavigationheader { color: #f1f5f9; }

/* Inputs */
.inputlabel { color: #f1f5f9; }

/* Brand navy bar — already dark, but you can theme it */
.myfantasyleague_menu, .myfantasyleague_tabmenu { background: #111827; }

/* The red home-page-module caption — keep brand or override */
.homepagecolumn .homepagemodule caption { background-color: #1f2937; }

/* Per-page scoping example — auction options only */
#body_options_43 .reportnavigation { color: #fde68a; }
```

(The above is illustrative, not authoritative. Treat the class/ID inventory in this doc as the canonical surface, and design overrides against it.)
