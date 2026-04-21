"""
rookie_draft_bridge.py — Local HTTP server that serves the Rookie Draft Hub
static files AND proxies hub actions to MFL's write API.

Runs on port 8093 by default. Uses Python stdlib only (no Flask/FastAPI).

Endpoints:
  GET  /*                 — static files from /New project/site/rookies/
  POST /api/pick          — { franchise_id, player_id, user_id? }  -> MFL draftResults
  POST /api/trade         — { from_fid, to_fid, give[], receive[], comments?, user_id? }
  POST /api/trade/respond — { from_fid, to_fid, accept, comments?, user_id? }

Run:
    python3 rookie_draft_bridge.py [--port 8093]
"""

from __future__ import annotations
import argparse
import json
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

# Allow import of mfl_write_client from same dir
SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR))
import mfl_write_client as mfl  # noqa: E402

HUB_DIR = Path("/Users/keithcreelman/Documents/New project/site/rookies")
MFL_DB = Path("/Users/keithcreelman/Documents/mfl/Development/pipelines/etl/data/mfl_database.db")
# User settings — holds the logged-in user's franchise_id + MFL user cookie.
# Kept out of the repo (gitignored). Only this user can submit writes.
SETTINGS_FILE = Path.home() / ".rookie_draft_hub" / "settings.json"


def _load_settings() -> dict:
    try:
        if SETTINGS_FILE.exists():
            return json.loads(SETTINGS_FILE.read_text())
    except Exception:
        pass
    return {}


def _save_settings(data: dict) -> None:
    SETTINGS_FILE.parent.mkdir(parents=True, exist_ok=True)
    SETTINGS_FILE.write_text(json.dumps(data, indent=2))


def _resolve_user_franchise() -> tuple[str | None, str | None]:
    """Return (franchise_id, user_cookie) for the logged-in hub user.
    If not set, returns (None, None) and the UI will prompt to configure."""
    s = _load_settings()
    return s.get("franchise_id"), s.get("mfl_user_id")


def _try_read_mfl_cookie_from_browsers() -> str | None:
    """Best-effort: pull MFL_USER_ID from local browser cookie stores.
    Tries Chrome (macOS). Decrypts the Chrome-encrypted value via the Keychain
    password + PBKDF2 + AES-CBC (using OpenSSL to avoid adding a crypto dep).

    Returns the cookie value if found, else None.
    """
    import os, sqlite3 as _sq, subprocess, hashlib, base64, tempfile
    if os.uname().sysname != "Darwin":
        return None
    chrome_db = Path.home() / "Library" / "Application Support" / "Google" / "Chrome" / "Default" / "Cookies"
    if not chrome_db.exists():
        return None
    # 1) Get Chrome's Safe Storage password from Keychain
    try:
        pw = subprocess.check_output(
            ["security", "find-generic-password", "-w", "-s", "Chrome Safe Storage"],
            stderr=subprocess.DEVNULL,
        ).strip()
    except subprocess.CalledProcessError:
        return None
    # 2) Derive AES key via PBKDF2-HMAC-SHA1 (saltysalt, 1003 rounds, 16 bytes)
    key = hashlib.pbkdf2_hmac("sha1", pw, b"saltysalt", 1003, 16)
    # 3) Read encrypted cookie value from a snapshot (Chrome locks the live DB)
    with tempfile.NamedTemporaryFile(suffix=".db", delete=False) as tmp:
        tmp_path = tmp.name
    try:
        import shutil
        shutil.copy2(str(chrome_db), tmp_path)
        conn = _sq.connect(tmp_path)
        rows = conn.execute(
            "SELECT encrypted_value, value FROM cookies "
            "WHERE host_key LIKE '%myfantasyleague.com' AND name='MFL_USER_ID' "
            "ORDER BY last_access_utc DESC LIMIT 1"
        ).fetchone()
        conn.close()
    except Exception:
        return None
    finally:
        try: os.remove(tmp_path)
        except Exception: pass
    if not rows:
        return None
    enc, plain = rows
    # Chrome stores plain value too in recent versions if the cookie is httponly only
    if plain:
        return plain
    if not enc or len(enc) < 3 or enc[:3] != b"v10":
        return None
    # 4) Decrypt AES-128-CBC with IV = 16 spaces (0x20)
    try:
        # Shell out to openssl since we don't want to add a crypto library dep.
        # The ciphertext (after stripping 'v10' prefix) is decrypted in-place.
        proc = subprocess.run(
            ["openssl", "enc", "-aes-128-cbc", "-d",
             "-K", key.hex(),
             "-iv", "20" * 16],
            input=enc[3:], capture_output=True, check=False,
        )
        out = proc.stdout
        if not out: return None
        # Chrome v10 cookie values have a 32-byte SHA256 hash prefix in some builds
        # (Chrome 90+), which we strip heuristically — MFL cookie values are always
        # alphanumeric so any non-alnum run at the start is the hash.
        try:
            # Try raw first
            s = out.decode("utf-8", errors="strict")
            return s
        except UnicodeDecodeError:
            # Strip possible 32-byte SHA256 prefix
            return out[32:].decode("utf-8", errors="ignore") or None
    except Exception:
        return None


def _detect_mfl_user_from_cookie(mfl_user_id: str) -> dict:
    """Given an MFL_USER_ID cookie, call MFL's league endpoint with the cookie
    to auto-detect which franchise this user is authenticated as. Returns
    {franchise_id, franchise_name, display_name} or {error}.

    This is how the Trade Module identifies "you" — the logged-in MFL user is
    tied to one (or more) franchises in the league. We use the `username`
    field from the league response filtered by whoever MFL identifies as the
    current session owner.
    """
    import urllib.request, urllib.error, json as _j
    from http.cookiejar import Cookie, CookieJar
    try:
        # MFL's TYPE=myleagues returns leagues the authed user belongs to —
        # including which franchise_id they own in each.
        url = (f"https://www48.myfantasyleague.com/{mfl.CURRENT_YEAR}/export"
               f"?TYPE=myleagues&L={mfl.LEAGUE_ID}&JSON=1")
        req = urllib.request.Request(url, headers={"Cookie": f"MFL_USER_ID={mfl_user_id}"})
        with urllib.request.urlopen(req, timeout=15) as r:
            data = _j.loads(r.read())
        leagues = data.get("myleagues", {}).get("league", [])
        if isinstance(leagues, dict): leagues = [leagues]
        for lg in leagues:
            if str(lg.get("league_id")) == str(mfl.LEAGUE_ID):
                return {
                    "franchise_id": lg.get("franchise_id"),
                    "franchise_name": lg.get("franchise_name") or lg.get("name"),
                    "league_name": lg.get("name"),
                }
        return {"error": f"MFL_USER_ID not a member of league {mfl.LEAGUE_ID}"}
    except urllib.error.HTTPError as e:
        return {"error": f"HTTP {e.code}: {e.reason}"}
    except Exception as e:
        return {"error": str(e)}


def build_player_bundle(pid: str, year: str = "2026") -> dict:
    """Consolidate MFL profile + injuries + local DB for a single player."""
    import json, sqlite3
    from urllib.request import urlopen as _urlopen
    bundle = {"player_id": pid}
    # 1. MFL playerProfile (bio + career stats) — merged with DETAILS=1 for full bio
    try:
        url = f"https://api.myfantasyleague.com/{year}/export?TYPE=playerProfile&P={pid}&JSON=1"
        with _urlopen(url, timeout=15) as r:
            bundle["profile"] = json.loads(r.read())
    except Exception as e:
        bundle["profile_error"] = str(e)
    # MFL playerProfile only returns height/weight/dob. Fetch DETAILS=1 to get
    # college / draft_year / draft_team / draft_round / draft_pick / jersey etc.
    try:
        url = f"https://api.myfantasyleague.com/{year}/export?TYPE=players&DETAILS=1&PLAYERS={pid}&JSON=1"
        with _urlopen(url, timeout=15) as r:
            details = json.loads(r.read())
        ps = details.get("players", {}).get("player", [])
        if isinstance(ps, dict): ps = [ps]
        if ps:
            # Merge into profile.player so the frontend has one place to read bio from
            existing = bundle.get("profile", {}).get("playerProfile", {})
            if "player" not in existing: existing["player"] = {}
            for k, v in ps[0].items():
                existing["player"].setdefault(k, v)
            bundle.setdefault("profile", {})["playerProfile"] = existing
    except Exception as e:
        bundle["details_error"] = str(e)
    # 2. Injuries
    try:
        url = f"https://www48.myfantasyleague.com/{year}/export?TYPE=injuries&L={mfl.LEAGUE_ID}&JSON=1"
        with _urlopen(url, timeout=15) as r:
            data = json.loads(r.read())
        players = data.get("injuries", {}).get("injury", []) or []
        if isinstance(players, dict): players = [players]
        for p in players:
            if str(p.get("id")) == str(pid):
                bundle["injury"] = p
                break
    except Exception as e:
        bundle["injuries_error"] = str(e)
    # 3. Local DB: current roster status + recent acquisition + weekly + trades
    if MFL_DB.exists():
        try:
            db = sqlite3.connect(str(MFL_DB))
            db.row_factory = sqlite3.Row
            # Check if player is CURRENTLY ROSTERED on any 2026 franchise.
            # If NOT rostered (either in FA pool or retired/not-in-league), skip
            # contract + acquisition rendering entirely — stale rosters_weekly data
            # would otherwise show wrong ownership (Josh Gordon-on-Blake-Bombers bug).
            rd: dict | None = None
            is_fa = False
            is_not_rostered = False  # catches retired + FA both
            try:
                live_url = f"https://www48.myfantasyleague.com/{year}/export?TYPE=rosters&L={mfl.LEAGUE_ID}&JSON=1"
                with _urlopen(live_url, timeout=15) as r:
                    live_data = json.loads(r.read())
                franchises = live_data.get("rosters", {}).get("franchise", [])
                if isinstance(franchises, dict): franchises = [franchises]
                league_url = f"https://www48.myfantasyleague.com/{year}/export?TYPE=league&L={mfl.LEAGUE_ID}&JSON=1"
                with _urlopen(league_url, timeout=15) as r:
                    league_data = json.loads(r.read())
                lf = league_data.get("league", {}).get("franchises", {}).get("franchise", [])
                if isinstance(lf, dict): lf = [lf]
                fid_name = {str(f.get("id")): f.get("name", "") for f in lf}
                for f in franchises:
                    fid = str(f.get("id"))
                    players = f.get("player", [])
                    if isinstance(players, dict): players = [players]
                    for pp in players:
                        if str(pp.get("id")) != str(pid): continue
                        rd = {
                            "season": int(year),
                            "franchise_id": fid,
                            "team_name": fid_name.get(fid, fid),
                            "salary": int(float(pp.get("salary") or 0)),
                            "contract_year": int(pp.get("contractYear") or 0),
                            "contract_status": pp.get("contractStatus") or "",
                            "contract_info": pp.get("contractInfo") or "",
                            "status": pp.get("status") or "",
                        }
                        break
                    if rd: break
                if rd is None:
                    is_not_rostered = True
            except Exception as e:
                bundle["live_roster_error"] = str(e)

            # If not rostered, classify as FA (in pool) or Retired/Not-in-league
            if is_not_rostered:
                try:
                    fa_url = f"https://www48.myfantasyleague.com/{year}/export?TYPE=freeAgents&L={mfl.LEAGUE_ID}&JSON=1"
                    with _urlopen(fa_url, timeout=15) as r:
                        fa_data = json.loads(r.read())
                    fa_players = fa_data.get("freeAgents", {}).get("leagueUnit", {}).get("player", [])
                    if isinstance(fa_players, dict): fa_players = [fa_players]
                    if any(str(p.get("id")) == str(pid) for p in fa_players):
                        is_fa = True
                        bundle["is_free_agent"] = True
                    else:
                        bundle["is_not_rostered"] = True  # retired / not-in-league
                except Exception as e:
                    bundle["fa_check_error"] = str(e)
                    bundle["is_not_rostered"] = True  # assume not rostered if we can't confirm FA
            # rosters_weekly fallback — ONLY if player is confirmed rostered via live MFL.
            # If live fetch succeeded but player not found, they're NOT rostered (FA or
            # retired) — do NOT fall back to stale DB data.
            if rd is None and not is_not_rostered:
                r = db.execute("""
                    SELECT season, franchise_id, team_name, salary, contract_year,
                           contract_status, contract_info, status
                    FROM rosters_weekly WHERE player_id=? ORDER BY season DESC, week DESC LIMIT 1
                """, (pid,)).fetchone()
                rd = dict(r) if r else None
            if rd and not is_not_rostered:
                bundle["current_roster"] = rd
                # Parse the MFL contractInfo format:
                # "CL 1| TCV 62K| AAV 62K| GTD 62K| Tag| Tier 1| Formula: ..."
                import re as _re
                try:
                    ci = rd.get("contract_info") or ""
                    def _parse_dollars(s: str) -> int | None:
                        m = _re.search(r"(\d+(?:\.\d+)?)\s*([KMk])?", s)
                        if not m: return None
                        n = float(m.group(1))
                        u = (m.group(2) or "").upper()
                        return int(n * (1000 if u == "K" else (1_000_000 if u == "M" else 1)))
                    length = None
                    tcv = None
                    aav = None
                    gtd = None
                    is_tag = False
                    tag_tier = None
                    is_walk_year = False  # "No Further Extensions" = FA after this season
                    for chunk in [c.strip() for c in ci.split("|") if c.strip()]:
                        up = chunk.upper()
                        if up.startswith("CL "): length = int(chunk[3:].strip() or 0) or None
                        elif up.startswith("TCV "): tcv = _parse_dollars(chunk[4:])
                        elif up.startswith("AAV "): aav = _parse_dollars(chunk[4:])
                        elif up.startswith("GTD "): gtd = _parse_dollars(chunk[4:])
                        elif up == "TAG": is_tag = True
                        elif up.startswith("TIER "):
                            try: tag_tier = int(chunk[5:].strip())
                            except Exception: pass
                        elif "NO FURTHER EXTENSIONS" in up:
                            is_walk_year = True
                    salary = int(rd.get("salary") or 0)
                    cyear = int(rd.get("contract_year") or 0)
                    years_remaining = max(0, (length - cyear + 1)) if (length and cyear) else None
                    status_raw = rd.get("contract_status") or ""
                    # IMPORTANT: MFL's contractStatus field reports "Tag" for any player
                    # on a one-year forced contract, including "No Further Extensions"
                    # post-extension players (not actually franchise tagged). The ONLY
                    # authoritative tag signal is the literal "Tag" pipe-chunk in
                    # contractInfo (present only for actual franchise tags — usually
                    # accompanied by "Tier N" and the formula string).
                    status_label = "Franchise Tag" if is_tag else status_raw
                    synth = {
                        "contract_status": status_label,
                        "contract_status_raw": status_raw,
                        "is_tag": is_tag or status_raw.upper() == "TAG",
                        "tag_tier": tag_tier,
                        "contract_year": cyear,
                        "contract_length": length,
                        "years_remaining": years_remaining,
                        "salary": salary,
                        "aav_current": aav or salary,
                        "total_contract_value": tcv or (salary * years_remaining if years_remaining else salary * (length or 1)),
                        "contract_guarantee": gtd,
                        "contract_info": ci,
                    }
                    bundle["contract"] = synth
                except Exception:
                    pass
            # Overlay contract details — only if currently rostered
            c = db.execute("""
                SELECT contract_status, contract_year, salary, contract_length,
                       total_contract_value, aav_current, aav_future,
                       contract_guarantee, year_salary_breakdown_json,
                       extension_history_json, won_at_auction, acquisition_date,
                       acquisition_source
                FROM contracts_current WHERE player_id=? LIMIT 1
            """, (pid,)).fetchone() if not is_not_rostered else None
            if c:
                c = dict(c)
                try:
                    cy = int(c.get("contract_year") or 0)
                    cl = int(c.get("contract_length") or 0)
                    if cy and cl:
                        years_elapsed = max(0, int(year) - cy)
                        c["years_remaining"] = max(0, cl - years_elapsed)
                except Exception:
                    pass
                try:
                    if c.get("year_salary_breakdown_json"):
                        c["year_salary_breakdown"] = json.loads(c["year_salary_breakdown_json"])
                except Exception:
                    pass
                bundle["contract"] = c
            # Latest acquisition — only if currently rostered
            if not is_not_rostered:
                r = db.execute("""
                    SELECT season, franchise_id, franchise_name, move_type, method, salary, datetime_et
                    FROM transactions_adddrop
                    WHERE player_id=? AND move_type='ADD'
                    ORDER BY unix_timestamp DESC LIMIT 1
                """, (pid,)).fetchone()
                if r: bundle["last_add"] = dict(r)
            # Recent weekly scores (last full season + current)
            rows = db.execute("""
                SELECT season, week, score, status, roster_franchise_name, pos_rank, overall_rank
                FROM player_weeklyscoringresults
                WHERE player_id=? AND is_reg=1 AND score > 0
                ORDER BY season DESC, week DESC LIMIT 24
            """, (pid,)).fetchall()
            bundle["recent_weeks"] = [dict(r) for r in rows]
            # INFER historical ownership for pre-2017 seasons where rosters_weekly has no data.
            # Replay draft → trades → adds → drops chronologically to determine current owner
            # per week. Returns dict[(season, week)] → {fid, team_name} for this player.
            def _infer_historical_ownership(target_pid: str) -> dict:
                out = {}
                # 1) Draft year → owner (may be blank in legacy data — use team_name lookup)
                draft_rows = db.execute("""
                    SELECT season, franchise_id, franchise_name FROM draftresults_legacy
                    WHERE player_id=? AND season < 2017
                    UNION ALL
                    SELECT season, franchise_id, franchise_name FROM draftresults_mfl
                    WHERE player_id=? AND season < 2017
                """, (target_pid, target_pid)).fetchall()
                # Event timeline: (unix_ts, season, franchise_id, team_name, action)
                events: list[tuple] = []
                # Seed with draft events (assume draft happened at season start)
                for r in draft_rows:
                    s = int(r["season"])
                    # Resolve franchise_id from team_name if blank
                    fid = r["franchise_id"] or None
                    if not fid and r["franchise_name"]:
                        # Two-step lookup: (1) find which OWNER had this team name in ANY
                        # historical season (handles "Bad Newz Kennels" = Keith's old 2010 name);
                        # (2) find what franchise_id that OWNER owned in the draft year
                        # (Keith had moved to 0008 'Raining Bullets' by 2011).
                        import re as _re
                        norm = _re.sub(r"[^a-z0-9]", "", r["franchise_name"].lower())[:15]
                        owner_row = None
                        for cr in db.execute(
                            "SELECT owner_name, team_name FROM franchises "
                            "WHERE team_name IS NOT NULL AND owner_name IS NOT NULL"
                        ).fetchall():
                            tn = _re.sub(r"[^a-z0-9]", "", (cr["team_name"] or "").lower())[:15]
                            if tn == norm:
                                owner_row = cr
                                break
                        if owner_row:
                            # Find that owner's franchise in the draft year
                            fr = db.execute(
                                "SELECT franchise_id FROM franchises "
                                "WHERE owner_name=? AND season=? LIMIT 1",
                                (owner_row["owner_name"], s)
                            ).fetchone()
                            if fr:
                                fid = fr["franchise_id"]
                    if fid:
                        # Rookie drafts happen in April-May. Use May 1 of draft year as the
                        # seed event timestamp — must be BEFORE any in-season transactions.
                        import datetime as _dt
                        draft_ts = int(_dt.datetime(s, 5, 1, 0, 0).timestamp())
                        events.append((draft_ts, s, str(fid), r["franchise_name"] or "", "ADD"))
                # Adds / Drops
                for r in db.execute("""
                    SELECT season, unix_timestamp, franchise_id, franchise_name, move_type
                    FROM transactions_adddrop WHERE player_id=? AND season < 2017
                    ORDER BY unix_timestamp
                """, (target_pid,)).fetchall():
                    if not r["franchise_id"] or not r["unix_timestamp"]: continue
                    events.append((int(r["unix_timestamp"]), int(r["season"]),
                                   str(r["franchise_id"]), r["franchise_name"] or "",
                                   "ADD" if r["move_type"] == "ADD" else "DROP"))
                # Trades
                for r in db.execute("""
                    SELECT season, unix_timestamp, franchise_id, franchise_name, asset_role
                    FROM transactions_trades WHERE player_id=? AND season < 2017
                    ORDER BY unix_timestamp
                """, (target_pid,)).fetchall():
                    if not r["franchise_id"] or not r["unix_timestamp"]: continue
                    role = (r["asset_role"] or "").upper()
                    events.append((int(r["unix_timestamp"]), int(r["season"]),
                                   str(r["franchise_id"]), r["franchise_name"] or "",
                                   "ADD" if role == "ACQUIRE" else "DROP"))
                # Sort by unix ts
                events.sort(key=lambda e: e[0])
                # Replay: walk forward; carry current owner across seasons until DROP
                current_fid: str | None = None
                current_name: str = ""
                # For each pre-2017 season, check every week (NFL week 1-17)
                for yr in range(2012, 2017):
                    # Apply any events that happen during or before this season's week X
                    # Season boundaries: NFL Week 1 starts early September. Approximate with
                    # Sept 1 of the season as week-1 cutoff, then 7-day buckets.
                    import datetime as _dt
                    week1_ts = int(_dt.datetime(yr, 9, 1, 0, 0).timestamp())
                    for wk in range(1, 18):
                        cutoff = week1_ts + (wk - 1) * 7 * 86400 + 6 * 86400  # end-of-week Sunday
                        # Apply all events with ts ≤ cutoff AND season ≤ yr
                        for ts, ev_season, fid, team, action in events:
                            if ev_season > yr: continue
                            if ts > cutoff: break
                            if action == "ADD":
                                current_fid = fid; current_name = team
                            elif action == "DROP":
                                current_fid = None; current_name = ""
                        if current_fid:
                            # Resolve team_name more authoritatively from franchises table
                            nm = db.execute(
                                "SELECT team_name FROM franchises WHERE season=? AND franchise_id=?",
                                (yr, current_fid)
                            ).fetchone()
                            out[(yr, wk)] = {
                                "franchise_id": current_fid,
                                "team_name": (nm["team_name"] if nm and nm["team_name"] else current_name or current_fid),
                            }
                return out

            inferred_ownership = _infer_historical_ownership(str(pid))

            # FULL per-season game log with per-week tier classification.
            # IMPORTANT: player_weeklyscoringresults.status is 'fa' for ALL pre-2020 rows
            # (stale data), and its roster_franchise_name shows 'Free Agent'. The
            # authoritative status/franchise comes from weeklyresults. LEFT JOIN picks
            # the correct info when available, falls back to pws only if no match.
            from build_rookie_draft_hub import _load_pos_baselines, _POS_BASELINES
            _load_pos_baselines(db)
            all_weeks = db.execute("""
                SELECT pws.season, pws.week, pws.score, pws.pos_group,
                       pws.pos_rank, pws.overall_rank,
                       COALESCE(wr.status, pws.status)   AS status,
                       wr.franchise_id                    AS wr_fid,
                       pws.roster_franchise_name          AS pws_team
                FROM player_weeklyscoringresults pws
                LEFT JOIN weeklyresults wr
                  ON wr.player_id = pws.player_id
                 AND wr.season = pws.season
                 AND wr.week = pws.week
                WHERE pws.player_id=? AND pws.score > 0
                ORDER BY pws.season DESC, pws.week ASC
            """, (pid,)).fetchall()

            # Cache franchise_id → team_name per season for the wr_fid lookup
            fid_name_cache: dict[tuple[int, str], str] = {}
            def _resolve_team(season: int, fid: str | None, fallback: str) -> str:
                if not fid: return (fallback or "").replace("Free Agent", "").strip() or "—"
                key = (int(season), str(fid))
                if key not in fid_name_cache:
                    rr = db.execute(
                        "SELECT team_name FROM franchises WHERE season=? AND franchise_id=?",
                        (season, fid)
                    ).fetchone()
                    fid_name_cache[key] = (rr["team_name"] if rr and rr["team_name"] else fid)
                return fid_name_cache[key]

            by_season: dict[int, list[dict]] = {}
            for r in all_weeks:
                s = int(r["season"])
                pg = r["pos_group"]
                baseline = _POS_BASELINES.get((s, pg))
                if baseline:
                    p50, delta = baseline
                    z = (float(r["score"]) - p50) / delta
                    if z >= 1.0: week_tier = "Elite"
                    elif z >= 0.25: week_tier = "Plus"
                    elif z >= -0.5: week_tier = "Neutral"
                    else: week_tier = "Dud"
                else:
                    z = None; week_tier = None
                # Resolve team: 1st weeklyresults, 2nd inferred lineage (pre-2017),
                # 3rd the stale pws string (discard if "Free Agent")
                team_name = _resolve_team(s, r["wr_fid"], r["pws_team"] or "")
                inferred_fid = None
                if (not r["wr_fid"]) and s < 2017:
                    inf = inferred_ownership.get((s, int(r["week"])))
                    if inf:
                        team_name = inf["team_name"]
                        inferred_fid = inf["franchise_id"]
                # Normalize status across data sources
                status = r["status"] or ""
                if status == "fa" and (r["wr_fid"] or inferred_fid):
                    # Known rostered — just didn't start (bench). Show 'nonstarter'.
                    status = "nonstarter" if not r["wr_fid"] else ""
                by_season.setdefault(s, []).append({
                    "season": s, "week": int(r["week"]), "score": float(r["score"]),
                    "pos_group": pg, "status": status,
                    "roster_franchise_name": team_name,
                    "pos_rank": r["pos_rank"], "overall_rank": r["overall_rank"],
                    "z_score": round(z, 3) if z is not None else None,
                    "week_tier": week_tier,
                })
            bundle["weekly_by_season"] = by_season
            # Trades involving player
            rows = db.execute("""
                SELECT season, datetime_et, franchise_name, asset_role, comments
                FROM transactions_trades
                WHERE player_id=? ORDER BY unix_timestamp DESC LIMIT 10
            """, (pid,)).fetchall()
            bundle["trade_history"] = [dict(r) for r in rows]
            # Seasonal career summary — starts from weeklyresults (authoritative
            # for starter status pre-2020; player_weeklyscoringresults.status='fa'
            # for 2012-2019). Elite/Plus/Dud % computed from weekly z-scores.
            from build_rookie_draft_hub import _load_pos_baselines as _lpb, _POS_BASELINES as _PB
            _lpb(db)
            rows = db.execute("""
                SELECT season,
                       SUM(CASE WHEN score > 0 THEN 1 ELSE 0 END) AS games_played,
                       ROUND(SUM(score), 1) AS season_points,
                       ROUND(AVG(CASE WHEN score > 0 THEN score ELSE NULL END), 2) AS avg_ppg
                FROM player_weeklyscoringresults
                WHERE player_id=? AND score > 0
                GROUP BY season ORDER BY season DESC
            """, (pid,)).fetchall()
            career = []
            for r in rows:
                rec = dict(r)
                s = int(rec["season"])
                # Starts from weeklyresults (correct pre-2020)
                r2 = db.execute(
                    "SELECT COUNT(*) FROM weeklyresults WHERE player_id=? AND season=? AND status='starter'",
                    (pid, s)
                ).fetchone()
                rec["mfl_starts"] = int(r2[0]) if r2 else 0
                # E+P/Dud % from z-scored weeks
                weeks = db.execute(
                    "SELECT score, pos_group FROM player_weeklyscoringresults WHERE player_id=? AND season=? AND score > 0",
                    (pid, s)
                ).fetchall()
                elite = plus = neutral = dud = total = 0
                for score, pg in weeks:
                    b = _PB.get((s, pg))
                    if not b: continue
                    z = (float(score) - b[0]) / b[1]
                    total += 1
                    if z >= 1.0: elite += 1
                    elif z >= 0.25: plus += 1
                    elif z >= -0.5: neutral += 1
                    else: dud += 1
                rec["elite_pct"] = round(elite / total * 100, 1) if total else None
                rec["plus_pct"] = round(plus / total * 100, 1) if total else None
                rec["ep_pct"] = round((elite + plus) / total * 100, 1) if total else None  # Elite+Plus combined
                rec["neutral_pct"] = round(neutral / total * 100, 1) if total else None
                rec["dud_pct"] = round(dud / total * 100, 1) if total else None
                career.append(rec)
            bundle["career_summary"] = career
            db.close()
        except Exception as e:
            bundle["db_error"] = str(e)
    return bundle


def build_franchise_assets(fid: str, year: str) -> dict:
    """Return a franchise's tradeable assets by NAME:
      - players: current roster pulled from MFL rosters endpoint
      - future_picks: from MFL futureDraftPicks
      - current_picks: any remaining picks in this year's draft order
      - blind_bid: placeholder (amount entered by user)
    All items include a human-readable display string + an asset_id that
    the MFL write API accepts."""
    import json, sqlite3
    from urllib.request import urlopen as _urlopen
    out = {"franchise_id": fid, "year": year, "players": [], "future_picks": [], "current_picks": []}

    # Players on roster
    try:
        url = f"https://www48.myfantasyleague.com/{year}/export?TYPE=rosters&L={mfl.LEAGUE_ID}&FRANCHISE={fid}&JSON=1"
        with _urlopen(url, timeout=15) as r:
            data = json.loads(r.read())
        franchises = data.get("rosters", {}).get("franchise", [])
        if isinstance(franchises, dict): franchises = [franchises]
        pids = []
        for f in franchises:
            if str(f.get("id")) != str(fid): continue
            players = f.get("player", [])
            if isinstance(players, dict): players = [players]
            for p in players:
                pids.append((str(p.get("id")), float(p.get("salary") or 0), p.get("contractInfo", ""), p.get("status", "")))
        # Look up names/positions from local DB in bulk
        if pids and MFL_DB.exists():
            db = sqlite3.connect(str(MFL_DB))
            db.row_factory = sqlite3.Row
            for pid, salary, contract_info, status in pids:
                row = db.execute("SELECT player_name, position FROM player_master WHERE player_id=?", (pid,)).fetchone()
                out["players"].append({
                    "asset_id": pid,
                    "display": (row["player_name"] if row else f"Player #{pid}"),
                    "position": (row["position"] if row else ""),
                    "salary": salary, "contract_info": contract_info, "status": status,
                })
            db.close()
        out["players"].sort(key=lambda p: p["display"])
    except Exception as e:
        out["players_error"] = str(e)

    # Future draft picks (TYPE=futureDraftPicks) — resolve original owner to NAME
    try:
        url = f"https://www48.myfantasyleague.com/{year}/export?TYPE=futureDraftPicks&L={mfl.LEAGUE_ID}&JSON=1"
        with _urlopen(url, timeout=15) as r:
            data = json.loads(r.read())
        rows = data.get("futureDraftPicks", {}).get("franchise", [])
        if isinstance(rows, dict): rows = [rows]
        # Map franchise_id → franchise_name from league info
        fid_to_name: dict[str, str] = {}
        try:
            league_url = f"https://www48.myfantasyleague.com/{year}/export?TYPE=league&L={mfl.LEAGUE_ID}&JSON=1"
            with _urlopen(league_url, timeout=15) as rr:
                ldata = json.loads(rr.read())
            lf = ldata.get("league", {}).get("franchises", {}).get("franchise", [])
            if isinstance(lf, dict): lf = [lf]
            for f in lf:
                fid_to_name[str(f.get("id"))] = f.get("name", "")
        except Exception:
            pass
        for row in rows:
            if str(row.get("id")) != str(fid): continue
            picks = row.get("futureDraftPick", []) or []
            if isinstance(picks, dict): picks = [picks]
            for p in picks:
                yr = p.get("year")
                rnd = p.get("round")
                original_fid = str(p.get("originalPickFor", fid))
                original_name = fid_to_name.get(original_fid, original_fid)
                asset_id = f"FP_{original_fid}_{yr}_{rnd}"
                # Always show original owner — even if it's yours — so the user
                # can see explicitly "this is MY 2027 R2" vs "from Ryan's 2027 R2"
                out["future_picks"].append({
                    "asset_id": asset_id,
                    "display": f"{yr} R{rnd} · {original_name}'s pick",
                    "year": yr, "round": rnd,
                    "original_owner": original_name,
                    "original_owner_fid": original_fid,
                    "is_own": original_fid == str(fid),
                })
    except Exception as e:
        out["future_picks_error"] = str(e)

    # Current-year remaining draft picks (from hub's live-state JSON)
    try:
        live_path = HUB_DIR / "rookie_draft_hub_2026.json"
        if live_path.exists():
            live = json.loads(live_path.read_text())
            for p in live.get("draft_order", []):
                if str(p.get("owned_by_franchise_id")) != str(fid):
                    continue
                rnd = p.get("round"); pick = p.get("pick")
                overall = p.get("pick_overall") or ((int(rnd) - 1) * 12 + int(pick))
                asset_id = f"DP_{str(rnd).zfill(2)}_{str(overall).zfill(2)}"
                out["current_picks"].append({
                    "asset_id": asset_id,
                    "display": f"{rnd}.{str(pick).zfill(2)} (overall #{overall})",
                    "round": rnd, "pick": pick,
                })
    except Exception as e:
        out["current_picks_error"] = str(e)

    return out


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(HUB_DIR), **kwargs)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(204)
        self.end_headers()

    def do_GET(self):
        path = urlparse(self.path).path
        from urllib.parse import parse_qs
        qs = parse_qs(urlparse(self.path).query)
        pid = (qs.get("pid") or [""])[0]
        year = (qs.get("year") or [str(mfl.CURRENT_YEAR)])[0]

        # Proxy MFL playerProfile (avoids CORS from browser)
        if path == "/api/player-profile":
            if not pid:
                return self._send_json(400, {"error": "missing pid"})
            try:
                import urllib.request
                url = (f"https://api.myfantasyleague.com/{year}/export"
                       f"?TYPE=playerProfile&P={pid}&JSON=1")
                with urllib.request.urlopen(url, timeout=15) as r:
                    body = r.read().decode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body.encode())))
                self.end_headers()
                self.wfile.write(body.encode())
                return
            except Exception as e:
                return self._send_json(502, {"error": str(e)})

        # Rich bundle: MFL profile + injuries + local DB (current status, weekly, txns)
        if path == "/api/player-bundle":
            if not pid:
                return self._send_json(400, {"error": "missing pid"})
            return self._send_json(200, build_player_bundle(pid, year))

        # Franchise assets (for trade asset picker) — players on roster + future
        # picks owned + current-year remaining picks + blind bid $ placeholder.
        if path == "/api/franchise-assets":
            fid = (qs.get("fid") or [""])[0]
            if not fid:
                return self._send_json(400, {"error": "missing fid"})
            return self._send_json(200, build_franchise_assets(fid, year))

        # Commissioner roster — hardcoded by franchise_id (the commish is a league
        # config, not an MFL-API-exposed field for this league). Update if commish
        # changes. Currently Keith Creelman (franchise 0008) runs the league.
        COMMISH_FIDS = {"0008"}
        # Logged-in user — returns the franchise + whether settings configured.
        # If no settings yet, TRY to auto-read the MFL_USER_ID cookie from the
        # local Chrome browser cookie store so the user doesn't have to paste it.
        if path == "/api/me":
            fid, cookie = _resolve_user_franchise()
            if not fid:
                browser_cookie = _try_read_mfl_cookie_from_browsers()
                if browser_cookie:
                    detected = _detect_mfl_user_from_cookie(browser_cookie)
                    if detected.get("franchise_id"):
                        cur = _load_settings()
                        cur["franchise_id"] = str(detected["franchise_id"])
                        cur["mfl_user_id"] = browser_cookie
                        cur["franchise_name"] = detected.get("franchise_name")
                        _save_settings(cur)
                        return self._send_json(200, {
                            "franchise_id": detected["franchise_id"],
                            "franchise_name": detected.get("franchise_name"),
                            "configured": True,
                            "auto_detected": True,
                        })
            resp: dict = {"franchise_id": fid, "configured": bool(fid)}
            if cookie:
                detected = _detect_mfl_user_from_cookie(cookie)
                if "franchise_id" in detected:
                    resp["franchise_name"] = detected.get("franchise_name")
            resp["is_commish"] = bool(fid and str(fid) in COMMISH_FIDS)
            return self._send_json(200, resp)

        return super().do_GET()

    def do_POST(self):
        path = urlparse(self.path).path
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length else b"{}"
        try:
            payload = json.loads(body or b"{}")
        except json.JSONDecodeError:
            return self._send_json(400, {"error": "invalid JSON body"})

        try:
            # Settings setter — save login info. Franchise is AUTO-DETECTED from
            # the MFL_USER_ID cookie (like the Trade Module does); the user just
            # provides the cookie and we resolve their franchise.
            if path == "/api/settings":
                cookie = payload.get("mfl_user_id", "").strip()
                if not cookie:
                    return self._send_json(400, {"error": "MFL_USER_ID cookie required"})
                detected = _detect_mfl_user_from_cookie(cookie)
                if "error" in detected:
                    return self._send_json(400, {"error": detected["error"]})
                fid = detected.get("franchise_id")
                if not fid:
                    return self._send_json(400, {"error": "MFL did not return a franchise for this cookie"})
                cur = _load_settings()
                cur["franchise_id"] = str(fid)
                cur["mfl_user_id"] = cookie
                cur["franchise_name"] = detected.get("franchise_name")
                _save_settings(cur)
                return self._send_json(200, {"ok": True, **detected})

            # For all write endpoints: resolve logged-in user's franchise + cookie,
            # and REJECT any request that tries to submit on behalf of a different
            # franchise. Prevents one owner from acting on another's team.
            my_fid, my_cookie = _resolve_user_franchise()
            if not my_fid:
                return self._send_json(401, {"error": "no logged-in user — configure settings first"})

            if path == "/api/pick":
                target = str(payload.get("franchise_id") or my_fid)
                if target != my_fid:
                    return self._send_json(403, {"error": f"you are logged in as {my_fid}; cannot submit for {target}"})
                r = mfl.submit_draft_pick(my_fid, payload["player_id"], user_id=my_cookie)
            elif path == "/api/trade":
                from_fid = str(payload.get("from_fid") or my_fid)
                if from_fid != my_fid:
                    return self._send_json(403, {"error": f"you are logged in as {my_fid}; cannot propose trades from {from_fid}"})
                r = mfl.submit_trade_proposal(
                    my_fid, str(payload["to_fid"]),
                    payload.get("give", []) or [], payload.get("receive", []) or [],
                    comments=payload.get("comments", ""),
                    expires_ts=payload.get("expires_ts"),
                    user_id=my_cookie)
            elif path == "/api/trade/respond":
                target = str(payload.get("to_fid") or my_fid)
                if target != my_fid:
                    return self._send_json(403, {"error": f"you are logged in as {my_fid}; cannot respond for {target}"})
                r = mfl.respond_to_trade(
                    str(payload["from_fid"]), my_fid,
                    accept=bool(payload.get("accept")),
                    comments=payload.get("comments", ""),
                    user_id=my_cookie)
            elif path == "/api/draft-list":
                target = str(payload.get("franchise_id") or my_fid)
                if target != my_fid:
                    return self._send_json(403, {"error": f"you are logged in as {my_fid}; cannot update {target}'s draft list"})
                r = mfl.update_draft_list(my_fid, payload.get("players", []) or [], user_id=my_cookie)
            else:
                return self._send_json(404, {"error": f"unknown endpoint {path}"})
        except KeyError as e:
            return self._send_json(400, {"error": f"missing field {e}"})
        except Exception as e:
            return self._send_json(500, {"error": str(e)})

        return self._send_json(200 if r.ok else 502, {
            "ok": r.ok,
            "status": r.status,
            "mfl_response": r.body,
            "mfl_url": r.url,
        })

    def _send_json(self, code: int, obj: dict):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8093)
    args = ap.parse_args()
    addr = ("0.0.0.0", args.port)
    print(f"Rookie Draft Hub bridge serving {HUB_DIR} on http://localhost:{args.port}/")
    server = ThreadingHTTPServer(addr, Handler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down")
        server.shutdown()


if __name__ == "__main__":
    main()
