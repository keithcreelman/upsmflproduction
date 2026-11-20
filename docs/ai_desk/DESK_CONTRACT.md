# Commissioner Desk: build contract (Phase 1, draft)

Planning inputs: `DESK_UX_SPEC.md`, `TOOL_CATALOG.md`, `tool_catalog.yaml`, `LEAGUE_RECORD_BACKLOG.md` (same folder). This file is the binding interface between the modules. Phase 1 is read-only, commissioner-only and ships dark (`DESK_ENABLED="0"`). No paid model call is possible in this phase: there is no desk API key and the live-call switch is off.

## Layers (all inside the existing Worker, under `worker/src/desk/`)
```
route handler (handler.js)  --proves commissioner--> makeCommishCaller()  (frozen; the only caller object that exists)
   -> budget gate (budget.js) -> router (router.js) -> bounded tool loop (loop.js) -> composer (composer.js) -> validator (validator.js) -> card
                                          |
                                          v
                              registry.runTool()  (registry.js: the ONLY way a tool runs)
                                          |
                  tools/*.js  get ONLY { args, asOf, caller, now, routeGet, knowledge }: no env, no D1, no cookies
```
- Authorization is code, in `registry.runTool` (caller proof on every call, schema-checked args, mandatory `as_of`, exact route allowlist, GET-only, output allowlist, secret stripping, data-class ceiling). The model can never widen it.
- A tool cannot write anything: it is never given a database handle or `env`. The desk's own writes (call log, question history) happen only in `store.js`, called by the handler and the budget gate, into `ai_call_log`, `ai_budget_totals` (both in migration 0180) and `ai_desk_questions` (migration 0181), never into league tables.
- `routeGet(path, params)` calls the Worker's own read-only GET routes via `env.SELF.fetch` (injected as `deps.fetchSelf`), with no headers or credentials, called as `fetchSelf(url, { redirect: "manual", signal })`; a redirect answer is an error.

## Tool definition (`defineTool`, see `registry.js`)
Each tool file exports its definition by calling `defineTool({...})` and exports `default` = that definition. Fields: `id`, `version`, `description` (what the model sees; say plainly what the tool can and cannot answer), `phase:"P1"`, `dataClass` (`P0` or `P2`), `readOnly:true`, `inputSchema` (`type:"object"`, `properties`, `required`; `as_of` is added by the registry), `asOf:{supports:"current"|"season"|"any", from?, check?}`, `allowlist:{routes:[{path,params:[...]}], modules:[...], tables:[]}`, `output:{allow:[dotted paths]}` (REQUIRED and non-empty for every tool; everything else is dropped), `run`.

`run({args, asOf, caller, now, routeGet, knowledge})` returns
`{status, data, facts, coverage:{supported, gaps:[{what, why, source_needed}]}, provenance:{...}, freshness, refusal?, error?}`.
- `status`: `ok | refused | unsupported_as_of | no_record | error`.
- `facts`: `[{key, label, value, unit, as_of, source, grade}]`. Units: `usd count pct rank season date week years text id`. Grades: `A` MFL record, `B` league document, `C` derived by code, `D` inferred, `NO_RECORD`. The registry namespaces keys as `cN.<key>`; the composer references them as `{{f.cN.<key>}}`. A non-`ok` result may not carry facts.
- Every number the model may state must be a fact. Calculations happen in the tool (code), never in the model.
- `refused` results carry `refusal:{code, reason}` (codes in `contract.js` `REFUSAL_CODES`) and no facts.
- Gap reasons: `NO_RECORD unsupported_as_of partial_coverage stale unverified_calculation conflict_in_canon`.

## The 14 Phase 1 tools (file = `worker/src/desk/tools/<name>.js`)
| # | id | file | backing | notes |
|---|---|---|---|---|
| 1 | `rules.search` | `rules_search.js` | `knowledge.rules` (built from `site/m/data/rules.json`) | current rules only; past `as_of` -> `unsupported_as_of` plus the current text labeled as such |
| 2 | `rules.get` | `rules_get.js` | same | by anchor; returns text, `canon_sha`, section path |
| 3 | `glossary.lookup` | `glossary_lookup.js` | `knowledge.glossary` | contract-status tokens and league terms |
| 4 | `coverage.check` | `coverage_check.js` | `knowledge.coverage` | "does data exist for domain X, season Y, as_of Z?" |
| 5 | `roster.current` | `roster_current.js` | `/roster-workbench` | always sends `NO_CACHE=1`, never `EXT_URL` |
| 6 | `cap.position` | `cap_position.js` | `/roster-workbench` + `cap_math.js` | states the sign convention |
| 7 | `cap.penalty_quote` | `cap_penalty_quote.js` | `/api/cap-penalty/preview` | **two guards** (below) |
| 8 | `cap.adjustments` | `cap_adjustments.js` | `/api/salary-adjustments/ledger` | completeness label by season |
| 9 | `extension.price` | `extension_price.js` | `extension_pricing.js` (module) | pure |
| 10 | `calendar.events` | `calendar_events.js` | `/api/league-events` + `trade_deadline.js` | surfaces canon's own conflicts |
| 11 | `standings.get` | `standings_get.js` | `/api/standings`, `/api/playoff-bracket` | explicit year |
| 12 | `history.finishes` | `history_finishes.js` | `/api/historical-finishes`, `/api/hall-of-champions` | **finish label map** (below) |
| 13 | `player.transactions` | `player_transactions.js` | `/api/player-transactions`, `/api/player-bundle` | `view: transactions|profile` |
| 14 | `data.freshness` | `data_freshness.js` | `/api/data-freshness` + `knowledge.rulesMeta` | per-source age vs limit |

Every route call passes `L` (the league id, from `knowledge.leagueId`) and the season explicitly. Two backing routes silently default (`/api/cap-penalty/preview` to a hard-coded 2026; `/api/standings` to the calendar year); the tools must pass the season they mean.

### Guard G1: `cap.penalty_quote` refuses an exact quote when the earned salary would be guessed
`index.js` ~3759 falls back to `AAV x years played` when `contractInfo` has no `Y1-nK` style year-by-year salaries. Archive example: `CL 3| TCV 12K| AAV 3K`, 1 year left: posted $1K, fallback gives $3K. If the player has completed years (contract length minus years remaining > 0) and `contractInfo` has no parseable per-year salaries for them, the tool returns `status:"refused"`, `refusal.code:"incomplete_contract_data"`, no facts, with a gap naming the missing source. It does not return the route's number.

### Guard G2: `cap.penalty_quote` refuses a tag-cut quote the route cannot price correctly
`index.js` ~3929 treats a TAG contract as cap-free if today's date is before Aug 1 of the season; canon (section 6.C2 / C8) says "before the FA Auction starts" (the 2026 cut deadline was Jul 22). Also a what-if with a past drop date is judged by today's date. For a contractStatus matching `/tag/i` the tool answers only when the route's view and canon agree (`today` and the drop date are both before the auction start, or both on or after Aug 1); every other case returns `refused` / `tag_cutoff_unreliable`. If the auction start date cannot be resolved (via `calendar.events` data or `knowledge.calendar`), it refuses. `now` is injected for tests.

Both guards must have tests proving the number is never returned, plus a test proving a normal quote still passes. The inline calculator in `index.js` is NOT changed in this work (a calculator change goes through the contract-change gate, `docs/CHANGE_PLAYBOOK.md` section 0).

### Finish label map (`history.finishes`)
`final_finish` 1 to 6 = championship bracket places; **7 = Toilet Bowl (Hawk Tuah Bowl) champion**, never "seventh place"; 8 to 12 = rest of the Toilet bracket. Do not use `/api/eras`' toilet counts (it counts finish 12). 2015 final standings are defective (two franchises at 6, none at 10): flag it. 2010 had no Toilet title. Return labeled finishes (`label` field), not raw numbers alone.

## The card (composer output; the validator checks it; the page renders it)
```json
{ "state": "<CARD_STATES>", "lead_md": "text with {{f.c1.cap_available}} tokens, no digits",
  "blocks": [{"type":"table|timeline|chart|branch|comparison","title":"","columns":[],"rows":[],"fact_ids":[],"tool_call_ids":[]}],
  "facts_used": ["c1.cap_available"], "cites": [{"anchor":"s1-c4","canon_sha":"194f8df","claim":""}],
  "gaps":[{"what":"","why":"NO_RECORD","source_needed":""}], "conflicts":[{"fact_a":"","fact_b":"","note":""}],
  "ruling_question": "", "follow_ups": [""] }
```
After validation the server attaches `facts` (id -> {value, unit, display, grade, source, as_of, tool, call_id}), `header` (`ai_generated:true`, `as_of`, `canon_sha`, `phase:"P1"`), `footer` (tools checked with durations, cost) and `request_id`. The page renders from this server-built card only.

Validator rules (code, before rendering; reject, retry once, then `tool_failure`): (1) every `{{f.*}}` token resolves to a fact returned in this run; (2) prose has no digits or spelled quantities outside tokens (reuse the Wire digits audit idea); (3) every cited anchor exists in the rules index at `canon_sha`; (4) no fact above the caller's data class; (5) tool gaps force a non-`answer` state and a non-empty `gaps`; (6) a past `as_of` with `unsupported_as_of` forces a non-`answer` state; (7) a refused or no-record tool cannot back an answer; (8) states that carry no facts have none. The model may choose only `MODEL_CARD_STATES`; code chooses `tool_failure`, `stale_data`, `budget_exceeded`, `ignore_injection`.

## Spend controls (no paid call is possible in Phase 1)
`budget.js`: `liveCallsAllowed(env)` requires `DESK_LIVE_MODEL_ENABLED="1"` AND `ANTHROPIC_API_KEY_DESK` AND an unexhausted budget. Defaults: switch `"0"`, key unset, every cap `0`, so every call is `blocked`. The gate reserves the worst-case cost (`est_cost_usd`) in `ai_call_log` BEFORE the call, fails closed if the ledger is unreadable, and enforces per-question, per-run and total caps. The real Anthropic client refuses to construct without the desk key; tests use the fake client.

## Rules for everyone building this
1. Work only in your assigned files. Never edit another agent's file; ask the integrator.
2. No network access, no production anything, no secrets, no `wrangler`, no git commands that change state (no commit, no checkout, no stash). Read-only git is fine.
3. Do not read, search or list anything outside the worktree except explicitly named read-only fixture files. Never browse parent directories of the scratchpad or the notes folder.
4. Do not change `index.js`, `wrangler.toml`, `admin_routes.js`, `feature_flags.js`, `.github/`, `tests/safe_suite.json`, `AGENTS.md`, `CLAUDE.md` unless your brief says so. The integrator wires the route, flag and vars.
5. Tests: plain node scripts named `tests/ai_desk_<area>.test.mjs` using `tests/fixtures/mini_test.mjs` (they are auto-discovered by the safe runner). Run your own file with `node tests/<file>`. Tests must be offline and deterministic.
6. American spelling. Short on-screen text. No private data, no owner real names (franchise ids and NFL player names are fine).
7. Report back tersely: files written, tests run and counts, anything you could not verify, and any contract change you need.
