# League Record S1: cap-token correction (register LR-05; prepared for review)

**Status:** FIXED_PENDING_VERIFICATION. A narrow, source-preserving parser correction with regression tests, on draft PR #1484. No raw record was altered, no production system touched, no D1 change.

## 1. What was wrong

Two 2025 trades carry **decimal cap tokens** in MFL's own trade record:

| Trade | Date | Sender to receiver | Raw token (sender's give-up list) | Archive amount column |
|---|---|---|---|---|
| `trade2025_35` | 2025-08-07 | 0006 to 0010 | `BB_3000.00` | blank (4 blank rows = 2 transfers) |
| `trade2025_60` | 2025-10-16 | 0006 to 0011 | `BB_5000.00` | blank |

The archive's amount column is blank for them, and the extraction's token reader accepted only whole numbers (`BB_<digits>`). The extraction therefore counted both transfers as **0**, so the 2025 cap-transfer aggregate (274,000) and the all-seasons aggregate (1,692,000) were **understated by 8,000**. The count of transfers (130; 22 in 2025) and their direction were already right, because they come from the paired rows.

## 2. The correction (narrow, source-preserving)

- **First source stays the archive's amount column.** It is never replaced when populated.
- **When the column is blank**, the amount is read from the **sender's own give-up list** in the raw payload, and only if that list holds **exactly one** well-formed cap token. The other side's list is never used.
- **Grammar:** `BB_<1 to 9 digits>` with an optional `.` and 1 to 6 decimal digits. The amount is the exact decimal as recorded. A sign, an exponent, a second dot, an empty amount, a comma or a space is **refused**, not guessed. A non-whole amount is flagged `fractional`.
- **Anything else is unrecoverable:** several cap tokens in the sender's list, a malformed token, or none: the amount stays **blank** (never 0, never a default) and is listed in the findings. Today: 0.
- **If both sources exist and disagree**, the column wins and the disagreement is recorded (`cap_amount_conflicts`). Today: 0.
- Every cap movement now carries `amount_source` (`archive_column`, `raw_token` or `unrecoverable`) and, when read from a token, the token itself, so a reader can always see where a number came from.
- The same grammar is used by the 2026 snapshot parser, so a decimal token there is read the same way (it was previously an "unknown" token).
- Only the three fields needed (`franchise`, `franchise1_gave_up`, `franchise2_gave_up`) are read from the raw payload; free-text comments are not read.

## 3. Effect (before and after, from the committed extraction)

| Figure | Before | After |
|---|---|---|
| 2025 cap-transfer amount | 274,000 | **282,000** |
| All seasons (2010 to 2025) | 1,692,000 | **1,700,000** |
| Cap transfers (all / 2025) | 130 / 22 | 130 / 22 (unchanged) |
| Amounts read from a raw token | 0 | 2 (listed in `findings.lists.cap_amount_from_raw_token`) |
| Unrecoverable amounts / conflicts | not tracked | 0 / 0 |

The pilot (A.J. Brown) bundle is unchanged: its cap transfer (20,000) comes from the populated column.

## 4. Evidence the method is not a guess

On the **128 transfers whose archive column is populated**, reading the sender's raw token reproduces the column **exactly in all 128 cases** (test: "the cap-token correction"). The method therefore gives the right answer wherever the answer is independently known, and is applied only where the column is blank.

## 5. What was not changed

- The archive and every raw record (the four blank rows are still blank; a test checks it).
- Any historical cap total outside this extraction (production D1, owner-facing numbers). The units are those of the archive column; the meaning of "from sends cap room to" for a `BB_` token is not tied to the league canon here and stays **unverified**.
- The other aggregates, counts, classifications and the 597 unresolved future picks.

## 6. Verification still needed before any cap figure is shown as complete (LR-05)

- An independent audit of the two trades against MFL (the A1 export contains `trade2025_35` and `trade2025_60` if MFL still holds them; reconcile the token and direction).
- Confirmation of cap direction semantics for `BB_` tokens with the commissioner.
- Any owner-visible cap aggregate must cite this correction and its source tag.
