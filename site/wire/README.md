# UPS Wire

The league's published-content hub: season reviews, weekly recaps and previews,
one-off features, and the trade-bot archive.

## One file, three surfaces

Every article is a **self-contained HTML document**. The same file renders:

1. **Inside MFL** — `?MODULE=MESSAGE19&hub=wire`, fetched and `srcdoc`'d by
   `mfl_hpm_embed_loader.js`.
2. **At its own public URL** — `https://keithcreelman.github.io/upsmflproduction/wire/articles/2026/<id>.html`,
   which is what you paste into Discord.
3. **As a Claude Artifact** — paste the file's source in and it renders.

That is why the CSS is inlined rather than `<link>`ed (an Artifact has no
network), and why there is no build framework (Pages just copies `site/`).

## How it fits together

```
MFL page  --  mfl_hpm_embed_loader.js   (same-origin: owns the hash, localStorage, scroll memory)
    +-- iframe  (srcdoc, sandboxed, no allow-same-origin)
          = index.html         <- the index; wire_shell.js renders it from index.json
            OR
            articles/<season>/<id>.html   <- one article, fully self-contained
```

**One iframe, not two.** The loader swaps what the frame holds when you cross
the index/article boundary. Navigation *within* the shell (front page to a
section) and *within* an article (section to section) never reloads — the
document handles it and just tells the loader the new route so the MFL address
bar tracks it.

**The frame is sandboxed** because article HTML is model-generated from Phase 3
onward; sandboxed, it cannot read MFL cookies or act as the logged-in owner.
The cost is an opaque origin — no `localStorage`, no `history` inside the frame
— so both live in the loader.

**Routes** live in the top-level URL hash (`#/a/<id>/<sectionId>`). The hash
never reaches MFL's server, so it cannot be stripped or normalized away by a
redirect. `?wire=<route>` is accepted for hand-written links but never written.

## The five hard rules

1. **No `href="#..."` anywhere.** Inside a `srcdoc` document with a `<base>`, a
   fragment link resolves *against the base* and navigates the frame to
   jsDelivr — which serves `.html` as `text/plain`, so the article turns into a
   wall of source code. Use `<button>` plus a data attribute.
2. **No `vh` / `svh` / `dvh` units.** In an auto-sized iframe `100vh` equals the
   height we just set, so the frame grows on every beacon tick, forever. `vw`
   is fine. (The reference artifact had `min-height:100vh`; it was dropped
   deliberately, and `html { background: var(--ground) }` covers the standalone
   case.)
3. **No `<script type="application/json">` data islands.** `scripts/check_inline_js.mjs`
   runs `node --check` on *every* inline block regardless of `type`, and a
   top-level JSON object is a `SyntaxError` (a top-level JSON *array* happens to
   pass, which makes this worse, not better). This is why `index.json` is a
   fetched file.
4. **No webfonts.** System stack only — a CDN `<link>` breaks in Artifacts and
   is a CSP and privacy liability.
5. **Never write the literal string `<script` outside a script block** — not in
   prose, not in markup, not in an HTML comment. The linter's regex does not
   understand HTML comments, so a stray `<script` opens a *phantom* block that
   runs to the next real `</script>` and reports working code as broken (or,
   worse, skips a real block). Write `&lt;script` in prose instead.
   Inside a block's own `/* */` comment it is harmless — the regex has already
   consumed that text — which is why `article_runtime.js` may discuss the tag
   freely but `article_skeleton.html.tmpl` may not, and carries a `.tmpl`
   extension to stay out of the `site/**/*.html` glob entirely.

Rules 1, 2, 3 and 5 all become CI checks in Phase 1.5.

## Prose never touches a JS parser

`check_inline_js.mjs` exists because one unescaped apostrophe in a tooltip
string shipped Commish Settings broken for hours. A hub whose entire purpose is
league prose is exactly the thing that breaks it, so the design routes around it
structurally rather than by discipline:

- Article titles, deks and body copy live in **markup** and in **`index.json`**.
- Shell logic is **external** (`wire_shell.js`), so `index.html` has zero inline JS.
- The one inlined per-article script (`article_runtime.js`) is **prose-free and
  byte-identical** in every article, so it is reviewed once and cannot regress
  per-article.
- All rendered text goes through `textContent`. Nothing concatenates data into
  an HTML string.

## Files

| File | Role |
|---|---|
| `mfl_hpm_embed_loader.js` | The only file the header knows about. Context resolution + router + beacon injection. |
| `index.html` | The index shell. Head, three `<link>`s, one `<script src>`, empty mounts. |
| `wire_shell.js` | Front page / family / archive renderers. Never renders an article. |
| `wire_tokens.css` | **SSOT for the palette.** Inlined into every article. |
| `wire_article.css` | Article components. Inlined into every article. |
| `wire_shell.css` | Index chrome only. Never inlined. |
| `index.json` | Article registry: families, articles, sections, content hashes. |
| `articles/_template/` | The canonical article skeleton and the shared runtime. |
| `articles/<season>/` | The articles themselves. |

## The toolchain

Three commands, stdlib-only, invoked by path (this repo has no Python packages,
so `python -m` is not the local convention):

```bash
python pipelines/etl/wire/wire.py restyle
```
Re-inlines `wire_tokens.css` + `wire_article.css` and `article_runtime.js` into
every article and re-stamps `data-wire-style-sha`. Run it after touching any of
those three files.

```bash
python pipelines/etl/wire/wire.py index
```
Rebuilds `index.json` from the article files. Run it after `restyle`, and after
adding or editing any article.

```bash
python pipelines/etl/wire/wire.py verify
```
What CI runs. Fails on a stale style sentinel, drifted runtime, any of the five
hard rules, a `sections[]` mismatch, a stale `contentHash`, an unknown
`familyId`, an invalid `status`, an unindexed article, a missing `wire-meta`
block, or an article over the srcdoc size limit.

### Where article metadata lives

**The article files are the source of truth; `index.json` is derived.** Title,
kicker, dek, sections and read time are read out of the markup. Everything else
lives in a `wire-meta` comment inside the article, so metadata travels with the
file to all three surfaces:

```html
<!--wire-meta
  familyId: season-review
  season: 2026
  week:
  status: live
  publishedAt: 2026-08-15T13:00:00Z
  tags: auction, cap
  heroValue: 12
  heroLabel: verdicts
-->
```

The one exception is `families[]`, which is curated by hand in `index.json` and
preserved across regeneration.

### Adding an article

1. Copy `articles/_template/article_skeleton.html.tmpl` to
   `articles/<season>/<id>.html`. The filename stem becomes the article `id`,
   and ids are permanent — never reuse one.
2. Write the content. Fill in the `wire-meta` block. Leave the `<style>` and
   `<script data-wire-runtime>` bodies empty; `restyle` fills them.
3. `restyle`, then `index`, then `verify`.

`status: draft` keeps an article out of the index until you flip it to `live` —
which is deliberately a separate commit, so a merge for preview is not a publish.

## Deploy notes

- **`purge-jsdelivr.yml` is deliberately untouched.** No MESSAGE19 hub
  (`auction`, `commish`, `gameday`) is in that list — they resolve at
  `window.UPS_RELEASE_SHA`, so their URLs are immutable and self-busting.
  Adding entries would only raise that workflow's throttle-failure risk.
- **Two path shapes for the same file.** jsDelivr keeps the `/site/` prefix;
  GitHub Pages strips it. Never hardcode either — derive from
  `document.baseURI`. `UPS_WIRE_PAGES_BASE` in the loader is the single
  exception and the single place the Pages shape is written down.
- **`header_custom_v2.html` is a manual paste.** After merging any header
  change, hand Keith the new copy.
