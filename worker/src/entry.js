// Worker entry point (#1475). Chooses how the worker runs from UPS_ENV, and nothing else.
//
//   UPS_ENV = "production"  the existing worker, unchanged: the same request, env and ctx go straight
//                           to index.js. wrangler.toml pins this value.
//   UPS_ENV = "test"        the test deployment (wrangler.test.toml): every request and outbound call
//                           goes through test_env_runtime.js first.
//   unset or anything else  every request is refused and no scheduled job runs. A deployment whose
//                           environment can't be told apart is never allowed to write anywhere.
import app from "./index.js";
import { resolveUpsEnv } from "./ups_env_guard.js";
import { handleTestFetch, handleTestScheduled } from "./test_env_runtime.js";

function unconfigured() {
  return new Response(JSON.stringify({
    ok: false,
    error: "ups_env_unconfigured",
    detail: "UPS_ENV must be exactly \"production\" or \"test\"; this deployment refuses every request until it is",
  }), { status: 503, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
}

export default {
  async fetch(request, env, ctx) {
    const mode = resolveUpsEnv(env);
    if (mode === "production") return app.fetch(request, env, ctx);
    if (mode === "test") return handleTestFetch(request, env, ctx, app);
    return unconfigured();
  },
  async scheduled(event, env, ctx) {
    const mode = resolveUpsEnv(env);
    if (mode === "production") return app.scheduled(event, env, ctx);
    if (mode === "test") return handleTestScheduled(event, env, ctx);
    console.log("[ups-env] scheduled run REFUSED: UPS_ENV is not set to production or test");
  },
};
