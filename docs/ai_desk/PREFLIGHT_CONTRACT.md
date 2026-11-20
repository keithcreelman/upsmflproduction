# Preflight hardening: what the free checks cover, and what they cannot

Written after three paid runs (R1 to R3) each stopped on something the free offline tests could not see. Everything here is free: no key, no network, no spend.

## What was added
| piece | where | what it does |
|---|---|---|
| Request contract | `worker/src/desk/request_contract.js`, run by `budget.js guardedCall` on every request | Judges the exact request object each pipeline step sends, in tests, dry runs and live runs. A request that breaks an *error* rule is refused as `request_contract` before any reservation or call. |
| Response classifier | same file; used by the tool loop and the composer | Truncated (`max_tokens`), refused and malformed replies fail closed in one way: the loop runs nothing from them, the composer treats them as "no card". |
| Structural diagnostics | `describeRequest`, `shapeLine`; carried on a failed or refused call | Model, HTTP status, provider error type, the request field path (`messages.1.content.0.text`), block types and counts, tool-call and result counts, cache-marker count. No text, names, ids, arguments, tool results or thinking. |
| Adversarial scripted model | `scripts/ai_eval/lib/scripted_model.mjs` (`createAdversarialClient`, `BEHAVIORS`) | The scripted answer, made to misbehave: thinking and redacted-thinking blocks, nine parallel tool calls, mixed text, a prose reply instead of a card, cut-off and refused replies, an invalid tool sequence, odd capitalization of a league term, a non-ASCII digit, a provider 400, a malformed reply. |
| Failing sources | `scenario_env.mjs` fault modes | Every route answers HTTP 500, is unreachable, or returns an empty body, text that is not JSON, JSON `null` or JSON no tool expects. |
| Adversarial matrix | `scripts/ai_eval/lib/adversarial.mjs`; free `--mode adversarial`; **mandatory live gate 7b** | All questions in a set through the real pipeline for every scenario (24 for the first ten: 240 runs, about 5 seconds). Gate 7b runs a 16-scenario subset from scratch inside every live run, before the confirmation prompt; a failure refuses the run (exit 2) exactly like gate 7. The subset is fixed in code; only a test running under the test gate (the literal canary key plus the test flag, which a real key can never satisfy) may name a smaller list, so the many live-mode tests do not each pay for the whole gate. Two tests use the full list. |
| Independent grade | `scripts/ai_eval/lib/grade.mjs`; a column in every results summary | Correct, Partial, Incorrect or Technical failure, from the card, the question's declared nature and the run's checks. Independent of the fixture oracle and of the frozen scorer. |
| One source of truth | `validator.js` exports `hasDigitOutsideTokens`, `modelProseFields`, `termRegex` | The runner's invariant, the scenario oracle and the data checks call these instead of keeping copies. `checkProseBase` itself calls `hasDigitOutsideTokens`. |
| Scorer parity | `scripts/ai_eval/scorer_parity.mjs` | Feeds the same strings to the validator and to the frozen scorer and prints the differences. The scorer is not changed. |

## What each paid-run defect would have been caught by
| defect | caught by | how |
|---|---|---|
| R1: forced `tool_choice` on Sonnet 5.5 (HTTP 400) | the request contract (`TOOL_CHOICE_FORCED_MODEL`) | The old composer request is an error in a unit test; at runtime the gate would have refused it before any spend. Proven by replica in `tests/ai_desk_preflight.test.mjs`. |
| R2: the replayed assistant turn (likely a thinking block turned into an empty text block) | the contract (`TEXT_EMPTY`, tool pairing, thinking order) and the adversarial scenarios `thinking`, `redacted_thinking`, `parallel9`, `mixed_text` | The old shape is an error in a unit test; every request of every scenario is linted. The cause is still **likely, not proven** (the real reply was never stored). |
| R2: first manual dry run failed on a monthly cap | dry-run caps (earlier fix) and the run-id test | Unchanged here. |
| R3: the runner's private, case-sensitive digit rule aborted a validator-approved answer | shared rule + scenario `glossary_case` + the parity tests | The matrix runs the real runner invariant on a card that writes the term in several capitalizations. |
| R1/R2 diagnosis took guesswork | structural diagnostics | A failing call now reports the field path and the block sequence, so the cause is on record. |

## What is NOT covered (read this before trusting a green result)
- **Provider acceptance.** The contract encodes the rules we know and the published notes state. A request that passes can still be refused (a new rule, a limit, an account setting, a model change). Only a real call proves acceptance.
- **Real model behavior.** The adversarial model reproduces known shapes. A real model can do something not on the list; the matrix cannot say how often a real model will take an unusual path.
- **Answer quality.** The grade is structural (does the card answer, cite, decline, or fail honestly). It cannot tell whether a paraphrase of a rule is faithful. A person reads the answers.
- **Tokens, price, latency, cache creation and reads.** Modeled, not measured, until a paid run.
- **A thinking block's real content and signature rules.** The scripted blocks are well-formed stand-ins; whether the provider validates a replayed signature the way we assume is only known live.

## Remaining differences between the validator, the runner and the frozen scorer
| topic | validator (production) | runner invariant | frozen scorer |
|---|---|---|---|
| league term with a digit | allowed case-insensitively, whole word, only terms the glossary returned this run | same function | allowed only in the exact spelling the glossary returned or that a glossary citation excerpt on the card contains; **flags a validator-approved capitalization such as `Ext1` when the alias is listed as `ext1`** |
| `49ers`, `76ers` | allowed | allowed | **flagged** as a typed number |
| non-ASCII digits (Arabic-Indic, fullwidth, fractions) | rejected | rejected | **not flagged** (ASCII `\d`) |
| prose fields | one list (`modelProseFields`) | that list | its own list (same fields; parity-tested) |
- The scorer stays frozen. Where it flags a number the validator accepted, a person reads the card and overrules; run summaries now print an `ADJUDICATE` line for those. Run `node scripts/ai_eval/scorer_parity.mjs` to see the table.
- Remaining small duplication: the scorer's own matcher (frozen); the proper-noun exemption lives in the validator only.
