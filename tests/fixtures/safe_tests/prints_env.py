# Fixture for tests/safe_tests_runner.test.mjs: the Python twin of prints_env.mjs.
import json
import os

print("SAFE_TESTS_ENV " + json.dumps({"keys": sorted(os.environ), "guard": os.environ.get("SAFE_TESTS_PYTHON_GUARD") == "1"}))
