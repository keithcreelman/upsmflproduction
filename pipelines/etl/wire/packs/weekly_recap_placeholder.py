#!/usr/bin/env python3
"""Placeholder for the 2026 Weekly Recap -- a real pack with zero facts.

Keith 2026-09-12: "Also let's add Weekly Recap which is the next thing we
need to build (Just the place holder for now)". The real recap builder is
packs/weekly_recap.py, which needs a completed week of box scores; there are
none yet in 2026. This pack exists only so the section has a stub to point at
before the first week is in the books -- it carries no numbers and makes no
claim beyond "this is coming."

Deterministic; no language model; no facts, so nothing here can go stale.
"""

import os
import sys
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from wire_pack import Pack                                # noqa: E402

SEASON = 2026
PACK_ID = "2026-weekly-recap-placeholder"


def build(pack_id):
    assert pack_id == PACK_ID, pack_id
    pack = Pack(PACK_ID, SEASON, week=None, title="Weekly Recap")
    pack.source("MFL schedule", datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                rows=None, note="No games have been played yet -- this pack carries no facts.")
    pack.section("s1", "Coming Soon",
                 "One short paragraph: recaps start once there is a week of games to recap. "
                 "No facts, no numbers, no promises about what it will cover.")
    return pack
