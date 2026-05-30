# UPS Trade Roast Bot — Deploy Guide

Always-on Discord bot that auto-detects trades from MFL, generates Opus-powered roasts, posts to a Discord channel, and clap-backs at replies. Code lives in [pipelines/etl/scripts/](../pipelines/etl/scripts/):

- [trade_roast_bot.py](../pipelines/etl/scripts/trade_roast_bot.py) — Discord bot entry point
- [trade_roast_context.py](../pipelines/etl/scripts/trade_roast_context.py) — context builder (pulls MFL + DB + computes EV/hit-rate/scoring)
- [content_engine.py](../pipelines/etl/scripts/content_engine.py) — Claude prompts + API calls
- [pick_valuation.py](../pipelines/etl/scripts/pick_valuation.py) — empirical pick value curve

## Pre-deploy checklist

1. **Rotate Discord bot token** in the developer portal. The prior token in commit `2e29441` is burned.
2. **Bot OAuth scopes**: `applications.commands`, `bot` with permissions `Send Messages`, `Read Message History`, `Read Messages/View Channels`. Re-invite if needed.
3. **Anthropic API key** available with sufficient quota for Opus 4.6 (roasts) + Sonnet 4.6 (reply classification).
4. **Discord user mapping CSV** (`import_discord_info.csv`) on the host. Contains owner/team/discord-id PII — do NOT commit. Set `DISCORD_USERS_CSV` env var to its location.
5. **Python venv** at the working directory: `python3 -m venv .venv && .venv/bin/pip install -r pipelines/etl/requirements.txt` (or whatever the project install path is). Required packages: `anthropic`, `discord.py`, `requests`.
6. **ADP + auction value data refreshed at least once** before first run:
   ```
   .venv/bin/python pipelines/etl/scripts/fetch_external_adp.py
   .venv/bin/python pipelines/etl/scripts/build_auction_value_model.py
   ```

## Linux deploy (systemd)

1. Clone repo to `/opt/upsmflproduction`, create venv, install deps.
2. Copy CSV to a non-repo location (e.g. `/etc/roast-bot/import_discord_info.csv`).
3. Copy and fill env file:
   ```
   sudo cp ops/roast-bot.env.example /etc/roast-bot.env
   sudo $EDITOR /etc/roast-bot.env   # fill in tokens
   sudo chown root:upsbot /etc/roast-bot.env && sudo chmod 640 /etc/roast-bot.env
   ```
4. Create log dir + bot user:
   ```
   sudo useradd -r -s /usr/sbin/nologin upsbot
   sudo mkdir -p /var/log/roast-bot && sudo chown upsbot:upsbot /var/log/roast-bot
   ```
5. Install units and start:
   ```
   sudo cp ops/systemd/roast-bot.service /etc/systemd/system/
   sudo cp ops/systemd/roast-bot-adp-refresh.service /etc/systemd/system/
   sudo cp ops/systemd/roast-bot-adp-refresh.timer /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable --now roast-bot.service
   sudo systemctl enable --now roast-bot-adp-refresh.timer
   ```
6. Verify:
   ```
   sudo systemctl status roast-bot
   sudo systemctl list-timers | grep roast
   sudo tail -f /var/log/roast-bot/stdout.log
   ```

## macOS deploy (launchd)

1. Clone repo to `/Users/upsbot/upsmflproduction`, create venv, install deps.
2. Put CSV at a stable location and set `DISCORD_USERS_CSV` to that path.
3. Set env vars (in `launchctl setenv` for the user session, OR encode directly in the plist).
4. Install plists:
   ```
   cp ops/launchd/com.ups.roast-bot.plist ~/Library/LaunchAgents/
   cp ops/launchd/com.ups.roast-bot.adp-refresh.plist ~/Library/LaunchAgents/
   launchctl load ~/Library/LaunchAgents/com.ups.roast-bot.plist
   launchctl load ~/Library/LaunchAgents/com.ups.roast-bot.adp-refresh.plist
   ```
5. Verify: `launchctl list | grep roast` and `tail -f ~/Library/Logs/roast-bot.log`.

## Local test

Before flipping to production, run the bot in test mode:

```
export ANTHROPIC_API_KEY=...
export DISCORD_BOT_TOKEN=...
unset ROAST_BOT_ENV   # ensures test channel
python pipelines/etl/scripts/trade_roast_bot.py --test
```

This re-roasts the canonical Hurts test trade (`timestamp 1775772921`) to the test channel and then stays running to monitor replies.

## Operational notes

- **Polling interval**: 5 minutes (configurable via `POLL_INTERVAL_SECONDS` constant). On detecting a new trade timestamp > the last processed one, the bot fetches full trade detail, builds context, generates the roast, posts to Discord, and stores the message ID for reply tracking.
- **Reply monitoring**: Discord replies to a roast message are auto-classified (VALUE_SIGNAL, DATA_ERROR, or COPE). COPE replies get a clap-back; VALUE_SIGNAL and DATA_ERROR get a canned acknowledgment + logged to `pipelines/etl/data/league_sentiment.json` and `data_review_queue.json`.
- **Archive**: every roast lands in `pipelines/etl/data/content_archive.json` with full context, grades, replies.
- **Data freshness**: the ADP refresh timer runs daily at 06:00 local time. The bot's pick-value curve and auction comparables read whatever is freshest on disk at the moment of trade analysis.
- **Stopping**: `sudo systemctl stop roast-bot` (linux) or `launchctl unload ~/Library/LaunchAgents/com.ups.roast-bot.plist` (macOS).

## Troubleshooting

- **"DISCORD_BOT_TOKEN env var is required"** — the env file isn't being read or the token line is missing. Verify `EnvironmentFile=` path on systemd or that `launchctl setenv` was run.
- **Bot online but no roasts posted** — check `pipelines/etl/data/last_trade_timestamp.txt`; if it equals or exceeds the most recent MFL trade timestamp, no new trades are being detected. Clear or back-date the file to re-process.
- **Stale tier counts in roasts** — the ADP refresh hasn't run recently. Check `last_trade_timestamp.txt` mtime vs `pipelines/etl/data/trade_value_model.json` mtime; if the model is more than ~7 days old, the prompt will soften tier claims automatically, but you should rerun the refresh manually.
- **CSV not found at startup** — `DISCORD_USERS_CSV` env var pointing to a missing path; bot still runs but loses owner-name/discord-id mappings, weakening clap-back personalization.
