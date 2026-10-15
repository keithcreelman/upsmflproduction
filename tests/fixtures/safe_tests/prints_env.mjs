// Fixture for tests/safe_tests_runner.test.mjs: prints the environment variable
// names the suite handed this test, and whether the network guard is loaded.
console.log("SAFE_TESTS_ENV " + JSON.stringify({ keys: Object.keys(process.env).sort(), guard: process.env.SAFE_TESTS_NODE_GUARD === "1" }));
