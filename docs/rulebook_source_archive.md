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

## The old forum — how to navigate it

**Forumotion resolves a section by its number and ignores the slug**, so `/f20-league-rules` silently serves whatever forum is #20 (in this case 2017 Transition Tags) rather than 404ing. Never trust a guessed number; read the href off the index.

Verified section paths:

| Section | Path | Volume |
|---|---|---|
| **League Rules** | `/f6-league-rules` | 8 threads — rule clarifications and proposals |
| **Trade Violations** | `/f5-trade-violations` | 6 threads, one per year 2012–2017 |
| Completed Rule Discussions | *(no direct href on the index — nested under League Rules)* | Unmined |
| 2012 FA Auction Contracts | `/f13-2012-free-agent-auction-contracts` | 69 topics |

Threads are `/t<N>-<slug>`.

### Mined 2026-08-16

**`/f6-league-rules`** — 8 threads. The high-value ones are the rule debates that pre-date every surviving rulebook: `/t92-ability-to-restructure-contracts` (16 replies — the 2014 restructure vote, already resolved in canon §C5), `/t83-taxi-squad-thoughts` (18 replies — the tiered-taxi proposal, superseded by flat 10 + 1 IDP), `/t65-contract-length` (8), `/t91-taxi-squad-contracts-guaranteed` (7), `/t15-general-thought` (30, sticky).

**`/f5-trade-violations`** — `/t12-trade-violation-rules` is the sticky that defines the strike system:

> "an owner **MUST** respond to a trade offer within **96 hours**" (two weeks in the offseason). Three unanswered offers in a season — defined as **February 1 through January 31** — and "that owner will have his trading privileges revoked for the remainder of the season." Legitimate reasons can be appealed; "simply not responding to an offer is pure laziness and will not be tolerated."

Six annual violation threads (2012–2017) show it was actively enforced. **Assessment: dead in the current era** — no strike since 2017, and MFL now auto-expires offers at 7 days (`defaultTradeExpirationDays: "7"`), which is the mechanical residue of the same intent. Worth retiring explicitly so nobody quotes the 96-hour rule.

### ⚠️ An open question this surfaced, never resolved

`/t15-general-thought` (30 replies) debates: **when you trade *for* a loaded contract and then cut it, do you eat the loading penalty the original owner created?** The case was a 3rd-round pick traded for Jonathan Stewart on a back-loaded deal ($19K / $26K); the acquiring owner argued he never got the year-1 discount and had already paid acquisition cost. The commissioner said he would "go whatever way the league decides" and sent it to a vote. **The thread records no outcome, and no rulebook since has answered it.**

This is live again: canon §D2a settles a loaded contract against "what the owner actually paid," and on a mid-contract trade it is unstated whether "the owner" means the franchise or the person. Belongs in §G7.

### Not yet mined

Completed Rule Discussions (no href found on the index — needs one thread URL to derive). Lower value: Contract Extensions (117 topics), FA Auction Contracts (69), Franchise & Transition Tags (49), Mid-Season Multi-Yr Offers (59), New Owner's Distribution Draft (3), Conditional Trades (4).

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
