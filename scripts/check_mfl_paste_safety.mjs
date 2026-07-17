#!/usr/bin/env node
/**
 * check_mfl_paste_safety.mjs
 *
 * Guards the files Keith pastes BY HAND into MFL's Home Page Message fields:
 *   header_custom_v2.html, footer_custom_v2.html
 *
 * These are not deployed by CI — they are copy-pasted — so a bad save is only
 * discovered by Keith, in the browser, mid-task. Worse, MFL fails them SILENTLY
 * in one case (reverting to the last-good copy), and loudly-but-cryptically in
 * the other. Both have now bitten more than once, so they are checks, not lore.
 *
 * WHY check_inline_js.mjs did not catch this: it globs `site/ **\/ *.html` and
 * therefore never looked at the repo-root header at all. It reported "0 broken"
 * while the header carried a <body> token that MFL rejected outright.
 *
 * ── CHECK 1: banned tags (hard fail) ────────────────────────────────────────
 * MFL substring-scans the RAW TEXT of the message and rejects it with:
 *   "ERROR - MESSAGE CANNOT CONTAIN THESE TAGS: <TEXTAREA>, <BODY>, <HTML>,
 *    </TEXTAREA>, </BODY> OR </HTML>"
 * It does not parse HTML — so the token is banned EVEN INSIDE A JS/CSS COMMENT.
 * Fix: write the tag name without angle brackets ("the page body", not the tag).
 *
 * ── CHECK 2: raw non-ASCII in rendered code (hard fail) ─────────────────────
 * MFL stores/serves the pasted message as MacRoman, so raw UTF-8 is
 * reinterpreted byte-by-byte and renders as mojibake:
 *   "▾"  (e2 96 be)    -> "‚ñæ"
 *   "👤" (f0 9f 91 a4) -> "üë§"
 * Verified 2026-07-17 that this is MFL's mangling, not our clipboard: piping the
 * header through pbcopy/pbpaste round-trips byte-identical.
 * Fix: use \uXXXX escapes in JS strings — pure-ASCII source is immune. Comment
 * decoration (box-drawing, em dashes) is exempt: it never reaches the DOM.
 */
import { readFileSync, existsSync } from "node:fs";

const FILES = ["header_custom_v2.html", "footer_custom_v2.html"];

// Exactly what MFL's error message enumerates.
const BANNED = [/<\s*textarea\b/i, /<\s*\/\s*textarea\s*>/i, /<\s*body\b/i,
                /<\s*\/\s*body\s*>/i, /<\s*html\b/i, /<\s*\/\s*html\s*>/i];

// Glyphs that would be USER-VISIBLE if they reached the DOM. Box-drawing and
// em/en dashes are intentionally absent: they only ever appear in comment
// banners, and escaping them would render those unreadable.
const VISIBLE_GLYPHS = "▾▸👤🛠✓×•…";

const isCommentOnly = (line) => {
  const s = line.trim();
  return s.startsWith("//") || s.startsWith("*") || s.startsWith("/*") || s.startsWith("<!--");
};

let failures = 0;
let checked = 0;

for (const file of FILES) {
  if (!existsSync(file)) continue;
  checked += 1;
  const lines = readFileSync(file, "utf8").split("\n");

  lines.forEach((line, i) => {
    const n = i + 1;

    // CHECK 1 — banned tags, anywhere, comments included.
    for (const re of BANNED) {
      if (re.test(line)) {
        failures += 1;
        console.error(
          `${file}:${n}  BANNED TAG — MFL will reject this save outright.\n` +
          `    ${line.trim().slice(0, 100)}\n` +
          `    Fix: drop the angle brackets (write "the page body", not the tag).`
        );
      }
    }

    // CHECK 2 — raw non-ASCII on a line that renders.
    if (!isCommentOnly(line)) {
      const found = [...new Set([...line].filter((c) => VISIBLE_GLYPHS.includes(c)))];
      if (found.length) {
        failures += 1;
        const esc = found
          .map((c) => `${c} -> \\u${c.codePointAt(0).toString(16).toUpperCase().padStart(4, "0")}`)
          .join(", ");
        console.error(
          `${file}:${n}  RAW UTF-8 IN RENDERED CODE — MFL renders this as mojibake.\n` +
          `    ${line.trim().slice(0, 100)}\n` +
          `    Fix: use \\uXXXX escapes (${esc}).`
        );
      }
    }
  });
}

if (failures) {
  console.error(`\nmfl-paste-safety: ${failures} problem(s) across ${checked} file(s) — MFL would reject or mangle this paste.`);
  process.exit(1);
}
console.log(`mfl-paste-safety: ${checked} paste-file(s) checked, 0 problems`);
