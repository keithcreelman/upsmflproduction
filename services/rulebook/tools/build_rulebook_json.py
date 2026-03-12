#!/usr/bin/env python3
import sys
from pathlib import Path


SERVICE_ROOT = Path(__file__).resolve().parents[1]
if str(SERVICE_ROOT) not in sys.path:
    sys.path.insert(0, str(SERVICE_ROOT))

from rulebook_core import build_rulebook_outputs


def main():
    payloads = build_rulebook_outputs()
    print(f"Wrote {len(payloads['rules']['documents'])} documents.")
    print(f"Wrote {len(payloads['ai']['chunks'])} AI chunks.")


if __name__ == "__main__":
    main()
