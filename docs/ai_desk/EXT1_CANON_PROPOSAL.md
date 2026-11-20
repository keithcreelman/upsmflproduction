# Ext1 and the contract-type wording: a proposed canon correction (for Keith's approval)

**Status: PROPOSAL ONLY.** The canon (`docs/league_context_v1.md`), the generated rules index (`site/m/data/rules.json`, `worker/src/desk/data/rules_data.js`) and `docs/rulebook_topics.json` are **not changed** by this document or by the PR that carries it. Keith approves the wording; the edit is its own small docs PR, because it changes the canon sha the desk pins.

## The ruling (Keith, 2026-11-20)

- **Extension** is the top-level contract type (the contract family).
- **Ext1** is the one-year Extension designation. It is also used as a `contract_type` field value in the canonical rules (C4 and T3.3).
- **Vet-Ext1** is a related status token (what the MFL `contractStatus` string carries on the contract once it is extended).
- The authoritative contract-type enumeration says Ext1 is not a separate type; C4 and T3.3 use it as a `contract_type` value. Both statements must be reconciled, not one deleted.

## Where the canon contradicts itself (checked 2026-11-20 against `docs/league_context_v1.md`)

| Line | Wording | Reads as |
|---|---|---|
| 41 | "Extension types = Ext1 / Ext2 (own contract_type values)" | Ext1 and Ext2 are `contract_type` values |
| 242 | "MYAC / Loading designations (FL/BL/EXT1/EXT2/EXT3) ... Encoded into the MFL `contractStatus` string" | EXT1/EXT2 are status tokens |
| 489 (C4 heading) | "Extension (contract types `Ext1` / `Ext2`)" | contract types |
| 496 (C4) | "`contract_type`: **Ext1** for 1-year extension, **Ext2** for 2-year extension. (Case-insensitive.)" | `contract_type` values |
| 498 (C4) | "The MFL `contractStatus` stays `EXT1` with no `-FL` / `-BL` suffix." | status token |
| 1000 (T3.3) | "`contract_type`: `Ext1` (1-year ext) or `Ext2` (2-year ext) — case-insensitive." | `contract_type` values |
| 2698 | "Extension types `Ext1` / `Ext2`. Resolved v4." | types |
| **449** | "**`EXT1` / `EXT2` are not separate contract types** — they are the same Extension mechanism recording how many years were added." | **contradicts 41, 489, 496, 1000, 2698** |
| `docs/rulebook_topics.json:1017` | "Ext1 and Ext2 are not separate contract types. They are the same extension, recording whether you added one year or two." | repeats line 449 |

Line 449 sits under the A3.1 taxonomy table, where Extension is one row ("adds 1 or 2 years"). Read as "the table has one Extension row, not two", it is true; read as "Ext1 is not a `contract_type` value", it contradicts C4 and T3.3. The wording does not say which, and the desk's first real-model run showed why that matters: asked "Is Ext1 a contract type?", the model answered yes from C4's heading, and the set had expected no from line 449.

Line 449 is internal-only in the published rules index (it is not in `rules.json`), so the desk cannot cite it; C4 and T3.3 are published and citable (anchors `s1-c4` and `s2-t3-3`).

## Proposed replacement for line 449

> **Extension is the contract type; Ext1 and Ext2 are its two designations.** An Extension adds 1 or 2 years. The length it adds is recorded as the `contract_type` field value `Ext1` (one year added) or `Ext2` (two years added) (C4, T3.3); the A3.1 table therefore lists one type, Extension, and both designations belong to it. When an extension is written into MFL's `contractStatus` string the contract carries the related status token: `Vet-Ext1` or `Rookie-Ext1`, `Vet-Ext2` or `Rookie-Ext2`, with an optional `-FL` or `-BL` suffix (an Ext2 loaded at signing, or an Ext1 or Ext2 after a later restructure). `EXT3` appears in the A3.1 taxonomy as legacy data; every current rule caps an extension at 2 years.

## Proposed replacement for the `docs/rulebook_topics.json` gotcha (line 1017)

> "Extension is one contract type. Ext1 and Ext2 are its designations: the `contract_type` value says whether you added one year or two, and the contract string then carries the related status token (for example Vet-Ext1)."

## Follow-on edits (small, none touches the rules)

1. After the canon edit, regenerate `site/m/data/rules.json` and `worker/src/desk/data/rules_data.js` (the build already does this from the canon); the canon sha pinned in the desk tests moves with it.
2. The desk glossary (`worker/src/desk/data/glossary.js`) already carries the three-way distinction as of this PR (Extension entry, Vet-Ext1 and Vet-Ext2 status-token entries), so nothing waits on the canon edit.
3. The development expectation for question DEV-RUL-10 already requires the three distinctions with citations (see below).

## What changed in the desk with this PR (and what did not)

- **Development expectation, DEV-RUL-10** (`tests/fixtures/ai_desk/eval_bank_dev.jsonl`, `scripts/ai_eval/sets/first10.json`, the oracle in `scripts/ai_eval/lib/scenario_env.mjs`): the plain "no" is replaced. A correct answer must say that Extension is the contract family; that Ext1 is the one-year designation and a `contract_type` value in canon (cited to C4 and, when retrieved, T3.3); and that Vet-Ext1 is the related status token (cited to the glossary). Neither a bare "no" nor a bare "yes" meets it. The oracle checks the words are on the card and the cite is present; a human still reads the answer.
- **The canon, the rules index, the frozen scorer and its hash:** unchanged. The frozen scorer still flags this question (`wrong_number` for a glossary term typed with different capitalization; see `scripts/ai_eval/scorer_parity.mjs`); that is adjudicated by reading the card, as before.
