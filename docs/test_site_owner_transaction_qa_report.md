# TEST site owner transaction QA report

## Executive summary

- This pass covered the public-facing TEST site (`25625`) against the REAL production site (`74598`) using live page fetches plus repo-backed loader mapping review.
- The owner-facing module parity story is not clean: production has active CCC, reports, and owner-widget mounts that TEST is missing in several message slots and on the home page.
- A true end-to-end transaction execution review could not be completed because no authenticated franchise session or owner cookie was available. All direct trade/owner routes (`O=05`) redirected correctly to login, which means add/drop, promote/demote, IR, taxi, contract, and player-action modal flows remain blocked for execution testing in this run.
- One league-setting mismatch is already confirmed from live exports: TEST has `lockout=No` while REAL has `lockout=Yes`. That alone means parity is not yet trustworthy for transaction-path QA.

## Scope tested

- Home page loader behavior on TEST and REAL.
- Roster / Front Office public render on `O=07`.
- Auth gating on trade/owner route `O=05`.
- Player detail page public render.
- Message slot parity for `MESSAGE2`, `MESSAGE5`, `MESSAGE8`, `MESSAGE9`, and `MESSAGE15`.
- Live `TYPE=league` export parity for settings relevant to owner behavior.

## Test matrix

| Status | Count |
| --- | --- |
| Blocked | 1 |
| Fail | 5 |
| Needs Review | 2 |
| Pass | 6 |

| Test ID | Module / page | Transaction type | Status |
| --- | --- | --- | --- |
| QA-001 | TEST home | Header/footer partial load | Pass |
| QA-002 | REAL home | Header/footer partial load | Pass |
| QA-003 | TEST vs REAL home | HPM parity | Fail |
| QA-004 | MESSAGE2 | CCC module parity | Fail |
| QA-005 | MESSAGE5 | Owner widget parity | Fail |
| QA-006 | MESSAGE8 | Trade / extension helper parity | Needs Review |
| QA-007 | MESSAGE9 | Reports module parity | Fail |
| QA-008 | MESSAGE15 | MCM / HPM parity | Needs Review |
| QA-009 | O=05 trade action route (TEST) | Owner transaction gate | Pass |
| QA-010 | O=05 trade action route (REAL) | Owner transaction gate | Pass |
| QA-011 | Rosters O=07 (TEST) | Roster / Front Office render | Pass |
| QA-012 | Rosters O=07 (REAL) | Roster / Front Office render | Pass |
| QA-013 | Player detail page | Player action / modal shortcut path | Blocked |
| QA-014 | League export parity | League configuration parity | Fail |

## Pass/fail summary

- Passed: public home/header/footer loads, public roster rendering, and expected login gating on owner-only trade route.
- Failed: home widget parity, CCC message-slot parity, widget message-slot parity, reports message-slot parity, and league `lockout` setting parity.
- Needs review: `MESSAGE8` and `MESSAGE15` because TEST and REAL are not using the same implementation path, but the live intent of those slots is not fully documented from the frontend alone.
- Blocked: all true owner transaction execution paths, including add/drop, promote/demote, IR, taxi, contract actions, and trade launches from roster/player context.

## Detailed findings

### QA-001 — TEST home

- Transaction type: Header/footer partial load
- Preconditions: Guest session, no auth cookie.
- Steps taken: Fetched https://www48.myfantasyleague.com/2026/home/25625 and inspected injected scripts.
- Expected result: Header and footer partials should load through the shared UPS loader.
- Actual result: TEST home loads `site/loader.js` with `data-ups-partial="header"` and `footer` plus standings loader.
- Status: Pass
- Notes: Parity is partial only; owner widget is missing relative to prod.

### QA-002 — REAL home

- Transaction type: Header/footer partial load
- Preconditions: Guest session, no auth cookie.
- Steps taken: Fetched https://www48.myfantasyleague.com/2026/home/74598 and inspected injected scripts.
- Expected result: Header, footer, standings, and active production HPMs should load.
- Actual result: REAL home loads header/footer, standings, and `ups_options_widget_embed_loader.js`.
- Status: Pass
- Notes: Confirms prod is ahead of TEST for owner widget deployment.

### QA-003 — TEST vs REAL home

- Transaction type: HPM parity
- Preconditions: Public home pages available.
- Steps taken: Compared home-page script includes between league 25625 and 74598.
- Expected result: TEST and REAL should load the same owner-facing home HPM set unless intentionally divergent.
- Actual result: REAL home loads `site/ups_options_widget_embed_loader.js`; TEST home does not.
- Status: Fail
- Notes: Likely missing TEST home registration for the Owner Hub widget or stale TEST `UPS_RELEASE_SHA` deployment.

### QA-004 — MESSAGE2

- Transaction type: CCC module parity
- Preconditions: Public HPM route accessible.
- Steps taken: Fetched `?MODULE=MESSAGE2` on TEST and REAL and inspected script includes.
- Expected result: TEST should load the same Contract Command Center embed as REAL.
- Actual result: REAL MESSAGE2 mounts `site/ccc/mfl_hpm_embed_loader.js`; TEST MESSAGE2 has no CCC mount.
- Status: Fail
- Notes: Missing TEST registration for the CCC HPM slot.

### QA-005 — MESSAGE5

- Transaction type: Owner widget parity
- Preconditions: Public HPM route accessible.
- Steps taken: Fetched `?MODULE=MESSAGE5` on TEST and REAL and inspected script includes.
- Expected result: TEST should load the same widget HPM as REAL.
- Actual result: REAL MESSAGE5 loads `site/ups_options_widget_embed_loader.js`; TEST MESSAGE5 does not.
- Status: Fail
- Notes: Missing TEST message-slot wiring for the widget HPM.

### QA-006 — MESSAGE8

- Transaction type: Trade / extension helper parity
- Preconditions: Public HPM route accessible.
- Steps taken: Fetched `?MODULE=MESSAGE8` on TEST and REAL and inspected HTML payloads.
- Expected result: If MESSAGE8 is an owner helper module, TEST and REAL should carry the same content path.
- Actual result: TEST MESSAGE8 loads `site/ccc/extension_assistant.css/js`; REAL MESSAGE8 does not expose the same include pattern.
- Status: Needs Review
- Notes: May be an intentional TEST-only helper, but parity is not there today.

### QA-007 — MESSAGE9

- Transaction type: Reports module parity
- Preconditions: Public HPM route accessible.
- Steps taken: Fetched `?MODULE=MESSAGE9` on TEST and REAL and inspected script includes.
- Expected result: TEST should load the same reports HPM as REAL.
- Actual result: REAL MESSAGE9 mounts `site/reports/mfl_hpm_embed_loader.js`; TEST MESSAGE9 serves static monthly-events content instead.
- Status: Fail
- Notes: TEST slot not registered to the reports loader.

### QA-008 — MESSAGE15

- Transaction type: MCM / HPM parity
- Preconditions: Public HPM route accessible.
- Steps taken: Fetched `?MODULE=MESSAGE15` on TEST and REAL and inspected markup.
- Expected result: TEST and REAL should use the same MCM HPM registration path.
- Actual result: TEST MESSAGE15 still points at `@dev/site/loader.js?...data-ups-partial=hpm-mcm`; REAL MESSAGE15 does not use the same loader path.
- Status: Needs Review
- Notes: Likely stale TEST-only dev registration or a prod move to inline content that TEST did not mirror.

### QA-009 — O=05 trade action route (TEST)

- Transaction type: Owner transaction gate
- Preconditions: Guest session only.
- Steps taken: Requested `https://www48.myfantasyleague.com/2026/options?L=25625&O=05`.
- Expected result: Non-owner access should be blocked and redirected to login.
- Actual result: Route resolves to the MFL login page for TEST.
- Status: Pass
- Notes: Confirms the trade-action route is auth-gated; actual execution could not be validated without owner credentials.

### QA-010 — O=05 trade action route (REAL)

- Transaction type: Owner transaction gate
- Preconditions: Guest session only.
- Steps taken: Requested `https://www48.myfantasyleague.com/2026/options?L=74598&O=05`.
- Expected result: Non-owner access should be blocked and redirected to login.
- Actual result: Route resolves to the MFL login page for REAL.
- Status: Pass
- Notes: Prod and TEST behave the same for unauthenticated trade-route access.

### QA-011 — Rosters O=07 (TEST)

- Transaction type: Roster / Front Office render
- Preconditions: Guest session only.
- Steps taken: Fetched `options?L=25625&O=07` and inspected roster HTML.
- Expected result: Roster tables, contract fields, and trade history labels should render.
- Actual result: Roster table loads publicly with salary, contract year, contract status, contract info, and acquisition source columns.
- Status: Pass
- Notes: No owner action controls could be executed from guest context.

### QA-012 — Rosters O=07 (REAL)

- Transaction type: Roster / Front Office render
- Preconditions: Guest session only.
- Steps taken: Fetched `options?L=74598&O=07` and inspected roster HTML.
- Expected result: Roster, taxi, and contract sections should render.
- Actual result: REAL roster page loads active roster plus taxi squad sections and detailed contract strings.
- Status: Pass
- Notes: Useful for public verification, but still not enough to validate owner execution flows.

### QA-013 — Player detail page

- Transaction type: Player action / modal shortcut path
- Preconditions: Guest session only.
- Steps taken: Fetched player detail page for Malik Nabers on TEST and REAL.
- Expected result: Owner-only action controls should either render for owners or be hidden for guests.
- Actual result: Guest view shows contract data but not actionable owner controls.
- Status: Blocked
- Notes: Need authenticated franchise session to validate add/drop, trade launch, IR/taxi, and contract action modals from player view.

### QA-014 — League export parity

- Transaction type: League configuration parity
- Preconditions: Public `TYPE=league` export accessible.
- Steps taken: Compared TEST and REAL `TYPE=league&JSON=1` payloads.
- Expected result: Critical owner-behavior settings should match between TEST and REAL unless intentionally varied.
- Actual result: Most core settings match, but TEST has `lockout=No` while REAL has `lockout=Yes`.
- Status: Fail
- Notes: This setting divergence can materially change transaction behavior and should be normalized before parity testing is considered complete.

## HPM parity analysis

### Confirmed matches

- Both TEST and REAL home pages load the shared UPS header/footer partials through `site/loader.js`.
- Both TEST and REAL home pages load the standings HPM through `site/standings/mfl_hpm_embed_loader.js`.
- Both TEST and REAL roster pages (`O=07`) render contract-heavy roster tables publicly.
- Both TEST and REAL send unauthenticated `O=05` requests to the login page.

### Confirmed mismatches

- REAL home loads `site/ups_options_widget_embed_loader.js`; TEST home does not.
- REAL `MESSAGE2` mounts `site/ccc/mfl_hpm_embed_loader.js`; TEST `MESSAGE2` does not.
- REAL `MESSAGE5` mounts the owner widget loader; TEST `MESSAGE5` does not.
- REAL `MESSAGE9` mounts `site/reports/mfl_hpm_embed_loader.js`; TEST `MESSAGE9` does not.
- TEST `MESSAGE8` is loading `site/ccc/extension_assistant.css/js`, while REAL is not using the same path.
- TEST `MESSAGE15` still references a dev `hpm-mcm` loader path; REAL `MESSAGE15` is not using that same include path.
- TEST `TYPE=league` export has `lockout=No`; REAL has `lockout=Yes`.

### Missing registrations / config points to verify

- MFL home page custom HTML on TEST for header/footer/home widget registrations.
- MFL message-slot assignments for TEST `MESSAGE2`, `MESSAGE5`, `MESSAGE8`, `MESSAGE9`, and `MESSAGE15`.
- Which SHA TEST should be running versus REAL `UPS_RELEASE_SHA`.
- Whether `MESSAGE8` is intended to be `hpm-ext-assist`, chat, or another owner helper in production.

### Repo files and config points to inspect

- `site/README.md` for the canonical message-slot mapping.
- `site/loader.js` for shared partial resolution.
- `apps/mfl_site/header_custom_v2.html` for route guards, hot links, and module-launch logic.
- `site/ccc/mfl_hpm_embed_loader.js` for CCC embed behavior.
- `site/reports/mfl_hpm_embed_loader.js` for reports embed behavior.
- `site/ups_options_widget_embed_loader.js` for owner widget behavior.
- `site/hpm-mcm.html` and `site/hpm-ext-assist.html` for TEST-only message-slot content.

## Recommended fixes

- Normalize TEST to the production message-slot map before deeper owner QA: add CCC to `MESSAGE2`, widget to home and `MESSAGE5`, reports to `MESSAGE9`, and reconcile `MESSAGE8`/`MESSAGE15`.
- Align TEST league settings with REAL, especially `lockout`, before relying on transaction-path results.
- Pin TEST to the intended release SHA and remove stale dev-loader references from TEST-only message content.
- Provide a disposable owner login for TEST or a sanctioned cookie-based test account if you want actual add/drop, taxi, IR, contract, and trade execution verified.

## Open questions / blockers

- No owner credentials or franchise cookie were available, so every execution path that requires ownership context is still blocked.
- No browser-interactive session with JS clicks/forms was available here; findings are based on live HTML payloads, exports, and repo source inspection.
- If TEST intentionally diverges from REAL for preview modules, that intent is not documented in the current frontend payloads and should be written down before more parity work.
