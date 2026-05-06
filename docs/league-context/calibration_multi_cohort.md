# JJ Multi-Cohort Calibration — B2S Grading

Two cohorts graded against JJ's ACTUAL model target (B2S = best 2 of Y1-Y3 PPR ppg with 8-game season minimum). 2024 cohort is partial (Y1-Y2 only as of NFL season end 2025).

**Why B2S, not Y1:** the prior calibration used Y1 ppg which is the wrong yardstick — JJ's model targets 3-year B2S. RB Y1 in particular is dominated by NFL coaching decisions and depth-chart noise. The 2022 cohort lets us grade JJ's *actual target* with full 3-year data.


## 2022 (Z-Prospect V1, full B2S)

Matched: 43; unmatched: 7

Unmatched examples (likely UDFAs / no NFL play): Ty Davis-Price, Isaih Pacheco, Max Borghi, Sincere McCormick, Tyler Goodson, Leddie Brown, Mike Polk


| Pos | n | Spearman ρ (ZAP vs B2S) | Median B2S | Top-1/3 hit % | Bot-1/3 hit % | Lift |
|----:|--:|------------------------:|-----------:|--------------:|--------------:|-----:|
| RB | 19 | **0.463** | 4.67 | 66.7% | 16.7% | +50.0pp |
| WR | 24 | **0.699** | 6.36 | 37.5% | 0.0% | +37.5pp |

### Top-1/3 ZAP cohort (model loved them)


**RB** (top 6 of 19):
- ✓ Breece Hall (NYJ, R?.36) — ZAP 96.9, B2S 16.07 ppg (Y1=0, Y2=17.09, Y3=15.06)
- ✓ Kenneth Walker (SEA, R?.41) — ZAP 93.2, B2S 14.99 ppg (Y1=13.51, Y2=13.29, Y3=16.47)
- ✓ Rachaad White (TAM, R?.91) — ZAP 85.4, B2S 14.12 ppg (Y1=8.49, Y2=15.55, Y3=12.69)
- ✓ James Cook (BUF, R?.63) — ZAP 83.1, B2S 15.31 ppg (Y1=6.49, Y2=13.54, Y3=17.07)
- ✗ Brian Robinson (WAS, R?.98) — ZAP 72.1, B2S 12.22 ppg (Y1=9.39, Y2=13.21, Y3=11.23)
- ✗ Tyler Allgeier (ATL, R?.151) — ZAP 70.1, B2S 9.03 ppg (Y1=9.96, Y2=8.09, Y3=6.25)

**WR** (top 8 of 24):
- ✓ Drake London (ATL, R?.8) — ZAP 98.4, B2S 13.71 ppg (Y1=10.51, Y2=10.9, Y3=16.52)
- ✓ Chris Olave (NOR, R?.11) — ZAP 97.9, B2S 13.83 ppg (Y1=13.21, Y2=14.46, Y3=9.59)
- ✓ Garrett Wilson (NYJ, R?.10) — ZAP 97.4, B2S 13.75 ppg (Y1=12.69, Y2=12.54, Y3=14.82)
- ✗ Treylon Burks (TEN, R?.18) — ZAP 95.3, B2S 6.22 ppg (Y1=8.01, Y2=4.43, Y3=0)
- ✗ Jameson Williams (DET, R?.12) — ZAP 95.1, B2S 10.72 ppg (Y1=0, Y2=7.36, Y3=14.08)
- ✗ Jahan Dotson (WAS, R?.16) — ZAP 94.2, B2S 9.11 ppg (Y1=10.88, Y2=7.34, Y3=3.51)
- ✗ Wan'Dale Robinson (NYG, R?.43) — ZAP 92.6, B2S 9.81 ppg (Y1=0, Y2=8.88, Y3=10.75)
- ✗ Skyy Moore (KAN, R?.54) — ZAP 85.5, B2S 3.72 ppg (Y1=3.31, Y2=4.13, Y3=0)

## 2024 (ZAP 1.0, partial best-of-Y1-Y2)

Matched: 55; unmatched: 7

Unmatched examples (likely UDFAs / no NFL play): Frank Gore, Jaden Shirden, George Holani, Michael Wiley, Daijun Edwards, Cody Schrader, Miyan Williams


| Pos | n | Spearman ρ (ZAP vs B2S) | Median B2S | Top-1/3 hit % | Bot-1/3 hit % | Lift |
|----:|--:|------------------------:|-----------:|--------------:|--------------:|-----:|
| RB | 18 | **-0.247** | 2.23 | 0.0% | 16.7% | +-16.7pp |
| WR | 25 | **0.785** | 4.33 | 12.5% | 0.0% | +12.5pp |
| TE | 12 | **0.462** | 2.45 | 25.0% | 0.0% | +25.0pp |

### Top-1/3 ZAP cohort (model loved them)


**RB** (top 6 of 18):
- ✗ Jonathon Brooks (CAR, R?.46) — ZAP 93.8, B2S 0 ppg (Y1=0, Y2=0, Y3=None)
- ✗ Trey Benson (ARI, R?.66) — ZAP 84.1, B2S 1.96 ppg (Y1=3.92, Y2=0, Y3=None)
- ✗ Blake Corum (LAR, R?.83) — ZAP 79.1, B2S 4.69 ppg (Y1=2.23, Y2=7.14, Y3=None)
- ✗ MarShawn Lloyd (GNB, R?.88) — ZAP 74.6, B2S 0 ppg (Y1=0, Y2=0, Y3=None)
- ✗ Braelon Allen (NYJ, R?.134) — ZAP 72.3, B2S 2.51 ppg (Y1=5.01, Y2=0, Y3=None)
- ✗ Jaylen Wright (MIA, R?.120) — ZAP 70.7, B2S 3.7 ppg (Y1=2.05, Y2=5.36, Y3=None)

**WR** (top 8 of 25):
- ✗ Malik Nabers (NYG, R?.6) — ZAP 99.5, B2S 9.12 ppg (Y1=18.24, Y2=0, Y3=None)
- ✗ Marvin Harrison (ARI, R?.4) — ZAP 99.3, B2S 11.1 ppg (Y1=11.56, Y2=10.65, Y3=None)
- ✗ Rome Odunze (CHI, R?.9) — ZAP 96.0, B2S 9.94 ppg (Y1=8.52, Y2=11.35, Y3=None)
- ✗ Xavier Worthy (KAN, R?.28) — ZAP 95.6, B2S 10.6 ppg (Y1=13.35, Y2=7.85, Y3=None)
- ✗ Brian Thomas (JAX, R?.23) — ZAP 94.5, B2S 13.32 ppg (Y1=16.71, Y2=9.93, Y3=None)
- ✗ Ricky Pearsall (SFO, R?.31) — ZAP 89.7, B2S 8.68 ppg (Y1=8.5, Y2=8.86, Y3=None)
- ✓ Ladd McConkey (LAC, R?.34) — ZAP 87.5, B2S 13.61 ppg (Y1=16.21, Y2=11.01, Y3=None)
- ✗ Ja'Lynn Polk (NWE, R?.37) — ZAP 86.5, B2S 1.17 ppg (Y1=2.34, Y2=0, Y3=None)

**TE** (top 4 of 12):
- ✓ Brock Bowers (LVR, R?.13) — ZAP 99.3, B2S 15.07 ppg (Y1=15.45, Y2=14.68, Y3=None)
- ✗ Ben Sinnott (WAS, R?.53) — ZAP 83.9, B2S 2.65 ppg (Y1=2.14, Y2=3.16, Y3=None)
- ✗ Tip Reiman (ARI, R?.82) — ZAP 81.8, B2S 0.61 ppg (Y1=1.21, Y2=0, Y3=None)
- ✗ Theo Johnson (NYG, R?.107) — ZAP 73.4, B2S 7.36 ppg (Y1=6.19, Y2=8.52, Y3=None)