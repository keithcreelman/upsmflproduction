// TEST deployment entry point (#1475), used only by wrangler.test.toml. It loads the test runtime,
// which needs AsyncLocalStorage (compatibility flag nodejs_als in wrangler.test.toml only), so the
// production entry (entry.js) never loads either.
//
//   UPS_ENV = "test"        every request and outbound call goes through test_env_runtime.js first
//   anything else           refused, including "production": this entry is never a production worker
import app from "./index.js";
import { resolveUpsEnv } from "./ups_env_guard.js";
import { handleTestFetch, handleTestScheduled } from "./test_env_runtime.js";

function refused(mode) {
  return new Response(JSON.stringify({
    ok: false,
    error: mode === "production" ? "ups_env_wrong_entry" : "ups_env_unconfigured",
    detail: "entry_test.js serves only UPS_ENV = \"test\"; this deployment refuses every request",
  }), { status: 503, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
}

export default {
  async fetch(request, env, ctx) {
    const mode = resolveUpsEnv(env);
    if (mode === "test") return handleTestFetch(request, env, ctx, app);
    return refused(mode);
  },
  async scheduled(event, env, ctx) {
    if (resolveUpsEnv(env) === "test") return handleTestScheduled(event, env, ctx);
    console.log("[ups-env] scheduled run REFUSED: entry_test.js serves only UPS_ENV = \"test\"");
  },
};
