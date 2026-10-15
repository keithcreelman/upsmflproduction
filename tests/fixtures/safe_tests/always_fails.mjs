// Fixture for tests/safe_tests_runner.test.mjs: a test that fails on purpose.
// It is not a *.test.mjs file, so the suite never discovers it on its own.
console.log("this fixture fails on purpose");
process.exit(1);
