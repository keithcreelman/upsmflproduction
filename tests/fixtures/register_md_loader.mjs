// Import this (dynamically, before importing worker code) so worker modules that
// `import x from "*.md"` load under plain Node.
import { register } from "node:module";
register("./md_text_loader.mjs", import.meta.url);
