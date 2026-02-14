#!/usr/bin/env python3
"""Backward-compatible wrapper for renamed script."""
import runpy
from pathlib import Path

runpy.run_path(str(Path(__file__).resolve().with_name("migrate_legacy_contract_xml.py")), run_name="__main__")
