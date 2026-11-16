# UPS_V2 Master Plan v8

2027 redesign: mobile first, read-only first, one reviewed release at a time.

## Status

- **Direction approved by Keith, 2026-11-16:** mobile first, read-only first, one reviewed release at a time.
- **Not approved by that ruling:** a test-site build, hosting, any production read, any league write, any merge or deployment.
- **Open decisions (kept open on purpose):** test environment, contract authority, contract event ledger, test clock.
- This document is `pending_review` in the artifact registry until Keith approves it for use. `MASTER_PLAN_v7.md` is kept unedited for history and is marked superseded only on that approval.
- A recommendation in this plan is not a decision. Items marked **[unverified]** were not checked.

## Why v8

v7 (approved seed, March 2026) cannot deliver a mobile build soon:

- It locks 2027 test-site work until its Phase 11, and its Phase 2 never closed.
- It describes a separate repository on SQLite and BigQuery. The live platform is a Cloudflare Worker, a D1 database and a GitHub Pages site in this repository (ADR-0002).
- Its surface inventory predates the mobile app, standings, UPS Center, the auction hub, stats and Game Day.

v8 replaces v7's sequence and stack assumptions and keeps its safeguards. Appendix A maps every v7 phase to its v8 home; Appendix B maps every safeguard. The change is recorded in ADR-0001.

## Release sequence

Each release is small, previewed on a phone, and approved separately. Read-only releases come first.

| # | Release | What an owner can do | Writes |
|---|---|---|---|
| 1 | Look around | New navigation, choose a skin, see My Team, open a player's contract card | None |
| 2 | Live and signed in | Same screens on current data, with "as of" times and working offline and outage states | None |
| 3 | League at a glance | Standings, scores, schedule | None |
| 4 | Research | Player search, stats, rules, UPS Center | None |
| 5 | Contract history | How each contract came to be, and where each fact came from | None to a league; needs the ledger decisions |
| 6 | First test contract action | One contract action, on a test environment only | Test environment only; separately approved |
| 7+ | Remaining tasks, one per release | Other contract actions, lineup, add/drop and waivers, trades, auction and rookie draft | Test environment only; each separately approved |
| Web | Desktop | Front Office, trades, commissioner tools, reports, thin MFL header | Same rule |
| Last | Cutover | Proposal to move owners to the new app | Separate decision; not authorized by v8 |

Releases 5 onward do not start until the decisions they depend on are made.

## The gate every release passes

1. **Audit** of current behavior for the surfaces touched, read from current `main`.
2. **Target and gap:** requirement, gap decision (`keep | replace | merge | split | deprecate | defer`), tap-count goal, who may do what.
3. **Data sources** confirmed against `data/source_of_truth_matrix.csv`; any new D1 query measured per `docs/D1_QUERY_RULES.md`.
4. **Rules** cited from `docs/league_context_v1.md`; open ambiguities resolved or logged; contract work follows `docs/CHANGE_PLAYBOOK.md` §0.
5. **Gate A (Keith):** one release brief holding steps 1 to 4. Build starts on approval.
6. **Build and test,** in the approved environment only.
7. **Preview and evidence:** phone-openable HTTPS link, 320 px and 375 px screenshots, measurements, accessibility results, parity, isolation proof, and the list of what was not verified.
8. **Independent review** of the diff by a reviewer not given the builder's conclusions.
9. **Gate B (Keith):** phone review. The outcome is "accepted on test" only. Production is a separate decision at cutover.

Rollback before cutover: remove the release from the test site. Production is never involved.

## Release 1: Look around

**Scope.** A new app shell in its own directory, with the live mobile app untouched. Task navigation, three skins, My Team, and a player contract card. It reads a recording of existing sources. No ledger, no history backfill, no sign-in, no write code.

**Source check (2026-11-16).** The tracked MFL export snapshot dated 2026-11-15 was checked by field names and counts:

- All 489 rostered players carry salary, years left, contract status, total value, average value and contract length.
- All 318 multi-year contracts carry per-year salaries and a guarantee figure. The 171 one-year contracts carry the single salary.
- The roster, salary and league files contain no message, comment, note or email fields.
- Two gaps: the snapshot has player ids but no names or positions, and it is MFL's raw record, not the repaired view Front Office shows. Each needs a ruling before the release brief is approved.

**Acceptance criteria.**

- **Opens** from an HTTPS link on a phone with no sign-in.
- **Navigation.** One navigation definition for the whole app. Every task area is reachable from the bottom bar or one menu; areas not yet built say what will be there. My Team to a contract card in 2 taps.
- **Skins.** Light, dark and high-contrast; the choice is remembered. Every skin passes an automated contrast check (text at least 4.5:1; 7:1 in high-contrast).
- **Accessibility.** Pinch-zoom works; usable at 200% zoom on a 320 px screen with no sideways scroll; no text under 12 px; tap targets at least 44 px; status never shown by color alone; reduced-motion honored.
- **My Team.** Active, taxi and injured-reserve groups; salary, years left and contract status per player; cap summary.
- **Contract card.** Salary by year, years left, status, total value, average value and guarantee as recorded, each labeled with its source and the recording time. No history and no action buttons.
- **Parity.** An automated comparison of every rostered player's terms against the agreed reference, with any difference listed and explained.
- **Isolation proof.** A full click-through logs zero requests outside the test site and zero non-read requests; the build is made from an allowlist; a private-text scan passes on the local build.
- **Evidence.** 320 px and 375 px screenshots in each skin; measured performance reported next to the approved targets; independent review.
- **Stated as unverified** until Keith runs it: real iPhone Safari.

**Performance targets are proposals until measured and approved.** Proposed for release 1: at most 150 KB of compressed script before the first usable screen with no render-blocking scripts; at most 8 requests before the first usable screen; on a mid-range phone profile with a slow connection and cold cache, main content within 2.5 s, tap response within 200 ms, warm reopen within 1.0 s.

## Test environment options (open)

v7 named league 25625 as the writable test target. v8 does not carry that assumption forward. "Test site only" does not authorize writes to any league; each write release names its environment and is approved on its own.

| Option | Contains | Can it change a league? | Isolation proof |
|---|---|---|---|
| 1. Recorded data, no league | The new app plus a recording of read-only league data with free-text fields blanked | No: no write code, no sign-in, no worker address | Click-through request log; allowlist build; private-text scan |
| 2. Live read-only from league 74598 | Current production data through existing read routes | Not by the new app, but production write routes still exist | Request log plus a check that the app sends only read requests |
| 3. League 25625 on the shared worker and database | Whatever 25625 holds **[unverified]** | Yes, 25625 | Weak: league comes from each request; test and production share one database and worker |
| 4. League 25625 with its own worker and database | A copy of rosters and salaries without free text | Only 25625 | Test worker holds no production credentials, runs no scheduled jobs, and refuses other leagues before any network call; production unchanged after the suite |
| 5. A new 2027 lab league with its own worker and database | 2027 settings and seeded rosters | Only the lab league | Same as option 4 |

## Open decisions

None is implemented from a recommendation. Release 1 depends only on hosting and its two source rulings.

- **Hosting and access** for the test site. Needed before the release 1 preview.
- **Release 1 source rulings:** where player names come from, and whether the card shows MFL's raw record or must match Front Office's repaired view.
- **Live environment and sign-in.** Needed before release 2.
- **Contract authority.** Which record wins when UPS and MFL disagree: MFL wins; a UPS record wins and MFL is the published copy; or today's mix. A change of authority requires every active contract's history to be loaded and reconciled first, with a ruling per mismatch; until then nothing changes for existing contracts. Needed before release 5.
- **Contract event ledger.** Whether and how to keep one complete event record per contract action (who, when, terms before, terms intended, what MFL shows afterward). A backfill copies existing records and changes none. Needed before release 5.
- **Test clock.** Whether a test environment may run as a different date so closed contract windows can be exercised. It must be impossible in production before it exists anywhere. Needed before release 6.
- **Write environment and first contract action.** Needed before release 6.
- **Warehouse.** Whether BigQuery (v7 Phase 12) is retired or deferred.

## Standing rules carried from v7

- Anti-scope-creep: a release ships only what its approved brief lists. Everything else goes to the parking lot.
- Publish object model, workflow states, warning and block policy, evidence confidence and parity definition are unchanged.
- Authoritative readback: no publishable unit requiring `MFL_readback` is complete until verification succeeds or the unit is marked `failed` or `reverted`.
- Documentation gate: no cutover approval is valid unless the required documents are present and approved. Each release closes with a short completion report.
- Privacy: test builds are made from an allowlist and scanned for owner-written text before any preview. Containment of existing exposure is handled in Keith's private project, not in this repository.

## Model routing (proposal)

| Work | Model tier |
|---|---|
| Plan revisions, decision records, cross-release rule synthesis | Most capable |
| Worker changes touching sign-in, permissions or contract writes | High |
| Release implementation, tests, harnesses | Standard |
| Inventories, duplicate searches, size tables, screenshots, formatting | Fastest |
| Review of every release diff | Independent reviewer |

One integrator per release; no two agents edit the same files.

## Appendix A: v7 phases mapped to v8

| v7 phase | v8 home | Change |
|---|---|---|
| 0 Program setup | This revision | First real decision records |
| 1 Current-state audit | Gate step 1, per release | Audited per release against current `main`; the inventory gains the missing surfaces as they are touched |
| 2 Target requirements and gap | Gate step 2, per release | Approved per release; the actor-permission matrix is filled as tasks arrive |
| 3 Signal intelligence, observability | Release 1 measurement harness; lanes deferred | Privacy boundary unchanged |
| 4 MFL and event matrix | Gate step 4, per release | Each release cites its windows and endpoints; order follows the 2027 calendar |
| 5 Business truth, rule governance | Standing rules | Canon, source-of-truth matrix and ambiguity register apply to every release; contract authority reopened as a decision |
| 6 Canonical data platform | Open decisions (ledger, environment) | SQLite and BigQuery replaced by the actual platform (ADR-0002) |
| 7 Raw evidence, history | Release 5 | Depends on the ledger decision |
| 8 Runtime isolation and config | Each environment's isolation proof | Hardcoded league values listed per release |
| 9 Jobs, environments, safety rails | Environment decision; each write release | Publish model applied to every write |
| 10 Site and workflow rebuild | Releases 1 to 7+, then web | Same task-first goal, mobile first, read-only first |
| 11 2027 future lab | Environment options 4 and 5 | No longer a late phase; an explicit choice |
| 12 Warehouse, reporting | Open decision | BigQuery not adopted |
| 13 Parallel run, cutover, docs | Cutover | Unchanged; separate decision |

## Appendix B: v7 safeguards in v8

| Safeguard | Treatment |
|---|---|
| Audit, then target, then gap, before build | Kept, per release |
| Anti-scope-creep | Kept |
| Phase re-entry by decision record and revision log | Kept; v8 enters this way (ADR-0001) |
| Publish model and MFL readback rule | Kept; made concrete only after the ledger decision |
| Workflow states, warning and block policy, evidence confidence, parity definition | Kept unchanged |
| Environment separation | Kept and reopened as an explicit choice with proofs |
| Documentation gate, completion reports | Kept: one short report per release |
| "Presence is not approval" | Kept: v8 is `pending_review` until approved |
| League-rule canon and contract change gate | Kept unchanged |
| Privacy | Strengthened: allowlist builds and a private-text scan |

## Appendix C: duplicates to retire

Each is retired in the release that replaces it, never in bulk. Release 1 retires none.

- Mobile mirror files copy the old Roster Workbench while desktop runs Front Office v2.
- Drop penalty, the contract-write helper, money parsing and tag price each exist in several copies across mobile, Front Office v2 and the old Roster Workbench.
- Several separate tab-bar definitions in the mobile app; two standings pages; three player panels; three bid sheets.
