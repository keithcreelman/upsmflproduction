// Worker entry point (#1475). Chooses how the worker runs from UPS_ENV, and nothing else.
//
//   UPS_ENV = "production"  the existing worker, unchanged: the same request, env and ctx go straight
//                           to index.js. wrangler.toml pins this value.
//   UPS_ENV = "test"        refused here: a test deployment must use entry_test.js (wrangler.test.toml),
//                           which wraps every request and outbound call. This file never loads that code.
//   unset or anything else  every request is refused and no scheduled job runs. A deployment whose
//                           environment can't be told apart is never allowed to write anywhere.
import app from "./index.js";
import { resolveUpsEnv } from "./ups_env_guard.js";

function unconfigured(error, detail) {
  return new Response(JSON.stringify({ ok: false, error, detail }),
    { status: 503, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
}
const UNSET = ["ups_env_unconfigured", "UPS_ENV must be exactly \"production\" for this entry; this deployment refuses every request until it is"];
const WRONG_ENTRY = ["ups_env_wrong_entry", "UPS_ENV is \"test\" but this is the production entry; a test deployment must use src/entry_test.js"];

export default {
  async fetch(request, env, ctx) {
    const mode = resolveUpsEnv(env);
    if (mode === "production") return app.fetch(request, env, ctx);
    return unconfigured(...(mode === "test" ? WRONG_ENTRY : UNSET));
  },
  async scheduled(event, env, ctx) {
    const mode = resolveUpsEnv(env);
    if (mode === "production") return app.scheduled(event, env, ctx);
    console.log(`[ups-env] scheduled run REFUSED: ${mode === "test" ? "test deployments use entry_test.js" : "UPS_ENV is not \"production\""}`);
  },
};
