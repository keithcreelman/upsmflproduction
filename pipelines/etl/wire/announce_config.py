"""Where the weekly UPS Center announcement is allowed to post.

WHY (2026-11-19). Week 10's announcement was posted to #league-announcements because the script
was copied from the Week 7 template, which predated the move to #ups-wire (Keith, 2026-11-05).
Weeks 7-9 had been copied from the newer script and were fine. A saved note does not stop that,
so the channel now lives in one place and every announcement script has to ask this module.

  WEEKLY_CHANNEL_ID   #ups-wire, the only channel a weekly announcement may use.
  LEGACY_CHANNELS     channels the weekly announcement used to use. Posting there is refused
                      unless the caller passes allow_legacy=True (nothing in the repo does).
  assert_weekly_channel(channel_id)   raises ChannelRefused for anything but #ups-wire.
  announced_channel_ids()             every channel to search when asking "was this announced?"
"""

WEEKLY_CHANNEL_ID = "1563205145880174624"          # #ups-wire (Keith, 2026-11-05)
LEGACY_CHANNELS = {"1057657441011109898": "#league-announcements"}


class ChannelRefused(RuntimeError):
    pass


def channel_name(channel_id):
    cid = str(channel_id)
    if cid == WEEKLY_CHANNEL_ID:
        return "#ups-wire"
    return LEGACY_CHANNELS.get(cid, "channel " + cid)


def assert_weekly_channel(channel_id, allow_legacy=False):
    """Return the channel id when it is #ups-wire; refuse everything else."""
    cid = str(channel_id)
    if cid == WEEKLY_CHANNEL_ID:
        return cid
    if cid in LEGACY_CHANNELS and allow_legacy:
        return cid
    raise ChannelRefused(
        "refusing to post the weekly UPS Center announcement to %s (%s): the weekly announcement goes to #ups-wire (%s). "
        "This script is out of date; use pipelines/etl/wire/announce_weekly.py."
        % (channel_name(cid), cid, WEEKLY_CHANNEL_ID))


def announced_channel_ids():
    """Where an earlier announcement could be: the canonical channel first, then the old ones."""
    return [WEEKLY_CHANNEL_ID] + list(LEGACY_CHANNELS)
