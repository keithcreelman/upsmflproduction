# 2025 to 2026 contract suspect items

Focus these first. These are the items that do not reconcile cleanly from the visible year-to-year contract strings.

## Downs, Josh (The Long Haulers)
- Changed fields: salary, AAV
- 2025: salary 2000, AAV 2000, TCV 14000, status Veteran
- 2026: salary 12000, AAV 14000, TCV 14000, status Veteran
- Bucket: AAV change without expected workflow support
- Why flagged: Contract info shows Y1-2 and Y2-12 with TCV 14K; 2026 AAV=14K does not reconcile cleanly to remaining-value math.
- Recommended fix: verify the contract-version transform or AAV rollforward logic for extension-style records before posting refreshed values to MFL.

## Higgins, Tee (C-Town Chivalry)
- Changed fields: AAV
- 2025: salary 24000, AAV 37000, TCV 48000, status Veteran
- 2026: salary 24000, AAV 47000, TCV 48000, status Veteran
- Bucket: AAV change without expected workflow support
- Why flagged: Visible Y1/Y2 salaries do not justify an AAV jump to 47K.
- Recommended fix: verify the contract-version transform or AAV rollforward logic for extension-style records before posting refreshed values to MFL.

## Smith-Njigba, Jaxon (C-Town Chivalry)
- Changed fields: salary, AAV
- 2025: salary 14000, AAV 10000, TCV 70000, status FL
- 2026: salary 1000, AAV 30000, TCV 70000, status FL
- Bucket: Extension-related year advancement
- Why flagged: The visible contract info supports a staged AAV change, but the 30K AAV does not map neatly to remaining-year average value.
- Recommended fix: verify the contract-version transform or AAV rollforward logic for extension-style records before posting refreshed values to MFL.

## Sutton, Courtland (L.A. Looks)
- Changed fields: AAV
- 2025: salary 15000, AAV 10000, TCV 30000, status Veteran
- 2026: salary 15000, AAV 20000, TCV 30000, status Veteran
- Bucket: AAV change without expected workflow support
- Why flagged: Visible Y1/Y2 salaries do not justify an AAV jump to 20K.
- Recommended fix: verify the contract-version transform or AAV rollforward logic for extension-style records before posting refreshed values to MFL.

