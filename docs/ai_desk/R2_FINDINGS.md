# R2: the second live evaluation run (2026-11-20)

R2 was authorized by Keith as the same 10 development questions with a hard cap of $1.00. It stopped by design after question 3 (the first model error in the first three cases). Recorded cost $0.146101 (the ledger carries the runner's 25 percent margin; raw about $0.1169). Nothing here contains a key or prompt text.

## What happened, question by question (from the run's results file and ledger)
| # | case | result | cost* | model calls |
|---|---|---|---:|---:|
| 1 | DEV-RUL-02 (when did Superflex start) | partial, oracle pass, cites the 2022 Superflex transition rule | $0.0632 | 5 (router, 2 loop, composer, **retry**) |
| 2 | DEV-RUL-10 (is Ext1 a contract type) | answer, oracle pass, cites s1-c4 and s2-t3-3 | $0.0655 | 5 (router, 2 loop, composer, **retry**) |
| 3 | DEV-REC-02 (champions 2017 to 2025) | tool_failure, no card | $0.0175 | 3 (router, loop, **loop: HTTP 400**) |
\* recorded, margin included.

## Question 3: what failed (confirmed vs likely)
- **Confirmed:** routing, tool execution and the composer were not involved. The router worked; loop round 1 returned nine parallel calls (one `history.finishes` per season), all nine ran and returned `ok`; the failure was the **second loop request**, answered with `http_error:400:invalid_request_error` (not billed). The status and the error type were recorded; the exact field was not (it is now).
- **Likely, not proven:** the loop sent the model's own previous turn back in a form the API rejects. The old code turned every block that was not a tool call into a text block, so a `thinking` block (Sonnet 5.5 thinks by default) became an EMPTY text block, which the API refuses, and the thinking itself was lost. Round 1 here had 1,271 output tokens against about 450 expected for nine plain calls, which fits a thinking block; the earlier rounds of R1 and R2 (150 to 400 output tokens) probably had none. The model's reply is not stored, so this cannot be checked after the fact.
- **Fix:** the loop now returns thinking and redacted-thinking blocks exactly as received, drops empty text blocks and unknown blocks, and fails closed on a reply cut off by `max_tokens`. A 400 now records the request FIELD PATH (for example `messages.1.content.0.text`): the first segment from a closed list of request fields, later segments short letters, digits and underscores, never the message.

## The dry-run inconsistency (confirmed, not a safety bypass)
- Keith's first manual dry run used the budget variables exported in his shell (monthly cap $2.00). The ledger shows 7 `budget_monthly` blocks, all in the scripted ("fake") lane: the free dry runs and test runs done earlier in the day (CHK1 to CHK3 and R1's dry runs) had already used about $1.83 of that scripted lane, so the next dry run hit the $2.00 monthly cap.
- The live command then ran its own dry test **from scratch** (the code calls `runDry` again; it never reads an earlier result) with fixed generous caps, so it passed and printed "Gate 7". The ledger agrees: R2 holds 21 scripted rows plus 7 blocks from the manual dry run, then 40 scripted rows from the live preflight.
- A genuinely failed preflight refuses with exit 2 before any client is created (an existing test, plus a new one that leaves an earlier PASSED result on disk and proves it is not trusted).
- **Fix:** a manual dry run applies your per-question and per-run caps but not the monthly and total caps (those meter real money; scripted rows have none), and each dry run writes its rows under its own run id, so repeated dry runs never add up.

## Quality, as observed
- **Citations:** correct rules on both finished questions (the 2022 Superflex transition entry for question 1; the extension rules s1-c4 and s2-t3-3 for question 2). No wrong number, no invented citation, no over-refusal.
- **Question 1 is `partial` by design here:** the model asked for the dated rule-version table, which does not exist yet (League Record slice S4), and a listed gap forbids a plain `answer`. The answer is honest; its lead said it "can't print the year" although the cited rule's title carries 2022 and the card shows that title beside the cite. The composer prompt (1.4.0) now says the desk prints the cited rule and the lead should point to it.
- **Substantive check of the two finished answers (read against the canon text the model was given):**
  - **Q1 (Superflex):** the cited entry is the right one ("2022 — Superflex transition ... Superflex era begins, ONGOING"). The card does not say "2022" in its lead; the year appears only in the cited rule's title shown beside the citation. So it is correct and honest, but it is an oracle pass with a weak lead: an owner has to read the citation to learn the year. It is `partial` for two reasons: the model itself asked for the dated rule-version table (which does not exist yet: League Record slice S4), so a listed gap forbids a plain `answer`; and the validator forbids a typed year, so only a fact token could carry it. No rule tool returns the rule's title or year as a fact today. That is a design gap (a candidate change, not made here).
  - **Q2 (is Ext1 a contract type):** "Yes" is right (the rule says `contract_type` is Ext1 for a one-year extension) and so is "always flat" (a one-year extension takes no FL or BL suffix). The wording is off: it says the rule "names Vet-Ext1", but the rule says Ext1; Vet-Ext1 is the glossary's status-token name. The cause is below.
- **Both finished questions needed a composer retry.** Q1: the first draft's citation claim used a counting word ("one-time"), rejected as a spelled quantity. Q2: the owner's spelling "Ext1" was rejected as a stray digit because the validator's allowed-term check was **case-sensitive** (the glossary alias is "ext1"), so the model fell back to "Vet-Ext1" and then credited the rule with that name. **Fix:** the allowed-term check ignores capitalization (still whole-word, still only terms the glossary returned this run); the composer prompt no longer tells the model to avoid "Ext1" and says to follow the rule's own wording; claims are prose too (no counting words). Whether this removes the retries is unproven until the next run.
- **The scorer's citation-support metric is a word-overlap heuristic** and marked 2 of 3 citations unsupported although a person reading the excerpts finds them supported (paraphrases). The scorer is frozen and was not changed; those two should be adjudicated by a person. The median latency (13.5 s) is above the scorer's threshold; real calls plus a retry are slow.

## Tokens and cost (raw tokens = recorded divided by 1.25)
| call | uncached in | out | cache write | cache read |
|---|---:|---:|---:|---:|
| 3 routers (Haiku) | 3,530 | 533 | 0 | 0 |
| 5 loop calls that ran (Sonnet; the 6th was the 400) | 17 | 2,208 | 15,469 | 14,920 |
| 4 composer and retry calls (Sonnet) | 14,920 | 2,414 | 0 | 0 |
Total raw: 18,467 uncached in, 5,155 out, 15,469 cache write, 14,920 cache read (all of it read by loop calls), about $0.117.
- Caching works: round 1 writes the prefix, round 2 reads it back, and question 3 even read question 1's prefix (same offered tools).
- Narrowing helped: round-1 request size fell from 7,218 tokens (R1, all 14 definitions) to about 4,500 (nine tools) and 6,100 (twelve tools).
- Cost tracks the model: without the retry, questions 1 and 2 cost about $0.046 each against the model's $0.050 to $0.055; the retry adds about $0.018 each.
