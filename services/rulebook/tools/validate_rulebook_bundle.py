#!/usr/bin/env python3
import sys
from pathlib import Path


SERVICE_ROOT = Path(__file__).resolve().parents[1]
if str(SERVICE_ROOT) not in sys.path:
    sys.path.insert(0, str(SERVICE_ROOT))

from rulebook_core import validate_rulebook_files


def main():
    validate_rulebook_files()
    print("Rulebook bundle validation passed.")


if __name__ == "__main__":
    main()
