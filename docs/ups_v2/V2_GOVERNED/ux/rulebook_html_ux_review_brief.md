# Rulebook HTML UX Review Brief

## Owner
- Lane: `ux_review`
- Assigned agent: `Bacon`
- Review target: `/Users/keithcreelman/Documents/mfl/Codex/version2/docs/ups_v2/V2_GOVERNED/rules/ups_v2_fantasy_rulebook_browser_comprehensive_draft.html`

## Purpose
- Give the comprehensive rulebook draft a dedicated UX pass instead of treating the HTML as a byproduct of the content rewrite.
- Focus on scanability, navigation, reading-path clarity, mobile behavior, and example discoverability.

## Context
- This rulebook is now structured like a real fantasy football rulebook instead of a metadata browser.
- It includes:
  - quick reading paths
  - sticky table of contents
  - search and filter controls
  - embedded examples
  - section-level status flags for settled, working, and open areas
  - site-surface guidance tied to the rules

## UX review goals
- Confirm that a new owner can find the league basics, deadlines, roster rules, and rookie draft rules quickly.
- Confirm that a contract-heavy owner can get to contracts, cap penalties, MYM, extensions, and trades without bouncing around the page.
- Confirm that the page feels like one coherent book rather than a dashboard with sections stapled together.
- Confirm that the examples are easy to notice and worth reading.

## Review checklist
- Navigation:
  - Is the sticky TOC enough, or does the page need a second local jump control on mobile?
  - Do the quick-path cards actually help, or are they decorative?
  - Are the section titles specific enough to scan without opening every block?
- Reading flow:
  - Does the document start with the right rulebook order for fantasy owners?
  - Are the site-workflow notes integrated naturally instead of hijacking the book?
  - Do the open sections feel visibly incomplete without wrecking the page?
- Examples:
  - Are contract examples prominent enough?
  - Should examples be visually stronger or collapsible by family?
  - Are there missing examples for the hardest concepts?
- Search and filters:
  - Are the current families and reader paths intuitive?
  - Is the filter model worth keeping, or should it be simplified?
  - Do owners need a dedicated `contracts only` or `deadlines only` mode?
- Mobile:
  - Does the sidebar fallback degrade cleanly?
  - Are tables readable enough on small screens?
  - Does the page remain navigable without precision tapping?
- Tone:
  - Does the page sound like a serious league rulebook instead of a product spec?
  - Are any sections still too engineering-heavy?

## Requested deliverables
- `journey_audit` entry focused on rulebook entry and section-to-section flow
- `friction_summary` focused on navigation overload, content density, and example discoverability
- `navigation_recommendation_log` items for any structural changes that should happen before this becomes the preferred review draft

## Suggested next-pass improvements if confirmed
- Add a compact section-progress rail or "You are here" indicator.
- Add a `deadlines only` quick mode.
- Add a print-friendly stylesheet.
- Tighten visual treatment for open items versus settled rules.
- Promote example blocks for contracts and trades into a stronger recurring pattern.
