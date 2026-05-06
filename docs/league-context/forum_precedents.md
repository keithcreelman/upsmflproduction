# UPS Forum Precedents Log

Year-by-year log of league one-offs from MFL forum / commissioner messages
that **set precedent** but may not be in the rulebook. Sourced from
`services/rulebook/sources/rules/mfl_message_boards/manual/{year}_messageboard.txt`
(for 2010-2011 manually transcribed) and `raw/{year}.json` (for 2012+ MFL API).

Format:
- **Date** (or month if specific date unknown)
- **Topic** — short tag
- **Decision/Event** — what happened
- **Citation** — source file + line ref
- **Lasting impact** — how this shaped later rules

---

## 2010 — League founding (Year 1, redraft)

(Pre-dynasty era. Specific precedents to be extracted from
`manual/2010_messageboard.txt`.)

---

## 2011 — Inaugural Dynasty Year

### Aug 14, 2011 — Auction-error restoration precedent
**Event:** Owners accidentally bid on ineligible players (Zoltan Mesko punter,
Dominique Foxworth, Jon Beason). Commissioner couldn't reverse mid-auction
without compromising integrity (would expose other teams' bid intel).
Decision: **let auction conclude, then return players to player pool**.
**Citation:** `manual/2011_messageboard.txt` lines 13-32, 256-265.
**Precedent:** Auction errors are repaired post-close, not in real-time.

### Aug 14-29, 2011 — The Fat Cat (Jacques) cap overage — NOT enforced
**Event:** Jacques (The Fat Cat) went over the salary cap during the inaugural
FA auction. Commissioner Keith + Jeff + Mannila granted a free pass with the
de facto consequence: he could only fill remaining roster slots at $1K each.
**Citation:** `manual/2011_messageboard.txt` lines 343, 728, 1327.
**Quote:** "the fact that The Fat Cat was punished enough with not having $$
to go out and draft any players more than $1000 and because it was not put
into the rules ahead of time we are not going to enforce any penalties for
him not making the minimum amount of players for this draft."
**Precedent:** Future cap-overage rules WERE codified after this. The
"unwarranted gift" framing in line 343 ("got a free pass (which in hindsight
was an absolutely unwarranted gift)") flags it as a one-time mercy.

### Sept 6, 2011 — 6-player cap on 3-year deals — enforced
**Event:** White Power tried to sign 7 players to 3-year deals.
Commissioner rejected the post: **"6 PLAYERS IS THE MOST YOU MAY SIGN
TO 3 YEAR DEALS."** Teams not posting contracts before midnight had all
players assigned to 1-yr deals.
**Citation:** `manual/2011_messageboard.txt` lines 3-12.
**Precedent:** Enforced cap on 3-yr contract count (later forum debate
2013-06-09 reaffirmed at 6× 3-yr per team excluding rookies — see
`league_history_chronicle.md` 2013).

### Sept 26 - Oct 2011 — Manning IR cap-relief debate — NO RELIEF granted
**Event:** Peyton Manning out for the season but Indianapolis didn't put him
on IR (left him questionable). The Fat Cat (his owner) was held cap-hostage
at $39K for a player who would never play. League debated 25%/50% relief
schemes. Final decision: NO cap relief granted; "no precedent for auction-day
knowledge of injury → retroactive relief".
**Citation:** `manual/2011_messageboard.txt` lines 354-380.
**Precedent:** Pre-existing injuries known at auction time DO NOT trigger
later cap relief. Owner bears the risk. (Formal IR rules later refined to
require actual NFL IR designation for cap relief.)

### Sept-Nov 2011 — Trade-pickup extension mechanic — clarified
**Event:** Commissioner described the extension window: "any player that you
acquire (via trade or waiver wire) with only 1 year on contract can be
extended within the 1st 2 weeks of acquisition."
**Citation:** `manual/2011_messageboard.txt` lines 243-245.
**Validated by data:** Darren Sproles (BBID pickup by Blake Bombers $5K
Sep 14 → traded to WTDD straight up for Eli Manning Nov 11 → extended to
2yr × $15K with the +$10K bump).
**Precedent:** Trade-acquisition extension rule formalized. Mechanism still
referenced in 2026 rulebook.

### Nov 6, 2011 — Mid-season cap-hit transparency post (template)
**Event:** Commissioner published a per-team running tally of cap-hit-eligible
cuts. Set the cadence of: mid-season check-in → final tally at season end.
**Citation:** `manual/2011_messageboard.txt` lines 109-159.

### Nov 23, 2011 — Trade-deadline reminder + offseason process preview
**Event:** Commissioner laid out the timing for rule-change votes:
- Week 14-15: Owners voice concerns / propose tweaks
- Week 16-17: Commissioner-curated proposals up for league-wide vote
**Citation:** `manual/2011_messageboard.txt` line 249.
**Precedent:** Annual rule-change voting cadence (now Aug-Sep typically).

### Jan 8, 2012 — Final cap-penalty post (canonical end-of-season)
**Event:** Commissioner published the canonical 2011 cap-penalty list per
team. **9 teams with cap hits, 3 teams ($0)**. Total league cap hits: $44.8K.
Plus playoff-period FA pickups force-removed from rosters (those don't count
against cap but per rules can't stay).
**Citation:** `manual/2011_messageboard.txt` lines 297-326.
**Loaded into D1:** `mfl_cap_penalty_event` (12 events) + `mfl_cap_penalty_player` (24 itemized cuts).
**Precedent:** Established the 20% cap-hit rate (vs 15% / 10% alternatives
debated in same forum thread). The 20% rate stuck for offseason cuts.

### Jan-Feb 2012 — Off-season cap-penalty rate poll (15% vs 20%)
**Event:** Forum poll closed Feb 1. Final decision: **20% offseason cap
penalty (same as in-season)**. Closed earlier debates about a lower
offseason rate (10% / 15% rejected).
**Citation:** `manual/2011_messageboard.txt` line 293-295.
**Precedent:** Symmetric in-season vs offseason cap-penalty rate. Held
through 2025+.

### 2011-12 offseason — 4-owner dispersal (between 2011 and 2012)
**Event:** 4 franchises did NOT process post-Week-16 LOAD_ROSTERS cleanup,
indicating they exited the league. **Identified by data signature**:
`f0003 The Fat Cat`, `f0006 Murray's Madmen`, `f0007 R-11`, `f0012 White Power`.
Their rosters (with all contracts) entered a 2012 dispersal pool.
Notable assets in dispersal:
- Jamaal Charles (R-11, $59K, on IR — torn ACL Wk2)
- Andre Johnson (White Power, $55K, CY2)
- Frank Gore (White Power, $45K, CY1)
- Brandon Marshall (White Power, $30K, CY2)
- Manning (Fat Cat, $39K, CY1)
- Dez Bryant (Fat Cat, $34K, CY2)
- Calvin Johnson (Murray's, $50K, CY1)
- Michael Turner (Murray's, $49K, CY2)

**Lasting impact:** The 2012 dispersal mechanic + 4 replacement owners brought
in for 2012 — sets up the heavy 2012 trade volume (380 trade-asset rows vs
62 in 2011 per `src_trades`).

---

## Patterns / themes from 2011

1. **Commissioner discretion was high in Year 1.** The Fat Cat overage,
   the auction-error restoration, the Manning IR debate — all resolved
   informally. Subsequent years codified more.
2. **Forum was the single source of truth for contract-related decisions.**
   No spreadsheet system yet; commissioner posted final tallies.
3. **Cap-hit rate of 20% was set after debate.** Alternatives (10%, 15%)
   considered and rejected.
4. **Trade-pickup extension was already in play in Year 1** — the Sproles
   case validates this rule was active and used.
5. **The dispersal-team signature** (no post-W16 LOAD_ROSTERS) is detectable
   in the data — useful for future years to identify exits without manual
   tracking.

---

## TODO — extract precedents from later years

- 2012-2016: parse from `raw/{year}.json` (MFL API has these)
- 2017-2025: combine MFL forum + Slack export
   (`~/Downloads/UPS Salary Cap Dynasty Football League Slack export May 18 2016 - Jan 2 2025`)

When extracting, prioritize:
- Rule changes (carry into rulebook)
- One-time exceptions / commissioner discretion
- Disputes and how they were resolved
- Annual format/scoring tweaks

Each year's precedents ground future rule interpretations.
