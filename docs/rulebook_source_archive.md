# Rulebook Source Archive

Where UPS's historical rules actually live, what has been mined out of each source, and what has not. Created 2026-08-16 after four review agents found ~160 discrepancies between canon, the member rulebook, and the running code — several of which traced back to rules that were written down years ago and then lost.

**Why this file exists.** The repo carries `.txt` extracts of some of these documents under `services/rulebook/sources/rules/archive/`. Those extracts are **lossy** — the 2014 extract is 21KB against 27KB of real text in the live PDF, and it drops rules. Anyone doing rules archaeology should start from the live source, not the extract.

---

## Primary sources

| # | Source | Live URL | In repo? | Mined |
|---|---|---|---|---|
| 1 | **Current Contract Guide** (being repopulated) | [docs.google.com/document/d/1QUfnhofXN7L378yZSSav5ypIgtkpI9EaMRtUuWxFAto](https://docs.google.com/document/d/1QUfnhofXN7L378yZSSav5ypIgtkpI9EaMRtUuWxFAto/edit?usp=sharing) | ❌ No | ✅ 2026-08-16 |
| 2 | **Rules v2012** | [docs.google.com/document/d/1Q6EhBPrP5nMde6fxY1gzZJHnu4Ww46eOP890phtcOmU](https://docs.google.com/document/d/1Q6EhBPrP5nMde6fxY1gzZJHnu4Ww46eOP890phtcOmU/edit?usp=sharing) | Partial (`UPS Dynasty League By-Laws.doc.txt`) | ✅ 2026-08-16 |
| 3 | **Rules v2013** | [docs.google.com/document/d/1SY_iKC1k9gFwI_JbJuNonMOfQBXm6mwa6pRxcfKqrak](https://docs.google.com/document/d/1SY_iKC1k9gFwI_JbJuNonMOfQBXm6mwa6pRxcfKqrak/edit?usp=sharing) | Partial (`UPS Dynasty Cap Rulebook 2013.1.txt`) | ✅ 2026-08-16 |
| 4 | **Rules v2014** (PDF, 13pp) | [drive.google.com/file/d/18SfYe2l1Z6lDJ2KUC9yXFfZs2_EroMN1](https://drive.google.com/file/d/18SfYe2l1Z6lDJ2KUC9yXFfZs2_EroMN1/view?usp=sharing) | Partial, **lossy** (`UPS FFL Bylaws V2014.1.txt`, 21KB vs 27KB live) | ✅ 2026-08-16 |
| 5 | **Rules v2018** | [docs.google.com/document/d/1SjWPTvzfo517Z6CnR-a6eDVR1pQXVp1bf5RoSih2zis](https://docs.google.com/document/d/1SjWPTvzfo517Z6CnR-a6eDVR1pQXVp1bf5RoSih2zis/edit?usp=sharing) | Partial (`UPS - Rules 2018 v1.txt`) | ✅ 2026-08-16 |
| 6 | **Old Forum** (Forumotion) | [upsdynastycap.forumotion.com/forum](https://upsdynastycap.forumotion.com/forum) | ❌ No | ⚠️ **Index only — see below** |
| 7 | **Calvin Johnson Rule doc** | [docs.google.com/document/d/1pXPxnab9bfEOs0QcPVDNI8EkQYRHOefOtVwv2EHrq04](https://docs.google.com/document/d/1pXPxnab9bfEOs0QcPVDNI8EkQYRHOefOtVwv2EHrq04/edit?usp=drivesdk) | ❌ No | ❌ **Auth-required, never fetched** |
| 8 | **League manifesto** | — | ❌ No | ❌ **Missing entirely** |

### Fetching a Google Doc

`.../edit` URLs return the app shell. Use the export endpoint and follow the one-hop redirect to `googleusercontent.com`:

```
https://docs.google.com/document/d/<DOC_ID>/export?format=txt
```

For a Drive PDF, `https://drive.google.com/uc?export=download&id=<FILE_ID>` redirects to `drive.usercontent.google.com`, returns binary, and needs `pdftotext -layout` locally.

---

## Not yet mined

**The old forum is the biggest remaining gap.** The index is reachable; individual sections are not, because Forumotion needs the exact `/fN-slug` path and the index fetch does not expose them. Two sections are worth real effort:

| Section | Volume | Why it matters |
|---|---|---|
| **League Rules** | 18 topics, 184 posts | Described on the index as *"Request clarification on rules. Propose New Rules."* This is where rule *interpretations* live — the arguments that settled how a rule actually works. Nothing of this kind survives anywhere else. |
| **Trade Violations** | 6 topics, 53 posts | Index blurb: *"3 strikes against an owner will result in trade privileges being revoked."* Six real cases of the strike system being applied. |

Also present, lower value: Free Agent Auction Contracts (69 topics), Contract Extensions (117), Franchise & Transition Tags (49), Mid-Season Multi-Yr Offers (59), New Owner's Distribution Draft (3), Conditional Trades (4).

**To unblock:** one thread URL from either section is enough to derive the section path and crawl from there.

**The Calvin Johnson Rule doc has never been read.** Canon §D2/§T1.10 describes the rule secondhand. The doc is auth-gated; it needs sharing or a paste.

---

## What the live sources turned up that the repo extracts missed

1. **A live compliance rule in no current document** (2014 PDF): *"If an in-season transaction results in an owner not being able to put out a full starting lineup, that GM will have 24 hours to fulfill their roster requirements. If this does not occur within 24 hours the transaction will be reversed."* Now canon §G4, flagged for replacement in §G7.1.
2. **The 24-hour injury window is UPS's own, from 2012** — *"Questionable designations becoming deactivated within 24 hours of kickoff do not trigger warnings, while Doubtful designations that become deactivated do."* Keith's 2026-08-16 ruling restores it rather than inventing it.
3. **The 2018 tag-compensation section is truncated in the source itself.** The live doc ends mid-sentence at *"Franchise Tag: 2 First Round Picks in"* — not an extraction artifact. That document was never finished, which is plausibly why the whole Franchise/Transition compensation mechanic evaporated without a repeal vote.
4. **The Contract Guide (#1) still carries the retired flat-35% WW penalty.** Keith 2026-08-16: *"That was old rules."* The doc is mid-repopulation; treat it as historical, not current.
5. **The 2012 trade-veto mechanism is fully recoverable** (2 objections → poll → 5 collusion votes → veto). **Retired** 2026-08-16 — canon §G2, §4.

---

## Precedence

When sources disagree, resolve in this order:

1. **A Keith ruling** recorded in canon with a date
2. **`docs/league_context_v1.md`** (canon)
3. **Running code** — where code and canon disagree on a *number*, code is what members actually experience; treat it as evidence, and fix one or the other rather than assuming canon wins
4. Newer rulebook over older
5. Forum threads and Discord — good for intent and precedent, weak for current state
