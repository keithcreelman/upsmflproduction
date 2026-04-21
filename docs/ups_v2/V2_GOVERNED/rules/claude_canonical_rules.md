# Claude Canonical Rules — UPS Salary Cap Dynasty League

> **Purpose.** Single source of truth for rules, terminology, and precedents that
> I (Claude) should use when helping with this league. Captured verbatim from
> the commissioner's instructions during review sessions. Append-only — prior
> rules are never deleted; they're superseded by a new rule with a back-reference.
>
> **Authority.** This file complements the human-facing
> [`ups_v2_rulebook_v4.html`](./ups_v2_rulebook_v4.html) and the governance
> trackers (`rule_ambiguity_register.csv`, `commissioner_directive_register.csv`).
> When a rule here conflicts with the authoritative HTML, the HTML wins and I
> should log the discrepancy as an ambiguity.

## Rule format

```
## RULE-{CATEGORY}-{NNN}: Short title
**Source:** Verbatim quote / chat timestamp / ticket ref
**Status:** active | provisional | superseded-by RULE-XXX
**Category:** terminology | contract | tag | extension | drop-penalty | taxi | roster | workflow | report
**Definition:** Plain-English rule
**Examples:** Concrete player/team examples that prove or clarify the rule
**Cross-refs:** Related rule IDs, rulebook HTML sections, governance entries
```

Category prefixes:
- `TERM` — terminology
- `CONTRACT` — contract structure / math
- `TAG` — franchise tag mechanics
- `EXT` — extension mechanics
- `DROP` — drop penalty mechanics
- `TAXI` — taxi squad mechanics
- `ROSTER` — roster construction / eligibility
- `CLASSIFY` — how to categorize players in reports
- `WORKFLOW` — how we work together (review process, data sources, etc.)

---

## RULE-TERM-001 — Contract field terminology
**Source:** Commissioner review of Blake Bombers, 2026-04-16
**Status:** active
**Category:** terminology
**Definition:**
- **CL** = Contract Length. The ORIGINAL contract length in years. Stays fixed once a contract is signed (even through extensions, a new CL is set when the extension takes effect).
- **TCV** = Total Contract Value. The sum of all year-by-year salaries over the contract's length.
- **AAV** = Average Annual Value. The per-year baseline used as the reference point for extensions and tags. **AAV survives restructuring** — it's the invariant that drives extension pricing regardless of how a contract is front-loaded or back-loaded.
- **Salary** = What counts against the cap in the CURRENT season. Can differ from AAV when the contract is front-loaded, back-loaded, or restructured.

**Examples:**
- A player won in auction for $15K → AAV = $15K.
- That player signed to a 2-year deal → TCV = $30K, CL = 2, AAV = $15K.
- The deal is structured $5K / $25K (back-loaded): Year 1 salary = $5K, Year 2 salary = $25K, AAV still $15K.

**Cross-refs:** RULE-CONTRACT-001, RULE-EXT-001

---

## RULE-CONTRACT-001 — Multi-year contract structures
**Source:** Commissioner review of Blake Bombers, 2026-04-16 (Brock Purdy example)
**Status:** active
**Category:** contract
**Definition:**
- Multi-year contracts can be **front-loaded** (higher salary in early years), **back-loaded** (higher salary in later years), or **restructured** (redistribute remaining salary).
- AAV never changes from structure alone. Only extensions change AAV.
- Year-by-year salary is encoded in the contract's `contractInfo` string as `Y1-XK, Y2-YK, Y3-ZK`.

**Examples:**
- **Brock Purdy (Blake Bombers)** — 3-year deal, TCV $84K, structured Y1-$40K, Y2-$22K, Y3-$22K. In 2026 he's in Y2 showing salary $22K. Front-loaded.

**Cross-refs:** RULE-TERM-001, RULE-CONTRACT-002

---

## RULE-CONTRACT-002 — MFL `contractYear` field = years remaining
**Source:** Derived during Walker III / Blake session, 2026-04-16
**Status:** provisional (needs commissioner confirmation)
**Category:** contract
**Definition:**
- MFL's `contractYear` field in the salaries export represents **years remaining on the contract** at the time of the export, not the current year-index.
- A 3-year contract in its second year shows `contractYear = 2` (2 years remaining), and its current-year salary is the Y2 value from `contractInfo`.
- At season rollover, MFL decrements `contractYear` by 1 on every active contract.
- The `contractInfo` string's `Y1/Y2/Y3` structure stays frozen — Y1 is always the first year of the original contract, regardless of how many years have elapsed.

**Examples:**
- Purdy contract `CL 3 | Y1-40K, Y2-22K, Y3-22K`. In 2026: `contractYear = 2`, salary = $22K (the Y2 value).
- Pure Greatness' Olave: `CL 2 | Y1-51K, Y2-11K`, in 2026 `contractYear = 1`, salary = $11K (Y2 value, because CL-1+1=Y2 when 1 year remains).

**Cross-refs:** RULE-CONTRACT-001. This is the rule I broke and then reverted — I tried to "fix" stale contractYear values and mangled 47 players' display.

---

## RULE-EXT-001 — Extension pricing (AAV + $10K)
**Source:** Commissioner review of Blake Bombers, 2026-04-16
**Status:** active
**Category:** extension
**Definition:**
- An extension adds **$10K to the player's AAV** for the extended year.
- AAV is the baseline regardless of current-year salary. Front-loaded / back-loaded structures don't change the extension pricing.
- Extensions can layer on top of any existing contract structure.

**Examples:**
- Player with AAV $15K → extended year AAV = $25K.
- Rigobelo (or similar player) whose AAV was $1K → extension took him to $11K this year. Matches rule.

**Cross-refs:** RULE-TERM-001, RULE-EXT-002 (pending tier rules)

---

## RULE-EXT-002 — Multi-year extension math (provisional)
**Source:** Commissioner review of C-Town Chivalry, 2026-04-16 (Jaxon Smith-Njigba example)
**Status:** provisional (needs confirmation that formula is exactly +$10K per extension year)
**Category:** extension
**Definition:**
- A multi-year extension appears to add **$10K per extension year** to AAV (not a flat +$10K for any extension length).
- 1-year extension: +$10K to AAV (RULE-EXT-001 confirmed).
- 2-year extension: +$20K to AAV (provisional, from JSN case).
- 3-year extension: presumably +$30K — to be confirmed.

**Examples:**
- **Jaxon Smith-Njigba (C-Town Chivalry)** — 2025 AAV $10K → got a 2-year extension → 2026 AAV $30K. Matches +$20K = 2 × $10K.

**Open questions:**
- Is the formula exactly `+$10K × extension_years` or is there a different multiplier for 2+ year extensions?
- Does the extension AAV apply to all remaining contract years or only the newly-added extension years?

**Cross-refs:** RULE-EXT-001, RULE-CONTRACT-003

---

## RULE-EXT-003 — Single-extension-per-team rule (per-team, NOT global)
**Source:** C-Town Chivalry review 2026-04-16 ("And he can no longer be extended by c town") + clarified 2026-04-18 via Josh Downs case ("He was extended by GRide but is on Cross' Team" — should still be extendable by Cross)
**Status:** active
**Category:** extension
**Definition:**
- A player who has been extended by a given team cannot be extended AGAIN by that same team.
- If traded to another team that has NOT previously extended him, the new team CAN extend him.
- Extension history is per-team, tracked in the `Ext: <team-list>` token of the contract info.
- The rule is per-team, not global — a player may accumulate multiple different team names in their Ext history over their career.

**Examples:**
- **Tony Pollard (C-Town Chivalry)** — was extended by C-Town (shown as `Ext: C-Town`). Cannot be extended again by C-Town, but could be extended by any other team he's traded to.
- **Josh Downs (Long Haulers, prior: Gride)** — contract shows `Ext: GRide`. Since Long Haulers (Cross) has NOT extended him, LH may extend him. Gride could not.
- Contract info like `Ext: UW, Creel, Chivalry` means those three teams cannot extend him. Any other team he lands on can.

**Cross-refs:** RULE-EXT-001, RULE-EXT-002

---

## RULE-CONTRACT-003 — Restructures redistribute salary across remaining years
**Source:** Commissioner review of C-Town Chivalry, 2026-04-16 (Jaxon Smith-Njigba example); reinforced by HammerTime review 2026-04-16 (Chase/Walker)
**Status:** active
**Category:** contract
**Definition:**
- A **restructure** redistributes salary dollars across the remaining contract years without changing AAV or TCV.
- Restructures happen in the offseason (not mid-season).
- Year salaries can be freely reshuffled — e.g., push money forward (increase Y1, decrease Y2/Y3) or defer (decrease Y1, increase Y2/Y3).
- **CRITICAL:** Restructure **DOES NOT** change AAV. AAV is preserved from the original contract. MFL sometimes auto-recomputes AAV from new TCV/CL after a restructure — that's a data bug we must correct manually.
- After a restructure, the `contractStatus` field should reflect the new salary distribution: `BL` (backloaded) if Y-values increase over time, `FL` (frontloaded) if they decrease. Extension-status (EXT1/EXT2) is superseded by the BL/FL status once restructured.

**Examples:**
- **Jaxon Smith-Njigba (C-Town)** — 3-year contract with AAV $30K (after 2-year extension). Restructured: Y1-$14K (2025), Y2-$1K (2026), Y3-$55K (2027). TCV still $70K, AAV still $30K.
- **Ja'Marr Chase (HammerTime)** — original 3yr deal AAV $54K restructured into 2 remaining years Y1-$26K/Y2-$103K (TCV $129K). AAV MUST stay $54K. MFL incorrectly showed AAV $64.5K (recomputed from $129K/2). Corrected 2026-04-16 by commissioner.

**Cross-refs:** RULE-TERM-001, RULE-EXT-002, RULE-CONTRACT-004 (AAV display quirk), RULE-CONTRACT-006 (BL/FL status), RULE-EXT-006 (extension allotment)

---

## RULE-DATA-001 — "UW" is the legacy franchise code for L.A. Looks
**Source:** Commissioner review of L.A. Looks, 2026-04-16
**Status:** active
**Category:** terminology / data
**Definition:**
- The franchise currently named **L.A. Looks** was previously called **Ulterior Warrior** (abbreviated **UW** in legacy contract info strings).
- Any `Ext: ... UW ...` token refers to L.A. Looks — same franchise, different name.
- For extension eligibility (RULE-EXT-003), "UW" and "L.A. Looks" count as the same team: a player with `Ext: UW` cannot be extended again by L.A. Looks.
- Contract info strings should eventually be rewritten so UW is replaced with "L.A. Looks" for clarity.

**Players currently showing "UW" in their 2026 contract info (need cleanup):**
- pid 13671 — `Ext: Blake, UW`
- pid 15799 (Jake Ferguson) — `Ext: Blake, UW`
- pid 14832 — `Ext: UW, Cleon`
- pid 15287 — `Ext: UW`
- pid 13630 — `Ext: UW`

**Cross-refs:** RULE-EXT-003 (single-extension-per-team)

---

## RULE-DATA-002 — MFL may corrupt contract info during trade + extension flows
**Source:** Commissioner review, 2026-04-16 (Ja'Marr Chase and Kenneth Walker III cases)
**Status:** observational (data issue, not a code rule)
**Category:** data
**Definition:**
- When a player is traded and/or extended, MFL's contract info string can become inconsistent with the UPS rulebook's expected values.
- The `salary`, `contractYear`, `contractInfo.TCV`, `contractInfo.AAV`, and year-by-year `Y1/Y2/Y3` values may all need manual commissioner correction.
- Our code should NOT try to auto-correct MFL's data. If a contract looks wrong, flag the player and let the commissioner update MFL directly.

**Known-corrupted cases (2026):**
1. **Ja'Marr Chase (HammerTime)** — 2025: 3yr deal $33K/$64K/$65K (TCV $162K). 2026 MFL says 2yr $26K/$103K (TCV $129K, AAV $64.5K). **Verified 2026-04-16 via `restructure_submissions.json`: HammerTime submitted NO 2026 restructure for Chase — only his original 2025 contract setup.** Correct 2026 values: remain in Y2 of original 3yr deal = $64K this year, $65K in 2027. MFL data needs manual correction.
2. **Kenneth Walker III (HammerTime)** — 2025 with L.A. Looks: 3yr deal $32K AAV (Ext: PG). Traded to HammerTime and extended in 2026. MFL 2026 shows `CL 2| TCV 74K| AAV 37K| Y1-15K, Y2-59K`. **Verified 2026-04-16: NO restructure submissions ever for this player — the trade+extension flow corrupted the contract.** Correct values: `CL 2| TCV 84K| AAV 32K, 42K| Y1-32K, Y2-42K| Ext: PG, Creel`. MFL data needs manual correction.

**Cross-refs:** RULE-CONTRACT-003 (restructures), RULE-EXT-001, RULE-WORKFLOW-002 (don't touch shared logic without approval)

---

## RULE-EXT-004 — AAV display format after extension
**Source:** Commissioner review of HammerTime, 2026-04-16 (Walker III case)
**Status:** active
**Category:** extension
**Definition:**
- After an extension, the AAV field in contractInfo should show as a **comma-separated list** of per-year AAVs.
- Format: `AAV {current_year_aav}, {extended_year_aav}[, {extended_year_2_aav} ...]`
- The current-year AAV remains the ORIGINAL AAV pre-extension. The extension-year AAV(s) are +$10K each (per RULE-EXT-001/RULE-EXT-002).
- Example: Walker III originally AAV $32K. Extended 1 year → AAV displays as `AAV 32K, 42K` (current $32K, extended year $42K).
- This format coexists with restructure year-by-year salary values. AAV reflects the original per-year contract pricing; Y1/Y2/Y3 show current restructured salaries.

**Examples:**
- **Walker III (HammerTime)** — originally AAV $32K → extended 1yr → AAV `32K, 42K`. After restructure: Y1-$15K, Y2-$59K (restructured salary), AAV preserved as `32K, 42K`.
- **Tony Pollard (C-Town, from prior review)** — extended 1yr, AAV recomputed to $27K post-extension. MFL incorrectly still displays `AAV 17K, 17K` (RULE-CONTRACT-004 data quirk).

**Cross-refs:** RULE-EXT-001, RULE-EXT-002, RULE-CONTRACT-004

---

## RULE-EXT-005 — Extension allotment per team per offseason [SUPERSEDED]
**Source:** Original: HammerTime review 2026-04-16. Superseded 2026-04-17: "there's no limit on extensions."
**Status:** superseded (see correction below)
**Category:** extension
**Correction (2026-04-17):** There is NO numeric cap on how many extensions a team can execute per offseason. The only extension limits are:
- RULE-EXT-003: a given team cannot extend the SAME player more than once (once a team has extended a player, they're done extending him).
- The player must be extension-eligible (not previously tagged, etc.).

HammerTime extending both Chase and Walker in the 2026 offseason was fine.

**Cross-refs:** RULE-EXT-001, RULE-EXT-003, RULE-RESTR-001 (restructure limit)

---

## RULE-RESTR-001 — Restructure limit: 3 per team per offseason
**Source:** Commissioner, 2026-04-17 ("Restructures we allow 3")
**Status:** active
**Category:** contract / restructure
**Definition:**
- Each team may execute at most **3 restructures** per offseason.
- A restructure redistributes salary across remaining contract years without changing AAV or TCV (RULE-CONTRACT-003).
- Each player-restructure counts as 1, regardless of how many years are reshuffled.
- Restructures are the primary mechanism for smoothing cap across seasons; 3 is meant to keep teams from gaming the cap.

**Tracking:**
- Count per team per year via `ccc/restructure_submissions.json` (logged submissions) + any commissioner-manual restructures that need backfilling (RULE-EXT-006 pattern).
- Any restructure beyond #3 in a single offseason is a rule violation.

**Examples:**
- HammerTime 2026 offseason: Chase (restructure) + Walker III (restructure) = 2 of 3 used. 1 more allowed.

**Cross-refs:** RULE-CONTRACT-003, RULE-EXT-006

---

## RULE-EXT-006 — Unlogged extensions must be backfilled into our tracking
**Source:** Commissioner review of HammerTime, 2026-04-16
**Status:** active
**Category:** workflow / extension
**Definition:**
- When an extension is applied directly in MFL (commissioner UI) without going through our contract submission flow, it is NOT logged in `restructure_submissions.json` / `extension_submissions.json`.
- These unlogged extensions still consume the team's allotment (RULE-EXT-005) and must be backfilled into our tracking data.
- When flagged (e.g., via contract corruption like Chase/Walker), we need to:
  1. Record the extension in our tracking files
  2. Count it against the team's allotment
  3. Correct the AAV and contract structure in MFL to match our rules

**Examples:**
- Chase (HammerTime) — extended + restructured 2026 offseason, never submitted to our system. Must be backfilled.
- Walker III (HammerTime) — extended + restructured 2026 offseason post-trade, never submitted. Must be backfilled.

**Cross-refs:** RULE-EXT-005, RULE-DATA-002

---

## RULE-ROSTER-001 — Maximum 5 frontloaded+backloaded contracts per team (COMBINED)
**Source:** Commissioner review of HammerTime, 2026-04-16 (corrected 2026-04-16: "MAX RULE-ROSTER-001: Max 5 COMBINED FRONT OR backloaded contracts per team")
**Status:** active
**Category:** roster
**Definition:**
- A team's active roster may contain **at most 5** contracts with `contractStatus in {BL, FL}` **combined** at any given time.
- BL = backloaded (salary increases over contract years)
- FL = frontloaded (salary decreases over contract years)
- Example: a team with 3 BL + 2 FL = 5 total (at the cap). Adding a 4th BL or a 3rd FL would be a violation.
- Exceeding this limit is a rule violation and should be flagged for commissioner review.
- When a player's contract is restructured into a BL or FL structure (per RULE-CONTRACT-003), the count increments for that team.

**Enforcement:**
- Our tooling should check (BL_count + FL_count) per team on any restructure or extension submission.
- Roster workbench should show each team's combined BL+FL count prominently (with BL and FL broken out).
- Any team where `BL_count + FL_count > 5` should generate an alert.

**Open questions:**
- What happens to a team currently over the 5-combined limit (legacy state)?
- Do expired/dropped BL/FL contracts free up slots immediately or at offseason rollover?

**Cross-refs:** RULE-CONTRACT-003

---

## RULE-DATA-003 — Duplicate GTD token in contractInfo (MFL bug)
**Source:** Commissioner review of HammerTime, 2026-04-16 (Walker III case)
**Status:** active
**Category:** data
**Definition:**
- MFL's contract info string sometimes contains the GTD token twice (e.g., `...| GTD: 55.5K| Ext: ...|GTD: 55.5K`).
- This happens after trade+extension+restructure flows.
- We should normalize contractInfo to a single GTD occurrence when detected, preserving the first (or canonical) value.
- Any import XML we send must contain exactly one GTD token.

**Examples:**
- Walker III MFL: `CL 2| TCV 74K| AAV 37K| Y1-15K, Y2-59K| GTD: 55.5K| Ext: PG, RealDeal|GTD: 55.5K`. Should be: `CL 2| TCV 74K| AAV 32K, 42K| Y1-15K, Y2-59K| GTD: 55.5K| Ext: PG, RealDeal`.

**Cross-refs:** RULE-DATA-002

---

## RULE-DATA-005 — MFL `TYPE=salaries` import REPLACES, does not merge (CRITICAL)
**Source:** Post-mortem of 2026-04-17 incident during L.A. Looks review
**Status:** active
**Category:** data / workflow
**Definition:**
- MFL's import endpoint `?TYPE=salaries` REPLACES the entire league's salaries table with whatever is in the POSTed `<salaries>` document.
- Posting a partial set of players wipes every other player's contract data.
- ANY tool that POSTs TYPE=salaries MUST:
  1. Fetch the current salaries export from MFL
  2. Build an in-memory map of all current players
  3. Overlay the updates onto the map (keyed by player id)
  4. Post the FULL merged set
- The same is NOT true of `?TYPE=salaryAdj` — salary adjustments append/replace per-franchise differently.

**Incident log:**
- 2026-04-17 11:05 PT: Posted 7-row salaries XML (Chase/Walker/5 UW renames) via browser session. MFL returned `<status>OK</status>`. MFL's salaries export afterward showed only those 7 players with contract data; 404 other players had blank salary/contractInfo. Recovered by building full restore XML from earlier backup + overlaying the 7 corrections, then re-posting the full 404-row set. Worker endpoint `/admin/import-salaries` updated to always fetch-merge-post.

**Cross-refs:** RULE-DATA-002 (data corruption patterns), RULE-WORKFLOW-002 (don't touch shared logic without approval)

---

## RULE-DATA-004 — All contract data must come from live MFL API
**Source:** Commissioner review of HammerTime, 2026-04-16 ("all references to contracts on the website comes from the API because I see chase had AAV of 54K in front office despite the issue in the display")
**Status:** active
**Category:** data / workflow
**Definition:**
- EVERY contract-related display across our tooling (roster workbench, front office, contract command center, Discord bot, cap summary, trade grader, etc.) MUST source its contract data from the live MFL salaries / rosters / league exports.
- No cached static files, no hardcoded overrides, no stale report artifacts — the live MFL API is the single source of truth for contract state.
- If a UI shows one value (e.g., Chase AAV $54K in front office) and another place shows a different value (e.g., Chase AAV $64.5K in roster workbench), one of them is out of sync and must be investigated and corrected.
- Any player override or manual data must be injected BY correcting MFL itself, not by local shims.

**Known violations to investigate:**
- Chase showed `AAV $54K` in front office vs `AAV $64.5K` in MFL's raw salaries export. Source of the $54K needs to be identified — if it's a hardcoded override somewhere, remove it and rely on MFL.

**Cross-refs:** RULE-WORKFLOW-002 (don't modify shared display logic), RULE-DATA-002 (MFL is source of truth for contracts)

---

## RULE-CONTRACT-004 — AAV display may lag after extension (data quirk)
**Source:** Commissioner review of C-Town Chivalry, 2026-04-16 (Tony Pollard case)
**Status:** informational
**Category:** contract
**Definition:**
- MFL's `contractInfo` string sometimes preserves the **pre-extension AAV** in its `AAV XK, XK` token, even after an extension has recalculated the actual AAV.
- Example: Tony Pollard shows `AAV 17K, 17K` in the contract info, but his true post-extension AAV is $27K (derived from TCV $54K / CL 2).
- This is an MFL display quirk, not a math error. When reasoning about extensions, trust the TCV ÷ CL calculation (or the actual contractStatus EXT1/EXT2 flag) over the displayed AAV.

**Cross-refs:** RULE-TERM-001, RULE-EXT-001

---

## RULE-DROP-001 — Year N of N non-rookie drops (no penalty)
**Source:** Commissioner review of Blake Bombers, 2026-04-16 ("Every player that is dropped makes sense")
**Status:** active
**Category:** drop-penalty
**Definition:**
- Players on the **final year** of their contract (Year N of N, or `contractYear = 1` by MFL's convention), where `contractStatus` is NOT a rookie contract, incur **no cap penalty** when dropped.
- These players are essentially expired contracts at season's end; dropping them just prevents auto-rollover.

**Examples:**
- All 14 Blake Bombers DROPPED players had `contractYear = 1` and non-rookie contract types → confirmed correct, no penalty for any.

**Cross-refs:** RULE-TAG-ELIG-001 (these same players were tag-eligible but weren't tagged — that's owner's choice), RULE-DROP-002 (rookie drops, pending full rule)

---

## RULE-TAG-001 — Tag-after-tag ineligibility (provisional)
**Source:** Commissioner review of Blake Bombers, 2026-04-16 ("Barkley isn't eligible. Because he was tagged last year.")
**Status:** provisional (needs clarification on scope)
**Category:** tag
**Definition:**
- A player who was tagged the prior season is NOT eligible to be tagged again the following season.
- Commissioner statement: "Barkley isn't eligible" — unclear whether this means ineligible for re-tag only, or also ineligible for extension, or also blocked from roster retention entirely.
- For now: assume ineligible for **re-tag** and ineligible for **extension** (both require re-negotiating contract terms, and the tag already signaled "last year together").

**Examples:**
- Saquon Barkley (Blake Bombers) — 2025 status TAG at $61K with note "No Further Extensions". Dropped for 2026 because he couldn't be tagged again or extended.

**Open questions:**
- Is the ineligibility permanent after one tag, or does it reset after the player leaves the roster?
- Does it apply across teams (e.g., traded during tag year)?

**Cross-refs:** Logged as AMB pending in `rule_ambiguity_register.csv`. RULE-TAG-ELIG-001.

---

## RULE-TAG-ELIG-001 — Tag eligibility on 1-year-remaining players
**Source:** Commissioner review of Blake Bombers, 2026-04-16 ("All of the other players that were one year remaining on his team are now tag eligible for this year")
**Status:** active
**Category:** tag
**Definition:**
- Players entering their contract's final year (1 year remaining, non-rookie) ARE tag-eligible for the following season.
- This is the owner's choice — they can tag, extend, or let the player walk.
- Eligibility is contingent on the player NOT having been tagged the prior year (see RULE-TAG-001).

**Examples:**
- Blake Bombers' 1-year-remaining non-rookie dropped players were all tag-eligible for 2026, but Blake chose not to tag them. That's legitimate owner's choice.

**Cross-refs:** RULE-DROP-001, RULE-TAG-001

---

## RULE-CLASSIFY-001 — Tag vs Extension classification in reports
**Source:** Commissioner review of Blake Bombers, 2026-04-16 ("Jacoby Brissett. He's not technically extended. He was tagged.")
**Status:** active
**Category:** classify
**Definition:**
- In the 2025→2026 roster transitions report (and any future player-status report), franchise tags and contract extensions are **distinct categories**.
- A tagged player must appear in the TAGGED bucket.
- An extended player (CL increased, or contractStatus moved to EXT1/EXT2) must appear in the EXTENDED bucket.
- A player cannot appear in both.

**Detection order (first match wins):**
1. 2026 contractStatus in `{TAG, TAG1, TAG2, Tag}` → TAGGED
2. 2026 contractStatus in `{EXT1, EXT2}` AND differs from 2025 contractStatus → EXTENDED
3. CL 2026 > CL 2025 → EXTENDED
4. Salary or type changed → MODIFIED
5. Otherwise → RETAINED (or DROPPED / TRADED if roster changed)

**Examples:**
- Jacoby Brissett (Blake Bombers) — 2025 contractStatus non-TAG, 2026 contractStatus TAG (Tier 3) → should classify as TAGGED, not EXTENDED.
- Christian McCaffrey (Sex Manther) — 2025 salary $56K, 2026 salary $62K, 2026 status TAG (Tier 1) → TAGGED.

**Cross-refs:** RULE-TAG-001

---

## RULE-WORKFLOW-001 — Team-by-team review process
**Source:** Commissioner request, 2026-04-16
**Status:** active
**Category:** workflow
**Definition:**
- Commissioner reviews roster transitions **one team at a time**.
- For each rule or issue identified on a team, I cross-reference ALL OTHER TEAMS for similar patterns and flag them, grouped by 2026 team.
- Flagged players are NOT automatically cleared. The commissioner must explicitly confirm per team (e.g., "yes, all of Team Z's matches are fine") before the players are marked cleared.
- When in doubt, capture the rule to this file before making any code or data changes.

**Cross-refs:** velvet-snuggling-gizmo.md plan file

---

## RULE-WORKFLOW-002 — Don't modify shared contract-display logic without explicit request
**Source:** Commissioner, 2026-04-16 ("STOP FUCKING MY SHIT UP" after Walker III incident)
**Status:** active
**Category:** workflow
**Definition:**
- I do NOT modify shared logic (`displaySalaryFromContractInfo`, `normalizeContractInfoForDisplay`, `inferYearsRemainingFromContract`, etc.) unless the commissioner explicitly asks.
- If a single player displays incorrectly, the solution is a targeted, player-specific override — NOT a generic rule that affects every player in the league.
- If a generic fix is warranted, I propose it explicitly, list every player it would affect, and wait for approval.

**Background:**
- I previously tried to "fix" Kenneth Walker III's stale MFL `contractYear` by changing shared display logic. This corrupted 47 other players' year-remaining display. The change was fully reverted in commit `da03afc`.

**Cross-refs:** RULE-CONTRACT-002

---

## RULE-CAP-003 — Drops before FA Auction apply to current season
**Source:** Commissioner, 2026-04-17 ("All drops between now and Free Agent Auction apply to 2026")
**Status:** active
**Category:** drop-penalty / cap
**Definition:**
- Any drop that triggers a cap penalty, executed **before** the Free Agent Auction for the current season, applies to the **current season's** cap (not the next season).
- After the FA Auction starts, penalties roll forward to the NEXT season per RULE-CAP-001.
- Each drop → cap-penalty must be pushed through the full pipeline:
  1. Post salaryAdj to MFL (real data — shows up in MFL cap pages and roster workbench automatically)
  2. Post Cap Penalty Announcement to Discord (`Cap Penalties` channel)
  3. Post front-end update via the worker + roster workbench (pulls MFL live)

**Cross-refs:** RULE-CAP-001, RULE-CAP-002, RULE-WORKFLOW-004

---

## RULE-WORKFLOW-004 — Drop → cap-penalty automation pipeline
**Source:** Commissioner, 2026-04-17
**Status:** active (scheduled cron: every hour at :05 past)
**Category:** workflow
**Definition:**
Cron trigger: every hour at `:05 past` (5 minutes after each hour).
Worker scans MFL adddrop/waiver/FA transactions and for each new drop that was not yet processed:
1. Compute the penalty (RULE-DROP-001, RULE-CAP-002 dynamic rounding if applicable, RULE-CAP-003 season-target).
2. POST salaryAdj to MFL so it becomes canonical data (shows in MFL cap pages + roster workbench Cap Summary automatically).
3. POST Cap Penalty Announcement to the Cap Penalties Discord channel via `/admin/cap-penalty/post`.
4. Log the event in a ledger keyed by `ledger_key` (idempotent — re-runs skip already-posted events).

Pre-auction vs post-auction:
- Pre-auction: penalty applies to CURRENT season (2026 until FA Auction start). Round dynamically (RULE-CAP-002) but note value is subject to final recompute.
- Post-auction: penalty applies to NEXT season (RULE-CAP-001), rounded at the time of auction lock.

**Cross-refs:** RULE-CAP-001, RULE-CAP-002, RULE-CAP-003

---

## RULE-CAP-001 — Drop penalties become future-season cap hits after auction
**Source:** Commissioner, 2026-04-17
**Status:** active
**Category:** drop-penalty / cap
**Definition:**
- During the regular-season/offseason window when cap hits are still applied to the CURRENT season, dropped-player penalties are posted as salary adjustments to the current season (RULE-DROP-001 and friends).
- Once we reach the point where cap hits are no longer allowed for the current season (effectively when the FreeAgent Auction is about to start), any remaining drop penalties roll forward to the NEXT season's cap.
- We must:
  1. Continue computing drop penalties in the background even after the current-season cutoff
  2. Log each future-season cap hit to Discord (Cap Penalties channel) when it occurs
  3. Store the penalty with its target season so we can post it to MFL when the time is right
- Trigger: once the auction starts (current season closed for cap adjustments), penalties shift to target the upcoming season.

**Tracking:**
- New data file needed: pending future-season cap hits keyed by (season, franchise_id, player_id, ledger_key)
- Source of truth: `salary_adjustments_YYYY.json` report → apply to season N+1 when the `import_target_season` field indicates rollover.

**Cross-refs:** RULE-DROP-001, RULE-CAP-002

---

## RULE-CAP-002 — Round cap penalties at TEAM level (dynamic, locks at auction)
**Source:** Commissioner, 2026-04-17 ("Rounding is done at the Team Level not transactionally")
**Status:** active
**Category:** drop-penalty / cap
**Definition:**
- Rounding to nearest $1,000 applies to each team's **total** drop-penalty cap hit — NOT to individual transactions.
- Each drop is computed and stored at its raw value (TCV<$5K fixed $1K rule + GTD−Earned + Waiver 35% all produce exact dollar amounts). Raw values are what land in MFL's `salaryAdjustments` as the canonical data.
- Team-level rounding is computed downstream and shown only in displays (Discord Cap Penalty Announcement, Cap Summary on the workbench).
- Rounding is **dynamic** — it recomputes on every scan and moves as new drops get added or existing ones roll forward.
- At FA Auction start, rounding **locks** — the final rounded delta is posted to MFL as a single-row "Other" bucket adjustment per team with description `Rounding`.
- Until the lock moment, no rounding rows are written to MFL.

**Examples:**
- Blake Bombers raw drops sum: $1,000 + $1,000 + $2,000 + $1,000 = **$5,000**. Rounded: $5,000 (no delta).
- HammerTime raw drops sum: $2,500 + $3,250 + $1,000 + $2,800 = **$9,550**. Rounded: $10,000. Dynamic delta: +$450 (shown in display). Locked to MFL only at auction.

**Display expectation:**
- Pre-auction posts must indicate: _"Rounding is dynamic and will lock at the Auction"_ so owners know the team total may shift until the lock moment.

**Cross-refs:** RULE-CAP-001, RULE-CAP-003, RULE-DROP-001

---

## RULE-WORKFLOW-003 — Discord contract activity analysis format
**Source:** Commissioner, 2026-04-17
**Status:** active
**Category:** workflow / discord
**Definition:**
- Every contract-activity post (extension, restructure, tag) that hits the Contract Activity Discord channel gets a follow-up reply with Claude-powered analysis.
- Reply is **concise** (trade-roast style, but shorter), focused on informative cap impact — not AAV deep dives.
- Include:
  - Player salary change (this year → next year)
  - Team's current BL/FL count (toward 5-max per RULE-ROSTER-001)
  - Team's restructure count this offseason (toward 3-max per RULE-RESTR-001)
  - Some wit/roast where appropriate
- Do NOT include AAV or extension-math details — commissioner wants salary-impact focus.
- For player-post-trade restructures (e.g., Walker III): call out the trade context, but don't re-announce the extension — that already happened at trade time.

**Trade-post analysis format:**
- Teams involved
- Date
- Cap adjustment amount (+/- for each side)
- Some commentary on the trade value

**Drop penalty post format:**
- Same data we show in the front-end Cap Summary drilldown
- Player, team, contract, drop date, penalty amount, rule applied
- Note whether the penalty is current-season or future-season rollover (per RULE-CAP-001)
- Store to stable ledger file so penalty can be applied to MFL at the right time

**Cross-refs:** RULE-CAP-001, RULE-CAP-002, RULE-EXT-005 (superseded), RULE-RESTR-001

---

## RULE-DATA-006 — MFL TYPE=salaries import: worker write recipe (LOCK)
**Source:** Commissioner + Claude debug session, 2026-04-18 (Downs/Pollard writes)
**Status:** active
**Category:** data / worker / mfl-api

### The silent-reject problem
MFL's `/import?TYPE=salaries` endpoint returns **HTTP 200 with empty body** when it accepts the request but refuses to persist — no error message, no redirect, nothing. Diagnosed root cause: MFL serves a minimal response when it detects a non-browser client posting a REPLACE-scoped operation.

### Working request recipe (worker → MFL for TYPE=salaries)
```js
await fetch(`https://www48.myfantasyleague.com/${season}/import?TYPE=salaries&L=${league}`, {
  method: "POST",
  headers: {
    Cookie: cookieHeader,                       // env.MFL_COOKIE — must carry commish session
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
    "Accept": "text/xml, text/plain, application/xml, */*",
    "Accept-Encoding": "identity",              // force uncompressed
  },
  body: new URLSearchParams({ DATA: dataXml }).toString(),
  redirect: "follow",                            // MFL redirects to success page; manual mode = empty body
});
```

**Success signature**: response body contains `<status>OK</status>`.
**Failure signature**: response body contains `<error>...</error>` OR is empty (silent reject).

### Anti-patterns that silently fail
- `User-Agent: upsmflproduction-worker` (any non-browser UA) — triggers silent reject
- `redirect: "manual"` — misses success-page body
- Including `APIKEY` in form when also using cookie auth — MFL accepts but doesn't persist
- Missing `Accept-Encoding: identity` — occasional gzip surprises

### Merge requirement (RULE-DATA-005)
`TYPE=salaries` REPLACES the entire salaries table. Always fetch current full salaries → merge target rows in → post merged full set. Never post partial data.

### Scope
- Applies to `TYPE=salaries` (contracts) from the Worker
- `TYPE=salaryAdj` (cap adjustments, drop penalties, trade cap) uses the legacy `postMflImportForm` path without these quirks — it's an APPEND operation that MFL treats more permissively.

**Cross-refs:** RULE-DATA-005 (TYPE=salaries REPLACES)

---

## RULE-CONTRACT-005 — Contract origin story + AAV lineage (LOCK)
**Source:** Commissioner, 2026-04-18 (Downs/Pollard/Group-1 deep-dive)
**Status:** active
**Category:** contract / audit / extension

Every rostered player's **stored AAV** must trace back to one of three **baselines**, then accumulate extension raises from there.

### Baselines (mutually exclusive)
1. **Rookie Draft** — slotted AAV based on round (approximate; verify against that season's rookie scale):
   - R1 ≈ $14K × 3yr (AAV $14K)
   - R2 ≈ $5K × 3yr (AAV $5K)
   - R3 ≈ $2K × 3yr (AAV $2K)
   - R4+ ≈ $2K × smaller / varies
2. **FA Auction win** — winning bid IS the new AAV. **HARD RESET** — prior contract history (extensions, tags) is wiped. Source: `transactions_auction.bid_amount` where `auction_event_type = 'WON'`.
3. **Re-sign after rookie expiry** (pre-2021 era, no weekly snapshots) — if prior-year contract ended (`contract_year = 1` at end of season) and player stays on same team with a new contract, infer re-sign by that team (may lack `Ext:` tag on pre-format strings).

### Post-baseline AAV accumulation
- Each subsequent extension raises AAV by `extension_rate × extension_years`.
  - **Current rates (2024-2025):** QB/RB/WR/TE = $10K (1YR) / $20K (2YR); PN = $3K/$5K; PK = $3K/$5K
  - **Historical rate changes** (need data loaded to `conformance_extensions` keyed by season):
    - **TE**: $6K/$12K → $10K/$20K when league adopted TE Premium scoring
    - **QB**: $6K/$12K → $10K/$20K when league adopted Super Flex
    - **RB and WR rates have ALWAYS been $10K / $20K** — no historical variation (confirmed 2026-04-18). Do not apply 6/12 fallback to RB/WR extensions.
  - Tracer must use the rate in effect at the time of the extension.
- **Multiple extensions** tracked in `Ext: Team1, Team2, ...` tag. Math: `baseline_AAV + Σ(raise_per_ext)`.
- **Trades do NOT change AAV** — player moves with contract intact.
- **Drops reset the contract.** Re-added = new baseline.

### Pre-2021 inference logic (no weekly data)
When weekly rosters are missing for a season, infer from:
- **Auction participation**: player in `transactions_auction` that season?
  - **April/May auction** = expired-rookie auction (baseline reset, league-dependent ~2020+)
  - **July/August auction** = annual FA Auction (baseline reset)
- **Add/drop transactions**: waiver/bid pickup mid-season implies a new baseline (not an extension).
- **Neither auction nor add/drop**: player was either (a) still on prior contract, (b) extended/re-signed by prior team, or (c) tagged — pick the interpretation that matches end-of-year contract shape and `Ext:` tag.

### Load detection (BL / FL)
- **Backloaded (BL)** — salaries strictly increase, `last_year_salary > first_year_salary` (Drake London: Y1-$14K, Y2-$52K, AAV $33K)
- **Frontloaded (FL)** — salaries strictly decrease, `first_year_salary > last_year_salary` (Olave: Y1-$51K, Y2-$11K)
- **Flat** — all year salaries equal AAV
- **Restructured** — year salaries diverge non-monotonically (JSN: Y1-$14K Y2-$1K Y3-$55K)
- **Always-true invariant**: `sum(year_salaries) == TCV`
- **Conditional invariant**: `AAV × CL == TCV` holds ONLY for non-extended contracts (pure rookie/auction deals). For EXTENDED contracts with carryover remaining years, `TCV = (carryover_year_salaries_at_old_salary) + (new_AAV × ext_years)`, so `AAV × CL ≠ TCV` is expected and correct. Example: Tua 2024 post-2YR-ext: CL=3, AAV=$49K, TCV=$116K. $49×3=$147≠$116 because Y1=$86K is a restructured carryover / front-load, not $49K.

### CORRECTED audit rule
- `sum(year_salaries) == TCV` — the only hard invariant
- `current_AAV == baseline_AAV + Σ(extension_raises)` — lineage check (requires full history)
- **DEPRECATED:** "AAV == last year salary" — only holds for flat contracts; fails for BL/FL.
- **DEPRECATED:** "AAV × CL == TCV" universal check — only valid for non-extended contracts. Extended contracts carry over the remaining old-contract year(s) at old salary, breaking this math.

### Tags
- Tags have been implemented multiple ways: Blind Bid, Auction, direct commish edits. Behavior varies by year.
- Post-tag contract may be re-signed extension, carryover, or reset. Needs per-case verification until tag rules are fully codified.

**Cross-refs:** RULE-EXT-001, RULE-EXT-003, RULE-CONTRACT-001, RULE-CONTRACT-003, RULE-RESTR-001, RULE-DATA-004

---

## RULE-WORKFLOW-005 — Pre-2021 lineage inference (no weekly rosters)
**Source:** Commissioner, 2026-04-18
**Status:** active
**Category:** workflow / data / contract-lineage

Weekly roster snapshots (`rosters_weekly`) only go back to 2021. For players whose career spans earlier seasons, we must INFER their per-season state from the event tables that do exist. The tracer (`trace_contract_history.py` / `build_rostered_players_lineage.py`) should treat these as authoritative when weekly data is missing:

### Signals available pre-2021
- `draftresults_mfl` — rookie draft picks by season (reliable back to league origin 2010)
- `transactions_auction` (event_type=WON) — FA auctions by season with bid amounts, auction_type, and dates
- `transactions_adddrop` — mid-season adds/drops with methods (FREE_AGENT, BBID, TAXI, etc.)
- `transactions_trades` — trade group records
- `franchises` — season-keyed franchise names + owner names (the truth for historical team naming, since rosters_weekly.team_name was backfilled with current names)

### Inference rules

1. **Auction type by timing:**
   - **April/May auction** ≈ expired-rookie auction (started ~2020 when league adopted the concept). Player's rookie contract expired the prior season; re-bid opens the contract anew at the winning bid price. Hard reset (wipes Ext history).
   - **July/August auction** ≈ annual FA Auction. Hard reset. Most common.
   - **Any other date** is likely a mid-season waiver pickup (not an auction) — check `transactions_adddrop` for method.

2. **Add/drop transitions mid-season:**
   - DROP + same-season ADD with matching `method` → **waiver pickup cycle**. The dropped team eats cap penalty per RULE-CAP-001; the claiming team gets a new baseline contract at the BBID salary + default contract length.
   - DROP without paired ADD → player was released to FA; rest of the season they're unowned.
   - ADD without paired DROP → midseason waiver claim from FA pool.

3. **Pre-2021 ownership + franchise-rename history:** Owner/team history is in `franchises(season, franchise_id)`. Use that for displaying team names for events AT THE TIME they occurred. Never use the current-season map for historical events.

4. **No-data implicit continuity:** If a player has a rookie draft in year Y, no auction win and no adddrop events between Y and Y+N, AND they show up on a weekly roster in Y+N, we infer they continued on the SAME contract (likely extended by their original team or kept at rookie wage) even if the exact extension event isn't in the data.

5. **Position-group rate history** (see RULE-CONTRACT-005 for current rates):
   - TE: 6/12 before TE-Premium adoption, 10/20 after.
   - QB: 6/12 before Super Flex adoption, 10/20 after.
   - RB, WR: always 10/20.
   - Exact adoption years need data loaded into `conformance_extensions`; until then, tracer tries both rate options and flags which one matched the stored AAV.

**Cross-refs:** RULE-CONTRACT-005, RULE-DATA-004

---

## RULE-TAG-002 — Super Flex Keeper (provisional, pre-Super-Flex transition)
**Source:** Commissioner, 2026-04-18 (Tua 2022 review)
**Status:** provisional
**Category:** tag / keeper / historical

When UPS MFL transitioned to Super Flex scoring (at some point between 2020 and 2022), the league ran a **Super Flex Keeper ceremony**: teams had to designate which QBs they wanted to keep under the new format. **Any QB NOT designated as a Super Flex Keeper was thrown back into the FA auction pool without a cap penalty to the prior owner.**

**Confirmed case:**
- **Tua (pid 14778)** — drafted 2020 R2.07 by Cleon Ca$h. In May 2022 Cleon dropped him (transactions_adddrop method=FREE_AGENT, 2022-05-17). He was FA-auctioned in July 2022 to Run CMC for $29K. **No cap penalty assessed** — this was a SF-Keeper release, not a regular drop.

### Implication for cap-penalty logic
Drop events from the SF-Keeper transition window should NOT generate drop-penalty candidates. This would require:
- Identifying the exact window (year + date range) of the SF-Keeper ceremony
- Flagging those DROPs with a special `drop_method=SF_KEEPER_RELEASE` or similar so the penalty pipeline skips them

**Action pending:** commissioner to provide the exact ceremony dates + list of affected players; until then, drop-penalty candidates from the SF transition window may need manual suppression.

**Cross-refs:** RULE-CAP-001, RULE-WORKFLOW-005

---

## Appendix A: pending ambiguities

These go into `rule_ambiguity_register.csv` as `AMB-` entries until resolved:

1. Scope of "tagged players not eligible next year" (RULE-TAG-001) — tag only? extension only? both? permanent?
2. Multi-year extension math (RULE-EXT-002) — confirm `+$10K × extension_years` is the exact formula vs some other multiplier.
3. Extension eligibility after trade (RULE-EXT-003) — does the receiving team inherit the `Ext` history, or do they have a fresh extension slot for the player?
4. Rookie drop penalty rules — not covered here yet.
5. Taxi drop rules — how do taxi-squad drops interact with cap penalties? (See `build_salary_adjustments_report.py` for current implementation.)

---

## Appendix B: Review ledger

Tracks which teams have been reviewed end-to-end and which players have been confirmed by the commissioner.

| Review Date | Team | Status | Notes |
|---|---|---|---|
| 2026-04-16 | Blake Bombers | ✓ reviewed | All drops, modified, and Brissett (TAG, mis-classified as EXTENDED in report) confirmed. Purdy Y2 salary $22K correct. Dowdle extension kicker correct. 27 players confirmed fine. |
| 2026-04-16 | C-Town Chivalry | ✓ reviewed | Pollard EXT1 correct (AAV display quirk noted). London $14K→$52K Y2 BL correct. JSN 2-year ext + restructure correct (gave us RULE-EXT-002 and RULE-CONTRACT-003). All 43 C-Town players confirmed fine. |
| 2026-04-16 | L.A. Looks (partial) | ⚠ issues found | Ferguson/Jennings $11K→$21K Y2 display correct. Confirmed via restructure_submissions.json: Chase and Walker III have NO legitimate restructure — MFL data is corrupted from trade+extension flow and needs manual correction. Gave us RULE-DATA-001 (UW = L.A. Looks) and RULE-DATA-002 (MFL corruption during trade+extension). Cross-team UW cleanup identified (5 players). |
