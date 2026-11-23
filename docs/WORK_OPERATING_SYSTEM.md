# UPS work system

This is a process guide, not a live status page. GitHub issues and pull requests hold current work. Keith's private cross-project dashboard links to the UPS items; it must not expose private notes in this public repository.

## One work item, one outcome

| Type | Meaning | First move | Done when |
| --- | --- | --- | --- |
| Fix | Existing behavior fails its intended rule | Reproduce with real shape or a faithful harness | Correct behavior verified, regression covered, released and checked |
| Enhancement | New or materially improved owner experience | State user need and reviewable design | Keith can use and inspect the released flow |
| Data discrepancy | Numbers, owner, position, or freshness disagree | Read-only comparison with authority and timestamps | Scope and cause documented; a separately authorized repair is verified |
| Rule decision | Canon, MFL setting, or enforcement policy is unclear | Present options and consequences | Keith rules, canon and implementation are aligned |

A report or draft PR is progress, not "done." Do not turn a data audit into a production data repair without a separate decision. Record dates in Eastern Time and show UTC when matching logs.

## Issue and PR lifecycle

1. Capture the outcome in an issue. Use the fix or enhancement form. Link the relevant PR and name an owner.
2. Check `main`, open PRs, overlapping worktrees, the current rule, and the actual data source. Record the verified baseline.
3. Define acceptance criteria including a user-visible example and a failure case. Decide what can be tested without a real MFL write.
4. Assign independent agents only when their output can be reconciled: data/source, UX, implementation, and QA. One integrator owns the final PR and conclusions.
5. Build on a focused branch. Keep private data out of commits, public previews, fixtures, and artifact links.
6. For UI, attach an interactive HTTPS preview URL accessible on a phone and before/after screenshots. Test at 320px and 375px, and on Safari when available. A public preview must use sanitized or read-only data; authenticated flows need a safe test environment.
7. Run targeted tests, required repo gates, and a final diff review. Separate demonstrated results from inferences and unverified production behavior.
8. Put the exact decision in a decision issue or PR comment with options and a recommendation. Keith can reply on his phone. Record the ruling once and link it back to the work item.
9. Merge/deploy only after the required review. Verify the deployed version and actual page, then close the issue with any remaining limitations and a rollback note.

## Phone review contract

Every review request must include:
- **Open preview:** a working HTTPS link, what data/environment it uses, and what actions are disabled.
- **Try this:** two or three taps that demonstrate the proposed behavior, with expected output.
- **Decision:** one short question with options and the recommended option.
- **Reply here:** the issue or PR comment link. Treat a reply as notes until its meaning is confirmed in the decision log.
- **Evidence:** before/after image, source-data timestamp, CI and local test result.

If no safe interactive preview exists, say so before seeking sign-off and give a concrete way to create one. Do not substitute a static mockup without labeling it.

## Session boundaries

Continue the current session while working on the same outcome and files. Start a new session for an independent project, an unrelated bug, or after the old context becomes unreliable. Before switching, update the issue/PR with current commit, completed work, evidence, open decisions, and the next action. A new session first verifies those facts. Dispatch can carry a phone message to the desktop, but the issue/PR is the durable record.

## Cross-workstream coordination

The program has four workstreams: **Mobile** (the 2027 beta, `docs/ups_v2/`), **AI/History/Valuation** (the commissioner desk, League Record, contract history), **Infrastructure** (data governance, jobs, security) and **Shared**. Sessions stay focused on one workstream; decisions, dependencies and status connect through **backlog index issue #1503**, which is the one backlog. The linked issues and PRs stay authoritative; the index points to them and authorizes nothing.

- **Gaps.** Record a cross-workstream gap once in #1503, as a new row or a child of an existing item, with links from the affected workstreams. Do not keep a second tracker.
- **Writer.** The #1503 header names the single writer and the owner of the scheduled refreshes. Other sessions hand row text to that session; they do not edit the dashboard concurrently. A refresh must keep manual rulings, the audit trail and the handoff register unchanged.
- **Handoff register.** #1503 lists, per session or workstream: scope, latest handoff location, date and custodian. A public row may name a restricted artifact and its custodian only. Content and retrieval instructions for private handoffs live in Keith's private GitHub Project, because a path on one Mac is not a retrieval route.
- **Settled decisions.** Carry earlier approvals forward within their stated scope. Link to the ruling (issue or PR comment, or the #1503 audit trail); do not re-ask it and do not reintroduce a rejected feature. A reply on a phone is a note until its meaning is recorded.
- **Overlap.** Before changing a shared file or interface, check the shared-interface list in #1503 and `gh pr list` and `git worktree list` for work touching it. Inventory and reconciliation of open PRs and worktrees is its own backlog item; never close a PR, delete a worktree or discard changes as a side effect of other work.

### Stages are separate facts

Record each stage with a date, the evidence and the commit it applies to. One stage never proves another.

| Stage | Means | Record |
| --- | --- | --- |
| Design approved | Keith approved a design or scope | date, where he said it, the scope limits |
| Implemented | The change exists on a branch or PR | PR, head commit, draft or ready |
| Verified | Named checks passed | what ran, at which commit, what it covers and does not (unit tests, CI on the merge result, Codex verdict, real browser, test league) |
| Preview deployed | A working HTTPS preview on safe data exists | link type, data used, date, commit |
| Released | Merged, deployed and checked on the real surface | merge commit, deployed version, check date, rollback note |

Approval is not implementation, green CI is not a release, and a preview is not proof of authenticated owner behavior.

## AI sprints and tests

When Claude builds and Codex reviews, follow `docs/AI_SPRINT_PROTOCOL.md`: roles, the status line, the two-round limit, stop states and approval gates. Codex reads the same rules through `AGENTS.md`. Run the test suite only with `node scripts/safe_tests/run.mjs` (`docs/SAFE_TESTS.md`); the **Safe offline tests** check runs it on every pull request.

## Learning and interview note

For meaningful architecture changes, add a short explanation to the PR or linked design note:
- **Business problem:** who needs the result and why.
- **Data path:** source → ingestion → validation → storage → serving → UI; freshness and ownership at each step.
- **Choice:** why this storage, API, job schedule, cache, or retrieval method; alternatives and tradeoffs.
- **Operations:** testing, observability, failure behavior, cost, security, and rollback.
- **Interview story:** challenge, decision, your contribution, measured result, and what you would improve.

Use RAG only when the task actually needs retrieval over a document corpus; explain chunking, access controls, freshness, citations, and evaluation when it is used. Do not call a simple database query "RAG."

## Portfolio boundary

The private dashboard also tracks work outside UPS. This repository contains only UPS implementation work. The dashboard may link to public UPS PRs, but never put private or other-project details here.
