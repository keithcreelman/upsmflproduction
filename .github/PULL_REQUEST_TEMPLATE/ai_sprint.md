<!-- AI sprint PR (docs/AI_SPRINT_PROTOCOL.md). Fill every line or write "n/a: <reason>". Keep the PR a draft until Keith decides. -->
**AI sprint:** issue #___ · builder Claude · reviewer Codex · round _/2

## Plain English
What will an owner notice? One to three sentences.

## Work item
- Type: fix / enhancement / data discrepancy / rule decision
- Owner outcome:
- Definition of done (from the issue; check an item only when it is proven):
  - [ ]
- Out of scope:

## Technical why
Source → ingestion → validation → storage → API → UI. Why this design; alternatives and tradeoffs.

## Source and freshness
- Data sources and timestamps (ET; UTC for logs):
- Base: `main` at `<sha>` on <date>. Overlapping PRs and worktrees checked:

## Tests and CI
- Local: `node scripts/safe_tests/run.mjs` on a clean worktree at `<sha>` → paste the summary line (passed / failed / excluded):
- Targeted tests added or changed:
- CI **Safe offline tests**, copied from the run's "Tested" line. CI tests GitHub's merge result, not the head alone:
  - PR head reviewed: `<sha>`
  - merge result tested: `<sha>` (base `<sha>`; current `main` is `<sha>`, moved by _ commits, touching this PR's files: yes / no)
  - run: link
- D1: new or changed query → `rows_read` + `EXPLAIN QUERY PLAN`; or "none"

## Preview and proof
UI changes only; otherwise "n/a: no UI change".
- Phone-openable HTTPS preview:
- Environment and data (synthetic / test league / production read-only):
- Try these taps → expect:
- 320px and 375px screenshots:

## Unverified
What was not tested and why (real Safari, authenticated MFL, production data, deployed worker, …):

## Risks and rollback
- What could go wrong in production, and who would notice:
- Danger-zone files touched (`docs/CHANGE_PLAYBOOK.md` §2):
- Rollback:

## Review record
- Rounds used: _/2. Last reviewer verdict: CLEAN / CHANGES at head `<sha>` (authenticated status comment: link)
- Open material findings: none / MAT-…
- Disputed (Keith decides): none / …
- Minor findings for Keith's final review (not fixed): MIN-…
- Commits after the last review (unreviewed): none / `<sha>..<sha>`

## Decision needed
One question for Keith, the options, and the recommended option.
- Keith's approval required for (`docs/AI_SPRINT_PROTOCOL.md` §9): none / list
