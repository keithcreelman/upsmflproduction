# UPS 2027 Preview 0

A read-only preview of two redesigned phone screens, Team roster and Player profile (with its Contract tab), showing real public league data and player headshots. It lives in its own folder, outside `site/`, so merging it cannot publish it to GitHub Pages, and it does not touch the current mobile app (`site/m/`).

Approved scope and limits: issue #1475 (Preview 0 approval, 2026-11-20). Nothing here signs in, saves, drops, extends, bids or trades.

## What it reads

Four public GET paths on the UPS worker, nothing else. `src/lib/data.js` refuses every other address before the network is touched.

| Read | Used for |
|---|---|
| `/roster-workbench?L&YEAR` | rosters, contracts (the Front Office read, with its AAV repair), roster status, ESPN ids |
| `/api/mfl-export?TYPE=league` and `TYPE=weeklyResults&W` | roster limits; the lineup MFL holds for the current week |
| `/api/current-lineup-week` | which week that is |
| `/api/cap-penalty/preview?L&YEAR` | earned to date, guarantee and cut cost, as the worker calculates them (fetched when the first profile is opened) |

Photos load from ESPN, then MFL's own thumbnail, then a neutral placeholder (the order the current app uses).

The profile header is colored by the player's NFL team, as in the approved "Player Profile Look" prototype: the team color is the ground (nudged only as far as needed for readable text: 4.5:1, or 7:1 in High contrast), the secondary color is the stripe and the photo ring, with the name, team, position, type and status pills on it. An unknown team or a free agent gets a neutral slate. The page forbids inline styles, so every team and skin is a rule in `src/team-colors.css`, written by `scripts/team_colors.mjs` (`node apps/mobile2027/scripts/team_colors.mjs`, or `--check`); a test fails if the file is not the generator's exact output. Colors are ESPN's public team data (read 2026-11-18). No logos, no helmet art.

## What is deliberately not here

Any action; cap space; the Team › Contracts and Cap & picks tabs; injury status, projections, game log, schedule, news, bio; sign-in; the helmet badge (no verified helmet art exists, so none is drawn or implied). A missing fact reads "Not available" or "Not recorded", never `$0`.

## Choices that go beyond the approved prototypes (each is easy to change)

- The Contract tab opens first (the prototype opens Performance), because it is the tab built in Preview 0.
- Four bottom tabs (Home, Team, Market, League), the layout Keith leans toward; unresolved.
- The roster has two views, Lineup and Contracts. Performance and Byes need data not in Preview 0.
- Vibrant position colors are on by default, as in the prototype; Plain turns them off (About › Display).
- A team picker, because there is no sign-in to say whose team to show.
- Earned to date says "Full-year rule" or "Not applicable" exactly when the worker says so. The prototype's newer one-year `$1,000` ruling (CC-1) is not in the worker yet, so it is not shown.

## Run, test, build, deploy

```bash
node apps/mobile2027/scripts/build.mjs --dev                    # a local working copy in apps/mobile2027/dist-dev (dirty tree allowed; never deployable)
python3 -m http.server 8741 --directory apps/mobile2027/dist-dev   # open http://localhost:8741 (reads the live public routes)
node tests/mobile2027_preview0.test.mjs                         # offline; or: node scripts/safe_tests/run.mjs
node apps/mobile2027/scripts/build.mjs                          # clean tree only: writes apps/mobile2027/dist, prints the source commit and artifact digest
node apps/mobile2027/scripts/build.mjs --write-lock             # re-pin the shared modules, after reviewing a change to one of them
node apps/mobile2027/scripts/deploy_preview.mjs apps/mobile2027/dist            # dry run: prints the plan
node apps/mobile2027/scripts/deploy_preview.mjs apps/mobile2027/dist --execute  # publishes to the preview address only
```

The deploy script's project (`ups-mobile-beta`) and branch (`preview`) are constants. It has no way to name the production branch. It trusts nothing in `build-manifest.json`: it requires the file list to equal the build allowlist, re-hashes every file, recomputes the artifact digest, and refuses unless the manifest's source commit is the commit checked out now, the tree is clean (in a dry run too), and every built file is byte for byte that commit's source file.

## Build target, shared code and Sample mode (R1)

**Build target.** `config.js` names the build mode (`preview`) and the manifest records it. The build only makes `preview`; the deploy script refuses any other mode. A Test build (write modules, league 25625) is a later, separately approved stage.

**Shared code, used directly.** The build copies `site/shared/contract_windows.js` and `site/shared/taxi_rule.js` into the artifact **byte for byte**, so there is one copy of those rules. Each is pinned by SHA-256 in `shared.lock.json`: a change made for the classic app stops this build until someone reviews it and runs `build.mjs --write-lock`. The deploy script re-checks that the built bytes equal the repository file.

**Why not twins in R1.** Nothing in R1 needs a generated calculator twin. The two modules above are pure and load as they are. Two shared modules are left out on purpose, and the write-code scan refuses them (a test proves it on the real files): `cap_math.js` calls the worker itself and hard-codes league 74598; `injury_status.js` carries a loader that calls `fetch`, a second network path. Stage R2 takes the pure injury resolver either as a reviewed exception proven dormant or as a generated twin. A twin becomes necessary at R5: the extension, restructure, MYAC and MYM calculators sit in the same classic files as the submit code (`site/m/front_office_*_submit.js`), which the Preview build may not contain. Those will be generated from the originals by a script, with an equivalence test over recorded fixtures (the `taxi_rule` pattern), never hand-copied. Today's contract parsing is already checked against `site/shared/cap_math.js` for every recorded player (see the contract tests).

**Write-code scan.** Every script and page in the artifact is scanned at build time and again by the tests: no `FormData`, `XMLHttpRequest`, `sendBeacon`, `WebSocket`, `eval`, write verbs, request method other than a literal GET, credentials other than `omit`, no file named like a submit or save module, and no reference to `fetch` outside `lib/data.js` (and the line in `app.js` that hands it the page's `fetch`). Comments are ignored.

**Sample mode** (`lib/sample.js`, About › Sample mode). A client-only store, off at every start and never remembered. While it is on the page makes no request at all (a test counts them), the label reads "Sample data · nothing is real and nothing is sent", and no league data is drawn. No scenario is installed yet; they arrive with the screens that use them. **The marker** at the top of every screen reads "Preview: view only".

**Helmet placeholder.** The profile photo carries the demo's labeled dashed "Helmet TBD" circle. No helmet art exists, and none is drawn.

## Files

`src/index.html` (content policy: the worker for data, ESPN and MFL for images, nothing else) · `src/lib/data.js` (the only network code) · `contract.js` · `model.js` · `views.js` · `photo.js` · `sample.js` · `format.js` · `src/app.js` (taps and drawing) · `src/styles.css` · `src/team-colors.css` (generated) · `shared.lock.json` · `scripts/build.mjs`, `scripts/deploy_preview.mjs`, `scripts/team_colors.mjs` · tests in `tests/mobile2027_preview0.test.mjs` with a trimmed recording of the public routes in `tests/fixtures/mobile2027/`.
