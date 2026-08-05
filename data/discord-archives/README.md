# Discord archives — UPS Dynasty FFL

Complete read-only exports of the league Discord guild (`1057655884475531324`).

These are **backups and analysis inputs**, not a live data source. Nothing in the worker reads
them. Same spirit as `data/db-archives/` — one compressed snapshot per pull, plus this README.

---

## `discord_export_2026-08-05.tar.gz` (2,336,059 bytes → 17 MB extracted)

Full export of **every channel and every thread**, taken 2026-08-05 for the channel redesign
audit (`docs/DISCORD_REDESIGN_2026.md`).

| | |
|---|---|
| Messages | **31,817** |
| Channels | 27 (6 categories) |
| Threads | 520 (active + archived, public + private) |
| Message files | 547 |
| Members | 20 (13 human accounts, 7 bots) |
| Date range | 2022-12-28 → 2026-08-05 |

### Extract

```bash
tar -xzf data/discord-archives/discord_export_2026-08-05.tar.gz
```

### Layout

```
dump/
  guild.json             guild metadata (owner_id, member counts, features)
  roles.json             all 8 roles + permission bitfields
  channels.json          all 27 channels: type, parent_id, position,
                         topic, permission_overwrites
  members.json           20 members: username, nick, roles, joined_at
  threads_active.json    currently-active threads
  threads_archived.json  archived threads, keyed by parent channel id
  index.json             one row per channel/thread: id, name, kind, parent,
                         count, first/last timestamp, message filename
  msgs_<channel_id>.json 547 files — one per channel or thread
```

### Message record

```jsonc
{
  "id": "...", "ts": "2026-07-25T16:04:11.123000+00:00", "type": 0,
  "author": "rybo4591", "author_id": "...", "bot": false, "webhook": null,
  "content": "...",                       // truncated at 4000 chars
  "embeds": [{"title": "...", "desc": "...",   // desc truncated at 1500
              "fields": [{"n": "...", "v": "..."}]}],  // v truncated at 400
  "attachments": ["filename.png"],        // FILENAMES ONLY — see caveat
  "reactions": 3,                         // total count across all emoji
  "mentions_everyone": false,
  "ref": "...",                           // message_reference id (native reply)
  "thread": true                          // whether a thread hangs off this message
}
```

### Caveats — read before relying on this

- **Attachment bytes are NOT included.** 1,144 files across 965 messages are recorded by
  filename only. Discord CDN URLs are signed and expiring (`ex=`/`is=`/`hm=`), so they were not
  retrievable after the fact. If the images ever matter, they must be pulled fresh — that clock
  is already running.
- **Reactions are a total count, not per-emoji and not per-user.** Reactor identities are gone.
- **Long content is truncated** at the limits noted above. Full fidelity would require a re-pull.
- **`index.json` counts were corrected post-pull** for `the-coffee-shop`, which was re-pulled in
  full (11,652 msgs) after an initial 6,000-message page cap. All 547 counts now match their
  files; total reconciles to 31,817.

### Regenerating

~20 minutes against the live API, bounded by the per-channel rate-limit bucket (5 GET/sec).
Needs the bot token from the macOS Keychain (`security find-generic-password -a "$USER"
-s discord_bot_token -w`). The pull script is `dump_guild.py`, reproduced in the redesign
audit; it is read-only and makes no writes of any kind.

---

## Why this exists

`docs/DISCORD_REDESIGN_2026.md` establishes that Discord **cannot move a message** between
channels or into a thread — `channel_id` is not editable and no endpoint exists. Any
"reorganize the history" work is therefore either an in-place container change (lossless) or a
re-post (which destroys timestamps, reactions, reply graph, and author identity — see the 2025
Slack import post-mortem in that doc).

This export is the hedge: it is the only representation of league Discord history that is not
subject to Discord's constraints, and it is the raw material for a searchable static archive on
the GH Pages site if that route is ever taken.
