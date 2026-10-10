# UPS work system

This is a process guide, not a live status page. GitHub issues and pull requests hold current work. Keith's private cross-project dashboard links to the UPS items; it must not expose job-search or business notes in this public repository.

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

## Learning and interview note

For meaningful architecture changes, add a short explanation to the PR or linked design note:
- **Business problem:** who needs the result and why.
- **Data path:** source → ingestion → validation → storage → serving → UI; freshness and ownership at each step.
- **Choice:** why this storage, API, job schedule, cache, or retrieval method; alternatives and tradeoffs.
- **Operations:** testing, observability, failure behavior, cost, security, and rollback.
- **Interview story:** challenge, decision, your contribution, measured result, and what you would improve.

Use RAG only when the task actually needs retrieval over a document corpus; explain chunking, access controls, freshness, citations, and evaluation when it is used. Do not call a simple database query "RAG."

## Portfolio boundary

The private cross-project dashboard contains four priorities: UPS, FIU Panthers, AI income experiments, and job search. This repository contains only UPS implementation work. The dashboard may link to public UPS PRs, but never put private career or other-project details here.
