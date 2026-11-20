# UPS 2027 Preview 0

A read-only preview of two redesigned phone screens, Team roster and Player profile (with its Contract tab), showing real public league data and player headshots. It lives in its own folder, outside `site/`, so merging it cannot publish it to GitHub Pages, and it does not touch the current mobile app (`site/m/`).

Approved scope and limits: issue #1475 (Preview 0 approval, 2026-11-20). Nothing here signs in, saves, drops, extends, bids or trades.

## What it reads

Six public GET paths on the UPS worker (four from Preview 0, two added for Team › Roster), nothing else. `src/lib/data.js` refuses every other address before the network is touched.

| Read | Used for |
|---|---|
| `/roster-workbench?L&YEAR` | rosters, contracts (the Front Office read, with its AAV repair), roster status, ESPN ids |
| `/api/mfl-export?TYPE=league` and `TYPE=weeklyResults&W` | roster limits; the lineup MFL holds for the current week |
| `/api/current-lineup-week` | which week that is |
| `/api/player-status?season&L` (R2) | one injury chip per player, through the derived copy of the classic resolver (Team › Roster) |
| `/api/lineup-matchups?YEAR&W` (R2) | each NFL team's opponent, home or away and kickoff for a week; each player's points per final game |
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
node apps/mobile2027/scripts/check_shared.mjs                 # compare the pins with the real classic files (--notice never fails)
node apps/mobile2027/scripts/deploy_preview.mjs apps/mobile2027/dist            # dry run: prints the plan
node apps/mobile2027/scripts/deploy_preview.mjs apps/mobile2027/dist --execute  # publishes to the preview address only
```

The deploy script's project (`ups-mobile-beta`) and branch (`preview`) are constants. It has no way to name the production branch. It trusts nothing in `build-manifest.json`: it requires the file list to equal the build allowlist, re-hashes every file, recomputes the artifact digest, and refuses unless the manifest's source commit is the commit checked out now, the tree is clean (in a dry run too), and every built file is byte for byte that commit's source file.

## Build target, shared code and Sample mode (R1)

**Build target.** `config.js` names the build mode (`preview`) and the manifest records it. The build only makes `preview`; the deploy script refuses any other mode. A Test build (write modules, league 25625) is a later, separately approved stage.

**Shared code, used directly.** The build copies `site/shared/contract_windows.js` and `site/shared/taxi_rule.js` into the artifact **byte for byte**, so there is one copy of those rules. Each is pinned by SHA-256 in `shared.lock.json`. **A change made for the classic app never blocks the classic app's release.** The classic app's tests do not read these files for the beta (the beta's tests use reviewed copies in `tests/fixtures/mobile2027/shared/`), and `.github/workflows/beta-shared-check.yml` only adds a warning annotation to a classic pull request that touches one. What a classic change does is make the beta's pin stale: the beta's build and the deploy script then refuse that module (so nothing out of date can be published), and the deployed beta keeps the bytes it was reviewed with until Keith approves a new deploy. To take the change, someone reviews it, runs `node apps/mobile2027/scripts/check_shared.mjs` (pins, scan, loads without a request, and the contract parser against `cap_math.js` for every recorded player), runs `build.mjs --write-lock`, and brings the update through the beta's own pull request. The classic release is never involved.

**Why not twins in R1.** Nothing in R1 needs a generated calculator twin. The two modules above are pure and load as they are. Two shared modules are left out on purpose, and the write-code scan refuses them (a test proves it on reviewed copies of those two files): `cap_math.js` calls the worker itself and hard-codes league 74598; `injury_status.js` carries a loader that calls `fetch`, a second network path. Stage R2 takes the pure injury resolver as a derived, hash-pinned copy (see Team › Roster, below). A twin becomes necessary at R5: the extension, restructure, MYAC and MYM calculators sit in the same classic files as the submit code (`site/m/front_office_*_submit.js`), which the Preview build may not contain. Those will be generated from the originals by a script, with an equivalence test over recorded fixtures (the `taxi_rule` pattern), never hand-copied. Today's contract parsing is checked against `site/shared/cap_math.js` for every recorded player by `scripts/check_shared.mjs` (not by the classic-facing test suite).

**Write-code scan: a lint, one of four layers.** The Preview build can read and cannot write, and four layers keep it that way: (1) the build scan, a lint that refuses what it recognizes and does not claim to prove arbitrary JavaScript harmless; (2) the loader's own allowlist (six GET routes, the worker only, credentials omitted), which refuses before the network; (3) the page's content policy (`connect-src` names the worker only) and the response headers, both pinned to the reviewed text; (4) tests that run the real app against a fake `fetch` and count every request, including while Sample mode is on. The scan covers every script, the page, the style sheets and `_headers`, at build time, again by the tests, and again by the deploy script on the files it is about to publish. It refuses: network and write APIs (`FormData`, `XMLHttpRequest`, `sendBeacon`, `WebSocket`, `EventSource`, workers, `Request`, `Image`), `eval` and the `Function` constructor, dynamic `import`, computed access to the global object (`window[...]`), loading properties set from script (`.src =`, `.href =`, `location =`, `setAttribute("src", ...)`) outside the one image file, document write and create, template literals, escaped letters that could hide a name, write verbs, a request method other than a literal GET, credentials other than `omit`, files named like a submit or save module, and any reference to `fetch` except the single line in `app.js` (`guardedFetch`, which refuses while Sample mode is on). Comments are ignored by a small tokenizer that keeps strings, so `//` inside a string cannot hide code. In the page it refuses an inline script, style or event handler, a form, a frame, an image tag, a remote or protocol-relative address, a refresh, and any content policy other than the reviewed one; in `_headers`, any header not on the reviewed list. It is not a parser: string concatenation can still build a word the scan never sees, which is why layers 2 to 4 exist.

**Sample mode** (`lib/sample.js`, About › Sample mode). A client-only store, off at every start and never remembered. While it is on the page starts no NEW request of any kind: no data read (three guards, and a test that counts them, including when it is switched on while a read is out) and no photo (no screen drawn in Sample mode holds an image, so the browser has nothing to fetch; a test checks the drawn HTML, and a real-browser run counted zero new network entries). A request already on its way at the moment Sample mode is turned on is not recalled: a read that finishes late is discarded and never drawn, and a headshot already loading may finish, drawn by no screen. Turning it off reads the league again. the label reads "Sample data · nothing is real and nothing is sent", and no league data is drawn. No scenario is installed yet; they arrive with the screens that use them. **The marker** at the top of every screen reads "Preview: view only".

**Helmet placeholder.** The profile photo carries the demo's labeled dashed "Helmet TBD" circle. No helmet art exists, and none is drawn.

## Team › Roster (stage R2)

**What an owner sees.** Four views of the roster (Lineup, Performance, Contracts, Byes) under a week bar; slot tags on the 18 starters (QB1 … DF, canon §B4); the NFL opponent and kickoff on lineup rows; one injury chip per row; last week's points and the season average per final game; bye weeks; the IR and taxi cap notes; a "Needs you" chip on a bench group; summary lines; a view-only week selector.

**Two reads added** (existing public GETs, no worker change): `/api/player-status?season=&L=` and `/api/lineup-matchups?YEAR=&W=`, plus other weeks' results through the existing export route. Each address is asked for once, on the first visit that needs it, and kept in memory: six requests when the roster opens, then one more the first time Performance is opened (last week's results) and one more the first time a past week is chosen (that week's lineups and scores). After that, switching view, week or team asks for nothing. A read is asked again only after its freshness limit (injury status 4.5 minutes, NFL games 5 minutes, a week's results 1 hour) and only when the screen is used again. Measured on 2026-11-20: player-status 114 KB raw / 12.4 KB on the wire; lineup-matchups 107 KB raw / 17.9 KB on the wire; weekly results 85 KB raw. Only the fields the screens use are kept.

**Injury resolver: a derived copy, not a twin.** `site/shared/injury_status.js` mixes the pure resolver with a loader that calls `fetch`. The build cuts exactly the loader and its export entry from the pinned classic file and ships the result as `shared/injury_status.pure.js`. `shared.lock.json` pins both the classic source hash and the derived result hash; the build and the deploy refuse a changed source, an anchor not found exactly once, or a result that differs from its pin. `tests/mobile2027_injury_resolver.test.mjs` runs the original and the derived file side by side over about 52,000 generated cases and requires identical answers. The classic file is not touched, and a classic edit never blocks a classic release (see "Shared code" above).

**What is current and what is historical.** A past week shows that week's lineup and scores only. **NFL opponents and bye weeks are Unavailable for a past week**: no read says which NFL club a player was with then, and his club today may not be the one he played for (a Codex finding on the first R2 head); a past-week row labels his club "now". Injury status, rosters, contracts and cap notes are current, so a past week does not draw them (the bench, injured reserve and taxi are not shown), and the Contracts and Byes views always draw today's data and say so.

**Expected return (C17) is Unavailable, by ruling (2026-11-20).** MFL's injury read carries an `exp_return` text on every row whose meaning is not verified (retired players read "Feb 15, 2027"). The loader drops it before anything else can hold it, IR rows read "Return: Unavailable", and a test checks that no screen contains it.

## Files

`src/index.html` (content policy: the worker for data, ESPN and MFL for images, nothing else) · `src/lib/data.js` (the only network code) · `contract.js` · `model.js` · `roster.js` (the Team › Roster facts) · `views.js` · `photo.js` · `sample.js` · `format.js` · `src/app.js` (taps and drawing) · `src/styles.css` · `src/team-colors.css` (generated) · `shared.lock.json` · `scripts/build.mjs`, `scripts/check_shared.mjs`, `scripts/deploy_preview.mjs`, `scripts/team_colors.mjs` · tests in `tests/mobile2027_preview0.test.mjs` with a trimmed recording of the public routes in `tests/fixtures/mobile2027/`.
