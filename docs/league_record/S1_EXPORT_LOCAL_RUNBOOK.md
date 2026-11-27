# League Record S1: local runbook for the approved exports A1 to A4 (for the commissioner's review before running)

**Approved (2026-11-21):** the four exact read-only requests A1 to A4 in `S1_MFL_EXPORT_REQUESTS.md`, **run by the commissioner locally with the commissioner's own credentials**. **Not approved:** B1, B2 and N1 to N3. **Not done:** nothing has been run. Claude does not retrieve credentials, does not run the requests, and has not seen any response.

Register: LR-02 (the gap), LR-16 (archive provenance), LR-17 (export handling controls) on issue #1486.

## 1. What is in the package (`scripts/league_record/s1/export_package/`)

| File | What it is |
|---|---|
| `run_a1_a4.sh` | Sends exactly four HTTP GET requests, stops at the first problem, saves raw responses to a **private folder outside the repository**. |
| `sanitize_exports.mjs` | Offline (no network, no credential). Reads that folder, checks every response, writes a small **sanitized extract** and a **manifest** next to it. |

Both are tested in `tests/league_record_s1_archive.test.mjs` (stub `curl`, synthetic responses; no network, no real data).

## 2. Review before running (about five minutes, nothing is sent)

```bash
./scripts/league_record/s1/export_package/run_a1_a4.sh --print      # shows the four requests with the key replaced by REDACTED; reads no key, uses no network
```

Then read `run_a1_a4.sh` (about 90 lines) for these properties; each is also checked by a test:

1. **Exactly four requests, all `export` GETs**, host `www48.myfantasyleague.com`, league `74598`, years 2025 and 2026, no `COUNT`, no `DAYS`, no import. The same four are held in `sanitize_exports.mjs`, and the tests fail if the runner, the sanitizer and the approved document ever differ.
2. **No credential is fetched from anywhere.** It asks you to type the 2025 key and the 2026 key (`read -s`, nothing echoed). It reads no file, no environment variable, no keychain, no password manager, no repository.
3. **A key is never in a file, a history line, a printed line or a process argument.** It lives in a shell variable, is URL-encoded, and goes to `curl` on its standard input (`--config -`).
4. **Redirects are refused** (`--max-redirs 0`, no `--location`): a 3xx is a stop. Any HTTP status other than 200, a `curl` failure, or an MFL error body inside an HTTP 200 also stops the run at once; later requests are not sent.
5. **The output folder is private and outside any git work tree.** Default `$HOME/ups_league_record_exports/2026-11` (override with `OUT=...`); mode 700, files 600; the script refuses a folder inside a repository.

## 3. Running it (when you decide to)

```bash
./scripts/league_record/s1/export_package/run_a1_a4.sh
node scripts/league_record/s1/export_package/sanitize_exports.mjs --dir "$HOME/ups_league_record_exports/2026-11"
```

The first command prompts for the two keys and prints one line per request (name, HTTP status, bytes). The second checks and sanitizes. **If either stops, do not retry with another credential; send me only the printed STOP line. It holds a fixed label and counts, never a key, a record, a token or a name (the sanitizer is built and tested so that it cannot print response content).**

## 4. What the sanitizer checks (a stop is exit 2; dropped records give exit 3)

| Check | On failure |
|---|---|
| The recorded request equals the approved one (host, path, query), HTTP 200, the file size equals the recorded size, a capture time exists | stop |
| The response is JSON, not an error object, has no unexpected top-level field, has the expected structure | stop |
| Every trade timestamp lies inside the instance year (a different instance would not) | stop |
| Every record is a `TRADE`; every token is a player id, a future-pick token, a slot token or cap money (decimals such as `BB_3000.00` accepted exactly as recorded) | stop |
| A future pick has an original franchise (`originalPickFor`); **no default is ever substituted** | stop |
| **Source identity:** the franchises in each instance's trades all belong to the league that the same instance's future-pick export lists | stop |
| A record that is not an executed trade of the archive's shape (a **pending offer** would be one) | dropped, counted, never read further; exit 3 |
| Free-text comments, expiry times, descriptions and any unrecognized field | dropped, counted; never kept |

## 5. What may be shared, and what must not

- **Share (with me, or in a GitHub comment) only:** the `sanitized/` folder and `manifest.json`. They hold trade times, franchise ids, asset tokens, future-pick holders, hashes and counts. No comment, name, e-mail, credential or pending offer.
- **Never share, commit or paste:** anything under `raw/`. Keep it private on your machine. (`requests.log` holds no key and is harmless, but is not needed.)
- Nothing from this runbook is written to the repository or GitHub automatically.

## 6. How the results are read (decided in advance)

- **A1 and A2** (trades): compared record for record with the archive and the 2026 snapshots (check E1). An export that is **empty or shows no trade in the gap does not prove that no trade occurred**: it shows what MFL still holds and cannot show a change MFL never logged as a trade. Any difference from the archive in the covered range is a **finding with both versions**, never a repair.
- **A3** (2025 future picks): the **date of this end state is unknown** (the 2025 instance may have been frozen at its rollover or written later). It brackets the start of the gap and is not a dated observation.
- **A4** (2026 future picks): a **current dated observation** (its capture time is in the manifest). It shows who holds each pick **on that date**; it is not proof of historical ownership.
- Together the four can support, at most, a verification **candidate per league instance** under `S1_SOURCE_COVERAGE_MODEL.md` (2025 for 2025-11-28 to 2025-12-31, 2026 for 2026-01-01 to 2026-03-07). It becomes `VERIFIED_COMPLETE` only if every required check passes, including an end-state reconciliation with a known date. Nothing resolves a future pick by itself.
- All four stay `KNOWN_GAP` / unresolved until the results are reconciled and reviewed; the register (#1486, LR-02) records the outcome.

## 7. Unverified until the run

Whether one key serves both league-years (believed not, hence two prompts); whether your key carries commissioner rights (then trade exports may include other franchises' pending offers, which the sanitizer drops); whether MFL serves the 2025 future-picks export after the rollover; whether MFL answers an error as HTTP 200 (handled). Each of these, if it happens, is a STOP or a manifest note, not a guess.
