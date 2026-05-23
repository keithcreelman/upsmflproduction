# Roast Bot — Parking Lot (Future Improvements)

Captured 2026-05-22 from Keith's review of the v8 trade-roast (announcement + threaded roast + GIF working end-to-end). These ideas were explicitly marked as "parking lot" — out of scope for the current iteration but worth keeping warm for the next round of investment.

Sibling docs:
- [docs/roast_bot_cut_list.md](roast_bot_cut_list.md) — what we removed and why
- [docs/generic_gif_fallback_rollout.md](generic_gif_fallback_rollout.md) — cross-activity GIF rollout plan

---

## Group A — Roster + Market Context (data the LLM doesn't have today)

The roast currently has cap space + owner record + pick-band hit rates. It does NOT have *roster strength* or *market state*. Both materially change how a trade should be judged. Three related ideas:

### A1. Roster Assessment

> "Cap space doesn't matter if you're loaded and don't have anyone for auction vs. you have nobody and no cap space."

**What:** Add a `roster_quality` dimension to each side's context. A team with $33K cap space and a loaded roster ("contender, no holes") reads totally differently than one with $33K cap and a depth chart of dart-throws ("rebuilder, broke and barren").

**Why:** The roast can mock cap moves that don't fit the roster's state — e.g. a team with no QBs grabbing more picks instead of plugging holes, or a contender hoarding cap with no positions to spend on.

**Data needed:**
- Per-roster: starters identified at each position
- Starter quality classification — reuse [site/rookies/rookie_draft_tiers.json](../site/rookies/rookie_draft_tiers.json) methodology (Smash / Hit / Contributor / Bust) but applied to *career* rather than rookie window
- Position-by-position depth ("3 Smash WRs, 0 starter-quality QBs")

**Effort:** ~half-day if we lean on the existing player-scoring report at [site/reports/player_scoring/player_scoring_2025.json](../site/reports/player_scoring/player_scoring_2025.json) — it already has Elite+ rates per player. Layer aggregate roster-strength on top.

**Output to LLM:**
```json
"roster_quality": {
  "tier": "contender | balanced | thin | barren",
  "starters_smash": 3,
  "starters_hit": 5,
  "biggest_gaps": ["QB", "TE"],
  "depth_strength": "deep | average | shallow"
}
```

**Known unknowns:**
- How to handle taxi/IR slots — count as roster or exclude?
- Cutoff for "starter" — top 12 at position? Top 24 (Superflex math)?

---

### A2. Auction Class Strength

> "Value in the auction matters. A loaded class means auction = better players."

**What:** Add a `current_auction_pool_strength` field describing how good this year's FA pool is. A loaded year (lots of stud FAs) means cap saved = real player. A weak year (scraps available) means cap is worth less.

**Why:** Roasts that say "you could buy a stud at auction" need the actual market to support that claim. If the auction is thin this year, hoarding picks is smart; if it's loaded, hoarding picks is hoarding lottery tickets while studs go for cheap.

**Data needed:**
- Auction pool roster — likely already in D1 (`src_franchises` joined to roster, or one of the recent auction tables `ups_auction_*` / `era_pool`)
- Per-FA quality tier (career Elite+ rate from player_scoring)
- Aggregate counts: "5 Smash-tier FAs, 12 Hit-tier, 30+ Contributor" vs "1 Smash, 4 Hit, lots of Contributor"

**Effort:** Half-day to a day. Auction data freshness is the risk — see "Bigger items" Task #14 (daily refresh timer).

**Output to LLM:**
```json
"auction_pool_strength": {
  "label": "strong | average | weak",
  "smash_count": 5,
  "hit_count": 12,
  "top_position": "WR",
  "thin_position": "QB"
}
```

**Known unknowns:**
- Does the league use the same Smash/Hit/Contributor methodology for veterans? (rookie_draft_tiers is rookie-only — need a sibling for veterans)
- ERA-pool eligibility nuances (e.g. age cutoffs, prior-tag exclusions)

---

### A3. League-Wide Cap Liquidity

> "Available salary in auction as a league matters. Studly players but no $$ = lower values in auction."

**What:** Sum of all teams' available cap space → how much money is chasing the auction. High aggregate cap = bidding inflation; low = price suppression.

**Why:** A team hoarding cap when the league is flush means everyone's going to outbid them anyway. Same team hoarding cap when the league is tapped is sitting on a real advantage.

**Data needed:**
- Each team's current cap space — we already have this (v6 fix)
- League sum + average + leader/laggard
- Maybe a per-team "above/below league avg" indicator

**Effort:** 30 minutes — straightforward aggregation of data we already pull.

**Output to LLM:**
```json
"league_cap_liquidity": {
  "total_remaining_cap": 1850000,
  "average_per_team": 154000,
  "label": "flush | normal | tight",
  "leader": "Team X with $410K",
  "your_team_vs_avg": "-$23K (below average)"
}
```

**Known unknowns:** None really — pure aggregation. Just needs to be wired.

---

## Group B — Personality + Interactivity

### B1. Discord-Mined Owner Personalities

> "Read discord and continuously develop personalities for people and frame in the message as needed. 'Cross claimed he was going to have the best team in '26 but ended up dead last.'"

**What:** Background job reads each owner's Discord message history, extracts memorable quotes / bold predictions / catchphrases / signature behaviors → stores a per-owner personality profile → roast context surfaces relevant excerpts when a trade involves that owner.

**Why:** "Cross said he'd be best in '26 and finished last" hits dramatically harder than an abstract roast about poor records. Self-incrimination via the owner's own words is the apex roast format.

**Data needed:**
- Discord message archive per channel, per author
- Some indexing by `discord_user_id` (we have these from `discord_owners` table in D1)
- Personality summary file per owner — distilled, not raw transcript

**Tech / build pieces:**
1. **Discord history scraper** — paginate through channel messages via Discord API, filter to UPS league members, store. Needs read permission on relevant channels (the bot likely already has it).
2. **Storage** — D1 table `owner_discord_messages` or R2 jsonl per owner. Probably D1 for queryability.
3. **Personality distillation** — periodic LLM job (Sonnet) that reads recent messages from an owner and updates a "personality summary" JSON: signature phrases, recent predictions, complaints, brags, characteristic emojis. Run weekly.
4. **Context integration** — add `owner_personality_profile` field per side in the roast context. Surface relevant excerpts.

**Effort:** Multi-day. Maybe a 1-week initiative. Sub-projects:
- Day 1: Discord scraper + initial backfill of message history
- Day 2: Storage schema + indexing
- Day 3: Personality distillation (LLM prompt + caching strategy)
- Day 4: Context integration + roast prompt updates
- Day 5: Test + iterate

**Known unknowns:**
- Channel scope — do we mine ALL channels, or just trade-talk / general chat? Privacy concern if we mine DMs.
- How recent of a memory to surface — last 3 months? Last season? "All-time signature quotes" vs "what they said this offseason"?
- Cost — if we re-distill personalities weekly via Sonnet, ~$1-3/week (12 owners × ~10K tokens of history × Sonnet pricing). Acceptable.
- Hallucination risk — LLM might attribute quotes the owner never said. Mitigation: surface DIRECT QUOTES with timestamps + message IDs, not paraphrases.

**Risk note:** The roast already plays loose with attribution (called Hammer "defending champion" before we fixed drought math). Surfacing supposed Discord quotes that owners didn't say would be much worse — could become a feature people lose trust in. Strict quote-faithfulness needs to be a load-bearing prompt rule.

---

### B2. Owner Clap-Back from Thread Replies

> "Clap back from owners…will you be able to read comments from people in the thread and respond. Use sonnet or haiku whatever makes the most sense."

**What:** When owners reply to a roast in the thread we created, the bot reads the reply, classifies it, and responds in the thread with a clap-back.

**Why:** Bot becomes interactive — not just a one-shot poster. The clap-back loop is what turns the roast into a Discord event people engage with.

**Current state — mostly built already:**
- `content_engine.py` has `classify_reply()` (uses Sonnet) and `generate_clap_back()` (Sonnet since v3).
- `trade_roast_bot.py` has a `@bot.event on_message` handler that watches for replies to tracked roast messages, classifies, and calls `generate_clap_back()`. Stores tracked messages in `ROAST_TRACKER`.
- Classification has three buckets: `VALUE_SIGNAL` (real disagreement with model) → logged + canned reply, `DATA_ERROR` (factual challenge) → logged + canned reply, `COPE` (salty / no substance) → generate full clap-back.

**What's missing:**
- The production bot (launchd) needs to actually be RUNNING and capturing thread messages (it has the gateway connection but until v6/v7/v8 it was producing junk roasts due to upstream data bugs).
- Threading specifically — the bot's reply-monitoring code may need to be updated to also watch messages INSIDE threads, not just channel-level replies. Need to verify the existing event handler picks up thread messages (Discord's `on_message` event fires for thread messages too AFAIK, but worth confirming with a test reply).
- When the test_fire_ab.py script creates a thread, the production bot needs to be aware of those threads to monitor them. Currently the bot only knows about messages IT posts. We'd need to either:
  - Have the same bot do the test fire AND monitoring (one process), OR
  - Have a shared "tracked threads" store (D1 table) that any process can append to + the bot polls

**Effort:** Small to medium. The mechanics exist; this is glue work:
- Verify Discord `on_message` fires for thread messages
- Wire test_fire_ab.py to append thread_ids to a shared store
- Production bot reads the store + monitors those threads
- Cost: Sonnet for classify + clap-back, ~1-2¢ per reply round-trip

**Haiku vs Sonnet:**
- Classification (`classify_reply`): Haiku would be fine — short, structured output. Already Sonnet though, ~negligible cost diff.
- Clap-back generation (`generate_clap_back`): Sonnet recommended. Haiku might lose the savage voice. Could A/B test.

**Known unknowns:**
- Threading + DM vs channel — does the bot get pinged when someone replies inside a thread? Need a confirming test.
- Rate limiting — if 5 owners reply in 30 seconds, do we clap back to all 5 or batch? Probably individual responses (parallel calls).
- Conversation depth — if owner replies to the clap-back, does the bot clap back to the clap-back? Risk of infinite loops. Cap to one round per (roast, owner) pair?

---

## Sequencing recommendation

If all five get green-lit eventually, recommended order:

1. **A3 (League cap liquidity)** — cheapest win, ~30 min, immediately enriches roast context.
2. **A1 (Roster assessment)** — half-day, big roast quality lift, depends on the existing player_scoring data being maintained.
3. **B2 (Clap-back)** — small glue work to wire the existing mechanism into the thread workflow. Real-time interactive bot once live.
4. **A2 (Auction class strength)** — half-day to a day, depends on auction-pool data freshness (Task #14 daily refresh helps here).
5. **B1 (Discord personality mining)** — biggest investment, biggest payoff for roast quality. Multi-day. Save for last.

---

*Last updated: 2026-05-22 — captured as parking-lot during v8 review. Nothing here is implemented yet; the current bot has none of these features wired.*
