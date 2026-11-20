# R1: the first live evaluation run (2026-11-20)

R1 was authorized by Keith as 10 development questions with a hard cap of $1.00. It made 5 model calls on its first question and stopped by design when a call failed in the first three cases. It never reached questions 2 to 10. No key, prompt text or private data is recorded here.

## What was observed (confirmed from the run's own ledger and results file)
| call | model | input tokens* | output tokens* | result |
|---|---|---:|---:|---|
| router | Haiku 5.5 | 1,470 | 217 | ok (forced tool choice accepted) |
| loop round 1 | Sonnet 5.5 | 9,022 | 187 | ok: called rules.search |
| loop round 2 | Sonnet 5.5 | 11,872 | 140 | ok: called coverage.check |
| loop round 3 | Sonnet 5.5 | 13,397 | 333 | ok: called rules.get with the rule the oracle expects |
| composer | Sonnet 5.5 | none | none | HTTP 4xx, billed nothing (ledger: `http_error`) |

\* As recorded, with the runner's 25 percent safety margin (real tokens are 1/1.25 of these). Recorded cost $0.075438; the measured request size is about 2.5 bytes per token.

## What caused the failure
- **Confirmed:** the composer call returned an HTTP 4xx (a definite client error, so it was not billed). The status code and error type were not stored, so the exact error is not on record.
- **Likely, not proven:** the composer sent a forced `tool_choice`. Anthropic's published notes for Sonnet 5.5 say that forced tool choice returns a 400. The router (Haiku, forced) and the three loop calls (Sonnet, `auto`) all worked, which fits. R2 will show the status and error type in the ledger if anything similar happens (they are now recorded, never the provider's message).
- **Why offline tests did not catch it:** the scripted stand-in accepts any request shape.

## What the fixes are
1. The composer uses `tool_choice: auto` plus a prompt line to call `emit_card` exactly once; only Haiku is ever forced. A reply with text and no card is a rejected card; it gets one nudged retry, then a code-built failure card (no model text reaches the owner).
2. The ledger records the HTTP status and provider error type of a failed call.
3. Cost: the loop shows only the tool definitions a question can need (core tools, plus the router's domains, plus any domain the question's own words name; an empty, "other" or unknown route shows all; one retry with all tools if a narrowed first reply uses no tool), and uses prompt caching on the system block and the newest message. See `COST_MODEL.md`.

## What stays unproven until R2
That the composer fix is accepted by the real API; that caching is created and read as modeled; the composer's real token use; and how a real model answers the other nine questions.
