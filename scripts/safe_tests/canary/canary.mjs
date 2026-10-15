// Guard canary (Node). run.mjs executes this under the suite's environment
// before any test; the run aborts unless every external attempt is blocked by
// the guard and loopback still works.
//
// Targets are deliberately harmless even if a guard were broken: 192.0.2.1 is
// TEST-NET-1 (RFC 5737, never routed) and .invalid never resolves (RFC 6761).
import http from "node:http";
import https from "node:https";
import net from "node:net";
import dns from "node:dns/promises";

const BLOCKED = "ESAFETESTS_NETWORK_BLOCKED";
const results = {};
async function attempt(name, fn) {
  try { await fn(); results[name] = "REACHED"; } catch (e) { results[name] = e.code === BLOCKED ? "blocked" : `unexpected: ${e.code || e.message}`; }
}

await attempt("fetch", () => fetch("http://192.0.2.1:9/canary"));
await attempt("https", () => new Promise((res, rej) => { https.get("https://safe-tests-canary.invalid/", res).on("error", rej); }));
await attempt("tcp", () => new Promise((res, rej) => { const s = net.connect(9, "192.0.2.1"); s.on("connect", res); s.on("error", rej); }));
await attempt("dns", () => dns.lookup("safe-tests-canary.invalid"));

const server = http.createServer((req, res) => res.end("loopback-ok"));
await new Promise((r) => server.listen(0, "127.0.0.1", r));
try {
  results.loopback = await (await fetch(`http://127.0.0.1:${server.address().port}/`)).text();
} catch (e) {
  results.loopback = `failed: ${e.message}`;
}
server.close();

results.guardLoaded = process.env.SAFE_TESTS_NODE_GUARD === "1";
console.log(JSON.stringify(results));
const ok = ["fetch", "https", "tcp", "dns"].every((k) => results[k] === "blocked") && results.loopback === "loopback-ok" && results.guardLoaded;
process.exit(ok ? 0 : 1);
