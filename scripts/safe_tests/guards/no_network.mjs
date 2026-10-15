// Safe offline suite -- loopback-only network guard for Node.
//
// scripts/safe_tests/run.mjs loads this into EVERY Node process it starts via
// NODE_OPTIONS=--import=<this file>, so child `node` processes inherit it too.
// It is one layer of several (see docs/SAFE_TESTS.md): the runner also scrubs
// the environment (no secrets, a throwaway HOME), shadows network/credential
// CLIs on PATH, and in GitHub Actions runs the whole suite inside a network
// namespace that has no interface except loopback.
//
// What it does: any attempt to reach a host that is not loopback (fetch, http,
// https, tls, net, http2, dns, udp) fails the way a dead network fails -- an
// error on the socket or a rejected promise -- with a message that names the
// target. Loopback stays open so tests can run local fixture servers.
// Every blocked attempt is appended to $SAFE_TESTS_BLOCK_LOG so the runner can
// report which test tried to leave the machine even if the test swallowed the
// error.

import fs from "node:fs";
import net from "node:net";
import dns from "node:dns";
import dgram from "node:dgram";
import { syncBuiltinESMExports } from "node:module";

const LOOPBACK_NAMES = new Set(["localhost", "ip6-localhost", "ip6-loopback"]);

// True only for the names above or a literal loopback / unspecified IP address.
// The IP must parse first: a prefix test alone would also wave through a real
// hostname such as 127.example.com.
export function isLoopbackHost(host) {
  if (host === undefined || host === null || host === "") return true; // net defaults to localhost
  let h = String(host).trim().toLowerCase();
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
  if (LOOPBACK_NAMES.has(h)) return true;
  const family = net.isIP(h.split("%")[0]);
  if (family === 4) return h.startsWith("127.") || h === "0.0.0.0";
  if (family === 6) return ["::1", "::", "0:0:0:0:0:0:0:1", "0:0:0:0:0:0:0:0"].includes(h) || /^::ffff:127\.\d+\.\d+\.\d+$/.test(h);
  return false;
}

function record(what, target) {
  const line = JSON.stringify({ lang: "node", pid: process.pid, what, target, argv1: process.argv[1] || "" });
  process.stderr.write(`[safe-tests] BLOCKED ${what} -> ${target}\n`);
  const log = process.env.SAFE_TESTS_BLOCK_LOG;
  if (log) {
    try { fs.appendFileSync(log, line + "\n"); } catch { /* never let logging change test behavior */ }
  }
}

function blockedError(what, target) {
  const err = new Error(
    `[safe-tests] network blocked: ${what} -> ${target}. The safe offline suite allows loopback only. ` +
      "A test that needs the network is not an offline test: stub the call, or exclude the file in " +
      "tests/safe_suite.json with a named reason."
  );
  err.code = "ESAFETESTS_NETWORK_BLOCKED";
  return err;
}

// Strip query strings and credentials from anything we print or log.
function describeUrl(u) {
  try {
    const url = new URL(u);
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return String(u).split("?")[0].slice(0, 200);
  }
}

// ---- fetch -----------------------------------------------------------------
// The socket patch below already stops undici, but checking the URL first gives
// the test a readable error instead of a bare "fetch failed".
const realFetch = globalThis.fetch;
if (typeof realFetch === "function") {
  globalThis.fetch = function safeTestsFetch(input, init) {
    let raw;
    try {
      raw = typeof input === "string" ? input : input instanceof URL ? input.href : input && input.url;
    } catch { raw = undefined; }
    if (raw) {
      let url = null;
      try { url = new URL(raw); } catch { url = null; }
      if (url && (url.protocol === "http:" || url.protocol === "https:" || url.protocol === "ws:" || url.protocol === "wss:") && !isLoopbackHost(url.hostname)) {
        const target = describeUrl(raw);
        record("fetch", target);
        return Promise.reject(blockedError("fetch", target));
      }
    }
    return realFetch.call(this, input, init);
  };
}

// ---- TCP / TLS / HTTP / HTTP2 (all go through net.Socket#connect) -----------
function connectTarget(args) {
  let a0 = args[0];
  // net.connect() normalizes its arguments into an array before calling
  // socket.connect(normalized); unwrap it.
  if (Array.isArray(a0)) a0 = a0[0];
  if (a0 && typeof a0 === "object") {
    if (a0.path) return { local: true };
    return { host: a0.host ?? a0.hostname ?? "localhost", port: a0.port };
  }
  if (typeof a0 === "string" && !/^\d+$/.test(a0)) return { local: true }; // unix socket / pipe path
  const host = typeof args[1] === "string" ? args[1] : "localhost";
  return { host, port: a0 };
}

const realConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function safeTestsConnect(...args) {
  const t = connectTarget(args);
  if (!t.local && !isLoopbackHost(t.host)) {
    const target = `${t.host}:${t.port}`;
    record("socket.connect", target);
    const err = blockedError("socket.connect", target);
    process.nextTick(() => this.destroy(err));
    return this;
  }
  return realConnect.apply(this, args);
};

// ---- DNS ---------------------------------------------------------------------
// A lookup is itself egress (it tells a resolver what we are about to call).
function guardDnsCallback(name, real) {
  return function safeTestsDns(hostname, ...rest) {
    if (!isLoopbackHost(hostname)) {
      record(`dns.${name}`, String(hostname));
      const cb = rest.findLast((x) => typeof x === "function");
      const err = blockedError(`dns.${name}`, String(hostname));
      if (cb) { process.nextTick(() => cb(err)); return undefined; }
      throw err;
    }
    return real.call(this, hostname, ...rest);
  };
}
function guardDnsPromise(name, real) {
  return function safeTestsDnsPromise(hostname, ...rest) {
    if (!isLoopbackHost(hostname)) {
      record(`dns.promises.${name}`, String(hostname));
      return Promise.reject(blockedError(`dns.promises.${name}`, String(hostname)));
    }
    return real.call(this, hostname, ...rest);
  };
}
const DNS_FNS = ["lookup", "lookupService", "resolve", "resolve4", "resolve6", "resolveAny", "resolveCname", "resolveMx", "resolveNs", "resolveTxt", "resolveSrv", "resolveNaptr", "resolvePtr", "resolveSoa", "resolveCaa", "reverse"];
for (const fn of DNS_FNS) {
  if (typeof dns[fn] === "function") dns[fn] = guardDnsCallback(fn, dns[fn]);
  if (dns.promises && typeof dns.promises[fn] === "function") dns.promises[fn] = guardDnsPromise(fn, dns.promises[fn]);
}
if (dns.Resolver) {
  for (const fn of DNS_FNS) {
    if (typeof dns.Resolver.prototype[fn] === "function") dns.Resolver.prototype[fn] = guardDnsCallback(fn, dns.Resolver.prototype[fn]);
  }
}

// ---- UDP -----------------------------------------------------------------------
const realUdpConnect = dgram.Socket.prototype.connect;
dgram.Socket.prototype.connect = function safeTestsUdpConnect(port, address, cb) {
  const host = typeof address === "string" ? address : "localhost";
  if (!isLoopbackHost(host)) {
    record("udp.connect", `${host}:${port}`);
    throw blockedError("udp.connect", `${host}:${port}`);
  }
  return realUdpConnect.call(this, port, address, cb);
};
const realUdpSend = dgram.Socket.prototype.send;
dgram.Socket.prototype.send = function safeTestsUdpSend(...args) {
  const host = args.slice(1).find((x) => typeof x === "string");
  if (host !== undefined && !isLoopbackHost(host)) {
    record("udp.send", host);
    throw blockedError("udp.send", host);
  }
  return realUdpSend.apply(this, args);
};

// Make `import { lookup } from "node:dns"` (ESM named bindings) see the patches.
syncBuiltinESMExports();

process.env.SAFE_TESTS_NODE_GUARD = "1";
