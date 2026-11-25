#!/usr/bin/env python3
"""Catch up held trades: grade on as-of-trade inputs, post exactly once, never lose a retry (Keith 2026-11-25).

Two ways a held trade gets posted, both through post_bundle() below:

  automatic  ONLY a trade held because the valuation snapshot was missing or stale (held_trades.RETRY_CAUSES,
             Keith 2026-10-22): on the bot's first poll with a valid snapshot it is graded on the inputs
             committed BEFORE the trade (trade_asof_inputs.py), its roast is generated, and it is posted as
             a labeled delayed post. A trade seen more than 6 hours late (standings_lag) is recorded as its
             own cause but is NOT retried automatically; it goes through the approved path.
  approved   any other held trade (held for review, standings_lag, a retry already used): a person prepares a bundle
             (`prepare`), reviews the exact announcement, grades and roast, and approves that exact
             bundle by its sha256 (`approve`). The bot posts only a bundle whose sha256 matches its
             approval record, verbatim. Nothing is regenerated after approval.

Safety (both ways):
  - never the cursor: held trades are already behind it; nothing here reads or writes it;
  - no duplicate: every message carries a reference marker ("ref <timestamp>-<franchise>-<franchise2>")
    in its embed footer. Each message's send intent is journaled before it is sent and its id right after;
    a step with an intent but no id is resent only after an EXHAUSTIVE search of everything posted since
    the intent proves it absent; a search that cannot complete stops for a person (needs_reconcile);
  - the thread is recovered from the announcement before one is created;
  - a retry is used up only when "posted" is recorded, after every message AND every tracking step (reply
    tracker, worker row, archive); tracking that fails is resumed on a later poll without reposting. A
    failed attempt is journaled and retried, at most held_trades.MAX_ATTEMPTS times, then a person is needed;
  - a trade that cannot be graded reliably on as-of inputs is never graded on today's data: it is held
    again with the reasons (automatic) or the bundle says so and cannot be approved (approved).

  python3 held_trade_catchup.py prepare <timestamp> [--roast-file F] [--gif-query Q] --out DIR
  python3 held_trade_catchup.py approve <bundle.json> --by <name>     # a person, after review
  python3 held_trade_catchup.py status

`prepare` reads MFL (read-only), git and local files; it never reads a secret, posts or writes the held file.
Its roast comes from --roast-file (reviewed text) or, with --generate, the bot's own roast model
(content_engine.generate_trade_roast; needs the bot's Anthropic key in the environment).
"""
import argparse
import asyncio
import hashlib
import json
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR))

import held_trades  # noqa: E402
import trade_asof_inputs as ta  # noqa: E402

DATA = SCRIPT_DIR.parent / "data"
CATCHUP_DIR = DATA / "held_catchup"
BUNDLES = CATCHUP_DIR / "bundles"
APPROVALS = CATCHUP_DIR / "approvals"
SCHEMA = "held-catchup-bundle/1"
GIF_SEARCH = "https://upsmflproduction.keith-creelman.workers.dev/api/giphy-search"


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def marker(entry_or_txn: dict) -> str:
    ts, a, b = held_trades.key(entry_or_txn)
    return f"ref {ts}-{a}-{b}"


def canonical(bundle: dict) -> bytes:
    body = {k: v for k, v in bundle.items() if k != "bundle_sha256"}
    return json.dumps(body, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode()


def bundle_sha(bundle: dict) -> str:
    return hashlib.sha256(canonical(bundle)).hexdigest()


def _slug(entry_or_txn) -> str:
    return "-".join(held_trades.key(entry_or_txn))


# ── building a bundle (no Discord) ──────────────────────────────────────────

def build_bundle(trade_txn: dict, asof: "ta.AsOf", players_map: dict, *, roast_text: str | None,
                 roast_source: str, gif_query: str = "", gif_url: str = "", recent_posts=(),
                 context_builder=None) -> dict:
    """Grade on the as-of inputs and assemble everything that will be posted. Returns a bundle with
    status "ready" (gradable) or "cannot_grade" (with reasons). roast_text None = generate later.
    recent_posts: the roast's anti-repetition list (None = read Discord, which needs the bot token)."""
    import trade_announcement as tan
    import trade_grader as tg
    m = marker(trade_txn)
    base = {"schema": SCHEMA, "key": list(held_trades.key(trade_txn)), "marker": m, "trade": trade_txn,
            "asof": {"ref": asof.ref, "commit": asof.commit, "folder": asof.folder,
                     "folder_available_at": ta.iso(asof.folder_available_at) if asof.folder_available_at else "",
                     "provenance": asof.provenance, "notes": asof.notes, "blocking": list(asof.blocking)},
            "created_at": _now()}
    if not asof.ok:
        return {**base, "status": "cannot_grade", "reasons": list(asof.blocking)}
    analysis = ta.grade(trade_txn, asof, players_map)
    if analysis.no_grade:
        return {**base, "status": "cannot_grade", "reasons": list(analysis.no_grade_reasons)}
    sens = ta.sensitivity(trade_txn, asof, players_map)
    if sens is not None and not sens["letters_same"]:
        return {**base, "status": "cannot_grade", "sensitivity": sens,
                "reasons": ["MFL corrected the standings after the trade and the letter grades differ between "
                            "the two versions; which was current at the trade is not recorded"]}
    analysis = ta.grade(trade_txn, asof, players_map)              # the folder's standings, reloaded last
    label = ta.delayed_label(asof)
    if sens is not None:
        label += (" MFL corrected stats after this trade; the letter grades are the same under both "
                  "versions of the standings.")
    ts = int(trade_txn["timestamp"])
    embed = tan.build_announcement_embed(analysis, asof.franchises, ta.iso(ts).replace("Z", "+00:00"))
    embed["description"] = f"{embed['description']}\n{label}"
    embed["footer"] = {"text": f"Delayed post · {m}"}
    builder = context_builder
    if builder is None:
        from trade_roast_context import build_trade_roast_context as builder
    from trade_roast_context import context_to_prompt_text
    ctx = builder(trade_txn, analysis=analysis, recent_posts=recent_posts)
    context_text = context_to_prompt_text(ctx)
    a, b = analysis.side_a, analysis.side_b
    team_a = asof.franchises.get(a.franchise_id, a.franchise_name)
    team_b = asof.franchises.get(b.franchise_id, b.franchise_name)
    bundle = {**base, "status": "ready", "label": label,
              "grades": {a.franchise_id: {"team": team_a, "grade": a.grade, "score": round(a.grade_score, 1)},
                         b.franchise_id: {"team": team_b, "grade": b.grade, "score": round(b.grade_score, 1)}},
              "valuation_as_of": analysis.valuation_as_of, "provisional_reasons": list(analysis.provisional_reasons),
              "sensitivity": sens,
              "announcement_embed": embed, "thread_name": f"Trade Roast — {team_a} ↔ {team_b}"[:100],
              "context_text": context_text, "ctx_franchises": [a.franchise_id, b.franchise_id],
              "roast": None}
    if roast_text is not None:
        set_roast(bundle, roast_text, roast_source, gif_query, gif_url)
    return bundle


def set_roast(bundle: dict, roast_text: str, source: str, gif_query: str = "", gif_url: str = "") -> dict:
    """Attach the roast exactly as it will be posted (fixed provisional banner, if any, on top)."""
    import trade_grader as tg
    text = roast_text.strip()
    bundle["roast"] = {"text": text, "source": source, "gif_query": gif_query, "gif_url": gif_url,
                       "embed": {"title": "🔥 Roast", "color": 0x5865F2,
                                 "description": tg.with_provisional_banner(text, bundle["provisional_reasons"])[:4096],
                                 "footer": {"text": f"Delayed post · {bundle['marker']}"}}}
    bundle["bundle_sha256"] = bundle_sha(bundle)
    return bundle


def fetch_gif_url(query: str) -> str:
    import urllib.parse
    import urllib.request
    if not query:
        return ""
    try:
        req = urllib.request.Request(f"{GIF_SEARCH}?{urllib.parse.urlencode({'q': query})}",
                                     headers={"User-Agent": "ups-roast-bot-launchd (production)"})  # the bot's own UA
        with urllib.request.urlopen(req, timeout=10) as r:
            data = json.loads(r.read().decode())
        return data.get("gif_url", "") if data.get("ok") else ""
    except Exception:
        return ""


# ── approval ────────────────────────────────────────────────────────────────

def approval_path(entry_or_txn) -> Path:
    return APPROVALS / f"{_slug(entry_or_txn)}.json"


def approve(bundle_file: Path, by: str) -> dict:
    bundle = json.loads(Path(bundle_file).read_text())
    if bundle.get("status") != "ready" or not bundle.get("roast"):
        raise SystemExit("only a ready bundle with a roast can be approved")
    if bundle_sha(bundle) != bundle.get("bundle_sha256"):
        raise SystemExit("bundle was edited after it was prepared (sha256 mismatch)")
    APPROVALS.mkdir(parents=True, exist_ok=True)
    BUNDLES.mkdir(parents=True, exist_ok=True)
    dest = BUNDLES / f"{_slug(bundle['trade'])}.json"
    dest.write_text(json.dumps(bundle, indent=1, ensure_ascii=False))
    rec = {"bundle_sha256": bundle["bundle_sha256"], "bundle": str(dest.name), "approved_by": by, "approved_at": _now()}
    approval_path(bundle["trade"]).write_text(json.dumps(rec, indent=1))
    return rec


def approved_bundle(entry: dict):
    """The approved bundle for a held entry, or None. Never a bundle whose sha256 differs from its approval."""
    ap = approval_path(entry)
    if not ap.exists():
        return None
    rec = json.loads(ap.read_text())
    bpath = BUNDLES / rec.get("bundle", "")
    if not bpath.exists():
        return None
    bundle = json.loads(bpath.read_text())
    if bundle_sha(bundle) != rec.get("bundle_sha256") or bundle.get("bundle_sha256") != rec.get("bundle_sha256"):
        return None
    if held_trades.key(bundle["trade"]) != held_trades.key(entry):
        return None
    return bundle


# ── posting (Discord through a sender; the bot supplies the real one) ───────
#
# Exactly once, fail closed (Codex review 2026-11-25):
#   - before each message is sent, its INTENT (step + time) is journaled; right after, its id;
#   - a step with an intent but no id may have been sent: the sender must establish presence or absence
#     by an EXHAUSTIVE search of everything posted after the intent (not a "latest N messages" window).
#     Found = adopt it. Proven absent = send. A search that cannot complete = needs_reconcile: a person
#     checks Discord; nothing is sent again automatically;
#   - the thread is recovered from the announcement (a message thread's id is its starter message's id)
#     before one is created;
#   - tracking (reply tracker, worker row, archive) is journaled step by step and resumed on a later poll
#     WITHOUT reposting; "posted" is recorded only when every message and every tracking step is recorded.

class IncompleteSearch(RuntimeError):
    """Presence or absence of a message could not be established: never resend on this."""


class Sender:
    """What post_bundle needs from Discord. ids are ints.

    find_announcement / find_in_thread must examine EVERY message posted after `after` (epoch seconds),
    however many there are, and raise IncompleteSearch if they cannot; returning None is a claim of absence."""
    async def find_announcement(self, marker: str, after: float):    # -> message_id | None
        raise NotImplementedError

    async def thread_of(self, message_id: int):                       # -> thread_id | None (raise if unsure)
        raise NotImplementedError

    async def send_announcement(self, embed: dict) -> int:
        raise NotImplementedError

    async def create_thread(self, message_id: int, name: str) -> int:
        raise NotImplementedError

    async def find_in_thread(self, thread_id: int, marker: str, title, after: float):  # title None = untitled (GIF)
        raise NotImplementedError

    async def send_in_thread(self, thread_id: int, embed: dict, reply_button: bool = False) -> int:
        raise NotImplementedError


INTENT_SLACK = 5.0          # seconds of clock slack before an intent when searching


async def post_bundle(entry: dict, bundle: dict, sender: Sender, *, section: str, path=None,
                      trackers=None, log=print) -> str:
    """Post one bundle, resuming from its journal. Returns "posted", "retry_later", "needs_reconcile" or
    "needs_person". section: "retry" (automatic) or "catchup" (approved). trackers: {name: fn(bundle, ids)}
    run in order after the messages; each returns truthy on success (may be async), is journaled as
    tracked_<name>, and is retried on later polls without reposting."""
    trackers = trackers or {}
    first = (entry.get(section) or {}).get("started_at")
    held_trades.journal(entry, path, section, marker=bundle["marker"], bundle_sha256=bundle["bundle_sha256"],
                        **({} if first else {"started_at": _now()}))

    def rec():
        return (held_trades.get(entry, path) or {}).get(section) or {}

    r = rec()
    if r.get("outcome") == "posted":
        return "posted"
    if r.get("outcome"):
        return "needs_person"
    if len(r.get("attempts") or []) >= held_trades.MAX_ATTEMPTS:
        return "needs_person"
    m = bundle["marker"]
    stage = "announcement"

    async def step(name, find, send):
        """One message, exactly once: adopt it if it exists, send it only if absent."""
        r = rec()
        if r.get(f"{name}_id") or r.get(f"{name}_skipped"):
            return r.get(f"{name}_id")
        intent = r.get(f"{name}_intent_at")
        if intent is not None:
            found = await find(float(intent) - INTENT_SLACK)          # exhaustive, or IncompleteSearch
            if found:
                held_trades.journal(entry, path, section, **{f"{name}_id": found, f"{name}_adopted": True})
                return found
        held_trades.journal(entry, path, section, **{f"{name}_intent_at": time.time()})
        mid = await send()
        held_trades.journal(entry, path, section, **{f"{name}_id": mid})
        return mid

    try:
        ann = await step("announcement", lambda after: sender.find_announcement(m, after),
                         lambda: sender.send_announcement(bundle["announcement_embed"]))
        stage = "thread"
        thread = rec().get("thread_id")
        if not thread:
            thread = await sender.thread_of(ann)                      # created before a crash? recover it
            if thread:
                held_trades.journal(entry, path, section, thread_id=thread, thread_adopted=True)
            else:
                held_trades.journal(entry, path, section, thread_intent_at=time.time())
                thread = await sender.create_thread(ann, bundle["thread_name"])
                held_trades.journal(entry, path, section, thread_id=thread)
        stage = "roast"
        roast = await step("roast", lambda after: sender.find_in_thread(thread, m, "🔥 Roast", after),
                           lambda: sender.send_in_thread(thread, bundle["roast"]["embed"], reply_button=True))
        stage = "gif"
        if bundle["roast"].get("gif_url"):
            r = rec()
            if r.get("gif_error") and r.get("gif_intent_at") is not None and not r.get("gif_id"):
                # The GIF send failed last time. It is optional: adopt it if it did land, else skip it, but
                # only once its absence is established (never resend for a GIF).
                found = await sender.find_in_thread(thread, m, None, float(r["gif_intent_at"]) - INTENT_SLACK)
                held_trades.journal(entry, path, section, **({"gif_id": found, "gif_adopted": True} if found
                                                             else {"gif_skipped": "absent after a failed send"}))
            else:
                gif_embed = {"color": 0x202225, "image": {"url": bundle["roast"]["gif_url"]},
                             "footer": {"text": f"Delayed post · {m}"}}
                try:
                    await step("gif", lambda after: sender.find_in_thread(thread, m, None, after),
                               lambda: sender.send_in_thread(thread, gif_embed))
                except IncompleteSearch:
                    raise
                except held_trades.HeldStateError:
                    raise
                except Exception as exc:
                    held_trades.journal(entry, path, section, gif_error=exc.__class__.__name__)
                    raise
        stage = "tracking"
        ids = {"announcement_id": ann, "thread_id": thread, "roast_id": roast}
        for name, fn in trackers.items():
            if rec().get(f"tracked_{name}"):
                continue
            stage = f"tracking:{name}"
            ok = fn(bundle, ids)
            if asyncio.iscoroutine(ok):
                ok = await ok
            if not ok:
                raise RuntimeError(f"tracking step {name} did not complete")
            held_trades.journal(entry, path, section, **{f"tracked_{name}": True})
        held_trades.mark_finished(entry, "posted", path, section)
        log(f"held trade {held_trades.key(entry)} posted ({section}): {ids}")
        return "posted"
    except held_trades.HeldStateError:
        raise
    except IncompleteSearch as exc:
        held_trades.journal(entry, path, section, attempt={"at": _now(), "stage": stage,
                                                            "error": f"IncompleteSearch: {str(exc)[:200]}"})
        held_trades.mark_finished(entry, f"needs_reconcile: {stage}", path, section)
        log(f"held trade {held_trades.key(entry)}: whether the {stage} was already posted could not be established; "
            f"nothing more is sent until a person reconciles it")
        return "needs_reconcile"
    except Exception as exc:
        e = held_trades.journal(entry, path, section, attempt={"at": _now(), "stage": stage,
                                                              "error": f"{exc.__class__.__name__}: {str(exc)[:200]}"})
        n = len((e.get(section) or {}).get("attempts") or [])
        log(f"held trade {held_trades.key(entry)} {section} attempt {n}/{held_trades.MAX_ATTEMPTS} failed at "
            f"{stage}: {exc.__class__.__name__}")
        if n >= held_trades.MAX_ATTEMPTS:
            held_trades.mark_finished(entry, f"error: {exc.__class__.__name__} at {stage}", path, section)
            return "needs_person"
        return "retry_later"


# ── CLI ─────────────────────────────────────────────────────────────────────

def _mfl(export_type: str) -> dict:
    import trade_grader as tg
    return tg.mfl_fetch(export_type)


def recent_posts_from_archive(limit: int = 12, path: Path | None = None) -> list:
    """The anti-repetition list from the bot's local archive (instead of reading Discord)."""
    p = Path(path) if path else DATA / "content_archive.json"
    try:
        rows = json.loads(p.read_text())
    except Exception:
        return []
    rows = [r for r in rows if r.get("type") == "trade_roast" and (r.get("content") or {}).get("roast")]
    rows.sort(key=lambda r: r.get("timestamp", ""), reverse=True)
    return [r["content"]["roast"] for r in rows[:limit]]


def cmd_prepare(args) -> int:
    import trade_grader as tg
    held_file = Path(args.held_file) if args.held_file else None            # read only
    entry = next((e for e in held_trades.load(held_file) if str(e.get("timestamp")) == str(args.timestamp)), None)
    if entry is None:
        print(f"no held entry with timestamp {args.timestamp}")
        return 2
    txns = _mfl("transactions")["transactions"]["transaction"]
    txns = txns if isinstance(txns, list) else [txns]
    trade = held_trades.find_trade(entry, [t for t in txns if t.get("type") == "TRADE"])
    if trade is None:
        print("the trade is not (uniquely) in MFL's transactions")
        return 2
    live = _mfl("leagueStandings")
    read_at = time.time()
    adj = _mfl("salaryAdjustments").get("salaryAdjustments", {}).get("salaryAdjustment", [])
    asof = ta.resolve(trade, ref=args.ref, live_standings=live, live_read_at=read_at,
                      salary_adjustment_rows=adj if isinstance(adj, list) else [adj], later_transactions=txns)
    try:
        roast_text, source = None, ""
        if args.roast_file:
            roast_text, source = Path(args.roast_file).read_text(), args.roast_source or f"reviewed text ({Path(args.roast_file).name})"
        bundle = build_bundle(trade, asof, tg.load_players_map(), roast_text=roast_text, roast_source=source,
                              gif_query=args.gif_query or "", gif_url=fetch_gif_url(args.gif_query or ""),
                              recent_posts=list(recent_posts_from_archive(path=args.archive)))
        if bundle["status"] == "ready" and roast_text is None and args.generate:
            from content_engine import generate_trade_roast
            raw = generate_trade_roast(bundle["context_text"])
            import re
            mm = re.search(r"\[GIF:\s*([^\]]+?)\s*\]\s*$", raw, re.I | re.M)
            q = mm.group(1).strip() if mm else ""
            set_roast(bundle, raw[:mm.start()].rstrip() if mm else raw, "bot roast model (content_engine)", q, fetch_gif_url(q))
    finally:
        asof.cleanup()
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    f = out / f"{_slug(trade)}.json"
    f.write_text(json.dumps(bundle, indent=1, ensure_ascii=False))
    print(json.dumps({"bundle": str(f), "status": bundle["status"], "sha256": bundle.get("bundle_sha256"),
                      "grades": bundle.get("grades"), "reasons": bundle.get("reasons")}, indent=1, ensure_ascii=False))
    return 0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("prepare")
    p.add_argument("timestamp")
    p.add_argument("--out", required=True)
    p.add_argument("--ref", default="origin/main")
    p.add_argument("--roast-file")
    p.add_argument("--roast-source")
    p.add_argument("--gif-query")
    p.add_argument("--generate", action="store_true")
    p.add_argument("--held-file", help="held-trades file to read (read only; default the bot's)")
    p.add_argument("--archive", help="content_archive.json for the anti-repetition list (default the bot's)")
    a = sub.add_parser("approve")
    a.add_argument("bundle")
    a.add_argument("--by", required=True)
    sub.add_parser("status")
    args = ap.parse_args(argv)
    if args.cmd == "prepare":
        return cmd_prepare(args)
    if args.cmd == "approve":
        print(json.dumps(approve(Path(args.bundle), args.by), indent=1))
        return 0
    out = []
    for e in held_trades.load():
        out.append({"key": held_trades.key(e), "cause": e.get("cause"), "retry": (e.get("retry") or {}).get("outcome"),
                    "catchup": (e.get("catchup") or {}).get("outcome"),
                    "approved_bundle": bool(approved_bundle(e))})
    print(json.dumps(out, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
