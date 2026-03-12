MFL Scheduler (macOS launchd)

This folder contains launchd jobs to run ETL refreshes at different times:

- `com.keith.mfl.rosterscurrent.daily.plist`: daily at 12:05 AM local time
- `com.keith.mfl.rostersweekly.inseason.tuesday.plist`: every Tuesday at 12:20 AM local time
  - Weekly refresh script self-skips outside season window using `leagueevents`
- `com.keith.mfl.acquisition.hourly.plist`: hourly trigger for Acquisition Hub history artifacts
  - The refresh script runs hourly during active draft / auction months and self-throttles to every 4 hours outside that window

Install / update:

```bash
REPO_ROOT="/absolute/path/to/upsmflproduction"
PYTHON_BIN="/absolute/path/to/python3"

mkdir -p "$HOME/Library/LaunchAgents"
mkdir -p "$REPO_ROOT/etl/logs"

cp "$REPO_ROOT/scripts/scheduler/com.keith.mfl.rosterscurrent.daily.plist" \
   "$HOME/Library/LaunchAgents/"
cp "$REPO_ROOT/scripts/scheduler/com.keith.mfl.rostersweekly.inseason.tuesday.plist" \
   "$HOME/Library/LaunchAgents/"
cp "$REPO_ROOT/scripts/scheduler/com.keith.mfl.acquisition.hourly.plist" \
   "$HOME/Library/LaunchAgents/"
cp "$REPO_ROOT/scripts/scheduler/com.keith.mfl.acquisition.rookie-reconcile.plist" \
   "$HOME/Library/LaunchAgents/"

for plist in \
  "$HOME/Library/LaunchAgents/com.keith.mfl.rosterscurrent.daily.plist" \
  "$HOME/Library/LaunchAgents/com.keith.mfl.rostersweekly.inseason.tuesday.plist" \
  "$HOME/Library/LaunchAgents/com.keith.mfl.acquisition.hourly.plist" \
  "$HOME/Library/LaunchAgents/com.keith.mfl.acquisition.rookie-reconcile.plist"; do
  perl -0pi -e "s#__REPO_ROOT__#$REPO_ROOT#g; s#__PYTHON_BIN__#$PYTHON_BIN#g" "$plist"
done

launchctl bootout gui/$(id -u) "$HOME/Library/LaunchAgents/com.keith.mfl.rosterscurrent.daily.plist" 2>/dev/null || true
launchctl bootout gui/$(id -u) "$HOME/Library/LaunchAgents/com.keith.mfl.rostersweekly.inseason.daily.plist" 2>/dev/null || true
launchctl bootout gui/$(id -u) "$HOME/Library/LaunchAgents/com.keith.mfl.rostersweekly.inseason.tuesday.plist" 2>/dev/null || true
launchctl bootout gui/$(id -u) "$HOME/Library/LaunchAgents/com.keith.mfl.acquisition.hourly.plist" 2>/dev/null || true
launchctl bootout gui/$(id -u) "$HOME/Library/LaunchAgents/com.keith.mfl.acquisition.rookie-reconcile.plist" 2>/dev/null || true

launchctl bootstrap gui/$(id -u) "$HOME/Library/LaunchAgents/com.keith.mfl.rosterscurrent.daily.plist"
launchctl bootstrap gui/$(id -u) "$HOME/Library/LaunchAgents/com.keith.mfl.rostersweekly.inseason.tuesday.plist"
launchctl bootstrap gui/$(id -u) "$HOME/Library/LaunchAgents/com.keith.mfl.acquisition.hourly.plist"
launchctl bootstrap gui/$(id -u) "$HOME/Library/LaunchAgents/com.keith.mfl.acquisition.rookie-reconcile.plist"
```

Check status:

```bash
launchctl print gui/$(id -u)/com.keith.mfl.rosterscurrent.daily
launchctl print gui/$(id -u)/com.keith.mfl.rostersweekly.inseason.tuesday
launchctl print gui/$(id -u)/com.keith.mfl.acquisition.hourly
launchctl print gui/$(id -u)/com.keith.mfl.acquisition.rookie-reconcile
```
