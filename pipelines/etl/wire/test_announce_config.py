#!/usr/bin/env python3
"""The weekly UPS Center announcement can only target #ups-wire, and "was it announced?" searches both channels.

WHAT HAPPENED (2026-11-19): Week 10 was announced in #league-announcements from a stale script copy and had to be
deleted and reposted in #ups-wire. Offline: no Discord, no D1, no network.

Usage:
  python3 pipelines/etl/wire/test_announce_config.py
"""
import io
import os
import sys
import tempfile
from contextlib import redirect_stdout

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import announce_config as AC  # noqa: E402
import announce_weekly as W  # noqa: E402
import ups_center_due as U  # noqa: E402

UPS_WIRE = "1563205145880174624"
LEAGUE_ANN = "1057657441011109898"


def refused(cid, **kw):
    try:
        AC.assert_weekly_channel(cid, **kw)
    except AC.ChannelRefused as e:
        return str(e)
    return None


def main():
    assert AC.WEEKLY_CHANNEL_ID == UPS_WIRE
    assert AC.assert_weekly_channel(UPS_WIRE) == UPS_WIRE
    assert AC.assert_weekly_channel(int(UPS_WIRE)) == UPS_WIRE
    msg = refused(LEAGUE_ANN)
    assert msg and "#league-announcements" in msg and "#ups-wire" in msg, msg
    assert refused("123456789"), "an unknown channel must be refused too"
    assert refused("") and refused(None), "an empty channel must be refused"
    assert refused(LEAGUE_ANN, allow_legacy=True) is None, "only an explicit allow_legacy opens the old channel"
    assert refused("123456789", allow_legacy=True), "allow_legacy never opens an unknown channel"
    assert AC.announced_channel_ids() == [UPS_WIRE, LEAGUE_ANN]

    # preflight finds an earlier announcement in either channel, and names it
    title = U.article_title(11)
    aid = U.article_id(2026, 11)
    for ch, name in ((UPS_WIRE, "#ups-wire"), (LEAGUE_ANN, "#league-announcements")):
        hit = U._announced(aid, title, [], [{"id": "9", "timestamp": "t", "channel_id": ch, "content": "x", "embeds": [{"title": title, "url": ""}]}])
        assert hit and name in hit[0], hit
    assert U._announced(aid, title, [], [{"id": "9", "content": "unrelated", "embeds": []}]) == []

    # the message builder: link appended once, mentions suppressed, button/thread come later
    built = W.build_message(2026, 11, "A dek.", "UPS Center — Week 11 is live.")
    assert built["url"] in built["content"] and built["content"].count(built["url"]) == 1
    assert built["payload"]["allowed_mentions"] == {"parse": []}
    assert W.build_message(2026, 11, "d", "see " + built["url"])["content"].count(built["url"]) == 1

    # default is a DRY RUN: it prints the channel and writes/posts nothing (no network is touched)
    with tempfile.NamedTemporaryFile("w", suffix=".txt", delete=False) as f:
        f.write("UPS Center — Week 11 is live.")
    try:
        buf = io.StringIO()
        with redirect_stdout(buf):
            rc = W.main(["--season", "2026", "--week", "11", "--dek", "A dek.", "--content-file", f.name])
        out = buf.getvalue()
        assert rc == 0 and "#ups-wire" in out and "DRY RUN" in out and "POSTED" not in out, out
    finally:
        os.unlink(f.name)

    # no argument can change the channel
    try:
        W.main(["--season", "2026", "--week", "11", "--dek", "d", "--content-file", "x", "--channel", LEAGUE_ANN])
        raise AssertionError("--channel must not exist")
    except SystemExit:
        pass
    print("ALL PASS")


if __name__ == "__main__":
    main()
