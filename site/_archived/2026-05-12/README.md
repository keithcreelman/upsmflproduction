# Archive — 2026-05-12

This directory holds source files for hubs that were retired from the live UPS MFL site on 2026-05-12. The files are kept in git history forever; this directory makes the deprecation explicit and reversible.

## What was archived

### `ccc/` — Contract Command Center (retired)

UI for owner contract submissions: MYM bids, extensions, restructures, tag submissions, cap penalty display. Per Keith: "Get Rid of CCC archive it. We use Front Office now for tagging and extensions" (2026-05-12).

The actual submission workflow path:

> Roster Workbench (`site/rosters/roster_workbench.js:10363` `submitExtensionUpdate`) → Worker `/commish-contract-update` (and `/offer-restructure`, `/offer-mym`).

Roster Workbench has been doing this work for owners with `source: "front-office-extension-submit"` as the payload tag. CCC was redundant.

**Files moved:**
- `ccc.css`, `ccc.js` — main hub
- `ccc_latest.js`, `ccc_latest.json`, `ccc_release_log.json` — release tracking
- `ccc_contracts.svg` — graphic
- `mfl_hpm16_contractcommandcenter.html` — iframe HTML
- `mfl_hpm_embed_loader.js` — HPM shim
- `mym_dashboard.json`, `mym_submissions.json`, `restructure_submissions.json` — submission caches (now stale)
- `player_points_history.json` — duplicate of `site/rosters/player_points_history.json`

**Files NOT moved (still live at `site/ccc/`):**
- `tag_tracking.json` — Roster Workbench reads this from `site/ccc/tag_tracking.json`
- `tag_submissions.json` — Roster Workbench reads this from `site/ccc/tag_submissions.json`

If you ever move those two, update `site/rosters/roster_workbench.js` lines 2618/2641 to match.

### `acquisition/` — Acquisition Hub (retired)

UI for FA Auction live + ERA (Expired Rookie Auction) + waivers + rookie draft live view. Per Keith: "Get rid of this Acquisition Hub We'll need an Auction Hub eventually but we have time we won't have it in time for the ERA at least I doubt it, maybe an MVP but not mandatory" (2026-05-12).

A clean Auction Hub is planned post-2026 rookie draft (May 24). Rookie draft live view is covered by Rookie Draft Hub.

**Files moved (whole directory):**
- `acquisition_hub.{html,js,css}`, `mfl_hpm_embed_loader.js`
- `lib/refresh_manager.js`
- `modules/{rookie_draft,free_agent_auction,expired_rookie_auction,waiver_lab}.js`
- `manifest.json`
- `expired_rookie_history.json`, `free_agent_auction_history.json`, `rookie_draft_history.json`, `waiver_history.json` — historical records (still in git history if needed for analytics)

### `hpm-ccc.html` (partial)

Used by `site/loader.js` PARTIAL_MAP to bootstrap the CCC iframe on MESSAGE2 pages. No longer reachable — the PARTIAL_MAP entry has been removed.

## What was NOT archived (intentional)

- **`site/ccc/tag_tracking.json`** — Roster Workbench reads it.
- **`site/ccc/tag_submissions.json`** — Roster Workbench reads it.
- **Worker `/api/contract-dashboard`, `/offer-mym`, `/offer-restructure`, `/commish-contract-update`, `/acquisition-hub/*`** — kept live. Roster Workbench depends on the first four; Acquisition routes are dormant (no UI consumer) but not removed pre-draft.
- **`pipelines/etl/scripts/build_acquisition_hub_artifacts.py`** — kept for historical CSV/JSON generation; can be retired post-draft.

## Header HTML changes

Two early-return short-circuits in `apps/mfl_site/header_custom_v2.html`:

- CCC IIFE at line ~1847 — `return;` immediately, before any CCC autoload.
- Acquisition IIFE at line ~2755 — same.

The rest of each IIFE (normalizers, observers, etc.) is left intact so a single-line revert restores the behavior if anything depends on those side effects.

## How to revert

```bash
git revert <archive-commit-sha>
# OR for surgical revert:
git mv site/_archived/2026-05-12/ccc/* site/ccc/
git mv site/_archived/2026-05-12/acquisition site/acquisition
git mv site/_archived/2026-05-12/hpm-ccc.html site/hpm-ccc.html
# Then remove the `return;` short-circuits from header_custom_v2.html
# and restore the "hpm-ccc" entry in site/loader.js PARTIAL_MAP.
```

## Deployment note

`apps/mfl_site/header_custom_v2.html` is **NOT** auto-deployed by git push. Keith must paste the updated file into MFL Commissioner → Settings → Appearance → Header Custom for the early-returns to take effect on the live site. Until the paste, CCC and Acquisition continue to autoload — but the underlying source files are now gone from their old locations, so the loaders will hit 404s on jsDelivr.

**Order of operations on deploy:**
1. Merge this PR to main.
2. **Immediately** paste the new header HTML into MFL site customization to stop the dead loaders from firing.
3. jsDelivr purge: `curl -X POST https://purge.jsdelivr.net/gh/keithcreelman/upsmflproduction@main` (so the new tree is served).

If step 2 lags significantly behind step 1, owners will see CCC and Acquisition Hub iframes go to "Failed to load" until the new header lands.
