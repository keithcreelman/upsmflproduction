# 2024 Calibration Retrospective — JJ Zachariason ZAP Model

Cohort: 55 prospects matched from JJ's 2024 PostDraft ZAP rankings to NFL 2024 draft + Y1 NFL fantasy production. 7 prospects in JJ's rankings did not match an NFL 2024 draft record (most are UDFAs or Combine invites who didn't get drafted).

**Note on Koalaty 2024:** his Substack went paid Oct 2025 and the archive doesn't preserve 2024 model output. JJ-only calibration on this cohort. For 2026, both JJ and Koalaty inputs will be available.

**Note on Y1 vs B2S:** JJ's ZAP target is B2S (best 2 of Y1-Y3 PPR ppg). The 2024 cohort has only Y1 observable as of NFL season end 2024. This calibration is *provisional* — re-run after 2025 and 2026 NFL seasons end for full B2S grading.


## Rank correlation (Spearman): ZAP score vs realized Y1 PPR ppg

| Position | n | Spearman ρ | Median Y1 ppg | Read |
|---------:|--:|-----------:|--------------:|:-----|
| RB | 18 | -0.059 | 3.17 | Effectively random |
| WR | 25 | 0.749 | 4.06 | Strong: ZAP rank tracked Y1 production well |
| TE | 12 | 0.217 | 3.61 | Weak: rank order weakly predictive |

## Realized Y1 hit rate by ZAP 2.0 tier (per position)

Hit = Y1 PPR ppg ≥ position starter threshold (RB 14.0, WR 13.5, TE 11.0). These thresholds are 2024-specific Y1 cuts; B2S thresholds will differ.


### RB

| Tier | n | n_hits | Hit % | Mean Y1 ppg | Median Y1 ppg |
|:-----|--:|-------:|------:|------------:|--------------:|
| Weekly Starter | 1 | 0 | 0.0% | 2.50 | 2.50 |
| Flex Play | 2 | 0 | 0.0% | 3.08 | 3.08 |
| Benchwarmer | 9 | 0 | 0.0% | 3.13 | 2.80 |
| Waiver Wire Add | 6 | 1 | 16.7% | 5.70 | 3.69 |

### WR

| Tier | n | n_hits | Hit % | Mean Y1 ppg | Median Y1 ppg |
|:-----|--:|-------:|------:|------------:|--------------:|
| Legendary Performer | 2 | 1 | 50.0% | 14.90 | 14.90 |
| Elite Producer | 3 | 1 | 33.3% | 12.86 | 13.35 |
| Weekly Starter | 6 | 1 | 16.7% | 7.66 | 7.88 |
| Flex Play | 6 | 0 | 0.0% | 3.34 | 2.08 |
| Benchwarmer | 4 | 0 | 0.0% | 2.54 | 1.94 |
| Waiver Wire Add | 4 | 0 | 0.0% | 1.36 | 0.64 |

### TE

| Tier | n | n_hits | Hit % | Mean Y1 ppg | Median Y1 ppg |
|:-----|--:|-------:|------:|------------:|--------------:|
| Legendary Performer | 1 | 1 | 100.0% | 15.45 | 15.45 |
| Flex Play | 3 | 0 | 0.0% | 3.18 | 2.14 |
| Benchwarmer | 3 | 0 | 0.0% | 3.45 | 4.48 |
| Waiver Wire Add | 5 | 0 | 0.0% | 3.31 | 2.74 |

## High-ZAP / Low-Y1 (model loved, Y1 didn't show)

| Position | Player | NFL Pick | ZAP 1.0 | ZAP 2.0 | Tier | Y1 ppg | Y1 games | Note |
|:---------|:-------|:--------:|--------:|--------:|:-----|-------:|---------:|:-----|
| WR | Rome Odunze | R1.9 | 96.0 | 85.6 | Elite Producer | 8.52 | 17 | role/usage limited |

## Low-ZAP / High-Y1 (model faded, Y1 popped)

| Position | Player | NFL Pick | ZAP 1.0 | ZAP 2.0 | Tier | Y1 ppg | Y1 games |
|:---------|:-------|:--------:|--------:|--------:|:-----|-------:|---------:|
| RB | Bucky Irving | R4.125 | 51.0 | 24.6 | Waiver Wire Add | 14.48 | 18 |

## Full 2024 cohort table (for reference)

| Pos | Player | NFL Pick | ZAP 1.0 | ZAP 2.0 | Tier | Y1 ppg | Y1 games |
|:----|:-------|:---------|--------:|--------:|:-----|-------:|---------:|
| RB | Jonathon Brooks | R2.46 (CAR) | 93.8 | 74.4 | Weekly Starter | 2.5 | 3 |
| RB | Trey Benson | R3.66 (ARI) | 84.1 | 56.8 | Flex Play | 3.92 | 12 |
| RB | Blake Corum | R3.83 (LAR) | 79.1 | 45.7 | Flex Play | 2.23 | 15 |
| RB | MarShawn Lloyd | R3.88 (GNB) | 74.6 | 39.8 | Benchwarmer | 2.8 | 1 |
| RB | Braelon Allen | R4.134 (NYJ) | 72.3 | 38.4 | Benchwarmer | 5.01 | 17 |
| RB | Jaylen Wright | R4.120 (MIA) | 70.7 | 37.4 | Benchwarmer | 2.05 | 13 |
| RB | Isaiah Davis | R5.173 (NYJ) | 70.0 | 37.0 | Benchwarmer | 3.53 | 13 |
| RB | Ray Davis | R4.128 (BUF) | 69.8 | 36.9 | Benchwarmer | 6.29 | 20 |
| RB | Will Shipley | R4.127 (PHI) | 67.8 | 35.7 | Benchwarmer | 1.84 | 16 |
| RB | Isaac Guerendo | R4.129 (SFO) | 66.4 | 34.8 | Benchwarmer | 6.01 | 16 |
| RB | Dylan Laube | R6.208 (LVR) | 63.9 | 33.1 | Benchwarmer | 0 | 0 |
| RB | Rasheen Ali | R5.165 (BAL) | 62.5 | 32.0 | Benchwarmer | 0.62 | 5 |
| RB | Kimani Vidal | R6.181 (LAC) | 59.8 | 29.9 | Waiver Wire Add | 3.63 | 9 |
| RB | Audric Estime | R5.147 (DEN) | 58.7 | 29.2 | Waiver Wire Add | 3.75 | 13 |
| RB | Jase McClellan | R6.186 (ATL) | 58.2 | 28.9 | Waiver Wire Add | 1.6 | 2 |
| RB | Keilan Robinson | R5.167 (JAX) | 54.4 | 26.6 | Waiver Wire Add | 0 | 0 |
| RB | Tyrone Tracy | R5.166 (NYG) | 51.7 | 25.0 | Waiver Wire Add | 10.72 | 17 |
| RB | Bucky Irving | R4.125 (TAM) | 51.0 | 24.6 | Waiver Wire Add | 14.48 | 18 |
| TE | Brock Bowers | R1.13 (LVR) | 99.3 | 97.2 | Legendary Performer | 15.45 | 17 |
| TE | Ben Sinnott | R2.53 (WAS) | 83.9 | 55.2 | Flex Play | 2.14 | 8 |
| TE | Tip Reiman | R3.82 (ARI) | 81.8 | 51.9 | Flex Play | 1.21 | 8 |
| TE | Theo Johnson | R4.107 (NYG) | 73.4 | 42.8 | Flex Play | 6.19 | 11 |
| TE | Jaheim Bell | R7.231 (NWE) | 68.5 | 36.5 | Benchwarmer | 1.0 | 4 |
| TE | Ja'Tavion Sanders | R4.101 (CAR) | 67.8 | 35.8 | Benchwarmer | 4.88 | 15 |
| TE | Erick All | R4.115 (CIN) | 63.6 | 31.9 | Benchwarmer | 4.48 | 8 |
| TE | Cade Stover | R4.123 (HOU) | 51.7 | 21.7 | Waiver Wire Add | 2.74 | 15 |
| TE | AJ Barner | R4.121 (SEA) | 50.3 | 20.3 | Waiver Wire Add | 5.23 | 15 |
| TE | Jared Wiley | R4.131 (KAN) | 44.1 | 20 | Waiver Wire Add | 1.7 | 1 |
| TE | Tanner McLachlan | R6.194 (CIN) | 20.3 | 20 | Waiver Wire Add | 0 | 0 |
| TE | Devin Culp | R7.246 (TAM) | 6.3 | 20 | Waiver Wire Add | 6.9 | 2 |
| WR | Malik Nabers | R1.6 (NYG) | 99.5 | 98.2 | Legendary Performer | 18.24 | 15 |
| WR | Marvin Harrison | R1.4 (ARI) | 99.3 | 97.5 | Legendary Performer | 11.56 | 17 |
| WR | Rome Odunze | R1.9 (CHI) | 96.0 | 85.6 | Elite Producer | 8.52 | 17 |
| WR | Xavier Worthy | R1.28 (KAN) | 95.6 | 84.2 | Elite Producer | 13.35 | 19 |
| WR | Brian Thomas | R1.23 (JAX) | 94.5 | 81.0 | Elite Producer | 16.71 | 17 |
| WR | Ricky Pearsall | R1.31 (SFO) | 89.7 | 71.5 | Weekly Starter | 8.5 | 11 |
| WR | Ladd McConkey | R2.34 (LAC) | 87.5 | 68.0 | Weekly Starter | 16.21 | 17 |
| WR | Ja'Lynn Polk | R2.37 (NWE) | 86.5 | 66.4 | Weekly Starter | 2.34 | 14 |
| WR | Keon Coleman | R2.33 (BUF) | 86.4 | 66.2 | Weekly Starter | 7.42 | 16 |
| WR | Xavier Legette | R1.32 (CAR) | 86.2 | 65.9 | Weekly Starter | 8.34 | 15 |
| WR | Adonai Mitchell | R2.52 (IND) | 84.0 | 62.4 | Weekly Starter | 3.16 | 17 |
| WR | Troy Franklin | R4.102 (DEN) | 77.7 | 52.8 | Flex Play | 4.74 | 17 |
| WR | Jermaine Burton | R3.80 (CIN) | 76.9 | 51.7 | Flex Play | 1.84 | 8 |
| WR | Roman Wilson | R3.84 (PIT) | 75.7 | 50.0 | Flex Play | 0 | 0 |
| WR | Jalen McMillan | R3.92 (TAM) | 74.6 | 48.4 | Flex Play | 10.11 | 14 |
| WR | Malachi Corley | R3.65 (NYJ) | 71.8 | 43.9 | Flex Play | 1.04 | 5 |
| WR | Luke McCaffrey | R3.100 (WAS) | 69.5 | 40.4 | Flex Play | 2.32 | 15 |
| WR | Javon Baker | R4.110 (NWE) | 67.6 | 38.1 | Benchwarmer | 0.37 | 6 |
| WR | Jacob Cowing | R4.135 (SFO) | 65.5 | 35.6 | Benchwarmer | 0.85 | 15 |
| WR | Devontez Walker | R4.113 (BAL) | 65.3 | 35.4 | Benchwarmer | 3.03 | 3 |
| WR | Ainias Smith | R5.152 (PHI) | 64.1 | 34.3 | Benchwarmer | 5.9 | 3 |
| WR | Jha'Quan Jackson | R6.182 (TEN) | 53.4 | 27.4 | Waiver Wire Add | 0.11 | 12 |
| WR | Malik Washington | R6.184 (MIA) | 51.5 | 26.6 | Waiver Wire Add | 4.06 | 14 |
| WR | Jamari Thrash | R5.156 (CLE) | 49.3 | 26 | Waiver Wire Add | 0.87 | 6 |
| WR | Anthony Gould | R5.142 (IND) | 49.2 | 26 | Waiver Wire Add | 0.41 | 8 |

## Provisional blend weights for Day 2 meta-model

Given Koalaty 2024 isn't accessible, we cannot fit the JJ vs Koalaty blend empirically on this cohort. Default for Day 2: **50/50 weighting** with these caveats:
- Position-specific calibration deferred until both analysts have a graded cohort.
- Re-fit after Koalaty's 2026 post-draft model and 2026 NFL Y1 outcomes are observable.
- Use Spearman ρ from this table as the JJ-side validation: ZAP 2.0 rank should track Y1 outcomes at meaningful ρ. If ρ < 0.3, weight JJ down for that position.
