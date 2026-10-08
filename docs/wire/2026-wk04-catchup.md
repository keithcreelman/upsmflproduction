# Week 4 UPS Center: catch-up procedure and verified preview

Prepared Thu Oct 8, 2026. **Nothing here has been published or sent.**

## What happened

Week 4 was never generated, so nothing was withheld. Nothing schedules UPS Center: there is no GitHub workflow, launchd job, Claude scheduled task or cloud routine for it. Weeks 1–3 were each built and published from a Claude session:
- Week 1 went live Thu Sep 17.
- Week 2 went live Thu Sep 24.
- Week 3 went live Wed Sep 30 at 9:42 AM ET and was announced at 9:46 AM ET.

No session was started for Week 4, and no transcript mentions `2026-wk04-recap` or "UPS Center: Week 4". `ups_center_due.py` (this PR) now detects that gap.

Checked Thu Oct 8 (`ups_center_due.py preflight --season 2026 --week 4`): **no Week 4 issue exists anywhere.**
- The repo index and the live Pages index have no entry. The index was last generated Sep 30.
- `articles/2026/2026-wk04-ups-center.html` returns 404 on Pages.
- `ups_wire_threads` has no row.
- #league-announcements has no post; the latest is Week 3's, Sep 30 at 9:46 AM ET.
- No Week 4 files exist on any branch or worktree.

## Inputs that are not ready, with evidence

1. **D1 Week 4 scores are pre-Elias.** This is the All-Play issue, PR #1190.
   - Elias posted Week 4 changes Wed Oct 7 at 11:32 PM ET, and MFL applied them.
   - D1 still has Tuesday's sync, so a pack built now would publish Martel 251.2 and Martel/Blake all-play 35-9 / 31-13 instead of 250.2 and 34-10 / 32-12.
   - **Repair D1 first.**
2. **Most Week 4 projections were overwritten after the games.**
   - 1,010 of 1,106 `ups_player_projections` rows were re-stamped Wed Oct 7 at about 18:00Z by the known Wednesday ingest bug.
   - No `projection_evidence_2026_wk04.json` freeze exists, and the Sep 30 raw export is gone. The preview inputs file holds model-adjusted values, not MFL's projections.
   - Only rows captured before each player's own kickoff are usable: 54 from Fri Oct 2 17:47Z, and 42 from Sun Oct 4 at about 18:00Z, which are valid only for late games.
   - The projection-based bust/bargain section must grade only those players or be dropped. Opportunity (xFP) comparisons are unaffected.
3. **The chat archive is not current.** Week 4 has 23 owner posts archived, ending Tue Oct 6 at 12:56 PM ET. Run the ingest before any Coffee Shop segment.
4. **The Week 5 preview goes stale tonight.** Week 5 kicks off Thu Oct 8 at 8:15 PM ET (TB–DAL).
   - A forecast and preview must be cut before then, or the issue ships without a Week 5 preview.
   - Week 5 has no `ups_player_projections` rows, because the Wednesday ingest wrote to Week 4 instead.

Separate item: **Week 3's Elias corrections were never applied to the published Week 3 article.** They posted Wed Sep 30 at 10:25 PM ET. Five team scores moved, no result flipped and no All-Play record changed, so under the standing rule the correction is published but no league message is needed.

| Team | Published | Elias-corrected | Change |
|---|---|---|---|
| Ryan Bousquet | 208.6 | 207.1 | -1.5 |
| Brian Cutting | 212.4 | 212.9 | +0.5 |
| Brian Cross | 204.7 | 205.2 | +0.5 |
| Shawn Blake | 245.4 | 245.9 | +0.5 |
| Chris Klingenberg | 227.5 | 227.0 | -0.5 |

The article's figures that change:
- Keith beat Cutting by 6.5, now 6.0.
- Ryan beat Cross by 3.9, now 1.9.
- Blake lost to Bear by 9.4, now 8.9.

## Catch-up procedure (one time, in order)

1. **Confirm the plan with Keith:** before or after tonight's 8:15 PM ET kickoff, the bust/bargain scope (item 2), and the publish order.
2. **Duplicate guard.** Run `python3 pipelines/etl/wire/ups_center_due.py preflight --season 2026 --week 4`. It must print `No 2026-wk04-ups-center anywhere checked.` and exit 0. If it finds anything, **stop**.
3. **Repair D1** using PR #1190's steps: standings `--standings-only` (dry run first), weekly scores `--weeks 4`, then verify 34-10 / 32-12 in D1 and `/api/standings`.
4. **Chat:** `python3 pipelines/etl/scripts/ingest_discord_chat.py --incremental --dry-run`, then run it without `--dry-run`.
5. **Week 5 preview, before kickoff only:** `week_preview.py --season 2026 --week 5 --live-cache <dir> --out <scratch>`, then move it into place deliberately, as on Sep 30.
6. **Pack:**
   - `python3 pipelines/etl/wire/wire.py build --pack 2026-wk04-recap`. The build freezes `scores_published_2026_wk04.json` from the corrected scores.
   - `python3 pipelines/etl/wire/elias.py check --season 2026 --week 4` records that the published numbers already include the 13 Week 4 corrections.
   - Run `wire.py check-pack --pack 2026-wk04-recap`.
7. **Article:** hand-build `site/wire/articles/2026/2026-wk04-ups-center.html` in the Weeks 1–3 format, as `status: draft`, on a branch.
   - Run `wire.py index` and `wire.py verify`.
   - Trace every number to the pack and every quote to its message id.
   - Keith reads it.
8. **Publish, on Keith's explicit go:**
   - Rerun preflight; it must still be clean.
   - Set `status: live` and `publishedAt`, run `wire.py index` and `wire.py verify`, then squash-merge.
   - Confirm the live page is byte-identical to the merged file.
9. **Announce, once:**
   - Run `python3 pipelines/etl/wire/ups_center_due.py preflight --season 2026 --week 4 --stage announce`. It must say the issue is live and not yet announced. **Stop** if it finds a `ups_wire_threads` row or a post.
   - Post one message, then add the `wire_reply:<id>` button, open the thread, and insert one `ups_wire_threads` row, as for Week 3.
10. **Week 3 correction (separate PR):** run `elias.py check --season 2026 --week 3`, add the Elias section and corrected figures to the live Week 3 article, and publish. **No league message:** All-Play didn't change.

## Verified preview: Week 4 statistics

Source: MFL `weeklyResults` W=4, `leagueStandings` and `players`, fetched 2026-10-08T12:54:43Z. Elias's Week 4 corrections (Wed Oct 7 11:32:16 p.m. ET 2026, 13 lines) are already applied, so these scores are Elias-final.

**Results** (each team played both division rivals)

| Team | Score | Opponent | Score | Result |
|---|---|---|---|---|
| Matt Gerardi | 208.3 | Derrick Whitman | 214.5 | Derrick Whitman by 6.2 |
| Matt Gerardi | 208.3 | Shawn Blake | 250.9 | Shawn Blake by 42.6 |
| Derrick Whitman | 214.5 | Shawn Blake | 250.9 | Shawn Blake by 36.4 |
| Eric Martel | 250.2 | Brian Cutting | 211.6 | Eric Martel by 38.6 |
| Eric Martel | 250.2 | Brian Cross | 181.4 | Eric Martel by 68.8 |
| Brian Cutting | 211.6 | Brian Cross | 181.4 | Brian Cutting by 30.2 |
| Keith Creelman | 206.3 | Josh Martel | 194.3 | Keith Creelman by 12.0 |
| Keith Creelman | 206.3 | Ryan Bousquet | 216.0 | Ryan Bousquet by 9.7 |
| Josh Martel | 194.3 | Ryan Bousquet | 216.0 | Ryan Bousquet by 21.7 |
| Bear Dunn | 289.9 | Chris Klingenberg | 223.9 | Bear Dunn by 66.0 |
| Bear Dunn | 289.9 | Eric Mannila | 294.7 | Eric Mannila by 4.8 |
| Chris Klingenberg | 223.9 | Eric Mannila | 294.7 | Eric Mannila by 70.8 |

**Week 4 All-Play**

| Team | Score | All-Play |
|---|---|---|
| Eric Mannila | 294.7 | 11-0 |
| Bear Dunn | 289.9 | 10-1 |
| Shawn Blake | 250.9 | 9-2 |
| Eric Martel | 250.2 | 8-3 |
| Chris Klingenberg | 223.9 | 7-4 |
| Ryan Bousquet | 216.0 | 6-5 |
| Derrick Whitman | 214.5 | 5-6 |
| Brian Cutting | 211.6 | 4-7 |
| Matt Gerardi | 208.3 | 3-8 |
| Keith Creelman | 206.3 | 2-9 |
| Josh Martel | 194.3 | 1-10 |
| Brian Cross | 181.4 | 0-11 |

**Standings after Week 4** (MFL's own `leagueStandings`)

| Team | H2H | All-Play W-L-T | All-Play % | PF |
|---|---|---|---|---|
| Bear Dunn | 8-2 | 34-10-0 | 0.773 | 1016.8 |
| Eric Martel | 8-2 | 34-10-0 | 0.773 | 996.5 |
| Shawn Blake | 7-3 | 32-12-0 | 0.727 | 981.0 |
| Derrick Whitman | 6-4 | 27-17-0 | 0.614 | 894.8 |
| Chris Klingenberg | 5-5 | 25-19-0 | 0.568 | 840.7 |
| Brian Cutting | 4-6 | 22-22-0 | 0.500 | 882.6 |
| Eric Mannila | 6-4 | 22-22-0 | 0.500 | 879.0 |
| Keith Creelman | 6-4 | 22-22-0 | 0.500 | 873.3 |
| Matt Gerardi | 3-7 | 16-28-0 | 0.364 | 800.8 |
| Ryan Bousquet | 4-6 | 13-31-0 | 0.295 | 768.9 |
| Josh Martel | 2-8 | 9-35-0 | 0.205 | 760.2 |
| Brian Cross | 1-9 | 8-36-0 | 0.182 | 784.6 |

**Top 10 starter scores**

| Player | Pos / NFL | Owner | UPS pts |
|---|---|---|---|
| McMillan, Tetairoa | WR CAR | Bear Dunn | 49.8 |
| Lamb, CeeDee | WR DAL | Eric Mannila | 46.5 |
| Williams, Kyren | RB LAR | Chris Klingenberg | 37.5 |
| Walker III, Kenneth | RB KCC | Eric Martel | 33.9 |
| Collins, Nico | WR HOU | Derrick Whitman | 33.8 |
| Burrow, Joe | QB CIN | Bear Dunn | 31.9 |
| Williams, Javonte | RB DAL | Eric Martel | 31.5 |
| Cousins, Kirk | QB LVR | Eric Mannila | 31.4 |
| Higgins, Tee | WR CIN | Bear Dunn | 31.3 |
| Nacua, Puka | WR LAR | Keith Creelman | 30.9 |

**Week 4 Elias effects:**
- Gerardi +1.3 (Chuck Clark, +1 tackle).
- Cutting −0.5 (Daiyan Henley, a tackle reclassified as an assist).
- Martel −1.0 (Jack Campbell, −1 tackle).
- Klingenberg −0.8 (Javon Bullard, −1 assist).

No result flipped. Week 4 All-Play changed for two teams: Blake 8-3 → 9-2 and Martel 9-2 → 8-3. Under the standing rule (message the league when an Elias change moves All-Play), that warrants a league message, because the league's standings pages have shown the pre-correction 35-9 / 31-13 since Tuesday. **Not sent.** Keith decides whether it goes out on its own after the D1 repair or as a line in the Week 4 issue.
