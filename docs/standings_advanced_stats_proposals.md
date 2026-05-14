# Standings — Advanced Stats Proposals (for Keith review)

**Status:** open for review. Created with the v1 Standings module; not shipped yet.
**Source data assumed:** `src_standings`, `src_franchise_weekly_score`, `src_schedule`, `src_weekly_franchise_summary`, `src_league_season_meta`, `src_final_standings`.

---

## Why this doc exists

The first cut of the Standings module ships with the league's existing standings columns plus a Division Power Rankings view and a 3-Year Eras view. Two methodology choices in that work were called out as needing your sign-off before they ossify:

1. **Era headliners** = top 2 owners by **All-Play %** (rate stat) over the 3-year cycle, **with a 3-full-season tenure minimum**.
2. **Division Power Rankings** = aggregate **All-Play %** across the division's 3 teams for that season.

This doc captures both — plus a slate of advanced team-level stats we could add to the Overall view in v2 — so we can decide what's worth wiring up and what to leave out. **Appendix A** documents the owner-tenure rule and lists the known partial-tenure cases the data needs to handle correctly.

---

## Section 1 — Methodology review for shipped v1 stats

### 1A. Era headliners — UPDATED 2026-05-14

**Definition:** for each 3-year realignment cycle (`((season − 2011) / 3) × 3 + 2011` as the cycle start), an owner is **eligible** to be a headliner if they played ALL 3 seasons of the cycle. Among eligible owners, rank by `ap_pct = (allplay_w + 0.5 × allplay_t) / (allplay_w + allplay_l + allplay_t)` aggregated over the 3 seasons. Top 2 become "era headliners" — the era is named `"The <Owner1> & <Owner2> Era"`.

**Tie-break (within eligible owners):** AP % → AP wins → PF.

**Why AP % (not AP wins) — Keith 2026-05-14:**
- Everyone plays the same All-Play schedule each season (each franchise faces every other franchise every week), so AP denominators are effectively even across full-tenure owners. With the **3-season floor**, the denominator is identical across all eligible owners — AP % becomes the cleanest "who was best across these 3 years" rate stat.
- AP wins remain a fine **tie-break** signal, but lead with the rate stat.

**Why the 3-season tenure floor — Keith 2026-05-14:**
- Without a floor, a mid-cycle joiner (e.g. Brian Cross, 1 season of the 2023–25 cycle) or a mid-cycle departure (the post-Lima/Hammer/Whitman dispersal events) can post a small-sample AP % that distorts the headliner pick.
- The floor mirrors a simple league-fairness intuition: you can't be the face of an era you didn't play.
- Partial-tenure owners still appear in the era leaderboard with a "partial" badge so the table remains complete; they're just ineligible for headliner / retro-Captain status.

**Why two headliners:**
- Your framing: "the 2 most important players of their run."
- Some eras are clearly defined by a duopoly; a single headliner under-tells that.

**Edge cases:**
- **Ties at #2 among eligible owners** → re-sort by AP wins, then PF (handled in `renderStEras`).
- **In-progress era (2026–2028)** → shown with an "(in progress)" tag; headliners are deliberately suppressed until the cycle closes (no owner has hit the 3-season floor yet).
- **Mid-cycle joiners / departures** → see Appendix A for the documented historical cases.
- **Zero eligible owners for an era** (theoretically possible if dispersal scrambled everything; not observed historically) → the headliner banner shows "no eligible owners".

**Alternatives considered (rejected):**
- ~~AP wins~~ — superseded by AP % per Keith 2026-05-14.
- **Championships won** — under-tells regular-season dominance; overweights variance-heavy playoff side.
- **Composite (championships + AP % + PF z-score)** — possibly right long-term, but tuning knobs we'd need to defend. Park for v2.

**Action needed:** walk through 2011–2013, 2014–2016, 2017–2019. If the algorithm picks owners that match your memory of those eras, we lock it.

### 1B. Division Power Ranking metric

**Definition:** for each (`season`, `division`), aggregate stats across the division's 3 teams and rank by combined AP %. Tie-break: AP wins → division PF.

**Why aggregate AP %:**
- AP is matchup-luck-neutral — it measures how the division *scored*, not who they happened to draw outside the division.
- Game counts varied across eras (14 reg weeks ↔ 16 reg weeks ↔ 17). AP % normalizes; raw AP wins don't.

**Alternatives considered:**
- **Total AP wins** — fine within a cycle (all divisions play the same schedule type per §3.5.A), but cross-cycle comparisons get distorted by schedule length changes.
- **Per-team average AP %** — mathematically identical to aggregate AP % when divisions have the same team count (always 3 in UPS); kept the aggregate form for clarity.
- **Blended power rating (AP % + PF z-score + EFF)** — richer signal but introduces weighting choices. Easier to defend a single-metric ranking in v1.

**Action needed:** confirm aggregate AP % is the right primary metric. If you want a composite, we add weights in v2.

### 1C. Retro Captain seeding window (Eras view)

**Definition:** for each closed era card, the "retro Captains" pill row shows the top 4 owners by AP % aggregated over **the 3 seasons of that era**. **Same 3-season tenure floor applies** as for headliners.

**Why within-era (not prior-3-year window):**
- The actual 2026 captain rule uses **full historical AP %**; subsequent cycles (2029, 2032…) use **rolling prior-3-year AP %** (`league_context_v1.md §1378–1380`).
- For a historical view, within-era is the clearest framing — it shows "who would have been Captain if we'd used this rule THAT cycle."
- A rolling-prior-3-year computation would be the academically correct prospective view but harder to read at a glance.

**Action needed:** confirm within-era framing. If you want rolling-prior-3-year, swap the SQL window.

---

## Section 2 — Advanced team stats for the Overall view (proposed for v2)

The Overall view today shows record, division, AP, PF, PA, PP, EFF. These add value but weren't asked for in v1. Listed here so we can pick which to wire up.

### 2A. Luck Index

**Formula:** `h2h_w − allplay_w × (games_h2h / games_ap)`
**Plain English:** wins above (or below) what the team's AP record predicts.
**Why it lands here:** UPS already cares about AP. Luck Index makes "matchup luck vs. team quality" legible at a glance.
**Data needed:** `src_standings.h2h_w`, `allplay_w`, denominators.
**Recommendation:** **YES**, ship in v2. Most owner-resonant stat for a league that argues about who deserved their record.

### 2B. Strength of Schedule (opponent AP %)

**Formula:** mean of opponents' season AP % across the regular-season weeks the team actually faced them. Multi-opponent weeks count each opponent.
**Why it lands here:** separates "lucky schedule" from "got destroyed by every elite team you played."
**Data needed:** `src_schedule` joined to `src_standings` season AP %.
**Recommendation:** **YES**, ship in v2 — once you confirm whether you want regular-season-only or include-playoffs.

### 2C. Pythagorean expected wins

**Formula:** `PF^2.37 / (PF^2.37 + PA^2.37) × games`
**Plain English:** Football Outsiders' classic projection — what record your PF/PA "deserve."
**Why it lands here:** familiar to anyone who reads Football Outsiders / PFF; clean compare to actual W-L.
**Data needed:** `src_standings.pf` + computed PA (already in `/api/standings`).
**Recommendation:** **MAYBE** — duplicates a lot of what Luck Index conveys. Ship one, not both.

### 2D. Power Rating (composite z-score)

**Formula:** mean of per-season z-scores for `[allplay_pct, eff, pf]`. Renders as 0.0 = league average, +1.0 = one stdev above.
**Plain English:** a single number that orders teams by "true" quality.
**Why it lands here:** great for a "who's the best team right now" gut check.
**Data needed:** all already in `src_standings`.
**Recommendation:** **YES** if we limit the Overall view to one composite stat (which I'd recommend). Pick this over Pythagorean.

### 2E. Median W-L

**Formula:** for each week, the team gets a "win" if its score is above the league median, else a "loss" (tie if equal). Sum across the season.
**Plain English:** how often did you beat the typical team that week? Robust to outlier scores in either direction.
**Why it lands here:** UPS uses AP, which is similar but pairwise. Median is the "all play minus the noise" version — same intuition, smaller numbers.
**Data needed:** `src_franchise_weekly_score`.
**Recommendation:** **NO** — too close to AP. UPS already lives in AP land; adding median dilutes rather than adds.

### 2F. Cluster Luck (variance of margin of victory)

**Formula:** stddev of weekly score differential.
**Plain English:** "did this team blow people out and lose squeakers, or did it eke out every win?" Predictive of regression.
**Recommendation:** **MAYBE** — fun but niche. Defer past v2.

### 2G. Best Single-Week Score / Worst

**Trivial to compute** from `src_franchise_weekly_score`. Not really "advanced" — more of a fun stat. Could live in a separate "Notable Weeks" panel later.

---

## Section 3 — Recommended v2 slate

If we add three advanced stats to Overall, my pick is:

1. **Luck Index** (2A) — most owner-resonant, leverages the league's AP focus.
2. **Strength of Schedule** (2B) — answers the perennial "your schedule was easy" arg.
3. **Power Rating** (2D) — single-column "true strength" sort. Replaces the need for Pythagorean.

If you want only two, drop Power Rating.
If you want a wildcard fourth, **Cluster Luck (2F)**.

---

## Section 4 — Open questions for Keith

1. ~~Era headliners: AP wins, championships, or composite?~~ → **Resolved 2026-05-14: AP % with 3-season floor.**
2. Division Power Rankings: keep **AP %** as the single metric, or move to a blended power rating?
3. Retro Captains: **within-era** or **rolling-prior-3-year** AP %? (default: within-era)
4. Should the Overall view get advanced stats in v2 — and if so, which from §3?
5. Do you want regular-season-only or include-playoffs for the AP/SOS denominator on advanced stats? (legacy `mfl_hpm_standings.html` had a week-range toggle; we could carry that forward.)
6. Appendix A below — are the partial-tenure cases captured correctly? Are there mid-season replacement events I'm missing?

---

## Appendix A — Owner-tenure handling

The 3-season tenure floor (§1A, §1C) is enforced by counting how many seasons of a cycle an owner's `franchise_id` actually appears in `src_standings`. Owners with `seasons_played < 3` are flagged "partial" in the leaderboard but excluded from headliner / retro-Captain ranking.

### A.1 Data signal

In the worker query (`/api/eras`):

```sql
COUNT(*) AS seasons_played   -- after JOIN cycle ON c.season = s.season
```

The client-side filter is:

```js
var eligible = rows.filter(function (r) { return (r.seasons_played || 0) >= 3; });
```

### A.2 Sources cross-referenced

- **`docs/league_context_v1.md` §A7 "Dispersal Draft":** documents that "anytime a new owner joins, the league opens it up to all teams to opt in" — the **post-Lima/Hammer/Whitman event** was the inflection point that codified this rule. Confirms multiple historical owner replacements.
- **`docs/league_context_v1.md` §A7b "New Owner Onboarding":** documents the cap-penalty wipe + 1 cap-free cut that incoming owners receive — implies a discrete event that can happen mid-cycle.
- **`docs/research-archive/owner_divisional_history_for_context.md`:** current-owner roster + tenure summary. Shows tenure variance: most owners have 5 cycles (2011–2025 = 15 seasons); a handful have fewer.

### A.3 Documented partial-tenure cases (current owners, from `owner_divisional_history_for_context.md`)

| Owner | Cycles in league | Notes |
|---|---:|---|
| Brian Cross | 1 | Active 2025–2025 only. Joined mid-cycle 2025. **Partial** in the 2023–25 era. |
| Eric Martel | 1 | Active in the 2023–25 cycle. **Partial** depending on which season(s) within the cycle. |
| Matt Gerardi | 3 | Multi-cycle but check whether any cycles are partial. |
| Derrick Whitman | 4 | One of the "post-Lima/Hammer/Whitman" referenced owners — confirm departure timing. |

**Owners with 5 full cycles (2011–2025) — always eligible:**
Bear Dunn, Brian Cutting, Chris Klingenberg, Eric Mannila, Josh Martel, Keith Creelman, Ryan Bousquet, Shawn Blake.

### A.4 Historical (departed) owners referenced

`league_context_v1.md` mentions the **Lima/Hammer/Whitman event** as the trigger for the modern dispersal-draft rule. There were **3 confirmed dispersal events** noted (memory reference: `league_history_timeline.md` — not currently present in the repo working tree). Implication: at least 3 historical owners have been replaced mid-tenure, which is why the 3-season floor matters for retroactive era analysis.

**What we'd need to confirm:** the exact season(s) each of those owner transitions happened so we can spot-check which historical era cards correctly exclude them.

**Suggested follow-up (not in scope for v1):**
- Resurrect or re-create `memory/league_history_timeline.md` with the dispersal-event roster (year, outgoing owner, incoming owner, mid-season or offseason).
- Add a `src_owner_tenure` table that records `(franchise_id, season, owner_name, joined_via, departed_via)` so the module can render the "partial" badge with a tooltip explaining *why* (e.g. "joined via 2025 dispersal" vs. "departed mid-season").

### A.5 What the UI does today

- Era leaderboard table shows ALL owners for the cycle, full-tenure first sorted by AP %, then partial-tenure rows at the bottom, dimmed, with a `partial` badge in the owner cell.
- Headliner banner ignores partial-tenure rows when picking top 2.
- Retro-Captain pill row ignores partial-tenure rows when picking top 4. If no full-tenure owners exist, shows "No eligible owners yet (3-season minimum)".

---

## Appendix B — Where this rule should be reflected elsewhere

If the 3-season tenure floor is the right principle, it should probably also apply to:

- **`/api/division-power-rankings`** — when a division contains a partial-tenure owner, the aggregate AP % is computed over fewer games for that team. Worth flagging in the UI ("contains partial-tenure owner") rather than silently averaging?
- **Future captain-seeding analytics** — when we eventually wire up the rolling-prior-3-year AP % view for the actual 2029 / 2032 captain draft, the same 3-season-tenure check should apply.
- **Future advanced stats (§2)** — Luck Index, SOS, Power Rating all need a min-games filter to avoid small-sample distortion. Recommend a global `MIN_GAMES_FOR_RATE_STATS` constant when we wire those up.
