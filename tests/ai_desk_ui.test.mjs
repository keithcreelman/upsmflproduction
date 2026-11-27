// Commissioner Desk page: card renderer, fixtures, fixture api, Desk tab gate, single-file preview build.
// Offline and deterministic. Run: node tests/ai_desk_ui.test.mjs
import vm from "node:vm";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test, run, t } from "./fixtures/mini_test.mjs";
import { CARD_STATES, NO_FACT_STATES, FACT_UNITS, GRADES, formatFact, isFactId } from "../worker/src/desk/contract.js";
import { buildPreview } from "../scripts/ai_desk/build_preview.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const deskDir = path.join(root, "site", "commish", "desk");
const rd = (p) => readFileSync(path.join(deskDir, p), "utf8");

// Load the browser files into one sandbox, the way a page loads them (render first, then controller).
const ctx = vm.createContext({ console, setTimeout, clearTimeout, setInterval, clearInterval, Date });
vm.runInContext(rd("desk_render.js"), ctx, { filename: "desk_render.js" });
vm.runInContext(rd("desk.js"), ctx, { filename: "desk.js" });
const R = ctx.UPSDeskRender, D = ctx.UPSDesk;

const cardsDir = path.join(deskDir, "fixtures", "cards");
const cards = {};
for (const f of readdirSync(cardsDir).filter((x) => x.endsWith(".json")).sort()) cards[f.replace(/\.json$/, "")] = JSON.parse(readFileSync(path.join(cardsDir, f), "utf8"));
const demo = JSON.parse(rd("fixtures/demo_questions.json"));
const TOKEN = /\{\{([^{}]*)\}\}/g;
const tokenIds = (s) => [...String(s || "").matchAll(TOKEN)].map((m) => m[1]);
const stripTokens = (s) => String(s || "").replace(TOKEN, "");

// Every tag's unquoted part must carry no event handler or javascript: URL.
function tagProblems(html) {
  const bad = [];
  for (const m of html.matchAll(/<([a-zA-Z][^\s/>]*)([^>]*)>/g)) {
    const unquoted = m[2].replace(/"[^"]*"/g, '""');
    if (/\son[a-z]+\s*=/i.test(unquoted) || /javascript:/i.test(unquoted)) bad.push(m[0].slice(0, 80));
    if (/^(script|iframe|object|embed|img|svg:script|style|link)$/i.test(m[1]) && !/^svg$/i.test(m[1])) bad.push("tag " + m[1]);
  }
  return bad;
}

// ── Fixtures ──────────────────────────────────────────────────────────────────────────────────────────────────────────
test("every one of the 15 card states has a fixture, plus the 8 required extras", () => {
  const have = new Set(Object.values(cards).map((c) => c.state));
  for (const s of CARD_STATES) t.ok(have.has(s), `no fixture for state ${s}`);
  t.equal(CARD_STATES.length, 15);
  for (const name of ["cap_penalty_quote", "penalty_refused_incomplete", "tag_cut_refused", "rule_citation", "finish_toilet_bowl", "conflict_trade_deadline", "cap_position", "coverage_pick_slot_decline"]) t.ok(cards[name], `missing fixture ${name}`);
  t.ok(cards.not_ready && cards.out_of_scope_preview);
});

test("every fixture card renders without throwing and shows no missing-fact marker", () => {
  for (const [name, c] of Object.entries(cards)) {
    const missing = [];
    const html = R.renderCardHtml(c, { onMissing: (id) => missing.push(id) });
    t.ok(typeof html === "string" && html.startsWith("<article"), name);
    t.equal(missing.length, 0, `${name} has missing facts: ${missing}`);
    t.ok(!html.includes("ud-missing"), name);
    t.ok(html.includes(`data-state="${c.state}"`), name);
    t.ok(html.includes("AI-generated") && html.includes("Canon 194f8df") && html.includes("Phase 1"), `${name} header chips`);
    t.ok(html.includes("Report a problem") && html.includes("What I checked"), `${name} footer`);
  }
});

test("every {{f.*}} token in every fixture resolves to a fact; facts are well formed", () => {
  for (const [name, c] of Object.entries(cards)) {
    const texts = [c.lead_md, ...(c.blocks || []).flatMap((b) => JSON.stringify(b).match(TOKEN) || []), ...(c.gaps || []).map((g) => g.what), ...(c.conflicts || []).map((x) => x.note)];
    for (const text of texts) for (const inner of tokenIds(text)) {
      const m = /^f\.(.+)$/.exec(inner.trim());
      t.ok(m, `${name}: token ${inner} is not f.*`);
      t.ok(isFactId(m[1]), `${name}: bad fact id ${m[1]}`);
      t.ok(Object.prototype.hasOwnProperty.call(c.facts, m[1]), `${name}: token ${inner} has no fact`);
    }
    for (const k of c.facts_used) t.ok(c.facts[k], `${name}: facts_used ${k} missing`);
    for (const x of c.conflicts || []) for (const side of [x.fact_a, x.fact_b]) t.ok(c.facts[String(side).replace(/^f\./, "")], `${name}: conflict side ${side}`);
    for (const [id, f] of Object.entries(c.facts)) {
      t.ok(FACT_UNITS.includes(f.unit), `${name}.${id} unit`);
      t.ok(GRADES.includes(f.grade), `${name}.${id} grade`);
      t.equal(f.display, formatFact(f), `${name}.${id} display must match formatFact`);
      for (const k of ["source", "as_of", "tool", "call_id"]) t.ok(f[k] != null && f[k] !== "", `${name}.${id} ${k}`);
      t.equal(R.formatFact(f), formatFact(f), `${name}.${id} renderer fallback format`);
    }
    if (NO_FACT_STATES.includes(c.state)) t.equal(Object.keys(c.facts).length, 0, `${name} (${c.state}) must carry no facts`);
    if (c.gaps.length) t.ok(c.state !== "answer", `${name}: gaps need a non-answer state`);
  }
});

test("lead_md has no typed digits, no spelled quantities, and stays short", () => {
  const words = /\b(two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|hundred|thousand|million)\b/i;
  for (const [name, c] of Object.entries(cards)) {
    const prose = stripTokens(c.lead_md);
    t.doesNotMatch(prose, /\d/, `${name}: digit in lead_md`);
    t.doesNotMatch(prose, words, `${name}: spelled quantity in lead_md`);
    const sentences = prose.split(/[.!?](?:\s|$)/).filter((s) => s.trim());
    t.ok(sentences.length <= 4, `${name}: lead_md too long (${sentences.length} sentences)`);
    t.ok(c.lead_md.length <= 330, `${name}: lead_md length`);
    for (const f of c.follow_ups || []) t.ok(f.length <= 90, `${name}: follow-up too long`);
  }
});

test("fixtures use American spelling and carry no external URLs", () => {
  const brit = /\b(colour|favour|centre|labelled|behaviour|defence|licence|organis|recognis|cheque|programme|whilst|analyse|judgement|honour|travelled)/i;
  for (const [name, c] of Object.entries(cards)) {
    const s = JSON.stringify(c);
    t.doesNotMatch(s, brit, name);
    t.doesNotMatch(s, /https?:\/\//i, name);
  }
  t.doesNotMatch(rd("fixtures/demo_questions.json"), /https?:\/\//i);
});

test("a decline never carries numbers and names what would settle it", () => {
  for (const name of ["abstain", "penalty_refused_incomplete", "coverage_pick_slot_decline", "cite_and_abstain", "tag_cut_refused"]) {
    t.ok(cards[name].gaps.length >= 1 && cards[name].gaps[0].source_needed, name);
    t.equal(cards[name].facts_used.length, 0, name);
  }
  t.equal(cards.penalty_refused_incomplete.footer.tools[0].code, "incomplete_contract_data");
  t.equal(cards.tag_cut_refused.footer.tools[0].code, "tag_cutoff_unreliable");
  t.ok(cards.finish_toilet_bowl.facts["c1.label"].value === "Toilet Bowl champion");
});

// ── Rendering rules ───────────────────────────────────────────────────────────────────────────────────────────────────
test("fact chips carry a text grade label, open the drawer, and the drawer shows value, unit, as-of, grade, source, tool, call id", () => {
  const c = cards.cap_position;
  const html = R.renderCardHtml(c);
  t.ok(/<button type="button" class="ud-fact ud-fg-C"[^>]*data-act="fact" data-fact="c1\.cap_room"/.test(html));
  t.ok(html.includes("$57K") && html.includes(">C</span>"));
  const prov = R.renderProvenanceHtml(c, "c1.cap_room");
  for (const needle of ["$57K", "usd", "2026-11-19", "Derived by code", "MFL roster workbench and cap math", "cap.position", "c1"]) t.ok(prov.includes(needle), "drawer lacks " + needle);
  t.ok(prov.includes("What the grades mean"));
  const nr = R.renderCardHtml({ ...cards.answer, facts: { ...cards.answer.facts, "c1.salary": { ...cards.answer.facts["c1.salary"], grade: "NO_RECORD", value: null, display: "" } } });
  t.ok(nr.includes("NO RECORD") && nr.includes("No record"));
});

test("a token with no fact renders a visible marker and is logged, never a guess", () => {
  const seen = [];
  const c = { ...cards.answer, lead_md: "Salary is {{f.c1.salary}} and bonus is {{f.c9.bonus}} and {{nonsense}} and {{f.c1.constructor}}." };
  const html = R.renderCardHtml(c, { onMissing: (id) => seen.push(id) });
  t.equal((html.match(/class="ud-missing"/g) || []).length, 3);
  t.deepEqual(seen, ["c9.bonus", "nonsense", "c1.constructor"]);
  t.ok(html.includes("$9K"));
});

test("each state shows its own banner label and the required boxes", () => {
  const label = (s) => R.stateLabel(s);
  for (const c of Object.values(cards)) t.ok(R.renderCardHtml(c).includes(R.esc(label(c.state))), c.state);
  const gap = R.renderCardHtml(cards.answer_with_gap);
  t.ok(gap.includes("ud-box-amber") && gap.includes("Gaps: what is missing") && gap.includes("No record") && gap.includes("Would settle it"));
  t.ok(gap.includes("ud-tl-gap") && gap.includes("ud-tl-final") && gap.includes("What was exchanged"));
  const conf = R.renderCardHtml(cards.answer_with_conflict);
  t.ok(conf.includes("Sources disagree") && conf.includes("Source A") && conf.includes("Source B") && conf.includes("Hall of champions page"));
  const rul = R.renderCardHtml(cards.needs_ruling);
  t.ok(rul.includes("ud-box-blue") && rul.includes("<textarea") && rul.includes("Draft ruling question") && rul.includes("ud-branch"));
  t.ok(R.renderCardHtml(cards.answer_with_caveat).includes("ud-caveat"));
  t.ok(R.renderCardHtml(cards.ignore_injection).includes("Ignored instructions found in source text"));
  t.ok(R.renderCardHtml(cards.stale_data).includes("ud-tone-red"));
  t.ok(R.renderCardHtml(cards.budget_exceeded).includes("Paused: AI budget reached for this period"));
  t.ok(R.renderCardHtml(cards.tool_failure).includes('data-act="retry"'));
  const cmp = R.renderCardHtml({ ...cards.answer, blocks: [{ type: "comparison", title: "Compare", columns: ["", "A (0001)", "B (0002)"], rows: [["x", "1", "2"]] }] });
  t.ok(cmp.includes("ud-compare") && cmp.includes("Franchise, not owner"));
  for (const c of Object.values(cards)) if (c.gaps.length) t.ok(R.renderCardHtml(c).includes("Gaps: what is missing"), c.state + " gaps box");
});

test("chart appears only for four or more seasons, with a values table and era lines", () => {
  const html = R.renderCardHtml(cards.partial);
  t.ok(html.includes("<svg") && html.includes('role="img"') && html.includes("ud-chart-table") && html.includes("ud-era") && html.includes("Superflex") && html.includes("37 games"));
  const short = { ...cards.partial, blocks: [{ ...cards.partial.blocks[0], rows: cards.partial.blocks[0].rows.slice(0, 3) }] };
  const h2 = R.renderCardHtml(short);
  t.ok(!h2.includes("<svg") && h2.includes("ud-chart-table"));
});

test("tables right-align numeric facts and keep a scroll box with a sticky row header", () => {
  const html = R.renderCardHtml(cards.cap_position);
  t.ok(html.includes('class="ud-scroll"') && html.includes('<th scope="row">') && html.includes('class="ud-num"'));
});

test("unknown or broken cards render inert, not as facts", () => {
  const html = R.renderCardHtml({ state: "mystery", lead_md: "Salary is {{f.c1.x}}", facts: {} });
  t.ok(html.includes("ud-state-unknown") && !html.includes("Salary is"));
  t.ok(R.renderCardHtml(null).includes(R.esc("Couldn't verify")));
  t.ok(R.renderCardHtml("nope").startsWith("<article"));
});

test("errors map to the right state: budget_exceeded, not_ready, tool_failure", () => {
  const e = (props) => Object.assign(new Error("x"), props);
  t.equal(D.errCard(e({ status: 402, data: { error: "budget_exceeded" } })).state, "budget_exceeded");
  t.equal(D.errCard(e({ data: { state: "budget_exceeded" } })).state, "budget_exceeded");
  t.equal(D.errCard(e({ status: 503, data: { error: "not_ready" } })).state, "not_ready");
  t.equal(D.errCard(e({ status: 500 })).state, "tool_failure");
  t.ok(R.renderCardHtml(D.errCard(e({ data: { error: "not_ready" } }))).includes("Desk not ready"));
  t.ok(R.renderCardHtml(D.errCard(e({ data: { error: "budget_exceeded" } }))).includes("Paused: AI budget reached for this period"));
});

// ── Security ──────────────────────────────────────────────────────────────────────────────────────────────────────────
test("hostile text in every field renders as inert text", () => {
  const H = `<script>alert(1)</script><img src=x onerror=alert(1)>"'><svg onload=alert(1)>`;
  const hostileFact = { value: H, unit: "text", display: H, grade: "A", source: H, as_of: H, tool: H, call_id: H, label: H, inputs: { x: H }, raw_url: "javascript:alert(1)" };
  const card = {
    state: "needs_ruling", question: H, request_id: `x" onmouseover="alert(1)`, lead_md: `${H} {{f.c1.bad}} **${H}**`,
    facts: { "c1.bad": hostileFact, "c1.other": { ...hostileFact, grade: H } }, facts_used: ["c1.bad"],
    blocks: [
      { type: "table", title: H, columns: [H, "{{f.c1.bad}}"], rows: [[H, `{{f.c1.bad}}`, H], [null, 5]], tool_call_ids: [H] },
      { type: "timeline", title: H, rows: [{ date: H, from: H, to: H, what: H, grade: H, detail: [H], kind: H }], expand_question: H, expand_label: H },
      { type: "chart", title: H, columns: [H, H], rows: [[H, "1"], ["b", "2"], ["c", "3"], ["d", "4"]], eras: [{ at: "b", label: H }] },
      { type: "branch", title: H, branches: [{ label: H, reading: H, rule: { anchor: H, claim: H }, needs: H }] },
      { type: "comparison", title: H, columns: [H], rows: [[H, H]] }, { type: H, title: H }],
    cites: [{ anchor: H, canon_sha: H, claim: H }], gaps: [{ what: H, why: H, source_needed: H }],
    conflicts: [{ fact_a: "f.c1.bad", fact_b: "f.c1.other", note: H }], ruling_question: `</textarea>${H}`, follow_ups: [H],
    caveat: H, injection_note: H,
    header: { as_of: H, canon_sha: H, phase: H, league_record_version: H }, footer: { tools: [{ id: H, call_id: H, ms: H, status: H, code: H }], cost_usd: H, sources: [H] },
  };
  for (const state of ["needs_ruling", "answer_with_caveat", "ignore_injection", "answer_with_conflict"]) {
    const html = R.renderCardHtml({ ...card, state });
    t.ok(!html.includes("<script"), state + " script");
    t.ok(!/<img/i.test(html) && !/<svg onload/i.test(html), state + " img/svg");
    t.deepEqual(tagProblems(html), [], state);
    t.ok(html.includes("&lt;script&gt;"), state + " escaped text present");
    t.ok(!html.includes('<a href="javascript'), state);
  }
  const prov = R.renderProvenanceHtml(card, "c1.bad");
  t.ok(!prov.includes("<script") && !/<img/i.test(prov) && !prov.includes("javascript:"));
  t.deepEqual(tagProblems(prov), []);
  const hist = R.renderHistoryHtml([{ id: `"><script>1</script>`, question: H, state: H, created_at: H }]);
  t.ok(!hist.includes("<script")); t.deepEqual(tagProblems(hist), []);
  const sug = R.renderSuggestionsHtml([H, { q: H, suggested: true }]);
  t.ok(!sug.includes("<script")); t.deepEqual(tagProblems(sug), []);
  // a safe https raw record link is the only link the drawer can carry
  const ok = R.renderProvenanceHtml({ facts: { "c1.a": { ...hostileFact, value: 1, display: "1", raw_url: "https://example.invalid/r/1" } } }, "c1.a");
  t.ok(ok.includes('rel="noopener noreferrer"'));
});

test("desk.js builds markup only from constants and escaped strings", () => {
  const src = rd("desk.js");
  t.doesNotMatch(src, /\bon(click|error|load|mouseover)\s*=/i);
  t.doesNotMatch(src, /\beval\(|new Function|document\.write/);
  t.doesNotMatch(src, /https?:\/\//i);
  t.doesNotMatch(rd("desk_render.js"), /https?:\/\//i);
  t.doesNotMatch(rd("desk.css"), /https?:\/\/|@import|url\(/i);
});

// ── Fixture api ───────────────────────────────────────────────────────────────────────────────────────────────────────
test("demo questions: at least 20, each mapped to a fixture card, matched by keyword scoring", async () => {
  t.ok(demo.questions.length >= 20);
  t.ok(demo.questions.filter((q) => q.suggested).length >= 4);
  for (const q of demo.questions) { t.ok(cards[q.card], `${q.id} -> ${q.card}`); t.ok(q.question.length > 10); }
  const mapped = new Set(demo.questions.map((q) => cards[q.card].state));
  for (const s of CARD_STATES) t.ok(mapped.has(s), `no demo question reaches state ${s}`);
  for (const q of demo.questions) t.equal(D.matchQuestion(q.question, demo.questions).id, q.id, "exact: " + q.question);
  t.equal(D.matchQuestion("cap penalty if we cut Chris Olave", demo.questions).card, "cap_penalty_quote");
  t.equal(D.matchQuestion("tell me about the zebra population", demo.questions), null);

  const api = D.makeFixtureApi({ questions: demo.questions, cards, fallback: demo.fallback }, { delayMs: 0 });
  const steps = [];
  const known = await api.ask({ question: "Who won the Toilet Bowl in 2019?", as_of: "current" }, { onProgress: (p) => steps.push(p) });
  t.equal(known.card.state, "answer"); t.ok(known.request_id.startsWith("demo-")); t.equal(known.card.request_id, known.request_id);
  t.ok(steps.length >= 2);
  const free = await api.ask({ question: "what is the meaning of life", as_of: "current" });
  t.equal(free.card.state, "out_of_scope"); t.ok(free.card.lead_md.includes("fixture preview"));
  const h = await api.history();
  t.ok(h.items.length >= 3 && h.items[0].id === free.request_id);
  const one = await api.question(known.request_id);
  t.equal(one.item.card.state, "answer");
  t.equal((await api.report({ id: known.request_id, note: "n" })).ok, true);
  t.equal((await api.status()).enabled, true);
});

// ── The Desk tab in commish_settings.html ─────────────────────────────────────────────────────────────────────────────
const page = readFileSync(path.join(root, "site", "commish", "commish_settings.html"), "utf8");
function deskLogic(deskCallImpl) {
  const m = /\/\/ DESK-TAB-LOGIC-START\n([\s\S]*?)\/\/ DESK-TAB-LOGIC-END/.exec(page);
  t.ok(m, "marker block present");
  const TABS = [{ key: "health", label: "Health" }], TAB_GROUPS = [{ label: "Dashboard", keys: ["health"] }];
  const appended = [];
  const nav = { appendChild: (n) => appended.push(n) };
  const document = { getElementById: (id) => (id === "cs-tabs" ? nav : null), createElement: () => ({ className: "", innerHTML: "" }) };
  const tabByKey = (k) => TABS.filter((x) => x.key === k)[0];
  const calls = [];
  const fn = new Function("TABS", "TAB_GROUPS", "tabByKey", "document", "_withUserId", "apiUrl", "L", "fetch",
    m[1] + "; return { deskStatusEnabled, addDeskTab, probeDesk, deskCall };");
  const api = fn(TABS, TAB_GROUPS, tabByKey, document, (u) => u + "&MFL_USER_ID=u&APIKEY=k", (p) => "https://w.invalid" + p, "74598", (url, init) => { calls.push({ url, init }); return deskCallImpl(url, init); });
  return { api, TABS, TAB_GROUPS, appended, calls };
}
const resp = (status, body) => Promise.resolve({ ok: status >= 200 && status < 300, status, text: () => Promise.resolve(body == null ? "" : JSON.stringify(body)) });

test("Desk tab: hidden when the status route is 404, disabled, malformed or fails; visible only for enabled:true", async () => {
  for (const [label, impl] of [["404", () => resp(404, { error: "not_found" })], ["403", () => resp(403, { reason: "not_commish" })], ["500", () => resp(500, null)],
    ["disabled", () => resp(200, { enabled: false })], ["string true", () => resp(200, { enabled: "true" })], ["number 1", () => resp(200, { enabled: 1 })], ["empty", () => resp(200, null)],
    ["network error", () => Promise.reject(new Error("offline"))], ["bad json", () => Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve("<html>") })]]) {
    const x = deskLogic(impl);
    t.equal(await x.api.probeDesk(), false, label);
    t.equal(x.TABS.length, 1, label + " tabs untouched"); t.equal(x.TAB_GROUPS.length, 1); t.equal(x.appended.length, 0);
  }
  const on = deskLogic(() => resp(200, { enabled: true, live_model_enabled: false, budget: {} }));
  t.equal(await on.api.probeDesk(), true);
  t.deepEqual(on.TABS.map((x) => x.key), ["health", "desk"]);
  t.equal(on.appended.length, 1); t.ok(on.appended[0].innerHTML.includes('data-cstab="desk"'));
  await on.api.probeDesk(); // idempotent
  t.equal(on.TABS.length, 2); t.equal(on.appended.length, 1);
});

test("Desk status probe uses GET, omits credentials, and sends the same auth params as other tabs", async () => {
  const x = deskLogic(() => resp(200, { enabled: false }));
  await x.api.probeDesk();
  t.equal(x.calls.length, 1);
  t.equal(x.calls[0].init.method, "GET"); t.equal(x.calls[0].init.credentials, "omit"); t.equal(x.calls[0].init.body, undefined);
  t.equal(x.calls[0].url, "https://w.invalid/admin/commish-desk/status?L=74598&MFL_USER_ID=u&APIKEY=k");
  const y = deskLogic(() => resp(200, {}));
  await y.api.deskCall("GET", "question?id=a b");
  t.equal(y.calls[0].url, "https://w.invalid/admin/commish-desk/question?id=a b&L=74598&MFL_USER_ID=u&APIKEY=k");
});

test("with the flag off the page is otherwise unchanged: static TABS has no desk, one quiet probe, no loud helpers", () => {
  const tabs = /var TABS = \[([\s\S]*?)\];/.exec(page)[1];
  t.doesNotMatch(tabs, /desk/i);
  const groups = /var TAB_GROUPS = \[([\s\S]*?)\];/.exec(page)[1];
  t.doesNotMatch(groups, /desk/i);
  t.equal((page.match(/\bprobeDesk\(\);/g) || []).length, 1);
  t.equal((page.match(/renderDesk\(\)/g) || []).length, 2); // the renderTab branch and the definition
  const logic = /\/\/ DESK-TAB-LOGIC-START\n([\s\S]*?)\/\/ DESK-TAB-LOGIC-END/.exec(page)[1];
  t.doesNotMatch(logic, /_commishKeyBanner|fetchJSON|postJSON|toast\(|alert\(/); // a failed probe must never raise the key bar or a toast
  t.doesNotMatch(logic, /innerHTML\s*=\s*[^;]*\b(L|YEAR)\b/);
  t.ok(/credentials: "omit"/.test(logic));
  t.ok(page.includes('if (CS.tab === "desk") return renderDesk();'));
});

// ── Single-file preview build ─────────────────────────────────────────────────────────────────────────────────────────
test("desk_preview.single.html is current, self-contained, and makes no external request", () => {
  const html = buildPreview();
  t.equal(readFileSync(path.join(deskDir, "desk_preview.single.html"), "utf8"), html, "stale: run node scripts/ai_desk/build_preview.mjs");
  t.doesNotMatch(html, /https?:\/\//i);
  t.doesNotMatch(html, /["'(=]\s*\/\/[a-z0-9.-]+\./i); // no protocol-relative URL
  const staticHtml = html.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "");
  t.doesNotMatch(staticHtml, /<(link|iframe|img|object|embed|form|video|audio|source)\b/i);
  t.doesNotMatch((html.match(/<style>[\s\S]*?<\/style>/gi) || []).join(""), /@import|url\(/i);
  t.doesNotMatch(staticHtml, /\b(src|href|action|data)\s*=/i);
  t.equal((html.match(/<script\b/g) || []).length, 4); // render, controller + fixtures, boot
  // every script src/fetch in the page is a relative fixture path (only used when the single file is NOT inlined)
  for (const m of html.matchAll(/fetch\(\s*([^)]*)\)/g)) t.ok(!/^["']?(https?:|\/\/)/.test(m[1].trim()), "fetch " + m[1]);
  t.ok(html.includes("window.UPS_DESK_FIXTURES") && html.includes("UPSDeskRender") && html.includes(".ud-root"));
  t.ok(html.includes("width=device-width") && html.includes("prefers-color-scheme: dark"));
});

await run("ai_desk_ui");
