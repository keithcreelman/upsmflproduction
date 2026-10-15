# Safe offline tests

One command runs every approved offline test in this repository, locally and in CI:

```bash
node scripts/safe_tests/run.mjs
```

`--list` shows what would run and what is excluded without running anything. `--only <text>` runs the planned tests whose path contains the text. The GitHub check **Safe offline tests** (`.github/workflows/safe-tests.yml`) runs the same command on every pull request and writes the report to the job summary.

The command never reads production, writes to MFL, D1, Discord or GitHub, deploys, reads the Keychain, or calls a paid API. That is enforced by the layers below, not by trusting each test.

## What runs

Discovery is explicit and lives in `tests/safe_suite.json`:

| Pattern | Runner | How each file runs |
| --- | --- | --- |
| `tests/*.test.mjs`, `tests/*_test.js` | Node 22.13+ (`node:sqlite`) | `node <file>` from the repo root |
| `pipelines/**/test_*.py` | Python 3.11+ | `python3 <file>` from the repo root |

Each file runs in its own process; most of these are plain scripts that check and `sys.exit`, so `pytest` and `unittest discover` do not work on them. Do not run `node --test` or `pytest` from the repo root as a substitute: they have no exclusions and no guards. Outside this runner, two current tests still make real MFL reads (see "Known network attempts").

## Exclusions are named, never silent

Every file the suite does not run fully is listed in `tests/safe_suite.json` with a category and a reason, and printed in every report.

| Category | Meaning |
| --- | --- |
| `send-capable` | Can write to MFL, D1, Discord or GitHub, deploy, or call a paid API |
| `prod-read` | Reads production (MFL, D1, the live worker, Keychain credentials) |
| `prod-read-opt-in` | Reads production only behind an explicit flag; the suite never opts in |
| `needs-network` | Needs the public internet (for example, downloads a package at run time) |
| `needs-unavailable-input` | Needs a gitignored file, local database or input a clean checkout lacks |
| `not-a-test` | Named like a test but is a helper, fixture or manual tool |
| `known-failing` | Fails on `main` today; listed so it stays visible |

Other manifest sections:
- `partial`: run a file with an argument that switches off one failing section (for example `--no-backtest`). Write, opt-in and production flags are refused.
- `known_network_attempts`: a test that tries an external host, survives the block and passes. Each target is named. Any other blocked attempt fails the run.
- `tripwire_reviewed`: a file whose source matches a production-tooling pattern only as test data, with the reason a person checked it.
- `env`: non-secret variables a test needs. Names that look like secrets or opt-ins are refused.

## How it stays offline

1. **Explicit discovery and a never-run list.** Only git-tracked files matching the patterns above are considered. Paths under dot-directories (`.claude/worktrees` holds whole old checkouts, including the deleted `test_fire_ab.py` that posted to Discord, #1233) and known send scripts are refused by name.
2. **Tripwire.** A planned test whose source invokes `wrangler --remote`, a deploy, the Keychain, a network CLI or a credential variable is not run until a person classifies it.
3. **Scrubbed environment.** Tests get a fresh environment: no inherited tokens, cookies, API keys or opt-in variables, and a throwaway `HOME`, so CLI logins (wrangler, gh) are not found.
4. **Blocked commands.** `wrangler`, `npx`, `npm`, `curl`, `wget`, `gh`, `security`, `op`, `ssh`, `launchctl`, `crontab`, `open`, `docker` and similar commands are replaced on `PATH` by stubs that exit 97. `git` runs local subcommands only (`push`, `fetch`, `pull`, `clone` and `remote` are refused).
5. **Network guards.** Every Node process loads `scripts/safe_tests/guards/no_network.mjs` (via `NODE_OPTIONS`). Every Python process loads `scripts/safe_tests/guards/python/sitecustomize.py` (via `PYTHONPATH`). Any connection, DNS lookup or UDP send to a host other than loopback fails like a dead network and is logged. Loopback stays open for local fixture servers.
6. **CI network namespace.** In GitHub Actions the whole suite runs inside a network namespace whose only interface is loopback. It runs as the runner user with every supplementary group dropped (no Docker socket) and `no-new-privs`, so `sudo` cannot leave it. `--expect-no-network` fails the run if any other interface exists.
7. **Proof before running.** Canary scripts try external targets that are harmless even if reached: `192.0.2.1` (TEST-NET-1, never routed) and `.invalid` names. They confirm the guards block them, loopback works, the command stubs exit 97 and no secret-looking variable is present. If any check fails, no test runs.
8. **After the run.** The working tree must be unchanged, and each blocked network attempt is reported against the test that made it.

`tests/safe_tests_runner.test.mjs` exercises these promises on every run. It checks that a failing fixture turns the run red, a swallowed network call is caught, planted secrets never reach a Node or Python test, and every file a stock `node --test` or `pytest` would collect is classified.

### What the guards do not stop (locally)

On a developer machine, layers 1 to 5 are the barrier; there is no OS-level network isolation. A test could still bypass them by:
- calling a binary by absolute path (`/usr/bin/curl`) or re-ordering `PATH` (`scripts/sync_live_season_weekly.sh` prepends `/opt/homebrew/bin`);
- starting a child process with an environment that drops `NODE_OPTIONS` or `PYTHONPATH`;
- using raw sockets (`_socket`, `ctypes`, `process.binding`).

The macOS Keychain is reached through `securityd`, not `HOME`, so a direct API call (not the blocked `security` command) could still read it. CI adds the network namespace, which closes the network side of all of these. Treat a new test that does any of the above as a review finding.

## Production-reading tests: opt-in only

A test that must read production follows the #1239 pattern: it does nothing unless it gets an explicit flag or variable. For example, `test_asof_leakage.py` needs `--allow-prod-d1` or `UPS_ALLOW_PROD_D1_READS=1`. By default it prints `SKIPPED` and exits 0. An offline twin (`test_asof_leakage_offline_default.py`) runs in the suite and proves the default makes no D1 call. The suite strips such variables and refuses such flags; the file itself is excluded as `prod-read-opt-in`. Run production checks by hand, deliberately, and measure them under `docs/D1_QUERY_RULES.md`.

## Adding a test

- Name it `tests/<topic>.test.mjs` (or `pipelines/.../test_<topic>.py`). It must pass with no network: stub `fetch`, `env.SELF` and D1 (`tests/fixtures/` has harnesses).
- Run `node scripts/safe_tests/run.mjs --only <topic>` and then the full command.
- If it cannot run offline, do not weaken the guards: add a named exclusion with a reason and, for `known-failing`, an issue.
