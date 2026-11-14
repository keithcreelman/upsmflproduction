# UPS Center weekly review email and approval gate

Code: `pipelines/etl/wire/ups_center_review.py`. Test: `pipelines/etl/wire/test_ups_center_review.py` (offline, fake gh/git, fake SMTP).

## Flow
1. The scheduled job (`ups_center_auto.py`) builds or updates the week's draft PR. An editor's rewrite of that PR is read as-is.
2. The week is **ready** when the draft validates with no errors and Elias is settled: official changes posted and checked, or the Friday 09:00 ET final look has passed.
3. When ready, one email goes to `keith.creelman@gmail.com` only: main story, PDF of the rendered issue, the gaps the article itself still lists, the Elias status, the PR link, and the exact approve / request-changes lines. One send per article version; an edit sends one `UPDATED` email.
4. Approval is a comment on the PR from `keithcreelman`, exactly one line: `APPROVE <issue id> article=<12 hex>`. The hash is of the article file, so any later edit voids it. Edited comments, status-line comments, agent headers and extra text never count. `CHANGES <issue id> ...` revokes. `ups_center_review.py gate --pr N` exits 0 only when approved.
5. Publishing and the Discord announcement are separate steps. An email, a build, or a passing gate does not publish anything; this module never writes to GitHub or Discord.

## Turning it on (off by default)
Sending needs a Gmail app password in the macOS Keychain, then `--review-email` (or `UPS_CENTER_REVIEW_EMAIL=1`) on the scheduled run:
```
security add-generic-password -s upsmfl-ups-center-review -a keith.creelman@gmail.com -w
```
Without it, `compose` writes the .eml and PDF to `~/Library/Caches/upsmfl-ups-center-auto/reviews/outbox` and nothing is sent. `compose --preview` does this before the week is final (subject marked PREVIEW) and can never be sent.
