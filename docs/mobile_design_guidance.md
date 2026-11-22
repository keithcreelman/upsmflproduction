# Mobile design guidance (standing)

Owner screens in the mobile app (the 2027 beta, `apps/mobile2027`, and any later mobile work) follow this guidance. It records Keith's direction from the phone review of the Contracts and Performance preview (2026-11-22). It is a standing rule for design choices, not a scope list: what a given screen must show is decided in its issue or PR.

## Principle

**Emphasize useful information and actions. Use fewer boxes, buttons and technical explanations.** An owner opens a screen to read a number or do something, not to learn how the number was produced.

## What belongs where

| On the screen | In Help or the review documentation |
|---|---|
| The number or action, in a large, easy-to-read form | How the number is calculated and from which source |
| A concise warning when uncertainty **materially affects a number or an action** (one line, in plain words) | Provenance, ledger or MFL plumbing, verification status and its history |
| A compact rank such as "QB 2 of 73" | Why a rank is exact or a range, how pools are counted, what an unsettled competitor is |
| One clear explanation of an actual data problem | Methodology, rule citations, evidence |

- Never remove a warning that a number or action depends on; shorten it. Do not hide a real data problem and do not manufacture data to fill a gap.
- A generic message repeated on every row ("unavailable") is a defect. Say what the issue actually is once, at the level where it applies, and leave the affected cells quiet.
- Prefer the full, plain label ("Expiration date", "2026 salary") to a technical or abbreviated one. Abbreviate only when the width at 320 px forces it.
- The player profile is reachable the same way wherever a player is shown, and a performance or contract breakdown can be expanded in place.
- Controls: fewer, and each one earns its space. Prefer one control with a selector (for example one Salary sort with a year) to a row of near-identical buttons.

## Checks before a layout is chosen

- Look at it at **320 px and 375 px**, including the worst case (four-digit ranks, 100-point weeks, long names), before deciding. A screenshot or desktop emulation is not a phone review; say what remains unverified.
- State whether the preview shows live or recorded data.
- Exploratory ideas stay exploratory until Keith commits them. A profile or breakdown may link to an existing flow; it adds no write, lineup swap or other action under a design-feedback request.

## Source

Keith's feedback on the phone preview of PR #1505 and #1507 (head `cd77e3b3`), 2026-11-22, recorded on issue #1493. This file does not change any league rule; contract and cap rules stay in `docs/league_context_v1.md`.
