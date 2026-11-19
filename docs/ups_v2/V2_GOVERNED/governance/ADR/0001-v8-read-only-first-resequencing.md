# ADR-0001: Master plan v8 resequences the rebuild as mobile-first, read-only-first releases

- Status: Direction accepted by Keith on 2026-11-16. The v8 document itself is `pending_review` until he approves it for use.
- Date: 2026-11-16
- Deciders: Keith (owner and commissioner)
- Related phase: v7 Phases 2 to 13 (re-entered under the phase re-entry rule)

## Context

- v7 fixes the order audit, target, gap, then rebuild, across 14 phases. Its Phase 2 never closed: four target rows are `in_review`, the actor-permission matrix is empty, and no phase report exists.
- v7 places 2027 test-site work in Phase 11, disabled until Phases 2 to 10 close.
- v7's surface inventory (March 2026) predates the mobile app, standings, UPS Center, the auction hub, stats and Game Day.
- Keith wants a 2027 redesign delivered mobile first on a test site, without waiting for v7's Phases 2 to 10.

## Decision

- Replace v7's single up-front sequence with small releases. Each release passes the same gate: audit, target and gap, data-source check, rule check, Keith's approval to build, build, phone preview with evidence, independent review, Keith's phone review.
- Order the releases read-only first. Release 1 is navigation, skins, My Team and a player contract card on recorded data.
- Keep every v7 safeguard. `MASTER_PLAN_v8.md` Appendix A maps each v7 phase to its v8 home and Appendix B maps each safeguard.
- Keep these as open decisions, not settled by this record: test environment, contract authority, contract event ledger, test clock, hosting.

## Consequences

- The audit, target and gap artifacts are produced per release instead of once for every surface. A surface not yet touched by a release has no refreshed audit.
- v7's Phase 11 lock on test-site work no longer applies; the environment becomes an explicit choice with a stated isolation proof.
- This record does not authorize a test-site build, hosting, a production read, a league write, a merge or a deployment.
- `MASTER_PLAN_v7.md` stays in the repository unedited. Its registry row changes to `superseded` only when Keith approves v8 for use.

## Revision log reference

`governance/revision_log.md`, entries dated 2026-11-16.
