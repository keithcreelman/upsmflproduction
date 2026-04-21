"""
trade_grader_prompt.py — Claude API prompt templates for trade roast generation.

Generates context-rich prompts that can be sent to Claude API to produce
entertaining, data-driven trade roasts for Discord.

Usage:
    from trade_grader_prompt import build_roast_prompt
    prompt = build_roast_prompt(trade_context)
    # Send to Claude API
"""

SYSTEM_PROMPT = """\
You are the UPS Trade Intelligence Analyst — a brutally honest, data-driven \
fantasy football trade analyst for a 12-team Superflex dynasty salary cap league. \
Your job is to grade trades and ROAST the participants.

Rules:
- Always back up your roasts with SPECIFIC numbers (Exp$, PPG, salary, cap %)
- Compare what they DID to what they COULD HAVE done (auction alternatives)
- Reference the salary cap ($300K), contract extension rules, and draft pick values
- Be funny, savage, and specific — no generic "this is a bad trade" takes
- Use analogies (cars, shopping, dating, etc.) to make the numbers relatable
- The winner gets praised but still gets light jabs for anything they left on the table
- The loser gets absolutely destroyed with data
- Format for Discord (markdown, use code blocks for tables)
- Keep each team's section to ~150 words max — punchy, not rambling
"""

ROAST_TEMPLATE = """\
Generate a trade roast for the following UPS league trade.

{context}

Write two sections:
1. **ROAST for {loser_name}** (the team that got the worse deal) — Grade: {loser_grade}
   - Lead with a devastating one-liner
   - Break down exactly why this was bad using the numbers
   - Compare to what they could have done at auction instead
   - End with a savage analogy

2. **ROAST for {winner_name}** (the team that won the trade) — Grade: {winner_grade}
   - Acknowledge the win but find something to nitpick
   - Show why the numbers work in their favor
   - Note what they could have done even BETTER
   - End with backhanded praise

Keep it under 300 words total. Be specific with dollar amounts and PPG numbers.
"""

VERDICT_TEMPLATE = """\
Based on this trade analysis, write a 2-3 sentence verdict:

{context}

The verdict should:
- Name the clear winner
- State the single most damning number for the loser
- End with a prediction about what happens next for both teams
"""


def build_roast_prompt(context: str, winner_name: str, winner_grade: str,
                       loser_name: str, loser_grade: str) -> dict:
    """Build a complete prompt payload for Claude API roast generation.

    Returns dict with 'system' and 'user' keys ready for the API call.
    """
    return {
        "system": SYSTEM_PROMPT,
        "user": ROAST_TEMPLATE.format(
            context=context,
            winner_name=winner_name,
            winner_grade=winner_grade,
            loser_name=loser_name,
            loser_grade=loser_grade,
        ),
    }


def build_verdict_prompt(context: str) -> dict:
    """Build a verdict prompt for Claude API."""
    return {
        "system": SYSTEM_PROMPT,
        "user": VERDICT_TEMPLATE.format(context=context),
    }


# ── Example: How to use with Claude API ──────────────────────────────────

USAGE_EXAMPLE = """
# Example integration with Anthropic SDK:

import anthropic
from trade_grader import main as analyze_trade
from trade_grader_prompt import build_roast_prompt

# 1. Run analysis to get context
context = analyze_trade(roast_context=True)  # returns context string

# 2. Build prompt
prompt = build_roast_prompt(
    context=context,
    winner_name="HammerTime",
    winner_grade="A-",
    loser_name="The Long Haulers",
    loser_grade="D+",
)

# 3. Call Claude API
client = anthropic.Anthropic()
message = client.messages.create(
    model="claude-sonnet-4-6",
    max_tokens=1024,
    system=prompt["system"],
    messages=[{"role": "user", "content": prompt["user"]}],
)

# 4. Post to Discord
roast_text = message.content[0].text
# discord_bot.send_message(channel_id, roast_text)
"""
