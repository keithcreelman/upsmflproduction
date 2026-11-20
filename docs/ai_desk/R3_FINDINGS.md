# R3: the third live evaluation run (2026-11-20)

R3 was authorized by Keith as the same 10 development questions, hard cap $1.00, code `5af1182d`. It ran 2 of 10 and stopped by design: the runner's own check found "a digit in model prose outside a fact token" in question 2, in the first three cases. Recorded cost $0.107558 (the ledger carries the 25 percent margin; raw about $0.0861). No key or prompt text is recorded here.

## Grades (Keith's rubric; the oracle alone is not a grade)
| # | question | grade | why |
|---|---|---|---|
| 1 | When did Superflex start in UPS? | **Partial** | Right rule cited (the 2022 Superflex transition entry), honest about the missing dated rule-version table, first draft accepted (no retry). The lead says "its title gives the year" instead of stating 2022, so an owner has to read the citation. Known gap, recorded below as its own improvement. |
| 2 | Is Ext1 a contract type? | **Correct** | "Yes": the rule's title and body say `contract_type` is Ext1 for a one-year extension; the glossary's status token Vet-Ext1 is described as a separate thing and "stays flat with no suffix from the extension itself", which matches the canon. Both citations (s1-c4, s1-c2) exist and fit. First draft accepted. This is the question R2 got slightly wrong (it credited the rule with the name Vet-Ext1). |
| 3 to 10 | not run | **Technical failure** (harness) | The run stopped before them. Nothing is known yet about the records, current-number, injection, outage, lineage, contract and false-premise cases with a real model. |

## Why the run stopped (proven)
- The validator accepted the question 2 card on its first attempt. The **runner's own invariant check** then flagged it: it flagged "Ext1" as a stray digit.
- Cause: after R2 the validator's allowed-glossary-term match became case-insensitive, but the runner kept a **private, hand-built, case-sensitive copy** of that matcher ("the validator allows it, so this does too"), so a validator-approved answer ("Ext1", with the glossary alias spelled `ext1`) was treated as a violation and hard-aborted the run. Infrastructure bug, not model quality. An earlier test used only the exact-case spelling "Vet-Ext1" and could not see it.
- **Fix:** the invariant now imports the validator's own `termRegex` and the composer's own `glossaryTerms`, so the two cannot drift. A regression test covers "Ext1", "ext1", "EXT1", "Vet-Ext1" (accepted) and "Ext2", "NEXT1", "Ext10", "Ext1 lasts 1 year", no lookup (rejected), and checks the source uses the shared matcher.

## What R3 showed about the R2 fixes
- **The R2 HTTP 400 did not recur** in 9 model calls (two questions, three loop rounds on question 1, two on question 2). That is evidence, not proof: the failing shape (nine parallel calls with a thinking block) did not occur. It stays unproven until the champions question runs.
- **Composer, glossary and prompt fixes worked on the real API:** both composer drafts passed the validator on the first attempt (R2: both needed a retry). Question 1's lead no longer says it "can't print the year".
- **Caching works:** question 1's loop wrote 5,625 tokens in round 1, read them in rounds 2 and 3 (5,625 then 8,478) and wrote only the increments. Question 2 wrote 7,600 and read them back.

## Tokens, cache, latency, cost (raw = recorded divided by 1.25)
| | uncached in | out | cache write | cache read | cost |
|---|---:|---:|---:|---:|---:|
| 9 model calls, 2 questions | 10,538 | 2,990 | 16,458 | 17,362 | $0.0861 raw, $0.1076 recorded |
- Per question (recorded): $0.0531 and $0.0545 (mean $0.0538); five model calls on question 1 (router, three loop rounds, composer), four on question 2. No retries.
- Loop cost with caching against the same loops uncached: 37 percent less (question 1: 45 percent). Against R1's old shape for the same question 1: $0.0337 against $0.0751 (55 percent less).
- Latency: 12.6 s and 12.4 s per question (scorer threshold p50 8 s, p95 20 s): real model calls in sequence, not yet optimized. The scorer's cost-mean threshold ($0.05 recorded) is just missed at $0.0538 with the 25 percent margin (raw $0.043).
- The scorer's citation-support metric again marked 2 of 3 citations unsupported; reading the excerpts they are supported (paraphrases). It is a word-overlap heuristic and the scorer is frozen, so a person adjudicates.

## Systematic problems (not patches)
Three paid runs, three different stops, each caused by something the free offline tests could not see:
1. **R1: an API compatibility rule** (forced tool choice is a 400 on Sonnet 5.5). The scripted stand-in accepts any request shape.
2. **R2: how the model's own turn is sent back** (likely a thinking block turned into an empty text block). The stand-in never returns thinking blocks or nine parallel calls.
3. **R3: duplicated logic that drifted** (the runner's private copy of the validator's term matcher).
The common cause: the offline harness checks that the engine behaves, but nothing checks that the **requests it sends are valid for the real API**, nothing makes the scripted model **misbehave like a real one**, and the runner re-implements rules instead of sharing them. A hard abort in the first three cases then turns each defect into a spent run.

## Separate improvement (not done, not a validator change): source-grounded rule dates
An owner asking "when did Superflex start" should see 2022 in the answer, not only in the cited rule's title. Do not manufacture years or relax the numerical validator. The work: a tool fact that returns a rule's own title or year from the canon text as a graded, source-bound fact (printable through a fact token), and, longer term, the dated rule-version table (League Record slice S4, LR-16).
