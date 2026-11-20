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

## What is deliberately not here

Any action; cap space; the Team › Contracts and Cap & picks tabs; injury status, projections, game log, schedule, news, bio; sign-in; the helmet badge and team colors (not approved). A missing fact reads "Not available" or "Not recorded", never `$0`.

## Choices that go beyond the approved prototypes (each is easy to change)

- The Contract tab opens first (the prototype opens Performance), because it is the tab built in Preview 0.
- Four bottom tabs (Home, Team, Market, League), the layout Keith leans toward; unresolved.
- The roster has two views, Lineup and Contracts. Performance and Byes need data not in Preview 0.
- Vibrant position colors are on by default, as in the prototype; Plain turns them off (About › Display).
- A team picker, because there is no sign-in to say whose team to show.
- Earned to date says "Full-year rule" or "Not applicable" exactly when the worker says so. The prototype's newer one-year `$1,000` ruling (CC-1) is not in the worker yet, so it is not shown.

## Run, test, build, deploy

```bash
python3 -m http.server 8741 --directory apps/mobile2027/src    # open http://localhost:8741 (reads the live public routes)
node tests/mobile2027_preview0.test.mjs                         # offline; or: node scripts/safe_tests/run.mjs
node apps/mobile2027/scripts/build.mjs                          # writes apps/mobile2027/dist and prints the artifact digest
node apps/mobile2027/scripts/deploy_preview.mjs apps/mobile2027/dist            # dry run: prints the plan
node apps/mobile2027/scripts/deploy_preview.mjs apps/mobile2027/dist --execute  # publishes to the preview address only
```

The deploy script's project (`ups-mobile-beta`) and branch (`preview`) are constants. It has no way to name the production branch and refuses a build folder that changed after the build.

## Files

`src/index.html` (content policy: the worker for data, ESPN and MFL for images, nothing else) · `src/lib/data.js` (the only network code) · `contract.js` · `model.js` · `views.js` · `photo.js` · `format.js` · `src/app.js` (taps and drawing) · `src/styles.css` · `scripts/build.mjs`, `scripts/deploy_preview.mjs` · tests in `tests/mobile2027_preview0.test.mjs` with a trimmed recording of the public routes in `tests/fixtures/mobile2027/`.
