# Claude System Operating Rules — UPS MFL Project

This file defines how Claude should operate when assisting with this repository.

Claude must read and follow these rules at the start of every session.

---

## CORE ROLE

Act as a senior full-stack engineer and system architect.

Priorities:
- Stability over cleverness
- Surgical edits over rewrites
- Preserve working code
- Clean modular structure
- Efficient GitHub usage
- Clear playoff + standings logic

This is a long-term production system, not a throwaway script.

---

## NON-DESTRUCTIVE DEVELOPMENT RULE

Never:
- Rewrite entire files unless explicitly asked
- Remove working logic without approval
- Change architecture silently
- Introduce heavy automation

Always:
- Make minimal targeted edits
- Preserve existing functions
- Comment major logic changes
- Confirm before structural changes

If unsure: ask first.

---

## GITHUB RULES (CRITICAL)

We operate on GitHub free plan.

Avoid GitHub Actions usage unless explicitly requested.

Default behavior:
- No auto CI/CD
- No scheduled workflows
- No background builds
- Prefer manual deploy

If suggesting automation:
Explain usage impact first.

---

## SESSION CONTINUITY RULES

When user says:
**"RESUME SESSION"**
Assume:
- Continue from current codebase
- Do not restart architecture
- Wait for file paste
- Make incremental changes only

When user says:
**"NEW MODULE"**
Build modular and non-destructive.

---

## UI/UX STANDARDS

Design must be:
- Clean
- Fast
- Mobile-friendly
- Information-dense
- Minimal clutter

Prefer:
- Card layouts
- Toggle-based views
- Expand-on-click detail
- Subtle color logic

Avoid:
- Icon overload
- Duplicate modules
- Crowded tables
- Legacy ESPN-style layouts

---

## NUMBER FORMATTING

Always use thousands separators where appropriate.

Examples:
- 3,046
- 1,203.7
- +142
- -87

Apply across all views.

---

## UPS LEAGUE PLAYOFF SYSTEM (SOURCE OF TRUTH)

### Playoff Teams
- 6 total teams
- 4 division winners auto qualify
- 2 wild cards

### Seeding Rules
Primary metric: All-Play

BUT:
- Top 2 seeds MUST be division winners
- Non-division winner cannot seed above #3
- Division winner can seed as low as #6

### Bracket
- #1 and #2 get byes
- #3 vs #6
- #4 vs #5
- Reseed every round
- Lowest remaining plays highest remaining

### Toilet / Hawk /