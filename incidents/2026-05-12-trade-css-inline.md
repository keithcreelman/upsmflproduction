# Trade War Room CSS inlined — 2026-05-12

## Problem

The Trade War Room iframe loads `cdn.jsdelivr.net/gh/keithcreelman/upsmflproduction@main/site/trades/trade_workbench.html`. jsDelivr serves any `.html` file with `Content-Type: text/plain; charset=utf-8` + `X-Content-Type-Options: nosniff`.

In that combination, modern browsers parse the document's markup (so headers and form controls do render) but **do not apply `<link rel="stylesheet">` references** — the doc is treated as plain text for stylesheet-loading purposes. Result: the Trade War Room renders with default browser styling — unstyled, flat, no card layout.

Keith hit this on 2026-05-12 after the PR #65 revert. Screenshot showed all UPS Trade Workflow text content but with default browser styling — no `.twb-*` classes applying.

Verified live with curl:

```
$ curl -sI 'https://cdn.jsdelivr.net/gh/keithcreelman/upsmflproduction@main/site/trades/trade_workbench.html'
HTTP/2 200
content-type: text/plain; charset=utf-8
x-content-type-options: nosniff
```

## Why other hubs don't have this

Rookie Draft Hub's loader (`site/rookies/mfl_hpm_embed_loader.js`) fetches its HTML as text via `fetch()` (which ignores Content-Type), injects `<base href>` + context globals, and renders into the iframe via `srcdoc`. Bypasses the entire Content-Type chain.

The previous attempt to do the same for Trade Workbench (PR #64, 2026-05-11) broke because `trade_workbench.js` reads `window.location.search` extensively — and `srcdoc` iframes have `window.location === "about:srcdoc"` with no query string. PR #65 reverted to `iframe.src`.

## Fix applied 2026-05-12

Inlined `trade_workbench.css` (41 KB, 2253 lines) into a `<style>` block inside `trade_workbench.html`. The HTML went from 11 KB to 53 KB.

Browsers render the inline `<style>` regardless of the document's Content-Type, so the CSS now applies even when jsDelivr serves the HTML as text/plain.

## Source-of-truth rule going forward

**`site/trades/trade_workbench.css` is still the canonical CSS source.** Any change to styling MUST:

1. Edit `trade_workbench.css` as usual.
2. Re-inline the file into `trade_workbench.html`'s `<style id="twbInlinedCss">` block.

A simple shell one-liner does the re-inline:

```bash
python3 - <<'PY'
from pathlib import Path
html = Path("site/trades/trade_workbench.html").read_text()
css = Path("site/trades/trade_workbench.css").read_text()
import re
new = re.sub(
    r'(<style id="twbInlinedCss"[^>]*>).*?(</style>)',
    lambda m: m.group(1) + "\n" + css.rstrip() + "\n  " + m.group(2),
    html, count=1, flags=re.DOTALL)
Path("site/trades/trade_workbench.html").write_text(new)
print("CSS re-inlined")
PY
```

A future task (post-May-24) is to wire this into CI as a check: fail the build if `trade_workbench.css` content differs from the inlined `<style>` block in `trade_workbench.html`.

## Files changed

- `site/trades/trade_workbench.html` — `<link rel="stylesheet">` replaced with inline `<style>` block.

## Files NOT changed

- `site/trades/trade_workbench.css` — kept as canonical source.
- `site/trades/trade_workbench.js` — untouched (window.location.search reads still work because we still use `iframe.src`, not `srcdoc`).
- `site/trades/mfl_hpm_embed_loader.js` — untouched.
- Worker — untouched.

## Verification

Before deploy: load the inlined HTML locally via `python3 -m http.server -d site/trades` and verify styling.

After deploy: purge jsDelivr cache (`curl -X POST https://purge.jsdelivr.net/gh/keithcreelman/upsmflproduction@<new-sha>/site/trades/trade_workbench.html`) and hard-refresh the MFL Trade War Room screen.

## Rollback

Single-file revert. If anything goes wrong, `git checkout flashpoint-2026-05-12-pre-audit -- site/trades/trade_workbench.html` restores the pre-inline version.
