"""Safe offline suite -- loopback-only network guard for Python.

scripts/safe_tests/run.mjs puts this directory first on PYTHONPATH, so Python
imports this module at startup in every Python process the suite starts,
including subprocesses that inherit the environment. It is one layer of
several (see docs/SAFE_TESTS.md).

Any connect, UDP send or name lookup aimed at a host that is not loopback
raises SafeTestsNetworkBlocked (an OSError, so code that handles a dead network
handles this too). Loopback stays open for local fixture servers. Every blocked
attempt is appended to $SAFE_TESTS_BLOCK_LOG so the runner can report it even if
the test swallowed the error.
"""

import ipaddress
import json
import os
import socket
import sys

_LOOPBACK_NAMES = {"localhost", "ip6-localhost", "ip6-loopback"}


def _is_loopback(host):
    """True only for the loopback names above or a literal loopback/unspecified IP.

    Parsed with ipaddress on purpose: a prefix test such as startswith("127.")
    would also wave through a real hostname like 127.example.com.
    """
    if host is None or host == "":
        return True
    if isinstance(host, bytes):
        host = host.decode("ascii", "replace")
    h = str(host).strip().lower()
    if h.startswith("[") and h.endswith("]"):
        h = h[1:-1]
    if h in _LOOPBACK_NAMES:
        return True
    try:
        ip = ipaddress.ip_address(h.split("%", 1)[0])
    except ValueError:
        return False
    if ip.version == 6 and ip.ipv4_mapped is not None:
        ip = ip.ipv4_mapped
    return ip.is_loopback or ip.is_unspecified


class SafeTestsNetworkBlocked(OSError):
    pass


def _blocked(what, target):
    sys.stderr.write("[safe-tests] BLOCKED %s -> %s\n" % (what, target))
    log = os.environ.get("SAFE_TESTS_BLOCK_LOG")
    if log:
        try:
            with open(log, "a", encoding="utf-8") as fh:
                fh.write(json.dumps({"lang": "python", "pid": os.getpid(), "what": what,
                                     "target": target, "argv0": (sys.argv[0] if sys.argv else "")}) + "\n")
        except Exception:
            pass
    return SafeTestsNetworkBlocked(
        "[safe-tests] network blocked: %s -> %s. The safe offline suite allows loopback only. "
        "A test that needs the network is not an offline test: stub the call, or exclude the file in "
        "tests/safe_suite.json with a named reason." % (what, target))


_INET = {socket.AF_INET, getattr(socket, "AF_INET6", socket.AF_INET)}


def _target(sock, address):
    if sock.family not in _INET or not isinstance(address, tuple) or not address:
        return None
    return address[0], (address[1] if len(address) > 1 else "")


_real_connect = socket.socket.connect
_real_connect_ex = socket.socket.connect_ex
_real_sendto = socket.socket.sendto
_real_getaddrinfo = socket.getaddrinfo
_real_gethostbyname = socket.gethostbyname
_real_gethostbyname_ex = socket.gethostbyname_ex


def _connect(self, address):
    t = _target(self, address)
    if t and not _is_loopback(t[0]):
        raise _blocked("socket.connect", "%s:%s" % t)
    return _real_connect(self, address)


def _connect_ex(self, address):
    t = _target(self, address)
    if t and not _is_loopback(t[0]):
        raise _blocked("socket.connect_ex", "%s:%s" % t)
    return _real_connect_ex(self, address)


def _sendto(self, data, *args):
    address = args[-1] if args else None
    t = _target(self, address)
    if t and not _is_loopback(t[0]):
        raise _blocked("socket.sendto", "%s:%s" % t)
    return _real_sendto(self, data, *args)


def _getaddrinfo(host, *args, **kwargs):
    if not _is_loopback(host):
        raise _blocked("socket.getaddrinfo", str(host))
    return _real_getaddrinfo(host, *args, **kwargs)


def _gethostbyname(host):
    if not _is_loopback(host):
        raise _blocked("socket.gethostbyname", str(host))
    return _real_gethostbyname(host)


def _gethostbyname_ex(host):
    if not _is_loopback(host):
        raise _blocked("socket.gethostbyname_ex", str(host))
    return _real_gethostbyname_ex(host)


socket.socket.connect = _connect
socket.socket.connect_ex = _connect_ex
socket.socket.sendto = _sendto
socket.getaddrinfo = _getaddrinfo
socket.gethostbyname = _gethostbyname
socket.gethostbyname_ex = _gethostbyname_ex
os.environ["SAFE_TESTS_PYTHON_GUARD"] = "1"


# This module shadows any sitecustomize the interpreter ships with (Homebrew and
# some distro Pythons have one). Run the next one on sys.path so the
# interpreter behaves as it normally would apart from the guard.
def _chain():
    here = os.path.dirname(os.path.abspath(__file__))
    for entry in sys.path:
        if not entry or os.path.abspath(entry) == here:
            continue
        candidate = os.path.join(entry, "sitecustomize.py")
        if os.path.isfile(candidate):
            with open(candidate, "r", encoding="utf-8") as fh:
                code = compile(fh.read(), candidate, "exec")
            exec(code, {"__name__": "sitecustomize", "__file__": candidate})
            return


try:
    _chain()
except Exception as exc:  # a broken chained sitecustomize must not disable the guard
    sys.stderr.write("[safe-tests] note: chained sitecustomize failed: %r\n" % (exc,))
