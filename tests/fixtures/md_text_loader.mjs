// Node ESM loader hooks: import "x.md" as a default-exported string, exactly what
// Wrangler's text-module rule does for worker/src/anthropic_explain.js.
import fs from "node:fs";
import { fileURLToPath } from "node:url";
export async function load(url, context, nextLoad) {
  if (url.endsWith(".md")) {
    const text = fs.readFileSync(fileURLToPath(url), "utf8");
    return { format: "module", source: `export default ${JSON.stringify(text)};`, shortCircuit: true };
  }
  return nextLoad(url, context);
}
