// MFL 2.0 (Release 1) configuration. The test-site build (scripts/test_env/build_test_site.mjs) fills both
// placeholders: the TEST worker and the TEST league. This app never names the production league or worker.
window.UPS2_CONFIG = Object.freeze({
  worker: "__UPS_TEST_WORKER__",
  league: "__UPS_TEST_LEAGUE__",
  release: "r1-2026-11-26",
});
