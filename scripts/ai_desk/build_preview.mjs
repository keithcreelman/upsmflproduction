#!/usr/bin/env node
// Builds ONE self-contained file for the Commissioner Desk fixture preview:
//   site/commish/desk/desk_preview.single.html
// It inlines desk.css, desk_render.js, desk.js and every fixture card, so the page makes no request of any kind
// (safe to publish as a private page and to open from a phone). Offline: reads local files only.
//
//   node scripts/ai_desk/build_preview.mjs            write the file
//   node scripts/ai_desk/build_preview.mjs --check    exit 1 if the file on disk is stale
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const dir = path.join(root, "site", "commish", "desk");
const read = (p) => readFileSync(path.join(dir, p), "utf8");

// Text placed inside <script> or <style> must not be able to close the element or open a comment.
const safeScript = (s) => s.replace(/<\/(script)/gi, "<\\/$1").replace(/<!--/g, "<\\!--");
const safeStyle = (s) => s.replace(/<\/(style)/gi, "<\\/$1");
const safeJson = (o) => JSON.stringify(o).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");

export function buildPreview() {
  let html = read("desk_preview.html");
  const dq = JSON.parse(read("fixtures/demo_questions.json"));
  const cards = {};
  for (const name of dq.cards) cards[name] = JSON.parse(read(`fixtures/cards/${name}.json`));
  const data = { questions: dq.questions, cards, fallback: dq.fallback };

  const swap = (needle, replacement) => {
    if (!html.includes(needle)) throw new Error(`desk_preview.html is missing: ${needle}`);
    html = html.replace(needle, () => replacement);
  };
  swap('<link rel="stylesheet" href="desk.css">', `<style>\n${safeStyle(read("desk.css"))}\n</style>`);
  swap('<script src="desk_render.js"></script>', `<script>\n${safeScript(read("desk_render.js"))}\n</script>`);
  swap('<script src="desk.js"></script>', `<script>\n${safeScript(read("desk.js"))}\n</script>\n<script>window.UPS_DESK_FIXTURES = ${safeJson(data)};</script>`);
  return html;
}

const out = path.join(dir, "desk_preview.single.html");
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const html = buildPreview();
  if (process.argv.includes("--check")) {
    if (!existsSync(out) || readFileSync(out, "utf8") !== html) { console.error("desk_preview.single.html is stale: run node scripts/ai_desk/build_preview.mjs"); process.exit(1); }
    console.log("desk_preview.single.html is up to date");
  } else {
    writeFileSync(out, html);
    console.log(`wrote ${path.relative(root, out)} (${html.length} bytes)`);
  }
}
