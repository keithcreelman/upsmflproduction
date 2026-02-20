# PROJECT STATE — UPS MFL Production

## Source of Truth
Primary repository: upsmflproduction  
This is the ONLY canonical source.  
Do not rely on ups-league-data unless explicitly instructed.

## Project Purpose
UPS MFL Production contains:
- ETL pipelines
- MFL integrations
- automation scripts
- site logic
- data processing and reporting

This repo must become a single clean, maintainable production system.

## Current Focus
- Repository consolidation
- Removing duplicate directories
- Establishing one true root structure
- Stabilizing ETL pipelines
- Ensuring MFL integration consistency
- Coordinating development across Claude + Codex

## Architecture Goals
- One clean root repo
- No duplicate code copies
- Clear ETL flow
- Stable MFL API posting
- Easy long-term maintenance
- High reliability

## Non-Negotiables
- Do NOT introduce dependency on upsleague-data
- Preserve working ETL logic
- Preserve MFL integration behavior
- Prefer simple and maintainable solutions
- Do not rewrite entire files unless requested
- Use surgical edits and diffs

## Known Risks
- Duplicate legacy folders exist
- Path inconsistencies may exist
- Old scripts may still be referenced
- Hidden dependencies may surface
- Multi-AI edits must stay coordinated

## Active Development Model
This repository is co-developed using:
- Claude (architecture + reasoning)
- ChatGPT Codex (implementation + edits)
- Keith (final authority)

All changes must remain readable and maintainable by any of the three.

## Next Major Milestone
Complete repository consolidation  
Single clean working ETL pipeline  
Stable MFL integration  
Production-ready structure