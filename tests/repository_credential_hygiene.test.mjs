// REPOSITORY CREDENTIAL HYGIENE: no MFL API key, MFL session cookie or hard-coded key fallback may be committed (containment, 2026-11-21).
//   node tests/repository_credential_hygiene.test.mjs
// It scans every tracked file (except tests/, whose values are synthetic) for credential-shaped values and prints only file paths and counts, never a value.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { t, test, run } from "./fixtures/mini_test.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const files = execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, maxBuffer: 256 * 1024 * 1024 }).toString("utf8").split("\0").filter(Boolean);
const TEXT = /\.(js|mjs|cjs|ts|py|json|md|txt|html|csv|yml|yaml|toml|sh|sql|xml|env|ini|cfg)$/i;
const RULES = [
  ["an MFL API key in a URL or parameter", /APIKEY=[A-Za-z0-9+/=%]{20,}/g],
  ["an MFL session cookie", /MFL_USER_ID=[A-Za-z0-9+/=%]{20,}/g],
  ["a hard-coded key fallback", /environ\.get\(\s*["']MFL_APIKEY["']\s*,\s*["'][A-Za-z0-9+/=]{20,}["']\s*\)/g],
  ["a hard-coded key in a JSON field", /"(?:api_?key|apikey|key20\d\d)"\s*:\s*"[A-Za-z0-9+/=]{24,}"/gi],
  ["a hard-coded fallback for any credential-named variable", /environ\.get\(\s*["'][A-Z0-9_]*(?:KEY|COOKIE|TOKEN|SECRET|PASSWORD|USER_ID)[A-Z0-9_]*["']\s*,\s*["'][A-Za-z0-9+/=_.-]{20,}["']/g],
  ["an MFL user id (session token) in a JSON field", /"(?:submitted_by_)?mfl_user_id"\s*:\s*"[A-Za-z0-9+/=%]{16,}"/gi],
  ["an MFL session token in a submitter label", /"submitted_by_label"\s*:\s*"[^"]*MFL [A-Za-z0-9+/=%]{16,}/g],
];

test("no tracked file holds an MFL key or session cookie (tests/ hold synthetic values only)", () => {
  const hits = [];
  for (const f of files) {
    if (f.startsWith("tests/") || !TEXT.test(f)) continue;
    let s; try { s = fs.readFileSync(path.join(ROOT, f), "utf8"); } catch { continue; }
    for (const [label, rx] of RULES) { const n = (s.match(rx) || []).length; if (n) hits.push(`${f}: ${n} x ${label}`); }
  }
  t.deepEqual(hits, [], "credential-shaped values found (paths and counts only)");
});

test("no key file is tracked", () => {
  t.deepEqual(files.filter((f) => /(^|\/)apikeys?[^/]*\.json$/i.test(f)), []);     // saved api_info pages are checked by content above
});

await run("repository_credential_hygiene");
