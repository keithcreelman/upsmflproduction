/* UPS 2027 Preview 0 settings. Public values only: the worker address is already in every page of the current app.
   Nothing here is a key, token or session. The season is fixed for this preview; it is not read from the phone or the address.
   data: "recorded" answers every read from the snapshot bundled with the page (recorded_data.js) and makes no data request;
   "live" reads the public routes of the worker, which needs Keith's separate approval. */
window.UPS2027_CONFIG = {
  workerBase: "https://upsmflproduction.keith-creelman.workers.dev",
  leagueId: "74598",
  season: "2026",
  build: "preview0.2",
  data: "recorded",
  mode: "preview" // the one build mode that exists; the build refuses any other (a Test build is a later, separately approved stage)
};
