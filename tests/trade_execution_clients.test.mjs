// What the OWNER is told about an accept / a held trade — the shared view (site/shared/trade_3way_view.js) and its two callers.
//   node tests/trade_execution_clients.test.mjs
//
//   1. an accept is one of THREE different truths: executed · executed but its contract step needs the commissioner · not executed / unconfirmed
//   2. a 3-way that every team accepted but the salary cap is holding shows WHO and HOW MUCH, keeps the accepts, and offers a Re-check
//   3. both callers (mobile + desktop) actually route through those readings, and the build stamps agree
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { t, test, run } from "./fixtures/mini_test.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const V = createRequire(import.meta.url)("../site/shared/trade_3way_view.js");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

const ok = (body, status = 200) => ({ ok: status < 400, status, body });

test("ACCEPT: executed · executed-needs-review · already · unconfirmed · not-executed are five DIFFERENT readings", () => {
  const done = V.interpretAction("accept", ok({ ok: true, executed: true, execution_state: "completed" }));
  t.equal(done.kind, "done"); t.equal(done.tone, "ok"); t.equal(done.executed, true);
  const review = V.interpretAction("accept", ok({ ok: true, executed: true, needs_review: true, execution_state: "executed_needs_review", message: "Your trade WAS executed in MFL. Its contract/extension processing did not finish and needs commissioner review (no action needed from you)." }));
  t.equal(review.kind, "executed_needs_review"); t.equal(review.executed, true, "it WAS executed"); t.equal(review.tone, "warn", "a warning, not an error and not plain success");
  t.match(review.title, /needs commissioner review/i); t.match(review.message, /WAS executed in MFL/); t.doesNotMatch(review.message, /fail/i);
  const again = V.interpretAction("accept", ok({ ok: true, already: true, executed: true }));
  t.equal(again.kind, "already"); t.equal(again.executed, true);
  const unconfirmed = V.interpretAction("accept", ok({ ok: false, code: "execution_unconfirmed", message: "We couldn't confirm whether MFL processed that accept, and it has NOT been sent again. Check the trade in MFL." }, 503));
  t.equal(unconfirmed.kind, "unconfirmed"); t.equal(unconfirmed.executed, null, "unknown — neither 'accepted' nor 'failed'"); t.match(unconfirmed.message, /NOT been sent again/);
  const busy = V.interpretAction("accept", ok({ ok: false, code: "execution_in_progress", message: "That trade is already being accepted. Give it a moment." }, 409));
  t.equal(busy.kind, "unconfirmed");
  const no = V.interpretAction("accept", ok({ ok: false, code: "cap_exceeded", error: "Hawks would be $5,000 over the $300,000 salary cap." }, 409));
  t.equal(no.kind !== "done" && no.executed === false, true); t.equal(no.tone, "bad"); t.match(no.message, /Hawks would be \$5,000 over/); t.match(no.title, /Not accepted/);
  const net = V.interpretAction("accept", { networkError: true });
  t.equal(net.executed, false); t.equal(net.retryable, true);
  const html = V.esc(review.message); t.equal(typeof html, "string");
});

test("RE-CHECK: an accepted-but-cap-held trade — success, still blocked (with the server's words), signed out, offline", () => {
  const good = V.interpretRecheck(ok({ ok: true, code: "rechecking", message: "The salary cap is fine now — the trade is being processed." }));
  t.equal(good.ok, true); t.equal(good.kind, "rechecking");
  const held = V.interpretRecheck(ok({ ok: false, code: "cap_exceeded", message: "Hawks would be $5,000 over the $300,000 salary cap." }, 409));
  t.equal(held.ok, false); t.equal(held.kind, "still_blocked"); t.match(held.message, /Hawks would be \$5,000 over/);
  const unavail = V.interpretRecheck(ok({ ok: false, code: "cap_check_unavailable", message: "We couldn't verify the salary cap for this trade right now." }, 409));
  t.equal(unavail.kind, "still_blocked");
  const anon = V.interpretRecheck(ok({ ok: false, code: "unauthenticated" }, 401)); t.equal(anon.ok, false); t.equal(anon.kind, "unauthenticated");
  const net = V.interpretRecheck({ networkError: true }); t.equal(net.ok, false); t.equal(net.retryable, true);
  const boom = V.interpretRecheck(ok({ ok: false, error: "TypeError: x is not a function at index.js:123" }, 500));
  t.doesNotMatch(boom.message, /TypeError|index\.js/, "raw server text never reaches the screen");
});

const TRADE = (over) => ({
  id: "t-1", version: "v1", terminal: false, status: "collecting",
  state_view: { code: "blocked_cap", label: "Waiting on the salary cap", message: "Hawks would be $5,000 over the $300,000 salary cap. Everyone has already accepted; it will go through as soon as the cap allows (re-check to try again).", terminal: false, waiting_on: [] },
  participants: [{ fid: "0008", name: "Real Deal Creel", state: "initiator" }, { fid: "0001", name: "L.A. Looks", state: "accepted" }, { fid: "0012", name: "Hawks", state: "accepted" }],
  sides: [], movements: [], extensions: [], timestamps: { created_at_utc: "2026-09-25T10:00:00Z", updated_at_utc: "2026-09-25T10:00:00Z" }, mfl_trade_ids: [],
  permissions: { can_view: true, can_cancel: false, can_recheck: true, cancel_block_reason: "All three teams have accepted, so this can no longer be called off." },
  execution: { state: "blocked_cap", blocked: true, mfl_executed: false, needs_review: false, block: { kind: "blocked", message: "Hawks would be $5,000 over the $300,000 salary cap.", violations: [{ franchise_id: "0012", franchise_name: "Hawks", amount_over: 5000 }] } },
  viewer: { role: "partner" }, integrity: { ok: true, issues: [] },
  ...(over || {}),
});

test("HELD 3-WAY: the block names the franchise and the amount, says the accepts are saved, and offers Re-check only when the server allows it", () => {
  const h = V.renderDetail(TRADE(), {});
  t.match(h, /Waiting on the salary cap/); t.match(h, /Hawks/); t.match(h, /over by \$5,000/); t.match(h, /already accepted and those accepts are saved/);
  t.match(h, /data-t3w-act="recheck"/); t.match(h, /Re-check now/);
  t.doesNotMatch(h, /data-t3w-act="cancel"/, "no Cancel button once everyone accepted (the server said so)");
  t.match(h, /can no longer be called off/, "and the reason is shown");
  const noPerm = V.renderDetail(TRADE({ permissions: { can_view: true, can_cancel: false, can_recheck: false } }), {});
  t.doesNotMatch(noPerm, /data-t3w-act="recheck"/);
  const busy = V.renderDetail(TRADE(), { recheck: { busy: true } }); t.match(busy, /Checking/); t.match(busy, /data-t3w-act="recheck"[^>]*disabled/);
  const fail = V.renderDetail(TRADE(), { recheck: { ok: false, message: "Hawks would be $5,000 over the $300,000 salary cap." } }); t.match(fail, /t3w-status-bad/);
  const evil = V.renderDetail(TRADE({ execution: { ...TRADE().execution, block: { message: "<img src=x onerror=alert(1)>", violations: [{ franchise_name: "<b>x</b>", amount_over: 1 }] } } }), {});
  t.doesNotMatch(evil, /<img|<b>x/, "every string is escaped");
});
test("TONES: a held trade and an executed-needs-review trade are warnings; neither looks like success or failure", () => {
  t.equal(V.tone(TRADE()), "warn");
  t.equal(V.tone({ state_view: { code: "executed_needs_review" } }), "warn");
  t.equal(V.tone({ state_view: { code: "completed" } }), "ok"); t.equal(V.tone({ state_view: { code: "failed" } }), "bad");
});
test("EXECUTED-NEEDS-REVIEW 3-WAY: the owner is told it WAS executed, and is offered nothing to redo", () => {
  const h = V.renderDetail(TRADE({
    status: "completed", terminal: true,
    state_view: { code: "executed_needs_review", label: "Executed — needs commissioner review", message: "The trade WAS executed in MFL. Its contract/extension processing did not finish and needs commissioner review (nothing is needed from you).", terminal: true, waiting_on: [] },
    permissions: { can_view: true, can_cancel: false, can_recheck: false }, execution: { state: "executed_needs_review", blocked: false, needs_review: true, mfl_executed: true }, executed: true,
  }), {});
  t.match(h, /Executed — needs commissioner review/); t.match(h, /WAS executed in MFL/); t.doesNotMatch(h, /data-t3w-act="(recheck|cancel|retry)"/);
});

test("CALLERS: mobile and desktop route the accept + the re-check through the shared readings; the build stamps agree", () => {
  const mobile = read("site/m/views/trade.js"), desk = read("site/trades/trade_workbench.js");
  t.match(mobile, /T\.interpretAction\(action, resp\)/, "mobile reads the accept through interpretAction");
  t.match(mobile, /executed_needs_review/); t.match(mobile, /recheck: function \(\) \{ doRecheckThreeWay\(id\); \}/); t.match(mobile, /\/api\/trades\/3way\/recheck/);
  t.match(desk, /Trade Executed \\u2014 Needs Commissioner Review/); t.match(desk, /Trade Not Confirmed/); t.match(desk, /recheck: function \(\) \{ doRecheck3Way\(twx\.detailId\); \}/); t.match(desk, /twxUrl\("\/recheck"/);
  // the "Done ✓" toast is reachable only by a plain success now
  t.match(mobile, /out\.kind === "executed_needs_review" \|\| out\.kind === "unconfirmed"/);
  const v = JSON.parse(read("site/m/version.json")).build;
  t.equal((read("site/m/app.js").match(/var BUILD = "([^"]+)"/) || [])[1], v, "app.js BUILD = version.json");
  const idx = read("site/m/index.html");
  const stampOf = (f) => (idx.match(new RegExp(f.replace(/[.\/]/g, "\\$&") + "\\?v=([0-9.]+)")) || [])[1];
  // Per-file ?v= only needs to be >= that file's own last real change, not equal to
  // whatever the live overall build is. On this combined branch (loaded-contract/lineup
  // compliance, PR #1135, + the cap-overage acknowledgment ruling, this PR) BOTH files
  // genuinely changed again -- shared/trade_3way_view.js for both features' UI, and
  // views/trade.js for the acknowledgment sheets -- so both correctly carry the combined
  // release's stamp (2026.09.28.4). Two files diverging in general is expected, not a
  // bug; here they happen to agree because both were touched.
  t.deepEqual([stampOf("shared/trade_3way_view.js"), stampOf("views/trade.js")], ["2026.09.28.4", "2026.09.28.4"],
    "both genuinely-changed scripts carry the combined release's stamp");
  t.equal(stampOf("app.js"), v, "app.js (the release identifier itself) always carries the current build");
  t.ok(v.split(".").map(Number).join(".") >= "2026.9.25.2" && v.split(".").length === 4, "the build did not go backwards from the accepted 2026.09.25.2");
  const html = read("site/trades/trade_workbench.html");
  t.equal((html.match(/trade_workbench\.js\?v=(\w+)/) || [])[1], (html.match(/trade_3way_view\.js\?v=(\w+)/) || [])[1], "desktop shared-view and workbench stamps agree");
});

await run("trade_execution_clients");
