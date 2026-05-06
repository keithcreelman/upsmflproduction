# Extension Flag Audit — pipelines/reports/contract_history_*.csv

The `extension_flag` column is set in `build_contract_history_snapshots.py` via a simple substring match: `extension_flag = 1 if 'EXT:' in contract_info.upper()`. This audit walks every player's season-by-season timeline and flags transitions that *look like* extensions but where the flag wasn't set, plus cases where a different signal (MYM, restructure) was set without an accompanying extension flag.


## Counts per position

| Pos | Total rows | Flagged extensions | Rookie→Vet (no flag) | Salary jump ≥1.5× (no flag) | CY reset (no flag) | MYM status (no flag) | Restructure only |
|----:|-----------:|-------------------:|---------------------:|----------------------------:|-------------------:|---------------------:|-----------------:|
| QB | 461 | 33 | 4 | 47 | 17 | 0 | 5 |
| RB | 1068 | 79 | 18 | 72 | 10 | 0 | 7 |
| WR | 1293 | 116 | 13 | 71 | 37 | 0 | 15 |
| TE | 458 | 37 | 8 | 40 | 17 | 0 | 0 |

## Sample suspects per category


### contract_year_reset_no_flag (n=53)

| Pos | Season | Player | Prior status | Cur status | Prior $ | Cur $ | Jump× | Prior cy | Cur cy | Ext flag | Notes |
|----:|-------:|:-------|:-------------|:-----------|--------:|------:|------:|---------:|-------:|:--------:|:------|
| WR | 2024 | Adams, Davante | Tag | FL | 72000 | 50000 | 0.69× | 1 | 3 | 0 | CL 3\| TCV 90K\| AAV 30K\| Y1-50, Y2-20, Y3 |
| WR | 2024 | Hill, Tyreek | Tag | BL | 51000 | 41000 | 0.8× | 1 | 3 | 0 | CL 3\| TCV 183K\| AAV 61Kl Y1- 41K, Y2- 71 |
| WR | 2019 | Green, A.J. | Tagged | Veteran | 70000 | 40000 | 0.57× | 1 | 3 | 0 | TCV 120K |
| WR | 2018 | Tate, Golden | STANDARD | Veteran | 27000 | 34000 | 1.26× | 1 | 3 | 0 |  |
| WR | 2021 | Lockett, Tyler | Veteran | FL | 46000 | 30000 | 0.65× | 1 | 3 | 0 | CL 3\| TCV 111K\| AAV 37K\| (30,40,41) |
| TE | 2018 | Ertz, Zach | STANDARD | Veteran | 25000 | 30000 | 1.2× | 1 | 3 | 0 | Tag UW '18 Ext '19/'20 C-Town [30K, 42K, |
| WR | 2019 | Watkins, Sammy | Veteran | FL | 35000 | 27000 | 0.77× | 1 | 3 | 0 | [27K, 12K, 6K] AAV 15K TCV 45K |
| WR | 2024 | Evans, Mike | FL | Veteran | 19000 | 24000 | 1.26× | 1 | 3 | 0 | CL 3\| TCV 72K\| AAV 24K\| Y1-24, Y2-24, Y3 |
| QB | 2019 | Brady, Tom | Veteran | Veteran | 32000 | 20000 | 0.62× | 1 | 3 | 0 | TCV 60K |
| WR | 2021 | Cooks, Brandin | BL | FL | 43000 | 20000 | 0.47× | 1 | 3 | 0 | CL 3\| TCV 27K\| AAV 9K\| (20,4,3) |
| WR | 2025 | McLaurin, Terry | Veteran | Veteran | 32000 | 19000 | 0.59× | 1 | 3 | 0 | CL 3\| TCV 57K\| AAV 19K |
| WR | 2018 | Fitzgerald, Larry | STANDARD | BL | 32000 | 18000 | 0.56× | 1 | 3 | 0 | [18K, 43K,62K] (AAV 41) |

### salary_jump_no_flag (n=188)

| Pos | Season | Player | Prior status | Cur status | Prior $ | Cur $ | Jump× | Prior cy | Cur cy | Ext flag | Notes |
|----:|-------:|:-------|:-------------|:-----------|--------:|------:|------:|---------:|-------:|:--------:|:------|
| RB | 2023 | Henry, Derrick | Veteran | Veteran | 49000 | 94000 | 1.92× | 1 | 1 | 0 | CL 1\| TCV K\| AAV K |
| WR | 2020 | Golladay, Kenny | Rookie GF | FL | 5000 | 87000 | 17.4× | 1 | 2 | 0 | TCV 124K AAV 62K [87K, 37K] |
| WR | 2025 | Hill, Tyreek | BL | FL | 41000 | 80000 | 1.95× | 3 | 2 | 0 | CL 2\| TCV 142K\| AAV 61Kl Y1- 80K, Y2- 62 |
| WR | 2019 | Jones, Julio | FL | Franchise GF | 49000 | 76000 | 1.55× | 1 | 1 | 0 | Ext. RB '14 TCBOO '15 CBP '16, '17 C-Tow |
| WR | 2022 | Lockett, Tyler | FL | FL | 30000 | 70000 | 2.33× | 3 | 2 | 0 | CL 2\| TCV 81K\| AAV 37K\| Y1-70 Y2-11 |
| QB | 2025 | Mahomes, Patrick | BL | BL | 40000 | 68000 | 1.7× | 2 | 1 | 0 | CL 2\| TCV 108K\| AAV 54K\| Y1-40K,\| Y2-68K |
| QB | 2022 | Brady, Tom | Veteran | Veteran | 20000 | 66000 | 3.3× | 1 | 1 | 0 | CL 1 |
| WR | 2021 | Woods, Robert | Veteran | FL | 31000 | 66000 | 2.13× | 1 | 2 | 0 | CL 2\| TCV 82K\| AAV 41K\| (66,16) |
| QB | 2021 | Wilson, Russell | FL | FL | 10000 | 64000 | 6.4× | 1 | 3 | 0 | CL 3\| TCV 84K\| AAV 28K\| (64,10,10) |
| QB | 2025 | Herbert, Justin | Veteran | FL | 22000 | 61000 | 2.77× | 1 | 3 | 0 | CL 3\| TCV 153K\| AAV 51K\| Y1-61, Y2-51, Y |
| WR | 2023 | Moore, D.J. | BL | FL | 26000 | 61000 | 2.35× | 3 | 2 | 0 | CL 2\| TCV 101K\| AAV 49K \|Y1-61 Y2-40\| Ex |
| QB | 2021 | Rodgers, Aaron | Veteran | FL | 18000 | 60000 | 3.33× | 1 | 2 | 0 | CL 2\| TCV 78K\| AAV 39K\| (60,18) |

### rookie_to_vet_no_flag (n=43)

| Pos | Season | Player | Prior status | Cur status | Prior $ | Cur $ | Jump× | Prior cy | Cur cy | Ext flag | Notes |
|----:|-------:|:-------|:-------------|:-----------|--------:|------:|------:|---------:|-------:|:--------:|:------|
| RB | 2019 | Elliott, Ezekiel | Rookie/Extension | Veteran GF | 15000 | 35000 | 2.33× | 3 | 2 | 0 | Extended GRide '19 '20 |
| RB | 2021 | Barkley, Saquon | Rookie/Veteran | Veteran | 15000 | 35000 | 2.33× | 3 | 2 | 0 | CL 3\| TCV 85K |
| RB | 2022 | Jacobs, Josh | Rookie/Veteran | Veteran | 15000 | 35000 | 2.33× | 3 | 2 | 0 | CL 3\| TCV 85K\| AAV 35K\| Y1-15 Y2-35 Y3-3 |
| RB | 2020 | Mixon, Joe | Rookie/Veteran | Veteran | 13000 | 33000 | 2.54× | 3 | 2 | 0 | Ext. GRide '20/21 TCV 79K |
| RB | 2025 | Walker III, Kenneth | Rookie/Veteran | Veteran | 12000 | 32000 | 2.67× | 3 | 2 | 0 | CL 3\| TCV 76K\| AAV 32K\| Y1-12, Y2-32, Y3 |
| RB | 2020 | Cook, Dalvin | Rookie/Veteran GF | Veteran GF | 10000 | 30000 | 3.0× | 3 | 2 | 0 | Ext. By Mather '20/'21 [10K, 30K, 30K] |
| WR | 2019 | Thomas, Michael | Rookie/Extension | Veteran GF | 10000 | 30000 | 3.0× | 3 | 2 | 0 | Extended by Hood '19 & '20 |
| RB | 2021 | Chubb, Nick | Rookie/Veteran | Veteran | 7000 | 27000 | 3.86× | 3 | 2 | 0 | CL 3\| TCV 61K |
| RB | 2025 | Cook, James | Rookie/Veteran | Veteran | 7000 | 27000 | 3.86× | 3 | 2 | 0 | CL 3\| TCV 61K\| AAV 27K\| Y1-7, Y2-27, Y3- |
| TE | 2024 | Pitts, Kyle | Rookie/Veteran | Veteran | 15000 | 27000 | 1.8× | 3 | 2 | 0 | CL 3\| TCV 69K\| AAV 27K\| Y1-15 Y2- 27 Y3- |
| QB | 2022 | Murray, Kyler | Rookie/Veteran | Veteran | 5000 | 25000 | 5.0× | 3 | 2 | 0 | CL 3\| TCV 55K\| AAV 25K\| Y1-5 Y2-25 Y3-25 |
| RB | 2019 | Howard, Jordan | Rookie/Extension | Veteran GF | 5000 | 25000 | 5.0× | 3 | 2 | 0 | Ext. Son '19 [5K, 25K,25K] |

### restructure_only (n=27)

| Pos | Season | Player | Prior status | Cur status | Prior $ | Cur $ | Jump× | Prior cy | Cur cy | Ext flag | Notes |
|----:|-------:|:-------|:-------------|:-----------|--------:|------:|------:|---------:|-------:|:--------:|:------|
| WR | 2017 | Jones, Julio |  | FL RESTRUCTURE | 0 | 91000 | — | 0 | 2 | 0 | Ext. RB '14 TCBOO '15 CBP '16, '17 C-Tow |
| WR | 2017 | Edelman, Julian |  | RESTRUCTURED - FL | 0 | 69000 | — | 0 | 2 | 0 | Ext. Gordon '16, T-Tag Gordon '17, Ext ' |
| RB | 2017 | Miller, Lamar |  | RESTRUCTURED | 0 | 51000 | — | 0 | 1 | 0 | Ext. RB '17 [51K, 51K] Avg. Annual $46,  |
| WR | 2018 | Jones, Julio | FL RESTRUCTURE | FL | 91000 | 49000 | 0.54× | 2 | 1 | 0 | Ext. RB '14 TCBOO '15 CBP '16, '17 C-Tow |
| WR | 2020 | Cooper, Amari | FL GF | FL GF | 70000 | 49000 | 0.7× | 3 | 2 | 0 | Ext. Blake '18/'19 PG '20/21 Restructure |
| RB | 2019 | Bell, Le'Veon | Veteran | Veteran GF | 48000 | 48000 | 1.0× | 3 | 2 | 0 | Ext. CTown '16 & '17  UW '18 BB '19/'20  |
| RB | 2017 | Bell, Le'Veon |  | FRONT LOAD [RESTRUCTURE] | 0 | 41000 | — | 0 | 2 | 0 | (FL in '17) Ext. CTown '16 & '17 UW '18  |
| WR | 2019 | Robinson, Allen | Veteran | Veteran GF | 38000 | 38000 | 1.0× | 3 | 2 | 0 | Ext. Mather '17 & '18 GRide '19 & '20 Re |
| QB | 2018 | Brady, Tom | RESTRUCTURED | Veteran | 31000 | 32000 | 1.03× | 2 | 1 | 0 | Restructured Ext WP '17 & '18 [31K, 31K, |
| QB | 2017 | Brady, Tom |  | RESTRUCTURED | 0 | 31000 | — | 0 | 2 | 0 | Ext WP '17 & '18 [31K, 31K, 32K] Avg. 22 |
| QB | 2017 | Brees, Drew |  | RESTRUCTURED | 0 | 30000 | — | 0 | 1 | 0 | Ext. RB '17 [30K, 30K] Avg. 25/35 |
| WR | 2017 | Richardson, Paul |  | RESTRUCTURED | 0 | 22000 | — | 0 | 2 | 0 | Ext UW '17 Ext. CC '18 [22K, 12K] |

## What to do with this

1. **Hand-audit a sample of each category.** If the rookie→vet or salary-jump rows are mostly legitimate extensions that the EXT: heuristic missed, the extension counts in our analysis are undercounted by this many. Re-run `rookie_extension_followthrough.py` after the underlying flag is fixed.
2. **MYM-status rows are extensions in disguise.** UPS treats MYM with a raise as a contract extension functionally. Suggest extending the parser in `build_contract_history_snapshots.py` to also set `extension_flag = 1` when `contract_status` contains 'MYM' AND `inferred_extension_rate > prior_salary × 1.5`.
3. **Contract-year resets are often extensions.** When prior_cy=1 and cur_cy=3 in consecutive seasons for the same player+franchise, a new contract started between the two snapshots. If contract_info doesn't carry 'EXT:', the parser should still set the flag based on the cy delta.
4. **Cross-check with `site/ccc/extension_submissions.json`** if such a file exists — those are the source-of-truth submissions; flag mismatches.
