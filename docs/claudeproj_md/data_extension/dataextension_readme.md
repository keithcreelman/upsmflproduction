# UPS Contract Command Center (CCC) — Extension Module Specification (Step-by-Step)

## Objective
Define a complete, deterministic, edge-case-safe specification for the **Extension** module inside the UPS Contract Command Center (CCC), so that a single implementation prompt can build it correctly without rework.

This project is **not** for writing production code.
This project is for defining logic precisely.

## Scope
This project covers Extensions only.

## Development Method (Critical)
We will build this specification **one step at a time** with minimal back-and-forth.

Rules:
1. Each step is defined in full before moving to the next.
2. No speculative assumptions.
3. No redesigns.
4. No naming prescriptions for datasets/tables/functions unless explicitly required for integration.
5. Output must remain concise and implementation-ready.

---

# Step Order

We will define the Extension module in this exact order:

---

## Step 1 — Data Ingestion Requirements (Raw)

Define the three required API pulls and the minimum required fields to ingest from each:

1) League export (franchise + owner identity)  
2) Players export (player identity + NFL draft year)  
3) Rosters export (contract + salary attributes + contractInfo parsing)

This step defines:
- Required input fields (raw)
- Required derived fields (contract parsing outputs)
- Explicitly out-of-scope fields (future projects)

---

## Step 2 — Salary Calculations

Define exact extension salary math:

- 1-year extension
- 2-year extension
- How AAV is used (current vs future AAV)
- Rounding / increments
- Minimum / maximum constraints (if any)
- Contract year effects (append vs replace)

Deliverable:
- Explicit formula blocks
- Validation rules
- Deterministic calculation order

---

## Step 3 — Eligibility Rules (Boolean Logic)

Define exact eligibility conditions:

- Rookie vs non-rookie
- Year logic
- Roster state effects
- Deadline constraints
- Exclusions (tag / no extensions / previous extension)

Deliverable:
- Boolean condition trees
- Explicit precedence order
- Failure outcomes

---

## Step 4 — Contract Year Effects (Before/After State)

Define contract state transitions for key scenarios:

- Rookie with 0 years remaining
- contract_year = 1
- contract_year > 1
- Already extended
- Tagged / restricted

Deliverable:
- Before/After state tables
- Field-level changes

---

## Step 5 — Database Writes + Logging

Define exactly:

- Tables affected
- Fields updated / inserted
- Audit/logging requirements
- Rollback rules and failure handling

Deliverable:
- Field-level update tables
- Failure state definitions

---

## Step 6 — MFL Integration

Define:

- Payload structure
- contractInfo formatting rules (CL, TCV, AAV, Y#, EXT, GTD, no-extension flags)
- Commit sequencing vs API success/failure
- Timeout / retry behavior

Deliverable:
- Exact payload specification
- Failure policy

---

## Step 7 — UI Flow

Define end-to-end user journey:

- Menu path
- Filtering
- Prompts and validation loops
- Timeout rules (60s)
- Cancellation behavior

Deliverable:
- Deterministic UI state flow

---

## Step 8 — Edge Case Library

Define expected behavior for all edge cases:

- Deadline violations
- Duplicate extension attempts
- Salary increment violations
- API failure
- Partial DB write
- Player traded mid-flow
- User timeout

Deliverable:
- Edge-case matrix

---

## Step 9 — Token Optimization Pack

Consolidate all rules into:

- Compact boolean trees
- Formula blocks
- State transition tables
- Minimal implementation directives

Deliverable:
- Single Claude build prompt