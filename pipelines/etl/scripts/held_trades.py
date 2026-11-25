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

Only a trade held BECAUSE THE SNAPSHOT WAS MISSING OR STALE is retried automatically
(Keith 2026-10-22). Each hold records its cause, classified from the NO GRADE reasons:
  - snapshot_missing: the snapshot file was missing;
  - snapshot_stale: every reason was the snapshot's own "stale:" check (too old, or behind the
    weeks MFL counts as complete);
  - other: anything else (a player or pick the snapshot cannot value, a corrupt or edited
    snapshot, unreadable standings, an unrecognized reason). Never retried automatically: the
    bot raises an operational alert when it holds one, and it waits for a person.
An entry with no recorded cause is "other". Unrecognized always means not eligible.

Each eligible held trade is retried exactly once, after the snapshot validates again:
  - only while the snapshot validates: a still-stale snapshot leaves every entry pending;
  - the entry is marked started BEFORE the attempt, so a crash mid-retry can never post it
    twice (at most once; a started-but-unfinished entry needs a person);
  - the outcome is recorded: posted, held again, or error. None is retried automatically.
  - trades are matched by their full key (timestamp, franchise, franchise2), never by
    timestamp alone; a multi-team trade is keyed by its group id.
The cursor file is never read or written here.

The as-of catch-up (Keith 2026-11-25; held_trade_catchup.py, trade_asof_inputs.py) changes what a
retry grades on and when a retry counts as used:
  - a retry grades on the inputs committed before the trade, never on today's standings;
  - standings_lag (the bot read MFL standings more than 6 hours after the trade, e.g. it was
    down) is recorded as its own cause; it is NOT retried automatically (the 2026-10-22 ruling
    stands) and can be posted as an approved bundle;
  - each posting step is journaled durably as it happens (announcement, thread, roast, GIF ids),
    and every message carries a reference marker, so an interrupted post RESUMES (finding its own
    messages first) instead of posting twice or needing a person. A retry is used up only when
    "posted" is recorded, or by a final no-grade ("held_again"), or after MAX_ATTEMPTS failures;
  - a trade a person holds for review (cause held_for_keith_review) is posted only from a bundle
    whose exact sha256 has an approval record; its journal is the "catchup" section.
Every read-modify-write of the file holds an exclusive lock (<file>.lock), so the bot and a person
running a command at the same time cannot lose each other's writes.

  python3 held_trades.py init     # create the empty file (once, during the supervised cutover)
  python3 held_trades.py status   # pending / unfinished / finished entries
"""
import fcntl
import json
import os
import re
import sys
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
HELD_TRADES_FILE = SCRIPT_DIR.parent / "data" / "held_trades_no_grade.json"

# The only causes retried automatically. valuation_snapshot.load_snapshot / validate_snapshot
# word these reasons; test_bot_snapshot_cutover pins the exact strings they produce.
RETRY_CAUSES = ("snapshot_missing", "snapshot_stale")
# standings_lag (the bot read MFL's standings more than 6 hours after the trade, e.g. it was down) is
# recorded as its own cause. The as-of path can grade it, but Keith's 2026-10-22 ruling retries only a
# missing or stale snapshot automatically, so it stays a person's decision until he rules otherwise.
REVIEW_CAUSE = "held_for_keith_review"     # posted only from an approved catch-up bundle
MAX_ATTEMPTS = 3                           # failed posting attempts before a person is needed
_MISSING = re.compile(r"valuation snapshot \([^()]+\): file is missing")      # load_snapshot
_STALE = "valuation snapshot: stale: "                                          # validate_snapshot
# trade_grader.load_season_state, read more than STANDINGS_MAX_LAG_SECONDS after the trade
_LAG = re.compile(r".*standings were read \d+h after the trade and may include later weeks.*")


class HeldStateError(RuntimeError):
    """The held-trades file cannot be trusted: never read as zero held trades."""


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _path(path) -> Path:
    return Path(path) if path is not None else HELD_TRADES_FILE


@contextmanager
def locked(path: Path = None):
    """Exclusive lock for a read-modify-write of the held file (blocks until free)."""
    path = _path(path)
    fd = os.open(str(path) + ".lock", os.O_RDWR | os.O_CREAT, 0o644)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX)
        yield
    finally:
        fcntl.flock(fd, fcntl.LOCK_UN)
        os.close(fd)


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


def classify(reasons) -> str:
    """The cause of a NO GRADE from its reasons: snapshot_missing, snapshot_stale or other.
    Eligible only if EVERY reason is the snapshot's own missing-file or stale check."""
    reasons = [str(r) for r in (reasons or [])]
    if len(reasons) == 1 and _MISSING.fullmatch(reasons[0]):
        return "snapshot_missing"
    if reasons and all(r.startswith(_STALE) for r in reasons):
        return "snapshot_stale"
    if reasons and all(_LAG.fullmatch(r) for r in reasons):
        return "standings_lag"
    return "other"


def record_hold(trade_txn: dict, report: str, path: Path = None, *, cause: str) -> dict:
    """Durably hold a trade (or record that it was held again) with its cause (classify()).
    Raises HeldStateError if the hold could not be recorded: the caller must then NOT advance
    its cursor. A trade held again keeps the cause of its first hold; each hold logs its own."""
    with locked(path):
        entries = load(path)
        for e in entries:
            if key(e) == key(trade_txn):
                e.setdefault("holds", []).append({"held_at": _now(), "report": report, "cause": cause})
                e["report"] = report
                break
        else:
            e = {"timestamp": trade_txn.get("timestamp"), "franchise": trade_txn.get("franchise"),
                 "franchise2": trade_txn.get("franchise2"), "held_at": _now(), "cause": cause,
                 "report": report}
            entries.append(e)
        save(entries, path)
    if not any(key(x) == key(trade_txn) for x in load(path)):
        raise HeldStateError(f"trade {key(trade_txn)} is not in {_path(path).name} after writing it")
    return e


def pending(entries: list) -> list:
    """Entries never retried."""
    return [e for e in entries if "retry" not in e]


def resumable(entry: dict, section: str = "retry") -> bool:
    """A journaled attempt that has not finished and has attempts left: safe to resume (its
    messages are found by marker before anything is sent again)."""
    rec = entry.get(section) or {}
    return (bool(rec.get("journaled")) and "outcome" not in rec
            and len(rec.get("attempts") or []) < MAX_ATTEMPTS)


def eligible(entries: list) -> list:
    """Entries the bot retries automatically: held because the snapshot was missing or stale, and
    either never retried or mid-way through a journaled retry (resumable)."""
    return [e for e in entries if e.get("cause") in RETRY_CAUSES
            and ("retry" not in e or resumable(e, "retry"))]


def not_eligible(entries: list) -> list:
    """Never-retried entries held for any other cause (or none recorded): they wait for a person
    (posted only from an approved bundle)."""
    return [e for e in pending(entries) if e.get("cause") not in RETRY_CAUSES
            and ((e.get("catchup") or {}).get("outcome") != "posted")]


def unfinished(entries: list) -> list:
    """Entries whose retry started but never recorded an outcome and cannot resume by itself: an
    old-style (unjournaled) crash mid-retry, or a journaled one out of attempts. Need a person."""
    return [e for e in entries if "retry" in e and "outcome" not in (e.get("retry") or {})
            and not resumable(e, "retry")]


def find_trade(entry: dict, trades: list, groups: dict | None = None):
    """The exact MFL trade (or multi-team group) for a held entry, by its full key; None if
    absent or ambiguous. Never by timestamp alone."""
    if entry.get("franchise") == "multiway":
        return (groups or {}).get(entry.get("franchise2")) or None
    hits = [t for t in trades if key(t) == key(entry)]
    return hits[0] if len(hits) == 1 else None


def _update(entry: dict, path: Path, section: str = "retry", **fields) -> dict:
    """Under the lock: reload, update this trade's retry (or catchup) record, save, read back.
    Keeps anything written meanwhile (a new hold). An "attempt" field is appended to attempts."""
    with locked(path):
        entries = load(path)
        for e in entries:
            if key(e) == key(entry):
                rec = e.setdefault(section, {})
                attempt = fields.pop("attempt", None)
                rec.update(fields)
                if attempt is not None:
                    rec.setdefault("attempts", []).append(attempt)
                save(entries, path)
                return e
    raise HeldStateError(f"held trade {key(entry)} is no longer in {_path(path).name}")


def journal(entry: dict, path: Path = None, section: str = "retry", **fields) -> dict:
    """Durably record one posting step (started, a message id, an attempt's failure, the
    outcome) BEFORE moving on. Raises HeldStateError if it could not be recorded."""
    return _update(entry, path, section, journaled=True, **fields)


def get(entry: dict, path: Path = None):
    for e in load(path):
        if key(e) == key(entry):
            return e
    return None


def mark_started(entry: dict, path: Path = None) -> dict:
    """Mark the single retry as started. Call BEFORE the attempt (at most once)."""
    return _update(entry, path, started_at=_now())


def mark_finished(entry: dict, outcome: str, path: Path = None, section: str = "retry") -> dict:
    return _update(entry, path, section, finished_at=_now(), outcome=outcome)


def retry_pending(*, validate, trades: list, grade_and_post, groups: dict | None = None,
                  path: Path = None, log=print) -> list:
    """Retry each eligible held trade (snapshot missing or stale) once, only if the snapshot
    validates now. Entries held for any other cause are never attempted.

    validate() -> list of failures (empty = the bot would grade now). trades: MFL's trade list.
    grade_and_post(entry, trade) -> "posted" | "held_again". Raises HeldStateError if the file
    cannot be trusted. Returns [(key, outcome)] for the entries attempted this call. (The bot
    runs the same steps around its async post: trade_roast_bot.retry_held_trades.)"""
    entries = load(path)
    skipped = not_eligible(entries)
    if skipped:
        log(f"{len(skipped)} held trade(s) not eligible for automatic retry (need a person): "
            f"{[(key(e), e.get('cause') or 'unrecorded') for e in skipped]}")
    todo = eligible(entries)
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
                      "eligible": [key(e) for e in eligible(entries)],
                      "not_eligible": [(key(e), e.get("cause") or "unrecorded") for e in not_eligible(entries)],
                      "unfinished": [key(e) for e in unfinished(entries)],
                      "finished": [(key(e), e["retry"].get("outcome")) for e in entries
                                   if (e.get("retry") or {}).get("outcome")]}, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
