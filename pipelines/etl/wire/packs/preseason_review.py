#!/usr/bin/env python3
"""Pre-Season Review data pack. Deterministic; no language model.

Answers the three questions Keith framed the report around, per team:
  1. where they started   -- the earliest daily snapshot we have
  2. what they did        -- contract activity, the auction, the draft, trades, cuts
  3. where they landed    -- the live compliance route

Plus the league-wide auction breakdown.

EVERY number here is attributed to an OWNER via src_franchises on
(season, franchise_id). Franchise ids are not a stable owner lineage in this
league and never have been.
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import wire_data as D                                    # noqa: E402
from wire_pack import Pack, fmt_usd                       # noqa: E402

SEASON = 2026
PACK_ID = "2026-preseason-review"

# Contract-activity types, in the order a reader meets them in the off-season.
MOVE_TYPES = ["Extension", "Multi-Year Contract", "MYM", "Restructure", "Tag", "FA Contract"]


def distinct_outcomes(rows):
    """Collapse a SUBMISSION log into contract OUTCOMES.

    contract_activity is a log of submissions, not of contracts. An owner who
    revises a deal in the Front Office UI writes a row per attempt: one player
    here has seven rows across seven hours on the same day, alternating between
    a one-year and a two-year shape. Those are seven real submission events and
    ONE contract.

    Counting rows and calling them "moves" therefore overstates activity for
    whoever iterates most -- which is the commissioner, who lives in the tool.
    It made him look roughly twice as busy as everyone else. Keep the last
    submission per (franchise, player, type); that is the outcome that stuck.
    """
    best = {}
    for r in rows:
        key = (r.get("franchise_id"), str(r.get("player_id")), r.get("activity_type"))
        stamp = r.get("submitted_at_utc") or ""
        if key not in best or stamp > (best[key].get("submitted_at_utc") or ""):
            best[key] = r
    return [best[k] for k in sorted(best, key=lambda k: tuple(str(x) for x in k))]


def build(pack_id=None):
    # pack_id accepted for interface parity with weekly_recap.build(pack_id),
    # which needs it to parse (season, week); this builder is single-purpose
    # and ignores it.
    pack = Pack(PACK_ID, SEASON, title="The 2026 Pre-Season Review")

    # ---------------------------------------------------------- attribution
    # Prove the attribution path before using it. Crediting the wrong owner for
    # a season is the worst error this project can make and the one that reads
    # most authoritatively, so it is a build-stopper, not a warning.
    drift = D.check_attribution()
    if drift:
        raise D.DataError("owner attribution disagrees with the commish ruling:\n  "
                          + "\n  ".join(drift))

    owners = D.owner_map(SEASON)
    pack.source("src_franchises", asof="%d season" % SEASON, rows=len(owners),
                note="authoritative (season, franchise_id) -> owner map; verified against "
                     "/api/standings on all %d contested seasons" % len(D.ATTRIBUTION_FIXTURES))
    for fid in sorted(owners):
        name = owners[fid]["owner_name"]
        key = D.owner_key(name)
        pack.owner(key, name)
        pack.franchise(SEASON, fid, key, owners[fid]["team_name"])

    def who(fid):
        return owners.get(fid, {}).get("owner_name") or ("Franchise %s" % fid)

    # ------------------------------------------------------ where they began
    snaps = D.snapshot_dates()
    if not snaps:
        raise D.DataError("no daily snapshots on disk")
    opening_date = snaps[0]
    opening = D.roster_salaries(opening_date)
    pack.source("data/mfl-snapshots/%s/rosters.json" % opening_date, asof=opening_date,
                rows=sum(v["active_count"] + v["taxi_count"] for v in opening.values()),
                note="earliest snapshot available; active-roster salary only")

    # Two honest limits on the "starting point", both material to any claim
    # about how much room a team began with.
    pack.warn("The off-season opened around 2026-03-10 (first contract activity) but the "
              "earliest daily snapshot is %s, so 'starting point' means %s, not the true "
              "start of the off-season." % (opening_date, opening_date))
    pack.warn("Opening cap figures are active-roster salary only. The daily snapshot does not "
              "capture salaryAdjustments, so they are not comparable to the live compliance "
              "numbers, which do include them. Do not subtract one from the other.")

    # ------------------------------------------------------ where they are now
    comp = D.worker_get("/api/auction/compliance", YEAR=SEASON)
    now = dict((str(f["fid"]).zfill(4), f) for f in comp.get("franchises", []))
    pack.source("GET /api/auction/compliance", asof=comp.get("generated_at", "live"),
                rows=len(now), note="cap spent/room, roster counts, live warnings")

    # ------------------------------------------------------------- the auction
    won = [l for l in D.worker_get("/api/auction/lots", YEAR=SEASON, status="won").get("lots", [])
           if not l.get("is_test")]
    open_lots = [l for l in D.worker_get("/api/auction/lots", YEAR=SEASON, status="open").get("lots", [])
                 if not l.get("is_test")]
    pack.source("GET /api/auction/lots", asof="live", rows=len(won) + len(open_lots),
                note="%d won, %d still open" % (len(won), len(open_lots)))

    if open_lots:
        last_lock = max(int(l.get("locks_at_unix") or 0) for l in open_lots)
        import datetime
        when = datetime.datetime.fromtimestamp(last_lock, datetime.timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
        pack.warn("THE AUCTION IS NOT FINISHED. %d lot(s) are still open; the last one locks at "
                  "%s. Every auction figure here is a mid-flight snapshot and must be presented "
                  "as of a timestamp, not as a final result." % (len(open_lots), when))

    finals = D.d1("SELECT source, COUNT(*) AS n, SUM(won_bid_k) AS k "
                  "FROM ups_auction_contract_finalizations GROUP BY source ORDER BY source")
    finalized_n = sum(int(r["n"]) for r in finals)
    pack.source("ups_auction_contract_finalizations", asof="live", rows=finalized_n,
                note="; ".join("%s=%s" % (r["source"], r["n"]) for r in finals))
    if finalized_n != len(won):
        pack.warn("%d lots are marked won but only %d finalized contracts exist (delta %d). "
                  "Auction spend and contract counts will not reconcile; prefer the lot ledger "
                  "for prices and say so." % (len(won), finalized_n, len(won) - finalized_n))
    if not any(r["source"] == "era" for r in finals):
        pack.warn("No ERA-sourced finalizations exist, though ups_era_pool has members. The "
                  "expired-rookie auction is not represented in the finalization ledger.")

    # ------------------------------------------------------- what they did
    submissions, activity_provenance = D.contract_activity(str(SEASON))
    activity = distinct_outcomes(submissions)
    blank = sum(1 for r in activity if not r.get("franchise_name"))
    if len(submissions) != len(activity):
        pack.warn("The contract log records SUBMISSIONS, not contracts: %d rows collapse to %d "
                  "distinct player-contract outcomes. Owners who revise a deal in the Front "
                  "Office write a row per attempt, so a raw row count overstates how active "
                  "the heaviest tool users were. Move counts here are outcomes."
                  % (len(submissions), len(activity)))
    pack.source("contract_activity_%d.json" % SEASON,
                asof=max((r.get("submitted_at_utc") or "")[:10] for r in activity),
                rows=len(activity),
                note="%d submissions collapsed to %d contract outcomes; extensions, "
                     "multi-year, MYM, restructures, tags, FA contracts; read from %s"
                     % (len(submissions), len(activity), activity_provenance))

    # Repo-tracked data is written by GitHub Actions onto main, so a branch goes
    # stale just by existing. Say so rather than publish an old number silently.
    behind = D.commits_behind_main()
    if behind:
        pack.warn("This pack was built from a checkout %d commit(s) behind origin/main. "
                  "Repo-tracked sources (the contract-activity log, the daily snapshots) are "
                  "auto-committed to main, so the contract log was read from origin/main "
                  "directly; the daily snapshots were NOT and may lag by a few days." % behind)
    if blank:
        pack.warn("%d of %d contract outcomes have a blank franchise_name and player_name. "
                  "The ids are present, so names are resolved from src_franchises rather than "
                  "rendered blank." % (blank, len(activity)))

    picks = D.d1("SELECT franchise_id, COUNT(*) AS picks FROM src_draft_picks "
                 "WHERE season = %d GROUP BY franchise_id ORDER BY franchise_id" % SEASON)
    pack.source("src_draft_picks", asof="%d" % SEASON,
                rows=sum(int(p["picks"]) for p in picks), note="rookie draft")

    trades = D.d1("SELECT COUNT(*) AS n FROM ups_transactions "
                  "WHERE season = '%d' AND type = 'TRADE'" % SEASON)
    trade_count = int(trades[0]["n"]) if trades else 0
    pack.source("ups_transactions", asof="%d" % SEASON, rows=trade_count,
                note="type=TRADE only; src_trades stops at 2025")

    drops = D.d1("SELECT franchise_id, COUNT(*) AS n, SUM(COALESCE(penalty_amount,0)) AS penalty "
                 "FROM ups_drop_events WHERE season = '%d' GROUP BY franchise_id "
                 "ORDER BY franchise_id" % SEASON)
    pack.source("ups_drop_events", asof="%d" % SEASON,
                rows=sum(int(d["n"]) for d in drops), note="cuts and their cap penalties")

    # The structural gap every 2026 report has to live with.
    pack.warn("Nearly every src_* history table stops at 2025 (src_standings, src_trades, "
              "src_adddrop, src_contracts). All 2026 figures here come from ups_* tables, the "
              "live worker API, and the daily snapshots instead.")

    pack.coverage = {
        "seasonsComplete": [2010, 2025],
        "currentSeason": SEASON,
        "currentSeasonPartial": True,
        "auctionComplete": not open_lots,
        "openingSnapshot": opening_date,
    }

    # ------------------------------------------------------------ aggregate
    by_fid = {}
    for fid in sorted(owners):
        o = opening.get(fid, {"salary_total": 0, "active_count": 0, "taxi_count": 0})
        n = now.get(fid, {})
        w = [l for l in won if str(l.get("winner_fid") or "").zfill(4) == fid]
        acts = [r for r in activity if r.get("franchise_id") == fid]
        by_fid[fid] = {
            "owner": who(fid),
            "team": n.get("franchise_name") or owners[fid]["team_name"],
            "open_salary": o["salary_total"],
            "open_active": o["active_count"],
            "cap_spent": int(n.get("cap_spent_k", 0)) * 1000,
            "cap_room": int(n.get("cap_room_k", 0)) * 1000,
            "active": int(n.get("active_count", 0)),
            "taxi": int(n.get("taxi_count", 0)),
            "lots_won": len(w),
            "auction_spend": sum(int(l.get("current_high_bid_k") or 0) for l in w) * 1000,
            "top_buy": max([int(l.get("current_high_bid_k") or 0) for l in w] or [0]) * 1000,
            "moves": len(acts),
            "by_type": dict((t, sum(1 for r in acts if r.get("activity_type") == t))
                            for t in MOVE_TYPES),
            "fl": sum(1 for r in acts if str(r.get("contract_status") or "").endswith("-FL")),
            "bl": sum(1 for r in acts if str(r.get("contract_status") or "").endswith("-BL")),
            "picks": next((int(p["picks"]) for p in picks
                           if str(p["franchise_id"]).zfill(4) == fid), 0),
            "drops": next((int(d["n"]) for d in drops
                           if str(d["franchise_id"]).zfill(4) == fid), 0),
        }

    prices = sorted(int(l.get("current_high_bid_k") or 0) for l in won)
    total_spend = sum(prices) * 1000

    # ---------------------------------------------------------------- facts
    F = pack.fact
    lot_src, live = "GET /api/auction/lots", "live"
    F("f.auction.lots_won", "Lots won so far", len(won), "count", lot_src, live)
    F("f.auction.lots_open", "Lots still open", len(open_lots), "count", lot_src, live)
    F("f.auction.total_spend", "Total auction spend", total_spend, "usd", lot_src, live)
    F("f.auction.top_price", "Highest winning bid", (prices[-1] if prices else 0) * 1000,
      "usd", lot_src, live)
    F("f.auction.median_price", "Median winning bid",
      (prices[len(prices) // 2] if prices else 0) * 1000, "usd", lot_src, live)
    F("f.auction.min_price_lots", "Lots won at the $1K opening bid",
      sum(1 for p in prices if p <= 1), "count", lot_src, live)
    F("f.auction.total_bids", "Bids placed",
      sum(int(l.get("bid_count") or 0) for l in won + open_lots), "count", lot_src, live)
    F("f.auction.contested_lots", "Lots with more than one bidder",
      sum(1 for l in won if int(l.get("unique_bidder_count") or 0) > 1), "count", lot_src, live)
    F("f.auction.finalized_contracts", "Finalized auction contracts", finalized_n, "count",
      "ups_auction_contract_finalizations", live)

    rooms = sorted(v["cap_room"] for v in by_fid.values())
    F("f.cap.median_room", "Median cap room", rooms[len(rooms) // 2], "usd",
      "GET /api/auction/compliance", live)
    F("f.cap.tightest_room", "Least cap room", rooms[0], "usd",
      "GET /api/auction/compliance", live)
    F("f.cap.most_room", "Most cap room", rooms[-1], "usd",
      "GET /api/auction/compliance", live)
    F("f.cap.total_committed", "League-wide cap committed",
      sum(v["cap_spent"] for v in by_fid.values()), "usd", "GET /api/auction/compliance", live)

    F("f.moves.total", "Distinct contract outcomes", len(activity), "count",
      "contract_activity_%d.json" % SEASON, live)
    F("f.moves.submissions", "Contract submissions logged (includes revisions)",
      len(submissions), "count", "contract_activity_%d.json" % SEASON, live)
    for t in MOVE_TYPES:
        F("f.moves.%s" % t.lower().replace(" ", "_").replace("-", "_"),
          "%s count" % t, sum(1 for r in activity if r.get("activity_type") == t),
          "count", "contract_activity_%d.json" % SEASON, live)
    F("f.moves.front_loaded", "Front-loaded contracts", sum(v["fl"] for v in by_fid.values()),
      "count", "contract_activity_%d.json" % SEASON, live)
    F("f.moves.back_loaded", "Back-loaded contracts", sum(v["bl"] for v in by_fid.values()),
      "count", "contract_activity_%d.json" % SEASON, live)
    F("f.draft.picks", "Rookie draft picks made", sum(int(p["picks"]) for p in picks),
      "count", "src_draft_picks", "%d" % SEASON)
    F("f.trades.count", "Trades completed", trade_count, "count", "ups_transactions",
      "%d" % SEASON)
    F("f.drops.count", "Players cut", sum(v["drops"] for v in by_fid.values()), "count",
      "ups_drop_events", "%d" % SEASON)

    # Per-team facts, so per-team prose can cite a number without typing a digit.
    for fid in sorted(by_fid):
        v = by_fid[fid]
        for metric, label, value, unit in (
            ("auction_spend", "auction spend", v["auction_spend"], "usd"),
            ("lots_won", "lots won", v["lots_won"], "count"),
            ("cap_room", "cap room", v["cap_room"], "usd"),
            ("cap_spent", "cap committed", v["cap_spent"], "usd"),
            ("moves", "contract moves", v["moves"], "count"),
            ("active", "active roster size", v["active"], "count"),
        ):
            F("f.team.%s.%s" % (fid, metric), "%s -- %s" % (v["owner"], label),
              value, unit, "GET /api/auction/compliance + lots", live)

    # --------------------------------------------------------------- tables
    order = sorted(by_fid, key=lambda k: -by_fid[k]["cap_spent"])
    pack.table("t.cap_sheet", "Where the twelve stand",
               [{"key": "owner", "label": "Owner", "type": "text"},
                {"key": "team", "label": "Team", "type": "text"},
                {"key": "open_salary", "label": "Roster salary %s" % opening_date,
                 "type": "usd", "align": "right"},
                {"key": "cap_spent", "label": "Cap committed now", "type": "usd", "align": "right"},
                {"key": "cap_room", "label": "Room", "type": "usd", "align": "right"},
                {"key": "active", "label": "Active", "type": "count", "align": "right"},
                {"key": "taxi", "label": "Taxi", "type": "count", "align": "right"}],
               [[by_fid[f]["owner"], by_fid[f]["team"], by_fid[f]["open_salary"],
                 by_fid[f]["cap_spent"], by_fid[f]["cap_room"], by_fid[f]["active"],
                 by_fid[f]["taxi"]] for f in order],
               note="Opening column is active-roster salary only and excludes salaryAdjustments.")

    spend_order = sorted(by_fid, key=lambda k: -by_fid[k]["auction_spend"])
    pack.table("t.auction_by_team", "Auction spend by owner",
               [{"key": "owner", "label": "Owner", "type": "text"},
                {"key": "lots", "label": "Lots won", "type": "count", "align": "right"},
                {"key": "spend", "label": "Spent", "type": "usd", "align": "right"},
                {"key": "top", "label": "Top buy", "type": "usd", "align": "right"},
                {"key": "avg", "label": "Average", "type": "usd", "align": "right"}],
               [[by_fid[f]["owner"], by_fid[f]["lots_won"], by_fid[f]["auction_spend"],
                 by_fid[f]["top_buy"],
                 int(by_fid[f]["auction_spend"] / by_fid[f]["lots_won"]) if by_fid[f]["lots_won"] else 0]
                for f in spend_order])

    top = sorted(won, key=lambda l: -int(l.get("current_high_bid_k") or 0))[:15]
    pack.table("t.top_buys", "The fifteen most expensive players",
               [{"key": "player", "label": "Player", "type": "text"},
                {"key": "pos", "label": "Pos", "type": "text"},
                {"key": "owner", "label": "Won by", "type": "text"},
                {"key": "price", "label": "Price", "type": "usd", "align": "right"},
                {"key": "bids", "label": "Bids", "type": "count", "align": "right"},
                {"key": "bidders", "label": "Bidders", "type": "count", "align": "right"}],
               [[l.get("player_name") or ("player %s" % l.get("player_id")),
                 l.get("position") or "",
                 who(str(l.get("winner_fid") or "").zfill(4)),
                 int(l.get("current_high_bid_k") or 0) * 1000,
                 int(l.get("bid_count") or 0), int(l.get("unique_bidder_count") or 0)]
                for l in top])

    pack.table("t.moves_by_team", "What each team actually did",
               [{"key": "owner", "label": "Owner", "type": "text"}] +
               [{"key": t, "label": t, "type": "count", "align": "right"} for t in MOVE_TYPES] +
               [{"key": "fl", "label": "FL", "type": "count", "align": "right"},
                {"key": "bl", "label": "BL", "type": "count", "align": "right"},
                {"key": "picks", "label": "Picks", "type": "count", "align": "right"},
                {"key": "drops", "label": "Cuts", "type": "count", "align": "right"}],
               [[by_fid[f]["owner"]] + [by_fid[f]["by_type"][t] for t in MOVE_TYPES] +
                [by_fid[f]["fl"], by_fid[f]["bl"], by_fid[f]["picks"], by_fid[f]["drops"]]
                for f in sorted(by_fid, key=lambda k: -by_fid[k]["moves"])])

    # --------------------------------------------------------------- charts
    pack.chart("c.auction_spend", "hbar", "Auction spend by owner",
               [{"label": by_fid[f]["owner"], "value": by_fid[f]["auction_spend"],
                 "accent": "gold" if f == spend_order[0] else None} for f in spend_order],
               axis={"unit": "usd", "max": max(v["auction_spend"] for v in by_fid.values())},
               alt_text="Horizontal bars of auction spend by owner, highest first. "
                        "Top spender %s at %s; lowest %s at %s."
                        % (by_fid[spend_order[0]]["owner"], fmt_usd(by_fid[spend_order[0]]["auction_spend"]),
                           by_fid[spend_order[-1]]["owner"], fmt_usd(by_fid[spend_order[-1]]["auction_spend"])))

    room_order = sorted(by_fid, key=lambda k: -by_fid[k]["cap_room"])
    pack.chart("c.cap_room", "hbar", "Cap room remaining",
               [{"label": by_fid[f]["owner"], "value": by_fid[f]["cap_room"]} for f in room_order],
               axis={"unit": "usd", "max": max(v["cap_room"] for v in by_fid.values())},
               alt_text="Horizontal bars of remaining cap room by owner, most first.")

    # -------------------------------------------------------------- outline
    pack.section("s1", "The Cap Sheet",
                 "Where the twelve teams stand on money right now, and how that compares with "
                 "the earliest snapshot of the off-season. Name the extremes; do not imply the "
                 "two columns are subtractable.",
                 fact_ids=["f.cap.median_room", "f.cap.tightest_room", "f.cap.most_room",
                           "f.cap.total_committed"],
                 table_ids=["t.cap_sheet"], chart_ids=["c.cap_room"])
    pack.section("s2", "The Auction",
                 "The comprehensive auction breakdown: what went for what, who spent, which lots "
                 "were contested and which went at the floor. State plainly that it is not over.",
                 fact_ids=["f.auction.lots_won", "f.auction.lots_open", "f.auction.total_spend",
                           "f.auction.top_price", "f.auction.median_price",
                           "f.auction.min_price_lots", "f.auction.total_bids",
                           "f.auction.contested_lots", "f.auction.finalized_contracts"],
                 table_ids=["t.auction_by_team", "t.top_buys"], chart_ids=["c.auction_spend"])
    pack.section("s3", "Twelve Verdicts",
                 "One card per owner: where they started, what they did, where they landed. "
                 "Every number cited must be a per-team fact token.",
                 fact_ids=sorted(k for k in pack._facts if k.startswith("f.team.")),
                 table_ids=["t.moves_by_team"])
    pack.section("s4", "The Off-Season in Aggregate",
                 "League-wide move counts: extensions, multi-year deals, restructures, tags, "
                 "front- and back-loading, the draft, trades and cuts.",
                 fact_ids=sorted(k for k in pack._facts
                                 if k.startswith(("f.moves.", "f.draft.", "f.trades.", "f.drops."))),
                 table_ids=["t.moves_by_team"])
    pack.section("s5", "What Does Not Fit",
                 "The honest limits: the open auction lots, the won-versus-finalized gap, the "
                 "snapshot start date, and the 2026 history-table cliff. Render warnings[] here.")

    return pack
