"""CBS draft-results HTML → fantasy_drafts / fantasy_draft_events rows.

WHY THIS IS A SCRAPER AND NOT AN API CALL
=========================================
CBS's JSON API works (league_id is the SUBDOMAIN STRING 'grffl', plus an
access_token), but it serves ONLY the current season. That was proven, not
assumed: `&season=` is ignored under every spelling tried
(season/year/SEASON/season_id/yr), draft/results returns 0 real picks for all
of them, and a content diff of league/stats between 2023 and 2025 found
**0 of 1,941 players different**.

⚠️ A PAYLOAD-HASH COMPARISON SAID league/stats HAD HISTORY. IT WAS A FALSE
POSITIVE — list-ordering noise that json sort_keys does not normalize. When
testing whether a source really supports a season parameter, diff the CONTENT,
never a hash.

The league WEBSITE does carry history: `/draft/results/<YEAR>` for 2013-2026,
server-rendered, behind the user's session. Hence HTML.

⚠️ USE THE PATH FORM. `/draft/results?season=2019` also returns HTTP 200 but
with FEWER rows than `/draft/results/2019` (252 vs 294). A query-form scrape
silently drops real picks and still looks successful.

PAGE ANATOMY (transcribed from the live 2019 page, 238 rows)
------------------------------------------------------------
The first `table.data` interleaves three row shapes:
    1 cell   -> a round banner, "Round 7"
    'Pick'   -> the column header, REPEATED once per round (17 times)
    7 cells  -> a pick: Pick | Team | Player | Elig | Elapsed | TotalFpts | ActiveFpts
A second table holds the draft-room chat log and is ignored.

⚠️ Total/Active Fpts are the points that player scored UNDER THIS LEAGUE'S
scoring rules — the reason this table is worth more than a pick list. They are
season-to-date at page render, so a historical season's are final and a live
season's are not. Stored verbatim; never recomputed.
"""
from __future__ import annotations

import re
from html.parser import HTMLParser

from .constants import GAME_CODE, PLATFORM, league_key, team_key

#: "Saquon Barkley RB • PHI" / "Alfred Blue RB •" (no NFL team)
#: ⚠️ The NFL team shown is the player's team AT PAGE RENDER, not in the drafted
#: season — a 2019 page rendered today shows Barkley on PHI, not NYG. Do not
#: read it as historical team; that is why it lands in a *_at_render column.
_PLAYER_RE = re.compile(r"^(?P<name>.+?)\s+(?P<pos>[A-Z/]{1,4})\s*•\s*(?P<team>[A-Z]{2,3})?\s*$")
_ROUND_RE = re.compile(r"^Round\s+(\d+)$", re.I)
#: /players/playerpage/2185957 -> 2185957
_PLAYERPAGE_RE = re.compile(r"/players/playerpage/(\d+)")


class _TableParser(HTMLParser):
    """Minimal table extractor — no bs4/lxml dependency in this repo."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.tables: list[list[list[str]]] = []
        #: parallel structure: the hrefs found inside each cell. CBS puts the
        #: player id ONLY in the anchor (/players/playerpage/2185957), and text
        #: extraction alone throws it away — see PLAYER ID note below.
        self.hrefs: list[list[list[list[str]]]] = []
        self._t: list[list[str]] | None = None
        self._th: list[list[list[str]]] | None = None
        self._row: list[str] | None = None
        self._rowh: list[list[str]] | None = None
        self._cell: list[str] | None = None
        self._cellh: list[str] | None = None
        self._depth = 0

    def handle_starttag(self, tag, attrs):
        if tag == "table":
            self._depth += 1
            if self._depth == 1:
                self._t = []; self._th = []
        elif tag == "tr" and self._t is not None:
            self._row = []; self._rowh = []
        elif tag in ("td", "th") and self._row is not None:
            self._cell = []; self._cellh = []
        elif tag == "a" and self._cellh is not None:
            for k, v in attrs:
                if k == "href" and v:
                    self._cellh.append(v)

    def handle_endtag(self, tag):
        if tag in ("td", "th") and self._cell is not None:
            self._row.append(re.sub(r"\s+", " ", "".join(self._cell)).strip())
            self._rowh.append(list(self._cellh or []))
            self._cell = None; self._cellh = None
        elif tag == "tr" and self._row is not None:
            if self._row:
                self._t.append(self._row); self._th.append(self._rowh)
            self._row = None; self._rowh = None
        elif tag == "table":
            if self._depth == 1 and self._t is not None:
                self.tables.append(self._t); self.hrefs.append(self._th)
                self._t = None; self._th = None
            self._depth = max(0, self._depth - 1)

    def handle_data(self, data):
        if self._cell is not None:
            self._cell.append(data)


def _num(s: str):
    """'252.1' -> 252.1 ; '' -> None. ⚠️ Never 0.0 for a blank — a blank means
    the page did not say, and 0.0 means the player scored zero."""
    s = (s or "").strip()
    if not s:
        return None
    try:
        return float(s)
    except ValueError:
        return None


def parse_draft_results(html: str, *, season: int, league_id: str,
                        teams_in_league: int | None = None) -> dict[str, list[dict]]:
    p = _TableParser()
    p.feed(html)
    if not p.tables:
        raise ValueError("no <table> found — the page did not render as expected; "
                         "refusing to report an empty draft")

    rows = p.tables[0]
    hrefs = p.hrefs[0] if p.hrefs else [[] for _ in rows]
    lk = league_key(season, league_id)
    events: list[dict] = []
    rnd = None
    seen_header = False

    for r, rh in zip(rows, hrefs):
        if len(r) == 1:
            m = _ROUND_RE.match(r[0])
            if m:
                rnd = int(m.group(1))
            continue
        if r and r[0].lower() == "pick":
            seen_header = True
            continue
        if len(r) < 3 or not r[0].isdigit():
            continue

        round_pick = int(r[0])
        franchise = r[1].strip()
        raw_player = r[2].strip()
        # ⚠️ A LEADING '*' IS PRESERVED, NOT INTERPRETED. 21 of 204 picks carry
        # it on the 2019 page. It most likely marks a keeper, but CBS does not
        # label it anywhere on the page and this league reports uses_keepers=0
        # for 2026 — so calling it "is_keeper" would be a guess dressed as data.
        # The flag is captured and the raw string kept; naming it is a separate,
        # evidence-backed decision.
        starred = raw_player.startswith("*")
        name_cell = raw_player.lstrip("*").strip()

        # ⚠️ PLAYER ID: recovered from the anchor, NOT from the text. CBS
        # renders the name as <a href="/players/playerpage/2185957">, so a
        # text-only scrape silently loses the only stable identifier the page
        # carries and leaves nothing to join a player across seasons on except
        # his display name. Names change (suffixes, punctuation); ids do not.
        cbs_pid = None
        for h in (rh[2] if len(rh) > 2 else []):
            m_id = _PLAYERPAGE_RE.search(h)
            if m_id:
                cbs_pid = m_id.group(1)
                break

        m = _PLAYER_RE.match(name_cell)
        if m:
            player_name = m.group("name").strip()
            position = m.group("pos")
            nfl_team = m.group("team")
        else:
            player_name, position, nfl_team = name_cell, None, None

        events.append({
            "platform": PLATFORM,
            "league_key": lk,
            "season": season,
            # pick_number (overall) is filled in below, once league width is known.
            "round_number": rnd,
            "pick_in_round": round_pick,
            "team_key": team_key(season, league_id, franchise) if franchise else None,
            "player_uid": f"{GAME_CODE}.p.{cbs_pid}" if cbs_pid else None,
            "provider_player_id": cbs_pid,
            "player_position_at_draft": position,
            # ⚠️ NAMED *_at_draft BY THE SCHEMA, BUT CBS RENDERS IT AS OF NOW.
            # A 2019 page fetched today shows Saquon Barkley on PHI, not NYG.
            # Stored because it is all CBS gives, and flagged here so nobody
            # mistakes it for the player's team during that season.
            "nfl_team_at_draft": nfl_team,
            # ⚠️ THE ASTERISK IS RECORDED AS AN *INFERENCE*, NOT AS is_keeper.
            # is_keeper stays NULL — CBS never labels the mark, and counts of
            # 20/21/49 across 2013/2019/2025 do not fit a keeper flag in a
            # league reporting uses_keepers=0. keeper_inferred + a written
            # basis is exactly the schema's affordance for "we saw a signal we
            # cannot yet name". Promote it to is_keeper only with evidence.
            "is_keeper": None,
            "keeper_inferred": 1 if starred else 0,
            "keeper_inference_basis": (
                "leading '*' on the CBS draft-results player cell; meaning "
                "UNCONFIRMED (CBS does not label it and this league reports "
                "uses_keepers=0)") if starred else None,
            # Everything CBS shows that the schema has no column for. The two
            # fantasy-points figures are the whole reason this page is worth
            # scraping — they are points under THIS LEAGUE'S scoring rules.
            "raw_pick_json": {
                "player_name": player_name or None,
                "raw_player_cell": raw_player,
                "team_name": franchise or None,
                "elapsed_time": (r[4].strip() or None) if len(r) > 4 else None,
                "total_fantasy_points": _num(r[5]) if len(r) > 5 else None,
                "active_fantasy_points": _num(r[6]) if len(r) > 6 else None,
            },
            "unmapped_fields": ["player_name", "total_fantasy_points",
                                "active_fantasy_points", "elapsed_time"],
        })

    if not events:
        raise ValueError(f"parsed {len(rows)} table rows but ZERO draft picks for "
                         f"{season} — a page that renders but yields no picks is a "
                         f"parse failure, not an empty draft")

    # ⚠️ AN UN-STARTED DRAFT RENDERS A FULL GRID OF EMPTY SLOTS. CBS serves the
    # upcoming season's board as 216 rows with no player anchor and no name
    # ("UpcomingPick" in the JSON API). Structurally these parse fine, so the
    # zero-rows guard above does NOT catch them — and writing them would put
    # 216 phantom picks into fantasy_draft_events. A draft nobody has made yet
    # is a GAP, and the caller must be told so explicitly.
    with_player = sum(1 for e in events
                      if e["provider_player_id"] or e["raw_pick_json"].get("player_name"))
    if not with_player:
        raise ValueError(
            f"{season}: {len(events)} pick slots rendered but NONE names a player — "
            f"this is an un-started draft board, not a completed draft. Treating it "
            f"as a gap rather than writing empty picks.")

    # overall_pick is DERIVED, and only when the league width is known for sure.
    # Guessing it from max(round_pick) would silently mis-number every round if
    # a round were short (a traded/forfeited pick).
    width = teams_in_league or max(e["pick_in_round"] for e in events)
    consistent = all(e["pick_in_round"] <= width for e in events)
    for e in events:
        e["pick_number"] = (
            (e["round_number"] - 1) * width + e["pick_in_round"]
            if (consistent and e["round_number"]) else None
        )

    rounds = sorted({e["round_number"] for e in events if e["round_number"]})
    draft = {
        "platform": PLATFORM,
        "league_key": lk,
        "season": season,
        "draft_kind": "offline_scrape",
        # ⚠️ is_price_bearing = 0: this is a SNAKE draft page with no auction
        # dollars. Saying otherwise would make auction_cost's NULLs look like
        # $0 bids rather than "not an auction".
        "is_price_bearing": 0,
        "draft_type": "snake",
        "draft_status": "completed",
        "num_rounds": len(rounds),
        "num_picks": len(events),
        "has_keepers": None,   # unknown — see keeper_inference_basis on the picks
        "raw_draft_json": {
            "source_url": f"https://{league_id}.football.cbssports.com/draft/results/{season}",
            "franchises_seen": sorted({e["team_key"] for e in events if e["team_key"]}),
            "header_rows_seen": 1 if seen_header else 0,
        },
    }
    return {"fantasy_drafts": [draft], "fantasy_draft_events": events}
