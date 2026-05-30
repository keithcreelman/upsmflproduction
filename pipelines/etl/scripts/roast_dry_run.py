"""
roast_dry_run.py — Build the Roast Bot context for a trade and print the
exact prompt text that would be sent to Opus. No Anthropic API call, no
Discord posting. Validates the data pipeline end-to-end.

Usage:
    python roast_dry_run.py                  # Hurts trade (default)
    python roast_dry_run.py --ts 1775772921  # specific trade timestamp
"""

import argparse
import json
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR))

from trade_grader import fetch_trades
from trade_roast_context import build_trade_roast_context, context_to_prompt_text


HURTS_TRADE_TS = 1775772921


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ts", type=int, default=HURTS_TRADE_TS)
    ap.add_argument("--ext-years", type=int, default=2)
    ap.add_argument("--ext-player", type=str, default="14783")
    ap.add_argument("--show-dict", action="store_true",
                    help="Also dump the raw context dict as JSON")
    args = ap.parse_args()

    print(f"=== Fetching trades from MFL API ===")
    trades = fetch_trades()
    print(f"  fetched {len(trades)} trades")
    trade = next((t for t in trades if int(t.get("timestamp", 0)) == args.ts), None)
    if not trade:
        print(f"ERROR: trade {args.ts} not found")
        sys.exit(1)

    print(f"=== Building context for trade {args.ts} ===")
    ctx = build_trade_roast_context(
        trade,
        extension_years=args.ext_years,
        extension_player_id=args.ext_player,
    )

    print()
    print("=" * 70)
    print("PROMPT TEXT (this is what Opus would see)")
    print("=" * 70)
    print(context_to_prompt_text(ctx))
    print("=" * 70)

    if args.show_dict:
        print()
        print("=== RAW CONTEXT DICT ===")
        print(json.dumps(ctx, indent=2, default=str)[:5000])


if __name__ == "__main__":
    main()
