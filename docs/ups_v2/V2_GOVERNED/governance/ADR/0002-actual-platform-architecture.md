# ADR-0002: Record the platform UPS actually runs on

- Status: Proposed. It records facts read from the repository on 2026-11-16; the items under "Still open" need Keith's ruling.
- Date: 2026-11-16
- Deciders: Keith (owner and commissioner)
- Related phase: v7 Phases 6, 8, 9 and 12

## Context

v7 says to build UPS_V2 in a separate repository with fresh history, SQLite as the operational store and BigQuery as the warehouse, with no shared runtime. That stack was never adopted, and no record documents the change. Planning against it produces requirements that do not match the running system.

## Decision

Plan against the platform as it is:

- **Runtime:** one Cloudflare Worker (`worker/`), which proxies MFL reads and performs MFL writes.
- **Data store:** one Cloudflare D1 database, `ups-mfl-db`, metered under the rules in `docs/D1_QUERY_RULES.md`.
- **Site:** static files in `site/`, deployed to GitHub Pages from `main`.
- **Pipelines:** Python ETL in `pipelines/`, run by GitHub Actions and by hand.
- **League host:** MyFantasyLeague. Production league 74598.
- **Repository:** this one. v8 work happens here, in new directories, not in a separate repository.

## Consequences

- v7 Phase 6's "new empty SQLite plus BigQuery dataset contracts" is replaced by decisions about D1: whether a test environment gets its own database, and whether a contract event ledger is added.
- v7's environment table (prod mirror, test working, future lab on SQLite) no longer describes anything that exists.
- Requirements that assume a warehouse layer are deferred.

## Still open

- Whether BigQuery and v7 Phase 12 are retired or only deferred.
- Whether a test environment gets its own Worker and D1 database.
- Where the test site is hosted and who can open it.

## Revision log reference

`governance/revision_log.md`, entries dated 2026-11-16.
