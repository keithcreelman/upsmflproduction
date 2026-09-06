#!/usr/bin/env python3
"""Fantasy ingestion CLI — Yahoo today, CBS/ESPN through the same commands later.

USAGE
  python3 pipelines/fantasy/cli.py auth                       # one-time authorization
  python3 pipelines/fantasy/cli.py discover --league-id 576919
  python3 pipelines/fantasy/cli.py backfill --league-id 576919
  python3 pipelines/fantasy/cli.py sync     --league-id 576919
  python3 pipelines/fantasy/cli.py report   --league-id 576919
  python3 pipelines/fantasy/cli.py verify   --from-dir data/yahoo-raw

  # identical, via the npm aliases in the root package.json
  npm run yahoo:auth
  npm run yahoo:backfill -- --league-id 576919
  npm run yahoo:sync     -- --league-id 576919

FAILURE MODES AND EXIT CODES — this is a contract, not documentation.
  0  did the right thing, INCLUDING a legitimate no-op that is logged loudly
  1  an input was unreadable, expected data was missing, or a read-back could
     not confirm the write
  2  authorization is missing or expired and a human must re-consent
  3  the provider is throttling; the run stopped deliberately and can resume

⚠️ "An unreadable input is NEVER an empty one." Do not make a red run green by
exiting 0. Every prior data-destruction incident in this repo traces to a guard
that treated an unreadable input as an empty one.

⚠️ --target DEFAULTS TO local. Writing to the production D1 requires typing
`--target remote`. That database holds every live UPS contract and cap ledger,
and this pipeline has no business touching any of it.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

_HERE = Path(__file__).resolve()
_REPO_ROOT = _HERE.parents[2]
sys.path.insert(0, str(_REPO_ROOT / "pipelines"))

from fantasy import d1 as fd1  # noqa: E402
from fantasy.providers import base as pbase  # noqa: E402
from fantasy.providers.espn.adapter import EspnProvider  # noqa: E402
from fantasy.providers.espn.auth import load_cookies as load_espn_cookies  # noqa: E402
from fantasy.providers.espn.client import ClientStats as EspnClientStats, EspnClient  # noqa: E402
from fantasy.providers.cbs.adapter import CbsProvider  # noqa: E402
from fantasy.providers.cbs.api import CbsApiClient, load_access_token  # noqa: E402
from fantasy.providers.cbs.auth import CbsAuthMissing, load_cookies as load_cbs_cookies  # noqa: E402
from fantasy.providers.cbs.client import CbsClient, ClientStats as CbsClientStats  # noqa: E402
from fantasy.providers.cbs.constants import DEFAULT_LEAGUE_ID as CBS_DEFAULT_LEAGUE_ID  # noqa: E402
from fantasy.providers.yahoo import oauth as yoauth  # noqa: E402
from fantasy.providers.yahoo.adapter import YahooProvider  # noqa: E402
from fantasy.providers.yahoo.client import ClientStats as YahooClientStats, TokenManager, YahooClient  # noqa: E402
from fantasy.quality import checks as qchecks  # noqa: E402
from fantasy.quality import completeness as qcomp  # noqa: E402
from fantasy.raw.sink import RawSink  # noqa: E402
from fantasy import adp as fadp  # noqa: E402
from fantasy.redact import redact_text  # noqa: E402
from fantasy.version import PARSER_VERSION, SCHEMA_VERSION  # noqa: E402

EXIT_OK, EXIT_DATA, EXIT_AUTH, EXIT_THROTTLED = 0, 1, 2, 3

#: The set of implemented platforms, and this CLI's default. Yahoo remains
#: the module-level default so every pre-existing call site that doesn't
#: thread `platform` explicitly (there are none left after this refactor,
#: but a future addition might miss one) fails toward the well-tested path
#: rather than an unbuilt one.
DEFAULT_PLATFORM = "yahoo"
PLATFORMS = ("yahoo", "espn", "cbs")


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _log(msg: str) -> None:
    print(f"[{_now()}] {redact_text(msg)}", flush=True)


def _new_run_id(platform: str, mode: str) -> str:
    return f"{platform}-{mode}-{datetime.now(timezone.utc):%Y%m%dT%H%M%SZ}-{uuid.uuid4().hex[:8]}"


# ─────────────────────────────────────────────────────────────────────────────
# Wiring
# ─────────────────────────────────────────────────────────────────────────────

def _build_provider(args, run_id: str):
    """Dispatch on args.platform. Returns (provider, raw_sink_or_None, stats).

    ⚠️ RawSink IS YAHOO-SPECIFIC (it writes to raw_yahoo_api_responses, a
    Yahoo-named table per the schema's naming convention — see migration
    0127's header). ESPN has no raw-archival layer in this lighter pass, so
    its branch returns sink=None; every call site that touches the sink
    (`_write_raw`) already guards for that.
    """
    if args.platform == "yahoo":
        creds = yoauth.ClientCredentials.from_env()
        store = yoauth.LocalTokenStore(account_key=args.account)
        stats = YahooClientStats()
        sink = RawSink(
            mode=args.raw_sink,
            archive_dir=Path(args.raw_dir),
            worker_cwd=_REPO_ROOT / "worker",
            run_id=run_id,
        )
        client = YahooClient(
            token_provider=TokenManager(creds, store),
            stats=stats,
            min_interval_sec=args.min_interval,
            raw_sink=sink,
            run_id=run_id,
        )
        return YahooProvider(client), sink, stats

    if args.platform == "espn":
        cookies = load_espn_cookies(account_key=args.account)
        if not cookies.is_present:
            _log("No ESPN_SWID/ESPN_S2 found (env or Keychain). Proceeding "
                 "unauthenticated — this only works for a PUBLIC league. For "
                 "a private league, see pipelines/fantasy/providers/espn/auth.py.")
        stats = EspnClientStats()
        client = EspnClient(cookies=cookies, stats=stats, min_interval_sec=args.min_interval)
        return EspnProvider(client), None, stats

    if args.platform == "cbs":
        # ⚠️ TWO CREDENTIALS, TWO TRANSPORTS. The access token reaches the JSON
        # API (current season); the `pid` cookie reaches the league website
        # (history). Neither authenticates the other's endpoints. The cookie is
        # OPTIONAL here — without it the current season still ingests fully and
        # only historical draft results become unreachable, which the adapter
        # reports as an access error rather than as an empty season.
        stats = CbsClientStats()
        api = CbsApiClient(load_access_token(account_key=args.account),
                           league_id=str(args.league_id or CBS_DEFAULT_LEAGUE_ID),
                           min_interval_sec=args.min_interval, stats=stats)
        try:
            html = CbsClient(load_cbs_cookies(account_key=args.account), stats=stats,
                             min_interval_sec=args.min_interval)
        except CbsAuthMissing as exc:
            _log(f"No CBS session cookie — history is unavailable this run ({exc})")
            html = None
        return (CbsProvider(api, html=html,
                            league_id=str(args.league_id or CBS_DEFAULT_LEAGUE_ID)),
                None, stats)

    raise ValueError(f"unknown platform {args.platform!r}; expected one of {PLATFORMS}")


def _loader(args) -> fd1.D1Loader:
    return fd1.D1Loader(
        target=args.target,
        db=args.db,
        worker_cwd=_REPO_ROOT / "worker",
        dry_run=args.dry_run,
        verbose=True,
    )


def _start_run(loader: fd1.D1Loader, run_id: str, platform: str, mode: str, args, **scope) -> None:
    loader.write_rows("fantasy_sync_runs", [{
        "run_id": run_id,
        "platform": platform,
        "mode": mode,
        "league_key": scope.get("league_key"),
        "season": scope.get("season"),
        "week": scope.get("week"),
        "requested_scope": json.dumps(
            {k: v for k, v in vars(args).items() if not k.startswith("_")},
            sort_keys=True, default=str),
        "started_at_utc": _now(),
        "status": "running",
        "parser_version": PARSER_VERSION,
        "runner_host": "github-actions" if os.environ.get("GITHUB_ACTIONS") else "local",
    }])


def _finish_run(
    loader: fd1.D1Loader, run_id: str, *, platform: str, mode: str, status: str,
    stats, written: dict, completeness: str | None = None,
    notes: str | None = None,
) -> None:
    # ⚠️ `mode` IS supplied even though this write must not change it. The
    # column is NOT NULL and SQLite evaluates an upsert's INSERT arm before it
    # detects the conflict, so omitting it fails the whole statement with
    # SQLITE_CONSTRAINT_NOTNULL. d1.IMMUTABLE_COLS keeps it out of the SET
    # clause, so the value written at run start survives. Both halves are
    # required; either alone is a bug (one crashes, the other corrupts).
    loader.write_rows("fantasy_sync_runs", [{
        "run_id": run_id,
        "platform": platform,
        "mode": mode,
        "finished_at_utc": _now(),
        "status": status,
        "rows_inserted": sum(written.values()),
        "api_calls": stats.api_calls,
        "api_retries": stats.retries,
        "error_count": len(stats.errors),
        "completeness_status": completeness,
        "parser_version": PARSER_VERSION,
        "notes": notes,
    }])
    if stats.errors:
        loader.write_rows("fantasy_api_errors", [
            {**e, "platform": platform, "run_id": run_id, "occurred_at_utc": _now()}
            for e in stats.errors
        ])


def _stamp_etl_runs(loader: fd1.D1Loader, source: str, status: str, detail: str) -> None:
    """Reuse the repo's existing per-source freshness registry.

    etl_runs already backs GET /api/data-freshness; stamping it means Yahoo
    staleness shows up on the existing surface with no new mechanism. `source`
    is a free-form TEXT primary key, so 'yahoo_backfill' namespaces cleanly
    with no migration.
    """
    if loader.dry_run:
        return
    safe = detail.replace("'", "''")[:400]
    try:
        loader.query(
            "INSERT OR REPLACE INTO etl_runs (source, last_run_utc, status, detail) "
            f"VALUES ('{source}', '{_now()}', '{status}', '{safe}');"
        )
    except fd1.D1Error as exc:
        # Non-fatal: a freshness stamp failing must not fail a good ingest, but
        # it must be VISIBLE rather than swallowed.
        _log(f"WARNING: could not stamp etl_runs[{source}]: {exc}")


# ─────────────────────────────────────────────────────────────────────────────
# Commands
# ─────────────────────────────────────────────────────────────────────────────

def cmd_auth(args) -> int:
    """One-time interactive authorization. No browser needed afterwards.

    ⚠️ ESPN HAS NO OAuth FLOW AT ALL — there is nothing to "authorize" the way
    Yahoo's authorization-code exchange works. `--platform espn` here only
    checks whether ESPN_SWID/ESPN_S2 are present (env or Keychain); it never
    prompts for a code, because there isn't one. The cookies must be pulled
    from your own browser and stored directly — see
    pipelines/fantasy/providers/espn/auth.py for the exact steps. Calling this
    command with --forget or without --status for ESPN is refused rather than
    silently running Yahoo's flow against the wrong platform.
    """
    if args.platform == "espn":
        cookies = load_espn_cookies(account_key=args.account)
        print(f"  espn_swid configured : {'yes' if cookies.swid else 'no'}")
        print(f"  espn_s2 configured   : {'yes' if cookies.espn_s2 else 'no'}")
        if not cookies.is_present:
            print("  → store both via `security add-generic-password` — see "
                  "pipelines/fantasy/providers/espn/auth.py for the exact steps")
        else:
            print("  → both present. A public league needs nothing further; a "
                  "private league will use these automatically.")
        return EXIT_OK if cookies.is_present else EXIT_AUTH

    if args.forget:
        yoauth.LocalTokenStore(account_key=args.account).forget()
        _log(f"Cleared the stored refresh token for account '{args.account}'.")
        print(yoauth.revocation_instructions())
        return EXIT_OK

    try:
        creds = yoauth.ClientCredentials.from_env()
    except pbase.AuthError as exc:
        _log(str(exc))
        return EXIT_AUTH

    store = yoauth.LocalTokenStore(account_key=args.account)
    if args.status:
        token = store.load()
        print(f"  client id configured : yes")
        print(f"  redirect_uri         : {creds.redirect_uri}")
        print(f"  refresh token stored : {'yes' if token else 'no'}")
        if not token:
            print("  → run `npm run yahoo:auth` to authorize")
        return EXIT_OK if token else EXIT_AUTH

    state = yoauth.new_state()
    url = yoauth.build_authorize_url(creds, state=state)
    print("\n1. Open this URL and grant READ-ONLY access:\n")
    print(f"   {url}\n")
    if creds.redirect_uri == yoauth.OOB_REDIRECT:
        print("2. Yahoo will show you a code. Paste it below.\n")
    else:
        print(f"2. You will be redirected to {creds.redirect_uri}.")
        print("   Copy the `code` query parameter from that URL and paste it below.\n")

    try:
        code = input("   Authorization code: ").strip()
    except (EOFError, KeyboardInterrupt):
        print()
        _log("Cancelled — nothing was stored.")
        return EXIT_AUTH
    if not code:
        _log("No code supplied; refusing to continue.")
        return EXIT_AUTH

    try:
        bundle = yoauth.exchange_code(creds, code)
    except pbase.ProviderError as exc:
        _log(f"Token exchange failed: {exc}")
        return EXIT_AUTH

    if not bundle.refresh_token:
        _log("Yahoo returned no refresh token. Without one, every run would need "
             "a browser. Re-register the app as an 'Installed Application'.")
        return EXIT_AUTH

    store.save(bundle.refresh_token)
    _log("Authorized. The refresh token is in your macOS Keychain; "
         "no browser is needed again.")
    _log(f"Access token valid until {datetime.fromtimestamp(bundle.expires_at_unix, timezone.utc):%H:%M:%SZ}.")
    return EXIT_OK


def cmd_discover(args) -> int:
    """Find every reachable league-season and write the discovery report.

    ⚠️ ESPN HAS NO DISCOVERY ENDPOINT, unlike Yahoo's users/games/leagues
    chain — there is no documented (or community-known) "which leagues does
    this cookie pair belong to" query. `--platform espn` therefore does the
    ESPN-appropriate thing instead: PROBE each season you supply via
    --seasons for the --league-id you already know, confirming access and
    capturing metadata rather than discovering anything new. --league-id and
    --seasons are both REQUIRED for ESPN discovery; there's nothing to loop
    over otherwise.
    """
    mode = "discover"
    run_id = _new_run_id(args.platform, mode)
    loader = _loader(args)
    provider, sink, stats = _build_provider(args, run_id)
    _start_run(loader, run_id, args.platform, mode, args)

    if args.platform == "espn":
        return _discover_espn(args, loader, provider, stats, run_id, mode)
    if args.platform == "cbs":
        return _discover_cbs(args, loader, provider, stats, run_id, mode)

    try:
        seasons = _parse_seasons(args.seasons) if args.seasons else None
        _log("Enumerating NFL game keys (never hardcoded — they are not derivable)…")
        games = provider.list_nfl_games(seasons)
        _log(f"  {len(games)} NFL game(s): "
             + ", ".join(f"{g['season']}={g['game_key']}" for g in sorted(games, key=lambda x: x['season'])))

        _log("Discovering leagues via the account's game list…")
        refs = provider.discover_leagues(seasons=seasons)
        _log(f"  {len(refs)} league-season(s) from users/games/leagues")

        # The renewal chain reaches seasons the account query misses — e.g. a
        # season played before this account joined, or after a commissioner
        # handoff. Neither mechanism alone is complete.
        seed = _pick_seed(refs, args.league_id)
        if seed:
            _log(f"Walking the renewal chain from {seed.league_key}…")
            extra = provider.follow_renewal_chain(seed)
            known = {r.league_key for r in refs}
            new = [r for r in extra if r.league_key not in known]
            refs.extend(new)
            _log(f"  {len(new)} additional league-season(s) from the renew chain")

        if args.league_id:
            refs = [r for r in refs if r.league_id == str(args.league_id)]
            _log(f"  filtered to league id {args.league_id}: {len(refs)} season(s)")

        if not refs:
            # ⚠️ Loud no-op, exit 1. Zero leagues after a successful set of API
            # calls means the filter is wrong or the account cannot see the
            # league — neither is a success.
            _log("No league-seasons found. This is NOT a success: either the "
                 "league id is wrong, or this Yahoo account is not a member of "
                 "that league (private leagues are readable only by members).")
            _finish_run(loader, run_id, platform=args.platform, mode=mode, status="failed", stats=stats, written={})
            return EXIT_DATA

        rows = [_league_row(r, run_id) for r in refs]
        written = {"fantasy_league_seasons": loader.write_rows("fantasy_league_seasons", rows)}
        written.update(_write_raw(loader, sink))

        print()
        print(_render_discovery(rows))
        print()

        _finish_run(loader, run_id, platform=args.platform, mode=mode, status="ok", stats=stats, written=written)
        _stamp_etl_runs(loader, f"{args.platform}_discover", "ok", f"{len(rows)} league-seasons")
        return EXIT_OK

    except pbase.AuthError as exc:
        _log(f"AUTH: {exc}")
        _finish_run(loader, run_id, platform=args.platform, mode=mode, status="failed", stats=stats, written={}, notes="auth")
        return EXIT_AUTH
    except pbase.RateLimitError as exc:
        _log(f"THROTTLED: {exc}")
        _finish_run(loader, run_id, platform=args.platform, mode=mode, status="partial", stats=stats, written={}, notes="rate limited")
        return EXIT_THROTTLED
    except pbase.ProviderError as exc:
        _log(f"FAILED: {exc}")
        _finish_run(loader, run_id, platform=args.platform, mode=mode, status="failed", stats=stats, written={})
        return EXIT_DATA


def _discover_espn(args, loader: "fd1.D1Loader", provider, stats, run_id: str, mode: str) -> int:
    """ESPN's version of discovery: probe known (league_id, season) pairs.

    Every season is attempted independently and a per-season failure does not
    abort the loop — a league that was created under a different id in an
    earlier season (common when a commissioner recreates a league) SHOULD
    show up as inaccessible for that season, not take down the whole command.
    """
    if not args.league_id:
        _log("--league-id is required for ESPN discovery (there is no "
             "account-wide discovery endpoint to fall back to).")
        _finish_run(loader, run_id, platform="espn", mode=mode, status="failed", stats=stats, written={})
        return EXIT_DATA
    seasons = _parse_seasons(args.seasons) if args.seasons else None
    if not seasons:
        _log("--seasons is required for ESPN discovery, e.g. --seasons 2020-2025.")
        _finish_run(loader, run_id, platform="espn", mode=mode, status="failed", stats=stats, written={})
        return EXIT_DATA

    rows = []
    for season in seasons:
        try:
            ref = provider.probe_league(season=season, league_id=str(args.league_id))
            rows.append(_league_row(ref, run_id))
            _log(f"  {season}: reachable — {ref.league_name or '(unnamed)'}")
        except pbase.ProviderError as exc:
            _log(f"  {season}: not reachable — {exc}")

    if not rows:
        _log("No season of this league id was reachable. This is NOT a "
             "success — the league id may be wrong for every season tried, "
             "or the league is private and ESPN_SWID/ESPN_S2 are unset.")
        _finish_run(loader, run_id, platform="espn", mode=mode, status="failed", stats=stats, written={})
        return EXIT_DATA

    written = {"fantasy_league_seasons": loader.write_rows("fantasy_league_seasons", rows)}
    print()
    print(_render_discovery(rows))
    print()
    _finish_run(loader, run_id, platform="espn", mode=mode, status="ok", stats=stats, written=written)
    _stamp_etl_runs(loader, "espn_discover", "ok", f"{len(rows)} league-seasons")
    return EXIT_OK


def cmd_backfill(args) -> int:
    return _ingest(args, mode="backfill")


def cmd_sync(args) -> int:
    return _ingest(args, mode="sync")


def _ingest(args, *, mode: str) -> int:
    run_id = _new_run_id(args.platform, mode)
    loader = _loader(args)
    provider, sink, stats = _build_provider(args, run_id)
    _start_run(loader, run_id, args.platform, mode, args)

    written: dict[str, int] = {}
    statuses: list[str] = []
    exit_code = EXIT_OK

    try:
        refs = _load_league_refs(loader, args)
        if not refs:
            _log("No league-seasons to process. Run `discover` first — an empty "
                 "work list is NOT a successful sync.")
            _finish_run(loader, run_id, platform=args.platform, mode=mode, status="failed", stats=stats, written={})
            return EXIT_DATA

        _log(f"{mode}: {len(refs)} league-season(s), parser {PARSER_VERSION}, "
             f"schema {SCHEMA_VERSION}, target={args.target}"
             + (" [DRY RUN]" if args.dry_run else ""))

        for ref in refs:
            _log(f"── {ref.season} · {ref.league_key} · {ref.league_name or '(unnamed)'}")
            outcomes: list[qcomp.ResourceOutcome] = []
            bundle: dict[str, list[dict]] = {}
            season_failed = False

            stream = (provider.backfill_season(ref) if mode == "backfill"
                      else provider.sync_season(ref, since_week=args.since_week))
            try:
                for result in stream:
                    for row in result.rows:
                        bundle.setdefault(row.get("_table", "?"), []).append(row)
                    counts = fd1.write_tagged_rows(loader, result.rows)
                    for t, n in counts.items():
                        written[t] = written.get(t, 0) + n
                    flag = "" if result.complete else "  [INCOMPLETE]"
                    note = f"  ({result.notes})" if result.notes else ""
                    _log(f"   {result.resource:<38} {len(result.rows):>6} rows{flag}{note}")
                    outcomes.append(_outcome_for(result))
            except pbase.AccessDeniedError as exc:
                # A season this account cannot read is a permanent, expected gap
                # for private leagues — not a failure of the run.
                _log(f"   ACCESS DENIED: {exc}")
                outcomes.append(qcomp.ResourceOutcome(
                    resource="league", access_denied=True, note=str(exc)[:300]))
                season_failed = True
            except pbase.RateLimitError as exc:
                _log(f"   THROTTLED, stopping cleanly: {exc}")
                statuses.append("partial")
                exit_code = EXIT_THROTTLED
                break

            written.update(_write_raw(loader, sink))

            comp_rows = qcomp.build_rows(
                league_key=ref.league_key, season=ref.season,
                outcomes=outcomes, run_id=run_id,
            ) + qcomp.not_exposed_rows(
                league_key=ref.league_key, season=ref.season, run_id=run_id
            )
            loader.write_rows("fantasy_data_completeness", comp_rows)
            statuses.append(qcomp.rollup(comp_rows))

            report = qchecks.run_all(bundle, is_auction=_is_auction(bundle), platform=args.platform)
            # check_cross_contamination needs a LIVE query against current D1
            # state (fantasy_* rows must all carry a known platform; no UPS
            # table may carry a fantasy platform row) -- every other check in
            # run_all() works on the in-memory `bundle` this run just parsed,
            # so this one genuinely could not be folded into that loop. It was
            # simply never called from anywhere (verified 2026-08-28: zero
            # callers repo-wide), which made it dead code despite being the
            # one check explicitly built to refuse rather than pass when it
            # cannot verify separation.
            #
            # loader.query() always runs a real read regardless of --dry-run
            # (dry_run only gates WRITES; see D1Loader._run) -- correct here,
            # since this validates COMMITTED state, not this run's own effect.
            for finding in qchecks.check_cross_contamination(loader.query):
                report.add(finding)
            if report.findings:
                _log("   quality:")
                print(report.render())
            if not report.ok:
                _log(f"   {len(report.errors)} quality ERROR(s) — see above")
                exit_code = max(exit_code, EXIT_DATA)
            if season_failed:
                exit_code = max(exit_code, EXIT_DATA)

        # ── read-back verification ──────────────────────────────────────────
        # ⚠️ A clean wrangler exit means the statement RAN, not that rows landed.
        # 'write failed' and 'could not confirm the write' are different claims
        # and both are different from success.
        if not args.dry_run and written:
            _log("Verifying what landed…")
            for table in sorted(written):
                try:
                    n = loader.table_count(table, f"platform = '{args.platform}'")
                    _log(f"   {table:<38} {n:>8} rows in D1")
                except fd1.D1Error as exc:
                    _log(f"   {table:<38} COULD NOT CONFIRM: {exc}")
                    exit_code = max(exit_code, EXIT_DATA)

        overall = ("failed" if exit_code == EXIT_DATA else
                   "partial" if "partial" in statuses or exit_code == EXIT_THROTTLED else "ok")
        _finish_run(loader, run_id, platform=args.platform, mode=mode, status=overall, stats=stats, written=written,
                    completeness=",".join(sorted(set(statuses))) or None)
        _stamp_etl_runs(loader, f"{args.platform}_{mode}", "ok" if exit_code == EXIT_OK else "error",
                        f"{sum(written.values())} rows across {len(written)} tables")

        print()
        _log(f"{mode} finished: {sum(written.values())} rows, "
             f"{stats.api_calls} API calls, {stats.retries} retries, "
             f"{len(stats.errors)} errors → exit {exit_code}")
        # ⚠️ sink is None for ESPN in this pass (no raw-archival layer built
        # yet — see _build_provider). Only Yahoo has something to summarize.
        if sink is not None:
            _log(f"raw archive: {sink.summary()}")
        return exit_code

    except pbase.AuthError as exc:
        _log(f"AUTH: {exc}")
        _finish_run(loader, run_id, platform=args.platform, mode=mode, status="failed", stats=stats, written=written, notes="auth")
        return EXIT_AUTH
    except pbase.ProviderError as exc:
        _log(f"FAILED: {exc}")
        _finish_run(loader, run_id, platform=args.platform, mode=mode, status="failed", stats=stats, written=written)
        return EXIT_DATA



def cmd_adp(args) -> int:
    """Pull external ADP into fantasy_adp.

    ⚠️ Platform-agnostic on purpose — ADP is market data about NFL players, not
    about one provider's league, so this command ignores --platform entirely.
    """
    loader = _loader(args)
    run_id = _new_run_id("adp", "adp")
    seasons = _parse_seasons(args.seasons) if args.seasons else [args.season]
    total = 0
    failures = []
    for season in seasons:
        try:
            res = fadp.fetch(args.source, season, scoring=args.scoring,
                             teams=args.teams, run_id=run_id)
        except fadp.AdpSourceUnavailable as e:
            # Not a crash — a configuration state the user can fix. Reported
            # loudly and NEVER downgraded to "0 rows", which would read as
            # "the market has no opinion" instead of "we could not ask".
            _log(f"{args.source} {season}: UNAVAILABLE\n{e}")
            failures.append((season, "unavailable"))
            continue
        except fadp.AdpError as e:
            _log(f"{args.source} {season}: FAILED — {e}")
            failures.append((season, "failed"))
            continue
        _log(f"{args.source} {season} {args.scoring} {args.teams}-team: {len(res.rows)} players")
        if not args.dry_run:
            n = loader.write_rows("fantasy_adp", res.rows)
            _log(f"   wrote {n} rows to fantasy_adp")
        total += len(res.rows)
    if failures and not total:
        return EXIT_DATA
    _log(f"adp finished: {total} rows from {args.source}")
    return EXIT_OK


def cmd_report(args) -> int:
    """Season-discovery and completeness reports, read back from D1."""
    loader = _loader(args)
    where = f"platform = '{args.platform}'"
    if args.league_id:
        where += f" AND league_id = '{args.league_id}'"
    try:
        seasons = loader.query(
            "SELECT season, game_key, league_key, league_name, num_teams, "
            "draft_type, is_auction_draft, backfill_status, is_accessible, notes "
            f"FROM fantasy_league_seasons WHERE {where} ORDER BY season;"
        )
        comp = loader.query(
            "SELECT season, resource, status, expected_units, observed_units, "
            "row_count, missing_notes FROM fantasy_data_completeness "
            f"WHERE platform = '{args.platform}' ORDER BY season, resource;"
        )
    except fd1.D1Error as exc:
        _log(f"Could not read the reports: {exc}")
        return EXIT_DATA

    print("\n=== SEASON DISCOVERY ===")
    print(_render_discovery(seasons) if seasons else "  (none — run `discover`)")
    print("\n=== COMPLETENESS ===")
    print(qcomp.render_report(comp) if comp else "  (none — run `backfill`)")
    print()
    return EXIT_OK


def cmd_verify(args) -> int:
    """Run the quality checks against archived raw payloads — no network."""
    from fantasy.providers.yahoo import parse as yparse
    from fantasy.providers.yahoo.shape import unwrap_content
    from fantasy.raw.sink import read_archived

    root = Path(args.from_dir)
    if not root.exists():
        _log(f"Raw archive not found: {root}. This is a refusal, not an empty run.")
        return EXIT_DATA
    files = sorted(root.rglob("*.json.gz"))
    if not files:
        _log(f"No archived payloads under {root}. Refusing to report success "
             "over an empty scan.")
        return EXIT_DATA

    _log(f"Re-parsing {len(files)} archived payload(s) with parser {PARSER_VERSION}…")
    bundle: dict[str, list[dict]] = {}
    failures = 0
    for path in files:
        try:
            content = unwrap_content(json.loads(read_archived(path)))
        except Exception as exc:  # noqa: BLE001 — any failure is a real failure
            _log(f"  UNREADABLE {path.name}: {redact_text(exc)[:160]}")
            failures += 1
            continue
        name = path.name
        try:
            if "draftresults" in name:
                tables = yparse.parse_draft_results(
                    content, league_key="?", season=0, is_auction=None)
            elif "transactions" in name:
                tables = yparse.parse_transactions(content, league_key="?", season=0)
            elif "teams.roster" in name:
                tables = yparse.parse_rosters(content, league_key="?", season=0, week=0)
            elif "scoreboard" in name:
                tables = yparse.parse_scoreboard(content, league_key="?", season=0)
            else:
                continue
        except Exception as exc:  # noqa: BLE001
            _log(f"  PARSE FAILED {path.name}: {redact_text(exc)[:160]}")
            failures += 1
            continue
        for table, rows in tables.items():
            bundle.setdefault(table, []).extend(rows)

    report = qchecks.run_all(bundle)
    print()
    print(report.render())
    print()
    _log(f"{failures} unreadable payload(s), {len(report.errors)} error finding(s)")
    return EXIT_OK if (report.ok and failures == 0) else EXIT_DATA


# ─────────────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────────────

def _parse_seasons(text: str) -> list[int]:
    """Accepts '2019', '2019,2021', '2014-2025' and combinations."""
    out: set[int] = set()
    for part in str(text).split(","):
        part = part.strip()
        if not part:
            continue
        if "-" in part:
            lo, hi = part.split("-", 1)
            out.update(range(int(lo), int(hi) + 1))
        else:
            out.add(int(part))
    return sorted(out)


def _pick_seed(refs, league_id):
    if not refs:
        return None
    candidates = [r for r in refs if not league_id or r.league_id == str(league_id)]
    if not candidates:
        return None
    return max(candidates, key=lambda r: r.season or 0)


def _league_row(ref, run_id: str) -> dict:
    raw = ref.raw or {}
    return {
        "platform": ref.platform,
        "league_key": ref.league_key,
        "season": ref.season,
        "game_key": ref.game_key,
        "game_code": raw.get("game_code"),
        "league_id": ref.league_id,
        "league_name": ref.league_name,
        "league_url": raw.get("league_url"),
        "num_teams": raw.get("num_teams"),
        "scoring_type": raw.get("scoring_type"),
        "league_type": raw.get("league_type"),
        "start_week": raw.get("start_week"),
        "end_week": raw.get("end_week"),
        "current_week": raw.get("current_week"),
        "renew_key": ref.renew_key,
        "renewed_key": ref.renewed_key,
        "my_team_key": ref.my_team_key,
        "discovery_source": ref.discovery_source,
        "is_accessible": 1 if ref.is_accessible else 0,
        "backfill_status": "pending",
        "updated_at_utc": _now(),
    }


def _discover_cbs(args, loader: "fd1.D1Loader", provider, stats, run_id: str, mode: str) -> int:
    """CBS discovery is a single probe of the league you already named.

    ⚠️ NO --seasons LOOP HERE, DELIBERATELY. CBS's JSON API ignores every
    season parameter and answers a 2019 request with the current season's data
    at HTTP 200. Looping seasons like the ESPN path does would register
    fourteen league-seasons that are all the same season wearing different
    stamps. The adapter reads the season out of CBS's own schedule dates, and
    exactly one row is written. Past seasons are reachable only through the
    HTML history path (see scripts/cbs_draft_backfill.py).
    """
    try:
        ref = provider.probe_league(league_id=str(args.league_id or CBS_DEFAULT_LEAGUE_ID))
    except pbase.ProviderError as exc:
        _log(f"CBS league not reachable: {exc}")
        _finish_run(loader, run_id, platform="cbs", mode=mode, status="failed",
                    stats=stats, written={})
        return EXIT_DATA

    _log(f"  {ref.season}: reachable — {ref.league_name or '(unnamed)'} "
         f"(the season CBS is serving, read from its own schedule)")
    rows = [_league_row(ref, run_id)]
    written = {"fantasy_league_seasons": loader.write_rows("fantasy_league_seasons", rows)}
    print()
    print(_render_discovery(rows))
    print()
    _finish_run(loader, run_id, platform="cbs", mode=mode, status="ok",
                stats=stats, written=written)
    _stamp_etl_runs(loader, "cbs_discover", "ok", f"{ref.season} {ref.league_key}")
    return EXIT_OK


def _load_league_refs(loader: fd1.D1Loader, args) -> list[pbase.LeagueRef]:
    where = f"platform = '{args.platform}'"
    if args.league_id:
        where += f" AND league_id = '{args.league_id}'"
    if args.seasons:
        seasons = ",".join(str(s) for s in _parse_seasons(args.seasons))
        where += f" AND season IN ({seasons})"
    if not args.include_inaccessible:
        where += " AND (is_accessible IS NULL OR is_accessible = 1)"
    rows = loader.query(
        "SELECT platform, league_key, season, game_key, league_id, league_name, "
        "renew_key, renewed_key, my_team_key, discovery_source, start_week, "
        f"end_week, current_week FROM fantasy_league_seasons WHERE {where} ORDER BY season;"
    )
    return [
        pbase.LeagueRef(
            platform=args.platform,
            league_key=r["league_key"],
            season=int(r.get("season") or 0),
            game_key=str(r.get("game_key") or ""),
            league_id=str(r.get("league_id") or ""),
            league_name=r.get("league_name"),
            my_team_key=r.get("my_team_key"),
            renew_key=r.get("renew_key"),
            renewed_key=r.get("renewed_key"),
            discovery_source=r.get("discovery_source") or "d1",
            is_accessible=True,
            raw=r,
        ) for r in rows
    ]


def _write_raw(loader: fd1.D1Loader, sink) -> dict[str, int]:
    """Drain the raw-payload sink into D1. `sink=None` is a valid input — it
    means this platform has no raw-archival layer in this pass (currently
    ESPN — see _build_provider) and the call is simply a no-op."""
    if sink is None:
        return {}
    rows = sink.drain()
    if not rows:
        return {}
    return {"raw_yahoo_api_responses": loader.write_rows("raw_yahoo_api_responses", rows)}


def _outcome_for(result) -> qcomp.ResourceOutcome:
    return qcomp.ResourceOutcome(
        resource=result.resource.split(".")[-1],
        row_count=len(result.rows),
        errored=False,
        note=result.notes,
    ) if result.complete else qcomp.ResourceOutcome(
        resource=result.resource.split(".")[-1],
        row_count=len(result.rows),
        expected_units=1,
        observed_units=0 if not result.rows else 1,
        note=result.notes,
    )


def _is_auction(bundle: dict) -> int | None:
    rows = bundle.get("fantasy_league_settings") or []
    return rows[0].get("is_auction_draft") if rows else None


def _render_discovery(rows) -> str:
    if not rows:
        return "  (none)"
    header = (f"  {'season':<8}{'game':<7}{'league_key':<20}{'name':<26}"
              f"{'tms':>4}  {'draft':<10}{'access':<8}{'backfill':<12}notes")
    out = [header, "  " + "-" * (len(header) - 2)]
    for r in sorted(rows, key=lambda x: x.get("season") or 0):
        access = ("yes" if r.get("is_accessible") in (1, "1", True)
                  else "NO" if r.get("is_accessible") in (0, "0") else "?")
        draft = r.get("draft_type") or ""
        if r.get("is_auction_draft") in (1, "1"):
            draft = (draft + " (auction)").strip()
        out.append(
            f"  {(r.get('season') or ''):<8}{(r.get('game_key') or ''):<7}"
            f"{(r.get('league_key') or ''):<20}{(r.get('league_name') or '')[:25]:<26}"
            f"{(r.get('num_teams') or ''):>4}  {draft[:9]:<10}{access:<8}"
            f"{(r.get('backfill_status') or ''):<12}{(r.get('notes') or '')[:30]}"
        )
    return "\n".join(out)


# ─────────────────────────────────────────────────────────────────────────────

def _common_parser() -> argparse.ArgumentParser:
    """The flags every subcommand shares (--platform, --target, etc.).

    ⚠️ WHY THIS IS A SEPARATE PARENT PARSER, NOT JUST ARGUMENTS ON `p`. Adding
    these only to the top-level parser `p` means argparse only recognizes them
    BEFORE the subcommand name (`--target remote discover ...`), and silently
    rejects the equally natural `discover --target remote ...` with
    "unrecognized arguments" — exactly what happened on Keith's first real
    remote push (2026-08-12): the migrations had already landed cleanly, and
    the very next command failed on flag ordering, not on anything about D1 or
    ESPN. Passing `parents=[common]` to EVERY subparser below registers each
    flag on both the top parser and every subcommand, so both orderings work.

    ⚠️ default=argparse.SUPPRESS IS NOT OPTIONAL — a bare `default=...` here
    would reintroduce a WORSE bug than the one this function exists to fix.
    argparse gives the top parser and each subparser their OWN independent
    copy of every `parents=[common]` argument, each with its own default. If
    the flag is supplied before the subcommand (parsed by the top parser) and
    NOT repeated after it, the subparser — seeing no occurrence in its own
    slice of argv — silently writes ITS OWN default over the value the top
    parser already set, because a normal default always fires when the flag
    is absent from that parser's view. The first version of this function did
    exactly that: `--platform espn --target remote backfill ...` silently
    became platform='yahoo' the moment the subparser ran, and it only surfaced
    because the ESPN branch never got a chance to try — the code went straight
    into loading YAHOO credentials, which don't exist, and crashed loudly.
    That was luck, not correctness: had Yahoo credentials been configured, it
    would have silently attempted a Yahoo run using an ESPN league id instead
    of failing. SUPPRESS on this shared definition means "absent here" writes
    NOTHING to the namespace rather than a default, so whichever parser
    actually saw the flag is the one whose value survives — the true defaults
    are established exactly once, via p.set_defaults() below, before parsing
    starts, and are only ever overwritten by a flag genuinely present in argv.
    """
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--platform", choices=list(PLATFORMS), default=argparse.SUPPRESS,
                        help="provider to use (cbs not implemented yet)")
    common.add_argument("--account", default=argparse.SUPPRESS,
                        help="local label for the stored credential; NOT an email. "
                             "For Yahoo: Keychain-suffix for the OAuth refresh token. "
                             "For ESPN: Keychain-suffix for ESPN_SWID/ESPN_S2.")
    common.add_argument("--target", choices=["local", "remote"], default=argparse.SUPPRESS,
                        help="D1 target. Defaults to local ON PURPOSE — the remote "
                             "database holds live UPS contract data.")
    common.add_argument("--db", default=argparse.SUPPRESS)
    common.add_argument("--dry-run", action="store_true", default=argparse.SUPPRESS,
                        help="build the SQL and report, but write nothing")
    common.add_argument("--raw-sink", choices=["file", "r2", "d1", "none"], default=argparse.SUPPRESS,
                        help="Yahoo only (ESPN has no raw-archival layer). "
                             "DEFAULT none: keep the provenance index row but do "
                             "NOT retain Yahoo response bodies, per Exhibit A "
                             "§2.c.vii of the signed agreement. file/r2/d1 turn "
                             "body retention back on — a legal-exposure choice, "
                             "not a tuning knob.")
    common.add_argument("--raw-dir", default=argparse.SUPPRESS, help="Yahoo only")
    common.add_argument("--min-interval", type=float, default=argparse.SUPPRESS,
                        help="seconds between API requests (conservative default; "
                             "neither platform documents a rate limit)")
    return common


def build_parser() -> argparse.ArgumentParser:
    common = _common_parser()
    p = argparse.ArgumentParser(
        prog="fantasy",
        description="Multi-platform fantasy-league ingestion (Yahoo + ESPN implemented; "
                     "ESPN is a lighter first pass — see docs/fantasy_provider_adapter_plan.md).",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
        parents=[common],
    )
    # ⚠️ NO p.set_defaults() HERE — DELIBERATELY. The first attempt at this
    # fix called it, and it silently reintroduced the exact bug this function
    # exists to prevent: ArgumentParser.set_defaults(**kw) does not just record
    # a dict, it also walks self._actions and sets action.default = value for
    # any matching dest. Because parents=[common] does not deep-copy Action
    # objects — every parser built from `common` (the top parser AND every
    # subparser) shares the literal SAME Action instances — that one call
    # silently un-suppressed --platform's default (back to 'yahoo') on EVERY
    # parser at once, defeating the whole point. Confirmed by inspecting the
    # constructed parser directly: after set_defaults(), the "backfill"
    # subparser's own --platform action reported default='yahoo', not
    # SUPPRESS, despite never being told to. True defaults are applied AFTER
    # parsing instead — see _apply_true_defaults() — which needs no
    # cooperation from argparse's internals and is trivial to test directly.

    sub = p.add_subparsers(dest="command", required=True)

    a = sub.add_parser("auth", help="one-time authorization", parents=[common])
    a.add_argument("--status", action="store_true", help="report credential presence only")
    a.add_argument("--forget", action="store_true", help="delete the stored refresh token")
    a.set_defaults(func=cmd_auth)

    d = sub.add_parser("discover", help="find reachable league-seasons", parents=[common])
    d.add_argument("--league-id", help="numeric league id, e.g. 576919")
    d.add_argument("--seasons", help="'2019', '2019,2021' or '2014-2025'")
    d.set_defaults(func=cmd_discover)

    b = sub.add_parser("backfill", help="full historical capture", parents=[common])
    b.add_argument("--league-id")
    b.add_argument("--seasons")
    b.add_argument("--include-inaccessible", action="store_true")
    b.add_argument("--since-week", type=int, default=None)
    b.set_defaults(func=cmd_backfill)

    s = sub.add_parser("sync", help="incremental refresh of mutable state", parents=[common])
    s.add_argument("--league-id")
    s.add_argument("--seasons")
    s.add_argument("--include-inaccessible", action="store_true")
    s.add_argument("--since-week", type=int, default=None)
    s.set_defaults(func=cmd_sync)

    p_adp = sub.add_parser("adp", help="pull external ADP (market cost) into fantasy_adp",
                           parents=[common])
    p_adp.add_argument("--source", choices=sorted(fadp.SOURCES), default="ffc",
                       help="ffc needs no key; fantasypros is the cross-site AGGREGATE "
                            "but requires FANTASYPROS_API_KEY (fails closed, never "
                            "silently falls back to ffc)")
    p_adp.add_argument("--season", type=int,
                       default=datetime.now(timezone.utc).year)
    p_adp.add_argument("--seasons", help="range like 2024-2026 (overrides --season)")
    p_adp.add_argument("--scoring", choices=list(fadp.SCORING), default="ppr")
    p_adp.add_argument("--teams", type=int, default=12)
    p_adp.set_defaults(func=cmd_adp)

    r = sub.add_parser("report", help="discovery + completeness reports", parents=[common])
    r.add_argument("--league-id")
    r.set_defaults(func=cmd_report)

    v = sub.add_parser("verify", help="re-parse the raw archive and run quality checks", parents=[common])
    v.add_argument("--from-dir", default="data/yahoo-raw")
    v.set_defaults(func=cmd_verify)

    return p


#: The real defaults, applied exactly once, after parsing — never inside
#: argparse's own default machinery. See the long comment on _common_parser
#: and build_parser for exactly why: any attempt to make argparse itself
#: apply these (a bare `default=...` on the shared parent actions, OR
#: `set_defaults()` on any parser built from them) mutates a shared Action
#: object that every parser — top-level and every subcommand — references,
#: silently clobbering a value the user actually supplied. This dict is the
#: single source of truth for what "not specified anywhere" means, and
#: getattr-with-default below can never be surprised by argparse internals.
#:
#: ⚠️ raw_sink DEFAULTS TO "none" ON PURPOSE — it is a CONTRACT default, not a
#: performance one. Exhibit A §2.c.vii of the executed Yahoo API Access and Use
#: Agreement says "Developer shall not store, cache or index the Yahoo Fantasy
#: Information." Mode "none" still writes the raw INDEX row (run id, resource,
#: request hash, byte count, timestamp) so provenance and idempotency survive —
#: it only declines to retain Yahoo's response BODIES. Passing --raw-sink file
#: (or r2/d1) re-enables body retention and is a decision about legal exposure,
#: not a tuning knob: make it deliberately, per §13's narrower "only as
#: necessary for the Approved Use Case" retention allowance, and remember §6
#: requires deleting everything within 10 business days of termination.
TRUE_DEFAULTS = {
    "platform": DEFAULT_PLATFORM, "account": "primary", "target": "local",
    "db": fd1.DEFAULT_DB, "dry_run": False, "raw_sink": "none",
    "raw_dir": "data/yahoo-raw", "min_interval": 1.0,
}


def _apply_true_defaults(args: argparse.Namespace) -> argparse.Namespace:
    """Fill in any flag the user never supplied, on either side of the subcommand.

    Because every shared flag is defined with default=argparse.SUPPRESS, an
    unsupplied flag leaves NO attribute on the namespace at all — never a
    silently-wrong value. This is the only place that turns "attribute
    absent" into "the real default," and it is trivial to unit test directly
    against a parsed Namespace, with no dependency on argparse's internals.
    """
    for key, value in TRUE_DEFAULTS.items():
        if not hasattr(args, key):
            setattr(args, key, value)
    return args


def main(argv=None) -> int:
    args = _apply_true_defaults(build_parser().parse_args(argv))
    started = time.time()
    try:
        code = args.func(args)
    except KeyboardInterrupt:
        _log("Interrupted. Anything already written is committed and idempotent; "
             "re-running resumes safely.")
        return EXIT_DATA
    _log(f"done in {time.time() - started:.1f}s (exit {code})")
    return code


if __name__ == "__main__":
    sys.exit(main())
