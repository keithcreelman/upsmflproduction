# Barebones Mode — per-user stock-MFL fallback

**Created:** 2026-07-16 · **Status:** SHIPPED (PR pending Keith's paste)
**What:** a per-user toggle that renders MFL pages with the entire custom layer disabled — stock MFL skin, stock menus, stock footer, native homepage modules only — as a fallback when the custom layer misbehaves. Two survivors: the **Full Site pill** (the way back) and the **stage-4 player modal** (contract data + a one-hop "Open in Front Office (full site) →" action), so owners can conduct contract business from the plain site. Keith 2026-07-16: *"completely barebones… no frills no thrills… nice to have fall back"*; carve-out: *"player pop ups would match the current modal… allows teams to conduct their contracts while still on the old site."*

## Rescue tiers

| Tier | Mechanism | What survives | How |
|---|---|---|---|
| 1 | The toggle (`localStorage.ups_barebones_v1`) | pill + player modal | "🔌 Lite Mode" in the desktop subnav / mobile drawer → "⚡ Full Site" pill (bottom-left) to return |
| 2 | URL param | same | append `?ups_barebones=1` or `=0` to any league URL (also `#ups_barebones=`). Persists to localStorage, then **self-strips** via `replaceState` so MFL never sees it |
| 3 | **HIDE_CUST (break-glass)** | nothing custom — MFL-served stock | `https://www48.myfantasyleague.com/2026/logout?L=74598&HIDE_CUST=1` (prod) · `…?L=25625&HIDE_CUST=1` (test). **Restore:** same URL with `HIDE_CUST=0`. Session-sticky. Strips EVERYTHING incl. the guard, pill, and modal — bookmark the restore URL BEFORE using it. Menu entry: Legacy Links ▾ → Account → "Stock MFL (break-glass)". Source: FantasySharks thread 441147 (see `mfl_customization_community.md` §Safety) |

## Mechanism

1. **The guard** — the FIRST `<script>` block in `header_custom_v2.html`. Reads storage + URL param → `window.UPS_BAREBONES` and defines `window.UPS_BAREBONES_SET(next)` (all buttons call it; storage-unavailable → alert with the URL fallback; default OFF). When ON it: sets `data-ups-barebones` on `<html>` · forces `UPS_USE_NATIVE_PLAYER_POPUP = true` (survivor #2) · disables MFL's `link#custom` (TOS light.css) while keeping `link#default` (MFLBaseCSS = the stock look) · runs a **style/link MutationObserver** disabling every later `<style>`/custom `<link>` as it parses (allowlist: `#upm-master-styles`, `#ups-bb-style`; pre-guard styles snapshotted) · injects `#ups-bb-style` hiding static custom HTML (hero/hotlinks/custom footer/app-switch pill/dev banner/subnav) · hides custom homepage modules (`.homepagemodule` boxes containing our github.io/worker embeds; native HPMs — standings, **MFL Legacy Links**, polls — untouched) and removes their iframes · injects the pill · logs a console self-check line **in both modes**.
2. **`UPS_BB_GATE` wraps** — every custom inline block is wrapped `if (!window.UPS_BAREBONES) { // UPS_BB_GATE … } // UPS_BB_GATE_END`. WRAP, never top-level `return` (SyntaxError in classic scripts). Marker counts are the integrity check: **header 29/29, footer 5/5**.
3. **Static-tag conversions** — parse-time script tags can't be stopped by a runtime flag, so TOS `header.js`, the stage-6 trio (mobile_menu/module_collapse/playoff_bracket_polish), and footer's `footer.js`+`standingsColumns.js` are loaded via gated `document.write` (parser-blocking ⇒ byte-identical full-mode semantics for the unauditable TOS files).
4. **Kept static (parse-time, both modes):** `mfl_cache.js`, `reveal.js`, `mini_boxscore.js` (dormant flag), and the stage-4 modal trio (`cap_math.js`, `player_profile_master.js`, `player_popup_bridge.js`) — the modal must exist even if later blocks crash.

## Survivor / always-run allowlist (inline blocks WITHOUT gates)

| Block | Why it always runs |
|---|---|
| Legacy global shims + CCC dev-league redirect (header, first custom block) | crash prevention — MFL/legacy references expect these globals |
| TOS config bare `var`s (`UPS_USE_CUSTOM_SCOREBOARD_HPM` block) | plain top-level vars, inert once TOS is gated; wrapping would change `var` semantics |
| Offseason shim (`is_offseason` globals) | pure globals, consumers all gated |
| `UPS_USE_NATIVE_MINI_BOXSCORE` / `UPS_USE_NATIVE_PLAYER_POPUP` typeof-defaults | must exist; the guard's early `= true` wins over the typeof check |
| Footer: "Footer config kept intentionally lean" TOS vars | same rationale as the header config block |

## MFL save-time validation gotchas (learned the hard way, 2026-07-16)

MFL's Home Page Message editor runs a **server-side validator on save** that scans the RAW text — it does not parse; it substring-matches. Two rules bit us; both reject the save and silently revert to the last-good content (looks like "my paste won't stick"):

1. **No `<script>`/`</script>` inside a JS string.** `document.write('<script src="..."><\/script>')` fails — MFL sees an unbalanced `<script>` (it doesn't recognize the browser-only `<\/script>` escape as a close). **Fix:** split the keyword so no literal token exists in the source: `document.write('<scr' + 'ipt src="..."></scr' + 'ipt>')`.
2. **No `<body>`, `<html>`, or `<textarea>` (or their closers) ANYWHERE — including inside comments or strings.** MFL substring-matches, so even `/* ...the <textarea> control... */` in a CSS comment or `// MFL sets <body id="...">` in a JS comment is rejected. **Fix:** never write those tag tokens in prose; drop the angle brackets.

These predate barebones (the live header was grandfathered in before MFL tightened the check) but block ANY fresh save. Scan before every paste:
```
grep -noiE "<\s*/?\s*(body|html|textarea)\b" header_custom_v2.html footer_custom_v2.html   # must be empty
grep -n "document.write('<script"  header_custom_v2.html footer_custom_v2.html                # must be empty
```

## Maintenance rule (IMPORTANT)

**Every NEW inline block added to `header_custom_v2.html` / `footer_custom_v2.html` MUST either get the `UPS_BB_GATE` wrap or be added to the allowlist table above with a rationale.** New static `<script src>` tags use the gated `document.write` pattern. New `<style>` blocks/stylesheet links are auto-disabled by the observer (allowlist by id only if they must survive barebones). New homepage embed loaders are auto-hidden by `hideCustomHpms()` (they match the github.io selector).

## Deploy & rollback

The two root HTML files deploy ONLY via manual paste into MFL's league setup (HPM #1 header / #20 footer). Procedure: **test league L=25625 first** (Advanced Editor OFF), verify the console self-check line + the click-through matrix, then prod late-night. Keep the previous file contents open in tabs during the paste window — rollback = repaste. `site/shared/*` changes deploy via GH Pages on merge; their `?v=` stamps in the header must bump in the same PR (this PR: `mobile_menu.js` and `player_popup_bridge.js` → `2026-07-16-barebones`).

## Test matrix

Full-mode REGRESSION rows first (the tag conversion is the top risk): home / rosters O=07 / trade O=05 / standings / O=43 in BOTH modes · iPhone Safari (drawer has the Lite Mode row; pill reachable ≥44px; modal opens on tap) · toggle loop ×3 · `?ups_barebones=0` rescue + self-strip · HIDE_CUST=1 → pure stock → `=0` restores · private mode defaults OFF with the alert fallback · barebones specifics: stock skin + stock menu bar + stock footer restored, custom HPM boxes hidden, Legacy Links module intact, player click → rich modal → salary strip + contract chain render → "Open in Front Office (full site) →" exits lite mode into the FO · FOUC eyeball budget.

## Interactions

- **TOS removal (tos_removal_plan.md):** barebones forces `UPS_USE_NATIVE_PLAYER_POPUP=true` per-user ahead of the plan's Stage-5 global flip — barebones users are early adopters of the native-popup bridge. Removal stages that convert static TOS tags should preserve the gated-document.write shape.
- **`site/m/` PWA:** unaffected (separate app; barebones concerns MFL-served pages only).
- **Worker:** zero involvement.
