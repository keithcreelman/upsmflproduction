"""Trades held as NO GRADE, and their one retry after a fresh snapshot (Keith 2026-10-21/22).

A trade that gets VALUATION INPUTS UNAVAILABLE — NO GRADE is held: logged, recorded in
pipelines/etl/data/held_trades_no_grade.json, never posted.

Fails closed (Keith 2026-10-22):
  - the file must exist (created once, explicitly, by `python3 held_trades.py init` during the
    supervised cutover). Missing, unreadable, corrupt or unwritable is a HeldStateError, never
    "zero held trades";
  - a hold is written durably (fsync of the file and its folder, then read back) before the
    bot may advance its cursor past the trade. If that fails the bot keeps the cursor where it
    is and raises an operational alert.

Each held trade is retried exactly once, after the snapshot validates again:
  - only while the snapshot validates: a still-stale snapshot leaves every entry pending;
  - the entry is marked started BEFORE the attempt, so a crash mid-retry can never post it
    twice (at most once; a started-but-unfinished entry needs a person);
  - the outcome is recorded: posted, held again, or error. None is retried automatically.
  - trades are matched by their full key (timestamp, franchise, franchise2), never by
    timestamp alone; a multi-team trade is keyed by its group id.
The cursor file is never read or written here.

  python3 held_trades.py init     # create the empty file (once, during the supervised cutover)
  python3 held_trades.py status   # pending / unfinished / finished entries
"""
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
HELD_TRADES_FILE = SCRIPT_DIR.parent / "data" / "held_trades_no_grade.json"


class HeldStateError(RuntimeError):
    """The held-trades file cannot be trusted: never read as zero held trades."""


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _path(path) -> Path:
    return Path(path) if path is not None else HELD_TRADES_FILE


def load(path: Path = None) -> list:
    path = _path(path)
    if not path.exists():
        raise HeldStateError(f"{path.name} is missing (run `held_trades.py init` once, during the supervised cutover)")
    try:
        data = json.loads(path.read_text())
    except OSError as exc:
        raise HeldStateError(f"{path.name} is unreadable ({exc.__class__.__name__})")
    except ValueError as exc:
        raise HeldStateError(f"{path.name} is corrupt ({exc})")
    if not isinstance(data, list) or not all(isinstance(e, dict) for e in data):
        raise HeldStateError(f"{path.name} is not a list of held trades")
    return data


def save(entries: list, path: Path = None) -> None:
    """Durable atomic replace: write, fsync, rename, fsync the folder, read back."""
    path = _path(path)
    body = json.dumps(entries, indent=1)
    tmp = path.with_suffix(path.suffix + ".tmp")
    try:
        with open(tmp, "w") as fh:
            fh.write(body)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, path)
        dfd = os.open(str(path.parent), os.O_RDONLY)
        try:
            os.fsync(dfd)
        finally:
            os.close(dfd)
    except OSError as exc:
        raise HeldStateError(f"{path.name} is unwritable ({exc.__class__.__name__}: {exc.strerror or exc})")
    if load(path) != json.loads(body):
        raise HeldStateError(f"{path.name} did not read back as written")


def init(path: Path = None) -> bool:
    """Create the empty file if it does not exist. True if created."""
    path = _path(path)
    if path.exists():
        load(path)                                   # an existing file must be valid
        return False
    path.parent.mkdir(parents=True, exist_ok=True)
    save([], path)
    return True


def key(entry_or_txn: dict) -> tuple:
    """The stable key: timestamp + both franchise fields (a multi-team trade: 'multiway' + group id)."""
    return (str(entry_or_txn.get("timestamp")), str(entry_or_txn.get("franchise")),
            str(entry_or_txn.get("franchise2")))


def record_hold(trade_txn: dict, report: str, path: Path = None) -> dict:
    """Durably hold a trade (or record that it was held again). Raises HeldStateError if the
    hold could not be recorded: the caller must then NOT advance its cursor."""
    entries = load(path)
    for e in entries:
        if key(e) == key(trade_txn):
            e.setdefault("holds", []).append({"held_at": _now(), "report": report})
            e["report"] = report
            break
    else:
        e = {"timestamp": trade_txn.get("timestamp"), "franchise": trade_txn.get("franchise"),
             "franchise2": trade_txn.get("franchise2"), "held_at": _now(), "report": report}
        entries.append(e)
    save(entries, path)
    if not any(key(x) == key(trade_txn) for x in load(path)):
        raise HeldStateError(f"trade {key(trade_txn)} is not in {_path(path).name} after writing it")
    return e


def pending(entries: list) -> list:
    """Entries never retried."""
    return [e for e in entries if "retry" not in e]


def unfinished(entries: list) -> list:
    """Entries whose one retry started but never recorded an outcome (a crash mid-retry)."""
    return [e for e in entries if "retry" in e and "outcome" not in (e.get("retry") or {})]


def find_trade(entry: dict, trades: list, groups: dict | None = None):
    """The exact MFL trade (or multi-team group) for a held entry, by its full key; None if
    absent or ambiguous. Never by timestamp alone."""
    if entry.get("franchise") == "multiway":
        return (groups or {}).get(entry.get("franchise2")) or None
    hits = [t for t in trades if key(t) == key(entry)]
    return hits[0] if len(hits) == 1 else None


def _update(entry: dict, path: Path, **retry) -> dict:
    """Reload, update this trade's retry record, save (keeps a hold written during the retry)."""
    entries = load(path)
    for e in entries:
        if key(e) == key(entry):
            e.setdefault("retry", {}).update(retry)
            save(entries, path)
            return e
    raise HeldStateError(f"held trade {key(entry)} is no longer in {_path(path).name}")


def mark_started(entry: dict, path: Path = None) -> dict:
    """Mark the single retry as started. Call BEFORE the attempt (at most once)."""
    return _update(entry, path, started_at=_now())


def mark_finished(entry: dict, outcome: str, path: Path = None) -> dict:
    return _update(entry, path, finished_at=_now(), outcome=outcome)


def retry_pending(*, validate, trades: list, grade_and_post, groups: dict | None = None,
                  path: Path = None, log=print) -> list:
    """Retry each never-retried held trade once, only if the snapshot validates now.

    validate() -> list of failures (empty = the bot would grade now). trades: MFL's trade list.
    grade_and_post(entry, trade) -> "posted" | "held_again". Raises HeldStateError if the file
    cannot be trusted. Returns [(key, outcome)] for the entries attempted this call. (The bot
    runs the same steps around its async post: trade_roast_bot.retry_held_trades.)"""
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
        trade = find_trade(entry, trades, groups)
        if trade is None:
            continue                               # not (uniquely) in MFL's list: stays pending
        mark_started(entry, path)                  # BEFORE the attempt: at most once
        try:
            outcome = grade_and_post(entry, trade)
        except HeldStateError:
            raise
        except Exception as exc:                   # recorded, not retried again automatically
            outcome = f"error: {exc.__class__.__name__}"
        mark_finished(entry, outcome, path)
        log(f"held trade {key(entry)} retried once: {outcome}")
        done.append((key(entry), outcome))
    return done


def main(argv=None) -> int:
    cmd = (argv or sys.argv[1:] or ["status"])[0]
    try:
        if cmd == "init":
            print("created" if init() else "already present and valid", HELD_TRADES_FILE)
            return 0
        entries = load()
    except HeldStateError as exc:
        print(f"HELD-TRADES STATE ERROR: {exc}")
        return 2
    print(json.dumps({"file": str(HELD_TRADES_FILE), "entries": len(entries), "pending": [key(e) for e in pending(entries)],
                      "unfinished": [key(e) for e in unfinished(entries)],
                      "finished": [(key(e), e["retry"].get("outcome")) for e in entries
                                   if (e.get("retry") or {}).get("outcome")]}, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
