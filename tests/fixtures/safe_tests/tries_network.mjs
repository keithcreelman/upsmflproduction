// Fixture for tests/safe_tests_runner.test.mjs: a test that passes but quietly
// tries to reach an external host and swallows the error -- the hidden-network
// case. 192.0.2.1 is TEST-NET-1 (RFC 5737): never routed, harmless if reached.
try { await fetch("http://192.0.2.1:9/hidden-dependency"); } catch { /* swallowed on purpose */ }
console.log("this fixture passes, but it tried the network");
