# Rosters Fork — TOS-Global Dependency Audit (Stage 8c)

**Created:** 2026-05-20
**Scope:** `site/rosters/mflscripts_rosters_fork.js` — UPS's forked copy of TOS's
rosters/script.js, hosted at GH Pages and loaded with `load_rosters_script=false`
in `footer_custom_v2.html:113`.
**Why:** Before deleting TOS's footer.js (Stage 10), we need to confirm our fork
doesn't rely on globals that footer.js sets up at runtime. The plan §3 Stage 8
flagged the audit; this doc closes it.

## Method

Grep the fork for the TOS-global call signatures that header.js/footer.js
expose to other TOS scripts. Patterns checked:

- `MFLCache.*` — TOS's cache surface (now ours, but the fork might use it)
- `report*API` (`reportInjuriesAPI`, `reportRostersAPI`, `reportTransactionsAPI`,
  `reportProjectedScoresAPI`, etc.) — the TOS API wrappers from lessons §1j
- `timeFrame` — TOS's anti-flicker reveal default (lessons §3)
- `MFL_customTabs*` / `FakeTabs` — the tabs API we already shim as no-ops
- `jQuery(window)` — TOS's typical jQuery bootstrap hooks

## Result

```bash
grep -nE "MFLCache|report.*API|timeFrame|MFL_customTabs|jQuery\(window\)" \
  site/rosters/mflscripts_rosters_fork.js
```

**Zero hits.** The fork is **clean** of TOS-global dependencies.

## Implication for Stage 10

Removing TOS's `footer.js` `<script src>` tag will NOT break the rosters fork.
The fork only requires:
- jQuery (provided by MFL itself, not TOS — confirmed in `mfl_page_html_inventory.md:93`)
- MFL's `/export` endpoint via fetch (now wrapped by our `MFLCache` 429-guard)
- DOM hooks on `body#body_options_07` (MFL native rosters page) — survives TOS removal

No refactor required pre-Stage 10. The fork stays as-is.

## Note for future ports

If a future rosters-fork refactor wants to:
- **Adopt our new `MFLCache`** — that's an upgrade path, not a dependency. The
  fork currently uses ad-hoc localStorage; calling `MFLCache.set(MFLCache.KEY.rosters(year, lid), data, MFLCache.TTL.SIX_HOUR)` would dedupe across tabs.
- **Adopt our `UPSReveal`** — same pattern for anti-flicker; would replace any
  ad-hoc `setTimeout` reveal in the fork.

Both are improvements, neither required.

---

**Stage 8c CLOSED.** No rosters-fork changes needed for TOS removal.
