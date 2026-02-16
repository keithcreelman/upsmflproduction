#!/usr/bin/env python3
"""Backward-compatible wrapper for renamed script."""
import runpy
from pathlib import Path

runpy.run_path(str(Path(__file__).resolve().with_name("ingest_contract_logs_2019_2021.py")), run_name="__main__")
