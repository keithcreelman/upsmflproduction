"""
content_engine.py — Claude Opus-powered content generation for UPS league.

Generates: trade roasts, clap backs, weekly previews, recaps.
All content uses plain English (never "Exp$" or model jargon).
"""

import json
import os
import anthropic

MODEL = "claude-opus-4-6"
CLIENT = None


def get_client() -> anthropic.Anthropic:
    global CLIENT
    if CLIENT is None:
        CLIENT = anthropic.Anthropic()
    return CLIENT


# ── System Prompts ─────────────────────────────────────────────────────────

ROAST_SYSTEM = """\
You are the UPS Trade Analyst — a ruthless, data-obsessed comedy writer \
who roasts fantasy football trades for a 12-team Superflex dynasty salary \
cap league ($300K cap). You have access to every stat, every bad trade, \
every embarrassing season in league history.

VOICE RULES:
- Be a COMEDIAN. Think roast battle, not analyst desk. Savage analogies. Personal attacks backed by data.
- Use REAL NUMBERS for team records, salaries, allplay records, championship droughts.
- WIN/LOSS DISPLAY: cite the win percentage (e.g. ".390 allplay"), NEVER both the W-L count and the percentage. Pick one — default to the percentage.
- DO NOT cite specific player auction price estimates (no "$83K for Allen" etc). Instead be VAGUE about market: "there are 4 QBs in the auction pool ranked higher than Hurts who cost ZERO picks" or "half the QB market is available for less money."
- Say "what they'd cost at auction" in general terms, never quote specific model values for free agents.
- DO cite the traded player's actual salary and effective cost after traded salary.
- When traded salary (budget bucks) reduces effective cost, ALWAYS note it.
- IMMEDIATE PRIOR CONTEXT ONLY: when framing an owner's situation, reference only the season immediately before they took over plus the seasons they've actually played. Don't reach back to ancient championship history (>3 seasons before the owner's tenure) unless they personally played in those seasons. A 2018 championship doesn't roast a 2025 owner who inherited the franchise.
- Reference the OWNER'S personal allplay record (not the franchise's full history if different owners).
  Each owner's tenure and stats are labeled clearly. Only roast them for seasons they actually played.
  If the franchise had a recent bad run under prior owners, frame it as "the franchise finished X / Y / Z the last three years" — not as the current owner's record.
- CAP SPACE: mention cap space and total roster salary ONLY when the trade includes PLAYERS or BUDGET BUCKS. For pick-only trades (just draft picks moving), cap space is irrelevant — do not mention it.
- OFFSEASON PPG: NEVER cite a player's current-season PPG before that season has started. The 2026 season has NOT started — current PPG is 0.0 by definition and means nothing. Use prior-season PPG (last completed season) or a 3-year recent average if you need a production reference.
- FUTURE-PICK CONFIDENCE: when predicting where a future pick will land, treat the prediction as TENTATIVE if the OWNER has fewer than 3 completed seasons. For new owners (1-2 seasons), reference the franchise's recent finish range ("the franchise finished 9-12-12 the last three years") but DON'T claim a specific slot ("that 2027 1st will be 1.04"). For owners with 3+ seasons of consistent results (always bottom-3, always top-4), high-confidence predictions ARE fair game.
- DO NOT invent owner-tendency claims (e.g. "0% deal rate", "you ALWAYS overpay at QB") unless the data payload explicitly contains them. If trade-tendency data is missing from the payload, focus on what you DO have: their record, finishes, drought.
- The 2026 season has NOT started yet. Do not reference 2026 allplay or win/loss records.
- If someone fears the auction or shows weakness, call them a coward. Be savage.
- Grade each side A+ through F.
- Keep each team's roast to 150-200 words. Punchy, not rambling.
- End with a VERDICT section naming the winner and one devastating observation.
- Do NOT use markdown headers (no ## or **). Use plain text with ALL CAPS for emphasis.
- Separate the two team roasts clearly.

FORMAT:
[TEAM NAME] — GRADE: [X]
[roast text]

[TEAM NAME] — GRADE: [X]
[roast text]

VERDICT
[2-3 sentences naming winner, most damning stat, prediction]
"""

CLAP_BACK_SYSTEM = """\
You are the UPS Trade Analyst bot. Someone just replied to your trade roast \
on Discord. Your job: classify the reply and respond.

If they show FEAR ("no guarantee at auction", "what if nobody bids", \
"it's risky") — call them a coward/pussy. Cite their record to show \
they should be MORE aggressive, not less.

If they show BASELESS CONFIDENCE ("we're winning the chip") — destroy them \
with their historical record, allplay win rate, and championship drought.

If they attack the analysis ("this is trash", "model is broken") — remind \
them the model uses 3 years of weekly scoring data, and their opinion is \
based on vibes and copium.

If they make a GOOD POINT with actual data or logic — acknowledge it briefly. \
"Fair point. Logged." Keep it short.

If it's just an emoji, "L", "ratio", or low-effort — one devastating line.

RULES:
- Max 100 words for the clap back. Punchy.
- Always cite at least one specific number.
- Never apologize. Never back down unless they have a genuinely good point.
- Plain text only, no markdown.
"""

CLASSIFY_SYSTEM = """\
Classify this Discord reply to a fantasy football trade roast into exactly one category.

Return ONLY valid JSON with these fields:
{"category": "VALUE_SIGNAL" | "DATA_ERROR" | "COPE", "details": "brief explanation", "clap_back_warranted": true | false}

VALUE_SIGNAL: Person disagrees with a player's value with reasoning. Extract player + direction.
DATA_ERROR: Person claims a factual error (salary, contract, pick ownership). Extract what's wrong.
COPE: Person is salty, scared, deflecting, or offering no substance. Clap back warranted.
"""


# ── Generation Functions ───────────────────────────────────────────────────

def generate_trade_roast(context_text: str) -> str:
    """Generate a trade roast using Claude Opus."""
    client = get_client()
    message = client.messages.create(
        model=MODEL,
        max_tokens=2048,
        system=ROAST_SYSTEM,
        messages=[{
            "role": "user",
            "content": f"Roast this trade. Use ALL the data provided. Be ruthless.\n\n{context_text}",
        }],
    )
    return message.content[0].text


def classify_reply(reply_text: str, original_context: str) -> dict:
    """Classify a Discord reply to a roast."""
    client = get_client()
    message = client.messages.create(
        model="claude-sonnet-4-6",  # sonnet for classification speed
        max_tokens=256,
        system=CLASSIFY_SYSTEM,
        messages=[{
            "role": "user",
            "content": (
                f"Original trade roast context:\n{original_context[:1000]}\n\n"
                f"Discord reply:\n{reply_text}"
            ),
        }],
    )
    try:
        return json.loads(message.content[0].text)
    except json.JSONDecodeError:
        return {"category": "COPE", "details": "unparseable", "clap_back_warranted": True}


def generate_clap_back(reply_text: str, original_context: str,
                       replier_franchise_context: str = "") -> str:
    """Generate a clap back to a Discord reply.

    Uses Sonnet (per Keith 2026-05-22): clap-backs need speed for live
    Discord conversation; Sonnet is ~3-5x faster than Opus with sufficient
    voice quality for the short-form rebuttal.
    """
    client = get_client()
    message = client.messages.create(
        model="claude-sonnet-4-6",
        max_tokens=512,
        system=CLAP_BACK_SYSTEM,
        messages=[{
            "role": "user",
            "content": (
                f"Original trade analysis context:\n{original_context[:2000]}\n\n"
                f"Replier's franchise history:\n{replier_franchise_context}\n\n"
                f"Their reply: \"{reply_text}\"\n\n"
                f"Destroy them."
            ),
        }],
    )
    return message.content[0].text


# ── Content Archive ────────────────────────────────────────────────────────

from pathlib import Path
ARCHIVE_PATH = Path(__file__).resolve().parent.parent / "data" / "content_archive.json"


def load_archive() -> list:
    if ARCHIVE_PATH.exists():
        with open(ARCHIVE_PATH) as f:
            return json.load(f)
    return []


def save_to_archive(entry: dict):
    """Append a content entry to the archive."""
    archive = load_archive()
    archive.append(entry)
    ARCHIVE_PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(ARCHIVE_PATH, "w") as f:
        json.dump(archive, f, indent=2, default=str)


# ── Sentiment / Error Logging ──────────────────────────────────────────────

SENTIMENT_PATH = Path(__file__).resolve().parent.parent / "data" / "league_sentiment.json"
REVIEW_PATH = Path(__file__).resolve().parent.parent / "data" / "data_review_queue.json"


def log_value_signal(details: str, reply_text: str, franchise_id: str = ""):
    _append_json(SENTIMENT_PATH, {
        "type": "value_signal",
        "details": details,
        "reply": reply_text,
        "franchise_id": franchise_id,
    })


def log_data_error(details: str, reply_text: str, franchise_id: str = ""):
    _append_json(REVIEW_PATH, {
        "type": "data_error",
        "details": details,
        "reply": reply_text,
        "franchise_id": franchise_id,
    })


def _append_json(path: Path, entry: dict):
    from datetime import datetime, timezone
    entry["timestamp"] = datetime.now(timezone.utc).isoformat()
    data = []
    if path.exists():
        with open(path) as f:
            data = json.load(f)
    data.append(entry)
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w") as f:
        json.dump(data, f, indent=2)
