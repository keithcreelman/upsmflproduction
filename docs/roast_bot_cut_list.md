# Roast Bot — Cut List

Tracking what we removed from the trade-roast context payload + what got cut from the Discord post structure, so we can revive any of it if we change our minds. Decision log, not a TODO list.

**Last updated:** 2026-05-22

---

## Guiding principle

Keith 2026-05-22: **"Categorical facts only, not derived calcs. Have some numbers to support. Ground the assessments based on value at the time of the trade."**

That cuts most model-output fields (Exp$, projected PPG, derived "trade values", quality scores, etc.) from the payload the LLM sees. The model outputs stay computed (so other consumers can use them and so we can restore them), they just don't get fed into the prompt.

---

## Cuts from the context payload

| Field | File path | Was a | Cut because | Restore by |
|---|---|---|---|---|
| `expected_auction_price` per player | [trade_roast_context.py:214](../pipelines/etl/scripts/trade_roast_context.py:214) | Derived $ (from `trade_value_model_2026.json` `auction_value_50`) | Dollar-heavy. Replaced by categorical `player_tier` (Smash/Hit/Contrib/Bust). | Re-add `"expected_auction_price"` to `player_detail()` return dict. |
| `expected_ppg` per player | [trade_roast_context.py:216](../pipelines/etl/scripts/trade_roast_context.py:216) | Derived projection (`_project_ppg` weighted-3yr × age curve) | Forward projection, not historical fact. Replaced with historical PPG + categorical tier. | Re-add `"ppg": round(p.expected_ppg, 1)` to `player_detail()`. |
| `trade_value` per player | [trade_roast_context.py:217](../pipelines/etl/scripts/trade_roast_context.py:217) | Derived (model output) | Opaque scalar. | Re-add `"trade_value"` field. |
| `quality_score` per player | [trade_roast_context.py:218](../pipelines/etl/scripts/trade_roast_context.py:218) | Derived (model output) | Opaque scalar. | Re-add `"quality_score"` field. |
| `pick.estimated_value` | [trade_roast_context.py:238,242,252,256](../pipelines/etl/scripts/trade_roast_context.py:238) | Derived ($-equivalent for pick) | Replaced by categorical slot label (Top R1 / Mid R1 / End R1 / Early R2 / Late R2 / R3+). | Re-add `"value": pk.estimated_value` to pick dict. |
| `extension_projections` (year-by-year $) | [trade_roast_context.py:264, 327-337](../pipelines/etl/scripts/trade_roast_context.py:264) | Derived forward $-by-year | Calculator output. Replaced by prompt-level acknowledgment ("comes with a 2yr extension"). | Re-enable the `if extension_years > 0` block + the EXTENSION PROJECTIONS section in `context_to_prompt_text`. |
| `tier`, `needs` from `team_summary` | [trade_roast_context.py:140, 145](../pipelines/etl/scripts/trade_roast_context.py:140) | Derived classifier output | Trust pending. | Restore as soon as we validate the classifier. |
| `auction_style`, `deal_rate`, `avg_value_delta`, `picks_traded_away`, `r1_away`, `position_targeting` | [trade_roast_context.py:130-137](../pipelines/etl/scripts/trade_roast_context.py:130) | Derived from historical auction transactions | Kept on hold per Keith — wants to understand the calc first. | Restore as categorical owner-tendency labels (Chronic overpayer / Market-rate / Bargain hunter) once `avg_value_delta` calc is understood. |
| `auction_comparables` top-6 (name + Exp$ + PPG) | [trade_roast_context.py:190-194, 340-345](../pipelines/etl/scripts/trade_roast_context.py:190) | Derived | Replaced by tier counts (`tier_above_count`, `same_tier_count`, `tier_below_count`) — never names, never dollars. | Restore the `find_comparables` call + AUCTION ALTERNATIVES section. |

## Kept per Keith 2026-05-22

| Field | Why kept |
|---|---|
| `grade`, `grade_score` per side | Keith: "for now we keep the grade score." Reverted earlier proposal to cut. |
| Player `salary` at trade time | FACT. Load-bearing for any roast about cost. |
| Player `contract_info`, `contract_status`, `contract_year` | FACTs. Canon vocabulary (FL/BL/WW/Tag/Rookie/Veteran). |
| TCV (frozen at signing) | FACT. |
| Pick `year`, `round` | FACTs. |
| Budget Bucks traded | FACT. |
| Owner career W-L, championships, playoff appearances, finishes | FACTs. Owner-tenure only. |
| Per-season trend | FACT (per-year allplay + finish). |
| Cap space, post-trade salary | FACT (current state). |
| H2H W-L | FACT — but cut from the embed in favor of trade-counter (see below). Still in the payload. |

---

## Cuts from the Discord post structure

| Element | Where | Cut because | Restore by |
|---|---|---|---|
| ASCII code-block intelligence report (Message 2 of legacy 3-message sequence) | [trade_roast_bot.py:108-115](../pipelines/etl/scripts/trade_roast_bot.py:108) | Dollar-bombed the channel. Replaced by cap-penalty-style embed + threaded roast reply. | Restore `build_report_block` + the code-block send. |
| "Owners" field (records of both owners) inside the trade embed | proposed embed structure | Not needed for trades (Keith). Replaced by trade-counter (lifetime owner-vs-owner, trade-of-the-season, etc.). | Restore as an embed field for non-trade activities (e.g. matchup recaps). |
| H2H W-L in the trade embed | proposed embed structure | Same — replaced by trade-counter. | Restore for matchup posts. |
| Tier-Elite / Star / Starter / Depth / Dart-throw labels (my proposal) | never shipped | Keith pointed at the league's existing **Smash / Hit / Contributor / Bust** methodology ([site/rookies/rookie_draft_tiers.json](../site/rookies/rookie_draft_tiers.json)) which is better-defined and league-canonical. | n/a — adopted Keith's instead. |

---

## How to restore

For each cut field above, the "Restore by" column gives the exact change. Restoration is **additive** — no field was deleted from the underlying model, just from the payload sent to the LLM. The trade value model + auction pool CSVs still compute everything; we just stopped feeding them in.

If a restored field shouldn't go BACK into the LLM prompt but should appear elsewhere (e.g. a debug-only "show me the numbers" command, or a separate model-driven verdict alongside the roast), implement it as a separate Discord post or admin endpoint.

---

## Related docs

- [docs/generic_gif_fallback_rollout.md](generic_gif_fallback_rollout.md) — sibling cut/keep doc for the GIF fallback rollout across activities
- [pipelines/etl/config/trade_exclusions.json](../pipelines/etl/config/trade_exclusions.json) — trade-counter exclusion rules (dispersals, reversals)
