# League Record S1: 2014 pick 4.12 selector conflict (investigation record, not resolved)

**Status:** open. Local, read-only, from the committed archive only. Franchise ids only. This is **a different record** from the 2018 pick 4.12 forfeiture: the 2018 commissioner clarification says nothing about 2014 and is not used here. The conflict stays a conflict on a SELECTED slot until a source decides it.

## The two records that disagree

| | Record | Says |
|---|---|---|
| Chain | `trade2014_4`, 2014-05-06 09:57:54 ET (a commissioner-processed trade; 32 of the 34 pre-draft 2014 trades carry the same flag, so it does not set this trade apart) | 0008 sent token `DP_3_11` (zero-indexed: round 4, slot 12) to 0004. The same trade moved `DP_3_9` (4.10) and `DP_4_4` (5.05) from 0008 to 0004, and `DP_2_5` (3.06) from 0004 to 0008. |
| Draft result | legacy draft table, 2014-06-15 22:07:20 ET, pick 4.12 (overall 48) | franchise 0006 made the selection (Calvin Pryor). No comment on the row. |

No later recorded transfer of the 4.12 token exists, so the chain leaves 0004 holding the slot at the selection and the draft result names 0006.

## Facts checked (all from the archive, none from a finish, standing, bracket or projected order)

1. **The same trade's other two picks reconcile.** 4.10 went 0008 to 0004 to 0001 (`trade2014_14`) to 0011 (`trade2014_37`) and the draft result names 0011. 5.05 went 0008 to 0004 to 0006 (`trade2014_24`) and the draft result names 0006. So the trade's franchise ids and its zero-indexed token mapping hold for two of its three picks; only 4.12 disagrees.
2. **No other pre-draft trade moves a 2014 round 4 pick between 0004 and 0006.** The trades between them before the draft (`trade2014_16`, `_24`, `_34`) carry a round 2 slot, a round 5 slot, 2015 future picks and players. `trade2014_45` is dated 2014-07-05, after the draft.
3. **The franchise name on the draft row matches its id.** In every legacy draft row the name equals the name the archive's franchise list gives that id for the season (0 disagreements). A name-to-id mix-up between 0004 and 0006 is therefore not supported.
4. **0004 made no selection in the 2014 draft at all** (0 of 60 rows), while the chains show it acquiring five 2014 slot tokens and sending six. 0006 made seven selections. (Two 2014 rows record no franchise id; the franchise name on both is 0002's, so they do not hide a 0004 selection.)
5. **The draft row has no comment.** Two other 2014 rows carry "Timer Expired Replacement pick made by Commissioner" (3.02 by 0006 and 4.06 by 0011); this one does not.
6. The rookie-contract view lists the pick under 0006 with salary 2000, but it is built from the same draft result, so it is not independent evidence.

## Candidate explanations (none proven; none chosen)

- **A.** A transfer of 4.12 from 0004 to 0006 between 2014-05-06 and the draft that the archive does not record.
- **B.** 0006 made the selection on behalf of 0004 (a draft result names the franchise that made the pick, which can differ from the holder; canon T1.8).
- **C.** The franchise recorded on that one draft row is wrong.
- **D.** The trade's `DP_3_11` is not slot 4.12 (the weakest reading, because the same trade's other two tokens reconcile).

## What would settle it (nothing queried; each needs approval)

1. MFL's 2014 draft results export (the franchise MFL itself stores on pick 4.12, with any comment).
2. MFL's 2014 transactions export for May to June 2014 (an unrecorded transfer or pick reassignment; whether commissioner-processed trades list all slot moves).
3. 0004's post-draft roster or contract record for the player (the archive's weekly roster record does not exist for 2014).
4. The league's own draft-day record for 2014, if one is kept.

## Handling in the extraction

The conflict stays a `conflict` in the slot-pick counts (CONFIRMED 439 of 451, conflict 1) and its draft slot stays SELECTED with the recorded selection and selector. Nothing assigns the pick to either franchise. Any decision belongs to the commissioner with one of the sources above.
