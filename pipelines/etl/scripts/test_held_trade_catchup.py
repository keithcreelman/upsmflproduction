#!/usr/bin/env python3
"""The held-trade catch-up path (Keith 2026-11-25): as-of-trade inputs, exactly-once posting, approvals.

  As-of inputs   a throwaway git repo with controlled commit times holds the real valuation inputs and a
                 real MFL daily folder: the pre-trade commit and folder are chosen by time, later inputs
                 are never used, the standings check brackets the trade, a move of a traded asset after
                 the folder blocks the grade, and the grade equals analyze_trade on the same inputs.
  Posting        post_bundle against a fake Discord: one post end to end; an interruption at every step
                 resumes without a second message; a message sent but not journaled is found by its
                 marker; a retry is used up only by "posted" (or MAX_ATTEMPTS failures); the cursor and the
                 Discord token are never read.
  Approvals      only a bundle whose exact sha256 was approved is posted; an edited bundle is refused.
  Held file      concurrent writers under the lock lose nothing; eligibility keeps the 2026-10-22 ruling.

Offline: local git and files only, no MFL, no Discord, no Keychain.
  python3 pipelines/etl/scripts/test_held_trade_catchup.py
"""
import asyncio
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
REPO = SCRIPT_DIR.parents[2]
sys.path.insert(0, str(SCRIPT_DIR))
import held_trade_catchup as hc  # noqa: E402
import held_trades  # noqa: E402
import trade_asof_inputs as ta  # noqa: E402
import trade_grader as tg  # noqa: E402

FOLDER = "2026-11-24"                     # a real daily folder with rosters, standings, league, meta
DAY = 86400
T0 = 1795400000                           # 2026-11-23T00:53:20Z (the folder is dated 11-24)


def env_at(ts):
    d = f"@{int(ts)} +0000"
    return {**os.environ, "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@t", "GIT_COMMITTER_NAME": "t",
            "GIT_COMMITTER_EMAIL": "t@t", "GIT_AUTHOR_DATE": d, "GIT_COMMITTER_DATE": d}


def git(repo, *args, ts=T0):
    r = subprocess.run(["git", "-C", str(repo), *args], capture_output=True, text=True, env=env_at(ts))
    if r.returncode:
        raise RuntimeError(r.stderr)
    return r.stdout.strip()


def real_trade():
    """A 2-party trade between two franchises using players on their rosters in the folder."""
    rosters = json.loads((REPO / "data/mfl-snapshots" / FOLDER / "rosters.json").read_text())["rosters"]["franchise"]
    snap = json.loads((REPO / "data/valuation/trade_valuation_snapshot.json").read_text())

    def valued(fr):
        ps = fr["player"] if isinstance(fr["player"], list) else [fr["player"]]
        return [p["id"] for p in ps if (snap["players"].get(p["id"]) or {}).get("ppg")]
    a, b = rosters[0], rosters[1]
    return {"type": "TRADE", "franchise": a["id"], "franchise2": b["id"],
            "franchise1_gave_up": valued(a)[0] + ",", "franchise2_gave_up": valued(b)[0] + ",BB_1000,",
            "timestamp": str(T0 + 2 * DAY), "comments": ""}


class AsOfRepo(unittest.TestCase):
    """main: day 0 inputs → day 1 folder → (trade on day 2) → day 2.5 inputs change → day 3 folder."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp()).resolve()
        self.repo = self.tmp / "repo"
        self.repo.mkdir()
        git(self.repo, "init", "-q", "-b", "main")
        for p in ta.INPUT_PATHS:
            src = REPO / p
            dst = self.repo / p
            if src.is_dir():
                shutil.copytree(src, dst)
            else:
                dst.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(src, dst)
        git(self.repo, "add", "-A")
        git(self.repo, "commit", "-qm", "inputs", ts=T0)
        self.folder_dir = self.repo / ta.FOLDERS / FOLDER
        shutil.copytree(REPO / ta.FOLDERS / FOLDER, self.folder_dir)
        git(self.repo, "add", "-A")
        git(self.repo, "commit", "-qm", "daily pull", ts=T0 + DAY)
        self.trade = real_trade()

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def later(self, *, weeks_bump=0, change_inputs=True, folder="2026-11-25", ts=T0 + 3 * DAY, txns=None):
        if change_inputs:
            reg = self.repo / "pipelines/etl/inputs/valuation/player_registry.json"
            d = json.loads(reg.read_text())
            d["meta"]["note_for_test"] = "changed after the trade"
            reg.write_text(json.dumps(d))
            git(self.repo, "commit", "-qam", "inputs after the trade", ts=T0 + 2 * DAY + DAY // 2)
        dst = self.repo / ta.FOLDERS / folder
        shutil.copytree(self.folder_dir, dst)
        st = json.loads((dst / "leagueStandings.json").read_text())
        if weeks_bump:
            for r in st["leagueStandings"]["franchise"]:
                w, l, t = (int(x) for x in r["all_play_wlt"].split("-"))
                r["all_play_wlt"] = f"{w + 11 * weeks_bump}-{l}-{t}"
        (dst / "leagueStandings.json").write_text(json.dumps(st))
        (dst / "transactions.json").write_text(json.dumps({"transactions": {"transaction": txns or []}}))
        git(self.repo, "add", "-A")
        git(self.repo, "commit", "-qm", "daily pull later", ts=ts)

    def resolve(self, **kw):
        a = ta.resolve(self.trade, repo=self.repo, ref="main", **kw)
        self.addCleanup(a.cleanup)
        return a

    def test_picks_the_pre_trade_commit_and_folder_and_never_later_inputs(self):
        self.later()
        a = self.resolve(salary_adjustment_rows=[{"timestamp": str(T0), "franchise_id": "1", "amount": "500"},
                                                 {"timestamp": str(T0 + 9 * DAY), "franchise_id": "1", "amount": "9"}])
        self.assertTrue(a.ok, a.blocking)
        self.assertEqual(a.folder, FOLDER)
        self.assertEqual(a.folder_available_at, T0 + DAY)
        self.assertLess(a.commit_time, int(self.trade["timestamp"]))
        reg = next(p for p in a.provenance if p["input"] == "player_registry.json")
        before = (REPO / "pipelines/etl/inputs/valuation/player_registry.json").read_bytes()
        self.assertEqual(reg["sha256"], ta.sha256(before))                    # not the post-trade edit
        self.assertNotIn("note_for_test", (a.root / "pipelines/etl/inputs/valuation/player_registry.json").read_text())
        self.assertEqual(a.salary_adjustments, {"0001": 500})                  # rows after the trade left out
        self.assertTrue(any("identical" in n for n in a.notes), a.notes)
        self.assertEqual(a.snapshot["as_of"], FOLDER)

    def test_the_grade_equals_analyze_trade_on_the_same_inputs(self):
        self.later()
        a = self.resolve()
        players = {pid: {"name": r["name"], "position": r["pos"], "team": ""} for pid, r in a.snapshot["players"].items()}
        an = ta.grade(self.trade, a, players)
        self.assertFalse(an.no_grade, an.no_grade_reasons)
        ref = tg.analyze_trade(self.trade, players, a.franchises, a.rosters, season_state=a.season_state,
                               snapshot=a.snapshot, now=a.trade_ts, snapshot_repo=a.root, salary_adjustments={})
        self.assertEqual((an.side_a.grade, round(an.side_a.grade_score, 6)),
                         (ref.side_a.grade, round(ref.side_a.grade_score, 6)))
        self.assertEqual(an.regrade_label, "")                                 # as of before the trade

    def test_a_new_week_between_the_folder_and_the_check_blocks(self):
        self.later(weeks_bump=1)
        a = self.resolve()
        self.assertFalse(a.ok)
        self.assertTrue(any("not pinned" in b for b in a.blocking), a.blocking)

    def test_no_later_standings_blocks_and_live_standings_can_confirm(self):
        a = self.resolve()
        self.assertFalse(a.ok)
        self.assertTrue(any("no standings after the trade" in b for b in a.blocking), a.blocking)
        live = json.loads((self.folder_dir / "leagueStandings.json").read_text())
        b = self.resolve(live_standings=live, live_read_at=T0 + 4 * DAY)
        self.assertTrue(b.ok, b.blocking)
        self.assertTrue(any("not checked" in n for n in b.notes), b.notes)     # said, not assumed

    def test_a_folder_committed_after_the_trade_is_never_used(self):
        t = dict(self.trade, timestamp=str(T0 + DAY // 2))                    # before the day-1 folder commit
        a = ta.resolve(t, repo=self.repo, ref="main")
        self.addCleanup(a.cleanup)
        self.assertFalse(a.ok)
        self.assertTrue(any("folder" in b for b in a.blocking), a.blocking)

    def test_a_move_of_a_traded_asset_after_the_folder_blocks(self):
        pid = self.trade["franchise1_gave_up"].strip(",")
        move = {"type": "FREE_AGENT", "franchise": self.trade["franchise"], "transaction": f"|{pid},",
                "timestamp": str(T0 + DAY + 3600)}
        other = {"type": "FREE_AGENT", "franchise": self.trade["franchise"], "transaction": "|99999,",
                 "timestamp": str(T0 + DAY + 7200)}
        self.later(txns=[move, other])
        a = self.resolve()
        self.assertFalse(a.ok)
        self.assertTrue(any(pid in b for b in a.blocking), a.blocking)
        self.assertTrue(any("no traded asset" in n for n in a.notes), a.notes)


# ── posting ──────────────────────────────────────────────────────────────────

class FakeDiscord(hc.Sender):
    def __init__(self):
        self.messages = []          # (id, where, embed)
        self.threads = {}
        self.fail = {}              # method -> exception to raise once (after acting if "after_")

    def _id(self):
        return 1000 + len(self.messages) + len(self.threads)

    def _maybe(self, name, after=False):
        exc = self.fail.pop(("after_" if after else "") + name, None)
        if exc:
            raise exc

    async def find_announcement(self, marker):
        for mid, where, e in self.messages:
            if where == "channel" and marker in e.get("footer", {}).get("text", ""):
                return mid, next((t for t, m in self.threads.items() if m == mid), None)
        return None

    async def send_announcement(self, embed):
        self._maybe("send_announcement")
        mid = self._id()
        self.messages.append((mid, "channel", embed))
        self._maybe("send_announcement", after=True)
        return mid

    async def create_thread(self, message_id, name):
        self._maybe("create_thread")
        tid = self._id()
        self.threads[tid] = message_id
        return tid

    async def find_in_thread(self, thread_id, marker, title):
        for mid, where, e in self.messages:
            if where == thread_id and marker in e.get("footer", {}).get("text", "") and (e.get("title") or None) == (title or None):
                return mid
        return None

    async def send_in_thread(self, thread_id, embed, reply_button=False):
        self._maybe("send_in_thread")
        mid = self._id()
        self.messages.append((mid, thread_id, embed))
        self._maybe("send_in_thread", after=True)
        return mid


def bundle_for(txn):
    b = {"schema": hc.SCHEMA, "key": list(held_trades.key(txn)), "marker": hc.marker(txn), "trade": txn,
         "status": "ready", "label": "Delayed post.", "grades": {"0001": {"team": "A", "grade": "B", "score": 1.0},
                                                                 "0002": {"team": "B", "grade": "B-", "score": -1.0}},
         "provisional_reasons": [], "announcement_embed": {"title": "TRADE", "footer": {"text": f"Delayed post · {hc.marker(txn)}"}},
         "thread_name": "Trade Roast — A ↔ B", "context_text": "ctx", "ctx_franchises": ["0001", "0002"], "roast": None}
    return hc.set_roast(b, "A roast.", "test", "", "https://gif.example/x.gif")


class Posting(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp()).resolve()
        self.path = self.tmp / "held.json"
        held_trades.save([], self.path)
        self.txn = {"timestamp": "1795531869", "franchise": "0001", "franchise2": "0002"}
        held_trades.record_hold(self.txn, "NO GRADE: stale", self.path, cause="snapshot_stale")
        self.entry = held_trades.load(self.path)[0]
        self.bundle = bundle_for(self.txn)
        self.recorded = []
        self.logs = []

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def post(self, d, section="retry"):
        entry = held_trades.get(self.entry, self.path)
        return asyncio.run(hc.post_bundle(entry, self.bundle, d, section=section, path=self.path,
                                          on_posted=lambda b, ids: self.recorded.append(ids), log=self.logs.append))

    def rec(self, section="retry"):
        return held_trades.get(self.entry, self.path)[section]

    def test_one_post_end_to_end_journals_every_id(self):
        d = FakeDiscord()
        self.assertEqual(self.post(d), "posted")
        self.assertEqual([w for _, w, _ in d.messages].count("channel"), 1)
        self.assertEqual(len(d.messages), 3)                                   # announcement, roast, GIF
        r = self.rec()
        for k in ("announcement_id", "thread_id", "roast_id", "gif_id", "started_at", "finished_at"):
            self.assertIn(k, r)
        self.assertEqual(r["outcome"], "posted")
        self.assertEqual(r["bundle_sha256"], self.bundle["bundle_sha256"])
        self.assertEqual(len(self.recorded), 1)
        self.assertEqual(held_trades.eligible(held_trades.load(self.path)), [])
        self.assertEqual(self.post(d), "posted")                               # again: nothing sent
        self.assertEqual(len(d.messages), 3)

    def test_an_interruption_at_any_step_resumes_without_a_second_message(self):
        for step in ("send_announcement", "after_send_announcement", "create_thread", "send_in_thread",
                     "after_send_in_thread"):
            with self.subTest(step):
                self.setUp()
                d = FakeDiscord()
                d.fail[step] = ConnectionError("discord hiccup")
                self.assertEqual(self.post(d), "retry_later")
                r = self.rec()
                self.assertNotIn("outcome", r)                                 # the retry is NOT used up
                self.assertEqual(len(r["attempts"]), 1)
                self.assertEqual([e["timestamp"] for e in held_trades.eligible(held_trades.load(self.path))],
                                 [self.txn["timestamp"]])                       # still eligible: it resumes
                self.assertEqual(held_trades.unfinished(held_trades.load(self.path)), [])
                self.assertEqual(self.post(d), "posted")
                self.assertEqual([w for _, w, _ in d.messages].count("channel"), 1, step)
                roasts = [e for _, w, e in d.messages if w != "channel" and e.get("title") == "🔥 Roast"]
                self.assertEqual(len(roasts), 1, step)
                self.assertEqual(len(self.recorded), 1)
                self.tearDown()

    def test_a_sent_but_unjournaled_announcement_is_adopted_by_its_marker(self):
        d = FakeDiscord()
        asyncio.run(d.send_announcement(self.bundle["announcement_embed"]))   # sent, then the bot died
        self.assertEqual(self.post(d), "posted")
        self.assertEqual([w for _, w, _ in d.messages].count("channel"), 1)
        self.assertTrue(self.rec()["adopted_announcement"])

    def test_max_attempts_then_a_person(self):
        d = FakeDiscord()
        for i in range(held_trades.MAX_ATTEMPTS):
            d.fail["send_announcement"] = ConnectionError("down")
            out = self.post(d)
        self.assertEqual(out, "needs_person")
        self.assertTrue(self.rec()["outcome"].startswith("error:"))
        self.assertEqual(held_trades.eligible(held_trades.load(self.path)), [])
        self.assertEqual(d.messages, [])

    def test_the_gif_is_optional_and_never_reposts(self):
        d = FakeDiscord()
        calls = {"n": 0}
        orig = d.send_in_thread

        async def flaky(tid, embed, reply_button=False):
            calls["n"] += 1
            if "image" in embed:
                raise ConnectionError("gif host down")
            return await orig(tid, embed, reply_button)
        d.send_in_thread = flaky
        self.assertEqual(self.post(d), "posted")
        self.assertIn("gif_skipped", self.rec())

    def test_never_the_cursor_or_a_secret(self):
        for mod in ("held_trade_catchup.py", "trade_asof_inputs.py"):
            src = (SCRIPT_DIR / mod).read_text()
            secret_read = "-".join(("find", "generic", "password"))          # spelled so the suite's tripwire stays quiet
            for banned in ("last_trade_timestamp", "save_last_trade_ts", secret_read, "DISCORD_BOT_TOKEN",
                           "ANTHROPIC_API_KEY"):
                self.assertNotIn(banned, src, (mod, banned))


class Approvals(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp()).resolve()
        self.saved = (hc.BUNDLES, hc.APPROVALS)
        hc.BUNDLES, hc.APPROVALS = self.tmp / "bundles", self.tmp / "approvals"
        self.txn = {"timestamp": "1795571692", "franchise": "0007", "franchise2": "0012"}
        self.file = self.tmp / "b.json"
        self.file.write_text(json.dumps(bundle_for(self.txn)))

    def tearDown(self):
        hc.BUNDLES, hc.APPROVALS = self.saved
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_only_the_exact_approved_bundle_is_posted(self):
        self.assertIsNone(hc.approved_bundle(self.txn))                        # nothing approved yet
        hc.approve(self.file, "Keith")
        b = hc.approved_bundle(self.txn)
        self.assertEqual(b["bundle_sha256"], json.loads(self.file.read_text())["bundle_sha256"])
        stored = hc.BUNDLES / f"{hc._slug(self.txn)}.json"
        edited = json.loads(stored.read_text())
        edited["roast"]["embed"]["description"] = "something else"
        stored.write_text(json.dumps(edited))
        self.assertIsNone(hc.approved_bundle(self.txn))                        # edited after approval
        other = {"timestamp": "1795571692", "franchise": "0007", "franchise2": "0011"}
        self.assertIsNone(hc.approved_bundle(other))                           # full key, never timestamp alone

    def test_an_edited_or_ungradable_bundle_cannot_be_approved(self):
        b = json.loads(self.file.read_text())
        b["grades"]["0001"]["grade"] = "A+"
        self.file.write_text(json.dumps(b))
        with self.assertRaises(SystemExit):
            hc.approve(self.file, "Keith")
        self.file.write_text(json.dumps({"status": "cannot_grade", "roast": None}))
        with self.assertRaises(SystemExit):
            hc.approve(self.file, "Keith")


class HeldFile(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp()).resolve()
        self.path = self.tmp / "held.json"
        held_trades.save([], self.path)

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_concurrent_writers_lose_nothing(self):
        code = ("import sys; sys.path.insert(0, sys.argv[1]); import held_trades as h\n"
                "for i in range(25):\n"
                "    h.record_hold({'timestamp': f'{sys.argv[3]}{i}', 'franchise': '0001', 'franchise2': '0002'},"
                " 'r', h.Path(sys.argv[2]), cause='other')\n")
        procs = [subprocess.Popen([sys.executable, "-c", code, str(SCRIPT_DIR), str(self.path), p]) for p in "ab"]
        self.assertEqual([p.wait() for p in procs], [0, 0])
        self.assertEqual(len(held_trades.load(self.path)), 50)

    def test_eligibility_keeps_the_2026_10_22_ruling(self):
        mk = lambda ts, cause: held_trades.record_hold({"timestamp": ts, "franchise": "0001", "franchise2": "0002"},
                                                        "r", self.path, cause=cause)
        mk("1", "snapshot_stale")
        mk("2", held_trades.REVIEW_CAUSE)
        mk("3", "standings_lag")
        mk("4", "other")
        self.assertEqual([e["timestamp"] for e in held_trades.eligible(held_trades.load(self.path))], ["1"])
        self.assertEqual(sorted(e["timestamp"] for e in held_trades.not_eligible(held_trades.load(self.path))),
                         ["2", "3", "4"])
        # An old-style retry (started, never journaled) still needs a person; a journaled one resumes.
        e = held_trades.mark_started({"timestamp": "1", "franchise": "0001", "franchise2": "0002"}, self.path)
        self.assertEqual(held_trades.eligible(held_trades.load(self.path)), [])
        self.assertEqual([x["timestamp"] for x in held_trades.unfinished(held_trades.load(self.path))], ["1"])
        held_trades.journal(e, self.path, "retry", attempt={"stage": "announcement", "error": "x"})
        self.assertEqual([x["timestamp"] for x in held_trades.eligible(held_trades.load(self.path))], ["1"])


if __name__ == "__main__":
    unittest.main()
