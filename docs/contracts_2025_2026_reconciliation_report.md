# 2025 to 2026 contract reconciliation report

## Executive summary

- Reviewed the 2025 week 17 `rosters_current` snapshot against the 2026 week 1 `rosters_current` snapshot in `pipelines/etl/data/mfl_database.db`.
- 195 player records matched across both seasons on the real league. 36 players had at least one value change in salary, AAV, or TCV.
- Field-level change counts: salary `32`, AAV `21`, TCV `1`.
- Initial reconciliation outcome: `32` expected changes, `2` items that need manual review, `2` items that look genuinely suspicious.
- Most changes are standard rollforward behavior on frontloaded/backloaded contracts or staged extension records. The main exceptions are a small set of AAV-only jumps that do not match the visible salary ladders, plus one rookie-to-EXT1 conversion that should be checked against source-of-truth extension posting.

## Scope and method

- Source table: `rosters_current`.
- Comparison window: season `2025` max week (`17`) vs season `2026` max week (`1`).
- Match key: `player_id` across seasons on the real league dataset.
- Support evidence: `contract_info` strings from `rosters_current`, `current_extensions`, `mym_submissions`, `restructure_submissions`, and spot checks against the live real-site player page for Malik Nabers.
- Limitation: `extension_submissions` is empty in this DB snapshot, so extension lineage relied on `current_extensions` plus the visible 2025/2026 contract strings rather than a richer extension event table.

## Bucket summary

- Normal rollover / expected year advancement: 19
- Extension-related year advancement: 13
- AAV change without expected workflow support: 3
- Extension-related changes: 1

## Detailed findings

| Player | Franchise | 2025 | 2026 | Changed fields | Bucket | Status | Likely reason |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Achane, De'Von | Sex Manther | S 5000 / AAV 5000 / TCV 55000 / CY 3 / Veteran | S 25000 / AAV 25000 / TCV 55000 / CY 2 / Veteran | salary, AAV | Extension-related year advancement | expected | Extension progression: staged AAV/salary moved from year 1 to later extension year. |
| Addison, Jordan | HammerTime 🔨 ⏰ | S 7000 / AAV 7000 / TCV 24000 / CY 2 / Veteran | S 17000 / AAV 17000 / TCV 24000 / CY 1 / Veteran | salary, AAV | Extension-related year advancement | expected | Extension progression on a 2-year veteran extension. |
| Brown, A.J. | The Long Haulers | S 73000 / AAV 46000 / TCV 129000 / CY 2 / BL | S 56000 / AAV 56000 / TCV 129000 / CY 1 / BL | salary, AAV | Normal rollover / expected year advancement | expected | Backloaded contract advanced from year 1 to year 2 values. |
| Chase, Ja'Marr | HammerTime 🔨 ⏰ | S 33000 / AAV 34000 / TCV 162000 / CY 3 / BL | S 64000 / AAV 54000 / TCV 162000 / CY 2 / BL | salary, AAV | Normal rollover / expected year advancement | expected | Backloaded contract advanced to later-year salary and staged AAV. |
| Collins, Nico | CBP | S 16000 / AAV 22000 / TCV 110000 / CY 3 / BL | S 47000 / AAV 42000 / TCV 110000 / CY 2 / BL | salary, AAV | Normal rollover / expected year advancement | expected | Backloaded contract advanced to later-year salary and staged AAV. |
| Dowdle, Rico | Blake Bombers | S 1000 / AAV 1000 / TCV 12000 / CY 2 / Veteran | S 11000 / AAV 11000 / TCV 12000 / CY 1 / Veteran | salary, AAV | Extension-related year advancement | expected | 2-year veteran extension advanced from 1K opening year to 11K final year. |
| Downs, Josh | The Long Haulers | S 2000 / AAV 2000 / TCV 14000 / CY 2 / Veteran | S 12000 / AAV 14000 / TCV 14000 / CY 1 / Veteran | salary, AAV | AAV change without expected workflow support | requires manual review | Salary advanced to the second-year amount, but AAV resolves to 14K against a 14K TCV / 12K final-year salary structure. |
| Ferguson, Jake | L.A. Looks | S 11000 / AAV 11000 / TCV 32000 / CY 2 / Veteran | S 21000 / AAV 21000 / TCV 32000 / CY 1 / Veteran | salary, AAV | Extension-related year advancement | expected | 2-year veteran extension advanced from 11K to 21K. |
| Flowers, Zay | Pure Greatness | S 5000 / AAV 5000 / TCV 55000 / CY 3 / Veteran | S 25000 / AAV 25000 / TCV 55000 / CY 2 / Veteran | salary, AAV | Extension-related year advancement | expected | 3-year veteran extension advanced from the low first-year salary to 25K. |
| Gibbs, Jahmyr | Pure Greatness | S 11000 / AAV 11000 / TCV 73000 / CY 3 / Veteran | S 31000 / AAV 31000 / TCV 73000 / CY 2 / Veteran | salary, AAV | Extension-related year advancement | expected | 3-year veteran extension advanced from 11K to 31K. |
| Henry, Derrick | The Long Haulers | S 50000 / AAV 34000 / TCV 94000 / CY 2 / BL | S 44000 / AAV 44000 / TCV 94000 / CY 1 / BL | salary, AAV | Normal rollover / expected year advancement | expected | Backloaded contract moved from 50K to 44K final year with AAV stepping to 44K. |
| Herbert, Justin | Cleon Ca$h | S 61000 / AAV 51000 / TCV 153000 / CY 3 / FL | S 51000 / AAV 51000 / TCV 153000 / CY 2 / FL | salary | Normal rollover / expected year advancement | expected | Frontloaded contract advanced from 61K opening year to 51K second year. |
| Higgins, Tee | C-Town Chivalry | S 24000 / AAV 37000 / TCV 48000 / CY 2 / Veteran | S 24000 / AAV 47000 / TCV 48000 / CY 1 / Veteran | AAV | AAV change without expected workflow support | suspicious | Salary stayed flat at 24K while AAV jumped from 37K to 47K on a 48K TCV / 2-year structure. |
| Hill, Tyreek | Sex Manther | S 80000 / AAV 61000 / TCV 142000 / CY 2 / FL | S 62000 / AAV 62000 / TCV 142000 / CY 1 / FL | salary, AAV | Normal rollover / expected year advancement | expected | Frontloaded contract advanced from 80K IR season value to 62K active-roster year 2 value. |
| Hurts, Jalen | HammerTime 🔨 ⏰ | S 17000 / AAV 42000 / TCV 84000 / CY 2 / BL | S 67000 / AAV 42000 / TCV 84000 / CY 1 / BL | salary | Normal rollover / expected year advancement | expected | Backloaded contract advanced from 17K to 67K final year. |
| Jefferson, Justin | Pure Greatness | S 25000 / AAV 48000 / TCV 96000 / CY 2 / BL | S 71000 / AAV 48000 / TCV 96000 / CY 1 / BL | salary | Normal rollover / expected year advancement | expected | Backloaded contract advanced from 25K to 71K final year. |
| Jennings, Jauan | L.A. Looks | S 11000 / AAV 11000 / TCV 32000 / CY 2 / Veteran | S 21000 / AAV 21000 / TCV 32000 / CY 1 / Veteran | salary, AAV | Extension-related year advancement | expected | 2-year veteran extension advanced from 11K to 21K. |
| Kincaid, Dalton | Hawks | S 9000 / AAV 9000 / TCV 67000 / CY 3 / Veteran | S 29000 / AAV 29000 / TCV 67000 / CY 2 / Veteran | salary, AAV | Extension-related year advancement | expected | 3-year veteran extension advanced from 9K to 29K. |
| Kmet, Cole | CBP | S 1000 / AAV 9000 / TCV 27000 / CY 2 / FL | S 6000 / AAV 9000 / TCV 27000 / CY 1 / FL | salary | Normal rollover / expected year advancement | expected | Frontloaded contract advanced from 1K bridge year to 6K final year. |
| London, Drake | C-Town Chivalry | S 14000 / AAV 33000 / TCV 66000 / CY 2 / BL | S 52000 / AAV 33000 / TCV 66000 / CY 1 / BL | salary | Normal rollover / expected year advancement | expected | Backloaded contract advanced from 14K to 52K final year. |
| Mason, Jordan | The Long Haulers | S 14000 / AAV 4000 / TCV 52000 / CY 3 / FL | S 14000 / AAV 24000 / TCV 52000 / CY 2 / FL | AAV | Extension-related year advancement | expected | Staged FL/AAV contract moved from 4K opening AAV tier to 24K later tier. |
| Mayfield, Baker | Pure Greatness | S 36000 / AAV 31000 / TCV 62000 / CY 2 / FL | S 26000 / AAV 31000 / TCV 62000 / CY 1 / FL | salary | Normal rollover / expected year advancement | expected | Frontloaded contract advanced from 36K to 26K final year. |
| McBride, Trey | HammerTime 🔨 ⏰ | S 9000 / AAV 22000 / TCV 44000 / CY 2 / BL | S 35000 / AAV 22000 / TCV 44000 / CY 1 / BL | salary | Normal rollover / expected year advancement | expected | Backloaded contract advanced from 9K to 35K final year. |
| Montgomery, David | L.A. Looks | S 28000 / AAV 20000 / TCV 40000 / CY 2 / FL | S 12000 / AAV 20000 / TCV 40000 / CY 1 / FL | salary | Normal rollover / expected year advancement | expected | Frontloaded contract advanced from 28K to 12K final year. |
| Nabers, Malik | Cleon Ca$h | S 13000 / AAV 13000 / TCV 39000 / CY 2 / Rookie | S 13000 / AAV 13000 / TCV 36000 / CY 2 / EXT1 | TCV | Extension-related changes | expected | Rookie contract converted to EXT1 between 2025 and 2026, reducing TCV from 39K to 36K. |
| Olave, Chris | Pure Greatness | S 51000 / AAV 31000 / TCV 62000 / CY 2 / FL | S 11000 / AAV 31000 / TCV 62000 / CY 1 / FL | salary | Normal rollover / expected year advancement | expected | Frontloaded contract advanced from 51K to 11K final year. |
| Purdy, Brock | Blake Bombers | S 40000 / AAV 28000 / TCV 84000 / CY 3 / FL | S 22000 / AAV 28000 / TCV 84000 / CY 2 / FL | salary | Normal rollover / expected year advancement | expected | Frontloaded contract advanced from 40K to 22K second year. |
| Rice, Rashee | Sex Manther | S 5000 / AAV 5000 / TCV 55000 / CY 3 / Veteran | S 25000 / AAV 25000 / TCV 55000 / CY 2 / Veteran | salary, AAV | Extension-related year advancement | expected | 3-year veteran extension advanced from 5K to 25K while moving off IR. |
| Robinson, Wan'Dale | Cleon Ca$h | S 12000 / AAV 12000 / TCV 34000 / CY 2 / Veteran | S 22000 / AAV 22000 / TCV 34000 / CY 1 / Veteran | salary, AAV | Extension-related year advancement | expected | 2-year veteran extension advanced from 12K to 22K. |
| Shakir, Khalil | Cleon Ca$h | S 14000 / AAV 19000 / TCV 57000 / CY 3 / BL | S 25000 / AAV 19000 / TCV 57000 / CY 2 / BL | salary | Normal rollover / expected year advancement | expected | Backloaded contract advanced from 14K to 25K second year. |
| Smith, Geno | HammerTime 🔨 ⏰ | S 9000 / AAV 15000 / TCV 45000 / CY 3 / BL | S 1000 / AAV 15000 / TCV 45000 / CY 2 / BL | salary | Normal rollover / expected year advancement | expected | Backloaded contract advanced into the 1K middle year before the final 35K season. |
| Smith, Roquan | Cleon Ca$h | S 3000 / AAV 4000 / TCV 12000 / CY 2 / FL | S 1000 / AAV 4000 / TCV 12000 / CY 1 / FL | salary | Normal rollover / expected year advancement | expected | Frontloaded contract advanced from 3K to 1K final year. |
| Smith, Tykee | Pure Greatness | S 1000 / AAV 1000 / TCV 5000 / CY 2 / Veteran | S 4000 / AAV 4000 / TCV 5000 / CY 1 / Veteran | salary, AAV | Extension-related year advancement | expected | 2-year veteran extension advanced from 1K to 4K. |
| Smith-Njigba, Jaxon | C-Town Chivalry | S 14000 / AAV 10000 / TCV 70000 / CY 3 / FL | S 1000 / AAV 30000 / TCV 70000 / CY 2 / FL | salary, AAV | Extension-related year advancement | requires manual review | Staged FL/AAV contract moved from the opening 10K AAV tier to the later 30K tier while salary moved to the 1K middle year. |
| Sutton, Courtland | L.A. Looks | S 15000 / AAV 10000 / TCV 30000 / CY 2 / Veteran | S 15000 / AAV 20000 / TCV 30000 / CY 1 / Veteran | AAV | AAV change without expected workflow support | suspicious | Salary stayed flat at 15K while AAV doubled from 10K to 20K on a 30K TCV / 2-year structure. |
| Wilson, Garrett | CBP | S 24000 / AAV 34000 / TCV 68000 / CY 2 / BL | S 44000 / AAV 34000 / TCV 68000 / CY 1 / BL | salary | Normal rollover / expected year advancement | expected | Backloaded contract advanced from 24K IR-season value to 44K active-roster final year. |

## Suspicious and needs-review items

### Downs, Josh

- Franchise: The Long Haulers
- 2025 values: salary `2000`, AAV `2000`, TCV `14000`, contract `Veteran`, year `2`
- 2026 values: salary `12000`, AAV `14000`, TCV `14000`, contract `Veteran`, year `1`
- Why it stands out: Contract info shows Y1-2 and Y2-12 with TCV 14K; 2026 AAV=14K does not reconcile cleanly to remaining-value math.
- Likely source to check: AAV transform or contract-version selection for extension-style records in the 2026 rollforward path.
- 2025 contract info: `CL 2| TCV 14K| AAV 2K, 14K| Y1-2 Y2-12| Ext: GRide`
- 2026 contract info: `CL 2| TCV 14K| AAV 14K| Y1-2 Y2-12| Ext: GRide`

### Higgins, Tee

- Franchise: C-Town Chivalry
- 2025 values: salary `24000`, AAV `37000`, TCV `48000`, contract `Veteran`, year `2`
- 2026 values: salary `24000`, AAV `47000`, TCV `48000`, contract `Veteran`, year `1`
- Why it stands out: Visible Y1/Y2 salaries do not justify an AAV jump to 47K.
- Likely source to check: AAV transform or contract-version selection for extension-style records in the 2026 rollforward path.
- 2025 contract info: `CL 2| TCV 48K| AAV 37K, 47K| Y1-24, Y2-24| Ext: Mafia, LH, C-Town`
- 2026 contract info: `CL 2| TCV 48K| AAV 47K| Y1-24, Y2-24| Ext: Mafia, LH, C-Town`

### Smith-Njigba, Jaxon

- Franchise: C-Town Chivalry
- 2025 values: salary `14000`, AAV `10000`, TCV `70000`, contract `FL`, year `3`
- 2026 values: salary `1000`, AAV `30000`, TCV `70000`, contract `FL`, year `2`
- Why it stands out: The visible contract info supports a staged AAV change, but the 30K AAV does not map neatly to remaining-year average value.
- Likely source to check: AAV transform or contract-version selection for extension-style records in the 2026 rollforward path.
- 2025 contract info: `CL 3| TCV 70K| AAV 10K, 30K| Y1-14K, Y2-1K, Y3-55K| Ext: C-Town`
- 2026 contract info: `CL 3| TCV 70K| AAV 30K| Y1-14K, Y2-1K, Y3-55K| Ext: C-Town`

### Sutton, Courtland

- Franchise: L.A. Looks
- 2025 values: salary `15000`, AAV `10000`, TCV `30000`, contract `Veteran`, year `2`
- 2026 values: salary `15000`, AAV `20000`, TCV `30000`, contract `Veteran`, year `1`
- Why it stands out: Visible Y1/Y2 salaries do not justify an AAV jump to 20K.
- Likely source to check: AAV transform or contract-version selection for extension-style records in the 2026 rollforward path.
- 2025 contract info: `CL 2| TCV 30K| AAV 10K, 20K| Y1-15K, Y2-15K| Ext: UW`
- 2026 contract info: `CL 2| TCV 30K| AAV 20K| Y1-15K, Y2-15K| Ext: UW`

## Recommended fixes

- Verify the AAV rollforward logic used for 2-year extension records where the posted year-by-year salary ladder does not support the new AAV. The cleanest suspects are Tee Higgins, Courtland Sutton, and Josh Downs.
- Confirm the Malik Nabers 2026 `EXT1` contract was created from the intended extension source record and that the expected TCV reduction from `39K` to `36K` is commissioner-approved.
- If the staged AAV model is intentional for players like Jaxon Smith-Njigba and Jordan Mason, document that rule explicitly in the transform logic or rulebook so these do not keep reading like data defects.
- If a richer extension event table exists outside this DB snapshot, merge it into the reconciliation workflow so future audits can point to the exact source submission instead of inferring from `contract_info`.

## Open questions / blockers

- `extension_submissions` is empty, so there is no first-class extension event ledger in this DB snapshot to reconcile against.
- The audit used the latest stored 2026 snapshot (`week=1`). If the live site has moved since that snapshot, rerun after refreshing `rosters_current` before posting fixes.
- No commissioner posting log was tied directly to each changed row here, so the report can identify likely causes but not prove which human workflow produced each line item.
