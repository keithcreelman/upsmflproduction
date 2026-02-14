#!/usr/bin/env python3
"""Backward-compatible wrapper for renamed script."""
import runpy
from pathlib import Path

runpy.run_path(str(Path(__file__).resolve().with_name("ingest_discord_contracts.py")), run_name="__main__")
