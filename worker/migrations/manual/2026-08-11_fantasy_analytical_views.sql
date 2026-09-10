-- 2026-08-11_fantasy_analytical_views.sql
-- Read-only convenience + analytical views over the fantasy_* model (0127-0132).
--
--   npx wrangler@4 d1 execute ups-mfl-db --local  --file=worker/migrations/manual/2026-08-11_fantasy_analytical_views.sql
--   npx wrangler@4 d1 execute ups-mfl-db --remote --file=worker/migrations/manual/2026-08-11_fantasy_analytical_views.sql
--
-- ⚠️ NEVER `wrangler d1 migrations apply` — the tracker is ~47 entries behind
--    reality (0057-0103 report pending but ARE applied) and running it corrupts
--    contract data. Hand-apply with `d1 execute --file`, exactly as above.
--
-- ⚠️ WHY THIS IS IN manual/ AND NOT A NUMBERED MIGRATION.
-- There are ZERO CREATE VIEW statements in all 132 prior migrations. Views are
-- simply not part of this repo's migration convention: the numbered files carry
-- tables, indexes, and one-way data repairs, and the migration tracker is
-- already untrustworthy enough that adding a new statement CLASS to it is a bad
-- trade. manual/ is the established home for hand-applied SQL (YYYY-MM-DD_slug),
-- it is applied deliberately by a human who has read the file, and a view that
-- is dropped and recreated does not need a tracker entry to stay correct.
-- Nothing here creates, alters, or writes a single row of any table.
--
-- WHY THESE VIEWS EXIST AT ALL.
-- 0127-0132 land the tables. Every consumer after them — the Worker's API
-- routes, a notebook, a one-off SQL question — otherwise has to re-derive the
-- same four things by hand, and history says one of them will get it wrong:
--   1. Which points number to use when the provider's and ours disagree.
--   2. That starter status is a DERIVED flag, not a string compare on the slot.
--   3. That platform + league_key + season all have to be in the predicate.
--   4. That NULL is not zero.
-- That failure mode is not hypothetical in this repo. The War Room cap-space
-- panel was wrong for all 12 teams because ONE surface re-derived cap usage and
-- forgot the `+ salaryAdjustments` half of the formula (PR #814, 2026-08). The
-- fix was a single shared derivation. These views are that shared derivation for
-- the fantasy_* family: the join and the null-handling live in ONE place, and
-- the caveats live in a comment attached to the thing that has them.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- THE FIVE RULES EVERY VIEW IN THIS FILE OBEYS
--
-- (1) PLATFORM + LEAGUE_KEY + SEASON, ALWAYS.
--     Every join predicate carries all three where the joined table has them,
--     and all three are the FIRST projected columns of every view. A view that
--     silently aggregates two platforms or two leagues into one number is a bug,
--     not a feature. A view cannot force a WHERE clause onto its caller — what
--     it can do is put league_key and season in front of them so the omission is
--     visible. The yahoo_* views additionally pin `platform = 'yahoo'`; the
--     fantasy_v_* views GROUP BY platform so they stay correct the day
--     platform='cbs' rows land, with no rewrite.
--
--     The one join that is deliberately identity-only is to fantasy_players
--     (PK: platform, player_uid). That table is the player UNIVERSE and has no
--     league or season by design — it resolves a name, never a fact about a
--     league-season. Anything league-relative comes from a league-scoped table.
--
-- (2) POINTS COME FROM THIS LEAGUE'S OWN SCORING, AND ARE NEVER RECOMPUTED HERE.
--     fantasy_player_week_points already holds both numbers: points_provider
--     (what the platform reported) and points_recomputed (what THIS league's
--     fantasy_scoring_rules produce from the captured stat lines). Views read
--     those columns. They do NOT re-derive scoring from fantasy_player_week_stats
--     — a second scoring implementation is a second thing to get wrong — and
--     they contain no scoring constant of any kind.
--
--     ⚠️ NOT ONE NUMBER IN THIS FILE COMES FROM UPS SCORING. The MFL league's
--     PPR-by-position rules (TE 1.5 / WR 1.0 / RB 0.8, first-down 0.2, sack-yard
--     -0.1) are a different league on a different platform. No view here reads
--     any ups_* / src_* / mfl_* / nfl_* table. Grep this file for those prefixes:
--     there are none outside this comment.
--
--     THE PREFERENCE ORDER, defined once and used identically everywhere:
--         points_effective = COALESCE(points_provider, points_recomputed)
--     This is a preference between two STATED values, not a NULL→0 coercion.
--     When both are NULL the result stays NULL and the week contributes nothing
--     to any SUM — which is why every aggregate view also emits a count of the
--     rows whose points were unknown. A total built on silence is reported as a
--     total plus the size of the silence.
--
--     Views that project a points figure also project points_source ('provider'
--     | 'recomputed' | NULL) so a mixed-source total is detectable rather than
--     assumed away.
--
-- (3) STARTER STATUS COMES FROM is_starter. NEVER FROM A SLOT STRING.
--     fantasy_roster_snapshots.is_starter is derived at ingest from THIS league's
--     own fantasy_roster_positions slot list. There is no `selected_position IN
--     ('BN','IR')` anywhere in this file, because leagues define IR+, IR-R and NA
--     and a hardcoded pair would silently promote those players to starters.
--
--     is_starter is NULLABLE and NULL means "this league's slot definitions were
--     not available when the roster was ingested" — it does NOT mean bench.
--     Every count in this file is therefore three-way: is_starter = 1, = 0, and
--     IS NULL each get their own column. Folding the third into the second is
--     exactly the fail-open the repo's NO-FAIL-OPEN rule forbids.
--
--     yahoo_weekly_rosters additionally joins fantasy_roster_positions and
--     projects starter_flag_disagrees_with_slot, so a stale derivation is
--     visible as data rather than found six months later.
--
-- (4) NULL SURVIVES. Most sharply for auction_cost.
--     A $0 keeper and an unpriced pick are DIFFERENT FACTS (0130, rule 1). There
--     is no COALESCE on auction_cost anywhere in this file. SUM(auction_cost)
--     over a set where every price is NULL returns NULL, not 0 — that is the
--     correct answer to "what did they spend" when nobody said. Alongside every
--     such SUM, the view emits picks_with_price and picks_without_price so a NULL
--     total is diagnosable in the same row.
--
--     Ratios are guarded the same way: points_per_dollar is NULL when the price
--     is NULL (unknown) AND when the price is 0 (a free keeper has undefined
--     points-per-dollar, which is not the same as zero value). The same holds for
--     faab_bid, where 0 is a legal winning bid and NULL means "not exposed".
--
-- (5) INFERRED VALUES CARRY THEIR FLAG THROUGH.
--     Weekly standings are RECONSTRUCTED — the provider serves exactly one
--     standings state per league and has no standings;week=N (0131). Anything
--     downstream of fantasy_standings_snapshots therefore projects is_inferred
--     and inference_basis, never the rank alone. Same for
--     fantasy_team_week_scores.is_derived and
--     fantasy_roster_snapshots.is_derived_acquisition.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHAT THIS FILE DELIBERATELY DOES NOT DO
--
--   * No materialization. These are views, not tables. They are recomputed on
--     every read. This league is 12 teams x ~17 weeks x ~15 seasons; the row
--     counts are thousands, not millions, and every correlated subquery below
--     lands on an index created in 0127-0132. If a view ever becomes hot enough
--     to need caching, cache it in the Worker — do not snapshot it into a table
--     and create a second version of the truth.
--
--   * No optimal-lineup solver. "Best legal lineup under this league's slots" is
--     a bin-packing problem over per-player slot eligibility and it does not
--     belong in a view. fantasy_v_bench_points SURFACES the ingester's
--     points_optimal and refuses to invent one when it is NULL. A NULL optimal
--     means the ingester could not compute it, and the efficiency ratio is
--     correctly NULL rather than 1.0.
--
--   * No cross-platform and no cross-league totals. There is no "career" view
--     here spanning leagues, because manager identity across leagues is a
--     separate claim (fantasy_managers.manager_uid) that deserves its own
--     deliberate treatment rather than an accidental GROUP BY.
--
--   * No writes, no triggers, no DROP. Nothing in this file can lose data.
--
--   * No re-scoring from raw stat lines. See rule 2.
--
-- ⚠️ RE-RUNNING THIS FILE IS A NO-OP, WHICH IS ALSO THE GOTCHA.
-- Every statement is CREATE VIEW IF NOT EXISTS, so applying it twice changes
-- nothing and errors nothing. But IF NOT EXISTS also means EDITING A VIEW BODY
-- HERE AND RE-APPLYING DOES NOTHING — SQLite keeps the old definition. To change
-- a view you must `DROP VIEW <name>` first, then re-apply this file. That is
-- stated here rather than automated with an unconditional DROP, because a DROP
-- at the top of a hand-applied file is a footgun the first time somebody runs it
-- against production while a route is mid-query.
--
-- VERIFIED 2026-08-11, in three passes, all local (--local, never --remote):
--   1. Applied to the working local D1. 11 views created.
--   2. Applied to a PRISTINE database built from 0127-0131 in an isolated
--      --persist-to dir, to prove a clean-slate apply lands all 11 in one shot
--      rather than depending on an earlier partial run. All 11 created; each
--      returned cleanly from `SELECT * FROM <view> LIMIT 1` with 0 rows. 0 rows
--      on an empty database is the correct result; a SQL error would not be.
--   3. Loaded a throwaway fixture into a scratch SQLite copy of the same schema,
--      because an empty database never exercises a join or a NULL guard. The
--      fixture deliberately included: auction_cost of 25.0, 0.0 and NULL on
--      three picks; faab_bid of NULL and 0; is_starter of 1, 0 and NULL (via a
--      slot with no definition in the league's own slot table); points that were
--      provider-only, recomputed-only, and both-NULL; a transaction parent with
--      zero legs; a team-week with points_optimal NULL; a team-week with NULL
--      points; a trade carrying one player and one draft pick; a SECOND LEAGUE;
--      and a platform='cbs' row reusing the SAME league_key, season and team_key
--      as a yahoo row.
--
--      Confirmed on that fixture: no yahoo_* view returned a single non-yahoo
--      row despite the colliding keys; the cbs row stayed its own row in
--      fantasy_v_draft_value rather than merging; 25.0 / 0.0 / NULL stayed three
--      distinct facts with points_per_dollar NULL for both the free keeper and
--      the unpriced pick; the undefined slot read 'unknown' and NOT 'bench', and
--      its points landed in unknown_starter_state_points rather than in the
--      bench total; points_optimal NULL yielded NULL efficiency rather than a
--      fabricated 1.0, and points_optimal = 0 yielded NULL rather than a
--      division error; the legless parent survived with orphan_parent_no_legs=1;
--      the traded draft pick reported NULL production rather than 0; the
--      other-league team reported final_standings_missing=1 with every standings
--      column NULL rather than inheriting the neighbouring league's; and the
--      week with an unknown score produced a 0-0-0 all-play record with a
--      non-zero skip count and a NULL win pct — "we could not tell", not "they
--      lost to everyone".


-- ═════════════════════════════════════════════════════════════════════════════
-- PART 1 — YAHOO CONVENIENCE VIEWS
--
-- Platform-pinned flattenings of the normalized model. These answer "show me the
-- thing" rather than "compute the metric": they do the joins and the null
-- handling, and add no arithmetic beyond the points preference order.
-- ═════════════════════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────────────────────
-- yahoo_draft_results
--
-- QUESTION IT ANSWERS: "show me a draft" — every pick of every Yahoo
-- league-season, with the player and team resolved to names, and the auction
-- price intact.
--
-- CAVEATS:
--   * auction_cost is projected RAW. NULL = the provider did not state a price;
--     0 = it stated zero (a free keeper). Read draft_kind / is_price_bearing
--     FIRST: in a snake draft the column is meaningless rather than empty.
--   * The player and team joins are LEFT, on purpose. 0130 calls a pick whose
--     player is missing from fantasy_players a DATA-QUALITY FAILURE — an INNER
--     JOIN would delete the evidence of exactly that failure. player_row_missing
--     and team_row_missing surface it instead, and player_unresolved separates
--     "the pick has no player_uid at all" from "it has one we never ingested".
--   * player_position_at_draft is the position AS OF the draft where it was
--     reconstructable and NULL where it was not. player_position_latest is
--     today's position and is NOT a substitute — a 2016 pick's current position
--     tells you nothing about that draft. Both are projected; neither is folded
--     into the other here.
--   * is_keeper is the PROVIDER's flag and is usually NULL, which is honest:
--     Yahoo has no per-pick keeper attribute. keeper_inferred is OUR inference
--     and lives in its own column with its basis. Never read one as the other.
CREATE VIEW IF NOT EXISTS yahoo_draft_results AS
SELECT
  de.platform,
  de.league_key,
  de.season,
  de.pick_number,
  de.round_number,
  de.pick_in_round,
  de.team_key,
  t.team_name,
  de.player_uid,
  de.player_key_at_draft,
  de.provider_player_id,
  p.full_name                                            AS player_name,
  de.player_position_at_draft,
  p.display_position                                     AS player_position_latest,
  de.nfl_team_at_draft,
  de.auction_cost,                                        -- ⚠️ NULL stays NULL. Never coalesced.
  d.draft_kind,
  d.is_price_bearing,
  d.draft_status,
  d.num_rounds                                           AS draft_num_rounds,
  d.num_picks                                            AS draft_num_picks_observed,
  de.is_keeper,                                           -- provider-stated only
  de.keeper_inferred,                                     -- OUR inference; read with the basis
  de.keeper_inference_basis,
  de.is_auto_pick,
  de.picked_at_unix,
  CASE WHEN de.player_uid IS NULL THEN 1 ELSE 0 END      AS player_unresolved,
  CASE WHEN de.player_uid IS NOT NULL AND p.player_uid IS NULL THEN 1 ELSE 0 END
                                                         AS player_row_missing,
  CASE WHEN de.team_key IS NOT NULL AND t.team_key IS NULL THEN 1 ELSE 0 END
                                                         AS team_row_missing,
  de.source_run_id
FROM fantasy_draft_events de
LEFT JOIN fantasy_drafts d
       ON d.platform   = de.platform
      AND d.league_key = de.league_key
      AND d.season     = de.season
LEFT JOIN fantasy_teams t
       ON t.platform   = de.platform
      AND t.team_key   = de.team_key
      AND t.league_key = de.league_key
      AND t.season     = de.season
LEFT JOIN fantasy_players p
       ON p.platform   = de.platform
      AND p.player_uid = de.player_uid
WHERE de.platform = 'yahoo';


-- ─────────────────────────────────────────────────────────────────────────────
-- yahoo_transactions
--
-- QUESTION IT ANSWERS: "what moved, when, and between whom" — the transaction
-- log flattened to ONE ROW PER ASSET LEG, with both counterparties resolved.
--
-- GRAIN: one row per (transaction_key, leg_index). A three-player trade is six
-- rows; an add/drop is two. Counting rows in this view is counting LEGS, not
-- transactions — COUNT(DISTINCT transaction_key) is the transaction count.
--
-- CAVEATS:
--   * The parent→leg join is LEFT. A parent with no legs still appears, with a
--     NULL leg_index and orphan_parent_no_legs = 1. That is the orphan-detection
--     signal 0130 asks for; an INNER JOIN would hide the corruption it exists to
--     find. legs_observed (a direct count off the child table) can be compared
--     against the parent's own asset_count for the same reason.
--   * source_team_name_at_txn is what the provider called the team THAT DAY;
--     source_team_name_current is what fantasy_teams calls it now. Teams get
--     renamed mid-season and both facts are real, so both are projected and
--     neither overwrites the other.
--   * faab_bid lives on the PARENT and is repeated on every leg of that
--     transaction. SUMming faab_bid across this view double-counts any
--     multi-leg transaction. Sum it per DISTINCT transaction_key, or use
--     fantasy_v_waiver_value which restricts to acquisition legs and counts the
--     ambiguity explicitly.
--   * faab_bid NULL = the provider did not expose the bid. 0 = a real zero bid,
--     which is legal. transaction_type and status are VERBATIM provider
--     vocabulary and are not normalized here — filter on what you observe, not
--     on what you assume the vocabulary is.
--   * ⚠️ WHAT IS STRUCTURALLY ABSENT: losing waiver claims. Once waivers
--     process, Yahoo discards competing claims, so this log shows an uncontested
--     market that was not uncontested. That is recorded as not_exposed in
--     fantasy_data_completeness and is not something this view can repair.
--   * The leg join also matches league_key and season. If a leg's league/season
--     ever disagreed with its parent's, the leg would vanish and
--     orphan_parent_no_legs would fire — a loud wrong answer instead of a quiet
--     one.
CREATE VIEW IF NOT EXISTS yahoo_transactions AS
SELECT
  tx.platform,
  tx.league_key,
  tx.season,
  tx.transaction_key,
  tx.transaction_id,
  tx.transaction_type,                                    -- VERBATIM
  tx.status,                                              -- VERBATIM
  tx.timestamp_unix,
  tx.processed_date,
  tx.week,                                                -- derived; NULL when underivable
  tx.faab_bid,                                            -- ⚠️ parent-level. NULL = not exposed, 0 = real zero
  tx.waiver_priority_at_processing,
  tx.is_commissioner_action,
  tx.trade_note,
  tx.asset_count                                         AS asset_count_claimed,
  (SELECT COUNT(*)
     FROM fantasy_transaction_assets x
    WHERE x.platform        = tx.platform
      AND x.transaction_key = tx.transaction_key)        AS legs_observed,
  a.leg_index,
  a.asset_kind,
  a.movement_type,
  a.player_uid,
  a.player_key_at_txn,
  a.player_name_at_txn,
  pl.full_name                                           AS player_name_latest,
  a.player_position_at_txn,
  a.nfl_team_at_txn,
  a.source_type,
  a.source_team_key,
  a.source_team_name                                     AS source_team_name_at_txn,
  st.team_name                                           AS source_team_name_current,
  a.destination_type,
  a.destination_team_key,
  a.destination_team_name                                AS destination_team_name_at_txn,
  dt.team_name                                           AS destination_team_name_current,
  a.pick_season,
  a.pick_round,
  a.faab_amount,                                          -- faab-as-a-traded-asset, not the bid
  CASE WHEN a.leg_index IS NULL THEN 1 ELSE 0 END        AS orphan_parent_no_legs,
  tx.source_run_id
FROM fantasy_transactions tx
LEFT JOIN fantasy_transaction_assets a
       ON a.platform        = tx.platform
      AND a.transaction_key = tx.transaction_key
      AND a.league_key      = tx.league_key
      AND a.season          = tx.season
LEFT JOIN fantasy_teams st
       ON st.platform   = tx.platform
      AND st.team_key   = a.source_team_key
      AND st.league_key = tx.league_key
      AND st.season     = tx.season
LEFT JOIN fantasy_teams dt
       ON dt.platform   = tx.platform
      AND dt.team_key   = a.destination_team_key
      AND dt.league_key = tx.league_key
      AND dt.season     = tx.season
LEFT JOIN fantasy_players pl
       ON pl.platform   = tx.platform
      AND pl.player_uid = a.player_uid
WHERE tx.platform = 'yahoo';


-- ─────────────────────────────────────────────────────────────────────────────
-- yahoo_weekly_rosters
--
-- QUESTION IT ANSWERS: "who was on this roster in week N, in which slot, and
-- what did they score" — the single most valuable read in the whole family,
-- because none of it is recoverable after the fact (0131).
--
-- GRAIN: one row per (league, season, week, team, player).
--
-- CAVEATS:
--   * starter_state is derived ONLY from rs.is_starter, which was itself derived
--     at ingest from this league's fantasy_roster_positions. There is no string
--     comparison against 'BN' or 'IR' here or anywhere in this file.
--     is_starter IS NULL yields starter_state = 'unknown', NOT 'bench' — NULL
--     means the slot definitions were unavailable at ingest, and calling that
--     bench would quietly invent a lineup decision the manager never made.
--   * slot_definition_missing = 1 means this week's selected_position has no
--     matching row in fantasy_roster_positions for this league-season. That is
--     the condition under which is_starter goes NULL, and it is projected so the
--     cause is visible next to the effect.
--   * starter_flag_disagrees_with_slot = 1 means the stored is_starter and the
--     league's own slot definition contradict each other — a stale derivation
--     after a mid-season settings change, or a re-parse that never re-ran. It is
--     0 when either side is NULL, because unknown is not disagreement.
--   * points are joined per rule 2 and may be NULL for a player who was rostered
--     but never scored a captured line. NULL is not 0 here: a bench player with
--     no points row and a bench player who scored 0.0 are different facts.
--   * acquisition_type / acquisition_date are DERIVED from the transaction log
--     where derivable. is_derived_acquisition says which rows those are. They
--     are not provider fields.
CREATE VIEW IF NOT EXISTS yahoo_weekly_rosters AS
SELECT
  rs.platform,
  rs.league_key,
  rs.season,
  rs.week,
  rs.team_key,
  t.team_name,
  rs.player_uid,
  p.full_name                                            AS player_name,
  rs.player_position,
  rs.nfl_team_abbr,
  rs.eligible_positions,
  rs.injury_status,
  rs.selected_position,                                   -- VERBATIM slot label
  rs.is_starter,                                          -- DERIVED at ingest; NULL = slots unknown
  rs.is_bench,
  rs.is_injury_slot,
  rs.is_flex_slot,
  CASE WHEN rs.is_starter = 1 THEN 'starter'
       WHEN rs.is_starter = 0 THEN 'bench'
       ELSE 'unknown'
  END                                                    AS starter_state,
  rp.is_starting_slot                                    AS slot_is_starting_slot,
  rp.is_bench_slot                                       AS slot_is_bench_slot,
  rp.is_injury_slot                                      AS slot_is_injury_slot,
  rp.is_flex_slot                                        AS slot_is_flex_slot,
  rp.flex_positions                                      AS slot_flex_positions,
  CASE WHEN rs.selected_position IS NOT NULL AND rp.position IS NULL THEN 1 ELSE 0 END
                                                         AS slot_definition_missing,
  CASE WHEN rs.is_starter IS NOT NULL
             AND rp.is_starting_slot IS NOT NULL
             AND rs.is_starter <> rp.is_starting_slot
       THEN 1 ELSE 0
  END                                                    AS starter_flag_disagrees_with_slot,
  rs.acquisition_type,
  rs.acquisition_date,
  rs.is_derived_acquisition,                              -- 1 = WE derived it from the txn log
  rs.game_started_before_lock,
  rs.is_editable_at_capture,
  rs.roster_observed_at_utc,
  pw.points_provider,
  pw.points_recomputed,
  COALESCE(pw.points_provider, pw.points_recomputed)     AS points_effective,
  CASE WHEN pw.points_provider   IS NOT NULL THEN 'provider'
       WHEN pw.points_recomputed IS NOT NULL THEN 'recomputed'
       ELSE NULL
  END                                                    AS points_source,
  pw.points_reconciled,
  pw.reconcile_delta,
  pw.projected_points,
  rs.source_run_id
FROM fantasy_roster_snapshots rs
LEFT JOIN fantasy_teams t
       ON t.platform   = rs.platform
      AND t.team_key   = rs.team_key
      AND t.league_key = rs.league_key
      AND t.season     = rs.season
LEFT JOIN fantasy_players p
       ON p.platform   = rs.platform
      AND p.player_uid = rs.player_uid
LEFT JOIN fantasy_roster_positions rp
       ON rp.platform   = rs.platform
      AND rp.league_key = rs.league_key
      AND rp.season     = rs.season
      AND rp.position   = rs.selected_position
LEFT JOIN fantasy_player_week_points pw
       ON pw.platform   = rs.platform
      AND pw.league_key = rs.league_key
      AND pw.season     = rs.season
      AND pw.week       = rs.week
      AND pw.player_uid = rs.player_uid
WHERE rs.platform = 'yahoo';


-- ─────────────────────────────────────────────────────────────────────────────
-- yahoo_player_week_points
--
-- QUESTION IT ANSWERS: "what did this player score in this league in week N, and
-- do we BELIEVE it" — points with the reconciliation verdict attached.
--
-- WHY THE VERDICT MATTERS MORE THAN THE POINTS. points_provider is what Yahoo
-- said. points_recomputed is what this league's fantasy_scoring_rules produce
-- from the captured stat lines. When they disagree, either the scoring table was
-- parsed wrong or the stat capture is incomplete — and every downstream metric
-- built on those points inherits the error silently. reconciliation_verdict
-- makes it a column you have to look at.
--
--   'agree'       points_reconciled = 1, within tolerance
--   'disagree'    points_reconciled = 0 — DO NOT trust derived metrics for
--                 these rows until the cause is found
--   'not_checked' points_reconciled IS NULL — no verdict was ever recorded. This
--                 is NOT a pass. It usually means one side was missing.
--
-- SUPPORTING EVIDENCE, projected so a verdict is explicable in the same row:
--   league_scoring_rules_loaded  — rows in fantasy_scoring_rules for THIS
--                                  league-season. 0 means recomputation was
--                                  impossible, so points_recomputed is
--                                  necessarily NULL and 'not_checked' is
--                                  expected rather than suspicious.
--   stat_lines_captured          — rows in fantasy_player_week_stats for this
--                                  player-week. 0 with a non-NULL
--                                  points_provider means we have the answer but
--                                  not the working.
--
-- CAVEATS:
--   * projected_points is NULL for every backfilled week and that is correct,
--     not missing — historical projections are not retrievable (0131).
--   * The roster join is LEFT and resolves who rostered the player that week. In
--     a sane league that is at most one team, and the table's PK permits two only
--     if the data is corrupt — in which case this view FANS OUT to two rows for
--     that player-week. That fan-out is the corruption signal, deliberately not
--     suppressed with a LIMIT that would hide it.
--   * A player with points but no roster row was a free agent that week. That is
--     a real and useful state, which is why the join is LEFT.
CREATE VIEW IF NOT EXISTS yahoo_player_week_points AS
SELECT
  pw.platform,
  pw.league_key,
  pw.season,
  pw.week,
  pw.player_uid,
  p.full_name                                            AS player_name,
  p.display_position,
  p.position_type,
  p.editorial_team_abbr,
  pw.points_provider,
  pw.points_recomputed,
  COALESCE(pw.points_provider, pw.points_recomputed)     AS points_effective,
  CASE WHEN pw.points_provider   IS NOT NULL THEN 'provider'
       WHEN pw.points_recomputed IS NOT NULL THEN 'recomputed'
       ELSE NULL
  END                                                    AS points_source,
  pw.points_reconciled,
  pw.reconcile_delta,
  CASE pw.points_reconciled
       WHEN 1 THEN 'agree'
       WHEN 0 THEN 'disagree'
       ELSE 'not_checked'
  END                                                    AS reconciliation_verdict,
  pw.projected_points,
  (SELECT COUNT(*)
     FROM fantasy_scoring_rules sr
    WHERE sr.platform   = pw.platform
      AND sr.league_key = pw.league_key
      AND sr.season     = pw.season)                     AS league_scoring_rules_loaded,
  (SELECT COUNT(*)
     FROM fantasy_player_week_stats ws
    WHERE ws.platform   = pw.platform
      AND ws.league_key = pw.league_key
      AND ws.season     = pw.season
      AND ws.week       = pw.week
      AND ws.player_uid = pw.player_uid)                 AS stat_lines_captured,
  rs.team_key                                            AS rostered_by_team_key,
  rt.team_name                                           AS rostered_by_team_name,
  rs.selected_position,
  rs.is_starter,
  CASE WHEN rs.is_starter = 1 THEN 'starter'
       WHEN rs.is_starter = 0 THEN 'bench'
       WHEN rs.team_key IS NULL THEN 'not_rostered'
       ELSE 'unknown'
  END                                                    AS starter_state,
  pw.updated_at_utc
FROM fantasy_player_week_points pw
LEFT JOIN fantasy_players p
       ON p.platform   = pw.platform
      AND p.player_uid = pw.player_uid
LEFT JOIN fantasy_roster_snapshots rs
       ON rs.platform   = pw.platform
      AND rs.league_key = pw.league_key
      AND rs.season     = pw.season
      AND rs.week       = pw.week
      AND rs.player_uid = pw.player_uid
LEFT JOIN fantasy_teams rt
       ON rt.platform   = pw.platform
      AND rt.team_key   = rs.team_key
      AND rt.league_key = pw.league_key
      AND rt.season     = pw.season
WHERE pw.platform = 'yahoo';


-- ─────────────────────────────────────────────────────────────────────────────
-- yahoo_team_seasons
--
-- QUESTION IT ANSWERS: "one row per team per season" — final placement, record,
-- points for/against, draft grade, and activity counts. The league-history read.
--
-- ⚠️ THE STANDINGS HALF OF THIS VIEW MAY BE INFERRED, AND SAYS SO.
-- standings_is_inferred comes straight through from
-- fantasy_standings_snapshots.is_inferred. 1 means the row was RECONSTRUCTED
-- from the weekly scoreboard, not read from the provider — the provider serves
-- exactly one standings state per league and has no historical form (0131).
-- standings_inference_basis explains how. A reconstructed rank must never be
-- reported as a source value, so both columns travel with it.
--
-- HOW THE STANDINGS ROW IS CHOSEN: strictly the is_final = 1 snapshot at the
-- greatest as_of_week. If there is no final snapshot at all, every standings
-- column is NULL and final_standings_missing = 1 — this view does NOT fall back
-- to the latest mid-season snapshot, because presenting a week-9 record as a
-- final record is precisely the kind of silent wrong answer the no-fail-open
-- rule exists to prevent. latest_standings_week_captured is projected so a NULL
-- final is diagnosable ("we have week 12 and nothing after").
--
-- CROSS-CHECKS, not substitutes:
--   points_for                         the standings value (source or inferred)
--   points_for_recomputed_from_weeks   summed from fantasy_team_week_scores
--   weeks_scored                       how many weeks that sum covers
-- A large gap between the two PF numbers means missing weeks, not a tie-break
-- subtlety. Both are projected; neither is silently preferred.
--
--   number_of_moves / number_of_trades         the provider's own counters
--   assets_acquired_observed / assets_given_up_observed / trade_transactions_observed
--                                              counted from the transaction log
-- These measure related but not identical things (the provider's "moves" bundles
-- adds and drops its own way), so they are projected side by side rather than
-- reconciled into one number that would be wrong in both directions.
--
-- CAVEATS:
--   * manager_names is a display convenience built from
--     COALESCE(display_name, nickname_at_time, manager_uid) and joined with
--     ' + ' for co-managed teams. ⚠️ '--hidden--' IS A LEGAL VALUE Yahoo returns
--     for managers who never made their nickname public, and several distinct
--     managers can carry it at once. NEVER group or join on manager_names.
--     manager_uids (the stable account GUIDs) is the key, and it is projected
--     right beside it for exactly that reason.
--   * faab_balance NULL = not exposed, NOT zero remaining (0129).
--   * draft_auction_spend is NULL when no pick in that team's draft carried a
--     price — read it with draft_picks_with_price / draft_picks_without_price.
CREATE VIEW IF NOT EXISTS yahoo_team_seasons AS
SELECT
  t.platform,
  t.league_key,
  t.season,
  t.team_key,
  t.team_id,
  t.team_name,
  t.division_id,
  ls.league_name,
  ls.num_teams,
  ls.playoff_start_week,
  ls.num_playoff_teams,
  ls.is_finished                                         AS league_is_finished,
  (SELECT group_concat(COALESCE(m.display_name, tm.nickname_at_time, tm.manager_uid), ' + ')
     FROM fantasy_team_managers tm
     LEFT JOIN fantasy_managers m
            ON m.platform    = tm.platform
           AND m.manager_uid = tm.manager_uid
    WHERE tm.platform   = t.platform
      AND tm.team_key   = t.team_key
      AND tm.league_key = t.league_key
      AND tm.season     = t.season)                      AS manager_names,
  (SELECT group_concat(tm.manager_uid, ' + ')
     FROM fantasy_team_managers tm
    WHERE tm.platform   = t.platform
      AND tm.team_key   = t.team_key
      AND tm.league_key = t.league_key
      AND tm.season     = t.season)                      AS manager_uids,
  fs."rank"                                              AS final_rank,
  fs.playoff_seed,
  fs.wins,
  fs.losses,
  fs.ties,
  fs.win_percentage,
  fs.points_for,
  fs.points_against,
  fs.games_back,
  fs.streak_type,
  fs.streak_value,
  fs.division_rank,
  fs.clinched_playoffs,
  fs.is_final                                            AS standings_is_final,
  fs.is_inferred                                         AS standings_is_inferred,
  fs.inference_basis                                     AS standings_inference_basis,
  CASE WHEN fs.team_key IS NULL THEN 1 ELSE 0 END        AS final_standings_missing,
  (SELECT MAX(s3.as_of_week)
     FROM fantasy_standings_snapshots s3
    WHERE s3.platform   = t.platform
      AND s3.league_key = t.league_key
      AND s3.season     = t.season
      AND s3.team_key   = t.team_key)                    AS latest_standings_week_captured,
  st.draft_position,
  st.draft_grade,
  st.has_draft_grade,
  st.draft_recap_url,
  st.number_of_moves,
  st.number_of_trades,
  st.waiver_priority,
  st.faab_balance,                                        -- ⚠️ NULL = not exposed, not zero
  (SELECT COUNT(*)
     FROM fantasy_draft_events de
    WHERE de.platform   = t.platform
      AND de.league_key = t.league_key
      AND de.season     = t.season
      AND de.team_key   = t.team_key)                    AS draft_picks_made,
  (SELECT SUM(de.auction_cost)
     FROM fantasy_draft_events de
    WHERE de.platform   = t.platform
      AND de.league_key = t.league_key
      AND de.season     = t.season
      AND de.team_key   = t.team_key)                    AS draft_auction_spend,
  (SELECT COUNT(de.auction_cost)
     FROM fantasy_draft_events de
    WHERE de.platform   = t.platform
      AND de.league_key = t.league_key
      AND de.season     = t.season
      AND de.team_key   = t.team_key)                    AS draft_picks_with_price,
  (SELECT COUNT(*)
     FROM fantasy_draft_events de
    WHERE de.platform     = t.platform
      AND de.league_key   = t.league_key
      AND de.season       = t.season
      AND de.team_key     = t.team_key
      AND de.auction_cost IS NULL)                       AS draft_picks_without_price,
  (SELECT COUNT(*)
     FROM fantasy_transaction_assets a
    WHERE a.platform             = t.platform
      AND a.league_key           = t.league_key
      AND a.season               = t.season
      AND a.destination_team_key = t.team_key)           AS assets_acquired_observed,
  (SELECT COUNT(*)
     FROM fantasy_transaction_assets a
    WHERE a.platform        = t.platform
      AND a.league_key      = t.league_key
      AND a.season          = t.season
      AND a.source_team_key = t.team_key)                AS assets_given_up_observed,
  (SELECT COUNT(DISTINCT a.transaction_key)
     FROM fantasy_transaction_assets a
     JOIN fantasy_transactions tx2
       ON tx2.platform        = a.platform
      AND tx2.transaction_key = a.transaction_key
    WHERE a.platform   = t.platform
      AND a.league_key = t.league_key
      AND a.season     = t.season
      AND LOWER(tx2.transaction_type) LIKE '%trade%'
      AND (a.destination_team_key = t.team_key
        OR a.source_team_key      = t.team_key))         AS trade_transactions_observed,
  (SELECT COUNT(*)
     FROM fantasy_team_week_scores ws
    WHERE ws.platform   = t.platform
      AND ws.league_key = t.league_key
      AND ws.season     = t.season
      AND ws.team_key   = t.team_key)                    AS weeks_scored,
  (SELECT SUM(COALESCE(ws.points_provider, ws.points_from_starters))
     FROM fantasy_team_week_scores ws
    WHERE ws.platform   = t.platform
      AND ws.league_key = t.league_key
      AND ws.season     = t.season
      AND ws.team_key   = t.team_key)                    AS points_for_recomputed_from_weeks
FROM fantasy_teams t
LEFT JOIN fantasy_league_settings ls
       ON ls.platform   = t.platform
      AND ls.league_key = t.league_key
      AND ls.season     = t.season
LEFT JOIN fantasy_team_season_state st
       ON st.platform   = t.platform
      AND st.team_key   = t.team_key
      AND st.league_key = t.league_key
      AND st.season     = t.season
LEFT JOIN fantasy_standings_snapshots fs
       ON fs.platform   = t.platform
      AND fs.league_key = t.league_key
      AND fs.season     = t.season
      AND fs.team_key   = t.team_key
      AND fs.is_final   = 1
      AND fs.as_of_week = (SELECT MAX(s2.as_of_week)
                             FROM fantasy_standings_snapshots s2
                            WHERE s2.platform   = t.platform
                              AND s2.league_key = t.league_key
                              AND s2.season     = t.season
                              AND s2.team_key   = t.team_key
                              AND s2.is_final   = 1)
WHERE t.platform = 'yahoo';


-- ═════════════════════════════════════════════════════════════════════════════
-- PART 2 — ANALYTICAL VIEWS
--
-- These are THE FOUNDATION, NOT THE FINAL MODEL. They compute the primitives
-- every fantasy question is built from — spend vs production, lineup efficiency,
-- acquisition value, all-play — at the lowest grain that is still meaningful, so
-- a caller can roll them up their own way. They do not rank managers, do not
-- grade drafts, and do not compute "luck" — those are judgements, and a judgement
-- baked into a view is a judgement nobody can see to argue with.
--
-- All of them GROUP BY or key on platform + league_key + season. None is pinned
-- to a platform, so the day platform='cbs' rows land they keep being correct.
-- ═════════════════════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────────────────────
-- fantasy_v_draft_value
--
-- QUESTION IT ANSWERS: "what did each pick cost, and what did it return" — draft
-- price against season production, per pick, with team and position on the row
-- so it rolls up either way.
--
-- GRAIN: one row per draft pick (platform, league_key, season, pick_number).
--
-- ⚠️ THE PRICE COLUMN IS RAW. auction_cost is NULL when the provider stated no
-- price and 0 when it stated zero. Nothing here coalesces it, and
-- points_per_dollar is NULL for BOTH cases — a free keeper's return per dollar
-- is undefined, not infinite and not zero. is_price_bearing tells you whether
-- the column means anything at all in this draft: in a snake league it does not.
--
-- WHAT "SEASON POINTS" MEANS HERE. season_points is the player's WHOLE-SEASON
-- points in THIS league (rule 2 preference order), regardless of who rostered
-- him after the draft. That is the standard read of draft value — the pick's
-- return does not stop counting because the drafter traded him — but it is not
-- the only one, so the roster-scoped figures are projected next to it:
--   points_while_rostered_by_drafting_team  points in weeks he was on their roster
--   points_started_for_drafting_team        points in weeks they actually STARTED him
-- The last one is the only figure that ever hit the drafting team's scoreboard.
--
-- COUNT DEFINITIONS, stated because "games played" is not self-evident in
-- fantasy:
--   games_played   weeks with a non-NULL points value for this player in this
--                  league-season. A week reported as 0.0 counts as played,
--                  because the source SAID zero. A week with no row at all does
--                  not, and lands in weeks_points_unknown instead.
--   games_started  weeks the player occupied a starting slot on ANY team in this
--                  league (is_starter = 1). games_started_for_drafting_team
--                  narrows it to the team that drafted him.
--   Weeks where is_starter IS NULL are counted in weeks_starter_state_unknown and
--   are NOT folded into either the started or the benched count.
--
-- CAVEATS:
--   * points_per_game divides by games_played and is NULL when that is 0. It is
--     not a projection and says nothing about weeks he was hurt.
--   * position falls back to the player's LATEST display_position when the draft
--     row did not state one; position_is_latest_not_at_draft = 1 flags those
--     rows. A 2016 pick attributed to a 2026 position is a real hazard when the
--     fallback fires, so it is marked rather than hidden.
--   * Every per-player aggregate is guarded by `player_uid IS NULL` → NULL. An
--     unresolvable pick reports UNKNOWN production, never zero production.
CREATE VIEW IF NOT EXISTS fantasy_v_draft_value AS
WITH picks AS (
  SELECT
    de.platform,
    de.league_key,
    de.season,
    de.team_key,
    t.team_name,
    de.pick_number,
    de.round_number,
    de.pick_in_round,
    de.player_uid,
    p.full_name                                          AS player_name,
    COALESCE(de.player_position_at_draft, p.display_position)
                                                         AS position,
    CASE WHEN de.player_position_at_draft IS NULL
               AND p.display_position IS NOT NULL
         THEN 1 ELSE 0
    END                                                  AS position_is_latest_not_at_draft,
    de.auction_cost,                                      -- ⚠️ raw. NULL != 0.
    d.draft_kind,
    d.is_price_bearing,
    de.is_keeper,
    de.keeper_inferred,

    -- Whole-season production in THIS league (rule 2 preference order).
    CASE WHEN de.player_uid IS NULL THEN NULL ELSE (
      SELECT SUM(COALESCE(pw.points_provider, pw.points_recomputed))
        FROM fantasy_player_week_points pw
       WHERE pw.platform   = de.platform
         AND pw.league_key = de.league_key
         AND pw.season     = de.season
         AND pw.player_uid = de.player_uid) END           AS season_points,
    CASE WHEN de.player_uid IS NULL THEN NULL ELSE (
      SELECT COUNT(COALESCE(pw.points_provider, pw.points_recomputed))
        FROM fantasy_player_week_points pw
       WHERE pw.platform   = de.platform
         AND pw.league_key = de.league_key
         AND pw.season     = de.season
         AND pw.player_uid = de.player_uid) END           AS games_played,
    CASE WHEN de.player_uid IS NULL THEN NULL ELSE (
      SELECT COUNT(*)
        FROM fantasy_player_week_points pw
       WHERE pw.platform   = de.platform
         AND pw.league_key = de.league_key
         AND pw.season     = de.season
         AND pw.player_uid = de.player_uid
         AND pw.points_provider IS NULL
         AND pw.points_recomputed IS NULL) END            AS weeks_points_unknown,

    -- Fantasy usage, league-wide.
    CASE WHEN de.player_uid IS NULL THEN NULL ELSE (
      SELECT COUNT(*)
        FROM fantasy_roster_snapshots rs
       WHERE rs.platform   = de.platform
         AND rs.league_key = de.league_key
         AND rs.season     = de.season
         AND rs.player_uid = de.player_uid
         AND rs.is_starter = 1) END                       AS games_started,
    CASE WHEN de.player_uid IS NULL THEN NULL ELSE (
      SELECT COUNT(*)
        FROM fantasy_roster_snapshots rs
       WHERE rs.platform   = de.platform
         AND rs.league_key = de.league_key
         AND rs.season     = de.season
         AND rs.player_uid = de.player_uid) END           AS weeks_rostered,
    CASE WHEN de.player_uid IS NULL THEN NULL ELSE (
      SELECT COUNT(*)
        FROM fantasy_roster_snapshots rs
       WHERE rs.platform   = de.platform
         AND rs.league_key = de.league_key
         AND rs.season     = de.season
         AND rs.player_uid = de.player_uid
         AND rs.is_starter IS NULL) END                   AS weeks_starter_state_unknown,

    -- Usage and production for the DRAFTING team specifically.
    CASE WHEN de.player_uid IS NULL OR de.team_key IS NULL THEN NULL ELSE (
      SELECT COUNT(*)
        FROM fantasy_roster_snapshots rs
       WHERE rs.platform   = de.platform
         AND rs.league_key = de.league_key
         AND rs.season     = de.season
         AND rs.player_uid = de.player_uid
         AND rs.team_key   = de.team_key) END             AS weeks_rostered_by_drafting_team,
    CASE WHEN de.player_uid IS NULL OR de.team_key IS NULL THEN NULL ELSE (
      SELECT COUNT(*)
        FROM fantasy_roster_snapshots rs
       WHERE rs.platform   = de.platform
         AND rs.league_key = de.league_key
         AND rs.season     = de.season
         AND rs.player_uid = de.player_uid
         AND rs.team_key   = de.team_key
         AND rs.is_starter = 1) END                       AS games_started_for_drafting_team,
    CASE WHEN de.player_uid IS NULL OR de.team_key IS NULL THEN NULL ELSE (
      SELECT SUM(COALESCE(pw.points_provider, pw.points_recomputed))
        FROM fantasy_roster_snapshots rs
        JOIN fantasy_player_week_points pw
          ON pw.platform   = rs.platform
         AND pw.league_key = rs.league_key
         AND pw.season     = rs.season
         AND pw.week       = rs.week
         AND pw.player_uid = rs.player_uid
       WHERE rs.platform   = de.platform
         AND rs.league_key = de.league_key
         AND rs.season     = de.season
         AND rs.player_uid = de.player_uid
         AND rs.team_key   = de.team_key) END             AS points_while_rostered_by_drafting_team,
    CASE WHEN de.player_uid IS NULL OR de.team_key IS NULL THEN NULL ELSE (
      SELECT SUM(COALESCE(pw.points_provider, pw.points_recomputed))
        FROM fantasy_roster_snapshots rs
        JOIN fantasy_player_week_points pw
          ON pw.platform   = rs.platform
         AND pw.league_key = rs.league_key
         AND pw.season     = rs.season
         AND pw.week       = rs.week
         AND pw.player_uid = rs.player_uid
       WHERE rs.platform   = de.platform
         AND rs.league_key = de.league_key
         AND rs.season     = de.season
         AND rs.player_uid = de.player_uid
         AND rs.team_key   = de.team_key
         AND rs.is_starter = 1) END                       AS points_started_for_drafting_team
  FROM fantasy_draft_events de
  LEFT JOIN fantasy_drafts d
         ON d.platform   = de.platform
        AND d.league_key = de.league_key
        AND d.season     = de.season
  LEFT JOIN fantasy_teams t
         ON t.platform   = de.platform
        AND t.team_key   = de.team_key
        AND t.league_key = de.league_key
        AND t.season     = de.season
  LEFT JOIN fantasy_players p
         ON p.platform   = de.platform
        AND p.player_uid = de.player_uid
)
SELECT
  picks.*,
  CASE WHEN games_played IS NULL OR games_played = 0
       THEN NULL
       ELSE season_points / games_played
  END                                                    AS points_per_game,
  -- ⚠️ NULL for an unpriced pick AND for a genuinely free one. Undefined, not zero.
  CASE WHEN auction_cost IS NULL OR auction_cost <= 0
       THEN NULL
       ELSE season_points / auction_cost
  END                                                    AS points_per_dollar
FROM picks;


-- ─────────────────────────────────────────────────────────────────────────────
-- fantasy_v_roster_construction
--
-- QUESTION IT ANSWERS: "how did this team allocate — money, roster spots, and
-- lineup slots — across positions" — the shape of a roster rather than its
-- result.
--
-- GRAIN: one row per (platform, league_key, season, team_key, position_group).
--
-- HOW THE ROW SET IS BUILT. Three independent aggregates are unioned on their
-- keys, not inner-joined:
--   roster_agg  what was actually rostered week to week
--   draft_agg   what was drafted, and for what price
--   faab_agg    what was picked up off waivers/free agency, and for what bid
-- A position a team drafted but never rostered still gets a row (with NULL
-- roster counts), and vice versa. An INNER JOIN between these would silently
-- delete a busted pick that never made a lineup — which is exactly the case
-- anyone asking about roster construction most wants to see.
--
-- The union spine joins on `position_group IS position_group` (SQLite's
-- null-safe equality), so a genuinely unknown position groups with itself
-- instead of vanishing from the join.
--
-- POSITION RESOLUTION. position_group is the source's own at-the-time position
-- where it stated one, else the player's latest display_position. That fallback
-- is a documented display convenience, and it is why this view is a foundation
-- rather than a final answer: a player who changed positions between the draft
-- and week 12 can appear under two groups.
--
-- COLUMN MEANINGS:
--   players_rostered              distinct players at this position, all season
--   roster_player_weeks           player-weeks — 3 players for 6 weeks = 18
--   starter_player_weeks          is_starter = 1
--   bench_player_weeks            is_starter = 0. ⚠️ INCLUDES injury slots by
--                                 construction, because an IR slot is not a
--                                 starting slot. Subtract injury_slot_player_weeks
--                                 if you want bench-excluding-IR.
--   unknown_starter_player_weeks  is_starter IS NULL — slot definitions were
--                                 missing at ingest. NOT bench.
--   injury_slot_player_weeks      IR usage in player-weeks
--   players_ever_on_injury_slot   distinct players who spent any week on IR
--   avg_starters_per_week         starter_player_weeks / team_weeks_observed,
--                                 i.e. how many of this position the team
--                                 typically started. Divides by the weeks the
--                                 TEAM was observed at all, not the weeks this
--                                 position appeared, so a position that was
--                                 benched all year reads as a low average rather
--                                 than an undefined one.
--
-- SPEND CAVEATS:
--   * auction_spend is NULL when NO pick at this position carried a price. Read
--     it with picks_with_price / picks_without_price. Never coalesced.
--   * faab_spend sums the PARENT transaction's faab_bid once per acquisition
--     leg. add_legs_sharing_one_bid counts the legs whose parent had more than
--     one add — those double-count in this sum and the column exists so that is
--     detectable rather than invisible. NULL bid = not exposed; 0 = a real zero
--     bid, which is legal and is not the same thing.
--   * faab_agg counts only acquisitions whose source_type is 'waivers' or
--     'freeagents'. Trade acquisitions are structurally excluded here — they
--     belong to fantasy_v_trade_ledger — using the SOURCE TYPE rather than the
--     transaction_type vocabulary, which is verbatim provider text and not
--     something to pattern-match on for a money figure.
CREATE VIEW IF NOT EXISTS fantasy_v_roster_construction AS
WITH roster_pos AS (
  SELECT
    rs.platform,
    rs.league_key,
    rs.season,
    rs.team_key,
    COALESCE(rs.player_position, p.display_position)     AS position_group,
    rs.week,
    rs.player_uid,
    rs.is_starter,
    rs.is_injury_slot,
    rs.is_flex_slot
  FROM fantasy_roster_snapshots rs
  LEFT JOIN fantasy_players p
         ON p.platform   = rs.platform
        AND p.player_uid = rs.player_uid
),
roster_agg AS (
  SELECT
    platform,
    league_key,
    season,
    team_key,
    position_group,
    COUNT(DISTINCT player_uid)                           AS players_rostered,
    COUNT(*)                                             AS roster_player_weeks,
    COUNT(DISTINCT week)                                 AS weeks_position_present,
    SUM(CASE WHEN is_starter = 1    THEN 1 ELSE 0 END)   AS starter_player_weeks,
    SUM(CASE WHEN is_starter = 0    THEN 1 ELSE 0 END)   AS bench_player_weeks,
    SUM(CASE WHEN is_starter IS NULL THEN 1 ELSE 0 END)  AS unknown_starter_player_weeks,
    SUM(CASE WHEN is_injury_slot = 1 THEN 1 ELSE 0 END)  AS injury_slot_player_weeks,
    SUM(CASE WHEN is_flex_slot   = 1 THEN 1 ELSE 0 END)  AS flex_slot_player_weeks,
    COUNT(DISTINCT CASE WHEN is_injury_slot = 1 THEN player_uid END)
                                                         AS players_ever_on_injury_slot
  FROM roster_pos
  GROUP BY platform, league_key, season, team_key, position_group
),
draft_agg AS (
  SELECT
    de.platform,
    de.league_key,
    de.season,
    de.team_key,
    COALESCE(de.player_position_at_draft, p.display_position)
                                                         AS position_group,
    COUNT(*)                                             AS picks_used,
    SUM(de.auction_cost)                                 AS auction_spend,
    COUNT(de.auction_cost)                               AS picks_with_price,
    SUM(CASE WHEN de.auction_cost IS NULL THEN 1 ELSE 0 END)
                                                         AS picks_without_price,
    MIN(de.round_number)                                 AS earliest_round_used,
    MIN(de.pick_number)                                  AS earliest_pick_used
  FROM fantasy_draft_events de
  LEFT JOIN fantasy_players p
         ON p.platform   = de.platform
        AND p.player_uid = de.player_uid
  WHERE de.team_key IS NOT NULL
  GROUP BY de.platform, de.league_key, de.season, de.team_key,
           COALESCE(de.player_position_at_draft, p.display_position)
),
faab_agg AS (
  SELECT
    a.platform,
    a.league_key,
    a.season,
    a.destination_team_key                               AS team_key,
    COALESCE(a.player_position_at_txn, p.display_position)
                                                         AS position_group,
    COUNT(*)                                             AS acquisitions,
    SUM(tx.faab_bid)                                     AS faab_spend,
    COUNT(tx.faab_bid)                                   AS acquisitions_with_bid,
    SUM(CASE WHEN tx.faab_bid IS NULL THEN 1 ELSE 0 END) AS acquisitions_without_bid,
    SUM(CASE WHEN (SELECT COUNT(*)
                     FROM fantasy_transaction_assets x
                    WHERE x.platform        = a.platform
                      AND x.transaction_key = a.transaction_key
                      AND LOWER(x.movement_type) = 'add') > 1
              THEN 1 ELSE 0 END)                         AS add_legs_sharing_one_bid
  FROM fantasy_transaction_assets a
  JOIN fantasy_transactions tx
    ON tx.platform        = a.platform
   AND tx.transaction_key = a.transaction_key
   AND tx.league_key      = a.league_key
   AND tx.season          = a.season
  LEFT JOIN fantasy_players p
         ON p.platform   = a.platform
        AND p.player_uid = a.player_uid
  -- ⚠️ LOWER() HERE, NOT A LITERAL 'add'. movement_type is stored VERBATIM
  -- per platform: Yahoo's API says 'add'/'drop' (lowercase), ESPN's says
  -- 'ADD'/'DROP' (uppercase) — both parsers correctly preserve their own
  -- provider's spelling, so a case-sensitive filter here silently returned
  -- ZERO rows for ESPN (found live, 2026-08-12, querying this exact CTE for
  -- Keith's league). The columns being compared are our OWN normalized
  -- vocabulary (not provider-verbatim), so normalizing the comparison here
  -- is the view's job, not a change to what the parsers store.
  WHERE LOWER(a.movement_type) = 'add'
    AND a.destination_type     = 'team'
    AND a.destination_team_key IS NOT NULL
    AND a.source_type IN ('waivers', 'freeagents')
  GROUP BY a.platform, a.league_key, a.season, a.destination_team_key,
           COALESCE(a.player_position_at_txn, p.display_position)
),
spine AS (
  SELECT platform, league_key, season, team_key, position_group FROM roster_agg
  UNION
  SELECT platform, league_key, season, team_key, position_group FROM draft_agg
  UNION
  SELECT platform, league_key, season, team_key, position_group FROM faab_agg
)
SELECT
  k.platform,
  k.league_key,
  k.season,
  k.team_key,
  t.team_name,
  k.position_group,
  r.players_rostered,
  r.roster_player_weeks,
  r.weeks_position_present,
  r.starter_player_weeks,
  r.bench_player_weeks,
  r.unknown_starter_player_weeks,
  r.injury_slot_player_weeks,
  r.players_ever_on_injury_slot,
  r.flex_slot_player_weeks,
  d.picks_used,
  d.auction_spend,                                        -- ⚠️ NULL when no pick had a price
  d.picks_with_price,
  d.picks_without_price,
  d.earliest_round_used,
  d.earliest_pick_used,
  f.acquisitions,
  f.faab_spend,                                           -- ⚠️ NULL when no bid was exposed
  f.acquisitions_with_bid,
  f.acquisitions_without_bid,
  f.add_legs_sharing_one_bid,
  (SELECT COUNT(DISTINCT rs2.week)
     FROM fantasy_roster_snapshots rs2
    WHERE rs2.platform   = k.platform
      AND rs2.league_key = k.league_key
      AND rs2.season     = k.season
      AND rs2.team_key   = k.team_key)                   AS team_weeks_observed,
  CASE WHEN (SELECT COUNT(DISTINCT rs3.week)
               FROM fantasy_roster_snapshots rs3
              WHERE rs3.platform   = k.platform
                AND rs3.league_key = k.league_key
                AND rs3.season     = k.season
                AND rs3.team_key   = k.team_key) > 0
       THEN r.starter_player_weeks * 1.0 /
            (SELECT COUNT(DISTINCT rs4.week)
               FROM fantasy_roster_snapshots rs4
              WHERE rs4.platform   = k.platform
                AND rs4.league_key = k.league_key
                AND rs4.season     = k.season
                AND rs4.team_key   = k.team_key)
       ELSE NULL
  END                                                    AS avg_starters_per_week
FROM spine k
LEFT JOIN roster_agg r
       ON r.platform       = k.platform
      AND r.league_key     = k.league_key
      AND r.season         = k.season
      AND r.team_key       = k.team_key
      AND r.position_group IS k.position_group
LEFT JOIN draft_agg d
       ON d.platform       = k.platform
      AND d.league_key     = k.league_key
      AND d.season         = k.season
      AND d.team_key       = k.team_key
      AND d.position_group IS k.position_group
LEFT JOIN faab_agg f
       ON f.platform       = k.platform
      AND f.league_key     = k.league_key
      AND f.season         = k.season
      AND f.team_key       = k.team_key
      AND f.position_group IS k.position_group
LEFT JOIN fantasy_teams t
       ON t.platform   = k.platform
      AND t.team_key   = k.team_key
      AND t.league_key = k.league_key
      AND t.season     = k.season;


-- ─────────────────────────────────────────────────────────────────────────────
-- fantasy_v_bench_points
--
-- QUESTION IT ANSWERS: "how much did this manager leave on the bench, and how
-- close was the lineup to the best legal one" — actual vs optimal per team-week.
--
-- GRAIN: one row per (platform, league_key, season, week, team_key).
--
-- ⚠️ THIS VIEW DOES NOT SOLVE THE OPTIMAL LINEUP. Finding the best legal lineup
-- is bin-packing over per-player slot eligibility against this league's own slot
-- table, and it belongs in the ingester (which writes
-- fantasy_team_week_scores.points_optimal), not in SQL. This view SURFACES that
-- value and REFUSES to invent one: when points_optimal is NULL, both
-- points_left_on_bench and lineup_efficiency_recomputed are NULL. An efficiency
-- of 1.0 for a team whose optimal was never computed would be a fabricated
-- compliment.
--
-- WHAT IS RECOMPUTED HERE, and why. starter_points_from_rosters and
-- bench_points_from_rosters are summed independently from the roster snapshots
-- joined to weekly points, using is_starter (never a slot string). They exist to
-- be COMPARED against the stored points_from_starters / points_bench: a
-- disagreement means the roster capture is incomplete or the starter derivation
-- is stale, and 0131 explicitly calls that out as the check both numbers are
-- stored for. Both are projected. Neither is silently preferred.
--
-- THREE-WAY STARTER ACCOUNTING, per rule 3:
--   starter_points_from_rosters        is_starter = 1
--   bench_points_from_rosters          is_starter = 0 (⚠️ includes injury slots)
--   injury_slot_points                 is_injury_slot = 1, broken out so bench
--                                      can be read either way
--   unknown_starter_state_points       is_starter IS NULL — points belonging to
--                                      players whose slot could not be
--                                      classified. NOT counted as bench.
-- The matching *_counted and *_missing_points columns say how many players are
-- behind each sum and how many of them had no points row at all, so a small
-- bench total is distinguishable from a missing one.
--
-- league_starting_slots_defined is the number of starting slots
-- fantasy_roster_positions defines for this league-season. 0 means the slot
-- table was never loaded — in which case every is_starter is NULL, every sum
-- above is NULL, and that is the correct output rather than a zero.
--
-- THE ROW SET is a UNION of team-weeks seen in fantasy_team_week_scores and
-- team-weeks seen in fantasy_roster_snapshots. A team-week with a roster but no
-- score row still appears (team_week_score_row_missing = 1) and vice versa —
-- driving off either table alone would hide exactly the gap worth finding.
CREATE VIEW IF NOT EXISTS fantasy_v_bench_points AS
WITH roster_pts AS (
  SELECT
    rs.platform,
    rs.league_key,
    rs.season,
    rs.week,
    rs.team_key,
    rs.is_starter,
    rs.is_injury_slot,
    COALESCE(pw.points_provider, pw.points_recomputed)   AS pts
  FROM fantasy_roster_snapshots rs
  LEFT JOIN fantasy_player_week_points pw
         ON pw.platform   = rs.platform
        AND pw.league_key = rs.league_key
        AND pw.season     = rs.season
        AND pw.week       = rs.week
        AND pw.player_uid = rs.player_uid
),
roster_agg AS (
  SELECT
    platform,
    league_key,
    season,
    week,
    team_key,
    SUM(CASE WHEN is_starter = 1     THEN pts END)       AS starter_points_from_rosters,
    SUM(CASE WHEN is_starter = 0     THEN pts END)       AS bench_points_from_rosters,
    SUM(CASE WHEN is_injury_slot = 1 THEN pts END)       AS injury_slot_points,
    SUM(CASE WHEN is_starter IS NULL THEN pts END)       AS unknown_starter_state_points,
    SUM(CASE WHEN is_starter = 1     THEN 1 ELSE 0 END)  AS starters_counted,
    SUM(CASE WHEN is_starter = 0     THEN 1 ELSE 0 END)  AS bench_counted,
    SUM(CASE WHEN is_starter IS NULL THEN 1 ELSE 0 END)  AS unknown_starter_state_counted,
    SUM(CASE WHEN is_starter = 1 AND pts IS NULL THEN 1 ELSE 0 END)
                                                         AS starters_missing_points,
    SUM(CASE WHEN is_starter = 0 AND pts IS NULL THEN 1 ELSE 0 END)
                                                         AS bench_missing_points,
    COUNT(*)                                             AS roster_slots_observed
  FROM roster_pts
  GROUP BY platform, league_key, season, week, team_key
),
spine AS (
  SELECT platform, league_key, season, week, team_key FROM fantasy_team_week_scores
  UNION
  SELECT platform, league_key, season, week, team_key FROM fantasy_roster_snapshots
)
SELECT
  k.platform,
  k.league_key,
  k.season,
  k.week,
  k.team_key,
  t.team_name,
  s.points_provider,
  s.points_from_starters,
  s.points_bench,
  s.points_optimal,                                       -- ⚠️ NULL = never computed. Not zero.
  s.lineup_efficiency,
  s.projected_points,
  s.scores_reconciled,
  s.reconcile_delta,
  s.is_derived                                           AS team_week_score_is_derived,
  r.starter_points_from_rosters,
  r.bench_points_from_rosters,                            -- ⚠️ includes injury slots
  r.injury_slot_points,
  r.unknown_starter_state_points,
  r.starters_counted,
  r.bench_counted,
  r.unknown_starter_state_counted,
  r.starters_missing_points,
  r.bench_missing_points,
  r.roster_slots_observed,
  CASE WHEN s.points_optimal IS NULL OR s.points_from_starters IS NULL
       THEN NULL
       ELSE s.points_optimal - s.points_from_starters
  END                                                    AS points_left_on_bench,
  CASE WHEN s.points_optimal IS NULL
             OR s.points_optimal = 0
             OR s.points_from_starters IS NULL
       THEN NULL
       ELSE s.points_from_starters / s.points_optimal
  END                                                    AS lineup_efficiency_recomputed,
  CASE WHEN s.points_from_starters IS NULL
             OR r.starter_points_from_rosters IS NULL
       THEN NULL
       ELSE s.points_from_starters - r.starter_points_from_rosters
  END                                                    AS starter_points_disagreement,
  (SELECT COUNT(*)
     FROM fantasy_roster_positions rp
    WHERE rp.platform         = k.platform
      AND rp.league_key       = k.league_key
      AND rp.season           = k.season
      AND rp.is_starting_slot = 1)                       AS league_starting_slots_defined,
  CASE WHEN s.team_key IS NULL THEN 1 ELSE 0 END         AS team_week_score_row_missing,
  CASE WHEN r.team_key IS NULL THEN 1 ELSE 0 END         AS roster_snapshot_rows_missing,
  sp.is_playoff,
  sp.is_consolation,
  sp.is_championship
FROM spine k
LEFT JOIN fantasy_team_week_scores s
       ON s.platform   = k.platform
      AND s.league_key = k.league_key
      AND s.season     = k.season
      AND s.week       = k.week
      AND s.team_key   = k.team_key
LEFT JOIN roster_agg r
       ON r.platform   = k.platform
      AND r.league_key = k.league_key
      AND r.season     = k.season
      AND r.week       = k.week
      AND r.team_key   = k.team_key
LEFT JOIN fantasy_teams t
       ON t.platform   = k.platform
      AND t.team_key   = k.team_key
      AND t.league_key = k.league_key
      AND t.season     = k.season
LEFT JOIN fantasy_schedule_periods sp
       ON sp.platform   = k.platform
      AND sp.league_key = k.league_key
      AND sp.season     = k.season
      AND sp.week       = k.week;


-- ─────────────────────────────────────────────────────────────────────────────
-- fantasy_v_waiver_value
--
-- QUESTION IT ANSWERS: "what did we pay for pickups, and what did they give
-- back" — FAAB spend against production before and after the acquisition, with
-- how often the player actually STARTED for the team that paid.
--
-- GRAIN: one row per acquisition leg — a transaction asset with
-- LOWER(movement_type) = 'add', destination_type = 'team', and source_type in
-- ('waivers','freeagents'). Trade acquisitions are excluded structurally, by
-- source type rather than by pattern-matching the verbatim transaction_type.
-- Roll up by team_key for "FAAB spent by team", by position for "by position".
-- ⚠️ LOWER() is required: movement_type is provider-verbatim ('add'/'drop' for
-- Yahoo, 'ADD'/'DROP' for ESPN) — a bare 'add' literal silently returned zero
-- rows for every ESPN league (found live 2026-08-12, fixed here).
--
-- ⚠️ BID SEMANTICS. faab_bid lives on the PARENT transaction. NULL means the
-- provider did not expose the bid — it does NOT mean the pickup was free. 0
-- means a real zero-dollar winning bid, which is legal in a FAAB league. Nothing
-- here coalesces it, and points_per_faab_dollar is NULL for both cases because
-- return-per-dollar on a zero-dollar claim is undefined, not infinite.
-- add_legs_in_transaction > 1 means this parent's single bid is shared across
-- several add legs, so summing faab_bid over those rows double-counts. The
-- column is projected so a rollup can detect and handle it.
--
-- ⚠️ THE BEFORE/AFTER SPLIT DEPENDS ON acquisition_week, WHICH CAN BE NULL.
-- fantasy_transactions.week is derived from the timestamp against the schedule
-- periods and is NULL when it could not be derived. When it is NULL, every
-- before/after figure in this row is NULL — not 0, and not "the whole season".
-- A window with no boundary produces no answer.
--
-- COLUMNS:
--   points_before_acquisition          league points in weeks < acquisition_week
--   points_from_acquisition_onward     league points in weeks >= acquisition_week
--                                      (whole league, regardless of who rostered
--                                      him afterwards)
--   points_rostered_by_acquirer_after  points in weeks he was actually on the
--                                      acquiring team's roster
--   points_started_for_acquirer_after  points in weeks the acquiring team STARTED
--                                      him — the only figure that ever reached
--                                      their scoreboard
--   weeks_started_for_acquirer_after   is_starter = 1 for that team, after
--   weeks_rostered_by_acquirer_after   any slot for that team, after
--
-- CAVEATS:
--   * A player picked up, dropped, and picked up again produces TWO rows whose
--     after-windows OVERLAP. Summing naively double-counts his production. Take
--     the latest acquisition per (team, player) if you need disjoint windows.
--   * Losing bids are structurally unavailable (0130), so the market this view
--     describes always looks less contested than it was.
--   * Every per-player aggregate is guarded on player_uid IS NULL, so a leg with
--     no resolvable player reports UNKNOWN rather than zero production.
CREATE VIEW IF NOT EXISTS fantasy_v_waiver_value AS
WITH acq AS (
  SELECT
    a.platform,
    a.league_key,
    a.season,
    a.transaction_key,
    a.leg_index,
    tx.transaction_type,                                  -- VERBATIM
    tx.status,                                            -- VERBATIM
    tx.timestamp_unix,
    tx.processed_date,
    tx.week                                              AS acquisition_week,
    tx.faab_bid,                                          -- ⚠️ NULL = not exposed, 0 = real zero bid
    tx.waiver_priority_at_processing,
    a.source_type,
    a.destination_team_key                               AS team_key,
    a.player_uid,
    a.player_name_at_txn,
    COALESCE(a.player_position_at_txn, p.display_position)
                                                         AS position,
    (SELECT COUNT(*)
       FROM fantasy_transaction_assets x
      WHERE x.platform        = a.platform
        AND x.transaction_key = a.transaction_key
        AND LOWER(x.movement_type) = 'add')               AS add_legs_in_transaction,

    CASE WHEN a.player_uid IS NULL OR tx.week IS NULL THEN NULL ELSE (
      SELECT SUM(COALESCE(pw.points_provider, pw.points_recomputed))
        FROM fantasy_player_week_points pw
       WHERE pw.platform   = a.platform
         AND pw.league_key = a.league_key
         AND pw.season     = a.season
         AND pw.player_uid = a.player_uid
         AND pw.week       < tx.week) END                 AS points_before_acquisition,
    CASE WHEN a.player_uid IS NULL OR tx.week IS NULL THEN NULL ELSE (
      SELECT SUM(COALESCE(pw.points_provider, pw.points_recomputed))
        FROM fantasy_player_week_points pw
       WHERE pw.platform   = a.platform
         AND pw.league_key = a.league_key
         AND pw.season     = a.season
         AND pw.player_uid = a.player_uid
         AND pw.week       >= tx.week) END                AS points_from_acquisition_onward,
    CASE WHEN a.player_uid IS NULL OR tx.week IS NULL THEN NULL ELSE (
      SELECT COUNT(COALESCE(pw.points_provider, pw.points_recomputed))
        FROM fantasy_player_week_points pw
       WHERE pw.platform   = a.platform
         AND pw.league_key = a.league_key
         AND pw.season     = a.season
         AND pw.player_uid = a.player_uid
         AND pw.week       >= tx.week) END                AS weeks_with_points_after,

    CASE WHEN a.player_uid IS NULL OR tx.week IS NULL OR a.destination_team_key IS NULL THEN NULL ELSE (
      SELECT COUNT(*)
        FROM fantasy_roster_snapshots rs
       WHERE rs.platform   = a.platform
         AND rs.league_key = a.league_key
         AND rs.season     = a.season
         AND rs.player_uid = a.player_uid
         AND rs.team_key   = a.destination_team_key
         AND rs.week       >= tx.week) END                AS weeks_rostered_by_acquirer_after,
    CASE WHEN a.player_uid IS NULL OR tx.week IS NULL OR a.destination_team_key IS NULL THEN NULL ELSE (
      SELECT COUNT(*)
        FROM fantasy_roster_snapshots rs
       WHERE rs.platform   = a.platform
         AND rs.league_key = a.league_key
         AND rs.season     = a.season
         AND rs.player_uid = a.player_uid
         AND rs.team_key   = a.destination_team_key
         AND rs.week       >= tx.week
         AND rs.is_starter = 1) END                       AS weeks_started_for_acquirer_after,
    CASE WHEN a.player_uid IS NULL OR tx.week IS NULL OR a.destination_team_key IS NULL THEN NULL ELSE (
      SELECT SUM(COALESCE(pw.points_provider, pw.points_recomputed))
        FROM fantasy_roster_snapshots rs
        JOIN fantasy_player_week_points pw
          ON pw.platform   = rs.platform
         AND pw.league_key = rs.league_key
         AND pw.season     = rs.season
         AND pw.week       = rs.week
         AND pw.player_uid = rs.player_uid
       WHERE rs.platform   = a.platform
         AND rs.league_key = a.league_key
         AND rs.season     = a.season
         AND rs.player_uid = a.player_uid
         AND rs.team_key   = a.destination_team_key
         AND rs.week       >= tx.week) END                AS points_rostered_by_acquirer_after,
    CASE WHEN a.player_uid IS NULL OR tx.week IS NULL OR a.destination_team_key IS NULL THEN NULL ELSE (
      SELECT SUM(COALESCE(pw.points_provider, pw.points_recomputed))
        FROM fantasy_roster_snapshots rs
        JOIN fantasy_player_week_points pw
          ON pw.platform   = rs.platform
         AND pw.league_key = rs.league_key
         AND pw.season     = rs.season
         AND pw.week       = rs.week
         AND pw.player_uid = rs.player_uid
       WHERE rs.platform   = a.platform
         AND rs.league_key = a.league_key
         AND rs.season     = a.season
         AND rs.player_uid = a.player_uid
         AND rs.team_key   = a.destination_team_key
         AND rs.week       >= tx.week
         AND rs.is_starter = 1) END                       AS points_started_for_acquirer_after
  FROM fantasy_transaction_assets a
  JOIN fantasy_transactions tx
    ON tx.platform        = a.platform
   AND tx.transaction_key = a.transaction_key
   AND tx.league_key      = a.league_key
   AND tx.season          = a.season
  LEFT JOIN fantasy_players p
         ON p.platform   = a.platform
        AND p.player_uid = a.player_uid
  -- ⚠️ LOWER() — see the matching comment in fantasy_v_roster_construction's
  -- faab_agg CTE above. ESPN stores 'ADD'/'DROP' (its own API's casing);
  -- Yahoo stores 'add'/'drop'. A literal 'add' here returned zero rows for
  -- every ESPN league, silently, until caught live 2026-08-12.
  WHERE LOWER(a.movement_type) = 'add'
    AND a.destination_type     = 'team'
    AND a.destination_team_key IS NOT NULL
    AND a.source_type IN ('waivers', 'freeagents')
)
SELECT
  acq.*,
  t.team_name,
  -- ⚠️ NULL for an unexposed bid AND for a real zero bid. Undefined, not zero.
  CASE WHEN faab_bid IS NULL OR faab_bid <= 0
       THEN NULL
       ELSE points_started_for_acquirer_after / faab_bid
  END                                                    AS started_points_per_faab_dollar
FROM acq
LEFT JOIN fantasy_teams t
       ON t.platform   = acq.platform
      AND t.team_key   = acq.team_key
      AND t.league_key = acq.league_key
      AND t.season     = acq.season;


-- ─────────────────────────────────────────────────────────────────────────────
-- fantasy_v_trade_ledger
--
-- QUESTION IT ANSWERS: "who traded what, and how did it play out" — every asset
-- that changed hands in a trade, with rest-of-season production attached to the
-- side that received it.
--
-- GRAIN: one row per trade leg. A 2-for-1 is three rows. Each row names the team
-- that gave the asset up and the team that received it, so summing
-- rest_of_season_points GROUP BY to_team_key gives each side's haul, and the
-- same sum GROUP BY from_team_key gives what each side surrendered. That is what
-- "for each side" means here — the sides are derived from the legs, not from a
-- guess about which team is "team 1".
--
-- WHICH TRANSACTIONS COUNT: LOWER(transaction_type) LIKE '%trade%'. That is a
-- deliberately loose match over VERBATIM provider vocabulary, catching 'trade'
-- and 'pending_trade' without hardcoding an exhaustive list that a vocabulary
-- change would silently empty. ⚠️ IT THEREFORE INCLUDES PROPOSED AND PENDING
-- TRADES. status is projected and YOU MUST FILTER ON IT — a proposed trade that
-- never executed is in this view, and counting it as a completed one would
-- invent a transaction that never happened. The structural columns
-- (source_type / destination_type) are projected too, so a caller can confirm a
-- leg really is a team-to-team movement.
--
-- ASSET KINDS. asset_kind is 'player', 'draft_pick', or 'faab'. Draft picks and
-- FAAB have no weekly points by definition, so every production column is NULL
-- for them — NULL meaning "the concept does not apply", never zero. pick_season /
-- pick_round carry what a pick leg actually is.
--
-- PRODUCTION COLUMNS (players only, and only when trade_week is derivable):
--   points_before_trade                league points in weeks < trade_week
--   rest_of_season_points              league points in weeks >= trade_week,
--                                      regardless of later moves
--   ros_points_rostered_by_receiver    points in weeks he was on the receiving
--                                      team's roster
--   ros_points_started_by_receiver     points in weeks the receiving team STARTED
--                                      him — what actually hit their scoreboard
--   ros_weeks_started_by_receiver      count of those weeks
--
-- CAVEATS:
--   * trade_week is fantasy_transactions.week, derived from the timestamp. When
--     it is NULL every before/after figure is NULL. A window with no boundary
--     produces no answer, not a full-season one.
--   * A player traded twice produces overlapping after-windows across two rows.
--   * Rest-of-season points are a DESCRIPTION, not a verdict. They ignore
--     opportunity cost, roster context, and the games the receiving team had
--     already won or lost. This is the foundation for a trade evaluation, not
--     one.
CREATE VIEW IF NOT EXISTS fantasy_v_trade_ledger AS
SELECT
  a.platform,
  a.league_key,
  a.season,
  a.transaction_key,
  a.leg_index,
  tx.transaction_type,                                    -- VERBATIM
  tx.status,                                              -- ⚠️ FILTER ON THIS
  tx.timestamp_unix,
  tx.processed_date,
  tx.week                                                AS trade_week,
  tx.trade_note,
  (SELECT COUNT(*)
     FROM fantasy_transaction_assets x
    WHERE x.platform        = a.platform
      AND x.transaction_key = a.transaction_key)         AS legs_in_trade,
  a.asset_kind,
  a.movement_type,
  a.source_type,
  a.destination_type,
  a.source_team_key                                      AS from_team_key,
  a.source_team_name                                     AS from_team_name_at_txn,
  ft.team_name                                           AS from_team_name_current,
  a.destination_team_key                                 AS to_team_key,
  a.destination_team_name                                AS to_team_name_at_txn,
  tt.team_name                                           AS to_team_name_current,
  a.player_uid,
  a.player_name_at_txn,
  COALESCE(a.player_position_at_txn, p.display_position) AS position,
  a.nfl_team_at_txn,
  a.pick_season,
  a.pick_round,
  a.faab_amount,
  CASE WHEN a.asset_kind <> 'player' OR a.player_uid IS NULL OR tx.week IS NULL THEN NULL ELSE (
    SELECT SUM(COALESCE(pw.points_provider, pw.points_recomputed))
      FROM fantasy_player_week_points pw
     WHERE pw.platform   = a.platform
       AND pw.league_key = a.league_key
       AND pw.season     = a.season
       AND pw.player_uid = a.player_uid
       AND pw.week       < tx.week) END                   AS points_before_trade,
  CASE WHEN a.asset_kind <> 'player' OR a.player_uid IS NULL OR tx.week IS NULL THEN NULL ELSE (
    SELECT SUM(COALESCE(pw.points_provider, pw.points_recomputed))
      FROM fantasy_player_week_points pw
     WHERE pw.platform   = a.platform
       AND pw.league_key = a.league_key
       AND pw.season     = a.season
       AND pw.player_uid = a.player_uid
       AND pw.week       >= tx.week) END                  AS rest_of_season_points,
  CASE WHEN a.asset_kind <> 'player' OR a.player_uid IS NULL OR tx.week IS NULL
            OR a.destination_team_key IS NULL THEN NULL ELSE (
    SELECT SUM(COALESCE(pw.points_provider, pw.points_recomputed))
      FROM fantasy_roster_snapshots rs
      JOIN fantasy_player_week_points pw
        ON pw.platform   = rs.platform
       AND pw.league_key = rs.league_key
       AND pw.season     = rs.season
       AND pw.week       = rs.week
       AND pw.player_uid = rs.player_uid
     WHERE rs.platform   = a.platform
       AND rs.league_key = a.league_key
       AND rs.season     = a.season
       AND rs.player_uid = a.player_uid
       AND rs.team_key   = a.destination_team_key
       AND rs.week       >= tx.week) END                  AS ros_points_rostered_by_receiver,
  CASE WHEN a.asset_kind <> 'player' OR a.player_uid IS NULL OR tx.week IS NULL
            OR a.destination_team_key IS NULL THEN NULL ELSE (
    SELECT SUM(COALESCE(pw.points_provider, pw.points_recomputed))
      FROM fantasy_roster_snapshots rs
      JOIN fantasy_player_week_points pw
        ON pw.platform   = rs.platform
       AND pw.league_key = rs.league_key
       AND pw.season     = rs.season
       AND pw.week       = rs.week
       AND pw.player_uid = rs.player_uid
     WHERE rs.platform   = a.platform
       AND rs.league_key = a.league_key
       AND rs.season     = a.season
       AND rs.player_uid = a.player_uid
       AND rs.team_key   = a.destination_team_key
       AND rs.week       >= tx.week
       AND rs.is_starter = 1) END                         AS ros_points_started_by_receiver,
  CASE WHEN a.asset_kind <> 'player' OR a.player_uid IS NULL OR tx.week IS NULL
            OR a.destination_team_key IS NULL THEN NULL ELSE (
    SELECT COUNT(*)
      FROM fantasy_roster_snapshots rs
     WHERE rs.platform   = a.platform
       AND rs.league_key = a.league_key
       AND rs.season     = a.season
       AND rs.player_uid = a.player_uid
       AND rs.team_key   = a.destination_team_key
       AND rs.week       >= tx.week
       AND rs.is_starter = 1) END                         AS ros_weeks_started_by_receiver
FROM fantasy_transaction_assets a
JOIN fantasy_transactions tx
  ON tx.platform        = a.platform
 AND tx.transaction_key = a.transaction_key
 AND tx.league_key      = a.league_key
 AND tx.season          = a.season
LEFT JOIN fantasy_players p
       ON p.platform   = a.platform
      AND p.player_uid = a.player_uid
LEFT JOIN fantasy_teams ft
       ON ft.platform   = a.platform
      AND ft.team_key   = a.source_team_key
      AND ft.league_key = a.league_key
      AND ft.season     = a.season
LEFT JOIN fantasy_teams tt
       ON tt.platform   = a.platform
      AND tt.team_key   = a.destination_team_key
      AND tt.league_key = a.league_key
      AND tt.season     = a.season
WHERE LOWER(tx.transaction_type) LIKE '%trade%';


-- ─────────────────────────────────────────────────────────────────────────────
-- fantasy_v_all_play
--
-- QUESTION IT ANSWERS: "if this team had played EVERY other team this week, what
-- would its record be" — the schedule-independent measure of a week, and the
-- basis for any later luck analysis.
--
-- GRAIN: one row per (platform, league_key, season, week, team_key).
--
-- HOW IT IS COMPUTED. A self-join of team-week scores within the SAME
-- (platform, league_key, season, week), excluding the team itself. Every
-- comparison is inside one league-week by construction — there is no path by
-- which a 2019 score is compared to a 2024 one, or one league's to another's.
--
-- TEAM POINTS come from COALESCE(points_provider, points_from_starters), the
-- same stated-value preference used everywhere else, with team_points_source
-- naming which one was used. It is a preference between two stated numbers, not
-- a NULL→0 fill.
--
-- ⚠️ AN UNKNOWN SCORE IS NOT A LOSS. A team-week with NULL points still gets a
-- row (dropping it would make a team silently vanish from a week), but it wins
-- and loses nothing: every comparison involving a NULL on either side is counted
-- in comparisons_skipped_unknown_points instead, and all_play_win_pct is NULL
-- when nothing was comparable. A 0-0-0 all-play record with a non-zero skip
-- count means "we could not tell", not "they lost to everyone".
--
-- COLUMNS:
--   all_play_wins / losses / ties      versus every other team in that week
--   all_play_win_pct                   (wins + 0.5*ties) / comparable games;
--                                      NULL when nothing was comparable
--   opponents_in_week                  how many other teams had a row at all
--   head_to_head_result                what ACTUALLY happened that week, from
--                                      fantasy_matchups ('win'|'loss'|'tie', or
--                                      NULL when undecided/not captured). The
--                                      gap between this and all_play_win_pct is
--                                      where a luck metric would come from — this
--                                      view deliberately stops short of computing
--                                      one.
--   is_playoff / is_consolation / is_championship
--                                      from fantasy_schedule_periods, so
--                                      postseason weeks can be excluded. All-play
--                                      over a 4-team playoff bracket is not a
--                                      comparable number and this view does not
--                                      pretend otherwise — it hands you the flag.
--
-- CAVEATS:
--   * team_week_score_is_derived comes through from fantasy_team_week_scores. A
--     derived team score feeding an all-play record makes the all-play record
--     derived too.
--   * Ties are half a win here. That is a convention, stated so it can be
--     disagreed with — the raw counts are projected so any other convention can
--     be computed from this view without modifying it.
CREATE VIEW IF NOT EXISTS fantasy_v_all_play AS
WITH tw AS (
  SELECT
    s.platform,
    s.league_key,
    s.season,
    s.week,
    s.team_key,
    COALESCE(s.points_provider, s.points_from_starters)  AS team_points,
    CASE WHEN s.points_provider      IS NOT NULL THEN 'provider'
         WHEN s.points_from_starters IS NOT NULL THEN 'recomputed_from_starters'
         ELSE NULL
    END                                                  AS team_points_source,
    s.is_derived,
    s.scores_reconciled
  FROM fantasy_team_week_scores s
),
cmp AS (
  SELECT
    a.platform,
    a.league_key,
    a.season,
    a.week,
    a.team_key,
    a.team_points,
    a.team_points_source,
    a.is_derived                                         AS team_week_score_is_derived,
    a.scores_reconciled,
    SUM(CASE WHEN a.team_points IS NOT NULL AND b.team_points IS NOT NULL
                  AND a.team_points > b.team_points THEN 1 ELSE 0 END)
                                                         AS all_play_wins,
    SUM(CASE WHEN a.team_points IS NOT NULL AND b.team_points IS NOT NULL
                  AND a.team_points < b.team_points THEN 1 ELSE 0 END)
                                                         AS all_play_losses,
    SUM(CASE WHEN a.team_points IS NOT NULL AND b.team_points IS NOT NULL
                  AND a.team_points = b.team_points THEN 1 ELSE 0 END)
                                                         AS all_play_ties,
    SUM(CASE WHEN b.team_key IS NOT NULL
                  AND (a.team_points IS NULL OR b.team_points IS NULL)
             THEN 1 ELSE 0 END)                          AS comparisons_skipped_unknown_points,
    COUNT(b.team_key)                                    AS opponents_in_week
  FROM tw a
  LEFT JOIN tw b
         ON b.platform   = a.platform
        AND b.league_key = a.league_key
        AND b.season     = a.season
        AND b.week       = a.week
        AND b.team_key  <> a.team_key
  GROUP BY a.platform, a.league_key, a.season, a.week, a.team_key,
           a.team_points, a.team_points_source, a.is_derived, a.scores_reconciled
)
SELECT
  cmp.platform,
  cmp.league_key,
  cmp.season,
  cmp.week,
  cmp.team_key,
  t.team_name,
  cmp.team_points,
  cmp.team_points_source,
  cmp.team_week_score_is_derived,
  cmp.scores_reconciled,
  cmp.all_play_wins,
  cmp.all_play_losses,
  cmp.all_play_ties,
  cmp.comparisons_skipped_unknown_points,
  cmp.opponents_in_week,
  CASE WHEN (cmp.all_play_wins + cmp.all_play_losses + cmp.all_play_ties) = 0
       THEN NULL
       ELSE (cmp.all_play_wins + 0.5 * cmp.all_play_ties) * 1.0
            / (cmp.all_play_wins + cmp.all_play_losses + cmp.all_play_ties)
  END                                                    AS all_play_win_pct,
  (SELECT CASE WHEN m.is_tied = 1                     THEN 'tie'
               WHEN m.winner_team_key IS NULL         THEN NULL
               WHEN m.winner_team_key = cmp.team_key  THEN 'win'
               ELSE 'loss'
          END
     FROM fantasy_matchups m
    WHERE m.platform   = cmp.platform
      AND m.league_key = cmp.league_key
      AND m.season     = cmp.season
      AND m.week       = cmp.week
      AND (m.team_a_key = cmp.team_key OR m.team_b_key = cmp.team_key)
    LIMIT 1)                                             AS head_to_head_result,
  sp.is_playoff,
  sp.is_consolation,
  sp.is_championship
FROM cmp
LEFT JOIN fantasy_teams t
       ON t.platform   = cmp.platform
      AND t.team_key   = cmp.team_key
      AND t.league_key = cmp.league_key
      AND t.season     = cmp.season
LEFT JOIN fantasy_schedule_periods sp
       ON sp.platform   = cmp.platform
      AND sp.league_key = cmp.league_key
      AND sp.season     = cmp.season
      AND sp.week       = cmp.week;


-- ─────────────────────────────────────────────────────────────────────────────
-- VERIFY (run each after applying; 0 rows is the correct result on an empty DB,
-- a SQL error is not):
--
--   SELECT name FROM sqlite_master WHERE type = 'view' ORDER BY name
--   SELECT * FROM yahoo_draft_results            LIMIT 1
--   SELECT * FROM yahoo_transactions             LIMIT 1
--   SELECT * FROM yahoo_weekly_rosters           LIMIT 1
--   SELECT * FROM yahoo_player_week_points       LIMIT 1
--   SELECT * FROM yahoo_team_seasons             LIMIT 1
--   SELECT * FROM fantasy_v_draft_value          LIMIT 1
--   SELECT * FROM fantasy_v_roster_construction  LIMIT 1
--   SELECT * FROM fantasy_v_bench_points         LIMIT 1
--   SELECT * FROM fantasy_v_waiver_value         LIMIT 1
--   SELECT * FROM fantasy_v_trade_ledger         LIMIT 1
--   SELECT * FROM fantasy_v_all_play             LIMIT 1
