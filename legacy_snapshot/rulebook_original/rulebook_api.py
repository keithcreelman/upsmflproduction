#!/usr/bin/env python3
import argparse
import hashlib
import json
import re
import sqlite3
import time
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

BASE_DIR = Path(__file__).resolve().parent
RULES_PATH = BASE_DIR / "rules.json"
DB_PATH = BASE_DIR / "ccc_rulebook.db"

ALLOWED_FEEDBACK_TYPES = {"thought", "change"}
ALLOWED_PRIORITIES = {"low", "normal", "high"}
ALLOWED_IMPACT = {"none", "small", "medium", "large"}

# Simple in-memory IP throttle window.
REQUEST_WINDOW_SECONDS = 600
MAX_SUBMISSIONS_PER_WINDOW = 6
IP_BUCKETS = {}


def utc_now_iso():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def normalize_text(value):
    if value is None:
        return ""
    return str(value).strip()


def load_rules():
    with RULES_PATH.open("r", encoding="utf-8") as fh:
        payload = json.load(fh)
    rules = payload.get("rules", [])
    rule_ids = {r["id"] for r in rules if "id" in r}
    return payload, rule_ids


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
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_rule_feedback_rule_id ON rule_feedback(rule_id)"
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_rule_feedback_created_at ON rule_feedback(created_at_utc)"
    )
    conn.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_rule_feedback_dedupe_hash ON rule_feedback(dedupe_hash)"
    )
    conn.commit()


def is_valid_email(value):
    if not value:
        return True
    return bool(re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", value))


def throttle_ok(ip):
    now = int(time.time())
    bucket = IP_BUCKETS.get(ip, [])
    bucket = [t for t in bucket if now - t <= REQUEST_WINDOW_SECONDS]
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
    server_version = "CCCRulebook/1.0"

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
            payload, _ = load_rules()
            self._send_json(200, payload)
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
            self._send_json(400, {"ok": False, "error": "Invalid request size."})
            return

        try:
            payload = json.loads(self.rfile.read(content_length).decode("utf-8"))
        except Exception:
            self._send_json(400, {"ok": False, "error": "Invalid JSON payload."})
            return

        rules_payload, rule_ids = load_rules()
        rule_lookup = {r["id"]: r for r in rules_payload.get("rules", []) if "id" in r}
        errors, canonical = validate_payload(payload, rule_ids)
        if errors:
            self._send_json(400, {"ok": False, "errors": errors})
            return

        digest = dedupe_hash(canonical)
        created_at_utc = utc_now_iso()
        ua = normalize_text(self.headers.get("User-Agent"))

        rule_meta = rule_lookup.get(canonical["rule_id"], {})
        conn = sqlite3.connect(DB_PATH)
        try:
            init_db(conn)
            conn.execute(
                """
                INSERT INTO rule_feedback (
                  created_at_utc, source_ip, user_agent, rule_id, rule_category, rule_title,
                  feedback_type, priority, impact, summary, rationale, current_text_excerpt,
                  proposed_text, examples, contact_name, contact_email, wants_followup,
                  submitter_team, status, submission_format_version, payload_json, dedupe_hash
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', ?, ?, ?)
                """,
                (
                    created_at_utc,
                    remote_ip,
                    ua,
                    canonical["rule_id"],
                    normalize_text(rule_meta.get("category")),
                    normalize_text(rule_meta.get("title")),
                    canonical["feedback_type"],
                    canonical["priority"],
                    canonical["impact"],
                    canonical["summary"],
                    canonical["rationale"],
                    canonical["current_text_excerpt"],
                    canonical["proposed_text"],
                    canonical["examples"],
                    canonical["contact_name"],
                    canonical["contact_email"],
                    1 if canonical["wants_followup"] else 0,
                    canonical["submitter_team"],
                    canonical["submission_format_version"],
                    json.dumps(canonical, sort_keys=True, ensure_ascii=True),
                    digest,
                ),
            )
            conn.commit()
        except sqlite3.IntegrityError:
            self._send_json(409, {"ok": False, "error": "Duplicate submission detected."})
            return
        finally:
            conn.close()

        self._send_json(
            201,
            {
                "ok": True,
                "message": "Feedback submitted.",
                "rule_id": canonical["rule_id"],
                "feedback_type": canonical["feedback_type"],
                "submission_format_version": canonical["submission_format_version"],
            },
        )


def run_server(host, port, cors_origin):
    httpd = ThreadingHTTPServer((host, port), RulebookHandler)
    httpd.cors_origin = cors_origin
    print(f"rulebook_api listening on http://{host}:{port}")
    httpd.serve_forever()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="CCC Rulebook API")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8787)
    parser.add_argument("--cors-origin", default="*")
    args = parser.parse_args()

    run_server(args.host, args.port, args.cors_origin)
