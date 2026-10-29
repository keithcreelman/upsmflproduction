import os, sys, unittest
HERE = os.path.dirname(__file__)
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
sys.path.insert(0, os.path.join(ROOT, "scripts", "punter"))
P = os.path.join(ROOT, "data", "punter", "processed")
def need(*names):
    """Skip (never pass) when the locally built dataset files are absent. Rebuild with scripts/punter/*.py (see reports/punter/methodology.md)."""
    missing = [n for n in names if not os.path.exists(os.path.join(P, n))]
    return unittest.skipIf(bool(missing), "SKIPPED: build data first, missing %s" % missing)
