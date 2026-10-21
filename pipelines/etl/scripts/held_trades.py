"""Trades held as NO GRADE, and their one retry after a fresh snapshot (Keith 2026-10-21).

A trade that gets VALUATION INPUTS UNAVAILABLE — NO GRADE is held: logged, recorded in
pipelines/etl/data/held_trades_no_grade.json, never posted. The bot's cursor moves past it
as before, so it is never picked up again as a "new" trade, and nothing older than the
cursor is ever regraded.

Once the valuation snapshot validates again (the weekly cutover), each held trade is
retried exactly once:
  - only while the snapshot validates: a still-stale snapshot leaves every entry pending,
    so a held trade is never used up or discarded merely because the snapshot is stale;
  - the entry is marked started BEFORE the retry, so a crash mid-retry can never post it
    twice (at most once, then a person decides);
  - the outcome is recorded: posted, held again (NO GRADE on the fresh snapshot), or
    error. None of them is retried automatically again.
  - a trade appears once in the file: holding it again updates its entry, never adds one.
The cursor file is never read or written here.
"""
import json
import os
from datetime import datetime, timezone
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
HELD_TRADES_FILE = SCRIPT_DIR.parent / "data" / "held_trades_no_grade.json"


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def load(path: Path = None) -> list:
    path = Path(path or HELD_TRADES_FILE)
    if not path.exists():
        return []
    data = json.loads(path.read_text())          # a corrupt file raises: never silently start over
    if not isinstance(data, list):
        raise ValueError(f"{path} is not a list of held trades")
    return data


def save(entries: list, path: Path = None) -> None:
    """Atomic replace, so a crash never leaves a half-written file."""
    path = Path(path or HELD_TRADES_FILE)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(entries, indent=1))
    os.replace(tmp, path)


def _key(entry_or_txn: dict) -> tuple:
    return (str(entry_or_txn.get("timestamp")), str(entry_or_txn.get("franchise")),
            str(entry_or_txn.get("franchise2")))


def record_hold(trade_txn: dict, report: str, path: Path = None) -> dict:
    """Hold a trade (or record that it was held again). Returns its entry."""
    entries = load(path)
    for e in entries:
        if _key(e) == _key(trade_txn):
            e.setdefault("holds", []).append({"held_at": _now(), "report": report})
            e["report"] = report
            save(entries, path)
            return e
    entry = {"timestamp": trade_txn.get("timestamp"), "franchise": trade_txn.get("franchise"),
             "franchise2": trade_txn.get("franchise2"), "held_at": _now(), "report": report}
    entries.append(entry)
    save(entries, path)
    return entry


def pending(entries: list) -> list:
    """Entries that have never been retried."""
    return [e for e in entries if "retry" not in e]


def _update(entry: dict, path: Path, **retry) -> dict:
    """Reload, update this trade's retry record, save. Reloading keeps a hold recorded
    during the retry (record_hold writes the file too)."""
    entries = load(path)
    for e in entries:
        if _key(e) == _key(entry):
            e.setdefault("retry", {}).update(retry)
            save(entries, path)
            return e
    raise KeyError(f"held trade {entry.get('timestamp')} is no longer in {path or HELD_TRADES_FILE}")


def mark_started(entry: dict, path: Path = None) -> dict:
    """Mark the single retry as started. Call BEFORE the attempt (at most once)."""
    return _update(entry, path, started_at=_now())


def mark_finished(entry: dict, outcome: str, path: Path = None) -> dict:
    return _update(entry, path, finished_at=_now(), outcome=outcome)


def retry_pending(*, validate, find_trade, grade_and_post, path: Path = None, log=print) -> list:
    """Retry each never-retried held trade once, only if the snapshot validates now.

    validate() -> list of failures (empty = the bot would grade now).
    find_trade(entry) -> the MFL trade transaction (or a multiway group), or None.
    grade_and_post(entry, trade) -> "posted" | "held_again".
    Returns [(timestamp, outcome)] for the entries attempted this call. (The bot runs the
    same steps around its async post: trade_roast_bot.retry_held_trades.)"""
    todo = pending(load(path))
    if not todo:
        return []
    failures = validate()
    if failures:
        log(f"{len(todo)} held trade(s) wait: the valuation snapshot does not validate yet "
            f"({'; '.join(str(f) for f in failures)[:300]})")
        return []
    done = []
    for entry in todo:
        trade = find_trade(entry)
        if trade is None:
            continue                               # not in MFL's list right now: stays pending
        mark_started(entry, path)                  # BEFORE the attempt: at most once
        try:
            outcome = grade_and_post(entry, trade)
        except Exception as exc:                   # recorded, not retried again automatically
            outcome = f"error: {exc.__class__.__name__}"
        mark_finished(entry, outcome, path)
        log(f"held trade {entry.get('timestamp')} retried once: {outcome}")
        done.append((entry.get("timestamp"), outcome))
    return done
