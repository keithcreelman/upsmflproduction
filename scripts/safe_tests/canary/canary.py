"""Guard canary (Python). run.mjs executes this under the suite's environment
before any test; the run aborts unless every external attempt is blocked by the
guard and loopback still works.

Targets are deliberately harmless even if a guard were broken: 192.0.2.1 is
TEST-NET-1 (RFC 5737, never routed) and .invalid never resolves (RFC 6761).
"""
import http.server
import json
import os
import socket
import sys
import threading
import urllib.request

results = {}


def attempt(name, fn):
    try:
        fn()
        results[name] = "REACHED"
    except Exception as exc:  # noqa: BLE001 -- we classify every outcome
        text = "%s %s" % (type(exc).__name__, getattr(exc, "reason", exc))
        results[name] = "blocked" if "SafeTestsNetworkBlocked" in text or "[safe-tests] network blocked" in text else "unexpected: " + text[:120]


attempt("urllib", lambda: urllib.request.urlopen("http://192.0.2.1:9/canary", timeout=3))
attempt("tcp", lambda: socket.create_connection(("192.0.2.1", 9), timeout=3))
attempt("dns", lambda: socket.getaddrinfo("safe-tests-canary.invalid", 443))


class Quiet(http.server.BaseHTTPRequestHandler):
    def do_GET(self):  # noqa: N802
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b"loopback-ok")

    def log_message(self, *args):
        pass


server = http.server.HTTPServer(("127.0.0.1", 0), Quiet)
threading.Thread(target=server.handle_request, daemon=True).start()
try:
    results["loopback"] = urllib.request.urlopen("http://127.0.0.1:%d/" % server.server_port, timeout=5).read().decode()
except Exception as exc:  # noqa: BLE001
    results["loopback"] = "failed: %r" % (exc,)
results["guardLoaded"] = os.environ.get("SAFE_TESTS_PYTHON_GUARD") == "1"
print(json.dumps(results))
ok = all(results[k] == "blocked" for k in ("urllib", "tcp", "dns")) and results["loopback"] == "loopback-ok" and results["guardLoaded"]
sys.exit(0 if ok else 1)
