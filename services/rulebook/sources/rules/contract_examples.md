## EX-CONTRACT-1 | 1-Year Extension
Kind: contract_example
Topic: Contracts
Applies To: C-EXTENSIONS,C-TRANSACTIONS
Keywords: extension,aav,tcv,schedule-1

Scenario:
Owner wants to extend a Schedule 1 player who is entering the final year of a deal.

Inputs:
- Current salary: $17K
- Years remaining before extension: 1
- Extension term: 1 year
- Extension schedule: Schedule 1

Calculation:
- Added AAV for the new extension year: $10K
- New extension-year salary: $27K
- New TCV after the extension: $44K

Outcome:
The player remains on the roster for two total seasons with a recalculated total contract value of $44K.

Why it matters:
This is the baseline extension workflow league owners use most often in Contract Command Center.

## EX-CONTRACT-2 | 2-Year Extension
Kind: contract_example
Topic: Contracts
Applies To: C-EXTENSIONS,C-TRANSACTIONS
Keywords: extension,aav,tcv,schedule-2

Scenario:
Owner extends a Schedule 2 player for two additional years.

Inputs:
- Current salary: $10K
- Years remaining before extension: 1
- Extension term: 2 years
- Extension schedule: Schedule 2

Calculation:
- Added AAV for the new extension years: $5K
- New extension-year salary: $15K
- New TCV after the extension: $40K

Outcome:
The player moves from a one-year expiring deal to a three-year contract with a $40K TCV.

Why it matters:
Owners can compare whether a two-year extension is worth the added future cap commitment.

## EX-CONTRACT-3 | Front-Loaded Split
Kind: math_example
Topic: Contracts
Applies To: C-LOADED-CONTRACTS,C-AUCTION-CONTRACTS
Keywords: front-loaded,loaded-contract,tcv

Scenario:
Owner gives a player a three-year loaded contract with more salary in year one.

Inputs:
- Contract length: 3 years
- Target TCV: $90K
- Contract style: front-loaded

Calculation:
- Year 1 salary: $40K
- Year 2 salary: $30K
- Year 3 salary: $20K
- Total check: $40K + $30K + $20K = $90K

Outcome:
The contract stays compliant because the total matches the TCV and the deal is clearly front-loaded.

Why it matters:
Front-loading lets an owner spend more cap now to reduce future cap burden.

## EX-CONTRACT-4 | Back-Loaded Split
Kind: math_example
Topic: Contracts
Applies To: C-LOADED-CONTRACTS,C-RESTRUCTURES,C-AUCTION-CONTRACTS
Keywords: back-loaded,loaded-contract,20-percent-rule

Scenario:
Owner wants a three-year back-loaded deal.

Inputs:
- Contract length: 3 years
- Target TCV: $90K
- Year 1 minimum: 20% of TCV

Calculation:
- Minimum year 1 salary: $18K
- Example split: $18K / $32K / $40K
- Total check: $18K + $32K + $40K = $90K

Outcome:
The deal remains valid because year one still meets the minimum 20% of TCV threshold.

Why it matters:
Back-loading is useful for teams with short-term cap pressure but still has a floor in year one.

## EX-CONTRACT-5 | MYM Conversion
Kind: contract_example
Topic: Contracts
Applies To: C-MYM,C-TRANSACTIONS
Keywords: mym,mid-year-multi,in-season

Scenario:
Owner converts a one-year in-season contract into a MYM deal at the same current salary.

Inputs:
- Current salary: $8K
- Current contract length: 1 year
- MYM term selected: 3 years total

Calculation:
- Current-year salary stays unchanged at $8K
- Remaining years inherit the allowed MYM structure from the submission preview
- New TCV is the sum of all years shown in the MYM preview

Outcome:
The player moves from a short-term one-year contract into a longer multi-year deal without changing the current-season salary.

Why it matters:
MYM is the main in-season tool for retaining waiver or auction players without forcing a same-day extension decision.

## EX-CONTRACT-6 | Restructure Allocation
Kind: math_example
Topic: Contracts
Applies To: C-RESTRUCTURES,C-TRANSACTIONS
Keywords: restructure,tcv,allocation

Scenario:
Owner restructures a contract to change how salary is distributed across the remaining years.

Inputs:
- New target TCV: $75K
- Remaining years: 3
- Year 1 minimum rule: 20% of TCV

Calculation:
- Minimum year 1 salary: $15K
- Example restructure: $20K / $25K / $30K
- Total check: $20K + $25K + $30K = $75K

Outcome:
The contract becomes more back-loaded while staying above the year-one minimum threshold.

Why it matters:
Restructures let owners reshape cap timing without changing the total value owed.

## EX-CONTRACT-7 | Guaranteed Contract Cut
Kind: math_example
Topic: Contracts
Applies To: C-GUARANTEES,C-PENALTIES
Keywords: guarantee,cap-penalty,earned-salary

Scenario:
Owner cuts a player before the full guarantee has been earned.

Inputs:
- TCV: $100K
- Guaranteed share: 75%
- Guarantee amount: $75K
- Earned amount at time of cut: $18.75K

Calculation:
- Cap penalty = guaranteed amount - earned amount
- Cap penalty = $75K - $18.75K = $56.25K

Outcome:
The owner absorbs a $56.25K penalty under the earned-salary schedule.

Why it matters:
This is the clearest example of why guarantees and cut timing matter in a salary-cap dynasty league.

## EX-CONTRACT-8 | Trade With Salary And Extension
Kind: contract_example
Topic: Contracts
Applies To: C-TRADE-EXTENSIONS,C-EXTENSIONS
Keywords: trade,trade-salary,pre-trade-extension

Scenario:
Two owners agree to move a player, include traded salary, and attach an extension as part of the deal.

Inputs:
- Player salary this season: $14K
- Traded salary included: $4K
- Extension term: 1 year
- Comment requirement: extension terms must be documented in trade comments or proof of discussion

Calculation:
- Acquiring team net current salary hit: $10K after traded salary
- Future contract terms follow the approved extension preview

Outcome:
The deal can process with both the salary adjustment and the extension if both are clearly stated and the teams remain cap compliant.

Why it matters:
Trade War Room supports this workflow directly, so owners need a clear example of how salary and extension logic combine.

## EX-CONTRACT-9 | Low-Salary Historical Cut Exception
Kind: math_example
Topic: Contracts
Applies To: C-HISTORICAL-TAGS,C-PENALTIES
Keywords: historical,low-salary,cap-penalty
Status: historical
Authority: historical_reference

Scenario:
Owner reviews an older league-era rule where very small final-year contracts could be cut without a meaningful penalty.

Inputs:
- Historical TCV: less than $5K
- Contract status: final year

Calculation:
- Historical penalty handling treated these deals as penalty-free or subject to a minimum floor rule depending on era

Outcome:
This remains a historical cross-reference only and should not be treated as a current default unless separately confirmed.

Why it matters:
Owners often remember old cap rules and need the rule book to separate historical exceptions from current policy.

## EX-CONTRACT-10 | Salary Floor Via Front-Load
Kind: math_example
Topic: Contracts
Applies To: C-LOADED-CONTRACTS,C-RESTRUCTURES
Keywords: salary-floor,front-load,auction

Scenario:
Owner needs to reach the salary floor by the end of the auction or contract deadline period.

Inputs:
- Team is below the floor by $12K
- Eligible player can be restructured or signed with a front-loaded split

Calculation:
- Increase year-one salary by $12K while keeping total contract value compliant
- Offset future years downward if needed to preserve the agreed TCV

Outcome:
The owner can meet the floor without forcing a separate unwanted auction purchase.

Why it matters:
This is one of the clearest practical reasons to use a loaded contract structure.
