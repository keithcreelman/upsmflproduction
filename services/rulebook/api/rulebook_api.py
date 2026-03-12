#!/usr/bin/env python3
import argparse
import hashlib
import json
import os
import re
import sqlite3
import sys
import time
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse


SERVICE_ROOT = Path(__file__).resolve().parents[1]
if str(SERVICE_ROOT) not in sys.path:
    sys.path.insert(0, str(SERVICE_ROOT))

from rulebook_core import DATA_ROOT, load_rules_ai_payload, load_rules_lookup, load_rules_payload


DB_PATH = Path(os.getenv("RULEBOOK_DB_PATH", str(DATA_ROOT / "rule_feedback.db")))

ALLOWED_FEEDBACK_TYPES = {"thought", "change"}
ALLOWED_PRIORITIES = {"low", "normal", "high"}
ALLOWED_IMPACT = {"none", "small", "medium", "large"}

REQUEST_WINDOW_SECONDS = 600
MAX_SUBMISSIONS_PER_WINDOW = 6
IP_BUCKETS = {}


def utc_now_iso():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def normalize_text(value):
    if value is None:
        return ""
    return str(value).strip()


def init_db(conn):
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS rule_feedback (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          created_at_utc TEXT NOT NULL,
          source_ip TEXT NOT NULL,
          user_agent TEXT,
          rule_id TEXT NOT NULL,
          rule_category TEXT,
          rule_title TEXT,
          feedback_type TEXT NOT NULL,
          priority TEXT NOT NULL,
          impact TEXT NOT NULL,
          summary TEXT NOT NULL,
          rationale TEXT NOT NULL,
          current_text_excerpt TEXT,
          proposed_text TEXT,
          examples TEXT,
          contact_name TEXT,
          contact_email TEXT,
          wants_followup INTEGER NOT NULL DEFAULT 0,
          submitter_team TEXT,
          status TEXT NOT NULL DEFAULT 'new',
          submission_format_version TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          dedupe_hash TEXT NOT NULL
        )
        """
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_rule_feedback_rule_id ON rule_feedback(rule_id)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_rule_feedback_created_at ON rule_feedback(created_at_utc)")
    conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_rule_feedback_dedupe_hash ON rule_feedback(dedupe_hash)")
    conn.commit()


def is_valid_email(value):
    if not value:
        return True
    return bool(re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", value))


def throttle_ok(ip):
    now = int(time.time())
    bucket = [t for t in IP_BUCKETS.get(ip, []) if now - t <= REQUEST_WINDOW_SECONDS]
    if len(bucket) >= MAX_SUBMISSIONS_PER_WINDOW:
        IP_BUCKETS[ip] = bucket
        return False
    bucket.append(now)
    IP_BUCKETS[ip] = bucket
    return True


def validate_payload(payload, valid_rule_ids):
    errors = []
    rule_id = normalize_text(payload.get("rule_id"))
    feedback_type = normalize_text(payload.get("feedback_type")).lower()
    priority = normalize_text(payload.get("priority", "normal")).lower()
    impact = normalize_text(payload.get("impact", "none")).lower()
    summary = normalize_text(payload.get("summary"))
    rationale = normalize_text(payload.get("rationale"))
    current_excerpt = normalize_text(payload.get("current_text_excerpt"))
    proposed_text = normalize_text(payload.get("proposed_text"))
    examples = normalize_text(payload.get("examples"))
    contact_name = normalize_text(payload.get("contact_name"))
    contact_email = normalize_text(payload.get("contact_email"))
    submitter_team = normalize_text(payload.get("submitter_team"))
    wants_followup = bool(payload.get("wants_followup", False))
    format_version = normalize_text(payload.get("submission_format_version")) or "v1"

    if rule_id not in valid_rule_ids:
        errors.append("Invalid rule_id.")
    if feedback_type not in ALLOWED_FEEDBACK_TYPES:
        errors.append("feedback_type must be thought or change.")
    if priority not in ALLOWED_PRIORITIES:
        errors.append("priority must be low, normal, or high.")
    if impact not in ALLOWED_IMPACT:
        errors.append("impact must be none, small, medium, or large.")
    if len(summary) < 15 or len(summary) > 180:
        errors.append("summary must be 15-180 characters.")
    if len(rationale) < 30 or len(rationale) > 1200:
        errors.append("rationale must be 30-1200 characters.")
    if len(current_excerpt) > 600:
        errors.append("current_text_excerpt max length is 600.")
    if len(examples) > 900:
        errors.append("examples max length is 900.")
    if len(contact_name) > 80:
        errors.append("contact_name max length is 80.")
    if len(submitter_team) > 80:
        errors.append("submitter_team max length is 80.")
    if feedback_type == "change":
        if len(proposed_text) < 30 or len(proposed_text) > 1200:
            errors.append("proposed_text must be 30-1200 chars for change submissions.")
    elif proposed_text:
        errors.append("proposed_text must be blank for thought submissions.")
    if not is_valid_email(contact_email):
        errors.append("contact_email is invalid.")

    canonical = {
        "rule_id": rule_id,
        "feedback_type": feedback_type,
        "priority": priority,
        "impact": impact,
        "summary": summary,
        "rationale": rationale,
        "current_text_excerpt": current_excerpt,
        "proposed_text": proposed_text,
        "examples": examples,
        "contact_name": contact_name,
        "contact_email": contact_email,
        "wants_followup": wants_followup,
        "submitter_team": submitter_team,
        "submission_format_version": format_version,
    }
    return errors, canonical


def dedupe_hash(canonical):
    raw = json.dumps(canonical, sort_keys=True, ensure_ascii=True)
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


class RulebookHandler(BaseHTTPRequestHandler):
    server_version = "UPSRulebook/2.1"

    def _send_json(self, status, payload):
        body = json.dumps(payload, ensure_ascii=True).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", self.server.cors_origin)
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self._send_json(200, {"ok": True})

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == "/health":
            self._send_json(200, {"ok": True, "time_utc": utc_now_iso()})
            return
        if parsed.path == "/api/rules":
            self._send_json(200, load_rules_payload())
            return
        if parsed.path == "/api/rules/ai":
            self._send_json(200, load_rules_ai_payload())
            return
        self._send_json(404, {"ok": False, "error": "Not found"})

    def do_POST(self):
        parsed = urlparse(self.path)
        if parsed.path != "/api/rule-feedback":
            self._send_json(404, {"ok": False, "error": "Not found"})
            return

        remote_ip = self.client_address[0]
        if not throttle_ok(remote_ip):
            self._send_json(429, {"ok": False, "error": "Rate limit exceeded. Try again in a few minutes."})
            return

        content_length = int(self.headers.get("Content-Length", "0"))
        if content_length <= 0 or content_length > 65536:
            self._send_json(400, {"ok": False, "error": "Invalid Content-Length."})
            return

        raw = self.rfile.read(content_length)
        try:
            payload = json.loads(raw.decode("utf-8"))
        except Exception:
            self._send_json(400, {"ok": False, "error": "Invalid JSON payload."})
            return

        _, valid_rule_ids, lookup = load_rules_lookup()
        errors, canonical = validate_payload(payload, valid_rule_ids)
        if errors:
            self._send_json(400, {"ok": False, "errors": errors})
            return

        submission_hash = dedupe_hash(canonical)
        rule = lookup.get(canonical["rule_id"], {})
        record = {
            "created_at_utc": utc_now_iso(),
            "source_ip": remote_ip,
            "user_agent": self.headers.get("User-Agent", ""),
            "rule_id": canonical["rule_id"],
            "rule_category": rule.get("subcategory", ""),
            "rule_title": rule.get("title", ""),
            "feedback_type": canonical["feedback_type"],
            "priority": canonical["priority"],
            "impact": canonical["impact"],
            "summary": canonical["summary"],
            "rationale": canonical["rationale"],
            "current_text_excerpt": canonical["current_text_excerpt"],
            "proposed_text": canonical["proposed_text"],
            "examples": canonical["examples"],
            "contact_name": canonical["contact_name"],
            "contact_email": canonical["contact_email"],
            "wants_followup": 1 if canonical["wants_followup"] else 0,
            "submitter_team": canonical["submitter_team"],
            "submission_format_version": canonical["submission_format_version"],
            "payload_json": json.dumps(canonical, ensure_ascii=True),
            "dedupe_hash": submission_hash,
        }

        try:
            with sqlite3.connect(DB_PATH) as conn:
                init_db(conn)
                conn.execute(
                    """
                    INSERT INTO rule_feedback (
                      created_at_utc, source_ip, user_agent, rule_id, rule_category, rule_title,
                      feedback_type, priority, impact, summary, rationale, current_text_excerpt,
                      proposed_text, examples, contact_name, contact_email, wants_followup,
                      submitter_team, submission_format_version, payload_json, dedupe_hash
                    ) VALUES (
                      :created_at_utc, :source_ip, :user_agent, :rule_id, :rule_category, :rule_title,
                      :feedback_type, :priority, :impact, :summary, :rationale, :current_text_excerpt,
                      :proposed_text, :examples, :contact_name, :contact_email, :wants_followup,
                      :submitter_team, :submission_format_version, :payload_json, :dedupe_hash
                    )
                    """,
                    record,
                )
                conn.commit()
        except sqlite3.IntegrityError:
            self._send_json(200, {"ok": True, "deduped": True})
            return
        except Exception as exc:
            self._send_json(500, {"ok": False, "error": f"Failed to store feedback: {exc}"})
            return

        self._send_json(200, {"ok": True, "deduped": False})


def run_server(host, port, cors_origin):
    server = ThreadingHTTPServer((host, port), RulebookHandler)
    server.cors_origin = cors_origin
    with sqlite3.connect(DB_PATH) as conn:
        init_db(conn)
    print(f"Rulebook API listening on http://{host}:{port}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("Shutting down...")
    finally:
        server.server_close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8877)
    parser.add_argument("--cors-origin", default="*")
    args = parser.parse_args()
    run_server(args.host, args.port, args.cors_origin)


if __name__ == "__main__":
    main()
