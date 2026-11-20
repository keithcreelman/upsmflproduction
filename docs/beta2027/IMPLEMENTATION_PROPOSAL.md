# UPS 2027 Beta: consolidated implementation proposal

**Status: DRAFT for Keith's decision. This approves nothing.** It follows the eight planning decisions Keith has ruled on (2026-11-20) and asks for one thing: approval to start the first build scope (section 9). Deployment, every write flow, every worker change and every production setting stay separate approvals. Companion: `DEMO_PARITY_CHECKLIST.md` (the 96-row checklist), issue #1475 (the planning record), PR #1477 (Preview 0).

## 1. The rulings this proposal obeys

| # | Ruling (Keith, chat 2026-11-20) |
|---|---|
| 1 | **Preview** draws the full Actions UI and every review sheet, **Submit disabled and no write code in that build**. Real transactions only in the **Test** build, league 25625. Each flow returns to Keith for separate approval before it is enabled in the invited beta. |
| 2 | The pinned Player Profile Look demo is the source of truth: Home lineup card, Team, profile, Actions, Contracts. Market and the other areas are later, separately scoped specs. |
| 3 | The demo's labeled dashed "Helmet TBD" placeholder is added as shown; no helmet art is drawn or invented. |
| 4 | Scenario toggles go in client-only **Sample** mode and the Test controls (labeled, never sends a transaction). **Report a bug** replaces Feedback, reachable everywhere including sheets, carrying the current screen and captured error; **bug reports go only to #keiths-test during integration testing**. The compare-navigation sheet is dropped. Skin, vibrant colors and the position-group rule stay owner settings. |
| 5 | Navigation B: Home, Team, Market, League. Fix lineup is a one-tap shortcut into Team's lineup workspace; an unsaved indicator inside it and a prompt before leaving with edits. |
| 6 | **Test clock:** A (request-scoped override) paired with B's closed-window refusal cases. Honored only for authorized Test sessions on league 25625; production never honors it; it does not change the shared worker's global clock. Document what our worker enforces versus what MFL enforces; never claim the override bypasses MFL's rules. |
| 7 | **Write order:** Report a bug (to #keiths-test only) → lineup → roster moves → drop → contract actions. Each flow needs verified results before the next. |
| 8 | **Data:** reuse existing league and NFL sources; audit before building any route or declaring data unavailable; establish sources for action eligibility, injury timing, opponents and kickoffs, weekly scoring history and the contract calendar. Projections, news, bio and IR return dates use the demo's **Unavailable** state until a suitable source is approved. **Never infer an exact return date.** |

## 2. What the audit found (decision 8)

I read the worker (`worker/src/index.js` and its modules), the shared browser modules (`site/shared/`) and the current phone app (`site/m/`). **Nothing was run or exercised**; every row is from reading code. The headline: **most of what the demo shows already has a source, and the current app already performs every contract action in-app.** The beta's job is to reuse these, not rebuild them.

| Need | What exists | Where | Verdict |
|---|---|---|---|
| Roster, contracts, taxi eligibility, call-ups | Front Office read | `GET /roster-workbench` | **In the beta already** |
| Lineup as MFL holds it | MFL export through the worker | `GET /api/mfl-export?TYPE=weeklyResults` | **In the beta already** |
| Your own lineup (with the ledger of what we sent) | Needs an MFL session | `GET /api/lineup` | Test/Live only |
| 18-slot lineup model (QB1, RB1-2, WR1-2, TE1, FX1-2, SF, K, P, DL1-2, LB1-2, DB1-2, DF) | The same model the demo uses | `site/m/front_office_lineup.js` | Reuse (mirror, see section 4) |
| Opponent, home/away, kickoff, status, spread; next three weeks | One read | `GET /api/lineup-matchups` (`worker/src/lineup_matchups.js`) | Reuse as is |
| Full remaining schedule with byes and game state | One read | `GET /api/fantasy-sos` (v=2) | Reuse as is |
| Allowed-to-position, usual, rank of 32 | Same engine as Pts Agst | `defRatings` in the two reads above (`worker/src/fpa_engine.js`) | Reuse as is |
| Injury status | Official report, roster designation and MFL designation, resolved once | `GET /api/player-status` + `site/shared/injury_status.js` (the one resolver) | Reuse; the resolver already **forbids expected-return dates** |
| Injury timing for the lineup-issue sheet | The §G3 machinery | `lineup_compliance.js`, `lineup_rulings.js` | Confirm which timing facts are readable |
| Weekly box score and snaps (game log) | One read | `GET /api/player-weekly-box` | Reuse as is |
| Season points, PPG, PPG rank | MFL player scores | `site/m/season_scoring.js`, `site/shared/player_facts.js` | Reuse |
| Start / Boom / Bust | Defined by Keith 2026-10-10 against the UPS starter pool | `GET /api/player-starter-rates` (`worker/src/starter_rates.js`) | Reuse; the demo's thresholds are placeholders and the beta says so |
| Per-week role (Started, Benched, On Team n, Free agent) | Not found as a stored fact | (MFL lineups per week are public) | **Gap**: derive from MFL lineups or show no role |
| Contract calendar and deadlines | Calendar read with a fail-closed resolver; ladder resolved on the worker | `getAuctionCalendar`, `resolveContractDeadlineUtc`, `GET /api/league-events`, `league_events_ladder.js`, `site/shared/contract_windows.js` | Reuse; confirm the read carries every date the Deadlines list shows |
| Action eligibility (Extend, Restructure, MYAC, MYM, Tag, taxi, IR, drop) | Client predicates (verbatim Front Office mirrors), shared window and taxi modules, server enforcement at submit | `site/m/front_office_actions.js`, `site/shared/contract_windows.js`, `site/shared/taxi_rule.js` (twin of `worker/src/taxi_rule.js`), `worker/src/extension_eligibility.js`, `mym_guard.js` | **Reuse first.** No single server "what can he do now" preview exists; add one only if a parity test shows the client and server disagree |
| Cut penalty, earned, guarantee | Worker calculation | `GET /api/cap-penalty/preview` | **In the beta already** (the older client estimate `front_office_penalty.js` is not used) |
| Extension pricing and options | Worker module and a per-season preview file | `worker/src/extension_pricing.js`, `extension_previews_<year>.json`, `front_office_extend_submit.js` | Reuse |
| Cap space | Front Office cap code | `site/m/front_office_cap.js` | Reconcile with the Front Office number before showing |
| Projections | Projection fetch exists in the current Lineup | `site/m/views/lineup.js` | **Unavailable** (decision 8) |
| News | `GET /api/player-news` (Sleeper via MFL ids) | worker | **Unavailable** until a source and its rights are approved |
| Bio | `GET /api/player-bundle` (MFL playerProfile) | worker | **Unavailable** until approved |
| IR expected return | MFL's export has a field; the repo deliberately shows none | `site/shared/injury_status.js` | **Not shown. Never inferred.** |
| Bug report | Older worker route `/bug-report`; newer private D1 backend in draft | #1465 (flag off, migration unapplied), #1474 | See dependencies |

**Findings that change the plan**
1. **The current phone app already runs Extend, Restructure, MYAC, MYM and Tag in-app**, through "verbatim mirror" files that POST to the same worker routes the desktop uses (`/commish-contract-update`, `/offer-restructure`, `/offer-mym`). The beta calls the same routes; it does not invent new write paths.
2. Those files are marked **"DO NOT EDIT logic"** and are hand-copied from desktop code, which is the drift the repo has been fighting. **The beta must not add another hand copy.**
3. The pure calculators the Preview build needs for review sheets (extension options, restructure math, MYAC and MYM builders) live **in the same files as the submit code**. Preview may contain no write code, so they cannot be shipped as they are.
4. The repo already has the right pattern: a browser **twin generated from the worker's body, with a test that fails if they drift** (`site/shared/taxi_rule.js`, `tests/taxi_rule.test.mjs`).

## 3. Design that follows

**One codebase, two artifacts.** `apps/mobile2027` builds a **Preview** artifact (no write code, `mode: preview`) and, later, a **Test** artifact (write modules included, `mode: test`, league 25625). They differ only in an `env.json`-style configuration plus the presence of the submit modules; a CI check pins that.

**Reuse without copying.**
- *Intake of shared modules:* the build copies named files from `site/shared/` **byte for byte** and verifies each file's SHA-256 against the repo file, so there is one source. A scan refuses a Preview-bound file that contains a write verb, `FormData` or a non-GET request.
- *Calculators embedded in submit mirrors:* extract them as **pure twin modules generated by a script from the mirrors**, with an equivalence test over recorded fixtures (the `taxi_rule` pattern). The classic app is not modified; the mirrors stay as they are.
- *The Test build's submit layer* is a thin client over the existing routes, with the verification standard of the planning record (preflight, intent record with idempotency key, write, independent MFL read-back with caches bypassed, report only what the read-back supports).

**Sample mode** is a client-only store with a visible label. A test pins that it makes **no request** and has **no submit path**.

## 4. The test clock (decision 6)

**Requirement:** the override is honored **only** for an authorized Test session on league 25625; production never honors it; it never changes the shared worker's global clock.

**Design (to be audited before it is built):** one function `nowFor(session)` is the only way the contract rules read "now". It returns the real clock unless the session is a validated Test session, the league is 25625, the caller is on the Test allowlist, and a bounded override value was set by Keith for that session. The value is **per session**, never stored in module state or an environment variable of the shared worker. (A deploy-config-only test clock, `TWR_TEST_NOW_MS`, already exists for trade deadlines and is documented as "unset in production"; it is a different mechanism and does not satisfy this ruling, because the shared worker also serves the live league.)

**Negative tests that must pass before any contract write is built:** a production session sending an override is ignored and logged; a Test session naming league 74598 is refused; two concurrent requests (one overridden) do not affect each other; no global or environment state is read or written by the override path; the override is consulted only through `nowFor`.

**Which restrictions are whose.** The override moves only the clock inputs of **our** rules. MFL applies its own real-time rules regardless, and a request MFL refuses is refused. Every evidence pack records both decisions.

| Enforced by our worker (the override can move these) | Enforced by MFL (the override cannot affect these) |
|---|---|
| Contract windows and the pre-season ladder (§B3, §C4, §C5) | Roster limits and lineup validity (for example a bye-week starter is rejected) |
| Tag, extension and restructure deadline locks | Whether a contract or salary import is accepted |
| Extension history, restructure counts, loaded-contract limit, MYM limit | Kickoff lineup locks, waiver rules, transaction limits |
| Caller authorization and the league guard | Lockout and commissioner-impersonation behavior |
| Cap and cut-penalty calculations | MFL's own timestamps and data |

**B's refusal cases (paired):** with no override, a closed window must be refused by our worker and write nothing; with the override, the worker allows it and **MFL's response is what the evidence pack reports**. *Unverified:* that every contract route reads "now" through one resolver. Auditing every `Date.now()` and `new Date()` on those routes is the first task of the clock PR.

## 5. Dependencies

| Dependency | State today | Needed for | Approval needed |
|---|---|---|---|
| #1477 Preview 0 | Draft; deployed to the preview address; Keith's review in progress | Everything in the R track | Keith's review and merge decision (separate) |
| #1480 (checklist and this document) | Draft, docs only | Planning record | Merge is only a record |
| #1465 bug-report backend (private D1) | Draft, flag off, migration unapplied | Report a bug (W1) | **Keith's go for the migration and the flag** (production change) |
| #1476 beta sessions and gate (Stage 1) | Draft | Sign-in handoff and identity (F3) | Keith's go to implement and enable |
| #1474 Report bug in the classic app | Draft | Not needed by the beta (the beta has its own surface) | None for the beta |
| Worker environment guard and beta-tagged requests (F1) | Not started | Every Test write | Own PR, own approval |
| Test clock (F2) | Not started | Contract flows (W5-W8) | Own PR, own approval |
| Discord routing of reports to #keiths-test | **Not found in the worker code I read**; the older report route keeps reports in a repo file under `site/reports/` (`bugReportsFilePath`), which the Pages workflow publishes | W1 | Confirm and pin by a test; never use the public-file path |
| Test league 25625 readiness (rosters synced, commissioner act-as, lockout off) | Not read | W2 onward | A read-only report of what 25625 holds needs Keith's go |
| Contract change gate (`docs/CHANGE_PLAYBOOK.md` §0) | Standing rule | Any client that computes contract fields (W5-W8) | Per PR |
| D1 budget (`docs/D1_QUERY_RULES.md`) | Standing rule | Any new or changed query | `rows_read` measured per route |
| Codex review | Standing rule | Every PR | None |

## 6. PR sequence

Each PR is a draft with one outcome, passes the safe suite (merge result named), goes through Codex, and stops for Keith. **No PR deploys, merges or enables anything on its own.**

**R track: read-only parity (Preview build)**
| ID | Outcome | Depends on |
|---|---|---|
| **R1** | **Beta build foundation** (the first build scope, section 9) | #1477 decision |
| R2 | Team › Roster parity: four views, slot tags, summaries, row chips, opponent and kickoff, view-only week selector | R1 |
| R3 | Team › Contracts tab, information sheets, Cap & picks wording | R1 |
| R4 | Player profile parity: Performance, Schedule, Contract deadlines, More (News and Bio Unavailable), Helmet placeholder | R1, R2 |
| R5 | Actions button, Actions sheet and every review sheet, Submit disabled, artifact scan | R1, R4 |
| R6 | Home lineup card and Fix lineup shortcut | R2 |

**F track: foundation for writes (worker and shared)**
| ID | Outcome | Depends on |
|---|---|---|
| F1 | Environment guard: Test sessions refused for any league but 25625; beta-tagged request classification; negative tests | none |
| F2 | Test clock (`nowFor`) with the negative tests in section 4 | F1 |
| F3 | Sign-in handoff and identity in the beta (the #1476 path) | F1 |
| F4 | Write ledger, MFL read-back harness and evidence-pack tooling (test only) | F1 |

**W track: real transactions, Test build only (decision 7 order; each needs its evidence pack accepted before the next)**
| ID | Flow | Depends on |
|---|---|---|
| W1 | **Report a bug**, routed only to #keiths-test | F1, F3, #1465 |
| W2 | Lineup (start, swap, empty, save, week selector writes, future-week experiments) | W1 accepted, F4 |
| W3 | Roster moves (IR, Activate, Call up, Return to taxi) | W2 accepted |
| W4 | Drop (with the worker's penalty and the lineup effect) | W3 accepted |
| W5-W8 | Extend, Restructure, MYAC, MYM (one PR each) | W4 accepted, F2, contract gate |

Then the planning record's later stages (results review, Beta button, invited beta, live writes one flow at a time on Keith's separate approval).

## 7. Acceptance criteria

**Every PR:** draft, one outcome, safe suite green with the tested merge result named, Codex verdict recorded (and its source, if relayed), checklist rows flipped only with evidence, mutation check for new tests, no deploy, American spelling, Keith's approval.

**R PRs:** side-by-side screenshots of the demo and the beta at **320 and 375 px for the same player and skin**, with measured geometry (the header comparison is the bar: within half a pixel); loading, failed, offline and partial states; **unknown is never zero**; the Preview artifact scan passes (no submit module, no non-GET request, no write verb); `rows_read` measured for any new read; 12 px text and 44 px targets.

**F PRs:** the negative tests listed for that PR pass; production behavior is unchanged (a golden test); no environment setting on the shared worker changes global behavior.

**W PRs (evidence pack, test league 25625):** before snapshot; request with secrets redacted; MFL response; after snapshot read independently from MFL with caches bypassed; diff against intent; D1 rows written; side effects checked (Discord, email, repo files); cap before and after; **negative cases that each write nothing** (wrong team, expired session, closed window, over the cap, double submit, MFL outage, partial failure); restore step; the Test-vs-Live comparison for that flow; result states `confirmed`, `unconfirmed`, `mismatch`, `refused`. A dry run is never accepted as proof of no side effects.

**W1 (Report a bug) additionally:** reachable from every screen and from inside every sheet (a test enumerates them); carries the current screen and the captured error; no session, cookie or credential in the payload (a scan); reaches **only #keiths-test**; stored privately, never in a public file; behind a flag.

## 8. What is not verified

No route in this document was exercised. Not read: the state of league 25625; whether the contract routes share one clock resolver; the worker's Discord routing for reports; whether `/api/league-events` carries every date the Deadlines list needs; whether the notice-deadline facts for the lineup-issue sheet are readable; whether a per-week role can be derived; `rows_read` for any route; real iPhone Safari. The audit is a first pass; each R PR repeats it for its own screens before building.

## 9. First concrete build scope: R1, "Beta build foundation"

**Outcome:** the Preview build can safely take shared modules, proves it contains no write code, has a labeled Sample-mode skeleton, and shows the one parity item that has no data dependency. **No worker change, no new route, no Actions, nothing deployed.**

**Changes (all under `apps/mobile2027/` and `tests/`):**
1. **Build target field.** `build-manifest.json` and the page configuration record `mode: "preview"`. A test pins that the Preview artifact has that mode and that no other mode builds yet.
2. **Shared-module intake.** A `SHARED` allowlist in `scripts/build.mjs` copies named files from `site/shared/` byte for byte and verifies their SHA-256 against the repo. First intake: only files the next PRs need and that scan clean of write code (`injury_status.js`, `contract_windows.js`, `taxi_rule.js`, `cap_math.js`). The deploy script's checks extend to them.
3. **Write-code scan.** A test over the built Preview tree fails on any non-GET request, `method:` other than GET, `FormData`, a file named like a submit module, or a write verb outside comments.
4. **Sample-mode skeleton.** A client-only store and a visible "Sample data" label; a test pins A14: zero requests and no submit path.
5. **Environment marker.** "Preview: view only" (checklist A12).
6. **Helmet placeholder** (checklist F2, Decision 3): the labeled dashed "Helmet TBD" circle on the profile photo exactly as the demo draws it, with the demo-versus-beta screenshots at 320 and 375 px and measured geometry.

**Not in R1:** any data read, any Actions UI, any worker or D1 change, any change to `site/`.

**Acceptance:** section 7's every-PR and R-PR criteria; checklist rows A12, A14 and F2 flipped with evidence; the intake and scan tests with a mutation check; full safe suite green; draft PR; Codex review; **no deploy** (a preview deployment of R1 is a separate approval).

**Estimated size:** small (build script, one shared-module list, three tests, one component, CSS for the placeholder).

## 10. Decision requested

**Approve R1 as the first build scope?** Recommended: yes. Approval would authorize implementing R1 on a draft branch only. It would **not** authorize deployment, any worker change, any write flow, or any later PR in the sequence; each of those returns to Keith.
