# Q8 — Standings Page Sort: Recommendation & Decision-Needed

**Status:** ⏳ Awaiting Keith's call.
**Tracker:** `docs/AUDIT_FOLLOWUP_TRACKERS.md` Q8 (added in PR #212).
**Canon:** `docs/league_context_v1.md` §F.1 (playoff seeding rule) + §F.2 (DO NOT CONFLATE — division tiebreaker vs UPS playoff seeding).

---

## Background

The 7-agent cross-codebase audit (PR #210) flagged that `worker/src/index.js:3340` uses

```sql
ORDER BY s.h2h_pct DESC, s.allplay_pct DESC, s.pf DESC
```

…for the **full league standings page** ordering. Canon §F.2 (added 2026-05-16) clarified that this query is **neither** division-leader logic **nor** playoff-seeding logic — it's the visual sort for the standings page. There is **no canon rule** for what the standings-page sort SHOULD be. Keith filed this as a follow-up; the audit's original "mismatch" flag was scored against the wrong canon.

Three concepts in play (per §F.2):

| Concept | Source of truth | Where in code |
|---|---|---|
| **Division-champ tiebreaker** | MFL `lg.standingsSort` (year-specific) | `worker/src/index.js:3358–3384` — `sortFnFromStandingsSort()` applied per-division |
| **UPS playoff-seeding tiebreaker** | UPS canon §F.1: AP% → Overall → PF → H2H | `worker/src/index.js:3565–3573` — wild-card pool sort |
| **Standings-page visual sort** | **Undefined in canon** — this doc | `worker/src/index.js:3340` — current legacy ordering |

---

## Options

### Option A — Match canon §F.1 (UPS playoff seeding) ⭐ **Recommended**

Change the query to:

```sql
ORDER BY s.allplay_pct DESC, s.overall_pct DESC, s.pf DESC, s.h2h_pct DESC
```

- Mirrors the playoff-seeding tiebreaker chain from `worker/src/index.js:3565–3573` (with `overall_pct` slotted in per the §F.1 ladder, which the wild-card pool currently omits — see code comment at `:3563–3564`).
- The viewer's eye lands on the same primary stat (All-Play %) whether they're on the standings page or scanning playoff seeds.
- Stable across seasons (UPS-custom, not MFL-driven).

**Trade-off:** divorces the standings page from how MFL itself displays standings.

### Option B — Match MFL `standingsSort`

Reuse the existing `sortFnFromStandingsSort()` helper (`worker/src/index.js:3363–3383`) on the full row set instead of per-division.

- Standings page mirrors what MFL shows in the native UPS league UI.
- Year-aware: 2011 was `PCT,DIVPCT,PTS,H2H,PWR`; 2014+ moved to `PCT,DIVPCT,H2H,PTS,ALL_PLAY_PCT,PWR`.

**Trade-offs:**
- Year-to-year sort variability means a viewer comparing 2013 standings to 2014 standings sees a different primary-sort field. Confusing for retro-analytics.
- The `PCT` token in MFL `standingsSort` refers to overall winning %; UPS canon weights All-Play % more heavily for seeding. So the standings-page #1 wouldn't necessarily match the playoff-seeding #1.

### Option C — Leave H2H-first as legacy (no change)

- Zero risk, status quo.
- The audit flagged this ordering against the wrong canon (§F.1 instead of "no canon"), so the flag itself is moot — but the ordering still doesn't reflect any rule, just historical accident.

---

## Recommendation: **Option A**

Reasoning:

1. **Bot-narrative consistency.** Most UPS conversations center on playoff seeding ("who's the #1 seed?"); aligning the visual standings sort with the playoff-seeding ladder makes the bot's answer self-consistent with what an owner sees on the standings page.
2. **MFL parity is preserved where it matters.** Division-champ marking (`worker/src/index.js:3384`) already uses MFL `standingsSort` — the year-aware logic that owners rely on for divisional tiebreakers isn't touched.
3. **Stable across seasons.** A retro view of 2013 standings ranks teams the same way as a 2025 view, which matters for the historical-tracking work in the Standings module's 3-Year Eras view (`docs/standings_advanced_stats_proposals.md`).
4. **Code change is minimal.** Single-line `ORDER BY` swap. No new helpers needed.

---

## Code change preview (do NOT apply until Keith approves)

```diff
   LEFT JOIN src_franchises f
     ON f.season = s.season AND f.franchise_id = s.franchise_id
  WHERE s.season = ?
- ORDER BY s.h2h_pct DESC, s.allplay_pct DESC, s.pf DESC
+ ORDER BY s.allplay_pct DESC, s.overall_pct DESC, s.pf DESC, s.h2h_pct DESC
```

Touches one row of `worker/src/index.js:3340`. Per §F.1 the full chain is AP% → Overall → PF → H2H; the SQL above mirrors that.

The wild-card pool sort at `worker/src/index.js:3565–3573` currently uses AP% → PF → H2H (skipping `overall_pct`). Filed as a separate follow-up: if Option A is approved, the wild-card pool should be updated to include `overall_pct` in the same position so all three sites — playoff seeding, standings page, wild-card pool — use the identical §F.1 ladder.

---

## Decision needed from Keith

- [ ] **Approve Option A** — open a follow-up PR that changes `worker/src/index.js:3340` to match §F.1 and update §F.2 to record the standings-page-sort rule.
- [ ] **Approve Option B** — open a follow-up PR that switches to MFL `standingsSort` and update §F.2.
- [ ] **Approve Option C** — close the follow-up; document in §F.2 that legacy H2H-first sort is intentional.
- [ ] **Other** — Keith specifies a different chain.

This PR is **doc-only**. No code changes. Filing the recommendation so Keith can call it from here.
